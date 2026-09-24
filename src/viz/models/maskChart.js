// 遮挡掩模的方位 / 俯仰二维图（canvas；框架无关的类，Vue 组件包一层即可）。
//
// 数据口径（D2，唯一定义在 packages/core/models/mask.mjs）：本体系方向，原点 = 挂点；
//   横轴 az 0–360°（自本体 +X 向 +Y），纵轴 el −90…+90°（+90° = 本体 +Z = 天底）。格子 360×181，整度格心。
// 画法（map2/timeline-ui.md §1.4 / §1.6 推荐的那一套）：
//   · 360×181 格先画进离屏位图（一格一像素），再关平滑 drawImage 进图框——二值掩模格边必须清楚；导出时在大画布上重画同一张位图，
//     不拉伸屏上画布（memory lb-export-png-resolution：位图层按倍率重画）。
//   · 屏上 / 导出同一个 drawTo(ctx, W, H, forExport)（RainPlot 两档）：屏上字体跟界面（uiFontStack）、颜色读 CSS 变量随主题；
//     导出字体跟报告（DOC_FONT_STACK）、白底印刷色、4 倍。
// 纵轴朝向：el 自下而上增大，+90°（天底）在上。理由：纵轴是带数的俯仰角，数值轴一律下小上大，倒过来读者会读反；
//   且与 D2 的行号（elIdx = el + 90）同向。天底 / 天顶另在刻度旁标 +Z / −Z。口径文字见 MASK_CHART_CALIBER（给宿主放进 title）。
// 两种着色：
//   'blocked'   遮挡格暖红实填，其余留底色（网格在下）。
//   'clearance' 遮挡格按最近遮挡距离（m）走单色相顺序色阶（暖红，近 = 显著：浅色主题深、深色主题亮），右侧色标条；
//               距离跨度超过 20 倍取对数刻度。
// 叠加：视轴十字（marks）、视场 / 限位 / 地球圆盘等折线（polylines，方位跨 0/360 的由 coneOutline 断开）。
// 悬停：格子高亮 + 画布内读数框（运行时数据：az / el、净空 m、挡住它的节点名）+ onHover 回调；不写任何判定字样。
import { uiFontStack, DOC_FONT_STACK } from '../../shared/lbFont.js'
import { isDark } from '../../shared/lbPlotTheme.js'
import { PALETTE } from '../../shared/lbColorScale.js'
import { maskIndex, maskAzEl, maskCell, MASK_W, MASK_H } from '@core/models/mask.mjs'

const W_CELLS = MASK_W, H_CELLS = MASK_H
const D2R = Math.PI / 180

/** 图的口径（宿主放进标题或分区名的 title；界面上不写说明文字） */
export const MASK_CHART_CALIBER = '横轴：方位 az（本体系，自 +X 向 +Y，0–360°）；纵轴：俯仰 el（+90° = 本体 +Z 天底，在上；−90° = 天顶）。' +
  '原点 = 挂点，射线起点沿视轴外推 1 cm。红格 = 该方向视线被星体挡住；色阶档 = 最近遮挡距离（m）。十字 = 视轴。'

// 暖红：取 lbColorScale 的暖臂（与蓝阶同明度同彩度逐级镜像、经校验），浅色主题取中浅一级（大面积实填不宜饱和），深色取中深一级
const RED = PALETTE.RED

/** 本体系方向 → [az°∈[0,360), el°]（mask.mjs 的 maskAzEl，D2 同一处定义；画叠加用，不取整） */
const _ae = { az: 0, el: 0 }
export function dirToAzEl(d) {
  maskAzEl(d, _ae)
  return [_ae.az, _ae.el]
}
export function azElToDir(az, el) {
  const a = az * D2R, e = el * D2R
  return [Math.cos(e) * Math.cos(a), Math.cos(e) * Math.sin(a), Math.sin(e)]
}

/**
 * 以 dirBody 为轴、半角 halfDeg 的圆锥与单位球的交线 → az/el 折线（跨 0/360 处断开；包含极点时方位扫满一周，折线自然贴顶/底）。
 * @returns {Array<Array<[az,el]>>}
 */
