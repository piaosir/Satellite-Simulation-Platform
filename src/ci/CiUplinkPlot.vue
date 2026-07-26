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
import { computed } from 'vue'
import { layoutLabels } from './ciPlotLabels.js'

const props = defineProps({
  ownDensityDbWPerHz: { type: Number, default: null },
  maskCurve: { type: Array, default: () => [] },      // [{deg, densityDbWPerHz, belowScope}]
  maskMarks: { type: Array, default: () => [] },
  maskBand: { type: String, default: '' },
  maskAuthoritative: { type: Boolean, default: false },
  maskPhi0Deg: { type: Number, default: null },
  peerCurves: { type: Array, default: () => [] },     // [{key, diameterM, mainLobeDeg, curve:[…]}]
  sources: { type: Array, default: () => [] },
  sourceMode: { type: String, default: 'peer' },
  hoveredId: { type: String, default: '' }
})
const emit = defineEmits(['hover'])

const W = 460, H = 250
const M = { l: 50, r: 48, t: 14, b: 34 }
const PW = W - M.l - M.r, PH = H - M.t - M.b

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
  return M.l + PW * (Math.log10(d) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))
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
      text: `${s.name || s.id} · ${fmtAng(s.offAxisDeg)}° · C/I ${fmt(s.ciDb, 1)}dB`,
      x: xOf(s.offAxisDeg), y: yOf(eff), yRaw: yOf(raw), yEff: yOf(eff)
    }
  })
  return layoutLabels(arr, { top: M.t + 5, bottom: M.t + PH - 6, left: M.l, right: M.l + PW })
})

const ownY = computed(() => (Number.isFinite(Number(props.ownDensityDbWPerHz)) ? yOf(props.ownDensityDbWPerHz) : null))
const belowScopeNames = computed(() => live.value.filter((s) => s.maskBelowScope).map((s) => s.name || s.id))
</script>

<template>
  <div class="ci-up">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
      <rect :x="M.l" :y="M.t" :width="PW" :height="PH" class="bg" />

      <g v-for="v in xTicks" :key="'x' + v">
        <line :x1="xOf(v)" :y1="M.t" :x2="xOf(v)" :y2="M.t + PH" class="grid" />
        <text :x="xOf(v)" :y="M.t + PH + 11" class="tick" text-anchor="middle">{{ fmtDeg(v) }}</text>
      </g>
      <g v-for="v in yTicks" :key="'y' + v">
        <line :x1="M.l" :y1="yOf(v)" :x2="M.l + PW" :y2="yOf(v)" class="grid" />
        <text :x="M.l - 4" :y="yOf(v)" class="tick" text-anchor="end" dominant-baseline="middle">{{ v }}</text>
        <!-- 右侧副轴 = C/I（本站密度 − 该高度），读图不必心算 -->
        <text v-if="ownY != null" :x="M.l + PW + 4" :y="yOf(v)" class="tick dim" dominant-baseline="middle">{{ fmt(ownDensityDbWPerHz - v, 0) }}</text>
      </g>

      <!-- S.524 的分段结构角 -->
      <g v-for="(m, i) in maskMarks" :key="'m' + m.key">
        <line :x1="xOf(m.deg)" :y1="M.t" :x2="xOf(m.deg)" :y2="M.t + PH" class="mark" :class="m.key" />
        <text :x="xOf(m.deg) + 2" :y="M.t + 8 + (i % 2) * 8" class="mark-lab">{{ m.label }}</text>
      </g>

      <!-- 本站上行 EIRP 密度 = C。它到干扰点的垂直距离就是 C/I -->
      <template v-if="ownY != null">
        <line :x1="M.l" :y1="ownY" :x2="M.l + PW" :y2="ownY" class="own" />
        <text :x="M.l + 3" :y="ownY - 2.5" class="own-lab">本站上行密度 {{ fmt(ownDensityDbWPerHz, 1) }} dBW/Hz</text>
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
          <circle :cx="p.x" :cy="p.yRaw" r="2.6" class="raw" />
        </template>
        <circle :cx="p.x" :cy="p.yEff" r="3.2" />
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

      <text :x="M.l + PW / 2" :y="H - 4" class="axis" text-anchor="middle">干扰站离轴角 φ（度，对数轴）</text>
      <text :x="11" :y="M.t + PH / 2" class="axis" text-anchor="middle" :transform="`rotate(-90 11 ${M.t + PH / 2})`">离轴 EIRP 密度（dBW/Hz）</text>
      <text :x="W - 9" :y="M.t + PH / 2" class="axis dim" text-anchor="middle" :transform="`rotate(90 ${W - 9} ${M.t + PH / 2})`">C/I（dB）</text>
    </svg>

    <div v-if="hasData" class="lg">
      <span class="lg-i"><i class="sw mask" />S.524 掩模<template v-if="maskBand"> · {{ maskBand }}</template></span>
      <span v-for="c in peerPaths" :key="'lg' + c.key" class="lg-i"><i class="sw peer" />对等站 Ø{{ fmt(c.diameterM, 1) }} m</span>
      <span v-if="ownY != null" class="lg-i"><i class="sw own" />本站上行密度（C）</span>
      <span class="lg-i"><i class="sw src" />干扰源落点</span>
    </div>
    <!-- 没有实线时要说清为什么：读者看到一条红虚线加几个孤零零的点，第一反应是图没画全 -->
    <p v-if="hasData && !peerPaths.length" class="ci-hint sm">
      <template v-if="sourceMode === 'explicit'">
        <strong>逐站给定</strong>：落点为直接填入的离轴 EIRP 密度，不经天线模型计算，故图上无对等站曲线。
        此时应读<strong>落点到红虚线的距离</strong>，即申报值相对 S.524 上界的余量。
        若多座站填入同一数值，落点同高、C/I 亦相同。
      </template>
      <template v-else>
        <strong>S.524 掩模模式</strong>：干扰源模型即该红线，故落点必位于线上，且无对等站曲线。
        查看工程预期值请切换至「对等站」。
      </template>
    </p>
    <p v-if="belowScopeNames.length" class="warn sm">
      {{ belowScopeNames.join('、') }} 的离轴角在 S.524 的 φ₀ 以内：<strong>建议书对该角不设限</strong>，
      此处取 φ₀ 处的钳位值。这些源的 C/I 因而相同，系掩模模型在该角不适用所致。
    </p>
    <p v-if="!maskAuthoritative && maskCurve.length" class="warn sm">
      该频率不在 S.524-9 正文明列的三个频段内，掩模按邻近频段外推，仅可作量级参照，不应标注为「ITU-R S.524-9」。
    </p>
    <p v-if="!hasData" class="empty">请先计算：上行几何由引擎按所选干扰源模型给出</p>
  </div>
