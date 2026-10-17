// ITU-R P.682-4（08/2022，现行版）航空移动卫星业务 —— 海面反射多径衰落（纯函数，CommonJS）。
//
// 实现 Annex 1 §4.2.1「Dependence on antenna height and antenna gain」的工程估算方法：
//   Step 1  镜面反射点与地平线的掠射角：θ_sp = 2γ_sp + θ_i，γ_sp = 7.2×10⁻³·H_a/tan θ_i（度，H_a 千米），
//           θ_hr = arccos[R_e/(R_e + H_a)]，R_e = 6371 km                                  式 (2a)(2b)
//   Step 2  主瓣方向图 G(θ) = −4×10⁻⁴·(10^(G_m/10) − 1)·θ²（dB），在 θ = θ_i + (θ_sp + θ_hr)/2 处取值   式 (1)
//   Step 3  海面菲涅尔反射系数 R_H / R_V / R_C = (R_H + R_V)/2，η = ε_r − j60λσ                  式 (3a)–(3c)
//   Step 4  修正 C_θ = 0（θ_sp ≥ 7°）或 (θ_sp − 7)/2（θ_sp < 7°）                                 式 (4)
//   Step 5  地球曲率发散因子 D = −10lg[1 + 2 sin γ_sp/(cos θ_sp·sin(γ_sp + θ_i))]                  式 (5)
//   Step 6  非相干反射功率（相对直射波）P_r = G + R + C_θ + D，R = 20lg|R_i|                       式 (6)
//   Step 7  衰落深度 F_d(p) = −[A + 10lg(1 + 10^(P_r/10))]                                         式 (7)
//           A = Figure 1（总功率恒为 0 dB 的 Nakagami-Rice 分布，参数 α = 多径功率/总功率
//           = 10^(P_r/10)/(1 + 10^(P_r/10))）上「(100 − p)% 时间被超过」的电平。
//   本实现不读图：Figure 1 就是莱斯分布，直射功率 1 − α、漫射功率 α，A 由 numeric.riceCdf 精确反解。
//
// ★ 菲涅尔系数的入射角：原文 Step 3 式 (3) 写的是仰角 θ_i（P.682-3 起一直如此），缺省照此。
//   但 Figure 2（1.54 GHz、圆极化、H_a = 10 km）按 θ_i 复算，在 3°–5° 比图高 1.0–1.7 dB，9° 以上才贴合；
//   改用镜面反射点处的本地掠射角 θ_i + γ_sp（球面地球几何）复算，全段与图差 ≤ 0.45 dB（均方根 0.2 dB）。
//   传 { fresnelAngle: 'grazing' } 即用后者；缺省 'elev' 是原文文字口径。低仰角（< 8°）两者差别才明显。
//
// 适用范围（原文 Applicable range）：频率 1–2 GHz；θ_i ≥ 3° 且 G(1.5θ_i) ≥ −10 dB；
// 圆极化 / 水平极化，垂直极化仅 θ_i ≥ 8°；海况：浪高 1–3 m（非相干分量充分发展）。
// 超出范围缺省返回 null；传 { allowOutOfRange: true } 照算，结果带 applicable = false 与原因码。
//
// 海水介电常数：原文让查 ITU-R P.527。此处按现行 P.527-6（09/2021）§5.1.2 式 (8)–(27) 计算
// （温度 T、盐度 S 的函数），缺省 T = 20 °C、S = 35 g/kg（P.527-6 Figure 2 的海水条件）；
// 也可直接给 { eta: { re, im } }（η = re − j·im）或 { epsR, sigmaSm } 覆盖。
// 注意：P.527-6 的 ε″ 已含电导项 18σ/f_GHz（= 60λσ），所以 η = ε′ − jε″，不再另加电导。
//
// 另附 §4.3 / §4.4 的实测典型值（Table 1 海面、Table 2 陆面）作参考常量。
// 未实现：§4.5 着陆进近段的多径信道（面向导航的时间序列生成模型，含机型多项式与马尔可夫地面回波）。
//
// 原文：https://www.itu.int/rec/R-REC-P.682-4-202208-I/en

const { riceCdf, brentRoot, num } = require('./numeric.js')

const R_E_KM = 6371
const DEG = Math.PI / 180

