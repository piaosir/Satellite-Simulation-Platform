<script setup>
// NGSO 时变 C/I 的**时序**曲线。
//
// CDF 回答「有多少时间比它更差」，时序回答「什么时候差、差多久、多久来一次」——
// 后者才决定是靠 ACM 扛过去还是必须切星。两张图缺一不可，故并排摆。
//
// 三条信息叠在一张图上（图例在图内顶行，导出 PNG 一并带上）：
//   · C/I(t) 主曲线（左轴 dB）；
//   · 门限横线，低于门限的段用另一种颜色描出来——一眼看见「一天几次、每次多久」；
//   · 服务星仰角（右轴，淡线）——C/I 的坑十有八九跟着切星走，两条对齐才看得出因果。
//
// 断点（无服务星的时刻）不连线：把中断画成一条平滑过渡是在编数据。
// 排版：viewBox 宽 = 容器实宽，字号恒 11 px；时间刻度取整点步长（见 ciPlotKit）。
import { computed, ref } from 'vue'
import { exportSvgPng, canExportPng, PNG_SCALE } from './ciFigureExport.js'
import { PLOT_FS as FS, usePlotWidth, usePlotSeriesVars, linTicks, timeTicks, fmtTimeTick } from './ciPlotKit.js'
import { textWidth } from './ciPlotLabels.js'
import NoticeLine from '../components/NoticeLine.vue'
import { useNotice } from '../shared/useNotice.js'

const props = defineProps({
  // [{ tMs, ciDb, iOverNDb, servingElevDeg, minThetaDeg }]，时间升序
  series: { type: Array, default: () => [] },
  thresholdDb: { type: Number, default: null },
  // 'ci' | 'iOverN'
  metric: { type: String, default: 'ci' },
  showElev: { type: Boolean, default: true },
  // 图名（题行左侧）与出图默认文件名
  title: { type: String, default: '' },
  fileName: { type: String, default: '' }
})

const wrapEl = ref(null)
const W = usePlotWidth(wrapEl, 640)
const serVars = usePlotSeriesVars()
const H = 270
const M = computed(() => ({ l: 58, r: props.showElev ? 52 : 16, t: 30, b: 42 }))
const PW = computed(() => W.value - M.value.l - M.value.r)
const PH = computed(() => H - M.value.t - M.value.b)

const key = computed(() => (props.metric === 'iOverN' ? 'iOverNDb' : 'ciDb'))
const qName = computed(() => (props.metric === 'iOverN' ? 'I/N' : 'C/I'))
const yName = computed(() => qName.value + ' (dB)')
// I/N 是越大越差，门限在上方；C/I 越小越差，门限在下方
const worseIsHigh = computed(() => props.metric === 'iOverN')
const hasThr = computed(() => props.thresholdDb != null && Number.isFinite(Number(props.thresholdDb)))

const pts = computed(() => (props.series || []).filter((d) => d && Number.isFinite(Number(d.tMs))))

const tDomain = computed(() => {
  const p = pts.value
  if (!p.length) return [0, 1]
  const lo = Number(p[0].tMs), hi = Number(p[p.length - 1].tMs)
  return hi > lo ? [lo, hi] : [lo, lo + 1]
})
const yDomain = computed(() => {
  const vs = pts.value.map((d) => Number(d[key.value])).filter(Number.isFinite)
  if (hasThr.value) vs.push(Number(props.thresholdDb))
  if (!vs.length) return [0, 1]
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (hi - lo < 1) hi = lo + 1
  const pad = (hi - lo) * 0.08
  return [lo - pad, hi + pad]
})
const xOf = (t) => { const [a, b] = tDomain.value; return M.value.l + PW.value * ((Number(t) - a) / (b - a)) }
const yOf = (v) => { const [a, b] = yDomain.value; return M.value.t + PH.value * (1 - (Number(v) - a) / (b - a)) }

// 断点不连线：连续可用的段各画一条 path
function runs(val, yFn, keep) {
  const out = []
  let cur = null
  for (const d of pts.value) {
    const v = val(d)
    if (!Number.isFinite(v) || (keep && !keep(v))) { if (cur && cur.length > 1) out.push(cur.join(' ')); cur = null; continue }
    cur = cur || []
    cur.push(`${cur.length ? 'L' : 'M'}${xOf(d.tMs).toFixed(2)},${yFn(v).toFixed(2)}`)
  }
  if (cur && cur.length > 1) out.push(cur.join(' '))
  return out
}
const mainPaths = computed(() => runs((d) => Number(d[key.value]), yOf))

