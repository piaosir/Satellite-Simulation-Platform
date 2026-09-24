// 非卫星实体姿态（packages/core/models/entityPose.mjs，DESIGN3 E9）的回归网。
//
//   ① 当地基底：ENU 正交右手、U = wgs84.geodeticUp = 场景 llaToVec 径向；sceneAnchor 与 focusLanes.llaToVec 逐位相同；
//      geodeticToEcefKm 与 wgs84.geodeticToEcef 逐位相同、ecefToGeodetic 与 wgs84.ecefToGeodetic 一致
//   ② FRD / NED 本体基底：正交归一右手；qB2S（qL2S ⊗ Q_BODY2L_NADIR ⊗ 俯仰 ⊗ 滚转）与定义式基底对拍；平飞 qB2L 逐位 = 常量；
//      qL2S = attitude.lvlhQuatScene(upEcef, fwdEcef)（零分配复写，≤ 1e-15）；地球站 = NED；俯仰抬头 / 滚转右翼下沉的符号
//   ③ 模型轴：Q_YUP_ZENITH 下 glTF +Z = 机头方向、+Y = 天顶（机身上方）、+X = 左侧
//   ④ 与 trajKinematics 衔接：vehiclePoseAt(state) 的机头水平投影 = 航迹切向（含航点恰在极点、lon ≠ 0）
//   ⑤ 地球站对星：WGS-84 读数对「按 az / el 放在 WGS-84 里的星」与 satellite.js ecfToLookAngles 对拍；
//      场景锚点口径与读数差 ≤ 0.2°（GEO 圆环 + 按 az/el 放的 GEO 高度 / LEO 300 / 500 / 1200 km，纬度 0/30/45/60、仰角 5–60°）；
//      站锚点可传数组 / THREE.Vector3 / {x,y,z}；挂点系与 gimbal 解一致、天顶 keyhole 沿用上一次方位、整体转方位兜底 = 航向取罗盘方位
//   ⑥ 热路径分配量（采样堆分析）：报数 + 宽判据（只抓显式分配回归）

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { Session } from 'node:inspector/promises'
import {
  enuEcef, headingDirEcef, sceneAnchor, geodeticToEcefKm, ecefToGeodetic, makeEntityPose, entityPoseAt, vehiclePoseAt,
  stationPoseAt, bodyQuatL, bodyBasisEcef, STATION_MOUNT, makeStationLook, stationTrackAzEl, stationAimScene
} from '../models/entityPose.mjs'
import { Q_BODY2L_NADIR, quatRotate, quatMul, mountFrame, lvlhQuatScene } from '../models/attitude.mjs'
import { dirFromAzEl } from '../models/gimbal.mjs'
import { Q_YUP_ZENITH } from '../models/bodyFrame.mjs'
import { trajStateAt, makeTrajState } from '../models/trajKinematics.mjs'
import { llaToVec } from '../../../src/viz/globe3d/focusLanes.js'
import * as W from '../../../src/viz/wgs84.js'

const require = createRequire(import.meta.url)
const satjs = require('../vendor/satellite.js')

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const nearV = (a, b, tol, msg) => { for (let k = 0; k < 3; k++) near(a[k], b[k], tol, `${msg}[${k}]`) }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const add = (a, b, k = 1) => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]]
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const toEcef = (s) => [s[0], -s[2], s[1]]          // 场景轴 → ECEF
const toScene = (e) => [e[0], e[2], -e[1]]         // ECEF → 场景轴
const angDeg = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot(nrm(u), nrm(v))))) * 180 / Math.PI
const azDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180)
const D2R = Math.PI / 180

