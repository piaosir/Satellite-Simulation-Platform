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
  selectOptions: { type: Object, default: () => ({}) }, // { 字段key: [选项…] }，覆盖该 select 字段的静态 options（用于运行时动态选项，如载波信号库）
  // 库引用列（{ 字段key: 资源库子栏key }，如 { basebandId: 'carrier', stationId: 'station' }）：这些 select
  // 列的值是资源库条目 id，格内与下拉项各挂一个「编辑参数」钮，点击 emit('editLib', 子栏key, 条目id)，
  // 由 App 展开资源库、切到该子栏并选中该条目——与卫星分区节头「编辑参数」同一去处。不传即空表，行为不变。
  libFields: { type: Object, default: () => ({}) },
  // 动态只读字段（按字段 key）：这些字段**可选中/可复制但不可编辑**（雨衰计算的结果列 / GEO 模式的
  // 仰角 / 自动降雨模型的 R0.01）。加法式：不传即空数组，链路预算 GEO/NGSO/Regen 行为完全不变。
  readonlyKeys: { type: Array, default: () => [] },
  // 计算列（f.ro 字段）的值来源：{ 行_id: { 字段key: 值 } }。计算列不存行数据（避免结果写回触发
  // 存档/过期 watcher 的连锁），显示/复制一律取此映射；未算出显示 '—'。
  extraValues: { type: Object, default: null },
  // 两层表头：列组行。传 [{ key, label }]，字段按 f.group 归组（相邻同组并为一个跨列头）。
  groups: { type: Array, default: null },
  // 单元格附加 class 钩子 (field, row) => class：结果列按合格/超限着色等
  cellClass: { type: Function, default: null },
  showImport: { type: Boolean, default: true },        // 导入城市库/点标记/地球站/航迹——纯地理点导入；星间链路（星→星，无经纬度）表关掉
  // 单元格「第二行小字」钩子 (field, row) => string|null：在单元格值下方渲染一行只读小字（链路表用它把实时 EIRP/G·T 挂到「地球站配置」格下方，替代原独立列）
  cellSub: { type: Function, default: null },
  // 单元格「行内尾标」钩子 (field, row) => string|null：跟在单元格值后面、同一行的一枚淡色小字
  // （链路表用它把发信站实时算出的功放功率贴在「地球站配置」名之后，正在第二行小字 EIRP 之上）；返回空即不加。
  cellTag: { type: Function, default: null },
  // 单元格「占比填充条」钩子 (field, row) => 0..1 或 null：在格底画按值比例的数据条（链路表功率/带宽占用列）；
  // 返回 null / 非正数即不画，>1 封顶铺满（超限着色由 cellClass 的 st-bad 接手）。
  cellFill: { type: Function, default: null },
  // 冻结「关键列」（首列起到城市列/frozen前缀的粘性左固定列）。默认 true 保持旧行为；链路表传 false 取消冻结、全列随横滚
  freezeKeys: { type: Boolean, default: true },
})
// rowFocus (行下标, 行_id)：聚焦行变化（链路表联动详细预算）
// editLib (资源库子栏key, 条目id)：库引用列的「编辑参数」钮 → App 导航到资源库该条目
const emit = defineEmits(['rowFocus', 'editLib'])
// 某列是否只读（按字段 key 判定，动态；f.ro 计算列恒只读）
const isReadonlyCol = (c) => { const f = props.fields[c]; return !!(f && (f.ro || props.readonlyKeys.includes(f.key))) }
// 计算列取值（extraValues 映射）
const roVal = (s, f) => { const m = props.extraValues && props.extraValues[s._id]; const v = m ? m[f.key] : undefined; return v == null || v === '' ? '—' : v }
// 占比填充条宽度（0..1）：钩子缺省或返回非正/非数即不画；>1 封顶（宽度铺满，超限着色走 st-bad）
const fillFrac = (f, s) => { if (!props.cellFill) return null; const v = props.cellFill(f, s); return typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(1, v) : null }
// 占比填充条色阶（四档，阈值 25/50/75%）：按未封顶的原始占比取档，>75%（含超 100%）统一落 lv4。
// 档位类挂在 .sg-fillbar 上，色值 --lb-lv1..4 见 lbworkbench.css
const fillLv = (f, s) => { const v = props.cellFill ? props.cellFill(f, s) : 0; return v > 0.75 ? 'lv4' : v > 0.5 ? 'lv3' : v > 0.25 ? 'lv2' : 'lv1' }
// 列组表头：按可见字段的 f.group 相邻归并成跨列头（组标签取 groups prop）
const headerGroups = computed(() => {
  if (!props.groups || !props.groups.length) return null
  const byKey = Object.fromEntries(props.groups.map((g) => [g.key, g.label]))
  const out = []
  for (const { f } of visFields.value) {
    const label = byKey[f.group] || ''
    const last = out[out.length - 1]
    if (last && last.g === (f.group || '')) last.span++
    else out.push({ g: f.group || '', label, span: 1 })
  }
  return out
})
// 组边界列：某可见列的下一可见列不同组 → 该列即「组末列」（整表末列不算，右边没有下一个组）。
// 分区线画在组末列的右框上（.sg-gend）——那里本就有一根格线，加深它即可，不必新增一根。
const groupEndCols = computed(() => {
  const out = new Set()
  if (!props.groups || !props.groups.length) return out
  const vis = visFields.value
  for (let i = 0; i < vis.length - 1; i++) {
    if ((vis[i].f.group || '') !== (vis[i + 1].f.group || '')) out.add(vis[i].c)
  }
  return out
})
const isGroupEnd = (c) => groupEndCols.value.has(c)

