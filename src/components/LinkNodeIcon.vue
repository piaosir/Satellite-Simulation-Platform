<script setup>
import { inject } from 'vue'
import MarkLegend from './MarkLegend.vue'

defineProps({
  kind: { type: String, required: true },
  objectId: [String, Number],
  size: { type: Number, default: 24 }
})
const legendFor = inject('mapNodeLegend')
</script>

<template>
  <MarkLegend class="node-icon" :size="size" v-bind="legendFor(kind, objectId)" />
</template>
