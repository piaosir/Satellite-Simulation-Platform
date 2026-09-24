// 标记实体模型层（src/viz/globe3d/entityLayer.js，P4 契约 §3.1 / §3.5）不依赖 GPU / DOM 的几何与生命期口径：
//   ① 展平：源网格数 = 模型可见网格数；每个源网格「实例矩阵 × 烘焙矩阵」= three 原树（holder(E) · body(MB) · 静止位姿）的 matrixWorld（≤ 1e-9）
//   ② 关节：13 m 站 / X-Y 座 / 车载站按瞄准驱动 (a1, a2) 后，关节帧的网格 = thumbs.poseArticulations(jointValuesOf(同值)) 后的 matrixWorld（≤ 1e-9）；
//      未受驱动的关节（船的雷达 / 螺旋桨）烘在静止位姿
//   ③ 锚点：船 datum 落在 sceneAnchor(lat, lon, 0)（≤ 1e-12）；A320 altM = 10668 时 datum 在 r = 1 + 10.668/6371；altM = 0 时按真实尺度
//      机腹最低点在地面（≤ 1e-9）；地球站（无 datum）盒底 · 方位轴 x / y
//   ④ 屏幕恒定：相机距离 2 / 4 / 8 时包围球投影直径 = px（±1 %）；逐实体 px 覆盖
//   ⑤ 姿态：载具航向 90° 时本体 +X（机头）= 当地正东（≥ 0.999999）；无关节模型整体转方位、目标一跳 > 2° 时一阶逼近、连续跟踪贴合
//   ⑥ spriteWeight = 1 − alpha；setEnabled(false) 即刻恒 1、再开即满 alpha（不做交叉淡化）；换模型先淡出旧的；移除后淡出回收
//   ⑦ 船 aClip：平面过锚点、法向 = 当地天顶；其余类别不裁
//   ⑧ update 稳态零分配（相机与状态不变 / 相机每帧微动两种；采样堆分析、宽判据、报数）
//   ⑨ dispose：inst.release 次数 = acquire 次数；材质 / 包装几何全部 dispose；命中 / 屏幕缓存 / 截断口径
// 画面（逐像素零漂移、光照两档截图、帧时）归真 Electron 验证台（契约 §6），这里不重复。
// 渲染端源码用 @core/… 别名：先注册解析钩子再动态导入（写法同 modelGlobeLayer.test.mjs）。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Session } from 'node:inspector/promises'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const { createEntityLayer } = await import(SRC + 'globe3d/entityLayer.js')
const { irToThree } = await import(SRC + 'models/irToThree.js')
const { applyRestPose, poseArticulations } = await import(SRC + 'models/thumbs.js')
const { modelToBodyMatrix } = await import(SRC + 'models/view.js')
const { buildAssembly } = await import(CORE + 'models/assembly.mjs')
const { entityTemplateDoc, getEntityTemplate } = await import(CORE + 'models/entityTemplates.mjs')
const EP = await import(CORE + 'models/entityPose.mjs')
const ER = await import(CORE + 'models/entityRuntime.mjs')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const D2R = Math.PI / 180
const tick = () => new Promise((r) => setTimeout(r, 0))
async function settle() { for (let i = 0; i < 6; i++) await tick() }

