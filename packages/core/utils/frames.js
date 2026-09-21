// 惯性系 / 地固系换算（IAU-76 岁差 + IAU-80 章动，纯 CommonJS）。
//
// 【链路】J2000 --P(IAU-76)--> MOD --N(IAU-80)--> TOD --R3(-Eq.Eq)--> TEME --R3(GMST)--> ECEF
//   ICRF / GCRF 与 J2000 差 mas 级（frame bias），本模块【视同 J2000】。
//   TEME->ECEF 只用 GMST，与 vendor/satellite.js 的 gstime / eciToEcf 逐位同口径 —— 这是硬要求：
//   平台既有口径是「卫星位置 = TEME，经 gstime 落地」，外部星历必须换到 TEME 才能进现有管线。
//
// 【明确忽略的两项，及其误差上限】
//   dUT1（|dUT1| <= 0.9 s）：GMST 少转 0.9 s x 7.292e-5 rad/s = 6.6e-5 rad，在赤道面上对 LEO
//     （r~7000 km）是 0.46 km、对 GEO 是 2.8 km 的【经度方向】位移；对仰角 / 斜距的影响远小于此。
//   极移 xp, yp（<= 0.3"）：0.3" x 6378 km = 9 m。
//   两者合计 <= 0.5 km 量级，故本模块头注的口径是：ECEF 方向误差 <= 1 km。若将来要做米级 ECEF，
//   须引入 IERS EOP（ΔUT1 + 极移），届时只改本文件。
//   惯性侧（J2000 <-> TEME）不含上述两项，只受章动截断影响，误差 <= 50 m 量级。
//
// 【符号约定】本文件的 rot1/rot2/rot3 是【坐标系旋转】（frame rotation），与 satellite.js 的
//   eciToEcf(eci, gmst) 逐字同形：rot3(v, a) => x' = x cos a + y sin a, y' = -x sin a + y cos a。
//   故 ecef = rot3(teme, gmst) 与 eciToEcf 完全一致（见 frames.test.mjs 的逐位断言）。

'use strict'

const T = require('./timeSystems.js')

const ARCSEC = Math.PI / (180 * 3600)
const DEG = Math.PI / 180
const OMEGA_E = 7.2921158553e-5   // 地球自转角速度 (rad/s)，仅用于 ECEF<->惯性 的速度换算

/* ===================== 坐标系旋转（frame rotation） ===================== */
function rot1(v, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return { x: v.x, y: v.y * c + v.z * s, z: -v.y * s + v.z * c }
}
function rot2(v, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return { x: v.x * c - v.z * s, y: v.y, z: v.x * s + v.z * c }
}
function rot3(v, a) {
  const c = Math.cos(a), s = Math.sin(a)
  return { x: v.x * c + v.y * s, y: -v.x * s + v.y * c, z: v.z }
}

/* ===================== IAU-76 岁差 ===================== */
// zeta / theta / z（弧度），T 为 J2000 起的 TT 儒略世纪数。
function precessionAngles(t) {
  const t2 = t * t, t3 = t2 * t
  return {
    zeta: (2306.2181 * t + 0.30188 * t2 + 0.017998 * t3) * ARCSEC,
    theta: (2004.3109 * t - 0.42665 * t2 - 0.041833 * t3) * ARCSEC,
    z: (2306.2181 * t + 1.09468 * t2 + 0.018203 * t3) * ARCSEC
  }
}

/* ===================== IAU-80 章动（1980 IAU Theory of Nutation，106 项） =====================
   每行：l, l', F, D, Omega 五个 Delaunay 乘子 | A(0.1 mas) | B(0.1 mas/世纪) | C(0.1 mas) | D(0.1 mas/世纪)
   dpsi = sum (A + B·T)·sin(arg)   deps = sum (C + D·T)·cos(arg)   单位 0.0001"
   表来源：IERS Conventions (1996) Table 5.1 / Vallado 附录 nut80.dat，按振幅降序。 */
