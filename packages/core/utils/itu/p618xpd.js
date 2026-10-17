// itu/p618xpd.js — ITU-R P.618-14 §4.1 雨致去极化 XPD（含 4~6 GHz 按 6 GHz 重算再 §4.3 标度）
//
// 另含 GEO 极化偏转角（XPD 的 τ 由它给出）。
// 2026-10-17 由 linkCalculator.js / linkCalculatorNGSO.js 两份逐字相同的副本抽出（C-16）。
// 注：NGSO 引擎的极化偏转角至今写死 0（线极化 XPD 取最乐观界），属既有口径，不在本模块。

const { scaleRainAttenP618_14, calculateSinglePathRainAttenuation } = require('./p618rain.js');

/**
 * GEO 极化偏转角（度）
 */
function calculatePolarizationAngle(stationLon, stationLat, satLon) {
  const deltaLonRad = (stationLon - satLon) * Math.PI / 180;
  const latRad = stationLat * Math.PI / 180;
  const polarizationAngleRad = Math.atan(Math.sin(deltaLonRad) / Math.tan(latRad));
  const polarizationAngleDeg = polarizationAngleRad * 180 / Math.PI;
  return polarizationAngleDeg;
}

/**
 * 4~6 GHz 的雨致 XPD 专用：把同一条路径、同一时间百分比的雨衰重算到 6 GHz。
 *
 * 只换频率，站址/降雨率/极化/几何一律沿用本条链路的原值，故与主链路的雨衰同源同口径。
 * 缺上下文时显式抛错而不是退回「拿本频率雨衰硬算」——后者会静默高报 XPD 16~17 dB。
 *
 * @param {number} p       时间百分比（%），与主链路同值
 * @param {number} elevDeg 路径仰角（度）
 * @param {object} ctx     {R001, pol, lat, lon, orbitPos, altitude, elevOverride}
 * @returns {number} 6 GHz 上超过 p% 时间的同极化雨衰（dB）
 */
function rainAttenAt6GHz(p, elevDeg, ctx) {
  if (!ctx || !(Number(ctx.R001) > 0)) {
    throw new Error('4~6 GHz 的雨致 XPD 需按 6 GHz 重算雨衰：请给 calculateRainXPD_P618_14 传 rainCtx（R001/pol/lat/lon/orbitPos/altitude）');
  }
  const { A001 } = calculateSinglePathRainAttenuation(
    ctx.R001, 6, ctx.pol, ctx.lat, ctx.lon, ctx.orbitPos, ctx.altitude, ctx.elevOverride
  );
  return scaleRainAttenP618_14(A001, p, ctx.lat, elevDeg);
}

/**
 * ITU-R P.618-14 §4.1：由同极化降雨衰减统计估算去极化（交叉极化鉴别度 XPD）
 *
 * 适用范围：8 ≤ f ≤ 35 GHz（频率项 Cf 给出的扩展范围为 6 ≤ f ≤ 55 GHz），θ ≤ 60°。
 * 严格按照电联（ITU-R P.618-14）规定的 8 个步骤实现，结果为 p% 时间不被超过的 XPD。
 *
 * @param {number} Ap      超过 p% 时间的同极化降雨衰减（CPA，dB），与 XPD 同一时间百分比
 * @param {number} freq    频率（GHz）
 * @param {number} tauDeg  线极化电场矢量相对当地水平方向的倾斜角 τ（度），圆极化取 45°
 * @param {number} elevDeg 路径仰角 θ（度）
 * @param {number} p       时间百分比（%）
 * @param {object} [rainCtx] 4~6 GHz 专用的雨衰上下文 {R001, pol, lat, lon, orbitPos, altitude, elevOverride}，
 *                           字段与 calculateSinglePathRainAttenuation 的入参一一对应。f≥6 GHz 时不使用。
 * @returns {number} XPDp（dB）；无降雨或参数无效时返回 Infinity（表示无去极化效应）
 */