const root = ref(null)
// 站址组（名称+经纬度三键一组）：链路表一行可含发/收两个站址组（f.city='tx'/'rx' 各一组）。
// 城市字段可显式声明配对键（f.lonKey/f.latKey）；未声明（单站址旧表）回退全表正则探测，行为不变。
const geoGroups = computed(() => {
  const legacyLon = (props.fields.find((f) => /longitude/i.test(f.key)) || {}).key
  const legacyLat = (props.fields.find((f) => /latitude/i.test(f.key)) || {}).key
  return props.fields.filter((f) => f.city).map((f) => ({ name: f.key, lon: f.lonKey || legacyLon, lat: f.latKey || legacyLat, kind: f.city }))
})
// 某键所属的站址组（名称/经度/纬度任一命中）
const geoOfKey = (key) => geoGroups.value.find((g) => g.name === key || g.lon === key || g.lat === key) || null
const nCol = computed(() => props.fields.length)
// 冻结列：优先取字段显式 frozen 标记的「前缀连续段」长度（列与城市字段位置解耦，可任意调列序仍固定冻结几列，
// 再生式站表在用）；无 frozen 标记时回退旧启发式——从第一列起冻结到「名称/城市」字段（含）为止。
const cityFieldIdx = computed(() => props.fields.findIndex((f) => f.city))
const frozenPrefix = computed(() => { let n = 0; for (const f of props.fields) { if (f.frozen) n++; else break } return n })
// freezeKeys=false（链路表）：不冻结任何数据列，全列随横滚（序号列 sg-sel 仍单独粘性固定，属行手柄不算数据列）
const frozenCount = computed(() => (!props.freezeKeys ? 0 : (frozenPrefix.value > 0 ? frozenPrefix.value : (cityFieldIdx.value >= 0 ? cityFieldIdx.value + 1 : 1))))
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
// Tab/Shift+Tab：走到本行末列换到下一行首列（反向亦然），与 Excel 一致——旧版夹在末列原地不动，
// 一行填到头就得手动回首列。到表尾/表首无处可换时保持原地。
function tabMove(back) {
  const vis = visSelCols.value
  if (!vis.length) return
  const i = vis.indexOf(range.fc)
  if (!back && i === vis.length - 1) { if (range.fr < props.stations.length - 1) setFocus(range.fr + 1, vis[0], false); return }
  if (back && i === 0) { if (range.fr > 0) setFocus(range.fr - 1, vis[vis.length - 1], false); return }
  setFocus(range.fr, visColAfter(range.fc, back ? -1 : 1), false)
}
// 取单元格文本（复制用）：只读列取其计算值；select 字段取显示名（而非内部存值 id）——这样复制出去
// 看到的就是名字，粘贴回来时 normalizeFieldValue() 也能按名字正确匹配回对应选项，名字和值的口径统一。
function cellText(s, c) { return isRO(c) ? (props.roValues[s._id] != null ? props.roValues[s._id] : '') : displayValue(s, props.fields[c]) }
// select 字段选项：优先用父组件传入的动态选项（如载波信号库），否则用字段静态 options。
// 选项元素可以是普通字符串，也可以是 { value, label }（用于值与显示名不同，如载波信号配置 id→名称）。
function fieldOptions(f) { return props.selectOptions[f.key] || f.options || [] }
const optVal = (o) => (o && typeof o === 'object') ? o.value : o
const optLabel = (o) => (o && typeof o === 'object') ? o.label : o
// 该列是否为库引用列 → 返回其资源库子栏 key（'carrier'/'station'/'sat'），否则 null
const libOf = (f) => (f && f.type === 'select' ? (props.libFields[f.key] || null) : null)
// 格内「编辑参数」钮：先把焦点落到本格（详细预算随之切到该行），再让 App 导航到资源库的对应条目。
// 值留空（显示「（默认）」）时传空串——资源库按其自身口径落到首份配置，与引擎「空→第一份」一致。
function editLibCell(r, c) {
  const f = props.fields[c]
  const lib = libOf(f)
  if (!lib) return
  if (editing.value) endEdit()
  setFocus(r, c, false)
  const v = props.stations[r][f.key]
  emit('editLib', lib, v == null ? '' : v)
}
// 下拉项内「编辑参数」钮：编辑的是该选项对应的条目，**不改变本行选择**（选值仍走点标签本身）
function editLibOpt(o) {
  const f = ddField.value
  const lib = libOf(f)
  if (!lib) return
  const v = optVal(o)
  endEdit()   // 关下拉、收编辑态（select 的 endEdit 只做值归一，本行选择未动）
  emit('editLib', lib, v == null ? '' : v)
}
// 单元格显示值：select 字段按选项表把存值换算成展示名，其余原样。
// 旧数据（升级前保存、缺该字段）值为 undefined，按空字符串对待以匹配“（默认）”选项。
function displayValue(s, f) {
  if (f.ro) return roVal(s, f)   // 计算列：显示/复制一律取 extraValues 映射
  if (f.type !== 'select') return s[f.key]
  const v = s[f.key] == null ? '' : s[f.key]
  const hit = fieldOptions(f).find((o) => optVal(o) === v)
  return hit ? optLabel(hit) : s[f.key]
}
// 单元格留空时「浅显示」的默认值（占位提示，对标 Handsontable placeholder + placeholderCellClassName）：
// 值真为空且该字段有非空默认值时返回其显示文本，否则 ''。params.js 的 f.def 即引擎 pickNum 的「空→默认」
// 回退值（口径严格对齐），故这里显示的就是留空实际会按之计算的值——让用户一眼看到默认，不必去猜。
// 灰字仅为提示、非真实数据：复制/导出仍取空（cellText 走 displayValue，与 Excel 占位一致）。
function ghost(s, f) {
  if (f.ro) return ''   // 计算列无默认占位
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
const isLatLonKey = (key) => geoGroups.value.some((g) => g.lon === key || g.lat === key)
function clampLatLon(val) {
  const s = String(val == null ? '' : val).trim()
  if (s === '') return s
  const n = Number(toHalf(s))                                                        // 全角减号/数字归一，负数经纬度可解
  return Number.isFinite(n) ? String(Number(n.toFixed(LATLON_DECIMALS))) : val
}

// 城市名归一：去全部空白（含全角空格）+ 小写。库内城市名不带行政后缀（是「北京」不是「北京市」），
// 故再给一个去后缀的宽松键，让 Excel 里常见的「北京市 / 香港特别行政区」也能对上（库名无这些后缀，不会引入歧义）。
const cityKey = (s) => String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase()
const cityKeyLoose = (s) => cityKey(s).replace(/(?:特别行政区|自治区|地区|市)$/, '')
// 按名字查城市库：先归一后精确匹配，再退一步用去后缀的宽松键。查不到返回 null（不猜、不模糊，免得静默写错坐标）。
function findCityByName(name) {
  const k = cityKey(name)
  if (!k) return null
  const list = props.cities
  const hit = list.find((c) => c && c.name != null && cityKey(c.name) === k)
  if (hit) return hit
  const lk = cityKeyLoose(name)
  return (lk && lk !== k) ? (list.find((c) => c && c.name != null && cityKey(c.name) === lk) || null) : null
}
// 地球站名称命中城市库 → 自动带入该城市经纬度（写入所属站址组）。
// keep：本轮已显式带入经/纬度的键（整行粘贴/填充场景）——名字反查不得覆盖它们。
// 返回经纬度是否真的被改写（命中但坐标本就一致时返回 false）；调用方据此联动 autoGeo 补降雨/海拔，
// 避免无谓重算把手改的降雨率/海拔冲掉，也免得整表粘贴时打出成百次无用的 geoFill。
function applyCityByName(row, g, keep) {
  if (!g || !props.cities.length) return false
  const hit = findCityByName(row[g.name])
  if (!hit) return false
  let changed = false
  for (const [key, val] of [[g.lon, hit.lon], [g.lat, hit.lat]]) {
    if (!key || val == null || (keep && keep.has(key))) continue
    const v = clampLatLon(val)
    if (row[key] !== v) { row[key] = v; changed = true }
  }
  return changed
}
// 粘贴/填充/批量设值写完一行后统一收口：把本轮写进「地球站位置」列的名字按城市库反查经纬度
// （不覆盖本轮显式带入的经纬度），命中改写的站址组并入 coordKinds，由调用方联动 autoGeo 补降雨/海拔
// ——批量写入路径与单格编辑（endEdit）口径一致：填名字即带出站址。
function applyCityForNames(row, nameKinds, keepCoord, coordKinds) {
  for (const kind of nameKinds) {
    const g = geoGroups.value.find((x) => x.kind === kind)
    if (g && applyCityByName(row, g, keepCoord)) coordKinds.add(kind)
  }
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
function addRow(atEnd) {
  const at = atEnd === true ? props.stations.length : (props.stations.length ? Math.min(props.stations.length, range.fr + 1) : 0)
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
  const rowChanged = range.fr !== r
  range.fr = r; range.fc = c
  if (!extend) { range.ar = r; range.ac = c }
  // 聚焦行变化通知父组件（链路表：联动下方「详细预算」切到该行链路）
  if (rowChanged && props.stations[r]) emit('rowFocus', r, props.stations[r]._id)
}
// 聚焦格的常驻捕获输入框（导航/编辑共用同一个真实 <input>，见模板 .sg-cap）：焦点始终落在它上，
// 中文输入法从首个拼音字母起就有真实可编辑目标，不再吞首字母。RO 列等无捕获框的格退回聚焦容器本身。
function capEl() { return root.value ? root.value.querySelector('input.sg-cap') : null }
// 取焦点一律 preventScroll —— 原生 focus() 会顺手把元素「滚进视野」，而它不认 sticky：序号列/冻结列/表头
// 在它眼里是普通内容，只要格子进了滚动容器的内容盒就收工，于是刚点的格被滚到序号列底下；更糟的是它会
// 连所有可滚祖先一起滚（分节流 .lbx-flow），点一格整页乱跳、底部横条自己跑。滚动改由 ensureVisible() 接管。
function focusGrid() {
  nextTick(() => {
    const el = capEl()
    if (el) el.focus({ preventScroll: true })
    else if (root.value) root.value.focus({ preventScroll: true })
    ensureVisible()
  })
}
// —— 聚焦格可见性（Excel 口径：只补差额的最小滚动）——
// sticky 覆盖层（左：序号列+冻结列；上：表头；右：只读末列）按「可视内容区」内缩掉，聚焦格才不会藏在它们后面；
// 用 clientWidth/clientHeight 而非 rect 宽高，滚动条占位也自然扣除。鼠标框选/拖填充期间不介入（光标本就在格上）。
function stickyPads() {
  const el = root.value
  const idx = el.querySelector('thead th.sg-sel')
  const head = el.querySelector('thead')
  const ro = props.roLabel ? el.querySelector('thead th.sg-ro') : null
  return {
    left: frozenCount.value > 0 ? 40 + frozenCount.value * KEY_COL_W : (idx ? idx.offsetWidth : 34),   // 与 keyColStyle() 同一口径
    top: head ? head.offsetHeight : 0,
    right: ro ? ro.offsetWidth : 0
  }
}
function ensureVisible(c) {
  if (dragging || fill.active || rowDragging || colDragging) return
  const el = root.value; if (!el) return
  const cell = el.querySelector('.sg-cell.focus'); if (!cell) return
  const col = c == null ? range.fc : c
  const pad = stickyPads()
  const cr = cell.getBoundingClientRect(), sr = el.getBoundingClientRect()
  if (!(isKeyCol(col) || isRO(col))) {          // 冻结列/只读末列本就常驻可见，横向不动（否则每次都被顶回 scrollLeft=0）
    const vl = sr.left + pad.left, vr = sr.left + el.clientWidth - pad.right
    let dx = 0
    if (cr.right > vr) dx = cr.right - vr
    if (cr.left - dx < vl) dx = cr.left - vl     // 格比可视区还宽时靠左对齐（与 Excel 一致）
    if (dx) el.scrollLeft += dx
  }
  const vt = sr.top + pad.top, vb = sr.top + el.clientHeight
  let dy = 0
  if (cr.bottom > vb) dy = cr.bottom - vb
  if (cr.top - dy < vt) dy = cr.top - vt
  if (dy) el.scrollTop += dy
}
// 滚轮（Excel 口径）：竖滚只管纵向，横滚只认 Shift+滚轮/触控板横向手势。
// 表内纵向滚不动时（分节流里站表按内容自适应高、纵滚统一交给页面）把竖滚原样转给最近的可滚祖先——
// 因为 Chromium 对「只有横向能滚」的容器会把竖滚折成横滚，那是「底部横条自己乱跑」的另一半原因；
// 祖先也滚不动就直接吞掉（Excel 到底了就是不动），绝不拿竖滚去挪横条。
function scrollableAncestorY(el) {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const ov = getComputedStyle(p).overflowY
    if ((ov === 'auto' || ov === 'scroll') && p.scrollHeight - p.clientHeight > 1) return p
  }
  return null
}
function onWheel(e) {
  const el = root.value
  if (!el || e.ctrlKey || e.shiftKey) return                                  // 缩放 / Shift 横滚：交给原生
  const dy = e.deltaY
  if (!dy || Math.abs(e.deltaX) >= Math.abs(dy)) return                       // 横向手势：原生横滚
  const room = el.scrollHeight - el.clientHeight
  if (room > 1 && (dy > 0 ? el.scrollTop < room - 1 : el.scrollTop > 1)) return   // 表内还能纵滚：原生
  e.preventDefault()
  const anc = scrollableAncestorY(el)
  if (anc) anc.scrollTop += dy * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? anc.clientHeight : 1)
}

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

