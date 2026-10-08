<script setup>
// 快速设置 · 模型视图（导入件 / NASA / STK / 已存参数化件 / 只读模板，2026-10 统一设计）：标定一件外来模型最先要做的四步——
//   ① 尺寸（读数 + 按已知尺寸缩放）② 朝向（±90° 步进 / 恢复导入缺省）③ 质量（整星质量：按比例缩放已有质量特性，或估算）
//   ④ 部件与挂点（自动识别：部件 / 太阳翼组 / 反射面焦点挂点）。完整的各节（单位、本体轴、质量特性、部件、挂点、关节、太阳翼组、
//   遮挡计算排除节点、JSON）在右栏属性里；这里只是同一份元数据的快捷入口（wb.edit，一步撤销）。
// 只读的件（参数化模板 / 星座精模 / 装配件）不在这里改：装配件给「在装配视图打开」；副本入口只在功能区文档组一处（ModelRibbon，§3.2）。
import { ref, computed, inject } from 'vue'
import Icon from '../../components/Icon.vue'
import NumIn from '../NumIn.vue'
import { scaleFromKnownDim } from '@core/models/units.mjs'
import { axisStep, quatCanonical, DEFAULT_Q_MODEL2BODY } from '@core/models/bodyFrame.mjs'
import { rescaleMeta, reframeMeta, mergeSegment, fmtNum, bodyBoxOfMeta, factoryFrameQ, sameRotation, displayName } from '../wbLogic.js'
import { wholeMassLabel } from '../asmLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const entry = computed(() => (cur.id ? wb.byId(cur.id) : null))
const isFleet = computed(() => !!entry.value && !!entry.value.fleet)
const roText = computed(() => {
  if (!m.value) return ''
  if (cur.asm) return '装配件'
  if (isFleet.value) return '星座精模只读'
  if (cur.kind === 'tpl' || cur.kind === 'gen') return '模板只读'
  if (!wb.api) return '需在桌面客户端中运行'
  return ''
})
function openAsm() { if (cur.id) wb.openInDesign(cur.id) }

// ── 名称 ──
const nameVal = computed(() => (m.value ? displayName(m.value, 'zh') : ''))
function rename(ev) {
  const v = String(ev.target.value || '').trim()
  if (!v || v === nameVal.value || ro.value) return
  wb.edit((x) => { x.titleZh = v })
}

// ── ① 尺寸 ──
const box = computed(() => { void cur.rev; void cur.geomRev; const vp = getVp(); const b = (cur.view && cur.view.bboxM) || (vp && vp.bounds && vp.bounds.bboxBody) || (m.value ? bodyBoxOfMeta(m.value) : null); return b })
const dims = computed(() => (box.value ? [0, 1, 2].map((k) => box.value.max[k] - box.value.min[k]) : null))
const DIMS = [
  { key: 1, label: '翼展（Y）', tip: '本体 Y 向总长（GEO 南北向，太阳翼展开方向）' },
  { key: 0, label: '长（X）', tip: '本体 X 向总长（速度方向）' },
  { key: 2, label: '高（Z）', tip: '本体 Z 向总高（对地方向）' },
  { key: 'max', label: '最长边', tip: '包围盒三边中的最长边' }
]
const dimKey = ref(1)
const known = ref(null)
const measured = computed(() => { const d = dims.value; if (!d) return null; const k = dimKey.value; return k === 'max' ? Math.max(...d) : d[Number(k)] })
function scaleNow() {
  const mm = measured.value, s0 = (m.value && m.value.units && m.value.units.scaleToMeters) || 1
  if (!(mm > 0) || !(known.value > 0) || ro.value) return
  const r = scaleFromKnownDim({ measuredModelUnits: mm / s0, knownMeters: known.value })
  if (!r.ok) { wb.hint(r.error || '无法缩放。'); return }
  // 照用户给的尺寸算、不吸附到标准单位（同单位节「已知尺寸反算」的缺省口径）
  const s = r.rawScale
  if (!(s > 0) || s === s0) return
  wb.edit((x) => {
    const n = rescaleMeta(JSON.parse(JSON.stringify(x)), s / s0)
    for (const key of Object.keys(n)) x[key] = n[key]
    x.units = { ...(x.units || {}), scaleToMeters: s, unitGuess: r.snapped && r.relErr < 1e-9 ? r.unitGuess : 'unknown' }
  }, { geom: true })
}

// ── ② 朝向 ──
const q = computed(() => { const f = m.value && m.value.frame; return f && Array.isArray(f.q_model2body) ? f.q_model2body : DEFAULT_Q_MODEL2BODY.slice() })
function setQ(qn) {
  if (!qn || ro.value || sameRotation(qn, q.value, 1e-9)) return
  const q0 = q.value.slice()
  wb.edit((x) => { const n = reframeMeta(JSON.parse(JSON.stringify(x)), q0, qn); for (const key of Object.keys(n)) x[key] = n[key] }, { geom: true })
}
const STEPS = [['x', 90], ['x', -90], ['y', 90], ['y', -90], ['z', 90], ['z', -90]]
const factoryQ = computed(() => (m.value ? factoryFrameQ(m.value) : null))
const isFactory = computed(() => !!factoryQ.value && sameRotation(q.value, factoryQ.value, 1e-6))

