<script setup>
// 装配页右侧 dock（契约 §6.4）：上 = 结构树、下 = 属性，中间一条可拖的分隔（比例存 model/asm/ui.split，缺省 0.42）。
// 栏宽由 ModelApp 那一列管（左缘拖宽，260–520）。
import { inject, ref } from 'vue'
import AsmTree from './AsmTree.vue'
import AsmProps from './AsmProps.vue'

const asm = inject('asm')
const ui = asm.ui
const el = ref(null)
const splitting = ref(false)
function startSplit(ev) {
  if (ev.button !== 0 || !el.value) return
  const box = el.value.getBoundingClientRect()
  const tgt = ev.currentTarget
  try { tgt.setPointerCapture(ev.pointerId) } catch { /* 无 */ }
  splitting.value = true
  const move = (e) => { ui.split = Math.min(0.8, Math.max(0.15, (e.clientY - box.top) / Math.max(1, box.height))) }
  const up = (e) => {
    splitting.value = false
    try { tgt.releasePointerCapture(e.pointerId) } catch { /* 无 */ }
    tgt.removeEventListener('pointermove', move); tgt.removeEventListener('pointerup', up); tgt.removeEventListener('pointercancel', up)
  }
  tgt.addEventListener('pointermove', move); tgt.addEventListener('pointerup', up); tgt.addEventListener('pointercancel', up)
  ev.preventDefault()
}
</script>

<template>
  <div ref="el" class="asm asm-dock" :class="{ splitting }">
    <div class="asm-pane" :style="{ flexBasis: (ui.split * 100) + '%' }"><AsmTree /></div>
    <div class="asm-split" title="拖动调整上下比例" @pointerdown="startSplit"></div>
    <div class="asm-pane grow"><AsmProps /></div>
  </div>
</template>

<style scoped>
.asm-dock { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--bg); }
.asm-dock.splitting { user-select: none; cursor: row-resize; }
.asm-pane { flex: 0 0 auto; min-height: 90px; display: flex; flex-direction: column; overflow: hidden; }
.asm-pane.grow { flex: 1 1 0; }
/* 分隔条：6px 命中区，中间 1px 线；悬停 / 拖动时机位色 */
.asm-split { flex: none; position: relative; height: 6px; margin: -3px 0; z-index: 2; cursor: row-resize; touch-action: none; }
.asm-split::after { content: ''; position: absolute; left: 0; right: 0; top: 2px; height: 1px; background: var(--border-strong); }
.asm-split:hover::after, .asm-dock.splitting .asm-split::after { top: 1px; height: 3px; background: var(--accent-ui); opacity: .5; }
</style>