let seed = 424242
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// ═════════════════════════════ ① 当地基底 ═════════════════════════════
t('ENU：正交右手（E × N = U）、U = wgs84.geodeticUp = 场景径向', () => {
  for (let i = 0; i < 200; i++) {
    const lat = rnd() * 180 - 90, lon = rnd() * 360 - 180
    const { E, N, U } = enuEcef(lat, lon)
    near(len(E), 1, 1e-15, 'E'); near(len(N), 1, 1e-15, 'N'); near(len(U), 1, 1e-15, 'U')
    near(dot(E, N), 0, 1e-15, 'E·N'); near(dot(N, U), 0, 1e-15, 'N·U')
    nearV(cross(E, N), U, 1e-15, 'E×N')
    nearV(U, W.geodeticUp(lon, lat), 1e-15, 'geodeticUp')
    const v = llaToVec(lat, lon, 0)
    nearV(U, toEcef(nrm([v.x, v.y, v.z])), 1e-15, '场景径向')
    nearV(headingDirEcef(lat, lon, 0), N, 1e-15, '航向 0 = N'); nearV(headingDirEcef(lat, lon, 90), E, 1e-15, '航向 90 = E')
  }
})
t('sceneAnchor 与 focusLanes.llaToVec 逐位相同', () => {
  for (let i = 0; i < 500; i++) {
    const lat = rnd() * 180 - 90, lon = rnd() * 720 - 360, h = i % 3 ? rnd() * 40000 : 0
    const a = sceneAnchor(lat, lon, h), v = llaToVec(lat, lon, h)
    assert.ok(Object.is(a[0], v.x) && Object.is(a[1], v.y) && Object.is(a[2], v.z), `${lat},${lon},${h}`)
  }
})
t('geodeticToEcefKm = wgs84.geodeticToEcef（逐位）；ecefToGeodetic = wgs84.ecefToGeodetic（1e-12）', () => {
  for (let i = 0; i < 300; i++) {
    const lat = rnd() * 180 - 90, lon = rnd() * 360 - 180, h = rnd() * 36000
    const a = geodeticToEcefKm(lat, lon, h), b = W.geodeticToEcef(lon, lat, h)
    assert.ok(Object.is(a[0], b[0]) && Object.is(a[1], b[1]) && Object.is(a[2], b[2]), `正算 ${i}`)
    const g = ecefToGeodetic(a[0], a[1], a[2]), r = W.ecefToGeodetic(a[0], a[1], a[2])
    near(g.lat, r.lat, 1e-12, '纬'); near(g.lon, r.lon, 1e-12, '经'); near(g.hKm, r.h, 1e-9, '高')
    near(g.lat, lat, 1e-9, '回环纬'); near(g.hKm, h, 1e-6, '回环高')
  }
})

