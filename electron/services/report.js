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

// ===== 工作台链路结果导出（Phase 5/6）=====
// payload: { links:[{ti,ri,txName,rxName,ok,error,metric,data,segments}], pairMode, lang, params, meta }
// 两类表：① 链路汇总（每条一行，纵向列表——常规计算/矩阵计算共用同一种纵向布局，仅首列「序号」/「坐标」不同；
//           三线表/Times New Roman/舒朗行距）
//        ② 详细计算结果：每条链路一个 sheet（七段瀑布，仿小程序专业版，与 UI 瀑布同源），表名=坐标+发信站-收信站。
// 不再生成"结果矩阵"宽表——多数使用者按行纵向阅读表格，矩阵计算的 m×n 组合已在①里逐行列全，常规计算的
// 1↔1 配对用宽矩阵展示反而大半是空格；纵向列表对两种配对方式都更直观，也更方便排序/筛选。
// 标签中英文由 lang('zh'|'en') 控制；详细计算结果表的标签翻译表统一在 packages/core 的 waterfallBuilder.js
// WF_DICT 维护（与结果区实时瀑布同源，避免两处译法不一致），此文件只维护链路汇总表自己的列头/标题译法。
const FNT = 'Times New Roman'       // 数字/拉丁；中文由 Excel 按字形自动回退
const CJK = '微软雅黑'               // 中文标签/标题
const MED = { style: 'medium', color: { argb: 'FF000000' } }
const THIN = { style: 'thin', color: { argb: 'FF000000' } }
const HAIR = { style: 'hair', color: { argb: 'FF999999' } }

// 中英文字符串表（链路汇总表头/标题等）。英文措辞对齐卫星通信工程报告的学术/行业惯用语，并与
// WF_DICT（瀑布详情表）的译法保持一致（如 Allocated Bandwidth / Link Margin / System Availability 等），
// 避免同一份工作簿里术语不统一。
const STR = {
  zh: {
    reportTitle: 'GEO 链路预算结果', sheetSummary: '链路汇总',
    paRecW: '功放建议 (W)', paRecDbw: '功放建议 (dBW)', paActW: '功放实际输出 (W)',
    linkMargin: '链路余量 (dB)', allocBw: '载波带宽 (kHz)', powerBw: '功率带宽 (kHz)',
    bwUsage: '带宽占用 (%)', pwUsage: '功率占用 (%)',
    upCN: '上行 C/N (dB)', downCN: '下行 C/N (dB)', totalCN: '合计 C/N (dB)', thresholdCN: '门限 C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: '载波功率谱密度 (dBW/Hz)', avail: '系统可用度 (%)',
    specEff: '频谱效率 (bps/Hz)', capacity: '容量 (Mbps)',
    status: '合格', statusOk: '是', statusBad: '否', statusErr: '错误',
    pairSeq: '常规计算（1↔1）', pairMatrix: '矩阵计算（m×n）',
    subtitle: (sat, band, mode, pair, date) => `卫星 ${sat} · 频段 ${band} · 计算方式 ${mode} · 配对方式 ${pair} · ${date}`,
    calcFailed: '计算失败：',
    capHeader: (n, failed) => `容量汇总（${n} 条链路${failed ? ` · ${failed} 条失败已排除` : ''}）`,
    totalCap: '总容量', totalBw: '总带宽', avgEff: '平均频谱效率',
    param: '参数', uplink: '上行', downlink: '下行', total: '合计', value: '数值', unit: '单位'
  },
  en: {
    reportTitle: 'GEO Link Budget Results', sheetSummary: 'Link Summary',
    paRecW: 'Recommended PA Power (W)', paRecDbw: 'Recommended PA Power (dBW)', paActW: 'Actual PA Output (W)',
    linkMargin: 'Link Margin (dB)', allocBw: 'Allocated Bandwidth (kHz)', powerBw: 'Power Bandwidth (kHz)',
    bwUsage: 'Bandwidth Usage Ratio (%)', pwUsage: 'Power Usage Ratio (%)',
    upCN: 'Uplink C/N (dB)', downCN: 'Downlink C/N (dB)', totalCN: 'Combined C/N (dB)', thresholdCN: 'Threshold C/N (dB)',
    ebno: 'Eb/N₀ (dB)', esno: 'Es/N₀ (dB)', psd: 'Satellite PSD (dBW/Hz)', avail: 'System Availability (%)',
    specEff: 'Spectral Efficiency (bps/Hz)', capacity: 'Capacity (Mbps)',
    status: 'Status', statusOk: 'Pass', statusBad: 'Fail', statusErr: 'Error',
    pairSeq: 'Sequential (1:1)', pairMatrix: 'Full Matrix (m×n)',
    subtitle: (sat, band, mode, pair, date) => `Satellite ${sat} · Band ${band} · Calculation Mode: ${mode} · Pairing: ${pair} · ${date}`,
    calcFailed: 'Calculation Failed: ',
    capHeader: (n, failed) => `Capacity Summary (${n} link${n > 1 ? 's' : ''}${failed ? `, ${failed} failed excluded` : ''})`,
    totalCap: 'Total Capacity', totalBw: 'Total Bandwidth', avgEff: 'Average Spectral Efficiency',
    param: 'Parameter', uplink: 'Uplink', downlink: 'Downlink', total: 'Total', value: 'Value', unit: 'Unit'
  }
}
const strFor = (lang) => (lang === 'en' ? STR.en : STR.zh)
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

