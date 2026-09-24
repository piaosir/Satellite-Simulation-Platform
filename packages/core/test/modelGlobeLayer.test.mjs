// 3D 球模型层（src/viz/globe3d/modelLayer.js）里不依赖 GPU / DOM 的几何口径：
//   ① satStateAt：锚点与点云顶点逐位同式（点精灵遮罩按它比对）、本体 +Z 对地心、LVLH 正交
//   ② velInL：近圆轨道速度≈沿迹、径向分量 = ṙ/|v|
//   ③ neighborInL：邻星相对位置（米）与真 ECEF 差一致、换回场景轴逐位相等
//   ④ followCamDir：进入跟随的机位（低轨平视地平线、GEO 把地球摆进画面、太阳在身后偏 50°）
//   ⑤ 太阳翼对日（mountInstance → makeSunTrackers）：参数化默认卫星 / 平板 LEO 的电池片法向在转轴法平面内正对太阳投影
//   ⑥ sunStateAt / NEIGHBOR_KM 口径
//   ⑦ lodByBudget：跟随取档按三角形预算往粗里退
//   ⑧ HUD 的 LVLH 方向符号（轨道法向 = +ĥ = r × v，径向 / 天底 / 沿迹）
//   ⑨ 绑定表逐星模型轴覆盖（frameOverride）、软件光栅判据
// 画面（图标 / 跟随 / 星空 / 大气 / 逐像素一致 / 堆 / 帧时）在真 Electron 验证台 .modelharness/w8/ 里跑，这里不重复。
// 渲染端源码用 @core/… 别名：先注册解析钩子再动态导入（写法同 modelRenderStack.test.mjs）。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const THREE = await import('three')
const ML = await import(SRC + 'globe3d/modelLayer.js')
const { llaToVec } = await import(SRC + 'globe3d/focusLanes.js')
const satMod = await import(SRC + 'constellation/satellite.js')
const sat = satMod.default || satMod
const { irToThree } = await import(SRC + 'models/irToThree.js')
const { buildTemplateModel } = await import(CORE + 'models/paramBus.mjs')
const AT = await import(CORE + 'models/attitude.mjs')
const W = await import(SRC + 'wgs84.js')

