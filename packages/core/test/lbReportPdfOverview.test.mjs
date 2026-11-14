import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { buildReportModel } from '../../../src/shared/lbReport.js'

const require = createRequire(import.meta.url)
const { parse, compileScript } = require('@vue/compiler-sfc')
const { transformSync } = require('esbuild')
const { topologyReference } = require('../../../electron/services/reportTopologyReference')
const { buildReportPresentation } = require('../../../electron/services/reportPresentation')
const { enrichReportModel } = require('../../../electron/services/report')

// Exercise the actual print-model handoff and Vue component output in Node.
const handlers = new Map(), printed = []
let cascadeCalls = 0
const cascadeParts = [{ data: Buffer.from('cascade-part-one'), w: 1800, h: 380,
  title: '#1 actual cascade', caption: '#1 actual cascade - 1 / 2', linkNo: 1, part: 1, parts: 2 },
{ data: Buffer.from('cascade-part-two'), w: 1800, h: 380,
  title: '#1 continued cascade', caption: '#1 actual cascade - 2 / 2', linkNo: 1, part: 2, parts: 2 }]
class PrintWindow {
  destroyed = false
  webContents = {
    executeJavaScript: async () => ({ ready: true }),
    printToPDF: async (options) => {
      printed.push({ model: handlers.get('report:print:model')(), options })
      return Buffer.from('PDF')
    }
  }
  async loadURL() {}
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
const originalLoad = Module._load
let buildReportPdf
try {
  Module._load = function (id, ...args) {
    if (id === 'electron') return {
      BrowserWindow: PrintWindow, app: { getAppPath: () => process.cwd() },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} }
    }
    if (id === './reportCascadeTopology') return { cascadeTopologyFigures: async (model, options) => {
      assert.equal(options.style, 'pdf', 'The PDF selects its own diagram palette and typography')
      cascadeCalls++
      await Promise.resolve()
      return model.scheme?.orbitType === 'E2E' ? cascadeParts : []
    } }
    return originalLoad.call(this, id, ...args)
  }
  ;({ buildReportPdf } = require('../../../electron/services/reportPdf'))
} finally { Module._load = originalLoad }

const filename = fileURLToPath(new URL('../../../src/report/ReportOverview.vue', import.meta.url))
const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
const compiled = compileScript(descriptor, { id: 'pdf-overview', inlineTemplate: true, templateOptions: { ssr: true } })
const componentModule = new Module(filename)
componentModule.filename = filename
componentModule.paths = require.resolve.paths('vue')
componentModule._compile(transformSync(compiled.content, { format: 'cjs' }).code, filename)
const ReportOverview = componentModule.exports.default
const fixture = (lang, orbitType = 'GEO') => {
  const model = buildReportModel({ lang, orbitType, satelliteName: 'SAT-1', frequencyBand: 'Ku',
    links: [{ no: 1, txName: 'TX-1', rxName: 'RX-1', ok: true, data: { linkmargin: '2.50' },
      figures: [{ title: 'Budget contour', dataUrl: 'data:image/png;base64,cHJlc2VydmVk' }] }] })
  enrichReportModel(model)
  return model
}

