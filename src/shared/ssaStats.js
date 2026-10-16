// 空间态势（SSA）统计引擎 —— CelesTrak 卫星编目（SATCAT）+ GP 星历的全部统计口径，只此一份。
//
// 屏上电子报告与 Word 报告都只吃 ssaReport.buildSsaModel() 的产物，而模型里的每一个数都出自本文件，
// 两端不各算各的（与 lbSla / lbReport 同一原则）。零 DOM 纯 ESM，Node 可直接 import 测。
//
// 三条硬口径，改动前先读：
//   ① 本文件【一次也不调 Date.now() / 无参 new Date()】—— 所有「今天」都由入参 asOf（ISO 串）给出。
//      报告要可复现：同一份数据 + 同一个 asOf，两次跑出的数必须逐位相同，否则测试与交付文档都失去意义。
//   ② 本文件【不产生任何用户可见的文字】—— 返回的是代码（PRC / PAY / LEO）与数，中英文名、标题、
//      题注一律由 ssaReport.js 按 lang 翻。判定词（达标 / 拥挤 / 正常…）在任何一层都不许出现。
//   ③ 排序一律确定性：主键相等时按 NORAD 升序（NORAD 是字符串，比较前转数）。全部函数对空输入
//      返回空表 / 零值，绝不抛错。
//
// 判据全文见 docs/空间态势报告模块任务书_2026-09-16.md 附录 C；下面每个谓词的注释是同一份口径的代码化。

import { splitCsvLine } from '../viz/constellation/tle.js'
import { classifyOrbit, foldInclination, fmtGeoSlot } from './orbitClass.js'
import { geoLonAtEpoch } from './geoSlot.js'
import sat from '../viz/constellation/satellite.js'
import { ACTIVE_STATUS } from './satcatCodes.js'
import { epochMs } from './epochMs.js'

const RE_KM = 6378.137        // WGS84 赤道半径，与 orbitClass.js 同源（区制判据要逐位一致）
const MU = 398600.4418        // 地心引力常数 μ (km³/s²)，同源
const DAY_MS = 86400000
const TWO_PI = 2 * Math.PI

// 类型 / 区制的固定展示序：报告的行序不随数据变化，便于逐版对照。
export const TYPE_ORDER = ['PAY', 'R/B', 'DEB', 'UNK']
export const REGIME_ORDER = ['LEO', 'MEO', 'GEO', 'IGSO', 'HEO', '—']

// 大型星座名称模式。★ 以【名称前缀】近似，与 CelesTrak 的 GROUP 分组不完全等价 ——
// GROUP 由 CelesTrak 人工维护（含改名星、含不按前缀命名的星），这里只认名字，
// 因此「在轨 / 活跃」列与官方 GROUP 计数可能差几颗；报告里这几列的口径就是名称前缀。
// 顺序即匹配序，一颗星只归第一个命中的星座（防重复计数）。
// ★ 星座成员只认【载荷】（见 constKeyOfRow）：编目里「IRIDIUM 33 DEB」这类名字带星座前缀的碎片
//   有 684 条（2009 年碰撞），按名字全计的话铱星「累计发射」印成 859。
// ★ 星历一侧按【编目名】归类（见 constKeyOfGp）：GLONASS 的星历名是「COSMOS 2433 (720)」，
//   编目名才是「COSMOS 2433 [GLONASS-M]」，按星历名归类星历颗数恒为 0。
// ★ Galileo 只认 GSAT0nnn：印度的 GSAT-7 / GSAT-30 一族同样以 GSAT 起头（真编目 22 颗）。
export const CONST_PATTERNS = [
  { key: 'starlink', re: /^STARLINK/ },
  { key: 'oneweb', re: /^ONEWEB/ },
  { key: 'kuiper', re: /^KUIPER/ },
  { key: 'qianfan', re: /^QIANFAN/ },
  { key: 'guowang', re: /^(HULIANWANG|GUOWANG)/ },
  { key: 'iridium', re: /^IRIDIUM/ },
  { key: 'globalstar', re: /^GLOBALSTAR/ },
  { key: 'planet', re: /^(FLOCK|SKYSAT|PELICAN)/ },
  { key: 'spire', re: /^LEMUR/ },
  { key: 'o3b', re: /^O3B/ },
  { key: 'gps', re: /^(NAVSTAR|GPS)/ },
  { key: 'beidou', re: /^BEIDOU/ },
  { key: 'galileo', re: /^GSAT0\d{3}/ },
  { key: 'glonass', re: /^COSMOS.*GLONASS|^GLONASS/ }
]

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/
const DIGITS_RE = /^\d+$/

// —— 小工具 ——
const fin = (x) => typeof x === 'number' && Number.isFinite(x)
const r1 = (x) => (fin(x) ? Math.round(x * 10) / 10 : null)
const r2 = (x) => (fin(x) ? Math.round(x * 100) / 100 : null)
const r3 = (x) => (fin(x) ? Math.round(x * 1000) / 1000 : null)
const byNorad = (a, b) => (Number(a) || 0) - (Number(b) || 0)

/** 'YYYY-MM-DD' → 该日 UTC 零时的毫秒；空 / 不合法返回 NaN。不走 Date.parse：'1957-10-04' 在部分
 *  实现里会被当本地时间解释，跨时区会差一天，而在轨天数是要写进交付文档的数。 */
