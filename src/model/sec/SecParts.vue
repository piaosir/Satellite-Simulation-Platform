<script setup>
// 部件（任务书 §5.4）：「自动识别」= segment.mjs autoSegment（Worker，全精度 lod0）→ 部件表。
// 表里：确认（勾选列）/ 名称 / 角色（枚举）/ 面积 / 法向 / 焦距 / 口径 / f/D / 拟合残差 rmsRel —— 反射面的 f/D 与残差摆出来，由用户确认
// （W2 ④-5：全语料 105/206 个文件有几何反射面，误判要人看）。选中行 = 预览高亮；「在预览中点选」点模型即选中所在部件；
// 右键：合并所选 / 按节点拆分。
import { ref, computed, inject, watch, nextTick, onBeforeUnmount } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { useCheckCol } from '../checkCol.js'
import { PART_ROLES } from '@core/models/ir.mjs'
import { mergeSegment, mergeParts, splitPartByNodes, partAtHit, ROLE_LABEL, fmtNum, fmtVec } from '../wbLogic.js'

const wb = inject('wb')
const getVp = inject('viewport')
const pick = inject('pick')
const hl = inject('hl')
const { cur } = wb
const m = computed(() => cur.meta)
const ro = computed(() => !cur.editable)
const parts = computed(() => { void cur.rev; return (m.value && Array.isArray(m.value.parts) ? m.value.parts : []) })
const rootOk = computed(() => { void cur.geomRev; return !!wb.currentRoot() && !(cur.kind === 'glb' && cur.lod !== 'lod0') })

// ============ 自动识别 ============
const busy = ref(false)
const segMs = ref(null)
const segErr = ref('')
async function autoSeg() {
  const root = wb.currentRoot()
  if (!root) return
  busy.value = true; segErr.value = ''
  const t0 = performance.now()
  try {
    const seg = await wb.analyzer.segment(root, wb.viewMeta())
    segMs.value = Math.round(performance.now() - t0)
    wb.edit((x) => {
      const n = mergeSegment(JSON.parse(JSON.stringify(x)), seg)
      x.parts = n.parts; x.attachPoints = n.attachPoints; x.solarPanelGroups = n.solarPanelGroups
    })
  } catch (e) { segErr.value = (e && e.message) || String(e) }
  finally { busy.value = false }
}

// ============ 表 ============
const ROLE_OPTS = PART_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] || r }))
// 列序：确认要看的（角色、f/D、残差）排在左栏可见范围内，面积 / 法向 / 焦距 / 口径往后放（横向滚动看）
const COLS = [
  { key: 'ok', label: '✓', w: 26, align: 'center', editable: false, tip: '已确认（点表头全选；空格翻转选中行）' },
  { key: 'name', label: '名称', w: 92 },
  { key: 'role', label: '角色', w: 54, options: ROLE_OPTS },
  { key: 'fd', label: 'f/D', num: true, w: 48, editable: false, tip: '反射面：抛物面拟合的焦距 / 口径' },
  { key: 'rms', label: '残差', unit: '%', num: true, w: 50, editable: false, tip: '抛物面拟合 RMS 残差 / 口径（< 0.5% 纯几何认定；0.5%–1.5% 需名称佐证）' },
  { key: 'D', label: '口径', unit: 'm', num: true, w: 52, editable: false, tip: '偏置口径面直径' },
  { key: 'f', label: '焦距', unit: 'm', num: true, w: 52, editable: false, tip: '抛物面拟合的焦距' },
  { key: 'area', label: '面积', unit: 'm²', num: true, w: 60, editable: false, tip: '太阳翼为单面投影面积，其余为表面积' },
  { key: 'normal', label: '法向', w: 92, editable: false, tip: '平面部件的法向（本体系）' },
  { key: 'src', label: '依据', w: 50, editable: false, tip: '几何识别 · 节点名 · 材质分组 · 剩余' }
]
const SRC_LABEL = { geometry: '几何', node: '节点', material: '材质', rest: '剩余', param: '参数化' }
function text(r, c) {
  const f = r.fitted
  switch (c.key) {
    case 'ok': return r.confirmed ? '✓' : ''
    case 'name': return r.name || r.id
    case 'role': return ROLE_LABEL[r.role] || r.role || ''
    case 'area': return Number.isFinite(r.areaM2) ? fmtNum(r.areaM2, 4) : ''
    case 'normal': return Array.isArray(r.normalBody) ? fmtVec(r.normalBody, 2) : ''
    case 'f': return f ? fmtNum(f.focalM, 4) : ''
    case 'D': return f ? fmtNum(f.diameterM, 4) : ''
    case 'fd': return f && f.diameterM ? fmtNum(f.focalM / f.diameterM, 3) : ''
    case 'rms': return f && Number.isFinite(f.rmsRel) ? fmtNum(f.rmsRel * 100, 3) : ''
    case 'src': return SRC_LABEL[r.source] || r.source || ''
  }
  return ''
}
function onEdit(id, key, val) {
  wb.edit((x) => {
    const p = (x.parts || []).find((q) => q.id === id)
    if (!p) return
    if (key === 'name') { const s = String(val || '').trim(); if (s) p.name = s }
    else if (key === 'role') {
      const r = PART_ROLES.includes(val) ? val : (ROLE_OPTS.find((o) => o.label === val) || {}).value
      if (r) { p.role = r; p.roleManual = true }
    }
  }, { undo: false })
}
const g = useGridSelect({
  gridId: 'md-parts', rows: () => parts.value, cols: () => COLS, cellText: text,
  cellRaw: (r, c) => (c.key === 'role' ? r.role : text(r, c)),
  cellEditable: () => !ro.value,
  onEdit,
  onDeleteRows: (ids) => { const s = new Set(ids); let n = 0; wb.edit((x) => { const before = (x.parts || []).length; x.parts = (x.parts || []).filter((p) => !s.has(p.id)); n = before - x.parts.length }, { undo: false }); return n },
  deletable: () => !ro.value,
  pushUndo: wb.pushUndo, dropUndo: wb.dropUndo, undo: wb.undo, redo: wb.redo
})
const cellClass = (r, c) => {
  if (c.key === 'ok') return r.confirmed ? 'md-chk on' : 'md-chk'
  if (c.key === 'rms' && r.fitted && r.fitted.rmsRel > 0.005) return 'md-mono md-dim'
  return c.num ? 'md-mono' : null
}
const chk = useCheckCol(g, {
  key: 'ok', cols: () => COLS, rows: () => parts.value,
  isOn: (r) => !!r.confirmed,
  set: (r, on) => { if (ro.value) return; wb.edit((x) => { const p = (x.parts || []).find((q) => q.id === r.id); if (p) { if (on) p.confirmed = true; else delete p.confirmed } }) },
  setAll: (on) => { if (ro.value) return; wb.edit((x) => { for (const p of x.parts || []) { if (on) p.confirmed = true; else delete p.confirmed } }) }
})
function menuItems({ rows }) {
  if (ro.value) return []
  const ids = rows.map((r) => r.id)
  const one = rows.length === 1 ? rows[0] : null
  const nNodes = one ? new Set([...(one.nodes || []), ...((one.triRanges || []).map((t) => t.node))]).size : 0
  return [
    { key: 'merge', label: '合并所选', dis: rows.length < 2, run: () => wb.edit((x) => { x.parts = mergeParts(JSON.parse(JSON.stringify(x.parts || [])), ids) }) },
    { key: 'split', label: '按节点拆分', dis: !one || nNodes < 2, run: () => wb.edit((x) => { x.parts = splitPartByNodes(JSON.parse(JSON.stringify(x.parts || [])), one.id) }) }
  ]
}