// ── 假来源：与 modelLayer createModelSource 的 ent: 分支同形（buildAssembly(entityTemplateDoc(id).doc) → irToThree；meta 带 attachPoints / kind）──
function makeSource() {
  const cache = new Map()
  const src = {
    acquired: 0, released: 0,
    built(id) {
      let c = cache.get(id)
      if (!c) {
        const d = entityTemplateDoc(id)
        const r = buildAssembly(d.doc)
        const tpl = getEntityTemplate(id)
        c = { r, root: irToThree(r.ir), meta: { id, kind: tpl.modelKind, frame: r.frame, units: { scaleToMeters: 1, sizeVerified: true }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups, attachPoints: r.attachPoints } }
        cache.set(id, c)
      }
      return c
    },
    async acquire(id) {
      if (!getEntityTemplate(id)) return null
      const c = src.built(id)
      src.acquired++
      let rel = false
      return { root: c.root.clone(true), meta: c.meta, lod: 'param', pending: false, release() { if (!rel) { rel = true; src.released++ } } }
    },
    forget() {},
    onReady() { return () => {} }
  }
  return src
}
// 参照树：同一份 IR 现造、摆静止位姿（或按关节值）
function refTree(src, id, values) {
  const c = src.built(id)
  const root = irToThree(c.r.ir)
  if (values) poseArticulations(root, c.meta.articulations, values)
  else applyRestPose(root, c.meta)
  root.updateMatrixWorld(true)
  const meshes = []
  root.traverseVisible((o) => { if (o.isMesh && o.geometry && o.geometry.attributes.position) meshes.push(o) })
  return { root, meshes, MB: modelToBodyMatrix(c.meta, new THREE.Matrix4()), meta: c.meta }
}
function cam(D, lat, lon, w = 1600, h = 900) {
  const c = new THREE.PerspectiveCamera(42, w / h, 1e-5, 100)
  const a = EP.sceneAnchor(lat, lon, 0)
  c.position.set(a[0] * D, a[1] * D, a[2] * D)
  c.up.set(0, 1, 0)
  c.lookAt(a[0], a[1], a[2])
  c.updateMatrixWorld(true)
  return c
}
const m4 = (arr) => new THREE.Matrix4().fromArray(arr)
function maxDiff(a, b) { let d = 0; for (let i = 0; i < 16; i++) d = Math.max(d, Math.abs(a.elements[i] - b.elements[i])); return d }
function applyE(E, p) { return [E[0] * p[0] + E[4] * p[1] + E[8] * p[2] + E[12], E[1] * p[0] + E[5] * p[1] + E[9] * p[2] + E[13], E[2] * p[0] + E[6] * p[1] + E[10] * p[2] + E[14]] }
const len3 = (v) => Math.hypot(v[0], v[1], v[2])
const item = (o) => ({ key: o.key, kind: o.kind, modelId: o.modelId, px: o.px ?? 28, lat: o.lat, lon: o.lon, altM: o.altM ?? 0, headingDeg: o.headingDeg ?? 0, pitchDeg: o.pitchDeg ?? 0, aim: o.aim ?? null })
// 按实例矩阵（双精度复算：entity(key).E / D）与烘焙矩阵拼出每个源网格的世界矩阵，与参照树对拍
function checkFlatten(L, key, id, ref, tol = 1e-9) {
  const e = L._debug.entity(key)
  const I = L._debug.internals(id)
  const V = I.V
  assert.equal(V.bakes.length, ref.meshes.length, `${id}：源网格数 ${V.bakes.length} ≠ 可见网格数 ${ref.meshes.length}`)
  const E = m4(e.E)
  let worst = 0
  for (let i = 0; i < V.bakes.length; i++) {
    const b = V.bakes[i]
    const inst = b.frame === 0 ? E.clone() : E.clone().multiply(m4(e.D.slice(b.frame * 16, b.frame * 16 + 16)))
    const got = inst.multiply(b.bake)
    const exp = E.clone().multiply(ref.MB).multiply(ref.meshes[i].matrixWorld)
    worst = Math.max(worst, maxDiff(got, exp))
  }
  assert.ok(worst <= tol, `${id}：实例 × 烘焙 与 three 原树差 ${worst.toExponential(2)}`)
  return { worst, prims: V.groups.length, frames: I.frames.length }
}

const src = makeSource()
const L = createEntityLayer({ source: src, simplify: false, waitGpu: false })
L.setEnabled(true)
L.setSun([1, 0, 0])

// ─────────────────────────────── ① 展平 ───────────────────────────────
const MODELS = [
  { id: 'ent:es-13p1', kind: 'station', lat: 48.1, lon: 11.6 },
  { id: 'ent:vsat-1p2', kind: 'station', lat: -33.9, lon: 18.4 },
  { id: 'ent:es-xy-2p4', kind: 'station', lat: 64.1, lon: -21.9 },
  { id: 'ent:a320neo', kind: 'aircraft', lat: 50.03, lon: 8.57, altM: 10668, headingDeg: 250 },
  { id: 'ent:ulcs-24k', kind: 'ship', lat: -10, lon: 70, headingDeg: 45 },
  { id: 'ent:suv-cotm', kind: 'vehicle', lat: 35, lon: 110, headingDeg: 300 },
  { id: 'ent:van-driveaway', kind: 'vehicle', lat: 30, lon: 120, headingDeg: 10 }
]
const rows = []
await t('① 展平：源网格数 = 可见网格数；实例 × 烘焙 = holder(E)·body(MB)·静止位姿 matrixWorld（≤ 1e-9）', async () => {
  L.setEntities(MODELS.map((m, i) => item({ key: 'k' + i, kind: m.kind, modelId: m.id, lat: m.lat, lon: m.lon, altM: m.altM, headingDeg: m.headingDeg })))
  await settle()
  for (let i = 0; i < MODELS.length; i++) {
    const m = MODELS[i]
    L.overlay.update(0.5, cam(3, m.lat, m.lon), 1600, 900)
    const r = checkFlatten(L, 'k' + i, m.id, refTree(src, m.id))
    rows.push(`${m.id.slice(4)} 网格 ${refTree(src, m.id).meshes.length} → 组 ${r.prims}（帧 ${r.frames}）差 ${r.worst.toExponential(1)}`)
  }
  console.log('  ' + rows.join('；'))
  // 合批：绘制调用 = Σ（帧 × 材质）组，远少于网格数（船 114 个网格）
  const ship = L._debug.models().find((x) => x.id === 'ent:ulcs-24k')
  assert.ok(ship.prims <= 24, `船的合批组 ${ship.prims}`)
})

