<script setup>
// 分析 › 万向节可达（任务书 §6.5、DESIGN2 §1 gimbal.mjs）：目标（地球站 / 另一颗星）→ 逐拍视线（地球挡住的拍记「无目标」）→
// 本体系（姿态律）→ 挂点系 → 两轴解算 + 限位 + 角速率上限（gimbal.trackSeries）。掩模（本页算过 / 读回来的）勾上时，落进掩模的拍记遮挡。
// 固定天线（无万向节）按视场判可跟踪：视场 = 挂点视场 → 方向图 −3 dB 全宽（表格「视场」列留空的口径、预览里画的锥同一个）→ 全向 360°（fovFullOf）。
// 读数：可跟踪时间比例（分母 = 有目标的时长）、最长中断、角速率峰值（需要的速率）、三类不可跟踪（超限 / 遮挡 / 追不上）拍数。
// 结果属于开算时那颗星的那个挂点：算的途中换星 / 换挂点，这一次作废（不把 A 星的数挂到 B 星名下）。
// 图：两轴角度与角速率两格 + 状态条（可跟踪实底绿 / 超限斜纹红 / 遮挡实底红 / 追不上斜纹红）+ 不可跟踪灰带。XLSX 走主进程 exceljs 三线表。
import { ref, computed, inject, watch, toRaw } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import ChartBox from './ChartBox.vue'
import CityPicker from '../../components/CityPicker.vue'
import SatKeyPicker from '../sat/SatKeyPicker.vue'
import { stationTarget, sampleStates, gimbalStrip, segmentsOf } from '../analysisCore.js'
import { runHeavy } from '../anaHeavy.js'
import { resolveOrbit, stateFn } from '../satSources.js'
import { REASON } from '@core/models/gimbal.mjs'
import { GIMBAL_LABEL, fovFullOf } from '../mountLogic.js'
import { fmtNum } from '../wbLogic.js'
import { fmtTimeFull } from '../../viz/models/timelineChart.js'

const sat = inject('sat')
const ana = inject('ana')
const S = sat.st
const mnt = sat.selMount
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

// ── 目标 ──
const tk = ref(lsGet('model/gbKind', 'station') === 'sat' ? 'sat' : 'station')
const stn = ref((() => { try { const s = JSON.parse(lsGet('model/gbStation', 'null')); if (s && Number.isFinite(s.latDeg)) return s } catch { /* 无 */ } return { latDeg: 39.9, lonDeg: 116.4, altM: 0, name: '北京', elMinDeg: 5 } })())
watch(stn, (v) => lsSet('model/gbStation', JSON.stringify(v)), { deep: true })
watch(tk, (v) => lsSet('model/gbKind', v))
const tgtSat = ref(lsGet('model/gbSat', '')), tgtSatLabel = ref(lsGet('model/gbSatLabel', ''))
function onTgtSat(o) { tgtSat.value = o.satKey; tgtSatLabel.value = o.label; lsSet('model/gbSat', o.satKey); lsSet('model/gbSatLabel', o.label) }
const cityOpen = ref(false)
function onCity(items) { const c = items && items[0]; if (c) stn.value = { ...stn.value, latDeg: Number(c.lat), lonDeg: Number(c.lon), name: String(c.name || '') }; cityOpen.value = false }
const setStn = (k, v) => { stn.value = { ...stn.value, [k]: v == null ? 0 : v, ...(k === 'latDeg' || k === 'lonDeg' ? { name: '' } : {}) } }
const tolDeg = ref(0.1)
const useMask = ref(true)
const maskRec = computed(() => { void S.maskRev; void S.rev; return mnt.value ? sat.maskOf(mnt.value.id) : null })

