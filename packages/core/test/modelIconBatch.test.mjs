// 球面模型图标批次（src/viz/globe3d/iconBatch.js / dotMaskHash.js / iconLod.js）不依赖 GPU 的口径：
//   ① 点精灵遮罩哈希表：七千颗锚点（LEO 壳层 + GEO 环 + 百米内共位对 + 贴格界的点）在自身位置与容差内抖动处都查得到，
//      远处的点一个也不误中；最长探测距离 < 着色器上限
//   ② 烘焙部件 + 着色器镜像（iconVertexMirror）与真场景树逐顶点相同：参数化默认卫星 / 星链 V2 Mini，随机太阳方向驱动太阳翼
//   ③ 图标抽稀档：三角形确实减少、索引不越界、换回的原顶点与代表顶点同位置且法向朝本三角形一侧
//   ④ 批次冒烟：几百颗同模型的星只建一组、draw call 数 = 部件数；撤掉后淡出摘净；遮罩表在有图标时打开
//   ⑤ 同模型换聚焦星：旧星淡出摘掉（末尾那颗挪进它的槽）之后，GPU 上那一格的位置 / 姿态是新星的
//   ⑥ 逐像素地球遮挡（JS 镜像）：背面大图标按地球轮廓裁、锚点刚被挡不整颗消失、近地侧大图标不被削、整颗剔除保守
//   ①b 遮罩表同一格挤进 ≥ 33 颗（一箭多星刚分离）：建表收敛、表长有界、同格只留前 32 项（2026-10-08 深度排查 · 既有低频项）
//   ⑦ 模板预编译期间加进来的同模型星：换上的第 0 档几何颗数 / 实例属性跟上（#54）
//   ⑧ 出图 / 视频出帧按输出像素选抽稀档、当场重选，出完回屏上那一档（#53）
// 着色器本身（屏幕定尺 / 剔除 / 地影 / 淡入淡出）在真 Electron 里看，这里不重复。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const DM = await import(SRC + 'globe3d/dotMaskHash.js')
const IB = await import(SRC + 'globe3d/iconBatch.js')
const LOD = await import(SRC + 'globe3d/iconLod.js')
const ML = await import(SRC + 'globe3d/modelLayer.js')
const { llaToVec } = await import(SRC + 'globe3d/focusLanes.js')
const { irToThree } = await import(SRC + 'models/irToThree.js')
const { buildTemplateModel } = await import(CORE + 'models/paramBus.mjs')
const { buildFleetModel } = await import(CORE + 'models/fleet/index.mjs')
const { MeshoptSimplifier } = await import('meshoptimizer')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }

// ---------------- ① 遮罩哈希表 ----------------
await t('① 七千颗锚点：自身与容差内抖动处都查得到，远处不误中，探测距离 < 上限', () => {
  const pts = []
  for (let i = 0; i < 7000; i++) { const v = llaToVec(rnd() * 140 - 70, rnd() * 360 - 180, 540 + rnd() * 30); pts.push([v.x, v.y, v.z]) }
  for (let i = 0; i < 60; i++) { const v = llaToVec(0, rnd() * 360 - 180, 35786); pts.push([v.x, v.y, v.z]) }
  for (let i = 0; i < 50; i++) { const p = pts[i * 7]; pts.push([p[0] + 1e-5, p[1], p[2]]) }                // 百米内共位
  for (let i = 0; i < 40; i++) { const c = (Math.floor(rnd() * 2000) + 0.5) / DM.DM_CELL; pts.push([c + (i % 2 ? 1 : -1) * 0.49999 / DM.DM_CELL, 0.3, 1.0]) }   // 贴格界
  const xyz = new Float32Array(pts.length * 3), gid = new Int32Array(pts.length)
  pts.forEach((p, i) => { xyz.set(p, i * 3); gid[i] = i })
  const tb = DM.buildDotMaskTable(xyz, gid, pts.length, null)
  assert.ok(tb.maxProbe < DM.DM_PROBES, 'maxProbe ' + tb.maxProbe)
  assert.equal(tb.tab.length, tb.w * tb.h * 4)
  let miss = 0, missJ = 0
  pts.forEach((p, i) => {
    if (!DM.dotMaskLookup(tb, p).includes(i)) miss++
    const d = 1.2e-5 / Math.sqrt(3)
    const q = [p[0] + (rnd() < 0.5 ? -d : d), p[1] + (rnd() < 0.5 ? -d : d), p[2] + (rnd() < 0.5 ? -d : d)]
    if (!DM.dotMaskLookup(tb, q).includes(i)) missJ++
  })
  assert.equal(miss, 0, '自身位置漏查'); assert.equal(missJ, 0, '容差内抖动漏查')
  let false1 = 0
  for (let k = 0; k < 20000; k++) { const v = llaToVec(rnd() * 180 - 90, rnd() * 360 - 180, 300 + rnd() * 2000); if (DM.dotMaskLookup(tb, [v.x, v.y, v.z]).length) false1++ }
  assert.ok(false1 <= 2, '远处误中 ' + false1)   // 随机点恰落在某锚点 127 m 内的概率 ~1e-7 量级
  // 尺寸系数：与着色器同式
  assert.equal(DM.dotMaskHide(1, 28, 1, false), 1)
  assert.ok(Math.abs(DM.dotMaskHide(1, 6, 1, false) - 0.104) < 1e-12)
  assert.equal(DM.dotMaskHide(0.3, 4, 1, true), 1)
})