// ─────────────────────────────── ② 关节 ───────────────────────────────
const GEO = (lonDeg) => [42164 * Math.cos(lonDeg * D2R), 42164 * Math.sin(lonDeg * D2R), 0]
await t('② 关节：按瞄准驱动 (a1, a2) 后关节帧网格 = poseArticulations(jointValuesOf(a1, a2)) 的 matrixWorld（≤ 1e-9）；视轴对准瞄准方向', async () => {
  const cases = [
    { id: 'ent:es-13p1', lat: 48.1, lon: 11.6, geo: 30 },
    { id: 'ent:es-xy-2p4', lat: 64.1, lon: -21.9, geo: -30 },
    { id: 'ent:van-driveaway', lat: 30, lon: 120, geo: 110, kind: 'station' },
    { id: 'ent:vsat-1p2', lat: -33.9, lon: 18.4, geo: 10 }
  ]
  const out = []
  for (const c of cases) {
    const st = { lat: c.lat, lon: c.lon, altM: 0 }
    const look = EP.stationAimScene(st, GEO(c.geo), EP.makeStationLook())
    const key = 'aim:' + c.id
    L.setEntities([item({ key, kind: c.kind || 'station', modelId: c.id, lat: c.lat, lon: c.lon, aim: { dir: look.dir.slice(), azDeg: look.azDeg, elDeg: look.elDeg, park: false } })])
    await settle()
    const cm = cam(3, c.lat, c.lon)
    for (let k = 0; k < 20; k++) L.overlay.update(0.1, cm, 1600, 900)
    const e = L._debug.entity(key)
    assert.equal(e.aimMode, 'joints', c.id + ' 应走关节驱动')
    assert.ok(Number.isFinite(e.a1) && Number.isFinite(e.a2))
    const I = L._debug.internals(c.id)
    const vals = ER.jointValuesOf(I.rig, e.a1, e.a2, {})
    const r = checkFlatten(L, key, c.id, refTree(src, c.id, vals))
    // 视轴：dirFromGimbal 在挂点系 → 本体 → 场景，与瞄准方向的夹角（驱动值是 gimbal 主解）
    const G = await import(CORE + 'models/gimbal.mjs')
    const dm = G.dirFromGimbal(I.rig.type, e.a1, e.a2, [0, 0, 0])
    const f = I.rig.frame
    const db = [0, 1, 2].map((j) => dm[0] * f.x[j] + dm[1] * f.y[j] + dm[2] * f.z[j])
    const q = e.qB2S, qv = new THREE.Vector3(db[0], db[1], db[2]).applyQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]))
    const angDeg = Math.acos(Math.min(1, qv.dot(new THREE.Vector3(look.dir[0], look.dir[1], look.dir[2])))) / D2R
    assert.ok(angDeg < 1e-5, `${c.id} 视轴偏 ${angDeg}°`)
    out.push(`${c.id.slice(4)} a1 ${e.a1.toFixed(2)} a2 ${e.a2.toFixed(2)} 差 ${r.worst.toExponential(1)}`)
  }
  console.log('  ' + out.join('；'))
})
await t('② 停放：仰角 < 0（park）→ 俯仰收到限位内最靠近 90°（VSAT 1.2 m = 84），方位保持', async () => {
  const key = 'park:vsat'
  const st = { lat: -33.9, lon: 18.4 }
  const look = EP.stationAimScene(st, GEO(10), EP.makeStationLook())
  L.setEntities([item({ key, kind: 'station', modelId: 'ent:vsat-1p2', lat: st.lat, lon: st.lon, aim: { dir: look.dir.slice(), azDeg: look.azDeg, elDeg: look.elDeg, park: false } })])
  await settle()
  const cm = cam(3, st.lat, st.lon)
  for (let k = 0; k < 10; k++) L.overlay.update(0.1, cm, 1600, 900)
  const a1 = L._debug.entity(key).a1
  L.setEntities([item({ key, kind: 'station', modelId: 'ent:vsat-1p2', lat: st.lat, lon: st.lon, aim: { dir: look.dir.slice(), azDeg: look.azDeg, elDeg: -3, park: true } })])
  for (let k = 0; k < 40; k++) L.overlay.update(0.1, cm, 1600, 900)
  const e = L._debug.entity(key)
  const lim = L._debug.internals('ent:vsat-1p2').rig.lim
  assert.equal(e.a2, Math.min(90, lim.a2Max))
  assert.ok(Math.abs(e.a1 - a1) < 1e-9, '停放时方位保持')
})

