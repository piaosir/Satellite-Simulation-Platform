// itu/p676.js — ITU-R P.676-13（08/2022）大气气体衰减：Annex 1 逐线法 + Annex 2 斜路径
//
// 原文核对：R-REC-P.676-13-202208-I!!PDF-E.pdf（2026-10-17 下载）——Annex 1 式(1)~(9)、§2.2.1 式(11)~(19)，
//   Annex 2 式(29)~(43)；Part 1 / Part 2 系数（p676Data.js）与 ITU 官方数据文件
//   https://www.itu.int/oth/R1101000002/en（R11010000020001TXTM.txt / …0002TXTM.txt）逐行一致；
//   谱线表见 p676Lines.js。验证：ValEx Rev 8.3.0 的 P.676-13 六张表（packages/core/test/ituP676.test.mjs）。
//
// 2026-10-17 订正（C-01）：比衰减由 P.676-9/10 已删除的旧闭式（式 22/23）改为 Annex 1 逐线求和——
//   旧闭式在 12/90/130 GHz 的 γ_w 偏高 11.5~12.8%、90 GHz 的 γ_o 偏低 19%，ValEx 瞬时算例偏高 11.7~13.7%。
//
// 本模块只放公式（不碰数字图）；按站址取统计气象参数、机载修正在 gasSite.js。

const { P676_PART1, P676_PART2 } = require('../p676Data.js');
const { OXYGEN_LINES, WATER_VAPOUR_LINES } = require('./p676Lines.js');
const p835 = require('./p835.js');

const RE_LAYER = 6371;   // km，Annex 1 §2.2.1 平均地球半径

// ═══════════════════ Annex 1 §1：比衰减（逐线求和） ═══════════════════

/**
 * 干空气（氧气 + 氮压致吸收 + 非谐振 Debye）比衰减 γ_o，dB/km —— 式 (1)(2a)(3)(5)~(9)
 * @param {number} f 频率 GHz
 * @param {number} p 干空气压 hPa
 * @param {number} e 水汽分压 hPa
 * @param {number} T 温度 K
 */
function gammaOxygen(f, p, e, T) {
  const th = 300 / T;
  let N = 0;
  for (let i = 0; i < OXYGEN_LINES.length; i++) {
    const [fi, a1, a2, a3, a4, a5, a6] = OXYGEN_LINES[i];
    const S = a1 * 1e-7 * p * th * th * th * Math.exp(a2 * (1 - th));                    // (3)
    let df = a3 * 1e-4 * (p * Math.pow(th, 0.8 - a4) + 1.1 * e * th);                    // (6a)
    df = Math.sqrt(df * df + 2.25e-6);                                                     // (6b) 塞曼分裂
    const dl = (a5 + a6 * th) * 1e-4 * (p + e) * Math.pow(th, 0.8);                       // (7)
    const F = f / fi * ((df - dl * (fi - f)) / ((fi - f) * (fi - f) + df * df)
                      + (df - dl * (fi + f)) / ((fi + f) * (fi + f) + df * df));          // (5)
    N += S * F;
  }
  const d = 5.6e-4 * (p + e) * Math.pow(th, 0.8);                                         // (9)
  const ND = f * p * th * th * (6.14e-5 / (d * (1 + (f / d) * (f / d)))
                               + 1.4e-12 * p * Math.pow(th, 1.5) / (1 + 1.9e-5 * Math.pow(f, 1.5)));   // (8)
  return 0.1820 * f * (N + ND);                                                            // (1)(2a)
}

/**
 * 水汽比衰减 γ_w，dB/km —— 式 (1)(2b)(3)(5)(6)（δ = 0）
 * @param {number} f 频率 GHz
 * @param {number} p 干空气压 hPa
 * @param {number} e 水汽分压 hPa
 * @param {number} T 温度 K
 */
function gammaWaterVapour(f, p, e, T) {
  const th = 300 / T;
  let N = 0;
  for (let i = 0; i < WATER_VAPOUR_LINES.length; i++) {
    const [fi, b1, b2, b3, b4, b5, b6] = WATER_VAPOUR_LINES[i];
    const S = b1 * 1e-1 * e * Math.pow(th, 3.5) * Math.exp(b2 * (1 - th));               // (3)
    let df = b3 * 1e-4 * (p * Math.pow(th, b4) + b5 * e * Math.pow(th, b6));             // (6a)
    df = 0.535 * df + Math.sqrt(0.217 * df * df + 2.1316e-12 * fi * fi / th);           // (6b) 多普勒展宽
    const F = f / fi * (df / ((fi - f) * (fi - f) + df * df) + df / ((fi + f) * (fi + f) + df * df));   // (5)
    N += S * F;
  }
  return 0.1820 * f * N;                                                                   // (1)(2b)
}

