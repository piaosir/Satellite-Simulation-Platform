<script setup>
// 单位：推断结果读数、比例（模型单位 → 米）、尺寸核定与出处；已知尺寸反算（翼展 / 长 / 高 / 口径 → scaleFromKnownDim，
// 缺省照用户给的尺寸算、不吸附——带出处的尺寸结果必须照它；最近的标准单位作为可选吸附给用户挑，W1 ④-4）。
// 改比例时本体系里贴在几何上的量（挂点、部件、质心惯量、原点偏移）一并按比例缩放（wbLogic.rescaleMeta）。
import { ref, computed, inject } from 'vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import { scaleFromKnownDim, UNIT_SCALE } from '@core/models/units.mjs'
import { isHttpUrl } from '@core/models/manifest.mjs'
import { rescaleMeta, fmtNum, bodyBoxOfMeta } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb
const m = computed(() => cur.meta)
const u = computed(() => (m.value && m.value.units) || {})
const ro = computed(() => !cur.editable)
const UNIT_LABEL = { m: '米', cm: '厘米', mm: '毫米', in: '英寸', ft: '英尺', unknown: '未知' }

function applyScale(s, unitGuess) {
  const old = u.value.scaleToMeters || 1
  if (!(s > 0) || s === old) return
  const k = s / old
  wb.edit((x) => {
    const n = rescaleMeta(JSON.parse(JSON.stringify(x)), k)
    for (const key of Object.keys(n)) x[key] = n[key]
    x.units = { ...(x.units || {}), scaleToMeters: s, unitGuess: unitGuess || nearestUnit(s) }
  }, { geom: true })
}
function nearestUnit(s) {
  for (const [k, v] of Object.entries(UNIT_SCALE)) if (Math.abs(s / v - 1) < 1e-9) return k
  return 'unknown'
}
function setVerified(on) {
  wb.edit((x) => { x.units = { ...(x.units || {}), sizeVerified: !!on && !!(x.units && x.units.sizeSource) } })
}
function setSource(v) {
  const s = String(v || '').trim()
  if (s === (u.value.sizeSource || '')) return
  wb.edit((x) => {
    const units = { ...(x.units || {}) }
    if (s) units.sizeSource = s; else { delete units.sizeSource; units.sizeVerified = false }
    x.units = units
  })
}

// ============ 已知尺寸反算 ============
const DIMS = [
  { key: 'span', label: '翼展', tip: '本体 Y 向总长（GEO 南北向，太阳翼展开方向）', axis: 1 },
  { key: 'len', label: '长', tip: '本体 X 向总长（速度方向）', axis: 0 },
  { key: 'height', label: '高', tip: '本体 Z 向总高（对地方向）', axis: 2 },
  { key: 'longest', label: '最长边', tip: '包围盒三边里最长的一条（翼展方向没摆到 ±Y 时用它）' },
  { key: 'aperture', label: '口径', tip: '部件里拟合出的最大反射面口径' }
]
const dim = ref('span')
const known = ref(null)
const res = ref(null)     // scaleFromKnownDim 的结果 + measured
function measuredMeters() {
  const d = DIMS.find((x) => x.key === dim.value)
  if (!d || !m.value) return null
  if (d.key === 'aperture') {
    let best = 0
    for (const p of m.value.parts || []) if (p && p.fitted && p.fitted.diameterM > best) best = p.fitted.diameterM
    return best || null
  }
  const vp = getVp()
  const b = vp ? vp.bounds.bboxBody : bodyBoxOfMeta(m.value)
  if (!b) return null
  const e = d.key === 'longest' ? Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k])) : b.max[d.axis] - b.min[d.axis]
  return e > 0 ? e : null
}
const measuredNow = computed(() => { void cur.geomRev; void cur.rev; void dim.value; return measuredMeters() })
function solve() {
  res.value = null
  const mm = measuredMeters()
  if (!(mm > 0) || !(known.value > 0)) return
  const s0 = u.value.scaleToMeters || 1
  const r = scaleFromKnownDim({ measuredModelUnits: mm / s0, knownMeters: known.value })
  res.value = r.ok ? { ...r, measured: mm / s0 } : { ok: false, error: r.error }
}
const srcBad = computed(() => !!u.value.sizeSource && !isHttpUrl(u.value.sizeSource) && !/文件头/.test(u.value.sizeSource))
</script>