let n = 0
const t = (name, fn) => { try { fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const D2R = Math.PI / 180
// 夹角用 atan2(|a×b|, a·b)：acos 在 1 附近只有 ~1.5e-8 的分辨率，量不出 1e-9 级
const ang = (a, b) => {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
}

// 固定种子
let seed = 0x9e3779b9
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

const OMM = [
  { name: 'LEO-A', noradId: '90001', epoch: '2026-09-24T00:00:00', meanMotion: 15.50, ecc: 0.0005, incl: 51.64, raan: 100, argp: 90, ma: 10, bstar: 0.0003, mdot: 0, mddot: 0 },
  { name: 'LEO-B', noradId: '90002', epoch: '2026-09-24T00:00:00', meanMotion: 15.06, ecc: 0.0012, incl: 97.6, raan: 250, argp: 30, ma: 200, bstar: 0.0001, mdot: 0, mddot: 0 },
  { name: 'MEO', noradId: '90003', epoch: '2026-09-24T00:00:00', meanMotion: 2.0056, ecc: 0.004, incl: 55, raan: 20, argp: 10, ma: 300, bstar: 0, mdot: 0, mddot: 0 },
  { name: 'GEO', noradId: '90004', epoch: '2026-09-24T00:00:00', meanMotion: 1.00273, ecc: 0.0002, incl: 0.05, raan: 80, argp: 200, ma: 150, bstar: 0, mdot: 0, mddot: 0 },
  { name: 'HEO', noradId: '90005', epoch: '2026-09-24T00:00:00', meanMotion: 2.006, ecc: 0.72, incl: 63.4, raan: 300, argp: 270, ma: 40, bstar: 0, mdot: 0, mddot: 0 }
]
const recs = OMM.map((o) => sat.omm2satrec(o))
const T0 = Date.UTC(2026, 8, 24, 6, 0, 0)
const samples = []
for (let i = 0; i < recs.length; i++) for (let k = 0; k < 40; k++) {
  const d = new Date(T0 + k * 1117e3 + i * 377e3)
  const pv = sat.propagate(recs[i], d)
  samples.push({ i, d, g: sat.gstime(d), pv })
}

// ---------------- ① satStateAt ----------------
t('① 锚点 = setSatellites 同式（llaToVec 大地纬经高 → Float32）逐位相等', () => {
  let cnt = 0
  for (const s of samples) {
    const sn = ML.sunStateAt(s.d)
    const st = ML.satStateAt(s.pv, s.g, sn.sunE)
    const gd = sat.eciToGeodetic(s.pv.position, s.g)
    const v = llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height)
    const f32 = new Float32Array([v.x, v.y, v.z]), a32 = new Float32Array(st.anchor)
    assert.deepEqual([...a32], [...f32])
    cnt++
  }
  assert.equal(cnt, samples.length)
})
t('① 本体 +Z（nadir 律）指地心，偏差 < 1e-9 rad；qL2S 单位', () => {
  let worst = 0
  for (const s of samples) {
    const st = ML.satStateAt(s.pv, s.g, [1, 0, 0])
    assert.ok(Math.abs(Math.hypot(...st.qL2S) - 1) < 1e-12)
    const qB2S = AT.quatMul(st.qL2S, AT.Q_BODY2L_NADIR)
    const z = AT.quatRotate(qB2S, [0, 0, 1])
    const down = AT.sceneFromEcef(st.rE).map((x) => -x)
    worst = Math.max(worst, ang(z, down))
  }
  assert.ok(worst < 1e-9, 'worst ' + worst)
})
t('① 地影因子 ∈ [0,1]，与 attitude.eclipseFactor 同值', () => {
  for (const s of samples.slice(0, 60)) {
    const sn = ML.sunStateAt(s.d)
    const st = ML.satStateAt(s.pv, s.g, sn.sunE)
    assert.ok(st.ecl >= 0 && st.ecl <= 1)
    assert.equal(st.ecl, AT.eclipseFactor(st.rE, sn.sunE))
  }
})
t('① 无效输入回 null（不抛）', () => {
  assert.equal(ML.satStateAt(null, 0, [1, 0, 0]), null)
  assert.equal(ML.satStateAt({ position: { x: 1, y: 2, z: 3 } }, 0, [1, 0, 0]), null)
})

// ---------------- ② velInL ----------------
t('② 近圆 LEO：速度方向 ≈ 沿迹 +x̂（>0.9999），径向分量 = ṙ/|v|', () => {
  for (const s of samples.filter((x) => x.i === 0)) {
    const st = ML.satStateAt(s.pv, s.g, [1, 0, 0])
    const v = ML.velInL(st)
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12)
    assert.ok(v[0] > 0.9999, 'x ' + v[0])
    // ṙ：惯性速度在径向上的分量（ECEF 轴向下同样成立，旋转不改点积）
    const r = st.rE, vv = st.vE
    const rdot = (r[0] * vv[0] + r[1] * vv[1] + r[2] * vv[2]) / Math.hypot(...r) / Math.hypot(...vv)
    assert.ok(Math.abs(v[1] - rdot) < 1e-12)
  }
})
t('② HEO：径向分量明显（近地点后 ṙ>0 时 y>0）且单位长', () => {
  let seenPos = false
  for (const s of samples.filter((x) => x.i === 4)) {
    const st = ML.satStateAt(s.pv, s.g, [1, 0, 0])
    const v = ML.velInL(st)
    assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-12)
    assert.ok(Math.abs(v[2]) < 1e-9, 'z ' + v[2])   // 速度在轨道面内：ẑ = x̂ × ŷ ⟂ 轨道面（= −ĥ，见 ⑧）
    if (v[1] > 0.3) seenPos = true
  }
  assert.ok(seenPos)
})

// ---------------- ③ neighborInL ----------------
t('③ 邻星相对位置：|relL| = |Δr|·1000，换回场景轴 = sceneFromEcef(Δr)·1000', () => {
  let worst = 0
  for (let k = 0; k < 40; k++) {
    const a = samples[k], b = samples[40 + k]
    const sn = ML.sunStateAt(a.d)
    const sa = ML.satStateAt(a.pv, a.g, sn.sunE), sb = ML.satStateAt(b.pv, a.g, sn.sunE)
    const n1 = ML.neighborInL(sa, sb)
    const dr = [sb.rE[0] - sa.rE[0], sb.rE[1] - sa.rE[1], sb.rE[2] - sa.rE[2]]
    assert.ok(Math.abs(Math.hypot(...n1.relL) - Math.hypot(...dr) * 1000) < 1e-6)
    const back = AT.quatRotate(sa.qL2S, n1.relL)
    const want = AT.sceneFromEcef(dr).map((x) => x * 1000)
    for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(back[j] - want[j]))
    assert.deepEqual(n1.anchorS, sb.anchor)
    // qB2L：邻星本体 +Z 在主星 L 系里也指【邻星自己的】地心方向
    const zL = AT.quatRotate(n1.qB2L, [0, 0, 1])
    const zS = AT.quatRotate(sa.qL2S, zL)
    assert.ok(ang(zS, AT.sceneFromEcef(sb.rE).map((x) => -x)) < 1e-9)
  }
  assert.ok(worst < 1e-5, 'worst ' + worst)
})

