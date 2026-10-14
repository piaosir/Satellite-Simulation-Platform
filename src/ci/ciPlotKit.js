// 干扰分析四张 SVG 图（CDF / 时序 / 方向图切面 / 上行密度切面）共用的排版小件。
//
// 几何随实宽重排、字号恒定：viewBox 宽 = 容器实宽（ResizeObserver 实量，照 SsaChart 的做法），
// 1 个 viewBox 单位 = 1 CSS px，所以刻度、轴名、注记写 11 px 就是屏上 11 px，不随栏宽缩放。
// 原先把 7 px 写在固定 320 / 640 单位的 viewBox 里再 width:100% 拉伸：出厂宽度下时序图刻度
// 只有 6.8 px，单栏时 CDF 刻度却有 24 px。出图倍率另算（ciFigureExport 的 PNG_SCALE）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { theme } from '../stores/theme.js'
import { seriesColor } from '../shared/lbPlotTheme.js'

export const PLOT_FS = 11

/** 容器实宽（px）。el 是模板 ref；未挂载前取 fallback。 */
export function usePlotWidth(el, fallback = 480, min = 260) {
  const w = ref(fallback)
  let ro = null
  const measure = () => {
    const n = el.value && el.value.clientWidth
    if (n > 0) { const v = Math.max(min, Math.round(n)); if (v !== w.value) w.value = v }
  }
  onMounted(() => {
    measure()
    if (typeof ResizeObserver !== 'undefined' && el.value) { ro = new ResizeObserver(measure); ro.observe(el.value) }
  })
  onBeforeUnmount(() => { if (ro) ro.disconnect() })
  return w
}

/** 曲线色 CSS 变量（--plot-s0..2 = lbPlotTheme 的 seriesColor），随外观换档；出图时被纸色板覆盖。 */
export function usePlotSeriesVars() {
  return computed(() => {
    void theme.resolved
    return { '--plot-s0': seriesColor(0), '--plot-s1': seriesColor(1), '--plot-s2': seriesColor(2) }
  })
}

export function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-12, raw))))
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)) || mag * 10
}

/** 线性轴的整步长刻度（约 n 档）。 */
export function linTicks(lo, hi, n = 5) {
  const step = niceStep((hi - lo) / Math.max(1, n))
  const out = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
}

const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3
const T_STEPS = [MIN, 2 * MIN, 5 * MIN, 10 * MIN, 15 * MIN, 30 * MIN, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 5 * DAY, 7 * DAY, 14 * DAY, 30 * DAY]

/** 时间轴刻度：整点步长（UTC 对齐），不多于 maxN 个。返回 { ticks, step }。 */
export function timeTicks(a, b, maxN = 6) {
  const span = Math.max(1, b - a)
  const step = T_STEPS.find((s) => span / s <= maxN) || T_STEPS[T_STEPS.length - 1]
  const ticks = []
  for (let t = Math.ceil(a / step) * step; t <= b + 1; t += step) ticks.push(t)
  return { ticks, step }
}

/** 时间刻度标签（UTC）：步长 ≥ 1 天给月-日；否则给时:分，跨到 0 点的那一格改写月-日。 */
export function fmtTimeTick(ms, step) {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  const md = `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
  if (step >= DAY) return md
  if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) return md
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}
