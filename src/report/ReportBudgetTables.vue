<script setup>
// Satmaster-style engineering tables over the same normalized snapshot used by
// Excel and Word. No report values or operating conditions are recalculated.
import { computed } from 'vue'
import { lbDocT } from '../shared/lbDocI18n.js'

const props = defineProps({ inputs: { type: Array, default: () => [] }, segments: { type: Array, default: () => [] },
  lang: { type: String, default: 'zh' }, inputTitle: { type: String, default: '' }, resultTitle: { type: String, default: '' } })
const en = computed(() => props.lang === 'en')
const t = computed(() => lbDocT(props.lang))
const S = (v) => v === null || v === undefined || v === '' ? '—' : String(v)
const heads = (segment) => Array.isArray(segment.heads) && segment.heads.length === segment.cols ? segment.heads.map(t.value)
  : segment.cols === 3 ? (en.value ? ['Uplink', 'Downlink', 'Total'] : ['上行', '下行', '合计'])
    : segment.cols === 2 ? (en.value ? ['Uplink', 'Downlink'] : ['上行', '下行']) : [en.value ? 'Value' : '数值']
const valueFields = (segment) => ['up', 'down', 'total'].slice(0, segment.cols || 1)
const widths = (cols) => cols === 3 ? [43, 15, 15, 15, 12] : cols === 2 ? [52, 18, 18, 12] : [65, 23, 12]
const isGroup = (row) => ['head', 'shead'].includes(row.kind)
const isKey = (row) => ['base', 'sub', 'chk', 'kpi', 'margin'].includes(row.kind)
const negative = (row, field) => row.kind === 'margin' && S(row[field]) !== '—' && Number(row[field]) < 0
const inputTables = computed(() => {
  const up = props.inputs.findIndex((b) => b.key === 'uplink'), down = props.inputs.findIndex((b) => b.key === 'downlink')
  const paired = up >= 0 && down >= 0
  const out = []
  props.inputs.forEach((block, i) => {
    if (paired && (i === up || i === down)) {
      if (i !== Math.min(up, down)) return
      const rows = [], byKey = new Map()
      for (const [side, index] of [['up', up], ['down', down]]) {
        const occurrences = new Map()
        for (const row of props.inputs[index].rows || []) {
          // Match identical names and units only. Repeated rows retain their
          // occurrence; unlike directional parameters remain separate.
          const base = JSON.stringify([row.label, row.unit || ''])
          const occurrence = occurrences.get(base) || 0; occurrences.set(base, occurrence + 1)
          const key = base + ':' + occurrence
          if (!byKey.has(key)) { const item = { label: row.label, unit: row.unit }; rows.push(item); byKey.set(key, item) }
          byKey.get(key)[side] = row.value
        }
      }
      out.push({ title: en.value ? 'Earth station input parameters' : '地球站输入参数', cols: 2, rows })
    } else out.push({ title: block.title, cols: 1, rows: (block.rows || []).map((r) => ({ label: r.label, up: r.value, unit: r.unit })) })
  })
  return out
})
const tables = computed(() => [...inputTables.value.map((s) => ({ ...s, input: true })), ...props.segments])
</script>

<template>
  <template v-for="(segment, si) in tables" :key="si">
    <h2 v-if="segment.input && si === 0 && inputTitle" class="rp-h2">{{ inputTitle }}</h2>
    <h2 v-if="!segment.input && si === inputTables.length && resultTitle" class="rp-h2">{{ resultTitle }}</h2>
    <table class="rp-budget-table">
      <colgroup><col v-for="(width, ci) in widths(segment.cols || 1)" :key="ci" :style="{ width: width + '%' }"></colgroup>
      <thead><tr>
        <th class="rp-budget-heading"><h3><span v-if="segment.no" class="rp-group-no">§{{ segment.no }} </span>{{ segment.title }}</h3></th>
        <th v-for="(head, hi) in heads(segment)" :key="hi" class="num">{{ head }}</th>
        <th class="unit">{{ en ? 'Units' : '单位' }}</th>
      </tr></thead>
      <tbody>
        <tr v-for="(row, ri) in segment.rows || []" :key="ri" :class="{ 'rp-budget-subgroup': isGroup(row), 'rp-budget-key': isKey(row), 'rp-budget-margin': row.kind === 'margin' }">
          <th v-if="isGroup(row)" :colspan="2 + (segment.cols || 1)">{{ row.label }}</th>
          <template v-else>
            <td class="lbl"><span v-if="row.sign" class="rp-budget-sign">{{ row.sign }} </span>{{ row.label }}</td>
            <td v-for="(field, vi) in valueFields(segment)" :key="vi" class="num" :class="{ 'rp-negative': negative(row, field) }">{{ S(row[field]) }}</td>
            <td class="unit">{{ row.unit || '' }}</td>
          </template>
        </tr>
      </tbody>
    </table>
  </template>
</template>
