// itu/p840.js — ITU-R P.840-9 云衰（K_l 介电模型 / K_L 质量吸收系数 / 对数正态 L_red / 斜路径云衰）
//
// 2026-10-17 由 linkCalculator.js / linkCalculatorNGSO.js 两份逐字相同的副本抽出（C-16），
// 同日补上 P.840-9 式(12)/(14)/(16) 的 K_L 修正（C-04；2026-08 审计待修 #4）。
//
// 口径（如实）：
//   · K_L(f) = K_l(f, 273.75 K) × [A1·e^(−(f−f1)²/σ1) + A2·e^(−(f−f2)²/σ2) + A3]——式(12)(14)(16) 三处同一式；
//     原实现用 K_l(f, 273.15 K) 且不乘修正因子，6~45 GHz 偏高 7.7~9.1%。
//   · 统计法用 §3.3 对数正态（L_red 参数图）。P.840-9 推荐条款 2 规定统计预测用 §3.2（§4 的 L(p) 年/月数字图，
//     L 对 log p 线性插值），§3.3 是「供 P.1853 使用」的近似；两法本身差 30~40%。本平台暂只打包了 §3.3 参数图。
//   · p < 1% 时 L 取 1% 值：这是 P.618-13 §2.5 的旧封顶口径（P.618-14 §2.5 式(67) 已改为 A_C(p)=A_C(5%)），
//     用户 2026-07-23 拍板保留，故此处不动。

const CLOUD_GRID = require('../../data/cloudParamsGrid.js'); // ITU-R P.840-9 Lred 对数正态参数地图

// P.840-9 式(12)(14)(16) 的修正因子系数
const KL_A1 = 0.1522, KL_A2 = 11.51, KL_A3 = -10.4912;
const KL_F1 = -23.9589, KL_F2 = 219.2096;
const KL_S1 = 3.2991e3, KL_S2 = 2.7595e6;
const KL_T = 273.75; // K

/**
 * 反误差函数 erfinv（Giles 2010 近似），用于对数正态分位数反算
 */
function erfinv(x) {
  const w0 = -Math.log((1 - x) * (1 + x));
  let p, w;
  if (w0 < 5) {
    w = w0 - 2.5;
    p = 2.81022636e-08;
    p = 3.43273939e-07 + p * w;
    p = -3.5233877e-06 + p * w;
    p = -4.39150654e-06 + p * w;
    p = 0.00021858087 + p * w;
    p = -0.00125372503 + p * w;
    p = -0.00417768164 + p * w;
    p = 0.246640727 + p * w;
    p = 1.50140941 + p * w;
  } else {
    w = Math.sqrt(w0) - 3;
    p = -0.000200214257;
    p = 0.000100950558 + p * w;
    p = 0.00134934322 + p * w;
    p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w;
    p = -0.0076224613 + p * w;
    p = 0.00943887047 + p * w;
    p = 1.00167406 + p * w;
    p = 2.83297682 + p * w;
  }
  return p * x;
}
function erfcinv(y) {
  return erfinv(1 - y);
}

/**
 * ITU-R P.840-9 比衰减系数 Kl（瑞利近似，双 Debye 水介电模型，<1000 GHz）
 *   Kl = 0.819·f / [ε″·(1+η²)]，η=(2+ε′)/ε″，单位 (dB/km)/(g/m³)
 * @param {number} f 频率 GHz
 * @param {number} T 温度 K（云默认 273.15）
 */
function cloudSpecificAttenuation(f, T) {
  const theta = 300 / T;
  const d = theta - 1;
  const e0 = 77.66 + 103.3 * d;
  const e1 = 0.0671 * e0;
  const e2 = 3.52;
  const fp = 20.20 - 146 * d + 316 * d * d;  // 主弛豫频率 GHz
  const fs = 39.8 * fp;                       // 次弛豫频率 GHz
  const rp = f / fp, rs = f / fs;
  const eImag = f * (e0 - e1) / (fp * (1 + rp * rp)) +
                f * (e1 - e2) / (fs * (1 + rs * rs));
  const eReal = (e0 - e1) / (1 + rp * rp) +
                (e1 - e2) / (1 + rs * rs) + e2;
  const eta = (2 + eReal) / eImag;
  return 0.819 * f / (eImag * (1 + eta * eta));
}

/**
 * ITU-R P.840-9 云液态水质量吸收系数 K_L(f)，式(12)/(14)/(16)（三式相同）
 *   K_L(f) = K_l(f, T = 273.75 K) · [A1·e^(−(f−f1)²/σ1) + A2·e^(−(f−f2)²/σ2) + A3]
 *   A1 = 0.1522, A2 = 11.51, A3 = −10.4912；f1 = −23.9589, f2 = 219.2096；σ1 = 3.2991×10³, σ2 = 2.7595×10⁶
 * ValEx Rev 8.3.0「P.840-9 A_Clouds」K_L(6/15/30/45 GHz) = 0.0311277818545 / 0.190113349078 / 0.707853958387 / 1.44305988658。
 * @param {number} f 频率 GHz（1~200）
 * @returns {number} dB/(kg/m²)，即 dB/mm
 */