// 越限段：单独描粗，看得见「一天几次、每次多久」
const breachPaths = computed(() => {
  if (!hasThr.value) return []
  const th = Number(props.thresholdDb)
  return runs((d) => Number(d[key.value]), yOf, (v) => (worseIsHigh.value ? v > th : v < th))
})

// 右轴：服务星仰角（整步长刻度，量程对齐到刻度）
const elevDomain = computed(() => {
  const vs = pts.value.map((d) => Number(d.servingElevDeg)).filter(Number.isFinite)
  if (!vs.length) return [0, 90]
  const lo = Math.max(0, Math.min(...vs) - 3), hi = Math.min(90, Math.max(...vs) + 3)
  const t = linTicks(lo, hi, 4), st = t.length > 1 ? t[1] - t[0] : 10
  return [Math.max(0, Math.floor(lo / st) * st), Math.min(90, Math.ceil(hi / st) * st)]
})
const elevTicks = computed(() => linTicks(elevDomain.value[0], elevDomain.value[1], 4))
const yElevOf = (v) => { const [a, b] = elevDomain.value; return M.value.t + PH.value * (1 - (Number(v) - a) / ((b - a) || 1)) }
const elevPaths = computed(() => (props.showElev ? runs((d) => Number(d.servingElevDeg), yElevOf) : []))

const yTicks = computed(() => linTicks(yDomain.value[0], yDomain.value[1], 4))
// 横轴：整点步长（1/2/5/10/15/30 min、1/2/3/6/12 h、1/2/5/7 d…），档数随实宽
const xTickInfo = computed(() => timeTicks(tDomain.value[0], tDomain.value[1], Math.max(3, Math.floor(PW.value / 80))))

// 图例（图内顶行，从左缘排起）
const legend = computed(() => {
  const items = [{ k: 'main', text: qName.value }]
  if (hasThr.value) items.push({ k: 'breach', text: '越限段' })
  if (props.showElev) items.push({ k: 'elev', text: '仰角' })
  let x = M.value.l
  for (const it of items) { it.x = x; x += 22 + textWidth(it.text, FS) + 14 }
  return items
})

// —— 出图 ——
// 按钮长在图上：外层不必先判断「当前是哪张图」，图自己知道自己叫什么、画的是什么。
const figName = computed(() => props.title || (props.metric === 'iOverN' ? 'I/N 时序' : 'C/I 时序'))
const svgEl = ref(null)
const busy = ref(false)
// 出图回执挂在图头上：成功带「打开 · 在文件夹中显示」，失败红字常驻。
// errorSink:false —— 本窗口的失败出口由 CiApp 那一条登记，图头这一条不抢。
const N = useNotice({ errorSink: false })
const outPath = (r) => (r && (r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath)) || ''
async function exportPng() {
  if (busy.value) return
  busy.value = true; N.clearNotice()
  try {
    const r = await exportSvgPng(svgEl.value, props.fileName || figName.value)
    if (r && r.ok) { const fp = outPath(r); N.toastFile('已导出：' + String(fp).split(/[\\/]/).pop(), fp) }
    else if (r && !r.canceled && !r.missing) N.toastError('导出失败：' + (r.error || ''))
  } finally { busy.value = false }
}
defineExpose({ svg: svgEl, exportPng })
</script>

