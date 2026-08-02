<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { FIELD_GROUPS, SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS, defaultsFor, buildParams } from './params.js'
import * as GEO_PARAMS from './params.js'   // 整份 schema 传给 lbMiniExport 的 target 分流（与 buildParams 同源，但不做 sfdRef 的引擎入口换算）
import { buildMiniConfig, miniConfigItem, miniConfigName } from '../shared/lbMiniExport.js'
import { loadSatTree, sampleAntennaParams, antennaSampleSpec } from './grdParam.js'
import { importGrdAntennas, removeLocalAntenna, localFolderFor, syncLocalNode } from '../shared/lbGrdImport.js'
import { resolveRefId } from '../shared/lbShare.js'
import { stableStringify } from '../shared/configDirty.js'
import { migrateLegacyEs } from '../shared/esMigrate.js'
import { pickColumn, fmtScaled, fmtQty } from '../shared/adaptUnits.js'
import { lbDocT } from '../shared/lbDocI18n.js'
import { syncAutoNames, adoptAutoFlag, withAutoFlag, isAutoNamed } from '../shared/lbAutoName.js'   // 三库条目自动命名（未被用户改名时，名字随关键参数走）
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import StationGrid from './StationGrid.vue'
import BasebandPanel from './BasebandPanel.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import SatellitePanel from './SatellitePanel.vue'
import WaterfallTable from './WaterfallTable.vue'
import LbVizPane from '../components/LbVizPane.vue'
import LbFontCtl from '../components/LbFontCtl.vue'
import LbCapFoot from '../components/LbCapFoot.vue'
import LbShareDialog from '../components/LbShareDialog.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import LbAdvBalanceDialog from '../components/LbAdvBalanceDialog.vue'
import { useLbReport } from '../shared/useLbReport.js'
import { planAdvWriteback, advBaseMargin } from '../shared/advBalance.js'   // 高级计算配平结果的写回落点（新建副本 / 就地改）
import { buildGeoScene } from '../shared/lbLinkScene.js'

const api = typeof window !== 'undefined' ? window.api : null

// 配置列表（Phase 4）：命名配置持久化到 userData/configs.json（store.config.*）。CRUD 见下方 Phase 4 区。
// 列表已升级为「多级文件夹树」：configs 里同时含配置项与文件夹项 { type:'folder',name,parentId }，
// 归属由 parentId 表达，展开态存 localStorage。文件夹本身不进 activeId（它不是可载入的工作状态）。
const configs = ref([])
const activeId = ref(null)
// 展开的文件夹 id 集合（响应式 Set，跨会话记忆）
const expandedFolders = ref(new Set(JSON.parse(localStorage.getItem('linkbudget/expandedFolders') || '[]')))
function persistExpanded() { try { localStorage.setItem('linkbudget/expandedFolders', JSON.stringify([...expandedFolders.value])) } catch (e) { /* ignore */ } }
function toggleFolder(f) { const s = new Set(expandedFolders.value); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); expandedFolders.value = s; persistExpanded() }
// —— 左侧栏（VS Code 活动栏范式：同屏只开一个视图）——
// 'configs' = 配置列表（场景文件树）/ 'library' = 资源库（全局参数库）/ '' = 隐藏，两者二选一。
// 开关：功能区「文件 › 配置列表」与「视图 › 资源库」，点当前视图即收起。
const SIDE_KEY = 'linkbudget/sideView'
const sideView = ref((() => {
  const v = localStorage.getItem(SIDE_KEY)
  if (v === 'configs' || v === 'library' || v === '') return v
  return localStorage.getItem('linkbudget/configsCollapsed') === '1' ? '' : 'configs'   // 旧键迁移（v1.4.4 及以前）
})())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
// 两视图各记各的宽度（树窄、资源库宽——后者要放得下两列参数），右缘同一个手柄按当前视图写对应那份
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('linkbudget/configsWidth')) || 210)))
const LIB_W_MIN = 300, LIB_W_MAX = 760
const libWidth = ref(Math.min(LIB_W_MAX, Math.max(LIB_W_MIN, Number(localStorage.getItem('linkbudget/libWidth')) || 460)))
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
    try { localStorage.setItem(lib ? 'linkbudget/libWidth' : 'linkbudget/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// —— 全局资源库（v1.4.2 模块化重构）——
// 地球站/卫星/载波三库脱离场景配置，全局持久化到 userData/library.json（命名空间 'geo'，三体制各自独立）。
// 场景（命名配置）只存链路行（站址 + 各列引用的库条目 id）+ 计算策略；改库条目影响所有引用它的场景。
const LIB_NS = 'geo'
const basebandOpts = ref({})

// —— 载波信号库（Phase 6）：载波由发信站调制器产生，故与发信站绑定（非收信站）——
// 每份配置 = 引擎参数(CARRIER_FIELDS，含系统余量) + UI 态(门限模式/频谱效率模式/DVB/MODCOD)。
// 「载波信号」模块以多张卡片同时展示/编辑全部配置（不再是单一表单+下拉切换）。
// 发信站表新增「载波信号配置」列选择使用哪一份；同一配置可被多个发信站共用，未选(空)即用第一份。
let _bbSeq = 1
// nameAuto：条目名是否还随参数自动生成（见 shared/lbAutoName.js）——不传 name 即新建的空名条目，自动
function makeBasebandConfig(name) { return withAutoFlag({ id: 'bb' + (_bbSeq++), name: name || '', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null } }, 'carrier') }
const basebandConfigs = reactive([makeBasebandConfig('默认')])
// 按 id 解析；正常路径（下拉选 / 粘贴 / 批量设值）StationGrid 已把存值归一化成合法 id，
// 这里按名称兜底匹配只是双保险（防御旧数据或遗漏路径）。都没命中则退到第一份默认配置。
function resolveBaseband(id) {
  if (!id) return basebandConfigs[0]
  return basebandConfigs.find((c) => c.id === id) || basebandConfigs.find((c) => c.name === id) || basebandConfigs[0]
}
const basebandSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...basebandConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addBasebandConfig() { basebandConfigs.push(makeBasebandConfig()); syncAutoNames(basebandConfigs, 'carrier') }
// 复制：自动命名的条目复制出来仍是自动的（名字由 syncAutoNames 按参数出，重名自动加序号）；
// 自定义名的条目才带「副本」后缀——那是用户起的名字，复制件跟着它走。
function duplicateBasebandConfig(cfg) {
  basebandConfigs.push({ id: 'bb' + (_bbSeq++), name: cfg.nameAuto ? '' : cfg.name + ' 副本', nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(basebandConfigs, 'carrier')
}
function removeBasebandConfig(cfg) { removeLibEntry(basebandConfigs, cfg, 'bb') }
// —— 地球站库：每份配置 = 一种站型的收发射频参数（公共天线口径 + 发射链/接收链分列，字段见 params.js station 组）。
// 发/收信站表各有「地球站配置」列（stationId）选择套用哪一份：发信站取发射参数、收信站取接收参数，
// 同一份可被多行乃至收发两侧共用；站表本身只留站址（经纬度等）信息。
let _esSeq = 1
function makeEsConfig(name, diameter) {
  const c = { id: 'es' + (_esSeq++), name: name || '', form: { ...defaultsFor(ES_FIELDS) } }
  if (diameter) c.form.antennaDiameter = diameter
  return withAutoFlag(c, 'es')
}
// 默认库：口径收发共用（一份配置=一面天线）后，经典「6.2 m 发 / 3.7 m 收」基线拆成两份站型——
// 链路行发端默认引用第一份（关口站）、收端默认引用第二份（干线站，见 newLinkRow），默认算例数值与旧版一致
const esConfigs = reactive([makeEsConfig('关口站 6.2m'), makeEsConfig('干线站 3.7m', '3.7')])
// 按 id 解析（名称兜底匹配防御旧数据/自由录入）；未选(空)即用第一份
function resolveEs(id) {
  if (!id) return esConfigs[0]
  return esConfigs.find((c) => c.id === id) || esConfigs.find((c) => c.name === id) || esConfigs[0]
}
const esSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...esConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addEsConfig() { esConfigs.push(makeEsConfig()); syncAutoNames(esConfigs, 'es') }
function duplicateEsConfig(cfg) {
  esConfigs.push({ id: 'es' + (_esSeq++), name: cfg.nameAuto ? '' : cfg.name + ' 副本', nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(esConfigs, 'es')
}
function removeEsConfig(cfg) { removeLibEntry(esConfigs, cfg, 'es') }

// —— 卫星库（新增，对齐再生式先例）：每份 = 完整空间段参数 + 方向图匹配(grd)；场景级单选（satId），全场景链路共用 ——
// grd = 这颗卫星的「方向图」属性（GRD 卫星树节点 folder + 卫星EIRP/G·T 各自匹配的天线 key），随库条目走：
// v1.4.3 起从场景态（旧 state.grdSel）下沉到库条目——方向图是卫星的属性，不是某个场景的属性；
// 编辑在资源库「卫星」库的条目编辑器里（SatellitePanel），工作台卫星分区只留只读速览行。
let _satSeq = 1
const blankGrd = () => ({ satFolder: '', eirpKey: '', gtKey: '' })
// 卫星库条目的「外部资源引用」容器：方向图匹配（satFolder/eirpKey/gtKey）+ 频率计划引用（fpId/fpNo）。
// 两者同属「这个卫星条目引了哪些外部资产」，共用一处即随条目入库/复制/分享，无需再开一条存储路径。
const normGrd = (g) => ({
  satFolder: (g && g.satFolder) || '', eirpKey: (g && g.eirpKey) || '', gtKey: (g && g.gtKey) || '',
  fpId: (g && g.fpId) || '', fpNo: (g && g.fpNo) || ''
})
function makeSatConfig(name) { return withAutoFlag({ id: 'sat' + (_satSeq++), name: name || '', form: { ...defaultsFor(SAT_FIELDS) }, grd: blankGrd() }, 'sat') }
const satConfigs = reactive([makeSatConfig('默认卫星')])
const satId = ref('')   // 场景选用的卫星库条目（空 = 第一份）
function resolveSat(id) {
  if (!id) return satConfigs[0]
  return satConfigs.find((c) => c.id === id) || satConfigs.find((c) => c.name === id) || satConfigs[0]
}
const curSat = computed(() => resolveSat(satId.value))
const satSelectOptions = computed(() => satConfigs.map((c) => ({ value: c.id, label: c.name })))
function addSatConfig() { satConfigs.push(makeSatConfig()); syncAutoNames(satConfigs, 'sat') }
function duplicateSatConfig(cfg) {
  satConfigs.push({ id: 'sat' + (_satSeq++), name: cfg.nameAuto ? '' : cfg.name + ' 副本', nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)), grd: normGrd(cfg.grd) })
  syncAutoNames(satConfigs, 'sat')
}
function removeSatConfig(cfg) { removeLibEntry(satConfigs, cfg, 'sat') }

// —— 库条目删除守卫：被链路行 / 已保存场景引用时先提示引用数 ——
function refCount(kind, id) {
  let n = 0
  const rowHit = (r) => (kind === 'es' ? (r.stationId === id || r.rxStationId === id) : kind === 'bb' ? r.basebandId === id : false)
  for (const r of linkRows) if (rowHit(r)) n++
  if (kind === 'sat' && (satId.value === id || (!satId.value && satConfigs[0] && satConfigs[0].id === id))) n++
  for (const c of configs.value) {
    const st = c && c.state
    if (!st) continue
    if (Array.isArray(st.rows)) for (const r of st.rows) if (r && rowHit(r)) n++
    if (kind === 'sat' && st.satId === id) n++
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

// —— 库的载入 / 自动保存（userData/library.json，防抖整写；seq 计数器随库持久化防删后撞号）——
let _libLoaded = false
let _libT = null
function serializeLibrary() {
  return JSON.parse(JSON.stringify({
    es: esConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })),
    carrier: basebandConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })),
    sat: satConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form, grd: normGrd(c.grd) })),   // 方向图匹配随条目入库
    seq: { es: _esSeq, bb: _bbSeq, sat: _satSeq }
  }))
}
function scheduleLibSave() {
  if (!_libLoaded || !api) return
  clearTimeout(_libT)
  _libT = setTimeout(() => { api.store.saveLibrary(LIB_NS, serializeLibrary()).catch(() => {}) }, 500)
}
// 频率/极化 + 干扰归属调整（两者均为「地球站 → 卫星」）的一次性迁移：就着旧库 form 里被移走的「孤儿键」搬运，
// 保留用户自定义值（须在按新字段集补默认值之前跑；已迁移过的库因目标键非空而幂等跳过）。
// 取第一份地球站配置作种子：频率/极化曾短暂随站型入库，一份场景里各站型通常填的是同一对上/下行频率。
// 只播种到「自身无该值」的卫星——早于那次改动建的卫星条目仍带着自己的频率（孤儿键被 applyLibrary 原样保留），
// 那才是这颗星真正的载频，不能被站型侧的值覆盖。
const _MIG_INTF_KEYS = ['aciUplinkFactor', 'adjUplinkFactor', 'xpolUplinkFactor', 'hpaIntermodFactor', 'aciDownlinkFactor', 'adjDownlinkFactor', 'xpolDownlinkFactor']
const _MIG_FREQ_KEYS = ['centerFrequency', 'rxCenterFrequency', 'uplinkPolarization', 'downlinkPolarization']
function migrateFreqIntfLib(lib) {
  const es0 = lib.es && lib.es[0] && lib.es[0].form
  if (!es0 || !Array.isArray(lib.sat)) return
  for (const c of lib.sat) {
    if (!c || !c.form) continue
    for (const k of [..._MIG_FREQ_KEYS, ..._MIG_INTF_KEYS]) if (c.form[k] == null && es0[k] != null) c.form[k] = es0[k]
  }
}
function applyLibrary(lib) {
  if (!lib) return
  migrateFreqIntfLib(lib)   // 结构迁移（频率/极化 + 干扰上移卫星），保留旧库自定义值；须在补默认值前
  // nameAuto：旧库没存过这一位，按历史默认名推定一次（见 shared/lbAutoName.js 的 adoptAutoFlag）
  const fill = (defFields, kind, extra) => (c, i, pfx) => ({ id: c.id || (pfx + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag(kind, c), form: { ...defaultsFor(defFields), ...(extra || null), ...c.form } })
  if (Array.isArray(lib.es) && lib.es.length) esConfigs.splice(0, esConfigs.length, ...lib.es.map((c, i) => fill(ES_FIELDS, 'es')(c, i, 'esb')))
  if (Array.isArray(lib.carrier) && lib.carrier.length) basebandConfigs.splice(0, basebandConfigs.length, ...lib.carrier.map((c, i) => fill(CARRIER_FIELDS, 'carrier', { rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null })(c, i, 'bbb')))
  if (Array.isArray(lib.sat) && lib.sat.length) satConfigs.splice(0, satConfigs.length, ...lib.sat.map((c, i) => {
    const e = fill(SAT_FIELDS, 'sat')(c, i, 'satb')
    e.grd = normGrd(c.grd)   // 旧库无 grd → 空匹配（旧场景里的 grdSel 由 applyState 播种，见 adoptSceneGrd）
    return e
  }))
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

// —— 内容去重并库（迁移 / 分享导入共用）：同内容复用既有条目 id，异内容新建（名称冲突自动加序号）。
// 返回 旧id→全局id 映射。两次对同一份旧配置执行得到相同映射（第二次全部命中内容去重）→ 指纹稳定。
// extraKeys：参与内容指纹并随条目并入的额外顶层键（卫星库传 ['grd']——方向图匹配是条目内容的一部分，
// 同参数不同方向图是两颗不同的星；与 NGSO 窗口的 ['ngsoSat'] 同款口径）。
function adoptEntries(arr, entries, makeNew, extraKeys) {
  const map = {}
  if (!Array.isArray(entries)) return map
  const names = () => new Set(arr.map((c) => c.name))
  const fpOf = (c) => stableStringify(extraKeys ? { form: c.form, ...Object.fromEntries(extraKeys.map((k) => [k, c[k] == null ? null : c[k]])) } : c.form)
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
    if (extraKeys) for (const k of extraKeys) if (e[k] !== undefined) c[k] = JSON.parse(JSON.stringify(e[k]))
    arr.push(c)
    map[e.id] = c.id
  }
  return map
}

// —— 链路表（单表：一行 = 一条完整链路 = 发端 + 收端 + 引用 + 结果列）——
let _sid = 1
function newLinkRow() {
  const r = { ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS) }
  r.rxStationId = (esConfigs[1] && esConfigs[1].id) || ''   // 默认收端引用第二份站型（经典 6.2m 发 / 3.7m 收基线）
  r._id = 's' + (_sid++)
  return r
}
const linkRows = reactive([newLinkRow()])

