<script setup>
// 「指向误差」工具 —— GSO 窗口：卫星日内运动（倾角 / 偏心率 / 东西保持）+ 地球站跟踪方式 + 误差预算分项
// → 一天的指向偏离与指向损耗。
//
// 只读工具：结果只在这里给工程师看，不回写链路表 / 资源库、不进链路引擎（页脚只有「关闭」）。
// 每次打开按链路表聚焦行（没有就取第一行）重播种：定点经度、上 / 下行频率取该行所用卫星，站址取该行两端，
// 天线口径 / 效率取两端各自的地球站配置。倾角 / 偏心率 / 东西保持、跟踪方式与误差分项是工具自己的量：
// 本窗口会话内保留（换一行再开不必重填），不落盘。
//
// 口径（packages/core/utils/geoTrack.js 的 gsoPointingBudget，经 IPC link:pointingBudget 在主进程算）：
//   1 min 步长、24 h；主项 θ_main(t)：固定 = 卫星运动带来的视线偏离（对日平均指向），步进跟踪 = 跟踪残差；
//   θ(t) = √(θ_main(t)² + Σθ_i²)；损耗 = 高斯主瓣 12·(θ/θ3dB)²，出主瓣按 RR 附录 8 旁瓣封顶。
//   分项取舍：步进跟踪按信标 / 信号峰值闭环，对星校准、重力 / 热变形这类慢变偏差被跟踪吸收，伺服 / 驱动误差
//   （步进量、齿隙、编码器）已含在厂家给的跟踪精度里 —— 这三项步进跟踪时不显示也不计入；阵风比步进周期快、
//   跟不上，风载两种方式都计入。
import { ref, reactive, computed, watch, onUnmounted } from 'vue'
import AppDialog from './AppDialog.vue'
import { num } from '../shared/num.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  // 初值（字符串，与表格同写法）：{ lonDeg, upGHz, dnGHz, tx: { lat, lon, altM, diameterM, effPct }, rx: { … } }
  seed: { type: Object, default: null }
})
const emit = defineEmits(['close'])

const api = (typeof window !== 'undefined' && window.api) ? window.api.linkBudget : null
// 英文标签长一截：框体随语言加宽（标签列宽见样式末尾 html[lang="en"]）
const lang = ref(getLang())
onUnmounted(onLangChange((l) => { lang.value = l }))

const SIDES = [
  { v: 'tx', l: '发信站', tip: '发信站：频率取上行频率' },
  { v: 'rx', l: '收信站', tip: '收信站：频率取下行频率' }
]
const MODES = [
  { v: 'fixed', l: '固定', tip: '固定：天线对准日平均指向不动，主项取卫星运动带来的视线偏离' },
  { v: 'step', l: '步进跟踪', tip: '步进跟踪：天线跟着卫星走，主项取跟踪残差；对星校准、重力 / 热变形、伺服 / 驱动由跟踪闭环吸收，不计入' }
]
// 误差预算分项（°）。step：步进跟踪时是否仍计入（见文件头「分项取舍」）
const ITEMS = [
  { k: 'cal', l: '对星校准', step: false, tip: '对星校准误差：开通对星时的指向标定残差（含电轴与机械轴偏差），按常值计入方和根' },
  { k: 'wind', l: '风载', step: true, tip: '风载指向误差：阵风引起的天线指向抖动（比步进周期快，步进跟踪时仍计入）' },
  { k: 'grav', l: '重力 / 热变形', step: false, tip: '重力 / 热变形：反射面与座架变形引起的指向偏差' },
  { k: 'servo', l: '伺服 / 驱动', step: false, tip: '伺服 / 驱动误差：编码器分辨率、齿隙与驱动误差' }
]

const side = ref('tx')
const sat = reactive({ lon: '', incl: '0', ecc: '0', box: '0' })
const blankStation = () => ({ lat: '', lon: '', alt: '0', d: '', eff: '', f: '', mode: 'fixed', resid: '0', cal: '0', wind: '0', grav: '0', servo: '0' })
const sta = reactive({ tx: blankStation(), rx: blankStation() })
const cur = computed(() => sta[side.value])
const freqLabel = computed(() => (side.value === 'tx' ? '上行频率' : '下行频率'))
const activeItems = computed(() => ITEMS.filter((it) => cur.value.mode === 'fixed' || it.step))

// 每次打开按宿主当前聚焦行重播种（只动播种的那几格，工具自己的量留着）
watch(() => props.open, (o) => {
  if (!o) return
  const s = props.seed || {}
  const str = (v) => (v == null ? '' : String(v))
  sat.lon = str(s.lonDeg)
  for (const k of ['tx', 'rx']) {
    const p = s[k] || {}, t = sta[k]
    t.lat = str(p.lat); t.lon = str(p.lon); t.alt = str(p.altM == null || p.altM === '' ? 0 : p.altM)
    t.d = str(p.diameterM); t.eff = str(p.effPct)
    t.f = str(k === 'tx' ? s.upGHz : s.dnGHz)
  }
}, { immediate: true })

