<script setup>
// 分析 › 星侧太阳侵入（任务书 §6.8、DESIGN2 D10 / D11 / D12）：选中挂点的视轴（姿态律 × 挂点系，逐拍 ECEF）+ 星位 → 主进程
// sunOutage.satIntrusion（日凌核：高精度太阳位置、当日视直径、地球遮挡日面比例、日面求积平均增益、NoRP 亮温）→ 逐拍 ΔT（K）与
// ΔG/T = 10·lg(1 + ΔT / T_sys)（dB）。最坏值与时刻给链路预算的「太阳侵入 ΔG/T」用（「复制最坏 ΔG/T」，不跨窗自动回填，D11）。
// 方向图：挂点天线引用 GRD 树天线时按 GRD 取增益（{kind:'grd', key}），否则高斯主瓣（−3 dB 全宽：参数化口径 hpbw → 70λ/D → 增益反推，可手改）。
// 天线引用链路预算卫星库条目（lbAntenna）时：频率 = 条目上行频率（星上接收），方向图 = 条目挂的 G/T 方向图（GRD 树天线），
// 没挂方向图按条目 G/T 反推高斯主瓣（G = G/T + 10·lg T_sys）。
// 主进程那一段有进度（preload 分段回报）、可取消（jobKey + cancelSatIntrusion）；结果属于开算时那颗星的那个挂点，途中换了就作废。
import { ref, computed, inject, watch, onMounted, onActivated, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import ChartBox from './ChartBox.vue'
import { mountAxesSeries, intrusionSamples, sunOffAxisSeries } from '../analysisCore.js'
import { hpbwOf, freqOf, lbAntennaInfo, hpbwFromGt } from '../mountLogic.js'
import { lbLibrarySats } from '../satSources.js'
import { fmtNum } from '../wbLogic.js'
import { fmtTimeFull } from '../../viz/models/timelineChart.js'

const sat = inject('sat')
const ana = inject('ana')
const S = sat.st
const mnt = sat.selMount
const api = typeof window !== 'undefined' ? window.api : null
const can = computed(() => !!(api && api.sunOutage && typeof api.sunOutage.satIntrusion === 'function'))
const JOB = 'modelwb-sun'
// 链路预算卫星库（天线引用 lbAntenna 的频率 / G/T / 方向图从这里取）
const lbList = ref([])
async function loadLb() { try { lbList.value = await lbLibrarySats() } catch { lbList.value = [] } }
onMounted(loadLb)
onActivated(loadLb)
onBeforeUnmount(() => { if (ctrl) { ctrl.abort(); cancelMain() } })

// 输入（留空 = 按挂点）：频率、−3 dB 全宽、T_sys、太阳亮温模型
const freq = ref(null), hpbw = ref(null), tsys = ref(null)
const model = ref('norp')
watch(() => S.mountSel, () => { freq.value = null; hpbw.value = null; tsys.value = null; res.value = null })
const aRef = computed(() => (mnt.value ? mnt.value.antennaRef : null))
const lbInfo = computed(() => {
  const r = aRef.value
  if (!r || r.kind !== 'lbAntenna') return null
  const e = lbList.value.find((x) => `${x.ns}:${x.id}` === r.id)
  return e ? lbAntennaInfo(e) : null
})
const tsysDef = computed(() => (mnt.value && Number.isFinite(mnt.value.sysTempK) ? mnt.value.sysTempK : 500))
const freqDef = computed(() => (mnt.value ? (freqOf(aRef.value) || (lbInfo.value && lbInfo.value.freqGHz) || null) : null))
const hpbwDef = computed(() => {
  if (!mnt.value) return null
  const h = hpbwOf(aRef.value, freq.value || freqDef.value)
  if (h) return h
  return lbInfo.value ? hpbwFromGt(lbInfo.value.gtDbK, tsys.value || tsysDef.value) : null
})
const grdKey = computed(() => {
  const r = aRef.value
  if (r && r.kind === 'grd') return r.id
  return lbInfo.value && lbInfo.value.grdKey ? lbInfo.value.grdKey : ''
})

const busy = ref(false), prog = ref(''), err = ref('')
const res = ref(null)
// 最坏时刻：整段 ΔT 都是 0（主瓣碰不到太阳）时没有「最坏」可言，不报时刻
const worstT = computed(() => { const r = res.value; return r && Number.isFinite(r.worst.tMs) && r.worst.dT > 0 ? r.worst.tMs : null })
let ctrl = null
async function compute() {
  const m = mnt.value
  if (!m || !can.value) return
  const f = freq.value || freqDef.value
  if (!(f > 0)) { err.value = '缺频率。'; return }
  const th = hpbw.value || hpbwDef.value
  if (!grdKey.value && !(th > 0)) { err.value = '缺方向图宽度。'; return }
  if (ctrl) ctrl.abort()
  ctrl = new AbortController()
  const signal = ctrl.signal
  busy.value = true; err.value = ''; prog.value = ''
  const t0 = performance.now()
  const sk = S.satKey, mid = m.id
  const live = () => !signal.aborted && S.satKey === sk && S.mountSel === mid
  const pk = grdKey.value
  try {
    const { tMs, st, B } = await ana.series({ signal, onProgress: (s, d, n) => { if (live()) prog.value = `${Math.round((d / n) * 100)}%` } })
    if (!live()) return
    const axes = mountAxesSeries(B, m)
    const { samples, idx } = intrusionSamples(tMs, st, axes)
    if (!idx.length) throw new Error('时段内取不到星位。')
    prog.value = '…'
    const pattern = pk ? { kind: 'grd', key: pk, thetaB3dB: th || undefined, thetaB3dBDeg: th || undefined } : { kind: 'gauss', thetaB3dB: th, thetaB3dBDeg: th }
    // 主进程这一段：同 jobKey 的新请求顶掉旧的；进度按 preload 分段（26 万拍一段）回报；取消 = cancelSatIntrusion(JOB)，
    // 在等的这一边同时跟 signal 赛跑，点「取消」立即放手（主进程在下一个时间片退出，回 {canceled:true}）
    const call = api.sunOutage.satIntrusion({
      samples, freqGHz: f, pattern, sysTempK: tsys.value || tsysDef.value, solarModel: model.value, jobKey: JOB,
      onProgress: (d, n) => { if (live() && n > 0) prog.value = `… ${Math.round((d / n) * 100)}%` }
    })
    const r = await new Promise((res2, rej) => {
      const on = () => rej(Object.assign(new Error('已取消'), { name: 'AbortError' }))
      if (signal.aborted) { on(); return }
      signal.addEventListener('abort', on, { once: true })
      call.then((v) => { signal.removeEventListener('abort', on); res2(v) }, (e) => { signal.removeEventListener('abort', on); rej(e) })
    })
    if (!live() || (r && (r.canceled || r.code === 'canceled'))) return
    if (!r || r.ok === false || !r.dT) throw new Error((r && (r.error || r.message)) || '主进程没有返回结果。')
    const N = tMs.length
    const dT = new Float64Array(N).fill(NaN), gl = new Float64Array(N).fill(NaN)
    for (let k = 0; k < idx.length; k++) { dT[idx[k]] = r.dT[k]; gl[idx[k]] = r.gtLossDb[k] }
    const off = sunOffAxisSeries(B, axes)
    let minOff = Infinity, minOffT = null
    for (let i = 0; i < N; i++) if (off[i] < minOff) { minOff = off[i]; minOffT = tMs[i] }
    const w = r.worst || {}
    res.value = Object.freeze({ tMs, dT, gl, off, minOff, minOffT, worst: { dT: w.dT, gtLossDb: w.gtLossDb, tMs: w.tMs }, freq: f, th, tsys: tsys.value || tsysDef.value, grd: !!pk, ms: Math.round(performance.now() - t0) })
  } catch (e) {
    if (e && e.name !== 'AbortError' && live()) err.value = (e && e.message) || String(e)
  } finally {
    if (ctrl && ctrl.signal === signal) { busy.value = false; prog.value = ''; ctrl = null }
  }
}
function cancelMain() { try { if (api && api.sunOutage && typeof api.sunOutage.cancelSatIntrusion === 'function') api.sunOutage.cancelSatIntrusion(JOB) } catch { /* 通道没有：等它自己回来 */ } }
function cancel() { if (ctrl) { ctrl.abort(); cancelMain() } }
// 换星 / 换挂点：结果清掉，在算的那一次作废（主进程那一段一并叫停）
watch(() => [S.satKey, S.mountSel], () => { res.value = null; err.value = ''; expMsg.value = ''; if (ctrl) { ctrl.abort(); cancelMain() } })

const chartData = computed(() => {
  const r = res.value
  if (!r) return null
  const marks = worstT.value != null ? [{ t: worstT.value, label: fmtNum(r.worst.gtLossDb, 3) + ' dB' }] : []
  return {
    t0: r.tMs[0], t1: r.tMs[r.tMs.length - 1], t: r.tMs, marks,
    panels: [
      { title: 'ΔT (K)', unit: 'K', dec: 2, zero: true, series: [{ name: 'ΔT', y: r.dT, slot: 0 }] },
      { title: 'ΔG/T (dB)', unit: 'dB', dec: 3, zero: true, series: [{ name: 'ΔG/T', y: r.gl, slot: 1 }] },
      { title: '太阳偏轴 (°)', unit: '°', dec: 1, zero: true, series: [{ name: '偏轴', y: r.off, slot: 2 }], weight: 0.8 }
    ]
  }
})
const copied = ref(false)
watch(res, () => { copied.value = false })   // 结果换了（重算 / 换挂点 / 换星），「已复制」说的是上一份
async function copyWorst() {
  const r = res.value
  if (!r || !Number.isFinite(r.worst.gtLossDb)) return
  const text = String(+r.worst.gtLossDb.toFixed(3))
  let ok = false
  try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); ok = true } } catch { ok = false }
  if (!ok) {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove() } catch { ok = false }
  }
  copied.value = ok
  if (ok) setTimeout(() => { copied.value = false }, 4000)
}
const chartRef = ref(null)
const expMsg = ref('')
async function exportPng() {
  if (!chartRef.value || !res.value) return
  const blob = await chartRef.value.exportPng({ scale: 4, title: `${S.label} · ${mnt.value ? mnt.value.name : ''} · 星侧太阳侵入` })
  const x = await ana.exportBlob(ana.fileStem('太阳侵入'), blob, 'png', 'PNG')
  expMsg.value = x && x.ok ? '已导出。' : ''
}
async function exportXlsx() {
  const r = res.value
  if (!r) return
  const tz = ana.win.tz
  const rows = []
  for (let i = 0; i < r.tMs.length; i++) rows.push({ t: fmtTimeFull(r.tMs[i], tz), off: Number.isFinite(r.off[i]) ? +r.off[i].toFixed(4) : null, dT: Number.isFinite(r.dT[i]) ? +r.dT[i].toFixed(4) : null, gl: Number.isFinite(r.gl[i]) ? +r.gl[i].toFixed(5) : null })
  const x = await ana.exportTable({ sheets: [{ name: '太阳侵入', cols: [{ key: 't', label: '时刻' }, { key: 'off', label: '太阳偏轴', unit: '°', num: true }, { key: 'dT', label: 'ΔT', unit: 'K', num: true }, { key: 'gl', label: 'ΔG/T', unit: 'dB', num: true }], rows }], defaultName: ana.fileStem('太阳侵入') + '.xlsx', title: `${S.label} · ${mnt.value ? mnt.value.name : ''}` })
  expMsg.value = x && x.ok ? '已导出。' : ''
}
const canXlsx = computed(() => !!(api && api.models && typeof api.models.exportTable === 'function'))
const f = (v, k = 4) => (v == null || !Number.isFinite(v) ? '—' : fmtNum(v, k))
</script>