const LIB_TABS = [
  { key: 'station', label: '地球站', tip: '站型收发射频参数库：链路表「地球站配置」列按行引用' },
  { key: 'sat', label: '卫星', tip: '空间段参数库：主区「卫星与转发器」分区场景级单选' },
  { key: 'carrier', label: '载波', tip: '载波信号库：链路表「载波信号配置」列按行引用' }
]
const libTab = ref('station')
const flowEl = ref(null)
// 资源库主从视图的当前选中项（会话态，不入存档）
const selBbId = ref('')
const selEsId = ref('')
const selSatId = ref('')
// 列表摘要：自动命名的条目其名字就是这几项参数（见 lbAutoName），再报一遍纯属重影 → 只给自定义名的条目报
const bbSummary = (c) => (isAutoNamed('carrier', c) ? '' : `${c.form.modulation || 'QPSK'} ${c.form.fec || '3/4'} · ${c.form.infoRate || '2048'} kbps`)
// 地球站：自动名只有口径（见 lbAutoName），功放不进名字 → 摘要照报功放，口径只给自定义名的条目补
const esSummary = (c) => [isAutoNamed('es', c) ? '' : `${c.form.antennaDiameter || '6.2'} m`, c.form.paPowerW ? `功放预设 ${c.form.paPowerW} W` : ''].filter(Boolean).join(' · ')
// 卫星摘要：自动命名时名字已带频段与轨位（见 lbAutoName），这里只补名字里没有的上/下行频率
const satLibSummary = (c) => [isAutoNamed('sat', c) ? '' : (c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : ''), (c.form.centerFrequency || c.form.rxCenterFrequency) ? `${c.form.centerFrequency || '—'}/${c.form.rxCenterFrequency || '—'} GHz` : '', isAutoNamed('sat', c) ? '' : (c.form.orbitPosition ? c.form.orbitPosition + '°E' : '')].filter(Boolean).join(' · ')
// 工作台卫星分区第二行「转发器」：关键参数只读速览（横排读数，不可编辑——编辑走节头「编辑参数」进资源库）。
// 只列空间段定调的那几项：频段/上下行频率极化/轨位（标识）+ SFDref/G/Tref（上行定标）+ 带宽/IBO/OBO/C/IM（转发器工作点）；
// 干扰系数七项留在资源库编辑器（此处横排会挤成一堵墙）。label 为横排用短名，单位/悬浮说明取自 SAT_FIELDS 口径。
// join: 上/下行成对的量并作一格显示（「14.25/12.5 GHz」「V/H」），省得横排排出四格。
const SAT_FACTS = [
  { key: 'frequencyBand', label: '频段' },
  { key: 'centerFrequency', label: '频率', join: 'rxCenterFrequency' },
  { key: 'uplinkPolarization', label: '极化', join: 'downlinkPolarization' },
  { key: 'orbitPosition', label: '轨位' },
  { key: 'sfdRef', label: 'SFDref' },
  { key: 'sfdGtRef', label: 'G/Tref' },
  { key: 'transponderBandwidth', label: '带宽' },
  { key: 'BOi', label: 'IBO' },
  { key: 'BOo', label: 'OBO' },
  { key: 'xpdrIntermodFactor', label: 'C/IM' }
]
const satFacts = computed(() => {
  const f = (curSat.value && curSat.value.form) || {}
  const show = (v) => ((v === '' || v == null) ? '—' : String(v))
  return SAT_FACTS.map((s) => {
    const d = SAT_FIELDS.find((x) => x.key === s.key) || {}
    const d2 = s.join ? (SAT_FIELDS.find((x) => x.key === s.join) || {}) : null
    return {
      key: s.key, label: s.label, unit: d.unit || '',
      tight: /^°/.test(d.unit || ''),   // 度类单位紧贴数字（110.5°E），不留读数与单位间的常规空隙
      value: s.join ? `${show(f[s.key])}/${show(f[s.join])}` : show(f[s.key]),
      tip: d2
        ? `${d.label} / ${d2.label}` + (d.unit ? `（${d.unit}）` : '')
        : (d.label || s.label) + (d.unit ? `（${d.unit}）` : '') + (d.tip ? '：' + d.tip : '')
    }
  })
})
// 工作台「去资源库编辑」：展开资源库侧栏、切到对应子栏并选中当前条目
function editInLibrary(kind, id) {
  sideView.value = 'library'
  libTab.value = kind
  if (kind === 'sat') selSatId.value = id || (curSat.value && curSat.value.id) || ''
  else if (kind === 'station') selEsId.value = id || ''
  else if (kind === 'carrier') selBbId.value = id || ''
}

// —— 计算方式 ——（enLabel 供导出 Excel 选英文时用，措辞对齐链路预算工程惯用语）
// 求解策略随载波入库（资源库「载波」条目的 calcMode / margin / overDb，见 params.js CARRIER_FIELDS），
// 逐行按该行所选载波取用——同一批次里不同载波可各按各的方式求解。功放功率仍是发射链硬件属性，
// 留在地球站库（paPowerW），「设置功放功率」方式按行取发端站型之值。
const CALC_MODES = [
  { key: 'margin', label: '设置余量', enLabel: 'Fixed Margin' },
  { key: 'power', label: '设置功放功率', enLabel: 'Fixed PA Power' },
  { key: 'balance', label: '功带平衡', enLabel: 'Power-Bandwidth Balance' },
  { key: 'overbalance', label: '功带平衡下超发', enLabel: 'Power-Bandwidth Balance with Overdrive' }
]
// 一行的求解器入参：方式与超发量取该行载波，功放功率取该行发端站型
const calcOptOf = (bbForm, txEs) => ({ mode: bbForm.calcMode || 'margin', powerW: txEs.paPowerW, overDb: bbForm.overDb })

