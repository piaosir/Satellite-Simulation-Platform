// ITU-R P.372-18（09/2026）无线电噪声 —— 手持 / 物联网终端的噪声环境（纯函数，CommonJS）。
//
// 收这几样：
//   ① 室外人为噪声 Fam = c − d·lg f（§6.1.1 式 17，Table 1：城市 / 居民区 / 乡村 / 安静乡村 / 银河）
//      与时间、位置的十分位偏差（Table 2）；
//   ② 银河噪声 Fam = 52 − 23 lg f（§4.1 式 15）与 408 MHz 天空图的频率外推（式 16）；
//   ③ 噪声系数 / 噪声温度 / 噪声功率的换算（§1.2 式 1–6、9）与多源噪声合成（§7.1 式 31–39）；
//   ④ 地面站的天空亮温（§3.1 式 10–11，T_mr 系数取建议书附带数据文件 Tmr_approx.txt，见 p372Tmr.js）；
//   ⑤ 室内人为噪声统计模型（§6.2 式 18–30、Table 3，80 MHz–2 GHz）—— P.372-18 新增，-17 版这一节只有两行实测；
//   ⑥ 0 dBi 手持终端的天线噪温口径，对照 TR 38.821 Table 6.1.1.1-3 对手持取 T_a = 290 K 的假设。
//
// ★ 第 ⑥ 项的口径（工程模型，不是 P.372 原文的一个公式，假设全部摆在参数里）：
//   T_a = η_sky·T̄_sky + (1 − η_sky)·T_gnd + T_mm + T_gal
//     · η_sky：方向图落在天空半球的份额，0 dBi 全向手持缺省 0.5；
//     · T̄_sky：式 (10) 天空亮温按 cos(仰角) 加权的上半球平均；斜路径衰减 = 天顶衰减 × 大气质量，
//       大气质量取 P.676 Annex 2 低仰角式的形状函数 F(x)（等效高度缺省 6 km、等效地球半径 8 500 km），
//       天顶衰减缺省 0.04 dB（P.676 标准大气在 1–3 GHz 的量级；TR 38.821 Table 6.1.3.3-1 的 S 频段
//       大气损耗 0.2 dB@12.5° / 0.1 dB@30° 反推也是 0.04–0.05 dB）；
//     · T_gnd = ε·T_phys + (1 − ε)·T̄_sky（§3.2 式 14 的形式），缺省 ε = 0.9、T_phys = 290 K
//       （Fig. 8：1.43 GHz 光滑地面亮温，干土约 275–283 K、含水 25% 约 135–180 K）；
//     · T_mm：人为噪声 = T₀·10^(F_a/10)（式 9）。室外按 Table 1 式 (17)；该式只在 0.3–250 MHz 有效，
//       用到 L / S 频段属外推（结果 manMadeExtrapolated = true）。室内按 §6.2（≤ 2 GHz 有效）；
//     · T_gal：式 (15) 的银河噪声（「for a vertical antenna」，即地面天线口径）；式 (15) 原文只写到约 100 MHz，
//       GHz 段属外推（Fig. 3 曲线 B 同一量级：2 GHz 约 2–3 K）。
//     · 室内（manMade = 'indoor'）：方向图被室温墙体 / 天花板占满，缺省 η_sky = 0、ε = 1，热噪声底 = T_phys；
//       卫星信号穿墙进来要扣的建筑物进入损耗（P.2109）不在本文件（terrestrial/ 模块）。
//   人体（头、手）近场对方向图和噪温的影响不在内（P.681 §4.3 只给示意，没有可用公式）。
//   G/T 按 TR 38.821 式 (6.1.3.1-3) / TR 38.811 Table 4.4-1 NOTE 1：G/T = G_a − NF − 10lg(T₀ + (T_a − T₀)·10^(−NF/10))。
//
// 原文：https://www.itu.int/rec/R-REC-P.372-18-202609-I/en

