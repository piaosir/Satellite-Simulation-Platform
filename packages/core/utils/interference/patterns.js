// 干扰分析 · 参考方向图与离轴 EIRP 密度掩模
//
// 干扰算的是「旁瓣」。主瓣增益人人会算，旁瓣得靠 ITU 的参考包络——而选哪一条包络不是
// 口味问题，是场景决定的：
//
//   · 峰值包络（S.465 / S.580 / RR AP8）：单个不动的干扰源打单个不动的接收机，取最坏。
//     GEO 邻星干扰就是这个场景——两颗星都不动，用峰值包络。
//   · 平均包络（S.1428）：干扰源或接收机在动、且不止一个。此时收到的干扰既取决于旁瓣的
//     峰也取决于谷，用峰值包络会系统性高估。NGSO 就是这个场景。
//     ——S.1428 的 considering c) 把这件事说得很直白，本模块据此分派。
//
// 故：GEO 路走 AP8/S.580，NGSO 路走 S.1428。不是随便挑一个能用的。
//
// ─────────────────────────────────────────────────────────────────────────────
// 权威依据
//   S.1428-1  由 ITU 官方 PDF 正文逐段核对（2001-02 版），三档 D/λ 的分段、Gmax 常数
//             （≤100 档为 +7.7、>100 档为 +8.4，两档不同）、远旁瓣平台（−5 / −4 / −9 / −12）
//             均以原文为准，未凭记忆。
//   AP8/S.580 沿用 utils/linkCalculator.js:202 已有实现的口径（RR AP8 分段 + S.580 的
//             29−25lgφ 旁瓣段），使干扰分析与链路预算引擎的「旁瓣增益」显示同源。
//   S.524-9   离轴 EIRP 密度掩模，见 §S524 的注释——含一处与引擎实现的已知分歧。
// ─────────────────────────────────────────────────────────────────────────────

const LOG10 = Math.log10;

// ---------------------------------------------------------------------------
// 主轴增益
// ---------------------------------------------------------------------------

/** 圆口径主轴增益（dBi）：G = 10lg(η) + 20lg(πD/λ)。 */
function peakGainDbi(diameterM, wavelengthM, efficiency) {
  const D = Number(diameterM), lam = Number(wavelengthM);
  const eff = Number(efficiency) > 0 ? Number(efficiency) : 0.65;
  if (!(D > 0) || !(lam > 0)) return null;
  return 20 * LOG10(Math.PI * D / lam) + 10 * LOG10(eff);
}

/** 3 dB 波束宽度（度）近似：θ₃dB ≈ 70·λ/D。用于判定「主瓣内」（in-line 事件）。 */
function beamwidth3dB(diameterM, wavelengthM) {
  const D = Number(diameterM), lam = Number(wavelengthM);
  if (!(D > 0) || !(lam > 0)) return null;
  return 70 * lam / D;
}

// ---------------------------------------------------------------------------
// RR AP8 / S.580 峰值包络 —— GEO 邻星干扰用
// ---------------------------------------------------------------------------

/**
 * 地球站离轴增益 G(φ)（dBi），峰值旁瓣包络。
 * 与 utils/linkCalculator.js 的 calculateITU465OffAxisGain 同口径同分段——两处必须一致，
 * 否则同一副天线在链路预算里显示的旁瓣增益与干扰分析算出的鉴别度会对不上。
 *
 * 注：函数名里的 465 在引擎侧是历史遗留（S.465-6 正文只有 32−25lgφ / −10 两段），
 * 实际结构是 AP8 分段 + S.580 的 29 系数旁瓣段。本模块按事实命名。
 */