// —— 计算结果列（只读，表头可自定义勾选）：并入链路表尾部「计算结果」列组 ——
// key 与引擎结果字段同名（容量为派生指标）；勾选集按窗口记忆（localStorage），不入场景配置。
const RESULT_DEFS = [
  { key: 'paRecommendation', label: '功放建议', unit: 'W' },
  { key: 'linkmargin', label: '链路余量', unit: 'dB' },
  { key: 'carrierTotalCN', label: '合计C/N', unit: 'dB' },
  { key: 'thresholdCN', label: '门限C/N', unit: 'dB' },
  { key: 'uplinkCN', label: '上行C/N', unit: 'dB' },
  { key: 'downlinkCN', label: '下行C/N', unit: 'dB' },
  { key: 'ebnoActualResult', label: 'Eb/N₀', unit: 'dB' },
  { key: 'esnoActualResult', label: 'Es/N₀', unit: 'dB' },
  { key: 'powerUsageRatio', label: '功率占用', unit: '%' },
  { key: 'bandwidthUsageRatio', label: '带宽占用', unit: '%' },
  { key: 'allocBandwidthResult', label: '载波带宽', unit: 'kHz' },
  { key: 'PowerBWResult', label: '功率带宽', unit: 'kHz' },
  { key: 'capacityMbps', label: '容量', unit: 'Mbps' },
  { key: 'spectralEfficiencyResult', label: '频谱效率', unit: 'bps/Hz' },
  { key: 'satellitePSDResult', label: '功率谱密度', unit: 'dBW/Hz' },
  { key: 'selectedPowerWResult', label: '功放实际输出', unit: 'W' },
  { key: 'elevationResult', label: '发站仰角', unit: '°' },
  { key: 'rxElevationResult', label: '收站仰角', unit: '°' },
  { key: 'systemAvailabilityResult', label: '系统可用度', unit: '%' }
]
const DEFAULT_RESULT_KEYS = ['paRecommendation', 'linkmargin', 'carrierTotalCN', 'bandwidthUsageRatio', 'powerUsageRatio', 'capacityMbps']
const resultKeys = ref((() => {
  try { const v = JSON.parse(localStorage.getItem('linkbudget/resultCols') || ''); return Array.isArray(v) && v.length ? v : DEFAULT_RESULT_KEYS.slice() } catch (e) { return DEFAULT_RESULT_KEYS.slice() }
})())
watch(resultKeys, (v) => { try { localStorage.setItem('linkbudget/resultCols', JSON.stringify(v)) } catch (e) { /* ignore */ } }, { deep: true })
const colPickOpen = ref(false)
// 面板打开期间拦滚轮：面板内滚到边界即止（遮罩上另行全拦）。否则滚轮默认动作沿 DOM 链滚动底下的
// 分节流，页面在遮罩下乱滚、面板随宿主节头滚出视野。
function onColPickWheel(e) {
  const el = e.currentTarget
  const canScroll = e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
  if (!canScroll) e.preventDefault()
}
// 勾选/取消结果列（保持 RESULT_DEFS 声明序，避免列序随点击顺序漂移）
function toggleResultKey(k) {
  if (resultKeys.value.includes(k)) resultKeys.value = resultKeys.value.filter((x) => x !== k)
  else resultKeys.value = RESULT_DEFS.map((d) => d.key).filter((x) => x === k || resultKeys.value.includes(x))
}
// 链路表列 = 发端组 + 收端组 + 结果列组；计算列 ro:true，值走 computedVals 映射。
// 实时 EIRP/G·T 不再占独立列（原段末的 _eirp/_gt 列已撤）——改由「地球站配置」单元格第二行小字承载
// （见 cellSubFn，值仍来自 computedVals：发端配置下显示 EIRP、收端配置下显示 G·T）。
const GRID_GROUPS = [{ key: 'tx', label: '发信站' }, { key: 'rx', label: '收信站' }, { key: 'res', label: '计算结果' }]
const gridFields = computed(() => [
  ...TX_FIELDS.map((f) => ({ ...f, group: 'tx' })),
  ...RX_FIELDS.map((f) => ({ ...f, group: 'rx' })),
  ...RESULT_DEFS.filter((d) => resultKeys.value.includes(d.key)).map((d) => ({ key: '_' + d.key, label: d.label, unit: resColUnits.value[d.key] || d.unit, type: d.type === 'text' ? 'text' : 'num', ro: true, group: 'res', target: 'meta', tip: d.tip || d.label }))
])
// 计算列取值映射 { 行_id: { _键: 值 } }：结果不写行数据 → 写回不惊动存档/脏检/过期 watcher
const computedVals = ref({})
// 结果列显示单位自适应：每次计算按整列最大|值|共选档位（W→mW/kW、kHz→MHz、全列<0dBW→dBm），
// 列头单位跟随；写入 computedVals 的值已按所选档位换算（复制出去的数与列头一致）
const resColUnits = ref({})
function setVals(id, patch) { computedVals.value = { ...computedVals.value, [id]: { ...(computedVals.value[id] || null), ...patch } } }
// 结果单元格着色：负余量 / 超占用标红（纯数字口径，不设文字判定列）
function cellClassFn(f, row) {
  if (!f.ro) return null
  const m = computedVals.value[row._id]
  if (!m) return null
  if (f.key === '_linkmargin') { const v = parseFloat(m._linkmargin); return isFinite(v) && v < 0 ? 'st-bad' : null }
  if (f.key === '_powerUsageRatio' || f.key === '_bandwidthUsageRatio') { const v = parseFloat(m[f.key]); return isFinite(v) && v > 100 ? 'st-bad' : null }
  return null
}
// 占用类结果列的比例填充条（数据条）：按占用值画 0–100% 宽度（>100% 由网格封顶铺满、随 st-bad 转红）
function cellFillFn(f, row) {
  if (f.key !== '_powerUsageRatio' && f.key !== '_bandwidthUsageRatio') return null
  const m = computedVals.value[row._id]
  const v = m ? parseFloat(m[f.key]) : NaN
  return isFinite(v) && v > 0 ? v / 100 : null
}
// 「地球站配置」单元格第二行小字：发端配置(stationId)下显示实时 EIRP、收端配置(rxStationId)下显示实时 G·T。
// 值取自 computedVals（refreshReadonly 实时回填，dBW/dB·K 为 dB 量纲不做单位自适应）；未算出则不显示第二行。
function cellSubFn(f, row) {
  if (f.key !== 'stationId' && f.key !== 'rxStationId') return null
  const m = computedVals.value[row._id]
  if (!m) return null
  const v = f.key === 'stationId' ? m._eirp : m._gt
  if (v == null || v === '' || v === '—') return null
  return f.key === 'stationId' ? `EIRP ${v} dBW` : `G/T ${v} dB/K`
}
// 「地球站配置」单元格行内尾标：发端配置(stationId)名之后贴该行实时算出的功放功率（就在第二行 EIRP 之上）。
// 只给发信站——功放是发射链的量，收端那格没有它。库里那一项是「功放功率预设」，这里是按本行几何/载波
// 与计算方式实时解出的功放功率：口径同为引擎 paRecommendation（含回退的功放输出），故「设置功放功率」
// 方式下二者相等，其余方式下这里报的是该链路真正需要的功率。单位自适应（0.2 W 报 200 mW）。
function cellTagFn(f, row) {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const w = m ? parseFloat(m._paW) : NaN
  // 取 4 位有效数字：尾标是一眼扫过的读数，引擎原串的 40.000 在这里读作「40 W」（精确值看结果列/瀑布）
  return isFinite(w) ? fmtQty(Number(w.toPrecision(4)), 'W') : null
}
// shallowRef：避免 Vue 把每条链路的 data(引擎结果) 深度代理成 reactive，
// 否则传给 waterfall IPC 时结构化克隆会报 “could not be cloned”。
const links = shallowRef([])  // [{ i, rowId, txName, rxName, data, ok, error }]（瀑布/导出/汇总数据源）
const selected = ref(0)       // 当前查看的链路下标（与链路表聚焦行联动）
const segments = ref([])      // 当前链路瀑布
const computing = ref(false)
const error = ref('')
// —— 结果过期提示：出结果后任何计算输入再变化（含库条目被改）→ 亮「输入已变」小灯，提醒重算 ——
const resultsStale = ref(false)
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId],
  () => { if (links.value.length) resultsStale.value = true }, { deep: true })
// —— 瀑布表一键整表复制（TSV，直接粘贴进 Excel / 报告）——
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
// Ctrl+Enter 全局快捷计算
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKey); window.removeEventListener('focus', reloadSatTree) })

// 链路表实时列：发端 EIRP / 收端 G/T —— 输入变化即逐行重算（无需点「计算」），写入 computedVals。
let _roT = null
let _suppressRO = false   // 刷新编排期间静默 watcher，避免表单/站点回填触发的重复扇出
async function refreshReadonly() {
  if (!api || !linkRows.length) return
  // EIRP 用该行载波的计算方式（与主计算一致，否则功带平衡等模式下解出的功率不同 → EIRP 对不上）；
  // G/T 只与收端天线/噪温有关 → 固定走最便宜的「设置余量」单算，避免平衡/超发模式白跑二分搜索。
  const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? v : n.toFixed(2) }
  for (const row of linkRows) {
    try {
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      const { satParams, linkParams } = buildParams(curSat.value.form, bbForm, row, row, txEs, resolveEs(row.rxStationId).form)
      const r = await api.linkBudget.computeMode(satParams, linkParams, calcOptOf(bbForm, txEs))
      // _paW＝实时功放功率（原值不 toFixed：小功率靠 fmtQty 换 mW 档显示，见 cellTagFn）
      if (r && r.success) setVals(row._id, { _eirp: fix2(r.data.stationEIRPResult), _gt: fix2(r.data.gOverTeResult), _paW: r.data.paRecommendation })
    } catch (e) { /* skip */ }
  }
}
function scheduleReadonly() { if (_suppressRO) return; clearTimeout(_roT); _roT = setTimeout(refreshReadonly, 350) }
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId], scheduleReadonly, { deep: true })

// 注：地球站库编辑器曾在发射/接收标题右端显示实时 EIRP / G·T 预览，已删——频率在卫星侧后，一份站型配置
// 不再自含算这两个量所需的全部输入（预览得挑一颗星当基准，反而误导）。链路表「地球站配置」格下的第二行
// 小字仍显示逐行实时 EIRP / G·T（那里有明确的卫星与站址，见 cellSubFn）。

// —— GRD 卫星树 + 天线匹配（Phase 3）——
// 卫星树来自「星座3D」页持久化（localStorage globe3d/settings.grd，同源共享）。选星后给
// 「卫星EIRP / 卫星G/T」各匹配一个天线：按每个收/发信站的经纬度取该天线多波束的【最大 Parameter】，
// 回填收信站「卫星EIRP」(rxEIRP) 与发信站「卫星G/T」(G_Ts)。站经纬度/匹配天线变化即重算。
const satTreeState = loadSatTree()
const satTree = ref(satTreeState.sats)
let grdCfgs = satTreeState.cfgs
// 匹配选择随卫星库条目走（curSat.grd，见上方卫星库）：本场景用哪颗星，就用那颗星自己的方向图。
const curGrd = computed(() => (curSat.value && curSat.value.grd) || null)
const grdSat = computed(() => (curGrd.value ? satTree.value.find((s) => s.folder === curGrd.value.satFolder) : null) || null)
const antByKey = (key) => {
  if (!key || !grdSat.value) return null
  const name = key.split('|')[1]
  const a = grdSat.value.antennas.find((x) => x.name === name)
  return a ? { node: grdSat.value, ant: a, cfg: grdCfgs[key] } : null
}
// 工作台卫星分区第三行「方向图」：只读速览（与第二行「转发器」同款读数族）。
// 匹配本身在资源库「卫星」库的条目编辑器里改——方向图是卫星的属性，工作台只报当前接的是哪面天线。
// 只报接的是哪两面天线——星名不在这行重复出现：方向图属于「配置」行那颗星（选星时星名/轨位随之
// 回填），并排再报一个星名只会让人以为选了两颗星。不写说明句（口径进 title），只留两个状态标记：
//   stale    匹配还在、本机卫星树里没有这份 GRD（换机器/未导入）
//   mismatch 星名/轨位事后被手改得与所选 GRD 节点对不上——那才是真有两颗星，必须报出来
const grdFacts = computed(() => {
  const g = curGrd.value, node = grdSat.value, f = (curSat.value && curSat.value.form) || {}
  const antName = (k) => (k ? (String(k).split('|')[1] || '') : '')
  const eq = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
  let mismatch = ''
  if (node) {
    const drift = []
    if (f.satelliteName && !eq(f.satelliteName, node.satName)) drift.push(node.satName)
    if (f.orbitPosition !== '' && f.orbitPosition != null && node.lon != null && Math.abs(parseFloat(f.orbitPosition) - Number(node.lon)) > 0.05) drift.push(`${node.lon}°E`)
    if (drift.length) mismatch = '方向图属 ' + drift.join(' ')
  }
  return {
    eirp: antName(g && g.eirpKey) || '—',
    gt: antName(g && g.gtKey) || '—',
    stale: !!(g && g.satFolder && !node),
    mismatch
  }
})
let _grdT = null
// 回填前若本就「无未保存改动」，回填后把基线推进到回填结果——否则实时星/GRD 自动重算出
// 的新值（非用户操作）会被指纹判定为改动，弹出误报的「未保存，是否保存？」。
// 若回填前已有用户自己的改动（isDirty 为真），则不触碰基线，改动仍会被正确提示保存。
async function refreshGrdFill() {
  const wasClean = !isDirty()
  // 卫星EIRP 天线 → 各行收端经纬度取最大 Parameter，回填 rxEIRP（一次 IPC 批量采样全部行）
  const eirp = antByKey(curGrd.value && curGrd.value.eirpKey)
  if (eirp && linkRows.length) {
    const pts = linkRows.map((r) => ({ lon: parseFloat(r.rxLongitude), lat: parseFloat(r.rxLatitude) }))
    const vals = await sampleAntennaParams(eirp.node, eirp.ant, eirp.cfg, pts)
    linkRows.forEach((r, i) => { if (vals && vals[i] != null) r.rxEIRP = String(vals[i]) })
  }
  // 卫星G/T 天线 → 各行发端经纬度取最大 Parameter，回填 G_Ts
  const gt = antByKey(curGrd.value && curGrd.value.gtKey)
  if (gt && linkRows.length) {
    const pts = linkRows.map((r) => ({ lon: parseFloat(r.longitude), lat: parseFloat(r.latitude) }))
    const vals = await sampleAntennaParams(gt.node, gt.ant, gt.cfg, pts)
    linkRows.forEach((r, i) => { if (vals && vals[i] != null) r.G_Ts = String(vals[i]) })
  }
  if (wasClean) setBaseline()
}
function scheduleGrdFill() { clearTimeout(_grdT); _grdT = setTimeout(refreshGrdFill, 300) }

