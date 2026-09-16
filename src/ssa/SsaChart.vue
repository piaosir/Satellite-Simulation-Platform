<script setup>
// 电子报告里的一幅图（屏上档）。
//
// 图的笔画全在 shared/ssaChartSvg.js（零 DOM 的纯函数，只拼字符串）：本组件只负责把它按容器
// 当前宽度拼出来挂进 DOM，并在容器宽度变化时重拼。屏上与 Word 吃的是**同一份 spec、同一个
// 渲染函数**（导出时换 theme:'print' 再栅格化，见 SsaReportDialog），故报告里的图与眼前这张
// 必然是同一张 —— 两条渲染路径分家正是「报告里的图和屏上看到的不一样」的由来。
//
// ★ 只盯宽度，不盯主题、不盯字号：theme:'screen' 档的颜色是 var(--…) token（主题一换 SVG
//   自己跟色），字号由 chartSvg 按图宽定（不读 --lb-fs）。故主题 / 数据区字号变了都不必重拼，
//   这里也就不必像 LbSurfacePlot 那样再挂一个 MutationObserver 盯 <html>。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { chartSvg } from '../shared/ssaChartSvg.js'

const props = defineProps({
  // 图 spec（模型里的 figures[figId].spec，七型之一）；为空只留空白不报错
  spec: { type: Object, default: null },
  // 题注（「图 3　在轨对象逐年」一类，编号由调用方数好）
  caption: { type: String, default: '' },
  // 图上文字已由模型翻好，这里只传给 chartSvg 供它自己的少量字面量（空态等）取语言
  lang: { type: String, default: 'zh' }
})

const wrap = ref(null)
const width = ref(560)
const MIN_W = 320        // 再窄坐标轴与刻度就挤不开了，宁可让容器横滚

const svg = computed(() => {
  if (!props.spec) return ''
  try {
    return chartSvg(props.spec, { theme: 'screen', width: width.value, lang: props.lang })
  } catch (e) {
    // 一幅图画不出来不该把整篇报告带下去：留空即可，控制台留因由
    console.warn('[ssa] 图渲染失败', e)
    return ''
  }
})

let _ro = null
onMounted(() => {
  const el = wrap.value
  if (!el) return
  const measure = () => { width.value = Math.max(MIN_W, Math.round(el.clientWidth || 560)) }
  measure()
  if (window.ResizeObserver) { _ro = new ResizeObserver(measure); _ro.observe(el) }
})
onBeforeUnmount(() => { if (_ro) { _ro.disconnect(); _ro = null } })
</script>

<template>
  <figure ref="wrap" class="ssa-figure">
    <!-- v-html：整串 SVG 由 ssaChartSvg 拼出，标签是它自己写的、标签里的字它自己转义，没有外来标记 -->
    <div class="ssa-figure-svg" v-html="svg"></div>
    <figcaption v-if="caption" class="ssa-figure-cap">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.ssa-figure { margin: 0; min-width: 0; }
/* 图自身按容器宽度重画（不靠缩放），故这里只负责横向兜底：窄到 MIN_W 以下时让它横滚而不是压扁 */
.ssa-figure-svg { overflow-x: auto; line-height: 0; }
.ssa-figure-svg :deep(svg) { display: block; }
/* 图题在图下方（中文出版惯例，与 Word 端 figureParagraphs 一致） */
.ssa-figure-cap {
  margin-top: 4px; font-size: var(--lb-fs); color: var(--text-muted);
  font-variant-numeric: tabular-nums; line-height: 1.5;
}
</style>