// 同格的项哈希到同一个槽、只能顺着往后排：第 33 项离哈希槽 ≥ 32、着色器探不到，表放多大都还是同一个槽 ——
// 原来「表长翻倍直到探得到」在这里永不收敛，一路翻倍到分配失败，页面每拍 set() 又重来一遍
await t('①b 同一格挤进 33 / 45 / 500 颗：建表收敛、表长至多 16 倍，同格只留前 32 项（都查得到），其余不遮；下一拍复用表、散开后回常态', () => {
  const C = [Math.floor(0.31 * DM.DM_CELL) + 0.5, Math.floor(0.82 * DM.DM_CELL) + 0.5, Math.floor(0.47 * DM.DM_CELL) + 0.5]   // 格心（格单位）
  for (const k of [33, 45, 500]) {
    const xyz = new Float32Array(k * 3), gid = new Int32Array(k)
    for (let i = 0; i < k; i++) {
      for (let a = 0; a < 3; a++) xyz[i * 3 + a] = (C[a] + (rnd() - 0.5) * 0.2) / DM.DM_CELL   // 格心 ±0.1 格（≈ ±600 m），不贴格界
      gid[i] = i
    }
    const tb = DM.buildDotMaskTable(xyz, gid, k, null)
    const need = Math.max(6, Math.ceil(Math.log2(tb.entries * 2)))
    assert.equal(tb.entries, k)
    assert.ok(tb.maxProbe < DM.DM_PROBES, 'maxProbe ' + tb.maxProbe)
    assert.ok(tb.bits <= need + 4, `表长 2^${tb.bits}，装载率 1/2 那档是 2^${need}`)
    assert.equal(tb.dropped, k - DM.DM_PROBES)
    assert.equal(tb.capped, true)
    for (let i = 0; i < k; i++) {
      const hit = DM.dotMaskLookup(tb, [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]).includes(i)
      assert.equal(hit, i < DM.DM_PROBES, `第 ${i} 颗${hit ? '查到了' : '没查到'}`)
    }
    // 下一拍（星稍动）：直接按限额插，表不再翻倍、Float32Array 原样复用
    for (let i = 0; i < k * 3; i++) xyz[i] += 1e-7
    const tb2 = DM.buildDotMaskTable(xyz, gid, k, tb)
    assert.ok(tb2.tab === tb.tab && tb2.bits === tb.bits && tb2.capped && tb2.dropped === k - DM.DM_PROBES)
    // 散开（沿迹 300 km）：限额一项都没扣，下一拍回到不限额的常态
    for (let i = 0; i < k; i++) { const v = llaToVec(30, 100 + 2.7 * i / k, 550); xyz[i * 3] = v.x; xyz[i * 3 + 1] = v.y; xyz[i * 3 + 2] = v.z }
    const tb3 = DM.buildDotMaskTable(xyz, gid, k, tb2)
    assert.ok(tb3.dropped === 0 && !tb3.capped, `散开后 dropped ${tb3.dropped}`)
    for (let i = 0; i < k; i++) assert.ok(DM.dotMaskLookup(tb3, [xyz[i * 3], xyz[i * 3 + 1], xyz[i * 3 + 2]]).includes(i))
  }
})

