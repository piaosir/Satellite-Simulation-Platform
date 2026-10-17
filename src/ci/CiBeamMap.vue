<script setup>
// C/CCI 目标波束页的波束图：逐波束足迹（峰值 − X 等值线）+ 波束号，单击点选；算完在目标覆盖区里铺 C/CCI 场。
//
// 投影：以「适配那一刻」视图中心纬度为标准纬线的等距圆柱（x = Δlon·cosφ₀，y = lat），平移缩放期间 φ₀ 不动
// （跟着视图中心变，横向比例尺会在拖动中一路伸缩）。中纬度服务区里波束圈因此看着是圆的——LbSurfacePlot 的
// 1°经 = 1°纬 在 35°N 会把圆压成 1.2:1 的椭圆，多波束图上一排排椭圆读起来就像方向图本身是椭的。
// 底图数据与配色同 LbSurfacePlot（shared/lbBasemap.js）；色标同一把 Turbo（shared/lbColorScale.js）。
//
// 三层 canvas：底图（海陆 + 岸线国界）· 场 · 波束与标注（含色标条，导出 PNG 时三层按序合成即成图）。
// 交互：滚轮缩放（以光标为锚）· 拖拽平移 · 双击复位；单击（按下到抬起位移 < 4 px）→ emit('pick', 原始下标)。
// 命中：点落在哪几个足迹里取峰值最近的那个（相邻足迹在 −4 dB 处彼此重叠）；不在任何足迹里时，取光标附近的波束号。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import { loadBasemap, onBasemapChange, basemapPaths, OCEAN, LAND, MAP_COAST, MAP_BORDER, MAP_LW, WASH } from '../shared/lbBasemap.js'
import { buildColorScale } from '../shared/lbColorScale.js'
import { niceScale, fmtTick } from '../shared/lbPlotScale.js'
import { isDark as screenDark, SERIES_LIGHT, SERIES_DARK } from '../shared/lbPlotTheme.js'

const props = defineProps({
  beams: { type: Array, default: () => [] },     // [{ idx, peak:{lon,lat}|null, rings:[[lon0,lat0,lon1,lat1,…]] }]
  fitKey: { type: String, default: '' },         // 变了才重新适配视图（同一副天线改覆盖电平不跳视图）
  target: { type: Number, default: null },
  co: { type: Array, default: () => [] },
  field: { type: Object, default: null },        // { xs, ys, nx, ny, z, min, max }（经纬栅格，区外 NaN）
  worst: { type: Object, default: null },        // { lon, lat, cciDb }
  dim: { type: Boolean, default: false },        // 输入已变：场压淡
  zLabel: { type: String, default: 'C/CCI' },
  zUnit: { type: String, default: 'dB' },
  height: { type: Number, default: 520 }
})
const emit = defineEmits(['pick'])

const wrap = ref(null)
const baseEl = ref(null), fieldEl = ref(null), overEl = ref(null)
const W = ref(600)
const H = computed(() => props.height)
const themeTick = ref(0)
const D2R = Math.PI / 180

// —— 视图 ——
const view = { cx: 110, cy: 30, k: 8, cos0: Math.cos(30 * D2R) }
let fittedKey = null
const kx = () => view.k * view.cos0
const px = (lon) => W.value / 2 + (lon - view.cx) * kx()
const py = (lat) => H.value / 2 - (lat - view.cy) * view.k
const geoAt = (x, y) => ({ lon: view.cx + (x - W.value / 2) / kx(), lat: view.cy - (y - H.value / 2) / view.k })
const clampK = (k) => Math.max(H.value / 170, Math.min(4000, k))

