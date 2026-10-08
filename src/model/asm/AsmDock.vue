<script setup>
// 装配页右侧 dock（契约 §6.4）：上 = 结构树、下 = 属性，中间一条可拖的分隔（比例存 model/asm/ui.split，缺省 0.42）。
// 栏宽由 ModelApp 那一列管（左缘拖宽，260–520）。
// 2026-10-06（任务书 §3.3.3）：结构树按行数自适应高度——树区 = min(树的自然高度（AsmTree natural 事件）, 分隔比例 × dock 高)，
//   分隔比例就是树区的上限：行少时属性面板拿到其余空间（选中件的「安装」节落在首屏），行多时树区停在上限内滚动。拖分隔条改的是上限。
import { inject, ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AsmTree from './AsmTree.vue'
import AsmProps from './AsmProps.vue'

const asm = inject('asm')
const ui = asm.ui
const el = ref(null)
const splitting = ref(false)
const PANE_MIN = 90   // 与 .asm-pane 的 min-height 同
const dockH = ref(0), treeNat = ref(0)
let rsz = null, raf = 0
const upd = () => { raf = 0; const h = el.value ? el.value.clientHeight : 0; if (Math.abs(h - dockH.value) >= 1) dockH.value = h }
onMounted(() => {
  // 观察回调里只排帧（同 AsmTree：不在 ResizeObserver 回调里改布局）
  if (typeof ResizeObserver === 'function' && el.value) { rsz = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(upd) }); rsz.observe(el.value) }
  upd()
})
onBeforeUnmount(() => { if (rsz) rsz.disconnect(); rsz = null; if (raf) cancelAnimationFrame(raf); raf = 0 })
const treeBasis = computed(() => {
  const H = dockH.value
  if (!(H > 0)) return (ui.split * 100) + '%'
  const cap = ui.split * H
  const nat = treeNat.value > 0 ? treeNat.value : cap
  return Math.round(Math.max(PANE_MIN, Math.min(cap, nat))) + 'px'
})
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
    <div class="asm-pane" data-pane="tree" :style="{ flexBasis: treeBasis }"><AsmTree @natural="(h) => (treeNat = h)" /></div>
    <div class="asm-split" title="拖动调整结构树高度上限" @pointerdown="startSplit"></div>
    <div class="asm-pane grow" data-pane="props"><AsmProps /></div>
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
