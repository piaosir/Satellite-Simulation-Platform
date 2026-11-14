import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { createRequire } from 'node:module'
import { LOGO_KEY, saveLogo, loadLogo, createLogoSelection } from '../../../src/shared/reportLogo.js'
import { buildReportModel } from '../../../src/shared/lbReport.js'
import { buildSlaReportModel } from '../../../src/shared/lbSlaReport.js'
import { buildCapModel } from '../../../src/shared/lbCapacity.js'
import { buildCapReportModel } from '../../../src/shared/lbCapReport.js'

const require = createRequire(import.meta.url)
const JSZip = require('jszip'), ExcelJS = require('exceljs')
const report = require('../../../electron/services/report.js')
const { logoImage, fitLogo } = require('../../../electron/services/reportLogoImage.js')
const { buildSlaWorkbook } = require('../../../electron/services/reportSla.js')
const { buildCapWorkbook } = require('../../../electron/services/reportCap.js')
const { buildReportDocx } = require('../../../electron/services/reportDocx.js')
const { buildSlaDocx } = require('../../../electron/services/reportSlaDocx.js')
const { buildCapDocx } = require('../../../electron/services/reportCapDocx.js')

// Small real PNGs with different dimensions and colors catch stale replacements
// and exporters that trust obsolete width/height metadata over the selected file.
function png(w, h, rgb) {
  const crc = (data) => {
    let n = 0xffffffff
    for (const b of data) { n ^= b; for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0) }
    return (n ^ 0xffffffff) >>> 0
  }
  const chunk = (name, value) => {
    const tag = Buffer.from(name), len = Buffer.alloc(4), sum = Buffer.alloc(4)
    len.writeUInt32BE(value.length); sum.writeUInt32BE(crc(Buffer.concat([tag, value])))
    return Buffer.concat([len, tag, value, sum])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const rows = Array.from({ length: h }, () => Buffer.from([0, ...Array.from({ length: w }, () => rgb).flat()]))
  const buffer = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))])
  return { dataUrl: 'data:image/png;base64,' + buffer.toString('base64'), w: 999, h: 1, buffer }
}
const a = png(16, 8, [0, 80, 200]), b = png(6, 18, [180, 0, 90])
assert.equal(logoImage(a).w, 16); assert.equal(logoImage(b).h, 18)
assert.deepEqual([fitLogo(a, 140, 46).width, fitLogo(a, 140, 46).height], [92, 46])
assert.deepEqual([fitLogo(b, 140, 46).width, fitLogo(b, 140, 46).height], [15, 46])
assert.equal(logoImage(null), null)
assert.equal(logoImage({ dataUrl: 'data:image/png;base64,bm90IGEgcG5n' }), null)
assert.equal(logoImage({ dataUrl: 'https://example.com/logo.png' }), null)

// Upload/replace/remove persist through the one shared store used by every
// workbench. Failed or late decoding cannot revive an old or removed image.
const memory = new Map()
globalThis.localStorage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) }
assert.deepEqual(loadLogo(), { logo: null, name: '' })
let selected = null, name = '', busy = false, errors = 0
const selection = createLogoSelection({
  apply: (logo, fileName) => { selected = logo; name = fileName; saveLogo(logo, fileName) },
  pending: (value) => { busy = value }, error: () => { errors++ }
})
await selection.select(async () => a, 'A.png')
assert.equal(loadLogo().logo.dataUrl, a.dataUrl); assert.equal(name, 'A.png')
await selection.select(async () => { throw new Error('decode') }, 'bad.png')
assert.equal(errors, 1); assert.equal(selected, a); assert.equal(loadLogo().name, 'A.png')
let finishOld
const old = selection.select(() => new Promise((resolve) => { finishOld = resolve }), 'old.png')
await selection.select(async () => b, 'B.png'); finishOld(a); await old
assert.equal(selected, b); assert.equal(loadLogo().logo.dataUrl, b.dataUrl); assert.equal(busy, false)
let finishRemoved
const removed = selection.select(() => new Promise((resolve) => { finishRemoved = resolve }), 'late.png')
assert.equal(busy, true); selection.clear(); finishRemoved(a); await removed
assert.equal(selected, null); assert.equal(name, ''); assert.equal(busy, false)
assert.equal(memory.has(LOGO_KEY), false); assert.deepEqual(loadLogo(), { logo: null, name: '' })
let finishClosed
const closed = selection.select(() => new Promise((resolve) => { finishClosed = resolve }), 'closed.png')
selection.cancel(); finishClosed(b); await closed
assert.equal(selected, null); assert.equal(memory.has(LOGO_KEY), false)