// ---------------- ② 烘焙 vs 真场景树 ----------------
const plainIR = (ir) => { for (const m of ir.materials) delete m.key; return ir }
function mountOf(r) {
  const root = irToThree(plainIR(r.ir))
  const inst = { root, meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups } }
  return ML.__test.mountInstance(inst)
}
for (const [name, build] of [['default-sat', () => buildTemplateModel('default-sat')], ['starlink-v2mini', () => buildFleetModel('starlink-v2mini')]]) {
  await t(`② ${name}：烘焙部件经着色器镜像 = 场景树逐顶点（随机太阳方向驱动太阳翼，含实例位姿）`, () => {
    const mount = mountOf(build())
    assert.ok(mount.sun && mount.sun.specs.length > 0, '没有对日关节')
    const { parts } = IB.bakeParts(mount, mount.sun.specs)
    assert.ok(parts.length > 0)
    assert.ok(parts.some((p) => p.bones.length > 0), '太阳翼部件没带关节')
    let worst = 0, cnt = 0
    for (let k = 0; k < 12; k++) {
      const s = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize()
      mount.sun.update(s)
      const ang = mount.sun.angles().map((d) => (Number.isFinite(d) ? d * Math.PI / 180 : 0))
      mount.holder.updateMatrixWorld(true)
      const inst = { pos: [0.3, 0.9, 0.6], quat: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 2, 3).normalize(), rnd() * 6).toArray(), k0: 1e-5 + rnd() * 1e-4 }
      const qi = new THREE.Quaternion().fromArray(inst.quat)
      const v = new THREE.Vector3()
      for (const p of parts) {
        for (const src of p.srcs) {
          const P = src.mesh.geometry.attributes.position
          for (let i = 0; i < src.vc; i += 7) {
            const o = (src.base + i) * 3
            const got = IB.iconVertexMirror(p, [p.attrs.position.array[o], p.attrs.position.array[o + 1], p.attrs.position.array[o + 2]], ang, inst)
            v.fromBufferAttribute(P, i).applyMatrix4(src.mesh.matrixWorld).multiplyScalar(inst.k0).applyQuaternion(qi).add(new THREE.Vector3(...inst.pos))
            worst = Math.max(worst, Math.hypot(got[0] - v.x, got[1] - v.y, got[2] - v.z) / inst.k0)
            cnt++
          }
        }
      }
    }
    assert.ok(cnt > 1000)
    assert.ok(worst < 2e-4, '最大偏差 ' + worst.toExponential(2) + ' m')   // float32 烘焙 + 矩阵往返，米制几毫米以内
  })
}

// ---------------- ③ 抽稀档 ----------------
await t('③ 抽稀：三角形减少、索引不越界、角点与代表顶点同位置且法向朝本三角形一侧', async () => {
  await MeshoptSimplifier.ready
  const mount = mountOf(buildFleetModel('starlink-v2mini'))
  const { parts, tris } = IB.bakeParts(mount, mount.sun.specs)
  const raw = parts.map((p) => ({ pos: p.attrs.position.array, nrm: p.attrs.normal ? p.attrs.normal.array : null, idx: p.index }))
  const box = new THREE.Box3()
  for (const p of parts) for (let i = 0; i < p.attrs.position.array.length; i += 3) box.expandByPoint(new THREE.Vector3(...p.attrs.position.array.slice(i, i + 3)))
  const E = Math.max(...box.getSize(new THREE.Vector3()).toArray())
  const levels = LOD.simplifyIconParts(MeshoptSimplifier, raw, LOD.ICON_LOD_ERR.slice(1).map((e) => e * E))
  const triOf = (lv) => lv.reduce((s, ix) => s + (ix ? ix.length / 3 : 0), 0)
  const t3 = triOf(levels[2])   // 0.02 档
  assert.ok(t3 < tris * 0.3, `0.02 档 ${t3} / ${tris}`)
  let back = 0, all = 0
  levels.forEach((lv) => lv.forEach((ix, i) => {
    if (!ix) return
    const P = raw[i].pos, N = raw[i].nrm, nv = P.length / 3
    for (let k = 0; k < ix.length; k += 3) {
      for (let c = 0; c < 3; c++) assert.ok(ix[k + c] < nv)
      if (!N) continue
      const a = ix[k], b = ix[k + 1], cc = ix[k + 2]
      const u = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]], w = [P[cc * 3] - P[a * 3], P[cc * 3 + 1] - P[a * 3 + 1], P[cc * 3 + 2] - P[a * 3 + 2]]
      const f = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      for (let c = 0; c < 3; c++) { const v = ix[k + c]; all++; if (N[v * 3] * f[0] + N[v * 3 + 1] * f[1] + N[v * 3 + 2] * f[2] < 0) back++ }
    }
  }))
  assert.ok(back / all < 0.02, `法向背离本三角形的角点 ${back} / ${all}`)
})

