<script setup>
// 不遮挡节点（AGI noObscuration）：算本体遮挡掩模（二期「分析」页）时整节点不参与射线求交 —— 天线自己的反射面、
// 馈源支架、会随关节转开的太阳翼这类「挡不到自己视线」或「只挡一瞬」的件在这里勾掉。
// 节点表按 IR 名（irLayout：与导出件节点名、部件 nodes 同一口径）；选中行 = 预览里高亮该节点。
import { ref, computed, inject, watch, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { irLayout } from '../../viz/models/irToThree.js'
import { useCheckCol } from '../checkCol.js'
import { normText, ROLE_LABEL, fmtInt } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)

// 节点表：随几何换（geomRev）重算；IR 名唯一，直接当行键
const layout = computed(() => {
  void cur.geomRev
  const root = wb.currentRoot()
  if (!root) return []
  const all = irLayout(root)
  // 三角形数含子树：先序表里子节点恒在父节点之后，倒序一遍把自己的和加给父节点即可
  const sums = all.map((e) => (e.mesh ? e.mesh.count / 3 : 0))
  for (let i = all.length - 1; i >= 0; i--) { const p = all[i].parent; if (p >= 0) sums[p] += sums[i] }
  const sceneRoot = !!(root.isScene || (root.userData && root.userData.__sceneRoot))
  const out = []
  all.forEach((e, i) => {
    if (e.isRoot && sceneRoot) return   // 场景根不是模型节点（导出时被摊平）
    out.push({ id: e.name, name: e.name, subtree: sums[i] })
  })
  return out
})
const partOf = computed(() => {
  void cur.rev
  const mp = new Map()
  for (const p of (m.value && Array.isArray(m.value.parts) ? m.value.parts : [])) {
    for (const n of Array.isArray(p.nodes) ? p.nodes : []) if (!mp.has(n)) mp.set(n, p)
    for (const t of Array.isArray(p.triRanges) ? p.triRanges : []) if (t && t.node && !mp.has(t.node)) mp.set(t.node, p)
  }
  return mp
})
const noObs = computed(() => { void cur.rev; return new Set(m.value && Array.isArray(m.value.noObscurationNodes) ? m.value.noObscurationNodes : []) })

const q = ref('')
const onlyOn = ref(false)
const rows = computed(() => {
  const nq = normText(q.value)
  return layout.value.filter((r) => (!onlyOn.value || noObs.value.has(r.name)) && (!nq || normText(r.name).includes(nq) || normText((partOf.value.get(r.name) || {}).name).includes(nq)))
})
const COLS = [
  { key: 'chk', label: '', w: 28, align: 'center', tip: '勾选 = 不参与本体遮挡计算（点表头全选当前列表；空格翻转选中行）' },
  { key: 'name', label: '节点', w: 170 },
  { key: 'tris', label: '三角形', num: true, w: 70, tip: '含子节点' },
  { key: 'part', label: '部件', w: 100 },
  { key: 'role', label: '角色', w: 60 }
]
function text(r, c) {
  if (c.key === 'chk') return noObs.value.has(r.name) ? '✓' : ''
  if (c.key === 'name') return r.name
  if (c.key === 'tris') return fmtInt(r.subtree)
  const p = partOf.value.get(r.name)
  if (c.key === 'part') return p ? (p.name || p.id) : ''
  if (c.key === 'role') return p ? (ROLE_LABEL[p.role] || p.role || '') : ''
  return ''
}
const g = useGridSelect({ gridId: 'md-noobs', rows: () => rows.value, cols: () => COLS, readOnly: true, cellText: text,
  sortValue: (r, c) => (c.key === 'tris' ? r.subtree : text(r, c)) })
