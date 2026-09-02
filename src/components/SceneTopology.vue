<script setup>
// 应用场景仿真 · 拓扑图视图（中央视图第三档，与 3D 球 / 2D 地图并列切换）。
//
// 与地理视图是同一份 sceneStore 的两个投影：这里不存任何第二份数据，
// 位置由 topoLayout 现算、走线由 topoRoute 现算，选中态与地图共用 scene.sel。
//
// ★ 二期起这块画布是【主编辑面】：从库里拖模块进来放置（不需要坐标）、悬停出四向连接柄、
//   从柄拖到另一节点即连线、框选、右键菜单、键盘增删改。一期它只是只读投影 ——
//   而人是先想拓扑、最后才关心站址，先要坐标才有模块的顺序正好反了。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import {
  scene, effective, modById, mediaOf, tierOf, catLabel, linkReadings,
  addModule, addSatModule, removeModule, removeLink, addLink, addFlow, portsCompatible,
  pushUndo, undo, redo, duplicateModule, lintIndex, autoCompute
} from '../viz/scene/sceneStore.js'
import { layout, fallbackMeasure } from '../viz/scene/topoLayout.js'
import { routeTopology, drawTopology, hitTest, palette, handlePoints } from '../viz/scene/topoRender.js'
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
const hover = ref(null)
const marquee = ref(null)
const menu = ref(null)
const toast = ref('')
const shooting = ref(false)

// ── 文字测量：布局与边标都要它。用一张离屏 canvas，字体与屏上同一套 ──
let mctx = null
function measure(text, px) {
  if (typeof document === 'undefined') return fallbackMeasure(text, px)
  if (!mctx) mctx = document.createElement('canvas').getContext('2d')
  const fam = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-stack').trim() || 'system-ui, sans-serif'
  mctx.font = `${px}px ${fam}`
  return mctx.measureText(String(text == null ? '' : text)).width
}

// resolve 出「有效模块」的 Map —— 与计算侧同口径（库条目 + 逐条覆盖）
const mods = computed(() => {
  const m = new Map()
  for (const inst of scene.modules) { const e = effective(inst); if (e) m.set(inst.id, e) }
  return m
})
const model = computed(() => ({
  links: scene.links, flows: scene.flows, result: scene.result, sel: scene.sel, hover: hover.value,
  mediaOf, tierOf, catLabel, readings: linkReadings, lint: lintIndex.value
}))
const lay = computed(() => layout(
  { mods: mods.value, links: scene.links, flows: scene.result ? scene.result.flows : [] },
  { nudge: scene.nudge, fontPx: panelFs(), measure, sub: (m) => subOf(m) }
))
const subOf = (m) => {
  if (!m) return ''
  if (m.cat === 'A') { const s = m.sat || {}; return s.orbitClass === 'GSO' ? `${s.orbitLongitude}°E · ${s.frequencyBand || ''}` : `${s.orbitAltitude || '—'} km · ${s.frequencyBand || ''}` }
  if (m.rf && m.rf.antennaDiameter > 0) return `Φ${m.rf.antennaDiameter} m · ${m.rf.opPowerW || '—'} W`
  return catLabel(m.cat)
}
const routed = computed(() => routeTopology(lay.value, model.value, { fontPx: panelFs(), measure }))

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
  drawTopology(ctx, lay.value, model.value, routed.value, view.value, w, h, panelFs())
  // 框选矩形与「正在连的那条线」画在最上层（不进 drawTopology —— 它是出图也要走的那支笔）
  const P = palette()
  if (marquee.value) {
    const m = marquee.value
    ctx.save(); ctx.strokeStyle = P.accent; ctx.setLineDash([4, 3]); ctx.lineWidth = 1
    ctx.strokeRect(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1), Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0))
    ctx.restore()
  }
  if (drag.value && drag.value.link) {
    const d = drag.value
    ctx.save(); ctx.strokeStyle = P.accent; ctx.lineWidth = 1.6; ctx.setLineDash([5, 4])
    ctx.beginPath(); ctx.moveTo(d.sx, d.sy); ctx.lineTo(d.cx, d.cy); ctx.stroke()
    ctx.restore()
  }
}
function fit() {
  const L = lay.value
  if (!L.nodes.length) { view.value = { ox: 40, oy: 20, k: 1 }; return }
  const { w, h } = size.value
  const k = Math.min((w - 40) / Math.max(1, L.w), (h - 40) / Math.max(1, L.h), 1.6)
  view.value = { ox: (w - L.w * k) / 2, oy: (h - L.h * k) / 2, k }
  draw()
}
const toScene = (sx, sy) => ({ x: (sx - view.value.ox) / view.value.k, y: (sy - view.value.oy) / view.value.k })

