<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import { FIELD_GROUPS, SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ISL_FIELDS, LASER_FIELDS, ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS, defaultsFor, buildRegenParams, buildRegenDownlinkParams, buildRegenIslParams, buildRegenLaserParams, eirpToPowerW, powerWToEirp, rxGtFromNoise } from './regenParams.js'
import { stableStringify } from '../shared/configDirty.js'
import { pf } from '../shared/num.js'   // 全角容错 parseFloat：手填圆轨道高度/倾角（经 sat 面板，不过 StationGrid 归一）也能吃全角数字
import { s8LinkParams } from '../shared/s8Params.js'   // ITU-R P.618-14 §8 统计口径参数组装 + 适用性门控
import { migrateLegacyEs } from '../shared/esMigrate.js'
import { pickColumn, fmtScaled, fmtQty } from '../shared/adaptUnits.js'
import { lbDocT } from '../shared/lbDocI18n.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'   // 报表语言跟随平台语言
import { syncAutoNames, adoptAutoFlag, withAutoFlag, isAutoNamed, newCfgName, newFolderName, copyNameOf } from '../shared/lbAutoName.js'   // 三库条目自动命名（未被用户改名时，名字随关键参数走）
import { byLang } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import { loadSatTree } from '../ngso/satTree.js'   // 卫星树＝轨道来源（v1.4.5 起不再带方向图，见该文件头注）
import { slantWgs84Max, altFromSlant } from '../shared/slantRange.js'   // 手动几何：斜距换算 / 等效轨道高度
import { resolveRefId } from '../shared/lbShare.js'
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import StationGrid from '../ngso/StationGrid.vue'
import BasebandPanel from '../ngso/BasebandPanel.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import RegenSatPanel from './RegenSatPanel.vue'
import WaterfallTable from '../ngso/WaterfallTable.vue'
import LbVizPane from '../components/LbVizPane.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import { useLbReport } from '../shared/useLbReport.js'
import LbFontCtl from '../components/LbFontCtl.vue'
import LbCapFoot from '../components/LbCapFoot.vue'
import LbCustomColsDialog from '../components/LbCustomColsDialog.vue'
import LbSlantTool from '../components/LbSlantTool.vue'
import LbIslRangeTool from '../components/LbIslRangeTool.vue'
import { buildPool, makeResolver, evalRows, customFieldDefs, loadDefs, saveDefs, unitOf, schemaInputPool } from '../shared/lbCustomCols.js'   // 自定义列：公式合成新列
import { labeledResultPool, RESULT_LABELS } from '../shared/lbResultLabels.js'   // 引擎出参中文名与单位（全量词表）
import LbShareDialog from '../components/LbShareDialog.vue'
import { buildRegenScene } from '../shared/lbLinkScene.js'

const api = typeof window !== 'undefined' ? window.api : null

// ============ 配置列表（多级文件夹树；持久化 orbitType='REGEN' 独立命名空间）============
const configs = ref([])
const activeId = ref(null)
const expandedFolders = ref(new Set(JSON.parse(localStorage.getItem('regen/expandedFolders') || '[]')))
function persistExpanded() { try { localStorage.setItem('regen/expandedFolders', JSON.stringify([...expandedFolders.value])) } catch (e) { /* ignore */ } }
function toggleFolder(f) { const s = new Set(expandedFolders.value); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); expandedFolders.value = s; persistExpanded() }
// —— 左侧栏（VS Code 活动栏范式：同屏只开一个视图）——
// 'configs' = 配置列表（场景文件树）/ 'library' = 资源库（全局参数库）/ '' = 隐藏，两者二选一。
// 开关：功能区「文件 › 配置列表」与「视图 › 资源库」，点当前视图即收起。
const SIDE_KEY = 'regen/sideView'
const sideView = ref((() => {
  const v = localStorage.getItem(SIDE_KEY)
  if (v === 'configs' || v === 'library' || v === '') return v
  return localStorage.getItem('regen/configsCollapsed') === '1' ? '' : 'configs'   // 旧键迁移（v1.4.4 及以前）
})())
watch(sideView, (v) => {
  try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ }
  if (v === 'library') reloadSatTree()   // 单例窗口：展开资源库即纳入星座3D 新导入的卫星（选星器数据源）
})
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
// 两视图各记各的宽度（树窄、资源库宽——后者要放得下两列参数），右缘同一个手柄按当前视图写对应那份
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('regen/configsWidth')) || 210)))
const LIB_W_MIN = 300, LIB_W_MAX = 760
const libWidth = ref(Math.min(LIB_W_MAX, Math.max(LIB_W_MIN, Number(localStorage.getItem('regen/libWidth')) || 460)))
const sideResizing = ref(false)
const sideWidth = computed(() => (sideView.value === 'library' ? libWidth.value : configsWidth.value))
function startResizeSide(e) {
  const lib = sideView.value === 'library'
  const w = lib ? libWidth : configsWidth, min = lib ? LIB_W_MIN : CFG_W_MIN, max = lib ? LIB_W_MAX : CFG_W_MAX
  const startX = e.clientX, startW = w.value
  sideResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { w.value = Math.min(max, Math.max(min, startW + (ev.clientX - startX))) }
  const up = () => {
    sideResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem(lib ? 'regen/libWidth' : 'regen/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 再生式体制：上行（v1）/ 下行（广播）/ 星间链路 ============
const LINK_MODES = [
  { key: 'uplink', label: '再生式上行', ready: true, tip: '地球站 → 星上再生解调；链路总 C/N = 上行 C/(N+I)' },
  { key: 'downlink', label: '再生式下行（广播）', ready: true, tip: '星上再生 → 地球站接收；链路总 C/N = 下行 C/(N+I)' },
  { key: 'isl', label: '星间链路（微波）', ready: true, tip: '发射卫星 → 接收卫星，两星微波直连；几何严格（双 SGP4 + 地球临边遮挡）；合计 C/N = 星间单跳 C/N' },
  { key: 'laser', label: '星间链路（激光）', ready: true, tip: '发射卫星 → 接收卫星，相干 DP-QPSK 激光直连；第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；给定速率 → 链路余量；完整可用度（指向抖动+建链+相干多普勒+太阳规避）' }
]
const linkMode = ref('uplink')

// ============ 再生式模式标签：用户可关闭不需要的模式（× 需确认，避免误删），随配置保存/分享；「+」可恢复 ============
// 关闭 = 隐藏该标签（当前配置范围），不删除已填参数；至少保留一个模式。
const hiddenModes = ref([])                                                          // 当前配置下被隐藏的模式 key
const visibleModes = computed(() => LINK_MODES.filter((m) => !hiddenModes.value.includes(m.key)))
const hiddenModeList = computed(() => LINK_MODES.filter((m) => hiddenModes.value.includes(m.key)))
const addMenuOpen = ref(false)
async function requestHideMode(m) {
  if (visibleModes.value.length <= 1) { toast('至少保留一个再生式模式'); return }
  if (!(await askConfirm(`关闭「${m.label}」？将从标签栏移除该模式（可点「+」恢复），已填的对应参数保留不删。`))) return
  if (!hiddenModes.value.includes(m.key)) hiddenModes.value = [...hiddenModes.value, m.key]
  if (linkMode.value === m.key) { const first = visibleModes.value[0]; if (first) linkMode.value = first.key }  // 关的是当前标签 → 切到剩下第一个
}
function restoreMode(m) {
  hiddenModes.value = hiddenModes.value.filter((k) => k !== m.key)
  addMenuOpen.value = false
  if (m && m.ready) linkMode.value = m.key                                          // 恢复即聚焦，让用户看到它回来了
}

// ============ 卫星库（全局；每颗 NGSO 式：搜索/天线树选星，无 EIRP 匹配；卫星 G/T 由发信站逐站手动输入）============
let _satSeq = 1
// nameAuto：条目名是否还随参数自动生成（见 shared/lbAutoName.js）——不传 name 即新建的空名条目，自动
// ★ v1.4.5：方向图匹配(grd)整块删除——卫星 EIRP / G·T 与星间 EIRP / G·T 一律逐行手填
//   （原因见 ngso/satTree.js 头注：三个窗口曾各按各的口径取值，同一副方向图能读出三个数）。
function makeSatConfig(name) { return withAutoFlag({ id: 'sat' + (_satSeq++), name: name || '', form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } }, 'sat') }
const satConfigs = reactive([makeSatConfig('卫星1')])
function resolveSatellite(id) {
  if (!id) return satConfigs[0]
  return satConfigs.find((c) => c.id === id) || satConfigs.find((c) => c.name === id) || satConfigs[0]
}
const satSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...satConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addSatConfig() { satConfigs.push(makeSatConfig()); syncAutoNames(satConfigs, 'sat') }
// 复制：自动命名的条目复制出来仍是自动的（名字由 syncAutoNames 按参数出，重名自动加序号）；
// 自定义名的条目才带「副本」后缀——那是用户起的名字，复制件跟着它走。
function duplicateSatConfig(cfg) {
  satConfigs.push({ id: 'sat' + (_satSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)), ngsoSat: JSON.parse(JSON.stringify(cfg.ngsoSat)) })
  syncAutoNames(satConfigs, 'sat')
}
function removeSatConfig(cfg) { removeLibEntry(satConfigs, cfg, 'sat') }
// 卫星树（星座3D 页导入的卫星）——作轨道来源
const satTree = ref(loadSatTree().sats)
function reloadSatTree() {
  try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ }
}