// ---------------- ④ followCamDir ----------------
const RE = 6371
const delta = (h) => Math.acos(RE / (RE + h))
t('④ 低轨（420 km）俯仰 = 地平俯角 + 4°（地平线略高于画面中线）', () => {
  const v = ML.followCamDir(420, { x: 0.6, y: 0.5, z: 0.62 }, new THREE.Vector3())
  const pitch = Math.asin(v.y)
  assert.ok(Math.abs(pitch - (delta(420) + 4 * D2R)) < 0.01 * D2R, (pitch / D2R) + ' vs ' + (delta(420) / D2R + 4))
  assert.ok(Math.abs(v.length() - 1) < 1e-12)
})
t('④ GEO：俯仰 = δ − 9.5°（地球盘心落在画面中心下方 ~18°）', () => {
  const h = 35786
  const v = ML.followCamDir(h, { x: 0.3, y: 0.2, z: -0.93 }, new THREE.Vector3())
  const pitch = Math.asin(v.y)
  assert.ok(Math.abs(pitch - (delta(h) - 9.5 * D2R)) < 0.01 * D2R)
  const earthOff = 90 - pitch / D2R        // 视线俯角 = 相机仰角；地心在正下方
  assert.ok(earthOff > 16 && earthOff < 20, 'earthOff ' + earthOff)
})
t('④ 方位：太阳在身后偏 50°、取偏向 −x̂（飞行反方向）那一侧；太阳近天顶时取缺省后方', () => {
  for (let k = 0; k < 200; k++) {
    const a = rnd() * 2 * Math.PI, el = (rnd() - 0.5) * 1.2
    const sun = { x: Math.cos(el) * Math.cos(a), y: Math.sin(el), z: Math.cos(el) * Math.sin(a) }
    const v = ML.followCamDir(800, sun, new THREE.Vector3())
    const h = [v.x, 0, v.z], s = [sun.x, 0, sun.z]
    assert.ok(Math.abs(ang(h, s) - 50 * D2R) < 1e-9)
    // 两个候选方位（太阳方位 ±50°）里取 x 更负的那个
    const sa = Math.atan2(sun.z, sun.x)
    const cosAz = v.x / Math.cos(Math.asin(v.y))
    assert.ok(Math.abs(cosAz - Math.min(Math.cos(sa + 50 * D2R), Math.cos(sa - 50 * D2R))) < 1e-9)
  }
  const top = ML.followCamDir(800, { x: 0.05, y: 0.99, z: 0.1 }, new THREE.Vector3())
  assert.ok(top.x < 0 && top.z > 0)
})
t('④ 太阳远在水平面下、星在日照里（夜侧）：相机往下压，但俯仰不低于 δ − 15°（地球临边留在 42° 视场里）；地影里照旧俯拍', () => {
  const at = (el, az) => ({ x: Math.cos(el * D2R) * Math.cos(az * D2R), y: Math.sin(el * D2R), z: Math.cos(el * D2R) * Math.sin(az * D2R) })
  const p = (v) => Math.asin(v.y) / D2R
  const HALF_FOV = 21
  for (const h of [35786, 20200, 1200, 550, 420]) {
    const dDeg = delta(h) / D2R, earthR = 90 - dDeg        // 主星看地球的角半径
    for (const el of [-16, -30, -53, -85]) {
      const pitch = p(ML.followCamDir(h, at(el, 30), new THREE.Vector3(), true))
      const low = Math.max(-45, Math.min(-10, 0.55 * el))
      assert.ok(Math.abs(pitch - Math.max(dDeg - 15, low)) < 1e-9, `h=${h} el=${el} pitch=${pitch}`)
      // 地心在视线下方 90° − 俯仰；临边 = 它减地球角半径：必须落进半视场（留 5° 以上）
      assert.ok((90 - pitch) - earthR < HALF_FOV - 5, `h=${h} el=${el} 临边出画`)
    }
  }
  assert.ok(Math.abs(p(ML.followCamDir(35786, at(-53, 30), new THREE.Vector3(), true)) - (delta(35786) / D2R - 15)) < 1e-9)   // GEO ≈ 66.3°
  assert.ok(p(ML.followCamDir(35786, at(-10, 30), new THREE.Vector3(), true)) > 70)                     // 太阳没那么低：照常俯拍（δ − 9.5°）
  assert.ok(p(ML.followCamDir(35786, at(-53, 30), new THREE.Vector3(), false)) > 70)                    // 地影：照常俯拍
  // 方位仍是太阳 ±50°（受光的 3/4 面）
  const v = ML.followCamDir(35786, at(-53, 30), new THREE.Vector3(), true)
  assert.ok(Math.abs(ang([v.x, 0, v.z], [Math.cos(30 * D2R), 0, Math.sin(30 * D2R)]) - 50 * D2R) < 1e-9)
})

