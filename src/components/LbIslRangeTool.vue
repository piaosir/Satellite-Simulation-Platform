<script setup>
// 「星间链路距离」工具 —— 手动几何下星间距离的核对与填入（再生式微波 ISL / 激光 ISL 共用）。
//
// 手动几何不选卫星：星间距离是用户直接给的一个数（见 regenParams 的 islRangeKm）。本工具只做一件事：
// 拿两颗卫星的轨道在一段时窗里逐拍算星间距离，把曲线和时间轴交出来，让用户自己挑一个时刻的距离填回去
// （挑最大＝最差工况，挑某一刻＝那一刻的真实几何）。软件不替用户决定挑哪个。
//
// 口径：几何与「几何=自动最差」走的是同一套（双 SGP4 → ECEF → LOS 段，见 core/utils/ngsoGeometry.js
// 的 sampleIslRangeSeries 与 solveIslWorstCase），差别只在这里逐拍出参、那边折成一个最差工况标量。
// 互视判据同样是「LOS 最近地心距 ≥ 地球半径 + 大气余量」。
import { ref, reactive, computed, watch } from 'vue'
import Icon from './Icon.vue'
import AppDialog from './AppDialog.vue'
import { pf } from '../shared/num.js'
import { sceneNowMs } from '../shared/sceneClock.js'   // 「此刻」＝主窗口时间轴上的当前时刻（全软件一条时间线）
import { inputText, parseInput, endFromHours, hoursFromEnd } from '../shared/timeWindowInput.js'
import { reportError } from '../shared/reportError.js'
import { parseDateTimeText } from '../shared/ui/rangeFieldCore.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  sats: { type: Array, default: () => [] },       // 卫星群条目 [{ id, name, orbit(已解析的轨道 spec), summary }]
  rowCount: { type: Number, default: 0 },
  hasRow: { type: Boolean, default: false },      // 是否有聚焦行（无则只给「全部行」）
  defaultHours: { type: Number, default: 6 },
  sideLabel: { type: String, default: '' },       // 当前子链路模式名（星间微波 / 星间激光）
  // 两端预选（端到端窗口用）：本跳两端就是链上那两颗星，打开工具时直接落到它们身上，
  // 省得用户在下拉里再找一遍。缺省为空＝沿用「卫星群前两份配置」的老行为（再生式窗口）。
  srcA: { type: String, default: '' },
  srcB: { type: String, default: '' }
})
const emit = defineEmits(['close', 'fill'])

const api = (typeof window !== 'undefined' && window.api) ? window.api.linkBudget : null

// 时窗＝起止时刻（两个都可自定义）；时长与结束时刻是同一个量的两种填法，改哪个另一个跟着变，改起始时刻时长不变（结束跟着平移）
const MAX_HOURS = 720   // 30 天：再长样本步长（时窗 / maxSamples）已粗到一小时，曲线不再有用
const A = reactive({ src: '', altKm: '1200', inclDeg: '53', raanDeg: '0', maDeg: '0' })
const B = reactive({ src: '', altKm: '1200', inclDeg: '53', raanDeg: '40', maDeg: '25' })
const hours = ref(6)
const atmMarginKm = ref('100')
const t0Local = ref('')
const busy = ref(false)
const err = ref('')
const res = ref(null)      // { samples, stats, method, representative, search }
const idx = ref(0)

// 本机时刻 ↔ datetime-local 值（该控件只吃本地墙钟，无时区后缀；读写与半截年份判据见 shared/timeWindowInput.js）
function nowT0() { t0Local.value = inputText(sceneNowMs(), 'local') }
const t0Ms = () => { const t = parseInput(t0Local.value, 'local'); return Number.isFinite(t) ? t : sceneNowMs() }
// 结束时刻 ⇄ 时长：结束时刻按起始 + 时长显示；改结束时刻 = 改时长（须晚于起始；超过 720 h 由「计算」报出，不在这里吞掉）
const t1Local = computed({
  get: () => inputText(endFromHours(t0Ms(), hours.value), 'local'),
  set: (v) => { const h = hoursFromEnd(t0Ms(), parseInput(v, 'local')); if (Number.isFinite(h)) hours.value = h }
})
const hoursText = computed({
  get: () => (hours.value > 0 ? String(+hours.value.toFixed(4)) : ''),
  set: (v) => { const h = pf(v); if (h > 0) hours.value = h }
})

