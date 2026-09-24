// 多序列时间线（canvas；框架无关的类，Vue 组件包一层即可）：太阳翼功率 W、星侧太阳侵入 ΔT K / ΔG/T dB、万向节角度 / 角速率。
//
// 形式（dataviz 口径 + map2/timeline-ui.md §1.10 的建议）：
//   · 一幅图 = 竖排的若干「格」（small multiples），共用一条时间轴；每格一根纵轴、至多三条线。
//     量纲不同的量（功率与相对值、角度与角速率、ΔT 与 ΔG/T）一律分格，不做双纵轴。
//   · 线色取 lbPlotTheme 的三槽分类色（亮 / 暗两套经校验），第 2、3 条再叠虚线 / 点线作二级编码；文字一律用文字色，不染线色。
//   · 灰带（bands）标区段、不写字：地影 = 中性实底淡带，遮挡 = 45° 斜纹，超限 = 135° 斜纹（色觉无关，靠纹理区分）。
//   · 状态条（strips）贴在最下一格下面：语义色（--ok / --danger）+ 实底 / 斜纹二级编码，如万向节「可跟踪 / 超限 / 落进掩模」。
//     条上不写字；要图例由宿主给 label（运行时数据以外的判定字样不进图，CLAUDE.md「结果只出数字」）。
//   · 竖标（marks）：峰值角速率时刻、最坏 ΔG/T 时刻；可带一个数字标签。
//   · 横轴：按显示时区（shared/tz.js 三档）对齐整点 / 整日的日历阶梯刻度（抽自 ConstellationMap3D.computeTicks 同一套阶梯），
//     日界刻度加深；窗口里没有日界时首个标签带日期。
//   · 纵轴：按当前时窗里的数据定尺度（窗外的峰不压扁窗内曲线；p.fitAll 改按全部样本）；步长极小（< 1e−6 量级）时刻度改科学计数。
//   · 悬停：十字竖线贯穿各格 + 各线最近样本点 + 画布内读数框（时刻 + 各线数值）+ onHover 回调。
//     读数框放在十字线左 / 右、各格顶 / 底几个候选里压线最少的那个（placeTip），不固定贴右上盖住光标右边的走势。
//   · 屏上 / 导出同一个 drawTo（RainPlot 两档）：屏上字体 uiFontStack、配色读 CSS 变量随主题；导出白底、报告字体、4 倍。
// ★ 为什么是 canvas 而不是摘要报告 timeline-ui.md §0 推荐的「CiSeriesPlot 骨架的 SVG + exportSvgPng」：
//   ① 要做成框架无关的类（mount / setData / resize / dispose），CiSeriesPlot 是 Vue 模板里的 SVG；
//   ② 与 MaskChart 共用同一套 drawTo 两档（屏上 / 导出），导出按倍率在大画布上重画位图与线（lb-export-png-resolution 口径），
//      不走「SVG 光栅化」；③ 一天 1 min 采样 × 数条线 × 数格，SVG 节点数与悬停重绘都比 canvas 贵。
//   导出缺省 4 倍（与报告位图层同倍率；C/I 图的 6 倍是 SVG 光栅化的取值，这里不照搬），宿主可传 scale。
// 数据：时间一律绝对毫秒（UTC 纪元）；非有限值断线。点数远多于像素时按像素列取 min/max 抽稀（形状不丢尖峰）。
import { uiFontStack, DOC_FONT_STACK } from '../../shared/lbFont.js'
import { SERIES_LIGHT, SERIES_DARK, isDark } from '../../shared/lbPlotTheme.js'
import { tzOffMin, tzParts, tzTag, normTzMode } from '../../shared/tz.js'

// ───────────────────────────── 纯函数（单测直接用） ─────────────────────────────

/** 「整齐」时间刻度阶梯（秒）：与 3D 页时间条 computeTicks 的 NICE 同一份 */
export const NICE_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 345600, 604800]
const modNear = (x, y) => x - y * Math.round(x / y)
const p2 = (n) => String(n).padStart(2, '0')

/** 跨度超过它（秒）时主刻度只落日界：与 fmtTimeTick「> 4 天只显日期」同一条线 */
export const DAY_ONLY_SPAN_S = 4 * 86400

/**
 * 时间刻度：日历阶梯 + 每约 minPx 像素一个主刻度 + 按显示时区的午夜对齐 + 次刻度。
 * ★ 对齐基准取「左端所在日、该档位墙钟 00:00」：UTC 档若仍按本地午夜对齐，刻度会落在非整点上。
 * ★ 跨度 > 4 天时步长下限钳到 1 天：此时标签只显日期（fmtTimeTick），12 h 步长会让 12:00 刻度也标成日期——
 *   标签成对重复、12:00 被读成日界。钳住后主刻度全落日界，12 h 退为次刻度。
 * @returns {{ step:number(s), sub:number(s), major:{ms:number, day:boolean}[], minor:number[] }}
 */
export function timeTicks(t0, t1, trackPx, tzMode, o = {}) {
  const mode = normTzMode(tzMode, 'local')
  const minPx = o.minPx || 80
  const span = Math.max(1e-3, (t1 - t0) / 1000)
  const off = tzOffMin(mode, t0) * 60000
  const d = new Date(t0 + off)
  const epoch = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - off) / 1000
  const start = t0 / 1000 - epoch, end = start + span
  const ideal = span / Math.max(1, trackPx / minPx)
  let step = NICE_STEPS_S.find((s) => s >= ideal) || Math.ceil(ideal / 604800) * 604800
  if (span > DAY_ONLY_SPAN_S && step < 86400) step = 86400
  let sub = 0
  const mi = NICE_STEPS_S.indexOf(step)
  for (let i = mi - 1; i >= 0; i--) if (Math.abs(modNear(step, NICE_STEPS_S[i])) < 1e-6) { sub = NICE_STEPS_S[i]; break }
  const major = [], minor = []
  for (let t = Math.ceil(start / step - 1e-9) * step; t <= end + 1e-6; t += step) {
    const ms = Math.round((epoch + t) * 1000)
    const q = tzParts(ms, mode)
    major.push({ ms, day: q.h === 0 && q.mi === 0 && q.s === 0 })
  }
  if (sub && trackPx * (sub / span) >= 6) {
    for (let t = Math.ceil(start / sub - 1e-9) * sub; t <= end + 1e-6; t += sub) {
      if (Math.abs(modNear(t, step)) < 1e-6) continue
      minor.push(Math.round((epoch + t) * 1000))
    }
  }
  return { step, sub, major, minor }
}