function offAxisAP8(diameterM, wavelengthM, efficiency, phiDeg) {
  const D = Number(diameterM), lam = Number(wavelengthM), phi = Number(phiDeg);
  const eff = Number(efficiency) > 0 ? Number(efficiency) : 0.65;
  if (!(D > 0) || !(lam > 0)) return null;
  const Gmax = peakGainDbi(D, lam, eff);
  if (!(phi > 0)) return Gmax;
  const ratio = D / lam;

  if (ratio >= 100) {
    const G1 = 2 + 15 * LOG10(ratio);
    const phi1 = (20 * lam / D) * Math.sqrt(Math.max(0, Gmax - G1));
    const phiR = 15.85 * Math.pow(ratio, -0.6);
    if (phi < phi1) return Gmax - 0.0025 * Math.pow(ratio * phi, 2);
    if (phi < phiR) return G1;
    // 29−25lgφ 延续到与 −10 dBi 的交点 φ = 10^(39/25) ≈ 36.31°
    if (phi < 36.31) return 29 - 25 * LOG10(phi);
    return -10;
  }
  if (ratio >= 50) {
    const LS = 39 - 5 * LOG10(ratio);
    const LF = -3 - 5 * LOG10(ratio);
    // 主瓣抛物线与旁瓣段的交点：数值求解（与引擎侧同法同迭代次数，保持逐位一致）
    let phi1 = 1;
    for (let i = 0; i < 20; i++) {
      const left = Gmax - 0.0025 * Math.pow(ratio * phi1, 2);
      const right = LS - 25 * LOG10(phi1);
      if (Math.abs(left - right) < 0.01) break;
      phi1 = phi1 * Math.pow(10, (left - right) / 50);
      phi1 = Math.max(0.1, Math.min(phi1, 10));
    }
    if (phi < phi1) return Gmax - 0.0025 * Math.pow(ratio * phi, 2);
    if (phi < 48) return LS - 25 * LOG10(phi);
    return LF;
  }
  const LF = -10 - 10 * LOG10(ratio);
  if (phi < 70 / ratio) return Gmax - 0.0025 * Math.pow(ratio * phi, 2);
  if (phi < 48) return 29 - 25 * LOG10(phi);
  return LF;
}

// ---------------------------------------------------------------------------
// ITU-R S.1428-1 平均包络 —— NGSO 干扰用
// ---------------------------------------------------------------------------

// S.1428-1 的适用频段：建议书标题与 recommends 均写明 10.7–30 GHz。
// 频段之外用它没有依据——由 earthStationOffAxis 退回 AP8 并如实上报 fellBack。
const S1428_F_LO_GHZ = 10.7;
const S1428_F_HI_GHZ = 30;

/**
 * ITU-R S.1428-1 参考方向图 G(φ)（dBi），10.7–30 GHz、D/λ ≥ 20。
 *
 * 与 AP8 的两处要害差别（照抄 AP8 去算 NGSO 会系统性偏保守）：
 *   ① D/λ > 100 档的 Gmax 常数是 **8.4** 而非 ≤100 档的 7.7——两档不同，不能混用；
 *   ② D/λ > 100 档在 10°–34.1° 是 **34 − 30 lgφ**（比 29 − 25 lgφ 掉得快），
 *      且远旁瓣分三段 −12 / −7 / −12，不是单一平台。
 *
 * Gmax 是本建议书自洽的**参考**峰值（由 D/λ 定，隐含一个效率），不是用户那副天线的实测
 * 增益。故返回值里 gmaxRef 与 gain 一并给出——需要「鉴别度」时用 gmaxRef − gain，
 * 需要绝对增益时直接用 gain（参考图的用法即如此）。
 *
 * 适用范围外返回 null，由调用方回退到 AP8：
 *   · D/λ < 20              建议书自身的下界
 *   · freqGHz 在 10.7–30 之外  同上（**freqGHz 不给则不校验**，兼容只关心口径比的调用方）
 *
 * @returns {{gain:number, gmaxRef:number, g1:number, phiM:number, phiR:number|null}|null}
 */
