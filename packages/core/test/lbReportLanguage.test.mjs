import assert from 'node:assert/strict'
import { useLbReport } from '../../../src/shared/useLbReport.js'
import { buildCapModel, CAP_PBW } from '../../../src/shared/lbCapacity.js'
import { pinReportTitle, resolveReportTitle } from '../../../src/shared/lbReport.js'
import { reportDiagnosticTranslator, localizeReportLinkDiagnostics, reportClassification } from '../../../src/shared/lbReportDiagnostics.js'
import { createRequire } from 'node:module'

// Exercise the actual export composable with a Chinese UI and an English report,
// including chart capture and the separately generated SLA / capacity models.
const source = { linkmargin: '3.125', allocBandwidthResult: '1200', capacityResult: '2400' }
const link = { rowId: 'r1', txName: 'TX', rxName: 'RX', ok: true, error: '', data: source }
const exports = [], errors = [], captures = [], langs = []
let selected = 7, failCapture = false
const enText = (lang, en, zh) => { langs.push(lang); return lang === 'en' ? en : zh }
const cap = buildCapModel([{ no: 1, rowId: 'r1', name: 'TX → RX', carrier: 'QPSK',
  gkey: 's1', gname: 'SAT-A', ok: true, tpBwMHz: 36, capKbps: 2400, bwKHz: 1200, pbwKHz: 1600 }], null, { pbw: CAP_PBW.SUM })
const flow = useLbReport({
  api: { report: { exportReport: async (payload) => { exports.push(payload); return { ok: true, files: ['report.pdf'] } } } },
  lang: () => 'zh', orbitType: 'GEO', links: () => [link], appVersion: () => 'test',
  calc: (lang) => ({ satelliteName: 'SAT-A', frequencyBand: 'Ku', mode: enText(lang, 'Given working point', '给定工作点') }),
  calcFor: (_l, lang) => ({ solveMode: enText(lang, 'Fixed HPA', '固定功放') }),
  fieldGroups: [], paramsFor: () => ({}), carrierOf: () => ({ dvbStandard: 'DVB-S2' }),
  showViz: () => true, selected: () => selected, setSelected: (i) => { selected = i }, nextTick: async () => {},
  vizRef: () => ({ captureFigures: async (o) => { captures.push(o); if (failCapture) throw new Error('capture failed'); return [{ title: 'Link view', dataUrl: 'data:image/png;base64,AA==' }] } }),
  slaCount: () => 1,
  slaFor: (_l, lang) => ({ rows: [{ key: 'sysAvail', label: enText(lang, 'System availability', '系统可用度'),
    group: 'availability', groupLabel: enText(lang, 'Availability', '可用度'), basis: '99.950', suggest: '99.950', adopt: '', value: '99.950', unit: '%' }] }),
  slaParams: (lang) => [{ label: enText(lang, 'Equipment availability', '设备可用度'), value: '99.99', unit: '%' }],
  slaComposition: (_key, lang) => [{ label: enText(lang, 'Earth station', '地球站'), count: 2, value: '99.99' }],
  slaExtra: () => ({ carrierStd: 'DVB-S2' }),
  capModelFor: () => cap,
  capFor: (_key, lang) => ({ head: ['Parameter', 'SAT-A'], rows: [[enText(lang, 'Capacity', '容量'), '2400']] }),
  defaultName: (en) => en ? 'Link_Budget' : '链路预算',
  toast: () => {}, setError: (e) => errors.push(e)
})

await flow.runReport({ lang: 'en', formats: ['pdf'], doc: {}, withSla: true, withFigures: true })
assert.equal(errors.length, 0)
assert.equal(exports[0].model.lang, 'en')
assert.equal(exports[0].model.calc.mode, 'Given working point')
assert.equal(exports[0].model.links[0].inputs[0].rows[1].value, 'Fixed HPA')
assert.equal(exports[0].model.links[0].sla.rows[0].label, 'System availability')
assert.equal(exports[0].model.capacity[0].rows[0][0], 'Capacity')
assert.equal(exports[0].model.slaParams[0].label, 'Equipment availability')
assert.equal(exports[0].defaultName, 'Link_Budget')
assert.equal(captures[0].lang, 'en')
assert.equal(selected, 7)
assert.deepEqual(exports[0].model.links[0].data, source)
assert.notEqual(exports[0].model.links[0].data, source)

await flow.runSlaReport({ lang: 'en', formats: ['pdf'], doc: {} })
assert.equal(exports[1].model.kind, 'sla')
assert.equal(exports[1].model.lang, 'en')
assert.equal(exports[1].model.composition[0].label, 'Earth station')
assert.equal(exports[1].model.links[0].sla.rows[0].label, 'System availability')
assert.deepEqual(exports[1].formats, ['pdf'])

await flow.runCapReport({ lang: 'en', formats: ['pdf'], doc: {} })
assert.equal(exports[2].model.kind, 'cap')
assert.equal(exports[2].model.lang, 'en')
assert.ok(exports[2].model.sections[0].detail[0].head.includes('Carriers'))
assert.deepEqual(exports[2].formats, ['pdf'])
assert.ok(langs.every((l) => l === 'en'))

