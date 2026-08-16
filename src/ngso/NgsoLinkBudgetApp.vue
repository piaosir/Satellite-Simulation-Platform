<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import { FIELD_GROUPS, SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS, defaultsFor, buildParams } from './ngsoParams.js'
import * as NGSO_PARAMS from './ngsoParams.js'   // 整份 schema 传给 lbMiniExport 的 target 分流（同 buildParams 但不折算 sfdRef）
import { buildMiniConfig, miniConfigItem, miniConfigName } from '../shared/lbMiniExport.js'
import { loadSatTree } from './satTree.js'   // 卫星树＝轨道来源（v1.4.5 起不再带方向图，见该文件头注）
import { slantWgs84Max, altFromSlant } from '../shared/slantRange.js'   // 手动几何：斜距换算 / 等效轨道高度
import { resolveRefId } from '../shared/lbShare.js'
import { findPoolByNorad } from './satSearchPool.js'
import { stableStringify } from '../shared/configDirty.js'
import { pf } from '../shared/num.js'   // 全角容错 parseFloat：手填圆轨道高度/倾角（经 sat 面板，不过 StationGrid 归一）也能吃全角数字
import { s8LinkParams } from '../shared/s8Params.js'   // ITU-R P.618-14 §8 统计口径参数组装 + 适用性门控
import { migrateLegacyEs } from '../shared/esMigrate.js'
import { pickColumn, fmtScaled, fmtQty } from '../shared/adaptUnits.js'
import { lbDocT } from '../shared/lbDocI18n.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'   // 报表语言跟随平台语言
import { syncAutoNames, adoptAutoFlag, withAutoFlag, isAutoNamed, newCfgName, newFolderName, copyNameOf } from '../shared/lbAutoName.js'   // 三库条目自动命名（未被用户改名时，名字随关键参数走）
import { byLang } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import StationGrid from './StationGrid.vue'
import BasebandPanel from './BasebandPanel.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import NgsoSatellitePanel from './NgsoSatellitePanel.vue'
import WaterfallTable from './WaterfallTable.vue'
import LbVizPane from '../components/LbVizPane.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import LbAdvBalanceDialog from '../components/LbAdvBalanceDialog.vue'
import { useLbReport } from '../shared/useLbReport.js'
import { planAdvWriteback, advBaseMargin } from '../shared/advBalance.js'   // 高级计算配平结果的写回落点（新建副本 / 就地改）
import LbFontCtl from '../components/LbFontCtl.vue'
import LbCapFoot from '../components/LbCapFoot.vue'
import LbCustomColsDialog from '../components/LbCustomColsDialog.vue'
import LbSlantTool from '../components/LbSlantTool.vue'
import { buildPool, makeResolver, evalRows, customFieldDefs, loadDefs, saveDefs, unitOf, schemaInputPool } from '../shared/lbCustomCols.js'   // 自定义列：公式合成新列
import { labeledResultPool, RESULT_LABELS } from '../shared/lbResultLabels.js'   // 引擎出参中文名与单位（全量词表）
import LbShareDialog from '../components/LbShareDialog.vue'
import { buildNgsoScene } from '../shared/lbLinkScene.js'

const api = typeof window !== 'undefined' ? window.api : null

