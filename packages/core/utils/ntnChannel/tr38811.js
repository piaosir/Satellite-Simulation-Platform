// 3GPP TR 38.811 V15.4.0（2020-09）§6.6「Large scale model」—— NTN 大尺度参数（纯函数，CommonJS）。
//
// 平台原先的物联网 / 手持 / NTN 链路预算只能手填一个「综合损耗」。本文件给出 3GPP 口径的三样东西：
//   ① LOS 概率（Table 6.6.1-1，按场景 × 仰角）；
//   ② 杂波损耗 CL 与阴影衰落标准差 σ_SF（Table 6.6.2-1 / -2 / -3，S 频段与 Ka 频段，分 LOS / NLOS）；
//   ③ 位置覆盖概率：链路余量 M 给定时，按 LOS / NLOS 混合 + 对数正态阴影算出能闭合的位置比例：
//        P_cov(M) = P_LOS·Φ(M/σ_LOS) + (1 − P_LOS)·Φ((M − CL)/σ_NLOS)
//      其中 M 是【未计 CL 与 SF】的余量（自由空间 + 大气 + 闪烁等都已扣掉之后剩下的 dB 数）。
//      推导：式 (6.6-4) PL_b = FSPL + SF + CL，SF ~ N(0, σ_SF²)；LOS 时 CL = 0（§6.6.2 末段原文
//      「When the UE is in LOS condition, clutter loss is negligible and should be set to 0 dB」）。
//      能闭合 ⇔ CL + SF ≤ M ⇔ SF ≤ M − CL，故条件概率 = Φ((M − CL)/σ)。
//   另附 §6.6.6 电离层 / 对流层闪烁参考量、式 (6.6-2)(6.6-3) 自由空间损耗与斜距、式 (6.6-8) 大气吸收。
//
// ★ 仰角取值规则：TR 38.811 §6.6.1 / §6.6.2 原文是「取最近的参考仰角」（10° 一档，10°…90°）。
//   本库缺省按仰角【线性插值】（任务书要求；扫仰角时曲线连续、没有 15°/25°… 处的台阶），
//   传 { elevRule: 'nearest' } 即回到 3GPP 原文口径。TR 38.821 Table 6.1.3.3-1 的闪烁损耗
//   （GEO 12.5° → 10° 档 1.08 → 1.1 dB）是按「最近档」取的，对拍 38.821 时要用 nearest。
//   两种规则在 10° 以下都取 10° 那一档（3GPP 不给 10° 以下的表；最近档规则本来就落到 10°），
//   返回结果里 elevClamped = true 标明。
//
// ★ P.2108（地物杂波）/ P.2109（建筑物进入损耗）由另一会话在 packages/core/utils/terrestrial/ 实现，
//   这里不重复实现，只留接口参数（见 coverageProbability 的 extraLossDb / extraLossQuantile / nlosClutterDb）。
//
// 原文：https://www.3gpp.org/ftp/Specs/archive/38_series/38.811/38811-f40.zip（表格逐值转录，表号见各常量注释）。

const { normCdf, normPdf, normInv, integrate, brentRoot, num } = require('./numeric.js')

// 参考仰角（Table 6.6.1-1 / 6.6.2-1…-3 的行）
const ELEV_REF = [10, 20, 30, 40, 50, 60, 70, 80, 90]

// 场景键：denseUrban 密集城区 / urban 城区 / suburban 郊区 / rural 乡村。
// 原文把郊区与乡村合成一列（Table 6.6.1-1「Suburban and Rural scenarios」）、一张表（Table 6.6.2-3），
// 这里保留四个键，郊区与乡村指向同一份数据。
const SCENARIOS = ['denseUrban', 'urban', 'suburban', 'rural']
const TABLE_KEY = { denseUrban: 'denseUrban', urban: 'urban', suburban: 'suburbanRural', rural: 'suburbanRural' }

// ===== Table 6.6.1-1 LOS probability（%，行 = 10°…90°）=====
const LOS_PROB_PCT = {
  denseUrban: [28.2, 33.1, 39.8, 46.8, 53.7, 61.2, 73.8, 82.0, 98.1],
  urban: [24.6, 38.6, 49.3, 61.3, 72.6, 80.5, 91.9, 96.8, 99.2],
  suburbanRural: [78.2, 86.9, 91.9, 92.9, 93.5, 94.0, 94.9, 95.2, 99.8]
}