/**
 * 刻度标签：窗口 > 4 天只显日期；2 h – 4 天整日显日期、其余 HH:MM；≤ 2 h 显 HH:MM:SS（与 3D 页 fmtTick 同档）。
 * > 4 天时 timeTicks 的主刻度全落日界（步长下限 1 天），标签不会重复。
 */
export function fmtTimeTick(ms, spanMs, tzMode) {
  const q = tzParts(ms, normTzMode(tzMode, 'local'))
  const wMin = spanMs / 60000
  const mid = q.h === 0 && q.mi === 0 && q.s === 0
  if (wMin > DAY_ONLY_SPAN_S / 60) return `${p2(q.mo)}-${p2(q.d)}`
  if (wMin > 120) return mid ? `${p2(q.mo)}-${p2(q.d)}` : `${p2(q.h)}:${p2(q.mi)}`
  return `${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`
}
/** 读数用完整时刻：YYYY-MM-DD HH:MM:SS 角标 */
export function fmtTimeFull(ms, tzMode) {
  const mode = normTzMode(tzMode, 'local')
  const q = tzParts(ms, mode)
  return `${q.y}-${p2(q.mo)}-${p2(q.d)} ${p2(q.h)}:${p2(q.mi)}:${p2(q.s)} ${tzTag(mode, ms)}`
}

/**
 * 纵轴整齐刻度。angle=true 走角度阶梯（…5/10/15/30/45/90°），否则 1/2/5×10^k。
 * @returns {{lo, hi, step, ticks:number[], dec:number}}
 */
export function niceScale(lo, hi, n = 5, o = {}) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1 }
  if (hi < lo) [lo, hi] = [hi, lo]
  if (hi - lo < 1e-12) { const pad = Math.abs(lo) > 1e-12 ? Math.abs(lo) * 0.1 : 1; lo -= pad; hi += pad }
  const raw = (hi - lo) / Math.max(1, n)
  let step
  if (o.angle && raw >= 1) {
    step = [1, 2, 5, 10, 15, 30, 45, 90, 180].find((s) => s >= raw) || 180
  } else {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p
    step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
  }
  const a = Math.floor(lo / step + 1e-9) * step, b = Math.ceil(hi / step - 1e-9) * step
  const ticks = []
  for (let v = a; v <= b + step * 1e-6; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : +v.toPrecision(12))
  return { lo: a, hi: b, step, ticks, dec: stepDecimals(step) }
}
/**
 * 能精确表示 step 的最少小数位（2.5 → 1、0.25 → 2、0.05 → 2、5e−10 → 10）。
 * ★ 相对容差：绝对容差 1e−6 在步长 < 1e−6 时于 d=0 就判「整数」，刻度全标成 0（远旁瓣 ΔG/T 只有 1e−7 dB 量级时就是这样）。
 */
export function stepDecimals(step) {
  const a = Math.abs(step)
  if (!(a > 0) || !Number.isFinite(a)) return 0
  for (let d = 0; d <= 15; d++) {
    const s = a * Math.pow(10, d), k = Math.round(s)
    if (k >= 1 && Math.abs(k - s) < 1e-9 * s) return d
  }
  return 15
}

/**
 * 数值 → 刻度 / 读数文字（负号 U+2212）。dec ≤ 6 走定点；更细（步长 < 1e−6 量级）改科学计数「1.5e−9」，
 * 尾数位数按该值的量级从 dec 折算（至多 6 位），保证相邻刻度可分。
 */
export function fmtValue(v, dec) {
  if (!Number.isFinite(v)) return '—'
  const dc = Number.isFinite(dec) ? Math.max(0, Math.round(dec)) : 0
  if (dc <= 6) return MINUS(v.toFixed(dc))
  if (v === 0) return '0'
  const e = +v.toExponential().split('e')[1]
  const [m, x] = v.toExponential(Math.max(0, Math.min(6, dc + e))).split('e')
  return MINUS(m) + 'e' + x.replace('+', '').replace('-', '−')
}

/** 有序数组里离 x 最近的下标（二分；空数组 −1） */
export function nearestIndex(t, x) {
  const n = t ? t.length : 0
  if (!n) return -1
  let lo = 0, hi = n - 1
  if (x <= t[0]) return 0
  if (x >= t[hi]) return hi
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] <= x) lo = m; else hi = m }
  return x - t[lo] <= t[hi] - x ? lo : hi
}

/**
 * 抽稀成画线用的像素折线：按像素列取「首 / 最小 / 最大 / 末」（M4），非有限值与 wrap 跳变处断开。
 * @returns {Array<Array<[x,y]>>}  各连续段（像素坐标）
 */
export function polylineSegments(t, y, X, Y, o = {}) {
  const n = Math.min(t.length, y.length)
  const wrapHalf = Number.isFinite(o.wrap) && o.wrap > 0 ? o.wrap / 2 : Infinity
  const gapMs = Number.isFinite(o.gapMs) && o.gapMs > 0 ? o.gapMs : Infinity
  const segs = []
  let cur = null, col = null, prevY = NaN, prevT = NaN
  const flushCol = () => {
    if (!col) return
    const pts = [[col.x, col.first]]
    if (col.n > 1) {
      // 首 / 极值 / 末：极值按出现先后放，保持折线走向
      const ex = col.iMin < col.iMax ? [col.min, col.max] : [col.max, col.min]
      for (const v of ex) if (v !== pts[pts.length - 1][1]) pts.push([col.x, v])
      if (col.last !== pts[pts.length - 1][1]) pts.push([col.x, col.last])
    }
    for (const p of pts) cur.push(p)
    col = null
  }
  for (let i = 0; i < n; i++) {
    const yi = y[i], ti = t[i]
    if (!Number.isFinite(yi) || !Number.isFinite(ti)) { flushCol(); if (cur && cur.length) segs.push(cur); cur = null; prevY = NaN; continue }
    if (cur && (Math.abs(yi - prevY) > wrapHalf || ti - prevT > gapMs)) { flushCol(); if (cur.length) segs.push(cur); cur = null }
    if (!cur) cur = []
    const px = X(ti), py = Y(yi), xc = Math.round(px)
    if (col && col.xc === xc) {
      col.n++; col.last = py
      if (py < col.min) { col.min = py; col.iMin = col.n }
      if (py > col.max) { col.max = py; col.iMax = col.n }
    } else {
      flushCol()
      col = { xc, x: px, first: py, last: py, min: py, max: py, iMin: 0, iMax: 0, n: 1 }
    }
    prevY = yi; prevT = ti
  }
  flushCol()
  if (cur && cur.length) segs.push(cur)
  return segs
}

