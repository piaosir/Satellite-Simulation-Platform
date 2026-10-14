<script setup>
// NGSO 时变 C/I 的 CDF 曲线。
//
// 横轴 C/I（dB），纵轴「有多少时间比它更差」——用**对数**纵轴，因为要看的正是尾巴：
// 0.001%～1% 那一段（一年里几分钟到几小时）决定了链路可用度，而线性纵轴会把整条尾巴
// 压成贴着 0 的一条水平线，什么也看不出来。这与雨衰把可用度画成对数刻度是同一个道理。
//
// 图上钉三样东西：
//   · 工程分位（0.001 / 0.01 / 0.1 / 1 / 5 / 10 / 50%）的刻度线与读数；
//   · 中位线（一半时间比它好），给「常态如何」一个锚；
//   · 若给了门限 C/I，画一条竖线，与曲线的交点即「达不到门限的时间占比」——这是这张图
//     真正要回答的问题。
//
// 排版：viewBox 宽 = 容器实宽，字号恒 11 px（见 ciPlotKit）。
import { computed, ref } from 'vue'
import { exportSvgPng, canExportPng, PNG_SCALE } from './ciFigureExport.js'
import { PLOT_FS as FS, usePlotWidth, usePlotSeriesVars, linTicks } from './ciPlotKit.js'
import NoticeLine from '../components/NoticeLine.vue'
import { useNotice } from '../shared/useNotice.js'

const props = defineProps({
  // [{ pct, ciDb }]，pct 升序（0→100）
  cdf: { type: Array, default: () => [] },
  percentiles: { type: Object, default: null },
  medianCiDb: { type: Number, default: null },
  // 门限 C/I（dB）：给了就画竖线并算越限占比
  thresholdDb: { type: Number, default: null },
  // 图名（题行左侧）与出图默认文件名
  title: { type: String, default: 'C/I 累积分布' },
  fileName: { type: String, default: '' }
})

// 绘图矩形（px）
const wrapEl = ref(null)
const W = usePlotWidth(wrapEl, 420)
const serVars = usePlotSeriesVars()
const H = 260
const M = { l: 58, r: 16, t: 14, b: 42 }
const PW = computed(() => W.value - M.l - M.r)
const PH = H - M.t - M.b

// 纵轴：对数百分比，从 PCT_MIN 到 100
const PCT_MIN = 1e-3
const yOf = (pct) => {
  const p = Math.max(PCT_MIN, Math.min(100, Number(pct) || PCT_MIN))
  const t = (Math.log10(p) - Math.log10(PCT_MIN)) / (Math.log10(100) - Math.log10(PCT_MIN))
  return M.t + PH * (1 - t)
}

const pts = computed(() => (props.cdf || []).filter((d) => Number.isFinite(d.ciDb) && Number.isFinite(d.pct)))

const xDomain = computed(() => {
  const vs = pts.value.map((d) => d.ciDb)
  if (props.thresholdDb != null && Number.isFinite(props.thresholdDb)) vs.push(props.thresholdDb)
  if (!vs.length) return [0, 1]
  let lo = Math.min(...vs), hi = Math.max(...vs)
  if (hi - lo < 1) { hi = lo + 1 }
  const pad = (hi - lo) * 0.06
  return [lo - pad, hi + pad]
})
const xOf = (v) => {
  const [lo, hi] = xDomain.value
  return M.l + PW.value * ((Number(v) - lo) / (hi - lo))
}

const pathD = computed(() => {
  const p = pts.value
  if (p.length < 2) return ''
  return p.map((d, i) => `${i ? 'L' : 'M'}${xOf(d.ciDb).toFixed(2)},${yOf(d.pct).toFixed(2)}`).join(' ')
})