// ═════════════════════════════ ② 本体基底 ═════════════════════════════
t('FRD 基底正交归一右手；qB2S 与定义式基底对拍（航向 / 俯仰 / 滚转随机）', () => {
  const pose = makeEntityPose(), basis = { X: [0, 0, 0], Y: [0, 0, 0], Z: [0, 0, 0] }
  for (let i = 0; i < 500; i++) {
    const lat = rnd() * 179 - 89.5, lon = rnd() * 360 - 180, hd = rnd() * 360, th = rnd() * 60 - 30, ph = rnd() * 90 - 45
    bodyBasisEcef(lat, lon, hd, th, ph, basis)
    const { X, Y, Z } = basis
    for (const [v, nm] of [[X, 'X'], [Y, 'Y'], [Z, 'Z']]) near(len(v), 1, 1e-14, `|${nm}|`)
    near(dot(X, Y), 0, 1e-14, 'X·Y'); near(dot(Y, Z), 0, 1e-14, 'Y·Z'); near(dot(Z, X), 0, 1e-14, 'Z·X')
    nearV(cross(X, Y), Z, 1e-14, '右手 X×Y=Z')
    entityPoseAt(lat, lon, hd, th, ph, pose)
    near(Math.hypot(...pose.qB2S), 1, 1e-14, '|qB2S|')
    nearV(toEcef(quatRotate(pose.qB2S, [1, 0, 0])), X, 1e-13, `X ${i}`)
    nearV(toEcef(quatRotate(pose.qB2S, [0, 1, 0])), Y, 1e-13, `Y ${i}`)
    nearV(toEcef(quatRotate(pose.qB2S, [0, 0, 1])), Z, 1e-13, `Z ${i}`)
    // qB2S = qL2S ⊗ qB2L
    const q = quatMul(pose.qL2S, pose.qB2L)
    for (let k = 0; k < 4; k++) assert.ok(Object.is(q[k], pose.qB2S[k]), 'qB2S = qL2S ⊗ qB2L')
  }
})
t('平飞：qB2L 逐位 = Q_BODY2L_NADIR（常量）；俯仰 / 滚转各自单独时与半角公式一致', () => {
  const q = bodyQuatL(0, 0)
  for (let k = 0; k < 4; k++) assert.ok(Object.is(q[k], Q_BODY2L_NADIR[k]), `分量 ${k}`)
  const p = entityPoseAt(35, 139, 270, 0, 0)
  for (let k = 0; k < 4; k++) assert.ok(Object.is(p.qB2L[k], Q_BODY2L_NADIR[k]))
  // 只俯仰 θ：Q ⊗ [0, sin θ/2, 0, cos θ/2]
  const th = 7 * D2R
  const ref = quatMul(Q_BODY2L_NADIR, [0, Math.sin(th / 2), 0, Math.cos(th / 2)])
  const got = bodyQuatL(7, 0)
  for (let k = 0; k < 4; k++) near(got[k], ref[k], 1e-16, `俯仰 ${k}`)
})
t('qL2S = attitude.lvlhQuatScene(upEcef, fwdEcef)：零分配复写与原函数 ≤ 1e-15（含极点、四个正方位）', () => {
  const pose = makeEntityPose()
  let worst = 0, flips = 0, cnt = 0
  const run = (lat, lon, hd) => {
    entityPoseAt(lat, lon, hd, 0, 0, pose)
    const ref = lvlhQuatScene(pose.upEcef, pose.fwdEcef)
    const d4 = ref[0] * pose.qL2S[0] + ref[1] * pose.qL2S[1] + ref[2] * pose.qL2S[2] + ref[3] * pose.qL2S[3]
    const sg = d4 < 0 ? -1 : 1                                                // w ≈ 0 时两边规范形可能各取一号（同一转动）
    if (sg < 0) flips++
    for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(pose.qL2S[k] - sg * ref[k]))
    cnt++
  }
  for (let i = 0; i < 2000; i++) run(rnd() * 180 - 90, rnd() * 720 - 360, rnd() * 720 - 360)
  for (const lat of [90, -90, 0, 45, -60]) for (const lon of [0, 100, -170, 180]) for (const hd of [0, 90, 180, 270]) run(lat, lon, hd)
  assert.ok(worst <= 1e-15, `最大分量差 ${worst}`)
  assert.ok(flips <= cnt * 0.01, `规范形取号不一致 ${flips} / ${cnt}`)
})
t('符号：俯仰 +θ 机头抬起（X·U = sinθ）、滚转 +φ 右翼下沉（Y·U = −sinφ）、机头水平分量 = 航向', () => {
  const lat = 31.2, lon = 121.5, hd = 57
  const { U } = enuEcef(lat, lon)
  const b1 = bodyBasisEcef(lat, lon, hd, 12, 0), b2 = bodyBasisEcef(lat, lon, hd, 0, 20)
  near(dot(b1.X, U), Math.sin(12 * D2R), 1e-15, '抬头')
  near(dot(b2.Y, U), -Math.sin(20 * D2R), 1e-15, '右翼下沉')
  const h = headingDirEcef(lat, lon, hd)
  near(angDeg(add(b1.X, U, -dot(b1.X, U)), h), 0, 1e-6, '机头水平投影 = 航向')
})
t('地球站 NED：X = 北、Y = 东、Z = 下（航向 0、俯仰 0、滚转 0）', () => {
  for (const [lat, lon] of [[0, 0], [39.9, 116.4], [-33.9, 151.2], [64.8, -147.7], [89.9, 12]]) {
    const pose = stationPoseAt(lat, lon), { E, N, U } = enuEcef(lat, lon)
    nearV(toEcef(quatRotate(pose.qB2S, [1, 0, 0])), N, 1e-14, 'X=N')
    nearV(toEcef(quatRotate(pose.qB2S, [0, 1, 0])), E, 1e-14, 'Y=E')
    nearV(toEcef(quatRotate(pose.qB2S, [0, 0, 1])), scl(U, -1), 1e-14, 'Z=下')
  }
})