const { TMR_APPROX } = require('./p372Tmr.js')
const { normCdf, brentRoot, integrate, num } = require('./numeric.js')

const T0 = 290                    // 参考温度（§1.2.1）
const KT0_DBW_HZ = -204           // 式 (6) 里的 −204 = 10lg(kT₀)，原文取整数

// ===== Table 1：Fam = c − d·lg f（f 单位 MHz）=====
// 有效频段：A/B/C（城市 / 居民区 / 乡村）0.3–250 MHz（§6.1.1）；D（安静乡村）、E（银河）以 Figure 39
// 上画出的线段为准：D 约 0.3–30 MHz，E 约 10–250 MHz。
const MANMADE_CD = {
  city: { c: 76.8, d: 27.7, curve: 'A', rangeMHz: [0.3, 250] },
  residential: { c: 72.5, d: 27.7, curve: 'B', rangeMHz: [0.3, 250] },
  rural: { c: 67.2, d: 27.7, curve: 'C', rangeMHz: [0.3, 250] },
  quietRural: { c: 53.6, d: 28.6, curve: 'D', rangeMHz: [0.3, 30] },
  galactic: { c: 52.0, d: 23.0, curve: 'E', rangeMHz: [10, 250] }
}

// ===== Table 2：人为噪声的十分位偏差（dB）=====
const MANMADE_DECILES = {
  city: { timeUpper: 11.0, timeLower: 6.7, location: 8.4 },
  residential: { timeUpper: 10.6, timeLower: 5.3, location: 5.8 },
  rural: { timeUpper: 9.2, timeLower: 4.6, location: 6.8 }
}

// §4.1：银河噪声十分位偏差 2 dB（§7.1 合成时 σ = 2/1.282 = 1.56 dB）
const GALACTIC_DECILE_DB = 2

/** 式 (17)，Table 1。@returns {null | {famDb, inRange}} */
function manMadeNoiseFam(fMHz, category) {
  const f = num(fMHz), t = MANMADE_CD[category]
  if (f === null || !(f > 0) || !t) return null
  return { famDb: t.c - t.d * Math.log10(f), inRange: f >= t.rangeMHz[0] && f <= t.rangeMHz[1] }
}

/** 式 (15)：银河噪声中值噪声系数（垂直天线、不计电离层屏蔽）；原文「up to about 100 MHz」。 */
function galacticNoiseFam(fMHz) {
  const f = num(fMHz)
  if (f === null || !(f > 0)) return null
  return { famDb: 52 - 23 * Math.log10(f), inRange: f <= 100 }
}

/** 式 (16)：408 MHz 天空图亮温（2.7 K 以上部分）外推到 f：T_b(f) = T_b(f0)·(f/f0)^−2.75 + 2.7（K）。 */
function galacticBrightnessK(tb0K, f0MHz, fMHz) {
  const t = num(tb0K), a = num(f0MHz), b = num(fMHz)
  if (t === null || a === null || b === null || !(a > 0) || !(b > 0) || t < 0) return null
  return t * Math.pow(b / a, -2.75) + 2.7
}

// ===== §1.2：换算 =====
/** 式 (9)：F_a（dB）→ 天线噪温 T_a（K）。 */
const faToTempK = (faDb) => { const v = num(faDb); return v === null ? null : T0 * Math.pow(10, v / 10) }
/** 式 (9) 反解。 */
const tempKToFa = (tK) => { const v = num(tK); return v === null || !(v > 0) ? null : 10 * Math.log10(v / T0) }
/** 式 (6)：P_n = F_a + B − 204（dBW），B = 10lg b。 */
function noisePowerDbw(faDb, bHz) {
  const fa = num(faDb), b = num(bHz)
  if (fa === null || b === null || !(b > 0)) return null
  return fa + 10 * Math.log10(b) + KT0_DBW_HZ
}

