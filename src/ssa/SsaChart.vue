<script setup>
// 电子报告里的一幅图（纸面档，样式规范 2026-10-15 §F / §I）。
//
// 图的笔画全在 shared/ssaChartSvg.js（零 DOM 的纯函数，只拼字符串）：本组件只把它挂进 DOM。
// ★ 屏上与 Word 是【同一张图】：同一份 spec、同一个渲染函数、同一档（'paper'）、同一物理尺寸（mm）——
//   导出时 SsaReportDialog 以 scale = 1 出串、按 600 dpi 栅格化后原尺寸放进 Word；屏上这里按纸面缩放 s
//   出串（几何、字号、线宽一起乘 s，不靠 CSS 缩放 —— SVG 不写 viewBox，见 ssaChartSvg 头注）。
//   故图内字号恒为 8 pt × s，与纸上的正文 / 表文同比例；窗口宽窄不再改变图内字号。
// ★ 纸面恒浅色（§I.2），图在屏上也走 'paper' 档的写死色值，不再跟主题换色。
import { computed } from 'vue'
import { chartSvg } from '../shared/ssaChartSvg.js'

const props = defineProps({
  // 图 spec（模型里的 figures[figId].spec）；为空只留空白不报错
  spec: { type: Object, default: null },
  // 题注（「图 3-1　在轨对象逐年」一类，编号由调用方数好）
  caption: { type: String, default: '' },
  // 图上文字已由模型翻好，这里只传给 chartSvg 供它自己的少量字面量（空态等）取语言
  lang: { type: String, default: 'zh' },
  // 成图物理尺寸 [宽, 高]（mm），模型 figures[figId].mm 给
  mm: { type: Array, default: () => [160, 80] },
  // 纸面缩放 s（SsaDoc 量出来的）
  scale: { type: Number, default: 1 }
})

const svg = computed(() => {
  if (!props.spec) return ''
  try {
    return chartSvg(props.spec, { theme: 'paper', widthMm: props.mm[0], heightMm: props.mm[1], scale: props.scale, lang: props.lang })
  } catch (e) {
    // 一幅图画不出来不该把整篇报告带下去：留空即可，控制台留因由
    console.warn('[ssa] 图渲染失败', e)
    return ''
  }
})
</script>

<template>
  <figure class="ssa-figure">
    <!-- v-html：整串 SVG 由 ssaChartSvg 拼出，标签是它自己写的、标签里的字它自己转义，没有外来标记 -->
    <div class="ssa-figure-svg" v-html="svg"></div>
    <figcaption v-if="caption" class="ssa-figure-cap">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.ssa-figure { margin: 0; min-width: 0; display: flex; flex-direction: column; align-items: center; }
.ssa-figure-svg { line-height: 0; max-width: 100%; overflow-x: auto; }
.ssa-figure-svg :deep(svg) { display: block; }
/* 图题在图下方居中（GB/T 7713.3 §5.3.1、与 Word 端 figureParagraphs 一致）：14 px 600，与表题同级 */
.ssa-figure-cap {
  margin-top: calc(5px * var(--paper-s, 1)); text-align: center;
  font-size: calc(14px * var(--paper-s, 1)); font-weight: 600; color: var(--paper-ink, #222);
  font-variant-numeric: tabular-nums; line-height: 1.5;
}
</style>
