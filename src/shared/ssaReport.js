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
  histBins, heatGrid, dayMs, asOfMs, windowStartMs, ephemerisCoverage, geoCatalogTally, backdateRows,
  launchCountSeries, yearToDate, recentLaunchEvents, debrisByParent, recentDebris, spatialDensity, geoSegments,
  inOrbitAt, windowFlows, debrisCataloguedBetween, yearByType, catalogCutNorad,
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

// —— 章节标题 ——
// ★ 2026-10-15 二期重排（docs/空间态势报告优化方案_2026-10-15.md §3）：章序按「先结论、再方法、后分项」——
//   关键指标页在最前（ESA《Space Environment Report》的执行摘要位）；原「编目总览」与「轨道区制」并成一章；
//   原「星历时效」是数据质量，并入「数据与方法」；新增「碎片与解体」。章 key 'regime' / 'epoch' 已删。
const SEC_TITLE = {
  summary: D('关键指标', 'Key Figures'),
  meta: D('数据与方法', 'Data and Methods'),
  catalog: D('编目与轨道区制', 'Catalogue and Orbital Regimes'),
  owner: D('所有者', 'Owners'),
  launch: D('发射与陨落', 'Launches and Decays'),
  debris: D('碎片与解体', 'Debris and Fragmentation'),
  constellation: D('大型星座', 'Large Constellations'),
  geo: D('GEO 带', 'The Geostationary Belt'),
  appendix: D('附录', 'Appendix')
}
export const ALL_SECTIONS = ['summary', 'meta', 'catalog', 'owner', 'launch', 'debris', 'constellation', 'geo', 'appendix']

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

  const rawRows = Array.isArray(inp.satcat) ? inp.satcat : []
  const allGp = Array.isArray(inp.gp) ? inp.gp : []
  const groups = Array.isArray(inp.groups) ? inp.groups : []
  const mode = inp.scope === 'groups' ? 'groups' : 'all'
  const o = normOpts(inp.opts)
  const meta = normMeta(inp.dataMeta)
  const asOf = meta.asOf
  // ★ 基准时刻可以早于数据时间（检查器「基准时刻：指定」，如截至月末出月报）：编目按发射 / 陨落日期倒推到
  //   基准时刻（backdateRows），往下所有编目侧统计吃的都是倒推后的这份；为「现在」时原样返回同一个数组。
  //   星历侧取不到历史，按最新的用 —— 回溯生效时附录判据写明（ctx.backdated）。
  const allRows = backdateRows(rawRows, asOfMs(asOf))
  const backdated = allRows !== rawRows
  // 回溯时 allRows 已不含基准之后的发射，新编目碎片的 NORAD 上界从原始编目取（非回溯时恒 ∞）
  const cutNorad = backdated ? catalogCutNorad(rawRows, asOfMs(asOf)) : Infinity

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

  // ★ 回溯时星历只留回溯后编目里有的号：基准之后才发射 / 编目的对象那一刻不存在（编目查无此号的星历条目
  //   一并落选）。不回溯时原样用同一个数组，老报告逐位不变。
  const gpAll = backdated ? allGp.filter((g) => g && idxAll.has(String(g.noradId))) : allGp
  const gpIdxAll = new Map()
  for (const g of gpAll) if (g && g.noradId != null) gpIdxAll.set(String(g.noradId), g)
  // 星座维按编目名归类（GLONASS 的星历名不带 GLONASS），故传全量索引
  const gpConst = filterGp(gpAll, o, idxAll)
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

  const ctx = { lang, en, T, rows, gp, gpAll, gpIdxAll, idx, idxAll, o, meta, asOf, used, mode, scopeGroups, doc, backdated,
    allRows, cutNorad, rawRows,
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
  // 章号只发给真出了的章：筛选感知可能让某一章整章不出（见 skipSec），号不能留空洞
  const push = (build) => {
    const before = new Set(Object.keys(figures))
    const s = build(String(no + 1))
    if (s && s.blocks && s.blocks.length) { no++; sections.push(s); return }
    // 整章没出：它登记过的图一并撤掉，模型里不留孤图
    for (const k of Object.keys(figures)) if (!before.has(k)) delete figures[k]
  }

  if (mode === 'all') {
    // 全量：关键指标 → 数据与方法 → 分项各章 → 附录
    // 关键指标页是前置部分（GB/T 7713.3 附录 A：摘要页属前置部分；样式规范 §D），不编章号、不占正文章号
    if (want('summary')) { const sm = secSummary(ctx, ''); if (sm.blocks.length) sections.push(sm) }
    push((n) => secMeta(ctx, n))
    for (const [key, fn] of [['catalog', secCatalog], ['owner', secOwner], ['launch', secLaunch], ['debris', secDebris],
      ['constellation', secConstellation], ['geo', secGeo]]) {
      if (want(key) && !skipSec(ctx, key)) push((n) => fn(ctx, n, figures))
    }
  } else {
    push((n) => secMeta(ctx, n))
    for (let i = 0; i < groups.length; i++) sections.push(secGroup(ctx, groups[i], i + 1, figures))
  }
  // ★ 附录不占正文章号（两种范围同一条）：按 GB/T 7713.3 §5.2.4 编字母 A / B / C，标题「附录 A　口径与判据」，
  //   表号「表 A1」。卫星组报告的章号是 1 / G1 / G2 / …，附录再拿一个数字号会排成 1 / G1 / G2 / 2。
  if (want('appendix')) sections.push(...secAppendix(ctx))

  const model = {
    kind: 'ssa',
    lang,
    doc,
    // asOfText：基准时刻按显示时区格式化好的串（封面「数据截至」一行与关键指标页用，渲染端不再格式化）
    data: Object.assign({}, meta, { asOfText: fmtTs(meta.asOf, ctx.tz) }),
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

// 表块的版式元数据（样式规范 §E）：
//   headGroups [{ label, from, to }]：分组表头（组名跨 from…to 列，组下短线）；未入组的列表头沉到底行；
//   rowRoles { [ri]: 'total' | 'other' }：合计行（换黑体、上方加线）/ 「其余 N 家」行；
//   blankCols [ci]：这些列的空串印空白不印「—」（判据表的「类别」只在组首行出现）。
function table(t) {
  const b = { type: 'table', tableId: t.tableId, caption: t.caption, source: t.source, head: t.head, rows: t.rows }
  if (t.align) b.align = t.align
  if (t.widths) b.widths = t.widths
  if (t.headGroups && t.headGroups.length) b.headGroups = t.headGroups
  if (t.rowRoles && Object.keys(t.rowRoles).length) b.rowRoles = t.rowRoles
  if (t.blankCols && t.blankCols.length) b.blankCols = t.blankCols
  if (t.capped) b.capped = t.capped
  if (t.emphasisRows && t.emphasisRows.length) b.emphasisRows = t.emphasisRows
  if (t.warnCells && t.warnCells.length) b.warnCells = t.warnCells
  return b
}

// size：成图物理尺寸档（样式规范 §F.1）—— 'std' 160×80 mm / 'tall' 160×110 / 'flat' 160×50。
// 图按档位尺寸画、按档位尺寸放进 Word，不缩放，图内字号恒为 8 pt。
const FIG_SIZES = { std: [160, 80], tall: [160, 110], flat: [160, 50] }
function figure(figures, figId, caption, spec, size) {
  const sz = FIG_SIZES[size] ? size : 'std'
  figures[figId] = { spec, png: null, size: sz, mm: FIG_SIZES[sz].slice() }
  return { type: 'figure', figId, caption, size: sz }
}
// 末行是合计的表
const totalLast = (rows) => ({ [rows.length - 1]: 'total' })

// 首列左对齐、其余右对齐是缺省；这里只在需要把某些列改回左对齐时显式给。
const alignLR = (n, leftCols) => {
  const a = []
  for (let i = 0; i < n; i++) a.push(leftCols.indexOf(i) >= 0 ? 'l' : 'r')
  return a
}

// 读数串：数按细空分组（≥ 1000 即分，与关键指标页 grp 同一规则 —— 同一个量在两处印同一个串；
// 负号 U+2212，样式规范 §E.3），其余原样
const S = (x) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) return String(x == null ? '' : x)
  const a = Math.abs(x)
  const s = String(a)
  const ip = s.split('.')[0]
  const body = ip.length >= 4 ? ip.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009') + s.slice(ip.length) : s
  return (x < 0 ? '\u2212' : '') + body
}
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
      // 回溯时同样给：「卫星编目条数」是原始快照条数，与倒推后各表合计对不上
      (ctx.filtered || ctx.backdated) && [T(D('本报告统计条数', 'Rows covered by this report')),
        `${S(ctx.filterRowsCount)} / ${S(ctx.backdated ? ctx.rawRows.length : ctx.allRowsCount)}`],
      [T(D('近期窗口（天）', 'Recent window (days)')), S(o.recentDays)],
      // 只列本报告里真起作用的参数（照 lbSlaReport 的口径：没用上的参数不该给读者一行）——
      // 逐月 / 排名 / 重点弧段只在全量报告里用；成员表行数只在卫星组报告里用。
      // 用语与检查器同名（2026-10-16 起）：读者对着报告去找设置，找得到同一个词。
      mode === 'all' && [T(D('逐月统计（月）', 'Monthly statistics (months)')), S(o.months)],
      mode === 'all' && [T(D('排名条数', 'Ranking size')), S(o.topN)],
      mode === 'all' && [T(D('GEO 重点弧段', 'GEO focus arc')), arcLabel(o.geoArc)],
      mode === 'groups' && [T(D('成员表行数上限', 'Member table row cap')), S(o.rowCap)],
      [T(D('软件版本', 'Software version')), doc.appVersion || '—'],
      [T(D('生成时刻', 'Generated at')), fmtTs(doc.generatedAt, ctx.tz)]
    ])
  ]
  if (fRows.length) blocks.splice(1, 0, kv(T(D('筛选条件', 'Filter conditions')), fRows))
  // 星历时效是数据质量：全量报告在本章末给一张表（原独立的第 8 章）；卫星组报告的星历龄逐成员在成员表里
  if (mode === 'all') blocks.push(epochTable(ctx))
  return { key: 'meta', no, title: T(SEC_TITLE.meta), blocks }
}

