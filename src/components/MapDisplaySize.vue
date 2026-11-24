<script setup>
import { computed, useId } from 'vue'

const props = defineProps({
  kind: { type: String, required: true },
  value: { type: Number, required: true }
})
const emit = defineEmits(['set'])
const headingId = useId()

const markerHint = '默认视角下的图标大小。模型取整到像素，最小 8 px。'
const fields = {
  station: { label: '图标与模型大小', scope: '全部地球站', min: 5, max: 120, step: 0.1, hint: markerHint },
  trajectory: { label: '图标与模型大小', scope: '全部航迹', min: 1, max: 120, step: 0.1, hint: markerHint },
  satellite: { label: '卫星模型大小', scope: '全部卫星', min: 4, max: 2048, step: 1, hint: '3D 球面上卫星模型在默认视距下的显示直径。跟随视图的主星按实际尺寸绘制。' }
}
const field = computed(() => fields[props.kind])
</script>

<template>
  <div class="map-display-size" :title="field.hint">
    <div :id="headingId" class="size-heading">
      <slot><label>{{ field.label }}</label></slot>
      <span class="size-scope">{{ field.scope }}</span>
    </div>
    <div class="size-control">
      <input type="range" :min="field.min" :max="field.max" :step="field.step" :value="value"
        :aria-labelledby="headingId" :aria-valuetext="value + ' px'"
        @input="emit('set', $event.target.valueAsNumber)" />
      <span>{{ value }} px</span>
    </div>
  </div>
</template>

<style scoped>
.size-heading, .size-control { display: flex; align-items: center; gap: 4px 8px; }
.size-heading { flex-wrap: wrap; justify-content: space-between; color: var(--text); }
.size-scope { color: var(--text-muted); font-size: var(--fs-2); }
.size-control { margin-top: 4px; --rnum-w: 62px; }
.size-control input { flex: 1; min-width: 0; }
</style>
