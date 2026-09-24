<script setup>
// 关节（AGI articulation，任务书 §5.5）：列表 + 每条的名称 / 节点 / pointingVector / 各 stage 的名称·类型·最小·最大·初值全部可改，
// 可新建 / 删除关节、加 / 删 stage —— 用户自己导入的 CAD / OBJ / STL 件没有任何关节，二期的太阳翼对日、天线万向节都要在这里补出来。
// 每个 stage 一根滑杆，实时驱动预览里对应节点（viewport.setArticulation，只动预览里的克隆，不改元数据）；「设为初值」把滑杆位置写成 initialValue。
// 滑杆值也记在视口里：元数据改一格重喂时视口照这个值重摆，两边一致。悬停关节 = 预览高亮它的节点。
// 节点按 IR 名（irLayout，与导出件节点名、部件 nodes 同一口径）；可从下拉加，也可在预览里点选（落到被点中的那个网格节点）。
import { reactive, computed, inject, watch, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import MdSec from '../MdSec.vue'
import NumIn from '../NumIn.vue'
import { irLayout } from '../../viz/models/irToThree.js'
import { STAGE_LABEL, STAGE_TYPE_LIST, stageUnit, fmtNum, uniqueName, newArticulation, newStage, retypeStage } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const pick = inject('pick', null)
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const arts = computed(() => { void cur.rev; return (m.value && Array.isArray(m.value.articulations) ? m.value.articulations : []) })

// ============ 滑杆（只驱动预览）============
// 滑杆当前值（关节名 → stage 名 → 值）；换模型清零（视口那边换模型也清，同一模型换 LOD 两边都留着）
const live = reactive({})
watch(() => cur.id, () => { for (const k of Object.keys(live)) delete live[k] })
function valOf(a, s) { const v = live[a.name] && live[a.name][s.name]; return Number.isFinite(v) ? v : (Number.isFinite(s.initialValue) ? s.initialValue : 0) }
/** 按当前元数据里这条关节的 stage 顺序把滑杆值送给视口；这条关节一个滑杆都没动过就让它回初值 */
function drive(name) {
  const vp = getVp()
  if (!vp) return
  const a = arts.value.find((x) => x.name === name)
  if (!a || !live[name] || !Object.keys(live[name]).length) { vp.setArticulation(name, null); return }
  vp.setArticulation(name, (a.stages || []).map((s) => valOf(a, s)))
}
function onSlide(a, s, v) {
  if (!live[a.name]) live[a.name] = {}
  live[a.name][s.name] = +v
  drive(a.name)
}
function reset(a) { delete live[a.name]; drive(a.name) }
function resetAll() { for (const k of Object.keys(live)) delete live[k]; const vp = getVp(); if (vp) vp.resetArticulations() }
function stepOf(s) {
  const span = Math.abs(s.maximumValue - s.minimumValue)
  if (/Rotate$/.test(s.type)) return span > 20 ? 0.5 : 0.05
  return span > 0 ? span / 400 : 0.01
}

// ============ 编辑（落盘）============
const findA = (x, name) => (Array.isArray(x.articulations) ? x.articulations.find((q) => q.name === name) : null)
function setStage(a, s, key, v) {
  wb.edit((x) => {
    const A = findA(x, a.name)
    const S = A && (A.stages || []).find((q) => q.name === s.name)
    if (!S) return
    S[key] = v
    if (S.minimumValue > S.maximumValue) { const t = S.minimumValue; S.minimumValue = S.maximumValue; S.maximumValue = t }
    S.initialValue = Math.min(S.maximumValue, Math.max(S.minimumValue, S.initialValue))
  })
}
function toInitial(a, s) { setStage(a, s, 'initialValue', valOf(a, s)) }
// AGI 名字：非空、不含空白（空白换下划线），同级唯一
const cleanName = (v) => String(v || '').trim().replace(/\s+/g, '_')
function renameArt(a, v) {
  const s = cleanName(v)
  if (!s || s === a.name) return
  const old = a.name
  let nm = s
  wb.edit((x) => {
    const A = findA(x, old)
    if (!A) return
    const taken = new Set((x.articulations || []).map((q) => q.name)); taken.delete(old)
    nm = uniqueName(s, taken)
    A.name = nm
  })
  if (live[old]) { live[nm] = live[old]; delete live[old] }
  const vp = getVp(); if (vp) vp.setArticulation(old, null)
  drive(nm)
}
function renameStage(a, s, v) {
  const n = cleanName(v)
  if (!n || n === s.name) return
  const old = s.name
  let nm = n
  wb.edit((x) => {
    const A = findA(x, a.name)
    const S = A && (A.stages || []).find((q) => q.name === old)
    if (!S) return
    const taken = new Set(A.stages.map((q) => q.name)); taken.delete(old)
    nm = uniqueName(n, taken)
    S.name = nm
  })
  if (live[a.name] && old in live[a.name]) { live[a.name][nm] = live[a.name][old]; delete live[a.name][old] }
}
function setType(a, s, type) {
  if (type === s.type) return
  wb.edit((x) => {
    const A = findA(x, a.name)
    const i = A ? (A.stages || []).findIndex((q) => q.name === s.name) : -1
    if (i < 0) return
    A.stages[i] = retypeStage(A.stages[i], type)
  })
  if (live[a.name]) delete live[a.name][s.name]   // 量纲可能变了（角度 ↔ 长度 ↔ 倍数），旧滑杆值没有意义
  drive(a.name)
}
function addStage(a) {
  wb.edit((x) => { const A = findA(x, a.name); if (A) (A.stages || (A.stages = [])).push(newStage(A.stages, 'zRotate')) })
  drive(a.name)
}
function removeStage(a, s) {
  if ((a.stages || []).length <= 1) return   // AGI：stages 须非空
  wb.edit((x) => { const A = findA(x, a.name); if (A) A.stages = A.stages.filter((q) => q.name !== s.name) })
  if (live[a.name]) delete live[a.name][s.name]
  drive(a.name)
}
function addArt() {
  let nm = ''
  wb.edit((x) => {
    const list = Array.isArray(x.articulations) ? x.articulations : (x.articulations = [])
    const a = newArticulation(new Set(list.map((q) => q.name)))
    nm = a.name
    list.push(a)
  })
  return nm
}
function removeArt(a) {
  const name = a.name
  wb.edit((x) => { x.articulations = (x.articulations || []).filter((q) => q.name !== name) })
  delete live[name]
  if (pick && pick.owner.value === 'artic:' + name) pick.stop()
  const vp = getVp(); if (vp) vp.setArticulation(name, null)
}
// pointingVector：三格可空；给了一格其余按 0；全 0 视为没给（AGI 要求非零向量）
function setPv(a, k, v) {
  wb.edit((x) => {
    const A = findA(x, a.name)
    if (!A) return
    const p = Array.isArray(A.pointingVector) ? A.pointingVector.slice() : [0, 0, 0]
    p[k] = v == null ? 0 : v
    if (p.every((c) => c === 0)) delete A.pointingVector
    else A.pointingVector = p
  })
}
function clearPv(a) { wb.edit((x) => { const A = findA(x, a.name); if (A) delete A.pointingVector }) }

// ============ 节点 ============
// 节点表（IR 名，先序、带层级缩进）：随几何换（geomRev）重算
const nodeList = computed(() => {
  void cur.geomRev
  const root = wb.currentRoot()
  if (!root) return []
  const all = irLayout(root)
  const sceneRoot = !!(root.isScene || (root.userData && root.userData.__sceneRoot))
  const depth = new Array(all.length).fill(0)
  const out = []
  all.forEach((e, i) => {
    depth[i] = e.parent >= 0 ? depth[e.parent] + 1 : 0
    if (e.isRoot && sceneRoot) return
    out.push({ name: e.name, depth: Math.max(0, depth[i] - (sceneRoot ? 1 : 0)) })
  })
  return out
})
const indent = (d) => ' '.repeat(Math.min(12, d))
function setNodes(a, fn) {
  wb.edit((x) => {
    const A = findA(x, a.name)
    if (!A) return
    const s = new Set(Array.isArray(A.nodes) ? A.nodes : [])
    fn(s)
    const order = new Map(nodeList.value.map((r, i) => [r.name, i]))
    A.nodes = [...s].sort((p, q) => (order.get(p) ?? 1e9) - (order.get(q) ?? 1e9))
  })
  drive(a.name)
  hover(arts.value.find((q) => q.name === a.name) || null)
}
function addNode(a, name) { if (name) setNodes(a, (s) => s.add(name)) }
function removeNode(a, name) { setNodes(a, (s) => s.delete(name)) }
const pickingFor = computed(() => (pick && typeof pick.owner.value === 'string' && pick.owner.value.startsWith('artic:') ? pick.owner.value.slice(6) : ''))
function togglePick(a) {
  if (!pick) return
  if (pickingFor.value === a.name) { pick.stop(); return }
  const name = a.name
  pick.start('artic:' + name, 'select', (hit) => {
    if (!hit) return
    const n = hit.irNode || hit.nodeName
    const A = arts.value.find((q) => q.name === name)
    if (n && A) addNode(A, n)
  })
}
function hover(a) { const vp = getVp(); if (vp) vp.highlightNodes(a ? a.nodes : null) }
onBeforeUnmount(() => { if (pick && pickingFor.value) pick.stop() })

function newArt() {
  const nm = addArt()
  // 新关节马上进点选：用户接下来就是在预览里点要转的件
  const a = arts.value.find((q) => q.name === nm)
  if (a && pick) togglePick(a)
}
</script>

<template>
  <MdSec id="m-artic" title="关节" :count="arts.length || null">
    <template #actions>
      <button class="lb-mini" :disabled="ro || !m" title="新建关节（绕节点局部 Z 轴转 ±180°），随后在预览里点要动的件" @click="newArt"><Icon name="plus" :size="12" />新建关节</button>
    </template>
    <template v-if="m">
      <div v-if="!arts.length" class="lb-placeholder ar-none">没有关节。</div>
      <template v-else>
        <div class="md-acts"><span class="sp"></span><button class="lb-mini" title="全部关节回初值（只影响预览）" @click="resetAll"><Icon name="undo-2" :size="12" />全部复位</button></div>
        <div v-for="a in arts" :key="a.name" class="ar" @mouseenter="hover(a)" @mouseleave="hover(null)">
          <div class="ar-hd">
            <input class="ci ar-name" type="text" :value="a.name" :disabled="ro" spellcheck="false" data-i18n-skip title="关节名（AGI：不含空白，同一模型内唯一）"
                   @change="renameArt(a, $event.target.value); $event.target.value = a.name" @keydown.enter="$event.target.blur()" />
            <span class="ar-c" :title="(a.nodes || []).join('\n')"><span data-i18n-skip>{{ (a.nodes || []).length }}</span> 节点</span>
            <span class="sp"></span>
            <button class="lb-mini lb-mini-ico" title="该关节回初值（只影响预览）" @click="reset(a)"><Icon name="undo-2" :size="12" /></button>
            <button class="lb-mini lb-mini-ico" :disabled="ro" title="删除这条关节" @click="removeArt(a)"><Icon name="trash" :size="12" /></button>
          </div>
          <!-- 节点 -->
          <div class="ar-nodes">
            <span v-for="n in a.nodes || []" :key="n" class="ar-chip" :title="n">
              <span class="ar-chip-t" data-i18n-skip>{{ n }}</span>
              <button v-if="!ro" class="ar-chip-x" title="移出这条关节" @click="removeNode(a, n)"><Icon name="x" :size="10" /></button>
            </span>
            <span v-if="!(a.nodes || []).length" class="ar-empty">无节点。</span>
          </div>
          <div v-if="!ro" class="ar-row">
            <select class="ci ar-add" value="" :disabled="!nodeList.length" title="加节点（IR 节点名；缩进 = 层级）" @change="addNode(a, $event.target.value); $event.target.value = ''">
              <option value="">加节点…</option>
              <option v-for="r in nodeList" :key="r.name" :value="r.name" :disabled="(a.nodes || []).includes(r.name)" data-i18n-skip>{{ indent(r.depth) + r.name }}</option>
            </select>
            <button class="lb-mini" :class="{ on: pickingFor === a.name }" :disabled="!nodeList.length" title="在预览里点模型，把被点中的节点加进这条关节" @click="togglePick(a)">
              <Icon name="square-dashed-mouse-pointer" :size="12" />点选
            </button>
          </div>
          <!-- pointingVector -->
          <div class="ar-row">
            <label class="ar-lab" title="pointingVector：该关节要指向目标时，节点局部系里朝向目标的那个方向（单轴对日等用；留空 = 无）">指向</label>
            <div class="md-v3 ar-pv">
              <NumIn v-for="k in [0, 1, 2]" :key="k" :model-value="a.pointingVector ? a.pointingVector[k] : null" allow-empty :disabled="ro" :sig="6" @commit="(v) => setPv(a, k, v)" />
            </div>
            <button class="lb-mini lb-mini-ico" :disabled="ro || !a.pointingVector" title="清除 pointingVector" @click="clearPv(a)"><Icon name="x" :size="12" /></button>
          </div>
          <!-- stages -->
          <div v-for="s in a.stages" :key="s.name" class="ar-st">
            <div class="ar-row">
              <input class="ci ar-sn" type="text" :value="s.name" :disabled="ro" spellcheck="false" data-i18n-skip title="stage 名（不含空白，本关节内唯一）"
                     @change="renameStage(a, s, $event.target.value); $event.target.value = s.name" @keydown.enter="$event.target.blur()" />
              <select class="ci ar-ty" :value="s.type" :disabled="ro" title="变换类型（节点局部系；角度为度、平移为模型单位）" @change="setType(a, s, $event.target.value)">
                <option v-for="t in STAGE_TYPE_LIST" :key="t" :value="t">{{ STAGE_LABEL[t] || t }}</option>
              </select>
              <input class="ar-sl" type="range" :min="s.minimumValue" :max="s.maximumValue" :step="stepOf(s)" :value="valOf(a, s)"
                     :title="'拖动驱动预览（' + s.minimumValue + ' … ' + s.maximumValue + '）'" @input="onSlide(a, s, $event.target.value)" />
              <span class="ar-v" data-i18n-skip>{{ fmtNum(valOf(a, s), 4) }}{{ stageUnit(s.type) }}</span>
            </div>
            <div class="ar-lim">
              <label title="最小值">最小</label><NumIn :model-value="s.minimumValue" :disabled="ro" :sig="6" @commit="(v) => setStage(a, s, 'minimumValue', v)" />
              <label title="最大值">最大</label><NumIn :model-value="s.maximumValue" :disabled="ro" :sig="6" @commit="(v) => setStage(a, s, 'maximumValue', v)" />
              <label title="初值（STK 加载模型时的位置；预览、缩略图、包围盒都按它）">初值</label><NumIn :model-value="s.initialValue" :disabled="ro" :sig="6" @commit="(v) => setStage(a, s, 'initialValue', v)" />
              <button class="lb-mini lb-mini-ico" :disabled="ro" title="把滑杆当前位置设为初值" @click="toInitial(a, s)"><Icon name="check" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" :disabled="ro || (a.stages || []).length <= 1" title="删除这个 stage" @click="removeStage(a, s)"><Icon name="trash" :size="12" /></button>
            </div>
          </div>
          <div v-if="!ro" class="md-acts"><button class="lb-mini" title="加一个 stage（按顺序右乘在前面的变换之后）" @click="addStage(a)"><Icon name="plus" :size="12" />加 stage</button></div>
        </div>
      </template>
    </template>
  </MdSec>
</template>

<style scoped>
.ar-none { text-align: left; padding: 2px 0; }
.ar { border: 1px solid var(--border); border-radius: var(--r-box); padding: 5px 7px 6px; display: flex; flex-direction: column; gap: 4px; }
.ar:hover { border-color: var(--border-strong); }
.ar-hd { display: flex; align-items: center; gap: 6px; }
.ar-hd .sp { flex: 1; }
.ar-name { flex: 1 1 120px; min-width: 0 !important; font-weight: 600; }
.ar-c { flex: none; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.ar-nodes { display: flex; flex-wrap: wrap; gap: 3px; }
.ar-chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; height: 18px; padding: 0 2px 0 6px; font-size: var(--fs-2); font-family: var(--font-mono);
  color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.ar-chip-t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ar-chip-x { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 2px; background: transparent; color: var(--text-faint); cursor: pointer; }
.ar-chip-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.ar-empty { font-size: var(--fs-2); color: var(--text-faint); }
.ar-row { display: flex; align-items: center; gap: 6px; }
.ar-add { flex: 1 1 auto; min-width: 0 !important; }
.ar-lab { flex: none; width: 30px; font-size: var(--fs-2); color: var(--text-muted); }
.ar-pv { min-width: 0; }
.ar-st { display: flex; flex-direction: column; gap: 2px; padding-top: 3px; border-top: 1px solid var(--lb-rule-soft); }
.ar-sn { flex: none !important; width: 78px; min-width: 0 !important; font-family: var(--font-mono); font-size: var(--fs-2); }
.ar-ty { flex: none !important; width: 78px; min-width: 0 !important; }
.ar-sl { flex: 1; min-width: 50px; }
.ar-v { flex: none; min-width: 52px; text-align: right; font-size: var(--fs-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.ar-lim { display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(0, 1fr) auto auto; align-items: center; gap: 3px 4px; }
.ar-lim label { font-size: var(--fs-1); color: var(--text-faint); }
</style>
