<script setup>
import { ref, shallowRef, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { askConfirm, confirmState } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import { FIELD_GROUPS, SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS, defaultsFor, buildParams } from './params.js'
import * as GEO_PARAMS from './params.js'   // 整份 schema 传给 lbMiniExport 的 target 分流（与 buildParams 同源，但不做 sfdRef 的引擎入口换算）
import { buildMiniConfig, miniConfigItem, miniConfigName } from '../shared/lbMiniExport.js'
import { loadSatTree, sampleAntennaParams, antennaSampleSpec, grdFillBase, grdFillNeeded } from './grdParam.js'
import { importGrdAntennas, removeLocalAntenna, localFolderFor, isLocalFolder, syncLocalNode, antKeyOf, folderOfKey, antNameOfKey, localAntennaCount, removeLocalNode } from '../shared/lbGrdImport.js'
import { resolveRefId, LIB_WINDOWS, libCopyTargets, copyLibEntry, externalLibEntries } from '../shared/lbShare.js'
import { stableStringify } from '../shared/configDirty.js'
import { migrateLegacyEs } from '../shared/esMigrate.js'
import { pickColumn, fmtScaled, fmtQty, fmtQtyParts } from '../shared/adaptUnits.js'
import { isUnitAdaptive, onUnitModeChange } from '../shared/lbUnitMode.js'   // 结果显示单位档（功能区「单位」，出厂锁定）
import { lbDocT } from '../shared/lbDocI18n.js'
import { waterfallTsv } from '../shared/lbWaterfallTsv.js'   // 详细预算整表复制（四窗一份）
import { getLang, onLangChange } from '../shared/i18n/runtime.js'   // 报表语言跟随平台语言
import { syncAutoNames, adoptAutoFlag, withAutoFlag, isAutoNamed, newCfgName, newFolderName, copyNameOf, isSatNamePlaceholder } from '../shared/lbAutoName.js'   // 三库条目自动命名（未被用户改名时，名字随关键参数走）
import { fmtGeoSlot } from '../shared/orbitClass.js'   // 轨位 °E/°W 折算（西经不再写成负°E）
import { byLang } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import StationGrid from './StationGrid.vue'
import LinkImportDialog from '../components/LinkImportDialog.vue'   // 「导入链路」：星座 3D 主窗建的图上链路
import { esStationType } from '../shared/lbStationType.js'   // 站带天线口径 / 天线罩 → 对号地球站库条目
import BasebandPanel from './BasebandPanel.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import SatellitePanel from './SatellitePanel.vue'
import WaterfallTable from './WaterfallTable.vue'
import LbVizPane from '../components/LbVizPane.vue'
import LbSlaDialog from '../components/LbSlaDialog.vue'
import LbCapDialog from '../components/LbCapDialog.vue'
import { CAP_PBW, capKeySat, buildCapModel, normCapParams, applyRowCap, setCapIncluded, setCapCount, setCapTpParam, remapCapParams, capReportBlock } from '../shared/lbCapacity.js'   // 容量汇总（三窗共用纯逻辑）
import { deriveSla, normSlaParams, applyRowSla, setAdopt, setInclude, setAllInclude, clearAdopt, slaIncludeCount, slaSamplesFor, slaLoopback, slaReportBlock, slaParamRows, sunOutageSummary, DEFAULT_SLA_PARAMS , slaScanReportRows, slaComposition} from '../shared/lbSla.js'   // SLA 建议（四窗共用纯逻辑）
import { getPlan, checkAgainstChannel, resyncAll } from '../shared/lbFreqPlanRef.js'   // 发射合规：卫星条目引用了频率计划时的数值核对；resyncAll＝计划改了按引用重套
import LbDispCtl from '../components/LbDispCtl.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import LbCapFoot from '../components/LbCapFoot.vue'
import LbCustomColsDialog from '../components/LbCustomColsDialog.vue'
import { buildPool, makeResolver, evalRows, customFieldDefs, loadDefs, saveDefs, unitOf, schemaInputPool } from '../shared/lbCustomCols.js'   // 自定义列：公式合成新列
import { createPreviewJob } from '../shared/lbPreview.js'   // 链路表实时预览作业（分块批量 IPC + 代际取消 + 「计算」优先）
import { loadDefaultSiteGeo, withDefaultSite, defaultSiteValue, seedDefaultSite, isDefaultSiteSeed } from '../shared/lbDefaultSite.js'   // 站址留空 → R0.01% / 海拔按默认站址取
import { loadOrder, saveOrder, makeDragOrder } from '../shared/lbResultOrder.js'   // 结果列的显示顺序 + 拖动排序
import { labeledResultPool, RESULT_LABELS, migrateLegacyFieldRefs } from '../shared/lbResultLabels.js'   // 引擎出参中文名与单位（全量词表）
import LbShareDialog from '../components/LbShareDialog.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import LbAdvBalanceDialog from '../components/LbAdvBalanceDialog.vue'
import { useLbReport } from '../shared/useLbReport.js'
import { planAdvWriteback, advBaseMargin } from '../shared/advBalance.js'   // 高级计算配平结果的写回落点（新建副本 / 就地改）
import { buildGeoScene } from '../shared/lbLinkScene.js'
import { validateRows } from '../shared/lbValidate.js'   // D6：计算前数值预校验（不是数 / 越出字段范围）
import { useNotice } from '../shared/useNotice.js'
import { reportError, reportPartial } from '../shared/reportError.js'

const api = typeof window !== 'undefined' ? window.api : null
// 通知条（shared/useNotice.js）：toast＝普通回执，toastFile＝导出回执（附「打开 · 在文件夹中显示」），toastError＝常驻错误；
// 调用即把本窗登记为 reportError 的出口。必须先于下面的 useConfigTree（它要拿 toast）——const 不像函数声明那样提升。
const N = useNotice()
const { toast, toastFile, toastError } = N

// 配置列表：命名配置持久化到 userData/configs.geo.json（store.config.*，各工作台一份互不见面）。
// 「多级文件夹树」：configs 里同时含配置项与文件夹项 { type:'folder',name,parentId }，
// 归属由 parentId 表达，展开态存 localStorage。文件夹本身不进 activeId（它不是可载入的工作状态）。
// 树的全部行为（增删改移 / 剪贴板 / 右键 / 键盘）在 shared/useConfigTree.js，五个工作台共用一份。
// 注入的都是本窗特有的那几件事；它们都是【函数声明】，提升后才能在这里前向引用。
// 场景自动保存（2026-10-06 起取代「保存」按钮）：工作区恒对应一份配置，改动约 1 s 后写回（shared/useConfigAutosave.js）；
// 后悔药是历史版本（shared/useConfigVersions.js + LbVersionsDialog）。
const cfgTree = useConfigTree({
  ns: 'geo', orbitType: 'GEO', api, storageKey: 'linkbudget/expandedFolders',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName,
  autosave: true, onNameAuto: (id) => { if (id === activeId.value) autosave.flush() }
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, ctxMenu,
  loadConfigs, uniqueCfgName, activeName, selectConfig, ensureActive, duplicateItem,
  toggleFolder, expandFolder, expandAll, collapseAll, persistExpanded,
  addFolder, addBlankConfig, removeConfig, removeFolder, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, ctxDo, onCfgKey
} = cfgTree
const autosave = useConfigAutosave({
  ns: 'geo', api, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'geo', api, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
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
  // html.ui-col-resize（controls.css）：拖动全程整窗锁 col-resize 光标、禁选字——指针划过表格 / 按钮时光标不再跳
  sideResizing.value = true; document.documentElement.classList.add('ui-col-resize')
  document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { w.value = Math.min(max, Math.max(min, startW + (ev.clientX - startX))) }
  const up = () => {
    sideResizing.value = false; document.documentElement.classList.remove('ui-col-resize')
    document.body.style.cursor = ''; document.body.style.userSelect = ''
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
function makeBasebandConfig(name) { return withAutoFlag({ id: 'bb' + (_bbSeq++), name: name || '', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null } }, 'carrier') }
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
  esConfigs.push({ id: 'es' + (_esSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)) })
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
// satFolder 只表示「从天线树选的那颗星」；本条目自己导入的方向图不占这一格（存量数据里占过，
// 见下方 isLocalFolder 归一化）——两者并列可选，「导入方向图」因此是纯添加。
const normGrd = (g) => ({
  satFolder: (g && g.satFolder && !isLocalFolder(g.satFolder)) ? g.satFolder : '',
  eirpKey: (g && g.eirpKey) || '', gtKey: (g && g.gtKey) || '',
  fpId: (g && g.fpId) || '', fpNo: (g && g.fpNo) || ''
})
function makeSatConfig(name) { return withAutoFlag({ id: 'sat' + (_satSeq++), name: name || '', form: { ...defaultsFor(SAT_FIELDS) }, grd: blankGrd() }, 'sat') }
const satConfigs = reactive([makeSatConfig('默认卫星')])
const satId = ref('')   // 配置级归属下本场景选用的卫星库条目（空 = 第一份）
function resolveSat(id) {
  if (!id) return satConfigs[0]
  return satConfigs.find((c) => c.id === id) || satConfigs.find((c) => c.name === id) || satConfigs[0]
}
const curSat = computed(() => resolveSat(satId.value))
const satSelectOptions = computed(() => satConfigs.map((c) => ({ value: c.id, label: c.name })))
// —— 卫星的指定方式（场景级，随场景存档；三个链路预算窗口同一套；开关在链路表节头）——
//   'config' 统一指定：本配置只用一颗卫星（satId），在「卫星与转发器」分区选，全部链路共用——GSO 出厂口径；
//   'link'   逐链路指定：链路表每行各选卫星（行字段 satelliteId），表首多出「卫星」列组（卫星 · 卫星G/T · 卫星EIRP），
//            上方卫星分区随之收起（再报一颗星只会与表里的混淆）。
// 引擎口径不变：两种方式只决定每行的 satForm 从哪里取（见 satOfRow）；方向图回填仍按「G/T 取发信站站址、
// EIRP 取收信站站址」，只是天线来自该行所用的那颗星。
const SAT_SCOPES = [{ v: 'config', l: '统一指定' }, { v: 'link', l: '逐链路指定' }]
const satScope = ref(localStorage.getItem('linkbudget/satScope') === 'link' ? 'link' : 'config')
watch(satScope, (v) => { try { localStorage.setItem('linkbudget/satScope', v) } catch (e) { /* ignore */ } })
const satLink = computed(() => satScope.value === 'link')
// 某行链路所用的卫星库条目：链路级取该行「卫星」列，配置级取场景单选
const satOfRow = (row) => (satLink.value ? resolveSat(row && row.satelliteId) : curSat.value)
// 链路表「卫星」列的选项（空 = 库中第一份，与引擎「空→第一份」口径一致）
const satColOptions = computed(() => [{ value: '', label: '（默认）' }, ...satConfigs.map((c) => ({ value: c.id, label: c.name }))])
// 切换归属：配置级→链路级 把场景卫星写进空着的「卫星」列（已有值的行留原值）；链路级→配置级 场景卫星取首行所选，
// 全表随之改用这一颗（各行原先不同星时，结果会变）
function setSatScope(v) {
  if (v !== 'link' && v !== 'config') return
  if (v === satScope.value) return
  if (v === 'link') { const id = curSat.value ? curSat.value.id : ''; for (const r of linkRows) if (!r.satelliteId) r.satelliteId = id }
  else if (linkRows.length) { const s = resolveSat(linkRows[0].satelliteId); if (s) satId.value = s.id }
  satScope.value = v
}
function addSatConfig() { satConfigs.push(makeSatConfig()); syncAutoNames(satConfigs, 'sat') }
function duplicateSatConfig(cfg) {
  satConfigs.push({ id: 'sat' + (_satSeq++), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)), grd: normGrd(cfg.grd) })
  syncAutoNames(satConfigs, 'sat')
}
function removeSatConfig(cfg) { removeLibEntry(satConfigs, cfg, 'sat') }

// —— 库条目删除守卫：被链路行 / 已保存场景引用时先提示引用数 ——
function refCount(kind, id) {
  let n = 0
  // 卫星：配置级看场景单选，链路级看各行「卫星」列（按该场景自己的归属判，另一种归属下的残留值不算引用）
  const rowHit = (r, link) => (kind === 'es' ? (r.stationId === id || r.rxStationId === id) : kind === 'bb' ? r.basebandId === id : kind === 'sat' ? (link && r.satelliteId === id) : false)
  for (const r of linkRows) if (rowHit(r, satLink.value)) n++
  if (kind === 'sat' && !satLink.value && (satId.value === id || (!satId.value && satConfigs[0] && satConfigs[0].id === id))) n++
  for (const c of configs.value) {
    const st = c && c.state
    if (!st) continue
    const link = st.satScope === 'link'
    if (Array.isArray(st.rows)) for (const r of st.rows) if (r && rowHit(r, link)) n++
    if (kind === 'sat' && !link && st.satId === id) n++
  }
  return n
}
async function removeLibEntry(arr, cfg, kind) {
  if (arr.length <= 1) return
  const n = refCount(kind, cfg.id)
  if (n > 0 && !(await askConfirm(`「${cfg.name}」正被 ${n} 处链路/场景引用，删除后相关引用将回退到库中第一份配置。确定删除？`))) return
  const idx = arr.findIndex((c) => c.id === cfg.id)
  if (idx >= 0) arr.splice(idx, 1)
  _libGone.add(cfg.id)   // 获焦并库（mergeLibFromDisk）不许把它从盘上的旧副本里捡回来
  if (kind === 'sat') await dropImportedGrdOf(cfg)
}
// G4：卫星条目名下导入的方向图（lb:<条目 id>，原始 GRD 在 userData）不随条目自动消失——删条目后第二步问一句，
// 确认则整节点删掉、文件进回收站（主进程 coverageGrd.remove）；不删就原样留着（与此前行为相同）。
// 别的卫星条目（复制条目时带过去的匹配）若也指着这些天线，一并报出个数：删了它们会显示「未导入」。
async function dropImportedGrdOf(cfg) {
  const folder = localFolderFor(cfg.id)
  const k = localAntennaCount(folder)
  if (!k) return
  const others = satConfigs.filter((c) => c.grd && ['eirpKey', 'gtKey'].some((x) => folderOfKey(c.grd[x]) === folder)).length
  if (!(await askConfirm(`同时删除该条目导入的方向图（${k} 个文件）？` + (others ? `另有 ${others} 个卫星条目匹配了上述方向图。` : '')))) return
  const r = await removeLocalNode(folder)
  reloadSatTree()
  if (r.failed.length) reportPartial('删除方向图', r.removed, r.failed)
  else toast(`已删除 ${r.removed} 个方向图文件`)
}
// 本会话删掉的库条目 id（见 mergeLibFromDisk）
const _libGone = new Set()

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
const libSaveFailed = (e) => reportError('资源库保存失败', e)   // 写盘失败常驻通知条（不随 4 s 回执消失）
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
  if (Array.isArray(lib.carrier) && lib.carrier.length) basebandConfigs.splice(0, basebandConfigs.length, ...lib.carrier.map((c, i) => fill(CARRIER_FIELDS, 'carrier', { rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null })(c, i, 'bbb')))
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
// 默认站址（经纬度留空时引擎所用的那一组）的 ITU 降雨率 / 海拔：onMounted 在载入配置前取一次（见 shared/lbDefaultSite.js）。
// 用途三处：出厂行的 R0.01% / 海拔按它写；站址留空的行组参时补它；表内灰字照显它。取不到为 null，一切照旧。
const defSite = shallowRef(null)
const ghostOf = (row, f) => defaultSiteValue(row, f.key, defSite.value)
// 站址名留空的行：链路名取表内灰字那个名字（字段缺省站址名，与 StationGrid 的 ghost 同源），不再回落成「发 n / 收 n」
const siteNameOf = (row, key, fields, i, pre) => {
  if (row[key]) return row[key]
  const f = (fields || []).find((x) => x.key === key)
  return (f && (ghostOf(row, f) || f.def)) || (pre + (i + 1))
}
function newLinkRow() {
  const r = seedDefaultSite({ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS) }, defSite.value)
  r.rxStationId = (esConfigs[1] && esConfigs[1].id) || ''   // 默认收端引用第二份站型（经典 6.2m 发 / 3.7m 收基线）
  r._id = 's' + (_sid++)
  return r
}
const linkRows = reactive([newLinkRow()])

