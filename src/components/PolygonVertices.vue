<script setup>
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'

const props = defineProps({ points: { type: Array, required: true } })
const emit = defineEmits(['update', 'copy'])
const page = ref(0)
const pageSize = 32
const pages = computed(() => Math.max(1, Math.ceil(props.points.length / pageSize)))
watch(pages, n => { page.value = Math.min(page.value, n - 1) })
const start = computed(() => page.value * pageSize)
const rows = computed(() => props.points.slice(start.value, start.value + pageSize))
const draft = defineModel('draft', { type: Object, default: null })
const error = ref('')
const columns = ['经度', '纬度']

function coordinate(value) {
  const n = Number(value)
  const rounded = n.toFixed(3)
  return Number(rounded) === n ? rounded : String(n)
}
const twoColumns = () => props.points.map(p => p.map(coordinate).join('\t')).join('\n')
function valid(v, axis) {
  return Number.isFinite(v) && Math.abs(v) <= (axis === 0 ? 360 : 90)
}
function invalidPoint(i) {
  return byLang(`p${i + 1} 坐标无效`, `Invalid coordinates at p${i + 1}`)
}
function changeCell(i, axis, el) {
  const value = el.valueAsNumber
  if (!valid(value, axis)) {
    error.value = invalidPoint(i)
    el.value = coordinate(props.points[i][axis])
    return
  }
  error.value = ''
  const points = props.points.slice()
  points[i] = [...points[i]]
  points[i][axis] = value
  emit('update', points)
}
function beginBatch() {
  const original = twoColumns()
  draft.value = { original, text: original }
  error.value = ''
}
function applyBatch() {
  if (twoColumns() !== draft.value.original) {
    error.value = byLang('顶点已在地图中更改', 'Vertices have changed on the map')
    return
  }
  const points = []
  for (const line of draft.value.text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const match = line.trim().match(/^(?:p(\d+)\s*=\s*)?([^,;，；\s]+)(?:\s*[,;，；]\s*|\s+)([^,;，；\s]+)$/i)
    const i = points.length
    if (!match || (match[1] && Number(match[1]) !== i + 1) || !valid(Number(match[2]), 0) || !valid(Number(match[3]), 1)) {
      error.value = invalidPoint(i)
      return
    }
    points.push([Number(match[2]), Number(match[3])])
  }
  const first = points[0], last = points.at(-1)
  if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop()
  if (points.length < 3) {
    error.value = byLang('Polygon 至少需要 3 个顶点', 'Polygon requires at least 3 vertices')
    return
  }
  emit('update', points)
  draft.value = null
  error.value = ''
}
</script>

<template>
  <div class="vertices">
    <template v-if="draft === null">
      <div class="scroll">
        <table>
          <thead><tr><th scope="col">#</th><th v-for="col in columns" :key="col" scope="col">{{ col }} (°)</th></tr></thead>
          <tbody>
            <tr v-for="(p, j) in rows" :key="start + j">
              <th scope="row">p{{ start + j + 1 }}</th>
              <td v-for="(col, axis) in columns" :key="col">
                <input type="number" step="any" :aria-label="`p${start + j + 1} ${col}`" :value="coordinate(p[axis])" @change="changeCell(start + j, axis, $event.target)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="tools">
        <button type="button" class="btn sm" @click="beginBatch"><Icon name="pencil" /> 批量编辑</button>
        <button type="button" class="btn sm" :disabled="!points.length" @click="emit('copy', twoColumns())"><Icon name="copy" /> 复制两列</button>
        <div v-if="pages > 1" class="pager">
          <button class="ibtn sm" type="button" title="上一页" :disabled="!page" @click="page--"><Icon name="chevron-left" /></button>
          <span>{{ page + 1 }}/{{ pages }}</span>
          <button class="ibtn sm" type="button" title="下一页" :disabled="page + 1 >= pages" @click="page++"><Icon name="chevron-right" /></button>
        </div>
      </div>
    </template>
    <template v-else>
      <textarea v-model="draft.text" aria-label="顶点坐标" spellcheck="false" wrap="off" placeholder="p1=110.500;32.000" />
      <div class="tools"><button class="btn sm primary" type="button" @click="applyBatch">应用</button><button class="btn sm" type="button" @click="draft = null; error = ''">取消</button></div>
    </template>
    <div v-if="error" class="error" role="alert">{{ error }}</div>
  </div>
</template>

<style scoped>
.scroll, textarea { border: 1px solid var(--border); border-radius: var(--r-ctl); }
.scroll { max-height: 176px; overflow: auto; }
table { width: 100%; table-layout: fixed; border-spacing: 0; font-size: var(--fs-2); }
thead th { position: sticky; top: 0; background: var(--surface); color: var(--text-muted); z-index: 1; }
th, td { padding: 0; text-align: right; border-bottom: 1px solid var(--border); }
th { padding: 4px 6px; font-weight: 500; }
th:first-child { width: 5em; text-align: left; }
tbody th { font-family: var(--font-mono); color: var(--text-muted); }
tbody tr:last-child > * { border-bottom: 0; }
td input { box-sizing: border-box; width: 100%; min-width: 0; padding: 4px 6px; border: 1px solid transparent; background: transparent; color: var(--text); font: inherit; font-family: var(--font-mono); text-align: right; }
td input:hover, td input:focus { border-color: var(--field-border-hover); background: var(--field-bg); }
td input::-webkit-inner-spin-button { display: none; }
textarea { width: 100%; box-sizing: border-box; min-height: 120px; resize: vertical; background: var(--field-bg); color: var(--text); font: var(--fs-2)/1.6 var(--font-mono); padding: 5px 7px; }
.tools, .pager { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.tools { margin-top: 6px; }
.pager { margin-left: auto; font: var(--fs-2) var(--font-mono); }
.error { color: var(--danger); margin-top: 6px; font-size: var(--fs-2); }
</style>