// ---------------- ④ 批次冒烟 ----------------
await t('④ 几百颗同模型：一组、draw call = 部件数；撤掉后淡出摘净；有图标时遮罩表打开', async () => {
  const L = ML.createModelLayer({})
  let maskOn = false
  const L2 = ML.createModelLayer({ onMaskChange: (on) => { maskOn = on } })
  for (const layer of [L, L2]) layer.setIconStyle({ on: true, px: 28 })
  const list = []
  for (let i = 0; i < 300; i++) {
    const a = llaToVec(rnd() * 120 - 60, rnd() * 360 - 180, 550)
    list.push({ key: 'n:' + i, modelId: 'ent:vsat-1p2', anchor: [a.x, a.y, a.z], qL2S: [0, 0, 0, 1], altKm: 550, eclipse: 1 })
  }
  const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 100)
  cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
  L2.setIcons(list)
  const t0 = Date.now()
  let s = null
  for (;;) {
    L2.overlay.update(0.05, cam, 1600, 900)
    s = L2.stats()
    if (s.iconGroups === 1 && s.iconDraws > 0 && s.iconsVisible > 0) break
    assert.ok(Date.now() - t0 < 15000, '15 s 内没就绪 ' + JSON.stringify(s.iconLevels))
    await new Promise((r) => setTimeout(r, 50))
  }
  for (let i = 0; i < 12; i++) L2.overlay.update(0.05, cam, 1600, 900)
  s = L2.stats()
  assert.equal(s.icons, 300)
  assert.equal(s.iconGroups, 1)
  assert.ok(s.iconDraws > 0 && s.iconDraws <= 20, 'draw call ' + s.iconDraws)
  assert.ok(s.iconsVisible > 30 && s.iconsVisible < 300, '可见 ' + s.iconsVisible)   // 背面的被地球挡住
  assert.ok(s.iconsPx.every(([, d]) => Math.abs(d - 28) < 1e-9))
  assert.equal(maskOn, true)
  const m = L2.overlay.dotMask()
  assert.ok(m && m.bits >= 0 && m.tab && m.inst)
  L2.setIcons([])
  for (let i = 0; i < 12; i++) L2.overlay.update(0.05, cam, 1600, 900)
  assert.equal(L2.stats().icons, 0)
  assert.equal(maskOn, false)
  L.dispose(); L2.dispose()
})

// ---------------- ⑤ 摘实例后的槽位重传 ----------------
// removeInst 把末尾那颗挪进空出的槽（只动 CPU 数组）。挪完只重传 iMisc 的话，GPU 那一格还是被摘那颗的位姿 ——
// 换聚焦星时新星的模型画在刚取消的那颗星上，要等下一拍 set() 整份重传才归位（时钟停着就一直错）。
// 「GPU」按 three WebGLAttributes 的口径镜像：version 变了才传，有 updateRanges 只传这几段（没有就整份），传完清空
await t('⑤ 同模型换聚焦星：旧星摘掉后 GPU 上 0 号实例的位置 / 姿态是新星的（中间不再 set）', async () => {
  const r = buildTemplateModel('default-sat')
  const scene = new THREE.Scene()
  const B = IB.createIconBatch({
    scene,
    acquire: async () => ({ root: irToThree(plainIR(r.ir)), meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups }, release() {} }),
    mount: (inst, frame) => ML.__test.mountInstance(inst, frame),
    frameSig: () => '', waitRenderer: () => null, warmUp: async () => {}, envTex: () => null, isWeak: () => false, envI: 1, eclFloor: 0.2
  })
  const gpu = new WeakMap()
  const upload = () => scene.traverse((o) => {
    const g = o.geometry
    if (!g || !g.isInstancedBufferGeometry) return
    for (const k of ['iPos', 'iQuat', 'iMisc']) {
      const a = g.attributes[k]
      let s = gpu.get(a)
      if (!s) { gpu.set(a, { ver: a.version, arr: a.array.slice() }); a.clearUpdateRanges(); continue }
      if (s.ver === a.version) continue
      if (!a.updateRanges.length) s.arr.set(a.array)
      else for (const rg of a.updateRanges) s.arr.set(a.array.subarray(rg.start, rg.start + rg.count), rg.start)
      a.clearUpdateRanges(); s.ver = a.version
    }
  })
  const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 100)
  cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
  const frame = () => { B.update(0.05, cam, 1600, 900, true); upload() }
  const pa = llaToVec(10, 20, 550), pb = llaToVec(-30, 60, 550)
  const qa = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.7).toArray()
  const qb = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.9).toArray()
  const item = (key, p, q) => ({ key, modelId: 'test:sat', anchor: [p.x, p.y, p.z], qL2S: q, altKm: 550, eclipse: 1 })
  B.set([item('n:A', pa, qa)])
  for (let i = 0; i < 300 && !B.drawable(); i++) { frame(); await new Promise((res) => setTimeout(res, 5)) }
  assert.ok(B.drawable(), '模板没就绪')
  for (let i = 0; i < 10; i++) frame()
  B.set([item('n:B', pb, qb)]); upload()                       // 新星进 1 号槽，旧星淡出
  for (let i = 0; i < 20 && B.count() > 1; i++) frame()
  assert.equal(B.count(), 1, '旧星没摘掉')
  for (let i = 0; i < 10; i++) frame()                         // 时钟停着：不再 set()
  let geo = null
  scene.traverse((o) => { if (!geo && o.geometry && o.geometry.isInstancedBufferGeometry) geo = o.geometry })
  assert.equal(geo.instanceCount, 1)
  const P = gpu.get(geo.attributes.iPos).arr, Q = gpu.get(geo.attributes.iQuat).arr
  assert.ok(Math.hypot(P[0] - pb.x, P[1] - pb.y, P[2] - pb.z) < 1e-6, 'GPU 0 号实例位置不是新星：' + Array.from(P.subarray(0, 3)).map((v) => v.toFixed(4)) + ' 应为 ' + [pb.x, pb.y, pb.z].map((v) => v.toFixed(4)))
  for (let c = 0; c < 4; c++) assert.ok(Math.abs(Q[c] - qb[c]) < 1e-6, 'GPU 0 号实例姿态不是新星的')
  B.dispose()
})

