<script setup>
// 卫星页「挂点」（任务书 §6.1、DESIGN2 §3）：卫星绑定上的天线安装位——引用模型的 attach point（几何来源，可空）+ 本体系位姿 +
// 视场 + 万向节 + 天线引用 + 排除节点。表格口径与换算在 mountLogic.js；预览里的圆盘 / 视轴射线 / 视场锥由 useSatViewport 画，
// 点圆盘 = 选中那一行。
// 新增的五条路：空白一行 · 从模型 attach point（单个或全部）· 在预览里点表面（命中点为位置、面法向为视轴）· 从模板套用（追加 / 替换）·
// JSON 导入；另有复制、删除、JSON 导出。
import { ref, computed, inject, watch, nextTick, onBeforeUnmount, onMounted, onActivated } from 'vue'
import Icon from '../../components/Icon.vue'
import ExcelGrid from '../../components/ExcelGrid.vue'
import MdSec from '../MdSec.vue'
import { useGridSelect } from '../../viz/grd/useGridSelect.js'
import { MOUNT_COLS, mountRow, cellText, applyMountEdit, mountFromAttachPoint, mountFromHit, blankMount, duplicateMounts,
  templateOptions, applyTemplate, mountsToJson, mountsFromJson, antennaOptions, isDefaultAttitude, GIMBAL_LABEL } from '../mountLogic.js'
import { grdTreeSats, lbLibrarySats } from '../satSources.js'

const wb = inject('wb')
const sat = inject('sat')
const getVp = inject('viewport')
const S = sat.st
const { cur } = wb
const api = typeof window !== 'undefined' ? window.api : null

// ── 天线引用的选项（GRD 树天线 + 链路预算卫星库 + 参数化）──
const antOpts = ref(antennaOptions({}))
async function loadAnt() {
  let grdSats = [], lbSats = []
  try { grdSats = grdTreeSats() } catch { grdSats = [] }
  try { lbSats = await lbLibrarySats() } catch { lbSats = [] }
  antOpts.value = antennaOptions({ grdSats, lbSats })
}
onMounted(loadAnt)
onActivated(loadAnt)

// ── 模型的 attach point（下拉 / 套用）──
const aps = computed(() => { void cur.rev; return cur.meta && Array.isArray(cur.meta.attachPoints) ? cur.meta.attachPoints.filter((a) => a && a.name && Array.isArray(a.posBody)) : [] })
const parts = computed(() => { void cur.rev; return cur.meta && Array.isArray(cur.meta.parts) ? cur.meta.parts : [] })
const apOpts = computed(() => [{ value: '', label: '（自由挂点）' }, ...aps.value.map((a) => ({ value: a.name, label: a.name }))])

const COLS = computed(() => MOUNT_COLS.map((c) => {
  if (c.key === 'attachPoint') return { ...c, options: () => apOpts.value }
  if (c.key === 'gimbal') return { ...c, options: Object.keys(GIMBAL_LABEL).map((k) => ({ value: k, label: GIMBAL_LABEL[k] })) }
  if (c.key === 'antenna') return { ...c, options: () => antOpts.value }
  return c
}))
const rows = computed(() => { void S.rev; return sat.mounts.value.map((m) => mountRow(m, antOpts.value)) })
const text = (r, c) => cellText(r, c)
const ro = computed(() => !S.binding)

function onEdit(id, key, val) {
  sat.edit((b) => {
    const i = b.mounts.findIndex((m) => m.id === id)
    if (i < 0) return
    const col = MOUNT_COLS.find((c) => c.key === key)
    let v = val
    if (col && col.num) { const s = String(val == null ? '' : val).trim().replace(/[，]/g, '.').replace(/[－−]/g, '-'); v = s === '' ? null : Number(s) }
    // 天线列：粘贴 / 填充柄写进来的是显示名，按选项名与本表别的行认回引用（antennaFromText；认不出不写）
    const nm = applyMountEdit(b.mounts[i], key, v, { attachPoints: aps.value, parts: parts.value, antOptions: antOpts.value, mounts: b.mounts })
    if (nm) b.mounts.splice(i, 1, nm)
  }, { undo: false })
}
const g = useGridSelect({
  gridId: 'md-mounts', rows: () => rows.value, cols: () => COLS.value, cellText: text,
  cellRaw: (r, c) => (c.num ? (r[c.key] == null ? '' : String(r[c.key])) : text(r, c)),
  cellEditable: () => !ro.value, onEdit,
  onDeleteRows: (ids) => { const s = new Set(ids); let n = 0; sat.edit((b) => { const k = b.mounts.length; b.mounts = b.mounts.filter((m) => !s.has(m.id)); n = k - b.mounts.length }, { undo: false }); return n },
  deletable: () => !ro.value,
  pushUndo: sat.pushUndo, dropUndo: sat.dropUndo, undo: sat.undo, redo: sat.redo
})
const cellClass = (r, c) => (c.num ? 'md-mono' : (c.key === 'attachPoint' && !r.attachPoint ? 'md-dim' : null))
const cellTip = (r, c) => (c.key === 'antenna' ? r.antenna : (c.key === 'attachPoint' ? (r.attachPoint || '自由挂点') : null))