// ---------------- ⑧ HUD 的 LVLH 方向符号 ----------------
t('⑧ HUD「轨道法向」虚线 = +ĥ（r × v 方向）：顺行 GEO 指北；「径向」= +r̂、「天底」= −r̂、「沿迹」与速度同向（5 类轨道 × 40 时刻）', () => {
  const D = ML.HUD_L_DIRS
  assert.ok(Object.isFrozen(D))
  let worst = 0
  for (const s of samples) {
    const st = ML.satStateAt(s.pv, s.g, [1, 0, 0])
    const r = st.rE, v = st.vE
    const h = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]
    const hS = AT.sceneFromEcef(h), rS = AT.sceneFromEcef(r), vS = AT.sceneFromEcef(v)
    const toS = (d) => AT.quatRotate(st.qL2S, [...d])
    worst = Math.max(worst, ang(toS(D.lh), hS), ang(toS(D.ly), rS), ang(toS(D.nadir), rS.map((x) => -x)))
    const lx = toS(D.lx)
    assert.ok(lx[0] * vS[0] + lx[1] * vS[1] + lx[2] * vS[2] > 0)
    // 本体 +Y（nadir 律）与「轨道法向」虚线反向 —— STK VVLH 的「负轨道法向」
    const yB = AT.quatRotate(AT.quatMul(st.qL2S, AT.Q_BODY2L_NADIR), [0, 1, 0])
    assert.ok(ang(yB, hS) > Math.PI - 1e-9)
  }
  assert.ok(worst < 1e-9, 'worst ' + worst)
  // 顺行 GEO（i ≈ 0.05°）：+ĥ 指北（场景 +Y 是地轴北）
  const g = samples.find((x) => x.i === 3)
  const st = ML.satStateAt(g.pv, g.g, [1, 0, 0])
  assert.ok(AT.quatRotate(st.qL2S, [...ML.HUD_L_DIRS.lh])[1] > 0.999)
})

t('⑧ stationDirsInL：星下点的站 = 天底方向、仰角 ≈ 90°；背面的站不出；近者优先、按上限截断；方向单位长', () => {
  const g = samples.find((x) => x.i === 3)
  const st = ML.satStateAt(g.pv, g.g, [1, 0, 0])
  const sub = W.ecefToGeodetic(...st.rE)
  const sts = [
    { name: '背面', lat: -sub.lat, lon: sub.lon + 180 },
    { name: '北 30°', lat: sub.lat + 30, lon: sub.lon },
    { name: '星下点', lat: sub.lat, lon: sub.lon },
    { name: '东 40°', lat: sub.lat, lon: sub.lon + 40 },
    { name: '坏', lat: NaN, lon: 1 }
  ]
  const r = ML.stationDirsInL(st, sts, 12, 0)
  assert.deepEqual(r.map((x) => x.name), ['星下点', '北 30°', '东 40°'])
  assert.ok(ang(r[0].dirL, [0, -1, 0]) < 1e-3, 'nadir ' + ang(r[0].dirL, [0, -1, 0]))
  assert.ok(r[0].elDeg > 89.9)
  for (const x of r) assert.ok(Math.abs(Math.hypot(...x.dirL) - 1) < 1e-12)
  // 北 30° 的站：方向在主星 L 系里偏向地球北侧（场景 +Y = 北极），即 dirL 换回场景轴后 y 分量为正、且低于水平面
  const n30 = AT.quatRotate(st.qL2S, r[1].dirL)
  assert.ok(n30[1] > 0 && r[1].dirL[1] < 0)
  assert.equal(ML.stationDirsInL(st, sts, 2, 0).length, 2)
  assert.equal(ML.stationDirsInL(st, sts, 12, 60).length, 1)          // 仰角门限 60°：只剩星下点
  assert.deepEqual(ML.stationDirsInL(null, sts), [])
  assert.deepEqual(ML.stationDirsInL(st, null), [])
})