/**
 * 式 (1)–(4)：系统噪声因子 f = f_a + (f_c − 1) + l_c(f_t − 1) + l_c·l_t(f_r − 1)，参考点为无损天线输入端。
 * @param {{faDb, lcDb, tcK, ltDb, ttK, frDb}} o  l_c / l_t 为天线回路 / 传输线损耗（dB），T_c / T_t 缺省 T₀
 * @returns {null | {f, fDb, tSysK}}  tSysK = f·T₀
 */
function systemNoiseFactor(o) {
  const fa = num(o && o.faDb), fr = num(o && o.frDb)
  const lcDb = o && o.lcDb != null ? num(o.lcDb) : 0, ltDb = o && o.ltDb != null ? num(o.ltDb) : 0
  const tc = o && o.tcK != null ? num(o.tcK) : T0, tt = o && o.ttK != null ? num(o.ttK) : T0
  if ([fa, fr, lcDb, ltDb, tc, tt].some((v) => v === null)) return null
  const lin = (d) => Math.pow(10, d / 10)
  const lc = lin(lcDb), lt = lin(ltDb)
  const fc = 1 + (lc - 1) * (tc / T0)                                   // (3)
  const ft = 1 + (lt - 1) * (tt / T0)                                   // (4)
  const f = lin(fa) + (fc - 1) + lc * (ft - 1) + lc * lt * (lin(fr) - 1)   // (1)
  return { f, fDb: 10 * Math.log10(f), tSysK: f * T0 }
}

// ===== §7.1：多源噪声合成（式 31–39）=====
const C_LN = 10 / Math.LN10   // 式 (33)：c = 4.343

/**
 * 两个以上噪声源合成后的中值与十分位偏差。各源按中值两侧各一个半正态（dB）处理（§7.1）。
 * @param {Array<{famDb, duDb, dlDb}>} comps  du / dl 为上 / 下十分位偏差（dB；只给 sigmaDb 时两侧同为 1.282σ）
 * @param {'upper'|'lower'} side  用哪一侧的偏差算 σ_i（式 34–35）。原文给出式 (31)(32) 的中值与 σ_T，
 *   并分别用上 / 下十分位算 D_uT / D_lT，但没说中值 F_amT 用哪一侧的 σ_i —— 这里按侧各给一份，不替原文做选择。
 * @returns {null | {famTDb, sigmaTDb, decileTDb, capped}}  capped = 某源十分位 > 12 dB 时按式 (38) 封顶
 */
function combineNoise(comps, side) {
  if (!Array.isArray(comps) || !comps.length) return null
  const sd = side === 'lower' ? 'dlDb' : 'duDb'
  let aT = 0, bT = 0, gT = 0, big = false
  for (const cp of comps) {
    const fam = num(cp && cp.famDb)
    let dec = cp && cp[sd] != null ? num(cp[sd]) : (cp && cp.sigmaDb != null ? num(cp.sigmaDb) * 1.282 : 0)
    if (fam === null || dec === null || dec < 0) return null
    if (dec > 12) big = true
    const s = dec / 1.282
    const ai = Math.exp(fam / C_LN + s * s / (2 * C_LN * C_LN))       // (34)
    aT += ai
    bT += ai * ai * (Math.exp(s * s / (C_LN * C_LN)) - 1)               // (35)
    gT += Math.exp(fam / C_LN)                                          // (39)
  }
  let sT = C_LN * Math.sqrt(Math.log(1 + bT / (aT * aT)))              // (32)
  let capped = false
  if (big) {
    const cap = C_LN * Math.sqrt(2 * Math.log(aT / gT))                // (38)
    if (sT > cap) { sT = cap; capped = true }
  }
  const famT = C_LN * (Math.log(aT) - sT * sT / (2 * C_LN * C_LN))     // (31)
  return { famTDb: famT, sigmaTDb: sT, decileTDb: 1.282 * sT, capped }   // (36)/(37)
}

