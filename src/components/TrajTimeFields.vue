<script setup>
// 航迹时间：出发 / 到达 / 历时 / 速度 四项联动。两处共用 ——
//   layout="form"  地图标记属性检查器（选中航迹）：逐行，标签列与检查器里的 .srow 对齐
//   layout="bar"   航迹表格参数栏：根节点与行都是 display: contents，各件并进外层 flex 行
// 这里只出读数与草稿；改动交 apply(edit) 落（页面套撤销栈、推图、落盘），口径全在 core/models/trajTiming.mjs：
//   改出发 = 整条平移（历时不变）；改到达 / 历时 / 速度 = 出发不动；静止档改任一项都补齐成能动的排程
//   （缺出发取时间轴游标，缺地速取 defSpeed）。
// 输入框一律草稿 + 回车 / 失焦提交、Esc 撤回（页面逐秒重渲染，直绑会吞输入）。
// ★ 时刻框是 datetime-local：Chromium 每敲一键发一次 input，年份段键到一半是 0002 —— 只在回车 / 失焦时解析，
//   parseLocalInput 不认首位为 0 的年份；没填全时 value 是空串，空串不当清除（回到原值），清除走「清除」。
import { computed, reactive, ref, watch, onBeforeUnmount } from 'vue'
import NumIn from '../model/NumIn.vue'
import { trajTiming } from '@core/models/trajTiming.mjs'
import { SPEED_KMH_MAX } from '@core/models/entityRuntime.mjs'
import { fmtLocalInput, parseLocalInput, parseDur } from '../shared/tlPeriod.js'
import { tzTag } from '../shared/tz.js'
import { clock } from '../stores/simClock'

const props = defineProps({
  t: { type: Object, required: true },               // 航迹（响应式对象：读数经代理建立依赖）
  tz: { type: [String, Number], default: 'local' },  // 显示时区档位（与时间轴同一个开关）
  layout: { type: String, default: 'form' },         // 'form' | 'bar'
  defSpeed: { type: Number, default: NaN },          // 缺省地速（km/h）：速度框占位，静止档补齐时写进航迹
  apply: { type: Function, required: true },         // (edit) => {ok, err}
  locate: { type: Function, default: null }          // 给了就出「定位」（侧栏卡片的定位钮在标题行，不传）
})

const tm = computed(() => trajTiming(props.t))
const off = computed(() => !(tm.value.L > 0))
const hasTime = computed(() => tm.value.moving || tm.value.t0Set || tm.value.pins > 0)

// —— 读数（草稿优先）——
const draft = reactive({ dep: null, arr: null, dur: null })
const vDep = computed(() => draft.dep ?? (tm.value.moving ? fmtLocalInput(Math.round(tm.value.depMs), props.tz) : ''))
const vArr = computed(() => draft.arr ?? (tm.value.moving ? fmtLocalInput(Math.round(tm.value.arrMs), props.tz) : ''))
const vDur = computed(() => draft.dur ?? fmtDur(tm.value.durMs))
const spVal = computed(() => (Number.isFinite(tm.value.speedKmh) ? tm.value.speedKmh : null))
const spPh = computed(() => (Number.isFinite(props.defSpeed) && props.defSpeed > 0 ? String(props.defSpeed) : ''))
const spKey = ref(0)   // 速度被拒时重挂 NumIn：它只在外部值变了才丢草稿，值没变就得换个实例回到当前值
// 两个时刻框按哪个时区读写（UTC / UTC+8…，同时间轴设置、卫星历元框的角标），挂在到达框后面那格空着的单位位上。
// 本机档按到达那一刻的实际偏移取（夏令时如实）；没排程时取现在 —— 不读 clock：读了这一小块就逐拍重渲染
const tzText = computed(() => tzTag(props.tz, tm.value.moving ? Math.round(tm.value.arrMs) : Date.now()))
watch(() => props.t, () => { draft.dep = null; draft.arr = null; draft.dur = null; setErr('') })