// 区间【右端点】的经度标注：fmtGeoSlot 把经度归一到 (−180,180]，180 会折成 180.0°W，
// 于是最东那个桶会印成「179.0°E – 180.0°W」。右端点单独处理，恒印 180.0°E。
const fmtLonEdge = (x) => (Number(x) >= 180 ? '180.0°E' : fmtGeoSlot(x))
const arcLabel = (arc) => `${fmtGeoSlot(arc[0])} – ${fmtLonEdge(arc[1])}`

// ===================================================================================
// 筛选感知：筛选维度上结构性为零 / 单值的章整章不出（docs/空间态势报告优化方案_2026-10-15.md §3.3）
// ===================================================================================

// 章节在本次筛选下有没有可报的东西。不出的章不占章号（buildSsaModel 的 push）；第 2 章「筛选条件」
// 照常把筛选逐维列出 —— 读者知道这一章为什么没了。
function skipSec(ctx, key) {
  const { o } = ctx
  // 只筛了一家所有者：所有者章就是一行加合计，不成章
  if (key === 'owner') return o.owners.length === 1
  // 类型筛选里没有碎片：碎片章无物可报
  if (key === 'debris') return o.types.length > 0 && o.types.indexOf('DEB') < 0
  // 区制筛选里没有 GEO：GEO 带无物可报
  if (key === 'geo') return o.regimes.length > 0 && o.regimes.indexOf('GEO') < 0
  // 类型筛选里没有载荷：星座只数载荷（constKeyOfRow）
  if (key === 'constellation') return o.types.length > 0 && o.types.indexOf('PAY') < 0
  return false
}

// 数量读数的分组：≥ 1000 的数每三位以 U+2009 细空分组（SI / GB 3101：不用逗号；样式规范 §E.3）。
// 负号用 U+2212。关键指标页的读数串在模型里格式化好（屏上与 Word 同一份串）；表格里的数仍存原值，
// 由渲染端按列格式化（ssaFormat.js）。
const THIN = '\u2009'
const grp = (n) => {
  const a = Math.abs(Math.round(n))
  const s = a >= 1000 ? String(a).replace(/\B(?=(\d{3})+(?!\d))/g, THIN) : String(a)
  return (n < 0 ? '−' : '') + s
}
const signed = (n) => (n > 0 ? '+' + grp(n) : n < 0 ? grp(n) : '0')
// 百分比变化：对照期基数 < 20 只给差值不给百分数（小基数的百分数是噪声），基数为 0 印「—」
const signedPct = (cur, prev) => {
  if (!(prev > 0)) return '—'
  if (prev < 20) return ''
  const p = (cur - prev) / prev * 100
  const s = Math.abs(p).toFixed(1)
  return (p > 0.05 ? '+' : p < -0.05 ? '−' : '') + s + '%'
}

// ===================================================================================
// 1 关键指标（样式规范 §G：前置页，3 行 × 4 格，每格「标签 / 数值 / 对照行」）
// ===================================================================================

// 块型 kpi：{ type: 'kpi', caption, groups: [{ title, refLabel, items: [{ label, value, ref?, delta?, pct?, note? }] }] }
// value / ref / delta / pct / note 都是【已格式化的读数串】—— 渲染端只排版，不再算、不再格式化。
// 对照行三段 = 对照期值 · 带符号差值 · 带符号百分数（年报「本期 / 上年同期 / 增减（%）」压成一行，§G.2）；
// 没有可比对照期的存量（活跃载荷、GEO 带对象）对照行给一个相关读数（note）。纯数字：不染色、不加箭头。
function secSummary(ctx, no) {
  const { T, rows, gp, o, asOf, idxAll, lang } = ctx
  const en = lang === 'en'
  const t = asOfMs(asOf)
  if (!Number.isFinite(t)) return { key: 'summary', no, title: T(SEC_TITLE.summary), blocks: [] }
  const DAY = 86400000
  const d = new Date(t)
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), Dd = d.getUTCDate()
  const day0 = Date.UTC(Y, M, Dd)
  const p2 = (x) => (x < 10 ? '0' + x : String(x))
  const ymd = (ms) => { const x = new Date(ms); return x.getUTCFullYear() + '-' + p2(x.getUTCMonth() + 1) + '-' + p2(x.getUTCDate()) }
  const md = (ms) => ymd(ms).slice(5)
  const withDebris = !(o.types.length && o.types.indexOf('DEB') < 0)
  const withGeo = !(o.regimes.length && o.regimes.indexOf('GEO') < 0)
  const cmp = (label, cur, prev) => ({ label: T(label), value: grp(cur), ref: prev == null ? '—' : grp(prev), delta: prev == null ? '' : signed(cur - prev), pct: prev == null ? '' : signedPct(cur, prev) })
  const groups = []

  // ① 存量：基准日 vs 一年前同日（倒推，inOrbitAt）
  const ov = catalogOverview(rows)
  const yAgo = Date.UTC(Y - 1, M, Dd)
  const g1 = [cmp(D('在轨对象', 'Objects in orbit'), ov.inOrbit, inOrbitAt(rows, yAgo))]
  const payInOrbit = rows.reduce((a, r) => a + (r.type === 'PAY' && isInOrbit(r) ? 1 : 0), 0)
  g1.push({ label: T(D('活跃载荷', 'Active payloads')), value: grp(ov.active), note: T(D('在轨载荷 %n', 'In-orbit payloads %n')).replace('%n', grp(payInOrbit)) })
  if (withDebris) {
    const db = debrisByParent(rows)
    g1.push(cmp(D('在轨碎片', 'Debris in orbit'), db.debrisInOrbit, inOrbitAt(rows, yAgo, 'DEB')))
  }
  if (withGeo) {
    const tally = geoCatalogTally(rows, gp)
    const go = geoOccupancy(gp, idxAll, { arc: o.geoArc })
    g1.push({ label: T(D('GEO 带对象', 'GEO belt objects')), value: grp(tally.catalog), note: T(D('定点解算 %n', 'Resolved slots %n')).replace('%n', grp(go.total)) })
  }
  // ★ 三组标题的日期都是 UTC 日（窗口按 UTC 日历日切），明标 UTC：东八区 0–8 点生成时与封面本地日期差一天
  groups.push({ title: T(D('存量（%d UTC）', 'Stock (%d UTC)')).replace('%d', ymd(day0)), refLabel: T(D('一年前', 'A year earlier')), items: g1 })

  // ② 本年至今 vs 去年同期
  const cur = windowFlows(rows, Date.UTC(Y, 0, 1), t)
  const prev = windowFlows(rows, Date.UTC(Y - 1, 0, 1), Date.UTC(Y - 1, M, Dd))
  groups.push({
    title: T(D('本年至今（%a—%b UTC）', 'Year to date (%a – %b UTC)')).replace('%a', ymd(Date.UTC(Y, 0, 1))).replace('%b', md(day0)),
    refLabel: T(D('%y 年同期', 'Same period %y')).replace('%y', String(Y - 1)),
    items: [cmp(D('发射次数', 'Launches'), cur.launches, prev.launches), cmp(D('入轨载荷', 'Payloads launched'), cur.payloads, prev.payloads),
      cmp(D('陨落对象', 'Objects decayed'), cur.decays, prev.decays), cmp(D('陨落载荷', 'Payloads decayed'), cur.decaysPay, prev.decaysPay)]
  })

  // ③ 近 N 天 vs 前 N 天（窗口与第 5 章同一条：windowStartMs，UTC 日历日）
  const N = o.recentDays
  const from = windowStartMs(t, N)
  const rc = windowFlows(rows, from, t)
  const rp = windowFlows(rows, from - N * DAY, from - DAY)
  const g3 = [cmp(D('发射次数', 'Launches'), rc.launches, rp.launches), cmp(D('入轨载荷', 'Payloads launched'), rc.payloads, rp.payloads),
    cmp(D('陨落对象', 'Objects decayed'), rc.decays, rp.decays)]
  if (withDebris) {
    // 定界走全量（回溯后）编目 + 原始编目的截断号，计数按筛后 rows（同 secDebris）
    const nc = debrisCataloguedBetween(rows, from, t, { boundRows: ctx.allRows, hiNorad: ctx.cutNorad })
    const np = debrisCataloguedBetween(rows, from - N * DAY, from - DAY, { boundRows: ctx.allRows, hiNorad: ctx.cutNorad })
    g3.push(cmp(D('新编目碎片', 'Newly catalogued debris'), nc == null ? 0 : nc, np))
  }
  groups.push({
    // 窗口跨年（如 365 天）印完整日期，否则「10-15—10-15」读不出是一整年
    title: T(D('近 %n 天（%a—%b UTC）', 'Last %n days (%a – %b UTC)')).replace('%n', String(N))
      .replace('%a', new Date(from).getUTCFullYear() === Y ? md(from) : ymd(from))
      .replace('%b', new Date(from).getUTCFullYear() === Y ? md(day0) : ymd(day0)),
    refLabel: T(D('前 %n 天', 'Previous %n days')).replace('%n', String(N)),
    items: g3
  })

  const blocks = [{ type: 'kpi', caption: T(D('基准时刻 %t', 'Reference epoch %t')).replace('%t', fmtTs(asOf, ctx.tz)), groups }]
  return { key: 'summary', no, title: T(SEC_TITLE.summary), blocks }
}

