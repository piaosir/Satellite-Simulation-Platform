// 独立《服务等级指标（SLA）》报告的 Excel 出口（.xlsx，主进程）。
//
// 版式与链路预算报告完全同一套（都取自 report.js 的表格件，只加导出、实现一个字不动）：
//   · 三线表（bookBox）：顶/底线 1.5 磅、栏目线 0.75 磅，无竖线、无底纹；
//   · 表头【居中】、数据行左/右对齐（2026-08-02 用户定的口径，刻意不照模板的全左对齐）；
//   · 题注整句 mergeCells 跨整幅 —— 不跨的话 autofit 会按这句话的长短去撑第 1 列；
//   · 分组行黑体不加粗（三线表不许底纹，层次只能靠字体给）；
//   · autofitBook 之后再 placeLogo（列宽定下来才知道版心右边界在哪），最后 applyBookFont
//     把中西混排格拆成富文本（西文与数字 TNR、中文宋体/黑体）。
//
// 工作簿：SLA 总表 · 指标定义 · 每链路一张 · 引用标准。
// 纯数字：本文件不产出任何「达标 / 合格 / 受限 / 满足」一类文字判定（见仓库根 CLAUDE.md）。
const ExcelJS = require('exceljs')
const {
  applyBookFont, placeLogo, bookBox, numOrText, buildSlaMatrix, sheetNameFor,
  autofitBook, RSTY, FNT, CJK, HEI
} = require('./report')

const S = (v) => (v == null || v === '' ? '—' : String(v))
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
const fx = (v, d) => { const n = num(v); return n === null ? '—' : n.toFixed(d) }

// 一张表的写手：把「文字格 / 数值格 / 分节标题 / 题注 / 三线表收口」这几件收在一处，
// 四张表各写各的内容，版式由这里统一保证。
function sheetWriter(wb, ws, model, ncol) {
  const L = model.t || {}
  const en = model.lang === 'en'
  const st = { r: 1 }
  const str = (row, col, text, align, o) => {
    o = o || {}
    const c = ws.getCell(row, col)
    c.value = text == null ? '' : text
    c.font = { name: o.font || (o.hei ? HEI : CJK), size: o.size || RSTY.size.table, bold: !!o.bold, color: o.color ? { argb: o.color } : undefined }
    c.alignment = { horizontal: align || 'left', vertical: 'middle', wrapText: !!o.wrap }
    return c
  }
  const numCell = (row, col, v) => {
    const c = ws.getCell(row, col)
    c.value = numOrText(v)
    c.font = { name: FNT, size: RSTY.size.table }
    c.alignment = { horizontal: 'right', vertical: 'middle' }
    return c
  }
  const wide = (text, align, o) => { ws.mergeCells(st.r, 1, st.r, ncol); str(st.r, 1, text, align, o); ws.getRow(st.r).height = (o && o.h) || 18; st.r++ }
  const section = (text) => { st.r++; wide(text, 'left', { hei: true, size: RSTY.size.h1, h: 26 }) }
  const cap = (no, title) => wide(en ? `Table ${no}  ${title}` : `${L.table} ${no}　${title}`, 'center', { hei: true, size: RSTY.size.caption })
  // 一张三线表：head 是列头（居中），rows 逐行 [值…]，groupRows 标出分组行（黑体）
  const box = (head, rows, o) => {
    o = o || {}
    const align = o.align || []
    const nc = head.length
    const h0 = st.r
    head.forEach((h, i) => str(st.r, 1 + i, h, 'center', { size: RSTY.size.table, wrap: true }))
    ws.getRow(st.r).height = o.headHeight || 24
    st.r++
    rows.forEach((row, ri) => {
      const grp = !!(o.groupRows && o.groupRows[ri])
      row.forEach((v, i) => {
        if (grp) str(st.r, 1 + i, i === 0 ? v : '', 'left', { hei: true, size: RSTY.size.table })
        else if (align[i] === 'right') numCell(st.r, 1 + i, v)
        else str(st.r, 1 + i, v, align[i] || 'left', { size: RSTY.size.table, wrap: !!o.wrap })
      })
      ws.getRow(st.r).height = o.rowHeight || 18
      st.r++
    })
    if (rows.length) bookBox(ws, h0, 1, st.r - 1, nc, h0)
    return nc
  }
  return { st, str, numCell, wide, section, cap, box }
}