// 单链路容量 kbps = 频谱效率 η(bps/Hz) × 载波带宽 B(kHz)——与工作台结果区「容量汇总」同口径
function capKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult)
  const eta = parseFloat(d.spectralEfficiencyResult)
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN
}
// 汇总块自适应单位（与工作台 UI 同规则）：容量 kbps→Mbps→Gbps；带宽 kHz→MHz→GHz
function fmtCapText(kbps) {
  const n = Number(kbps)
  if (!isFinite(n) || n <= 0) return '0 kbps'
  if (n >= 1e6) return (n / 1e6).toFixed(3) + ' Gbps'
  if (n >= 1e3) return (n / 1e3).toFixed(3) + ' Mbps'
  return n.toFixed(n >= 100 ? 1 : 2) + ' kbps'
}
function fmtBwText(khz) {
  const n = Number(khz)
  if (!isFinite(n) || n <= 0) return '0 kHz'
  if (n >= 1e6) return (n / 1e6).toFixed(3) + ' GHz'
  if (n >= 1e3) return (n / 1e3).toFixed(3) + ' MHz'
  return n.toFixed(n >= 100 ? 1 : 3) + ' kHz'
}

// 链路汇总的"参数行"：矩阵显示全部指标 ∪ 结果卡片全部字段。每行一个参数，纵向排列——
// 这样每条链路占一整列，从上往下读完一列就是这条链路的完整结果，跟下面单链路详细计算结果表
// （参数纵向列在左、数值在右）是同一种阅读方式，多条链路时天然变成左右并排的对比表。
function summaryRows(t) {
  return [
    { label: t.paRecW, get: (l) => val(l.data, 'paRecommendation') },
    { label: t.paRecDbw, get: (l) => val(l.data, 'paRecommendationdBResult') },
    { label: t.paActW, get: (l) => val(l.data, 'selectedPowerWResult') },
    { label: t.linkMargin, get: (l) => val(l.data, 'linkmargin') },
    { label: t.allocBw, get: (l) => val(l.data, 'allocBandwidthResult') },
    { label: t.powerBw, get: (l) => val(l.data, 'PowerBWResult') },
    { label: t.specEff, get: (l) => val(l.data, 'spectralEfficiencyResult') },
    { label: t.capacity, get: (l) => { const k = capKbpsOf(l.data); return isFinite(k) ? (k / 1000).toFixed(3) : '—' } },
    { label: t.bwUsage, get: (l) => val(l.data, 'bandwidthUsageRatio') },
    { label: t.pwUsage, get: (l) => val(l.data, 'powerUsageRatio') },
    { label: t.upCN, get: (l) => val(l.data, 'uplinkCN') },
    { label: t.downCN, get: (l) => val(l.data, 'downlinkCN') },
    { label: t.totalCN, get: (l) => val(l.data, 'carrierTotalCN') },
    { label: t.thresholdCN, get: (l) => val(l.data, 'thresholdCN') },
    { label: t.ebno, get: (l) => val(l.data, 'ebnoActualResult') },
    { label: t.esno, get: (l) => val(l.data, 'esnoActualResult') },
    { label: t.psd, get: (l) => val(l.data, 'satellitePSDResult') },
    { label: t.avail, get: (l) => val(l.data, 'systemAvailabilityResult') },
    { label: t.status, get: (l) => (l.error ? t.statusErr : (l.ok ? t.statusOk : t.statusBad)), text: true }
  ]
}
// 每条链路的列头：常规计算用 #序号，矩阵计算用坐标；第二行换行写发信站→收信站
function linkColHeader(l, idx, isSequential) {
  return `${isSequential ? '#' + (idx + 1) : l.coord}\n${l.txName || ''} → ${l.rxName || ''}`
}

