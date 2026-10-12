// 取卫星位置 —— 渲染端【唯一】入口（packages/core/utils/orbitPos.js 的渲染端对应物）。
//
// 两种传播体，同一个 posAt、同一种返回形状，调用方不必分支：
//   satrec（SGP4/SDP4，来自 OMM / TLE / 六根数）        -> satellite.js 的 propagate
//   ephem 表（时间标签位置序列，来自 .e / OEM / SP3 / 中国卫通 .eph） -> ephemTable.js 的插值
//   另：satrec 上挂了 __fix（天线树里的同步轨道定点星，见 viz/grd/treeGeo.js）→ 钉在地固系定点上：
//       TEME = Rz(−GMST)·r_ECEF、速度 = ω⊕ × r；那份 satrec 只供读数，不拿来推演。
// 两者都返 { position:{x,y,z}, velocity:{x,y,z} }（TEME，km / km·s⁻¹）或 null。
//   satrec 的 null = SGP4 报错 / 位置非有限；ephem 的 null = 查询时刻【落在采样时段之外】
//   （口径：不外推、不钉端点，该星此刻不画、不参与几何）。
//
// 【叠加星历】导入星历时「对应已有卫星」：那颗星（按 NORAD = satrec.satnum / 表的 satnum）在导入星历的时段内
//   改由导入的表取位（新导入的优先），时段外回落本体（SGP4 / 本体表）。口径与 core 的 orbitPos 逐条一致。
//   注册表由宿主页（星座 3D）经 setOverlays 灌进来；Worker 里没有注册表，只认传播体上已打的 __ovl 戳
//   （聚焦几何池发 satrec 之前用 stampOverlays 打好，见 focusGeomPool.js）。定点星（__fix）不叠加。
//
// ★ 渲染端凡取卫星位置一律走本模块，不再直接调 sat.propagate ——
//   否则新加的 ephem 星会静默出 NaN（表对象不是 satrec，喂给 SGP4 只会得到垃圾），叠加星历也会被绕过。
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

/* ===================== 叠加星历 ===================== */
// 编号归一（与 core orbitPos.normId 同式）：TLE 的 5 列编号可能带前导零 / 空格，或是 Alpha-5（A0001 = 100001）
const A5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export function normId(x) {
  const s = String(x == null ? '' : x).trim().toUpperCase()
  if (!s) return ''
  const a = /^([A-HJ-NP-Z])(\d{4})$/.exec(s)
  if (a) return String((A5.indexOf(a[1]) + 10) * 10000 + Number(a[2]))
  return /^\d+$/.test(s) ? String(Number(s)) : s
}
let _ovReg = null         // Map<NORAD, [表…]>（新导入的在前）；null = 本线程没有注册表（Worker）
let _ovVer = 0
/** 宿主灌注册表：map = Map<NORAD, [取位表…]>（表由 ephemTable.tableFrom 装好）。返回新版本号。 */
export function setOverlays(map) {
  const m = new Map()
  if (map) for (const [k, v] of (map instanceof Map ? map : Object.entries(map))) { const list = (v || []).filter((t) => t && t.__ephem); if (list.length) m.set(normId(k), list) }
  _ovReg = m
  return ++_ovVer
}
export const overlayVersion = () => _ovVer
// 某传播体的叠加表（按优先级排好）；没有返回 null。主线程按版本号缓存在传播体上，Worker 只信戳。
export function overlaysOf(o) {
  if (!o || o.__fix) return null
  if (!_ovReg) return o.__ovl || null
  if (o.__ovlVer !== _ovVer) {
    const list = _ovReg.size ? _ovReg.get(normId(o.satnum)) : null
    o.__ovl = list ? list.filter((t) => t !== o) : null
    if (o.__ovl && !o.__ovl.length) o.__ovl = null
    o.__ovlVer = _ovVer
  }
  return o.__ovl
}
/** 发往 Worker 之前打戳（Worker 没有注册表）：返回打上的叠加表（或 null） */
export function stampOverlays(x) { const o = propOf(x); return o ? overlaysOf(o) : null }
/** 此刻由哪张叠加表供位（没有 = 本体）—— 信息栏「星历源」读数用 */
export function overlayAt(x, t) {
  const o = propOf(x)
  const ov = o && overlaysOf(o)
  if (!ov) return null
  const ms = t instanceof Date ? t.getTime() : Number(t)
  for (const tab of ov) if (evalTable(tab, ms)) return tab
  return null
}
function ovPv(o, ms) {
  const ov = overlaysOf(o)
  if (!ov) return null
  for (const tab of ov) { const r = evalTable(tab, ms); if (r) return wrap(r) }
  return null
}

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
  const ms = t instanceof Date ? t.getTime() : Number(t)
  const ov = ovPv(o, ms)
  if (ov) return ov
  if (o.__ephem) return wrap(evalTable(o, ms))
  const d = t instanceof Date ? t : new Date(ms)
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
  if (!o.__fix) { const ov = ovPv(o, tMs); if (ov) return ov }
  if (o.__ephem) return wrap(evalTable(o, tMs))
  if (!_sgp4) return posAt(o, tMs)
  const j = jd === undefined ? tMs / MS_PER_DAY + JD_UNIX : jd
  if (o.__fix) return fixPv(o.__fix, sat.gstime(j))
  let pv
  try { pv = _sgp4(o, (j - o.jdsatepoch) * MIN_PER_DAY) } catch { return null }
  if (!pv || !pv.position || (o.error && o.error !== 0)) return null
  return Number.isFinite(pv.position.x) ? pv : null
}

// 传播器标注（信息卡 / 链路窗口读数）。给了时刻且该刻由叠加星历供位：标「星历点序列」
export function propagatorLabel(x, t) {
  const o = propOf(x)
  if (!o) return ''
  if (o.__fix) return '定点'
  if (t != null && overlayAt(o, t)) return '星历点序列'
  if (o.__ephem) return '星历点序列'
  return o.method === 'd' ? 'SDP4' : 'SGP4'
}
// 有效时段（UTC 毫秒）；satrec 无限制返回 null（叠加星历的时段外回落 SGP4，仍无限制）；星历表带叠加取并集
export function validSpan(x) {
  const o = propOf(x)
  if (!o || !o.__ephem) return null
  let t0 = o.t0, t1 = o.t1
  const ov = overlaysOf(o)
  if (ov) for (const tab of ov) { if (tab.t0 < t0) t0 = tab.t0; if (tab.t1 > t1) t1 = tab.t1 }
  return { t0, t1 }
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
  const o = propOf(x)
  if (o && overlaysOf(o)) return true      // 挂了叠加星历：SGP4 解不出来的时刻也可能有星历
  const pv = posAt(x, t)
  return !!(pv && pv.position)
}

export default { posAt, posAtMs, propOf, isEphem, isEphemEntry, propagatorLabel, validSpan, periodMinOf, keepInRenderSet, setOverlays, overlaysOf, overlayAt, stampOverlays, overlayVersion, normId }
