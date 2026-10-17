// 独立《容量汇总》报告的模型（渲染端组装，纯数据）。GSO / NGSO / 再生式三窗共用。
//
// 与 lbReport.js 的分工同 lbSlaReport.js：那边是【链路预算报告】的模型（§2 只嵌一张逐转发器矩阵），
// 这边单出容量那一份——不取图、不组瀑布、不带输入清单。两个渲染器（reportCap.js / reportCapDocx.js）
// 只认这里排好的字，不各带一份字典、不另算一个数。
//
// 口径：
//   ① 账目一律出自 lbCapacity.buildCapModel（与「导出 › 容量」弹窗同一份：列入 / 载波数 / 可用资源 / 单价都在里头），
//      本文件只排版：矩阵走 capReportBlock（与总报告 §2 同一张表），明细走 capDetailBlock；
//   ② 明细只列【列入且算出结果】的链路——未列入 / 计算失败的只在「汇总范围」里报编号，不进账；
//   ③ 链路编号用导出流程给的全篇 #N（noOf），与总报告、SLA 报告同一套编号；
//   ④ 纯数字：定义与计算式可以成段写（报告是交付文档不是界面），但不出「达标 / 受限」一类文字判定（见仓库根 CLAUDE.md）。
import { labelBundle, schemeOf, schemeName, schemeSub, defaultDocInfo, translate } from './lbReport.js'
import { CAP_PBW, CAP_DEC, capUnits, capFx, capReportBlock, capMembersText } from './lbCapacity.js'

/** 报告名：与弹窗同名（「容量汇总」），前缀卫星与频段 */
export function capReportTitle(satName, band, lang) {
  const en = lang === 'en'
  const sat = String(satName || '').trim()
  const bd = String(band || '').trim()
  if (en) {
    const head = [sat && sat + ' Satellite', bd && bd + '-Band'].filter(Boolean).join(' ')
    return (head ? head + ' ' : 'Satellite ') + 'Capacity Summary'
  }
  const head = [sat && sat + ' 卫星', bd && bd + ' 频段'].filter(Boolean).join(' ')
  return (head || '卫星') + '容量汇总'
}

// 这份报告自己的章名与栏名（按 lang 出好随模型走）。再生式的分组是「模块 × 卫星」不是转发器，章名随之换说法
function capLabels(pbw, lang) {
  const en = lang === 'en'
  const L = (zh, e) => (en ? e : zh)
  const tp = pbw !== CAP_PBW.NONE
  return {
    capReport: L('容量汇总', 'Capacity Summary'),
    capScope: L('汇总范围', 'Scope'),
    capMatrix: tp ? L('转发器资源汇总', 'Transponder Resource Summary') : L('资源汇总', 'Resource Summary'),
    capDetail: tp ? L('逐转发器明细', 'Per-Transponder Details') : L('逐组明细', 'Per-Group Details'),
    capDefs: L('计算口径', 'Conventions'),
    capTerm: L('参数', 'Parameter'), capDefinition: L('定义', 'Definition'), capFormula: L('计算式', 'Formula')
  }
}

// ============ 逐转发器明细 ============
/**
 * 一组一张表：# · 链路 · 载波 · 载波数 · 容量 · 载波带宽 · [功率带宽] · 带宽占用 · [功率占用]，
 * 组内逐链路一行，组末「小计 / 可用 / 剩余」（同弹窗）。功率两列按体制：'sum' 组内求和、'list' 只逐行、'none' 不出。
 * 数按单位档格式化好（整张账共一档，同 capReportBlock），组内没有列入链路的组不出。
 * @returns [{ key, name, tpBwMHz, head, align, rows, keyRows }]
 */
