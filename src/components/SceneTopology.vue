<script setup>
// 应用场景仿真 · 拓扑图视图（中央视图第三档，与 3D 球 / 2D 地图并列切换）。
//
// 与地理视图是同一份 sceneStore 的两个投影：这里不存任何第二份数据，
// 位置由 topoLayout 现算，选中态与地图共用 scene.sel。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import { scene, effective, modById, mediaOf, tierOf, catLabel, linkReadings } from '../viz/scene/sceneStore.js'
import { layout } from '../viz/scene/topoLayout.js'
import { drawTopology, hitTest, palette } from '../viz/scene/topoRender.js'
import { theme } from '../stores/theme'
import { uiFont } from '../stores/uiFont'

// 字号跟界面：取 --fs-3（面板正文档），不另立一套
function panelFs() {
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--fs-3'))
  return Number.isFinite(v) ? v : 12
}

const wrap = ref(null)
const cv = ref(null)
const view = ref({ ox: 40, oy: 20, k: 1 })
const size = ref({ w: 900, h: 600 })
const drag = ref(null)

// resolve 出「有效模块」的 Map —— 与计算侧同口径（库条目 + 逐条覆盖）
const mods = computed(() => {
  const m = new Map()
  for (const inst of scene.modules) { const e = effective(inst); if (e) m.set(inst.id, e) }
  return m
})
const lay = computed(() => layout(
  { mods: mods.value, links: scene.links, flows: scene.result ? scene.result.flows : [] },
  { nudge: scene.nudge }
))
const model = computed(() => ({
  links: scene.links, flows: scene.flows, result: scene.result, sel: scene.sel,
  mediaOf, tierOf, catLabel, readings: linkReadings
}))

const touched = ref(false)   // 用户手动平移/缩放过 → 尺寸变化不再抢镜头
function resize() {
  const el = wrap.value; if (!el) return
  const r = el.getBoundingClientRect()
  size.value = { w: Math.max(200, Math.round(r.width)), h: Math.max(160, Math.round(r.height)) }
  // 面板尺寸一变，原来的平移量就把图推出视野了（侧栏拖宽、窗口最大化都会撞上）。
  // 没手动调过镜头的一律重新适应；调过的尊重用户。
  if (!touched.value) fit(); else draw()
}
function draw() {
  const c = cv.value; if (!c) return
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
  const { w, h } = size.value
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr) }
  c.style.width = w + 'px'; c.style.height = h + 'px'
  const ctx = c.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawTopology(ctx, lay.value, model.value, view.value, w, h, panelFs())
}
function fit() {
  const L = lay.value
  if (!L.nodes.length) { view.value = { ox: 40, oy: 20, k: 1 }; return }
  const { w, h } = size.value
  const k = Math.min((w - 40) / Math.max(1, L.w), (h - 40) / Math.max(1, L.h), 1.6)
  view.value = { ox: (w - L.w * k) / 2, oy: (h - L.h * k) / 2, k }
  draw()
}