// ===== §3.1：地面站天空亮温（式 10–13）=====
/**
 * 平均辐射温度 T_mr（K），式 (11)/(13)。无雨：系数按频率在 Tmr_approx 表里线性插值（1–200 GHz）；
 * 有雨：275 K（1–55 GHz）。tsK 开尔文、psHpa 百帕、rhoWs g/m³。
 */
function meanRadiatingTempK(fGHz, conds) {
  const o = conds || {}
  const f = num(fGHz)
  if (f === null) return null
  if (o.rain) return f >= 1 && f <= 55 ? 275 : null
  if (f < 1 || f > 200) return null
  const ts = o.tsK == null ? 288.15 : num(o.tsK)
  const ps = o.psHpa == null ? 1013.25 : num(o.psHpa)
  const rho = o.rhoWs == null ? 7.5 : num(o.rhoWs)
  if (ts === null || ps === null || rho === null) return null
  const i = Math.min(TMR_APPROX.length - 2, Math.floor((f - 1) / 0.5))
  const r0 = TMR_APPROX[i], r1 = TMR_APPROX[i + 1]
  const t = (f - r0[0]) / (r1[0] - r0[0])
  const co = [1, 2, 3, 4].map((k) => r0[k] + (r1[k] - r0[k]) * t)
  return co[0] + co[1] * ts + co[2] * ps + co[3] * rho
}

/**
 * 式 (10)/(12)：天空亮温 T_B = 2.73·10^(−A/10) + T_mr·(1 − 10^(−A/10))（K）。
 * @param atmAttenDb 该仰角斜路径的总大气衰减（不含闪烁），由 P.676 / P.618 给
 */
function skyBrightnessK(fGHz, atmAttenDb, conds) {
  const a = num(atmAttenDb)
  const tmr = meanRadiatingTempK(fGHz, conds)
  if (a === null || tmr === null || a < 0) return null
  const tr = Math.pow(10, -a / 10)
  return 2.73 * tr + tmr * (1 - tr)
}

// 低仰角大气质量：P.676 Annex 2 的形状函数 F(x) = 1/(0.661x + 0.339√(x² + 5.51))，
// m(θ) = √(R_e/h)·F(tanθ·√(R_e/h))/cosθ（θ ≥ 5° 时就是 1/sinθ）
function airMass(elevRad, hKm) {
  const re = 8500
  if (elevRad >= 5 * Math.PI / 180) return 1 / Math.sin(elevRad)
  const k = Math.sqrt(re / hKm)
  const x = Math.tan(elevRad) * k
  return k / (0.661 * x + 0.339 * Math.sqrt(x * x + 5.51)) / Math.cos(elevRad)
}

/**
 * 上半球按 cos(仰角) 加权的平均天空亮温（K）——全向天线「看到的天空」。
 * @param {number} fGHz
 * @param {object} [o] zenithAttenDb（缺省 0.04）、equivHeightKm（缺省 6）、tsK / psHpa / rhoWs / rain
 */
function hemisphereSkyTempK(fGHz, o) {
  const q = o || {}
  const az = q.zenithAttenDb == null ? 0.04 : num(q.zenithAttenDb)
  const h = q.equivHeightKm == null ? 6 : num(q.equivHeightKm)
  if (az === null || h === null || az < 0 || !(h > 0)) return null
  const tmr = meanRadiatingTempK(fGHz, q)
  if (tmr === null) return null
  const tb = (el) => {
    const tr = Math.pow(10, -az * airMass(el, h) / 10)
    return 2.73 * tr + tmr * (1 - tr)
  }
  return integrate((el) => tb(el) * Math.cos(el), 0, Math.PI / 2, 24, [2 * Math.PI / 180, 5 * Math.PI / 180, 15 * Math.PI / 180])
}