function offAxisS1428(diameterM, wavelengthM, phiDeg, freqGHz) {
  const D = Number(diameterM), lam = Number(wavelengthM);
  if (!(D > 0) || !(lam > 0)) return null;
  const f = Number(freqGHz);
  // 频段校验只在调用方给了频率时做：拿不到频率就无从判断，不能假装它落在范围内
  if (Number.isFinite(f) && (f < S1428_F_LO_GHZ || f > S1428_F_HI_GHZ)) return null;
  const r = D / lam;
  if (r < 20) return null;                       // 建议书不覆盖，调用方回退
  const phi = Math.max(0, Math.min(180, Number(phiDeg) || 0));

  let gmaxRef, g1, phiR = null;
  if (r > 100) {
    gmaxRef = 20 * LOG10(r) + 8.4;
    g1 = -1 + 15 * LOG10(r);
    phiR = 15.85 * Math.pow(r, -0.6);
  } else {
    gmaxRef = 20 * LOG10(r) + 7.7;
    g1 = 29 - 25 * LOG10(95 / r);                // = 29 − 25 lg(95λ/D)
  }
  const phiM = (20 / r) * Math.sqrt(Math.max(0, gmaxRef - g1));

  let gain;
  if (r > 100) {
    if (phi < phiM) gain = gmaxRef - 2.5e-3 * Math.pow(r * phi, 2);
    else if (phi < phiR) gain = g1;
    else if (phi < 10) gain = 29 - 25 * LOG10(phi);
    else if (phi < 34.1) gain = 34 - 30 * LOG10(phi);
    else if (phi < 80) gain = -12;
    else if (phi < 120) gain = -7;
    else gain = -12;
  } else if (r > 25) {
    const phiSide = 95 / r;
    if (phi < phiM) gain = gmaxRef - 2.5e-3 * Math.pow(r * phi, 2);
    else if (phi < phiSide) gain = g1;
    else if (phi <= 33.1) gain = 29 - 25 * LOG10(phi);
    else if (phi <= 80) gain = -9;
    else if (phi <= 120) gain = -4;
    else gain = -9;
  } else {
    // 20 ≤ D/λ ≤ 25：远旁瓣是 −9 / −5 两段（注意 −5，与上一档的 −4 不同）
    const phiSide = 95 / r;
    if (phi < phiM) gain = gmaxRef - 2.5e-3 * Math.pow(r * phi, 2);
    else if (phi < phiSide) gain = g1;
    else if (phi < 33.1) gain = 29 - 25 * LOG10(phi);
    else if (phi <= 80) gain = -9;
    else gain = -5;
  }
  return { gain, gmaxRef, g1, phiM, phiR };
}

/**
 * 统一入口：按场景选包络。
 *
 * ─── S.1428 分支为什么走「鉴别度」而不是绝对增益 ─────────────────────────────
 * S.1428 的 Gmax 是建议书自洽的**参考**峰值（20lg(D/λ)+7.7 或 +8.4，隐含 η≈70%），
 * 与用户填的那副天线的实测峰值（20lg(πD/λ)+10lg η）不是一个量。
 * 首版此处直接返回 s.gain（绝对增益），于是 C 侧用 gPeak(η)、I 侧用与 η 无关的 Gmax 基准，
 * η 就成了 C/I 的杠杆：η 从 65% 改到 50%，C/I 恰好掉 10lg(0.65/0.50)=1.14 dB——
 * 纯粹来自两套增益基准混用，不是物理。
 * 现改为 G(φ) = gPeak(η) − [Gmax_ref − G_ref(φ)]：把建议书当**鉴别度包络**用，
 * η 同时作用于 C 与 I，两边对消。AP8 分支（offAxisAP8）本来就自洽，不受影响。
 *
 * @param {'peak'|'average'} kind 'peak' = GEO 静态（AP8/S.580）；'average' = NGSO 动态（S.1428）
 * @param {number} [freqGHz] 给了才校验 S.1428 的 10.7–30 GHz 适用频段（见 offAxisS1428）
 */
function earthStationOffAxis(kind, diameterM, wavelengthM, efficiency, phiDeg, freqGHz) {
  if (kind === 'average') {
    const s = offAxisS1428(diameterM, wavelengthM, phiDeg, freqGHz);
    if (s) {
      const gPeak = peakGainDbi(diameterM, wavelengthM, efficiency);
      // 结合次序写成 (gPeak − gmaxRef) + gain，与 makeEarthStationOffAxis 的预解析版逐位一致
      // ——那边把 (gPeak − gmaxRef) 提成了循环外常量，两处必须是同一个浮点表达式
      return gPeak == null ? s.gain : (gPeak - s.gmaxRef) + s.gain;
    }
    // D/λ < 20 或 10.7–30 GHz 之外：S.1428 不适用，退回峰值包络（偏保守，但有出处）
  }
  return offAxisAP8(diameterM, wavelengthM, efficiency, phiDeg);
}

