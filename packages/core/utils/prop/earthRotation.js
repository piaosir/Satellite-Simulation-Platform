// J2000（EME2000）↔ 地固系的旋转矩阵（纯 CommonJS），供重力场 / 大气 / 固体潮用。
//
// 【复用 frames.js（只读）】岁差角 precessionAngles（IAU-76）、章动 nutationAngles（IAU-80 106 项，时差方程取
//   1982 式 Δψ·cos ε̄）都直接调 frames.js；旋转约定与其 rot1/rot2/rot3（坐标系旋转）逐式一致：
//     M = R3(GMST) · R3(EqEq) · N · P
//     P = R3(−z)·R2(θ)·R3(−ζ)          （j2000ToMod）
//     N = R1(−ε)·R3(−Δψ)·R1(ε̄)          （modToTod）
//     R3(EqEq)                          （todToTeme）
//     R3(GMST)                          （temeToEcef）
//   即 frames.js 的 J2000 → MOD → TOD → TEME → FIXED 链合成一个矩阵（测试逐点对拍）。地固系 = frames.js 的 FIXED：
//   PEF（伪地固），不含极移。
// 【GMST】IAU-82：GMST(s) = 67310.54841 + (876600·3600 + 8640184.812866)·Tu + 0.093104·Tu² − 6.2e-6·Tu³，
//   Tu = UT1 儒略世纪数（与 vendor/satellite.js 的 gstime 同式；Vallado 4th ed. 式 3-45）。UT1 取 UTC（frames.js 口径）。
//   这里把 876600·3600·Tu 拆成 86400·（J2000 起整日数 + 日内部分），只用日内部分，免掉 JD ≈ 2.46e6 的双精度
//   量化（gstime 那条路约 40 µs，即 3e-9 rad）。
// 【忽略项及上限】dUT1（≤ 0.9 s ⇒ 经向 ≤ 6.6e-5 rad）、极移（≤ 0.3″）、EOP 的 δΔψ/δε、1997 起时差方程的两个
//   小项（≤ 0.0027″）——与 frames.js 头注同口径。对力模型它们只是把重力场 / 大气绕地轴转一个小角；输出位置在
//   J2000 里，不受地固系精度的直接影响。
// 【缓存】Q = R3(EqEq)·N·P（J2000→TEME）变化率 ≤ 1e-11 rad/s，按 cacheStepSec（缺省 3600 s）的网格节点精确计算、
//   节点间对 9 个元素线性插值：二阶项误差 ≤ ψ''·h²/8 ≈ 3e-17 rad/s² × 1.6e6 s² ≈ 5e-11 rad。GMST 每次现算。
//
// 接口：createEarthRotation(opts) → {
//   q(tMs) → Float64Array(9)       J2000→TEME（行主序）
//   m(tMs) → Float64Array(9)       J2000→地固（行主序）
//   toFixed(tMs, r) / toJ2000(tMs, rFixed) → [x,y,z]
//   omegaJ2000(tMs) → [wx,wy,wz]   地球自转角速度矢量（J2000 分量，rad/s）
// }
// 另导出 gmst82(tMs)、precNut(tMs)（不缓存的 Q）、矩阵小工具 rotX/rotY/rotZ/matMul/mulMV/mulTV。

'use strict'

const F = require('../frames.js')
const T = require('../timeSystems.js')

const TWO_PI = 2 * Math.PI
const J2000_MS = Date.UTC(2000, 0, 1, 12, 0, 0)       // JD 2451545.0 的「读数毫秒」
const DAY_MS = 86400000
const OMEGA_E = F.OMEGA_E                             // 7.2921158553e-5 rad/s（frames.js 同值）

/* ===================== 3×3 矩阵（行主序 Float64Array(9)）：坐标系旋转，与 frames.js 同号 ===================== */
function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return Float64Array.of(1, 0, 0, 0, c, s, 0, -s, c) }
function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return Float64Array.of(c, 0, -s, 0, 1, 0, s, 0, c) }
function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return Float64Array.of(c, s, 0, -s, c, 0, 0, 0, 1) }
function matMul(A, B) {
  const C = new Float64Array(9)
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j]
  }
  return C
}
function mulMV(M, v) {
  return [M[0] * v[0] + M[1] * v[1] + M[2] * v[2], M[3] * v[0] + M[4] * v[1] + M[5] * v[2], M[6] * v[0] + M[7] * v[1] + M[8] * v[2]]
}
// Mᵀ·v
function mulTV(M, v) {
  return [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]]
}

/* ===================== GMST（IAU-82，UT1 = UTC） ===================== */
function gmst82(tMs) {
  const days = (tMs - J2000_MS) / DAY_MS
  const tu = days / 36525
  const frac = days - Math.floor(days)
  // 67310.54841 s 与 86400·整日数 mod 86400 相消后的日内秒数
  let sec = 67310.54841 + 86400 * frac + (8640184.812866 + (0.093104 - 6.2e-6 * tu) * tu) * tu
  sec = sec % 86400
  if (sec < 0) sec += 86400
  return sec * (TWO_PI / 86400)
}

/* ===================== 岁差章动（不缓存） ===================== */
function precNut(tMs) {
  const t = T.julianCenturiesTT(tMs)
  const p = F.precessionAngles(t)
  const n = F.nutationAngles(t)
  const P = matMul(rotZ(-p.z), matMul(rotY(p.theta), rotZ(-p.zeta)))
  const N = matMul(rotX(-n.eps), matMul(rotZ(-n.dpsi), rotX(n.epsBar)))
  return matMul(rotZ(n.eqEq), matMul(N, P))
}

function createEarthRotation(opts) {
  const o = opts || {}
  const stepMs = (o.cacheStepSec > 0 ? o.cacheStepSec : 3600) * 1000
  const nodes = new Map()
  const node = (k) => {
    let q = nodes.get(k)
    if (!q) {
      if (nodes.size > 4096) nodes.clear()
      q = precNut(k * stepMs)
      nodes.set(k, q)
    }
    return q
  }
  const qBuf = new Float64Array(9)
  // 同一时刻连续多次取（重力 / 大气 / 潮汐各取一次）只算一回
  let lastT = NaN, lastQ = null, lastM = null
  function q(tMs) {
    if (tMs === lastT && lastQ) return lastQ
    const x = tMs / stepMs
    const k = Math.floor(x), w = x - k
    const a = node(k), b = node(k + 1)
    for (let i = 0; i < 9; i++) qBuf[i] = a[i] + (b[i] - a[i]) * w
    lastT = tMs; lastQ = Float64Array.from(qBuf); lastM = null
    return lastQ
  }
  function m(tMs) {
    const Q = q(tMs)
    if (lastM) return lastM
    lastM = matMul(rotZ(gmst82(tMs)), Q)
    return lastM
  }
  return {
    q, m,
    toFixed: (tMs, r) => mulMV(m(tMs), r),
    toJ2000: (tMs, r) => mulTV(m(tMs), r),
    // ω 沿 TEME / PEF 的 z 轴（= TOD 真天极）；J2000 分量 = Qᵀ·(0, 0, ω) = ω·（Q 的第三行）
    omegaJ2000: (tMs) => { const Q = q(tMs); return [OMEGA_E * Q[6], OMEGA_E * Q[7], OMEGA_E * Q[8]] }
  }
}

module.exports = { createEarthRotation, gmst82, precNut, rotX, rotY, rotZ, matMul, mulMV, mulTV, OMEGA_E, J2000_MS }
