<script>
// 行 _id 生成器放模块级：组件切换标签会 v-if 卸载/重挂载，若计数器写在 <script setup> 内则每次归零，
// 新行 _id（'r1','r2'…）便和数组里保留的旧行撞车 → :key 重复 → Vue 带 key 的 diff 错乱（幽灵行/选区
// 错位，即“0 个发信站却仍显示数据行、暂无发信站与数据行并存”的现象）。模块级计数器全局单调、跨挂载不重置。
let _rowSeq = 1
</script>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../components/Icon.vue'
import { defaultsFor } from './ngsoParams.js'
import { toHalf, halfStr } from '../shared/num.js'   // 数字列输入/粘贴归一全角→半角，避免全角减号令负数经纬度等被吞

// 发信/收信站群 Excel 式电子表格：单元格框选（拖拽）、Ctrl+C/X/V 复制/剪切/粘贴（TSV，序号列选中时按整行）、
// 填充柄向下填充、「＋增加」在聚焦行下方插入行、多选行批量删除/设值、清空、撤销/重做、逐行选址、点列头选整列。
const props = defineProps({
  stations: { type: Array, required: true },
  fields: { type: Array, required: true },
  cities: { type: Array, default: () => [] },
  label: { type: String, default: '' },
  autoGeo: { type: Function, default: null },
  roLabel: { type: String, default: '' },          // 只读末列标题（EIRP / G/T）
  roUnit: { type: String, default: '' },
  roValues: { type: Object, default: () => ({}) },  // { _id: 计算值 }，计算后回填
  citySearch: { type: Function, default: null },     // (关键词)→Promise<城市[]>：支持城市名/省份/拼音缩写检索
  selectOptions: { type: Object, default: () => ({}) }, // { 字段key: [选项…] }，覆盖该 select 字段的静态 options（用于运行时动态选项，如载波信号配置库）
  showImport: { type: Boolean, default: true }        // 导入城市库/点标记/地球站/航迹——纯地理点导入；星间链路（星→星，无经纬度）表关掉
})

const root = ref(null)
const nameKey = computed(() => (props.fields.find((f) => f.city) || {}).key)
const lonKey = computed(() => (props.fields.find((f) => /longitude/i.test(f.key)) || {}).key)
const latKey = computed(() => (props.fields.find((f) => /latitude/i.test(f.key)) || {}).key)
const nCol = computed(() => props.fields.length)
// 冻结列：优先取字段显式 frozen 标记的「前缀连续段」长度（列与城市字段位置解耦，可任意调列序仍固定冻结几列）；
// 无 frozen 标记时回退旧启发式——从第一列起冻结到「名称/城市」字段（含）为止。
const cityFieldIdx = computed(() => props.fields.findIndex((f) => f.city))
const frozenPrefix = computed(() => { let n = 0; for (const f of props.fields) { if (f.frozen) n++; else break } return n })
const frozenCount = computed(() => (frozenPrefix.value > 0 ? frozenPrefix.value : (cityFieldIdx.value >= 0 ? cityFieldIdx.value + 1 : 1)))
const KEY_COL_W = 90   // 冻结列统一窄宽度（原 120/108，缩窄）
const isKeyCol = (c) => c < frozenCount.value
function keyColStyle(c) { return { left: (40 + c * KEY_COL_W) + 'px' } }
// 只读列(EIRP/G·T)作为「可选不可编辑」的最后一列：可框选/复制，但不可编辑/粘贴/填充。
const roCol = computed(() => (props.roLabel ? props.fields.length : -1))   // 只读列列号，无则 -1
const nColSel = computed(() => props.fields.length + (props.roLabel ? 1 : 0))  // 可选区总列数（含只读列）
const isRO = (c) => c === roCol.value

// —— 隐藏/显示列（仅折叠显示，不动数据与字段集；序号列、名称列 c=0、只读列不可隐藏）——
const hiddenCols = ref([])                       // 已隐藏的字段列下标（原始 fields 下标）
const isHidden = (c) => hiddenCols.value.includes(c)
const visFields = computed(() => props.fields.map((f, c) => ({ f, c })).filter(({ c }) => !isHidden(c)))
const visColCount = computed(() => visFields.value.length + 1 + (props.roLabel ? 1 : 0))   // 含序号列与只读列
// 可选区中「可见」的列下标（有序）：可见字段列 +（如有）只读列。用于键盘左右移动时跳过隐藏列。
const visSelCols = computed(() => {
  const out = []
  for (let c = 0; c < props.fields.length; c++) if (!isHidden(c)) out.push(c)
  if (props.roLabel) out.push(props.fields.length)
  return out
})
const firstVisSelCol = () => (visSelCols.value.length ? visSelCols.value[0] : 0)
const lastVisSelCol = () => { const v = visSelCols.value; return v.length ? v[v.length - 1] : 0 }
// 从列 c 朝 dir(±1) 取下一可见可选列；c 自身隐藏时取该方向最近可见列
function visColAfter(c, dir) {
  const vis = visSelCols.value
  if (!vis.length) return c
  const i = vis.indexOf(c)
  if (i >= 0) return vis[Math.max(0, Math.min(vis.length - 1, i + dir))]
  if (dir >= 0) { for (const v of vis) if (v > c) return v; return vis[vis.length - 1] }
  for (let k = vis.length - 1; k >= 0; k--) if (vis[k] < c) return vis[k]
  return vis[0]
}
// 取单元格文本（复制用）：只读列取其计算值；select 字段取显示名（而非内部存值 id）——这样复制出去
// 看到的就是名字，粘贴回来时 normalizeFieldValue() 也能按名字正确匹配回对应选项，名字和值的口径统一。
function cellText(s, c) { return isRO(c) ? (props.roValues[s._id] != null ? props.roValues[s._id] : '') : displayValue(s, props.fields[c]) }
// select 字段选项：优先用父组件传入的动态选项（如载波信号配置库），否则用字段静态 options。
// 选项元素可以是普通字符串，也可以是 { value, label }（用于值与显示名不同，如载波信号配置 id→名称）。
function fieldOptions(f) { return props.selectOptions[f.key] || f.options || [] }
const optVal = (o) => (o && typeof o === 'object') ? o.value : o
const optLabel = (o) => (o && typeof o === 'object') ? o.label : o
// 单元格显示值：select 字段按选项表把存值换算成展示名，其余原样。
// 旧数据（升级前保存、缺该字段）值为 undefined，按空字符串对待以匹配“（默认）”选项。
function displayValue(s, f) {
  if (f.type !== 'select') return s[f.key]
  const v = s[f.key] == null ? '' : s[f.key]
  const hit = fieldOptions(f).find((o) => optVal(o) === v)
  return hit ? optLabel(hit) : s[f.key]
}
// 单元格留空时「浅显示」的默认值（占位提示，对标 Handsontable placeholder + placeholderCellClassName）：
// 值真为空且该字段有非空默认值时返回其显示文本，否则 ''。字段 def 即引擎「空→默认」的回退值（口径对齐），
// 故这里显示的就是留空实际会按之计算的值——让用户一眼看到默认，不必去猜。
// 灰字仅为提示、非真实数据：复制/导出仍取空（cellText 走 displayValue，与 Excel 占位一致）。
function ghost(s, f) {
  const v = s[f.key]
  if (v != null && String(v).trim() !== '') return ''
  if (f.def == null || f.def === '') return ''
  if (f.type === 'select') { const hit = fieldOptions(f).find((o) => optVal(o) === f.def); return hit ? optLabel(hit) : f.def }
  return f.def
}
// 写入 select 字段时做一次归一化：粘贴/批量设值/直接键入这些路径拿到的是「自由文本」，
// 用户很可能填的是看到的显示名（如载波信号配置名）而不是内部存值(id)——原样存进去会匹配不上任何选项，
// 表现为「只认下拉框选的，手动打/粘贴名字不算数」。这里按显示名兜底换算成正确的存值；
// 已经是合法存值、或非 select 字段，原样返回。
function normalizeFieldValue(f, raw) {
  if (f.type !== 'select') return raw
  const opts = fieldOptions(f)
  if (opts.some((o) => optVal(o) === raw)) return raw
  const s = String(raw == null ? '' : raw).trim()
  const hit = opts.find((o) => String(optLabel(o)).trim() === s)
  return hit ? optVal(hit) : raw
}
// 经纬度最多保留 6 位小数（≈0.11 m，GIS/GPS 实用精度；再多是浮点噪声）。导入/粘贴 Excel 时清理
// 超长小数；非数字/空值原样，少于 6 位不补零（去尾零）。
const LATLON_DECIMALS = 6
const isLatLonKey = (key) => key === lonKey.value || key === latKey.value
function clampLatLon(val) {
  const s = String(val == null ? '' : val).trim()
  if (s === '') return s
  const n = Number(toHalf(s))                                                        // 全角减号/数字归一，负数经纬度可解
  return Number.isFinite(n) ? String(Number(n.toFixed(LATLON_DECIMALS))) : val
}

// 地球站名称命中城市库（按城市名精确匹配，忽略首尾空格/大小写）→ 自动带入该城市经纬度。
// 返回是否命中（命中后由调用方联动 autoGeo 补降雨/海拔）。
function applyCityByName(row) {
  if (!nameKey.value || !props.cities.length) return false
  const name = String(row[nameKey.value] == null ? '' : row[nameKey.value]).trim()
  if (!name) return false
  const lc = name.toLowerCase()
  const hit = props.cities.find((c) => c && c.name != null && String(c.name).trim().toLowerCase() === lc)
  if (!hit) return false
  if (lonKey.value && hit.lon != null) row[lonKey.value] = clampLatLon(hit.lon)
  if (latKey.value && hit.lat != null) row[latKey.value] = clampLatLon(hit.lat)
  return true
}

