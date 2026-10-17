// itu/p618rain.js — ITU-R P.618-14 §2.2.1.1 斜路径雨衰（A0.01 与式(8) 时间百分比换算）
//
// 雨高取 ITU-R P.839-4（isothermHeight.js）+ 0.36 km；比衰减取 itu/p838.js。
// 2026-10-17 由 linkCalculator.js / linkCalculatorNGSO.js 两份副本抽出（C-16）：两份去注释后只差一个形参名
// 与一处 let 声明顺序，抽取前后两引擎出参逐字段对拍零变化。

const { getIsothermHeight } = require('../isothermHeight.js');
const { getCoefficients } = require('./p838.js');

/**
 * ITU-R P.618-14 公式(8)：将 A(0.01%) 换算为目标时间百分比 p 的雨衰
 * @param {number} A001    超过年均 0.01% 时间的衰减（dB）
 * @param {number} p       目标时间百分比（%），如 0.1 表示 0.1%
 * @param {number} latDeg  地球站纬度（度）
 * @param {number} elevDeg 链路仰角（度）
 * @returns {number} Ap（dB）
 */
function scaleRainAttenP618_14(A001, p, latDeg, elevDeg) {
  // 可用度 100% → p = 0 → 晴天，直接返回 0
  if (p <= 0 || A001 <= 0) return 0;
  // P.618-14 公式(8) 仅在 0.001%~5% 有效；p>5% 时雨衰记为 0（与 §2.5 总衰减合并一致）
  if (p > 5) return 0;

  const absLat = Math.abs(latDeg);
  const elevRad = elevDeg * Math.PI / 180;
  const sinElev = Math.sin(elevRad);

  // 确定修正系数 β（ITU-R P.618-14 Step 10）
  let beta;
  if (p >= 1 || absLat >= 36) {
    beta = 0;
  } else if (elevDeg >= 25) {
    // p < 1%、|φ| < 36°、θ ≥ 25°
    beta = -0.005 * (absLat - 36);
  } else {
    // p < 1%、|φ| < 36°、θ < 25°
    beta = -0.005 * (absLat - 36) + 1.8 - 4.25 * sinElev;
  }

  // 公式(8): Ap = A0.01 × (p/0.01)^[−(0.655 + 0.033·ln(p) − 0.045·ln(A0.01) − β·(1−p)·sinθ)]
  const exponent = -(0.655 + 0.033 * Math.log(p) - 0.045 * Math.log(A001)
                    - beta * (1 - p) * sinElev);
  return A001 * Math.pow(p / 0.01, exponent);
}

/**
 * 计算单路径降雨衰减 A(0.01%) —— ITU-R P.618-14 §2.2.1.1 步骤 1~9
 * @param {number} R001        R0.01% 降雨率（mm/h）
 * @param {number} freq        频率（GHz）
 * @param {string} pol         'H' | 'V' | 'C'
 * @param {number} latitude    站址纬度（度）
 * @param {number} longitude   站址经度（度）
 * @param {number} orbitPos    GEO 定点经度（度）；给了 elevOverride 时不用
 * @param {number} altitude    站址海拔（km）
 * @param {number} [elevOverride] 直接注入的仰角（度；NGSO / 雨衰页 / §8 等效仰角）
 * @returns {{A001:number, hR:number}}
 */
