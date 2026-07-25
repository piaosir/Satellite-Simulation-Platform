<script setup>
// 功能区「字号」组：调数据区基准字号 --lb-fs（链路表 / 详细预算 / 容量汇总等结果排版）。
// A− / A+ 步进、双击数值恢复默认；值走 shared/lbFont.js（localStorage 三窗共享 + 跨窗同步）。
// 样式（.lbf-*）在 styles/lbworkbench.css。
import { ref, onMounted } from 'vue'
import { getLbFontSize, setLbFontSize, initLbFontSize, LB_FONT_DEFAULT, LB_FONT_MIN, LB_FONT_MAX } from '../shared/lbFont.js'

const size = ref(getLbFontSize())
function step(d) { size.value = setLbFontSize(size.value + d) }
function reset() { size.value = setLbFontSize(LB_FONT_DEFAULT) }
onMounted(() => initLbFontSize((v) => { size.value = v }))
</script>

<template>
  <div class="lbr-g">
    <div class="lbr-items">
      <button class="lbf-btn" :disabled="size <= LB_FONT_MIN" title="缩小数据区字号" @click="step(-1)">A−</button>
      <span class="lbf-val" :title="`数据区字号 ${size}px（链路表 / 详细预算 / 容量汇总）\n双击恢复默认 ${LB_FONT_DEFAULT}px`" @dblclick="reset">{{ size }}</span>
      <button class="lbf-btn" :disabled="size >= LB_FONT_MAX" title="放大数据区字号" @click="step(1)">A+</button>
    </div>
    <div class="lbr-cap">字号</div>
  </div>
</template>