function calculateRainXPD_P618_14(Ap, freq, tauDeg, elevDeg, p, rainCtx) {
  // 无降雨衰减或参数无效 → 不产生雨致去极化
  if (!(Ap > 0) || !(freq > 0) || !(p > 0)) return Infinity;

  // §4.1 频率下界 6 GHz：4~6 GHz 按 §4.3 式(79) 半经验频率标度 XPD₂ = XPD₁ − 20·lg(f₂/f₁)
  // 从域内 6 GHz 换算（直接把 f<6 代入 Cf=60·lgf−28.3 属域外使用）；
  // f<4 GHz 超出该标度的下界，返回 Infinity（不计雨致去极化）。
  //
  // ★ 换算的是「6 GHz 上的 XPD」，故喂进 §4.1 的必须是 **6 GHz 上的**同极化雨衰：
  //   Step 2 的 CA = V(f)·lg(Ap) 里 V(6)=21.6 配套的就是 6 GHz 的 CPA 统计，
  //   建议书 Step 8 后另有明文——4~6 GHz 路径衰减很低、其 Ap 统计不足以预测 XPD，
  //   须由 6 GHz 的结果标度下来。C 频段雨衰随频率极陡（P.838 比衰减 γ(6)/γ(4)≈6），
  //   沿用本频率那个小雨衰会把 CA 少算十几 dB、XPD 高报 16~17 dB（形同「雨天不去极化」）。
  //   注：§2.4.1 的长期雨衰频率标度式在此段不可用（4→6 GHz 它给 ×2.2，实际 ×6，其适用域自 7 GHz 起）。
  if (freq < 4) return Infinity;
  if (freq < 6) {
    const ap6 = rainAttenAt6GHz(p, elevDeg, rainCtx);
    if (!(ap6 > 0)) return Infinity;
    const xpd6 = calculateRainXPD_P618_14(ap6, 6, tauDeg, elevDeg, p, rainCtx);
    return isFinite(xpd6) ? xpd6 - 20 * Math.log10(freq / 6) : xpd6;
  }

  // 方法有效仰角范围 θ ≤ 60°，超出则限幅到 60°
  const theta = Math.min(Math.max(elevDeg, 0), 60);
  const D2R = Math.PI / 180;

  // Step 1: 频率相关项 Cf —— ITU-R P.618-14 §4.1 Step 1，按频段分三式
  //   6 ≤ f < 9 :  60·log f − 28.3
  //   9 ≤ f < 36:  26·log f + 4.1
  //   36 ≤ f ≤ 55: 35.9·log f − 11.3
  let Cf;
  if (freq < 9)        Cf = 60 * Math.log10(freq) - 28.3;
  else if (freq < 36)  Cf = 26 * Math.log10(freq) + 4.1;
  else                 Cf = 35.9 * Math.log10(freq) - 11.3;

  // Step 2: 降雨衰减相关项 CA = V(f)·log(Ap) —— ITU-R P.618-14 §4.1 Step 2，按频段分四式
  //   6 ≤ f < 9 :  V = 30.8·f^(−0.21)
  //   9 ≤ f < 20:  V = 12.8·f^0.19
  //   20 ≤ f < 40: V = 22.6
  //   40 ≤ f ≤ 55: V = 13.0·f^0.15
  let Vf;
  if (freq < 9)        Vf = 30.8 * Math.pow(freq, -0.21);
  else if (freq < 20)  Vf = 12.8 * Math.pow(freq, 0.19);
  else if (freq < 40)  Vf = 22.6;
  else                 Vf = 13.0 * Math.pow(freq, 0.15);
  const CA = Vf * Math.log10(Ap);

  // Step 3: 极化改善因子 Cτ = -10·log[1 - 0.484·(1 + cos4τ)]
  //   τ=0°(水平) 或 τ=90°(垂直) → Cτ ≈ 15 dB；τ=45°(圆极化) → Cτ = 0
  const Ctau = -10 * Math.log10(1 - 0.484 * (1 + Math.cos(4 * tauDeg * D2R)));

  // Step 4: 仰角相关项 Cθ = -40·log(cosθ) （θ ≤ 60°）
  const Ctheta = -40 * Math.log10(Math.cos(theta * D2R));

  // Step 5: 雨滴倾角分布相关项 Cσ = 0.0053·σ² —— ITU-R P.618-14 §4.1 Step 5，σ 按时间百分比离散取值
  //   σ(°)：p≤0.001%→15；p≤0.01%→10；p≤0.1%→5；其余→0
  let sigma;
  if (p <= 0.001)      sigma = 15;
  else if (p <= 0.01)  sigma = 10;
  else if (p <= 0.1)   sigma = 5;
  else                 sigma = 0;
  const Csigma = 0.0053 * sigma * sigma;

  // Step 6: 降雨去极化 XPDrain = Cf - CA + Cτ + Cθ + Cσ （dB）
  const XPDrain = Cf - CA + Ctau + Ctheta + Csigma;

  // Step 7: 冰晶相关项 Cice = XPDrain·(0.3 + 0.1·log p)/2 （dB）
  const Cice = XPDrain * (0.3 + 0.1 * Math.log10(p)) / 2;

  // Step 8: 含冰晶效应的 XPD（p% 时间不被超过的 XPD）
  return XPDrain - Cice;
}

module.exports = { calculatePolarizationAngle, rainAttenAt6GHz, calculateRainXPD_P618_14 };
