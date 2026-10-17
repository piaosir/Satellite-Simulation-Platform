// 独立《容量汇总》报告的 Excel 出口（.xlsx，主进程）。
//
// 版式与链路预算报告 / SLA 报告同一套（表格件都取自 report.js，见 reportSla.js 头注）：三线表、表头随数据列对齐、
// 题注整句跨整幅、关键行（小计）黑体不加粗、autofit 之后再贴 logo、最后 applyBookFont 拆中西文。
//
// 工作簿：容量汇总（范围 + 逐转发器矩阵）· 逐转发器明细 · 计算口径。
// 与 SLA 版的一处不同：数值格写成【数值】并按读数的小数位给 numFmt——容量与带宽是要在 Excel 里接着加减的账，
// 写成字符串就求不了和；显示仍与读数逐位一致（36000.000 不会变成 36000）。
// 纯数字：本文件不产出任何「达标 / 合格 / 受限 / 满足」一类文字判定（见仓库根 CLAUDE.md）。
const ExcelJS = require('exceljs')
const { applyBookFont, placeLogo, bookBox, autofitBook, RSTY, FNT, CJK, HEI, TITLE } = require('./report')
const { fontsOf } = require('./reportStyle')

const NUM_RE = /^-?\d+(\.\d+)?$/

function sheetWriter(ws, model, ncol) {
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
  // 读数「36000.000」→ 数值 36000 + numFmt 0.000：可求和，显示与读数一致；「—」等原样写字
  const numCell = (row, col, v, key) => {
    const c = ws.getCell(row, col)
    const s = v == null ? '' : String(v)
    if (NUM_RE.test(s)) {
      c.value = Number(s)
      const d = s.indexOf('.') < 0 ? 0 : s.length - s.indexOf('.') - 1
      c.numFmt = d ? '0.' + '0'.repeat(d) : '0'
    } else c.value = s
    c.font = { name: key ? HEI : FNT, size: RSTY.size.table }
    c.alignment = { horizontal: 'right', vertical: 'middle' }
    return c
  }
  const wide = (text, align, o) => { ws.mergeCells(st.r, 1, st.r, ncol); str(st.r, 1, text, align, o); ws.getRow(st.r).height = (o && o.h) || 18; st.r++ }
  const section = (text) => { st.r++; wide(text, 'left', { hei: true, size: RSTY.size.h1, h: 26 }) }
  const sub = (text) => wide(text, 'left', { hei: true, size: RSTY.size.table, h: 22 })
  const cap = (no, title) => wide(en ? `Table ${no}  ${title}` : `${L.table} ${no}　${title}`, 'center', { hei: true, size: RSTY.size.caption })
  // 三线表：align[i] 为 right 的列按数值写；keyRows 标出的关键行（小计）换黑体
  const box = (head, rows, o) => {
    o = o || {}
    const align = o.align || []
    const h0 = st.r
    head.forEach((h, i) => str(st.r, 1 + i, h, align[i] === 'right' ? 'right' : 'left', { size: RSTY.size.table, wrap: true }))
    ws.getRow(st.r).height = o.headHeight || 24
    st.r++
    rows.forEach((row, ri) => {
      const key = !!(o.keyRows && o.keyRows[ri])
      row.forEach((v, i) => {
        if (align[i] === 'right') numCell(st.r, 1 + i, v, key)
        else str(st.r, 1 + i, v, 'left', { size: RSTY.size.table, wrap: !!o.wrap, hei: key })
      })
      ws.getRow(st.r).height = o.rowHeight || 18
      st.r++
    })
    if (rows.length) bookBox(ws, h0, 1, st.r - 1, head.length, h0)
  }
  return { st, str, wide, section, sub, cap, box }
}