</template>

<style scoped>
.ci-up { width: 100%; }
.ci-up svg { width: 100%; height: auto; display: block; }

.bg { fill: var(--surface-2); stroke: var(--border-strong); stroke-width: 0.7; }
.grid { stroke: var(--border); stroke-width: 0.4; }
.tick { font-size: 7.5px; fill: var(--text-muted); }
.tick.dim { opacity: 0.65; }
.axis { font-size: 8px; fill: var(--text-muted); font-weight: 600; }
.axis.dim { opacity: 0.7; font-weight: 500; }

/* 三条线各自的语言：天花板用告警色虚线、实际泼洒用主色实线、本站载波用中性虚线 */
.mask { fill: none; stroke: var(--danger, #a32d2d); stroke-width: 1.3; stroke-dasharray: 5 2.5; stroke-linejoin: round; }
.mask.out { stroke-dasharray: 1 2; opacity: 0.45; }
.peer { fill: none; stroke: var(--accent); stroke-width: 1.7; stroke-linejoin: round; }
.own { stroke: var(--text-muted); stroke-width: 0.6; stroke-dasharray: 3 2; }
.own-lab { font-size: 7px; fill: var(--text-muted); }

.mark { stroke: var(--text-muted); stroke-width: 0.5; stroke-dasharray: 2 2.5; opacity: 0.5; }
.mark.phi0 { stroke-dasharray: 3.5 1.5; opacity: 0.75; }
.mark-lab { font-size: 6.6px; fill: var(--text-muted); opacity: 0.85; }

.drop { stroke: var(--warn, #d08a2e); stroke-width: 0.5; stroke-dasharray: 1.5 1.5; opacity: 0.5; }
.cut { stroke: var(--warn, #d08a2e); stroke-width: 0.8; stroke-dasharray: 2 1.4; opacity: 0.9; }
.lead { stroke: var(--warn, #d08a2e); stroke-width: 0.5; opacity: 0.7; }
.src circle { fill: var(--warn, #d08a2e); stroke: var(--surface); stroke-width: 0.9; cursor: pointer; }
.src circle.raw { fill: none; stroke: var(--warn, #d08a2e); stroke-width: 1; }
.src:hover circle, .src.hot circle { stroke: var(--text); }
.src-lab { font-size: 7.4px; fill: var(--text); pointer-events: none; }
.src:hover .src-lab, .src.hot .src-lab { font-weight: 700; }
.src:hover .drop, .src.hot .drop { opacity: 1; stroke-width: 0.8; }

.lg { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 11px; color: var(--text-muted); }
.lg-i { display: inline-flex; align-items: center; gap: 5px; }
.sw { display: inline-block; width: 15px; height: 0; border-top-width: 2px; border-top-style: solid; }
.sw.mask { border-top-color: var(--danger, #a32d2d); border-top-style: dashed; }
.sw.peer { border-top-color: var(--accent); }
.sw.own { border-top-color: var(--text-muted); border-top-style: dashed; }
.sw.src { width: 7px; height: 7px; border: none; border-radius: 50%; background: var(--warn, #d08a2e); }

.ci-hint { margin: 6px 0 0; font-size: 11px; line-height: 1.55; color: var(--text-muted); }
.ci-hint strong { color: var(--text); font-weight: 600; }
.warn { margin: 6px 0 0; font-size: 11px; line-height: 1.5; color: var(--warn, #d08a2e); }
.empty { margin: 8px 0 0; text-align: center; font-size: 12px; color: var(--text-muted); }
</style>