// ── 交互 ──
function onDown(e) {
  if (e.button !== 0) return
  const r = cv.value.getBoundingClientRect()
  const sx = e.clientX - r.left, sy = e.clientY - r.top
  const hit = hitTest(lay.value, model.value, view.value, sx, sy)
  if (hit) {
    scene.sel = { type: hit.type, id: hit.id }
    if (hit.type === 'module') { drag.value = { id: hit.id, sx, sy, base: Object.assign({ dx: 0, dy: 0 }, scene.nudge[hit.id] || {}) } }
  } else {
    drag.value = { pan: true, sx, sy, ox: view.value.ox, oy: view.value.oy }
    touched.value = true
  }
  cv.value.setPointerCapture && cv.value.setPointerCapture(e.pointerId)
}
function onMove(e) {
  const d = drag.value; if (!d) return
  const r = cv.value.getBoundingClientRect()
  const sx = e.clientX - r.left, sy = e.clientY - r.top
  if (d.pan) { view.value = { ...view.value, ox: d.ox + (sx - d.sx), oy: d.oy + (sy - d.sy) }; draw() }
  else {
    scene.nudge[d.id] = { dx: d.base.dx + (sx - d.sx) / view.value.k, dy: d.base.dy + (sy - d.sy) / view.value.k }
    draw()
  }
}
function onUp(e) {
  drag.value = null
  try { cv.value.releasePointerCapture && cv.value.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
}
function onWheel(e) {
  e.preventDefault()
  const r = cv.value.getBoundingClientRect()
  const sx = e.clientX - r.left, sy = e.clientY - r.top
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const k = Math.max(0.25, Math.min(4, view.value.k * f))
  const s = k / view.value.k
  view.value = { k, ox: sx - (sx - view.value.ox) * s, oy: sy - (sy - view.value.oy) * s }
  touched.value = true
  draw()
}
function resetNudge() { scene.nudge = {}; touched.value = false; nextTick(fit) }

// ── 出图（4× 口径，与平台其余出图一致）──
const shooting = ref(false)
async function shot() {
  shooting.value = true
  try {
    const L = lay.value
    const S = 4
    const c = document.createElement('canvas')
    c.width = Math.round(L.w * S); c.height = Math.round(L.h * S)
    const ctx = c.getContext('2d')
    ctx.setTransform(S, 0, 0, S, 0, 0)
    drawTopology(ctx, L, model.value, { ox: 0, oy: 0, k: 1 }, L.w, L.h, (panelFs()))
    const url = c.toDataURL('image/png')
    const a = document.createElement('a')
    a.href = url
    a.download = (scene.name || '场景') + '_拓扑图.png'
    a.click()
  } finally { shooting.value = false }
}

let ro = null
onMounted(() => {
  ro = new ResizeObserver(resize); ro.observe(wrap.value)
  resize(); nextTick(fit)
})
onBeforeUnmount(() => { if (ro) ro.disconnect() })
watch(() => [scene.modules, scene.links, scene.result, scene.sel, scene.nudge, theme.mode, uiFont.stack], () => draw(), { deep: true })
// ★ 内容尺寸变了就重新适应（换模板、加删模块都会变），除非用户已手动调过镜头。
//   只在挂载时 fit 一次是不够的：那一刻场景往往还是空的（模板是异步取的），
//   fit 到一张空画布上，之后内容进来就再也不居中了。
watch(() => lay.value.w + '×' + lay.value.h + '/' + lay.value.nodes.length, () => {
  if (!touched.value) nextTick(fit); else draw()
})
</script>

<template>
  <div class="topo" ref="wrap">
    <canvas ref="cv" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @wheel="onWheel"></canvas>
    <div class="tbar">
      <button class="tb" title="适应窗口" @click="touched = false; fit()"><Icon name="move" :size="13" /></button>
      <button class="tb" title="清除手动微调" @click="resetNudge"><Icon name="undo-2" :size="13" /></button>
      <button class="tb" title="导出 PNG（4×）" :disabled="shooting" @click="shot"><Icon name="image" :size="13" /></button>
    </div>
    <div class="lgd">
      <span><i class="ln sat"></i>卫星段</span>
      <span><i class="ln pow"></i>功率预算</span>
      <span><i class="ln con"></i>约束校验</span>
      <span><i class="ln ctr"></i>契约</span>
    </div>
    <div v-if="!scene.modules.length" class="ph">场景里还没有模块。</div>
  </div>
</template>

<style scoped>
.topo { position: relative; width: 100%; height: 100%; background: var(--bg); overflow: hidden; }
canvas { display: block; cursor: grab; touch-action: none; }
canvas:active { cursor: grabbing; }
.tbar { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; }
.tb { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; border-radius: var(--r-1, 2px); }
.tb:hover { background: var(--surface); }
.tb:disabled { opacity: .5; cursor: default; }
.lgd { position: absolute; left: 10px; bottom: 10px; display: flex; gap: 12px; align-items: center; font-size: var(--fs-2, 11px); color: var(--text-muted); background: color-mix(in srgb, var(--bg) 88%, transparent); padding: 4px 8px; border: 1px solid var(--border); }
.lgd span { display: inline-flex; align-items: center; gap: 5px; }
.ln { width: 16px; height: 0; border-top-width: 2px; border-top-style: solid; }
.ln.sat { border-color: var(--accent-ui); border-top-width: 2.6px; }
.ln.pow { border-color: var(--text); }
.ln.con { border-color: var(--text); border-top-width: 1.6px; }
.ln.ctr { border-color: var(--warn); border-top-style: dashed; }
.ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); pointer-events: none; }
</style>
