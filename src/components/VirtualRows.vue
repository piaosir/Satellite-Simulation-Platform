<script setup>
// 定高行的虚拟滚动：只渲染滚动容器可见区（上下各多留 overscan 行）里的行，上下两段空白撑出总高、滚动条与全量渲染时一样长。
// 行数不超过 threshold 时全部渲染、不出空白段 —— 与不虚拟化时逐元素相同。
// 用法：放进滚动容器（scroller，通常是父组件的模板 ref），跟在容器自己的粘顶表头之后；head = 第一行之前的高度（表头高）。
// 行由默认插槽按 { item, index } 渲染（在父组件作用域编译，样式 / 事件照旧）；rowH 必须恒定。
// 空白段是 grid 整行（grid-column: 1 / -1），网格列表与普通块级列表都适用。
import { ref, computed, watch, onBeforeUnmount } from 'vue'

const props = defineProps({
  items: { type: Array, required: true },
  rowH: { type: Number, required: true },
  head: { type: Number, default: 0 },
  scroller: { type: Object, default: null },
  keyOf: { type: Function, default: (it, i) => i },
  threshold: { type: Number, default: 60 },
  overscan: { type: Number, default: 6 }
})

const top = ref(0)
const viewH = ref(0)
let el = null
function measure() { if (el) { top.value = el.scrollTop; viewH.value = el.clientHeight } }
const onScroll = () => measure()
let ro = null
watch(() => props.scroller, (s) => {
  if (el) el.removeEventListener('scroll', onScroll)
  if (ro) { ro.disconnect(); ro = null }
  el = s && s.addEventListener ? s : null
  if (!el) return
  el.addEventListener('scroll', onScroll, { passive: true })
  if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(measure); ro.observe(el) }
  measure()
}, { immediate: true })
onBeforeUnmount(() => { if (el) el.removeEventListener('scroll', onScroll); if (ro) ro.disconnect(); el = null })

const virt = computed(() => props.items.length > props.threshold)
const range = computed(() => {
  const n = props.items.length
  if (!virt.value) return [0, n]
  const vh = viewH.value > 0 ? viewH.value : 600
  const a = Math.max(0, Math.floor((top.value - props.head) / props.rowH) - props.overscan)
  const b = Math.min(n, Math.ceil((top.value + vh - props.head) / props.rowH) + props.overscan)
  return [Math.min(a, n), Math.max(Math.min(a, n), b)]
})
const rows = computed(() => {
  const [a, b] = range.value, out = []
  for (let i = a; i < b; i++) out.push(i)
  return out
})
const padTop = computed(() => range.value[0] * props.rowH)
const padBot = computed(() => (props.items.length - range.value[1]) * props.rowH)
</script>

<template>
  <div v-if="padTop > 0" :style="{ gridColumn: '1 / -1', height: padTop + 'px' }" aria-hidden="true"></div>
  <template v-for="i in rows" :key="keyOf(items[i], i)"><slot :item="items[i]" :index="i" /></template>
  <div v-if="padBot > 0" :style="{ gridColumn: '1 / -1', height: padBot + 'px' }" aria-hidden="true"></div>
</template>