// ===== Table 6.6.2-1 / 6.6.2-2 / 6.6.2-3：阴影衰落 σ_SF 与杂波损耗 CL（dB，行 = 10°…90°）=====
// sfLos = LOS 的 σ_SF；sfNlos = NLOS 的 σ_SF；clNlos = NLOS 的 CL（LOS 的 CL 按 §6.6.2 取 0，表里没有这一列）。
// S 频段 = 2 GHz 上下行；Ka 频段 = 20 GHz 下行 / 30 GHz 上行（§4、Table 4.4-1；同一张表不分上下行）。
const SF_CL = {
  // Table 6.6.2-1: Shadow fading and clutter loss for dense urban scenario
  denseUrban: {
    S: {
      sfLos: [3.5, 3.4, 2.9, 3.0, 3.1, 2.7, 2.5, 2.3, 1.2],
      sfNlos: [15.5, 13.9, 12.4, 11.7, 10.6, 10.5, 10.1, 9.2, 9.2],
      clNlos: [34.3, 30.9, 29.0, 27.7, 26.8, 26.2, 25.8, 25.5, 25.5]
    },
    Ka: {
      sfLos: [2.9, 2.4, 2.7, 2.4, 2.4, 2.7, 2.6, 2.8, 0.6],
      sfNlos: [17.1, 17.1, 15.6, 14.6, 14.2, 12.6, 12.1, 12.3, 12.3],
      clNlos: [44.3, 39.9, 37.5, 35.8, 34.6, 33.8, 33.3, 33.0, 32.9]
    }
  },
  // Table 6.6.2-2: Shadow fading and clutter loss for urban scenario
  urban: {
    S: {
      sfLos: [4, 4, 4, 4, 4, 4, 4, 4, 4],
      sfNlos: [6, 6, 6, 6, 6, 6, 6, 6, 6],
      clNlos: [34.3, 30.9, 29.0, 27.7, 26.8, 26.2, 25.8, 25.5, 25.5]
    },
    Ka: {
      sfLos: [4, 4, 4, 4, 4, 4, 4, 4, 4],
      sfNlos: [6, 6, 6, 6, 6, 6, 6, 6, 6],
      clNlos: [44.3, 39.9, 37.5, 35.8, 34.6, 33.8, 33.3, 33.0, 32.9]
    }
  },
  // Table 6.6.2-3: Shadow fading and clutter loss for suburban and rural scenarios
  suburbanRural: {
    S: {
      sfLos: [1.79, 1.14, 1.14, 0.92, 1.42, 1.56, 0.85, 0.72, 0.72],
      sfNlos: [8.93, 9.08, 8.78, 10.25, 10.56, 10.74, 10.17, 11.52, 11.52],
      clNlos: [19.52, 18.17, 18.42, 18.28, 18.63, 17.68, 16.50, 16.30, 16.30]
    },
    Ka: {
      sfLos: [1.9, 1.6, 1.9, 2.3, 2.7, 3.1, 3.0, 3.6, 0.4],
      sfNlos: [10.7, 10.0, 11.2, 11.6, 11.8, 10.8, 10.8, 10.8, 10.8],
      clNlos: [29.5, 24.6, 21.9, 20.0, 18.7, 17.8, 17.2, 16.9, 16.8]
    }
  }
}

// ===== §6.6.6.2.1 Table 6.6.6.2.1-1：对流层闪烁（20 GHz、Toulouse、99% 时间概率）dB，行 = 10°…90° =====
const TROPO_SCINT_99_DB = [1.08, 0.48, 0.30, 0.22, 0.17, 0.13, 0.12, 0.12, 0.12]

// ===== §6.6.6.1.1 Table 6.6.6.1.1-1：按 S4 划分的闪烁强度档 =====
// 相位闪烁的边界原文就是区间（0.25-0.3、0.5-0.7），照录为 [下, 上]。
const SCINT_REGIMES = [
  { regime: 'weak', s4: [0, 0.3], sigmaPhiRad: [0, [0.25, 0.3]] },
  { regime: 'moderate', s4: [0.3, 0.6], sigmaPhiRad: [[0.25, 0.3], [0.5, 0.7]] },
  { regime: 'strong', s4: [0.6, Infinity], sigmaPhiRad: [[0.5, 0.7], Infinity] }
]