const LIB_TABS = [
  { key: 'station', label: '地球站', tip: '站型收发射频参数库：链路表「地球站配置」列按行引用' },
  { key: 'sat', label: '卫星', tip: '空间段参数库：卫星统一指定时在主区「卫星与转发器」分区单选，逐链路指定时由链路表「卫星」列按行引用' },
  { key: 'carrier', label: '载波', tip: '载波库：链路表「载波配置」列按行引用' }
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
const satLibSummary = (c) => [isAutoNamed('sat', c) ? '' : (c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : ''), (c.form.centerFrequency || c.form.rxCenterFrequency) ? `${c.form.centerFrequency || '—'}/${c.form.rxCenterFrequency || '—'} GHz` : '', isAutoNamed('sat', c) ? '' : (c.form.orbitPosition ? (fmtGeoSlot(Number(c.form.orbitPosition)) || c.form.orbitPosition + '°E') : '')].filter(Boolean).join(' · ')
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
// 卫星分区所报的那颗星：配置级＝场景单选；链路级＝聚焦行（未点过表时首行）所选卫星，与表脚「本行读数」同一行
const bandSat = computed(() => {
  if (!satLink.value) return curSat.value
  const row = linkRows.find((r) => r._id === focusRowId.value) || linkRows[0] || null
  return row ? satOfRow(row) : (satConfigs[0] || null)
})
// 链路级：链路表引用了哪些卫星（去重计数，卫星分区首行的读数）
const satUsage = computed(() => {
  if (!satLink.value) return []
  const m = new Map()
  for (const r of linkRows) {
    const s = satOfRow(r); if (!s) continue
    const e = m.get(s.id) || { id: s.id, name: s.form.satelliteName || s.name || s.id, n: 0 }
    e.n++; m.set(s.id, e)
  }
  return [...m.values()]
})
// 场景所用卫星的名字与频段（报告封面 / 默认文件名 / 配置默认名）：配置级＝场景单选那颗；链路级＝链路表引用的各星去重并列
const sceneSatName = computed(() => (satLink.value ? satUsage.value.map((u) => u.name).join(' / ') : ((curSat.value && curSat.value.form.satelliteName) || '')))
const sceneBand = computed(() => {
  const sats = satLink.value ? satUsage.value.map((u) => resolveSat(u.id)) : [curSat.value]
  return [...new Set(sats.map((s) => (s && s.form.frequencyBand) || '').filter(Boolean))].join(' / ')
})
const satFacts = computed(() => {
  const f = (bandSat.value && bandSat.value.form) || {}
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
  if (kind === 'sat') selSatId.value = id || (bandSat.value && bandSat.value.id) || ''
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
  // 文字型三列（引擎回显的载波体制）：本行用的调制 / 码率 / MODCOD 档名——看余量时不必回头翻载波库
  { key: 'modulationResult', label: '调制方式', type: 'text', tip: '本行载波的调制方式（引擎回显）' },
  { key: 'fecResult', label: 'FEC 码率', type: 'text', tip: '本行载波的 FEC 码率（引擎回显，保持录入写法）' },
  { key: 'modcodResult', label: 'MODCOD', type: 'text', tip: '从 MODCOD 库中所选档位的名称；未从库中选择则按「调制方式 + FEC 码率」拼出' },
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
  // 倾斜运行 / 保持盒（A-01）：日最大指向损耗（已计入链路）；定点 + 固定天线时为空
  { key: 'uplinkPointingLossResult', label: '上行指向损耗', unit: 'dB', tip: '日最大：卫星倾斜运行 / 在保持盒里走动时发信站天线的指向损耗（已计入链路）' },
  { key: 'downlinkPointingLossResult', label: '下行指向损耗', unit: 'dB', tip: '日最大：卫星倾斜运行 / 在保持盒里走动时收信站天线的指向损耗（已计入链路）' },
  { key: 'systemAvailabilityResult', label: '系统可用度', unit: '%' }
]
const DEFAULT_RESULT_KEYS = ['paRecommendation', 'linkmargin', 'carrierTotalCN', 'bandwidthUsageRatio', 'powerUsageRatio', 'capacityMbps']
const resultKeys = ref((() => {
  try { const v = JSON.parse(localStorage.getItem('linkbudget/resultCols') || ''); return Array.isArray(v) && v.length ? v : DEFAULT_RESULT_KEYS.slice() } catch (e) { return DEFAULT_RESULT_KEYS.slice() }
})())
watch(resultKeys, (v) => { try { localStorage.setItem('linkbudget/resultCols', JSON.stringify(v)) } catch (e) { /* ignore */ } }, { deep: true })
// 结果列的显示顺序：全量 key 序（含未勾选的）另存，「结果列」面板里拖把手换位；表列与本行读数都按它排
const RESULT_DEF_BY_KEY = Object.fromEntries(RESULT_DEFS.map((d) => [d.key, d]))
const resultOrder = ref(loadOrder('linkbudget/resultOrder', RESULT_DEFS))
watch(resultOrder, (v) => saveOrder('linkbudget/resultOrder', v))
const resultDefsOrdered = computed(() => resultOrder.value.map((k) => RESULT_DEF_BY_KEY[k]).filter(Boolean))
const resultDefsOn = computed(() => resultDefsOrdered.value.filter((d) => resultKeys.value.includes(d.key)))
const colDrag = reactive({ key: '' })
const colDragH = makeDragOrder({ state: colDrag, getOrder: () => resultOrder.value, setOrder: (v) => { resultOrder.value = v } })
const colPickOpen = ref(false)
// 面板打开期间拦滚轮：面板内滚到边界即止（遮罩上另行全拦）。否则滚轮默认动作沿 DOM 链滚动底下的
// 分节流，页面在遮罩下乱滚、面板随宿主节头滚出视野。
function onColPickWheel(e) {
  const el = e.currentTarget
  const canScroll = e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
  if (!canScroll) e.preventDefault()
}
// 勾选/取消结果列（勾选集按显示顺序表排，列序不随点击顺序漂移）
function toggleResultKey(k) {
  if (resultKeys.value.includes(k)) resultKeys.value = resultKeys.value.filter((x) => x !== k)
  else resultKeys.value = resultOrder.value.filter((x) => x === k || resultKeys.value.includes(x))
}
// 链路表列 = 发端组 + 收端组 + 结果列组；计算列 ro:true，值走 computedVals 映射。
// 实时 EIRP/G·T 不再占独立列（原段末的 _eirp/_gt 列已撤）——改由「地球站配置」单元格第二行小字承载
// （见 cellSubFn，值仍来自 computedVals：发端配置下显示 EIRP、收端配置下显示 G·T）。
// 列组随卫星的指定方式变：统一指定＝发信站 | 收信站 | 计算结果（卫星在上方分区单选，不占列）；
// 逐链路指定＝卫星 | 发信站 | 收信站 | 计算结果——「卫星」列组放在表首（用户要求：一眼先看到这行用的哪颗星），
// 组内三列：卫星（库引用）、该星对本行发信站的 G/T、该星对本行收信站的 EIRP（与再生式链路表的「卫星」列组同一口径）。
const GRID_GROUPS_CONFIG = [{ key: 'tx', label: '发信站' }, { key: 'rx', label: '收信站' }, { key: 'res', label: '计算结果' }]
const GRID_GROUPS_LINK = [{ key: 'sat', label: '卫星' }, { key: 'tx', label: '发信站' }, { key: 'rx', label: '收信站' }, { key: 'res', label: '计算结果' }]
const gridGroups = computed(() => (satLink.value ? GRID_GROUPS_LINK : GRID_GROUPS_CONFIG))
const SAT_COL_KEYS = ['satelliteId', 'G_Ts', 'rxEIRP']
const gridFields = computed(() => {
  const link = satLink.value
  const all = [...TX_FIELDS, ...RX_FIELDS]
  return [
    ...(link ? SAT_COL_KEYS.map((k) => ({ ...all.find((f) => f.key === k), group: 'sat' })) : []),
    ...TX_FIELDS.filter((f) => (link ? !SAT_COL_KEYS.includes(f.key) : f.key !== 'satelliteId')).map((f) => ({ ...f, group: 'tx' })),
    ...RX_FIELDS.filter((f) => !(link && SAT_COL_KEYS.includes(f.key))).map((f) => ({ ...f, group: 'rx' })),
    ...resultDefsOn.value.map((d) => ({ key: '_' + d.key, label: d.label, unit: resColUnits.value[d.key] || d.unit, type: d.type === 'text' ? 'text' : 'num', ro: true, group: 'res', target: 'meta', tip: d.tip || d.label })),
    ...customFieldDefs(customCols.value, customPool.value)
  ]
})
// 计算列取值映射 { 行_id: { _键: 值 } }：结果不写行数据 → 写回不惊动存档/脏检/过期 watcher
const computedVals = ref({})
// 结果列显示单位自适应：每次计算按整列最大|值|共选档位（W→mW、kHz→MHz、全列<0dBW→dBm），
// 列头单位跟随；写入 computedVals 的值已按所选档位换算（复制出去的数与列头一致）
const resColUnits = ref({})
function setVals(id, patch) { computedVals.value = { ...computedVals.value, [id]: { ...(computedVals.value[id] || null), ...patch } } }
// 多行一次合并（预览按块回填用）：逐行 setVals 每次都整份复制 computedVals，万行表一块下来就是 O(块长×行数)
function patchVals(m) { const next = { ...computedVals.value }; for (const id in m) next[id] = { ...(next[id] || null), ...m[id] }; computedVals.value = next }
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
// 值取自 computedVals（预览作业 preview 按块回填，dBW/dB·K 为 dB 量纲不做单位自适应）；未算出则不显示第二行。
function cellSubFn(f, row) {
  if (f.key !== 'stationId' && f.key !== 'rxStationId') return null
  const m = computedVals.value[row._id]
  if (!m) return null
  const v = f.key === 'stationId' ? m._eirp : m._gt
  if (v == null || v === '' || v === '—') return null
  return f.key === 'stationId' ? `EIRP ${v} dBW` : `G/T ${v} dB/K`
}
// 功能区「单位」档的响应式副本：模板里就地算的读数（功放尾标等）直接吃它——fmtQty 内部读的是
// 模块态，不响应式，没算过链路时切档就不会有任何东西触发重渲染。值由 onUnitModeChange 更新。
const unitAdaptive = ref(isUnitAdaptive())

// 「地球站配置」单元格行内尾标：发端配置(stationId)名之后贴该行实时算出的功放功率（就在第二行 EIRP 之上）。
// 只给发信站——功放是发射链的量，收端那格没有它。库里那一项是「功放功率预设」，这里是按本行几何/载波
// 与计算方式实时解出的功放功率：口径同为引擎 paRecommendation（含回退的功放输出），故「设置功放功率」
// 方式下二者相等，其余方式下这里报的是该链路真正需要的功率。单位自适应（0.2 W 报 200 mW）。
function cellTagFn(f, row) {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const w = m ? parseFloat(m._paW) : NaN
  // 取 4 位有效数字：尾标是一眼扫过的读数，引擎原串的 40.000 在这里读作「40 W」（精确值看结果列/瀑布）
  return isFinite(w) ? fmtQty(Number(w.toPrecision(4)), 'W', unitAdaptive.value) : null
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
// 输入代次：上面这些输入每变一次 +1（有没有结果都记）。compute 开算时记下、算完比一次 —— 算的途中改了表，
// 灯就保持亮（早先算完一律熄灯，期间那一笔改动从此不认账）
let _inGen = 0
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId, satScope],
  () => { _inGen++; if (links.value.length) resultsStale.value = true }, { deep: true })
// —— 自定义列（公式把引擎出参组合成新列，语法与求值见 shared/lbCustomCols.js）——
// 定义按窗口记忆（localStorage），不入场景配置——口径同结果列勾选集；值由 links 里留底的引擎
// 结果即时求出，新建/改公式即刻回填，无需重算。
// 字段池 = 本页【输入参数】+【全部输出参数】：输入取每行真正送进引擎的那份入参（sweepParamsByRow
// 留底，天然分体制），标签复用 params 字段表；输出算过之前给结果列+可绘清单（策展），算过之后按
// 本体制实际出参过滤并补齐其余全部数值键（「全部出参」组，label=键名）。capacityMbps 是派生指标，恒剔除。
// 载入时把按旧列名引用的公式改写成新名（v1.5.0「卫星EIRP」→「卫星饱和 EIRP」，见 migrateLegacyFieldRefs）
const customCols = ref(migrateLegacyFieldRefs(loadDefs('linkbudget/customCols'), 'GEO'))
watch(customCols, (v) => saveDefs('linkbudget/customCols', v), { deep: true })
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
  // 文字型结果列（调制方式 / FEC / MODCOD）不是量，不进公式字段池
  const base = RESULT_DEFS.filter((d) => d.key !== 'capacityMbps' && d.type !== 'text').map((d) => { const t = RESULT_LABELS[d.key]; return { key: d.key, label: t ? t.label : d.label, unit: t ? t.unit : d.unit, group: '结果列' } })
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
// —— 瀑布表一键整表复制（TSV，直接粘贴进 Excel / 报告）——
// 拼表在 shared/lbWaterfallTsv.js（四窗一份）：多列段列头取段自带的 heads（工况对照「晴空 / 降雨」），
// 段标题 / 行标签已随 segments 按报表语言翻好，列头在那里按 lbDocT 补上
async function copyWaterfallTsv() {
  if (!segments.value.length) return
  try { await navigator.clipboard.writeText(waterfallTsv(segments.value, lbDocT(reportLang.value))); toast('已复制详细预算（TSV）') }
  catch (e) { toast('复制失败') }
}
// Ctrl+Enter 全局快捷计算
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !computing.value) { e.preventDefault(); compute() }
}
onBeforeUnmount(() => { preview.dispose(); window.removeEventListener('keydown', onGlobalKey); window.removeEventListener('focus', reloadSatTree); window.removeEventListener('focus', onWinFocus) })

// 链路表实时列：发端 EIRP / 收端 G/T / 功放尾标 —— 输入变化即逐行重算（无需点「计算」），写入 computedVals。
// 作业本体在 shared/lbPreview.js（分块批量 IPC + 代际取消 + 「计算」优先：computing 一亮就挂起、算完续跑），
// 这里只给它四件事：行数、第 i 行的入参、一块怎么发、一块回来怎么写。
// EIRP 用该行载波的计算方式（与主计算一致，否则功带平衡等模式下解出的功率不同 → EIRP 对不上）；
// G/T 只与收端天线/噪温有关，同一次调用顺带取出。
const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? v : n.toFixed(2) }
const preview = createPreviewJob({
  count: () => (api ? linkRows.length : 0),
  build: (i) => {
    const row = linkRows[i]
    try {
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      const site = withDefaultSite(row, defSite.value)   // 站址留空 → R0.01% / 海拔按默认站址（与「计算」同口径）
      const { satParams, linkParams } = buildParams(satOfRow(row).form, bbForm, site, site, txEs, resolveEs(row.rxStationId).form)
      return { id: row._id, spec: { engine: 'geo', sat: satParams, link: linkParams, opt: calcOptOf(bbForm, txEs) } }
    } catch (e) { return null }
  },
  // 老 preload 没有批量入口时逐条回退（口径相同，只是没了行间让出与取消）
  send: (specs, token) => (api.linkBudget.previewBatch
    ? api.linkBudget.previewBatch(specs, token)
    : Promise.all(specs.map((s) => api.linkBudget.computeMode(s.sat, s.link, s.opt)))),
  cancel: (token) => { if (api.linkBudget.previewCancel) api.linkBudget.previewCancel(token) },
  apply: (list) => {
    const m = {}
    // _paW＝实时功放功率（原值不 toFixed：小功率靠 fmtQty 换 mW 档显示，见 cellTagFn）
    for (const { id, r } of list) if (r && r.success) m[id] = { _eirp: fix2(r.data.stationEIRPResult), _gt: fix2(r.data.gOverTeResult), _paW: r.data.paRecommendation }
    patchVals(m)
  }
})
watch([satConfigs, basebandConfigs, esConfigs, linkRows, satId, satScope], () => preview.schedule(), { deep: true })
// 「计算」优先：computing 一亮就挂起预览、算完（含瀑布表）再续跑。同步 watcher——取消令牌要赶在 compute 发出
// 批量 IPC 之前送到主进程，在算的那块才会在下一个让出点停手给「计算」腾地方；计算期间改了输入，恢复时重排一次。
watch(computing, (v) => { if (v) preview.pause(); else preview.resume() }, { flush: 'sync' })

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
// 匹配选择随卫星库条目走（cfg.grd，见上方卫星库）：一行链路用哪颗星，就用那颗星自己的方向图——
// 配置级全表同一颗（curGrd），链路级逐行按「卫星」列取（grdOfRow）。
const curGrd = computed(() => (curSat.value && curSat.value.grd) || null)
const grdOfRow = (r) => { const s = satOfRow(r); return (s && s.grd) || null }
const grdNodeOf = (g) => (g && g.satFolder ? satTree.value.find((s) => s.folder === g.satFolder) : null) || null
// 天线按键里自带的 folder 解析，不再钉在 satFolder 那一个节点上——树选星与本条目导入的方向图
// 因此能同时挂在各路天线上：「导入方向图」是纯添加，不作废已选树星的匹配。
const antByKey = (key) => {
  if (!key) return null
  const node = satTree.value.find((s) => s.folder === folderOfKey(key))
  if (!node) return null
  const a = node.antennas.find((x) => x.name === antNameOfKey(key))
  return a ? { node, ant: a, cfg: grdCfgs[key] } : null
}
// 工作台卫星分区第三行「方向图」：只读速览（与第二行「转发器」同款读数族）。
// 匹配本身在资源库「卫星」库的条目编辑器里改——方向图是卫星的属性，工作台只报当前接的是哪面天线。
// 只报接的是哪两面天线——星名不在这行重复出现：方向图属于「配置」行那颗星（选星时星名/轨位随之
// 回填），并排再报一个星名只会让人以为选了两颗星。不写说明句（口径进 title），只留两个状态标记：
//   stale    匹配还在、本机卫星树里没有这份 GRD（换机器/未导入）
//   mismatch 星名/轨位事后被手改得与所选 GRD 节点对不上——那才是真有两颗星，必须报出来
function grdFactsOf(sat) {
  const g = (sat && sat.grd) || null, node = grdNodeOf(g), f = (sat && sat.form) || {}
  const antName = (k) => (k ? antNameOfKey(k) : '')
  const eq = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
  let mismatch = ''
  if (node) {
    const drift = []
    if (f.satelliteName && !eq(f.satelliteName, node.satName)) drift.push(node.satName)
    if (f.orbitPosition !== '' && f.orbitPosition != null && node.lon != null && Math.abs(parseFloat(f.orbitPosition) - Number(node.lon)) > 0.05) drift.push(fmtGeoSlot(Number(node.lon)) || `${node.lon}°E`)
    if (drift.length) mismatch = '方向图属 ' + drift.join(' ')
  }
  // stale 逐路判：树选星与各面天线各有各的来源，只要有一路在本机卫星树里找不到就标出来
  const missing = (k) => !!(k && !antByKey(k))
  return {
    eirp: antName(g && g.eirpKey) || '—',
    gt: antName(g && g.gtKey) || '—',
    stale: !!(g && ((g.satFolder && !node) || missing(g.eirpKey) || missing(g.gtKey))),
    mismatch
  }
}
const grdFacts = computed(() => grdFactsOf(bandSat.value))
let _grdT = null
// —— 回填＝派生量：某行的卫星 EIRP / G·T 由【匹配的天线 + 采样吃的天线设置 + 卫星几何 + 本行取值站址】唯一决定 ——
// 这几项只要有一项变，本行该格立刻重算写回——不问那格是不是用户改过的：输入都变了，旧值必然对不上
// （口径同 NGSO/再生式的斜距 refreshSlant、端到端的 scanGeoSeeds）。格子空着也直接补上，故「清空该格」
// ＝恢复自动取值；等于字段缺省值（46 dBW / 2 dB/K）视同没填过，新建/重置场景选上带方向图的卫星即回填。
// grdMemo 逐行记两样东西，只活在本次会话（不入场景）：
//   fp   上次算过的那组输入（指纹，基底见 grdParam.grdFillBase）——载入场景时各行是新 _id、指纹尚未记过
//        ⇒ 只登记不改写，绝不覆盖存档里用户手改过的 EIRP / G·T（此前每次开窗都被自动取值冲掉）；
//   auto 本会话上次自动写进那格的值——顶栏「刷新」(force) 只重取【现在还是这个值】的格子：肯定没被用户碰过，
//        才按最新星位 / 天线重取。实时星位与 3D 页的绘制项刻意不进指纹（grdFillBase）：否则星位一漂、
//        改个等值线颜色，下次任何触发（加行 / 改站址）就把整列手改值冲掉。
const grdMemo = {}                     // { 行_id: { fp: { 字段key: 指纹 }, auto: { 字段key: 上次自动值 } } }
const memoOf = (r) => grdMemo[r._id] || (grdMemo[r._id] = { fp: {}, auto: {} })
const ROW_DEF = { ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS) }
// 一路天线 → 一列格子：antKeyOf 给该行这一路的天线键（配置级全表同一副，链路级按该行所用卫星各取各的），
// ptOf 给该列的取值站址（EIRP 取收端、G·T 取发端）。同一副天线的行并成一批采样，只对真正需要回填的行发 IPC。
// ★ 没匹配到天线时也照样登记指纹（base 为空串）：这样「本来没接天线、后来接上了」也算指纹变了，
//   照常回填——否则载入场景后再去卫星条目里选天线，那一列会一动不动。换星＝换天线＝指纹变，同理重取。
async function fillFromAnt(key, antKeyOf, ptOf, force) {
  const groups = new Map()   // 天线键 → { a, base, todo }
  for (const r of linkRows) {
    const antKey = antKeyOf(r) || ''
    let g = groups.get(antKey)
    if (!g) { const a = antByKey(antKey); g = { a, base: a ? grdFillBase(a.node, a.ant, a.cfg) : '', todo: [] }; groups.set(antKey, g) }
    const pt = ptOf(r)
    const fp = `${g.base}|${pt.lon},${pt.lat}`
    const m = memoOf(r)
    const prev = m.fp[key]
    m.fp[key] = fp
    if (g.a && grdFillNeeded(prev, fp, r[key], ROW_DEF[key], force, m.auto[key])) g.todo.push({ r, pt, prev })
  }
  for (const g of groups.values()) {
    if (!g.a || !g.todo.length) continue
    const vals = await sampleAntennaParams(g.a.node, g.a.ant, g.a.cfg, g.todo.map((t) => t.pt))
    g.todo.forEach((t, i) => {
      const v = vals && vals[i]
      const m = memoOf(t.r)
      // 没取到值（越地平 / IPC 失败）：指纹退回原样，当这次没发生过，下次输入再变还会重试
      if (v == null) { if (t.prev === undefined) delete m.fp[key]; else m.fp[key] = t.prev }
      else { t.r[key] = String(v); m.auto[key] = String(v) }
    })
  }
}
// 回填写进场景的值与手改一样随自动保存落盘（屏幕上是什么，盘上就是什么）；
// ★ 不许再在这里「推进基线」：自动保存下那等于把回填值标成已落盘，它就永远写不进去。
// force：顶栏「刷新」——本会话自动写过、现在还没被改的格子按最新星位 / 天线重取（见 grdFillNeeded）。
async function refreshGrdFill(force) {
  const f = force === true
  // 卫星EIRP 天线 → 各行收端经纬度取最大 Parameter，回填 rxEIRP；卫星G/T 天线 → 各行发端经纬度回填 G_Ts。
  // 天线按该行所用卫星取（配置级全表同一颗）。
  await fillFromAnt('rxEIRP', (r) => { const g = grdOfRow(r); return g && g.eirpKey }, (r) => ({ lon: parseFloat(r.rxLongitude), lat: parseFloat(r.rxLatitude) }), f)
  await fillFromAnt('G_Ts', (r) => { const g = grdOfRow(r); return g && g.gtKey }, (r) => ({ lon: parseFloat(r.longitude), lat: parseFloat(r.latitude) }), f)
  const ids = new Set(linkRows.map((r) => r._id))
  for (const k of Object.keys(grdMemo)) if (!ids.has(k)) delete grdMemo[k]   // 删掉的行不留底
}
function scheduleGrdFill() { clearTimeout(_grdT); _grdT = setTimeout(() => refreshGrdFill(false), 300) }