<template>
  <MdSec id="m-units" title="单位" :summary="u.scaleToMeters ? '× ' + fmtNum(u.scaleToMeters, 6) + ' m' : ''">
    <template v-if="m">
      <div class="md-kvs">
        <div class="md-kv" title="导入时的推断（STEP 头 > extras.satsim > 已知尺寸 > 导出器线索 > 包围盒量级）"><span class="k">推断</span><span class="v un-font">{{ UNIT_LABEL[u.unitGuess] || u.unitGuess }}</span></div>
        <div class="md-kv"><span class="k">当前尺寸</span><span class="v" data-i18n-skip>{{ measuredNow ? fmtNum(measuredNow, 4) : '—' }}</span><span class="u">m</span></div>
      </div>
      <div class="srow"><label title="1 个模型单位合多少米；改它时挂点、部件、质心、惯量一并缩放">比例</label>
        <NumIn :model-value="u.scaleToMeters" :min="1e-9" :max="1e6" :sig="9" :disabled="ro" @commit="(v) => applyScale(v)" />
        <span class="u">m/单位</span></div>
      <div class="srow"><label title="尺寸出处（网址，或 STEP / IGES 文件头）；核定尺寸必须有出处">出处</label>
        <input class="ci" type="text" :value="u.sizeSource || ''" :disabled="ro" :class="{ 'md-red': srcBad }" spellcheck="false" data-i18n-skip
               @change="setSource($event.target.value)" @keydown.enter="$event.target.blur()" /></div>
      <label class="md-chkrow" :class="{ dim: !u.sizeSource }" title="尺寸已按出处核定（没有出处不能勾）">
        <input type="checkbox" :checked="!!u.sizeVerified" :disabled="ro || !u.sizeSource" @change="setVerified($event.target.checked)" />尺寸已核定
      </label>

      <div class="lbx-sla-cap un-cap">已知尺寸反算</div>
      <div class="srow">
        <select v-model="dim" class="ci un-dim" :title="(DIMS.find((d) => d.key === dim) || {}).tip">
          <option v-for="d in DIMS" :key="d.key" :value="d.key" :title="d.tip">{{ d.label }}</option>
        </select>
        <NumIn v-model="known" :min="1e-6" :max="1e5" allow-empty :disabled="ro" title="该尺寸的真实值（米，按出处填）" @keydown.enter="solve" />
        <span class="u">m</span>
        <button class="lb-mini" :disabled="ro || !(known > 0) || !measuredNow" @click="solve">反算</button>
      </div>
      <template v-if="res">
        <div v-if="!res.ok" class="md-state bad" data-i18n-skip>{{ res.error }}</div>
        <template v-else>
          <div class="md-kvs">
            <div class="md-kv"><span class="k">模型量得</span><span class="v" data-i18n-skip>{{ fmtNum(res.measured, 5) }}</span><span class="u">单位</span></div>
            <div class="md-kv"><span class="k">比例</span><span class="v" data-i18n-skip>{{ fmtNum(res.rawScale, 6) }}</span><span class="u">m/单位</span></div>
          </div>
          <div class="md-acts">
            <button class="lb-mini primary" :disabled="ro" title="照已知尺寸精确换算（不吸附）" @click="applyScale(res.rawScale, res.unitGuess); res = null">应用</button>
            <button v-if="res.nearest" class="lb-mini" :disabled="ro" :title="'按标准单位 ' + res.nearest.unitGuess + ' 吸附，与已知尺寸差 ' + (res.nearest.relErr * 100).toFixed(1) + '%'"
                    @click="applyScale(res.nearest.scaleToMeters, res.nearest.unitGuess); res = null">
              <span>吸附</span><span data-i18n-skip>{{ res.nearest.unitGuess }} · {{ (res.nearest.relErr * 100).toFixed(1) }}%</span>
            </button>
          </div>
        </template>
      </template>
    </template>
  </MdSec>
</template>

<style scoped>
.un-font { font-family: var(--font-ui) !important; }
.un-cap { margin-top: 6px; }
.un-dim { flex: none !important; width: 74px; min-width: 0 !important; }
</style>