// 表格选中 ⇄ 预览选中
watch(() => [g.rect.value.r0, g.rect.value.r1], () => {
  const r = g.rect.value
  const row = r.r0 >= 0 && r.r0 === r.r1 ? g.rows.value[r.r0] : null
  if (row && row.id !== S.mountSel) S.mountSel = row.id
})
watch(() => S.mountSel, (id) => {
  const ri = g.rows.value.findIndex((x) => x.id === id)
  const r = g.rect.value
  if (ri >= 0 && !(r.r0 === ri && r.r1 === ri)) { g.sel.value = { ar: ri, ac: Math.max(0, g.sel.value.ac), ri, ci: Math.max(0, g.sel.value.ci) }; nextTick(() => g.ensureVisible && g.ensureVisible()) }
})
function selectNew(id) { S.mountSel = id; nextTick(() => { const ri = g.rows.value.findIndex((x) => x.id === id); if (ri >= 0) { g.sel.value = { ar: ri, ac: 0, ri, ci: 0 }; nextTick(() => g.ensureVisible && g.ensureVisible()) } }) }

// ── 新增 ──
const takenIds = () => new Set(sat.mounts.value.map((m) => m.id))
function addBlank() { const m = blankMount(takenIds()); sat.edit((b) => { b.mounts.push(m) }); selectNew(m.id) }
function addFromAp(name) {
  if (!name) return
  const list = name === '*' ? aps.value : aps.value.filter((a) => a.name === name)
  if (!list.length) return
  let last = ''
  sat.edit((b) => {
    const taken = new Set(b.mounts.map((m) => m.id))
    for (const a of list) { const m = mountFromAttachPoint(a, taken, parts.value); taken.add(m.id); b.mounts.push(m); last = m.id }
  })
  if (last) selectNew(last)
}
const tplOpts = templateOptions()
const tplMsg = ref('')
function addTemplate(id, mode) {
  if (!id) return
  const r = applyTemplate(id, sat.mounts.value, aps.value, mode, parts.value)
  if (!r) return
  sat.edit((b) => {
    b.mounts = r.mounts
    // 模板建议的姿态律：只在还是缺省 nadir 时带上（用户改过的不覆盖）
    if (r.attitude && isDefaultAttitude(b.attitude)) b.attitude = JSON.parse(JSON.stringify(r.attitude))
  })
  tplMsg.value = r.unmatched.length ? `${r.matched.length} / ${r.matched.length + r.unmatched.length}` : ''
  if (r.mounts.length) selectNew(r.mounts[r.mounts.length - 1].id)
}
// 预览里点表面新增
const picking = ref(false)
function togglePick() {
  const vp = getVp()
  if (!vp) return
  if (picking.value) { vp.pickMode(null); picking.value = false; return }
  picking.value = true
  vp.pickMode('surface', (hit) => {
    if (!hit) return
    const m = mountFromHit(hit, takenIds())
    sat.edit((b) => { b.mounts.push(m) })
    selectNew(m.id)
  })
}
function stopPick() { if (picking.value) { const vp = getVp(); if (vp) vp.pickMode(null); picking.value = false } }
onBeforeUnmount(stopPick)
watch(() => wb.st.tab, (t) => { if (t !== 'sat') stopPick() })

