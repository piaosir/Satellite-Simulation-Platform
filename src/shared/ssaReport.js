// 空间态势（SSA）报告模型 —— 屏上电子报告与 Word 报告共同的、唯一的数据来源。
//
// 分工（与 lbReport / lbSlaReport 同一原则）：
//   · ssaStats.js 只出【数】（代码 + 数字，语言无关）；
//   · 本文件把数摆成章 / 块，并按 lang 把标题、题注、列头全部翻好放进模型；
//   · SsaDoc.vue 与 reportSsaDocx.js 只认模型，不再算任何数、不再各带一份词典。
// 于是「报告里的数与屏上看到的数不一致」这类问题在结构上不可能发生。
//
// 硬口径：
//   ① 出参是【纯数据】：JSON 往返后深相等，无 undefined / NaN / 函数（末尾 pure() 统一收口）；
//   ② 基准时刻只从入参 dataMeta.asOf 来，本文件一次也不调 Date.now() / 无参 new Date()；
//   ③ 纯数字：块里只有数、代码、名称、口径。禁「达标 / 良好 / 拥挤 / 正常 / 健康」一类文字判定 ——
//      报告是交付文档，「口径与判据」一节允许定义性表格，但同样不写评价（仓库根 CLAUDE.md）；
//   ④ 表号 / 图号不进模型：tableId / figId 全篇唯一且稳定，显示用的连续编号由各渲染端自己数。
//
// 块的四种形状与字段名见 SSA 模块内部契约 §1；章节 key 与顺序见契约 §3。

import {
  buildIndex, isInOrbit, isDecayed, isActiveInOrbit,
  catalogOverview, regimeTable, ownerTable, launchSeries, decaySeries, monthlySeries,
  inOrbitCumulative, recentLaunches, recentDecays, constellationDeploy, epochAgeStats,
  geoOccupancy, groupResolve, groupMembers, planeClusters, groupVsCatalog, geoNeighbors,
  histBins, heatGrid, dayMs, asOfMs,
  normFilters, hasFilters, filterRows, filterGp, FILTER_KEYS, REGIME_ORDER, TYPE_ORDER
} from './ssaStats.js'
import { ownerName, launchSiteName, opsStatusName, objectTypeName } from './satcatCodes.js'
import { fmtGeoSlot } from './orbitClass.js'
import { normTzMode, tzParts, tzTag } from './tz.js'

// 时刻一律过 shared/tz.js 的显示时区档（本机 / UTC / UTC±N），并把时区角标一并印出来 ——
// 报告是交付文档，「2026-09-16 09:37」不带时区就是句歧义话；ISO 原串（…T01:37:09Z）更不能上纸。
// 档位由调用方传进来（窗口的 ssa/tz 键），这里不读 localStorage：模型层零 DOM，Node 里也要能建。
// GP 的 EPOCH 没有时区后缀（CCSDS OMM 的约定是 UTC），Date.parse 在不带 Z 时按【本机时区】解，
// 会整体偏一个时差 —— 补个 Z 再交给 fmtTs。
function fmtEpoch(iso, tzMode) {
  if (!iso) return '—'
  const s = String(iso)
  return fmtTs(/[Zz]$|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z', tzMode)
}

function fmtTs(iso, tzMode) {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return String(iso)
  const t = tzParts(ms, tzMode)
  const p = (n) => String(n).padStart(2, '0')
  return `${t.y}-${p(t.mo)}-${p(t.d)} ${p(t.h)}:${p(t.mi)} ${tzTag(tzMode, ms)}`
}

// 中英词表：与 lbSlaReport.js 同一写法，一个词一处定义，不在模板里散着写 if (en)。
const D = (zh, en) => ({ zh, en })

// 大表的行数上限（成员表 / 明细表这类）。出厂 500，由 opts.rowCap 给，屏上与 Word 同一个值 ——
// 两端各一套上限会让「纸上这张是全表的一截」这句读数在两边说的不是同一件事。
// 超出的行不印，题注后补「（共 N 条）」的读数；要看全的走屏上那张表（ExcelGrid 可滚可复制）。
const MEMBER_CAP_DEF = 500

// —— 章节标题（契约 §3，逐字）——
const SEC_TITLE = {
  meta: D('数据来源与口径', 'Data Sources and Definitions'),
  catalog: D('编目总览', 'Catalog Overview'),
  regime: D('轨道区制', 'Orbital Regimes'),
  owner: D('所有者', 'Owners'),
  launch: D('发射与陨落', 'Launches and Decays'),
  constellation: D('大型星座部署', 'Large Constellation Deployment'),
  geo: D('GEO 轨道弧', 'GEO Orbital Arc'),
  epoch: D('星历时效', 'Ephemeris Currency'),
  appendix: D('附录', 'Appendix')
}
export const ALL_SECTIONS = ['meta', 'catalog', 'regime', 'owner', 'launch', 'constellation', 'geo', 'epoch', 'appendix']

// —— 取数来源（omm.fetchCsv 的 source 字段）——
const SOURCE = {
  today: D('当日缓存', 'Cached today'),
  network: D('直连', 'Direct'),
  cloud: D('云镜像', 'Cloud mirror'),
  cache: D('旧缓存', 'Stale cache'),
  bundled: D('内置快照', 'Bundled snapshot')
}

// —— 星座显示名（自命名，不逐词直译；千帆 / 星网按官方英文写法）——
const CONST_NAME = {
  starlink: D('Starlink', 'Starlink'),
  oneweb: D('OneWeb', 'OneWeb'),
  kuiper: D('Kuiper', 'Kuiper'),
  qianfan: D('千帆星座', 'Qianfan'),
  guowang: D('中国星网', 'Guowang'),
  iridium: D('铱星', 'Iridium NEXT'),
  globalstar: D('Globalstar', 'Globalstar'),
  planet: D('Planet', 'Planet'),
  spire: D('Spire', 'Spire'),
  o3b: D('O3b', 'O3b'),
  gps: D('GPS', 'GPS'),
  beidou: D('北斗', 'BeiDou'),
  galileo: D('Galileo', 'Galileo'),
  glonass: D('GLONASS', 'GLONASS')
}

// —— 通用词 ——
const W = {
  total: D('合计', 'Total'),
  type: D('类型', 'Type'),
  inOrbit: D('在轨', 'In orbit'),
  decayed: D('已陨落', 'Decayed'),
  deepSpace: D('深空 / 着陆', 'Deep space / landed'),
  activePay: D('活跃载荷', 'Active payloads'),
  regime: D('区制', 'Regime'),
  owner: D('所有者', 'Owner'),
  code: D('代码', 'Code'),
  name: D('名称', 'Name'),
  norad: D('NORAD', 'NORAD'),
  objectId: D('国际编号', 'Int’l designator'),
  status: D('状态', 'Status'),
  launchDate: D('发射日期', 'Launch date'),
  decayDate: D('陨落日期', 'Decay date'),
  launchSite: D('发射场', 'Launch site'),
  count: D('颗数', 'Objects'),
  months: D('月份', 'Month'),
  category: D('类别', 'Category'),
  slot: D('定点', 'Slot'),
  lonRange: D('经度区间', 'Longitude range'),
  sats: D('卫星', 'Satellites'),
  none: D('无', 'None'),
  objects: D('个', 'objects'),
  source: D('来源', 'Source')
}

// ===================================================================================
// 入口
// ===================================================================================

/**
 * 报告模型。入参见契约 §1；出参严格按契约 §1 的形状。
 * asOf（dataMeta.asOf）必须由调用方给：报告要可复现，模块内不许取系统时钟。
 */
export function buildSsaModel(input) {
  const inp = input || {}
  const lang = inp.lang === 'en' ? 'en' : 'zh'
  const en = lang === 'en'
  const T = (d) => (d == null ? '' : typeof d === 'string' ? d : (en ? d.en : d.zh))

  const allRows = Array.isArray(inp.satcat) ? inp.satcat : []
  const allGp = Array.isArray(inp.gp) ? inp.gp : []
  const groups = Array.isArray(inp.groups) ? inp.groups : []
  const mode = inp.scope === 'groups' ? 'groups' : 'all'
  const o = normOpts(inp.opts)
  const meta = normMeta(inp.dataMeta)
  const asOf = meta.asOf

  // ★ 四道筛选（典型星座 / 所有者 / 轨道区制 / 对象类型）在这里【一次性】切好，往下所有统计
  //   吃的都是切过的那份 —— 别在各章里各筛各的，那样第 2 章与第 4 章的合计就会对不上。
  //
  // ★ 编目与星历【各两份】，用途泾渭分明，逐个调用点必须想清楚自己在干哪件事：
  //   · idxAll / gpIdxAll / gpAll（全量）—— 【查属性】：这颗星是什么（所有者 / 状态 / 类型 /
  //     陨落日期 / 根数），以及「它旁边还停着谁」。组成员表、第 7 章各表的回填、G.5 的 ±1°
  //     邻星都走全量：筛选不该让「查得到」变成「查不到」，更不该把贴着你停的那颗别国星藏掉；
  //   · idx / gp（筛后）—— 【定口径】：哪些星进这一项统计。第 2 至 8 章的统计一律走它。
  //
  // ★ 星历侧怎么筛：GP 里没有所有者与类型两列，自己只筛得动星座名前缀（filterGp），非星座三维
  //   得落到编目侧筛后的 NORAD 集合上再过一道。这一步原先只在第 6 章就地做了一次（局部变量
  //   gpSame），第 7、8 两章直接吃 filterGp 的产物 —— 于是「所有者＝中国」的报告里 GEO 轨道弧
  //   与星历时效印的还是全世界的数（真编目实测：483 颗定点 / 16561 条星历，一个没少），而第 1
  //   章的「筛选条件」明写着中国。现在上提到这里，三章同一口径。
  //   代价（与第 6 章原先那段注释同）：编目里查无此号的星历条目在非星座维筛时一并落选 ——
  //   它们本来也没有所有者 / 类型可筛。
  // ★ 不筛时 gp 与 gpAll 是同一个数组（filterGp 无星座维即原样返回），老报告逐位不变。
  const filtered = hasFilters(o)
  const rows = filterRows(allRows, o)
  const idxAll = buildIndex(allRows)
  const idx = filtered ? buildIndex(rows) : idxAll

  const gpAll = allGp
  const gpIdxAll = new Map()
  for (const g of gpAll) if (g && g.noradId != null) gpIdxAll.set(String(g.noradId), g)
  const gpConst = filterGp(allGp, o)
  const gp = (o.owners.length || o.regimes.length || o.types.length)
    ? gpConst.filter((g) => idx.has(String(g && g.noradId)))
    : gpConst

  // 本报告真用到的代码（附录代码表只列这些 —— 报告里没出现的代码不该给读者一条词条）
  const used = { OWNER: new Set(), LAUNCH_SITE: new Set(), OPS_STATUS: new Set() }

  const scopeGroups = groups.map((g) => ({
    id: String((g && g.id) || ''), name: String((g && g.name) || ''),
    count: ((g && g.sats) || []).length
  }))
  // doc 先归一：第 1 章的「软件版本 / 生成时刻」两行要读它，且缺省报告名也由范围推出来
  const doc = normDoc(inp.doc, { mode, groups: scopeGroups, asOf, lang, brief: filterBrief(o, lang) })

  const ctx = { lang, en, T, rows, gp, gpAll, gpIdxAll, idx, idxAll, o, meta, asOf, used, mode, scopeGroups, doc,
    filtered, filterRowsCount: rows.length, allRowsCount: allRows.length, allGpCount: allGp.length,
    tz: normTzMode(inp.tz, 'local') }

  const want = (key) => {
    if (key === 'meta') return true
    // 组模式下附录恒出：检查器里那一栏切到卫星组就整片变灰（章节由所选的组决定），
    // 此时若沿用上一次在「全量」下取消勾选的状态，报告会静悄悄少掉「口径与判据」与代码表，
    // 而那一栏的悬停提示写的正是「一组一章，前有『数据来源与口径』、后有『附录』」。
    if (key === 'appendix' && mode === 'groups') return true
    const s = inp.opts && inp.opts.sections
    return !(s && s[key] === false)
  }

  const sections = []
  const figures = {}
  let no = 0
  const nextNo = () => String(++no)

  sections.push(secMeta(ctx, nextNo()))

  if (mode === 'all') {
    if (want('catalog')) sections.push(secCatalog(ctx, nextNo(), figures))
    if (want('regime')) sections.push(secRegime(ctx, nextNo(), figures))
    if (want('owner')) sections.push(secOwner(ctx, nextNo(), figures))
    if (want('launch')) sections.push(secLaunch(ctx, nextNo(), figures))
    if (want('constellation')) sections.push(secConstellation(ctx, nextNo(), figures))
    if (want('geo')) sections.push(secGeo(ctx, nextNo(), figures))
    if (want('epoch')) sections.push(secEpoch(ctx, nextNo(), figures))
  } else {
    for (let i = 0; i < groups.length; i++) sections.push(secGroup(ctx, groups[i], i + 1, figures))
  }
  // ★ 卫星组报告的章号是 1 / G1 / G2 / …（组章自成一套，见任务书 §7），附录不是组，也就没有号：
  //   再从 nextNo() 拿一个的话，附录会拿到「2」而排在 G2 之后，目录里就成了 1 / G1 / G2 / 2。
  if (want('appendix')) sections.push(secAppendix(ctx, mode === 'groups' ? '' : nextNo()))

  const model = {
    kind: 'ssa',
    lang,
    doc,
    data: meta,
    scope: {
      mode,
      groups: scopeGroups,
      filters: { constellations: o.constellations.slice(), owners: o.owners.slice(), regimes: o.regimes.slice(), types: o.types.slice() },
      filtered,
      rows: rows.length,
      rowsTotal: allRows.length
    },
    opts: {
      recentDays: o.recentDays, topN: o.topN, geoArc: o.geoArc.slice(), months: o.months, rowCap: o.rowCap,
      constellations: o.constellations.slice(), owners: o.owners.slice(), regimes: o.regimes.slice(), types: o.types.slice()
    },
    sections,
    figures
  }
  return pure(model)
}

// ===================================================================================
// 缺省值归一
// ===================================================================================

function normOpts(v) {
  const s = v || {}
  const int = (x, def, min) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n >= (min == null ? 1 : min) ? n : def }
  const arc = Array.isArray(s.geoArc) && s.geoArc.length === 2 && s.geoArc.every((x) => Number.isFinite(Number(x)))
    ? [Number(s.geoArc[0]), Number(s.geoArc[1])] : [60, 150]
  return {
    recentDays: int(s.recentDays, 30),
    topN: int(s.topN, 15),
    geoArc: arc,
    months: int(s.months, 24),
    rowCap: int(s.rowCap, MEMBER_CAP_DEF, 10),
    ...normFilters(s)
  }
}