// —— 直接导入方向图（卫星库条目编辑器里的「导入方向图」）——
// 免去「先去星座3D页导入一趟」：选中的 GRD/PAT 由主进程按字节拷进 userData，挂在本卫星条目名下
// （folder = lb:<条目 id>，即「一个卫星配置＝一颗星」的那颗星），随后自动匹配到 EIRP / G·T 两路，
// 站表按各站经纬度回填。一个文件＝一副天线，文件内多个 set＝该天线的多波束（取值取多波束最大）。
const importingGrd = ref(false)
async function importGrdFor(cfg) {
  if (!cfg || importingGrd.value) return
  importingGrd.value = true
  try {
    const folder = localFolderFor(cfg.id)
    const r = await importGrdAntennas({
      folder,
      satName: cfg.form.satelliteName || cfg.name || '卫星',
      lon: parseFloat(cfg.form.orbitPosition), lat: 0, altKm: 35786   // GSO：星位即轨位，标称高度
    })
    if (r.canceled) return
    if (r.added.length) {
      reloadSatTree()
      if (!cfg.grd) cfg.grd = normGrd(null)
      cfg.grd.satFolder = folder
      const keyOf = (a) => folder + '|' + a.name
      // 只填空位，不覆盖用户已匹配的：首个文件 → EIRP；有第二个 → G/T，只有一个则两路同一副天线
      if (!cfg.grd.eirpKey) cfg.grd.eirpKey = keyOf(r.added[0])
      if (!cfg.grd.gtKey) cfg.grd.gtKey = keyOf(r.added[1] || r.added[0])
      scheduleGrdFill()
      toast(`已导入 ${r.added.length} 副方向图：${r.added.map((a) => `${a.name}（${a.beams} 波束）`).join('、')}；已匹配 EIRP / G·T，可在下拉中改选`)
    }
    if (r.errors.length) error.value = '部分方向图导入失败：' + r.errors.join('；')
  } catch (e) {
    error.value = '导入方向图失败：' + (e && e.message ? e.message : String(e))
  } finally { importingGrd.value = false }
}
// 删除本条目导入的方向图（连同盘上的原始 GRD）；3D 页导入的天线不在此管辖内
async function removeImportedGrd(cfg) {
  const folder = localFolderFor(cfg.id)
  const node = satTree.value.find((s) => s.folder === folder)
  if (!node || !node.antennas.length) return
  const names = node.antennas.map((a) => a.name)
  if (!(await askConfirm(`删除本卫星条目导入的方向图？\n${names.join('、')}\n（原始 GRD 文件一并删除，匹配随之解除）`))) return
  for (const n of names) await removeLocalAntenna(folder, n)
  reloadSatTree()
  if (cfg.grd && cfg.grd.satFolder === folder) { cfg.grd.satFolder = ''; cfg.grd.eirpKey = ''; cfg.grd.gtKey = '' }
  toast(`已删除 ${names.length} 副方向图`)
}
// 地理图的「卫星关联」（见 LbSpacePane / core 的 spec.geo）：站表回填只在各站那一个点上取方向图，
// 地理图是把站址铺成一整面，故同一支天线要逐格重采——卫星 G/T 随发信站站址变、卫星 EIRP 随
// 收信站站址变，两端各挂各的。仰角门限 GSO 不另设：定点星的覆盖边界就是地平线本身。
const geoLink = computed(() => {
  const g = curGrd.value
  const pat = (key, field) => {
    const a = antByKey(key)
    const spec = a ? antennaSampleSpec(a.node, a.ant, a.cfg) : null
    return spec ? { key: field, ...spec } : null
  }
  return {
    minElev: { tx: 0, rx: 0 },
    pattern: { tx: pat(g && g.gtKey, 'G_Ts'), rx: pat(g && g.eirpKey, 'rxEIRP') }
  }
})
// 链路窗口为单例复用：窗口重新获得焦点时刷新卫星树（见 onMounted 的 focus 监听），纳入此后在
// 「星座3D」新导入的 GRD 天线。
function reloadSatTree() {
  const wasClean = !isDirty()
  // 本模块导入的方向图节点：星名/轨位以卫星库条目为准（条目改名/改轨位后，树里那颗星跟着变）。
  // 单向——条目是真值源，节点只是它的影子，故下面的回写循环会跳过 local 节点。
  for (const c of satConfigs) {
    if (c.grd && c.grd.satFolder && c.grd.satFolder === localFolderFor(c.id)) {
      syncLocalNode({ folder: c.grd.satFolder, satName: c.form.satelliteName || c.name, lon: parseFloat(c.form.orbitPosition), lat: 0, altKm: 35786 })
    }
  }
  const t = loadSatTree(); satTree.value = t.sats; grdCfgs = t.cfgs
  // 实时星位同步写入【所有】引用该 GRD 节点的卫星库条目（名称/轨位以实时星历为准）——库为全局资产，
  // 引用它的其它场景同步受益。树里暂时没有的节点保留其匹配不清空：本机未导入 GRD ≠ 用户想解除匹配，
  // 库条目被清掉便无从找回；未命中期间 antByKey 自然不回填，编辑器里标「未导入」。
  for (const c of satConfigs) {
    const node = (c.grd && c.grd.satFolder) ? satTree.value.find((s) => s.folder === c.grd.satFolder) : null
    if (!node || node.local) continue   // local 节点是条目自己的影子，不回写条目（否则改名会被弹回旧名）
    if (c.form.satelliteName !== node.satName) c.form.satelliteName = node.satName
    if (String(c.form.orbitPosition) !== String(node.lon)) c.form.orbitPosition = String(node.lon)
  }
  // 实时星取新位置是系统自动同步，不算用户改动；若之前本就无未保存改动，基线随之推进
  if (wasClean) setBaseline()
}

// 顶栏「刷新」：重新拉取主窗口的最新设置（GRD 卫星树/各天线设置/实时星位 + 城市库/载波信号选项），并按最新数据重算
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  _suppressRO = true        // 抑制下方表单/站点回填触发的 watcher，整套扇出最后只跑一次
  clearTimeout(_roT)
  try {
    reloadSatTree()   // 重读 globe3d/settings.grd（树/天线 cfg）+ grdLive 实时位置（数据未变则复用缓存，不重解析 GRD）
    try { const c = api && await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    try { await refreshGrdFill() } catch (e) { /* keep */ }   // 直接回填(跳过防抖)，确保 EIRP/G·T 就绪后再算
    _suppressRO = false
    clearTimeout(_roT)        // 丢弃抑制期间可能挂起的计时器
    await refreshReadonly()   // 守卫解除后只跑一遍扇出
    toast('已刷新最新设置')
  } finally { _suppressRO = false; refreshing.value = false }
}
// 换卫星条目 / 改匹配天线 / 行经纬度变化 → 重算回填。仅看经纬度（避免回填值本身再触发循环）。
watch(() => [satId.value, curGrd.value && curGrd.value.eirpKey, curGrd.value && curGrd.value.gtKey,
  linkRows.map((r) => r.longitude + ',' + r.latitude).join(';'),
  linkRows.map((r) => r.rxLongitude + ',' + r.rxLatitude).join(';')],
  scheduleGrdFill)
const sel = computed(() => links.value[selected.value] || null)
// 核心指标（详细预算首块）：取当前选中链路的完整结果
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))

// 供图表区「参数扫描」用的引擎入参：计算时按行原样留底（见 compute()），不在此处重新组装。
// 重新组装会与「输入已变」状态打架——用户算完又改了表单时，重组出来的是新参数，
// 扫描曲线就不再经过详细预算里正在显示的那一点了。留底则保证图、表、曲线永远同一次计算。
const sweepParamsByRow = ref({})
const selParams = computed(() => (sel.value ? (sweepParamsByRow.value[sel.value.rowId] || null) : null))
// 图表区显示开关（功能区「视图 → 图表」）。关掉时详细预算只剩表：图表整块不渲染，
// 里头的扫描自然也不会跑——不出图还占着 CPU 逐格重算引擎是说不过去的。
const showViz = ref((() => { try { return localStorage.getItem('linkbudget/viz/show') !== '0' } catch (e) { return true } })())
watch(showViz, (v) => { try { localStorage.setItem('linkbudget/viz/show', v ? '1' : '0') } catch (e) { /* ignore */ } })
// 链路视图的场景：站址与轨位取本行送进引擎的那份入参，仰角/方位/斜距取本行算出的结果——
// 图与左边的表说的是同一条链路的同一组数（见 shared/lbLinkScene.js）
const linkScene = computed(() => buildGeoScene(sel.value, selParams.value))

// —— 容量汇总（独立模块）——
// 汇总本批次所有已成功计算的链路：总带宽 = Σ 各链路载波带宽；总容量 = Σ 各链路容量。
// 单链路容量 = 频谱效率 η(bps/Hz) × 载波带宽 B(kHz) = 容量(kbps)；各链路载波信号配置可不同（η 各异），
// 故逐链路相乘再求和，而非用单一 η 乘总带宽。engine 已按链路输出 allocBandwidthResult / spectralEfficiencyResult。
// capacityKbpsOf 是单链路口径的唯一出处：列表/矩阵「容量」指标、容量汇总都从这里换算。
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult)       // 载波带宽 kHz
  const eta = parseFloat(d.spectralEfficiencyResult)  // 频谱效率 bps/Hz
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN   // 容量 kbps
}
// 总功率带宽 = Σ 各链路功率带宽（PowerBWResult = 功率占用 × 转发器带宽，kHz）——转发器资源占用的另一维：
// 与总带宽并列着看才知道整批是受功率限还是受带宽限（Σ功率带宽 = Σ载波带宽 即整批功带平衡，见「高级计算」）。
// pbwN = 出了这个数的链路条数；为 0（本批没一条算出功率带宽）时汇总行不出该项，而非显示一个 0。
const capacitySummary = computed(() => {
  const done = links.value.filter((l) => l && l.data && !l.error)
  let bwKHz = 0, capKbps = 0, pbwKHz = 0, pbwN = 0
  for (const l of done) {
    const bw = parseFloat(l.data.allocBandwidthResult)
    if (isFinite(bw)) bwKHz += bw
    const kbps = capacityKbpsOf(l.data)
    if (isFinite(kbps)) capKbps += kbps
    const pbw = parseFloat(l.data.PowerBWResult)
    if (isFinite(pbw)) { pbwKHz += pbw; pbwN++ }
  }
  return {
    count: done.length,
    failed: links.value.length - done.length,
    bwKHz, capKbps, pbwKHz, pbwN,
    avgEff: bwKHz > 0 ? capKbps / bwKHz : 0   // 带宽加权平均频谱效率 bps/Hz
  }
})
// 自适应单位：容量 kbps→Mbps→Gbps；带宽 kHz→MHz→GHz
function fmtCapacity(kbps) {
  const n = Number(kbps)
  if (!isFinite(n) || n <= 0) return { v: '0', u: 'kbps' }
  if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'Gbps' }
  if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'Mbps' }
  return { v: n.toFixed(n >= 100 ? 1 : 2), u: 'kbps' }
}
function fmtBandwidth(khz) {
  const n = Number(khz)
  if (!isFinite(n) || n <= 0) return { v: '0', u: 'kHz' }
  if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'GHz' }
  if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'MHz' }
  return { v: n.toFixed(n >= 100 ? 1 : 3), u: 'kHz' }
}
const capMain = computed(() => fmtCapacity(capacitySummary.value.capKbps))
const bwMain = computed(() => fmtBandwidth(capacitySummary.value.bwKHz))
const pbwMain = computed(() => (capacitySummary.value.pbwN ? fmtBandwidth(capacitySummary.value.pbwKHz) : null))

// —— 本行读数（容量汇总下方第二行，见 LbCapFoot）——
// 结果列多了要横滚才看得全，而用户看的往往就是刚点的那一行：把聚焦行的结果就地摊平成一行，
// 点哪行看哪行、重算即刷新。指标口径与「结果列」勾选完全一致（连列序也一致），只是换了个横排读法。
// 单位取该列此次计算共选的档位（resColUnits），与表头/单元格里的数完全一致。
const focusRowId = ref('')
const rowReadout = computed(() => {
  if (!linkRows.length) return null
  let idx = linkRows.findIndex((r) => r._id === focusRowId.value)
  if (idx < 0 && sel.value) idx = linkRows.findIndex((r) => r._id === sel.value.rowId)   // 还没点过表 → 跟详细预算走
  if (idx < 0) return null
  const row = linkRows[idx]
  const link = links.value.find((l) => l.rowId === row._id) || null
  const m = computedVals.value[row._id] || null
  const items = []
  for (const def of (m ? RESULT_DEFS.filter((d) => resultKeys.value.includes(d.key)) : [])) {
    const v = m['_' + def.key]
    if (v === undefined || v === null || v === '' || v === '—') continue
    const n = parseFloat(v)   // 着色口径同结果单元格（见 cellClassFn）：负余量 / 超占用转红
    const bad = isFinite(n) && (def.key === 'linkmargin' ? n < 0
      : (def.key === 'powerUsageRatio' || def.key === 'bandwidthUsageRatio') ? n > 100 : false)
    items.push({ key: def.key, label: def.label, value: v, unit: resColUnits.value[def.key] || def.unit || '', tip: def.tip || def.label, bad })
  }
  const name = link ? `${link.txName} → ${link.rxName}`
    : [row.earthStationLocation, row.rxEarthStationLocation].filter(Boolean).join(' → ')
  return { no: idx + 1, name, err: (link && link.error) || '', items }
})

