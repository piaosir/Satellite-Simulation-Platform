<script setup>
import { computed } from 'vue'

const props = defineProps({
  visible: Boolean, color: { type: String, default: 'currentColor' },
  width: { type: Number, default: 0.7 }, dashArray: String,
  label: { type: String, required: true }
})
const previewWidth = computed(() => Math.min(5, Math.max(1.5, props.width)))
</script>

<template>
  <button type="button" class="ibtn angle-visibility" :aria-label="label" :aria-pressed="visible"
          :title="visible ? '隐藏角度线' : '显示角度线'">
    <svg width="24" height="16" viewBox="0 0 24 16" aria-hidden="true" fill="none" stroke-linecap="round">
      <g v-if="visible" :stroke-dasharray="dashArray">
        <path d="M3 8h18" stroke="var(--text)" stroke-opacity=".5" :stroke-width="previewWidth + 1.5" />
        <path d="M3 8h18" :stroke="color" :stroke-width="previewWidth" />
      </g>
      <path v-else d="M3 8h4.5m9 0H21M9.5 12.5l5-9" stroke="currentColor" stroke-width="1.5" />
    </svg>
  </button>
</template>

<style scoped>
.angle-visibility { width: 28px; height: 24px; }
</style>
