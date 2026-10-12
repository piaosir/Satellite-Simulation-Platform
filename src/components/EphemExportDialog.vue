<script setup>
// 「导出星历」对话框：任意一批卫星（内置星座 / 卫星组 / 导入组 / 自定义星座 / 天线树 / 搜索结果 / 单星）→ 任一格式。
//   宿主把成员解析成导出项（items，形状见 electron/services/ephemExport.js 头注）交进来；读数（各格式能写几颗、
//   点序列星的时段、能否逐字节吐原文）问主进程 omm:exportPlan，执行走 omm:exportEphem（弹保存框 / 选文件夹、
//   逐星算逐星写盘、进度经 onExportProgress 推回、可取消）。
//   平均根数：OMM CSV / JSON / KVN / XML、TLE / 3LE —— 只有平均根数星写得出（TLE 另受 Alpha-5 编号上限）。
//   点序列：CCSDS OEM（KVN / XML）、STK .e、中国卫通 .eph —— 全部星都写得出：平均根数星按时段 × 步长采样，
//   点序列星缺省导原始采样点（数值逐位等于导入时）。单目标格式一星一个文件。
// 对话框壳自带（ephx- 前缀、z 300），不依赖宿主窗口的 CSS。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { byLang } from '../shared/i18n/lang.js'

const props = defineProps({
  title: { type: String, default: '' },        // 导出对象名（集名 / 星名）
  titleLit: { type: Boolean, default: false }, // 名字是界面词（跟语言走）还是用户数据
  items: { type: Array, default: () => [] },
  group: { type: Object, default: null },      // { kind:'builtin'|'import', key|id, hidden:[…] }：整组导出的原文快路
  sourceFormat: { type: String, default: '' }, // 导入组：它的导入格式（缺省就选它）
  defaults: { type: Object, default: () => ({}) }, // { fromMs, toMs, stepS, timelineFromMs, timelineToMs, nativeFrame }
  z: { type: Number, default: 300 }                 // 叠在别的模态（文件管理 z 2000）之上时调高
})
const emit = defineEmits(['close', 'done'])
const api = typeof window !== 'undefined' ? window.api : null

const MEAN = [
  { v: 'omm-csv', t: 'OMM CSV' }, { v: 'omm-json', t: 'OMM JSON' }, { v: 'omm-kvn', t: 'OMM KVN（CCSDS）' }, { v: 'omm-xml', t: 'OMM XML（CCSDS）' },
  { v: 'tle', t: 'TLE（两行）' }, { v: '3le', t: '3LE（三行）' }
]
const POINT = [
  { v: 'ccsds-oem-kvn', t: 'CCSDS OEM（KVN）' }, { v: 'ccsds-oem-xml', t: 'CCSDS OEM（XML）' },
  { v: 'stk-e', t: 'STK 星历（.e）' }, { v: 'cs-eph', t: '中国卫通星历（.eph）' }
]
const isPoint = (f) => POINT.some((x) => x.v === f)
const SINGLE = new Set(['stk-e', 'cs-eph'])
// 各格式可选的坐标系（值 = 平台帧名；显示 = 该格式里的写法）
const FRAMES = {
  'ccsds-oem-kvn': [['TEME', 'TEME'], ['J2000', 'EME2000'], ['TOD', 'TOD'], ['MOD', 'MOD'], ['FIXED', 'ITRF（地固）']],
  'ccsds-oem-xml': [['TEME', 'TEME'], ['J2000', 'EME2000'], ['TOD', 'TOD'], ['MOD', 'MOD'], ['FIXED', 'ITRF（地固）']],
  'stk-e': [['TEME', 'TEMEOfDate'], ['J2000', 'J2000'], ['TOD', 'TrueOfDate'], ['MOD', 'MeanOfDate'], ['FIXED', 'Fixed（地固）']],
  'cs-eph': [['FIXED', '地固系']]
}
const INTERPS = [
  { v: 'lagrange:8', t: '拉格朗日 · 8 点', m: 'lagrange', n: 8 }, { v: 'lagrange:6', t: '拉格朗日 · 6 点', m: 'lagrange', n: 6 },
  { v: 'lagrange:10', t: '拉格朗日 · 10 点', m: 'lagrange', n: 10 }, { v: 'hermite:2', t: '埃尔米特 · 2 点', m: 'hermite', n: 2 }
]

