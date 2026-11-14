import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import * as Vue from 'vue'
import { useLbReport } from '../../../../src/shared/useLbReport.js'
import { resultRowIndices } from '../../../../src/shared/lbResultSelection.js'

const require = createRequire(import.meta.url)
const { compile } = require('@vue/compiler-dom')
const { parse } = require('@babel/parser')
const files = {
  GEO: 'linkbudget/LinkBudgetApp.vue', NGSO: 'ngso/NgsoLinkBudgetApp.vue', REGEN: 'regen/RegenLinkBudgetApp.vue'
}
const modes = ['uplink', 'downlink', 'isl', 'laser']
const hostNode = (kind, text = '') => ({ kind, text, style: {}, parent: null, children: [] })
const renderer = Vue.createRenderer({
  createElement: hostNode, createText: (t) => hostNode('text', t), createComment: (t) => hostNode('comment', t),
  setText: (n, t) => { n.text = t }, setElementText: (n, t) => { n.text = t }, patchProp() {},
  parentNode: (n) => n.parent, nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
  insert(n, parent, anchor) {
    if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1)
    n.parent = parent
    const at = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(at < 0 ? parent.children.length : at, 0, n)
  },
  remove(n) { if (n.parent) n.parent.children.splice(n.parent.children.indexOf(n), 1); n.parent = null }
})