// §6.6.6.1.4：P3 曲线（Figure 6.6.6.1.4-1，4 GHz）在 1% 时间（= 99% 水平）的峰峰起伏 1.1 dB
// （§6.6.6.1.4 末式「A_IS = P_fluc(4GHz)·0.5^−1.5/√2 = 1.1 × 0.5^−1.5/√2 = 2.2 dB」；TR 38.821 Table 6.1.3.2-1 NOTE 1）
const PFLUC_4GHZ_P3_1PCT_DB = 1.1

const DEFAULT_ELEV_RULE = 'linear'

// ---------- 仰角查表 ----------
function elevIndexer(elevDeg, rule) {
  const e = num(elevDeg)
  if (e === null || !(e > 0) || e > 90) return null
  const clamped = e < ELEV_REF[0]
  const eu = clamped ? ELEV_REF[0] : e
  if ((rule || DEFAULT_ELEV_RULE) === 'nearest') {
    // 最近参考仰角；正好落在两档中间（15°、25°…）时取较低仰角（更保守：低仰角 CL / σ 更大）
    let best = 0
    for (let i = 1; i < ELEV_REF.length; i++) {
      if (Math.abs(ELEV_REF[i] - eu) < Math.abs(ELEV_REF[best] - eu)) best = i
    }
    return { i0: best, i1: best, t: 0, elevUsed: ELEV_REF[best], clamped }
  }
  if (eu >= 90) return { i0: 8, i1: 8, t: 0, elevUsed: 90, clamped }
  const i0 = Math.floor((eu - 10) / 10)
  const t = (eu - ELEV_REF[i0]) / 10
  return { i0, i1: Math.min(8, i0 + 1), t, elevUsed: eu, clamped }
}
const pick = (arr, ix) => arr[ix.i0] + (arr[ix.i1] - arr[ix.i0]) * ix.t

function bandKey(band) {
  const b = String(band == null ? '' : band).trim().toLowerCase()
  if (b === 's') return 'S'
  if (b === 'ka') return 'Ka'
  return null
}

/**
 * 频率 → 3GPP NTN 两档频段口径：< 6 GHz 用 S 频段参数，≥ 6 GHz 用 Ka 频段参数。
 * 3GPP 以 6 GHz 为界划分「below / above 6 GHz」两类部署（TR 38.811 §4、§6.6.6 闪烁也以 6 GHz 分界），
 * 表格只在 2 GHz（S）与 20/30 GHz（Ka）测/算过；L 频段、Ku 频段借用就近一档是工程近似，
 * nominal = false 标明「不在该档的标称频率附近」（S 档标称 1.5–2.5 GHz，Ka 档标称 17–31 GHz）。
 */
function bandOfFreq(fGHz) {
  const f = num(fGHz)
  if (f === null || !(f > 0)) return null
  if (f < 6) return { band: 'S', nominal: f >= 1.5 && f <= 2.5 }
  return { band: 'Ka', nominal: f >= 17 && f <= 31 }
}

/** LOS 概率（0–1），Table 6.6.1-1。 */
function losProbability(scenario, elevDeg, opts) {
  const key = TABLE_KEY[scenario]
  const ix = elevIndexer(elevDeg, opts && opts.elevRule)
  if (!key || !ix) return null
  return pick(LOS_PROB_PCT[key], ix) / 100
}

/** 阴影衰落标准差 σ_SF（dB），Table 6.6.2-1…-3；los = true 取 LOS 列。 */
function shadowFadingSigma(scenario, band, los, elevDeg, opts) {
  const key = TABLE_KEY[scenario], bk = bandKey(band)
  const ix = elevIndexer(elevDeg, opts && opts.elevRule)
  if (!key || !bk || !ix) return null
  return pick(SF_CL[key][bk][los ? 'sfLos' : 'sfNlos'], ix)
}

/** NLOS 杂波损耗 CL（dB），Table 6.6.2-1…-3。LOS 一律 0，不走这里。 */
function clutterLoss(scenario, band, elevDeg, opts) {
  const key = TABLE_KEY[scenario], bk = bandKey(band)
  const ix = elevIndexer(elevDeg, opts && opts.elevRule)
  if (!key || !bk || !ix) return null
  return pick(SF_CL[key][bk].clNlos, ix)
}

