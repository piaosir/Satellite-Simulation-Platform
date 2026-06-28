// 报告生成服务（主进程，Node）。从链路结果生成 Word / Excel；返回 Buffer 由调用方写盘。
// 移植自小程序云函数（docx / exceljs）。PDF 因需内嵌中文字体，后续单独处理。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, AlignmentType, BorderStyle
} = require('docx')
const ExcelJS = require('exceljs')

// 报告字段表：标签 / 结果键 / 单位
const ROWS = [
  ['—— 几何', null, ''],
  ['仰角', 'elevationResult', '°'],
  ['方位角', 'azimuthResult', '°'],
  ['斜距', 'slantRangeResult', 'km'],
  ['单向时延', 'linkDelayResult', 'ms'],
  ['—— 上行链路', null, ''],
  ['上行站 EIRP', 'stationEIRPResult', 'dBW'],
  ['上行自由空间损耗', 'uplinkFSLResult', 'dB'],
  ['上行雨衰 (P.618)', 'uplinkRainAttenuation', 'dB'],
  ['上行大气衰减 (P.676)', 'uplinkAtmosphericAttenuationResult', 'dB'],
  ['上行云衰 (P.840)', 'uplinkCloudAttenuation', 'dB'],
  ['上行 C/N', 'uplinkCN', 'dB'],
  ['—— 卫星', null, ''],
  ['卫星下行 EIRP', 'EIRPsResult', 'dBW'],
  ['卫星 G/T', 'satelliteGTResult', 'dB/K'],
  ['饱和通量密度 SFD', 'SFDsResult', 'dBW/m²'],
  ['转发器带宽', 'transponderBandwidthResult', 'MHz'],
  ['—— 下行链路', null, ''],
  ['下行自由空间损耗', 'downlinkFSLResult', 'dB'],
  ['下行雨衰 (P.618)', 'downlinkRainAttenuationResult', 'dB'],
  ['下行大气衰减 (P.676)', 'downlinkAtmosphericAttenuationResult', 'dB'],
  ['下行云衰 (P.840)', 'downlinkCloudAttenuation', 'dB'],
  ['接收 G/Te', 'gOverTeResult', 'dB/K'],
  ['下行 C/N', 'downlinkCN', 'dB'],
  ['—— 合成与余量', null, ''],
  ['合成 C/N', 'carrierTotalCN', 'dB'],
  ['门限 C/N', 'thresholdCN', 'dB'],
  ['链路余量', 'linkmargin', 'dB'],
  ['系统可用度', 'systemAvailabilityResult', '%'],
  ['—— 通信参数', null, ''],
  ['信息速率', 'infoRateResult', 'kbps'],
  ['调制方式', 'modulationResult', ''],
  ['FEC 码率', 'fecResult', ''],
  ['符号率', 'symbolRateResult', 'kbaud'],
  ['频谱效率', 'spectralEfficiencyResult', 'bps/Hz']
]

function val(results, key) {
  if (!key) return ''
  const v = results && results[key]
  return v === undefined || v === null || v === '-' ? '—' : String(v)
}

function cell(text, align, bold) {
  return new TableCell({
    width: { size: 33, type: WidthType.PERCENTAGE },
    children: [new Paragraph({
      alignment: align === 'right' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      children: [new TextRun({ text: String(text), bold: !!bold, size: 20 })]
    })]
  })
}

async function buildWord(payload) {
  const { results = {}, params = {}, meta = {} } = payload
  const header = new TableRow({ children: [cell('环节', 'left', true), cell('数值', 'right', true), cell('单位', 'left', true)] })
  const body = ROWS.map(([label, key, unit]) => {
    const isSection = key === null
    return new TableRow({ children: [cell(label, 'left', isSection), cell(val(results, key), 'right'), cell(unit)] })
  })
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({ text: meta.title || '卫星链路预算报告', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ children: [new TextRun({
          text: `卫星：${params.satelliteName || '—'}    频段：${params.frequencyBand || '—'}    生成时间：${new Date().toLocaleString()}`,
          size: 18, color: '666666'
        })] }),
        new Paragraph({ text: '' }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] }),
        new Paragraph({ text: '' }),
        new Paragraph({ children: [new TextRun({ text: '模型：ITU-R P.618 / P.676 / P.837 / P.838 / P.840 / P.839', size: 16, color: '999999' })] })
      ]
    }]
  })
  return Packer.toBuffer(doc)
}