// 配置列表：命名配置持久化到 userData/configs.ngso.json（store.config.*，各工作台一份互不见面）。
// 「多级文件夹树」：configs 里同时含配置项与文件夹项 { type:'folder',name,parentId }。
// 树的全部行为（增删改移 / 剪贴板 / 右键 / 键盘）在 shared/useConfigTree.js，五个工作台共用一份。
// 注入的都是本窗特有的那几件事；它们都是【函数声明】，提升后才能在这里前向引用。
const cfgTree = useConfigTree({
  ns: 'ngso', orbitType: 'NGSO', api, storageKey: 'ngso/expandedFolders',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, cfgDlg, ctxMenu,
  loadConfigs, uniqueCfgName, activeName, applyConfig, selectConfig,
  openSaveDlg, confirmCfgDlg, updateConfig, saveCurrent,
  toggleFolder, expandFolder, expandAll, collapseAll, persistExpanded,
  addFolder, addBlankConfig, removeConfig, removeFolder, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, ctxDo, onCfgKey
} = cfgTree
// —— 左侧栏（VS Code 活动栏范式：同屏只开一个视图）——
// 'configs' = 配置列表（场景文件树）/ 'library' = 资源库（全局参数库）/ '' = 隐藏，两者二选一。
// 开关：功能区「文件 › 配置列表」与「视图 › 资源库」，点当前视图即收起。
const SIDE_KEY = 'ngso/sideView'
const sideView = ref((() => {
  const v = localStorage.getItem(SIDE_KEY)
  if (v === 'configs' || v === 'library' || v === '') return v
  return localStorage.getItem('ngso/configsCollapsed') === '1' ? '' : 'configs'   // 旧键迁移（v1.4.4 及以前）
})())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
// 两视图各记各的宽度（树窄、资源库宽——后者要放得下两列参数），右缘同一个手柄按当前视图写对应那份
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('ngso/configsWidth')) || 210)))
const LIB_W_MIN = 300, LIB_W_MAX = 760
const libWidth = ref(Math.min(LIB_W_MAX, Math.max(LIB_W_MIN, Number(localStorage.getItem('ngso/libWidth')) || 460)))
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
    try { localStorage.setItem(lib ? 'ngso/libWidth' : 'ngso/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// —— 全局资源库（v1.4.2 模块化重构，对齐 GEO 窗口）——
// 地球站/卫星/载波三库脱离场景配置，全局持久化到 userData/library.json（命名空间 'ngso'，三体制各自独立）。
// 场景（命名配置）只存链路行（站址 + 各列引用的库条目 id）+ 计算策略；改库条目影响所有引用它的场景。
const LIB_NS = 'ngso'
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
  basebandConfigs.push({ id: 'bb' + (_bbSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(basebandConfigs, 'carrier')
}
function removeBasebandConfig(cfg) { removeLibEntry(basebandConfigs, cfg, 'bb') }
// —— 地球站库：每份配置 = 一种站型的收发射频参数（公共天线口径 + 发射链/接收链分列，字段见 ngsoParams.js station 组）。
// 发/收信站表各有「地球站配置」列（stationId）选择套用哪一份：发信站取发射参数、收信站取接收参数，
// 同一份可被多行乃至收发两侧共用；站表本身只留站址（经纬度/最低仰角等）信息。
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
  esConfigs.push({ id: 'es' + (_esSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
  syncAutoNames(esConfigs, 'es')
}
function removeEsConfig(cfg) { removeLibEntry(esConfigs, cfg, 'es') }

// —— 卫星库（对齐 GEO/再生式先例）：每份 = 完整空间段参数 + NGSO 特有轨道来源(ngsoSat)；
// 场景级单选（satId），全场景链路共用。ngsoSat 是「这颗卫星的属性」（选星模式/轨道根数/名称/NORAD/
// 星座3D 树节点 folder），随库条目走：换场景引用同一颗星，其轨道来源一致。
// 编辑在资源库卫星编辑器，工作台只留只读速览行。
// ★ v1.4.5：方向图匹配(grd)整块删除——卫星 EIRP / G·T 改为链路表逐站填写（原因见 ngso/satTree.js 头注）。——
let _satSeq = 1
const blankNgsoSat = () => ({ mode: 'manual', orbit: null, name: '', noradId: null, folder: '' })
// 存量条目归一：早期「星座3D 取星」把树节点 folder 记在 grd.satFolder 里，这里搬进 ngsoSat.folder
// （方向图匹配的其余字段一并丢弃）；再早的条目连 folder 都没有，取星下拉回到未选、轨道根数照旧可用。
function normNgsoSat(ns, legacyGrd) {
  const o = blankNgsoSat()
  if (ns) {
    o.mode = ns.mode || 'manual'
    o.orbit = ns.orbit ? JSON.parse(JSON.stringify(ns.orbit)) : null
    o.name = ns.name || ''
    o.noradId = ns.noradId || null
    o.folder = ns.folder || ''
  }
  if (!o.folder && legacyGrd && legacyGrd.satFolder && !String(legacyGrd.satFolder).startsWith('lb:')) o.folder = legacyGrd.satFolder
  if (o.mode !== 'tree') o.folder = ''
  return o
}
function makeSatConfig(name) { return withAutoFlag({ id: 'sat' + (_satSeq++), name: name || '', form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: blankNgsoSat() }, 'sat') }
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
  satConfigs.push({ id: 'sat' + (_satSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)), ngsoSat: normNgsoSat(cfg.ngsoSat) })
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
    sat: satConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form, ngsoSat: c.ngsoSat || blankNgsoSat() })),   // 轨道来源随条目入库
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
// 频率/极化 + 干扰归属调整（两者均为「地球站 → 卫星」）的一次性迁移：就着旧库 form 里被移走的「孤儿键」搬运，
// 保留用户自定义值（须在按新字段集补默认值之前跑；已迁移过的库因目标键非空而幂等跳过）。
// 取第一份地球站配置作种子；只播种到「自身无该值」的卫星——早于那次改动建的卫星条目仍带着自己的频率，
// 那才是这颗星真正的载频，不能被站型侧的值覆盖（与 GEO 窗口同款口径）。
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
    e.ngsoSat = normNgsoSat(c.ngsoSat, c.grd)   // 旧库无 ngsoSat → 默认手动轨道；旧 grd.satFolder → ngsoSat.folder
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
// extraKeys：参与内容指纹并随条目并入的额外顶层键（卫星库传 ['ngsoSat']——轨道来源是条目内容的一部分，
// 指纹 = stableStringify({ form, ngsoSat })，同内容⇒同 id 的确定性对卫星条目同样成立；GSO 版只比 form）。
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
  { key: 'sat', label: '卫星', tip: '空间段参数库（含轨道来源）：主区「卫星与轨道」分区场景级单选' },
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
// 库列表行摘要：频段 + 上/下行频率 + 轨道来源（选星定轨 / 手动圆轨道高度）。
// NGSO 的自动名只有星名（见 lbAutoName），频段与轨道高度不再进名字 → 一律由这里报，与名字不重影。
const satLibSummary = (c) => {
  const ns = c.ngsoSat || {}
  const picked = ns.mode !== 'manual' && ns.orbit
  return [
    c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : '',
    (c.form.centerFrequency || c.form.rxCenterFrequency) ? `${c.form.centerFrequency || '—'}/${c.form.rxCenterFrequency || '—'} GHz` : '',
    picked ? '选星定轨' : (c.form.orbitAltitude ? 'h=' + c.form.orbitAltitude + ' km' : '')
  ].filter(Boolean).join(' · ')
}
// 取星来源（＝这颗星的轨道与方向图从哪来）。三选一、互斥，界面各处统一用这套措辞。
const SAT_SRC_LABEL = { tree: '卫星/天线树取星', search: '星历搜索定轨', manual: '手动轨道' }
// 星名：全窗口唯一的卫星身份。取星后以所选星为准（ns.name），手动轨道时用表单里的卫星名称。
// 库条目名是「配置」标签（同一颗星可有多份转发器配置），单独显示在下拉里，不与星名混排。
const satNameShown = computed(() => {
  const c = curSat.value; if (!c) return ''
  const ns = c.ngsoSat || {}
  return (((ns.mode !== 'manual' && ns.orbit) ? (ns.name || c.form.satelliteName) : c.form.satelliteName) || '—')
})
// 星名之外的速览：频段 · 频率/极化 · 取星来源与轨道
const satMeta = computed(() => {
  const c = curSat.value; if (!c) return ''
  const ns = c.ngsoSat || {}
  const picked = ns.mode !== 'manual' && !!ns.orbit
  return [
    c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : '',
    (c.form.centerFrequency || c.form.rxCenterFrequency) ? `${c.form.centerFrequency || '—'}/${c.form.rxCenterFrequency || '—'} GHz ${c.form.uplinkPolarization || '—'}/${c.form.downlinkPolarization || '—'}` : '',
    picked
      ? (SAT_SRC_LABEL[ns.mode] || '选星定轨') + (ns.noradId ? `（NORAD ${ns.noradId}）` : '')
      : (c.form.orbitAltitude ? '手动轨道 h=' + c.form.orbitAltitude + ' km' : '手动轨道')
  ].filter(Boolean).join(' · ')
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
// 求解策略随载波入库（资源库「载波」条目的 calcMode / margin / overDb，见 ngsoParams.js CARRIER_FIELDS），
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
// 互视最差几何的搜索时窗（小时）——同属计算策略，输入留在计算栏（选星模式生效）。
// 必须先于下方 resultsStale watcher 声明（const 有 TDZ，watch 数组在 setup 期即求值）。
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 120, l: '5 天' }, { v: 168, l: '7 天' }, { v: 336, l: '14 天' }, { v: 720, l: '30 天' }]
const geoHorizonHours = ref(Number(localStorage.getItem('ngso/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('ngso/horizonHours', String(v)) } catch (e) { /* ignore */ } })

// —— 几何模式（场景级，随场景存档；默认手动）——
//   'manual' 纯手动（默认）：仰角与斜距都由链路表逐行给定，软件不解算任何轨道关系（也就没有 t*、
//            没有互视窗口、没有 §8 仰角分布）。两个数直接送进引擎的 slantRange 模式。
//            斜距不用手敲——换卫星即按新轨道高度算出推荐值填进去（见 refreshSlant），改不改由用户。
//   'auto'   自动最差工况：按卫星轨道解最差几何（选星走平台 SGP4 互视，未选星走圆轨道闭式），
//            仰角字段作【门限】，斜距由求解器给出。
// 存进场景（见 serializeState）；localStorage 那份只作「新场景的默认值」。
// 旧场景（v1.4.4 及以前无此字段）载入时回到 'auto'——它们的结果本就是那样算出来的，不静默改口径。
const GEO_MODES = [{ v: 'manual', l: '手动' }, { v: 'auto', l: '自动最差' }]
const geoMode = ref(localStorage.getItem('ngso/geoMode') === 'auto' ? 'auto' : 'manual')
watch(geoMode, (v) => { try { localStorage.setItem('ngso/geoMode', v) } catch (e) { /* ignore */ } })
const geoManual = computed(() => geoMode.value === 'manual')
// 手动几何的两侧：链路表一行同时是发端与收端，各有自己的站址、仰角与斜距。
// eKey/dKey 既是链路表列名，也正是引擎入参键名（同名，故下面直接写回 lp）；latKey/staAltKey 供斜距换算
// （站表海拔单位是 m，换算函数吃 km）。
const MANUAL_SIDES = [
  { label: '发信站', eKey: 'minElevation', dKey: 'slantRange', latKey: 'latitude', staAltKey: 'altitude', modeKey: 'distanceMode', altKey: 'orbitAltitude' },
  { label: '收信站', eKey: 'rxMinElevation', dKey: 'rxSlantRange', latKey: 'rxLatitude', staAltKey: 'rxAltitude', modeKey: 'rxDistanceMode', altKey: 'rxOrbitAltitude' }
]
// 某行某侧：按 WGS-84 椭球 + 该站纬度/海拔算「绕站一圈最大斜距」（口径见 shared/slantRange.js）
const rowSlant = (row, side, altKm) => slantWgs84Max(pf(row[side.latKey]), (pf(row[side.staAltKey]) || 0) / 1000, pf(row[side.eKey]) || 0, altKm)
// 手动几何 → 送进引擎的那份 linkParams：斜距/仰角照抄单元格。
// 轨道高度顺带按 (斜距, 仰角) 反算成【等效值】覆盖进去：引擎在 slantRange 模式下不用它（斜距有效即直接取用），
// 但链路视图与几何读数会去读 orbitAltitude —— 不覆盖就会拿卫星条目里那个与本行斜距对不上的高度画图。
function manualLp(linkParams, row) {
  const lp = Object.assign({}, linkParams)
  for (const s of MANUAL_SIDES) {
    const d = pf(row[s.dKey]), e = pf(row[s.eKey]) || 0
    lp[s.modeKey] = 'slantRange'; lp[s.dKey] = d; lp[s.eKey] = e
    const h = altFromSlant(d, e); if (h != null) lp[s.altKey] = h
  }
  return lp
}


// —— 计算结果列（只读，表头可自定义勾选）：并入链路表尾部「计算结果」列组 ——
// key 与引擎结果字段同名（容量为派生指标）；以旧矩阵 METRIC_OPTIONS 指标集为基础，补门限C/N/
// 收发仰角/系统可用度（纯数字口径，不设文字判定列）。勾选集按窗口记忆（localStorage），不入场景配置。
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
  { key: 'satellitePSDResult', label: '载波功率谱密度', unit: 'dBW/Hz' },
  { key: 'selectedPowerWResult', label: '功放实际输出', unit: 'W' },
  { key: 'elevationResult', label: '发站仰角', unit: '°', tip: '「链路最差」候选时刻的发信站仰角（平台 SGP4 / 闭式球面）' },
  { key: 'rxElevationResult', label: '收站仰角', unit: '°', tip: '「链路最差」候选时刻的收信站仰角' },
  { key: 'systemAvailabilityResult', label: '系统可用度', unit: '%' }
]
const DEFAULT_RESULT_KEYS = ['paRecommendation', 'linkmargin', 'carrierTotalCN', 'bandwidthUsageRatio', 'powerUsageRatio', 'capacityMbps']
const resultKeys = ref((() => {
  try { const v = JSON.parse(localStorage.getItem('ngso/resultCols') || ''); return Array.isArray(v) && v.length ? v : DEFAULT_RESULT_KEYS.slice() } catch (e) { return DEFAULT_RESULT_KEYS.slice() }
})())
watch(resultKeys, (v) => { try { localStorage.setItem('ngso/resultCols', JSON.stringify(v)) } catch (e) { /* ignore */ } }, { deep: true })
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
// 实时 EIRP/G·T 不再单列，改由「地球站配置」单元格第二行小字承载（cellSubFn），值仍来自 computedVals。
const GRID_GROUPS = [{ key: 'tx', label: '发信站' }, { key: 'rx', label: '收信站' }, { key: 'res', label: '计算结果' }]
// 几何=手动：多出「斜距」列，仰角列改称「仰角」（此时它就是本条链路的仰角，不再是最差工况的门限）；
// 几何=自动最差：斜距由求解器给出，不占列。
function gridSideFields(fields, group) {
  return fields.filter((f) => !f.manualOnly || geoManual.value)
    .map((f) => ({ ...f, group, ...((geoManual.value && f.manualLabel) ? { label: f.manualLabel, tip: f.manualTip || f.tip } : null) }))
}
const gridFields = computed(() => [
  ...gridSideFields(TX_FIELDS, 'tx'),
  ...gridSideFields(RX_FIELDS, 'rx'),
  ...RESULT_DEFS.filter((d) => resultKeys.value.includes(d.key)).map((d) => ({ key: '_' + d.key, label: d.label, unit: resColUnits.value[d.key] || d.unit, type: d.type === 'text' ? 'text' : 'num', ro: true, group: 'res', target: 'meta', tip: d.tip || d.label })),
  ...customFieldDefs(customCols.value, customPool.value)
])
// 计算列取值映射 { 行_id: { _键: 值 } }：结果不写行数据 → 写回不惊动存档/脏检/过期 watcher
const computedVals = ref({})
// 结果列显示单位自适应：每次计算按整列最大|值|共选档位（W→mW、kHz→MHz、全列<0dBW→dBm），
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
// 「地球站配置」单元格第二行小字：发端配置(stationId)下显示实时 EIRP、收端配置(rxStationId)下显示实时 G·T（值取自 computedVals）
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
const links = shallowRef([])  // [{ i, rowId, txName, rxName, data, geom, ok, error }]（瀑布/导出/汇总数据源）
const selected = ref(0)       // 当前查看的链路下标（与链路表聚焦行联动）
const segments = ref([])      // 当前链路瀑布
const computing = ref(false)
const error = ref('')
// —— 结果过期提示：出结果后任何计算输入再变化（含库条目被改）→ 亮「输入已变」小灯，提醒重算 ——
const resultsStale = ref(false)
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId, geoHorizonHours, geoMode],
  () => { if (links.value.length) resultsStale.value = true }, { deep: true })
// —— 自定义列（公式把引擎出参组合成新列，语法与求值见 shared/lbCustomCols.js）——
// 定义按窗口记忆（localStorage），不入场景配置——口径同结果列勾选集；值由 links 里留底的引擎
// 结果即时求出，新建/改公式即刻回填，无需重算。
// 字段池 = 本页【输入参数】+【全部输出参数】：输入取每行真正送进引擎的那份入参（sweepParamsByRow
// 留底，天然分体制），标签复用 ngsoParams 字段表；输出算过之前给结果列+可绘清单（策展），算过之后
// 按本体制实际出参过滤并补齐其余全部数值键（「全部出参」组，label=键名）。capacityMbps 是派生指标，恒剔除。
const customCols = ref(loadDefs('ngso/customCols'))
watch(customCols, (v) => saveDefs('ngso/customCols', v), { deep: true })
const customCurated = ref([])
onMounted(async () => {
  try {
    if (api) {
      const g = await api.linkBudget.outputDefs()
      // 站址地理量组（siteRainRate/siteAltitude）是参数扫描的注入量，引擎结果里不存在，不进池
      customCurated.value = (g || []).flatMap((x) => (x.items || []).map((it) => ({ key: it.key, label: it.label, unit: it.unit, group: x.title })))
        .filter((it) => it.key !== 'siteRainRate' && it.key !== 'siteAltitude')
    }
  } catch (e) { /* 取不到就只用结果列池 */ }
})
// 输入参数池的策展清单（不倒整包入参对象，只收 schema 声明的数值字段）：按面板逻辑分组，
// ES 收发共用字段拆两侧，跨侧同名标签（降雨率/天线口径…）由 schemaInputPool 自动标（发）/（收）
const CC_INPUT_SPECS = [
  { fields: SAT_FIELDS, group: '输入 · 卫星与转发器' },
  { fields: CARRIER_FIELDS, group: '输入 · 载波' },
  { fields: TX_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: ES_TX_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: ES_COMMON_FIELDS, group: '输入 · 发信站', side: 'tx' },
  { fields: RX_FIELDS, group: '输入 · 收信站', side: 'rx' },
  { fields: ES_RX_FIELDS, group: '输入 · 收信站', side: 'rx' },
  { fields: ES_COMMON_FIELDS, group: '输入 · 收信站', side: 'rx', useRxKey: true }
]
const ccSampleRow = computed(() => links.value.find((x) => x.data) || null)
const ccInputsOf = (l) => { const p = l && sweepParamsByRow.value[l.rowId]; return p ? { ...(p.linkParams || null), ...(p.satParams || null) } : null }
// 求值/预览用的行数据：输入参数打底、引擎出参盖上（同名键出参优先）
const ccRowData = (l) => (l && l.data ? { ...(ccInputsOf(l) || null), ...l.data } : null)
const customPool = computed(() => {
  // 结果列组沿用【词表】的名字与单位：同一个量在两个组里叫两个名字（功放建议/功放建议功率）
  // 会让人以为是两个量，且裸标签一歧义就报「未知字段」。词表是命名权威，表头短名只用于链路表列头。
  const base = RESULT_DEFS.filter((d) => d.key !== 'capacityMbps').map((d) => { const t = RESULT_LABELS[d.key]; return { key: d.key, label: t ? t.label : d.label, unit: t ? t.unit : d.unit, group: '结果列' } })
  const rows = links.value.filter((x) => x.data)
  if (!rows.length) return buildPool(base, customCurated.value)
  // 键取全部行的并集：逐行出参可不同（0 雨强行的 XPD 出 '-'），单行样本会误滤别行的合法键。
  // berResult 是 "1×10⁻⁷" 形式，parseFloat 得 1 是错值，恒剔除。
  const keySet = new Set()
  for (const l of rows) {
    const d = l.data
    for (const k of Object.keys(d)) {
      if (k !== 'berResult' && typeof d[k] !== 'object' && Number.isFinite(parseFloat(d[k]))) keySet.add(k)
    }
  }
  return buildPool(
    base.filter((it) => keySet.has(it.key)),
    customCurated.value.filter((it) => keySet.has(it.key)),
    schemaInputPool(CC_INPUT_SPECS, ccInputsOf(rows[0])),
    labeledResultPool(keySet),   // 全量词表：出参一律有中文名与单位（见 shared/lbResultLabels.js）
    // 词表没收录的键才落裸键名——测试钉死三体制 100% 收录，正常情况下这一组是空的
    [...keySet].sort().map((k) => ({ key: k, label: k, unit: '', group: '未命名出参' }))
  )
})
const customResolve = computed(() => makeResolver(customPool.value))
const customOn = computed(() => customCols.value.filter((c) => c.on !== false))
const customVals = computed(() => evalRows(customOn.value, links.value.map((l) => ({ id: l.rowId, data: ccRowData(l) })), customResolve.value, customPool.value))
// 编辑器实时预览：优先当前聚焦行，没有就取第一条有结果的链路
function ccPreview(expr, dp) {
  const l = links.value.find((x) => x.rowId === focusRowId.value && x.data) || ccSampleRow.value
  if (!l) return null
  const v = evalRows([{ id: 'p', expr, dp }], [{ id: 'p', data: ccRowData(l) }], customResolve.value, customPool.value)
  return v.p && v.p._cp !== '—' ? v.p._cp : null
}
// 弹窗开关与下拉里的勾选（下拉只负责选，建在独立弹窗——写公式费时间，不能点外即丢）
const ccDlgOpen = ref(false)
const toggleCustomCol = (id) => { customCols.value = customCols.value.map((c) => (c.id === id ? { ...c, on: c.on === false } : c)) }
const ccUnit = (c) => unitOf(c, customPool.value)
// 表格取值 = 内置结果列(computedVals) + 自定义列(customVals) 合流
const gridVals = computed(() => {
  if (!customOn.value.length) return computedVals.value
  const out = { ...computedVals.value }
  for (const [id, patch] of Object.entries(customVals.value)) out[id] = { ...(out[id] || null), ...patch }
  return out
})
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
// 卫星几何卡折叠（记忆；预算文档以瀑布为主角，几何压成可折叠小节）
const geoFold = ref(localStorage.getItem('ngso/geoFold') === '1')
watch(geoFold, (v) => { try { localStorage.setItem('ngso/geoFold', v ? '1' : '0') } catch (e) { /* ignore */ } })
// Ctrl+Enter 全局快捷计算
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKey); window.removeEventListener('focus', reloadSatTree) })