// ── ③ 质量 ──
const mp = computed(() => (m.value && m.value.massProps) || null)
const SRC = { manual: '手动输入', estimate: '估算', components: '组件' }
/**
 * 改整体质量：已有质量特性 → 同一分布按比例缩放（质心不变、惯量 × 比例）；没有 → 走估算。
 * 组件档（总量由部件表逐件质量汇总）：各部件质量同比缩放——只改总量的话，下次在质量特性节改任一部件质量就按部件重新汇总，总量又回到旧值。
 */
function setMass(v) {
  if (!(v > 0) || ro.value) return
  const p = mp.value
  if (p && p.massKg > 0) {
    const k = v / p.massKg
    wb.edit((x) => {
      const o = JSON.parse(JSON.stringify(x.massProps))
      o.massKg = v
      if (Array.isArray(o.inertiaBody)) o.inertiaBody = o.inertiaBody.map((r) => r.map((e) => e * k))
      x.massProps = o
      if (o.source === 'components' && Array.isArray(x.parts)) for (const pt of x.parts) if (pt && pt.massKg > 0) pt.massKg *= k
    })
  } else estimate(v)
}
// 整体质量的叫法随模型类别（整星 / 整机 / 全船 / 整车 / 整站），与装配视图根节点同一套
const massLabel = computed(() => wholeMassLabel(m.value && m.value.kind))
const estBusy = ref(false)
// 发起计算的那一件（id + 几何版本）：Worker 回来时当前件换了（切签 / 库页单击别的件）或几何改过（缩放 / 轴向），结果作废——
// 不写进别的件（500 ms 后会自动落盘），同分析页 live() 守卫
const stamp = () => cur.id + '|' + cur.geomRev
async function estimate(massKg) {
  const root = wb.currentRoot()
  if (!root || !(massKg > 0)) return
  estBusy.value = true
  const s0 = stamp()
  try {
    const r = await wb.analyzer.massProps(root, wb.viewMeta(), { massKg })
    if (stamp() !== s0) return
    if (!r) { wb.hint('网格为空。'); return }
    if (!Array.isArray(r.comBody)) { wb.hint('未识别出部件。'); return }
    wb.edit((x) => { x.massProps = { massKg, comBody: r.comBody, inertiaBody: r.inertiaBody, source: 'estimate', confidence: r.confidence } })
  } catch (e) { if (stamp() === s0) wb.hint((e && e.message) || String(e)) } finally { estBusy.value = false }
}

// ── ④ 部件与挂点 ──
const segBusy = ref(false)
const counts = computed(() => {
  void cur.rev
  const x = m.value || {}
  const parts = Array.isArray(x.parts) ? x.parts : []
  return { parts: parts.length, refl: parts.filter((p) => p && p.role === 'reflector').length, aps: Array.isArray(x.attachPoints) ? x.attachPoints.length : 0, spg: Array.isArray(x.solarPanelGroups) ? x.solarPanelGroups.length : 0 }
})
const rootOk = computed(() => { void cur.geomRev; return !!wb.currentRoot() && !(cur.kind === 'glb' && cur.lod !== 'lod0') })
async function autoSeg() {
  const root = wb.currentRoot()
  if (!root || ro.value) return
  segBusy.value = true
  const s0 = stamp()
  try {
    const seg = await wb.analyzer.segment(root, wb.viewMeta())
    if (stamp() !== s0) return
    wb.edit((x) => { const n = mergeSegment(JSON.parse(JSON.stringify(x)), seg); x.parts = n.parts; x.attachPoints = n.attachPoints; x.solarPanelGroups = n.solarPanelGroups })
  } catch (e) { if (stamp() === s0) wb.hint((e && e.message) || String(e)) } finally { segBusy.value = false }
}
</script>