// ============ 选中 ↔ 预览高亮 ============
watch(() => [g.rect.value.r0, g.rect.value.r1, cur.rev], () => {
  if (wb.st.tab !== 'model') return
  const r = g.rect.value
  const ids = r.r0 < 0 ? [] : g.rows.value.slice(r.r0, r.r1 + 1).map((p) => p.id)
  hl.parts.value = ids
  const vp = getVp()
  if (vp) vp.highlightParts(ids.length ? ids : null)
})
const picking = computed(() => pick.owner.value === 'parts')
function togglePick() {
  if (picking.value) { pick.stop('parts'); return }
  pick.start('parts', 'select', (hit) => {
    const p = hit ? partAtHit(parts.value, hit) : null
    if (!p) return
    const ri = g.rows.value.findIndex((x) => x.id === p.id)
    if (ri < 0) return
    g.sel.value = { ar: ri, ac: 1, ri, ci: 1 }
    nextTick(() => g.ensureVisible())
  })
}
onBeforeUnmount(() => pick.stop('parts'))
const byRole = computed(() => {
  const n = {}
  for (const p of parts.value) n[p.role] = (n[p.role] || 0) + 1
  return ['solarArray', 'reflector', 'feed', 'bus'].filter((k) => n[k]).map((k) => `${ROLE_LABEL[k]} ${n[k]}`).join(' · ')
})
</script>

<template>
  <MdSec id="m-parts" title="部件" :count="parts.length || null" :summary="byRole">
    <template v-if="m">
      <div class="md-acts">
        <button class="lb-mini primary" :disabled="ro || !rootOk || busy" title="材质分组 → 节点 → 连通分量 + 平面聚类（太阳翼）→ 抛物面拟合（反射面，自动挂点）；在后台线程跑，全精度 lod0" @click="autoSeg">
          <Icon name="scan-eye" :size="13" />{{ busy ? '识别中…' : '自动识别' }}
        </button>
        <button class="lb-mini" :class="{ on: picking }" :disabled="!rootOk || !parts.length" title="在预览里点模型，选中它所在的部件" @click="togglePick">
          <Icon name="square-dashed-mouse-pointer" :size="13" />在预览中点选
        </button>
        <span class="sp"></span>
        <span v-if="segMs != null" class="md-state" data-i18n-skip>{{ segMs }} ms</span>
      </div>
      <div v-if="segErr" class="md-state bad" data-i18n-skip>{{ segErr }}</div>
      <div class="md-grid tall" @click.capture="chk.onClickCapture" @keydown.capture="chk.onKeyCapture">
        <ExcelGrid :grid="g" :cols="COLS" :text="text" :cell-class="cellClass" :menu-items="menuItems"
                   :head-tip="(c) => c.tip || c.label" empty-text="还没有部件。" />
      </div>
    </template>
  </MdSec>
</template>
