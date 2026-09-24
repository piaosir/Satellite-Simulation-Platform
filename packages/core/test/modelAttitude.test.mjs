// 姿态 / 光照几何（packages/core/models/attitude.mjs）的回归网。
//
//   ① 场景轴：sceneFromEcef 与 3D 球实际用的 focusLanes.llaToVec 方向逐点对拍（外部真值 = 渲染端代码本身）。
//   ② LVLH / nadir：四元数单位、矩阵正交归一且 det=+1；本体 +Z 精确指地心（1e-12）；+X 沿速度水平投影；
//      +Y = 负轨道法向（GEO 顺行 → 指南）；GEO 用惯性速度，地固速度 ≈ 0 也不影响。
//   ③ 地影因子：日照 1、本影 0、半影单调介于其间；GEO 春分午夜前后进出影时刻打印出来（给数，不设硬判据，只查先后顺序与对称）。

import assert from 'node:assert/strict'
import {
  sceneFromEcef, ecefFromScene, lvlhFrameEcef, lvlhQuatScene, Q_BODY2L_NADIR, bodyQuatSceneNadir,
  quatRotate, quatMul, quatConj, matFromQuat, quatFromBasis, sunDirEcef, sunDirScene, eclipseFactor, EARTH_RADIUS_KM
} from '../models/attitude.mjs'
import { llaToVec } from '../../../src/viz/globe3d/focusLanes.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const nearV = (a, b, tol, msg) => { for (let k = 0; k < 3; k++) near(a[k], b[k], tol, `${msg}[${k}]`) }
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(...a)
const nrm = (a) => { const l = len(a); return a.map((x) => x / l) }
const D2R = Math.PI / 180

// 确定性伪随机（LCG），别用 Math.random：失败要能复现
let seed = 12345
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// 圆轨道上的一点：半径 a（km）、倾角 i、升交点赤经 Ω、纬度幅角 u（度）→ ECEF 位置与惯性速度（ECEF 轴向）
function orbitPoint(a, iDeg, raanDeg, uDeg) {
  const i = iDeg * D2R, O = raanDeg * D2R, u = uDeg * D2R, v = Math.sqrt(398600.4418 / a)
  const P = [Math.cos(O), Math.sin(O), 0], Q = [-Math.sin(O) * Math.cos(i), Math.cos(O) * Math.cos(i), Math.sin(i)]
  const r = [0, 1, 2].map((k) => a * (Math.cos(u) * P[k] + Math.sin(u) * Q[k]))
  const vv = [0, 1, 2].map((k) => v * (-Math.sin(u) * P[k] + Math.cos(u) * Q[k]))
  return { r, v: vv }
}

t('sceneFromEcef 与 focusLanes.llaToVec 方向一致（经纬网格逐点，1e-12）', () => {
  for (let lat = -90; lat <= 90; lat += 15) {
    for (let lon = -180; lon <= 180; lon += 20) {
      const e = [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)]
      const s = sceneFromEcef(e), L = llaToVec(lat, lon, 0)
      nearV(s, [L.x, L.y, L.z], 1e-12, `(${lat},${lon})`)
      nearV(ecefFromScene(s), e, 1e-15, '逆变换')
      nearV(sunDirScene(lat, lon), [L.x, L.y, L.z], 1e-12, `sunDirScene(${lat},${lon})`)
    }
  }
  // 接受 satellite.js 的 {x,y,z}
  nearV(sceneFromEcef({ x: 1, y: 2, z: 3 }), [1, 3, -2], 0, '{x,y,z} 入参')
})

t('Q_BODY2L_NADIR：X_B→x̂、Y_B→ẑ、Z_B→−ŷ', () => {
  nearV(quatRotate(Q_BODY2L_NADIR, [1, 0, 0]), [1, 0, 0], 1e-15, 'X_B')
  nearV(quatRotate(Q_BODY2L_NADIR, [0, 1, 0]), [0, 0, 1], 1e-15, 'Y_B')
  nearV(quatRotate(Q_BODY2L_NADIR, [0, 0, 1]), [0, -1, 0], 1e-15, 'Z_B')
})