export function coneOutline(dirBody, halfDeg, n = 240) {
  const L = Math.hypot(dirBody[0], dirBody[1], dirBody[2]) || 1
  const z = [dirBody[0] / L, dirBody[1] / L, dirBody[2] / L]
  const ref = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let x = [ref[1] * z[2] - ref[2] * z[1], ref[2] * z[0] - ref[0] * z[2], ref[0] * z[1] - ref[1] * z[0]]
  const xl = Math.hypot(x[0], x[1], x[2]); x = x.map((v) => v / xl)
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const c = Math.cos(halfDeg * D2R), s = Math.sin(halfDeg * D2R)
  const out = []
  let cur = [], prev = null
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * 2 * Math.PI, ct = Math.cos(t), st = Math.sin(t)
    const d = [z[0] * c + s * (x[0] * ct + y[0] * st), z[1] * c + s * (x[1] * ct + y[1] * st), z[2] * c + s * (x[2] * ct + y[2] * st)]
    const p = dirToAzEl(d)
    if (prev && Math.abs(p[0] - prev[0]) > 180) {
      // 跨缝：在 0/360 上各补一个端点，断成两段
      const a0 = prev[0] > 180 ? 360 : 0, a1 = 360 - a0
      const f = (a0 - prev[0]) / ((p[0] + (a0 === 360 ? 360 : -360)) - prev[0])
      const eMid = prev[1] + (p[1] - prev[1]) * (Number.isFinite(f) ? f : 0.5)
      cur.push([a0, eMid]); out.push(cur); cur = [[a1, eMid]]
    }
    cur.push(p); prev = p
  }
  if (cur.length > 1) out.push(cur)
  // 圆是闭合的：起点不在缝上时，末段与首段其实相连，拼成一段（跨缝两次的圆就只有两段）
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1]
    const a = f[0], b = l[l.length - 1]
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) { out[0] = l.concat(f.slice(1)); out.pop() }
  }
  return out
}