// —— 四道筛选的显示名 ——
const FILTER_NAME = {
  constellations: D('典型星座', 'Constellations'),
  owners: D('所有者', 'Owners'),
  regimes: D('轨道区制', 'Orbital regimes'),
  types: D('对象类型', 'Object types')
}
// 逐维把代码译成人看得懂的名字（星座走 CONST_NAME、所有者走代码表、区制原样、类型走代码表）
function filterValueLabels(dim, vals, lang) {
  const en = lang === 'en'
  const T = (d) => (typeof d === 'string' ? d : (en ? d.en : d.zh))
  return (vals || []).map((v) => {
    if (dim === 'constellations') return T(CONST_NAME[v] || D(v, v))
    if (dim === 'owners') return `${v}　${ownerName(v, lang)}`
    if (dim === 'types') return `${v}　${objectTypeName(v, lang)}`
    return v
  })
}
// 生效的筛选 → [[维度名, 值列表串]]；没有任何筛选返回空表
function filterLabelRows(o, lang) {
  const en = lang === 'en'
  const T = (d) => (typeof d === 'string' ? d : (en ? d.en : d.zh))
  const out = []
  for (const k of FILTER_KEYS) {
    const v = o[k] || []
    if (!v.length) continue
    out.push([T(FILTER_NAME[k]), filterValueLabels(k, v, lang).join(en ? ', ' : '、')])
  }
  return out
}
// 报告名 / 文件名里的筛选摘要：只取值本身（不带维度名），维度间空格分隔，最多三维。
// 导出给窗口用 —— 屏上那份自动名与模型里那份必须是同一个函数拼的，各拼各的必然漂移。
export function filterBrief(o, lang) {
  const en = lang === 'en'
  const parts = []
  for (const k of FILTER_KEYS) {
    const v = o[k] || []
    if (!v.length) continue
    if (k === 'owners') parts.push(v.map((c) => ownerName(c, lang)).join(en ? '/' : '、'))
    else if (k === 'types') parts.push(v.map((c) => objectTypeName(c, lang)).join(en ? '/' : '、'))
    else if (k === 'constellations') parts.push(v.map((c) => (en ? (CONST_NAME[c] || { en: c }).en : (CONST_NAME[c] || { zh: c }).zh)).join(en ? '/' : '、'))
    else parts.push(v.join(en ? '/' : '、'))
    if (parts.length >= 3) break
  }
  return parts.join(' ')
}

function normMeta(v) {
  const s = v || {}
  const str = (x) => String(x == null ? '' : x)
  const int = (x) => { const n = Number(x); return Number.isFinite(n) ? Math.round(n) : 0 }
  return {
    satcatAt: str(s.satcatAt), satcatSource: str(s.satcatSource), satcatRows: int(s.satcatRows),
    gpAt: str(s.gpAt), gpSource: str(s.gpSource), gpRows: int(s.gpRows), gpGroups: int(s.gpGroups),
    asOf: str(s.asOf)
  }
}

function normDoc(v, def) {
  const s = v || {}
  const str = (x) => String(x == null ? '' : x)
  return {
    title: str(s.title) || ssaReportTitle(def.mode, def.groups, def.lang, def.brief),
    docNo: str(s.docNo),
    classification: str(s.classification),
    org: str(s.org),
    date: str(s.date),
    logo: s.logo == null ? null : s.logo,
    fonts: s.fonts == null ? null : s.fonts,
    appVersion: str(s.appVersion),
    generatedAt: str(s.generatedAt)
  }
}

// ===================================================================================
// 报告名与文件名（任务书 §7.2 末段）
// ===================================================================================

const BASE_TITLE = D('空间态势报告', 'Space Situational Awareness Report')

/** 组名串：≤ 3 组逐个列出（中文「、」连、英文逗号连），> 3 组写「首组名等 n 组」。 */
export function groupsLabel(groups, lang) {
  const en = lang === 'en'
  const names = (groups || []).map((g) => String((g && g.name) || '').trim()).filter(Boolean)
  if (!names.length) return ''
  if (names.length <= 3) return names.join(en ? ', ' : '、')
  return en ? `${names[0]} and ${names.length} groups` : `${names[0]}等 ${names.length} 组`
}