// ─────────────────────────────── ③ 锚点 ───────────────────────────────
await t('③ 锚点：船 datum 落在 sceneAnchor(lat, lon, 0)（≤ 1e-12）、|A| = 1；地球站盒底 · 方位轴 x / y', async () => {
  L.setEntities([
    item({ key: 'ship', kind: 'ship', modelId: 'ent:ulcs-24k', lat: -10, lon: 70, headingDeg: 45 }),
    item({ key: 'es', kind: 'station', modelId: 'ent:es-13p1', lat: 48.1, lon: 11.6 })
  ])
  await settle()
  L.overlay.update(0.5, cam(3, -10, 70), 1600, 900)
  const e = L._debug.entity('ship')
  assert.equal(e.anchorSrc, 'datum')
  const hull = src.built('ent:ulcs-24k').meta.attachPoints.find((a) => /(^|_)datum$/.test(a.name))
  assert.deepEqual(e.anchorBody, hull.posBody)
  const P = applyE(e.E, e.anchorBody), A = EP.sceneAnchor(-10, 70, 0)
  assert.ok(Math.max(...P.map((v, i) => Math.abs(v - A[i]))) <= 1e-12)
  assert.ok(Math.abs(len3(A) - 1) <= 1e-15)
  L.overlay.update(0.5, cam(3, 48.1, 11.6), 1600, 900)
  const s = L._debug.entity('es')
  assert.equal(s.anchorSrc, 'bottom')
  const bore = src.built('ent:es-13p1').meta.attachPoints.find((a) => /(^|_)boresight$/.test(a.name))
  const box = L._debug.internals('ent:es-13p1').box
  assert.equal(s.anchorBody[0], bore.posBody[0]); assert.equal(s.anchorBody[1], bore.posBody[1]); assert.equal(s.anchorBody[2], box.max[2])
})
await t('③ 锚点：A320 altM = 10668 时 datum 在 r = 1 + 10.668/6371（≤ 1e-12）；altM = 0 时按真实尺度机腹最低点在地面（≤ 1e-9）', async () => {
  L.setEntities([item({ key: 'ac', kind: 'aircraft', modelId: 'ent:a320neo', lat: 50.03, lon: 8.57, altM: 10668, headingDeg: 250 })])
  await settle()
  L.overlay.update(0.5, cam(3, 50.03, 8.57), 1600, 900)
  let e = L._debug.entity('ac')
  assert.equal(e.anchorSrc, 'datum')
  assert.ok(e.liftM > 0)
  assert.equal(e.altEffM, 10668)
  assert.ok(Math.abs(len3(applyE(e.E, e.anchorBody)) - (1 + 10.668 / 6371)) <= 1e-12)
  // 起降点：有效高度 = liftM；真实尺度（k = 1/6371000）下机腹最低点（盒底，datum 的 x / y）落在 r = 1
  L.setEntities([item({ key: 'ac', kind: 'aircraft', modelId: 'ent:a320neo', lat: 50.03, lon: 8.57, altM: 0, headingDeg: 250 })])
  L.overlay.update(0.1, cam(3, 50.03, 8.57), 1600, 900)
  e = L._debug.entity('ac')
  assert.equal(e.altEffM, e.liftM)
  const box = L._debug.internals('ent:a320neo').box
  const q = new THREE.Quaternion(...e.qB2S), A = e.anchor, p = e.anchorBody, kT = 1 / 6371000
  const belly = new THREE.Vector3(0, 0, box.max[2] - p[2]).applyQuaternion(q).multiplyScalar(kT).add(new THREE.Vector3(A[0], A[1], A[2]))
  assert.ok(Math.abs(belly.length() - 1) <= 1e-9, `机腹 r = ${belly.length()}`)
})