// ============ 载波信号库 ============
let _bbSeq = 1
function makeBasebandConfig(name) { return withAutoFlag({ id: 'bb' + (_bbSeq++), name: name || '', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null } }, 'carrier') }
const basebandConfigs = reactive([makeBasebandConfig('默认')])
const basebandOpts = ref({})
function resolveBaseband(id) {
  if (!id) return basebandConfigs[0]
  return basebandConfigs.find((c) => c.id === id) || basebandConfigs.find((c) => c.name === id) || basebandConfigs[0]
}
const basebandSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...basebandConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addBasebandConfig() { basebandConfigs.push(makeBasebandConfig()); syncAutoNames(basebandConfigs, 'carrier') }
function duplicateBasebandConfig(cfg) {
  basebandConfigs.push({ id: 'bb' + (_bbSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(basebandConfigs, 'carrier')
}
function removeBasebandConfig(cfg) { removeLibEntry(basebandConfigs, cfg, 'bb') }

// ============ 地球站库 ============
// 每份配置 = 一种站型的收发射频参数（发射链/接收链分列，再生式含逐站型干扰项，字段见 regenParams.js station 组）。
// 发/收信站表各有「地球站配置」列（stationId）选择套用哪一份：发信站取发射参数（含工作点换算所需天线/馈线/回退）、
// 收信站取接收参数（工作点 G/T 的构成量）；站表本身只留站址信息与逐站配对量（卫星G/T·EIRP）。
let _esSeq = 1
function makeEsConfig(name) { return withAutoFlag({ id: 'es' + (_esSeq++), name: name || '', form: { ...defaultsFor(ES_FIELDS) } }, 'es') }
const esConfigs = reactive([makeEsConfig('默认')])
function resolveEs(id) {
  if (!id) return esConfigs[0]
  return esConfigs.find((c) => c.id === id) || esConfigs.find((c) => c.name === id) || esConfigs[0]
}
const esSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...esConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addEsConfig() { esConfigs.push(makeEsConfig()); syncAutoNames(esConfigs, 'es') }
function duplicateEsConfig(cfg) {
  esConfigs.push({ id: 'es' + (_esSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(esConfigs, 'es')
}
function removeEsConfig(cfg) { removeLibEntry(esConfigs, cfg, 'es') }

// ============ 全局资源库（v1.4 工作台重构）============
// 地球站/卫星/载波三库脱离场景配置，全局持久化到 userData/library.json（命名空间 'regen'，三体制各自独立）。
// 场景（命名配置）只存四种模式的链路行（站址/链路量 + 各列引用的库条目 id）+ 计算策略；改库条目影响所有引用它的场景。
const LIB_NS = 'regen'

// —— 库条目删除守卫：被四种模式的链路行 / 已保存场景引用时先提示引用数 ——
function refCount(kind, id) {
  // 地面站行（发/收信站）：stationId / basebandId / satelliteId；星间行（微波/激光）：basebandId / 发·收卫星
  const hitStation = (r) => (kind === 'es' ? r.stationId === id : kind === 'bb' ? r.basebandId === id : r.satelliteId === id)
  const hitSpace = (r) => (kind === 'bb' ? r.basebandId === id : kind === 'sat' ? (r.txSatelliteId === id || r.rxSatelliteId === id) : false)
  const scan = (txArr, rxArr, islArr, laserArr) => {
    let n = 0
    for (const r of txArr || []) if (r && hitStation(r)) n++
    for (const r of rxArr || []) if (r && hitStation(r)) n++
    for (const r of islArr || []) if (r && hitSpace(r)) n++
    for (const r of laserArr || []) if (r && hitSpace(r)) n++
    return n
  }
  let n = scan(txStations, rxStations, islLinks, laserLinks)
  for (const c of configs.value) {
    const st = c && c.state
    // 旧结构场景自带内嵌库：行引用指向内嵌条目而非全局库（id 前缀相同可能撞名误报），不计入
    if (!st || !(st.v >= 2)) continue
    n += scan(st.tx, st.rx, st.isl, st.laser)
  }
  return n
}
async function removeLibEntry(arr, cfg, kind) {
  if (arr.length <= 1) return
  const n = refCount(kind, cfg.id)
  if (n > 0 && !(await askConfirm(`「${cfg.name}」正被 ${n} 处链路/场景引用，删除后这些引用将回退到库中第一份配置。确定删除？`))) return
  const idx = arr.findIndex((c) => c.id === cfg.id)
  if (idx >= 0) arr.splice(idx, 1)
}

// ngsoSat 选星态规范化（缺省=手动轨道）；legacyFolder 兼容旧配置（曾把 tree folder 存于 gtAnt.folder）
function normNgsoSat(ns, legacyFolder) {
  return ns
    ? { mode: ns.mode || 'manual', orbit: ns.orbit ? JSON.parse(JSON.stringify(ns.orbit)) : null, name: ns.name || '', noradId: ns.noradId || null, folder: ns.folder || legacyFolder || '' }
    : { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' }
}

// —— 库的载入 / 自动保存（userData/library.json，防抖整写；seq 计数器随库持久化防删后撞号）——
let _libLoaded = false
let _libT = null
function serializeLibrary() {
  return JSON.parse(JSON.stringify({
    es: esConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })),
    carrier: basebandConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })),
    sat: satConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form, ngsoSat: c.ngsoSat })),   // 选星态随条目入库
    seq: { es: _esSeq, bb: _bbSeq, sat: _satSeq }
  }))
}
const libSaveFailed = (e) => toast('资源库保存失败：' + ((e && e.message) || e))
function scheduleLibSave() {
  if (!_libLoaded || !api) return
  clearTimeout(_libT)
  _libT = setTimeout(() => { api.store.saveLibrary(LIB_NS, serializeLibrary()).catch(libSaveFailed) }, 500)
}
// 冲刷挂起的那次防抖写盘。两处必须用：① 关窗——库改动不入场景指纹（见 fingerprintOf），guardedLeave
// 拦不住它，改完 0.5 秒内关窗就丢；② 导入并库后——configs.json 里的新配置引用的正是这批条目，
// 反了顺序则中途关窗后引用解析不到，会静默回退到库里第一份配置。
async function flushLibSave() {
  if (!_libLoaded || !api) return
  await nextTick()   // 让 watch 里的 syncAutoNames 先跑完，落盘的名字与屏幕上的一致
  clearTimeout(_libT); _libT = null
  try { await api.store.saveLibrary(LIB_NS, serializeLibrary()) } catch (e) { libSaveFailed(e) }
}
// 干扰(地球站→卫星) 归属调整的一次性迁移：干扰八项从地球站库迁回「卫星群」（与 GSO/NGSO 一致）。
// 就着旧库 es[0].form 里被移走的「孤儿键」搬运到各卫星条目，保留用户自定义值（须在按新字段集补默认值之前跑；
// 已迁移过的库因目标键非空而幂等跳过）。
const _MIG_INTF_KEYS = ['aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor', 'aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor', 'xpdrIntermodFactor']
function pickIntf(form) { const o = {}; if (form) for (const k of _MIG_INTF_KEYS) if (form[k] != null) o[k] = form[k]; return o }
function migrateRegenIntfLib(lib) {
  const es0 = lib.es && lib.es[0] && lib.es[0].form
  if (es0 && Array.isArray(lib.sat)) for (const c of lib.sat) {
    if (!c || !c.form) continue
    for (const k of _MIG_INTF_KEYS) if (c.form[k] == null && es0[k] != null) c.form[k] = es0[k]
  }
}
function applyLibrary(lib) {
  if (!lib) return
  migrateRegenIntfLib(lib)   // 结构迁移（干扰上移卫星），保留旧库自定义值；须在补默认值前
  // nameAuto：旧库没存过这一位，按历史默认名推定一次（见 shared/lbAutoName.js 的 adoptAutoFlag）
  if (Array.isArray(lib.es) && lib.es.length) esConfigs.splice(0, esConfigs.length, ...lib.es.map((c, i) => ({ id: c.id || ('esb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('es', c), form: { ...defaultsFor(ES_FIELDS), ...c.form } })))
  if (Array.isArray(lib.carrier) && lib.carrier.length) basebandConfigs.splice(0, basebandConfigs.length, ...lib.carrier.map((c, i) => ({ id: c.id || ('bbb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('carrier', c), form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null, ...c.form } })))
  if (Array.isArray(lib.sat) && lib.sat.length) satConfigs.splice(0, satConfigs.length, ...lib.sat.map((c, i) => ({ id: c.id || ('satb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('sat', c), form: { ...defaultsFor(SAT_FIELDS), ...c.form }, ngsoSat: normNgsoSat(c.ngsoSat) })))
  syncAutoNames(esConfigs, 'es'); syncAutoNames(basebandConfigs, 'carrier'); syncAutoNames(satConfigs, 'sat')
  if (lib.seq) { _esSeq = Math.max(_esSeq, lib.seq.es || 1); _bbSeq = Math.max(_bbSeq, lib.seq.bb || 1); _satSeq = Math.max(_satSeq, lib.seq.sat || 1) }
  // 兜底回抬序号：防旧库无 seq 时新建条目撞已有 id
  for (const [arr, re, bump] of [[esConfigs, /^es(\d+)$/, (n) => { _esSeq = Math.max(_esSeq, n + 1) }], [basebandConfigs, /^bb(\d+)$/, (n) => { _bbSeq = Math.max(_bbSeq, n + 1) }], [satConfigs, /^sat(\d+)$/, (n) => { _satSeq = Math.max(_satSeq, n + 1) }]]) {
    for (const c of arr) { const m = re.exec(c.id || ''); if (m) bump(Number(m[1])) }
  }
}
// 库一动就：① 未被改名的条目按新参数刷名（幂等，重算一遍就收敛）② 防抖落盘
watch([esConfigs, basebandConfigs, satConfigs], () => {
  syncAutoNames(esConfigs, 'es'); syncAutoNames(basebandConfigs, 'carrier'); syncAutoNames(satConfigs, 'sat')
  scheduleLibSave()
}, { deep: true, immediate: true })   // immediate：内置默认库（还没载入盘上库时）也先按参数刷一遍名

// —— 内容去重并库（旧配置迁移 / 分享导入共用）：同内容复用既有条目 id，异内容新建（名称冲突自动加序号）。
// 返回 旧id→全局id 映射。两次对同一份旧配置执行得到相同映射（第二次全部命中内容去重）→ 指纹稳定。
// extraKeys：form 之外一并纳入指纹与拷贝的键（卫星条目的 ngsoSat 选星态——同参数不同选星是两颗不同的星）。
function adoptEntries(arr, entries, makeNew, extraKeys = []) {
  const map = {}
  if (!Array.isArray(entries)) return map
  const names = () => new Set(arr.map((c) => c.name))
  const fpOf = (e) => stableStringify([e.form, ...extraKeys.map((k) => (e[k] === undefined ? null : e[k]))])
  for (const e of entries) {
    if (!e || !e.form) continue
    const fp = fpOf(e)
    const hit = arr.find((c) => fpOf(c) === fp)
    if (hit) { map[e.id] = hit.id; continue }
    const c = makeNew()
    let nm = e.name || c.name
    if (names().has(nm)) { let i = 2; while (names().has(nm + ' ' + i)) i++; nm = nm + ' ' + i }
    c.name = nm
    // 并进来的名字是别处的数据，一律钉成自定义（除非对方明确标了「自动」）：不替别人的库改名
    c.nameAuto = e.nameAuto === true
    c.form = { ...c.form, ...JSON.parse(JSON.stringify(e.form)) }
    for (const k of extraKeys) if (e[k] !== undefined) c[k] = JSON.parse(JSON.stringify(e[k]))
    arr.push(c)
    map[e.id] = c.id
  }
  return map
}

// ============ 发信站群 ============
let _sid = 1
const newStation = (fields) => { const r = defaultsFor(fields); r._id = 's' + (_sid++); return r }
const txStations = reactive([newStation(TX_FIELDS)])

// 工作点（功放功率）已随站型移入「地球站配置」发射参数（opPowerW）：给定功放功率 → 引擎 power 模式算上行余量。
// 原「工作点列 EIRP⇄W 切换」随之退役——EIRP 仍可在结果指标「地球站 EIRP」查看。

// —— 计算方式 ——（enLabel 供导出报告选英文时用）
// 求解策略随载波入库（资源库「载波」条目的 calcMode / margin，见 regenParams.js CARRIER_FIELDS），
// 逐行按该行所选载波取用。再生式上下行解耦、无转发器功带之分，故只有两种；工作点仍是硬件属性
// （上行＝发信站功放功率 opPowerW，下行＝收信站天线/噪温算出的 G/T），留在地球站库。
// 星间/激光链路不受此约束：其工作点由链路自身参数给定（见 computeIsl / computeLaser）。
const CALC_MODES = [
  { key: 'power', label: '设置工作点', enLabel: 'Fixed Operating Point' },
  { key: 'margin', label: '设置余量', enLabel: 'Fixed Margin' }
]
const calcModeOf = (bbForm) => ((bbForm && bbForm.calcMode) === 'margin' ? 'margin' : 'power')

// ============ 收信站群（再生式下行）============
// 工作点 G/T 恒由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算得
// （不再支持「直接输入设备 G/T」——设备 G/T 系统噪温未知，无法自洽推出雨致 G/T 劣化）。
const rxStations = reactive([newStation(RX_FIELDS)])
// 收信站 G/T 只读列：随天线/噪温/馈线 + 所选卫星下行频率实时算出的晴空 G/T（与引擎 gOverTe 同口径），
// 让用户编辑参数时即时看到 G/T，无需先计算。传给 StationGrid 的 ro-values（{ _id: 值 }）。
const rxGtValues = computed(() => {
  const m = {}
  for (const rx of rxStations) {
    const sat = resolveSatellite(rx.satelliteId)
    const gt = sat ? rxGtFromNoise(resolveEs(rx.stationId).form, sat.form) : NaN   // 接收链参数取自该站所选地球站配置
    m[rx._id] = isFinite(gt) ? (Math.round(gt * 100) / 100).toFixed(2) : ''
  }
  return m
})
// 链路表「地球站配置」格第二行小字（与 GSO/NGSO 一致）：发信站群显示实时 EIRP、收信站群显示实时 G/T。
// EIRP = 工作点功放 powerWToEirp（取该行所选卫星的上行频率）；G/T 复用 rxGtValues（替代原末列 ro-label 列）。
const txCellSub = (f, row) => {
  if (f.key !== 'stationId') return null
  const sat = resolveSatellite(row.satelliteId)
  const eirp = powerWToEirp(resolveEs(row.stationId).form.opPowerW, resolveEs(row.stationId).form, sat ? sat.form : {})
  return isFinite(eirp) ? `EIRP ${eirp.toFixed(2)} dBW` : null
}
// 「地球站配置」格内行内尾标：发信站配置名之后贴该站算出的功放功率（就在第二行 EIRP 之上）。只给发信站——
// 功放是发射链的量，收信站那格没有它。库里那一项是「功放功率预设」，这里是引擎按该站几何/载波解出的
// paRecommendation（含回退的功放输出）：计算方式=设置功放功率时二者相等，=设置余量时报本链路真正需要的功率。
// 与 GSO/NGSO 的差别：再生式上行几何要跑 SGP4 最差互视，太贵故不做逐键实时——此值随「计算」更新
// （输入再改会亮「输入已变」，与结果列同一口径）。
const txCellTag = (f, row) => {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const w = m ? parseFloat(m._paW) : NaN
  // 取 4 位有效数字：尾标是一眼扫过的读数，引擎原串的 0.200 在这里读作「200 mW」（精确值看结果列/瀑布）
  return isFinite(w) ? fmtQty(Number(w.toPrecision(4)), 'W') : null
}
const rxCellSub = (f, row) => {
  if (f.key !== 'stationId') return null
  const v = rxGtValues.value[row._id]
  return (v != null && v !== '') ? `G/T ${v} dB/K` : null
}

// ============ 星间链路群（再生式微波 ISL）============
const islLinks = reactive([newStation(ISL_FIELDS)])
// ============ 星间激光链路群（再生式激光 / 相干 DP-QPSK）============
const laserLinks = reactive([newStation(LASER_FIELDS)])

// 某卫星配置 → 轨道来源 spec（选星→真实星历；未选→手动圆轨道）。上/下/星间共用。
function orbitSpecOf(sat) {
  const ns = sat && sat.ngsoSat
  const selectedStar = ns && ns.mode !== 'manual' && ns.orbit
  return selectedStar ? JSON.parse(JSON.stringify(ns.orbit))
    : { type: 'circular', altKm: pf(sat.form.orbitAltitude) || 0, inclDeg: pf(sat.form.orbitInclination) || 0 }
}
// 搜索时窗起点 t0：不再锚各星 TLE/场景历元，一律锚到「计算此刻」的墙钟绝对时（用户口径「从当前时间开始」扫描）。
// 每次计算前取一次、整批共用 → 同一张表内上下行/星间各行起点严格一致；轨道仍按 SGP4 从各自历元正推到该时刻（同属墙钟系）。
function searchT0ISO() { return new Date().toISOString() }
// 手动几何：星间距离是用户给的一个数，没有轨道也就没有两星高度/掠地高度/多普勒/互视占比。
// 只把这个数与由它直接导出的单程时延写进结果，其余几何量一律不写（不拿占位数冒充几何）。
// ★ 可用度必须清掉：星间可用度的唯一来源是互视占比，手动几何没有它——留着的话，微波侧会漏出
//   上下行占位入参算出的雨衰可用度、激光侧会漏出「visPct 缺省 → 100%」，两个都是凭空的数。
function clearIslAvailability(d) {
  d.systemAvailabilityResult = ''; d.uplinkAvailabilityResult = ''; d.downlinkAvailabilityResult = ''
  d.interruptionMinutes = ''; d.interruptionHours = ''
  d.islVisibleFracResult = ''; d.laserVisibleFracResult = ''
}
function mergeIslManualDistance(d, distKm) {
  d.islRfDistResult = distKm.toFixed(1)
  d.islDelayResult = (distKm / 299792.458 * 1000).toFixed(2)
  d.islManualGeomResult = '1'   // 瀑布据此把「星间几何（最差工况）」段改称「星间距离（手动给定）」
  clearIslAvailability(d)
}
// 激光同理（距离另有 laserDistResult 一份；多普勒需要距离变化率，手动几何没有 → 清空）
function mergeLaserManualDistance(d, distKm) {
  mergeIslManualDistance(d, distKm)
  d.laserDistResult = distKm.toFixed(1)
  d.laserDopplerResult = ''
}
// 把两星几何最差工况量注入结果对象，供瀑布「星间几何」段与结果卡展示
function mergeIslGeometry(d, geo) {
  const w = geo.worst
  d.islRfDistResult = w.rangeKm.toFixed(1)   // 覆盖引擎默认距离展示为几何最差距离
  d.islTxAltResult = w.txAltKm.toFixed(1)
  d.islRxAltResult = w.rxAltKm.toFixed(1)
  d.islCentralAngleResult = w.centralAngleDeg.toFixed(2)
  d.islGrazAltResult = w.grazAltKm.toFixed(1)
  d.islDelayResult = w.oneWayDelayMs.toFixed(2)
  d.islRangeRateResult = w.rangeRateKmS.toFixed(4)
  d.islDopplerResult = (w.maxDopplerHz / 1000).toFixed(2)
  d.islVisibleFracResult = (geo.visibility.visibleFrac * 100).toFixed(2)
}
// 激光星间几何注入（复用 ISL 几何字段：瀑布/结果卡共用；多普勒此时为光频 Δf，单位 GHz）
function mergeLaserGeometry(d, geo) {
  const w = geo.worst
  d.islRfDistResult = w.rangeKm.toFixed(1)
  d.islTxAltResult = w.txAltKm.toFixed(1)
  d.islRxAltResult = w.rxAltKm.toFixed(1)
  d.islCentralAngleResult = w.centralAngleDeg.toFixed(2)
  d.islGrazAltResult = w.grazAltKm.toFixed(1)
  d.islDelayResult = w.oneWayDelayMs.toFixed(2)
  d.islRangeRateResult = w.rangeRateKmS.toFixed(4)
  d.laserDistResult = w.rangeKm.toFixed(1)              // 覆盖引擎占位距离 → 几何最差距离
  d.islVisibleFracResult = (geo.visibility.visibleFrac * 100).toFixed(2)
}

// 顶栏「刷新」：重新拉取主窗口的最新设置（卫星/天线树 + 城市库/载波信号选项）。
// 与 GEO refreshLatest 同口径（去掉 GEO 特有的实时星位/只读 EIRP·G·T 扇出）。
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  try {
    reloadSatTree()   // 重读星座3D 页的卫星树（作轨道来源）
    try { const c = api && await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    toast('已刷新最新设置')
  } finally { refreshing.value = false }
}

const LIB_TABS = [
  { key: 'station', label: '地球站', tip: '站型收发射频参数库（发射链含再生工作点）：站表「地球站配置」列按行引用' },
  { key: 'sat', label: '卫星群', tip: '卫星库：每颗一份（选星定轨 / 手动轨道），链路表「卫星 / 发射·接收卫星」列按行引用' },
  { key: 'carrier', label: '载波', tip: '载波信号库：链路表「载波信号配置」列按行引用' }
]
const libTab = ref('station')
const flowEl = ref(null)
// 资源库主从视图的当前选中项（会话态，不入存档）
const selBbId = ref('')
const selEsId = ref('')
const selSatId = ref('')
// 站表/链路表库引用列（载波信号配置 / 地球站配置 / 卫星）格内「编辑参数」钮的去处：
// 展开资源库侧栏、切到对应子栏并选中该条目。id 留空即由资源库自行落到首份配置（与引擎「空→第一份」一致）。
function editInLibrary(kind, id) {
  sideView.value = 'library'
  libTab.value = kind
  if (kind === 'sat') selSatId.value = id || ''
  else if (kind === 'station') selEsId.value = id || ''
  else if (kind === 'carrier') selBbId.value = id || ''
}
// 注：地球站库编辑器曾在发射/接收标题右端显示 EIRP / G·T 预览，已删——频率在卫星群，一份站型配置不再自含
// 算这两个量所需的全部输入（预览得挑第一份卫星当基准，反而误导）。站表「地球站配置」格下的第二行小字仍按
// 该行所选卫星显示实时 EIRP / G·T（见 txCellSub / rxCellSub）。
// 列表摘要：自动命名的条目其名字就是这几项参数（见 lbAutoName），再报一遍纯属重影 → 只给自定义名的条目报
const bbSummary = (c) => (isAutoNamed('carrier', c) ? '' : `${c.form.modulation || 'QPSK'} ${c.form.fec || '3/4'} · ${c.form.infoRate || '2048'} kbps`)
// 摘要 = 口径 · 功放（这两项定性一份站型，与配置面板顶部主参数条一致；GSO/NGSO 同口径，其功放键名为 paPowerW）。
// 自动名只有口径（见 lbAutoName），功放不进名字 → 摘要照报功放，口径只给自定义名的条目补。
const esSummary = (c) => [isAutoNamed('es', c) ? '' : `${c.form.antennaDiameter || '2.4'} m`, c.form.opPowerW ? `功放预设 ${c.form.opPowerW} W` : ''].filter(Boolean).join(' · ')
// 自动名只有星名（见 lbAutoName），频段与轨道不再进名字 → 摘要一律报轨道来源与高度倾角，与名字不重影
const satSummary = (c) => [
  c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : '',
  (c.ngsoSat && c.ngsoSat.mode !== 'manual' && c.ngsoSat.orbit) ? '选星定轨' : '手动轨道',
  `h=${c.form.orbitAltitude || '?'} km · i=${c.form.orbitInclination || '?'}°`
].filter(Boolean).join(' · ')
// 切换体制：只显示该模式的表格分区。上/下行/星间各口径的链路条数与结果列都不同，旧体制的结果
// 不再适用——切换即清空（含表格结果列映射），避免「上行结果套着下行列头」的串味显示。
watch(linkMode, () => {
  nextTick(() => { const el = flowEl.value; if (el) el.scrollTop = 0 })
  links.value = []; selected.value = 0; segments.value = []; error.value = ''
  computedVals.value = {}
  rawDataByRow.value = {}   // 自定义列留底同步清：旧模式的引擎结果不许穿到新模式的自定义列上
})

// ============ 几何搜索时窗（选星 SGP4 典型时刻 + 全部访问窗口）============
const geoHorizonHours = ref(Number(localStorage.getItem('regen/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('regen/horizonHours', String(v)) } catch (e) { /* ignore */ } })
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 120, l: '5 天' }, { v: 168, l: '7 天' }, { v: 336, l: '14 天' }, { v: 720, l: '30 天' }]

// —— 几何模式（场景级，随场景存档；默认手动。四种体制统一受此开关约束：上/下行的站星几何 +
//    星间/激光的两星几何）——
//   'manual' 纯手动（默认）：仰角与斜距都由站表逐行给定，软件不解算任何轨道关系（也就没有 t*、
//            没有过境窗口、没有 §8 仰角分布）。两个数直接送进引擎的 slantRange 模式。
//            斜距不用手敲——换卫星即按新轨道高度算出推荐值填进去（见 refreshSlant），改不改由用户。
//            星间/激光同理：不选卫星，星间距离由链路表的 islRangeKm 逐条给定（可用「距离工具」按两星
//            轨道在时间轴上算出来再填），没有互视可见度/多普勒/访问窗口 → 可用度也随之留空。
//   'auto'   自动最差工况：按卫星轨道解最差几何，仰角字段作【门限】，斜距由求解器给出；
//            星间/激光按两星轨道解最差星间距离与互视可见度。
// 旧场景（无此字段）载入时回到 'auto'——它们的结果本就是那样算出来的，不静默改口径。
const GEO_MODES = [{ v: 'manual', l: '手动' }, { v: 'auto', l: '自动最差' }]
const geoMode = ref(localStorage.getItem('regen/geoMode') === 'auto' ? 'auto' : 'manual')
watch(geoMode, (v) => { try { localStorage.setItem('regen/geoMode', v) } catch (e) { /* ignore */ } })
const geoManual = computed(() => geoMode.value === 'manual')
// 手动几何注入：斜距/仰角照抄单元格；轨道高度顺带按二者反算成【等效值】覆盖进去——引擎在
// slantRange 模式下不用它，但链路视图与几何读数会去读，不覆盖就会拿卫星条目里那个对不上的高度画图。
// 再生式一条链路只有一侧是真的（上行走 up、下行走 dn），另一侧是让弯管引擎良定的镜像占位，故两侧同值。
function applyManualGeom(lp, slantKm, elevDeg) {
  const d = pf(slantKm), e = pf(elevDeg) || 0
  lp.distanceMode = 'slantRange'; lp.slantRange = d; lp.minElevation = e
  lp.rxDistanceMode = 'slantRange'; lp.rxSlantRange = d; lp.rxMinElevation = e
  const h = altFromSlant(d, e)
  if (h != null) { lp.orbitAltitude = h; lp.rxOrbitAltitude = h }
}

// ============ 计算结果（每个发信站一条上行链路）============
const links = shallowRef([])  // [{ ti, txName, satName, data, geom, access, margin, powerW, ok, error }]
const METRIC_OPTIONS_UP = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'paRecommendation', label: '功放功率 (W)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'carrierTotalCN', label: '上行 C/N (dB)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
  { key: 'allocBandwidthResult', label: '载波带宽 (kHz)' },
  { key: 'stationEIRPResult', label: '地球站 EIRP (dBW)' },
  { key: 'stationPSDResult', label: '功率谱密度 (dBW/Hz)' }
]
const METRIC_OPTIONS_DN = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'gOverTeResult', label: '收信站 G/T (dB/K)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'carrierTotalCN', label: '下行 C/N (dB)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
  { key: 'allocBandwidthResult', label: '载波带宽 (kHz)' },
  { key: 'satellitePSDResult', label: '卫星功率谱密度 (dBW/Hz)' },
  { key: 'arrivalPFDAtGroundResult', label: '到达地面 PFD (dBW/m²)' }
]
const METRIC_OPTIONS_ISL = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'carrierTotalCN', label: '星间 C/N (dB)' },
  { key: 'islRfDistResult', label: '星间距离 (km)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
  { key: 'allocBandwidthResult', label: '载波带宽 (kHz)' },
  { key: 'islRfEirpResult', label: '发射 EIRP (dBW)' },
  { key: 'islVisibleFracResult', label: '互视可见度 (%)' }
]
const METRIC_OPTIONS_LASER = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'laserPrxResult', label: '接收光功率 (dBm)' },
  { key: 'laserPreqResult', label: '所需接收功率 (dBm)' },
  { key: 'laserFslResult', label: '自由空间损耗 (dB)' },
  { key: 'laserGTxResult', label: '发射增益 (dBi)' },
  { key: 'laserDistResult', label: '星间距离 (km)' },
  { key: 'laserDopplerResult', label: '相干多普勒 (GHz)' },
  { key: 'islVisibleFracResult', label: '互视可见度 (%)' },
  { key: 'systemAvailabilityResult', label: '系统可用度 (%)' }
]
// ============ 表格内计算结果列（只读列组，表头可勾选）============
// 以各模式结果指标（METRIC_OPTIONS_*）为基础；key 与引擎结果字段同名（容量为派生指标）。
// 纯数字口径：不设文字判定列。勾选集按模式分别持久化（localStorage 'regen/resultCols.<模式>'，视图态不入场景配置）。
function parseMetricLabel(label) { const m = /^(.*?)\s*\(([^)]+)\)$/.exec(label || ''); return m ? { title: m[1], unit: m[2] } : { title: label || '', unit: '' } }
const mkResultDefs = (opts) =>
  opts.map((o) => { const { title, unit } = parseMetricLabel(o.label); return { key: o.key, label: title, unit } })
const RESULT_DEFS_BY = {
  uplink: mkResultDefs(METRIC_OPTIONS_UP),
  downlink: mkResultDefs(METRIC_OPTIONS_DN),
  isl: mkResultDefs(METRIC_OPTIONS_ISL),
  laser: mkResultDefs(METRIC_OPTIONS_LASER)
}
const DEFAULT_RESULT_KEYS = {
  uplink: ['linkmargin', 'paRecommendation', 'carrierTotalCN', 'capacityMbps'],
  downlink: ['linkmargin', 'gOverTeResult', 'carrierTotalCN', 'capacityMbps'],
  isl: ['linkmargin', 'carrierTotalCN', 'islRfDistResult', 'islVisibleFracResult'],
  laser: ['linkmargin', 'laserPrxResult', 'laserPreqResult', 'laserDistResult']
}
const resultKeys = reactive(Object.fromEntries(LINK_MODES.map((m) => {
  try { const v = JSON.parse(localStorage.getItem('regen/resultCols.' + m.key) || ''); return [m.key, Array.isArray(v) && v.length ? v : DEFAULT_RESULT_KEYS[m.key].slice()] }
  catch (e) { return [m.key, DEFAULT_RESULT_KEYS[m.key].slice()] }
})))
watch(resultKeys, () => { try { for (const m of LINK_MODES) localStorage.setItem('regen/resultCols.' + m.key, JSON.stringify(resultKeys[m.key])) } catch (e) { /* ignore */ } }, { deep: true })
const colPickOpen = ref(false)
// 面板打开期间拦滚轮：面板内滚到边界即止（遮罩上另行全拦）。否则滚轮默认动作沿 DOM 链滚动底下的
// 分节流，页面在遮罩下乱滚、面板随宿主节头滚出视野。
function onColPickWheel(e) {
  const el = e.currentTarget
  const canScroll = e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
  if (!canScroll) e.preventDefault()
}
const curResultDefs = computed(() => RESULT_DEFS_BY[linkMode.value] || [])
// 勾选/取消结果列（保持声明序，避免列序随点击顺序漂移）
function toggleResultKey(k) {
  const mode = linkMode.value
  const cur = resultKeys[mode]
  if (cur.includes(k)) resultKeys[mode] = cur.filter((x) => x !== k)
  else resultKeys[mode] = RESULT_DEFS_BY[mode].map((d) => d.key).filter((x) => x === k || cur.includes(x))
}
// 各模式表格列 = 输入列 + 已勾选结果列（计算列 ro:true，值走 computedVals 映射，不写行数据）。
// 结果列显示单位自适应：每次计算按整列最大|值|共选档位（W→mW、kHz→MHz、全列<0dBW→dBm），
// 列头单位跟随（resColUnits 按 '模式:键' 记录）；写入 computedVals 的值已按所选档位换算
const resColUnits = reactive({})
const resColsOf = (mode) => [
  ...RESULT_DEFS_BY[mode]
    .filter((d) => resultKeys[mode].includes(d.key))
    .map((d) => ({ key: '_' + d.key, label: d.label, unit: resColUnits[mode + ':' + d.key] || d.unit, type: d.type === 'text' ? 'text' : 'num', ro: true, group: 'res', target: 'meta', tip: d.tip || d.label })),
  ...customFieldDefs(customColsBy[mode], customPoolOf(mode))
]
// —— 自定义列（公式把引擎出参组合成新列，语法与求值见 shared/lbCustomCols.js；按子链路模式各存一份）——
// 定义按窗口记忆（localStorage），不入场景配置——口径同结果列勾选集；值由 writeResultVals 留底的
// 引擎结果即时求出，新建/改公式即刻回填，无需重算。
// 字段池按【本模式实际算出的键】过滤：lbOutputDefs 那张表是 GSO/NGSO 口径的超集，再生式
// （尤其星间/激光）大半键根本不出——不过滤会端出一池死字段。算过之前只有本模式结果列池；
// 算过之后 = 结果列∩出参 + 可绘清单∩出参 + 其余全部数值出参（「全部出参」组，label=键名）。
// 求值解析器逐模式建，与编辑器字段池同口径（isl/laser 的「星间距离」同名不同键，合并池会歧义判死）。
const customColsBy = reactive(Object.fromEntries(LINK_MODES.map((m) => [m.key, loadDefs('regen/customCols.' + m.key)])))
watch(customColsBy, () => { try { for (const m of LINK_MODES) saveDefs('regen/customCols.' + m.key, customColsBy[m.key]) } catch (e) { /* ignore */ } }, { deep: true })
const customOutputPool = ref([])
onMounted(async () => {
  try {
    if (api) {
      const g = await api.linkBudget.outputDefs()
      // 站址地理量组（siteRainRate/siteAltitude）是参数扫描的注入量，引擎结果里不存在，不进池
      customOutputPool.value = (g || []).flatMap((x) => (x.items || []).map((it) => ({ key: it.key, label: it.label, unit: it.unit, group: x.title })))
        .filter((it) => it.key !== 'siteRainRate' && it.key !== 'siteAltitude')
    }
  } catch (e) { /* 取不到就只用结果列池 */ }
})
// 引擎结果按行留底（writeResultVals 顺手写入；切模式清空见 watch(linkMode)）
const rawDataByRow = ref({})
const ccRowsOf = (mode) => (mode === 'laser' ? laserLinks : mode === 'isl' ? islLinks : mode === 'downlink' ? rxStations : txStations)
// 输入参数池的策展清单（不倒整包入参对象，只收 schema 声明的数值字段）：按面板逻辑分组，
// ES 收发共用字段拆两侧；具体模式用不到的组由 schema ∩ 入参样本自然滤空
const CC_INPUT_SPECS = [
  { fields: SAT_FIELDS, group: '输入 · 卫星' },
  { fields: CARRIER_FIELDS, group: '输入 · 载波' },
  { fields: TX_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: ES_TX_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: ES_COMMON_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: RX_FIELDS, group: '输入 · 收信站', side: 'rx' },
  { fields: ES_RX_FIELDS, group: '输入 · 收信站', side: 'rx' },
  { fields: ES_COMMON_FIELDS, group: '输入 · 收信站', side: 'rx', useRxKey: true },
  { fields: ISL_FIELDS, group: '输入 · 星间链路' },
  { fields: LASER_FIELDS, group: '输入 · 激光链路' }
]
const ccInputsOfRow = (rowId) => { const p = sweepParamsByRow.value[rowId]; return p ? { ...(p.linkParams || null), ...(p.satParams || null) } : null }
// 求值/预览用的行数据：输入参数打底、引擎出参盖上（同名键出参优先；激光模式不留底入参则只有出参）
const ccRowDataOf = (rowId) => { const d = rawDataByRow.value[rowId]; if (!d) return null; const inp = ccInputsOfRow(rowId); return inp ? { ...inp, ...d } : d }
const customPoolOf = (mode) => {
  // 结果列组沿用【词表】的名字与单位：同一个量在两个组里叫两个名字（功放建议/功放建议功率）
  // 会让人以为是两个量，且裸标签一歧义就报「未知字段」。词表是命名权威，表头短名只用于链路表列头。
  const base = RESULT_DEFS_BY[mode].filter((d) => d.key !== 'capacityMbps').map((d) => { const t = RESULT_LABELS[d.key]; return { key: d.key, label: t ? t.label : d.label, unit: t ? t.unit : d.unit, group: '结果列' } })
  const rows = ccRowsOf(mode).filter((r) => rawDataByRow.value[r._id])
  if (!rows.length) return buildPool(base)
  // 键取全部行的并集：逐行出参可不同（0 雨强行的 XPD 出 '-'），单行样本会误滤别行的合法键。
  // berResult 是 "1×10⁻⁷" 形式，parseFloat 得 1 是错值，恒剔除。
  const keySet = new Set()
  for (const r of rows) {
    const d = rawDataByRow.value[r._id]
    for (const k of Object.keys(d)) {
      if (k !== 'berResult' && typeof d[k] !== 'object' && Number.isFinite(parseFloat(d[k]))) keySet.add(k)
    }
  }
  return buildPool(
    base.filter((it) => keySet.has(it.key)),
    customOutputPool.value.filter((it) => keySet.has(it.key)),
    schemaInputPool(CC_INPUT_SPECS, ccInputsOfRow(rows[0]._id)),
    labeledResultPool(keySet),   // 全量词表：出参一律有中文名与单位（含 ISL/激光族，见 shared/lbResultLabels.js）
    // 词表没收录的键才落裸键名——测试钉死三体制 100% 收录，正常情况下这一组是空的
    [...keySet].sort().map((k) => ({ key: k, label: k, unit: '', group: '未命名出参' }))
  )
}
const customPool = computed(() => customPoolOf(linkMode.value))
const customResolveOf = (mode) => makeResolver(customPoolOf(mode))
const customVals = computed(() => {
  const out = {}
  for (const m of LINK_MODES) {
    const defs = (customColsBy[m.key] || []).filter((c) => c.on !== false)
    if (!defs.length) continue
    Object.assign(out, evalRows(defs, ccRowsOf(m.key).map((r) => ({ id: r._id, data: ccRowDataOf(r._id) })), customResolveOf(m.key), customPoolOf(m.key)))
  }
  return out
})
// 编辑器实时预览：优先当前聚焦行，没有就取本模式第一条有结果的行
function ccPreview(expr, dp) {
  const mode = linkMode.value
  const rows = ccRowsOf(mode)
  const row = rows.find((r) => r._id === focusRowId.value && rawDataByRow.value[r._id]) || rows.find((r) => rawDataByRow.value[r._id]) || null
  if (!row) return null
  const v = evalRows([{ id: 'p', expr, dp }], [{ id: 'p', data: ccRowDataOf(row._id) }], customResolveOf(mode), customPoolOf(mode))
  return v.p && v.p._cp !== '—' ? v.p._cp : null
}
// 弹窗开关与下拉里的勾选（下拉只负责选，建在独立弹窗——写公式费时间，不能点外即丢）
const ccDlgOpen = ref(false)
const toggleCustomCol = (id) => { const m = linkMode.value; customColsBy[m] = (customColsBy[m] || []).map((c) => (c.id === id ? { ...c, on: c.on === false } : c)) }
const ccUnit = (c) => unitOf(c, customPool.value)
// 表格取值 = 内置结果列(computedVals) + 自定义列(customVals) 合流
const gridVals = computed(() => {
  if (!LINK_MODES.some((m) => (customColsBy[m.key] || []).some((c) => c.on !== false))) return computedVals.value
  const out = { ...computedVals.value }
  for (const [id, patch] of Object.entries(customVals.value)) out[id] = { ...(out[id] || null), ...patch }
  return out
})
// —— 列组（排版更符合逻辑）：配置引用 / 站址 / 链路参数 / 计算结果。字段按 key 归组（结果列已带 group:'res'）——
const _STN_GROUP = { basebandId: 'ref', stationId: 'ref', satelliteId: 'ref',
  earthStationLocation: 'geo', longitude: 'geo', latitude: 'geo', minElevation: 'geo', slantRange: 'geo', altitude: 'geo',
  rxEarthStationLocation: 'geo', rxLongitude: 'geo', rxLatitude: 'geo', rxMinElevation: 'geo', rxSlantRange: 'geo', rxAltitude: 'geo',
  rainRate: 'link', uplinkAvailability: 'link', G_Ts: 'link',
  rxRainRate: 'link', rxDownlinkAvailability: 'link', rxEIRP: 'link' }
// 收信站群另一份归组：「地球站配置」并入站址组（列序上它已排在站址组之首，见 regenParams 的 downlink 组）
// ——下行的地球站配置＝这座收信站的站型（口径/噪温/馈线），与站址同属「这座站」；发信站群那份还带工作点
// （功放功率），是链路的激励源，仍留在配置组。
const _RX_GROUP = { ..._STN_GROUP, stationId: 'geo' }
const _ISL_GROUP = { basebandId: 'ref', txSatelliteId: 'ref', rxSatelliteId: 'ref' }   // 其余（EIRP/GT/频率/损耗…）默认归 'link'
const _tagGroup = (map, def) => (f) => ({ ...f, group: map[f.key] || def })
// 几何=手动：多出「斜距」列，仰角列改称「仰角」（此时它就是本条链路的仰角，不再是最差工况的门限）；
// 几何=自动最差：斜距由求解器给出，不占列。
// 星间/激光两张表同一套开关：手动只留「星间链路距离」（manualOnly），自动才有两颗卫星与大气余量/
// 最大工作距离（autoOnly）——那三项都是解算轨道才用得上的量。
function _geoCols(fields) {
  return fields.filter((f) => (f.manualOnly ? geoManual.value : (f.autoOnly ? !geoManual.value : true)))
    .map((f) => ((geoManual.value && f.manualLabel) ? { ...f, label: f.manualLabel, tip: f.manualTip || f.tip } : f))
}
const GROUPS_STATION = [{ key: 'ref', label: '配置' }, { key: 'geo', label: '站址' }, { key: 'link', label: '链路' }, { key: 'res', label: '计算结果' }]
const GROUPS_ISL = [{ key: 'ref', label: '配置' }, { key: 'link', label: '星间参数' }, { key: 'res', label: '计算结果' }]
const GROUPS_LASER = [{ key: 'ref', label: '配置' }, { key: 'link', label: '激光参数' }, { key: 'res', label: '计算结果' }]
const txGridFields = computed(() => [..._geoCols(TX_FIELDS).map(_tagGroup(_STN_GROUP, 'link')), ...resColsOf('uplink')])
const rxGridFields = computed(() => [..._geoCols(RX_FIELDS).map(_tagGroup(_RX_GROUP, 'link')), ...resColsOf('downlink')])
const islGridFields = computed(() => [..._geoCols(ISL_FIELDS).map(_tagGroup(_ISL_GROUP, 'link')), ...resColsOf('isl')])
const laserGridFields = computed(() => [..._geoCols(LASER_FIELDS).map(_tagGroup(_ISL_GROUP, 'link')), ...resColsOf('laser')])
// 计算列取值映射 { 行_id: { _键: 值 } }：结果不写行数据 → 写回不惊动存档/脏检/过期 watcher
const computedVals = ref({})
function setVals(id, patch) { computedVals.value = { ...computedVals.value, [id]: { ...(computedVals.value[id] || null), ...patch } } }
// 结果单元格着色：负余量标红（纯数字口径，不设文字判定列）
function cellClassFn(f, row) {
  if (!f.ro) return null
  const m = computedVals.value[row._id]
  if (!m) return null
  if (f.key === '_linkmargin') { const v = parseFloat(m._linkmargin); return isFinite(v) && v < 0 ? 'st-bad' : null }
  return null
}
// compute 后把该模式全量结果指标写入 computedVals（含未勾选列：事后勾选新列即刻可见，无需重算）。
// 写入前按整列共选显示单位（见 resColUnits），值与列头单位一致
function writeResultVals(out, mode) {
  const colVal = (d, def) => (def.key === 'capacityMbps' ? capacityKbpsOf(d) / 1000 : parseFloat(d && d[def.key]))
  const colAd = {}
  for (const def of RESULT_DEFS_BY[mode]) {
    if (!def.unit) continue
    const p = pickColumn(out.map((l) => (l.data ? colVal(l.data, def) : NaN)), def.unit)
    if (p) colAd[def.key] = p
  }
  for (const k of Object.keys(resColUnits)) { if (k.startsWith(mode + ':')) delete resColUnits[k] }
  for (const k of Object.keys(colAd)) resColUnits[mode + ':' + k] = colAd[k].unit
  const raw = { ...rawDataByRow.value }   // 引擎结果按行留底，供自定义列即时求值
  for (const l of out) raw[l.rowId] = l.data
  rawDataByRow.value = raw
  for (const l of out) {
    const d = l.data
    const patch = {}
    for (const def of RESULT_DEFS_BY[mode]) {
      if (!d) { patch['_' + def.key] = '—'; continue }
      const ad = colAd[def.key]
      if (def.key === 'capacityMbps') {
        const mbps = colVal(d, def)
        patch._capacityMbps = !isFinite(mbps) ? '—' : ad ? fmtScaled(ad.conv(mbps)) : mbps.toFixed(3)
      } else {
        const v = d[def.key]
        const n = parseFloat(v)
        patch['_' + def.key] = (v === undefined || v === null || v === '') ? '—' : (ad && isFinite(n)) ? fmtScaled(ad.conv(n)) : v
      }
    }
    // _paW＝该站算出的功放功率原值（上行独有；不随列档位换算——尾标自己按 fmtQty 换 mW 档，见 cellTagFn）
    if (mode === 'uplink') patch._paW = d ? d.paRecommendation : ''
    setVals(l.rowId, patch)
  }
}
// 表格聚焦行变化 → 表脚「本行读数」跟随（无结果的新行也跟）；有结果时详细预算一并切到该行链路
function onRowFocus(idx, rowId) {
  focusRowId.value = rowId
  if (!links.value.length) return
  const i = links.value.findIndex((l) => l.rowId === rowId)
  if (i >= 0 && i !== selected.value) { selected.value = i; loadWaterfall() }
}
const selected = ref(0)
const segments = ref([])
const computing = ref(false)
const error = ref('')
// —— 结果过期提示 ——
const resultsStale = ref(false)
watch([satConfigs, basebandConfigs, esConfigs, txStations, rxStations, islLinks, laserLinks, geoMode, geoHorizonHours],
  () => { if (links.value.length) resultsStale.value = true }, { deep: true })
// —— 瀑布表一键整表复制（TSV） ——
async function copyWaterfallTsv() {
  if (!segments.value.length) return
  const t = lbDocT(reportLang.value)   // 段标题/行标签已随 segments 翻好，列头在此补上
  const lines = []
  for (const seg of segments.value) {
    lines.push(seg.no ? '§' + seg.no + '  ' + seg.title : seg.title)   // 章节号与屏幕/Excel 同号同序
    if (seg.cols >= 2) lines.push(['', '', t('上行'), t('下行')].concat(seg.cols === 3 ? [t('合计')] : []).concat(['']).join('\t'))
    for (const r of seg.rows) {
      const cells = [r.sign || '', r.label, r.up]
      if (seg.cols >= 2) { cells.push(r.down); if (seg.cols === 3) cells.push(r.total) }
      cells.push(r.unit || '')
      lines.push(cells.join('\t'))
    }
    lines.push('')
  }
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('瀑布表已复制（TSV，可直接粘贴到 Excel）') }
  catch (e) { toast('复制失败') }
}
// 几何/访问窗口卡折叠（记忆）
const geoFold = ref(localStorage.getItem('regen/geoFold') === '1')
watch(geoFold, (v) => { try { localStorage.setItem('regen/geoFold', v ? '1' : '0') } catch (e) { /* ignore */ } })
// Ctrl+Enter 全局快捷计算（compute 内部按体制分发）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
const nLinks = computed(() => (linkMode.value === 'laser' ? laserLinks.length : linkMode.value === 'isl' ? islLinks.length : linkMode.value === 'downlink' ? rxStations.length : txStations.length))
// 链路方向标签：上行=站→星，下行=星→站，星间=发射星→接收星（txName=发射星, satName=接收星）
function pairLabel(l) {
  if (!l) return ''
  // 手动几何的星间/激光链路两端没有卫星身份（表上也没那两列）→ 按条数命名，不拿「发射星 → 接收星」充数
  if (l.islManual) return `星间链路 ${(l.ti || 0) + 1}`
  return linkMode.value === 'downlink' ? `${l.satName} → ${l.txName}` : `${l.txName} → ${l.satName}`
}
// 体制短标签（上行/下行/星间）与逐条量词
const modeLabel = computed(() => (linkMode.value === 'laser' ? '激光星间' : linkMode.value === 'isl' ? '星间' : linkMode.value === 'downlink' ? '下行' : '上行'))

// ============ 平台精确几何覆盖引擎几何量 ============
const _C_KMS = 299792.458
function mergePlatformGeometry(d, geom) {
  const w = geom.worst, el = geom.elements
  d.slantRangeResult = w.up.slantKm.toFixed(2); d.rxSlantRangeResult = w.dn.slantKm.toFixed(2)
  d.elevationResult = w.up.elevDeg.toFixed(2); d.rxElevationResult = w.dn.elevDeg.toFixed(2)
  if (w.up.altKm != null) d.orbitAltitudeUpResult = w.up.altKm.toFixed(1)
  if (w.dn.altKm != null) d.orbitAltitudeResult = w.dn.altKm.toFixed(1)
  if (w.speedInertialKmS != null) { d.orbitVelocityResult = w.speedInertialKmS.toFixed(3); d.orbitVelocityUpResult = d.orbitVelocityResult }
  if (w.speedGroundRelKmS != null) { d.groundRelVelResult = w.speedGroundRelKmS.toFixed(3); d.groundRelVelUpResult = d.groundRelVelResult }
  if (w.maxDopplerUpHz != null) d.maxDopplerUplinkResult = (w.maxDopplerUpHz / 1000).toFixed(3)
  if (w.maxDopplerDnHz != null) d.maxDopplerDownlinkResult = (w.maxDopplerDnHz / 1000).toFixed(3)
  if (w.oneWayDelayMs != null) { d.linkDelayResult = w.oneWayDelayMs.toFixed(3); d.linkDelayUpResult = (w.up.slantKm / _C_KMS * 1000).toFixed(3) }
  if (el && el.periodMin != null) { d.orbitPeriodUpResult = el.periodMin.toFixed(2); d.orbitPeriodDownResult = d.orbitPeriodUpResult }
  const fmtPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)
  if (w.up.coverageHalfAngleDeg != null) {
    d.coverageHalfAngleUpResult = w.up.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusUpResult = w.up.coverageRadiusKm.toFixed(1)
    d.maxPassDurationUpResult = fmtPass(w.up.maxPassMin)
    // 下行覆盖（再生下行瀑布用）：单站 收=发，下行覆盖等同上行覆盖
    d.coverageHalfAngleDownResult = w.up.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusDownResult = w.up.coverageRadiusKm.toFixed(1)
    d.maxPassDurationDownResult = fmtPass(w.up.maxPassMin)
  }
}
const g2 = (n, p = 2) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(p)
const gPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)

// —— 时标格式化（访问窗口）——
const tzMode = ref('utc')
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function localOffsetLabel() { const off = -new Date().getTimezoneOffset(); const s = off >= 0 ? '+' : '−'; const h = Math.floor(Math.abs(off) / 60); const m = Math.abs(off) % 60; return 'UTC' + s + h + (m ? ':' + String(m).padStart(2, '0') : '') }
const tzSuffix = computed(() => (tzMode.value === 'utc' ? 'UTCG' : localOffsetLabel()))
function fmtInstant(iso, mode) {
  if (!iso) return '—'
  const d = new Date(iso); if (isNaN(d.getTime())) return String(iso)
  const loc = mode === 'local'; const p = (n, w = 2) => String(n).padStart(w, '0')
  const D = loc ? d.getDate() : d.getUTCDate(), MO = loc ? d.getMonth() : d.getUTCMonth(), Y = loc ? d.getFullYear() : d.getUTCFullYear()
  const H = loc ? d.getHours() : d.getUTCHours(), MI = loc ? d.getMinutes() : d.getUTCMinutes(), S = loc ? d.getSeconds() : d.getUTCSeconds()
  return `${D} ${UTCG_MON[MO]} ${Y} ${p(H)}:${p(MI)}:${p(S)}`
}
function fmtDur(min) { if (min == null || !isFinite(min)) return '—'; return min >= 60 ? (min / 60).toFixed(2) + ' h' : min.toFixed(1) + ' min' }

// ============ 容量汇总 ============
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult); const eta = parseFloat(d.spectralEfficiencyResult)
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN
}
// GSO/NGSO 两窗的容量汇总此处还有一项「总功率带宽」（Σ PowerBWResult = Σ 功率占用 × 转发器带宽），
// 再生式没有：星上解调再调制，转发器（SFD/IBO/OBO/带宽）压根不参与，引擎入参里那套转发器参数只是
// 为让求解良定而由 buildRegenParams 塞的 NGSO 占位值（见 linkCalculatorRegen.js 文件头）。
// 结果对象里透传出来的 PowerBWResult 因此是占位值算出的弯管量，不可读——故 pbwN 恒为 0、该项不出现。
// 报告侧同口径：regenSummaryRows 的四个体制也都没列功率带宽。
const capacitySummary = computed(() => {
  const done = links.value.filter((l) => l && l.data && !l.error)
  let bwKHz = 0, capKbps = 0
  for (const l of done) {
    const bw = parseFloat(l.data.allocBandwidthResult); if (isFinite(bw)) bwKHz += bw
    const kbps = capacityKbpsOf(l.data); if (isFinite(kbps)) capKbps += kbps
  }
  return { count: done.length, failed: links.value.length - done.length, bwKHz, capKbps, avgEff: bwKHz > 0 ? capKbps / bwKHz : 0 }
})
function fmtCapacity(kbps) { const n = Number(kbps); if (!isFinite(n) || n <= 0) return { v: '0', u: 'kbps' }; if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'Gbps' }; if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'Mbps' }; return { v: n.toFixed(n >= 100 ? 1 : 2), u: 'kbps' } }
function fmtBandwidth(khz) { const n = Number(khz); if (!isFinite(n) || n <= 0) return { v: '0', u: 'kHz' }; if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'GHz' }; if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'MHz' }; return { v: n.toFixed(n >= 100 ? 1 : 3), u: 'kHz' } }
const capMain = computed(() => fmtCapacity(capacitySummary.value.capKbps))
const bwMain = computed(() => fmtBandwidth(capacitySummary.value.bwKHz))

// —— 本行读数（容量汇总下方第二行，见 LbCapFoot）——
// 结果列多了要横滚才看得全，而用户看的往往就是刚点的那一行：把聚焦行的结果就地摊平成一行，
// 点哪行看哪行、重算即刷新。指标口径与「结果列」勾选完全一致（连列序也一致），只是换了个横排读法。
// 单位取该列此次计算共选的档位（resColUnits 按 '模式:键' 记）；切体制会清空结果，此行随之消失。
const focusRowId = ref('')

// —— 斜距工具（几何=手动）——
// 只做换算与填入；填多少、填哪几行由用户点。填入按【各行自己的仰角】算，不是把同一个数刷满全表。
// 作用于当前子链路模式那张表（上行→发信站群、下行→收信站群；星间/激光不受几何模式约束）。
const slantToolOpen = ref(false)
// 两张表各自的站址/仰角/斜距列名（站表海拔单位是 m，换算函数吃 km）
const MANUAL_TX = { rows: null, eKey: 'minElevation', dKey: 'slantRange', latKey: 'latitude', staAltKey: 'altitude', label: '上行' }
const MANUAL_RX = { rows: null, eKey: 'rxMinElevation', dKey: 'rxSlantRange', latKey: 'rxLatitude', staAltKey: 'rxAltitude', label: '下行' }
const slantSide = computed(() => (linkMode.value === 'downlink'
  ? { ...MANUAL_RX, rows: rxStations } : { ...MANUAL_TX, rows: txStations }))
// 某行某侧：按 WGS-84 椭球 + 该站纬度/海拔算「绕站一圈最大斜距」（口径见 shared/slantRange.js）
const rowSlant = (row, side, altKm) => slantWgs84Max(pf(row[side.latKey]), (pf(row[side.staAltKey]) || 0) / 1000, pf(row[side.eKey]) || 0, altKm)
const slantToolRow = computed(() => slantSide.value.rows.find((r) => r._id === focusRowId.value) || null)
const _slantSeedRow = computed(() => slantToolRow.value || slantSide.value.rows[0] || null)
const slantToolAlt = computed(() => {
  const sat = _slantSeedRow.value ? resolveSatellite(_slantSeedRow.value.satelliteId) : satConfigs[0]
  return (sat && sat.form.orbitAltitude) || ''
})
const slantToolElev = computed(() => (_slantSeedRow.value && _slantSeedRow.value[slantSide.value.eKey]) || 10)
const slantToolLat = computed(() => (_slantSeedRow.value && _slantSeedRow.value[slantSide.value.latKey]) || '')
const slantToolStaAlt = computed(() => (_slantSeedRow.value && _slantSeedRow.value[slantSide.value.staAltKey]) || 0)
function applySlantFill({ altKm, scope }) {
  const s = slantSide.value
  const rows = scope === 'row' ? [slantToolRow.value].filter(Boolean) : s.rows
  let n = 0
  for (const r of rows) {
    const d = rowSlant(r, s, altKm)
    if (d != null) { r[s.dKey] = d.toFixed(2); n++ }
  }
  slantToolOpen.value = false
  toast(`已按各行站址与仰角填入 ${n} 处斜距（轨道高度 ${Number(altKm).toFixed(0)} km）`)
}

// —— 星间链路距离工具（几何=手动，星间/激光两张表共用）——
// 手动几何不选卫星，星间距离是逐条给的一个数。工具里挑两颗卫星在时间轴上算距离曲线，用户挑一刻填回。
const islToolOpen = ref(false)
const islToolRows = computed(() => (linkMode.value === 'laser' ? laserLinks : islLinks))
const islToolRow = computed(() => islToolRows.value.find((r) => r._id === focusRowId.value) || null)
// 工具的两端候选＝卫星群全部条目（选星定轨的给真实星历，手动轨道的给圆轨道；也可在工具里自定义轨道）
const islToolSats = computed(() => satConfigs.map((c) => ({
  id: c.id, name: c.name || c.form.satelliteName || c.id, orbit: orbitSpecOf(c), summary: satSummary(c)
})))
function applyIslRangeFill({ rangeKm, scope }) {
  const rows = scope === 'row' ? [islToolRow.value].filter(Boolean) : islToolRows.value
  const v = Number(rangeKm).toFixed(1)
  let n = 0
  for (const r of rows) { r.islRangeKm = v; n++ }
  islToolOpen.value = false
  toast(`已填入 ${n} 条链路的星间链路距离 ${v} km`)
}

// —— 斜距＝派生量：手动几何下由【仰角 / 站点纬度 / 站点海拔 / 轨道高度】四项按 WGS-84 算出 ——
// 这四项只要有一项变，本行的斜距立刻重算写回——不问那格是不是用户改过的：输入都变了，旧值必然对不上。
// （轨道高度取该行所选卫星的，故换卫星＝换轨道高度，同样触发重算。）
// 用户仍可就地改斜距，改完一直用它，直到上述四项再次变动。斜距格空着也直接补上（切到手动 / 新增行）。
// slantSig 只活在本次会话（不入场景）：载入场景时各行是新 _id、签名尚未记过 ⇒ 只登记不改写，
// 绝不覆盖存档里的值。上下两张表一起刷，切子链路模式不用再来一遍。
const slantSig = {}   // { 行_id: { 斜距列名: '纬度|海拔|仰角|轨道高度' } }
function refreshSlant() {
  if (!geoManual.value) return
  const wasClean = !isDirty()
  for (const [rows, side] of [[txStations, MANUAL_TX], [rxStations, MANUAL_RX]]) {
    for (const r of rows) {
      const rec = slantSig[r._id] || (slantSig[r._id] = {})
      const h = pf(resolveSatellite(r.satelliteId).form.orbitAltitude)
      const sig = `${r[side.latKey]}|${r[side.staAltKey]}|${r[side.eKey]}|${h || ''}`
      const changed = rec[side.dKey] !== undefined && rec[side.dKey] !== sig
      rec[side.dKey] = sig
      const empty = String(r[side.dKey] == null ? '' : r[side.dKey]).trim() === ''
      if (!(changed || empty) || !(h > 0)) continue
      const d = rowSlant(r, side, h)
      if (d != null) r[side.dKey] = d.toFixed(2)
    }
  }
  // 派生值是系统自动填的、不是用户改的：本就无未保存改动时把基线推进，免得误报「未保存」
  if (wasClean) setBaseline()
}
let _slantT = null
function scheduleSlant() { clearTimeout(_slantT); _slantT = setTimeout(refreshSlant, 300) }
// 只盯推荐值的【输入】（几何模式 / 各行所选卫星与其轨道高度 / 各行站址与仰角）——盯回填值本身会自激
watch(() => [geoMode.value,
  [[txStations, MANUAL_TX], [rxStations, MANUAL_RX]].map(([rows, s]) => rows.map((r) =>
    `${r.satelliteId},${resolveSatellite(r.satelliteId).form.orbitAltitude},${r[s.latKey]},${r[s.staAltKey]},${r[s.eKey]}`).join(';')).join('/')].join('#'),
scheduleSlant, { immediate: true })

const rowReadout = computed(() => {
  const mode = linkMode.value
  const rows = mode === 'laser' ? laserLinks : mode === 'isl' ? islLinks : mode === 'downlink' ? rxStations : txStations
  if (!rows.length) return null
  let idx = rows.findIndex((r) => r._id === focusRowId.value)
  if (idx < 0 && sel.value) idx = rows.findIndex((r) => r._id === sel.value.rowId)   // 还没点过表 → 跟详细预算走
  if (idx < 0) return null
  const row = rows[idx]
  const link = links.value.find((l) => l.rowId === row._id) || null
  const m = computedVals.value[row._id] || null
  const items = []
  for (const def of (m ? RESULT_DEFS_BY[mode].filter((d) => resultKeys[mode].includes(d.key)) : [])) {
    const v = m['_' + def.key]
    if (v === undefined || v === null || v === '' || v === '—') continue
    const n = parseFloat(v)   // 着色口径同结果单元格（见 cellClassFn）：负余量转红
    const bad = def.key === 'linkmargin' && isFinite(n) && n < 0
    items.push({ key: def.key, label: def.label, value: v, unit: resColUnits[mode + ':' + def.key] || def.unit || '', tip: def.tip || def.label, bad })
  }
  const cv = customVals.value[row._id] || null
  for (const c of (cv ? (customColsBy[mode] || []).filter((x) => x.on !== false) : [])) {
    const v = cv['_c' + c.id]
    if (v === undefined || v === null || v === '' || v === '—') continue
    items.push({ key: '_c' + c.id, label: c.label, value: v, unit: unitOf(c, customPoolOf(mode)), tip: c.expr, bad: false })
  }
  const name = link ? pairLabel(link) : (row.earthStationLocation || row.rxEarthStationLocation || '')
  return { no: idx + 1, name, err: (link && link.error) || '', items }
})

const sel = computed(() => links.value[selected.value] || null)
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))
// —— 图表区「参数扫描」——
// 引擎入参按行原样留底（含解算后注入的最差几何/星间距离），不重新组装：重组会丢几何，
// 扫出来的曲线就不再经过详细预算正在显示的那一点。
const sweepParamsByRow = ref({})
const selParams = computed(() => (sel.value ? (sweepParamsByRow.value[sel.value.rowId] || null) : null))
// 图表区显示开关（功能区「视图 → 图表」）。关掉时详细预算只剩表：图表整块不渲染，
// 里头的扫描自然也不会跑——不出图还占着 CPU 逐格重算引擎是说不过去的。
const showViz = ref((() => { try { return localStorage.getItem('regen/viz/show') !== '0' } catch (e) { return true } })())
watch(showViz, (v) => { try { localStorage.setItem('regen/viz/show', v ? '1' : '0') } catch (e) { /* ignore */ } })
// 链路视图的场景（见 shared/lbLinkScene.js）：上行只画发信站那一端、下行只画收信站那一端，
// 星间两颗星按最差星间距离时刻的星下点摆位——每种子链路各自只有那么几个实体，多画一个都是假的。
const linkScene = computed(() => buildRegenScene(sel.value, selParams.value,
  linkMode.value === 'downlink' ? 'down' : linkMode.value === 'isl' ? 'isl' : linkMode.value === 'laser' ? 'laser' : 'up'))
