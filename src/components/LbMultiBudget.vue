<script setup>
import { ref, watch, onBeforeUnmount, toRaw, markRaw } from 'vue'
import WaterfallTable from '../linkbudget/WaterfallTable.vue'
import { createBudgetWaterfallLoader } from '../shared/budgetWaterfallLoader.js'

const props = defineProps({
  rows: { type: Array, required: true }, // { rowId, no, name, data, err }
  lang: { type: String, default: 'zh' },
  orbitType: { type: String, required: true },
  adaptive: { type: Boolean, default: false }
})
const docs = ref([])
const loader = createBudgetWaterfallLoader((data, options) => window.api.linkBudget.waterfall({
  results: JSON.parse(JSON.stringify(data)), ...options
}))
let prevKey = ''
watch(() => [props.rows, props.lang, props.adaptive, props.orbitType], () => {
  const rows = props.rows.map((row) => ({ ...row, data: toRaw(row.data) }))
  const nextKey = `${props.lang}|${props.adaptive ? 1 : 0}|${props.orbitType}|` + rows.map((r) => `${r.rowId}:${r.no}:${r.name || ''}:${r.err || ''}:${r.txName || ''}:${r.rxName || ''}`).join(';')
  if (nextKey === prevKey && rows.length === docs.value.length && rows.every((r, i) => r.data === docs.value[i]?.data)) return
  prevKey = nextKey
  docs.value = rows.map((row) => ({ ...row, segments: [], loading: !!row.data }))
  loader.update(rows, { lang: props.lang, orbitType: props.orbitType, adaptUnits: props.adaptive },
    (i, result) => { docs.value[i] = { ...rows[i], ...result, segments: result.segments ? markRaw(result.segments) : [] } })
}, { immediate: true })
onBeforeUnmount(() => loader.dispose())
</script>

<template>
  <div class="lbx-multi-budget">
    <section v-for="doc in docs" :key="doc.rowId" class="lbx-budget-row">
      <div class="lbx-budget-hd"><b class="lbx-rr-no">#{{ doc.no }}</b><span data-i18n-skip>{{ doc.name }}</span></div>
      <div v-if="doc.err" class="lb-err">{{ doc.err }}</div>
      <div v-else-if="doc.loading" class="lb-placeholder">正在加载…</div>
      <div v-else-if="!doc.segments.length" class="lb-placeholder">该行尚未计算</div>
      <div v-else class="lbx-doc">
        <div class="lbx-doc-main"><WaterfallTable :segments="doc.segments" pick="cascade" :lang="lang" /></div>
        <div class="lbx-doc-ref"><WaterfallTable :segments="doc.segments" pick="rest" :lang="lang" /></div>
      </div>
    </section>
  </div>
</template>