// ─────────────────────────────── ④ 屏幕恒定 ───────────────────────────────
await t('④ 屏幕恒定：相机距离 2 / 4 / 8 时包围球投影直径 = px（±1 %）；逐实体 px 覆盖', async () => {
  const lat = 22.3, lon = 114.2
  for (const px of [28, 96]) {
    L.setEntities([item({ key: 'px', kind: 'station', modelId: 'ent:es-13p1', lat, lon, px })])
    await settle()
    for (const D of [2, 4, 8]) {
      const cm = cam(D, lat, lon)
      L.overlay.update(0.5, cm, 1600, 900)
      const e = L._debug.entity('px')
      const I = L._debug.internals('ent:es-13p1')
      const C = new THREE.Vector3(...applyE(e.E, I.center))
      const right = new THREE.Vector3().setFromMatrixColumn(cm.matrixWorld, 0).normalize()
      const r = e.k * I.radius
      const a = C.clone().addScaledVector(right, r).project(cm), b = C.clone().addScaledVector(right, -r).project(cm)
      const dpx = Math.abs(a.x - b.x) * 0.5 * 1600
      assert.ok(Math.abs(dpx / px - 1) < 0.01, `D=${D} 直径 ${dpx.toFixed(2)} px ≠ ${px}`)
      assert.equal(e.screen[2], px / 2)
    }
  }
})

// ─────────────────────────────── ⑤ 姿态 ───────────────────────────────
await t('⑤ 姿态：航向 90° 时机头（本体 +X，= glTF +Z）投到当地正东 ≥ 0.999999', async () => {
  const lat = 40.64, lon = -73.78
  L.setEntities([item({ key: 'hd', kind: 'aircraft', modelId: 'ent:a320neo', lat, lon, altM: 10668, headingDeg: 90 })])
  await settle()
  L.overlay.update(0.5, cam(3, lat, lon), 1600, 900)
  const e = L._debug.entity('hd')
  const E3 = new THREE.Matrix3().setFromMatrix4(m4(e.E))
  const nose = new THREE.Vector3(1, 0, 0).applyMatrix3(E3).normalize()
  const MB = L._debug.internals('ent:a320neo').MB
  const gz = new THREE.Vector3(0, 0, 1).applyMatrix3(new THREE.Matrix3().setFromMatrix4(MB)).normalize()
  assert.ok(gz.x > 0.999999, 'glTF +Z 应映射到本体 +X（机头）')
  const l = lon * D2R, east = new THREE.Vector3(-Math.sin(l), 0, -Math.cos(l))   // ECEF 东 (−sinλ, cosλ, 0) → 场景 (x, z, −y)
  assert.ok(nose.dot(east) >= 0.999999, `机头·东 = ${nose.dot(east)}`)
})
await t('⑤ 无关节模型（车载 COTM）：整体转方位 = 罗盘方位；一跳 > 2° 一阶逼近（busy）、≤ 2° 直接贴合；停放保持', async () => {
  const lat = 35, lon = 110
  const put = (az, park = false) => L.setEntities([item({ key: 'yaw', kind: 'station', modelId: 'ent:suv-cotm', lat, lon, aim: { dir: [0, 1, 0], azDeg: az, elDeg: 30, park } })])
  put(40)
  await settle()
  const cm = cam(3, lat, lon)
  L.overlay.update(0.05, cm, 1600, 900)
  let e = L._debug.entity('yaw')
  assert.equal(e.aimMode, 'yaw')
  assert.equal(e.yawDeg, 40)
  put(41.5); L.overlay.update(0.016, cm, 1600, 900)
  assert.equal(L._debug.entity('yaw').yawDeg, 41.5, '≤ 2° 直接贴合')
  put(100); L.overlay.update(0.05, cm, 1600, 900)
  e = L._debug.entity('yaw')
  assert.ok(e.yawDeg > 41.5 && e.yawDeg < 100, '一跳 58.5°：过渡中')
  assert.equal(L.overlay.busy(), true)
  for (let k = 0; k < 40; k++) L.overlay.update(0.05, cm, 1600, 900)
  e = L._debug.entity('yaw')
  assert.equal(e.yawDeg, 100)
  const E3 = new THREE.Matrix3().setFromMatrix4(m4(e.E))
  const fwd = new THREE.Vector3(1, 0, 0).applyMatrix3(E3).normalize()
  const h = EP.headingDirEcef(lat, lon, 100)
  assert.ok(fwd.dot(new THREE.Vector3(h[0], h[2], -h[1])) > 0.999999)
  put(200, true); L.overlay.update(0.05, cm, 1600, 900)
  assert.equal(L._debug.entity('yaw').yawDeg, 100, '停放保持上一次方位')
})

