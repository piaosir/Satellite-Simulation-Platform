<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount, toRef } from 'vue'
import { cursor } from '../stores/cursor'
import { view } from '../stores/view'
import { covNav } from '../stores/coveragePanels'
import { zoom } from '../stores/zoom'
import { effective as displayQuality } from '../stores/displayQuality'
import { viewPrefs } from '../stores/viewPrefs'
import { setGrdBridge, clearGrdBridge, fileBridge } from '../stores/fileBridge'
import { alertMsg, appAlert, closeAlert } from '../stores/alert'
import { displaySatName } from '../viz/satName.js'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
import { useGrdCoverage } from '../viz/grd/useGrdCoverage.js'
import { usePerfTable } from '../viz/grd/usePerfTable.js'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import sat from '../viz/constellation/satellite.js'
import * as W from '../viz/wgs84.js'
import { parseOMMCsv, fetchGroupLiveOrSup } from '../viz/constellation/tle.js'

// 分组与「星座地图」(2D) 完全一致：同一份列表 / 顺序 / 默认「中国星网」。
const GROUPS = [
  { key: 'none', label: '无（不渲染星座）' },
  { key: 'all', label: '全部卫星' },
  { key: 'gps', label: 'GPS' },
  { key: 'glonass', label: 'GLONASS' },
  { key: 'beidou', label: '北斗' },
  { key: 'galileo', label: 'Galileo' },
  { key: 'o3b', label: 'O3b' },
  { key: 'geo', label: 'GEO' },
  { key: 'starlink', label: 'Starlink' },
  { key: 'oneweb', label: 'OneWeb' },
  { key: 'kuiper', label: 'Kuiper' },
  { key: 'qianfan', label: '千帆星座' },
  { key: 'guowang', label: '中国星网' },
  { key: 'iridium', label: '铱星' },
  { key: 'globalstar', label: 'Globalstar' },
  { key: 'stations', label: '空间站' },
  { key: 'planet', label: 'Planet' },
  { key: 'spire', label: 'Spire' },
  { key: 'other', label: '其他' }
]
const GROUP_LABEL = { other: '其他' }
GROUPS.forEach((g) => { GROUP_LABEL[g.key] = g.label })
const DEFAULT_GROUP = Math.max(0, GROUPS.findIndex((g) => g.key === 'geo'))

const RE = 6378.137
const DEG = Math.PI / 180
const STORE_KEY = 'constellation3d/selection'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const el = ref(null)
const fileInput = ref(null)
const flatCanvas = ref(null)       // 平面覆盖图 canvas
const flatView = ref(false)        // 平面图 / 球体 切换
let flat = null                    // 平面渲染器实例
let covGeom = { lines: [], dots: [], labels: [], sats: [] }   // 覆盖几何（3D 与 平面图共用）
const groupIndex = ref(DEFAULT_GROUP)
const status = ref('')          // 卫星加载状态（无星时驱动「重试下载 / 导入 TLE」横幅）；导出反馈不走此处，避免误触横幅
const satCount = ref(0)     // 该组卫星总数
const shownCount = ref(0)   // 实际渲染点数
const dataTime = ref('')
const live = ref(false)     // 实时刷新（与 2D 默认一致：关）
const autoRotate = toRef(viewPrefs, 'autoRotate')   // 自转开关：以 viewPrefs 为单一真相（设置弹窗共享）
const nameMode = ref('en')   // 国名：'zh' | 'en' | 'off'
const showProvinces = ref(false)
let provincesLoaded = false
let provincesData = null
const showCities = ref(false)   // 显示中国地级市界 / 地级市名
let citiesLoaded = false
let citiesData = null
const timeOffset = ref(0)   // 分钟，0~1440（未来 24h）
const timePct = ref(0)
const keyword = ref('')
const searchResults = ref([])
const selected = ref(null)
const cardCollapsed = ref(false)   // 信息卡收起/展开（点标题栏切换）
// 波束角
const beam = ref('')
const beamAuto = ref('')
const beamLock = ref(false)
const geoOpen = ref(false)         // 地名设置面板开关
const apiOk = typeof window !== 'undefined' && !!(window.api && window.api.omm)
const covApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverage)
const grdApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverageGrd)

// ===================== 覆盖图（GEO 卫星，两级模型：卫星 → 批次） =====================
// covItems: 已添加的卫星 [{ folder, type:'EIRP'|'GT', band:'all'|频段, batches:[batch] }]
//   batch: { id, name, beams:[beamId], gains:[number], custom:'', mode:'gradient'|'solid'|'perGain', solid:'#hex', gainColors:{gain:'#hex'} }
const covOpen = toRef(covNav, 'covOpen')   // 右侧覆盖面板开关（GXT）；与顶栏按钮共用 covNav store

// 覆盖图（GRD）：实时原始场，渲染到星座3D 的 scene/flat（独立图层）
const grd = useGrdCoverage(() => scene, () => flat, () => flatView.value)
const { sats: grdSats, loading: grdLoading, s: grdS } = grd
const grdOpen = toRef(covNav, 'grdOpen')   // GRD 覆盖面板开关；与顶栏按钮共用 covNav store
async function toggleGrd() {
  grdOpen.value = !grdOpen.value
  if (grdOpen.value) { await grd.loadIndex(); grd.recompute(); redrawSats() }
}

// ===================== 性能指标表（SATSOFT Performance Table，第 1 期）=====================
const perf = usePerfTable()
const perfKey = ref('')                 // 当前打开表的天线 key（''=关闭）；每个天线一张独立表
const perfNew = ref({ country: '', city: '', desig: '', lon: '', lat: '' })   // 手动加站输入
const perfOptsOpen = ref(false)         // 「性能表选项」弹窗开关
// 浮窗几何（可拖拽移动 / 右下角缩放）+ 中缝分隔（城市输入区高度，px）。首次打开按视口初始化一次。
const perfWin = ref({ x: 0, y: 0, w: 760, h: 560, init: false })
const perfInputH = ref(190)
const perfCols = computed(() => perfKey.value ? perf.visibleColumns(perf.getOpts(perfKey.value)) : [])   // 当前显示的列
const perfOpts = computed(() => perfKey.value ? perf.getOpts(perfKey.value) : null)                      // 当前天线选项（弹窗 v-model）
// 重算当前表（站点库/天线设置/选中波束/选项变化时调用）
function refreshPerf() { if (perfKey.value) perf.compute(grd.getPerfContext(perfKey.value), perf.getOpts(perfKey.value)) }
// 点天线下方「性能指标表」→ 打开该天线的表（确保其方向图已载入再取值）
async function openPerf(sat, a) {
  const key = grd.keyOf(sat.folder, a.name)
  const ok = await grd.ensureAntLoaded(key)
  if (!ok) { appAlert('该天线方向图未就绪，无法生成性能表'); return }
  perfKey.value = key
  perfWinInit()
  refreshPerf()
}
function closePerf() { perfKey.value = '' }
// ===== 浮窗拖拽：移动（标题栏）/ 缩放（右下角）/ 分隔（中缝）。统一一个临时 window 监听会话 =====
function perfWinInit() {
  if (perfWin.value.init) return
  const vw = window.innerWidth, vh = window.innerHeight
  const w = Math.min(760, vw - 48), h = Math.min(Math.round(vh * 0.74), vh - 48)
  perfWin.value = { x: Math.max(12, vw - w - 24), y: Math.max(12, Math.round(vh * 0.12)), w, h, init: true }
  perfInputH.value = Math.min(190, Math.round(h * 0.34))
}
function perfDragSession(onMove) {
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
function perfDragMove(e) {
  if (e.button !== 0 || (e.target.closest && e.target.closest('.csx, .ptb, input, select, label'))) return   // 标题栏空白处才拖动
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, o = { ...perfWin.value }
  perfDragSession((ev) => {
    const vw = window.innerWidth, vh = window.innerHeight
    const x = Math.max(-o.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx)))   // 不让完全拖出视口
    const y = Math.max(0, Math.min(vh - 32, o.y + (ev.clientY - sy)))
    perfWin.value = { ...perfWin.value, x, y }
  })
}
// 8 向缩放：dir 含 n/s/e/w（角=两字母）。东/南改 w/h；西/北还要同步移动 x/y（保持对边不动）。
function perfDragResize(e, dir = 'se') {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, o = { ...perfWin.value }
  const minW = 380, minH = 260
  const E = dir.includes('e'), W = dir.includes('w'), S = dir.includes('s'), N = dir.includes('n')
  perfDragSession((ev) => {
    const vw = window.innerWidth, vh = window.innerHeight
    let x = o.x, y = o.y, w = o.w, h = o.h
    const dx = ev.clientX - sx, dy = ev.clientY - sy
    if (E) w = Math.max(minW, Math.min(o.w + dx, vw - o.x - 6))
    if (S) h = Math.max(minH, Math.min(o.h + dy, vh - o.y - 6))
    if (W) { const right = o.x + o.w; x = Math.max(6, Math.min(o.x + dx, right - minW)); w = right - x }
    if (N) { const bottom = o.y + o.h; y = Math.max(0, Math.min(o.y + dy, bottom - minH)); h = bottom - y }
    perfWin.value = { ...perfWin.value, x, y, w, h }
    if (perfInputH.value > h - 140) perfInputH.value = Math.max(64, h - 140)   // 缩小时让结果区保底
  })
}
function perfDragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, o = perfInputH.value
  perfDragSession((ev) => {
    perfInputH.value = Math.max(64, Math.min(perfWin.value.h - 140, o + (ev.clientY - sy)))
  })
}
function perfAddStation() {
  perf.pushUndo()
  const s = perf.addStation(perfNew.value)
  if (!s) { perf.dropUndo(); appAlert('请填写有效经纬度'); return }
  perfNew.value = { country: '', city: '', desig: '', lon: '', lat: '' }
  refreshPerf()
}
function perfImportMarkers() { perf.pushUndo(); const n = perf.importFromMarkers(points.value, stations.value); if (!n) { perf.dropUndo(); appAlert('没有可导入的新标记（点标记/地面站）') } refreshPerf() }
// Excel 式粘贴：在加站区任一输入框 Ctrl+V 整块表格 → 拦截并批量加站（单值粘贴仍走普通输入）
function perfPaste(e) {
  const text = e.clipboardData ? e.clipboardData.getData('text') : ''
  if (!text || !/[\t\n,]/.test(text.trim())) return
  e.preventDefault()
  perf.pushUndo()
  const n = perf.addStationsBulk(text)
  if (n) { perfNew.value = { country: '', city: '', desig: '', lon: '', lat: '' }; refreshPerf() }
  else { perf.dropUndo(); appAlert('未识别到经纬度（约定末两列为 经度、纬度，且需为数字）') }
}
// 「粘贴」按钮：直接读剪贴板批量加站（需浏览器授权剪贴板读取）
async function perfPasteBtn() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请点输入框后按 Ctrl+V 粘贴'); return }
  perf.pushUndo()
  const n = perf.addStationsBulk(text)
  if (n) refreshPerf(); else { perf.dropUndo(); appAlert('剪贴板没有可识别的经纬度数据（约定末两列为 经度、纬度）') }
}
// ===== 两张表都用 Excel 式交互（框选 / 键盘导航 / 复制 / 编辑·粘贴·清除）=====
// 城市输入网格列（可编辑）；行 = perf.stations，行 id 即站点 id。
const perfInCols = [
  { key: 'country', label: '国家' },
  { key: 'city', label: '城市' },
  { key: 'desig', label: '代号' },
  { key: 'lon', label: '经度', num: true },
  { key: 'lat', label: '纬度', num: true }
]
// 上：城市输入（可编辑）——单格编辑/区域粘贴/清除均落到站点库，深 watch 自动重算结果表。
const perfInGrid = useGridSelect({
  rows: () => perf.stations.value,
  cols: () => perfInCols,
  cellText: (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) },
  onEdit: (id, key, val) => perf.updateStation(id, { [key]: val }),
  onPasteBlock: (anchorId, startKey, text) => perf.pasteBlock(anchorId, startKey, text),
  onPasteAppend: (text) => perf.addStationsBulk(text),
  onClear: (cells) => cells.forEach(({ rowId, key }) => perf.updateStation(rowId, { [key]: '' })),
  pushUndo: () => perf.pushUndo(), dropUndo: () => perf.dropUndo(), refresh: () => refreshPerf()
})
// 下：性能结果（只读）——框选 + 复制 + 键盘导航；行 = filteredRows。
const perfResGrid = useGridSelect({
  rows: () => perf.filteredRows.value,
  cols: () => perfCols.value,
  readOnly: true,
  cellText: (r, c) => { const v = r[c.key]; if (c.num && c.fix != null) return v == null ? '' : Number(v).toFixed(c.fix); return v == null ? '' : String(v) }
})
function perfDelStation(id) { perf.pushUndo(); perf.removeStation(id) }
function perfClearStations() { if (!perf.stations.value.length) return; perf.pushUndo(); perf.clearStations() }
function perfUndo() { if (perf.undo()) refreshPerf() }
function perfRedo() { if (perf.redo()) refreshPerf() }
// 复制整张只读结果表为 TSV（含表头，可直接粘进 Excel）。同步 execCommand 优先（见 useGridSelect.writeClip 同理）。
function perfWriteClipboard(text) {
  let ok = false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0'
    document.body.appendChild(ta)
    ta.focus(); ta.select()
    ok = document.execCommand('copy')
    document.body.removeChild(ta)
  } catch { ok = false }
  if (!ok) { try { navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {}) } catch {} }
  return ok
}
function perfCellText(r, c) {
  const v = r[c.key]
  if (c.num && c.fix != null) return v == null ? '' : Number(v).toFixed(c.fix)
  return v == null ? '' : String(v)
}
function perfCopyResult() {
  const cols = perfCols.value, rows = perf.filteredRows.value
  if (!rows.length) { appAlert('结果表为空'); return }
  const head = cols.map((c) => c.label).join('\t')
  const body = rows.map((r) => cols.map((c) => perfCellText(r, c)).join('\t')).join('\n')
  if (!perfWriteClipboard(head + '\n' + body)) appAlert('复制失败，请检查剪贴板权限')
}
const perfFix = (v, n) => (v == null ? '—' : v.toFixed(n == null ? 2 : n))
const perfColDef = (k) => perf.colDefs.find((c) => c.key === k)
const perfColLabel = (k) => { const c = perfColDef(k); return c ? c.label : k }
const perfColNa = (k) => { const c = perfColDef(k); return !!(c && c.na) }
// 站点库 / 天线设置（极化/增益/路损/相对绝对）/ 选中波束 / 表选项 变化 → 表重算（仅表开启时）
watch(() => perf.stations.value, () => refreshPerf(), { deep: true })
watch(() => perf.optsByAnt.value, () => refreshPerf(), { deep: true })
watch(() => [grdS.pol, grdS.gainOffset, grdS.pathLoss, grdS.ctype, grdS.beamsToPlot], () => { if (perfKey.value === grd.active.value) refreshPerf() }, { deep: true })
// 电平颜色 css(rgb) -> #hex（供 <input type=color>）；setLevelColor 反向写回
function grdLvHex(css) { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(css || ''); if (!m) return '#ffffff'; const h = (n) => (+n).toString(16).padStart(2, '0'); return '#' + h(m[1]) + h(m[2]) + h(m[3]) }
function setLevelColor(i, e) { const x = e.target.value; grdS.levels[i].color = `rgb(${parseInt(x.slice(1, 3), 16)},${parseInt(x.slice(3, 5), 16)},${parseInt(x.slice(5, 7), 16)})` }
function setLineColor(i, e) { const x = e.target.value; grdS.levels[i].lineColor = `rgb(${parseInt(x.slice(1, 3), 16)},${parseInt(x.slice(3, 5), 16)},${parseInt(x.slice(5, 7), 16)})` }
const covSats = ref([])           // 索引：[{folder,displayName,satName,lon,beams:[{band,beam,type,gains,file}...]}]
const covItems = ref([])          // 已添加卫星（两级结构）
const covCleared = ref(false)      // 「清除绘制」后置位：保留 covItems 但暂不绘制，避免切视图/重开面板时 GXT 覆盖自行复现（再次 redraw 即解除）。入 snapshot 持久化，使「清除后效果」跨重启保留
const covAddSel = ref('')         // 「添加卫星」下拉临时值
const showBeamLabels = ref(true)
const beamLabelSize = ref(16)     // 波束名字号（6–32，内部映射为标签 hpx）
const showBore = ref(true)        // 波束中心点
const boreSize = ref(5)           // 波束中心点大小（1–12，映射球半径）
const showContourLabels = ref(false) // 等值线数值标签
const contourLabelSize = ref(12)  // 数值标签字号（2–20）
const countryNameSize = ref(1.1)  // 国家名/大洋名字号倍率（0.6–2.0）
const provNameSize = ref(0.55)    // 省名字号倍率（0.6–2.0）
const cityNameSize = ref(0.5)     // 地级市名字号倍率（小空间，默认偏小）
// 国界(海岸线)/省界/地级市界线样式：线宽 px / 颜色 / 透明度，同时作用于 3D 与平面图
// 地级市界默认更细更淡（线粗支持到 0.05），层级上从属于省界
const borderStyle = reactive({ natColor: '#000000', natWidth: 0.2, natOpacity: 1.0, provColor: '#000000', provWidth: 0.3, provOpacity: 1.0, cityColor: '#6b7280', cityWidth: 0.12, cityOpacity: 0.7 })
// 地名颜色/透明度：国家名 与 省名 与 地级市名 分开（大洋名维持固有蓝），同时作用于 3D 与平面图
const labelStyle = reactive({ countryColor: '#eef2f6', countryOpacity: 1.0, provColor: '#f6fa00', provOpacity: 1.0, cityColor: '#9aa3b0', cityOpacity: 1.0 })
// 大海颜色（限蓝色系预设），同时作用于 3D 球体与平面图底色
// 蓝色系：深→浅，兼顾鲜艳/中性/低饱和；第 2 项 #15426b 为默认深蓝，末项 #92b6e4 取自 SATSOFT 浅蓝海面
const OCEAN_BLUES = ['#0d2b4d', '#15426b', '#1b5a8c', '#1e6fa8', '#2a85c4', '#3d7ba6', '#5b7f9e', '#92b6e4']
const oceanColor = ref('#92b6e4')
const covStatus = ref('')
const covLegend = ref([])         // [{ name, mode, gmin, gmax, type, solid }]
let covLoaded = false
const covCache = {}               // file -> 数据（避免重复加载）
let covSeq = 0                    // 卫星/批次唯一 id
const newCovId = () => 'c' + (++covSeq)
let covColorCursor = 0           // 新批次默认配色游标
const DEF_COLORS = [0xff5a5a, 0x5ad1ff, 0xffd24a, 0x7cff8a, 0xc78bff, 0xff9a5a, 0x66ddff, 0xff6fae]

const clamp01 = (v) => Math.max(0, Math.min(1, v))
// HSL(蓝→红) -> 0xRRGGBB（按增益强弱渐变，供 three 线条用）
function gainHex(t) {
  const h = (1 - clamp01(t)) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}
const hexToCss = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
const cssToHex = (s) => { const n = parseInt(String(s || '').replace('#', ''), 16); return Number.isFinite(n) ? n : 0xff5a5a }
const parseNums = (s) => String(s || '').split(/[,，\s]+/).map((x) => parseFloat(x)).filter((x) => Number.isFinite(x))

// ---- 两级模型查询辅助 ----
const idxOf = (folder) => covSats.value.find((x) => x.folder === folder)
function itemBands(it) { const s = idxOf(it.folder); if (!s) return []; return [...new Set(s.beams.filter((b) => b.type === it.type).map((b) => b.band))] }
// 提取波束名里的第一个整数作为波束号（CS26 "1 拉萨"→1、CS19 "Beam No.10"→10；无号→Infinity）
const beamNum = (s) => { const m = String(s).match(/\d+/); return m ? parseInt(m[0], 10) : Infinity }
// 某卫星在其 type/band 过滤下的波束行（按波束号升序，无号者保持原序置后，并标 1-based 序号 seq）
function beamRowsOf(it) {
  const s = idxOf(it.folder); if (!s) return []
  const map = new Map()
  for (const b of s.beams) {
    if (b.type !== it.type) continue
    if (it.band !== 'all' && b.band !== it.band) continue
    const id = b.band + '|' + b.beam
    if (!map.has(id)) map.set(id, { id, band: b.band, beam: b.beam, label: `${b.band}·${b.beam}`, file: b.file, gains: b.gains || [], user: !!b.user })
  }
  const rows = [...map.values()]
  rows.sort((a, b) => beamNum(a.beam) - beamNum(b.beam))   // Array.sort 稳定：同号/无号保持原序
  rows.forEach((r, i) => { r.seq = i + 1 })
  return rows
}
// 搜索词若是纯序号语法（如 "1-62"、"1,3,5"、"1-10,20-30"）则返回序号集合，否则 null
function parseSeqSet(q) {
  const set = new Set()
  for (const part of q.split(/[,，\s]+/)) {
    if (!part) continue
    const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
    if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
    else if (/^\d+$/.test(part)) set.add(+part)
    else return null   // 含非序号字符 -> 当作文字搜索
  }
  return set.size ? set : null
}
const beamRowGains = (it, id) => { const r = beamRowsOf(it).find((x) => x.id === id); return r ? r.gains : [] }
// 按批次搜索词过滤波束行：纯序号语法（"1-62" 等）按序号选，否则按 label/beam 名（大小写不敏感）
function filteredBeamRows(it, ba) {
  const q = (ba.q || '').trim()
  const rows = beamRowsOf(it)
  if (!q) return rows
  const seqSet = parseSeqSet(q)
  if (seqSet) return rows.filter((r) => seqSet.has(r.seq))
  const ql = q.toLowerCase()
  return rows.filter((r) => r.label.toLowerCase().includes(ql) || r.beam.toLowerCase().includes(ql))
}
// 当前过滤结果是否已全选（用于全选/取消按钮文案）
const allFilteredOn = (it, ba) => { const rows = filteredBeamRows(it, ba); return rows.length > 0 && rows.every((r) => ba.beams.includes(r.id)) }
// 批次已选波束的增益档并集（供档位 chips）
function batchGains(it, ba) {
  const set = new Set()
  for (const r of beamRowsOf(it)) if (ba.beams.includes(r.id)) for (const g of r.gains) set.add(g)
  return [...set].sort((a, b) => a - b)
}
// 批次生效的增益档（含自定义输入）
function batchEffGains(ba) {
  const set = new Set(ba.gains)
  for (const v of parseNums(ba.custom)) set.add(v)
  return set
}
// 单条等值线最终颜色（按批次统一配色模式）
function contourColor(ba, g, gmin, gmax) {
  if (ba.mode === 'solid') return cssToHex(ba.solid)
  if (ba.mode === 'perGain') { const c = ba.gainColors && ba.gainColors[g]; if (c) return cssToHex(c) }
  const t = gmax > gmin ? (g - gmin) / (gmax - gmin) : 1
  return gainHex(t)
}
// 面板里某增益档的色块色（与地图同一套取值）
function gainSwatchCss(ba, g) {
  const arr = [...batchEffGains(ba)]
  const gmin = arr.length ? Math.min(...arr) : 0, gmax = arr.length ? Math.max(...arr) : 1
  return hexToCss(contourColor(ba, g, gmin, gmax))
}

let scene = null
let entries = []        // 全部 {rec, name, noradId, group}
let renderEntries = []  // 有效卫星集，与点云顺序一致
let selEntry = null
let baseTime = Date.now()
let timer = null, ro = null
let pendingNorad = null, pendingNoFace = false

function calcAt() { return live.value ? new Date() : new Date(baseTime + timeOffset.value * 60000) }

const curKey = () => GROUPS[groupIndex.value].key
const fmtSlot = (lonDeg) => { const v = ((lonDeg % 360) + 540) % 360 - 180; return `${Math.abs(v).toFixed(1)}°${v >= 0 ? 'E' : 'W'}` }
const fmtDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

