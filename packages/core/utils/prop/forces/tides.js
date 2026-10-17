// 固体地球潮汐（IERS Conventions 2010 §6.2 第一步，频率无关的名义 Love 数），纯 CommonJS。
//
// 【公式】日（j = 3）、月（j = 2）引潮引起的位系数变化（IERS 2010 式 (6.6)、(6.7)）：
//   ΔC̄nm − iΔS̄nm = k_nm/(2n+1) · Σ_j (GM_j/GM⊕)(R⊕/r_j)^(n+1) · P̄nm(sin Φ_j) · e^(−imλ_j)     n = 2, 3
//   ΔC̄4m − iΔS̄4m = k⁽⁺⁾_2m/5   · Σ_j (GM_j/GM⊕)(R⊕/r_j)³     · P̄2m(sin Φ_j) · e^(−imλ_j)     m = 0, 1, 2
//   Φ_j、λ_j 为日 / 月在地固系的地心纬度与东经，P̄nm 为与重力场同口径的完全归一化缔合勒让德函数。
//   复数 Love 数 k = k_R + i·k_I 展开：记 A = Σ f_j P̄ cos mλ_j，B = Σ f_j P̄ sin mλ_j，则
//     ΔC̄ = (k_R·A + k_I·B)/(2n+1)，ΔS̄ = (k_R·B − k_I·A)/(2n+1)。
//   名义 Love 数（IERS 2010 表 6.3，滞弹性地球）：
//     k20 = 0.30190，k21 = 0.29830 − 0.00144i，k22 = 0.30102 − 0.00130i；
//     k⁽⁺⁾20 = −0.00089，k⁽⁺⁾21 = −0.00080，k⁽⁺⁾22 = −0.00057；k30 = k31 = k32 = 0.093，k33 = 0.094。
// 【永久潮汐】式 (6.6) 的 ΔC̄20 含时间平均部分 ΔC̄20perm = A0·H0·k20 = −4.2007e-9（式 (6.13)）。重力场若是
//   zero-tide（gravity.js 缺省），该部分已在 C̄20 里，须从潮汐里扣掉（IERS 2010 §6.2.2）；tide-free 场则不扣。
//   由 centralTideSystem 指定，须与所用重力场的 tideSystem 一致。
// 【未含】第二步频率相关修正（表 6.5a–c；最大项 K1 对 ΔC̄21/ΔS̄21 约 4.7e-10 —— K1 频率靠近自由核章动共振，
//   k21 在该频率比名义值小约 14%，而周日带在惯性系里近乎不动，对 LEO 是长期项）、固体极潮（式 6.22，需极移，
//   平台不带 EOP）、海潮（§6.3）。
// 【精度（Orekit 13.1.9 对拍，450 km / 51.6° LEO，7 天）】与 Orekit 只开第一步（LoveNumbers 构造）逐项一致：6 mm；
//   与 Orekit 的 IERS 2010 全模型（第一步 + 第二步 + 极潮）差 19 m —— 即上述未含项的量级；潮汐总效应约 60 m。
//
// 接口：createSolidTides({ ephemeris, earthRotation, gm, ae, centralTideSystem }) → {
//   acceleration(tMs, r) → [ax,ay,az]（km/s²，J2000）, deltaCS(tMs) → { C, S }（三角下标 n ≤ 4）
// }

'use strict'

const ER = require('../earthRotation.js')
const EPH = require('../ephemeris.js')
const G = require('./gravity.js')
const TB = require('./thirdBody.js')

const K2 = [[0.30190, 0], [0.29830, -0.00144], [0.30102, -0.00130]]   // [Re, Im]
const K2P = [-0.00089, -0.00080, -0.00057]
const K3 = [0.093, 0.093, 0.093, 0.094]
const tri = (n, m) => n * (n + 1) / 2 + m