// 拖拽（框选/填充/选行）到容器边缘时自动滚动，使底部滚动条跟随。
// 速度按越界距离渐进（Excel 式加速：贴着边缘慢慢挪、甩远了快滚），旧版恒定 16px/帧一碰边就窜出去。
let scrollRAF = null, scrollVX = 0, scrollVY = 0
const edgeVel = (over) => Math.min(30, 2 + over * 0.45)
function onDragMove(e) {
  if (!(dragging || fill.active || rowDragging || colDragging)) { stopAutoScroll(); return }
  const el = root.value; if (!el) return
  const r = el.getBoundingClientRect(), edge = 28
  const right = r.left + el.clientWidth, bottom = r.top + el.clientHeight   // 扣掉滚动条占位，鼠标压在横条上不算越界
  scrollVX = e.clientX > right - edge ? edgeVel(e.clientX - (right - edge)) : (e.clientX < r.left + edge ? -edgeVel((r.left + edge) - e.clientX) : 0)
  scrollVY = e.clientY > bottom - edge ? edgeVel(e.clientY - (bottom - edge)) : (e.clientY < r.top + edge ? -edgeVel((r.top + edge) - e.clientY) : 0)
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
    const coordKinds = new Set()       // 填充改动了哪些站址组的经纬度 → 按组联动 autoGeo（与粘贴/单格编辑口径一致）
    const filledAuto = new Set()       // 填充已显式带入的降雨/海拔列：重算时跳过，不覆盖填充值
    const nameKinds = new Set()        // 填充写了哪些站址组的「地球站位置」→ 按名字反查城市库带出经纬度
    const keepCoord = new Set()        // 本轮显式填入的经/纬度键：名字反查不得覆盖
    for (let c = c0_; c <= c1_; c++) {
      if (isRO(c) || isReadonlyCol(c)) continue
      const f = props.fields[c]; const v = srcRow[f.key]
      const g = geoOfKey(f.key)
      const nonEmpty = String(v == null ? '' : v).trim() !== ''
      if (g && f.key === g.name) { if (nonEmpty) nameKinds.add(g.kind) }
      else if (g) { if (row[f.key] !== v) coordKinds.add(g.kind); if (nonEmpty) keepCoord.add(f.key) }
      if (f.auto && nonEmpty) filledAuto.add(f.key)
      row[f.key] = v
    }
    applyCityForNames(row, nameKinds, keepCoord, coordKinds)
    if (props.autoGeo) for (const kind of coordKinds) props.autoGeo(row, filledAuto, kind)
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
  if (isRO(c) || isReadonlyCol(c)) return   // 只读列 / 只读字段不可编辑
  const f = props.fields[c]
  if (f.type === 'select') { openDropdown(r, c); return }   // select：委托自建下拉列表（替代原生 <select>）
  _editOrig = props.stations[r][f.key]
  editing.value = { r, c, typed: false }
  nextTick(() => {
    const el = capEl()
    if (!el) return
    el.value = _editOrig == null ? '' : String(_editOrig)   // 带出原值供编辑
    el.focus({ preventScroll: true })
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
    const g = f && geoOfKey(f.key)
    if (g && f.key === g.name) {
      // 名称真的改动且命中城市库 → 带入该站址组经纬度，并联动 autoGeo 重算降雨/海拔
      if (row[f.key] !== _editOrig && applyCityByName(row, g) && props.autoGeo) props.autoGeo(row, undefined, g.kind)
    } else if (g && props.autoGeo) {
      if (row[f.key] !== _editOrig) props.autoGeo(row, undefined, g.kind)   // 仅坐标真的改动才重算降雨/海拔，避免 Enter/Tab 掠过未改坐标时清掉手改值
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
  else if (e.key === 'Tab') { endEdit(); tabMove(e.shiftKey); e.preventDefault() }
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
  if (isReadonlyCol(c)) return   // 只读字段：忽略输入法组字
  if (props.fields[c].type === 'select') { if (!dd.open) openDropdown(r, c); return }   // select：组字即开组合框（输入用于过滤）
  beginCapEdit(r, c)
}
function onCapInput(e, r, c) {
  if (isReadonlyCol(c)) { e.target.value = ''; return }   // 只读字段：不接受键入
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
function onRootFocus() { if (editing.value) return; const el = capEl(); if (el) el.focus({ preventScroll: true }) }

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
    if (el) { el.value = dd.query; el.focus({ preventScroll: true }); if (el.setSelectionRange) { const n = el.value.length; try { el.setSelectionRange(n, n) } catch (e) { /* ignore */ } } }
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
  if (isReadonlyCol(c)) return   // 只读 select 字段：不弹下拉
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
  nextTick(() => { const el = ddEl.value; if (!el) return; const a = el.querySelector('.sg-opt.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' }) })
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
  if (e.key === 'Tab') { props.stations[dd.r][props.fields[dd.c].key] = ddCommitValue(); endEdit(); tabMove(e.shiftKey); e.preventDefault(); return }
  if (e.key === 'Escape') { cancelEdit(); e.preventDefault(); return }
}

function clearSel() {
  pushUndo()
  for (let r = r0.value; r <= r1.value; r++) for (let c = c0.value; c <= c1.value; c++) if (!isRO(c) && !isReadonlyCol(c)) props.stations[r][props.fields[c].key] = ''
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
    const coordKinds = new Set()       // 该行哪些站址组的经纬度被粘贴改动 → 按组联动 autoGeo 重算降雨/海拔
    const pastedAuto = new Set()       // 粘贴已显式带入的降雨/海拔列（如整行复制）：重算时跳过，不覆盖粘贴值
    const nameKinds = new Set()        // 粘贴写了哪些站址组的「地球站位置」→ 按名字反查城市库带出经纬度
    const keepCoord = new Set()        // 本轮显式粘贴的经/纬度键：名字反查不得覆盖（整行复制时粘贴值优先）
    for (let j = 0; j < outC; j++) {
      const c = sc + j
      const src = grid[i % gR][j % gC]
      if (src === undefined) continue
      if (c < nColSel.value && !isRO(c) && !isReadonlyCol(c)) {
        const f = props.fields[c]
        const v = isLatLonKey(f.key) ? clampLatLon(src) : normalizeFieldValue(f, src)
        const g = geoOfKey(f.key)
        const nonEmpty = String(v == null ? '' : v).trim() !== ''
        if (g && f.key === g.name) { if (nonEmpty) nameKinds.add(g.kind) }
        else if (g) { if (row[f.key] !== v) coordKinds.add(g.kind); if (nonEmpty) keepCoord.add(f.key) }
        if (f.auto && nonEmpty) pastedAuto.add(f.key)
        row[f.key] = v
      }
    }
    applyCityForNames(row, nameKinds, keepCoord, coordKinds)
    if (props.autoGeo) for (const kind of coordKinds) props.autoGeo(row, pastedAuto, kind)
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
  if (mod) {   // Ctrl+方向：跳到数据区边缘（链路表数据连续，等价于首/末行、首/末列），加 Shift 为扩选——与 Excel 一致
    const a = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key]
    if (a) {
      collapseRowSel()
      const r = a[0] ? (a[0] < 0 ? 0 : props.stations.length - 1) : range.fr
      const c = a[1] ? (a[1] < 0 ? firstVisSelCol() : lastVisSelCol()) : range.fc
      setFocus(r, c, e.shiftKey); e.preventDefault()
    }
    return
  }
  if (e.key === 'F2') { startEdit(range.fr, range.fc); e.preventDefault(); return }
  if (e.key === 'Enter') { collapseRowSel(); setFocus(range.fr + (e.shiftKey ? -1 : 1), range.fc); e.preventDefault(); return }   // Excel：Enter 下移、Shift+Enter 上移（编辑用 F2/双击/直接键入）
  if (e.key === 'Tab') { collapseRowSel(); tabMove(e.shiftKey); e.preventDefault(); return }
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
  nextTick(() => {
    const el = capEl()
    if (el) el.focus({ preventScroll: true })
    else if (root.value) root.value.focus({ preventScroll: true })
    ensureVisible()
  })
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
// Quick Pick 式（对齐 VS Code）：面板锚在列头导入钮下方，即点即入、可连续导入；
// hl=键盘高亮下标，added=本会话各项已导入次数（√×N 回显），addedN=本次共加行数；
// other=钉住的「另一端」站（{id,name,lon,lat}，null=对侧用字段默认如北京）——解决
// 「导入发信站后收信站全是默认北京」：先 ⇄ 钉某站为另一端，再连点导入，每行对侧都写它
const imp = reactive({ open: false, source: 'city', query: '', side: '', hl: 0, added: {}, addedN: 0, style: null, other: null })
const impSearchEl = ref(null)
// 对侧站址组（链路表发/收两组时才有）与其字段默认站名（另一端未钉时的去向，用于回显）
const impOtherGroup = computed(() => geoGroups.value.find((x) => x.kind !== imp.side) || null)
const impOtherDefault = computed(() => { const og = impOtherGroup.value; if (!og) return ''; const f = props.fields.find((x) => x.key === og.name); return (f && f.def) || '' })
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
const IMPORT_LIST_CAP = 1000   // 导入列表展示上限（城市库 349 项可一次看全，亦留余量给点标记/航迹）
const impResults = computed(() => {
  if (useCitySearch.value) return cityHits.value.slice(0, IMPORT_LIST_CAP)
  const q = imp.query.trim().toLowerCase()
  const l = q ? impItems.value.filter((it) => it.name.toLowerCase().includes(q) || String(it.lon).includes(q)) : impItems.value
  return l.slice(0, IMPORT_LIST_CAP)
})
// kind（'tx'/'rx'，来自「地球站位置」列头导入钮）：预选站址写入侧；ev 用于把面板锚在按钮下方
function openImport(kind, ev) {
  imp.open = true; imp.query = ''; imp.hl = 0; imp.added = {}; imp.addedN = 0; imp.other = null
  imp.side = (typeof kind === 'string' && kind) ? kind : ((geoGroups.value[0] || {}).kind || '')
  const W = 380
  const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : null
  if (r) {
    const left = Math.max(8, Math.min(r.left - 10, window.innerWidth - W - 8))
    const top = Math.min(r.bottom + 4, window.innerHeight - 180)
    imp.style = { left: left + 'px', top: top + 'px', width: W + 'px', maxHeight: Math.max(220, window.innerHeight - top - 12) + 'px' }
  } else {
    imp.style = { left: '50%', top: '110px', transform: 'translateX(-50%)', width: W + 'px' }   // 防御：无锚事件时居中
  }
  nextTick(() => { if (impSearchEl.value) impSearchEl.value.focus({ preventScroll: true }) })
}
function setSource(k) { imp.source = k; imp.query = ''; imp.hl = 0 }
// 关闭：有导入过则把网格焦点落到最后加的行的该侧站址列（接着就能改別的列）
function closeImport() {
  imp.open = false
  if (imp.addedN > 0 && props.stations.length) {
    const g = geoGroups.value.find((x) => x.kind === imp.side) || geoGroups.value[0] || null
    const ci = g ? props.fields.findIndex((f) => f.key === g.name) : -1
    setFocus(props.stations.length - 1, ci >= 0 ? ci : (cityFieldIdx.value >= 0 ? cityFieldIdx.value : firstVisSelCol()), false)
  }
}
// 即点即入：每批一步 undo（单点=1 行，「全部导入」=一步撤全批）；面板不关，可连续导入
function importItems(items) {
  if (!items.length) return
  // 目标站址组：多站址表（链路表发/收两组）按面板所选一侧写入，单站址表即唯一一组
  const g = geoGroups.value.find((x) => x.kind === imp.side) || geoGroups.value[0] || null
  const og = impOtherGroup.value
  pushUndo()
  for (const it of items) {
    const row = defaultsFor(props.fields); row._id = 'r' + (_rowSeq++)
    if (g) {
      row[g.name] = it.name
      if (g.lon && it.lon != null) row[g.lon] = clampLatLon(it.lon)
      if (g.lat && it.lat != null) row[g.lat] = clampLatLon(it.lat)
    }
    // 对侧：钉了「另一端」则写它（覆盖字段默认的北京），未钉维持默认
    if (imp.other && og) {
      row[og.name] = imp.other.name
      if (og.lon && imp.other.lon != null) row[og.lon] = clampLatLon(imp.other.lon)
      if (og.lat && imp.other.lat != null) row[og.lat] = clampLatLon(imp.other.lat)
    }
    props.stations.push(row)
    if (props.autoGeo && g) props.autoGeo(row, undefined, g.kind)
    if (props.autoGeo && og && imp.other) props.autoGeo(row, undefined, og.kind)
    imp.added[it.id] = (imp.added[it.id] || 0) + 1
    imp.addedN++
  }
}
function importAll() { importItems(impResults.value) }
// 搜索框键盘流：↑/↓ 移动高亮（循环）、Enter 导入高亮项、Esc 关闭；焦点始终留在搜索框
function onImpKey(e) {
  const n = impResults.value.length
  if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { imp.hl = (imp.hl + 1) % n; scrollImpHl() } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { imp.hl = (imp.hl - 1 + n) % n; scrollImpHl() } }
  else if (e.key === 'Enter') { e.preventDefault(); const it = impResults.value[Math.min(imp.hl, n - 1)]; if (it) importItems([it]) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeImport() }
}
function scrollImpHl() { nextTick(() => { const el = document.querySelector('.sg-imppop .sg-impitem.hl'); if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }) }) }

