import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildReportModel } from '../../../src/shared/lbReport.js'
import { buildSlaReportModel } from '../../../src/shared/lbSlaReport.js'
import { buildCapModel } from '../../../src/shared/lbCapacity.js'
import { buildCapReportModel } from '../../../src/shared/lbCapReport.js'

const require = createRequire(import.meta.url)
const ExcelJS = require('exceljs')
const report = require('../../../electron/services/report.js')
const { buildSlaWorkbook } = require('../../../electron/services/reportSla.js')
const { buildCapWorkbook } = require('../../../electron/services/reportCap.js')
const { numericReading, matrixBlocks } = require('../../../electron/services/reportEngineering.js')
const text = (v) => v && v.richText ? v.richText.map((r) => r.text).join('') : String(v == null ? '' : v)
const rowOf = (ws, label) => {
  let hit
  ws.eachRow((row) => { if (!hit && text(row.getCell(1).value) === label) hit = row })
  assert.ok(hit, label)
  return hit
}
const open = async (buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer); return wb }
const verifyPrint = (wb) => wb.worksheets.forEach((ws) => {
  assert.equal(ws.pageSetup.orientation, 'landscape')
  assert.equal(ws.pageSetup.fitToHeight, 0)
  assert.ok(ws.pageSetup.printArea && ws.headerFooter.oddFooter.includes('&P / &N'))
})

// Numeric display precision, fractions and absent readings survive serialization.
{
  const cell = {}
  numericReading(cell, '99.800'); assert.equal(cell.value, 99.8); assert.equal(cell.numFmt, '0.000')
  numericReading(cell, '1.20e-7'); assert.equal(cell.value, 1.2e-7); assert.equal(cell.numFmt, '0.00E+00')
  numericReading(cell, '3/4'); assert.equal(cell.value, '3/4')
  numericReading(cell, '0012'); assert.equal(cell.value, '0012')
  numericReading(cell, ''); assert.equal(cell.value, '—')
  numericReading(cell, '0.00', 0); assert.equal(cell.value, 0)
}

// Native Excel QA exposed detached section captions and a two-row capacity
// tail. Compact three-line tables move with their section/caption as one block;
// long tables retain their opening readings and their final three rows.
{
  const { engineeringPrintGroups, finishEngineeringWorkbook } = require('../../../electron/services/reportEngineering.js')
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Conventions')
  ws.columns = [{ width: 30 }, { width: 30 }]
  const merged = (row, text, heading = false) => {
    ws.mergeCells(row, 1, row, 2); ws.getCell(row, 1).value = text
    ws.getCell(row, 1).font = { size: heading ? 12 : 10, underline: heading }
  }
  merged(1, 'Report'); merged(2, 'Table 1  Conventions')
  const table = (start, end) => {
    for (let row = start; row <= end; row++) ws.getCell(row, 1).value = 'Reading ' + row
    ws.getCell(start, 1).border = { top: { style: 'medium' }, bottom: { style: 'thin' } }
    ws.getCell(end, 1).border = { bottom: { style: 'medium' } }
  }
  table(3, 7)
  merged(9, '2 Resource summary', true); merged(10, 'Table 2  Resources'); merged(11, 'Capacity summary (2 links)')
  table(12, 20)
  merged(22, '3 Long results', true); merged(23, 'Table 3  Results'); table(24, 42)
  const groups = engineeringPrintGroups(ws, 1)
  assert.ok(groups.some(([a, b]) => a === 9 && b === 20), 'A short table keeps the section, caption, note and final readings')
  assert.ok(groups.some(([a, b]) => a === 22 && b === 26), 'A long table keeps its first two readings with its heading')
  assert.ok(groups.some(([a, b]) => a === 40 && b === 42), 'Long-table tails contain at least three rows')
}
// Print pagination keeps section starts and short final tails together. Manual
// breaks survive XLSX serialization, with width fitting expressed as print scale.
{
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('Grouped')
  ws.columns = [{ width: 44 }, { width: 13 }, { width: 16 }]
  for (let row = 1; row <= 42; row++) {
    ws.getCell(row, 1).value = 'Row ' + row
    ws.getRow(row).height = row <= 7 ? 20 : 22
  }
  ws.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, printTitlesRow: '1:7',
    margins: { left: 0.3, right: 0.3, top: 0.45, bottom: 0.45, header: 0.15, footer: 0.2 } }
  ws._engineeringKeep = [[24, 26], [40, 42]]
  require('../../../electron/services/reportEngineering.js').paginateEngineeringSheet(ws)
  assert.deepEqual(ws.rowBreaks.map((b) => b.id), [23, 39])
  const buffer = await wb.xlsx.writeBuffer()
  const book = await open(buffer), sheet = book.getWorksheet('Grouped')
  assert.equal(sheet.pageSetup.fitToPage, false)
  assert.equal(sheet.pageSetup.scale, 100)
  // ExcelJS writes row breaks but its reader does not restore them; inspect the
  // saved OOXML that Excel itself uses for printing.
  const zip = await require('jszip').loadAsync(buffer)
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string')
  assert.ok(/<rowBreaks count="2"/.test(xml) && /<brk id="23"[^>]*man="1"/.test(xml) && /<brk id="39"[^>]*man="1"/.test(xml))
}