// ── 计算 ──
const busy = ref(false), prog = ref(''), err = ref('')
const res = ref(null)
let ctrl = null
async function compute() {
  const m = mnt.value
  if (!m) return
  if (ctrl) ctrl.abort()
  ctrl = new AbortController()
  const signal = ctrl.signal
  busy.value = true; err.value = ''; prog.value = ''
  const t0 = performance.now()
  const sk = S.satKey, mid = m.id
  const live = () => !signal.aborted && S.satKey === sk && S.mountSel === mid
  try {
    const onProgress = (stage, d, n) => { if (live()) prog.value = `${Math.round((d / n) * 100)}%` }
    const { tMs, st, B } = await ana.series({ signal, onProgress })
    let target
    if (tk.value === 'station') target = stationTarget(stn.value)
    else {
      if (!tgtSat.value) throw new Error('未选目标星。')
      const orb = await resolveOrbit(tgtSat.value)
      if (!orb) throw new Error('找不到目标星的轨道。')
      const s2 = await sampleStates(stateFn(orb), tMs, { signal, onProgress })
      target = { kind: 'sat', r: s2.r, ok: s2.ok }
    }
    if (!live()) return
    const mk = useMask.value && maskRec.value ? maskRec.value.mask : null
    const fovDeg = fovFullOf(m)
    prog.value = '…'
    const { ls, tr } = await runHeavy('gimbal', {
      tMs, st: { r: st.r, ok: st.ok }, B: { X: B.X, Y: B.Y, Z: B.Z, ok: B.ok }, target, mount: JSON.parse(JSON.stringify(m)),
      mask: mk ? toRaw(mk) : null, tolDeg: tolDeg.value, fovDeg: fovDeg || undefined
    }, { signal })
    if (!live()) return
    res.value = Object.freeze({ tMs, tr, ls, mountId: m.id, gimbal: (m.gimbal && m.gimbal.type) || 'none', fovDeg, masked: !!mk, ms: Math.round(performance.now() - t0), target: tk.value === 'station' ? (stn.value.name || `${stn.value.latDeg}, ${stn.value.lonDeg}`) : (tgtSatLabel.value || tgtSat.value) })
  } catch (e) {
    if (e && e.name !== 'AbortError' && live()) err.value = (e && e.message) || String(e)
  } finally {
    if (ctrl && ctrl.signal === signal) { busy.value = false; prog.value = ''; ctrl = null }
  }
}
function cancel() { if (ctrl) ctrl.abort() }
// 换星 / 换挂点：结果清掉，在算的那一次作废
watch(() => [S.satKey, S.mountSel], () => { res.value = null; err.value = ''; expMsg.value = ''; if (ctrl) ctrl.abort() })

// ── 读数 ──
const R = computed(() => {
  const r = res.value
  if (!r) return null
  const t = r.tr
  const dur = t.durationsSec
  return {
    frac: t.trackableFrac, longest: t.longestOutageMin, peak: t.peakRateDegS,
    nLimit: t.counts.limit, nMask: t.counts.mask, nRate: t.counts.rate, nNo: t.counts.noTarget, nOk: t.counts.ok,
    minLimit: dur.limit / 60, minMask: dur.mask / 60, minRate: dur.rate / 60, validMin: dur.valid / 60
  }
})
const fixed = computed(() => res.value && res.value.gimbal === 'none')
const chartData = computed(() => {
  const r = res.value
  if (!r) return null
  const t = r.tr, s = t.series
  const ax = fixed.value ? ['偏轴', ''] : (r.gimbal === 'xy' ? ['X', 'Y'] : ['方位', '俯仰'])
  const panels = []
  if (fixed.value) panels.push({ title: '偏离视轴 (°)', unit: '°', dec: 2, zero: true, series: [{ name: '偏轴', y: s.errDeg, slot: 0 }] })
  else {
    panels.push({ title: '指令角 (°)', unit: '°', dec: 2, angle: true, series: [{ name: ax[0], y: s.a1, slot: 0, wrap: 360 }, { name: ax[1], y: s.a2, slot: 1 }] })
    panels.push({ title: '角速率 (°/s)', unit: '°/s', dec: 3, zero: true, series: [{ name: ax[0], y: s.rate1.map(Math.abs), slot: 0 }, { name: ax[1], y: s.rate2.map(Math.abs), slot: 1 }] })
  }
  const bands = segmentsOf(r.tMs, (i) => s.reason[i] !== REASON.OK && s.reason[i] !== REASON.NO_TARGET).map((x) => ({ ...x, kind: 'limit' }))
  return { t0: r.tMs[0], t1: r.tMs[r.tMs.length - 1], t: r.tMs, panels, bands, strips: [{ label: '', segs: gimbalStrip(r.tMs, s.reason) }] }
})