// ─────────────────────────────── ⑥ 精灵权重 ───────────────────────────────
await t('⑥ spriteWeight = 1 − alpha；setEnabled(false) 即刻恒 1、再开即满；换模型先淡出；移除后淡出回收', async () => {
  const L2 = createEntityLayer({ source: makeSource(), simplify: false, waitGpu: false })
  L2.setEnabled(true)
  const cm = cam(3, 10, 10)
  L2.setEntities([item({ key: 'w', kind: 'station', modelId: 'ent:vsat-1p2', lat: 10, lon: 10 })])
  assert.equal(L2.spriteWeight('w'), 1)
  assert.equal(L2.spriteWeight('nope'), 1)
  await settle()
  L2.overlay.update(0, cm, 1600, 900)
  L2.overlay.update(0.15, cm, 1600, 900)
  assert.ok(Math.abs(L2.spriteWeight('w') - 0.5) < 1e-12, `半程权重 ${L2.spriteWeight('w')}`)
  assert.equal(L2.overlay.busy(), true)
  L2.overlay.update(0.2, cm, 1600, 900)
  assert.equal(L2.spriteWeight('w'), 0)
  assert.equal(L2.overlay.isEmpty(), false)
  L2.setEnabled(false)
  assert.equal(L2.spriteWeight('w'), 1)
  assert.equal(L2.overlay.isEmpty(), true)
  L2.setEnabled(true)
  assert.equal(L2.spriteWeight('w'), 0, '再开：已就绪的直接满 alpha')
  // 换模型：旧的先淡出（精灵回来一半），新的就绪后淡入
  L2.setEntities([item({ key: 'w', kind: 'station', modelId: 'ent:es-13p1', lat: 10, lon: 10 })])
  L2.overlay.update(0.15, cm, 1600, 900)
  assert.ok(Math.abs(L2.spriteWeight('w') - 0.5) < 1e-12)
  L2.overlay.update(0.2, cm, 1600, 900)
  assert.equal(L2._debug.entity('w').modelId, 'ent:es-13p1')
  await settle()
  for (let k = 0; k < 5; k++) L2.overlay.update(0.1, cm, 1600, 900)
  assert.equal(L2.spriteWeight('w'), 0)
  assert.equal(L2._debug.entity('w').lod, 'full')
  // 移除：淡出后回收
  L2.setEntities([])
  L2.overlay.update(0.1, cm, 1600, 900)
  assert.ok(L2.spriteWeight('w') > 0 && L2.spriteWeight('w') < 1)
  for (let k = 0; k < 5; k++) L2.overlay.update(0.1, cm, 1600, 900)
  assert.equal(L2._debug.entity('w'), null)
  assert.equal(L2.stats().entities, 0)
  L2.dispose()
})

// ─────────────────────────────── ⑦ 水线裁剪 ───────────────────────────────
await t('⑦ 船 aClip：平面过锚点、法向 = 当地天顶；其余类别不裁', async () => {
  L.setEntities([
    item({ key: 'sh', kind: 'ship', modelId: 'ent:ulcs-24k', lat: 35.2, lon: 139.8, headingDeg: 200 }),
    item({ key: 'ac2', kind: 'aircraft', modelId: 'ent:a320neo', lat: 35.2, lon: 139.8, altM: 3000 })
  ])
  await settle()
  L.overlay.update(0.5, cam(3, 35.2, 139.8), 1600, 900)
  const e = L._debug.entity('sh')
  const A = e.anchor, n3 = e.clip
  const up = A.map((v) => v / len3(A))
  assert.ok(Math.max(...up.map((v, i) => Math.abs(v - n3[i]))) <= 1e-15, '法向 = 天顶')
  assert.ok(Math.abs(n3[0] * A[0] + n3[1] * A[1] + n3[2] * A[2] - n3[3]) <= 1e-15, '过锚点')
  assert.deepEqual(L._debug.entity('ac2').clip, [0, 0, 0, -1e9])
})

