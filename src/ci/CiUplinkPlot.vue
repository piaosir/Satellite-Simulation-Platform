<script setup>
// 上行干扰几何 —— 离轴 EIRP 密度切面图。
//
// ─── 为什么不能拿下行那张图凑 ──────────────────────────────────────────────
// 下行画的是**本站接收天线**的方向图：干扰漏进来多少，由「我这面天线在那个角度上给多少
// 增益」决定。上行的施扰者不是我，是**邻网的发射站**——它朝自己的星发，旁瓣泼进本星。
// 决定量的是那座站往外泼多少 EIRP 密度，用的是它自己的天线、它自己看到的夹角
// （非共址时与本站看到的拓扑角不是一个数）。两件事，两张图。
//
// ─── 纵轴为什么取 dBW/Hz 而不是 dBi ────────────────────────────────────────
// 三种干扰源模型只有在「离轴 EIRP 密度」上才对得起来：S.524 掩模模式根本没有天线，
// 建议书给的就是密度上限。统一到密度轴后，同一张图上能同时读出三件事：
//   · 红虚线 = S.524 监管天花板（掩模模式的干扰源就取在这条线上）
//   · 实线   = 对等站按一副真天线算出来的实际泼洒 —— 与天花板的落差就是那 27 dB
//   · 水平线 = 本站上行 EIRP 密度，即 C；**它到干扰点的垂直距离就是该源的 C/I**
// 右侧副轴直接把这段距离标成 C/I，读图不必心算——与下行图右轴标鉴别度是同一套做法。
import { computed, ref } from 'vue'
import { layoutLabels, textWidth } from './ciPlotLabels.js'
import { PLOT_FS as FS, usePlotWidth, usePlotSeriesVars } from './ciPlotKit.js'

const props = defineProps({
  ownDensityDbWPerHz: { type: Number, default: null },
  maskCurve: { type: Array, default: () => [] },      // [{deg, densityDbWPerHz, belowScope}]
  maskMarks: { type: Array, default: () => [] },
  maskBand: { type: String, default: '' },
  maskAuthoritative: { type: Boolean, default: false },
  maskPhi0Deg: { type: Number, default: null },
  peerCurves: { type: Array, default: () => [] },     // [{key, diameterM, mainLobeDeg, curve:[…]}]
  sources: { type: Array, default: () => [] },
  hoveredId: { type: String, default: '' },
  peerPatternName: { type: String, default: '' }      // 对等站所用地球站方向图（名称），并进图例，导出的 PNG 自带出处
})
const emit = defineEmits(['hover'])

// 排版：viewBox 宽 = 容器实宽，字号恒 11 px（见 ciPlotKit）；图例在图内顶行，导出 PNG 一并带上
const wrapEl = ref(null), svgEl = ref(null)
const W = usePlotWidth(wrapEl, 460)
const serVars = usePlotSeriesVars()
const H = 306
const M = { l: 60, r: 56, t: 32, b: 42 }
const PW = computed(() => W.value - M.l - M.r)
const PH = H - M.t - M.b

const fmt = (v, n = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(n) : '—')
// 角度按量级给小数位：共址邻星的离轴角可以是 0.003°，写死两位小数会印成「0.00°」——
// 一个恒等于零的读数比不写还糟（它把「贴着主轴」误读成「就在主轴上，无需分辨」）。
const fmtAng = (v) => {
  const d = Number(v)
  if (!Number.isFinite(d)) return '—'
  return d >= 10 ? d.toFixed(1) : d >= 1 ? d.toFixed(2) : d >= 0.1 ? d.toFixed(3) : d.toFixed(4)
}
const live = computed(() => (props.sources || []).filter((s) => Number.isFinite(Number(s.offAxisDeg))))
const hasData = computed(() => props.maskCurve.length > 0 || props.peerCurves.some((c) => c.curve && c.curve.length))