// Use the real workbench template and its report callbacks. Only table/chart
// drawing and the main-process save dialog are stubbed: Vue owns the refs,
// conditional branches, module watcher, and component lifetimes.
async function checkCapture(orbitType, { multi = true, outcome = 'success', showViz = true,
  withFigures = true, origin = 'isl' } = {}) {
  const full = fs.readFileSync(new URL('../../../../src/' + files[orbitType], import.meta.url), 'utf8')
  const source = full.split('<script setup>')[1].split('</script>')[0]
  const ast = parse(source, { sourceType: 'module' })
  const binding = ast.program.body.flatMap((n) => n.declarations || [])
    .find((n) => n.init?.type === 'CallExpression' && n.init.callee.name === 'useLbReport')
  assert.ok(binding.id.properties.some((p) => p.key.name === 'reportFigureCapture'), 'Host binds the capture state')
  const optionNames = ['links', 'selected', 'setSelected', 'activeSection', 'activateSection', 'beforeReport', 'afterReport', 'sections']
  const optionsCode = binding.init.arguments[0].properties.filter((p) => optionNames.includes(p.key.name))
    .map((p) => source.slice(p.start, p.end)).join(',\n')
  const isRegen = orbitType === 'REGEN', sectionKeys = isRegen ? modes : ['']
  const linksBy = Object.fromEntries(sectionKeys.map((key) => [key, [0, 1].map((i) => ({
    rowId: key + '-r' + i, mode: key, txName: key + '-TX' + i, rxName: key + '-RX' + i,
    ok: true, data: { linkmargin: String(i + 3) }
  }))]))
  const originalSection = isRegen ? origin : ''
  const linkMode = Vue.ref(originalSection), selectedBy = Vue.reactive(Object.fromEntries(sectionKeys.map((key) => [key, 1])))
  const selected = Vue.computed({ get: () => selectedBy[linkMode.value], set: (i) => { selectedBy[linkMode.value] = i } })
  const links = Vue.computed(() => linksBy[linkMode.value])
  const selectedRowIds = Vue.ref(multi ? links.value.map((l) => l.rowId) : [links.value[1].rowId])
  const originalIds = selectedRowIds.value.slice(), originalSelected = { ...selectedBy }
  const focusRowId = Vue.ref(links.value[1].rowId), originalFocus = focusRowId.value
  const selectedBudgetRows = Vue.computed(() => resultRowIndices(links.value.map((l) => ({ _id: l.rowId })),
    selectedRowIds.value, links.value[selected.value]?.rowId).map((i) => links.value[i]))
  const vizRef = Vue.ref(null), reportModules = Vue.ref(sectionKeys)
  const context = vm.createContext({ selected, selectedBy, links, linksBy, linkMode, selectedRowIds,
    modules: reportModules, reportModules, canReport: Vue.ref(true), MODE_KEYS: modes,
    nextTick: Vue.nextTick, watch: Vue.watch, _selSnap: null, error: Vue.ref(''),
    ensureFreshResults: async () => true, computeMissing: async () => {}, loadWaterfall: async () => {} })
  const hostOptions = vm.runInContext('({' + optionsCode + '})', context)
  let payload = null, exported = 0, messages = [], errors = [], captures = [], multiMounted = false
  const allLinks = sectionKeys.flatMap((key) => linksBy[key])
  const failRow = allLinks[0].rowId
  const flow = useLbReport({
    ...hostOptions, orbitType, fieldGroups: [], paramsFor: () => null,
    api: { report: { exportReport: async (p) => {
      payload = p; exported++
      assert.equal(flow.reportFigureCapture.value, null, 'Capture state ends before the save dialog')
      if (outcome === 'export-error') throw new Error('save failed')
      return outcome === 'cancel' ? { canceled: true } : { ok: true, files: ['test.pdf'] }
    } } },
    lang: () => 'zh', appVersion: () => 'test', calc: () => ({}), defaultName: () => 'test',
    nextTick: Vue.nextTick, showViz: () => showViz, vizRef: () => vizRef.value,
    toast: (s) => messages.push(s), setError: (s) => errors.push(s)
  })
  context.reportFigureCapture = flow.reportFigureCapture
  // The real regenerative module watcher must preserve the selection while
  // temporary report switches occur, then behave normally after export.
  const selectionWatch = isRegen && ast.program.body.find((n) => n.type === 'ExpressionStatement'
    && n.expression.callee?.name === 'watch' && n.expression.arguments[0]?.name === 'linkMode'
    && source.slice(n.start, n.end).includes('selectedRowIds.value'))
  const stopWatch = selectionWatch ? vm.runInContext(source.slice(selectionWatch.start, selectionWatch.end), context) : null
  let detail = /<LbSection\b[^>]*\bid="detail"[\s\S]*?<\/LbSection>/.exec(full)?.[0]
  assert.ok(detail)
  // Preserve each module's real v-if/v-show condition, replacing its inner
  // editor with a stateful grid stub. Losing the original instance loses its
  // cell/row selection; keeping only parent row IDs is insufficient.
  const grids = new Map()
  if (isRegen) detail = modes.map((key) => {
    const opening = new RegExp('<LbSection v-if="linkMode === \'' + key + '\'[^>]*>').exec(full)?.[0]
    assert.ok(opening)
    return opening + `<StationGrid mode="${key}" /></LbSection>`
  }).join('\n') + detail
  const render = new Function('Vue', compile('<div>' + detail + '</div>', { mode: 'function' }).code)(Vue)
  const blank = { render: () => Vue.h('div') }
  const app = renderer.createApp({
    components: {
      LbSection: { inheritAttrs: false, setup: (_p, { slots }) => () => Vue.h('div', slots.default?.()) },
      Icon: blank, WaterfallTable: blank,
      LbMultiBudget: { setup() {
        multiMounted = true
        Vue.onUnmounted(() => { multiMounted = false })
        return () => Vue.h('div')
      } },
      StationGrid: { props: ['mode'], setup(props) {
        const state = { selection: ['row-0', 'row-1'], activeCell: [1, 2] }
        grids.set(props.mode, state)
        Vue.onUnmounted(() => { grids.delete(props.mode) })
        return () => Vue.h('div')
      } },
      LbVizPane: { setup(_p, { expose }) {
        expose({ captureFigures: async () => {
          assert.ok(flow.reportFigureCapture.value)
          assert.equal(multiMounted, false, 'The actual single-link capture pane is visible while taking a figure')
          const rowId = links.value[selected.value].rowId
          captures.push(rowId)
          if (outcome === 'capture-error' && rowId === failRow) throw new Error('chart failed')
          return [{ title: rowId, dataUrl: 'data:image/png;base64,AA==' }]
        } })
        return () => Vue.h('div')
      } }
    },
    setup: () => ({ selected, selectedBudgetRows, vizRef, links, linkMode,
      reportFigureCapture: flow.reportFigureCapture, focusRowId,
      resultsStale: false, detailNo: 2, sel: Vue.computed(() => links.value[selected.value]),
      error: '', core: true, segments: [], showViz, reportLang: 'zh', unitAdaptive: false,
      selParams: {}, api: null, linkScene: {}, geoLink: {}, geom: null, islGeo: null, access: null,
      geoFold: true, geoFoldSum: '', geoT0ISO: '', geoT0Mode: 'scene', geoHorizonHours: 24,
      geoRefMs: 0, tzMode: 'UTC', sceneApi: null, orbit: null, sweepEngine: 'regen',
      sweepUnavailable: '', vizShowGeo: false, vizGeoSite: null,
      txStations: [], rxStations: [], islLinks: [], laserLinks: [],
      stepDetail() {}, toastFile() {}, pairLabel: (l) => l.txName + ' → ' + l.rxName }),
    render
  })
  app.config.warnHandler = () => {}
  app.mount(hostNode('root'))
  const originalGrid = grids.get(originalSection)
  assert.equal(multiMounted, multi)
  flow.reportDlg.open = true
  const oldWarn = console.warn
  console.warn = () => {}
  try {
    await flow.runReport({ doc: {}, formats: ['pdf'], withFigures })
    assert.equal(exported, 1)
    const expectedCaptures = showViz && withFigures ? allLinks.map((l) => l.rowId) : []
    assert.deepEqual(captures, expectedCaptures, orbitType + ': every report link gets its own figure')
    assert.deepEqual(payload.model.links.map((l) => l.figures.map((f) => f.title)), allLinks.map((l) =>
      expectedCaptures.includes(l.rowId) && !(outcome === 'capture-error' && l.rowId === failRow) ? [l.rowId] : []))
    assert.deepEqual(selectedRowIds.value, originalIds, 'Contiguous/Ctrl-selected row IDs survive')
    assert.deepEqual({ ...selectedBy }, originalSelected, 'Every module restores its original current row')
    assert.equal(linkMode.value, originalSection)
    assert.equal(focusRowId.value, originalFocus)
    assert.equal(flow.reportFigureCapture.value, null)
    assert.equal(flow.reportDlg.busy, false)
    assert.equal(multiMounted, multi, 'Multi-link details return after success, cancel, or an exception')
    assert.equal(errors.length, outcome === 'export-error' ? 1 : 0)
    assert.equal(flow.reportDlg.open, outcome === 'cancel' || outcome === 'export-error')
    if (outcome === 'capture-error') assert.ok(messages.some((s) => s.includes('报告缺少图件')))
    if (isRegen) {
      assert.equal(grids.get(originalSection), originalGrid, 'The original grid and its actual selection state survive module switches')
      linkMode.value = modes.find((key) => key !== originalSection)
      await Vue.nextTick()
      assert.deepEqual(Array.from(selectedRowIds.value), [], 'Normal module switches still clear the previous module selection')
    }
  } finally {
    console.warn = oldWarn
    stopWatch?.()
    app.unmount()
  }
}

export async function testReportFigureCapture() {
  for (const type of ['GEO', 'NGSO']) {
    await checkCapture(type, { multi: false })
    for (const outcome of ['success', 'cancel', 'export-error', 'capture-error']) await checkCapture(type, { outcome })
    await checkCapture(type, { withFigures: false })
    await checkCapture(type, { showViz: false })
  }
  for (const origin of modes) await checkCapture('REGEN', { origin })
  for (const outcome of ['cancel', 'export-error', 'capture-error']) await checkCapture('REGEN', { outcome })
  await checkCapture('REGEN', { multi: false })
  console.log('PASS report figure capture: real GEO/NGSO/REGEN templates, single/multi selections, all modules, save/cancel/errors and selection restoration')
}
