// 通用表格 ⇄ .xlsx（主进程，Node）。
//
// ★ 这一份【不认识任何业务】：拿到的是渲染端算好的纯数据模型（第几列叫什么、是不是数字列、
//   几位小数、每行各格什么值），只负责刷成工作簿；反过来读表也只把格子还原成 JS 原生值，
//   「哪一列是经度」之类的匹配全在渲染端 src/shared/gridXlsx.js 做。
//   与频率计划那份（freqPlanXlsx.js）分工相同，区别是那份带版式、这份是给人改完再导回来的数据表。
//
// 导出版式刻意朴素（首行表头 + 冻结 + 筛选器 + 数字列真存数字）：这些表是「导出→在 Excel 里改→
// 再导回来」的往返载体，任何标题条/合并格都会让「首行=表头」这条约定破功。要好看的交付件走报表模块。
//
// 字体与报表同一套（西文/数字 Times New Roman，中文靠字体链接回落宋体）——见 report.js 的 FNT。

const ExcelJS = require('exceljs')
const { autofitBook } = require('./reportAutofit')

const FNT = 'Times New Roman'
const INK = 'FF17181A'
const RULE = 'FF3A3F45'
const HEAD_FILL = 'FFEDEFF2'

const MED = { style: 'medium', color: { argb: RULE } }
const HAIR = { style: 'hair', color: { argb: 'FFB9BEC5' } }

// 小数位 → Excel 数字格式；fix 缺省交给 Excel 通用格式（整数不补零、长小数不截断）
const numFmt = (fix) => (fix == null || !(fix >= 0) ? null : (fix === 0 ? '0' : '0.' + '0'.repeat(fix)))

// 工作表名的非法字符（Excel 禁 : \ / ? * [ ]），且上限 31 字符；重名自动加序号由调用处保证
function safeSheetName(name, used) {
  let s = String(name == null ? '' : name).replace(/[:\\/?*[\]]/g, '·').trim() || 'Sheet'
  if (s.length > 31) s = s.slice(0, 31)
  if (!used) return s
  let out = s, k = 2
  while (used.has(out)) { const tail = '(' + k++ + ')'; out = s.slice(0, 31 - tail.length) + tail }
  used.add(out)
  return out
}

/**
 * 建工作簿。model = {
 *   creator?, title?,
 *   sheets: [{ name, header: [string], cols?: [{ num, fix, w }], rows: [[值]] , note? }]
 * }
 * rows 里的值：数字列给 number（null 表示空格），文本列给 string。
 */
async function buildGridWorkbook(model) {
  const wb = new ExcelJS.Workbook()
  wb.creator = (model && model.creator) || '卫星仿真平台'
  wb.created = new Date()
  const used = new Set()
  const sheets = (model && model.sheets) || []
  for (const sh of sheets) {
    const header = (sh && sh.header) || []
    const cols = (sh && sh.cols) || []
    const rows = (sh && sh.rows) || []
    const ws = wb.addWorksheet(safeSheetName(sh && sh.name, used), { views: [{ state: 'frozen', ySplit: 1 }] })

    // 表头
    const hr = ws.getRow(1)
    header.forEach((label, i) => {
      const cell = hr.getCell(i + 1)
      cell.value = label == null ? '' : String(label)
      cell.font = { name: FNT, size: 10, bold: true, color: { argb: INK } }
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: false }
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEAD_FILL } }
      cell.border = { top: MED, bottom: MED, left: HAIR, right: HAIR }
    })
    hr.height = 17

    // 数据
    rows.forEach((cells, ri) => {
      const row = ws.getRow(ri + 2)
      for (let ci = 0; ci < header.length; ci++) {
        const c = cols[ci] || {}
        const v = cells ? cells[ci] : null
        const cell = row.getCell(ci + 1)
        cell.value = (v === '' || v === undefined || v === null) ? null : v
        cell.font = { name: FNT, size: 10, color: { argb: INK } }
        cell.alignment = { vertical: 'middle', horizontal: c.num ? 'right' : 'left' }
        cell.border = { left: HAIR, right: HAIR, bottom: HAIR }
        if (c.num) { const f = numFmt(c.fix); if (f) cell.numFmt = f }
      }
    })
    // 末行下沿收一条粗线（三线表的下横线；空表时收在表头下方）
    const last = ws.getRow(Math.max(1, rows.length + 1))
    for (let ci = 0; ci < header.length; ci++) {
      const cell = last.getCell(ci + 1)
      cell.border = Object.assign({}, cell.border, { bottom: MED })
    }
    if (header.length) {
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } }
      header.forEach((_, i) => { const w = cols[i] && cols[i].w; if (w > 0) ws.getColumn(i + 1).width = w })
    }
  }
  // 说明（卫星/天线/时刻等上下文）单开一张表：★不能写在数据表下方——空行不是可靠的分隔符
  // （读表时空行被跳过），那行字会被当成一条数据读回来。数据表恒保持「首行表头 + 纯数据」。
  const notes = sheets.filter((s) => s && s.note)
  if (notes.length) {
    const ws = wb.addWorksheet(safeSheetName('说明', used))
    notes.forEach((s, i) => {
      const row = ws.getRow(i + 1)
      row.getCell(1).value = String(s.name || '')
      row.getCell(2).value = String(s.note)
      for (const c of [1, 2]) row.getCell(c).font = { name: FNT, size: 10, color: { argb: INK } }
      row.getCell(1).font = { name: FNT, size: 10, bold: true, color: { argb: INK } }
    })
  }
  autofitBook(wb)
  return wb.xlsx.writeBuffer()
}

// exceljs 的 cell.value 可能是富文本/公式/超链接对象 → 一律还原成 JS 原生值（数字保持数字）
function plain(v) {
  if (v == null) return null
  if (typeof v === 'number' || typeof v === 'boolean') return v
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v.richText)) return v.richText.map((t) => t.text || '').join('')
  if (v.text != null) return String(v.text)                       // 超链接
  if (v.result != null) return plain(v.result)                    // 公式：取算出的值
  if (v.formula != null || v.sharedFormula != null) return null    // 未缓存结果的公式
  if (v.error) return null
  return String(v)
}

/**
 * 读工作簿。返回 { sheets: [{ name, rows: [[值]] }] }。
 * 只做「格子 → 值」的还原：空行剔除、行尾空格裁掉；表头识别与列匹配交给渲染端。
 */
async function readGridWorkbook(filePath) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const sheets = []
  wb.eachSheet((ws) => {
    const rows = []
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells = []
      // row.cellCount 只数到最后一个有值的格；用 values 数组（1-based，[0] 恒空）逐格取
      const vals = row.values || []
      for (let i = 1; i < vals.length; i++) cells.push(plain(vals[i]))
      while (cells.length && (cells[cells.length - 1] == null || String(cells[cells.length - 1]).trim() === '')) cells.pop()
      if (cells.length) rows.push(cells)
    })
    sheets.push({ name: ws.name, rows })
  })
  return { sheets }
}

module.exports = { buildGridWorkbook, readGridWorkbook }