/**
 * 本副天线在本频率上**实际会走哪条包络**——与 φ 无关，故每次扫描只需算一次。
 * 调用方据此告警：退回 AP8 是有出处的保守选择，但用户得知道自己看的不是 S.1428。
 *
 * @returns {{kind, applied:'S.1428-1'|'AP8/S.580', fellBack:boolean, reason:string|null,
 *            dOverLambda:number|null, freqGHz:number|null}}
 */
function earthStationPatternInfo(kind, diameterM, wavelengthM, freqGHz) {
  const D = Number(diameterM), lam = Number(wavelengthM), f = Number(freqGHz);
  const r = (D > 0 && lam > 0) ? D / lam : null;
  const out = {
    kind: kind === 'average' ? 'average' : 'peak',
    applied: 'AP8/S.580', fellBack: false, reason: null,
    dOverLambda: r, freqGHz: Number.isFinite(f) ? f : null
  };
  if (out.kind !== 'average') return out;
  if (r != null && r < 20) {
    out.fellBack = true;
    out.reason = `D/λ = ${r.toFixed(1)} < 20，超出 ITU-R S.1428-1 的适用范围`;
    return out;
  }
  if (Number.isFinite(f) && (f < S1428_F_LO_GHZ || f > S1428_F_HI_GHZ)) {
    out.fellBack = true;
    out.reason = `${f} GHz 在 ITU-R S.1428-1 的适用频段 ${S1428_F_LO_GHZ}–${S1428_F_HI_GHZ} GHz 之外`;
    return out;
  }
  out.applied = 'S.1428-1';
  return out;
}

/**
 * 热路径用的预解析版：包络选择、Gmax 参考基准、鉴别度偏置都只与 (kind, D, λ, η, f) 有关，
 * 与 φ 无关——NGSO 扫描里 earthStationOffAxis 每颗星每时刻调一次，把这些常量提到循环外。
 *
 * ⚠️ 与 earthStationOffAxis 必须逐位一致：两者是同一口径的两种写法，改一处必改另一处。
 * interference.test.mjs 里有一条全角域逐点比对把这件事钉死。
 *
 * @returns {{info:object, gain:(phiDeg:number)=>number}}
 */
function makeEarthStationOffAxis(kind, diameterM, wavelengthM, efficiency, freqGHz) {
  const info = earthStationPatternInfo(kind, diameterM, wavelengthM, freqGHz);
  if (info.applied === 'S.1428-1') {
    const gPeak = peakGainDbi(diameterM, wavelengthM, efficiency);
    const ref0 = offAxisS1428(diameterM, wavelengthM, 0, freqGHz);
    if (ref0 && gPeak != null) {
      const off = gPeak - ref0.gmaxRef;          // 鉴别度偏置（见 earthStationOffAxis 头注）
      return { info, gain: (phi) => off + offAxisS1428(diameterM, wavelengthM, phi, freqGHz).gain };
    }
  }
  return { info, gain: (phi) => offAxisAP8(diameterM, wavelengthM, efficiency, phi) };
}

// ---------------------------------------------------------------------------
// 卫星侧天线 —— 无 GRD 时的兜底
// ---------------------------------------------------------------------------

/**
 * 高斯主瓣近似 G(φ) = Gpeak − 12·(φ/θ₃dB)²，旁瓣按 sidelobeFloorDb 截平。
 *
 * 【这不是 ITU-R S.672】。S.672 的分段参考图本模块暂未实现（其官方 PDF 抓取失败，
 * 不凭记忆写系数）。卫星侧增益的**主路径是 GRD 实测方向图**——本函数只在没有 GRD 时
 * 兜底，且仅主瓣内可信；离轴远了请务必导入 GRD，不要拿这条曲线当参考图用。
 * 调用方应把 approx:true 透传到 UI 上标明。
 */
function gaussianSatBeam(peakGainDbi_, beamwidth3dBDeg, phiDeg, sidelobeFloorDb) {
  const gp = Number(peakGainDbi_), th = Number(beamwidth3dBDeg), phi = Math.abs(Number(phiDeg) || 0);
  if (!Number.isFinite(gp) || !(th > 0)) return null;
  const floor = Number.isFinite(Number(sidelobeFloorDb)) ? Number(sidelobeFloorDb) : gp - 30;
  const g = gp - 12 * Math.pow(phi / th, 2);
  return { gain: Math.max(floor, g), approx: true };
}