t('LVLH / nadir：正交归一、det=+1、+Z_B 精确指地心、+X_B 沿速度、+Y_B = 负轨道法向（300 个随机轨道点）', () => {
  let worstZ = 0
  for (let k = 0; k < 300; k++) {
    const a = 6371 + 300 + rnd() * 40000, { r, v } = orbitPoint(a, rnd() * 180, rnd() * 360, rnd() * 360)
    // 加一点径向速度分量（偏心轨道的样子），沿迹轴要把它去掉
    const kr = 0.3 * rnd()
    const vr = v.map((x, i) => x + kr * r[i] / len(r))
    const q = lvlhQuatScene(r, vr)
    near(Math.hypot(...q), 1, 1e-14, '|qL2S|')
    const M = matFromQuat(q)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(M[0][i] * M[0][j] + M[1][i] * M[1][j] + M[2][i] * M[2][j], i === j ? 1 : 0, 1e-13, `MᵀM[${i}${j}]`)
    near(dot(cross([M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]]), [M[0][2], M[1][2], M[2][2]]), 1, 1e-13, 'det')
    const qb = bodyQuatSceneNadir(r, vr)
    const zB = quatRotate(qb, [0, 0, 1]), xB = quatRotate(qb, [1, 0, 0]), yB = quatRotate(qb, [0, 1, 0])
    const down = sceneFromEcef(nrm(r).map((x) => -x))
    worstZ = Math.max(worstZ, len([zB[0] - down[0], zB[1] - down[1], zB[2] - down[2]]))
    // +X_B = 速度去径向后的方向；+Y_B = −(r × v) 方向
    const up = nrm(r), vh = nrm(vr.map((x, i) => x - dot(vr, up) * up[i]))
    nearV(xB, sceneFromEcef(vh), 1e-12, '+X_B 沿速度水平投影')
    nearV(yB, sceneFromEcef(nrm(cross(r, v)).map((x) => -x)), 1e-9, '+Y_B = 负轨道法向')
    // qB2S = qL2S ⊗ qB2L
    const qb2 = quatMul(q, Q_BODY2L_NADIR)
    nearV(qb2.slice(0, 3), qb.slice(0, 3), 1e-15, '合成')
  }
  assert.ok(worstZ < 1e-12, `+Z_B 指地心最大偏差 ${worstZ}`)
  console.log(`  +Z_B 指地心最大偏差 ${worstZ.toExponential(2)}（300 点）`)
})

t('GEO：惯性速度定沿迹 → +X_B 指东、+Y_B 指南；地固速度≈0 不影响', () => {
  const a = 42164.17, lon = 110.5 * D2R
  const r = [a * Math.cos(lon), a * Math.sin(lon), 0]
  const vIn = [-3.0747 * Math.sin(lon), 3.0747 * Math.cos(lon), 0]
  const L = lvlhFrameEcef(r, vIn)
  nearV(L.x, [-Math.sin(lon), Math.cos(lon), 0], 1e-15, '沿迹 = 东')
  const qb = bodyQuatSceneNadir(r, vIn)
  nearV(quatRotate(qb, [0, 1, 0]), sceneFromEcef([0, 0, -1]), 1e-15, '+Y_B = 南')
  // 退化：零速度 / 纯径向速度 → 退到当地正东，不出 NaN
  for (const v of [[0, 0, 0], r.map((x) => x * 1e-3)]) {
    const q = lvlhQuatScene(r, v)
    assert.ok(q.every(Number.isFinite)); near(Math.hypot(...q), 1, 1e-14, '|q|')
    nearV(lvlhFrameEcef(r, v).x, [-Math.sin(lon), Math.cos(lon), 0], 1e-12, '退化 → 正东')
  }
  // 极点正上方且零速度：再退一级
  const qp = lvlhQuatScene([0, 0, 7000], [0, 0, 0]); assert.ok(qp.every(Number.isFinite))
})

