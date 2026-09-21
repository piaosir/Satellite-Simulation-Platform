// 卫星搜索的筛选器（仿 STK Standard Object Database 的过滤器）——纯函数，零依赖。
//
// 九个字段分两组：
//   ① 来自【卫星编目 SATCAT】：所有者 / 对象类型 / 运行状态 / 发射年（从–至）
//      —— 没下载过编目就取不到，这四项在界面上禁用、在这里【一律视为不限】（不是「全都筛掉」：
//      把没编目的星全滤没了，用户会以为搜索坏了）。
//   ② 来自【池记录本身】：轨道区制 / 近地点 / 远地点 / 倾角 / 周期（从–至）
//      —— 任何一颗星都算得出来，与编目在不在无关。
//
// 空筛选 = 不筛（isEmpty 为真时 makePredicate 返回 null，调用方据此走原来的路，零开销）。

import { classifyOrbit } from './orbitClass.js'
import { ACTIVE_STATUS } from './satcatCodes.js'

const RE = 6378.137
const MU = 398600.4418
const TWO_PI = Math.PI * 2

export const OBJECT_TYPES = ['PAY', 'R/B', 'DEB', 'UNK']
export const ORBIT_CLASSES = ['GEO', 'IGSO', 'MEO', 'LEO', 'HEO']
// 运行状态四档（把 SATCAT 的十几个状态码折成用户看得懂的四类）
export const STATUS_KINDS = [
  { key: 'active', zh: '运行', en: 'Operational' },
  { key: 'inactive', zh: '停运', en: 'Non-operational' },
  { key: 'unknown', zh: '未知', en: 'Unknown' },
  { key: 'decayed', zh: '已陨落', en: 'Decayed' }
]

export function emptyFilters() {
  return {
    owner: '', type: '', status: '', orbit: '',
    launchFrom: null, launchTo: null,
    perigeeFrom: null, perigeeTo: null,
    apogeeFrom: null, apogeeTo: null,
    inclFrom: null, inclTo: null,
    periodFrom: null, periodTo: null
  }
}
const isNum = (v) => v != null && v !== '' && Number.isFinite(Number(v))
export function isEmpty(f) {
  if (!f) return true
  const e = emptyFilters()
  for (const k of Object.keys(e)) {
    const v = f[k]
    if (typeof e[k] === 'string') { if (v) return false } else if (isNum(v)) return false
  }
  return true
}
// 只留认得的键，数值归一成 number|null（localStorage 读回来的可能是字符串）
export function normalize(f) {
  const out = emptyFilters()
  if (!f) return out
  for (const k of Object.keys(out)) {
    const v = f[k]
    if (typeof out[k] === 'string') out[k] = v ? String(v) : ''
    else out[k] = isNum(v) ? Number(v) : null
  }
  return out
}

// 池记录 / entry -> 可筛的数值。两种形状都收：
//   搜索池记录 { incl, meanMotion, ecc, apogeeKm, perigeeKm }
//   SATCAT 行  { inclDeg, periodMin, apogeeKm, perigeeKm }
export function metricsOf(rec, row) {
  const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
  let incl = n(rec && rec.incl)
  if (incl == null) incl = n(rec && rec.inclDeg)
  if (incl == null) incl = n(row && row.inclDeg)
  let apo = n(rec && rec.apogeeKm), per = n(rec && rec.perigeeKm)
  if (apo == null) apo = n(row && row.apogeeKm)
  if (per == null) per = n(row && row.perigeeKm)
  // 周期：优先平均运动（池记录的权威量），其次编目里的 PERIOD
  let period = null
  const mm = n(rec && rec.meanMotion)
  if (mm != null && mm > 0) period = 1440 / mm
  if (period == null) period = n(rec && rec.periodMin)
  if (period == null) period = n(row && row.periodMin)
  // 轨道区制：能算就算（classifyOrbit 自己会按 a / 周期 / 近远地点三条路兜底）
  let aKm = null
  if (period != null && period > 0) aKm = Math.cbrt(MU * Math.pow(period * 60 / TWO_PI, 2))
  else if (apo != null && per != null) aKm = ((apo + RE) + (per + RE)) / 2
  const ecc = (apo != null && per != null && apo + per + 2 * RE > 0)
    ? ((apo + RE) - (per + RE)) / ((apo + RE) + (per + RE))
    : n(rec && rec.ecc)
  let orbit = null
  if (aKm != null || period != null || (apo != null && per != null)) {
    try { orbit = classifyOrbit({ aKm, e: ecc, inclDeg: incl, periodMin: period, apogeeAltKm: apo, perigeeAltKm: per }) } catch { orbit = null }
  }
  return { incl, apogeeKm: apo, perigeeKm: per, periodMin: period, orbit }
}

// SATCAT 行 -> 四档状态之一
export function statusKind(row) {
  if (!row) return 'unknown'
  if (row.decayDate) return 'decayed'
  const s = String(row.status || '').trim()
  if (!s || s === '?') return 'unknown'
  if (ACTIVE_STATUS.indexOf(s) >= 0) return 'active'
  return 'inactive'
}
export const launchYearOf = (row) => {
  const m = /^(\d{4})/.exec(String((row && row.launchDate) || ''))
  return m ? +m[1] : null
}

const inRange = (v, lo, hi) => {
  if (lo == null && hi == null) return true
  if (v == null) return false            // 这一项要筛，但这颗星没有这个量 -> 不命中
  if (lo != null && v < lo) return false
  if (hi != null && v > hi) return false
  return true
}

/**
 * 生成谓词。filters 为空 -> 返回 null（调用方据此走原来的路）。
 * index：NORAD -> SATCAT 行 的 Map；为 null/空 时【前四项一律视为不限】。
 */
export function makePredicate(filters, index) {
  const f = normalize(filters)
  if (isEmpty(f)) return null
  const hasCat = !!(index && typeof index.get === 'function' && index.size > 0)
  return (rec) => {
    if (!rec) return false
    const row = hasCat ? index.get(String(rec.noradId)) : null
    // ① 编目四项：没编目就不筛
    if (hasCat) {
      if (f.owner && String((row && row.owner) || '') !== f.owner) return false
      if (f.type && String((row && row.type) || '') !== f.type) return false
      if (f.status && statusKind(row) !== f.status) return false
      if (f.launchFrom != null || f.launchTo != null) {
        if (!inRange(launchYearOf(row), f.launchFrom, f.launchTo)) return false
      }
    }
    // ② 几何五项：与编目在不在无关
    const m = metricsOf(rec, row)
    if (f.orbit && m.orbit !== f.orbit) return false
    if (!inRange(m.perigeeKm, f.perigeeFrom, f.perigeeTo)) return false
    if (!inRange(m.apogeeKm, f.apogeeFrom, f.apogeeTo)) return false
    if (!inRange(m.incl, f.inclFrom, f.inclTo)) return false
    if (!inRange(m.periodMin, f.periodFrom, f.periodTo)) return false
    return true
  }
}

// 池里出现过的所有者代码（供下拉只列真有的那些，而不是编目里的两百多个）
export function ownersIn(pool, index) {
  if (!index || !index.size) return []
  const set = new Set()
  for (const r of (pool || [])) {
    const row = index.get(String(r && r.noradId))
    if (row && row.owner) set.add(row.owner)
  }
  return Array.from(set).sort()
}

export default { emptyFilters, isEmpty, normalize, makePredicate, metricsOf, statusKind, launchYearOf, ownersIn, OBJECT_TYPES, ORBIT_CLASSES, STATUS_KINDS }
