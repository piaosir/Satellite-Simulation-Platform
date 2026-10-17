// itu/p838.js — ITU-R P.838-3 降雨比衰减系数 k / α（单一真值源）
//
// 2026-10-17 由 linkCalculator.js / linkCalculatorNGSO.js 两份逐字相同的副本抽出（C-16），
// 两引擎、雨衰页、瞬时衰减一律从这里取。抽取前后两引擎出参逐字段对拍零变化。

// ITU-R P.838 降雨衰减系数表（整数频点；非整数频点按 P.838-3 规则插值）
const P838_TABLE = {
  1: { k_H: 0.000025892705, alpha_H: 0.96907444, k_V: 0.000030797361, alpha_V: 0.85922053 },
  2: { k_H: 0.000084686876, alpha_H: 1.0664189, k_V: 0.000099766062, alpha_V: 0.94896086 },
  3: { k_H: 0.000138979031, alpha_H: 1.2321603, k_V: 0.000194231849, alpha_V: 1.0687585 },
  4: { k_H: 0.00010713452, alpha_H: 1.6008816, k_V: 0.000246077198, alpha_V: 1.2475492 },
  5: { k_H: 0.000216150314, alpha_H: 1.6969267, k_V: 0.000242763745, alpha_V: 1.5317316 },
  6: { k_H: 0.000705586708, alpha_H: 1.5900457, k_V: 0.000487824508, alpha_V: 1.5727561 },
  7: { k_H: 0.0019149876, alpha_H: 1.4810276, k_V: 0.0014247707, alpha_V: 1.4744899 },
  8: { k_H: 0.0041154302, alpha_H: 1.390512, k_V: 0.0034498248, alpha_V: 1.3797357 },
  9: { k_H: 0.0075346436, alpha_H: 1.3154597, k_V: 0.0066908078, alpha_V: 1.2895105 },
  10: { k_H: 0.012166988, alpha_H: 1.2570969, k_V: 0.01129187, alpha_V: 1.215645 },
  11: { k_H: 0.017718799, alpha_H: 1.2140084, k_V: 0.017307344, alpha_V: 1.1617056 },
  12: { k_H: 0.023857793, alpha_H: 1.1824726, k_V: 0.02454833, alpha_V: 1.1215943 },
  13: { k_H: 0.03041288, alpha_H: 1.158639, k_V: 0.032656034, alpha_V: 1.0900799 },
  14: { k_H: 0.037375011, alpha_H: 1.139556, k_V: 0.041258318, alpha_V: 1.0646263 },
  15: { k_H: 0.044814639, alpha_H: 1.1232753, k_V: 0.050082454, alpha_V: 1.0439919 },
  16: { k_H: 0.052817368, alpha_H: 1.1086208, k_V: 0.058991895, alpha_V: 1.02729 },
  17: { k_H: 0.061455939, alpha_H: 1.0949247, k_V: 0.067968978, alpha_V: 1.0137111 },
  18: { k_H: 0.070784069, alpha_H: 1.0818267, k_V: 0.077076121, alpha_V: 1.0025047 },
  19: { k_H: 0.080838515, alpha_H: 1.0691419, k_V: 0.086417626, alpha_V: 0.99301241 },
  20: { k_H: 0.091642669, alpha_H: 1.0567811, k_V: 0.096111206, alpha_V: 0.98468993 },
  21: { k_H: 0.1032095, alpha_H: 1.0447058, k_V: 0.10627015, alpha_V: 0.97711019 },
  22: { k_H: 0.1155435, alpha_H: 1.0329027, k_V: 0.11699376, alpha_V: 0.96995443 },
  23: { k_H: 0.12864198, alpha_H: 1.0213699, k_V: 0.12836316, alpha_V: 0.96299667 },
  24: { k_H: 0.14249583, alpha_H: 1.0101105, k_V: 0.1404403, alpha_V: 0.95608638 },
  25: { k_H: 0.15709015, alpha_H: 0.9991285, k_V: 0.15326853, alpha_V: 0.94913169 },
  26: { k_H: 0.17240481, alpha_H: 0.98842745, k_V: 0.16687405, alpha_V: 0.94208463 },
  27: { k_H: 0.18841489, alpha_H: 0.97800963, k_V: 0.18126761, alpha_V: 0.93492872 },
  28: { k_H: 0.20509125, alpha_H: 0.96787591, k_V: 0.19644632, alpha_V: 0.92766912 },
  29: { k_H: 0.22240103, alpha_H: 0.95802573, k_V: 0.21239548, alpha_V: 0.92032489 },
  30: { k_H: 0.24030819, alpha_H: 0.94845732, k_V: 0.22909032, alpha_V: 0.91292323 },
  31: { k_H: 0.25877402, alpha_H: 0.93916779, k_V: 0.24649762, alpha_V: 0.9054953 },
  32: { k_H: 0.27775773, alpha_H: 0.93015338, k_V: 0.26457728, alpha_V: 0.89807327 },
  33: { k_H: 0.29721692, alpha_H: 0.92140958, k_V: 0.2832838, alpha_V: 0.89068829 },
  34: { k_H: 0.31710806, alpha_H: 0.91293129, k_V: 0.30256755, alpha_V: 0.88336924 },
  35: { k_H: 0.33738699, alpha_H: 0.90471296, k_V: 0.32237605, alpha_V: 0.876142 },
  36: { k_H: 0.35800932, alpha_H: 0.89674868, k_V: 0.34265498, alpha_V: 0.86902908 },
  37: { k_H: 0.37893081, alpha_H: 0.88903227, k_V: 0.36334918, alpha_V: 0.86204954 },
  38: { k_H: 0.40010772, alpha_H: 0.8815574, k_V: 0.38440346, alpha_V: 0.85521909 },
  39: { k_H: 0.42149715, alpha_H: 0.8743176, k_V: 0.40576327, alpha_V: 0.84855024 },
  40: { k_H: 0.44305724, alpha_H: 0.86730633, k_V: 0.42737533, alpha_V: 0.84205265 },
  41: { k_H: 0.46474746, alpha_H: 0.86051705, k_V: 0.44918808, alpha_V: 0.83573336 },
  42: { k_H: 0.48652876, alpha_H: 0.85394324, k_V: 0.47115201, alpha_V: 0.82959713 },
  43: { k_H: 0.50836375, alpha_H: 0.84757842, k_V: 0.49322003, alpha_V: 0.82364674 },
  44: { k_H: 0.53021678, alpha_H: 0.84141619, k_V: 0.51534758, alpha_V: 0.81788326 },
  45: { k_H: 0.55205407, alpha_H: 0.83545023, k_V: 0.53749282, alpha_V: 0.81230635 },
  46: { k_H: 0.57384377, alpha_H: 0.82967436, k_V: 0.55961668, alpha_V: 0.80691446 },
  47: { k_H: 0.59555596, alpha_H: 0.8240825, k_V: 0.58168291, alpha_V: 0.80170507 },
  48: { k_H: 0.61716269, alpha_H: 0.81866871, k_V: 0.60365804, alpha_V: 0.79667486 },
  49: { k_H: 0.638638, alpha_H: 0.81342718, k_V: 0.62551134, alpha_V: 0.79181991 },
  50: { k_H: 0.65995784, alpha_H: 0.80835228, k_V: 0.64721474, alpha_V: 0.78713577 },
  51: { k_H: 0.68110011, alpha_H: 0.80343849, k_V: 0.66874277, alpha_V: 0.78261767 },
  52: { k_H: 0.70204455, alpha_H: 0.79868046, k_V: 0.69007239, alpha_V: 0.77826056 },
  53: { k_H: 0.72277271, alpha_H: 0.79407301, k_V: 0.71118294, alpha_V: 0.77405922 },
  54: { k_H: 0.7432679, alpha_H: 0.78961108, k_V: 0.73205596, alpha_V: 0.77000832 },
  55: { k_H: 0.76351508, alpha_H: 0.78528979, k_V: 0.7526751, alpha_V: 0.76610252 },
  60: { k_H: 0.86061304, alpha_H: 0.76563228, k_V: 0.85152007, alpha_V: 0.74856482 },
  70: { k_H: 1.0314779, alpha_H: 0.73446512, k_V: 1.0253337, alpha_V: 0.72153399 },
  80: { k_H: 1.170445, alpha_H: 0.71149456, k_V: 1.166831, alpha_V: 0.7020764 },
  90: { k_H: 1.2807147, alpha_H: 0.6943701, k_V: 1.2794572, alpha_V: 0.68761399 },
  100: { k_H: 1.3671083, alpha_H: 0.68145001, k_V: 1.3680473, alpha_V: 0.67654052 },
};