// 横轴：对数角度。下界退到「最近的干扰源 / φ₀ / 对等站主瓣半宽」再低一档，但**不越过曲线
// 自身的采样下限**——共址邻星的离轴角可低到 0.003°，照它定标会拉出三个空白数量级（那一段
// 一条线也没有）。落在下限以内的源钉在左边缘：方向图在主瓣内本就平，钉过去几乎无误差，
// 真实角度由标签给出。
const curveFloorDeg = computed(() => {
  let lo = Infinity
  if (props.maskCurve.length) lo = Math.min(lo, props.maskCurve[0].deg)
  for (const c of props.peerCurves) if (c.curve && c.curve.length) lo = Math.min(lo, c.curve[0].deg)
  return Number.isFinite(lo) ? lo : 0.05
})
const xDomain = computed(() => {
  let want = Infinity
  for (const s of live.value) want = Math.min(want, Number(s.offAxisDeg))
  if (Number.isFinite(Number(props.maskPhi0Deg))) want = Math.min(want, Number(props.maskPhi0Deg))
  for (const c of props.peerCurves) if (Number(c.mainLobeDeg) > 0) want = Math.min(want, Number(c.mainLobeDeg))
  const lo = Number.isFinite(want) && want > 0
    ? Math.max(curveFloorDeg.value, Math.pow(10, Math.floor(Math.log10(want)) - 0.3))
    : 0.5
  return [lo, 180]
})
const xOf = (deg) => {
  const [lo, hi] = xDomain.value
  const d = Math.max(lo, Math.min(hi, Number(deg) || lo))
  return M.l + PW.value * (Math.log10(d) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
}

// 纵轴：EIRP 谱密度 dBW/Hz。量程按**可见段**取——横轴左端裁掉的那部分曲线不该撑高量程。
const yDomain = computed(() => {
  const lo0 = xDomain.value[0]
  const vals = []
  const push = (arr) => { for (const p of arr) if (p.deg >= lo0 && Number.isFinite(p.densityDbWPerHz)) vals.push(p.densityDbWPerHz) }
  push(props.maskCurve)
  for (const c of props.peerCurves) push(c.curve || [])
  for (const s of live.value) {
    if (Number.isFinite(Number(s.interfererDensityDbWPerHz))) vals.push(Number(s.interfererDensityDbWPerHz))
    if (Number.isFinite(Number(s.effectiveDensityDbWPerHz))) vals.push(Number(s.effectiveDensityDbWPerHz))
  }
  if (Number.isFinite(Number(props.ownDensityDbWPerHz))) vals.push(Number(props.ownDensityDbWPerHz))
  if (!vals.length) return [-80, 0]
  const hi = Math.max(...vals), lo = Math.min(...vals)
  const pad = Math.max(2, (hi - lo) * 0.06)
  return [Math.floor((lo - pad) / 5) * 5, Math.ceil((hi + pad) / 5) * 5]
})
const yOf = (v) => {
  const [lo, hi] = yDomain.value
  return M.t + PH * (1 - (Math.max(lo, Math.min(hi, Number(v))) - lo) / (hi - lo))
}

const pathOf = (arr) => {
  const c = (arr || []).filter((p) => p.deg >= xDomain.value[0] && Number.isFinite(p.densityDbWPerHz))
  if (c.length < 2) return ''
  return c.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.deg).toFixed(2)},${yOf(p.densityDbWPerHz).toFixed(2)}`).join(' ')
}

// 掩模拆两段：φ < φ₀ 建议书**不设限**（值按 φ₀ 处连续钳住），画成点线并另标 —— 画成实线
// 会让人以为主瓣区也有这么一条限值。
const maskPathIn = computed(() => pathOf(props.maskCurve.filter((p) => !p.belowScope)))
const maskPathOut = computed(() => pathOf(props.maskCurve.filter((p) => p.belowScope)))
const peerPaths = computed(() => props.peerCurves.map((c) => ({ key: c.key, diameterM: c.diameterM, d: pathOf(c.curve) })).filter((c) => c.d))

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

// 干扰源落点。曲线上的那个点是**原始离轴密度**；卫星鉴别 / 极化 / 频谱重叠三项折减后落到
// 等效密度上——两者不同就画一段虚线连起来，那段长度即这三项一共给了多少 dB。
//
// 标签排布交给 ciPlotLabels：「逐站给定」模式下每座站可以填成同一个密度，五个落点严丝合缝
// 叠在同一高度上——首版只会一路往下推，整叠压到横轴刻度和轴名上。
const pts = computed(() => {
  const arr = live.value.map((s) => {
    const raw = Number(s.interfererDensityDbWPerHz)
    const eff = Number.isFinite(Number(s.effectiveDensityDbWPerHz)) ? Number(s.effectiveDensityDbWPerHz) : raw
    return {
      id: String(s.id || s.name || ''), name: s.name || s.id,
      deg: Number(s.offAxisDeg), raw, eff,
      ciDb: Number(s.ciDb), sharePct: Number(s.sharePct),
      belowScope: !!s.maskBelowScope,
      extraDb: raw - eff,
      text: `${s.name || s.id} · ${fmtAng(s.offAxisDeg)}° · C/I ${fmt(s.ciDb, 1)} dB`,
      x: xOf(s.offAxisDeg), y: yOf(eff), yRaw: yOf(raw), yEff: yOf(eff)
    }
  })
  return layoutLabels(arr, { top: M.t + 5, bottom: M.t + PH - 6, left: M.l, right: M.l + PW.value }, { fontSize: FS, lineH: FS + 4, gap: 10 })
})

const ownY = computed(() => (Number.isFinite(Number(props.ownDensityDbWPerHz)) ? yOf(props.ownDensityDbWPerHz) : null))
// 图例：一行排不下就折到下一行，整组向上叠
const legend = computed(() => {
  const items = [{ k: 'mask', text: 'S.524 掩模' + (props.maskBand ? ' · ' + props.maskBand : '') }]
  for (const c of peerPaths.value) items.push({ k: 'peer', text: '对等站 Ø' + fmt(c.diameterM, 1) + ' m' + (props.peerPatternName ? ' · ' + props.peerPatternName : '') })
  if (ownY.value != null) items.push({ k: 'own', text: '本站上行密度（C）' })
  items.push({ k: 'src', text: '干扰源落点' })
  let x = M.l, row = 0
  for (const it of items) {
    const w = 22 + textWidth(it.text, FS)
    if (x > M.l && x + w > M.l + PW.value) { x = M.l; row++ }
    it.x = x; it.row = row; x += w + 14
  }
  for (const it of items) it.y = M.t - 12 - (row - it.row) * (FS + 4)
  return items
})
const belowScopeNames = computed(() => live.value.filter((s) => s.maskBelowScope).map((s) => s.name || s.id))
defineExpose({ svg: svgEl })
</script>

<template>
  <div ref="wrapEl" class="ci-up" :style="serVars">
    <svg ref="svgEl" :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H">
      <g v-for="(it, i) in (hasData ? legend : [])" :key="'lg' + i">
        <circle v-if="it.k === 'src'" :cx="it.x + 9" :cy="it.y" r="3.6" class="lg-src" />
        <line v-else :x1="it.x" :y1="it.y" :x2="it.x + 18" :y2="it.y" :class="it.k" />
        <text :x="it.x + 22" :y="it.y" class="tick" dominant-baseline="middle">{{ it.text }}</text>
      </g>
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="bg" />

      <g v-for="v in xTicks" :key="'x' + v">
        <line :x1="xOf(v)" :y1="M.t" :x2="xOf(v)" :y2="M.t + PH" class="grid" />
        <text :x="xOf(v)" :y="M.t + PH + FS + 4" class="tick" text-anchor="middle">{{ fmtDeg(v) }}</text>
      </g>
      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="M.l" :y1="yOf(v)" :x2="M.l + PW" :y2="yOf(v)" class="grid" />
        <text :x="M.l - 4" :y="yOf(v)" class="tick" text-anchor="end" dominant-baseline="middle">{{ v }}</text>
        <!-- 右侧副轴 = C/I（本站密度 − 该高度），读图不必心算 -->
        <text v-if="ownY != null" :x="M.l + PW + 5" :y="yOf(v)" class="tick dim" dominant-baseline="middle">{{ fmt(ownDensityDbWPerHz - v, 0) }}</text>
      </g>

      <!-- S.524 的分段结构角 -->
      <g v-for="(m, i) in maskMarks" :key="'m' + m.key">
        <line :x1="xOf(m.deg)" :y1="M.t" :x2="xOf(m.deg)" :y2="M.t + PH" class="mark" :class="m.key" />
        <text :x="xOf(m.deg) + 2" :y="M.t + FS + (i % 2) * (FS + 2)" class="mark-lab">{{ m.label }}</text>
      </g>

      <!-- 本站上行 EIRP 密度 = C。它到干扰点的垂直距离就是 C/I -->
      <template v-if="ownY != null">
        <line :x1="M.l" :y1="ownY" :x2="M.l + PW" :y2="ownY" class="own" />
        <text :x="M.l + 3" :y="ownY - 4" class="own-lab">本站上行密度 {{ fmt(ownDensityDbWPerHz, 1) }} dBW/Hz</text>
      </template>

      <!-- S.524 掩模：监管天花板。φ<φ₀ 那段建议书不设限，点线示意 -->
      <path v-if="maskPathOut" :d="maskPathOut" class="mask out" />
      <path v-if="maskPathIn" :d="maskPathIn" class="mask" />

      <!-- 对等站：按一副真天线算出来的实际离轴泼洒 -->
      <path v-for="c in peerPaths" :key="c.key" :d="c.d" class="peer" />

      <g
        v-for="p in pts" :key="p.id"
        class="src" :class="{ hot: hoveredId && p.id === hoveredId }"
        @mouseenter="emit('hover', p.id)" @mouseleave="emit('hover', '')">
        <line :x1="p.x" :y1="p.yEff" :x2="p.x" :y2="M.t + PH" class="drop" />
        <!-- 折减不为零：曲线上的原始密度 → 折减 → 等效密度 -->
        <template v-if="Math.abs(p.extraDb) > 0.05">
          <line :x1="p.x" :y1="p.yRaw" :x2="p.x" :y2="p.yEff" class="cut" />
          <circle :cx="p.x" :cy="p.yRaw" r="3" class="raw" />
        </template>
        <circle :cx="p.x" :cy="p.yEff" r="3.6" />
        <line
          v-if="p.displaced"
          :x1="p.x + (p.anchor === 'end' ? -4 : 4)" :y1="p.yEff"
          :x2="p.labelX + (p.anchor === 'end' ? 1.5 : -1.5)" :y2="p.labelY" class="lead" />
        <text :x="p.labelX" :y="p.labelY" class="src-lab" :text-anchor="p.anchor" dominant-baseline="middle">{{ p.text }}</text>
        <title>{{ p.name }}
干扰站离轴角 {{ fmtAng(p.deg) }}°<template v-if="p.belowScope">（在 S.524 的 φ₀ 以内，建议书对该角不设限）</template>
离轴 EIRP 密度 {{ fmt(p.raw, 2) }} dBW/Hz<template v-if="Math.abs(p.extraDb) > 0.05">
卫星鉴别 / 极化 / 重叠折减 {{ fmt(p.extraDb, 2) }} dB
等效密度 {{ fmt(p.eff, 2) }} dBW/Hz</template>
C/I {{ fmt(p.ciDb, 2) }} dB<template v-if="Number.isFinite(p.sharePct)">
占总干扰 {{ fmt(p.sharePct, 1) }}%</template></title>
      </g>

      <text :x="M.l + PW / 2" :y="H - 6" class="axis" text-anchor="middle">干扰站离轴角 φ (°)</text>
      <text :x="14" :y="M.t + PH / 2" class="axis" text-anchor="middle" :transform="`rotate(-90 14 ${M.t + PH / 2})`">离轴 EIRP 密度 (dBW/Hz)</text>
      <text :x="W - 12" :y="M.t + PH / 2" class="axis dim" text-anchor="middle" :transform="`rotate(90 ${W - 12} ${M.t + PH / 2})`">C/I (dB)</text>
    </svg>

    <p v-if="belowScopeNames.length" class="warn sm">
      {{ belowScopeNames.join('、') }} 的离轴角在 S.524 的 φ₀ 以内，此处取 φ₀ 处的钳位值。
    </p>
    <p v-if="!maskAuthoritative && maskCurve.length" class="warn sm" title="外推结果不应标注为「ITU-R S.524-9」">
      该频率不在 S.524-9 正文明列的三个频段内，掩模按邻近频段外推，仅可作量级参照。
    </p>
    <p v-if="!hasData" class="empty">尚未计算。</p>
  </div>
</template>

<style scoped>
.ci-up { width: 100%; min-width: 0; }
.ci-up svg { display: block; max-width: 100%; }
/* 字号恒 11 px（viewBox 单位 = CSS px），线宽按 px 给 */

.bg { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 1; }
.grid { stroke: var(--border); stroke-width: 1; }
.tick { font-size: 11px; fill: var(--text-muted); font-variant-numeric: tabular-nums; }
.tick.dim { opacity: 0.75; }
.axis { font-size: 11px; fill: var(--text-muted); font-weight: 600; }
.axis.dim { opacity: 0.7; font-weight: 500; }

/* 三条线各自的语言：天花板用告警色虚线、实际泼洒用主色实线、本站载波用中性虚线 */
.mask { fill: none; stroke: var(--danger); stroke-width: 1.5; stroke-dasharray: 6 3; stroke-linejoin: round; }
.mask.out { stroke-dasharray: 1.5 3; opacity: 0.45; }
.peer { fill: none; stroke: var(--plot-s0); stroke-width: 1.8; stroke-linejoin: round; }
.own { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 4 3; }
.own-lab { font-size: 11px; fill: var(--text-muted); }

.mark { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; opacity: 0.5; }
.mark.phi0 { stroke-dasharray: 5 2; opacity: 0.75; }
.mark-lab { font-size: 11px; fill: var(--text-muted); opacity: 0.85; }

.drop { stroke: var(--warn); stroke-width: 1; stroke-dasharray: 2 2; opacity: 0.5; }
.cut { stroke: var(--warn); stroke-width: 1.2; stroke-dasharray: 3 2; opacity: 0.9; }
.lead { stroke: var(--warn); stroke-width: 1; opacity: 0.7; }
.src circle, .lg-src { fill: var(--warn); stroke: var(--surface-2); stroke-width: 1.2; cursor: pointer; }
.src circle.raw { fill: none; stroke: var(--warn); stroke-width: 1.2; }
.src:hover circle, .src.hot circle { stroke: var(--text); }
.src-lab { font-size: 11px; fill: var(--text); pointer-events: none; }
.src:hover .src-lab, .src.hot .src-lab { font-weight: 700; }
.src:hover .drop, .src.hot .drop { opacity: 1; stroke-width: 1.4; }


.warn { margin: 6px 0 0; font-size: var(--fs-2); line-height: 1.5; color: var(--warn); }
.empty { margin: 8px 0 0; text-align: center; font-size: var(--fs-3); color: var(--text-muted); }
</style>
