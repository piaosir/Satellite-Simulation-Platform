<script setup>
// 时间轴设置浮层：时间条「跨度 / 时段」钮点开（步长 / 倍速下拉的「自定义…」也开它，见 openAt）。
// 一处设全：时段模式（滚动 / 固定）、起止时刻、时长、终止处理、步长、倍速 —— 全部可任意键入。
//   · 滚动：只定跨度，时间窗随游标走（改造前的行为）
//   · 固定：起止时刻钉死；连播到终止时刻按「停止 / 循环 / 继续」处理（STK Animation 的 End Time / Loop At）
// 交互：逐项回车 / 失焦即生效（与编辑卫星弹窗同一套「实时编辑器」口径），没有「应用」键；Esc 放弃正在键入的那一项并收起。
// ★ 浮层 Teleport 到 body（时间条是 container-type 的包含块，地图外层层 overflow，留在原位不是被裁就是坐标算错），
//   且套在触发器【里面】—— 组件单根，父页面的 scoped 样式才落得到触发器上（同 TzPicker 那个坑）。
// ★ 起止时刻按显示时区档位读写（与「跳到时刻」同一个开关），只改显示与输入，不改计算口径。
import { ref, reactive, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { DUR_UNITS, QUICK_SPANS, SPAN_MIN_SEC, SPAN_MAX_SEC, parseDur, parseNum, durPick, durIn, durUnitSec, numTxt, fmtSpanSec, fmtLocalInput, parseLocalInput } from '../shared/tlPeriod.js'
import { STEP_MIN, STEP_MAX, SPEED_MIN, SPEED_MAX } from '../shared/simClockCore.js'
import { tzTag } from '../shared/tz.js'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  mode: { type: String, default: 'roll' },      // 'roll' | 'fixed'
  startMs: { type: Number, default: 0 },        // 固定档：时段起止；滚动档：当前时间窗两端（切到固定时据此起算）
  stopMs: { type: Number, default: 0 },
  end: { type: String, default: 'stop' },       // 'stop' | 'loop' | 'continue'
  stepSec: { type: Number, default: 60 },
  speed: { type: Number, default: 600 },
  tz: { type: [String, Number], default: 'local' },
  // () => 时间轴游标（UTC ms）：起始旁「此刻」取它 —— 与航迹出发 / 卫星历元的「此刻」同口径（平台的「此刻」都是时间轴游标）。
  // 传函数不传数：游标逐拍在走，传数的话宿主页模板就得逐拍读 clock、整页跟着重渲染
  now: { type: Function, default: null }
})
const emit = defineEmits(['period', 'span', 'step', 'speed', 'fit', 'open', 'close'])

const GAP = 3
const open = ref(false)
const btn = ref(null)
const pop = ref(null)
const inStart = ref(null), inDur = ref(null), inStep = ref(null), inSpeed = ref(null)
const pos = ref({ left: '-9999px', top: '0px' })
let anchor = null, align = 'left'

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const draft = reactive({ start: null, stop: null, dur: null, step: null, speed: null })
const durUnit = ref('h'), stepUnit = ref('s')
const spanSec = computed(() => Math.max(0, (props.stopMs - props.startMs) / 1000))
const valStart = computed(() => draft.start ?? fmtLocalInput(props.startMs, props.tz))
const valStop = computed(() => draft.stop ?? fmtLocalInput(props.stopMs, props.tz))
const valDur = computed(() => draft.dur ?? durIn(spanSec.value, durUnit.value))
const valStep = computed(() => draft.step ?? durIn(props.stepSec, stepUnit.value))
const valSpeed = computed(() => draft.speed ?? numTxt(props.speed))
const spanRound = computed(() => Math.round(spanSec.value))
const tzText = computed(() => tzTag(props.tz, props.startMs || Date.now()))
const fixed = computed(() => props.mode === 'fixed')