// ---------------------------------------------------------------------------
// ITU-R S.524-9 离轴 EIRP 密度掩模 —— 上行 C/ASI 的干扰源上限
// ---------------------------------------------------------------------------
//
// 用法与语义：这是地球站**不得超过**的发射上限。把它当干扰源模型，等于假设邻网每一座站
// 都正好顶着限值发——给出的是最坏情形 C/ASI。这是刻意的保守选择：真算 C/ASI 需要邻网每
// 座站的口径/功率/位置，工程上拿不到；顶着限值算是行业通行做法，也是协调谈判的基准口径。
//
// 分段形状（各频段共用）：
//   φ < φ0        A − 25 lg(φ0)      （主瓣区不设限，按 φ0 处的值钳住）
//   φ0 ≤ φ < 7°   A − 25 lg φ
//   7° ≤ φ < 9.2° P                  （平台）
//   9.2° ≤ φ < 48° B − 25 lg φ
//   φ ≥ 48°       F                  （底板）
//
// ─── 数值出处：ITU-R S.524-9 (2006) 正文逐条核对 ──────────────────────────────
//
// 建议书**只覆盖三个频段组**（这一点极易被忽略，导致把外推值当成 S.524 引用）：
//   recommends 2    5.725–7.075 GHz（1988 年后新装天线）  32/11/35/−7  dB(W/4 kHz)  φ₀=2.5°
//   recommends 3.1  12.75–13.25 与 13.75–14.5 GHz         39/18/42/0   dB(W/40 kHz) φ₀=2.5°
//   recommends 4    27.5–30 GHz                            19/−2/22/−10 dB(W/40 kHz) φ₀=2.0°
// 分段形状统一为：
//   φ₀ ≤ φ ≤ 7°   A − 25 lgφ ；7° < φ ≤ 9.2°  P ；9.2° < φ ≤ 48°  B − 25 lgφ ；φ > 48°  F
//
// 【2026-07-26 统一】此前 utils/linkCalculator.js 与 linkCalculatorNGSO.js 各抄了一份表，
// 其 C 频段为 26/5/29/−7 —— A、平台、B 三项**整体低 6 dB**（正确值 32/11/35）。Ku 与 Ka 两组
// 与建议书一致。已按建议书订正并把两个引擎的内联表统一到本函数，不再各存一份。
//
// φ < φ₀：建议书原文是「at any angle φ which is 2.5° or more off the main lobe axis」——
// 即主瓣内**根本不设限**，不是限值更高。故此处按 φ₀ 处的值连续钳住并置 belowScope=true，
// 由调用方决定是显示「不适用」还是照用钳位值。引擎旧实现在此处用 A+9，无出处，已废。
//
// 建议书未覆盖的频段（X / 10.7–11.7 / 17.3–18.4 / Q / V / 低C 等）保留原有数值不动
// （避免无据改动引起回归），但一律置 authoritative=false —— 它们是按邻近频段外推的工程值，
// 不是 S.524 正文，UI 与报表不得标成「ITU-R S.524-9」。

// [fLo, fHi, φ0, A, P, B, F, 参考带宽Hz, 标签, 是否建议书正文]
const S524_BANDS = [
  // —— ITU-R S.524-9 正文明列 ——
  [5.725, 7.075, 2.5, 32, 11, 35, -7, 4e3, 'C (S.524-9 rec.2)', true],
  [12.75, 13.25, 2.5, 39, 18, 42, 0, 4e4, 'Ku 13G (S.524-9 rec.3.1)', true],
  [13.75, 14.5, 2.5, 39, 18, 42, 0, 4e4, 'Ku 14G (S.524-9 rec.3.1)', true],
  [27.5, 30.0, 2.0, 19, -2, 22, -10, 4e4, 'Ka (S.524-9 rec.4)', true],
  // —— 建议书未覆盖，按邻近频段外推的工程值（数值沿用引擎旧表，不改） ——
  [5.091, 5.25, 2.5, 25, 4, 28, -8, 4e3, '低C 航空移动（外推）', false],
  [7.9, 8.4, 2.5, 24, 3, 27, -9, 4e3, 'X（外推）', false],
  [10.7, 11.7, 2.5, 38, 17, 41, -1, 4e4, '10.7–11.7 馈线（外推）', false],
  [17.3, 18.4, 2.5, 35, 14, 38, -4, 4e4, 'Ka低 BSS馈线（外推）', false],
  [30.0, 31.0, 2.0, 19, -2, 22, -10, 4e4, '30–31 GHz（按 Ka 外推）', false],
  [42.5, 43.5, 2.0, 33, 12, 36, -6, 1e6, 'Q（外推）', false],
  [47.2, 50.2, 2.0, 30, 9, 33, -9, 1e6, 'V（外推）', false],
  [50.4, 51.4, 2.0, 28, 7, 31, -11, 1e6, 'V高（外推）', false]
];