// —— 「SLA 总表」——
function masterSheet(wb, model) {
  const L = model.t || {}
  const links = model.links || []
  const doc = model.doc || {}
  const ncol = Math.max(6, 1 + links.length)
  const ws = wb.addWorksheet(L.slaMatrix, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 26 }, ...Array.from({ length: ncol - 1 }, () => ({ width: 16 }))]
  const W = sheetWriter(wb, ws, model, ncol)

  W.wide(doc.title || L.sla, 'center', { hei: true, size: RSTY.size.docTitle, h: 30 })
  // 摘要行：Excel 没有封面，这一行就是它唯一的上下文
  W.wide([
    model.schemeText, doc.docNo, doc.classification, doc.org, doc.date,
    (model.calc || {}).satelliteName, (model.calc || {}).frequencyBand,
    L.period + ' ' + (model.monthly ? L.periodMonth : L.periodYear),
    doc.appVersion
  ].filter(Boolean).join('　·　'), 'center', { size: RSTY.size.table, color: 'FF666666' })

  // 1 链路清单
  W.section('1　' + L.schedule)
  W.cap(1, L.schedule)
  W.box([L.no, L.tx, L.rx, L.satellite, L.band, L.carrier],
    links.map((l) => {
      const s = l.summary || {}, c = s.carrier || {}
      const carrier = [c.infoRate != null ? fx(c.infoRate, 0) + ' kbps' : '', c.modcod,
        c.symbolRate != null ? fx(c.symbolRate, 2) + ' ksps' : ''].filter(Boolean).join('　·　')
      return ['#' + l.no, S(l.txName), S(l.rxName), S(s.satellite), S(s.band), carrier || '—']
    }), { align: ['left', 'left', 'left', 'left', 'left', 'left'] })

  // 2 指标总表矩阵：条款（含单位）做行、链路做列
  const mx = buildSlaMatrix(links, model.lang)
  if (mx) {
    W.section('2　' + L.slaMatrix)
    W.cap(2, L.slaMatrix)
    const head = [L.slaTerm, ...links.map((l) => '#' + l.no + '\n' + (l.txName || '') + ' → ' + (l.rxName || ''))]
    const rows = mx.rows.map((r) => (r.group ? [r.label, ...links.map(() => '')] : [r.label, ...r.values.map(S)]))
    W.box(head, rows, {
      align: ['left', ...links.map(() => 'right')],
      groupRows: mx.rows.map((r) => !!r.group), headHeight: 34
    })
  }
  // SLA 参数行
  const pr = model.slaParams || []
  if (pr.length) {
    W.st.r++
    W.wide(L.slaParams + '　' + pr.map((p) => p.label + ' ' + p.value + (p.unit ? ' ' + p.unit : '')).join('　·　'),
      'left', { size: RSTY.size.table, color: 'FF666666', wrap: true })
  }
  return ncol
}

// —— 「指标定义」——
function defsSheet(wb, model) {
  const L = model.t || {}
  const ncol = 5
  const ws = wb.addWorksheet(L.slaDefsSheet || L.slaDefs, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 18 }, { width: 46 }, { width: 30 }, { width: 12 }, { width: 26 }]
  const W = sheetWriter(wb, ws, model, ncol)
  W.wide(L.slaDefs, 'center', { hei: true, size: RSTY.size.h1, h: 26 })
  W.cap(1, L.slaDefs)
  W.box([L.slaTerm, L.slaDefinition, L.slaFormula, L.period, L.slaSource],
    (model.definitions || []).map((d) => [d.term, d.definition, d.formula, d.period, d.basis]),
    { wrap: true, rowHeight: 32 })
  // 免责事件：合同惯例三条只列名（日凌的预计窗口在各链路表里给数）
  const ex = model.exclusions || []
  if (ex.length) {
    W.section(L.slaExcl)
    for (const s of ex) W.wide('· ' + s, 'left', { size: RSTY.size.table })
  }
  return ncol
}