<template>
  <MdSec id="a-sun" title="星侧太阳侵入" :summary="res ? f(res.worst.gtLossDb) + ' dB' : ''" tip="ΔG/T = 10·lg(1 + ΔT / T_sys)；ΔT = 太阳亮温 × 方向图在日面上的平均耦合 × 未被地球挡住的日面比例（日凌核同一套物理，主进程计算）">
    <template #actions>
      <button class="lb-mini" :disabled="!res || !canXlsx" :title="canXlsx ? '导出 XLSX' : '需在桌面客户端中运行'" @click="exportXlsx"><Icon name="table" :size="12" />XLSX</button>
      <button class="lb-mini" :disabled="!res" title="导出 PNG" @click="exportPng"><Icon name="image" :size="12" />PNG</button>
    </template>
    <div class="srow">
      <label title="星上接收频率（GHz）；留空 = 挂点参数化口径里的频率，或所引链路预算卫星库条目的上行频率">频率</label>
      <NumIn :model-value="freq" :min="0.01" :max="1000" :sig="6" allow-empty :placeholder="freqDef ? String(freqDef) : ''" @commit="(v) => { freq = v }" />
      <span class="u">GHz</span>
    </div>
    <div class="srow">
      <label :title="grdKey ? '方向图取 GRD 天线（' + grdKey + '）；取不到的方向退回这个宽度的高斯主瓣' : '高斯主瓣 −3 dB 全宽；留空 = 按挂点口径推（hpbw → 70λ/D → 增益反推；链路预算卫星库条目按 G = G/T + 10·lg T_sys 反推）'">−3 dB 宽</label>
      <NumIn :model-value="hpbw" :min="0.01" :max="180" :sig="5" allow-empty :placeholder="hpbwDef ? String(+hpbwDef.toPrecision(4)) : ''" @commit="(v) => { hpbw = v }" />
      <span class="u">°</span>
    </div>
    <div class="srow">
      <label title="星上接收系统噪声温度；留空 = 挂点的 T_sys（缺省 500 K）">T_sys</label>
      <NumIn :model-value="tsys" :min="1" :max="1e6" :sig="6" allow-empty :placeholder="String(tsysDef)" @commit="(v) => { tsys = v }" />
      <span class="u">K</span>
      <select v-model="model" class="ci as-mdl" title="太阳亮温模型：NoRP 回归谱（缺省，按当日 F10.7）/ 旧版公式">
        <option value="norp">NoRP</option>
        <option value="legacy">旧版</option>
      </select>
    </div>
    <div class="md-acts">
      <button class="lb-mini primary" :disabled="!mnt || busy || !can || ana.tooMany.value" :title="can ? '' : '需在桌面客户端中运行'" @click="compute"><Icon name="calculator" :size="13" />计算</button>
      <button v-if="busy" class="lb-mini" title="取消" @click="cancel"><Icon name="x" :size="13" />取消</button>
      <span v-if="busy" class="md-state"><span class="as-spin"></span><span data-i18n-skip>{{ prog }}</span></span>
      <span class="sp"></span>
      <button class="lb-mini" :disabled="!res || !Number.isFinite(res.worst.gtLossDb)" title="把最坏 ΔG/T（dB，3 位小数）复制到剪贴板：粘进链路预算表的「太阳侵入 ΔG/T」列" @click="copyWorst"><Icon name="clipboard" :size="13" />复制最坏 ΔG/T</button>
    </div>
    <div v-if="copied" class="md-state ok">已复制</div>
    <div v-if="err" class="md-state bad" data-i18n-skip>{{ err }}</div>
    <template v-if="res">
      <div class="md-kvs">
        <div class="md-kv" :title="'最坏时刻 ' + (worstT != null ? fmtTimeFull(worstT, ana.win.tz) : '—')"><span class="k">最坏 ΔG/T</span><span class="v" data-i18n-skip>{{ f(res.worst.gtLossDb) }}</span><span class="u">dB</span></div>
        <div class="md-kv"><span class="k">最坏 ΔT</span><span class="v" data-i18n-skip>{{ f(res.worst.dT) }}</span><span class="u">K</span></div>
        <div class="md-kv as-t"><span class="k">最坏时刻</span><span class="v" data-i18n-skip>{{ worstT != null ? fmtTimeFull(worstT, ana.win.tz) : '—' }}</span></div>
        <div class="md-kv" :title="'太阳离视轴最近的时刻 ' + (res.minOffT ? fmtTimeFull(res.minOffT, ana.win.tz) : '—') + '（地心太阳方向）'"><span class="k">最小偏轴</span><span class="v" data-i18n-skip>{{ f(res.minOff) }}</span><span class="u">°</span></div>
        <div class="md-kv"><span class="k">耗时</span><span class="v" data-i18n-skip>{{ res.ms }}</span><span class="u">ms</span></div>
      </div>
      <ChartBox ref="chartRef" kind="timeline" :data="chartData" :tz="ana.win.tz" :panel-height="84" />
    </template>
    <div v-if="expMsg" class="md-state ok">{{ expMsg }}</div>
  </MdSec>
</template>

<style scoped>
.as-mdl { flex: 0 1 80px; min-width: 0 !important; }
.as-t { grid-column: span 2; }
.as-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: as-spin .7s linear infinite; }
@keyframes as-spin { to { transform: rotate(360deg); } }
.srow :deep(.md-num) { flex: 1 1 60px; }
</style>
