import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { selectedSites, stationImportPlan, stationSources } from '../../../src/shared/stationImport.js'

const markers = {
  points: [{ lon: '', lat: 0 }, { lon: 0, lat: 0, color: '#123456' }],
  stations: [{ id: 's', name: 'A', lon: 80, lat: 20, diaM: 5, radome: true }],
  trajectories: [
    { id: 't', name: 'Sea', kind: 'sea', pts: [{ lon: 100, lat: 20 }] },
    { id: 'f', name: 'Air', kind: 'flight', color: '#abcdef', pts: [{ lon: 0, lat: 20, altM: 1000 }, { lon: 1, lat: 20, altM: 1500 }] }
  ]
}
const polygon = { id: 'p', name: 'P', pts: [[20, 30], [0, 0], [20, 30]] }
const catalog = stationSources(markers, { polys: [polygon] }, { markStyle: { tjSea: '#123123' } })
assert.equal(catalog.pts.length, 1)
assert.equal(catalog.pts[0].legend.text, 2)
assert.equal(catalog.pts[0].legend.badge.fill, '#123456')
assert.deepEqual(catalog.trajs.map(t => [t.legend.icon, t.legend.color]), [['ship', '#123123'], ['plane', '#abcdef']])
assert.equal(stationSources(markers, [], { mkPtIdxShow: false, markStyle: { ptShape: 'square' } }).pts[0].legend.shape, 'square')
assert.deepEqual(stationSources({}, [polygon]).polygons, catalog.polygons)
const [station, ...flight] = selectedSites(catalog, { sts: ['s'], trajs: ['f'] })
assert.equal(station.diaM, 5)
assert.equal(station.radome, true)
assert.deepEqual(flight.map(s => [s.name, s.altM, s.legend.icon]), [['Air#1', 1000, 'plane'], ['Air#2', 1500, 'plane']])
const vertices = selectedSites(catalog, { polygons: ['p'] })
assert.deepEqual(vertices.map(v => [v.name, v.lon, v.lat]), [['P#1', 20, 30], ['P#2', 0, 0], ['P#3', 20, 30]])

const groups = ['tx', 'rx'].map(kind => ({ kind, name: kind, lon: kind + 'Lon', lat: kind + 'Lat' }))
const rows = [{ tx: 'A', rx: 'B' }, { tx: 'C' }, { rxLon: 0 }, {}]
const plan = (picks, mode = 'fill') => stationImportPlan(groups, rows, picks, mode, 2)
assert.deepEqual(plan({ rx: vertices }).rows.map(r => r.index), [1, 3, 4])
const fanOut = plan({ tx: [station], rx: vertices })
assert.equal(fanOut.mismatch, false)
assert.deepEqual(fanOut.rows.map(r => r.index), [3, 4, 5])
assert.ok(fanOut.rows.every(r => r.sites.tx === station))
assert.deepEqual(plan({ tx: vertices, rx: [station] }, 'append').rows.map(r => r.index), [4, 5, 6])
assert.deepEqual(plan({ tx: flight, rx: flight }, 'current').rows.map(r => [r.index, r.sites.rx.name]), [[2, 'Air#1'], [3, 'Air#2']])
assert.equal(plan({ tx: flight, rx: vertices }).mismatch, true)
assert.deepEqual(stationImportPlan(groups, rows, { rx: flight }, 'current', 99).rows.map(r => r.index), [3, 4])

// Compile the dialog's real setup. Child widgets have no role in the edit and
// submission logic; SSR supplies Vue's component lifecycle without a window.
const file = new URL('../../../src/components/StationImportDialog.vue', import.meta.url)
const descriptor = parse(readFileSync(file, 'utf8')).descriptor
const script = compileScript(descriptor, { id: 'station-import' }).content.replace(/from '([^']+)'/g, (_, spec) => {
  const url = spec === 'vue' ? import.meta.resolve('vue') : spec.endsWith('.vue')
    ? 'data:text/javascript,export default {}' : new URL(spec, file).href
  return 'from ' + JSON.stringify(url)
})
const { default: dialog } = await import('data:text/javascript;base64,' + Buffer.from(script).toString('base64'))
async function preview(items) {
  let state
  const props = { groups, stations: [{ rx: 'A', rxLon: '1', rxLat: '2' }], initialSide: 'rx',
    formatCoordinate: String, placeholder: () => '', applyCityByName: () => false }
  await renderToString(createSSRApp({ setup(_, context) {
    state = dialog.setup(props, context)
    return () => h('div')
  } }))
  state.add(items)
  return state
}
const clear = await preview([station, flight[0]])
clear.grid.sel.value = { ar: 0, ri: 1, ac: 3, ci: 5 }
clear.grid.clearRange()
assert.deepEqual(clear.submission.value.rows.map(row => row.sites.rx.name), ['', '', flight[0].name])
const paste = await preview(flight.slice(0, 1))
paste.pasteBlock(1, 'rx', '\t\t\nC\t30\t40')
const edited = paste.submission.value.rows
assert.deepEqual(edited.map(row => [row.index, row.sites.rx.name]), [[0, ''], [1, 'C']])
assert.equal(edited[1].sites.rx.lon, '30')
assert.equal(edited[1].sites.rx.altM, undefined)
const equipment = await preview([station])
equipment.changeCell(2, 'rx', 'Alias')
assert.equal(equipment.submission.value.rows.at(-1).sites.rx.diaM, 5)
equipment.changeCell(2, 'rxLat', '42')
assert.equal(equipment.submission.value.rows.at(-1).sites.rx.diaM, undefined)
console.log('PASS station import sources, legends, pairing and destination rows')