export function capDetailBlock(model, { lang = 'zh', adaptive = false, noOf = null } = {}) {
  if (!model || !Array.isArray(model.groups)) return []
  const en = lang === 'en'
  const L = (zh, e) => (en ? e : zh)
  const u = capUnits(model, adaptive)
  const hasPw = model.pbw !== CAP_PBW.NONE
  const sumPw = model.pbw === CAP_PBW.SUM
  const wrap = (unit) => (en ? ` (${unit})` : `（${unit}）`)
  const B = (v) => capFx(v != null ? v * u.bw.f : v, CAP_DEC.bw)
  const C = (v) => capFx(v != null ? v * u.cap.f : v, CAP_DEC.cap)
  const P = (v) => capFx(v, CAP_DEC.pct)
  const pw = (v) => (hasPw ? [v] : [])
  const head = [
    '#', L('链路', 'Link'), L('载波', 'Carrier'), L('载波数', 'Carriers'),
    L('容量', 'Capacity') + wrap(u.cap.unit), L('载波带宽', 'Allocated BW') + wrap(u.bw.unit),
    ...pw(L('功率带宽', 'Power BW') + wrap(u.bw.unit)),
    L('带宽占用', 'Bandwidth Usage') + wrap('%'), ...pw(L('功率占用', 'Power Usage') + wrap('%'))
  ]
  const align = ['left', 'left', 'left', ...head.slice(3).map(() => 'right')]
  const out = []
  for (const g of model.groups) {
    const rs = g.rows.filter((r) => r.on && r.ok)
    if (!rs.length) continue
    const rows = [], keyRows = []
    for (const r of rs) {
      const no = typeof noOf === 'function' ? noOf(r.rowId) : null
      rows.push(['#' + (Number.isFinite(no) ? no : r.no), r.name || '—', r.carrier || '—', String(r.n),
        C(r.capKbps), B(r.bwKHz), ...pw(B(r.pbwKHz)), P(r.bwPct), ...pw(P(r.pwPct))])
      keyRows.push(false)
    }
    rows.push(['', L('小计', 'Subtotal'), '', String(g.n), C(g.capKbps), B(g.bwKHz),
      ...pw(sumPw ? B(g.pbwKHz) : ''), P(g.bwPct), ...pw(sumPw ? P(g.pwPct) : '')])
    keyRows.push(true)
    if (g.availBwKHz != null) {
      rows.push(['', L('可用', 'Available'), '', '', '', B(g.availBwKHz), ...pw(sumPw ? B(g.availPwKHz) : ''), '', ...pw('')])
      rows.push(['', L('剩余', 'Remaining'), '', '', '', B(g.remBwKHz), ...pw(sumPw ? B(g.remPwKHz) : ''), '', ...pw('')])
      keyRows.push(false, false)
    }
    out.push({ key: g.key, name: g.name || '—', tpBwMHz: g.tpBwMHz > 0 ? g.tpBwMHz : null, head, align, rows, keyRows })
  }
  return out
}