// ===================== 信息卡（字段/顺序与 2D 完全一致） =====================
function cardFor(e) {
  const now = calcAt(), gmst = sat.gstime(now)
  const pv = sat.propagate(e.rec, now)
  if (!pv || !pv.position) return null
  const gd = sat.eciToGeodetic(pv.position, gmst), v = pv.velocity, r = pv.position
  const WE = 7.2921159e-5
  const speedAbs = v ? Math.hypot(v.x, v.y, v.z) : 0
  const speedRel = (v && r) ? Math.hypot(v.x + WE * r.y, v.y - WE * r.x, v.z) : 0
  const rec = e.rec
  const periodMin = (2 * Math.PI) / rec.no            // 轨道周期(min)
  const meanMotion = rec.no * 1440 / (2 * Math.PI)    // 平均运动(rev/day)
  const apoKm = rec.alta * RE, perKm = rec.altp * RE, meanKm = (apoKm + perKm) / 2
  // 轨道类型判定
  let kind = 'LEO'
  if (rec.ecco > 0.2) kind = 'HEO'
  else if (meanKm > 30000) kind = ((rec.inclo / DEG) < 10 ? 'GEO' : 'IGSO')
  else if (meanKm > 2000) kind = 'MEO'
  const isGeo = (e.group || curKey()) === 'geo'
  return {
    name: e.name, noradId: e.noradId, group: GROUP_LABEL[e.group] || GROUP_LABEL[curKey()] || '', kind,
    slot: isGeo ? fmtSlot(sat.degreesLong(gd.longitude)) : '',
    alt: gd.height.toFixed(0), lat: sat.degreesLat(gd.latitude).toFixed(2), lon: sat.degreesLong(gd.longitude).toFixed(2),
    incl: (rec.inclo / DEG).toFixed(2), ecc: rec.ecco.toFixed(5), period: periodMin.toFixed(1),
    perigee: perKm.toFixed(0), apogee: apoKm.toFixed(0), meanMotion: meanMotion.toFixed(4),
    raan: (((rec.nodeo / DEG) % 360 + 360) % 360).toFixed(2), argp: (((rec.argpo / DEG) % 360 + 360) % 360).toFixed(2),
    ma: (((rec.mo / DEG) % 360 + 360) % 360).toFixed(2),
    speedAbs: speedAbs.toFixed(3), speedRel: speedRel.toFixed(3)
  }
}

// ===================== 选中几何：轨道圈 / 星下点轨迹 / 覆盖足迹 =====================
function buildSelectedGeometry() {
  if (!selEntry || !scene) return
  const rec = selEntry.rec
  const now = calcAt(), gmstNow = sat.gstime(now)
  const periodMin = (2 * Math.PI) / rec.no, N = 120

  // 轨道圈：一个周期内逐点，统一用 now 的 gmst 冻结成当前朝向
  const orbit = []
  for (let k = 0; k <= N; k++) {
    const t = new Date(now.getTime() + (k / N) * periodMin * 60000)
    const pv = sat.propagate(rec, t)
    if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, gmstNow); orbit.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }) }
  }
  // 星下点轨迹：逐时刻 gmst -> 真实地表轨迹
  const track = []
  for (let k = 0; k <= N; k++) {
    const t = new Date(now.getTime() + (k / N) * periodMin * 60000)
    const pv = sat.propagate(rec, t)
    if (!pv || !pv.position) continue
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(t))
    track.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude) })
  }
  scene.setOrbit(orbit)
  scene.setGroundTrack(track)
  selTrack = track            // 缓存星下点轨迹，供 2D 平面图同步绘制
  buildFootprint(rec, now, gmstNow)
}

// 聚焦卫星几何缓存（推 2D 平面图：覆盖范围 + 星下点轨迹，与 3D 同源）；无聚焦为 null
let selTrack = null, selFootprint = null
function pushSelGeomFlat() {
  if (flat) flat.setSelGeom(selEntry ? { track: selTrack, footprint: selFootprint } : null)
}

// 覆盖足迹圈：与 2D 同一套几何（全波束角 B，半角 η=B/2；地心半角 λ=arcsin(r/RE·sinη)−η，夹断到 ε=0 上限）
function buildFootprint(rec, now, gmstNow) {
  const pv = sat.propagate(rec, now)
  if (!pv || !pv.position) { scene.setFootprint(null); selFootprint = null; pushSelGeomFlat(); return }
  const gd = sat.eciToGeodetic(pv.position, gmstNow)
  const lat0 = sat.degreesLat(gd.latitude), lon0 = sat.degreesLong(gd.longitude), h = gd.height
  scene.setHighlightLLA({ lat: lat0, lon: lon0, altKm: h })
  if (!(h > 0)) { scene.setFootprint(null); selFootprint = null; pushSelGeomFlat(); return }
  const r = RE + h
  const etaMax = Math.asin(clamp(RE / r, -1, 1))
  const bMaxDeg = 2 * etaMax / DEG

  const raw = parseFloat(beam.value)
  let bDeg, clampText = null
  if (!(raw > 0)) bDeg = bMaxDeg
  else if (raw > bMaxDeg) { bDeg = bMaxDeg; clampText = bMaxDeg.toFixed(1) }
  else bDeg = raw

  const eta = (bDeg / 2) * DEG
  const ecf = sat.eciToEcf(pv.position, gmstNow)   // 卫星 ECEF(km)，按 WGS84 椭球求足迹边
  const fp = W.footprintEllipsoid([ecf.x, ecf.y, ecf.z], eta, 72)
  scene.setFootprint(fp)
  selFootprint = fp; pushSelGeomFlat()   // 同步到 2D 平面图

  // placeholder 常显 ε=0 上限；用户超限回写夹断值（锁定态不回写）
  const autoText = bMaxDeg.toFixed(1)
  if (autoText !== beamAuto.value) beamAuto.value = autoText
  if (clampText != null && !beamLock.value && clampText !== beam.value) beam.value = clampText
}

// 以 (lat0,lon0) 为心、地心半角 lambda 的地表小圆 -> 经纬度点列
function circleLatLon(lat0, lon0, lambda, N) {
  const la = lat0 * DEG, lo = lon0 * DEG
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  let ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]
  const n1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1]
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]]
  const cosL = Math.cos(lambda), sinL = Math.sin(lambda), out = []
  for (let k = 0; k <= N; k++) {
    const th = (k / N) * 2 * Math.PI, c = Math.cos(th), s = Math.sin(th)
    const w = [cosL * u[0] + sinL * (c * e1[0] + s * e2[0]), cosL * u[1] + sinL * (c * e1[1] + s * e2[1]), cosL * u[2] + sinL * (c * e1[2] + s * e2[2])]
    out.push({ lat: Math.asin(clamp(w[2], -1, 1)) / DEG, lon: Math.atan2(w[1], w[0]) / DEG })
  }
  return out
}

// ===================== 渲染集 =====================
// 换组/加载后：算一次此刻位置，过滤掉不可解算的，渲染全部有效卫星（PC 端性能足够，不再抽稀）
function rebuildRenderSet() {
  if (!scene) return
  const now = calcAt()
  const valid = []
  for (const e of entries) {
    try { const pv = sat.propagate(e.rec, now); if (pv && pv.position) valid.push(e) } catch { /* skip */ }
  }
  renderEntries = valid
  satCount.value = entries.length
  refreshPositions()
}

// 时间推进 / 实时刷新：只重算渲染集位置（不重建集合），并刷新选中几何/信息卡
function refreshPositions() {
  if (!scene) return
  if (curKey() === 'none' || !renderEntries.length) { scene.setSatellites([]); shownCount.value = 0; pushFocusSat(); if (hasLinkedElev()) redrawSats(); grd.tickLive(); return }
  const now = calcAt(), gmst = sat.gstime(now)
  const positions = []
  for (const e of renderEntries) {
    try {
      const pv = sat.propagate(e.rec, now)
      if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, gmst); positions.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }) }
      else positions.push({ lat: 0, lon: 0, altKm: -RE })   // 占位，保持索引对齐（落到地心不可见）
    } catch { positions.push({ lat: 0, lon: 0, altKm: -RE }) }
  }
  scene.setSatellites(positions)
  shownCount.value = renderEntries.length
  if (selEntry) {
    const c = cardFor(selEntry); if (c) selected.value = c; buildSelectedGeometry()
    if (points.value.length || stations.value.length) pushMarkers()   // 随卫星移动刷新标记仰角
  }
  pushFocusSat()   // 同步 2D 平面图上聚焦卫星实时位置
  if (hasLinkedElev()) redrawSats()   // 星座关联星：仰角线随时间轴/实时跟踪
  if (grd.tickLive(perfKey.value || null).perfMoved) refreshPerf()   // 星动 → GRD 覆盖随时间轴移动；性能指标表也随之重算（取值依赖星位推出的 basis）
  if (satModal.value && satModal.value.noradId) liveTick.value++   // 关联星编辑中：驱动弹窗经纬度/高度刷新
  persistGrdLive()   // 写实时关联星当前星下点到轻量缓存，供链路预算窗口「导入时取新位置」
}

// ===================== 数据加载 =====================
function ingest(sats, payloadGroup, fetchedAt) {
  entries = []
  for (const s of sats) {
    try { const r = sat.omm2satrec(s); if (r && !r.error) entries.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || payloadGroup || '' }) } catch { /* skip */ }
  }
  dataTime.value = fetchedAt ? fmtDate(new Date(fetchedAt)) : '—'
  rebuildRenderSet()
  status.value = entries.length ? '' : '无有效卫星'
  // 跨分组/恢复选中：按 NORAD 定位
  if (pendingNorad) {
    const e = entries.find((x) => String(x.noradId) === String(pendingNorad))
    const noFace = pendingNoFace
    pendingNorad = null; pendingNoFace = false
    if (e) { selectSat(e, !noFace) }
  }
}

async function loadGroup() {
  if (!apiOk) { status.value = '需在 Electron 中运行（npm run dev）'; return }
  const g = GROUPS[groupIndex.value]
  resetBeam(); selEntry = null; selected.value = null; scene && scene.clearSelectionGeom(); selTrack = selFootprint = null; pushSelGeomFlat()
  // 「无」：不加载/不传播/不渲染任何卫星，省 SGP4 与点渲染开销（覆盖图、地球照常）
  if (g.key === 'none') {
    entries = []; renderEntries = []; satCount.value = 0; shownCount.value = 0
    if (scene) scene.setSatellites([])
    status.value = ''; dataTime.value = '—'
    redrawSats()   // 无星座时自定义卫星照常绘制（关联卫星回退到存储位置）
    return
  }
  if (g.key === 'all' || g.key === 'other') {
    status.value = `加载 ${g.label} …`
    try { await (g.key === 'all' ? loadAll() : loadOther()) }
    catch (e) { status.value = `${g.label} 获取失败：${(e && e.message) || '网络不可达'}` }
    return
  }
  // 单组星历：缓存优先即时渲染 + 后台静默联网刷新（无网/慢网也不卡住进软件）
  let shown = false
  try {
    const cached = await fetchGroupLiveOrSup(g.key, { cacheOnly: true })
    if (cached && cached.sats.length) { ingest(cached.sats, g.key, cached.fetchedAt); shown = true; status.value = '' }
  } catch { /* 无缓存：继续走后台联网 */ }
  if (!shown) status.value = `加载 ${g.label} …`
  fetchGroupLiveOrSup(g.key)
    .then((payload) => {
      if (curKey() !== g.key) return   // 用户已切到别的组：丢弃过期结果
      if (payload && payload.sats.length) { ingest(payload.sats, g.key, payload.fetchedAt); status.value = '' }
      else if (!shown) status.value = `${g.label} 暂无数据`
    })
    .catch((e) => { if (curKey() === g.key && !shown) status.value = `${g.label} 获取失败：${(e && e.message) || '网络不可达'}` })
}

// 加载「全部在轨」全集并归类：各已知分组并集 ∪ active；返回归类后的卫星数组（_group 为分组或 'other'）
// silent=true：后台构建全量搜索库用，不写主状态栏
async function loadUniverse(silent) {
  const setS = (t) => { if (!silent) status.value = t }
  const keys = GROUPS.filter((g) => g.key !== 'all' && g.key !== 'other' && g.key !== 'none').map((g) => g.key)
  let done = 0
  setS(`加载全部卫星 0/${keys.length + 1} …`)
  const tick = () => { done++; setS(`加载全部卫星 ${done}/${keys.length + 1} …`) }
  const fetchedAts = []   // 各组实际下载落盘时间 → 合并视图取最新一份作为 OMM 显示时间
  const tasks = keys.map((key) => fetchGroupLiveOrSup(key)
    .then((p) => { tick(); if (p.fetchedAt) fetchedAts.push(p.fetchedAt); for (const s of p.sats) s._group = key; return p.sats })
    .catch(() => { tick(); return [] }))
  const arrs = await Promise.all(tasks)
  // 并集（NORAD 去重）+ 分组归类映射
  const groupOf = new Map(), universe = new Map()
  for (const a of arrs) for (const s of a) {
    if (!groupOf.has(s.noradId)) groupOf.set(s.noradId, s._group)
    if (!universe.has(s.noradId)) universe.set(s.noradId, s)
  }
  // 全部在轨（CelesTrak GROUP=active）并入全集；active 被 403/不可达时自动退化为分组并集
  let active = []
  try { const ap = await fetchGroupLiveOrSup('active'); active = ap.sats; if (ap.fetchedAt) fetchedAts.push(ap.fetchedAt) } catch { /* ignore */ }
  tick()
  for (const s of active) if (!universe.has(s.noradId)) universe.set(s.noradId, s)
  // 归类：在已知分组里的标该组，其余标“其他”
  for (const s of universe.values()) s._group = groupOf.get(s.noradId) || 'other'
  // 合并视图的下载时间：取各组最新一份（无则 null → 调用方回退 now）
  universeFetchedAt = fetchedAts.length ? fetchedAts.reduce((a, b) => (b > a ? b : a)) : null
  return [...universe.values()]
}
let universeFetchedAt = null   // loadUniverse 产出的“各组最新下载时间”，供 loadAll/loadOther 显示
async function loadAll() {
  const sats = await loadUniverse()
  if (!sats.length) { status.value = '暂无卫星数据（网络不可达）'; return }
  ingest(sats, 'all', universeFetchedAt || new Date().toISOString())
}
async function loadOther() {
  const others = (await loadUniverse()).filter((s) => s._group === 'other')
  if (!others.length) { status.value = '暂无“其他”卫星（或全集未加载成功）'; return }
  ingest(others, 'other', universeFetchedAt || new Date().toISOString())
}

// ===================== 选择 / 搜索 =====================
// 全量搜索库：独立于当前组的显示集 entries，后台加载一次「全部在轨」并集，使主界面/GRD 搜索
// 不受当前分组（含「无」）限制，全量可搜。失败/未就绪时回退当前组 entries。
let searchPool = []
let poolReady = false, poolLoading = false
async function ensureSearchPool() {
  if (poolReady || poolLoading || !apiOk) return
  poolLoading = true
  try {
    const sats = await loadUniverse(true)   // 静默：不打扰主状态栏
    const pool = []
    for (const s of sats) { try { const r = sat.omm2satrec(s); if (r && !r.error) pool.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || 'other' }) } catch { /* skip */ } }
    if (pool.length) { searchPool = pool; poolReady = true }
  } catch { /* 离线/失败：回退当前组 */ } finally { poolLoading = false }
}
const searchSource = () => (poolReady && searchPool.length ? searchPool : entries)

function selectSat(e, face) {
  selEntry = e
  resetBeam()
  const c = cardFor(e); if (c) selected.value = c
  buildSelectedGeometry()
  pushMarkers()   // 聚焦后立即在标记上显示仰角
  pushFocusSat()  // 2D 平面图标注聚焦卫星位置
  if (face && scene) {
    const now = calcAt(), gmst = sat.gstime(now)
    const pv = sat.propagate(e.rec, now)
    if (pv && pv.position) {
      const gd = sat.eciToGeodetic(pv.position, gmst)
      const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude)
      const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180
      // 与场景 llaToVec 同向的单位方向；faceTo 内部会归一化
      scene.faceTo({ x: -Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) })
      autoRotate.value = false
    }
  }
  saveSelection()
}

function onSearch(e) {
  keyword.value = e.target.value
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) { searchResults.value = []; return }
  ensureSearchPool()   // 懒加载全量搜索库（幂等）
  const now = new Date(), gmst = sat.gstime(now), geo = curKey() === 'geo'
  const src = searchSource(), out = []
  for (let i = 0; i < src.length && out.length < 40; i++) {
    const en = src[i]
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw)) {
      let slot = ''
      if (geo) { const pv = sat.propagate(en.rec, now); if (pv && pv.position) slot = fmtSlot(sat.degreesLong(sat.eciToGeodetic(pv.position, gmst).longitude)) }
      out.push({ en, name: en.name, noradId: en.noradId, groupLabel: GROUP_LABEL[en.group] || GROUP_LABEL[curKey()] || '', slot })
    }
  }
  searchResults.value = out
}
function clearSearch() { keyword.value = ''; searchResults.value = [] }
function pickResult(item) { searchResults.value = []; keyword.value = ''; selectSat(item.en, true) }
function closeCard() { selEntry = null; selected.value = null; resetBeam(); scene && scene.clearSelectionGeom(); selTrack = selFootprint = null; pushSelGeomFlat(); pushMarkers(); pushFocusSat(); saveSelection() }

// ===================== 波束角 =====================
function resetBeam() { if (!beamLock.value) beam.value = ''; beamAuto.value = '' }
function onBeam(e) {
  beam.value = e.target.value
  if (selEntry) { const now = calcAt(); buildFootprint(selEntry.rec, now, sat.gstime(now)) }
}
function toggleBeamLock() { beamLock.value = !beamLock.value }

// ===================== 时间轴 =====================
const track = ref(null)
// 文字刻度（0~1440 分钟＝未来 24h）：与小程序时间轴一致的整点标记
const timeTicks = [
  { min: 0, label: '此刻' },
  { min: 360, label: '+6h' },
  { min: 720, label: '+12h' },
  { min: 1080, label: '+18h' },
  { min: 1440, label: '+24h' }
]
// 刻度文字定位：首尾贴边、其余居中，避免溢出轨道两端
function tickStyle(min) {
  const tf = min === 0 ? 'translateX(0)' : min === 1440 ? 'translateX(-100%)' : 'translateX(-50%)'
  return { left: min / 14.4 + '%', transform: tf }
}
function trackToMin(clientX) {
  const r = track.value.getBoundingClientRect()
  return Math.round(clamp01((clientX - r.left) / r.width) * 1440)
}
// 拖拽/点击时间轴（监听挂 document，移出轨道仍连续）
function trackDown(e) {
  if (live.value || !track.value) return
  applyTime(trackToMin(e.clientX))
  const move = (ev) => applyTime(trackToMin(ev.clientX))
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
}
function applyTime(v) {
  timeOffset.value = clamp(v, 0, 1440); timePct.value = timeOffset.value / 1440 * 100
  if (live.value) { live.value = false; if (timer) { clearInterval(timer); timer = null } baseTime = Date.now() }
  refreshPositions()
}
function step(min) { applyTime((timeOffset.value || 0) + min) }
function resetTime() { if (!timeOffset.value && !live.value) return; baseTime = Date.now(); applyTime(0) }
function toggleLive() {
  live.value = !live.value
  if (live.value) { if (!timer) timer = setInterval(refreshPositions, 1000); refreshPositions() }
  else { if (timer) { clearInterval(timer); timer = null } baseTime = Date.now(); timeOffset.value = 0; timePct.value = 0; refreshPositions() }
}
function toggleRotate() { autoRotate.value = !autoRotate.value; scene && scene.setAutoRotate(autoRotate.value) }
function setNameMode(m) { nameMode.value = m; scene && scene.setLabelMode(m); if (flat) flat.setNameMode(m) }
async function toggleProvinces() {
  showProvinces.value = !showProvinces.value
  if (showProvinces.value && !provincesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); provincesData = mod.default || mod; scene && scene.setProvinces(provincesData); if (flat) flat.setProvinces(provincesData); provincesLoaded = true }
    catch (e) { /* 省界数据缺失 */ }
  }
  scene && scene.setProvincesVisible(showProvinces.value)
  if (flat) flat.setProvincesVisible(showProvinces.value)
}
async function toggleCities() {
  showCities.value = !showCities.value
  if (showCities.value && !citiesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-cities.json'); citiesData = mod.default || mod; scene && scene.setCities(citiesData); if (flat) flat.setCities(citiesData); citiesLoaded = true }
    catch (e) { /* 地级市数据缺失 */ }
  }
  scene && scene.setCitiesVisible(showCities.value)
  if (flat) flat.setCitiesVisible(showCities.value)
  applyNameScale()   // 套用当前地级市名字号（首次加载后生效）
}

// ===================== 覆盖图 =====================
let _presetCovSats = []   // 预置覆盖索引（只读）；用户 GXT 库与之合并成 covSats
async function ensureCovIndex() {
  if (covLoaded || !covApiOk) return
  covLoaded = true
  try { const idx = await window.api.coverage.index(); _presetCovSats = ((idx && idx.satellites) || []).map((s) => ({ ...s, displayName: displaySatName(s.displayName) })) }
  catch (e) { covStatus.value = '覆盖索引加载失败' }
  await mergeUserGxt()
}
// 把用户 GXT 库（文件管理器导入）合并进 covSats，使其可在覆盖图(GXT)面板里被添加绘制。
// 与文件管理器同口径：① 套用软隐藏（hidden）过滤内置星/波束；② 用户卫星【按名并入同名内置卫星】，
// 避免出现两个同名卫星（如内置「中星10R」+ 在其下加波束自动建的同名用户卫星）。
async function mergeUserGxt() {
  let ui = null
  try { if (window.api && window.api.coverageGxt) ui = await window.api.coverageGxt.index() } catch { /* 无库：仅用预置 */ }
  const hidden = (ui && ui.hidden) || {}
  const hiddenSats = new Set(hidden.sats || [])
  const hiddenBeams = new Set(hidden.beams || [])
  const byName = new Map(); const merged = []
  for (const s of _presetCovSats) {
    if (hiddenSats.has(s.folder)) continue
    const node = { ...s, beams: (s.beams || []).filter((b) => !hiddenBeams.has(b.key)) }
    merged.push(node); byName.set(String(s.displayName || '').toLowerCase(), node)
  }
  for (const s of (((ui && ui.satellites) || []))) {
    const ubeams = (s.beams || []).filter((b) => b.file).map((b) => ({ band: b.band || '', beam: b.name, type: b.type || 'EIRP', gains: b.gains || [], file: b.file, user: true, lon: b.lon }))
    if (!ubeams.length) continue
    const key = String(s.name || '').toLowerCase()
    const host = byName.get(key)
    if (host) host.beams = [...host.beams, ...ubeams]   // 并入同名内置卫星
    else { const node = { folder: 'gxt:' + s.id, displayName: s.name, satName: s.name, lon: s.lon, beams: ubeams }; merged.push(node); byName.set(key, node) }
  }
  covSats.value = merged
}
async function toggleCoverage() {
  covOpen.value = !covOpen.value
  if (covOpen.value) { await ensureCovIndex(); if (!covCleared.value) redraw() }   // 已清除则重开面板不复现覆盖
  // 关闭对话框不清空：已绘制的覆盖图保留在地图上（与标记一致）
}
// 缩放进度条桥接（底部状态栏 ↔ 当前活动地图：球体 scene / 平面图 flat）。
// 活动地图滚轮缩放 → 回填 zoom.value（进度条走动）；拖动进度条 / 按钮 → zoom.apply 设回地图。
const activeMap = () => (flatView.value && flat) ? flat : scene
// 视图记忆：球体/平面图各存一份完整视图（缩放 + 朝向/平移中心），下次启动恢复。
const VIEW_KEY = 'globe3d/view'
const savedView = { globe: null, flat: null }
try { const o = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null'); if (o && typeof o === 'object') { if (o.globe && typeof o.globe === 'object') savedView.globe = o.globe; if (o.flat && typeof o.flat === 'object') savedView.flat = o.flat } } catch { /* ignore */ }
let viewRestoredFlat = false
let _viewSaveTimer = null
// 读当前活动地图的完整视图并防抖写盘（缩放/平移/旋转任意变化后调用）
function saveView() {
  const kind = flatView.value ? 'flat' : 'globe'
  const m = activeMap()
  if (!m || !m.getView) return
  savedView[kind] = m.getView()
  if (_viewSaveTimer) clearTimeout(_viewSaveTimer)
  _viewSaveTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(savedView)) } catch { /* ignore */ } }, 300)
}
function pushZoom() { const m = activeMap(); if (m && m.getZoom) zoom.value = m.getZoom() }
function applyZoom(t) { const m = activeMap(); if (m && m.setZoom) { m.setZoom(t); zoom.value = t; saveView() } }
// 球体 <-> 平面图 切换（顶栏「视图」按钮与覆盖面板按钮共用 view.flat）
function toggleFlat() { view.flat = !view.flat }
watch(() => view.flat, (v) => applyFlat(v))
async function applyFlat(v) {
  flatView.value = v
  // 切回 3D：补齐 3D 覆盖层。编辑电平时只 patch 了当前可见视图（recomputeActive），另一视图需在此一次性重算。
  if (!v) { if (grdOpen.value) grd.recompute(); pushZoom(); return }
  await ensureCovIndex(); if (!covCleared.value) redraw()   // 已清除则切平面图不复现覆盖（covGeom 保持为空）
  await nextTick()
  if (ensureFlat()) {
    feedFlat()   // 内含 resize → base 就绪，之后才能正确 setView
    // 首次进入平面图时恢复上次视图（缩放+平移中心）；之后切换保持当前，不再覆盖
    if (!viewRestoredFlat) { viewRestoredFlat = true; if (savedView.flat) flat.setView(savedView.flat) }
    pushZoom()
  }
}
// 平面渲染器：按需创建（绑定交互回调）。返回实例（flatCanvas 未就绪时返回 null）。
function ensureFlat() {
  if (!flat && flatCanvas.value) {
    flat = createFlatCoverage(flatCanvas.value)
    flat.setRenderScale(displayQuality.value.pixelRatio); flat.setMapDetail(displayQuality.value.mapDetail, displayQuality.value.mapThin)
    flat.setOnRightClick(onMapRightClick); flat.setOnHover((ll) => { cursor.ll = ll }); flat.setOnBeamDrag(grd.beamDrag); flat.setBeamDragMode(grd.dragBore.value)
    flat.setOnZoom((t) => { if (flatView.value) { zoom.value = t; saveView() } })
    flatCanvas.value.addEventListener('pointerup', saveView)   // 平移结束保存视图（平移中心）
  }
  return flat
}
// 把当前全部状态（底图选项/标记/覆盖几何/GRD 场/卫星层/聚焦星）喂给平面渲染器。
// 切到平面图与「导出（含 3D 视图下）」共用，保证导出所见即所得。
function feedFlat() {
  if (!flat) return
  flat.resize()
  flat.setNameMode(nameMode.value)
  if (provincesData) flat.setProvinces(provincesData)
  flat.setProvincesVisible(showProvinces.value)
  if (citiesData) flat.setCities(citiesData)
  flat.setCitiesVisible(showCities.value)
  flat.setBorderStyle({ ...borderStyle })
  flat.setLabelStyle({ ...labelStyle })
  flat.setOceanColor(oceanColor.value)
  flat.setMarkers(markerPts(), markerSts(), markerTrs())
  flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value, ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value, ptDot: markPtDot.value, trajDot: trajDotSize.value })
  flat.setGeom(covGeom)
  grd.recompute()   // GRD 覆盖：把当前选中天线的面+线喂给 flat（recompute 同时喂 scene/flat）
  redrawSats()      // 卫星/仰角线图层
  pushFocusSat()    // 聚焦卫星位置
  pushSelGeomFlat() // 聚焦卫星覆盖范围 + 星下点轨迹
}