// ===================================================================================
// 3 编目与轨道区制（原「编目总览」「轨道区制」两章合并）
// ===================================================================================

function secCatalog(ctx, no, figures) {
  const { T, rows, o } = ctx
  const ov = catalogOverview(rows)
  const head = [T(W.type), T(W.inOrbit), T(W.decayed), T(W.deepSpace), T(W.total)]
  const body = ov.byType.map((t) => [objectTypeName(t.code, ctx.lang), t.inOrbit, t.decayed, t.deepSpace, t.total])
  body.push([T(W.total), ov.inOrbit, ov.decayed, ov.deepSpace, ov.total])
  const blocks = [
    table({
      tableId: 't.catalog.type', source: 'SATCAT',
      caption: T(D('编目对象按类型与状态分布', 'Catalogued objects by type and state')),
      head, rows: body, align: alignLR(5, [0]), widths: [28, 18, 18, 18, 18], rowRoles: totalLast(body)
    }),
    // 主表里没有的三项轨道类型计数（原「总览读数」里与主表重复的四行删了）
    kv(T(D('轨道类型计数', 'Orbit type counts')), [
      [T(D('停靠（DOC）', 'Docked (DOC)')), S(ov.docked)],
      [T(D('着陆（LAN）', 'Landed (LAN)')), S(ov.landed)],
      [T(D('再入 / 撞击（IMP）', 'Re-entry / impact (IMP)')), S(ov.impacted)]
    ])
  ]

  // 区制 × 类型：筛选生效时删去结构性为零的行（区制筛）与列（类型筛），合计行恒留
  const rt = regimeTable(rows)
  const types = o.types.length ? rt.types.filter((c) => rt.total.byType[c] > 0) : rt.types
  const regRows = o.regimes.length ? rt.rows.filter((r) => r.total > 0) : rt.rows
  // 分组表头：「在轨对象」跨各类型 + 合计，活跃载荷单列（样式规范 §E.2）
  const rHead = [T(W.regime), ...types.map((c) => objectTypeName(c, ctx.lang)), T(W.total), T(W.activePay)]
  const rBody = regRows.map((r) => [r.regime, ...types.map((c) => r.byType[c]), r.total, r.active])
  rBody.push([T(W.total), ...types.map((c) => rt.total.byType[c]), rt.total.total, rt.total.active])
  blocks.push(table({
    tableId: 't.regime.type', source: 'SATCAT',
    caption: T(D('在轨对象按轨道区制与类型分布', 'In-orbit objects by orbital regime and type')),
    head: rHead, rows: rBody, align: alignLR(rHead.length, [0]), rowRoles: totalLast(rBody),
    headGroups: [{ label: T(D('在轨对象', 'Objects in orbit')), from: 1, to: types.length + 1 }]
  }))

  // LEO 空间密度剖面（ESA 空间密度图同一算法口径，见 ssaStats.spatialDensity）
  const sd = spatialDensity(rows, { lo: 200, hi: 2000, step: 25 })
  if (sd.n > 0) {
    const SCALE = 1e8      // 个/km³ 量级 1e-8：按 10⁻⁸ 为单位出数，轴上不出科学计数
    // 按对象类型堆叠（自下而上 载荷 / 火箭体 / 碎片 / 未知，样式规范 §F2.1；密度可加，堆叠在物理上成立）。
    // series.key 是类型码：图按它取全篇固定的类型色（§F.4），不按段序
    const series = sd.types
      .map((ty) => ({ key: ty, name: objectTypeName(ty, ctx.lang), data: sd.density[ty].map((v) => Math.round(v * SCALE * 1000) / 1000) }))
      .filter((x) => x.data.some((v) => v > 0))
    blocks.push(figure(figures, 'f.catalog.density',
      T(D('低轨空间密度剖面（在轨对象，按类型堆叠，%s km 分层）', 'LEO spatial density by object type (in-orbit objects, %s km shells)')).replace('%s', String(sd.step)), {
        type: 'stackhist', bins: sd.bins.map((b) => ({ x0: b.h0, x1: b.h1 })), series,
        xLabel: T(D('高度（km）', 'Altitude (km)')), yLabel: T(D('空间密度（10⁻⁸ 个/km³）', 'Spatial density (10⁻⁸ objects/km³)'))
      }, 'tall'))
  }

  // 倾角 × 平均高度：高度轴取对数（LEO 的密集带在线性 0–40000 km 轴上只占底下三行）
  const pay = rows.filter((r) => isInOrbit(r) && r.type === 'PAY')
  if (pay.length) {
    const hg = heatGrid(pay, { incStep: 5, altMin: 150, altMax: 50000, logAlt: true, altBins: 36 })
    blocks.push(figure(figures, 'f.regime.heat', T(D('在轨载荷的倾角 × 平均高度分布（高度对数分层）', 'In-orbit payloads by inclination and mean altitude (logarithmic altitude bins)')), {
      type: 'heat', xBins: hg.xBins, yBins: hg.yBins, cells: hg.cells, yLog: true,
      xLabel: T(D('倾角（°）', 'Inclination (deg)')), yLabel: T(D('平均高度（km）', 'Mean altitude (km)')), legendLabel: T(W.count)
    }, 'tall'))
  }
  return { key: 'catalog', no, title: T(SEC_TITLE.catalog), blocks }
}

// ===================================================================================
// 4 所有者
// ===================================================================================