// ═══════════════════════════════════════════════════════════════════════════
// 交互
// ═══════════════════════════════════════════════════════════════════════════
function local(e) {
  const r = cv.value.getBoundingClientRect()
  return { sx: e.clientX - r.left, sy: e.clientY - r.top }
}
function onDown(e) {
  menu.value = null
  const { sx, sy } = local(e)
  if (e.button === 2) return                       // 右键交给 contextmenu
  if (e.button !== 0) return
  const hit = hitTest(lay.value, model.value, routed.value, view.value, sx, sy)
  cv.value.setPointerCapture && cv.value.setPointerCapture(e.pointerId)
  if (hit && hit.type === 'handle') {
    // 从连接柄拖出去 = 连线（draw.io / X6 的那套：不必先选端口）
    const p = handlePoints(hit.node)[['t', 'r', 'b', 'l'].indexOf(hit.side)]
    const s = { x: p[0] * view.value.k + view.value.ox, y: p[1] * view.value.k + view.value.oy }
    drag.value = { link: true, from: hit.id, sx: s.x, sy: s.y, cx: sx, cy: sy }
    draw(); return
  }
  if (hit && hit.type === 'module') {
    scene.sel = { type: 'module', id: hit.id }
    pushUndo('拖动节点')
    drag.value = { id: hit.id, sx, sy, base: Object.assign({ dx: 0, dy: 0 }, scene.nudge[hit.id] || {}) }
    return
  }
  if (hit && (hit.type === 'link' || hit.type === 'site')) { scene.sel = { type: hit.type === 'link' ? 'link' : 'module', id: hit.id }; return }
  if (e.shiftKey) { const p = toScene(sx, sy); marquee.value = { x0: sx, y0: sy, x1: sx, y1: sy, s0: p }; return }
  scene.sel = null
  drag.value = { pan: true, sx, sy, ox: view.value.ox, oy: view.value.oy }
  touched.value = true
}
function onMove(e) {
  const { sx, sy } = local(e)
  const d = drag.value
  if (!d) {
    const hit = hitTest(lay.value, model.value, routed.value, view.value, sx, sy)
    const h = hit && (hit.type === 'module' || hit.type === 'handle') ? { type: 'module', id: hit.id } : null
    const changed = JSON.stringify(h) !== JSON.stringify(hover.value)
    hover.value = h
    if (changed) draw()
    return
  }
  if (d.pan) { view.value = { ...view.value, ox: d.ox + (sx - d.sx), oy: d.oy + (sy - d.sy) }; draw(); return }
  if (d.link) { d.cx = sx; d.cy = sy; draw(); return }
  if (marquee.value) { marquee.value.x1 = sx; marquee.value.y1 = sy; draw(); return }
  // 拖节点：吸附 8 px 网格（Visio 的手感；也让 nudge 的值不会攒出一堆小数）
  const gx = Math.round((d.base.dx + (sx - d.sx) / view.value.k) / 8) * 8
  const gy = Math.round((d.base.dy + (sy - d.sy) / view.value.k) / 8) * 8
  scene.nudge[d.id] = { dx: gx, dy: gy }
  draw()
}
function onUp(e) {
  const { sx, sy } = local(e)
  const d = drag.value
  try { cv.value.releasePointerCapture && cv.value.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  if (d && d.link) {
    const hit = hitTest(lay.value, model.value, routed.value, view.value, sx, sy)
    if (hit && (hit.type === 'module' || hit.type === 'handle') && hit.id !== d.from) tryConnect(d.from, hit.id, sx, sy, e.altKey)
    drag.value = null; draw(); return
  }
  if (marquee.value) {
    const a = toScene(Math.min(marquee.value.x0, marquee.value.x1), Math.min(marquee.value.y0, marquee.value.y1))
    const b = toScene(Math.max(marquee.value.x0, marquee.value.x1), Math.max(marquee.value.y0, marquee.value.y1))
    sel2.value = lay.value.nodes.filter((n) => n.x > a.x && n.x < b.x && n.y > a.y && n.y < b.y).map((n) => n.id)
    marquee.value = null; draw(); return
  }
  drag.value = null
}
const sel2 = ref([])       // 框选出来的多选集合（Delete / 方向键作用于它）

/**
 * 连线：把源端全部非供电端口 × 目标端全部端口过一遍相容性。
 *   唯一解 → 直接连；多解 → 在光标处弹一个小菜单；零解 → 一句原因。
 * ★ 一期是「点链图标 → 全屏蒙层选出口 → 点目标 → 再选入口」四步，且没有一步是可发现的。
 */
function tryConnect(aId, bId, sx, sy, alt) {
  const ea = effective(modById.value.get(aId)), eb = effective(modById.value.get(bId))
  if (!ea || !eb) return
  if (alt) { pushUndo('新建业务流'); const f = addFlow(aId, bId); scene.sel = { type: 'flow', id: f.id }; return }
  const cands = []
  for (const pa of (ea.ports || [])) {
    if (pa.role === 'power') continue
    for (const pb of (eb.ports || [])) {
      const c = portsCompatible(pa, pb)
      if (c.ok) cands.push({ pa, pb })
    }
  }
  if (!cands.length) {
    // 零解：报出第一条的原因（端口系统已经算过，直接转述）
    const pa = (ea.ports || []).find((p) => p.role !== 'power'), pb = (eb.ports || [])[0]
    const why = pa && pb ? portsCompatible(pa, pb).why : '两端没有可连的端口'
    say(`${ea.name} → ${eb.name}：${why}`)
    return
  }
  if (cands.length === 1) { doLink(aId, cands[0].pa.key, bId, cands[0].pb.key); return }
  menu.value = { x: sx, y: sy, kind: 'ports', a: aId, b: bId, items: cands }
}
function doLink(aId, aPort, bId, bPort) {
  pushUndo('连线')
  const r = addLink(aId, aPort, bId, bPort)
  if (!r.ok) say(r.reason)
  else { scene.sel = { type: 'link', id: r.link.id }; autoCompute() }
  menu.value = null
}
function say(t) { toast.value = t; setTimeout(() => { if (toast.value === t) toast.value = '' }, 2600) }

function onWheel(e) {
  e.preventDefault()
  const { sx, sy } = local(e)
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
  const k = Math.max(0.25, Math.min(4, view.value.k * f))
  const s = k / view.value.k
  view.value = { k, ox: sx - (sx - view.value.ox) * s, oy: sy - (sy - view.value.oy) * s }
  touched.value = true
  draw()
}
function onContext(e) {
  e.preventDefault()
  const { sx, sy } = local(e)
  const hit = hitTest(lay.value, model.value, routed.value, view.value, sx, sy)
  if (hit && hit.type === 'module') scene.sel = { type: 'module', id: hit.id }
  else if (hit && hit.type === 'link') scene.sel = { type: 'link', id: hit.id }
  menu.value = { x: sx, y: sy, kind: 'ctx', hit }
}
function resetNudge() { pushUndo('自动排版'); scene.nudge = {}; touched.value = false; nextTick(fit) }

// ── 从库里拖进来放置（HTML5 DnD；不需要坐标）──
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
function onDrop(e) {
  e.preventDefault()
  const raw = e.dataTransfer.getData('text/scene-lib')
  if (!raw) return
  pushUndo('放置模块')
  const m = raw.startsWith('sat:') ? addSatModule(raw.slice(4)) : addModule(raw, {})
  if (!m) return
  // 落在光标处：拖进来的模块没有坐标，位置先由 nudge 记着（拓扑图上它就在你放的地方）
  const { sx, sy } = local(e)
  const p = toScene(sx, sy)
  nextTick(() => {
    const n = lay.value.nodes.find((x) => x.id === m.id)
    if (n) scene.nudge[m.id] = { dx: Math.round((p.x - n.x) / 8) * 8, dy: Math.round((p.y - n.y) / 8) * 8 }
    scene.sel = { type: 'module', id: m.id }
    draw()
  })
}

// ── 键盘 ──
function onKey(e) {
  if (!wrap.value || !wrap.value.contains(document.activeElement) && document.activeElement !== document.body) return
  const tag = (document.activeElement && document.activeElement.tagName) || ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  const ids = sel2.value.length ? sel2.value : (scene.sel && scene.sel.type === 'module' ? [scene.sel.id] : [])
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); draw(); return }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); draw(); return }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
    e.preventDefault()
    if (ids.length) { pushUndo('复制'); const m = duplicateModule(ids[0]); if (m) scene.sel = { type: 'module', id: m.id } }
    return
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (scene.sel && scene.sel.type === 'link') { pushUndo('删除连线'); removeLink(scene.sel.id); return }
    if (ids.length) { pushUndo('删除模块'); ids.forEach(removeModule); sel2.value = []; return }
  }
  const step = e.shiftKey ? 24 : 8
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
  if (d && ids.length) {
    e.preventDefault()
    pushUndo('微移')
    for (const id of ids) {
      const n = Object.assign({ dx: 0, dy: 0 }, scene.nudge[id] || {})
      scene.nudge[id] = { dx: n.dx + d[0], dy: n.dy + d[1] }
    }
    draw()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 出图：PNG（4×）与 SVG，两条路走同一支画笔
// ═══════════════════════════════════════════════════════════════════════════
const frameOf = () => ({
  title: scene.name || '场景',
  meta: `${new Date().toLocaleDateString('zh-CN')}　${scene.modules.length} 模块 · ${scene.links.length} 边 · ${scene.flows.length} 流`
})
const FRAME_H = 44   // 图框那一条占的高度（只在导出时留）

function download(blobOrUrl, name) {
  const a = document.createElement('a')
  a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl)
  a.download = name
  a.click()
  if (typeof blobOrUrl !== 'string') setTimeout(() => URL.revokeObjectURL(a.href), 4000)
}
async function shotPng() {
  shooting.value = true
  try {
    const L = lay.value, S = 4
    const c = document.createElement('canvas')
    c.width = Math.round(L.w * S); c.height = Math.round((L.h + FRAME_H) * S)
    const ctx = c.getContext('2d')
    ctx.setTransform(S, 0, 0, S, 0, 0)
    drawTopology(ctx, L, model.value, routed.value, { ox: 0, oy: 0, k: 1 }, L.w, L.h + FRAME_H, panelFs(), { frame: frameOf() })
    download(c.toDataURL('image/png'), (scene.name || '场景') + '_拓扑图.png')
  } finally { shooting.value = false }
}
async function shotSvg() {
  shooting.value = true
  try {
    const { Context: SvgContext } = await import('svgcanvas')
    const L = lay.value
    const sctx = new SvgContext(Math.round(L.w), Math.round(L.h + FRAME_H))
    // ★ 字体写死进 SVG：离开本页面就没有祖先可继承 --ui-font-stack 了（出图字体那条既定坑）
    const fam = getComputedStyle(document.documentElement).getPropertyValue('--ui-font-stack').trim() || 'system-ui, sans-serif'
    drawTopology(sctx, L, model.value, routed.value, { ox: 0, oy: 0, k: 1 }, L.w, L.h + FRAME_H, panelFs(), { frame: frameOf(), fontStack: fam })
    const svg = sctx.getSerializedSvg(true)
    download(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), (scene.name || '场景') + '_拓扑图.svg')
  } catch (e) { say('SVG 导出失败：' + ((e && e.message) || e)) } finally { shooting.value = false }
}
async function copyPng() {
  try {
    const L = lay.value, S = 2
    const c = document.createElement('canvas')
    c.width = Math.round(L.w * S); c.height = Math.round((L.h + FRAME_H) * S)
    const ctx = c.getContext('2d')
    ctx.setTransform(S, 0, 0, S, 0, 0)
    drawTopology(ctx, L, model.value, routed.value, { ox: 0, oy: 0, k: 1 }, L.w, L.h + FRAME_H, panelFs(), { frame: frameOf() })
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'))
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
    say('已复制到剪贴板')
  } catch (e) { say('复制失败：' + ((e && e.message) || e)) }
}