// —— 每链路一张 ——
function linkSheet(wb, model, link, name) {
  const L = model.t || {}
  const ncol = 10
  const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 22 }, { width: 34 }, { width: 13 }, { width: 13 }, { width: 11 },
    ...Array.from({ length: ncol - 5 }, () => ({ width: 11 }))]
  const W = sheetWriter(wb, ws, model, ncol)
  W.wide('#' + link.no + '　' + S(link.txName) + ' → ' + S(link.rxName), 'center', { hei: true, size: RSTY.size.h1, h: 26 })
  if (!link.ok && link.error) { W.wide(L.calcFailed + '：' + link.error, 'left', { size: RSTY.size.table }); return ncol }

  // 明细五列
  const rows = []
  const groupRows = []
  let cur = ''
  for (const r of ((link.sla && link.sla.rows) || [])) {
    if (r.groupLabel && r.groupLabel !== cur) { cur = r.groupLabel; rows.push([cur, '', '', '', '']); groupRows.push(true) }
    rows.push([r.label + (r.sub ? '　' + r.sub : ''), S(r.basis), S(r.suggest), r.adopt === '' ? '—' : S(r.adopt), S(r.unit)])
    groupRows.push(false)
  }
  W.cap(link.no + '-1', L.sla)
  W.box([L.slaTerm, L.slaBasis, L.slaSuggest, L.slaAdopt, L.unit], rows,
    { align: ['left', 'left', 'right', 'right', 'left'], groupRows, wrap: true })

  // 可用度档位：整列都取不到数的不出
  const sc = link.scan
  if (sc && sc.rows.length) {
    const COLS = [
      { k: 'tier', label: L.tier, unit: '%', dec: 2 },
      { k: 'comp', label: L.composite, unit: '%', dec: 3 },
      { k: 'up', label: L.uplink, unit: '%', dec: 3 },
      { k: 'dn', label: L.downlink, unit: '%', dec: 3 },
      { k: 'uplinkRain', label: L.rainUp, unit: 'dB', dec: 2 },
      { k: 'downlinkRain', label: L.rainDown, unit: 'dB', dec: 2 },
      { k: 'margin', label: L.marginCol, unit: 'dB', dec: 2 },
      { k: 'powerUsage', label: L.powerUse, unit: '%', dec: 2 },
      { k: 'bwUsage', label: L.bwUse, unit: '%', dec: 2 },
      { k: 'outage', label: L.outageCol, unit: 'min', dec: 0 }
    ].filter((c) => sc.rows.some((r) => num(r[c.k]) !== null))
    const wrapUnit = (u) => (model.lang === 'en' ? ' (' + u + ')' : '（' + u + '）')
    W.st.r++
    W.cap(link.no + '-2', L.slaTiers)
    W.box(COLS.map((c) => c.label + wrapUnit(c.unit)),
      sc.rows.map((r) => COLS.map((c) => {
        const v = num(r[c.k])
        if (v === null) return '—'
        return c.k === 'tier' ? (v % 1 ? v.toFixed(2) : v.toFixed(0)) : v.toFixed(c.dec)
      })), { align: COLS.map(() => 'right') })
  }

  // 日凌预计窗口
  const so = link.sunOutage
  if (so) {
    const rows3 = []
    for (const key of ['vernal', 'autumnal']) {
      const seg = so[key]
      if (!seg || !seg.rows) continue
      for (const d of seg.rows) {
        rows3.push([S(d.date), S(d.startUTC) + ' – ' + S(d.endUTC), S(d.startBJT) + ' – ' + S(d.endBJT), fx(num(d.durationSec) / 60, 1)])
      }
    }
    if (rows3.length) {
      W.st.r++
      W.cap(link.no + '-3', L.slaSun)
      W.box([L.date, 'UTC', L.localTime, L.duration + (model.lang === 'en' ? ' (min)' : '（min）')], rows3,
        { align: ['left', 'left', 'left', 'right'] })
    }
  }
  return ncol
}

// —— 「引用标准」+ 参数与假设 ——
function refsSheet(wb, model) {
  const L = model.t || {}
  const ncol = 3
  const ws = wb.addWorksheet(L.slaRefs, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 30 }, { width: 60 }, { width: 46 }]
  const W = sheetWriter(wb, ws, model, ncol)
  W.wide(L.slaAssump, 'center', { hei: true, size: RSTY.size.h1, h: 26 })
  const pr = model.slaParams || []
  if (pr.length) {
    W.cap(1, L.slaParams)
    W.box([L.param, L.value, L.unit], pr.map((p) => [p.label, S(p.value), p.unit || '—']), { align: ['left', 'right', 'left'] })
  }
  const comp = model.composition || []
  if (comp.length) {
    W.st.r++
    W.cap(2, L.slaComposition)
    W.box([L.param, L.slaSlots, L.value], comp.map((c) => [c.label, String(c.count), S(c.value)]),
      { align: ['left', 'right', 'right'] })
  }
  W.section(L.slaRefs)
  W.cap(3, L.slaRefs)
  W.box([L.mId, L.mTitle, L.mUse], (model.refs || []).map((r) => [r.id, r.title, r.use]), { wrap: true, rowHeight: 30 })
  return ncol
}

// —— 装配 ——
// 逐张表写完记下它的版心列数（logo 要贴到版心右边界），autofit 之后再统一贴 logo。
async function build(model) {
  const L = model.t || {}
  const links = model.links || []
  links.forEach((l, i) => { if (!l.no) l.no = i + 1 })
  const wb = new ExcelJS.Workbook()
  wb.creator = (model.doc && model.doc.org) || (model.lang === 'en' ? 'Satellite Link Budget Workbench' : '卫星链路预算工作台')
  wb.title = (model.doc && model.doc.title) || L.sla
  wb.created = new Date()

  const widths = []
  widths.push(masterSheet(wb, model))
  widths.push(defsSheet(wb, model))
  const used = {}
  for (const l of links) widths.push(linkSheet(wb, model, l, sheetNameFor(l, used)))
  widths.push(refsSheet(wb, model))

  // ★ 先 autofit（列宽定下来）再贴 logo：版心右边界要按最终列宽算
  autofitBook(wb, { maxWidth: 56, maxHeight: 260 })
  wb.worksheets.forEach((ws, i) => placeLogo(wb, ws, (model.doc || {}).logo, widths[i] || 6))
  return applyBookFont(wb).xlsx.writeBuffer()
}

module.exports = { buildSlaWorkbook: build }
