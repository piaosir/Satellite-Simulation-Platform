<script setup>
import { computed } from 'vue'
const props = defineProps({ model: { type: Object, required: true } })
const d = computed(() => props.model.doc || {})
const p = computed(() => props.model.presentation || {})
const reference = computed(() => props.model.topologyReference)
const cascadeFigures = computed(() => props.model.cascadeTopologyFigures || [])
const en = computed(() => props.model.lang === 'en')
const t = computed(() => props.model.t || {})
const meta = computed(() => [[t.value.cvDocNo, d.value.docNo], [t.value.org, d.value.org], [t.value.date, d.value.date], [t.value.cvClass, d.value.classification]]
  .filter((r) => r[1]).map((r) => r[0] + ': ' + r[1]).join(' · '))
</script>
<template>
  <header class="rp-opening">
    <h1 class="rp-cv-title">{{ d.title }}</h1>
    <p class="rp-origin">{{ meta }}</p>
    <h2 v-if="p.intro" class="rp-h2">{{ en ? 'Solution overview' : '方案概述' }}</h2>
    <p v-if="p.intro" class="rp-solution-intro">{{ p.intro }}</p>
    <p v-if="p.facts?.length" class="rp-origin">{{ p.facts.map((r) => r.label + ': ' + r.value).join(' · ') }}</p>
    <p v-if="p.cards?.length" class="rp-overview-line">{{ p.cards.map((c) => c.label + ': ' + c.value + (c.unit ? ' ' + c.unit : '')).join('　　') }}</p>
    <figure v-if="reference?.dataUrl" class="rp-fig rp-solution-figure">
      <img :src="reference.dataUrl" :alt="reference.title" :width="reference.width" :height="reference.height">
      <figcaption>{{ reference.caption }}</figcaption>
    </figure>
    <h2 v-if="cascadeFigures.length" class="rp-h2">{{ en ? 'Actual cascade topology' : '实际级联拓扑' }}</h2>
    <figure v-for="(f, fi) in cascadeFigures" :key="fi" class="rp-fig rp-solution-figure rp-cascade-figure">
      <img :src="f.dataUrl" :alt="f.title" :width="f.width" :height="f.height">
      <figcaption>{{ f.caption }}</figcaption>
    </figure>
  </header>
</template>