async function buildExcel(payload) {
  const { results = {}, params = {}, meta = {} } = payload
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('链路预算')
  ws.mergeCells('A1:C1')
  ws.getCell('A1').value = meta.title || '卫星链路预算报告'
  ws.getCell('A1').font = { size: 14, bold: true }
  ws.getCell('A2').value = `卫星 ${params.satelliteName || '—'} · 频段 ${params.frequencyBand || '—'} · ${new Date().toLocaleString()}`
  ws.addRow([])
  const head = ws.addRow(['环节', '数值', '单位'])
  head.font = { bold: true }
  ROWS.forEach(([label, key, unit]) => {
    const row = ws.addRow([label, val(results, key), unit])
    if (key === null) row.font = { bold: true }
  })
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 12 }]
  return wb.xlsx.writeBuffer()
}

// ===== 工作台 m×n 链路结果导出（Phase 5，重做）=====
// payload: { links:[{ti,ri,txName,rxName,ok,error,metric,data,segments}], metricLabel, params, meta }
// 三类表：① 链路汇总（每条一行，列=矩阵指标∪结果卡片字段，三线表/Times New Roman/舒朗行距）
//        ② 结果矩阵（发信站 T × 收信站 R，坐标标注清晰）
//        ③ 详细计算结果：每条链路一个 sheet（七段瀑布，仿小程序专业版），表名=坐标+发信站-收信站。
const FNT = 'Times New Roman'       // 数字/拉丁；中文由 Excel 按字形自动回退
const CJK = '微软雅黑'               // 中文标签/标题
const MED = { style: 'medium', color: { argb: 'FF000000' } }
const THIN = { style: 'thin', color: { argb: 'FF000000' } }
const HAIR = { style: 'hair', color: { argb: 'FF999999' } }
function setRowBorder(ws, rowNumber, fromCol, toCol, edges) {
  for (let c = fromCol; c <= toCol; c++) {
    const cell = ws.getCell(rowNumber, c)
    const b = Object.assign({}, cell.border)
    if (edges.top) b.top = edges.top
    if (edges.bottom) b.bottom = edges.bottom
    cell.border = b
  }
}
// 数字单元格：能转数字则存数字（右对齐、可排序/计算），否则原样（'—'/'✕'/字符串）
function numOrText(v) {
  if (v === undefined || v === null || v === '' || v === '—' || v === '✕') return v == null ? '' : v
  const n = Number(v)
  return Number.isFinite(n) && String(v).trim() !== '' ? n : v
}