function secOwner(ctx, no) {
  const { T, rows, o, used } = ctx
  const ot = ownerTable(rows, { topN: o.topN })
  // 分组表头：「在轨」跨活跃载荷…合计五列，「累计」跨发射 / 陨落两列（样式规范 §E.2）
  const head = [T(W.code), T(W.owner), T(W.activePay), T(D('载荷', 'Payloads')),
    T(D('火箭体', 'Rocket bodies')), T(D('碎片', 'Debris')), T(W.total),
    T(D('发射', 'Launched')), T(D('陨落', 'Decayed'))]
  const body = ot.rows.map((r) => {
    used.OWNER.add(r.owner)
    return [r.owner, ownerName(r.owner, ctx.lang), r.active, r.payloads, r.rockets, r.debris, r.inOrbit, r.launched, r.decayed]
  })
  // 合计是全表口径：榜外各家并成「其余 N 家」一行，合计才等于表内各行之和
  const roles = {}
  if (ot.rest.count > 0) {
    const r = ot.rest
    roles[body.length] = 'other'
    body.push([T(D('其余 %k 家', 'Others (%k)')).replace('%k', String(r.count)), '', r.active, r.payloads, r.rockets, r.debris, r.inOrbit, r.launched, r.decayed])
  }
  body.push([T(W.total), '', ot.total.active, ot.total.payloads, ot.total.rockets, ot.total.debris, ot.total.inOrbit, ot.total.launched, ot.total.decayed])
  // 排名条图 2026-10-15 删：被前两家压扁，其余条读不出，数又全在表里
  const blocks = [
    table({
      tableId: 't.owner.top', source: 'SATCAT',
      caption: T(D('所有者统计（在轨载荷前 %n 位）', 'Owners (top %n by in-orbit payloads)')).replace('%n', String(o.topN)),
      head, rows: body, align: alignLR(head.length, [0, 1]), widths: [8, 24, 9, 9, 8, 8, 9, 13, 12],
      rowRoles: Object.assign(roles, totalLast(body)),
      headGroups: [{ label: T(D('在轨', 'In orbit')), from: 2, to: 6 }, { label: T(D('累计', 'Cumulative')), from: 7, to: 8 }]
    })
  ]
  return { key: 'owner', no, title: T(SEC_TITLE.owner), blocks }
}

// ===================================================================================
// 5 发射与陨落
// ===================================================================================

// 一次发射的「主要载荷」读数：1 颗写名字；多颗写首颗（按 NORAD）+ 颗数
function payloadBrief(e, en) {
  const n = e.payloadNames.length
  if (!n) return '—'
  if (n === 1) return e.payloadNames[0]
  return en ? `${e.payloadNames[0]} (+${n - 1})` : `${e.payloadNames[0]} 等 ${n} 颗`
}

function secLaunch(ctx, no, figures) {
  const { T, rows, o, asOf, used, en } = ctx
  const ms = monthlySeries(rows, { asOf, months: o.months })
  const lc = launchCountSeries(rows, { asOf })
  const cum = inOrbitCumulative(rows, { asOf })
  const rle = recentLaunchEvents(rows, { asOf, days: o.recentDays })
  const rd = recentDecays(rows, { asOf, days: o.recentDays })

  const cumX = cum.months.map((s) => { const p = s.split('-'); return Number(p[0]) + (Number(p[1]) - 1) / 12 })
  // 逐年序列的末年是不完整年（截至基准时刻那天，UTC 日历日）：图上末段另画、题注写截至日期 ——
  // 不标的话末端那一截读起来就是「今年骤降」
  const tAs = asOfMs(asOf)
  const partialTail = (() => {
    if (!Number.isFinite(tAs)) return ''
    const d = new Date(tAs)
    const p2 = (x) => (x < 10 ? '0' + x : String(x))
    const md = p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
    return T(D('（%y 年截至 %md UTC）', ' (%y through %md UTC)')).replace('%y', String(d.getUTCFullYear())).replace('%md', md)
  })()
  // 逐年三图（样式规范 §F2.3）：计数用竖柱、存量用折线；入轨对象按载荷 / 火箭体堆叠，陨落按四类堆叠，
  // 颜色跟类型走（series.key = 类型码）；发射次数不属任何一类，穿石板墨（key 留空）
  const lYt = yearByType(rows, { asOf }, 'launchDate', (r) => r.type === 'PAY' || r.type === 'R/B')
  const dYt = yearByType(rows, { asOf }, 'decayDate', isDecayed)
  const typeSeries = (yt, types) => types.map((ty) => ({ key: ty, name: objectTypeName(ty, ctx.lang), data: yt.byType[ty] })).filter((x) => x.data.some((v) => v > 0))

  const blocks = [
    figure(figures, 'f.launch.count', T(D('逐年发射次数', 'Launches per year')) + partialTail, {
      type: 'col', x: lc.years, xIsYear: true, partialLast: !!partialTail,
      series: [{ key: '', name: T(D('发射次数', 'Launches')), data: lc.counts }],
      xLabel: T(D('年', 'Year')), yLabel: T(D('次数', 'Launches'))
    }, 'std'),
    figure(figures, 'f.launch.year', T(D('逐年入轨对象（按类型）', 'Objects launched per year, by type')) + partialTail, {
      type: 'col', x: lYt.years, xIsYear: true, partialLast: !!partialTail, series: typeSeries(lYt, ['PAY', 'R/B']),
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }, 'std'),
    figure(figures, 'f.decay.year', T(D('逐年陨落对象（按类型）', 'Objects decayed per year, by type')) + partialTail, {
      type: 'col', x: dYt.years, xIsYear: true, partialLast: !!partialTail, series: typeSeries(dYt, ['PAY', 'R/B', 'DEB', 'UNK']),
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }, 'std'),
    figure(figures, 'f.inorbit.cum', T(D('在轨对象数（逐月）', 'Objects in orbit (monthly)')), {
      type: 'line', x: cumX, xIsYear: true,
      series: [{ key: '', name: T(D('在轨对象', 'Objects in orbit')), data: cum.counts }],
      xLabel: T(D('年', 'Year')), yLabel: T(W.count)
    }, 'std'),
    table({
      tableId: 't.launch.monthly', source: 'SATCAT',
      caption: T(D('近 %n 个月逐月发射与陨落', 'Monthly launches and decays over the last %n months')).replace('%n', String(o.months)),
      head: [T(W.months), T(D('次数', 'Launches')), T(D('载荷', 'Payloads')), T(D('载荷与火箭体', 'Payloads and rocket bodies')),
        T(D('载荷', 'Payloads')), T(D('全部对象', 'All objects'))],
      headGroups: [{ label: T(D('发射', 'Launched')), from: 1, to: 3 }, { label: T(D('陨落', 'Decayed')), from: 4, to: 5 }],
      rows: ms.months.map((m, i) => [m, ms.launches[i], ms.launchPay[i], ms.launchPayRb[i], ms.decayPay[i], ms.decayAll[i]]),
      align: alignLR(6, [0]), widths: [16, 14, 16, 22, 16, 16]
    })
  ]
  // 近 N 天发射：按「次」列，一次一行（原 287 行逐对象明细移到附录）
  if (rle.length) {
    blocks.push(table({
      tableId: 't.launch.events', source: 'SATCAT',
      caption: T(D('近 %n 天发射', 'Launches in the last %n days')).replace('%n', String(o.recentDays)),
      head: [T(D('日期', 'Date')), T(W.objectId), T(D('运载火箭', 'Launch vehicle')), T(W.launchSite), T(D('入轨载荷', 'Payloads')),
        T(D('主要载荷', 'Principal payload')), T(W.owner)],
      rows: rle.map((e) => {
        used.LAUNCH_SITE.add(e.site)
        const own = e.owners.map((c) => ownerName(c, ctx.lang))
        const ownText = own.length > 3
          ? own.slice(0, 3).join(en ? ', ' : '、') + (en ? ` and ${own.length - 3} more` : `等 ${own.length} 家`)
          : own.join(en ? ', ' : '、')
        return [e.date, e.key, e.vehicle || '—', launchSiteName(e.site, ctx.lang), e.payloads, payloadBrief(e, en), ownText || '—']
      }),
      align: alignLR(7, [0, 1, 2, 3, 5, 6]), widths: [11, 10, 12, 16, 8, 27, 16]
    }))
  }
  blocks.push(kv(T(D('近 %n 天陨落计数', 'Decays in the last %n days')).replace('%n', String(o.recentDays)), [
    [T(D('载荷', 'Payloads')), S(rd.payloads.length)],
    [T(D('火箭体', 'Rocket bodies')), S(rd.rockets.length)],
    [T(D('碎片', 'Debris')), S(rd.debris)],
    [T(D('其它 / 未知', 'Other / unknown')), S(rd.other)],
    [T(W.total), S(rd.total)]
  ]))
  const dRows = rd.payloads.concat(rd.rockets).map((r) => [r.name, r.objectId, r.norad, ownerName(r.owner, ctx.lang), r.date, objectTypeName(r.type, ctx.lang), r.regime])
  if (dRows.length) {
    blocks.push(table({
      tableId: 't.decay.recent', source: 'SATCAT',
      caption: T(D('近 %n 天陨落明细（载荷与火箭体）', 'Decays in the last %n days (payloads and rocket bodies)')).replace('%n', String(o.recentDays)),
      head: [T(W.name), T(W.objectId), T(W.norad), T(W.owner), T(W.decayDate), T(W.type), T(W.regime)],
      rows: dRows, align: alignLR(7, [0, 1, 3, 4, 5, 6]), widths: [26, 12, 9, 17, 13, 12, 11]
    }))
  }
  return { key: 'launch', no, title: T(SEC_TITLE.launch), blocks }
}

