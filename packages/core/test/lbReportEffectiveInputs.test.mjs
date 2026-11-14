import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { useLbReport } from '../../../src/shared/useLbReport.js'
import { reportInputParams, buildInputDigest, calcBlock, reportT } from '../../../src/shared/lbReport.js'
import * as G from '../../../src/linkbudget/params.js'
import { FIELD_GROUPS as REGEN_FIELDS } from '../../../src/regen/regenParams.js'
import { regenDigestParams } from '../../../src/regen/regenModeScope.js'

const require = createRequire(import.meta.url)
const { computeLinkMode } = require('../../../packages/core/utils/modeSolver.js')
const { computeRegenUplinkMode, computeRegenLaserIslMode } = require('../../../packages/core/utils/linkCalculatorRegen.js')
const { enrichReportModel, buildReportWorkbook } = require('../../../electron/services/report.js')
const { buildReportDocx } = require('../../../electron/services/reportDocx.js')
const ExcelJS = require('exceljs'), JSZip = require('jszip')
const rowOf = (blocks, key, label) => blocks.find((b) => b.key === key)?.rows.find((r) => r.label === label)

// A blank RF input has conditional engine defaults; filling schema defaults in
// the report would incorrectly print a 6.2 m Rx antenna and Ku noise temperatures.
const params = {
  satParams: { satelliteName: 'SAT', frequencyBand: 'C', sfdRef: '', sfdGtRef: 2 },
  linkParams: { rxAntennaDiameter: '', rxAntennaNoiseTemp: '', rxReceiverNoiseTemp: '',
    rxAntennaNoiseTempMode: '', downlinkPolarization: '', uplinkPolarization: 'H',
    margin: '', paBackoff: 0, rxFeederLoss: 0 },
  opt: { mode: 'margin' }
}
const before = JSON.stringify(params)
const result = computeLinkMode(params.satParams, params.linkParams, { ...params.opt, captureInputs: true })
assert.equal(result.success, true)
assert.equal(JSON.stringify(params), before, 'Recording inputs never mutates the form or calculation request')
assert.deepEqual(result.data, computeLinkMode(params.satParams, params.linkParams, params.opt).data, 'Report metadata cannot change calculated readings')
const effective = reportInputParams(params, result.effectiveInputs)
assert.equal(reportInputParams(params, null), params, 'Legacy or failed calculations do not invent uncomputed defaults')
const expected = [['carrier', '信息速率', '2048'], ['carrier', '系统余量', '3'],
  ['downlink', '天线口径', '3.7'], ['downlink', '天线噪温', '30'],
  ['downlink', '接收机噪温', '40'], ['downlink', '天线噪温模式', '自定义'],
  ['sat', '下行极化', 'V'], ['sat', 'SFDref（有效）', '-84'], ['uplink', '功放回退', '0']]

for (const lang of ['zh', 'en']) {
  const t = reportT(lang), inputs = buildInputDigest(G.FIELD_GROUPS, effective, lang)
  for (const [key, label, value] of expected) {
    const row = rowOf(inputs, key, t(label))
    assert.ok(row, `Missing defaulted input ${label}`)
    assert.equal(row.value, label === '天线噪温模式' ? t(value) : value)
  }
  let exported, error = ''
  const link = { rowId: 'r1', txName: 'TX', rxName: 'RX', data: result.data, ok: true, effectiveInputs: result.effectiveInputs }
  const report = useLbReport({
    api: { report: { exportReport: async (p) => { exported = p; return { canceled: true } } } },
    orbitType: 'GEO', fieldGroups: G.FIELD_GROUPS, links: () => [link],
    lang: () => lang, appVersion: () => 'test', calc: () => ({ mode: 'margin', satelliteName: 'SAT', frequencyBand: 'C' }),
    calcFor: (l) => ({ targetMargin: l.effectiveInputs.linkParams.margin }),
    paramsFor: (l) => reportInputParams(params, l.effectiveInputs),
    defaultName: () => 'test', setError: (s) => { error = s }, toast: () => {}
  })
  await report.runReport({ lang, formats: ['xlsx', 'docx', 'pdf'], withFigures: false, doc: {} })
  assert.equal(error, '')
  assert.deepEqual(exported.formats, ['xlsx', 'docx', 'pdf'])
  const model = exported.model
  assert.equal(rowOf(model.links[0].inputs, 'calc', t('目标系统余量')).value, '3')
  assert.equal(model.links[0].topology.edges[0].frequency, '14.25 GHz', 'Topology uses the same defaulted frequencies')
  assert.equal(model.links[0].topology.edges[1].frequency, '12.5 GHz')
  enrichReportModel(model)
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await buildReportWorkbook(model))
  const detail = book.worksheets[1]
  const xml = await (await JSZip.loadAsync(await buildReportDocx(model))).file('word/document.xml').async('string')
  for (const [key, label] of expected) {
    const row = rowOf(inputs, key, t(label))
    let found = false
    detail.eachRow((r) => { if (r.getCell(1).value === row.label && String(r.getCell(3).value) === row.value) found = true })
    assert.ok(found, 'Excel prints the effective input: ' + row.label)
    assert.ok([...xml.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].some((m) => m[0].includes(row.label) && m[0].includes('>' + row.value + '</w:t>')), 'Word prints the effective input: ' + row.label)
  }
}

