<script setup>
// 链路预算功能区的「单位」「字号」两组（四窗共用）。
// 功能区放不下时按 Office 功能区的收缩法：这两组先合成一枚「显示」下拉钮，其余组不动；
// 下拉层 position:fixed（.lb-ctx），留在 .lbr 里吃得到功能区小控件的定高规则。
// 窗口放宽到能装下完整功能区时再展开。完整宽度按屏上实量（字体 / 字号可调，不写死）。
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import LbUnitCtl from './LbUnitCtl.vue'
import LbFontCtl from './LbFontCtl.vue'

const root = ref(null)
const compact = ref(false)
const pop = ref(null)
let fullW = 0, ro = null, bar = null

function fit() {
  if (!bar) return
  if (!compact.value) {
    if (bar.scrollWidth > bar.clientWidth + 1) { fullW = bar.scrollWidth; compact.value = true }
  } else if (bar.clientWidth >= fullW) {
    compact.value = false; pop.value = null
    nextTick(fit)          // 展开后若仍放不下（字号刚调大等）立刻再收
  }
}
function toggle(ev) {
  if (pop.value) { pop.value = null; return }
  const r = ev.currentTarget.getBoundingClientRect()
  pop.value = { x: Math.max(4, Math.min(r.left, window.innerWidth - 260)), y: r.bottom + 2 }
}
onMounted(() => {
  bar = root.value && root.value.closest('.lbr')
  if (!bar || typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(() => fit())
  ro.observe(bar)
  nextTick(fit)
})
onBeforeUnmount(() => { if (ro) ro.disconnect() })
</script>

<template>
  <div ref="root" class="lbd-wrap">
    <template v-if="!compact">
      <LbUnitCtl />
      <LbFontCtl />
    </template>
    <div v-else class="lbr-g">
      <div class="lbr-items">
        <button class="lbr-big" :class="{ on: !!pop }" :aria-pressed="(!!pop) ? 'true' : 'false'" title="单位 · 字号" @click="toggle">
          <Icon name="sliders-horizontal" :size="16" />显示
        </button>
      </div>
      <div class="lbr-cap">显示</div>
    </div>
    <div v-if="pop" class="lb-ctx-mask menu-mask" @mousedown="pop = null" @contextmenu.prevent="pop = null">
      <div class="lb-ctx lbd-pop menu" :style="{ left: pop.x + 'px', top: pop.y + 'px' }" @mousedown.stop>
        <LbUnitCtl />
        <LbFontCtl />
      </div>
    </div>
  </div>
</template>

<style scoped>
.lbd-wrap { display: contents; }
.lbd-pop { display: flex; flex-direction: column; gap: 6px; padding: 6px 8px; }
.lbd-pop :deep(.lbr-g) { flex-direction: row-reverse; justify-content: flex-end; align-items: center; gap: 10px; padding: 0; }
.lbd-pop :deep(.lbr-g::after) { display: none; }
.lbd-pop :deep(.lbr-items) { min-height: 0; }
.lbd-pop :deep(.lbr-cap) { min-width: 28px; text-align: left; padding: 0; }
</style>