// ── 复制 / 删除 / JSON ──
function selIds() { const r = g.rect.value; return r.r0 < 0 ? [] : g.rows.value.slice(r.r0, r.r1 + 1).map((x) => x.id) }
function duplicate() { const ids = selIds(); if (!ids.length) return; sat.edit((b) => { b.mounts = duplicateMounts(b.mounts, ids) }) }
function menuItems({ rows: rs }) {
  if (ro.value) return []
  return [{ key: 'dup', label: '复制所选挂点', dis: !rs.length, run: duplicate }]
}
const jsonMsg = ref(''), jsonBad = ref(false), attKept = ref(false)
async function exportJson() {
  if (!api || !api.exportFile) return
  const name = String(S.label || 'mounts').replace(/[\\/:*?"<>|]+/g, '_') + '_挂点.json'
  const r = await api.exportFile({ defaultName: name, data: mountsToJson(sat.mounts.value, { satKey: S.satKey, attitude: S.binding ? S.binding.attitude : undefined }), filters: [{ name: 'JSON', extensions: ['json'] }] })
  if (r && r.ok) { jsonMsg.value = '已导出。'; jsonBad.value = false; attKept.value = false }
}
const fileEl = ref(null)
function importJson() { if (fileEl.value) { fileEl.value.value = ''; fileEl.value.click() } }
async function onFile(e) {
  const f = e.target.files && e.target.files[0]
  if (!f) return
  let text = ''
  try { text = await f.text() } catch (err) { jsonMsg.value = String((err && err.message) || err); jsonBad.value = true; return }
  const r = mountsFromJson(text, sat.mounts.value.map((m) => m.id))
  if (!r.mounts) { jsonMsg.value = r.errors[0] || '读不出挂点。'; jsonBad.value = true; return }
  // 整条绑定 / 导出件带着姿态律：与模板套用同一口径 —— 当前还是缺省 nadir 才采用，用户改过的不覆盖（不覆盖时状态行报一句）
  let attSkipped = false
  sat.edit((b) => {
    b.mounts = b.mounts.concat(r.mounts)
    if (r.attitude && JSON.stringify(r.attitude) !== JSON.stringify(b.attitude)) {
      if (isDefaultAttitude(b.attitude)) b.attitude = JSON.parse(JSON.stringify(r.attitude))
      else attSkipped = true
    }
  })
  jsonMsg.value = r.errors.slice(0, 2).join('；')
  jsonBad.value = !!r.errors.length
  attKept.value = attSkipped
  if (r.mounts.length) selectNew(r.mounts[r.mounts.length - 1].id)
}
// 换星：上一颗星的导入 / 套用状态不跟过来
watch(() => S.satKey, () => { jsonMsg.value = ''; jsonBad.value = false; attKept.value = false; tplMsg.value = '' })
</script>

<template>
  <MdSec id="s-mounts" title="挂点" :count="rows.length || null" tip="天线安装位（本体系：+X 速度、+Z 天底）。视轴 az / el 与掩模图同一口径；滚转 = 上向相对缺省上向（本体 −Y 投影）绕视轴的右手角">
    <template v-if="S.binding">
      <div class="md-acts">
        <button class="lb-mini" title="空白挂点（原点、视轴天底）" @click="addBlank"><Icon name="plus" :size="13" />新增</button>
        <select class="ci sm-ap" value="" :disabled="!aps.length" title="从模型的 attach point 套用（位置 / 视轴 / 上向取挂点）" @change="addFromAp($event.target.value); $event.target.value = ''">
          <option value="">从 attach point…</option>
          <option v-if="aps.length > 1" value="*">全部（{{ aps.length }}）</option>
          <option v-for="a in aps" :key="a.name" :value="a.name" data-i18n-skip>{{ a.name }}</option>
        </select>
        <button class="lb-mini" :class="{ on: picking }" :disabled="!cur.meta" title="在预览里点模型表面新增挂点：命中点为位置、面法向为视轴" @click="togglePick">
          <Icon name="locate-fixed" :size="13" />点表面
        </button>
      </div>
      <div class="md-acts">
        <select class="ci sm-tpl" value="" title="从模板套用（示意挂点：TDRS / GOES / SSL-1300 / 默认卫星 / Landsat 8 / 3U 立方星；同名 attach point 的位姿以当前模型为准），追加到表尾" @change="addTemplate($event.target.value, 'append'); $event.target.value = ''">
          <option value="">从模板套用…</option>
          <option v-for="t in tplOpts" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
        <select class="ci sm-tpl" value="" title="用模板替换全部挂点" @change="addTemplate($event.target.value, 'replace'); $event.target.value = ''">
          <option value="">替换为模板…</option>
          <option v-for="t in tplOpts" :key="t.id" :value="t.id">{{ t.label }}</option>
        </select>
        <span v-if="tplMsg" class="md-state warn" title="模板里引用的 attach point 在当前模型里有几个对得上（没对上的按模板位置放、attach point 置空）" data-i18n-skip>{{ tplMsg }}</span>
      </div>
      <div class="md-grid tall">
        <ExcelGrid :grid="g" :cols="COLS" :text="text" :cell-class="cellClass" :cell-tip="cellTip" :menu-items="menuItems" :head-tip="(c) => c.tip || c.label" empty-text="还没有挂点。" />
      </div>
      <div class="md-acts">
        <button class="lb-mini" :disabled="g.rect.value.r0 < 0" title="复制所选挂点" @click="duplicate"><Icon name="copy" :size="13" />复制</button>
        <button class="lb-mini" :disabled="!g.canDelete.value || g.rect.value.r0 < 0" title="删除所选挂点" @click="g.deleteRows()"><Icon name="trash" :size="13" />删除</button>
        <span class="sp"></span>
        <button class="lb-mini" title="从 JSON 追加挂点（认 {mounts:[…]}、裸数组、整条绑定）" @click="importJson"><Icon name="upload" :size="13" />JSON</button>
        <button class="lb-mini" :disabled="!rows.length || !api" title="挂点表导出为 JSON" @click="exportJson"><Icon name="download" :size="13" />JSON</button>
        <input ref="fileEl" type="file" accept=".json,application/json" hidden @change="onFile" />
      </div>
      <div v-if="jsonMsg" class="md-state" :class="{ bad: jsonBad, ok: !jsonBad }" data-i18n-skip>{{ jsonMsg }}</div>
      <div v-if="attKept" class="md-state warn" title="JSON 里带的姿态律与这颗星现有的不同；现有的不是缺省对地律，没有覆盖">姿态律未覆盖。</div>
    </template>
  </MdSec>
</template>

<style scoped>
.sm-ap { flex: 1 1 120px; min-width: 0 !important; }
.sm-tpl { flex: 1 1 120px; min-width: 0 !important; }
</style>