// ===================== 覆盖图导出（高清 PNG / 矢量 PDF，统一走 2D 平面图） =====================
const exporting = ref(false)
let _cjkFont   // undefined=未取；string=base64；null=无可用中文字体
async function getCjkFont() {
  if (_cjkFont !== undefined) return _cjkFont
  try { const r = window.api && window.api.cjkFont && await window.api.cjkFont(); _cjkFont = (r && r.ok) ? r.base64 : null }
  catch { _cjkFont = null }
  return _cjkFont
}
async function saveExport(bytes, defaultName, filters) {
  if (!(window.api && window.api.exportFile)) { appAlert('需在 Electron 中运行（npm run dev）'); return }
  const r = await window.api.exportFile({ defaultName, data: bytes, filters })
  // 成功/取消无需提示（已走系统保存对话框，用户自选路径即知结果）；仅失败弹错。
  if (r && !r.ok && !r.canceled) { const msg = (r && r.error) || '写入失败'; appAlert('导出失败：' + msg) }
}
// fmt: 'png2' | 'png4' | 'pdf'。无论当前在 2D 还是 3D 视图，都按 2D 平面图导出整幅世界图。
// scope: 'world'(整幅世界图，默认) | 'view'(当前视图，所见即所得)。view 模式需在 2D 平面图下，按屏幕缩放/平移出图。
async function exportMap(fmt, scope) {
  if (exporting.value) return
  const view = scope === 'view'
  if (view && !flatView.value) { appAlert('「截图」导出需先切换到 2D 平面图（顶栏「视图」按钮），再框定要导出的范围'); return }
  exporting.value = true
  try {
    await ensureCovIndex(); if (!covCleared.value) redraw()
    await nextTick()
    if (!ensureFlat()) { appAlert('地图渲染器未就绪，请切到 2D 平面图后重试'); return }
    feedFlat()   // resize() 仅首帧 fit，已交互过的缩放/平移会保留 → view 模式即所见即所得
    await nextTick()
    const tag = view ? '截图' : '全球图'
    const { renderFlatPNG, renderFlatPDF } = await import('../viz/flatmap/exportFlat.js')
    if (fmt === 'pdf') {
      // 矢量 PDF 按「设置」里的底图精度导出（flat 实例已随 displayQuality 同步精度）：
      // 10m 更清晰但点数约 5.5× → 导出更慢、文件更大；如需更快可在设置里调到 50m/110m。
      const fontBase64 = await getCjkFont()
      const bytes = await renderFlatPDF(flat, { base: 2400, fontBase64, view })
      await saveExport(bytes, `覆盖图_${tag}.pdf`, [{ name: 'PDF 矢量图', extensions: ['pdf'] }])
    } else {
      const factor = fmt === 'png4' ? 4 : 2
      const bytes = await renderFlatPNG(flat, { base: 2400, factor, view })
      await saveExport(bytes, `覆盖图_${tag}_${factor}x.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
    }
  } catch (e) { console.error('导出失败', e); appAlert('导出失败：' + ((e && e.message) || e)) }
  finally { exporting.value = false }
}

// ---- 批次 / 卫星 增删改 ----
function newBatch() {
  const color = hexToCss(DEF_COLORS[covColorCursor++ % DEF_COLORS.length])
  return { id: newCovId(), name: '', q: '', beams: [], gains: [], custom: '', mode: 'gradient', solid: color, gainColors: {}, width: 1.6 }
}
const covTrash = {}   // folder -> 已移除卫星的设置（type/band/batches），再次添加时恢复，避免重配批次
function addCovSat() {
  const folder = covAddSel.value; if (!folder) return
  covAddSel.value = ''
  if (covItems.value.find((i) => i.folder === folder)) return   // 已添加则跳过
  const idx = idxOf(folder); if (!idx) return
  const saved = covTrash[folder]; delete covTrash[folder]   // 恢复上次移除时保留的批次设置
  covItems.value.push(saved
    ? { id: newCovId(), folder, type: saved.type, band: saved.band, batches: saved.batches }
    : { id: newCovId(), folder, type: 'EIRP', band: 'all', batches: [newBatch()] })
  redraw()
}
// 移除卫星：仅从绘制列表移除，保留其批次设置，再次添加时恢复
function removeCovSat(it) {
  covTrash[it.folder] = { type: it.type, band: it.band, batches: it.batches }
  const i = covItems.value.indexOf(it); if (i >= 0) covItems.value.splice(i, 1); redraw()
}
function setItemType(it, t) {
  if (it.type === t) return
  it.type = t; it.band = 'all'
  for (const ba of it.batches) { ba.beams = []; ba.gains = [] }
  redraw()
}
function onItemBand(it, e) {
  it.band = e.target.value
  const ids = beamRowsOf(it).map((r) => r.id)
  for (const ba of it.batches) { ba.beams = ba.beams.filter((id) => ids.includes(id)); ba.gains = batchGains(it, ba) }
  redraw()
}
function addBatch(it) { it.batches.push(newBatch()); redraw() }
function removeBatch(it, ba) { const i = it.batches.indexOf(ba); if (i >= 0) it.batches.splice(i, 1); redraw() }
function setBatchName(it, ba, e) { ba.name = e.target.value }
function focusCovSat(it) { const idx = idxOf(it.folder); if (idx && idx.lon != null) { scene.faceLonLat(idx.lon, 0); autoRotate.value = false } }

// 批次内设置统一作用于全部波束。增删波束时【保留已选增益档】（新增的波束并入其档，删除的仅去掉失效档）
function toggleBatchBeam(it, ba, id) {
  const i = ba.beams.indexOf(id)
  if (i >= 0) {
    ba.beams.splice(i, 1)
    const all = new Set(batchGains(it, ba))
    ba.gains = ba.gains.filter((g) => all.has(g))                                  // 删波束：保留已选，仅去掉已不可选的档
  } else {
    ba.beams.push(id)
    ba.gains = [...new Set([...ba.gains, ...beamRowGains(it, id)])].sort((a, b) => a - b)   // 加波束：并入新档，保留已选
  }
  redraw()
}
function onBatchQuery(it, ba, e) { ba.q = e.target.value }   // 仅过滤波束列表，无需重绘
// 全选/取消：作用于【当前过滤结果】，可多次累加，便于在大量波束里分批多选
function allBatchBeams(it, ba, on) {
  const rows = filteredBeamRows(it, ba)
  if (on) {
    const bset = new Set(ba.beams), gset = new Set(ba.gains)
    for (const r of rows) { bset.add(r.id); for (const g of r.gains) gset.add(g) }
    ba.beams = [...bset]; ba.gains = [...gset].sort((a, b) => a - b)
  } else {
    const rem = new Set(rows.map((r) => r.id))
    ba.beams = ba.beams.filter((id) => !rem.has(id))
    const all = new Set(batchGains(it, ba))
    ba.gains = ba.gains.filter((g) => all.has(g))
  }
  redraw()
}
// 反选：对当前过滤结果取反
function invertBatchBeams(it, ba) {
  const rows = filteredBeamRows(it, ba)
  const sel = new Set(ba.beams), gset = new Set(ba.gains)
  for (const r of rows) { if (sel.has(r.id)) sel.delete(r.id); else { sel.add(r.id); for (const g of r.gains) gset.add(g) } }
  ba.beams = [...sel]
  const all = new Set(batchGains(it, ba))
  ba.gains = [...gset].filter((g) => all.has(g)).sort((a, b) => a - b)
  redraw()
}
function toggleBatchGain(it, ba, g) { const i = ba.gains.indexOf(g); if (i >= 0) ba.gains.splice(i, 1); else ba.gains.push(g); redraw() }
function allBatchGains(it, ba, on) { ba.gains = on ? batchGains(it, ba) : []; redraw() }
function onBatchCustom(it, ba, e) { ba.custom = e.target.value; redraw() }
function setBatchMode(it, ba, m) { if (ba.mode === m) return; ba.mode = m; redraw() }
function onBatchSolid(it, ba, e) { ba.solid = e.target.value; redraw() }
function onGainColor(it, ba, g, e) { ba.gainColors[g] = e.target.value; redraw() }
function onBatchWidth(it, ba, e) { ba.width = Number(e.target.value); redraw() }

function toggleBeamLabels() { showBeamLabels.value = !showBeamLabels.value; redraw() }
function setBeamFont(e) { beamLabelSize.value = Number(e.target.value); redraw() }
function setBoreSize(e) { boreSize.value = Number(e.target.value); redraw() }
function setContourSize(e) { contourLabelSize.value = Number(e.target.value); redraw() }
function applyNameScale() { if (scene) scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value); if (flat) flat.setSizes({ nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value }) }
function setCountryNameSize(e) { countryNameSize.value = Number(e.target.value); applyNameScale() }
function setProvNameSize(e) { provNameSize.value = Number(e.target.value); applyNameScale() }
function setCityNameSize(e) { cityNameSize.value = Number(e.target.value); applyNameScale() }
// 国界/省界线样式 → 3D 与平面图。{ ...borderStyle } 取响应式对象快照传入两个渲染器。
function applyBorderStyle() { const s = { ...borderStyle }; if (scene) scene.setBorderStyle(s); if (flat) flat.setBorderStyle(s) }
// 地名颜色/透明度 → 3D 与平面图。
function applyLabelStyle() { const s = { ...labelStyle }; if (scene) scene.setLabelStyle(s); if (flat) flat.setLabelStyle(s) }
// 大海颜色 → 3D 与平面图。
function setOceanColor(c) { oceanColor.value = c; if (scene) scene.setOceanColor(c); if (flat) flat.setOceanColor(c) }
// 显示画质（全局档位）→ 应用到 3D / 2D / 覆盖网格。msaa 不在此（需重建上下文，由 3D 视图按 key 重挂载切换）。
function applyDisplayQuality() {
  const q = displayQuality.value
  if (scene) { scene.setPixelRatio(q.pixelRatio); scene.setRenderFps(q.fps); scene.setSphereDetail(q.sphereSeg); scene.setMapDetail(q.mapDetail, q.mapThin) }
  if (flat) { flat.setRenderScale(q.pixelRatio); flat.setMapDetail(q.mapDetail, q.mapThin) }
  grd.recompute()   // gridStride 变化 → 覆盖层按新步长重建（无选中层时为空操作）
}
function setPtFont(e) { markPtFont.value = Number(e.target.value); syncMarkers() }
function setPtDot(e) { markPtDot.value = Number(e.target.value); syncMarkers() }
function setStIcon(e) { stIconSize.value = Number(e.target.value); syncMarkers() }
function setStFont(e) { stFontSize.value = Number(e.target.value); syncMarkers() }
function setTrajDot(e) { trajDotSize.value = Number(e.target.value); syncMarkers() }
function togglePtLabel() { showPtLabel.value = !showPtLabel.value; syncMarkers() }
function toggleStName() { showStName.value = !showStName.value; syncMarkers() }
function togglePtLayer() { showPtLayer.value = !showPtLayer.value; syncMarkers() }
function toggleStLayer() { showStLayer.value = !showStLayer.value; syncMarkers() }
function toggleTrajLayer() { showTrajLayer.value = !showTrajLayer.value; syncMarkers() }
function toggleBore() { showBore.value = !showBore.value; redraw() }
function toggleContourLabels() { showContourLabels.value = !showContourLabels.value; redraw() }
// 以 (lat0,lon0) 为心、角半径 lambda 的地表小圆 -> [[lon,lat]...]
function circleLonLatArr(lat0, lon0, lambda, N) {
  const la = lat0 * DEG, lo = lon0 * DEG
  const u = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  let ref = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  let e1 = [u[1] * ref[2] - u[2] * ref[1], u[2] * ref[0] - u[0] * ref[2], u[0] * ref[1] - u[1] * ref[0]]
  const n1 = Math.hypot(e1[0], e1[1], e1[2]) || 1; e1 = [e1[0] / n1, e1[1] / n1, e1[2] / n1]
  const e2 = [u[1] * e1[2] - u[2] * e1[1], u[2] * e1[0] - u[0] * e1[2], u[0] * e1[1] - u[1] * e1[0]]
  const cosL = Math.cos(lambda), sinL = Math.sin(lambda), out = []
  for (let i = 0; i <= N; i++) {
    const th = (i / N) * 2 * Math.PI, c = Math.cos(th), si = Math.sin(th)
    const w = [cosL * u[0] + sinL * (c * e1[0] + si * e2[0]), cosL * u[1] + sinL * (c * e1[1] + si * e2[1]), cosL * u[2] + sinL * (c * e1[2] + si * e2[2])]
    out.push([Math.atan2(w[1], w[0]) / DEG, Math.asin(clamp(w[2], -1, 1)) / DEG])
  }
  return out
}

let redrawSeq = 0
async function redraw() {
  if (!scene) return
  covCleared.value = false   // 显式重绘（添加卫星/改批次/调显示项等）解除「已清除」状态
  const seq = ++redrawSeq
  const lines = [], dots = [], labels = [], sats = [], bores = [], legend = []
  let loading = false
  for (const it of covItems.value) {
    const idx = idxOf(it.folder); if (!idx) continue
    sats.push({ lon: idx.lon, name: idx.displayName })
    const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
    for (const ba of it.batches) {
      const eff = batchEffGains(ba)   // 批次统一生效增益档；空=不画等值线
      // 加载该批次波束数据（带缓存）
      const datas = []
      for (const id of ba.beams) {
        const r = rowById.get(id); if (!r) continue
        try {
          if (!covCache[r.file]) { loading = true; covStatus.value = '加载覆盖…'; covCache[r.file] = await (r.user ? window.api.coverageGxt.get(r.file) : window.api.coverage.get(r.file)) }
          datas.push({ r, d: covCache[r.file] })
        } catch (e) { /* skip */ }
      }
      if (seq !== redrawSeq) return   // 已被更新的重绘取代
      const allG = []
      for (const { d } of datas) for (const c of d.contours) if (eff.has(c.g)) allG.push(c.g)
      const gmin = allG.length ? Math.min(...allG) : 0, gmax = allG.length ? Math.max(...allG) : 1
      for (const { r, d } of datas) {
        for (const c of d.contours) {
          if (!eff.has(c.g)) continue
          lines.push({ p: c.p, color: contourColor(ba, c.g, gmin, gmax), width: ba.width })
          if (showContourLabels.value && c.p.length) {
            let top = c.p[0]; for (const pt of c.p) if (pt[1] > top[1]) top = pt
            labels.push({ lon: top[0], lat: top[1], text: String(c.g), hpx: contourLabelSize.value / 533, color: '#ffffff', alt: 50 })
          }
        }
        if (showBore.value) for (const b of (d.bore || [])) { dots.push({ lon: b[0], lat: b[1] }); bores.push({ lon: b[0], lat: b[1], satLon: idx.lon }) }
        if (showBeamLabels.value && d.bore && d.bore[0]) labels.push({ lon: d.bore[0][0], lat: d.bore[0][1], text: r.beam, hpx: beamLabelSize.value / 533 })
      }
      if (allG.length) legend.push({ name: (ba.name && ba.name.trim()) ? ba.name : idx.displayName, mode: ba.mode, gmin, gmax, type: it.type, solid: ba.solid })
    }
  }
  scene.setCoverage({ lines, dots, labels, sats, bores, dotR: boreSize.value * 0.0014 })
  covGeom = { lines, dots, labels, sats }   // 平面图共用同一份几何（不含卫星连线 bores）
  if (flat) { flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value }); flat.setGeom(covGeom) }
  covLegend.value = legend
  if (!loading) covStatus.value = ''
}
// 只清当前绘制的覆盖图（图形 + 图例），保留卫星 / 批次设置，便于再次绘制
function clearCoverage() {
  covCleared.value = true   // 保持已清除：后续切视图/重开面板的「被动重绘」不再复现 GXT（直到用户显式重绘）；入 snapshot 后跨重启保留
  covGeom = { lines: [], dots: [], labels: [], sats: [] }
  covLegend.value = []; covStatus.value = ''
  if (scene) scene.setCoverage(null)
  if (flat) flat.setGeom(covGeom)
}

// 采集当前画面绘制的覆盖（GXT 来源 covItems + GRD 来源 grd）为 GXT 用数据数组。供文件管理器「导出当前画面覆盖为 GXT」。
function collectGxt() {
  const out = []
  for (const it of covItems.value) {
    const idx = idxOf(it.folder); if (!idx) continue
    const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
    for (const ba of it.batches) {
      const eff = batchEffGains(ba)
      for (const id of ba.beams) {
        const r = rowById.get(id); if (!r) continue
        const d = covCache[r.file]; if (!d) continue
        const contours = (d.contours || []).filter((c) => eff.has(c.g))
        if (!contours.length) continue
        out.push({ name: r.beam, satName: idx.displayName, lon: idx.lon, bore: d.bore || [], contours, emiRcp: 'E' })
      }
    }
  }
  if (grd && grd.exportContours) { try { out.push(...grd.exportContours()) } catch (e) { console.warn('GRD 导出等值线失败', e) } }
  return out
}

// ===================== 仰角线（卫星属性，挂在 GRD 卫星树的每个卫星上） =====================
// 仰角线是卫星属性、不是天线：每个卫星节点(grd.sats)自带 { els, elevColor, elevShow }。
//   预置星 GEO 定点 (lon,0,GEO_ALT)；自定义星固定 lon/lat/altKm；
//   星座关联星(kind:'linked') 位置随 calcAt()（时间轴/实时）由 satLivePos 解算。
// 数据与增删全部走 useGrdCoverage；本页只负责按星历解算关联星位置 + 渲染独立图层。
const GEO_ALT = 35786              // GEO 轨道高度 km（一键GEO / 预置星默认）：NASA 标称值（22,236 mi）

// 天线名内联重命名：grdEditAnt 存正在编辑的天线 key（folder|name），grdEditVal 为输入框值
const grdEditAnt = ref('')
const grdEditVal = ref('')
function startRenameAnt(sat, a) { grdEditAnt.value = grd.keyOf(sat.folder, a.name); grdEditVal.value = a.name }
function commitRenameAnt(sat, a) {
  if (grdEditAnt.value === '') return   // 已提交（blur 与 ✓/回车可能重复触发）→ 跳过
  if (grd.renameAntenna(sat.folder, a.name, grdEditVal.value) === false) {
    appAlert('天线名为空或与同星其他天线重名')   // 校验失败 → 保持编辑态，可继续修改
    return
  }
  grdEditAnt.value = ''
}

// 仰角线显示开关（仰角值/颜色在卫星「✎」弹窗里编辑）
function toggleSatElev(node) { node.elevShow = !node.elevShow; redrawSats() }
function toggleSatLabel(node) { node.labelShow = node.labelShow === false; redrawSats(); if (grdOpen.value) grd.recompute() }   // 卫星名开关也影响 3D 覆盖连线(卫星↔波束中心)，需重绘覆盖层
// 是否有显示中且位置随时间变化的卫星（星座关联星 / 轨道根数模拟星）：其仰角线/卫星名需随时间刷新位置
const hasLinkedElev = () => grdSats.value.some((s) => (s.noradId || s.elements) && (s.elevShow || s.labelShow !== false))
// 随 GRD「清除绘图」一并隐藏所有仰角线与卫星名（保留各星配置，再点亮即重绘）
function grdClearDrawing() {
  grd.clearDrawing()
  for (const s of grdSats.value) { s.elevShow = false; s.labelShow = false }
  redrawSats()
}
// 添加/编辑卫星弹窗（null=关闭）+ 从星座点选/搜索状态
const satModal = ref(null)
const satPick = ref(false)
const satSearchKw = ref('')
const satSearchRes = ref([])
const liveTick = ref(0)   // 每次 refreshPositions 自增：驱动关联星编辑弹窗的经纬度/高度随星历实时刷新

// 编辑弹窗里展示的位置：关联星按星历实时解算（随 liveTick / 时间轴更新），否则取草稿手填值
const satModalPos = computed(() => {
  const m = satModal.value
  if (!m) return { lon: 0, lat: 0, altKm: 0 }
  if (m.noradId) {
    liveTick.value   // 触发依赖：实时/时间轴每秒自增
    const p = satLivePos({ noradId: m.noradId })
    if (Number.isFinite(p.lon)) return { lon: +p.lon.toFixed(3), lat: +p.lat.toFixed(3), altKm: +p.altKm.toFixed(1) }
    return { lon: m.lon, lat: m.lat, altKm: m.altKm }   // 星历未就绪：回退到存储值
  }
  return { lon: m.lon, lat: m.lat, altKm: m.altKm }
})

const defaultElements = () => ({ altKm: 500, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0 })
function defaultSatDraft() {
  return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, color: '#ffffff', els: '5,10', noradId: null, posMode: 'fixed', elements: defaultElements(), elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4 }
}
// hideViz：从文件管理器调起时为 true，隐藏可视化项（图标/字号/仰角线/颜色），其余功能（定位方式/星座关联）一致
function openAddSat(hideViz = false) { satModal.value = { ...defaultSatDraft(), hideViz }; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
// 编辑已有卫星（含预置星）：名称/位置/关联/仰角线/图标与标签大小都可改
function editSat(node, hideViz = false) { satModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, color: node.elevColor, els: node.els, noradId: node.noradId, kind: node.kind, posMode: node.elements ? 'orbit' : 'fixed', elements: node.elements ? { ...node.elements } : defaultElements(), elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18, iconSize: node.iconSize || 10, labelSize: node.labelSize || 4, hideViz }; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
function closeSatModal() { satModal.value = null; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
function applyGeoAlt() { if (satModal.value) satModal.value.altKm = GEO_ALT }   // 一键GEO：轨道高度设为 GEO

function saveSatModal() {
  const m = satModal.value; if (!m) return
  // 关联星：保存当前星历解算的位置作为存储回退值（无星座时按此投影），而非草稿里的陈旧值
  if (m.noradId) { const p = satLivePos({ noradId: m.noradId }); if (Number.isFinite(p.lon)) { m.lon = p.lon; m.lat = p.lat; m.altKm = p.altKm } }
  // 轨道根数模拟星：校验根数 → 试建 satrec → 取当前星下点作为静态回退位置（lon/lat/altKm）
  const orbit = !m.noradId && m.posMode === 'orbit'
  let elements = null
  if (orbit) {
    const el = m.elements || {}
    const alt = Number(el.altKm), ecc = Number(el.ecc), incl = Number(el.incl)
    if (!(alt > 0) || !(ecc >= 0 && ecc < 1) || !(incl >= 0 && incl <= 180)) { appAlert('轨道根数非法：需 轨道高度>0、0≤偏心率<1、0≤倾角≤180'); return }
    elements = { altKm: alt, ecc, incl, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0 }
    let rec; try { rec = elementsToSatrec(elements) } catch { rec = null }
    if (!rec || rec.error) { appAlert('该组根数无法构造有效轨道（可能已衰减或超界），请调整'); return }
    const now = calcAt(); const pv = sat.propagate(rec, now)
    if (!pv || !pv.position) { appAlert('轨道传播失败，请检查根数'); return }
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(now))
    m.lon = sat.degreesLong(gd.longitude); m.lat = sat.degreesLat(gd.latitude); m.altKm = gd.height
  }
  const lon = Number(m.lon), lat = Number(m.lat), altKm = Number(m.altKm)
  if (!validLon(lon) || !validLat(lat) || !(altKm > 0)) { return }   // 非法输入不保存
  if (m.folder) {
    // 所有星（含预置）都可改名称/位置/关联/仰角线。预置星 kind 保持 'preset'（仍属平台数据、不在树里删）；
    // 自定义/星座/模拟星按定位方式切换 custom/linked/orbit。是否随时间跟踪由 noradId / elements 决定，与 kind 无关。
    const patch = { satName: (m.name || '卫星').trim() || '卫星', lon, lat, altKm, noradId: m.noradId || null, elements: orbit ? elements : null, els: m.els || '', elevColor: m.color || '#66ddff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18, iconSize: Number(m.iconSize) || 10, labelSize: Number(m.labelSize) || 4 }
    if (m.kind !== 'preset') patch.kind = m.noradId ? 'linked' : (orbit ? 'orbit' : 'custom')
    grd.updateSatellite(m.folder, patch)
  } else {
    grd.addSatellite({ name: m.name, lon, lat, altKm, noradId: m.noradId, elements, els: m.els, color: m.color, elevWidth: m.elevWidth, elevLabelSize: m.elevLabelSize, iconSize: m.iconSize, labelSize: m.labelSize })
  }
  closeSatModal(); redrawSats()
}
function removeSat(node) { grd.removeSatellite(node.folder); redrawSats() }

// ===== 轨道根数模拟星：用经典根数自建 satrec，复用 SGP4 引擎自行解算（不并入真实星座 entries）=====
const MU = 398600.4418   // 地球引力常数 km^3/s^2
// 经典轨道根数 → satrec（复用 omm2satrec；历元取当前时刻）。elements 角度单位 °，altKm 视作近地点高度（圆轨道 e=0 即轨道高度）。
function elementsToSatrec(el) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)   // 半长轴：a=(RE+hp)/(1-e)
  const n = Math.sqrt(MU / (a * a * a))                  // 平均运动 rad/s
  const meanMotion = 86400 * n / (2 * Math.PI)           // rev/day（omm2satrec 所需）
  return sat.omm2satrec({
    noradId: 'SIM', epoch: new Date().toISOString(),
    meanMotion, ecc, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0,
    argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, bstar: 0, mdot: 0, mddot: 0
  })
}
// 模拟星 satrec 缓存：根数签名不变则复用（历元随之冻结 → 同一会话内相位连续；改根数/重载时重建）
const customSatrecs = new Map()   // folder -> { sig, rec }
function orbitSatrec(node) {
  const sig = JSON.stringify(node.elements)
  const hit = customSatrecs.get(node.folder)
  if (hit && hit.sig === sig) return hit.rec
  const rec = elementsToSatrec(node.elements)
  customSatrecs.set(node.folder, { sig, rec })
  return rec
}
// 当前生效位置：星座关联星按 calcAt() 实时解算；轨道根数模拟星按自建 satrec 解算；否则取节点存储值
function satLivePos(node) {
  if (node.noradId) {
    const en = entries.find((x) => String(x.noradId) === String(node.noradId)) || searchPool.find((x) => String(x.noradId) === String(node.noradId))
    if (en) { const now = calcAt(); const pv = sat.propagate(en.rec, now); if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, sat.gstime(now)); return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), altKm: gd.height } } }
  } else if (node.elements) {
    try { const now = calcAt(); const pv = sat.propagate(orbitSatrec(node), now); if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, sat.gstime(now)); return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), altKm: gd.height } } } catch { /* 根数异常 → 回退静态值 */ }
  }
  return { lon: node.lon, lat: node.lat, altKm: node.altKm }
}

// 把实时关联星(linked/orbit)的【当前】星下点写入轻量缓存 globe3d/grdLive，供独立的链路预算窗口
// 在选星/导入时取到新位置（与覆盖分析同源 satLivePos）。固定星不写（其 lon 本就是真值）。节流 3s。
let _grdLiveT = 0
function persistGrdLive() {
  const sats = (grd.sats && grd.sats.value) || []
  if (!sats.some((s) => s.noradId || s.elements)) return
  const nowMs = Date.now()
  if (nowMs - _grdLiveT < 3000) return
  _grdLiveT = nowMs
  const pos = {}
  for (const s of sats) {
    if (!(s.noradId || s.elements)) continue
    const p = satLivePos(s)
    if (p && Number.isFinite(p.lon)) pos[s.folder] = { lon: +p.lon.toFixed(4), lat: +(p.lat || 0).toFixed(4), altKm: +(p.altKm || 0).toFixed(1) }
  }
  try { localStorage.setItem('globe3d/grdLive', JSON.stringify({ t: nowMs, pos })) } catch { /* ignore */ }
  fileBridge.liveTick++   // 驱动文件管理器 GRD 树行经度跟随实时
}

// 从星座点选：进入点选模式后，地图 onPick 命中的星填入弹窗（见 onMounted）
function toggleSatPick() { satPick.value = !satPick.value }
function pickEntryIntoModal(en) {
  if (!satModal.value || !en) return
  const p = satLivePos({ noradId: en.noradId })   // 借助同一解算路径取该星当前星下点/高度
  if (Number.isFinite(p.lon)) { satModal.value.lon = +p.lon.toFixed(3); satModal.value.lat = +p.lat.toFixed(3); satModal.value.altKm = +p.altKm.toFixed(1) }
  if (!satModal.value.name) satModal.value.name = en.name
  satModal.value.noradId = String(en.noradId)
  satPick.value = false
}
function onSatSearch(e) {
  satSearchKw.value = e.target.value
  const kw = satSearchKw.value.trim().toLowerCase()
  if (!kw) { satSearchRes.value = []; return }
  ensureSearchPool()   // 懒加载全量搜索库（幂等）
  const src = searchSource(), out = []
  for (let i = 0; i < src.length && out.length < 30; i++) {
    const en = src[i]
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw)) out.push({ en, name: en.name, noradId: en.noradId, groupLabel: GROUP_LABEL[en.group] || GROUP_LABEL[curKey()] || '' })
  }
  satSearchRes.value = out
}
function pickSatSearch(r) { pickEntryIntoModal(r.en); satSearchKw.value = ''; satSearchRes.value = [] }

// 重绘仰角线独立图层（3D + 平面图共用同一 spec）；遍历卫星树每个点亮的卫星
function redrawSats() {
  if (!scene) return
  const lines = [], labels = [], sats = []
  for (const node of grdSats.value) {
    // 两项相互独立：卫星名（图标/名称）由 labelShow 控；等仰角线由 elevShow 控且需填仰角值。
    const showLabel = node.labelShow !== false
    const els = parseNums(node.els)
    const showElev = node.elevShow && els.length > 0
    if (!showLabel && !showElev) continue
    const p = (node.noradId || node.elements) ? satLivePos(node) : { lon: node.lon, lat: node.lat, altKm: node.altKm }
    if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat) || !(p.altKm > 0)) continue
    const color = node.elevColor, colNum = cssToHex(color)
    if (showElev) {
      const w = node.elevWidth || 1.3
      const satEcef = W.geodeticToEcef(p.lon, p.lat, p.altKm)
      for (const el of els) {
        if (!(el >= 0 && el < 90)) continue
        const ring = W.isoElevationContourAt(satEcef, el, 160)
        if (!ring || ring.length < 3) continue
        lines.push({ p: ring, color: colNum, width: el === 0 ? w * 1.45 : w, opacity: el === 0 ? 0.95 : 0.85, closed: true })
        // 角度标注：沿正北/东/南/西四个方位（相对星下点的地理方位角）各取一个环上点，0° 也标成「0°」
        const elTxt = el + '°', elHpx = (node.elevLabelSize || 18) / 533
        const phi1 = p.lat * DEG, best = [0, 90, 180, 270].map(() => ({ d: Infinity, q: null }))
        for (const q of ring) {
          const phi2 = q[1] * DEG, dlon = (q[0] - p.lon) * DEG
          let az = Math.atan2(Math.sin(dlon) * Math.cos(phi2), Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dlon)) / DEG
          if (az < 0) az += 360
          ;[0, 90, 180, 270].forEach((dir, i) => { let diff = Math.abs(az - dir); if (diff > 180) diff = 360 - diff; if (diff < best[i].d) best[i] = { d: diff, q } })
        }
        for (const b of best) if (b.q) labels.push({ lon: b.q[0], lat: b.q[1], text: elTxt, hpx: elHpx, color, alt: 40 })
      }
    }
    // 卫星名/图标：不依赖仰角值，仅由 labelShow 决定（3D 只画名，2D 画图标+名）
    if (showLabel) sats.push({ lon: p.lon, lat: p.lat, altKm: p.altKm, name: node.satName, color: colNum, nameColor: color, iconSize: node.iconSize || 10, labelSize: node.labelSize || 4, labelShow: true })
  }
  const spec = (lines.length || sats.length) ? { lines, dots: [], labels, sats } : null
  scene.setSatLayer(spec)
  if (flat) flat.setSatLayer(spec)
}

// ===================== 标记 / 地面站 / 轨迹 =====================
const MK_KEY = 'globe3d/markers'
const mkOpen = ref(false)
const points = ref([])             // [{id,lat,lon}]
const stations = ref([])           // [{id,lat,lon,name}]
const trajectories = ref([])       // [{id,name,kind,pts:[{lat,lon}]}]
const activeTraj = ref('')         // 当前编辑的轨迹 id
const ptLat = ref(''), ptLon = ref('')
const stLat = ref(''), stLon = ref(''), stName = ref('')
const wpLat = ref(''), wpLon = ref('')
const markPtFont = ref(14)         // 点标记坐标字号（1–32）
const markPtDot = ref(3.5)         // 点标记圆点大小（半径口径，1–12，默认偏小）
const stIconSize = ref(16)         // 地面站图标大小（5–60，默认 16）
const stFontSize = ref(17)         // 地面站名称字号（1–32）
const trajDotSize = ref(2.5)       // 轨迹圆点大小（半径口径，1–10，默认偏小）
const showPtLabel = ref(false)     // 是否显示点标记坐标文字（默认不显示；圆点不受影响）
const showStName = ref(false)      // 是否显示地面站名称文字（默认不显示；图标不受影响）
const showPtLayer = ref(true)      // 点标记图层显隐（小眼睛；隐藏仅停止渲染，数据保留并持久化）
const showStLayer = ref(true)      // 地面站图层显隐（小眼睛）
const showTrajLayer = ref(true)    // 航迹图层显隐（小眼睛）
let mkSeq = 1
const newId = () => 'm' + Date.now().toString(36) + (mkSeq++)   // 跨会话唯一，避免与已存数据撞 key

// 经度在前、纬度在后，保留两位小数
const fmtLL = (lat, lon) => `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}, ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90
const validLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180

// 当前聚焦卫星相对地面点(lat,lon)的仰角；未聚焦或不可解算时返回 null
function satElevAt(lat, lon) {
  if (!selEntry) return null
  const now = calcAt()
  const pv = sat.propagate(selEntry.rec, now)
  if (!pv || !pv.position) return null
  const ecf = sat.eciToEcf(pv.position, sat.gstime(now))
  const look = sat.ecfToLookAngles({ longitude: lon * DEG, latitude: lat * DEG, height: 0 }, ecf)
  return look.elevation / DEG
}
// 标签用仰角文本：未聚焦返回空串（地平线以下显示负值即标识不可见）
const fmtElev = (lat, lon) => { const e = satElevAt(lat, lon); return e == null ? '' : `仰角 ${e.toFixed(1)}°` }

// 聚焦卫星实时星下点；无聚焦/不可解算返回 null
function focusSubpoint() {
  if (!selEntry) return null
  const now = calcAt()
  const pv = sat.propagate(selEntry.rec, now)
  if (!pv || !pv.position) return null
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(now))
  return { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude) }
}
// 把聚焦卫星星下点推给 2D 平面图（标注其实时位置）
function pushFocusSat() { if (flat) flat.setFocusSat(focusSubpoint()) }

// 地图右键（3D 球体与 2D 平面图共用）：轨迹描绘中→直接加航点（连续右键描点）；否则→弹出右键菜单。
// ll：点击处经纬度（点在地球外为 null）；pos：屏幕坐标（菜单定位）。
const ctxMenu = ref(null)        // { x, y, ll } 右键菜单状态（null=隐藏）
const covSetOpen = ref(false)    // 「覆盖图设置」弹窗开关
function onMapRightClick(ll, pos) {
  const t = curTraj()
  if (t) { if (ll) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() } return }   // 描绘中：连续加点，不弹菜单
  ctxMenu.value = { x: pos ? pos.x : 0, y: pos ? pos.y : 0, ll: ll || null }
}
function closeCtx() { ctxMenu.value = null }
const ctxLL = () => ctxMenu.value && ctxMenu.value.ll
// —— 菜单动作（均在当前右键经纬度处执行）——
function ctxAddPoint() { const ll = ctxLL(); if (ll) addPoint(ll.lat, ll.lon); closeCtx() }
// 加地面站：弹出命名对话框（位置取右键处），确认后入库
const stPrompt = ref(null)       // { lat, lon } 待命名地面站；null=关闭
const stPromptName = ref('')
// 应用内提示弹窗（替代 Electron 原生 alert）：alertMsg/appAlert/closeAlert 见 stores/alert.js（GRD 等组合式同源）。
function ctxAddStation() { const ll = ctxLL(); if (ll) { stPrompt.value = { lat: ll.lat, lon: ll.lon }; stPromptName.value = '' } closeCtx() }
function confirmStation() {
  const p = stPrompt.value; if (!p) return
  stations.value.push({ id: newId(), lat: p.lat, lon: p.lon, name: (stPromptName.value || '').trim() || '地面站' })
  syncMarkers(); stPrompt.value = null; stPromptName.value = ''
}
function cancelStation() { stPrompt.value = null; stPromptName.value = '' }
// 新建一条轨迹并进入描绘态（之后连续右键加点，由顶部横幅「结束」收尾）
function ctxStartTraj(kind) { newTraj(kind); const ll = ctxLL(); if (ll) { const t = curTraj(); if (t) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() } } closeCtx() }
function endTraj() { activeTraj.value = '' }
// —— 清除（右键菜单平铺项）——
function clearPoints() { points.value = []; syncMarkers(); closeCtx() }
function clearStations() { stations.value = []; syncMarkers(); closeCtx() }
function clearTrajs() { trajectories.value = []; activeTraj.value = ''; syncMarkers(); closeCtx() }
function clearAllMk() { clearAllMarkers(); closeCtx() }
function clearAllCoverage() { if (covApiOk) clearCoverage(); if (grdApiOk) grd.clearDrawing(); closeCtx() }
function ctxOpenMarkers() { mkOpen.value = true; closeCtx() }
function ctxOpenGeo() { geoOpen.value = true; closeCtx() }
function ctxOpenCovSet() { covSetOpen.value = true; closeCtx() }   // 打开覆盖图显示设置弹窗（GRD 4 + GXT 3，含字号/大小条）
const markSizes = () => ({ ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value, ptDot: markPtDot.value, trajDot: trajDotSize.value })
// 标记载荷构造器：坐标/名称是否带文字由 showPtLabel/showStName 决定（空串=圆点/图标保留、文字隐藏）。
// pushMarkers 与 feedFlat 共用，避免两处各写一份导致显隐口径不一致。
// 图层隐藏（小眼睛关）时返回空数组：仅停止渲染，points/stations/trajectories 原始数据不动、照常持久化。
const markerPts = () => showPtLayer.value ? points.value.map((p) => ({ lat: p.lat, lon: p.lon, label: showPtLabel.value ? fmtLL(p.lat, p.lon) : '', el: fmtElev(p.lat, p.lon) })) : []
const markerSts = () => showStLayer.value ? stations.value.map((s) => ({ lat: s.lat, lon: s.lon, name: showStName.value ? s.name : '', el: fmtElev(s.lat, s.lon) })) : []
const markerTrs = () => showTrajLayer.value ? trajectories.value.map((t) => ({ pts: t.pts, kind: t.kind, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a })) : []
// 仅把标记推送到两个视图（含聚焦卫星仰角），不写入持久化；供时间推进/选星刷新仰角调用
function pushMarkers() {
  if (!scene) return
  const pts = markerPts(), sts = markerSts(), trs = markerTrs()
  scene.setMarkers(pts, sts, markSizes()); scene.setTrajectories(trs, markSizes())
  if (flat) { flat.setMarkers(pts, sts, trs); flat.setSizes(markSizes()) }
}
function syncMarkers() { pushMarkers(); persistMarkers() }
function persistMarkers() {
  try { localStorage.setItem(MK_KEY, JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })) } catch { /* ignore */ }
}
function loadMarkers() {
  try {
    const d = JSON.parse(localStorage.getItem(MK_KEY) || 'null')
    if (d) { points.value = d.points || []; stations.value = d.stations || []; trajectories.value = d.trajectories || [] }
  } catch { /* ignore */ }
}
function toggleMarkers() { mkOpen.value = !mkOpen.value }
function toggleGeo() { geoOpen.value = !geoOpen.value }