// ---------------- ⑥ 逐像素地球遮挡 ----------------
// 图标当成立在锚点、正对相机的板（板距 boardAt），视线与地球（EARTH_R）的近交点比板近就藏；整颗剔除（hiddenAt）必须保守。
// 原口径（锚点没被挡 → 整颗压在地球上；被挡 → 整颗消失）作对照：用户实拍「模型在地球后面却压住地球」
{
  const { boardAt, hiddenAt, earthOccludes, occludedAt, CULL_MARGIN } = IB.__test
  const V = (x, y, z) => new THREE.Vector3(x, y, z)
  // 图标视锥内（半角 asin(rw/d)）按同心圆取视线：中心 + 8 圈 × 48 条
  const footprint = (C, A, rw) => {
    const d = A.distanceTo(C), a = A.clone().sub(C).normalize()
    const th = Math.asin(Math.min(1, rw / d))
    const e1 = new THREE.Vector3().crossVectors(a, Math.abs(a.y) < 0.9 ? V(0, 1, 0) : V(1, 0, 0)).normalize()
    const e2 = new THREE.Vector3().crossVectors(a, e1)
    const out = [a.clone()]
    for (let k = 1; k <= 8; k++) for (let j = 0; j < 48; j++) {
      const t = th * k / 8, p = j / 48 * 2 * Math.PI
      out.push(a.clone().multiplyScalar(Math.cos(t)).addScaledVector(e1, Math.sin(t) * Math.cos(p)).addScaledVector(e2, Math.sin(t) * Math.sin(p)).normalize())
    }
    return { a, d, rays: out }
  }
  const hitsEarth = (C, u) => { const b = u.dot(C); return b < 0 && b * b - (C.lengthSq() - IB.EARTH_R ** 2) > 0 }
  const occOf = (C, A, rw) => { const f = footprint(C, A, rw); const wb = boardAt(C, f.d, rw); return f.rays.map((u) => earthOccludes(C, u, f.a, wb)) }

  await t('⑥a 地球背面、锚点露在轮廓外的大图标（原口径整颗压在地球上）：落在地球轮廓内的视线全藏、轮廓外全露', () => {
    const C = V(0, 0, 4.5)                                     // 相机在 GEO 环里面：轮廓旁的 GEO 星都在地球后面
    const u0 = V(Math.sin(16 * Math.PI / 180), 0, -Math.cos(16 * Math.PI / 180))
    const A = C.clone().addScaledVector(u0, 10.8)               // |A| ≈ 6.6
    assert.ok(Math.abs(A.length() - 6.6) < 0.05)
    assert.equal(occludedAt(C, A.x, A.y, A.z), false, '前提：锚点没被挡（原口径整颗画在地球上面）')
    const rw = 2.4
    const f = footprint(C, A, rw)
    const occ = occOf(C, A, rw)
    let inE = 0
    f.rays.forEach((u, i) => { const h = hitsEarth(C, u); if (h) inE++; assert.equal(occ[i], h, '第 ' + i + ' 条视线') })
    assert.ok(inE > 50 && inE < f.rays.length - 50, '轮廓内外都要有：' + inE)
    assert.equal(hiddenAt(C, A.x, A.y, A.z, rw), false)
  })

  await t('⑥b 锚点刚转到地球背面（原口径整颗消失）：露在轮廓外的部分照画、不整颗剔；锚点那条视线被挡', () => {
    const C = V(0, 0, 4.5)
    const u0 = V(Math.sin(11 * Math.PI / 180), 0, -Math.cos(11 * Math.PI / 180))   // 地球轮廓半角 asin(0.998/4.5) ≈ 12.8°
    const A = C.clone().addScaledVector(u0, 10.9)
    assert.equal(occludedAt(C, A.x, A.y, A.z), true, '前提：锚点被挡')
    const rw = 1.2
    const occ = occOf(C, A, rw)
    assert.equal(occ[0], true, '锚点那条视线')
    assert.ok(occ.some((o) => !o), '轮廓外的部分要露出来')
    assert.equal(hiddenAt(C, A.x, A.y, A.z, rw), false, '不许整颗剔')
    assert.equal(hiddenAt(C, A.x, A.y, A.z, 0.05), true, '小图标整颗在轮廓内 → 整颗剔')
  })

  await t('⑥c 近地侧低轨星的大图标：看得见、投在地球轮廓内的锚点，离轮廓 5% 以内才可能削到外圈（≤ 5% 的视线），其余一条不削', () => {
    let worst = 0, cases = 0
    for (const D of [1.6, 2, 3, 5, 9]) {
      const C = V(0, 0, D)
      const wpp = 2 * Math.tan(21 * Math.PI / 180) / 900
      const thE = Math.asin(IB.EARTH_R / D)
      for (let k = 0; k < 1500; k++) {
        const A = llaToVec(rnd() * 180 - 90, rnd() * 360 - 180, 300 + rnd() * 1700)
        if (occludedAt(C, A.x, A.y, A.z)) continue
        const d = A.distanceTo(C)
        const aDir = A.clone().sub(C).normalize()
        if (!hitsEarth(C, aDir)) continue                         // 只看投在地球轮廓内的（近地侧、看得见）
        const px = 20 + rnd() * 280                              // 图标半径 20–300 px
        const occ = occOf(C, A, px * d * wpp)
        const frac = occ.filter(Boolean).length / occ.length
        const rho = Math.acos(-aDir.dot(C) / D) / thE             // 锚点离地心的视角 / 地球轮廓半角
        if (rho <= 0.95) assert.equal(frac, 0, `D=${D} rho=${rho.toFixed(3)} px=${px.toFixed(0)} 削掉 ${frac}`)
        worst = Math.max(worst, frac)
        cases++
      }
    }
    assert.ok(cases > 500, '样本 ' + cases)
    assert.ok(worst <= 0.05, '贴轮廓的近地侧图标削掉的视线占比 ' + worst)
  })

  await t('⑥d 整颗剔除保守：hiddenAt 说整颗藏的，视锥内（含余量）每条视线逐像素都藏；切线长以外的看不见锚点不提板', () => {
    let culled = 0, back = 0
    for (let k = 0; k < 3000; k++) {
      const D = 1.3 + rnd() * 12
      const C = V(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize().multiplyScalar(D)
      const alt = [550, 1200, 8000, 20200, 35786][k % 5]
      const A = llaToVec(rnd() * 180 - 90, rnd() * 360 - 180, alt)
      const d = A.distanceTo(C)
      const rw = d * (0.001 + rnd() * 0.25)
      if (occludedAt(C, A.x, A.y, A.z)) { back++; assert.equal(boardAt(C, d, rw), d, '背面锚点不提板') }
      if (!hiddenAt(C, A.x, A.y, A.z, rw)) continue
      culled++
      assert.ok(occOf(C, A, rw * CULL_MARGIN).every(Boolean), '剔了却有视线没被挡')
    }
    assert.ok(culled > 100 && back > culled, `剔除 ${culled} / 背面 ${back}`)
  })

  await t('⑥e 着色器与 JS 镜像同式：地球半径 / 板距 / 剔除判据的关键句都在着色器源码里', () => {
    const src = readFileSync(path.resolve(HERE, '../../../src/viz/globe3d/iconBatch.js'), 'utf8')
    assert.match(src, /#define IC_RE \$\{EARTH_R\.toFixed\(4\)\}/)
    assert.match(src, /float icTl = sqrt\( max\( 0\.0, dot\( cameraPosition, cameraPosition \) - IC_RE \* IC_RE \) \);/)
    assert.match(src, /vIcBb = vec4\( icDv \/ icD, icD - min\( icRw, max\( 0\.0, \$\{BOARD_K\.toFixed\(1\)\} \* \( icTl - icD \) \) \) \);/)
    assert.match(src, /return d - Math\.min\(rw, Math\.max\(0, BOARD_K \* \(L - d\)\)\)/)
    assert.match(src, /icCull = icHidden\( vIcBb\.xyz, vIcBb\.w, icRw \* \$\{CULL_MARGIN\.toFixed\(2\)\} \/ icD \)/)
    assert.match(src, /float ds = b < 0\.0 \? b \* b - l2 : - l2;/)
    assert.match(src, /if \( icVis < 0\.004 \) discard;/)
    assert.doesNotMatch(src, /icQc = dot\( cameraPosition, cameraPosition \) - 1\.0/, '锚点整颗显隐的旧判据不许回来')
    assert.equal(IB.EARTH_R, 0.998)
  })
}

// ---------------- ⑦ 预编译期间加星 ----------------
// 第 0 档几何在预编译（warmUp，约 0.1–1 s）之前按当时的颗数 / 实例属性造好；这期间加进来的同模型星，换上之后 instanceCount 还是旧值、
// 扩容换的新实例属性也没挂上 —— 全精度档上不画，点却照遮（图标调大、拉近时一直缺）
await t('⑦ 预编译期间加 1 颗 / 20 颗同模型星：换上的第 0 档几何颗数对、挂的是批次此刻的实例属性', async () => {
  const r = buildTemplateModel('default-sat')
  const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 100)
  cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
  for (const nAdd of [1, 20]) {
    const scene = new THREE.Scene()
    let release = null, warmCalled = false
    const gate = new Promise((res) => { release = res })
    const B = IB.createIconBatch({
      scene,
      acquire: async () => ({ root: irToThree(plainIR(r.ir)), meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups }, release() {} }),
      mount: (inst, frame) => ML.__test.mountInstance(inst, frame),
      frameSig: () => '', waitRenderer: () => null, warmUp: async () => { warmCalled = true; await gate }, envTex: () => null, isWeak: () => false, envI: 1, eclFloor: 0.2
    })
    const item = (k) => { const p = llaToVec(10 + k * 0.5, 20 + k, 550); return { key: 'n:' + k, modelId: 'test:sat', anchor: [p.x, p.y, p.z], qL2S: [0, 0, 0, 1], altKm: 550, eclipse: 1 } }
    B.set([item(0)])
    for (let i = 0; i < 400 && !warmCalled; i++) await new Promise((res) => setTimeout(res, 5))
    assert.ok(warmCalled, 'warmUp 没被调到')
    const list = [item(0)]
    for (let k = 1; k <= nAdd; k++) list.push(item(k))
    B.set(list)                                                   // 预编译还没完：用户再加星
    release()
    for (let i = 0; i < 200 && !B.drawable(); i++) { B.update(0.05, cam, 1600, 900, true); await new Promise((res) => setTimeout(res, 5)) }
    assert.ok(B.drawable(), '模板没就绪')
    for (let i = 0; i < 10; i++) B.update(0.05, cam, 1600, 900, true)   // 时钟停着：不再 set()
    let geo = null
    scene.traverse((o) => { if (!geo && o.geometry && o.geometry.isInstancedBufferGeometry && o.parent && o.parent.visible) geo = o.geometry })
    assert.equal(geo.instanceCount, nAdd + 1, '第 0 档几何的颗数')
    const before = geo.attributes.iPos.array[0]
    B.set(list.map((it) => ({ ...it, anchor: [it.anchor[0] + 0.01, it.anchor[1], it.anchor[2]] })))
    assert.notEqual(geo.attributes.iPos.array[0], before, '几何上挂的不是批次此刻写的那份实例属性')
    B.dispose()
  }
})

