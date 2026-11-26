<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  paneId: { type: String, required: true },
  label: { type: String, required: true },
  fraction: { type: Number, default: 0.34 },
  minUpper: { type: Number, default: 100 },
  minLower: { type: Number, default: 150 }
})
const box = ref(null), upper = ref(null)
const available = ref(0), actual = ref(0)
const key = 'coverage-pane-ratio/' + props.paneId
const ratio = ref(null)
try {
  const saved = parseFloat(localStorage.getItem(key))
  if (saved > 0 && saved < 1) ratio.value = saved
} catch { /* Storage is optional. */ }
const gripHeight = 8
const min = computed(() => Math.min(props.minUpper, Math.floor(available.value * 0.42)))
const max = computed(() => available.value - Math.min(props.minLower, Math.floor(available.value * 0.48)))
function clamp(px) { return Math.max(min.value, Math.min(max.value, Math.round(px))) }
const size = computed(() => {
  if (!available.value) return { maxHeight: (props.fraction * 100) + '%' }
  const px = clamp(available.value * (ratio.value ?? props.fraction)) + 'px'
  return ratio.value === null ? { maxHeight: px } : { height: px }
})
let observer, frame
onMounted(() => {
  function measure() {
    available.value = Math.max(0, box.value.clientHeight - gripHeight)
    actual.value = upper.value.offsetHeight
  }
  measure()
  observer = new ResizeObserver(() => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(measure)
  })
  observer.observe(box.value)
  observer.observe(upper.value)
})
onBeforeUnmount(() => { observer?.disconnect(); cancelAnimationFrame(frame); finish() })

function save() {
  try {
    if (ratio.value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(ratio.value))
  } catch { /* Resizing still works for this session. */ }
}
function setPixels(px) {
  if (available.value > 0) ratio.value = clamp(px) / available.value
}
const dragging = ref(false)
let startY, startHeight, pointer, scale
function start(e) {
  if (dragging.value || e.button !== 0 || !e.isPrimary) return
  e.preventDefault()
  e.currentTarget.focus({ preventScroll: true })
  pointer = e.pointerId
  startY = e.clientY
  startHeight = upper.value.offsetHeight
  scale = box.value.clientHeight / box.value.getBoundingClientRect().height
  dragging.value = true
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
  window.addEventListener('blur', finish)
}
function move(e) {
  if (!dragging.value || pointer !== e.pointerId) return
  if (e.clientY !== startY || ratio.value !== null) setPixels(startHeight + (e.clientY - startY) * scale)
}
function finish(e) {
  if (!dragging.value || (e?.pointerId != null && pointer !== e.pointerId)) return
  dragging.value = false
  window.removeEventListener('pointermove', move, true)
  window.removeEventListener('pointerup', finish, true)
  window.removeEventListener('pointercancel', finish, true)
  window.removeEventListener('blur', finish)
  save()
}
function reset() { ratio.value = null; save() }
function keydown(e) {
  const step = e.shiftKey ? 40 : 8
  const positions = { ArrowUp: actual.value - step, ArrowDown: actual.value + step, Home: min.value, End: max.value }
  if (!Object.hasOwn(positions, e.key)) return
  e.preventDefault()
  e.stopPropagation()
  setPixels(positions[e.key])
  save()
}
</script>

<template>
  <div ref="box" class="coverage-split" :class="{ dragging }">
    <div :id="paneId" ref="upper" class="split-upper" :style="size"><slot name="upper" /></div>
    <div class="split-grip" role="separator" tabindex="0" aria-orientation="horizontal"
         :aria-label="label" :aria-controls="paneId" :aria-valuenow="actual" :aria-valuemin="Math.min(actual, min)" :aria-valuemax="max"
         title="拖动调整高度，双击恢复自动高度" @pointerdown="start" @dblclick="reset" @keydown="keydown"></div>
    <div class="split-lower"><slot /></div>
  </div>
</template>

<style scoped>
.coverage-split, .split-upper, .split-lower { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.coverage-split, .split-lower { flex: 1 1 0; overflow: hidden; }
.split-upper { flex: none; overflow: hidden; }
.split-grip { flex: 0 0 8px; position: relative; cursor: row-resize; touch-action: none; outline-offset: -2px; }
.split-grip::before, .split-grip::after { content: ''; position: absolute; top: 50%; transform: translateY(-50%); }
.split-grip::before { inset-inline: 0; height: 1px; background: var(--border); }
.split-grip::after { left: calc(50% - 12px); width: 24px; height: 3px; border-radius: 2px; background: var(--border-strong); }
.split-grip:is(:hover, :focus-visible)::after, .dragging > .split-grip::after { background: var(--accent-ui); }
.dragging { user-select: none; cursor: row-resize; }
</style>