// 链路表实时列：发端 EIRP / 收端 G/T —— 输入变化即逐行重算（无需点「计算」），写入 computedVals。
// 一行 = 完整链路（同一行当收发两端）→ 一次引擎调用同时取 stationEIRPResult 与 gOverTeResult。
// 几何用 NGSO 引擎球形闭式（轨道高度+最低仰角，快），无需时窗 SGP4——与主计算口径基本一致，
// 仅几何取闭式近似，避免实时列每次都跑双站互视搜索。
// EIRP 用该行载波的计算方式（与主计算一致，否则功带平衡等模式下解出的功率不同 → EIRP 对不上）；
// 「设置功放功率」逐行取发端站型 paPowerW（功放已随站型入地球站库）。
let _roT = null
let _suppressRO = false   // 刷新编排期间静默 watcher，避免表单/站点回填触发的重复扇出
async function refreshReadonly() {
  if (!api || !linkRows.length) return
  const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? v : n.toFixed(2) }
  for (const row of linkRows) {
    try {
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      const { satParams, linkParams } = buildParams(curSat.value.form, bbForm, row, row, txEs, resolveEs(row.rxStationId).form)
      const r = await api.linkBudget.computeModeNGSO(satParams, linkParams, calcOptOf(bbForm, txEs))
      // _paW＝实时功放功率（原值不 toFixed：小功率靠 fmtQty 换 mW 档显示，见 cellTagFn）
      if (r && r.success) setVals(row._id, { _eirp: fix2(r.data.stationEIRPResult), _gt: fix2(r.data.gOverTeResult), _paW: r.data.paRecommendation })
    } catch (e) { /* skip */ }
  }
}
function scheduleReadonly() { if (_suppressRO) return; clearTimeout(_roT); _roT = setTimeout(refreshReadonly, 350) }
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId], scheduleReadonly, { deep: true })

// 注：地球站库编辑器曾在发射/接收标题右端显示实时 EIRP / G·T 预览，已删——频率在卫星侧后，一份站型配置
// 不再自含算这两个量所需的全部输入。链路表「地球站配置」格下的第二行小字仍显示逐行实时 EIRP / G·T（见 cellSubFn）。

// —— 卫星树（轨道来源）——
// 来自「星座3D」页持久化（localStorage globe3d/settings.grd，同源共享）；本窗口只取其轨道根数。
const satTree = ref(loadSatTree().sats)

// —— NGSO 卫星几何来源（卫星库条目属性）——
// mode: 'manual'（手动填轨道高度/倾角）| 'tree'（卫星/天线树选的星）| 'search'（星历搜索到的星）
// orbit: 主进程 buildSatrec 的 spec（tree/search 且带轨道根数时非空）。选星后轨道高度/倾角只读「自动」。
// v1.4：轨道来源是「这颗卫星的属性」，随卫星库条目走（curSat.ngsoSat）——写它即写库（全局资产），
// 换场景引用同一颗星，轨道来源一致。此 computed 恒返回库条目里的响应式对象（makeSatConfig/applyLibrary 保证存在）。
const ngsoSat = computed(() => (curSat.value && curSat.value.ngsoSat) || blankNgsoSat())
const satSelected = computed(() => ngsoSat.value.mode !== 'manual' && !!ngsoSat.value.orbit)