const plan = ref(null)
const kinds = computed(() => (plan.value && plan.value.kinds) || { gp: 0, ephem: 0, fix: 0, norad: 0 })
const nAll = computed(() => props.items.length)
const nGp = computed(() => kinds.value.gp + kinds.value.norad)
const onlyEphem = computed(() => nAll.value > 0 && kinds.value.ephem === nAll.value)

// 缺省格式：导入组按它的来源格式；全是平均根数星给 OMM CSV；有点序列星给 OEM
const format = ref('')
const frame = ref('')
const sampling = ref('native')
const stepS = ref(Number(props.defaults.stepS) > 0 ? Number(props.defaults.stepS) : 60)
const interp = ref('lagrange:8')
const perFile = ref(false)
const fromTxt = ref(''), toTxt = ref('')

const p2 = (n) => String(n).padStart(2, '0')
const toInput = (ms) => { if (!Number.isFinite(ms)) return ''; const d = new Date(ms); return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}` }
const fromInput = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''))
  if (!m || +m[1] < 1000) return NaN
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)
}
const fromMs = computed(() => fromInput(fromTxt.value))
const toMs = computed(() => fromInput(toTxt.value))
// 输入框只到秒：起点向下、终点向上取整，时段才盖得住（点序列星的首末点常带毫秒）
function setSpan(a, b) { if (Number.isFinite(a) && Number.isFinite(b) && b > a) { fromTxt.value = toInput(Math.floor(a / 1000) * 1000); toTxt.value = toInput(Math.ceil(b / 1000) * 1000) } }

const spanOk = computed(() => Number.isFinite(fromMs.value) && Number.isFinite(toMs.value) && toMs.value > fromMs.value)
const stepOk = computed(() => Number(stepS.value) > 0)
const needGrid = computed(() => isPoint(format.value) && (nAll.value - kinds.value.ephem > 0 || sampling.value === 'grid'))
const pointsPerSat = computed(() => (needGrid.value && spanOk.value && stepOk.value ? Math.floor((toMs.value - fromMs.value) / (Number(stepS.value) * 1000)) + 1 : null))
const exportable = computed(() => {
  const p = plan.value
  if (!p) return 0
  const f = format.value
  if (f === 'tle' || f === '3le') return p.tle
  if (!isPoint(f)) return p.mean
  return p.point
})
const skipNote = computed(() => {
  const p = plan.value, f = format.value
  if (!p || isPoint(f)) return ''
  const out = []
  if (kinds.value.ephem) out.push(byLang(`星历点序列 ${kinds.value.ephem} 颗没有平均根数`, `${kinds.value.ephem} ephemeris point series have no mean elements`))
  if (kinds.value.fix) out.push(byLang(`定点星 ${kinds.value.fix} 颗没有平均根数`, `${kinds.value.fix} fixed-position satellites have no mean elements`))
  if ((f === 'tle' || f === '3le') && p.tleBad) out.push(byLang(`${p.tleBad} 颗编号超出 TLE 编号栏上限（Alpha-5 ≤ 339999）`, `${p.tleBad} catalog numbers exceed the TLE field limit (Alpha-5 ≤ 339999)`))
  return out.join(byLang('；', '; '))
})
// 估算体积：每点一行（KVN ~120 B、XML ~360 B、.e ~110 B、.eph ~165 B）；平均根数每颗 ~200 B
const estBytes = computed(() => {
  const f = format.value, n = exportable.value
  if (!isPoint(f)) return n * 200
  const per = { 'ccsds-oem-kvn': 120, 'ccsds-oem-xml': 360, 'stk-e': 110, 'cs-eph': 165 }[f] || 120
  const pts = pointsPerSat.value != null ? pointsPerSat.value : null
  if (pts == null) return null
  return n * pts * per
})
// KB 档按 1 KB 起（单颗 OMM ~200 B 原先显示成「0 KB」）；0 只在真没有可导出的星时出现
const fmtBytes = (b) => (b == null ? '—' : b <= 0 ? '0 KB' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1048576).toFixed(b < 100 * 1048576 ? 1 : 0) + ' MB')
const multiFile = computed(() => isPoint(format.value) && nAll.value > 1 && (SINGLE.has(format.value) || perFile.value))

const frameOpts = computed(() => FRAMES[format.value] || [])
watch(format, (f) => {
  const opts = FRAMES[f] || []
  if (opts.length && !opts.some((o) => o[0] === frame.value)) frame.value = opts.some((o) => o[0] === nativeFrame.value) ? nativeFrame.value : opts[0][0]
})
// 「原帧」：全部是点序列星且来自同一种帧时取它；否则平均根数的原生帧 TEME
const nativeFrame = ref('TEME')

let planT = 0, planSeq = 0
function req() {
  const [m, n] = interp.value.split(':')
  return {
    items: JSON.parse(JSON.stringify(props.items)),          // IPC 只收纯数据（Vue 代理过不了结构化克隆）
    group: props.group ? JSON.parse(JSON.stringify(props.group)) : null,
    format: format.value,
    fromMs: needGrid.value || sampling.value === 'native' ? (Number.isFinite(fromMs.value) ? fromMs.value : null) : null,
    toMs: needGrid.value || sampling.value === 'native' ? (Number.isFinite(toMs.value) ? toMs.value : null) : null,
    stepS: Number(stepS.value) || 60,
    frame: format.value === 'cs-eph' ? 'FIXED' : frame.value,
    sampling: onlyEphem.value ? sampling.value : 'grid',
    interp: format.value === 'cs-eph' ? null : { method: m, samples: Number(n) },
    perFile: perFile.value,
    includeEnd: true,
    baseName: props.title || 'ephemeris'
  }
}
function refreshPlan() {
  clearTimeout(planT)
  planT = setTimeout(async () => {
    const seq = ++planSeq
    try { const p = api && api.omm && api.omm.exportPlan ? await api.omm.exportPlan(req()) : null; if (seq === planSeq) plan.value = p } catch { /* 读数失败：保留上一份 */ }
  }, 80)
}

const running = ref(false)
const progress = ref(null)     // { done, total }
const result = ref(null)
let jobId = '', offProg = null
async function run() {
  if (running.value || !api || !api.omm || !api.omm.exportEphem) return
  if (needGrid.value && !(spanOk.value && stepOk.value)) return
  running.value = true; result.value = null; progress.value = null
  jobId = 'x' + Date.now().toString(36)
  const r0 = Object.assign(req(), { jobId })
  try {
    const r = await api.omm.exportEphem(r0)
    if (r && r.canceled) { result.value = null; return }
    result.value = r
    emit('done', r)
  } catch (e) { result.value = { ok: false, error: (e && e.message) || String(e) } }
  finally { running.value = false; progress.value = null }
}
function cancelRun() { if (running.value && api && api.omm && api.omm.exportCancel) api.omm.exportCancel(jobId) }
const pct = computed(() => (progress.value && progress.value.total ? Math.round((100 * progress.value.done) / progress.value.total) : 0))
const resultText = computed(() => {
  const r = result.value
  if (!r) return ''
  if (!r.ok) return r.error || byLang('导出失败', 'Export failed')
  const files = (r.files || []).length, sk = r.skipped && r.skipped.length ? r.skipped.length : 0
  return byLang(`已导出 ${r.written} 颗 · ${files} 个文件${r.exact ? ' · 原文' : ''}${sk ? ` · 跳过 ${sk} 颗` : ''}`,
    `Exported ${r.written} · ${files} file${files === 1 ? '' : 's'}${r.exact ? ' · original file' : ''}${sk ? ` · ${sk} skipped` : ''}`)
})
const resultTitle = computed(() => {
  const r = result.value
  if (!r) return ''
  const a = (r.files || []).map((f) => f.path)
  const b = (r.skipped || []).map((s) => `${s.name}：${s.reason}`)
  return a.concat(b).join('\n')
})

function onKey(e) {
  if (e.key !== 'Escape' || e.isComposing) return
  e.preventDefault(); e.stopPropagation()
  if (running.value) { cancelRun(); return }
  emit('close')
}
watch([format, frame, sampling, stepS, interp, perFile, fromTxt, toTxt], refreshPlan)
onMounted(async () => {
  document.addEventListener('keydown', onKey, true)
  if (api && api.omm && api.omm.onExportProgress) offProg = api.omm.onExportProgress((p) => { if (p && p.id === jobId) progress.value = p })
  // 先问一次读数，再定缺省（格式 / 时段 / 帧都要看成员构成）
  try { plan.value = api && api.omm && api.omm.exportPlan ? await api.omm.exportPlan(Object.assign(req(), { format: 'ccsds-oem-kvn' })) : null } catch { plan.value = null }
  const p = plan.value
  const k = (p && p.kinds) || {}
  const src = props.sourceFormat
  format.value = src && (MEAN.some((x) => x.v === src) || isPoint(src)) ? src : ((k.ephem || k.fix) ? 'ccsds-oem-kvn' : 'omm-csv')
  const nf = props.defaults.nativeFrame
  nativeFrame.value = nf || 'TEME'
  frame.value = (FRAMES[format.value] || []).some((o) => o[0] === nativeFrame.value) ? nativeFrame.value : ((FRAMES[format.value] || [['TEME']])[0][0])
  sampling.value = onlyEphem.value ? 'native' : 'grid'
  if (onlyEphem.value && p && p.ephemSpan) setSpan(p.ephemSpan.t0, p.ephemSpan.t1)
  else setSpan(Number(props.defaults.fromMs), Number(props.defaults.toMs))
  if (!fromTxt.value) { const now = Math.floor(Date.now() / 60000) * 60000; setSpan(now, now + 86400000) }
  refreshPlan()
})
onBeforeUnmount(() => { document.removeEventListener('keydown', onKey, true); clearTimeout(planT); if (offProg) offProg() })

const presetTimeline = () => setSpan(Number(props.defaults.timelineFromMs), Number(props.defaults.timelineToMs))
const presetEphem = () => { const s = plan.value && plan.value.ephemSpan; if (s) setSpan(s.t0, s.t1) }
const presetDays = (d) => { const a = Number.isFinite(fromMs.value) ? fromMs.value : Math.floor(Date.now() / 60000) * 60000; setSpan(a, a + d * 86400000) }
const hasTimeline = computed(() => Number.isFinite(Number(props.defaults.timelineFromMs)) && Number.isFinite(Number(props.defaults.timelineToMs)) && Number(props.defaults.timelineToMs) > Number(props.defaults.timelineFromMs))
</script>

<template>
  <div class="ephx-mask" :style="{ zIndex: z }" @mousedown.self="!running && emit('close')">
    <div class="ephx-dlg" role="dialog" aria-modal="true">
      <div class="ephx-hd">
        <span>导出星历</span>
        <button type="button" class="ephx-x" aria-label="关闭" title="关闭" :disabled="running" @click="emit('close')"><Icon name="x" :size="12" /></button>
      </div>
      <div class="ephx-body">
        <div class="ephx-obj">
          <span class="ephx-on" :data-i18n-skip="titleLit ? null : ''">{{ title }}</span>
          <span class="ephx-rd"><span>卫星</span> {{ nAll }}<template v-if="kinds.ephem"><span class="sep">·</span><span>星历点序列</span> {{ kinds.ephem }}</template><template v-if="kinds.fix"><span class="sep">·</span><span>定点</span> {{ kinds.fix }}</template></span>
        </div>
        <div class="ephx-grid">
          <span class="ephx-k">格式</span>
          <select v-model="format" class="ephx-v" :disabled="running">
            <!-- optgroup 的 label 是属性，呈现层只翻 title / placeholder 一类：按语言现出字 -->
            <optgroup :label="byLang('平均根数', 'Mean elements')">
              <option v-for="o in MEAN" :key="o.v" :value="o.v" :disabled="!nGp || ((o.v === 'tle' || o.v === '3le') && plan && !plan.tle)">{{ o.t }}</option>
            </optgroup>
            <optgroup :label="byLang('星历点序列', 'Ephemeris point sequence')">
              <option v-for="o in POINT" :key="o.v" :value="o.v">{{ o.t }}</option>
            </optgroup>
          </select>

          <template v-if="isPoint(format)">
            <span class="ephx-k">时段<i>UTC</i></span>
            <div class="ephx-v ephx-span">
              <input v-model="fromTxt" type="datetime-local" step="1" :disabled="running" />
              <span class="ephx-ar">→</span>
              <input v-model="toTxt" type="datetime-local" step="1" :disabled="running" />
            </div>
            <span></span>
            <div class="ephx-v ephx-pre">
              <button v-if="kinds.ephem" type="button" class="ephx-chip" :disabled="running" title="导入星历的全时段" @click="presetEphem">星历时段</button>
              <button v-if="hasTimeline" type="button" class="ephx-chip" :disabled="running" title="主窗口时间轴的起止时刻" @click="presetTimeline">时间轴</button>
              <button type="button" class="ephx-chip" :disabled="running" @click="presetDays(1)">1 天</button>
              <button type="button" class="ephx-chip" :disabled="running" @click="presetDays(7)">7 天</button>
              <button type="button" class="ephx-chip" :disabled="running" @click="presetDays(30)">30 天</button>
            </div>

            <span class="ephx-k">采样</span>
            <div class="ephx-v ephx-inl">
              <select v-if="onlyEphem" v-model="sampling" :disabled="running" title="原始采样点：输出导入时的原点，数值逐位不变；等间隔：按步长重新插值">
                <option value="native">原始采样点</option>
                <option value="grid">等间隔</option>
              </select>
              <template v-if="needGrid">
                <span class="ephx-k2">步长</span>
                <input v-model.number="stepS" type="number" min="1" step="1" class="ephx-num" :disabled="running" />
                <span class="ephx-u">s</span>
              </template>
            </div>

            <span class="ephx-k">坐标系</span>
            <select v-model="frame" class="ephx-v" :disabled="running || frameOpts.length < 2">
              <option v-for="o in frameOpts" :key="o[0]" :value="o[0]">{{ o[1] }}</option>
            </select>

            <template v-if="format !== 'cs-eph'">
              <span class="ephx-k">插值</span>
              <select v-model="interp" class="ephx-v" :disabled="running" title="写进文件头的插值方法与点数（读入方据此插值）">
                <option v-for="o in INTERPS" :key="o.v" :value="o.v">{{ o.t }}</option>
              </select>
            </template>

            <template v-if="nAll > 1 && !SINGLE.has(format)">
              <span class="ephx-k">输出</span>
              <label class="ephx-v ephx-ck"><input v-model="perFile" type="checkbox" :disabled="running" /><span>每颗卫星一个文件</span></label>
            </template>
          </template>
        </div>

        <div class="ephx-sum">
          <span class="ephx-rd"><span>可导出</span> {{ exportable }}/{{ nAll }}</span>
          <span v-if="isPoint(format) && pointsPerSat != null" class="ephx-rd"><span>每颗</span> {{ pointsPerSat }} <span>点</span></span>
          <span class="ephx-rd"><span>约</span> {{ fmtBytes(estBytes) }}</span>
          <span v-if="multiFile" class="ephx-rd">{{ exportable }} <span>个文件</span></span>
          <span v-if="plan && plan.exact" class="ephx-rd ok" title="整组同格式、原始采样、全时段：直接写导入时的原文件，逐字节一致">原文</span>
        </div>
        <div v-if="skipNote" class="ephx-warn">{{ skipNote }}</div>
        <div v-if="isPoint(format) && needGrid && !(spanOk && stepOk)" class="ephx-warn">时段或步长无效</div>
        <div v-if="result" class="ephx-res" :class="{ bad: !result.ok }" :title="resultTitle">{{ resultText }}</div>
      </div>
      <div class="ephx-ft">
        <span v-if="running" class="ephx-cnt"><span>导出中</span> {{ pct }}%</span>
        <span v-else class="ephx-cnt"></span>
        <button v-if="running" type="button" class="ephx-btn ghost" @click="cancelRun">停止</button>
        <button v-else type="button" class="ephx-btn ghost" @click="emit('close')">{{ result && result.ok ? '关闭' : '取消' }}</button>
        <button type="button" class="ephx-btn" :disabled="running || !exportable || (isPoint(format) && needGrid && !(spanOk && stepOk))" @click="run">导出…</button>
      </div>
    </div>
  </div>
</template>

<style>
.ephx-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: var(--scrim); }
.ephx-dlg { width: 520px; max-width: calc(100% - 32px); max-height: 86%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); overflow: hidden; box-shadow: var(--shadow-3); animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.ephx-hd { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); color: var(--text); flex: none; }
.ephx-x { margin-left: auto; cursor: pointer; display: inline-flex; border: 0; background: transparent; padding: 2px; border-radius: var(--r-ctl); color: var(--text-faint); }
.ephx-x:hover:not(:disabled) { color: var(--text); background: var(--wash-hover); }
.ephx-body { padding: 12px 14px; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.ephx-obj { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.ephx-on { font-size: var(--fs-4); color: var(--text); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ephx-grid { display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: center; column-gap: 10px; row-gap: 8px; }
.ephx-k { font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
.ephx-k i { font-style: normal; margin-left: 4px; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.ephx-k2 { font-size: var(--fs-3); color: var(--text-muted); margin-left: 10px; }
.ephx-v { min-width: 0; width: 100%; }
.ephx-span { display: flex; align-items: center; gap: 6px; }
.ephx-span input { flex: 1; min-width: 0; padding-inline: 6px; font-family: var(--font-mono); font-size: var(--fs-2); }
.ephx-ar { flex: none; color: var(--text-faint); }
.ephx-pre { display: flex; flex-wrap: wrap; gap: 6px; }
.ephx-chip { height: 22px; padding: 0 9px; font-size: var(--fs-2); color: var(--text-muted); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-pill); cursor: pointer; }
.ephx-chip:hover:not(:disabled) { color: var(--text); border-color: var(--line-hover); }
.ephx-chip:disabled { opacity: .45; cursor: not-allowed; }
.ephx-inl { display: flex; align-items: center; gap: 6px; }
.ephx-inl select { flex: none; width: auto; }
.ephx-num { width: 84px; padding-inline: 6px; text-align: right; font-family: var(--font-mono); }
.ephx-u { font-size: var(--fs-2); color: var(--text-faint); }
.ephx-ck { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-3); color: var(--text); cursor: pointer; }
.ephx-sum { display: flex; flex-wrap: wrap; gap: 6px 14px; padding-top: 2px; border-top: 1px solid var(--border); padding-top: 8px; }
.ephx-rd { font-size: var(--fs-2); color: var(--text-muted); font-family: var(--font-mono); white-space: nowrap; }
.ephx-rd .sep { margin: 0 6px; color: var(--text-faint); }
.ephx-rd.ok { color: var(--ok); }
.ephx-warn { font-size: var(--fs-2); color: var(--warn); }
.ephx-res { font-size: var(--fs-2); color: var(--ok); font-family: var(--font-mono); }
.ephx-res.bad { color: var(--danger); font-family: inherit; }
.ephx-ft { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); flex: none; }
.ephx-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; margin-right: auto; }
.ephx-btn { display: inline-flex; align-items: center; justify-content: center; height: var(--h-ctl-lg); padding: 0 18px;
            font-size: var(--fs-3); white-space: nowrap; cursor: pointer; user-select: none; color: var(--primary-on);
            background: var(--primary-fill); border: 1px solid var(--primary-fill); border-radius: var(--r-ctl); }
.ephx-btn:hover:not(:disabled) { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.ephx-btn.ghost { color: var(--text); background: var(--bg); border-color: var(--border-strong); }
.ephx-btn.ghost:hover:not(:disabled) { background: var(--bg); border-color: var(--line-hover); }
.ephx-btn:disabled { opacity: .45; cursor: not-allowed; }
</style>
