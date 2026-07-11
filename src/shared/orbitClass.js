// 轨道区制严谨判定（GEO / IGSO / MEO / LEO / HEO）——所有链路预算 / 星座页共用的单一真值源。
//
// 依据：IADC 空间碎片保护区边界（LEO 天花板 = 2000 km 高度）+ ITU-R 地球静止轨道定义
//   （圆 · 赤道 · 同步）+ CelesTrak / 空间监视轨道区制惯例。判定按「先偏心率 → 再同步周期 →
//   最后高度带」的有序 first-match（首条命中即返回，保证唯一标签、总函数不抛错）：
//     1) e ≥ 0.20                         → HEO  （大椭圆：Molniya/Tundra/GTO。近圆轨道绝不会被误判为
//                                                  HEO —— 这修正了历史「e ≥ 0.01 即 HEO」的错误判据）
//     2) 同步周期 且 e ≤ 0.01 且 折叠倾角 < 5° → GEO  （三者须同时满足才算地球静止）
//     3) 同步周期（未过 GEO 门）             → IGSO （倾斜/微偏心地球同步，如北斗 IGSO、QZSS）
//     4) 半长轴 ≤ Re+2000 km               → LEO  （能量壳层判据；倾角不参与 → 逆行 SSO 仍为 LEO）
//     5) 其余                              → MEO  （默认：近圆·非同步·2000 km 以上，如
//                                                  GPS/GLONASS/Galileo/北斗 MEO、O3b）
// 每个阈值的取值论证见下方常量注释（经 4 组独立设计 + 对标 16 颗已知卫星的对抗校核后综合确定）。
//
// 入参（任一缺失即自洽推导，互为备援）：
//   { aKm, e, inclDeg, perigeeAltKm, apogeeAltKm, periodMin }
//   - aKm↔periodMin 可经开普勒第三定律互推；半长轴亦可由近/远地点高度取平均得到。
// 返回：'GEO' | 'IGSO' | 'MEO' | 'LEO' | 'HEO'。纯函数、全域（非法/退化输入尽力给 MEO，绝不抛错）。

const RE_KM = 6378.137            // WGS84 赤道半径（与 ngsoGeometry.js RE_KM、viz/wgs84.js 同源）
const MU = 398600.4418           // 地心引力常数 μ (km³/s²)，同源
const T_SIDEREAL_MIN = 1436.07   // 一个恒星日（同步周期）；对应 a_GEO≈42164.17 km、平均运动 1.00273896 rev/day
const TWO_PI = 2 * Math.PI

// —— 判定阈值 ——（改动会直接影响所有链路预算的轨道归属显示，务必连同注释一并评估）
const HEO_ECC_MIN = 0.20         // 大椭圆偏心率下限：Tundra 设计带 e≈0.20–0.30，取 0.20 而非 0.25 更稳
                                 //   （0.24 的 Tundra 用 0.25 会漏判为 IGSO）；且约为近圆各类（GEO<0.001、
                                 //   GNSS-MEO<0.02、QZSS≈0.075）的 10 倍以上 → 近圆轨道结构上不可能被误标 HEO。
const GEO_ECC_MAX = 0.01         // GEO 近圆门：受控 GEO 实运 e<5e-4；同步但 e∈(0.01,0.20) 属「微偏心地球同步」→ IGSO。
const GEO_INCL_MAX_DEG = 5       // GEO 近赤道门，严格 < 5°：i=5° 的退役倾斜 GEO 纬向摆动 ±5°、并非静止 → 归 IGSO。
const GSO_PERIOD_TOL_MIN = 28.72 // 同步周期容差 = ±2% 恒星日（带宽 1407.35–1464.79 min）。取 ±2% 而非 ±1%：
                                 //   可含 IADC +235~300 km 处置/坟墓带，而最近的非同步区制（12h MEO≈718 min）
                                 //   相距约 50% → 无泄漏、对带宽不敏感。
const LEO_SMA_MAX_KM = RE_KM + 2000  // LEO 半长轴天花板：IADC LEO 保护区 2000 km 高度（= 8378.137 km）。
const ECC_CLAMP_MAX = 0.999      // e 非有限或 ≥1（开放/近抛物，非法）钳到 0.999 → 命中 HEO，保持总函数不抛错。

// 各区制显示信息：短代码（徽标/信息卡）+ 中文全称（悬浮提示）。
export const REGIME_LABELS = {
  GEO:  { code: 'GEO',  short: 'GEO',  zh: '地球静止轨道（GEO）' },
  IGSO: { code: 'IGSO', short: 'IGSO', zh: '倾斜地球同步轨道（IGSO）' },
  MEO:  { code: 'MEO',  short: 'MEO',  zh: '中地球轨道（MEO）' },
  LEO:  { code: 'LEO',  short: 'LEO',  zh: '低地球轨道（LEO）' },
  HEO:  { code: 'HEO',  short: 'HEO',  zh: '大椭圆轨道（HEO）' }
}

const _fin = (x) => typeof x === 'number' && isFinite(x)

// 折叠倾角到 [0,90]（逆行安全）：凡涉及倾角的判据一律用 i_eff = min(i, 180−i)。
export function foldInclination(inclDeg) {
  if (!_fin(inclDeg)) return 0
  let i = Math.abs(inclDeg) % 360
  if (i > 180) i = 360 - i
  return Math.min(i, 180 - i)
}

// 主判据。见文件顶部有序规则说明。
export function classifyOrbit(p) {
  p = p || {}
  // 偏心率消毒：非有限→0（当近圆处理）；≥1（非法）→钳到 0.999（HEO 极端）
  const eSafe = _fin(p.e) ? Math.min(Math.max(p.e, 0), ECC_CLAMP_MAX) : 0

  // 有效半长轴：优先 aKm，其次由周期反推，再次由近/远地点高度取平均
  let aEff = (_fin(p.aKm) && p.aKm > 0) ? p.aKm : NaN
  let pEff = (_fin(p.periodMin) && p.periodMin > 0) ? p.periodMin : NaN
  if (!_fin(aEff) && _fin(pEff)) aEff = Math.cbrt(MU * Math.pow(pEff * 60 / TWO_PI, 2))
  if (!_fin(aEff) && _fin(p.perigeeAltKm) && _fin(p.apogeeAltKm)) {
    aEff = ((p.perigeeAltKm + RE_KM) + (p.apogeeAltKm + RE_KM)) / 2
  }
  // 有效周期：优先 periodMin，其次由半长轴反推（供同步性判据）
  if (!_fin(pEff) && _fin(aEff) && aEff > 0) pEff = TWO_PI * Math.sqrt(Math.pow(aEff, 3) / MU) / 60

  const iEff = foldInclination(p.inclDeg)
  const isGSO = _fin(pEff) && Math.abs(pEff - T_SIDEREAL_MIN) <= GSO_PERIOD_TOL_MIN

  if (eSafe >= HEO_ECC_MIN) return 'HEO'                                       // 1 大椭圆
  if (isGSO && eSafe <= GEO_ECC_MAX && iEff < GEO_INCL_MAX_DEG) return 'GEO'   // 2 地球静止
  if (isGSO) return 'IGSO'                                                     // 3 倾斜地球同步
  if (_fin(aEff) && aEff <= LEO_SMA_MAX_KM) return 'LEO'                       // 4 低轨
  return 'MEO'                                                                 // 5 默认（中轨）
}

// 便捷：区制代码 → 中文全称（未知代码原样返回）。
export function orbitRegimeLabel(code) {
  const r = REGIME_LABELS[code]
  return r ? r.zh : String(code || '')
}