// —— 批量设值（选中行）——
const batch = reactive({ open: false, key: '', value: '' })
function openBatch() { if (!selectedRows.value.length) return; batch.key = props.fields[0].key; batch.value = ''; batch.open = true }
function doBatch() {
  if (props.readonlyKeys.includes(batch.key)) { batch.open = false; return }   // 只读字段：批量设值无效
  pushUndo()
  const v = isLatLonKey(batch.key) ? clampLatLon(batch.value) : normalizeFieldValue(batchField.value, batch.value)
  const bg = geoOfKey(batch.key)
  const isNameKey = !!bg && batch.key === bg.name   // 批量设的是「地球站位置」→ 按名字反查城市库带出经纬度
  for (const s of selectedRows.value) {
    const coordChanged = isLatLonKey(batch.key) && s[batch.key] !== v
    s[batch.key] = v
    const cityHit = isNameKey && applyCityByName(s, bg)
    if ((coordChanged || cityHit) && props.autoGeo && bg) props.autoGeo(s, undefined, bg.kind)   // 批量设经纬度/站名同样联动重算降雨/海拔
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
      <button class="sg-btn" title="在聚焦行下方插入一行（表为空则新建首行）" @click="addRow()"><Icon name="plus" :size="12" /> 增加行</button>
      <button class="sg-btn" :disabled="!selectedRows.length" @click="openBatch">批量设值</button>
      <button class="sg-btn" :disabled="!selectedRows.length" @click="removeSelected">删除选中</button>
      <button class="sg-btn" :disabled="!stations.length" @click="clearAll">清空</button>
      <button class="sg-btn" :disabled="!undoStack.length" title="撤销" @click="undo"><Icon name="undo-2" :size="12" /></button>
      <button class="sg-btn" :disabled="!redoStack.length" title="重做" @click="redo"><Icon name="redo-2" :size="12" /></button>
      <button class="sg-btn" :disabled="!canMoveUp" title="上移一行（Alt+↑）" @click="moveUp"><Icon name="arrow-up" :size="12" /> 上移</button>
      <button class="sg-btn" :disabled="!canMoveDown" title="下移一行（Alt+↓）" @click="moveDown"><Icon name="arrow-down" :size="12" /> 下移</button>
      <button v-if="hiddenCols.length" class="sg-btn" :title="'已隐藏 ' + hiddenCols.length + ' 列，点击全部显示'" @click="unhideAll">显示隐藏列（{{ hiddenCols.length }}）</button>
    </div>

    <div ref="root" class="sg-scroll" tabindex="0" @keydown="onKey" @focus="onRootFocus" @wheel="onWheel">
      <table class="sg-tbl" :class="{ 'has-g': headerGroups }">
        <thead>
          <!-- 列组行（两层表头首行）：字段按 f.group 相邻归并跨列；仅顶部吸附（横滚时组名随普通列滚动属预期） -->
          <tr v-if="headerGroups" class="sg-ghd">
            <th class="sg-sel sg-gpad"></th>
            <th v-for="(g, gi) in headerGroups" :key="gi" :colspan="g.span" class="sg-gcol"
                :class="['g-' + g.g, { 'sg-gend': gi < headerGroups.length - 1 }]">
              <span class="sg-glbl">{{ g.label }}</span>
            </th>
            <th v-if="roLabel" class="sg-gcol"></th>
          </tr>
          <tr>
            <th class="sg-sel"><input type="checkbox" :checked="allSelected" @change="toggleAll" /></th>
            <th v-for="({ f, c }) in visFields" :key="f.key" class="sg-hcol" :class="{ 'sg-key': isKeyCol(c), colsel: colHeadSel(c), 'sg-gend': isGroupEnd(c) }" :style="isKeyCol(c) ? keyColStyle(c) : null" :title="f.tip || f.label"
                @mousedown.left="onHeaderDown(c, $event)" @mouseenter="onHeaderEnter(c)">
              {{ f.label }}<i v-if="f.unit"> ({{ f.unit }})</i>
              <!-- 站址组锚点列（地球站位置）：列头内联导入钮，点击按该侧（f.city='tx'/'rx'）打开导入 -->
              <button v-if="showImport && f.city" class="sg-himp" :title="'导入站址到' + (f.city === 'rx' ? '收信站' : '发信站') + '：城市库 / 点标记 / 地球站 / 航迹'"
                      @mousedown.left.stop @click.stop="openImport(f.city, $event)"><Icon name="import" :size="11" /></button>
            </th>
            <th v-if="roLabel" class="sg-ro">{{ roLabel }}<i v-if="roUnit"> ({{ roUnit }})</i></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in stations" :key="s._id || i" :class="{ on: sel[s._id] }">
            <td class="sg-sel" :title="'拖拽序号可框选行 · 右键插入/删除行'" @mousedown.left="onRowDown(i, $event)" @mouseenter="onRowEnter(i)" @contextmenu.prevent="onIdxContext(i, $event)"><span class="sg-idx">{{ i + 1 }}</span></td>
            <td v-for="({ f, c }) in visFields" :key="f.key"
                class="sg-cell" :class="[{ 'sg-key': isKeyCol(c), 'ro-field': isReadonlyCol(c), sel: inSel(i, c), focus: isFocus(i, c), editing: isEditing(i, c), fillp: inFill(i, c), 'sg-gend': isGroupEnd(c) }, cellClass ? cellClass(f, s) : null]"
                :style="isKeyCol(c) ? keyColStyle(c) : null"
                @mousedown.left="onDown(i, c, $event)" @mouseenter="onEnter(i, c)" @dblclick="startEdit(i, c)" @contextmenu.prevent="onCellContext(i, c, $event)">
              <!-- 占比填充条（单色半透明，无格底衬色）：最先渲染画在格底（::after 按 --fill 比例铺色，档位类 lv1..lv4 定色），后继 .sg-v 抬为 relative 浮于其上（样式在 lbworkbench.css） -->
              <span v-if="fillFrac(f, s) != null" class="sg-fillbar" :class="fillLv(f, s)" :style="{ '--fill': (fillFrac(f, s) * 100).toFixed(2) + '%' }"></span>
              <!-- 聚焦格常驻捕获输入框：导航态透明覆盖在值上（pointer-events:none 让鼠标框选穿透 td），
                   键入/输入法组字即翻成可见编辑框——中文输入法从首字母起就落在真实 <input>，不吞首字母。
                   select 字段：编辑态不套 editing 皮肤（保持透明导航态），选择改由自建下拉列表(sg-dd)承接，
                   绕开原生 <select> 弹层在滚动/sticky/冻结列 + Windows 分数缩放下的「点谁选上一个」坐标错位。 -->
              <template v-if="isFocus(i, c)">
                <input class="sg-cap" :class="{ editing: isEditing(i, c), combo: f.type === 'select', mono: f.type === 'num' }" tabindex="-1" :readonly="isReadonlyCol(c)"
                       :placeholder="!isEditing(i, c) ? '' : (f.type === 'select' ? (displayValue(s, f) || ghost(s, f) || '输入或选择…') : ghost(s, f))"
                       @input="onCapInput($event, i, c)" @compositionstart="onCapCompStart(i, c)"
                       @keydown="onCapKey" @blur="onCapBlur"
                       @copy="onCapClip" @cut="onCapClip" @paste="onCapClip" />
                <span v-if="!(isEditing(i, c) && f.type === 'select')" class="sg-v" :class="{ mono: f.type === 'num', 'has-caret': f.type === 'select', ph: ghost(s, f) }">{{ ghost(s, f) || displayValue(s, f) }}<i v-if="cellTag && cellTag(f, s)" class="sg-tag">{{ cellTag(f, s) }}</i></span>
                <span v-if="f.type === 'select'" class="sg-caret" :class="{ open: isEditing(i, c) }"
                      @mousedown.left.stop.prevent="onCaretDown(i, c)"><Icon name="chevron-down" :size="12" /></span>
              </template>
              <template v-else>
                <span class="sg-v" :class="{ mono: f.type === 'num', 'has-caret': f.type === 'select', ph: ghost(s, f) }">{{ ghost(s, f) || displayValue(s, f) }}<i v-if="cellTag && cellTag(f, s)" class="sg-tag">{{ cellTag(f, s) }}</i></span>
                <span v-if="f.type === 'select'" class="sg-caret"
                      @mousedown.left.stop.prevent="onCaretDown(i, c)"><Icon name="chevron-down" :size="12" /></span>
              </template>
              <!-- 库引用列（载波信号配置 / 地球站配置 / 卫星）格内「编辑参数」钮：悬停或聚焦本格才现形，
                   点击直达资源库该条目（与卫星分区节头「编辑参数」同一去处）。悬停才显＝不常占格宽，
                   现形时是不透明小钮盖住值的尾部（Airtable 展开记录钮的做法），列宽不因它变化。 -->
              <button v-if="libOf(f)" type="button" class="sg-libed"
                      :title="'到资源库编辑「' + (displayValue(s, f) || ghost(s, f) || '（默认）') + '」的参数'"
                      @mousedown.left.stop.prevent @click.stop="editLibCell(i, c)"><Icon name="pencil" :size="10" /></button>
              <!-- 单元格第二行小字（只读）：链路表「地球站配置」下方挂实时 EIRP/G·T。导航态透明捕获框(inset:0)不遮它、编辑 select 时才盖住，均属预期 -->
              <span v-if="cellSub && cellSub(f, s)" class="sg-sub">{{ cellSub(f, s) }}</span>
              <span v-if="isFillAnchor(i, c) && !isEditing(i, c)" class="sg-handle" title="拖动/双击向下填充" @mousedown.left.stop.prevent="onFillDown" @dblclick.stop="onFillDbl"></span>
            </td>
            <td v-if="roLabel" class="sg-ro mono sg-cell" :class="{ sel: inSel(i, fields.length), focus: isFocus(i, fields.length), fillp: inFill(i, fields.length) }"
                @mousedown.left="onDown(i, fields.length, $event)" @mouseenter="onEnter(i, fields.length)" @contextmenu.prevent="onCellContext(i, fields.length, $event)">
              {{ roValues[s._id] != null ? roValues[s._id] : '—' }}
              <span v-if="isFillAnchor(i, fields.length)" class="sg-handle" title="拖动/双击向下填充" @mousedown.left.stop.prevent="onFillDown" @dblclick.stop="onFillDbl"></span>
            </td>
          </tr>
          <tr v-if="!stations.length"><td :colspan="visColCount" class="sg-empty">暂无{{ label }}</td></tr>
          <!-- 表尾追加行（Notion 式）：常驻，点击在表尾加一行；行中插入仍走右键菜单 -->
          <tr class="sg-addrow"><td :colspan="visColCount"><button type="button" class="sg-addlbl" title="在表尾追加一行" @mousedown.stop @click="addRow(true)"><Icon name="plus" :size="11" /> 增加一行</button></td></tr>
        </tbody>
      </table>
    </div>

    <!-- 导入（城市库 / 点标记 / 地球站 / 航迹）—— Quick Pick 式：锚在列头导入钮下方，
         搜索自动聚焦；点条目/Enter 即入表尾一行（面板不关可连续导入，Ctrl+Z 逐步撤销）；Esc/完成 关闭 -->
    <div v-if="imp.open" class="sg-mask sg-mask-lite" @click="closeImport">
      <div class="sg-box sg-imppop" :style="imp.style" @click.stop>
        <div class="sg-box-hd sg-imphd">
          <span>导入站址 →</span>
          <template v-if="geoGroups.length > 1">
            <button v-for="gg in geoGroups" :key="gg.kind" class="sg-sideb" :class="{ on: imp.side === gg.kind }"
                    :title="'新行站址写入' + (gg.kind === 'rx' ? '收信站' : '发信站') + '侧'" @click="imp.side = gg.kind">{{ gg.kind === 'rx' ? '收信站' : '发信站' }}</button>
          </template>
          <span v-else class="sg-side1">{{ imp.side === 'rx' ? '收信站' : '发信站' }}</span>
        </div>
        <div class="sg-tabs">
          <button v-for="s in IMPORT_SOURCES" :key="s.key" class="sg-tab" :class="{ on: imp.source === s.key }" @click="setSource(s.key)">{{ s.label }}</button>
        </div>
        <!-- 另一端：钉住某站后，每导入一行对侧站址都写它（未钉=对侧用字段默认，如北京） -->
        <div v-if="impOtherGroup" class="sg-oth">
          <span class="sg-oth-l">另一端（{{ imp.side === 'rx' ? '发信站' : '收信站' }}）</span>
          <template v-if="imp.other">
            <b class="sg-oth-v" :title="imp.other.lon + '°E ' + imp.other.lat + '°N'" data-i18n-skip>{{ imp.other.name }}</b>
            <button class="sg-oth-x" title="清除另一端，恢复用默认站址" @click="imp.other = null">✕</button>
          </template>
          <span v-else class="sg-oth-def" title="未指定另一端：新行对侧用默认站址。悬停列表条目点 ⇄ 可把该站设为另一端">默认（{{ impOtherDefault }}）</span>
        </div>
        <input ref="impSearchEl" v-model="imp.query" class="sg-search" :placeholder="imp.source === 'city' ? '搜索城市 / 省份 / 拼音缩写（如 北京 / 江苏 / bj）' : '搜索名称 / 经度'"
               @keydown="onImpKey" @input="imp.hl = 0" />
        <div class="sg-list">
          <!-- mousedown.prevent：点击不夺走搜索框焦点，点完接着打字/回车连续导入 -->
          <div v-for="(it, ii) in impResults" :key="it.id" class="sg-impitem" :class="{ hl: ii === imp.hl, done: imp.added[it.id] }"
               :title="'点击加为新行（写入' + (imp.side === 'rx' ? '收信站' : '发信站') + '侧）'"
               @mousedown.prevent @click="importItems([it])" @mouseenter="imp.hl = ii">
            <span class="sg-impn" data-i18n-skip>{{ it.name }}</span>
            <span class="mono sg-ll">{{ it.lon }}°E  {{ it.lat }}°N</span>
            <span v-if="impOtherGroup" class="sg-imppin" :class="{ on: imp.other && imp.other.id === it.id }"
                  :title="'设为另一端：之后导入的每行，' + (imp.side === 'rx' ? '发信站' : '收信站') + '侧都写「' + it.name + '」'"
                  @mousedown.prevent.stop @click.stop="imp.other = it">⇄</span>
            <span class="sg-impck" :class="{ show: imp.added[it.id] }">✓<i v-if="imp.added[it.id] > 1"> ×{{ imp.added[it.id] }}</i></span>
          </div>
          <div v-if="!impResults.length" class="sg-empty">无可导入项</div>
        </div>
        <div class="sg-box-ft sg-impft">
          <span class="sg-impn2">{{ imp.addedN ? '本次已加 ' + imp.addedN + ' 行（Ctrl+Z 可撤销）' : '↑↓ 高亮 · Enter 导入' }}</span>
          <button class="sg-btn" :disabled="!impResults.length" :title="'把当前列出的 ' + impResults.length + ' 项全部加为新行（一步可撤销）'" @click="importAll">全部导入（{{ impResults.length }}）</button>
          <button class="sg-btn primary" @click="closeImport">完成</button>
        </div>
      </div>
    </div>

    <!-- 批量设值 -->
    <div v-if="batch.open" class="sg-mask" @click="batch.open = false">
      <div class="sg-box sg-box-sm" @click.stop>
        <div class="sg-box-hd">批量设值（应用到选中的 {{ selectedRows.length }} 行）</div>
        <div class="sg-batch">
          <select v-model="batch.key" class="sg-search"><option v-for="f in fields.filter((x) => !x.ro)" :key="f.key" :value="f.key">{{ f.label }}</option></select>
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
          <!-- 库引用列：每个选项挂「编辑参数」钮（悬停现形）→ 直达资源库该条目，不改变本行选择。
               走 mousedown.stop：选项本身用 mousedown 提交选值，不 stop 会先把这项选上 -->
          <button v-if="libOf(ddField)" type="button" class="sg-opt-ed" :title="'到资源库编辑「' + optLabel(o) + '」的参数（不改变本行选择）'"
                  @mousedown.left.stop.prevent="editLibOpt(o)"><Icon name="pencil" :size="10" /></button>
        </div>
        <div v-if="!ddFiltered.length" class="sg-opt sg-opt-empty">{{ ddOptions.length ? '无匹配 · 回车录入「' + dd.query + '」' : '无选项' }}</div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.sg { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.sg-bar { display: flex; align-items: center; gap: 6px; padding: 4px 2px 6px; flex: none; flex-wrap: wrap; }
.sg-count { font-size: 11px; color: var(--text-muted); }
.sg-sp { flex: 1; }
.sg-btn { font: inherit; font-size: 11px; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.sg-btn:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.sg-btn:disabled { opacity: .4; cursor: not-allowed; }
.sg-btn.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }

.sg-scroll { flex: 1; overflow: auto; overscroll-behavior-x: contain; border: 1px solid var(--border); border-radius: var(--r-box, 3px); outline: none; }
.sg-tbl { border-collapse: separate; border-spacing: 0; font-size: var(--lb-fs, 11px); white-space: nowrap; }
.sg-tbl th, .sg-tbl td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); background: var(--bg); box-sizing: border-box; }
/* 表头：白底 + 栏目线（与结果三线表同语言），仍不透明以便 sticky 悬浮时盖住滚过的行 */
/* —— 表内层级总表（动任一处 z-index 都先对照这里）——
     0 普通数据格 .sg-cell   < 1 聚焦/编辑格   < 2 冻结数据格（序号列/名称列/只读末列）
   < 3 字段表头行            < 4 列组表头行    < 5 冻结列表头格   < 6 列组行的序号角格
   前提是 .sg-cell 自成层叠上下文（见下方 z-index:0）：格内浮层（下拉箭头/填充柄/捕获输入框 z3–6）
   只在格内互相排序。否则它们会越过 td 直接与表头比大小——滚动时小箭头、填充柄浮在标题行上面。 */
.sg-tbl th { position: sticky; top: 0; z-index: 3; padding: 3px 7px; font-weight: 600; color: var(--text-muted); text-align: left; background: var(--bg); }
.sg-tbl thead tr:last-child th { border-bottom: 1px solid var(--lb-rule); }
/* —— 两层表头（列组行）与分区区分度 ——
   组行贴顶、字段行整体下移一行高（20px，与下方 top 同步）；序号角格(sg-gpad)抬高层级盖住横滚组名。
   分区（发信站 / 收信站 / 计算结果）不填底色，靠**线的层级差**：普通格线 --border(#e2e2dd)，
   分区线 --lb-rule(#8a8a87)，对比度差三倍多，密排表里一眼可辨。曾试过 booktabs 的减墨路子
   （撤通栏线改分段 cmidrule + 组间留一道空白列距），在这种全格线密排表里读起来是「少画了根格线」
   而非「这里是分区」，已否决——留白当分隔符的前提是稀疏排版，勿再重来。
   组标题原为 --text-faint，比它管辖的列头(--text-muted)还淡、层级倒挂，一并提到 muted/700。 */
.sg-tbl.has-g thead tr.sg-ghd th { top: 0; height: 20px; padding: 2px 7px; font-size: 10px; font-weight: 700; letter-spacing: var(--ls-caps); color: var(--text-muted); z-index: 4; border-bottom: 1px solid var(--lb-rule); }
.sg-tbl.has-g thead tr.sg-ghd th.sg-gpad { z-index: 6; }
.sg-tbl.has-g thead tr:not(.sg-ghd) th { top: 20px; }
.sg-glbl { vertical-align: middle; }
/* 分区线：画在**组末列的右框**（组行为跨列 th、表体为该列每个格），而不是组首列的左框——
   border-collapse:separate 下相邻格的左右框不合并，走左框会与前一列的右框并排成一淡一深两条线。
   加深既有格线则始终只有一根，表宽也不变。 */
.sg-tbl th.sg-gend, .sg-tbl td.sg-gend { border-right: 1px solid var(--lb-rule); }
/* 列头内联导入钮（站址组锚点列「地球站位置」）：点击按该侧打开导入 */
.sg-himp { display: inline-flex; align-items: center; justify-content: center; margin-left: 5px; padding: 1px 3px; vertical-align: -2px; cursor: pointer; background: transparent; color: var(--text-faint); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-himp:hover { color: var(--accent); border-color: var(--border-strong); }
/* 表尾「＋ 增加一行」；标签横滚时粘住左缘 */
/* 表尾「＋ 增加一行」：点击区**只是标签本身**，不是整行——整行热区紧挨底部横向滚动条，够一下滚动条就白加一行。
   标签横滚时粘住左缘；行本体只作留白，不吃点击。 */
.sg-addrow td { padding: 2px 8px; color: var(--text-muted); user-select: none; }
.sg-addlbl { position: sticky; left: 8px; display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: inherit; padding: 2px 7px; cursor: pointer; color: var(--text-faint); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px); }
.sg-addlbl:hover { color: var(--accent); border-color: var(--border); background: var(--surface); }
.sg-tbl th.sg-hcol { cursor: pointer; }
.sg-tbl th.sg-hcol:hover { color: var(--text); }
.sg-tbl th.colsel { background: color-mix(in srgb, var(--accent) 24%, var(--surface-2)); color: var(--text); }
.sg-tbl th i { color: var(--text-faint); font-style: normal; font-weight: 400; }
.sg-tbl tbody tr.on > td { background: var(--surface-2); }
/* 冻结：选择列(固定 40px) + 名称区(从首列冻结到城市/名称字段，可能不止 1 列，left 由 keyColStyle() 按列动态算) */
.sg-tbl th.sg-sel, .sg-tbl td.sg-sel { position: sticky; left: 0; z-index: 2; width: 34px; min-width: 34px; max-width: 34px; padding: 3px 2px; text-align: center; white-space: nowrap; }
.sg-tbl thead th.sg-sel { z-index: 5; }
.sg-tbl td.sg-sel { cursor: pointer; user-select: none; }
.sg-tbl td.sg-sel:hover { background: var(--surface-2); }
.sg-tbl tbody tr.on > td.sg-sel { background: var(--surface-2); }
.sg-tbl tbody tr.on > td.sg-sel .sg-idx { color: var(--accent); font-weight: 700; }
.sg-idx { color: var(--text-faint); font-size: 10px; display: block; }
.sg-tbl th.sg-key, .sg-tbl td.sg-key { position: sticky; z-index: 2; width: 90px; min-width: 90px; }
.sg-tbl thead th.sg-key { z-index: 5; }
/* 单元格。z-index:0 不是为了排序，是为了让 td 自成层叠上下文，把格内浮层（下拉箭头/填充柄/
   捕获输入框）关在格子里——见上方「表内层级总表」。 */
.sg-cell { position: relative; z-index: 0; padding: 0; cursor: cell; user-select: none; vertical-align: top; }
/* Excel 填充柄：聚焦格右下角黑色方块，悬停为十字光标 */
.sg-handle { position: absolute; right: -2px; bottom: -2px; width: 6px; height: 6px; background: var(--accent); border: 1px solid var(--bg); cursor: crosshair; z-index: 6; }
.sg-cell.fillp { outline: 1px dashed var(--accent); outline-offset: -1px; }
.sg-v { display: block; padding: 2.5px 6px; min-width: 76px; min-height: 19px; overflow: hidden; text-overflow: ellipsis; }
.sg-key .sg-v { min-width: 78px; }
.sg-v.mono { font-family: var(--font-mono); }
/* 留空单元格「浅显示」默认值（占位提示，非真实输入）——比正常内容更淡，用户一眼可辨 */
.sg-v.ph { color: var(--text-faint); opacity: .7; }
/* 行内尾标（如「地球站配置」名之后的实时功放功率）：跟在值后同一行，与第二行小字同一档字号/色阶——
   读数性质相同（都是随输入实时回填的算出量），只是一个贴在名后、一个另起一行。 */
.sg-tag { margin-left: 6px; font-style: normal; font-size: max(9px, calc(var(--lb-fs, 11px) - 2px)); color: var(--text-faint); }
/* 单元格第二行只读小字（如「地球站配置」下的实时 EIRP/G·T）：更小更淡、等宽、不吃鼠标（点击落到 td 选中本格） */
.sg-sub { display: block; padding: 0 6px 2px; margin-top: -1px; font-size: max(9px, calc(var(--lb-fs, 11px) - 2px)); line-height: 1.3; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
.sg-cell.sel { background: color-mix(in srgb, var(--accent) 12%, var(--bg)); }
/* 聚焦/编辑格抬一层（仍低于冻结列与表头）：让填充柄那 2px 出檐、编辑框边框压过相邻格 */
.sg-cell.focus, .sg-cell.editing { z-index: 1; }
.sg-cell.focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.sg-tbl tbody tr.on > td.sg-cell.sel { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); }
.sg-i { width: 100%; font: inherit; font-size: 12px; padding: 3px 5px; border: 0; border-radius: 0; background: var(--surface); color: var(--text); }
.sg-i.mono { font-family: var(--font-mono); }
.sg-i:focus { outline: none; }
/* 聚焦格常驻捕获输入框：始终存在并持有键盘/输入法焦点。导航态透明覆盖在值上、pointer-events:none 让鼠标框选穿透到 td；
   一旦键入/输入法组字即翻成不透明可见编辑框。核心作用：中文输入法从第一个拼音字母起就有真实 <input> 目标，不再吞首字母。 */
.sg-cap { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box; margin: 0; border: 0; border-radius: 0; padding: 2.5px 6px; font: inherit; line-height: normal; background: transparent; color: transparent; caret-color: transparent; pointer-events: none; z-index: 3; }
.sg-cap.mono { font-family: var(--font-mono); }
.sg-cap:focus { outline: none; }
.sg-cap.editing { background: var(--surface); color: var(--text); caret-color: var(--text); pointer-events: auto; z-index: 5; }
.sg-cap.editing::placeholder { color: var(--text-faint); opacity: .7; }   /* 编辑空格时输入框内仍浅显默认值，键入即消 */
.sg-act { position: sticky; right: 0; z-index: 2; white-space: nowrap; padding: 0 4px; text-align: center; width: 86px; min-width: 86px; }
.sg-tbl thead th.sg-act { z-index: 5; }
.sg-mini { font: inherit; font-size: 11px; padding: 2px 6px; margin: 2px 1px; cursor: pointer; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-mini:hover { color: var(--text); border-color: var(--border-strong); }
.sg-mini.del:hover { color: var(--danger); border-color: var(--danger); }
.sg-empty { padding: 12px; text-align: center; color: var(--text-faint); }
/* 只读末列（EIRP / G/T，计算后回填）——冻结在右侧 */
.sg-tbl th.sg-ro, .sg-tbl td.sg-ro { position: sticky; right: 0; z-index: 2; width: 1%; white-space: nowrap; text-align: right; padding: 2.5px 8px; border-left: 1px solid var(--border-strong); background: var(--bg); color: var(--text); }
.sg-tbl thead th.sg-ro { z-index: 5; }
.sg-tbl td.sg-ro.mono { font-family: var(--font-mono); }
/* 只读列可框选/复制：选中高亮（基样式更具体，需在此覆写） */
.sg-tbl td.sg-ro.sel { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
.sg-tbl tbody tr.on > td.sg-ro.sel { background: color-mix(in srgb, var(--accent) 16%, var(--surface-2)); }
/* 只读字段单元格 ro-field：可选中/可复制但不可编辑（雨衰结果列 / GEO仰角 / 自动降雨率）。
   淡底 + 默认光标区分于可编辑格；选中态仍以强调色高亮以便复制。 */
.sg-tbl td.sg-cell.ro-field { background: color-mix(in srgb, var(--surface-2) 40%, var(--bg)); color: var(--text-muted); cursor: default; }
.sg-tbl td.sg-cell.ro-field.sel { background: color-mix(in srgb, var(--accent) 14%, var(--surface)); color: var(--text); }
.sg-cap[readonly] { cursor: default; }
.sg-hint { flex: none; margin: 6px 2px 0; font-size: 11px; color: var(--text-faint); }

.sg-mask { position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.sg-box { width: 380px; max-height: 72vh; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card, 4px); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.sg-box-sm { width: 320px; }
.sg-box-hd { padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: var(--ls-label); text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.sg-search { margin: 10px 12px; padding: 6px 9px; font: inherit; font-size: 12px; background-color: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-search:focus { outline: none; border-color: var(--accent); }
.sg-list { flex: 1; overflow: auto; padding: 0 6px 8px; }
.sg-city { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 8px; cursor: pointer; border-radius: var(--r-ctl, 2px); font-size: 12px; }
.sg-city:hover { background: var(--surface-2); }
.sg-ll { font-size: 11px; color: var(--text-faint); }
/* 导入弹窗 */
.sg-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.sg-tab { flex: 1; font: inherit; font-size: 12px; padding: 5px 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-tab.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
/* Quick Pick 式导入面板：透明遮罩（仅拦截外点关闭）+ 锚定在列头导入钮下方的浮层 */
.sg-mask-lite { background: transparent; display: block; }
.sg-imppop { position: fixed; margin: 0; box-shadow: 0 8px 28px rgba(0,0,0,.24); }
.sg-imphd { display: flex; align-items: center; gap: 6px; }
.sg-sideb { font: inherit; font-size: 11px; font-weight: 400; line-height: 1; letter-spacing: 0; text-transform: none; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-sideb.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); box-shadow: inset 0 -2px 0 var(--accent); font-weight: 600; }
.sg-side1 { letter-spacing: 0; text-transform: none; color: var(--text); }
/* 「另一端」行：钉住的对侧站回显 + 清除 */
.sg-oth { display: flex; align-items: center; gap: 5px; margin: 6px 12px 0; font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; }
.sg-oth-v { color: var(--text); font-weight: 700; }
.sg-oth-x { font: inherit; font-size: 10px; line-height: 1; padding: 1px 4px; cursor: pointer; background: transparent; color: var(--text-faint); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); }
.sg-oth-x:hover { color: var(--danger); border-color: var(--border-strong); }
.sg-oth-def { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; }
.sg-impitem { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: pointer; font-size: var(--lb-fs, 11px); border-radius: var(--r-ctl, 2px); user-select: none; }
/* 条目内 ⇄ 钉为另一端：悬停显现，钉中常亮 */
.sg-imppin { visibility: hidden; font-size: 12px; line-height: 1; padding: 0 3px; color: var(--text-faint); cursor: pointer; border-radius: var(--r-ctl, 2px); }
.sg-impitem:hover .sg-imppin { visibility: visible; }
.sg-imppin:hover { color: var(--accent); }
.sg-imppin.on { visibility: visible; color: var(--accent); font-weight: 700; }
.sg-impitem.hl { background: color-mix(in srgb, var(--accent) 14%, var(--bg)); }
.sg-impitem.done .sg-impn { color: var(--text-muted); }
.sg-impn { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-impck { visibility: hidden; color: var(--ok); font-weight: 700; }
.sg-impck.show { visibility: visible; }
.sg-impck i { font-style: normal; font-size: 10px; color: var(--text-muted); font-weight: 400; }
.sg-impft { display: flex; align-items: center; gap: 8px; padding: 6px 12px 10px; }
.sg-impn2 { flex: 1; min-width: 0; font-size: 10.5px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sg-batch { display: flex; flex-direction: column; }
.sg-box-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 4px 12px 12px; }

/* 右键菜单（Excel 式）：满屏遮罩拦截点击关闭 + 浮层菜单 */
.sg-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.sg-ctx { position: fixed; min-width: 168px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.sg-ctx-i { display: flex; align-items: center; justify-content: space-between; gap: 16px; font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl, 2px); white-space: nowrap; }
.sg-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.sg-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.sg-ctx-i.danger:hover { color: var(--danger); }
.sg-ctx-i kbd { font: inherit; font-size: 10px; color: var(--text-faint); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-box); padding: 0 4px; }
.sg-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }

/* select 单元格下拉指示 chevron：单击即开的热区，pointer-events 高于透明捕获框(.sg-cap z3) */
/* top:10px（首行 ~19px 行高的中线）而非 50%：单行格与 50% 等效，双行格（配置名+第二行小字）时 chevron 仍贴首行的配置名 */
.sg-caret { position: absolute; right: 2px; top: 10px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 15px; height: 18px; color: var(--text-faint); cursor: pointer; z-index: 6; pointer-events: auto; transition: transform .12s, color .12s; }
.sg-cell:hover .sg-caret, .sg-cell.focus .sg-caret { color: var(--text-muted); }
.sg-caret.open { color: var(--accent); transform: translateY(-50%) scaleY(-1); }
.sg-v.has-caret { padding-right: 18px; }
/* 库引用列格内「编辑参数」钮：默认隐形且不占位，悬停/聚焦本格才现形——现形时是一枚不透明小钮，
   浮在值尾部之上（Airtable 悬停「展开记录」钮的做法）。这样列宽与普通 select 列一致，不必为一个
   偶尔按一次的钮长期让出 16px。竖直上与 chevron 同基线（首行中线），横向排在它左边。 */
.sg-libed { position: absolute; right: 17px; top: 10px; transform: translateY(-50%); display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; visibility: hidden; cursor: pointer; color: var(--text-faint); background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px); box-shadow: 0 1px 3px rgba(0,0,0,.14); z-index: 6; }
.sg-cell:hover .sg-libed, .sg-cell.focus .sg-libed { visibility: visible; }
.sg-libed:hover { color: var(--accent); border-color: var(--border-strong); }
.sg-cap.combo { padding-right: 20px; }   /* 组合框输入：右留位给 chevron，打字不压住箭头 */
/* 自建下拉列表（Teleport 到 body，fixed 定位；层级高于 sticky 表头/冻结列 z4，低于模态遮罩 z200） */
/* Teleport 到 body 在 .lb-shell 之外，字体/字号显式跟数据区（衬线栈 + --lb-fs） */
.sg-dd { position: fixed; z-index: 250; min-width: 96px; max-height: 320px; padding: 3px; overflow-y: auto; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px); box-shadow: 0 6px 20px rgba(0,0,0,.22); font-family: var(--lb-serif, inherit); font-size: var(--lb-fs, 11px); }
.sg-dd.flip { box-shadow: 0 -6px 20px rgba(0,0,0,.22); }
.sg-opt { display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer; border-radius: var(--r-ctl, 2px); color: var(--text); white-space: nowrap; user-select: none; }
.sg-opt:hover { background: var(--surface-2); }
.sg-opt.active { background: color-mix(in srgb, var(--accent) 16%, var(--bg)); }
.sg-opt.sel { color: var(--accent); font-weight: 600; }
.sg-opt-ck { flex: none; width: 12px; color: var(--accent); }
.sg-opt:not(.sel) .sg-opt-ck { visibility: hidden; }   /* 占位对齐，未选中项留白 */
.sg-opt-lb { flex: 1; overflow: hidden; text-overflow: ellipsis; }
/* 下拉项内「编辑参数」钮：悬停/高亮该项才现形（与导入面板条目的 ⇄ 钉钮同一手法）。
   用 visibility 而非 display：位置常驻，列表宽度不随鼠标跳动。 */
.sg-opt-ed { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 2px; padding: 0; visibility: hidden; cursor: pointer; color: var(--text-faint); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px); }
.sg-opt:hover .sg-opt-ed, .sg-opt.active .sg-opt-ed { visibility: visible; }
.sg-opt-ed:hover { color: var(--accent); background: var(--bg); border-color: var(--border); }
.sg-opt-empty { color: var(--text-faint); cursor: default; justify-content: center; }
.sg-opt-empty:hover { background: transparent; }
</style>