const NUT80 = [
  [0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
  [0, 0, 2, -2, 2, -13187, -1.6, 5736, -3.1],
  [0, 0, 2, 0, 2, -2274, -0.2, 977, -0.5],
  [0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
  [0, -1, 0, 0, 0, -1426, 3.4, 54, -0.1],
  [1, 0, 0, 0, 0, 712, 0.1, -7, 0],
  [0, 1, 2, -2, 2, -517, 1.2, 224, -0.6],
  [0, 0, 2, 0, 1, -386, -0.4, 200, 0],
  [1, 0, 2, 0, 2, -301, 0, 129, -0.1],
  [0, -1, 2, -2, 2, 217, -0.5, -95, 0.3],
  [-1, 0, 0, 2, 0, 158, 0, -1, 0],
  [0, 0, 2, -2, 1, 129, 0.1, -70, 0],
  [-1, 0, 2, 0, 2, 123, 0, -53, 0],
  [1, 0, 0, 0, 1, 63, 0.1, -33, 0],
  [0, 0, 0, 2, 0, 63, 0, -2, 0],
  [-1, 0, 2, 2, 2, -59, 0, 26, 0],
  [-1, 0, 0, 0, 1, -58, -0.1, 32, 0],
  [1, 0, 2, 0, 1, -51, 0, 27, 0],
  [-2, 0, 0, 2, 0, -48, 0, 1, 0],
  [-2, 0, 2, 0, 1, 46, 0, -24, 0],
  [0, 0, 2, 2, 2, -38, 0, 16, 0],
  [2, 0, 2, 0, 2, -31, 0, 13, 0],
  [2, 0, 0, 0, 0, 29, 0, -1, 0],
  [1, 0, 2, -2, 2, 29, 0, -12, 0],
  [0, 0, 2, 0, 0, 26, 0, -1, 0],
  [0, 0, 2, -2, 0, -22, 0, 0, 0],
  [-1, 0, 2, 0, 1, 21, 0, -10, 0],
  [0, 2, 0, 0, 0, 17, -0.1, 0, 0],
  [0, 2, 2, -2, 2, -16, 0.1, 7, 0],
  [-1, 0, 0, 2, 1, 16, 0, -8, 0],
  [0, 1, 0, 0, 1, -15, 0, 9, 0],
  [1, 0, 0, -2, 1, -13, 0, 7, 0],
  [0, -1, 0, 0, 1, -12, 0, 6, 0],
  [2, 0, -2, 0, 0, 11, 0, 0, 0],
  [-1, 0, 2, 2, 1, -10, 0, 5, 0],
  [1, 0, 2, 2, 2, -8, 0, 3, 0],
  [0, -1, 2, 0, 2, -7, 0, 3, 0],
  [0, 0, 2, 2, 1, -7, 0, 3, 0],
  [1, 1, 0, -2, 0, -7, 0, 0, 0],
  [0, 1, 2, 0, 2, 7, 0, -3, 0],
  [-2, 0, 0, 2, 1, -6, 0, 3, 0],
  [0, 0, 0, 2, 1, -6, 0, 3, 0],
  [2, 0, 2, -2, 2, 6, 0, -3, 0],
  [1, 0, 0, 2, 0, 6, 0, 0, 0],
  [1, 0, 2, -2, 1, 6, 0, -3, 0],
  [0, 0, 0, -2, 1, -5, 0, 3, 0],
  [0, -1, 2, -2, 1, -5, 0, 3, 0],
  [2, 0, 2, 0, 1, -5, 0, 3, 0],
  [1, -1, 0, 0, 0, 5, 0, 0, 0],
  [1, 0, 0, -1, 0, -4, 0, 0, 0],
  [0, 0, 0, 1, 0, -4, 0, 0, 0],
  [0, 1, 0, -2, 0, -4, 0, 0, 0],
  [1, 0, -2, 0, 0, 4, 0, 0, 0],
  [2, 0, 0, -2, 1, 4, 0, -2, 0],
  [0, 1, 2, -2, 1, 4, 0, -2, 0],
  [1, 1, 0, 0, 0, -3, 0, 0, 0],
  [1, -1, 0, -1, 0, -3, 0, 0, 0],
  [-1, -1, 2, 2, 2, -3, 0, 1, 0],
  [0, -1, 2, 2, 2, -3, 0, 1, 0],
  [1, -1, 2, 0, 2, -3, 0, 1, 0],
  [3, 0, 2, 0, 2, -3, 0, 1, 0],
  [-2, 0, 2, 0, 2, -3, 0, 1, 0],
  [1, 0, 2, 0, 0, 3, 0, 0, 0],
  [-1, 0, 2, 4, 2, -2, 0, 1, 0],
  [1, 0, 0, 0, 2, -2, 0, 1, 0],
  [-1, 0, 2, -2, 1, -2, 0, 1, 0],
  [0, -2, 2, -2, 1, -2, 0, 1, 0],
  [-2, 0, 0, 0, 1, -2, 0, 1, 0],
  [2, 0, 0, 0, 1, 2, 0, -1, 0],
  [3, 0, 0, 0, 0, 2, 0, 0, 0],
  [1, 1, 2, 0, 2, 2, 0, -1, 0],
  [0, 0, 2, 1, 2, 2, 0, -1, 0],
  [1, 0, 0, 2, 1, -1, 0, 0, 0],
  [1, 0, 2, 2, 1, -1, 0, 1, 0],
  [1, 1, 0, -2, 1, -1, 0, 0, 0],
  [0, 1, 0, 2, 0, -1, 0, 0, 0],
  [0, 1, 2, -2, 0, -1, 0, 0, 0],
  [0, 1, -2, 2, 0, -1, 0, 0, 0],
  [1, 0, -2, 2, 0, -1, 0, 0, 0],
  [1, 0, -2, -2, 0, -1, 0, 0, 0],
  [1, 0, 2, -2, 0, -1, 0, 0, 0],
  [1, 0, 0, -4, 0, -1, 0, 0, 0],
  [2, 0, 0, -4, 0, -1, 0, 0, 0],
  [0, 0, 2, 4, 2, -1, 0, 0, 0],
  [0, 0, 2, -1, 2, -1, 0, 0, 0],
  [-2, 0, 2, 4, 2, -1, 0, 1, 0],
  [2, 0, 2, 2, 2, -1, 0, 0, 0],
  [0, -1, 2, 0, 1, -1, 0, 0, 0],
  [0, 0, -2, 0, 1, -1, 0, 0, 0],
  [0, 0, 4, -2, 2, 1, 0, 0, 0],
  [0, 1, 0, 0, 2, 1, 0, 0, 0],
  [1, 1, 2, -2, 2, 1, 0, -1, 0],
  [3, 0, 2, -2, 2, 1, 0, 0, 0],
  [-2, 0, 2, 2, 2, 1, 0, -1, 0],
  [-1, 0, 0, 0, 2, 1, 0, -1, 0],
  [0, 0, -2, 2, 1, 1, 0, 0, 0],
  [0, 1, 2, 0, 1, 1, 0, 0, 0],
  [-1, 0, 4, 0, 2, 1, 0, 0, 0],
  [2, 1, 0, -2, 0, 1, 0, 0, 0],
  [2, 0, 0, 2, 0, 1, 0, 0, 0],
  [2, 0, 2, -2, 1, 1, 0, -1, 0],
  [2, 0, -2, 0, 1, 1, 0, 0, 0],
  [1, -1, 0, -2, 0, 1, 0, 0, 0],
  [-1, 0, 0, 1, 1, 1, 0, 0, 0],
  [-1, -1, 0, 2, 1, 1, 0, 0, 0],
  [0, 1, 0, 1, 0, 1, 0, 0, 0]
]

const TWO_PI = Math.PI * 2
const wrap2pi = (a) => { const r = a % TWO_PI; return r < 0 ? r + TWO_PI : r }

// Delaunay 五角（弧度），T 为 TT 儒略世纪数。r = 360 度。
function delaunay(t) {
  const t2 = t * t, t3 = t2 * t
  return {
    l: wrap2pi((134.96298139 + (1325 * 360 + 198.8673981) * t + 0.0086972 * t2 + 1.78e-5 * t3) * DEG),
    lp: wrap2pi((357.52772333 + (99 * 360 + 359.05034) * t - 0.0001603 * t2 - 3.3e-6 * t3) * DEG),
    f: wrap2pi((93.27191028 + (1342 * 360 + 82.0175381) * t - 0.0036825 * t2 + 3.1e-6 * t3) * DEG),
    d: wrap2pi((297.85036306 + (1236 * 360 + 307.11148) * t - 0.0019142 * t2 + 5.3e-6 * t3) * DEG),
    om: wrap2pi((125.04452222 - (5 * 360 + 134.1362608) * t + 0.0020708 * t2 + 2.2e-6 * t3) * DEG)
  }
}

// 平黄赤交角（弧度）：84381.448" - 46.8150"T - 0.00059"T^2 + 0.001813"T^3
function meanObliquity(t) {
  return (84381.448 - 46.815 * t - 0.00059 * t * t + 0.001813 * t * t * t) * ARCSEC
}

// 章动角与时差方程。eqEq 用 1982 式 dpsi·cos(epsBar)；1997 起的两小项（0.00264"sin Om +
// 0.000063"sin 2Om，合计 <= 0.0027" = LEO 上 9 cm）按任务书口径省略。
function nutationAngles(t) {
  const a = delaunay(t)
  let dpsi = 0, deps = 0
  for (let i = 0; i < NUT80.length; i++) {
    const r = NUT80[i]
    const arg = r[0] * a.l + r[1] * a.lp + r[2] * a.f + r[3] * a.d + r[4] * a.om
    dpsi += (r[5] + r[6] * t) * Math.sin(arg)
    deps += (r[7] + r[8] * t) * Math.cos(arg)
  }
  dpsi *= 1e-4 * ARCSEC
  deps *= 1e-4 * ARCSEC
  const epsBar = meanObliquity(t)
  return { dpsi, deps, epsBar, eps: epsBar + deps, eqEq: dpsi * Math.cos(epsBar), om: a.om }
}

/* ===================== 单步换算 ===================== */
// J2000 -> MOD：R3(-z)·R2(theta)·R3(-zeta)（ESAA 的坐标系旋转约定，与本文件 rot1/2/3 同形），
// 即先绕 z 转 -zeta、再绕 y 转 theta、最后绕 z 转 -z。顺序不可换：zeta 在内、z 在外。
function j2000ToMod(v, t) {
  const p = precessionAngles(t)
  return rot3(rot2(rot3(v, -p.zeta), p.theta), -p.z)
}
function modToJ2000(v, t) {
  const p = precessionAngles(t)
  return rot3(rot2(rot3(v, p.z), -p.theta), p.zeta)
}
// MOD -> TOD：rot1(-eps)·rot3(-dpsi)·rot1(epsBar)
function modToTod(v, t, nu) {
  const n = nu || nutationAngles(t)
  return rot1(rot3(rot1(v, n.epsBar), -n.dpsi), -n.eps)
}
function todToMod(v, t, nu) {
  const n = nu || nutationAngles(t)
  return rot1(rot3(rot1(v, n.eps), n.dpsi), -n.epsBar)
}
// TOD -> TEME：绕 z 转时差方程
const todToTeme = (v, t, nu) => rot3(v, (nu || nutationAngles(t)).eqEq)
const temeToTod = (v, t, nu) => rot3(v, -(nu || nutationAngles(t)).eqEq)
// TEME <-> ECEF：只用 GMST（与 satellite.js eciToEcf 逐字同式）
const temeToEcef = (v, gmst) => rot3(v, gmst)
const ecefToTeme = (v, gmst) => rot3(v, -gmst)

/* ===================== 组合：任意帧 <-> TEME ===================== */
const FRAMES = ['J2000', 'MOD', 'TOD', 'TEME', 'FIXED']
// 外部星历里出现的帧名 -> 本模块的五档。未知返回 ''（调用方点名拒收）。
const FRAME_ALIAS = {
  J2000: 'J2000', EME2000: 'J2000', ICRF: 'J2000', GCRF: 'J2000', INERTIAL: 'J2000',
  MEANOFDATE: 'MOD', MOD: 'MOD', MEANOFEPOCH: 'J2000',
  TRUEOFDATE: 'TOD', TOD: 'TOD',
  TEME: 'TEME', TEMEOFDATE: 'TEME', TEMEOFEPOCH: 'TEME',
  FIXED: 'FIXED', ECEF: 'FIXED', ECF: 'FIXED', EFG: 'FIXED', ITRF: 'FIXED', WGS84: 'FIXED'
}
function normFrame(name) {
  const k = String(name == null ? '' : name).toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (FRAME_ALIAS[k]) return FRAME_ALIAS[k]
  if (/^ITRF\d*$/.test(k) || /^IGS\d+$/.test(k) || /^IGB\d+$/.test(k) || /^ITRF\d+$/.test(k)) return 'FIXED'
  return ''
}

// 位置（km）从任一帧换到 TEME。gmst 由调用方给（省一次 gstime）。
function toTeme(v, frame, t, gmst, nu) {
  const f = normFrame(frame) || 'TEME'
  if (f === 'TEME') return { x: v.x, y: v.y, z: v.z }
  if (f === 'FIXED') return ecefToTeme(v, gmst)
  const n = nu || nutationAngles(t)
  if (f === 'TOD') return todToTeme(v, t, n)
  if (f === 'MOD') return todToTeme(modToTod(v, t, n), t, n)
  return todToTeme(modToTod(j2000ToMod(v, t), t, n), t, n)
}
function fromTeme(v, frame, t, gmst, nu) {
  const f = normFrame(frame) || 'TEME'
  if (f === 'TEME') return { x: v.x, y: v.y, z: v.z }
  if (f === 'FIXED') return temeToEcef(v, gmst)
  const n = nu || nutationAngles(t)
  const tod = temeToTod(v, t, n)
  if (f === 'TOD') return tod
  const mod = todToMod(tod, t, n)
  if (f === 'MOD') return mod
  return modToJ2000(mod, t)
}
// 速度（km/s）：地固系要补地球自转牵连项 omega x r，其余帧只是刚性旋转。
// rEcef 是该刻的地固位置（km）。
function velToTeme(vel, pos, frame, t, gmst, nu) {
  const f = normFrame(frame) || 'TEME'
  if (f !== 'FIXED') return toTeme(vel, frame, t, gmst, nu)
  const withSpin = { x: vel.x - OMEGA_E * pos.y, y: vel.y + OMEGA_E * pos.x, z: vel.z }
  return ecefToTeme(withSpin, gmst)
}
function velFromTeme(vel, posTeme, frame, t, gmst, nu) {
  const f = normFrame(frame) || 'TEME'
  if (f !== 'FIXED') return fromTeme(vel, frame, t, gmst, nu)
  const e = temeToEcef(vel, gmst), r = temeToEcef(posTeme, gmst)
  return { x: e.x + OMEGA_E * r.y, y: e.y - OMEGA_E * r.x, z: e.z }
}

// 便利入口：给 UTC 毫秒，自己算 TT 世纪数与 GMST（gstimeFn 由调用方注入，避免 core/渲染端两份 satellite.js）
function contextAt(utcMs, gstimeFn) {
  const t = T.julianCenturiesTT(utcMs)
  return { t, gmst: gstimeFn(T.jdFromMs(utcMs)), nu: nutationAngles(t) }
}

module.exports = {
  ARCSEC, OMEGA_E, FRAMES, NUT80,
  rot1, rot2, rot3,
  precessionAngles, delaunay, meanObliquity, nutationAngles,
  j2000ToMod, modToJ2000, modToTod, todToMod, todToTeme, temeToTod, temeToEcef, ecefToTeme,
  normFrame, toTeme, fromTeme, velToTeme, velFromTeme, contextAt
}