// 地理场图：只有地面-空间的子链路才铺得出站址平面。星间/激光两端都在天上，引擎压根不读
// 地面站经纬度，扫出来整片恒定，那张图连同它的「场」下拉一起没有意义 → 整块不出现。
const vizShowGeo = computed(() => linkMode.value === 'uplink' || linkMode.value === 'downlink')
// 上下行各只有一个真站（另一端的站址字段是给弯管引擎凑几何的镜像，见 regenParams），
// 故扫哪一端不该由用户选：上行钉发信站、下行钉收信站。
const vizGeoSite = computed(() => (linkMode.value === 'downlink' ? 'rx' : 'tx'))
// 子链路 → 扫描用的引擎标识（与 core/utils/linkSweep.js 的 _solver 对应）
const sweepEngine = computed(() => (
  linkMode.value === 'downlink' ? 'regen-down'
    : linkMode.value === 'isl' ? 'regen-isl'
      : linkMode.value === 'laser' ? 'regen-laser' : 'regen-up'
))
// 激光星间的引擎入口是 (params, opt) 两参形式，与扫描通道的三参约定不同，暂不接
const sweepUnavailable = computed(() => {
  if (linkMode.value !== 'laser') return ''
  return reportLang.value === 'en'
    ? 'Figures are unavailable for the laser ISL (its engine entry takes two arguments, unlike the 2-D sweep channel)'
    : '激光星间链路暂不支持出图（其引擎入口是两参形式，与二维扫描通道的调用约定不同）'
})
const geom = computed(() => (sel.value ? sel.value.geom : null))
const access = computed(() => (sel.value ? sel.value.access : null))
const islGeo = computed(() => (sel.value ? sel.value.islGeo : null))
// 几何折叠小节的头部摘要（收拢态一眼可见关键量）
const geoFoldSum = computed(() => {
  const ig = islGeo.value
  if (ig && ig.feasible) return `${ig.method} · 最差 ${Math.round(ig.worst.rangeKm)} km · 可见 ${(ig.visibility.visibleFrac * 100).toFixed(1)}%`
  const g = geom.value
  if (g && g.feasible) return g.method + (access.value && access.value.feasible ? ` · ${access.value.totalWindows} 次过境` : '')
  if (g && !g.feasible) return '几何不可行：' + (g.reason || '')
  return ''
})