// 天线树节点 → 轨道 spec（异步，可能要联网反解 NORAD）。按 node.kind 分派，**只有真·静止星才走 GEO 静态几何**：
//   ① 节点带 NORAD（kind:'linked'）→ 到「从星历搜索」同一份共享候选池（findPoolByNorad）反解真实轨道根数——
//      树导入与搜索读同一份池，同一颗星两处几何一致。查不到（离线/不在 active 目录）→ 报因，不伪造 GEO。
//   ② 节点自带 OMM / 经典六根数（kind:'orbit'）→ 直接用真实轨道；
//   ③ 仅星下点快照：**只有 GEO 预置星('preset')与用户手放的固定点('custom')**才按真实星下点经纬高做静止几何
//      （这两类本就无轨道运动，静止几何是正确口径）；对「本应在动」的星绝不默认 GEO 静止解。
async function treeNodeOrbit(node) {
  if (!node) return null
  const kind = node.kind || ''
  if (node.noradId != null) {
    const rec = await findPoolByNorad(node.noradId)
    if (rec) {
      if (rec.orbitType === 'elements' && rec.elements) {
        const e = rec.elements
        return { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
      }
      return { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
    }
    // 关联星但星历库暂时查不到——不静默按 GEO 静止星处理，明确报因
    return { type: 'unresolved', noradId: node.noradId, reason: `关联星（NORAD ${node.noradId}）暂未在星历库解析到，无法确定其轨道（可能离线或本地缓存缺失）。请联网后在「从星历搜索」按 NORAD 重选，或改用手动轨道高度+倾角。` }
  }
  if (node.omm && node.omm.meanMotion) return Object.assign({ type: 'omm' }, node.omm)
  const el = node.elements
  if (el && el.altKm != null) {
    return { type: 'elements', altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, epoch: node.epoch || null, noradId: node.noradId }
  }
  // 仅 GEO 预置星 / 用户固定点（无轨道运动）→ 真实星下点静止几何；kind 缺省（旧数据）也归此类兼容。
  if ((kind === 'preset' || kind === 'custom' || !kind) && node.altKm != null) {
    return { type: 'snapshot', lonDeg: Number(node.lon) || 0, latDeg: Number(node.lat) || 0, altKm: Number(node.altKm) || 0, noradId: node.noradId }
  }
  // 「本应在动」的星（linked/orbit）却拿不到轨道根数——报因而非默认 GEO 静止
  return { type: 'unresolved', noradId: node.noradId, reason: `卫星「${node.satName || node.folder}」缺少可用轨道根数，无法确定其轨道。请在「星座3D」页为其补充轨道根数（关联 NORAD 或填经典六根数），或改用手动轨道高度+倾角。` }
}
// 上下行频率（GHz），供几何求解算多普勒：频率在卫星侧（场景级单选的那颗星，全部链路共用）
const _satFreqForm = () => (curSat.value && curSat.value.form) || {}
const upFreqGHz = () => parseFloat(_satFreqForm().centerFrequency) || 14.25
const dnFreqGHz = () => parseFloat(_satFreqForm().rxCenterFrequency) || 12.5

// 平均运动(rev/day) → 平均高度(km)：a=(μ/n²)^(1/3)，h≈a−Re（近圆轨道即圆轨道高度）
const _MU_G = 398600.4418, _RE_G = 6378.137
function altFromMeanMotion(revDay) {
  const n = (Number(revDay) || 0) * 2 * Math.PI / 86400
  if (!(n > 0)) return null
  return Math.cbrt(_MU_G / (n * n)) - _RE_G
}
// 卫星/天线树选星 → 记录轨道来源并回显轨道高度/倾角（只读「自动」）。异步：linked 星要联网按 NORAD 反解真实轨道。
// 写入目标是【指定】卫星库条目（form + ngsoSat）：取星器在资源库卫星编辑器里，逐条目独立选星
// （与「从星历搜索」同款）；库为全局资产，其它引用它的场景同步受益。
async function applyTreeSatOrbitFor(cfg, node) {
  if (!cfg || !cfg.ngsoSat || !node) return
  const ns = cfg.ngsoSat, sf = cfg.form
  ns.mode = 'tree'; ns.orbit = null; ns.name = node.satName; ns.noradId = node.noradId || null; ns.folder = node.folder
  sf.satelliteName = node.satName   // 条目名随之跟到新星（自动命名，见 shared/lbAutoName.js）
  const orbit = await treeNodeOrbit(node)
  ns.orbit = orbit
  if (orbit && orbit.type === 'elements') {
    if (orbit.altKm != null) sf.orbitAltitude = String(Math.round(orbit.altKm))
    if (orbit.incl != null) sf.orbitInclination = String(orbit.incl)
  } else if (orbit && orbit.type === 'omm') {
    const h = altFromMeanMotion(orbit.meanMotion); if (h != null) sf.orbitAltitude = h.toFixed(0)
    if (orbit.incl != null) sf.orbitInclination = String(orbit.incl)
  } else if (orbit && orbit.type === 'snapshot') {
    if (orbit.altKm != null) sf.orbitAltitude = String(Math.round(orbit.altKm))
    sf.orbitInclination = String(Math.abs(Number(orbit.latDeg) || 0).toFixed(2))
  }
}
// 场景选中卫星的树选星（刷新卫星树时同步其轨道用）
const applyTreeSatOrbit = (node) => applyTreeSatOrbitFor(curSat.value, node)
// 搜索选星 → 仅轨道根数，回显轨道高度/倾角。写到指定卫星库条目（cfg）——
// 「从星历搜索」取星器在资源库卫星编辑器里，逐条目独立搜星（不只作用于场景选中的 curSat）。
// 两类记录：真实目录星（orbitType 'omm'，喂原始 OMM 根数走 SGP4）与本地自定义星座
// （orbitType 'elements'，经典六根数含偏心率/近地点幅角走 buildSatrec type:'elements'，
//  与星座3D 页 elementsToSatrec 完全同口径——HEO/椭圆几何因此精确）。
function pickSearchSatFor(cfg, rec) {
  if (!cfg || !cfg.ngsoSat) return
  const ns = cfg.ngsoSat, sf = cfg.form
  // 取星来源互斥（三选一）：改用星历搜索即放开卫星/天线树选的那颗星
  ns.mode = 'search'; ns.name = rec.name; ns.noradId = rec.noradId || null; ns.folder = ''
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    ns.orbit = { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
  } else {
    // 仅取 SGP4 所需 OMM 字段，剥离候选池的显示字段（apogeeKm/groupLabel/altName…）
    ns.orbit = { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
  }
  sf.satelliteName = rec.name   // 条目名随之跟到新星（自动命名，见 shared/lbAutoName.js）
  const h = altFromMeanMotion(rec.meanMotion); if (h != null) sf.orbitAltitude = h.toFixed(0)
  if (rec.incl != null) sf.orbitInclination = String(rec.incl)
}
// 取消选星（恢复手动填轨道）——作用于指定条目
function clearSatSelectionFor(cfg) {
  if (!cfg || !cfg.ngsoSat) return
  const ns = cfg.ngsoSat; ns.mode = 'manual'; ns.orbit = null; ns.name = ''; ns.noradId = null; ns.folder = ''
}

// 用平台 SGP4 精确几何覆盖引擎输出的几何量（斜距/仰角/方位/轨道高度/速度/多普勒/时延/周期），
// 确保结果几何一律取「本软件建模体系」的更精准值（轨道根数/最差时刻/互视窗口另由几何卡展示）。
const _C_KMS = 299792.458
function mergePlatformGeometry(d, geom) {
  const w = geom.worst, el = geom.elements
  d.slantRangeResult = w.up.slantKm.toFixed(2); d.rxSlantRangeResult = w.dn.slantKm.toFixed(2)
  d.elevationResult = w.up.elevDeg.toFixed(2); d.rxElevationResult = w.dn.elevDeg.toFixed(2)
  // 卫星高度：选星取典型时刻 t* 同一瞬间的高度（上下行相同）；手动圆轨道两站也相同
  if (w.up.altKm != null) d.orbitAltitudeUpResult = w.up.altKm.toFixed(1)
  if (w.dn.altKm != null) d.orbitAltitudeResult = w.dn.altKm.toFixed(1)
  if (w.speedInertialKmS != null) { d.orbitVelocityResult = w.speedInertialKmS.toFixed(3); d.orbitVelocityUpResult = d.orbitVelocityResult }
  if (w.speedGroundRelKmS != null) { d.groundRelVelResult = w.speedGroundRelKmS.toFixed(3); d.groundRelVelUpResult = d.groundRelVelResult }
  if (w.maxDopplerUpHz != null) d.maxDopplerUplinkResult = (w.maxDopplerUpHz / 1000).toFixed(3)
  if (w.maxDopplerDnHz != null) d.maxDopplerDownlinkResult = (w.maxDopplerDnHz / 1000).toFixed(3)
  if (w.oneWayDelayMs != null) {
    d.linkDelayResult = w.oneWayDelayMs.toFixed(3)
    d.linkDelayUpResult = (w.up.slantKm / _C_KMS * 1000).toFixed(3)
    d.linkDelayDownResult = (w.dn.slantKm / _C_KMS * 1000).toFixed(3)
  }
  if (el && el.periodMin != null) { d.orbitPeriodUpResult = el.periodMin.toFixed(2); d.orbitPeriodDownResult = d.orbitPeriodUpResult }
  // 覆盖地心半角 / 地面覆盖半径 / 天顶过境最大时长——单一真值源（用卫星真实倾角，替代旧引擎里 50° 默认）
  // 常驻可见（GEO/严格 ω_s≈ω_E）→ ∞（语言中立，专业；与几何卡 gPass、Excel 几何表同口径）
  const fmtPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)
  if (w.up.coverageHalfAngleDeg != null) {
    d.coverageHalfAngleUpResult = w.up.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusUpResult = w.up.coverageRadiusKm.toFixed(1)
    d.maxPassDurationUpResult = fmtPass(w.up.maxPassMin)
  }
  if (w.dn.coverageHalfAngleDeg != null) {
    d.coverageHalfAngleDownResult = w.dn.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusDownResult = w.dn.coverageRadiusKm.toFixed(1)
    d.maxPassDurationDownResult = fmtPass(w.dn.maxPassMin)
  }
}
// 搜索时窗起点 t0：统一锚到「计算此刻」的墙钟绝对时（与再生式模块同口径，不再锚场景/TLE 历元）。
// 卫星仍按 SGP4 从各自设计历元（elements=场景历元 / omm=该星自身历元）正推到此刻，同属墙钟系 → t* 仍是绝对时、
// 可与星座3D 星下点对表（见 geoHasTimes 上方注释）。传入批级 t0ISO 令同批各链路起点一致；未传则各自取此刻。
function searchT0ISO() { return new Date().toISOString() }
// 选星（tree/search，真实轨道根数）→ 平台 SGP4 双站互视最差几何。与主计算 compute() 的「选星分支」
// 同口径（均锚计算此刻墙钟·同时窗长）。手动圆轨道(circular)不走这里（无相位、无单一时刻）；未选星返回 null。
function geomStations(tx, rx) {
  return {
    tx: { lonDeg: parseFloat(tx.longitude), latDeg: parseFloat(tx.latitude), altKm: (parseFloat(tx.altitude) || 0) / 1000, minElevDeg: parseFloat(tx.minElevation) || 0, freqGHz: upFreqGHz() },
    rx: { lonDeg: parseFloat(rx.rxLongitude), latDeg: parseFloat(rx.rxLatitude), altKm: (parseFloat(rx.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(rx.rxMinElevation) || 0, freqGHz: dnFreqGHz() }
  }
}
async function solveSelectedGeom(tx, rx, t0ISO) {
  if (!api || !satSelected.value || !ngsoSat.value.orbit) return null
  const orbitSpec = JSON.parse(JSON.stringify(ngsoSat.value.orbit))
  return await api.linkBudget.ngsoGeometry(Object.assign({ orbit: orbitSpec }, geomStations(tx, rx), {
    t0ISO: t0ISO || searchT0ISO(), horizonHours: geoHorizonHours.value
  }))
}
// 整表几何的批量请求（口径与 solveSelectedGeom 逐字一致，只是把各行的站对并成一份 pairs）。
// 每行既当发端又当收端（单一链路表），故 pairs[i] 直接由第 i 行两侧字段组出。
function geomBatchSpec(rows, t0ISO) {
  if (!api || !satSelected.value || !ngsoSat.value.orbit || !rows.length) return null
  return {
    orbit: JSON.parse(JSON.stringify(ngsoSat.value.orbit)),
    pairs: rows.map((r) => geomStations(r, r)),
    t0ISO: t0ISO || searchT0ISO(), horizonHours: geoHorizonHours.value
  }
}
// 链路窗口为单例复用：窗口重新获得焦点时刷新卫星树（见 onMounted 的 focus 监听），纳入此后在「星座3D」新加的星。
// 树里暂时没有的节点不清空所选（换机器 ≠ 用户想换星；ngsoSat 里已存的轨道根数照常参与计算）。
async function reloadSatTree() {
  const wasClean = !isDirty()
  satTree.value = loadSatTree().sats
  // 场景选中的这颗星若来自卫星树：刷新时同步其名称/轨道（取实时新位置，写入所引卫星库条目）。
  // 只同步当前这一条：treeNodeOrbit 对 linked 星要联网按 NORAD 反解，遍历全库会扇出一堆网络请求。
  const ns = ngsoSat.value
  const cur = (ns && ns.mode === 'tree' && ns.folder) ? satTree.value.find((s) => s.folder === ns.folder) : null
  if (cur) await applyTreeSatOrbit(cur)
  // 实时星取新位置是系统自动同步，不算用户改动；若之前本就无未保存改动，基线随之推进，
  // 避免仅仅切回本窗口或点「刷新」就被指纹判定为「未保存」。
  if (wasClean) setBaseline()
}

// 顶栏「刷新」：重新拉取主窗口的最新设置（卫星树/实时星位 + 城市库/载波信号选项），并按最新数据重算
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  _suppressRO = true        // 抑制下方表单/站点回填触发的 watcher，整套扇出最后只跑一次
  clearTimeout(_roT)
  try {
    reloadSatTree()   // 重读 globe3d/settings.grd（卫星树）+ grdLive 实时位置
    try { const c = api && await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    _suppressRO = false
    clearTimeout(_roT)        // 丢弃抑制期间可能挂起的计时器
    await refreshReadonly()   // 守卫解除后只跑一遍扇出
    toast('已刷新最新设置')
  } finally { _suppressRO = false; refreshing.value = false }
}
const sel = computed(() => links.value[selected.value] || null)
// 核心结果卡片（照搬小程序）：取当前选中链路的完整结果
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))
// 图表区「参数扫描」的引擎入参：计算时按行原样留底（含解算后注入的最差几何），不重新组装
const sweepParamsByRow = ref({})
const selParams = computed(() => (sel.value ? (sweepParamsByRow.value[sel.value.rowId] || null) : null))
// 地理图的「卫星关联」（见 LbSpacePane / core 的 spec.geo）：覆盖门的仰角门限取站点自己的
// 【最低工作仰角】门限字段，不取 linkParams 里那个——后者已被最差候选的瞬时几何仰角覆盖，
// 拿它当门限会把覆盖圈按一个偶然值收紧。
// pattern 恒空：NGSO 不再挂 GRD 方向图（见 ngso/satTree.js 头注），地理图只画站址与覆盖门。
const geoLink = computed(() => {
  const row = sel.value ? linkRows.find((r) => r._id === sel.value.rowId) : null
  return {
    minElev: { tx: parseFloat(row && row.minElevation) || 0, rx: parseFloat(row && row.rxMinElevation) || 0 },
    pattern: {}
  }
})
// 图表区显示开关（功能区「视图 → 图表」）。关掉时详细预算只剩表：图表整块不渲染，
// 里头的扫描自然也不会跑——不出图还占着 CPU 逐格重算引擎是说不过去的。
const showViz = ref((() => { try { return localStorage.getItem('ngso/viz/show') !== '0' } catch (e) { return true } })())
watch(showViz, (v) => { try { localStorage.setItem('ngso/viz/show', v ? '1' : '0') } catch (e) { /* ignore */ } })
// 链路视图的场景：卫星摆在本行「余量最差」那一候选几何的星下点上——与详细预算、与上面
// 那张几何卡取的是同一个瞬间 t*（见 shared/lbLinkScene.js）
const linkScene = computed(() => buildNgsoScene(sel.value, selParams.value))
// 平台精确几何（选星时由 SGP4 双站互视最差几何求得；含轨道根数 / 最差互视时刻 / 互视窗口）
const geom = computed(() => (sel.value ? sel.value.geom : null))
// 站星几何时标：UTC / 本地 / 北京 可切换（默认 UTC 对标 STK；本地取运行机时区；北京=UTC+8 便于国内核对）
const tzMode = ref('utc')   // 'utc' | 'local' | 'beijing'
// 几何卡片是否含时刻字段（仅选星耦合模式给出典型时刻/互视窗口），无则不显示时区切换
const geoHasTimes = computed(() => {
  const g = geom.value
  return !!(g && g.coupled && g.search && (g.search.typicalISO || g.search.mutualWindow))
})
// 典型时刻 t* 一律是墙钟绝对时，可直接对表：自定义星座（elements）几何锚在场景历元，得到 t*=场景历元+Δ 的绝对时刻，
// 而星座3D 已让合成星按墙钟从场景历元正向传播（此刻=真实当前时刻、非场景历元），二者同属墙钟系 → 把时间轴设到 t*
// 即与地图星下点吻合，和真实目录星完全一致，无需再做「自场景历元偏移」的换算（旧时间模型下才需要）。
// 本地时区标签：按运行机偏移给出 UTC±H(:MM)，随时刻旁的时区角标显示
function localOffsetLabel() {
  const off = -new Date().getTimezoneOffset()
  const sign = off >= 0 ? '+' : '−'
  const h = Math.floor(Math.abs(off) / 60)
  const m = Math.abs(off) % 60
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '')
}
// 时标角标：UTC→'UTCG'（对标 STK）、北京→'UTC+8'、本地→运行机偏移
const tzSuffix = computed(() => (tzMode.value === 'utc' ? 'UTCG' : tzMode.value === 'beijing' ? 'UTC+8' : localOffsetLabel()))
// 时刻格式化（STK UTCG 版式）：D Mon YYYY HH:MM:SS.mmm，按 mode 取 UTC / 本地 / 北京(UTC+8) 字段（时区由区头角标标注）
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtInstant(iso, mode) {
  if (!iso) return '—'
  const d0 = new Date(iso)
  if (isNaN(d0.getTime())) return String(iso)
  const loc = mode === 'local'
  // 北京=UTC+8（无夏令时）：整体 +8h 后读 UTC 字段即得北京本地表示；UTC/本地不偏移
  const d = mode === 'beijing' ? new Date(d0.getTime() + 8 * 3600000) : d0
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const D = loc ? d.getDate() : d.getUTCDate()
  const MO = loc ? d.getMonth() : d.getUTCMonth()
  const Y = loc ? d.getFullYear() : d.getUTCFullYear()
  const H = loc ? d.getHours() : d.getUTCHours()
  const MI = loc ? d.getMinutes() : d.getUTCMinutes()
  const S = loc ? d.getSeconds() : d.getUTCSeconds()
  const MS = loc ? d.getMilliseconds() : d.getUTCMilliseconds()
  return `${D} ${UTCG_MON[MO]} ${Y} ${p(H)}:${p(MI)}:${p(S)}.${p(MS, 3)}`
}
// 互视窗口持续时长：min，≥60 折算 h
function fmtDur(min) {
  if (min == null || !isFinite(min)) return '—'
  return min >= 60 ? (min / 60).toFixed(2) + ' h' : min.toFixed(1) + ' min'
}
const g2 = (n, p = 2) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(p)
// 过境时长（几何卡）：GEO/常驻可见 → ∞（与瀑布 fmtPass、Excel 几何表同口径）
const gPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)

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

