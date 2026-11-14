<script setup>
// Print only: every displayed value is taken from the frozen report snapshot.
import { ref, computed, onMounted, nextTick } from 'vue'
import ReportBudgetTables from './ReportBudgetTables.vue'
import ReportOverview from './ReportOverview.vue'
import ReportSubreport from './ReportSubreport.vue'
import ReportDataTable from './ReportDataTable.vue'
const model = ref(null)
const api = typeof window !== 'undefined' ? window.api?.reportPrint : null
const en = computed(() => model.value?.lang === 'en')
const L = computed(() => model.value?.t || {})
const links = computed(() => model.value?.links || [])
const isSubreport = computed(() => ['sla', 'cap'].includes(model.value?.kind))
const sections = computed(() => model.value?.sections?.length > 1 ? model.value.sections.map((s, i) => ({ ...s,
  links: links.value.filter((l) => l.sec === i) })) : [{ links: links.value, summary: model.value?.summary || {}, title: '' }])
const chunk = (items, n = 4) => Array.from({ length: Math.ceil(items.length / n) }, (_, i) => ({ from: i * n, items: items.slice(i * n, i * n + n) }))
const matrixChunks = (m) => chunk((m.head || []).slice(1)).map((c) => ({ head: [m.head[0], ...c.items], rows: (m.rows || []).map((r) => [r[0], ...r.slice(c.from + 1, c.from + 1 + c.items.length)]) }))
const path = (l) => [l.txName, l.rxName].map((v) => v || '—').join(' → ')
const refIds = computed(() => [...new Set((model.value?.method?.refGroups || []).flatMap((g) => (g.items || []).map((r) => r.id)))])
onMounted(async () => {
  try {
    model.value = api ? await api.model() : null
    if (!model.value) throw new Error('Report model is unavailable')
    document.documentElement.lang = en.value ? 'en' : 'zh-CN'
    document.title = model.value.doc?.title || 'Report'
    const f = model.value.doc?.fonts
    if (f?.cssBody) document.documentElement.style.setProperty('--rp-font-body', f.cssBody)
    if (f?.cssHead) document.documentElement.style.setProperty('--rp-font-head', f.cssHead)
    await nextTick()
    await document.fonts?.ready
    await Promise.all(Array.from(document.images).map(async (im) => {
      if (im.decode) await im.decode()
      else if (!im.complete) await new Promise((resolve, reject) => { im.onload = resolve; im.onerror = reject })
      if (!im.naturalWidth) throw new Error('Report image failed to load')
    }))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    if (window.__reportError) throw new Error(window.__reportError)
    window.__reportReady = true
    api?.ready?.()
  } catch (e) { window.__reportError = e?.message || String(e); window.__reportReady = false }
})
</script>
<template>
  <div v-if="model" class="rp" data-i18n-skip>
    <ReportSubreport v-if="isSubreport" :model="model" />
    <template v-else>
      <ReportOverview :model="model" />
      <section v-for="(s, si) in sections" :key="si" class="rp-summary-section">
        <h2 class="rp-h2">{{ [s.title, en ? 'Key link results' : '链路主要结果'].filter(Boolean).join(' · ') }}</h2>
        <ReportDataTable v-for="(c, ci) in chunk(s.links)" :key="ci" :head="[L.param, ...c.items.map((l) => '#' + l.no + ' ' + path(l))]"
          :rows="(s.summary?.metrics || []).map((r) => [r.label, ...r.values.slice(c.from, c.from + c.items.length)])"
          :widths="[42, ...c.items.map(() => 58 / c.items.length)]" :align="['left', ...c.items.map(() => 'right')]" />
        <template v-if="s.summary?.cap">
          <h3 class="rp-caption">{{ L.capacity }}</h3>
          <ReportDataTable v-for="(m, mi) in matrixChunks(s.summary.cap)" :key="mi" :head="m.head" :rows="m.rows"
            :widths="[34, ...m.head.slice(1).map(() => 66 / (m.head.length - 1))]" />
        </template>
        <ReportDataTable v-else-if="s.summary?.stats?.length" :head="[L.param, L.value]" :rows="s.summary.stats.map((r) => [r.label, r.value])" :widths="[65,35]" />
      </section>
      <template v-for="(t, ti) in model.slaCommitments?.tables || []" :key="'sla-' + ti">
        <h2 class="rp-h2">{{ t.title }}</h2>
        <ReportDataTable :head="t.head" :rows="t.rows" :widths="t.widths" :align="t.align" :group-rows="t.groupRows" />
      </template>
      <section v-for="(l, li) in links" :key="l.no" class="rp-detail">
        <h2 class="rp-detail-name">#{{ l.no }} {{ path(l) }}</h2>
        <p v-if="l.error || !l.data" class="rp-fail">{{ l.error || L.noResult }}</p>
        <ReportBudgetTables v-else :inputs="l.inputs || []" :segments="l.segments || []" :lang="model.lang" :input-title="L.inputs" :result-title="L.results" />
        <div v-if="!l.error && l.data && l.figures?.length" class="rp-figure-grid">
          <figure v-for="(f, fi) in l.figures" :key="fi" class="rp-fig"><img :src="f.dataUrl" :alt="f.title"><figcaption>{{ f.title }}</figcaption></figure>
        </div>
      </section>
      <p v-if="refIds.length" class="rp-note">{{ en ? 'Calculation references: ' : '计算依据：' }}{{ refIds.join('；') }}</p>
    </template>
  </div>
</template>