/** 默认报告名：全量「空间态势报告」；卫星组「<组名> 空间态势报告」。 */
export function ssaReportTitle(mode, groups, lang, brief) {
  const en = lang === 'en'
  const base = en ? BASE_TITLE.en : BASE_TITLE.zh
  const lab = mode === 'groups' ? groupsLabel(groups, lang) : String(brief || '').trim()
  if (!lab) return base
  return `${lab} ${base}`
}

// 文件名里不能出现的 Windows 保留字符一律换成下划线（空白另行折成下划线，见下）
const BAD_FILE_CH = /[\\/:*?"<>|]+/g

/** 默认文件名：空间态势报告_YYYYMMDD / 空间态势报告_<组名>_YYYYMMDD（日期取 asOf 的 UTC 日）。 */
export function ssaReportFileName(mode, groups, asOf, lang, brief) {
  const t = asOfMs(asOf)
  let ymd = ''
  if (Number.isFinite(t)) {
    const d = new Date(t)
    const p2 = (x) => (x < 10 ? '0' + x : String(x))
    ymd = String(d.getUTCFullYear()) + p2(d.getUTCMonth() + 1) + p2(d.getUTCDate())
  }
  const base = lang === 'en' ? 'Space Situational Awareness Report' : '空间态势报告'
  const parts = [base]
  const lab = mode === 'groups' ? groupsLabel(groups, lang) : String(brief || '').trim()
  if (lab) parts.push(lab)
  if (ymd) parts.push(ymd)
  return parts.join('_').replace(BAD_FILE_CH, '_').replace(/\s+/g, '_')
}

// ===================================================================================
// 块构造小工具
// ===================================================================================

const kv = (caption, rows) => ({ type: 'kv', caption, rows: rows.filter(Boolean) })

function table(t) {
  const b = { type: 'table', tableId: t.tableId, caption: t.caption, source: t.source, head: t.head, rows: t.rows }
  if (t.align) b.align = t.align
  if (t.widths) b.widths = t.widths
  if (t.capped) b.capped = t.capped
  if (t.emphasisRows && t.emphasisRows.length) b.emphasisRows = t.emphasisRows
  if (t.warnCells && t.warnCells.length) b.warnCells = t.warnCells
  return b
}

function figure(figures, figId, caption, spec) {
  figures[figId] = { spec, png: null }
  return { type: 'figure', figId, caption }
}

// 首列左对齐、其余右对齐是缺省；这里只在需要把某些列改回左对齐时显式给。
const alignLR = (n, leftCols) => {
  const a = []
  for (let i = 0; i < n; i++) a.push(leftCols.indexOf(i) >= 0 ? 'l' : 'r')
  return a
}

const S = (x) => String(x == null ? '' : x)
const N = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
const pctStr = (x, digits) => (typeof x === 'number' && Number.isFinite(x) ? (x * 100).toFixed(digits == null ? 2 : digits) + '%' : '—')

// ===================================================================================
// 1 数据来源与口径
// ===================================================================================

function secMeta(ctx, no) {
  const { T, meta, o, mode, doc, lang } = ctx
  const src = (k) => (SOURCE[k] ? T(SOURCE[k]) : (k || '—'))
  const scopeText = mode === 'groups'
    ? (groupsLabel(ctx.scopeGroups, ctx.lang) || T(D('卫星组', 'Satellite groups')))
    : T(D('全量编目', 'Full catalog'))
  // 生效的筛选逐维列出来 + 筛前筛后的条数 —— 报告里每一个数都是在这个子集上算的，
  // 不把子集讲清楚，读者拿这份报告与别处的数一对就会认为哪边算错了
  const fRows = filterLabelRows(o, lang)
  const blocks = [
    kv(T(D('数据来源', 'Data sources')), [
      [T(D('卫星编目（SATCAT）数据时间', 'Catalogue (SATCAT) data time')), fmtTs(meta.satcatAt, ctx.tz)],
      [T(D('卫星编目来源', 'Catalogue source')), src(meta.satcatSource)],
      [T(D('卫星编目条数', 'Catalogue rows')), S(meta.satcatRows)],
      [T(D('星历数据时间', 'Ephemeris data time')), fmtTs(meta.gpAt, ctx.tz)],
      [T(D('星历来源', 'Ephemeris source')), src(meta.gpSource)],
      [T(D('星历组数', 'Ephemeris groups')), S(meta.gpGroups)],
      [T(D('星历颗数', 'Ephemeris objects')), S(meta.gpRows)]
    ]),
    kv(T(D('报告基准', 'Report basis')), [
      [T(D('基准时刻', 'Reference epoch')), fmtTs(meta.asOf, ctx.tz)],
      [T(D('报告主体', 'Report subject')), scopeText],
      ctx.filtered && [T(D('本报告统计条数', 'Rows covered by this report')),
        `${S(ctx.filterRowsCount)} / ${S(ctx.allRowsCount)}`],
      [T(D('近期明细窗口（天）', 'Recent detail window (days)')), S(o.recentDays)],
      // 榜单位数 / 重点弧段只在全量报告里起作用；卫星组报告不列它们
      // （照 lbSlaReport 的口径：报告里没用上的参数不该给读者一行）
      mode === 'all' && [T(D('所有者榜条目数', 'Owner ranking size')), S(o.topN)],
      mode === 'all' && [T(D('GEO 重点弧段', 'GEO focus arc')), arcLabel(o.geoArc)],
      [T(D('大表行数上限', 'Row cap for large tables')), S(o.rowCap)],
      [T(D('软件版本', 'Software version')), doc.appVersion || '—'],
      [T(D('生成时刻', 'Generated at')), fmtTs(doc.generatedAt, ctx.tz)]
    ])
  ]
  if (fRows.length) blocks.splice(1, 0, kv(T(D('筛选条件', 'Filter conditions')), fRows))
  return { key: 'meta', no, title: T(SEC_TITLE.meta), blocks }
}

// 区间【右端点】的经度标注：fmtGeoSlot 把经度归一到 (−180,180]，180 会折成 180.0°W，
// 于是最东那个桶会印成「179.0°E – 180.0°W」。右端点单独处理，恒印 180.0°E。
const fmtLonEdge = (x) => (Number(x) >= 180 ? '180.0°E' : fmtGeoSlot(x))
const arcLabel = (arc) => `${fmtGeoSlot(arc[0])} – ${fmtLonEdge(arc[1])}`

// ===================================================================================
// 2 编目总览
// ===================================================================================

function secCatalog(ctx, no, figures) {
  const { T, rows } = ctx
  const ov = catalogOverview(rows)
  const head = [T(W.type), T(W.inOrbit), T(W.decayed), T(W.deepSpace), T(W.total)]
  const body = ov.byType.map((t) => [objectTypeName(t.code, ctx.lang), t.inOrbit, t.decayed, t.deepSpace, t.total])
  body.push([T(W.total), ov.inOrbit, ov.decayed, ov.deepSpace, ov.total])
  const blocks = [
    table({
      tableId: 't.catalog.type', source: 'SATCAT',
      caption: T(D('编目对象按类型分布', 'Catalogued objects by type')),
      head, rows: body, align: alignLR(5, [0])
    }),
    kv(T(D('总览读数', 'Overview')), [
      [T(W.activePay), S(ov.active)],
      [T(D('在轨对象', 'In-orbit objects')), S(ov.inOrbit)],
      [T(D('已陨落对象', 'Decayed objects')), S(ov.decayed)],
      [T(W.deepSpace), S(ov.deepSpace)],
      [T(D('停靠（DOC）', 'Docked (DOC)')), S(ov.docked)],
      [T(D('着陆（LAN）', 'Landed (LAN)')), S(ov.landed)],
      [T(D('再入 / 撞击（IMP）', 'Re-entry / impact (IMP)')), S(ov.impacted)]
    ]),
    figure(figures, 'f.catalog.stack', T(D('在轨对象类型构成', 'Composition of in-orbit objects by type')), {
      type: 'stack',
      segs: ov.byType.filter((t) => t.inOrbit > 0).map((t) => ({ label: objectTypeName(t.code, ctx.lang), value: t.inOrbit })),
      total: ov.inOrbit, unitLabel: T(W.objects)
    })
  ]
  return { key: 'catalog', no, title: T(SEC_TITLE.catalog), blocks }
}

// ===================================================================================
// 3 轨道区制
// ===================================================================================

function secRegime(ctx, no, figures) {
  const { T, rows } = ctx
  const rt = regimeTable(rows)
  // 任务书附录 B 把「区制 × 类型」与「区制 × 活跃载荷」列成两张表；这里并成一张
  // （同一批在轨对象、同一行轴，活跃载荷只是多一列），信息一个不少、读者少翻一张表。
  const head = [T(W.regime), ...rt.types.map((c) => objectTypeName(c, ctx.lang)), T(D('在轨合计', 'In-orbit total')), T(W.activePay)]
  const body = rt.rows.map((r) => [r.regime, ...rt.types.map((c) => r.byType[c]), r.total, r.active])
  body.push([T(W.total), ...rt.types.map((c) => rt.total.byType[c]), rt.total.total, rt.total.active])

  const orb = rows.filter(isInOrbit)
  // ★ 近地点图的量程写在图题里（0–2000 km），故越界值不入末桶（dropOver）：并进去的话，
  //   1950–2000 km 那根柱子画的是「≥ 1950 km 的全部在轨对象」，真实快照上是 11 被画成 3364。
  //   2000 km 以上的对象不是没统计 —— 上面那张区制表（MEO / GEO / IGSO / HEO 各行）里逐行都有。
  //   倾角图不设 dropOver：0–180° 已覆盖全域，恰好 180° 的那颗该落在末桶。
  const peri = histBins(orb.map((r) => r.perigeeKm), 0, 2000, 50, { dropOver: true })
  const incl = histBins(orb.map((r) => r.inclDeg), 0, 180, 5)
  const pay = orb.filter((r) => r.type === 'PAY')
  const hg = heatGrid(pay, { incStep: 5, altMax: 40000, altStep: 500 })

  const blocks = [
    table({
      tableId: 't.regime.type', source: 'SATCAT',
      caption: T(D('在轨对象按轨道区制与类型分布', 'In-orbit objects by orbital regime and type')),
      head, rows: body, align: alignLR(head.length, [0])
    }),
    figure(figures, 'f.regime.perigee', T(D('近地点高度分布（在轨对象，0–2000 km，50 km 分箱）', 'Perigee altitude distribution (in-orbit objects, 0–2000 km, 50 km bins)')), {
      type: 'hist', bins: peri.bins, xLabel: T(D('近地点高度（km）', 'Perigee altitude (km)')), yLabel: T(W.count)
    }),
    figure(figures, 'f.regime.incl', T(D('倾角分布（在轨对象，5° 分箱）', 'Inclination distribution (in-orbit objects, 5° bins)')), {
      type: 'hist', bins: incl.bins, xLabel: T(D('倾角（°）', 'Inclination (deg)')), yLabel: T(W.count)
    }),
    figure(figures, 'f.regime.heat', T(D('倾角 × 平均高度密度（在轨载荷，0–40000 km / 500 km × 5°）', 'Inclination vs mean altitude density (in-orbit payloads, 0–40000 km / 500 km x 5 deg)')), {
      type: 'heat', xBins: hg.xBins, yBins: hg.yBins, cells: hg.cells,
      xLabel: T(D('倾角（°）', 'Inclination (deg)')), yLabel: T(D('平均高度（km）', 'Mean altitude (km)')), legendLabel: T(W.count)
    })
  ]
  return { key: 'regime', no, title: T(SEC_TITLE.regime), blocks }
}

// ===================================================================================
// 4 所有者
// ===================================================================================

const HBAR_CAP = 20    // 排名图的横条上限（表可以给到 topN = 50，图画不下）

function secOwner(ctx, no, figures) {
  const { T, rows, o, used } = ctx
  const ot = ownerTable(rows, { topN: o.topN })
  const head = [T(W.code), T(W.owner), T(W.activePay), T(D('在轨载荷', 'In-orbit payloads')),
    T(D('火箭体', 'Rocket bodies')), T(D('碎片', 'Debris')), T(D('在轨合计', 'In-orbit total')),
    T(D('累计发射', 'Cumulative launched')), T(D('累计陨落', 'Cumulative decayed'))]
  const body = ot.rows.map((r) => {
    used.OWNER.add(r.owner)
    return [r.owner, ownerName(r.owner, ctx.lang), r.active, r.payloads, r.rockets, r.debris, r.inOrbit, r.launched, r.decayed]
  })
  body.push([T(W.total), '', ot.total.active, ot.total.payloads, ot.total.rockets, ot.total.debris, ot.total.inOrbit, ot.total.launched, ot.total.decayed])

  // 排名图只画前 20 条（再多横条就挤成一片）；表可以给到 topN = 50，图画不下。
  const items = ot.rows.slice(0, HBAR_CAP).map((r) => ({ label: r.owner, value: r.payloads }))
  const blocks = [
    table({
      tableId: 't.owner.top', source: 'SATCAT',
      caption: T(D('所有者统计（在轨载荷前 %n 位）', 'Owners (top %n by in-orbit payloads)')).replace('%n', String(o.topN)),
      head, rows: body, align: alignLR(head.length, [0, 1])
    }),
    figure(figures, 'f.owner.rank', T(D('在轨载荷排名（所有者）', 'In-orbit payloads by owner')), {
      type: 'hbar', items, xLabel: T(D('在轨载荷（个）', 'In-orbit payloads'))
    })
  ]
  return { key: 'owner', no, title: T(SEC_TITLE.owner), blocks }
}

// ===================================================================================
// 5 发射与陨落
// ===================================================================================

function secLaunch(ctx, no, figures) {
  const { T, rows, o, asOf, used } = ctx
  const ms = monthlySeries(rows, { asOf, months: o.months })
  const ls = launchSeries(rows, { asOf })
  const ds = decaySeries(rows, { asOf })
  const cum = inOrbitCumulative(rows, { asOf })
  const rl = recentLaunches(rows, { asOf, days: o.recentDays })
  const rd = recentDecays(rows, { asOf, days: o.recentDays })

  const mHead = [T(W.months), T(D('发射（载荷）', 'Launched (payloads)')), T(D('发射（全部）', 'Launched (all)')),
    T(D('陨落（载荷）', 'Decayed (payloads)')), T(D('陨落（全部）', 'Decayed (all)'))]
  const mRows = ms.months.map((m, i) => [m, ms.launchPay[i], ms.launchAll[i], ms.decayPay[i], ms.decayAll[i]])

  const cumX = cum.months.map((s) => { const p = s.split('-'); return Number(p[0]) + (Number(p[1]) - 1) / 12 })

  const blocks = [
    table({
      tableId: 't.launch.monthly', source: 'SATCAT',
      caption: T(D('近 %n 个月逐月发射与陨落', 'Monthly launches and decays over the last %n months')).replace('%n', String(o.months)),
      head: mHead, rows: mRows, align: alignLR(5, [0])
    }),
    figure(figures, 'f.launch.year', T(D('逐年发射数量', 'Launches by year')), {
      type: 'line', x: ls.years, xIsYear: true,
      series: [{ name: T(D('载荷', 'Payloads')), data: ls.payload }, { name: T(D('全部对象', 'All objects')), data: ls.all }],
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }),
    figure(figures, 'f.decay.year', T(D('逐年陨落数量', 'Decays by year')), {
      type: 'line', x: ds.years, xIsYear: true,
      series: [{ name: T(D('载荷', 'Payloads')), data: ds.payload }, { name: T(D('全部对象', 'All objects')), data: ds.all }],
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }),
    figure(figures, 'f.inorbit.cum', T(D('在轨对象累计（逐月）', 'Cumulative objects in orbit (monthly)')), {
      type: 'line', x: cumX, xIsYear: true,
      series: [{ name: T(D('在轨对象', 'Objects in orbit')), data: cum.counts }],
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }),
    kv(T(D('近 %n 天新发射计数', 'New launches in the last %n days')).replace('%n', String(o.recentDays)), [
      [T(D('载荷', 'Payloads')), S(rl.payloads.length)],
      [T(D('火箭体', 'Rocket bodies')), S(rl.rockets.length)],
      [T(D('碎片', 'Debris')), S(rl.debris)],
      [T(D('其它 / 未知', 'Other / unknown')), S(rl.other)],
      [T(W.total), S(rl.total)]
    ])
  ]
  const detailHead = [T(W.name), T(W.objectId), T(W.norad), T(W.owner), T(W.launchDate), T(W.launchSite), T(W.type), T(W.regime)]
  const detailRows = rl.payloads.concat(rl.rockets).map((r) => {
    used.OWNER.add(r.owner); used.LAUNCH_SITE.add(r.launchSite)
    return [r.name, r.objectId, r.norad, r.owner, r.date, r.launchSite, objectTypeName(r.type, ctx.lang), r.regime]
  })
  if (detailRows.length) {
    blocks.push(table({
      tableId: 't.launch.recent', source: 'SATCAT',
      caption: T(D('近 %n 天新发射明细（载荷与火箭体）', 'New launches in the last %n days (payloads and rocket bodies)')).replace('%n', String(o.recentDays)),
      head: detailHead, rows: detailRows, align: alignLR(8, [0, 1, 3, 4, 5, 6, 7])
    }))
  }
  blocks.push(kv(T(D('近 %n 天陨落计数', 'Decays in the last %n days')).replace('%n', String(o.recentDays)), [
    [T(D('载荷', 'Payloads')), S(rd.payloads.length)],
    [T(D('火箭体', 'Rocket bodies')), S(rd.rockets.length)],
    [T(D('碎片', 'Debris')), S(rd.debris)],
    [T(D('其它 / 未知', 'Other / unknown')), S(rd.other)],
    [T(W.total), S(rd.total)]
  ]))
  const dHead = [T(W.name), T(W.objectId), T(W.norad), T(W.owner), T(W.decayDate), T(W.type), T(W.regime)]
  const dRows = rd.payloads.concat(rd.rockets).map((r) => {
    used.OWNER.add(r.owner)
    return [r.name, r.objectId, r.norad, r.owner, r.date, objectTypeName(r.type, ctx.lang), r.regime]
  })
  if (dRows.length) {
    blocks.push(table({
      tableId: 't.decay.recent', source: 'SATCAT',
      caption: T(D('近 %n 天陨落明细（载荷与火箭体）', 'Decays in the last %n days (payloads and rocket bodies)')).replace('%n', String(o.recentDays)),
      head: dHead, rows: dRows, align: alignLR(7, [0, 1, 3, 4, 5, 6])
    }))
  }
  return { key: 'launch', no, title: T(SEC_TITLE.launch), blocks }
}

// ===================================================================================
// 6 大型星座部署
// ===================================================================================

const shellText = (s) => `${s.altKm} km · ${s.incDeg}° · ${s.n}`

function secConstellation(ctx, no, figures) {
  const { T, rows, gp, asOf } = ctx
  // ★ 一行里两侧必须同口径：左半边（累计发射 / 在轨 / 活跃 / 累计陨落）来自筛过的编目，右半边
  //   （星历颗数 / 主壳层）来自筛过的星历 —— 否则会出「Starlink 累计发射 0 / 星历颗数 11123」
  //   这种自相矛盾的行。「筛过的星历」原先是本函数里就地算的（局部变量 gpSame），2026-09-17
  //   上提到 buildSsaModel 成为 ctx.gp，第 7、8 两章从此与本章同口径；本章的数逐位不变。
  const cd = constellationDeploy(rows, gp, { asOf })
  const head = [T(D('星座', 'Constellation')), T(D('累计发射', 'Cumulative launched')), T(W.inOrbit), T(D('活跃', 'Active')),
    T(D('近 30 天', 'Last 30 d')), T(D('近 365 天', 'Last 365 d')), T(D('累计陨落', 'Cumulative decayed')),
    T(D('星历颗数', 'Ephemeris objects')), T(D('主壳层 1', 'Main shell 1')), T(D('主壳层 2', 'Main shell 2')), T(D('主壳层 3', 'Main shell 3'))]
  const body = cd.rows.map((r) => [
    T(CONST_NAME[r.key] || D(r.key, r.key)), r.launched, r.inOrbit, r.active, r.recent30, r.recent365, r.decayed, r.gpCount,
    r.shells[0] ? shellText(r.shells[0]) : '—', r.shells[1] ? shellText(r.shells[1]) : '—', r.shells[2] ? shellText(r.shells[2]) : '—'
  ])
  const blocks = [
    table({
      tableId: 't.const.deploy', source: 'SATCAT+GP',
      caption: T(D('大型星座部署统计（主壳层格式：高度 · 倾角 · 颗数）', 'Large constellation deployment (shell format: altitude / inclination / count)')),
      head, rows: body, align: alignLR(head.length, [0, 8, 9, 10])
    }),
    figure(figures, 'f.const.rank', T(D('大型星座在轨数量', 'In-orbit objects by constellation')), {
      type: 'hbar', items: cd.rows.slice(0, 20).map((r) => ({ label: T(CONST_NAME[r.key] || D(r.key, r.key)), value: r.inOrbit })),
      xLabel: T(D('在轨（个）', 'In orbit'))
    })
  ]
  return { key: 'constellation', no, title: T(SEC_TITLE.constellation), blocks }
}

// ===================================================================================
// 7 GEO 轨道弧
// ===================================================================================

function secGeo(ctx, no, figures) {
  const { T, gp, idxAll, o, used } = ctx
  // ★ 统计的那批星是 ctx.gp —— 【筛后】的星历（见 buildSsaModel），故本章跟着「统计范围」走：
  //   所有者筛成中国，这里的定点数、共位簇、重点弧段表就只讲中国的星。
  //   ★ 随之而来的口径：共位簇也只在筛后的这批星里连通 —— 一份筛过的报告不谈范围外的星，
  //     要看「别国那颗贴着我停的」，看组章 G.5 的 ±1° 邻星（那一处走全量 gpAll）。
  // ★ 而这里的编目索引只用来【查属性】（这颗星的所有者 / 状态 / 国际编号），不定统计口径，
  //   故走全量索引 idxAll：用筛后的 idx 时，被筛掉的那些星查不到行，重点弧段表的
  //   「代码 / 所有者 / 状态」三列会整片空白（真实快照 + 所有者筛 PRC：180 行空 119 行）。
  const go = geoOccupancy(gp, idxAll, { binDeg: 1, coloTol: 0.2, arc: o.geoArc, topN: o.topN })
  const binLabel = (lon) => `${fmtGeoSlot(lon)} – ${fmtLonEdge(lon + go.binDeg)}`

  const blocks = [
    kv(T(D('GEO 占用读数', 'GEO occupancy')), [
      [T(D('定点解算成功的 GEO 卫星', 'GEO satellites with a resolved slot')), S(go.total)],
      [T(D('共位簇（≥ 2 颗）', 'Co-located clusters (2+ satellites)')), S(go.clusters.length)],
      [T(D('重点弧段', 'Focus arc')), arcLabel(o.geoArc)],
      [T(D('重点弧段内卫星', 'Satellites within the focus arc')), S(go.arc.n)]
    ]),
    table({
      tableId: 't.geo.top', source: 'SATCAT+GP',
      caption: T(D('1° 经度桶卫星数前 %n 位', 'Top %n one-degree longitude bins by satellite count')).replace('%n', String(o.topN)),
      head: [T(W.lonRange), T(W.count)],
      rows: go.top.map((b) => [binLabel(b.lon), b.n]), align: ['l', 'r']
    })
  ]
  if (go.clusters.length) {
    blocks.push(table({
      tableId: 't.geo.colo', source: 'SATCAT+GP',
      caption: T(D('共位簇（相邻定点经度差 ≤ %t°，≥ 2 颗）', 'Co-located clusters (adjacent slot spacing <= %t deg, 2+ satellites)')).replace('%t', String(go.coloTol)),
      head: [T(W.lonRange), T(W.count), T(W.sats)],
      rows: go.clusters.map((c) => [`${fmtGeoSlot(c.lonFrom)} – ${fmtGeoSlot(c.lonTo)}`, c.n, c.sats.map((s) => s.name).join(ctx.en ? ', ' : '、')]),
      align: ['l', 'r', 'l']
    }))
  }
  const arcRows = go.arc.sats.map((s) => {
    used.OWNER.add(s.owner); used.OPS_STATUS.add(s.status)
    return [s.name, s.norad, s.slot, s.owner, ownerName(s.owner, ctx.lang), opsStatusName(s.status, ctx.lang)]
  })
  if (arcRows.length) {
    blocks.push(table({
      tableId: 't.geo.arc', source: 'SATCAT+GP',
      caption: T(D('重点弧段 %a 内的卫星', 'Satellites within the focus arc %a')).replace('%a', arcLabel(o.geoArc)),
      head: [T(W.name), T(W.norad), T(W.slot), T(W.code), T(W.owner), T(W.status)],
      rows: arcRows, align: alignLR(6, [0, 2, 3, 4, 5])
    }))
  }
  blocks.push(figure(figures, 'f.geo.strip', T(D('GEO 定点经度占用（1° 桶）', 'GEO longitude slot occupancy (1-degree bins)')), {
    type: 'strip', bins: go.bins,
    bands: [{ from: o.geoArc[0], to: o.geoArc[1], label: arcLabel(o.geoArc) }],
    xLabel: T(D('定点经度（°）', 'Slot longitude (deg)')), yLabel: T(W.count)
  }))
  return { key: 'geo', no, title: T(SEC_TITLE.geo), blocks }
}

// ===================================================================================
// 8 星历时效
// ===================================================================================

// 历元龄分布图：x 上界跟着实测最大值走，★ 不封顶。原先封在 30 天，离线用内置快照时（历元龄
// 上百天）整张图作废 —— 表里写着中位数 181 天，图里 16559 颗全挤在 29–30 天那一条，同一节自相矛盾。
// 桶宽从 1 / 2 / 5 / 10 … 这道阶梯里取第一个能把桶数压进 EPOCH_BINS_MAX 的：日常「当天更新」那档
// 仍是 1 天分箱（与改前逐位相同），远古快照才放大桶宽。实际桶宽随图题一起印出去，图题不许写死。
const EPOCH_BINS_MAX = 40
const EPOCH_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]