// —— 斜距工具（几何=手动）——
// 只做换算与填入；填多少、填哪几行由用户点。填入按【各行自己的仰角】算，不是把同一个数刷满全表。
const slantToolOpen = ref(false)
const slantToolRow = computed(() => linkRows.find((r) => r._id === focusRowId.value) || null)
const slantToolAlt = computed(() => (curSat.value && curSat.value.form.orbitAltitude) || '')
const _slantSeedRow = computed(() => slantToolRow.value || linkRows[0] || null)
const slantToolElev = computed(() => (_slantSeedRow.value && _slantSeedRow.value.minElevation) || 10)
const slantToolLat = computed(() => (_slantSeedRow.value && _slantSeedRow.value.latitude) || '')
const slantToolStaAlt = computed(() => (_slantSeedRow.value && _slantSeedRow.value.altitude) || 0)
function applySlantFill({ altKm, scope }) {
  const rows = scope === 'row' ? [slantToolRow.value].filter(Boolean) : linkRows
  let n = 0
  for (const r of rows) {
    for (const s of MANUAL_SIDES) {
      const d = rowSlant(r, s, altKm)
      if (d != null) { r[s.dKey] = d.toFixed(2); n++ }
    }
  }
  slantToolOpen.value = false
  toast(`已按各行站址与仰角填入 ${n} 处斜距（轨道高度 ${Number(altKm).toFixed(0)} km）`)
}

// —— 斜距＝派生量：手动几何下由【仰角 / 站点纬度 / 站点海拔 / 轨道高度】四项按 WGS-84 算出 ——
// 这四项只要有一项变，本行该侧的斜距立刻重算写回——不问那格是不是用户改过的：输入都变了，旧值必然对不上。
// 用户仍可就地改斜距，改完一直用它，直到上述四项再次变动。斜距格空着也直接补上（切到手动 / 新增行）。
// slantSig 记每行每侧上次算过的那组输入，只活在本次会话（不入场景）：载入场景时各行是新 _id、
// 签名尚未记过 ⇒ 只登记不改写，绝不覆盖存档里的值。
const slantSig = {}   // { 行_id: { 斜距列名: '纬度|海拔|仰角|轨道高度' } }
function refreshSlant() {
  if (!geoManual.value) return
  const wasClean = !isDirty()
  const h = pf(curSat.value && curSat.value.form.orbitAltitude)
  for (const r of linkRows) {
    const rec = slantSig[r._id] || (slantSig[r._id] = {})
    for (const s of MANUAL_SIDES) {
      const sig = `${r[s.latKey]}|${r[s.staAltKey]}|${r[s.eKey]}|${h || ''}`
      const changed = rec[s.dKey] !== undefined && rec[s.dKey] !== sig
      rec[s.dKey] = sig
      const empty = String(r[s.dKey] == null ? '' : r[s.dKey]).trim() === ''
      if (!(changed || empty) || !(h > 0)) continue
      const d = rowSlant(r, s, h)
      if (d != null) r[s.dKey] = d.toFixed(2)
    }
  }
  // 派生值是系统自动填的、不是用户改的：本就无未保存改动时把基线推进，免得误报「未保存」
  if (wasClean) setBaseline()
}
let _slantT = null
function scheduleSlant() { clearTimeout(_slantT); _slantT = setTimeout(refreshSlant, 300) }
// 只盯推荐值的【输入】（几何模式 / 所选卫星与其轨道高度 / 各行站址与仰角）——
// 盯回填值本身会自激。immediate：切窗口/载入场景后也补一次。
watch(() => [geoMode.value, satId.value, (curSat.value && curSat.value.form.orbitAltitude) || '',
  linkRows.map((r) => MANUAL_SIDES.map((s) => `${r[s.latKey]},${r[s.staAltKey]},${r[s.eKey]}`).join('|')).join(';')].join('#'),
scheduleSlant, { immediate: true })

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
  const cv = customVals.value[row._id] || null
  for (const c of (cv ? customOn.value : [])) {
    const v = cv['_c' + c.id]
    if (v === undefined || v === null || v === '' || v === '—') continue
    items.push({ key: '_c' + c.id, label: c.label, value: v, unit: unitOf(c, customPool.value), tip: c.expr, bad: false })
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
    const geomT0ISO = searchT0ISO()   // 本批统一搜索时窗起点：计算此刻墙钟（同批各链路 t0 一致）
    // —— 几何预解（选星分支）：整表一次 IPC 求完 ——
    // 同批各链路的星、t0、时窗长完全一样，只有站对不同；而 SGP4 粗扫里最贵的传播部分与站址无关，
    // 主进程内各站对共享同一份采样 → 逐行各扫一遍变成整批扫一遍（12 行实测 2.4×，且逐位不变）。
    // 结果按行下标取用；批量入口不可用（老版本 preload）时留 null，下面自动回退逐行求解。
    let geomBatch = null
    if (!geoManual.value && satSelected.value && api.linkBudget.ngsoGeometryBatch) {
      const spec = geomBatchSpec(linkRows, geomT0ISO)
      if (spec) { try { geomBatch = await api.linkBudget.ngsoGeometryBatch(spec) } catch (e) { geomBatch = null } }
    }
    // 单一链路表：逐行一条链路，同一行同时当发端(tx)与收端(rx)传引擎（收端键全 rx 前缀，不冲突）
    for (let i = 0; i < linkRows.length; i++) {
      const row = linkRows[i]
      const tx = row, rx = row
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      const { satParams, linkParams } = buildParams(curSat.value.form, bbForm, tx, rx, txEs, resolveEs(row.rxStationId).form)
      // 计算方式与系统余量/超发量随该行所选载波；「设置功放功率」另取发端站型的功放功率（站的硬件属性）
      const opt = calcOptOf(bbForm, txEs)
      const mode = opt.mode
      const txName = row.earthStationLocation || ('发' + (i + 1))
      const rxName = row.rxEarthStationLocation || ('收' + (i + 1))
      const base = { i, rowId: row._id, txName, rxName }

      // —— 几何：三条路 ——
      //  ① 几何=手动：不解算任何轨道关系，仰角与斜距就是链路表两侧的两个数（见下方 manualLp）；
      //  ② 几何=自动最差 且已选星：平台 SGP4 互视窗内【多候选几何】(两端+内部+几何t*)，逐候选跑真实
      //     链路预算取“余量最差”者。要点：几何最差(仰角)≠链路最差——弯管总 C/N=1/(1/CNup+1/CNdn)
      //     被【弱侧】主导，t* 仅按“仰角和最小”选一个窗口边缘，会漏掉“瓶颈站压最低仰角”的另一边缘工况；
      //     故遍历候选、按当前计算方式取最差（见 ngsoGeometry.coupledTypicalMoment 返回的 candidates）；
      //  ③ 几何=自动最差 未选星：引擎球形闭式（单候选，虚拟圆轨道）。
      let geom = null, candList = null
      if (geoManual.value) {
        // 手动几何：两侧各要一个正斜距。缺了就明确报错——绝不悄悄按轨道高度换算回去（那就又变成
        // 「有真实几何关系」了，与本模式的口径相反）。斜距可用工具栏「斜距工具」按仰角批量填。
        const bad = MANUAL_SIDES.find((s) => !(pf(row[s.dKey]) > 0))
        if (bad) { out.push({ ...base, data: null, error: `手动几何：${bad.label}斜距未填或非正数`, geom: null }); continue }
      } else if (satSelected.value) {
        // 选星→平台 SGP4 双站互视（t0/时窗口径见 solveSelectedGeom：统一锚计算此刻墙钟、与再生式同口径）。
        // 优先取本批预解结果（与逐行求解逐位一致），没有则逐行求。
        geom = (geomBatch && geomBatch[i]) || await solveSelectedGeom(tx, rx, geomT0ISO)
        if (!(geom && geom.feasible)) {
          // 时窗内两站不同时可见：本条链路单星无法建链
          out.push({ ...base, data: null, error: (geom && geom.reason) || '两站不互视', geom })
          continue
        }
        candList = (geom.candidates && geom.candidates.length) ? geom.candidates : [geom]
      } else {
        // 手动模式：虚拟圆轨道（轨道高度+倾角）→ 球形闭式最差几何（单候选，每站各自最低仰角，无 subSat）。
        // 每站按自身最低仰角取最差斜距；带上站址纬度 → 闭式判「纬度 vs 倾角」可见性（如赤道轨道看不到高纬站）。
        geom = await api.linkBudget.ngsoGeometry({
          orbit: { type: 'circular', altKm: pf(curSat.value.form.orbitAltitude) || 0, inclDeg: pf(curSat.value.form.orbitInclination) || 0 },
          tx: { latDeg: parseFloat(tx.latitude), minElevDeg: parseFloat(tx.minElevation) || 0, freqGHz: upFreqGHz() },
          rx: { latDeg: parseFloat(rx.rxLatitude), minElevDeg: parseFloat(rx.rxMinElevation) || 0, freqGHz: dnFreqGHz() }
        })
        if (!(geom && geom.feasible)) {
          // 手动几何不可行（轨道高度≤0 / 站址纬度超出轨道覆盖带）→ 明确报错，不再用兜底假高度静默算出误导结果
          out.push({ ...base, data: null, error: (geom && geom.reason) || '手动轨道几何不可行', geom })
          continue
        }
        candList = [geom]
      }

      // 逐候选选“链路最差”几何。要点：本 NGSO 引擎是“给定余量→反解功放”的模型，达成余量被钉在目标值、
      //   对几何不敏感；几何只体现为【所需资源】，且上下行是两套口径——上行受限=所需功放(paDb)随上行 FSL 增，
      //   下行受限=转发器功率占用(pUse)随下行 FSL 增，二者在互视窗两端各自达峰。故：
      //   ① 排序统一用 margin 口径（最差几何=需资源最多者，与显示口径无关）跑各候选，顺带取达成上/下行 C/N；
      //   ② 瓶颈侧 = 全窗口【平均达成 C/N 更低】的一侧（弱侧主导总 C/N；取均值稳，不受 t* 落哪端影响）；
      //   ③ 越大越差：下行瓶颈看 pUse、上行瓶颈看 paDb（各自单调于该侧 FSL＋星下点增益，已 Node 双向验证）；
      //   ④ 最差候选再按用户当前计算方式出最终结果。单候选（手动圆轨道/快照星）直接算，跳过排序。
      // §8 统计口径参数（ITU-R P.618-14 §8，适用性门控见 s8Params.js：快照星/偏心轨道/同步周期
      // 自动回退单仰角口径）。最低仰角取【站点门限字段】原始值——候选回喂给引擎的 minElevation
      // 是瞬时几何仰角，不能作 §8 仰角分布的下界。候选间轨道相同 → s8 片段整批复用（引擎侧带缓存，
      // 逐候选重复注入近零成本）；雨衰等统计量因此不随候选变，候选排序退化为纯几何/增益比较（更稳）。
      // 手动几何没有轨道分布可言（斜距/仰角是给定的两个数），§8 自然不适用 → 空片段。
      const s8Frag = geom ? s8LinkParams(geom, { minElevUp: tx.minElevation, minElevDn: rx.rxMinElevation }) : {}
      // resolvedMargin＝求解器最终喂给引擎的余量（功带平衡等方式下由它解出）。留全精度原值：
      // 高级计算的组配平要拿它做归一化基准，data.marginResult 已按显示精度截成 2 位小数。
      let worstCand = null, worstLp = null, worstData = null, resolvedMargin = null
      if (!candList) {
        worstLp = manualLp(linkParams, row)   // 手动几何：仰角/斜距直接注入，无候选可比
      } else if (candList.length === 1) {
        worstCand = candList[0]
        worstLp = Object.assign({}, linkParams, s8Frag)
        worstLp.distanceMode = 'slantRange'; worstLp.slantRange = worstCand.worst.up.slantKm; worstLp.minElevation = worstCand.worst.up.elevDeg
        worstLp.rxDistanceMode = 'slantRange'; worstLp.rxSlantRange = worstCand.worst.dn.slantKm; worstLp.rxMinElevation = worstCand.worst.dn.elevDeg
      } else {
        const rankOpt = { mode: 'margin' }
        const rows = []
        // 先把各候选的入参组齐（含按各自星下点重采天线），再一次 IPC 连算完：
        // 逐条口径与单条调用完全一致，只是把「候选数」次往返压成一次。
        const lps = []
        for (const cand of candList) {
          const lp = Object.assign({}, linkParams, s8Frag)
          lp.distanceMode = 'slantRange'; lp.slantRange = cand.worst.up.slantKm; lp.minElevation = cand.worst.up.elevDeg
          lp.rxDistanceMode = 'slantRange'; lp.rxSlantRange = cand.worst.dn.slantKm; lp.rxMinElevation = cand.worst.dn.elevDeg
          lps.push(lp)
        }
        const rrList = api.linkBudget.computeModeNGSOBatch
          ? await api.linkBudget.computeModeNGSOBatch(satParams, lps, rankOpt)
          : await Promise.all(lps.map((lp) => api.linkBudget.computeModeNGSO(satParams, lp, rankOpt)))
        for (let ci = 0; ci < candList.length; ci++) {
          const rr = rrList && rrList[ci]
          if (!(rr && rr.success)) continue
          const dd = rr.data
          rows.push({ cand: candList[ci], lp: lps[ci], data: dd, paDb: parseFloat(dd.paRecommendationdBResult), pUse: parseFloat(dd.powerUsageRatio), upCN: parseFloat(dd.uplinkCN), dnCN: parseFloat(dd.downlinkCN) })
        }
        if (!rows.length) { out.push({ ...base, data: null, error: '链路预算计算失败', geom }); continue }
        const meanOf = (f) => rows.reduce((s, x) => s + (isFinite(f(x)) ? f(x) : 0), 0) / rows.length
        const bottleneck = meanOf((x) => x.dnCN) < meanOf((x) => x.upCN) ? 'down' : 'up'
        const badnessOf = (x) => bottleneck === 'down' ? (isFinite(x.pUse) ? x.pUse : Infinity) : (isFinite(x.paDb) ? x.paDb : Infinity)
        let wr = rows[0]
        for (const x of rows) if (badnessOf(x) > badnessOf(wr)) wr = x
        worstCand = wr.cand; worstLp = wr.lp
        if (mode === 'margin') { worstData = wr.data; resolvedMargin = parseFloat(worstLp.margin) }   // 用户口径即 margin → 直接复用排序结果，省一次计算
      }
      if (!worstData) {
        const r = await api.linkBudget.computeModeNGSO(satParams, worstLp, opt)
        if (!(r && r.success)) { out.push({ ...base, data: null, error: (r && r.message) || '失败', geom }); continue }
        worstData = r.data
        resolvedMargin = r.resolvedMargin
      }

      const d = worstData
      const worstGeom = worstCand
      // 留底本行真正送进引擎的那份入参，供图表区参数扫描原地重跑（见 selParams）。
      // 必须留 worstLp 而非重新 buildParams：最差几何（斜距/最低仰角/重采样后的天线量）
      // 是解算后注入进去的，重组一份就丢了几何，扫出来的曲线不再经过详细预算这一点。
      sweepStore[row._id] = { satParams, linkParams: worstLp, opt }
      if (worstGeom) mergePlatformGeometry(d, worstGeom)   // 报告“链路最差”候选的几何（斜距/星下点/时刻/时窗）
      // 手动几何不覆盖：引擎回填的斜距/仰角就是用户给的那两个数，几何卡与链路视图照它走
      const m = parseFloat(d.linkmargin)
      const pUse = parseFloat(d.powerUsageRatio); const bUse = parseFloat(d.bandwidthUsageRatio)
      // 合格判定按本行自己的方式：设置余量看资源是否够（功率/带宽占用 ≤100%），其它方式看余量 ≥0
      const ok = mode === 'margin' ? (!(pUse > 100) && !(bUse > 100)) : (!isNaN(m) && m >= 0)
      out.push({ ...base, data: d, geom: worstGeom, ok, resolvedMargin })
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
    results: JSON.parse(JSON.stringify(l.data)), lang: reportLang.value, orbitType: 'NGSO',
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

// —— 高级计算：多载波功带平衡（VSAT 组网 / CNC 载波叠加，与 GEO 窗同一套求解与对话框）——
// 单链路的功带平衡只看自己，而转发器上跑的是一组载波：前向 TDM 超发、返向 TDMA 欠发，各自都不平衡，
// 合起来 Σ功率带宽 = Σ载波带宽 才是要的结果（CNC 则是两条链路占同一段频谱、功率叠加）。求解在核心
// 算法外层（shared/advBalance.js，闭式解），结果落成各载波的「设置余量」，再照常走一次正常计算——
// 本窗的参考态即上一次计算，那已经是各链路「最坏几何」下的结果，配平也就配在最坏工况上。
const advDlg = reactive({ open: false, busy: false })
const advRemap = ref(null)   // 上一次应用时的「原载波id → 派生副本id」映射，回传给对话框
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
const advTpBwMHz = computed(() => {
  const d = (links.value.find((l) => l.data) || {}).data
  const v = parseFloat(d ? d.transponderBandwidthResult : (curSat.value && curSat.value.form.transponderBandwidth))
  return isFinite(v) ? v : 0
})
async function openAdvDlg() {
  if (!links.value.length || resultsStale.value) await compute()
  advDlg.open = true
}
// 落地：解出的余量写进载波配置的「设置余量」，随后重算全表。写进哪一份由 planAdvWriteback 定
// （纯函数，与 GEO 窗共用）：VSAT 一律派生专用副本、用户原来的载波配置一字不动，反复配平复用同一份副本；
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

// —— Phase 4：配置持久化 ——
// ① 场景状态序列化（链路行 + 库引用 + 几何模式 + 互视时窗）。
// ② 自动保存「上次会话」到 localStorage：关掉再开窗口即原样恢复（卫星/天线选择不丢）。
// ③ 命名配置（配置列表）走 store.config.* 持久化到 userData/configs.json，可多套切换。
const STATE_KEY = 'ngso/last'
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

function serializeState() {
  // v3 场景 = 关联关系：链路行（站址 + 库条目 id 引用）+ 卫星选择 + 几何模式 + 搜索时窗。
  // 三库是全局资产（userData/library.json），不再随场景存副本；卫星轨道来源(ngsoSat)随卫星库条目走；
  // _ 前缀键（行内部 id / 计算列）一律剥离。orbitType 标记轨道体制：NGSO 窗口配置列表按此过滤。
  // 计算方式/系统余量/超发量自 v3 起随载波入库（求解策略是载波的属性），故不再是场景字段。
  return {
    v: 3, orbitType: 'NGSO',
    rows: linkRows.map((r) => { const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; return o }),
    satId: satId.value,
    geoMode: geoMode.value,
    geoHorizonHours: geoHorizonHours.value
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
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // —— v2 场景（本版结构）：行 + 库引用直读；库是全局资产不随场景载入（卫星轨道来源在卫星库条目里）——
  if (Array.isArray(st.rows)) {
    linkRows.splice(0, linkRows.length, ...st.rows.map((r) => ({ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) })))
    satId.value = st.satId || ''
    adoptSceneCalc(st)                        // v2 场景的计算策略 → 下沉到所引载波库条目
    geoMode.value = st.geoMode === 'manual' ? 'manual' : 'auto'   // 旧场景无此字段 → 自动最差（不改它原来的口径）
    if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
    return
  }
  // —— 旧结构迁移（v1.x：内嵌库 + 发/收两张站表 + 全局 satForm/ngsoSat）——
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
  // ③ 卫星：旧单一 satForm + 全局 ngsoSat（轨道来源）→ 并成一个卫星库条目
  // （内容指纹含 ngsoSat，见 adoptEntries extraKeys——同 form 不同轨道来源是两颗星，不可去重成一条）
  if (st.satForm) {
    const form = { ...defaultsFor(SAT_FIELDS) }
    for (const f of SAT_FIELDS) if (st.satForm[f.key] !== undefined) form[f.key] = st.satForm[f.key]
    // 旧场景的树选星记在场景级 grdSel.satFolder 里 → 归一进 ngsoSat.folder（方向图匹配部分丢弃）
    const ns = normNgsoSat(st.ngsoSat, st.grdSel)
    const satMap = adoptEntries(satConfigs, [{ id: '__sat0', name: form.satelliteName || '卫星', nameAuto: true, form, ngsoSat: ns }], () => makeSatConfig(), ['ngsoSat'])
    satId.value = satMap.__sat0 || ''
  } else { satId.value = '' }
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
  geoMode.value = st.geoMode === 'manual' ? 'manual' : 'auto'
  if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
}
let _stateT = null
// 「上次会话」存盘要带上 activeId：否则重开窗口时配置列表没有任何一项被聚焦，
// 但工作区却显示着上次的内容，看起来像是内容跟列表对不上号（用户反馈的困惑点）。
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* 配额满等忽略 */ } dirtyFlag.value = isDirty() }, 600) }
watch([linkRows, satId, geoMode, geoHorizonHours, activeId], scheduleSaveState, { deep: true })

