import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildReportModel } from '../../../src/shared/lbReport.js'
import { buildSlaReportModel } from '../../../src/shared/lbSlaReport.js'
const require = createRequire(import.meta.url)
const { buildReportPresentation } = require('../../../electron/services/reportPresentation.js')
const { buildCompactReport } = require('../../../electron/services/reportCompact.js')
const { buildReportDocx } = require('../../../electron/services/reportDocx.js')
const { buildSlaDocx } = require('../../../electron/services/reportSlaDocx.js')
const report = require('../../../electron/services/report.js')
const JSZip = require('jszip')

const links = [
  { no: 4, txName: 'TX', rxName: 'RX', ok: true, data: { linkmargin: '0', e2eMarginResult: '-1.25' }, carrier: { stds: ['DVB-S2'] }, segments: [], inputs: [] },
  { no: 5, txName: 'TX', rxName: 'RX2', ok: true, data: { linkmargin: '', e2eMarginResult: null }, segments: [], inputs: [] },
  { no: 6, txName: 'TX', rxName: 'RX3', ok: false, error: 'Invalid site', data: { linkmargin: '-999' }, segments: [], inputs: [] }
]
for (const lang of ['zh', 'en']) {
  const model = buildReportModel({ lang, links, satelliteName: 'SAT-A', frequencyBand: 'Ku' })
  const p = buildReportPresentation(model)
  assert.equal(p.cards[1].value, '2')
  assert.equal(p.cards[2].value, '1')
  assert.equal(p.cards[3].value, '0.00', 'A real zero is retained; blanks and failed values cannot become the minimum')
  assert.equal(p.routes[2].margin, '—')
  assert.equal(p.routes[2].error, 'Invalid site')
  const e2e = buildReportPresentation({ ...model, scheme: { ...model.scheme, orbitType: 'E2E' } })
  assert.equal(e2e.cards[3].value, '-1.25', 'End-to-end uses its own margin field')
  const absent = buildReportPresentation({ ...model, links: [{ no: 1, data: { linkmargin: null } }] })
  assert.equal(absent.cards[3].value, '—', 'Missing data never displays as a zero margin')
  if (lang === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(p)), 'Generated English overview copy has no Chinese')
  report.enrichReportModel(model)
  const zip = await JSZip.loadAsync(await buildReportDocx(model))
  const body = await zip.file('word/document.xml').async('string')
  assert.ok(body.includes(p.title) && body.includes('TX') && body.includes('RX3') && body.includes('Invalid site'))
  assert.ok(body.includes('DVB-S2'), 'Engineering carrier data remains in the solution')
  assert.ok(body.includes('<w:tblLayout w:type="fixed"/>'), 'Word column widths are fixed instead of collapsing into a narrow label column')
  assert.ok(/<w:pgSz[^>]*w:w="11906"[^>]*w:h="16838"/.test(body), 'The continuous contract-style report uses portrait A4')
  assert.equal((body.match(/<w:sectPr>/g) || []).length, 1, 'The solution flows into the technical results without separate cover/contents sections')
  assert.ok(!body.includes('Update Field') && !body.includes('更新域'), 'The exported contents are populated without an update action')
}
const cap = buildReportPresentation({ kind: 'cap', lang: 'en', scope: [['Links included', '3'], ['Carriers', '8']], sections: [{ detail: [{}, {}] }] })
assert.deepEqual(cap.cards.map((c) => c.value), ['2', '3', '8', '1'])
const sla = buildReportPresentation({ kind: 'sla', lang: 'en', monthly: true, links: [{ ok: true, sla: { rows: [{ key: 'sysAvail' }, { key: 'cir' }] } }, { ok: true, sla: { rows: [{ key: 'sysAvail' }] } }] })
assert.deepEqual(sla.cards.map((c) => c.value), ['2', '2', '2', 'Worst month'])