function epochHist(ctx, ages) {
  const { T } = ctx
  let max = 0
  for (const a of ages) if (Number.isFinite(a) && a > max) max = a
  const top = Math.max(1, Math.ceil(max))
  let step = EPOCH_STEPS[EPOCH_STEPS.length - 1]
  for (const s of EPOCH_STEPS) if (Math.ceil(top / s) <= EPOCH_BINS_MAX) { step = s; break }
  const hi = Math.ceil(top / step) * step
  const hb = histBins(ages, 0, hi, step)
  return { step, spec: { type: 'hist', bins: hb.bins, xLabel: T(D('历元龄（天）', 'Epoch age (days)')), yLabel: T(W.count) } }
}

function secEpoch(ctx, no, figures) {
  // ctx.gp 是【筛后】的星历，本章跟着「统计范围」走 —— 表首行「全部在轨（星历并集）」说的是
  // 本报告范围内的全部在轨，与第 2 章的合计是同一批星，不是本机取到的 17 组的并集。
  const { T, gp, asOf } = ctx
  const ea = epochAgeStats(gp, asOf)
  const head = [T(D('范围', 'Scope')), T(W.count), T(D('中位数（天）', 'Median (d)')), T(D('P90（天）', 'P90 (d)')),
    T(D('最大（天）', 'Max (d)')), T(D('> 7 天颗数', 'Older than 7 d'))]
  const body = []
  const warn = []
  const push = (label, s) => {
    const r = body.length
    body.push([label, s.n, s.median, s.p90, s.max, s.stale])
    for (const c of [2, 3, 4]) { const v = body[r][c]; if (typeof v === 'number' && v > 7) warn.push([r, c]) }
  }
  push(T(D('全部在轨（星历并集）', 'All in orbit (ephemeris union)')), ea.overall)
  for (const c of ea.byConst) push(T(CONST_NAME[c.key] || D(c.key, c.key)), c)
  const eh = epochHist(ctx, ea.ages)
  const blocks = [
    table({
      tableId: 't.epoch.age', source: 'GP',
      caption: T(D('星历历元龄', 'Ephemeris epoch age')),
      head, rows: body, align: alignLR(6, [0]), warnCells: warn
    }),
    figure(figures, 'f.epoch.hist',
      T(D('历元龄分布（%s 天分箱）', 'Epoch age distribution (%s-day bins)')).replace('%s', String(eh.step)), eh.spec)
  ]
  return { key: 'epoch', no, title: T(SEC_TITLE.epoch), blocks }
}

