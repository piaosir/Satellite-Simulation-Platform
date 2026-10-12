<script setup>
// 视频导出 · 取景框的屏上把手：拖框边 = 平移，拖四角 = 等比缩放（锚在对角；按住 Alt 以框心缩放），双击框边 / 角 = 复位（最大居中）。
// 框内框外都不挡地图：容器 pointer-events: none，只有四条边带（框线内侧 8 px）与四个角块吃指针 —— 框里照样转地球、滚轮缩放。
// ★ 把手一律落在框【内侧】：最大框贴着舞台边，骑线的把手会伸进相邻的停靠栏分隔条，按下去拖的是栏宽（验证台实测踩到）。
// 框的位置 / 大小记在导出设置 S.frame（相对舞台的框心 + 相对最大可容框的比例），由 useVideoExport.setFrameRect 夹进舞台后落定。
// ★ 只有主键才抓指针（setPointerCapture）：右键 / 中键抓了不放，pointerup 落不到这里就一直卡在拖动态（平台已栽过一次）
import { ref, computed } from 'vue'
import { FRAME_SMIN } from '../shared/video/videoPlan.js'

const props = defineProps({ vx: { type: Object, required: true } })
const vx = props.vx
const T = vx.T

const show = computed(() => vx.S.framing && !!vx.cropNow.value && vx.phase.value !== 'running' && vx.phase.value !== 'finishing')
const boxStyle = computed(() => {
  const c = vx.cropNow.value
  return c ? { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' } : {}
})
const pct = computed(() => Math.round((vx.S.frame.s || 1) * 100))
const dragging = ref(false)
const TIP = computed(() => T('拖框边移动，拖四角缩放（Alt：以框心缩放），双击复位', 'Drag an edge to move, a corner to resize (Alt: about the center); double-click to reset'))

let drag = null
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
function down(e, mode) {
  if (e.button !== 0) return
  const c = vx.cropNow.value
  if (!c) return
  e.preventDefault(); e.stopPropagation()
  const el = e.currentTarget
  try { el.setPointerCapture(e.pointerId) } catch { /* 指针已失效 */ }
  const wrap = el.closest('.vfh').parentElement.getBoundingClientRect()
  drag = { mode, pid: e.pointerId, x0: e.clientX, y0: e.clientY, c0: { ...c }, maxW: c.w / (vx.S.frame.s || 1), wrap }
  dragging.value = true
}
function move(e) {
  if (!drag || e.pointerId !== drag.pid) return
  const { c0, wrap } = drag
  if (drag.mode === 'move') {
    vx.setFrameRect({ x: c0.x + e.clientX - drag.x0, y: c0.y + e.clientY - drag.y0, w: c0.w, h: c0.h })
    return
  }
  // 角：锚在对角（Alt：框心）；指针相对锚点的位移投到「锚点 → 被拖的角」那条对角线上定缩放比 —— 横拖、竖拖、斜拖都连续跟手
  const A = c0.w / c0.h, W = vx.stage.w, H = vx.stage.h
  const sx = drag.mode.includes('l') ? -1 : 1, sy = drag.mode.includes('t') ? -1 : 1
  const alt = e.altKey
  const px = e.clientX - wrap.left, py = e.clientY - wrap.top
  const ax = alt ? c0.x + c0.w / 2 : (sx < 0 ? c0.x + c0.w : c0.x)
  const ay = alt ? c0.y + c0.h / 2 : (sy < 0 ? c0.y + c0.h : c0.y)
  const dx = sx * c0.w / (alt ? 2 : 1), dy = sy * c0.h / (alt ? 2 : 1)
  let w = Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)) * c0.w
  // 从锚点往拖动方向（Alt：往两侧）还剩多少地方
  const roomW = alt ? 2 * Math.min(ax, W - ax) : (sx > 0 ? W - ax : ax)
  const roomH = alt ? 2 * Math.min(ay, H - ay) : (sy > 0 ? H - ay : ay)
  w = Math.min(clamp(w, FRAME_SMIN * drag.maxW, drag.maxW), roomW, roomH * A)
  const h = w / A
  const x = alt ? ax - w / 2 : (sx > 0 ? ax : ax - w)
  const y = alt ? ay - h / 2 : (sy > 0 ? ay : ay - h)
  vx.setFrameRect({ x, y, w, h })
}
function up(e) {
  if (!drag || e.pointerId !== drag.pid) return
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* 已释放 */ }
  drag = null
  dragging.value = false
}
const EDGES = ['t', 'b', 'l', 'r']
const CORNERS = ['tl', 'tr', 'bl', 'br']
</script>

<template>
  <div v-if="show" class="vfh" :class="{ on: dragging }" :style="boxStyle" data-i18n-skip>
    <div
      v-for="k in EDGES" :key="k" class="vfh-e" :class="k" :title="TIP"
      @pointerdown="down($event, 'move')" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @dblclick="vx.resetFrame()"
    ></div>
    <div
      v-for="k in CORNERS" :key="k" class="vfh-c" :class="k" :title="TIP"
      @pointerdown="down($event, k)" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up" @dblclick="vx.resetFrame()"
    ><i class="h"></i><i class="v"></i></div>
    <div v-if="dragging" class="vfh-ro">{{ vx.dims.value.w }} × {{ vx.dims.value.h }} · {{ pct }}%</div>
  </div>
</template>

<style scoped>
.vfh { position: absolute; z-index: 4; pointer-events: none; box-sizing: border-box; }
/* 边带：框线内侧 8 px，四角留给角块 */
.vfh-e { position: absolute; pointer-events: auto; cursor: move; touch-action: none; }
.vfh-e.t { top: 0; left: 20px; right: 20px; height: 8px; }
.vfh-e.b { bottom: 0; left: 20px; right: 20px; height: 8px; }
.vfh-e.l { left: 0; top: 20px; bottom: 20px; width: 8px; }
.vfh-e.r { right: 0; top: 20px; bottom: 20px; width: 8px; }
/* 角块：框角内侧 20 px 命中区，画取景器式 L 角（白线 + 一圈深色描边，浅底深底都看得见） */
.vfh-c { position: absolute; width: 20px; height: 20px; pointer-events: auto; touch-action: none; }
.vfh-c.tl { left: 0; top: 0; cursor: nwse-resize; }
.vfh-c.br { right: 0; bottom: 0; cursor: nwse-resize; }
.vfh-c.tr { right: 0; top: 0; cursor: nesw-resize; }
.vfh-c.bl { left: 0; bottom: 0; cursor: nesw-resize; }
.vfh-c > i { position: absolute; background: #fff; box-shadow: 0 0 0 1px rgba(8, 12, 18, 0.55); border-radius: 1px; }
.vfh-c > i.h { width: 16px; height: 2px; }
.vfh-c > i.v { width: 2px; height: 16px; }
.vfh-c.tl > i { left: 1px; top: 1px; }
.vfh-c.tr > i { right: 1px; top: 1px; }
.vfh-c.bl > i { left: 1px; bottom: 1px; }
.vfh-c.br > i { right: 1px; bottom: 1px; }
.vfh-c:hover > i, .vfh.on .vfh-c > i { background: var(--accent-ui); }
/* 拖动中的读数：成片尺寸 + 框占最大可容框的比例 */
.vfh-ro {
  position: absolute; left: 8px; bottom: 8px; padding: 2px 7px; border-radius: var(--r-ctl);
  background: rgba(8, 12, 18, 0.72); color: #fff; font-size: var(--fs-2); font-variant-numeric: tabular-nums; white-space: nowrap;
}
</style>