// ===================================================================================
// 6 碎片与解体
// ===================================================================================

function secDebris(ctx, no) {
  const { T, rows, o, asOf } = ctx
  const db = debrisByParent(rows)
  if (!db.debrisTotal) return { key: 'debris', no, title: T(SEC_TITLE.debris), blocks: [] }
  // 定界走全量（回溯后）编目：按所有者 / 类型筛后的 rows 里可能没有窗口内的发射对象
  const rdb = recentDebris(rows, { asOf, days: o.recentDays, boundRows: ctx.allRows, hiNorad: ctx.cutNorad })
  const blocks = [
    kv(T(D('碎片读数', 'Debris')), [
      [T(D('在轨碎片', 'Debris in orbit')), S(db.debrisInOrbit)],
      // debrisByParent 不计深空 / 着陆：与编目表碎片行的「合计 − 深空 / 着陆」相等
      [T(D('累计编目碎片（不含深空 / 着陆）', 'Debris catalogued in total (excl. deep space / landed)')), S(db.debrisTotal)],
      [T(D('产生过碎片的发射', 'Launches with catalogued debris')), S(db.parents)],
      [T(D('近 %n 天新编目碎片', 'Debris newly catalogued in the last %n days')).replace('%n', String(o.recentDays)), S(rdb.total)]
    ]),
    table({
      tableId: 't.debris.parents', source: 'SATCAT',
      caption: T(D('在轨碎片最多的母体（前 %n 位）', 'Parent objects with the most debris in orbit (top %n)')).replace('%n', String(o.topN)),
      head: [T(W.objectId), T(D('母体', 'Parent')), T(W.owner), T(D('发射年', 'Launch year')), T(D('在轨碎片', 'In orbit')),
        T(D('累计编目', 'Catalogued')), T(W.decayed)],
      rows: db.rows.slice(0, o.topN).map((r) => [r.key || '—', r.parent || '—', ownerName(r.owner, ctx.lang), r.year || '—', r.inOrbit, r.total, r.decayed]),
      align: alignLR(7, [0, 1, 2, 3]), widths: [12, 26, 20, 10, 11, 11, 10]
    })
  ]
  if (rdb.rows.length) {
    blocks.push(table({
      tableId: 't.debris.recent', source: 'SATCAT',
      caption: T(D('近 %n 天新编目碎片（按母体）', 'Debris newly catalogued in the last %n days, by parent')).replace('%n', String(o.recentDays)),
      head: [T(W.objectId), T(D('母体', 'Parent')), T(W.owner), T(D('发射年', 'Launch year')), T(D('新编目', 'Newly catalogued')), T(D('其中在轨', 'Of which in orbit'))],
      rows: rdb.rows.map((r) => [r.key || '—', r.parent || '—', ownerName(r.owner, ctx.lang), r.year || '—', r.n, r.inOrbit]),
      align: alignLR(6, [0, 1, 2, 3]), widths: [13, 30, 22, 11, 12, 12]
    }))
  }
  return { key: 'debris', no, title: T(SEC_TITLE.debris), blocks }
}

// ===================================================================================
// 7 大型星座
// ===================================================================================

const shellText = (s) => `${s.altKm} km · ${s.incDeg}° · ${s.n}`

function secConstellation(ctx, no) {
  const { T, rows, gp, asOf, o, idxAll } = ctx
  // ★ 一行里两侧必须同口径：左半边（累计发射 / 在轨 / 活跃 / 累计陨落）来自筛过的编目，右半边
  //   （星历颗数 / 主壳层）来自筛过的星历（ctx.gp，见 buildSsaModel）。
  // ★ 近 N 天窗口与第 5 章同一个参数（近期明细），按 UTC 日历日；星历按编目名归类（idxAll）。
  const cd = constellationDeploy(rows, gp, { asOf, days: o.recentDays, index: idxAll })
  if (!cd.rows.length) return { key: 'constellation', no, title: T(SEC_TITLE.constellation), blocks: [] }
  // 分组表头：「新增发射」跨近 N 天 / 近 365 天，「主壳层（高度 · 倾角 · 颗数）」跨三列（样式规范 §E.2）
  const head = [T(D('星座', 'Constellation')), T(D('累计发射', 'Launched')), T(W.inOrbit), T(D('活跃', 'Active')),
    T(D('近 %n 天', 'Last %n d')).replace('%n', String(o.recentDays)), T(D('近 365 天', 'Last 365 d')), T(D('累计陨落', 'Decayed')),
    T(D('星历颗数', 'Ephemeris')), '1', '2', '3']
  const body = cd.rows.map((r) => [
    T(CONST_NAME[r.key] || D(r.key, r.key)), r.launched, r.inOrbit, r.active, r.recent30, r.recent365, r.decayed, r.gpCount,
    r.shells[0] ? shellText(r.shells[0]) : '—', r.shells[1] ? shellText(r.shells[1]) : '—', r.shells[2] ? shellText(r.shells[2]) : '—'
  ])
  // 排名条图 2026-10-15 删：Starlink 一家把横轴撑满，其余星座的条读不出，数又全在表里
  const blocks = [
    table({
      tableId: 't.const.deploy', source: 'SATCAT+GP',
      caption: T(D('大型星座部署', 'Large constellation deployment')),
      head, rows: body, align: alignLR(head.length, [0, 8, 9, 10]), widths: [10, 7, 6, 6, 6, 6, 6, 7, 15, 15, 16],
      headGroups: [{ label: T(D('新增发射', 'Launched recently')), from: 4, to: 5 }, { label: T(D('主壳层（高度 · 倾角 · 颗数）', 'Main shells (altitude / inclination / count)')), from: 8, to: 10 }]
    })
  ]
  return { key: 'constellation', no, title: T(SEC_TITLE.constellation), blocks }
}

// ===================================================================================
// 8 GEO 带
// ===================================================================================