// ===================================================================================
// 卫星组章（G1…Gn，每章 5 小节）
// ===================================================================================

function secGroup(ctx, group, gi, figures) {
  // ★ 成员的四类判定与逐行属性一律走【全量】编目索引 idxAll：组的成员是用户点名的那几颗，
  //   不是本次筛选的产物 —— 拿筛后的 idx 查，被筛掉的成员会被误报成「编目查无此号」，
  //   所有者 / 状态 / 类型几列一并变空（模块说明 §1 写死了这条）。
  //   筛后的 rows 只用在 groupVsCatalog 那一处：它算的是「本组占同区制在轨载荷的比例」，
  //   分母是统计口径，该跟着筛选走。
  // ★ 星历侧同理，走【全量】gpIdxAll：拿筛后的建索引，一开「典型星座＝OneWeb」再看一个
  //   Starlink 的组，六个成员会整片报「不在星历」，G.2 成员表的根数列一并变空（实测）。
  const { T, rows, gpAll, gpIdxAll, idxAll, o, asOf, used, en } = ctx
  const gid = 'g' + gi
  const P = (n, d) => `G${gi}.${n} ${T(d)}`
  const res = groupResolve(group, gpIdxAll, idxAll)
  const members = groupMembers(group, gpIdxAll, idxAll, { asOf })
  const vs = groupVsCatalog(members, rows)

  // —— G.1 概况 ——
  const missObserved = res.absent.filter((e) => e.missAt).length
  const regimeMix = new Map()
  const ownerMix = new Map()
  let activeN = 0, ageSum = 0, ageN = 0
  let ldMin = '', ldMax = ''
  for (const m of members) {
    if (m.cls !== 'decayed' && m.cls !== 'unknown') regimeMix.set(m.regime, (regimeMix.get(m.regime) || 0) + 1)
    if (m.owner) { ownerMix.set(m.owner, (ownerMix.get(m.owner) || 0) + 1); used.OWNER.add(m.owner) }
    if (m.status) used.OPS_STATUS.add(m.status)
    const row = idxAll.get(m.id)
    if (row && isActiveInOrbit(row)) activeN++
    if (Number.isFinite(m.ageDays)) { ageSum += m.ageDays; ageN++ }
    if (m.launchDate) { if (!ldMin || m.launchDate < ldMin) ldMin = m.launchDate; if (!ldMax || m.launchDate > ldMax) ldMax = m.launchDate }
  }
  const mixText = (m, fmt) => {
    const arr = [...m.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))
    if (!arr.length) return '—'
    return arr.map(fmt).join(en ? ', ' : '、')
  }
  const ratioText = vs.byRegime.length
    ? vs.byRegime.map((r) => `${r.regime} ${pctStr(r.ratio)}`).join(en ? ', ' : '、')
    : '—'

  const blocks = [
    kv(P(1, D('概况', 'Overview')), [
      [T(D('成员数', 'Members')), S(res.total)],
      [T(D('在最新星历中', 'In latest ephemeris')), S(res.inGp.length)],
      [T(D('不在星历（含缺席观察 %k 颗）', 'Not in ephemeris (%k with a first-absence record)')).replace('%k', String(missObserved)), S(res.absent.length)],
      [T(D('编目已陨落', 'Decayed per catalogue')), S(res.decayed.length)],
      [T(D('编目查无此号（含自定义号段 %c 颗）', 'Not found in catalogue (%c synthetic NORAD)')).replace('%c', String(res.customCount)), S(res.unknown.length)],
      [T(D('活跃状态', 'Active status')), S(activeN)],
      [T(D('区制构成', 'Regime mix')), mixText(regimeMix, ([k, v]) => `${k} ${v}`)],
      [T(D('所有者构成', 'Owner mix')), mixText(ownerMix, ([k, v]) => `${k} ${v}`)],
      [T(D('发射跨度', 'Launch span')), ldMin ? `${ldMin} – ${ldMax}` : '—'],
      [T(D('平均在轨龄（天）', 'Mean time in orbit (d)')), ageN ? String(Math.round(ageSum / ageN)) : '—'],
      [T(D('占同区制在轨载荷比例', 'Share of in-orbit payloads in the same regime')), ratioText]
    ])
  ]

  // —— G.2 成员表 ——
  const mHead = [T(W.name), T(W.norad), T(W.objectId), T(W.owner), T(W.launchDate), T(D('在轨天数', 'Days in orbit')),
    T(W.status), T(W.type), T(W.regime), T(D('近地点（km）', 'Perigee (km)')), T(D('远地点（km）', 'Apogee (km)')),
    T(D('倾角（°）', 'Inclination (deg)')), T(D('周期（min）', 'Period (min)')), T(D('RAAN（°）', 'RAAN (deg)')),
    T(D('历元', 'Epoch')), T(D('历元龄（天）', 'Epoch age (d)')), T(D('RCS（m²）', 'RCS (m2)')), T(D('GEO 定点', 'GEO slot')), T(W.source)]
  const shown = members.slice(0, ctx.o.rowCap)
  const mWarn = []
  const mRows = shown.map((m, i) => {
    if (Number.isFinite(m.epochAgeDays) && m.epochAgeDays > 7) mWarn.push([i, 15])
    return [m.name, m.id, m.objectId, m.owner, m.launchDate, N(m.ageDays), m.status,
      m.type ? objectTypeName(m.type, ctx.lang) : '', m.regime, N(m.perigeeKm), N(m.apogeeKm), N(m.inclDeg),
      // 历元过显示时区档：GP CSV 里那串是 `2026-09-15T00:00:00.000000`（无时区、六位小数），
      // 上纸就是一列读不动的机器串
      N(m.periodMin), N(m.raanDeg), fmtEpoch(m.epoch, ctx.tz), N(m.epochAgeDays), N(m.rcsM2), m.geoSlot, m.source]
  })
  const mTable = {
    tableId: 't.' + gid + '.members', source: 'SATCAT+GP',
    caption: P(2, D('成员表', 'Members')),
    head: mHead, rows: mRows, align: alignLR(19, [0, 1, 2, 3, 4, 6, 7, 8, 14, 17, 18]), warnCells: mWarn
  }
  if (members.length > ctx.o.rowCap) mTable.capped = { shown: shown.length, total: members.length }
  blocks.push(table(mTable))

  // —— G.3 轨道分布 ——
  const pc = planeClusters(members, { incTol: 1, raanTol: 4 })
  blocks.push(table({
    tableId: 't.' + gid + '.planes', source: 'GP',
    caption: P(3, D('轨道面估计（升交点赤经聚类）', 'Orbital plane estimate (RAAN clustering)')),
    head: [T(D('倾角（°）', 'Inclination (deg)')), T(D('高度（km）', 'Altitude (km)')), T(W.count), T(D('面数', 'Planes')),
      T(D('每面颗数', 'Per plane')), T(D('面间平均间隔（°）', 'Mean plane spacing (deg)')), T(D('最小（°）', 'Min (deg)')), T(D('最大（°）', 'Max (deg)'))],
    rows: pc.shells.map((s) => [N(s.inclDeg), N(s.altKm), s.n, s.planeCount, `${s.perPlaneMin}–${s.perPlaneMax}`, N(s.spacingDeg), N(s.spacingMinDeg), N(s.spacingMaxDeg)]),
    align: alignLR(8, [4])
  }))
  const alts = members.map((m) => (Number.isFinite(m.perigeeKm) && Number.isFinite(m.apogeeKm) ? (m.perigeeKm + m.apogeeKm) / 2 : NaN)).filter(Number.isFinite)
  blocks.push(figure(figures, 'f.' + gid + '.alt', P(3, D('平均高度分布', 'Mean altitude distribution')), altHistSpec(ctx, alts)))
  blocks.push(figure(figures, 'f.' + gid + '.incl', P(3, D('倾角分布（5° 分箱）', 'Inclination distribution (5-degree bins)')), {
    type: 'hist', bins: histBins(members.map((m) => m.inclDeg), 0, 180, 5).bins,
    xLabel: T(D('倾角（°）', 'Inclination (deg)')), yLabel: T(W.count)
  }))
  blocks.push(figure(figures, 'f.' + gid + '.scatter', P(3, D('升交点赤经 × 倾角', 'RAAN vs inclination')), scatterSpec(ctx, members)))

  // —— G.4 变化 ——
  const t = asOfMs(asOf)
  const recent = Number.isFinite(t)
    ? members.filter((m) => { const ms = dayMs(m.launchDate); return Number.isFinite(ms) && ms >= t - o.recentDays * 86400000 && ms <= t })
    : []
  if (recent.length) {
    blocks.push(table({
      tableId: 't.' + gid + '.recent', source: 'SATCAT',
      caption: P(4, D('近 %n 天入轨成员', 'Members launched in the last %n days')).replace('%n', String(o.recentDays)),
      head: [T(W.name), T(W.norad), T(W.launchDate), T(W.owner), T(W.regime)],
      rows: recent.map((m) => [m.name, m.id, m.launchDate, m.owner, m.regime]), align: alignLR(5, [0, 1, 2, 3, 4])
    }))
  }
  const lost = members.filter((m) => m.cls === 'decayed' || m.cls === 'absent' || m.cls === 'unknown')
  if (lost.length) {
    const clsName = { decayed: D('编目已陨落', 'Decayed per catalogue'), absent: D('不在星历', 'Not in ephemeris'), unknown: D('编目查无此号', 'Not found in catalogue') }
    blocks.push(table({
      tableId: 't.' + gid + '.lost', source: 'SATCAT+GP',
      caption: P(4, D('已陨落 / 缺席成员', 'Decayed or absent members')),
      head: [T(W.name), T(W.norad), T(W.category), T(W.decayDate), T(D('缺席观察时刻', 'First absence recorded'))],
      // missAt 是 3D 页存进卫星组里的 ISO 串（首次缺席观察时刻），同样过显示时区档再上纸
      rows: lost.map((m) => [m.name, m.id, T(clsName[m.cls]), (idxAll.get(m.id) || {}).decayDate || '—', fmtTs(m.missAt, ctx.tz)]),
      align: alignLR(5, [0, 1, 2, 3, 4])
    }))
  }
  const inactive = members.filter((m) => { const row = idxAll.get(m.id); return row && row.type === 'PAY' && !isActiveInOrbit(row) && !isDecayed(row) })
  if (inactive.length) {
    blocks.push(table({
      tableId: 't.' + gid + '.inactive', source: 'SATCAT',
      caption: P(4, D('非活跃状态成员', 'Members without an active status')),
      head: [T(W.name), T(W.norad), T(W.code), T(W.status), T(W.type)],
      rows: inactive.map((m) => [m.name, m.id, m.status || '—', opsStatusName(m.status, ctx.lang), objectTypeName(m.type, ctx.lang)]),
      align: alignLR(5, [0, 1, 2, 3, 4])
    }))
  }

  // —— G.5 GEO 成员 ——
  const geoMembers = members.filter((m) => m.geoSlot && Number.isFinite(m.lon))
  if (geoMembers.length) {
    blocks.push(table({
      tableId: 't.' + gid + '.geo', source: 'SATCAT+GP',
      caption: P(5, D('GEO 成员定点与 ±%t° 邻星', 'GEO members: slots and neighbours within ±%t deg')).replace('%t', '1.0'),
      head: [T(W.name), T(W.norad), T(W.slot), T(W.owner), T(W.status), T(D('邻星（Δ经度）', 'Neighbours (delta longitude)'))],
      rows: geoMembers.map((m) => {
        // 邻星走【全量】gpAll：挤在你旁边 0.1° 的那颗是不是本次筛选留下的，与它挤不挤你无关
        const nb = geoNeighbors({ norad: m.id, lon: m.lon }, gpAll, { tol: 1.0, index: idxAll })
        const txt = nb.length
          ? nb.map((x) => `${x.name} (${x.dLon >= 0 ? '+' : '−'}${Math.abs(x.dLon).toFixed(2)}°)`).join(en ? ', ' : '、')
          : T(W.none)
        return [m.name, m.id, m.geoSlot, m.owner, m.status, txt]
      }),
      align: alignLR(6, [0, 1, 2, 3, 4, 5])
    }))
    blocks.push(figure(figures, 'f.' + gid + '.strip', P(5, D('本组 GEO 定点在经度条带上的位置', 'Group GEO slots on the longitude strip')), {
      type: 'strip',
      bins: geoStripBins(geoMembers),
      marks: geoMembers.map((m) => ({ lon: m.lon, label: m.name })),
      xLabel: T(D('定点经度（°）', 'Slot longitude (deg)')), yLabel: T(W.count)
    }))
  }

  return { key: 'g:' + String((group && group.id) || gi), no: 'G' + gi, title: String((group && group.name) || ''), blocks }
}