// ───────────────────────────── 配色 ─────────────────────────────
function cssVar(cs, n, f) { const v = cs ? (cs.getPropertyValue(n) || '').trim() : ''; return v || f }
function paletteOf(forExport) {
  if (forExport) {
    return { bg: '#ffffff', plot: '#ffffff', text: '#1a1a1a', muted: '#4a4a46', faint: '#77776f', grid: '#e3e2dd', frame: '#8e8d85',
      blocked: RED[3], ramp: RED.slice(1).reverse(), ink: '#1a1a1a', halo: '#ffffff', hi: '#1a1a1a', tipBg: '#ffffff', tipBorder: '#adaca4', dark: false }
  }
  let cs = null
  try { cs = getComputedStyle(document.documentElement) } catch { /* 无 DOM */ }
  const dark = isDark()
  return {
    bg: 'transparent',
    plot: cssVar(cs, '--bg', dark ? '#1c1c1a' : '#ffffff'),
    text: cssVar(cs, '--text', dark ? '#ececea' : '#1a1a1a'),
    muted: cssVar(cs, '--text-muted', dark ? '#a4a49e' : '#6b6b66'),
    faint: cssVar(cs, '--text-faint', dark ? '#82817a' : '#86867f'),
    grid: cssVar(cs, '--border', dark ? '#3f3f39' : '#d3d2cc'),
    frame: cssVar(cs, '--border-strong', dark ? '#5c5b54' : '#adaca4'),
    // 大面积实填：浅色取 RED[2]（中浅）、深色取 RED[4]（中深，压在 #1c1c1a 上不刺眼）
    blocked: dark ? RED[4] : RED[2],
    // 顺序色阶按「近 = 显著」：浅色主题近端深，深色主题近端亮。t=0 为近端。
    //   两头各收一级：浅色的远端不取最浅的 RED[0]（白底上几乎看不见），深色的近端不取 RED[0/1]（整片贴着挂点的大块浅粉在暗底上刺眼）
    ramp: dark ? RED.slice(2) : RED.slice(1).reverse(),
    ink: cssVar(cs, '--text', dark ? '#ececea' : '#1a1a1a'),
    halo: cssVar(cs, '--bg', dark ? '#1c1c1a' : '#ffffff'),
    hi: cssVar(cs, '--text', dark ? '#ececea' : '#1a1a1a'),
    tipBg: cssVar(cs, '--bg', dark ? '#1c1c1a' : '#ffffff'),
    tipBorder: cssVar(cs, '--border-strong', dark ? '#5c5b54' : '#adaca4'),
    dark
  }
}
const hexRgb = (h) => { const s = h.replace('#', ''); return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)] }
function rampAt(stops, t) {
  const x = Math.max(0, Math.min(1, t)) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i
  const a = hexRgb(stops[i]), b = hexRgb(stops[i + 1])
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** 净空色阶的值域与映射（纯函数，单测可直接用）：跨度 > 20 倍取对数 */
export function clearanceScale(clearance, blocked) {
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k < clearance.length; k++) {
    if (blocked && !blocked[k]) continue
    const v = clearance[k]
    if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v }
  }
  if (!Number.isFinite(lo)) return null
  lo = Math.max(lo, 0.001)
  if (!(hi > lo * 1.0001)) hi = lo * 1.5 + 0.01
  const log = hi / lo > 20
  const L0 = Math.log10(lo), L1 = Math.log10(hi)
  const t = log ? (v) => (Math.log10(Math.max(v, lo)) - L0) / (L1 - L0) : (v) => (v - lo) / (hi - lo)
  // 刻度：对数取 1/2/5×10^k，线性取 niceStep
  const ticks = []
  if (log) {
    for (let k = Math.floor(L0); k <= Math.ceil(L1); k++) for (const m of [1, 2, 5]) { const v = m * Math.pow(10, k); if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v) }
    if (ticks.length > 6) { const keep = ticks.filter((v) => /^1/.test(v.toExponential())); if (keep.length >= 2) ticks.splice(0, ticks.length, ...keep) }
  } else {
    const raw = (hi - lo) / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(+v.toPrecision(10))
  }
  return { lo, hi, log, t, ticks }
}
const fmtM = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3))
// 色标刻度（1/2/5 整数档）：去掉尾零，10.0 → 10、0.500 → 0.5
const fmtTick = (v) => String(+v.toPrecision(3))

// ───────────────────────────── 图类 ─────────────────────────────
export class MaskChart {
  /**
   * @param o { mode?: 'blocked'|'clearance', onHover?: (info|null) => void, height?: 'auto'|'fill'|number }
   *   height：'auto'（缺省）= 按宽度取图框 2:1 + 边距，画布自己定高；'fill' = 填满容器高度；数字 = 固定 CSS 像素高
   *   info = { az, el, idx, blocked:0|1, clearanceM:number|null, node:string|null }
   */
  constructor(o = {}) {
    this.mode = o.mode === 'clearance' ? 'clearance' : 'blocked'
    this.onHover = typeof o.onHover === 'function' ? o.onHover : null
    this.height = o.height === 'fill' || Number.isFinite(o.height) ? o.height : 'auto'
    this.data = null
    this.overlays = { marks: [], polylines: [] }
    this.hover = null
    this._img = null; this._imgKey = ''
    this._el = null; this._cv = null; this._ro = null; this._mo = null; this._raf = 0
    this._cssW = 0; this._cssH = 0; this._dpr = 1
    this._layout = null
    this._onMove = (e) => this._move(e)
    this._onLeave = () => this._leave()
  }

