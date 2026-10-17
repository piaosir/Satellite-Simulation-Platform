// itu/p835.js — ITU-R P.835-7 参考大气（Annex 1）+ 平台既有的地面气压 / 温度估算
//
// ① ITU-R 参考大气（P.835-7 Annex 1，2024-08；与 P.835-6「年均全球参考大气」同式）：
//    温度、气压取 1976 美国标准大气，0~86 km 按位势高度分段（式 1a/2/3），86~100 km 按几何高度（式 4/5）；
//    水汽密度 ρ(Z) = ρ₀·exp(−Z/2)（式 6），直到混合比 e/P = 2×10⁻⁶ 为止，其上 ρ = 2×10⁻⁶·P·216.7/T（式 7/8）。
//    P.676-13 Annex 1 §2.2.1 分层射线在无本地探空时用它（ValEx「P.676-13 A_Gas_A1」即此大气）。
//    原文核对：R-REC-P.835-7-202408-I!!PDF-E.pdf 第 2~5 页（2026-10-17 下载）。
//
// ② 平台链路预算一直用的地面气象估算（原写在两引擎里，2026-10-17 归到这里，数值逐位不变）：
//    气压 Ps(h) = 1013.25·(1 − 6.5h/288.15)^5.2561（P.835 对流层式，h 为站址海拔 km）；
//    温度 Ts = 纬度带参考值（|φ|<22°：300.4 K，<45°：283.1 K，其余 272.4 K）− 6.5 K/km·h，下限 200 K。
//    ★ 这是粗估：伦敦按此 272.2 K，P.2145 年均是 284.1 K。P.1510 / P.2145 年均地表温度图未打包前沿用。

const RE_GEOPOT = 6356.766;   // km，式 (1a)(1b)

/** 几何高度 Z (km) → 位势高度 h' (km)，式 (1a) */
function geopotentialHeight(Z) { return RE_GEOPOT * Z / (RE_GEOPOT + Z); }

/** 参考大气温度 T(Z)，K；Z 为几何高度 km（0~100） */
function refTemperature(Z) {
  if (Z < 86) {
    const h = geopotentialHeight(Z);
    if (h <= 11) return 288.15 - 6.5 * h;                 // (2a)
    if (h <= 20) return 216.65;                           // (2b)
    if (h <= 32) return 216.65 + (h - 20);                // (2c)
    if (h <= 47) return 228.65 + 2.8 * (h - 32);          // (2d)
    if (h <= 51) return 270.65;                           // (2e)
    if (h <= 71) return 270.65 - 2.8 * (h - 51);          // (2f)
    return 214.65 - 2.0 * (h - 71);                       // (2g)，至 84.852 km'
  }
  if (Z <= 91) return 186.8673;                           // (4a)
  const u = (Z - 91) / 19.9429;
  return 263.1905 - 76.3232 * Math.sqrt(Math.max(0, 1 - u * u));   // (4b)，至 100 km
}

/** 参考大气总气压 P(Z)，hPa；Z 为几何高度 km（0~100） */
function refPressure(Z) {
  if (Z < 86) {
    const h = geopotentialHeight(Z);
    if (h <= 11) return 1013.25 * Math.pow(288.15 / (288.15 - 6.5 * h), -34.1632 / 6.5);                  // (3a)
    if (h <= 20) return 226.3226 * Math.exp(-34.1632 * (h - 11) / 216.65);                               // (3b)
    if (h <= 32) return 54.74980 * Math.pow(216.65 / (216.65 + (h - 20)), 34.1632);                       // (3c)
    if (h <= 47) return 8.680422 * Math.pow(228.65 / (228.65 + 2.8 * (h - 32)), 34.1632 / 2.8);           // (3d)
    if (h <= 51) return 1.109106 * Math.exp(-34.1632 * (h - 47) / 270.65);                                // (3e)
    if (h <= 71) return 0.6694167 * Math.pow(270.65 / (270.65 - 2.8 * (h - 51)), -34.1632 / 2.8);        // (3f)
    return 0.03956649 * Math.pow(214.65 / (214.65 - 2.0 * (h - 71)), -34.1632 / 2.0);                     // (3g)
  }
  return Math.exp(95.571899 - 4.011801 * Z + 6.424731e-2 * Z * Z - 4.789660e-4 * Z * Z * Z + 1.340543e-6 * Z * Z * Z * Z); // (5)
}

/**
 * 参考大气水汽密度，g/m³（式 6~8）：ρ₀·exp(−(Z−Z₀)/H)，下限为混合比 2×10⁻⁶ 对应的密度。
 * @param {number} Z    几何高度 km
 * @param {number} [rho0=7.5] Z₀ 处的水汽密度 g/m³
 * @param {number} [H=2]      标高 km
 * @param {number} [Z0=0]     ρ₀ 所在高度 km
 * @param {number} [P] [T]    该高度的总气压 hPa / 温度 K（缺省取参考大气）
 */
function refWaterVapourDensity(Z, rho0, H, Z0, P, T) {
  const r0 = Number.isFinite(rho0) ? rho0 : 7.5;
  const hs = Number.isFinite(H) && H > 0 ? H : 2;
  const z0 = Number.isFinite(Z0) ? Z0 : 0;
  const PP = Number.isFinite(P) ? P : refPressure(Z);
  const TT = Number.isFinite(T) ? T : refTemperature(Z);
  return Math.max(r0 * Math.exp(-(Z - z0) / hs), 2e-6 * PP * 216.7 / TT);
}

/** 平台地面气压估算 Ps(h)，hPa（P.835 对流层式，h 为站址海拔 km） */
function surfacePressure(hKm) {
  return 1013.25 * Math.pow(Math.max(0.01, 1 - 6.5 * hKm / 288.15), 5.2561);
}

/** 平台地面温度估算 Ts(φ, h)，K（纬度带参考值 − 6.5 K/km，下限 200 K） */
function surfaceTemperature(latDeg, hKm) {
  const a = Math.abs(latDeg);
  return Math.max(200, (a < 22 ? 300.4 : a < 45 ? 283.1 : 272.4) - 6.5 * hKm);
}

module.exports = {
  geopotentialHeight, refTemperature, refPressure, refWaterVapourDensity, surfacePressure, surfaceTemperature
};