function altHistSpec(ctx, alts) {
  const { T } = ctx
  if (!alts.length) return { type: 'hist', bins: [], xLabel: T(D('平均高度（km）', 'Mean altitude (km)')), yLabel: T(W.count) }
  let lo = Infinity, hi = -Infinity
  for (const a of alts) { if (a < lo) lo = a; if (a > hi) hi = a }
  lo = Math.floor(lo / 25) * 25
  hi = Math.ceil(hi / 25) * 25
  if (hi <= lo) hi = lo + 25
  const step = 25 * Math.max(1, Math.ceil((hi - lo) / 25 / 30))   // 桶数封顶 30，步长恒为 25 km 的整数倍
  return { type: 'hist', bins: histBins(alts, lo, lo + step * Math.ceil((hi - lo) / step), step).bins, xLabel: T(D('平均高度（km）', 'Mean altitude (km)')), yLabel: T(W.count) }
}

const SCATTER_CAP = 2000
function scatterSpec(ctx, members) {
  const { T } = ctx
  const all = members.filter((m) => Number.isFinite(m.raanDeg) && Number.isFinite(m.inclDeg))
  // 超出上限按固定步长抽稀（不随机：同一份数据两次出图必须一样）
  const stride = all.length > SCATTER_CAP ? Math.ceil(all.length / SCATTER_CAP) : 1
  const pts = []
  for (let i = 0; i < all.length; i += stride) pts.push({ x: all[i].raanDeg, y: all[i].inclDeg })
  const spec = {
    type: 'scatter', pts, xRange: [0, 360], yRange: [0, 180],
    xLabel: T(D('升交点赤经（°）', 'RAAN (deg)')), yLabel: T(D('倾角（°）', 'Inclination (deg)'))
  }
  if (stride > 1) spec.capped = { shown: pts.length, total: all.length }
  return spec
}