// —— 直接导入方向图（卫星库条目编辑器里的「导入方向图」）——
// 免去「先去星座3D页导入一趟」：选中的 GRD/PAT 由主进程按字节拷进 userData，挂在本卫星条目名下
// （folder = lb:<条目 id>，即「一个卫星配置＝一颗星」的那颗星），随后自动匹配到空着的那几路，
// 站表按各站经纬度回填。一个文件＝一副天线，文件内多个 set＝该天线的多波束（取值取多波束最大）。
// ★ 纯添加：既不改写树选星（satFolder），也不覆盖用户已匹配的天线——导进来的只是多了几个可选项。
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
      const keyOf = (a) => antKeyOf(folder, a.name)
      // 只填空位，不覆盖用户已匹配的：首个文件 → EIRP；有第二个 → G/T，只有一个则两路同一副天线
      if (!cfg.grd.eirpKey) cfg.grd.eirpKey = keyOf(r.added[0])
      if (!cfg.grd.gtKey) cfg.grd.gtKey = keyOf(r.added[1] || r.added[0])
      scheduleGrdFill()
      toast(`已导入 ${r.added.length} 副方向图：${r.added.map((a) => `${a.name}（${a.beams} 波束）`).join('、')}；已填入空着的天线位，可在下拉中改选`)
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
  // 只解除指向本条目导入天线的那几路；树选星与它的匹配不受影响
  if (cfg.grd) {
    if (cfg.grd.satFolder === folder) cfg.grd.satFolder = ''   // 存量数据：早期导入曾把树选星改写成本地节点
    for (const k of ['eirpKey', 'gtKey']) if (folderOfKey(cfg.grd[k]) === folder) cfg.grd[k] = ''
  }
  toast(`已删除 ${names.length} 副方向图`)
}
// 地理图的「卫星关联」（见 LbSpacePane / core 的 spec.geo）：站表回填只在各站那一个点上取方向图，
// 地理图是把站址铺成一整面，故同一支天线要逐格重采——卫星 G/T 随发信站站址变、卫星 EIRP 随
// 收信站站址变，两端各挂各的。仰角门限 GSO 不另设：定点星的覆盖边界就是地平线本身。
const geoLink = computed(() => {
  // 铺的是当前查看的那条链路：方向图取该行所用卫星的（配置级即场景单选那颗）
  const row = sel.value ? linkRows.find((r) => r._id === sel.value.rowId) : null
  const g = row ? grdOfRow(row) : curGrd.value
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
  // 本模块导入的方向图节点：星名/轨位以卫星库条目为准（条目改名/改轨位后，树里那颗星跟着变）。
  // 单向——条目是真值源，节点只是它的影子，故下面的回写循环会跳过 local 节点。
  // 逐条目无条件同步：节点不存在（本条目没导过方向图）时 syncLocalNode 自身是空操作。
  for (const c of satConfigs) {
    syncLocalNode({ folder: localFolderFor(c.id), satName: c.form.satelliteName || c.name, lon: parseFloat(c.form.orbitPosition), lat: 0, altKm: 35786 })
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
  // 实时星位同步改的是资源库（自动保存，不入场景）；★ 不在这里推进场景基线，理由同 refreshGrdFill
  // C5：主窗改了天线指向 / 极化 / 存活波束等采样设置后，grdCfgs 换了新的 → 回填跟上（地理场图经 geoLink 已跟）。
  // 非 force：指纹（grdParam.grdFillBase：天线文件 + 采样吃的设置 + 静态星位）没变的格子一个不动，手改值照留；
  // 指纹变了的格子输入已变、旧值必然对不上，照常重取。
  scheduleGrdFill()
}

// 顶栏「刷新」：重新拉取主窗口的最新设置（GRD 卫星树/各天线设置/实时星位 + 城市库/载波信号选项），并按最新数据重算
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  preview.suppress(true)    // 抑制下方表单/站点回填触发的 watcher，整套扇出最后只跑一次
  // 逐项取：某项失败不拦其余各项（取不到的保留原值），但不再一律报「已刷新」——失败的如实列出（A5）
  const failed = []
  let ok = 0
  const step = async (name, fn) => { try { await fn(); ok++ } catch (e) { failed.push({ name, error: e }) } }
  try {
    reloadSatTree()   // 重读 globe3d/settings.grd（树/天线 cfg）+ grdLive 实时位置（数据未变则复用缓存，不重解析 GRD）
    await step('城市库', async () => { const c = api && await api.linkBudget.cities(); if (c) cities.value = c })
    await step('载波信号选项', async () => { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b })
    // C4：引用了频率计划的卫星条目按计划现值重套（计划已删 / 转发器不在了：保留现值，计为失败）
    await step('频率计划', async () => { const r = await resyncFreqPlans(); if (r.failed.length) throw new Error(r.failed.map((f) => (f.name ? f.name + '：' : '') + f.error).join('；')) })
    await step('方向图回填', () => refreshGrdFill(true))   // 直接回填(跳过防抖)且 force：本会话自动写过的格子按最新星位重取，手改的不碰
    preview.suppress(false)   // 抑制期间挂起的计时器已随之丢弃
    await preview.refresh()   // 守卫解除后只跑一遍扇出
    if (failed.length) reportPartial('刷新最新设置', ok, failed)
    else toast('已刷新最新设置')
  } finally { preview.suppress(false); refreshing.value = false }
}

// —— 频率计划同步（C4）——
// 卫星条目引用了「计划 → 转发器」时，频段 / 上下行频率 / 极化 / 转发器带宽由计划托管（见 SatellitePanel）。
// 计划在频率计划窗口改了，这里按引用重新拉取并重套；解除过引用的条目不动。真有字段变了，资源库的深监听照常
// 亮「输入已变」（无需另起一套过期判据）。三个时机：收到 freqPlan:changed 广播、窗口获焦、点「刷新」。
// 串行：获焦与广播可能前后脚到，排队跑，后一次一定读到最新的计划。
let _fpChain = Promise.resolve()
function resyncFreqPlans() {
  const p = _fpChain.then(() => resyncAll(satConfigs))
  _fpChain = p.catch(() => {})
  return p
}
const _offFpChanged = (api && api.freqPlan && api.freqPlan.onChanged)
  ? api.freqPlan.onChanged(async () => {
    const r = await resyncFreqPlans()
    if (r.failed.length) reportPartial('频率计划同步', r.checked - r.failed.length, r.failed)
    else if (r.changed) toast(`已按频率计划更新 ${r.changed} 个卫星条目`)
  })
  : null
onBeforeUnmount(() => { if (typeof _offFpChanged === 'function') _offFpChanged() })

// 窗口获焦（单例窗口切回来）的另两件事（卫星树另有 reloadSatTree 那个监听）：按频率计划重套、
// 并入别的窗口「复制到」本库的条目
function onWinFocus() { resyncFreqPlans(); mergeLibFromDisk() }
// 别的链路预算窗口「复制到 GSO 库」写的是盘上的 library.json；本窗口内存里那份不知道，下次整写会把它冲掉。
// 故获焦时把盘上有、内存里没有、本会话也没删过的条目并进来（只认新增，见 shared/lbShare.js externalLibEntries）。
async function mergeLibFromDisk() {
  if (!_libLoaded || !api) return
  let lib = null
  try { lib = await api.store.getLibrary(LIB_NS) } catch (e) { return }   // 读不到就下次获焦再并，不打扰
  if (!lib) return
  const fresh = (kind, arr) => externalLibEntries(lib, kind, arr).filter((c) => !_libGone.has(c.id))
  const es = fresh('es', esConfigs), bb = fresh('carrier', basebandConfigs), sat = fresh('sat', satConfigs)
  for (const c of es) esConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('es', c), form: { ...defaultsFor(ES_FIELDS), ...c.form } })
  for (const c of bb) basebandConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('carrier', c), form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null, ...c.form } })
  for (const c of sat) satConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('sat', c), form: { ...defaultsFor(SAT_FIELDS), ...c.form }, grd: normGrd(c.grd) })
  const n = es.length + bb.length + sat.length
  if (n) toast(`资源库新增 ${n} 条`)
}
// 资源库条目「复制到 ▸ 其它窗口的库」（G4）：可否与原因由 shared/lbShare.js 判（字段结构兼容才放行）
const copyTargetsOf = (kind) => (cfg) => libCopyTargets(kind, LIB_NS, cfg)
async function copyLibTo(kind, cfg, ns) {
  try {
    const made = await copyLibEntry(api, kind, LIB_NS, ns, cfg)
    const w = LIB_WINDOWS.find((x) => x.ns === ns)
    toast(`${w ? w.doneLabel : '已复制'}：${made.name || cfg.name}`)
  } catch (e) { reportError('复制资源库条目', e) }
}
// 换卫星条目 / 改匹配天线 / 行经纬度变化 → 重算回填。值本身只看「空没空」（避免回填值再触发循环），
// 空了就补回自动取值——这就是「清空该格＝恢复自动取值」那一手的触发处。
const blankSig = (r, k) => (String(r[k] == null ? '' : r[k]).trim() === '' ? '1' : '0')
// 天线来源签名逐行拼：配置级各行同一颗星（随 satId / 该星的两路天线键变），链路级随各行「卫星」列与各自那颗星的天线键变
watch(() => [satScope.value, satId.value,
  linkRows.map((r) => { const g = grdOfRow(r); return (satLink.value ? (r.satelliteId || '') : '') + ':' + (g ? g.eirpKey + ':' + g.gtKey : '') }).join(';'),
  linkRows.map((r) => r.longitude + ',' + r.latitude).join(';'),
  linkRows.map((r) => r.rxLongitude + ',' + r.rxLatitude).join(';'),
  linkRows.map((r) => blankSig(r, 'rxEIRP') + blankSig(r, 'G_Ts')).join('')],
  scheduleGrdFill)
const sel = computed(() => links.value[selected.value] || null)
// 核心指标（详细预算首块）：取当前选中链路的完整结果
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))

// 供图表区「参数扫描」用的引擎入参：计算时按行原样留底（见 compute()），不在此处重新组装。
// 重新组装会与「输入已变」状态打架——用户算完又改了表单时，重组出来的是新参数，
// 扫描曲线就不再经过详细预算里正在显示的那一点了。留底则保证图、表、曲线永远同一次计算。
const sweepParamsByRow = ref({})
const selParams = computed(() => (sel.value ? (sweepParamsByRow.value[sel.value.rowId] || null) : null))

// —— SLA 建议（功能区「导出 › SLA」→ LbSlaDialog，纯逻辑在 shared/lbSla.js）——
// 建议值只从「本行真正送进引擎的那份入参 + 引擎出参」推导，与详细预算同源。
// ★ 弹窗自带链路下拉（slaIdx），与链路表的聚焦行（selected）分开走：填 SLA 不该把详细预算
//   和图表一起拽到别的链路上去。打开时对齐到当前聚焦行，之后各走各的。
// 采用值/勾选存在链路行上（row.sla），随场景与分享包自然带走；SLA 参数是场景级。
const slaParams = reactive({ ...DEFAULT_SLA_PARAMS })
const slaScanByRow = ref({})          // 会话态：可用度档位扫描（compute 后批量求得，不入存档）
const slaSunByRow = ref({})           // 会话态：日凌预计中断（惰性算，按入参哈希缓存，不入存档）
const slaOpen = ref(false)
const slaIdx = ref(0)
const slaLink = computed(() => links.value[slaIdx.value] || null)
const slaOpts = computed(() => links.value.map((l, i) => ({ i, label: `#${i + 1} ${l.txName} → ${l.rxName}` })))
const slaRow = computed(() => (slaLink.value ? linkRows.find((r) => r._id === slaLink.value.rowId) || null : null))
const slaLinkName = computed(() => (slaLink.value ? `${slaLink.value.txName} → ${slaLink.value.rxName}` : ''))
// 建议值必须出自「此刻这套输入」：没算过或输入已变，先算一遍再开（同 openAdvDlg）
async function openSlaDlg() {
  if (!(await ensureFreshResults())) return
  slaIdx.value = Math.min(Math.max(0, selected.value), Math.max(0, links.value.length - 1))
  slaOpen.value = true
  ensureSlaScan()
  refreshSlaSun()
}