function extentOf() {
  let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity
  for (const b of props.beams) {
    for (const r of b.rings || []) {
      for (let i = 0; i < r.length; i += 2) {
        const lon = r[i], lat = r[i + 1]
        if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon
        if (lat < la0) la0 = lat; if (lat > la1) la1 = lat
      }
    }
    if (b.peak) {
      const { lon, lat } = b.peak
      if (lon < lo0) lo0 = lon; if (lon > lo1) lo1 = lon
      if (lat < la0) la0 = lat; if (lat > la1) la1 = lat
    }
  }
  return lo1 > lo0 && la1 > la0 ? { lo0, lo1, la0, la1 } : null
}
function fit() {
  const e = extentOf()
  if (!e) { view.cx = 110; view.cy = 30; view.cos0 = Math.cos(30 * D2R); view.k = clampK(H.value / 60) }
  else {
    view.cx = (e.lo0 + e.lo1) / 2; view.cy = (e.la0 + e.la1) / 2
    view.cos0 = Math.max(0.2, Math.cos(view.cy * D2R))
    const dx = Math.max(0.05, (e.lo1 - e.lo0) * view.cos0), dy = Math.max(0.05, e.la1 - e.la0)
    view.k = clampK(Math.min(W.value / dx, H.value / dy) * 0.86)
  }
  schedule(7)
}
// 聚焦目标：目标足迹外接框放大到占图面约四成（看清覆盖区里的场）
function focusTarget() {
  const b = props.beams.find((x) => x.idx === props.target)
  if (!b) return
  let lo0 = Infinity, lo1 = -Infinity, la0 = Infinity, la1 = -Infinity
  for (const r of b.rings || []) for (let i = 0; i < r.length; i += 2) {
    if (r[i] < lo0) lo0 = r[i]; if (r[i] > lo1) lo1 = r[i]
    if (r[i + 1] < la0) la0 = r[i + 1]; if (r[i + 1] > la1) la1 = r[i + 1]
  }
  if (!(lo1 > lo0) || !(la1 > la0)) return
  view.cx = (lo0 + lo1) / 2; view.cy = (la0 + la1) / 2
  view.k = clampK(Math.min(W.value / ((lo1 - lo0) * view.cos0), H.value / (la1 - la0)) * 0.42)
  schedule(7)
}
function zoomAt(f, x, y) {
  const g = geoAt(x, y)
  view.k = clampK(view.k * f)
  view.cx = g.lon - (x - W.value / 2) / kx()
  view.cy = g.lat + (y - H.value / 2) / view.k
  schedule(7)
}

// —— 主题色 ——
function palette() {
  void themeTick.value
  const dark = screenDark()
  const cs = typeof getComputedStyle === 'function' && wrap.value ? getComputedStyle(wrap.value) : null
  const v = (name, d) => (cs && cs.getPropertyValue(name).trim()) || d
  const S = dark ? SERIES_DARK : SERIES_LIGHT
  return {
    dark,
    target: S[0], co: S[1],
    // 图面上的墨（波束号 / 轮廓 / 最差点）不随界面主题翻：底图两档同为浅海浅陆（暗档只多一道洗暗），
    // 压在它上面的始终是深墨 + 白晕；随主题翻成浅字深晕，在中灰的洗暗底图上反而糊成一圈黑边
    ink: '#1b1f24',
    muted: '#4b525b',
    other: 'rgba(38,44,51,0.5)',
    otherHot: 'rgba(20,24,28,0.92)',
    halo: 'rgba(255,255,255,0.88)',
    // 色标条那块面板跟界面主题走（它是图例，不是图面）
    panel: dark ? 'rgba(27,27,27,0.9)' : 'rgba(255,255,255,0.9)',
    panelLine: dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
    panelInk: v('--text', dark ? '#e6e6e6' : '#1a1a1a'),
    panelMuted: v('--text-muted', dark ? '#afafaf' : '#6b6b66'),
    font: (cs && cs.fontFamily) || 'system-ui, sans-serif'
  }
}
const hexA = (hex, a) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return hex
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}

// —— 底图 ——
let feats = null
let _offMap = null
loadBasemap().then((m) => { feats = m; schedule(1) })
_offMap = onBasemapChange((m) => { feats = m; schedule(1) })

