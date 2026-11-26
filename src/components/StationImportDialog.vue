<script setup>
import { computed, nextTick, ref, shallowRef } from 'vue'
import ExcelGrid from './ExcelGrid.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import AppDialog from './AppDialog.vue'
import CityPicker from './CityPicker.vue'
import Icon from './Icon.vue'
import MarkLegend from './MarkLegend.vue'
import MarkerPick from '../perf/MarkerPick.vue'
import { numStrict } from '../shared/num.js'
import { cityName } from '../shared/cityName.js'
import { byLang } from '../shared/i18n/lang.js'
import { editedSite, selectedSites, stationImportPlan, stationSources } from '../shared/stationImport.js'

const props = defineProps({
  groups: { type: Array, required: true },
  stations: { type: Array, required: true },
  initialSide: { type: String, required: true },
  targetSide: { type: String, default: null },
  placeholder: { type: Function, required: true },
  formatCoordinate: { type: Function, required: true },
  applyCityByName: { type: Function, required: true },
  startRow: { type: Number, default: null }
})
const emit = defineEmits(['apply', 'close'])
const side = ref(props.initialSide)
const source = ref('')
const picks = shallowRef({ tx: [], rx: [] })
const catalog = shallowRef(null)
const paired = computed(() => props.groups.length > 1)
const editableGroups = computed(() => props.groups.filter(g => !props.targetSide || g.kind === props.targetSide))
const mode = ref(paired.value ? 'fill' : 'append')
// 手工行与按来源展开的行各自保存草稿，移动或改配对时按站点身份取回编辑值。
const manualCount = ref(0)
const edits = ref(new Map())
const rowKey = (index, kind) => 'row:' + index + ':' + kind
const baseRows = computed(() => props.stations.map((row, index) => {
  let draft = row
  for (const g of props.groups) {
    const patch = edits.value.get(rowKey(index, g.kind))
    if (!patch) continue
    if (draft === row) draft = { ...row }
    for (const [key, value] of Object.entries(patch)) draft[g[key]] = value
  }
  return draft
}))
// Reserve destinations when choosing sites or changing destination mode. Editing
// the preview must keep the same row identities for the entire edit/clear/paste.
const placementRows = shallowRef(props.stations)
const plan = computed(() => stationImportPlan(props.groups, placementRows.value, picks.value, mode.value, props.startRow))
const importEnd = computed(() => Math.max(props.stations.length, (plan.value.rows.at(-1)?.index ?? -1) + 1))
let pickSeq = 0
function editKeys(index, kind, change) {
  const item = change?.sites[kind]
  const other = change?.sites[kind === 'tx' ? 'rx' : 'tx']
  if (index >= importEnd.value) return ['manual:' + (index - importEnd.value) + ':' + kind]
  if (!item) return [other && index >= props.stations.length ? 'peer:' + other.pickId + ':' + kind : rowKey(index, kind)]
  const key = 'pick:' + item.pickId
  return picks.value[kind].length === 1 && plan.value.rows.length > 1 && other ? [key, key + ':' + other.pickId] : [key]
}
function cellPatch(index, kind, change) {
  const keys = editKeys(index, kind, change)
  return Object.assign({}, ...keys.map(key => edits.value.get(key)))
}
function invalid(key, value) {
  if (key === 'name' || value === '') return false
  const n = numStrict(value)
  return !Number.isFinite(n) || Math.abs(n) > (key === 'lat' ? 90 : 180)
}
const changes = computed(() => new Map(plan.value.rows.map((entry, pickIndex) => [entry.index, { ...entry, pickIndex }])))
const rowCount = computed(() => importEnd.value + manualCount.value)
const sideName = kind => kind === 'rx' ? byLang('收信站', 'Rx station') : byLang('发信站', 'Tx station')
const columns = computed(() => props.groups.flatMap(g => ['name', 'lon', 'lat'].map(field => ({
  key: g[field], field, kind: g.kind, editable: !props.targetSide || props.targetSide === g.kind,
  label: field === 'name' ? sideName(g.kind) : (field === 'lon' ? byLang('经度', 'Longitude') : byLang('纬度', 'Latitude')),
  unit: field === 'name' ? '' : '°', num: field !== 'name', w: field === 'name' ? 160 : 112
}))))
const column = key => columns.value.find(c => c.key === key)
function original(index, col, item) {
  if (!item) return String(props.stations[index]?.[col.key] ?? '')
  return col.field === 'name' ? cityName(item) : props.formatCoordinate(item[col.field])
}
const gridRows = computed(() => Array.from({ length: rowCount.value }, (_, index) => {
  const change = changes.value.get(index)
  const cells = {}
  for (const col of columns.value) {
    const item = change?.sites[col.kind]
    const patch = cellPatch(index, col.kind, change)
    const changed = col.field in patch
    const value = patch[col.field] ?? original(index, col, item)
    cells[col.key] = { value, placeholder: value ? '' : props.placeholder({ ...baseRows.value[index], [col.key]: '' }, col.key),
      dirty: !!item || changed, bad: changed && invalid(col.field, value), legend: col.field === 'name' ? item?.legend : null }
  }
  return { id: index + 1, cells }
}))
const cellText = (r, c) => r.cells[c.key].value
const cellStyle = (r, c) => {
  const cell = r.cells[c.key]
  return { 'site-invalid': cell.bad, 'site-change': cell.dirty, 'site-ghost': !cell.value, 'site-locked': !c.editable }
}
const title = computed(() => editableGroups.value.length === 1
  ? byLang('导入' + sideName(editableGroups.value[0].kind) + '站址', 'Import ' + sideName(editableGroups.value[0].kind) + ' sites')
  : byLang('导入收发站址', 'Import Tx and Rx sites'))