// —— 撤销/重做 ——
const undoStack = ref([]); const redoStack = ref([])
const snapshot = () => props.stations.map((s) => ({ ...s }))
function restore(snap) { props.stations.splice(0, props.stations.length, ...snap.map((s) => ({ ...s }))) }
function pushUndo() { undoStack.value.push(snapshot()); if (undoStack.value.length > 100) undoStack.value.shift(); redoStack.value = [] }
function undo() { if (!undoStack.value.length) return; redoStack.value.push(snapshot()); restore(undoStack.value.pop()) }
function redo() { if (!redoStack.value.length) return; undoStack.value.push(snapshot()); restore(redoStack.value.pop()) }

// —— 行多选（行级批量）——
const sel = ref({})
const selectedRows = computed(() => props.stations.filter((s) => sel.value[s._id]))
const allSelected = computed(() => props.stations.length > 0 && props.stations.every((s) => sel.value[s._id]))
function toggleAll() { const v = !allSelected.value; const m = {}; if (v) for (const s of props.stations) m[s._id] = true; sel.value = m }

// —— 增删行 ——
// 新行＝纯空行（各列留空，不带 北京/默认口径 等默认值，由用户自行填写或粘贴）；_id 由模块级计数器保证全局唯一。
function makeRow() { const row = {}; for (const f of props.fields) row[f.key] = ''; row._id = 'r' + (_rowSeq++); return row }
// 「＋ 增加」：Excel 式在当前聚焦行的下方插入一行（纯空行，不再按城市表循环取名）；表为空时作为第一行。
// 焦点落到新行的「地球站位置」列，便于直接键入站名。
function addRow() {
  const at = props.stations.length ? Math.min(props.stations.length, range.fr + 1) : 0
  pushUndo()
  props.stations.splice(at, 0, makeRow())
  sel.value = {}
  setFocus(at, cityFieldIdx.value >= 0 ? cityFieldIdx.value : firstVisSelCol(), false)
}
function removeRow(i) { pushUndo(); const id = props.stations[i]._id; props.stations.splice(i, 1); delete sel.value[id] }
function removeSelected() {
  if (!selectedRows.value.length) return
  pushUndo()
  const ids = new Set(selectedRows.value.map((s) => s._id))
  for (let i = props.stations.length - 1; i >= 0; i--) if (ids.has(props.stations[i]._id)) props.stations.splice(i, 1)
  sel.value = {}
}
function clearAll() { if (!props.stations.length) return; pushUndo(); props.stations.splice(0, props.stations.length); sel.value = {} }

// ============ 电子表格单元格选区 ============
const range = reactive({ ar: 0, ac: 0, fr: 0, fc: 0 }) // anchor / focus (行,列)
const editing = ref(null) // { r, c }
let dragging = false
const r0 = computed(() => Math.min(range.ar, range.fr))
const r1 = computed(() => Math.max(range.ar, range.fr))
const c0 = computed(() => Math.min(range.ac, range.fc))
const c1 = computed(() => Math.max(range.ac, range.fc))
const inSel = (r, c) => r >= r0.value && r <= r1.value && c >= c0.value && c <= c1.value
const isFocus = (r, c) => r === range.fr && c === range.fc
const isEditing = (r, c) => editing.value && editing.value.r === r && editing.value.c === c

function setFocus(r, c, extend) {
  r = Math.max(0, Math.min(props.stations.length - 1, r))
  c = Math.max(0, Math.min(nColSel.value - 1, c))
  range.fr = r; range.fc = c
  if (!extend) { range.ar = r; range.ac = c }
}
// 聚焦格的常驻捕获输入框（导航/编辑共用同一个真实 <input>，见模板 .sg-cap）：焦点始终落在它上，
// 中文输入法从首个拼音字母起就有真实可编辑目标，不再吞首字母。RO 列等无捕获框的格退回聚焦容器本身。
function capEl() { return root.value ? root.value.querySelector('input.sg-cap') : null }
function focusGrid() { nextTick(() => { const el = capEl(); if (el) el.focus(); else if (root.value) root.value.focus() }) }

function onDown(r, c, e) {
  if (isEditing(r, c)) return
  e.preventDefault()
  if (editing.value) endEdit()          // 点击其它格＝提交当前编辑（归一化/城市联动照跑），与 Excel 一致
  if (!e.shiftKey) sel.value = {}        // 普通点击收起整行勾选，选区归一（避免单元格选区与整行勾选并存）
  setFocus(r, c, e.shiftKey)
  dragging = true
  focusGrid()
}
function onEnter(r, c) {
  if (fill.active) { fill.toR = Math.max(fill.r1, r); return }   // 填充柄拖拽：只向下跟踪行
  if (dragging) setFocus(r, c, true)
}
function onUp() {
  if (fill.active) { fill.active = false; applyFill() }
  dragging = false; rowDragging = false; colDragging = false
  stopAutoScroll()
}

// 拖拽（框选/填充/选行）到容器边缘时自动滚动，使底部滚动条跟随
let scrollRAF = null, scrollVX = 0, scrollVY = 0
function onDragMove(e) {
  if (!(dragging || fill.active || rowDragging || colDragging)) { stopAutoScroll(); return }
  const el = root.value; if (!el) return
  const r = el.getBoundingClientRect(), edge = 36
  scrollVX = e.clientX > r.right - edge ? 16 : (e.clientX < r.left + edge ? -16 : 0)
  scrollVY = e.clientY > r.bottom - edge ? 12 : (e.clientY < r.top + edge ? -12 : 0)
  if ((scrollVX || scrollVY) && !scrollRAF) scrollRAF = requestAnimationFrame(autoScrollTick)
}
function autoScrollTick() {
  const el = root.value
  if (!el || !(dragging || fill.active || rowDragging || colDragging) || (!scrollVX && !scrollVY)) { scrollRAF = null; return }
  el.scrollLeft += scrollVX; el.scrollTop += scrollVY
  scrollRAF = requestAnimationFrame(autoScrollTick)
}
function stopAutoScroll() { scrollVX = scrollVY = 0; if (scrollRAF) { cancelAnimationFrame(scrollRAF); scrollRAF = null } }

// —— 序号列：点击/长按拖拽框选行 ——
let rowDragging = false, rowAnchor = 0
let colDragging = false, colAnchor = 0
function selectRowRange(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b), m = {}
  for (let r = lo; r <= hi; r++) m[props.stations[r]._id] = true
  sel.value = m
}
// 整行勾选(sel)后把单元格选区(range)同步铺到这些行的全部列——这样 Ctrl+C/X/V、Delete 等快捷键都按整行生效
// （否则它们只认单元格选区，会对上一次遗留的某个格误操作）。与右键 onIdxContext 已有的做法一致。
function syncRangeToRows() { const idx = selectedRowIdx(); if (idx.length) selectFullRows(idx[0], idx[idx.length - 1]) }
function onRowDown(i, e) {
  e.preventDefault()
  if (editing.value) endEdit()
  if (e.ctrlKey || e.metaKey) {   // Ctrl+点：增/减单行（离散多选）
    sel.value = { ...sel.value, [props.stations[i]._id]: !sel.value[props.stations[i]._id] }
    rowAnchor = i; syncRangeToRows(); focusGrid(); return
  }
  rowDragging = true
  if (e.shiftKey) selectRowRange(rowAnchor, i)     // Shift：从锚点行扩展（与 Excel 一致），不改锚点
  else { rowAnchor = i; sel.value = { [props.stations[i]._id]: true } }
  syncRangeToRows(); focusGrid()
}
function onRowEnter(i) { if (rowDragging) { selectRowRange(rowAnchor, i); syncRangeToRows() } }

// —— 列头：点击/拖拽选整列（与 Excel 一致；序号列与只读列不参与）——
function selectCols(a, b) {
  const lo = Math.min(a, b), hi = Math.max(a, b), last = Math.max(0, props.stations.length - 1)
  sel.value = {}
  range.ar = last; range.ac = lo; range.fr = 0; range.fc = hi   // 铺满整列：锚点底行、焦点顶行
}
function onHeaderDown(c, e) {
  e.preventDefault()
  if (editing.value) endEdit()
  if (!props.stations.length) return
  colDragging = true
  if (e.shiftKey) selectCols(colAnchor, c)
  else { colAnchor = c; selectCols(c, c) }
  focusGrid()
}
function onHeaderEnter(c) { if (colDragging) selectCols(colAnchor, c) }
// 列头高亮：当前选区铺满全部行且覆盖该列时（点列头/Ctrl+A/Ctrl+Space 都会命中）
const colHeadSel = (c) => props.stations.length > 0 && r0.value === 0 && r1.value === props.stations.length - 1 && c >= c0.value && c <= c1.value