function emitPeriod(p) { emit('period', { mode: 'fixed', startMs: props.startMs, stopMs: props.stopMs, end: props.end, ...p }) }
// —— 逐项提交（回车 / 失焦）：解析不出或没变就只丢掉草稿，框里回到当前值 ——
function commitStart() {
  const v = draft.start; draft.start = null
  if (v == null) return
  const t = parseLocalInput(v, props.tz)
  if (t == null || t === props.startMs) return
  emitPeriod({ startMs: t, stopMs: t + (props.stopMs - props.startMs) })   // 改起始：时长不变，终止随之平移
}
function commitStop() {
  const v = draft.stop; draft.stop = null
  if (v == null) return
  const t = parseLocalInput(v, props.tz)
  if (t == null || t === props.stopMs || t <= props.startMs) return
  emitPeriod({ stopMs: t })
}
function applySpan(sec) {
  const s = Math.round(clamp(sec, SPAN_MIN_SEC, SPAN_MAX_SEC))
  if (fixed.value) { if (s !== spanRound.value) emitPeriod({ stopMs: props.startMs + s * 1000 }) }
  else if (s !== spanRound.value) emit('span', s)
}
function commitDur() {
  const v = draft.dur; draft.dur = null
  if (v == null) return
  const sec = parseDur(v, durUnitSec(durUnit.value))
  if (sec != null) applySpan(sec)
}
function commitStep() {
  const v = draft.step; draft.step = null
  if (v == null) return
  const sec = parseDur(v, durUnitSec(stepUnit.value))
  if (sec == null) return
  const s = clamp(sec, STEP_MIN, STEP_MAX)
  if (s !== props.stepSec) emit('step', s)
}
function commitSpeed() {
  const v = draft.speed; draft.speed = null
  if (v == null) return
  const x = parseNum(v)
  if (x == null) return
  const c = clamp(x, SPEED_MIN, SPEED_MAX)
  if (c !== props.speed) emit('speed', c)
}
function commitAll() { commitStart(); commitStop(); commitDur(); commitStep(); commitSpeed() }

function setMode(m) {
  if (m === props.mode) return
  commitAll()
  if (m !== 'fixed') { emit('period', { mode: 'roll', end: props.end }); return }
  // 滚动 → 固定：以当前时间窗为时段（落整秒），画面不跳
  const a = Math.round(props.startMs / 1000) * 1000
  emit('period', { mode: 'fixed', startMs: a, stopMs: a + Math.max(SPAN_MIN_SEC, spanRound.value) * 1000, end: props.end })
}
function setEnd(k) { if (k !== props.end) emitPeriod({ end: k }) }
// 此刻：起始设为时间轴游标（取整秒），时长不变。没给 now（不会发生）才退回系统钟
function startNow() {
  draft.start = null
  const c = typeof props.now === 'function' ? Number(props.now()) : NaN
  const t = Math.round((Number.isFinite(c) ? c : Date.now()) / 1000) * 1000
  emitPeriod({ startMs: t, stopMs: t + (props.stopMs - props.startMs) })
}
function pickQuick(v) { draft.dur = null; applySpan(v) }

// —— 开合与定位 ——
function place() {
  const el = anchor && anchor.isConnected ? anchor : btn.value, m = pop.value
  if (!el || !m) return
  const r = el.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight
  const up = r.bottom + GAP + h > window.innerHeight             // 时间条在屏幕最底下，常态朝上开
  let left = align === 'right' ? r.right - w : r.left
  left = Math.max(4, Math.min(left, window.innerWidth - w - 4))
  const top = up ? Math.max(4, r.top - GAP - h) : r.bottom + GAP
  pos.value = { left: left + 'px', top: top + 'px' }
}
/** 从指定元素旁打开（al：贴它的左 / 右边；focus：'start' | 'dur' | 'step' | 'speed' 打开后聚焦哪一格） */
function openAt(el, al = 'left', focus = '') {
  anchor = el || null; align = al === 'right' ? 'right' : 'left'
  if (!open.value) {
    for (const k of Object.keys(draft)) draft[k] = null
    durUnit.value = durPick(spanSec.value).k
    stepUnit.value = durPick(props.stepSec).k
    pos.value = { left: '-9999px', top: '0px' }                    // 先在屏外排一次量出尺寸，再摆到位（同一帧内，不闪）
    open.value = true
  }
  nextTick(() => {
    place()
    const f = { start: inStart, dur: inDur, step: inStep, speed: inSpeed }[focus]
    if (f && f.value) { f.value.focus({ preventScroll: true }); if (f.value.select) f.value.select() }
  })
}
// cancel：Esc —— 丢掉正在键入的那一项；其余关法（点外面 / 再点触发器）先把草稿提交了
function close(refocus = true, cancel = false) {
  if (!open.value) return
  if (cancel) for (const k of Object.keys(draft)) draft[k] = null
  else commitAll()
  const m = pop.value, b = btn.value
  if (refocus && m && b && m.contains(document.activeElement)) b.focus({ preventScroll: true })
  open.value = false
}
function toggle() { if (open.value) close(); else openAt(btn.value, 'left') }
function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault(); e.stopPropagation()
  close(true, true)
}
function onResize() { if (open.value) place() }
watch(open, (v) => {
  if (v) { document.addEventListener('keydown', onKey); window.addEventListener('resize', onResize) }
  else { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) }
  emit(v ? 'open' : 'close')
})
watch(() => props.mode, () => { if (open.value) nextTick(place) })   // 换档行数变了：重新摆（朝上开时底边贴住触发器）
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize) })
defineExpose({ openAt, close })
</script>

