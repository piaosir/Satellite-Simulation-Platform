// 位置访问器：全平台取卫星位置的【单一入口】（纯 CommonJS）。
//
// 传播类型两种，返回形状完全一样，调用方不必分支：
//   satrec（SGP4/SDP4，来自 OMM / TLE / 六根数）-> vendor/satellite.js 的 propagate
//   ephem 表（时间标签位置序列，来自 STK .e / CCSDS OEM / SP3 / 中国卫通 .eph）-> ephemInterp 的插值
// 两者都返 { position:{x,y,z}, velocity:{x,y,z} }（TEME，km / km·s⁻¹）或 null。
//   satrec 的 null = SGP4 报错 / 位置非有限；ephem 的 null = 查询时刻【落在采样时段之外】
//   （口径：不外推、不钉端点，该星此刻不画、不参与几何）。
//
// 【叠加星历】导入星历时可以「对应已有卫星」：外部星历不另立一颗星，而是挂到那颗星（按 NORAD）身上。
//   取位时先按优先级（新导入的在前）逐张查叠加表，查询时刻落在某张表的时段内就用它；都不在才回落本体
//   （SGP4 / 本体星历表）。宿主（主进程）用 setOverlayResolver 注入「NORAD → [表…]」的查找函数，库变更时
//   bumpOverlays 让各传播体上缓存的那份作废。没注入查找函数（Node 单测、Worker）就只认传播体上已带的 __ovl。
//
// core 内凡取卫星位置一律走本模块，不再直接调 sat.propagate —— 否则新加的 ephem 星会静默出 NaN，
// 叠加星历也会被静默绕过。

'use strict'

const sat = require('../vendor/satellite.js')
const EI = require('./ephemInterp.js')

const isEphem = (o) => !!(o && o.__ephem)
const toMs = (d) => (d instanceof Date ? d.getTime() : Number(d))

/* ===================== 叠加星历 ===================== */
// 编号归一：TLE 的 5 列编号可能带前导零 / 空格，或是 Alpha-5（A0001 = 100001）；OMM 的是十进制串
const A5 = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
function normId(x) {
  const s = String(x == null ? '' : x).trim().toUpperCase()
  if (!s) return ''
  const a = /^([A-HJ-NP-Z])(\d{4})$/.exec(s)
  if (a) return String((A5.indexOf(a[1]) + 10) * 10000 + Number(a[2]))
  return /^\d+$/.test(s) ? String(Number(s)) : s
}
let _resolver = null
let _ver = 0
function setOverlayResolver(fn) { _resolver = typeof fn === 'function' ? fn : null; _ver++ }
function bumpOverlays() { _ver++ }
// 叠加库版本号：任何对应关系 / 叠加表变更都会变。按「轨道 spec」缓存取位结果的地方（如 ngsoGeometry 的粗扫会话）
// 必须把它并进缓存键——同一 spec 在对应前后取到的位置不同
const overlayVersion = () => _ver
// 某传播体的叠加表（按优先级排好）；没有返回 null。结果缓存在传播体上，版本号变了才重查。
function overlaysOf(obj) {
  if (!obj) return null
  if (!_resolver) return obj.__ovl || null
  if (obj.__ovlVer !== _ver) {
    let list = null
    try { const id = normId(obj.satnum); list = id ? _resolver(id) : null } catch { list = null }
    obj.__ovl = list && list.length ? list.filter((t) => t && t !== obj) : null
    if (obj.__ovl && !obj.__ovl.length) obj.__ovl = null
    obj.__ovlVer = _ver
  }
  return obj.__ovl
}
// 此刻由哪张叠加表供位（没有 = 本体）
function overlayAt(obj, ms) {
  const ov = overlaysOf(obj)
  if (!ov) return null
  for (const tab of ov) { if (EI.evalTable(tab, ms)) return tab }
  return null
}

// obj: satrec | ephem 表；dateOrMs: Date | UTC 毫秒
function positionAt(obj, dateOrMs) {
  if (!obj) return null
  const ov = overlaysOf(obj)
  if (ov) {
    const ms = toMs(dateOrMs)
    for (const tab of ov) {
      const r = EI.evalTable(tab, ms)
      if (r) return { position: { x: r.x, y: r.y, z: r.z }, velocity: { x: r.vx, y: r.vy, z: r.vz } }
    }
  }
  if (isEphem(obj)) {
    const r = EI.evalTable(obj, toMs(dateOrMs))
    if (!r) return null
    return { position: { x: r.x, y: r.y, z: r.z }, velocity: { x: r.vx, y: r.vy, z: r.vz } }
  }
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(toMs(dateOrMs))
  const pv = sat.propagate(obj, d)
  if (!pv || !pv.position || (obj.error && obj.error !== 0)) return null
  const p = pv.position
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return pv
}

// 传播器标注：SGP4 / SDP4 / 星历点序列（给了时刻且该刻由叠加星历供位时标「星历点序列」）
function propagatorLabel(obj, dateOrMs) {
  if (dateOrMs != null && overlayAt(obj, toMs(dateOrMs))) return '星历点序列'
  if (isEphem(obj)) return '星历点序列'
  return obj && obj.method === 'd' ? 'SDP4' : 'SGP4'
}

// 该传播体的有效时段（UTC 毫秒）；satrec 无限制返回 null。星历表带叠加时取并集。
function validSpan(obj) {
  if (!isEphem(obj)) return null
  let t0 = obj.t0, t1 = obj.t1
  const ov = overlaysOf(obj)
  if (ov) for (const tab of ov) { if (tab.t0 < t0) t0 = tab.t0; if (tab.t1 > t1) t1 = tab.t1 }
  return { t0, t1 }
}

module.exports = { positionAt, propagatorLabel, isEphem, validSpan, setOverlayResolver, bumpOverlays, overlayVersion, overlaysOf, overlayAt, normId }