for (const lang of ['zh', 'en']) {
  const en = lang === 'en', label = en ? 'Margin' : '余量', input = en ? 'Frequency' : '频率'
  const links = Array.from({ length: 9 }, (_, index) => ({
    no: 11 + index, rowId: 'r' + index, txName: 'TX-' + index, rxName: 'RX-' + index,
    ok: true, data: { linkmargin: '2.40' }, error: '',
    inputs: [{ key: 'carrier', title: en ? 'Carrier' : '载波', rows: [{ label: input, value: '14.2500', unit: 'GHz' }, { label: 'MODCOD', value: 'QPSK 3/4', unit: '' }] }],
    segments: [{ no: '1', title: en ? 'Operating Conditions' : '工况', cols: 2, heads: en ? ['Clear sky', 'Rain'] : ['晴空', '降雨'],
      rows: [{ label, unit: 'dB', up: '2.40', down: '0.00', num: 2.4, numDown: 0, kind: 'margin' }] }], figures: []
  }))
  for (const orbitType of ['GEO', 'NGSO', 'REGEN', 'E2E']) {
    const model = buildReportModel({ lang, orbitType, regenMode: 'laser', links: structuredClone(links), doc: { title: en ? 'Engineering test' : '工程校验' } })
    report.enrichReportModel(model)
    const wb = await open(await report.buildReportWorkbook(model))
    const matrices = wb.worksheets.filter((ws) => ws.name.startsWith('Link_result'))
    assert.equal(matrices.length, 2, 'Large matrices paginate into readable link batches')
    const ws = matrices[0]
    assert.equal(ws.views[0].xSplit || 0, 0); assert.equal(ws.views[0].ySplit, 6)
    assert.equal(text(ws.getCell('C5').value), '#11 TX-0'); assert.equal(text(matrices[1].getCell('C5').value), '#19 TX-8')
    assert.equal(text(ws.getCell('C6').value), 'RX-0')
    const fr = rowOf(ws, input); assert.equal(fr.getCell(2).value, '(GHz)'); assert.equal(fr.getCell(3).value, 14.25); assert.equal(fr.getCell(3).numFmt, '0.0000')
    const mr = rowOf(ws, label + (en ? ' · Rain' : ' · 降雨')); assert.equal(mr.getCell(2).value, '(dB)'); assert.equal(mr.getCell(3).value, 0); assert.equal(mr.getCell(3).numFmt, '0.00')
    assert.equal(text(rowOf(ws, 'MODCOD').getCell(3).value), 'QPSK 3/4')
    assert.equal(wb.worksheets.length, 3, 'The requested overview precedes the preserved engineering matrices')
    assert.equal(wb.worksheets[0].name, en ? 'Overview' : '总览')
    assert.equal(ws.getColumn(1).width, 32.25); assert.equal(ws.getColumn(2).width, 8.875); assert.equal(ws.getColumn(3).width, 9.125)
    assert.equal(ws.getCell('A3').font.name, '仿宋_GB2312'); assert.equal(ws.getCell('A3').font.size, 22)
    assert.equal(fr.getCell(3).font.name, '宋体'); assert.equal(fr.getCell(3).font.size, 10)
    assert.equal(mr.height, 12.95); assert.equal(mr.getCell(3).border.left.style, 'thin')
    assert.equal(mr.getCell(3).border.left.color.argb, 'FF000000')
    assert.equal(Object.keys(ws._merges).length, 0, 'The full Link_result retains the unmerged source layout')
    verifyPrint(wb)
    if (en) ws.eachRow((row) => row.eachCell((cell) => assert.ok(!/[一-鿿]/.test(text(cell.value)), text(cell.value))))
  }
  // A commitment brief shows the resolved value once, with no derivation.
  const sla = buildSlaReportModel({ lang, links: [{ no: 7, txName: 'TX', rxName: 'RX', ok: true,
    sla: { rows: [{ key: 'sysAvail', group: 'availability', groupLabel: en ? 'Availability' : '可用度', label: en ? 'System Availability' : '系统可用度',
      unit: '%', basis: '99.800', suggest: '99.700', adopt: '99.600', value: '99.600' }] } }] })
  const slaBook = await open(await buildSlaWorkbook(sla)), slaMatrix = slaBook.getWorksheet('SLA_result')
  assert.ok(slaMatrix)
  assert.equal(rowOf(slaMatrix, (en ? 'System Availability' : '系统可用度')).getCell(3).value, 99.6)
  assert.equal(rowOf(slaMatrix, (en ? 'System Availability' : '系统可用度')).getCell(3).numFmt, '0.000')
  assert.equal(slaBook.worksheets.length, 1)
  slaMatrix.eachRow((row) => row.eachCell((cell) => { assert.notEqual(cell.value, 99.8); assert.notEqual(cell.value, 99.7); assert.ok(!/Calculation basis|Suggested|计算依据|建议值/.test(text(cell.value))) }))
  const zeroSla = structuredClone(sla)
  zeroSla.links[0].sla.rows[0].value = '0.000'
  zeroSla.links[0].sla.rows[0].adopt = '0.000'
  const zeroSheet = (await open(await buildSlaWorkbook(zeroSla))).worksheets[0]
  const zero = rowOf(zeroSheet, en ? 'System Availability' : '系统可用度').getCell(3)
  assert.equal(zero.value, 0); assert.equal(zero.numFmt, '0.000', 'A zero commitment is neither blank nor replaced by a suggestion')
  const wide = structuredClone(sla)
  wide.doc.title = 'Satellite communications service level commitments for a customer project with a long descriptive title'
  wide.links[0].txName = 'Transmit station with a long full name'
  wide.links[0].sla.rows.push({ key: 'frequency', label: 'Frequency', unit: 'MHz', value: '14250.0000' })
  const wideSheet = (await open(await buildSlaWorkbook(wide))).worksheets[0]
  const frequency = rowOf(wideSheet, 'Frequency').getCell(3)
  assert.equal(frequency.value, 14250); assert.equal(frequency.numFmt, '0.0000')
  assert.equal(frequency.alignment.shrinkToFit, true, 'Long precision values fit the fixed reference column without ####')
  assert.ok(wideSheet.getRow(3).height > 37.5 && wideSheet.getCell('A3').isMerged, 'Only long titles receive enough full-width space')
  verifyPrint(slaBook)
  // Capacity output still preserves its authoritative arithmetic and precision.
  const cap = buildCapModel([{ no: 1, rowId: 'a', name: 'A-B', carrier: 'QPSK', ok: true, gkey: 's1', gname: 'SAT', tpBwMHz: 36, capKbps: 2000, bwKHz: 1350, pbwKHz: 1800 }], null, {})
  const capModel = buildCapReportModel({ lang, sections: [{ key: '', title: '', model: cap, noOf: () => 1 }] })
  const capBook = await open(await buildCapWorkbook(capModel)); verifyPrint(capBook)
  assert.equal(capBook.worksheets.length, 1)
  let rate
  capBook.worksheets[0].eachRow((row) => row.eachCell((cell) => { if (cell.value === 2000) rate = cell }))
  assert.ok(rate); assert.equal(rate.numFmt, '0.000')
}