<template>
  <span ref="btn" class="tls" :class="{ open }" v-bind="$attrs" @click="toggle"><slot />
    <Teleport to="body">
      <div v-if="open" class="tls-mask" @mousedown="close(false)" @contextmenu.prevent="close(false)" @wheel.prevent>
        <div ref="pop" class="tls-pop" role="dialog" aria-label="时间轴设置" tabindex="-1" :style="pos" @mousedown.stop @wheel.stop @contextmenu.stop>
          <div class="tls-row">
            <span class="tls-k">时间窗</span>
            <span class="tls-seg" role="radiogroup" aria-label="时间窗">
              <button type="button" role="radio" :aria-checked="!fixed" :class="{ on: !fixed }" title="时间窗随游标移动" @click="setMode('roll')">滚动</button>
              <button type="button" role="radio" :aria-checked="fixed" :class="{ on: fixed }" title="起止时刻固定" @click="setMode('fixed')">固定</button>
            </span>
            <span v-if="fixed" class="tls-tz" data-i18n-skip>{{ tzText }}</span>
          </div>
          <template v-if="fixed">
            <div class="tls-row">
              <span class="tls-k">起始</span>
              <input ref="inStart" class="tls-dt" type="datetime-local" step="1" :value="valStart"
                     @input="draft.start = $event.target.value" @keydown.enter.prevent="commitStart" @blur="commitStart" />
              <button type="button" class="btn sm tls-now" title="设为时间轴当前时刻" @click="startNow">此刻</button>
            </div>
            <div class="tls-row">
              <span class="tls-k">终止</span>
              <input class="tls-dt" type="datetime-local" step="1" :value="valStop"
                     @input="draft.stop = $event.target.value" @keydown.enter.prevent="commitStop" @blur="commitStop" />
            </div>
          </template>
          <div class="tls-row">
            <span class="tls-k">{{ fixed ? '时长' : '跨度' }}</span>
            <input ref="inDur" class="tls-num" type="text" inputmode="decimal" spellcheck="false" :value="valDur"
                   title="可带单位连写，如 1d12h、90min、2w"
                   @input="draft.dur = $event.target.value" @keydown.enter.prevent="commitDur" @blur="commitDur" />
            <select class="tls-unit" :value="durUnit" @change="durUnit = $event.target.value">
              <option v-for="u in DUR_UNITS" :key="u.k" :value="u.k">{{ u.k }}</option>
            </select>
          </div>
          <div class="tls-row tls-qk">
            <span class="tls-k"></span>
            <span class="tls-chips">
              <button v-for="v in QUICK_SPANS" :key="v" type="button" class="tls-chip" :class="{ on: v === spanRound }" data-i18n-skip @click="pickQuick(v)">{{ fmtSpanSec(v) }}</button>
            </span>
          </div>
          <div v-if="fixed" class="tls-row">
            <span class="tls-k">终止时</span>
            <span class="tls-seg" role="radiogroup" aria-label="终止时">
              <button type="button" role="radio" :aria-checked="end === 'stop'" :class="{ on: end === 'stop' }" title="到达终止时刻即暂停" @click="setEnd('stop')">停止</button>
              <button type="button" role="radio" :aria-checked="end === 'loop'" :class="{ on: end === 'loop' }" title="到达终止时刻后回到起始时刻" @click="setEnd('loop')">循环</button>
              <button type="button" role="radio" :aria-checked="end === 'continue'" :class="{ on: end === 'continue' }" title="越过终止时刻继续推进" @click="setEnd('continue')">继续</button>
            </span>
            <button type="button" class="btn sm tls-fit" title="时间窗对准整个时段（双击刻度尺同效）" @click="emit('fit')">缩放至时段</button>
          </div>
          <div class="tls-sep"></div>
          <div class="tls-row">
            <span class="tls-k">步长</span>
            <input ref="inStep" class="tls-num" type="text" inputmode="decimal" spellcheck="false" :value="valStep"
                   title="每拍推进的仿真时间；可带单位连写"
                   @input="draft.step = $event.target.value" @keydown.enter.prevent="commitStep" @blur="commitStep" />
            <select class="tls-unit" :value="stepUnit" @change="stepUnit = $event.target.value">
              <option v-for="u in DUR_UNITS" :key="u.k" :value="u.k">{{ u.k }}</option>
            </select>
          </div>
          <div class="tls-row">
            <span class="tls-k">倍速</span>
            <input ref="inSpeed" class="tls-num" type="text" inputmode="decimal" spellcheck="false" :value="valSpeed"
                   title="仿真时间相对真实时间的倍数"
                   @input="draft.speed = $event.target.value" @keydown.enter.prevent="commitSpeed" @blur="commitSpeed" />
            <span class="tls-u">×</span>
          </div>
        </div>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