/** 有序数组里第一个 ≥ x 的下标（全都 < x 返回 n） */
function lowerBound(t, x) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m } return lo }

/**
 * 一条序列在时窗 [t0, t1] 里的取值范围（纵轴定尺度用）：窗内样本 + 两端边界上的线性插值
 * （窗外样本不算——缩放到一段时窗时，窗外的峰不该把窗内曲线压扁；边界插值保证贴边那一截线也在轴内）。
 * 跨 wrap 回绕 / 超 gapMs 间隔 / 非有限值的相邻两点不插值（画线时那里本来就断开）。
 * @returns {[lo, hi]}（无有效值时 [Infinity, −Infinity]）
 */
export function seriesRange(t, y, t0, t1, o = {}) {
  const n = Math.min(t ? t.length : 0, y ? y.length : 0)
  let lo = Infinity, hi = -Infinity
  const take = (v) => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v } }
  if (!n) return [lo, hi]
  const i0 = lowerBound(t, t0)
  let i1 = lowerBound(t, t1)
  if (i1 < n && t[i1] === t1) i1++
  for (let i = i0; i < Math.min(i1, n); i++) take(y[i])
  const wrapHalf = Number.isFinite(o.wrap) && o.wrap > 0 ? o.wrap / 2 : Infinity
  const gapMs = Number.isFinite(o.gapMs) && o.gapMs > 0 ? o.gapMs : Infinity
  const lerpAt = (a, b, x) => {
    if (a < 0 || b >= n) return
    const ya = y[a], yb = y[b], ta = t[a], tb = t[b]
    if (!Number.isFinite(ya) || !Number.isFinite(yb) || !(tb > ta) || tb - ta > gapMs || Math.abs(yb - ya) > wrapHalf) return
    take(ya + (yb - ya) * (x - ta) / (tb - ta))
  }
  lerpAt(i0 - 1, i0, t0)            // 左边界：窗外最后一点与窗内第一点之间
  lerpAt(i1 - 1, i1, t1)            // 右边界：窗内最后一点与窗外第一点之间
  return [lo, hi]
}

/** 线段 pq 落在矩形 [xa,xb]×[ya,yb] 里的长度（Liang–Barsky 裁剪） */
function clipLen(p, q, xa, xb, ya, yb) {
  const dx = q[0] - p[0], dy = q[1] - p[1]
  const P = [-dx, dx, -dy, dy], Q = [p[0] - xa, xb - p[0], p[1] - ya, yb - p[1]]
  let t0 = 0, t1 = 1
  for (let k = 0; k < 4; k++) {
    if (P[k] === 0) { if (Q[k] < 0) return 0; continue }
    const r = Q[k] / P[k]
    if (P[k] < 0) { if (r > t1) return 0; if (r > t0) t0 = r } else { if (r < t0) return 0; if (r < t1) t1 = r }
  }
  return (t1 - t0) * Math.hypot(dx, dy)
}
/** 一组像素折线压在矩形 r={x,y,w,h} 里的总长度（孤点按 2 px 计）——读数框放哪儿挡线最少就看它 */
export function inkInRect(r, polylines) {
  const xa = r.x, xb = r.x + r.w, ya = r.y, yb = r.y + r.h
  let s = 0
  for (const pl of polylines || []) {
    if (pl.length === 1) { const p = pl[0]; if (p[0] >= xa && p[0] <= xb && p[1] >= ya && p[1] <= yb) s += 2; continue }
    for (let i = 1; i < pl.length; i++) {
      const p = pl[i - 1], q = pl[i]
      if ((p[0] < xa && q[0] < xa) || (p[0] > xb && q[0] > xb) || (p[1] < ya && q[1] < ya) || (p[1] > yb && q[1] > yb)) continue
      s += clipLen(p, q, xa, xb, ya, yb)
    }
  }
  return s
}

/**
 * 悬停读数框的位置：十字线左 / 右 × 各格顶 / 底（及整块图区顶 / 底）几个候选，挑压线最少的一个。
 * 同分时偏右、偏上；上一帧的位置有 8 px 的粘滞（光标挪一点框不来回跳）。
 * @param o { x:十字线像素, tw, th, W, H, top, bottom, panels:[{top,h}], ink:像素折线[], prev?:上次的 key }
 * @returns {{ x, y, key, cost }}
 */
export function placeTip(o) {
  const gapX = 14, pad = 4
  const xs = [['R', o.x + gapX], ['L', o.x - gapX - o.tw]].filter(([, bx]) => bx >= 2 && bx + o.tw <= o.W - 2)
  if (!xs.length) xs.push(['R', Math.max(2, Math.min(o.W - 2 - o.tw, o.x + gapX))])
  const ys = [['T', o.top + pad], ['B', o.bottom - o.th - pad]]
  ;(o.panels || []).forEach((P, i) => {
    if (o.th > P.h - 2 * pad) return
    ys.push(['P' + i + 't', P.top + pad], ['P' + i + 'b', P.top + P.h - o.th - pad])
  })
  let best = null
  xs.forEach(([sx, bx], ix) => ys.forEach(([sy, by0], iy) => {
    const by = Math.max(2, Math.min(o.H - 2 - o.th, by0))
    const key = sx + sy
    let cost = inkInRect({ x: bx - 3, y: by - 3, w: o.tw + 6, h: o.th + 6 }, o.ink) + ix * 1 + iy * 0.25
    if (key === o.prev) cost -= 8
    if (!best || cost < best.cost) best = { x: bx, y: by, key, cost }
  }))
  return best
}