// —— 命名配置 CRUD ——
// 树本身的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js（见文件上方 useConfigTree(...) 注入点）。
// 这里只留本窗特有的三件：保存为新配置的预填名、空白配置的内容、删除文件夹用的确认框。
// 注意：Electron 渲染进程没有 window.prompt / confirm（静默返回 null → 早先「保存不了」的根因），一律用应用内弹窗。
function defaultCfgName() { const nm = curSat.value && curSat.value.form.satelliteName; return (nm ? nm + ' ' : '') + byLang(`链路 ${linkRows.length} 条`, `${linkRows.length} Links`) }

// 通用确认弹窗（Electron 渲染进程无原生 confirm）
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }

// 默认（空白）配置内容：一条默认链路行（收端引用库中第二份站型，经典 6.2m 发 / 3.7m 收基线）。
// state.orbitType 照写：瀑布表/报表按它分体制（配置库的归属已改由文件分家决定，是另一件事）。
function blankState() {
  return {
    v: 3, orbitType: 'NGSO',
    rows: [{ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), rxStationId: (esConfigs[1] && esConfigs[1].id) || '' }],
    satId: '', geoMode: 'manual', geoHorizonHours: 24
  }
}

// —— 改动检测 + 离开提示 + 恢复默认 ——
// 指纹只取「配置内容」字段（不含页签/结果列勾选等视图态），避免切页签/调结果列误判为改动。
// 库是全局资产（自动保存、不入场景）：指纹只含场景自身内容（行/引用/卫星选择/时窗）；
// 计算策略已随载波库条目走（v1.3.8），不再是场景内容 → 不入指纹。
function fingerprintOf(s) {
  return stableStringify({ rows: s.rows, satId: s.satId, geoMode: s.geoMode || 'auto', geoHorizonHours: s.geoHorizonHours })
}
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
// dirtyFlag：顶栏「未保存」小灯的渲染缓存——随防抖存盘刷新，setBaseline 即刻清灯
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
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
// 库 spec（口径与 serializeLibrary 一致）。卫星的 sanitize：ngsoSat.mode 由 'tree' 降为 'manual'
// 并清掉 folder —— 树节点 folder 是【本机】星座3D 页的标识，对端没有这颗树星，原样发过去会得到
// 「号称从卫星树取的星、树里却没有」的破状态。orbit / name / noradId 是自包含数据，照带不误。
const shareLib = {
  es: { arr: esConfigs, label: '地球站', keys: [], pack: packBase, makeNew: () => makeEsConfig('站型') },
  carrier: { arr: basebandConfigs, label: '载波', keys: [], pack: packBase, makeNew: () => makeBasebandConfig('载波') },
  sat: {
    arr: satConfigs, label: '卫星', keys: ['ngsoSat'],
    pack: (c) => ({ ...packBase(c), ngsoSat: c.ngsoSat || blankNgsoSat() }),
    sanitize: (e) => {
      const ns = e.ngsoSat || blankNgsoSat()
      return { ...e, ngsoSat: { ...ns, folder: '', mode: ns.mode === 'tree' ? 'manual' : (ns.mode || 'manual') } }
    },
    makeNew: () => makeSatConfig()
  }
}
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
// ★ NGSO 的几何必须送【平台算出来的那一组】：本窗口是 SGP4 双站互视 + 逐候选跑真实引擎按瓶颈侧
//   取最差路径，而小程序只有「最低仰角 + 轨道高度」的闭式几何。只送轨道高度的话小程序会用自己的
//   几何重算，与平台的最差路径不是一回事。故有结果时送 slantRange 模式 + 该时刻的实际仰角
//   （斜距与仰角要是同一时刻的那一对，大气/雨衰按仰角走）；没算过就退回轨道高度模式，诚实。
function toMiniItems(picked) {
  const out = []
  const taken = new Set()
  const fresh = !resultsStale.value && links.value.length ? links.value : null
  // 幂等身份「体制:配置id:行下标」。草稿没有稳定 id（'__draft__' 是每次都一样的假身份，两份不同的
  // 草稿会在手机上互相顶掉）→ 留空，按 lbMiniExport 的规矩退化为内容哈希：宁可多一份，不错覆盖。
  const srcIdOf = (p, i) => (p.id && p.id !== '__draft__' ? `NGSO:${p.id}:${i}` : '')
  for (const p of picked || []) {
    const st = p && p.state
    if (!st || !Array.isArray(st.rows) || !st.rows.length) continue
    const sat = resolveSat(st.satId)
    // 已存配置的 st 是 configs.json 里的旧快照，fresh 却是按工作区当前参数算的：工作区一脏两者就不是
    // 一回事（行数相同不代表内容相同），最差路径斜距/仰角不能贴上去，让小程序退回自己的闭式几何
    const useRes = fresh && fresh.length === st.rows.length && (p.id === '__draft__' || (p.id === activeId.value && !isDirty()))
    st.rows.forEach((row, i) => {
      const bb = resolveBaseband(row.basebandId)
      const txEs = resolveEs(row.stationId)
      const rxEs = resolveEs(row.rxStationId)
      const l = useRes ? fresh[i] : null
      out.push(miniConfigItem(buildMiniConfig({
        mod: 'NGSO',
        P: NGSO_PARAMS,
        name: miniConfigName(p.name, row.earthStationLocation, row.rxEarthStationLocation, i, taken),
        forms: { satForm: sat.form, carrierForm: bb.form, txStation: row, rxStation: row, txEs: txEs.form, rxEs: rxEs.form },
        result: l && l.data ? l.data : null,
        resolvedMargin: l ? l.resolvedMargin : null,
        // 轨道取星来源（ngsoSat.folder）是本机指针，buildMiniConfig 只读它的轨道根数判区制，不外传
        ngsoSat: sat.ngsoSat,
        beamInput: sat.form.satelliteName || sat.name || '',
        note: `${p.name || '配置'} · 第 ${i + 1} 行 · 载波「${bb.name || '默认'}」· 站型「${txEs.name || '默认'}」→「${rxEs.name || '默认'}」`
      }), 'NGSO', srcIdOf(p, i)))
    })
  }
  return out
}
const shareCtx = {
  mod: 'NGSO',
  getConfigs: () => configs.value,
  getActiveId: () => activeId.value,
  getDraft: () => ({ name: defaultCfgName(), state: serializeState() }),
  lib: shareLib,
  refsOf: shareRefsOf,
  pinRefs: sharePinRefs,
  remapState: shareRemap,
  toMiniItems,
  saveConfig: (payload) => api.store.saveConfig('ngso', payload),
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

// —— 报表语言与报告导出 ——
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
// NGSO 特有的平台几何（轨道根数 / 典型时刻 t* / 互视窗 / 覆盖）与两端站址随链路透传，
// 供报告的「几何关系」sheet 按 STK 口径出表。
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
  orbitType: 'NGSO',
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
  extraLink: (l) => {
    // 行优先按 _id 定位（计算后行可能被增删挪动），找不到退回原下标
    const row = linkRows.find((r) => r._id === l.rowId) || linkRows[l.i] || {}
    return {
      geom: l.geom ? JSON.parse(JSON.stringify(l.geom)) : null,
      txGeo: { name: l.txName, lat: parseFloat(row.latitude), lon: parseFloat(row.longitude), altM: parseFloat(row.altitude) || 0, minEl: parseFloat(row.minElevation) || 0 },
      rxGeo: { name: l.rxName, lat: parseFloat(row.rxLatitude), lon: parseFloat(row.rxLongitude), altM: parseFloat(row.rxAltitude) || 0, minEl: parseFloat(row.rxMinElevation) || 0 }
    }
  },
  defaultName: (en) => {
    const s = curSat.value ? curSat.value.form.satelliteName : ''
    return en
      ? `NGSO_Link_Budget_Report_${(s || 'Results').replace(/[^\w-]+/g, '_')}`
      : `NGSO链路预算报告_${(s || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
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
  api?.ngso?.onCloseRequested?.(async () => {
    if (!(await guardedLeave())) return
    await flushLibSave()
    api.ngso.confirmClose()
  })
  window.addEventListener('keydown', onGlobalKey)   // Ctrl+Enter = 计算
  window.addEventListener('focus', reloadSatTree)   // 单例窗口：切回本窗口即纳入「星座3D」新导入的 GRD
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
              :items="configs" :active-id="activeId" :focus-id="focusId" :editing-id="editing.id" :editing-name="editing.name"
              :expanded="expandedFolders"
              :cut-id="cfgClip && cfgClip.mode === 'cut' ? cfgClip.id : null"
              @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove" @focus="focusId = $event.id"
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
              <!-- 资源库编辑器：两种取星器（分段切换，均为配置级，只定轨道）+ 参数表单。选星后轨道高度/倾角只读「自动」——
                   ① show-tree：卫星/天线树选择；② show-search：从星历搜索。工作台卫星分区只留只读速览行。 -->
              <template #default="{ cfg }"><NgsoSatellitePanel :form="cfg.form" :fields="SAT_FIELDS" :show-tree="true" :show-search="true" :sat-tree="satTree" :ngso-sat="cfg.ngsoSat" :sat-selected="!!(cfg.ngsoSat && cfg.ngsoSat.mode !== 'manual' && cfg.ngsoSat.orbit)" :on-pick-tree="(node) => applyTreeSatOrbitFor(cfg, node)" :on-pick-search="(rec) => pickSearchSatFor(cfg, rec)" :on-clear="() => clearSatSelectionFor(cfg)" /></template>
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
        <!-- 功能区：文件 · 计算 · 场景 · 视图 · 导出 ‖ 状态位 -->
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" @click="saveCurrent">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
                保存<span v-if="dirtyFlag" class="lbx-dirty" title="有未保存的修改"></span>
              </button>
              <button class="lbr-big" :disabled="!api" title="分享 / 导入：配置（可多选）+ 资源库条目（可多选）——分享码 / 文件 / 发给用户ID" @click="openShareDlg"><Icon name="external-link" :size="15" />分享</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（卫星/天线树 / 实时星位 / 城市库 / 载波信号选项 等）" @click="refreshLatest">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :title="sideView === 'configs' ? '隐藏左侧「配置列表」栏（腾出工作区宽度）' : '左侧栏显示「配置列表」（场景文件树；与「资源库」二选一）'" @click="toggleSide('configs')"><Icon name="panel-left" :size="15" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <!-- 计算方式已随载波入资源库（逐行按所选载波取用），此处只留几何模式/搜索时窗与执行 -->
              <div class="lbr-form">
                <label title="几何来源：自动最差＝按卫星轨道解最差工况几何（仰角字段作门限，斜距由求解器给出）；手动＝仰角与斜距由链路表逐行给定，不解算轨道"><span>几何</span>
                  <select v-model="geoMode" style="width: 86px"><option v-for="g in GEO_MODES" :key="g.v" :value="g.v">{{ g.l }}</option></select>
                </label>
                <label v-if="!geoManual && satSelected" title="从计算此刻起在此时窗内，比较全部互视过境，取最坏一次的工况"><span>时窗</span>
                  <select v-model.number="geoHorizonHours" style="width: 76px"><option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option></select>
                </label>
              </div>
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
              <button class="lbr-big" :class="{ on: showViz }" :title="showViz ? '隐藏详细预算的图表区（地理场图 + 链路视图）' : '显示详细预算的图表区：地理场图（站址经纬度）+ 链路视图（3D 站星几何，卫星在最差时刻星下点）'" @click="showViz = !showViz"><Icon name="chart-line" :size="15" />图表</button>
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

        <!-- 链路工作台：全宽横向分区（卫星与轨道 → 链路表 → 详细预算），计算栏吸底 -->
        <div ref="flowEl" class="lbx-flow lbx-cards">
          <LbSection id="sat" title="卫星与轨道">
            <template #actions>
              <button class="lb-mini" title="到资源库编辑当前卫星：卫星/天线树选择 或 从星历搜索 定轨 + 完整参数（SFD/回退/轨道高度等）" @click="editInLibrary('sat')">编辑 / 选星</button>
            </template>
            <!-- 配置行：库单选（配置标签）+ 星名（本窗口唯一的卫星身份，加粗）+ 频率/取星来源速览。
                 星名与配置名分开呈现——同一颗星可有多份配置，但一份配置只认一颗星。 -->
            <div class="lbx-satrow">
              <label class="lbx-satpick" title="从卫星库选择本场景使用的卫星（场景级单选，全部链路共用；轨道来源随卫星条目走）"><span>卫星配置</span>
                <select :value="(curSat && curSat.id) || ''" @change="satId = $event.target.value">
                  <option v-for="o in satSelectOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                </select>
              </label>
              <span v-if="curSat" class="lbx-satname" title="卫星名称：取星后由所选卫星确定">{{ satNameShown }}</span>
              <span class="lbx-satsum" :title="satMeta">{{ satMeta }}</span>
            </div>
          </LbSection>

          <LbSection id="links" title="链路表" :count="linkRows.length" summary="一行一条链路：发端 + 收端 + 库引用 + 结果">
            <template #actions>
              <button v-if="geoManual" class="lb-mini" title="斜距工具：按轨道高度 × 仰角算斜距，可按各行仰角批量填入「斜距」列" @click="slantToolOpen = true">斜距工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="11" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" @wheel="onColPickWheel">
                  <label v-for="d in RESULT_DEFS" :key="d.key" class="lbx-colpick-i" :title="d.tip || d.label">
                    <input type="checkbox" :checked="resultKeys.includes(d.key)" @change="toggleResultKey(d.key)" />
                    <span>{{ d.label }}<i v-if="d.unit"> ({{ d.unit }})</i></span>
                  </label>
                  <div class="lbx-ccf">
                    <div class="lbx-ccf-hd"><span>自定义列</span>
                      <button class="lbx-ccf-btn" title="新建/编辑/删除自定义列（独立窗口，误点不丢）" @click="ccDlgOpen = true; colPickOpen = false">{{ customCols.length ? '管理…' : '＋ 新建…' }}</button></div>
                    <label v-for="c in customCols" :key="c.id" class="lbx-colpick-i" :title="c.expr">
                      <input type="checkbox" :checked="c.on !== false" @change="toggleCustomCol(c.id)" />
                      <span>{{ c.label }}<i v-if="ccUnit(c)"> ({{ ccUnit(c) }})</i></span>
                    </label>
                  </div>
                </div>
              </span>
            </template>
            <div class="lbx-grid">
              <StationGrid :stations="linkRows" :fields="gridFields" :groups="GRID_GROUPS" :extra-values="gridVals" :cell-class="cellClassFn"
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
            <div v-else-if="core" class="lbx-doc">
              <!-- NGSO 特有：平台精确几何。选星=单一典型时刻 t*(SGP4/SDP4，两站同刻·仰角尽量贴近各自最低)；
                   手动圆轨道=闭式球面(每站各自最低仰角)。预算文档以瀑布为主角：几何收进可折叠小节
                   （记忆展开态），头部常显方法/t* 摘要；折叠块随「详细预算」分区走。 -->
              <div class="lbx-fold">
                <div class="lbx-fold-hd" :class="{ closed: geoFold }" @click="geoFold = !geoFold">
                  <span class="chev"><Icon name="chevron-down" :size="12" /></span>
                  <span>卫星几何</span>
                  <span class="lbx-fold-sum">{{ geom && geom.feasible
                    ? (geom.method + (geom.coupled && geom.search && geom.search.typicalISO ? ' · t* ' + fmtInstant(geom.search.typicalISO, tzMode) : ''))
                    : (geom ? '不可行：' + (geom.reason || '') : '手动轨道 · 闭式球面最差几何') }}</span>
                </div>
                <div v-show="!geoFold" class="lbx-fold-bd">
              <div v-if="geom && geom.feasible" class="geo-card">
                <div class="geo-top">
                  <div class="geo-title">
                    <span class="geo-tt">卫星几何</span>
                    <span class="geo-badge" title="平台精确传播器：satellite.js 统一 SGP4/SDP4，225 min 自动切深空">{{ geom.method }}</span>
                  </div>
                  <div v-if="geoHasTimes" class="geo-tz" role="group" aria-label="时区切换" title="切换典型时刻 / 互视窗口的时标（UTC / 运行机本地 / 北京 UTC+8）">
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'beijing' }" @click="tzMode = 'beijing'">北京</button>
                  </div>
                </div>

                <div class="geo-body">
                  <!-- 互视访问（选星耦合：典型时刻 t* / 两站互视窗口起止·持续，STK UTCG 时标）-->
                  <template v-if="geom.coupled && geom.search">
                    <div class="geo-sec">互视访问<span class="geo-sec-x">{{ tzMode === 'utc' ? 'UTCG' : tzSuffix }}</span></div>
                    <div v-if="geom.search.typicalISO" class="geo-trow"><span class="geo-l" title="所有几何量取自这一物理瞬间；此刻两站同时可见、仰角尽量贴近各自最低仰角（通常一站正压最低、另一站略高）。t* 为墙钟绝对时——在「星座3D」页将时间轴设至此刻，即可与地图星下点直接核对（自定义星座同理：合成星已按场景历元正向传播到时间轴时刻，无需偏移换算）。">典型时刻 t*</span><span class="geo-time">{{ fmtInstant(geom.search.typicalISO, tzMode) }}</span></div>
                    <div v-if="geom.search.subSatLonDeg != null" class="geo-trow"><span class="geo-l" title="t* 该刻卫星星下点（经纬）。导入卫星天线时，卫星EIRP/G·T 即将卫星置于该位置对各站取天线增益，与本行斜距/FSL/C·N 同一瞬间">t* 星下点</span><span class="geo-time">{{ g2(geom.search.subSatLonDeg, 3) }}°E, {{ g2(geom.search.subSatLatDeg, 3) }}°N</span></div>
                    <template v-if="geom.search.mutualWindow">
                      <div class="geo-trow"><span class="geo-l" title="发信站与收信站同时满足各自最低仰角的时段（含 t* 的那次过境）——即两站可经该星建链的时间窗口范围">互视窗口 · 起始</span><span class="geo-time">{{ fmtInstant(geom.search.mutualWindow.startISO, tzMode) }}</span></div>
                      <div class="geo-trow"><span class="geo-l">互视窗口 · 结束</span><span class="geo-time">{{ fmtInstant(geom.search.mutualWindow.endISO, tzMode) }}<span v-if="geom.search.mutualWindow.clipped" class="geo-clip" title="窗口被搜索时窗边界切断，非完整过境">clipped</span></span></div>
                      <div class="geo-trow"><span class="geo-l">互视窗口 · 持续</span><span class="geo-time">{{ fmtDur(geom.search.mutualWindow.durationMin) }}</span></div>
                    </template>
                  </template>

                  <div class="geo-sec">站星几何<span class="geo-sec-x">{{ geom.coupled ? '典型时刻 t*' : '最差工况' }}</span></div>
                  <div class="geo-duo">
                    <span class="geo-duh"></span>
                    <span class="geo-duh geo-up">↑ 上行</span>
                    <span class="geo-duh geo-dn">↓ 下行</span>
                    <span class="geo-l" :title="geom.coupled ? '同一典型时刻 t* 两站各自对卫星的仰角：两站同时可见、都尽量贴近各自最低仰角（通常一站正压最低、另一站略高）' : '各站在「≥ 自身最低仰角」约束下的最差工况仰角（圆轨道=最低仰角门限）'">对卫星仰角</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.elevDeg) }}<i>°</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.elevDeg) }}<i>°</i></span>
                    <span class="geo-l" :title="geom.coupled ? 't* 该刻两站各自的星地斜距（同一物理瞬间）' : '仰角约束下的最大星地斜距（各站独立取，最坏几何）'">星地斜距</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.slantKm) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.slantKm) }}<i>km</i></span>
                    <span class="geo-l" :title="geom.coupled ? 't* 该刻卫星高度（同一瞬间，上下行相同）' : ''">卫星高度</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.altKm, 1) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.altKm, 1) }}<i>km</i></span>
                    <span class="geo-l" title="覆盖地心半角 λ = arccos((Re/r)·cosε) − ε（该仰角门限下卫星对地心张成的地面覆盖带半角）">覆盖地心半角</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.coverageHalfAngleDeg) }}<i>°</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.coverageHalfAngleDeg) }}<i>°</i></span>
                    <span class="geo-l" title="地面覆盖半径 = Re·λ（星下点到覆盖带边缘的地表大圆弧长）">地面覆盖半径</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.coverageRadiusKm, 1) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.coverageRadiusKm, 1) }}<i>km</i></span>
                    <span class="geo-l" title="最大过境时长(天顶) = 2λ/|ω_s − ω_E·cos i|；GEO / 严格常驻可见为 ∞">最大过境时长</span>
                    <span class="geo-vu" :class="{ 'geo-inf': geom.worst.up.maxPassMin == null }">{{ gPass(geom.worst.up.maxPassMin) }}<i v-if="geom.worst.up.maxPassMin != null">min</i></span>
                    <span class="geo-vd" :class="{ 'geo-inf': geom.worst.dn.maxPassMin == null }">{{ gPass(geom.worst.dn.maxPassMin) }}<i v-if="geom.worst.dn.maxPassMin != null">min</i></span>
                  </div>

                  <div class="geo-row"><span class="geo-l">单程链路时延</span><span class="geo-v">{{ g2(geom.worst.oneWayDelayMs, 3) }}<i>ms</i></span></div>

                  <div class="geo-sec">卫星运动</div>
                  <div v-if="geom.worst.speedInertialKmS != null" class="geo-row"><span class="geo-l">轨道速度<i>惯性系</i></span><span class="geo-v">{{ g2(geom.worst.speedInertialKmS, 3) }}<i>km/s</i></span></div>
                  <div v-if="geom.worst.speedGroundRelKmS != null" class="geo-row"><span class="geo-l">相对地面速度<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-v">{{ g2(geom.worst.speedGroundRelKmS, 3) }}<i>km/s</i></span></div>
                  <div v-if="geom.worst.maxDopplerUpHz != null" class="geo-duo geo-duo-tight"><span class="geo-l" :title="geom.dopplerEstimate ? '圆轨道无相位，闭式估算 f·v_radial/c' : (geom.coupled ? (geom.method + ' 取典型时刻 t* 该刻 ECEF 斜距变化率（含地球自转）；t* 多在低仰角、range-rate 近峰值') : (geom.method + ' 沿星历求 ECEF 斜距变化率（含地球自转）'))">{{ geom.coupled ? '多普勒频移' : '最大多普勒' }}<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-vu">±{{ g2(geom.worst.maxDopplerUpHz / 1000, 3) }}<i>kHz</i></span><span class="geo-vd">±{{ g2(geom.worst.maxDopplerDnHz / 1000, 3) }}<i>kHz</i></span></div>

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
              <div v-if="showViz" class="lbx-doc-side"><LbVizPane ref="vizRef" engine="ngso" :params="selParams" :sweep2D="api ? api.linkBudget.sweep2D : null"
                :output-defs="api ? api.linkBudget.outputDefs : null" :link-scene="linkScene" :geo-link="geoLink"
                store-key="ngso" :lang="reportLang" /></div>
              <div class="lbx-doc-ref"><WaterfallTable :segments="segments" pick="rest" :lang="reportLang" /></div>
            </div>
          </LbSection>
        </div>
      </section>

    </div>

    <!-- 配置右键菜单 -->
    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api"
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @save-new="openSaveDlg" @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
    />

    <!-- 高级计算：多载波功带平衡（VSAT 组网 / CNC 载波叠加，GEO/NGSO 共用组件）-->
    <LbAdvBalanceDialog :open="advDlg.open" :rows="advRows" :tp-bw-mhz="advTpBwMHz" :busy="advDlg.busy || computing"
      :stale="resultsStale" :carrier-remap="advRemap" store-key="ngso" @close="advDlg.open = false" @apply="applyAdvPlan" />

    <!-- 命名弹窗：保存为新配置（替代 Electron 不支持的 window.prompt）-->
    <!-- 导出报告：封面元信息 + 输出格式 + 是否含图（三窗共用组件）-->
    <LbCustomColsDialog :open="ccDlgOpen" :cols="customCols" :pool="customPool" :preview-fn="ccPreview"
      @update:cols="customCols = $event" @close="ccDlgOpen = false" />

    <!-- 斜距工具（几何=手动 时可用）：算斜距 + 按各行仰角批量填 -->
    <LbSlantTool :open="slantToolOpen" :alt-km="slantToolAlt" :elev-deg="slantToolElev" :lat-deg="slantToolLat" :sta-alt-m="slantToolStaAlt"
      :row-count="linkRows.length" :has-row="!!slantToolRow" @fill="applySlantFill" @close="slantToolOpen = false" />
    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="NGSO"
      :sat-name="curSat ? curSat.form.satelliteName : ''" :band="curSat ? curSat.form.frequencyBand : ''" :link-count="links.length"
      :viz-available="showViz" store-key="ngso" :busy="reportDlg.busy" :progress="reportDlg.progress"
      @close="reportDlg.open = false" @submit="runReport" />

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
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b data-i18n-skip>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
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
  /* 上行/下行分列的克制冷暖角标色（仅用于图例与箭头，数值仍取中性 text） */
  --up: #3f6d8c; --dn: #97672f;
  /* 统一圆角尺度 */
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
/* 右缘拖拽手柄：调整配置栏宽度 */
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
/* 配置栏表头更紧凑，给「配置列表」标题留足空间 */
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

/* 分段选择（链路配对等，计算栏用） */
.seg { display: flex; gap: 2px; }
.seg-i { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.seg-i:hover { color: var(--text); border-color: var(--border-strong); }
.seg-i.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }

/* 结果 */
.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }

/* 核心指标（.core-*）三线式样式统一在 styles/lbworkbench.css（三 App 共用，此处不再重复定义） */
/* 站星几何卡：三线语言（上下双线、题注行带栏目线、无底色）；正文上行/下行分列对齐。 */
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
.geo-sec { display: flex; align-items: baseline; gap: 7px; font-size: calc(var(--lb-fs, 11px) - 1px); font-weight: 600; color: var(--accent); margin: 8px 0 3px; padding-top: 5px; border-top: 1px solid var(--lb-rule-soft); letter-spacing: .3px; }
.geo-sec:first-child { border-top: none; padding-top: 0; margin-top: 3px; }
.geo-sec-x { font-weight: 400; font-size: 10px; color: var(--text-faint); letter-spacing: .2px; }

.geo-row, .geo-trow { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 1.5px 0; }
.geo-l { font-size: var(--lb-fs, 11px); color: var(--text-muted); min-width: 0; }
.geo-l i { font-style: normal; font-size: 10px; color: var(--text-faint); margin-left: 4px; letter-spacing: .2px; }
.geo-v, .geo-time { font-size: var(--lb-fs, 11px); font-weight: 700; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-v i, .geo-time i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 5px; }
.geo-clip { font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .4px; color: var(--text-faint); margin-left: 7px; padding: 1px 5px; border: 1px solid var(--border); border-radius: 999px; vertical-align: 1px; }
.geo-v-updn { display: inline-flex; gap: 11px; }
.geo-v-updn .up { color: var(--up); }
.geo-v-updn .dn { color: var(--dn); }

/* 核心几何三行：标签 + 上行 + 下行三列对齐，值取中性色，靠图例色区分方向 */
.geo-duo { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; column-gap: 16px; row-gap: 3px; margin: 4px 0 2px; }
/* 多普勒行复用双列格与站星几何列对齐，但夹在卫星运动的单列行之间，去掉分节块专用的上下外边距，回归 geo-row 行距 */
.geo-duo.geo-duo-tight { margin: 2.5px 0; }
.geo-duo .geo-l { grid-column: 1; }
.geo-duh { font-size: 10px; font-weight: 600; letter-spacing: .3px; text-align: right; color: var(--text-faint); padding-bottom: 1px; }
.geo-duh.geo-up { color: var(--up); }
.geo-duh.geo-dn { color: var(--dn); }
.geo-vu, .geo-vd { font-size: var(--lb-fs, 11px); font-weight: 700; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-vu i, .geo-vd i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 4px; }
/* 常驻可见 ∞：正文字号下符号偏小，单独放大（不加粗，字重同其它数值）*/
.geo-vu.geo-inf, .geo-vd.geo-inf { font-size: calc(var(--lb-fs, 11px) + 6px); line-height: 1; }

.geo-note { padding: 6px 2px; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-muted); line-height: 1.6; font-family: inherit; font-weight: 400; }

</style>