/**
 * 查找最接近的频率键
 */
function findClosestFrequency(freq) {
  const keys = Object.keys(P838_TABLE).map(Number);
  let closest = keys[0];
  let minDiff = Math.abs(freq - closest);

  for (const key of keys) {
    const diff = Math.abs(freq - key);
    if (diff < minDiff) {
      minDiff = diff;
      closest = key;
    }
  }

  return closest;
}

/**
 * ITU-R P.838-3 频率插值：返回任意频率 f(GHz) 处的 {k_H, alpha_H, k_V, alpha_V}
 *
 * 标准插值规则（ITU-R P.838-3，§ 注释）：
 *   - 频率 f 采用对数刻度；
 *   - 系数 k 采用对数刻度（即 k 关于 log f 做 log-log 线性插值）；
 *   - 指数 α 采用线性刻度（即 α 关于 log f 做半对数线性插值）。
 * 表外频率夹紧到 [1, 100] GHz（表的有效范围）；整数频点直接返回表值（向后兼容）。
 *
 * @param {number} freqGHz 频率（GHz）
 * @returns {{k_H:number, alpha_H:number, k_V:number, alpha_V:number}}
 */
function interpolateP838(freqGHz) {
  const keys = Object.keys(P838_TABLE).map(Number).sort((a, b) => a - b);
  const fMin = keys[0];
  const fMax = keys[keys.length - 1];

  // 表外夹紧到有效范围
  if (freqGHz <= fMin) return Object.assign({}, P838_TABLE[fMin]);
  if (freqGHz >= fMax) return Object.assign({}, P838_TABLE[fMax]);
  // 整数频点直接命中表值（避免浮点误差，向后兼容）
  if (P838_TABLE[freqGHz]) return Object.assign({}, P838_TABLE[freqGHz]);

  // 定位相邻两频点 f1 < f < f2
  let f1 = fMin;
  let f2 = fMax;
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] <= freqGHz && freqGHz <= keys[i + 1]) {
      f1 = keys[i];
      f2 = keys[i + 1];
      break;
    }
  }
  const e1 = P838_TABLE[f1];
  const e2 = P838_TABLE[f2];

  // 频率对数刻度上的插值比例
  const t = (Math.log(freqGHz) - Math.log(f1)) / (Math.log(f2) - Math.log(f1));
  // k：log-log（k 取对数后线性插值）
  const logInterp = (y1, y2) => Math.exp(Math.log(y1) + t * (Math.log(y2) - Math.log(y1)));
  // α：半对数（α 关于 log f 线性插值）
  const linInterp = (y1, y2) => y1 + t * (y2 - y1);

  return {
    k_H: logInterp(e1.k_H, e2.k_H),
    alpha_H: linInterp(e1.alpha_H, e2.alpha_H),
    k_V: logInterp(e1.k_V, e2.k_V),
    alpha_V: linInterp(e1.alpha_V, e2.alpha_V),
  };
}