// ═════════════════════════════ ③ 模型轴 ═════════════════════════════
t('Q_YUP_ZENITH：glTF +Z = 机头方向、+Y = 机身上方（平飞即天顶）、+X = 左侧', () => {
  const pose = makeEntityPose()
  for (let i = 0; i < 100; i++) {
    const lat = rnd() * 160 - 80, lon = rnd() * 360 - 180, hd = rnd() * 360, th = rnd() * 20 - 10, ph = rnd() * 30 - 15
    entityPoseAt(lat, lon, hd, th, ph, pose)
    const qM2S = quatMul(pose.qB2S, Q_YUP_ZENITH)
    const b = bodyBasisEcef(lat, lon, hd, th, ph)
    nearV(toEcef(quatRotate(qM2S, [0, 0, 1])), b.X, 1e-13, `glTF +Z = 机头 ${i}`)
    nearV(toEcef(quatRotate(qM2S, [0, 1, 0])), scl(b.Z, -1), 1e-13, `glTF +Y = 机身上方 ${i}`)
    nearV(toEcef(quatRotate(qM2S, [1, 0, 0])), scl(b.Y, -1), 1e-13, `glTF +X = 左 ${i}`)
  }
  // 平飞：glTF +Y 恰为场景径向（天顶）、glTF +Z 恰为航向
  entityPoseAt(22.3, 114.2, 135, 0, 0, pose)
  const qM2S = quatMul(pose.qB2S, Q_YUP_ZENITH), v = llaToVec(22.3, 114.2, 0)
  nearV(quatRotate(qM2S, [0, 1, 0]), nrm([v.x, v.y, v.z]), 1e-14, '平飞 +Y = 天顶')
  nearV(quatRotate(qM2S, [0, 0, 1]), toScene(headingDirEcef(22.3, 114.2, 135)), 1e-14, '平飞 +Z = 航向')
})

// ═════════════════════════════ ④ 与航迹衔接 ═════════════════════════════
t('vehiclePoseAt(trajStateAt(...))：机头水平投影 = 航迹切向；俯仰 = 航迹角', () => {
  const T0 = Date.UTC(2026, 8, 24)
  const tr = { id: 'veh', kind: 'flight', pts: [{ lat: 40.08, lon: 116.58 }, { lat: 43.9, lon: 125.2 }, { lat: 45.6, lon: 126.2 }], t0Ms: T0, speedKmh: 800 }
  const st = makeTrajState(), pose = makeEntityPose()
  for (const dtMin of [3, 10, 45, 80, 110]) {
    trajStateAt(tr, T0 + dtMin * 60000, st)
    if (st.done) continue
    vehiclePoseAt(st, pose)
    const X = quatRotate(pose.qB2S, [1, 0, 0]), up = toScene(enuEcef(st.lat, st.lon).U)
    const horiz = add(X, up, -dot(X, up))
    near(angDeg(horiz, st.tan), 0, 1e-6, `机头 = 切向 t=${dtMin}min`)
    near(Math.asin(dot(X, up)) / D2R, st.pitchDeg, 1e-9, `俯仰 t=${dtMin}min`)
  }
})

t('航点恰在极点（lat 90 / −90、lon ≠ 0）：机头水平投影 = 航迹切向（静止档、运动档到达）', () => {
  const T0 = Date.UTC(2026, 8, 24)
  for (const [la0, la1, lon] of [[80, 90, 100], [-80, -90, -45], [85, 90, 179.9]]) {
    const pts = [{ lat: la0, lon }, { lat: la1, lon }]
    for (const tr of [{ id: `poleS ${la1} ${lon}`, kind: 'flight', pts }, { id: `poleM ${la1} ${lon}`, kind: 'flight', pts, t0Ms: T0, speedKmh: 800 }]) {
      const st = trajStateAt(tr, T0 + 864e5)
      if (tr.t0Ms) assert.equal(st.done, true)
      assert.equal(st.hasTan, true)
      const pose = vehiclePoseAt(st)
      const X = quatRotate(pose.qB2S, [1, 0, 0]), up = toScene(enuEcef(st.lat, st.lon).U)
      near(angDeg(add(X, up, -dot(X, up)), st.tan), 0, 1e-6, `机头 = 切向 ${tr.id}`)
    }
  }
})

