<script setup>
// 雨衰函数交互式坐标系（canvas 2D）。纵轴固定 = 雨衰(dB)；横轴可选 可用度 / 频率 / 降雨率，
// 取值范围默认合理且可改；曲线经主进程 core.sweepRainAttenuation 计算；当前算例取值处标记 +
// 悬停读数；「导出 PNG」复用通用 file:save 通道（白底、含标题/坐标，适合放进用户报告）。
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps({
  params: { type: Object, default: null },   // buildRainCase 输出（当前算例）
  result: { type: Object, default: null },   // 当前算例结果（取 rainAtten 作标记）
  station: { type: String, default: '' }
})

const api = (typeof window !== 'undefined' && window.api) ? window.api.rainAttenuation : null
const exportFile = (typeof window !== 'undefined' && window.api) ? window.api.exportFile : null

// 横轴定义（dmin/dmax 为默认取值范围，可在界面改）
const AXES = {
  availability: { label: '可用度', unit: '%', dmin: 99, dmax: 99.99, cur: (p) => p.availability },
  frequency: { label: '频率', unit: 'GHz', dmin: 1, dmax: 50, cur: (p) => p.freq },
  rainRate: { label: '降雨率 R0.01%', unit: 'mm/h', dmin: 0, dmax: 150, cur: (p) => p.rainRate },
  elevation: { label: '仰角', unit: '°', dmin: 5, dmax: 90, cur: (p) => p.elevation }
}
const axis = ref('availability')
const range = reactive({ min: AXES.availability.dmin, max: AXES.availability.dmax, steps: 120 })
watch(axis, (a) => { const A = AXES[a]; range.min = A.dmin; range.max = A.dmax })

const points = ref([])       // [{x, y}]
const loading = ref(false)
const hover = ref(null)      // {x, y, px, py}
const wrap = ref(null)
const canvas = ref(null)
let dpr = 1, cssW = 440, cssH = 240

const curAxis = computed(() => AXES[axis.value])
const curX = computed(() => (props.params && curAxis.value) ? curAxis.value.cur(props.params) : null)
const curY = computed(() => (props.result && Number.isFinite(+props.result.rainAtten)) ? +props.result.rainAtten : null)

let _sweepT = null
function scheduleSweep() { clearTimeout(_sweepT); _sweepT = setTimeout(runSweep, 180) }
async function runSweep() {
  if (!api || !props.params) { points.value = []; draw(); return }
  const mn = parseFloat(range.min), mx = parseFloat(range.max)
  if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn) { points.value = []; draw(); return }
  loading.value = true
  try {
    const r = await api.sweep(props.params, axis.value, { min: mn, max: mx, steps: Math.max(2, Math.min(400, parseInt(range.steps, 10) || 120)) })
    points.value = (r && Array.isArray(r.points)) ? r.points : []
  } catch (e) { points.value = [] }
  finally { loading.value = false; draw() }
}
watch(() => props.params, scheduleSweep, { deep: true })
watch([axis, () => range.min, () => range.max, () => range.steps], scheduleSweep)