// 链路汇总列：标识 + 矩阵显示全部指标 ∪ 结果卡片全部字段（去重，含单位）。num=数字列。
const SUMMARY_COLS = [
  ['坐标', (l) => l.coord, false],
  ['发信站', (l) => l.txName, false],
  ['收信站', (l) => l.rxName, false],
  ['功放建议 (W)', (l) => val(l.data, 'paRecommendation'), true],
  ['功放建议 (dBW)', (l) => val(l.data, 'paRecommendationdBResult'), true],
  ['功放实际输出 (W)', (l) => val(l.data, 'selectedPowerWResult'), true],
  ['链路余量 (dB)', (l) => val(l.data, 'linkmargin'), true],
  ['载波带宽 (kHz)', (l) => val(l.data, 'allocBandwidthResult'), true],
  ['功率带宽 (kHz)', (l) => val(l.data, 'PowerBWResult'), true],
  ['带宽占用 (%)', (l) => val(l.data, 'bandwidthUsageRatio'), true],
  ['功率占用 (%)', (l) => val(l.data, 'powerUsageRatio'), true],
  ['上行 C/N (dB)', (l) => val(l.data, 'uplinkCN'), true],
  ['下行 C/N (dB)', (l) => val(l.data, 'downlinkCN'), true],
  ['合计 C/N (dB)', (l) => val(l.data, 'carrierTotalCN'), true],
  ['门限 C/N (dB)', (l) => val(l.data, 'thresholdCN'), true],
  ['Eb/N₀ (dB)', (l) => val(l.data, 'ebnoActualResult'), true],
  ['Es/N₀ (dB)', (l) => val(l.data, 'esnoActualResult'), true],
  ['载波功率谱密度 (dBW/Hz)', (l) => val(l.data, 'satellitePSDResult'), true],
  ['系统可用度 (%)', (l) => val(l.data, 'systemAvailabilityResult'), true],
  ['合格', (l) => (l.error ? '错误' : (l.ok ? '是' : '否')), false]
]

// 瀑布段渲染辅助（与小程序 exportLinkBudget 同口径：黑白三线表）
const valueHeaders = (cols) => (cols >= 3 ? ['上行', '下行', '合计'] : cols >= 2 ? ['上行', '下行'] : ['数值'])
const rowValues = (row, cols) => (cols >= 3 ? [row.up || '', row.down || '', row.total || ''] : cols >= 2 ? [row.up || '', row.down || ''] : [row.up || ''])
const labelWithSign = (row) => (row.sign ? row.sign + ' ' : '') + (row.label || '')

// ① 链路汇总
function buildSummarySheet(wb, links, params, meta) {
  const ncol = SUMMARY_COLS.length
  const ws = wb.addWorksheet('链路汇总', { views: [{ showGridLines: false, state: 'frozen', xSplit: 3, ySplit: 4 }] })
  ws.mergeCells(1, 1, 1, ncol)
  const t = ws.getCell(1, 1); t.value = meta.title || 'GEO 链路预算结果'
  t.font = { name: CJK, size: 15, bold: true }; t.alignment = { vertical: 'middle' }; ws.getRow(1).height = 28
  ws.mergeCells(2, 1, 2, ncol)
  const s = ws.getCell(2, 1)
  s.value = `卫星 ${params.satelliteName || '—'} · 频段 ${params.frequencyBand || '—'} · 计算方式 ${meta.mode || '—'} · ${new Date().toLocaleString()}`
  s.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; s.alignment = { vertical: 'middle' }; ws.getRow(2).height = 20
  // 表头（第 4 行）
  const hr = 4
  SUMMARY_COLS.forEach((c, i) => {
    const cell = ws.getCell(hr, i + 1)
    cell.value = c[0]
    cell.font = { name: i < 3 ? CJK : FNT, bold: true, size: 10 }
    cell.alignment = { vertical: 'middle', horizontal: i < 3 ? 'left' : 'center', wrapText: true }
  })
  setRowBorder(ws, hr, 1, ncol, { top: MED, bottom: THIN }); ws.getRow(hr).height = 32
  // 数据行
  let r = hr + 1
  for (const l of links) {
    SUMMARY_COLS.forEach((c, i) => {
      const raw = c[1](l)
      const cell = ws.getCell(r, i + 1)
      const isText = i < 3 || c[0] === '合格'
      cell.value = isText ? (raw == null ? '' : raw) : numOrText(raw)
      cell.font = { name: (typeof cell.value === 'number') ? FNT : (i < 3 || c[0] === '合格' ? CJK : FNT), size: 10 }
      cell.alignment = { vertical: 'middle', horizontal: i < 3 ? 'left' : (c[0] === '合格' ? 'center' : 'right') }
    })
    ws.getRow(r).height = 19
    r++
  }
  if (links.length) setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  ws.columns = SUMMARY_COLS.map((c, i) => ({ width: i === 0 ? 9 : i < 3 ? 14 : (c[0].length > 10 ? 20 : 13) }))
}