// ── 导出 XLSX ──
const expMsg = ref('')
const REASON_TEXT = { [REASON.OK]: '可跟踪', [REASON.LIMIT]: '超限', [REASON.MASK]: '遮挡', [REASON.RATE]: '追不上', [REASON.NO_TARGET]: '无目标' }
async function exportXlsx() {
  const r = res.value
  if (!r) return
  const s = r.tr.series, tz = ana.win.tz
  const rows = []
  for (let i = 0; i < r.tMs.length; i++) {
    const n = (v, k = 4) => (Number.isFinite(v) ? +v.toFixed(k) : null)
    rows.push({ t: fmtTimeFull(r.tMs[i], tz), a1: n(s.a1[i]), a2: n(s.a2[i]), r1: n(s.rate1[i], 5), r2: n(s.rate2[i], 5), err: n(s.errDeg[i]), el: r.ls.elDeg ? n(r.ls.elDeg[i], 3) : null, range: n(r.ls.rangeKm[i], 3), state: REASON_TEXT[s.reason[i]] || '' })
  }
  const cols = [
    { key: 't', label: '时刻' },
    { key: 'a1', label: fixed.value ? 'a1' : (r.gimbal === 'xy' ? 'X' : '方位'), unit: '°', num: true },
    { key: 'a2', label: fixed.value ? 'a2' : (r.gimbal === 'xy' ? 'Y' : '俯仰'), unit: '°', num: true },
    { key: 'r1', label: '角速率 1', unit: '°/s', num: true },
    { key: 'r2', label: '角速率 2', unit: '°/s', num: true },
    { key: 'err', label: '指向误差', unit: '°', num: true },
    ...(r.ls.elDeg ? [{ key: 'el', label: '站心仰角', unit: '°', num: true }] : []),
    { key: 'range', label: '距离', unit: 'km', num: true },
    { key: 'state', label: '状态' }
  ]
  const x = await ana.exportTable({ sheets: [{ name: '万向节', cols, rows }], defaultName: ana.fileStem('万向节') + '.xlsx', title: `${S.label} · ${mnt.value ? mnt.value.name : ''} · ${r.target}` })
  expMsg.value = x && x.ok ? '已导出。' : (x && x.missing ? '' : (x && x.error) || '')
  expBad.value = !!(x && !x.ok && !x.canceled && !x.missing)
}
const expBad = ref(false)
const canXlsx = computed(() => !!(ana.api && ana.api.models && typeof ana.api.models.exportTable === 'function'))
const chartRef = ref(null)
async function exportPng() {
  if (!chartRef.value || !res.value) return
  const blob = await chartRef.value.exportPng({ scale: 4, title: `${S.label} · ${mnt.value ? mnt.value.name : ''} · ${res.value.target}` })
  const x = await ana.exportBlob(ana.fileStem('万向节'), blob, 'png', 'PNG')
  expMsg.value = x && x.ok ? '已导出。' : ''
}
const f = (v, k = 4) => (v == null || !Number.isFinite(v) ? '—' : fmtNum(v, k))
</script>