t('quatFromBasis 与 matFromQuat 互逆（含 w 接近 0 的 180° 转）', () => {
  const bases = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, -1, 0], [0, 0, 1]],     // 绕 z 180°
    [[1, 0, 0], [0, -1, 0], [0, 0, -1]],     // 绕 x 180°
    [[0, 0, 1], [-1, 0, 0], [0, -1, 0]]      // 附录 B 映射 R 的转置 Rᵀ（列 = 本体轴在 glTF 系的像；附录 B 现名 Q_YUP_ZENITH，不是出厂值）
  ]
  for (const [x, y, z] of bases) {
    const q = quatFromBasis(x, y, z); assert.ok(q[3] >= 0)
    const M = matFromQuat(q)
    nearV([M[0][0], M[1][0], M[2][0]], x, 1e-15, 'col x'); nearV([M[0][1], M[1][1], M[2][1]], y, 1e-15, 'col y'); nearV([M[0][2], M[1][2], M[2][2]], z, 1e-15, 'col z')
  }
  // 附录 B：列为 R 的列（glTF 轴在本体系的像）→ 四元数 = bodyFrame 的 Q_YUP_ZENITH（NASA 语料 / 普通导入件的缺省，轴映射终案 ②）。
  // ≠ 出厂值 DEFAULT_Q_MODEL2BODY（= Q_STK = [0.5, 0.5, 0.5, 0.5]，STK 件 / 参数化 / 导出目标；2026-09-24 起）
  const qR = quatFromBasis([0, -1, 0], [0, 0, -1], [1, 0, 0])
  nearV(qR.slice(0, 3), [-0.5, 0.5, -0.5], 1e-15, '附录 B 四元数'); near(qR[3], 0.5, 1e-15, 'w')
  nearV(quatRotate(quatMul(qR, quatConj(qR)), [0.3, -2, 5]), [0.3, -2, 5], 1e-14, 'q q* = 1')
})

t('热路径 out 参数：写进同一数组、与向量版逐位一致', () => {
  const out = [9, 9, 9, 9], rot = [0, 0, 0]
  for (let k = 0; k < 50; k++) {
    const { r, v } = orbitPoint(7000 + rnd() * 30000, rnd() * 180, rnd() * 360, rnd() * 360)
    const L = lvlhFrameEcef(r, v)
    const qRef = quatFromBasis(sceneFromEcef(L.x), sceneFromEcef(L.y), sceneFromEcef(L.z))
    assert.equal(lvlhQuatScene(r, v, out), out)
    for (let i = 0; i < 4; i++) near(out[i], qRef[i], 1e-15, `q[${i}]`)
    const qb = bodyQuatSceneNadir({ x: r[0], y: r[1], z: r[2] }, { x: v[0], y: v[1], z: v[2] }, out)
    assert.equal(qb, out)
    assert.equal(quatRotate(qb, [0, 0, 1], rot), rot)
    nearV(rot, sceneFromEcef(nrm(r).map((x) => -x)), 1e-12, '+Z_B（out 版）')
  }
})

// ───────── 地影 ─────────