async function compute() {
  if (!api) { error.value = '引擎需在桌面客户端中运行'; return }
  if (!linkRows.length) { error.value = '请至少添加一条链路'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const sweepStore = {}
    // 先把整表各行的入参组齐，再一次 IPC 连算完：逐行口径与单条调用完全一致，
    // 只是把「行数」次主进程往返压成一次（批量入口不可用时自动逐行回退）。
    const specs = []
    for (let i = 0; i < linkRows.length; i++) {
      const row = linkRows[i]
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      const { satParams, linkParams } = buildParams(curSat.value.form, bbForm, row, row, txEs, resolveEs(row.rxStationId).form)
      // 计算方式与系统余量/超发量随该行所选载波；「设置功放功率」另取发端站型的功放功率（站的硬件属性）
      const opt = calcOptOf(bbForm, txEs)
      // 留底本行真正送进引擎的那份入参，供图表区参数扫描原地重跑（见 selParams）
      sweepStore[row._id] = { satParams, linkParams, opt }
      specs.push({ sat: satParams, link: linkParams, opt })
    }
    const results = api.linkBudget.computeModeBatch
      ? await api.linkBudget.computeModeBatch(specs)
      : await Promise.all(specs.map((s) => api.linkBudget.computeMode(s.sat, s.link, s.opt)))
    for (let i = 0; i < linkRows.length; i++) {
      const row = linkRows[i]
      const txName = row.earthStationLocation || ('发' + (i + 1))
      const rxName = row.rxEarthStationLocation || ('收' + (i + 1))
      const base = { i, rowId: row._id, txName, rxName }
      const r = results && results[i]
      if (r && r.success) {
        const d = r.data
        // 负仰角（卫星在地平线下、几何上不可见）→ 硬拦截，不出预算数字、判不可行（收发双侧都判）。
        const txBad = d.elevationValidation && d.elevationValidation.valid === false
        const rxBad = d.rxElevationValidation && d.rxElevationValidation.valid === false
        if (txBad || rxBad) {
          const parts = []
          if (txBad) parts.push('发端仰角 ' + d.elevationResult + '°')
          if (rxBad) parts.push('收端仰角 ' + d.rxElevationResult + '°')
          out.push({ ...base, data: null, error: '卫星不可见（' + parts.join('，') + '）' })
          continue
        }
        const m = parseFloat(d.linkmargin)
        const pUse = parseFloat(d.powerUsageRatio); const bUse = parseFloat(d.bandwidthUsageRatio)
        // 合格判定按本行自己的方式：设置余量看资源是否够（功率/带宽占用 ≤100%），其它方式看余量 ≥0
        const ok = specs[i].opt.mode === 'margin' ? (!(pUse > 100) && !(bUse > 100)) : (!isNaN(m) && m >= 0)
        // resolvedMargin＝求解器最终喂给引擎的余量（功带平衡等方式下由它解出）。留全精度原值：
        // 高级计算的组配平要拿它做归一化基准，data.marginResult 已按显示精度截成 2 位小数。
        out.push({ ...base, data: d, ok, resolvedMargin: r.resolvedMargin })
      } else {
        out.push({ ...base, data: null, error: (r && r.message) || '失败' })
      }
    }
    sweepParamsByRow.value = sweepStore
    const prevSel = sel.value
    links.value = out
    // 结果列写回 computedVals（全部 RESULT_DEFS 都算：事后勾选新列即刻可见，无需重算）。
    // 写入前按整列共选显示单位（见 resColUnits），值与列头单位一致
    const colVal = (d, def) => (def.key === 'capacityMbps' ? capacityKbpsOf(d) / 1000 : parseFloat(d && d[def.key]))
    const colAd = {}
    for (const def of RESULT_DEFS) {
      if (!def.unit) continue
      const p = pickColumn(out.map((l) => (l.data ? colVal(l.data, def) : NaN)), def.unit)
      if (p) colAd[def.key] = p
    }
    resColUnits.value = Object.fromEntries(Object.entries(colAd).map(([k, p]) => [k, p.unit]))
    for (const l of out) {
      const d = l.data
      const patch = {}
      for (const def of RESULT_DEFS) {
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
      setVals(l.rowId, patch)
    }
    // 计算后保持当前查看位置（按行 _id 定位；行数变化则夹取原下标），不跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
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
  segments.value = await api.linkBudget.waterfall({
    results: JSON.parse(JSON.stringify(l.data)), lang: reportLang.value, orbitType: 'GEO',
    txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '')
  })
}
// 链路表聚焦行变化 → 表脚「本行读数」跟随（无结果的新行也跟）；有结果时详细预算一并切到该行链路
function onRowFocus(idx, rowId) {
  focusRowId.value = rowId
  if (!links.value.length) return
  const i = links.value.findIndex((l) => l.rowId === rowId)
  if (i >= 0 && i !== selected.value) { selected.value = i; loadWaterfall() }
}

// —— 高级计算：多载波功带平衡（VSAT 组网 / CNC 载波叠加）——
// 单链路的功带平衡只看自己，而转发器上跑的是一组载波：前向 TDM 超发、返向 TDMA 欠发，各自都不平衡，
// 合起来 Σ功率带宽 = Σ载波带宽 才是要的结果（CNC 则是两条链路占同一段频谱、功率叠加）。求解在核心
// 算法外层（shared/advBalance.js，闭式解），结果落成各载波的「设置余量」，再照常走一次正常计算——
// 屏幕上的每个数仍然出自引擎本身，这里只决定喂进去的余量。
const advDlg = reactive({ open: false, busy: false })
const advRemap = ref(null)   // 上一次应用时的「原载波id → 派生副本id」映射，回传给对话框
// 送进对话框的候选链路：全部行 + 各自上一次的计算结果（载波带宽/功率带宽/实际余量）
const advRows = computed(() => linkRows.map((row, i) => {
  const bb = resolveBaseband(row.basebandId)
  const l = links.value.find((x) => x.rowId === row._id) || null
  const d = (l && l.data) || null
  const name = l ? `${l.txName} → ${l.rxName}`
    : ([row.earthStationLocation, row.rxEarthStationLocation].filter(Boolean).join(' → ') || '链路 ' + (i + 1))
  const marginDb = d ? (isFinite(l.resolvedMargin) ? l.resolvedMargin : parseFloat(d.marginResult)) : NaN
  return {
    no: i + 1, rowId: row._id, name, carrierId: bb.id, carrierName: bb.name,
    bwKHz: d ? parseFloat(d.allocBandwidthResult) : NaN,
    pbwKHz: d ? parseFloat(d.PowerBWResult) : NaN,
    marginDb,
    // 基准余量：本功能上一轮自己写进去的余量不算「当前」（含着那一轮的偏置，再当基准就一轮叠一层）
    baseDb: advBaseMargin(bb.form, marginDb),
    error: l ? (l.error || '') : '未计算'
  }
}))
// 转发器带宽（占用率读数用）：优先取结果里引擎回报的那份，没有结果则取当前卫星条目
const advTpBwMHz = computed(() => {
  const d = (links.value.find((l) => l.data) || {}).data
  const v = parseFloat(d ? d.transponderBandwidthResult : (curSat.value && curSat.value.form.transponderBandwidth))
  return isFinite(v) ? v : 0
})
// 参考态必须是「此刻这套输入」算出来的：没算过或输入已变，先算一遍再开
async function openAdvDlg() {
  if (!links.value.length || resultsStale.value) await compute()
  advDlg.open = true
}
// 落地：把解出的余量写进载波配置的「设置余量」，随后重算全表。写进哪一份由 planAdvWriteback 定
// （纯函数，两窗共用）：VSAT 一律派生专用副本、用户原来的载波配置一字不动，反复配平复用同一份副本；
// CNC 两条链路本就引用同一份载波，余量是它自己的属性，故就地改（仅被未勾选链路引用时才派生）。
async function applyAdvPlan(plan) {
  const { ops } = planAdvWriteback({
    mode: plan.mode, carriers: plan.carriers, rowIds: plan.rowIds,
    rows: linkRows.map((r) => ({ rowId: r._id, carrierId: resolveBaseband(r.basebandId).id })),
    configs: basebandConfigs.map((c) => ({ id: c.id, name: c.name, form: c.form }))
  })
  const forked = []
  const remap = {}
  for (const op of ops) {
    if (op.kind === 'fork') {
      const from = basebandConfigs.find((b) => b.id === op.fromId)
      if (!from) continue
      const copy = { id: 'bb' + (_bbSeq++), name: op.name, nameAuto: false, form: JSON.parse(JSON.stringify(from.form)) }
      Object.assign(copy.form, op.formPatch)
      basebandConfigs.push(copy)
      const ids = new Set(op.rowIds)
      for (const r of linkRows) if (ids.has(r._id)) r.basebandId = copy.id
      forked.push(copy.name); remap[op.fromId] = copy.id
    } else {
      const target = basebandConfigs.find((b) => b.id === op.carrierId)
      if (target) Object.assign(target.form, op.formPatch)
    }
  }
  advRemap.value = remap   // 载波换了 id：把对话框里那份偏置一并搬过去
  advDlg.busy = true
  try { await compute() } finally { advDlg.busy = false }
  toast(`已按「${plan.mode === 'cnc' ? 'CNC 载波叠加' : 'VSAT 组网平衡'}」口径配平 ${plan.rowIds.length} 条链路`
    + (forked.length ? `；配平余量写入新建载波配置「${forked.join('」「')}」，原配置未改动` : ''))
}

// —— 经纬度 → 降雨率/海拔自动填（与小程序一致；选址或改经纬度触发，逐站）——
// skip：粘贴/填充已显式带入的降雨/海拔列（整行复制场景），重算时跳过不覆盖
async function fillGeoRow(row, lonK, latK, rainK, elevK, skip) {
  if (!api) return
  const lat = parseFloat(row[latK]); const lon = parseFloat(row[lonK])
  if (isNaN(lat) || isNaN(lon)) return
  try {
    const g = await api.linkBudget.geoFill(lat, lon)
    if (!g) return
    if (g.rainRate !== null && g.rainRate !== undefined && !(skip && skip.has(rainK))) row[rainK] = String(g.rainRate)
    if (g.altitude !== null && g.altitude !== undefined && !(skip && skip.has(elevK))) row[elevK] = String(g.altitude)
  } catch (e) { /* 保留原值 */ }
}
// 城市关键词检索（城市名 / 省份 / 拼音缩写）——交给引擎 core.searchCities（与小程序口径一致）
const citySearch = (q) => (api ? api.linkBudget.searchCities(q) : Promise.resolve([]))
// 链路表一行含发/收两个站址组：按 StationGrid 回调的 kind（'tx'/'rx'）分侧补降雨/海拔
const autoGeoRow = (row, skip, kind) => (kind === 'rx'
  ? fillGeoRow(row, 'rxLongitude', 'rxLatitude', 'rxRainRate', 'rxAltitude', skip)
  : fillGeoRow(row, 'longitude', 'latitude', 'rainRate', 'altitude', skip))

// —— Phase 4：配置持久化（含卫星 / EIRP·GT 天线匹配选择）——
// ① 整盘工作台状态序列化（卫星/载波信号参数、发收信站群、计算方式、GRD 匹配选择、矩阵显示）。
// ② 自动保存「上次会话」到 localStorage：关掉再开窗口即原样恢复（卫星/天线选择不丢）。
// ③ 命名配置（配置列表）走 store.config.* 持久化到 userData/configs.json，可多套切换。
const STATE_KEY = 'linkbudget/last'
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

function serializeState() {
  // v3 场景 = 关联关系：链路行（站址 + 库条目 id 引用）+ 卫星选择。
  // 三库是全局资产（userData/library.json），不再随场景存副本；_ 前缀键（行内部 id / 计算列）一律剥离。
  // 计算方式/系统余量/超发量自 v3 起随载波入库（求解策略是载波的属性），故不再是场景字段。
  return {
    v: 3,
    rows: linkRows.map((r) => { const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; return o }),
    satId: satId.value
  }
}
// v2 及更早：计算方式/系统余量/超发量是场景级字段 → 下沉到该场景各行所引的载波条目
// （与旧全局「设置功放功率」目标值下沉为站型 paPowerW 同一办法）。场景重存为 v3 后不再触发。
function adoptSceneCalc(st) {
  if (!st || st.v >= 3) return
  const has = (v) => v !== undefined && v !== null && String(v) !== ''
  if (!has(st.calcMode) && !has(st.overDb) && !has(st.targetMarginDb)) return
  const ids = new Set(linkRows.map((r) => r.basebandId || ''))
  for (const id of ids) {
    const f = resolveBaseband(id).form
    if (has(st.calcMode)) f.calcMode = st.calcMode
    if (has(st.overDb)) f.overDb = st.overDb
    if (has(st.targetMarginDb)) f.margin = st.targetMarginDb
  }
}
// 旧场景（v1.4.2 及以前）的方向图匹配是场景级 state.grdSel → 播种到本场景所引的卫星库条目。
// 条目已有匹配则不动：幂等（反复 applyState 结果一致），也避免另一个旧场景的选择盖掉用户在库里改过的匹配。
function adoptSceneGrd(g) {
  const c = curSat.value
  if (!c || !g || !g.satFolder) return
  if (c.grd && c.grd.satFolder) return
  c.grd = normGrd(g)
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // —— v2 场景（本版结构）：行 + 库引用直读；库是全局资产不随场景载入 ——
  if (Array.isArray(st.rows)) {
    linkRows.splice(0, linkRows.length, ...st.rows.map((r) => ({ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) })))
    satId.value = st.satId || ''
    adoptSceneCalc(st)                        // v2 场景的计算策略 → 下沉到所引载波库条目
    if (st.grdSel) adoptSceneGrd(st.grdSel)   // 旧场景的方向图匹配 → 下沉到所引卫星库条目
    return
  }
  // —— 旧结构迁移（v1.x：内嵌库 + 发/收两张站表）——
  // 内嵌库条目按内容去重并入全局库（adoptEntries 同内容⇒同 id，反复 applyState 映射稳定 → 指纹不误报）；
  // 行引用经映射改写；双表并单表（旧矩阵模式按 m×n 展开，常规按序号配对、短侧末行复用补齐）。
  // ① 载波库（更旧的单一 carrierForm 包成一份）
  const bbUi = { rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, rateAnchor: 'info', rateAnchorValue: null }
  // nameAuto：旧场景条目名多是「配置1」这类占位名 → 按历史默认名推定，并库后交给自动命名接手
  const bbEntries = (Array.isArray(st.basebandConfigs) && st.basebandConfigs.length)
    ? st.basebandConfigs.map((c) => ({ id: c.id, name: c.name || '配置', nameAuto: adoptAutoFlag('carrier', c), form: { ...defaultsFor(CARRIER_FIELDS), ...bbUi, ...c.form } }))
    : (st.carrierForm ? [{ id: '__bb0', name: '默认', nameAuto: true, form: { ...defaultsFor(CARRIER_FIELDS), ...bbUi, ...st.carrierForm } }] : [])
  const bbMap = adoptEntries(basebandConfigs, bbEntries, () => makeBasebandConfig('载波'))
  // ② 地球站库：三代结构统一（内嵌库 / 过渡版收发分口径展开重迁 / 行内射频 migrateLegacyEs）
  let esList = (Array.isArray(st.esConfigs) && st.esConfigs.length) ? st.esConfigs : null
  let txRows = Array.isArray(st.tx) ? st.tx : null
  let rxRows = Array.isArray(st.rx) ? st.rx : null
  if (esList && esList.some((c) => c && c.form && c.form.rxAntennaDiameter !== undefined && String(c.form.rxAntennaDiameter) !== String(c.form.antennaDiameter))) {
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
  if (!esList) {
    let _mn = 0
    const mig = migrateLegacyEs({ txRows: txRows || [], rxRows: rxRows || [], esTxFields: ES_TX_FIELDS, esRxFields: ES_RX_FIELDS, esCommonFields: ES_COMMON_FIELDS, makeId: () => 'esm' + (++_mn) })
    if (mig) { esList = mig.esConfigs; txRows = mig.txRows; rxRows = mig.rxRows }
  }
  const esEntries = (esList || []).map((c, i) => {
    // 频率/极化与干扰项都在卫星侧（见下方 SAT_FIELDS 回填）：地球站配置只取本库字段集，多余的旧键自然落空。
    const form = { ...defaultsFor(ES_FIELDS), ...c.form }
    // 旧全局「设置功放功率」目标值 → 下沉为各站型的功放功率（功放已随站型入库）
    if (st.targetPowerW != null && String(st.targetPowerW).trim() !== '') form.paPowerW = st.targetPowerW
    return { id: c.id || ('esb' + i), name: c.name || '站型', nameAuto: adoptAutoFlag('es', c), form }
  })
  const esMap = adoptEntries(esConfigs, esEntries, () => makeEsConfig('站型'))
  // ③ 卫星：旧单一 satForm + 旧场景级 grdSel（方向图匹配）→ 并成一个卫星库条目
  //（取 SAT_FIELDS 键；干扰七项现留卫星侧，SAT_FIELDS 已含之，直接回填。内容指纹含 grd，见 adoptEntries
  //  extraKeys——同参数不同方向图是两颗星，不可去重成一条）
  if (st.satForm) {
    const form = { ...defaultsFor(SAT_FIELDS) }
    for (const f of SAT_FIELDS) if (st.satForm[f.key] !== undefined) form[f.key] = st.satForm[f.key]
    const satMap = adoptEntries(satConfigs, [{ id: '__sat0', name: form.satelliteName || '卫星', nameAuto: true, form, grd: normGrd(st.grdSel) }], () => makeSatConfig(), ['grd'])
    satId.value = satMap.__sat0 || ''
  } else { satId.value = ''; adoptSceneGrd(st.grdSel) }
  // ④ 双表 → 单链路表（行引用经映射改写；收端引用列改名 rxStationId）
  const remapT = (r) => { const o = { ...r }; o.basebandId = (o.basebandId && bbMap[o.basebandId]) || ''; o.stationId = (o.stationId && esMap[o.stationId]) || ''; return o }
  const remapR = (r) => { const o = { ...r }; o.rxStationId = (o.stationId && esMap[o.stationId]) || ''; delete o.stationId; return o }
  const tArr = (txRows || []).map(remapT), xArr = (rxRows || []).map(remapR)
  const mkRow = (t, x) => ({ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), ...(t || null), ...(x || null), _id: 's' + (_sid++) })
  const merged = []
  if (st.linkPairMode === 'matrix' && tArr.length && xArr.length) {
    for (const t of tArr) for (const x of xArr) merged.push(mkRow(t, x))
  } else {
    const n = Math.max(tArr.length, xArr.length)
    for (let i = 0; i < n; i++) merged.push(mkRow(tArr[Math.min(i, tArr.length - 1)], xArr[Math.min(i, xArr.length - 1)]))
  }
  if (merged.length) linkRows.splice(0, linkRows.length, ...merged)
  // 计算策略下沉到所引载波条目；系统余量场景级字段优先，缺则沿用旧存档里 carrierForm.margin（已随条目并库）
  adoptSceneCalc(st)
}
let _stateT = null
// 「上次会话」存盘要带上 activeId：否则重开窗口时配置列表没有任何一项被聚焦，
// 但工作区却显示着上次的内容，看起来像是内容跟列表对不上号（用户反馈的困惑点）。
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* 配额满等忽略 */ } dirtyFlag.value = isDirty() }, 600) }
watch([linkRows, satId, activeId], scheduleSaveState, { deep: true })