// ===== §6.2：室内人为噪声（式 18–30，Table 3）=====
// 缺省参数 = Table 3（英国 400–1 400 MHz 长期实测；ρ、η 原表给 0.2 与 0.15 两档，缺省取 0.2）
const INDOOR_DEFAULTS = {
  r0: 1, rD: 4,                         // m：最近噪声源距离、显著半径
  muEG: -125, muEI: -120,               // 高斯 / 脉冲（IN）发射均值（原表单位 dBm）
  varEG: 2, varEI: 2,                   // 发射方差（原表单位记作 dB）
  rho: 0.2, eta: 0.2,                   // 噪声源密度（个/m²）、活动因子
  eps: 0,                               // IN 带宽缩放（dB）：缺省对应 40 MHz 带宽，带宽每翻倍 +3 dB
  pi: 0.001,                            // IN 出现概率（置 0 即只算高斯部分，NOTE 2）
  alpha: 1.47, beta: 34.17, gamma: 2.08, sigmaL: 3.68   // 室内基本传输损耗系数
}
const ZETA = 1e-6                       // 式 (29)(30) 的正则化因子
const KAPPA = 10 / Math.LN10

/**
 * 室内人为噪声的高斯 / IN 两个分量的均值与标准差（dB，相对 kT₀b），式 (19)–(30)。
 * 有效频段 80 MHz–2 GHz；越界返回 null，除非 allowOutOfRange。
 * ★ 式 (26) 原文里 σ̂²_e,x 不含 ε（只有式 25 的均值含 ε）——照录；缺省 ε = 0 时两者无差别。
 * ★ 与原文图的对拍：高斯分量复现 Figure 41（13 个频点 ±0.1 dB）与 Figure 42 超过概率 ≥ 1% 的部分；
 *   但 Figure 42 在超过概率 < 0.1% 的 IN 段比式 (18)–(26) + Table 3 缺省算出的高 7–10 dB
 *   （按图反推 IN 分量约为 μ_G + 12 dB、σ ≈ 5.3 dB；照印出的式子只有 μ_G + 5 dB、σ 与高斯相同）。
 *   原文没给出能复现该段的参数，本实现按印出的式子算，未改动；链路预算缺省只用中值（不涉及 IN 尾部）。
 * @returns {null | {muG, sigmaG, muI, sigmaI, pi, inRange}}
 */
function indoorNoiseParams(fGHz, opts) {
  const o = Object.assign({}, INDOOR_DEFAULTS, opts || {})
  const f = num(fGHz)
  if (f === null || !(f > 0)) return null
  const inRange = f >= 0.08 && f <= 2
  if (!inRange && !o.allowOutOfRange) return null
  for (const k of Object.keys(INDOOR_DEFAULTS)) if (num(o[k]) === null) return null
  const { r0, rD, alpha, sigmaL } = o
  if (!(rD > r0) || !(r0 > 0) || !(o.rho > 0) || !(o.eta > 0) || o.pi < 0 || o.pi > 1) return null
  const muL = o.beta + 10 * o.gamma * Math.log10(f)
  const muLh = Math.exp(-muL / KAPPA + sigmaL * sigmaL / (2 * KAPPA * KAPPA))                               // (27)
  const varLh = (Math.exp(sigmaL * sigmaL / (KAPPA * KAPPA)) - 1) * Math.exp(-2 * muL / KAPPA + sigmaL * sigmaL / (KAPPA * KAPPA))   // (28)
  const az = alpha + ZETA
  const muRh = 2 / ((az - 2) * rD * rD) * (Math.pow(r0, 2 - alpha + ZETA) - Math.pow(rD, 2 - alpha + ZETA))   // (29)
  const varRh = 1 / ((az - 1) * rD * rD) * (Math.pow(r0, 2 - 2 * az) - Math.pow(rD, 2 - 2 * az)) - muRh * muRh   // (30)
  const nSrc = o.eta * o.rho * Math.PI * (rD * rD - r0 * r0)
  const comp = (muE, varE, eps) => {
    const muEh = Math.exp((eps + muE) / KAPPA + varE / (2 * KAPPA * KAPPA))                                   // (25)
    const varEh = (Math.exp(varE / (KAPPA * KAPPA)) - 1) * Math.exp(2 * muE / KAPPA + varE / (KAPPA * KAPPA))  // (26)
    const muYh = muEh * muLh * muRh                                                                           // (23)
    const varYh = (varRh + muRh * muRh) * (varLh + muLh * muLh) * (varEh + muEh * muEh) - muEh * muEh * muLh * muLh * muRh * muRh   // (24)
    const muAll = nSrc * muYh, varAll = nSrc * varYh                                                          // (21)(22)
    const s2 = KAPPA * KAPPA * Math.log(varAll / (muAll * muAll) + 1)                                        // (19)
    const mu = Math.max(0, KAPPA * Math.log(muAll) - s2 / (2 * KAPPA) + 174)                                 // (20)
    return { mu, sigma: Math.sqrt(s2) }
  }
  const g = comp(o.muEG, o.varEG, 0)
  const i = comp(o.muEI, o.varEI, o.eps)
  return { muG: g.mu, sigmaG: g.sigma, muI: i.mu, sigmaI: i.sigma, pi: o.pi, inRange }
}

