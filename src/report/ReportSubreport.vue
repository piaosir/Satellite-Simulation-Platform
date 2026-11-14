<script setup>
// The main process supplies a compact projection of the same result snapshot.
// No method, intermediate calculation, or engineering appendix is printed.
import { computed } from 'vue'
import ReportDataTable from './ReportDataTable.vue'

const props = defineProps({ model: { type: Object, required: true } })
const brief = computed(() => props.model.compact || { title: '', meta: [], tables: [], notes: [], landscape: false })
const metaRows = computed(() => {
  const rows = []
  for (let i = 0; i < brief.value.meta.length; i += 3) rows.push(brief.value.meta.slice(i, i + 3))
  return rows
})
</script>

<template>
  <section class="rp-brief" :class="{ 'rp-land': brief.landscape }">
    <h1 class="rp-cv-title">{{ brief.title }}</h1>
    <p v-for="(row, i) in metaRows" :key="i" class="rp-brief-meta"><span v-for="(item, j) in row" :key="j"><span class="rp-brief-label">{{ item.label }}：</span>{{ item.value }}</span></p>
    <div v-for="(table, i) in brief.tables" :key="i" class="rp-brief-table">
      <h2 v-if="model.kind !== 'sla' || brief.tables.length > 1" class="rp-h2">{{ table.title }}</h2>
      <ReportDataTable :head="table.head" :rows="table.rows" :widths="table.widths" :align="table.align" :group-rows="table.groupRows" />
    </div>
    <p v-for="(note, i) in brief.notes" :key="i" class="rp-note">{{ note }}</p>
  </section>
</template>

<style scoped>
.rp-brief-meta { display: flex; flex-wrap: wrap; column-gap: 5mm; row-gap: .5mm; margin: 0 0 1mm; font-size: 9pt; line-height: 1.25; }
.rp-brief-meta > span { overflow-wrap: anywhere; }
.rp-brief-label { color: #454545; }
.rp-brief-table { margin: 2mm 0 0; }
.rp-brief-table :deep(.rp-tb) { margin-bottom: 2mm; }
.rp-brief-table :deep(.rp-tb td), .rp-brief-table :deep(.rp-tb th) { padding-top: .6mm; padding-bottom: .6mm; }
</style>