// ② 结果矩阵（坐标清晰：行=发信站 T，列=收信站 R）
function buildMatrixSheet(wb, links, metricLabel) {
  const tis = [...new Set(links.map((l) => l.ti))].sort((a, b) => a - b)
  const ris = [...new Set(links.map((l) => l.ri))].sort((a, b) => a - b)
  if (!tis.length || !ris.length) return
  const at = (ti, ri) => links.find((l) => l.ti === ti && l.ri === ri)
  const ws = wb.addWorksheet('结果矩阵', { views: [{ showGridLines: false, state: 'frozen', xSplit: 1, ySplit: 3 }] })
  const ncol = ris.length + 1
  ws.mergeCells(1, 1, 1, ncol)
  const t = ws.getCell(1, 1); t.value = `结果矩阵 · ${metricLabel}`
  t.font = { name: CJK, size: 14, bold: true }; t.alignment = { vertical: 'middle' }; ws.getRow(1).height = 26
  ws.mergeCells(2, 1, 2, ncol)
  const s = ws.getCell(2, 1); s.value = '行 = 发信站（T1…Tm）　列 = 收信站（R1…Rn）　单元格 = ' + metricLabel
  s.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; s.alignment = { vertical: 'middle' }; ws.getRow(2).height = 18
  // 表头（第 3 行）：角标 + R 坐标 + 收信站名
  const hr = 3
  const corner = ws.getCell(hr, 1); corner.value = '发信站 ＼ 收信站'
  corner.font = { name: CJK, size: 10, bold: true }; corner.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  ris.forEach((ri, j) => {
    const l = at(tis[0], ri)
    const cell = ws.getCell(hr, j + 2)
    cell.value = `R${ri + 1}\n${(l && l.rxName) || ''}`
    cell.font = { name: CJK, size: 10, bold: true }; cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  })
  setRowBorder(ws, hr, 1, ncol, { top: MED, bottom: THIN }); ws.getRow(hr).height = 34
  // 数据行
  let r = hr + 1
  for (const ti of tis) {
    const l0 = at(ti, ris[0])
    const rc = ws.getCell(r, 1); rc.value = `T${ti + 1}　${(l0 && l0.txName) || ''}`
    rc.font = { name: CJK, size: 10, bold: true }; rc.alignment = { vertical: 'middle', horizontal: 'left' }
    ris.forEach((ri, j) => {
      const l = at(ti, ri)
      const cell = ws.getCell(r, j + 2)
      cell.value = l ? (l.error ? '✕' : numOrText(l.metric)) : ''
      cell.font = { name: FNT, size: 11 }; cell.alignment = { vertical: 'middle', horizontal: 'center' }
    })
    ws.getRow(r).height = 22
    r++
  }
  setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  ws.columns = [{ width: 22 }, ...ris.map(() => ({ width: 14 }))]
}

