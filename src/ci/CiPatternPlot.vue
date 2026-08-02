<script setup>
// 地球站天线方向图切面图（pattern cut）—— C/ASI 的主图。
//
// ─── 为什么是这张，而不是极坐标环图 ────────────────────────────────────────
// 环图只能表达「干扰星在几度」，表达不了「那个角度上天线给多少增益」。而 C/ASI 的物理
// 全在后者：鉴别度 = 峰值增益 − G(θ)。所以真正该画的是**方向图本身**——
// 横轴离轴角、纵轴增益，把包络画成一条真实曲线，干扰星就落在这条曲线上。
// 这是 MATLAB antenna toolbox 的 pattern cut、也是 ITU 建议书里方向图的标准画法。
//
// ─── 三个刻意的选择 ────────────────────────────────────────────────────────
//   ① 横轴取**对数**：主瓣宽度常在 0.2°、远旁瓣要看到 180°，跨三个数量级。
//      线性轴会把整个主瓣压成贴着纵轴的一条竖线——正是环图看不清的同一个毛病。
//   ② 纵轴锚在峰值：右侧副刻度直接标**鉴别度**（峰值 − 增益），读图不必心算。
//   ③ 干扰星画在曲线上并向下引垂线到横轴：一眼看到它踩在方向图的哪一段
//      （主瓣 / φ₁ 拐点 / 29−25lgφ 斜坡 / 远场底板），这决定了鉴别度是几 dB。
import { computed } from 'vue'
import { layoutLabels } from './ciPlotLabels.js'

const props = defineProps({
  curve: { type: Array, default: () => [] },        // [{deg, gainDbi}]，对数角度轴采样
  marks: { type: Array, default: () => [] },        // [{deg, gainDbi, key, label}] AP8 结构角
  sources: { type: Array, default: () => [] },      // 干扰源
  peakGainDbi: { type: Number, default: null },
  hoveredId: { type: String, default: '' }
})
const emit = defineEmits(['hover'])

const W = 460, H = 250
const M = { l: 46, r: 46, t: 14, b: 34 }
const PW = W - M.l - M.r, PH = H - M.t - M.b

const live = computed(() => (props.sources || []).filter((s) => !s.skipped && Number.isFinite(Number(s.thetaDeg))))