// ═════════════════════════════ ⑤ 地球站对星 ═════════════════════════════
// 在真 WGS-84 里按 (az, el) 放一颗大地高 hs 的星：沿视线二分到 h = hs（与摸底 aimerr.mjs 同法）
function satAt(lat, lon, az, el, hs) {
  const S = W.geodeticToEcef(lon, lat, 0), { E, N, U } = enuEcef(lat, lon)
  const d = add(scl(add(scl(N, Math.cos(az * D2R)), E, Math.sin(az * D2R)), Math.cos(el * D2R)), U, Math.sin(el * D2R))
  let lo = 0, hi = 2e5
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; const P = add(S, d, m); if (W.ecefToGeodetic(P[0], P[1], P[2]).h < hs) lo = m; else hi = m }
  return add(S, d, lo)
}
const LATS = [0, 30, 45, 60], LON0 = 100
const lookDirEnu = (az, el) => [Math.cos(el * D2R) * Math.sin(az * D2R), Math.cos(el * D2R) * Math.cos(az * D2R), Math.sin(el * D2R)]   // (E, N, U)
let worstAim = 0, worstAimCase = ''
function checkAim(st, P, tag) {
  const w = stationTrackAzEl(st, P), s = stationAimScene(st, P)
  const e = angDeg(lookDirEnu(w.azDeg, w.elDeg), lookDirEnu(s.azDeg, s.elDeg))
  if (e > worstAim) { worstAim = e; worstAimCase = tag }
  assert.ok(e <= 0.2, `${tag}：场景锚点口径与 WGS-84 差 ${e.toFixed(4)}°`)
  return { w, s }
}
t('WGS-84 读数：对「按 az/el 放的星」1e-7°、对 satellite.js ecfToLookAngles 1e-9°、斜距一致（GEO 高度 / LEO 500 / 1200 km）', () => {
  const look = makeStationLook()
  for (const lat of LATS) for (const hs of [500, 1200, 35786]) for (const az of [0, 45, 90, 180, 270, 333]) for (const el of [5, 10, 30, 60]) {
    const st = { lat, lon: LON0 }, P = satAt(lat, LON0, az, el, hs)
    stationTrackAzEl(st, P, look)
    near(look.elDeg, el, 1e-7, `el ${lat}/${hs}/${az}/${el}`)
    assert.ok(azDiff(look.azDeg, az) <= 1e-7, `az ${lat}/${hs}/${az}/${el}：${look.azDeg}`)
    assert.ok(look.azDeg >= 0 && look.azDeg < 360)
    const ref = satjs.ecfToLookAngles({ longitude: LON0 * D2R, latitude: lat * D2R, height: 0 }, { x: P[0], y: P[1], z: P[2] })
    near(look.elDeg, ref.elevation / D2R, 1e-9, 'satellite.js el')
    assert.ok(azDiff(look.azDeg, ref.azimuth / D2R) <= 1e-9, `satellite.js az ${look.azDeg} vs ${ref.azimuth / D2R}`)
    near(look.rangeKm, ref.rangeSat, 1e-7, '斜距')
    assert.equal(look.visible, true); assert.equal(look.singular, false)
  }
  // 站址海拔（altM）进读数
  const P = satAt(30, LON0, 120, 20, 800)
  const hi = stationTrackAzEl({ lat: 30, lon: LON0, altM: 3000 }, P)
  const ref = satjs.ecfToLookAngles({ longitude: LON0 * D2R, latitude: 30 * D2R, height: 3 }, { x: P[0], y: P[1], z: P[2] })
  near(hi.elDeg, ref.elevation / D2R, 1e-9, '海拔 3 km el'); near(hi.rangeKm, ref.rangeSat, 1e-7, '海拔 3 km 斜距')
})
t('场景锚点口径（星锚点 − 站锚点）与 WGS-84 读数差 ≤ 0.2°：LEO 300 / 500 / 1200 km 与 GEO 高度，纬度 0/30/45/60、仰角 5–60°', () => {
  for (const lat of LATS) for (const hs of [300, 500, 1200, 35786]) for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) for (const el of [5, 10, 20, 30, 45, 60]) {
    checkAim({ lat, lon: LON0 }, satAt(lat, LON0, az, el, hs), `lat ${lat} h ${hs} az ${az} el ${el}`)
  }
})
t('场景锚点口径：真 GEO 圆环（赤道 42164.17 km）上仰角 5–60° 的星，差 ≤ 0.2°', () => {
  let cnt = 0
  for (const lat of LATS) for (let dl = -80; dl <= 80; dl += 2.5) {
    const lonS = LON0 + dl, P = [W.RS_GEO * Math.cos(lonS * D2R), W.RS_GEO * Math.sin(lonS * D2R), 0]
    const w = stationTrackAzEl({ lat, lon: LON0 }, P)
    if (w.elDeg < 5 || w.elDeg > 60) continue
    checkAim({ lat, lon: LON0 }, P, `GEO lat ${lat} Δλ ${dl}`); cnt++
    // 南半球站
    checkAim({ lat: -lat, lon: LON0 }, P, `GEO lat ${-lat} Δλ ${dl}`)
  }
  assert.ok(cnt > 60, `GEO 样本 ${cnt}`)
  console.log(`  场景锚点口径 vs WGS-84 最坏 ${worstAim.toFixed(4)}°（${worstAimCase}）`)
})
t('stationAimScene：dir = 星场景锚点 − 站场景锚点（单位化）、可传实际站锚点（数组 / THREE.Vector3 / {x,y,z}）', () => {
  const st = { lat: 45, lon: LON0 }, P = satAt(45, LON0, 200, 25, 1200)
  const s = stationAimScene(st, P)
  const g = W.ecefToGeodetic(P[0], P[1], P[2]), ta = llaToVec(g.lat, g.lon, g.h), sa = llaToVec(45, LON0, 0)
  nearV(s.dir, nrm([ta.x - sa.x, ta.y - sa.y, ta.z - sa.z]), 1e-12, 'dir')
  near(s.rangeKm, Math.hypot(ta.x - sa.x, ta.y - sa.y, ta.z - sa.z) * 6371, 1e-6, '场景距离')
  // 与导出的 ecefToGeodetic + sceneAnchor 逐位一致（私有复写没走样）
  const gg = ecefToGeodetic(P[0], P[1], P[2]), t2 = sceneAnchor(gg.lat, gg.lon, gg.hKm), s2a = sceneAnchor(45, LON0, 0)
  const dx = t2[0] - s2a[0], dy = t2[1] - s2a[1], dz = t2[2] - s2a[2], r = Math.sqrt(dx * dx + dy * dy + dz * dz)
  assert.ok(Object.is(s.dir[0], dx / r) && Object.is(s.dir[1], dy / r) && Object.is(s.dir[2], dz / r), '逐位 dir')
  assert.ok(Object.is(s.rangeKm, r * 6371), '逐位场景距离')
  const lifted = sceneAnchor(45, LON0, 0).map((x) => x * 1.0012)
  const s2 = stationAimScene(st, P, undefined, lifted)
  nearV(s2.dir, nrm([ta.x - lifted[0], ta.y - lifted[1], ta.z - lifted[2]]), 1e-12, '抬高后的锚点')
  assert.ok(Math.abs(s2.elDeg - s.elDeg) > 0.01, `抬高锚点确实改了仰角：${s2.elDeg} vs ${s.elDeg}`)
  // THREE.Vector3（mesh.position）与 {x,y,z} 与数组同一结果（逐位）
  const liftedV = llaToVec(45, LON0, 0).multiplyScalar(1.0012)
  for (const [anc, tag] of [[liftedV, 'Vector3'], [{ x: lifted[0], y: lifted[1], z: lifted[2] }, '{x,y,z}']]) {
    const s3 = stationAimScene(st, P, undefined, anc)
    for (let k = 0; k < 3; k++) assert.ok(Object.is(s3.dir[k], s2.dir[k]), `${tag} dir[${k}]`)
    assert.ok(Object.is(s3.elDeg, s2.elDeg) && Object.is(s3.azDeg, s2.azDeg), `${tag} 角度`)
  }
  // 非有限锚点 → 缺省锚点
  const s4 = stationAimScene(st, P, undefined, [NaN, 0, 0]), s5 = stationAimScene(st, P, undefined, { x: 1, y: NaN, z: 0 })
  assert.ok(Object.is(s4.elDeg, s.elDeg) && Object.is(s5.elDeg, s.elDeg), '非有限锚点退回缺省')
})
t('挂点系：STATION_MOUNT = attitude.mountFrame(视轴 +X_B、up −Z_B)；dirFromAzEl(a1, a2) 回到视线；a1 = −罗盘方位', () => {
  const mf = mountFrame({ boresightBody: [1, 0, 0], upBody: [0, 0, -1] })
  nearV(mf.x, STATION_MOUNT.x, 1e-15, 'x'); nearV(mf.y, STATION_MOUNT.y, 1e-15, 'y'); nearV(mf.z, STATION_MOUNT.z, 1e-15, 'z')
  const look = makeStationLook()
  for (const [az, el] of [[0, 10], [90, 30], [180, 45], [270, 5], [123.4, 56.7]]) {
    const P = satAt(30, LON0, az, el, 1200)
    stationTrackAzEl({ lat: 30, lon: LON0 }, P, look)
    near(((look.a1Deg + az) % 360 + 540) % 360 - 180, 0, 1e-7, `a1 = −az (${az})`)
    near(look.a2Deg, el, 1e-7, 'a2 = el')
    // 挂点系方向 → 本体 NED → ENU，应为视线
    const dm = dirFromAzEl(look.a1Deg, look.a2Deg), M = STATION_MOUNT
    const b = add(add(scl(M.x, dm[0]), M.y, dm[1]), M.z, dm[2])                   // 本体 NED
    nearV([b[1], b[0], -b[2]], lookDirEnu(az, el), 1e-9, `关节角还原视线 (${az},${el})`)
  }
})
t('天顶 keyhole：GEO 正上方 → singular、仰角 90°；复用 out 时方位沿用上一次（关节不乱转）', () => {
  const look = makeStationLook()
  const P1 = satAt(0, LON0, 250, 40, 35786)
  stationTrackAzEl({ lat: 0, lon: LON0 }, P1, look)
  const a1 = look.a1Deg
  const P = W.geodeticToEcef(LON0, 0, W.RS_GEO - W.A)
  stationTrackAzEl({ lat: 0, lon: LON0 }, P, look)
  assert.equal(look.singular, true); near(look.elDeg, 90, 1e-9, '仰角')
  assert.equal(look.a1Deg, a1, '方位沿用')
  const fresh = stationTrackAzEl({ lat: 0, lon: LON0 }, P)
  assert.equal(fresh.a1Deg, 0); assert.equal(fresh.azDeg, 0)
})
t('地平以下：visible = false；非法目标返回 NaN 不抛', () => {
  const P = satAt(45, LON0, 10, 30, 800)
  const far = stationTrackAzEl({ lat: -45, lon: LON0 + 180 }, P)
  assert.ok(far.elDeg < 0); assert.equal(far.visible, false)
  const bad = stationTrackAzEl({ lat: 10, lon: 10 }, W.geodeticToEcef(10, 10, 0))
  assert.ok(Number.isNaN(bad.elDeg)); assert.equal(bad.visible, false)
})
t('整体转方位兜底：entityPoseAt(lat, lon, 罗盘方位, 0, 0) 的机头（视轴零位）方位 = 对星方位', () => {
  for (const lat of LATS) for (const az of [15, 100, 200, 300]) {
    const P = satAt(lat, LON0, az, 20, 35786)
    const s = stationAimScene({ lat, lon: LON0 }, P)
    const pose = entityPoseAt(lat, LON0, s.azDeg, 0, 0)
    const X = toEcef(quatRotate(pose.qB2S, [1, 0, 0])), { E, N } = enuEcef(lat, LON0)
    const azX = (Math.atan2(dot(X, E), dot(X, N)) / D2R + 360) % 360
    assert.ok(azDiff(azX, s.azDeg) <= 1e-9, `lat ${lat} az ${az}：${azX} vs ${s.azDeg}`)
  }
})

