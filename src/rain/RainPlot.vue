<script setup>
// 雨衰函数交互式坐标系（canvas 2D）。纵轴固定 = 雨衰(dB)；横轴可选 可用度 / 频率 / 降雨率 / 仰角，
// 取值范围默认合理且可改；曲线经主进程 core.sweepRainAttenuation 计算；当前算例取值处标记 +
// 悬停读数；「导出 PNG」复用通用 file:save 通道（白底、含标题/坐标，适合放进用户报告）。
//
// 【可用度轴 = 不可用度对数刻度】线性刻度画不了高可用度：99.99 ~ 99.99999 在数轴上只占 0.01，
// 全挤在最右一格，刻度标签还会四舍五入成重复串（99.99 99.99 100.00 100.00）。改按
// u = 100 − 可用度 取对数等分后，99 / 99.9 / 99.99 / 99.999 / 99.9999 / 99.99999 各占等宽一段，
// 每多一个「9」宽度相同；取点也同步等比（sweep 传 spacing:'log-unavail'）。且雨衰对 p 是幂律，
// 取对数后曲线接近直线。其余三轴（频率 / 降雨率 / 仰角）仍是线性。
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { halfStr } from '../shared/num.js'

const props = defineProps({
  params: { type: Object, default: null },   // buildRainCase 输出（当前算例）
  result: { type: Object, default: null },   // 当前算例结果（取 rainAtten 作标记）
  station: { type: String, default: '' }
})

const api = (typeof window !== 'undefined' && window.api) ? window.api.rainAttenuation : null
const exportFile = (typeof window !== 'undefined' && window.api) ? window.api.exportFile : null

// 不可用度下限（% 时间）：可用度封顶 100 − 1e-7（8 个 9）。u 须为正才取得了对数，
// 且再往下已是浮点噪声（1e-7 % 合 0.03 s/年）。
const U_FLOOR = 1e-7