function cloudMassAbsorptionKL(f) {
  const corr = KL_A1 * Math.exp(-((f - KL_F1) * (f - KL_F1)) / KL_S1)
             + KL_A2 * Math.exp(-((f - KL_F2) * (f - KL_F2)) / KL_S2)
             + KL_A3;
  return cloudSpecificAttenuation(f, KL_T) * corr;
}

/**
 * 对数正态法求液态水柱含量 Lred(p)（完全符合 P.840-9）
 *   Lred = exp(m + σ·√2·erfcinv(2p/Pclw))，p<Pclw；否则 0
 * @param {number} pPercent 超越概率 %
 * @param {{m:number,sigma:number,Pclw:number}} params Pclw 单位 %
 * @returns {number} kg/m²
 */
function cloudLWCFromLognormal(pPercent, params) {
  const Pclw = params.Pclw;
  if (!(Pclw > 0) || pPercent >= Pclw) return 0;  // 云出现概率不足 → 无云
  const arg = 2 * pPercent / Pclw;                 // ∈(0,2)
  return Math.exp(params.m + params.sigma * Math.SQRT2 * erfcinv(arg));
}

/**
 * 云液态水柱含量 L(p) - 工程保守回退表（官方 Lred 地图未导入时使用），kg/m²
 * - p ≤ 1%：封顶在 1% 值（保守取湿润端）；1%~50% 线性递减；≥50% 取下限
 * @param {number} p 超越概率 %
 */
function getCloudLWC(p) {
  const tbl = [
    { p: 1,  L: 1.6 },   // 封顶值：所有 p<1% 都用它
    { p: 5,  L: 1.0 },
    { p: 10, L: 0.7 },
    { p: 20, L: 0.45 },
    { p: 30, L: 0.3 },
    { p: 50, L: 0.2 },
  ];
  if (p <= 1)  return tbl[0].L;
  if (p >= 50) return tbl[tbl.length - 1].L;
  for (let i = 0; i < tbl.length - 1; i++) {
    const a = tbl[i], b = tbl[i + 1];
    if (p >= a.p && p <= b.p) {
      return a.L + (b.L - a.L) * (p - a.p) / (b.p - a.p);
    }
  }
  return tbl[0].L;
}

/**
 * 斜路径云衰减 —— ITU-R P.840-9 §3.3 对数正态近似（式 15/16），A_C = K_L(f)·L_red(p) / sinθ
 *   L_red(p) 优先取官方对数正态参数图（站点 lat/lon），图未导入时回退工程保守表 getCloudLWC。
 *   p < 1% 时 L 取 1% 值（P.618-13 旧封顶口径，用户 2026-07-23 拍板保留，见文件头）。
 * @param {number} frequency 频率 GHz
 * @param {number} elevation 仰角 度
 * @param {number} p 超越概率 %，= 100 - 可用度
 * @param {number} lat 地球站纬度（用于查 Lred 地图，可选）
 * @param {number} lon 地球站经度（用于查 Lred 地图，可选）
 * @param {number} [lFactor] 柱液态水保留比例 0~1（机载终端按 P.2041-1 §4.3 削减；缺省 1 = 地面站）
 */
function calculateCloudAttenuation(frequency, elevation, p, lat, lon, lFactor) {
  // 可用度 100% → p=0 → 视为晴天，不考虑云衰减
  if (p === null || p === undefined || p <= 0) return 0;
  if (!elevation || elevation <= 0) return 0;

  const pEff = Math.max(p, 1);  // p<1% 封顶在 1% 值

  // L：优先官方 Lred 对数正态地图，否则回退保守表
  let L = null;
  try {
    const params = (lat !== undefined && lon !== undefined && CLOUD_GRID && CLOUD_GRID.getParams)
      ? CLOUD_GRID.getParams(lat, lon) : null;
    if (params) L = cloudLWCFromLognormal(pEff, params);
  } catch (e) { /* 地图异常时静默回退 */ }
  if (L === null || L === undefined || isNaN(L)) L = getCloudLWC(pEff);

  const keep = (lFactor === undefined || lFactor === null || !isFinite(lFactor)) ? 1 : Math.max(0, Math.min(1, lFactor));
  if (keep <= 0) return 0;
  return cloudMassAbsorptionKL(frequency) * L * keep / Math.sin(elevation * Math.PI / 180);
}

module.exports = {
  erfinv, erfcinv, cloudSpecificAttenuation, cloudMassAbsorptionKL, cloudLWCFromLognormal, getCloudLWC,
  calculateCloudAttenuation
};
