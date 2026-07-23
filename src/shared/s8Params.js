// ITU-R P.618-14 §8 统计口径 —— 渲染层参数组装与适用性门控（NGSO / 再生式链路预算共用）。
//
// 背景：把「最低/最差仰角」同时用于 FSL 几何和雨/气/云/闪烁统计是「最坏几何 × 最坏气象」的
// 双重最坏（P.618-14 §1 h)/§2 点名 non-GSO 须按 §8 计入仰角变化）。引擎（linkCalculatorNGSO）
// 已支持 s8Mode：启用后传播统计量按 §8 等效仰角求值、FSL/斜距仍用最差瞬时几何。本模块负责
// 渲染层的两件事：
//   ① 适用性门控 —— §8 的解析仰角分布假设「近圆轨道 + 站-星经差长期均匀混合」，以下情形不成立，
//      须静默回退单仰角口径（不传 s8 参数即可，引擎行为不变）：
//        · 快照/静止星（geom.static，几何时不变，本就无仰角分布可言）；
//        · 偏心轨道 e > 0.05（HEO/Molniya 高度随真近点角变化，圆轨道分布式不成立）；
//        · 地球同步周期（周期在恒星日 ±5% 内，星下点轨迹闭合重复，Δλ 不混合——含倾斜 GEO）。
//   ② 参数组装 —— 从几何求解结果 geom.elements（各来源统一：SGP4 静态根数 / 手动圆轨道虚拟
//      根数 / 快照静态根数）取轨道高度与倾角；最低仰角用「站点门限字段」（minElevation /
//      rxMinElevation 的原始输入），而非候选几何的瞬时仰角——§8 分布的下界是工作门限。
//
// 返回：可直接 Object.assign 进 linkParams 的对象；不适用时返回 {}（引擎侧 s8Mode 缺省=关闭）。

import { num } from './num.js'

const RE_KM = 6378.137
const SIDEREAL_DAY_MIN = 1436.0671   // 恒星日（min）

/**
 * @param {object} geom       几何求解结果（solveNgsoMutualWorstCase / coupledTypicalMoment 顶层），
 *                            需含 elements:{a,e,iDeg,periodMin}；static 真值表示快照/静止星
 * @param {object} opt        { minElevUp, minElevDn } —— 各站最低工作仰角（门限字段原始值，
 *                            单侧链路只传该侧即可；两侧都无效则不启用）
 * @returns {object} s8 linkParams 片段 或 {}
 */
export function s8LinkParams(geom, opt) {
  opt = opt || {}
  const el = geom && geom.elements
  if (!el || geom.static) return {}
  const e = Number(el.e)
  const iDeg = Number(el.iDeg)
  const a = Number(el.a)
  const periodMin = Number(el.periodMin)
  if (!Number.isFinite(e) || e > 0.05) return {}                     // 非近圆
  if (!Number.isFinite(iDeg) || !Number.isFinite(a)) return {}
  if (Number.isFinite(periodMin) &&
      Math.abs(periodMin - SIDEREAL_DAY_MIN) / SIDEREAL_DAY_MIN < 0.05) return {}  // 同步周期不混合
  const orbitAltKm = a - RE_KM
  if (!(orbitAltKm > 0)) return {}
  const up = num(opt.minElevUp)
  const dn = num(opt.minElevDn)
  if (up == null && dn == null) return {}
  const out = { s8Mode: '1', s8OrbitAltKm: orbitAltKm, s8InclDeg: iDeg }
  if (up != null) out.s8MinElevUp = up
  if (dn != null) out.s8MinElevDn = dn
  return out
}