// 格值 → 数：留空时必填项为 NaN（标红），选填项按 0；非数一律 NaN
const val = (v, req) => {
  const s = String(v == null ? '' : v).trim()
  if (s === '') return req ? NaN : 0
  const n = num(s)
  return n == null ? NaN : n
}
// 不成立的格（标红，整份不算）
const bad = computed(() => {
  const t = cur.value, out = new Set()
  const chk = (key, v, req, ok) => { const n = val(v, req); if (!(Number.isFinite(n) && ok(n))) out.add(key) }
  chk('satLon', sat.lon, true, (x) => x >= -180 && x <= 360)
  chk('incl', sat.incl, false, (x) => x >= 0 && x <= 15)
  chk('ecc', sat.ecc, false, (x) => x >= 0 && x <= 0.05)
  chk('box', sat.box, false, (x) => x >= 0 && x <= 5)
  chk('lat', t.lat, true, (x) => x >= -90 && x <= 90)
  chk('lon', t.lon, true, (x) => x >= -180 && x <= 360)
  chk('alt', t.alt, false, () => true)
  chk('d', t.d, true, (x) => x > 0)
  chk('eff', t.eff, true, (x) => x > 0 && x <= 100)
  chk('f', t.f, true, (x) => x > 0)
  if (t.mode === 'step') chk('resid', t.resid, false, (x) => x >= 0)
  for (const it of activeItems.value) chk(it.k, t[it.k], false, (x) => x >= 0)
  return out
})
// 送主进程的纯数据入参；有格不成立则 null
const req = computed(() => {
  if (bad.value.size) return null
  const t = cur.value
  return {
    sat: { lonDeg: val(sat.lon, true), inclDeg: val(sat.incl), ecc: val(sat.ecc), boxDeg: val(sat.box) },
    station: { latDeg: val(t.lat, true), lonDeg: val(t.lon, true), altKm: val(t.alt) / 1000, freqGHz: val(t.f, true), diameterM: val(t.d, true), efficiencyPct: val(t.eff, true) },
    mode: t.mode,
    residualDeg: t.mode === 'step' ? val(t.resid) : 0,
    budgetDeg: activeItems.value.map((it) => val(t[it.k]))
  }
})

// 改一格就重算（一天 1441 拍，主进程几毫秒；按入参缓存）。回包按序号认领：慢的那次回来晚了直接丢
const res = ref(null)
const err = ref('')
let seq = 0, timer = null
async function run() {
  const my = ++seq
  const q = req.value
  if (!q) { res.value = null; return }
  if (!api || !api.pointingBudget) { res.value = null; err.value = '需在桌面客户端中运行。'; return }
  try {
    const r = await api.pointingBudget(JSON.parse(JSON.stringify(q)))
    if (my !== seq) return
    res.value = r || null
    err.value = ''
  } catch (e) {
    if (my !== seq) return
    res.value = null
    err.value = String((e && e.message) || e)
  }
}
watch([() => props.open, () => JSON.stringify(req.value)], ([o]) => {
  clearTimeout(timer)
  if (!o) return
  if (!req.value) { seq++; res.value = null; return }
  timer = setTimeout(run, 60)
}, { immediate: true })

const below = computed(() => !!res.value && res.value.minElevDeg < 0)
const fmt = (v, dp) => (v == null || !isFinite(v) ? '—' : Number(v).toFixed(dp))
const span = (a, b, dp) => (a == null || !isFinite(a) || b == null || !isFinite(b) ? '—' : `${fmt(a, dp)} – ${fmt(b, dp)}`)
</script>