// ---------- 复数小工具（只用在菲涅尔系数里）----------
const C = (re, im) => ({ re, im })
const cAdd = (a, b) => C(a.re + b.re, a.im + b.im)
const cSub = (a, b) => C(a.re - b.re, a.im - b.im)
const cDiv = (a, b) => {
  const d = b.re * b.re + b.im * b.im
  return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d)
}
const cAbs = (a) => Math.hypot(a.re, a.im)
function cSqrt(a) {                       // 主值分支（实部 ≥ 0）
  const r = cAbs(a)
  const re = Math.sqrt((r + a.re) / 2)
  const im = Math.sqrt(Math.max(0, (r - a.re) / 2))
  return C(re, a.im < 0 ? -im : im)
}

/**
 * ITU-R P.527-6 §5.1.2 海水复相对介电常数 ε_sw = ε′ − jε″（式 14–27）。
 * 适用 −4 °C ≤ T ≤ 40 °C、0 ≤ S ≤ 40 g/kg（§5.1）；S = 0 即纯水（§5.1.1 式 5–13）。
 * @returns {null | {epsReal, epsImag, sigmaSm}}  sigmaSm = 式 (22) 的电导率（S/m）
 */
function seaWaterPermittivity(fGHz, tempC, salinity) {
  const f = num(fGHz)
  const T = tempC == null ? 20 : num(tempC)
  const S = salinity == null ? 35 : num(salinity)
  if (f === null || T === null || S === null || !(f > 0) || T < -4 || T > 40 || S < 0 || S > 40) return null
  const th = 300 / (T + 273.15) - 1                                   // (11)
  const es = 77.66 + 103.3 * th                                       // (8)
  const e1 = 0.0671 * es                                              // (9)
  const einf = 3.52 - 7.52 * th                                       // (10)
  const f1 = 20.20 - 146.4 * th + 316 * th * th                       // (12)
  const f2 = 39.8 * f1                                                // (13)
  const ess = es * Math.exp(-3.33330e-3 * S + 4.74868e-6 * S * S)    // (17)
  const f1s = f1 * (1 + S * (2.3232e-3 - 7.9208e-5 * T + 3.6764e-6 * T * T +
    3.5594e-7 * T * T * T + 8.9795e-9 * T * T * T * T))               // (18)
  const e1s = e1 * Math.exp(-6.28908e-3 * S + 1.76032e-4 * S * S - 9.22144e-5 * T * S)   // (19)
  const f2s = f2 * (1 + S * (-1.99723e-2 + 1.81176e-4 * T))           // (20)
  const einfs = einf * (1 + S * (-2.04265e-3 + 1.57883e-4 * T))       // (21)
  const sig35 = 2.903602 + 8.607e-2 * T + 4.738817e-4 * T * T - 2.991e-6 * T * T * T + 4.3047e-9 * T * T * T * T  // (23)
  const r15 = S * (37.5109 + 5.45216 * S + 1.4409e-2 * S * S) / (1004.75 + 182.283 * S + S * S)                  // (24)
  const a0 = (6.9431 + 3.2841 * S - 9.9486e-2 * S * S) / (84.850 + 69.024 * S + S * S)                          // (26)
  const a1 = 49.843 - 0.2276 * S + 0.198e-2 * S * S                    // (27)
  const rt15 = 1 + a0 * (T - 15) / (a1 + T)                            // (25)
  const sigma = sig35 * r15 * rt15                                     // (22)
  const u1 = f / f1s, u2 = f / f2s
  const epsReal = (ess - e1s) / (1 + u1 * u1) + (e1s - einfs) / (1 + u2 * u2) + einfs                   // (15)
  const epsImag = u1 * (ess - e1s) / (1 + u1 * u1) + u2 * (e1s - einfs) / (1 + u2 * u2) + 18 * sigma / f   // (16)
  return { epsReal, epsImag, sigmaSm: sigma }
}

// η：优先 opts.eta，其次 opts.epsR + opts.sigmaSm（η = ε_r − j60λσ），否则按 P.527-6 算海水
function etaOf(fGHz, o) {
  if (o.eta) {
    const re = num(o.eta.re), im = num(o.eta.im)
    return re === null || im === null ? null : C(re, -Math.abs(im))
  }
  if (o.epsR != null || o.sigmaSm != null) {
    const er = num(o.epsR), sg = num(o.sigmaSm)
    if (er === null || sg === null) return null
    const lambda = 0.299792458 / fGHz
    return C(er, -60 * lambda * sg)
  }
  const sw = seaWaterPermittivity(fGHz, o.seaTempC, o.salinity)
  return sw ? C(sw.epsReal, -sw.epsImag) : null
}