/**
 * 由总气压 / 温度 / 水汽密度求两项比衰减（e = ρT/216.7，式 4；干空气压 p = P − e）
 * @returns {{gammaO:number, gammaW:number, p:number, e:number}}
 */
function specificAttenuation(f, Ptot, T, rho) {
  const e = rho * T / 216.7;
  const p = Ptot - e;
  return { gammaO: gammaOxygen(f, p, e, T), gammaW: gammaWaterVapour(f, p, e, T), p, e };
}

// ═══════════════════ Annex 2：斜路径（θ ≥ 5°） ═══════════════════

// Part 1 / Part 2 系数按频率线性插值（Part 1 含 118.75 GHz 附加行；表外夹到端点）
function interpPart(data, f) {
  const n = data.length;
  if (f <= data[0][0]) return [data[0][1], data[0][2], data[0][3], data[0][4]];
  if (f >= data[n - 1][0]) return [data[n - 1][1], data[n - 1][2], data[n - 1][3], data[n - 1][4]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (data[mid][0] <= f) lo = mid; else hi = mid; }
  const t = (f - data[lo][0]) / (data[hi][0] - data[lo][0]);
  return [1, 2, 3, 4].map((k) => data[lo][k] + t * (data[hi][k] - data[lo][k]));
}

/** 氧气等效高度 h_o，km —— 式 (31)/(34)：a₀ + b₀·T + c₀·P + d₀·ρ（P 为总气压） */
function oxygenEquivalentHeight(f, P, T, rho) {
  const [a0, b0, c0, d0] = interpPart(P676_PART1, f);
  return a0 + b0 * T + c0 * P + d0 * rho;
}

/** 水汽等效高度 h_w，km —— 式 (37)，Table 4 */
function waterVapourEquivalentHeight(f) {
  return 5.6585e-5 * f + 1.8348
    + 2.6846 / ((f - 22.235080) * (f - 22.235080) + 2.7649)
    + 5.8905 / ((f - 183.310087) * (f - 183.310087) + 4.9219)
    + 2.9810 / ((f - 325.152888) * (f - 325.152888) + 3.0748);
}

/** 水汽质量吸收系数 K_w，dB/(kg/m²) —— 式 (39)/(41)/(43)：a + b·ρ + c·T + d·P（Part 2 第 2~5 列） */
function waterVapourMassAbsorption(f, P, T, rho) {
  const [a, b, c, d] = interpPart(P676_PART2, f);
  return a + b * rho + c * T + d * P;
}

/**
 * 瞬时法（§1.1 + §2.1 方法 1）：地面实测 P/T/ρ → 斜路径气体衰减（θ ≥ 5°）
 * @returns {{Ao:number, Aw:number, A:number, gammaO:number, gammaW:number, ho:number, hw:number}} 天顶分量×1/sinθ 后的 dB
 */
function slantPathInstant(f, elDeg, Ptot, T, rho) {
  const g = specificAttenuation(f, Ptot, T, rho);
  const ho = oxygenEquivalentHeight(f, Ptot, T, rho);
  const hw = waterVapourEquivalentHeight(f);
  const s = Math.sin(elDeg * Math.PI / 180);
  const Ao = g.gammaO * ho / s, Aw = g.gammaW * hw / s;
  return { Ao, Aw, A: Ao + Aw, gammaO: g.gammaO, gammaW: g.gammaW, ho, hw };
}

/**
 * 统计法（§1.2 + §2.3）：γ_o 与 K_w 用年均地面气象，h_o 用 p 档地面气象，水汽用 p 档柱水汽 V(p)（θ ≥ 5°）
 * @param {object} q { f, el, P, T, rho（年均总气压/温度/水汽密度）, Pp, Tp, rhop（p 档）, V（p 档柱水汽 kg/m²） }
 */
function slantPathStatistical(q) {
  const g = specificAttenuation(q.f, q.P, q.T, q.rho);
  const ho = oxygenEquivalentHeight(q.f, q.Pp, q.Tp, q.rhop);
  const Kw = waterVapourMassAbsorption(q.f, q.P, q.T, q.rho);
  const s = Math.sin(q.el * Math.PI / 180);
  const Ao = g.gammaO * ho / s, Aw = Kw * q.V / s;
  return { Ao, Aw, A: Ao + Aw, gammaO: g.gammaO, ho, Kw };
}