// 历时：1d2h31m12s（零项省掉，至少一项）；输入认单位连写（1h30m、90min、2小时）、h:mm[:ss]，纯数字按小时
function fmtDur(ms) {
  if (!(ms > 0)) return ''
  let s = Math.round(ms / 1000)
  const d = Math.floor(s / 86400); s -= d * 86400
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  let out = (d ? d + 'd' : '') + (h ? h + 'h' : '') + (m ? m + 'm' : '')
  if (s || !out) out += s + 's'
  return out
}
function parseDurText(text) {
  const s = String(text).replace(/\s+/g, '').replace(/：/g, ':')
  const c = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s)
  if (c) return (Number(c[1]) * 3600 + Number(c[2]) * 60 + (c[3] ? Number(c[3]) : 0)) * 1000
  const sec = parseDur(s, 3600)
  return sec == null ? NaN : sec * 1000
}

// —— 报错：只留状态本身，5 s 后自行收起 ——
const ERR = {
  order: '到达时刻早于出发时刻',
  fast: `速度超出上限 ${SPEED_KMH_MAX} km/h`,
  range: '时刻超出范围',
  short: '航点不足',
  bad: '数值无效'
}
const err = ref('')
let errTimer = 0
function setErr(code) {
  if (errTimer) { clearTimeout(errTimer); errTimer = 0 }
  err.value = code ? (ERR[code] || ERR.bad) : ''
  if (code) errTimer = setTimeout(() => { err.value = ''; errTimer = 0 }, 5000)
}
onBeforeUnmount(() => { if (errTimer) clearTimeout(errTimer) })

function run(edit) {
  let r = null
  try { r = props.apply(edit) } catch { r = null }
  const ok = !!(r && r.ok)
  setErr(ok ? '' : (r && r.err) || 'bad')
  return ok
}
function commitDep() {
  const v = draft.dep; draft.dep = null
  if (v == null || v === '') return
  const ms = parseLocalInput(v, props.tz)
  if (ms == null || (tm.value.moving && ms === Math.round(tm.value.depMs))) return
  run({ key: 'dep', value: ms })
}
function commitArr() {
  const v = draft.arr; draft.arr = null
  if (v == null || v === '') return
  const ms = parseLocalInput(v, props.tz)
  if (ms == null || (tm.value.moving && ms === Math.round(tm.value.arrMs))) return
  run({ key: 'arr', value: ms })
}
function commitDur() {
  const v = draft.dur; draft.dur = null
  if (v == null) return
  const s = String(v).trim()
  if (!s || s === fmtDur(tm.value.durMs)) return
  const ms = parseDurText(s)
  if (!(ms > 0)) { setErr('bad'); return }
  run({ key: 'dur', value: ms })
}
function commitSpeed(v) {
  if (v == null || run({ key: 'speed', value: v })) return
  spKey.value++
}
// 此刻：出发设为时间轴游标（取整秒，与时间轴设置的「此刻」同）
function setNow() { run({ key: 'dep', value: Math.round(clock.tMs / 1000) * 1000 }) }
function clearAll() { run({ key: 'clear' }) }
function esc(k, e) { draft[k] = null; if (e && e.target) e.target.blur() }
</script>