/** 式 (3a)–(3c)：海面菲涅尔反射系数（复数）。θ_i 用的是仰角（原文如此）。 */
function fresnelCoefficients(elevDeg, eta) {
  const s = Math.sin(elevDeg * DEG), c2 = Math.cos(elevDeg * DEG) ** 2
  const root = cSqrt(cSub(eta, C(c2, 0)))
  const S = C(s, 0)
  const rh = cDiv(cSub(S, root), cAdd(S, root))                       // (3a)
  const rootV = cDiv(root, eta)                                        // √(η − cos²θ)/η
  const rv = cDiv(cSub(S, rootV), cAdd(S, rootV))                     // (3b)
  const rc = C((rh.re + rv.re) / 2, (rh.im + rv.im) / 2)              // (3c)
  return { rh, rv, rc }
}

/** 式 (1)：主瓣相对增益（dB）。 */
function relativeGainDb(gainDbi, thetaDeg) {
  return -4e-4 * (Math.pow(10, gainDbi / 10) - 1) * thetaDeg * thetaDeg
}

/**
 * Step 1–6：非相干海面反射功率 P_r（dB，相对直射波）与各中间量。
 * @param {object} a
 *   fGHz, elevDeg（θ_i）, heightKm（H_a）, gainDbi（G_m）, pol 'circular' | 'horizontal' | 'vertical'（缺省圆极化）
 *   eta | {epsR, sigmaSm} | {seaTempC, salinity}（海面电参数，见文件头）
 *   fresnelAngle 'elev'（缺省，原文 θ_i）| 'grazing'（θ_i + γ_sp，贴合 Figure 2，见文件头）
 *   allowOutOfRange
 * @returns {null | {pr, G, R, c0, D, thetaSp, thetaHr, gammaSp, thetaG, eta:{re,im}, applicable, reasons}}
 */
function multipathPower(a) {
  const o = a || {}
  const f = num(o.fGHz), th = num(o.elevDeg), ha = num(o.heightKm), gm = num(o.gainDbi)
  const pol = o.pol == null ? 'circular' : String(o.pol)
  const fAngMode = o.fresnelAngle == null ? 'elev' : String(o.fresnelAngle)
  if (f === null || th === null || ha === null || gm === null) return null
  if (!(f > 0) || !(th > 0 && th < 90) || !(ha > 0) || ['circular', 'horizontal', 'vertical'].indexOf(pol) < 0) return null
  if (fAngMode !== 'elev' && fAngMode !== 'grazing') return null
  const eta = etaOf(f, o)
  if (!eta) return null
  const reasons = []
  if (f < 1 || f > 2) reasons.push('freq')
  if (th < 3) reasons.push('elev')
  if (relativeGainDb(gm, 1.5 * th) < -10) reasons.push('gainRolloff')
  if (pol === 'vertical' && th < 8) reasons.push('vpolElev')
  const applicable = reasons.length === 0
  if (!applicable && !o.allowOutOfRange) return null
  const gammaSp = 7.2e-3 * ha / Math.tan(th * DEG)                     // 度
  const thetaSp = 2 * gammaSp + th                                     // (2a)
  const thetaHr = Math.acos(R_E_KM / (R_E_KM + ha)) / DEG              // (2b)
  const thetaG = th + (thetaSp + thetaHr) / 2
  const G = relativeGainDb(gm, thetaG)                                 // Step 2，式 (1)
  const fc = fresnelCoefficients(fAngMode === 'grazing' ? th + gammaSp : th, eta)
  const ri = pol === 'horizontal' ? fc.rh : (pol === 'vertical' ? fc.rv : fc.rc)
  const R = 20 * Math.log10(cAbs(ri))
  const c0 = thetaSp >= 7 ? 0 : (thetaSp - 7) / 2                      // (4)
  const D = -10 * Math.log10(1 + 2 * Math.sin(gammaSp * DEG) /
    (Math.cos(thetaSp * DEG) * Math.sin((gammaSp + th) * DEG)))         // (5)
  return {
    pr: G + R + c0 + D,                                                // (6)
    G, R, c0, D, thetaSp, thetaHr, gammaSp, thetaG,
    eta: { re: eta.re, im: -eta.im }, applicable, reasons
  }
}

/**
 * Figure 1：总功率恒为 0 dB 的 Nakagami-Rice 分布上，被超过 pExceededPct% 时间的电平（dB）。
 * α = 多径功率 / 总功率（0 < α ≤ 1）。直射功率 1 − α、漫射功率 α。
 */