/**
 * Weibull 近似（§2.4 式 42/43）：A_w = K_w·λ·(−ln(p/100))^(1/k) / sinθ（供 P.1853 用；链路预算不走此式）
 */
function weibullWaterVapour(f, elDeg, P, T, rho, pPct, lambda, k) {
  const Kw = waterVapourMassAbsorption(f, P, T, rho);
  return Kw * lambda * Math.pow(-Math.log(pPct / 100), 1 / k) / Math.sin(elDeg * Math.PI / 180);
}

// ═══════════════════ Annex 1 §2.2.1：分层射线（任意非负视仰角、任意起止高度） ═══════════════════

/**
 * P.835 参考大气、可按地面实况锚定的廓线：
 *   P(h) = P_ref(h)·(Ps / P_ref(hs))；T(h) = T_ref(h) + (Ts − T_ref(hs))·w(h)，w 在 hs 以下取 1、至 11 km 线性降到 0；
 *   ρ(h) = ρs·exp(−(h−hs)/H)，下限为混合比 2×10⁻⁶ 对应密度（P.835 式 6~8）。
 * 不给锚定值时即 P.835-7 Annex 1 原样（ρ₀ = 7.5 g/m³、H = 2 km，ValEx A1 用的就是它）。
 * @param {object} [a] { hs 锚定高度 km, Ps hPa, Ts K, rho g/m³, H km }
 * @returns {function(number):{P:number,T:number,rho:number}}
 */
function anchoredProfile(a) {
  a = a || {};
  const hs = Number.isFinite(a.hs) ? a.hs : 0;
  const kP = Number.isFinite(a.Ps) ? a.Ps / p835.refPressure(hs) : 1;
  const dT = Number.isFinite(a.Ts) ? a.Ts - p835.refTemperature(hs) : 0;
  const rho0 = Number.isFinite(a.rho) ? a.rho : 7.5 * Math.exp(-hs / 2);
  const H = Number.isFinite(a.H) && a.H > 0 ? a.H : 2;
  return (h) => {
    const P = p835.refPressure(h) * kP;
    const w = h <= hs ? 1 : (hs >= 11 ? 0 : Math.max(0, 1 - (h - hs) / (11 - hs)));
    const T = p835.refTemperature(h) + dT * w;
    const rho = Math.max(rho0 * Math.exp(-(h - hs) / H), 2e-6 * P * 216.7 / T);
    return { P, T, rho };
  };
}

// P.453-14 式 (1)(2)：n = 1 + N·10⁻⁶，N = 77.6·Pd/T + 72·e/T + 3.75×10⁵·e/T²
function refractiveIndex(Pd, e, T) {
  return 1 + 1e-6 * (77.6 * Pd / T + 72 * e / T + 3.75e5 * e / (T * T));
}

/**
 * 分层射线斜路径气体衰减 —— 式 (13)~(17)(19b)
 * @param {number} f       频率 GHz
 * @param {number} elDeg   起点视仰角（≥ 0）
 * @param {number} hLower  起点高度 km（≥ 0）
 * @param {number} hUpper  终点高度 km（≤ 100）
 * @param {function} [profile] h → {P 总气压 hPa, T K, rho g/m³}，缺省为 P.835 参考大气
 * @returns {{A:number, Ao:number, Aw:number, layers:number}}
 */
