<script setup>
// 太阳翼组（AGI_stk_metadata.solarPanelGroups）：名称 / 效率 % / 节点 / 面积。选中行 = 预览高亮组内节点（及挂在组上的部件）。
// 「从太阳翼部件生成」：给还没进组的太阳翼部件各建一组（效率缺省 28 %，AGI 百分数口径），部件上记 solarGroup 维持关联
// （单网格模型的翼没有独立节点，组的 nodes 可能为空 —— W2 ④-3，关联靠部件）。
import { computed, inject, watch } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { num } from '../../shared/num.js'
import { uniqueName, fmtNum } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const groups = computed(() => { void cur.rev; return (m.value && Array.isArray(m.value.solarPanelGroups) ? m.value.solarPanelGroups : []).map((g) => ({ ...g, id: g.name })) })
const partsOf = (name) => (m.value && Array.isArray(m.value.parts) ? m.value.parts.filter((p) => p.solarGroup === name) : [])
const COLS = [
  { key: 'name', label: '名称', w: 110 },
  { key: 'eff', label: '效率', unit: '%', num: true, w: 58, tip: '光电转换效率（百分数，AGI_stk_metadata 口径）' },
  { key: 'nodes', label: '节点', num: true, w: 48, editable: false },
  { key: 'area', label: '面积', unit: 'm²', num: true, w: 66, editable: false, tip: '关联太阳翼部件的单面投影面积之和' }
]
function text(r, c) {
  if (c.key === 'name') return r.name
  if (c.key === 'eff') return fmtNum(r.efficiency, 4)
  if (c.key === 'nodes') return String((r.nodes || []).length)
  if (c.key === 'area') { const a = partsOf(r.name).reduce((s, p) => s + (p.areaM2 || 0), 0); return a ? fmtNum(a, 4) : '' }
  return ''
}
function onEdit(id, key, val) {
  wb.edit((x) => {
    const G = (x.solarPanelGroups || []).find((q) => q.name === id)
    if (!G) return
    if (key === 'name') {
      const s = String(val || '').trim().replace(/\s+/g, '_')
      if (!s || s === G.name) return
      const taken = new Set((x.solarPanelGroups || []).map((q) => q.name)); taken.delete(G.name)
      const nm = uniqueName(s, taken)
      for (const p of x.parts || []) if (p.solarGroup === G.name) p.solarGroup = nm
      G.name = nm
    } else if (key === 'eff') {
      const n = num(val)
      if (n != null) G.efficiency = Math.min(100, Math.max(0, n))
    }
  }, { undo: false })
}
const g = useGridSelect({
  gridId: 'md-solar', rows: () => groups.value, cols: () => COLS, cellText: text,
  cellRaw: (r, c) => (c.key === 'eff' ? String(r.efficiency ?? '') : text(r, c)),
  cellEditable: () => !ro.value, onEdit,
  onDeleteRows: (ids) => { const s = new Set(ids); let n = 0; wb.edit((x) => { const b = (x.solarPanelGroups || []).length; x.solarPanelGroups = (x.solarPanelGroups || []).filter((q) => !s.has(q.name)); n = b - x.solarPanelGroups.length; for (const p of x.parts || []) if (s.has(p.solarGroup)) delete p.solarGroup }, { undo: false }); return n },
  deletable: () => !ro.value,
  pushUndo: wb.pushUndo, dropUndo: wb.dropUndo, undo: wb.undo, redo: wb.redo
})
const cellClass = (r, c) => (c.num ? 'md-mono' : null)
watch(() => [g.rect.value.r0, g.rect.value.r1, cur.rev], () => {
  if (wb.st.tab !== 'model') return
  const r = g.rect.value
  const vp = getVp()
  if (!vp) return
  if (r.r0 < 0) { vp.highlightNodes(null); return }
  const sel = g.rows.value.slice(r.r0, r.r1 + 1)
  const nodes = [...new Set(sel.flatMap((q) => q.nodes || []))]
  vp.highlightNodes(nodes.length ? nodes : null)
  const pids = sel.flatMap((q) => partsOf(q.name).map((p) => p.id))
  if (pids.length) vp.highlightParts(pids)
})
const freeArrays = computed(() => (m.value && Array.isArray(m.value.parts) ? m.value.parts.filter((p) => p.role === 'solarArray' && !p.solarGroup) : []))
function fromParts() {
  wb.edit((x) => {
    const list = x.solarPanelGroups || (x.solarPanelGroups = [])
    const taken = new Set(list.map((q) => q.name))
    for (const p of x.parts || []) {
      if (p.role !== 'solarArray' || p.solarGroup) continue
      const name = uniqueName('SolarArray' + (list.length + 1), taken); taken.add(name)
      const nodes = [...new Set([...(p.nodes || []), ...((p.triRanges || []).filter((t) => !(p.nodes || []).length).map((t) => t.node))])]
      list.push({ name, nodes, efficiency: 28 })
      p.solarGroup = name
    }
  })
}
</script>

<template>
  <MdSec id="m-solar" title="太阳翼组" :count="groups.length || null">
    <template v-if="m">
      <div class="md-acts">
        <button class="lb-mini" :disabled="ro || !freeArrays.length" title="给还没进组的太阳翼部件各建一组（效率 28 %）" @click="fromParts"><Icon name="plus" :size="12" />从太阳翼部件生成</button>
        <button class="lb-mini" :disabled="ro || !g.canDelete.value || g.rect.value.r0 < 0" @click="g.deleteRows()"><Icon name="trash" :size="12" />删除</button>
      </div>
      <div class="md-grid short">
        <ExcelGrid :grid="g" :cols="COLS" :text="text" :cell-class="cellClass" :head-tip="(c) => c.tip || c.label" empty-text="没有太阳翼组。" />
      </div>
    </template>
  </MdSec>
</template>