// ───────────────────────────── 配色 ─────────────────────────────
function cssVar(cs, n, f) { const v = cs ? (cs.getPropertyValue(n) || '').trim() : ''; return v || f }
function paletteOf(forExport) {
  if (forExport) {
    return { bg: '#ffffff', text: '#1a1a1a', muted: '#4a4a46', faint: '#77776f', grid: '#e6e5e0', frame: '#8e8d85',
      shade: '#e9e8e3', hatch: '#a9a8a0', ok: '#1d7a52', danger: '#a32d2d', series: SERIES_LIGHT, cross: '#4a4a46',
      tipBg: '#ffffff', tipBorder: '#adaca4', ring: '#ffffff', ref: '#77776f' }
  }
  let cs = null
  try { cs = getComputedStyle(document.documentElement) } catch { /* 无 DOM */ }
  const dark = isDark()
  return {
    bg: 'transparent',
    text: cssVar(cs, '--text', dark ? '#ececea' : '#1a1a1a'),
    muted: cssVar(cs, '--text-muted', dark ? '#a4a49e' : '#6b6b66'),
    faint: cssVar(cs, '--text-faint', dark ? '#82817a' : '#86867f'),
    grid: cssVar(cs, '--border', dark ? '#3f3f39' : '#d3d2cc'),
    frame: cssVar(cs, '--border-strong', dark ? '#5c5b54' : '#adaca4'),
    shade: cssVar(cs, '--surface-2', dark ? '#333330' : '#e4e3de'),
    hatch: cssVar(cs, '--text-faint', dark ? '#82817a' : '#86867f'),
    ok: cssVar(cs, '--ok', dark ? '#4caf82' : '#1d7a52'),
    danger: cssVar(cs, '--danger', dark ? '#e26a6a' : '#a32d2d'),
    series: dark ? SERIES_DARK : SERIES_LIGHT,
    cross: cssVar(cs, '--text-muted', dark ? '#a4a49e' : '#6b6b66'),
    tipBg: cssVar(cs, '--bg', dark ? '#1c1c1a' : '#ffffff'),
    tipBorder: cssVar(cs, '--border-strong', dark ? '#5c5b54' : '#adaca4'),
    ring: cssVar(cs, '--bg', dark ? '#1c1c1a' : '#ffffff'),
    ref: cssVar(cs, '--text-faint', dark ? '#82817a' : '#86867f')
  }
}
const DASHES = [[], [7, 4], [2, 3]]
const BAND_KIND = { eclipse: 'shade', shade: 'shade', blocked: 'hatch', hatch: 'hatch', limit: 'hatch2', hatch2: 'hatch2' }
const MINUS = (s) => s.replace(/^-/, '−')

const fmtVal = fmtValue

// ───────────────────────────── 图类 ─────────────────────────────
export class TimelineChart {
  /**
   * @param o { tz?: 'local'|'utc'|number, onHover?: (info|null)=>void, height?: 'auto'|'fill'|number, panelHeight?: number(缺省 120) }
   *   info = { tMs, rows:[{ panel, series, value, unit }] }
   */
  constructor(o = {}) {
    this.tz = normTzMode(o.tz, 'local')
    this.onHover = typeof o.onHover === 'function' ? o.onHover : null
    this.height = o.height === 'fill' || Number.isFinite(o.height) ? o.height : 'auto'
    this.panelHeight = o.panelHeight || 120
    this.data = null
    this.hover = null
    this._el = null; this._cv = null; this._ro = null; this._mo = null; this._raf = 0
    this._cssW = 0; this._cssH = 0; this._dpr = 1
    this._layout = null
    this._tipKey = ''
    this._onMove = (e) => this._move(e)
    this._onLeave = () => this._leave()
  }