// ============ 计算口径 ============
// 只列这份报告里真出现的量：再生式没有功率两列、没给单价就没有资费三行、只有一组就没有合计。
// 计算式的符号与矩阵 / 明细的栏名同名（读者拿表里的数代进来就能复算）。
export function capDefinitions(pbw, o, lang) {
  o = o || {}
  const en = lang === 'en'
  const L = (zh, e) => (en ? e : zh)
  const sum = pbw === CAP_PBW.SUM
  const hasPw = pbw !== CAP_PBW.NONE
  const D = (term, def, fml) => ({ term, definition: def, formula: fml })
  const out = [
    D(L('容量', 'Capacity'), L('一行链路所代表的各路同型载波的信息容量之和。', 'Information capacity of all identical carriers the link row stands for.'),
      L('C = η × B_载波 × N', 'C = η × B_carrier × N')),
    D(L('载波带宽', 'Allocated BW'), L('载波的分配带宽，按载波数计。', 'Allocated bandwidth of the carrier, multiplied by the carrier count.'),
      L('B = 符号率 × 带宽系数 × N', 'B = symbol rate × bandwidth factor × N'))
  ]
  if (hasPw) {
    out.push(D(L('功率带宽', 'Power BW'), sum
      ? L('载波在转发器上占用的功率份额折算的等效带宽，按载波数计，组内求和。', 'Equivalent bandwidth of the carrier’s share of transponder power, multiplied by the carrier count and summed within the group.')
      : L('各链路在各自最差时刻的功率份额折算的等效带宽，逐行列出，组内不求和。', 'Equivalent bandwidth of each link’s power share at its own worst-case epoch; listed per link, not summed within the group.'),
    L('PEB = 功率占用 × B_转发器 × N', 'PEB = power usage × B_transponder × N')))
  }
  out.push(D(L('可用带宽', 'Available BW'), o.availDefault === false
    ? L('本组可占用的带宽，由用户给定；未给定时不出剩余与占用。', 'Bandwidth available to the group, as entered; without it no remaining or usage figure is given.')
    : L('本组可占用的转发器带宽；未给定时取转发器带宽。', 'Transponder bandwidth available to the group; the transponder bandwidth when not entered.'),
  L('B_可用', 'B_avail')))
  if (sum) {
    out.push(D(L('可用功率', 'Available power'), L('本组可占用的转发器功率，以等效带宽计；未给定时等于可用带宽。', 'Transponder power available to the group, as equivalent bandwidth; equal to the available bandwidth when not entered.'),
      L('P_可用', 'P_avail')))
  }
  out.push(D(L('剩余带宽', 'Remaining BW'), L('可用带宽扣除本组载波带宽之和。', 'Available bandwidth less the sum of allocated bandwidths in the group.'),
    L('B_剩余 = B_可用 − ΣB', 'B_rem = B_avail − ΣB')))
  if (sum) {
    out.push(D(L('剩余功率', 'Remaining power'), L('可用功率扣除本组功率带宽之和。', 'Available power less the sum of power bandwidths in the group.'),
      L('P_剩余 = P_可用 − ΣPEB', 'P_rem = P_avail − ΣPEB')))
  }
  out.push(D(L('带宽占用', 'Bandwidth Usage'), L('载波带宽占可用带宽的比例。', 'Allocated bandwidth as a share of the available bandwidth.'),
    L('ΣB / B_可用 × 100 %', 'ΣB / B_avail × 100 %')))
  if (hasPw) {
    out.push(sum
      ? D(L('功率占用', 'Power Usage'), L('功率带宽占可用功率的比例。', 'Power bandwidth as a share of the available power.'), L('ΣPEB / P_可用 × 100 %', 'ΣPEB / P_avail × 100 %'))
      : D(L('功率占用', 'Power Usage'), L('单条链路的功率带宽占转发器带宽的比例。', 'Power bandwidth of one link as a share of the transponder bandwidth.'), L('PEB / B_转发器 × 100 %', 'PEB / B_transponder × 100 %')))
  }
  out.push(D(L('频谱效率', 'Spectral Efficiency'), L('本组容量与载波带宽之比（带宽加权）。', 'Group capacity over allocated bandwidth (bandwidth-weighted).'),
    'η = ΣC / ΣB'))
  out.push(sum
    ? D(L('结算带宽', 'Settled bandwidth'), L('带宽与功率两本账取大者。', 'The larger of the bandwidth-limited and power-limited demands.'), L('B_结算 = max(ΣB, ΣPEB)', 'B_settled = max(ΣB, ΣPEB)'))
    : D(L('结算带宽', 'Settled bandwidth'), L('按载波带宽结算。', 'Billed on allocated bandwidth.'), L('B_结算 = ΣB', 'B_settled = ΣB')))
  if (o.anyPrice) {
    out.push(D(L('年费', 'Annual fee'), L('单价以万元/MHz/年计。', 'Unit price in 10k CNY/MHz/yr.'), L('F = 单价 × B_结算', 'F = unit price × B_settled')))
    out.push(D(L('单位容量成本', 'Cost per capacity'), L('每 Mbps 容量的年费。', 'Annual fee per Mbps of capacity.'), 'F / ΣC'))
  }
  if (o.multi) {
    out.push(D(L('合计', 'Total'), hasPw
      ? L('只加可跨组相加的量：容量、载波带宽、结算带宽、年费；功率带宽不跨组相加。年费在各组均给单价时才合计。', 'Only quantities that add across groups are totalled: capacity, allocated bandwidth, settled bandwidth and annual fee; power bandwidth is not added across groups. The annual fee is totalled only when every group has a unit price.')
      : L('只加可跨组相加的量：容量、载波带宽、结算带宽、年费。年费在各组均给单价时才合计。', 'Only quantities that add across groups are totalled: capacity, allocated bandwidth, settled bandwidth and annual fee. The annual fee is totalled only when every group has a unit price.'),
    'Σ'))
  }
  return out
}

