<script setup>
// 装配放置中的光标读数（2026-10-06 设计页交互重构 §3.3.2）：跟在指针右下，「目标件 · 接口 / 面 · 推断 · i/n · 滚转°」——运行时数据，
// 不是说明文字。拖动中逐帧更新，所以单独成组件：只有这里读 asm.ui.cursor，ModelApp 不跟着重排。不挡鼠标；贴近窗口右 / 下缘时翻到指针另一侧。
import { inject, computed, ref, watch, nextTick } from 'vue'

const asm = inject('asm')
const cur = asm.ui.cursor
const el = ref(null)
const OFF_X = 16, OFF_Y = 18, PAD = 6
// 读数框尺寸只在文字变了时量一次（拖动中逐帧只改 transform）
const box = { w: 0, h: 0 }
watch(() => cur.text, () => nextTick(() => { const e = el.value; if (e) { box.w = e.offsetWidth; box.h = e.offsetHeight } }), { immediate: true })
const style = computed(() => {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1600, vh = typeof window !== 'undefined' ? window.innerHeight : 1000
  let x = cur.x + OFF_X, y = cur.y + OFF_Y
  if (box.w && x + box.w > vw - PAD) x = Math.max(PAD, cur.x - OFF_X - box.w)
  if (box.h && y + box.h > vh - PAD) y = Math.max(PAD, cur.y - OFF_Y - box.h)
  return { transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)` }
})
</script>

<template>
  <div v-show="cur.on && cur.text" ref="el" class="asm-cur" :style="style" data-asm-cursor data-i18n-skip>{{ cur.text }}</div>
</template>

<style scoped>
.asm-cur {
  position: fixed; left: 0; top: 0; z-index: 240; pointer-events: none; max-width: 420px;
  padding: 2px 8px; font-size: var(--fs-2); line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-variant-numeric: tabular-nums; color: var(--text);
  background: color-mix(in srgb, var(--bg) 88%, transparent); border: 1px solid color-mix(in srgb, var(--border-strong) 80%, transparent);
  border-radius: var(--r-box); box-shadow: var(--shadow-1, 0 1px 3px rgba(0, 0, 0, 0.12));
}
</style>
