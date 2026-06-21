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

module.exports = { buildWord, buildExcel, ROWS }