// 横轴：对数角度。下界取「最近那颗干扰星 / 主瓣半宽」再退一档，上界固定 180°
const xDomain = computed(() => {
  const degs = props.curve.map((p) => p.deg).filter((d) => d > 0)
  if (!degs.length) return [0.05, 180]
  let lo = 0.05
  const minSrc = live.value.reduce((m, s) => Math.min(m, Number(s.thetaDeg)), Infinity)
  const firstMark = props.marks.length ? props.marks[0].deg : Infinity
  const want = Math.min(minSrc, firstMark)
  if (Number.isFinite(want) && want > 0) lo = Math.max(0.01, Math.pow(10, Math.floor(Math.log10(want)) - 0.3))
  return [lo, 180]
})
const xOf = (deg) => {
  const [lo, hi] = xDomain.value
  const d = Math.max(lo, Math.min(hi, Number(deg) || lo))
  return M.l + PW * (Math.log10(d) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
}

// 纵轴：增益 dBi
const yDomain = computed(() => {
  const gs = props.curve.map((p) => p.gainDbi).filter(Number.isFinite)
  if (!gs.length) return [-15, 55]
  const hi = Math.max(...gs, Number(props.peakGainDbi) || -Infinity)
  const lo = Math.min(...gs)
  const pad = Math.max(2, (hi - lo) * 0.06)
  return [Math.floor((lo - pad) / 5) * 5, Math.ceil((hi + pad) / 5) * 5]
})
const yOf = (g) => {
  const [lo, hi] = yDomain.value
  return M.t + PH * (1 - (Math.max(lo, Math.min(hi, Number(g))) - lo) / (hi - lo))
}

const pathD = computed(() => {
  const c = props.curve.filter((p) => p.deg >= xDomain.value[0])
  if (c.length < 2) return ''
  return c.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.deg).toFixed(2)},${yOf(p.gainDbi).toFixed(2)}`).join(' ')
})

// 横轴刻度：每个数量级 + 1/2/5 中间档
const xTicks = computed(() => {
  const [lo, hi] = xDomain.value
  const out = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e)
      if (v >= lo && v <= hi) out.push(v)
    }
  }
  if (!out.includes(180) && hi >= 180) out.push(180)
  return out
})
const fmtDeg = (v) => (v >= 10 ? String(Math.round(v)) : v >= 1 ? v.toFixed(0) : v.toFixed(2).replace(/0$/, ''))

const yTicks = computed(() => {
  const [lo, hi] = yDomain.value
  const step = (hi - lo) > 60 ? 20 : (hi - lo) > 30 ? 10 : 5
  const out = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v)
  return out
})

// 干扰星落点：按增益排序后自上而下错开标签，避免叠字（截图里那一坨就是没做这一步）。
// 推开的边界与「被推开就排成一列」两件事交给 ciPlotLabels——与上行图共用一套，
// 免得两张图在密集时表现不一致（上行那张已经因为缺边界把整叠推到轴名上过一次）。
const pts = computed(() => {
  const arr = live.value.map((s) => ({
    id: String(s.id || s.name || ''), name: s.name || s.id,
    deg: Number(s.thetaDeg), gainDbi: Number(s.offAxisGainDbi),
    discrimDb: Number(s.discrimDb), ciDb: Number(s.ciDb), sharePct: Number(s.sharePct),
    text: `${s.name || s.id} · ${fmtAng(s.thetaDeg)}° · 鉴别 ${fmt(s.discrimDb, 1)}dB`,
    x: xOf(s.thetaDeg), y: yOf(s.offAxisGainDbi)
  }))
  return layoutLabels(arr, { top: M.t + 5, bottom: M.t + PH - 6, left: M.l, right: M.l + PW })
})

const fmt = (v, n = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : '—')
// 角度按量级给小数位：共址邻星的拓扑角可以是 0.003°，写死两位小数会印成「0.00°」
const fmtAng = (v) => {
  const d = Number(v)
  if (!Number.isFinite(d)) return '—'
  return d >= 10 ? d.toFixed(1) : d >= 1 ? d.toFixed(2) : d >= 0.1 ? d.toFixed(3) : d.toFixed(4)
}
</script>

<template>
  <div class="ci-pat">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="bg" />

      <!-- 网格 -->
      <g v-for="v in xTicks" :key="'x' + v">
        <line :x1="xOf(v)" :y1="M.t" :x2="xOf(v)" :y2="M.t + PH" class="grid" />
        <text :x="xOf(v)" :y="M.t + PH + 11" class="tick" text-anchor="middle">{{ fmtDeg(v) }}</text>
      </g>
      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="M.l" :y1="yOf(v)" :x2="M.l + PW" :y2="yOf(v)" class="grid" />
        <text :x="M.l - 4" :y="yOf(v)" class="tick" text-anchor="end" dominant-baseline="middle">{{ v }}</text>
        <!-- 右侧副刻度 = 鉴别度（峰值 − 增益），读图不必心算 -->
        <text v-if="Number.isFinite(Number(peakGainDbi))" :x="M.l + PW + 4" :y="yOf(v)" class="tick dim" dominant-baseline="middle">{{ fmt(peakGainDbi - v, 0) }}</text>
      </g>

      <!-- AP8 结构角：竖线 + 顶部标签 -->
      <g v-for="(m, i) in marks" :key="'m' + m.key">
        <line :x1="xOf(m.deg)" :y1="M.t" :x2="xOf(m.deg)" :y2="M.t + PH" class="mark" :class="m.key" />
        <text :x="xOf(m.deg) + 2" :y="M.t + 8 + (i % 2) * 8" class="mark-lab" :class="m.key">{{ m.label }}</text>
      </g>

      <!-- 峰值参考线 -->
      <template v-if="Number.isFinite(Number(peakGainDbi))">
        <line :x1="M.l" :y1="yOf(peakGainDbi)" :x2="M.l + PW" :y2="yOf(peakGainDbi)" class="peak" />
        <text :x="M.l + 3" :y="yOf(peakGainDbi) - 2.5" class="peak-lab">峰值 {{ fmt(peakGainDbi, 1) }} dBi</text>
      </template>

      <!-- 方向图曲线 -->
      <path :d="pathD" class="curve" />

      <!-- 干扰星：曲线上的点 + 垂线 + 错开的标签 -->
      <g
        v-for="p in pts" :key="p.id"
        class="src" :class="{ hot: hoveredId && p.id === hoveredId }"
        @mouseenter="emit('hover', p.id)" @mouseleave="emit('hover', '')">
        <line :x1="p.x" :y1="p.y" :x2="p.x" :y2="M.t + PH" class="drop" />
        <circle :cx="p.x" :cy="p.y" r="3.2" />
        <line
          v-if="p.displaced"
          :x1="p.x + (p.anchor === 'end' ? -4 : 4)" :y1="p.y"
          :x2="p.labelX + (p.anchor === 'end' ? 1.5 : -1.5)" :y2="p.labelY" class="lead" />
        <text :x="p.labelX" :y="p.labelY" class="src-lab" :text-anchor="p.anchor" dominant-baseline="middle">{{ p.text }}</text>
        <title>{{ p.name }}
离轴角 {{ fmtAng(p.deg) }}°
该处增益 {{ fmt(p.gainDbi, 2) }} dBi
鉴别度 {{ fmt(p.discrimDb, 2) }} dB
C/I {{ fmt(p.ciDb, 2) }} dB<template v-if="Number.isFinite(p.sharePct)">
占总干扰 {{ fmt(p.sharePct, 1) }}%</template></title>
      </g>

      <!-- 轴名 -->
      <text :x="M.l + PW / 2" :y="H - 4" class="axis" text-anchor="middle">离轴角 φ（度，对数轴）</text>
      <text :x="11" :y="M.t + PH / 2" class="axis" text-anchor="middle" :transform="`rotate(-90 11 ${M.t + PH / 2})`">增益（dBi）</text>
      <text :x="W - 9" :y="M.t + PH / 2" class="axis dim" text-anchor="middle" :transform="`rotate(90 ${W - 9} ${M.t + PH / 2})`">鉴别度（dB）</text>
    </svg>
    <p v-if="!curve.length" class="empty">请先计算。</p>
  </div>
</template>

<style scoped>
.ci-pat { width: 100%; }
.ci-pat svg { width: 100%; height: auto; display: block; }

.bg { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 0.7; }
.grid { stroke: var(--border); stroke-width: 0.4; }
.tick { font-size: 7.5px; fill: var(--text-muted); }
.tick.dim { opacity: 0.65; }
.axis { font-size: 8px; fill: var(--text-muted); font-weight: 600; }
.axis.dim { opacity: 0.7; font-weight: 500; }

.curve { fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linejoin: round; }
.peak { stroke: var(--text-muted); stroke-width: 0.6; stroke-dasharray: 3 2; }
.peak-lab { font-size: 7px; fill: var(--text-muted); }

/* 结构角：主瓣边界与远场底板用不同虚线密度区分层级，不另加颜色 */
.mark { stroke: var(--text-muted); stroke-width: 0.5; stroke-dasharray: 2 2.5; opacity: 0.55; }
.mark.hpbw, .mark.phi1 { stroke-dasharray: 3.5 1.5; opacity: 0.8; }
.mark-lab { font-size: 6.6px; fill: var(--text-muted); opacity: 0.85; }
.mark-lab.hpbw, .mark-lab.phi1 { font-weight: 600; opacity: 1; }

.drop { stroke: var(--warn, #d08a2e); stroke-width: 0.5; stroke-dasharray: 1.5 1.5; opacity: 0.5; }
.lead { stroke: var(--warn, #d08a2e); stroke-width: 0.5; opacity: 0.7; }
.src circle { fill: var(--warn, #d08a2e); stroke: var(--surface); stroke-width: 0.9; cursor: pointer; }
.src:hover circle, .src.hot circle { r: 4.2; stroke: var(--text); }
.src-lab { font-size: 7.4px; fill: var(--text); pointer-events: none; }
.src:hover .src-lab, .src.hot .src-lab { font-weight: 700; }
.src:hover .drop, .src.hot .drop { opacity: 1; stroke-width: 0.8; }

.empty { margin: 8px 0 0; text-align: center; font-size: 12px; color: var(--text-muted); }
</style>