<template>
  <div class="ttf" :class="layout">
    <div class="ttr">
      <label>出发</label>
      <input class="ci ttdt" type="datetime-local" step="1" :value="vDep" :disabled="off"
             title="离开首航点的时刻（显示时区）；改出发 = 整条航迹平移，历时不变"
             @input="draft.dep = $event.target.value" @keydown.enter.prevent="commitDep" @keydown.esc.prevent="esc('dep', $event)" @blur="commitDep" />
      <button type="button" class="ttb" :disabled="off" title="出发设为时间轴当前时刻" @click="setNow">此刻</button>
    </div>
    <div class="ttr">
      <label>到达</label>
      <input class="ci ttdt" type="datetime-local" step="1" :value="vArr" :disabled="off"
             title="到达末航点的时刻（显示时区）；改到达 = 出发不动，历时随之变"
             @input="draft.arr = $event.target.value" @keydown.enter.prevent="commitArr" @keydown.esc.prevent="esc('arr', $event)" @blur="commitArr" /><span class="u tz" data-i18n-skip>{{ tzText }}</span>
    </div>
    <div class="ttr">
      <label>历时</label>
      <input class="ci ttin" type="text" spellcheck="false" autocomplete="off" placeholder="1h30m" :value="vDur" :disabled="off"
             title="出发至到达的时长：可连写单位（1h30m、90min、1d2h）或写作 h:mm；纯数字按小时"
             @input="draft.dur = $event.target.value" @keydown.enter.prevent="commitDur" @keydown.esc.prevent="esc('dur', $event)" @blur="commitDur" /><span class="u"></span>
    </div>
    <div class="ttr">
      <label>{{ tm.avg ? '均速' : '速度' }}</label>
      <NumIn :key="spKey" class="ttsp" :model-value="spVal" :sig="5" :placeholder="spPh" :disabled="off"
             :title="tm.avg ? '全程平均地速（航点设有时刻，各段快慢不同）；改均速 = 各航点时刻按比例伸缩' : '地速（WGS-84 测地线里程）；改速度 = 出发不动，历时随之变'"
             @commit="commitSpeed" /><span class="u">km/h</span>
    </div>
    <div v-if="err || hasTime || locate" class="tta">
      <span v-if="err" class="tterr" role="alert">{{ err }}</span>
      <button v-if="locate && tm.moving" type="button" class="ttb" title="时间轴定位到该航迹：游标落在出发时刻，时间窗框住全程" @click="locate()">定位</button>
      <button v-if="hasTime" type="button" class="ttb" title="清除出发时刻与各航点时刻，载具停在末航点" @click="clearAll">清除</button>
    </div>
  </div>
</template>

<style scoped>
.ttr { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-height: var(--h-ctl); }
.ttr > label { flex: none; color: var(--text-muted); white-space: nowrap; }
.ttdt { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.u { flex: none; min-width: 30px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 时区角标：次要读数，小一号、淡一档 —— 「UTC+8」落在行尾单位槽里，到达框右沿仍与出发 / 巡航高度各框对齐 */
.u.tz { font-size: var(--fs-1); color: var(--text-faint); white-space: nowrap; }
/* 文字钮（此刻 / 定位 / 清除）：链接式的轻量画法 */
.ttb { flex: none; height: auto; padding: 0 2px; border: 0; background: transparent; font: inherit; font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; }
.ttb:hover:not(:disabled) { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.ttb:disabled { color: var(--text-faint); cursor: default; }
.tterr { color: var(--danger); font-size: var(--fs-2); }

/* 地图标记属性检查器：标签列与同区的 .srow 对齐（宿主给 --srow-lab，英文档更宽），不缩进；行距、尾格宽同 .srow（8px / 34px）。
   每行尾都留一格（此刻 / 单位 / 空位），各框右沿对齐到同一条线，与巡航高度行的「m」一列；时刻框装不下时整件折到下一行，不裁字 */
.form .ttr { margin-bottom: 8px; }
.form .ttr > label { min-width: var(--srow-lab, 70px); }
.form .ttdt { flex: 1 1 0; min-width: 160px; }
.form .ttin, .form .ttsp { flex: 1 1 0; min-width: 72px; }
.form .u, .form .ttr > .ttb { min-width: 34px; }
.form .ttr > .ttb { padding: 0; text-align: right; }
.form .tta { display: flex; align-items: center; justify-content: flex-end; gap: 4px 10px; margin: -2px 0 8px; }
.form .tta .tterr { margin-right: auto; }

/* 表格参数栏：整件并进外层 flex 行（外层负责换行与间距） */
.bar, .bar .ttr, .bar .tta { display: contents; }
.bar .u:empty { display: none; }
.bar .ttr > label { margin-left: 6px; }
.bar .ttdt { flex: none; width: 176px; }
.bar .ttin { flex: none; width: 84px; }
.bar .ttsp { flex: none; width: 72px; }
</style>
