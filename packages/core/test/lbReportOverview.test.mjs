import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const { buildReportWorkbook } = require('../../../electron/services/report.js')
const { buildReportDocx } = require('../../../electron/services/reportDocx.js')
const JSZip = require('jszip')
const plain = (v) => v?.richText ? v.richText.map((r) => r.text).join('') : String(v ?? '')

for (const lang of ['zh', 'en']) {
  const en = lang === 'en', links = Array.from({ length: 6 }, (_, i) => ({
    no: i + 11, sec: i === 1 ? 1 : 0, txName: 'TX-' + i, rxName: 'RX-' + i,
    error: i === 2 ? 'Unavailable geometry' : '', data: i === 2 ? null : { linkmargin: '0.000' },
    inputs: [], segments: [], figures: [], sla: { rows: [{ key: 'cir', label: 'CIR', unit: 'kbps', value: i ? '2048.000' : '0.000' }] }
  }))
  const cap = { head: ['Resources', ...Array.from({ length: 12 }, (_, i) => 'RESOURCE-' + i)],
    rows: [['Capacity', ...Array.from({ length: 12 }, (_, i) => (i + 100).toFixed(3))]] }
  const firstSummary = { metrics: [{ label: 'C/N (dB)', values: ['12.340', '—', '0.000', '1.20e-7', '14.250'] }], cap }
  const secondSummary = { metrics: [{ label: 'Optical power (dBm)', values: ['-14.2500'] }] }
  const model = { lang, doc: { title: en ? 'Link budget report' : '链路预算报告', docNo: 'LB-1' }, t: {}, hasSla: true,
    scheme: { orbitType: 'REGEN', regenMode: 'uplink' }, links,
    sections: [{ title: en ? 'Uplink' : '上行', summary: firstSummary }, { title: en ? 'Optical ISL' : '星间激光', summary: secondSummary }] }
  const before = JSON.stringify(model.sections)
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await buildReportWorkbook(model))
  const ws = book.worksheets[0]
  assert.equal(ws.name, en ? 'Overview' : '总览')
  assert.equal(book.worksheets.length, 3, 'One overview supplements, rather than replaces, both engineering matrices')
  assert.equal(JSON.stringify(model.sections), before, 'Presentation cannot alter the summary snapshot')
  const matching = (label) => {
    const out = []
    ws.eachRow((row) => { if (plain(row.getCell(1).value) === label) out.push(row) })
    return out
  }
  const matrix = matching('C/N (dB)')
  assert.equal(matrix.length, 2, 'More than four links continue in the same batches used by Word')
  assert.deepEqual(matrix.map((row) => [3, 4, 5, 6].map((c) => row.getCell(c).value)), [[12.34, '—', 0, 1.2e-7], [14.25, null, null, null]])
  assert.equal(matrix[0].getCell(3).numFmt, '0.000'); assert.equal(matrix[0].getCell(5).numFmt, '0.000')
  assert.equal(matrix[0].getCell(6).numFmt, '0.00E+00')
  assert.deepEqual([3, 4, 5, 6].map((c) => ws.getRow(matrix[0].number - 1).getCell(c).value), ['#11', '#13', '#14', '#15'], 'Interleaved module members retain their actual global IDs, including failed links')
  assert.equal(ws.getRow(matrix[1].number - 1).getCell(3).value, '#16')
  assert.equal(matching('Optical power (dBm)')[0].getCell(3).value, -14.25)
  const capacities = matching('Capacity').filter((row) => typeof row.getCell(2).value === 'number')
  assert.equal(capacities.length, 2, 'Wide resource summaries continue without shrinking or discarding columns')
  assert.deepEqual(capacities.flatMap((row) => row.values.slice(2).filter((v) => v != null)), Array.from({ length: 12 }, (_, i) => i + 100))
  const cir = matching('CIR')[0]
  assert.equal(cir.getCell(3).value, 0); assert.equal(cir.getCell(3).numFmt, '0.000', 'SLA uses the same resolved zero and precision as Word')
  assert.equal(ws.getCell('A3').font.name, '仿宋_GB2312'); assert.equal(ws.getCell('A3').font.size, 22)
  assert.equal(ws.getCell('A3').font.color.argb, 'FF0000FF')
  assert.equal(ws.getCell('A5').font.color.argb, 'FF000080'); assert.equal(ws.getCell('A5').font.underline, true)
  assert.equal(matrix[0].getCell(3).font.name, '宋体'); assert.equal(matrix[0].getCell(3).font.size, 10)
  assert.deepEqual([1, 2, 3].map((c) => ws.getColumn(c).width), [32.25, 8.875, 9.125])
  assert.equal(ws.pageSetup.orientation, 'landscape'); assert.equal(ws.pageSetup.fitToHeight, 0)
  assert.ok(ws.pageSetup.printArea && ws.headerFooter.oddFooter.includes('&P / &N'))
  const xml = await (await JSZip.loadAsync(await buildReportDocx(model))).file('word/document.xml').async('string')
  for (const s of ['12.340', '0.000', '1.20e-7', '14.250', '-14.2500', ...cap.head]) assert.ok(xml.includes(s), 'Word retains the same source result: ' + s)
}
console.log('lbReportOverview: all passed')