export function dayMs(s) {
  const m = DATE_RE.exec(String(s || ''))
  if (!m) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

/** asOf（ISO 串 / 毫秒数）→ 毫秒；不合法返回 NaN。模块内所有「今天」的唯一入口。 */
export function asOfMs(asOf) {
  if (fin(asOf)) return asOf
  const t = Date.parse(String(asOf || ''))
  return Number.isFinite(t) ? t : NaN
}

/** 「近 N 天」窗口的起点（毫秒）：基准时刻先归到它所在的 UTC 零点再往前数 N 天。
 *  ★ 全模块只此一处（近期明细、星座表的近 N 天 / 近 365 天、卫星组的近期入轨）：
 *    直接 t − N×24h 会落在当天某个钟点上，同一天上午与下午生成的报告差出好几条，
 *    而且第 5 章与第 6 章各算各的就会一边 19 一边 0（真编目 2026-10-15：千帆）。 */
export function windowStartMs(t, days) {
  if (!fin(t)) return NaN
  const d = new Date(t)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - days * DAY_MS
}

// 月序号：以 1957-01 为 0 的连续月编号（发射 / 陨落序列、在轨累计都按它对齐）
const monthIdxOfMs = (ms) => {
  const d = new Date(ms)
  return (d.getUTCFullYear() - 1957) * 12 + d.getUTCMonth()
}
const monthLabel = (idx) => {
  const y = 1957 + Math.floor(idx / 12)
  const m = idx % 12 + 1
  return y + '-' + (m < 10 ? '0' + m : String(m))
}

// ===================================================================================
// 1. 解析
// ===================================================================================

// 附录 A 的 17 列。表头按名字取列号（不按位置），上游加列也不会错位。
const SATCAT_COLS = ['OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'OBJECT_TYPE', 'OPS_STATUS_CODE',
  'OWNER', 'LAUNCH_DATE', 'LAUNCH_SITE', 'DECAY_DATE', 'PERIOD', 'INCLINATION',
  'APOGEE', 'PERIGEE', 'RCS', 'DATA_STATUS_CODE', 'ORBIT_CENTER', 'ORBIT_TYPE']

const numOrNull = (s) => {
  if (!s) return null
  const v = Number(s)
  return Number.isFinite(v) ? v : null
}

/**
 * SATCAT CSV → 行数组。字段名见契约 §4：norad 是【字符串】（与 GP 的 noradId 同型，便于 Map 对齐），
 * 字符串列空 → ''，数值列空 / 非数 → null。
 *
 * ★ 性能：约 6.6 万行 / 6.7 MB，目标 < 300 ms。不含引号的行走 String.split(',')（绝大多数行），
 *   含引号的行才退到 tle.js 的 splitCsvLine（名字里有逗号的星，如 "COSMOS 1, DEB"）——
 *   两条路径对无引号行的结果逐字相同（splitCsvLine 在无引号时就是按逗号切）。
 *   循环体里不建正则、不建闭包：DATE_RE / DIGITS_RE 都是模块级常量。
 */
export function parseSatcatCsv(text) {
  // 去 BOM：CelesTrak 的 CSV 偶带 UTF-8 BOM，不剥掉表头第一列名就匹配不上（NORAD_CAT_ID 尚在别的列，
  // 但 OBJECT_NAME 会整列取空）。剥在整份文本上做一次，比逐列 trim 便宜。
  const raw = String(text || '')
  const lines = (raw.charCodeAt(0) === 65279 ? raw.slice(1) : raw).split(/\r?\n/)
  let h = 0
  while (h < lines.length && !lines[h].trim()) h++
  if (h >= lines.length) return []
  const header = splitCsvLine(lines[h]).map((s) => s.trim().toUpperCase())
  const col = {}
  for (let i = 0; i < header.length; i++) col[header[i]] = i
  const ix = {}
  for (const n of SATCAT_COLS) ix[n] = (n in col ? col[n] : -1)
  if (ix.NORAD_CAT_ID < 0) return []

  const iName = ix.OBJECT_NAME, iObj = ix.OBJECT_ID, iId = ix.NORAD_CAT_ID, iType = ix.OBJECT_TYPE
  const iSt = ix.OPS_STATUS_CODE, iOwn = ix.OWNER, iLd = ix.LAUNCH_DATE, iLs = ix.LAUNCH_SITE
  const iDd = ix.DECAY_DATE, iPer = ix.PERIOD, iInc = ix.INCLINATION, iApo = ix.APOGEE
  const iPeri = ix.PERIGEE, iRcs = ix.RCS, iDs = ix.DATA_STATUS_CODE, iOc = ix.ORBIT_CENTER, iOt = ix.ORBIT_TYPE

  const out = []
  for (let r = h + 1; r < lines.length; r++) {
    const line = lines[r]
    if (!line || !line.trim()) continue
    const f = line.indexOf('"') < 0 ? line.split(',') : splitCsvLine(line)
    const norad = (iId < f.length ? f[iId] : '').trim()
    if (!norad) continue
    const g = (i) => (i >= 0 && i < f.length ? f[i].trim() : '')
    out.push({
      name: g(iName),
      objectId: g(iObj),
      norad,
      type: g(iType),
      status: g(iSt),
      owner: g(iOwn),
      launchDate: g(iLd),
      launchSite: g(iLs),
      decayDate: g(iDd),
      periodMin: numOrNull(g(iPer)),
      inclDeg: numOrNull(g(iInc)),
      apogeeKm: numOrNull(g(iApo)),
      perigeeKm: numOrNull(g(iPeri)),
      rcsM2: numOrNull(g(iRcs)),
      dataStatus: g(iDs),
      orbitCenter: g(iOc),
      orbitType: g(iOt)
    })
  }
  return out
}

/**
 * 把编目倒推到基准时刻 t（ms）：之后才发射的行、以及编号 ≥ catalogCutNorad 的碎片去掉（那一刻还不存在 /
 * 尚未编目）；之后才陨落的行按在轨计 ——
 * 清掉 DECAY_DATE、IMP 改回 ORB、状态码 D（已陨落）改成 ?（那一刻的运行状态编目里查不到）。
 * 其余字段（类型 / 所有者 / 根数）取最新编目值。基准时刻就是「现在」时没有任何行要改，【原样返回同一个数组】
 * （下游按数组身份做的缓存因此照常命中）。星历侧（GP）不在这里：历史星历取不到，按最新的用，判据表写明。
 */
export function backdateRows(rows, t) {
  const list = Array.isArray(rows) ? rows : []
  if (!fin(t)) return list
  // ★ 碎片的 LAUNCH_DATE 是母体发射日，按它去留会把基准之后才解体 / 编目的碎片留下（2026-09 YAOGAN-50 02
  //   解体的 72 条在回溯到 08-31 时全进了「近 30 天新编目碎片」）。编目时刻用 NORAD 近似（同 recentDebris）：
  //   基准之后首个发射对象的编号即截断，编号不小于它的 DEB 当时尚未编目。
  const cut = catalogCutNorad(list, t)
  let out = null
  for (let i = 0; i < list.length; i++) {
    const r = list[i]
    const lm = dayMs(r.launchDate)
    const dm = dayMs(r.decayDate)
    const late = (fin(lm) && lm > t) || (r.type === 'DEB' && Number(r.norad) >= cut)
    const alive = !late && fin(dm) && dm > t
    if (!late && !alive) { if (out) out.push(r); continue }
    if (!out) out = list.slice(0, i)
    if (alive) out.push(Object.assign({}, r, { decayDate: '', orbitType: r.orbitType === 'IMP' ? 'ORB' : r.orbitType, status: r.status === 'D' ? '?' : r.status }))
  }
  return out || list
}

/**
 * 编目截断号：LAUNCH_DATE 晚于 t 的首个发射对象（载荷 / 火箭体）的最小 NORAD；没有则 Infinity。
 * 编号不小于它的对象视为 t 之后才编目（backdateRows / recentDebris / debrisCataloguedBetween 同一近似）。
 */
export function catalogCutNorad(rows, t) {
  let cut = Infinity
  if (!fin(t)) return cut
  for (const r of (rows || [])) {
    if (!isPayRb(r)) continue
    const ms = dayMs(r.launchDate), n = Number(r.norad)
    if (fin(ms) && ms > t && Number.isFinite(n) && n < cut) cut = n
  }
  return cut
}

/** NORAD（字符串）→ 行 */
export function buildIndex(rows) {
  const m = new Map()
  for (const r of (rows || [])) if (r && r.norad) m.set(r.norad, r)
  return m
}

// ===================================================================================
// 2. 谓词（附录 C）
// ===================================================================================

// 「围着地球转」：ORBIT_CENTER 为 EA，或为纯数字（数字＝停靠母体的 NORAD，母体本身在地球轨道上）。
const centerIsEarth = (row) => {
  const c = row.orbitCenter
  return c === 'EA' || c === '' || DIGITS_RE.test(c)
}

/** 深空 / 着陆：ORBIT_CENTER ≠ EA（非地球中心天体），或 ORBIT_TYPE ∈ {LAN, R/T}。
 *  单独计数，不进区制表与所有者表 —— 它们既不「在轨」也不是地球轨道上的「陨落」。 */
export function isDeepSpace(row) {
  if (!row) return false
  const t = row.orbitType
  if (t === 'LAN' || t === 'R/T') return true
  return !centerIsEarth(row)
}

/** 在轨：DECAY_DATE 为空 且 ORBIT_TYPE ∈ {ORB, DOC} 且中心为地球（含数字＝停靠母体）。 */
export function isInOrbit(row) {
  if (!row || isDeepSpace(row)) return false
  if (row.decayDate) return false
  const t = row.orbitType
  return (t === 'ORB' || t === 'DOC') && centerIsEarth(row)
}

/** 已陨落：DECAY_DATE 非空，或 ORBIT_TYPE = IMP（撞击 / 再入）；均要求中心为地球。
 *  与 isInOrbit / isDeepSpace 三者互斥且覆盖全表（测试里以「类型合计 = 三者之和」把这条钉死）。 */
export function isDecayed(row) {
  if (!row || isDeepSpace(row)) return false
  if (!centerIsEarth(row)) return false
  return !!row.decayDate || row.orbitType === 'IMP'
}

/** 活跃载荷：OBJECT_TYPE = PAY 且 OPS_STATUS_CODE ∈ {+, P, B, S, X}（CelesTrak status.php）。 */
export function isActive(row) {
  if (!row || row.type !== 'PAY') return false
  return ACTIVE_STATUS.indexOf(row.status) >= 0
}

/**
 * ★ 报告里所有「活跃载荷」的计数一律用这条（isActive 再叠一道「在轨」）：
 *   2026-09-16 的编目里有 64 颗深空探测器（ORBIT_CENTER = SU / MO / MA…）状态是 + 或 P，
 *   它们确实在工作，但不在地球轨道上 —— 附录 C 明写深空 / 着陆不进区制表与所有者表，
 *   总览里的活跃载荷数自然也要同口径，否则总览（17066）与区制表逐行相加（17002）对不上。
 */
export const isActiveInOrbit = (row) => isActive(row) && isInOrbit(row)

/**
 * 区制：走 orbitClass.classifyOrbit。SATCAT 行只有周期与近 / 远地点【高度】，故
 *   e = (APOGEE − PERIGEE) / (APOGEE + PERIGEE + 2·Re)，a 由 PERIOD 反推（classifyOrbit 内部做）。
 * 根数为空（既无 PERIOD，又缺近 / 远地点）→ '—'：编目里 DATA_STATUS_CODE = NEA / NIE 的星就是这类，
 * 它们有真实轨道但根数不公开，归不出区制来，报告里如实留 '—' 而不是塞进 MEO。
 */
export function regimeOf(row) {
  if (!row) return '—'
  const per = row.periodMin, ap = row.apogeeKm, pe = row.perigeeKm
  const hasAlt = fin(ap) && fin(pe)
  if (!fin(per) && !hasAlt) return '—'
  const e = hasAlt ? (ap - pe) / (ap + pe + 2 * RE_KM) : 0
  return classifyOrbit({
    e,
    inclDeg: fin(row.inclDeg) ? row.inclDeg : 0,
    periodMin: fin(per) ? per : undefined,
    perigeeAltKm: hasAlt ? pe : undefined,
    apogeeAltKm: hasAlt ? ap : undefined
  })
}

/** 平均高度（km）：(远地点 + 近地点) / 2；缺一即 null。分箱 / 密度格用。 */
export function meanAltKm(row) {
  if (!row || !fin(row.apogeeKm) || !fin(row.perigeeKm)) return null
  return (row.apogeeKm + row.perigeeKm) / 2
}

// ===================================================================================
// 3. 编目总览 / 区制 / 所有者
// ===================================================================================

/** 类型 × {在轨, 已陨落, 深空/着陆, 合计} + 活跃载荷 + 停靠 / 着陆 / 再入计数。 */
export function catalogOverview(rows) {
  rows = rows || []
  const acc = new Map()
  const get = (code) => {
    let o = acc.get(code)
    if (!o) acc.set(code, (o = { code, inOrbit: 0, decayed: 0, deepSpace: 0, total: 0, active: 0 }))
    return o
  }
  for (const c of TYPE_ORDER) get(c)
  let inOrbit = 0, decayed = 0, deepSpace = 0, active = 0, docked = 0, landed = 0, impacted = 0
  for (const r of rows) {
    const o = get(r.type || 'UNK')
    o.total++
    if (isDeepSpace(r)) { o.deepSpace++; deepSpace++ } else if (isInOrbit(r)) { o.inOrbit++; inOrbit++ } else if (isDecayed(r)) { o.decayed++; decayed++ }
    if (isActiveInOrbit(r)) { o.active++; active++ }
    if (r.orbitType === 'DOC') docked++
    else if (r.orbitType === 'LAN') landed++
    // 只数地球轨道上的再入 / 撞击：月面 / 行星撞击体（ORBIT_CENTER ≠ EA）归深空，
    // 算进来会让这一项大于「已陨落」（真编目 35262 > 35183），而它本是已陨落的子集
    else if (r.orbitType === 'IMP' && isDecayed(r)) impacted++
  }
  // 固定序在前，上游万一冒出新类型码接在后面按字典序（行序确定）
  const known = new Set(TYPE_ORDER)
  const extra = [...acc.keys()].filter((k) => !known.has(k)).sort()
  const byType = [...TYPE_ORDER, ...extra].map((k) => acc.get(k))
  return { total: rows.length, inOrbit, decayed, deepSpace, active, docked, landed, impacted, byType }
}

/** 区制 × 类型（只数在轨），另给每个区制的活跃载荷数。 */
export function regimeTable(rows) {
  rows = rows || []
  const types = TYPE_ORDER.slice()
  const known = new Set(types)
  const acc = new Map()
  const get = (rg) => {
    let o = acc.get(rg)
    if (!o) { o = { regime: rg, byType: {}, total: 0, active: 0 }; for (const t of types) o.byType[t] = 0; acc.set(rg, o) }
    return o
  }
  for (const rg of REGIME_ORDER) get(rg)
  const total = { byType: {}, total: 0, active: 0 }
  for (const t of types) total.byType[t] = 0
  for (const r of rows) {
    if (!isInOrbit(r)) continue
    const o = get(regimeOf(r))
    const t = known.has(r.type) ? r.type : 'UNK'
    o.byType[t]++; o.total++
    total.byType[t]++; total.total++
    if (isActive(r)) { o.active++; total.active++ }
  }
  const extra = [...acc.keys()].filter((k) => REGIME_ORDER.indexOf(k) < 0).sort()
  return { types, rows: [...REGIME_ORDER, ...extra].map((k) => acc.get(k)), total }
}

/**
 * 所有者表：所有者 → {活跃载荷, 在轨载荷, 火箭体, 碎片, 在轨合计, 累计发射, 累计陨落}。
 * 深空 / 着陆的行不进本表（附录 C）。按在轨载荷降序，并列按代码升序，取前 topN 行。
 * ★ 2026-09-17 删掉了「钉住某一家所有者（不足榜也追加在表尾）」那档：榜长出厂 15 条，
 *   出厂钉的 PRC 恒在前几名，这个旋钮从未生效过。删净之后 rows 恒 = 前 topN 行，
 *   题注「在轨载荷前 N 位」才与实际行数真正对得上（原先钉住行不足榜时是 N + 1 行）。
 */
export function ownerTable(rows, opts) {
  rows = rows || []
  const topN = (opts && fin(opts.topN) && opts.topN > 0) ? Math.floor(opts.topN) : 15
  const acc = new Map()
  const get = (code) => {
    let o = acc.get(code)
    if (!o) acc.set(code, (o = { owner: code, active: 0, payloads: 0, rockets: 0, debris: 0, inOrbit: 0, launched: 0, decayed: 0 }))
    return o
  }
  for (const r of rows) {
    if (isDeepSpace(r)) continue
    const o = get(r.owner || 'UNK')
    // 累计·发射只计载荷 + 火箭体（附录判据「发射」口径；碎片的 LAUNCH_DATE 是母体发射日）
    if (isPayRb(r)) o.launched++
    if (isDecayed(r)) o.decayed++
    if (isInOrbit(r)) {
      o.inOrbit++
      if (r.type === 'PAY') { o.payloads++; if (isActive(r)) o.active++ } else if (r.type === 'R/B') o.rockets++
      else if (r.type === 'DEB') o.debris++
    }
  }
  const all = [...acc.values()].sort((a, b) => (b.payloads - a.payloads) || (b.inOrbit - a.inOrbit) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  const top = all.slice(0, topN)
  const KEYS = ['active', 'payloads', 'rockets', 'debris', 'inOrbit', 'launched', 'decayed']
  const zero = () => ({ owner: '', active: 0, payloads: 0, rockets: 0, debris: 0, inOrbit: 0, launched: 0, decayed: 0 })
  const total = zero()
  for (const o of all) for (const k of KEYS) total[k] += o[k]
  // 榜外各家并成一行「其余 N 家」：合计行是全表口径，不给这一行的话合计 ≠ 表内各行之和，读者对不上账
  const rest = zero()
  rest.count = all.length - top.length
  for (const o of all.slice(topN)) for (const k of KEYS) rest[k] += o[k]
  return { rows: top, rest, total, ownerCount: all.length, topN }
}

// ===================================================================================
// 4. 发射与陨落
// ===================================================================================

// 年序列骨架：起于 1957（人类第一次发射），止于 asOf 的 UTC 年；asOf 不给就取数据里的最大年。
function yearRange(rows, asOf, field) {
  let last = -Infinity
  const t = asOfMs(asOf)
  if (fin(t)) last = new Date(t).getUTCFullYear()
  else {
    for (const r of rows) { const ms = dayMs(r[field]); if (fin(ms)) last = Math.max(last, new Date(ms).getUTCFullYear()) }
  }
  if (!fin(last) || last < 1957) last = 1957
  const years = []
  for (let y = 1957; y <= last; y++) years.push(y)
  return years
}

// 发射序列只数载荷与火箭体：碎片的 LAUNCH_DATE 是【母体】的发射日，FY-1C 2007 年解体的
// 2000 多条碎片会全部记成 1999 年的「发射」（真编目：1999 年印 4299）。陨落序列不受此限 ——
// 碎片的 DECAY_DATE 是它自己的再入日，是真事件。
const isPayRb = (r) => r.type === 'PAY' || r.type === 'R/B'

function yearSeries(rows, asOf, field, keep, second) {
  rows = rows || []
  const years = yearRange(rows, asOf, field)
  const base = years[0]
  const sec = new Array(years.length).fill(0)
  const payload = new Array(years.length).fill(0)
  for (const r of rows) {
    if (keep && !keep(r)) continue
    const ms = dayMs(r[field])
    if (!fin(ms)) continue
    const i = new Date(ms).getUTCFullYear() - base
    if (i < 0 || i >= years.length) continue
    if (!second || second(r)) sec[i]++
    if (r.type === 'PAY') payload[i]++
  }
  return { years, payload, sec }
}

/** 逐年发射：{ years, payload, payRb }（payRb = 载荷与火箭体）。深空探测器也算一次发射，故不按状态过滤。 */
export function launchSeries(rows, opts) {
  const s = yearSeries(rows, opts && opts.asOf, 'launchDate', null, isPayRb)
  return { years: s.years, payload: s.payload, payRb: s.sec }
}

/** 逐年陨落：{ years, payload, all }。
 *  ★ 只数 isDecayed 的行，不是「凡有 DECAY_DATE 就算」：航天飞机一类 ORBIT_TYPE = R/T 的行也带
 *  返回日期，但它归深空 / 着陆一类，总览里不计入已陨落 —— 两处口径必须一致，否则报告里
 *  「逐年陨落」的总和会比「已陨落」多出几条，读者对不上账。 */
export function decaySeries(rows, opts) {
  const s = yearSeries(rows, opts && opts.asOf, 'decayDate', isDecayed)
  return { years: s.years, payload: s.payload, all: s.sec }
}

/**
 * 近 months 个月逐月：发射（载荷 / 全部）与陨落（载荷 / 全部）。
 * 末月 = asOf 所在月（含当月，当月是不完整月，报告里照实给数不做外推）。
 */
export function monthlySeries(rows, opts) {
  rows = rows || []
  const months = (opts && fin(opts.months) && opts.months > 0) ? Math.floor(opts.months) : 24
  const t = asOfMs(opts && opts.asOf)
  let endIdx
  if (fin(t)) endIdx = monthIdxOfMs(t)
  else {
    endIdx = -Infinity
    for (const r of rows) { const ms = dayMs(r.launchDate); if (fin(ms)) endIdx = Math.max(endIdx, monthIdxOfMs(ms)) }
    if (!fin(endIdx)) endIdx = 0
  }
  const startIdx = endIdx - months + 1
  const labels = [], launchPayRb = [], launchPay = [], decayAll = [], decayPay = []
  for (let i = 0; i < months; i++) { labels.push(monthLabel(startIdx + i)); launchPayRb.push(0); launchPay.push(0); decayAll.push(0); decayPay.push(0) }
  for (const r of rows) {
    // 发射只数载荷与火箭体（与 launchSeries 同口径，见 isPayRb 的注释）
    const lm = isPayRb(r) ? dayMs(r.launchDate) : NaN
    if (fin(lm)) { const i = monthIdxOfMs(lm) - startIdx; if (i >= 0 && i < months) { launchPayRb[i]++; if (r.type === 'PAY') launchPay[i]++ } }
    const dm = isDecayed(r) ? dayMs(r.decayDate) : NaN   // 与 decaySeries 同口径，见那里的注释
    if (fin(dm)) { const i = monthIdxOfMs(dm) - startIdx; if (i >= 0 && i < months) { decayAll[i]++; if (r.type === 'PAY') decayPay[i]++ } }
  }
  // 逐月发射次数（发射编号去重，与 launchCountSeries 同口径）
  const launches = new Array(months).fill(0)
  for (const e of launchEvents(rows)) { const ms = dayMs(e.date); if (!fin(ms)) continue; const i = monthIdxOfMs(ms) - startIdx; if (i >= 0 && i < months) launches[i]++ }
  return { months: labels, launches, launchPayRb, launchPay, decayAll, decayPay }
}

/**
 * 逐月在轨对象数：发射 +1、陨落 −1 的前缀和。深空 / 着陆不计（它们不在地球轨道上）。
 * ★ 末值必须等于 catalogOverview().inOrbit —— 这是本函数的正确性判据，测试里钉死。为此两处兜底：
 *   · 无 LAUNCH_DATE 的在轨星：记在序列首月（否则它永远不会被计入，末值就少了）；
 *   · 判为已陨落却无 DECAY_DATE 的星（ORBIT_TYPE = IMP 且日期缺失）：−1 记在它自己的发射月，净零。
 */
export function inOrbitCumulative(rows, opts) {
  rows = rows || []
  const t = asOfMs(opts && opts.asOf)
  let endIdx = fin(t) ? monthIdxOfMs(t) : -Infinity
  if (!fin(endIdx)) {
    for (const r of rows) { const ms = dayMs(r.launchDate); if (fin(ms)) endIdx = Math.max(endIdx, monthIdxOfMs(ms)) }
    if (!fin(endIdx)) endIdx = 9   // 1957-10：只有空表才会走到这里
  }
  const startIdx = 9               // 1957-10，第一次入轨
  const n = Math.max(1, endIdx - startIdx + 1)
  const delta = new Array(n).fill(0)
  const clamp = (i) => (i < 0 ? 0 : i >= n ? n - 1 : i)
  for (const r of rows) {
    if (isDeepSpace(r)) continue
    const inOrb = isInOrbit(r), dec = isDecayed(r)
    if (!inOrb && !dec) continue
    const lm = dayMs(r.launchDate)
    const li = fin(lm) ? clamp(monthIdxOfMs(lm) - startIdx) : 0
    delta[li]++
    if (dec) {
      const dm = dayMs(r.decayDate)
      const di = fin(dm) ? clamp(monthIdxOfMs(dm) - startIdx) : li
      delta[di]--
    }
  }
  const months = [], counts = []
  let acc = 0
  for (let i = 0; i < n; i++) { acc += delta[i]; months.push(monthLabel(startIdx + i)); counts.push(acc) }
  return { months, counts }
}

// 近 N 天明细的共用体：载荷与火箭体列明细，碎片只计数（附录 B §5）。keep 与年 / 月序列同口径。
function recentDetail(rows, opts, field, keep) {
  rows = rows || []
  const days = (opts && fin(opts.days) && opts.days > 0) ? Math.floor(opts.days) : 30
  const t = asOfMs(opts && opts.asOf)
  const payloads = [], rockets = []
  let debris = 0, other = 0
  if (!fin(t)) return { days, from: '', payloads, rockets, debris, other, total: 0 }
  // 窗口起点按 UTC 日历日（windowStartMs，全模块一处）
  const fromMs = windowStartMs(t, days)
  for (const r of rows) {
    if (keep && !keep(r)) continue
    const ms = dayMs(r[field])
    if (!fin(ms) || ms < fromMs || ms > t) continue
    if (r.type === 'PAY') payloads.push(detailRow(r, field))
    else if (r.type === 'R/B') rockets.push(detailRow(r, field))
    else if (r.type === 'DEB') debris++
    else other++
  }
  const cmp = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : byNorad(a.norad, b.norad))
  payloads.sort(cmp); rockets.sort(cmp)
  const d = new Date(fromMs)
  const p2 = (x) => (x < 10 ? '0' + x : String(x))
  const from = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
  return { days, from, payloads, rockets, debris, other, total: payloads.length + rockets.length + debris + other }
}

const detailRow = (r, field) => ({
  norad: r.norad, name: r.name, objectId: r.objectId, owner: r.owner,
  date: r[field], launchSite: r.launchSite, type: r.type, status: r.status, regime: regimeOf(r)
})

/** 近 N 天新发射。 */
export function recentLaunches(rows, opts) { return recentDetail(rows, opts, 'launchDate') }

/** 近 N 天陨落（与 decaySeries 同口径，只数 isDecayed 的行）。 */
export function recentDecays(rows, opts) { return recentDetail(rows, opts, 'decayDate', isDecayed) }

// ===================================================================================
// 4b. 发射按「次」（国际编号）
// ===================================================================================

// 国际编号 YYYY-NNNP → 发射编号 YYYY-NNN（一次入轨发射一个编号，同一次发射的载荷 / 火箭体 / 碎片共用）
const LAUNCH_KEY_RE = /^(\d{4}-\d{3})/
export const launchKeyOf = (row) => { const m = LAUNCH_KEY_RE.exec(String((row && row.objectId) || '')); return m ? m[1] : '' }

// 出现次数最多的值（并列取字典序最小 —— 确定性）
function modeOf(list) {
  const m = new Map()
  for (const v of list) if (v) m.set(v, (m.get(v) || 0) + 1)
  let best = '', n = 0
  for (const [v, c] of m) if (c > n || (c === n && v < best)) { best = v; n = c }
  return best
}

/**
 * 发射事件表：按发射编号归并。每次发射 = { key, date, year, site, vehicle, payloads, rocketBodies, owners[], payloadNames[] }。
 * · date = 该编号下最早的 LAUNCH_DATE（同一次发射的对象本应同日，取最早防个别录入偏差）；
 * · vehicle = 火箭体名去掉「R/B」尾巴（编目里一次发射的末级就叫「CZ-2D R/B」「FALCON 9 R/B」）；
 * · 碎片只认它属于哪次发射，不算发射本身的产物计数。
 * 编目里查不到发射编号的行（极少数早期 / 不规范的国际编号）不进本表。
 */
// 同一份 rows 在一次建模里会被关键指标、逐年 / 逐月、近 N 天各问一遍：按数组身份缓存（WeakMap，数组没了缓存跟着走）。
// ★ 出参只读：调用方 filter / map 出新数组，不许就地改。
const _evCache = new WeakMap()
export function launchEvents(rows) {
  if (Array.isArray(rows)) { const c = _evCache.get(rows); if (c) return c }
  const out = launchEventsRaw(rows)
  if (Array.isArray(rows)) _evCache.set(rows, out)
  return out
}
function launchEventsRaw(rows) {
  const acc = new Map()
  for (const r of (rows || [])) {
    // 碎片不立发射事件：只按碎片筛出来的范围（对象类型＝碎片）里不该冒出「发射」来
    if (r.type === 'DEB') continue
    const k = launchKeyOf(r)
    if (!k) continue
    let e = acc.get(k)
    if (!e) acc.set(k, (e = { key: k, date: '', sites: [], vehicles: [], payloads: 0, rocketBodies: 0, owners: [], payloadNames: [] }))
    const d = r.launchDate
    if (d && (!e.date || d < e.date)) e.date = d
    if (r.launchSite) e.sites.push(r.launchSite)
    if (r.type === 'PAY') { e.payloads++; e.owners.push(r.owner || ''); e.payloadNames.push({ norad: r.norad, name: r.name }) }
    else if (r.type === 'R/B') { e.rocketBodies++; e.vehicles.push(String(r.name || '').replace(/\s*R\/B.*$/, '').trim()) }
  }
  const out = []
  for (const e of acc.values()) {
    if (!e.date) continue
    e.payloadNames.sort((a, b) => byNorad(a.norad, b.norad))
    const owners = [...new Set(e.owners.filter(Boolean))].sort()
    out.push({
      key: e.key, date: e.date, year: Number(e.date.slice(0, 4)), site: modeOf(e.sites), vehicle: modeOf(e.vehicles),
      payloads: e.payloads, rocketBodies: e.rocketBodies, owners, payloadNames: e.payloadNames.map((p) => p.name)
    })
  }
  out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.key < b.key ? 1 : -1)))
  return out
}