// 组内 GEO 条带：仍画 −180…180 全程 1° 桶，只是计数只来自本组（读者能一眼看出本组占了哪几段）
function geoStripBins(geoMembers) {
  const bins = []
  for (let i = 0; i < 360; i++) bins.push({ lon: -180 + i, n: 0 })
  for (const m of geoMembers) {
    let i = Math.floor(m.lon + 180)
    if (i < 0) i = 0
    if (i > 359) i = 359
    bins[i].n++
  }
  return bins
}

// ===================================================================================
// 附录：口径与判据 + 代码表
// ===================================================================================

// 「口径与判据」全文。★ 只写定义，不写评价 —— 这是全报告唯一允许成段文字的地方。
//
// 四列（类别 | 项 | 判据 | 数据来源）而不是两列：原先一张平表把「SATCAT 的字段规则」「由根数算出来的量」
// 「按名称猜的归类」「随设置变的窗口」混在一起，读者没法判断哪条是编目自带的事实、哪条是本平台算的、
// 哪条只是近似 —— 而这恰恰是拿这份报告对外说话时最先被问到的。类别给视角，来源给可追溯性。
//
// ★ 2026-09-17 逐条精简：判据格里只留「怎么算的」——字段名、阈值、集合、公式、单位、边界一个不少，
//   讲动机的从句（「取历元一拍而非长期平均：未受控的漂移星本就没有『定点』…」这类）一律删。
//   同时把原先塞在「区制判定」尾部的 e / a 求法拆成自己一行：一格一件事，才不用在表里读长句。
const CRIT_CAT = {
  state: D('对象状态', 'Object state'),
  attr: D('对象属性', 'Object attributes'),
  orbit: D('轨道', 'Orbit'),
  time: D('时间', 'Time'),
  group: D('归类方法', 'Classification method'),
  filter: D('筛选条件', 'Filter conditions')
}
const CRIT_SRC = {
  satcat: D('SATCAT 字段', 'SATCAT fields'),
  gp: D('GP 星历', 'GP ephemeris'),
  both: D('GP 优先，缺则 SATCAT', 'GP first, SATCAT fallback'),
  calc: D('由根数算出', 'Derived from elements'),
  approx: D('名称近似', 'Name heuristic'),
  opt: D('报告设置', 'Report settings'),
  group3d: D('卫星组存档', 'Satellite group record')
}

