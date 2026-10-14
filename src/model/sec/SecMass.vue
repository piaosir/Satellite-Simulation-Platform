<script setup>
// 质量特性（任务书 §4.3 三档来源互斥）：
//   手填   质量 / 质心 / 惯量六项由用户给；
//   估算   用户给质量，按部件类型赋密度估算质心与惯量（partMass；部件没识别出来时 Worker 先自动识别）；闭合性 / 体积 / 表面积只作读数；
//   组件   部件表里逐件填质量（质心缺省取分割给的部件质心）→ 平行轴累加；参数化模型用生成器的组件表（只读）。
// 结果区只出数字；闭合性 / 可信度用图标 + title（属性，不是判定）。
import { ref, computed, inject, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { combineComponents, principalInertia } from '@core/models/massProps.mjs'
import { num } from '../../shared/num.js'
import { partsAsComponents, fmtNum, ROLE_LABEL } from '../wbLogic.js'

const wb = inject('wb')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const mp = computed(() => (m.value && m.value.massProps) || null)
const MODES = [
  { key: 'manual', label: '手动输入', tip: '质量、质心、惯量由用户指定' },
  { key: 'estimate', label: '估算', tip: '给定总质量，按部件类型赋密度估算质心与惯量（星体按包围盒实心盒，太阳翼 / 反射面 / 散热面等按面密度；与参数化生成器同一张密度表；未识别部件时先自动识别）' },
  { key: 'components', label: '组件', tip: '逐部件指定质量，按平行轴定理累加' }
]
const mode = ref('manual')
watch(() => [cur.id, mp.value && mp.value.source], () => { mode.value = (mp.value && mp.value.source) || (cur.kind === 'tpl' || cur.kind === 'param' || cur.kind === 'gen' ? 'components' : 'manual') }, { immediate: true })
const isParam = computed(() => cur.kind === 'tpl' || cur.kind === 'param' || cur.kind === 'gen')

function setMP(o) {
  wb.edit((x) => { x.massProps = o ? JSON.parse(JSON.stringify(o)) : null })
}
// ---------- 手填 ----------
const draft = ref({ massKg: null, com: [0, 0, 0], I: [null, null, null, null, null, null] })   // Ixx Iyy Izz Ixy Ixz Iyz
function loadDraft() {
  const p = mp.value
  const I = p && Array.isArray(p.inertiaBody) ? p.inertiaBody : null
  draft.value = {
    massKg: p ? p.massKg : null,
    com: p && Array.isArray(p.comBody) ? p.comBody.slice() : [0, 0, 0],
    // 惯性积按 P = +∫xy dm 显示 / 输入（存的是张量元 = −P）
    I: I ? [I[0][0], I[1][1], I[2][2], -I[0][1], -I[0][2], -I[1][2]] : [null, null, null, null, null, null]
  }
}
watch(() => [cur.id, cur.rev], loadDraft, { immediate: true })
function commitManual() {
  const d = draft.value
  if (!(d.massKg > 0)) return
  const I = d.I
  // 输入的惯性积是 P = +∫xy dm，张量非对角元 = −P
  const P = (k) => (Number.isFinite(I[k]) ? -I[k] : 0)
  const inertia = I.slice(0, 3).every((v) => Number.isFinite(v)) ? [[I[0], P(3), P(4)], [P(3), I[1], P(5)], [P(4), P(5), I[2]]] : null
  setMP({ massKg: d.massKg, comBody: d.com.map((v) => (Number.isFinite(v) ? v : 0)), inertiaBody: inertia, source: 'manual', confidence: 'high' })
}
function setDraft(path, v) {
  const d = JSON.parse(JSON.stringify(draft.value))
  if (path === 'massKg') d.massKg = v
  else if (path[0] === 'c') d.com[+path[1]] = v
  else d.I[+path[1]] = v
  draft.value = d
  commitManual()
}
// 惯量（对质心、本体轴）+ 惯性积 P = +∫xy dm（SolidWorks 缺省「正」记法同号；张量非对角元 = −P）
const I_LABELS = ['Ixx', 'Iyy', 'Izz', 'Pxy', 'Pxz', 'Pyz']
const I_TIPS = ['转动惯量 Ixx（对质心、沿本体轴）', '转动惯量 Iyy（对质心、沿本体轴）', '转动惯量 Izz（对质心、沿本体轴）',
  '惯性积 Pxy = +∫xy dm（张量非对角元 = −Pxy）', '惯性积 Pxz = +∫xz dm（张量非对角元 = −Pxz）', '惯性积 Pyz = +∫yz dm（张量非对角元 = −Pyz）']
const iVal = (I, k) => [I[0][0], I[1][1], I[2][2], -I[0][1], -I[0][2], -I[1][2]][k]

// ---------- 估算 ----------
const estMass = ref(null)
const est = ref(null)          // Worker 结果（体积、闭合性等读数）
const estBusy = ref(false)
const estErr = ref('')
const estMs = ref(0)
watch(() => cur.id, () => { est.value = null; estErr.value = ''; estMass.value = mp.value && mp.value.source === 'estimate' ? mp.value.massKg : null })
const rootOk = computed(() => { void cur.geomRev; return !!wb.currentRoot() && !(cur.kind === 'glb' && cur.lod !== 'lod0') })
// 发起计算的那一件（id + 几何版本）：Worker 回来时当前件换了（切签 / 库页单击别的件）或几何改过，结果作废——
// 不把 A 的质量特性写进 B（500 ms 后自动落盘），同分析页 live() 守卫
const stamp = () => cur.id + '|' + cur.geomRev
async function runEstimate() {
  const root = wb.currentRoot()
  if (!root || !(estMass.value > 0)) return
  estBusy.value = true; estErr.value = ''
  const t0 = performance.now()
  const s0 = stamp(), massKg = estMass.value
  try {
    const r = await wb.analyzer.massProps(root, wb.viewMeta(), { massKg })
    if (stamp() !== s0) return
    estMs.value = Math.round(performance.now() - t0)
    if (!r) { estErr.value = '网格为空。'; return }
    // 部件拆不出来、网格又不闭合：给不出可信的质心（不拿面积形心冒充，审查 P0-1）
    if (!Array.isArray(r.comBody)) { estErr.value = '未识别出部件。'; return }
    est.value = r
    setMP({ massKg, comBody: r.comBody, inertiaBody: r.inertiaBody, source: 'estimate', confidence: r.confidence })
    wb.edit((x) => { const g = x.geometry || (x.geometry = {}); g.closed = !!r.closed; g.volumeM3 = r.volumeM3 == null ? null : r.volumeM3; if (r.areaM2) g.areaM2 = r.areaM2 }, { undo: false })
  } catch (e) { if (stamp() === s0) estErr.value = (e && e.message) || String(e) }
  finally { estBusy.value = false }
}

// ---------- 组件 ----------
const PCOLS = [
  { key: 'name', label: '部件', w: 110, editable: false },
  { key: 'role', label: '角色', w: 64, editable: false },
  { key: 'massKg', label: '质量', unit: 'kg', num: true, w: 70 },
  { key: 'cx', label: '质心 X', unit: 'm', num: true, w: 66 },
  { key: 'cy', label: '质心 Y', unit: 'm', num: true, w: 66 },
  { key: 'cz', label: '质心 Z', unit: 'm', num: true, w: 66 }
]
const parts = computed(() => { void cur.rev; return (m.value && Array.isArray(m.value.parts) ? m.value.parts : []).map((p) => ({ ...p, id: p.id })) })
function comOf(p) { return Array.isArray(p.comBody) ? p.comBody : Array.isArray(p.centroidBody) ? p.centroidBody : null }
function pText(r, c) {
  if (c.key === 'name') return r.name || r.id
  if (c.key === 'role') return ROLE_LABEL[r.role] || r.role || ''
  if (c.key === 'massKg') return Number.isFinite(r.massKg) ? fmtNum(r.massKg, 6) : ''
  const k = { cx: 0, cy: 1, cz: 2 }[c.key]
  const v = comOf(r)
  return v ? fmtNum(v[k], 5) : ''
}
function pEdit(id, key, val) {
  const n = num(val)
  wb.edit((x) => {
    const p = (x.parts || []).find((q) => q.id === id)
    if (!p) return
    if (key === 'massKg') { if (n == null || n <= 0) delete p.massKg; else p.massKg = n }
    else {
      const k = { cx: 0, cy: 1, cz: 2 }[key]
      const c = Array.isArray(p.comBody) ? p.comBody.slice() : (Array.isArray(p.centroidBody) ? p.centroidBody.slice() : [0, 0, 0])
      if (n != null) { c[k] = n; p.comBody = c }
    }
    applyComponents(x)
  }, { undo: false })
  refineComponents()
}
// 组件档的自身惯量（审查 P0-2）：各部件单位质量惯量由分析 Worker 按部件几何与类型算（partMass），按「模型 + 几何版本 + 部件划分」记一份；
// 改质量先按已有的（或质点）即时合成，Worker 回来后补上自身惯量再合成一次
let jpk = null, jpkKey = '', jpkRun = null
const partsSig = (x) => JSON.stringify((x && Array.isArray(x.parts) ? x.parts : []).map((p) => [p.id, p.role, p.nodes || null, p.triRanges || null]))
async function ensureJpk() {
  const root = wb.currentRoot()
  if (!root || !m.value) return null
  const key = cur.id + '|' + cur.geomRev + '|' + partsSig(m.value)
  if (key === jpkKey && jpk) return jpk
  if (jpkRun && jpkRun.key === key) return jpkRun.p
  const p = wb.analyzer.partInertia(root, wb.viewMeta()).then((list) => {
    jpk = new Map((Array.isArray(list) ? list : []).map((o) => [o.id, o.inertiaPerKg])); jpkKey = key
    return jpk
  }).catch(() => null).finally(() => { if (jpkRun && jpkRun.key === key) jpkRun = null })
  jpkRun = { key, p }
  return p
}
async function refineComponents() {
  const s0 = stamp()
  const J = await ensureJpk()
  if (stamp() !== s0) return   // 算的途中换了件：这份自身惯量属于上一件
  if (!J || !J.size || !m.value || !m.value.massProps || m.value.massProps.source !== 'components') return
  wb.edit((x) => applyComponents(x, J), { undo: false })
}
function applyComponents(x, J = jpk) {
  const r = combineComponents(partsAsComponents(x.parts, J))
  if (r) x.massProps = { massKg: r.massKg, comBody: r.comBody, inertiaBody: r.inertiaBody, source: 'components', confidence: 'low' }
}
const pg = useGridSelect({
  gridId: 'md-mass-parts', rows: () => parts.value, cols: () => PCOLS, cellText: pText,
  cellRaw: (r, c) => pText(r, c),
  onEdit: pEdit,
  onClear: (cells) => { for (const { rowId, key } of cells) if (key === 'massKg') pEdit(rowId, key, '') },
  pushUndo: wb.pushUndo, dropUndo: wb.dropUndo, undo: wb.undo, redo: wb.redo
})
// 没手填质心的部件：质心列显示面积形心，压暗（等宽与压暗两个类都要，不能一个吃掉另一个）
const pCellClass = (r, c) => [c.num ? 'md-mono' : '', (c.key === 'cx' || c.key === 'cy' || c.key === 'cz') && !Array.isArray(r.comBody) ? 'md-dim' : ''].filter(Boolean).join(' ') || null
const nWithMass = computed(() => parts.value.filter((p) => p.massKg > 0).length)
const paramComps = computed(() => {
  void cur.rev
  const r = wb.currentParam()
  return r && r.massProps && Array.isArray(r.massProps.components) ? r.massProps.components : []
})
function useParamComponents() {
  const r = wb.currentParam()
  if (!r) return
  setMP({ massKg: r.massProps.massKg, comBody: r.massProps.comBody, inertiaBody: r.massProps.inertiaBody, source: 'components', confidence: 'low' })
}

const conf = computed(() => mp.value && mp.value.confidence)
const inertia = computed(() => (mp.value && Array.isArray(mp.value.inertiaBody) ? mp.value.inertiaBody : null))
const principal = computed(() => { const I = inertia.value; if (!I) return []; try { return principalInertia(I).moments.slice().sort((a, b) => a - b) } catch { return [] } })
</script>

<template>
  <MdSec id="m-mass" title="质量特性" :summary="mp ? fmtNum(mp.massKg, 5) + ' kg' : ''">
    <template v-if="m">
      <div class="srow"><label title="三种来源互斥：结果仅取当前所选来源">来源</label>
        <div class="lbu-seg">
          <button v-for="x in MODES" :key="x.key" :class="{ on: mode === x.key }" :aria-pressed="(mode === x.key) ? 'true' : 'false'" :title="x.tip" :disabled="ro && !isParam" @click="mode = x.key">{{ x.label }}</button>
        </div>
      </div>

      <!-- 手填 -->
      <template v-if="mode === 'manual'">
        <div class="srow"><label>质量</label>
          <NumIn :model-value="draft.massKg" :min="1e-6" :max="1e7" allow-empty :disabled="ro" @commit="(v) => setDraft('massKg', v)" /><span class="u">kg</span></div>
        <div class="srow"><label title="本体系（米）">质心</label>
          <div class="md-v3"><NumIn v-for="k in [0, 1, 2]" :key="k" :model-value="draft.com[k]" :sig="6" :disabled="ro" @commit="(v) => setDraft('c' + k, v)" /></div><span class="u">m</span></div>
        <div class="srow ms-I"><label title="对质心、沿本体系轴；未填惯量时仅保存质量与质心">惯量 (kg·m²)</label>
          <div class="ms-I6">
            <div v-for="(lab, k) in I_LABELS" :key="lab" class="ms-Ic" :title="I_TIPS[k]"><span class="ms-Il" data-i18n-skip>{{ lab }}</span>
              <NumIn :model-value="draft.I[k]" :sig="6" allow-empty :disabled="ro" @commit="(v) => setDraft('I' + k, v)" /></div>
          </div></div>
      </template>

      <!-- 估算 -->
      <template v-else-if="mode === 'estimate'">
        <div class="srow"><label>质量</label>
          <NumIn v-model="estMass" :min="1e-6" :max="1e7" allow-empty :disabled="ro" /><span class="u">kg</span>
          <button class="lb-mini" :disabled="ro || !rootOk || !(estMass > 0) || estBusy" title="按部件类型赋密度估算（全精度 lod0；未识别部件时先自动识别）" @click="runEstimate">{{ estBusy ? '估算中…' : '估算' }}</button>
        </div>
        <div v-if="estErr" class="md-state bad">{{ estErr }}</div>
        <div v-if="est" class="md-acts ms-flags">
          <span class="md-ico" :class="est.closed ? 'good' : 'poor'" :title="est.closed ? '网格闭合' : '网格不闭合'"><Icon :name="est.closed ? 'check' : 'alert-triangle'" :size="12" />闭合性</span>
          <span class="md-ico" :class="est.confidence === 'high' ? 'good' : 'poor'" :title="'可信度 ' + est.confidence"><Icon :name="est.confidence === 'high' ? 'check' : 'alert-triangle'" :size="12" />可信度</span>
          <span v-if="est.volumeM3 != null" class="md-state" title="体积"><span data-i18n-skip>{{ fmtNum(est.volumeM3, 4) }}</span> m³</span>
          <span class="md-state" title="表面积"><span data-i18n-skip>{{ fmtNum(est.areaM2, 4) }}</span> m²</span>
          <span v-if="est.shells" class="md-state" title="壳体数 / 已翻正的壳体 / 空腔数"><span data-i18n-skip>{{ est.shells }} / {{ est.invertedShells }} / {{ est.cavities }}</span></span>
          <span class="md-state" data-i18n-skip>{{ estMs }} ms</span>
        </div>
      </template>

      <!-- 组件 -->
      <template v-else>
        <template v-if="isParam">
          <div class="md-grid short ms-pc">
            <table class="ms-ctbl">
              <thead><tr><th>组件</th><th class="n">质量 (kg)</th><th class="n">质心 (m)</th></tr></thead>
              <tbody><tr v-for="c in paramComps" :key="c.name"><td data-i18n-skip>{{ c.name }}</td><td class="n" data-i18n-skip>{{ fmtNum(c.massKg, 5) }}</td><td class="n" data-i18n-skip>{{ c.comBody.map((v) => fmtNum(v, 3)).join(', ') }}</td></tr></tbody>
            </table>
          </div>
          <div v-if="cur.kind !== 'tpl' && cur.kind !== 'gen'" class="md-acts"><button class="lb-mini" :disabled="ro" @click="useParamComponents">按生成器组件汇总</button></div>
        </template>
        <template v-else>
          <div class="md-grid tall">
            <ExcelGrid :grid="pg" :cols="PCOLS" :text="pText" :cell-class="pCellClass" :head-tip="(c) => c.tip || c.label" empty-text="暂无部件。" />
          </div>
          <div class="md-state"><span>计入</span><span data-i18n-skip>{{ nWithMass }} / {{ parts.length }}</span></div>
        </template>
      </template>

      <!-- 结果（只出数字） -->
      <div class="lbx-sla-cap ms-cap">结果</div>
      <div v-if="!mp" class="lb-placeholder ms-none">尚无质量特性。</div>
      <template v-else>
        <div class="md-kvs">
          <div class="md-kv"><span class="k">质量</span><span class="v" data-i18n-skip>{{ fmtNum(mp.massKg, 6) }}</span><span class="u">kg</span></div>
          <div class="md-kv" :title="mp.source + ' · ' + conf"><span class="k">来源</span><span class="v ms-src">{{ (MODES.find((x) => x.key === mp.source) || {}).label || mp.source }}</span>
            <Icon :name="conf === 'high' ? 'check' : 'alert-triangle'" :size="12" :class="conf === 'high' ? 'ms-good' : 'ms-poor'" /></div>
          <div class="md-kv"><span class="k">质心 X</span><span class="v" data-i18n-skip>{{ fmtNum(mp.comBody[0], 5) }}</span><span class="u">m</span></div>
          <div class="md-kv"><span class="k">质心 Y</span><span class="v" data-i18n-skip>{{ fmtNum(mp.comBody[1], 5) }}</span><span class="u">m</span></div>
          <div class="md-kv"><span class="k">质心 Z</span><span class="v" data-i18n-skip>{{ fmtNum(mp.comBody[2], 5) }}</span><span class="u">m</span></div>
          <template v-if="inertia">
            <div v-for="(lab, k) in I_LABELS" :key="lab" class="md-kv" :title="I_TIPS[k]"><span class="k" data-i18n-skip>{{ lab }}</span>
              <span class="v" data-i18n-skip>{{ fmtNum(iVal(inertia, k), 5) }}</span><span class="u">kg·m²</span></div>
            <div v-for="(v, k) in principal" :key="'pm' + k" class="md-kv" title="主惯量（惯量张量特征值，由小到大；与惯性积符号记法无关）"><span class="k" data-i18n-skip>I{{ k + 1 }}</span>
              <span class="v" data-i18n-skip>{{ fmtNum(v, 5) }}</span><span class="u">kg·m²</span></div>
          </template>
        </div>
        <div class="md-acts"><span class="sp"></span><button class="lb-mini" :disabled="ro" title="清除质量特性" @click="setMP(null)"><Icon name="trash" :size="12" />清除</button></div>
      </template>
    </template>
  </MdSec>
</template>

<style scoped>
.srow > .lbu-seg { flex: 1 1 auto; min-width: 0; }
.srow > .lbu-seg > button { flex: 1 1 auto; height: var(--h-ctl); padding-top: 0; padding-bottom: 0; font-size: var(--fs-3); }
.ms-I { align-items: flex-start; }
.ms-I6 { flex: 1 1 auto; min-width: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 3px; }
.ms-Ic { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ms-Il { font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.ms-flags { gap: 10px; }
.ms-cap { margin-top: 6px; }
.ms-none { padding: 4px 0; text-align: left; }
.ms-src { font-family: var(--font-ui) !important; }
.ms-good { color: var(--ok); } .ms-poor { color: var(--warn); }
.ms-pc { padding: 0; }
.ms-ctbl { width: 100%; border-collapse: collapse; font-size: var(--fs-2); font-variant-numeric: tabular-nums; }
.ms-ctbl th { position: sticky; top: 0; background: var(--surface-2); text-align: left; font-weight: 600; color: var(--text-muted); padding: 3px 6px; border-bottom: 1px solid var(--lb-rule); }
.ms-ctbl td { padding: 2px 6px; border-bottom: 1px solid var(--lb-rule-soft); white-space: nowrap; }
.ms-ctbl .n { text-align: right; font-family: var(--font-mono); }
</style>