function drawBase(ctx, s) {
  const w = W.value * s, h = H.value * s
  ctx.fillStyle = OCEAN
  ctx.fillRect(0, 0, w, h)
  const m = feats
  if (m && (m.land.length || m.coast.length || m.borders.length)) {
    const g0 = geoAt(0, H.value), g1 = geoAt(W.value, 0)
    const vw = { lon0: g0.lon, lon1: g1.lon, lat0: g0.lat, lat1: g1.lat }
    const size = { w, h }
    const dec = { minPx: 1.1 * s, minSize: 2.6 * s }
    const trace = (paths, close) => {
      ctx.beginPath()
      for (const r of paths) {
        ctx.moveTo(r[0], r[1])
        for (let i = 2; i < r.length; i += 2) ctx.lineTo(r[i], r[i + 1])
        if (close) ctx.closePath()
      }
    }
    const land = basemapPaths(m.land, vw, size, dec)
    if (land.length) { trace(land, true); ctx.fillStyle = LAND; ctx.fill('evenodd') }
    const th = palette().dark ? 'dark' : 'light'
    ctx.fillStyle = WASH[th]
    ctx.fillRect(0, 0, w, h)
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    const lw = (o) => Math.max(o.min, o.w * s)
    const bord = basemapPaths(m.borders, vw, size, dec)
    if (bord.length) { trace(bord, false); ctx.strokeStyle = MAP_BORDER[th]; ctx.lineWidth = lw(MAP_LW.border); ctx.stroke() }
    const coast = basemapPaths(m.coast, vw, size, dec)
    if (coast.length) { trace(coast, false); ctx.strokeStyle = MAP_COAST[th]; ctx.lineWidth = lw(MAP_LW.coast); ctx.stroke() }
  }
}

// —— 场 ——
const scale = computed(() => {
  void themeTick.value
  const f = props.field
  if (!f || !Number.isFinite(f.min) || !Number.isFinite(f.max)) return null
  const lo = f.min, hi = f.max > f.min ? f.max : f.min + 1
  return buildColorScale({ min: lo, max: hi, palette: 'turbo', dark: screenDark() })
})
let fieldImg = null
function buildFieldImg() {
  fieldImg = null
  const f = props.field, sc = scale.value
  if (!f || !sc || typeof document === 'undefined') return
  const c = document.createElement('canvas')
  c.width = f.nx; c.height = f.ny
  const cx = c.getContext('2d')
  const img = cx.createImageData(f.nx, f.ny)
  const d = img.data
  for (let j = 0; j < f.ny; j++) {
    const row = (f.ny - 1 - j) * f.nx
    for (let i = 0; i < f.nx; i++) {
      const rgb = sc.rgbAt(f.z[j * f.nx + i])
      if (!rgb) continue
      const o = (row + i) * 4
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255
    }
  }
  cx.putImageData(img, 0, 0)
  fieldImg = c
}
function drawField(ctx, s) {
  const f = props.field
  if (!f || !fieldImg) return
  const hx = f.nx > 1 ? (f.xs[1] - f.xs[0]) / 2 : 0, hy = f.ny > 1 ? (f.ys[1] - f.ys[0]) / 2 : 0
  const x0 = px(f.xs[0] - hx), x1 = px(f.xs[f.nx - 1] + hx)
  const yT = py(f.ys[f.ny - 1] + hy), yB = py(f.ys[0] - hy)
  ctx.save()
  ctx.globalAlpha = props.dim ? 0.35 : 1
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(fieldImg, x0 * s, yT * s, (x1 - x0) * s, (yB - yT) * s)
  ctx.restore()
}

// —— 波束 ——
// 相邻波束峰值的中位间距（投影后度）：决定标注字号与缩远时只标目标 / 同频
const nnDeg = computed(() => {
  const pk = props.beams.filter((b) => b.peak).map((b) => b.peak)
  if (pk.length < 2) return null
  const c0 = Math.cos((pk.reduce((a, p) => a + p.lat, 0) / pk.length) * D2R)
  const d = pk.map((p, i) => {
    let m = Infinity
    for (let j = 0; j < pk.length; j++) {
      if (j === i) continue
      const v = Math.hypot((pk[j].lon - p.lon) * c0, pk[j].lat - p.lat)
      if (v < m) m = v
    }
    return m
  }).sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)]
})
const coSet = computed(() => new Set(props.co || []))
const hover = ref(null)          // { idx, lon, lat, z, x, y }