/** 逐年发射次数（与 launchSeries 同一条年轴，1957 起至 asOf 年）。 */
export function launchCountSeries(rows, opts) {
  const years = yearRange(rows || [], opts && opts.asOf, 'launchDate')
  const base = years[0]
  const counts = new Array(years.length).fill(0)
  for (const e of launchEvents(rows)) {
    const i = e.year - base
    if (i >= 0 && i < years.length) counts[i]++
  }
  return { years, counts }
}

/**
 * 本年至今与去年同期：发射次数 / 入轨载荷 / 陨落对象。「同期」= 去年 1 月 1 日至与基准日同月同日（UTC）。
 * 返回 { year, md, cur: {launches, payloads, decays}, prev: {…} }。asOf 不合法返回 null。
 */
export function yearToDate(rows, opts) {
  const t = asOfMs(opts && opts.asOf)
  if (!fin(t)) return null
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const p2 = (x) => (x < 10 ? '0' + x : String(x))
  const md = p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
  const inYtd = (date, yy) => !!date && date.slice(0, 4) === String(yy) && date.slice(5, 10) <= md
  const tally = (yy) => {
    let launches = 0, payloads = 0, decays = 0
    for (const e of launchEvents(rows)) if (inYtd(e.date, yy)) launches++
    for (const r of (rows || [])) {
      if (r.type === 'PAY' && inYtd(r.launchDate, yy)) payloads++
      if (isDecayed(r) && inYtd(r.decayDate, yy)) decays++
    }
    return { launches, payloads, decays }
  }
  return { year: y, md, cur: tally(y), prev: tally(y - 1) }
}

