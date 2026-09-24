<script setup>
// 分析页图表宿主：把框架无关的 MaskChart / TimelineChart（src/viz/models）挂进一个 div，数据变了 setData，卸载时 dispose。
// KeepAlive 切页签回来时图还在（组件没卸载）；图自己按容器宽度 ResizeObserver 重排。
import { ref, onMounted, onBeforeUnmount, watch, shallowRef } from 'vue'
import { MaskChart } from '../../viz/models/maskChart.js'
import { TimelineChart } from '../../viz/models/timelineChart.js'

const props = defineProps({
  kind: { type: String, required: true },          // 'mask' | 'timeline'
  data: { type: Object, default: null },
  overlays: { type: Object, default: null },       // mask：{marks, polylines}
  mode: { type: String, default: 'blocked' },      // mask：'blocked' | 'clearance'
  tz: { type: [String, Number], default: 'local' },// timeline
  panelHeight: { type: Number, default: 110 }
})
const emit = defineEmits(['hover'])
const el = ref(null)
const chart = shallowRef(null)
onMounted(() => {
  chart.value = props.kind === 'mask'
    ? new MaskChart({ mode: props.mode, onHover: (i) => emit('hover', i) })
    : new TimelineChart({ tz: props.tz, panelHeight: props.panelHeight, onHover: (i) => emit('hover', i) })
  chart.value.mount(el.value)
  if (props.overlays && chart.value.setOverlays) chart.value.setOverlays(props.overlays)
  chart.value.setData(props.data)
})
watch(() => props.data, (d) => { if (chart.value) chart.value.setData(d) })
watch(() => props.overlays, (o) => { if (chart.value && chart.value.setOverlays) chart.value.setOverlays(o || {}) })
watch(() => props.mode, (m) => { if (chart.value && chart.value.setMode) chart.value.setMode(m) })
watch(() => props.tz, (z) => { if (chart.value && chart.value.setTz) chart.value.setTz(z) })
onBeforeUnmount(() => { if (chart.value) chart.value.dispose(); chart.value = null })
defineExpose({ exportPng: (o) => (chart.value ? chart.value.exportPng(o) : Promise.reject(new Error('图还没画'))), chart })
</script>

<template>
  <div ref="el" class="cb" :class="kind"></div>
</template>

<style scoped>
.cb { width: 100%; min-height: 60px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--bg); overflow: hidden; }
</style>