function criteriaRows(ctx) {
  const { T, o, mode, lang } = ctx
  const list = []
  const row = (cat, item, def, src) => list.push([T(CRIT_CAT[cat]), T(item), T(def), T(CRIT_SRC[src])])

  // ① 对象状态：三类互斥且铺满整张编目表 —— 报告里每一个「合计」都靠这条成立
  row('state', D('在轨', 'In orbit'),
    D('DECAY_DATE 为空，ORBIT_TYPE ∈ {ORB, DOC}，ORBIT_CENTER = EA 或为数字（停靠于地球轨道母体）。',
      'DECAY_DATE empty, ORBIT_TYPE in {ORB, DOC}, ORBIT_CENTER = EA or numeric (docked to a parent body in Earth orbit).'), 'satcat')
  row('state', D('已陨落', 'Decayed'),
    D('DECAY_DATE 非空，或 ORBIT_TYPE = IMP；中心天体为地球。',
      'DECAY_DATE non-empty, or ORBIT_TYPE = IMP; central body the Earth.'), 'satcat')
  row('state', D('深空 / 着陆', 'Deep space / landed'),
    D('ORBIT_CENTER 非地球，或 ORBIT_TYPE ∈ {LAN, R/T}；单独计数，不进区制表与所有者表。',
      'ORBIT_CENTER other than the Earth, or ORBIT_TYPE in {LAN, R/T}; counted separately, excluded from the regime and owner tables.'), 'satcat')

  // ② 对象属性
  row('attr', D('对象类型', 'Object type'),
    D('OBJECT_TYPE：PAY 载荷 · R/B 火箭体 · DEB 碎片 · UNK 未知。',
      'OBJECT_TYPE: PAY payload, R/B rocket body, DEB debris, UNK unknown.'), 'satcat')
  row('attr', D('运行状态', 'Operational status'),
    D('OPS_STATUS_CODE：+ 运行 · - 停运 · P 部分运行 · B 备份 · S 备用 · X 延寿 · D 已陨落 · ? 未知；空 = 未标注。',
      'OPS_STATUS_CODE: + operational, - nonoperational, P partially operational, B backup, S spare, X extended mission, D decayed, ? unknown; empty = not annotated.'), 'satcat')
  row('attr', D('活跃载荷', 'Active payload'),
    D('OBJECT_TYPE = PAY，且 OPS_STATUS_CODE ∈ {+, P, B, S, X}，且在轨。',
      'OBJECT_TYPE = PAY, OPS_STATUS_CODE in {+, P, B, S, X}, and in orbit.'), 'satcat')

  // ③ 轨道
  row('orbit', D('轨道量来源', 'Source of orbital quantities'),
    D('近 / 远地点、倾角、周期按星历历元处的根数算（a 由平均运动反推，近 / 远地点 = a(1∓e) − Re）；无星历退回编目的整数千米值，成员表逐行标来源。',
      'Perigee, apogee, inclination and period from the elements at the ephemeris epoch (a from mean motion; perigee/apogee = a(1-/+e) - Re); integer-kilometre catalogue values only where no ephemeris exists, with the source marked per row in the member table.'), 'both')
  row('orbit', D('区制判定', 'Regime classification'),
    D('有序 first-match：e ≥ 0.20 → HEO；同步周期（±2% 恒星日）且 e ≤ 0.01 且折叠倾角 < 5° → GEO；同步周期 → IGSO；a ≤ Re + 2000 km → LEO；其余 → MEO。',
      'Ordered first-match: e >= 0.20 -> HEO; synchronous period (within 2% of a sidereal day) with e <= 0.01 and folded inclination < 5 deg -> GEO; synchronous period -> IGSO; a <= Re + 2000 km -> LEO; otherwise MEO.'), 'calc')
  row('orbit', D('区制判定的 e 与 a', 'e and a used for the regime'),
    D('编目行 e = (APOGEE − PERIGEE) / (APOGEE + PERIGEE + 2Re)，a 由 PERIOD 反推；根数为空记「—」。',
      'For catalogue rows e = (APOGEE - PERIGEE) / (APOGEE + PERIGEE + 2Re) and a from PERIOD; rows without elements show an em dash.'), 'calc')
  row('orbit', D('GEO 定点', 'GEO slot'),
    D('星历历元处 SGP4 传播一拍的星下点经度，东经为正、西经为负。',
      'Sub-satellite longitude from a single SGP4 step at the ephemeris epoch; east positive, west negative.'), 'gp')
  if (mode === 'all') {
    row('orbit', D('共位', 'Co-location'),
      D('GEO 定点经度升序相邻差 ≤ 0.2° 的连通分量，且 ≥ 2 颗；跨 ±180° 接缝合并。',
        'Connected components of GEO slot longitudes with adjacent spacing <= 0.2 deg and at least two satellites; merged across the +/-180 deg seam.'), 'gp')
  } else {
    row('orbit', D('轨道面估计', 'Orbital plane estimate'),
      D('折叠倾角按 1° 就近分壳；壳内升交点赤经环向排序，相邻差 > 4° 处切分为面。',
        'Shells by folded inclination rounded to 1 deg; within a shell the RAAN values are sorted around the circle and split wherever the adjacent gap exceeds 4 deg.'), 'gp')
  }

  // ④ 时间：全部相对「基准时刻」，报告第 1 章已给出该时刻
  row('time', D('近 %n 天', 'Last %n days'),
    D('LAUNCH_DATE / DECAY_DATE ≥ 基准时刻 − %n 天，按 UTC 日历日比较（非 24 小时的整数倍）。',
      'LAUNCH_DATE / DECAY_DATE >= reference epoch - %n days, by UTC calendar day (not multiples of 24 hours).'), 'satcat')
  row('time', D('在轨龄', 'Time in orbit'), D('基准时刻 − LAUNCH_DATE，单位天。', 'Reference epoch - LAUNCH_DATE, in days.'), 'satcat')
  row('time', D('历元龄', 'Epoch age'),
    D('基准时刻 − 星历 EPOCH，单位天；中位数与 P90 用最近秩法，不插值。',
      'Reference epoch - ephemeris EPOCH, in days; median and P90 by nearest rank, no interpolation.'), 'gp')

  // ⑤ 归类方法：这两条是近似，单列一类，免得与上面那些「编目自带的事实」混为一谈
  if (mode === 'all') {
    row('group', D('星座名称模式', 'Constellation name pattern'),
      D('按卫星名称前缀归类，一颗星只归第一个命中的模式；与 CelesTrak 的 GROUP 名单不完全等价。',
        'By satellite name prefix, each object assigned to the first matching pattern only; not equivalent to the CelesTrak GROUP lists.'), 'approx')
  } else {
    row('group', D('成员四类', 'Member classification'),
      D('在最新星历中 / 不在星历但编目未陨落（带首次缺席观察时刻）/ 编目已陨落 / 编目查无此号（含自建星座的 NORAD ≥ 900000）。',
        'In the latest ephemeris / absent from it but not decayed per the catalogue (with the first-absence time) / decayed per the catalogue / not found in the catalogue (including user-built NORAD numbers of 900000 and above).'), 'satcat')
    row('group', D('缺席观察时刻', 'First-absence timestamp'),
      D('卫星组存档里记的首次缺席时刻，不是陨落时刻。',
        'The first absence recorded in the satellite group; not a decay time.'), 'group3d')
  }

  // ⑥ 本报告生效的筛选：不筛就不出这一类（没用上的口径不该给读者一行）
  for (const pair of filterLabelRows(o, lang)) {
    list.push([T(CRIT_CAT.filter), pair[0], pair[1], T(CRIT_SRC.opt)])
  }
  if (o.regimes.length) {
    row('filter', D('区制筛选的边界', 'Regime filter boundary'),
      D('按上方「区制判定」比对；区制记「—」的对象不属任一区制，不在本报告的统计范围内。',
        'Matched against the regime classification above; objects shown as an em dash belong to no regime and fall outside this report.'), 'calc')
  }
  if (o.constellations.length) {
    row('filter', D('星座筛选的边界', 'Constellation filter boundary'),
      D('按上方「星座名称模式」归类。',
        'Matched by the constellation name pattern above.'), 'approx')
  }

  return list.map(function (r) { return r.map(function (cell) { return String(cell).replace(/%n/g, String(o.recentDays)) }) })
}

function secAppendix(ctx, no) {
  const { T, used } = ctx
  // ★ 2026-09-17 由 note 升格成正式三线表（占表号「表 N」，与第 7 章 GEO 那几张同一副骨架）：
  //   原先它是「题注即小标题、不编号」的特例，于是全报告只此一张表在正文里引用不到。
  //   升格后附录的代码表号顺延 +1；屏上与 Word 两端各数各的表号，规则同为「非空 table 才计数」。
  //   不给 source：本表第四列逐行标来源（SATCAT 字段 / 由根数算出 / 名称近似 / 报告设置 …），
  //   题注旁再挂一个全局来源标是自相矛盾。
  const blocks = [table({
    tableId: 't.appendix.criteria',
    caption: T(D('口径与判据', 'Definitions and criteria')),
    head: [T(D('类别', 'Category')), T(D('项', 'Item')), T(D('判据', 'Definition')), T(D('数据来源', 'Source'))],
    rows: criteriaRows(ctx),
    align: ['l', 'l', 'l', 'l'],
    widths: [12, 17, 57, 14]
  })]
  const catName = { OWNER: D('所有者', 'Owner'), LAUNCH_SITE: D('发射场', 'Launch site'), OPS_STATUS: D('运行状态', 'Operational status') }
  const namer = { OWNER: ownerName, LAUNCH_SITE: launchSiteName, OPS_STATUS: opsStatusName }
  const codeRows = []
  for (const cat of ['OWNER', 'LAUNCH_SITE', 'OPS_STATUS']) {
    const codes = [...used[cat]].filter((c) => c !== '').sort()
    for (const c of codes) codeRows.push([T(catName[cat]), c, namer[cat](c, ctx.lang)])
  }
  if (codeRows.length) {
    blocks.push(table({
      tableId: 't.appendix.codes', source: 'SATCAT',
      caption: T(D('本报告出现的代码', 'Codes used in this report')),
      head: [T(W.category), T(W.code), T(W.name)],
      rows: codeRows, align: ['l', 'l', 'l']
    }))
  }
  return { key: 'appendix', no, title: T(SEC_TITLE.appendix), blocks }
}

// ===================================================================================
// 收口：纯数据化
// ===================================================================================

// undefined / NaN / ±Infinity / 函数 / Symbol / BigInt 一律落成 null；结构原样保留。
// 为什么不直接 JSON.parse(JSON.stringify(m))：那会把 NaN 悄悄变成 null、把 undefined 的键悄悄删掉，
// 于是「模型里不许有 NaN」这条就永远测不出来。这里显式转，测试再做一次 JSON 往返比对才有意义。
function pure(v) {
  if (v === null) return null
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? v : null
  if (t === 'string' || t === 'boolean') return v
  if (t !== 'object') return null
  if (Array.isArray(v)) {
    const a = new Array(v.length)
    for (let i = 0; i < v.length; i++) a[i] = pure(v[i])
    return a
  }
  const o = {}
  for (const k of Object.keys(v)) o[k] = pure(v[k])
  return o
}
