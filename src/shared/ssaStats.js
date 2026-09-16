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
export const CONST_PATTERNS = [
  { key: 'starlink', re: /^STARLINK/ },
  { key: 'oneweb', re: /^ONEWEB/ },
  { key: 'kuiper', re: /^KUIPER/ },
  { key: 'qianfan', re: /^QIANFAN/ },
  { key: 'guowang', re: /^HULIANWANG/ },
  { key: 'iridium', re: /^IRIDIUM/ },
  { key: 'globalstar', re: /^GLOBALSTAR/ },
  { key: 'planet', re: /^(FLOCK|SKYSAT|PELICAN)/ },
  { key: 'spire', re: /^LEMUR/ },
  { key: 'o3b', re: /^O3B/ },
  { key: 'gps', re: /^(NAVSTAR|GPS)/ },
  { key: 'beidou', re: /^BEIDOU/ },
  { key: 'galileo', re: /^GSAT/ },
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
    else if (r.orbitType === 'IMP') impacted++
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
    o.launched++
    if (isDecayed(r)) o.decayed++
    if (isInOrbit(r)) {
      o.inOrbit++
      if (r.type === 'PAY') { o.payloads++; if (isActive(r)) o.active++ } else if (r.type === 'R/B') o.rockets++
      else if (r.type === 'DEB') o.debris++
    }
  }
  const all = [...acc.values()].sort((a, b) => (b.payloads - a.payloads) || (b.inOrbit - a.inOrbit) || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
  const top = all.slice(0, topN)
  const total ={ owner: '', active: 0, payloads: 0, rockets: 0, debris: 0, inOrbit: 0, launched: 0, decayed: 0 }
  for (const o of all) for (const k of ['active', 'payloads', 'rockets', 'debris', 'inOrbit', 'launched', 'decayed']) total[k] += o[k]
  return { rows: top, total, ownerCount: all.length, topN }
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

function yearSeries(rows, asOf, field, keep) {
  rows = rows || []
  const years = yearRange(rows, asOf, field)
  const base = years[0]
  const all = new Array(years.length).fill(0)
  const payload = new Array(years.length).fill(0)
  for (const r of rows) {
    if (keep && !keep(r)) continue
    const ms = dayMs(r[field])
    if (!fin(ms)) continue
    const i = new Date(ms).getUTCFullYear() - base
    if (i < 0 || i >= years.length) continue
    all[i]++
    if (r.type === 'PAY') payload[i]++
  }
  return { years, payload, all }
}

/** 逐年发射：{ years, payload, all }。发射就是发射，深空探测器也算一次，故不过滤。 */
export function launchSeries(rows, opts) { return yearSeries(rows, opts && opts.asOf, 'launchDate') }

/** 逐年陨落：{ years, payload, all }。
 *  ★ 只数 isDecayed 的行，不是「凡有 DECAY_DATE 就算」：航天飞机一类 ORBIT_TYPE = R/T 的行也带
 *  返回日期，但它归深空 / 着陆一类，总览里不计入已陨落 —— 两处口径必须一致，否则报告里
 *  「逐年陨落」的总和会比「已陨落」多出几条，读者对不上账。 */
export function decaySeries(rows, opts) { return yearSeries(rows, opts && opts.asOf, 'decayDate', isDecayed) }

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
  const labels = [], launchAll = [], launchPay = [], decayAll = [], decayPay = []
  for (let i = 0; i < months; i++) { labels.push(monthLabel(startIdx + i)); launchAll.push(0); launchPay.push(0); decayAll.push(0); decayPay.push(0) }
  for (const r of rows) {
    const lm = dayMs(r.launchDate)
    if (fin(lm)) { const i = monthIdxOfMs(lm) - startIdx; if (i >= 0 && i < months) { launchAll[i]++; if (r.type === 'PAY') launchPay[i]++ } }
    const dm = isDecayed(r) ? dayMs(r.decayDate) : NaN   // 与 decaySeries 同口径，见那里的注释
    if (fin(dm)) { const i = monthIdxOfMs(dm) - startIdx; if (i >= 0 && i < months) { decayAll[i]++; if (r.type === 'PAY') decayPay[i]++ } }
  }
  return { months: labels, launchAll, launchPay, decayAll, decayPay }
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
  // ★ 先把基准时刻归到它所在的 UTC 零点再往前数：判据（报告附录原文）写的是「按 UTC 日历日比较，
  //   不是 24 小时的整数倍」。直接 t − days×DAY_MS 会落在当天某个钟点上，于是同一天上午生成与
  //   下午生成的两份报告「近 30 天」差出好几条，而两份都印着同一个窗口起点。
  const dt = new Date(t)
  const t0 = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
  const fromMs = t0 - days * DAY_MS
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
// 5. 大型星座部署
// ===================================================================================

/** 名称 → 星座 key（第一个命中的模式即归属，未命中返回 ''）。 */
export const constKeyOf = (name) => {
  const s = String(name || '')
  for (let i = 0; i < CONST_PATTERNS.length; i++) if (CONST_PATTERNS[i].re.test(s)) return CONST_PATTERNS[i].key
  return ''
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
  if (f.constellations && f.constellations.length && f.constellations.indexOf(constKeyOf(row.name)) < 0) return false
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

/** GP 记录数组 → 过筛后的数组：只按星座名称前缀筛（GP 里没有所有者 / 类型，区制另算）。 */
export function filterGp (gp, f) {
  const list = Array.isArray(gp) ? gp : []
  const keys = (f && f.constellations) || []
  if (!keys.length) return list
  return list.filter((g) => keys.indexOf(constKeyOf(g.name)) >= 0)
}

/** GP 记录 → 半长轴 km（由平均运动反推），不合法返回 NaN。 */
export function gpSemiMajorKm(rec) {
  const mm = Number(rec && rec.meanMotion)
  if (!(mm > 0)) return NaN
  const nRad = mm * TWO_PI / 86400            // rev/day → rad/s
  return Math.cbrt(MU / (nRad * nRad))
}

/**
 * 星座部署：SATCAT 里数 {累计发射, 在轨, 活跃, 近 30 天新增, 近 365 天新增, 累计陨落}，
 * GP 里数 {星历颗数} 并做壳层聚类（高度 25 km × 倾角 1° 的桶，取前 3）。
 * 壳层的 altKm / incDeg 是【桶的下边界】，不是均值 —— 报告里当分档读数用。
 */
export function constellationDeploy(rows, gpUnion, opts) {
  rows = rows || []
  gpUnion = gpUnion || []
  const t = asOfMs(opts && opts.asOf)
  const d30 = fin(t) ? t - 30 * DAY_MS : NaN
  const d365 = fin(t) ? t - 365 * DAY_MS : NaN
  const acc = new Map()
  for (const p of CONST_PATTERNS) acc.set(p.key, { key: p.key, launched: 0, inOrbit: 0, active: 0, recent30: 0, recent365: 0, decayed: 0, gpCount: 0, shells: [] })
  for (const r of rows) {
    const k = constKeyOf(r.name)
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
    const k = constKeyOf(g.name)
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
export function epochAgeStats(gpRecs, asOf) {
  gpRecs = gpRecs || []
  const t = asOfMs(asOf)
  const all = []
  const byKey = new Map()
  for (const g of gpRecs) {
    const e = Date.parse(String(g && g.epoch || '').replace(/Z?$/i, 'Z'))
    if (!Number.isFinite(e) || !fin(t)) continue
    const age = (t - e) / DAY_MS
    all.push(age)
    const k = constKeyOf(g.name)
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
  const top = bins.filter((b) => b.n > 0).slice().sort((a, b) => (b.n - a.n) || (a.lon - b.lon)).slice(0, topN)

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
  return { sats, bins, top, clusters, arc: { from: arcIn[0], to: arcIn[1], sats: arcSats, n: arcSats.length }, total: sats.length, binDeg, coloTol }
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
    if (fin(t) && row && row.launchDate) { const ms = dayMs(row.launchDate); if (fin(ms)) m.ageDays = Math.floor((t - ms) / DAY_MS) }
    if (g) {
      const a = gpSemiMajorKm(g)
      const e = Number(g.ecc)
      const inc = Number(g.incl), raan = Number(g.raan), mm = Number(g.meanMotion)
      if (fin(a) && Number.isFinite(e)) { m.perigeeKm = r1(a * (1 - e) - RE_KM); m.apogeeKm = r1(a * (1 + e) - RE_KM) }
      if (Number.isFinite(inc)) m.inclDeg = r2(inc)
      if (Number.isFinite(raan)) m.raanDeg = r2(raan)
      if (mm > 0) m.periodMin = r2(1440 / mm)
      m.regime = classifyOrbit({ e: Number.isFinite(e) ? e : 0, inclDeg: Number.isFinite(inc) ? inc : 0, periodMin: mm > 0 ? 1440 / mm : undefined })
      const ep = Date.parse(String(g.epoch || '').replace(/Z?$/i, 'Z'))
      if (Number.isFinite(ep) && fin(t)) m.epochAgeDays = r1((t - ep) / DAY_MS)
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
 */
export function planeClusters(members, opts) {
  const incTol = (opts && fin(opts.incTol) && opts.incTol > 0) ? opts.incTol : 1
  const raanTol = (opts && fin(opts.raanTol) && opts.raanTol > 0) ? opts.raanTol : 4
  const shells = new Map()
  for (const m of (members || [])) {
    if (!fin(m.inclDeg) || !fin(m.raanDeg)) continue
    const key = Math.round(foldInclination(m.inclDeg) / incTol) * incTol
    let arr = shells.get(key)
    if (!arr) shells.set(key, (arr = []))
    arr.push(m)
  }
  const out = []
  for (const [inc, arr] of shells) {
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
    out.push({
      inclDeg: r2(inc), n: arr.length, altKm: alts.length ? r1(alts[Math.floor((alts.length - 1) / 2)]) : null,
      planeCount: pInfo.length, planes: pInfo,
      perPlaneMin: sizes.length ? Math.min(...sizes) : 0, perPlaneMax: sizes.length ? Math.max(...sizes) : 0,
      spacingDeg: spac.length ? r2(spac.reduce((s, x) => s + x, 0) / spac.length) : null,
      spacingMinDeg: spac.length ? r2(Math.min(...spac)) : null,
      spacingMaxDeg: spac.length ? r2(Math.max(...spac)) : null
    })
  }
  out.sort((a, b) => (b.n - a.n) || (a.inclDeg - b.inclDeg))
  return { shells: out, incTol, raanTol }
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
  const yLo = 0, yHi = (opts && opts.altMax > 0) ? opts.altMax : 40000, yStep = (opts && opts.altStep > 0) ? opts.altStep : 500
  const nx = Math.max(1, Math.min(360, Math.round((xHi - xLo) / xStep)))
  const ny = Math.max(1, Math.min(400, Math.round((yHi - yLo) / yStep)))
  const xBins = [], yBins = []
  for (let i = 0; i < nx; i++) xBins.push({ x0: xLo + i * xStep, x1: xLo + (i + 1) * xStep })
  for (let j = 0; j < ny; j++) yBins.push({ y0: yLo + j * yStep, y1: yLo + (j + 1) * yStep })
  const cells = []
  for (let j = 0; j < ny; j++) cells.push(new Array(nx).fill(0))
  let over = 0
  for (const r of (rows || [])) {
    const alt = meanAltKm(r)
    if (!fin(alt) || !fin(r.inclDeg)) continue
    let xi = Math.floor((r.inclDeg - xLo) / xStep)
    let yj = Math.floor((alt - yLo) / yStep)
    if (xi < 0) xi = 0
    if (xi >= nx) xi = nx - 1
    if (yj < 0) yj = 0
    if (yj >= ny) { over++; if (alt > yHi) continue; yj = ny - 1 }
    cells[yj][xi]++
  }
  return { xBins, yBins, cells, over }
}