function nakagamiRiceLevelDb(alpha, pExceededPct) {
  const al = num(alpha), pe = num(pExceededPct)
  if (al === null || pe === null || !(al > 0 && al <= 1) || !(pe > 0 && pe < 100)) return null
  const a = Math.sqrt(1 - al), target = 1 - pe / 100                // P(电平 ≤ A) = 1 − 超过概率
  const F = (uDb) => riceCdf(Math.pow(10, uDb / 20), a, al) - target
  return brentRoot(F, -120, 20, 1e-9)
}

/**
 * 式 (7)：时间百分比 p 下被超过的衰落深度 F_d(p)（dB，正 = 低于直射波电平）。
 * 「(1 − p)% 时间被超过的接收电平」即 Figure 1 上横坐标 (100 − p)% 的读数 A。
 * @param {number} pPercent 0 < p < 100（如 1 → 99% 时间的余量）
 * @param {object} a 同 multipathPower
 * @returns {null | {fadeDb, A, alpha, pr, applicable, reasons, detail}}
 */
function fadeDepthDb(pPercent, a) {
  const p = num(pPercent)
  if (p === null || !(p > 0 && p < 100)) return null
  const mp = multipathPower(a)
  if (!mp) return null
  const lin = Math.pow(10, mp.pr / 10)
  const alpha = lin / (1 + lin)
  const A = nakagamiRiceLevelDb(alpha, 100 - p)
  if (A === null) return null
  return {
    fadeDb: -(A + 10 * Math.log10(1 + lin)),
    A, alpha, pr: mp.pr, applicable: mp.applicable, reasons: mp.reasons, detail: mp
  }
}

// ---------- §4.3 Table 1 / §4.4 Table 2：实测多径参数（典型值）----------
// 海面（Table 1，1.5–1.6 GHz 测量 + 解析模型补充）；typical 按 8° / 15° / 30° 仰角
const OCEAN_MULTIPATH = {
  normPowerDb: {
    horizontal: { range: [-5.5, -0.5], typical: { 8: -2.5, 15: -1, 30: -1.5 } },
    vertical: { range: [-15, -2.5], typical: { 8: -14.5, 15: -9, 30: -3.5 } }
  },
  delaySpreadUs: {                      // 双边
    db3: { range: [0.25, 1.8], typical: { 8: 0.6, 15: 0.8, 30: 0.8 } },
    db10: { range: [2.2, 5.6], typical: { 8: 2.8, 15: 3.2, 30: 3.2 } }
  },
  corrBandwidthKHz: { db3: { range: [70, 380], typical: { 8: 160, 15: 200, 30: 200 } } },   // 单边
  dopplerSpreadHz: {                    // 双边；8° 的第二个数是飞机 10 km、1 000 km/h 的模型值（脚注 3）
    inPlane: {
      db3: { range: [14, 190], typical: { 8: 45, 15: 70, 30: 140 } },
      db10: { range: [13, 350], typical: { 8: 44, 15: 180, 30: 350 }, model8: 40 }
    },
    crossPlane: {
      db3: { range: [179, 240], typical: { 8: 179, 15: 110, 30: 190 } },
      db10: { range: [180, 560], typical: { 8: 180, 15: 280, 30: 470 }, model8: 180 }
    }
  },
  decorrTimeMs: { db3: { range: [1.3, 10], typical: { 8: 7.5, 15: 3.2, 30: 2.2 } } }   // 单边
}
// 陆面（Table 2；与仰角无稳定关系，只给一个典型值）
const LAND_MULTIPATH = {
  normPowerDb: { horizontal: { range: [-18, 2], typical: -9 }, vertical: { range: [-21, -3], typical: -13 } },
  delaySpreadUs: { db3: { range: [0.1, 1.2], typical: 0.3 }, db10: { range: [0.2, 3.2], typical: 1.2 } },
  corrBandwidthKHz: { db3: { range: [150, 3000], typical: 600 } },
  dopplerSpreadHz: { db3: { range: [20, 140], typical: 260 }, db10: { range: [40, 500], typical: 200 } },
  decorrTimeMs: { db3: { range: [1, 10], typical: 4 } }
}

module.exports = {
  R_E_KM, OCEAN_MULTIPATH, LAND_MULTIPATH,
  seaWaterPermittivity, fresnelCoefficients, relativeGainDb, multipathPower, nakagamiRiceLevelDb, fadeDepthDb
}