.tls { cursor: pointer; user-select: none; }
</style>

<style>
/* 浮层 Teleport 出去了，scoped 打不到它的节点 */
.tls-mask { position: fixed; inset: 0; z-index: 2400; }
.tls-pop {
  position: fixed; z-index: 2401; width: max-content; padding: 4px 10px 10px;
  background: var(--surface, var(--bg)); border: 1px solid var(--border-strong, var(--border)); border-radius: var(--r-float); box-shadow: var(--shadow-2);
  font-size: var(--fs-3); color: var(--text);
  animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.tls-pop:focus { outline: none; }
.tls-row { display: flex; align-items: center; gap: 6px; min-height: var(--h-ctl); margin-top: 6px; }
.tls-k { flex: none; width: 3.6em; color: var(--text-muted); font-size: var(--fs-2); white-space: nowrap; }
/* 英文栏名更长（Time Window / Duration / At Stop）：定宽 3.6em 时字溢出去压在右侧分段键上 ——
   改成按字撑开、下限 4.8em（多数栏名在下限内，各行控件仍对齐；最长那条只把自己这一行往右推） */
html[lang="en"] .tls-k { width: auto; min-width: 4.8em; }
.tls-tz { margin-left: auto; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-2); color: var(--text-faint); }
.tls-dt { width: 196px; flex: none; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.tls-num { width: 96px; flex: none; font-family: var(--font-mono); font-variant-numeric: tabular-nums; text-align: right; }
.tls-unit { width: 58px; flex: none; font-family: var(--font-mono); }
.tls-u { color: var(--text-muted); font-family: var(--font-mono); }
.tls-fit { margin-left: auto; }
/* 分段键：与时间条走带键同一画法（外框一道、键间细分隔）；选中 = 机位色实底（字色走 --bg，两主题同一份） */
.tls-seg { display: inline-flex; align-items: stretch; height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; flex: none; }
.tls-seg > button { padding: 0 10px; border: 0; border-radius: 0; background: transparent; font: inherit; font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; white-space: nowrap; transition: var(--t-state); }
.tls-seg > button + button { border-left: 1px solid var(--border); }
.tls-seg > button:hover { background: var(--wash-hover); color: var(--text); }
.tls-seg > button.on { background: var(--accent-ui); color: var(--bg); }
.tls-seg > button:focus-visible { outline-offset: -2px; }
/* 常用时长：一排紧凑小键（与刻度标签同一种等宽数字） */
.tls-qk { margin-top: 4px; }
.tls-chips { display: flex; flex-wrap: wrap; gap: 3px; max-width: 290px; }
.tls-chip { height: 18px; padding: 0 5px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: transparent; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); color: var(--text-muted); cursor: pointer; line-height: 1; }
.tls-chip:hover { border-color: var(--line-hover); color: var(--text); }
.tls-chip.on { border-color: var(--accent-ui); background: var(--accent-ui-weak); color: var(--text); }
.tls-sep { height: 1px; margin: 9px -4px 2px; background: var(--border); }
</style>