/**
 * 容量报告模型。
 * @param o {
 *   lang, adaptUnits, doc, appVersion, orbitType, regenMode, calc,
 *   sections  [{ key, title, model（buildCapModel 的结果；null = 该节没有容量口径，如星间激光）, noOf(rowId) → 全篇 #N }]
 * }
 */
export function buildCapReportModel(o) {
  o = o || {}
  const lang = o.lang === 'en' ? 'en' : 'zh'
  const en = lang === 'en'
  const L = (zh, e) => (en ? e : zh)
  const adaptive = !!o.adaptUnits
  const scheme = schemeOf(o.orbitType || 'GEO', o.regenMode || 'uplink')
  const calc = Object.assign({}, o.calc || {})
  const src = (o.sections || []).filter((s) => s && s.model && Array.isArray(s.model.groups))
  const pbw = (src[0] && src[0].model.pbw) || CAP_PBW.SUM
  const sections = []
  const off = [], failed = []
  let nGroups = 0, nCarriers = 0, nOn = 0, anyPrice = false, anyMulti = false, availDefault = true
  for (const s of src) {
    const m = s.model
    const noOf = typeof s.noOf === 'function' ? s.noOf : null
    const numOf = (r) => { const n = noOf ? noOf(r.rowId) : null; return Number.isFinite(n) ? n : r.no }
    for (const g of m.groups) {
      for (const r of g.rows) {
        if (!r.on) off.push({ no: numOf(r), n: 1 })
        else if (!r.ok) failed.push({ no: numOf(r), n: 1 })
      }
    }
    const matrix = capReportBlock(m, { lang, adaptive, noOf })
    if (!matrix) continue
    nGroups += m.groups.length
    nOn += m.counts.on
    nCarriers += m.groups.reduce((a, g) => a + g.n, 0)
    if (m.groups.some((g) => g.price != null)) anyPrice = true
    if (m.total) anyMulti = true
    if (m.groups.some((g) => g.availBwDef == null)) availDefault = false
    sections.push({ key: s.key || '', title: s.title || '', matrix, detail: capDetailBlock(m, { lang, adaptive, noOf }) })
  }
  const hasCap = sections.length > 0
  // 分节只看真出了账的节（再生式只剩一个模块有列入链路时，按不分节排）
  const multiSec = sections.length > 1
  const t = Object.assign(labelBundle(lang), capLabels(pbw, lang))
  const schemeText = schemeName(scheme, lang) + (schemeSub(scheme, lang) ? '　·　' + schemeSub(scheme, lang) : '')
  const doc = Object.assign({}, defaultDocInfo(scheme, calc.satelliteName, lang, calc.frequencyBand), o.doc, {
    title: (o.doc && o.doc.title) || capReportTitle(calc.satelliteName, calc.frequencyBand, lang),
    appVersion: o.appVersion || '',
    generatedAt: new Date().toISOString()
  })
  // 汇总范围：键值表（标签与值都已按 lang 出好，渲染器照印）
  const scope = [[t.scheme, schemeText]]
  if (calc.satelliteName) scope.push([t.satellite, String(calc.satelliteName)])
  if (calc.frequencyBand) scope.push([t.band, String(calc.frequencyBand)])
  scope.push([pbw === CAP_PBW.NONE ? L('资源组', 'Resource groups') : L('转发器', 'Transponders'), String(nGroups)])
  scope.push([L('列入链路', 'Links included'), String(nOn)])
  scope.push([L('载波数', 'Carriers'), String(nCarriers)])
  if (off.length) scope.push([L('未列入链路', 'Links not included'), capMembersText(off)])
  if (failed.length) scope.push([L('计算失败链路', 'Links failed'), capMembersText(failed)])
  scope.push([t.unitMode, adaptive ? t.unitAdaptive : t.unitLocked])
  if (doc.appVersion) scope.push([t.appVersion, String(doc.appVersion)])
  scope.push([t.generated, String(doc.generatedAt).replace('T', ' ').slice(0, 19)])
  return {
    v: 1, kind: 'cap', lang, scheme, t, adaptUnits: adaptive, pbw,
    schemeText, doc, calc, hasCap, multi: multiSec,
    scope, sections,
    definitions: capDefinitions(pbw, { anyPrice, multi: anyMulti, availDefault }, lang),
    unitMode: translate(adaptive ? '自适应' : '锁定', lang)
  }
}