let ro = null
onMounted(() => {
  ro = new ResizeObserver(resize); ro.observe(wrap.value)
  resize(); nextTick(fit)
  window.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => { if (ro) ro.disconnect(); window.removeEventListener('keydown', onKey) })
watch(() => [scene.modules, scene.links, scene.result, scene.sel, scene.nudge, theme.mode, uiFont.stack], () => draw(), { deep: true })
// ★ 内容尺寸变了就重新适应（换模板、加删模块都会变），除非用户已手动调过镜头。
//   只在挂载时 fit 一次是不够的：那一刻场景往往还是空的（模板是异步取的），
//   fit 到一张空画布上，之后内容进来就再也不居中了。
watch(() => lay.value.w + '×' + lay.value.h + '/' + lay.value.nodes.length, () => {
  if (!touched.value) nextTick(fit); else draw()
})

const menuItems = computed(() => {
  const m = menu.value
  if (!m || m.kind !== 'ctx') return []
  const h = m.hit
  const out = []
  if (h && h.type === 'module') {
    out.push({ k: 'dup', t: '复制' }, { k: 'flow', t: '新建业务流到…' }, { k: 'map', t: '落点到地图' }, { k: 'del', t: '删除' })
  } else if (h && h.type === 'link') {
    const lk = scene.links.find((l) => l.id === h.id)
    out.push({ k: 'backup', t: lk && lk.role === 'backup' ? '设为主用链路' : '设为备份链路' }, { k: 'del', t: '删除' })
  } else {
    out.push({ k: 'fit', t: '适应窗口' }, { k: 'auto', t: '自动排版' })
  }
  return out
})
function onMenu(k) {
  const h = menu.value && menu.value.hit
  menu.value = null
  if (k === 'fit') { touched.value = false; fit(); return }
  if (k === 'auto') { resetNudge(); return }
  if (!h) return
  if (k === 'del') { pushUndo('删除'); h.type === 'link' ? removeLink(h.id) : removeModule(h.id); return }
  if (k === 'dup') { pushUndo('复制'); const m = duplicateModule(h.id); if (m) scene.sel = { type: 'module', id: m.id }; return }
  if (k === 'backup') { pushUndo('改链路角色'); const lk = scene.links.find((l) => l.id === h.id); if (lk) { lk.role = lk.role === 'backup' ? 'main' : 'backup'; scene.dirty = true } return }
  if (k === 'flow') { flowFrom.value = h.id; say('再点一个模块作为业务流的另一端'); return }
  if (k === 'map') { scene.view = 'map'; scene.placing = null; scene.sel = { type: 'module', id: h.id }; scene.editPos = true; return }
}
const flowFrom = ref('')
watch(() => scene.sel, (s) => {
  if (flowFrom.value && s && s.type === 'module' && s.id !== flowFrom.value) {
    pushUndo('新建业务流')
    const f = addFlow(flowFrom.value, s.id)
    flowFrom.value = ''
    scene.sel = { type: 'flow', id: f.id }
  }
})
</script>

<template>
  <div class="topo" ref="wrap" tabindex="0" @dragover="onDragOver" @drop="onDrop">
    <canvas ref="cv" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp"
            @wheel="onWheel" @contextmenu="onContext"></canvas>
    <div class="tbar">
      <button class="tb" title="适应窗口" @click="touched = false; fit()"><Icon name="move" :size="13" /></button>
      <button class="tb" title="自动排版（清除手动微调）" @click="resetNudge"><Icon name="undo-2" :size="13" /></button>
      <button class="tb" title="导出 PNG（4×）" :disabled="shooting" @click="shotPng"><Icon name="image" :size="13" /></button>
      <button class="tb" title="导出 SVG（矢量）" :disabled="shooting" @click="shotSvg"><Icon name="file-down" :size="13" /></button>
      <button class="tb" title="复制到剪贴板" @click="copyPng"><Icon name="copy" :size="13" /></button>
    </div>
    <div class="lgd">
      <span><i class="ln sat"></i>卫星段</span>
      <span><i class="ln pow"></i>功率预算</span>
      <span><i class="ln con"></i>约束校验</span>
      <span><i class="ln ctr"></i>契约</span>
      <span v-if="routed.ms">{{ routed.ms.toFixed(1) }} ms</span>
    </div>
    <div v-if="toast" class="tst">{{ toast }}</div>
    <div v-if="!scene.modules.length" class="ph">场景里还没有模块。</div>

    <!-- 端口多解：光标处的小菜单（一期是全屏蒙层） -->
    <div v-if="menu && menu.kind === 'ports'" class="cm" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <div v-for="(c, i) in menu.items" :key="i" class="cmi" @click="doLink(menu.a, c.pa.key, menu.b, c.pb.key)">
        {{ c.pa.zh || c.pa.key }} → {{ c.pb.zh || c.pb.key }}
      </div>
    </div>
    <!-- 右键菜单 -->
    <div v-if="menu && menu.kind === 'ctx' && menuItems.length" class="cm" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <div v-for="it in menuItems" :key="it.k" class="cmi" @click="onMenu(it.k)">{{ it.t }}</div>
    </div>
    <div v-if="menu" class="cmask" @click="menu = null" @contextmenu.prevent="menu = null"></div>
  </div>
</template>

<style scoped>
.topo { position: relative; width: 100%; height: 100%; background: var(--bg); overflow: hidden; outline: none; }
canvas { display: block; cursor: grab; touch-action: none; }
canvas:active { cursor: grabbing; }
.tbar { position: absolute; top: 10px; right: 10px; display: flex; gap: 4px; z-index: 2; }
.tb { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; border-radius: var(--r-1, 2px); }
.tb:hover { background: var(--surface); }
.tb:disabled { opacity: .5; cursor: default; }
.lgd { position: absolute; left: 10px; bottom: 10px; display: flex; gap: 12px; align-items: center; font-size: var(--fs-2, 11px); color: var(--text-muted); background: color-mix(in srgb, var(--bg) 88%, transparent); padding: 4px 8px; border: 1px solid var(--border); z-index: 2; }
.lgd span { display: inline-flex; align-items: center; gap: 5px; }
.ln { width: 16px; height: 0; border-top-width: 2px; border-top-style: solid; }
.ln.sat { border-color: var(--accent-ui); border-top-width: 2.6px; }
.ln.pow { border-color: var(--text); }
.ln.con { border-color: var(--text); border-top-width: 1.6px; }
.ln.ctr { border-color: var(--warn); border-top-style: dashed; }
.ph { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); pointer-events: none; }
.tst { position: absolute; left: 50%; top: 14px; transform: translateX(-50%); background: var(--surface); border: 1px solid var(--border-strong); padding: 4px 12px; font-size: var(--fs-3); color: var(--text); z-index: 4; box-shadow: var(--shadow-2, 0 2px 8px rgba(0,0,0,.15)); }
.cm { position: absolute; z-index: 6; background: var(--bg); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3, 0 8px 24px rgba(0,0,0,.2)); min-width: 150px; font-size: var(--fs-3); }
.cmi { padding: 4px 12px; cursor: pointer; white-space: nowrap; }
.cmi:hover { background: var(--accent-ui-wash); }
.cmask { position: fixed; inset: 0; z-index: 5; }
</style>