const cellClass = (r, c) => (c.key === 'chk' ? (noObs.value.has(r.name) ? 'md-chk on' : 'md-chk') : c.key === 'tris' ? 'md-mono' : (c.key === 'part' || c.key === 'role') ? 'md-dim' : null)
function setNodes(names, on) {
  if (ro.value || !names.length) return
  wb.edit((x) => {
    const s = new Set(Array.isArray(x.noObscurationNodes) ? x.noObscurationNodes : [])
    for (const n of names) on ? s.add(n) : s.delete(n)
    // 按节点表的先序排（稳定、与导出件节点顺序一致）
    const order = new Map(layout.value.map((r, i) => [r.name, i]))
    x.noObscurationNodes = [...s].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9))
  })
}
const chk = useCheckCol(g, {
  cols: () => COLS, rows: () => rows.value,
  isOn: (r) => noObs.value.has(r.name),
  set: (r, on) => setNodes([r.name], on),
  setAll: (on) => setNodes(rows.value.map((r) => r.name), on)
})
// 按部件角色一次勾上（反射面 / 馈源 / 太阳翼）
const ROLE_PICK = ['reflector', 'feed', 'solarArray', 'boom', 'sensor']
const roleNodes = (role) => {
  const out = []
  for (const r of layout.value) { const p = partOf.value.get(r.name); if (p && p.role === role) out.push(r.name) }
  return out
}
const rolesAvail = computed(() => ROLE_PICK.filter((k) => roleNodes(k).length))
function pickRole(role) { if (role) setNodes(roleNodes(role), true) }

// 选中 → 预览高亮
watch(() => [g.rect.value.r0, g.rect.value.r1], () => {
  if (wb.st.tab !== 'model') return
  const r = g.rect.value
  const vp = getVp()
  if (!vp) return
  const names = r.r0 < 0 ? [] : g.rows.value.slice(r.r0, r.r1 + 1).map((x) => x.name)
  vp.highlightNodes(names.length ? names : null)
})
onBeforeUnmount(() => { const vp = getVp(); if (vp) vp.highlightNodes(null) })
const nOn = computed(() => noObs.value.size)
</script>

<template>
  <MdSec id="m-noobs" title="不遮挡节点" :count="nOn || null" :default-open="false"
         tip="AGI noObscuration：本体遮挡掩模计算时不参与求交的节点（天线自身的反射面、馈源支架等）">
    <template v-if="m">
      <div v-if="!layout.length" class="lb-placeholder ob-none">没有节点。</div>
      <template v-else>
        <div class="md-acts">
          <label class="ob-q">
            <Icon name="search" :size="12" />
            <input v-model="q" type="text" spellcheck="false" placeholder="筛选" title="按节点名 / 部件名筛选" />
          </label>
          <select class="ci ob-role" value="" :disabled="ro || !rolesAvail.length" title="把某一角色部件的全部节点勾为不遮挡" @change="pickRole($event.target.value); $event.target.value = ''">
            <option value="">按角色勾选</option>
            <option v-for="k in rolesAvail" :key="k" :value="k">{{ ROLE_LABEL[k] }}</option>
          </select>
          <button class="lb-mini" :class="{ on: onlyOn }" title="只列已勾选的节点" @click="onlyOn = !onlyOn"><Icon name="check" :size="12" />已勾选</button>
        </div>
        <div class="md-grid" @click.capture="chk.onClickCapture" @keydown.capture="chk.onKeyCapture">
          <ExcelGrid :grid="g" :cols="COLS" :text="text" :cell-class="cellClass" :head-tip="(c) => c.tip || c.label" empty-text="没有匹配的节点。" />
        </div>
      </template>
    </template>
  </MdSec>
</template>

<style scoped>
.ob-none { text-align: left; padding: 2px 0; }
.ob-q { flex: 1 1 120px; min-width: 0; display: flex; align-items: center; gap: 4px; height: var(--h-ctl); padding: 0 6px; color: var(--text-faint);
  background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl); }
.ob-q:focus-within { border-color: var(--accent-ui); }
.ob-q input { flex: 1; min-width: 0; height: 100%; border: 0 !important; background: transparent !important; outline: none; padding: 0 !important; box-shadow: none !important; font-size: var(--fs-3); color: var(--text); }
.ob-role { flex: none !important; width: 104px; min-width: 0 !important; }
</style>