const sources = [
  { key: 'cities', label: byLang('典型城市', 'Cities'), icon: 'map-pin' },
  { key: 'markers', label: byLang('标记 / 航迹', 'Markers / tracks'), icon: 'route' },
  { key: 'polygons', label: 'Polygon', icon: 'polygon' }
]
const pickerTitle = computed(() => sideName(side.value) + ' · ' + sources.find(s => s.key === source.value)?.label)
function stored(key) {
  try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
}
function choose(kind, key) {
  grid.commitEdit()
  side.value = kind
  if (key !== 'cities') catalog.value = stationSources(stored('globe3d/markers'), stored('globe3d/polygons'), stored('globe3d/settings'))
  source.value = key
}
function add(items) {
  if (!items.length) return
  pushUndo()
  placementRows.value = baseRows.value
  items = items.map(item => ({ ...item, pickId: ++pickSeq }))
  picks.value = { ...picks.value, [side.value]: picks.value[side.value].concat(items) }
}
function changeMode(value) {
  pushUndo()
  placementRows.value = baseRows.value
  mode.value = value
}
function addMarkers(selection) {
  add(selectedSites(catalog.value, selection))
  source.value = ''
}
function writeCell(index, col, value, change) {
  if (!col?.editable) return
  const keys = editKeys(index, col.kind, change)
  const key = keys.at(-1)
  const patch = { ...edits.value.get(key) }
  const inherited = keys.length > 1 ? edits.value.get(keys[0])?.[col.field] : undefined
  if (value === (inherited ?? original(index, col, change?.sites[col.kind]))) delete patch[col.field]
  else patch[col.field] = value
  if (Object.keys(patch).length) edits.value.set(key, patch)
  else edits.value.delete(key)
  side.value = col.kind
}
// 先收齐一行，再按城市库补缺少的坐标。冻结列重排后，粘贴的经纬度也可能在站名前面。
function writeFields(index, fields, change) {
  const supplied = new Set(Object.keys(fields))
  for (const group of editableGroups.value) {
    if (supplied.has(group.name)) props.applyCityByName(fields, group, supplied)
  }
  for (const [key, value] of Object.entries(fields)) writeCell(index, column(key), value, change)
}
function changeCell(id, key, value) {
  writeFields(id - 1, { [key]: String(value ?? '') }, changes.value.get(id - 1))
}
function pasteBlock(id, key, text) {
  const cols = grid.visCols.value
  const ci = cols.findIndex(c => c.key === key)
  if (ci < 0 || !cols[ci].editable) return 0
  if (grid.edit.value.ri >= 0) grid.cancelEdit()
  const start = id == null ? rowCount.value : id - 1
  const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n')
  const targets = changes.value
  manualCount.value += Math.max(0, start + lines.length - rowCount.value)
  lines.forEach((line, i) => {
    const fields = {}
    line.split('\t').forEach((value, j) => {
      const col = cols[ci + j]
      if (col?.editable) fields[col.key] = value
    })
    writeFields(start + i, fields, targets.get(start + i))
  })
  return lines.length
}
function addRow() {
  pushUndo()
  const index = rowCount.value
  manualCount.value++
  nextTick(() => {
    const ci = grid.visCols.value.findIndex(c => c.editable)
    grid.sel.value = { ar: index, ac: ci, ri: index, ci }
    grid.ensureVisible()
    grid.focusGrid()
  })
}
const history = [], future = []
const snapshot = () => ({ edits: new Map(edits.value), count: manualCount.value, picks: picks.value, mode: mode.value, placement: placementRows.value })
function pushUndo() {
  history.push(snapshot())
  if (history.length > 50) history.shift()
  future.length = 0
}
function restore(from, to) {
  if (!from.length) return
  to.push(snapshot())
  const state = from.pop()
  edits.value = state.edits
  manualCount.value = state.count
  picks.value = state.picks
  mode.value = state.mode
  placementRows.value = state.placement
}
function selectionActions({ row, col }) {
  if (!row || !col?.editable) return []
  const change = changes.value.get(row.id - 1)
  if (!change?.sites[col.kind]) return []
  const items = picks.value[col.kind]
  const i = items.length === 1 ? 0 : change.pickIndex
  function update(move) {
    pushUndo()
    const list = items.slice()
    if (move) [list[i - 1], list[i]] = [list[i], list[i - 1]]
    else list.splice(i, 1)
    picks.value = { ...picks.value, [col.kind]: list }
  }
  return [
    { key: 'up', label: byLang('上移所选站址', 'Move site up'), dis: i < 1, run: () => update(true) },
    { key: 'remove', label: byLang('移除所选站址', 'Remove selected site'), run: () => update(false) }
  ]
}
const grid = useGridSelect({
  rows: () => gridRows.value, cols: () => columns.value, cellText, cellRaw: cellText,
  onEdit: changeCell, onClear: cells => cells.forEach(c => changeCell(c.rowId, c.key, '')),
  onPasteBlock: pasteBlock, onPasteAppend: text => pasteBlock(null, grid.visCols.value.find(c => c.editable)?.key, text),
  pushUndo, dropUndo: () => history.pop(), undo: () => restore(history, future), redo: () => restore(future, history)
})
const submission = computed(() => {
  const rows = []
  let bad = false
  for (let index = 0; index < rowCount.value; index++) {
    const change = changes.value.get(index)
    const sites = {}
    for (const g of editableGroups.value) {
      const picked = change?.sites[g.kind]
      const patch = cellPatch(index, g.kind, change)
      if (!picked && !Object.keys(patch).length) continue
      if (Object.entries(patch).some(([key, value]) => invalid(key, value))) bad = true
      const replacedByCity = picked && patch.name && props.applyCityByName({ [g.name]: patch.name }, g)
      sites[g.kind] = editedSite(picked, patch, props.formatCoordinate, replacedByCity)
    }
    if (Object.keys(sites).length || index >= props.stations.length) rows.push({ index, sites })
  }
  return { rows, bad }
})
function apply() {
  grid.commitEdit()
  if (!submission.value.bad && !plan.value.mismatch && submission.value.rows.length) emit('apply', submission.value.rows, side.value)
}
</script>