// —— 日凌预计中断（免责事件，只 GSO 有）——
// 惰性：弹窗打开或导出报告时才算。一条链路两次 IPC（春分 + 秋分），按【入参哈希】缓存到会话态，
// 重算即作废（同 slaScanByRow 的生命周期）。算不出来就没有这一条 —— 没有就是没有。
// 入参一律取【留底入参 + 引擎出参】，与其余建议值同源（见 lbSla 头注口径①）。
function slaSunSpec(l) {
  const p = sweepParamsByRow.value[l.rowId]
  if (!p || !l.data) return null
  const n = (v) => { const x = parseFloat(v); return isFinite(x) ? x : null }
  const lat = n(l.data.rxLatitudeResult) !== null ? n(l.data.rxLatitudeResult) : n(p.linkParams.rxLatitude)
  const lon = n(l.data.rxLongitudeResult) !== null ? n(l.data.rxLongitudeResult) : n(p.linkParams.rxLongitude)
  const dia = n(p.linkParams.rxAntennaDiameter)
  const satLon = n(p.satParams.orbitPosition)
  const freq = n(p.linkParams.rxCenterFrequency)
  const sysTemp = n(l.data.systemNoiseTempKResult)
  if (lat === null || lon === null || !(dia > 0) || satLon === null || !(freq > 0)) return null
  // degThreshold 1 dB＝行业预报惯例口径（与日凌工具默认一致）
  return { lat, lon, satLon, diameter: dia, customFreq: freq, sysTemp: sysTemp > 0 ? sysTemp : 0, degThreshold: 1, year: new Date().getFullYear() }
}
async function refreshSlaSun() {
  if (!api || !api.sunOutage || !api.sunOutage.compute) return
  const jobs = []
  for (const l of links.value) {
    if (!l || !l.data) continue
    const spec = slaSunSpec(l)
    if (!spec) continue
    const key = JSON.stringify(spec)
    const had = slaSunByRow.value[l.rowId]
    if (had && had.key === key) continue
    jobs.push({ rowId: l.rowId, key, spec })
  }
  if (!jobs.length) return
  // 整表一次 IPC（主进程逐链路让出事件循环，见 sunoutage:computeBatch）；期间重算过（会话态已清）
  // 这批结果就作废，与档位扫描同一套代号判据
  const gen = _slaScanGen
  try {
    const res = api.sunOutage.computeBatch
      ? await api.sunOutage.computeBatch(jobs.map((j) => j.spec))
      : await Promise.all(jobs.map(async (j) => ({
        vernal: await api.sunOutage.compute({ ...j.spec, season: 'vernal' }),
        autumnal: await api.sunOutage.compute({ ...j.spec, season: 'autumnal' })
      })))
    if (gen !== _slaScanGen) return
    const next = { ...slaSunByRow.value }
    jobs.forEach((j, i) => {
      const r = res && res[i]
      if (!r) return
      next[j.rowId] = { key: j.key, sum: sunOutageSummary({ vernal: r.vernal, autumnal: r.autumnal }) }
    })
    slaSunByRow.value = next
  } catch (e) { /* 算不出就没有日凌那一行，其余条款不受影响 */ }
}
// 重算后链路可能变少：下标越界就退回第一条，免得弹窗里一片空白、看着像算漏了
watch(links, () => { if (slaIdx.value >= links.value.length) slaIdx.value = 0 })
// 频率计划核对：卫星条目引用了「计划 → 转发器」时才有；计划全文异步取，随引用变化重载。
// 卫星取弹窗正看着的那条链路所用的（配置级即场景单选那颗）
const slaSat = computed(() => (slaRow.value ? satOfRow(slaRow.value) : curSat.value))
const slaFpPlan = shallowRef(null)
watch(() => (slaSat.value && slaSat.value.grd ? slaSat.value.grd.fpId : ''), async (id) => {
  slaFpPlan.value = id ? await getPlan(id) : null
}, { immediate: true })
const slaFpCheck = computed(() => {
  const g = slaSat.value && slaSat.value.grd
  const d = slaLink.value && slaLink.value.data
  if (!slaFpPlan.value || !g || !g.fpNo || !d) return null
  const bw = parseFloat(d.allocBandwidthResult), fc = parseFloat(d.uplinkFrequencyResult)
  return checkAgainstChannel(slaFpPlan.value, g.fpNo, {
    occBwMHz: isFinite(bw) ? bw / 1000 : undefined,
    fcMHz: isFinite(fc) ? fc * 1000 : undefined,
    polUp: d.uplinkPolarizationResult || undefined,
    polDn: d.downlinkPolarizationResult || undefined
  })
})
// 逐链路的建议：弹窗看 slaLink 那一条（带频率计划核对），报告要全部（fp 恒 null）
function slaDerivedFor(l, fp) {
  if (!l || !l.data) return null
  const row = linkRows.find((r) => r._id === l.rowId)
  const form = row ? resolveBaseband(row.basebandId).form : {}
  return deriveSla({
    orbitType: 'GEO',
    data: l.data, ok: l.ok, error: l.error, resolvedMargin: l.resolvedMargin,
    params: sweepParamsByRow.value[l.rowId] || null,
    carrierForm: form,
    modcodRows: (basebandOpts.value.modcod || {})[form.dvbStandard] || [],
    scan: slaScanByRow.value[l.rowId] || null,
    sunOutage: (slaSunByRow.value[l.rowId] || {}).sum || null,
    fp: fp || null,
    slaParams
  })
}
const slaDerived = computed(() => slaDerivedFor(slaLink.value, slaFpCheck.value))
const slaCount = computed(() => links.value.reduce((n, l) => {
  const row = linkRows.find((r) => r._id === l.rowId)
  return n + (l.data && slaIncludeCount(slaDerivedFor(l), row && row.sla) ? 1 : 0)
}, 0))