// Identical labels in successive E2E hop contexts never overwrite each other.
{
  const blocks = matrixBlocks([{ segments: [{ no: 1, title: 'Chain', cols: 1, rows: [
    { kind: 'head', label: 'Segment 1' }, { kind: 'shead', label: 'Hop 1' }, { label: 'Range', unit: 'km', up: '100', num: 100 },
    { kind: 'shead', label: 'Hop 2' }, { label: 'Range', unit: 'km', up: '200', num: 200 },
    { kind: 'head', label: 'Segment 2' }, { kind: 'shead', label: 'Hop 1' }, { label: 'Range', unit: 'km', up: '300', num: 300 }
  ] }] }], 'en')
  assert.deepEqual(blocks[0].rows.map((row) => row.values[0].raw), [100, 200, 300])
  assert.equal(new Set(blocks[0].rows.map((row) => row.label)).size, 3)
}
// Mixed regenerative modules get separate matrices, preserving global IDs.
{
  const model = { lang: 'en', sections: [{ key: 'up', short: 'Uplink' }, { key: 'laser', short: 'ISL Optical' }],
    links: [{ sec: 0, no: 4, inputs: [{ title: 'RF', rows: [{ label: 'Frequency', unit: 'GHz', value: '30' }] }] },
      { sec: 1, no: 8, inputs: [{ title: 'Optical', rows: [{ label: 'Wavelength', unit: 'nm', value: '1550' }] }] }] }
  const wb = new ExcelJS.Workbook()
  require('../../../electron/services/reportEngineering.js').addEngineeringMatrices(wb, model)
  assert.equal(wb.worksheets.length, 2)
  assert.equal(text(wb.worksheets[1].getCell('C5').value), '#8 —')
  assert.equal(rowOf(wb.worksheets[1], 'Wavelength').getCell(3).value, 1550)
}
console.log('lbEngineeringReport: all passed')