// 每次打开重播种：起点取时间轴此刻，时窗跟随主界面；两端默认取卫星群前两份配置。
// immediate：宿主可能一挂载就是打开态（验证台/深链），那一次不走「关→开」的边沿，得在此补上
watch(() => props.open, (o) => {
  if (!o) return
  nowT0()
  hours.value = props.defaultHours || 6
  err.value = ''
  if (props.srcA) A.src = props.srcA
  if (props.srcB) B.src = props.srcB
  if (!A.src && props.sats[0]) A.src = props.sats[0].id
  if (!B.src && props.sats[1]) B.src = props.sats[1].id
}, { immediate: true })

const satOpts = computed(() => [...props.sats.map((s) => ({ value: s.id, label: s.name })), { value: '', label: '自定义轨道' }])
const t0ISO = computed(() => new Date(t0Ms()).toISOString())   // 起始框读不出（清空 / 半截）按时间轴此刻
// 一端 → 轨道 spec：选卫星群条目取其轨道（选星=真实星历 / 手动=圆轨道），自定义则按本地四项圆轨道。
// 圆轨道缺历元时钉到时窗起点：相位(M0)/升交点从这一刻起算，多次计算复现。
function specOf(s) {
  let spec = null
  if (s.src) {
    const sat = props.sats.find((x) => x.id === s.src)
    spec = sat && sat.orbit ? JSON.parse(JSON.stringify(sat.orbit)) : null
  } else {
    const alt = pf(s.altKm)
    if (!(alt > 0)) return null
    spec = { type: 'circular', altKm: alt, inclDeg: pf(s.inclDeg) || 0, raanDeg: pf(s.raanDeg) || 0, maDeg: pf(s.maDeg) || 0 }
  }
  if (spec && spec.type === 'circular' && !spec.epoch) spec.epoch = t0ISO.value
  return spec
}

async function run() {
  if (!api || !api.islRangeSeries) { err.value = '几何求解需在桌面客户端中运行'; return }
  const orbitA = specOf(A), orbitB = specOf(B)
  if (!orbitA || !orbitB) { err.value = '两端轨道未给全（自定义轨道需要高度）'; return }
  if (!(hours.value > 0) || hours.value > MAX_HOURS) { err.value = '时长须大于 0 且不超过 720 h'; return }
  busy.value = true; err.value = ''
  try {
    const am = pf(atmMarginKm.value)
    const r = await api.islRangeSeries({
      orbitA, orbitB, t0ISO: t0ISO.value, horizonHours: hours.value,
      atmMarginKm: isNaN(am) ? 100 : am, maxSamples: 720
    })
    if (!r || !r.ok) { res.value = null; err.value = (r && r.reason) || '几何求解失败'; return }
    res.value = r
    // 光标落在时窗内互视样本里距离最大的那一拍（＝最差工况，与「几何=自动最差」同口径；用户可再拖）
    idx.value = argMax(r.samples)
  } catch (e) {
    res.value = null; err.value = String(e)
  } finally {
    busy.value = false
  }
}
// 极值只在【互视样本】里找：被地球挡住的那些拍两星根本连不上，它们的距离拿去做预算没有意义
// （这也是 solveIslWorstCase 的口径）。一拍互视都没有时退回全体，至少还能看出量级。
function argExtreme(samples, cmp) {
  let k = -1
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].visible) continue
    if (k < 0 || cmp(samples[i].rangeKm, samples[k].rangeKm)) k = i
  }
  if (k >= 0) return k
  k = 0
  for (let i = 1; i < samples.length; i++) if (cmp(samples[i].rangeKm, samples[k].rangeKm)) k = i
  return k
}
const argMax = (samples) => argExtreme(samples, (a, b) => a > b)
const argMin = (samples) => argExtreme(samples, (a, b) => a < b)
// 「在主窗口定位」：把主窗口时间轴拨到光标所在那一拍（C3，经主进程 scene:cmd 中继；主窗被提到前台）
const sceneApi = (typeof window !== 'undefined' && window.api && window.api.scene && window.api.scene.cmd) ? window.api.scene : null
function seekMain() {
  const c = cur.value
  if (!sceneApi || !c || !Number.isFinite(c.tMs)) return
  Promise.resolve(sceneApi.cmd('seekClock', { tMs: c.tMs })).catch((e) => reportError('在主窗口定位', e))
}
function jump(which) {
  const s = res.value && res.value.samples
  if (!s || !s.length) return
  idx.value = which === 'max' ? argMax(s) : argMin(s)
}
// 两端任一输入改动 → 旧曲线与当前参数已不对应，清掉（不留着让人以为算过了）
watch([() => A.src, () => A.altKm, () => A.inclDeg, () => A.raanDeg, () => A.maDeg,
  () => B.src, () => B.altKm, () => B.inclDeg, () => B.raanDeg, () => B.maDeg,
  hours, atmMarginKm, t0Local], () => { res.value = null })