// Missing export language preserves the UI language for existing callers.
await flow.runReport({ formats: ['xlsx'], doc: {} })
assert.equal(exports[3].model.lang, 'zh')
assert.equal(exports[3].model.calc.mode, '给定工作点')
assert.equal(exports[0].model.lang, 'en')

// A failed figure must restore the selected link while allowing the numeric report.
failCapture = true
const oldWarn = console.warn
console.warn = () => {}
try { await flow.runReport({ lang: 'en', formats: ['pdf'], doc: {}, withFigures: true }) } finally { console.warn = oldWarn }
assert.equal(selected, 7)
assert.equal(flow.reportDlg.busy, false)
assert.equal(errors.length, 0)
assert.deepEqual(source, { linkmargin: '3.125', allocBandwidthResult: '1200', capacityResult: '2400' })

// A custom title in one language must not leak into the other language.
const zhTitle = 'SAT-A 卫星 Ku 频段链路预算报告'
const enTitle = 'SAT-A Satellite Ku Band Link Budget Report'
let pins = pinReportTitle(null, zhTitle, '客户甲方案')
assert.equal(resolveReportTitle(pins, enTitle), enTitle)
pins = pinReportTitle(pins, enTitle, 'Customer A solution')
assert.equal(resolveReportTitle(pins, zhTitle), '客户甲方案')
assert.equal(resolveReportTitle(pins, enTitle), 'Customer A solution')

const diagnostic = await reportDiagnosticTranslator('en')
const require = createRequire(import.meta.url)
const solver = require('../utils/modeSolver.js')
const geometry = require('../utils/ngsoGeometry.js')
const engineError = solver.computeLinkMode({}, {}, { mode: 'power', powerW: 0 }).message
assert.equal(diagnostic(engineError), 'Amplifier power (W) is invalid')
const geoError = geometry.solveStaticGeometry({ orbit: { lonDeg: 0, altKm: 35786 }, tx: { lonDeg: 180, latDeg: 0 }, rx: { lonDeg: 180, latDeg: 0 } }).reason
assert.ok(!/[\u4e00-\u9fff]/.test(diagnostic(geoError)))
assert.deepEqual(diagnostic(geoError).match(/-?\d+(?:\.\d+)?/g), geoError.match(/-?\d+(?:\.\d+)?/g), 'Geometry diagnostic details retain all numeric values')
const visibilityError = '卫星不可见（发端仰角 -3.25°，收端仰角 -0.04°）'
assert.equal(diagnostic(visibilityError), 'Satellite not visible (Tx elevation -3.25°, Rx elevation -0.04°)')
assert.equal(diagnostic('第 3 跳几何无解：SGP4 初始化失败（error=6）'), 'Hop 3: no geometry solution: SGP4 initialization failed (error=6)')
assert.equal(diagnostic('计算失败（第 2 跳）：' + engineError), 'Computation failed (hop 2): Amplifier power (W) is invalid')
assert.equal(diagnostic('天线口径：超出范围 (0, 100]；轨道高度：不是数值'), 'Antenna Diameter: Out of range (0, 100]; Orbital Altitude: Not numeric')
assert.equal(diagnostic('第 2 跳：地球站「计算失败」缺经纬度，无法解几何'), 'Hop 2: Earth station “计算失败” has no coordinates, the geometry cannot be solved', 'Quoted custom names are preserved even when they match a dictionary entry')
const original = { error: visibilityError, data: source, geom: { feasible: false, reason: geoError, sampleCount: 18 } }
const localized = localizeReportLinkDiagnostics(original, diagnostic)
assert.equal(localized.geom.sampleCount, 18)
assert.equal(localized.data, source)
assert.equal(original.geom.reason, geoError)
assert.equal(localized.error, diagnostic(visibilityError))
assert.equal((await reportDiagnosticTranslator('zh'))(visibilityError), visibilityError)
assert.equal(diagnostic('Customer supplied diagnostic'), 'Customer supplied diagnostic')
link.error = visibilityError
await flow.runReport({ lang: 'en', formats: ['pdf'], doc: {} })
assert.equal(exports.at(-1).model.links[0].error, diagnostic(visibilityError))
await flow.runSlaReport({ lang: 'en', formats: ['pdf'], doc: {} })
assert.equal(exports.at(-1).model.links[0].error, diagnostic(visibilityError))
assert.equal(link.error, visibilityError, 'The source calculation record retains its original diagnostic')
link.error = ''
assert.equal(reportClassification('内部', 'en'), 'Internal')
assert.equal(reportClassification('Internal', 'zh'), '内部')
assert.equal(reportClassification('客户甲专用', 'en'), '客户甲专用')
console.log('PASS independent report language, model consistency, PDF payloads and figure recovery')
const { testReportFigureCapture } = await import('./helpers/reportFigureCapture.mjs')
await testReportFigureCapture()