/**
 * 某一时刻的在轨存量（倒推）：发射日 ≤ D、且此刻仍在轨或陨落日 > D 的对象数。与 inOrbitCumulative 同一口径
 * （编目里被删掉的条目看不见，所以是「此刻这份编目眼里的那一天」）。type 给了就只数该类型。
 */
export function inOrbitAt(rows, ms, type) {
  if (!fin(ms)) return null
  let n = 0
  for (const r of (rows || [])) {
    if (type && r.type !== type) continue
    if (isDeepSpace(r)) continue
    const lm = dayMs(r.launchDate)
    if (!fin(lm) || lm > ms) continue
    if (isInOrbit(r)) { n++; continue }
    if (isDecayed(r)) { const dm = dayMs(r.decayDate); if (fin(dm) && dm > ms) n++ }
  }
  return n
}

/**
 * 一个时间窗 [fromMs, toMs]（UTC 日历日，两端含）里的流量：发射次数 / 入轨载荷 / 陨落对象 / 陨落载荷。
 * 关键指标页「近 N 天 vs 前 N 天」「本年至今 vs 去年同期」都走它。
 */
export function windowFlows(rows, fromMs, toMs) {
  const inW = (s) => { const ms = dayMs(s); return fin(ms) && ms >= fromMs && ms <= toMs }
  let launches = 0, payloads = 0, decays = 0, decaysPay = 0
  for (const e of launchEvents(rows)) if (inW(e.date)) launches++
  for (const r of (rows || [])) {
    if (r.type === 'PAY' && inW(r.launchDate)) payloads++
    if (isDecayed(r) && inW(r.decayDate)) { decays++; if (r.type === 'PAY') decaysPay++ }
  }
  return { launches, payloads, decays, decaysPay }
}

/**
 * 窗口 [fromMs, toMs] 内新编目的碎片数（NORAD 近似编目时间，口径同 recentDebris）：编号 ≥ 窗口内首个新发射
 * 对象的编号、且 < 窗口之后首个新发射对象的编号（窗口之后没有发射就不设上限）。窗口内无发射返回 null。
 * opts.boundRows：定界用的编目（缺省 = rows）—— 按所有者 / 类型筛后的 rows 里可能没有发射对象，界须取全量；
 * opts.hiNorad：外加的上界（回溯时 rows 已不含基准之后的发射，传 catalogCutNorad(原始编目, t)）。
 */
export function debrisCataloguedBetween(rows, fromMs, toMs, opts) {
  let lo = Infinity, hi = (opts && Number.isFinite(opts.hiNorad)) ? opts.hiNorad : Infinity
  for (const r of ((opts && opts.boundRows) || rows || [])) {
    if (!isPayRb(r)) continue
    const ms = dayMs(r.launchDate), n = Number(r.norad)
    if (!fin(ms) || !Number.isFinite(n)) continue
    if (ms >= fromMs && ms <= toMs) { if (n < lo) lo = n } else if (ms > toMs) { if (n < hi) hi = n }
  }
  if (!fin(lo)) return null
  let c = 0
  for (const r of (rows || [])) {
    if (r.type !== 'DEB' || isDeepSpace(r)) continue
    const n = Number(r.norad)
    if (Number.isFinite(n) && n >= lo && n < hi) c++
  }
  return c
}

/** 逐年按对象类型分列（堆叠柱图用）：field = 'launchDate' | 'decayDate'；keep 过滤行。
 *  返回 { years, byType: { PAY, 'R/B', DEB, UNK } }，年轴与 launchSeries 同一条。 */
export function yearByType(rows, opts, field, keep) {
  const years = yearRange(rows || [], opts && opts.asOf, field)
  const base = years[0]
  const byType = {}
  for (const ty of TYPE_ORDER) byType[ty] = new Array(years.length).fill(0)
  for (const r of (rows || [])) {
    if (keep && !keep(r)) continue
    const ms = dayMs(r[field])
    if (!fin(ms)) continue
    const i = new Date(ms).getUTCFullYear() - base
    if (i < 0 || i >= years.length) continue
    byType[TYPE_ORDER.indexOf(r.type) >= 0 ? r.type : 'UNK'][i]++
  }
  return { years, byType }
}

/** 近 N 天的发射事件（窗口与近期明细同一条，按 UTC 日历日）。 */
export function recentLaunchEvents(rows, opts) {
  const days = (opts && fin(opts.days) && opts.days > 0) ? Math.floor(opts.days) : 30
  const t = asOfMs(opts && opts.asOf)
  if (!fin(t)) return []
  const from = windowStartMs(t, days)
  return launchEvents(rows).filter((e) => { const ms = dayMs(e.date); return fin(ms) && ms >= from && ms <= t })
}

// ===================================================================================
// 4c. 碎片与解体
// ===================================================================================

// 碎片名 → 母体名：「FENGYUN 1C DEB」→「FENGYUN 1C」；「COSMOS 2251 DEB」→「COSMOS 2251」
const parentNameOf = (name) => String(name || '').replace(/\s*\bDEB\b.*$/, '').trim()

/**
 * 碎片按母体（发射编号）归并：{ key, parent, owner, year, total, inOrbit, decayed }，按在轨碎片降序。
 * 母体名取该编号下碎片名去掉「DEB」后的众数（同一次发射可能有载荷与末级两个母体，取碎片最多的那个名）。
 * 返回 { rows（全部，调用方取前 N）, debrisInOrbit, debrisTotal, parents }。
 */