// 纵轴刻度（每个数量级 + 中间的 50%），标签写全（0.001%，不写 .001%）
const Y_TICKS = [0.001, 0.01, 0.1, 1, 10, 50, 100]
const yLabel = (p) => p + '%'
// 对数轴上 50% 与 100% 只差 0.3 个数量级：两个标签挨得比一行字还近时上下各让一半
const yLabelY = (p) => {
  const gap = yOf(50) - yOf(100), need = FS + 2
  if (gap >= need || (p !== 50 && p !== 100)) return yOf(p)
  const d = (need - gap) / 2
  return p === 100 ? yOf(p) - d : yOf(p) + d
}

// 横轴刻度：整步长，档数随实宽
const xTicks = computed(() => linTicks(xDomain.value[0], xDomain.value[1], Math.max(3, Math.floor(PW.value / 70))))

// 工程分位标记
const marks = computed(() => {
  const p = props.percentiles
  if (!p) return []
  return Object.keys(p)
    .map(Number).filter((k) => Number.isFinite(k) && Number.isFinite(p[k]))
    .sort((a, b) => a - b)
    .map((k) => ({ pct: k, ciDb: p[k] }))
})

// 门限交点：曲线上第一个 C/I ≥ 门限处的百分比 = 低于门限的时间占比
const breach = computed(() => {
  const th = Number(props.thresholdDb)
  if (!Number.isFinite(th)) return null
  const p = pts.value
  if (p.length < 2) return null
  if (th <= p[0].ciDb) return { pct: 0, below: true }
  if (th >= p[p.length - 1].ciDb) return { pct: 100, below: false }
  for (let i = 1; i < p.length; i++) {
    if (p[i].ciDb >= th) {
      const a = p[i - 1], b = p[i]
      const t = (th - a.ciDb) / (b.ciDb - a.ciDb || 1)
      return { pct: a.pct + (b.pct - a.pct) * t, below: false }
    }
  }
  return null
})
// 两个分支同构：一律「低于门限 x% 的时间」，0 就写 0%（结果区只出数，不出文字判定）。
// 指数记法只留给真正的小数（1e-3 量级）。
const fmtPct = (v) => (v <= 0 ? '0%' : v >= 1 ? v.toFixed(2) + '%' : v >= 0.01 ? v.toFixed(3) + '%' : v.toExponential(1) + '%')
// 门限标签靠近右缘时翻到竖线左侧
const thrAnchor = computed(() => (xOf(props.thresholdDb) > M.l + PW.value * 0.62 ? 'end' : 'start'))
const thrDx = computed(() => (thrAnchor.value === 'end' ? -4 : 4))

// —— 出图 ——
// 按钮长在图上：外层不必先判断「当前是哪张图」，图自己知道自己叫什么、画的是什么。
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
    const r = await exportSvgPng(svgEl.value, props.fileName || props.title)
    if (r && r.ok) { const fp = outPath(r); N.toastFile('已导出：' + String(fp).split(/[\\/]/).pop(), fp) }
    else if (r && !r.canceled && !r.missing) N.toastError('导出失败：' + (r.error || ''))
  } finally { busy.value = false }
}
defineExpose({ svg: svgEl, exportPng })
</script>