// ---------------- ⑨ 逐星模型轴覆盖 / 软件光栅判据 ----------------
t('⑨ 绑定表 frameOverride：本体矩阵换成覆盖的 q / t，缩放仍取元数据；不合法的覆盖原样忽略', () => {
  const r = buildTemplateModel('flat-leo')
  const pir = (ir) => { for (const m of ir.materials) delete m.key; return ir }   // 同 ⑤ 的 plainIR（那个声明在后面，这里还在 TDZ）
  const meta = { frame: { q_model2body: [0, 0, 0, 1], t_model2body: [0, 0, 0] }, units: { scaleToMeters: 2 } }
  const q90 = [0, 0, Math.SQRT1_2, Math.SQRT1_2]   // 绕 Z 转 90°
  const m0 = ML.__test.mountInstance({ root: irToThree(pir(r.ir)), meta })
  const m1 = ML.__test.mountInstance({ root: irToThree(pir(r.ir)), meta }, { q: q90, t: [1, 2, 3] })
  const m2 = ML.__test.mountInstance({ root: irToThree(pir(r.ir)), meta }, { q: [1, 2] })
  const p = new THREE.Vector3(1, 0, 0)
  assert.deepEqual(p.clone().applyMatrix4(m0.body.matrix).toArray().map((x) => +x.toFixed(9)), [2, 0, 0])
  assert.deepEqual(p.clone().applyMatrix4(m1.body.matrix).toArray().map((x) => +x.toFixed(9)), [1, 4, 3])
  assert.deepEqual(m2.body.matrix.toArray(), m0.body.matrix.toArray())
})
t('⑨ isSoftwareRenderer：SwiftShader / llvmpipe / 微软基本显示驱动算软件光栅，真 GPU 不算', () => {
  for (const s of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)']) assert.equal(ML.isSoftwareRenderer(s), true, s)
  for (const s of ['ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Ti (0x00002782) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (AMD, AMD Radeon(TM) Graphics (0x00001638) Direct3D11 vs_5_0 ps_5_0, D3D11)', '', null]) assert.equal(ML.isSoftwareRenderer(s), false, String(s))
})

