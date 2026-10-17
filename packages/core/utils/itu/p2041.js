// itu/p2041.js — ITU-R P.2041-1（09/2026）机载终端 ↔ 空间的衰减修正（§4）
//
// 原文核对：R-REC-P.2041-1-202609-I!!PDF-E.pdf（2026-10-17 下载）。平台不设「机载」开关，一律由站高决定：
//   §4.2 气体：A_o' = γ_o·h_o·e^(−h/h_o)（h = 机高离地高度，γ_o/h_o 取地面气象），A_w' = K_w·V(p)（V 取机高处）
//                —— 实现见 gasSite.js；离地高度为 0 时与 P.676-13 Annex 2 统计法逐位相同。
//   §4.3 云：云底取雨高 h_R（P.839），云顶取 6 km；h_R 以下 100% 柱液态水，6 km 以上 0%，其间线性过渡。
//   §4.4 雨：P.618 的站高 h_s 换成机高，h_s ≥ h_R 时雨衰为 0 —— 雨衰函数本来就按站高这样算（p618rain.js）。
//   §4.5 闪烁：机高在雨高以下按地面站算，高于雨高时忽略。
// §4.1 的总衰减合成（式 1/2/3）沿用 P.618 §2.5，平台的总衰减读数不另分机载式。
// 气象参数取机下点经纬度（§2 要求取路径与地面交点，10 km 机高 / 30° 仰角时两点相距约 17 km，远小于 1.125° 格距）。

const CLOUD_TOP_KM = 6;

/**
 * 云柱液态水保留比例（§4.3）
 * @param {number} hsKm 终端海拔 km
 * @param {number} hRKm 雨高 km（P.839 + 0.36）
 * @returns {number} 0~1
 */
function cloudLiquidFraction(hsKm, hRKm) {
  const hs = Number(hsKm) || 0;
  if (!Number.isFinite(hRKm)) return 1;
  if (hs <= hRKm) return 1;
  if (hRKm >= CLOUD_TOP_KM) return 0;     // 雨高已在云顶之上：过了雨高即无云
  if (hs >= CLOUD_TOP_KM) return 0;
  return (CLOUD_TOP_KM - hs) / (CLOUD_TOP_KM - hRKm);
}

/** §4.5：终端高于雨高时忽略对流层闪烁 */
function scintillationApplies(hsKm, hRKm) {
  return !(Number.isFinite(hRKm) && (Number(hsKm) || 0) > hRKm);
}

module.exports = { CLOUD_TOP_KM, cloudLiquidFraction, scintillationApplies };
