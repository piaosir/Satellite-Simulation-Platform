import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildSlaReportModel } from '../../../src/shared/lbSlaReport.js'
import { buildCapReportModel } from '../../../src/shared/lbCapReport.js'
import { buildCapModel, CAP_PBW } from '../../../src/shared/lbCapacity.js'

const require = createRequire(import.meta.url)
const { buildCompactReport, effectiveSlaValue } = require('../../../electron/services/reportCompact.js')
const JSZip = require('jszip')
const deepFreeze = (x) => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(deepFreeze) } return x }

assert.equal(effectiveSlaValue({ value: 0, adopt: '9', suggest: '8' }), '0')
assert.equal(effectiveSlaValue({ value: '', adopt: 0, suggest: '8' }), '0')
assert.equal(effectiveSlaValue({ adopt: '', suggest: '0.000' }), '0.000')
assert.equal(effectiveSlaValue({}), '—')

function slaModel(lang) {
  const en = lang === 'en'
  return buildSlaReportModel({
    lang, monthly: 1, calc: { satelliteName: 'SAT-A', frequencyBand: 'Ku' }, doc: { docNo: 'SLA-1', org: 'CUSTOMER', date: '2026-11-14' },
    links: [{ no: 1, txName: 'TX', rxName: 'RX', ok: true, data: {}, sla: { rows: [
      { key: 'sysAvail', groupLabel: en ? 'Availability' : '可用度', label: en ? 'System availability' : '系统可用度', unit: '%', value: '99.700', adopt: '99.600', suggest: '99.500', basis: 'CALC_BASIS_SECRET' },
      { key: 'cir', groupLabel: en ? 'Rate' : '速率', label: 'CIR', unit: 'kbps', value: 0, suggest: '1000', basis: 'CALC_BASIS_SECRET' },
      { key: 'extra', groupLabel: en ? 'Other' : '其他', label: en ? 'Custom metric' : '自定义指标', unit: 'ms', value: '7.00', basis: 'CALC_BASIS_SECRET' }
    ] } }, { no: 2, txName: 'TX', rxName: 'RX-2', ok: true, data: {}, sla: { rows: [
      { key: 'sysAvail', groupLabel: en ? 'Availability' : '可用度', label: en ? 'System availability' : '系统可用度', unit: '%', value: '99.950', basis: 'CALC_BASIS_SECRET' },
      { key: 'cir', groupLabel: en ? 'Rate' : '速率', label: 'CIR', unit: 'kbps', adopt: '2048.000', suggest: '512', basis: 'CALC_BASIS_SECRET' }
    ] } }],
    definitions: [{ definition: 'DEFINITION_SECRET', formula: 'FORMULA_SECRET' }], refs: [{ title: 'REFERENCE_SECRET' }],
    composition: [{ label: 'COMPOSITION_SECRET', count: 8, value: '99.99' }], slaParams: [{ label: 'PARAMETER_SECRET', value: '1' }]
  })
}

for (const lang of ['zh', 'en']) {
  const m = slaModel(lang), before = JSON.stringify(m)
  deepFreeze(m)
  const brief = buildCompactReport(m)
  assert.equal(JSON.stringify(m), before, 'The compact report does not modify the calculation snapshot')
  assert.equal(brief.tables.length, 1)
  assert.equal(brief.landscape, false)
  const table = brief.tables[0], rows = table.rows.filter((r, i) => !table.groupRows[i])
  assert.equal(rows.length, 3, 'All selected terms are retained, including custom terms outside the former three-metric summary')
  assert.deepEqual(rows.map((r) => r.slice(1)), [['%', '99.700', '99.950'], ['kbps', '0', '2048.000'], ['ms', '7.00', '—']])
  assert.ok(brief.meta.some((r) => /最坏月|Worst month/.test(r.value)))
  assert.ok(!/CALC_BASIS_SECRET|DEFINITION_SECRET|FORMULA_SECRET|REFERENCE_SECRET|COMPOSITION_SECRET|PARAMETER_SECRET/.test(JSON.stringify(brief)))
  assert.ok(!/basis|suggest|scan|formula|composition|definitions/.test(JSON.stringify(brief)))
  if (lang === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(brief)))
}