// 瀑布段渲染辅助（与小程序 exportLinkBudget 同口径：黑白三线表）
const valueHeaders = (cols, t) => (cols >= 3 ? [t.uplink, t.downlink, t.total] : cols >= 2 ? [t.uplink, t.downlink] : [t.value])
const rowValues = (row, cols) => (cols >= 3 ? [row.up || '', row.down || '', row.total || ''] : cols >= 2 ? [row.up || '', row.down || ''] : [row.up || ''])
const labelWithSign = (row) => (row.sign ? row.sign + ' ' : '') + (row.label || '')

// ① 链路汇总（纵向：参数名在左侧纵列，每条链路占一列；常规计算/矩阵计算共用同一种纵向布局，
// 仅列头标识不同——常规计算 #序号，矩阵计算坐标 T#R#）
function buildSummarySheet(wb, links, params, meta, t, isSequential) {
  const rows = summaryRows(t)
  const ncol = 1 + links.length
  const ws = wb.addWorksheet(t.sheetSummary, { views: [{ showGridLines: false, state: 'frozen', xSplit: 1, ySplit: 4 }] })
  ws.mergeCells(1, 1, 1, ncol)
  const title = ws.getCell(1, 1); title.value = meta.title || t.reportTitle
  title.font = { name: CJK, size: 15, bold: true }; title.alignment = { vertical: 'middle' }; ws.getRow(1).height = 28
  ws.mergeCells(2, 1, 2, ncol)
  const s = ws.getCell(2, 1)
  s.value = t.subtitle(params.satelliteName || '—', params.frequencyBand || '—', meta.mode || '—', meta.pairMode || (isSequential ? t.pairSeq : t.pairMatrix), new Date().toLocaleString())
  s.font = { name: CJK, size: 10, color: { argb: 'FF666666' } }; s.alignment = { vertical: 'middle' }; ws.getRow(2).height = 20
  // 表头（第 4 行）：左上角「参数」+ 每条链路一列
  const hr = 4
  const corner = ws.getCell(hr, 1); corner.value = t.param
  corner.font = { name: CJK, bold: true, size: 10 }; corner.alignment = { vertical: 'middle', horizontal: 'left' }
  links.forEach((l, idx) => {
    const cell = ws.getCell(hr, idx + 2)
    cell.value = linkColHeader(l, idx, isSequential)
    cell.font = { name: CJK, bold: true, size: 10 }
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  })
  setRowBorder(ws, hr, 1, ncol, { top: MED, bottom: THIN }); ws.getRow(hr).height = 34
  // 数据行：一行一个参数，横向铺开各条链路的值
  let r = hr + 1
  rows.forEach((row) => {
    const lc = ws.getCell(r, 1); lc.value = row.label
    lc.font = { name: CJK, size: 10 }; lc.alignment = { vertical: 'middle', horizontal: 'left' }
    links.forEach((l, idx) => {
      const raw = row.get(l)
      const cell = ws.getCell(r, idx + 2)
      cell.value = row.text ? (raw == null ? '' : raw) : numOrText(raw)
      cell.font = { name: row.text ? CJK : FNT, size: 10 }
      cell.alignment = { vertical: 'middle', horizontal: row.text ? 'center' : 'right' }
    })
    ws.getRow(r).height = 19
    r++
  })
  if (rows.length) setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  // 容量汇总（与工作台结果区同口径）：总带宽 = Σ 载波带宽，总容量 = Σ(η×B) 逐链路相乘再求和，
  // 平均频谱效率 = 总容量/总带宽（带宽加权）；失败链路排除并在标题注明。
  const done = links.filter((l) => l.data && !l.error)
  if (done.length) {
    let bwKHz = 0, capKbps = 0
    for (const l of done) {
      const bw = parseFloat(l.data.allocBandwidthResult)
      if (isFinite(bw)) bwKHz += bw
      const k = capKbpsOf(l.data)
      if (isFinite(k)) capKbps += k
    }
    r++
    ws.mergeCells(r, 1, r, ncol)
    const hd = ws.getCell(r, 1); hd.value = t.capHeader(done.length, links.length - done.length)
    hd.font = { name: CJK, size: 11, bold: true }; hd.alignment = { vertical: 'middle', horizontal: 'left' }
    setRowBorder(ws, r, 1, ncol, { bottom: THIN }); ws.getRow(r).height = 22; r++
    const capRows = [
      [t.totalCap, fmtCapText(capKbps)],
      [t.totalBw, fmtBwText(bwKHz)],
      [t.avgEff, bwKHz > 0 ? (capKbps / bwKHz).toFixed(3) + ' bps/Hz' : '—']
    ]
    for (const [label, value] of capRows) {
      const lc = ws.getCell(r, 1); lc.value = label
      lc.font = { name: CJK, size: 10 }; lc.alignment = { vertical: 'middle', horizontal: 'left' }
      const vc = ws.getCell(r, 2); vc.value = value
      vc.font = { name: FNT, size: 10, bold: true }; vc.alignment = { vertical: 'middle', horizontal: 'right' }
      ws.getRow(r).height = 19; r++
    }
    setRowBorder(ws, r - 1, 1, ncol, { bottom: MED })
  }
  ws.columns = [{ width: 24 }, ...links.map(() => ({ width: 15 }))]
}