// ③ 单链路详细计算结果（七段瀑布，仿小程序专业版三线表）
function writeLinkDetailSheet(ws, link) {
  const MAXCOL = 5
  ws.columns = [{ width: 32 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 10 }]
  let r = 1
  ws.mergeCells(r, 1, r, MAXCOL)
  const tc = ws.getCell(r, 1); tc.value = link.name || ''
  tc.font = { name: CJK, bold: true, size: 15 }; tc.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 28; r++
  if (link.subtitle) {
    ws.mergeCells(r, 1, r, MAXCOL)
    const sub = ws.getCell(r, 1); sub.value = link.subtitle
    sub.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; sub.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 18; r++
  }
  r++
  for (const seg of (link.segments || [])) {
    if (!seg || !seg.rows || !seg.rows.length) continue
    const cols = seg.cols || 1
    const vh = valueHeaders(cols)
    const totalCols = 2 + vh.length
    ws.mergeCells(r, 1, r, totalCols)
    const cap = ws.getCell(r, 1); cap.value = seg.title || ''
    cap.font = { name: CJK, bold: true, size: 12 }; cap.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 24; r++
    // 表头
    const headerTexts = ['参数', ...vh, '单位']
    headerTexts.forEach((h, i) => {
      const cell = ws.getCell(r, i + 1); cell.value = h
      cell.font = { name: CJK, bold: true, size: 10 }
      cell.alignment = { horizontal: i === 0 ? 'left' : (i === totalCols - 1 ? 'left' : 'right'), vertical: 'middle' }
    })
    setRowBorder(ws, r, 1, totalCols, { top: MED, bottom: THIN }); ws.getRow(r).height = 20; r++
    // 数据行
    const dataRows = seg.rows
    dataRows.forEach((row, ri) => {
      const isLast = ri === dataRows.length - 1
      const vals = rowValues(row, cols)
      const strong = ['base', 'sub', 'chk', 'kpi', 'margin'].indexOf(row.kind) > -1
      const sepTop = ['sub', 'margin'].indexOf(row.kind) > -1
      const lc = ws.getCell(r, 1); lc.value = labelWithSign(row)
      lc.font = { name: CJK, size: 10, bold: strong, color: { argb: 'FF1A1A1A' } }; lc.alignment = { horizontal: 'left', vertical: 'middle' }
      vals.forEach((v, vi) => {
        const isTotalCol = cols >= 3 && vi === 2
        const cell = ws.getCell(r, 2 + vi)
        cell.value = numOrText(v)
        cell.font = { name: FNT, size: 10, bold: strong || isTotalCol }; cell.alignment = { horizontal: 'right', vertical: 'middle' }
      })
      const uc = ws.getCell(r, totalCols); uc.value = row.unit || ''
      uc.font = { name: FNT, size: 9, color: { argb: 'FF555555' } }; uc.alignment = { horizontal: 'left', vertical: 'middle' }
      const edges = {}
      if (sepTop) edges.top = HAIR
      if (isLast) edges.bottom = MED
      if (edges.top || edges.bottom) setRowBorder(ws, r, 1, totalCols, edges)
      ws.getRow(r).height = 18
      r++
    })
    r++
  }
}

async function buildLinkBudgetExcel(payload) {
  const { links = [], metricLabel = '指标', params = {}, meta = {} } = payload
  const enriched = links.map((l) => ({ ...l, coord: 'T' + ((l.ti || 0) + 1) + 'R' + ((l.ri || 0) + 1) }))
  const wb = new ExcelJS.Workbook()
  wb.creator = '卫星链路预算工作台'; wb.created = new Date()

  buildSummarySheet(wb, enriched, params, meta)
  buildMatrixSheet(wb, enriched, metricLabel)

  // 详细计算结果：每条链路一个 sheet，表名 = 坐标 + 发信站-收信站（去重、截断 31 字符）
  const used = {}
  for (const l of enriched) {
    let base = `${l.coord} ${l.txName || ''}-${l.rxName || ''}`.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || l.coord
    let name = base, k = 2
    while (used[name]) name = base.slice(0, 28) + '~' + (k++)
    used[name] = true
    const ws = wb.addWorksheet(name, { views: [{ showGridLines: false }] })
    writeLinkDetailSheet(ws, {
      name: `${l.coord}　${l.txName || ''} → ${l.rxName || ''}`,
      subtitle: l.error ? ('计算失败：' + l.error) : `卫星 ${params.satelliteName || '—'} · 频段 ${params.frequencyBand || '—'} · 计算方式 ${meta.mode || '—'}`,
      segments: l.segments || []
    })
  }

  return wb.xlsx.writeBuffer()
}

module.exports = { buildWord, buildExcel, buildLinkBudgetExcel, ROWS }
