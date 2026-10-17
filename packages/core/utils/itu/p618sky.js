// itu/p618sky.js — ITU-R P.618-14 §3 天空噪温（式 (69)(70)）单一真值源
//
//   T_sky = T_mr·(1 − 10^(−A/10)) + 2.7·10^(−A/10)        (69)
//   T_mr  = 37.34 + 0.81·T_s                               (70)  无地表温度时取 275 K
//
// A 是除闪烁以外的**总**大气衰减（A_G + A_C + A_R）。串联的吸收介质必须先把衰减合成再代入式(69)：
// 把气体、云、雨三项各按 T_mr·(1−10^(−A_i/10)) 算出再相加，等于假设每一层都直面冷空（2.7 K），
// 雨天会算出超过介质温度本身的天空亮温（广州 20 GHz 99.9%：分项相加 335.9 K，按式(69) 只有 268.0 K）。
//
// 平台的用法（GSO / NGSO 引擎与雨衰页同一口径）：
//   · 「自动」天线噪温 = T_sky(A_G) + 25 K（25 K 为地面溢出 / 旁瓣拾取的工程常数）；手填天线噪温视为晴空值。
//   · 云 / 雨的噪温抬升只取增量：ΔT_云 = T_sky(A_G+A_C) − T_sky(A_G)，ΔT_雨 = T_sky(A_G+A_C+A_R) − T_sky(A_G+A_C)，
//     二者之和 = T_sky(A_G+A_C+A_R) − T_sky(A_G)。增量经馈线折算后叠到系统噪温上，
//     雨致 G/T 劣化 = 10·lg(T_sys(雨) / T_sys(晴))。
//   · 可用度 100% 时 A_C = A_R = 0，两项增量恒为 0。

const T_MR_DEFAULT = 275;   // K，P.618-14 §3：无本地资料时的介质平均辐射温度
const T_COSMIC = 2.7;       // K，宇宙背景

/**
 * 介质平均辐射温度 T_mr（式 70）
 * @param {number} [Ts] 地表温度 K；缺省 / 非法时返回 275 K
 * @returns {number} K
 */
function meanRadiatingTemp(Ts) {
  return (Number.isFinite(Ts) && Ts > 0) ? 37.34 + 0.81 * Ts : T_MR_DEFAULT;
}

/**
 * 天空噪温 T_sky（式 69）
 * @param {number} A   除闪烁外的总大气衰减 dB（负值按 0）
 * @param {number} [Tmr] 介质平均辐射温度 K，缺省 275 K
 * @returns {number} K
 */
function skyNoiseTemp(A, Tmr) {
  const a = Math.pow(10, -Math.max(0, Number(A) || 0) / 10);
  const tmr = Number.isFinite(Tmr) ? Tmr : T_MR_DEFAULT;
  return tmr * (1 - a) + T_COSMIC * a;
}

/**
 * 按串联介质合成的天空噪温及其分解
 * @param {{A_G:number, A_C:number, A_R:number, Ts?:number, Tmr?:number}} q  各项衰减 dB；Ts 地表温度 K
 * @returns {{Tmr:number, clear:number, cloudy:number, total:number, cloud:number, rain:number, precip:number}}
 *   clear  = T_sky(A_G)；cloudy = T_sky(A_G+A_C)；total = T_sky(A_G+A_C+A_R)
 *   cloud  = cloudy − clear（云增量）；rain = total − cloudy（雨增量）；precip = total − clear（云+雨增量）
 */
function skyNoise(q) {
  q = q || {};
  const g = Math.max(0, Number(q.A_G) || 0);
  const c = Math.max(0, Number(q.A_C) || 0);
  const r = Math.max(0, Number(q.A_R) || 0);
  const Tmr = Number.isFinite(q.Tmr) ? q.Tmr : meanRadiatingTemp(q.Ts);
  const clear = skyNoiseTemp(g, Tmr);
  const cloudy = skyNoiseTemp(g + c, Tmr);
  const total = skyNoiseTemp(g + c + r, Tmr);
  return { Tmr, clear, cloudy, total, cloud: cloudy - clear, rain: total - cloudy, precip: total - clear };
}

module.exports = { T_MR_DEFAULT, meanRadiatingTemp, skyNoiseTemp, skyNoise };