/** 式 (18)：P(F_a ≤ F_x)。 */
function indoorNoiseCdf(fxDb, fGHz, opts) {
  const x = num(fxDb), p = indoorNoiseParams(fGHz, opts)
  if (x === null || !p) return null
  return (1 - p.pi) * normCdf((x - p.muG) / p.sigmaG) + p.pi * normCdf((x - p.muI) / p.sigmaI)
}

/** 式 (18) 反解：不被超过概率为 pNotExceeded 的 F_a（dB）。Figure 42 的横轴是「超过」百分比 = 1 − 此值。 */
function indoorNoiseFaDb(pNotExceeded, fGHz, opts) {
  const pp = num(pNotExceeded), p = indoorNoiseParams(fGHz, opts)
  if (pp === null || !p || !(pp > 0 && pp < 1)) return null
  const F = (x) => (1 - p.pi) * normCdf((x - p.muG) / p.sigmaG) + p.pi * normCdf((x - p.muI) / p.sigmaI) - pp
  return brentRoot(F, -100, 200, 1e-9)
}

// ===== ⑥ 0 dBi 手持终端的天线噪温（口径见文件头）=====
/**
 * @param {object} o
 *   fGHz（必填）；skyFraction（室外 0.5 / 室内 0）；groundEmissivity（室外 0.9 / 室内 1）；groundTempK（290）；
 *   manMade：'none'（缺省）| 'city' | 'residential' | 'rural' | 'quietRural' | 'indoor'；
 *   indoor：§6.2 参数覆盖（传给 indoorNoiseParams）；indoorP：室内噪声取「不被超过」概率（缺省 0.5 = 中值）；
 *   includeGalactic（室外 true / 室内 false）；zenithAttenDb / equivHeightKm / tsK / psHpa / rhoWs（天空项）
 * @returns {null | {taK, skyK, groundK, manMadeK, galacticK, manMadeFaDb, manMadeExtrapolated, galacticExtrapolated}}
 */