<template>
  <div ref="wrapEl" class="ci-series" :style="serVars">
    <div class="ci-fig-hd">
      <b class="ci-fig-name">{{ figName }}</b>
      <span class="ci-fig-sp" />
      <NoticeLine :n="N" />
      <button
        v-if="canExportPng" class="ci-fig-exp" :disabled="busy || !pts.length"
        :title="`导出为 PNG 图片（${PNG_SCALE} 倍分辨率）`" @click="exportPng">导出</button>
    </div>
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H">
      <!-- 图例 -->
      <g v-for="it in legend" :key="'lg' + it.k">
        <line :x1="it.x" :y1="M.t - 14" :x2="it.x + 18" :y2="M.t - 14" :class="'lg-' + it.k" />
        <text :x="it.x + 22" :y="M.t - 14" class="pl-tick" dominant-baseline="middle">{{ it.text }}</text>
      </g>

      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="pl-bg" />

      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="M.l" :y1="yOf(v)" :x2="M.l + PW" :y2="yOf(v)" class="pl-grid" />
        <text :x="M.l - 5" :y="yOf(v)" class="pl-tick" text-anchor="end" dominant-baseline="middle">{{ v }}</text>
      </g>
      <g v-for="t in xTickInfo.ticks" :key="'x' + t">
        <line :x1="xOf(t)" :y1="M.t" :x2="xOf(t)" :y2="M.t + PH" class="pl-grid" />
        <text :x="xOf(t)" :y="M.t + PH + FS + 4" class="pl-tick" text-anchor="middle">{{ fmtTimeTick(t, xTickInfo.step) }}</text>
      </g>

      <!-- 服务星仰角（右轴，淡线）：C/I 的下陷多与切星同步，两条对齐才看得出因果 -->
      <template v-if="showElev">
        <path v-for="(d, i) in elevPaths" :key="'e' + i" :d="d" class="pl-elev" />
        <text v-for="v in elevTicks" :key="'ey' + v" :x="M.l + PW + 5" :y="yElevOf(v)" class="pl-tick dim" dominant-baseline="middle">{{ v }}</text>
        <text :x="W - 12" :y="M.t + PH / 2" class="pl-axis dim" text-anchor="middle"
          :transform="`rotate(90 ${W - 12} ${M.t + PH / 2})`">仰角 (°)</text>
      </template>

      <!-- 门限 -->
      <template v-if="hasThr">
        <line :x1="M.l" :y1="yOf(thresholdDb)" :x2="M.l + PW" :y2="yOf(thresholdDb)" class="pl-thr" />
        <text :x="M.l + 4" :y="yOf(thresholdDb) - 4" class="pl-thr-lab">门限 {{ thresholdDb }} dB</text>
      </template>

      <path v-for="(d, i) in mainPaths" :key="'m' + i" :d="d" class="pl-line" />
      <path v-for="(d, i) in breachPaths" :key="'b' + i" :d="d" class="pl-breach" />

      <text :x="14" :y="M.t + PH / 2" class="pl-axis" text-anchor="middle"
        :transform="`rotate(-90 14 ${M.t + PH / 2})`">{{ yName }}</text>
      <!-- 横轴名：刻度按 UTC 出（与本页起止时刻框、事件表同一口径）。不写的话，起点取自主时间轴
           （本地时区显示）、刻度却是 UTC，读图差一个时区。写在 SVG 里，导出 PNG 一并带上 -->
      <text :x="M.l + PW / 2" :y="H - 6" class="pl-axis" text-anchor="middle">时间 (UTC)</text>
    </svg>
    <p v-if="!pts.length" class="ci-series-empty">尚无时序数据</p>
  </div>
</template>

<style scoped>
.ci-series { width: 100%; min-width: 0; }
.ci-series svg { display: block; max-width: 100%; }

/* 题行：图名 + 出图。与 CiCdfPlot 同一份（两图是并列的一对，样式一向各存各的） */
.ci-fig-hd { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
.ci-fig-name { font-size: var(--fs-4); font-weight: 700; color: var(--text-muted); }
.ci-fig-sp { flex: 1; }
.ci-fig-exp {
  font: inherit; font-size: var(--fs-3); height: var(--h-ctl); white-space: nowrap; padding: 0 9px; cursor: pointer;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px);
}
.ci-fig-exp:hover:not(:disabled) { border-color: var(--border-strong); }
.ci-fig-exp:disabled { opacity: 0.45; cursor: default; }

/* 字号恒 11 px（viewBox 单位 = CSS px），与链路预算两张图同档 */
.pl-bg { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1; }
.pl-grid { stroke: var(--border); stroke-width: 1; }
.pl-tick { font-size: 11px; fill: var(--text-muted); font-variant-numeric: tabular-nums; }
.pl-tick.dim { opacity: 0.8; }
.pl-axis { font-size: 11px; fill: var(--text-muted); font-weight: 600; }
.pl-axis.dim { font-weight: 500; }

.pl-line, .lg-main { fill: none; stroke: var(--plot-s0); stroke-width: 1.4; stroke-linejoin: round; }
.pl-breach, .lg-breach { fill: none; stroke: var(--danger); stroke-width: 2.6; stroke-linejoin: round; stroke-linecap: round; }
.pl-elev, .lg-elev { fill: none; stroke: var(--text-muted); stroke-width: 1; opacity: 0.6; stroke-dasharray: 4 3; }
.pl-thr { stroke: var(--warn); stroke-width: 1.2; stroke-dasharray: 4 3; }
.pl-thr-lab { font-size: 11px; fill: var(--warn); font-weight: 600; }

.ci-series-empty { margin: 6px 0 0; text-align: center; font-size: var(--fs-3); color: var(--text-muted); }
</style>