  /** 挂到容器上。已挂在别处时先摘下（数据保留：弹出大图 / 换页签 / KeepAlive 复用后不必重新 setData） */
  mount(el) {
    if (this._el) this._detach()
    this._el = el
    const cv = document.createElement('canvas')
    cv.style.cssText = 'display:block;width:100%;'
    cv.setAttribute('role', 'img')
    el.appendChild(cv)
    this._cv = cv
    cv.addEventListener('pointermove', this._onMove)
    cv.addEventListener('pointerleave', this._onLeave)
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(el) }
    if (typeof MutationObserver !== 'undefined') {
      this._mo = new MutationObserver(() => this.draw())
      this._mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    }
    this.resize()
    return this
  }

  /**
   * data = {
   *   t0, t1,                         横轴范围（ms）；缺省取数据首末
   *   t?,                             各格共用的时刻数组（ms，升序）；序列可自带 t 覆盖
   *   panels: [{ title:'功率 (W)', unit?:'W', dec?:读数小数位（刻度按步长自定）, yMin?, yMax?, zero?:bool, angle?:bool, weight?:1,
   *              series:[{ name, y, t?, slot?:0..2, wrap?:360, gapMs? }],
   *              refLines?:[{ y, label? }] }],
   *   bands?:  [{ t0, t1, kind:'eclipse'|'blocked'|'limit' }],
   *   strips?: [{ label?, segs:[{ t0, t1, style:'ok'|'bad'|'badHatch'|'neutral' }] }],
   *   marks?:  [{ t, panel?:格下标（缺省全部）, label? }]
   * }
   */
  setData(data) {
    this.data = data && Array.isArray(data.panels) && data.panels.length ? data : null
    this.hover = null
    this._tipKey = ''
    this._cssW = 0
    this.resize()
  }
  setTz(mode) { this.tz = normTzMode(mode, this.tz); this.draw() }

  _range() {
    const d = this.data
    let t0 = Number.isFinite(d.t0) ? d.t0 : Infinity, t1 = Number.isFinite(d.t1) ? d.t1 : -Infinity
    if (!Number.isFinite(d.t0) || !Number.isFinite(d.t1)) {
      const scan = (t) => { if (t && t.length) { if (!Number.isFinite(d.t0)) t0 = Math.min(t0, t[0]); if (!Number.isFinite(d.t1)) t1 = Math.max(t1, t[t.length - 1]) } }
      scan(d.t)
      for (const p of d.panels) for (const s of p.series || []) scan(s.t)
    }
    if (!(t1 > t0)) { t0 = Number.isFinite(t0) ? t0 : 0; t1 = t0 + 3600000 }
    return [t0, t1]
  }

  _metrics(forExport, titled) {
    const k = forExport ? 1.25 : 1
    const nStrip = this.data && Array.isArray(this.data.strips) ? this.data.strips.length : 0
    return {
      k, l: Math.round(58 * k), r: Math.round(16 * k), t: Math.round((titled ? 30 : 6) * k),
      head: Math.round(20 * k), gap: Math.round(10 * k), strip: Math.round(10 * k), stripGap: Math.round(4 * k), nStrip,
      axis: Math.round(38 * k)
    }
  }
  _naturalHeight(forExport, titled, panelH) {
    if (!this.data) return 120
    const m = this._metrics(forExport, titled)
    const ph = panelH || this.panelHeight
    let h = m.t
    this.data.panels.forEach((p, i) => { h += m.head + ph * (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1) + (i ? m.gap : 0) })
    if (m.nStrip) h += m.gap + m.nStrip * (m.strip + m.stripGap)
    return h + m.axis
  }

  resize() {
    if (!this._cv || !this._el) return
    this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
    const w = Math.max(280, this._el.clientWidth || 0)
    const h = this.height === 'fill' ? Math.max(120, this._el.clientHeight || 0)
      : Number.isFinite(this.height) ? this.height : Math.round(this._naturalHeight(false, false))
    if (w === this._cssW && h === this._cssH && this._cv.width === Math.round(w * this._dpr)) { this.draw(); return }
    this._cssW = w; this._cssH = h
    this._cv.width = Math.round(w * this._dpr); this._cv.height = Math.round(h * this._dpr)
    this._cv.style.height = this.height === 'fill' ? '100%' : h + 'px'
    this.draw()
  }

  draw() {
    if (!this._cv || this._raf) return
    const go = () => {
      this._raf = 0
      const ctx = this._cv.getContext('2d')
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0)
      this._layout = this.drawTo(ctx, this._cssW, this._cssH, false)
    }
    if (typeof requestAnimationFrame !== 'undefined') this._raf = requestAnimationFrame(go)
    else go()
  }

  /** 屏上 / 导出同一个画法；返回布局（悬停换算用）。opt = { title? } */
  drawTo(ctx, W, H, forExport, opt = {}) {
    const pal = paletteOf(forExport)
    const stack = forExport ? DOC_FONT_STACK : uiFontStack()
    const m = this._metrics(forExport, !!opt.title)
    const FS = forExport ? 13 : 11, FSs = forExport ? 12 : 10.5
    const LW = forExport ? 2.2 : 2
    const font = (px, w) => (w ? w + ' ' : '') + px + 'px ' + stack
    ctx.save()
    ctx.clearRect(0, 0, W, H)
    if (forExport) { ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H) }
    const d = this.data
    if (!d) { ctx.restore(); return null }
    const [t0, t1] = this._range()
    // 左边距按最宽的纵轴刻度量出来（数值位数随数据变）
    ctx.font = font(FS)
    const scales = d.panels.map((p) => this._yScale(p, d, t0, t1))
    let lw = 0
    for (const s of scales) for (const v of s.ticks) lw = Math.max(lw, ctx.measureText(fmtVal(v, s.dec)).width)
    const x0 = Math.max(m.l, Math.ceil(lw + 14 * m.k)), x1 = W - m.r, pw = Math.max(20, x1 - x0)
    const X = (t) => x0 + ((t - t0) / (t1 - t0)) * pw
    // 各格纵向分配：可用高度按 weight 摊
    const nP = d.panels.length
    const stripsH = m.nStrip ? m.gap + m.nStrip * (m.strip + m.stripGap) : 0
    const avail = H - m.t - m.axis - stripsH - nP * m.head - (nP - 1) * m.gap
    const wsum = d.panels.reduce((a, p) => a + (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1), 0)
    let y = m.t
    const panels = d.panels.map((p, i) => {
      if (i) y += m.gap
      const top = y + m.head
      const h = Math.max(24, (avail * (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1)) / wsum)
      y = top + h
      const sc = scales[i]
      return { p, top, h, sc, Y: (v) => top + h - ((v - sc.lo) / (sc.hi - sc.lo)) * h }
    })
    const plotBottom = y
    const strips = []
    if (m.nStrip) {
      y += m.gap
      for (const s of d.strips) { strips.push({ s, top: y, h: m.strip }); y += m.strip + m.stripGap }
    }
    const axisY = strips.length ? y - m.stripGap : plotBottom
    const ticks = timeTicks(t0, t1, pw, this.tz, { minPx: forExport ? 90 : 80 })

    if (opt.title) {
      ctx.fillStyle = pal.text; ctx.font = font(forExport ? 15 : 13, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      ctx.fillText(opt.title, x0, m.t - 12 * m.k)
    }

    // 灰带（每格与状态条区域内各画一遍，格间留白不画）
    const bandRects = [...panels.map((P) => [P.top, P.h]), ...strips.map((S) => [S.top, S.h])]
    for (const b of d.bands || []) {
      const kind = BAND_KIND[b && b.kind] || 'shade'
      const bx0 = Math.max(x0, X(b.t0)), bx1 = Math.min(x1, X(b.t1))
      if (!(bx1 > bx0)) continue
      for (const [ry, rh] of bandRects) this._band(ctx, kind, bx0, ry, bx1 - bx0, rh, pal, m.k)
    }

    // 竖网格（主刻度，贯穿各格）
    ctx.lineWidth = 1
    for (const P of panels) {
      ctx.strokeStyle = pal.grid
      ctx.beginPath()
      for (const tk of ticks.major) { const x = Math.round(X(tk.ms)) + 0.5; if (x < x0 || x > x1) continue; ctx.moveTo(x, P.top); ctx.lineTo(x, P.top + P.h) }
      ctx.stroke()
    }

    // 各格（画线的同时把像素折线收进 ink：悬停读数框按它挑压线最少的位置）
    const ink = []
    panels.forEach((P, pi) => {
      const p = P.p, sc = P.sc
      // 横网格 + 纵轴刻度（线宽每格重设：上一格画线时改过）
      ctx.lineWidth = 1; ctx.setLineDash([])
      ctx.strokeStyle = pal.grid; ctx.beginPath()
      for (const v of sc.ticks) { const yy = Math.round(P.Y(v)) + 0.5; ctx.moveTo(x0, yy); ctx.lineTo(x1, yy) }
      ctx.stroke()
      ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
      for (const v of sc.ticks) ctx.fillText(fmtVal(v, sc.dec), x0 - 6 * m.k, P.Y(v))
      // 纵轴线 + 底线
      ctx.strokeStyle = pal.frame; ctx.beginPath()
      ctx.moveTo(Math.round(x0) + 0.5, P.top); ctx.lineTo(Math.round(x0) + 0.5, P.top + P.h)
      ctx.moveTo(x0, Math.round(P.top + P.h) + 0.5); ctx.lineTo(x1, Math.round(P.top + P.h) + 0.5)
      ctx.stroke()
      // 格题 + 图例（≥ 2 条线才有图例；单线由格题说明）
      ctx.fillStyle = pal.text; ctx.font = font(FS, '600'); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
      const hy = P.top - m.head / 2
      ctx.fillText(p.title || '', x0, hy)
      let lx = x0 + ctx.measureText(p.title || '').width + 16 * m.k
      const ser = p.series || []
      if (ser.length >= 2) {
        ctx.font = font(FSs)
        ser.forEach((s, si) => {
          const slot = Number.isInteger(s.slot) ? s.slot : si
          ctx.strokeStyle = pal.series[slot % 3]; ctx.lineWidth = LW; ctx.setLineDash(DASHES[slot % 3].map((v) => v * m.k))
          ctx.beginPath(); ctx.moveTo(lx, hy); ctx.lineTo(lx + 18 * m.k, hy); ctx.stroke(); ctx.setLineDash([])
          ctx.fillStyle = pal.muted; ctx.fillText(s.name || '', lx + 23 * m.k, hy)
          lx += 23 * m.k + ctx.measureText(s.name || '').width + 14 * m.k
        })
      }
      // 参考线（限位 / 均值）：细虚线 + 可选数字标签
      ctx.save(); ctx.beginPath(); ctx.rect(x0, P.top, pw, P.h); ctx.clip()
      for (const r of p.refLines || []) {
        if (!Number.isFinite(r.y)) continue
        const yy = Math.round(P.Y(r.y)) + 0.5
        ctx.strokeStyle = pal.ref; ctx.lineWidth = 1; ctx.setLineDash([4 * m.k, 3 * m.k])
        ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke(); ctx.setLineDash([])
        if (r.label) { ctx.fillStyle = pal.faint; ctx.font = font(FSs); ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(r.label, x1 - 4, yy - 2) }
      }
      // 线
      ser.forEach((s, si) => {
        const slot = Number.isInteger(s.slot) ? s.slot : si
        const tt = s.t || d.t
        if (!tt || !s.y) return
        const segs = polylineSegments(tt, s.y, X, P.Y, { wrap: s.wrap, gapMs: s.gapMs })
        ctx.strokeStyle = pal.series[slot % 3]; ctx.lineWidth = LW; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
        ctx.setLineDash(DASHES[slot % 3].map((v) => v * m.k))
        for (const sg of segs) {
          ink.push(sg)
          if (sg.length === 1) { ctx.fillStyle = pal.series[slot % 3]; ctx.beginPath(); ctx.arc(sg[0][0], sg[0][1], LW, 0, 2 * Math.PI); ctx.fill(); continue }
          ctx.beginPath(); sg.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke()
        }
        ctx.setLineDash([])
      })
      ctx.restore()
      // 竖标
      for (const mk of d.marks || []) {
        if (!Number.isFinite(mk.t) || (Number.isInteger(mk.panel) && mk.panel !== pi)) continue
        const x = X(mk.t)
        if (x < x0 || x > x1) continue
        ctx.strokeStyle = pal.text; ctx.lineWidth = 1; ctx.setLineDash([2 * m.k, 2 * m.k])
        ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, P.top); ctx.lineTo(Math.round(x) + 0.5, P.top + P.h); ctx.stroke(); ctx.setLineDash([])
        const s = 4 * m.k
        ctx.fillStyle = pal.text; ctx.beginPath(); ctx.moveTo(x - s, P.top); ctx.lineTo(x + s, P.top); ctx.lineTo(x, P.top + s * 1.4); ctx.closePath(); ctx.fill()
        if (mk.label && (!Number.isInteger(mk.panel) || mk.panel === pi)) {
          ctx.font = font(FSs); ctx.textBaseline = 'top'
          const tw = ctx.measureText(mk.label).width
          const right = x + 6 + tw < x1
          ctx.textAlign = right ? 'left' : 'right'
          ctx.fillStyle = pal.text; ctx.fillText(mk.label, right ? x + 6 : x - 6, P.top + 2)
        }
      }
    })

    // 状态条
    for (const S of strips) {
      for (const sg of S.s.segs || []) {
        const bx0 = Math.max(x0, X(sg.t0)), bx1 = Math.min(x1, X(sg.t1))
        if (!(bx1 > bx0)) continue
        const st = sg.style
        if (st === 'ok') { ctx.fillStyle = pal.ok; ctx.fillRect(bx0, S.top, bx1 - bx0, S.h) }
        else if (st === 'bad') { ctx.fillStyle = pal.danger; ctx.fillRect(bx0, S.top, bx1 - bx0, S.h) }
        else if (st === 'badHatch') this._hatch(ctx, bx0, S.top, bx1 - bx0, S.h, pal.danger, 1, m.k, 1.6)
        else { ctx.fillStyle = pal.shade; ctx.fillRect(bx0, S.top, bx1 - bx0, S.h) }
      }
      if (S.s.label) { ctx.fillStyle = pal.muted; ctx.font = font(FSs); ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(S.s.label, x0 - 6 * m.k, S.top + S.h / 2) }
    }

    // 横轴刻度与标签（贪心抽稀，两端收进画布；窗口里没有日界时首个标签带日期）
    const span = t1 - t0
    ctx.strokeStyle = pal.frame; ctx.lineWidth = 1; ctx.beginPath()
    for (const tk of ticks.major) { const x = Math.round(X(tk.ms)) + 0.5; if (x < x0 - 0.5 || x > x1 + 0.5) continue; ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + (tk.day ? 6 : 4) * m.k) }
    for (const ms of ticks.minor) { const x = Math.round(X(ms)) + 0.5; if (x < x0 || x > x1) continue; ctx.moveTo(x, axisY); ctx.lineTo(x, axisY + 2.5 * m.k) }
    ctx.stroke()
    const anyDay = ticks.major.some((tk) => tk.day)
    ctx.textBaseline = 'top'
    let lastRight = -Infinity
    ticks.major.forEach((tk, i) => {
      const x = X(tk.ms)
      if (x < x0 - 0.5 || x > x1 + 0.5) return
      let label = fmtTimeTick(tk.ms, span, this.tz)
      if (!anyDay && i === 0 && span / 60000 <= 5760) { const q = tzParts(tk.ms, this.tz); label = `${p2(q.mo)}-${p2(q.d)} ` + label }
      ctx.font = font(FS, tk.day ? '600' : '')
      const w = ctx.measureText(label).width
      let lx = x - w / 2
      lx = Math.max(Math.min(lx, W - 2 - w), x0 - Math.min(w / 2, x0 - 2))
      if (lx < lastRight + 8 * m.k) return
      lastRight = lx + w
      ctx.fillStyle = tk.day ? pal.text : pal.muted; ctx.textAlign = 'left'
      ctx.fillText(label, lx, axisY + 8 * m.k)
    })
    ctx.fillStyle = pal.muted; ctx.font = font(FS); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'
    ctx.fillText('时刻 (' + tzTag(this.tz, t0) + ')', x0 + pw / 2, H - 3 * m.k)

    const lay = { x0, x1, pw, t0, t1, X, panels, strips, top: panels[0].top, bottom: axisY, ink }
    if (!forExport && this.hover) this._drawHover(ctx, pal, lay, font, FS, FSs, W, H)
    ctx.restore()
    return lay
  }

  // 纵轴范围按当前时窗 [t0, t1] 里的数据定（seriesRange：窗内样本 + 边界插值）；p.fitAll = true 则按全部样本定（多幅图要同尺度对比时用）
  _yScale(p, d, t0, t1) {
    let lo = Infinity, hi = -Infinity
    for (const s of p.series || []) {
      const y = s.y
      if (!y) continue
      const tt = s.t || d.t
      if (p.fitAll || !tt || !Number.isFinite(t0) || !Number.isFinite(t1)) {
        for (let i = 0; i < y.length; i++) { const v = y[i]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v } }
      } else {
        const [a, b] = seriesRange(tt, y, t0, t1, { wrap: s.wrap, gapMs: s.gapMs })
        if (a < lo) lo = a
        if (b > hi) hi = b
      }
    }
    for (const r of p.refLines || []) if (Number.isFinite(r.y)) { lo = Math.min(lo, r.y); hi = Math.max(hi, r.y) }
    if (p.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0) }
    if (Number.isFinite(p.yMin)) lo = p.yMin
    if (Number.isFinite(p.yMax)) hi = p.yMax
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1 }
    const n = Math.max(2, Math.round((this.panelHeight * (p.weight || 1)) / 32))
    const sc = niceScale(lo, hi, n, { angle: !!p.angle })
    if (Number.isFinite(p.yMin)) sc.lo = p.yMin
    if (Number.isFinite(p.yMax)) sc.hi = p.yMax
    sc.ticks = sc.ticks.filter((v) => v >= sc.lo - 1e-9 && v <= sc.hi + 1e-9)
    return sc
  }

  _band(ctx, kind, x, y, w, h, pal, k) {
    if (kind === 'shade') { ctx.fillStyle = pal.shade; ctx.fillRect(x, y, w, h); return }
    this._hatch(ctx, x, y, w, h, pal.hatch, kind === 'hatch2' ? -1 : 1, k, 1, 0.55)
  }
  // 斜纹：45°（dir=1）/ 135°（dir=−1），逻辑间距 6 px；剪在矩形里画，倍率导出时线跟着放大、不糊
  _hatch(ctx, x, y, w, h, color, dir, k, lw, alpha = 0.9) {
    ctx.save()
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip()
    ctx.strokeStyle = color; ctx.lineWidth = lw * k; ctx.globalAlpha = alpha
    const g = 6 * k
    ctx.beginPath()
    const a0 = Math.floor((x - h) / g) * g
    for (let a = a0; a < x + w + h; a += g) {
      if (dir > 0) { ctx.moveTo(a, y + h); ctx.lineTo(a + h, y) } else { ctx.moveTo(a, y); ctx.lineTo(a + h, y + h) }
    }
    ctx.stroke()
    ctx.restore()
  }

  _rowsAt(tMs) {
    const d = this.data, rows = []
    d.panels.forEach((p, pi) => (p.series || []).forEach((s, si) => {
      const tt = s.t || d.t
      const i = nearestIndex(tt, tMs)
      let v = NaN, ts = NaN
      if (i >= 0) {
        ts = tt[i]
        // 最近样本离光标超过两个采样间隔（缺测 / 断段）就不认
        const dt = tt.length > 1 ? Math.abs(tt[Math.min(tt.length - 1, i + 1)] - tt[Math.max(0, i - 1)]) : Infinity
        if (Math.abs(ts - tMs) <= Math.max(dt, 1)) v = s.y[i]
      }
      rows.push({ panel: pi, series: si, name: s.name || p.title || '', value: Number.isFinite(v) ? v : null, t: ts, unit: p.unit || '', dec: null })
    }))
    return rows
  }

  _drawHover(ctx, pal, lay, font, FS, FSs, W, H) {
    const hv = this.hover
    const x = lay.X(hv.tMs)
    ctx.strokeStyle = pal.cross; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, lay.top); ctx.lineTo(Math.round(x) + 0.5, lay.bottom); ctx.stroke()
    const lines = [{ text: fmtTimeFull(hv.tMs, this.tz), slot: -1 }]
    let lastPanel = -1
    for (const r of hv.rows) {
      const P = lay.panels[r.panel]
      const s = P.p.series[r.series]
      const slot = Number.isInteger(s.slot) ? s.slot : r.series
      if (r.value != null && Number.isFinite(r.t)) {
        const px = lay.X(r.t), py = P.Y(r.value)
        if (py >= P.top - 1 && py <= P.top + P.h + 1) {
          ctx.fillStyle = pal.ring; ctx.beginPath(); ctx.arc(px, py, 5.5, 0, 2 * Math.PI); ctx.fill()
          ctx.fillStyle = pal.series[slot % 3]; ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 2 * Math.PI); ctx.fill()
        }
      }
      const dec = Number.isInteger(P.p.dec) ? P.p.dec : P.sc.dec + 1
      const nm = (P.p.series.length > 1 ? (s.name || '') : (s.name || P.p.title || ''))
      // 换格处画一道细分隔：不同格常有同名线（万向节「方位轴」角度 / 角速率各一条），按格分组才不串
      lines.push({ text: nm + '  ' + (r.value == null ? '—' : fmtVal(r.value, dec)) + (P.p.unit ? ' ' + P.p.unit : ''), slot, sep: lastPanel >= 0 && r.panel !== lastPanel })
      lastPanel = r.panel
    }
    ctx.font = font(FS)
    const tw = Math.max(...lines.map((l) => ctx.measureText(l.text).width)) + 34, lh = FS + 6, th = lines.length * lh + 10
    // 框放在压线最少的一侧 / 一格（placeTip）：固定贴右上会整段盖住光标右边的走势，读数和走势不能同时看
    const pos = placeTip({ x, tw, th, W, H, top: lay.top, bottom: lay.bottom, panels: lay.panels.map((P) => ({ top: P.top, h: P.h })), ink: lay.ink, prev: this._tipKey })
    this._tipKey = pos.key
    const bx = pos.x, by = pos.y
    this._tipRect = { x: bx, y: by, w: tw, h: th }   // 调试 / 验证台量「框压了多少线」用
    ctx.fillStyle = pal.tipBg; ctx.strokeStyle = pal.tipBorder; ctx.lineWidth = 1
    ctx.beginPath(); ctx.rect(Math.round(bx) + 0.5, Math.round(by) + 0.5, Math.round(tw), Math.round(th)); ctx.fill(); ctx.stroke()
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    lines.forEach((l, i) => {
      const yy = by + 5 + lh * i + lh / 2
      if (l.sep) {
        const sy = Math.round(yy - lh / 2) + 0.5
        ctx.strokeStyle = pal.grid; ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(bx + 8, sy); ctx.lineTo(bx + tw - 8, sy); ctx.stroke()
      }
      if (l.slot >= 0) {
        ctx.strokeStyle = pal.series[l.slot % 3]; ctx.lineWidth = 2; ctx.setLineDash(DASHES[l.slot % 3])
        ctx.beginPath(); ctx.moveTo(bx + 8, yy); ctx.lineTo(bx + 22, yy); ctx.stroke(); ctx.setLineDash([])
      }
      ctx.fillStyle = i ? pal.muted : pal.text
      ctx.fillText(l.text, bx + (l.slot >= 0 ? 28 : 8), yy)
    })
  }

  _move(e) {
    const lay = this._layout
    if (!lay || !this.data) return
    const r = this._cv.getBoundingClientRect()
    const px = e.clientX - r.left, py = e.clientY - r.top
    if (px < lay.x0 || px > lay.x1 || py < lay.top - 20 || py > lay.bottom) { this._leave(); return }
    const tMs = lay.t0 + ((px - lay.x0) / lay.pw) * (lay.t1 - lay.t0)
    const rows = this._rowsAt(tMs)
    this.hover = { tMs, rows }
    if (this.onHover) this.onHover({ tMs, rows: rows.map((x) => ({ panel: x.panel, series: x.series, name: x.name, value: x.value, unit: x.unit, t: x.t })) })
    this.draw()
  }
  _leave() {
    if (!this.hover) return
    this.hover = null
    this._tipKey = ''
    if (this.onHover) this.onHover(null)
    this.draw()
  }

  /** 出图画布（缺省逻辑 880 宽、按格数自适应高、4 倍；白底 + 报告字体）。o = { scale?, width?, height?, title?, panelHeight? } */
  toCanvas(o = {}) {
    const scale = o.scale || 4, W = o.width || 880
    const H = o.height || Math.round(this._naturalHeight(true, !!o.title, o.panelHeight || 150))
    const cv = document.createElement('canvas')
    cv.width = Math.round(W * scale); cv.height = Math.round(H * scale)
    const ctx = cv.getContext('2d')
    ctx.scale(scale, scale)
    const hv = this.hover; this.hover = null
    this.drawTo(ctx, W, H, true, { title: o.title })
    this.hover = hv
    return cv
  }
  exportPng(o = {}) {
    const cv = this.toCanvas(o)
    return new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob 失败'))), 'image/png'))
  }

  // 只摘 DOM / 观察器 / 监听，数据与设置留着（mount 换容器用）
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
    this._cv = null; this._el = null; this._layout = null; this.hover = null; this._tipKey = ''
    this._cssW = 0; this._cssH = 0
  }
  dispose() {
    this._detach()
    this.data = null
  }
}