// ============ 计算（逐发信站一条上行链路；工作点给定 → 求余量）============
async function compute() {
  if (!api) { error.value = '引擎需在桌面客户端中运行'; return }
  if (linkMode.value === 'laser') return computeLaser()
  if (linkMode.value === 'isl') return computeIsl()
  const isDown = linkMode.value === 'downlink'
  const stations = isDown ? rxStations : txStations
  if (!stations.length) { error.value = isDown ? '请至少添加一个收信站' : '请至少添加一个发信站'; return }
  if (!satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const sweepStore = {}         // 逐行留底送进引擎的入参，供图表区参数扫描原地重跑
    const t0ISO = searchT0ISO()   // 本批上下行统一起点：计算此刻墙钟
    for (let ti = 0; ti < stations.length; ti++) {
      const st = stations[ti]
      const sat = resolveSatellite(st.satelliteId)
      const bbForm = resolveBaseband(st.basebandId).form
      const satName = (sat && (sat.form.satelliteName || sat.name)) || '卫星'
      // 轨道来源：选星→真实星历；未选→手动圆轨道（上/下行共用）
      const ns = sat.ngsoSat
      const selectedStar = ns && ns.mode !== 'manual' && ns.orbit
      const orbitSpec = selectedStar ? JSON.parse(JSON.stringify(ns.orbit))
        : { type: 'circular', altKm: pf(sat.form.orbitAltitude) || 0, inclDeg: pf(sat.form.orbitInclination) || 0 }

      if (isDown) {
        // ===== 再生式下行：星上再生 → 收信站接收；工作点 = 收信站 G/T =====
        const rxName = st.rxEarthStationLocation || ('收' + (ti + 1))
        const { satParams, linkParams } = buildRegenDownlinkParams(sat.form, bbForm, st, resolveEs(st.stationId).form)
        const freqGHz = parseFloat(sat.form.rxCenterFrequency) || 12.5   // 下行频率（几何多普勒/FSL）
        const stationGeo = { lonDeg: parseFloat(st.rxLongitude), latDeg: parseFloat(st.rxLatitude), altKm: (parseFloat(st.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(st.rxMinElevation) || 0, freqGHz }
        let geo = null, acc = null
        if (geoManual.value) {
          // 手动几何：仰角与斜距就是本行那两个数，不解算轨道（无 t*、无过境窗口、§8 不适用）
          if (!(pf(st.rxSlantRange) > 0)) {
            out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: '手动几何：斜距未填或非正数', geom: null, access: null }); continue
          }
          applyManualGeom(linkParams, st.rxSlantRange, st.rxMinElevation)
        } else {
          geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
          if (!(geo && geo.feasible)) {
            out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
          }
          // 下行几何注入（单站：收=发，up/dn 同值）
          linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.dn.slantKm; linkParams.rxMinElevation = geo.worst.dn.elevDeg
          linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.dn.slantKm; linkParams.minElevation = geo.worst.dn.elevDeg
          // §8 统计口径（仅下行侧；最低仰角取收信站门限字段，非最差瞬时仰角；不适用时为空对象=原口径）
          Object.assign(linkParams, s8LinkParams(geo, { minElevDn: st.rxMinElevation }))
          try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
        }
        // 计算方式随该行所选载波：power = 按收信站实配 G/T 算余量；margin = 按载波系统余量反解所需 G/T
        const dopt = { mode: calcModeOf(bbForm) }
        sweepStore[st._id] = { satParams, linkParams, opt: dopt }
        const r = await api.linkBudget.computeRegenDownlink(satParams, linkParams, dopt)
        if (r && r.success) {
          const d = r.data
          if (geo) mergePlatformGeometry(d, geo)   // 手动几何不覆盖：引擎回填的就是用户给的那两个数
          const m = parseFloat(d.linkmargin)
          out.push({ ti, rowId: st._id, txName: rxName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
        } else {
          out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
        }
        continue
      }

      // ===== 再生式上行：地球站 → 星上再生解调 =====
      // 计算方式随该行所选载波：power = 按站型功放功率（工作点）算上行余量；margin = 按载波系统余量反解所需功放功率
      const txName = st.earthStationLocation || ('发' + (ti + 1))
      const es = resolveEs(st.stationId).form
      const { satParams, linkParams } = buildRegenParams(sat.form, bbForm, st, es)
      let copt = { mode: 'margin' }
      if (calcModeOf(bbForm) === 'power') {
        const powerW = parseFloat(es.opPowerW)
        if (!(powerW > 0)) {
          out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: '工作点无效（地球站配置的「功放功率预设」需为正数）', geom: null, access: null }); continue
        }
        copt = { mode: 'power', powerW }
      }
      const freqGHz = parseFloat(sat.form.centerFrequency) || 14.25
      const stationGeo = { lonDeg: parseFloat(st.longitude), latDeg: parseFloat(st.latitude), altKm: (parseFloat(st.altitude) || 0) / 1000, minElevDeg: parseFloat(st.minElevation) || 0, freqGHz }
      let geo = null, acc = null
      if (geoManual.value) {
        if (!(pf(st.slantRange) > 0)) {
          out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: '手动几何：斜距未填或非正数', geom: null, access: null }); continue
        }
        applyManualGeom(linkParams, st.slantRange, st.minElevation)
      } else {
        geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
        if (!(geo && geo.feasible)) {
          out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
        }
        linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.up.slantKm; linkParams.minElevation = geo.worst.up.elevDeg
        linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.up.slantKm; linkParams.rxMinElevation = geo.worst.up.elevDeg
        // §8 统计口径（仅上行侧；最低仰角取发信站门限字段，非最差瞬时仰角；不适用时为空对象=原口径）
        Object.assign(linkParams, s8LinkParams(geo, { minElevUp: st.minElevation }))
        try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
      }
      sweepStore[st._id] = { satParams, linkParams, opt: copt }
      const r = await api.linkBudget.computeRegenUplink(satParams, linkParams, copt)
      if (r && r.success) {
        const d = r.data
        if (geo) mergePlatformGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, rowId: st._id, txName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, powerW: d.paRecommendation, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
      }
    }
    const prevSel = sel.value
    sweepParamsByRow.value = sweepStore
    links.value = out
    writeResultVals(out, isDown ? 'downlink' : 'uplink')   // 结果列写回表格（按行 _id 映射）
    // 计算后保持当前查看位置（按行 _id 定位；行数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    await nextTick()
    resultsStale.value = false
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

// 再生式星间：逐条星间链路。几何=自动最差 时两星轨道 → 严格互视最差距离/可见度；
// 几何=手动 时不选卫星，星间距离取本行 islRangeKm 直接算 FSL。
async function computeIsl() {
  if (!islLinks.length) { error.value = '请至少添加一条星间链路'; return }
  if (!geoManual.value && !satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const sweepStore = {}         // 逐行留底送进引擎的入参，供图表区参数扫描原地重跑
    const t0ISO = searchT0ISO()   // 本批星间统一起点：与上下行同口径，计算此刻墙钟
    for (let ti = 0; ti < islLinks.length; ti++) {
      const link = islLinks[ti]
      const manual = geoManual.value
      // 手动几何不选卫星：两端无身份（表上也没那两列），链路名按条数走；引擎占位仍取首份卫星配置
      const txSat = manual ? null : resolveSatellite(link.txSatelliteId)
      const rxSat = manual ? null : resolveSatellite(link.rxSatelliteId)
      const bbForm = resolveBaseband(link.basebandId).form
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      let geo = null, distKm = 0, visPct = null   // 手动几何无互视占比 → null（引擎据此不写可用度）
      if (manual) {
        distKm = pf(link.islRangeKm)
        if (!(distKm > 0)) {
          out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: true, data: null, margin: '—', error: '手动几何：星间链路距离未填或非正数', geom: null, islGeo: null, access: null }); continue
        }
      } else {
        const freqGHz = parseFloat(link.islFreq) || 23
        const am = parseFloat(link.islAtmMargin); const atmMarginKm = isNaN(am) ? 100 : am
        // 两星几何（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）。
        // 最大工作距离留空＝不限：最差工况就是几何可达的最大互视距离（擦地球临边那一瞬）。
        geo = await api.linkBudget.islGeometry({ orbitA: orbitSpecOf(txSat), orbitB: orbitSpecOf(rxSat), t0ISO, horizonHours: geoHorizonHours.value, freqGHz, atmMarginKm, maxRangeKm: pf(link.islMaxRange) || 0 })
        if (!(geo && geo.feasible)) {
          out.push({ ti, rowId: link._id, txName, satName: rxName, data: null, margin: '—', error: (geo && geo.reason) || '两星几何不可行/时窗内不互视', geom: null, islGeo: geo, access: null }); continue
        }
        distKm = geo.worst.rangeKm
        visPct = (geo.visibility.visibleFrac || 0) * 100
      }
      const { satParams, linkParams } = buildRegenIslParams(txSat ? txSat.form : ((satConfigs[0] && satConfigs[0].form) || null), bbForm, link)
      satParams.islHopDistance = distKm     // 星间距离注入（自动=几何最差；手动=本行给定）
      sweepStore[link._id] = { satParams, linkParams, opt: { visibilityPct: visPct } }
      const r = await api.linkBudget.computeRegenIsl(satParams, linkParams, { visibilityPct: visPct })
      if (r && r.success) {
        const d = r.data
        if (manual) mergeIslManualDistance(d, distKm); else mergeIslGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: d, geom: null, islGeo: geo, access: null, margin: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: null, margin: '—', error: (r && r.message) || '失败', geom: null, islGeo: geo, access: null })
      }
    }
    const prevSel = sel.value
    sweepParamsByRow.value = sweepStore
    links.value = out
    writeResultVals(out, 'isl')   // 结果列写回表格（按行 _id 映射）
    // 计算后保持当前查看位置（按行 _id 定位；行数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    await nextTick()
    resultsStale.value = false
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