// ---------------- ⑤ 太阳翼对日 ----------------
// 材质库的程序纹理要画布（node 里没有）：去掉材质键走普通材质 —— 只验几何，材质不参与
const plainIR = (ir) => { for (const m of ir.materials) delete m.key; return ir }
function mountParam(tid) {
  const r = buildTemplateModel(tid)
  const root = irToThree(plainIR(r.ir))
  const inst = { root, meta: { frame: r.frame, units: { scaleToMeters: 1 }, geometry: { boundingRadiusM: r.boundingRadiusM }, articulations: r.articulations, solarPanelGroups: r.solarPanelGroups } }
  return { r, inst, mount: ML.__test.mountInstance(inst) }
}
function cellNormalsBody(mount, r) {
  // 电池片网格在本体系（holder = 恒等）里的面法向
  const names = new Set(r.solarPanelGroups.flatMap((g) => g.nodes))
  mount.holder.updateMatrixWorld(true)
  const out = []
  mount.holder.traverse((o) => {
    const nm = (o.userData && o.userData.name) || o.name
    if (!o.isMesh || !names.has(nm)) return
    const n0 = ML.__test.faceNormal(o.geometry)
    const nm3 = new THREE.Matrix3().getNormalMatrix(o.matrixWorld)
    out.push({ name: nm, n: n0.applyMatrix3(nm3).normalize() })
  })
  return out
}
for (const tid of ['default-sat', 'flat-leo']) {
  t(`⑤ ${tid}：电池片法向在转轴法平面内正对太阳投影（200 个随机太阳方向，偏差 < 1e-6）`, () => {
    const { r, mount } = mountParam(tid)
    assert.ok(mount.sun, '没建出对日驱动')
    let worst = 0, cnt = 0
    for (let k = 0; k < 200; k++) {
      const u = rnd() * 2 - 1, p = rnd() * 2 * Math.PI, q = Math.sqrt(1 - u * u)
      const s = new THREE.Vector3(q * Math.cos(p), q * Math.sin(p), u)
      if (Math.abs(s.y) > 0.98) continue                  // 太阳几乎沿翼轴：法平面投影退化，驱动按兵不动
      mount.sun.update(s)
      for (const c of cellNormalsBody(mount, r)) {
        // 两翼都沿本体 ±Y（参数化平台的翼轴），最好情况 n·s = √(1 − s_y²)
        const best = Math.sqrt(1 - s.y * s.y)
        worst = Math.max(worst, Math.abs(c.n.dot(s) - best))
        cnt++
      }
    }
    assert.ok(cnt > 100)
    assert.ok(worst < 1e-6, 'worst ' + worst)
  })
}
t('⑤ 没有关节 / 没有太阳翼组的模型不建驱动（NASA 美术件照原样挂）', () => {
  const r = buildTemplateModel('default-sat')
  const root = irToThree(plainIR(r.ir))
  const m1 = ML.__test.mountInstance({ root, meta: { frame: r.frame, units: { scaleToMeters: 1 } } })
  assert.equal(m1.sun, null)
  const m2 = ML.__test.mountInstance({ root: irToThree(r.ir), meta: { frame: r.frame, units: { scaleToMeters: 1 }, articulations: r.articulations, solarPanelGroups: [] } })
  assert.equal(m2.sun, null)
})
t('⑤ 包围半径（本体原点 → 最远角点）与参数化生成器给的同量级（±15%）', () => {
  const { r, mount } = mountParam('default-sat')
  assert.ok(Math.abs(mount.radius - r.boundingRadiusM) / r.boundingRadiusM < 0.15, mount.radius + ' vs ' + r.boundingRadiusM)
})

// ---------------- ⑦ 跟随取档：三角形预算 ----------------
t('⑦ lodByBudget：从目标档往粗里找第一档 ≤ 预算；都超了取最粗；没有面数 / 没有 files 照目标档', () => {
  const iss = { files: { lod0: { tris: 2975912 }, lod1: { tris: 1401063 }, lod2: { tris: 286510 } } }
  assert.equal(ML.lodByBudget(iss, 'lod1', 8e5), 'lod2')      // 「高」档：ISS IGOAL 的 lod1 140 万面超预算 → lod2
  assert.equal(ML.lodByBudget(iss, 'lod0', 3.5e6), 'lod0')    // 「极致」
  assert.equal(ML.lodByBudget(iss, 'lod0', 2e6), 'lod1')
  assert.equal(ML.lodByBudget(iss, 'lod1', 1e5), 'lod2')      // 都超：取最粗
  const maven = { files: { lod0: { tris: 1746023 }, lod1: { tris: 519714 }, lod2: { tris: 172525 } } }
  assert.equal(ML.lodByBudget(maven, 'lod1', 8e5), 'lod1')
  assert.equal(ML.lodByBudget({ files: { lod2: { tris: 10 } } }, 'lod0', 1e5), 'lod2')   // 只有随包 lod2
  assert.equal(ML.lodByBudget({ files: { lod1: {}, lod2: { tris: 10 } } }, 'lod1', 5), 'lod1')   // 没面数的档不挡路
  assert.equal(ML.lodByBudget(null, 'lod1', 8e5), 'lod1')
  assert.equal(ML.lodByBudget(iss, 'lod1', 0), 'lod1')
})

// ---------------- ⑥ 其他口径 ----------------
t('⑥ sunStateAt：单位矢量，场景轴 = (X, Z, −Y)', () => {
  for (let k = 0; k < 24; k++) {
    const s = ML.sunStateAt(new Date(T0 + k * 3600e3))
    assert.ok(Math.abs(Math.hypot(...s.sunE) - 1) < 1e-12)
    assert.deepEqual(s.sunS, [s.sunE[0], s.sunE[2], -s.sunE[1]])
  }
})
t('⑥ NEIGHBOR_KM：外沿 500 km、内沿 1 km（对接件不算邻星），冻结', () => {
  assert.equal(ML.NEIGHBOR_KM.max, 500)
  assert.equal(ML.NEIGHBOR_KM.min, 1)
  assert.ok(Object.isFrozen(ML.NEIGHBOR_KM))
})

console.log(`modelGlobeLayer: ${n} 项通过`)