function slantPathLayered(f, elDeg, hLower, hUpper, profile) {
  const prof = profile || anchoredProfile();
  const h1 = Math.max(0, hLower || 0), h2 = Math.min(100, Number.isFinite(hUpper) ? hUpper : 100);
  if (!(h2 > h1)) return { A: 0, Ao: 0, Aw: 0, layers: 0 };
  const E1 = Math.exp(1 / 100) - 1;
  let iLo, iHi, m, base;
  if (h1 === 0 && h2 >= 100) {
    iLo = 1; iHi = 923; m = 1e-4; base = 0;                              // 式 (14)(15)，i_max = 922
  } else {
    iLo = Math.floor(100 * Math.log(1e4 * h1 * E1 + 1) + 1);              // (16a)
    iHi = Math.ceil(100 * Math.log(1e4 * h2 * E1 + 1) + 1);               // (16b)
    m = ((Math.exp(2 / 100) - Math.exp(1 / 100)) / (Math.exp(iHi / 100) - Math.exp(iLo / 100))) * (h2 - h1);   // (16c)
    base = h1;
  }
  const beta1 = (90 - Math.max(0, elDeg)) * Math.PI / 180;
  const eLo = Math.exp((iLo - 1) / 100);
  let n1r1 = NaN, Ao = 0, Aw = 0;
  for (let i = iLo; i < iHi; i++) {
    const ei = Math.exp((i - 1) / 100);
    const delta = m * ei;                                                  // (14) / (16c)
    const hi = base + m * (ei - eLo) / E1;                                 // (15) / (16d)
    const r = RE_LAYER + hi;
    const s = prof(hi + delta / 2);                                        // 层中点取值
    const e = s.rho * s.T / 216.7;
    const pd = s.P - e;
    const n = refractiveIndex(pd, e, s.T);
    if (!Number.isFinite(n1r1)) n1r1 = n * r * Math.sin(beta1);
    const sb = Math.min(1, n1r1 / (n * r));                                // (19b)
    const cb = Math.sqrt(Math.max(0, 1 - sb * sb));
    const a = -r * cb + Math.sqrt(r * r * cb * cb + 2 * r * delta + delta * delta);   // (17)
    Ao += a * gammaOxygen(f, pd, e, s.T);
    Aw += a * gammaWaterVapour(f, pd, e, s.T);
  }
  return { A: Ao + Aw, Ao, Aw, layers: iHi - iLo };
}

// 由地面气压反推参考大气中的同压高度（km）：瞬时调用方不给站高时用于分层廓线的起点
function heightFromPressure(Ps) {
  if (!(Ps > 0)) return 0;
  if (Ps >= p835.refPressure(0)) return 0;
  let lo = 0, hi = 30;
  for (let k = 0; k < 60; k++) { const mid = 0.5 * (lo + hi); if (p835.refPressure(mid) > Ps) lo = mid; else hi = mid; }
  return 0.5 * (lo + hi);
}

/**
 * 瞬时气体衰减（给定站址地面 P / T / ρ）：θ ≥ 5° 走 Annex 2 §1.1 + §2.1；θ < 5° 走 Annex 1 §2.2.1 分层射线
 * （廓线按地面实况锚定的 P.835 参考大气）；仰角缺省 / ≥ 90° 返回天顶值。实时气象分支与雨衰页对照项用。
 * @param {number} frequencyGHz 频率 GHz（1~350）
 * @param {number} [elevationDeg] 视仰角
 * @param {number} [Ps=1013.25] 地面总气压 hPa
 * @param {number} [Ts=288.15]  地面温度 K
 * @param {number} [rhoWs=20]   地面水汽密度 g/m³（缺省偏湿，保留旧兜底）
 * @param {object} [opt] { hsKm 站高（分层射线起点；缺省由 Ps 反推）, H 水汽标高 km }
 * @returns {number} dB
 */
function calculateAtmosphericAttenuation(frequencyGHz, elevationDeg, Ps, Ts, rhoWs, opt) {
  if (!isFinite(frequencyGHz) || frequencyGHz <= 0) return 0;
  if (elevationDeg !== undefined && elevationDeg !== null && !isFinite(elevationDeg)) elevationDeg = undefined;
  if (!Ps || !isFinite(Ps)) Ps = 1013.25;
  if (!Ts || !isFinite(Ts)) Ts = 288.15;
  if (rhoWs == null || !isFinite(rhoWs)) rhoWs = 20.0;
  const el = (elevationDeg === undefined || elevationDeg === null) ? 90 : Math.min(90, Math.max(0, elevationDeg));
  if (el >= 5) return slantPathInstant(frequencyGHz, el, Ps, Ts, rhoWs).A;
  const o = opt || {};
  const hs = Number.isFinite(o.hsKm) ? Math.max(0, o.hsKm) : heightFromPressure(Ps);
  return slantPathLayered(frequencyGHz, el, hs, 100, anchoredProfile({ hs, Ps, Ts, rho: rhoWs, H: o.H })).A;
}

module.exports = {
  gammaOxygen, gammaWaterVapour, specificAttenuation,
  oxygenEquivalentHeight, waterVapourEquivalentHeight, waterVapourMassAbsorption, interpPart,
  slantPathInstant, slantPathStatistical, weibullWaterVapour,
  anchoredProfile, refractiveIndex, slantPathLayered, heightFromPressure,
  calculateAtmosphericAttenuation
};