// 横轴定义（dmin/dmax 为默认取值范围，可在界面改；log:true = 按不可用度取对数）
const AXES = {
  availability: { label: '可用度', unit: '%', dmin: 99, dmax: 99.999, log: true, cur: (p) => p.availability },
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

// 屏幕态边距（导出态另有一套，见 drawTo）——悬停命中要与绘制同一份，故提到模块级
const PAD = { mL: 52, mR: 14, mT: 12, mB: 40 }

const curAxis = computed(() => AXES[axis.value])
const curX = computed(() => (props.params && curAxis.value) ? curAxis.value.cur(props.params) : null)
const curY = computed(() => (props.result && Number.isFinite(+props.result.rainAtten)) ? +props.result.rainAtten : null)

// 实际入算的取值范围：对数轴上把可用度收进 [·, 100−U_FLOOR]，保证 u > 0
const xr = computed(() => {
  const A = curAxis.value
  let mn = parseFloat(halfStr(range.min)), mx = parseFloat(halfStr(range.max))
  if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null
  if (A.log) { mx = Math.min(mx, 100 - U_FLOOR); mn = Math.min(mn, 100 - U_FLOOR * 10) }
  if (!(mx > mn)) return null
  return { mn, mx }
})

// 值 ⇄ 归一化横向位置 t ∈ [0,1]。线性轴按值等分；可用度轴按 u = 100 − 可用度 取对数等分。
function posOf(x, r, A) {
  if (!r || !Number.isFinite(x)) return null
  if (A.log) {
    const u1 = 100 - r.mn, u2 = 100 - r.mx, u = 100 - x
    if (!(u1 > 0) || !(u2 > 0) || !(u > 0)) return null
    return Math.log(u1 / u) / Math.log(u1 / u2)
  }
  return (x - r.mn) / (r.mx - r.mn || 1)
}

// 可用度读数：小数位跟着不可用度的量级走，再削掉补位的 0 —— 固定 2 位会把 99.99 与 99.99999
// 显示成同一个数，固定 7 位又让 99.9 拖一串 0
function trimZeros(s) { return s.indexOf('.') < 0 ? s : s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') }
function fmtAvail(a) {
  const u = 100 - a
  if (!(u > 0)) return '100'
  return trimZeros(a.toFixed(Math.min(9, Math.max(1, Math.ceil(-Math.log10(u)) + 1))))
}
// 线性轴：小数位由刻度间距定（窄区间也不会两格显示成同一个数），全轴统一位数不削尾零
function fmtLin(x, span) {
  const step = Math.abs(span) / 5
  return x.toFixed(Math.min(8, Math.max(0, Math.ceil(-Math.log10(step || 1)) + 1)))
}
function fmtX(x) {
  const A = curAxis.value, r = xr.value
  return A.log ? fmtAvail(x) : fmtLin(x, r ? (r.mx - r.mn) : 1)
}

let _sweepT = null
function scheduleSweep() { clearTimeout(_sweepT); _sweepT = setTimeout(runSweep, 180) }
async function runSweep() {
  const r = xr.value
  if (!api || !props.params || !r) { points.value = []; draw(); return }
  loading.value = true
  try {
    const res = await api.sweep(props.params, axis.value, {
      min: r.mn, max: r.mx,
      steps: Math.max(2, Math.min(400, parseInt(range.steps, 10) || 120)),
      spacing: curAxis.value.log ? 'log-unavail' : 'linear'
    })
    points.value = (res && Array.isArray(res.points)) ? res.points : []
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

// 横轴刻度。对数轴取 u 的 1/2/5 × 10^k —— 标签正好落在 99 / 99.9 / 99.99 … 这些「9」上；
// 挤得放不下就退到 1/5、再退到整十倍幂，仍放不下才等距抽稀。另给不带标签的次网格（m=1..9）。
function xTicksFor(r, A, ctx, pw, forExport) {
  const out = []
  if (!r) return out
  if (A.log) {
    const u1 = 100 - r.mn, u2 = 100 - r.mx
    const kHi = Math.floor(Math.log10(u1)), kLo = Math.floor(Math.log10(u2))
    const build = (ms) => {
      const t = []
      for (let k = kHi; k >= kLo; k--) for (const m of ms) {
        const u = m * Math.pow(10, k)
        if (u <= u1 * (1 + 1e-9) && u >= u2 * (1 - 1e-9)) t.push({ v: 100 - u, label: (100 - u).toFixed(Math.max(0, -k)) })
      }
      return t
    }
    const gapOk = (t) => {
      if (t.length < 2) return true
      let w = 0, g = Infinity
      for (let i = 0; i < t.length; i++) {
        w = Math.max(w, ctx.measureText(t[i].label).width)
        if (i) g = Math.min(g, Math.abs(posOf(t[i].v, r, A) - posOf(t[i - 1].v, r, A)) * pw)
      }
      return g >= w + (forExport ? 24 : 12)
    }
    let ticks = null
    for (const ms of [[5, 2, 1], [5, 1], [1]]) { const t = build(ms); if (gapOk(t)) { ticks = t; break } }
    if (!ticks) {
      const all = build([1])
      const stride = Math.max(1, Math.ceil(all.length / Math.max(2, Math.floor(pw / 64))))
      ticks = all.filter((_, i) => i % stride === 0)
    }
    // 区间窄到装不下一个 1/2/5 档（如 99.999–99.9991）时按位置等分兜底，否则轴上只剩一根刻度
    if (ticks.length < 2) {
      for (const n of [4, 3, 2]) {
        const t = []
        for (let i = 0; i <= n; i++) {
          const v = 100 - u1 * Math.pow(u2 / u1, i / n)
          t.push({ v, label: fmtAvail(v) })
        }
        if (gapOk(t)) { ticks = t; break }
        ticks = t
      }
    }
    // 次网格：十倍程内的 m×10^k，只画线不写字。密度跟着每十倍程摊到多少像素走 ——
    // 对数刻度上 9→8 只隔 0.05 个十倍程，窄了画满就是一条灰带
    const dw = pw / Math.max(1, kHi - kLo)
    const minors = dw >= 160 ? [9, 8, 7, 6, 5, 4, 3, 2] : dw >= 55 ? [5, 2] : null
    if (minors) {
      for (let k = kHi; k >= kLo; k--) for (const m of minors) {
        const u = m * Math.pow(10, k)
        if (u <= u1 && u >= u2) out.push({ v: 100 - u, minor: true })
      }
    }
    return out.concat(ticks)
  }
  const span = r.mx - r.mn
  for (let i = 0; i <= 5; i++) {
    const v = r.mn + span * i / 5
    out.push({ v, label: fmtLin(v, span) })
  }
  return out
}

function drawTo(ctx, W, H, forExport) {
  const pal = palette(forExport)
  ctx.clearRect(0, 0, W, H)
  if (forExport) { ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H) }
  // 导出时字号/线宽/边距整体放大，配合更高 DPI → 报告里清晰
  const FS = forExport ? 15 : 11, FSM = forExport ? 15 : 11, FST = forExport ? 19 : 14
  const LWg = forExport ? 1.2 : 1, LWa = forExport ? 1.8 : 1.2, LWc = forExport ? 3 : 2
  // 与界面同栈（styles/global.css 的 --font-serif 手工镜像）：Times New Roman 打西文，宋体接中文
  const font = (px, w) => (w ? w + ' ' : '') + px + 'px "Times New Roman", Times, "SimSun", "宋体", serif'
  const mL = forExport ? 68 : PAD.mL, mR = forExport ? 22 : PAD.mR, mT = forExport ? 46 : PAD.mT, mB = forExport ? 54 : PAD.mB
  const pw = W - mL - mR, ph = H - mT - mB
  const A = curAxis.value
  const r = xr.value
  const pts = points.value.filter((p) => p && p.y != null && Number.isFinite(p.y))
  const ymax = niceYMax(Math.max(curY.value || 0, ...pts.map((p) => p.y), 0.001))
  const X = (x) => { const t = posOf(x, r, A); return t == null ? null : mL + t * pw }
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
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  for (const t of xTicksFor(r, A, ctx, pw, forExport)) {
    const xx = X(t.v); if (xx == null) continue
    ctx.strokeStyle = pal.grid
    if (t.minor) {
      ctx.save(); ctx.globalAlpha = 0.4
      ctx.beginPath(); ctx.moveTo(xx, mT); ctx.lineTo(xx, mT + ph); ctx.stroke()
      ctx.restore(); continue
    }
    ctx.beginPath(); ctx.moveTo(xx, mT); ctx.lineTo(xx, mT + ph); ctx.stroke()
    ctx.fillStyle = pal.sub
    // 两端标签居中会顶出画布（99.99999 有 8 个字符），按半宽收进画布内
    const hw = ctx.measureText(t.label).width / 2
    ctx.fillText(t.label, Math.max(hw + 1, Math.min(xx, W - hw - 1)), mT + ph + (forExport ? 8 : 5))
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
      const xx = X(p.x); if (xx == null) { started = false; continue }
      const yy = Y(p.y)
      if (!started) { ctx.moveTo(xx, yy); started = true } else ctx.lineTo(xx, yy)
    }
    ctx.stroke()
  }

  // 当前算例标记
  const mx = (curX.value != null && curY.value != null) ? X(curX.value) : null
  if (mx != null && mx >= mL - 0.5 && mx <= W - mR + 0.5) {
    const my = Y(curY.value)
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

// 悬停读数：取横向位置最近的采样点（对数轴上按位置比按值近，否则读数总粘在高可用度那一端）
function onMove(e) {
  const cv = canvas.value, r = xr.value; if (!cv || !r || !points.value.length) return
  const A = curAxis.value
  const rect = cv.getBoundingClientRect()
  const pw = cssW - PAD.mL - PAD.mR, ph = cssH - PAD.mT - PAD.mB
  const t = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD.mL) / (pw || 1)))
  let best = null, bd = Infinity
  for (const p of points.value) {
    if (p.y == null) continue
    const pt = posOf(p.x, r, A); if (pt == null) continue
    const d = Math.abs(pt - t)
    if (d < bd) { bd = d; best = { p, t: pt } }
  }
  if (!best) { hover.value = null; return }
  const ymax = niceYMax(Math.max(curY.value || 0, ...points.value.filter((p) => p.y != null).map((p) => p.y), 0.001))
  hover.value = { x: best.p.x, y: best.p.y, px: PAD.mL + best.t * pw, py: PAD.mT + ph - (best.p.y / (ymax || 1)) * ph }
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

const hoverText = computed(() => hover.value
  ? (`${curAxis.value.label} ${fmtX(hover.value.x)} ${curAxis.value.unit} → 雨衰 ${hover.value.y.toFixed(2)} dB`)
  : '')
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
        <input v-model="range.min" class="rp-inp" :class="{ wide: curAxis.log }" type="number" step="any" title="下限" />
        <span class="rp-dash">–</span>
        <input v-model="range.max" class="rp-inp" :class="{ wide: curAxis.log }" type="number" step="any" title="上限" />
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
    </div>
  </div>
</template>

<style scoped>
.rp { border: 1px solid var(--border); border-radius: var(--r-box, 3px); overflow: hidden; background: var(--surface); }
.rp-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
.rp-lb { font-size: 12px; color: var(--text-muted); }
.rp-sel { font: inherit; font-size: 12px; padding: 2px 5px; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); background-color: var(--surface); color: var(--text); }
.rp-rng { display: inline-flex; align-items: center; gap: 3px; }
.rp-inp { width: 58px; font: inherit; font-size: 12px; padding: 2px 4px; border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); background: var(--surface); color: var(--text); }
/* 可用度轴要放得下 99.99999（8 字符）+ 数字输入框自带的步进箭头 */
.rp-inp.wide { width: 84px; }
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
</style>