// —— 命名配置 CRUD ——
// 注意：Electron 不支持 window.prompt（静默返回 null → 之前「保存不了」的根因）。改用应用内命名弹窗。
// 与 NGSO / 再生式共用 configs.json：按体制过滤——文件夹按顶层 orbitType，配置按 state.orbitType。
// GEO 是历史默认体制：老配置无 orbitType 字段，故 GEO 用「白名单」——只收「无 orbitType（遗留 GEO）
// 或显式 GEO」的项。切忌用「排除 NGSO」式黑名单：每新增一种体制（如 REGEN）都会漏网串到 GEO 列表。
async function loadConfigs() {
  try {
    const all = (api && await api.store.listConfigs()) || []
    configs.value = all.filter((it) => (it.type === 'folder') ? (it.orbitType === 'GEO') : (!it.state || !it.state.orbitType || it.state.orbitType === 'GEO'))
  } catch (e) { configs.value = [] }
  pruneExpanded()
}
// 剪除已不存在的文件夹 id，防展开集无限膨胀
function pruneExpanded() {
  const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
  let changed = false
  for (const id of [...expandedFolders.value]) if (!ids.has(id)) { expandedFolders.value.delete(id); changed = true }
  if (changed) persistExpanded()
}
function defaultCfgName() { const nm = curSat.value && curSat.value.form.satelliteName; return (nm ? nm + ' ' : '') + `链路 ${linkRows.length} 条` }
// 命名弹窗：保存为新配置
const cfgDlg = reactive({ open: false, name: '' })
function openSaveDlg() { if (!api) { toast('保存需在桌面客户端中运行'); return } cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
async function confirmCfgDlg() {
  const name = (cfgDlg.name || '').trim()
  if (!name) { toast('请输入配置名称'); return }
  const item = await api.store.saveConfig({ name, state: serializeState() })
  cfgDlg.open = false; await loadConfigs(); if (item && item.id) { activeId.value = item.id; setBaseline() }
  toast('已保存配置：' + name)
}
// 双击配置 → 原地改名（行内输入框）
const editing = reactive({ id: null, name: '' })
function startRename(c) {
  editing.id = c.id; editing.name = c.name
  nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } })
}
function cancelRename() { editing.id = null }
async function commitRename() {
  const id = editing.id; if (id == null) return
  const c = configs.value.find((x) => x.id === id)
  const nm = (editing.name || '').trim()
  editing.id = null
  // 只传 { id, name }：saveConfig 做 merge，既不动 state/parentId，又对文件夹（无 state）通用，且规避 Proxy 克隆报错
  if (c && nm && nm !== c.name) { await api.store.saveConfig({ id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
}
async function updateConfig() {
  if (!api || !activeId.value) return
  const c = configs.value.find((x) => x.id === activeId.value); if (!c) return
  await api.store.saveConfig({ id: c.id, name: c.name, state: serializeState() })
  setBaseline()
  await loadConfigs(); toast('已保存修改到：' + c.name)
}
// 存盘按钮：有当前配置则更新，否则保存为新（两个按钮都能把现有配置存下来）
async function saveCurrent() {
  if (!api) { toast('保存需在桌面客户端中运行'); return }
  if (activeId.value) await updateConfig()
  else openSaveDlg()
}
// 点击配置 = 载入到工作台编辑（设为当前；随后改参数 + 点存盘即保存回该配置）。静默载入。
function applyConfig(c) { if (!c) return; activeId.value = c.id; applyState(c.state); setBaseline() }
// 守卫式选择：从已改动的现有配置离开前提示是否保存
async function selectConfig(c) {
  if (!c || c.id === activeId.value) return
  if (!(await guardedLeave())) return
  applyConfig(c)
}
async function removeConfig(id, e) {
  if (e) e.stopPropagation()
  if (!api) return
  await api.store.deleteConfig(id)
  if (activeId.value === id) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && cfgClip.value.id === id) cfgClip.value = null
  await loadConfigs()
}

// —— 文件夹（分组）——
// 通用确认弹窗（Electron 渲染进程无原生 confirm）
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
// 新建文件夹：parentId 为空=根，否则建在该文件夹下；建后自动展开并进入改名
async function addFolder(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  const item = await api.store.saveConfig({ type: 'folder', name: uniqueCfgName('新建文件夹'), parentId: parentId || null, orbitType: 'GEO' })
  if (parentId) { expandedFolders.value.add(parentId) }
  if (item && item.id) expandedFolders.value.add(item.id)
  persistExpanded()
  await loadConfigs()
  if (item && item.id) startRename(item)
}
// 拖拽/粘贴移动：把 dragId 项挪到目标位置。纯元数据操作，不载入、不走 guardedLeave（parentId 不入指纹，脏态与 baseline 不受影响）
async function onMove(payload) {
  if (!api || !payload || !payload.dragId) return
  await api.store.moveItem({ id: payload.dragId, parentId: payload.parentId, anchorId: payload.anchorId, position: payload.position })
  if (payload.position === 'inside' && payload.parentId) { expandedFolders.value.add(payload.parentId); persistExpanded() }
  await loadConfigs()
}
// 删除文件夹（级联删子项）：非空先确认，并清掉受影响的 activeId/baseline/剪贴板/展开态
async function removeFolder(folder) {
  if (!api || !folder) return
  const hasChildren = configs.value.some((c) => c.parentId === folder.id)
  if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
  const removed = (await api.store.deleteFolder(folder.id)) || [folder.id]
  const rset = new Set(removed)
  if (activeId.value && rset.has(activeId.value)) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && rset.has(cfgClip.value.id)) cfgClip.value = null
  for (const id of removed) expandedFolders.value.delete(id)
  persistExpanded()
  await loadConfigs()
  toast('已删除文件夹：' + folder.name)
}
// 列表项删除分发：文件夹级联删除，配置单删
function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }
// 默认（空白）配置内容：一条默认链路行（收端引用库中第二份站型，经典 6.2m 发 / 3.7m 收基线）
function blankState() {
  return {
    v: 3,
    rows: [{ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), rxStationId: (esConfigs[1] && esConfigs[1].id) || '' }],
    satId: ''
  }
}
function uniqueCfgName(base) {
  const names = new Set(configs.value.map((c) => c.name))
  if (!names.has(base)) return base
  let i = 2; while (names.has(base + ' ' + i)) i++; return base + ' ' + i
}
// ＋ / 右键「添加空白配置」：新建一份默认参数配置并载入（parentId 非空=建在该文件夹内）
async function addBlankConfig(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  if (!(await guardedLeave())) return
  const state = blankState()
  const item = await api.store.saveConfig({ name: uniqueCfgName('新配置'), state, parentId: parentId || null })
  if (parentId) { expandedFolders.value.add(parentId); persistExpanded() }
  await loadConfigs()
  if (item && item.id) { activeId.value = item.id; applyState(state); setBaseline() }
  toast('已添加空白配置')
}

// —— 配置 复制 / 剪切 / 粘贴（含 Ctrl+C/X/V）——
// 剪贴板仅对「配置」（文件夹的移动/归并走拖拽或右键「粘贴到此文件夹」）——文件夹无 state，克隆会炸。
const cfgClip = shallowRef(null)   // { mode:'copy'|'cut', id, name, state }；shallowRef 避免 state 被再代理
function copyConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'copy', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已复制：' + c.name) }
function cutConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'cut', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已剪切：' + c.name + '（粘贴以换位置）') }
// 粘贴：复制=生成副本；剪切=移动原配置。into=true 且目标是文件夹 → 放入其内；否则放到目标之后；无目标=根末尾。
async function pasteConfig(targetId, into = false) {
  const clip = cfgClip.value; if (!clip || !api) return
  let movingId
  if (clip.mode === 'copy') { const item = await api.store.saveConfig({ name: uniqueCfgName(clip.name + ' 副本'), state: JSON.parse(JSON.stringify(clip.state)) }); movingId = item && item.id }
  else movingId = clip.id
  if (movingId) {
    const target = (targetId && targetId !== movingId) ? configs.value.find((c) => c.id === targetId) : null
    if (into && target && target.type === 'folder') await api.store.moveItem({ id: movingId, parentId: target.id, anchorId: null, position: 'inside' })
    else if (target) await api.store.moveItem({ id: movingId, parentId: null, anchorId: target.id, position: 'after' })
    else await api.store.moveItem({ id: movingId, parentId: null, anchorId: null, position: 'inside' })
    if (into && target && target.type === 'folder') { expandedFolders.value.add(target.id); persistExpanded() }
  }
  if (clip.mode === 'cut') cfgClip.value = null
  await loadConfigs()
  toast('已粘贴')
}
// 配置面板内的 Ctrl+C/X/V（作用于当前聚焦配置；编辑/输入框中不拦截）
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

// —— 右键菜单 ——
const ctxMenu = reactive({ open: false, x: 0, y: 0, configId: null })
const ctxConfig = computed(() => (ctxMenu.configId ? configs.value.find((c) => c.id === ctxMenu.configId) : null))
const ctxIsFolder = computed(() => !!(ctxConfig.value && ctxConfig.value.type === 'folder'))
function openCtx(e, c) {
  e.preventDefault()
  ctxMenu.configId = c ? c.id : null
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 170)   // 防止贴右/下边溢出
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - 230)
  ctxMenu.open = true
}
function ctxDo(fn) { ctxMenu.open = false; fn() }

