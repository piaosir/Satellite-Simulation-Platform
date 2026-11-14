<script setup>
import { computed } from 'vue'

const props = defineProps({
  head: { type: Array, default: () => [] },
  rows: { type: Array, default: () => [] },
  groupRows: { type: Array, default: () => [] },
  keyRows: { type: Array, default: () => [] },
  align: { type: Array, default: () => [] },
  widths: { type: Array, default: () => [] },
  matrix: { type: Boolean, default: false }
})
const text = (v) => v === null || v === undefined || v === '' ? '—' : String(v)
// A subtotal must travel with the preceding record, and a group heading with
// its first record. Keep original indices so visual flags never shift data.
const rowGroups = computed(() => {
  const groups = []
  for (let i = 0; i < props.rows.length;) {
    let end = i + 1
    if (props.groupRows[i] && end < props.rows.length && !props.groupRows[end]) end++
    if (end < props.rows.length && props.keyRows[end]) end++
    groups.push(props.rows.slice(i, end).map((cells, offset) => ({ cells, index: i + offset })))
    i = end
  }
  return groups
})
</script>

<template>
  <table class="rp-tb" :class="{ 'rp-matrix': matrix }">
    <colgroup v-if="widths.length"><col v-for="(width, i) in widths" :key="i" :style="{ width: width + '%' }"></colgroup>
    <colgroup v-else-if="matrix"><col style="width:30%"><col v-for="i in Math.max(0, head.length - 1)" :key="i"></colgroup>
    <thead><tr><th v-for="(cell, i) in head" :key="i" :class="align[i] === 'right' ? 'num' : 'lbl'">{{ text(cell) }}</th></tr></thead>
    <tbody v-for="(group, gi) in rowGroups" :key="gi" :class="{ 'rp-keep-rows': group.length > 1 }">
      <tr v-for="row in group" :key="row.index" :class="{ 'rp-grp': groupRows[row.index], 'rp-key': keyRows[row.index] }">
        <td v-if="groupRows[row.index]" class="lbl" :colspan="head.length">{{ text(row.cells[0]) }}</td>
        <template v-else><td v-for="(cell, ci) in row.cells" :key="ci" :class="align[ci] === 'right' ? 'num' : 'lbl'">{{ text(cell) }}</td></template>
      </tr>
    </tbody>
  </table>
</template>
