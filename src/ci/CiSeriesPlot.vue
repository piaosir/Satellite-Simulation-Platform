<script setup>
// NGSO 时变 C/I 的**时序**曲线。
//
// CDF 回答「有多少时间比它更差」，时序回答「什么时候差、差多久、多久来一次」——
// 后者才决定是靠 ACM 扛过去还是必须切星。两张图缺一不可，故并排摆。
//
// 三条信息叠在一张图上：
//   · C/I(t) 主曲线（左轴 dB）；
//   · 门限横线，低于门限的段用另一种颜色描出来——一眼看见「一天几次、每次多久」；
//   · 服务星仰角（右轴，淡线）——C/I 的坑十有八九跟着切星走，两条对齐才看得出因果。
//
// 断点（无服务星的时刻）不连线：把中断画成一条平滑过渡是在编数据。
import { computed, ref } from 'vue'
import { exportSvgPng, canExportPng, PNG_SCALE } from './ciFigureExport.js'

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

const W = 640, H = 220
const M = { l: 46, r: 44, t: 12, b: 28 }
const PW = W - M.l - M.r, PH = H - M.t - M.b

const key = computed(() => (props.metric === 'iOverN' ? 'iOverNDb' : 'ciDb'))
const yName = computed(() => (props.metric === 'iOverN' ? 'I/N（dB）' : 'C/I（dB）'))
// I/N 是越大越差，门限在上方；C/I 越小越差，门限在下方
const worseIsHigh = computed(() => props.metric === 'iOverN')

const pts = computed(() => (props.series || []).filter((d) => d && Number.isFinite(Number(d.tMs))))

const tDomain = computed(() => {
  const p = pts.value
  if (!p.length) return [0, 1]
  const lo = Number(p[0].tMs), hi = Number(p[p.length - 1].tMs)
  return hi > lo ? [lo, hi] : [lo, lo + 1]
})
const yDomain = computed(() => {
  const vs = pts.value.map((d) => Number(d[key.value])).filter(Number.isFinite)
  if (props.thresholdDb != null && Number.isFinite(props.thresholdDb)) vs.push(props.thresholdDb)
  if (!vs.length) return [0, 1]
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (hi - lo < 1) hi = lo + 1
  const pad = (hi - lo) * 0.08
  return [lo - pad, hi + pad]
})
const xOf = (t) => { const [a, b] = tDomain.value; return M.l + PW * ((Number(t) - a) / (b - a)) }
const yOf = (v) => { const [a, b] = yDomain.value; return M.t + PH * (1 - (Number(v) - a) / (b - a)) }

// 断点不连线：把连续可用的段各画一条 path
function segments(field, pick) {
  const out = []
  let cur = null
  for (const d of pts.value) {
    const v = pick ? pick(d) : Number(d[field])
    if (!Number.isFinite(v)) { if (cur && cur.length > 1) out.push(cur); cur = null; continue }
    if (!cur) cur = []
    cur.push(`${xOf(d.tMs).toFixed(2)},${v.toFixed(4)}`)
  }
  if (cur && cur.length > 1) out.push(cur)
  return out
}
const mainPaths = computed(() =>
  segments(key.value).map((seg) => seg.map((s, i) => {
    const [x, v] = s.split(',')
    return `${i ? 'L' : 'M'}${x},${yOf(+v).toFixed(2)}`
  }).join(' '))
)

// 越限段：单独描粗，看得见「一天几次、每次多久」
const breachPaths = computed(() => {
  const th = Number(props.thresholdDb)
  if (!Number.isFinite(th)) return []
  const out = []
  let cur = null
  for (const d of pts.value) {
    const v = Number(d[key.value])
    const bad = Number.isFinite(v) && (worseIsHigh.value ? v > th : v < th)
    if (!bad) { if (cur && cur.length > 1) out.push(cur.join(' ')); cur = null; continue }
    cur = cur || []
    cur.push(`${cur.length ? 'L' : 'M'}${xOf(d.tMs).toFixed(2)},${yOf(v).toFixed(2)}`)
  }
  if (cur && cur.length > 1) out.push(cur.join(' '))
  return out
})

// 右轴：服务星仰角
const elevDomain = computed(() => {
  const vs = pts.value.map((d) => Number(d.servingElevDeg)).filter(Number.isFinite)
  if (!vs.length) return [0, 90]
  return [Math.max(0, Math.min(...vs) - 3), Math.min(90, Math.max(...vs) + 3)]
})
const yElevOf = (v) => { const [a, b] = elevDomain.value; return M.t + PH * (1 - (Number(v) - a) / (b - a)) }
const elevPaths = computed(() => {
  if (!props.showElev) return []
  const out = []
  let cur = null
  for (const d of pts.value) {
    const v = Number(d.servingElevDeg)
    if (!Number.isFinite(v)) { if (cur && cur.length > 1) out.push(cur.join(' ')); cur = null; continue }
    cur = cur || []
    cur.push(`${cur.length ? 'L' : 'M'}${xOf(d.tMs).toFixed(2)},${yElevOf(v).toFixed(2)}`)
  }
  if (cur && cur.length > 1) out.push(cur.join(' '))
  return out
})