function handheldAntennaTempK(o) {
  const q = o || {}
  const f = num(q.fGHz)
  if (f === null || !(f > 0)) return null
  const mmKind = q.manMade == null ? 'none' : String(q.manMade)
  const indoor = mmKind === 'indoor'
  const eta = q.skyFraction == null ? (indoor ? 0 : 0.5) : num(q.skyFraction)
  const eps = q.groundEmissivity == null ? (indoor ? 1 : 0.9) : num(q.groundEmissivity)
  const tPhys = q.groundTempK == null ? 290 : num(q.groundTempK)
  if (eta === null || eps === null || tPhys === null || eta < 0 || eta > 1 || eps < 0 || eps > 1 || tPhys < 0) return null
  const sky = hemisphereSkyTempK(f, q)
  if (sky === null) return null
  const ground = eps * tPhys + (1 - eps) * sky
  let mmFa = null, mmK = 0, mmExtra = false
  if (mmKind === 'indoor') {
    mmFa = indoorNoiseFaDb(q.indoorP == null ? 0.5 : q.indoorP, f, q.indoor)
    if (mmFa === null) return null
    mmK = faToTempK(mmFa)
  } else if (mmKind !== 'none') {
    const r = manMadeNoiseFam(f * 1000, mmKind)
    if (!r || mmKind === 'galactic') return null
    mmFa = r.famDb
    mmK = faToTempK(mmFa)
    mmExtra = !r.inRange
  }
  let gal = 0, galExtra = false
  if (q.includeGalactic === true || (q.includeGalactic == null && !indoor)) {   // 室内看不到天空，缺省不计
    const g = galacticNoiseFam(f * 1000)
    gal = faToTempK(g.famDb)
    galExtra = !g.inRange
  }
  return {
    taK: eta * sky + (1 - eta) * ground + mmK + gal,
    skyK: sky, groundK: ground, manMadeK: mmK, galacticK: gal, manMadeFaDb: mmFa,
    manMadeExtrapolated: mmExtra, galacticExtrapolated: galExtra
  }
}

/**
 * G/T（dB/K）：TR 38.821 式 (6.1.3.1-3) / TR 38.811 Table 4.4-1 NOTE 1
 *   G/T = G_a − NF − 10lg(T₀ + (T_a − T₀)·10^(−0.1·NF))
 */
function gOverTDb(gaDbi, nfDb, taK, t0K) {
  const g = num(gaDbi), nf = num(nfDb), ta = num(taK), t0 = t0K == null ? T0 : num(t0K)
  if (g === null || nf === null || ta === null || t0 === null || ta < 0 || !(t0 > 0)) return null
  return g - nf - 10 * Math.log10(t0 + (ta - t0) * Math.pow(10, -0.1 * nf))
}

/**
 * 手持终端：P.372 估出的 T_a 与 TR 38.821 的 290 K 假设对照。
 * gaDbi 缺省 0、nfDb 缺省 7（TR 38.821 Table 6.1.1.1-3 手持）；其余参数同 handheldAntennaTempK。
 * deltaGtDb > 0 表示按 P.372 环境比 290 K 假设的 G/T 好（噪声更低）。
 */
function handheldVs38821(o) {
  const q = o || {}
  const ga = q.gaDbi == null ? 0 : num(q.gaDbi)
  const nf = q.nfDb == null ? 7 : num(q.nfDb)
  const ta = handheldAntennaTempK(q)
  if (ga === null || nf === null || !ta) return null
  const gt = gOverTDb(ga, nf, ta.taK)
  const gt290 = gOverTDb(ga, nf, 290)
  const fLin = Math.pow(10, nf / 10)
  return Object.assign({}, ta, {
    gtDb: gt, gt290Db: gt290, deltaGtDb: gt - gt290,
    tSysK: ta.taK + (fLin - 1) * T0, tSys290K: 290 + (fLin - 1) * T0
  })
}

module.exports = {
  T0, KT0_DBW_HZ, MANMADE_CD, MANMADE_DECILES, GALACTIC_DECILE_DB, INDOOR_DEFAULTS,
  manMadeNoiseFam, galacticNoiseFam, galacticBrightnessK,
  faToTempK, tempKToFa, noisePowerDbw, systemNoiseFactor, combineNoise,
  meanRadiatingTempK, skyBrightnessK, hemisphereSkyTempK,
  indoorNoiseParams, indoorNoiseCdf, indoorNoiseFaDb,
  handheldAntennaTempK, gOverTDb, handheldVs38821
}