// ─────────────────────────────── ⑨ 命中 / 截断 / 光照口径 ───────────────────────────────
await t('⑨ 命中：图标屏幕中心命中键、离开半径不中；背面淡到 0 的不参与；截断：每类 1024、超出的权重恒 1', async () => {
  const L3 = createEntityLayer({ source: makeSource(), simplify: false, waitGpu: false })
  L3.setEnabled(true)
  const lat = -20, lon = 150
  const cm = cam(2.5, lat, lon)
  L3.setEntities([item({ key: 'st:hit', kind: 'station', modelId: 'ent:vsat-1p2', lat, lon, px: 40 }),
    item({ key: 'st:back', kind: 'station', modelId: 'ent:vsat-1p2', lat: -lat, lon: lon - 180, px: 40 })])
  await settle()
  L3.overlay.update(1, cm, 1600, 900)
  const s = L3.overlay.screenOf('st:hit')
  assert.ok(s && Number.isFinite(s[0]) && s[2] === 20)
  assert.equal(L3.hitTest(s[0] + 3, s[1] - 3), 'st:hit')
  assert.equal(L3.hitTest(s[0] + 40, s[1]), null)
  assert.equal(L3.overlay.screenOf('st:back'), null)
  assert.equal(L3._debug.entity('st:back').drawn, false)
  // 截断
  const many = []
  for (let i = 0; i < 1030; i++) many.push(item({ key: 'pt:' + i, kind: 'point', modelId: 'ent:vsat-1p2', lat: -60 + (i % 120), lon: (i * 7) % 360 - 180 }))
  L3.setEntities(many)
  L3.overlay.update(0.5, cm, 1600, 900)
  assert.equal(L3.stats().truncated, 6)
  assert.equal(L3.spriteWeight('pt:1029'), 1)
  assert.equal(L3.spriteWeight('pt:0'), 0)
  L3.dispose()
})
await t('⑨ 光照：晨昏效果关 → shade 恒 1；开 → shadeOf(Â, sunS, true) 量化 1/50、夜侧 ≥ 0.5', async () => {
  const L4 = createEntityLayer({ source: makeSource(), simplify: false, waitGpu: false })
  L4.setEnabled(true)
  const sun = [0, 0, 1]
  L4.setSun(sun)
  L4.setSunLit(false)
  const pts = [[0, 0], [0, 90], [0, -90], [20, 180], [45, 60]]
  L4.setEntities(pts.map(([la, lo], i) => item({ key: 'l' + i, kind: 'station', modelId: 'ent:vsat-1p2', lat: la, lon: lo })))
  await settle()
  L4.overlay.update(0.5, cam(3, 0, 0), 1600, 900)
  for (let i = 0; i < pts.length; i++) assert.equal(L4._debug.entity('l' + i).shade, 1)
  L4.setSunLit(true)
  L4.overlay.update(0.1, cam(3, 0, 0), 1600, 900)
  for (let i = 0; i < pts.length; i++) {
    const e = L4._debug.entity('l' + i)
    const exp = Math.round(ER.shadeOf(e.anchor, sun, true) * 50) / 50
    assert.equal(e.shade, exp)
    assert.ok(e.shade >= 0.5)
  }
  L4.dispose()
})