// 频段表未命中时的兜底（按频率量级挑一条形状相近的）——一律非权威
const S524_FALLBACK = [
  [0, 3, 2.5, 33, 12, 36, -6, 4e3, '<3 GHz（按 L/S 外推）', false],
  [3, 10, 2.5, 32, 11, 35, -7, 4e3, '3–10 GHz（按 C 外推）', false],
  [10, 20, 2.5, 39, 18, 42, 0, 4e4, '10–20 GHz（按 Ku 外推）', false],
  [20, 40, 2.0, 19, -2, 22, -10, 4e4, '20–40 GHz（按 Ka 外推）', false],
  [40, 1e4, 2.0, 30, 9, 33, -9, 1e6, '>40 GHz（按 V 外推）', false]
];

/**
 * 离轴 EIRP 密度上限。
 * @returns {{limitDb, refBwHz, densityDbWPerHz, band, authoritative, fallback, belowScope, phi0}|null}
 *   limitDb          该参考带宽内的上限 dBW/refBW
 *   densityDbWPerHz  换算到每 Hz 的谱密度 dBW/Hz —— C/ASI 直接吃这个
 *   authoritative    true = ITU-R S.524-9 正文；false = 按邻近频段外推的工程值
 *   belowScope       true = φ < φ₀，落在建议书不设限的主瓣区（值按 φ₀ 处连续钳住）
 */
function s524OffAxisEirpDensity(phiDeg, freqGHz) {
  const f = Number(freqGHz);
  if (!(f > 0)) return null;
  let b = null, fallback = false;
  for (const x of S524_BANDS) if (f >= x[0] && f <= x[1]) { b = x; break; }
  if (!b) { for (const x of S524_FALLBACK) if (f >= x[0] && f < x[1]) { b = x; fallback = true; break; } }
  if (!b) return null;

  const [, , phi0, A, P, B, F, refBwHz, label, authoritative] = b;
  const phi = Number(phiDeg);
  if (!Number.isFinite(phi)) return null;

  const belowScope = phi < phi0;
  let limitDb;
  if (belowScope) limitDb = A - 25 * LOG10(phi0);       // 建议书在主瓣内不设限，按 φ₀ 处连续钳住
  else if (phi <= 7) limitDb = A - 25 * LOG10(phi);
  else if (phi <= 9.2) limitDb = P;
  else if (phi <= 48) limitDb = B - 25 * LOG10(phi);
  else limitDb = F;

  return {
    limitDb,
    refBwHz,
    densityDbWPerHz: limitDb - 10 * LOG10(refBwHz),
    band: label,
    authoritative: !!authoritative,
    fallback,
    belowScope,
    phi0
  };
}

/** dBW/4kHz 口径（两个链路预算引擎的既有出参单位）。 */
function s524LimitPer4kHz(phiDeg, freqGHz) {
  const r = s524OffAxisEirpDensity(phiDeg, freqGHz);
  return r ? { ...r, limit4kHz: r.densityDbWPerHz + 10 * LOG10(4000) } : null;
}

module.exports = {
  peakGainDbi, beamwidth3dB,
  offAxisAP8, offAxisS1428, earthStationOffAxis, earthStationPatternInfo, makeEarthStationOffAxis,
  S1428_F_LO_GHZ, S1428_F_HI_GHZ,
  gaussianSatBeam,
  s524OffAxisEirpDensity, s524LimitPer4kHz, S524_BANDS
};