// 完全归一化 P̄nm(sin φ)，n ≤ 3（与 gravity.js 同一递推）
function pbar3(s, c) {
  const P = new Float64Array(10)
  P[0] = 1
  P[tri(1, 1)] = Math.sqrt(3) * c
  P[tri(2, 2)] = Math.sqrt(5 / 4) * c * P[tri(1, 1)]
  P[tri(3, 3)] = Math.sqrt(7 / 6) * c * P[tri(2, 2)]
  for (let m = 0; m <= 3; m++) {
    if (m + 1 <= 3) P[tri(m + 1, m)] = Math.sqrt(2 * m + 3) * s * P[tri(m, m)]
    for (let n = m + 2; n <= 3; n++) {
      const a = Math.sqrt((4 * n * n - 1) / ((n - m) * (n + m)))
      const b = Math.sqrt((2 * n + 1) * (n + m - 1) * (n - m - 1) / ((2 * n - 3) * (n - m) * (n + m)))
      P[tri(n, m)] = a * s * P[tri(n - 1, m)] - b * P[tri(n - 2, m)]
    }
  }
  return P
}

function createSolidTides(opts) {
  const o = opts || {}
  const eph = o.ephemeris || EPH.analyticEphemeris()
  const er = o.earthRotation || ER.createEarthRotation()
  const egm = G.loadEgm2008()
  const gm = o.gm > 0 ? o.gm : egm.gm
  const ae = o.ae > 0 ? o.ae : egm.ae
  const system = o.centralTideSystem || 'zero-tide'
  if (system !== 'zero-tide' && system !== 'tide-free') throw new Error('centralTideSystem 只认 zero-tide / tide-free')
  const ratios = { moon: (o.gmMoon || TB.GM_MOON) / gm, sun: (o.gmSun || TB.GM_SUN) / gm }
  // 4×4 的「潮汐场」：系数每次现填，不含中心项
  const zero = { C: new Float64Array(15), S: new Float64Array(15), nmax: 4, gm, ae, tideSystem: 'tide-free' }
  const field = G.createGravityField({ degree: 4, order: 4, coeffs: zero, tideSystem: 'tide-free', includeCentral: false, gm, ae })

  function deltaCS(tMs) {
    const M = er.m(tMs)
    const C = field.C, S = field.S
    C.fill(0); S.fill(0)
    for (const body of ['moon', 'sun']) {
      const rb = ER.mulMV(M, eph[body](tMs))
      const rr = Math.hypot(rb[0], rb[1], rb[2]), rho = Math.hypot(rb[0], rb[1])
      const s = rb[2] / rr, c = rho / rr
      const cl = rb[0] / rho, sl = rb[1] / rho
      const P = pbar3(s, c)
      const q = ratios[body] * ae / rr
      const f2 = q * (ae / rr) * (ae / rr), f3 = f2 * (ae / rr)
      let cm = 1, sm = 0      // cos mλ、sin mλ（逐次倍角）
      for (let m = 0; m <= 3; m++) {
        if (m <= 2) {
          const A = f2 * P[tri(2, m)] * cm, B = f2 * P[tri(2, m)] * sm
          const k = K2[m]
          C[tri(2, m)] += (k[0] * A + k[1] * B) / 5
          S[tri(2, m)] += (k[0] * B - k[1] * A) / 5
          C[tri(4, m)] += K2P[m] * A / 5
          S[tri(4, m)] += K2P[m] * B / 5
        }
        const A3 = f3 * P[tri(3, m)] * cm, B3 = f3 * P[tri(3, m)] * sm
        C[tri(3, m)] += K3[m] * A3 / 7
        S[tri(3, m)] += K3[m] * B3 / 7
        const cn = cm * cl - sm * sl, sn = sm * cl + cm * sl
        cm = cn; sm = sn
      }
    }
    if (system === 'zero-tide') C[tri(2, 0)] -= G.DC20_PERM
    S[tri(2, 0)] = 0; S[tri(3, 0)] = 0; S[tri(4, 0)] = 0
    return { C, S }
  }

  return {
    deltaCS,
    acceleration(tMs, r) {
      deltaCS(tMs)
      const M = er.m(tMs)
      return ER.mulTV(M, field.accelerationFixed(ER.mulMV(M, r)))
    }
  }
}

module.exports = { createSolidTides, K2, K2P, K3 }