const _dbCache = new WeakMap()
export function debrisByParent(rows) {
  if (Array.isArray(rows)) { const c = _dbCache.get(rows); if (c) return c }
  const out = debrisByParentRaw(rows)
  if (Array.isArray(rows)) _dbCache.set(rows, out)
  return out
}
function debrisByParentRaw(rows) {
  const acc = new Map()
  let debrisInOrbit = 0, debrisTotal = 0
  for (const r of (rows || [])) {
    if (r.type !== 'DEB' || isDeepSpace(r)) continue
    debrisTotal++
    const io = isInOrbit(r)
    if (io) debrisInOrbit++
    const k = launchKeyOf(r) || ('?' + parentNameOf(r.name))
    let e = acc.get(k)
    if (!e) acc.set(k, (e = { key: launchKeyOf(r), names: [], owners: [], dates: [], total: 0, inOrbit: 0, decayed: 0 }))
    e.names.push(parentNameOf(r.name)); e.owners.push(r.owner || ''); e.dates.push(r.launchDate || '')
    e.total++
    if (io) e.inOrbit++
    else if (isDecayed(r)) e.decayed++
  }
  const out = [...acc.values()].map((e) => ({
    key: e.key, parent: modeOf(e.names), owner: modeOf(e.owners),
    year: (modeOf(e.dates) || '').slice(0, 4), total: e.total, inOrbit: e.inOrbit, decayed: e.decayed
  }))
  out.sort((a, b) => (b.inOrbit - a.inOrbit) || (b.total - a.total) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { rows: out, debrisInOrbit, debrisTotal, parents: out.length }
}

/**
 * 近 N 天新编目的碎片（按母体归并）。SATCAT 不带编目日期，这里用 NORAD 编号近似：编号按编目先后分配，
 * 窗口内首个新发射对象（载荷 / 火箭体，LAUNCH_DATE 落在窗口内）拿到的最小编号即窗口起点，编号不小于它的
 * 碎片即近期编目。窗口内没有发射时无从定界，返回空表。判据写进报告附录。
 * 上界：基准之后首个发射对象的编号（与 debrisCataloguedBetween 同口径），opts.hiNorad 可再收紧。
 * opts.boundRows：定界用的编目（缺省 = rows），计数仍按 rows。
 * 返回 { fromNorad, rows: [{ key, parent, owner, year, n, inOrbit }], total }。
 */
export function recentDebris(rows, opts) {
  const days = (opts && fin(opts.days) && opts.days > 0) ? Math.floor(opts.days) : 30
  const t = asOfMs(opts && opts.asOf)
  const empty = { fromNorad: null, rows: [], total: 0 }
  if (!fin(t)) return empty
  const from = windowStartMs(t, days)
  let minNo = Infinity
  let maxNo = (opts && Number.isFinite(opts.hiNorad)) ? opts.hiNorad : Infinity
  for (const r of ((opts && opts.boundRows) || rows || [])) {
    if (!isPayRb(r)) continue
    const ms = dayMs(r.launchDate)
    const n = Number(r.norad)
    if (!fin(ms) || !Number.isFinite(n)) continue
    if (ms > t) { if (n < maxNo) maxNo = n; continue }
    if (ms >= from && n < minNo) minNo = n
  }
  if (!fin(minNo)) return empty
  const acc = new Map()
  let total = 0
  for (const r of (rows || [])) {
    if (r.type !== 'DEB' || isDeepSpace(r)) continue
    const n = Number(r.norad)
    if (!Number.isFinite(n) || n < minNo || n >= maxNo) continue
    total++
    const k = launchKeyOf(r) || ('?' + parentNameOf(r.name))
    let e = acc.get(k)
    if (!e) acc.set(k, (e = { key: launchKeyOf(r), names: [], owners: [], dates: [], n: 0, inOrbit: 0 }))
    e.names.push(parentNameOf(r.name)); e.owners.push(r.owner || ''); e.dates.push(r.launchDate || '')
    e.n++
    if (isInOrbit(r)) e.inOrbit++
  }
  const out = [...acc.values()].map((e) => ({ key: e.key, parent: modeOf(e.names), owner: modeOf(e.owners), year: (modeOf(e.dates) || '').slice(0, 4), n: e.n, inOrbit: e.inOrbit }))
  out.sort((a, b) => (b.n - a.n) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { fromNorad: minNo, rows: out, total }
}

// ===================================================================================
// 4d. 低轨空间密度剖面
// ===================================================================================

/**
 * 空间密度（个 / km³）随高度的剖面，按对象类型分列 —— 每个在轨对象按开普勒轨道在各高度壳层里的
 * 【停留时间比例】摊开（近圆轨道整颗落在一层，椭圆轨道按时间摊到近地点—远地点之间各层），
 * 再除以壳层体积 4/3·π·(R₂³ − R₁³)。这是 ESA《Space Environment Report》空间密度图的同一算法口径。
 *   时间比例：r = a(1 − e·cosE)，M = E − e·sinE，r ≤ R 的时间比例 F(R) = (E_R − e·sin E_R) / π，
 *   E_R = arccos((1 − R/a) / e)；壳层 [R₁, R₂) 的比例 = F(R₂) − F(R₁)。
 * 近 / 远地点取 SATCAT 的 PERIGEE / APOGEE（km，整数）。缺任一即不计。
 * 返回 { lo, hi, step, bins: [{ h0, h1 }], types, density: { PAY: [...], 'R/B': [...], DEB: [...], UNK: [...] }, n }。
 */
export function spatialDensity(rows, opts) {
  const lo = (opts && fin(opts.lo)) ? opts.lo : 200
  const hi = (opts && fin(opts.hi)) ? opts.hi : 2000
  const step = (opts && fin(opts.step) && opts.step > 0) ? opts.step : 20
  const nb = Math.max(1, Math.round((hi - lo) / step))
  const bins = []
  for (let i = 0; i < nb; i++) bins.push({ h0: lo + i * step, h1: lo + (i + 1) * step })
  const types = TYPE_ORDER.slice()
  const density = {}
  for (const ty of types) density[ty] = new Array(nb).fill(0)
  const vol = bins.map((b) => (4 / 3) * Math.PI * (Math.pow(RE_KM + b.h1, 3) - Math.pow(RE_KM + b.h0, 3)))
  let n = 0
  for (const r of (rows || [])) {
    if (!isInOrbit(r) || !fin(r.perigeeKm) || !fin(r.apogeeKm)) continue
    const hp = Math.min(r.perigeeKm, r.apogeeKm), ha = Math.max(r.perigeeKm, r.apogeeKm)
    if (hp >= hi || ha < lo) continue
    const ty = types.indexOf(r.type) >= 0 ? r.type : 'UNK'
    const rp = RE_KM + hp, ra = RE_KM + ha
    const a = (rp + ra) / 2, e = (ra - rp) / (ra + rp)
    const F = (h) => {
      const R = RE_KM + h
      if (R <= rp) return 0
      if (R >= ra) return 1
      if (e < 1e-9) return R >= a ? 1 : 0
      const c = Math.max(-1, Math.min(1, (1 - R / a) / e))
      const E = Math.acos(c)
      return (E - e * Math.sin(E)) / Math.PI
    }
    let counted = false
    for (let i = 0; i < nb; i++) {
      const b = bins[i]
      if (b.h1 <= hp || b.h0 > ha) continue
      // 近圆轨道（近远地点同一层）整颗落进该层
      const frac = (hp >= b.h0 && ha < b.h1) ? 1 : F(b.h1) - F(b.h0)
      if (frac > 0) { density[ty][i] += frac / vol[i]; counted = true }
    }
    if (counted) n++
  }
  return { lo, hi, step, bins, types, density, n }
}

// ===================================================================================
// 4e. GEO 经度段
// ===================================================================================

/** GEO 定点按 step°（缺省 10°）经度段计数：全程 −180…180，每段 { from, to, n, active }。
 *  sats = geoOccupancy().sats（已带 status）。active = 状态码属活跃（与 isActive 同一张码表）。 */
export function geoSegments(sats, step) {
  const s = (fin(step) && step > 0) ? step : 10
  const nb = Math.round(360 / s)
  const out = []
  for (let i = 0; i < nb; i++) out.push({ from: -180 + i * s, to: -180 + (i + 1) * s, n: 0, active: 0 })
  for (const x of (sats || [])) {
    if (!fin(x.lon)) continue
    let i = Math.floor((x.lon + 180) / s)
    if (i < 0) i = 0
    if (i >= nb) i = nb - 1
    out[i].n++
    if (ACTIVE_STATUS.indexOf(x.status) >= 0) out[i].active++
  }
  return out
}

// ===================================================================================
// 5. 大型星座部署
// ===================================================================================

/** 名称 → 星座 key（第一个命中的模式即归属，未命中返回 ''）。 */
export const constKeyOf = (name) => {
  const s = String(name || '')
  for (let i = 0; i < CONST_PATTERNS.length; i++) if (CONST_PATTERNS[i].re.test(s)) return CONST_PATTERNS[i].key
  return ''
}

/** 编目行 → 星座 key：名称前缀 + 必须是载荷（星座成员是卫星，不是名字带前缀的碎片 / 火箭体）。 */
export const constKeyOfRow = (row) => (row && row.type === 'PAY' ? constKeyOf(row.name) : '')

/** 星历记录 → 星座 key。编目里查得到：按那一行（名称 + 类型；编目名不中再试星历名）；
 *  查不到：只能按星历名。index = 全量编目索引（NORAD 字符串 → 行）。 */
export function constKeyOfGp(g, index) {
  if (!g) return ''
  const row = index instanceof Map ? index.get(String(g.noradId)) : null
  if (row) return row.type === 'PAY' ? (constKeyOf(row.name) || constKeyOf(g.name)) : ''
  return constKeyOf(g.name)
}

/** 前 n 位，并列的同进同出：第 n 位与其后取值相同的一律留下（按 key 降序已排好的数组）。 */
export function topWithTies(sorted, n, key) {
  const list = sorted || []
  if (list.length <= n) return list.slice()
  const cut = key(list[n - 1])
  let end = n
  while (end < list.length && key(list[end]) === cut) end++
  return list.slice(0, end)
}

// ===================================================================================
// 5b. 报告范围筛选
// ===================================================================================

// 四道可叠加的筛选：典型星座 / 所有者 / 轨道区制 / 对象类型。空数组 = 该维度不筛。
// 叠加是【交集】—— 四维都给了就是「同时满足」，报告第 1 章会把生效的逐条列出来。
//
// ★ 两处口径要说清楚（也写进了报告的「口径与判据」）：
//   · 区制筛选按 regimeOf 的结果比，故【无根数的行（区制记「—」）在区制筛选生效时一律落选】——
//     它们不是「不属于这些区制」，而是判不出来，硬塞进哪一档都是编数；
//   · 星座筛选走名称前缀（CONST_PATTERNS），是近似归类，不是 CelesTrak 的 GROUP 名单。
export const FILTER_KEYS = ['constellations', 'owners', 'regimes', 'types']

/** 把任意入参规整成确定性的筛选条件（去空、去重、排序 —— 同一组条件必须建出逐字相同的报告）。 */
export function normFilters (v) {
  const s = v || {}
  const arr = (x) => {
    if (!Array.isArray(x)) return []
    const out = []
    for (const it of x) {
      const t = String(it == null ? '' : it).trim()
      if (t && out.indexOf(t) < 0) out.push(t)
    }
    return out.sort()
  }
  return { constellations: arr(s.constellations), owners: arr(s.owners), regimes: arr(s.regimes), types: arr(s.types) }
}

/** 有没有任何一维在筛。 */
export const hasFilters = (f) => FILTER_KEYS.some((k) => (f && f[k] || []).length > 0)

/** 逐行判定：全部生效维度都命中才留下。 */
export function rowPassesFilters (row, f) {
  if (!row || !f) return true
  if (f.constellations && f.constellations.length && f.constellations.indexOf(constKeyOfRow(row)) < 0) return false
  if (f.owners && f.owners.length && f.owners.indexOf(String(row.owner || '').trim()) < 0) return false
  if (f.types && f.types.length && f.types.indexOf(String(row.type || '').trim()) < 0) return false
  if (f.regimes && f.regimes.length && f.regimes.indexOf(regimeOf(row)) < 0) return false
  return true
}

/** 编目行数组 → 过筛后的数组（不筛时【原样返回同一个数组】，省一次 7 万行的拷贝）。 */
export function filterRows (rows, f) {
  const list = Array.isArray(rows) ? rows : []
  if (!hasFilters(f)) return list
  return list.filter((r) => rowPassesFilters(r, f))
}

/** 编目里实际出现过的所有者代码 → [{ code, inOrbit, payloads }]，按在轨载荷降序（供筛选器下拉排序）。 */
export function ownerOptions (rows) {
  const m = new Map()
  for (const r of (rows || [])) {
    const c = String(r.owner || '').trim()
    if (!c) continue
    let e = m.get(c)
    if (!e) m.set(c, (e = { code: c, inOrbit: 0, payloads: 0 }))
    if (isInOrbit(r)) { e.inOrbit++; if (r.type === 'PAY') e.payloads++ }
  }
  return [...m.values()].sort((a, b) => (b.payloads - a.payloads) || (b.inOrbit - a.inOrbit) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** GP 记录数组 → 过筛后的数组：只按星座筛（GP 里没有所有者 / 类型，区制另算）。
 *  星座归属走 constKeyOfGp（编目名优先），index 不给就只能按星历名。 */
export function filterGp (gp, f, index) {
  const list = Array.isArray(gp) ? gp : []
  const keys = (f && f.constellations) || []
  if (!keys.length) return list
  return list.filter((g) => keys.indexOf(constKeyOfGp(g, index)) >= 0)
}

/** GP 记录 → 半长轴 km（由平均运动反推），不合法返回 NaN。 */
export function gpSemiMajorKm(rec) {
  const mm = Number(rec && rec.meanMotion)
  if (!(mm > 0)) return NaN
  const nRad = mm * TWO_PI / 86400            // rev/day → rad/s
  return Math.cbrt(MU / (nRad * nRad))
}

/**
 * 星座部署：SATCAT 里数 {累计发射, 在轨, 活跃, 近 N 天新增, 近 365 天新增, 累计陨落}（只数载荷，
 * 见 constKeyOfRow），GP 里数 {星历颗数} 并做壳层聚类（高度 25 km × 倾角 1° 的桶，取前 3）。
 * 壳层的 altKm / incDeg 是【桶的下边界】，不是均值 —— 报告里当分档读数用。
 * opts.days = 近期窗口天数（与第 5 章「近期明细」同一个参数，缺省 30；字段名 recent30 是历史名）；
 * 两个窗口都按 UTC 日历日（windowStartMs）。opts.index = 全量编目索引，星历按编目名归类用。
 */
export function constellationDeploy(rows, gpUnion, opts) {
  rows = rows || []
  gpUnion = gpUnion || []
  const t = asOfMs(opts && opts.asOf)
  const days = (opts && fin(opts.days) && opts.days > 0) ? Math.floor(opts.days) : 30
  const index = (opts && opts.index instanceof Map) ? opts.index : buildIndex(rows)
  const d30 = windowStartMs(t, days)
  const d365 = windowStartMs(t, 365)
  const acc = new Map()
  for (const p of CONST_PATTERNS) acc.set(p.key, { key: p.key, launched: 0, inOrbit: 0, active: 0, recent30: 0, recent365: 0, decayed: 0, gpCount: 0, shells: [] })
  for (const r of rows) {
    const k = constKeyOfRow(r)
    if (!k) continue
    const o = acc.get(k)
    o.launched++
    if (isInOrbit(r)) o.inOrbit++
    if (isActiveInOrbit(r)) o.active++
    if (isDecayed(r)) o.decayed++
    const ms = dayMs(r.launchDate)
    if (fin(ms) && fin(t) && ms <= t) { if (ms >= d30) o.recent30++; if (ms >= d365) o.recent365++ }
  }
  const shellAcc = new Map()   // key → Map<'alt|inc', n>
  for (const g of gpUnion) {
    const k = constKeyOfGp(g, index)
    if (!k) continue
    const o = acc.get(k)
    o.gpCount++
    const a = gpSemiMajorKm(g)
    const inc = Number(g.incl)
    if (!fin(a) || !Number.isFinite(inc)) continue
    const altBin = Math.floor((a - RE_KM) / 25) * 25
    const incBin = Math.floor(inc)
    let m = shellAcc.get(k)
    if (!m) shellAcc.set(k, (m = new Map()))
    const bk = altBin + '|' + incBin
    m.set(bk, (m.get(bk) || 0) + 1)
  }
  for (const [k, m] of shellAcc) {
    const list = [...m.entries()].map(([bk, n]) => { const p = bk.split('|'); return { altKm: +p[0], incDeg: +p[1], n } })
    list.sort((a, b) => (b.n - a.n) || (a.altKm - b.altKm) || (a.incDeg - b.incDeg))
    acc.get(k).shells = list.slice(0, 3)
  }
  const out = [...acc.values()].filter((o) => o.launched > 0 || o.gpCount > 0)
  out.sort((a, b) => (b.inOrbit - a.inOrbit) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { rows: out }
}

// ===================================================================================
// 6. 星历时效
// ===================================================================================

// 分位数：最近秩法（sorted 升序，p ∈ [0,1]）。n=0 → null。
function pct(sorted, p) {
  const n = sorted.length
  if (!n) return null
  const i = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))
  return sorted[i]
}

function ageSummary(ages) {
  const s = ages.slice().sort((a, b) => a - b)
  let stale = 0
  for (const a of s) if (a > 7) stale++
  return { n: s.length, median: r1(pct(s, 0.5)), p90: r1(pct(s, 0.9)), max: r1(s.length ? s[s.length - 1] : null), stale }
}

/**
 * 历元龄（天）= asOf − GP EPOCH。整体一行 + 每个大型星座一行（按 CONST_PATTERNS 名称前缀归组）。
 * 中位数 / P90 都用最近秩法（sorted[ceil(p·n)−1]），不做插值 —— 报告里给的是「第 90 个百分位那一颗
 * 的历元龄」，插值出来的数在目录里找不到对应的星。
 */
export function epochAgeStats(gpRecs, asOf, index) {
  gpRecs = gpRecs || []
  const t = asOfMs(asOf)
  const all = []
  const byKey = new Map()
  for (const g of gpRecs) {
    const e = epochMs(g && g.epoch)
    if (!Number.isFinite(e) || !fin(t)) continue
    const age = (t - e) / DAY_MS
    all.push(age)
    const k = constKeyOfGp(g, index)
    if (!k) continue
    let arr = byKey.get(k)
    if (!arr) byKey.set(k, (arr = []))
    arr.push(age)
  }
  const byConst = []
  for (const p of CONST_PATTERNS) { const arr = byKey.get(p.key); if (arr && arr.length) byConst.push({ key: p.key, ...ageSummary(arr) }) }
  byConst.sort((a, b) => (b.n - a.n) || (a.key < b.key ? -1 : 1))
  return { overall: ageSummary(all), byConst, ages: all }
}

/**
 * 星历的在轨覆盖率：分子 = 星历里、编目判为在轨的条目数；分母 = 编目在轨对象数（rows 即本报告范围）。
 * 星座行分子分母都只计该星座的载荷。GP 并集几乎只有活跃载荷（碎片覆盖率接近 0），不给这个比值的话
 * 第 8 章的颗数（真编目 16717）会被读成「全部在轨对象」（35026）。
 * index = 全量编目索引（星座归类按编目名）；在轨判定只认 rows 里的行（范围外的不算分子）。
 */
export function ephemerisCoverage(rows, gpRecs, index) {
  const inScope = new Map()
  const den = new Map()
  let denAll = 0
  for (const r of (rows || [])) {
    if (!isInOrbit(r)) continue
    inScope.set(r.norad, r)
    denAll++
    const k = constKeyOfRow(r)
    if (k) den.set(k, (den.get(k) || 0) + 1)
  }
  const num = new Map()
  let numAll = 0
  const seen = new Set()
  for (const g of (gpRecs || [])) {
    const id = String(g && g.noradId)
    if (seen.has(id) || !inScope.has(id)) continue
    seen.add(id)
    numAll++
    const k = constKeyOfGp(g, index)
    if (k) num.set(k, (num.get(k) || 0) + 1)
  }
  const ratio = (n, d) => (d > 0 ? n / d : null)
  const byConst = {}
  for (const p of CONST_PATTERNS) byConst[p.key] = { num: num.get(p.key) || 0, den: den.get(p.key) || 0, ratio: ratio(num.get(p.key) || 0, den.get(p.key) || 0) }
  return { overall: { num: numAll, den: denAll, ratio: ratio(numAll, denAll) }, byConst }
}

/** 编目侧的 GEO 对账：在轨且编目根数判为 GEO 的对象数，以及其中有星历的条数（gpRecs = 本报告范围的星历）。 */
export function geoCatalogTally(rows, gpRecs) {
  const ids = new Set()
  for (const g of (gpRecs || [])) ids.add(String(g && g.noradId))
  let catalog = 0, withEphem = 0
  for (const r of (rows || [])) {
    if (!isInOrbit(r) || regimeOf(r) !== 'GEO') continue
    catalog++
    if (ids.has(r.norad)) withEphem++
  }
  return { catalog, withEphem }
}

// ===================================================================================
// 7. GEO 轨道弧
// ===================================================================================

/**
 * OMM 记录 → 历元处定点经度（°，东正西负）；非 GEO / 解算失败返回 NaN。
 * 是 geoSlot.geoSlotOfOmm 的【数值孪生】：同一套粗判（根数换算判 classifyOrbit === 'GEO'，
 * 不逐条建 satrec）、同一个 geoLonAtEpoch，只是不格式化成 '110.5°E'。
 * 结果缓存在记录上的 _geoLon（与 geoSlot.js 的 _geoSlot 同约定）：全量 active 上万条，
 * geoOccupancy 与 geoNeighbors 会重复问同一批记录。
 */
export function geoLonOfOmm(s) {
  if (!s) return NaN
  if (s._geoLon !== undefined) return s._geoLon
  const mm = Number(s.meanMotion)
  if (!(mm > 0)) return (s._geoLon = NaN)
  const geo = classifyOrbit({ e: Number(s.ecc) || 0, inclDeg: Number(s.incl) || 0, periodMin: 1440 / mm }) === 'GEO'
  if (!geo) return (s._geoLon = NaN)
  try {
    const rec = sat.omm2satrec(s)
    const lon = rec && !rec.error ? geoLonAtEpoch(rec) : NaN
    return (s._geoLon = Number.isFinite(lon) ? normLon(lon) : NaN)
  } catch { return (s._geoLon = NaN) }
}

// 经度归一到 (−180, 180]
const normLon = (v) => ((v % 360) + 540) % 360 - 180

// 弧段包含判定（支持跨 ±180 接缝：from > to 时表示绕过接缝的那一段）
const inArc = (lon, from, to) => (from <= to ? (lon >= from && lon <= to) : (lon >= from || lon <= to))

/**
 * GEO 轨道弧占用。
 * · 逐星定点经度：只算 classifyOrbit === 'GEO' 的（geoLonOfOmm 的粗判即此）；
 * · 1° 桶：桶号 = floor(经度)，覆盖 −180…179 全程（图要画完整条带，空桶也要有）；
 * · 共位簇：定点经度升序相邻差 ≤ coloTol 的连通分量、≥ 2 颗。★ 环向闭合：首尾两簇跨 ±180 接缝
 *   相邻时合并（180°E 附近真有共位星，按线性切会把一个簇劈成两半）；
 * · 重点弧段：缺省 60°E–150°E，from > to 时按跨接缝解释。
 */
export function geoOccupancy(geoGpRecs, satcatIndex, opts) {
  geoGpRecs = geoGpRecs || []
  const binDeg = (opts && fin(opts.binDeg) && opts.binDeg > 0) ? opts.binDeg : 1
  const coloTol = (opts && fin(opts.coloTol) && opts.coloTol >= 0) ? opts.coloTol : 0.2
  const arcIn = (opts && Array.isArray(opts.arc) && opts.arc.length === 2) ? opts.arc : [60, 150]
  const topN = (opts && fin(opts.topN) && opts.topN > 0) ? Math.floor(opts.topN) : 15
  const idx = satcatIndex instanceof Map ? satcatIndex : new Map()

  const sats = []
  for (const g of geoGpRecs) {
    const lon = geoLonOfOmm(g)
    if (!Number.isFinite(lon)) continue
    const row = idx.get(String(g.noradId))
    sats.push({
      norad: String(g.noradId), name: g.name || '', lon: r3(lon), slot: fmtGeoSlot(lon),
      owner: row ? row.owner : '', status: row ? row.status : '', objectId: row ? row.objectId : ''
    })
  }
  sats.sort((a, b) => (a.lon - b.lon) || byNorad(a.norad, b.norad))

  // 1° 桶：全程 −180…179
  const nBins = Math.round(360 / binDeg)
  const bins = []
  for (let i = 0; i < nBins; i++) bins.push({ lon: r3(-180 + i * binDeg), n: 0 })
  for (const s of sats) {
    let i = Math.floor((s.lon + 180) / binDeg)
    if (i < 0) i = 0
    if (i >= nBins) i = nBins - 1
    bins[i].n++
  }
  // 前 N 位并列的同进同出（真编目：17 个桶并列 4 颗，按 slice 截只出其中 8 个，哪 8 个全凭经度序）
  const top = topWithTies(bins.filter((b) => b.n > 0).sort((a, b) => (b.n - a.n) || (a.lon - b.lon)), topN, (b) => b.n)

  // 共位簇（线性切分 → 环向闭合）
  const comps = []
  for (const s of sats) {
    const last = comps[comps.length - 1]
    if (last && s.lon - last[last.length - 1].lon <= coloTol) last.push(s)
    else comps.push([s])
  }
  if (comps.length > 1) {
    const first = comps[0], last = comps[comps.length - 1]
    if ((first[0].lon + 360) - last[last.length - 1].lon <= coloTol) { comps.pop(); comps[0] = last.concat(first) }
  }
  const clusters = comps.filter((c) => c.length >= 2).map((c) => ({
    lonFrom: c[0].lon, lonTo: c[c.length - 1].lon, n: c.length,
    spanDeg: r3(normLon(c[c.length - 1].lon - c[0].lon)), sats: c
  }))
  clusters.sort((a, b) => (b.n - a.n) || (a.lonFrom - b.lonFrom))

  const arcSats = sats.filter((s) => inArc(s.lon, arcIn[0], arcIn[1]))
  return { sats, bins, top, topN, clusters, arc: { from: arcIn[0], to: arcIn[1], sats: arcSats, n: arcSats.length }, total: sats.length, binDeg, coloTol }
}

/**
 * 某颗 GEO 成员 ±tol 内的邻星（不含自己）。satcatIndex 给了就顺带回填所有者 / 状态。
 * 按 |Δlon| 升序、并列按 NORAD 升序。Δlon 走环向差（±180 接缝两侧互为邻居）。
 */
export function geoNeighbors(member, geoGpRecs, opts) {
  const tol = (opts && fin(opts.tol) && opts.tol > 0) ? opts.tol : 1.0
  const idx = (opts && opts.index instanceof Map) ? opts.index : new Map()
  const lon0 = member && fin(member.lon) ? member.lon : NaN
  if (!Number.isFinite(lon0)) return []
  const id0 = String(member.norad == null ? (member.id == null ? '' : member.id) : member.norad)
  const out = []
  for (const g of (geoGpRecs || [])) {
    const id = String(g.noradId)
    if (id === id0) continue
    const lon = geoLonOfOmm(g)
    if (!Number.isFinite(lon)) continue
    const d = normLon(lon - lon0)
    if (Math.abs(d) > tol) continue
    const row = idx.get(id)
    out.push({ norad: id, name: g.name || '', owner: row ? row.owner : '', status: row ? row.status : '', lon: r3(lon), slot: fmtGeoSlot(lon), dLon: r3(d) })
  }
  out.sort((a, b) => (Math.abs(a.dLon) - Math.abs(b.dLon)) || byNorad(a.norad, b.norad))
  return out
}

// ===================================================================================
// 8. 卫星组
// ===================================================================================

const CUSTOM_NORAD_BASE = 900000   // 与 useCustomConstellations.NORAD_BASE 同值：≥ 此号段是自建星座的合成星，
                                   // 真实编目里必然查无此号，单独计一笔，不当成「目录漏了」。

/**
 * 组成员分四类（附录 C）：在最新星历中 / 不在星历但 SATCAT 未陨落（附 missAt）/ SATCAT 已陨落 /
 * 编目里查无此号（含自定义号段）。判定序即上面的书写序：星历里有＝它此刻确在轨，证据最硬，优先。
 */
export function groupResolve(group, gpIndex, satcatIndex) {
  const gp = gpIndex instanceof Map ? gpIndex : new Map()
  const cat = satcatIndex instanceof Map ? satcatIndex : new Map()
  const out = { inGp: [], absent: [], decayed: [], unknown: [], customCount: 0, total: 0 }
  for (const s of ((group && group.sats) || [])) {
    const id = String((s && s.id) != null ? s.id : '').trim()
    if (!id) continue
    out.total++
    const e = { id, name: String((s && s.name) || ''), missAt: String((s && s.missAt) || '') }
    if ((Number(id) || 0) >= CUSTOM_NORAD_BASE) { out.customCount++; out.unknown.push(e); continue }
    if (gp.has(id)) { out.inGp.push(e); continue }
    const row = cat.get(id)
    if (!row) { out.unknown.push(e); continue }
    if (isDecayed(row)) { out.decayed.push(e); continue }
    out.absent.push(e)
  }
  for (const k of ['inGp', 'absent', 'decayed', 'unknown']) out[k].sort((a, b) => byNorad(a.id, b.id))
  return out
}

/**
 * 组成员表（语言无关，字段名即列名的 key）。
 * ★ 轨道量优先取 GP（历元处根数换算：a 由平均运动、近 / 远地点 = a(1∓e) − Re），无 GP 才退 SATCAT；
 *   source 列如实注明 GP / SATCAT / '—'（两边都没有）。两套数不可混排 —— SATCAT 的近 / 远地点是
 *   上一次编目更新时的值，与 GP 历元差几天到几个月，混在一行里读者无从判断哪个数是什么时候的。
 * 行序按 NORAD 升序（确定性）。
 */
export function groupMembers(group, gpIndex, satcatIndex, opts) {
  const gp = gpIndex instanceof Map ? gpIndex : new Map()
  const cat = satcatIndex instanceof Map ? satcatIndex : new Map()
  const t = asOfMs(opts && opts.asOf)
  // 历元龄基准：缺省 = asOf；回溯时调用方传星历数据时间（星历是最新的那份，拿过去的基准去减得负龄）
  const tEp = (opts && opts.epochAt != null) ? asOfMs(opts.epochAt) : t
  const res = groupResolve(group, gp, cat)
  const cls = new Map()
  for (const k of ['inGp', 'absent', 'decayed', 'unknown']) for (const e of res[k]) cls.set(e.id, { cls: k, missAt: e.missAt, name: e.name })
  const out = []
  for (const [id, meta] of cls) {
    const row = cat.get(id) || null
    const g = gp.get(id) || null
    const m = {
      id, name: (g && g.name) || (row && row.name) || meta.name || '', objectId: (row && row.objectId) || (g && g.objectId) || '',
      owner: row ? row.owner : '', launchDate: row ? row.launchDate : '', ageDays: null,
      status: row ? row.status : '', type: row ? row.type : '', regime: '—',
      perigeeKm: null, apogeeKm: null, inclDeg: null, periodMin: null, raanDeg: null,
      epoch: g ? g.epoch : '', epochAgeDays: null, rcsM2: row ? row.rcsM2 : null,
      geoSlot: '', source: '—', cls: meta.cls, missAt: meta.missAt
    }
    // 在轨天数止于陨落日：已陨落成员按基准时刻算，2020 年再入的星会印成在轨 2701 天；
    // 判为已陨落却没有 DECAY_DATE（IMP 缺日期）的记空
    if (fin(t) && row && row.launchDate) {
      const ms = dayMs(row.launchDate)
      const end = isDecayed(row) ? dayMs(row.decayDate) : t
      if (fin(ms) && fin(end)) m.ageDays = Math.floor((Math.min(end, t) - ms) / DAY_MS)
    }
    if (g) {
      const a = gpSemiMajorKm(g)
      const e = Number(g.ecc)
      const inc = Number(g.incl), raan = Number(g.raan), mm = Number(g.meanMotion)
      if (fin(a) && Number.isFinite(e)) { m.perigeeKm = r1(a * (1 - e) - RE_KM); m.apogeeKm = r1(a * (1 + e) - RE_KM) }
      if (Number.isFinite(inc)) m.inclDeg = r2(inc)
      if (Number.isFinite(raan)) m.raanDeg = r2(raan)
      if (mm > 0) m.periodMin = r2(1440 / mm)
      m.regime = classifyOrbit({ e: Number.isFinite(e) ? e : 0, inclDeg: Number.isFinite(inc) ? inc : 0, periodMin: mm > 0 ? 1440 / mm : undefined })
      const ep = epochMs(g.epoch)
      if (Number.isFinite(ep) && fin(tEp)) m.epochAgeDays = r1((tEp - ep) / DAY_MS)
      const lon = geoLonOfOmm(g)
      if (Number.isFinite(lon)) { m.geoSlot = fmtGeoSlot(lon); m.lon = r3(lon) }
      m.source = 'GP'
    } else if (row) {
      m.perigeeKm = row.perigeeKm; m.apogeeKm = row.apogeeKm
      m.inclDeg = row.inclDeg; m.periodMin = row.periodMin
      m.regime = regimeOf(row)
      m.source = 'SATCAT'
    }
    out.push(m)
  }
  out.sort((a, b) => byNorad(a.id, b.id))
  return out
}

/**
 * 轨道面估计（升交点赤经聚类）：折叠倾角按 incTol 就近分壳（round，不是 floor —— 52.98° 与 53.04°
 * 是同一个壳，按 floor 会被切成两个）；壳内 RAAN 环向排序，相邻差 > raanTol 处切分成面。
 * ★ 面间平均间隔 = 相邻两面锚点（面内最小 RAAN）的环向差的均值，绕一圈必然 = 360/面数 ——
 *   它是给读者的校验值；真正带信息的是同时给出的 min / max。
 * 壳的 altKm 是壳内成员平均高度的【中位数】，只是读数，不参与分壳判据（附录 C 只按倾角分壳）。
 * ★ 两道门（2026-10-15 真编目审查）：GEO 成员不参与（RAAN 在近零倾角下没有物理意义，
 *   几颗北斗 GEO 会各自成一个「面」）；成员不足 minShell（缺省 3）颗的壳不列 —— 原先 8 行里
 *   5 行只有 1 颗，面间间隔恒印 360。只有一个面的壳，面间间隔三列记空。
 */
export function planeClusters(members, opts) {
  const incTol = (opts && fin(opts.incTol) && opts.incTol > 0) ? opts.incTol : 1
  const raanTol = (opts && fin(opts.raanTol) && opts.raanTol > 0) ? opts.raanTol : 4
  const minShell = (opts && fin(opts.minShell) && opts.minShell > 0) ? Math.floor(opts.minShell) : 3
  const shells = new Map()
  for (const m of (members || [])) {
    if (!fin(m.inclDeg) || !fin(m.raanDeg) || m.regime === 'GEO') continue
    const key = Math.round(foldInclination(m.inclDeg) / incTol) * incTol
    let arr = shells.get(key)
    if (!arr) shells.set(key, (arr = []))
    arr.push(m)
  }
  const out = []
  for (const [inc, arr] of shells) {
    if (arr.length < minShell) continue
    const list = arr.slice().sort((a, b) => (a.raanDeg - b.raanDeg) || byNorad(a.id, b.id))
    // 环向切分：先算相邻（含绕回首个）的间隔，间隔 > tol 即为面的分界
    const n = list.length
    const gaps = []
    for (let i = 0; i < n; i++) {
      const cur = list[i].raanDeg
      const nxt = i === n - 1 ? list[0].raanDeg + 360 : list[i + 1].raanDeg
      gaps.push(nxt - cur)
    }
    const cuts = []
    for (let i = 0; i < n; i++) if (gaps[i] > raanTol) cuts.push(i)
    let planes
    if (!cuts.length) planes = [list]                       // 整壳环向连成一片：算一个面
    else {
      planes = []
      const start = (cuts[cuts.length - 1] + 1) % n
      let cur = []
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n
        cur.push(list[i])
        if (cuts.indexOf(i) >= 0) { planes.push(cur); cur = [] }
      }
      if (cur.length) planes.push(cur)
    }
    const pInfo = planes.map((p) => ({ raanDeg: r2(p[0].raanDeg), n: p.length, ids: p.map((x) => x.id) }))
    pInfo.sort((a, b) => a.raanDeg - b.raanDeg)
    const sizes = pInfo.map((p) => p.n)
    const spac = []
    for (let i = 0; i < pInfo.length; i++) {
      const nx = i === pInfo.length - 1 ? pInfo[0].raanDeg + 360 : pInfo[i + 1].raanDeg
      spac.push(nx - pInfo[i].raanDeg)
    }
    const alts = arr.map((m) => (fin(m.perigeeKm) && fin(m.apogeeKm) ? (m.perigeeKm + m.apogeeKm) / 2 : NaN)).filter(fin).sort((a, b) => a - b)
    const multi = pInfo.length > 1      // 单面壳没有「面间」可言
    out.push({
      inclDeg: r2(inc), n: arr.length, altKm: alts.length ? r1(alts[Math.floor((alts.length - 1) / 2)]) : null,
      planeCount: pInfo.length, planes: pInfo,
      perPlaneMin: sizes.length ? Math.min(...sizes) : 0, perPlaneMax: sizes.length ? Math.max(...sizes) : 0,
      spacingDeg: multi ? r2(spac.reduce((s, x) => s + x, 0) / spac.length) : null,
      spacingMinDeg: multi ? r2(Math.min(...spac)) : null,
      spacingMaxDeg: multi ? r2(Math.max(...spac)) : null
    })
  }
  out.sort((a, b) => (b.n - a.n) || (a.inclDeg - b.inclDeg))
  return { shells: out, incTol, raanTol, minShell }
}

/**
 * 本组相对全目录：逐区制「本组在轨载荷 / 同区制在轨载荷」的比例（比例是数，不是判定），
 * 以及本组的所有者构成。
 */
export function groupVsCatalog(members, rows) {
  const cat = new Map()
  for (const r of (rows || [])) {
    if (!isInOrbit(r) || r.type !== 'PAY') continue
    const rg = regimeOf(r)
    cat.set(rg, (cat.get(rg) || 0) + 1)
  }
  const mine = new Map()
  const owners = new Map()
  let minePay = 0
  for (const m of (members || [])) {
    if (m.cls === 'decayed' || m.cls === 'unknown') continue
    if (m.type !== 'PAY') continue
    minePay++
    mine.set(m.regime, (mine.get(m.regime) || 0) + 1)
    const ow = m.owner || 'UNK'
    owners.set(ow, (owners.get(ow) || 0) + 1)
  }
  const byRegime = [...mine.entries()].map(([regime, n]) => {
    // ★ ratio 是【原始比值】，这一层不做四舍五入：报告按两位小数的百分数印（pctStr(x, 2)），
    //   先量化到 0.001 再乘 100 的话，后两位全是量化噪声 —— 1/6000 会印成 0.00%。
    //   分子分母同时给出来，读者要更高精度自己能算。
    const tot = cat.get(regime) || 0
    return { regime, groupPayloads: n, catalogPayloads: tot, ratio: tot > 0 ? n / tot : null }
  })
  byRegime.sort((a, b) => (b.groupPayloads - a.groupPayloads) || (REGIME_ORDER.indexOf(a.regime) - REGIME_ORDER.indexOf(b.regime)))
  const ownerRows = [...owners.entries()].map(([owner, n]) => ({ owner, n }))
  ownerRows.sort((a, b) => (b.n - a.n) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  return { byRegime, owners: ownerRows, payloads: minePay }
}

// ===================================================================================
// 9. 分箱（图用；放这里是因为分箱边界也是口径，不该散在渲染端）
// ===================================================================================

/** 等宽分箱：[lo, hi) 按 step 切，超出上界的并入末桶（overflow 计数单独给）。
 *  step ≤ 0 会让桶数算成 Infinity 进而把循环卡死，故在入口钳成 1（调用方传错只会得到一张粗图，不会挂）。
 *
 *  ★ opts.dropOver：越界值【不入桶】（仍计进 over）。图题写明了量程（「0–2000 km」）时必须开 ——
 *    否则末桶画的是「≥ 末桶下界的全部对象」，柱子高度不是那一档的真值，读者照图读出来的数是错的。
 *    缺省仍是并入末桶：倾角这类量程本就覆盖全域（0–180°），恰好等于上界的那颗理应落在末桶里，
 *    一律丢掉反而会漏点。判据也按这条写：只丢 v > hi，v === hi 仍进末桶。 */
export function histBins(values, lo, hi, step, opts) {
  if (!(step > 0)) step = 1
  const dropOver = !!(opts && opts.dropOver)
  const n = Math.max(1, Math.min(4000, Math.round((hi - lo) / step)))
  const bins = []
  for (let i = 0; i < n; i++) bins.push({ x0: r3(lo + i * step), x1: r3(lo + (i + 1) * step), n: 0 })
  let under = 0, over = 0
  for (const v of (values || [])) {
    if (!fin(v)) continue
    if (v < lo) { under++; continue }
    let i = Math.floor((v - lo) / step)
    if (i >= n) { over++; if (dropOver && v > hi) continue; i = n - 1 }
    bins[i].n++
  }
  return { bins, under, over }
}

/** 倾角 × 高度密度格。cells[yi][xi] = 计数（契约 §2 的 heat）。
 *  ★ 高度越界（> altMax）的【不入格】，另计 over —— 与 histBins 的 dropOver 同一条理由：
 *    图题写着量程，把几十颗深空椭圆轨道的载荷压进顶行，顶行那格就不是它标注的那一档的数。
 *    倾角一侧不丢：0–180° 已覆盖全域，恰好 180° 的那颗该落在末列。 */
export function heatGrid(rows, opts) {
  const xLo = 0, xHi = 180, xStep = (opts && opts.incStep > 0) ? opts.incStep : 5
  // logAlt：高度轴按对数等分（altMin…altMax 切 altBins 层）。LEO 的密集带（300–1500 km）在线性
  // 0–40000 km 轴上只占底下三行，而 MEO / GEO 各只有一两行有数 —— 对数轴让三个区制同时读得出层次。
  const logAlt = !!(opts && opts.logAlt)
  const yLo = logAlt ? ((opts && opts.altMin > 0) ? opts.altMin : 150) : 0
  const yHi = (opts && opts.altMax > 0) ? opts.altMax : 40000, yStep = (opts && opts.altStep > 0) ? opts.altStep : 500
  const nx = Math.max(1, Math.min(360, Math.round((xHi - xLo) / xStep)))
  const ny = logAlt ? Math.max(1, Math.min(400, Math.round((opts && opts.altBins) || 36))) : Math.max(1, Math.min(400, Math.round((yHi - yLo) / yStep)))
  const xBins = [], yBins = []
  for (let i = 0; i < nx; i++) xBins.push({ x0: xLo + i * xStep, x1: xLo + (i + 1) * xStep })
  const lq = Math.log(yHi / yLo) / ny
  for (let j = 0; j < ny; j++) {
    yBins.push(logAlt
      ? { y0: r1(yLo * Math.exp(j * lq)), y1: r1(yLo * Math.exp((j + 1) * lq)) }
      : { y0: yLo + j * yStep, y1: yLo + (j + 1) * yStep })
  }
  const cells = []
  for (let j = 0; j < ny; j++) cells.push(new Array(nx).fill(0))
  let over = 0, under = 0
  for (const r of (rows || [])) {
    const alt = meanAltKm(r)
    if (!fin(alt) || !fin(r.inclDeg)) continue
    let xi = Math.floor((r.inclDeg - xLo) / xStep)
    let yj = logAlt ? (alt > 0 ? Math.floor(Math.log(alt / yLo) / lq) : -1) : Math.floor((alt - yLo) / yStep)
    if (xi < 0) xi = 0
    if (xi >= nx) xi = nx - 1
    if (yj < 0) { if (logAlt) { under++; continue } yj = 0 }
    if (yj >= ny) { over++; if (alt > yHi) continue; yj = ny - 1 }
    cells[yj][xi]++
  }
  return { xBins, yBins, cells, over, under, logAlt }
}