// ② 单链路详细计算结果（七段瀑布，仿小程序专业版三线表；标签翻译来自 buildWaterfallSegments 本身）
function writeLinkDetailSheet(ws, link, t) {
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
    const vh = valueHeaders(cols, t)
    const totalCols = 2 + vh.length
    ws.mergeCells(r, 1, r, totalCols)
    const cap = ws.getCell(r, 1); cap.value = seg.title || ''
    cap.font = { name: CJK, bold: true, size: 12 }; cap.alignment = { horizontal: 'left', vertical: 'middle' }; ws.getRow(r).height = 24; r++
    // 表头
    const headerTexts = [t.param, ...vh, t.unit]
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
  const { links = [], params = {}, meta = {}, lang = 'zh', pairMode = 'matrix' } = payload
  const t = strFor(lang)
  const isSequential = pairMode === 'sequential'
  const enriched = links.map((l) => ({ ...l, coord: 'T' + ((l.ti || 0) + 1) + 'R' + ((l.ri || 0) + 1) }))
  const wb = new ExcelJS.Workbook()
  wb.creator = lang === 'en' ? 'GEO Satellite Link Budget Workbench' : '卫星链路预算工作台'; wb.created = new Date()

  buildSummarySheet(wb, enriched, params, meta, t, isSequential)

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
      subtitle: l.error ? (t.calcFailed + l.error) : t.subtitle(params.satelliteName || '—', params.frequencyBand || '—', meta.mode || '—', meta.pairMode || (isSequential ? t.pairSeq : t.pairMatrix), new Date().toLocaleString()),
      segments: l.segments || []
    }, t)
  }

  return wb.xlsx.writeBuffer()
}

// ===== 日凌预报报告（Word，交付级）=====
// payload: { result: calculateSunOutage 返回值, station:{name,lat,lon}, satellite:{name,lon}, tz:'bjt'|'utc' }
// 布局：标题 → 参数/模型信息块（键值两列）→ 逐日事件表（三线表）→ 方法学脚注。
// 时标由 tz 决定（默认北京时，表头注明；UTC 时刻在 ICS 日历中恒有）。

function soKV(k, v) {
  return new TableRow({ children: [
    new TableCell({ width: { size: 30, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: String(k), size: 18, color: '666666' })] })] }),
    new TableCell({ width: { size: 70, type: WidthType.PERCENTAGE }, children: [new Paragraph({ children: [new TextRun({ text: String(v), size: 18 })] })] })
  ] })
}
function soTd(text, opts) {
  opts = opts || {}
  return new TableCell({ children: [new Paragraph({
    alignment: opts.align === 'right' ? AlignmentType.RIGHT : opts.align === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT,
    children: [new TextRun({ text: String(text), bold: !!opts.bold, size: 18 })]
  })] })
}