// ---------------- ⑧ 出图 / 出帧的抽稀档 ----------------
// 选档量的是屏上 CSS px 的误差（≤ 1 px）。4× 出图 / 视频超采样沿用屏上那一档，误差在输出上放大 4 倍：折面、被 Prune 掉的小部件
await t('⑧ 抽稀按输出像素选：屏上那一档在 4× 出图上超 1 px；setLodScale(4) 后下一次 update 当场换细档，调回 1 回屏上那一档；scene 出图 / 出帧前后都接上', async () => {
  await MeshoptSimplifier.ready
  const r = buildFleetModel('starlink-v2mini')
  const mount = mountOf(r)
  const bx = mount.box, extent = Math.max(bx.max[0] - bx.min[0], bx.max[1] - bx.min[1], bx.max[2] - bx.min[2])
  const { pointZoomK } = await import(SRC + 'globe3d/zoomScale.js')
  const pxR = 28 * pointZoomK(3) * 0.5                       // 出厂图标大小、出厂视距
  const err = (j, s) => LOD.ICON_LOD_ERR[j] * extent * pxR * s / mount.radius
  const j1 = IB.iconLodLevel(extent, mount.radius, pxR, 1), j4 = IB.iconLodLevel(extent, mount.radius, pxR, 4)
  assert.ok(j1 > 0 && err(j1, 1) <= 1 && err(j1, 4) > 1, `屏上档 ${j1}：屏上误差 ${err(j1, 1).toFixed(2)} px、4× 出图 ${err(j1, 4).toFixed(2)} px`)
  assert.ok(j4 < j1 && err(j4, 4) <= 1, `4× 档 ${j4}：出图误差 ${err(j4, 4).toFixed(2)} px`)
  assert.equal(IB.iconLodLevel(extent, mount.radius, pxR, 0.5), j1, '倍率 < 1 按 1')

  // 真批次（抽稀 Worker 换成同步的替身，算法同 iconLodWorker.js）
  const hadWorker = 'Worker' in globalThis, W0 = globalThis.Worker
  globalThis.Worker = class {
    postMessage(m) { Promise.resolve(MeshoptSimplifier.ready).then(() => { const levels = LOD.simplifyIconParts(MeshoptSimplifier, m.parts, m.errs); if (this.onmessage) this.onmessage({ data: { id: m.id, ok: true, levels } }) }) }
    terminate() {}
  }
  try {
    const scene = new THREE.Scene()
    const B = IB.createIconBatch({
      scene,
      acquire: async () => ({ root: irToThree(plainIR(r.ir)), meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups }, release() {} }),
      mount: (inst, frame) => ML.__test.mountInstance(inst, frame),
      frameSig: () => '', waitRenderer: () => null, warmUp: async () => {}, envTex: () => null, isWeak: () => false, envI: 1, eclFloor: 0.2
    })
    const cam = new THREE.PerspectiveCamera(42, 1600 / 900, 0.01, 100)
    cam.position.set(0, 0, 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
    const p = new THREE.Vector3(0.2, 0.1, 1).normalize().multiplyScalar(1 + 550 / 6371)   // 正对相机那一侧
    B.set([{ key: 'n:0', modelId: 'fleet:v2mini', anchor: [p.x, p.y, p.z], qL2S: [0, 0, 0, 1], altKm: 550, eclipse: 1 }])
    const lv = () => B.stats().iconLevels[0]
    // 某档抽稀成空（tris 0）时选档往细里找：期望档按同一规则折一下
    const has = (J) => { const L = lv().levels; let k = J; while (k > 0 && !(L[k] > 0)) k--; return k }
    const ready = () => B.drawable() && lv().levels.length === LOD.ICON_LOD_ERR.length && lv().level === has(j1)
    for (let i = 0; i < 400 && !ready(); i++) { B.update(0.05, cam, 1600, 900, true); await new Promise((res) => setTimeout(res, 20)) }
    assert.ok(ready(), '屏上档：' + JSON.stringify(lv()))
    assert.ok(has(j4) < has(j1), '4× 出图应有更细的档：' + JSON.stringify(lv()))
    B.setLodScale(4)
    B.update(0, cam, 1600, 900, true)                         // 同一时刻（不到 100 ms 节流）：当场重选
    assert.ok(lv().level === has(j4) && B.lodScale() === 4, '4× 出图档：' + JSON.stringify(lv()))
    B.setLodScale(1)
    B.update(0, cam, 1600, 900, true)
    assert.equal(lv().level, has(j1), '出完回屏上档')
    B.dispose()
  } finally {
    if (hadWorker) globalThis.Worker = W0; else delete globalThis.Worker
  }

  // 接线：scene 出图在渲染前把实际倍率交给图标层、finally 里调回；视频逐帧按渲染倍率、结束调回；图标层转给批次
  const SCENE = readFileSync(path.resolve(HERE, '../../../src/viz/globe3d/scene.js'), 'utf8').replace(/\r\n/g, '\n')
  const snap = /async function snapshot\([\s\S]*?\n  \}\n/.exec(SCENE)[0]
  assert.ok(snap.indexOf('overlay.setLodScale(s)') > 0 && snap.indexOf('overlay.setLodScale(s)') < snap.indexOf('if (overlay) overlay.update(0, camera, curW, curH)'), 'snapshot：先交倍率再 update')
  assert.match(snap, /finally \{[\s\S]*overlay\.setLodScale\(1\)/)
  const capF = /async function captureFrame\([\s\S]*?\n  \}\n/.exec(SCENE)[0]
  assert.ok(capF.indexOf('overlay.setLodScale(renderer.getPixelRatio())') > 0 && capF.indexOf('overlay.setLodScale(renderer.getPixelRatio())') < capF.indexOf('if (overlay) overlay.update(0, camera, curW, curH)'), 'captureFrame：先交倍率再 update')
  assert.match(/function endCapture\(\) \{[\s\S]*?\n  \}\n/.exec(SCENE)[0], /overlay\.setLodScale\(1\)/)
  const MLS = readFileSync(path.resolve(HERE, '../../../src/viz/globe3d/modelLayer.js'), 'utf8')
  assert.match(MLS, /setLodScale\(s\) \{ if \(!disposed\) batch\.setLodScale\(s\) \}/)
})

console.log(`modelIconBatch: ${n} 项通过`)