const samples = computed(() => (res.value && res.value.samples) || [])
const cur = computed(() => samples.value[Math.min(idx.value, samples.value.length - 1)] || null)
// 游标时刻读数即输入框：打一个时刻（本机时区，与读数同口径；只打「HH:MM」沿用当前日期），落到最近的采样点
const idxRnum = {
  fromText: (s) => {
    const c = cur.value
    const d = c && c.tMs ? new Date(c.tMs) : null
    const p = parseDateTimeText(s, d && { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() })
    const arr = samples.value
    if (!p || !arr.length) return NaN
    const t = new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s).getTime()
    let best = 0
    for (let i = 1; i < arr.length; i++) if (Math.abs(arr[i].tMs - t) < Math.abs(arr[best].tMs - t)) best = i
    return best
  }
}
const stats = computed(() => (res.value && res.value.stats) || null)
// 读数里的最大/最小与「跳到最大/最小」同口径：优先互视样本，一拍都不互视才退回全体
// 两端都取「手动轨道」的卫星群条目时，两星只有高度/倾角、相位缺省相同 → 几何重合，曲线贴着 0。
// 这是输入的问题不是求解的问题，如实点出来（改用真实星历的条目，或在此选「自定义轨道」拉开升交点/相位）。
const coincident = computed(() => !!stats.value && stats.value.maxRangeKm != null && stats.value.maxRangeKm < 1)
const extremes = computed(() => {
  const s = stats.value
  if (!s) return { max: null, min: null }
  return {
    max: s.maxVisibleRangeKm != null ? s.maxVisibleRangeKm : s.maxRangeKm,
    min: s.minVisibleRangeKm != null ? s.minVisibleRangeKm : s.minRangeKm
  }
})