/**
 * 获取P838系数 - 根据频率和极化
 * @param {number} freq 具体频率（GHz，非整数频率经 interpolateP838 插值）
 */
function getCoefficients(freq, pol, elevationDeg) {
  const entry = interpolateP838(freq);
  if (!entry) {
    return [0, 0];
  }

  const { k_H, alpha_H, k_V, alpha_V } = entry;

  // ITU-R P.838-3 极化合成公式：
  //   k     = (k_H + k_V + (k_H - k_V) * cos²θ * cos2τ) / 2
  //   alpha = (k_H·αH + k_V·αV + (k_H·αH - k_V·αV) * cos²θ * cos2τ) / (2k)
  // τ=0°  → H 极化，cos2τ = +1
  // τ=90° → V 极化，cos2τ = -1
  // τ=45° → 圆极化，cos2τ =  0（θ项消去，与仰角无关）
  const theta = (elevationDeg !== undefined && elevationDeg !== null) ? elevationDeg : 0;
  const cos2Theta = Math.pow(Math.cos(theta * Math.PI / 180), 2);

  let cos2Tau;
  if (pol === 'H')      cos2Tau =  1;
  else if (pol === 'V') cos2Tau = -1;
  else                  cos2Tau =  0; // 圆极化 C

  const k     = (k_H + k_V + (k_H - k_V) * cos2Theta * cos2Tau) / 2;
  const alpha = (k_H * alpha_H + k_V * alpha_V
               + (k_H * alpha_H - k_V * alpha_V) * cos2Theta * cos2Tau) / (2 * k);
  return [k, alpha];
}

module.exports = { P838_TABLE, findClosestFrequency, interpolateP838, getCoefficients };