async function buildSunOutageWord(payload) {
  const { result: r = {}, station = {}, satellite = {}, tz = 'bjt' } = payload
  const m = r.model || {}
  const isBjt = tz !== 'utc'
  const tzLabel = isBjt ? '北京时 (UTC+8)' : 'UTC'
  const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`

  const info = new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [
    soKV('地球站', `${station.name || '—'}（${fmtLL(Number(station.lat) || 0, Number(station.lon) || 0)}）`),
    soKV('卫星', `${satellite.name || '—'} · 轨位 ${satellite.lon}°E`),
    soKV('指向', `方位 ${r.satAz}° · 仰角 ${r.satEl}°`),
    soKV('频率 / 口径', `${r.frequency} GHz · ${m.diameter} m（3dB 波束宽 ${m.beamWidth3dB}°）`),
    soKV('判据', `C/N 恶化 ≥ ${m.degThreshold} dB（T_sys = ${m.sysTemp} K，T_sun = ${m.solarTemp} K${m.solarTempSource === 'manual' ? '·手动指定' : `·由 F10.7=${m.f107} 推算`}）`),
    soKV('分点', `${r.seasonName} ${r.equinoxDate} · 主轴对准恶化上限 ${m.boresightDeg} dB`),
    soKV('事件概况', `${r.startDate} ~ ${r.endDate} 共 ${r.totalDays} 天 · 单日最长 ${r.maxDurationStr}`),
    soKV('时标', tzLabel),
    soKV('生成时间', new Date().toLocaleString())
  ] })

  const header = new TableRow({ children: [
    soTd('序号', { bold: true, align: 'center' }), soTd('日期', { bold: true }),
    soTd('开始', { bold: true, align: 'right' }), soTd('峰值', { bold: true, align: 'right' }),
    soTd('结束', { bold: true, align: 'right' }), soTd('时长', { bold: true, align: 'right' }),
    soTd('峰值恶化 (dB)', { bold: true, align: 'right' }), soTd('强度', { bold: true, align: 'center' })
  ] })
  const body = (r.dailyResults || []).map((d, i) => new TableRow({ children: [
    soTd(i + 1, { align: 'center' }),
    soTd((isBjt ? d.dateBJT : d.date) + (d.isPeak ? ' ★' : ''), { bold: !!d.isPeak }),
    soTd(isBjt ? d.startTimeBJT : d.startTimeUTC, { align: 'right' }),
    soTd(isBjt ? d.peakTimeBJT : d.peakTimeUTC, { align: 'right', bold: !!d.isPeak }),
    soTd(isBjt ? d.endTimeBJT : d.endTimeUTC, { align: 'right' }),
    soTd(d.durationStr, { align: 'right' }),
    soTd(d.peakCNdeg, { align: 'right' }),
    soTd(d.intensity, { align: 'center' })
  ] }))

  const doc = new Document({ sections: [{ children: [
    new Paragraph({ text: '日凌预报报告', heading: HeadingLevel.HEADING_1 }),
    new Paragraph({ children: [new TextRun({
      text: `${satellite.name || ''} ${satellite.lon}°E → ${station.name || ''} · ${r.seasonName} ${String(r.equinoxDate || '').slice(0, 4)}`,
      size: 20, color: '444444'
    })] }),
    new Paragraph({ text: '' }),
    info,
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({ text: `逐日日凌窗口（时标：${tzLabel}，★ 为最长日）`, bold: true, size: 20 })] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...body] }),
    new Paragraph({ text: '' }),
    new Paragraph({ children: [new TextRun({
      text: '方法：太阳视位置 VSOP87+IAU1980 章动（黄经精度 ≈1″）；窗口判据为 C/N 恶化门限——太阳均匀盘（当日视直径）与天线高斯主瓣（3dB 波束宽 70λ/D）作精确卷积得 ΔT(θ)，D(θ)=10lg(1+ΔT/T_sys)≥门限即计入窗口。太阳亮温由太阳射电流量指数 F10.7（2.8GHz 实测，NOAA SWPC 每日发布）锚定、按 (2.8/f)^1.8 谱外推（光球层 6000K floor）。采用当日实测 F10.7 与本站实测 T_sys 时峰值恶化不确定度约 ±1dB；起止时刻对噪温仅对数敏感（±数十秒）。',
      size: 16, color: '999999'
    })] }),
    new Paragraph({ children: [new TextRun({ text: '强度分级：高 ≥10dB（链路失锁）· 中 3~10dB · 低 <3dB。', size: 16, color: '999999' })] })
  ] }] })
  return Packer.toBuffer(doc)
}

module.exports = { buildWord, buildExcel, buildLinkBudgetExcel, buildSunOutageWord, ROWS }