const SUN = [1, 0, 0]
t('地影三区：日照 = 1、本影 = 0、半影单调且严格介于 0 与 1', () => {
  assert.equal(eclipseFactor([7000, 0, 0], SUN), 1, '向阳面')
  assert.equal(eclipseFactor([0, 7000, 0], SUN), 1, '晨昏线上')
  assert.equal(eclipseFactor([-7000, 0, 0], SUN), 0, 'LEO 正背日')
  assert.equal(eclipseFactor([-42164, 0, 0], SUN), 0, 'GEO 正背日')
  assert.equal(eclipseFactor([-6000, 0, 0], SUN), 0, '地球内部')
  // LEO（7000 km）横扫地影边缘：y 从 6200 到 6500 km
  let prev = -1, inside = 0
  for (let y = 6200; y <= 6500; y += 0.5) {
    const f = eclipseFactor([-Math.sqrt(7000 * 7000 - y * y), y, 0], SUN)
    assert.ok(f >= prev - 1e-15, `y=${y} 非单调：${f} < ${prev}`)
    if (f > 0 && f < 1) inside++
    prev = f
  }
  assert.equal(prev, 1, '扫出地影后 = 1')
  assert.ok(inside > 10, `半影样本 ${inside}`)
  // 对称：y 取反结果相同
  near(eclipseFactor([-6800, 1500, 0], SUN), eclipseFactor([-6800, -1500, 0], SUN), 1e-15, '对称')
})

t('GEO 春分附近午夜前后进出影时刻（打印；只查先后与对称）', () => {
  const a = 42164.17, w = (2 * Math.PI) / 86400   // 相对太阳的角速度（一太阳日一圈）
  const at = (sec, decDeg) => {
    const th = w * sec, sd = [Math.cos(decDeg * D2R), 0, Math.sin(decDeg * D2R)]
    return eclipseFactor([-a * Math.cos(th), -a * Math.sin(th), 0], sd)
  }
  const edge = (decDeg, pred, lo, hi) => { // 在 [lo,hi] 秒内二分找 pred 翻转点
    for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (pred(at(m, decDeg)) === pred(at(lo, decDeg))) lo = m; else hi = m }
    return (lo + hi) / 2
  }
  const fmt = (s) => `${s < 0 ? '−' : '+'}${Math.floor(Math.abs(s) / 60)}m${(Math.abs(s) % 60).toFixed(1).padStart(4, '0')}s`
  const rows = []
  for (const dec of [0, 2, 5, 8, 8.5, 8.8]) {
    if (at(0, dec) === 1) { rows.push(`  赤纬 ${String(dec).padStart(4)}°：午夜也在日照中（出食季）`); continue }
    const pIn = edge(dec, (f) => f < 1, -7200, 0), pOut = edge(dec, (f) => f < 1, 0, 7200)
    const hasUmbra = at(0, dec) === 0
    const uIn = hasUmbra ? edge(dec, (f) => f === 0, pIn, 0) : null, uOut = hasUmbra ? edge(dec, (f) => f === 0, 0, pOut) : null
    assert.ok(pIn < 0 && pOut > 0, '入半影在午夜前、出半影在午夜后')
    near(pIn, -pOut, 1e-3, '进出对称')
    if (hasUmbra) { assert.ok(pIn < uIn && uIn < 0 && 0 < uOut && uOut < pOut, '先半影后本影'); near(uIn, -uOut, 1e-3, '本影对称') }
    rows.push(`  赤纬 ${String(dec).padStart(4)}°：入半影 ${fmt(pIn)}  入本影 ${hasUmbra ? fmt(uIn) : '—'}  出本影 ${hasUmbra ? fmt(uOut) : '—'}  出半影 ${fmt(pOut)}  ` +
      `本影 ${hasUmbra ? ((uOut - uIn) / 60).toFixed(1) : '0'} min、含半影 ${((pOut - pIn) / 60).toFixed(1)} min`)
  }
  console.log('  GEO 地影（相对当地午夜；地球半径 ' + EARTH_RADIUS_KM + ' km、日地 1 AU）：\n' + rows.join('\n'))
})

t('sunDirEcef：日下点 → 单位矢量', () => {
  nearV(sunDirEcef(0, 0), [1, 0, 0], 1e-15, '(0,0)')
  nearV(sunDirEcef(23.44, 90), [0, Math.cos(23.44 * D2R), Math.sin(23.44 * D2R)], 1e-15, '夏至 90°E')
})

console.log(`modelAttitude: ${n} 项通过`)