/** 一次取齐某场景 / 频段 / 仰角下的大尺度参数。 */
function largeScaleParams(scenario, band, elevDeg, opts) {
  const key = TABLE_KEY[scenario], bk = bandKey(band)
  const rule = (opts && opts.elevRule) || DEFAULT_ELEV_RULE
  const ix = elevIndexer(elevDeg, rule)
  if (!key || !bk || !ix) return null
  const t = SF_CL[key][bk]
  return {
    scenario, band: bk, elevRule: rule, elevUsed: ix.elevUsed, elevClamped: ix.clamped,
    pLos: pick(LOS_PROB_PCT[key], ix) / 100,
    sigmaLos: pick(t.sfLos, ix),
    sigmaNlos: pick(t.sfNlos, ix),
    clNlos: pick(t.clNlos, ix)
  }
}

// 额外随机损耗（P.2109 建筑物进入损耗等）按分位数函数给入时：P = ∫₀¹ P_cov(M − Q(u)) du。
// 换元 u = Φ(z) 把两端的尾巴拉开，z ∈ [−8.5, 8.5] 分段 Gauss–Legendre（Φ(−8.5) ≈ 1e-17）。
function averageOverExtraLoss(pc, m0, quantile) {
  return integrate((z) => {
    const q = num(quantile(normCdf(z)))
    return q === null ? NaN : normPdf(z) * pc(m0 - q)
  }, -8.5, 8.5, 24, [-4, -2, 0, 2, 4])
}

/**
 * 位置覆盖概率细项。
 * @param {number} marginDb  未计 CL 与 SF 的链路余量（dB）
 * @param {string} scenario  'denseUrban' | 'urban' | 'suburban' | 'rural'
 * @param {string} band      'S' | 'Ka'
 * @param {number} elevDeg   仰角（度）
 * @param {object} [opts]
 *   elevRule          'linear'（缺省）| 'nearest'（3GPP 原文口径）
 *   extraLossDb       与位置无关的确定性附加损耗（dB），从余量里扣
 *   extraLossQuantile 与阴影独立的随机附加损耗的分位数函数 u ↦ dB（u ∈ (0,1)），
 *                     例如 P.2109 建筑物进入损耗（terrestrial/ 模块提供）；给了就对它求期望
 *   nlosClutterDb     覆盖 NLOS 的 CL（例如改用 P.2108 时传 0，再把 P.2108 经 extraLossQuantile 接进来）
 * @returns {null | {p, pLos, pCloseLos, pCloseNlos, sigmaLos, sigmaNlos, clNlos, elevUsed, elevClamped, elevRule}}
 */
function coverageBreakdown(marginDb, scenario, band, elevDeg, opts) {
  const o = opts || {}
  const m = num(marginDb)
  const lsp = largeScaleParams(scenario, band, elevDeg, o)
  if (m === null || !lsp) return null
  const cl = o.nlosClutterDb != null ? num(o.nlosClutterDb) : lsp.clNlos
  const extra = o.extraLossDb != null ? num(o.extraLossDb) : 0
  if (cl === null || extra === null) return null
  const m0 = m - extra
  const fLos = (mm) => normCdf(mm / lsp.sigmaLos)
  const fNlos = (mm) => normCdf((mm - cl) / lsp.sigmaNlos)
  let pCloseLos, pCloseNlos
  if (typeof o.extraLossQuantile === 'function') {
    pCloseLos = averageOverExtraLoss(fLos, m0, o.extraLossQuantile)
    pCloseNlos = averageOverExtraLoss(fNlos, m0, o.extraLossQuantile)
    if (!Number.isFinite(pCloseLos) || !Number.isFinite(pCloseNlos)) return null
  } else {
    pCloseLos = fLos(m0)
    pCloseNlos = fNlos(m0)
  }
  const p = lsp.pLos * pCloseLos + (1 - lsp.pLos) * pCloseNlos
  return {
    p, pLos: lsp.pLos, pCloseLos, pCloseNlos,
    sigmaLos: lsp.sigmaLos, sigmaNlos: lsp.sigmaNlos, clNlos: cl,
    elevUsed: lsp.elevUsed, elevClamped: lsp.elevClamped, elevRule: lsp.elevRule
  }
}