function addPoint(lat, lon, face) {
  if (!validLat(lat) || !validLon(lon)) return
  points.value.push({ id: newId(), lat, lon }); syncMarkers()
  if (face && scene) { scene.faceLonLat(lon, lat); autoRotate.value = false }
}
function addPointInput() { addPoint(parseFloat(ptLat.value), parseFloat(ptLon.value)); ptLat.value = ''; ptLon.value = '' }
function removePoint(id) { points.value = points.value.filter((p) => p.id !== id); syncMarkers() }

function addStation() {
  const lat = parseFloat(stLat.value), lon = parseFloat(stLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  stations.value.push({ id: newId(), lat, lon, name: (stName.value || '').trim() || '地面站' })
  stLat.value = ''; stLon.value = ''; stName.value = ''; syncMarkers()
}
function setStationName(id, v) { const s = stations.value.find((x) => x.id === id); if (s) { s.name = v; syncMarkers() } }
function removeStation(id) { stations.value = stations.value.filter((s) => s.id !== id); syncMarkers() }

function newTraj(kind) {
  const t = { id: newId(), name: (kind === 'flight' ? '飞行' : '航行') + trajectories.value.length, kind, pts: [] }
  trajectories.value.push(t); activeTraj.value = t.id
}
function curTraj() { return trajectories.value.find((t) => t.id === activeTraj.value) }
function addWaypoint() {
  const t = curTraj(); if (!t) return
  const lat = parseFloat(wpLat.value), lon = parseFloat(wpLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  t.pts.push({ lat, lon }); wpLat.value = ''; wpLon.value = ''; syncMarkers()
}
function removeWaypoint(t, i) { t.pts.splice(i, 1); syncMarkers() }
function setTrajName(id, v) { const t = trajectories.value.find((x) => x.id === id); if (t) { t.name = v; persistMarkers() } }
function removeTraj(id) { trajectories.value = trajectories.value.filter((t) => t.id !== id); if (activeTraj.value === id) activeTraj.value = ''; syncMarkers() }
function clearAllMarkers() { points.value = []; stations.value = []; trajectories.value = []; activeTraj.value = ''; syncMarkers() }

const timeLabel = () => {
  if (live.value) return '实时'
  if (!timeOffset.value) return '此刻'
  const oh = Math.floor(timeOffset.value / 60), om = timeOffset.value % 60
  const d = calcAt(), p = (n) => String(n).padStart(2, '0')
  return `+${oh}h${p(om)}m · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// ===================== 持久化（记住分组 + 选中星） =====================
function saveSelection() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ groupIndex: groupIndex.value, selNorad: selEntry ? String(selEntry.noradId) : '' })) } catch { /* ignore */ }
}
function onGroup(e) {
  groupIndex.value = Number(e.target.value); clearSearch()
  loadGroup(); saveSelection()
}

// ===================== 全部选项/设置本地缓存（无感） =====================
const SETTINGS_KEY = 'globe3d/settings'
// 批次内设置统一，但持久化时按波束各存一份（每条波束记录自带其增益档/颜色/线粗，便于波束级追溯）
function serializeCov() {
  return covItems.value.map((it) => ({
    id: it.id, folder: it.folder, type: it.type, band: it.band,
    batches: it.batches.map((ba) => ({
      id: ba.id, name: ba.name,
      beams: ba.beams.map((bid) => ({
        id: bid, gains: ba.gains.slice(), custom: ba.custom,
        mode: ba.mode, solid: ba.solid, gainColors: { ...ba.gainColors }, width: ba.width
      }))
    }))
  }))
}
// 反序列化：把按波束存的记录还原为运行时的批次统一设置（取该批首个波束记录为准）
function deserializeCov(items) {
  return (items || []).filter((it) => it && idxOf(it.folder)).map((it) => ({
    id: it.id, folder: it.folder, type: it.type || 'EIRP', band: it.band || 'all',
    batches: (it.batches || []).map((ba) => {
      const bms = ba.beams || [], f = bms[0] || {}
      return {
        id: ba.id, name: ba.name || '', q: '',
        beams: bms.map((b) => (typeof b === 'string' ? b : b.id)),
        gains: Array.isArray(f.gains) ? f.gains : [], custom: f.custom || '',
        mode: f.mode || 'gradient', solid: f.solid || '#ff5a5a',
        gainColors: f.gainColors || {}, width: Number.isFinite(f.width) ? f.width : 1.6
      }
    })
  }))
}
function snapshot() {
  return {
    nameMode: nameMode.value, countryName: countryNameSize.value, provName: provNameSize.value, cityName: cityNameSize.value, showProvinces: showProvinces.value, showCities: showCities.value, borderStyle: { ...borderStyle }, labelStyle: { ...labelStyle }, oceanColor: oceanColor.value, autoRotate: autoRotate.value, autoRotateSpeed: viewPrefs.autoRotateSpeed, live: live.value, beamLock: beamLock.value,
    mkPt: markPtFont.value, mkStIcon: stIconSize.value, mkStFont: stFontSize.value, mkPtDot: markPtDot.value, mkTrajDot: trajDotSize.value,
    mkPtShow: showPtLabel.value, mkStShow: showStName.value,
    mkPtLayer: showPtLayer.value, mkStLayer: showStLayer.value, mkTrajLayer: showTrajLayer.value,
    covOpen: covOpen.value, mkOpen: mkOpen.value, geoOpen: geoOpen.value,
    grdOpen: grdOpen.value, grd: grd.getState(), perf: perf.getState(),
    cov: {
      items: serializeCov(), cleared: covCleared.value,
      beamLabels: showBeamLabels.value, beamFont: beamLabelSize.value, bore: showBore.value, boreSize: boreSize.value,
      contourLabels: showContourLabels.value, contourSize: contourLabelSize.value
    }
  }
}
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot())) } catch { /* ignore */ } }
async function restoreSettings() {
  let s; try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') } catch { s = null }
  if (!s) return
  if (s.nameMode === 'zh' || s.nameMode === 'en' || s.nameMode === 'off') { nameMode.value = s.nameMode; scene.setLabelMode(nameMode.value) }
  if (Number.isFinite(s.countryName)) countryNameSize.value = s.countryName
  else if (Number.isFinite(s.geoName)) countryNameSize.value = s.geoName   // 兼容旧字段
  if (Number.isFinite(s.provName)) provNameSize.value = s.provName
  else if (Number.isFinite(s.geoName)) provNameSize.value = s.geoName
  if (Number.isFinite(s.cityName)) cityNameSize.value = s.cityName
  scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value)
  if (s.borderStyle && typeof s.borderStyle === 'object') Object.assign(borderStyle, s.borderStyle)
  applyBorderStyle()
  if (s.labelStyle && typeof s.labelStyle === 'object') Object.assign(labelStyle, s.labelStyle)
  applyLabelStyle()
  if (typeof s.oceanColor === 'string') setOceanColor(s.oceanColor)
  if (Number.isFinite(s.mkPt)) markPtFont.value = s.mkPt
  if (Number.isFinite(s.mkPtDot)) markPtDot.value = s.mkPtDot
  if (Number.isFinite(s.mkStIcon)) stIconSize.value = s.mkStIcon
  if (Number.isFinite(s.mkStFont)) stFontSize.value = s.mkStFont
  if (Number.isFinite(s.mkTrajDot)) trajDotSize.value = s.mkTrajDot
  if (typeof s.mkPtShow === 'boolean') showPtLabel.value = s.mkPtShow
  if (typeof s.mkStShow === 'boolean') showStName.value = s.mkStShow
  if (typeof s.mkPtLayer === 'boolean') showPtLayer.value = s.mkPtLayer
  if (typeof s.mkStLayer === 'boolean') showStLayer.value = s.mkStLayer
  if (typeof s.mkTrajLayer === 'boolean') showTrajLayer.value = s.mkTrajLayer
  syncMarkers()   // 以恢复后的尺寸重建标记（含坐标/名称显隐、各图层显隐）
  if (typeof s.autoRotate === 'boolean') { autoRotate.value = s.autoRotate; scene.setAutoRotate(autoRotate.value) }
  if (Number.isFinite(s.autoRotateSpeed)) { viewPrefs.autoRotateSpeed = s.autoRotateSpeed; scene.setAutoRotateSpeed(s.autoRotateSpeed) }
  if (typeof s.beamLock === 'boolean') beamLock.value = s.beamLock
  if (typeof s.mkOpen === 'boolean') mkOpen.value = s.mkOpen
  if (typeof s.geoOpen === 'boolean') geoOpen.value = s.geoOpen
  if (s.showProvinces) {
    showProvinces.value = true
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); provincesData = mod.default || mod; scene.setProvinces(provincesData); scene.setProvincesVisible(true); provincesLoaded = true } catch { /* ignore */ }
  }
  if (s.showCities) {
    showCities.value = true
    try { const mod = await import('../viz/globe3d/data/china-cities.json'); citiesData = mod.default || mod; scene.setCities(citiesData); scene.setCitiesVisible(true); citiesLoaded = true } catch { /* ignore */ }
    scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value)
  }
  if (s.live) { live.value = true; if (!timer) timer = setInterval(refreshPositions, 1000) }
  const c = s.cov
  if (c && Array.isArray(c.items) && c.items.length) {
    covOpen.value = !!s.covOpen
    await ensureCovIndex()
    // 仅恢复索引中仍存在的卫星；同步 id 游标避免冲突
    const items = deserializeCov(c.items)
    for (const it of items) {
      const ids = [it.id, ...(it.batches || []).map((b) => b.id)].map((x) => parseInt(String(x).replace(/\D/g, ''), 10)).filter(Number.isFinite)
      for (const n of ids) if (n > covSeq) covSeq = n
    }
    covItems.value = items
    showBeamLabels.value = c.beamLabels !== false
    if (Number.isFinite(c.beamFont)) beamLabelSize.value = c.beamFont
    showBore.value = c.bore !== false
    if (Number.isFinite(c.boreSize)) boreSize.value = c.boreSize
    showContourLabels.value = !!c.contourLabels
    if (Number.isFinite(c.contourSize)) contourLabelSize.value = c.contourSize
    // 上次「清除绘制」后退出 → 恢复卫星列表但保持空白（不复现覆盖），直到用户显式重绘
    if (c.cleared) covCleared.value = true
    else redraw()
  } else if (s.covOpen) { covOpen.value = true; await ensureCovIndex() }
  // 覆盖图（GRD）状态恢复：只要有保存的 GRD 状态就载入索引并恢复卫星树（含自定义/星座星）+
  // 天线设置 + 仰角线属性，使仰角线即便面板关闭也照常画在地图上；面板仅在上次开启时才展开。
  if (s.perf) perf.restoreState(s.perf)
  if (grdApiOk && s.grd) {
    await grd.loadIndex(false)
    await grd.restoreState(s.grd)
    if (s.grdOpen) grdOpen.value = true
    redrawSats()
  } else if (s.grdOpen && grdApiOk) {
    grdOpen.value = true
    await grd.loadIndex(false)
    redrawSats()
  }
}

// ===================== TLE 文件导入（兜底） =====================
function pickFile() { fileInput.value && fileInput.value.click() }
function onFile(e) {
  const f = e.target.files && e.target.files[0]; if (!f) return
  const reader = new FileReader()
  reader.onload = () => {
    const sats = parseOMMCsv(String(reader.result || ''))
    if (sats.length) ingest(sats, 'import', new Date().toISOString())
    else status.value = '文件解析失败：请用 CelesTrak「FORMAT=csv」的 OMM 文件'
  }
  reader.readAsText(f); e.target.value = ''
}

onMounted(async () => {
  // 顶栏「视图」按钮右侧的覆盖图入口：注册可用性与切换回调（按钮渲染在 App.vue，状态走 covNav store）
  covNav.grdAvail = grdApiOk; covNav.covAvail = covApiOk
  covNav.toggleGrd = toggleGrd; covNav.toggleCov = toggleCoverage
  covNav.exportAvail = true; covNav.exportMap = exportMap   // 顶栏「导出图」入口（高清 PNG / 矢量 PDF）
  scene = createGlobeScene(el.value, { ...displayQuality.value })
  scene.setAutoRotate(autoRotate.value)
  scene.setLabelMode(nameMode.value)
  scene.setBorderStyle({ ...borderStyle })
  scene.setLabelStyle({ ...labelStyle })
  scene.setOceanColor(oceanColor.value)
  scene.setOnAutoRotateOff(() => { autoRotate.value = false })
  scene.setOnPick((index) => {
    // 从星座点选模式：命中的星填入卫星编辑弹窗，不改变当前选中星
    if (satPick.value && satModal.value) { if (index >= 0) { const en = renderEntries[index]; if (en) pickEntryIntoModal(en) } return }
    if (index < 0) { closeCard(); return }
    const en = renderEntries[index]; if (!en) return
    selectSat(en, false)
  })
  // 鼠标实时经纬度（底部状态栏显示）+ 右键标点/加航点
  scene.setOnHover((ll) => { cursor.ll = ll })
  scene.setOnRightClick(onMapRightClick)
  scene.setOnBeamDrag(grd.beamDrag)   // 拖拽波束（GRD boresight 中心）
  // 缩放进度条（底部状态栏）：注册当前页缩放能力，球体滚轮缩放回填进度条 + 记忆
  scene.setOnZoom((t) => { if (!flatView.value) { zoom.value = t; saveView() } })
  if (savedView.globe) scene.setView(savedView.globe)   // 恢复上次球体视图（朝向+缩放）
  // 平移/旋转结束也保存视图（滚轮已由 onZoom 覆盖；拖拽无回调，故监听 pointerup）
  el.value.addEventListener('pointerup', saveView)
  zoom.avail = true; zoom.apply = applyZoom; pushZoom()
  grd.setLivePos(satLivePos)          // GRD 覆盖按星历/时间轴解算星下点+高度（关联星实时跟踪）
  // 注册到文件管理器：镜像 GRD 树 + 导出当前覆盖 + 改星后重绘 + 复用原版卫星弹窗（隐藏可视化项）
  setGrdBridge(grd, collectGxt, {
    redraw: redrawSats,
    openAddSat: () => openAddSat(true),
    openEditSat: (folder) => { const n = grdSats.value.find((s) => s.folder === folder); if (n) editSat(n, true) },
    livePos: (folder) => { const n = grdSats.value.find((s) => s.folder === folder); return n ? satLivePos(n) : null }   // 实时星下点（文件管理器树行经度用）
  })
  // 用户在文件管理器导入/删除 GXT → 重新合并 covSats，使覆盖图(GXT)面板可选用新库
  watch(() => fileBridge.libraryTick, () => { if (covLoaded) mergeUserGxt() })
  loadMarkers(); syncMarkers()
  ro = new ResizeObserver(() => { if (scene) scene.resize(); if (flat && flatView.value) flat.resize() }); ro.observe(el.value)

  // 恢复上次分组 + 选中星
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (saved && Number.isInteger(saved.groupIndex) && saved.groupIndex >= 0 && saved.groupIndex < GROUPS.length) groupIndex.value = saved.groupIndex
    if (saved && saved.selNorad) { pendingNorad = saved.selNorad; pendingNoFace = true }
  } catch { /* ignore */ }

  await restoreSettings()   // 恢复全部选项/设置（无感）
  loadGroup()
  ensureSearchPool()   // 后台构建全量搜索库（当日缓存命中则很快），与当前分组无关
  redrawSats()   // 恢复后立即绘制自定义卫星（关联卫星待 loadGroup 完成由 refreshPositions 跟踪）
  applyDisplayQuality()   // 套用当前画质档位（含低/中档的 50m 底图按需加载）
  scene.setAutoRotateSpeed(viewPrefs.autoRotateSpeed)
  if (view.flat) await applyFlat(true)   // 恢复上次退出时的 2D 平面图（watch 不触发初始值，故挂载时主动套用一次）
  watch(snapshot, saveSettings, { deep: true })   // 此后任意改动自动本地缓存
  watch(displayQuality, applyDisplayQuality, { deep: true })   // 画质档位变化 → 实时套用（msaa 除外，由重挂载处理）
  // 设置弹窗改自转开关/速度 → 套到 scene（自转开关亦由页内按钮 toggleRotate 写同一 viewPrefs）
  watch(() => [viewPrefs.autoRotate, viewPrefs.autoRotateSpeed], () => { if (scene) { scene.setAutoRotate(viewPrefs.autoRotate); scene.setAutoRotateSpeed(viewPrefs.autoRotateSpeed) } })
})
onBeforeUnmount(() => {
  // 离开 3D 页：复位顶栏覆盖图入口（按钮随之隐藏），并关掉面板镜像状态
  covNav.grdAvail = false; covNav.covAvail = false; covNav.toggleGrd = null; covNav.toggleCov = null
  covNav.exportAvail = false; covNav.exportMap = null
  covNav.grdOpen = false; covNav.covOpen = false
  zoom.avail = false; zoom.apply = null   // 复位底部状态栏缩放进度条
  if (_viewSaveTimer) { clearTimeout(_viewSaveTimer); _viewSaveTimer = null }
  if (el.value) el.value.removeEventListener('pointerup', saveView)
  if (flatCanvas.value) flatCanvas.value.removeEventListener('pointerup', saveView)

  clearGrdBridge()   // 离开 3D 页：注销文件管理器对活树/导出器的引用
  cursor.ll = null; if (timer) clearInterval(timer); if (ro) ro.disconnect(); if (flat) flat.destroy(); if (scene) { scene.clearCoverage(); scene.destroy() }
})
</script>

<template>
  <div class="g3">
    <div class="bar">
      <span class="t">星座地图 · 3D</span>
      <select :value="groupIndex" @change="onGroup">
        <option v-for="(g, i) in GROUPS" :key="g.key" :value="i">{{ g.label }}</option>
      </select>
      <div class="search">
        <input :value="keyword" placeholder="搜索卫星名 / 编号" @input="onSearch" />
        <span v-if="keyword" class="clr" @click="clearSearch">✕</span>
        <div v-if="searchResults.length" class="panel">
          <div v-for="item in searchResults" :key="item.noradId" class="item" @click="pickResult(item)">
            <div class="nm">{{ item.name }}</div>
            <div class="sub">{{ item.groupLabel }} · NORAD {{ item.noradId }}<span v-if="item.slot"> · {{ item.slot }}</span></div>
          </div>
        </div>
      </div>
      <span class="mini" :class="{ on: autoRotate }" @click="toggleRotate">{{ autoRotate ? '旋转中' : '旋转停' }}</span>
      <span class="mini" :class="{ on: live }" @click="toggleLive">{{ live ? '实时开' : '实时关' }}</span>
      <span class="mini" :class="{ on: mkOpen }" @click="toggleMarkers">标记</span>
      <span class="mini" :class="{ on: geoOpen }" @click="toggleGeo">地图设置</span>
      <span class="meta">在轨 {{ satCount }}<template v-if="shownCount && shownCount < satCount"> · 渲染 {{ shownCount }}</template>
        <template v-if="dataTime"> · OMM {{ dataTime }}</template>
        <template v-if="status"> · {{ status }}</template></span>
    </div>

    <div class="tl">
      <div class="tb-track" ref="track" :class="{ dis: live }" @mousedown="trackDown">
        <span v-for="t in timeTicks" :key="'k' + t.min" class="tb-tick" :style="{ left: t.min / 14.4 + '%' }"></span>
        <div class="tb-bar"><div class="tb-fill" :style="{ width: timePct + '%' }"></div></div>
        <div class="tb-knob" :style="{ left: timePct + '%' }"></div>
        <span v-for="t in timeTicks" :key="'m' + t.min" class="tb-mark" :style="tickStyle(t.min)">{{ t.label }}</span>
      </div>
      <span class="tlab">{{ timeLabel() }}</span>
      <span class="st" :class="{ dis: live }" @click="step(-60)">−1h</span>
      <span class="st" :class="{ dis: live }" @click="step(-10)">−10m</span>
      <span class="st" :class="{ dis: live }" @click="step(-1)">−1m</span>
      <span class="st" :class="{ dis: live || !timeOffset }" @click="resetTime">此刻</span>
      <span class="st" :class="{ dis: live }" @click="step(1)">+1m</span>
      <span class="st" :class="{ dis: live }" @click="step(10)">+10m</span>
      <span class="st" :class="{ dis: live }" @click="step(60)">+1h</span>
      <span class="beamc">
        <template v-if="selected">
          <span class="bl">波束角</span>
          <input class="bi" :value="beam" :placeholder="beamAuto || '自动'" @input="onBeam" />
          <span class="bu">°</span>
          <span class="lock" :class="{ on: beamLock }" @click="toggleBeamLock">{{ beamLock ? '🔒' : '🔓' }}</span>
        </template>
        <span v-else class="hint">点击卫星设置波束角</span>
      </span>
    </div>

    <div class="body">
      <div class="stage-wrap">
        <div ref="el" class="stage"></div>
        <canvas v-show="flatView" ref="flatCanvas" class="flat"></canvas>

        <!-- 聚焦卫星图例：说明地图上为聚焦星绘制的覆盖范围(蓝)与星下点轨迹(黄)，3D / 2D 同步显示 -->
        <div v-if="selected" class="focus-legend">
          <div class="fl-row"><span class="fl-sw cov"></span>覆盖范围</div>
          <div class="fl-row"><span class="fl-sw trk"></span>星下点轨迹</div>
        </div>

        <div v-if="!satCount && status && !exporting" class="dl-banner">
          <div class="dl-msg">{{ status }}</div>
          <div class="dl-row">
            <button @click="loadGroup">重试下载</button>
            <button @click="pickFile">导入 TLE 文件(CSV)</button>
          </div>
          <input ref="fileInput" type="file" accept=".csv,.txt" style="display:none" @change="onFile" />
        </div>

        <div v-if="selected" class="card" :class="{ collapsed: cardCollapsed }">
          <div class="ch" :title="cardCollapsed ? '展开' : '收起'" @click="cardCollapsed = !cardCollapsed">
            <span class="cc" :class="{ col: cardCollapsed }">▾</span>
            <span class="cn" :title="selected.name">{{ selected.name }}</span>
            <span class="cx" @click.stop="closeCard">✕</span>
          </div>
          <div v-show="!cardCollapsed" class="cbody">
          <div class="cmeta">
            <span class="badge">NORAD {{ selected.noradId }}</span>
            <span class="badge kind">{{ selected.kind }}</span>
            <span v-if="selected.group" class="badge">{{ selected.group }}</span>
            <span v-if="selected.slot" class="badge geo">定点 {{ selected.slot }}</span>
          </div>

          <div class="csec">实时状态</div>
          <div class="rows">
            <div class="row"><span class="k">星下点</span><span class="v">{{ selected.lat }}°, {{ selected.lon }}°</span></div>
            <div class="row"><span class="k">海拔高度</span><span class="v">{{ selected.alt }}<i>km</i></span></div>
            <div class="row"><span class="k">对地速度</span><span class="v">{{ selected.speedRel }}<i>km/s</i></span></div>
            <div class="row"><span class="k">惯性速度</span><span class="v">{{ selected.speedAbs }}<i>km/s</i></span></div>
          </div>

          <div class="csec">轨道根数（开普勒）</div>
          <div class="rows">
            <div class="row"><span class="k">轨道周期</span><span class="v">{{ selected.period }}<i>min</i></span></div>
            <div class="row"><span class="k">平均运动 <em>n</em></span><span class="v">{{ selected.meanMotion }}<i>圈/日</i></span></div>
            <div class="row"><span class="k">轨道倾角 <em>i</em></span><span class="v">{{ selected.incl }}<i>°</i></span></div>
            <div class="row"><span class="k">偏心率 <em>e</em></span><span class="v">{{ selected.ecc }}</span></div>
            <div class="row"><span class="k">近地点高度</span><span class="v">{{ selected.perigee }}<i>km</i></span></div>
            <div class="row"><span class="k">远地点高度</span><span class="v">{{ selected.apogee }}<i>km</i></span></div>
            <div class="row"><span class="k">升交点赤经 <em>Ω</em></span><span class="v">{{ selected.raan }}<i>°</i></span></div>
            <div class="row"><span class="k">近地点幅角 <em>ω</em></span><span class="v">{{ selected.argp }}<i>°</i></span></div>
            <div class="row"><span class="k">平近点角 <em>M</em></span><span class="v">{{ selected.ma }}<i>°</i></span></div>
          </div>
          </div>
        </div>
      </div>

      <div v-if="covOpen" class="cov-side">
        <div class="csh"><span class="csn">GEO 卫星覆盖（GXT）</span>
          <span class="flatbtn" :class="{ on: flatView }" @click="toggleFlat">{{ flatView ? '球体' : '平面图' }}</span>
          <button class="winx" type="button" aria-label="关闭" title="关闭" @click="toggleCoverage"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg></button></div>

        <div class="sec">
          <div class="srow"><label>添加卫星</label>
            <select :value="covAddSel" @change="e => { covAddSel = e.target.value; addCovSat() }">
              <option value="" disabled>选择卫星…</option>
              <option v-for="s in covSats" :key="s.folder" :value="s.folder"
                      :disabled="covItems.some(i => i.folder === s.folder)">{{ s.displayName }}（{{ s.lon }}°）</option>
            </select>
          </div>
          <div v-if="!covItems.length" class="tip">添加一颗或多颗卫星，各自可建多个批次（波束分组），分别设增益档与颜色。</div>
        </div>

        <!-- 每颗已添加卫星 -->
        <div v-for="it in covItems" :key="it.id" class="sec satcard">
          <div class="sath">
            <span class="satn">{{ idxOf(it.folder)?.displayName }} <em>{{ idxOf(it.folder)?.lon }}°</em></span>
            <span class="seg sm">
              <span class="sg" :class="{ on: it.type === 'EIRP' }" @click="setItemType(it, 'EIRP')">EIRP</span>
              <span class="sg" :class="{ on: it.type === 'GT' }" @click="setItemType(it, 'GT')">G/T</span>
            </span>
            <span class="ic" title="定位" @click="focusCovSat(it)">◎</span>
            <span class="ic del" title="移除该星" @click="removeCovSat(it)">✕</span>
          </div>
          <div class="srow"><label>频段</label>
            <select :value="it.band" @change="e => onItemBand(it, e)">
              <option value="all">全部频段</option>
              <option v-for="b in itemBands(it)" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>

          <!-- 批次 -->
          <div v-for="(ba, bi) in it.batches" :key="ba.id" class="batch">
            <div class="bah">
              <input class="bnm" :value="ba.name" :placeholder="'批次' + (bi + 1)" @input="e => setBatchName(it, ba, e)" />
              <span class="ic del" title="删除批次" @click="removeBatch(it, ba)">✕</span>
            </div>

            <div class="bsub">波束
              <span class="lnk" @click="allBatchBeams(it, ba, !allFilteredOn(it, ba))">{{ allFilteredOn(it, ba) ? '取消' : '全选' }}</span>
              <span class="lnk" @click="invertBatchBeams(it, ba)">反选</span>
              <span class="cnt2">已选 {{ ba.beams.length }}</span>
            </div>
            <input class="ci bq" :value="ba.q" placeholder="搜索：拉萨 / Beam 3，或序号 1-62、1,3,5" @input="e => onBatchQuery(it, ba, e)" />
            <div class="list">
              <label v-for="r in filteredBeamRows(it, ba)" :key="r.id" class="chk">
                <input type="checkbox" :checked="ba.beams.includes(r.id)" @change="toggleBatchBeam(it, ba, r.id)" />
                <span class="bseq">{{ r.seq }}</span><span>{{ r.label }}</span>
              </label>
              <div v-if="!filteredBeamRows(it, ba).length" class="empty">{{ beamRowsOf(it).length ? '无匹配波束' : '该频段/类型无波束' }}</div>
            </div>

            <template v-if="ba.beams.length">
              <!-- 增益档（批次统一） -->
              <div class="bsub">增益档
                <span class="lnk" @click="allBatchGains(it, ba, ba.gains.length !== batchGains(it, ba).length)">{{ ba.gains.length === batchGains(it, ba).length && batchGains(it, ba).length ? '取消' : '全选' }}</span>
              </div>
              <div class="chips">
                <span v-for="g in batchGains(it, ba)" :key="g" class="chip" :class="{ on: ba.gains.includes(g) }"
                      :style="ba.gains.includes(g) ? { borderColor: gainSwatchCss(ba, g), color: gainSwatchCss(ba, g) } : {}"
                      @click="toggleBatchGain(it, ba, g)">
                  <span v-if="ba.mode === 'perGain' && ba.gains.includes(g)" class="dot" :style="{ background: gainSwatchCss(ba, g) }"></span>{{ g }}
                </span>
              </div>
              <div class="srow"><label>自定义</label><input class="ci" :value="ba.custom" placeholder="如 48,52" @input="e => onBatchCustom(it, ba, e)" /></div>

              <!-- 配色（批次统一） -->
              <div class="bsub">配色
                <span class="seg sm">
                  <span class="sg" :class="{ on: ba.mode === 'gradient' }" @click="setBatchMode(it, ba, 'gradient')">渐变</span>
                  <span class="sg" :class="{ on: ba.mode === 'solid' }" @click="setBatchMode(it, ba, 'solid')">纯色</span>
                  <span class="sg" :class="{ on: ba.mode === 'perGain' }" @click="setBatchMode(it, ba, 'perGain')">逐档</span>
                </span>
                <input v-if="ba.mode === 'solid'" class="clr" type="color" :value="ba.solid" @input="e => onBatchSolid(it, ba, e)" />
              </div>
              <div v-if="ba.mode === 'perGain' && ba.gains.length" class="pglist">
                <label v-for="g in ba.gains" :key="g" class="pgrow">
                  <input class="clr" type="color" :value="ba.gainColors[g] || gainSwatchCss(ba, g)" @input="e => onGainColor(it, ba, g, e)" />
                  <span>{{ g }}</span>
                </label>
              </div>

              <!-- 线粗细（批次统一） -->
              <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.6" max="5" step="0.2" :value="ba.width" @input="e => onBatchWidth(it, ba, e)" /><span class="u">{{ ba.width }}</span></div>
            </template>
          </div>
          <div class="addbatch" @click="addBatch(it)">＋ 新建批次</div>
        </div>

        <div class="sec">
          <div class="sect"><span>显示选项</span></div>
          <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
          <div v-if="showBeamLabels" class="srow"><label>字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="beamLabelSize" @input="setBeamFont" /><span class="u">{{ beamLabelSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
          <div v-if="showBore" class="srow"><label>大小</label><input class="rng" type="range" min="1" max="12" step="1" :value="boreSize" @input="setBoreSize" /><span class="u">{{ boreSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
          <div v-if="showContourLabels" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="20" step="1" :value="contourLabelSize" @input="setContourSize" /><span class="u">{{ contourLabelSize }}</span></div>
        </div>

        <div v-if="covLegend.length" class="legend">
          <div class="lrow" v-for="(L, li) in covLegend" :key="li">
            <span class="lname">{{ L.name }}<em>{{ L.type === 'GT' ? ' G/T' : ' EIRP' }}</em></span>
            <span v-if="L.mode === 'solid'" class="lsw" :style="{ background: L.solid }"></span>
            <template v-else><span class="lbar2"></span><span class="lsc2">{{ L.gmin }}~{{ L.gmax }}</span></template>
          </div>
        </div>

        <div class="csfoot">
          <span v-if="covStatus" class="cst">{{ covStatus }}</span>
          <span class="cclr" @click="clearCoverage">清除绘制</span>
        </div>
      </div>

      <div v-if="grdOpen" class="cov-side grd-side">
        <div class="csh"><span class="csn">覆盖分析</span>
          <span class="flatbtn" :class="{ on: flatView }" @click="toggleFlat">{{ flatView ? '球体' : '平面图' }}</span>
          <button class="winx" type="button" aria-label="关闭" title="关闭" @click="toggleGrd"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg></button></div>

        <div class="sec">
          <div class="sect"><span>卫星 / 天线</span><span class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click="openAddSat">＋ 卫星</span></div>
          <div class="gtree">
            <template v-for="sat in grdSats" :key="sat.folder">
              <div class="gsat" :class="{ exp: grd.isExpanded(sat.folder) }">
                <i class="tri" :class="{ open: grd.isExpanded(sat.folder) }" @click="grd.toggleExpand(sat.folder)">▸</i>
                <input type="checkbox" class="gck" :checked="grd.satState(sat) === 'all'" :indeterminate="grd.satState(sat) === 'some'" :disabled="!sat.antennas.length" :title="sat.antennas.length ? '全选 / 全不选该星天线' : '该星暂无天线'" @change="grd.toggleSatAll(sat)" />
                <svg class="gsvg sat-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M13 7 9 3 5 7l4 4" /><path d="m17 11 4 4-4 4-4-4" /><path d="m8 12 4 4 6-6-4-4Z" /><path d="m16 8 3-3" /><path d="M9 21a6 6 0 0 0-6-6" />
                </svg>
                <span class="gsname" @click="grd.toggleExpand(sat.folder)" :title="sat.satName">{{ sat.satName }}<em v-if="sat.antennas.length">{{ sat.antennas.length }}</em><i v-if="sat.elements" class="simtag" title="轨道根数模拟星：星下点随时间移动">轨</i></span>
                <span class="sacts">
                  <span class="ic" title="导入 GRD：在该星下新建天线" @click.stop="grd.importGrd(sat)">＋</span>
                  <span class="ic" title="编辑卫星 / 仰角线 / 颜色" @click.stop="editSat(sat)">✎</span>
                  <span class="ic del" title="删除卫星（含其天线）" @click.stop="removeSat(sat)">✕</span>
                </span>
              </div>
              <!-- 卫星名 / 仰角线 开关（卫星属性）：卫星名下方独立一行，收起时仍显示；仰角值/颜色在「✎」里编辑 -->
              <div class="elacts">
                <span class="dotc" :style="{ background: sat.elevColor }" title="该星颜色（仰角线 / 卫星名），在「✎」里改"></span>
                <span class="elbtn" :class="{ on: sat.labelShow !== false }" title="在地图上显示/隐藏该卫星（3D 名称、平面图标 + 名称）" @click.stop="toggleSatLabel(sat)">{{ sat.labelShow !== false ? '✓ ' : '' }}卫星名</span>
                <span class="elbtn" :class="{ on: sat.elevShow }" title="显示/隐藏等仰角线（需先在「✎」里填仰角值，如 5,10）" @click.stop="toggleSatElev(sat)">{{ sat.elevShow ? '✓ ' : '' }}仰角线</span>
              </div>
              <div v-if="grd.isExpanded(sat.folder)" class="gbody">
                <div v-if="!sat.antennas.length" class="gant noant">暂无天线 — 点上方「＋」导入 GRD</div>
                <template v-for="a in sat.antennas" :key="a.name">
                <div class="gant" :class="{ on: grd.isSelected(sat.folder, a.name), foc: grd.isActive(sat.folder, a.name) }" @click="grd.setActive(sat, a)">
                  <input type="checkbox" class="gck" :checked="grd.isSelected(sat.folder, a.name)" @click.stop @change="grd.toggleAnt(sat, a)" />
                  <svg class="gsvg ant-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" />
                  </svg>
                  <template v-if="grdEditAnt === grd.keyOf(sat.folder, a.name)">
                    <input class="aname-in" v-model="grdEditVal" @click.stop @keydown.enter="commitRenameAnt(sat, a)" @blur="commitRenameAnt(sat, a)" />
                    <span class="ic ok" title="确认重命名" @mousedown.prevent @click.stop="commitRenameAnt(sat, a)">✓</span>
                  </template>
                  <template v-else>
                    <span class="aname" title="双击重命名" @dblclick.stop="startRenameAnt(sat, a)">{{ a.name }}</span>
                    <span v-if="grd.isActive(sat.folder, a.name)" class="afoc">编辑中</span>
                    <span class="sacts">
                      <span class="ic" title="重命名天线" @click.stop="startRenameAnt(sat, a)">✎</span>
                      <span class="ic del" title="删除天线" @click.stop="grd.removeAntenna(sat.folder, a.name)">✕</span>
                    </span>
                  </template>
                </div>
                <div class="gperf" :class="{ on: perfKey === grd.keyOf(sat.folder, a.name) }" title="打开该天线的性能指标表" @click.stop="openPerf(sat, a)">
                  <svg class="gsvg perf-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" />
                  </svg>
                  <span class="gperfn">性能指标表</span>
                </div>
                </template>
              </div>
            </template>
          </div>
        </div>

        <template v-if="grd.antMeta()">
          <div class="sec">
            <div class="sect setsect">
              <svg class="gsvg ant-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" />
              </svg>
              <span class="setlbl">天线设置</span><span class="setname" :title="grd.activeName()">{{ grd.activeName() }}</span>
              <span v-if="grd.selected.value.length > 1" class="editing" title="多选时设置只作用于聚焦（编辑中）天线，各天线独立保存">仅编辑聚焦天线</span>
            </div>
            <template v-if="grd.activeBeams().length > 1">
              <div class="sect" style="margin-top:2px"><span>Beams To Plot · {{ grd.activeBeams().length }} 波束</span></div>
              <input class="ci bq" :value="grd.beamQuery.value" placeholder="搜索：波束名，或序号 1-62、1,3,5、1-10,20-30" @input="e => grd.setBeamQuery(e.target.value)" />
              <div class="bplist">
                <label class="brow ball">
                  <input type="checkbox" :checked="grd.filteredAllOn()" :indeterminate="grd.filteredAnyOn() && !grd.filteredAllOn()" @change="grd.selectFiltered(!grd.filteredAllOn())" />
                  <span class="balln">{{ grd.beamQuery.value.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
                  <span class="bpk">{{ grdS.beamsToPlot.length }}/{{ grd.activeBeams().length }}</span>
                </label>
                <label v-for="b in grd.filteredBeams()" :key="b.i" class="brow" :class="{ on: grd.isBeamOn(b.i) }">
                  <input type="checkbox" :checked="grd.isBeamOn(b.i)" @change="grd.toggleBeam(b.i)" />
                  <span class="bseq">{{ b.i + 1 }}</span>
                  <input class="bnm-in" :value="b.label" title="编辑波束名（地图标注同步用此名）" @click.stop @keydown.enter="e => e.target.blur()" @change="e => grd.renameBeam(b.i, e.target.value)" />
                  <span class="bpk">{{ b.peakDb.toFixed(1) }}</span>
                </label>
                <div v-if="!grd.filteredBeams().length" class="empty">无匹配波束</div>
              </div>
            </template>
            <div class="srow"><label>极化</label><select v-model="grdS.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
            <div class="srow"><label>类型</label>
              <span class="seg sm"><span class="sg" :class="{ on: grdS.ctype === 'rel' }" @click="grdS.ctype = 'rel'">相对峰值</span><span class="sg" :class="{ on: grdS.ctype === 'abs' }" @click="grdS.ctype = 'abs'">绝对</span></span>
            </div>
            <div class="srow"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.number="grdS.gainOffset" /><span class="u">dB</span></div>
            <div class="srow"><label>路径损耗</label><select v-model="grdS.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>

            <div class="sect" style="margin-top:9px"><span>电平</span><span class="lvhdr">填充 · 线 · 值 · 绝对</span></div>
            <div class="glv">
              <div v-for="(L, i) in grdS.levels" :key="i" class="glvrow">
                <input class="lvclr" type="color" title="填充色" :value="grdLvHex(L.color)" @input="e => setLevelColor(i, e)" />
                <input class="lvclr" type="color" title="线色" :value="grdLvHex(L.lineColor)" @input="e => setLineColor(i, e)" />
                <input class="lvval" type="number" step="0.5" v-model.number.lazy="L.v" />
                <span class="lvabs">{{ (grdS.ctype === 'rel' ? (grd.antMeta().peakDb + L.v) : L.v).toFixed(1) }}</span>
                <span class="ic del" title="删除该档" @click="grd.removeLevel(i)">✕</span>
              </div>
              <div class="glvadd" @click="grd.addLevel()">＋ 添加电平</div>
            </div>
            <div class="srow"><label>线宽</label><input class="rng" type="range" min="0.5" max="4" step="0.1" v-model.number="grdS.lineWidth" /><span class="u">{{ grdS.lineWidth.toFixed(1) }}</span></div>
          </div>

          <div class="sec">
            <label class="chk2"><input type="checkbox" v-model="grdS.fill" /><span>Fill Contours（分带填充）</span></label>
            <label class="chk2"><input type="checkbox" v-model="grdS.line" /><span>显示等值线</span></label>
            <div class="srow"><label>透明度</label><input class="rng" type="range" min="0" max="1" step="0.02" v-model.number="grdS.alpha" /><span class="u">{{ grdS.alpha.toFixed(2) }}</span></div>
            <div class="tip">多个天线/卫星各自开启「Fill」即可叠加填充；交叠区按透明度混合，编辑中天线置于最上。仰角线在上方卫星树展开各星设置。</div>
          </div>

          <div class="sec">
            <div class="sect"><span>天线 boresight</span>
              <span class="lnk" :class="{ on: grd.dragBore.value }" title="开启后在地图上拖动可平移波束中心" @click="grd.setDragBore(!grd.dragBore.value)">{{ grd.dragBore.value ? '✓ 拖拽波束' : '拖拽波束' }}</span>
            </div>
            <div class="srow"><label>类型</label>
              <select v-model="grdS.boreType">
                <option value="geo">经纬度 (Lon/Lat, Rot)</option>
                <option value="azel">方位/俯仰 (Az/El, Rot)</option>
              </select>
            </div>
            <template v-if="grdS.boreType === 'geo'">
              <div class="srow"><label>经度</label><input class="ci" type="number" step="0.5" v-model.number="grdS.boreLon" /><span class="u">°E</span></div>
              <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.5" v-model.number="grdS.boreLat" /><span class="u">°N</span></div>
            </template>
            <template v-else>
              <div class="srow"><label>方位 Az</label><input class="ci" type="number" step="0.5" v-model.number="grdS.boreAz" /><span class="u">°</span></div>
              <div class="srow"><label>俯仰 El</label><input class="ci" type="number" step="0.5" v-model.number="grdS.boreEl" /><span class="u">°</span></div>
            </template>
            <div class="srow"><label>旋转 Rot</label><input class="ci" type="number" step="1" v-model.number="grdS.yaw" /><span class="u">°</span></div>
            <div class="tip"><template v-if="grd.boreGround()">指向 {{ grd.boreGround().lon.toFixed(2) }}°E, {{ grd.boreGround().lat.toFixed(2) }}°N</template><template v-else>指向深空（越过地平）</template>（默认星下点 {{ grd.antMeta().satLon }}°）· 峰值 {{ grd.antMeta().peakDb }}dB @ {{ grd.antMeta().peak[0] }},{{ grd.antMeta().peak[1] }}</div>
          </div>

          <div class="sec">
            <div class="sect"><span>显示选项</span><span class="editing" title="对所有选中天线生效">全局</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showName" /><span>显示天线名</span></label>
            <div v-if="grdS.showName" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="32" step="0.5" v-model.number="grdS.nameSize" /><span class="u">{{ grdS.nameSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showBore" /><span>显示波束中心</span></label>
            <div v-if="grdS.showBore" class="srow"><label>大小</label><input class="rng" type="range" min="0.5" max="12" step="0.5" v-model.number="grdS.boreSize" /><span class="u">{{ grdS.boreSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showPeak" /><span>显示波束中心峰值</span></label>
            <div v-if="grdS.showPeak" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="30" step="0.5" v-model.number="grdS.peakSize" /><span class="u">{{ grdS.peakSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showVal" /><span>显示数值标签</span></label>
            <div v-if="grdS.showVal" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="30" step="0.5" v-model.number="grdS.valSize" /><span class="u">{{ grdS.valSize }}</span></div>
            <div class="tip">数值标签按各天线「电平」档显示（相对峰值模式标档值，绝对模式标绝对 dB），需开启「显示等值线」。</div>
          </div>
        </template>

        <div class="csfoot">
          <span v-if="grdLoading" class="cst">载入中…</span>
          <span class="cclr" title="清空地图上的填充/等值线/仰角线，保留各天线设置与卫星列表" @click="grdClearDrawing">清除绘图</span>
        </div>
      </div>

      <div v-if="geoOpen" class="cov-side geo-side">
        <div class="csh"><span class="csn">地图设置</span><button class="winx" type="button" aria-label="关闭" title="关闭" @click="toggleGeo"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg></button></div>
        <div class="sec">
          <div class="sect"><span>大海颜色</span></div>
          <div class="swatches">
            <span v-for="c in OCEAN_BLUES" :key="c" class="sw" :class="{ on: oceanColor === c }" :style="{ background: c }" :title="c" @click="setOceanColor(c)"></span>
          </div>
          <div class="tip">海洋底色限蓝色系，同时作用于 3D 球体与平面图。</div>
        </div>
        <div class="sec">
          <div class="sect"><span>国家（国界）</span></div>
          <div class="srow"><label>国家名</label>
            <span class="seg">
              <span class="sg" :class="{ on: nameMode === 'zh' }" @click="setNameMode('zh')">中文</span>
              <span class="sg" :class="{ on: nameMode === 'en' }" @click="setNameMode('en')">英文</span>
              <span class="sg" :class="{ on: nameMode === 'off' }" @click="setNameMode('off')">不显示</span>
            </span>
          </div>
          <div class="srow"><label>名字号</label><input class="rng" type="range" min="0.3" max="3" step="0.05" :value="countryNameSize" @input="setCountryNameSize" /><span class="u">{{ countryNameSize.toFixed(2) }}</span></div>
          <div class="srow"><label>名颜色</label><input class="clr" type="color" v-model="labelStyle.countryColor" @input="applyLabelStyle" /><span class="u">{{ labelStyle.countryColor }}</span></div>
          <div class="srow"><label>名透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle.countryOpacity" @input="applyLabelStyle" /><span class="u">{{ labelStyle.countryOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>国界线颜色</label><input class="clr" type="color" v-model="borderStyle.natColor" @input="applyBorderStyle" /><span class="u">{{ borderStyle.natColor }}</span></div>
          <div class="srow"><label>国界线粗</label><input class="rng" type="range" min="0.1" max="4" step="0.1" v-model.number="borderStyle.natWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.natWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>国界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.natOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.natOpacity.toFixed(2) }}</span></div>
          <div class="tip">国家名含海岸线/国境线；大洋名维持固有蓝，不随国家名色改。同时作用于 3D 与平面图。</div>
        </div>

        <div class="sec">
          <div class="sect"><span>中国省（中国省界）</span></div>
          <label class="chk2"><input type="checkbox" :checked="showProvinces" @change="toggleProvinces" /><span>显示中国省界 / 省名</span></label>
          <div class="srow"><label>名字号</label><input class="rng" type="range" min="0.3" max="2" step="0.05" :value="provNameSize" @input="setProvNameSize" /><span class="u">{{ provNameSize.toFixed(2) }}</span></div>
          <div class="srow"><label>名颜色</label><input class="clr" type="color" v-model="labelStyle.provColor" @input="applyLabelStyle" /><span class="u">{{ labelStyle.provColor }}</span></div>
          <div class="srow"><label>名透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle.provOpacity" @input="applyLabelStyle" /><span class="u">{{ labelStyle.provOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>省界线颜色</label><input class="clr" type="color" v-model="borderStyle.provColor" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provColor }}</span></div>
          <div class="srow"><label>省界线粗</label><input class="rng" type="range" min="0.1" max="4" step="0.1" v-model.number="borderStyle.provWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>省界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.provOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provOpacity.toFixed(2) }}</span></div>
          <div class="tip">需勾选「显示中国省界」后可见；线宽为屏幕像素，缩放时恒定。</div>
        </div>

        <div class="sec">
          <div class="sect"><span>中国地级市（中国地级市界）</span></div>
          <label class="chk2"><input type="checkbox" :checked="showCities" @change="toggleCities" /><span>显示中国地级市界 / 地级市名</span></label>
          <div class="srow"><label>名字号</label><input class="rng" type="range" min="0.05" max="1.5" step="0.05" :value="cityNameSize" @input="setCityNameSize" /><span class="u">{{ cityNameSize.toFixed(2) }}</span></div>
          <div class="srow"><label>名颜色</label><input class="clr" type="color" v-model="labelStyle.cityColor" @input="applyLabelStyle" /><span class="u">{{ labelStyle.cityColor }}</span></div>
          <div class="srow"><label>名透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle.cityOpacity" @input="applyLabelStyle" /><span class="u">{{ labelStyle.cityOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>市界线颜色</label><input class="clr" type="color" v-model="borderStyle.cityColor" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityColor }}</span></div>
          <div class="srow"><label>市界线粗</label><input class="rng" type="range" min="0.05" max="2" step="0.05" v-model.number="borderStyle.cityWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityWidth.toFixed(2) }}</span></div>
          <div class="srow"><label>市界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.cityOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityOpacity.toFixed(2) }}</span></div>
          <div class="tip">需勾选「显示中国地级市界」后可见；画在省界之下，线粗可低至 0.05 以适配密集网格与小空间。</div>
        </div>
      </div>

      <div v-if="mkOpen" class="cov-side mk-side">
        <div class="csh"><span class="csn">标记</span><button class="winx" type="button" aria-label="关闭" title="关闭" @click="toggleMarkers"><svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1 1 L11 11 M11 1 L1 11" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg></button></div>

        <div class="sec">
          <div class="sect"><span>点标记</span><span class="eyebtn" :class="{ off: !showPtLayer }" :title="showPtLayer ? '隐藏点标记（数据保留）' : '显示点标记'" @click="togglePtLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showPtLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <div class="tip">右键地图也可直接标点</div>
          <label class="chk2"><input type="checkbox" :checked="showPtLabel" @change="togglePtLabel" /><span>显示坐标</span></label>
          <div v-if="showPtLabel" class="srow"><label>坐标字号</label><input class="rng" type="range" min="1" max="32" step="1" :value="markPtFont" @input="setPtFont" /><span class="u">{{ markPtFont }}</span></div>
          <div class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="12" step="0.5" :value="markPtDot" @input="setPtDot" /><span class="u">{{ markPtDot }}</span></div>
          <div class="mlist">
            <div v-for="p in points" :key="p.id" class="mrow"><span class="mc">{{ fmtLL(p.lat, p.lon) }}</span><span class="del" @click="removePoint(p.id)">✕</span></div>
          </div>
        </div>

        <div class="sec">
          <div class="sect"><span>地面站</span><span class="eyebtn" :class="{ off: !showStLayer }" :title="showStLayer ? '隐藏地面站（数据保留）' : '显示地面站'" @click="toggleStLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showStLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span></div>
          <div class="srow"><label>纬度</label><input class="ci" v-model="stLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="stLon" placeholder="-180 ~ 180" /></div>
          <div class="srow"><label>名称</label><input class="ci" v-model="stName" placeholder="如 北京站" /><span class="addb" @click="addStation">添加</span></div>
          <div class="srow"><label>图标大小</label><input class="rng" type="range" min="5" max="60" step="1" :value="stIconSize" @input="setStIcon" /><span class="u">{{ stIconSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showStName" @change="toggleStName" /><span>显示名称</span></label>
          <div v-if="showStName" class="srow"><label>名称字号</label><input class="rng" type="range" min="1" max="32" step="1" :value="stFontSize" @input="setStFont" /><span class="u">{{ stFontSize }}</span></div>
          <div class="mlist">
            <div v-for="s in stations" :key="s.id" class="mrow">
              <input class="sni" :value="s.name" @input="e => setStationName(s.id, e.target.value)" />
              <span class="mc2">{{ fmtLL(s.lat, s.lon) }}</span><span class="del" @click="removeStation(s.id)">✕</span>
            </div>
          </div>
        </div>

        <div class="sec">
          <div class="sect"><span>轨迹</span><span class="eyebtn" :class="{ off: !showTrajLayer }" :title="showTrajLayer ? '隐藏航迹（数据保留）' : '显示航迹'" @click="toggleTrajLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showTrajLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>
            <span class="lnk" @click="newTraj('sea')">+航行</span>
            <span class="lnk" @click="newTraj('flight')">+飞行</span>
          </div>
          <div class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="10" step="0.5" :value="trajDotSize" @input="setTrajDot" /><span class="u">{{ trajDotSize }}</span></div>
          <div v-for="t in trajectories" :key="t.id" class="tcard" :class="{ act: activeTraj === t.id }">
            <div class="trow">
              <span class="tk" :class="t.kind"></span>
              <input class="tni" :value="t.name" @input="e => setTrajName(t.id, e.target.value)" />
              <span class="tsel" :class="{ on: activeTraj === t.id }" @click="activeTraj = t.id">{{ activeTraj === t.id ? '编辑中' : '编辑' }}</span>
              <span class="del" @click="removeTraj(t.id)">✕</span>
            </div>
            <div class="twp">
              <span v-for="(p, i) in t.pts" :key="i" class="wp">{{ p.lat.toFixed(1) }},{{ p.lon.toFixed(1) }}<span class="wdel" @click="removeWaypoint(t, i)">×</span></span>
              <span v-if="!t.pts.length" class="empty">无航点</span>
            </div>
          </div>
          <div v-if="activeTraj" class="srow">
            <label>航点</label>
            <input class="ci nrw" v-model="wpLat" placeholder="纬" />
            <input class="ci nrw" v-model="wpLon" placeholder="经" />
            <span class="addb" @click="addWaypoint">加点</span>
          </div>
          <div v-if="!trajectories.length" class="tip">+航行 / +飞行 新建轨迹，再加航点</div>
        </div>

        <div class="csfoot"><span class="cclr" @click="clearAllMarkers">清空全部</span></div>
      </div>
    </div>

    <!-- 卫星编辑弹窗（单独对话框）；点选模式下折叠为顶部横幅，便于点击地图上的卫星 -->
    <!-- hideViz（从文件管理器调起）：浮到文件管理器之上与之共存（提升 z-index 并改 fixed 定位） -->
    <div v-if="satModal && !satPick" class="sat-mask" :class="{ 'sat-overlay': satModal.hideViz }">
      <div class="sat-dlg">
        <div class="sdh"><span>{{ satModal.folder ? '编辑卫星' : '添加卫星' }}</span><span class="csx" @click="closeSatModal">✕</span></div>
        <div class="sdbody">
          <div class="sdiv">卫星（图标 / 卫星名）</div>
          <div class="srow"><label>名称</label><input class="ci" v-model="satModal.name" placeholder="卫星名称" /></div>
          <div v-if="!satModal.noradId" class="srow"><label>定位方式</label>
            <span class="pmode" :class="{ on: satModal.posMode !== 'orbit' }" @click="satModal.posMode = 'fixed'">固定经纬度</span>
            <span class="pmode" :class="{ on: satModal.posMode === 'orbit' }" @click="satModal.posMode = 'orbit'">轨道根数</span>
          </div>
          <template v-if="satModal.posMode !== 'orbit' || satModal.noradId">
            <div class="srow"><label>经度</label><input class="ci" type="number" step="0.1" :value="satModalPos.lon" @input="satModal.lon = Number($event.target.value)" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手填' : ''" /><span class="u">°E</span></div>
            <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.1" :value="satModalPos.lat" @input="satModal.lat = Number($event.target.value)" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手填' : ''" /><span class="u">°N</span></div>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="100" :value="satModalPos.altKm" @input="satModal.altKm = Number($event.target.value)" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手填' : ''" /><span class="u">km</span><span v-if="!satModal.noradId" class="geobtn" title="设为标准 GEO 轨道高度 35786km（NASA 标称值）" @click="applyGeoAlt">一键GEO</span></div>
          </template>
          <template v-else>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="50" v-model.number="satModal.elements.altKm" /><span class="u">km</span></div>
            <div class="srow"><label>偏心率</label><input class="ci" type="number" step="0.001" min="0" max="0.999" v-model.number="satModal.elements.ecc" /></div>
            <div class="srow"><label>倾角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.incl" /><span class="u">°</span></div>
            <div class="srow"><label>升交点赤经</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.raan" /><span class="u">°</span></div>
            <div class="srow"><label>近地点幅角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.argp" /><span class="u">°</span></div>
            <div class="srow"><label>平近点角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.ma" /><span class="u">°</span></div>
            <div class="tip2">轨道根数模拟星：星下点 / 覆盖足迹随时间轴 / 实时模式移动（历元取保存时刻）。偏心率&gt;0 时轨道高度按近地点高度计。</div>
          </template>
          <template v-if="!satModal.hideViz">
            <div class="srow"><label>图标大小</label><input class="rng" type="range" min="1" max="64" step="1" v-model.number="satModal.iconSize" /><span class="u">{{ satModal.iconSize }}</span></div>
            <div class="srow"><label>卫星名字号</label><input class="rng" type="range" min="1" max="30" step="1" v-model.number="satModal.labelSize" /><span class="u">{{ satModal.labelSize }}</span></div>

            <div class="sdiv">仰角线（等仰角环 / 角度标注）</div>
            <div class="srow"><label>仰角值</label><input class="ci" v-model="satModal.els" placeholder="如 5,10,20（0=地平）" /><span class="u">°</span></div>
            <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.5" max="4" step="0.1" v-model.number="satModal.elevWidth" /><span class="u">{{ (satModal.elevWidth || 1.3).toFixed(1) }}</span></div>
            <div class="srow"><label>标注字号</label><input class="rng" type="range" min="1" max="35" step="1" v-model.number="satModal.elevLabelSize" /><span class="u">{{ satModal.elevLabelSize || 18 }}</span></div>

            <div class="sdiv">颜色（仰角线与卫星名共用）</div>
            <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="satModal.color" /></div>
          </template>
          <div v-if="satModal.kind === 'preset'" class="tip2">预置卫星，可改名称 / 位置 / 仰角线；导入的天线沿用其原星下点投影。</div>

          <div class="sdiv">从星座选取（可选）</div>
          <div class="srow"><span class="pickbtn" @click="toggleSatPick">在地图上点选卫星</span></div>
          <div class="srow"><input class="ci" :value="satSearchKw" placeholder="或搜索卫星名 / 编号" @input="onSatSearch" /></div>
          <div v-if="satSearchRes.length" class="sres">
            <div v-for="r in satSearchRes" :key="r.noradId" class="sresi" @click="pickSatSearch(r)">
              <span class="srn">{{ r.name }}</span><em>{{ r.groupLabel }} · {{ r.noradId }}</em>
            </div>
          </div>
          <div v-if="satModal.noradId" class="tip2">已关联星座卫星 NORAD {{ satModal.noradId }}（仰角线随时间轴 / 实时跟踪）<span class="lnk" @click="satModal.noradId = null">取消关联</span></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="closeSatModal">取消</span><span class="save" @click="saveSatModal">保存</span></div>
      </div>
    </div>
    <div v-if="satModal && satPick" class="sat-banner">
      点选模式：点击地图上的卫星填入位置{{ flatView ? '（平面图无星点，请切回球体或用搜索）' : '' }}
      <span class="lnk" @click="satPick = false">完成 / 取消</span>
    </div>

    <!-- 添加地面站命名对话框（右键菜单触发，位置取右键处） -->
    <div v-if="stPrompt" class="sat-mask">
      <div class="sat-dlg st-dlg">
        <div class="sdh"><span>添加地面站</span><span class="csx" @click="cancelStation">✕</span></div>
        <div class="sdbody">
          <div class="srow"><label>名称</label><input class="ci" v-model="stPromptName" placeholder="如 北京站" autofocus @keyup.enter="confirmStation" /></div>
          <div class="srow"><label>位置</label><span class="u">{{ fmtLL(stPrompt.lat, stPrompt.lon) }}</span></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="cancelStation">取消</span><span class="save" @click="confirmStation">添加</span></div>
      </div>
    </div>

    <!-- 应用内提示弹窗（替代 Electron 原生 alert，避免关闭后输入框无法聚焦） -->
    <div v-if="alertMsg" class="sat-mask sat-overlay" @click.self="closeAlert">
      <div class="sat-dlg al-dlg">
        <div class="sdh"><span>提示</span><span class="csx" @click="closeAlert">✕</span></div>
        <div class="sdbody"><p class="al-msg">{{ alertMsg }}</p></div>
        <div class="sdfoot"><span class="save" @click="closeAlert">确定</span></div>
      </div>
    </div>

    <!-- 轨迹描绘横幅：有正在编辑的轨迹时显示，提示右键连续加点，「结束」收尾 -->
    <div v-if="activeTraj" class="traj-banner">
      正在描绘{{ curTraj() && curTraj().kind === 'flight' ? '飞行' : '航行' }}轨迹 · 右键地图连续加点
      <span class="lnk" @click="endTraj">结束</span>
    </div>

    <!-- 地图右键上下文菜单（3D / 平面图共用）；点击空白处或再次右键关闭 -->
    <template v-if="ctxMenu">
      <div class="ctx-mask" @click="closeCtx" @contextmenu.prevent="closeCtx"></div>
      <div class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddPoint">添加点标记（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddStation">添加地面站（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('sea')">添加航行轨迹</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('flight')">添加飞行轨迹</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" @click="clearPoints">清除点标记</div>
        <div class="ctx-item" @click="clearStations">清除地面站</div>
        <div class="ctx-item" @click="clearTrajs">清除航迹</div>
        <div class="ctx-item" @click="clearAllMk">清除所有标记</div>
        <div v-if="grdApiOk || covApiOk" class="ctx-item" @click="clearAllCoverage">清除所有覆盖图</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" @click="ctxOpenMarkers">标记设置</div>
        <div class="ctx-item" @click="ctxOpenGeo">地图设置</div>
        <div v-if="grdApiOk || covApiOk" class="ctx-item" @click="ctxOpenCovSet">覆盖图设置…</div>
      </div>
    </template>

    <!-- 覆盖图显示设置弹窗（GRD 4 项 + GXT 3 项，含字号/大小调节条） -->
    <div v-if="covSetOpen" class="sat-mask">
      <div class="sat-dlg">
        <div class="sdh"><span>覆盖图显示设置</span><span class="csx" @click="covSetOpen = false">✕</span></div>
        <div class="sdbody">
          <template v-if="grdApiOk">
            <div class="sect"><span>覆盖分析</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showName" /><span>显示天线名</span></label>
            <div v-if="grdS.showName" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="32" step="0.5" v-model.number="grdS.nameSize" /><span class="u">{{ grdS.nameSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showBore" /><span>显示波束中心</span></label>
            <div v-if="grdS.showBore" class="srow"><label>大小</label><input class="rng" type="range" min="0.5" max="12" step="0.5" v-model.number="grdS.boreSize" /><span class="u">{{ grdS.boreSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showPeak" /><span>显示波束中心峰值</span></label>
            <div v-if="grdS.showPeak" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="30" step="0.5" v-model.number="grdS.peakSize" /><span class="u">{{ grdS.peakSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="grdS.showVal" /><span>显示数值标签</span></label>
            <div v-if="grdS.showVal" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="30" step="0.5" v-model.number="grdS.valSize" /><span class="u">{{ grdS.valSize }}</span></div>
          </template>
          <template v-if="covApiOk">
            <div class="sect"><span>覆盖图（GXT）</span></div>
            <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
            <div v-if="showBeamLabels" class="srow"><label>字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="beamLabelSize" @input="setBeamFont" /><span class="u">{{ beamLabelSize }}</span></div>
            <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
            <div v-if="showBore" class="srow"><label>大小</label><input class="rng" type="range" min="1" max="12" step="1" :value="boreSize" @input="setBoreSize" /><span class="u">{{ boreSize }}</span></div>
            <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
            <div v-if="showContourLabels" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="20" step="1" :value="contourLabelSize" @input="setContourSize" /><span class="u">{{ contourLabelSize }}</span></div>
          </template>
        </div>
        <div class="sdfoot"><span class="save" @click="covSetOpen = false">完成</span></div>
      </div>
    </div>

    <!-- 性能指标表（独立浮窗，每个天线一张）。对标 SATSOFT 两步法、合为一窗：
         上 = 城市输入区（增删改）；下 = 只读性能结果表（仅列覆盖该城市的波束）。 -->
    <div v-if="perfKey" class="perf-win" :style="{ left: perfWin.x + 'px', top: perfWin.y + 'px', width: perfWin.w + 'px', height: perfWin.h + 'px' }">
      <div class="perf-h" @mousedown="perfDragMove">
        <span class="perf-t">性能指标表
          <em v-if="perf.ctxInfo.value">· {{ perf.ctxInfo.value.satName }} / {{ perf.ctxInfo.value.antName }} · {{ perf.ctxInfo.value.beams }} 波束</em>
        </span>
        <span class="csx" @click="closePerf">✕</span>
      </div>

      <!-- 上：城市输入区（第一步——输入城市列表；每个经纬度 = 一行城市，不随波束膨胀） -->
      <section class="perf-input" :style="{ height: perfInputH + 'px' }">
        <div class="pin-h">
          <span class="pin-t">城市输入</span>
          <span class="ptb" :class="{ dis: !perf.canUndo.value }" title="撤销 (Ctrl+Z)" @click="perfUndo">↶</span>
          <span class="ptb" :class="{ dis: !perf.canRedo.value }" title="重做 (Ctrl+Y)" @click="perfRedo">↷</span>
          <span class="ptb" title="把地图上的点标记 / 地面站导入为城市" @click="perfImportMarkers">⭳ 从标记导入</span>
          <span class="ptb" title="从剪贴板粘贴表格（末两列=经度、纬度，可含 国家/城市/代号）批量添加" @click="perfPasteBtn">📋 粘贴</span>
          <span class="ptb" title="清空城市列表" @click="perfClearStations">清空</span>
          <span class="perf-cnt">{{ perf.stations.value.length }} 城市</span>
        </div>
        <!-- Excel 式网格：拖拽框选 / Shift 扩选 / 方向键导航 / Ctrl+C 复制 / 双击·键入编辑 / Ctrl+V 区域粘贴 / Del 清除 -->
        <div class="pin-body" :ref="el => perfInGrid.bodyEl.value = el" tabindex="0" @keydown="perfInGrid.gridKey" @click="perfInGrid.focusGrid">
          <table class="perf-tbl grid">
            <thead>
              <tr>
                <th v-for="c in perfInCols" :key="c.key" :class="{ n: c.num }">{{ c.label }}</th>
                <th class="th-act"></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, ri) in perf.stations.value" :key="s.id">
                <td v-for="(c, ci) in perfInCols" :key="c.key"
                    :class="{ n: c.num, ed: true, sel: perfInGrid.inSel(ri, ci), active: perfInGrid.isActive(ri, ci), editing: perfInGrid.isEdit(ri, ci) }"
                    @mousedown="perfInGrid.cellDown($event, ri, ci)" @mouseenter="perfInGrid.cellEnter(ri, ci)" @dblclick="perfInGrid.tryEdit(ri, ci, null)">
                  <input v-if="perfInGrid.isEdit(ri, ci)" :ref="el => perfInGrid.editEl.value = el" class="pcell" :class="{ n: c.num }"
                         :value="perfInGrid.editSeed.value != null ? perfInGrid.editSeed.value : (s[c.key] == null ? '' : s[c.key])"
                         @blur="perfInGrid.commitEdit" @paste="perfInGrid.cellPaste($event, s, c.key)" />
                  <template v-else>{{ s[c.key] || '' }}</template>
                </td>
                <td class="td-act"><span class="del" title="删除该城市" @click="perfDelStation(s.id)">✕</span></td>
              </tr>
              <!-- 末行：新增（可在任一格 Ctrl+V 粘贴整块表格批量添加；不参与框选） -->
              <tr class="pin-add" @paste="perfPaste" title="可从 Excel 复制后在此 Ctrl+V 批量粘贴（末两列=经度、纬度）">
                <td><input v-model="perfNew.country" placeholder="国家" @keydown.enter="perfAddStation" /></td>
                <td><input v-model="perfNew.city" placeholder="城市" @keydown.enter="perfAddStation" /></td>
                <td><input v-model="perfNew.desig" placeholder="代号" @keydown.enter="perfAddStation" /></td>
                <td class="n"><input class="n" v-model="perfNew.lon" placeholder="经度" @keydown.enter="perfAddStation" /></td>
                <td class="n"><input class="n" v-model="perfNew.lat" placeholder="纬度" @keydown.enter="perfAddStation" /></td>
                <td class="act"><span class="ptb add" title="新增城市 (Enter)" @click="perfAddStation">＋</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 中缝：上下拖拽调整城市输入区 / 结果区的高度比例 -->
      <div class="perf-split" title="拖拽调整上下高度" @mousedown="perfDragSplit"><span class="grip"></span></div>

      <!-- 下：只读性能结果表（第二步——输出；仅列覆盖该城市的波束） -->
      <section class="perf-result">
        <div class="pr-h">
          <span class="pr-t">性能结果<em>只读</em></span>
          <label class="pr-cov"><input type="checkbox" v-model="perfOpts.filterOn" title="仅列方向性≥阈值（覆盖该城市）的波束" /> 仅覆盖波束</label>
          <label class="pr-cov" :class="{ dis: !perfOpts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.number="perfOpts.minDir" :disabled="!perfOpts.filterOn" /><span class="u">dB</span></label>
          <input class="perf-q" v-model="perf.query.value" placeholder="查询：国家 / 城市 / 代号" />
          <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="perfCopyResult">⧉ 复制全表</span>
          <span class="ptb" :class="{ on: perfOptsOpen }" title="显示列 / 计算口径 / 指向误差" @click="perfOptsOpen = !perfOptsOpen">⚙ 选项…</span>
          <span class="perf-cnt">{{ perf.filteredRows.value.length }} 行</span>
        </div>
        <!-- 只读 Excel 网格：拖拽框选 / Shift 扩选 / 方向键导航 / Ctrl+A 全选 / Ctrl+C 复制选区（不可编辑） -->
        <div class="pr-body" :ref="el => perfResGrid.bodyEl.value = el" tabindex="0" @keydown="perfResGrid.gridKey" @click="perfResGrid.focusGrid">
          <table class="perf-tbl grid ro">
            <thead>
              <tr>
                <th v-for="c in perfCols" :key="c.key" :style="{ width: c.w + 'px' }" :class="{ n: c.num }" :title="c.na ? '本数据仅含功率（无相位），AR 暂不可算' : ''">{{ c.label }}<em v-if="c.na">*</em></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, ri) in perf.filteredRows.value" :key="r.id" :class="{ out: !r.inPattern }">
                <td v-for="(c, ci) in perfCols" :key="c.key"
                    :class="{ n: c.num, sel: perfResGrid.inSel(ri, ci), active: perfResGrid.isActive(ri, ci) }"
                    @mousedown="perfResGrid.cellDown($event, ri, ci)" @mouseenter="perfResGrid.cellEnter(ri, ci)">
                  <template v-if="c.num">{{ c.fix != null ? perfFix(r[c.key], c.fix) : (r[c.key] == null ? '—' : r[c.key]) }}</template>
                  <template v-else>{{ r[c.key] || '' }}</template>
                </td>
              </tr>
              <tr v-if="!perf.stations.value.length"><td :colspan="perfCols.length" class="perf-empty">先在上方「城市输入」添加城市（手填 / 从标记导入 / 粘贴）</td></tr>
              <tr v-else-if="!perf.filteredRows.value.length"><td :colspan="perfCols.length" class="perf-empty">没有波束覆盖这些城市 — 可调低覆盖阈值或取消「仅覆盖波束」</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- 8 向缩放手柄（窗口 overflow:hidden，故均贴边在框内） -->
      <div class="prh prh-n" @mousedown="perfDragResize($event, 'n')"></div>
      <div class="prh prh-s" @mousedown="perfDragResize($event, 's')"></div>
      <div class="prh prh-w" @mousedown="perfDragResize($event, 'w')"></div>
      <div class="prh prh-e" @mousedown="perfDragResize($event, 'e')"></div>
      <div class="prh prh-nw" @mousedown="perfDragResize($event, 'nw')"></div>
      <div class="prh prh-ne" @mousedown="perfDragResize($event, 'ne')"></div>
      <div class="prh prh-sw" @mousedown="perfDragResize($event, 'sw')"></div>
      <div class="perf-rsz" title="拖拽缩放窗口" @mousedown="perfDragResize($event, 'se')"></div>
    </div>

    <!-- 性能表选项弹窗（对标 SATSOFT Performance Table Options）：显示列 / 过滤 / 波束类型 / 计算口径 / 指向误差 -->
    <div v-if="perfOptsOpen && perfOpts" class="sat-mask perf-opt-mask" @click.self="perfOptsOpen = false">
      <div class="perf-opt-dlg">
        <div class="sdh"><span>性能表选项<em v-if="perf.ctxInfo.value"> · {{ perf.ctxInfo.value.antName }}</em></span><span class="csx" @click="perfOptsOpen = false">✕</span></div>
        <div class="perf-opt-body">
          <!-- 左：显示列 -->
          <section class="po-card po-cols">
            <div class="po-ct">显示列</div>
            <div class="po-scroll">
              <div v-for="g in perf.colGroups" :key="g.title" class="po-grp">
                <div class="po-gt">{{ g.title }}</div>
                <label v-for="k in g.keys" :key="k" class="po-ck" :class="{ dis: perfColNa(k) }">
                  <input type="checkbox" v-model="perfOpts.cols[k]" :disabled="perfColNa(k)" />
                  <span>{{ perfColLabel(k) }}<em v-if="perfColNa(k)"> *</em></span>
                </label>
              </div>
            </div>
            <div class="po-note">取值用功率域 bicubic 插值；AR 由复场相位算（bicubic）。预置烘焙天线无复场 → AR 显示 —</div>
          </section>

          <!-- 右：计算设置 -->
          <div class="po-right">
            <section class="po-card">
              <div class="po-ct">过滤</div>
              <label class="po-chk"><input type="checkbox" v-model="perfOpts.filterOn" /><span>剔除低于最低方向性的记录</span></label>
              <div class="po-row"><label>最低方向性</label><input class="ci" type="number" step="0.5" v-model.number="perfOpts.minDir" :disabled="!perfOpts.filterOn" /><span class="u">dB</span></div>
            </section>

            <section class="po-card">
              <div class="po-ct">参数计算</div>
              <label class="po-chk"><input type="checkbox" v-model="perfOpts.sameAsAnt" /><span>与天线当前设置一致</span></label>
              <template v-if="!perfOpts.sameAsAnt">
                <div class="po-row"><label>极化</label><select v-model="perfOpts.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
                <div class="po-row"><label>单位</label><span class="seg sm"><span class="sg" :class="{ on: perfOpts.unit === 'dB' }" @click="perfOpts.unit = 'dB'">dB</span><span class="sg" :class="{ on: perfOpts.unit === 'power' }" @click="perfOpts.unit = 'power'">功率</span><span class="sg" :class="{ on: perfOpts.unit === 'voltage' }" @click="perfOpts.unit = 'voltage'">电压</span></span></div>
                <div class="po-row"><label>路径损耗</label><select v-model="perfOpts.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>
                <div class="po-row"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.number="perfOpts.gainOffset" /><span class="u">dB</span></div>
              </template>
            </section>

            <section class="po-card">
              <div class="po-ct">指向误差 · Min/Max Pointing</div>
              <div class="po-row"><label>方位 Az</label><input class="ci" type="number" step="any" min="0" v-model.number="perfOpts.pointAz" /><span class="u">°</span></div>
              <div class="po-row"><label>俯仰 El</label><input class="ci" type="number" step="any" min="0" v-model.number="perfOpts.pointEl" /><span class="u">°</span></div>
              <div class="po-row"><label>偏航 Yaw</label><input class="ci" type="number" step="any" min="0" v-model.number="perfOpts.pointYaw" /><span class="u">°</span></div>
            </section>
          </div>
        </div>
        <div class="sdfoot"><span class="save" @click="perfOptsOpen = false">完成</span></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.g3 { display: flex; flex-direction: column; height: 100%; position: relative; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: 12.5px; }
.bar .t { font-family: var(--font-serif); font-size: 14px; }
.bar select { border: 1px solid var(--border); background: var(--bg); padding: 3px 8px; }
.search { position: relative; }
.search input { border: 1px solid var(--border); background: var(--bg); padding: 3px 24px 3px 8px; outline: none; width: 180px; }
.search .clr { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 11px; line-height: 1; cursor: pointer; color: var(--text-faint); }
.search .clr:hover { color: var(--text); }
.search .panel { position: absolute; top: 28px; left: 0; width: 260px; max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--border-strong); z-index: 5; }
.search .item { padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search .item:hover { background: var(--surface); }
.search .nm { font-size: 12.5px; }
.search .sub { color: var(--text-faint); font-size: 11px; }
.meta { margin-left: auto; color: var(--text-faint); }
.tl { display: flex; align-items: center; gap: 12px; padding: 7px 16px 9px; border-bottom: 1px solid var(--border); flex: none; font-size: 11.5px; }
/* 时间轴（同小程序样式）：自绘轨道 + 进度 + 圆点滑块 + 文字刻度 */
.tb-track { position: relative; flex: 1; min-width: 180px; height: 30px; cursor: pointer; }
.tb-track.dis { opacity: 0.45; pointer-events: none; }
.tb-bar { position: absolute; left: 0; right: 0; top: 9px; height: 3px; border-radius: 2px; background: var(--border-strong); }
.tb-fill { height: 100%; border-radius: 2px; background: var(--accent); }
.tb-knob { position: absolute; top: 4.5px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); transform: translateX(-50%); box-shadow: 0 0 0 2px var(--bg); }
.tb-tick { position: absolute; top: 6px; width: 1px; height: 9px; background: var(--border-strong); transform: translateX(-50%); }
.tb-mark { position: absolute; top: 17px; font-family: var(--font-mono); font-size: 10px; line-height: 1; color: var(--text-faint); white-space: nowrap; pointer-events: none; }
.tlab { font-family: var(--font-mono); min-width: 150px; color: var(--text-muted); }
.tl .st { padding: 2px 8px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); }
.tl .st.dis { opacity: 0.4; pointer-events: none; }
.tl .beamc { display: inline-flex; align-items: center; gap: 6px; margin-left: 6px; flex: none; }
.tl .bl { color: var(--text-muted); }
.tl .bi { width: 56px; border: 0; border-bottom: 1px solid var(--border-strong); background: transparent; outline: none; color: var(--text); font-size: 11.5px; }
.tl .bu { color: var(--text-muted); }
.tl .lock { cursor: pointer; }
.tl .hint { color: var(--text-faint); }
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-size: 12px; }
.mini.on { color: var(--text); border-color: var(--accent); }
.body { flex: 1; min-height: 0; display: flex; }
.stage-wrap { flex: 1; min-width: 0; position: relative; }
.stage { width: 100%; height: 100%; background: #070b12; }
.flat { position: absolute; inset: 0; width: 100%; height: 100%; background: #0b1a2b; }
/* 聚焦卫星图例（左下，3D/2D 共用）：色条对应地图上实际绘制的覆盖范围线与星下点轨迹线 */
.focus-legend {
  position: absolute; left: 14px; bottom: 10px; display: flex; flex-direction: column; gap: 5px;
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  backdrop-filter: blur(10px) saturate(1.1); -webkit-backdrop-filter: blur(10px) saturate(1.1);
  border: 1px solid color-mix(in srgb, var(--border-strong) 60%, transparent);
  border-radius: 5px; padding: 7px 10px; font-size: 11px; color: var(--text-muted); pointer-events: none;
}
.fl-row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.fl-sw { width: 18px; height: 0; border-top: 2px solid; flex: none; }
.fl-sw.cov { border-color: #96d7f0; }
.fl-sw.trk { border-color: #c2a25e; }
.dl-banner { position: absolute; left: 50%; top: 55%; transform: translate(-50%, -50%); width: 420px; max-width: 86%; background: rgba(20,22,28,0.94); border: 1px solid #34384a; border-radius: 6px; padding: 16px 18px; color: #d7dde6; text-align: center; }
.dl-msg { font-size: 13px; margin-bottom: 12px; color: #f0c674; line-height: 1.5; }
.dl-row { display: flex; gap: 10px; justify-content: center; }
.dl-row button { border: 1px solid #4a5168; background: #1c2230; color: #d7dde6; padding: 6px 14px; cursor: pointer; border-radius: 4px; font-size: 12.5px; }
.dl-row button:hover { border-color: #6b7490; }
.card {
  position: absolute; right: 14px; top: 14px; width: 256px;
  max-height: calc(100% - 28px); overflow-y: auto;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  backdrop-filter: blur(14px) saturate(1.1); -webkit-backdrop-filter: blur(14px) saturate(1.1);
  border: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent);
  border-radius: 6px; padding: 11px 13px; font-size: 12px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.45);
}
.ch { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.cc { flex: none; align-self: center; color: var(--text-faint); font-size: 10px; line-height: 1; transition: transform .15s; }
.cc.col { transform: rotate(-90deg); }
.ch:hover .cc { color: var(--text); }
.cn { flex: 1 1 auto; min-width: 0; font-family: var(--font-serif); font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.card.collapsed .cn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx { flex: none; cursor: pointer; color: var(--text-faint); line-height: 1.2; }
.cx:hover { color: var(--text); }
.cmeta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.badge { font-family: var(--font-mono); font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--border); color: var(--text-muted); }
.badge.kind { color: var(--accent); border-color: var(--accent); }
.badge.geo { color: #ffd24a; border-color: #ffd24a; }
.csec { margin: 11px 0 5px; padding-top: 8px; border-top: 1px solid var(--border); font-size: 10.5px; letter-spacing: 1.5px; color: var(--text-faint); }
.rows { display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.row .k { color: var(--text-muted); white-space: nowrap; }
.row .k em { font-style: italic; font-family: var(--font-serif); color: var(--accent); margin-left: 3px; font-size: 12.5px; }
.row .v { font-family: var(--font-mono); color: var(--text); white-space: nowrap; text-align: right; }
.row .v i { font-style: normal; color: var(--text-faint); font-size: 10.5px; margin-left: 3px; }

/* 覆盖图：右侧停靠面板（挤压地球，独占右栏） */
/* 右侧边栏：与「设置弹窗」一致——surface 底色、统一表头/分区内边距与标题字号 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: 12px; }
.csh { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: 15px; padding: 11px 16px; align-self: center; }
.flatbtn { align-self: center; margin-left: 10px; flex: none; border: 1px solid var(--border); padding: 2px 9px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.flatbtn:hover { border-color: var(--accent); color: var(--text); }
.flatbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
/* 关闭按钮：与「文件管理」一致——Windows 风矩形热区，悬停变红 */
.winx { width: 44px; margin-left: auto; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s; }
.winx:hover { background: #c42b1c; color: #fff; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.srow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.srow:last-child { margin-bottom: 0; }
.srow label { color: var(--text-muted); width: 36px; flex: none; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
.srow .ci:disabled { background: var(--surface); color: var(--text-faint); cursor: not-allowed; border-style: dashed; }
.srow .u { color: var(--text-muted); }
.seg { display: flex; border: 1px solid var(--border); }
.seg .sg { padding: 3px 12px; cursor: pointer; color: var(--text-muted); }
.seg .sg.on { background: var(--accent); color: #fff; }
.nseg { font-size: 12px; }
.nseg .sg { padding: 3px 8px; }
.nseg .sg + .sg { border-left: 1px solid var(--border); }
.sect { display: flex; align-items: center; margin-bottom: 6px; color: var(--text-muted); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: 11.5px; }
/* 分区标题旁的「小眼睛」显隐开关：睁眼=显示，闭眼（带斜杠/淡出）=隐藏 */
.eyebtn { display: inline-flex; align-items: center; margin-left: 7px; cursor: pointer; color: var(--text-muted); }
.eyebtn:hover { color: var(--text); }
.eyebtn.off { color: var(--text-faint); }
/* 天线设置区标题：SVG 图标 + 「天线设置」+ 天线名（高区分度） */
.setsect .ant-svg { width: 14px; height: 14px; color: var(--accent); margin-right: 6px; }
.setsect .setlbl { color: var(--text); font-weight: 600; }
.setsect .setname { margin-left: 6px; color: var(--accent); font-weight: 600; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { max-height: 150px; overflow-y: auto; border: 1px solid var(--border); padding: 4px 6px; }
.chk { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.chk .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.chk input, .chk2 input { accent-color: var(--accent); }
.empty { color: var(--text-faint); padding: 4px 0; }
.cnt { margin-top: 6px; color: var(--text-faint); font-size: 11.5px; }
.cnt .lnk2 { margin-left: 8px; color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; }
.chip { padding: 2px 7px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-family: var(--font-mono); font-size: 11px; }
.chip.on { color: var(--text); }
.chk2 { display: flex; align-items: center; gap: 6px; margin-top: 8px; cursor: pointer; }
.tip { color: var(--text-faint); font-size: 11px; margin-top: 4px; line-height: 1.5; }
/* GRD 工程树：卫星 → 天线（二级层次，竖向引导线 + 统一缩进） */
.gtree { margin-top: 6px; max-height: clamp(280px, 48vh, 620px); overflow-y: auto; }
/* 卫星行（节点头） */
.gsat { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 2px; color: var(--text); font-size: 12px; border-radius: 3px; }
.gsat:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gsat .tri { font-style: normal; flex: none; width: 12px; text-align: center; color: var(--text-faint); font-size: 9px; cursor: pointer; transition: transform .12s; }
.gsat .tri.open { transform: rotate(90deg); }
.gsat .gsname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.gsat .gsname:hover { color: var(--accent); }
.gsat .gsname em { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.gsat .gsname .simtag { font-style: normal; margin-left: 5px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 2px; color: var(--accent); font-size: 10px; vertical-align: middle; }
.gsvg { flex: none; width: 14px; height: 14px; }
.gsat .sat-svg { color: #000; opacity: .92; }
.gant .ant-svg { width: 13px; height: 13px; color: var(--text-faint); transition: color .12s; }
.gant:hover .ant-svg, .gant.on .ant-svg { color: var(--accent); }
.gant.foc .ant-svg { color: var(--accent); }
.gperf { display: flex; align-items: center; gap: 6px; margin: 0 0 2px 22px; padding: 2px 6px; color: var(--text-faint); cursor: pointer; font-size: 11px; border-radius: 3px; transition: background .12s, color .12s; }
.gperf:hover { color: var(--text-muted); background: color-mix(in srgb, var(--text) 5%, transparent); }
.gperf .perf-svg { width: 12px; height: 12px; flex: none; }
.gperf .gperfn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gperf.on { color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.gperf.on .perf-svg { color: var(--accent); }

/* 性能指标表浮窗（几何由 JS 控制：可拖拽移动 / 右下角缩放 / 中缝分隔） */
.perf-win { position: absolute; left: 24px; top: 64px; display: flex; flex-direction: column; background: var(--panel, var(--bg)); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 12px 40px rgba(0, 0, 0, .35); z-index: 60; overflow: hidden; }
.perf-h { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; cursor: move; user-select: none; }
.perf-t { flex: 1; font-family: var(--font-serif); font-size: 13.5px; color: var(--text); }
.perf-t em { font-style: normal; font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
.perf-h .csx { cursor: pointer; color: var(--text-faint); padding: 0 4px; position: relative; z-index: 5; }   /* 高于 NE 缩放角，保证可点关闭 */
.perf-h .csx:hover { color: var(--text); }
.ptb { font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.ptb:hover { color: var(--text); border-color: var(--accent); }
.ptb.add { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.ptb.dis { opacity: .38; pointer-events: none; }
.ptb.on { color: var(--accent); border-color: var(--accent); }
.perf-q { flex: 1; min-width: 110px; border: 1px solid var(--border); background: var(--bg); padding: 2px 8px; font-size: 11.5px; color: var(--text); border-radius: 4px; outline: none; }
.perf-cnt { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; }

/* —— 上：城市输入区（高度由 JS 控制，可经中缝拖拽） —— */
.perf-input { flex: none; display: flex; flex-direction: column; min-height: 0; }
/* 中缝分隔条（上下拖拽） */
.perf-split { flex: none; height: 7px; cursor: ns-resize; background: var(--border); display: flex; align-items: center; justify-content: center; }
.perf-split:hover { background: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.perf-split .grip { width: 30px; height: 2px; border-radius: 2px; background: color-mix(in srgb, var(--text) 35%, transparent); }
/* 缩放手柄：四角 + 四边（窗口 overflow:hidden，全部贴边在框内）。角 z-index 高于边以便优先命中。 */
.prh { position: absolute; z-index: 3; }
.prh-n { top: 0; left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
.prh-s { bottom: 0; left: 14px; right: 14px; height: 6px; cursor: ns-resize; }
.prh-w { left: 0; top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
.prh-e { right: 0; top: 14px; bottom: 14px; width: 6px; cursor: ew-resize; }
.prh-nw { left: 0; top: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 4; }
.prh-ne { right: 0; top: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 4; }
.prh-sw { left: 0; bottom: 0; width: 14px; height: 14px; cursor: nesw-resize; z-index: 4; }
/* 右下角缩放手柄（带可见纹理） */
.perf-rsz { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize; z-index: 4; background: linear-gradient(135deg, transparent 50%, color-mix(in srgb, var(--text) 30%, transparent) 50%, color-mix(in srgb, var(--text) 30%, transparent) 62%, transparent 62%, transparent 74%, color-mix(in srgb, var(--text) 30%, transparent) 74%, color-mix(in srgb, var(--text) 30%, transparent) 86%, transparent 86%); }
.pin-h, .pr-h { display: flex; align-items: center; gap: 6px; padding: 6px 12px; flex: none; flex-wrap: wrap; }
.pin-h { border-bottom: 1px solid var(--border); }
.pin-t, .pr-t { font-size: 11.5px; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.pr-t em { margin-left: 4px; font-style: normal; font-size: 10px; font-weight: 400; color: var(--text-faint); border: 1px solid var(--border); border-radius: 6px; padding: 0 5px; }
.pin-body { flex: 1; overflow: auto; outline: none; }
/* 新增行（不参与框选）：常驻输入框 */
.perf-tbl tr.pin-add td { padding: 0; cursor: default; }
.perf-tbl tr.pin-add td input { width: 100%; box-sizing: border-box; border: 1px solid transparent; background: transparent; color: var(--text); font: inherit; font-size: 11.5px; padding: 3px 8px; outline: none; }
.perf-tbl tr.pin-add td input.n { text-align: right; font-family: var(--font-mono); }
.perf-tbl tr.pin-add td input:hover { border-color: var(--border); }
.perf-tbl tr.pin-add td input:focus { border-color: var(--accent); background: var(--bg); }
.perf-tbl tr.pin-add td input::placeholder { color: var(--text-faint); }
.perf-tbl tr.pin-add:hover { background: none; }
.perf-tbl tr.pin-add .ptb.add { display: inline-block; padding: 0 6px; line-height: 18px; }

/* —— 下：只读性能结果表 —— */
.perf-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pr-h { border-bottom: 1px solid var(--border); }
.pr-cov { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); white-space: nowrap; cursor: pointer; }
.pr-cov.dis { opacity: .5; }
.pr-cov input[type=checkbox] { accent-color: var(--accent); }
.pr-cov .ci { width: 52px; border: 1px solid var(--border); background: var(--bg); padding: 1px 5px; font-size: 11px; color: var(--text); border-radius: 4px; outline: none; font-family: var(--font-mono); }
.pr-cov .ci:disabled { opacity: .45; }
.pr-cov .u { color: var(--text-faint); font-size: 10.5px; }
.pr-body { flex: 1; overflow: auto; }
.perf-tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.perf-tbl th, .perf-tbl td { padding: 3px 8px; border-bottom: 1px solid color-mix(in srgb, var(--border) 60%, transparent); text-align: left; white-space: nowrap; }
.perf-tbl th { position: sticky; top: 0; background: var(--panel, var(--bg)); color: var(--text-muted); font-weight: 600; z-index: 1; }
.perf-tbl th.n, .perf-tbl td.n { text-align: right; font-family: var(--font-mono); }
.perf-tbl td { color: var(--text); }
.perf-tbl th em { color: var(--text-faint); font-style: normal; }
.perf-tbl tbody tr:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.perf-tbl tr.out td { color: var(--text-faint); }
.perf-empty { text-align: center !important; color: var(--text-faint); padding: 18px !important; font-style: italic; }
/* —— Excel 式网格（城市输入 + 性能结果共用）：十字光标 / 框选淡蓝 / 活动格·编辑格描蓝框 —— */
.perf-tbl.grid { user-select: none; }                    /* 拖拽框选时不选中文本 */
.perf-tbl.grid tbody td { cursor: cell; }
.perf-tbl.grid td.sel { background: color-mix(in srgb, var(--accent) 16%, transparent); }
.perf-tbl.grid tr.out td.sel { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.perf-tbl.grid td.active { box-shadow: inset 0 0 0 2px var(--accent); }
.perf-tbl.grid td.editing { padding: 0; box-shadow: inset 0 0 0 2px var(--accent); }
.perf-tbl.grid td.ed { color: var(--text); }
.pcell { width: 100%; box-sizing: border-box; border: none; background: var(--bg); color: inherit; font: inherit; padding: 3px 8px; outline: none; }
.pcell.n { text-align: right; font-family: var(--font-mono); }
.perf-tbl .td-act, .perf-tbl .th-act { width: 22px; text-align: center; }
.perf-tbl .td-act { cursor: default; }
.perf-tbl .td-act .del { cursor: pointer; color: var(--text-faint); opacity: 0; }
.perf-tbl tbody tr:hover .del { opacity: .8; }
.perf-tbl .td-act .del:hover { color: #ff6a6a; }

/* 性能表选项弹窗 */
.sat-mask.perf-opt-mask { z-index: 70; }   /* 提高特异性压过 .sat-mask(z40)，高于性能表浮窗(z60)避免被遮挡 */
.perf-opt-dlg { width: 620px; max-width: calc(100% - 32px); max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .55); }
.perf-opt-dlg .sdh em { font-style: normal; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-faint); }
.perf-opt-body { display: flex; gap: 12px; padding: 12px; overflow: auto; align-items: stretch; }
.po-card { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: color-mix(in srgb, var(--text) 2.5%, transparent); }
.po-ct { font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: .3px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.po-cols { flex: 0 0 196px; display: flex; flex-direction: column; }
.po-scroll { flex: 1; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; align-content: start; }
.po-grp { display: contents; }
.po-gt { grid-column: 1 / -1; font-size: 10px; color: var(--text-faint); margin: 6px 0 1px; letter-spacing: .5px; }
.po-gt:first-child { margin-top: 0; }
.po-ck { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: 11.5px; color: var(--text); cursor: pointer; min-width: 0; }
.po-ck span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-ck input { flex: none; accent-color: var(--accent); }
.po-ck.dis { color: var(--text-faint); cursor: not-allowed; }
.po-ck em { color: var(--text-faint); font-style: normal; }
.po-note { font-size: 10px; color: var(--text-faint); line-height: 1.4; margin-top: 8px; padding-top: 6px; border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.po-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.po-chk { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text); cursor: pointer; padding: 1px 0; }
.po-chk input { accent-color: var(--accent); }
.po-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; }
.po-row label { flex: 0 0 64px; color: var(--text-muted); }
.po-row .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 12px; color: var(--text); border-radius: 4px; outline: none; }
.po-row .ci:disabled { opacity: .45; }
.po-row select { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 12px; color: var(--text); border-radius: 4px; }
.po-row .u { flex: none; color: var(--text-faint); font-size: 11px; }
.po-row .seg, .po-card > .seg { flex: 1; }
.gck { flex: none; width: 12px; height: 12px; margin: 0; cursor: pointer; accent-color: var(--accent); }
.gck:disabled { opacity: .35; cursor: not-allowed; }
/* 展开后的子级容器：左侧一条淡引导线统辖「卫星显示开关 + 天线列表」，缩进统一 */
.gbody { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--border); margin-bottom: 2px; }
/* 天线行（叶子节点） */
.gant { display: flex; align-items: center; gap: 6px; padding: 3px 6px; margin: 1px 0; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-radius: 3px; transition: background .12s, color .12s, box-shadow .12s; }
.gant:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.gant.on { color: var(--text); }                                                                          /* 已选中=绘制中 */
.gant.foc { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent); font-weight: 600; }   /* 聚焦=编辑中 */
.gant .aname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gant .aname-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--bg); padding: 1px 5px; font-size: 11.5px; color: var(--text); outline: none; }
.gant .afoc { flex: none; font-size: 9.5px; font-weight: 600; letter-spacing: .3px; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 8px; padding: 0 5px; line-height: 14px; }
.gant.noant { color: var(--text-faint); font-style: italic; cursor: default; padding-left: 6px; }
.gant.noant:hover { background: none; color: var(--text-faint); }
/* 行内次级操作（卫星行 ＋✎✕ / 天线行 ✎✕ 共用）：常驻但弱化淡灰，hover 该行变亮 */
.sacts { flex: none; display: flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 4px; }
.sacts .ic { font-size: 11px; color: var(--text-faint); opacity: .5; cursor: pointer; padding: 0; transition: opacity .12s, color .12s; }
.gsat:hover .sacts .ic, .gant:hover .sacts .ic { opacity: .9; }
.sacts .ic:hover { color: var(--text); opacity: 1; }
.sacts .ic.del:hover { color: #e66; }
/* 设置面板：当前编辑对象提示 */
.grd-side .sect .editing { margin-left: auto; font-size: 9.5px; font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: 8px; padding: 1px 6px; }
/* GRD 电平表 */
.glv { border: 1px solid var(--border); border-radius: 2px; margin-top: 5px; }
.lvhdr { margin-left: auto; color: var(--text-faint); font-size: 10px; font-family: var(--font-mono); }
.glvrow { display: flex; align-items: center; gap: 5px; padding: 3px 6px; }
.glvrow + .glvrow { border-top: 1px solid var(--border); }
.glvrow .lvclr { width: 20px; height: 18px; padding: 0; border: 1px solid var(--border); background: none; cursor: pointer; flex: none; }
.glvrow .lvval { width: 66px; flex: none; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: 11.5px; padding: 2px 6px; font-family: var(--font-mono); }
.glvrow .lvabs { flex: 1; color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
.glvrow .ic.del { cursor: pointer; color: var(--text-faint); }
.glvrow .ic.del:hover { color: #d66; }
.glvadd { padding: 4px 7px; text-align: center; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-top: 1px solid var(--border); }
.glvadd:hover { color: var(--accent); background: var(--bg); }
/* Beams To Plot 多波束多选列表（SATSOFT 风格） */
.bplist { border: 1px solid var(--border); border-radius: 2px; margin-top: 5px; max-height: 132px; overflow-y: auto; }
.brow { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: pointer; font-size: 11.5px; }
.brow + .brow { border-top: 1px solid var(--border); }
.brow:hover { background: var(--bg); }
.brow.on .bnm-in { color: var(--text); }
.brow .bnm-in { flex: 1; min-width: 0; border: 1px solid transparent; background: transparent; color: var(--text-muted); font-size: 11.5px; padding: 1px 4px; border-radius: 2px; outline: none; }
.brow .bnm-in:hover { border-color: var(--border); }
.brow .bnm-in:focus { border-color: var(--accent); background: var(--bg); color: var(--text); }
.brow .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.brow .bpk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
/* Excel 式「(全选)」主行：置顶 sticky、随列表滚动常驻；三态复选框（全/半/无） */
.brow.ball { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--border); }
.brow.ball + .brow { border-top: 0; }
.brow .balln { flex: 1; color: var(--text); font-weight: 600; }
/* 两级覆盖：卫星卡 / 批次 */
.satcard { border-left: 2px solid var(--accent); }
.sath { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.satn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.satn em { color: var(--text-muted); font-style: normal; font-weight: 400; font-size: 11px; }
.seg.sm .sg { padding: 2px 7px; font-size: 11px; }
.ic { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 1px; }
.ic:hover { color: var(--text); }
.ic.del:hover { color: #e66; }
.ic.ok { color: #5fbf6a; font-weight: 700; }
.ic.ok:hover { color: #7ddc88; }
.batch { border: 1px solid var(--border); padding: 7px 8px; margin-top: 8px; }
.bah { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.bnm { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); outline: none; }
.bnm:focus { border-color: var(--accent); }
.clr { flex: none; width: 26px; height: 20px; padding: 0; border: 1px solid var(--border); background: none; cursor: pointer; }
.rng { flex: 1; min-width: 0; accent-color: var(--accent); }
.clr { flex: 1; min-width: 0; height: 22px; padding: 0; border: 1px solid var(--border); background: var(--bg); cursor: pointer; }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sw { width: 24px; height: 24px; border-radius: 3px; border: 1px solid var(--border); cursor: pointer; box-sizing: border-box; }
.sw:hover { border-color: var(--accent); }
.sw.on { border: 2px solid var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.srow .u { min-width: 18px; text-align: right; }
.bsub { display: flex; align-items: center; gap: 8px; margin: 7px 0 4px; color: var(--text-muted); font-size: 11.5px; }
.bsub .lnk { color: var(--accent); cursor: pointer; font-size: 11.5px; }
.bsub .cnt2 { margin-left: auto; color: var(--text-faint); font-size: 11px; }
.bq { display: block; width: 100%; box-sizing: border-box; margin-bottom: 5px; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 11.5px; color: var(--text); outline: none; }
.bq:focus { border-color: var(--accent); }
.chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.pglist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pgrow { display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); cursor: pointer; }
.addbatch { margin-top: 8px; text-align: center; border: 1px dashed var(--border); padding: 4px; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.addbatch:hover { border-color: var(--accent); background: var(--surface); }
.legend { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.legend .lrow { display: flex; align-items: center; gap: 6px; }
.legend .lname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text); }
.legend .lname em { color: var(--text-muted); font-style: normal; }
.legend .lsw { width: 22px; height: 10px; flex: none; border: 1px solid var(--border); }
.legend .lbar2 { width: 56px; height: 10px; flex: none; border: 1px solid var(--border); background: linear-gradient(to right, hsl(240,90%,55%), hsl(120,90%,55%), hsl(0,90%,55%)); }
.legend .lsc2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); flex: none; }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.cst { font-size: 11px; color: var(--text-faint); }
.cclr { margin-left: auto; font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; }
.cclr:hover { border-color: var(--accent); color: var(--text); }

/* 标记面板 */
.addb { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: 11.5px; }
.addb:hover { background: var(--accent); color: #fff; }
.ci.nrw { width: 0; }
.mlist { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; }
.mrow { display: flex; align-items: center; gap: 6px; }
.mrow .mc { flex: 1; font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); }
.mrow .mc2 { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-faint); }
.mrow .sni { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; outline: none; color: var(--text); }
.del { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 2px; }
.del:hover { color: #e26a6a; }
.tcard { border: 1px solid var(--border); padding: 6px; margin-bottom: 6px; }
.tcard.act { border-color: var(--accent); }
.trow { display: flex; align-items: center; gap: 6px; }
.trow .tk { width: 10px; height: 10px; flex: none; border-radius: 2px; }
.trow .tk.sea { background: #ff6a4a; }
.trow .tk.flight { background: #5ad1ff; }
.trow .tni { flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--border); background: transparent; outline: none; color: var(--text); font-size: 12px; }
.trow .tsel { flex: none; font-size: 11px; color: var(--text-muted); border: 1px solid var(--border); padding: 1px 7px; cursor: pointer; }
.trow .tsel.on { color: var(--accent); border-color: var(--accent); }
.twp { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.twp .wp { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 1px 5px; }
.twp .wdel { margin-left: 4px; cursor: pointer; color: var(--text-faint); }
.twp .wdel:hover { color: #e26a6a; }

/* 仰角线（卫星属性）子分区 */
.dotc { flex: none; width: 10px; height: 10px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.4); }
.lnknm { cursor: pointer; }
.lnknm:hover { color: var(--accent); }
.tip2 { color: var(--text-faint); font-size: 11px; line-height: 1.6; }
.tip2 .lnk { margin-left: 6px; color: var(--accent); cursor: pointer; }
/* 卫星显示开关（卫星名下方独立一行，收起仍显示）：色点 + 卫星名/仰角线（切换） */
.elacts { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin: 1px 0 5px; padding-left: 24px; }
.elacts .dotc { margin-right: 0; }
.elacts .elbtn { flex: none; cursor: pointer; font-size: 10.5px; padding: 1.5px 8px; border: 1px solid var(--border); border-radius: 9px; color: var(--text-muted); white-space: nowrap; transition: color .12s, border-color .12s, background .12s; }
.elacts .elbtn:hover { color: var(--text); border-color: var(--text-faint); }
.elacts .elbtn.on { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.elacts .elbtn.act:hover { color: var(--accent); border-color: var(--accent); }

/* 卫星编辑弹窗 */
.sat-mask { position: absolute; inset: 0; background: rgba(4,8,14,0.55); display: flex; align-items: center; justify-content: center; z-index: 40; }
/* 从文件管理器（z2000 浮层）调起时，提升到其上方并改 fixed，以便两个弹窗共存 */
.sat-mask.sat-overlay { position: fixed; z-index: 2100; }
.sat-dlg { width: 320px; max-height: 86%; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 12px 40px rgba(0,0,0,0.5); display: flex; flex-direction: column; }
.sdh { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: 14px; }
.sdh .csx { margin-left: auto; cursor: pointer; color: var(--text-faint); }
.sdbody { padding: 12px 14px; }
.sdbody .srow label { width: 64px; }
.geobtn { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: 11px; }
.geobtn:hover { background: var(--accent); color: #fff; }
.sdiv { margin: 12px 0 8px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 11.5px; }
.sdbody .sdiv:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.pickbtn { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: 12px; }
.pickbtn:hover { border-color: var(--accent); color: var(--text); }
.pmode { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: 12px; }
.pmode:hover { border-color: var(--accent); color: var(--text); }
.pmode.on { border-color: var(--accent); background: var(--accent); color: #fff; }
.sres { border: 1px solid var(--border); max-height: 150px; overflow-y: auto; margin-bottom: 8px; }
.sresi { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; font-size: 11.5px; }
.sresi:hover { background: var(--bg); }
.sresi .srn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.sresi em { flex: none; font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.sdfoot { display: flex; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
.sdfoot .cancel { margin-left: auto; color: var(--text-muted); border: 1px solid var(--border); padding: 4px 14px; cursor: pointer; font-size: 12px; }
.sdfoot .cancel:hover { color: var(--text); }
.sdfoot .save { background: var(--accent); color: #fff; padding: 4px 18px; cursor: pointer; font-size: 12px; }
/* 应用内提示弹窗：消息文本 + 右对齐「确定」 */
.al-dlg { width: 360px; }
.al-msg { margin: 0; font-size: 13px; line-height: 1.65; color: var(--text); }
.al-dlg .sdfoot { justify-content: flex-end; }
.sat-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: 12px; color: var(--text); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
.sat-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }
.traj-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: 12px; color: var(--text); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
.traj-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }

/* 地图右键上下文菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 60; }
.ctx-menu { position: fixed; z-index: 61; min-width: 190px; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 8px 24px rgba(0,0,0,0.45); padding: 4px; font-size: 12px; color: var(--text); }
.ctx-item { padding: 6px 12px; cursor: pointer; white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ctx-item:hover { background: var(--bg); color: var(--accent); }
.ctx-item.dis, .ctx-item.dis:hover { color: var(--text-muted); opacity: 0.45; cursor: default; background: none; }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }
</style>