// —— Excel 填充柄（选区右下角黑色方块）：拖动/双击向下填充【整个选区的列】，按选中行循环复制，与 Excel 一致 ——
const fill = reactive({ active: false, r0: 0, r1: 0, c0: 0, c1: 0, toR: 0 })
const inFill = (r, c) => fill.active && c >= fill.c0 && c <= fill.c1 && r > fill.r1 && r <= fill.toR
const isFillAnchor = (r, c) => r === r1.value && c === c1.value   // 选区右下角 = 填充柄所在格
function onFillDown(e) {
  e.stopPropagation(); e.preventDefault()
  editing.value = null
  fill.active = true; fill.r0 = r0.value; fill.r1 = r1.value; fill.c0 = c0.value; fill.c1 = c1.value; fill.toR = r1.value
  focusGrid()
}
// 把选区(r0..r1 × c0..c1)按行循环向下填到 toR（只读列跳过）；并把选区扩展到填充范围
function fillDownTo(r0_, r1_, c0_, c1_, toR) {
  const lo = r1_ + 1, hi = toR
  if (hi < lo) return
  pushUndo()
  const srcN = r1_ - r0_ + 1
  for (let r = lo; r <= hi; r++) {
    const row = props.stations[r]; const srcRow = props.stations[r0_ + ((r - lo) % srcN)]
    let coordChanged = false           // 填充改动了经纬度 → 联动 autoGeo（与粘贴/单格编辑口径一致）
    const filledAuto = new Set()       // 填充已显式带入的降雨/海拔列：重算时跳过，不覆盖填充值
    for (let c = c0_; c <= c1_; c++) {
      if (isRO(c)) continue
      const f = props.fields[c]; const v = srcRow[f.key]
      if (isLatLonKey(f.key) && row[f.key] !== v) coordChanged = true
      if (f.auto && String(v == null ? '' : v).trim() !== '') filledAuto.add(f.key)
      row[f.key] = v
    }
    if (coordChanged && props.autoGeo) props.autoGeo(row, filledAuto)
  }
  range.ar = r0_; range.ac = c0_; range.fr = hi; range.fc = c1_
}
function applyFill() { fillDownTo(fill.r0, fill.r1, fill.c0, fill.c1, fill.toR) }
// 双击填充柄 → 从选区底部向下填到最后一行（整个选区的列）
function onFillDbl(e) {
  e.stopPropagation()
  if (r1.value >= props.stations.length - 1) return
  fillDownTo(r0.value, r1.value, c0.value, c1.value, props.stations.length - 1)
}

let _editOrig = null   // 进入编辑时的原值：用于判断名称是否真的改动（避免无改动失焦时误覆盖经纬度）
// F2/双击进入编辑：select 字段弹原生下拉；其余字段把原值带入常驻捕获框、光标置末尾（插入而非整体替换，与 Excel 一致）。
// 直接键入/输入法进入编辑不走这里——它们由 .sg-cap 的 @input/@compositionstart（onCapInput/onCapCompStart）就地翻成编辑态，
// 使中文输入法从第一个拼音字母起就落在真实 <input> 内，不丢首字母。
function startEdit(r, c) {
  if (isRO(c)) return   // 只读列不可编辑
  const f = props.fields[c]
  if (f.type === 'select') { openDropdown(r, c); return }   // select：委托自建下拉列表（替代原生 <select>）
  _editOrig = props.stations[r][f.key]
  editing.value = { r, c, typed: false }
  nextTick(() => {
    const el = capEl()
    if (!el) return
    el.value = _editOrig == null ? '' : String(_editOrig)   // 带出原值供编辑
    el.focus()
    if (el.setSelectionRange) { const n = el.value.length; try { el.setSelectionRange(n, n) } catch (e) { /* ignore */ } }
  })
}
function endEdit() {
  closeDropdown()
  if (editing.value) {
    const { r, c } = editing.value
    const f = props.fields[c]
    const row = props.stations[r]
    if (f && f.type === 'select') row[f.key] = normalizeFieldValue(f, row[f.key])
    if (f && f.key === nameKey.value) {
      // 名称真的改动且命中城市库 → 带入经纬度，并联动 autoGeo 重算降雨/海拔
      if (row[f.key] !== _editOrig && applyCityByName(row) && props.autoGeo) props.autoGeo(row)
    } else if (f && props.autoGeo && (f.key === lonKey.value || f.key === latKey.value)) {
      if (row[f.key] !== _editOrig) props.autoGeo(row)   // 仅坐标真的改动才重算降雨/海拔，避免 Enter/Tab 掠过未改坐标时清掉手改值
    }
  }
  editing.value = null; _editOrig = null
  const el = capEl(); if (el) el.value = ''   // 复位捕获框为空，供下次「键入即替换」
  focusGrid()
}
// Esc 取消编辑：还原编辑前的值，不提交、不做归一化/城市联动（与 Excel 一致）
function cancelEdit() {
  closeDropdown()
  if (editing.value) {
    const { r, c } = editing.value; const f = props.fields[c]
    if (f) props.stations[r][f.key] = _editOrig
  }
  editing.value = null; _editOrig = null
  const el = capEl(); if (el) el.value = ''
  focusGrid()
}
// 常驻捕获框 / 原生下拉的键盘处理。导航态（未进入编辑）不接管——交还冒泡给容器 onKey 做方向/命令键；
// 编辑态才处理提交/取消/跳格。组字中（isComposing/229）一律放行，让 Enter/Esc 去确认/取消输入法候选，勿误提交单元格。
function onCapKey(e) {
  if (!editing.value) return
  if (e.isComposing || e.keyCode === 229) return
  if (dd.open) { onDropdownKey(e); e.stopPropagation(); return }   // 下拉列表打开中：键盘交给列表模型（上下移高亮/Enter·Tab 提交/Esc 取消/字符前缀跳转）
  if (e.key === 'Enter') { endEdit(); setFocus(range.fr + (e.shiftKey ? -1 : 1), range.fc); e.preventDefault() }   // Shift+Enter 上移
  else if (e.key === 'Escape') { cancelEdit(); e.preventDefault() }
  else if (e.key === 'Tab') { endEdit(); setFocus(range.fr, visColAfter(range.fc, e.shiftKey ? -1 : 1)); e.preventDefault() }
  e.stopPropagation()
}
// 在聚焦格里开始键入 / 输入法组字：把常驻捕获框就地翻成编辑态（首字母已落在真实 input 内，输入法不丢字）。
// 首次进入时记下原值 _editOrig（供名称→城市 / 经纬度→autoGeo 的改动判定）；捕获框进入编辑前为空 → 键入即替换。
function beginCapEdit(r, c) {
  if (editing.value || isRO(c)) return
  _editOrig = props.stations[r][props.fields[c].key]
  editing.value = { r, c, typed: true }
}
function onCapCompStart(r, c) {
  if (props.fields[c].type === 'select') { if (!dd.open) openDropdown(r, c); return }   // select：组字即开组合框（输入用于过滤）
  beginCapEdit(r, c)
}
function onCapInput(e, r, c) {
  const f = props.fields[c]
  if (f.type === 'select') {   // select＝组合框：输入即开列表并作为过滤词（不写行，提交时才落值）
    if (!dd.open) openDropdown(r, c, e.target.value)
    else { dd.query = e.target.value; dd.active = 0 }
    return
  }
  beginCapEdit(r, c)
  // 数字列即时归一全角→半角（尤其全角减号－ U+FF0D），使存值恒为半角 → 经纬度/增益等负数不被 Number() 吞；文本列原样
  if (editing.value) props.stations[r][f.key] = f.type === 'num' ? halfStr(e.target.value) : e.target.value
}
function onCapBlur() {
  if (!editing.value) return                                     // 导航态失焦：不处理
  if (dd.open) return                                            // 下拉列表打开中：失焦由 onDocDown 统一裁决（点列表内选项已用 mousedown.prevent 保住焦点，不算失焦）
  endEdit()                                                      // 文本编辑失焦提交（与 Excel 一致）
}
// 导航态下捕获框已获焦：屏蔽它的原生复制/剪切/粘贴，交回 onKey 的整块（多格/整行）剪贴板逻辑，避免与之双写或落进单格；
// 编辑态放行 → 单元格内文本正常复制/粘贴。
function onCapClip(e) { if (!editing.value) e.preventDefault() }
// 容器（RO 列等无捕获框时的后备焦点持有者）意外获得焦点 → 转交给捕获框，保证输入法有真实编辑目标
function onRootFocus() { if (editing.value) return; const el = capEl(); if (el) el.focus() }

// ============ 自建下拉编辑器（select 字段）：替换原生 <select> ============
// 为什么弃用原生 <select>：其下拉是 Chromium/OS 级弹层，几何在 .sg-scroll 滚动 + sticky 表头 + 冻结列 + Windows
// 分数缩放(1.25/1.5)/zoomFactor 下「绘制」与「命中测试」按不同取整对齐，行高仅 ~18px 时错位≥一行 → 点「卫星2」却
// 命中上一行「卫星1」；且错选发生在原生弹层内、任何 JS 事件之前，@change/@blur 只能读到已错的值，无从拦截（历史两次修补皆治标）。
// 自建 DOM 列表：每个选项是真实节点、各自 @mousedown.prevent 提交自身绑定的值——点谁提交谁，与网格同一坐标系，结构上根除错位。
// 列表 Teleport 到 body 脱离滚动裁剪与 sticky 层叠；fixed + 编辑格实时 rect 定位；键盘焦点始终留在 .sg-cap（不移入列表，消除「弹出即失焦」）。
// 对标 AG Grid richSelect / Handsontable autocomplete / Univer / x-spreadsheet / Radix / Headless UI——均不用原生 <select>。
// 组合框（select＝可选可输入）：dd.query 为输入过滤词。单点选择走列表、批量录入走打字，两者兼得。
const dd = reactive({ open: false, r: -1, c: -1, active: -1, flip: false, style: {}, query: '' })
const ddEl = ref(null)
const ddField = computed(() => (dd.c >= 0 && dd.c < props.fields.length ? props.fields[dd.c] : null))
const ddOptions = computed(() => (ddField.value ? fieldOptions(ddField.value) : []))
// 过滤：按输入词对显示名/存值做「包含」匹配（忽略大小写）；空输入=全表。
const ddFiltered = computed(() => {
  const all = ddOptions.value
  const q = (dd.query || '').trim().toLowerCase()
  if (!q) return all
  return all.filter((o) => String(optLabel(o)).toLowerCase().includes(q) || String(optVal(o)).toLowerCase().includes(q))
})
// 当前存值（列表打钩/预高亮用）：null/undefined 归一为 '' 以匹配「（默认）」项
const ddCurrent = computed(() => {
  if (dd.r < 0 || dd.c < 0 || !props.stations[dd.r]) return ''
  const v = props.stations[dd.r][props.fields[dd.c].key]
  return v == null ? '' : v
})