/** 位置覆盖概率（0–1）。参数同 coverageBreakdown。 */
function coverageProbability(marginDb, scenario, band, elevDeg, opts) {
  const r = coverageBreakdown(marginDb, scenario, band, elevDeg, opts)
  return r ? r.p : null
}

/**
 * 达到目标位置覆盖概率所需的余量（dB，未计 CL 与 SF 的口径），即 coverageProbability 的反函数。
 * P_cov(M) 对 M 单调增、两端趋于 0 / 1，任何 0 < p < 1 都有唯一解。
 */
function requiredMarginDb(pTarget, scenario, band, elevDeg, opts) {
  const p = num(pTarget)
  if (p === null || !(p > 0 && p < 1)) return null
  if (!largeScaleParams(scenario, band, elevDeg, opts)) return null
  const f = (m) => coverageProbability(m, scenario, band, elevDeg, opts) - p
  let lo = -60, hi = 120
  while (f(lo) > 0 && lo > -1000) lo -= 100
  while (f(hi) < 0 && hi < 1000) hi += 100
  return brentRoot(f, lo, hi, 1e-9)
}

/** 只看 LOS 的经典阴影余量：Φ⁻¹(p)·σ_LOS（dB）——对照用。 */
function losShadowMarginDb(pTarget, scenario, band, elevDeg, opts) {
  const p = num(pTarget)
  const s = shadowFadingSigma(scenario, band, true, elevDeg, opts)
  if (p === null || !(p > 0 && p < 1) || s === null) return null
  return normInv(p) * s
}

// ---------- §6.6.2 式 (6.6-2) (6.6-3)、§6.6.4 式 (6.6-8) ----------

/** 自由空间损耗 FSPL = 32.45 + 20lg f_c + 20lg d（d 米、f_c GHz），式 (6.6-2)。 */
function fsplDb(distanceM, fGHz) {
  const d = num(distanceM), f = num(fGHz)
  if (d === null || f === null || !(d > 0) || !(f > 0)) return null
  return 32.45 + 20 * Math.log10(f) + 20 * Math.log10(d)
}

/**
 * 地面终端到卫星 / HAPS 的斜距（米），式 (6.6-3)：
 *   d = √(R_E² sin²α + h₀² + 2h₀R_E) − R_E sin α
 * R_E 缺省 6371 km（TR 38.811 只写「Earth radius」；TR 38.821 链路预算表按 6371 km 复算吻合）。
 */
function slantRangeM(altitudeM, elevDeg, earthRadiusM) {
  const h = num(altitudeM), e = num(elevDeg)
  const re = earthRadiusM == null ? 6371e3 : num(earthRadiusM)
  if (h === null || e === null || re === null || !(h > 0) || e < 0 || e > 90 || !(re > 0)) return null
  const s = Math.sin(e * Math.PI / 180)
  return Math.sqrt(re * re * s * s + h * h + 2 * h * re) - re * s
}

/** 大气吸收：PL_g = A_zenith / sin α，式 (6.6-8)。A_zenith 由 ITU-R P.676 给（本库不重复实现）。 */
function atmosphericLossDb(zenithAttenDb, elevDeg) {
  const a = num(zenithAttenDb), e = num(elevDeg)
  if (a === null || e === null || !(e > 0) || e > 90) return null
  return a / Math.sin(e * Math.PI / 180)
}

// ---------- §6.6.6 闪烁 ----------

/** 式 (6.6-14)：P_fluc = 27.5·S4^1.26（dB，峰峰起伏）。 */
const pflucFromS4 = (s4) => { const s = num(s4); return s === null || s < 0 ? null : 27.5 * Math.pow(s, 1.26) }
/** 式 (6.6-14) 的反解。 */
const s4FromPfluc = (p) => { const v = num(p); return v === null || v < 0 ? null : Math.pow(v / 27.5, 1 / 1.26) }
/** 式 (6.6-11)：S4 频率换算 S4(f2) = S4(f1)·(f2/f1)^(−n)，n 缺省 1.5（原文：L 频段推荐 1.5）。 */
function scaleS4(s4, f1, f2, n) {
  const s = num(s4), a = num(f1), b = num(f2), k = n == null ? 1.5 : num(n)
  if (s === null || a === null || b === null || k === null || !(a > 0) || !(b > 0)) return null
  return s * Math.pow(b / a, -k)
}
/** 式 (6.6-12)：σφ 频率换算，n 缺省 1（原文：L 频段推荐 1）。 */
function scaleSigmaPhi(sigma, f1, f2, n) { return scaleS4(sigma, f1, f2, n == null ? 1 : n) }

