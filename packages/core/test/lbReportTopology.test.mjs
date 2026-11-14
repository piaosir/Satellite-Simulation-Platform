import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { linkTopologyOf, topologyEdgeFrequency } from '../../../src/shared/lbReportTopology.js'
import { newHop, newEsNode, newSatNode, hopTypeOf } from '../../../src/e2e/e2eParams.js'
import { buildReportModel } from '../../../src/shared/lbReport.js'
const require = createRequire(import.meta.url)
const { topologyReference, SOURCE, IMAGE_SOURCE, REGEN_SOURCE } = require('../../../electron/services/reportTopologyReference')
const { buildReportDocx } = require('../../../electron/services/reportDocx')
const { enrichReportModel } = require('../../../electron/services/report')
const JSZip = require('jszip')
const base = { no: 1, txName: 'Station A', rxName: 'Station B', ok: true, data: { linkmargin: '3' }, inputs: [], segments: [] }
for (const lang of ['zh', 'en']) {
  const topology = linkTopologyOf(base, 'GEO', '', { satParams: { satelliteName: 'SAT-1' }, linkParams: { centerFrequency: '30', rxCenterFrequency: '20' } }, lang)
  assert.deepEqual(topology.nodes.map((n) => n.name), ['Station A', 'SAT-1', 'Station B'])
  assert.deepEqual(topology.edges.map((e) => e.frequency), ['30 GHz', '20 GHz'])
  const model = buildReportModel({ lang, links: [{ ...base, topology }], satelliteName: 'SAT-1' })
  enrichReportModel(model)
  const image = topologyReference(model)
  assert.equal(createHash('sha256').update(image.data).digest('hex'), '0e9338a74769df73e85d00d7d68e90862aab1dec7197867204bb13da19f107c4', 'The original online image is retained byte for byte')
  assert.equal(SOURCE, 'https://www.mathworks.com/help/satcom/gs/satellite-link-budget.html')
  assert.equal(IMAGE_SOURCE, 'https://www.mathworks.com/help/satcom/gs/intro_slb.png')
  const before = JSON.stringify(model.links[0].data)
  const zip = await JSZip.loadAsync(await buildReportDocx(model))
  const xml = await zip.file('word/document.xml').async('string')
  assert.ok(xml.includes('MathWorks') && xml.includes('ReferenceTopology'))
  const media = await Promise.all(Object.values(zip.files).filter((f) => f.name.startsWith('word/media/') && !f.dir).map((f) => f.async('nodebuffer')))
  assert.ok(media.some((b) => b.equals(image.data)), 'Word uses the actual online picture rather than a redrawn placeholder')
  assert.equal(JSON.stringify(model.links[0].data), before)
  assert.ok(xml.includes('SAT-1'), 'Actual configured nodes remain in the solution schedule')
}
for (const mode of ['uplink', 'downlink', 'isl', 'laser']) {
  const t = linkTopologyOf({ ...base, data: { laserWavelengthResult: '1550.000' } }, 'REGEN', mode, null, 'en')
  assert.equal(t.nodes.length, 2)
  const reference = topologyReference({ scheme: { orbitType: 'REGEN' } })
  assert.ok(reference.caption.includes('MIT Haystack') && reference.caption.includes('星地'), 'Regenerative reports use the selected ground-dish-to-satellite illustration')
  assert.equal(reference.source, REGEN_SOURCE); assert.equal(reference.sourcePage, 9)
  assert.equal(reference.type, 'jpg'); assert.equal(reference.mimeType, 'image/jpeg')
  assert.equal(createHash('sha256').update(reference.data).digest('hex'), 'cd793c31c9965449623a0669d697abc806367b985ff1dff5644eac5ab44d4c61', 'The embedded MIT original is preserved byte for byte')
  if (mode === 'laser') assert.equal(t.edges[0].frequency, '1550.000 nm')
}
assert.equal(topologyReference({ scheme: { orbitType: 'E2E' } }), null, 'End-to-end reports use only their actual cascade diagrams')
assert.equal(linkTopologyOf(base, 'E2E'), null)
const changed = newHop('laser'), a = newEsNode('A'), b = newSatNode('regen', 'S1')
assert.equal(topologyEdgeFrequency(hopTypeOf(a, b, changed), changed), '14.25 GHz')
assert.ok(!fs.readFileSync(new URL('../../../src/shared/lbReportTopology.js', import.meta.url), 'utf8').includes('<svg'), 'The generated topology drawing path has been removed')
console.log('PASS original online topology image, scope, actual node metadata and no redraw')