function ringPath(ctx, b, s) {
  ctx.beginPath()
  for (const r of b.rings || []) {
    if (r.length < 4) continue
    ctx.moveTo(px(r[0]) * s, py(r[1]) * s)
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(px(r[i]) * s, py(r[i + 1]) * s)
    if (r[0] === r[r.length - 2] && r[1] === r[r.length - 1]) ctx.closePath()
  }
}
function drawOver(ctx, s, P) {
  const hot = hover.value ? hover.value.idx : null
  const others = [], cos = [], tgt = []
  for (const b of props.beams) {
    if (b.idx === props.target) tgt.push(b)
    else if (coSet.value.has(b.idx)) cos.push(b)
    else others.push(b)
  }
  ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  // 其余波束：细灰线，悬停加深
  for (const b of others) {
    ringPath(ctx, b, s)
    if (b.idx === hot) { ctx.fillStyle = 'rgba(0,0,0,0.06)'; ctx.fill(); ctx.strokeStyle = P.otherHot; ctx.lineWidth = 1.6 * s }
    else { ctx.strokeStyle = P.other; ctx.lineWidth = 1 * s }
    ctx.stroke()
  }
  // 同频：橙填淡 + 实线（衬一道底色晕，压在海色 / 场上都读得出）
  for (const b of cos) {
    ringPath(ctx, b, s)
    ctx.fillStyle = hexA(P.co, b.idx === hot ? 0.24 : 0.16); ctx.fill()
    ctx.strokeStyle = P.halo; ctx.lineWidth = 3.6 * s; ctx.stroke()
    ctx.strokeStyle = P.co; ctx.lineWidth = (b.idx === hot ? 2.4 : 1.9) * s; ctx.stroke()
  }
  // 目标：有场时只描边（场就是它的填充），无场时蓝填淡
  for (const b of tgt) {
    ringPath(ctx, b, s)
    if (!fieldImg) { ctx.fillStyle = hexA(P.target, 0.2); ctx.fill() }
    ctx.strokeStyle = P.halo; ctx.lineWidth = 4.4 * s; ctx.stroke()
    ctx.strokeStyle = fieldImg ? P.ink : P.target; ctx.lineWidth = 2.4 * s; ctx.stroke()
  }
  // 波束号：缩远到标注挤在一起时只标目标 / 同频 / 悬停
  const sp = nnDeg.value != null ? nnDeg.value * kx() : 99
  const all = sp >= 20
  const fs = Math.max(9.5, Math.min(13, sp * 0.36))
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  for (const b of props.beams) {
    if (!b.peak) continue
    const isT = b.idx === props.target, isC = coSet.value.has(b.idx)
    if (!all && !isT && !isC && b.idx !== hot) continue
    const x = px(b.peak.lon) * s, y = py(b.peak.lat) * s
    if (x < -40 * s || y < -40 * s || x > (W.value + 40) * s || y > (H.value + 40) * s) continue
    ctx.font = `${isT || isC || b.idx === hot ? 700 : 500} ${fs * s}px ${P.font}`
    ctx.lineWidth = 3 * s; ctx.strokeStyle = P.halo
    const t = String(b.idx + 1)
    ctx.strokeText(t, x, y)
    ctx.fillStyle = isT || isC || b.idx === hot ? P.ink : P.muted
    ctx.fillText(t, x, y)
  }
  // 最差点
  const w = props.worst
  if (w && Number.isFinite(w.lon) && Number.isFinite(w.lat)) {
    const x = px(w.lon) * s, y = py(w.lat) * s, r = 5.5 * s
    ctx.lineWidth = 4 * s; ctx.strokeStyle = P.halo
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
    ctx.lineWidth = 1.8 * s; ctx.strokeStyle = P.ink
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke()
    ctx.beginPath(); ctx.moveTo(x - r - 3 * s, y); ctx.lineTo(x - r + 2 * s, y); ctx.moveTo(x + r - 2 * s, y); ctx.lineTo(x + r + 3 * s, y)
    ctx.moveTo(x, y - r - 3 * s); ctx.lineTo(x, y - r + 2 * s); ctx.moveTo(x, y + r - 2 * s); ctx.lineTo(x, y + r + 3 * s); ctx.stroke()
    if (Number.isFinite(w.cciDb)) {
      ctx.font = `700 ${11.5 * s}px ${P.font}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const t = w.cciDb.toFixed(2)
      ctx.lineWidth = 3 * s; ctx.strokeStyle = P.halo; ctx.strokeText(t, x + r + 6 * s, y)
      ctx.fillStyle = P.ink; ctx.fillText(t, x + r + 6 * s, y)
    }
  }
  drawBar(ctx, s, P)
}
// 色标条：右下角一块，导出时随图带走
function drawBar(ctx, s, P) {
  const sc = scale.value, f = props.field
  if (!sc || !f) return
  const lo = f.min, hi = f.max > f.min ? f.max : f.min + 1
  const bw = 188, bh = 9, pad = 10
  const boxW = bw + pad * 2, boxH = 50
  const X = (W.value - boxW - 10) * s, Y = (H.value - boxH - 10) * s
  ctx.save()
  ctx.fillStyle = P.panel; ctx.strokeStyle = P.panelLine; ctx.lineWidth = 1 * s
  roundRect(ctx, X, Y, boxW * s, boxH * s, 5 * s); ctx.fill(); ctx.stroke()
  const bx = X + pad * s, by = Y + 22 * s
  const stops = sc.stops(48)
  const grad = ctx.createLinearGradient(bx, 0, bx + bw * s, 0)
  for (const st of stops) grad.addColorStop(st.t, st.css)
  ctx.globalAlpha = props.dim ? 0.45 : 1
  ctx.fillStyle = grad; ctx.fillRect(bx, by, bw * s, bh * s)
  ctx.globalAlpha = 1
  ctx.font = `600 ${10.5 * s}px ${P.font}`; ctx.fillStyle = P.panelInk; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  ctx.fillText(`${props.zLabel} / ${props.zUnit}`, bx, Y + 15 * s)
  const nt = niceScale(lo, hi, 5)
  ctx.font = `${10 * s}px ${P.font}`; ctx.fillStyle = P.panelMuted; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.strokeStyle = P.panelMuted; ctx.lineWidth = 1 * s
  for (const t of nt.ticks) {
    if (t < lo - 1e-9 || t > hi + 1e-9) continue
    const x = bx + sc.tAt(t) * bw * s
    ctx.beginPath(); ctx.moveTo(x, by + bh * s); ctx.lineTo(x, by + (bh + 3) * s); ctx.stroke()
    ctx.fillText(fmtTick(t, nt.step), x, by + (bh + 4) * s)
  }
  ctx.restore()
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y); ctx.closePath()
}

// —— 绘制调度（1 底图 · 2 场 · 4 波束）——
let _dirty = 0, _raf = 0
function schedule(bits) {
  _dirty |= bits
  if (_raf || typeof requestAnimationFrame === 'undefined') return
  _raf = requestAnimationFrame(paint)
}
function sizeCanvas(c, dpr) {
  const w = Math.round(W.value * dpr), h = Math.round(H.value * dpr)
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
}
function paint() {
  _raf = 0
  const bits = _dirty; _dirty = 0
  const dpr = window.devicePixelRatio || 1
  const P = palette()
  const layers = [[1, baseEl.value, (c) => drawBase(c, dpr)], [2, fieldEl.value, (c) => drawField(c, dpr)], [4, overEl.value, (c) => drawOver(c, dpr, P)]]
  for (const [bit, el, fn] of layers) {
    if (!el || !(bits & bit)) continue
    sizeCanvas(el, dpr)
    const ctx = el.getContext('2d')
    ctx.clearRect(0, 0, el.width, el.height)
    fn(ctx)
  }
}

// —— 命中 ——
function inRing(r, lon, lat) {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1]
    if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function hitAt(x, y) {
  const g = geoAt(x, y)
  let best = null, bd = Infinity
  const dist = (b) => (b.peak ? Math.hypot(px(b.peak.lon) - x, py(b.peak.lat) - y) : 1e9)
  for (const b of props.beams) {
    if (!(b.rings || []).some((r) => r.length >= 6 && r[0] === r[r.length - 2] && r[1] === r[r.length - 1] && inRing(r, g.lon, g.lat))) continue
    const d = dist(b)
    if (d < bd) { bd = d; best = b }
  }
  if (best) return best.idx
  const R = Math.min(26, Math.max(10, (nnDeg.value || 1) * kx() * 0.45))
  for (const b of props.beams) { const d = dist(b); if (d < bd && d <= R) { bd = d; best = b } }
  return best ? best.idx : null
}
function fieldAt(lon, lat) {
  const f = props.field
  if (!f || f.nx < 2 || f.ny < 2) return null
  const i = Math.round((lon - f.xs[0]) / (f.xs[1] - f.xs[0])), j = Math.round((lat - f.ys[0]) / (f.ys[1] - f.ys[0]))
  if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return null
  const v = f.z[j * f.nx + i]
  return Number.isFinite(v) ? v : null
}

// —— 指针 ——
let drag = null
const dragging = ref(false)
const local = (e) => { const r = overEl.value.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] }
function onDown(e) {
  if (e.button !== 0) return
  const [x, y] = local(e)
  drag = { x, y, cx: view.cx, cy: view.cy, moved: false }
  overEl.value.setPointerCapture && overEl.value.setPointerCapture(e.pointerId)
}
function onMove(e) {
  const [x, y] = local(e)
  if (drag) {
    const dx = x - drag.x, dy = y - drag.y
    if (!drag.moved && Math.hypot(dx, dy) >= 4) { drag.moved = true; dragging.value = true; hover.value = null }
    if (drag.moved) {
      view.cx = drag.cx - dx / kx(); view.cy = drag.cy + dy / view.k
      schedule(7)
      return
    }
  }
  const idx = hitAt(x, y)
  const g = geoAt(x, y)
  const prev = hover.value ? hover.value.idx : null
  hover.value = { idx, lon: g.lon, lat: g.lat, z: fieldAt(g.lon, g.lat) }
  if (idx !== prev) schedule(4)
}
function onUp(e) {
  if (!drag) return
  const was = drag
  drag = null; dragging.value = false
  try { overEl.value.releasePointerCapture && overEl.value.releasePointerCapture(e.pointerId) } catch (er) { /* 已释放 */ }
  if (!was.moved) {
    const [x, y] = local(e)
    const idx = hitAt(x, y)
    if (idx != null) emit('pick', idx)
  }
}
function onLeave() { if (!drag && hover.value) { hover.value = null; schedule(4) } }
function onWheel(e) {
  e.preventDefault()
  const [x, y] = local(e)
  zoomAt(Math.exp(-e.deltaY * 0.0016), x, y)
}
const cursor = computed(() => (dragging.value ? 'grabbing' : (hover.value && hover.value.idx != null ? 'pointer' : 'grab')))
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`

// —— 生命周期 ——
let _ro = null, _mo = null
onMounted(() => {
  const el = wrap.value
  const measure = () => {
    const w = Math.max(240, el.clientWidth || 600)
    if (Math.abs(w - W.value) < 0.5 && fittedKey !== null) return
    W.value = w
    if (fittedKey === null && props.beams.length) { fittedKey = props.fitKey; fit() } else schedule(7)
  }
  measure()
  if (window.ResizeObserver) { _ro = new ResizeObserver(measure); _ro.observe(el) }
  if (window.MutationObserver) {
    _mo = new MutationObserver(() => { themeTick.value++; buildFieldImg(); schedule(7) })
    _mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin', 'class'] })
  }
  overEl.value.addEventListener('wheel', onWheel, { passive: false })
  buildFieldImg()
  schedule(7)
})
onBeforeUnmount(() => {
  if (_ro) _ro.disconnect()
  if (_mo) _mo.disconnect()
  if (_offMap) _offMap()
  if (_raf) cancelAnimationFrame(_raf)
  if (overEl.value) overEl.value.removeEventListener('wheel', onWheel)
})
watch(() => props.beams, () => {
  if (props.beams.length && props.fitKey !== fittedKey) { fittedKey = props.fitKey; fit() } else schedule(4)
})
watch(() => props.fitKey, (k) => { if (props.beams.length && k !== fittedKey) { fittedKey = k; fit() } })
watch(() => [props.target, props.co, props.worst], () => schedule(4), { deep: true })
watch(() => [props.field, scale.value], () => { buildFieldImg(); schedule(6) })
watch(() => props.dim, () => schedule(6))
watch(H, () => schedule(7))

// 导出：三层按序合成到一张图（倍率 scale）
function toPngDataUrl(scale = 3) {
  if (typeof document === 'undefined') return null
  const c = document.createElement('canvas')
  c.width = Math.round(W.value * scale); c.height = Math.round(H.value * scale)
  const ctx = c.getContext('2d')
  const P = palette()
  drawBase(ctx, scale); drawField(ctx, scale); drawOver(ctx, scale, P)
  return c.toDataURL('image/png')
}
defineExpose({ fit, focusTarget, toPngDataUrl })
</script>

<template>
  <div ref="wrap" class="cbm" :style="{ height: height + 'px' }">
    <canvas ref="baseEl" class="cbm-lay"></canvas>
    <canvas ref="fieldEl" class="cbm-lay"></canvas>
    <canvas ref="overEl" class="cbm-lay cbm-top" :style="{ cursor }"
      @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp" @pointerleave="onLeave" @dblclick="fit"></canvas>
    <div class="cbm-tools">
      <button type="button" class="cbm-tb" title="放大" @click="zoomAt(1.5, W / 2, height / 2)"><Icon name="zoom-in" :size="14" /></button>
      <button type="button" class="cbm-tb" title="缩小" @click="zoomAt(1 / 1.5, W / 2, height / 2)"><Icon name="zoom-out" :size="14" /></button>
      <button type="button" class="cbm-tb" title="适配全部波束（双击图面同效）" @click="fit"><Icon name="scan-eye" :size="14" /></button>
      <button type="button" class="cbm-tb" title="聚焦目标波束" :disabled="target == null" @click="focusTarget"><Icon name="crosshair" :size="14" /></button>
    </div>
    <div v-if="hover && !dragging" class="cbm-read" data-i18n-skip>
      <b v-if="hover.idx != null">#{{ hover.idx + 1 }}</b>
      <span>{{ fmtLon(hover.lon) }} {{ fmtLat(hover.lat) }}</span>
      <span v-if="hover.z != null">{{ zLabel }} <b>{{ hover.z.toFixed(2) }}</b> {{ zUnit }}</span>
    </div>
  </div>
</template>

<style scoped>
.cbm { position: relative; width: 100%; overflow: hidden; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface-2); user-select: none; touch-action: none; }
.cbm-lay { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.cbm-tools { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; gap: 4px; }
.cbm-tb { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; padding: 0; cursor: pointer; color: var(--text); background: color-mix(in srgb, var(--bg) 88%, transparent); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.cbm-tb:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg); }
.cbm-tb:disabled { opacity: 0.45; cursor: default; }
.cbm-read { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; align-items: baseline; padding: 3px 8px; font-size: var(--fs-3); font-variant-numeric: tabular-nums; color: var(--text-muted); background: color-mix(in srgb, var(--bg) 90%, transparent); border: 1px solid var(--border); border-radius: var(--r-ctl); pointer-events: none; white-space: nowrap; }
.cbm-read b { color: var(--text); font-weight: 700; }
</style>