/** Table 6.6.6.1.1-1：按 S4 判闪烁强度档（weak / moderate / strong）。 */
function scintRegime(s4) {
  const s = num(s4)
  if (s === null || s < 0) return null
  return s < 0.3 ? 'weak' : (s <= 0.6 ? 'moderate' : 'strong')
}

/**
 * 电离层闪烁损耗 A_IS（dB），§6.6.6.1.4 Gigahertz 模型：
 *   P_fluc(f) = P_fluc(4 GHz)·(f/4)^(−1.5)；A_IS = P_fluc/√2（式 6.6-13）
 * 仅 f < 6 GHz（§6.6.6.1「Ionosphere propagation shall only be considered for frequencies below 6 GHz」）。
 * 纬度规则（原文：磁赤道 ±20° 内取 A_IS；±20°–±60° 取 0；±60° 以上模型不适用、幅度效应可忽略，也取 0）：
 *   latDeg 给了就按此判；不给 = TR 38.821 Table 6.1.3.2-1 的链路预算基线（不分纬度，一律计入 A_IS）。
 * pflucDb4GHz 缺省 1.1 dB（P3 曲线 1% 时间，= 原文 99% 基线）。
 * @returns {null | {lossDb, pflucDb, latApplied}}
 */
function ionoScintillation(fGHz, opts) {
  const o = opts || {}
  const f = num(fGHz)
  if (f === null || !(f > 0)) return null
  if (f >= 6) return { lossDb: 0, pflucDb: 0, latApplied: false }
  const p4 = o.pflucDb4GHz == null ? PFLUC_4GHZ_P3_1PCT_DB : num(o.pflucDb4GHz)
  if (p4 === null || p4 < 0) return null
  const lat = o.latDeg == null ? null : num(o.latDeg)
  if (o.latDeg != null && lat === null) return null
  const pfluc = p4 * Math.pow(f / 4, -1.5)
  const inBand = lat === null || Math.abs(lat) <= 20
  return { lossDb: inBand ? pfluc / Math.SQRT2 : 0, pflucDb: pfluc, latApplied: lat !== null }
}

/**
 * 对流层闪烁损耗（dB），Table 6.6.6.2.1-1（20 GHz、Toulouse、99% 时间）。仅 f > 6 GHz 适用；
 * 原文建议把这张图表当作卫星链路余量的参考，不做频率换算。仰角规则同其余表（缺省插值，可传 nearest）。
 */
function tropoScintillationDb(elevDeg, opts) {
  const ix = elevIndexer(elevDeg, opts && opts.elevRule)
  if (!ix) return null
  return pick(TROPO_SCINT_99_DB, ix)
}

/**
 * §6.6.6 闪烁损耗 PL_s 参考量（dB）：f < 6 GHz 取电离层（纬度规则见 ionoScintillation），
 * f ≥ 6 GHz 取对流层 Table 6.6.6.2.1-1。
 */
function scintillationLossDb(fGHz, elevDeg, opts) {
  const f = num(fGHz)
  if (f === null || !(f > 0)) return null
  if (f < 6) {
    const r = ionoScintillation(f, opts)
    return r ? r.lossDb : null
  }
  return tropoScintillationDb(elevDeg, opts)
}

module.exports = {
  ELEV_REF, SCENARIOS, LOS_PROB_PCT, SF_CL, TROPO_SCINT_99_DB, SCINT_REGIMES, PFLUC_4GHZ_P3_1PCT_DB,
  DEFAULT_ELEV_RULE,
  bandOfFreq, losProbability, shadowFadingSigma, clutterLoss, largeScaleParams,
  coverageBreakdown, coverageProbability, requiredMarginDb, losShadowMarginDb,
  fsplDb, slantRangeM, atmosphericLossDb,
  pflucFromS4, s4FromPfluc, scaleS4, scaleSigmaPhi, scintRegime,
  ionoScintillation, tropoScintillationDb, scintillationLossDb
}