// ─────────────────────────────── ⑧ 零分配 ───────────────────────────────
// 采样堆分析（量法同 modelEntityPose ⑥）：300 个实体（三种模型、含关节驱动），两种稳态各 N 帧。
async function allocPerCall(ss, fn, N) {
  fn(); fn()
  await ss.post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
  fn()
  const { profile } = await ss.post('HeapProfiler.stopSampling')
  let bytes = 0
  const sites = new Map()
  const walk = (nd) => {
    if (!/^node:/.test(nd.callFrame.url || '') && nd.selfSize) {
      bytes += nd.selfSize
      const k = (nd.callFrame.url || '').split('/').pop() + ' ' + nd.callFrame.functionName + ':' + (nd.callFrame.lineNumber + 1)
      sites.set(k, (sites.get(k) || 0) + nd.selfSize)
    }
    for (const c of nd.children || []) walk(c)
  }
  walk(profile.head)
  if (process.env.ALLOC_SITES) console.log('    ', [...sites].sort((p, q) => q[1] - p[1]).slice(0, 6).map(([k, v]) => k + ' ' + (v / N).toFixed(1)).join('; '))
  return bytes / N
}
await t('⑧ update 稳态零分配：相机与状态不变 / 相机每帧微动（300 个实体，采样堆分析，每帧 ≤ 96 B（≈ 6 个装箱），报数）', async () => {
  const L5 = createEntityLayer({ source: makeSource(), simplify: false, waitGpu: false })
  L5.setEnabled(true)
  const ids = ['ent:es-13p1', 'ent:vsat-1p2', 'ent:a320neo']
  const list = []
  for (let i = 0; i < 300; i++) {
    const lat = -50 + (i * 37) % 100, lon = -30 + (i * 53) % 90
    const id = ids[i % 3]
    const st = { lat, lon }
    const look = EP.stationAimScene(st, GEO(lon + 20), EP.makeStationLook())
    list.push(item({ key: 'z' + i, kind: id === 'ent:a320neo' ? 'aircraft' : 'station', modelId: id, lat, lon, altM: id === 'ent:a320neo' ? 10668 : 0, headingDeg: (i * 13) % 360,
      aim: id === 'ent:a320neo' ? null : { dir: look.dir.slice(), azDeg: look.azDeg, elDeg: look.elDeg, park: look.elDeg < 0 } }))
  }
  L5.setEntities(list)
  await settle()
  const cm = cam(3, 0, 15)
  for (let k = 0; k < 30; k++) L5.overlay.update(0.1, cm, 1600, 900)
  const N = 400
  const ss = new Session(); ss.connect()
  await ss.post('HeapProfiler.enable')
  const still = await allocPerCall(ss, () => { for (let i = 0; i < N; i++) L5.overlay.update(0.016, cm, 1600, 900) }, N)
  // 相机微动：机位 / 朝向预先算好 K 组，逐帧就地拷（量的是层本身，不量 three 的 lookAt）
  const K = 64, PP = [], QQ = []
  for (let k = 0; k < K; k++) { const c = cam(3 + 0.01 * Math.sin(k), 0.3 * Math.cos(k * 0.7), 15 + 0.3 * Math.sin(k * 0.3)); PP.push(c.position.clone()); QQ.push(c.quaternion.clone()) }
  // three 自己改相机朝向时（quaternion.copy → 联动 Euler）有装箱：先量「只挪相机」的底数，层的分配 = 差值
  const base = await allocPerCall(ss, () => { for (let i = 0; i < N; i++) { cm.position.copy(PP[i % K]); cm.quaternion.copy(QQ[i % K]) } }, N)
  const moving = await allocPerCall(ss, () => { for (let i = 0; i < N; i++) { cm.position.copy(PP[i % K]); cm.quaternion.copy(QQ[i % K]); L5.overlay.update(0.016, cm, 1600, 900) } }, N)
  await ss.post('HeapProfiler.disable'); ss.disconnect()
  const s = L5.stats()
  const mv = Math.max(0, moving - base)
  console.log(`  每帧分配（B）：静止 ${still.toFixed(1)}、相机微动 ${mv.toFixed(1)}（挪相机底数 ${base.toFixed(1)} 已扣；实体 ${s.entities}、在画 ${s.shown}、绘制调用 ${s.drawCalls}、实例 ${s.instances}、update EMA ${s.updateMs} ms）`)
  assert.ok(s.shown > 50, '应有相当数量的实体在画')
  assert.ok(still <= 96 && mv <= 96, `分配超限：静止 ${still}、微动 ${mv}`)
  L5.dispose()
})

// ─────────────────────────────── ⑨ dispose ───────────────────────────────
await t('⑨ dispose：inst.release 次数 = acquire 次数；材质 / 包装几何全部 dispose', async () => {
  const s2 = makeSource()
  const L6 = createEntityLayer({ source: s2, simplify: false, waitGpu: false })
  L6.setEnabled(true)
  L6.setEntities(MODELS.map((m, i) => item({ key: 'd' + i, kind: m.kind, modelId: m.id, lat: m.lat, lon: m.lon })))
  await settle()
  L6.overlay.update(0.5, cam(3, 0, 0), 1600, 900)
  let mats = 0, geos = 0, meshes = 0
  const disposed = { mat: 0, geo: 0, mesh: 0 }
  for (const m of MODELS) {
    const I = L6._debug.internals(m.id)
    for (const mt of I.M.mats) { mats++; mt.addEventListener('dispose', () => disposed.mat++) }
    for (const g of I.V.groups) { geos++; meshes++; g.geo.addEventListener('dispose', () => disposed.geo++); g.mesh.addEventListener('dispose', () => disposed.mesh++) }
  }
  L6.dispose()
  assert.equal(s2.released, s2.acquired)
  assert.equal(disposed.mat, mats)
  assert.equal(disposed.geo, geos)
  assert.equal(disposed.mesh, meshes)
  assert.equal(L6.stats().entities, 0)
})

L.dispose()
assert.equal(src.released, src.acquired)
console.log(`modelEntityLayer: ${n} 项通过`)