function secGeo(ctx, no, figures) {
  const { T, gp, rows, idxAll, o } = ctx
  // ★ 统计的那批星是 ctx.gp —— 【筛后】的星历（见 buildSsaModel），故本章跟着「统计范围」走。
  //   共位簇也只在筛后的这批星里连通；要看「别国那颗贴着我停的」，看组章 G.5 的 ±1° 邻星（走全量）。
  // ★ 编目索引只用来【查属性】（所有者 / 状态 / 国际编号），走全量 idxAll，筛选不让「查得到」变成查不到。
  const go = geoOccupancy(gp, idxAll, { binDeg: 1, coloTol: 0.2, arc: o.geoArc, topN: o.topN })
  // 编目侧对账：编目根数判区制（含火箭体 / 碎片 / 失效载荷）与本章定点数（星历判 GEO 且解算成功）分母不同
  const tally = geoCatalogTally(rows, gp)
  // 共位簇只列 ≥ 3 颗：相邻 0.2° 内的两颗大量是巧合（真编目 92 个簇里 51 个是两颗）
  const clusters = go.clusters.filter((c) => c.n >= 3)

  const blocks = [
    kv(T(D('GEO 占用读数', 'GEO occupancy')), [
      [T(D('编目在轨 GEO 对象', 'In-orbit GEO objects in the catalogue')), S(tally.catalog)],
      [T(D('其中有星历', 'Of which with ephemeris')), S(tally.withEphem)],
      [T(D('定点解算成功的 GEO 卫星', 'GEO satellites with a resolved slot')), S(go.total)],
      [T(D('共位簇（≥ 3 颗）', 'Co-located clusters (3+ satellites)')), S(clusters.length)],
      [T(D('重点弧段', 'Focus arc')), arcLabel(o.geoArc)],
      [T(D('重点弧段内卫星', 'Satellites within the focus arc')), S(go.arc.n)]
    ]),
    figure(figures, 'f.geo.strip', T(D('GEO 定点经度占用（1° 分箱）', 'GEO longitude slot occupancy (1-degree bins)')), {
      type: 'strip', bins: go.bins,
      bands: [{ from: o.geoArc[0], to: o.geoArc[1], label: arcLabel(o.geoArc) }],
      xLabel: T(D('定点经度（°）', 'Slot longitude (deg)')), yLabel: T(W.count)
    }, 'flat'),
    // 10° 经度段：全程 36 段固定行，逐版可对照（原「1° 桶前 N 位」只覆盖最挤的十几格，且并列处截断）
    table({
      tableId: 't.geo.seg', source: 'SATCAT+GP',
      caption: T(D('GEO 定点按 10° 经度段分布', 'GEO slots by 10-degree longitude segment')),
      head: [T(W.lonRange), T(D('卫星数', 'Satellites')), T(D('其中活跃', 'Of which active'))],
      rows: geoSegments(go.sats, 10).map((s) => [`${fmtGeoSlot(s.from)} – ${fmtLonEdge(s.to)}`, s.n, s.active]),
      align: ['l', 'r', 'r'], widths: [50, 25, 25]
    })
  ]
  if (clusters.length) {
    blocks.push(table({
      tableId: 't.geo.colo', source: 'SATCAT+GP',
      caption: T(D('共位簇（相邻定点经度差 ≤ %t°，≥ 3 颗）', 'Co-located clusters (adjacent slot spacing <= %t deg, 3+ satellites)')).replace('%t', String(go.coloTol)),
      head: [T(W.lonRange), T(W.count), T(W.sats)],
      rows: clusters.map((c) => [`${fmtGeoSlot(c.lonFrom)} – ${fmtGeoSlot(c.lonTo)}`, c.n, c.sats.map((s) => s.name).join(ctx.en ? ', ' : '、')]),
      align: ['l', 'r', 'l'], widths: [22, 8, 70]
    }))
  }
  // 重点弧段清单：所有者印名称（代码列 2026-10-15 删，与名称二选一）
  const arcRows = go.arc.sats.map((s) => [s.name, s.norad, s.slot, ownerName(s.owner, ctx.lang), opsStatusName(s.status, ctx.lang)])
  if (arcRows.length) {
    blocks.push(table({
      tableId: 't.geo.arc', source: 'SATCAT+GP',
      caption: T(D('重点弧段 %a 内的卫星', 'Satellites within the focus arc %a')).replace('%a', arcLabel(o.geoArc)),
      head: [T(W.name), T(W.norad), T(W.slot), T(W.owner), T(W.status)],
      rows: arcRows, align: alignLR(5, [0, 2, 3, 4]), widths: [32, 10, 12, 26, 20]
    }))
  }
  return { key: 'geo', no, title: T(SEC_TITLE.geo), blocks }
}

// ===================================================================================
// 星历时效（并入「数据与方法」一章；原第 8 章）
// ===================================================================================

