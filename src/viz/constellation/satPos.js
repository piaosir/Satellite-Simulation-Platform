// 取卫星位置 —— 渲染端【唯一】入口（packages/core/utils/orbitPos.js 的渲染端对应物）。
//
// 两种传播体，同一个 posAt、同一种返回形状，调用方不必分支：
//   satrec（SGP4/SDP4，来自 OMM / TLE / 六根数）        -> satellite.js 的 propagate
//   ephem 表（时间标签位置序列，来自 .e / OEM / SP3）    -> ephemTable.js 的插值
//   另：satrec 上挂了 __fix（天线树里的同步轨道定点星，见 viz/grd/treeGeo.js）→ 钉在地固系定点上：
//       TEME = Rz(−GMST)·r_ECEF、速度 = ω⊕ × r；那份 satrec 只供读数，不拿来推演。
// 两者都返 { position:{x,y,z}, velocity:{x,y,z} }（TEME，km / km·s⁻¹）或 null。
//   satrec 的 null = SGP4 报错 / 位置非有限；ephem 的 null = 查询时刻【落在采样时段之外】
//   （口径：不外推、不钉端点，该星此刻不画、不参与几何）。
//
// ★ 渲染端凡取卫星位置一律走本模块，不再直接调 sat.propagate ——
//   否则新加的 ephem 星会静默出 NaN（表对象不是 satrec，喂给 SGP4 只会得到垃圾）。
//   判据：grep -n "propagate(" src/pages src/viz 只允许剩 satellite.js 的定义与本文件。

import sat from './satellite.js'
import { evalTable } from './ephemTable.js'
import { periodMinFromNo, metricsFromEphem } from '../../shared/satrecMetrics.js'

const JD_UNIX = 2440587.5, MS_PER_DAY = 864e5, MIN_PER_DAY = 1440
const _sgp4 = (typeof sat.sgp4 === 'function') ? sat.sgp4 : null

// entry（{rec} 或 {eph}）或裸传播体都收；ephem 表优先（同一条 entry 不会两者都有）
export const propOf = (x) => (x && (x.__ephem || x.jdsatepoch !== undefined) ? x : (x && (x.eph || x.rec)) || x)
export const isEphem = (x) => !!(propOf(x) || {}).__ephem
// 该 entry 是不是点序列星（给「拒收」那一批模块判一句用）
export const isEphemEntry = (e) => !!(e && e.eph && e.eph.__ephem)

const wrap = (r) => (r ? { position: { x: r.x, y: r.y, z: r.z }, velocity: { x: r.vx, y: r.vy, z: r.vz } } : null)

// 定点（__fix.r = 地固系 km）在 GMST = g（rad）时刻的 TEME 位置 / 速度。与 satellite.js eciToEcf 互逆（同一个 gstime）
const WE = 7.292115146706979e-5          // 地球自转角速度 rad/s（WGS-84）
export const SIDEREAL_MIN = 1436.0681743 // 恒星日（min）：定点星的「周期」—— 轨道圈画一整圈恰好闭合
function fixPv(f, g) {
  const r = f && f.r
  if (!r || !Number.isFinite(g)) return null
  const c = Math.cos(g), s = Math.sin(g)
  const X = r[0] * c - r[1] * s, Y = r[0] * s + r[1] * c
  return { position: { x: X, y: Y, z: r[2] }, velocity: { x: -WE * Y, y: WE * X, z: 0 } }
}

// 通用取位。t 可以是 Date 或 UTC 毫秒。任何情况下都不抛。
export function posAt(x, t) {
  const o = propOf(x)
  if (!o) return null
  if (o.__fix) return fixPv(o.__fix, sat.gstime(t instanceof Date ? t : new Date(Number(t))))
  if (o.__ephem) return wrap(evalTable(o, t instanceof Date ? t.getTime() : Number(t)))
  const d = t instanceof Date ? t : new Date(Number(t))
  let pv
  try { pv = sat.propagate(o, d) } catch { return null }
  if (!pv || !pv.position || (o.error && o.error !== 0)) return null
  return Number.isFinite(pv.position.x) ? pv : null
}

// 热路径取位（可见性扫描、逐帧点云）：给毫秒，satrec 一路直调 sgp4 内核，
// 省掉 new Date 分配与 propagate/gstime 各算一遍 jday。数值与 posAt 完全一致。
// 返回 { position, velocity } 或 null。jd 可由调用方传入复用（它多半已经算过）。
export function posAtMs(x, tMs, jd) {
  const o = propOf(x)
  if (!o) return null
  if (o.__ephem) return wrap(evalTable(o, tMs))
  if (!_sgp4) return posAt(o, tMs)
  const j = jd === undefined ? tMs / MS_PER_DAY + JD_UNIX : jd
  if (o.__fix) return fixPv(o.__fix, sat.gstime(j))
  let pv
  try { pv = _sgp4(o, (j - o.jdsatepoch) * MIN_PER_DAY) } catch { return null }
  if (!pv || !pv.position || (o.error && o.error !== 0)) return null
  return Number.isFinite(pv.position.x) ? pv : null
}

// 传播器标注（信息卡 / 链路窗口读数）
export function propagatorLabel(x) {
  const o = propOf(x)
  if (!o) return ''
  if (o.__fix) return '定点'
  if (o.__ephem) return '星历点序列'
  return o.method === 'd' ? 'SDP4' : 'SGP4'
}
// 有效时段（UTC 毫秒）；satrec 无限制返回 null
export function validSpan(x) {
  const o = propOf(x)
  return o && o.__ephem ? { t0: o.t0, t1: o.t1 } : null
}
// 轨道周期（分钟）—— 信息卡 / 轨道圈 TTL / 轨迹长度的【唯一】口径。
//   satrec       -> 2π/no（no 是 un-Kozai 后的平均运动，rad/min）
//   星历点序列表 -> 表内相邻两次升交点估计（结果缓存在表上，见 shared/satrecMetrics.js）
// 估不出（表不足两次升交点，例如整天一档的 GEO）返回 null —— 调用方据此走「按表点连线」，不编数。
// ★ satrec 这一路刻意不走 metricsFromSatrec：它每次都建一个对象，而本函数在逐拍逐颗的热路径上。
export function periodMinOf(x) {
  const o = propOf(x)
  if (!o) return null
  if (o.__fix) return SIDEREAL_MIN
  if (o.__ephem) { const m = metricsFromEphem(o); return m ? m.periodMin : null }
  return periodMinFromNo(o.no)
}

// 渲染集去留判据（3D 页 rebuildRenderSet 的 add 用）。
// ★ 星历星「此刻不在采样时段内」不等于「解算不了」：渲染集只在换组 / 换可见层时重建，时钟推进只重算
//   位置 —— 一旦按「此刻取位为 null」把它剔出集合，导入覆盖未来时段的 .e 之后就永远是 0 颗，
//   时钟走进时段也不会出现。故星历星一律留在集里，这一拍画不画交给 posAt 说话（refreshPositions
//   对 null 本来就有占位分支，保持索引对齐）。
// satrec 星相反：这一刻解不出来多半是根数坏了 / 已衰落，留着只是每拍白跑一次 SGP4。
export function keepInRenderSet(x, t) {
  if (isEphem(x)) return true
  const pv = posAt(x, t)
  return !!(pv && pv.position)
}

export default { posAt, posAtMs, propOf, isEphem, isEphemEntry, propagatorLabel, validSpan, periodMinOf, keepInRenderSet }