<template>
  <AppDialog :title="title" :width="paired ? 900 : 540" :initial-focus="'.site-' + initialSide + ' button'" @close="emit('close')">
    <div class="site-sides">
      <section v-for="g in editableGroups" :key="g.kind" :class="'site-' + g.kind">
        <h3>{{ sideName(g.kind) }} <small>{{ picks[g.kind].length }}</small>
          <small v-if="picks[g.kind].length === 1 && plan.rows.length > 1">{{ byLang(' · ' + plan.rows.length + ' 行共用', ' · shared by ' + plan.rows.length + ' rows') }}</small>
        </h3>
        <div class="site-actions">
          <button v-for="s in sources" :key="s.key" class="btn" type="button" :title="sideName(g.kind) + ' · ' + s.label" @click="choose(g.kind, s.key)">
            <Icon :name="s.icon" :size="13" />{{ s.label }}
          </button>
        </div>
      </section>
    </div>
    <div class="site-mode">
      <label>{{ byLang('写入位置', 'Destination') }}
        <select :value="mode" @change="changeMode($event.target.value)">
          <option v-if="paired" value="fill">{{ byLang('优先填入空站址', 'Fill empty sites first') }}</option>
          <option value="append">{{ byLang('追加到表尾', 'Append rows') }}</option>
          <option v-if="startRow != null" value="current">{{ byLang('从第 ' + (startRow + 1) + ' 行覆盖', 'Overwrite from row ' + (startRow + 1)) }}</option>
        </select>
      </label>
      <button type="button" class="btn" @click="addRow"><Icon name="plus" :size="12" />增加行</button>
    </div>
    <ExcelGrid class="site-grid" :grid="grid" :cols="columns" :text="cellText" :cell-class="cellStyle"
               :cell-tip="(row, c) => row.cells[c.key].bad ? (c.field === 'lon' ? '−180° … 180°' : '−90° … 90°') : null"
               :menu-items="selectionActions" empty-text="暂无站址。">
      <template #cell="{ row, col }">
        <MarkLegend v-if="row.cells[col.key].legend" :size="14" v-bind="row.cells[col.key].legend" />
        <span data-i18n-skip>{{ row.cells[col.key].value || row.cells[col.key].placeholder || '—' }}</span>
      </template>
    </ExcelGrid>
    <template #footer>
      <span v-if="submission.bad" class="site-error" role="alert">{{ byLang('经纬度无效', 'Invalid coordinates') }}</span>
      <span v-else-if="plan.mismatch" class="site-error" role="alert">{{ byLang('两侧数量不匹配', 'Station counts do not match') }}</span>
      <button type="button" class="btn" @click="emit('close')">取消</button>
      <button type="button" class="btn primary" :disabled="(!submission.rows.length || submission.bad || plan.mismatch) && grid.edit.value.ri < 0" @click="apply">
        {{ byLang('执行修改', 'Apply changes') }}
      </button>
    </template>
  </AppDialog>
  <CityPicker v-if="source === 'cities'" :title="pickerTitle" :table-cities="[]" dup @add="add" @close="source = ''" />
  <MarkerPick v-if="source === 'markers' || source === 'polygons'" :title="pickerTitle" :pts="catalog.pts" :sts="catalog.sts" :trajs="catalog.trajs"
              :polygons="source === 'polygons' ? catalog.polygons : null" @confirm="addMarkers" @close="source = ''" />
</template>

<style scoped>
.site-sides, .site-actions, .site-mode { display: flex; align-items: center; gap: 6px; }
.site-sides { align-items: stretch; gap: 12px; }
.site-sides section { flex: 1; min-width: 0; padding: 9px; border: 1px solid var(--border); border-radius: var(--r-box); }
.site-sides h3 { margin: 0 0 8px; font-size: var(--fs-4); }
.site-sides small { color: var(--text-muted); font-weight: 400; }
.site-actions { flex-wrap: wrap; }
.site-mode { margin: 12px 0 8px; justify-content: space-between; }
.site-mode select { margin-left: 6px; }
.site-grid { max-height: 48vh; min-height: 100px; border: 1px solid var(--border); }
.site-grid :deep(.site-ghost .eg-v), .site-grid :deep(.site-locked .eg-v) { color: var(--text-faint); }
.site-grid :deep(.site-change:not(.sel)) { background-color: color-mix(in srgb, var(--accent-ui) 8%, transparent); }
.site-grid :deep(.site-invalid) { color: var(--danger); }
.site-grid :deep(.eg-v .mlg) { display: inline-flex; vertical-align: middle; margin-right: 5px; }
.site-error { color: var(--danger); margin-right: auto; }
</style>