const fmt = (v, dp) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(dp))
const fmtTime = (ms) => {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// —— 曲线（SVG，视图坐标 0..W / 0..H）——
const W = 420, H = 130, PADL = 46, PADR = 8, PADT = 8, PADB = 16
const plot = computed(() => {
  const s = samples.value
  if (s.length < 2) return null
  let lo = Infinity, hi = -Infinity
  for (const p of s) { if (p.rangeKm < lo) lo = p.rangeKm; if (p.rangeKm > hi) hi = p.rangeKm }
  if (!(hi > lo)) { hi = lo + 1; lo -= 1 }
  const t0 = s[0].tMs, t1 = s[s.length - 1].tMs
  const x = (p) => PADL + (W - PADL - PADR) * ((p.tMs - t0) / Math.max(1, t1 - t0))
  const y = (p) => PADT + (H - PADT - PADB) * (1 - (p.rangeKm - lo) / (hi - lo))
  // 互视 / 被遮挡分成两组折线：一眼看出哪段距离是这条链路真能用的
  const segs = []
  let cursp = null
  for (const p of s) {
    if (!cursp || cursp.vis !== p.visible) { cursp = { vis: p.visible, pts: [] }; segs.push(cursp) }
    cursp.pts.push(`${x(p).toFixed(1)},${y(p).toFixed(1)}`)
  }
  // 断点接上：段与段之间不留缝
  for (let i = 1; i < segs.length; i++) segs[i].pts.unshift(segs[i - 1].pts[segs[i - 1].pts.length - 1])
  return { lo, hi, t0, t1, x, y, segs, cursorX: cur.value ? x(cur.value) : null, cursorY: cur.value ? y(cur.value) : null }
})
function pickAt(e) {
  const s = samples.value
  if (!s.length) return
  const r = e.currentTarget.getBoundingClientRect()
  const fx = (e.clientX - r.left) / r.width * W
  const f = (fx - PADL) / (W - PADL - PADR)
  idx.value = Math.max(0, Math.min(s.length - 1, Math.round(f * (s.length - 1))))
}
function onDrag(e) { if (e.buttons & 1) pickAt(e) }

const canFill = computed(() => !!cur.value && props.rowCount > 0)
function fill(scope) { if (canFill.value) emit('fill', { rangeKm: cur.value.rangeKm, scope }) }
</script>

<template>
  <!-- 外壳是 AppDialog（Esc / 关闭钮关、点遮罩不关） -->
  <AppDialog :open="open" :width="468" flush @close="emit('close')">
      <template #title>星间链路距离<span v-if="sideLabel" class="irt-sub">· {{ sideLabel }}</span></template>

      <div class="irt-bd">
        <div class="irt-ends">
          <div v-for="e in [{ k: 'A', s: A, l: '卫星一' }, { k: 'B', s: B, l: '卫星二' }]" :key="e.k" class="irt-end">
            <label class="irt-f"><span class="irt-l">{{ e.l }}</span>
              <select v-model="e.s.src" class="irt-in">
                <option v-for="o in satOpts" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select></label>
            <template v-if="!e.s.src">
              <label class="irt-f"><span class="irt-l">轨道高度</span>
                <input v-model="e.s.altKm" class="irt-in mono" inputmode="decimal" /><i class="irt-u">km</i></label>
              <label class="irt-f"><span class="irt-l">倾角</span>
                <input v-model="e.s.inclDeg" class="irt-in mono" inputmode="decimal" /><i class="irt-u">°</i></label>
              <label class="irt-f" title="升交点赤经 Ω"><span class="irt-l">升交点</span>
                <input v-model="e.s.raanDeg" class="irt-in mono" inputmode="decimal" /><i class="irt-u">°</i></label>
              <label class="irt-f" title="时窗起点时刻的平近点角 M₀"><span class="irt-l">初始相位</span>
                <input v-model="e.s.maDeg" class="irt-in mono" inputmode="decimal" /><i class="irt-u">°</i></label>
            </template>
            <div v-else class="irt-orb">{{ (sats.find((x) => x.id === e.s.src) || {}).summary || '' }}</div>
          </div>
        </div>

        <div class="irt-sep"></div>

        <div class="irt-row">
          <label class="irt-f wide"><span class="irt-l">起始时刻</span>
            <input v-model="t0Local" type="datetime-local" class="irt-in mono" /></label>
          <button class="irt-btn" title="起始时刻取时间轴当前时刻" @click="nowT0">此刻</button>
        </div>
        <div class="irt-row">
          <label class="irt-f wide" title="改结束时刻＝改时长；改起始时刻时长不变"><span class="irt-l">结束时刻</span>
            <input v-model.lazy="t1Local" type="datetime-local" class="irt-in mono" @blur="$event.target.value = t1Local" /></label>
          <button class="irt-btn irt-ghost" tabindex="-1" aria-hidden="true">此刻</button>
        </div>
        <div class="irt-row">
          <label class="irt-f" title="结束时刻 − 起始时刻（≤ 720 h）"><span class="irt-l">时长</span>
            <input v-model.lazy="hoursText" class="irt-in mono" inputmode="decimal" @blur="$event.target.value = hoursText" /><i class="irt-u">h</i></label>
          <label class="irt-f" title="LOS 视线须高出地表的余量（km）：微波/激光须清过大气；0=纯几何视线"><span class="irt-l">大气余量</span>
            <input v-model="atmMarginKm" class="irt-in mono" inputmode="decimal" /><i class="irt-u">km</i></label>
          <button class="irt-btn primary" :disabled="busy" @click="run">{{ busy ? '计算中…' : '计算' }}</button>
        </div>

        <div v-if="err" class="irt-err">{{ err }}</div>
        <div v-else-if="coincident" class="irt-err">两星几何重合（星间距离≈0）：两端轨道的相位/升交点相同。</div>

        <template v-if="res && plot">
          <div class="irt-sep"></div>
          <svg class="irt-chart" :viewBox="`0 0 ${W} ${H}`" @pointerdown="pickAt" @pointermove="onDrag">
            <line :x1="PADL" :y1="PADT" :x2="PADL" :y2="H - PADB" class="irt-ax" />
            <line :x1="PADL" :y1="H - PADB" :x2="W - PADR" :y2="H - PADB" class="irt-ax" />
            <text :x="PADL - 4" :y="PADT + 8" class="irt-tk" text-anchor="end">{{ fmt(plot.hi, 0) }}</text>
            <text :x="PADL - 4" :y="H - PADB" class="irt-tk" text-anchor="end">{{ fmt(plot.lo, 0) }}</text>
            <polyline v-for="(sg, si) in plot.segs" :key="si" :points="sg.pts.join(' ')"
                      class="irt-ln" :class="{ blocked: !sg.vis }" />
            <line v-if="plot.cursorX != null" :x1="plot.cursorX" :y1="PADT" :x2="plot.cursorX" :y2="H - PADB" class="irt-cur" />
            <circle v-if="plot.cursorX != null" :cx="plot.cursorX" :cy="plot.cursorY" r="2.6" class="irt-dot" />
          </svg>
          <input v-model.number="idx" type="range" class="irt-slider" min="0" :max="samples.length - 1" step="1" :rnumMap.prop="idxRnum" />

          <div class="irt-out">
            <span class="irt-big mono">{{ fmt(cur && cur.rangeKm, 1) }}</span><i>km</i>
            <span class="irt-aux mono" data-rnum>{{ fmtTime(cur && cur.tMs) }}</span>
            <span class="irt-aux mono" title="LOS 掠地高度：视线最近点高出地表多少">掠地 {{ fmt(cur && cur.grazAltKm, 0) }} km</span>
            <span class="irt-aux mono" :class="{ bad: cur && !cur.visible }">{{ cur && cur.visible ? '互视' : '被遮挡' }}</span>
          </div>
          <div class="irt-out">
            <span class="irt-aux mono" title="时窗内互视样本占比">互视 {{ fmt(stats && stats.visibleFrac * 100, 1) }}%</span>
            <span class="irt-aux mono" title="时窗内互视样本中的最大星间距离（＝最差工况，与「几何=自动最差」同口径）">最大 {{ fmt(extremes.max, 1) }} km</span>
            <span class="irt-aux mono" title="时窗内互视样本中的最小星间距离">最小 {{ fmt(extremes.min, 1) }} km</span>
            <span class="irt-aux">{{ res.method }}</span>
            <button class="irt-btn" title="光标跳到时窗内星间距离最大的一拍" @click="jump('max')">跳到最大</button>
            <button class="irt-btn" title="光标跳到时窗内星间距离最小的一拍" @click="jump('min')">跳到最小</button>
            <button v-if="sceneApi" class="irt-btn irt-loc" title="主窗口时间轴拨到光标所在时刻" :disabled="!cur" @click="seekMain"><Icon name="locate-fixed" :size="12" />在主窗口定位</button>
          </div>
        </template>
      </div>

      <template #footer>
        <span class="adlg-ft-l">
          <button class="btn" :disabled="!canFill || !hasRow"
                  title="把光标所在时刻的星间距离填入当前行" @click="fill('row')">填入当前行</button>
          <button class="btn" :disabled="!canFill"
                  :title="`把光标所在时刻的星间距离填入全部 ${rowCount} 行`" @click="fill('all')">填入全部行</button>
        </span>
        <button class="btn" @click="emit('close')">关闭</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳归 AppDialog */
.irt-sub { margin-left: 6px; color: var(--text-faint); font-size: var(--fs-3); font-weight: 400; }
.irt-bd { padding: 10px; }
.irt-sep { height: 1px; background: var(--border); margin: 9px 0; }
.irt-ends { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.irt-end { min-width: 0; }
.irt-f { display: grid; grid-template-columns: 58px 1fr 22px; align-items: center; gap: 5px; }
.irt-f + .irt-f { margin-top: 5px; }
.irt-f.wide { flex: 1; }
.irt-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.irt-row .irt-f { flex: 1; }
.irt-l { font-size: var(--fs-3); color: var(--text-muted); }
.irt-in { font: inherit; font-size: var(--fs-3); padding: 4px 6px; width: 100%; min-width: 0; background-color: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.irt-in:focus { outline: none; border-color: var(--accent-ui); }
.irt-u { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.irt-orb { margin-top: 4px; font-size: var(--fs-2); color: var(--text-faint); }
.mono { font-family: var(--font-mono); }
.irt-err { margin-top: 8px; font-size: var(--fs-3); color: var(--danger); }
.irt-chart { width: 100%; height: auto; display: block; touch-action: none; cursor: crosshair; }
.irt-ax { stroke: var(--border); stroke-width: 1; }
.irt-tk { font-size: 9px; fill: var(--text-faint); font-family: var(--font-mono); }
.irt-ln { fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-linejoin: round; }
.irt-ln.blocked { stroke: var(--text-faint); stroke-dasharray: 3 2; }
.irt-cur { stroke: var(--text-muted); stroke-width: 1; }
.irt-dot { fill: var(--accent); }
.irt-slider { width: 100%; margin: 2px 0 4px; }
.irt-out { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; margin-top: 4px; }
.irt-big { font-size: var(--fs-5); color: var(--accent); }
.irt-out i { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.irt-aux { font-size: var(--fs-2); color: var(--text-muted); }
.irt-aux.bad { color: var(--danger); }
/* 读数可框选复制（口径同斜距工具）：只放开读数，标签/按钮仍不可选 */
.irt-out { user-select: text; -webkit-user-select: text; }
.irt-btn { font: inherit; font-size: var(--fs-2); line-height: 1; padding: 4px 9px; white-space: nowrap; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.irt-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.irt-btn:disabled { opacity: .45; cursor: not-allowed; }
.irt-loc { display: inline-flex; align-items: center; gap: 4px; }
.irt-ghost { visibility: hidden; }   /* 占住「此刻」那一格：结束时刻输入框与起始时刻的同宽对齐 */
.irt-btn.primary { background: var(--primary-fill); color: var(--primary-on); border-color: var(--primary-fill); }
/* 主钮悬停压深一档（原规则只保住字色，描边却被通用悬停染成灰框） */
.irt-btn.primary:hover:not(:disabled) { color: var(--primary-on); background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
</style>
