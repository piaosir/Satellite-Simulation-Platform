<script setup>
// 分析 › 太阳翼功率（任务书 §6.7、power.mjs）：模型的太阳翼部件（role = solarArray，法向 / 面积 / 所属太阳翼组的效率；带单轴对日关节的
// 按 pointingVector 绕转轴对日并夹限位）× 逐拍太阳方向（本体系，姿态律）× 地影因子（eclipseFactor，D13）× 日地距离。
// W = S₀·(1 AU / R)²·A·η·cos⁺θ·e（S₀ = 1361 W/m²）；相对值 = 纯几何 + 地影（满额 1）。只出数字与曲线；地影期是图上的灰带。
// 曲线：一组太阳翼画那一组；两组画合计 + 两组（图表只有三档线型，三条正好分得开）；三组及以上只画合计（线型不够分，
// 各组的时段平均在读数里、逐拍在 XLSX 里）。结果属于开算时那颗星 / 那个模型：算的途中换了就作废。
import { ref, computed, inject, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import ChartBox from './ChartBox.vue'
import { segmentsOf } from '../analysisCore.js'
import { runHeavy } from '../anaHeavy.js'
import { panelsFromMeta } from '@core/models/power.mjs'
import { fmtNum } from '../wbLogic.js'
import { fmtTimeFull } from '../../viz/models/timelineChart.js'

const wb = inject('wb')
const sat = inject('sat')
const ana = inject('ana')
const S = sat.st
const { cur } = wb

const pm = computed(() => { void cur.rev; return cur.meta ? panelsFromMeta(JSON.parse(JSON.stringify(cur.meta))) : { panels: [], warnings: [] } })
const busy = ref(false), prog = ref(''), err = ref('')
const res = ref(null)
let ctrl = null
async function compute() {
  if (!pm.value.panels.length) return
  if (ctrl) ctrl.abort()
  ctrl = new AbortController()
  busy.value = true; err.value = ''; prog.value = ''
  const t0 = performance.now()
  const signal = ctrl.signal
  const sk = S.satKey, cid = cur.id
  const live = () => !signal.aborted && S.satKey === sk && cur.id === cid
  try {
    const panels = JSON.parse(JSON.stringify(pm.value.panels))
    const { tMs, st, B } = await ana.series({ signal, onProgress: (s, d, n) => { if (live()) prog.value = `${Math.round((d / n) * 100)}%` } })
    if (!live()) return
    prog.value = '…'
    const { p, eclipse } = await runHeavy('power', { panels, tMs, st: { r: st.r, ok: st.ok }, B: { X: B.X, Y: B.Y, Z: B.Z, sun: B.sun, ok: B.ok } }, { signal })
    if (!live()) return
    res.value = Object.freeze({ tMs, p, eclipse, ms: Math.round(performance.now() - t0), model: cid })
  } catch (e) {
    if (e && e.name !== 'AbortError' && live()) err.value = (e && e.message) || String(e)
  } finally {
    if (ctrl && ctrl.signal === signal) { busy.value = false; prog.value = ''; ctrl = null }
  }
}
function cancel() { if (ctrl) ctrl.abort() }
// 换星 / 换模型：结果清掉，在算的那一次作废
watch(() => [S.satKey, cur.id], () => { res.value = null; err.value = ''; expMsg.value = ''; if (ctrl) ctrl.abort() })

const chartData = computed(() => {
  const r = res.value
  if (!r) return null
  const g = r.p.groups
  // 1 组：只画它；2 组：合计（slot 0）+ 两组（slot 1、2）；≥ 3 组：只画合计（三档线型分不开四条以上）
  const each = g.length === 1 ? [{ x: g[0], slot: 0 }] : (g.length === 2 ? g.map((x, i) => ({ x, slot: i + 1 })) : [])
  const series = each.map(({ x, slot }) => ({ name: x.name, y: x.W, slot }))
  const rel = each.map(({ x, slot }) => ({ name: x.name, y: x.rel, slot }))
  if (g.length > 1) { series.unshift({ name: '合计', y: r.p.W, slot: 0 }); rel.unshift({ name: '合计', y: r.p.rel, slot: 0 }) }
  const bands = segmentsOf(r.tMs, (i) => Number.isFinite(r.eclipse[i]) && r.eclipse[i] < 1).map((x) => ({ ...x, kind: 'eclipse' }))
  return {
    t0: r.tMs[0], t1: r.tMs[r.tMs.length - 1], t: r.tMs, bands,
    panels: [
      { title: '功率 (W)', unit: 'W', dec: 1, zero: true, series, weight: 1.3 },
      { title: '相对值', unit: '', dec: 3, yMin: 0, yMax: 1, series: rel }
    ]
  }
})
const chartRef = ref(null)
const expMsg = ref('')
async function exportPng() {
  if (!chartRef.value || !res.value) return
  const blob = await chartRef.value.exportPng({ scale: 4, title: `${S.label} · 太阳翼功率` })
  const x = await ana.exportBlob(`${S.label || 'sat'}_太阳翼功率`, blob, 'png', 'PNG')
  expMsg.value = x && x.ok ? '已导出。' : ''
}
async function exportXlsx() {
  const r = res.value
  if (!r) return
  const tz = ana.win.tz, g = r.p.groups
  const rows = []
  for (let i = 0; i < r.tMs.length; i++) {
    const row = { t: fmtTimeFull(r.tMs[i], tz), W: +r.p.W[i].toFixed(3), rel: +r.p.rel[i].toFixed(5), e: Number.isFinite(r.eclipse[i]) ? +r.eclipse[i].toFixed(5) : null }
    g.forEach((x, k) => { row['g' + k] = +x.W[i].toFixed(3) })
    rows.push(row)
  }
  const cols = [{ key: 't', label: '时刻' }, { key: 'W', label: '合计功率', unit: 'W', num: true }, ...g.map((x, k) => ({ key: 'g' + k, label: x.name, unit: 'W', num: true })), { key: 'rel', label: '相对值', num: true }, { key: 'e', label: '光照因子', num: true }]
  const daily = r.p.daily.map((d) => ({ d: fmtTimeFull(d.dayStartMs, 'utc').slice(0, 10), mean: d.meanW == null ? null : +d.meanW.toFixed(2), min: +d.minW.toFixed(2), max: +d.maxW.toFixed(2), cov: +(d.coverage * 100).toFixed(2) }))
  const x = await ana.exportTable({
    sheets: [
      { name: '功率', cols, rows },
      { name: '日均', cols: [{ key: 'd', label: '日期（UTC）' }, { key: 'mean', label: '日均', unit: 'W', num: true }, { key: 'min', label: '最小', unit: 'W', num: true }, { key: 'max', label: '最大', unit: 'W', num: true }, { key: 'cov', label: '样本覆盖', unit: '%', num: true }], rows: daily }
    ],
    defaultName: `${S.label || 'sat'}_太阳翼功率.xlsx`, title: `${S.label} · 太阳翼功率`
  })
  expMsg.value = x && x.ok ? '已导出。' : ''
}
const canXlsx = computed(() => !!(ana.api && ana.api.models && typeof ana.api.models.exportTable === 'function'))
const f = (v, k = 5) => (v == null || !Number.isFinite(v) ? '—' : fmtNum(v, k))
</script>

<template>
  <MdSec id="a-power" title="太阳翼功率" :summary="res ? f(res.p.meanW) + ' W' : ''" tip="W = S₀·(1 AU / R)²·A·η·cos⁺θ·e，S₀ = 1361 W/m²（IAU 2015 B3）；相对值 = Σ Aη·cos⁺θ·e / Σ Aη；地影 = 圆锥 + 半影（eclipseFactor）；不计温度系数、老化、本体遮挡">
    <template #actions>
      <button class="lb-mini" :disabled="!res || !canXlsx" :title="canXlsx ? '导出 XLSX（逐拍 + 日均）' : '需在桌面客户端中运行'" @click="exportXlsx"><Icon name="table" :size="12" />XLSX</button>
      <button class="lb-mini" :disabled="!res" title="导出 PNG" @click="exportPng"><Icon name="image" :size="12" />PNG</button>
    </template>
    <div v-if="!cur.meta" class="lb-placeholder an-l">未载入模型。</div>
    <div v-else-if="!pm.panels.length" class="lb-placeholder an-l" :title="pm.warnings.join('\n')">没有太阳翼部件。</div>
    <template v-else>
      <div class="md-kvs">
        <div class="md-kv" :title="pm.panels.map((p) => p.name + '：' + f(p.areaM2, 4) + ' m² · ' + p.efficiencyPct + ' %' + (p.articulation ? ' · 对日 ' + p.articulation.name : '')).join('\n')"><span class="k">电池板</span><span class="v" data-i18n-skip>{{ pm.panels.length }}</span></div>
        <div class="md-kv"><span class="k">电池面积</span><span class="v" data-i18n-skip>{{ f(pm.panels.reduce((s, p) => s + (p.areaM2 || 0), 0), 5) }}</span><span class="u">m²</span></div>
      </div>
      <div class="md-acts">
        <button class="lb-mini primary" :disabled="busy || !S.binding || ana.tooMany.value" title="按时段逐拍算（姿态律 × 太阳 × 地影）" @click="compute"><Icon name="calculator" :size="13" />计算</button>
        <button v-if="busy" class="lb-mini" title="取消" @click="cancel"><Icon name="x" :size="13" />取消</button>
        <span v-if="busy" class="md-state"><span class="ap-spin"></span><span data-i18n-skip>{{ prog }}</span></span>
      </div>
      <div v-if="err" class="md-state bad" data-i18n-skip>{{ err }}</div>
      <template v-if="res">
        <div class="md-kvs">
          <div class="md-kv" title="时段内按时间加权的平均功率（整个时段，不是逐日；逐日平均见 XLSX「日均」表）"><span class="k">平均</span><span class="v" data-i18n-skip>{{ f(res.p.meanW) }}</span><span class="u">W</span></div>
          <div class="md-kv"><span class="k">最小</span><span class="v" data-i18n-skip>{{ f(res.p.minW) }}</span><span class="u">W</span></div>
          <div class="md-kv"><span class="k">最大</span><span class="v" data-i18n-skip>{{ f(res.p.maxW) }}</span><span class="u">W</span></div>
          <div class="md-kv" title="Σ S₀·A·η（1 AU 正入射、全日照）"><span class="k">满额</span><span class="v" data-i18n-skip>{{ f(res.p.nominalW) }}</span><span class="u">W</span></div>
          <div class="md-kv" title="时段内按时间加权的平均相对值"><span class="k">平均相对值</span><span class="v" data-i18n-skip>{{ f(res.p.meanRel, 4) }}</span></div>
          <div class="md-kv" title="全日照时长占比（本影与半影之外）"><span class="k">受照</span><span class="v" data-i18n-skip>{{ f(res.p.sunlitFrac * 100, 4) }}</span><span class="u">%</span></div>
          <div class="md-kv" title="本影 + 半影时长"><span class="k">地影</span><span class="v" data-i18n-skip>{{ f((res.p.eclipseSec + res.p.penumbraSec) / 60, 4) }}</span><span class="u">min</span></div>
          <div v-for="g in res.p.groups" :key="g.name" class="md-kv" :title="g.name + '：时段平均'"><span class="k" data-i18n-skip>{{ g.name }}</span><span class="v" data-i18n-skip>{{ f(g.meanW) }}</span><span class="u">W</span></div>
        </div>
        <ChartBox ref="chartRef" kind="timeline" :data="chartData" :tz="ana.win.tz" :panel-height="96" />
      </template>
    </template>
    <div v-if="expMsg" class="md-state ok">{{ expMsg }}</div>
  </MdSec>
</template>

<style scoped>
.an-l { text-align: left; padding: 2px 0; }
.ap-spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: ap-spin .7s linear infinite; }
@keyframes ap-spin { to { transform: rotate(360deg); } }
</style>