<template>
  <div class="asm qk" data-quick="model">
    <div v-if="!m" class="asm-empty">未选中模型。</div>
    <template v-else>
      <div class="sec qk-head">
        <div class="srow"><label>名称</label>
          <input :key="cur.id + '|' + nameVal" class="ci asm-txt" type="text" spellcheck="false" :value="nameVal" :disabled="ro" data-i18n-skip @change="rename" @keydown.enter="$event.target.blur()" />
        </div>
        <div v-if="roText" class="md-state warn"><Icon name="lock" :size="12" />{{ roText }}</div>
        <div v-if="cur.asm" class="md-acts">
          <button class="lb-mini primary" data-act="q-open-asm" title="在装配视图中编辑" @click="openAsm"><Icon name="boxes" :size="12" />在装配视图打开</button>
        </div>
      </div>

      <!-- ① 尺寸 -->
      <div class="sec" data-sec="q-size">
        <div class="sect"><span class="qk-n">1</span><span class="sect-t">尺寸</span></div>
        <div class="md-kvs qk-kvs3">
          <div v-for="(a, k) in ['X', 'Y', 'Z']" :key="a" class="md-kv"><span class="k">{{ a }}</span><span class="v" data-i18n-skip>{{ dims ? fmtNum(dims[k], 4) : '—' }}</span><span class="u">m</span></div>
        </div>
        <div class="srow"><label title="用一项已知尺寸反算模型比例（本体系里的挂点、部件、质量特性一并缩放）">已知尺寸</label>
          <select v-model="dimKey" class="ci qk-dim" :disabled="ro"><option v-for="d in DIMS" :key="d.key" :value="d.key" :title="d.tip">{{ d.label }}</option></select>
          <NumIn v-model="known" :min="1e-4" :max="1e5" :sig="6" :disabled="ro" placeholder="米" />
          <button class="lb-mini" data-act="q-scale" :disabled="ro || !(known > 0) || !(measured > 0)" title="按已知尺寸缩放" @click="scaleNow">缩放</button>
        </div>
      </div>

      <!-- ② 朝向 -->
      <div class="sec" data-sec="q-frame">
        <div class="sect"><span class="qk-n">2</span><span class="sect-t">朝向</span></div>
        <div class="qk-steps">
          <button v-for="([ax, d], i) in STEPS" :key="i" class="lb-mini" :class="'fr-' + ax" :disabled="ro" :title="`绕本体 ${ax.toUpperCase()} 轴转 ${d > 0 ? '+' : '−'}90°`" @click="setQ(axisStep(q, ax, d))" data-i18n-skip>{{ ax.toUpperCase() }} {{ d > 0 ? '+90°' : '−90°' }}</button>
        </div>
        <div class="md-acts">
          <button class="lb-mini" :disabled="ro || isFactory || !factoryQ" title="恢复导入时的缺省映射（按来源）" @click="setQ(quatCanonical(factoryQ))"><Icon name="undo-2" :size="12" />恢复缺省映射</button>
        </div>
      </div>

      <!-- ③ 质量 -->
      <div class="sec" data-sec="q-mass">
        <div class="sect"><span class="qk-n">3</span><span class="sect-t">质量</span><span v-if="mp" class="cnt">{{ SRC[mp.source] || mp.source }}</span></div>
        <div class="srow"><label title="已有质量特性时按同一分布缩放（质心不变、惯量按比例；组件来源时各部件质量同比缩放）；没有时按网格估算">{{ massLabel }}</label>
          <NumIn :model-value="mp ? mp.massKg : null" :min="1e-3" :max="1e9" :sig="6" :disabled="ro || estBusy || !rootOk" placeholder="kg" @commit="setMass" />
          <span class="u">kg</span>
        </div>
      </div>

      <!-- ④ 部件与挂点 -->
      <div class="sec" data-sec="q-parts">
        <div class="sect"><span class="qk-n">4</span><span class="sect-t">部件与挂点</span></div>
        <div class="md-acts">
          <button class="lb-mini" data-act="q-seg" :disabled="ro || segBusy || !rootOk" title="按几何、节点名与材质分组识别部件；生成太阳翼组与反射面焦点挂点（已有的不覆盖）" @click="autoSeg"><Icon name="scan-eye" :size="12" />{{ segBusy ? '识别中…' : '自动识别' }}</button>
        </div>
        <div class="md-kvs">
          <div class="md-kv"><span class="k">部件</span><span class="v" data-i18n-skip>{{ counts.parts }}</span></div>
          <div class="md-kv"><span class="k">反射面</span><span class="v" data-i18n-skip>{{ counts.refl }}</span></div>
          <div class="md-kv"><span class="k">挂点</span><span class="v" data-i18n-skip>{{ counts.aps }}</span></div>
          <div class="md-kv"><span class="k">太阳翼组</span><span class="v" data-i18n-skip>{{ counts.spg }}</span></div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.qk { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
.qk-head { display: flex; flex-direction: column; gap: 6px; }
.qk-n { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-right: 6px; border-radius: 50%;
  font-size: var(--fs-1); font-weight: 700; color: var(--bg); background: var(--text-muted); font-variant-numeric: tabular-nums; }
.qk-kvs3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.qk-dim { flex: 0 1 96px; min-width: 84px; }
.qk-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.qk-steps > .lb-mini { height: var(--h-ctl); font-family: var(--font-mono); }
.qk-steps .fr-x { color: #c4453f; }
.qk-steps .fr-y { color: #2f8a55; }
.qk-steps .fr-z { color: #3d5fc4; }
html[data-theme='dark'] .qk-steps .fr-x { color: #e5736d; }
html[data-theme='dark'] .qk-steps .fr-y { color: #5fbf86; }
html[data-theme='dark'] .qk-steps .fr-z { color: #7f9cf0; }
</style>