// —— 绘制 ——
function palette(forExport) {
  if (forExport) return { bg: '#ffffff', axis: '#333', grid: '#e6e6e6', text: '#222', sub: '#666', curve: '#2563eb', marker: '#c2410c' }
  const cs = getComputedStyle(canvas.value || document.documentElement)
  const v = (n, f) => (cs.getPropertyValue(n) || '').trim() || f
  return {
    bg: 'transparent', axis: v('--text-muted', '#555'), grid: v('--border', '#ddd'),
    text: v('--text', '#222'), sub: v('--text-faint', '#888'),
    curve: v('--accent', '#2563eb'), marker: '#c2410c'
  }
}
function niceYMax(m) {
  if (!(m > 0)) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(m)))
  const n = m / pow
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * pow
}
function drawTo(ctx, W, H, forExport) {
  const pal = palette(forExport)
  ctx.clearRect(0, 0, W, H)
  if (forExport) { ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H) }
  // 导出时字号/线宽/边距整体放大，配合更高 DPI → 报告里清晰
  const FS = forExport ? 15 : 11, FSM = forExport ? 15 : 11, FST = forExport ? 19 : 14
  const LWg = forExport ? 1.2 : 1, LWa = forExport ? 1.8 : 1.2, LWc = forExport ? 3 : 2
  const font = (px, w) => (w ? w + ' ' : '') + px + 'px "Microsoft YaHei", system-ui, sans-serif'
  const mL = forExport ? 68 : 52, mR = forExport ? 22 : 14, mT = forExport ? 46 : 12, mB = forExport ? 54 : 40
  const pw = W - mL - mR, ph = H - mT - mB
  const A = curAxis.value
  const xmn = parseFloat(range.min), xmx = parseFloat(range.max)
  const pts = points.value.filter((p) => p && p.y != null && Number.isFinite(p.y))
  let ymax = niceYMax(Math.max(curY.value || 0, ...pts.map((p) => p.y), 0.001))
  const X = (x) => mL + ((x - xmn) / (xmx - xmn || 1)) * pw
  const Y = (y) => mT + ph - (y / (ymax || 1)) * ph

  if (forExport) {
    ctx.fillStyle = pal.text; ctx.font = font(FST, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    ctx.fillText('雨衰 vs ' + A.label + (props.station ? ('  ·  ' + props.station) : ''), mL, 30)
  }

  // 网格 + 刻度
  ctx.strokeStyle = pal.grid; ctx.fillStyle = pal.sub; ctx.lineWidth = LWg
  ctx.font = font(FS)
  const yTicks = 5
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
  for (let i = 0; i <= yTicks; i++) {
    const yv = ymax * i / yTicks, yy = Y(yv)
    ctx.beginPath(); ctx.moveTo(mL, yy); ctx.lineTo(W - mR, yy); ctx.stroke()
    ctx.fillText(yv.toFixed(yv < 10 ? 1 : 0), mL - (forExport ? 9 : 6), yy)
  }
  const xTicks = 5
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  for (let i = 0; i <= xTicks; i++) {
    const xv = xmn + (xmx - xmn) * i / xTicks, xx = X(xv)
    ctx.strokeStyle = pal.grid; ctx.beginPath(); ctx.moveTo(xx, mT); ctx.lineTo(xx, mT + ph); ctx.stroke()
    ctx.fillStyle = pal.sub
    const dec = (xmx - xmn) < 5 ? 2 : (xmx - xmn) < 50 ? 1 : 0
    ctx.fillText(xv.toFixed(dec), xx, mT + ph + (forExport ? 8 : 5))
  }

  // 轴线
  ctx.strokeStyle = pal.axis; ctx.lineWidth = LWa
  ctx.beginPath(); ctx.moveTo(mL, mT); ctx.lineTo(mL, mT + ph); ctx.lineTo(W - mR, mT + ph); ctx.stroke()

  // 轴标题
  ctx.fillStyle = pal.text; ctx.font = font(FS)
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
  ctx.fillText(A.label + ' (' + A.unit + ')', mL + pw / 2, H - (forExport ? 8 : 4))
  ctx.save(); ctx.translate(forExport ? 22 : 12, mT + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('雨衰 (dB)', 0, 0); ctx.restore()

  // 曲线
  if (pts.length > 1) {
    ctx.strokeStyle = pal.curve; ctx.lineWidth = LWc; ctx.lineJoin = 'round'; ctx.beginPath()
    let started = false
    for (const p of points.value) {
      if (p.y == null || !Number.isFinite(p.y)) { started = false; continue }
      const xx = X(p.x), yy = Y(p.y)
      if (!started) { ctx.moveTo(xx, yy); started = true } else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
  }

  // 当前算例标记
  if (curX.value != null && curY.value != null && curX.value >= xmn && curX.value <= xmx) {
    const mx = X(curX.value), my = Y(curY.value)
    ctx.strokeStyle = pal.marker; ctx.lineWidth = forExport ? 1.4 : 1; ctx.setLineDash(forExport ? [5, 4] : [3, 3])
    ctx.beginPath(); ctx.moveTo(mx, mT + ph); ctx.lineTo(mx, my); ctx.lineTo(mL, my); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = pal.marker; ctx.beginPath(); ctx.arc(mx, my, forExport ? 5 : 3.5, 0, Math.PI * 2); ctx.fill()
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.font = font(FSM, '600')
    ctx.fillText(curY.value.toFixed(2) + ' dB', Math.min(mx + (forExport ? 9 : 6), W - mR - (forExport ? 66 : 46)), my - (forExport ? 7 : 5))
  }

  // 悬停十字
  if (!forExport && hover.value) {
    ctx.strokeStyle = pal.sub; ctx.lineWidth = 1; ctx.setLineDash([2, 3])
    ctx.beginPath(); ctx.moveTo(hover.value.px, mT); ctx.lineTo(hover.value.px, mT + ph); ctx.stroke(); ctx.setLineDash([])
    ctx.fillStyle = pal.curve; ctx.beginPath(); ctx.arc(hover.value.px, hover.value.py, 3, 0, Math.PI * 2); ctx.fill()
  }
}
function draw() {
  const cv = canvas.value; if (!cv) return
  const ctx = cv.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawTo(ctx, cssW, cssH, false)
}
function resize() {
  const cv = canvas.value, w = wrap.value; if (!cv || !w) return
  dpr = window.devicePixelRatio || 1
  cssW = Math.max(280, w.clientWidth); cssH = 240
  cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr)
  cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px'
  draw()
}

// 悬停读数：取最近采样点
function onMove(e) {
  const cv = canvas.value; if (!cv || !points.value.length) return
  const rect = cv.getBoundingClientRect()
  const px = e.clientX - rect.left
  const mL = 52, mR = 14, pw = cssW - mL - mR
  const xmn = parseFloat(range.min), xmx = parseFloat(range.max)
  const xv = xmn + Math.max(0, Math.min(1, (px - mL) / (pw || 1))) * (xmx - xmn)
  let best = null, bd = Infinity
  for (const p of points.value) { if (p.y == null) continue; const d = Math.abs(p.x - xv); if (d < bd) { bd = d; best = p } }
  if (!best) { hover.value = null; return }
  const ph = cssH - 12 - 40
  let ymax = niceYMax(Math.max(curY.value || 0, ...points.value.filter((p) => p.y != null).map((p) => p.y), 0.001))
  hover.value = { x: best.x, y: best.y, px: mL + ((best.x - xmn) / (xmx - xmn || 1)) * pw, py: 12 + ph - (best.y / (ymax || 1)) * ph }
  draw()
}
function onLeave() { hover.value = null; draw() }

// —— 导出 PNG ——
async function exportPng() {
  if (!exportFile) return
  // 高 DPI 导出（逻辑 880×470 × 3 → 2640×1410 物理像素），报告里放大也清晰
  const scale = 3
  const W = 880, H = 470
  const cv = document.createElement('canvas')
  cv.width = W * scale; cv.height = H * scale
  const ctx = cv.getContext('2d'); ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
  drawTo(ctx, W, H, true)
  const blob = await new Promise((res, rej) => cv.toBlob((b) => b ? res(b) : rej(new Error('toBlob 失败')), 'image/png'))
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const nm = '雨衰曲线_' + (AXES[axis.value].label) + (props.station ? ('_' + props.station) : '') + '.png'
  try { await exportFile({ defaultName: nm, data: bytes, filters: [{ name: 'PNG 图片', extensions: ['png'] }] }) } catch (e) { /* ignore */ }
}

let _ro = null
onMounted(() => {
  nextTick(() => { resize(); runSweep() })
  if (window.ResizeObserver && wrap.value) { _ro = new ResizeObserver(() => resize()); _ro.observe(wrap.value) }
  else window.addEventListener('resize', resize)
})
onBeforeUnmount(() => { if (_ro) _ro.disconnect(); else window.removeEventListener('resize', resize); clearTimeout(_sweepT) })

const hoverText = computed(() => hover.value ? (`${curAxis.value.label} ${hover.value.x.toFixed((parseFloat(range.max) - parseFloat(range.min)) < 5 ? 2 : 1)} ${curAxis.value.unit} → 雨衰 ${hover.value.y.toFixed(2)} dB`) : '')
</script>

<template>
  <div class="rp">
    <div class="rp-bar">
      <span class="rp-lb">雨衰 vs</span>
      <select v-model="axis" class="rp-sel">
        <option value="availability">可用度</option>
        <option value="frequency">频率</option>
        <option value="rainRate">降雨率</option>
        <option value="elevation">仰角</option>
      </select>
      <span class="rp-rng">
        <input v-model="range.min" class="rp-inp" type="number" title="下限" />
        <span class="rp-dash">–</span>
        <input v-model="range.max" class="rp-inp" type="number" title="上限" />
        <span class="rp-unit">{{ curAxis.unit }}</span>
      </span>
      <span class="rp-flex"></span>
      <button class="rp-png" :disabled="!points.length" title="导出曲线为 PNG（用于报告）" @click="exportPng">导出 PNG</button>
    </div>
    <div ref="wrap" class="rp-canvas-wrap">
      <canvas ref="canvas" @mousemove="onMove" @mouseleave="onLeave"></canvas>
      <div v-if="loading" class="rp-loading">计算中…</div>
    </div>
    <div class="rp-foot">
      <span v-if="hoverText" class="rp-hover">{{ hoverText }}</span>
      <span v-else class="rp-hint">橙色虚线 = 当前算例取值；悬停查看曲线上任意点</span>
    </div>
  </div>
</template>

<style scoped>
.rp { border: 1px solid var(--border); border-radius: var(--r-box, 3px); overflow: hidden; background: var(--surface); }
.rp-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.rp-lb { font-size: 12px; color: var(--text-muted); }
.rp-sel { font: inherit; font-size: 12px; padding: 2px 5px; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); background: var(--surface); color: var(--text); }
.rp-rng { display: inline-flex; align-items: center; gap: 3px; }
.rp-inp { width: 58px; font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); background: var(--surface); color: var(--text); }
.rp-dash { color: var(--text-faint); }
.rp-unit { font-size: 11px; color: var(--text-faint); margin-left: 2px; }
.rp-flex { flex: 1 1 auto; }
.rp-png { font: inherit; font-size: 12px; padding: 3px 9px; border: 1px solid var(--border); background: var(--surface); color: var(--text); border-radius: var(--r-ctl, 2px); cursor: pointer; }
.rp-png:hover:not(:disabled) { border-color: var(--accent); }
.rp-png:disabled { opacity: .5; cursor: default; }
.rp-canvas-wrap { position: relative; padding: 4px; }
.rp-canvas-wrap canvas { display: block; width: 100%; }
.rp-loading { position: absolute; top: 8px; right: 12px; font-size: 11px; color: var(--text-faint); }
.rp-foot { padding: 4px 10px 6px; border-top: 1px solid var(--border); min-height: 20px; }
.rp-hover { font-size: 11px; font-family: var(--font-mono); color: var(--accent); }
.rp-hint { font-size: 11px; color: var(--text-faint); }
</style>