<template>
  <MdSec id="a-gimbal" title="万向节可达" :summary="R ? f(R.frac * 100, 4) + ' %' : ''" tip="挂点系：z = 视轴、y = up、x = y × z；az-el 的方位轴 = up，X-Y 的外轴绕挂点 x。可跟踪比例的分母 = 有目标（地球没挡住）的时长">
    <template #actions>
      <button class="lb-mini" :disabled="!res || !canXlsx" :title="canXlsx ? '导出 XLSX（三线表）' : '需在桌面客户端中运行'" @click="exportXlsx"><Icon name="table" :size="12" />XLSX</button>
      <button class="lb-mini" :disabled="!res" title="导出 PNG" @click="exportPng"><Icon name="image" :size="12" />PNG</button>
    </template>
    <div class="srow">
      <label>目标</label>
      <div class="lbu-seg ag-seg">
        <button :class="{ on: tk === 'station' }" @click="tk = 'station'">地球站</button>
        <button :class="{ on: tk === 'sat' }" @click="tk = 'sat'">卫星</button>
      </div>
    </div>
    <template v-if="tk === 'station'">
      <div class="srow">
        <label title="WGS-84 大地坐标（纬度 / 经度，°）">站址</label>
        <NumIn :model-value="stn.latDeg" :min="-90" :max="90" :sig="8" title="纬度（°，北正）" @commit="(v) => setStn('latDeg', v)" />
        <NumIn :model-value="stn.lonDeg" :min="-360" :max="360" :sig="8" title="经度（°，东正）" @commit="(v) => setStn('lonDeg', v)" />
        <button class="lb-mini lb-mini-ico" title="从城市库选" @click="cityOpen = true"><Icon name="map-pin" :size="13" /></button>
      </div>
      <div class="srow">
        <label title="站心仰角低于它的拍记「无目标」（地球 / 地形挡住）">最低仰角</label>
        <NumIn :model-value="stn.elMinDeg" :min="-5" :max="90" :sig="4" @commit="(v) => setStn('elMinDeg', v)" />
        <span class="u">°</span>
        <span v-if="stn.name" class="ag-name" data-i18n-skip>{{ stn.name }}</span>
      </div>
    </template>
    <div v-else class="srow">
      <label>目标星</label>
      <SatKeyPicker :model-value="tgtSat" :label="tgtSatLabel" @pick="onTgtSat" />
    </div>
    <div class="srow">
      <label title="实际指向与目标的夹角超过它记「追不上」（过 keyhole、重新捕获时的回转）">跟踪容差</label>
      <NumIn :model-value="tolDeg" :min="0.001" :max="10" :sig="4" @commit="(v) => { tolDeg = v || 0.1 }" />
      <span class="u">°</span>
      <label class="md-chkrow ag-chk" :class="{ dim: !maskRec }" title="视线落进本挂点的本体遮挡掩模的拍记「遮挡」（先在上面算掩模）"><input v-model="useMask" type="checkbox" :disabled="!maskRec" />查掩模</label>
    </div>
    <div class="md-acts">
      <button class="lb-mini primary" :disabled="!mnt || busy || ana.tooMany.value" :title="mnt ? GIMBAL_LABEL[(mnt.gimbal && mnt.gimbal.type) || 'none'] : ''" @click="compute"><Icon name="calculator" :size="13" />计算</button>
      <button v-if="busy" class="lb-mini" title="取消" @click="cancel"><Icon name="x" :size="13" />取消</button>
      <span v-if="busy" class="md-state"><span class="ag-spin"></span><span data-i18n-skip>{{ prog }}</span></span>
    </div>
    <div v-if="err" class="md-state bad" data-i18n-skip>{{ err }}</div>
    <template v-if="R">
      <div class="md-kvs">
        <div class="md-kv" title="可跟踪时长 / 有目标的时长"><span class="k">可跟踪</span><span class="v" data-i18n-skip>{{ f(R.frac * 100) }}</span><span class="u">%</span></div>
        <div class="md-kv" title="最长的连续不可跟踪（无目标的拍打断计时）"><span class="k">最长中断</span><span class="v" data-i18n-skip>{{ f(R.longest) }}</span><span class="u">min</span></div>
        <div class="md-kv" title="相邻两拍指令角之差 / 步长的最大值（需要的角速率；固定天线无）"><span class="k">角速率峰值</span><span class="v" data-i18n-skip>{{ f(R.peak) }}</span><span class="u">°/s</span></div>
        <div class="md-kv" :title="(fixed ? (res.fovDeg ? '目标在 ' + f(res.fovDeg, 4) + '° 视场外（固定天线）' : '目标偏离视轴超过跟踪容差（固定天线，视场未知）') : '限位内无解') + ' · ' + f(R.minLimit) + ' min'"><span class="k">超限</span><span class="v" data-i18n-skip>{{ R.nLimit }}</span><span class="u">拍</span></div>
        <div class="md-kv" :title="'视线落进本体遮挡掩模 · ' + f(R.minMask) + ' min'"><span class="k">遮挡</span><span class="v" data-i18n-skip>{{ R.nMask }}</span><span class="u">拍</span></div>
        <div class="md-kv" :title="'指向误差超过容差（角速率上限 / 过奇点）· ' + f(R.minRate) + ' min'"><span class="k">追不上</span><span class="v" data-i18n-skip>{{ R.nRate }}</span><span class="u">拍</span></div>
        <div class="md-kv" title="地球挡住 / 取不到星位的拍（不进分母）"><span class="k">无目标</span><span class="v" data-i18n-skip>{{ R.nNo }}</span><span class="u">拍</span></div>
        <div class="md-kv"><span class="k">耗时</span><span class="v" data-i18n-skip>{{ res.ms }}</span><span class="u">ms</span></div>
      </div>
      <ChartBox ref="chartRef" kind="timeline" :data="chartData" :tz="ana.win.tz" :panel-height="96" />
    </template>
    <div v-if="expMsg" class="md-state" :class="{ ok: !expBad, bad: expBad }" data-i18n-skip>{{ expMsg }}</div>
    <CityPicker v-if="cityOpen" single title="地球站" @add="onCity" @close="cityOpen = false" />
  </MdSec>
</template>

<style scoped>
.ag-seg { flex: 1 1 auto; display: flex; }
.ag-seg > button { flex: 1 1 auto; height: var(--h-ctl); }
.ag-chk { min-height: 0; margin-left: auto; }
.ag-name { font-size: var(--fs-2); color: var(--text-muted); }
.ag-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: ag-spin .7s linear infinite; }
@keyframes ag-spin { to { transform: rotate(360deg); } }
.srow :deep(.md-num) { flex: 1 1 60px; }
</style>