// seed：以某初值打开（打字/组字进入时把已输入内容带进过滤框）；无 seed=纯选择打开，输入框空、占位显示当前值、全表并高亮当前项。
function openDropdown(r, c, seed) {
  if (isRO(c)) return
  const f = props.fields[c]
  if (!f || f.type !== 'select') return
  if (editing.value && !(editing.value.r === r && editing.value.c === c)) endEdit()
  _editOrig = props.stations[r][f.key]
  editing.value = { r, c, typed: false }
  setFocus(r, c, false)   // 确保编辑格==聚焦格：组合框输入靠本格的 .sg-cap，二者必须重合（editing 先置好，watch 不会抢焦）
  const cur = props.stations[r][f.key] == null ? '' : props.stations[r][f.key]
  dd.r = r; dd.c = c; dd.open = true; dd.flip = false
  dd.query = seed == null ? '' : String(seed)
  const all = fieldOptions(f)
  dd.active = dd.query ? 0 : Math.max(0, all.findIndex((o) => optVal(o) === cur))   // 空输入预高亮当前值；打字则高亮首个匹配
  window.addEventListener('scroll', onDropdownReflow, true)   // capture：接住 .sg-scroll 容器不冒泡的滚动
  window.addEventListener('resize', onDropdownReflow)
  window.addEventListener('mousedown', onDocDown, true)
  nextTick(() => {
    const el = capEl()
    if (el) { el.value = dd.query; el.focus(); if (el.setSelectionRange) { const n = el.value.length; try { el.setSelectionRange(n, n) } catch (e) { /* ignore */ } } }
    positionDropdown(); scrollActive()
  })
}
function closeDropdown() {
  if (!dd.open) return
  dd.open = false; dd.r = dd.c = dd.active = -1; dd.style = {}; dd.query = ''
  window.removeEventListener('scroll', onDropdownReflow, true)
  window.removeEventListener('resize', onDropdownReflow)
  window.removeEventListener('mousedown', onDocDown, true)
}
// 从编辑格实时 rect 定位（fixed=视口坐标，天然免疫 scrollLeft/Top 与 sticky 偏移，勿手动加 scrollTop）；下方空间不足且上方够则上翻并夹高
function positionDropdown() {
  const cell = root.value && root.value.querySelector('.sg-cell.editing')
  const pop = ddEl.value
  if (!cell || !pop) return
  const cr = cell.getBoundingClientRect(), gap = 2, vh = window.innerHeight, ph = pop.offsetHeight
  let top = cr.bottom + gap, flip = false
  if (top + ph > vh - 8 && cr.top - gap - ph > 8) { top = cr.top - gap - ph; flip = true }
  const maxH = Math.max(72, Math.round(flip ? (cr.top - gap - 8) : (vh - top - 8)))
  dd.flip = flip
  dd.style = { left: Math.round(cr.left) + 'px', top: Math.round(top) + 'px', minWidth: Math.round(cr.width) + 'px', maxHeight: maxH + 'px' }
}
// 网格滚动/窗口变化：重定位；编辑格被滚出可视网格 → 放弃本次编辑（还原原值）收起，避免把半截输入误提交
function onDropdownReflow() {
  if (!dd.open) return
  const cell = root.value && root.value.querySelector('.sg-cell.editing')
  if (!cell || !root.value) { cancelEdit(); return }
  const cr = cell.getBoundingClientRect(), sr = root.value.getBoundingClientRect()
  if (cr.bottom < sr.top || cr.top > sr.bottom || cr.right < sr.left || cr.left > sr.right) { cancelEdit(); return }
  positionDropdown()
}
// 文档级按下（capture 先于 td/caret 的 mousedown）：点在列表内或当前编辑格内交给各自 handler；点其它处＝提交当前解析值收起
function onDocDown(e) {
  if (!dd.open) return
  if (ddEl.value && ddEl.value.contains(e.target)) return
  const cell = root.value && root.value.querySelector('.sg-cell.editing')
  if (cell && cell.contains(e.target)) return
  commitDropdown(ddCommitValue())
}
function onCaretDown(r, c) {
  if (dd.open && dd.r === r && dd.c === c) { commitDropdown(ddCommitValue()); return }   // 再点当前 caret＝提交并收起
  if (editing.value) endEdit()
  sel.value = {}
  setFocus(r, c, false)
  openDropdown(r, c)
}
function onOptDown(o) { commitDropdown(optVal(o)) }   // 点选项：提交该选项自身绑定的值（点谁提交谁）
// 提交解析：优先取当前高亮的过滤项；无过滤项（打了字但无匹配）则把输入文本按显示名兜底归一为存值（支持自由录入）。
function ddCommitValue() {
  const filtered = ddFiltered.value
  if (filtered.length && dd.active >= 0 && dd.active < filtered.length) return optVal(filtered[dd.active])
  return normalizeFieldValue(props.fields[dd.c], dd.query == null ? '' : dd.query)
}
function commitDropdown(val) {
  if (dd.r >= 0 && dd.c >= 0) props.stations[dd.r][props.fields[dd.c].key] = val
  endEdit()   // 归一化（合法存值原样）+清编辑态+关弹层+回焦捕获框
}
function scrollActive() {
  nextTick(() => { const el = ddEl.value; if (!el) return; const a = el.querySelector('.sg-opt.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }) })
}
// 列表键盘模型（自持，跨浏览器/Electron 一致）：上下移高亮；Enter/Tab 提交并按网格约定移动焦点；Esc 取消还原；
// 可打印字符/Backspace/左右键不拦截 → 落进 .sg-cap 输入框驱动过滤（@input→onCapInput 更新 dd.query）；空输入时 Home/End 跳首末项。
function onDropdownKey(e) {
  const opts = ddFiltered.value, n = opts.length
  if (e.key === 'ArrowDown') { if (n) dd.active = Math.min(n - 1, dd.active + 1); scrollActive(); e.preventDefault(); return }
  if (e.key === 'ArrowUp') { if (n) dd.active = Math.max(0, dd.active - 1); scrollActive(); e.preventDefault(); return }
  if (e.key === 'Home' && !dd.query) { if (n) dd.active = 0; scrollActive(); e.preventDefault(); return }
  if (e.key === 'End' && !dd.query) { if (n) dd.active = n - 1; scrollActive(); e.preventDefault(); return }
  if (e.key === 'Enter') { props.stations[dd.r][props.fields[dd.c].key] = ddCommitValue(); const fr = range.fr, fc = range.fc; endEdit(); setFocus(fr + (e.shiftKey ? -1 : 1), fc); e.preventDefault(); return }
  if (e.key === 'Tab') { props.stations[dd.r][props.fields[dd.c].key] = ddCommitValue(); const fr = range.fr, fc = range.fc; endEdit(); setFocus(fr, visColAfter(fc, e.shiftKey ? -1 : 1)); e.preventDefault(); return }
  if (e.key === 'Escape') { cancelEdit(); e.preventDefault(); return }
}

function clearSel() {
  pushUndo()
  for (let r = r0.value; r <= r1.value; r++) for (let c = c0.value; c <= c1.value; c++) if (!isRO(c)) props.stations[r][props.fields[c].key] = ''
}
function copyRange() {
  const lines = []
  for (let r = r0.value; r <= r1.value; r++) {
    const row = []
    for (let c = c0.value; c <= c1.value; c++) row.push(cellText(props.stations[r], c) ?? '')   // 含只读列（取其计算值）
    lines.push(row.join('\t'))
  }
  try { navigator.clipboard.writeText(lines.join('\n')) } catch (e) { /* ignore */ }
}
async function pasteRange() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch (e) { return }
  if (!text) return
  const rows = text.replace(/\r/g, '').split('\n'); if (rows.length && rows[rows.length - 1] === '') rows.pop()
  const grid = rows.map((r) => r.split('\t'))
  if (!grid.length) return
  const gR = grid.length, gC = grid[0].length
  const sr = r0.value, sc = c0.value
  // Excel 平铺：目标选区比剪贴板大、且行列都是整数倍时，把源块循环铺满整个选区（如复制 1 格铺满一片）
  const selR = r1.value - r0.value + 1, selC = c1.value - c0.value + 1
  const tile = (selR > gR || selC > gC) && selR % gR === 0 && selC % gC === 0
  const outR = tile ? selR : gR, outC = tile ? selC : gC
  pushUndo()
  for (let i = 0; i < outR; i++) {
    const r = sr + i
    if (r >= props.stations.length) props.stations.push(makeRow())
    const row = props.stations[r]
    let coordChanged = false           // 该行经纬度被粘贴改动 → 联动 autoGeo 重算降雨/海拔（与单格编辑口径一致）
    const pastedAuto = new Set()       // 粘贴已显式带入的降雨/海拔列（如整行复制）：重算时跳过，不覆盖粘贴值
    for (let j = 0; j < outC; j++) {
      const c = sc + j
      const src = grid[i % gR][j % gC]
      if (src === undefined) continue
      if (c < nColSel.value && !isRO(c)) {
        const f = props.fields[c]
        const v = isLatLonKey(f.key) ? clampLatLon(src) : normalizeFieldValue(f, src)
        if (isLatLonKey(f.key) && row[f.key] !== v) coordChanged = true
        if (f.auto && String(v == null ? '' : v).trim() !== '') pastedAuto.add(f.key)
        row[f.key] = v
      }
    }
    if (coordChanged && props.autoGeo) props.autoGeo(row, pastedAuto)
  }
  range.ar = sr; range.ac = sc
  range.fr = Math.min(props.stations.length - 1, sr + outR - 1)
  range.fc = Math.min(nColSel.value - 1, sc + outC - 1)
}

// —— 整行复制/剪切：当「序号列选中了整行」时，Ctrl+C/X 跨全部列作用于这些整行 ——
function fullRowTSV(i) { const row = []; for (let c = 0; c < nColSel.value; c++) row.push(cellText(props.stations[i], c) ?? ''); return row.join('\t') }
function copyRows(idx) { try { navigator.clipboard.writeText(idx.map(fullRowTSV).join('\n')) } catch (e) { /* ignore */ } }
function cutRows(idx) {
  copyRows(idx)                                   // 整行剪切＝移动语义：复制后删除这些行（可 Ctrl+V 到别处；可撤销）
  const set = new Set(idx.map((i) => props.stations[i]._id))
  pushUndo()
  for (let i = props.stations.length - 1; i >= 0; i--) if (set.has(props.stations[i]._id)) props.stations.splice(i, 1)
  sel.value = {}
  if (props.stations.length) setFocus(Math.min(idx[0], props.stations.length - 1), firstVisSelCol(), false)
}
// 复制/剪切统一入口：序号列选中整行时按整行、否则按单元格选区——键盘 Ctrl+C/X 与右键菜单共用，口径一致
function smartCopy() { const ri = selectedRowIdx(); ri.length ? copyRows(ri) : copyRange() }
function smartCut() { const ri = selectedRowIdx(); ri.length ? cutRows(ri) : cutRange() }
// 单元格导航（方向键/Enter/Tab/Home/End/翻页）收起整行勾选，回到单选，与 Excel 一致
function collapseRowSel() { if (selectedRows.value.length) sel.value = {} }

function onKey(e) {
  if (editing.value) return
  if (e.isComposing || e.keyCode === 229) return   // 输入法（中文）组字中：交给 IME，勿吞首字/误触发覆盖编辑
  if (!props.stations.length) return
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'z' || e.key === 'Z')) { if (e.shiftKey) redo(); else undo(); e.preventDefault(); return }
  if (mod && (e.key === 'y' || e.key === 'Y')) { redo(); e.preventDefault(); return }
  if (mod && (e.key === 'c' || e.key === 'C')) { smartCopy(); e.preventDefault(); return }
  if (mod && (e.key === 'x' || e.key === 'X')) { smartCut(); e.preventDefault(); return }
  if (mod && (e.key === 'v' || e.key === 'V')) { pasteRange(); e.preventDefault(); return }
  if (mod && (e.key === 'a' || e.key === 'A')) { sel.value = {}; range.ar = 0; range.ac = firstVisSelCol(); range.fr = props.stations.length - 1; range.fc = lastVisSelCol(); e.preventDefault(); return }
  if (mod && e.key === 'Home') { collapseRowSel(); setFocus(0, firstVisSelCol(), e.shiftKey); e.preventDefault(); return }
  if (mod && e.key === 'End') { collapseRowSel(); setFocus(props.stations.length - 1, lastVisSelCol(), e.shiftKey); e.preventDefault(); return }
  if (mod && e.key === ' ') { selectCols(c0.value, c1.value); e.preventDefault(); return }   // Ctrl+Space：选中当前选区跨过的整列
  if (mod) return
  if (e.key === 'F2') { startEdit(range.fr, range.fc); e.preventDefault(); return }
  if (e.key === 'Enter') { collapseRowSel(); setFocus(range.fr + (e.shiftKey ? -1 : 1), range.fc); e.preventDefault(); return }   // Excel：Enter 下移、Shift+Enter 上移（编辑用 F2/双击/直接键入）
  if (e.key === 'Tab') { collapseRowSel(); setFocus(range.fr, visColAfter(range.fc, e.shiftKey ? -1 : 1)); e.preventDefault(); return }
  if (e.key === 'Delete' || e.key === 'Backspace') { clearSel(); e.preventDefault(); return }
  if (e.key === 'Home') { collapseRowSel(); setFocus(range.fr, firstVisSelCol(), e.shiftKey); e.preventDefault(); return }
  if (e.key === 'End') { collapseRowSel(); setFocus(range.fr, lastVisSelCol(), e.shiftKey); e.preventDefault(); return }
  if (e.key === 'PageUp' || e.key === 'PageDown') { collapseRowSel(); const PAGE = 12; setFocus(range.fr + (e.key === 'PageUp' ? -PAGE : PAGE), range.fc, e.shiftKey); e.preventDefault(); return }
  if (e.shiftKey && e.key === ' ') {   // Shift+Space：把当前选区所在行选为整行
    selectFullRows(r0.value, r1.value); const m = {}; for (let r = r0.value; r <= r1.value; r++) m[props.stations[r]._id] = true; sel.value = m; e.preventDefault(); return
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { moveRows(e.key === 'ArrowUp' ? -1 : 1); e.preventDefault(); return }
  const arrow = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
  if (arrow) { collapseRowSel(); setFocus(range.fr + arrow[0], arrow[1] ? visColAfter(range.fc, arrow[1]) : range.fc, e.shiftKey); e.preventDefault(); return }
  // 可见字符 / 输入法：不在此合成编辑，也不 preventDefault——放行让按键自然落进聚焦格里那个已获焦的常驻捕获框 .sg-cap，
  // 由其 @input/@compositionstart 就地进入编辑。这样中文输入法组字从第一个字母起就有真实目标，不再吞首字母。
}

// 聚焦格变化（键盘导航 / 鼠标框选 / 增行 / 粘贴 / 填充 / 移动行等任意来源）后，把键盘焦点移到新聚焦格的常驻捕获框，
// 让输入法始终有真实编辑目标；编辑中不抢焦点。RO 列等无捕获框的格退回容器本身，保证导航链不断。
watch(() => [range.fr, range.fc], () => {
  if (editing.value) return
  nextTick(() => { const el = capEl(); if (el) el.focus(); else if (root.value) root.value.focus() })
})

onMounted(() => { window.addEventListener('mouseup', onUp); window.addEventListener('mousemove', onDragMove) })
onBeforeUnmount(() => { window.removeEventListener('mouseup', onUp); window.removeEventListener('mousemove', onDragMove); stopAutoScroll(); closeDropdown() })

// —— 导入（城市库 / 点标记 / 地球站 / 航迹）——
// 点标记/地球站/航迹来自主窗口 localStorage('globe3d/markers')（同源共享，无需 IPC）。
const IMPORT_SOURCES = [
  { key: 'city', label: '城市库' },
  { key: 'point', label: '点标记' },
  { key: 'station', label: '地球站' },
  { key: 'traj', label: '航迹' }
]
const imp = reactive({ open: false, source: 'city', query: '', picked: {} })
function readMarkers() { try { return JSON.parse(localStorage.getItem('globe3d/markers') || 'null') || {} } catch (e) { return {} } }
// 城市项稳定 id（城市名+经度）：跨关键词/搜索结果保持一致，避免勾选错位
const cityId = (c) => 'c_' + c.name + '_' + c.lon
const impItems = computed(() => {
  if (imp.source === 'city') return props.cities.map((c) => ({ id: cityId(c), name: c.name, lon: c.lon, lat: c.lat }))
  const mk = readMarkers()
  if (imp.source === 'point') return (mk.points || []).map((p, i) => ({ id: p.id || 'p' + i, name: '点标记' + (i + 1), lon: p.lon, lat: p.lat }))
  if (imp.source === 'station') return (mk.stations || []).map((s, i) => ({ id: s.id || 's' + i, name: s.name || ('地球站' + (i + 1)), lon: s.lon, lat: s.lat }))
  if (imp.source === 'traj') { const out = []; for (const t of (mk.trajectories || [])) (t.pts || []).forEach((p, j) => out.push({ id: (t.id || 't') + '_' + j, name: (t.name || '航迹') + '#' + (j + 1), lon: p.lon, lat: p.lat })); return out }
  return []
})
// 城市关键词检索（城市名 / 省份名含别名 / 拼音首字母缩写）：交给引擎 core.searchCities（与小程序口径一致）。
// 仅「城市库」源、传入了 citySearch、且有关键词时启用；否则退回本地名称/经度过滤。
const cityHits = ref([])
const useCitySearch = computed(() => imp.source === 'city' && !!props.citySearch && imp.query.trim() !== '')
let _cityT = null
watch(() => [imp.open, imp.source, imp.query], () => {
  if (!useCitySearch.value) { cityHits.value = []; return }
  const q = imp.query.trim()
  clearTimeout(_cityT)
  _cityT = setTimeout(async () => {
    try { const r = await props.citySearch(q); cityHits.value = (r || []).map((c) => ({ id: cityId(c), name: c.name, lon: c.lon, lat: c.lat })) }
    catch (e) { cityHits.value = [] }
  }, 160)
})
const currentItems = computed(() => (useCitySearch.value ? cityHits.value : impItems.value))   // 勾选/导入的真实数据源
const IMPORT_LIST_CAP = 1000   // 导入列表展示上限（城市库 349 项可一次看全，亦留余量给点标记/航迹）
const impResults = computed(() => {
  if (useCitySearch.value) return cityHits.value.slice(0, IMPORT_LIST_CAP)
  const q = imp.query.trim().toLowerCase()
  const l = q ? impItems.value.filter((it) => it.name.toLowerCase().includes(q) || String(it.lon).includes(q)) : impItems.value
  return l.slice(0, IMPORT_LIST_CAP)
})
function openImport() { imp.open = true; imp.query = ''; imp.picked = {} }
function setSource(k) { imp.source = k; imp.query = ''; imp.picked = {} }
const impAllSel = computed(() => impResults.value.length > 0 && impResults.value.every((it) => imp.picked[it.id]))
function impToggleAll() { const v = !impAllSel.value; const m = { ...imp.picked }; for (const it of impResults.value) m[it.id] = v; imp.picked = m }
function doImport() {
  const chosen = currentItems.value.filter((it) => imp.picked[it.id])
  if (!chosen.length) { imp.open = false; return }
  pushUndo()
  for (const it of chosen) {
    const row = defaultsFor(props.fields); row._id = 'r' + (_rowSeq++)
    if (nameKey.value) row[nameKey.value] = it.name
    if (lonKey.value && it.lon != null) row[lonKey.value] = clampLatLon(it.lon)
    if (latKey.value && it.lat != null) row[latKey.value] = clampLatLon(it.lat)
    props.stations.push(row)
    if (props.autoGeo) props.autoGeo(row)
  }
  imp.open = false
}

// —— 批量设值（选中行）——
const batch = reactive({ open: false, key: '', value: '' })
function openBatch() { if (!selectedRows.value.length) return; batch.key = props.fields[0].key; batch.value = ''; batch.open = true }
function doBatch() {
  pushUndo()
  const v = isLatLonKey(batch.key) ? clampLatLon(batch.value) : normalizeFieldValue(batchField.value, batch.value)
  for (const s of selectedRows.value) {
    const coordChanged = isLatLonKey(batch.key) && s[batch.key] !== v
    s[batch.key] = v
    if (coordChanged && props.autoGeo) props.autoGeo(s)   // 批量设经纬度同样联动重算降雨/海拔
  }
  batch.open = false
}
const batchField = computed(() => props.fields.find((f) => f.key === batch.key) || props.fields[0])

// ============ 右键菜单（Excel 式）：复制/剪切/粘贴/清除内容 · 插入/删除行 · 隐藏列/清除整列 ============
const menu = reactive({ open: false, x: 0, y: 0 })
function openMenu(e) {
  menu.x = Math.min(e.clientX, window.innerWidth - 200)     // 防贴右/下边溢出
  menu.y = Math.min(e.clientY, window.innerHeight - 320)
  menu.open = true
}
function menuDo(fn) { menu.open = false; fn() }
function selectedRowIdx() { const out = []; props.stations.forEach((s, i) => { if (sel.value[s._id]) out.push(i) }); return out }
function selectFullRows(lo, hi) { range.ar = lo; range.fr = hi; range.ac = firstVisSelCol(); range.fc = lastVisSelCol() }
// 单元格右键：进入「单元格模式」——清行勾选；右键落在选区外则选区跳到该格（与 Excel 一致）
function onCellContext(r, c, e) {
  e.preventDefault(); editing.value = null; sel.value = {}
  if (!inSel(r, c)) setFocus(r, c, false)
  focusGrid(); openMenu(e)
}
// 序号列右键：进入「整行模式」——右键行在已选外则只选该行；并让单元格选区覆盖选中行整行
function onIdxContext(i, e) {
  e.preventDefault(); editing.value = null
  if (!sel.value[props.stations[i]._id]) sel.value = { [props.stations[i]._id]: true }
  const idx = selectedRowIdx()
  if (idx.length) selectFullRows(Math.min(...idx), Math.max(...idx))
  focusGrid(); openMenu(e)
}

// 复制/剪切/粘贴/清除内容复用电子表格选区逻辑（copyRange/pasteRange/clearSel 已有）
function cutRange() { copyRange(); clearSel() }

// —— 插入/删除行：行集 = 已勾选行（整行模式）否则单元格选区所在行（单元格模式）——
function targetRowIdx() {
  const s = selectedRowIdx()
  if (s.length) return s
  const out = []; for (let r = r0.value; r <= r1.value; r++) out.push(r); return out
}
function insertRowsAt(at, count) {
  pushUndo()
  const rows = []; for (let k = 0; k < count; k++) rows.push(makeRow())   // 纯空行（与「＋ 增加」一致）
  props.stations.splice(at, 0, ...rows)
  sel.value = {}; selectFullRows(at, at + count - 1)
}
function insertAbove() { const idx = targetRowIdx(); if (idx.length) insertRowsAt(Math.min(...idx), idx.length) }
function insertBelow() { const idx = targetRowIdx(); if (idx.length) insertRowsAt(Math.max(...idx) + 1, idx.length) }
function deleteCtxRows() {
  if (!props.stations.length) return
  const idx = targetRowIdx().slice().sort((a, b) => b - a)   // 从后往前删，下标不串位
  pushUndo()
  for (const i of idx) { const s = props.stations[i]; if (s) { delete sel.value[s._id]; props.stations.splice(i, 1) } }
  sel.value = {}
  if (props.stations.length) {   // 删完让选区落在下方接替的整行上（保持整行语义，连续删除体验连贯）
    const at = Math.min(idx[idx.length - 1], props.stations.length - 1)
    selectFullRows(at, at); sel.value = { [props.stations[at]._id]: true }
  }
}

// —— 行上移/下移（整行顺序交换）：行集 = 已勾选行，否则单元格选区所在行；须连续 ——
function targetRowIdxSorted() { return targetRowIdx().slice().sort((a, b) => a - b) }
function isContiguousIdx(idx) { for (let i = 1; i < idx.length; i++) if (idx[i] !== idx[i - 1] + 1) return false; return true }
const canMoveUp = computed(() => { const idx = targetRowIdxSorted(); return idx.length > 0 && isContiguousIdx(idx) && idx[0] > 0 })
const canMoveDown = computed(() => { const idx = targetRowIdxSorted(); return idx.length > 0 && isContiguousIdx(idx) && idx[idx.length - 1] < props.stations.length - 1 })
function moveRows(dir) {
  const idx = targetRowIdxSorted()
  if (!idx.length || !isContiguousIdx(idx)) return
  const lo = idx[0], hi = idx[idx.length - 1]
  if (dir < 0 && lo <= 0) return
  if (dir > 0 && hi >= props.stations.length - 1) return
  pushUndo()
  if (dir < 0) { const row = props.stations.splice(lo - 1, 1)[0]; props.stations.splice(hi, 0, row) }
  else { const row = props.stations.splice(hi + 1, 1)[0]; props.stations.splice(lo, 0, row) }
  // 行勾选选区(sel)按 _id 跟随，移动后自动仍指向同一批行，无需重设；这里只需把单元格选区同步到新位置
  selectFullRows(lo + dir, hi + dir)
  focusGrid()
}
function moveUp() { moveRows(-1) }
function moveDown() { moveRows(1) }

// —— 列：隐藏/显示、清除整列内容。列集 = 单元格选区跨过的列 ——
function targetColIdx() { const out = []; for (let c = c0.value; c <= c1.value; c++) out.push(c); return out }
const canHideSel = computed(() => targetColIdx().some((c) => c < props.fields.length && !isKeyCol(c) && !isHidden(c)))
function hideCols() {
  const add = targetColIdx().filter((c) => c < props.fields.length && !isKeyCol(c) && !isHidden(c))   // 序号列、冻结列、只读列不可隐藏
  if (!add.length) return
  hiddenCols.value = [...hiddenCols.value, ...add]
  const vis = visSelCols.value                                  // 焦点/锚点落在刚隐藏的列上 → 贴回最近可见列
  const snap = (c) => (vis.includes(c) ? c : visColAfter(c, -1))
  range.ac = snap(range.ac); range.fc = snap(range.fc)
}
function unhideAll() { hiddenCols.value = [] }
function clearColContents() {
  const cols = targetColIdx().filter((c) => c < props.fields.length && !isRO(c))
  if (!cols.length || !props.stations.length) return
  pushUndo()
  for (const c of cols) { const key = props.fields[c].key; for (const s of props.stations) s[key] = '' }
}
</script>

<template>
  <div class="sg">
    <div class="sg-bar">
      <span class="sg-count">{{ stations.length }} 个{{ label }}<template v-if="selectedRows.length"> · 选中 {{ selectedRows.length }} 行</template></span>
      <span class="sg-sp"></span>
      <button class="sg-btn" @click="addRow"><Icon name="plus" :size="12" /> 增加</button>
      <button v-if="showImport" class="sg-btn" @click="openImport"><Icon name="import" :size="12" /> 导入</button>
      <button class="sg-btn" :disabled="!selectedRows.length" @click="openBatch">批量设值</button>
      <button class="sg-btn" :disabled="!selectedRows.length" @click="removeSelected">删除选中</button>
      <button class="sg-btn" :disabled="!stations.length" @click="clearAll">清空</button>
      <button class="sg-btn" :disabled="!undoStack.length" title="撤销" @click="undo"><Icon name="undo-2" :size="12" /></button>
      <button class="sg-btn" :disabled="!redoStack.length" title="重做" @click="redo"><Icon name="redo-2" :size="12" /></button>
      <button class="sg-btn" :disabled="!canMoveUp" title="上移一行（Alt+↑）" @click="moveUp"><Icon name="arrow-up" :size="12" /> 上移</button>
      <button class="sg-btn" :disabled="!canMoveDown" title="下移一行（Alt+↓）" @click="moveDown"><Icon name="arrow-down" :size="12" /> 下移</button>
      <button v-if="hiddenCols.length" class="sg-btn" :title="'已隐藏 ' + hiddenCols.length + ' 列，点击全部显示'" @click="unhideAll">显示隐藏列（{{ hiddenCols.length }}）</button>
    </div>

    <div ref="root" class="sg-scroll" tabindex="0" @keydown="onKey" @focus="onRootFocus">
      <table class="sg-tbl">
        <thead>
          <tr>
            <th class="sg-sel"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
            <th v-for="({ f, c }) in visFields" :key="f.key" class="sg-hcol" :class="{ 'sg-key': isKeyCol(c), colsel: colHeadSel(c) }" :style="isKeyCol(c) ? keyColStyle(c) : null" :title="f.label"
                @mousedown.left="onHeaderDown(c, $event)" @mouseenter="onHeaderEnter(c)">
              {{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i>
            </th>
            <th v-if="roLabel" class="sg-ro">{{ roLabel }}<i v-if="roUnit"> ({{ roUnit }})</i></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in stations" :key="s._id || i" :class="{ on: sel[s._id] }">
            <td class="sg-sel" :title="'拖拽序号可框选行 · 右键插入/删除行'" @mousedown.left="onRowDown(i, $event)" @mouseenter="onRowEnter(i)" @contextmenu.prevent="onIdxContext(i, $event)"><span class="sg-idx">{{ i + 1 }}</span></td>
            <td v-for="({ f, c }) in visFields" :key="f.key"
                class="sg-cell" :class="{ 'sg-key': isKeyCol(c), sel: inSel(i, c), focus: isFocus(i, c), editing: isEditing(i, c), fillp: inFill(i, c) }"
                :style="isKeyCol(c) ? keyColStyle(c) : null"
                @mousedown.left="onDown(i, c, $event)" @mouseenter="onEnter(i, c)" @dblclick="startEdit(i, c)" @contextmenu.prevent="onCellContext(i, c, $event)">
              <!-- 聚焦格常驻捕获输入框：导航态透明覆盖在值上（pointer-events:none 让鼠标框选穿透 td），
                   键入/输入法组字即翻成可见编辑框——中文输入法从首字母起就落在真实 <input>，不吞首字母。
                   select 字段：编辑态不套 editing 皮肤（保持透明导航态），选择改由自建下拉列表(sg-dd)承接，
                   绕开原生 <select> 弹层在滚动/sticky/冻结列 + Windows 分数缩放下的「点谁选上一个」坐标错位。 -->
              <template v-if="isFocus(i, c)">
                <input class="sg-cap" :class="{ editing: isEditing(i, c), combo: f.type === 'select', mono: f.type === 'num' }" tabindex="-1"
                       :placeholder="!isEditing(i, c) ? '' : (f.type === 'select' ? (displayValue(s, f) || ghost(s, f) || '输入或选择…') : ghost(s, f))"
                       @input="onCapInput($event, i, c)" @compositionstart="onCapCompStart(i, c)"
                       @keydown="onCapKey" @blur="onCapBlur"
                       @copy="onCapClip" @cut="onCapClip" @paste="onCapClip" />
                <span v-if="!(isEditing(i, c) && f.type === 'select')" class="sg-v" :class="{ mono: f.type === 'num', 'has-caret': f.type === 'select', ph: ghost(s, f) }">{{ ghost(s, f) || displayValue(s, f) }}</span>
                <span v-if="f.type === 'select'" class="sg-caret" :class="{ open: isEditing(i, c) }"
                      @mousedown.left.stop.prevent="onCaretDown(i, c)"><Icon name="chevron-down" :size="12" /></span>
              </template>
              <template v-else>
                <span class="sg-v" :class="{ mono: f.type === 'num', 'has-caret': f.type === 'select', ph: ghost(s, f) }">{{ ghost(s, f) || displayValue(s, f) }}</span>
                <span v-if="f.type === 'select'" class="sg-caret"
                      @mousedown.left.stop.prevent="onCaretDown(i, c)"><Icon name="chevron-down" :size="12" /></span>
              </template>
              <span v-if="isFillAnchor(i, c) && !isEditing(i, c)" class="sg-handle" title="拖动/双击向下填充" @mousedown.left.stop.prevent="onFillDown" @dblclick.stop="onFillDbl"></span>
            </td>
            <td v-if="roLabel" class="sg-ro mono sg-cell" :class="{ sel: inSel(i, fields.length), focus: isFocus(i, fields.length), fillp: inFill(i, fields.length) }"
                @mousedown.left="onDown(i, fields.length, $event)" @mouseenter="onEnter(i, fields.length)" @contextmenu.prevent="onCellContext(i, fields.length, $event)">
              {{ roValues[s._id] != null ? roValues[s._id] : '—' }}
              <span v-if="isFillAnchor(i, fields.length)" class="sg-handle" title="拖动/双击向下填充" @mousedown.left.stop.prevent="onFillDown" @dblclick.stop="onFillDbl"></span>
            </td>
          </tr>
          <tr v-if="!stations.length"><td :colspan="visColCount" class="sg-empty">暂无{{ label }}，点击「＋ 增加」<template v-if="showImport">或「⇩ 导入」</template></td></tr>
        </tbody>
      </table>
    </div>

    <!-- 导入（城市库 / 点标记 / 地球站 / 航迹）——多选 -->
    <div v-if="imp.open" class="sg-mask" @click="imp.open = false">
      <div class="sg-box" @click.stop>
        <div class="sg-box-hd">导入{{ label }}</div>
        <div class="sg-tabs">
          <button v-for="s in IMPORT_SOURCES" :key="s.key" class="sg-tab" :class="{ on: imp.source === s.key }" @click="setSource(s.key)">{{ s.label }}</button>
        </div>
        <input v-model="imp.query" class="sg-search" :placeholder="imp.source === 'city' ? '搜索城市 / 省份 / 拼音缩写（如 北京 / 江苏 / bj）' : '搜索名称 / 经度'" />
        <div class="sg-list">
          <label class="sg-impall"><input type="checkbox" :checked="impAllSel" @change="impToggleAll" /> 全选（{{ impResults.length }} 项）</label>
          <label v-for="it in impResults" :key="it.id" class="sg-impitem">
            <input type="checkbox" :checked="!!imp.picked[it.id]" @change="imp.picked = { ...imp.picked, [it.id]: !imp.picked[it.id] }" />
            <span class="sg-impn">{{ it.name }}</span><span class="mono sg-ll">{{ it.lon }}°E  {{ it.lat }}°N</span>
          </label>
          <div v-if="!impResults.length" class="sg-empty">无可导入项{{ imp.source !== 'city' ? '（请先在地图上标记点/地球站/航迹）' : '' }}</div>
        </div>
        <div class="sg-box-ft"><button class="sg-btn" @click="imp.open = false">取消</button><button class="sg-btn primary" @click="doImport">导入选中</button></div>
      </div>
    </div>

    <!-- 批量设值 -->
    <div v-if="batch.open" class="sg-mask" @click="batch.open = false">
      <div class="sg-box sg-box-sm" @click.stop>
        <div class="sg-box-hd">批量设值（应用到选中的 {{ selectedRows.length }} 行）</div>
        <div class="sg-batch">
          <select v-model="batch.key" class="sg-search"><option v-for="f in fields" :key="f.key" :value="f.key">{{ f.label }}</option></select>
          <!-- select 字段的批量值：可输入筛选（datalist）也可下拉选，输入显示名即可，doBatch 里 normalizeFieldValue 归一为存值 -->
          <template v-if="batchField.type === 'select'">
            <input v-model="batch.value" class="sg-search" list="sg-batch-opts" placeholder="输入或选择…（可输入筛选）" autocomplete="off" />
            <datalist id="sg-batch-opts"><option v-for="o in fieldOptions(batchField)" :key="optVal(o)" :value="optLabel(o)" /></datalist>
          </template>
          <input v-else v-model="batch.value" class="sg-search" :placeholder="'值（' + (batchField.unit || '') + '）'" />
        </div>
        <div class="sg-box-ft"><button class="sg-btn" @click="batch.open = false">取消</button><button class="sg-btn primary" @click="doBatch">应用</button></div>
      </div>
    </div>

    <!-- 右键菜单（Excel 式） -->
    <div v-if="menu.open" class="sg-ctx-mask" @click="menu.open = false" @contextmenu.prevent="menu.open = false">
      <div class="sg-ctx" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @click.stop @contextmenu.stop.prevent>
        <button class="sg-ctx-i" @click="menuDo(smartCopy)"><span>复制</span><kbd>Ctrl+C</kbd></button>
        <button class="sg-ctx-i" @click="menuDo(smartCut)"><span>剪切</span><kbd>Ctrl+X</kbd></button>
        <button class="sg-ctx-i" @click="menuDo(pasteRange)"><span>粘贴</span><kbd>Ctrl+V</kbd></button>
        <button class="sg-ctx-i" @click="menuDo(clearSel)"><span>清除内容</span><kbd>Del</kbd></button>
        <div class="sg-ctx-sep"></div>
        <button class="sg-ctx-i" @click="menuDo(insertAbove)">在上方插入行</button>
        <button class="sg-ctx-i" @click="menuDo(insertBelow)">在下方插入行</button>
        <button class="sg-ctx-i danger" @click="menuDo(deleteCtxRows)">删除行</button>
        <div class="sg-ctx-sep"></div>
        <button class="sg-ctx-i" :disabled="!canMoveUp" @click="menuDo(moveUp)"><span>上移一行</span><kbd>Alt+↑</kbd></button>
        <button class="sg-ctx-i" :disabled="!canMoveDown" @click="menuDo(moveDown)"><span>下移一行</span><kbd>Alt+↓</kbd></button>
        <div class="sg-ctx-sep"></div>
        <button class="sg-ctx-i" :disabled="!canHideSel" @click="menuDo(hideCols)">隐藏列</button>
        <button v-if="hiddenCols.length" class="sg-ctx-i" @click="menuDo(unhideAll)">显示所有列（{{ hiddenCols.length }}）</button>
        <button class="sg-ctx-i" @click="menuDo(clearColContents)">清除整列内容</button>
      </div>
    </div>

    <!-- 自建下拉编辑器：DOM 选项列表 + Teleport 到 body（脱离 .sg-scroll 溢出裁剪与 sticky/冻结列层叠上下文）。
         每个选项各自绑定其值并 @mousedown.prevent 提交——点谁提交谁，从结构上根除原生 <select> 弹层坐标错位「点卫星2却选中卫星1」。 -->
    <Teleport to="body">
      <div v-if="dd.open" ref="ddEl" class="sg-dd" :class="{ flip: dd.flip }" :style="dd.style" role="listbox" @contextmenu.prevent>
        <div v-for="(o, oi) in ddFiltered" :key="optVal(o)" class="sg-opt"
             :class="{ active: oi === dd.active, sel: optVal(o) === ddCurrent }"
             role="option" :aria-selected="optVal(o) === ddCurrent"
             @mousedown.left.prevent="onOptDown(o)" @mouseenter="dd.active = oi">
          <Icon class="sg-opt-ck" name="check" :size="12" />
          <span class="sg-opt-lb">{{ optLabel(o) }}</span>
        </div>
        <div v-if="!ddFiltered.length" class="sg-opt sg-opt-empty">{{ ddOptions.length ? '无匹配 · 回车录入「' + dd.query + '」' : '无选项' }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sg { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.sg-bar { display: flex; align-items: center; gap: 6px; padding: 6px 2px 8px; flex: none; flex-wrap: wrap; }
.sg-count { font-size: 12px; color: var(--text-muted); }
.sg-sp { flex: 1; }
.sg-btn { font: inherit; font-size: 12px; padding: 4px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.sg-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sg-btn:disabled { opacity: .4; cursor: not-allowed; }
.sg-btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }

.sg-scroll { flex: 1; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-box, 3px); outline: none; }
.sg-tbl { border-collapse: separate; border-spacing: 0; font-size: 12px; white-space: nowrap; }
.sg-tbl th, .sg-tbl td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); box-sizing: border-box; }
.sg-tbl th { position: sticky; top: 0; z-index: 2; padding: 5px 8px; font-weight: 600; color: var(--text-muted); text-align: left; background: var(--surface-2); }
.sg-tbl th.sg-hcol { cursor: pointer; }
.sg-tbl th.sg-hcol:hover { color: var(--text); }
.sg-tbl th.colsel { background: color-mix(in srgb, var(--accent) 24%, var(--surface-2)); color: var(--text); }
.sg-tbl th i { color: var(--text-faint); font-style: normal; font-weight: 400; }
.sg-tbl tbody tr.on > td { background: var(--surface-2); }
/* 冻结：选择列(固定 40px) + 名称区(从首列冻结到城市/名称字段，可能不止 1 列，left 由 keyColStyle() 按列动态算) */
.sg-tbl th.sg-sel, .sg-tbl td.sg-sel { position: sticky; left: 0; z-index: 1; width: 40px; min-width: 40px; max-width: 40px; padding: 4px 2px; text-align: center; white-space: nowrap; }
.sg-tbl thead th.sg-sel { z-index: 4; }
.sg-tbl td.sg-sel { cursor: pointer; user-select: none; }
.sg-tbl td.sg-sel:hover { background: var(--surface-2); }
.sg-tbl tbody tr.on > td.sg-sel { background: var(--surface-2); }
.sg-tbl tbody tr.on > td.sg-sel .sg-idx { color: var(--accent); font-weight: 700; }
.sg-idx { color: var(--text-faint); font-size: 11px; display: block; }
.sg-tbl th.sg-key, .sg-tbl td.sg-key { position: sticky; z-index: 1; width: 90px; min-width: 90px; }
.sg-tbl thead th.sg-key { z-index: 4; }
/* 单元格 */
.sg-cell { position: relative; padding: 0; cursor: cell; user-select: none; }
/* Excel 填充柄：聚焦格右下角黑色方块，悬停为十字光标 */
.sg-handle { position: absolute; right: -2px; bottom: -2px; width: 6px; height: 6px; background: var(--accent); border: 1px solid var(--bg); cursor: crosshair; z-index: 6; }
.sg-cell.fillp { outline: 1px dashed var(--accent); outline-offset: -1px; }
.sg-v { display: block; padding: 4px 6px; min-width: 76px; min-height: 22px; overflow: hidden; text-overflow: ellipsis; }
.sg-key .sg-v { min-width: 78px; }
.sg-v.mono { font-family: var(--font-mono); }
/* 留空单元格「浅显示」默认值（占位提示，非真实输入）——比正常内容更淡，用户一眼可辨 */
.sg-v.ph { color: var(--text-faint); opacity: .7; }
.sg-cell.sel { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
.sg-cell.focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.sg-tbl tbody tr.on > td.sg-cell.sel { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); }
.sg-i { width: 100%; font: inherit; font-size: 12px; padding: 3px 5px; border: 0; background: var(--surface); color: var(--text); }
.sg-i.mono { font-family: var(--font-mono); }
.sg-i:focus { outline: none; }
/* 聚焦格常驻捕获输入框：始终存在并持有键盘/输入法焦点。导航态透明覆盖在值上、pointer-events:none 让鼠标框选穿透到 td；
   一旦键入/输入法组字即翻成不透明可见编辑框。核心作用：中文输入法从第一个拼音字母起就有真实 <input> 目标，不再吞首字母。 */
.sg-cap { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; border: 0; padding: 4px 6px; font: inherit; font-size: 12px; line-height: normal; background: transparent; color: transparent; caret-color: transparent; pointer-events: none; z-index: 3; }
.sg-cap.mono { font-family: var(--font-mono); }
.sg-cap:focus { outline: none; }
.sg-cap.editing { background: var(--surface); color: var(--text); caret-color: var(--text); pointer-events: auto; z-index: 5; }
.sg-cap.editing::placeholder { color: var(--text-faint); opacity: .7; }   /* 编辑空格时输入框内仍浅显默认值，键入即消 */
.sg-act { position: sticky; right: 0; z-index: 1; white-space: nowrap; padding: 0 4px; text-align: center; width: 86px; min-width: 86px; }
.sg-tbl thead th.sg-act { z-index: 4; }
.sg-mini { font: inherit; font-size: 11px; padding: 2px 6px; margin: 2px 1px; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-mini:hover { color: var(--text); border-color: var(--border-strong); }
.sg-mini.del:hover { color: var(--danger); border-color: var(--danger); }
.sg-empty { padding: 16px; text-align: center; color: var(--text-faint); }
/* 只读末列（EIRP / G/T，计算后回填）——冻结在右侧 */
.sg-tbl th.sg-ro, .sg-tbl td.sg-ro { position: sticky; right: 0; z-index: 1; width: 1%; white-space: nowrap; text-align: right; padding: 4px 10px; background: var(--surface); color: var(--text); }
.sg-tbl thead th.sg-ro { z-index: 4; background: var(--surface-2); }
.sg-tbl td.sg-ro.mono { font-family: var(--font-mono); }
/* 只读列可框选/复制：选中高亮（基样式更具体，需在此覆写） */
.sg-tbl td.sg-ro.sel { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
.sg-tbl tbody tr.on > td.sg-ro.sel { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); }
.sg-hint { flex: none; margin: 6px 2px 0; font-size: 11px; color: var(--text-faint); }

.sg-mask { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.sg-box { width: 380px; max-height: 72vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal, 4px); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.sg-box-sm { width: 320px; }
.sg-box-hd { padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.sg-search { margin: 10px 12px; padding: 6px 9px; font: inherit; font-size: 12px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-search:focus { outline: none; border-color: var(--accent); }
.sg-list { flex: 1; overflow: auto; padding: 0 6px 8px; }
.sg-city { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px; cursor: pointer; border-radius: var(--r-ctl, 2px); font-size: 12px; }
.sg-city:hover { background: var(--surface-2); }
.sg-ll { font-size: 11px; color: var(--text-faint); }
/* 导入弹窗 */
.sg-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.sg-tab { flex: 1; font: inherit; font-size: 12px; padding: 5px 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-tab.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.sg-impall { display: flex; align-items: center; gap: 6px; padding: 6px 8px; font-size: 12px; color: var(--text-muted); border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); }
.sg-impitem { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; font-size: 12px; }
.sg-impitem:hover { background: var(--surface-2); }
.sg-impn { flex: 1; }
.sg-batch { display: flex; flex-direction: column; }
.sg-box-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 4px 12px 12px; }

/* 右键菜单（Excel 式）：满屏遮罩拦截点击关闭 + 浮层菜单 */
.sg-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.sg-ctx { position: fixed; min-width: 168px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.sg-ctx-i { display: flex; align-items: center; justify-content: space-between; gap: 16px; font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl, 2px); white-space: nowrap; }
.sg-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.sg-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.sg-ctx-i.danger:hover { color: var(--danger); }
.sg-ctx-i kbd { font: inherit; font-size: 10px; color: var(--text-faint); background: var(--surface-2); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; }
.sg-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }

/* select 单元格下拉指示 chevron：单击即开的热区，pointer-events 高于透明捕获框(.sg-cap z3) */
.sg-caret { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 18px; color: var(--text-faint); cursor: pointer; z-index: 6; pointer-events: auto; transition: transform .12s, color .12s; }
.sg-cell:hover .sg-caret, .sg-cell.focus .sg-caret { color: var(--text-muted); }
.sg-caret.open { color: var(--accent); transform: translateY(-50%) scaleY(-1); }
.sg-v.has-caret { padding-right: 18px; }
.sg-cap.combo { padding-right: 20px; }   /* 组合框输入：右留位给 chevron，打字不压住箭头 */
/* 自建下拉列表（Teleport 到 body，fixed 定位；层级高于 sticky 表头/冻结列 z4，低于模态遮罩 z200） */
.sg-dd { position: fixed; z-index: 250; min-width: 96px; max-height: 320px; padding: 3px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); box-shadow: 0 6px 20px rgba(0,0,0,.22); font-size: 12px; }
.sg-dd.flip { box-shadow: 0 -6px 20px rgba(0,0,0,.22); }
.sg-opt { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; border-radius: var(--r-ctl, 2px); color: var(--text); white-space: nowrap; user-select: none; }
.sg-opt:hover { background: var(--surface-2); }
.sg-opt.active { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); }
.sg-opt.sel { color: var(--accent); font-weight: 600; }
.sg-opt-ck { flex: none; width: 12px; color: var(--accent); }
.sg-opt:not(.sel) .sg-opt-ck { visibility: hidden; }   /* 占位对齐，未选中项留白 */
.sg-opt-lb { flex: 1; overflow: hidden; text-overflow: ellipsis; }
.sg-opt-empty { color: var(--text-faint); cursor: default; justify-content: center; }
.sg-opt-empty:hover { background: transparent; }
</style>