<template>
  <div ref="wrapEl" class="ci-cdf" :style="serVars">
    <div class="ci-fig-hd">
      <b class="ci-fig-name">{{ title }}</b>
      <span class="ci-fig-sp" />
      <NoticeLine :n="N" />
      <button
        v-if="canExportPng" class="ci-fig-exp" :disabled="busy || pts.length < 2"
        :title="`导出为 PNG 图片（${PNG_SCALE} 倍分辨率）`" @click="exportPng">导出</button>
    </div>
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H">
      <!-- 绘图区 -->
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="pl-bg" />

      <!-- 纵轴网格与刻度 -->
      <g v-for="p in Y_TICKS" :key="'y' + p">
        <line :x1="M.l" :y1="yOf(p)" :x2="M.l + PW" :y2="yOf(p)" class="pl-grid" />
        <text :x="M.l - 5" :y="yLabelY(p)" class="pl-tick" text-anchor="end" dominant-baseline="middle">{{ yLabel(p) }}</text>
      </g>
      <!-- 横轴网格与刻度 -->
      <g v-for="v in xTicks" :key="'x' + v">
        <line :x1="xOf(v)" :y1="M.t" :x2="xOf(v)" :y2="M.t + PH" class="pl-grid" />
        <text :x="xOf(v)" :y="M.t + PH + FS + 4" class="pl-tick" text-anchor="middle">{{ v }}</text>
      </g>

      <!-- 门限竖线 + 越限占比 -->
      <template v-if="Number.isFinite(Number(thresholdDb))">
        <line :x1="xOf(thresholdDb)" :y1="M.t" :x2="xOf(thresholdDb)" :y2="M.t + PH" class="pl-thr" />
        <text :x="xOf(thresholdDb) + thrDx" :y="M.t + FS + 2" :text-anchor="thrAnchor" class="pl-thr-lab">门限 {{ thresholdDb }} dB</text>
        <template v-if="breach">
          <circle v-if="breach.pct > 0" :cx="xOf(thresholdDb)" :cy="yOf(breach.pct)" r="3" class="pl-breach" />
          <text
            :x="xOf(thresholdDb) + thrDx"
            :y="breach.pct > 0 ? Math.max(M.t + 2 * FS + 6, yOf(breach.pct) - 5) : M.t + PH - 6"
            :text-anchor="thrAnchor" class="pl-breach-lab">低于门限 {{ fmtPct(breach.pct) }} 的时间</text>
        </template>
      </template>

      <!-- CDF 曲线 -->
      <path :d="pathD" class="pl-line" />

      <!-- 工程分位标记 -->
      <g v-for="m in marks" :key="'m' + m.pct">
        <circle :cx="xOf(m.ciDb)" :cy="yOf(m.pct)" r="2.4" class="pl-dot" />
      </g>

      <!-- 中位线 -->
      <template v-if="Number.isFinite(Number(medianCiDb))">
        <line :x1="xOf(medianCiDb)" :y1="yOf(50)" :x2="xOf(medianCiDb)" :y2="M.t + PH" class="pl-median" />
      </template>

      <!-- 轴名 -->
      <text :x="M.l + PW / 2" :y="H - 6" class="pl-axis" text-anchor="middle">C/I (dB)</text>
      <text :x="14" :y="M.t + PH / 2" class="pl-axis" text-anchor="middle"
        :transform="`rotate(-90 14 ${M.t + PH / 2})`">超越时间 (%)</text>
    </svg>
    <p v-if="pts.length < 2" class="ci-cdf-empty">尚无扫描结果。</p>
  </div>
</template>

<style scoped>
.ci-cdf { width: 100%; min-width: 0; }
.ci-cdf svg { display: block; max-width: 100%; }

/* 题行：图名 + 出图。与 CiSeriesPlot 同一份（两图是并列的一对，样式一向各存各的） */
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
.pl-axis { font-size: 11px; fill: var(--text-muted); font-weight: 600; }

.pl-line { fill: none; stroke: var(--plot-s0); stroke-width: 1.8; stroke-linejoin: round; stroke-linecap: round; }
.pl-dot { fill: var(--plot-s0); stroke: var(--surface-2); stroke-width: 1; }
.pl-median { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; }

.pl-thr { stroke: var(--warn); stroke-width: 1.2; stroke-dasharray: 4 3; }
.pl-thr-lab { font-size: 11px; fill: var(--warn); font-weight: 600; }
.pl-breach { fill: var(--warn); stroke: var(--surface-2); stroke-width: 1; }
.pl-breach-lab { font-size: 11px; fill: var(--warn); font-variant-numeric: tabular-nums; }

.ci-cdf-empty { margin: 6px 0 0; text-align: center; font-size: var(--fs-3); color: var(--text-muted); }
</style>