function calculateSinglePathRainAttenuation(R001, freq, pol, latitude, longitude, orbitPos, altitude, elevOverride) {
  if (R001 === 0 || R001 === null || R001 === undefined) {
    return { A001: 0, hR: 0 };
  }

  // 步骤 1: 确定链路仰角
  //   - 给定 elevOverride（雨衰工具的通用几何、NGSO 的最低 / 等效仰角）→ 直接采用，不依赖 GEO 定点经度；
  //   - 否则由 GEO 定点经度 orbitPos 反算（链路预算 GSO 原路径）。
  let elevationDeg, elevationRad;
  if (elevOverride !== undefined && elevOverride !== null && isFinite(elevOverride)) {
    // 限幅 0~90°
    elevationDeg = Math.max(0, Math.min(90, Number(elevOverride)));
    elevationRad = elevationDeg * Math.PI / 180;
  } else {
    const earthLatRad = latitude * Math.PI / 180;
    const deltaLonRad_elev = (orbitPos - longitude) * Math.PI / 180;
    const cosTerm_elev = Math.cos(earthLatRad) * Math.cos(deltaLonRad_elev);
    const denominator = Math.sqrt(Math.max(1e-10, 1 - Math.pow(cosTerm_elev, 2))); // 防止除零
    elevationRad = Math.atan((cosTerm_elev - 0.15127) / denominator);
    elevationDeg = elevationRad * 180 / Math.PI;
  }

  // 步骤 2: 查询零度等温线高度（ITU-R P.839-4 数据库）
  const h0 = getIsothermHeight(latitude, longitude);
  const hR = h0 + 0.36; // 雨高（km）
  const absLat = Math.abs(latitude);

  // hR - hs ≤ 0：站址高于雨高，无降雨衰减（P.618-14 Step 2）
  if (hR - altitude <= 0) {
    return { A001: 0, hR };
  }

  // 步骤 3: 计算通过雨区的倾斜路径长度
  let Ls;
  if (elevationDeg >= 5) {
    // 对于仰角 ≥ 5° 的情况使用简化公式
    Ls = (hR - altitude) / Math.sin(elevationRad);
  } else {
    // 对于低仰角使用更准确的公式（考虑地球曲率）
    const Re = 8500; // 有效地球半径（km）
    const sinElev = Math.sin(elevationRad);
    Ls = (2 * (hR - altitude)) / (Math.sqrt(sinElev * sinElev + 2 * (hR - altitude) / Re) + sinElev);
  }

  // 步骤 4: 计算水平投影长度
  const LG = Ls * Math.cos(elevationRad);

  // 步骤 5: 计算比降雨衰减（specific attenuation）
  const [k, alpha] = getCoefficients(freq, pol, elevationDeg);
  const gamma = k * Math.pow(R001, alpha); // 比降雨衰减 (dB/km)

  // 步骤 6: 计算水平路径缩减因子
  const r001 = 1 / (1 + 0.78 * Math.sqrt(LG * gamma / freq) - 0.38 * (1 - Math.exp(-2 * LG)));

  // 步骤 7: 计算垂直调整系数 v0.01（ITU-R P.618-14 Step 7）
  // 第一步：辅助角 ζ
  const zetaRad = Math.atan((hR - altitude) / (LG * r001));

  // 第二步：有效雨区路径长度 LR
  //   ζ > θ → 水平受限路径；否则 → 全斜路径
  let LR;
  if (zetaRad > elevationRad) {
    LR = LG * r001 / Math.cos(elevationRad);
  } else {
    LR = (hR - altitude) / Math.sin(elevationRad);
  }

  // 第三步：纬度修正量 χ（度）— 直接代入指数，不做事后二次修正
  const chi = absLat < 36 ? (36 - absLat) : 0;

  // 第四步：v0.01（P.618-14 关键变化：χ 在 e 的指数内，替代旧版中的 θ）
  const term = 31 * (1 - Math.exp(-elevationDeg / (1 + chi))) * Math.sqrt(LR * gamma) / (freq * freq);
  const v001 = 1 / (1 + Math.sqrt(Math.sin(elevationRad)) * (term - 0.45));

  // 步骤 8: 计算有效路径长度
  const LE = LR * v001;

  // 步骤 9: 计算0.01%时间超过的衰减值
  const A001 = gamma * LE;

  return { A001, hR };
}

/**
 * 雨高 h_R = h₀ + 0.36 km（P.839-4 零度等温线高度 + P.618-14 §2.2.1.1 步骤 1），与降雨率无关。
 * （calculateSinglePathRainAttenuation 在 R0.01 = 0 时返回的 hR 是 0，不能拿来判机载高度。）
 */
function rainHeightKm(latitude, longitude) {
  return getIsothermHeight(latitude, longitude) + 0.36;
}

module.exports = { scaleRainAttenP618_14, calculateSinglePathRainAttenuation, rainHeightKm };
