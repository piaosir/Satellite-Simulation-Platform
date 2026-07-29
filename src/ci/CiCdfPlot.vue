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
import { computed, ref } from 'vue'
import { exportSvgPng, canExportPng, PNG_SCALE } from './ciFigureExport.js'

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

// 绘图矩形（viewBox 单位）
const W = 320, H = 200
const M = { l: 44, r: 12, t: 12, b: 30 }
const PW = W - M.l - M.r, PH = H - M.t - M.b

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
  return M.l + PW * ((Number(v) - lo) / (hi - lo))
}

const pathD = computed(() => {
  const p = pts.value
  if (p.length < 2) return ''
  return p.map((d, i) => `${i ? 'L' : 'M'}${xOf(d.ciDb).toFixed(2)},${yOf(d.pct).toFixed(2)}`).join(' ')
})

// 纵轴刻度（每个数量级 + 中间的 50%）
const Y_TICKS = [0.001, 0.01, 0.1, 1, 10, 50, 100]
const yLabel = (p) => (p >= 1 ? p + '%' : p.toString().replace(/^0/, '') + '%')

// 横轴刻度：在定义域上取 5 档整数
const xTicks = computed(() => {
  const [lo, hi] = xDomain.value
  const span = hi - lo
  const raw = span / 4
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6))
  return out
})

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
// 0 要显式说成「全时段高于门限」而不是「低于门限 0%」——后者读起来像「刚好卡在门限上」，
// 而实际情形是门限整个落在曲线左侧，一次都没越过。指数记法只留给真正的小数（1e-3 量级）。
const fmtPct = (v) => (v <= 0 ? '0%' : v >= 1 ? v.toFixed(2) + '%' : v >= 0.01 ? v.toFixed(3) + '%' : v.toExponential(1) + '%')

// —— 出图 ——
// 按钮长在图上：外层不必先判断「当前是哪张图」，图自己知道自己叫什么、画的是什么。
const svgEl = ref(null)
const busy = ref(false)
async function exportPng() {
  if (busy.value) return
  busy.value = true
  try { await exportSvgPng(svgEl.value, props.fileName || props.title) }
  finally { busy.value = false }
}
defineExpose({ svg: svgEl, exportPng })
</script>

<template>
  <div class="ci-cdf">
    <div class="ci-fig-hd">
      <b class="ci-fig-name">{{ title }}</b>
      <span class="ci-fig-sp" />
      <button
        v-if="canExportPng" class="ci-fig-exp" :disabled="busy || pts.length < 2"
        :title="`导出为 PNG 图片（${PNG_SCALE} 倍分辨率）`" @click="exportPng">出图</button>
    </div>
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
      <!-- 绘图区 -->
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="pl-bg" />

      <!-- 纵轴网格与刻度 -->
      <g v-for="p in Y_TICKS" :key="'y' + p">
        <line :x1="M.l" :y1="yOf(p)" :x2="M.l + PW" :y2="yOf(p)" class="pl-grid" />
        <text :x="M.l - 4" :y="yOf(p)" class="pl-tick" text-anchor="end" dominant-baseline="middle">{{ yLabel(p) }}</text>
      </g>
      <!-- 横轴网格与刻度 -->
      <g v-for="v in xTicks" :key="'x' + v">
        <line :x1="xOf(v)" :y1="M.t" :x2="xOf(v)" :y2="M.t + PH" class="pl-grid" />
        <text :x="xOf(v)" :y="M.t + PH + 10" class="pl-tick" text-anchor="middle">{{ v }}</text>
      </g>

      <!-- 门限竖线 + 越限占比 -->
      <template v-if="Number.isFinite(Number(thresholdDb))">
        <line :x1="xOf(thresholdDb)" :y1="M.t" :x2="xOf(thresholdDb)" :y2="M.t + PH" class="pl-thr" />
        <text :x="xOf(thresholdDb) + 3" :y="M.t + 8" class="pl-thr-lab">门限 {{ thresholdDb }} dB</text>
        <template v-if="breach">
          <circle v-if="breach.pct > 0" :cx="xOf(thresholdDb)" :cy="yOf(breach.pct)" r="2.4" class="pl-breach" />
          <text
            :x="xOf(thresholdDb) + 3"
            :y="breach.pct > 0 ? yOf(breach.pct) - 3 : M.t + PH - 4"
            class="pl-breach-lab">
            {{ breach.pct > 0 ? `低于门限 ${fmtPct(breach.pct)} 的时间` : '全时段高于门限' }}
          </text>
        </template>
      </template>

      <!-- CDF 曲线 -->
      <path :d="pathD" class="pl-line" />

      <!-- 工程分位标记 -->
      <g v-for="m in marks" :key="'m' + m.pct">
        <circle :cx="xOf(m.ciDb)" :cy="yOf(m.pct)" r="1.5" class="pl-dot" />
      </g>

      <!-- 中位线 -->
      <template v-if="Number.isFinite(Number(medianCiDb))">
        <line :x1="xOf(medianCiDb)" :y1="yOf(50)" :x2="xOf(medianCiDb)" :y2="M.t + PH" class="pl-median" />
      </template>

      <!-- 轴名 -->
      <text :x="M.l + PW / 2" :y="H - 4" class="pl-axis" text-anchor="middle">C/I（dB）</text>
      <text :x="10" :y="M.t + PH / 2" class="pl-axis" text-anchor="middle"
        :transform="`rotate(-90 10 ${M.t + PH / 2})`">超越时间百分比</text>
    </svg>
    <p v-if="pts.length < 2" class="ci-cdf-empty">尚无扫描结果 —— 设好星座与时窗后点「计算」</p>
  </div>
</template>

<style scoped>
.ci-cdf { width: 100%; }
.ci-cdf svg { width: 100%; height: auto; display: block; }

/* 题行：图名 + 出图。与 CiSeriesPlot 同一份（两图是并列的一对，样式一向各存各的） */
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
.pl-axis { font-size: 7.5px; fill: var(--text-muted); font-weight: 600; }

.pl-line { fill: none; stroke: var(--accent); stroke-width: 1.6; stroke-linejoin: round; stroke-linecap: round; }
.pl-dot { fill: var(--accent); stroke: var(--surface); stroke-width: 0.5; }
.pl-median { stroke: var(--text-muted); stroke-width: 0.6; stroke-dasharray: 2 2; }

.pl-thr { stroke: var(--warn, #d08a2e); stroke-width: 1; stroke-dasharray: 3 2; }
.pl-thr-lab { font-size: 6.5px; fill: var(--warn, #d08a2e); font-weight: 600; }
.pl-breach { fill: var(--warn, #d08a2e); stroke: var(--surface); stroke-width: 0.6; }
.pl-breach-lab { font-size: 6.5px; fill: var(--warn, #d08a2e); }

.ci-cdf-empty { margin: 6px 0 0; text-align: center; font-size: 12px; color: var(--text-muted); }
</style>