  /** 挂到容器上。已挂在别处时先摘下（数据与叠加保留：弹出大图 / 换页签 / KeepAlive 复用后不必重新 setData） */
  mount(el) {
    if (this._el) this._detach()
    this._el = el
    const cv = document.createElement('canvas')
    cv.style.cssText = 'display:block;width:100%;height:100%;'
    cv.setAttribute('role', 'img')
    cv.setAttribute('aria-label', MASK_CHART_CALIBER)
    el.appendChild(cv)
    this._cv = cv
    cv.addEventListener('pointermove', this._onMove)
    cv.addEventListener('pointerleave', this._onLeave)
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(el) }
    // 主题 / 界面字体（<html> 行内 --font-ui）一变就重画：屏上配色与字体都是现读 CSS 变量的
    if (typeof MutationObserver !== 'undefined') {
      this._mo = new MutationObserver(() => { this._imgKey = ''; this.draw() })
      this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    }
    this.resize()
    return this
  }

  /** data：{ blocked:Uint8Array(65160), clearance?:Float32Array, hitNode?:Int32Array, nodeNames?:string[] } | null */
  setData(data) {
    this.data = data && data.blocked ? data : null
    this._imgKey = ''
    this.hover = null
    this.draw()
  }
  setMode(mode) { this.mode = mode === 'clearance' ? 'clearance' : 'blocked'; this._imgKey = ''; this._cssW = 0; this.resize() }
  /**
   * overlays：
   *   marks:     [{ dirBody?:[3], az?, el?, label? }]   十字（视轴等）
   *   polylines: [{ pts:[[az,el],…], dash?:number[], width? }]   视场圆 / 限位框 / 地球圆盘（coneOutline 的每段各算一条）
   */
  setOverlays(ov) {
    this.overlays = { marks: Array.isArray(ov && ov.marks) ? ov.marks : [], polylines: Array.isArray(ov && ov.polylines) ? ov.polylines : [] }
    this.draw()
  }

  resize() {
    if (!this._cv || !this._el) return
    this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const w = Math.max(240, this._el.clientWidth || 0)
    const h = this.height === 'fill' ? Math.max(120, this._el.clientHeight || 0)
      : Number.isFinite(this.height) ? this.height : Math.round(this._naturalHeight(w))
    if (w === this._cssW && h === this._cssH && this._cv.width === Math.round(w * this._dpr)) { this.draw(); return }
    this._cssW = w; this._cssH = h
    this._cv.width = Math.round(w * this._dpr); this._cv.height = Math.round(h * this._dpr)
    this._cv.style.height = this.height === 'fill' ? '100%' : h + 'px'
    this.draw()
  }
  _margins(forExport, withBar, titled) {
    const k = forExport ? 1.3 : 1
    return { l: Math.round(58 * k), r: Math.round((withBar ? 70 : 14) * k), t: Math.round((titled ? 34 : 10) * k), b: Math.round(50 * k) }
  }
  _naturalHeight(w) {
    const m = this._margins(false, this.mode === 'clearance', false)
    return (w - m.l - m.r) / 2 + m.t + m.b
  }

  draw() {
    if (!this._cv) return
    if (this._raf) return
    const go = () => {
      this._raf = 0
      const ctx = this._cv.getContext('2d')
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
      this._layout = this.drawTo(ctx, this._cssW, this._cssH, false)
    }
    if (typeof requestAnimationFrame !== 'undefined') this._raf = requestAnimationFrame(go)
    else go()
  }

  // 360×181 格 → 离屏位图（多补一列 = 第 0 列，让 az 360 那半格也有色；格心在整度，图框 0–360 两端各裁半格）
  _image(pal) {
    const key = this.mode + '|' + pal.blocked + '|' + pal.ramp.join(',')
    if (this._img && this._imgKey === key) return this._img
    const W = W_CELLS + 1, H = H_CELLS
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H })
    const ctx = cv.getContext('2d')
    const img = ctx.createImageData(W, H)
    const d = this.data
    let scale = null
    if (d && this.mode === 'clearance' && d.clearance) scale = clearanceScale(d.clearance, d.blocked)
    const bc = hexRgb(pal.blocked)
    // 顺序色阶查找表（256 级）
    const lut = new Uint8Array(256 * 3)
    for (let i = 0; i < 256; i++) { const c = rampAt(pal.ramp, i / 255); lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2] }
    if (d) {
      for (let j = 0; j < H; j++) {
        const row = H - 1 - j            // 位图第 0 行在上 = el +90
        for (let i = 0; i < W; i++) {
          const k = j * W_CELLS + (i % W_CELLS)
          if (!d.blocked[k]) continue
          const o = (row * W + i) * 4
          let c = bc
          if (scale) { const v = d.clearance[k]; if (Number.isFinite(v)) { const q = Math.round(Math.max(0, Math.min(1, scale.t(v))) * 255) * 3; c = [lut[q], lut[q + 1], lut[q + 2]] } }
          img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255
        }
      }
    }
    ctx.putImageData(img, 0, 0)
    this._img = { cv, scale }
    this._imgKey = key
    return this._img
  }

  /**
   * 屏上 / 导出同一个画法。W×H 为逻辑尺寸（ctx 已按倍率缩放）。返回图框布局（悬停换算用）。
   * @param opt { title?: string }  导出时可带图题（运行时数据，如挂点名）
   */
  drawTo(ctx, W, H, forExport, opt = {}) {
    const pal = paletteOf(forExport)
    const im = this._image(pal)
    const withBar = this.mode === 'clearance' && !!(im.scale)
    const m = this._margins(forExport, withBar, !!opt.title)
    const stack = forExport ? DOC_FONT_STACK : uiFontStack()
    const FS = forExport ? 13 : 11, FSs = forExport ? 11.5 : 10
    const font = (px, w) => (w ? w + ' ' : '') + px + 'px ' + stack
    ctx.save()
    ctx.clearRect(0, 0, W, H)
    if (forExport) { ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H) }
    // 图框：保持 2:1（方位与俯仰每度等长，形状不失真），放不下就按高度缩，水平居中
    let pw = W - m.l - m.r, ph = pw / 2
    if (ph > H - m.t - m.b) { ph = Math.max(40, H - m.t - m.b); pw = ph * 2 }
    const x0 = m.l + Math.max(0, (W - m.l - m.r - pw) / 2), y0 = m.t
    const X = (az) => x0 + (az / 360) * pw
    const Y = (el) => y0 + ((90 - el) / 180) * ph
    const lay = { x0, y0, pw, ph, X, Y }

    if (opt.title) {
      ctx.fillStyle = pal.text; ctx.font = font(forExport ? 15 : 13, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      ctx.fillText(opt.title, x0, m.t - (forExport ? 14 : 10))
    }
    // 底色 + 网格（格子画在网格上面：遮挡区里不需要网格）
    ctx.fillStyle = pal.plot; ctx.fillRect(x0, y0, pw, ph)
    ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
    ctx.beginPath()
    for (let a = 30; a < 360; a += 30) { const x = Math.round(X(a)) + 0.5; ctx.moveTo(x, y0); ctx.lineTo(x, y0 + ph) }
    for (let e = -60; e <= 60; e += 30) { const y = Math.round(Y(e)) + 0.5; ctx.moveTo(x0, y); ctx.lineTo(x0 + pw, y) }
    ctx.stroke()

    // 格子：位图覆盖 az ∈ [−0.5, 360.5]、el ∈ [−90.5, 90.5]，裁到图框
    if (this.data) {
      ctx.save()
      ctx.beginPath(); ctx.rect(x0, y0, pw, ph); ctx.clip()
      ctx.imageSmoothingEnabled = false
      ctx.drawImage(im.cv, X(-0.5), Y(90.5), (361 / 360) * pw, (181 / 180) * ph)
      ctx.restore()
    }

    // 叠加折线
    ctx.save()
    ctx.beginPath(); ctx.rect(x0 - 1, y0 - 1, pw + 2, ph + 2); ctx.clip()
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'
    for (const pl of this.overlays.polylines) {
      const pts = pl && pl.pts
      if (!Array.isArray(pts) || pts.length < 2) continue
      const lw = (pl.width || 1.5) * (forExport ? 1.2 : 1)
      const path = () => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))) }
      // 底色描边一圈再描墨线（surface ring）：压在红格上也读得出
      ctx.setLineDash([]); ctx.strokeStyle = pal.halo; ctx.lineWidth = lw + 2.5; ctx.globalAlpha = 0.85; path(); ctx.stroke()
      ctx.globalAlpha = 1; ctx.strokeStyle = pal.ink; ctx.lineWidth = lw; ctx.setLineDash(Array.isArray(pl.dash) ? pl.dash : []); path(); ctx.stroke()
    }
    ctx.setLineDash([])
    // 十字（视轴）。视轴落在极点（|el| ≥ 89.5°，即本体 ±Z——对地天线最常见）时方位无定义、整条上 / 下边都是那一个方向：
    //   改画贴边的粗墨线（整条边 = 视轴），标签放在边内左端
    for (const mk of this.overlays.marks) {
      const ae = mk && Array.isArray(mk.dirBody) ? dirToAzEl(mk.dirBody) : (mk && Number.isFinite(mk.az) && Number.isFinite(mk.el) ? [mk.az, mk.el] : null)
      if (!ae) continue
      if (Math.abs(ae[1]) >= 89.5) {
        const ye = ae[1] > 0 ? y0 : y0 + ph, lwp = forExport ? 4 : 3
        ctx.fillStyle = pal.ink; ctx.fillRect(x0, ae[1] > 0 ? ye : ye - lwp, pw, lwp)
        if (mk.label) {
          // 贴边标签垫一块底色：视轴在天底时地球圆盘线（GEO 81.3°）就在这条边下面几像素，光靠描边压不住虚线
          ctx.font = font(FSs); ctx.textAlign = 'left'; ctx.textBaseline = ae[1] > 0 ? 'top' : 'bottom'
          const ty = ae[1] > 0 ? ye + lwp + 2 : ye - lwp - 2
          const tw = ctx.measureText(mk.label).width, pad = 3, bh = FSs + 4
          ctx.fillStyle = pal.halo
          ctx.fillRect(x0 + 6 - pad, ae[1] > 0 ? ty : ty - bh, tw + 2 * pad, bh)
          ctx.fillStyle = pal.text; ctx.fillText(mk.label, x0 + 6, ae[1] > 0 ? ty + 2 : ty - 2)
        }
        continue
      }
      const x = X(ae[0]), y = Y(ae[1]), r = forExport ? 9 : 7
      for (const [col, lw] of [[pal.halo, forExport ? 5 : 4], [pal.ink, forExport ? 2 : 1.5]]) {
        ctx.strokeStyle = col; ctx.lineWidth = lw
        ctx.beginPath(); ctx.moveTo(x - r, y); ctx.lineTo(x + r, y); ctx.moveTo(x, y - r); ctx.lineTo(x, y + r); ctx.stroke()
      }
      if (mk.label) {
        // 标签缺省在十字右上；右边放不下（视轴 az ≈ 340–360°）翻到左边右对齐，上边放不下（贴 el +90 边）翻到下面——
        // 否则超出图框的部分被裁掉，文字截断
        ctx.font = font(FSs)
        const tw = ctx.measureText(mk.label).width
        const roomR = x0 + pw - 2 - (x + r + 3), roomL = (x - r - 3) - (x0 + 2)
        const right = roomR >= tw || roomR >= roomL
        const up = y - 2 - (FSs + 2) >= y0 || (y + 2 + FSs + 2 > y0 + ph)
        const lx = right ? x + r + 3 : x - r - 3, ly = up ? y - 2 : y + 2
        ctx.textAlign = right ? 'left' : 'right'; ctx.textBaseline = up ? 'bottom' : 'top'
        ctx.lineWidth = 3; ctx.strokeStyle = pal.halo; ctx.strokeText(mk.label, lx, ly)
        ctx.fillStyle = pal.text; ctx.fillText(mk.label, lx, ly)
      }
    }
    ctx.restore()

    // 图框线
    ctx.strokeStyle = pal.frame; ctx.lineWidth = 1
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(pw) - 1, Math.round(ph) - 1)

    // 刻度：方位每 45°，俯仰每 30°；0/90/180/270 下方淡标本体轴，±90 左侧淡标 ±Z
    ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    const AX = { 0: '+X', 90: '+Y', 180: '−X', 270: '−Y', 360: '+X' }
    for (let a = 0; a <= 360; a += 45) {
      const x = X(a)
      ctx.strokeStyle = pal.frame; ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y0 + ph); ctx.lineTo(Math.round(x) + 0.5, y0 + ph + 4); ctx.stroke()
      ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.fillText(String(a), x, y0 + ph + 6)
      if (AX[a]) { ctx.fillStyle = pal.faint; ctx.font = font(FSs); ctx.fillText(AX[a], x, y0 + ph + 6 + FS + 3) }
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    for (let e = -90; e <= 90; e += 30) {
      const y = Y(e)
      ctx.strokeStyle = pal.frame; ctx.beginPath(); ctx.moveTo(x0 - 4, Math.round(y) + 0.5); ctx.lineTo(x0, Math.round(y) + 0.5); ctx.stroke()
      ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.fillText(String(e).replace('-', '−'), x0 - 6, y)
      if (e === 90 || e === -90) {
        const w = ctx.measureText(String(e).replace('-', '−')).width
        ctx.fillStyle = pal.faint; ctx.font = font(FSs); ctx.fillText(e > 0 ? '+Z' : '−Z', x0 - 10 - w, y)
      }
    }
    // 轴题
    ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText('方位 az (°)', x0 + pw / 2, H - (forExport ? 4 : 2))
    ctx.save(); ctx.translate(forExport ? 14 : 11, y0 + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('俯仰 el (°)', 0, 0); ctx.restore()

    // 色标条（净空模式）
    if (withBar) this._drawBar(ctx, pal, im.scale, x0 + pw + (forExport ? 18 : 14), y0, forExport ? 14 : 10, ph, font, FS, forExport)

    // 悬停：格子高亮 + 读数框
    if (!forExport && this.hover && this.data) this._drawHover(ctx, pal, lay, font, FS, W, H)
    ctx.restore()
    return lay
  }

  _drawBar(ctx, pal, sc, x, y, w, h, font, FS, forExport) {
    const n = 64
    for (let i = 0; i < n; i++) {
      const c = rampAt(pal.ramp, 1 - (i + 0.5) / n)   // 上端 = 远（t=1），下端 = 近（t=0）
      ctx.fillStyle = `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
      ctx.fillRect(x, y + (i / n) * h, w, h / n + 0.6)
    }
    ctx.strokeStyle = pal.frame; ctx.lineWidth = 1; ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h) - 1)
    ctx.fillStyle = pal.muted; ctx.font = font(FS - 1); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    for (const v of sc.ticks) {
      const yy = y + (1 - sc.t(v)) * h
      ctx.strokeStyle = pal.frame; ctx.beginPath(); ctx.moveTo(x + w, Math.round(yy) + 0.5); ctx.lineTo(x + w + 3, Math.round(yy) + 0.5); ctx.stroke()
      ctx.fillText(fmtTick(v), x + w + 5, yy)
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText('m', x + w / 2, y - (forExport ? 4 : 2))
  }

  _drawHover(ctx, pal, lay, font, FS, W, H) {
    const hv = this.hover
    // 光标在图框最右半格（az ∈ [359.5, 360]）：数据仍是第 0 列，但高亮与读数框跟着光标画在右端（位图多补的那一列），
    // 不跳到图框最左边、离光标一整幅宽
    const azPos = hv.wrapRight ? 360 : hv.az
    const x = lay.X(azPos - 0.5), y = lay.Y(hv.el + 0.5)
    const cw = lay.pw / 360, ch = lay.ph / 180
    ctx.strokeStyle = pal.hi; ctx.lineWidth = 1.5
    ctx.strokeRect(x - 0.5, y - 0.5, Math.max(3, cw) + 1, Math.max(3, ch) + 1)
    const lines = ['az ' + hv.az + '°  ·  el ' + String(hv.el).replace('-', '−') + '°']
    if (hv.blocked) {
      if (hv.clearanceM != null) lines.push(fmtM(hv.clearanceM) + ' m')
      if (hv.node) lines.push(hv.node)
    }
    ctx.font = font(FS)
    const tw = Math.max(...lines.map((s) => ctx.measureText(s).width)) + 16, th = lines.length * (FS + 5) + 10
    let bx = lay.X(azPos) + 14, by = lay.Y(hv.el) + 14
    if (bx + tw > W - 2) bx = lay.X(azPos) - 14 - tw
    if (by + th > H - 2) by = lay.Y(hv.el) - 14 - th
    ctx.fillStyle = pal.tipBg; ctx.strokeStyle = pal.tipBorder; ctx.lineWidth = 1
    ctx.beginPath(); ctx.rect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(tw), Math.round(th)); ctx.fill(); ctx.stroke()
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'
    lines.forEach((s, i) => { ctx.fillStyle = i ? pal.muted : pal.text; ctx.fillText(s, bx + 8, by + 6 + i * (FS + 5)) })
  }

  _move(e) {
    const lay = this._layout
    if (!lay || !this.data) return
    const r = this._cv.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    if (px < lay.x0 || px > lay.x0 + lay.pw || py < lay.y0 || py > lay.y0 + lay.ph) { this._leave(); return }
    const az = ((px - lay.x0) / lay.pw) * 360, el = 90 - ((py - lay.y0) / lay.ph) * 180
    const idx = maskIndex(azElToDir(az, el))
    if (idx < 0) return
    const cell = maskCell(idx)
    const azI = cell.az, elI = cell.el
    // 最右半格取整回到第 0 列：记下光标实际在右端，画高亮 / 读数框用（下标仍是 0）
    const wrapRight = azI === 0 && az >= 359.5
    if (this.hover && this.hover.idx === idx && this.hover.wrapRight === wrapRight) return
    const d = this.data
    const b = d.blocked[idx] ? 1 : 0
    const cv = d.clearance ? d.clearance[idx] : NaN
    const nodeI = d.hitNode ? d.hitNode[idx] : -1
    this.hover = { az: azI, el: elI, idx, blocked: b, clearanceM: b && Number.isFinite(cv) ? cv : null, node: b && nodeI >= 0 && d.nodeNames ? (d.nodeNames[nodeI] || null) : null, wrapRight }
    if (this.onHover) { const { wrapRight: _w, ...info } = this.hover; this.onHover(info) }
    this.draw()
  }
  _leave() {
    if (!this.hover) return
    this.hover = null
    if (this.onHover) this.onHover(null)
    this.draw()
  }

  /** 出图画布（逻辑 width × 自适应高 × scale；缺省 880 宽、4 倍，白底印刷色 + 报告字体） */
  toCanvas(o = {}) {
    const scale = o.scale || 4, W = o.width || 880
    const m = this._margins(true, this.mode === 'clearance' && !!(this.data && this.data.clearance), !!o.title)
    const H = o.height || Math.round((W - m.l - m.r) / 2 + m.t + m.b)
    const cv = document.createElement('canvas')
    cv.width = Math.round(W * scale); cv.height = Math.round(H * scale)
    const ctx = cv.getContext('2d')
    ctx.scale(scale, scale)
    const hv = this.hover; this.hover = null
    this.drawTo(ctx, W, H, true, { title: o.title })
    this.hover = hv
    return cv
  }
  /** → Promise<Blob>（image/png）；落盘由宿主走 window.api.exportFile */
  exportPng(o = {}) {
    const cv = this.toCanvas(o)
    return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 失败'))), 'image/png'))
  }

  // 只摘 DOM / 观察器 / 监听，数据、叠加与格子位图留着（mount 换容器用）
  _detach() {
    if (this.hover && this.onHover) this.onHover(null)
    if (this._raf && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this._raf)
    this._raf = 0
    if (this._ro) { this._ro.disconnect(); this._ro = null }
    if (this._mo) { this._mo.disconnect(); this._mo = null }
    if (this._cv) {
      this._cv.removeEventListener('pointermove', this._onMove)
      this._cv.removeEventListener('pointerleave', this._onLeave)
      if (this._cv.parentNode) this._cv.parentNode.removeChild(this._cv)
      this._cv.width = 0; this._cv.height = 0
    }
    this._cv = null; this._el = null; this._layout = null; this.hover = null
    this._cssW = 0; this._cssH = 0
  }
  dispose() {
    this._detach()
    this._img = null; this._imgKey = ''; this.data = null
  }
}