// 再生式激光星间：逐条激光链路（发射卫星 → 接收卫星）。几何复用两星互视最差距离/可见度；
// 链路预算走第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；给定速率 → 链路余量。
async function computeLaser() {
  if (!laserLinks.length) { error.value = '请至少添加一条激光星间链路'; return }
  if (!geoManual.value && !satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const t0ISO = searchT0ISO()
    for (let ti = 0; ti < laserLinks.length; ti++) {
      const link = laserLinks[ti]
      const manual = geoManual.value
      const txSat = manual ? null : resolveSatellite(link.txSatelliteId)
      const rxSat = manual ? null : resolveSatellite(link.rxSatelliteId)
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      let geo = null, distKm = 0, visPct = null, rangeRateKmS = null
      if (manual) {
        distKm = pf(link.islRangeKm)
        if (!(distKm > 0)) {
          out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: true, data: null, margin: '—', error: '手动几何：星间链路距离未填或非正数', geom: null, islGeo: null, access: null }); continue
        }
      } else {
        // 光频（GHz）= c/λ：喂几何求解器使 maxDopplerHz 为相干光多普勒
        const lambdaNm = parseFloat(link.wavelengthNm) || 1550
        const optFreqGHz = 2.99792458e8 / lambdaNm    // = c[m/s]/λ[nm] → GHz（c/λ 的 GHz 数值）
        const am = parseFloat(link.islAtmMargin); const atmMarginKm = isNaN(am) ? 100 : am
        // 两星几何（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）
        geo = await api.linkBudget.islGeometry({ orbitA: orbitSpecOf(txSat), orbitB: orbitSpecOf(rxSat), t0ISO, horizonHours: geoHorizonHours.value, freqGHz: optFreqGHz, atmMarginKm, maxRangeKm: pf(link.islMaxRange) || 0 })
        if (!(geo && geo.feasible)) {
          out.push({ ti, rowId: link._id, txName, satName: rxName, data: null, margin: '—', error: (geo && geo.reason) || '两星几何不可行/时窗内不互视', geom: null, islGeo: geo, access: null }); continue
        }
        distKm = geo.worst.rangeKm
        visPct = (geo.visibility.visibleFrac || 0) * 100
        rangeRateKmS = geo.worst.rangeRateKmS
      }
      const laserParams = buildRegenLaserParams(txSat ? txSat.form : null, link)
      laserParams.islHopDistance = distKm          // 星间距离注入（自动=几何最差；手动=本行给定）
      const r = await api.linkBudget.computeRegenLaser(laserParams, { visibilityPct: visPct, rangeRateKmS })
      if (r && r.success) {
        const d = r.data
        if (manual) mergeLaserManualDistance(d, distKm); else mergeLaserGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: d, geom: null, islGeo: geo, access: null, margin: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: null, margin: '—', error: (r && r.message) || '失败', geom: null, islGeo: geo, access: null })
      }
    }
    const prevSel = sel.value
    sweepParamsByRow.value = {}     // 激光星间不走扫描通道（引擎入口两参形式），清掉上一子链路的留底免得串味
    links.value = out
    writeResultVals(out, 'laser')   // 结果列写回表格（按行 _id 映射）
    // 计算后保持当前查看位置（按行 _id 定位；行数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    // 先把「表格一动就置位」的 stale 侦听冲刷掉再清旗：方向图回填也是往单元格里写数，
    // 那是本次计算自己填的、不是用户改的，不该立刻亮「输入已变」。
    await nextTick()
    resultsStale.value = false
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

async function loadWaterfall() {
  const l = sel.value
  if (!l || !l.data) { segments.value = []; return }
  segments.value = await api.linkBudget.waterfall({ results: JSON.parse(JSON.stringify(l.data)), lang: reportLang.value, orbitType: 'REGEN', txLocation: String(l.txName || '') })
}
// ============ 经纬度 → 降雨率/海拔自动填 ============
async function fillGeoRow(row, lonK, latK, rainK, elevK, skip) {
  if (!api) return
  const lat = parseFloat(row[latK]); const lon = parseFloat(row[lonK])
  if (isNaN(lat) || isNaN(lon)) return
  try {
    const g = await api.linkBudget.geoFill(lat, lon)
    if (!g) return
    if (g.rainRate !== null && g.rainRate !== undefined && !(skip && skip.has(rainK))) row[rainK] = String(g.rainRate)
    if (g.altitude !== null && g.altitude !== undefined && !(skip && skip.has(elevK))) row[elevK] = String(g.altitude)
  } catch (e) { /* keep */ }
}
const citySearch = (q) => (api ? api.linkBudget.searchCities(q) : Promise.resolve([]))
const autoGeoTx = (row, skip) => fillGeoRow(row, 'longitude', 'latitude', 'rainRate', 'altitude', skip)
const autoGeoRx = (row, skip) => fillGeoRow(row, 'rxLongitude', 'rxLatitude', 'rxRainRate', 'rxAltitude', skip)

// ============ 状态序列化 / 持久化 / 命名配置 ============
const STATE_KEY = 'regen/last'
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