for (const lang of ['zh', 'en']) {
  const model = fixture(lang), before = JSON.stringify(model.links)
  const expected = topologyReference(model), presentation = buildReportPresentation(model)
  assert.equal((await buildReportPdf(model)).toString(), 'PDF')
  const { model: handedOff, options } = printed.at(-1)
  assert.equal(handedOff.presentation.intro, presentation.intro, 'PDF and Word use the same snapshot-derived overview')
  assert.deepEqual(Buffer.from(handedOff.topologyReference.dataUrl.split(',')[1], 'base64'), expected.data,
    'The PDF embeds the exact PNG used by Word')
  assert.ok(handedOff.topologyReference.dataUrl.startsWith('data:image/png;base64,'))
  assert.equal(handedOff.topologyReference.caption, expected.caption, 'Figure attribution is retained')
  assert.equal(JSON.stringify(model.links), before, 'The existing detailed figures and calculation values remain intact')
  assert.ok(options.printBackground && options.preferCSSPageSize, 'The existing PDF print style is retained')
  const html = await renderToString(createSSRApp(ReportOverview, { model: handedOff }))
  assert.ok(html.includes(lang === 'en' ? 'Solution overview' : '方案概述'))
  assert.ok(html.includes(presentation.intro))
  assert.ok(html.includes(handedOff.topologyReference.dataUrl) && html.includes(expected.caption),
    'The print page renders the illustration and source caption, not just model metadata')
  assert.ok(html.includes('943') && html.includes('398'), 'The original aspect ratio is available before decoding')
}
for (const lang of ['zh', 'en']) for (const orbitType of ['REGEN', 'E2E']) {
  const model = fixture(lang, orbitType), before = JSON.stringify(model.links)
  await buildReportPdf(model)
  const reference = topologyReference(model)
  const html = await renderToString(createSSRApp(ReportOverview, { model }))
  assert.ok(html.includes(lang === 'en' ? 'Solution overview' : '方案概述'))
  const cascade = model.cascadeTopologyFigures
  if (orbitType === 'E2E') {
    assert.equal(reference, null, 'End-to-end reports use actual cascades without a generic reference picture')
    assert.equal(model.topologyReference, null)
    assert.equal(cascade.length, 2, 'All asynchronously rendered continuation panels reach the print page')
    for (const [i, part] of cascade.entries()) {
      assert.deepEqual(Buffer.from(part.dataUrl.split(',')[1], 'base64'), cascadeParts[i].data)
      assert.equal(part.caption, cascadeParts[i].caption)
      assert.equal(part.linkNo, 1); assert.equal(part.part, i + 1); assert.equal(part.parts, 2)
      assert.ok(html.includes(part.dataUrl) && html.includes(part.caption))
    }
    assert.ok(html.includes(lang === 'en' ? 'Actual cascade topology' : '实际级联拓扑'))
    assert.ok(html.indexOf(cascade[0].dataUrl) < html.indexOf(cascade[1].dataUrl), 'Continuation panels retain link order')
  } else {
    assert.ok(reference, 'Regenerative reports have a ground-antenna-to-satellite reference illustration')
    assert.equal(reference.mimeType, 'image/jpeg')
    assert.ok(model.topologyReference.dataUrl.startsWith('data:image/jpeg;base64,'), 'The JPEG keeps its actual image MIME type')
    assert.deepEqual(Buffer.from(model.topologyReference.dataUrl.split(',')[1], 'base64'), reference.data,
      'Regenerative PDF and Word embed the same original MIT JPEG bytes')
    assert.match(reference.source, /haystack\.mit\.edu/)
    assert.equal(model.topologyReference.caption, reference.caption)
    assert.ok(html.includes(reference.caption), 'The matching reference image retains its source attribution')
    assert.ok(html.includes('1319') && html.includes('525'), 'The original JPEG aspect ratio is retained')
    assert.equal(cascade.length, 0, 'The actual cascade drawing is restricted to end-to-end reports')
    assert.ok(!html.includes('rp-cascade-figure'))
  }
  assert.equal(JSON.stringify(model.links), before, 'Topology preparation does not modify calculation snapshots')
}
const sla = { kind: 'sla', lang: 'en', doc: {}, links: [] }
const callsBeforeSla = cascadeCalls
await buildReportPdf(sla)
assert.ok(!sla.topologyReference, 'Standalone SLA reports retain their own content and layout')
assert.equal(cascadeCalls, callsBeforeSla, 'Standalone SLA reports do not generate unrelated cascade drawings')
console.log('PASS PDF overview, exact Word illustration and attribution, architecture scope, print-model handoff and rendered HTML')