const duplicate = { kind: 'sla', lang: 'en', links: [{ no: 1, txName: 'A', rxName: 'B', sla: { rows: [
  { key: 'k', label: 'Repeated', unit: 'ms', value: '1' },
  { key: 'k', label: 'Repeated', unit: 'ms', value: '2' },
  { key: 'k', label: 'Different unit', unit: 's', value: '3' }
] } }] }
assert.deepEqual(buildCompactReport(duplicate).tables[0].rows.map((r) => r.slice(-1)[0]), ['1', '2', '3'], 'Repeated keys and unlike units cannot overwrite a selected commitment')
const many = { ...duplicate, links: Array.from({ length: 13 }, (_, i) => ({ ...duplicate.links[0], no: i + 1 })) }
const batches = buildCompactReport(many)
assert.deepEqual(batches.tables.map((t) => t.head.length), [8, 8, 3])
assert.equal(batches.tables.reduce((n, t) => n + t.head.length - 2, 0), 13, 'Large reports continue without dropping links')
assert.equal(batches.landscape, true)

function capModel(lang) {
  const en = lang === 'en'
  const source = buildCapModel([
    { no: 1, rowId: 'a', name: 'TX → RX', carrier: 'QPSK', gkey: 's1', gname: 'SAT-A', ok: true, tpBwMHz: 36, capKbps: 2048, bwKHz: 14000, pbwKHz: 1000 },
    { no: 2, rowId: 'b', name: 'TX → RX-2', carrier: 'QPSK', gkey: 's1', gname: 'SAT-A', ok: true, tpBwMHz: 36, capKbps: 4096, bwKHz: 1500, pbwKHz: 2000, cap: { n: 2 } },
    { no: 3, rowId: 'c', name: 'NOT INCLUDED', gkey: 's2', gname: 'SAT-B', ok: true, tpBwMHz: 36, capKbps: 500, bwKHz: 500, pbwKHz: 500, cap: { off: true } }
  ], {}, { pbw: CAP_PBW.SUM })
  return buildCapReportModel({ lang, doc: { title: en ? 'Capacity summary' : '容量汇总' }, calc: { satelliteName: 'SAT-A', frequencyBand: 'Ku' }, sections: [{ key: '', model: source }] })
}

for (const lang of ['zh', 'en']) {
  const m = capModel(lang), before = JSON.stringify(m), brief = buildCompactReport(deepFreeze(m))
  assert.equal(JSON.stringify(m), before)
  assert.deepEqual(brief.tables[0].rows, m.sections[0].matrix.rows, 'The exact resource totals, precision and unavailable markers are retained')
  const assignments = brief.tables.at(-1)
  assert.equal(assignments.rows.length, 2)
  assert.deepEqual(assignments.rows.map((r) => r[2]), ['1', '2'])
  assert.ok(assignments.rows.every((r) => !/Subtotal|小计|NOT INCLUDED/.test(r.join(' '))))
  assert.ok(!/definition|formula/.test(JSON.stringify(brief)))
  assert.ok(brief.notes.some((s) => s.includes('#3')), 'Excluded link identifiers remain explicit')
  if (lang === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(JSON.stringify(brief)))
}

const { buildSlaDocx } = require('../../../electron/services/reportSlaDocx.js')
const { buildCapDocx } = require('../../../electron/services/reportCapDocx.js')
for (const lang of ['zh', 'en']) for (const [model, build] of [[slaModel(lang), buildSlaDocx], [capModel(lang), buildCapDocx]]) {
  const zip = await JSZip.loadAsync(await build(model))
  const xml = await zip.file('word/document.xml').async('string')
  assert.equal((xml.match(/<w:sectPr>/g) || []).length, 1, 'A short brief is one flowing section, without standalone cover or contents')
  assert.ok(!/CALC_BASIS_SECRET|DEFINITION_SECRET|FORMULA_SECRET|REFERENCE_SECRET|COMPOSITION_SECRET|PARAMETER_SECRET/.test(xml))
  assert.ok(!xml.includes('TOC ') && !xml.includes('w:pageBreakBefore'))
  assert.ok(xml.includes('<w:tblHeader/>'), 'Tables repeat their column headings on a natural continuation page')
  if (model.kind === 'sla') assert.ok(xml.includes('99.700') && xml.includes('2048.000') && xml.includes('7.00'))
}
console.log('PASS compact SLA commitments and capacity briefs: all selected values, zero/precision, continuation, no calculation leakage, and flowing Word output')
