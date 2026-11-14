import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { cascadeTopologyDiagrams, cascadeTopologyFigures } = require('../../../electron/services/reportCascadeTopology')
const { topologyReference } = require('../../../electron/services/reportTopologyReference')
const { buildReportDocx } = require('../../../electron/services/reportDocx')
const JSZip = require('jszip'), sharp = require('sharp')

const makeLink = (length, no = 1) => ({ no, data: { linkmargin: '3' }, inputs: [], segments: [], txName: 'TX', rxName: 'RX',
  topology: { nodes: Array.from({ length }, (_, i) => ({ kind: i === 0 || i === length - 1 || i === 6 ? 'ground' : i % 2 ? 'regen' : 'transparent',
    name: `Node-${String(i + 1).padStart(2, '0')}` })),
  edges: Array.from({ length: length - 1 }, (_, i) => ({ type: i === 0 ? 'up' : i === length - 2 ? 'down' : i % 2 ? 'laser' : 'isl', frequency: i % 2 ? '1550 nm' : '23 GHz' })) } })
for (const lang of ['zh', 'en']) {
  const link = makeLink(27, 8), before = JSON.stringify(link)
  const model = { lang, scheme: { orbitType: 'E2E' }, links: [link], doc: {} }
  const pages = cascadeTopologyDiagrams(model)
  assert.ok(pages.length >= 3)
  assert.equal(pages[0].start, 0); assert.equal(pages.at(-1).end, 26)
  let edgeCount = 0
  for (const [index, page] of pages.entries()) {
    assert.equal(page.part, index + 1); assert.equal(page.parts, pages.length)
    assert.equal(page.linkNo, 8); assert.ok(page.h <= 1100)
    if (index) assert.equal(page.start, pages[index - 1].end, 'Continuation repeats only its shared boundary node')
    for (let i = page.start; i <= page.end; i++) assert.ok(page.svg.includes(`Node-${String(i + 1).padStart(2, '0')}`))
    edgeCount += (page.svg.match(/marker-end=/g) || []).length
    assert.ok(page.caption.includes('#8') && page.caption.includes(`${index + 1}/${pages.length}`))
  }
  assert.equal(edgeCount, 26, 'Every actual hop appears exactly once across continuation figures')
  assert.ok(pages.some((p) => p.svg.includes(lang === 'en' ? 'Ground relay' : '地面转接站')))
  assert.ok(pages.some((p) => p.svg.includes(lang === 'en' ? 'Transparent satellite' : '透明卫星')))
  assert.ok(pages.some((p) => p.svg.includes(lang === 'en' ? 'Regenerative satellite' : '再生卫星')))
  assert.equal(JSON.stringify(link), before, 'Rendering leaves the computation and topology snapshots unchanged')
  const pdf = cascadeTopologyDiagrams(model, { style: 'pdf' })
  assert.ok(pdf[0].svg.includes('#000080') && pdf[0].svg.includes('Verdana'))
  assert.ok(pages[0].svg.includes('#111111') && !pages[0].svg.includes('Verdana'), 'Word and PDF keep their own style')
  const single = { ...model, links: [makeLink(2)] }
  const rendered = await cascadeTopologyFigures(single, { rasterize: (svg) => sharp(Buffer.from(svg)).png().toBuffer() })
  assert.equal(rendered.length, 1)
  const metadata = await sharp(rendered[0].data).metadata()
  assert.equal(metadata.width, rendered[0].w); assert.equal(metadata.height, rendered[0].h)
  assert.equal(metadata.format, 'png')
}
const dangerous = makeLink(3)
dangerous.topology.nodes[1].name = '<script>&"两颗星'
const safe = cascadeTopologyDiagrams({ scheme: { orbitType: 'E2E' }, links: [dangerous] })[0]
assert.ok(!safe.svg.includes('<script>') && safe.svg.includes('&lt;script&gt;&amp;&quot;'))
const failed = { ...makeLink(3), data: null, error: 'Missing hop' }
failed.topology.edges[0] = { type: 'unknown', missing: true, invalid: true }
const failedFig = cascadeTopologyDiagrams({ lang: 'en', scheme: { orbitType: 'E2E' }, links: [failed] })[0]
assert.ok(failedFig.caption.includes('Configuration only'))
assert.ok(failedFig.svg.includes('Missing link') && failedFig.svg.includes('stroke-dasharray'))
assert.equal((failedFig.svg.match(/marker-end=/g) || []).length, 1, 'Missing hops have a dashed indication rather than a verified signal arrow')
assert.deepEqual(cascadeTopologyDiagrams({ scheme: { orbitType: 'REGEN' }, links: [makeLink(4)] }), [])
assert.deepEqual(cascadeTopologyDiagrams({ kind: 'sla', scheme: { orbitType: 'E2E' }, links: [makeLink(4)] }), [])
assert.deepEqual(cascadeTopologyDiagrams({ scheme: { orbitType: 'E2E' }, links: [{ no: 1, data: {} }] }), [])
for (const orbitType of ['REGEN', 'E2E']) for (const lang of ['zh', 'en']) {
  const model = { lang, scheme: { orbitType }, doc: {}, t: {}, links: [] }
  const expected = topologyReference(model)
  const zip = await JSZip.loadAsync(await buildReportDocx(model)), xml = await zip.file('word/document.xml').async('string')
  const media = await Promise.all(Object.values(zip.files).filter((f) => f.name.startsWith('word/media/') && !f.dir).map((f) => f.async('nodebuffer')))
  if (expected) {
    assert.ok(media.some((data) => data.equals(expected.data)), `${orbitType} Word embeds the selected original image`)
    assert.ok(xml.includes(expected.caption) && xml.includes('MIT Haystack'))
    assert.ok(Object.keys(zip.files).some((name) => /word\/media\/.*\.jpg$/.test(name)), 'Word correctly declares the original JPEG format')
  } else {
    assert.equal(orbitType, 'E2E')
    assert.ok(!xml.includes('ReferenceTopology'), 'End-to-end Word has no generic reference illustration')
    assert.equal(media.length, 0, 'No unrequested stock image remains when an end-to-end report has no cascade to draw')
  }
  assert.ok(!xml.includes('Wikimedia'), 'The superseded satellite-to-satellite picture and attribution are gone')
  assert.ok(!xml.includes('MathWorks'), 'The transparent-link reference is not reused for another architecture')
}
console.log('PASS actual cascade figures: full hop coverage, continuation, mixed node roles, missing links, escaping, format styles, PNG rendering, and Word illustration')
