<script setup>
// 挂点（AGI attach point；任务书 §5.5）：表格编辑位置 / 视轴 / 上向（本体系），「在预览中点选」点表面新增（命中点为位置、
// 面法向为视轴、上向按二期契约 D1：本体 −Y 在视轴法平面的投影，退化取 +X —— bodyFrame.defaultUpBody），复制 / 删除。
// 选中行 = 预览里该挂点换色放大并画上向。
import { computed, inject, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { defaultUpBody, isUpDegenerate } from '@core/models/bodyFrame.mjs'
import { num } from '../../shared/num.js'
import { uniqueName, fmtNum } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const pick = inject('pick')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const aps = computed(() => { void cur.rev; return (m.value && Array.isArray(m.value.attachPoints) ? m.value.attachPoints : []).map((a) => ({ ...a, id: a.name })) })
const rootOk = computed(() => { void cur.geomRev; return !!wb.currentRoot() && !(cur.kind === 'glb' && cur.lod !== 'lod0') })

const V = (k, i) => ({ k, i })
const COLS = [
  { key: 'name', label: '名称', w: 116 },
  { key: 'px', label: 'X', unit: 'm', num: true, w: 56, tip: '位置（本体系）' },
  { key: 'py', label: 'Y', unit: 'm', num: true, w: 56 },
  { key: 'pz', label: 'Z', unit: 'm', num: true, w: 56 },
  { key: 'dx', label: '视轴 x', num: true, w: 54, tip: '视轴单位矢量（本体系；改完自动归一）' },
  { key: 'dy', label: '视轴 y', num: true, w: 54 },
  { key: 'dz', label: '视轴 z', num: true, w: 54 },
  { key: 'ux', label: '上向 x', num: true, w: 54, tip: '上向（天线 +y）；缺省 = 本体 −Y 在视轴法平面的投影' },
  { key: 'uy', label: '上向 y', num: true, w: 54 },
  { key: 'uz', label: '上向 z', num: true, w: 54 },
  { key: 'node', label: '节点', w: 90, editable: false, tip: '挂点所在的模型节点（导入件的 attach point 节点；导出时自由挂点另建空节点）' }
]
const MAP = { px: V('posBody', 0), py: V('posBody', 1), pz: V('posBody', 2), dx: V('dirBody', 0), dy: V('dirBody', 1), dz: V('dirBody', 2), ux: V('upBody', 0), uy: V('upBody', 1), uz: V('upBody', 2) }
function text(r, c) {
  if (c.key === 'name') return r.name
  if (c.key === 'node') return r.node || ''
  const mp = MAP[c.key]
  const v = mp && Array.isArray(r[mp.k]) ? r[mp.k][mp.i] : null
  return v == null ? '' : fmtNum(v, mp.k === 'posBody' ? 4 : 3)
}
function norm(v) { const n = Math.hypot(v[0], v[1], v[2]); return n > 1e-12 ? v.map((x) => x / n) : null }
function onEdit(id, key, val) {
  wb.edit((x) => {
    const a = (x.attachPoints || []).find((q) => q.name === id)
    if (!a) return
    if (key === 'name') {
      const s = String(val || '').trim().replace(/\s+/g, '_')
      if (!s || s === a.name) return
      const taken = new Set((x.attachPoints || []).map((q) => q.name))
      taken.delete(a.name)
      a.name = uniqueName(s, taken)
      return
    }
    const mp = MAP[key]
    const n = num(val)
    if (!mp || n == null) return
    const v = Array.isArray(a[mp.k]) ? a[mp.k].slice() : (mp.k === 'posBody' ? [0, 0, 0] : [0, 0, 1])
    v[mp.i] = n
    if (mp.k === 'posBody') { a.posBody = v; return }
    const u = norm(v)
    if (!u) return
    if (mp.k === 'dirBody') {
      a.dirBody = u
      if (!Array.isArray(a.upBody) || isUpDegenerate(u, a.upBody)) a.upBody = defaultUpBody(u)
    } else {
      a.upBody = isUpDegenerate(a.dirBody || [0, 0, 1], u) ? defaultUpBody(a.dirBody || [0, 0, 1]) : u
    }
  }, { undo: false })
}
const g = useGridSelect({
  gridId: 'md-aps', rows: () => aps.value, cols: () => COLS, cellText: text,
  // 编辑 / 复制取全精度（显示只留 4 位有效数字，改一格不许把别的位数截掉）
  cellRaw: (r, c) => { if (c.key === 'name' || c.key === 'node') return text(r, c); const mp = MAP[c.key]; const v = mp && Array.isArray(r[mp.k]) ? r[mp.k][mp.i] : null; return v == null ? '' : String(v) },
  cellEditable: () => !ro.value, onEdit,
  onDeleteRows: (ids) => { const s = new Set(ids); let n = 0; wb.edit((x) => { const b = (x.attachPoints || []).length; x.attachPoints = (x.attachPoints || []).filter((a) => !s.has(a.name)); n = b - x.attachPoints.length }, { undo: false }); return n },
  deletable: () => !ro.value,
  pushUndo: wb.pushUndo, dropUndo: wb.dropUndo, undo: wb.undo, redo: wb.redo
})
const cellClass = (r, c) => (c.num ? 'md-mono' : (c.key === 'node' ? 'md-dim' : null))

// 选中 → 预览高亮
watch(() => [g.rect.value.r0, g.rect.value.r1, cur.rev], () => {
  if (wb.st.tab !== 'model') return
  const r = g.rect.value
  const row = r.r0 >= 0 && r.r0 === r.r1 ? g.rows.value[r.r0] : null
  const vp = getVp()
  if (vp) vp.setAttachHighlight(row ? row.name : null)
})

// 在预览中点选新增
const picking = computed(() => pick.owner.value === 'attach')
function togglePick() {
  if (picking.value) { pick.stop('attach'); return }
  pick.start('attach', 'surface', (hit) => {
    if (!hit) return
    const dir = norm(hit.normalBody) || [0, 0, 1]
    let name = ''
    wb.edit((x) => {
      const list = Array.isArray(x.attachPoints) ? x.attachPoints : (x.attachPoints = [])
      name = uniqueName('AP_' + (list.length + 1), new Set(list.map((a) => a.name)))
      list.push({ name, posBody: hit.pointBody.map((v) => +v.toFixed(6)), dirBody: dir.map((v) => +v.toFixed(6)), upBody: defaultUpBody(dir) })
    })
    nextTick(() => {
      const ri = g.rows.value.findIndex((a) => a.name === name)
      if (ri >= 0) { g.sel.value = { ar: ri, ac: 0, ri, ci: 0 }; nextTick(() => g.ensureVisible()) }
    })
  })
}
function duplicate() {
  const r = g.rect.value
  if (r.r0 < 0) return
  const rows = g.rows.value.slice(r.r0, r.r1 + 1)
  wb.edit((x) => {
    const list = x.attachPoints || (x.attachPoints = [])
    const taken = new Set(list.map((a) => a.name))
    for (const a of rows) {
      const c = JSON.parse(JSON.stringify(a)); delete c.id; delete c.node
      c.name = uniqueName(a.name + '_copy', taken); taken.add(c.name)
      list.push(c)
    }
  })
}
function menuItems({ rows }) {
  if (ro.value) return []
  return [{ key: 'dup', label: '复制所选挂点', dis: !rows.length, run: duplicate }]
}
onBeforeUnmount(() => pick.stop('attach'))
</script>

<template>
  <MdSec id="m-attach" title="挂点" :count="aps.length || null">
    <template v-if="m">
      <div class="md-acts">
        <button class="lb-mini" :class="{ on: picking }" :disabled="ro || !rootOk" title="在预览里点模型表面新增挂点：命中点为位置、面法向为视轴" @click="togglePick">
          <Icon name="locate-fixed" :size="13" />在预览中点选
        </button>
        <button class="lb-mini" :disabled="ro || g.rect.value.r0 < 0" title="复制所选挂点" @click="duplicate"><Icon name="copy" :size="13" />复制</button>
        <button class="lb-mini" :disabled="ro || !g.canDelete.value || g.rect.value.r0 < 0" title="删除所选挂点" @click="g.deleteRows()"><Icon name="trash" :size="13" />删除</button>
      </div>
      <div class="md-grid">
        <ExcelGrid :grid="g" :cols="COLS" :text="text" :cell-class="cellClass" :menu-items="menuItems" :head-tip="(c) => c.tip || c.label" empty-text="还没有挂点。" />
      </div>
    </template>
  </MdSec>
</template>