// —— 独立《服务等级指标（SLA）》报告 ——
// 逐链路的附加料：载波体制（决定引用哪几份标准）/ MODCOD / 档位表（综合与中断按考核周期算好）/ 日凌预计窗口
function slaReportExtra(l) {
  const row = linkRows.find((r) => r._id === l.rowId)
  const f = row ? resolveBaseband(row.basebandId).form : {}
  return {
    carrierStd: f.dvbStandard || 'custom', modcod: f.modcodLabel || '',
    scan: slaScanReportRows(slaDerivedFor(l)),
    sunOutage: (slaSunByRow.value[l.rowId] || {}).sum || null
  }
}
function slaDefaultNameOf(en) {
  const s = sceneSatName.value
  return en
    ? `GEO_SLA_${(s || 'Results').replace(/[^\w-]+/g, '_')}`
    : `GEO服务等级指标_${(s || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
}
// row.sla 挂在链路行上，会被「结果过期」那条深监听盯到——但采用值是【结论】不是引擎入参，
// 改它一个字也不会让已出的结果失效。故写完把过期灯还原（深监听是 pre-flush，nextTick 时它已跑过）。
function slaTouch(fn) { const keep = resultsStale.value; fn(); nextTick(() => { resultsStale.value = keep }) }
function slaSetAdopt(e) { const r = slaRow.value; if (r) slaTouch(() => applyRowSla(r, setAdopt(r.sla, e.key, e.value))) }
function slaSetInclude(e) { const r = slaRow.value; if (r) slaTouch(() => applyRowSla(r, setInclude(r.sla, e.key, e.value))) }
function slaSetParam(e) { if (e.value != null) slaParams[e.key] = e.value }
function slaToggleAll(on) { const r = slaRow.value; if (r) slaTouch(() => applyRowSla(r, setAllInclude(r.sla, slaDerived.value, on))) }
// 「重置」两件事一起做：本条链路的采用值清空（回到建议值）+ SLA 参数回到缺省 ——
// 参数是场景级的，可它只在这个弹窗里露面，另设一颗按钮反而找不着。
function slaClear() {
  slaTouch(() => {
    const r = slaRow.value
    if (r) applyRowSla(r, clearAdopt(r.sla))
    Object.assign(slaParams, DEFAULT_SLA_PARAMS)
  })
}
const slaAllOn = computed(() => {
  const r = slaRow.value, d = slaDerived.value
  if (!r || !d) return true
  return d.order.every((k) => !(r.sla && r.sla.include && r.sla.include[k] === false))
})

// 图表区显示开关（功能区「视图 → 图表」）。关掉时详细预算只剩表：图表整块不渲染，
// 里头的扫描自然也不会跑——不出图还占着 CPU 逐格重算引擎是说不过去的。
const showViz = ref((() => { try { return localStorage.getItem('linkbudget/viz/show') !== '0' } catch (e) { return true } })())
watch(showViz, (v) => { try { localStorage.setItem('linkbudget/viz/show', v ? '1' : '0') } catch (e) { /* ignore */ } })
// 链路视图的场景：站址与轨位取本行送进引擎的那份入参，仰角/方位/斜距取本行算出的结果——
// 图与左边的表说的是同一条链路的同一组数（见 shared/lbLinkScene.js）
const linkScene = computed(() => buildGeoScene(sel.value, selParams.value))

// 单链路容量 = 频谱效率 η(bps/Hz) × 载波带宽 B(kHz) = 容量(kbps)；各链路载波信号配置可不同（η 各异），
// 故逐链路相乘再求和，而非用单一 η 乘总带宽。engine 已按链路输出 allocBandwidthResult / spectralEfficiencyResult。
// capacityKbpsOf 是单链路口径的唯一出处：列表/矩阵「容量」指标、容量汇总都从这里换算。
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult)       // 载波带宽 kHz
  const eta = parseFloat(d.spectralEfficiencyResult)  // 频谱效率 bps/Hz
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN   // 容量 kbps
}

// —— 容量汇总（功能区「导出 › 容量」→ LbCapDialog，纯逻辑在 shared/lbCapacity.js）——
// 一组＝一只转发器（一份卫星配置）：功率带宽 = 功率占用 × 本转发器带宽，只在组内求和、对照可用资源出剩余与
// 占用；表末合计只加能跨转发器相加的量。2026-10-16 起取代链路表表脚那一行（那里把各星的功率带宽直接相加）。
// 列入 / 载波数随行走（row.cap，由「非 _ 键全存」带上）；可用资源与单价是场景级一份（capParams.tp[卫星配置 id]）。
const capParams = reactive(normCapParams(null))
const capOpen = ref(false)
const capItems = computed(() => { const byRow = new Map(links.value.map((x) => [x.rowId, x])); return linkRows.map((row, i) => {
  const l = byRow.get(row._id) || null
  const d = (l && l.data) || null
  const sat = satOfRow(row)
  const satForm = (sat && sat.form) || {}
  return {
    no: i + 1, rowId: row._id,
    name: l ? `${l.txName} → ${l.rxName}` : ([row.earthStationLocation, row.rxEarthStationLocation].filter(Boolean).join(' → ') || byLang('链路 ' + (i + 1), 'Link ' + (i + 1))),
    carrier: resolveBaseband(row.basebandId).name || '',
    // 分组键＝卫星配置 id、组名取库条目名（与链路表「卫星」列的选项同名），口径同高级计算 advRows
    gkey: capKeySat(sat && sat.id), gname: sat ? (sat.name || satForm.satelliteName || sat.id) : '',
    // 转发器带宽取引擎回显（＝这一行真正算用的那份），没结果的行退到卫星条目
    tpBwMHz: parseFloat(d ? d.transponderBandwidthResult : satForm.transponderBandwidth),
    ok: !!(d && !l.error), error: l ? (l.error || '') : '',
    capKbps: capacityKbpsOf(d),
    bwKHz: d ? parseFloat(d.allocBandwidthResult) : NaN,
    pbwKHz: d ? parseFloat(d.PowerBWResult) : NaN,
    cap: row.cap || null
  }
}) })
// ★ 只在弹窗开着时喂给它（模板里 capOpen ? capModel : null）：prop 在父组件渲染时求值，常驻绑定会让
//   链路表每改一格都把整张账重算一遍；报告导出走 capFor 现取
const capModel = computed(() => buildCapModel(capItems.value, capParams, { pbw: CAP_PBW.SUM }))
// 汇总必须出自「此刻这套输入」：没算过或输入已变，先算一遍再开（同 SLA / 高级计算）
async function openCapDlg() {
  if (!(await ensureFreshResults())) return
  capOpen.value = true
}
// 列入 / 载波数挂在链路行上，会被「结果过期」那条深监听盯到——它们是汇总口径不是引擎入参，灯不该亮（同 slaTouch）
const capRowOf = (id) => linkRows.find((r) => r._id === id) || null
function capSetInclude(e) { const r = capRowOf(e.rowId); if (r) slaTouch(() => applyRowCap(r, setCapIncluded(r.cap, e.on))) }
function capSetCount(e) { const r = capRowOf(e.rowId); if (r) slaTouch(() => applyRowCap(r, setCapCount(r.cap, e.n))) }
function capSetParam(e) { setCapTpParam(capParams, e.key, e.field, e.value) }
function capToggleAll(on) { slaTouch(() => { for (const r of linkRows) applyRowCap(r, setCapIncluded(r.cap, on)) }) }
// 「重置」两件事一起做（同 SLA）：各行回到列入、1 路，可用资源与单价清空
function capReset() {
  slaTouch(() => { for (const r of linkRows) applyRowCap(r, null) })
  capParams.tp = {}
}

// —— 本行读数（链路表表脚，见 LbCapFoot）——
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
  for (const def of (m ? resultDefsOn.value : [])) {
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
  return { no: idx + 1, rowId: row._id, name, err: (link && link.error) || '', items }
})
// 「详细预算」节头那枚行号：由 sel 反算，与该节自己的摘要（站对名）同源。
// 不能照搬 rowReadout.no —— onRowFocus 只在该行**已算出结果**时才推进 selected，聚焦到一条尚未
// 计算的新行时详细预算画的仍是原来那条链路，两处编号本就该不同，同源才不会出现自相矛盾的节头。
const detailNo = computed(() => {
  const s = sel.value
  if (!s || !links.value.length) return 0
  return linkRows.findIndex((r) => r._id === s.rowId) + 1
})

// —— 计算前预校验（D6）——
// 数值格不是数、或越出字段范围（schema 的 min / max，口径见 shared/lbValidate.js）：引擎按前缀解析会静默算出错数，
// 故开算前先查一遍。坏行不送引擎、该行结果清空（详细预算里写明是哪一格）；通知条常驻列出前 3 处与总数。
// 返回 行下标 → 该行报因（没有坏格时为空 Map）。上一次的校验报错在这次全部合法时一并撤掉。
let _valNotice = ''
function preValidate(fields, rows, rowNo = (i) => i + 1) {
  // 只查用户录入的列：计算结果列 / 自定义公式列（ro，或 _ 前缀键）不是输入
  const bad = validateRows((fields || []).filter((f) => f && !f.ro && !String(f.key || '').startsWith('_')), rows)
  const byRow = new Map()
  for (const b of bad) { const t = b.label + '：' + b.msg; byRow.set(b.row, byRow.has(b.row) ? byRow.get(b.row) + '；' + t : t) }
  if (bad.length) {
    _valNotice = bad.slice(0, 3).map((b) => `第 ${rowNo(b.row)} 行 · ${b.label}：${b.msg}`).join('；') + `；共 ${bad.length} 处`
    toastError(_valNotice)
  } else if (_valNotice) {
    if (N.notice.value === _valNotice) N.clearNotice()
    _valNotice = ''
  }
  return byRow
}
async function compute() {
  if (!api) { error.value = '引擎需在桌面客户端中运行'; return }
  if (!linkRows.length) { error.value = '暂无链路。'; return }
  computing.value = true; error.value = ''
  try {
    // 开算前先让已排队的「输入已变」监听跑完（点「计算」之前那一笔改动不算「期间」），再记输入代次
    await nextTick()
    const gen0 = _inGen
    // 行快照：批量 IPC 回来时按开算那一刻的行序对号（期间增删 / 挪行，结果也不会套到别的行上）
    const rows = linkRows.slice()
    // D6：数值格预校验——坏行不送引擎，该行结果清空并写明是哪一格；其余行照算
    const badRows = preValidate(gridFields.value, rows)
    const out = []
    const sweepStore = {}
    // 先把整表各行的入参组齐，再一次 IPC 连算完：逐行口径与单条调用完全一致，
    // 只是把「行数」次主进程往返压成一次（批量入口不可用时自动逐行回退）。
    const specs = []
    const specAt = []   // 行下标 → 该行送算的 spec（坏行没有）
    for (let i = 0; i < rows.length; i++) {
      if (badRows.has(i)) continue
      const row = rows[i]
      const txEs = resolveEs(row.stationId).form
      const bbForm = resolveBaseband(row.basebandId).form
      // 站址经纬度留空的一侧：R0.01% / 海拔也留空时按默认站址的 ITU 取值入算（其余行原样，入参逐位不变）
      const site = withDefaultSite(row, defSite.value)
      const { satParams, linkParams } = buildParams(satOfRow(row).form, bbForm, site, site, txEs, resolveEs(row.rxStationId).form)
      // 计算方式与系统余量/超发量随该行所选载波；「设置功放功率」另取发端站型的功放功率（站的硬件属性）
      const opt = calcOptOf(bbForm, txEs)
      // 留底本行真正送进引擎的那份入参，供图表区参数扫描原地重跑（见 selParams）
      sweepStore[row._id] = { satParams, linkParams, opt }
      specAt[i] = { sat: satParams, link: linkParams, opt }
      specs.push(specAt[i])
    }
    const res = !specs.length ? [] : api.linkBudget.computeModeBatch
      ? await api.linkBudget.computeModeBatch(specs)
      : await Promise.all(specs.map((s) => api.linkBudget.computeMode(s.sat, s.link, s.opt)))
    // 批量结果按 specs 的次序回来，摊回行下标（坏行那几格留空）
    const results = []
    { let k = 0; for (let i = 0; i < rows.length; i++) if (specAt[i]) results[i] = res && res[k++] }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const txName = siteNameOf(row, 'earthStationLocation', gridFields.value, i, '发')
      const rxName = siteNameOf(row, 'rxEarthStationLocation', gridFields.value, i, '收')
      const base = { i, rowId: row._id, txName, rxName }
      if (badRows.has(i)) { out.push({ ...base, data: null, error: badRows.get(i) }); continue }
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
        const ok = specAt[i].opt.mode === 'margin' ? (!(pUse > 100) && !(bUse > 100)) : (!isNaN(m) && m >= 0)
        // resolvedMargin＝求解器最终喂给引擎的余量（功带平衡等方式下由它解出）。留全精度原值：
        // 高级计算的组配平要拿它做归一化基准，data.marginResult 已按显示精度截成 2 位小数。
        out.push({ ...base, data: d, ok, resolvedMargin: r.resolvedMargin })
      } else {
        out.push({ ...base, data: null, error: (r && r.message) || '失败' })
      }
    }
    // 算的途中被删掉的行不留结果（行快照里还有它们）：链路列表、容量汇总、详细预算只认表里还在的行
    const live = new Set(linkRows.map((r) => r._id))
    for (let k = out.length - 1; k >= 0; k--) if (!live.has(out[k].rowId)) out.splice(k, 1)
    sweepParamsByRow.value = sweepStore
    const prevSel = sel.value
    links.value = out
    writeResultVals(out)
    // 计算后保持当前查看位置（按行 _id 定位；行数变化则夹取原下标），不跳回第一条
    // 聚焦行有结果就对到聚焦行：表脚「本行读数」与「详细预算」节头讲的是同一行（新加两行、聚焦第 3 行再算，不再一个 #3 一个 #1）
    let keepIdx = focusRowId.value ? out.findIndex((l) => l.rowId === focusRowId.value) : -1
    if (keepIdx < 0) keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    resultsStale.value = _inGen !== gen0   // 算的途中输入又变了：这批结果对应的是开算那一刻，灯保持亮
    await loadWaterfall()
    // SLA 档位扫描只在用得着时跑（弹窗开着；导出含 SLA 的报告前由 beforeSla 现补，见 ensureSlaScan），
    // 且不 await：每行 9 档 = 9 次引擎重算，跟着每次「计算」全表跑等于把普通计算拖慢一个量级、还占着「计算中」
    invalidateSlaScan()
    if (slaWanted()) ensureSlaScan()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

// SLA 可用度档位扫描：整表一次批量 IPC（逐档钉住当前工作点重算，见 core 的 scanSlaTiers）。
// 会话态、不入存档；随结果一起过期（重算即作废，下次用得着时再扫），切「单位」档不重扫（档位只管显示）。
// ★ 出 IPC 前必须现造纯数据：Vue 的 Proxy 过不了结构化克隆，invoke 当场抛且无 catch 时全静默。
let _slaScanGen = 0, _slaScanDone = -1, _slaScanRun = null, _slaScanRunGen = -1
function invalidateSlaScan() { _slaScanGen++; slaScanByRow.value = {}; slaSunByRow.value = {} }
// ★ 只认弹窗开着。别拿 slaCount 当闸：includeOf 缺键即「入报告」，任何算出结果的行都算勾了条款，
//   slaCount 恒等于有结果的行数 → 闸恒开，每次「计算」都全表 9 档扫一遍（2026-09-07 深审 #3）。
//   档位表与 MIR 之外没有别的消费者：导出含 SLA 的报告走 beforeSla 现补，弹窗打开时 ensureSlaScan。
const slaWanted = () => slaOpen.value
// 把当前这批结果的档位表补齐（已齐就直接返回）；弹窗打开、导出报告前调
async function ensureSlaScan() {
  if (_slaScanDone === _slaScanGen) return
  if (_slaScanRun) {
    if (_slaScanRunGen === _slaScanGen) return _slaScanRun
    await _slaScanRun                      // 上一批的扫描还没完：等它落地再按现在这批重扫
    return ensureSlaScan()
  }
  const gen = _slaScanGen
  _slaScanRunGen = gen
  _slaScanRun = refreshSlaScan(links.value, sweepParamsByRow.value, gen).finally(() => { _slaScanRun = null })
  return _slaScanRun
}
async function refreshSlaScan(out, store, gen) {
  if (!api || !api.linkBudget.slaScanBatch) return
  const jobs = []
  for (const l of out) {
    if (!l || !l.data) continue
    const p = store[l.rowId]
    if (!p) continue
    // 同站回环（场景参数勾了且发收站同址）：样本两侧同取该档，与建议值同一模型
    const samples = slaSamplesFor({ up: l.data.uplinkAvailabilityResult, dn: l.data.downlinkAvailabilityResult, sameSite: slaLoopback(slaParams, l.data, p) })
    if (!samples.length) continue
    jobs.push({ rowId: l.rowId, spec: { engine: 'geo', satParams: p.satParams, linkParams: p.linkParams, opt: p.opt, samples } })
  }
  if (!jobs.length) { if (gen === _slaScanGen) _slaScanDone = gen; return }
  try {
    const res = await api.linkBudget.slaScanBatch(JSON.parse(JSON.stringify(jobs.map((j) => j.spec))))
    if (gen !== _slaScanGen) return        // 期间又算过一轮：这份已过期
    const m = {}
    jobs.forEach((j, i) => { if (res && res[i]) m[j.rowId] = res[i] })
    slaScanByRow.value = m
    _slaScanDone = gen
  } catch (e) { /* 扫不出就不出档位表与 MIR，结果本身不受影响 */ }
}

// MODCOD 列：本行载波从 MODCOD 库里选的那一档（名字可自定义），且与引擎回显的调制 / 码率仍一致才用它；
// 否则（自定义体制、或选完又手改过调制 / 码率）按「调制方式 + FEC 码率」拼出来
// rowOf：批量回填时传进来的「行 id → 行」查表（取第一个同 id 的行，同 find 口径）；单条调用照旧线性找
function modcodNameOf(rowId, d, rowOf) {
  const row = rowOf ? rowOf.get(rowId) : linkRows.find((r) => r._id === rowId)
  const f = row ? resolveBaseband(row.basebandId).form : null
  const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
  const mc = f && f.modcodLabel ? ((basebandOpts.value.modcod || {})[f.dvbStandard] || []).find((r) => r.label === f.modcodLabel) : null
  if (mc && same(mc.modulation, d.modulationResult) && same(mc.fec, d.fecResult)) return mc.label
  return [d.modulationResult, d.fecResult].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(' ') || '—'
}
// 结果列写回 computedVals（全部 RESULT_DEFS 都算：事后勾选新列即刻可见，无需重算）。
// 写入前按整列共选显示单位（见 resColUnits），值与列头单位一致——「单位」档锁定时 pickColumn
// 恒返回 null，于是整列留在引擎基准单位上。切档位不必重算引擎，拿 links 原样再走一遍这里即可。
function writeResultVals(out) {
  const colVal = (d, def) => (def.key === 'capacityMbps' ? capacityKbpsOf(d) / 1000 : parseFloat(d && d[def.key]))
  const colAd = {}
  for (const def of RESULT_DEFS) {
    if (!def.unit) continue
    const p = pickColumn(out.map((l) => (l.data ? colVal(l.data, def) : NaN)), def.unit)
    if (p) colAd[def.key] = p
  }
  resColUnits.value = Object.fromEntries(Object.entries(colAd).map(([k, p]) => [k, p.unit]))
  // 原来逐行 setVals（每行整份复制 computedVals）+ 逐行 linkRows.find —— 两处都是 O(N²)，千行表回填一秒多。
  // 改成先查表、各行补丁攒成一份（同 id 多次照序合并），末尾一次 patchVals：结果与逐行写逐字节相同
  const rowOf = new Map()
  for (const r of linkRows) if (!rowOf.has(r._id)) rowOf.set(r._id, r)
  const batch = {}
  for (const l of out) {
    const d = l.data
    const patch = {}
    for (const def of RESULT_DEFS) {
      if (!d) { patch['_' + def.key] = '—'; continue }
      const ad = colAd[def.key]
      if (def.key === 'capacityMbps') {
        const mbps = colVal(d, def)
        patch._capacityMbps = !isFinite(mbps) ? '—' : ad ? fmtScaled(ad.conv(mbps)) : mbps.toFixed(3)
      } else if (def.key === 'modcodResult') {
        patch._modcodResult = modcodNameOf(l.rowId, d, rowOf)
      } else {
        const v = d[def.key]
        const n = parseFloat(v)
        patch['_' + def.key] = (v === undefined || v === null || v === '') ? '—' : (ad && isFinite(n)) ? fmtScaled(ad.conv(n)) : v
      }
    }
    batch[l.rowId] = { ...(batch[l.rowId] || null), ...patch }
  }
  patchVals(batch)
}
// 功能区「单位」档改动（本窗切换或别的链路预算窗改的）：结果列就地重排 + 详细预算重取一次。
// 不碰引擎——档位只管显示，数值一个没变。
let _offUnitMode = null
onMounted(() => { _offUnitMode = onUnitModeChange((v) => { unitAdaptive.value = v; if (links.value.length) writeResultVals(links.value); loadWaterfall() }) })
onBeforeUnmount(() => { if (_offUnitMode) _offUnitMode() })

async function loadWaterfall() {
  const l = sel.value
  if (!l || !l.data) { segments.value = []; return }
  const segs = await api.linkBudget.waterfall({
    results: JSON.parse(JSON.stringify(l.data)), lang: reportLang.value, orbitType: 'GEO',
    adaptUnits: isUnitAdaptive(),
    txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '')
  })
  // 等回包期间换了链路 / 换了配置（结果已清）：这份是上一条的，不往上贴
  if (sel.value === l) segments.value = segs
}
// 「详细预算」节头上一条 / 下一条、序号格右键「查看详细预算」：切到第 i 条链路的详细预算，聚焦行一并跟过去
function showDetailAt(i) {
  if (i < 0 || i >= links.value.length) return
  focusRowId.value = links.value[i].rowId
  if (i !== selected.value) { selected.value = i; loadWaterfall() }
}
function stepDetail(d) { showDetailAt(selected.value + d) }
const linkIdxOfRow = (rows, i) => (rows[i] ? links.value.findIndex((l) => l.rowId === rows[i]._id) : -1)
function viewDetailOfRow(rows, i) {
  const k = linkIdxOfRow(rows, i)
  if (k < 0) return
  showDetailAt(k)
  nextTick(() => { const el = document.querySelector('[data-sec="detail"]'); if (el) el.scrollIntoView({ block: 'start' }) })
}
const detailMenuItem = (rows) => ({ label: '查看详细预算', icon: 'file-text', disabled: (i) => linkIdxOfRow(rows, i) < 0, run: (i) => viewDetailOfRow(rows, i) })
// 链路表聚焦行变化 → 表脚「本行读数」跟随（无结果的新行也跟）；有结果时详细预算一并切到该行链路
function onRowFocus(idx, rowId) {
  focusRowId.value = rowId
  if (!links.value.length) return
  const i = links.value.findIndex((l) => l.rowId === rowId)
  if (i >= 0 && i !== selected.value) { selected.value = i; loadWaterfall() }
}

// —— 高级计算：多载波功带平衡（VSAT 组网）——
// 单链路的功带平衡只看自己，而转发器上跑的是一组载波：前向 TDM 超发、返向 TDMA 欠发，各自都不平衡，
// 合起来 Σ功率带宽 = Σ载波带宽 才是要的结果。求解在核心
// 算法外层（shared/advBalance.js，闭式解），结果落成各载波的「设置余量」，再照常走一次正常计算——
// 屏幕上的每个数仍然出自引擎本身，这里只决定喂进去的余量。
const advDlg = reactive({ open: false, busy: false })
const advRemap = ref(null)   // 上一次应用的 { group: 卫星配置 id, map: { 原载波id: 派生副本id } }，回传给对话框
// 送进对话框的候选链路：全部行 + 各自上一次的计算结果（载波带宽/功率带宽/实际余量）。
// 功带平衡只在同一只转发器上成立：每行带上所用卫星配置（satKey / satName）与那只转发器的带宽，对话框按星分组、
// 一次配一组——统一指定时全表同一颗星即一组；逐链路指定时表里用了几颗星就几组。
const advRows = computed(() => linkRows.map((row, i) => {
  const bb = resolveBaseband(row.basebandId)
  const l = links.value.find((x) => x.rowId === row._id) || null
  const d = (l && l.data) || null
  const name = l ? `${l.txName} → ${l.rxName}`
    : ([row.earthStationLocation, row.rxEarthStationLocation].filter(Boolean).join(' → ') || '链路 ' + (i + 1))
  const marginDb = d ? (isFinite(l.resolvedMargin) ? l.resolvedMargin : parseFloat(d.marginResult)) : NaN
  // 组网语义：功放（此刻实算值 + 发端站型预设）、转发器回退——都从行与上一次结果现取，不另跑引擎；卫星取该行所用的
  const sat = satOfRow(row)
  const satForm = (sat && sat.form) || {}
  return {
    no: i + 1, rowId: row._id, name, carrierId: bb.id, carrierName: bb.name,
    // 分组键＝卫星配置 id，显示名取库条目名（与链路表「卫星」列的选项同名；同一颗星的不同转发器配置也分得开）
    satKey: sat ? sat.id : '', satName: sat ? (sat.name || satForm.satelliteName || sat.id) : '',
    // 转发器带宽：取引擎回显（＝这一行真正算用的那份），没结果的行退到卫星条目
    tpBwMHz: parseFloat(d ? d.transponderBandwidthResult : satForm.transponderBandwidth),
    bwKHz: d ? parseFloat(d.allocBandwidthResult) : NaN,
    pbwKHz: d ? parseFloat(d.PowerBWResult) : NaN,
    marginDb,
    // 基准余量：本功能上一轮自己写进去的余量不算「当前」（含着那一轮的偏置，再当基准就一轮叠一层）
    baseDb: advBaseMargin(bb.form, marginDb),
    error: l ? (l.error || '') : '未计算',
    paW: d ? parseFloat(d.paRecommendation) : NaN,
    paPresetW: parseFloat(resolveEs(row.stationId).form.paPowerW),
    booDb: parseFloat(satForm.BOo), boiDb: parseFloat(satForm.BOi)
  }
}))
// 结果是否对应「此刻这套输入」：没算过、输入已变、有行还没结果 → 补算一遍。
// 正在算（用户刚点过「计算」）就等它算完再判，不并发再起一轮。返回 false = 补算失败（报错已写进 error）。
function computeIdle() {
  if (!computing.value) return Promise.resolve()
  return new Promise((res) => { const stop = watch(computing, (v) => { if (!v) { stop(); res() } }) })
}
async function ensureFreshResults(step) {
  await computeIdle()
  if (links.value.length && !resultsStale.value && links.value.length === linkRows.length) return true
  if (step) step(reportLang.value === 'en' ? 'Computing…' : '计算…', 0, 1)
  await compute()
  return links.value.length > 0 && !resultsStale.value
}
// 参考态必须是「此刻这套输入」算出来的：没算过或输入已变，先算一遍再开
async function openAdvDlg() {
  if (!(await ensureFreshResults())) return
  advDlg.open = true
}
// 落地：把解出的余量写进载波配置的「设置余量」，随后重算全表。写进哪一份由 planAdvWriteback 定
// （纯函数）：一律派生专用副本、用户原来的载波配置一字不动，反复配平复用同一份副本。
// rows 给全表（含别的卫星上的行）：同一份载波被另一颗星的行引用着，就得派生而不是就地改成本组的余量。
async function applyAdvPlan(plan) {
  const { ops } = planAdvWriteback({
    carriers: plan.carriers, rowIds: plan.rowIds,
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
  advRemap.value = { group: plan.group, map: remap }   // 载波换了 id：把对话框里这一组的偏置一并搬过去
  advDlg.busy = true
  try { await compute() } finally { advDlg.busy = false }
  toast(`已按「VSAT 组网平衡」口径配平 ${plan.rowIds.length} 条链路`
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

// —— 主窗口带上下文打开（地图右键 / 卫星信息栏「分析 ▸ GSO 链路预算」）——
// 载荷 { sat?, sites? } 已由主进程清洗。口径：只追加、不改动现有配置——
//   带星：库里找同一颗（天线树 folder → 星名），没有就新建条目（有天线树节点就挂上，方向图匹配随之可用）；
//         当前配置统一指定的正是这颗星、或是逐链路指定 → 就地追加；否则新建一份配置承接，原配置一字不动。
//   带站：按 role 写发 / 收一侧（both = 收发同站），对侧留白（灰显默认站址、引擎按默认算，同「导入站址」口径），
//         经纬度落地后联动 autoGeo 补降雨 / 海拔。新建配置里那条出厂默认行由站址行顶替。
// 开窗时配置还没载入：先排队，onMounted 载入完再按序处理（_ctxChain 保证一次只处理一份）。
const TX_SITE = { kind: 'tx', name: 'earthStationLocation', lon: 'longitude', lat: 'latitude', alt: 'altitude', rain: 'rainRate' }
const RX_SITE = { kind: 'rx', name: 'rxEarthStationLocation', lon: 'rxLongitude', lat: 'rxLatitude', alt: 'rxAltitude', rain: 'rxRainRate' }
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
// 失败不再静默（A5）：从地图带对象进来没成，通知条常驻报因
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
const ctxNameKey = (s) => String(s || '').trim().toLowerCase()
function satEntryForCtx(s) {
  const node = s.folder ? satTree.value.find((n) => n.folder === s.folder) : null
  const names = [s.name, node && node.satName].map(ctxNameKey).filter(Boolean)
  const hit = (node && satConfigs.find((c) => c.grd && c.grd.satFolder === node.folder)) ||
    satConfigs.find((c) => names.includes(ctxNameKey(c.form.satelliteName)))
  if (hit) return hit
  const cfg = makeSatConfig()
  if (node) {   // 与资源库「从天线树取星」同口径：星名 / 轨位跟树节点，方向图匹配随之可用
    cfg.grd.satFolder = node.folder; cfg.form.satelliteName = node.satName; cfg.form.orbitPosition = String(node.lon)
  } else {
    if (s.name) cfg.form.satelliteName = s.name
    if (s.slotLon != null) cfg.form.orbitPosition = String(Math.round(s.slotLon * 100) / 100)
  }
  satConfigs.push(cfg)
  syncAutoNames(satConfigs, 'sat')
  return satConfigs[satConfigs.length - 1]
}
// 站址行：整行留白（同 StationGrid 新增行），只写 role 指的那一侧（site 为空 = 两侧都留白）
function rowFromSite(site, satEntry) {
  const r = {}
  for (const f of [...TX_FIELDS, ...RX_FIELDS]) r[f.key] = ''
  r._id = 's' + (_sid++)
  const sides = !site ? [] : site.role === 'rx' ? [RX_SITE] : site.role === 'both' ? [TX_SITE, RX_SITE] : [TX_SITE]
  for (const g of sides) { r[g.name] = site.name || ''; r[g.lon] = String(site.lon); r[g.lat] = String(site.lat) }
  if (satEntry && satLink.value) r.satelliteId = satEntry.id
  return r
}
// 落站址。配对口径同「导入站址」：只写一侧的站先填进【这一侧留白、对侧已有站】的行（上一回只带了发信站 / 收信站
// 的那行），填满才新增——右键 A 站「发信站」、再右键 B 站「收信站」，得到的是一条 A→B 链路而不是两条半截的。
// 新建的配置：整表换成站址行（顶掉出厂默认行）。
const siteBlank = (r, g) => [g.name, g.lon, g.lat].every((k) => r[k] == null || String(r[k]).trim() === '')
function placeSites(sites, entry, fresh) {
  if (fresh) linkRows.splice(0, linkRows.length)
  for (const s of sites) {
    const g = s.role === 'rx' ? RX_SITE : s.role === 'both' ? null : TX_SITE
    const og = g === TX_SITE ? RX_SITE : TX_SITE
    let row = g ? linkRows.find((r) => siteBlank(r, g) && !siteBlank(r, og) && (!entry || !satLink.value || r.satelliteId === entry.id)) : null
    if (row) { row[g.name] = s.name || ''; row[g.lon] = String(s.lon); row[g.lat] = String(s.lat) }
    else { linkRows.push(rowFromSite(s, entry)); row = linkRows[linkRows.length - 1] }   // 取回响应式代理：autoGeo 异步回填才触发重绘
    if (s.role !== 'rx') autoGeoRow(row, undefined, 'tx')
    if (s.role === 'rx' || s.role === 'both') autoGeoRow(row, undefined, 'rx')
  }
}
async function applyToolContext(c) {
  if (!c) return
  if (c.links) {   // 图上链路（见下方 importChains）；只带链路时到此为止，不落进下面「载入卫星」那句提示
    await importChains(c.links)
    if (!c.sat && !(c.sites && c.sites.length)) return
  }
  const entry = c.sat ? satEntryForCtx(c.sat) : null
  const sites = c.sites || []
  let fresh = false
  if (entry && !satLink.value && !(curSat.value && curSat.value.id === entry.id)) {
    const before = activeId.value
    await addBlankConfig(null)
    if (!activeId.value || activeId.value === before) return   // 没建成（未激活 / 写盘失败未离开）：不动现场
    satId.value = entry.id
    fresh = true
  }
  if (sites.length) placeSites(sites, entry, fresh)
  else if (entry && satLink.value) {
    linkRows.push(rowFromSite(null, entry))   // 逐链路指定 + 只带星：添一行用这颗星的链路，两侧站址留白
  }
  const who = entry ? (entry.form.satelliteName || entry.name) : ''
  toast(sites.length
    ? byLang(`已添加 ${sites.length} 条链路${who ? '（' + who + '）' : ''}`, `Added ${sites.length} link${sites.length === 1 ? '' : 's'}${who ? ' (' + who + ')' : ''}`)
    : byLang(`已载入卫星：${who}`, `Satellite loaded: ${who}`))
}
const _stopCtx = api && api.tools && api.tools.onContext ? api.tools.onContext(onToolContext) : null
onBeforeUnmount(() => { if (_stopCtx) _stopCtx() })

// —— 回主窗口（C3）：计算窗 → 主窗口的反向通道（主进程 scene:cmd 中继，主窗被提到前台）——
// 载荷出 IPC 前现造纯数据（Vue 的 Proxy 过不了结构化克隆）。老主进程没有这条通道时不出这些入口。
const sceneApi = api && api.scene && api.scene.cmd ? api.scene : null
function sceneCmd(cmd, payload) {
  if (!sceneApi) return Promise.resolve(false)
  return Promise.resolve(sceneApi.cmd(cmd, JSON.parse(JSON.stringify(payload || {})))).catch((e) => { reportError('在主窗口定位', e); return false })
}
// 某行发 / 收一侧的站址（经纬度都是有效数才算）
function rowSite(row, g) {
  const lat = parseFloat(row && row[g.lat]), lon = parseFloat(row && row[g.lon])
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, name: String(row[g.name] || '') } : null
}
// 链路表行右键「在主窗口定位」：聚焦该行所用的卫星，画面正对发信站（发信站没填站址就正对收信站）
async function locateRowInMain(i) {
  const row = linkRows[i]
  if (!row) return
  const sat = satOfRow(row)
  const node = grdNodeOf(sat && sat.grd)
  const nm = String((sat && sat.form.satelliteName) || (node && node.satName) || '').trim()
  const name = isSatNamePlaceholder(nm) ? '' : nm   // 出厂占位名「Satellite」不是哪颗星
  const norad = node && node.noradId != null ? node.noradId : undefined
  if (name || norad !== undefined) await sceneCmd('focusSat', { norad, name })
  const site = rowSite(row, TX_SITE) || rowSite(row, RX_SITE)
  if (site) await sceneCmd('faceLonLat', site)
}
const rowMenuExtra = [detailMenuItem(linkRows), ...(sceneApi ? [{ label: '在主窗口定位', icon: 'locate-fixed', run: (i) => { locateRowInMain(i) } }] : [])]
// 表格 Excel 导入 / 导出完成（StationGrid 的 xlsxDone）：导出回执带「打开 · 在文件夹中显示」，导入报行数
function onXlsxDone(e) {
  if (!e) return
  if (e.kind === 'export') toastFile('已导出 Excel', e.path || '')
  else if (e.kind === 'import') toast(`已导入 ${e.rows} 行`)
}

// —— 整窗拖入 .lbcfg（G1）：与「分享 › 导入 › 文件」同一条导入流水线 ——
// dragover 阶段拿不到文件名，只认「拖的是文件」；落下时按扩展名分流，不认识的类型在通知条报一句。
// 窗口内部的拖动（配置树、结果列、表格）不带 Files，不拦；子组件已经接住的（defaultPrevented）也不再管。
const shareRef = ref(null)
const isFileDrag = (e) => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
function onWinDragOver(e) {
  if (e.defaultPrevented || !isFileDrag(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'copy'
}
async function onWinDrop(e) {
  if (e.defaultPrevented || !isFileDrag(e)) return
  e.preventDefault()
  const f = e.dataTransfer.files && e.dataTransfer.files[0]
  if (!f) return
  const m = /\.([^.\\/]+)$/.exec(f.name || '')
  const ext = m ? m[1].toLowerCase() : ''
  if (ext !== 'lbcfg' && ext !== 'json') { toast('不支持的文件类型：' + (ext ? '.' + ext : (f.name || ''))); return }
  let text = ''
  try { text = await f.text() } catch (err) { reportError('读取拖入的文件', err); return }
  await openShareDlg()
  await nextTick()
  if (shareRef.value) shareRef.value.importText(text, f.name)
}

// —— 导入图上链路（星座 3D 主窗建的 STK Chain 式单向链路：链路表「导入链路」对话框拉取 / tool:open 的 ctx.links 推送）——
// 本窗只收「地球站 → 透明转发 GEO 星 → 地球站」三节点链路，其余计数跳过（载荷形状见 packages/core/models/mapLinks.mjs）。
// 口径同上方带上下文打开：只追加，既有链路行与库条目一字不动——
//   星：satEntryForCtx 库里找同一颗、没有就新建条目；同一批里同一颗星（satKey）只解一次。
//   配置：逐链路指定 → 就地追加，各行写「卫星」列；统一指定且本配置用的正是这批里唯一那颗 → 就地追加；
//         否则新建一份配置承接（一颗星 → 统一指定选它；多颗 → 逐链路指定），新配置自带的出厂默认行由导入行顶替。
//         就地追加时表里只有一条没动过的出厂默认行，同样顶替。
//   站：一条链路 = 一行，发 / 收两侧取链首 / 链尾地球站的站名与经纬度（其余留白，同站址行），联动 autoGeo 补降雨 / 海拔；
//       站带天线口径 / 天线罩 → 按站型对号地球站库（shared/lbStationType.js），否则两侧引用同新增行（发端缺省、收端库第二份）。
// 对话框那条入口也走 onToolContext 的队列：配置还没载入就排队，与主窗推来的上下文一次只处理一份。
const linkImpOpen = ref(false)
const onLinkImport = (list) => onToolContext({ links: list })
const ES_LOSS_KEYS = { up: 'uplinkOtherLoss', dn: 'downlinkOtherLoss' }   // 带罩时罩损并进上 / 下行「其他损耗」
// 站型对号 → { id, made } | null（站没带口径 / 罩：调用方沿用该侧原引用）。新条目当场落库（id 规则同 duplicateEsConfig）
// 并取回响应式代理：同一批里下一个同口径同罩的站就命中它，不再另建一份。罩损档位取该行所用卫星的上 / 下行频率。
function esRefForSite(site, prefer, sat, tx) {
  const f = (sat && sat.form) || {}
  const t = esStationType(esConfigs, {
    diaM: Number(site && site.diaM), radome: !!site && site.radome === true, prefer,
    lossKeys: ES_LOSS_KEYS, freq: { up: Number(f.centerFrequency), dn: Number(f.rxCenterFrequency) },
    powerW: tx && site ? Number(site.pwrW) : null, powerKey: 'paPowerW'   // 功放功率只对发端站有意义
  })
  if (!t) return null
  if (t.hit) return { id: t.hit.id, made: false }
  esConfigs.push({ id: 'es' + (_esSeq++), name: t.make.name, nameAuto: t.make.nameAuto, form: t.make.form })
  syncAutoNames(esConfigs, 'es')
  return { id: esConfigs[esConfigs.length - 1].id, made: true }
}
// StationGrid「导入站址」写进带口径 / 罩的标记层地球站后回调：对号底本 = 该侧此刻引用的那份（收端留空按库第二份，同新增行）
function applySiteType(row, kind, item) {
  if (!row || !item) return
  const rx = kind === 'rx'
  const prefer = rx ? (row.rxStationId ? resolveEs(row.rxStationId) : (esConfigs[1] || esConfigs[0])) : resolveEs(row.stationId)
  const ref = esRefForSite(item, prefer, satOfRow(row), !rx)
  if (!ref) return
  if (rx) row.rxStationId = ref.id
  else row.stationId = ref.id
  if (ref.made) flushLibSave()   // 行里引用的条目先落盘（理由见 flushLibSave 头注）
}
const okEsNode = (n) => !!n && n.t === 'es' && Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lon))
function chainFits(c) {
  const ns = c && Array.isArray(c.nodes) ? c.nodes : []
  return ns.length === 3 && okEsNode(ns[0]) && okEsNode(ns[2]) && !!ns[1] && ns[1].t === 'sat' && !ns[1].regen && ns[1].geo === true
}
// 载荷的星节点 → satEntryForCtx 认的形状（noradId 恒为字符串，缺项一律空值）
const ctxSatOf = (n) => ({
  name: String(n.name || ''), noradId: n.noradId == null ? '' : String(n.noradId), folder: n.folder ? String(n.folder) : '',
  slotLon: Number.isFinite(n.slotLon) ? n.slotLon : null, altKm: Number.isFinite(n.altKm) ? n.altKm : null, inclDeg: Number.isFinite(n.inclDeg) ? n.inclDeg : null
})
// 没动过的出厂默认行：发 / 收各字段仍是出厂值或留白（收端站型 = 库第二份也算），没挑过站型 / 载波，没有 SLA 采用值；
// G/T、EIRP 等于本会话方向图自动回填的值也算；逐链路指定下「卫星」列等于切换归属时写进去的场景卫星也算；
// R0.01% / 海拔等于出厂时按默认站址写进去的值（seedDefaultSite）也算
function isFactoryRow(r) {
  if (!r || r.sla) return false
  const m = grdMemo[r._id]
  return [...TX_FIELDS, ...RX_FIELDS].every((f) => {
    const v = r[f.key] == null ? '' : String(r[f.key]).trim()
    if (v === '' || v === String(f.def) || isDefaultSiteSeed(f.key, v, defSite.value)) return true
    if (f.key === 'rxStationId') return v === ((esConfigs[1] && esConfigs[1].id) || '')
    if (f.key === 'satelliteId') return satLink.value && !!curSat.value && v === curSat.value.id
    return !!m && m.auto[f.key] !== undefined && v === String(m.auto[f.key])
  })
}
async function importChains(chains) {
  const list = Array.isArray(chains) ? chains : []
  const fit = list.filter(chainFits)
  const skipped = list.length - fit.length
  if (!fit.length) { toast(byLang('没有可导入的链路', 'No applicable links')); return }
  const byKey = new Map(), jobs = [], sats = []
  for (const c of fit) {
    const n = c.nodes[1], k = String(n.key || '')
    const e = (k && byKey.get(k)) || satEntryForCtx(ctxSatOf(n))
    if (k) byKey.set(k, e)
    if (!sats.some((s) => s.id === e.id)) sats.push(e)
    jobs.push({ c, e })
  }
  let fresh = false
  if (!satLink.value && !(sats.length === 1 && curSat.value && curSat.value.id === sats[0].id)) {
    const before = activeId.value
    await addBlankConfig(null)
    if (!activeId.value || activeId.value === before) return   // 没建成（未激活 / 写盘失败未离开）：不动现场
    if (sats.length === 1) satId.value = sats[0].id
    else setSatScope('link')
    fresh = true
  }
  if (fresh || (linkRows.length === 1 && isFactoryRow(linkRows[0]))) linkRows.splice(0, linkRows.length)
  for (const { c, e } of jobs) {
    const [tx, , rx] = c.nodes
    const r = rowFromSite(null, e)   // 整行留白 + 新 _id；逐链路指定时写「卫星」列
    // 航迹代表点带实际高度（altM）：「海拔」列写它，autoGeo 只补降雨率、不再按地形改写海拔
    for (const [g, s] of [[TX_SITE, tx], [RX_SITE, rx]]) { r[g.name] = s.name || ''; r[g.lon] = String(s.lon); r[g.lat] = String(s.lat); if (Number.isFinite(s.altM)) r[g.alt] = String(Math.round(s.altM)) }
    const tRef = esRefForSite(tx, esConfigs[0], e, true)
    const xRef = esRefForSite(rx, esConfigs[1] || esConfigs[0], e)
    r.stationId = tRef ? tRef.id : ''
    r.rxStationId = xRef ? xRef.id : ((esConfigs[1] && esConfigs[1].id) || '')
    linkRows.push(r)
    const row = linkRows[linkRows.length - 1]   // 取回响应式代理：autoGeo 异步回填才触发重绘
    autoGeoRow(row, Number.isFinite(tx.altM) ? new Set([TX_SITE.alt]) : undefined, 'tx')
    autoGeoRow(row, Number.isFinite(rx.altM) ? new Set([RX_SITE.alt]) : undefined, 'rx')
  }
  // 计数：一条图上链路（grp）可按 Polygon / 航迹的代表点展开成多行（支路）
  const n = new Set(jobs.map((j, i) => j.c.grp || '#' + i)).size, nRows = jobs.length
  const who = sats.length === 1 ? (sats[0].form.satelliteName || sats[0].name) : ''
  toast(byLang(
    `已导入 ${n} 条链路${nRows > n ? `（${nRows} 行）` : ''}${who ? '（' + who + '）' : ''}${skipped ? `，${skipped} 条不适用已跳过` : ''}`,
    `Imported ${n} link${n === 1 ? '' : 's'}${nRows > n ? ` (${nRows} rows)` : ''}${who ? ' (' + who + ')' : ''}${skipped ? `, ${skipped} skipped (not applicable)` : ''}`))
  await flushLibSave()
}

// —— Phase 4：配置持久化（含卫星 / EIRP·GT 天线匹配选择）——
// ① 整盘工作台状态序列化（卫星/载波信号参数、发收信站群、计算方式、GRD 匹配选择、矩阵显示）。
// ② 场景自动保存：工作区恒对应配置列表里的一份，改动约 1 s 后写回 userData/configs.geo.json（见 useConfigAutosave）。
// ③ localStorage 只记「上次打开的是哪一份」（{ activeId }）；v1.5.0 及以前这里存的是整份场景，载入时迁移一次（见 onMounted）。
const STATE_KEY = 'linkbudget/last'

function serializeState() {
  // v3 场景 = 关联关系：链路行（站址 + 库条目 id 引用）+ 卫星选择。
  // 三库是全局资产（userData/library.json），不再随场景存副本；_ 前缀键（行内部 id / 计算列）一律剥离。
  // 计算方式/系统余量/超发量自 v3 起随载波入库（求解策略是载波的属性），故不再是场景字段。
  // SLA：采用值/勾选随行走（row.sla 由「非 _ 键全存」自然带上），参数是场景级一份。
  return {
    v: 3,
    // ★ row.sla 是嵌套对象：从响应式行上浅拷出来的是 Vue 的 Proxy，结构化克隆过不了 ——
    //   saveConfig 走 IPC 当场抛「保存失败」。applyRowSla 内部 normRowSla 现造纯对象，顺手落平。
    // row.cap（容量汇总的列入 / 载波数）同理：applyRowCap 现造纯对象
    rows: linkRows.map((r) => { const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; if (o.sla) applyRowSla(o, o.sla); if (o.cap) applyRowCap(o, o.cap); return o }),
    satScope: satScope.value,   // 卫星参数归属：'config' 配置级（satId）/ 'link' 链路级（各行 satelliteId）
    satId: satId.value,
    slaParams: { ...slaParams },
    capParams: normCapParams(capParams)   // 容量汇总：逐转发器的可用资源与单价（键＝卫星配置 id）
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
// 链路表组件（StationGrid）：载入配置时要清它的撤销 / 重做栈
const linkGridRef = ref(null)
// 换了一份内容：上一份的结果态整套清掉（口径同再生式 clearModuleResults）。行 _id 全换新，按 _id 落表的映射
// 本就对不上号，可 links / segments 不清的话，详细预算、图表、容量汇总、TSV 复制仍报上一份的数，「输入已变」灯
// 也还亮着。实时列（_eirp / _gt / _paW）随 computedVals 一并清——行一换预览作业即整表重填。
// 档位扫描 / 日凌预计随结果作废（invalidateSlaScan 推进代次：在途那批回来按代次丢弃）。
function clearResults() {
  links.value = []
  segments.value = []
  selected.value = 0
  focusRowId.value = ''
  error.value = ''
  sweepParamsByRow.value = {}
  computedVals.value = {}
  resColUnits.value = {}
  resultsStale.value = false
  invalidateSlaScan()
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // 换了一份内容（切换 / 新建 / 还原历史版本 / 导入）：表格撤销栈里存的是上一份的行，不清的话一按撤销
  // 就把它整张灌进当前配置、约 1 s 后自动写盘（StationGrid 不随配置重建，栈不会自己清）
  if (linkGridRef.value) linkGridRef.value.clearHistory()
  clearResults()
  // SLA 参数：旧场景没这一项 → 补缺省（normSlaParams 幂等，非法值也退缺省）
  Object.assign(slaParams, normSlaParams(st.slaParams))
  capParams.tp = normCapParams(st.capParams).tp   // 容量汇总参数：旧场景没这一项 → 空（各组按缺省）
  // —— v2 场景（本版结构）：行 + 库引用直读；库是全局资产不随场景载入 ——
  if (Array.isArray(st.rows)) {
    // row.sla 逐行深拷（normRowSla 现造新对象）：st 常常就是配置列表里那份 state，
    // 直接引用会让两处共用同一个 sla 对象，改采用值就地改掉了已保存的那份。空的一律删键。
    linkRows.splice(0, linkRows.length, ...st.rows.map((r) => {
      const o = { ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) }
      applyRowSla(o, r.sla)
      applyRowCap(o, r.cap)
      return o
    }))
    satId.value = st.satId || ''
    satScope.value = st.satScope === 'link' ? 'link' : 'config'   // 旧场景无此字段 → 配置级（原口径）
    adoptSceneCalc(st)                        // v2 场景的计算策略 → 下沉到所引载波库条目
    if (st.grdSel) adoptSceneGrd(st.grdSel)   // 旧场景的方向图匹配 → 下沉到所引卫星库条目
    return
  }
  // —— 旧结构迁移（v1.x：内嵌库 + 发/收两张站表）——
  // 内嵌库条目按内容去重并入全局库（adoptEntries 同内容⇒同 id，反复 applyState 映射稳定 → 指纹不误报）；
  // 行引用经映射改写；双表并单表（旧矩阵模式按 m×n 展开，常规按序号配对、短侧末行复用补齐）。
  // ① 载波库（更旧的单一 carrierForm 包成一份）
  const bbUi = { rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null }
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
  satScope.value = 'config'   // 旧结构只有一份 satForm：配置级
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
// 场景一变就交给自动保存（防抖写回当前配置）；「上次打开的是哪一份」随 activeId 记一笔
watch([linkRows, satId, satScope, slaParams, capParams], () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* 配额满等忽略 */ } })

// —— 命名配置 CRUD ——
// 树本身的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js（见文件上方 useConfigTree(...) 注入点）。
// 这里只留本窗特有的几件：配置的自动名、空白配置的内容、确认框。
// 注意：Electron 渲染进程没有 window.prompt / confirm（静默返回 null → 早先「保存不了」的根因），一律用应用内弹窗。
// 自动名（名字随内容的配置用）：「<卫星> 链路 N 条」，按平台语言出字（名字是数据，呈现层翻不到）。
// 卫星名称的出厂占位符「Satellite」不算星名，略去（与资源库条目自动命名同一口径）
const cfgSatText = (names) => [...new Set(names.map((x) => String(x == null ? '' : x).trim()).filter((x) => !isSatNamePlaceholder(x)))].join(' / ')
function defaultCfgName() { const nm = cfgSatText(sceneSatName.value.split(' / ')); return (nm ? nm + ' ' : '') + byLang(`链路 ${linkRows.length} 条`, `${linkRows.length} Link${linkRows.length === 1 ? '' : 's'}`) }
// 同一句话按【存档内容】出（历史版本那一列读数：留档的是当时的场景，不是工作区）
function cfgLabelOf(st) {
  if (!st || !Array.isArray(st.rows)) return ''
  const sats = st.satScope === 'link' ? st.rows.map((r) => resolveSat(r.satelliteId)) : [resolveSat(st.satId)]
  const nm = cfgSatText(sats.filter(Boolean).map((s) => (s.form && s.form.satelliteName) || s.name))
  return (nm ? nm + ' ' : '') + byLang(`链路 ${st.rows.length} 条`, `${st.rows.length} Link${st.rows.length === 1 ? '' : 's'}`)
}


// 默认（空白）配置内容：一条默认链路行（收端引用库中第二份站型，经典 6.2m 发 / 3.7m 收基线）；
// 这行站址写着默认站址，R0.01% / 海拔随之按默认站址的 ITU 取值写进去（seedDefaultSite，口径同选址自动补）
function blankState() {
  return {
    v: 3,
    rows: [seedDefaultSite({ ...defaultsFor(TX_FIELDS), ...defaultsFor(RX_FIELDS), rxStationId: (esConfigs[1] && esConfigs[1].id) || '' }, defSite.value)],
    satScope: 'config',
    satId: '',
    slaParams: { ...DEFAULT_SLA_PARAMS },
    capParams: { tp: {} }
  }
}

// —— 改动检测 + 离开 ——
// 指纹只取「配置内容」字段（不含页签/结果列勾选等视图态），避免切页签/调结果列也去写盘。
function fingerprintOf(s) {
  // 库是全局资产（自动保存、不入场景）：指纹只含场景自身内容（行/引用）；
  // 方向图匹配已随卫星库条目走（v1.4.3）、计算策略已随载波库条目走（v1.3.8），不再是场景内容 → 不入指纹。
  // SLA：采用值/勾选在 rows 里（row.sla）自然计入；参数是场景级，显式列进来 —— 改了 SLA 就是改了场景。
  // 容量汇总参数同理（场景级）；规整后再比——旧场景没这一项与「一项都没填」是同一份内容，不该算改动
  return stableStringify({ rows: s.rows, satScope: s.satScope || 'config', satId: s.satId, slaParams: s.slaParams, capParams: normCapParams(s.capParams) })
}
// 一份配置刚载入工作区：以当前内容为已落盘基线（useConfigTree 在载入 / 新建后调）
function setBaseline() { autosave.attach() }
function isDirty() { return autosave.isDirty() }
// 离开当前配置（切换 / 新建 / 副本）前：把没落盘的改动写进去；写不进去（盘满 / 文件被占用 / 未激活）才问一句
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}

// —— 分享 / 导入（弹窗与全部流程在 components/LbShareDialog.vue，三窗共用）——
// 本窗口只提供「体制适配层」：本机有哪些配置与库、场景引用了哪些条目、并库后怎么改写引用。
const deviceId = ref('')   // 本机用户ID（按 MAC 派生；管理员机器由主进程硬编码为 master1/2/3，不可改）
const shareConfigured = ref(false)
const shareOpen = ref(false)
// 先把没落盘的改动写进去：分享框列的是配置列表里的存档，当前这份要与屏幕一致（结果才能随它带走）
async function openShareDlg() { await autosave.flush(); shareOpen.value = true }
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
  // 卫星按该场景的归属取：链路级引用各行「卫星」列，配置级引用场景单选
  const sat = st.satScope === 'link' ? st.rows.map((r) => r.satelliteId || '') : [st.satId || '']
  return { es, carrier, sat }
}
// 打包前把空引用钉成显式 id：'' 的意思是「用库里第一份」，到了对端就成了「用他库里第一份」
function sharePinRefs(st) {
  if (!st || !Array.isArray(st.rows)) return st
  const s = JSON.parse(JSON.stringify(st))
  for (const r of s.rows) {
    r.stationId = resolveRefId(esConfigs, r.stationId)
    r.rxStationId = resolveRefId(esConfigs, r.rxStationId)
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
    if (s.satScope === 'link') r.satelliteId = resolveRefId(satConfigs, r.satelliteId)
  }
  if (s.satScope !== 'link') s.satId = resolveRefId(satConfigs, s.satId)
  return s
}
function shareRemap(state, idMap) {
  if (!state || !Array.isArray(state.rows)) return
  for (const r of state.rows) {
    if (r.stationId) r.stationId = idMap.es[r.stationId] || ''
    if (r.rxStationId) r.rxStationId = idMap.es[r.rxStationId] || ''
    if (r.basebandId) r.basebandId = idMap.carrier[r.basebandId] || ''
    if (r.satelliteId) r.satelliteId = idMap.sat[r.satelliteId] || ''
  }
  if (state.satId) state.satId = idMap.sat[state.satId] || ''
  // 容量汇总参数按卫星配置 id 记：随卫星一起换成对端库里的 id（对端没收的星，那组设置丢掉）
  if (state.capParams) state.capParams = remapCapParams(state.capParams, idMap.sat)
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
  // 幂等身份「体制:配置id:行下标」。草稿没有稳定 id（'__draft__' 是每次都一样的假身份，两份不同的
  // 草稿会在手机上互相顶掉）→ 留空，按 lbMiniExport 的规矩退化为内容哈希：宁可多一份，不错覆盖。
  const srcIdOf = (p, i) => (p.id && p.id !== '__draft__' ? `GEO:${p.id}:${i}` : '')
  for (const p of picked || []) {
    const st = p && p.state
    if (!st || !Array.isArray(st.rows) || !st.rows.length) continue
    // 已存配置的 st 是 configs.json 里的旧快照，fresh 却是按工作区当前参数算的：工作区一脏两者就不是
    // 一回事（行数相同不代表内容相同），结果不能贴上去，让小程序自己算
    const useRes = fresh && fresh.length === st.rows.length && (p.id === '__draft__' || (p.id === activeId.value && !isDirty()))
    st.rows.forEach((row, i) => {
      const sat = st.satScope === 'link' ? resolveSat(row.satelliteId) : resolveSat(st.satId)   // 卫星按该场景的归属取
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
      }), 'GEO', srcIdOf(p, i)))
    })
  }
  return out
}
const shareCtx = {
  mod: 'GEO',
  getConfigs: () => configs.value,
  getActiveId: () => activeId.value,
  // 不再给 getDraft：自动保存下工作区恒是某一份配置，没有「当前工作参数」这种草稿
  lib: shareLib,
  refsOf: shareRefsOf,
  pinRefs: sharePinRefs,
  remapState: shareRemap,
  toMiniItems,
  saveConfig: (payload) => api.store.saveConfig('geo', payload),
  flushLib: flushLibSave,
  onImported: async ({ last, plan, idMap }) => {
    if (last) await autosave.flush()   // 换到导入的那份之前，当前配置的改动先落盘
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
const { reportDlg, reportVariant, openReportDialog, openSlaReportDialog, openCapReportDialog, submitReport } = useLbReport({
  api,
  orbitType: 'GEO',
  fieldGroups: FIELD_GROUPS,
  nextTick,
  links: () => links.value,
  // 报告讲【当前输入】：有链路行即可导出，没算过 / 输入已变的导出前先补算（口径同再生式 computeMissing）；
  // 补算本身失败就中止，不拿过期的数出交付文件。逐行失败照旧作为「计算失败」链路进报告。
  canReport: () => linkRows.length > 0,
  beforeReport: async (step) => { if (!(await ensureFreshResults(step))) throw new Error(error.value || '计算失败') },
  selected: () => selected.value,
  setSelected: (i) => { selected.value = i },
  showViz: () => showViz.value,
  vizRef: () => vizRef.value,
  lang: () => reportLang.value,
  appVersion: () => appVersion.value,
  paramsFor: (l) => sweepParamsByRow.value[l.rowId] || null,
  // 总报告「逐参数对照」头两行（标准 / 调制编码）：交出这条链路引用的载波表单，标准名由 useLbReport 解析
  carrierOf: (l) => { const row = linkRows.find((r) => r._id === l.rowId); return row ? resolveBaseband(row.basebandId).form : null },
  basebandOpts: () => basebandOpts.value,
  // SLA 建议（§4）：逐链路出纯数据块（标签按报表语言翻好、速率/带宽按当前单位档格式化）
  slaFor: (l) => {
    const row = linkRows.find((r) => r._id === l.rowId)
    return slaReportBlock(slaDerivedFor(l), row && row.sla, slaParams, reportLang.value,
      (v, u) => fmtQtyParts(v, u, unitAdaptive.value))
  },
  slaParams: () => slaParamRows(slaParams, reportLang.value),
  // 容量汇总（§2）：与弹窗同一份账（列入 / 载波数 / 可用资源 / 单价都算进去），标签按报表语言、数按单位档
  capFor: (key, lang, noOf) => capReportBlock(capModel.value, { lang, adaptive: unitAdaptive.value, noOf }),
  // 独立《容量汇总》报告：同一份账（导出前 beforeReport 已补算，computed 随之刷新）
  capModelFor: () => capModel.value,
  capDefaultName: (en) => {
    const s = sceneSatName.value
    return en
      ? `GEO_Capacity_${(s || 'Results').replace(/[^\w-]+/g, '_')}`
      : `GEO容量汇总_${(s || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
  },
  // 导出含 SLA 的报告前把惰性会话态补齐：档位扫描（MIR / 档位表）与日凌（免责事件那一行）——
  // 两条导出路径都走这里，条款数不再随「有没有开过 SLA 弹窗」变
  beforeSla: async () => { await ensureSlaScan(); await refreshSlaSun() },
  // 计算方式随载波逐链路而定：封面/表头只在全表口径一致时报该方式（不一致则不报，各链路详情自带「计算设置」块）
  calc: () => {
    const modes = new Set(links.value.map((l) => calcOfLink(l).key).filter(Boolean))
    return {
      mode: modes.size === 1 ? calcOfLink(links.value[0]).label : '',
      satelliteName: sceneSatName.value,
      frequencyBand: sceneBand.value
    }
  },
  calcFor: (l) => { const c = calcOfLink(l); return { mode: c.label, targetMargin: c.margin, overDb: c.overDb } },
  // —— 独立《服务等级指标（SLA）》报告：不取图、不组瀑布，只把各链的 SLA 块与档位表组成模型 ——
  slaCount: () => slaCount.value,
  slaMonthly: () => (Number(slaParams.monthly) ? 1 : 0),
  slaComposition: () => slaComposition({ orbitType: 'GEO', slaParams }, reportLang.value),
  slaExtra: (l) => slaReportExtra(l),
  slaDefaultName: (en) => slaDefaultNameOf(en),
  defaultName: (en) => {
    const s = sceneSatName.value
    return en
      ? `GEO_Link_Budget_Report_${(s || 'Results').replace(/[^\w-]+/g, '_')}`
      : `GEO链路预算报告_${(s || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  toastFile,
  setError: (m) => { error.value = m }
})

// 城市库
const cities = ref([])
onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  // 默认站址的降雨率 / 海拔先于配置载入：首次运行 ensureActive 新建的那份空白配置，出厂行要按它写 R0.01% / 海拔
  defSite.value = await loadDefaultSiteGeo(api)
  // 全局库先于配置载入（场景行引用靠库解析）；库为空 = 首次运行/升级首启 → 保持默认三库、随后落盘
  try { const lib = api && await api.store.getLibrary(LIB_NS); if (lib) applyLibrary(lib) } catch (e) { reportError('读取资源库失败', e) }   // 保持默认库，但得让人知道
  _libLoaded = true
  scheduleLibSave()   // 首启把默认库落盘；已有库则等值覆写无害
  await loadConfigs()
  // 打开上次那份配置；它没了就开树上第一份，一份都没有就新建一份空白配置（工作区恒对应一份配置）。
  // 迁移：v1.5.0 及以前「上次会话」存的是整份场景（含没点保存的改动）——对应的配置还在，就把那份改动接上，
  // 随即由自动保存写盘（写盘前先给它留一档「打开时」，想退回去走历史版本）。只认得出配置的那份才接：
  // 旧版本从不恢复不属于任何配置的草稿，这里也不凭空造一份。
  let last = null
  try { last = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { last = null }
  await ensureActive(last && last.activeId)
  if (last && Array.isArray(last.rows) && last.activeId && last.activeId === activeId.value) { applyState(last); autosave.touch() }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* 配额满等忽略 */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  preview.refresh()
  // 关窗：主进程拦截原生关闭后转到这里——把场景与资源库挂起的写盘冲掉即放行（观感上秒关）；
  // 只有场景写不进磁盘时才问一句，免得一关窗就丢改动。
  api?.linkBudget?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    await flushLibSave()
    if (!ok && !(await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
    api.linkBudget.confirmClose()
  })
  stopAutosaveListen = autosave.listen()   // 窗口失焦 / 页面隐藏时立即写盘
  window.addEventListener('keydown', onGlobalKey)   // Ctrl+Enter = 计算
  window.addEventListener('focus', reloadSatTree)   // 单例窗口：切回本窗口即纳入「星座3D」新导入的 GRD
  window.addEventListener('focus', onWinFocus)      // 同上：频率计划改动、别的窗口复制来的库条目
  flushToolContext()   // 配置已载入：处理开窗时随窗带来的主窗口上下文
})
</script>

<template>
  <div class="lb-shell" @dragover="onWinDragOver" @drop="onWinDrop">
    <ActivationLock />
    <div class="lb-body">
      <!-- ① 左侧栏：配置列表 / 资源库 二选一（功能区「文件 › 配置列表」「视图 › 资源库」开关，右缘可拖宽） -->
      <aside v-show="sideView" class="lb-col lb-side" :class="[sideView === 'library' ? 'lb-lib' : 'lb-configs', { resizing: sideResizing }]" :style="{ width: sideWidth + 'px' }">
        <!-- ①-A 配置列表视图：场景文件树 -->
        <template v-if="sideView !== 'library'">
          <div class="lb-col-hd">
            <span class="lb-cfg-hd-t">配置列表</span>
            <span class="lb-cfg-acts">
              <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="sideView = ''"><Icon name="x" :size="12" /></button>
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
                @click="libTab === 'station' ? addEsConfig() : libTab === 'sat' ? addSatConfig() : addBasebandConfig()"><Icon name="plus" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏资源库" @click="sideView = ''"><Icon name="x" :size="12" /></button>
            </span>
          </div>
          <nav class="lb-lib-tabs">
            <button v-for="t in LIB_TABS" :key="t.key" class="lbx-subtab" :class="{ on: libTab === t.key }" :aria-pressed="(libTab === t.key) ? 'true' : 'false'" :title="t.tip" @click="libTab = t.key">
              {{ t.label }}<span class="lbx-tab-n">{{ t.key === 'station' ? esConfigs.length : t.key === 'sat' ? satConfigs.length : basebandConfigs.length }}</span>
            </button>
          </nav>
          <div class="lb-libpane">
            <LbLibrary v-if="libTab === 'station'" v-model="selEsId" layout="column" :items="esConfigs" :summary="esSummary" name-placeholder="站型名称"
              auto-tip="天线口径" :copy-targets="copyTargetsOf('es')" @copy-to="(c, ns) => copyLibTo('es', c, ns)"
              @add="addEsConfig" @duplicate="duplicateEsConfig" @remove="removeEsConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此配置的副本" @click="duplicateEsConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="esConfigs.length <= 1" @click="removeEsConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><EarthStationPanel :form="cfg.form" :common-fields="ES_COMMON_FIELDS" :tx-fields="ES_TX_FIELDS" :rx-fields="ES_RX_FIELDS" /></template>
            </LbLibrary>
            <LbLibrary v-else-if="libTab === 'sat'" v-model="selSatId" layout="column" :items="satConfigs" :summary="satLibSummary" name-placeholder="卫星名称"
              auto-tip="所选卫星" :copy-targets="copyTargetsOf('sat')" @copy-to="(c, ns) => copyLibTo('sat', c, ns)"
              @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此配置的副本" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <!-- 方向图匹配（卫星方向图 + EIRP/G·T 天线）是本条目的属性：把卫星树与本条目的 grd 递进去，
                   编辑器就地写 cfg.grd（工作台卫星分区只留只读速览行，见 grdFacts）。
                   :key＝条目 id：换条目即重建编辑器——同一实例换 form，频段 watcher 会把「换条目」当成「改频段」套预设。 -->
              <template #default="{ cfg }"><SatellitePanel :key="cfg.id" :form="cfg.form" :fields="SAT_FIELDS" :sat-tree="satTree" :sel="cfg.grd" :local-folder="localFolderFor(cfg.id)"
                :on-import="() => importGrdFor(cfg)" :on-remove-ant="() => removeImportedGrd(cfg)" :importing="importingGrd" /></template>
            </LbLibrary>
            <LbLibrary v-else v-model="selBbId" layout="column" :items="basebandConfigs" :summary="bbSummary" name-placeholder="载波名称"
              auto-tip="速率与调制" :copy-targets="copyTargetsOf('carrier')" @copy-to="(c, ns) => copyLibTo('carrier', c, ns)"
              @add="addBasebandConfig" @duplicate="duplicateBasebandConfig" @remove="removeBasebandConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此配置的副本" @click="duplicateBasebandConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此配置（被引用时提示引用数）" :disabled="basebandConfigs.length <= 1" @click="removeBasebandConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><BasebandPanel :form="cfg.form" :options="basebandOpts" :calc-modes="CALC_MODES" /></template>
            </LbLibrary>
          </div>
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
              <!-- 计算方式已随载波入资源库（逐行按所选载波取用），此处只留执行 -->
              <button class="lbr-big primary" :disabled="computing" :title="`逐行计算链路表全部 ${linkRows.length} 条链路（Ctrl+Enter）`" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
              <!-- 图标与「计算」同一枚实心三角：同一件事的两档（单条 / 整组），不该长成两个族 -->
              <button class="lbr-big" :disabled="computing || !linkRows.length"
                title="高级计算：多载波组功带平衡（VSAT 组网）——勾选多条链路，解出各载波应设的系统余量，使整组 Σ功率带宽 = Σ载波带宽"
                @click="openAdvDlg">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                高级计算
              </button>
            </div>
            <div class="lbr-cap">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <!-- 配置自动保存（无「保存」按钮）：这里是它的后悔药；写盘失败时旁边多出一枚告警，单击即重试 -->
              <button class="lbr-big" :disabled="!api || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
              <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
              <button class="lbr-big" :disabled="!api" title="分享 / 导入：配置（可多选）+ 资源库条目（可多选）——分享码 / 文件 / 发给用户ID" @click="openShareDlg"><Icon name="external-link" :size="16" />分享</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（GRD 卫星树 / 天线设置 / 实时星位 / 城市库 / 载波信号选项 等）" @click="refreshLatest">
                <Icon name="refresh-cw" :size="16" />
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :aria-pressed="(sideView === 'configs') ? 'true' : 'false'" :title="sideView === 'configs' ? '隐藏左侧「配置列表」栏（腾出工作区宽度）' : '左侧栏显示「配置列表」（场景文件树；与「资源库」二选一）'" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ on: sideView === 'library' }" :aria-pressed="(sideView === 'library') ? 'true' : 'false'" :title="`${sideView === 'library' ? '隐藏' : '左侧栏显示'}「资源库」：地球站 ${esConfigs.length} · 卫星 ${satConfigs.length} · 载波 ${basebandConfigs.length}（全局资产，场景按 id 引用；与「配置列表」二选一）`" @click="toggleSide('library')"><Icon name="folder-open" :size="16" />资源库</button>
              <button class="lbr-big" :class="{ on: showViz }" :aria-pressed="showViz ? 'true' : 'false'" :title="showViz ? '隐藏详细预算的图表区（地理场图 + 链路视图）' : '显示详细预算的图表区：地理场图（站址经纬度）+ 链路视图（3D 站星几何）'" @click="showViz = !showViz"><Icon name="chart-line" :size="16" />图表</button>
            </div>
            <div class="lbr-cap">视图</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!linkRows.length" :title="linkRows.length ? '按当前计算结果给出 SLA 条款建议值：可用度 / 带宽与速率 / 时延与丢包 / 故障响应与恢复 / 发射合规（逐条可改采用值、可勾选列入报告）' : '暂无链路。'" @click="openSlaDlg">
                <Icon name="shield-check" :size="16" />
                SLA
              </button>
              <button class="lbr-big" :disabled="!linkRows.length" :title="linkRows.length ? '容量汇总：逐转发器汇总容量与带宽，对照可用资源（可勾选链路，设载波数、可用资源与单价）' : '暂无链路。'" @click="openCapDlg">
                <Icon name="sigma" :size="16" />
                容量
              </button>
              <button class="lbr-big" :disabled="reportDlg.busy || !linkRows.length" :title="linkRows.length ? '生成交付级报告：Excel（总报告 + 逐链路详情）/ Word / PDF（封面 · 目录 · 总报告 · 逐链路详情，含图）' : '暂无链路。'" @click="openReportDialog"><Icon name="file-export" :size="16" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
              <button class="lbr-big" :disabled="!segments.length" title="复制当前瀑布表（TSV，可直接粘贴到 Excel / 报告）" @click="copyWaterfallTsv"><Icon name="copy" :size="16" />TSV</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <LbDispCtl />
        </div>

        <!-- 链路工作台：全宽横向分区（卫星 → 链路表 → 详细预算），计算栏吸底 -->
        <div ref="flowEl" class="lbx-flow lbx-cards" :class="{ 'lbx-stale-res': !!(resultsStale && links.length) }">
          <!-- 卫星分区只在「统一指定」下出现：逐链路指定时卫星在链路表表首的「卫星」列组里逐行选，这里再报一颗星只会混淆 -->
          <LbSection v-if="!satLink" id="sat" title="卫星与转发器">
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
                    title="从卫星资源库选择本配置使用的卫星（统一指定：全部链路共用）" @change="satId = $event.target.value">
                    <option v-for="o in satSelectOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <span v-if="curSat" class="lbx-satname" title="卫星名称（随资源库条目；选中 GRD 实时星时以星历为准）">{{ curSat.form.satelliteName || '—' }}</span>
                  <span class="lbx-satnote">全部 {{ linkRows.length }} 条链路共用</span>
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
                  <span class="lbx-kv" title="卫星饱和 EIRP 天线：按各收信站经纬度取该天线多波束最大 Parameter，自动回填收信站「卫星饱和 EIRP」。取星与天线匹配在资源库卫星编辑器中修改">
                    <span class="lbx-kv-l">EIRP 天线</span><span class="lbx-kv-v">{{ grdFacts.eirp }}</span>
                  </span>
                  <span class="lbx-kv" title="卫星G/T 天线：按各发信站经纬度取该天线多波束最大 Parameter，自动回填发信站「卫星G/T」">
                    <span class="lbx-kv-l">G/T 天线</span><span class="lbx-kv-v">{{ grdFacts.gt }}</span>
                  </span>
                  <span v-if="grdFacts.stale" class="lbx-satnote bad" title="匹配已保留，但本机卫星树中没有该 GRD 方向图（更换计算机 / 尚未在主窗口导入）：期间不回填">未导入</span>
                  <span v-else-if="grdFacts.mismatch" class="lbx-satnote bad" title="所匹配的方向图与本配置的星名/轨位不一致">{{ grdFacts.mismatch }}</span>
                </div>
              </div>
            </div>
          </LbSection>

          <LbSection id="links" title="链路表" :count="linkRows.length">
            <template #actions>
              <!-- 卫星的指定方式（场景级）：统一指定＝上方分区单选一颗；逐链路指定＝表首「卫星」列组逐行选，上方分区收起 -->
              <span class="lbx-segwrap" title="卫星的指定方式：统一指定＝本配置仅使用一颗卫星（在上方「卫星与转发器」分区选择，全部链路共用）；逐链路指定＝链路表每行各选卫星（表首「卫星」列组：卫星 · 卫星G/T · 卫星饱和 EIRP，上方分区随之收起）。切到逐链路指定：「卫星」列为空的行填入统一指定的卫星，已有选择的行不变；切到统一指定：全部链路改用首行所用的卫星">
                <span class="lbx-segl">卫星</span>
                <span class="lbu-seg"><button v-for="s in SAT_SCOPES" :key="s.v" :class="{ on: satScope === s.v }" :aria-pressed="(satScope === s.v) ? 'true' : 'false'" @click="setSatScope(s.v)">{{ s.l }}</button></span>
              </span>
              <button class="lb-mini" title="导入主窗口「目标间链路建链」中建立的链路" @click="linkImpOpen = true">导入链路</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="12" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" :class="{ dragging: !!colDrag.key }" @wheel="onColPickWheel">
                  <!-- 拖左侧把手换位＝改表里结果列的次序（本行读数同序）；勾选框只管显示与否 -->
                  <label v-for="d in resultDefsOrdered" :key="d.key" class="lbx-colpick-i" :class="{ dragging: colDrag.key === d.key }" :title="d.tip || d.label" @mousemove="colDragH.over($event, d.key)">
                    <span class="lbx-colpick-grip" title="拖动调整列序" @mousedown.left.prevent.stop="colDragH.start($event, d.key)" @click.prevent.stop><Icon name="grip-vertical" :size="12" /></span>
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
              <span class="lbx-gridbar" data-gridbar="lb.links"></span>
            </template>
            <div class="lbx-grid">
              <StationGrid ref="linkGridRef" grid-id="lb.links" bar-to="[data-gridbar='lb.links']" :focus-id="rowReadout ? rowReadout.rowId : ''" :stations="linkRows" :fields="gridFields" :ghost-of="ghostOf" :groups="gridGroups" :extra-values="gridVals" :cell-class="cellClassFn"
                :cell-sub="cellSubFn" :cell-tag="cellTagFn" :cell-fill="cellFillFn" :freeze-keys="false"
                :cities="cities" :city-search="citySearch" label="链路" :auto-geo="autoGeoRow" :site-type="applySiteType"
                :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, rxStationId: esSelectOptions, satelliteId: satColOptions }"
                :lib-fields="{ basebandId: 'carrier', stationId: 'station', rxStationId: 'station', satelliteId: 'sat' }" @edit-lib="editInLibrary"
                :row-menu-extra="rowMenuExtra" @xlsx-done="onXlsxDone" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :readout="rowReadout" />
          </LbSection>

          <LbSection id="detail" title="详细预算" :stale="!!(resultsStale && links.length)" :no="detailNo" :summary="sel && links.length ? `${sel.txName} → ${sel.rxName}` : ''">
            <template #nav>
              <button class="lb-mini lb-mini-ico" :disabled="!links.length || selected <= 0" title="上一条" @click="stepDetail(-1)"><Icon name="chevron-up" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" :disabled="!links.length || selected >= links.length - 1" title="下一条" @click="stepDetail(1)"><Icon name="chevron-down" :size="12" /></button>
            </template>
            <div v-if="error" class="lb-err">{{ error }}</div>
            <div v-else-if="!links.length" class="lb-placeholder">尚无预算结果。</div>
            <div v-else-if="sel && sel.error" class="lb-err">链路 {{ sel.txName }} → {{ sel.rxName }} 计算失败：{{ sel.error }}</div>
            <!-- 文档区（样式见 styles/lbworkbench.css）：上排＝级联主表 ‖ 图表区，下排＝参考段整幅段带 -->
            <div v-else-if="core" class="lbx-doc">
              <div class="lbx-doc-main"><WaterfallTable :segments="segments" pick="cascade" :lang="reportLang" /></div>
              <div v-if="showViz" class="lbx-doc-side"><LbVizPane ref="vizRef" engine="geo" :params="selParams" :sweep2D="api ? api.linkBudget.sweep2D : null"
                :output-defs="api ? api.linkBudget.outputDefs : null" :link-scene="linkScene" :geo-link="geoLink"
                store-key="linkbudget" :lang="reportLang" @exported="toastFile" /></div>
              <div class="lbx-doc-ref"><WaterfallTable :segments="segments" pick="rest" :lang="reportLang" /></div>
            </div>
          </LbSection>
        </div>
      </section>

    </div>

    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
    />

    <!-- 高级计算：多载波功带平衡（VSAT 组网，GEO 窗专用）-->
    <LbAdvBalanceDialog :open="advDlg.open" :rows="advRows" :busy="advDlg.busy || computing"
      :stale="resultsStale" :carrier-remap="advRemap" store-key="linkbudget" @close="advDlg.open = false" @apply="applyAdvPlan" />

    <!-- SLA 建议：条款表 + SLA 参数 + 可用度档位扫描（四窗共用组件；链路由头部下拉选） -->
    <LbSlaDialog
      :open="slaOpen" :options="slaOpts" :index="slaIdx" :derived="slaDerived"
      :row-sla="slaRow && slaRow.sla" :params="slaParams" :adaptive="unitAdaptive" :all-on="slaAllOn"
      :error="error" :link-error="(slaLink && slaLink.error) || ''" :link-name="slaLinkName"
      @close="slaOpen = false" @pick="slaIdx = $event" @adopt="slaSetAdopt" @include="slaSetInclude"
      @param="slaSetParam" @toggle-all="slaToggleAll" :sla-count="slaCount" @clear="slaClear" @export="openSlaReportDialog" />

    <!-- 容量汇总：逐转发器的三线表（三窗共用组件；账目由 shared/lbCapacity 算好传进去） -->
    <LbCapDialog :open="capOpen" :model="capOpen ? capModel : null" :adaptive="unitAdaptive" :error="error"
      @close="capOpen = false" @include="capSetInclude" @count="capSetCount" @param="capSetParam"
      @toggle-all="capToggleAll" @reset="capReset" @export="openCapReportDialog" />

    <!-- 导入链路：星座 3D 主窗的图上链路（四窗共用组件；本窗只收 站 → 透明 GEO 星 → 站）-->
    <LinkImportDialog v-if="linkImpOpen" kind="linkbudget" @import="onLinkImport" @close="linkImpOpen = false" />

    <!-- 导出报告：封面元信息 + 输出格式 + 是否含图（三窗共用组件）-->
    <LbCustomColsDialog :open="ccDlgOpen" :cols="customCols" :pool="customPool" :preview-fn="ccPreview"
      @update:cols="customCols = $event" @close="ccDlgOpen = false" />
    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="GEO"
      :sat-name="sceneSatName" :band="sceneBand" :link-count="linkRows.length"
      :viz-available="showViz" :sla-count="slaCount" store-key="linkbudget" :busy="reportDlg.busy" :progress="reportDlg.progress"
      @close="reportDlg.open = false" :variant="reportVariant" @submit="submitReport" />

    <!-- 历史版本（自动保存的后悔药）：还原 / 用那一版另建副本 -->
    <LbVersionsDialog v-model:open="verDlg.open" ns="geo" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />

    <ConfirmDialog />


    <!-- 分享 / 导入弹窗（三窗共用组件）：配置多选 + 资源库多选，分享码 / 文件 / 在线三条路共用同一份勾选 -->
    <LbShareDialog ref="shareRef" v-model:open="shareOpen" :ctx="shareCtx" :device-id="deviceId" :configured="shareConfigured" @toast="toastFile" />
    <WinStatusBar :n="N" :stale="resultsStale && links.length" stale-title="计算输入已被修改，结果列与详细预算对应修改前的参数">
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
    </WinStatusBar>
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini / .lb-dlg…）在 styles/lbworkbench.css，此处只留本窗的变体 */

/* 功能区「文件」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .app-icon { animation: ui-spin .7s linear infinite; transform-origin: 50% 50%; }


.lb-empty, .lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; }
.lb-cfg-list { list-style: none; margin: 0; padding: 0; }
.lb-cfg-list li { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 9px; font-size: var(--fs-3); cursor: pointer; border-radius: var(--r-ctl); color: var(--text-muted); }
.lb-cfg-list li:hover { background: var(--wash-hover); color: var(--text); }
.lb-cfg-list li.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent-ui); }
.lb-cfg-nm { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.lb-cfg-ico { flex: none; font: inherit; font-size: var(--fs-4); line-height: 1; padding: 0 4px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); opacity: 0; display: inline-flex; align-items: center; }
.lb-cfg-list li:hover .lb-cfg-ico { opacity: 1; }
.lb-cfg-ico:hover { color: var(--text); }
.lb-cfg-ico.del:hover { color: var(--danger); }
.lb-cfg-list { user-select: none; }
.lb-cfg-list li { cursor: pointer; }
.lb-cfg-list li.cut { opacity: .5; }
/* 右键菜单 */
.lb-cfg-rename { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-3); padding: 2px 5px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-cfg-rename:focus { outline: none; }
.lb-cfg-hint { padding: 2px 6px 8px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.5; }
.lb-cfg-acts i { font-style: normal; }


/* 分段选择（链路配对等，计算栏用） */
.seg-i { font: inherit; font-size: var(--fs-3); padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.seg-i:hover { color: var(--text); border-color: var(--border-strong); }
.seg-i.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent-ui); }


/* 核心指标（.core-*）三线式样式统一在 styles/lbworkbench.css（三 App 共用，此处不再重复定义） */

</style>