// —— 「容量汇总」：标题 + 摘要行 + 汇总范围 + 逐转发器矩阵（分节时各节一张）——
function masterSheet(wb, model) {
  const L = model.t || {}
  const doc = model.doc || {}
  const secs = model.sections || []
  const ncol = Math.max(4, ...secs.map((s) => s.matrix.head.length))
  const ws = wb.addWorksheet(L.capReport, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 26 }, ...Array.from({ length: ncol - 1 }, () => ({ width: 16 }))]
  const W = sheetWriter(ws, model, ncol)
  let no = 0

  // 报告标题固定 Arial + 黑体（reportStyle.TPL.title），不随对话框的字体三档走
  W.wide(doc.title || L.capReport, 'center', { font: TITLE, size: RSTY.title.size, bold: RSTY.title.bold, h: 30 })
  // 摘要行：Excel 没有封面，这一行就是它唯一的上下文
  W.wide([model.schemeText, doc.docNo, doc.classification, doc.org, doc.date, doc.appVersion].filter(Boolean).join('　·　'),
    'center', { size: RSTY.size.table, color: 'FF666666' })

  W.section('1　' + L.capScope)
  W.cap(++no, L.capScope)
  W.box([L.param, L.value], model.scope || [], { align: ['left', 'left'] })

  W.section('2　' + L.capMatrix)
  secs.forEach((s, si) => {
    if (model.multi) { if (si) W.st.r++; W.sub('2.' + (si + 1) + '　' + s.title) }
    W.cap(++no, L.capMatrix + (model.multi ? '　·　' + s.title : ''))
    if (s.matrix.note) W.wide(s.matrix.note, 'left', { size: RSTY.size.table, color: 'FF666666' })
    // 首行「链路」是成员编号（文字），其余行是数；转发器列与合计列靠右
    const head = s.matrix.head
    W.box(head, s.matrix.rows, { align: ['left', ...head.slice(1).map(() => 'right')] })
  })
  model.__tblNo = no
  return ncol
}

// —— 「逐转发器明细」：一组一张，分节时按节分段 ——
function detailSheet(wb, model) {
  const L = model.t || {}
  const secs = model.sections || []
  const ncol = Math.max(4, ...secs.flatMap((s) => s.detail.map((g) => g.head.length)))
  const ws = wb.addWorksheet(L.capDetail, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 8 }, { width: 28 }, { width: 18 }, ...Array.from({ length: Math.max(1, ncol - 3) }, () => ({ width: 14 }))]
  const W = sheetWriter(ws, model, ncol)
  let no = model.__tblNo || 0
  W.wide(L.capDetail, 'center', { hei: true, size: RSTY.size.h1, h: 26 })
  secs.forEach((s, si) => {
    if (model.multi) { W.st.r++; W.sub((si + 1) + '　' + s.title) }
    s.detail.forEach((g, gi) => {
      if (gi || model.multi) W.st.r++
      W.cap(++no, groupTitle(g, model.lang))
      W.box(g.head, g.rows, { align: g.align, keyRows: g.keyRows })
    })
  })
  model.__tblNo = no
  return ncol
}

// 组的表题：组名 + 转发器带宽（再生式没有转发器带宽，只写组名）
function groupTitle(g, lang) {
  if (!(g.tpBwMHz > 0)) return g.name
  return lang === 'en' ? `${g.name} (transponder BW ${g.tpBwMHz} MHz)` : `${g.name}（转发器带宽 ${g.tpBwMHz} MHz）`
}

// —— 「计算口径」——
function defsSheet(wb, model) {
  const L = model.t || {}
  const ncol = 3
  const ws = wb.addWorksheet(L.capDefs, { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 18 }, { width: 56 }, { width: 34 }]
  const W = sheetWriter(ws, model, ncol)
  W.wide(L.capDefs, 'center', { hei: true, size: RSTY.size.h1, h: 26 })
  W.cap((model.__tblNo || 0) + 1, L.capDefs)
  W.box([L.capTerm, L.capDefinition, L.capFormula],
    (model.definitions || []).map((d) => [d.term, d.definition, d.formula]), { wrap: true, rowHeight: 30 })
  return ncol
}

async function build(model) {
  const L = model.t || {}
  const wb = new ExcelJS.Workbook()
  wb.creator = (model.doc && model.doc.org) || (model.lang === 'en' ? 'Satellite Link Budget Workbench' : '卫星链路预算工作台')
  wb.title = (model.doc && model.doc.title) || L.capReport
  wb.created = new Date()
  model.__tblNo = 0
  const widths = [masterSheet(wb, model), detailSheet(wb, model), defsSheet(wb, model)]
  // ★ 先 autofit（列宽定下来）再贴 logo：版心右边界要按最终列宽算
  autofitBook(wb, { maxWidth: 56, maxHeight: 260 })
  wb.worksheets.forEach((ws, i) => placeLogo(wb, ws, (model.doc || {}).logo, widths[i] || 4))
  return applyBookFont(wb, fontsOf(model.doc)).xlsx.writeBuffer()
}

module.exports = { buildCapWorkbook: build, capGroupTitle: groupTitle }