// _ 前缀键（行内部 id / 表格「＋增加」按全字段建行带出的计算列空键）一律剥离，不入场景
const stripRow = (r) => { const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; return o }
function serializeState() {
  // v2 场景 = 关联关系：四种模式的链路行（站址/链路量 + 各列引用的库条目 id）+ 模式/时窗等计算策略。
  // 三库是全局资产（userData/library.json），不再随场景存副本。
  return {
    orbitType: 'REGEN', v: 2,
    linkMode: linkMode.value,
    hiddenModes: [...hiddenModes.value],
    tx: txStations.map(stripRow),
    rx: rxStations.map(stripRow),
    isl: islLinks.map(stripRow),
    laser: laserLinks.map(stripRow),
    geoMode: geoMode.value,
    geoHorizonHours: geoHorizonHours.value
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // 隐藏模式：过滤掉未知 key；旧配置无该字段 → 全部显示
  hiddenModes.value = Array.isArray(st.hiddenModes) ? st.hiddenModes.filter((k) => LINK_MODES.some((m) => m.key === k)) : []
  if (st.linkMode) linkMode.value = st.linkMode
  if (hiddenModes.value.includes(linkMode.value)) { const first = visibleModes.value[0]; if (first) linkMode.value = first.key }  // 兜底：活动模式恰被隐藏
  let txRows = Array.isArray(st.tx) ? st.tx : null
  let rxRows = Array.isArray(st.rx) ? st.rx : null
  let islRows = Array.isArray(st.isl) ? st.isl : null
  let laserRows = Array.isArray(st.laser) ? st.laser : null

  // —— 旧结构迁移（v1.x：场景内嵌三库）——内嵌条目按内容去重并入全局库（adoptEntries 同内容⇒同 id，
  // 反复 applyState 映射稳定 → 基线/会话恢复指纹不误报），行引用经映射改写；v2 场景（只存引用）直接跳过。
  if (!(st.v >= 2)) {
    // ① 卫星：条目含 ngsoSat 选星态，指纹一并纳入比较（同参数不同选星是两颗不同的星）。
    // v1 场景内嵌库：干扰八项旧在地球站配置(st.esConfigs) → 播种到卫星条目（与库级迁移同口径；夹在默认与
    // 卫星自身值之间：卫星条目自带该值时仍以自带为准）。无内嵌地球站库则回退卫星干扰默认值。
    const _es0Intf = pickIntf((Array.isArray(st.esConfigs) && st.esConfigs[0] && st.esConfigs[0].form) || null)
    // nameAuto：旧场景条目名多是「卫星1」这类占位名 → 按历史默认名推定，并库后交给自动命名接手
    const satEntries = (Array.isArray(st.satConfigs) ? st.satConfigs : []).map((c, i) => ({
      id: c.id || ('__sat' + i), name: c.name || '卫星', nameAuto: adoptAutoFlag('sat', c),
      form: { ...defaultsFor(SAT_FIELDS), ..._es0Intf, ...c.form },
      // folder：tree 选星回显用；兼容旧配置（曾把 tree folder 存于 gtAnt.folder）
      ngsoSat: normNgsoSat(c.ngsoSat, c.gtAnt && c.gtAnt.folder)
    }))
    const satMap = adoptEntries(satConfigs, satEntries, () => makeSatConfig('卫星'), ['ngsoSat'])
    // ② 载波（补默认与 UI 态后并库）
    const bbEntries = (Array.isArray(st.basebandConfigs) ? st.basebandConfigs : []).map((c, i) => ({
      id: c.id || ('__bb' + i), name: c.name || '配置', nameAuto: adoptAutoFlag('carrier', c),
      form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null, ...c.form }
    }))
    const bbMap = adoptEntries(basebandConfigs, bbEntries, () => makeBasebandConfig('载波'))
    // ③ 地球站：三代结构统一后并库（内嵌库 / 过渡版收发分口径+行上工作点展开重迁 / 行内射频 migrateLegacyEs）。
    // 迁移 id 必须确定性生成（'esm'+序、无 id 存档按位置 'esb'+下标）：同一份内容反复 applyState 得到同一批
    // 映射键，adoptEntries 再按内容并库 → 全程指纹稳定。
    let esList = (Array.isArray(st.esConfigs) && st.esConfigs.length) ? st.esConfigs : null
    // 过渡版存档（库已建，但口径仍收发各一份 / 工作点仍在行上）：把配置值按侧展开回行上重走统一迁移，
    // 使「口径收发共用 + 同口径配对 + 工作点入库」新规则一并生效（两侧数值逐键保留，仅重新分组命名）
    if (esList && (
      esList.some((c) => c && c.form && c.form.rxAntennaDiameter !== undefined && String(c.form.rxAntennaDiameter) !== String(c.form.antennaDiameter)) ||
      (txRows || []).some((r) => r && r.opPoint !== undefined)
    )) {
      const byId = new Map(esList.map((c) => [c.id, c]))
      const cfgOf = (r) => ((r && r.stationId && byId.get(r.stationId)) || esList[0])
      txRows = (txRows || []).map((r) => {
        const c = cfgOf(r); if (!c || !c.form) return r
        const o = { ...r }
        if (c.form.antennaDiameter !== undefined) o.antennaDiameter = c.form.antennaDiameter
        for (const f of ES_TX_FIELDS) if (c.form[f.key] !== undefined) o[f.key] = c.form[f.key]
        return o
      })
      rxRows = (rxRows || []).map((r) => {
        const c = cfgOf(r); if (!c || !c.form) return r
        const o = { ...r }
        const rd = c.form.rxAntennaDiameter !== undefined ? c.form.rxAntennaDiameter : c.form.antennaDiameter
        if (rd !== undefined) o.rxAntennaDiameter = rd
        for (const f of ES_RX_FIELDS) if (c.form[f.key] !== undefined) o[f.key] = c.form[f.key]
        return o
      })
      esList = null
    }
    // 旧行工作点换算：opPoint（旧全局 opMode='eirp' 存 EIRP dBW / ='power' 存功放 W）→ 功放功率 opPowerW(W)，
    // 随站型入库。EIRP→W 用该行自身的旧射频参数（天线/馈线/回退——迁移前仍在行上）与所选卫星上行频率换算
    // （旧引用经 satMap 换到并库后的条目），物理工作点不变；无法解析留空 → 计算时按「工作点无效」提示。
    if (!esList && txRows && txRows.some((r) => r && r.opPoint !== undefined)) {
      const wasEirp = st.opMode !== 'power'
      txRows = txRows.map((r) => {
        if (!r || r.opPoint === undefined) return r
        const { opPoint, ...rest } = r
        let w = ''
        const v = parseFloat(opPoint)
        if (isFinite(v)) {
          const sat = resolveSatellite((r.satelliteId && satMap[r.satelliteId]) || '')
          const conv = wasEirp ? eirpToPowerW(v, r, sat ? sat.form : {}) : v
          if (isFinite(conv) && conv > 0) w = String(Math.round(conv * 1000) / 1000)
        }
        return { ...rest, opPowerW: w }
      })
    }
    if (!esList) {
      let _mn = 0
      const mig = migrateLegacyEs({ txRows: txRows || [], rxRows: rxRows || [], esTxFields: ES_TX_FIELDS, esRxFields: ES_RX_FIELDS, esCommonFields: ES_COMMON_FIELDS, makeId: () => 'esm' + (++_mn) })
      if (mig) { esList = mig.esConfigs; txRows = mig.txRows; rxRows = mig.rxRows }
    }
    // 无 esList 也无旧行可迁 = 该场景不含地球站信息：全局库保持原样（库是全局资产，场景不应重置它）
    const esEntries = (esList || []).map((c, i) => ({ id: c.id || ('esb' + i), name: c.name || '站型', nameAuto: adoptAutoFlag('es', c), form: { ...defaultsFor(ES_FIELDS), ...c.form } }))
    const esMap = adoptEntries(esConfigs, esEntries, () => makeEsConfig('站型'))
    // ④ 行引用改写（旧内嵌 id → 全局库 id）。空引用的旧语义 = 「内嵌库第一份」：并库后该条目未必
    // 还排在全局库首位，故显式钉到其并库后的 id（再生式卫星按行引用、直接决定轨道，绝不能漂到别的星）；
    // 旧场景确无内嵌库（def* 为空）才保持空 = 全局库第一份。
    const defSat = (satEntries[0] && satMap[satEntries[0].id]) || ''
    const defBb = (bbEntries[0] && bbMap[bbEntries[0].id]) || ''
    const defEs = (esEntries[0] && esMap[esEntries[0].id]) || ''
    const remapStation = (r) => ({
      ...r,
      basebandId: (r.basebandId && bbMap[r.basebandId]) || defBb,
      stationId: (r.stationId && esMap[r.stationId]) || defEs,
      satelliteId: (r.satelliteId && satMap[r.satelliteId]) || defSat
    })
    const remapIsl = (r) => ({
      ...r,
      basebandId: (r.basebandId && bbMap[r.basebandId]) || defBb,
      txSatelliteId: (r.txSatelliteId && satMap[r.txSatelliteId]) || defSat,
      rxSatelliteId: (r.rxSatelliteId && satMap[r.rxSatelliteId]) || defSat
    })
    const remapLaser = (r) => ({
      ...r,
      txSatelliteId: (r.txSatelliteId && satMap[r.txSatelliteId]) || defSat,
      rxSatelliteId: (r.rxSatelliteId && satMap[r.rxSatelliteId]) || defSat
    })
    txRows = txRows && txRows.map(remapStation)
    rxRows = rxRows && rxRows.map(remapStation)
    islRows = islRows && islRows.map(remapIsl)
    laserRows = laserRows && laserRows.map(remapLaser)
  }

  // 合并 TX 默认：旧配置（G/T 尚在卫星侧时保存）的发信站行缺 G_Ts，按默认补齐，避免下沉后该列为空
  if (txRows && txRows.length) txStations.splice(0, txStations.length, ...txRows.map((r) => ({ ...defaultsFor(TX_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 收信站群：旧配置（仅上行）无 rx 字段 → 保留默认一站，避免下行模式空表
  if (rxRows && rxRows.length) rxStations.splice(0, rxStations.length, ...rxRows.map((r) => ({ ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 星间链路群：旧配置无 isl 字段 → 保留默认一条
  if (islRows && islRows.length) islLinks.splice(0, islLinks.length, ...islRows.map((r) => ({ ...defaultsFor(ISL_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 激光星间链路群：旧配置无 laser 字段 → 保留默认一条；只保留当前字段键（清除旧速率/调制/BER 等已删字段的惰性残留）
  if (laserRows && laserRows.length) {
    const lkeys = LASER_FIELDS.map((f) => f.key)
    laserLinks.splice(0, laserLinks.length, ...laserRows.map((r) => {
      const o = { ...defaultsFor(LASER_FIELDS), _id: 's' + (_sid++) }
      for (const k of lkeys) if (r[k] !== undefined) o[k] = r[k]
      return o
    }))
  }
  geoMode.value = st.geoMode === 'manual' ? 'manual' : 'auto'   // 旧场景无此字段 → 自动最差（原行为）
  if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
}
let _stateT = null
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* ignore */ } dirtyFlag.value = isDirty() }, 600) }
watch([txStations, rxStations, islLinks, laserLinks, geoMode, geoHorizonHours, linkMode, hiddenModes, activeId], scheduleSaveState, { deep: true })

async function loadConfigs() {
  try {
    const all = (api && await api.store.listConfigs()) || []
    configs.value = all.filter((it) => it && ((it.type === 'folder') ? (it.orbitType === 'REGEN') : (it.state && it.state.orbitType === 'REGEN')))
  } catch (e) { configs.value = [] }
  pruneExpanded()
}
function pruneExpanded() {
  const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
  let changed = false
  for (const id of [...expandedFolders.value]) if (!ids.has(id)) { expandedFolders.value.delete(id); changed = true }
  if (changed) persistExpanded()
}
function defaultCfgName() { const s = satConfigs[0] && satConfigs[0].form.satelliteName; const kind = linkMode.value === 'laser' ? byLang('再生激光星间', 'OBP Optical ISL') : linkMode.value === 'isl' ? byLang('再生星间', 'OBP ISL') : linkMode.value === 'downlink' ? byLang('再生下行', 'OBP Downlink') : byLang('再生上行', 'OBP Uplink'); const unit = (linkMode.value === 'isl' || linkMode.value === 'laser') ? byLang('条', 'links') : byLang('站', 'stations'); return (s ? s + ' ' : '') + `${kind} ${nLinks.value} ${unit}` }
const cfgDlg = reactive({ open: false, name: '' })
function openSaveDlg() { if (!api) { toast('保存需在桌面客户端中运行'); return } cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
async function confirmCfgDlg() {
  const name = (cfgDlg.name || '').trim()
  if (!name) { toast('请输入配置名称'); return }
  const item = await api.store.saveConfig({ name, state: serializeState() })
  cfgDlg.open = false; await loadConfigs(); if (item && item.id) { activeId.value = item.id; setBaseline() }
  toast('已保存配置：' + name)
}
const editing = reactive({ id: null, name: '' })
function startRename(c) { editing.id = c.id; editing.name = c.name; nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } }) }
function cancelRename() { editing.id = null }
async function commitRename() {
  const id = editing.id; if (id == null) return
  const c = configs.value.find((x) => x.id === id); const nm = (editing.name || '').trim(); editing.id = null
  if (c && nm && nm !== c.name) { await api.store.saveConfig({ id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
}
async function updateConfig() {
  if (!api || !activeId.value) return
  const c = configs.value.find((x) => x.id === activeId.value); if (!c) return
  await api.store.saveConfig({ id: c.id, name: c.name, state: serializeState() })
  setBaseline(); await loadConfigs(); toast('已保存修改到：' + c.name)
}
async function saveCurrent() { if (!api) { toast('保存需在桌面客户端中运行'); return } if (activeId.value) await updateConfig(); else openSaveDlg() }
function applyConfig(c) { if (!c) return; activeId.value = c.id; applyState(c.state); setBaseline() }
async function selectConfig(c) { if (!c || c.id === activeId.value) return; if (!(await guardedLeave())) return; applyConfig(c) }
async function removeConfig(id, e) {
  if (e) e.stopPropagation(); if (!api) return
  await api.store.deleteConfig(id)
  if (activeId.value === id) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && cfgClip.value.id === id) cfgClip.value = null
  await loadConfigs()
}
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
async function addFolder(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  const item = await api.store.saveConfig({ type: 'folder', name: uniqueCfgName(newFolderName()), parentId: parentId || null, orbitType: 'REGEN' })
  if (parentId) expandedFolders.value.add(parentId)
  if (item && item.id) expandedFolders.value.add(item.id)
  persistExpanded(); await loadConfigs(); if (item && item.id) startRename(item)
}
async function onMove(payload) {
  if (!api || !payload || !payload.dragId) return
  await api.store.moveItem({ id: payload.dragId, parentId: payload.parentId, anchorId: payload.anchorId, position: payload.position })
  if (payload.position === 'inside' && payload.parentId) { expandedFolders.value.add(payload.parentId); persistExpanded() }
  await loadConfigs()
}
async function removeFolder(folder) {
  if (!api || !folder) return
  const hasChildren = configs.value.some((c) => c.parentId === folder.id)
  if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
  const removed = (await api.store.deleteFolder(folder.id)) || [folder.id]
  const rset = new Set(removed)
  if (activeId.value && rset.has(activeId.value)) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && rset.has(cfgClip.value.id)) cfgClip.value = null
  for (const id of removed) expandedFolders.value.delete(id)
  persistExpanded(); await loadConfigs(); toast('已删除文件夹：' + folder.name)
}
function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }
// 默认（空白）配置内容：四种模式各一条默认行（空引用 = 各库第一份），不再内嵌三库
function blankState() {
  return {
    orbitType: 'REGEN', v: 2, linkMode: 'uplink', hiddenModes: [],
    tx: [defaultsFor(TX_FIELDS)],
    rx: [defaultsFor(RX_FIELDS)],
    isl: [defaultsFor(ISL_FIELDS)],
    laser: [defaultsFor(LASER_FIELDS)],
    geoMode: 'manual', geoHorizonHours: 24
  }
}
function uniqueCfgName(base) { const names = new Set(configs.value.map((c) => c.name)); if (!names.has(base)) return base; let i = 2; while (names.has(base + ' ' + i)) i++; return base + ' ' + i }
async function addBlankConfig(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  if (!(await guardedLeave())) return
  const state = blankState()
  const item = await api.store.saveConfig({ name: uniqueCfgName(newCfgName()), state, parentId: parentId || null })
  if (parentId) { expandedFolders.value.add(parentId); persistExpanded() }
  await loadConfigs(); if (item && item.id) { activeId.value = item.id; applyState(state); setBaseline() }
  toast('已添加空白配置')
}
const cfgClip = shallowRef(null)
function copyConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'copy', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已复制：' + c.name) }
function cutConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'cut', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已剪切：' + c.name + '（粘贴以换位置）') }
async function pasteConfig(targetId, into = false) {
  const clip = cfgClip.value; if (!clip || !api) return
  let movingId
  if (clip.mode === 'copy') { const item = await api.store.saveConfig({ name: uniqueCfgName(copyNameOf(clip.name)), state: JSON.parse(JSON.stringify(clip.state)) }); movingId = item && item.id }
  else movingId = clip.id
  if (movingId) {
    const target = (targetId && targetId !== movingId) ? configs.value.find((c) => c.id === targetId) : null
    if (into && target && target.type === 'folder') await api.store.moveItem({ id: movingId, parentId: target.id, anchorId: null, position: 'inside' })
    else if (target) await api.store.moveItem({ id: movingId, parentId: null, anchorId: target.id, position: 'after' })
    else await api.store.moveItem({ id: movingId, parentId: null, anchorId: null, position: 'inside' })
    if (into && target && target.type === 'folder') { expandedFolders.value.add(target.id); persistExpanded() }
  }
  if (clip.mode === 'cut') cfgClip.value = null
  await loadConfigs(); toast('已粘贴')
}
function onCfgKey(e) {
  if (!(e.ctrlKey || e.metaKey)) return
  if (editing.id != null) return
  const t = e.target && e.target.tagName
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return
  const c = activeId.value && configs.value.find((x) => x.id === activeId.value)
  const k = e.key.toLowerCase()
  if (k === 'c') { if (c) { copyConfig(c); e.preventDefault() } }
  else if (k === 'x') { if (c) { cutConfig(c); e.preventDefault() } }
  else if (k === 'v') { if (cfgClip.value) { pasteConfig(activeId.value || null); e.preventDefault() } }
}
const ctxMenu = reactive({ open: false, x: 0, y: 0, configId: null })
const ctxConfig = computed(() => (ctxMenu.configId ? configs.value.find((c) => c.id === ctxMenu.configId) : null))
const ctxIsFolder = computed(() => !!(ctxConfig.value && ctxConfig.value.type === 'folder'))
function openCtx(e, c) { e.preventDefault(); ctxMenu.configId = c ? c.id : null; ctxMenu.x = Math.min(e.clientX, window.innerWidth - 170); ctxMenu.y = Math.min(e.clientY, window.innerHeight - 230); ctxMenu.open = true }
function ctxDo(fn) { ctxMenu.open = false; fn() }
// 指纹只取「场景内容」字段（库是全局资产、页签/结果列勾选是视图态，均不入指纹）
function fingerprintOf(s) {
  return stableStringify({ tx: s.tx, rx: s.rx, isl: s.isl, laser: s.laser, geoMode: s.geoMode || 'auto', geoHorizonHours: s.geoHorizonHours, linkMode: s.linkMode, hiddenModes: s.hiddenModes })
}
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
// dirtyFlag：顶栏「未保存」小灯的渲染缓存——随防抖存盘刷新，setBaseline 即刻清灯
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
function activeName() { const c = configs.value.find((x) => x.id === activeId.value); return c ? c.name : '' }
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function askLeave(name) { return new Promise((res) => { leaveDlg.name = name; leaveDlg.open = true; _leaveResolve = res }) }
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await askLeave(activeName())
  if (ans === 'cancel') return false
  if (ans === 'save') await updateConfig()
  return true
}
const deviceId = ref('')
const shareConfigured = ref(false)
// —— 分享 / 导入（弹窗与全部流程在 components/LbShareDialog.vue，三窗共用）——
// 本窗口只提供「体制适配层」：本机有哪些配置与库、场景引用了哪些条目、并库后怎么改写引用。
const shareOpen = ref(false)
function openShareDlg() { shareOpen.value = true }
const packBase = (c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })
// 卫星的 sanitize：ngsoSat.folder 是【本机】卫星树取星的节点 id（见 RegenSatPanel 的 tree 下拉），
// 原样发过去只会指到对端另一颗星上，故打包时清空并把 mode 由 'tree' 降为 'manual'——
// orbit / name / noradId 是自包含数据，照带不误，对端拿到的是「轨道齐全、取星来源标为手动」的自洽状态。
const shareLib = {
  es: { arr: esConfigs, label: '地球站', keys: [], pack: packBase, makeNew: () => makeEsConfig('站型') },
  carrier: { arr: basebandConfigs, label: '载波', keys: [], pack: packBase, makeNew: () => makeBasebandConfig('载波') },
  sat: {
    arr: satConfigs, label: '卫星群', keys: ['ngsoSat'],
    pack: (c) => ({ ...packBase(c), ngsoSat: normNgsoSat(c.ngsoSat) }),
    sanitize: (e) => {
      const ns = normNgsoSat(e.ngsoSat)
      return { ...e, ngsoSat: { ...ns, folder: '', mode: ns.mode === 'tree' ? 'manual' : (ns.mode || 'manual') } }
    },
    makeNew: () => makeSatConfig('卫星')
  }
}
// 再生式一个场景有四张表：地面上/下行（tx/rx）+ 星间微波（isl）+ 星间激光（laser）
function shareRefsOf(st) {
  if (!st || !(st.v >= 2)) return { es: [], carrier: [], sat: [] }
  const es = [], carrier = [], sat = []
  for (const r of [...(st.tx || []), ...(st.rx || [])]) { es.push(r.stationId || ''); carrier.push(r.basebandId || ''); sat.push(r.satelliteId || '') }
  for (const r of [...(st.isl || []), ...(st.laser || [])]) { carrier.push(r.basebandId || ''); sat.push(r.txSatelliteId || '', r.rxSatelliteId || '') }
  return { es, carrier, sat }
}
// 打包前把空引用钉成显式 id：'' 的意思是「用库里第一份」，到了对端就成了「用他库里第一份」
function sharePinRefs(st) {
  if (!st || !(st.v >= 2)) return st
  const s = JSON.parse(JSON.stringify(st))
  for (const r of [...(s.tx || []), ...(s.rx || [])]) {
    r.stationId = resolveRefId(esConfigs, r.stationId)
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
    r.satelliteId = resolveRefId(satConfigs, r.satelliteId)
  }
  for (const r of [...(s.isl || []), ...(s.laser || [])]) {
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
    r.txSatelliteId = resolveRefId(satConfigs, r.txSatelliteId)
    r.rxSatelliteId = resolveRefId(satConfigs, r.rxSatelliteId)
  }
  return s
}
function shareRemap(state, idMap) {
  if (!state) return
  for (const r of [...(state.tx || []), ...(state.rx || [])]) {
    if (r.stationId) r.stationId = idMap.es[r.stationId] || ''
    if (r.basebandId) r.basebandId = idMap.carrier[r.basebandId] || ''
    if (r.satelliteId) r.satelliteId = idMap.sat[r.satelliteId] || ''
  }
  for (const r of [...(state.isl || []), ...(state.laser || [])]) {
    if (r.basebandId) r.basebandId = idMap.carrier[r.basebandId] || ''
    if (r.txSatelliteId) r.txSatelliteId = idMap.sat[r.txSatelliteId] || ''
    if (r.rxSatelliteId) r.rxSatelliteId = idMap.sat[r.rxSatelliteId] || ''
  }
}
const shareCtx = {
  mod: 'REGEN',
  getConfigs: () => configs.value,
  getActiveId: () => activeId.value,
  getDraft: () => ({ name: defaultCfgName(), state: serializeState() }),
  lib: shareLib,
  refsOf: shareRefsOf,
  pinRefs: sharePinRefs,
  remapState: shareRemap,
  saveConfig: (payload) => api.store.saveConfig(payload),
  flushLib: flushLibSave,
  onImported: async ({ last, plan, idMap }) => {
    await loadConfigs()
    if (last) {
      activeId.value = last.id
      applyState(last.state)
      setBaseline()
      const byId = new Map(configs.value.map((c) => [c.id, c]))
      const add = []
      let p = byId.get(last.id) && byId.get(last.id).parentId
      while (p && byId.has(p)) { add.push(p); p = byId.get(p).parentId }
      if (add.length) { expandedFolders.value = new Set([...expandedFolders.value, ...add]); persistExpanded() }
    } else {
      const first = plan.lib.find((r) => r.action === 'new')
      if (first) {
        sideView.value = 'library'
        libTab.value = first.kind === 'es' ? 'station' : first.kind
        const nid = idMap[first.kind][first.srcId]
        if (first.kind === 'es') selEsId.value = nid
        else if (first.kind === 'sat') selSatId.value = nid
        else selBbId.value = nid
      }
    }
  }
}

// ============ 报表语言与报告导出 ============
// 报表语言跟随平台语言（设置▸语言），不再单独设一档：一个软件只有一种语言，
// 屏幕上核对的、详细预算区显示的、交出去的报表，三者必然是同一种。
const reportLang = ref(getLang())
onLangChange((v) => { reportLang.value = v })
watch(reportLang, () => {
  loadWaterfall()   // 段标题/行标签是 core 取数时按 lang 翻好的，换语言得重取一次
})
// 自动命名的库条目跟着换语言：它们的名字是生成时按语言出的字（呈现层翻不到），换了语言得重出一次。
// 只动 nameAuto 的条目，用户起过的名字一律不碰（syncAutoNames 幂等，重跑无副作用）。
onLangChange(() => {
  syncAutoNames(basebandConfigs, 'carrier'); syncAutoNames(esConfigs, 'es'); syncAutoNames(satConfigs, 'sat')
})
// 交付级报告：流程在 shared/useLbReport.js（三窗共用），此处只接本窗数据源。
// 再生式一份报告只讲一段链路（上行 / 下行 / 星间微波 / 星间激光），故 regenMode 随当前体制走；
// 几何上下文分两族：地面-空间（上/下行）传 geom+access+staGeo，空间-空间（星间）传 islGeo。
const vizRef = ref(null)
const appVersion = ref('')
const REGEN_MODE_LABEL = {
  uplink: ['给定工作点', 'Given operating point'],
  downlink: ['给定工作点 G/T', 'Given G/T operating point'],
  isl: ['给定 EIRP/G-T + 严格几何', 'Given EIRP/GT + rigorous geometry'],
  laser: ['给定速率 + 光学功率预算', 'Given rate + optical power budget']
}
const REGEN_FILE_NAME = {
  uplink: ['再生式上行链路预算报告', 'Regen_Uplink_Report'],
  downlink: ['再生式下行链路预算报告', 'Regen_Downlink_Report'],
  isl: ['再生式星间链路预算报告', 'Regen_ISL_Report'],
  laser: ['再生式激光星间链路预算报告', 'Regen_Laser_ISL_Report']
}
const { reportDlg, openReportDialog, runReport } = useLbReport({
  api,
  orbitType: 'REGEN',
  regenMode: () => linkMode.value,
  fieldGroups: FIELD_GROUPS,
  nextTick,
  links: () => links.value,
  selected: () => selected.value,
  setSelected: (i) => { selected.value = i },
  showViz: () => showViz.value,
  vizRef: () => vizRef.value,
  lang: () => reportLang.value,
  appVersion: () => appVersion.value,
  paramsFor: (l) => sweepParamsByRow.value[l.rowId] || null,
  // 「计算方式」一栏报的是链路类型（再生式上行/下行/星间）；求解策略随载波逐链路而定，另占「求解方式」一行
  // （取计算时留底的那份入参，此后改库不改已出结果的口径）。星间/激光无此栏——工作点由链路自身参数给定。
  calcFor: (l) => {
    const p = l && sweepParamsByRow.value[l.rowId]
    const key = (p && p.opt && p.opt.mode) || ''
    const info = CALC_MODES.find((m) => m.key === key)
    if (!info) return {}
    return {
      solveMode: reportLang.value === 'en' ? info.enLabel : info.label,
      targetMargin: key === 'margin' ? ((p.linkParams && p.linkParams.margin) || '') : ''
    }
  },
  calc: () => {
    const en = reportLang.value === 'en'
    const m = REGEN_MODE_LABEL[linkMode.value] || REGEN_MODE_LABEL.uplink
    return {
      mode: en ? m[1] : m[0],
      satelliteName: (satConfigs[0] && satConfigs[0].form.satelliteName) || '',
      frequencyBand: (satConfigs[0] && satConfigs[0].form.frequencyBand) || ''
    }
  },
  extraLink: (l) => {
    const mode = linkMode.value
    const isDown = mode === 'downlink'
    const isSpace = mode === 'isl' || mode === 'laser'
    const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : null)
    // 站址透传（上行取发信站、下行取收信站）→「几何关系」sheet 按 STK 口径标注坐标/最低仰角
    let staGeo = null
    if (!isSpace) {
      if (isDown) { const st = rxStations[l.ti] || {}; staGeo = { name: l.txName, lat: parseFloat(st.rxLatitude), lon: parseFloat(st.rxLongitude), altM: parseFloat(st.rxAltitude) || 0, minEl: parseFloat(st.rxMinElevation) || 0 } }
      else { const st = txStations[l.ti] || {}; staGeo = { name: l.txName, lat: parseFloat(st.latitude), lon: parseFloat(st.longitude), altM: parseFloat(st.altitude) || 0, minEl: parseFloat(st.minElevation) || 0 } }
    }
    return {
      // 下行的信号流向是「卫星 → 收信站」，链路两端名字据此对调（与结果区一致）
      txName: isDown ? l.satName : l.txName,
      rxName: isDown ? l.txName : l.satName,
      geom: clone(l.geom), islGeo: clone(l.islGeo), access: clone(l.access),
      staGeo, satName: l.satName
    }
  },
  defaultName: (en) => {
    const n = REGEN_FILE_NAME[linkMode.value] || REGEN_FILE_NAME.uplink
    const s = (satConfigs[0] && satConfigs[0].form.satelliteName) || (en ? 'Results' : '结果')
    return en ? `${n[1]}_${s.replace(/[^\w-]+/g, '_')}` : `${n[0]}_${s.replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  setError: (m) => { error.value = m }
})

// ============ 城市库 + 启动恢复 + 关窗守卫 ============
const cities = ref([])
onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  // 全局库先于配置载入（场景行引用靠库解析）；库为空 = 首次运行/升级首启 → 保持默认三库、随后落盘
  try { const lib = api && await api.store.getLibrary(LIB_NS); if (lib) applyLibrary(lib) } catch (e) { /* 保持默认库 */ }
  _libLoaded = true
  scheduleLibSave()   // 首启把默认库落盘；已有库则等值覆写无害
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      // 基线取「规整后的已存配置」：先 applyState(c.state) 走一遍与实时相同的规整管线再 setBaseline，
      // 而非直接指纹原始 c.state——否则旧版本配置一打开就因补默认/裁字段被误判「已改」。
      // 随后 applyState(st) 恢复上次会话（可能含未保存编辑）：若 st 与已存配置一致则判定干净、不误报；
      // 若确有未保存改动，实时指纹与基线不同，仍会正确提示保存。
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
    }
  } catch (e) { /* ignore */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  api?.regen?.onCloseRequested?.(async () => { if (!(await guardedLeave())) return; await flushLibSave(); api.regen.confirmClose() })
  window.addEventListener('keydown', onGlobalKey)   // Ctrl+Enter = 计算（按体制分发）
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <div class="lb-body">
      <!-- ① 左侧栏：配置列表 / 资源库 二选一（功能区「文件 › 配置列表」「视图 › 资源库」开关，右缘可拖宽） -->
      <aside v-show="sideView" class="lb-col lb-side" :class="[sideView === 'library' ? 'lb-lib' : 'lb-configs', { resizing: sideResizing }]" :style="{ width: sideWidth + 'px' }">
        <!-- ①-A 配置列表视图：场景文件树 -->
        <template v-if="sideView !== 'library'">
          <div class="lb-col-hd">
            <span class="lb-cfg-hd-t">配置列表</span>
            <span class="lb-cfg-acts">
              <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="sideView = ''"><Icon name="x" :size="13" /></button>
            </span>
          </div>
          <div class="lb-col-bd" tabindex="0" @keydown="onCfgKey" @contextmenu="openCtx($event, null)">
            <ConfigTree
              :items="configs" :active-id="activeId" :editing-id="editing.id" :editing-name="editing.name"
              :expanded="expandedFolders"
              :cut-id="cfgClip && cfgClip.mode === 'cut' ? cfgClip.id : null"
              @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove"
              @add-folder="addFolder" @add-config="addBlankConfig" @context="openCtx"
              @rename-start="startRename" @rename-input="editing.name = $event" @rename-commit="commitRename" @rename-cancel="cancelRename"
            />
          </div>
          <div v-if="deviceId" class="lb-myid" :title="'本机用户 ID（用于在线分享）'">本机标识：<b>{{ deviceId }}</b></div>
        </template>

        <!-- ①-B 资源库视图：地球站 / 卫星 / 载波三库主从管理（全局资产，改动实时保存并影响所有引用场景） -->
        <template v-else>
          <div class="lb-col-hd">
            <span class="lb-cfg-hd-t">资源库</span>
            <span class="lb-cfg-acts">
              <button class="lb-mini lb-mini-ico" :title="`新增${(LIB_TABS.find((t) => t.key === libTab) || {}).label}配置`"
                @click="libTab === 'station' ? addEsConfig() : libTab === 'sat' ? addSatConfig() : addBasebandConfig()"><Icon name="plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏资源库" @click="sideView = ''"><Icon name="x" :size="13" /></button>
            </span>
          </div>
          <nav class="lb-lib-tabs">
            <button v-for="t in LIB_TABS" :key="t.key" class="lbx-subtab" :class="{ on: libTab === t.key }" :title="t.tip" @click="libTab = t.key">
              {{ t.label }}<span class="lbx-tab-n">{{ t.key === 'station' ? esConfigs.length : t.key === 'sat' ? satConfigs.length : basebandConfigs.length }}</span>
            </button>
          </nav>
          <div class="lb-libpane">
            <LbLibrary v-if="libTab === 'station'" v-model="selEsId" layout="column" :items="esConfigs" :summary="esSummary" name-placeholder="站型名称"
              auto-tip="天线口径" @add="addEsConfig" @duplicate="duplicateEsConfig" @remove="removeEsConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此配置" @click="duplicateEsConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="esConfigs.length <= 1" @click="removeEsConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><EarthStationPanel :form="cfg.form" :common-fields="ES_COMMON_FIELDS" :tx-fields="ES_TX_FIELDS" :rx-fields="ES_RX_FIELDS" /></template>
            </LbLibrary>
            <LbLibrary v-else-if="libTab === 'sat'" v-model="selSatId" layout="column" :items="satConfigs" :summary="satSummary" name-placeholder="卫星名（列表用）"
              auto-tip="所选卫星" @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此卫星" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此卫星（被引用时提示引用数）" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <!-- 取星只定轨道（卫星/天线树 / 星历搜索）；EIRP·G/T 逐行手填 -->
              <template #default="{ cfg }"><RegenSatPanel :form="cfg.form" :fields="SAT_FIELDS" :ngso-sat="cfg.ngsoSat" :sat-tree="satTree" /></template>
            </LbLibrary>
            <LbLibrary v-else v-model="selBbId" layout="column" :items="basebandConfigs" :summary="bbSummary" name-placeholder="载波名称"
              auto-tip="速率与调制" @add="addBasebandConfig" @duplicate="duplicateBasebandConfig" @remove="removeBasebandConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此配置" @click="duplicateBasebandConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="basebandConfigs.length <= 1" @click="removeBasebandConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><BasebandPanel :form="cfg.form" :options="basebandOpts" :calc-modes="CALC_MODES" /></template>
            </LbLibrary>
          </div>
          <div class="lb-lib-foot" :title="(LIB_TABS.find((t) => t.key === libTab) || {}).tip">{{ (LIB_TABS.find((t) => t.key === libTab) || {}).tip }}</div>
        </template>

        <!-- 右缘拖拽调宽手柄（两视图各记各的宽度） -->
        <div class="lb-cfg-resizer" :title="sideView === 'library' ? '拖动调整资源库栏宽度' : '拖动调整配置栏宽度'" @mousedown.prevent="startResizeSide"></div>
      </aside>

      <!-- ② 主区：MATLAB 式功能区 + 停靠面板 -->
      <section class="lb-col lb-build">
        <!-- 功能区：文件 · 计算 · 视图 · 导出 ‖ 状态位（计算方式随载波入资源库，功能区只留执行） -->
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" @click="saveCurrent">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
                保存<span v-if="dirtyFlag" class="lbx-dirty" title="有未保存的修改"></span>
              </button>
              <button class="lbr-big" :disabled="!api" title="分享 / 导入：配置（可多选）+ 资源库条目（可多选）——分享码 / 文件 / 发给用户ID" @click="openShareDlg"><Icon name="external-link" :size="15" />分享</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（卫星/天线树 / 城市库 / 载波信号选项 等）" @click="refreshLatest">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :title="sideView === 'configs' ? '隐藏左侧「配置列表」栏（腾出工作区宽度）' : '左侧栏显示「配置列表」（场景文件树；与「资源库」二选一）'" @click="toggleSide('configs')"><Icon name="panel-left" :size="15" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <div class="lbr-form">
                <label title="几何来源（四种体制统一）：自动最差＝按卫星轨道解最差工况几何（星地：仰角字段作门限、斜距由求解器给出；星间：两星轨道解最差星间距离与互视可见度）；手动＝星地斜距与星间链路距离由表内逐行给定，不解算轨道"><span>几何</span>
                  <select v-model="geoMode" style="width: 86px"><option v-for="g in GEO_MODES" :key="g.v" :value="g.v">{{ g.l }}</option></select>
                </label>
                <label v-if="!geoManual" title="在此时窗内求几何最差工况并列出全部满足最低仰角的访问窗口（选星走 SGP4；手动圆轨道为示意）"><span>时窗</span>
                  <select v-model.number="geoHorizonHours" style="width: 76px"><option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option></select>
                </label>
                <label title="功放与余量随站型设置——在各站所选「地球站配置」的发射参数（工作点）中"><span>工作点</span><span class="lbr-u">随站型</span></label>
              </div>
              <button class="lbr-big primary" :disabled="computing" :title="`计算全部 ${nLinks} 条${modeLabel}链路（Ctrl+Enter）`" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
            </div>
            <div class="lbr-cap">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ on: sideView === 'library' }" :title="`${sideView === 'library' ? '隐藏' : '左侧栏显示'}「资源库」：地球站 ${esConfigs.length} · 卫星群 ${satConfigs.length} · 载波 ${basebandConfigs.length}（全局资产，场景按 id 引用；与「配置列表」二选一）`" @click="toggleSide('library')"><Icon name="folder-open" :size="15" />资源库</button>
              <button class="lbr-big" :class="{ on: showViz }" :title="showViz ? '隐藏详细预算的图表区（地理场图 + 链路视图）' : '显示详细预算的图表区：链路视图（3D 站星几何）+ 地理场图（站址经纬度；星间无地面站，只出链路视图）'" @click="showViz = !showViz"><Icon name="chart-line" :size="15" />图表</button>
            </div>
            <div class="lbr-cap">视图</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="reportDlg.busy || !links.length" :title="links.length ? '生成交付级报告：Excel（总报告 + 几何关系 + 逐链路详情）/ PDF（封面 · 目录 · 总报告 · 逐链路详情，含图）' : '尚无计算结果'" @click="openReportDialog"><Icon name="file-down" :size="15" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
              <button class="lbr-big" :disabled="!segments.length" title="复制当前瀑布表（TSV，可直接粘贴到 Excel / 报告）" @click="copyWaterfallTsv"><Icon name="file-text" :size="15" />TSV</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <LbFontCtl />
          <div class="lbr-status">
            <span v-if="notice" class="lb-note">{{ notice }}</span>
            <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
            <span v-if="resultsStale && links.length" class="lbx-stale" title="计算输入已被修改，结果列与详细预算对应修改前的参数">输入已变</span>
          </div>
        </div>

        <!-- 链路工作台：体制标签栏 + 全宽横向分区（当前模式链路表 → 详细预算），计算栏吸底 -->
        <div class="rlmode">
          <div v-for="m in visibleModes" :key="m.key" class="rlmode-i" :class="{ on: linkMode === m.key, disabled: !m.ready }" :title="m.tip"
               @click="m.ready ? (linkMode = m.key) : null">
            <span class="rlmode-lbl">{{ m.label }}</span><span v-if="!m.ready" class="rlmode-todo">开发中</span>
            <span v-if="visibleModes.length > 1" class="rlmode-x" title="关闭该模式（可从「+」恢复）" @click.stop="requestHideMode(m)">
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" /></svg>
            </span>
          </div>
          <div v-if="hiddenModeList.length" class="rlmode-add-wrap">
            <button class="rlmode-add" :class="{ on: addMenuOpen }" title="恢复已关闭的再生式模式" @click.stop="addMenuOpen = !addMenuOpen">
              <svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 2v8M2 6h8" /></svg>
            </button>
            <template v-if="addMenuOpen">
              <div class="rlmode-menu-mask" @click="addMenuOpen = false"></div>
              <div class="rlmode-menu" @click.stop>
                <div class="rlmode-menu-hd">恢复模式</div>
                <button v-for="m in hiddenModeList" :key="m.key" class="rlmode-menu-i" @click="restoreMode(m)">{{ m.label }}</button>
              </div>
            </template>
          </div>
        </div>

        <!-- 全宽分区流：当前模式的链路表分区 → 详细预算分区 -->
        <div ref="flowEl" class="lbx-flow lbx-cards">
          <LbSection v-if="linkMode === 'uplink'" id="tx" title="发信站群" :count="txStations.length" summary="一行一站：站址 + 库引用 + 结果列">
            <template #actions>
              <button v-if="geoManual" class="lb-mini" title="斜距工具：按轨道高度 × 仰角算斜距，可按各行仰角批量填入「斜距」列" @click="slantToolOpen = true">斜距工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys[linkMode].includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                  <div class="lbx-ccf">
                    <div class="lbx-ccf-hd"><span>自定义列</span>
                      <button class="lbx-ccf-btn" title="新建/编辑/删除自定义列（独立窗口，误点不丢）" @click="ccDlgOpen = true; colPickOpen = false">{{ (customColsBy[linkMode] || []).length ? '管理…' : '＋ 新建…' }}</button></div>
                    <label v-for="c in customColsBy[linkMode]" :key="c.id" class="lbx-colpick-i" :title="c.expr">
                      <input type="checkbox" :checked="c.on !== false" @change="toggleCustomCol(c.id)" />
                      <span>{{ c.label }}<i v-if="ccUnit(c)"> ({{ ccUnit(c) }})</i></span>
                    </label>
                  </div>
                </div>
              </span>
            </template>
            <div class="tx-optbar">
              <span class="tx-optl">工作点</span>
            </div>
            <div class="lbx-grid">
              <StationGrid :stations="txStations" :fields="txGridFields" :groups="GROUPS_STATION" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cell-sub="txCellSub" :cell-tag="txCellTag" :cities="cities" :city-search="citySearch" label="发信站" :auto-geo="autoGeoTx" :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, satelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', stationId: 'station', satelliteId: 'sat' }" @edit-lib="editInLibrary" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :cap="capacitySummary" :cap-main="capMain" :bw-main="bwMain" :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'downlink'" id="rx" title="收信站群" :count="rxStations.length" summary="一行一站：站址 + 库引用 + 结果列">
            <template #actions>
              <button v-if="geoManual" class="lb-mini" title="斜距工具：按轨道高度 × 仰角算斜距，可按各行仰角批量填入「斜距」列" @click="slantToolOpen = true">斜距工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys[linkMode].includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                  <div class="lbx-ccf">
                    <div class="lbx-ccf-hd"><span>自定义列</span>
                      <button class="lbx-ccf-btn" title="新建/编辑/删除自定义列（独立窗口，误点不丢）" @click="ccDlgOpen = true; colPickOpen = false">{{ (customColsBy[linkMode] || []).length ? '管理…' : '＋ 新建…' }}</button></div>
                    <label v-for="c in customColsBy[linkMode]" :key="c.id" class="lbx-colpick-i" :title="c.expr">
                      <input type="checkbox" :checked="c.on !== false" @change="toggleCustomCol(c.id)" />
                      <span>{{ c.label }}<i v-if="ccUnit(c)"> ({{ ccUnit(c) }})</i></span>
                    </label>
                  </div>
                </div>
              </span>
            </template>
            <div class="tx-optbar">
              <span class="tx-optl">工作点 G/T</span>
            </div>
            <div class="lbx-grid">
              <StationGrid :stations="rxStations" :fields="rxGridFields" :groups="GROUPS_STATION" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cell-sub="rxCellSub" :cities="cities" :city-search="citySearch" label="收信站" :auto-geo="autoGeoRx" :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, satelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', stationId: 'station', satelliteId: 'sat' }" @edit-lib="editInLibrary" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :cap="capacitySummary" :cap-main="capMain" :bw-main="bwMain" :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'isl'" id="isl" title="星间链路群" :count="islLinks.length" :summary="geoManual ? '一行一条：星间链路距离 + 星间参数 + 结果列' : '一行一条：发射星 → 接收星 + 结果列'">
            <template #actions>
              <button v-if="geoManual" class="lb-mini" title="星间链路距离工具：两颗卫星在时间轴上的星间距离，可填入「星间链路距离」列" @click="islToolOpen = true">距离工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys[linkMode].includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                  <div class="lbx-ccf">
                    <div class="lbx-ccf-hd"><span>自定义列</span>
                      <button class="lbx-ccf-btn" title="新建/编辑/删除自定义列（独立窗口，误点不丢）" @click="ccDlgOpen = true; colPickOpen = false">{{ (customColsBy[linkMode] || []).length ? '管理…' : '＋ 新建…' }}</button></div>
                    <label v-for="c in customColsBy[linkMode]" :key="c.id" class="lbx-colpick-i" :title="c.expr">
                      <input type="checkbox" :checked="c.on !== false" @change="toggleCustomCol(c.id)" />
                      <span>{{ c.label }}<i v-if="ccUnit(c)"> ({{ ccUnit(c) }})</i></span>
                    </label>
                  </div>
                </div>
              </span>
            </template>
            <div class="lbx-grid">
              <StationGrid :stations="islLinks" :fields="islGridFields" :groups="GROUPS_ISL" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cities="cities" :city-search="citySearch" label="星间链路" :show-import="false" :select-options="{ basebandId: basebandSelectOptions, txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', txSatelliteId: 'sat', rxSatelliteId: 'sat' }" @edit-lib="editInLibrary" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :cap="capacitySummary" :cap-main="capMain" :bw-main="bwMain" :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'laser'" id="laser" title="星间激光链路群" :count="laserLinks.length" :summary="geoManual ? '一行一条：星间链路距离 + 激光参数 + 结果列' : '一行一条：发射星 → 接收星 + 结果列'">
            <template #actions>
              <button v-if="geoManual" class="lb-mini" title="星间链路距离工具：两颗卫星在时间轴上的星间距离，可填入「星间链路距离」列" @click="islToolOpen = true">距离工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys[linkMode].includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                  <div class="lbx-ccf">
                    <div class="lbx-ccf-hd"><span>自定义列</span>
                      <button class="lbx-ccf-btn" title="新建/编辑/删除自定义列（独立窗口，误点不丢）" @click="ccDlgOpen = true; colPickOpen = false">{{ (customColsBy[linkMode] || []).length ? '管理…' : '＋ 新建…' }}</button></div>
                    <label v-for="c in customColsBy[linkMode]" :key="c.id" class="lbx-colpick-i" :title="c.expr">
                      <input type="checkbox" :checked="c.on !== false" @change="toggleCustomCol(c.id)" />
                      <span>{{ c.label }}<i v-if="ccUnit(c)"> ({{ ccUnit(c) }})</i></span>
                    </label>
                  </div>
                </div>
              </span>
            </template>
            <div class="lbx-grid">
              <StationGrid :stations="laserLinks" :fields="laserGridFields" :groups="GROUPS_LASER" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cities="cities" :city-search="citySearch" label="激光星间链路" :show-import="false" :select-options="{ txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" :lib-fields="{ txSatelliteId: 'sat', rxSatelliteId: 'sat' }" @edit-lib="editInLibrary" @row-focus="onRowFocus" />
            </div>
            <!-- 激光星间不出容量汇总（载波带宽/频谱效率口径不适用），但本行读数照给 -->
            <LbCapFoot :readout="rowReadout" />
          </LbSection>
          <LbSection id="detail" title="详细预算" :summary="sel && links.length ? pairLabel(sel) : ''">
            <div v-if="error" class="lb-err">{{ error }}</div>
            <div v-else-if="!links.length" class="lb-placeholder">尚无预算结果。</div>
            <div v-else-if="sel && sel.error" class="lb-err">链路 {{ pairLabel(sel) }} 计算失败：{{ sel.error }}</div>
            <div v-else-if="core" class="lbx-doc">

            <!-- 几何/访问窗口：预算文档以瀑布为主角，几何收进可折叠小节（记忆展开态），头部常显摘要。
                 手动几何（斜距/星间链路距离由表内给定）压根没有解算出来的几何 → 整节不出，不留空壳标题。 -->
            <div v-if="islGeo || geom || access" class="lbx-fold">
              <div class="lbx-fold-hd" :class="{ closed: geoFold }" @click="geoFold = !geoFold">
                <span class="chev"><Icon name="chevron-down" :size="12" /></span>
                <span>{{ linkMode === 'isl' || linkMode === 'laser' ? '星间几何 · 互视' : '站星几何 · 访问窗口' }}</span>
                <span class="lbx-fold-sum">{{ geoFoldSum }}</span>
              </div>
              <div v-show="!geoFold" class="lbx-fold-bd">
            <!-- 星间几何 + 互视可见度（两星微波 ISL，最差工况）-->
            <div v-if="islGeo && islGeo.feasible" class="geo-card">
              <div class="geo-top">
                <div class="geo-title">
                  <span class="geo-tt">星间几何（最差工况）</span>
                  <span class="geo-badge" :title="islGeo.representative ? '手动圆轨道：几何示意' : '双 SGP4/SDP4 传播 + 地球临边遮挡'">{{ islGeo.method }}</span>
                </div>
                <div class="geo-tz" role="group" aria-label="时区切换">
                  <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                  <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                </div>
              </div>
              <div class="geo-body">
                <div v-if="islGeo.worst.worstISO && !islGeo.representative" class="geo-row"><span class="geo-l" title="所有几何量取自这一物理瞬间（互视样本中星间距离最大 → 最差 FSL）">最差时刻 t*</span><span class="geo-v" style="white-space:normal">{{ fmtInstant(islGeo.worst.worstISO, tzMode) }}</span></div>
                <div class="geo-row"><span class="geo-l">星间距离（最差）</span><span class="geo-v">{{ g2(islGeo.worst.rangeKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">最近星间距离</span><span class="geo-v">{{ g2(islGeo.worst.minRangeKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">发射/接收卫星高度</span><span class="geo-v">{{ g2(islGeo.worst.txAltKm, 1) }} / {{ g2(islGeo.worst.rxAltKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">地心夹角</span><span class="geo-v">{{ g2(islGeo.worst.centralAngleDeg) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">LOS 掠地高度</span><span class="geo-v">{{ g2(islGeo.worst.grazAltKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">单程链路时延</span><span class="geo-v">{{ g2(islGeo.worst.oneWayDelayMs, 3) }}<i>ms</i></span></div>
                <div class="geo-row"><span class="geo-l" title="全搜索时窗内两星径向相对速度的峰值（决定最大多普勒）；轨道周期性复现量，与搜索起点无关，多次计算复现">最大距离变化率</span><span class="geo-v">{{ g2(islGeo.worst.rangeRateKmS, 4) }}<i>km/s</i></span></div>
                <div v-if="linkMode === 'laser'" class="geo-row"><span class="geo-l">相干多普勒 Δf</span><span class="geo-v">±{{ g2(islGeo.worst.maxDopplerHz / 1e9, 3) }}<i>GHz</i></span></div>
                <div v-else class="geo-row"><span class="geo-l">最大多普勒</span><span class="geo-v">±{{ g2(islGeo.worst.maxDopplerHz / 1000, 3) }}<i>kHz</i></span></div>

                <div class="geo-sec">互视可见度<span class="geo-sec-x">LOS 须清过地表 + 大气余量 {{ islGeo.search.atmMarginKm }}km</span></div>
                <div class="acc-sum">
                  时窗 {{ islGeo.search.horizonHours }}h 内可见 <b>{{ (islGeo.visibility.visibleFrac * 100).toFixed(1) }}%</b> · 互视窗口 <b>{{ islGeo.visibility.totalWindows }}</b> 次 · 合计 <b>{{ fmtDur(islGeo.visibility.totalVisibleMin) }}</b>
                  <span v-if="islGeo.representative" class="acc-note">（手动轨道·示意）</span>
                </div>
                <div v-if="islGeo.visibility.windows && islGeo.visibility.windows.length" class="acc-list">
                  <div class="acc-hd"><span class="acc-c1">#</span><span class="acc-c2">开始（{{ tzSuffix }}）</span><span class="acc-c3">时长</span><span class="acc-c4">最大距离</span></div>
                  <div v-for="(w, wi) in islGeo.visibility.windows" :key="wi" class="acc-row">
                    <span class="acc-c1">{{ wi + 1 }}</span>
                    <span class="acc-c2 mono">{{ fmtInstant(w.startISO, tzMode) }}<em v-if="w.clipped" class="acc-clip" title="窗口被搜索时窗边界截断">clip</em></span>
                    <span class="acc-c3 mono">{{ fmtDur(w.durationMin) }}</span>
                    <span class="acc-c4 mono">{{ g2(w.maxRangeKm, 0) }} km</span>
                  </div>
                </div>

                <!-- 两星轨道与运动（合并入星间几何卡，发射 / 接收两列，NGSO 式分节）-->
                <div class="geo-sec" v-if="islGeo.elements && (islGeo.elements.tx || islGeo.elements.rx)">两星轨道与运动<span class="geo-sec-x">发射 / 接收各一列</span></div>
                <div v-if="islGeo.elements && (islGeo.elements.tx || islGeo.elements.rx)" class="geo-2col">
                  <div v-for="side in [{ k: 'tx', name: sel.txName, alt: islGeo.worst.txAltKm, spd: islGeo.worst.txSpeedKmS, gspd: islGeo.worst.txGroundSpeedKmS, el: islGeo.elements.tx }, { k: 'rx', name: sel.satName, alt: islGeo.worst.rxAltKm, spd: islGeo.worst.rxSpeedKmS, gspd: islGeo.worst.rxGroundSpeedKmS, el: islGeo.elements.rx }]" :key="side.k" class="geo-col">
                    <div class="geo-col-hd" :class="side.k">{{ side.k === 'tx' ? '发射卫星' : '接收卫星' }}<em data-i18n-skip>{{ side.name }}</em></div>
                    <template v-if="side.el">
                      <div class="geo-sec">卫星运动</div>
                      <div class="geo-row"><span class="geo-l">轨道速度<i>惯性系</i></span><span class="geo-v">{{ g2(side.spd, 3) }}<i>km/s</i></span></div>
                      <div v-if="side.gspd != null" class="geo-row"><span class="geo-l">相对地面速度</span><span class="geo-v">{{ g2(side.gspd, 3) }}<i>km/s</i></span></div>
                      <div class="geo-row"><span class="geo-l">卫星高度</span><span class="geo-v">{{ g2(side.alt, 1) }}<i>km</i></span></div>
                      <div class="geo-sec">卫星轨道根数<span class="geo-sec-x">{{ side.el.satnum == null ? '虚拟圆轨道' : '历元' }}</span></div>
                      <div class="geo-row"><span class="geo-l">半长轴 a</span><span class="geo-v">{{ g2(side.el.a, 3) }}<i>km</i></span></div>
                      <div class="geo-row"><span class="geo-l">偏心率 e</span><span class="geo-v">{{ g2(side.el.e, 6) }}</span></div>
                      <div class="geo-row"><span class="geo-l">倾角 i</span><span class="geo-v">{{ g2(side.el.iDeg, 4) }}<i>°</i></span></div>
                      <div class="geo-row"><span class="geo-l">升交点赤经 Ω</span><span class="geo-v">{{ g2(side.el.raanDeg, 4) }}<i>°</i></span></div>
                      <div class="geo-row"><span class="geo-l">近地点幅角 ω</span><span class="geo-v">{{ g2(side.el.argpDeg, 4) }}<i>°</i></span></div>
                      <div class="geo-row"><span class="geo-l">平近点角 M</span><span class="geo-v">{{ g2(side.el.maDeg, 4) }}<i>°</i></span></div>
                      <div class="geo-row"><span class="geo-l">平均运动 n</span><span class="geo-v">{{ g2(side.el.meanMotionRevDay, 6) }}<i>rev/day</i></span></div>
                      <div class="geo-row"><span class="geo-l">轨道周期 T</span><span class="geo-v">{{ g2(side.el.periodMin, 3) }}<i>min</i></span></div>
                      <div class="geo-row"><span class="geo-l">近/远地点高度</span><span class="geo-v">{{ g2(side.el.perigeeAltKm, 1) }} / {{ g2(side.el.apogeeAltKm, 1) }}<i>km</i></span></div>
                      <div v-if="side.el.satnum" class="geo-row"><span class="geo-l">卫星编号 (NORAD)</span><span class="geo-v">{{ side.el.satnum }}</span></div>
                    </template>
                    <div v-else class="geo-col-na">静态几何（无轨道根数）</div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 访问窗口（满足最低仰角及以上的全部过境）-->
            <div v-if="access" class="geo-card">
              <div class="geo-top">
                <div class="geo-title">
                  <span class="geo-tt">访问窗口</span>
                  <span class="geo-badge" :title="access.representative ? '手动圆轨道：过境节律/时长真实，绝对时刻仅示意' : '平台精确传播器 SGP4/SDP4'">{{ access.method }}{{ access.representative ? ' · 示意' : '' }}</span>
                </div>
                <div class="geo-tz" role="group" aria-label="时区切换">
                  <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                  <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                </div>
              </div>
              <div class="geo-body">
                <div v-if="access.feasible" class="acc-sum">
                  时窗 {{ (access.search && access.search.horizonHours) || geoHorizonHours }}h 内共 <b>{{ access.totalWindows }}</b> 次过境（≥最低仰角 {{ access.search && access.search.minElevDeg }}°）· 合计可视 <b>{{ fmtDur(access.totalDurationMin) }}</b>
                  <span v-if="access.representative" class="acc-note">（手动轨道·时刻示意）</span>
                </div>
                <div v-else class="acc-none">{{ access.reason || '时窗内不可见' }}</div>
                <div v-if="access.feasible && access.windows && access.windows.length" class="acc-list">
                  <div class="acc-hd"><span class="acc-c1">#</span><span class="acc-c2">开始（{{ tzSuffix }}）</span><span class="acc-c3">时长</span><span class="acc-c4">峰值仰角</span></div>
                  <div v-for="(w, wi) in access.windows" :key="wi" class="acc-row">
                    <span class="acc-c1">{{ wi + 1 }}</span>
                    <span class="acc-c2 mono">{{ fmtInstant(w.startISO, tzMode) }}<em v-if="w.clipped" class="acc-clip" title="窗口被搜索时窗边界截断">clip</em></span>
                    <span class="acc-c3 mono">{{ fmtDur(w.durationMin) }}</span>
                    <span class="acc-c4 mono">{{ g2(w.peakElevDeg, 1) }}°</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- 站星几何（最差工况）-->
            <div v-if="geom && geom.feasible" class="geo-card">
              <div class="geo-top">
                <div class="geo-title">
                  <span class="geo-tt">站星几何（最差工况）</span>
                  <span class="geo-badge">{{ geom.method }}</span>
                </div>
              </div>
              <div class="geo-body">
                <div class="geo-row"><span class="geo-l">对卫星仰角</span><span class="geo-v">{{ g2(geom.worst.up.elevDeg) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">星地斜距</span><span class="geo-v">{{ g2(geom.worst.up.slantKm) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">卫星高度</span><span class="geo-v">{{ g2(geom.worst.up.altKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">覆盖地心半角</span><span class="geo-v">{{ g2(geom.worst.up.coverageHalfAngleDeg) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">地面覆盖半径</span><span class="geo-v">{{ g2(geom.worst.up.coverageRadiusKm, 1) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">最大过境时长</span><span class="geo-v" :class="{ 'geo-inf': geom.worst.up.maxPassMin == null }">{{ gPass(geom.worst.up.maxPassMin) }}<i v-if="geom.worst.up.maxPassMin != null">min</i></span></div>
                <div class="geo-row"><span class="geo-l">单程链路时延</span><span class="geo-v">{{ g2(geom.worst.oneWayDelayMs, 3) }}<i>ms</i></span></div>

                <div class="geo-sec">卫星运动</div>
                <div v-if="geom.worst.speedInertialKmS != null" class="geo-row"><span class="geo-l">轨道速度<i>惯性系</i></span><span class="geo-v">{{ g2(geom.worst.speedInertialKmS, 3) }}<i>km/s</i></span></div>
                <div v-if="geom.worst.speedGroundRelKmS != null" class="geo-row"><span class="geo-l">相对地面速度<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-v">{{ g2(geom.worst.speedGroundRelKmS, 3) }}<i>km/s</i></span></div>
                <div v-if="geom.worst.maxDopplerUpHz != null" class="geo-row"><span class="geo-l">上行多普勒<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-v">±{{ g2(geom.worst.maxDopplerUpHz / 1000, 3) }}<i>kHz</i></span></div>

                <div class="geo-sec">卫星轨道根数<span class="geo-sec-x">{{ geom.elements && geom.elements.satnum == null ? '虚拟圆轨道' : '历元' }}</span></div>
                <div class="geo-row"><span class="geo-l">半长轴 a</span><span class="geo-v">{{ g2(geom.elements.a, 3) }}<i>km</i></span></div>
                <div class="geo-row"><span class="geo-l">偏心率 e</span><span class="geo-v">{{ g2(geom.elements.e, 6) }}</span></div>
                <div class="geo-row"><span class="geo-l">倾角 i</span><span class="geo-v">{{ g2(geom.elements.iDeg, 4) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">升交点赤经 Ω</span><span class="geo-v">{{ g2(geom.elements.raanDeg, 4) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">近地点幅角 ω</span><span class="geo-v">{{ g2(geom.elements.argpDeg, 4) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">平近点角 M</span><span class="geo-v">{{ g2(geom.elements.maDeg, 4) }}<i>°</i></span></div>
                <div class="geo-row"><span class="geo-l">平均运动 n</span><span class="geo-v">{{ g2(geom.elements.meanMotionRevDay, 6) }}<i>rev/day</i></span></div>
                <div class="geo-row"><span class="geo-l">轨道周期 T</span><span class="geo-v">{{ g2(geom.elements.periodMin, 3) }}<i>min</i></span></div>
                <div class="geo-row"><span class="geo-l">近地点 / 远地点高度</span><span class="geo-v">{{ g2(geom.elements.perigeeAltKm, 1) }} / {{ g2(geom.elements.apogeeAltKm, 1) }}<i>km</i></span></div>
                <div v-if="geom.elements.satnum" class="geo-row"><span class="geo-l">卫星编号 (NORAD)</span><span class="geo-v">{{ geom.elements.satnum }}</span></div>
              </div>
            </div>
            <div v-else-if="geom && !geom.feasible" class="geo-card geo-note">
              几何提示：{{ geom.reason }}。
            </div>
              </div>
            </div>

            <!-- 文档区（样式见 styles/lbworkbench.css）：上排＝级联主表 ‖ 图表区，下排＝参考段整幅段带。
                 三块在 DOM 里排在上面的几何折叠之后，靠 flex order 负值视觉提到文档最前。 -->
            <div class="lbx-doc-main"><WaterfallTable :segments="segments" pick="cascade" :lang="reportLang" /></div>
            <div v-if="showViz" class="lbx-doc-side"><LbVizPane ref="vizRef" :engine="sweepEngine" :params="selParams" :sweep2D="api ? api.linkBudget.sweep2D : null"
              :output-defs="api ? api.linkBudget.outputDefs : null" :sweep-unavailable="sweepUnavailable" :link-scene="linkScene"
              :show-geo="vizShowGeo" :geo-site="vizGeoSite" store-key="regen" :lang="reportLang" /></div>
            <div class="lbx-doc-ref"><WaterfallTable :segments="segments" pick="rest" :lang="reportLang" /></div>
            </div>
          </LbSection>
        </div>
      </section>
    </div>

    <!-- 配置右键菜单 -->
    <div v-if="ctxMenu.open" class="lb-ctx-mask" @click="ctxMenu.open = false" @contextmenu.prevent="ctxMenu.open = false">
      <div class="lb-ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop>
        <template v-if="ctxIsFolder">
          <button class="lb-ctx-i" @click="ctxDo(() => startRename(ctxConfig))">重命名</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addFolder(ctxMenu.configId))">新建子文件夹</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addBlankConfig(ctxMenu.configId))">在此新建配置</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(ctxMenu.configId, true))">粘贴到此文件夹</button>
          <button class="lb-ctx-i danger" @click="ctxDo(() => removeFolder(ctxConfig))">删除文件夹（含子项）</button>
        </template>
        <template v-else-if="ctxConfig">
          <button class="lb-ctx-i" @click="ctxDo(() => startRename(ctxConfig))">重命名</button>
          <button class="lb-ctx-i" @click="ctxDo(() => copyConfig(ctxConfig))">复制</button>
          <button class="lb-ctx-i" @click="ctxDo(() => cutConfig(ctxConfig))">剪切</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(ctxMenu.configId))">粘贴到此后</button>
          <button class="lb-ctx-i danger" @click="ctxDo(() => removeConfig(ctxConfig.id))">删除</button>
        </template>
        <template v-else>
          <button class="lb-ctx-i" @click="ctxDo(() => addFolder(null))">新建文件夹</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addBlankConfig(null))">添加空白配置</button>
          <button class="lb-ctx-i" :disabled="!api" @click="ctxDo(openSaveDlg)">保存当前为新配置</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(null))">粘贴{{ cfgClip.mode === 'cut' ? '（移动到末尾）' : '' }}</button>
        </template>
        <div class="lb-ctx-sep"></div>
        <button class="lb-ctx-i" @click="ctxDo(() => { sideView = '' })">隐藏配置列表</button>
      </div>
    </div>

    <!-- 命名弹窗 -->
    <!-- 导出报告：封面元信息 + 输出格式 + 是否含图（三窗共用组件）-->
    <LbCustomColsDialog :open="ccDlgOpen" :cols="customColsBy[linkMode]" :pool="customPool"
      :subtitle="(LINK_MODES.find((m) => m.key === linkMode) || {}).label || ''" :preview-fn="ccPreview"
      @update:cols="customColsBy[linkMode] = $event" @close="ccDlgOpen = false" />

    <!-- 斜距工具（几何=手动 时可用）：算斜距 + 按各行仰角批量填 -->
    <LbSlantTool :open="slantToolOpen" :alt-km="slantToolAlt" :elev-deg="slantToolElev" :lat-deg="slantToolLat" :sta-alt-m="slantToolStaAlt"
      :row-count="slantSide.rows.length" :has-row="!!slantToolRow" :side-label="slantSide.label" @fill="applySlantFill" @close="slantToolOpen = false" />

    <!-- 星间链路距离工具（几何=手动 时可用）：两星轨道 → 时间轴上的星间距离 → 填入链路表 -->
    <LbIslRangeTool :open="islToolOpen" :sats="islToolSats" :row-count="islToolRows.length" :has-row="!!islToolRow"
      :default-hours="geoHorizonHours" :side-label="linkMode === 'laser' ? '星间激光' : '星间微波'"
      @fill="applyIslRangeFill" @close="islToolOpen = false" />

    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="REGEN" :regen-mode="linkMode"
      :sat-name="(satConfigs[0] && satConfigs[0].form.satelliteName) || ''" :band="(satConfigs[0] && satConfigs[0].form.frequencyBand) || ''" :link-count="links.length"
      :viz-available="showViz" store-key="regen" :busy="reportDlg.busy" :progress="reportDlg.progress"
      @close="reportDlg.open = false" @submit="runReport" />

    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <div class="lb-dlg-bd"><input v-model="cfgDlg.name" class="lb-input" placeholder="配置名称" @keyup.enter="confirmCfgDlg" /></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini primary" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <!-- 离开已改动配置提示 -->
    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b data-i18n-skip>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini primary" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <!-- 通用确认弹窗 -->
    <div v-if="confirmDlg.open" class="lb-mask" @click="answerConfirm(false)">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">确认</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">{{ confirmDlg.msg }}</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="answerConfirm(false)">取消</button>
          <button class="lb-mini primary" @click="answerConfirm(true)">确定</button>
        </div>
      </div>
    </div>

    <!-- 分享 / 导入弹窗（三窗共用组件）：配置多选 + 资源库多选，分享码 / 文件 / 在线三条路共用同一份勾选 -->
    <LbShareDialog v-model:open="shareOpen" :ctx="shareCtx" :device-id="deviceId" :configured="shareConfigured" @toast="toast" />
  </div>
</template>

<style scoped>
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--lb-serif);
  /* 报表衬线排版：--lb-serif 别名自 global.css 的 --font-serif（全软件同栈），等宽语义亦同源，
     TNR 数字字面天然等宽，右对齐即成列，此处不再单独覆写 --font-mono */
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  --up: #3f6d8c; --dn: #97672f;
  --r-ctl: 2px; --r-box: 3px; --r-modal: 4px;
}
html[data-theme='dark'] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; --up: #82a9c6; --dn: #c9a26a; }

/* 功能区「文件」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .lbr-svg { animation: lb-spin .7s linear infinite; transform-origin: 50% 50%; }
@keyframes lb-spin { to { transform: rotate(360deg); } }
/* 功能区右缘状态位文案：操作回执（绿）/ 无引擎警示（黄） */
.lb-hint { color: var(--warn); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.lb-note { color: var(--ok); font-size: 11px; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lb-body { flex: 1; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.lb-col:last-child { border-right: none; }
/* 左侧栏（配置列表 / 资源库 二选一）：宽度由 sideWidth 内联给出，两视图各记各的 */
.lb-side { flex: none; position: relative; transition: width .15s ease; }
.lb-side.resizing { transition: none; user-select: none; }
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
.lb-configs .lb-col-bd { padding: 10px 8px; scrollbar-width: thin; }
.lb-cfg-hd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-build { flex: 1; min-width: 460px; }

.lb-col-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; flex: none; padding: 0 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.lb-col-bd { flex: 1; overflow: auto; padding: 12px; }
.lb-lang-sel { font: inherit; font-size: 11px; text-transform: none; letter-spacing: normal; line-height: 1; padding: 3px 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-lang-sel:focus { outline: none; border-color: var(--accent); }
.lb-mini { font: inherit; font-size: 11px; line-height: 1; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-mini:disabled { opacity: .45; cursor: not-allowed; }
.lb-placeholder { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; }
.lb-cfg-acts { display: flex; gap: 4px; }
.lb-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.lb-ctx { position: fixed; min-width: 150px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.lb-ctx-i { font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl); white-space: nowrap; }
.lb-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.lb-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.lb-ctx-i.danger:hover { color: var(--danger); }
.lb-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; }
.lb-ico-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; }
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-mono); color: var(--text); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; }

.lb-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.lb-dlg { width: 380px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
/* 分享弹窗自 v1.4.6 起是独立组件（components/LbShareDialog.vue，自带 lbs- 一套样式），
   原先只服务于它的 lb-tabs / lb-area / lb-inbox 系列 / lb-share-l 等已随之删去。 */
.lb-dlg-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lb-dlg-bd { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-dlg-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-input { font: inherit; font-size: 12px; padding: 6px 9px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-input:focus { outline: none; border-color: var(--accent); }
.lb-mini.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.lb-mini.primary:hover:not(:disabled) { opacity: .88; }
.lb-share-row { font-size: 12px; color: var(--text-muted); }

.rlmode { display: flex; align-items: center; gap: 4px; flex: none; padding: 8px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.rlmode-i { position: relative; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; font-weight: 600; padding: 6px 9px 6px 14px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.rlmode-i:hover:not(.disabled) { color: var(--text); border-color: var(--border-strong); }
.rlmode-i.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.rlmode-i.disabled { opacity: .55; cursor: not-allowed; }
.rlmode-todo { font-size: 9px; font-weight: 700; margin-left: 1px; padding: 1px 5px; border-radius: 999px; background: var(--surface-2); color: var(--text-faint); border: 1px solid var(--border); vertical-align: 1px; }
.rlmode-i.on .rlmode-todo { background: color-mix(in srgb, var(--bg) 20%, transparent); color: var(--bg); border-color: transparent; }
.rlmode-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 1px; border-radius: 4px; color: currentColor; opacity: .5; }
.rlmode-x svg { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; fill: none; }
.rlmode-i:hover .rlmode-x { opacity: .8; }
.rlmode-x:hover { opacity: 1; background: rgba(214,69,69,.16); color: #d64545; }
.rlmode-i.on .rlmode-x:hover { background: color-mix(in srgb, var(--bg) 28%, transparent); color: var(--bg); }
.rlmode-add-wrap { position: relative; display: inline-flex; }
.rlmode-add { display: inline-flex; align-items: center; justify-content: center; width: 27px; height: 27px; padding: 0; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl); }
.rlmode-add svg { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; fill: none; }
.rlmode-add:hover, .rlmode-add.on { color: var(--accent); border-color: var(--accent); }
.rlmode-menu-mask { position: fixed; inset: 0; z-index: 40; }
.rlmode-menu { position: absolute; top: calc(100% + 5px); left: 0; z-index: 41; min-width: 156px; display: flex; flex-direction: column; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.rlmode-menu-hd { font-size: 10px; font-weight: 600; letter-spacing: .5px; color: var(--text-faint); padding: 4px 8px 6px; }
.rlmode-menu-i { text-align: left; font: inherit; font-size: 12px; font-weight: 500; padding: 6px 8px; cursor: pointer; background: transparent; color: var(--text); border: none; border-radius: var(--r-ctl); }
.rlmode-menu-i:hover { background: var(--surface-2); }

/* 链路表节内的说明条 */
.tx-optbar { display: flex; align-items: center; gap: 10px; flex: none; margin-bottom: 6px; flex-wrap: wrap; }
.tx-optl { font-size: 12px; color: var(--text-muted); font-weight: 600; }

.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }

/* 核心指标（.core-*）三线式样式统一在 styles/lbworkbench.css（三 App 共用，此处不再重复定义） */

/* 站星几何卡：三线语言（上下双线、题注行带栏目线、无底色），tx/rx 双列 */
.geo-card { margin-bottom: 12px; border-top: 2px solid var(--lb-rule-strong); border-bottom: 2px solid var(--lb-rule-strong); }
.geo-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 2px 4px; border-bottom: 1px solid var(--lb-rule); }
.geo-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.geo-tt { font-size: calc(var(--lb-fs, 11px) + 1px); font-weight: 700; letter-spacing: .3px; color: var(--text); }
.geo-badge { flex: none; align-self: center; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .5px; line-height: 1; padding: 2px 7px; border-radius: 999px; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border-strong); }
.geo-tz { display: inline-flex; flex: none; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.geo-tzb { font: inherit; font-size: 11px; line-height: 1; padding: 3px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 0; }
.geo-tzb + .geo-tzb { border-left: 1px solid var(--border); }
.geo-tzb:hover:not(.on) { color: var(--text); }
.geo-tzb.on { background: var(--accent); color: var(--bg); font-weight: 600; }
.geo-body { padding: 2px 2px 6px; }
.geo-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.geo-col { min-width: 0; }
.geo-col-hd { display: flex; align-items: baseline; gap: 6px; font-size: var(--lb-fs, 11px); font-weight: 700; padding: 3px 0 4px; border-bottom: 2px solid var(--border-strong); margin-bottom: 2px; }
.geo-col-hd.tx { color: var(--accent); border-bottom-color: var(--accent); }
.geo-col-hd.rx { color: var(--ok); border-bottom-color: var(--ok); }
.geo-col-hd em { font-style: normal; font-weight: 500; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.geo-col-na { font-size: var(--lb-fs, 11px); color: var(--text-faint); padding: 10px 0; }
.geo-col .geo-sec:first-of-type { border-top: none; padding-top: 3px; margin-top: 4px; }
.geo-sec { display: flex; align-items: baseline; gap: 7px; font-size: calc(var(--lb-fs, 11px) - 1px); font-weight: 600; color: var(--accent); margin: 8px 0 3px; padding-top: 5px; border-top: 1px solid var(--lb-rule-soft); letter-spacing: .3px; }
.geo-sec-x { font-weight: 400; font-size: 10px; color: var(--text-faint); letter-spacing: .2px; }
.geo-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 1.5px 0; }
.geo-l { font-size: var(--lb-fs, 11px); color: var(--text-muted); min-width: 0; }
.geo-l i { font-style: normal; font-size: 10px; color: var(--text-faint); margin-left: 4px; letter-spacing: .2px; }
.geo-v { font-size: var(--lb-fs, 11px); font-weight: 700; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-v i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 5px; }
.geo-v.geo-inf { font-size: calc(var(--lb-fs, 11px) + 6px); line-height: 1; }
.geo-v.danger { color: var(--danger); }
/* 关键行：不再用底色填充，改细辅助线 + 加粗（三线语言） */
.geo-row.hi { border-top: 1px solid var(--lb-rule-soft); }
.geo-row.hi .geo-l { color: var(--text); font-weight: 600; }
.geo-note { padding: 6px 2px; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-muted); line-height: 1.6; font-family: inherit; font-weight: 400; }

/* 访问窗口列表：三线式（顶线/栏目线/底线，无竖线无底色） */
.acc-sum { font-size: var(--lb-fs, 11px); color: var(--text-muted); line-height: 1.6; }
.acc-sum b { color: var(--text); font-weight: 700; font-variant-numeric: tabular-nums; }
.acc-note { color: var(--text-faint); font-size: calc(var(--lb-fs, 11px) - 1px); }
.acc-none { font-size: var(--lb-fs, 11px); color: var(--warn); line-height: 1.6; }
.acc-list { margin-top: 6px; border-top: 2px solid var(--lb-rule-strong); border-bottom: 2px solid var(--lb-rule-strong); }
.acc-hd, .acc-row { display: grid; grid-template-columns: 26px 1fr 64px 62px; gap: 6px; align-items: baseline; padding: 1.5px 2px; font-size: var(--lb-fs, 11px); }
.acc-hd { color: var(--text-muted); font-weight: 600; border-bottom: 1px solid var(--lb-rule); }
.acc-row { color: var(--text-muted); }
.acc-row:hover { background: var(--surface); }
.acc-row .mono { font-family: var(--font-mono); }
.acc-c1 { color: var(--text-faint); }
.acc-c3, .acc-c4 { text-align: right; }
.acc-clip { font-style: normal; font-size: 9px; color: var(--text-faint); margin-left: 5px; padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; }

</style>