<template>
  <!-- 外壳是 AppDialog（Esc / 关闭钮关、点遮罩不关） -->
  <AppDialog :open="open" :width="lang === 'en' ? 600 : 460" flush @close="emit('close')">
      <template #title>指向误差</template>

      <div class="pt-bd">
        <div class="seg sm pt-side" role="radiogroup">
          <button v-for="s in SIDES" :key="s.v" type="button" role="radio" class="sg" :class="{ on: side === s.v }"
                  :aria-checked="side === s.v ? 'true' : 'false'" :title="s.tip" @click="side = s.v">{{ s.l }}</button>
        </div>

        <div class="pt-sep"></div>

        <div class="pt-g">
          <label class="pt-f" title="卫星定点经度（日平均经度；东西保持取盒心）"><span class="pt-l">定点经度</span>
            <input v-model="sat.lon" class="pt-in mono" :class="{ bad: bad.has('satLon') }" inputmode="decimal" /><i class="pt-u">°E</i></label>
          <label class="pt-f" title="轨道倾角：星下点每天南北摆动 ±i、画「8」字（二体同步轨道）；0 = 定点"><span class="pt-l">倾角</span>
            <input v-model="sat.incl" class="pt-in mono" :class="{ bad: bad.has('incl') }" inputmode="decimal" /><i class="pt-u">°</i></label>
          <label class="pt-f" title="轨道偏心率：每天东西摆动 ±2e rad、径向 ±a·e（近地点幅角取 0，东西与南北摆动同相）；0 = 正圆"><span class="pt-l">偏心率</span>
            <input v-model="sat.ecc" class="pt-in mono" :class="{ bad: bad.has('ecc') }" inputmode="decimal" /><i class="pt-u"></i></label>
          <label class="pt-f" title="东西位保窗口半宽：当日平均经度落在盒边（两边各算一遍取差的那边）；固定天线对准盒心那一天的日平均指向"><span class="pt-l">东西保持 ±</span>
            <input v-model="sat.box" class="pt-in mono" :class="{ bad: bad.has('box') }" inputmode="decimal" /><i class="pt-u">°</i></label>
        </div>

        <div class="pt-sep"></div>

        <div class="pt-g">
          <label class="pt-f" title="站点大地纬度（WGS-84）"><span class="pt-l">站点纬度</span>
            <input v-model="cur.lat" class="pt-in mono" :class="{ bad: bad.has('lat') }" inputmode="decimal" /><i class="pt-u">°</i></label>
          <label class="pt-f"><span class="pt-l">站点经度</span>
            <input v-model="cur.lon" class="pt-in mono" :class="{ bad: bad.has('lon') }" inputmode="decimal" /><i class="pt-u">°E</i></label>
          <label class="pt-f"><span class="pt-l">站点海拔</span>
            <input v-model="cur.alt" class="pt-in mono" :class="{ bad: bad.has('alt') }" inputmode="decimal" /><i class="pt-u">m</i></label>
          <label class="pt-f"><span class="pt-l">天线口径</span>
            <input v-model="cur.d" class="pt-in mono" :class="{ bad: bad.has('d') }" inputmode="decimal" /><i class="pt-u">m</i></label>
          <label class="pt-f"><span class="pt-l">天线效率</span>
            <input v-model="cur.eff" class="pt-in mono" :class="{ bad: bad.has('eff') }" inputmode="decimal" /><i class="pt-u">%</i></label>
          <label class="pt-f"><span class="pt-l">{{ freqLabel }}</span>
            <input v-model="cur.f" class="pt-in mono" :class="{ bad: bad.has('f') }" inputmode="decimal" /><i class="pt-u">GHz</i></label>
        </div>

        <div class="pt-sep"></div>

        <div class="pt-g">
          <div class="pt-f"><span class="pt-l">跟踪方式</span>
            <div class="seg sm pt-mode" role="radiogroup">
              <button v-for="m in MODES" :key="m.v" type="button" role="radio" class="sg" :class="{ on: cur.mode === m.v }"
                      :aria-checked="cur.mode === m.v ? 'true' : 'false'" :title="m.tip" @click="cur.mode = m.v">{{ m.l }}</button>
            </div>
          </div>
          <label v-if="cur.mode === 'step'" class="pt-f" title="步进跟踪的指向残差（厂家给的跟踪精度）"><span class="pt-l">跟踪残差</span>
            <input v-model="cur.resid" class="pt-in mono" :class="{ bad: bad.has('resid') }" inputmode="decimal" /><i class="pt-u">°</i></label>
        </div>
        <div class="pt-g pt-items">
          <label v-for="it in activeItems" :key="it.k" class="pt-f" :title="it.tip"><span class="pt-l">{{ it.l }}</span>
            <input v-model="cur[it.k]" class="pt-in mono" :class="{ bad: bad.has(it.k) }" inputmode="decimal" /><i class="pt-u">°</i></label>
        </div>

        <div class="pt-sep"></div>

        <div class="pt-rd">
          <div class="pt-r" title="指向损耗日最大值：θ(t) = √(θ_main(t)² + Σθ_i²) 逐分钟（24 h）求损耗取最大；高斯主瓣 12·(θ/θ3dB)²，出主瓣按 RR 附录 8 旁瓣封顶">
            <span class="pt-k">日最大损耗</span><span class="pt-big mono">{{ fmt(res && res.lossMaxDb, 2) }}</span><i>dB</i></div>
          <div class="pt-r" title="日内 θ(t) 的最大值（主项与各分项方和根）">
            <span class="pt-k">最大总偏离角</span><span class="pt-v mono">{{ fmt(res && res.maxOffDeg, 4) }}</span><i>°</i></div>
          <div class="pt-r" title="一天里 50% 的时间超过的指向损耗">
            <span class="pt-k">50% 时间损耗</span><span class="pt-v mono">{{ fmt(res && res.lossP50Db, 2) }}</span><i>dB</i></div>
          <div class="pt-r" title="半功率波束宽度 θ3dB = 70λ/D">
            <span class="pt-k">θ3dB</span><span class="pt-v mono">{{ fmt(res && res.theta3dBDeg, 4) }}</span><i>°</i></div>
          <div class="pt-r" title="一天里 1% 的时间超过的指向损耗">
            <span class="pt-k">1% 时间损耗</span><span class="pt-v mono">{{ fmt(res && res.lossP1Db, 2) }}</span><i>dB</i></div>
          <div class="pt-r" title="日内最大距离变化率 × f / c">
            <span class="pt-k">最大多普勒</span><span class="pt-v mono">{{ fmt(res && res.maxDopplerHz, 1) }}</span><i>Hz</i></div>
          <div class="pt-r wide" title="日内仰角范围（WGS-84 椭球 + 站点海拔）">
            <span class="pt-k">日内仰角</span><span class="pt-v mono">{{ span(res && res.minElevDeg, res && res.maxElevDeg, 2) }}</span><i>°</i></div>
          <div class="pt-r wide" title="日内斜距范围">
            <span class="pt-k">日内斜距</span><span class="pt-v mono">{{ span(res && res.minRangeKm, res && res.maxRangeKm, 1) }}</span><i>km</i></div>
        </div>
        <div v-if="err" class="pt-err">{{ err }}</div>
        <div v-else-if="below" class="pt-err">卫星低于地平线。</div>

        <div class="pt-sep"></div>

        <table class="pt-tb" title="偏离角 → 指向损耗（本站天线：高斯主瓣，出主瓣按 RR 附录 8 旁瓣封顶）">
          <thead><tr><th>θ/θ3dB</th><th>偏离角 (°)</th><th>损耗 (dB)</th></tr></thead>
          <tbody>
            <tr v-for="q in (res && res.quick) || []" :key="q.ratio">
              <td class="mono">{{ q.ratio }}</td><td class="mono">{{ fmt(q.thetaDeg, 4) }}</td><td class="mono">{{ fmt(q.lossDb, 2) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template #footer>
        <button class="btn" @click="emit('close')">关闭</button>
      </template>
  </AppDialog>
</template>

<style scoped>
/* 外壳归 AppDialog；尺度与斜距工具（LbSlantTool）同一套 */
.pt-bd { padding: 10px; }
.pt-sep { height: 1px; background: var(--border); margin: 9px 0; }
.pt-side { width: 100%; }
.pt-side > .sg { flex: 1 1 0; text-align: center; }
.pt-g { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 12px; }
.pt-items { margin-top: 5px; }
.pt-f { display: grid; grid-template-columns: 70px 1fr 26px; align-items: center; gap: 6px; min-width: 0; }
.pt-f > .pt-mode { grid-column: 2 / 4; }
.pt-mode > .sg { flex: 1 1 0; text-align: center; }
.pt-l { font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
.pt-in { font: inherit; font-size: var(--fs-3); padding: 4px 7px; width: 100%; min-width: 0; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px); }
.pt-in:focus { outline: none; border-color: var(--accent-ui); }
.pt-in.bad { border-color: var(--danger); }
.pt-u { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.mono { font-family: var(--font-mono); }
.pt-rd { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
.pt-r { display: grid; grid-template-columns: 76px auto 1fr; align-items: baseline; column-gap: 6px; min-width: 0; }
.pt-r.wide { grid-column: 1 / -1; }
.pt-k { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.pt-v { font-size: var(--fs-3); color: var(--text); }
.pt-big { font-size: var(--fs-5); color: var(--accent); }
.pt-r i { font-size: var(--fs-2); color: var(--text-faint); font-style: normal; }
.pt-err { margin-top: 8px; font-size: var(--fs-3); color: var(--danger); }
.pt-tb { width: 100%; border-collapse: collapse; font-size: var(--fs-2); }
.pt-tb th { text-align: right; font-weight: 500; color: var(--text-faint); padding: 2px 6px; border-bottom: 1px solid var(--border); }
.pt-tb td { text-align: right; padding: 2px 6px; color: var(--text-muted); }
/* 读数可框选复制（口径同斜距工具）：只放开读数，标签 / 按钮仍不可选 */
.pt-v, .pt-big, .pt-tb td { user-select: text; -webkit-user-select: text; cursor: text; }
/* 英文标签列加宽（整条写进 :global —— 写成 :global(html[lang="en"]) .pt-f 会被编译器截成只剩 html[lang="en"]） */
:global(html[lang="en"] .pt-f) { grid-template-columns: 132px 1fr 26px; }
:global(html[lang="en"] .pt-r) { grid-template-columns: 124px auto 1fr; }
</style>