// ═════════════════════════════ ⑥ 热路径分配量 ═════════════════════════════
// 采样堆分析（量法同 modelTrajKinematics ⑨ / modelAttitudeLaws ⑦），整份剖面计数、只剔 node: 内部帧。
// 代码里没有显式分配（qL2S 不走 attitude.lvlhQuatScene 的 Math.hypot、四元数积不走被冻结常量撑开的 attitude.quatMul，
// 站 / 星的 double 经暂存数组递、不当实参传）；单独跑五项都 ≈ 0 B / 次，剩下的是 V8 装箱（16 B / 个，随 JIT 反馈浮动）：本进程前面
// 的用例拿数组 / {x,y,z} / Vector3 喂过锚点与目标，取分量变 megamorphic，最后一项实测 ≈ 64 B / 次（页面锚点恒为 mesh.position，单态）。
// 判据只抓显式分配回归（改前 entityPoseAt ≈ 600 B / 次、对象 / 数组字面量 ≈ 72 B 起）：上限 6 个装箱。ALLOC_SITES=1 打印分配点。
const ALLOC_MAX_B = 96
async function allocPerCall(ss, fn, N) {
  fn(); fn()                                                               // 预热到优化态
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
  if (process.env.ALLOC_SITES) console.log('    ', [...sites].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => k + ' ' + (v / N).toFixed(1)).join('; '))
  return bytes / N
}
{
  const name = '热路径分配量：entityPoseAt / vehiclePoseAt / stationTrackAzEl / stationAimScene 复用 out 时每次 ≤ ALLOC_MAX_B（报数）'
  try {
    const N = 100000, T0 = Date.UTC(2026, 8, 24)
    const pose = makeEntityPose(), look = makeStationLook(), st = { lat: 30, lon: LON0 }
    const Parr = satAt(30, LON0, 150, 35, 35786), Pobj = { x: Parr[0], y: Parr[1], z: Parr[2] }
    const anchorV = llaToVec(30, LON0, 0).multiplyScalar(1.0012)
    const tr = { id: 'allocVeh', kind: 'flight', pts: [{ lat: 40.08, lon: 116.58 }, { lat: 43.9, lon: 125.2 }], t0Ms: T0, speedKmh: 800 }
    const ts = makeTrajState()
    trajStateAt(tr, T0 + 30 * 60000, ts)
    const hd = new Float64Array(360)
    for (let i = 0; i < 360; i++) hd[i] = i + 0.5
    const cases = [
      ['entityPoseAt', () => { for (let i = 0; i < N; i++) entityPoseAt(31.2, 121.5, hd[i % 360], 3, 1, pose) }],
      ['vehiclePoseAt', () => { for (let i = 0; i < N; i++) vehiclePoseAt(ts, pose) }],
      ['stationTrackAzEl', () => { for (let i = 0; i < N; i++) stationTrackAzEl(st, Parr, look) }],
      ['stationAimScene', () => { for (let i = 0; i < N; i++) stationAimScene(st, Parr, look) }],
      ['stationAimScene（{x,y,z} 星、Vector3 锚点）', () => { for (let i = 0; i < N; i++) stationAimScene(st, Pobj, look, anchorV) }]
    ]
    const ss = new Session(); ss.connect()
    await ss.post('HeapProfiler.enable')
    const rows = [], over = []
    for (const [nm, fn] of cases) { const b = await allocPerCall(ss, fn, N); rows.push(`${nm} ${b.toFixed(1)}`); if (b > ALLOC_MAX_B) over.push(`${nm} ${b.toFixed(1)} B`) }
    await ss.post('HeapProfiler.disable'); ss.disconnect()
    console.log(`  每次调用平均分配（B，${N} 次、采样堆分析）：` + rows.join('；'))
    assert.equal(over.length, 0, `超过 ${ALLOC_MAX_B} B / 次（疑似显式分配回归）：${over.join('，')}`)
    n++
  } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 }
}

console.log(`modelEntityPose: ${n} 项通过`)