// Word and PDF consume one SLA summary. It selects actual exported clauses,
// retains their precision, and does not replace zero with a suggested value.
for (const lang of ['zh', 'en']) {
  const en = lang === 'en'
  const period = en ? 'Annual average' : '年平均'
  const slaModel = buildSlaReportModel({
    lang, calc: { satelliteName: 'SAT-A', frequencyBand: 'Ku' },
    definitions: ['sysAvail', 'cir', 'owd'].map((key) => ({ key, term: key, definition: key, formula: '—', period, basis: '—' })),
    links: [
      { no: 1, ok: true, txName: 'TX', rxName: 'RX', sla: { rows: [
        { key: 'cir', label: 'CIR', basis: 'BASIS_CIR', suggest: '1024.000', adopt: '2048.000', value: 0, unit: 'kbps' },
        { key: 'sysAvail', label: en ? 'System availability' : '系统可用度', basis: 'BASIS_SYS', suggest: '99.500', adopt: '99.900', value: '99.700', unit: '%' },
        { key: 'owd', label: en ? 'One-way delay' : '单程时延', basis: 'BASIS_OWD', suggest: 0, adopt: '', unit: 'ms' },
        { key: 'restore', label: 'RESTORE_NOT_IN_SUMMARY', suggest: '4', unit: 'h' }
      ] } },
      { no: 2, ok: true, txName: 'TX', rxName: 'RX2', sla: { rows: [
        { key: 'sysAvail', label: en ? 'System availability' : '系统可用度', basis: 'BASIS_SYS_2', suggest: '99.500', adopt: 0, unit: '%' },
        { key: 'cir', label: 'CIR', basis: 'BASIS_CIR_2', suggest: '128.000', adopt: '', unit: 'kbps' },
        { key: 'owd', label: en ? 'One-way delay' : '单程时延', basis: 'BASIS_OWD_2', suggest: '0.0', value: '', unit: 'ms' }
      ] } }
    ]
  })
  const snapshot = JSON.stringify(slaModel)
  const presentation = buildReportPresentation(slaModel)
  const mt = presentation.metricTable
  assert.equal(JSON.stringify(slaModel), snapshot, 'Summary assembly does not mutate the exported snapshot')
  assert.equal(mt.title, en ? 'Key metric summary' : '关键指标摘要')
  assert.equal(mt.head.length, 6)
  assert.equal(mt.rows.length, 6, 'Only the three selected key clauses per link are summarized')
  assert.deepEqual(mt.rows.map((r) => r[3]), ['99.500', '1024.000', '0', '99.500', '128.000', '0.0'])
  assert.deepEqual(mt.rows.map((r) => r[4]), ['99.700', '0', '0', '0', '128.000', '0.0'], 'Resolved values take precedence, then adopted, then suggested values')
  assert.ok(mt.rows.every((r) => r[2] === period), 'Assessment periods come from the matching exported definition')
  assert.ok(!JSON.stringify(mt).includes('RESTORE_NOT_IN_SUMMARY'))
  if (en) assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(mt)), 'English SLA summary headers and rows remain English')
  const legacy = buildReportPresentation({ kind: 'sla', lang, links: [{ no: 3, sla: { rows: [
    { key: 'custom', label: 'Custom', basis: 0, suggest: null, adopt: '', value: 0, unit: '' }
  ] } }] }).metricTable
  assert.deepEqual(legacy.rows, [['#3 · Custom', '0', '—', '—', '0', '—']], 'Legacy snapshots keep available clauses without inventing missing readings')
  assert.equal(buildReportPresentation({ kind: 'sla', lang, links: [] }).metricTable.rows.length, 0)
  assert.equal(buildReportPresentation({ kind: 'cap', lang }).metricTable, null, 'Capacity reports do not gain SLA summary rows')

  // The customer-facing Word brief retains every selected commitment and
  // continues wide link batches without exposing engineering calculations.
  const many = { ...slaModel, links: Array.from({ length: 36 }, (_, i) => ({ ...slaModel.links[0], no: i + 1 })) }
  const expected = buildCompactReport(many)
  const word = await JSZip.loadAsync(await buildSlaDocx(many))
  const xml = await word.file('word/document.xml').async('string')
  const tables = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) || []
  assert.equal(tables.length, expected.tables.length, 'Every selected link batch is present')
  tables.forEach((table, i) => {
    assert.equal((table.match(/<w:tr>/g) || []).length, expected.tables[i].rows.length + 1)
    assert.ok(table.includes('<w:tblHeader/>'), 'Word repeats headings on a natural continuation page')
    assert.ok(table.includes('<w:tblLayout w:type="fixed"/>'))
  })
  assert.ok(xml.includes('#36') && xml.includes('99.700') && xml.includes('RESTORE_NOT_IN_SUMMARY'))
  assert.ok(!/BASIS_|1024\.000|99\.900/.test(xml), 'Only effective commitments are printed; bases and unused suggestions are absent')
}

// Real PDF orchestration with a fake Electron surface: simultaneous exports must
// retain their own snapshots, and a rendering error must release the queue.
const source = fs.readFileSync(new URL('../../../electron/services/reportPdf.js', import.meta.url), 'utf8')
let handler, current, failNext = false
const seen = []
class FakeWindow {
  destroyed = false
  webContents = {
    executeJavaScript: async () => ({ ready: !this.fail, error: this.fail ? 'Image failed to decode' : '' }),
    printToPDF: async (options) => {
      await Promise.resolve()
      seen.push({ title: current.doc.title, presentation: current.presentation, matrix: current.slaMatrix, options })
      return Buffer.from(current.doc.title)
    }
  }
  async loadURL() { current = handler(); this.fail = failNext; failNext = false; await Promise.resolve() }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
const module = { exports: {} }
vm.runInNewContext(source, {
  require: (name) => name === 'electron' ? { BrowserWindow: FakeWindow, app: { getAppPath: () => 'C:/app' }, ipcMain: { handle: (_n, fn) => { handler = fn }, on: () => {} } }
    : name === './reportStyle' ? require('../../../electron/services/reportStyle.js')
      : name === './reportPresentation' ? { buildReportPresentation }
        : name === './reportTopologyReference' ? require('../../../electron/services/reportTopologyReference.js')
        : name === './reportCascadeTopology' ? { cascadeTopologyFigures: async () => [] }
        : name === './reportCompact' ? { buildCompactReport } : name === './report' ? report : name === './reportLogoImage' ? require('../../../electron/services/reportLogoImage.js') : require(name),
  module, process: { env: {} }, Promise, Date, Error, String, setTimeout
})
const pdf = module.exports.buildReportPdf
const models = ['full', 'sla', 'cap'].map((kind) => ({ kind, lang: 'en', doc: { title: kind }, links: [], sections: [] }))
models[1].links = [{ ok: true, sla: { rows: [{ key: 'cir', group: 'rate', label: 'CIR', value: '0', unit: 'kbps' }] } }]
assert.deepEqual((await Promise.all(models.map(pdf))).map(String), ['full', 'sla', 'cap'])
assert.deepEqual(seen.map((s) => s.title), ['full', 'sla', 'cap'])
assert.ok(seen.every((s) => s.presentation && s.options.printBackground && s.options.footerTemplate.includes('totalPages')))
assert.ok(seen[1].matrix, 'SLA PDF receives the same adopted-value matrix as the engineer workbook')
failNext = true
await assert.rejects(pdf(models[0]), /Image failed/)
assert.equal(String(await pdf(models[2])), 'cap', 'A failed PDF job does not block later jobs')
console.log('lbReportPresentation: all passed')