// Exercise the PDF exporter itself, replacing only Electron's window surface.
let handler, pdfOptions
class Window {
  destroyed = false
  webContents = { executeJavaScript: async () => ({ ready: true, error: '' }), printToPDF: async (opts) => { pdfOptions = opts; return Buffer.from('%PDF-test') } }
  async loadURL() { assert.ok(handler()) }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
const pdfModule = { exports: {} }
const serviceRequire = createRequire(new URL('../../../electron/services/reportPdf.js', import.meta.url))
vm.runInNewContext(fs.readFileSync(new URL('../../../electron/services/reportPdf.js', import.meta.url), 'utf8'), {
  require: (id) => id === 'electron' ? { BrowserWindow: Window, app: { getAppPath: () => 'C:/test' }, ipcMain: { handle: (_n, cb) => { handler = cb }, on: () => {} } } : serviceRequire(id),
  module: pdfModule, process: { env: {} }, Promise, Date, Error, String, setTimeout
})

function model(kind, lang, logo, orbitType = 'GEO') {
  const doc = { title: 'Custom identity', logo }, link = { no: 1, rowId: 'a', txName: 'TX', rxName: 'RX', ok: true, data: { linkmargin: '2.40' }, inputs: [], segments: [], figures: [] }
  if (kind === 'full') {
    const result = buildReportModel({ lang, orbitType, regenMode: 'uplink', doc, links: [link] }); report.enrichReportModel(result); return result
  }
  if (kind === 'sla') return buildSlaReportModel({ lang, orbitType, doc, links: [{ ...link, sla: { rows: [{ key: 'sysAvail', group: 'availability', label: 'Availability', unit: '%', basis: '99.800', suggest: '99.700', adopt: '99.600', value: '99.600' }] } }] })
  const capacity = buildCapModel([{ no: 1, rowId: 'a', name: 'TX-RX', carrier: 'QPSK', ok: true, gkey: 'sat', gname: 'SAT', tpBwMHz: 36, capKbps: 2000, bwKHz: 1350, pbwKHz: 1800 }], null, {})
  return buildCapReportModel({ lang, orbitType, doc, sections: [{ key: '', title: '', model: capacity, noOf: () => 1 }] })
}
const exporters = { full: [report.buildReportWorkbook, buildReportDocx], sla: [buildSlaWorkbook, buildSlaDocx], cap: [buildCapWorkbook, buildCapDocx] }
for (const lang of ['zh', 'en']) for (const kind of ['full', 'sla', 'cap']) {
  for (const logo of [null, a, b, null]) {
    const m = model(kind, lang, logo), [xlsx, docx] = exporters[kind]
    assert.equal(m.doc.logo, logo)
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(await xlsx(m))
    for (const sheet of workbook.worksheets) {
      const images = sheet.getImages()
      assert.equal(images.length, logo ? 1 : 0, `${kind}/${lang}/${sheet.name}: custom logo only`)
      if (logo) {
        assert.ok(Buffer.from(workbook.getImage(images[0].imageId).buffer).equals(logo.buffer))
        assert.equal(images[0].range.tl.nativeCol, 0, 'Excel logos are anchored on the left')
        assert.equal(images[0].range.tl.nativeColOff, 0)
        assert.ok(sheet.getRow(1).height + sheet.getRow(2).height >= fitLogo(logo, 140, 46).height * .75 + 3, 'The logo has its own lane above the row-3 title')
      }
    }
    const zip = await JSZip.loadAsync(await docx(m))
    const headers = zip.file(/^word\/header\d+\.xml$/)
    assert.ok(headers.length)
    for (const header of headers) {
      const xml = await header.async('string')
      assert.equal(xml.includes('<w:drawing>'), !!logo, `${kind}/${lang}: every Word header uses the chosen image`)
      if (logo) assert.ok(xml.includes('<w:jc w:val="left"/>'), 'Word logos are on the left')
    }
    if (logo) {
      const media = await Promise.all(zip.file(/^word\/media\//).filter((f) => !f.dir).map((f) => f.async('nodebuffer')))
      assert.ok(media.some((data) => data.equals(logo.buffer)), 'The Word image is the replacement file')
    }
    await pdfModule.exports.buildReportPdf(m)
    assert.equal(pdfOptions.headerTemplate.includes('<img '), !!logo, `${kind}/${lang}: PDF logo removal`)
    if (logo) {
      assert.ok(pdfOptions.headerTemplate.includes(logo.dataUrl), 'The PDF header embeds the selected file')
      assert.ok(pdfOptions.headerTemplate.includes('text-align:left'), 'PDF logos are on the left')
      const fitted = fitLogo(logo, 151, 38)
      assert.ok(pdfOptions.headerTemplate.includes(`width="${fitted.width}" height="${fitted.height}"`))
    }
  }
}
// The four workbenches share the same picker and preserve the logo in every
// family model. A default/new report intentionally starts with an empty slot.
for (const scheme of ['GEO', 'NGSO', 'REGEN', 'E2E']) for (const kind of ['full', 'sla', 'cap']) {
  assert.equal(model(kind, 'en', b, scheme).doc.logo, b)
  assert.equal(model(kind, 'zh', null, scheme).doc.logo, null)
}
for (const file of ['src/linkbudget/LinkBudgetApp.vue', 'src/ngso/NgsoLinkBudgetApp.vue', 'src/regen/RegenLinkBudgetApp.vue', 'src/e2e/E2eLinkBudgetApp.vue']) {
  assert.ok(fs.readFileSync(new URL('../../../' + file, import.meta.url), 'utf8').includes('<LbReportDialog'))
}
delete globalThis.localStorage
console.log('lbReportLogo: all passed')