// A compensated SFD is explicitly labelled as effective rather than being
// printed as an unadjusted reference that would be compensated a second time.
const built = G.buildParams({ ...G.defaultsFor(G.SAT_FIELDS), sfdGtRef: '2' },
  G.defaultsFor(G.CARRIER_FIELDS), G.defaultsFor(G.TX_FIELDS), G.defaultsFor(G.RX_FIELDS))
const compensated = computeLinkMode(built.satParams, built.linkParams, { mode: 'margin', captureInputs: true })
assert.equal(compensated.effectiveInputs.satParams.sfdRef, -82)
assert.equal(rowOf(buildInputDigest(G.FIELD_GROUPS, reportInputParams(built, compensated.effectiveInputs), 'zh'), 'sat', 'SFDref（有效）').value, '-82')
const overdrive = computeLinkMode(built.satParams, built.linkParams, { mode: 'overbalance', overDb: '', captureInputs: true })
const overdriveParams = reportInputParams({ ...built, opt: { mode: 'overbalance', overDb: '' } }, overdrive.effectiveInputs)
assert.equal(overdriveParams.opt.overDb, 0)
assert.equal(calcBlock({ overDb: overdriveParams.opt.overDb }, 'zh').rows[0].value, '0', 'Default zero overdrive is printed instead of disappearing')

// Apply the mode projection after merging defaults so mirrored ground stations
// and transponder placeholders cannot reappear in a regenerative report.
const up = regenDigestParams('uplink', effective), down = regenDigestParams('downlink', effective)
assert.equal(up.linkParams.rxLongitude, undefined)
assert.equal(up.linkParams.rxAntennaDiameter, undefined)
assert.equal(down.linkParams.longitude, undefined)
assert.equal(down.linkParams.antennaDiameter, undefined)
assert.equal(down.linkParams.rxAntennaDiameter, 3.7)

const regen = computeRegenUplinkMode({ frequencyBand: 'Ku' }, { orbitAltitude: 1200, rxOrbitAltitude: 1200, margin: '' }, { mode: 'margin', captureInputs: true })
assert.equal(regen.success, true)
assert.equal(regen.effectiveInputs.targetMargin, 3)
assert.notEqual(regen.effectiveInputs.linkParams.margin, 3, 'Regenerative solving uses a different internal bent-pipe margin')
const regenInputs = buildInputDigest(REGEN_FIELDS, regenDigestParams('uplink', reportInputParams(null, regen.effectiveInputs)), 'zh')
assert.equal(rowOf(regenInputs, 'carrier', '系统余量').value, '3', 'Report retains the actual target, including its blank-input default')

// Laser budgets have no RF sweep snapshot; their effective optical inputs still
// reach the report, including explicit zero pointing loss and default wavelength.
const laser = computeRegenLaserIslMode({ islHopDistance: 1000, txPointingErrUrad: 0 }, { captureInputs: true })
assert.equal(laser.success, true)
const optical = buildInputDigest(REGEN_FIELDS, regenDigestParams('laser', reportInputParams(null, laser.effectiveInputs)), 'zh')
assert.equal(rowOf(optical, 'laser', '波长 λ').value, '1550')
assert.equal(rowOf(optical, 'laser', '发射指向误差').value, '0')
assert.equal(optical.length, 1)
assert.equal(JSON.stringify(params), before)
console.log('lbReportEffectiveInputs: engine defaults, zero, conditional values, topology and Word/Excel exports passed')