const yTicks = computed(() => {
  const [lo, hi] = yDomain.value
  const step = niceStep((hi - lo) / 4)
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
})
function niceStep(raw) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1e-12, raw))))
  return ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)) || mag * 10
}
// 横轴：时窗跨度决定标签粒度（几小时给时:分，跨天给日期）
const spanH = computed(() => (tDomain.value[1] - tDomain.value[0]) / 3600e3)
const xTicks = computed(() => {
  const [a, b] = tDomain.value
  const n = 5
  const out = []
  for (let i = 0; i <= n; i++) out.push(a + (b - a) * (i / n))
  return out
})
const fmtT = (ms) => {
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return spanH.value > 36
    ? `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    : `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

// —— 出图 ——
// 按钮长在图上：外层不必先判断「当前是哪张图」，图自己知道自己叫什么、画的是什么。
const figName = computed(() => props.title || (props.metric === 'iOverN' ? 'I/N 时序' : 'C/I 时序'))
const svgEl = ref(null)
const busy = ref(false)
async function exportPng() {
  if (busy.value) return
  busy.value = true
  try { await exportSvgPng(svgEl.value, props.fileName || figName.value) }
  finally { busy.value = false }
}
defineExpose({ svg: svgEl, exportPng })
</script>

<template>
  <div class="ci-series">
    <div class="ci-fig-hd">
      <b class="ci-fig-name">{{ figName }}</b>
      <span class="ci-fig-sp" />
      <button
        v-if="canExportPng" class="ci-fig-exp" :disabled="busy || !pts.length"
        :title="`导出为 PNG 图片（${PNG_SCALE} 倍分辨率）`" @click="exportPng">出图</button>
    </div>
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="pl-bg" />

      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="M.l" :y1="yOf(v)" :x2="M.l + PW" :y2="yOf(v)" class="pl-grid" />
        <text :x="M.l - 4" :y="yOf(v)" class="pl-tick" text-anchor="end" dominant-baseline="middle">{{ v }}</text>
      </g>
      <g v-for="(t, i) in xTicks" :key="'x' + i">
        <line :x1="xOf(t)" :y1="M.t" :x2="xOf(t)" :y2="M.t + PH" class="pl-grid" />
        <text :x="xOf(t)" :y="M.t + PH + 10" class="pl-tick" text-anchor="middle">{{ fmtT(t) }}</text>
      </g>

      <!-- 服务星仰角（右轴，淡线）：C/I 的下陷多与切星同步，两条对齐才看得出因果 -->
      <template v-if="showElev">
        <path v-for="(d, i) in elevPaths" :key="'e' + i" :d="d" class="pl-elev" />
        <text :x="M.l + PW + 6" :y="M.t + 8" class="pl-tick dim">仰角 °</text>
        <text :x="M.l + PW + 6" :y="yElevOf(elevDomain[1])" class="pl-tick dim" dominant-baseline="middle">{{ elevDomain[1].toFixed(0) }}</text>
        <text :x="M.l + PW + 6" :y="yElevOf(elevDomain[0])" class="pl-tick dim" dominant-baseline="middle">{{ elevDomain[0].toFixed(0) }}</text>
      </template>

      <!-- 门限 -->
      <template v-if="Number.isFinite(Number(thresholdDb))">
        <line :x1="M.l" :y1="yOf(thresholdDb)" :x2="M.l + PW" :y2="yOf(thresholdDb)" class="pl-thr" />
        <text :x="M.l + 3" :y="yOf(thresholdDb) - 2.5" class="pl-thr-lab">门限 {{ thresholdDb }} dB</text>
      </template>

      <path v-for="(d, i) in mainPaths" :key="'m' + i" :d="d" class="pl-line" />
      <path v-for="(d, i) in breachPaths" :key="'b' + i" :d="d" class="pl-breach" />

      <text :x="10" :y="M.t + PH / 2" class="pl-axis" text-anchor="middle"
        :transform="`rotate(-90 10 ${M.t + PH / 2})`">{{ yName }}</text>
    </svg>
    <p v-if="!pts.length" class="ci-series-empty">尚无时序数据</p>
  </div>
</template>

<style scoped>
.ci-series { width: 100%; }
.ci-series svg { width: 100%; height: auto; display: block; }

/* 题行：图名 + 出图。与 CiCdfPlot 同一份（两图是并列的一对，样式一向各存各的） */
.ci-fig-hd { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; }
.ci-fig-name { font-size: 12.5px; font-weight: 700; color: var(--text-muted); }
.ci-fig-sp { flex: 1; }
.ci-fig-exp {
  font: inherit; font-size: 11.5px; padding: 2px 9px; cursor: pointer;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px);
}
.ci-fig-exp:hover:not(:disabled) { border-color: var(--border-strong); }
.ci-fig-exp:disabled { opacity: 0.45; cursor: default; }

.pl-bg { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 0.6; }
.pl-grid { stroke: var(--border); stroke-width: 0.4; }
.pl-tick { font-size: 7px; fill: var(--text-muted); }
.pl-tick.dim { opacity: 0.75; }
.pl-axis { font-size: 7.5px; fill: var(--text-muted); font-weight: 600; }

.pl-line { fill: none; stroke: var(--accent); stroke-width: 1; stroke-linejoin: round; }
.pl-breach { fill: none; stroke: var(--danger, #c0392b); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.pl-elev { fill: none; stroke: var(--text-muted); stroke-width: 0.7; opacity: 0.45; stroke-dasharray: 3 2; }
.pl-thr { stroke: var(--warn, #d08a2e); stroke-width: 1; stroke-dasharray: 3 2; }
.pl-thr-lab { font-size: 6.5px; fill: var(--warn, #d08a2e); font-weight: 600; }

.ci-series-empty { margin: 6px 0 0; text-align: center; font-size: 12px; color: var(--text-muted); }
</style>