// —— 改动检测 + 离开提示 + 恢复默认 ——
// 指纹只取「配置内容」字段（不含页签/结果列勾选等视图态），避免切页签/调结果列误判为改动。
function fingerprintOf(s) {
  // 库是全局资产（自动保存、不入场景）：指纹只含场景自身内容（行/引用）；
  // 方向图匹配已随卫星库条目走（v1.4.3）、计算策略已随载波库条目走（v1.3.8），不再是场景内容 → 不入指纹
  return stableStringify({ rows: s.rows, satId: s.satId })
}
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
// dirtyFlag：顶栏「未保存」小灯的渲染缓存——isDirty() 全量指纹较贵，不能每帧算；
// 随「上次会话」防抖存盘一起刷新（见 scheduleSaveState），setBaseline 即刻清灯。
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
function activeName() { const c = configs.value.find((x) => x.id === activeId.value); return c ? c.name : '' }
// 离开当前（已改动的）配置前的三选一提示，返回是否可继续
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

// —— 分享 / 导入（弹窗与全部流程在 components/LbShareDialog.vue，三窗共用）——
// 本窗口只提供「体制适配层」：本机有哪些配置与库、场景引用了哪些条目、并库后怎么改写引用。
const deviceId = ref('')   // 本机用户ID（按 MAC 派生；管理员机器由主进程硬编码为 master1/2/3，不可改）
const shareConfigured = ref(false)
const shareOpen = ref(false)
function openShareDlg() { shareOpen.value = true }
const packBase = (c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })
// 库 spec（口径与 serializeLibrary 一致）。卫星的 sanitize：方向图匹配指向【本机】GRD 天线树节点
//（grd.satFolder = 'lb:' + 卫星条目 id，见 shared/lbGrdImport.js），原样发过去只会挂到对端另一颗星上，
// 故打包时一律清空——对端拿到的是「参数与轨位齐全、方向图待自行匹配」这个诚实状态。
const shareLib = {
  es: { arr: esConfigs, label: '地球站', keys: [], pack: packBase, makeNew: () => makeEsConfig('站型') },
  carrier: { arr: basebandConfigs, label: '载波', keys: [], pack: packBase, makeNew: () => makeBasebandConfig('载波') },
  sat: {
    arr: satConfigs, label: '卫星', keys: ['grd'],
    pack: (c) => ({ ...packBase(c), grd: normGrd(c.grd) }),
    sanitize: (e) => ({ ...e, grd: blankGrd() }),
    makeNew: () => makeSatConfig()
  }
}
// 场景引用了哪些库条目（空串 = 用库里第一份，由 resolveRefs 按引擎口径解析）。
// 旧结构（v1.x 双表 + 内嵌库）自带全部参数，无需闭包——applyState 那条迁移路径会把内嵌库并进来。
function shareRefsOf(st) {
  if (!st || !Array.isArray(st.rows)) return { es: [], carrier: [], sat: [] }
  const es = [], carrier = []
  for (const r of st.rows) { es.push(r.stationId || '', r.rxStationId || ''); carrier.push(r.basebandId || '') }
  return { es, carrier, sat: [st.satId || ''] }
}
// 打包前把空引用钉成显式 id：'' 的意思是「用库里第一份」，到了对端就成了「用他库里第一份」
function sharePinRefs(st) {
  if (!st || !Array.isArray(st.rows)) return st
  const s = JSON.parse(JSON.stringify(st))
  for (const r of s.rows) {
    r.stationId = resolveRefId(esConfigs, r.stationId)
    r.rxStationId = resolveRefId(esConfigs, r.rxStationId)
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
  }
  s.satId = resolveRefId(satConfigs, s.satId)
  return s
}
function shareRemap(state, idMap) {
  if (!state || !Array.isArray(state.rows)) return
  for (const r of state.rows) {
    if (r.stationId) r.stationId = idMap.es[r.stationId] || ''
    if (r.rxStationId) r.rxStationId = idMap.es[r.rxStationId] || ''
    if (r.basebandId) r.basebandId = idMap.carrier[r.basebandId] || ''
  }
  if (state.satId) state.satId = idMap.sat[state.satId] || ''
}
// —— 发到小程序：一条链路 = 一份小程序配置（逐行摊平，见 shared/lbMiniExport.js）——
// 小程序没有三库结构，故不发分享包而发【摊平后的扁平配置】；摊平要用到本机三个库（行里存的是
// 引用），故这一层留在体制适配层里。结果只随「工作台上正算着的那一份」走（见 buildMini 的 id）。
function toMiniItems(picked) {
  const out = []
  const taken = new Set()
  // 行 _id 在 serializeState 里被剥掉了（_ 前缀键不入场景），故结果按【行下标】对齐——
  // 只有当前正算着的那一份才对得上，别的配置不带结果（见下 useRes）
  const fresh = !resultsStale.value && links.value.length ? links.value : null
  for (const p of picked || []) {
    const st = p && p.state
    if (!st || !Array.isArray(st.rows) || !st.rows.length) continue
    const sat = resolveSat(st.satId)
    const useRes = fresh && (p.id === '__draft__' || p.id === activeId.value) && fresh.length === st.rows.length
    st.rows.forEach((row, i) => {
      const bb = resolveBaseband(row.basebandId)
      const txEs = resolveEs(row.stationId)
      const rxEs = resolveEs(row.rxStationId)
      const l = useRes ? fresh[i] : null
      out.push(miniConfigItem(buildMiniConfig({
        mod: 'GEO',
        P: GEO_PARAMS,
        name: miniConfigName(p.name, row.earthStationLocation, row.rxEarthStationLocation, i, taken),
        forms: { satForm: sat.form, carrierForm: bb.form, txStation: row, rxStation: row, txEs: txEs.form, rxEs: rxEs.form },
        result: l && l.data ? l.data : null,
        resolvedMargin: l ? l.resolvedMargin : null,
        // 小程序的「波束」是一格纯文字（不参与计算）：有方向图匹配就写那颗星的名字，否则写卫星条目名
        beamInput: sat.form.satelliteName || sat.name || '',
        note: `${p.name || '配置'} · 第 ${i + 1} 行 · 载波「${bb.name || '默认'}」· 站型「${txEs.name || '默认'}」→「${rxEs.name || '默认'}」`
      }), 'GEO', `GEO:${p.id || ''}:${i}`))
    })
  }
  return out
}
const shareCtx = {
  mod: 'GEO',
  getConfigs: () => configs.value,
  getActiveId: () => activeId.value,
  getDraft: () => ({ name: defaultCfgName(), state: serializeState() }),
  lib: shareLib,
  refsOf: shareRefsOf,
  pinRefs: sharePinRefs,
  remapState: shareRemap,
  toMiniItems,
  saveConfig: (payload) => api.store.saveConfig(payload),
  onImported: async ({ last, plan, idMap }) => {
    await loadConfigs()
    if (last) {
      activeId.value = last.id
      applyState(last.state)
      setBaseline()
      // 新建的文件夹（连同已存在的父级）展开，导进来的配置得看得见落在哪
      const byId = new Map(configs.value.map((c) => [c.id, c]))
      const add = []
      let p = byId.get(last.id) && byId.get(last.id).parentId
      while (p && byId.has(p)) { add.push(p); p = byId.get(p).parentId }
      if (add.length) { expandedFolders.value = new Set([...expandedFolders.value, ...add]); persistExpanded() }
    } else {
      // 只带资源库的包：直接把侧栏切到资源库并选中新并进来的第一条
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

// —— 报表语言与报告导出 ——
// 报表语言：中文 / English（学术英文译法，与瀑布详情表的 WF_DICT 同源）。记住上次选择。
// 「详细预算」区与导出内容同吃这一个值——屏幕上核对的和交出去的报表得是同一份东西。
// localStorage 键沿用旧名 exportLang，保住用户已经存下的选择。
const reportLang = ref(localStorage.getItem('linkbudget/exportLang') || 'zh')
watch(reportLang, (v) => {
  try { localStorage.setItem('linkbudget/exportLang', v) } catch (e) { /* ignore */ }
  loadWaterfall()   // 段标题/行标签是 core 取数时按 lang 翻好的，换语言得重取一次
})
// —— 交付级报告导出（Excel 总报告 + 逐链路详情 / PDF 封面+目录+总报告+详情）——
// 流程在 shared/useLbReport.js（三窗共用），这里只把本窗的数据源接上去。
const vizRef = ref(null)
const appVersion = ref('')
// 某条已算链路实际用的求解策略：取计算时留底的那份入参（此后改库不改已出结果的口径）。
// 超发量只在「功带平衡下超发」方式下有意义，其余方式不入报告。
function calcOfLink(l) {
  const p = l && sweepParamsByRow.value[l.rowId]
  const key = (p && p.opt && p.opt.mode) || ''
  const info = CALC_MODES.find((m) => m.key === key)
  const en = reportLang.value === 'en'
  return {
    key,
    label: info ? (en ? info.enLabel : info.label) : key,
    margin: (p && p.linkParams && p.linkParams.margin) || '',
    overDb: key === 'overbalance' ? ((p && p.opt && p.opt.overDb) || '') : ''
  }
}
const { reportDlg, openReportDialog, runReport } = useLbReport({
  api,
  orbitType: 'GEO',
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
  // 计算方式随载波逐链路而定：封面/表头只在全表口径一致时报该方式（不一致则不报，各链路详情自带「计算设置」块）
  calc: () => {
    const modes = new Set(links.value.map((l) => calcOfLink(l).key).filter(Boolean))
    return {
      mode: modes.size === 1 ? calcOfLink(links.value[0]).label : '',
      satelliteName: curSat.value ? curSat.value.form.satelliteName : '',
      frequencyBand: curSat.value ? curSat.value.form.frequencyBand : ''
    }
  },
  calcFor: (l) => { const c = calcOfLink(l); return { mode: c.label, targetMargin: c.margin, overDb: c.overDb } },
  defaultName: (en) => {
    const s = curSat.value ? curSat.value.form.satelliteName : ''
    return en
      ? `GEO_Link_Budget_Report_${(s || 'Results').replace(/[^\w-]+/g, '_')}`
      : `GEO链路预算报告_${(s || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  setError: (m) => { error.value = m }
})

// 城市库
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
  // 「上次会话」只在能确定它属于哪个仍然存在的命名配置时才恢复并聚焦该配置——哪怕含未保存的
  // 编辑，也按该配置已保存的内容算基线，离开时仍会正确提示「未保存」。
  // 否则（从没聚焦过配置，或聚焦的配置已被删）一律保持工作区默认初始状态、不应用任何内容：
  // 避免「列表没有任何一项被选中，工作区却显示着不知道属于谁的内容」误导用户。
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      // 基线取「规整后的已存配置」：先 applyState(c.state) 走一遍与实时相同的规整管线再 setBaseline，
      // 而非直接指纹原始 c.state——否则旧版本配置一打开就因补默认/裁字段被误判「已改」。
      // 随后 applyState(st) 恢复上次会话（可能含未保存编辑）：一致则判干净、不误报；确有改动仍正确提示。
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
    }
  } catch (e) { /* 损坏忽略 */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  refreshReadonly()
  // 关窗守卫：主进程拦截原生关闭动作后转发到这里，复用与内部切换配置同一套「取消/不保存/保存」
  // 弹窗（guardedLeave/isDirty），答完（或本就无未保存改动）才回调 confirmClose() 真正关闭窗口。
  api?.linkBudget?.onCloseRequested?.(async () => {
    if (await guardedLeave()) api.linkBudget.confirmClose()
  })
  window.addEventListener('keydown', onGlobalKey)   // Ctrl+Enter = 计算
  window.addEventListener('focus', reloadSatTree)   // 单例窗口：切回本窗口即纳入「星座3D」新导入的 GRD
})
</script>

<template>
  <div class="lb-shell">
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
            <LbLibrary v-else-if="libTab === 'sat'" v-model="selSatId" layout="column" :items="satConfigs" :summary="satLibSummary" name-placeholder="卫星名称"
              auto-tip="所选卫星" @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此配置" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <!-- 方向图匹配（卫星方向图 + EIRP/G·T 天线）是本条目的属性：把卫星树与本条目的 grd 递进去，
                   编辑器就地写 cfg.grd（工作台卫星分区只留只读速览行，见 grdFacts）。 -->
              <template #default="{ cfg }"><SatellitePanel :form="cfg.form" :fields="SAT_FIELDS" :sat-tree="satTree" :sel="cfg.grd"
                :on-import="() => importGrdFor(cfg)" :on-remove-ant="() => removeImportedGrd(cfg)" :importing="importingGrd" /></template>
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

      <!-- ② 主区：链路工作台（常驻） -->
      <section class="lb-col lb-build">
        <!-- 功能区（MATLAB App 式工具条）：文件 · 计算 · 场景 · 视图 · 导出 ‖ 状态位 -->
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" @click="saveCurrent">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
                保存<span v-if="dirtyFlag" class="lbx-dirty" title="有未保存的修改"></span>
              </button>
              <button class="lbr-big" :disabled="!api" title="分享 / 导入：配置（可多选）+ 资源库条目（可多选）——分享码 / 文件 / 发给用户ID" @click="openShareDlg"><Icon name="external-link" :size="15" />分享</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（GRD 卫星树 / 天线设置 / 实时星位 等）" @click="refreshLatest">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :title="sideView === 'configs' ? '隐藏左侧「配置列表」栏（腾出工作区宽度）' : '左侧栏显示「配置列表」（场景文件树；与「资源库」二选一）'" @click="toggleSide('configs')"><Icon name="panel-left" :size="15" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <!-- 计算方式已随载波入资源库（逐行按所选载波取用），此处只留执行 -->
              <button class="lbr-big primary" :disabled="computing" :title="`逐行计算链路表全部 ${linkRows.length} 条链路（Ctrl+Enter）`" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
              <!-- 图标与「计算」同一枚实心三角：同一件事的两档（单条 / 整组），不该长成两个族 -->
              <button class="lbr-big" :disabled="computing || !linkRows.length"
                title="高级计算：多载波组功带平衡（VSAT 组网 / CNC 载波叠加）——勾选多条链路，解出各载波应设的系统余量，使整组 Σ功率带宽 = Σ载波带宽"
                @click="openAdvDlg">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                高级计算
              </button>
            </div>
            <div class="lbr-cap">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ on: sideView === 'library' }" :title="`${sideView === 'library' ? '隐藏' : '左侧栏显示'}「资源库」：地球站 ${esConfigs.length} · 卫星 ${satConfigs.length} · 载波 ${basebandConfigs.length}（全局资产，场景按 id 引用；与「配置列表」二选一）`" @click="toggleSide('library')"><Icon name="folder-open" :size="15" />资源库</button>
              <button class="lbr-big" :class="{ on: showViz }" :title="showViz ? '隐藏详细预算的图表区（地理场图 + 链路视图）' : '显示详细预算的图表区：地理场图（站址经纬度）+ 链路视图（3D 站星几何）'" @click="showViz = !showViz"><Icon name="chart-line" :size="15" />图表</button>
            </div>
            <div class="lbr-cap">视图</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="reportDlg.busy || !links.length" :title="links.length ? '生成交付级报告：Excel（总报告 + 逐链路详情）/ PDF（封面 · 目录 · 总报告 · 逐链路详情，含图）' : '尚无计算结果'" @click="openReportDialog"><Icon name="file-down" :size="15" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
              <button class="lbr-big" :disabled="!segments.length" title="复制当前瀑布表（TSV，可直接粘贴到 Excel / 报告）" @click="copyWaterfallTsv"><Icon name="file-text" :size="15" />TSV</button>
              <div class="lbr-form">
                <label title="报表语言：「详细预算」区与导出内容一起切换 / Report language: detailed budget & exports"><span>语言</span>
                  <select v-model="reportLang" style="width: 64px"><option value="zh">中文</option><option value="en">English</option></select>
                </label>
              </div>
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

        <!-- 链路工作台：全宽横向分区（卫星 → 链路表 → 详细预算），计算栏吸底 -->
        <div ref="flowEl" class="lbx-flow lbx-cards">
          <LbSection id="sat" title="卫星与转发器">
            <template #actions>
              <button class="lb-mini" title="到资源库编辑当前卫星：方向图天线匹配 + 完整空间段参数" @click="editInLibrary('sat')">编辑参数</button>
            </template>
            <!-- 卫星分区＝定义列表式三行横带（左栏名 + 右内容，行间发丝线）：
                 配置（资源库单选 + 星名）/ 转发器（关键参数只读速览）/ 方向图（GRD 天线匹配只读速览）。
                 转发器与方向图都只报当前值，编辑一律走节头「编辑参数」进资源库卫星条目。 -->
            <div class="lbx-satband">
              <div class="lbx-satline">
                <span class="lbx-satgut">配置</span>
                <div class="lbx-satmain">
                  <select class="lbx-satsel" :value="(curSat && curSat.id) || ''"
                    title="从卫星资源库选择本场景使用的卫星（场景级单选，全部链路共用）" @change="satId = $event.target.value">
                    <option v-for="o in satSelectOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <span v-if="curSat" class="lbx-satname" title="卫星名称（随资源库条目；选中 GRD 实时星时以星历为准）">{{ curSat.form.satelliteName || '—' }}</span>
                  <span class="lbx-satnote">场景级 · 全部 {{ linkRows.length }} 条链路共用</span>
                </div>
              </div>
              <div v-if="curSat" class="lbx-satline">
                <span class="lbx-satgut">转发器</span>
                <div class="lbx-satmain lbx-satkv">
                  <span v-for="k in satFacts" :key="k.key" class="lbx-kv" :title="k.tip">
                    <span class="lbx-kv-l">{{ k.label }}</span>
                    <span class="lbx-kv-v">{{ k.value }}<i v-if="k.unit" :class="{ tight: k.tight }">{{ k.unit }}</i></span>
                  </span>
                </div>
              </div>
              <div v-if="curSat" class="lbx-satline">
                <span class="lbx-satgut">方向图</span>
                <div class="lbx-satmain lbx-satkv">
                  <span class="lbx-kv" title="卫星EIRP 天线：按各收信站经纬度取该天线多波束最大 Parameter，自动回填收信站「卫星EIRP」。取星与天线匹配在资源库卫星编辑器里改">
                    <span class="lbx-kv-l">EIRP 天线</span><span class="lbx-kv-v">{{ grdFacts.eirp }}</span>
                  </span>
                  <span class="lbx-kv" title="卫星G/T 天线：按各发信站经纬度取该天线多波束最大 Parameter，自动回填发信站「卫星G/T」">
                    <span class="lbx-kv-l">G/T 天线</span><span class="lbx-kv-v">{{ grdFacts.gt }}</span>
                  </span>
                  <span v-if="grdFacts.stale" class="lbx-satnote bad" title="匹配已保留，但本机卫星树中没有这份 GRD 方向图（更换计算机 / 尚未在「星座3D」页导入）：期间不回填">未导入</span>
                  <span v-else-if="grdFacts.mismatch" class="lbx-satnote bad" title="所匹配的方向图与本配置的星名/轨位不一致，请核对是否为同一颗卫星">{{ grdFacts.mismatch }}</span>
                </div>
              </div>
            </div>
          </LbSection>

          <LbSection id="links" title="链路表" :count="linkRows.length" summary="一行一条链路：发端 + 收端 + 库引用 + 结果">
            <template #actions>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="自定义计算结果列（只读，重算即时回填）" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in RESULT_DEFS" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys.includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                </div>
              </span>
            </template>
            <div class="lbx-grid">
              <StationGrid :stations="linkRows" :fields="gridFields" :groups="GRID_GROUPS" :extra-values="computedVals" :cell-class="cellClassFn"
                :cell-sub="cellSubFn" :cell-tag="cellTagFn" :cell-fill="cellFillFn" :freeze-keys="false"
                :cities="cities" :city-search="citySearch" label="链路" :auto-geo="autoGeoRow"
                :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, rxStationId: esSelectOptions }"
                :lib-fields="{ basebandId: 'carrier', stationId: 'station', rxStationId: 'station' }" @edit-lib="editInLibrary"
                @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :cap="capacitySummary" :cap-main="capMain" :bw-main="bwMain" :pbw-main="pbwMain" :readout="rowReadout" />
          </LbSection>

          <LbSection id="detail" title="详细预算" :summary="sel && links.length ? `${sel.txName} → ${sel.rxName}` : ''">
            <div v-if="error" class="lb-err">{{ error }}</div>
            <div v-else-if="!links.length" class="lb-placeholder">尚无预算结果。</div>
            <div v-else-if="sel && sel.error" class="lb-err">链路 {{ sel.txName }} → {{ sel.rxName }} 计算失败：{{ sel.error }}</div>
            <!-- 文档区（样式见 styles/lbworkbench.css）：上排＝级联主表 ‖ 图表区，下排＝参考段整幅段带 -->
            <div v-else-if="core" class="lbx-doc">
              <div class="lbx-doc-main"><WaterfallTable :segments="segments" pick="cascade" :lang="reportLang" /></div>
              <div v-if="showViz" class="lbx-doc-side"><LbVizPane ref="vizRef" engine="geo" :params="selParams" :sweep2D="api ? api.linkBudget.sweep2D : null"
                :output-defs="api ? api.linkBudget.outputDefs : null" :link-scene="linkScene" :geo-link="geoLink"
                store-key="linkbudget" :lang="reportLang" /></div>
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

    <!-- 高级计算：多载波功带平衡（VSAT 组网 / CNC 载波叠加，GEO/NGSO 共用组件）-->
    <LbAdvBalanceDialog :open="advDlg.open" :rows="advRows" :tp-bw-mhz="advTpBwMHz" :busy="advDlg.busy || computing"
      :stale="resultsStale" :carrier-remap="advRemap" store-key="linkbudget" @close="advDlg.open = false" @apply="applyAdvPlan" />

    <!-- 导出报告：封面元信息 + 输出格式 + 是否含图（三窗共用组件）-->
    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="GEO"
      :sat-name="curSat ? curSat.form.satelliteName : ''" :band="curSat ? curSat.form.frequencyBand : ''" :link-count="links.length"
      :viz-available="showViz" store-key="linkbudget" :busy="reportDlg.busy" :progress="reportDlg.progress"
      @close="reportDlg.open = false" @submit="runReport" />

    <!-- 命名弹窗：保存为新配置（替代 Electron 不支持的 window.prompt）-->
    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <div class="lb-dlg-bd">
          <input v-model="cfgDlg.name" class="lb-input" placeholder="配置名称" @keyup.enter="confirmCfgDlg" />
        </div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini primary" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <!-- 离开已改动配置的提示（保存 / 不保存 / 取消）-->
    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini primary" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <!-- 通用确认弹窗（删除文件夹等）-->
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
/* 浅色精密仪器风：页内统一圆角/字号尺度，并就地覆写语义色（仅本页生效，不影响主窗口/地图）。 */
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--lb-serif);
  /* 报表衬线排版：--lb-serif 别名自 global.css 的 --font-serif（全软件同栈），等宽语义亦同源，
     TNR 数字字面天然等宽，右对齐即成列，此处不再单独覆写 --font-mono */
  /* 降饱和的语义色（更接近灰，避免红绿黄过艳） */
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  /* 统一圆角尺度 */
  --r-ctl: 2px; --r-box: 3px; --r-modal: 4px;
}
html[data-theme='dark'] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; }

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
/* 右缘拖拽手柄：调整配置栏宽度 */
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
/* 配置栏表头更紧凑，给「配置列表」标题留足空间（4 个操作按钮较占位）*/
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
/* 细滚动条：树可横向滚动看全名，且尽量不与右缘拖拽手柄抢占 */
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
.lb-empty, .lb-placeholder { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; }
.lb-cfg-acts { display: flex; gap: 4px; }
.lb-cfg-list { list-style: none; margin: 0; padding: 0; }
.lb-cfg-list li { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 9px; font-size: 12px; cursor: pointer; border-radius: var(--r-ctl); color: var(--text-muted); }
.lb-cfg-list li:hover { background: var(--surface-2); color: var(--text); }
.lb-cfg-list li.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.lb-cfg-nm { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.lb-cfg-ico { flex: none; font: inherit; font-size: 13px; line-height: 1; padding: 0 4px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); opacity: 0; display: inline-flex; align-items: center; }
.lb-cfg-list li:hover .lb-cfg-ico { opacity: 1; }
.lb-cfg-ico:hover { color: var(--text); }
.lb-cfg-ico.del:hover { color: var(--danger); }
.lb-cfg-list { user-select: none; }
.lb-cfg-list li { cursor: pointer; }
.lb-cfg-list li.cut { opacity: .5; }
/* 右键菜单 */
.lb-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.lb-ctx { position: fixed; min-width: 150px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.lb-ctx-i { font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl); white-space: nowrap; }
.lb-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.lb-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.lb-ctx-i.danger:hover { color: var(--danger); }
.lb-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
.lb-cfg-rename { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 2px 5px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-cfg-rename:focus { outline: none; }
.lb-cfg-hint { padding: 2px 6px 8px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.lb-cfg-acts { display: flex; gap: 3px; }
.lb-cfg-acts i { font-style: normal; }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; }
.lb-ico-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; }
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-mono); color: var(--text); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; }

/* 弹窗（命名 / 分享） */
.lb-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
/* 保留的三个小弹窗：保存为新配置 / 配置已修改 / 确认。
   分享弹窗自 v1.4.6 起是独立组件（components/LbShareDialog.vue，自带 lbs- 一套样式），
   原先只服务于它的 lb-tabs / lb-area / lb-inbox 系列 / lb-share-l 等已随之删去。 */
.lb-dlg { width: 380px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.lb-dlg-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lb-dlg-bd { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-dlg-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-input { font: inherit; font-size: 12px; padding: 6px 9px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-input:focus { outline: none; border-color: var(--accent); }
.lb-mini.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.lb-mini.primary:hover:not(:disabled) { opacity: .88; }
.lb-share-row { font-size: 12px; color: var(--text-muted); }

/* 分段选择（链路配对等，计算栏用） */
.seg { display: flex; gap: 2px; }
.seg-i { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.seg-i:hover { color: var(--text); border-color: var(--border-strong); }
.seg-i.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }

/* 结果 */
.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }

/* 核心指标（.core-*）三线式样式统一在 styles/lbworkbench.css（三 App 共用，此处不再重复定义） */

</style>