// ★ 首行是「星历并集」，不是「全部在轨」：GP 并集几乎只有活跃载荷（真编目：16717 条 vs 在轨 35026，
//   碎片覆盖 2 / 12549）。另给「在轨覆盖率」一列，分子分母见 ssaStats.ephemerisCoverage。
// 历元龄直方图 2026-10-15 删：98% 的对象挤在前两箱，信息全在表里的中位数 / P90 / 最大。
function epochTable(ctx) {
  const { T, gp, asOf, rows, idxAll } = ctx
  // 回溯时历元龄按星历数据时间计：星历是最新的那一份，拿过去的基准时刻去减会得出负龄
  const ea = epochAgeStats(gp, (ctx.backdated && ctx.meta.gpAt) || asOf, idxAll)
  const cov = ephemerisCoverage(rows, gp, idxAll)
  const head = [T(D('范围', 'Scope')), T(W.count), T(D('中位数（天）', 'Median (d)')), T(D('P90（天）', 'P90 (d)')),
    T(D('最大（天）', 'Max (d)')), T(D('> 7 天颗数', 'Older than 7 d')), T(D('在轨覆盖率', 'In-orbit coverage'))]
  const body = []
  const warn = []
  const push = (label, s, c) => {
    const r = body.length
    body.push([label, s.n, s.median, s.p90, s.max, s.stale, c && c.ratio != null ? pctStr(c.ratio, 1) : '—'])
    for (const ci of [2, 3, 4]) { const v = body[r][ci]; if (typeof v === 'number' && v > 7) warn.push([r, ci]) }
  }
  push(T(D('星历并集', 'Ephemeris union')), ea.overall, cov.overall)
  for (const c of ea.byConst) push(T(CONST_NAME[c.key] || D(c.key, c.key)), c, cov.byConst[c.key])
  return table({
    tableId: 't.epoch.age', source: 'GP',
    caption: T(D('星历历元龄与在轨覆盖率', 'Ephemeris epoch age and in-orbit coverage')),
    head, rows: body, align: alignLR(7, [0]), warnCells: warn, widths: [22, 12, 13, 12, 12, 14, 15]
  })
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
  // 题注不带「G1.n」前缀：表号 / 图号由两端按章编号（原先印成「表 G1-2　G1.3 轨道面估计」）
  const P = (n, d) => T(d)
  // ★ 回溯时基准之后发射 / 编目的成员（原始编目有、倒推后编目没有）剔除，另记一个数：那一刻它不存在，
  //   与报告其余各章「之后发射的不计」同一口径；留着会被判成「编目查无此号」或带最新星历的负历元龄。
  let lateN = 0
  if (ctx.backdated) {
    const idxRaw = ctx.idxRaw || (ctx.idxRaw = buildIndex(ctx.rawRows))
    const keep = []
    for (const s of ((group && group.sats) || [])) {
      const id = String((s && s.id) != null ? s.id : '').trim()
      if (id && idxRaw.has(id) && !idxAll.has(id)) lateN++
      else keep.push(s)
    }
    if (lateN) group = Object.assign({}, group, { sats: keep })
  }
  const res = groupResolve(group, gpIdxAll, idxAll)
  // 历元龄基准与全量星历表（epochTable）同口径：回溯时按星历数据时间
  const members = groupMembers(group, gpIdxAll, idxAll, { asOf, epochAt: (ctx.backdated && ctx.meta.gpAt) || asOf })
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
      lateN > 0 && [T(D('基准时刻之后发射（未计入）', 'Launched after the reference epoch (not counted)')), S(lateN)],
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
    // 所有者 / 状态 / 类型三列一律印名称（2026-10-15：原先状态印代码、类型印中文，同一张表两种口径）
    return [m.name, m.id, m.objectId, m.owner ? ownerName(m.owner, ctx.lang) : '', m.launchDate, N(m.ageDays), m.status ? opsStatusName(m.status, ctx.lang) : '',
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
  // ★ 只取「在最新星历中 / 缺席」两类：已陨落成员的编目根数是它再入前最后一次的值（142 km 那种），
  //   混进来的是一颗不在天上的星；查无此号的本就没有根数。
  const live = members.filter((m) => m.cls === 'inGp' || m.cls === 'absent')
  const pc = planeClusters(live, { incTol: 1, raanTol: 4, minShell: 3 })
  // 没有够格的壳（全是 GEO / 每壳不足 3 颗）就不出这张表：结构性为空，不留一张「暂无数据」的空表
  if (pc.shells.length) blocks.push(table({
    tableId: 't.' + gid + '.planes', source: 'GP',
    caption: P(3, D('轨道面估计（升交点赤经聚类）', 'Orbital plane estimate (RAAN clustering)')),
    head: [T(D('倾角（°）', 'Inclination (deg)')), T(D('高度（km）', 'Altitude (km)')), T(W.count), T(D('面数', 'Planes')),
      T(D('每面颗数', 'Per plane')), T(D('面间平均间隔（°）', 'Mean plane spacing (deg)')), T(D('最小（°）', 'Min (deg)')), T(D('最大（°）', 'Max (deg)'))],
    rows: pc.shells.map((s) => [N(s.inclDeg), N(s.altKm), s.n, s.planeCount, `${s.perPlaneMin}–${s.perPlaneMax}`, N(s.spacingDeg), N(s.spacingMinDeg), N(s.spacingMaxDeg)]),
    align: alignLR(8, [4])
  }))
  // 高度分布按区制各一张：LEO 550 km 与 GEO 35786 km 同一条线性轴，箱宽被撑到上千千米，
  // LEO 成员全挤在一根柱里（真编目审查：Starlink + 北斗 GEO 的组）
  const altOf = (m) => (Number.isFinite(m.perigeeKm) && Number.isFinite(m.apogeeKm) ? (m.perigeeKm + m.apogeeKm) / 2 : NaN)
  const altByRegime = new Map()
  for (const m of live) {
    const a = altOf(m)
    if (!Number.isFinite(a)) continue
    if (!altByRegime.has(m.regime)) altByRegime.set(m.regime, [])
    altByRegime.get(m.regime).push(a)
  }
  const regimeSeq = REGIME_ORDER.filter((rg) => altByRegime.has(rg)).concat([...altByRegime.keys()].filter((rg) => REGIME_ORDER.indexOf(rg) < 0).sort())
  for (const rg of regimeSeq) {
    blocks.push(figure(figures, 'f.' + gid + '.alt.' + rg, P(3, D('平均高度分布（%r）', 'Mean altitude distribution (%r)')).replace('%r', rg), altHistSpec(ctx, altByRegime.get(rg)), 'std'))
  }
  blocks.push(figure(figures, 'f.' + gid + '.incl', P(3, D('倾角分布（5° 分箱）', 'Inclination distribution (5-degree bins)')), {
    type: 'hist', bins: histBins(live.map((m) => m.inclDeg), 0, 180, 5).bins,
    xLabel: T(D('倾角（°）', 'Inclination (deg)')), yLabel: T(W.count)
  }, 'std'))
  blocks.push(figure(figures, 'f.' + gid + '.scatter', P(3, D('升交点赤经 × 倾角', 'RAAN vs inclination')), scatterSpec(ctx, live), 'std'))

  // —— G.4 变化 ——
  // 窗口与第 5 章同一条（windowStartMs：按 UTC 日历日）
  const t = asOfMs(asOf)
  const from = windowStartMs(t, o.recentDays)
  const recent = Number.isFinite(t)
    ? members.filter((m) => { const ms = dayMs(m.launchDate); return Number.isFinite(ms) && ms >= from && ms <= t })
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
        return [m.name, m.id, m.geoSlot, m.owner ? ownerName(m.owner, ctx.lang) : '', m.status ? opsStatusName(m.status, ctx.lang) : '', txt]
      }),
      align: alignLR(6, [0, 1, 2, 3, 4, 5])
    }))
    blocks.push(figure(figures, 'f.' + gid + '.strip', P(5, D('本组 GEO 定点在经度条带上的位置', 'Group GEO slots on the longitude strip')), {
      type: 'strip',
      bins: geoStripBins(geoMembers),
      marks: geoMembers.map((m) => ({ lon: m.lon, label: m.name })),
      xLabel: T(D('定点经度（°）', 'Slot longitude (deg)')), yLabel: T(W.count)
    }, 'flat'))
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
  group3d: D('卫星组存档', 'Satellite group record'),
  gpSatcat: D('GP 星历 + SATCAT 字段', 'GP ephemeris + SATCAT fields')
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
      D('GEO 定点经度升序相邻差 ≤ 0.2° 的连通分量，且 ≥ 3 颗；跨 ±180° 接缝合并。',
        'Connected components of GEO slot longitudes with adjacent spacing <= 0.2 deg and at least three satellites; merged across the +/-180 deg seam.'), 'gp')
    row('orbit', D('空间密度', 'Spatial density'),
      D('在轨对象按开普勒轨道在各高度壳层的停留时间比例摊分（r = a(1 − e·cosE)，近远地点取 PERIGEE / APOGEE），除以壳层体积 4/3·π·(R₂³ − R₁³)；Re = 6378.137 km。',
        'Each in-orbit object distributed over altitude shells by the fraction of time spent in them on its Keplerian orbit (r = a(1 - e cosE), perigee and apogee from PERIGEE / APOGEE), divided by the shell volume 4/3 pi (R2^3 - R1^3); Re = 6378.137 km.'), 'calc')
    row('orbit', D('高度对数分层', 'Logarithmic altitude bins'),
      D('平均高度 150–50000 km 按对数等分 36 层；倾角 5° 分箱。',
        'Mean altitude from 150 to 50000 km in 36 logarithmically equal bins; inclination in 5 deg bins.'), 'calc')
    row('orbit', D('GEO 经度段', 'GEO longitude segments'),
      D('定点经度自 180°W 起每 10° 一段，共 36 段；「其中活跃」按 OPS_STATUS_CODE ∈ {+, P, B, S, X}。',
        'Slot longitudes in 36 segments of 10 deg from 180 deg W; "of which active" by OPS_STATUS_CODE in {+, P, B, S, X}.'), 'gpSatcat')
    row('orbit', D('主壳层', 'Main shells'),
      D('星座在星历中的成员按（a − Re）25 km × 倾角 1° 分桶，取颗数前 3 的桶，印桶下边界 · 颗数。',
        'Constellation members in the ephemeris binned by (a - Re) in 25 km x inclination in 1 deg; the three most populated bins, shown as lower bin edges and count.'), 'calc')
  } else {
    row('orbit', D('轨道面估计', 'Orbital plane estimate'),
      D('在星历中与缺席两类成员，GEO 成员除外：折叠倾角按 1° 就近分壳，不足 3 颗的壳不列；壳内升交点赤经环向排序，相邻差 > 4° 处切分为面；只有一个面的壳不给面间间隔。',
        'Members in the ephemeris or absent from it, GEO members excluded: shells by folded inclination rounded to 1 deg, shells with fewer than 3 members omitted; within a shell the RAAN values are sorted around the circle and split wherever the adjacent gap exceeds 4 deg; no plane spacing for single-plane shells.'), 'gp')
  }

  // 星历侧：并集怎么来的、覆盖了多少在轨对象
  row('orbit', D('星历并集', 'Ephemeris union'),
    D('各星历组按 NORAD 去重，同号取历元最新的一条。',
      'Ephemeris groups merged by NORAD number; for duplicates the record with the latest epoch is kept.'), 'gp')
  row('orbit', D('在轨覆盖率', 'In-orbit coverage'),
    D('星历并集中编目判为在轨的条目数 ÷ 本报告范围内编目在轨对象数；星座行的分子分母只计该星座载荷。',
      'Ephemeris records whose catalogue entry is in orbit / in-orbit catalogue objects within this report; for constellation rows both counts are limited to that constellation’s payloads.'), 'gpSatcat')

  // ④ 时间：全部相对「基准时刻」，报告第 1 章已给出该时刻
  row('time', D('近 %n 天', 'Last %n days'),
    D('LAUNCH_DATE / DECAY_DATE ≥ 基准时刻所在 UTC 日的零时 − %n 天（按 UTC 日历日，非 24 小时的整数倍）；近 365 天同此口径。',
      'LAUNCH_DATE / DECAY_DATE >= 00:00 UTC of the reference day - %n days (by UTC calendar day, not multiples of 24 hours); the last 365 days likewise.'), 'satcat')
  row('time', D('逐年与逐月发射', 'Launches by year and month'),
    D('计 OBJECT_TYPE ∈ {PAY, R/B} 的 LAUNCH_DATE；碎片的 LAUNCH_DATE 为母体发射日，不计入发射。逐年与逐月陨落计全部已陨落对象的 DECAY_DATE。逐年序列末年截至基准时刻所在 UTC 日。',
      'LAUNCH_DATE of objects with OBJECT_TYPE in {PAY, R/B}; debris carry the parent’s launch date and are not counted as launches. Decays by year and month count the DECAY_DATE of all decayed objects. The last year of the annual series runs to the reference day (UTC).'), 'satcat')
  if (mode === 'all') {
    row('time', D('发射次数', 'Launch count'),
      D('国际编号的年份与序号（YYYY-NNN）去重，一个编号计一次发射；只由碎片构成的编号不计。',
        'International designators de-duplicated on year and launch number (YYYY-NNN), one launch per designator; designators carried only by debris are not counted.'), 'satcat')
    row('time', D('本年至今与同期', 'Year to date and same period'),
      D('本年 1 月 1 日至基准时刻所在 UTC 日；同期为上一年 1 月 1 日至同月同日。',
        '1 January of the current year to the reference day (UTC); the same period is 1 January to the same month and day of the previous year.'), 'satcat')
  }
  if (ctx.backdated) {
    row('time', D('基准时刻回溯', 'Back-dated reference epoch'),
      D('基准时刻早于数据时间：编目按 LAUNCH_DATE / DECAY_DATE 倒推到基准时刻（之后发射的不计，NORAD 编号不小于基准时刻之后首个发射对象的碎片不计，之后陨落的按在轨计，其运行状态记 ?；其余字段取最新编目值）。星历只留倒推后编目中有的编号，根数取最新星历（GEO 定点、历元龄、在轨覆盖率、主壳层）；历元龄按星历数据时间计。卫星组中基准时刻之后发射的成员不计。',
        'Reference epoch earlier than the data time: the catalogue is rolled back by LAUNCH_DATE / DECAY_DATE (later launches excluded, debris numbered at or above the first object launched after the reference epoch excluded, later decays counted as in orbit with status ?; other fields from the latest catalogue). Ephemeris records are kept only for numbers in the rolled-back catalogue, with elements from the latest ephemeris (GEO slots, epoch age, in-orbit coverage, main shells); epoch age is measured from the ephemeris data time. Group members launched after the reference epoch are not counted.'), 'satcat')
  }
  row('time', D('在轨龄', 'Time in orbit'), D('基准时刻（已陨落对象取 DECAY_DATE）− LAUNCH_DATE，单位天。', 'Reference epoch (DECAY_DATE for decayed objects) - LAUNCH_DATE, in days.'), 'satcat')
  row('time', D('历元龄', 'Epoch age'),
    D('基准时刻 − 星历 EPOCH，单位天；中位数与 P90 用最近秩法，不插值。',
      'Reference epoch - ephemeris EPOCH, in days; median and P90 by nearest rank, no interpolation.'), 'gp')
  row('time', D('历元龄超限', 'Stale epoch'),
    D('历元龄 > 7 天的计入「> 7 天颗数」。',
      'Records with an epoch age above 7 days are counted under "Older than 7 d".'), 'gp')

  // ⑤ 归类方法：这两条是近似，单列一类，免得与上面那些「编目自带的事实」混为一谈
  if (mode === 'all') {
    row('group', D('碎片母体', 'Debris parent'),
      D('OBJECT_TYPE = DEB 按国际编号的发射部分（YYYY-NNN）归并；母体名取碎片名去掉「DEB」后的众数。',
        'Objects with OBJECT_TYPE = DEB grouped by the launch part of the international designator (YYYY-NNN); the parent name is the most frequent debris name with "DEB" removed.'), 'satcat')
    row('group', D('近 %n 天新编目碎片', 'Debris newly catalogued in the last %n days'),
      D('NORAD 编号不小于窗口内首个新发射对象（载荷或火箭体）的编号、且小于基准时刻之后首个发射对象的编号；编号按编目先后分配，以此近似编目时间；界取全量编目，不随筛选。窗口内无发射时不出。',
        'NORAD number not below that of the first object (payload or rocket body) launched in the window and below that of the first object launched after the reference epoch; numbers are assigned in cataloguing order and stand in for the cataloguing date; the bounds come from the full catalogue regardless of filters. Not given when the window has no launch.'), 'approx')
    row('group', D('星座名称模式', 'Constellation name pattern'),
      D('OBJECT_TYPE = PAY 且卫星名称前缀命中，一颗星只归第一个命中的模式；星历条目按编目中的名称归类（编目查无此号时按星历名）；与 CelesTrak 的 GROUP 名单不完全等价。',
        'OBJECT_TYPE = PAY with a matching name prefix, each object assigned to the first matching pattern only; ephemeris records classified by their catalogue name (by the ephemeris name when absent from the catalogue); not equivalent to the CelesTrak GROUP lists.'), 'approx')
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

// 同一类别连续几行：类别名只在组首行出现，后续行留空（blankCols 让空串印空白而不是「—」），
// 组首行标 'group'（渲染端在它前面加 3 pt 段前距）。样式规范 §E.4、§H.1。
function groupFirstCol(rows) {
  const roles = {}
  let prev = null
  const out = rows.map((r, i) => {
    if (r[0] !== prev) { prev = r[0]; if (i > 0) roles[i] = 'group'; return r }
    return [''].concat(r.slice(1))
  })
  return { rows: out, roles }
}

// 参考文献（附录 C，GB/T 7714—2015 顺序编码制）：数据源与算法的出处。条目是著录信息，不翻译。
const REFERENCES = [
  'KELSO T S. SATCAT format documentation[EB/OL]. CelesTrak. https://celestrak.org/satcat/satcat-format.php.',
  'KELSO T S. A new way to obtain GP data (aka TLEs)[EB/OL]. CelesTrak. https://celestrak.org/NORAD/documentation/gp-data-formats.php.',
  'CCSDS. Orbit data messages: CCSDS 502.0-B-3[S]. Washington, DC: CCSDS Secretariat, 2023.',
  'VALLADO D A, CRAWFORD P, HUJSAK R, et al. Revisiting spacetrack report #3[C]//AIAA/AAS Astrodynamics Specialist Conference and Exhibit. Keystone: AIAA, 2006: AIAA 2006-6753.',
  'ESA Space Debris Office. ESA\u2019s annual space environment report: GEN-DB-LOG-00288-OPS-SD[R]. Darmstadt: ESA/ESOC, 2026.'
]

// 附录（样式规范 §H、GB/T 7713.3 §5.2.4）：拆成三篇，各自另起一页、表号按附录字母编（表 A1 / 表 B1）。
//   A　口径与判据　B　代码表（本报告出现过的代码）　C　参考文献
// 章 key 'appendix' 仍是检查器里那一个开关（三篇同进同出）；后两篇 key 带后缀。
function secAppendix(ctx) {
  const { T, used } = ctx
  const out = []
  // ★ 2026-09-17 由 note 升格成正式三线表：占表号；不给 source —— 第四列逐行标来源，题注旁再挂全局来源标是自相矛盾。
  const crit = groupFirstCol(criteriaRows(ctx))
  out.push({
    key: 'appendix', no: 'A', appendix: true, title: T(D('口径与判据', 'Definitions and criteria')),
    blocks: [table({
      tableId: 't.appendix.criteria',
      caption: T(D('口径与判据', 'Definitions and criteria')),
      head: [T(D('类别', 'Category')), T(D('项', 'Item')), T(D('判据', 'Definition')), T(D('数据来源', 'Source'))],
      rows: crit.rows, rowRoles: crit.roles, blankCols: [0],
      align: ['l', 'l', 'l', 'l'],
      widths: [12, 17, 57, 14]
    })]
  })
  const catName = { OWNER: D('所有者', 'Owner'), LAUNCH_SITE: D('发射场', 'Launch site'), OPS_STATUS: D('运行状态', 'Operational status') }
  const namer = { OWNER: ownerName, LAUNCH_SITE: launchSiteName, OPS_STATUS: opsStatusName }
  const codeRows = []
  for (const cat of ['OWNER', 'LAUNCH_SITE', 'OPS_STATUS']) {
    const codes = [...used[cat]].filter((c) => c !== '').sort()
    for (const c of codes) codeRows.push([T(catName[cat]), c, namer[cat](c, ctx.lang)])
  }
  if (codeRows.length) {
    const g = groupFirstCol(codeRows)
    out.push({
      key: 'appendix-b', no: 'B', appendix: true, title: T(D('代码表', 'Code tables')),
      blocks: [table({
        tableId: 't.appendix.codes', source: 'SATCAT',
        caption: T(D('本报告出现的代码', 'Codes used in this report')),
        head: [T(W.category), T(W.code), T(W.name)],
        rows: g.rows, rowRoles: g.roles, blankCols: [0], align: ['l', 'l', 'l'], widths: [18, 14, 68]
      })]
    })
  }
  out.push({
    key: 'appendix-c', no: out.length === 2 ? 'C' : 'B', appendix: true, title: T(D('参考文献', 'References')),
    blocks: [{ type: 'refs', items: REFERENCES.slice() }]
  })
  return out
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
