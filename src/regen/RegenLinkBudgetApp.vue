<script setup>
import { ref, shallowReactive, reactive, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { askConfirm, confirmState } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import { FIELD_GROUPS, SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ISL_FIELDS, LASER_FIELDS, ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS, defaultsFor, withFieldDefaults, buildRegenParams, buildRegenDownlinkParams, buildRegenIslParams, buildRegenLaserParams, eirpToPowerW } from './regenParams.js'
import { hopSideOf, regenHopGeometry, regenHopDelay, regenDigestParams } from './regenModeScope.js'   // 上/下行单跳时延口径 · 报告输入清单按模块取字段
import { stableStringify } from '../shared/configDirty.js'
import { pf } from '../shared/num.js'   // 全角容错 parseFloat：手填圆轨道高度/倾角（经 sat 面板，不过 StationGrid 归一）也能吃全角数字
import { s8LinkParams } from '../shared/s8Params.js'   // ITU-R P.618-14 §8 统计口径参数组装 + 适用性门控
import { migrateLegacyEs } from '../shared/esMigrate.js'
import { pickColumn, fmtScaled, fmtQty, fmtQtyParts } from '../shared/adaptUnits.js'
import { isUnitAdaptive, onUnitModeChange } from '../shared/lbUnitMode.js'   // 结果显示单位档（功能区「单位」，出厂锁定）
import { lbDocT } from '../shared/lbDocI18n.js'
import { waterfallTsv } from '../shared/lbWaterfallTsv.js'   // 详细预算整表复制（四窗一份）
import { getLang, onLangChange } from '../shared/i18n/runtime.js'   // 报表语言跟随平台语言
import { syncAutoNames, adoptAutoFlag, withAutoFlag, isAutoNamed, newCfgName, newFolderName, copyNameOf, isSatNamePlaceholder } from '../shared/lbAutoName.js'   // 三库条目自动命名（未被用户改名时，名字随关键参数走）
import { byLang } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import { loadSatTree } from '../ngso/satTree.js'   // 卫星树＝轨道来源（v1.4.5 起不再带方向图，见该文件头注）
import { loadCustomSats, findPoolByNorad, orbitSpecOf as poolOrbitSpecOf } from '../ngso/satSearchPool.js'   // 自定义星座星（现读，历元按当天场景历元规则解析）；后两者：导入图上链路按 NORAD 取星（别名：本窗另有按库条目出 spec 的 orbitSpecOf）
import { lbOrbitSpec, pickedTreeNode, scenarioEpochPatch, pinCircularEpoch } from '../shared/lbTreeOrbit.js'   // 库条目 spec 送引擎前补历元 / 跟上场景历元
import { GEO_T0_MODES, normGeoT0Mode, normGeoT0ISO, geoT0State, resolveGeoT0ISO, sceneSecondISO, t0InputValue, parseT0Input } from '../shared/geoT0.js'   // 自动几何的搜索起点：时间轴 / 系统时钟 / 指定
import { slantWgs84Max, altFromSlant } from '../shared/slantRange.js'   // 手动几何：斜距换算 / 等效轨道高度
import { resolveRefId, LIB_WINDOWS, libCopyTargets, copyLibEntry, externalLibEntries, shareNgsoSat } from '../shared/lbShare.js'
import { createPreviewJob } from '../shared/lbPreview.js'   // 站表实时列（EIRP / G·T / 功放尾标）：输入一变逐行重算，「计算」优先
import Icon from '../components/Icon.vue'
import TzPicker from '../components/TzPicker.vue'
import { tzParts, tzTag, normTzMode } from '../shared/tz.js'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import StationGrid from '../ngso/StationGrid.vue'
import BasebandPanel from '../ngso/BasebandPanel.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import RegenSatPanel, { treeNodeOrbit, orbitToForm } from './RegenSatPanel.vue'   // 后两者：刷新卫星树时重解已选星（与面板选星同一份代码）
import WaterfallTable from '../ngso/WaterfallTable.vue'
import LbVizPane from '../components/LbVizPane.vue'
import LbSlaDialog from '../components/LbSlaDialog.vue'
import LbCapDialog from '../components/LbCapDialog.vue'
import { CAP_PBW, capKeyMode, capKeyIsl, buildCapModel, normCapParams, applyRowCap, setCapIncluded, setCapCount, setCapTpParam, remapCapParams, capReportBlock } from '../shared/lbCapacity.js'   // 容量汇总（三窗共用纯逻辑）
import { deriveSla, normSlaParams, applyRowSla, setAdopt, setInclude, setAllInclude, clearAdopt, slaIncludeCount, slaSamplesFor, slaReportBlock, slaParamRows, DEFAULT_SLA_PARAMS , slaScanReportRows, slaComposition} from '../shared/lbSla.js'   // SLA 建议（四窗共用纯逻辑）
import LbReportDialog from '../components/LbReportDialog.vue'
import { useLbReport } from '../shared/useLbReport.js'
import LbDispCtl from '../components/LbDispCtl.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import LbCapFoot from '../components/LbCapFoot.vue'
import LbCustomColsDialog from '../components/LbCustomColsDialog.vue'
import LbSlantTool from '../components/LbSlantTool.vue'
import LbIslRangeTool from '../components/LbIslRangeTool.vue'
import { buildPool, makeResolver, evalRows, customFieldDefs, loadDefs, saveDefs, unitOf, schemaInputPool } from '../shared/lbCustomCols.js'   // 自定义列：公式合成新列
import { loadOrder, saveOrder, makeDragOrder } from '../shared/lbResultOrder.js'   // 结果列的显示顺序 + 拖动排序
import { labeledResultPool, RESULT_LABELS, migrateLegacyFieldRefs } from '../shared/lbResultLabels.js'   // 引擎出参中文名与单位（全量词表）
import LbShareDialog from '../components/LbShareDialog.vue'
import { buildRegenScene } from '../shared/lbLinkScene.js'
import LinkImportDialog from '../components/LinkImportDialog.vue'   // 「导入链路」：星座 3D 主窗建的图上链路
import { suggestIslRangeKm } from '../e2e/e2eParams.js'   // 导入的星间行在手动几何下先给建议距离（同端到端手动档的建议初值）
import { esStationType } from '../shared/lbStationType.js'   // 站带天线口径 / 天线罩 → 对号地球站库条目
import { ngsoSatBandFacts } from '../shared/lbSatBand.js'
import { loadDefaultSiteGeo, withDefaultSite, defaultSiteValue, seedDefaultSite, isDefaultSiteSeed, TX_SITE, RX_SITE } from '../shared/lbDefaultSite.js'   // 站址留空 → R0.01% / 海拔按默认站址取
import { validateRows } from '../shared/lbValidate.js'   // D6：计算前数值预校验（不是数 / 越出字段范围）
import { useNotice } from '../shared/useNotice.js'
import { reportError, reportPartial } from '../shared/reportError.js'

const api = typeof window !== 'undefined' ? window.api : null
// 通知条（shared/useNotice.js）：toast＝普通回执，toastFile＝导出回执（附「打开 · 在文件夹中显示」），toastError＝常驻错误；
// 调用即把本窗登记为 reportError 的出口。必须先于下面的 useConfigTree（它要拿 toast）——const 不像函数声明那样提升。
const N = useNotice()
const { toast, toastFile, toastError } = N

// ============ 配置列表（多级文件夹树，持久化到 userData/configs.regen.json，各工作台一份互不见面）============
// 树的全部行为（增删改移 / 剪贴板 / 右键 / 键盘）在 shared/useConfigTree.js，五个工作台共用一份。
// 注入的都是本窗特有的那几件事；它们都是【函数声明】，提升后才能在这里前向引用。
// 场景自动保存（2026-10-06 起取代「保存」按钮）：工作区恒对应一份配置，改动约 1 s 后写回（shared/useConfigAutosave.js）；
// 后悔药是历史版本（shared/useConfigVersions.js + LbVersionsDialog）。
const cfgTree = useConfigTree({
  ns: 'regen', orbitType: 'REGEN', api, storageKey: 'regen/expandedFolders',
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
  ns: 'regen', api, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'regen', api, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
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
  // html.ui-col-resize（controls.css）：拖动全程整窗锁 col-resize 光标、禁选字——指针划过表格 / 按钮时光标不再跳
  sideResizing.value = true; document.documentElement.classList.add('ui-col-resize')
  document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { w.value = Math.min(max, Math.max(min, startW + (ev.clientX - startX))) }
  const up = () => {
    sideResizing.value = false; document.documentElement.classList.remove('ui-col-resize')
    document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem(lib ? 'regen/libWidth' : 'regen/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 再生式体制：上行 / 下行（广播）/ 星间微波 / 星间激光 ============
// 四种是【计算模块】（2026-09-07 起）：一份配置装哪几个由用户按需添加（模块栏「＋」），不要的 × 掉；
// 空白配置一个都没有。装了的模块各有自己的链路表与结果，报告讲整份配置（按模块分节，次序 = 模块栏次序）。
const LINK_MODES = [
  { key: 'uplink', label: '再生式上行', tip: '地球站 → 星上再生解调；链路总 C/N = 上行 C/(N+I)' },
  { key: 'downlink', label: '再生式下行（广播）', tip: '星上再生 → 地球站接收；链路总 C/N = 下行 C/(N+I)' },
  { key: 'isl', label: '星间链路（微波）', tip: '发射卫星 → 接收卫星，两星微波直连；几何严格（双 SGP4 + 地球临边遮挡）；合计 C/N = 星间单跳 C/N' },
  { key: 'laser', label: '星间链路（激光）', tip: '发射卫星 → 接收卫星，两星激光直连；光学功率链（发射光功率 · 光学效率 · 望远镜增益 · 指向损耗 · 自由空间损耗）得接收光功率 P_rx；链路余量 = P_rx − 接收机灵敏度 P_req；可用度 = 两星几何互视占比' }
]
const MODE_KEYS = LINK_MODES.map((m) => m.key)
const modeOf = (key) => LINK_MODES.find((m) => m.key === key) || null
// 当前配置装了哪些模块（有序；随配置存档 / 分享）与当前看着的那个（'' = 一个都没装）
const modules = ref([])
const linkMode = ref('')
const activeModules = computed(() => modules.value.map(modeOf).filter(Boolean))
const addableModes = computed(() => LINK_MODES.filter((m) => !modules.value.includes(m.key)))
const addMenuOpen = ref(false)
// 各模块的链路表 / 字段集。四张表在下文声明，这里只按 key 分发——调用全发生在 setup 之后，不撞 TDZ
function rowsOf(key) { return key === 'laser' ? laserLinks : key === 'isl' ? islLinks : key === 'downlink' ? rxStations : key === 'uplink' ? txStations : [] }
function fieldsOf(key) { return key === 'laser' ? LASER_FIELDS : key === 'isl' ? ISL_FIELDS : key === 'downlink' ? RX_FIELDS : TX_FIELDS }
// 各表的站址组（shared/lbDefaultSite.js）：发信站群只有发侧、收信站群只有收侧，星间两表没有站址
function sitesOf(key) { return key === 'uplink' ? [TX_SITE] : key === 'downlink' ? [RX_SITE] : [] }
// 默认站址（经纬度留空时引擎所用的那一组）的 ITU 降雨率 / 海拔：onMounted 在载入配置前取一次。
// 用途三处：出厂行的 R0.01% / 海拔按它写；站址留空的行组参时补它；表内灰字照显它。取不到为 null，一切照旧。
const defSite = ref(null)
const ghostOf = (row, f) => defaultSiteValue(row, f.key, defSite.value)
// 入算行：留空格补成表内灰字的那个值，再组参 / 解几何（口径同雨衰页 effectiveRow）——
//   ① 站址经纬度都留空：R0.01% / 海拔按默认站址的 ITU 取值（withDefaultSite，须在②之前：它看经纬度是否留空）；
//   ② 其余留空的数值格补字段缺省（经纬度即 DEFAULT_SITE、最低仰角 10°、卫星 G/T 10 dB/K、再生下行 EIRP 25 dBW…）。
// 早先留空格原样下去：几何把最低仰角当 0°，引擎按弯管口径回退（卫星 G/T 2 dB/K、下行 EIRP 46 dBW）——灰字写 25、算的是 46。
// 组参（计算 / 实时列）、几何求解、斜距推算、图表站址都按它取数；表格本身不改写（留空就是留空）。
const effTx = (row) => withFieldDefaults(withDefaultSite(row, defSite.value, [TX_SITE]), TX_FIELDS)
const effRx = (row) => withFieldDefaults(withDefaultSite(row, defSite.value, [RX_SITE]), RX_FIELDS)
// 地球站库条目同理：库编辑器的灰字也是 f.def（天线口径留空曾按引擎回退 6.2 / 3.7 m 算，灰字写着 2.4；功放预设留空直接报「工作点无效」）
const effEs = (form) => withFieldDefaults(form, ES_FIELDS)
// 站址名留空的行：链路名取表内灰字那个名字（字段缺省站址名，与 StationGrid 的 ghost 同源），不再回落成「发 n / 收 n」
const siteNameOf = (row, key, fields, i, pre) => {
  if (row[key]) return row[key]
  const f = (fields || []).find((x) => x.key === key)
  return (f && (ghostOf(row, f) || f.def)) || (pre + (i + 1))
}
// 添加 = 装上并切过去；已装的再点一次只是切过去。新模块先给一条默认行（空引用 = 各库第一份）；
// 上 / 下行的默认行站址写着默认站址，R0.01% / 海拔随之按默认站址的 ITU 取值写进去（seedDefaultSite）
function addModule(key) {
  addMenuOpen.value = false
  if (!modeOf(key)) return
  if (!modules.value.includes(key)) {
    const rows = rowsOf(key)
    if (!rows.length) rows.push(seedDefaultSite(newStation(fieldsOf(key)), defSite.value, sitesOf(key)))
    modules.value = [...modules.value, key]
  }
  linkMode.value = key
}
// 模块有没有【内容】：多于一行 / 那一行改过默认值 / 算过。有内容才问一句，空模块直接关
function moduleHasContent(key) {
  const rows = rowsOf(key)
  if (rows.length > 1 || (linksBy[key] || []).length) return true
  const r = rows[0]
  if (!r) return false
  const def = defaultsFor(fieldsOf(key))
  const s = (v) => String(v == null ? '' : v)
  // 斜距是手动几何下软件自己按仰角/轨道高度回填的派生量（见 refreshSlant），不算用户填的内容；
  // R0.01% / 海拔等于出厂时按默认站址写进去的值（seedDefaultSite）同样不算
  const derived = new Set(['slantRange', 'rxSlantRange', 'sla'])
  return Object.keys(r).some((k) => !k.startsWith('_') && !derived.has(k) && s(r[k]) !== s(def[k]) && !isDefaultSiteSeed(k, r[k], defSite.value, sitesOf(key)))
}
// 移除 = 模块连同它的链路行与结果一起删（配置里不留看不见的表）；关的是当前页签就切到邻近的一个
async function removeModule(key) {
  const m = modeOf(key)
  if (!m || !modules.value.includes(key)) return
  const n = rowsOf(key).length
  if (moduleHasContent(key) && !(await askConfirm(`移除「${m.label}」？其 ${n} 条链路及计算结果将一并删除。`))) return
  const idx = modules.value.indexOf(key)
  modules.value = modules.value.filter((k) => k !== key)
  clearModuleResults(key)
  rowsOf(key).splice(0)
  if (linkMode.value === key) linkMode.value = modules.value[Math.min(idx, modules.value.length - 1)] || ''
}
// 页签拖拽换序：次序即报告分节次序（上行 → 星间 → 下行 这类信号流向由用户自己排）
const dragKey = ref('')
function onModDragStart(key, e) {
  dragKey.value = key
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', key) } catch (err) { /* ignore */ } }
}
function onModDragOver(key) {
  const from = dragKey.value
  if (!from || from === key) return
  const list = modules.value.slice()
  const i = list.indexOf(from), j = list.indexOf(key)
  if (i < 0 || j < 0) return
  list.splice(i, 1); list.splice(j, 0, from)
  modules.value = list
}
function onModDragEnd() { dragKey.value = '' }
// 页签上的状态点：'ok' 有结果且未过期 / 'stale' 有结果但输入已变 / '' 没算过
function modStatus(key) { const n = (linksBy[key] || []).length; return !n ? '' : staleBy[key] ? 'stale' : 'ok' }

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
// —— 卫星的指定方式（场景级，随场景存档；三个链路预算窗口同一套；开关在发/收信站群节头）——
//   'link'   逐链路指定：发/收信站表每行各选卫星（satelliteId）——再生式出厂口径；
//   'config' 统一指定：本配置只用一颗卫星（satId），在主区「卫星」分区选，上/下行两个地面模块的全部链路共用，
//            站表不再出「卫星」列（「卫星」列组只剩该星对本站的配对量 G/T · EIRP）；逐链路指定时该分区收起。
// 星间微波 / 激光链路不受此约束：一条星间链路两端本就是两颗不同的星，恒按行指定发射 / 接收卫星。
// 引擎口径不变：两种方式只决定每行的 satForm 与轨道从哪里取（见 satOfRow）。
const SAT_SCOPES = [{ v: 'config', l: '统一指定' }, { v: 'link', l: '逐链路指定' }]
const satScope = ref(localStorage.getItem('regen/satScope') === 'config' ? 'config' : 'link')
watch(satScope, (v) => { try { localStorage.setItem('regen/satScope', v) } catch (e) { /* ignore */ } })
const satLink = computed(() => satScope.value === 'link')
const satId = ref('')   // 配置级归属下本场景选用的卫星库条目（空 = 第一份）
const curSat = computed(() => resolveSatellite(satId.value))
// 某发/收信站行所用的卫星库条目：链路级取该行「卫星」列，配置级取场景单选
const satOfRow = (row) => (satLink.value ? resolveSatellite(row && row.satelliteId) : curSat.value)
// 卫星分区（配置级）的单选选项：库条目本身，不带「（默认）」
const satPickOptions = computed(() => satConfigs.map((c) => ({ value: c.id, label: c.name })))
// 切换归属：配置级→链路级 把场景卫星写进上/下行站表空着的「卫星」列（已有值的行留原值）；链路级→配置级
// 场景卫星取当前模块首行所选，上/下行全部站行随之改用这一颗（各行原先不同星时，结果会变）
function setSatScope(v) {
  if (v !== 'link' && v !== 'config') return
  if (v === satScope.value) return
  if (v === 'link') {
    const id = curSat.value ? curSat.value.id : ''
    for (const r of [...txStations, ...rxStations]) if (!r.satelliteId) r.satelliteId = id
  } else {
    const rows = linkMode.value === 'downlink' ? rxStations : txStations
    const seed = rows[0] || txStations[0] || rxStations[0]
    if (seed) { const s = resolveSatellite(seed.satelliteId); if (s) satId.value = s.id }
  }
  satScope.value = v
}
// 卫星树（星座3D 页导入的卫星）——作轨道来源
const satTree = ref(loadSatTree().sats)
// 重读卫星树，并把用着的、取自卫星树的星按树里现在的节点重解轨道（口径同 NGSO reloadSatTree：3D 页改了根数 / 历元即跟上）；
// 自定义星座星（搜索选的，或树里关联到合成号的）换成当前场景历元（见 shared/lbTreeOrbit.js）。轨道只在真变了时写（免得自动保存空转）。
// 树里暂时没有的节点不清空所选（换机器 ≠ 用户想换星）；关联星此刻反解不出（离线）也不拿 unresolved 顶掉已存的轨道。
async function reloadSatTree() {
  try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ }
  let cust = null
  const custSats = () => { if (!cust) { try { cust = loadCustomSats().sats } catch (e) { cust = [] } } return cust }
  for (const c of orbitSyncTargets()) {
    const ns = c.ngsoSat
    if (!ns || ns.mode === 'manual') continue
    const node = pickedTreeNode(ns, satTree.value)
    if (node) {
      let orbit = null
      try { orbit = await treeNodeOrbit(node) } catch (e) { orbit = null }   // 反解失败：留着已存的轨道
      if (ns.mode !== 'tree' || ns.folder !== node.folder) continue   // 反解期间用户另选了星：不拿旧节点顶掉新选的
      if (orbit && orbit.type !== 'unresolved') {
        // 先换成当前场景历元再比（候选池按窗口缓存，历元可能是旧的）：否则每次刷新都「写旧→换新」两遍，结果全标过期
        if (orbit.type === 'elements') orbit = scenarioEpochPatch(orbit, custSats()) || orbit
        ns.name = node.satName; ns.noradId = node.noradId || null; c.form.satelliteName = node.satName
        if (stableStringify(orbit) !== stableStringify(ns.orbit)) { ns.orbit = orbit; orbitToForm(c.form, orbit) }
        continue
      }
    }
    if (!ns.orbit || ns.orbit.type !== 'elements') continue
    const p = scenarioEpochPatch(ns.orbit, custSats())
    if (p) ns.orbit = p
  }
}
// 刷新时要重解轨道的卫星条目：场景用着的（sceneSats）+ 星间 / 激光行两端（手动几何下「星间链路距离」工具也取它们的轨道）
function orbitSyncTargets() {
  const out = new Set(sceneSats.value)
  for (const r of [...islLinks, ...laserLinks]) { out.add(resolveSatellite(r.txSatelliteId)); out.add(resolveSatellite(r.rxSatelliteId)) }
  return [...out].filter(Boolean)
}

// ============ 载波信号库 ============
let _bbSeq = 1
function makeBasebandConfig(name) { return withAutoFlag({ id: 'bb' + (_bbSeq++), name: name || '', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null } }, 'carrier') }
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
  if (kind === 'sat' && !satLink.value && curSat.value && curSat.value.id === id) n++   // 配置级：场景单选也是一处引用
  for (const c of configs.value) {
    const st = c && c.state
    // 旧结构场景自带内嵌库：行引用指向内嵌条目而非全局库（id 前缀相同可能撞名误报），不计入
    if (!st || !(st.v >= 2)) continue
    n += scan(st.tx, st.rx, st.isl, st.laser)
    if (kind === 'sat' && st.satScope === 'config' && st.satId === id) n++
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
}
// 本会话删掉的库条目 id（见 mergeLibFromDisk）
const _libGone = new Set()

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
  if (Array.isArray(lib.carrier) && lib.carrier.length) basebandConfigs.splice(0, basebandConfigs.length, ...lib.carrier.map((c, i) => ({ id: c.id || ('bbb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('carrier', c), form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null, ...c.form } })))
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
// 四张表起始都是空的：装上对应模块（addModule / applyState）才有行；没装的模块一行也不留
const txStations = reactive([])

// 工作点（功放功率）已随站型移入「地球站配置」发射参数（opPowerW）：给定功放功率 → 引擎 power 模式算上行余量。
// 原「工作点列 EIRP⇄W 切换」随之退役——EIRP 仍可在结果指标「地球站 EIRP」查看。

// —— 计算方式 ——（enLabel 供导出报告选英文时用）
// 求解策略随载波入库（资源库「载波」条目的 calcMode / margin，见 regenParams.js CARRIER_FIELDS），
// 逐行按该行所选载波取用。再生式上下行解耦、无转发器功带之分，故只有两种：power＝设置工作点（按设备实配求余量：
// 上行工作点＝功放功率预设、下行没有功放则工作点＝收信站 G/T）、margin＝设置余量（按目标余量反解设备）。
// 不叫「设置功放功率」：下行钉住的是 G/T 而非功放，故用两侧通用的「工作点」（2026-09-16 用户拍板），口径写在 tip 里。
// 功放功率 / G/T 是硬件属性（上行＝发信站功放功率 opPowerW，下行＝收信站天线/噪温算出的 G/T），留在地球站库。
// 星间/激光链路不受此约束：其工作点由链路自身参数给定（见 computeIsl / computeLaser）。
const CALC_MODES = [
  { key: 'power', label: '设置工作点', enLabel: 'Fixed Operating Point', tip: '工作点固定：上行取地球站配置的功放功率预设、下行取收信站计算得到的 G/T，求链路余量' },
  { key: 'margin', label: '设置余量', enLabel: 'Fixed Margin', tip: '给定系统余量，上行反解所需功放功率、下行反解所需 G/T' }
]
const calcModeOf = (bbForm) => ((bbForm && bbForm.calcMode) === 'margin' ? 'margin' : 'power')

// ============ 收信站群（再生式下行）============
// 工作点 G/T 恒由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算得
// （不再支持「直接输入设备 G/T」——设备 G/T 系统噪温未知，无法自洽推出雨致 G/T 劣化）。
const rxStations = reactive([])
// 链路表「地球站配置」格第二行小字（与 GSO/NGSO 一致）：发信站群显示 EIRP、收信站群显示收信站 G/T。
// 两个读数与功放尾标都取引擎出参（computedVals 的 _eirp / _gt / _paW）：算过且这一行输入没变的，就是那次「计算」的
// 结果（与结果列同源，见 writeTagVals）；没算过 / 输入已变的行由实时预览（groundPreview）按闭式几何现算。
// ★ 早先这两处是窗口里的闭式算式：G/T 按 rxGtFromNoise——不认「天线噪温 = 自动」（出厂即自动：10° 仰角比引擎高 0.55 dB）、
//   也不计云噪；EIRP 按功放预设 powerWToEirp——「设置余量」方式下引擎解出的功放不是预设值，EIRP 与结果列对不上。
const tagText = (v) => (v != null && v !== '' && v !== '—' ? v : null)
const txCellSub = (f, row) => {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const v = tagText(m && m._eirp)
  return v ? `EIRP ${v} dBW` : null
}
// 功能区「单位」档的响应式副本：模板里就地算的读数（功放尾标等）直接吃它——fmtQty 内部读的是
// 模块态，不响应式，没算过链路时切档就不会有任何东西触发重渲染。值由 onUnitModeChange 更新。
const unitAdaptive = ref(isUnitAdaptive())
// 「地球站配置」格内行内尾标：发信站配置名之后贴该站算出的功放功率（就在第二行 EIRP 之上）。只给发信站——
// 功放是发射链的量，收信站那格没有它。库里那一项是「功放功率预设」，这里是引擎按该站几何/载波解出的
// paRecommendation（含回退的功放输出）：计算方式=设置工作点时二者相等，=设置余量时报本链路真正需要的功率。
// 算过且输入没变的行就是结果列「功放功率」那个数；没算过的行是闭式几何的实时估算（同 GSO / NGSO）。
const txCellTag = (f, row) => {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const w = m ? parseFloat(m._paW) : NaN
  // 取 4 位有效数字：尾标是一眼扫过的读数，引擎原串的 0.200 在这里读作「200 mW」（精确值看结果列/瀑布）
  return isFinite(w) ? fmtQty(Number(w.toPrecision(4)), 'W', unitAdaptive.value) : null
}
const rxCellSub = (f, row) => {
  if (f.key !== 'stationId') return null
  const m = computedVals.value[row._id]
  const v = tagText(m && m._gt)
  return v ? `G/T ${v} dB/K` : null
}

// ============ 星间链路群（再生式微波 ISL）============
const islLinks = reactive([])
// ============ 星间激光链路群（再生式激光 / MathWorks 简化光学功率链，灵敏度 P_req 直接给定）============
const laserLinks = reactive([])

// 某卫星配置 → 轨道来源 spec（选星→真实星历；未选→手动圆轨道）。上/下/星间共用。
// 选星的 spec 经 lbOrbitSpec 送出：旧库条目的根数 spec 缺历元时按所选树节点的历元补（不让主进程按计算那一刻编一个）。
function orbitSpecOf(sat) {
  const ns = sat && sat.ngsoSat
  const selectedStar = ns && ns.mode !== 'manual' && ns.orbit
  return selectedStar ? lbOrbitSpec(ns, satTree.value)
    : { type: 'circular', altKm: pf(sat.form.orbitAltitude) || 0, inclDeg: pf(sat.form.orbitInclination) || 0 }
}
// 搜索时窗起点 t0：不锚各星 TLE/场景历元，按场景的「起点」设置取（shared/geoT0.js，与 NGSO / 端到端同口径）——
// 时间轴＝主窗口时间轴上的「此刻」（全软件一条时间线；实时档即系统钟）；系统时钟＝点「计算」那一刻；指定＝场景里存的绝对时刻。
// 每次计算前取一次、整批共用 → 同一张表内上下行/星间各行起点严格一致；轨道仍按 SGP4 从各自历元正推到该时刻（同属绝对时）。
function searchT0ISO() { return resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value) }
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
  // 逐项取：某项失败不拦其余各项（取不到的保留原值），但不再一律报「已刷新」——失败的如实列出（A5）
  const failed = []
  let ok = 0
  const step = async (name, fn) => { try { await fn(); ok++ } catch (e) { failed.push({ name, error: e }) } }
  try {
    reloadSatTree()   // 重读星座3D 页的卫星树（作轨道来源）
    await step('城市库', async () => { const c = api && await api.linkBudget.cities(); if (c) cities.value = c })
    await step('载波信号选项', async () => { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b })
    if (failed.length) reportPartial('刷新最新设置', ok, failed)
    else toast('已刷新最新设置')
  } finally { refreshing.value = false }
}
// 别的链路预算窗口「复制到再生式库」写的是盘上的 library.json；本窗口内存里那份不知道，下次整写会把它冲掉。
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
  for (const c of sat) satConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('sat', c), form: { ...defaultsFor(SAT_FIELDS), ...c.form }, ngsoSat: normNgsoSat(c.ngsoSat) })
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

const LIB_TABS = [
  { key: 'station', label: '地球站', tip: '站型收发射频参数库（发射链含再生工作点）：站表「地球站配置」列按行引用' },
  { key: 'sat', label: '卫星', tip: '卫星库：每颗一份（选星定轨 / 手动轨道）。卫星逐链路指定时站表「卫星」列按行引用，统一指定时在主区「卫星」分区单选；星间链路恒按行引用「发射·接收卫星」' },
  { key: 'carrier', label: '载波', tip: '载波库：链路表「载波配置」列按行引用' }
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
  if (kind === 'sat') selSatId.value = id || (bandSat.value && bandSat.value.id) || ''
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
const satSummary = (c) => (c ? [
  c.form.frequencyBand ? c.form.frequencyBand + ' 频段' : '',
  (c.ngsoSat && c.ngsoSat.mode !== 'manual' && c.ngsoSat.orbit) ? '选星定轨' : '手动轨道',
  `h=${c.form.orbitAltitude || '?'} km · i=${c.form.orbitInclination || '?'}°`
].filter(Boolean).join(' · ') : '')
// 星名：取星后以所选星为准，手动轨道用表单里的卫星名称（与 NGSO 窗口同口径）
const satNameOf = (c) => {
  if (!c) return ''
  const ns = c.ngsoSat || {}
  return (((ns.mode !== 'manual' && ns.orbit) ? (ns.name || c.form.satelliteName) : c.form.satelliteName) || c.name || '—')
}
// 卫星分区横带（与 GSO 同构的三行定义列表：配置 / 频率 / 轨道；读数换行不截断，见 shared/lbSatBand.js）
const satBandLines = computed(() => {
  if (!bandSat.value) return []
  const f = ngsoSatBandFacts(bandSat.value)
  return [{ k: 'freq', label: '频率', items: f.freq }, { k: 'orbit', label: '轨道', items: f.orbit }]
})
// 主区「卫星」分区所报的那颗星：配置级＝场景单选；链路级＝当前地面模块聚焦行（未点过表时首行）所选卫星
const bandSat = computed(() => {
  if (!satLink.value) return curSat.value
  const rows = linkMode.value === 'downlink' ? rxStations : txStations
  const row = rows.find((r) => r._id === focusRowId.value) || rows[0] || null
  return row ? satOfRow(row) : (satConfigs[0] || null)
})
// 链路级：当前地面模块的站表引用了哪些卫星（去重计数，分区首行的读数）
const satUsage = computed(() => {
  if (!satLink.value) return []
  const rows = linkMode.value === 'downlink' ? rxStations : txStations
  const m = new Map()
  for (const r of rows) {
    const s = satOfRow(r); if (!s) continue
    const e = m.get(s.id) || { id: s.id, name: satNameOf(s), n: 0 }
    e.n++; m.set(s.id, e)
  }
  return [...m.values()]
})
// 场景所用卫星（报告封面 / 默认文件名 / 配置默认名）：配置级＝场景单选那颗（星间行另引用的照列）；
// 链路级＝各模块链路表引用的各星去重并列。星间行只在自动几何下才真的用到所选两星（手动几何不选星）。
const sceneSats = computed(() => {
  const out = new Map()
  const add = (s) => { if (s && !out.has(s.id)) out.set(s.id, s) }
  if (!satLink.value) add(curSat.value)
  else for (const r of [...txStations, ...rxStations]) add(satOfRow(r))
  if (!geoManual.value) for (const r of [...islLinks, ...laserLinks]) { add(resolveSatellite(r.txSatelliteId)); add(resolveSatellite(r.rxSatelliteId)) }
  return [...out.values()]
})
const sceneSatName = computed(() => sceneSats.value.map((s) => s.form.satelliteName || s.name).filter(Boolean).join(' / '))
const sceneBand = computed(() => [...new Set(sceneSats.value.map((s) => s.form.frequencyBand || '').filter(Boolean))].join(' / '))
// 切换模块：只显示该模块的表格分区。各模块的结果各存各的（linksBy，按行 _id 落表），
// 切走再切回来还在——报告要的是整份配置，屏幕上看着哪个模块不该决定别的模块有没有数。
watch(linkMode, () => {
  nextTick(() => { const el = flowEl.value; if (el) el.scrollTop = 0 })
  loadWaterfall()   // 详细预算跟着切到该模块的选中链路
})

// ============ 几何搜索时窗（选星 SGP4 典型时刻 + 全部访问窗口）============
const geoHorizonHours = ref(Number(localStorage.getItem('regen/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('regen/horizonHours', String(v)) } catch (e) { /* ignore */ } })
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 120, l: '5 天' }, { v: 168, l: '7 天' }, { v: 336, l: '14 天' }, { v: 720, l: '30 天' }]
// 搜索时窗起点（场景级，随场景存档；口径见 shared/geoT0.js）：时间轴 / 系统时钟 / 指定。
// 切到「指定」而还没有时刻时，以时间轴此刻（取整到秒）作初值。
const geoT0Mode = ref('scene')
const geoT0ISO = ref('')
watch(geoT0Mode, (m) => { if (m === 'fixed' && !normGeoT0ISO(geoT0ISO.value)) geoT0ISO.value = sceneSecondISO() })

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

// ============ 计算结果（按模块各存一份：切模块不清空，报告讲的是整份配置）============
// linksBy[模块] = [{ ti, rowId, mode, txName, satName, data, geom, islGeo, access, margin, ok, error }]
// 选中行 / 报错 / 过期灯同样按模块各记各的；下面四个 computed 是「当前模块」的视图，模板与旧代码照旧读写它们。
const linksBy = shallowReactive(Object.fromEntries(MODE_KEYS.map((k) => [k, []])))
const selectedBy = reactive(Object.fromEntries(MODE_KEYS.map((k) => [k, 0])))
const errorBy = reactive(Object.fromEntries(MODE_KEYS.map((k) => [k, ''])))
const staleBy = reactive(Object.fromEntries(MODE_KEYS.map((k) => [k, false])))
const links = computed({ get: () => (linkMode.value && linksBy[linkMode.value]) || [], set: (v) => { if (linkMode.value) linksBy[linkMode.value] = v } })
const selected = computed({ get: () => (linkMode.value ? selectedBy[linkMode.value] : 0), set: (v) => { if (linkMode.value) selectedBy[linkMode.value] = v } })
const error = computed({ get: () => (linkMode.value ? errorBy[linkMode.value] : ''), set: (v) => { if (linkMode.value) errorBy[linkMode.value] = v } })
const resultsStale = computed({ get: () => !!(linkMode.value && staleBy[linkMode.value]), set: (v) => { if (linkMode.value) staleBy[linkMode.value] = !!v } })
// 清掉一个模块的全部结果态（移除模块 / 换场景）：按行 _id 落表的几张映射只删本模块那几行的键
function clearModuleResults(key) {
  const ids = new Set(rowsOf(key).map((r) => r._id))
  linksBy[key] = []; selectedBy[key] = 0; errorBy[key] = ''; staleBy[key] = false
  const drop = (obj) => { const o = { ...obj }; for (const id of ids) delete o[id]; return o }
  computedVals.value = drop(computedVals.value)
  rawDataByRow.value = drop(rawDataByRow.value)
  sweepParamsByRow.value = drop(sweepParamsByRow.value)
  slaScanByRow.value = drop(slaScanByRow.value)
  dropTagCache(ids)   // 格内读数「以计算结果为准」的登记随结果一起作废
  for (const k of Object.keys(resColUnits)) if (k.startsWith(key + ':')) delete resColUnits[k]
}
const METRIC_OPTIONS_UP = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'paRecommendation', label: '功放功率 (W)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'carrierTotalCN', label: '上行 C/N (dB)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
  // 文字型三列（引擎回显的载波体制）：本行用的调制 / 码率 / MODCOD 档名——看余量时不必回头翻载波库
  { key: 'modulationResult', label: '调制方式', type: 'text', tip: '本行载波的调制方式（引擎回显）' },
  { key: 'fecResult', label: 'FEC 码率', type: 'text', tip: '本行载波的 FEC 码率（引擎回显，保持录入写法）' },
  { key: 'modcodResult', label: 'MODCOD', type: 'text', tip: '从 MODCOD 库中所选档位的名称；未从库中选择则按「调制方式 + FEC 码率」拼出' },
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
  // 文字型三列（引擎回显的载波体制）：本行用的调制 / 码率 / MODCOD 档名——看余量时不必回头翻载波库
  { key: 'modulationResult', label: '调制方式', type: 'text', tip: '本行载波的调制方式（引擎回显）' },
  { key: 'fecResult', label: 'FEC 码率', type: 'text', tip: '本行载波的 FEC 码率（引擎回显，保持录入写法）' },
  { key: 'modcodResult', label: 'MODCOD', type: 'text', tip: '从 MODCOD 库中所选档位的名称；未从库中选择则按「调制方式 + FEC 码率」拼出' },
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
  // 文字型三列（引擎回显的载波体制）：本行用的调制 / 码率 / MODCOD 档名——看余量时不必回头翻载波库
  { key: 'modulationResult', label: '调制方式', type: 'text', tip: '本行载波的调制方式（引擎回显）' },
  { key: 'fecResult', label: 'FEC 码率', type: 'text', tip: '本行载波的 FEC 码率（引擎回显，保持录入写法）' },
  { key: 'modcodResult', label: 'MODCOD', type: 'text', tip: '从 MODCOD 库中所选档位的名称；未从库中选择则按「调制方式 + FEC 码率」拼出' },
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
  opts.map((o) => { const { title, unit } = parseMetricLabel(o.label); return { key: o.key, label: title, unit, type: o.type, tip: o.tip } })
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
// 结果列的显示顺序（按模式各记各的）：全量 key 序另存，「结果列」面板里拖把手换位；表列与本行读数都按它排
const RESULT_DEF_BY_KEY = Object.fromEntries(LINK_MODES.map((m) => [m.key, Object.fromEntries((RESULT_DEFS_BY[m.key] || []).map((d) => [d.key, d]))]))
const resultOrderBy = reactive(Object.fromEntries(LINK_MODES.map((m) => [m.key, loadOrder('regen/resultOrder.' + m.key, RESULT_DEFS_BY[m.key] || [])])))
watch(resultOrderBy, () => { for (const m of LINK_MODES) saveOrder('regen/resultOrder.' + m.key, resultOrderBy[m.key]) }, { deep: true })
const resultDefsOrderedOf = (mode) => (resultOrderBy[mode] || []).map((k) => (RESULT_DEF_BY_KEY[mode] || {})[k]).filter(Boolean)
const resultDefsOnOf = (mode) => resultDefsOrderedOf(mode).filter((d) => (resultKeys[mode] || []).includes(d.key))
const colDrag = reactive({ key: '' })
const colDragH = makeDragOrder({ state: colDrag, getOrder: () => resultOrderBy[linkMode.value] || [], setOrder: (v) => { if (linkMode.value) resultOrderBy[linkMode.value] = v } })
const colPickOpen = ref(false)
// 面板打开期间拦滚轮：面板内滚到边界即止（遮罩上另行全拦）。否则滚轮默认动作沿 DOM 链滚动底下的
// 分节流，页面在遮罩下乱滚、面板随宿主节头滚出视野。
function onColPickWheel(e) {
  const el = e.currentTarget
  const canScroll = e.deltaY > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0
  if (!canScroll) e.preventDefault()
}
const curResultDefs = computed(() => resultDefsOrderedOf(linkMode.value))
// 勾选/取消结果列（勾选集按显示顺序表排，列序不随点击顺序漂移）
function toggleResultKey(k) {
  const mode = linkMode.value
  const cur = resultKeys[mode]
  if (cur.includes(k)) resultKeys[mode] = cur.filter((x) => x !== k)
  else resultKeys[mode] = (resultOrderBy[mode] || []).filter((x) => x === k || cur.includes(x))
}
// 各模式表格列 = 输入列 + 已勾选结果列（计算列 ro:true，值走 computedVals 映射，不写行数据）。
// 结果列显示单位自适应：每次计算按整列最大|值|共选档位（W→mW、kHz→MHz、全列<0dBW→dBm），
// 列头单位跟随（resColUnits 按 '模式:键' 记录）；写入 computedVals 的值已按所选档位换算
const resColUnits = reactive({})
const resColsOf = (mode) => [
  ...resultDefsOnOf(mode)
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
// 载入时把按旧列名引用的公式改写成新名（v1.5.0「卫星EIRP」→「再生下行 EIRP」、「综合损耗」→「其他损耗」，见 migrateLegacyFieldRefs）
const customColsBy = reactive(Object.fromEntries(LINK_MODES.map((m) => [m.key, migrateLegacyFieldRefs(loadDefs('regen/customCols.' + m.key), 'REGEN')])))
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
// 引擎结果按行留底（writeResultVals 顺手写入；行 _id 全局唯一，四个模块共用一张表，移除模块时按行清）
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
  // 一个模块都没装（mode 为空）时池子是空的：弹窗只在装了模块时才开得了，但 computed 在渲染期就会求值
  // 文字型结果列（调制方式 / FEC / MODCOD）不是量，不进公式字段池
  const base = (RESULT_DEFS_BY[mode] || []).filter((d) => d.key !== 'capacityMbps' && d.type !== 'text').map((d) => { const t = RESULT_LABELS[d.key]; return { key: d.key, label: t ? t.label : d.label, unit: t ? t.unit : d.unit, group: '结果列' } })
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
// —— 列组：一段一个【实体】，不再有笼统的「配置」组。载波 / 卫星 / 地球站 / 链路 / 计算结果，
// 字段按 key 归组（结果列已带 group:'res'）。上下行两张表同一份映射（rx* 键并列在内），列序见 regenParams。
//   卫星组＝选哪颗星 + 这颗星对本站的那一个配对量（上行 G/T、下行 EIRP）——它们是卫星侧的量，
//     不是链路条件，摆在「卫星」后面才读得出「这颗星对这座站有多强」。
//   地球站组＝站型配置（口径/功放/噪温/馈线）+ 站址 + 几何——都是「这座站」的属性，一体不拆。
//   链路组＝只剩传播与设计条件（雨强 / 可用度）。
const _STN_GROUP = { basebandId: 'ref',
  satelliteId: 'sat', G_Ts: 'sat', rxEIRP: 'sat',
  stationId: 'es',
  earthStationLocation: 'es', longitude: 'es', latitude: 'es', minElevation: 'es', slantRange: 'es', altitude: 'es',
  rxEarthStationLocation: 'es', rxLongitude: 'es', rxLatitude: 'es', rxMinElevation: 'es', rxSlantRange: 'es', rxAltitude: 'es',
  rainRate: 'link', uplinkAvailability: 'link',
  rxRainRate: 'link', rxDownlinkAvailability: 'link' }
// 星间/激光两张表同理：载波一组、两颗卫星一组（手动几何下选星列整组隐去，该组自然不出现）
const _ISL_GROUP = { basebandId: 'ref', txSatelliteId: 'sat', rxSatelliteId: 'sat' }   // 其余（EIRP/GT/频率/损耗…）默认归 'link'
const _tagGroup = (map, def) => (f) => ({ ...f, group: map[f.key] || def })
// 几何=手动：多出「斜距」列，仰角列改称「仰角」（此时它就是本条链路的仰角，不再是最差工况的门限）；
// 几何=自动最差：斜距由求解器给出，不占列。
// 星间/激光两张表同一套开关：手动只留「星间链路距离」（manualOnly），自动才有两颗卫星与大气余量/
// 最大工作距离（autoOnly）——那三项都是解算轨道才用得上的量。
function _geoCols(fields) {
  return fields.filter((f) => (f.manualOnly ? geoManual.value : (f.autoOnly ? !geoManual.value : true)))
    .map((f) => ((geoManual.value && f.manualLabel) ? { ...f, label: f.manualLabel, tip: f.manualTip || f.tip } : f))
}
const GROUPS_STATION = [{ key: 'ref', label: '载波' }, { key: 'sat', label: '卫星' }, { key: 'es', label: '地球站' }, { key: 'link', label: '链路' }, { key: 'res', label: '计算结果' }]
const GROUPS_ISL = [{ key: 'ref', label: '载波' }, { key: 'sat', label: '卫星' }, { key: 'link', label: '星间参数' }, { key: 'res', label: '计算结果' }]
const GROUPS_LASER = [{ key: 'sat', label: '卫星' }, { key: 'link', label: '激光参数' }, { key: 'res', label: '计算结果' }]
// 站表列还随卫星参数归属变：配置级不出「卫星」列（全表同一颗星，「卫星」列组只剩 G/T · EIRP 配对量）
const _stnCols = (fields) => _geoCols(fields).filter((f) => f.key !== 'satelliteId' || satLink.value)
const txGridFields = computed(() => [..._stnCols(TX_FIELDS).map(_tagGroup(_STN_GROUP, 'link')), ...resColsOf('uplink')])
const rxGridFields = computed(() => [..._stnCols(RX_FIELDS).map(_tagGroup(_STN_GROUP, 'link')), ...resColsOf('downlink')])
const islGridFields = computed(() => [..._geoCols(ISL_FIELDS).map(_tagGroup(_ISL_GROUP, 'link')), ...resColsOf('isl')])
const laserGridFields = computed(() => [..._geoCols(LASER_FIELDS).map(_tagGroup(_ISL_GROUP, 'link')), ...resColsOf('laser')])
// 计算列取值映射 { 行_id: { _键: 值 } }：结果不写行数据 → 写回不惊动存档/脏检/过期 watcher
const computedVals = ref({})
function setVals(id, patch) { computedVals.value = { ...computedVals.value, [id]: { ...(computedVals.value[id] || null), ...patch } } }
// 多行一次合并（结果回填用）：逐行 setVals 每次都整份复制 computedVals，千行表就是 O(N²)
function patchVals(m) { const next = { ...computedVals.value }; for (const id in m) next[id] = { ...(next[id] || null), ...m[id] }; computedVals.value = next }
// 结果单元格着色：负余量标红（纯数字口径，不设文字判定列）
function cellClassFn(f, row) {
  if (!f.ro) return null
  const m = computedVals.value[row._id]
  if (!m) return null
  if (f.key === '_linkmargin') { const v = parseFloat(m._linkmargin); return isFinite(v) && v < 0 ? 'st-bad' : null }
  return null
}
// MODCOD 列：本行载波从 MODCOD 库里选的那一档（名字可自定义），且与引擎回显的调制 / 码率仍一致才用它；
// 否则（自定义体制、或选完又手改过调制 / 码率）按「调制方式 + FEC 码率」拼出来
// rowOf：批量回填时传进来的「行 id → 行」查表（取第一个同 id 的行，同 find 口径）；单条调用照旧线性找
function modcodNameOf(rowId, d, mode, rowOf) {
  const row = rowOf ? rowOf.get(rowId) : rowsOf(mode).find((r) => r._id === rowId)
  const f = row && row.basebandId !== undefined ? resolveBaseband(row.basebandId).form : null
  const same = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim()
  const mc = f && f.modcodLabel ? ((basebandOpts.value.modcod || {})[f.dvbStandard] || []).find((r) => r.label === f.modcodLabel) : null
  if (mc && same(mc.modulation, d.modulationResult) && same(mc.fec, d.fecResult)) return mc.label
  return [d.modulationResult, d.fecResult].map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(' ') || '—'
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
  // 原来逐行 setVals（每行整份复制 computedVals）+ 逐行 rowsOf(mode).find —— 两处都是 O(N²)，千行表回填一秒多。
  // 改成先查表、各行补丁攒成一份（同 id 多次照序合并），末尾一次 patchVals：结果与逐行写逐字节相同
  const rowOf = new Map()
  for (const r of rowsOf(mode)) if (!rowOf.has(r._id)) rowOf.set(r._id, r)
  const batch = {}
  for (const l of out) {
    const d = l.data
    const patch = {}
    for (const def of RESULT_DEFS_BY[mode]) {
      if (!d) { patch['_' + def.key] = '—'; continue }
      const ad = colAd[def.key]
      if (def.key === 'capacityMbps') {
        const mbps = colVal(d, def)
        patch._capacityMbps = !isFinite(mbps) ? '—' : ad ? fmtScaled(ad.conv(mbps)) : mbps.toFixed(3)
      } else if (def.key === 'modcodResult') {
        patch._modcodResult = modcodNameOf(l.rowId, d, mode, rowOf)
      } else {
        const v = d[def.key]
        const n = parseFloat(v)
        patch['_' + def.key] = (v === undefined || v === null || v === '') ? '—' : (ad && isFinite(n)) ? fmtScaled(ad.conv(n)) : v
      }
    }
    // 格内读数（_eirp / _gt / _paW）不在这里写：它们只在「计算」那一刻落一次（writeTagVals）——这里还会在切「单位」档时
    // 整列重写，输入已变的行那时挂的是实时预览的值，不能拿上一次的结果顶回去
    batch[l.rowId] = { ...(batch[l.rowId] || null), ...patch }
  }
  patchVals(batch)
}
// 表格聚焦行变化 → 表脚「本行读数」跟随（无结果的新行也跟）；有结果时详细预算一并切到该行链路
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
function onRowFocus(idx, rowId) {
  focusRowId.value = rowId
  if (!links.value.length) return
  const i = links.value.findIndex((l) => l.rowId === rowId)
  if (i >= 0 && i !== selected.value) { selected.value = i; loadWaterfall() }
}
const segments = ref([])
const computing = ref(false)
// —— 结果过期提示（按模块各记各的）——
// 三库 / 几何模式 / 时窗是四个模块共用的输入，一动全部有结果的模块都过期；四张表只让自己那个模块过期。
// 输入代次（按模块各记各的）：每次 markStale 给涉及的模块 +1（有没有结果都记）。computeModule 开算时记下、
// finishCompute 收尾比一次 —— 算的途中改了表，灯就保持亮（早先收尾一律熄灯，期间那一笔改动从此不认账）
const inGenBy = Object.fromEntries(MODE_KEYS.map((k) => [k, 0]))
const genAtStart = {}
const markStale = (keys) => { for (const k of keys) { inGenBy[k] = (inGenBy[k] || 0) + 1; if ((linksBy[k] || []).length) staleBy[k] = true } }
watch([satConfigs, basebandConfigs, esConfigs, geoMode, geoHorizonHours, geoT0Mode, geoT0ISO], () => markStale(MODE_KEYS), { deep: true })
watch([satScope, satId], () => markStale(['uplink', 'downlink']))   // 卫星参数归属 / 配置级卫星只管两个地面模块
watch(txStations, () => markStale(['uplink']), { deep: true })
watch(rxStations, () => markStale(['downlink']), { deep: true })
watch(islLinks, () => markStale(['isl']), { deep: true })
watch(laserLinks, () => markStale(['laser']), { deep: true })

// —— 上 / 下行一行站送引擎的入参（「计算」与实时列同一份）——
// 留空格按灰字补齐（effTx / effRx / effEs），卫星取该行所用的那颗，计算方式随该行载波：设置工作点＝上行按站型
// 「功放功率预设」、下行按收信站 G/T 求余量；设置余量＝反解功放 / G/T。site＝入算行（几何也取它）；
// powerBad＝上行「设置工作点」而功放预设不是正数（「计算」报因，实时列不算）。
function groundInputs(mode, st) {
  const sat = satOfRow(st)
  const bbForm = resolveBaseband(st.basebandId).form
  const es = effEs(resolveEs(st.stationId).form)
  if (mode === 'downlink') {
    const site = effRx(st)
    const { satParams, linkParams } = buildRegenDownlinkParams(sat.form, bbForm, site, es)
    return { site, satParams, linkParams, opt: { mode: calcModeOf(bbForm) }, powerBad: false }
  }
  const site = effTx(st)
  const { satParams, linkParams } = buildRegenParams(sat.form, bbForm, site, es)
  const power = calcModeOf(bbForm) === 'power', powerW = parseFloat(es.opPowerW)
  return { site, satParams, linkParams, opt: power ? { mode: 'power', powerW } : { mode: 'margin' }, powerBad: power && !(powerW > 0) }
}
// 实时列那一次引擎调用的入参：几何=手动时与「计算」逐字同一份（applyManualGeom 照抄入算行的斜距 / 仰角）；
// 几何=自动最差时取引擎闭式（轨道高度 + 最低仰角：单站最差即压在最低仰角上），不跑 SGP4——那只是还没点「计算」时的估算。
function groundPreviewSpec(mode, inp) {
  let link = inp.linkParams
  if (geoManual.value) {
    const s = mode === 'downlink' ? MANUAL_RX : MANUAL_TX
    link = { ...inp.linkParams }
    applyManualGeom(link, inp.site[s.dKey], inp.site[s.eKey])
  }
  return { mode, sat: inp.satParams, link, opt: inp.opt }
}
// —— 站表实时列：发信站 EIRP + 功放尾标 / 收信站 G/T（与 GSO / NGSO 同一套，作业本体在 shared/lbPreview.js）——
// 只跑正看着的那张地面表（读数只在那张表上露面）；再生式引擎没有批量入口，逐行一次 IPC（口径相同，只是没了块内取消）。
// ★ 与结果列同源：算过且这一行输入没变的，读数就是那次「计算」的引擎出参（writeTagVals）；判据＝本行此刻的
//   预览入参指纹与「计算」那一刻的相同（_resFp）。没算过 / 输入已变的行才由预览按闭式几何现算。
const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? v : n.toFixed(2) }
const _resFp = {}     // 行 _id → 「计算」那一刻该行的预览入参指纹（会话态，换配置 / 移除模块清掉）
const _resTags = {}   // 行 _id → 那次「计算」写进格内的读数
const _pvFp = {}      // 行 _id → 本轮预览给该行组的入参指纹（回包时比对用）
// 上行：EIRP + 功放尾标；下行：收信站 G/T（「设置余量」时即反解出的所需 G/T，同结果列「收信站 G/T」）
const tagsOf = (down, d) => (down ? { _gt: d ? fix2(d.gOverTeResult) : '' } : { _eirp: d ? fix2(d.stationEIRPResult) : '', _paW: d ? d.paRecommendation : '' })
function writeTagVals(mode, out, fpByRow) {
  const m = {}
  for (const l of out) {
    const t = tagsOf(mode === 'downlink', l.data)   // 算失败的行清空读数：结果列是「—」，格里不该还挂着估算值
    m[l.rowId] = t
    _resTags[l.rowId] = t
    if (fpByRow[l.rowId] != null) _resFp[l.rowId] = fpByRow[l.rowId]
  }
  patchVals(m)
}
// 改过又改回「计算」那一份输入：把计算结果的读数写回去（中间那次预览写的是改动时的估算）
function restoreTags(id) {
  const t = _resTags[id], cur = computedVals.value[id]
  if (!t || (cur && Object.keys(t).every((k) => cur[k] === t[k]))) return
  setVals(id, t)
}
function dropTagCache(ids) { for (const id of ids) { delete _resFp[id]; delete _resTags[id]; delete _pvFp[id] } }
const pvMode = () => (linkMode.value === 'uplink' || linkMode.value === 'downlink' ? linkMode.value : '')
const groundPreview = createPreviewJob({
  count: () => { const m = pvMode(); return api && m ? rowsOf(m).length : 0 },
  build: (i) => {
    const mode = pvMode()
    const st = mode ? rowsOf(mode)[i] : null
    if (!st) return null
    try {
      const inp = groundInputs(mode, st)
      if (inp.powerBad) return null
      const spec = groundPreviewSpec(mode, inp)
      const fp = stableStringify(spec)
      _pvFp[st._id] = fp
      if (_resFp[st._id] === fp) { restoreTags(st._id); return null }   // 输入正是算过的那一份：读数以计算结果为准，不再预览
      return { id: st._id, spec }
    } catch (e) { return null }
  },
  send: (specs) => Promise.all(specs.map((s) => Promise.resolve(s.mode === 'downlink'
    ? api.linkBudget.computeRegenDownlink(s.sat, s.link, s.opt)
    : api.linkBudget.computeRegenUplink(s.sat, s.link, s.opt)).catch(() => null))),
  cancel: () => {},
  apply: (list) => {
    const m = {}
    for (const { id, r } of list) {
      if (_resFp[id] != null && _resFp[id] === _pvFp[id]) continue   // 挂起前发出、算完才回来的：本行已有同一份输入的计算结果
      if (r && r.success && r.data) m[id] = tagsOf(r.data.linkType === 'downlink', r.data)
    }
    patchVals(m)
  }
})
watch([satConfigs, basebandConfigs, esConfigs, txStations, rxStations, satScope, satId, geoMode, linkMode], () => groundPreview.schedule(), { deep: true })
// 「计算」优先：computing 一亮就挂起预览、算完再续跑（同 NGSO）
watch(computing, (v) => { if (v) groundPreview.pause(); else groundPreview.resume() }, { flush: 'sync' })
onBeforeUnmount(() => groundPreview.dispose())
// —— 瀑布表一键整表复制（TSV） ——
// 拼表在 shared/lbWaterfallTsv.js（四窗一份）：多列段列头取段自带的 heads（工况对照「晴空 / 降雨」），
// 段标题 / 行标签已随 segments 按报表语言翻好，列头在那里按 lbDocT 补上
async function copyWaterfallTsv() {
  if (!segments.value.length) return
  try { await navigator.clipboard.writeText(waterfallTsv(segments.value, lbDocT(reportLang.value))); toast('已复制详细预算（TSV）') }
  catch (e) { toast('复制失败') }
}
// 几何/访问窗口卡折叠（记忆）
const geoFold = ref(localStorage.getItem('regen/geoFold') === '1')
watch(geoFold, (v) => { try { localStorage.setItem('regen/geoFold', v ? '1' : '0') } catch (e) { /* ignore */ } })
// Ctrl+Enter 全局快捷计算（算当前模块）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !computing.value) { e.preventDefault(); computeActive() }
}
onBeforeUnmount(() => { window.removeEventListener('keydown', onGlobalKey); window.removeEventListener('focus', reloadSatTree); window.removeEventListener('focus', mergeLibFromDisk) })
const nLinks = computed(() => rowsOf(linkMode.value).length)
// 链路方向标签：上行=站→星，下行=星→站，星间=发射星→接收星（txName=发射星, satName=接收星）。
// 按链路自带的 mode 走，不看当前页签——报告把四个模块的链路排在一起，名字不能跟着页签变
function pairLabel(l) {
  if (!l) return ''
  // 手动几何的星间/激光链路两端没有卫星身份（表上也没那两列）→ 按条数命名，不拿「发射星 → 接收星」充数
  if (l.islManual) return `星间链路 ${(l.ti || 0) + 1}`
  return l.mode === 'downlink' ? `${l.satName} → ${l.txName}` : `${l.txName} → ${l.satName}`
}
// 体制短标签（上行/下行/星间）与逐条量词
const modeLabel = computed(() => (linkMode.value === 'laser' ? '激光星间' : linkMode.value === 'isl' ? '星间' : linkMode.value === 'downlink' ? '下行' : linkMode.value === 'uplink' ? '上行' : ''))

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
  // 时延：几何已按本模块那一跳改写过（computeGround 里的 regenHopGeometry），这里照抄；两段分段时延按几何精度回填，
  // 镜像那一段随后由 regenHopDelay 清空
  if (w.oneWayDelayMs != null) {
    d.linkDelayResult = w.oneWayDelayMs.toFixed(3)
    d.linkDelayUpResult = (w.up.slantKm / _C_KMS * 1000).toFixed(3)
    d.linkDelayDownResult = (w.dn.slantKm / _C_KMS * 1000).toFixed(3)
  }
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

// —— 时标格式化（访问窗口 / 星间互视）——
// 档位可调：本机 / UTC / UTC±N（口径与格式化在 shared/tz.js，选择器是 TzPicker）。
// 记在本机：换算是纯显示，跟着人走不跟着配置走。
const TZ_KEY = 'regen/geo/tz'
const tzMode = ref(normTzMode((() => { try { return localStorage.getItem(TZ_KEY) } catch (e) { return null } })(), 'utc'))
watch(tzMode, (v) => { try { localStorage.setItem(TZ_KEY, String(v)) } catch (e) { /* ignore */ } })
// 「起点 = 指定」的时刻框：按同一个时区档位显示与解释（换档不改所指的瞬间），角标同几何卡片。
// 草稿只在回车 / 失焦提交：datetime-local 每敲一键就发一次 input，年份段键到一半是 0002 —— 逐键提交会把公元 2 年落进场景。
// 解析不出就丢掉草稿，框回到已存值。
const t0Draft = ref(null)
const t0Val = computed(() => (t0Draft.value != null ? t0Draft.value : t0InputValue(geoT0ISO.value, tzMode.value)))
const t0RefMs = computed(() => { const t = Date.parse(geoT0ISO.value); return Number.isFinite(t) ? t : Date.now() })
const t0TzTag = computed(() => (tzMode.value === 'utc' ? 'UTCG' : tzTag(tzMode.value, t0RefMs.value)))
function t0Commit() {
  const typed = t0Draft.value; t0Draft.value = null
  const iso = typed == null ? null : parseT0Input(typed, tzMode.value)
  if (iso) geoT0ISO.value = iso
}
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// 角标：UTC→'UTCG'（对标 STK），其余档位→UTC±H(:MM)（本机档按几何时刻的实际偏移取，夏令时不会标错）
const geoRefMs = computed(() => {
  const iso = (islGeo.value && islGeo.value.worst && islGeo.value.worst.worstISO)
    || (access.value && access.value.windows && access.value.windows.length && access.value.windows[0].startISO)
  const t = iso ? new Date(iso).getTime() : NaN
  return Number.isFinite(t) ? t : Date.now()
})
const tzSuffix = computed(() => (tzMode.value === 'utc' ? 'UTCG' : tzTag(tzMode.value, geoRefMs.value)))
function fmtInstant(iso, mode) {
  if (!iso) return '—'
  const d = new Date(iso); if (isNaN(d.getTime())) return String(iso)
  const t = tzParts(d.getTime(), mode), p = (n, w = 2) => String(n).padStart(w, '0')
  return `${t.d} ${UTCG_MON[t.mo - 1]} ${t.y} ${p(t.h)}:${p(t.mi)}:${p(t.s)}`
}
function fmtDur(min) { if (min == null || !isFinite(min)) return '—'; return min >= 60 ? (min / 60).toFixed(2) + ' h' : min.toFixed(1) + ' min' }

// ============ 容量汇总（功能区「导出 › 容量」→ LbCapDialog，纯逻辑在 shared/lbCapacity.js）============
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult); const eta = parseFloat(d.spectralEfficiencyResult)
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN
}
// 一组＝模块 × 卫星：上行占的是该星的上行频谱、下行占的是下行频谱，两份资源不在一本账上；星间按「发射星 → 接收星」
// 成对（手动几何两端无身份，整模块一组）。激光没有载波带宽 / 频谱效率口径，不出。
// ★ 再生式不出功率带宽（pbw: 'none'）：星上解调再调制，转发器（SFD/IBO/OBO/带宽）压根不参与，引擎入参里那套
// 转发器参数只是为让求解良定而由 buildRegenParams 塞的 NGSO 占位值（见 linkCalculatorRegen.js 文件头），
// 结果里透传出来的 PowerBWResult / 转发器带宽都是占位值——故可用带宽也没有缺省（availDefault: false），
// 填了才出剩余与占用。报告侧同口径：regenSummaryRows 的四个体制也都没列功率带宽。
// 列入 / 载波数随行走（row.cap）；可用带宽与单价是场景级一份（capParams.tp['模块:卫星 id']，星间 'isl:发>收'）。
const capParams = reactive(normCapParams(null))
const capOpen = ref(false)
const capSatName = (s) => (s ? (s.name || satNameOf(s)) : '')
function capItemsOf(mode) {
  const byRow = new Map((linksBy[mode] || []).map((x) => [x.rowId, x]))
  return rowsOf(mode).map((row, i) => {
    const l = byRow.get(row._id) || null
    const d = (l && l.data) || null
    let gkey, gname
    if (mode === 'isl') {
      // 手动几何不选星：两端无身份，整模块一组。组名是数据（组头不过呈现层翻译），生成时就按平台语言出字
      if (geoManual.value) { gkey = capKeyIsl('', ''); gname = byLang('发射星 → 接收星', 'Tx Satellite → Rx Satellite') }
      else {
        const a = resolveSatellite(row.txSatelliteId), b = resolveSatellite(row.rxSatelliteId)
        gkey = capKeyIsl(a && a.id, b && b.id); gname = `${capSatName(a)} → ${capSatName(b)}`
      }
    } else {
      const s = satOfRow(row)
      gkey = capKeyMode(mode, s && s.id); gname = capSatName(s)
    }
    // 链路名按信号流向（与结果区一致）：下行是「卫星 → 收信站」
    const name = l ? (mode === 'downlink' ? `${l.satName} → ${l.txName}` : `${l.txName} → ${l.satName}`) : byLang('链路 ' + (i + 1), 'Link ' + (i + 1))
    return {
      no: i + 1, rowId: row._id, name, carrier: resolveBaseband(row.basebandId).name || '',
      gkey, gname, tpBwMHz: NaN,
      ok: !!(d && !l.error), error: l ? (l.error || '') : '',
      capKbps: capacityKbpsOf(d), bwKHz: d ? parseFloat(d.allocBandwidthResult) : NaN, pbwKHz: NaN,
      cap: row.cap || null
    }
  })
}
const capModelOf = (mode) => ((mode && mode !== 'laser' && MODE_KEYS.includes(mode))
  ? buildCapModel(capItemsOf(mode), capParams, { pbw: CAP_PBW.NONE, availDefault: false })
  : null)
const capModel = computed(() => capModelOf(linkMode.value))
const capSub = computed(() => { const m = modeOf(linkMode.value); return m ? m.label : '' })
// 汇总必须出自「此刻这套输入」：当前模块没算过或输入已变，先算一遍再开（同 SLA）
async function openCapDlg() {
  if (!capModelOf(linkMode.value)) return
  if (!links.value.length || resultsStale.value) await computeActive()
  if (!links.value.length) return
  capOpen.value = true
}
// 列入 / 载波数挂在链路行上，会被「结果过期」那条深监听盯到——它们是汇总口径不是引擎入参，灯不该亮（同 slaTouch）
const capRowOf = (id) => rowsOf(linkMode.value).find((r) => r._id === id) || null
function capSetInclude(e) { const r = capRowOf(e.rowId); if (r) slaTouch(() => applyRowCap(r, setCapIncluded(r.cap, e.on))) }
function capSetCount(e) { const r = capRowOf(e.rowId); if (r) slaTouch(() => applyRowCap(r, setCapCount(r.cap, e.n))) }
function capSetParam(e) { setCapTpParam(capParams, e.key, e.field, e.value) }
function capToggleAll(on) { slaTouch(() => { for (const r of rowsOf(linkMode.value)) applyRowCap(r, setCapIncluded(r.cap, on)) }) }
// 「重置」只动当前模块（同 SLA：两件事一起做）：本模块各行回到列入、1 路，本模块各组的可用带宽与单价清空
function capReset() {
  const mode = linkMode.value
  slaTouch(() => { for (const r of rowsOf(mode)) applyRowCap(r, null) })
  for (const k of Object.keys(capParams.tp)) if (k.startsWith(mode + ':')) delete capParams.tp[k]
}

// —— 本行读数（链路表表脚，见 LbCapFoot）——
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
// 某行某侧：按 WGS-84 椭球 + 该站纬度/海拔算「绕站一圈最大斜距」（口径见 shared/slantRange.js）。
// 纬度 / 海拔 / 仰角取入算行（发信站 effTx / 收信站 effRx）：留空的仰角按灰字 10° 推，不再当 0° 推出一个擦地平线的斜距
const effSide = (row, side) => (side.eKey === MANUAL_RX.eKey ? effRx(row) : effTx(row))
const rowSlant = (row, side, altKm) => { const r = effSide(row, side); return slantWgs84Max(pf(r[side.latKey]), (pf(r[side.staAltKey]) || 0) / 1000, pf(r[side.eKey]) || 0, altKm) }
const slantToolRow = computed(() => slantSide.value.rows.find((r) => r._id === focusRowId.value) || null)
const _slantSeedRow = computed(() => slantToolRow.value || slantSide.value.rows[0] || null)
const slantToolAlt = computed(() => {
  const sat = _slantSeedRow.value ? satOfRow(_slantSeedRow.value) : (satLink.value ? satConfigs[0] : curSat.value)
  return (sat && sat.form.orbitAltitude) || ''
})
// 仰角 / 纬度 / 海拔初值取种子行的入算值（留空格即灰字那个值，与填入时 rowSlant 的取数一致）
const _slantSeedEff = computed(() => (_slantSeedRow.value ? effSide(_slantSeedRow.value, slantSide.value) : null))
const slantToolElev = computed(() => (_slantSeedEff.value && _slantSeedEff.value[slantSide.value.eKey]) || 10)
const slantToolLat = computed(() => (_slantSeedEff.value && _slantSeedEff.value[slantSide.value.latKey]) || '')
const slantToolStaAlt = computed(() => (_slantSeedEff.value && _slantSeedEff.value[slantSide.value.staAltKey]) || 0)
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
  for (const [rows, side] of [[txStations, MANUAL_TX], [rxStations, MANUAL_RX]]) {
    for (const r of rows) {
      const rec = slantSig[r._id] || (slantSig[r._id] = {})
      const h = pf(satOfRow(r).form.orbitAltitude)
      const sig = `${r[side.latKey]}|${r[side.staAltKey]}|${r[side.eKey]}|${h || ''}`
      const changed = rec[side.dKey] !== undefined && rec[side.dKey] !== sig
      rec[side.dKey] = sig
      const empty = String(r[side.dKey] == null ? '' : r[side.dKey]).trim() === ''
      if (!(changed || empty) || !(h > 0)) continue
      const d = rowSlant(r, side, h)
      if (d != null) r[side.dKey] = d.toFixed(2)
    }
  }
  // 系统填的派生值与手改一样随自动保存落盘。★ 不在这里推进基线：自动保存下那等于把它标成已落盘，
  // 它就永远写不进去（屏幕上是什么，盘上就该是什么）
}
let _slantT = null
function scheduleSlant() { clearTimeout(_slantT); _slantT = setTimeout(refreshSlant, 300) }
// 只盯推荐值的【输入】（几何模式 / 各行所选卫星与其轨道高度 / 各行站址与仰角）——盯回填值本身会自激
watch(() => [geoMode.value, satScope.value, satId.value,
  [[txStations, MANUAL_TX], [rxStations, MANUAL_RX]].map(([rows, s]) => rows.map((r) =>
    `${satLink.value ? r.satelliteId : ''},${satOfRow(r).form.orbitAltitude},${r[s.latKey]},${r[s.staAltKey]},${r[s.eKey]}`).join(';')).join('/')].join('#'),
scheduleSlant, { immediate: true })

const rowReadout = computed(() => {
  const mode = linkMode.value
  const rows = rowsOf(mode)
  if (!mode || !rows.length) return null
  let idx = rows.findIndex((r) => r._id === focusRowId.value)
  if (idx < 0 && sel.value) idx = rows.findIndex((r) => r._id === sel.value.rowId)   // 还没点过表 → 跟详细预算走
  if (idx < 0) return null
  const row = rows[idx]
  const link = links.value.find((l) => l.rowId === row._id) || null
  const m = computedVals.value[row._id] || null
  const items = []
  for (const def of (m ? resultDefsOnOf(mode) : [])) {
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
  return { no: idx + 1, rowId: row._id, name, err: (link && link.error) || '', items }
})
// 「详细预算」节头那枚行号：由 sel 反算，与该节自己的摘要（站对名）同源。
// 不能照搬 rowReadout.no —— onRowFocus 只在该行**已算出结果**时才推进 selected，聚焦到一条尚未
// 计算的新行时详细预算画的仍是原来那条链路，两处编号本就该不同，同源才不会出现自相矛盾的节头。
const detailNo = computed(() => {
  const s = sel.value
  if (!s || !links.value.length) return 0
  return rowsOf(linkMode.value).findIndex((r) => r._id === s.rowId) + 1
})

const sel = computed(() => links.value[selected.value] || null)
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))
// —— 图表区「参数扫描」——
// 引擎入参按行原样留底（含解算后注入的最差几何/星间距离），不重新组装：重组会丢几何，
// 扫出来的曲线就不再经过详细预算正在显示的那一点。
const sweepParamsByRow = ref({})
const selParams = computed(() => (sel.value ? (sweepParamsByRow.value[sel.value.rowId] || null) : null))

// —— SLA 建议（功能区「导出 › SLA」→ LbSlaDialog，纯逻辑在 shared/lbSla.js）——
// 四种子链路各出该出的组：上行有发射合规、下行/星间没有（客户端不在这一段发射）、
// 激光连可用度组都不出（它的「可用度」是几何互视占比，与雨衰口径不是一回事）。
// 采用值/勾选存在该子链路的行上（row.sla），四张表各存各的；SLA 参数是场景级一份。
// ★ 弹窗自带链路下拉（slaIdx），与链路表的聚焦行（selected）分开走；切子链路时归零 ——
//   四种模式各是各的一批链路，下标留着会指到另一批的第 n 条上。
const slaParams = reactive({ ...DEFAULT_SLA_PARAMS })
const slaScanByRow = ref({})          // 会话态：可用度档位扫描（compute 后批量求得，不入存档）
const modeRows = computed(() => rowsOf(linkMode.value))
const slaOpen = ref(false)
const slaIdx = ref(0)
const slaLink = computed(() => links.value[slaIdx.value] || null)
const slaOpts = computed(() => links.value.map((l, i) => ({ i, label: `#${i + 1} ${pairLabel(l)}` })))
const slaRow = computed(() => (slaLink.value ? modeRows.value.find((r) => r._id === slaLink.value.rowId) || null : null))
const slaLinkName = computed(() => (slaLink.value ? pairLabel(slaLink.value) : ''))
// 与另三窗同一启用条件（有链路即可点）：没算过或输入已变，先算当前模块再开
async function openSlaDlg() {
  if (!links.value.length || resultsStale.value) await computeActive()
  if (!links.value.length) return
  slaIdx.value = Math.min(Math.max(0, selected.value), Math.max(0, links.value.length - 1))
  slaOpen.value = true
  ensureSlaScan()
}
// 重算 / 换子链路后链路可能变少：下标越界就退回第一条，免得弹窗里一片空白、看着像算漏了
watch(links, () => { if (slaIdx.value >= links.value.length) slaIdx.value = 0 })
watch(linkMode, () => { slaIdx.value = 0 })
// 链路所属模块的行（链路自带 mode：报告把四个模块的链路排在一起，不能按当前页签找行）
const rowOfLink = (l) => (l ? rowsOf(l.mode || linkMode.value).find((r) => r._id === l.rowId) || null : null)
function slaDerivedFor(l) {
  if (!l || !l.data) return null
  const row = rowOfLink(l)
  const form = row && row.basebandId !== undefined ? resolveBaseband(row.basebandId).form : {}
  return deriveSla({
    orbitType: 'REGEN', regenMode: l.mode || linkMode.value,
    data: l.data, ok: l.ok, error: l.error, resolvedMargin: l.resolvedMargin,
    params: sweepParamsByRow.value[l.rowId] || null,
    carrierForm: form,
    modcodRows: (basebandOpts.value.modcod || {})[form.dvbStandard] || [],
    scan: slaScanByRow.value[l.rowId] || null,
    fp: null,
    slaParams
  })
}
const slaDerived = computed(() => slaDerivedFor(slaLink.value))
const slaCountOf = (list) => list.reduce((n, l) => {
  const row = rowOfLink(l)
  return n + (l.data && slaIncludeCount(slaDerivedFor(l), row && row.sla) ? 1 : 0)
}, 0)
const slaCount = computed(() => slaCountOf(links.value))                                   // 当前模块（SLA 弹窗）
const slaCountAll = computed(() => modules.value.reduce((n, k) => n + slaCountOf(linksBy[k] || []), 0))   // 整份配置（报告）

// —— 独立《服务等级指标（SLA）》报告 ——
// 逐链路的附加料：载波体制（决定引用哪几份标准）/ MODCOD / 档位表（综合与中断按考核周期算好）
function slaReportExtra(l) {
  const row = rowOfLink(l)
  const f = row && row.basebandId !== undefined ? resolveBaseband(row.basebandId).form : {}
  return { carrierStd: f.dvbStandard || 'custom', modcod: f.modcodLabel || '', scan: slaScanReportRows(slaDerivedFor(l)) }
}
function slaDefaultNameOf(en) {
  const s = sceneSatName.value || (en ? 'Results' : '结果')
  return en
    ? `REGEN_SLA_${s.replace(/[^\w-]+/g, '_')}`
    : `再生式服务等级指标_${s.replace(/[\\/:*?"<>|]/g, '_')}`
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

// ============ 计算（按模块：功能区「计算」算当前模块；导出报告前把别的模块补算齐）============
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
async function computeActive() { return computeModule(linkMode.value) }
async function computeModule(mode) {
  if (!mode || !modules.value.includes(mode)) return
  // 开算前先让已排队的「输入已变」监听跑完（点「计算」之前那一笔改动不算「期间」），再记该模块的输入代次
  await nextTick()
  genAtStart[mode] = inGenBy[mode] || 0
  if (mode === 'laser') return computeLaser(mode)
  if (mode === 'isl') return computeIsl(mode)
  return computeGround(mode)
}
// 计算收尾（四种模块同一套）：结果落到该模块那一份、结果列写回表格、选中行按 _id 保持、过期灯清掉；
// 只有正看着的模块才刷详细预算（别的模块切过去时 watch(linkMode) 会刷）。
// 入参留底按行合并进全局那张表：先删掉本模块全部行的旧留底（没算成的行不许留着上一轮的入参）。
async function finishCompute(mode, out, sweepStore) {
  const prevSel = (linksBy[mode] || [])[selectedBy[mode]] || null
  for (const l of out) l.mode = mode
  const sp = { ...sweepParamsByRow.value }
  for (const r of rowsOf(mode)) delete sp[r._id]
  sweepParamsByRow.value = Object.assign(sp, sweepStore || null)
  linksBy[mode] = out
  writeResultVals(out, mode)   // 结果列写回表格（按行 _id 映射）
  // 聚焦行有结果就对到聚焦行：表脚「本行读数」与「详细预算」节头讲的是同一行
  let keepIdx = focusRowId.value ? out.findIndex((l) => l.rowId === focusRowId.value) : -1
  if (keepIdx < 0) keepIdx = prevSel ? out.findIndex((l) => l.rowId === prevSel.rowId) : -1
  if (keepIdx < 0) keepIdx = Math.min(selectedBy[mode], out.length - 1)
  selectedBy[mode] = keepIdx < 0 ? 0 : keepIdx
  // 先把「表格一动就置位」的 stale 侦听冲刷掉再判旗（本次计算自己写的数不是用户改的）；
  // 开算之后该模块的输入又变过（代次对不上）→ 这批结果对应的是开算那一刻，灯保持亮
  await nextTick()
  staleBy[mode] = (inGenBy[mode] || 0) !== genAtStart[mode]
  if (mode === linkMode.value) await loadWaterfall()
}
// 地面段（再生式上行 / 下行）：逐站一条链路；工作点给定 → 求余量
async function computeGround(mode) {
  if (!api) { errorBy[mode] = '引擎需在桌面客户端中运行'; return }
  const isDown = mode === 'downlink'
  // 本模块真实的那一跳（上行 up / 下行 dn）：另一侧是让弯管引擎与双站几何良定的镜像占位，单程时延只认这一跳
  const side = hopSideOf(mode)
  const stations = isDown ? rxStations : txStations
  if (!stations.length) { errorBy[mode] = isDown ? '暂无收信站。' : '暂无发信站。'; return }
  if (!satConfigs.length) { errorBy[mode] = '暂无卫星。'; return }
  computing.value = true; errorBy[mode] = ''
  try {
    const out = []
    const sweepStore = {}         // 逐行留底送进引擎的入参，供图表区参数扫描原地重跑
    const t0ISO = searchT0ISO()   // 本批上下行统一起点：时间轴此刻
    // D6：数值格预校验——坏行不送引擎，该行结果清空并写明是哪一格；其余行照算
    const badRows = preValidate((isDown ? rxGridFields : txGridFields).value, stations)
    const tagFp = {}   // 行 _id → 本次计算时该行的实时列入参指纹（见 writeTagVals：输入没变的行，格内读数以计算结果为准）
    for (let ti = 0; ti < stations.length; ti++) {
      const st = stations[ti]
      const sat = satOfRow(st)   // 这条链路所用的卫星（配置级即场景单选）：参数、轨道来源、频率都取它的
      const satName = (sat && (sat.form.satelliteName || sat.name)) || '卫星'
      if (badRows.has(ti)) {
        const nm = (isDown ? st.rxEarthStationLocation : st.earthStationLocation) || ((isDown ? '收' : '发') + (ti + 1))
        out.push({ ti, rowId: st._id, txName: nm, satName, data: null, margin: '—', error: badRows.get(ti), geom: null, access: null }); continue
      }
      // 入参与实时列同一份（groundInputs）：留空格按灰字补齐——站址留空补默认站址（经纬度 + ITU 降雨率 / 海拔）、
      // 最低仰角 10°、卫星 G/T 10 dB/K、再生下行 EIRP 25 dBW……；几何的站址 / 仰角 / 斜距也取补齐后的入算行 site
      const inp = groundInputs(mode, st)
      const site = inp.site
      tagFp[st._id] = stableStringify(groundPreviewSpec(mode, inp))
      // 轨道来源：选星→真实星历；未选→手动圆轨道（上/下行共用；与星间同一出口 orbitSpecOf）
      const orbitSpec = orbitSpecOf(sat)

      if (isDown) {
        // ===== 再生式下行：星上再生 → 收信站接收；工作点 = 收信站 G/T =====
        const rxName = siteNameOf(st, 'rxEarthStationLocation', rxGridFields.value, ti, '收')
        const { satParams, linkParams } = inp
        const freqGHz = parseFloat(sat.form.rxCenterFrequency) || 12.5   // 下行频率（几何多普勒/FSL）
        const stationGeo = { lonDeg: parseFloat(site.rxLongitude), latDeg: parseFloat(site.rxLatitude), altKm: (parseFloat(site.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(site.rxMinElevation) || 0, freqGHz }
        let geo = null, acc = null
        if (geoManual.value) {
          // 手动几何：仰角与斜距就是本行那两个数，不解算轨道（无 t*、无过境窗口、§8 不适用）
          if (!(pf(site.rxSlantRange) > 0)) {
            out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: '手动几何：斜距未填或非正数', geom: null, access: null }); continue
          }
          applyManualGeom(linkParams, site.rxSlantRange, site.rxMinElevation)
        } else {
          geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
          if (!(geo && geo.feasible)) {
            out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
          }
          regenHopGeometry(geo, side)   // 单站求解的 oneWayDelayMs 是上下两侧之和 → 改写成本跳（几何卡 / 回填 / 报告同读这一个数）
          // 下行几何注入（单站：收=发，up/dn 同值）
          linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.dn.slantKm; linkParams.rxMinElevation = geo.worst.dn.elevDeg
          linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.dn.slantKm; linkParams.minElevation = geo.worst.dn.elevDeg
          // §8 统计口径（仅下行侧；最低仰角取收信站门限字段，非最差瞬时仰角；不适用时为空对象=原口径）
          Object.assign(linkParams, s8LinkParams(geo, { minElevDn: site.rxMinElevation }))
          try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
        }
        // 计算方式随该行所选载波：power = 按收信站实配 G/T 算余量；margin = 按载波系统余量反解所需 G/T
        const dopt = inp.opt
        sweepStore[st._id] = { satParams, linkParams, opt: dopt }
        const r = await api.linkBudget.computeRegenDownlink(satParams, linkParams, dopt)
        if (r && r.success) {
          const d = r.data
          if (geo) mergePlatformGeometry(d, geo)   // 手动几何不覆盖：引擎回填的就是用户给的那两个数
          regenHopDelay(d, side)   // 单程时延只取下行这一跳（引擎按弯管口径报上下两侧之和）
          const m = parseFloat(d.linkmargin)
          out.push({ ti, rowId: st._id, txName: rxName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
        } else {
          out.push({ ti, rowId: st._id, txName: rxName, satName, data: null, margin: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
        }
        continue
      }

      // ===== 再生式上行：地球站 → 星上再生解调 =====
      // 计算方式随该行所选载波：power = 按站型功放功率（工作点）算上行余量；margin = 按载波系统余量反解所需功放功率
      const txName = siteNameOf(st, 'earthStationLocation', txGridFields.value, ti, '发')
      const { satParams, linkParams } = inp
      if (inp.powerBad) {
        out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: '工作点无效（地球站配置的「功放功率预设」需为正数）', geom: null, access: null }); continue
      }
      const copt = inp.opt
      const freqGHz = parseFloat(sat.form.centerFrequency) || 14.25
      const stationGeo = { lonDeg: parseFloat(site.longitude), latDeg: parseFloat(site.latitude), altKm: (parseFloat(site.altitude) || 0) / 1000, minElevDeg: parseFloat(site.minElevation) || 0, freqGHz }
      let geo = null, acc = null
      if (geoManual.value) {
        if (!(pf(site.slantRange) > 0)) {
          out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: '手动几何：斜距未填或非正数', geom: null, access: null }); continue
        }
        applyManualGeom(linkParams, site.slantRange, site.minElevation)
      } else {
        geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
        if (!(geo && geo.feasible)) {
          out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
        }
        regenHopGeometry(geo, side)   // 单站求解的 oneWayDelayMs 是上下两侧之和 → 改写成本跳
        linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.up.slantKm; linkParams.minElevation = geo.worst.up.elevDeg
        linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.up.slantKm; linkParams.rxMinElevation = geo.worst.up.elevDeg
        // §8 统计口径（仅上行侧；最低仰角取发信站门限字段，非最差瞬时仰角；不适用时为空对象=原口径）
        Object.assign(linkParams, s8LinkParams(geo, { minElevUp: site.minElevation }))
        try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
      }
      sweepStore[st._id] = { satParams, linkParams, opt: copt }
      const r = await api.linkBudget.computeRegenUplink(satParams, linkParams, copt)
      if (r && r.success) {
        const d = r.data
        if (geo) mergePlatformGeometry(d, geo)
        regenHopDelay(d, side)   // 单程时延只取上行这一跳（引擎按弯管口径报上下两侧之和）
        const m = parseFloat(d.linkmargin)
        out.push({ ti, rowId: st._id, txName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, powerW: d.paRecommendation, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, rowId: st._id, txName, satName, data: null, margin: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
      }
    }
    await finishCompute(mode, out, sweepStore)
    writeTagVals(mode, out, tagFp)   // 格内读数（EIRP / G·T / 功放尾标）改用本次引擎出参，与结果列同源
    // SLA 档位扫描只在用得着时跑、且不 await（每行 9 档 = 9 次引擎重算，不该跟着每次「计算」全表跑）
    invalidateSlaScan(mode)
    if (slaWanted() && mode === linkMode.value) ensureSlaScan(mode)
  } catch (e) {
    errorBy[mode] = String(e)
  } finally {
    computing.value = false
  }
}

// SLA 可用度档位扫描：整表一次批量 IPC（逐档钉住当前工作点重算，见 core 的 scanSlaTiers）。
// 只有上行/下行两种子链路扫：星间的「可用度」是几何互视占比（不随雨衰档位变），激光整组不出。
// 上行只改上行那一个入参键、下行只改下行那一个 —— 另一侧是凑几何的镜像入参，改了就把这条
// 链路的口径悄悄换成另一件事。会话态、不入存档；随结果一起过期（重算即重扫）。
// ★ 出 IPC 前必须现造纯数据：Vue 的 Proxy 过不了结构化克隆，invoke 当场抛且无 catch 时全静默。
// 扫描态按模块各记各的（代数 / 已完成代数 / 在跑的那次）：四个模块的档位表互不作废
const _slaScan = Object.fromEntries(MODE_KEYS.map((k) => [k, { gen: 0, done: -1, run: null, runGen: -1 }]))
function invalidateSlaScan(mode) {
  const s = _slaScan[mode]
  if (!s) return
  s.gen++
  const m = { ...slaScanByRow.value }
  for (const r of rowsOf(mode)) delete m[r._id]
  slaScanByRow.value = m
}
// ★ 只认弹窗开着。别拿 slaCount 当闸：includeOf 缺键即「入报告」，任何算出结果的行都算勾了条款，
//   slaCount 恒等于有结果的行数 → 闸恒开，每次「计算」都全表 9 档扫一遍（2026-09-07 深审 #3）。
//   档位表与 MIR 之外没有别的消费者：导出含 SLA 的报告走 beforeSla 现补，弹窗打开时 ensureSlaScan。
const slaWanted = () => slaOpen.value
// 把某模块这批结果的档位表补齐（已齐就直接返回）；弹窗打开（当前模块）、导出报告前（全部模块）调
async function ensureSlaScan(mode = linkMode.value) {
  const s = _slaScan[mode]
  if (!s || s.done === s.gen) return
  if (s.run) {
    if (s.runGen === s.gen) return s.run
    await s.run
    return ensureSlaScan(mode)
  }
  const gen = s.gen
  s.runGen = gen
  s.run = refreshSlaScan(linksBy[mode] || [], sweepParamsByRow.value, mode, gen).finally(() => { s.run = null })
  return s.run
}
async function ensureSlaScanAll() { for (const k of modules.value) await ensureSlaScan(k) }
async function refreshSlaScan(out, store, mode, gen) {
  const s = _slaScan[mode]
  if (!api || !api.linkBudget.slaScanBatch) return
  if (mode !== 'uplink' && mode !== 'downlink') { if (gen === s.gen) s.done = gen; return }
  const engine = mode === 'downlink' ? 'regen-down' : 'regen-up'
  const single = mode === 'downlink' ? 'dn' : 'up'
  const jobs = []
  for (const l of out) {
    if (!l || !l.data) continue
    const p = store[l.rowId]
    if (!p) continue
    const samples = slaSamplesFor({ up: l.data.uplinkAvailabilityResult, dn: l.data.downlinkAvailabilityResult, single })
    if (!samples.length) continue
    jobs.push({ rowId: l.rowId, spec: { engine, satParams: p.satParams, linkParams: p.linkParams, opt: p.opt, samples } })
  }
  if (!jobs.length) { if (gen === s.gen) s.done = gen; return }
  try {
    const res = await api.linkBudget.slaScanBatch(JSON.parse(JSON.stringify(jobs.map((j) => j.spec))))
    if (gen !== s.gen) return        // 期间又算过一轮：这份已过期
    const m = { ...slaScanByRow.value }   // 合并：别的模块的档位表留着
    jobs.forEach((j, i) => { if (res && res[i]) m[j.rowId] = res[i] })
    slaScanByRow.value = m
    s.done = gen
  } catch (e) { /* 扫不出就不出档位表与 MIR，结果本身不受影响 */ }
}

// 再生式星间：逐条星间链路。几何=自动最差 时两星轨道 → 严格互视最差距离/可见度；
// 几何=手动 时不选卫星，星间距离取本行 islRangeKm 直接算 FSL。
async function computeIsl(mode = 'isl') {
  if (!api) { errorBy[mode] = '引擎需在桌面客户端中运行'; return }
  if (!islLinks.length) { errorBy[mode] = '暂无星间链路。'; return }
  if (!geoManual.value && !satConfigs.length) { errorBy[mode] = '暂无卫星。'; return }
  computing.value = true; errorBy[mode] = ''
  try {
    const out = []
    const sweepStore = {}         // 逐行留底送进引擎的入参，供图表区参数扫描原地重跑
    const t0ISO = searchT0ISO()   // 本批星间统一起点：与上下行同口径，时间轴此刻
    const badRows = preValidate(islGridFields.value, islLinks)   // D6：数值格预校验（坏行不算、结果清空并写明哪一格）
    for (let ti = 0; ti < islLinks.length; ti++) {
      const link = islLinks[ti]
      const manual = geoManual.value
      // 手动几何不选卫星：两端无身份（表上也没那两列），链路名按条数走；引擎占位仍取首份卫星配置
      const txSat = manual ? null : resolveSatellite(link.txSatelliteId)
      const rxSat = manual ? null : resolveSatellite(link.rxSatelliteId)
      const bbForm = resolveBaseband(link.basebandId).form
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      if (badRows.has(ti)) { out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: null, margin: '—', error: badRows.get(ti), geom: null, islGeo: null, access: null }); continue }
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
        // 手动圆轨道的历元钉到本批 t0（pinCircularEpoch），否则主进程按计算那一刻补、与时间轴上的 t0 不同步
        geo = await api.linkBudget.islGeometry({ orbitA: pinCircularEpoch(orbitSpecOf(txSat), t0ISO), orbitB: pinCircularEpoch(orbitSpecOf(rxSat), t0ISO), t0ISO, horizonHours: geoHorizonHours.value, freqGHz, atmMarginKm, maxRangeKm: pf(link.islMaxRange) || 0 })
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
    await finishCompute(mode, out, sweepStore)
  } catch (e) {
    errorBy[mode] = String(e)
  } finally {
    computing.value = false
  }
}

// 再生式激光星间：逐条激光链路（发射卫星 → 接收卫星）。几何复用两星互视最差距离/可见度；
// 链路预算走光学功率链（P_rx 链）；链路余量 = P_rx − 接收机灵敏度 P_req（直接给定，无速率 / 带宽概念）。
async function computeLaser(mode = 'laser') {
  if (!api) { errorBy[mode] = '引擎需在桌面客户端中运行'; return }
  if (!laserLinks.length) { errorBy[mode] = '暂无激光星间链路。'; return }
  if (!geoManual.value && !satConfigs.length) { errorBy[mode] = '暂无卫星。'; return }
  computing.value = true; errorBy[mode] = ''
  try {
    const out = []
    const t0ISO = searchT0ISO()
    const badRows = preValidate(laserGridFields.value, laserLinks)   // D6：数值格预校验（坏行不算、结果清空并写明哪一格）
    for (let ti = 0; ti < laserLinks.length; ti++) {
      const link = laserLinks[ti]
      const manual = geoManual.value
      const txSat = manual ? null : resolveSatellite(link.txSatelliteId)
      const rxSat = manual ? null : resolveSatellite(link.rxSatelliteId)
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      if (badRows.has(ti)) { out.push({ ti, rowId: link._id, txName, satName: rxName, islManual: manual, data: null, margin: '—', error: badRows.get(ti), geom: null, islGeo: null, access: null }); continue }
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
        // 两星几何（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）；手动圆轨道历元钉到本批 t0（同微波星间）
        geo = await api.linkBudget.islGeometry({ orbitA: pinCircularEpoch(orbitSpecOf(txSat), t0ISO), orbitB: pinCircularEpoch(orbitSpecOf(rxSat), t0ISO), t0ISO, horizonHours: geoHorizonHours.value, freqGHz: optFreqGHz, atmMarginKm, maxRangeKm: pf(link.islMaxRange) || 0 })
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
    // 激光星间不走扫描通道（引擎入口两参形式）：不留底入参（finishCompute 会把本模块各行的旧留底删干净）
    await finishCompute(mode, out, null)
  } catch (e) {
    errorBy[mode] = String(e)
  } finally {
    computing.value = false
  }
}

async function loadWaterfall() {
  const l = sel.value
  if (!l || !l.data) { segments.value = []; return }
  const segs = await api.linkBudget.waterfall({ results: JSON.parse(JSON.stringify(l.data)), lang: reportLang.value, orbitType: 'REGEN', adaptUnits: isUnitAdaptive(), txLocation: String(l.txName || '') })
  // 等回包期间换了链路 / 模块 / 配置（结果已清）：这份是上一条的，不往上贴
  if (sel.value === l) segments.value = segs
}
// 功能区「单位」档改动（本窗切换或别的链路预算窗改的）：有结果的模块结果列全部就地重排 + 详细预算重取一次。
// 不碰引擎：档位只管显示，数值一个没变。
let _offUnitMode = null
onMounted(() => { _offUnitMode = onUnitModeChange((v) => { unitAdaptive.value = v; for (const k of MODE_KEYS) if ((linksBy[k] || []).length) writeResultVals(linksBy[k], k); loadWaterfall() }) })
onBeforeUnmount(() => { if (_offUnitMode) _offUnitMode() })
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

// ============ 主窗口带上下文打开（tool:open）============
// 本窗只认图上链路 ctx.links（见下方 importChains）。口径同 GSO / NGSO 窗口：只追加、不改动现有配置；
// 开窗时配置未载入则排队（onMounted 末尾 flushToolContext 放行），之后一次只处理一份上下文。
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
// 失败不再静默（A5）：从地图带对象进来没成，通知条常驻报因
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
async function applyToolContext(c) {
  if (c && c.links) await importChains(c.links)
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
// 卫星条目在主窗口里的身份：只有取过星的（卫星树 / 星历搜索）才在主场景里有这颗星；手动轨道是虚拟圆轨道，不发
function satIdentOf(sat) {
  const ns = sat && sat.ngsoSat
  if (!ns || ns.mode === 'manual' || !ns.orbit) return null
  const name = ns.name || (sat.form && sat.form.satelliteName) || ''
  return (name || ns.noradId != null) ? { norad: ns.noradId != null ? ns.noradId : undefined, name } : null
}
const SITE_TX = { name: 'earthStationLocation', lat: 'latitude', lon: 'longitude' }
const SITE_RX = { name: 'rxEarthStationLocation', lat: 'rxLatitude', lon: 'rxLongitude' }
function rowSite(row, g) {
  const lat = parseFloat(row && row[g.lat]), lon = parseFloat(row && row[g.lon])
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon, name: String(row[g.name] || '') } : null
}
// 站表行右键「在主窗口定位」：聚焦该行所用的卫星，画面正对本站
async function locateStationRow(row, side) {
  if (!row) return
  const id = satIdentOf(satOfRow(row))
  if (id) await sceneCmd('focusSat', id)
  const site = rowSite(row, side)
  if (site) await sceneCmd('faceLonLat', site)
}
// 星间 / 激光行：聚焦发射卫星（手动几何不选卫星，没有可定位的对象，不出这一项）
async function locateSpaceRow(row) {
  const id = row ? satIdentOf(resolveSatellite(row.txSatelliteId)) : null
  if (id) await sceneCmd('focusSat', id)
}
const ROW_LOC = '在主窗口定位'
const txRowMenu = [detailMenuItem(txStations), ...(sceneApi ? [{ label: ROW_LOC, icon: 'locate-fixed', run: (i) => { locateStationRow(txStations[i], SITE_TX) } }] : [])]
const rxRowMenu = [detailMenuItem(rxStations), ...(sceneApi ? [{ label: ROW_LOC, icon: 'locate-fixed', run: (i) => { locateStationRow(rxStations[i], SITE_RX) } }] : [])]
const islRowMenu = computed(() => (sceneApi && !geoManual.value ? [{ label: ROW_LOC, icon: 'locate-fixed', run: (i) => { locateSpaceRow(islLinks[i]) } }] : []))
const laserRowMenu = computed(() => (sceneApi && !geoManual.value ? [{ label: ROW_LOC, icon: 'locate-fixed', run: (i) => { locateSpaceRow(laserLinks[i]) } }] : []))
// 表格 Excel 导入 / 导出完成（StationGrid 的 xlsxDone）：导出回执带「打开 · 在文件夹中显示」，导入报行数
function onXlsxDone(e) {
  if (!e) return
  if (e.kind === 'export') toastFile('已导出 Excel', e.path || '')
  else if (e.kind === 'import') toast(`已导入 ${e.rows} 行`)
}
// 「卫星几何」卡的时刻：地面段＝典型时刻 t*，星间＝最差时刻 t*。主窗口时间轴拨过去、聚焦这颗星（星间取发射卫星），
// 并在时间轴上标出 t* 与本次的搜索时窗（同 src + label 覆盖上一次的标记）
async function locateGeomInMain(kind) {
  const l = sel.value
  if (!l) return
  const row = rowsOf(linkMode.value).find((r) => r._id === l.rowId) || null
  const g = kind === 'isl' ? islGeo.value : geom.value
  if (!g || !g.search) return
  const t = Date.parse(kind === 'isl' ? (g.worst && g.worst.worstISO) : g.search.typicalISO)
  if (!Number.isFinite(t)) return
  const s0 = Date.parse(g.search.t0ISO), hh = Number(g.search.horizonHours)
  if (Number.isFinite(s0) && hh > 0) await sceneCmd('markTime', { t0: s0, t1: s0 + hh * 3600000, label: '搜索时窗', src: 'regen' })
  await sceneCmd('markTime', { t0: t, label: 't*', src: 'regen' })
  await sceneCmd('seekClock', { tMs: t })
  const sat = kind === 'isl' ? (row ? resolveSatellite(row.txSatelliteId) : null) : (row ? satOfRow(row) : curSat.value)
  const id = satIdentOf(sat)
  if (id) await sceneCmd('focusSat', id)
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
// 带进来的星 → 卫星群条目：库里找同一颗（NORAD → 天线树 folder → 星名），没有就新建并按资源库取星器同一条路定轨
// （天线树节点 → 同 RegenSatPanel.onPickTree；目录星 → 星历池按 NORAD 反解 → 同 RegenSatPanel.pickSearch，星历点序列
// 取池的 orbitSpecOf；都取不到才退回手动轨道，高度 / 倾角取主窗口那一拍的值）
const ctxNameKey = (s) => String(s || '').trim().toLowerCase()
function ctxOrbitSnap(sf, s) {
  if (s.altKm != null) sf.orbitAltitude = String(Math.round(s.altKm))
  if (s.inclDeg != null) sf.orbitInclination = String(Math.round(s.inclDeg * 100) / 100)
}
async function satEntryForCtx(s) {
  const node = s.folder ? satTree.value.find((n) => n.folder === s.folder) : null
  const hit = (s.noradId && satConfigs.find((c) => c.ngsoSat && c.ngsoSat.noradId != null && String(c.ngsoSat.noradId) === s.noradId)) ||
    (node && satConfigs.find((c) => c.ngsoSat && c.ngsoSat.folder === node.folder)) ||
    (s.name && satConfigs.find((c) => ctxNameKey(c.form.satelliteName) === ctxNameKey(s.name)))
  if (hit) return hit
  satConfigs.push(makeSatConfig())
  const cfg = satConfigs[satConfigs.length - 1]
  const ns = cfg.ngsoSat, sf = cfg.form
  let rec = null, orbit = null
  if (!node && s.noradId) { try { rec = await findPoolByNorad(s.noradId) } catch (e) { rec = null } }
  // 池记录 → spec 走取星的唯一出口（satSearchPool.orbitSpecOf：目录星 OMM / 自定义星座六根数 / 星历点序列引用），不在这里分支手拼
  if (rec) { try { orbit = poolOrbitSpecOf(rec) } catch (e) { orbit = null } }
  if (node) {
    ns.mode = 'tree'; ns.name = node.satName; ns.noradId = node.noradId || null; ns.folder = node.folder
    sf.satelliteName = node.satName
    const treeOrbit = await treeNodeOrbit(node)
    if (ns.mode === 'tree' && ns.folder === node.folder) { ns.orbit = treeOrbit; orbitToForm(sf, treeOrbit) }   // 反解期间用户另选了星：不拿旧节点顶掉
  } else if (orbit) {
    ns.mode = 'search'; ns.name = rec.name; ns.noradId = rec.noradId || null; ns.folder = ''
    ns.orbit = orbit
    sf.satelliteName = rec.name
    orbitToForm(sf, orbit)
    if (orbit.type === 'ephem') ctxOrbitSnap(sf, s)   // 点序列没有平均根数可回显：轨道高度 / 倾角取主窗口那一拍（手动几何的斜距按它推）
  } else {   // 星历池里没有（离线 / 合成星）：留手动轨道
    if (s.name) sf.satelliteName = s.name
    ctxOrbitSnap(sf, s)
  }
  syncAutoNames(satConfigs, 'sat')
  return cfg
}

// —— 导入图上链路（星座 3D 主窗建的 STK Chain 式单向链路：模块栏「导入链路」对话框拉取 / tool:open 的 ctx.links 推送）——
// 本窗收「每颗星都按再生」的链路（链端星恒再生、中间星须勾再生；中间的地球站 = 地面转接站），其余计数跳过。逐跳拆行：
//   站 → 星 = 再生式上行一行 · 星 → 站 = 再生式下行一行 · 星 → 星 = 星间微波 / 激光一行（跳型由主窗定）。
//   星：satEntryForCtx（见上）；同一批里同一颗星（satKey）只解一次，解不出（定轨抛错）的那颗星所在链路算跳过。
//   配置：逐链路指定 → 就地追加，上 / 下行行写「卫星」列；统一指定且这批上 / 下行用的星全是本配置那颗 → 就地追加；
//         否则新建一份配置承接（空白配置 = 逐链路指定）。星间 / 激光行恒按行写发射 / 接收卫星。
//   模块：用到的按首次出现的次序补装（不带出厂默认行）；没有当前模块就切到第一个；已装模块的表里只有一条
//         没动过、没算过的出厂默认行时由导入行顶替。只追加，既有链路行与库条目一字不动。
//   站：站名与经纬度写进该行站址，其余取出厂默认，联动 autoGeo 补降雨 / 海拔；站带天线口径 / 天线罩 → 按站型对号
//       地球站库（shared/lbStationType.js，底本 = 库第一份），否则「地球站配置」留空（= 库第一份，同新增行）。
// 对话框那条入口也走 onToolContext 的队列：配置还没载入就排队，与主窗推来的上下文一次只处理一份。
const linkImpOpen = ref(false)
const onLinkImport = (list) => onToolContext({ links: list })
const ES_LOSS_KEYS = { up: 'uplinkOtherLoss', dn: 'downlinkOtherLoss' }   // 带罩时罩损并进上 / 下行「其他损耗」
// 站型对号 → { id, made } | null（站没带口径 / 罩：调用方沿用原引用）。新条目当场落库（id 规则同 duplicateEsConfig）
// 并取回响应式代理：同一批里下一个同口径同罩的站就命中它，不再另建一份。罩损档位取该行所用卫星的上 / 下行频率。
function esRefForSite(site, prefer, sat, tx) {
  const f = (sat && sat.form) || {}
  const t = esStationType(esConfigs, {
    diaM: Number(site && site.diaM), radome: !!site && site.radome === true, prefer,
    lossKeys: ES_LOSS_KEYS, freq: { up: Number(f.centerFrequency), dn: Number(f.rxCenterFrequency) },
    powerW: tx && site ? Number(site.pwrW) : null, powerKey: 'opPowerW'   // 功放功率只对发端站有意义
  })
  if (!t) return null
  if (t.hit) return { id: t.hit.id, made: false }
  esConfigs.push({ id: 'es' + (_esSeq++), name: t.make.name, nameAuto: t.make.nameAuto, form: t.make.form })
  syncAutoNames(esConfigs, 'es')
  return { id: esConfigs[esConfigs.length - 1].id, made: true }
}
// StationGrid「导入站址」写进带口径 / 罩的标记层地球站后回调（发 / 收信站表同一个键 stationId）：对号底本 = 该行此刻引用的那份
function applySiteType(row, kind, item) {
  if (!row || !item) return
  const ref = esRefForSite(item, resolveEs(row.stationId), satOfRow(row), kind !== 'rx')
  if (!ref) return
  row.stationId = ref.id
  if (ref.made) flushLibSave()   // 行里引用的条目先落盘（理由见 flushLibSave 头注）
}
const HOP_MODULE = { up: 'uplink', down: 'downlink', isl: 'isl', laser: 'laser' }
const okEsNode = (n) => !!n && n.t === 'es' && Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lon))
const okHop = (t, a, b) => (t === 'up' ? a.t === 'es' && b.t === 'sat'
  : t === 'down' ? a.t === 'sat' && b.t === 'es'
    : (t === 'isl' || t === 'laser') && a.t === 'sat' && b.t === 'sat')
function chainFits(c) {
  const ns = c && Array.isArray(c.nodes) ? c.nodes : []
  const hs = c && Array.isArray(c.hops) ? c.hops : []
  if (ns.length < 2 || hs.length !== ns.length - 1) return false
  if (!ns.every((n) => okEsNode(n) || (!!n && n.t === 'sat' && n.regen === true))) return false
  return hs.every((h, i) => !!h && okHop(h.type, ns[i], ns[i + 1]))
}
// 载荷的星节点 → satEntryForCtx 认的形状（noradId 恒为字符串，缺项一律空值）
const ctxSatOf = (n) => ({
  name: String(n.name || ''), noradId: n.noradId == null ? '' : String(n.noradId), folder: n.folder ? String(n.folder) : '',
  slotLon: Number.isFinite(n.slotLon) ? n.slotLon : null, altKm: Number.isFinite(n.altKm) ? n.altKm : null, inclDeg: Number.isFinite(n.inclDeg) ? n.inclDeg : null
})
// 没动过的出厂默认行：各字段仍是出厂值或留白、没有 SLA 采用值；斜距是手动几何按仰角 / 轨道高度回填的派生量，不算
// （同 moduleHasContent）；逐链路指定下「卫星」列等于切换归属时写进去的场景卫星也算；
// R0.01% / 海拔等于出厂时按默认站址写进去的值（seedDefaultSite）也算
function isFactoryRow(key, r) {
  if (!r || r.sla) return false
  const def = defaultsFor(fieldsOf(key))
  return Object.keys(r).every((k) => {
    if (k.startsWith('_') || k === 'slantRange' || k === 'rxSlantRange') return true
    const v = r[k] == null ? '' : String(r[k]).trim()
    if (v === String(def[k] == null ? '' : def[k]).trim() || isDefaultSiteSeed(k, v, defSite.value, sitesOf(key))) return true
    return k === 'satelliteId' && satLink.value && !!curSat.value && v === curSat.value.id
  })
}
async function importChains(chains) {
  const list = Array.isArray(chains) ? chains : []
  const fit = list.filter(chainFits)
  let skipped = list.length - fit.length
  try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ }   // 主窗刚加进天线树的星也按 folder 认得出
  const byKey = new Map(), jobs = []
  for (const c of fit) {
    const ents = []   // 与 c.nodes 逐位对齐：星节点 = 卫星群条目，站节点 = null
    for (const n of c.nodes) {
      if (n.t !== 'sat') { ents.push(null); continue }
      const k = String(n.key || '')
      let e = null
      if (k && byKey.has(k)) e = byKey.get(k)
      else {
        try { e = await satEntryForCtx(ctxSatOf(n)) } catch (err) { e = null }
        if (k) byKey.set(k, e)
      }
      if (!e) break
      ents.push(e)
    }
    if (ents.length < c.nodes.length) { skipped++; continue }
    jobs.push({ c, ents })
  }
  if (!jobs.length) { toast(byLang('没有可导入的链路', 'No applicable links')); return }
  const ground = new Set()   // 上 / 下行行所用的星
  for (const { c, ents } of jobs) {
    c.hops.forEach((h, i) => { if (h.type === 'up') ground.add(ents[i + 1].id); else if (h.type === 'down') ground.add(ents[i].id) })
  }
  if (!satLink.value && ![...ground].every((id) => !!curSat.value && curSat.value.id === id)) {
    const before = activeId.value
    await addBlankConfig(null)
    if (!activeId.value || activeId.value === before) return   // 没建成（未激活 / 写盘失败未离开）：不动现场
  }
  const used = []
  for (const { c } of jobs) for (const h of c.hops) { const k = HOP_MODULE[h.type]; if (!used.includes(k)) used.push(k) }
  for (const k of used) {
    const rows = rowsOf(k)
    if (!modules.value.includes(k)) modules.value = [...modules.value, k]
    else if (rows.length === 1 && !(linksBy[k] || []).length && isFactoryRow(k, rows[0])) rows.splice(0, 1)
  }
  if (!linkMode.value) linkMode.value = used[0]
  const SITE = {
    up: { rows: txStations, fields: TX_FIELDS, name: 'earthStationLocation', lon: 'longitude', lat: 'latitude', alt: 'altitude', geo: autoGeoTx },
    down: { rows: rxStations, fields: RX_FIELDS, name: 'rxEarthStationLocation', lon: 'rxLongitude', lat: 'rxLatitude', alt: 'rxAltitude', geo: autoGeoRx }
  }
  // 同一条图上链路（grp）按 Polygon / 航迹的代表点展开的各支路里，与多点节点不相邻的跳是同一行（Polygon 8 点 → 星 → 关口站：
  // 8 行上行 + 1 行下行，而不是 8 + 8）——逐跳拆行时按「跳类型 + 站址 + 两端卫星」认重，只在同一 grp 内认（不同链路照旧各成各行）
  const seen = new Set(), grpN = new Map()
  for (const { c } of jobs) if (c.grp) grpN.set(c.grp, (grpN.get(c.grp) || 0) + 1)   // 只有展开成多条支路的链路才认重（单条链路与改前逐行相同）
  const hopKey = (c, i, ents) => {
    const t = c.hops[i].type, a = c.nodes[i], b = c.nodes[i + 1]
    const site = t === 'up' ? a : t === 'down' ? b : null
    return [c.grp, t, site ? [site.name, site.lat, site.lon, site.altM].join('|') : '', ents[i] ? ents[i].id : '', ents[i + 1] ? ents[i + 1].id : ''].join('§')
  }
  let nRows = 0
  for (const { c, ents } of jobs) {
    for (let i = 0; i < c.hops.length; i++) {
      if (grpN.get(c.grp) > 1) { const k = hopKey(c, i, ents); if (seen.has(k)) continue; seen.add(k) }
      const t = c.hops[i].type, g = SITE[t]
      if (g) {
        const site = t === 'up' ? c.nodes[i] : c.nodes[i + 1]
        const sat = t === 'up' ? ents[i + 1] : ents[i]
        const r = newStation(g.fields)
        r[g.name] = site.name || ''; r[g.lon] = String(site.lon); r[g.lat] = String(site.lat)
        const fixAlt = Number.isFinite(site.altM)   // 航迹代表点带实际高度：「海拔」列写它，autoGeo 只补降雨率
        if (fixAlt) r[g.alt] = String(Math.round(site.altM))
        if (satLink.value) r.satelliteId = sat.id
        const ref = esRefForSite(site, esConfigs[0], sat, t === 'up')
        if (ref) r.stationId = ref.id
        g.rows.push(r)
        g.geo(g.rows[g.rows.length - 1], fixAlt ? new Set([g.alt]) : undefined)   // 取回响应式代理：autoGeo 异步回填才触发重绘
      } else {
        const r = newStation(t === 'laser' ? LASER_FIELDS : ISL_FIELDS)
        r.txSatelliteId = ents[i].id; r.rxSatelliteId = ents[i + 1].id
        // 手动几何：星间链路距离先填建议值（双 GSO = 定点弦长；其余 = 擦临边最大互视距离，最差工况上界），可改，或用「距离工具」按时间轴算
        if (geoManual.value) { const dk = suggestIslRangeKm(orbitSpecOf(ents[i]), orbitSpecOf(ents[i + 1])); if (dk > 0) r.islRangeKm = String(Math.round(dk * 10) / 10) }
        if (t === 'laser') laserLinks.push(r)
        else islLinks.push(r)
      }
      nRows++
    }
  }
  const n = new Set(jobs.map((j, i) => j.c.grp || '#' + i)).size   // 一条图上链路（grp）的各支路算一条
  toast(byLang(
    `已导入 ${n} 条链路（${nRows} 行）${skipped ? `，${skipped} 条不适用已跳过` : ''}`,
    `Imported ${n} link${n === 1 ? '' : 's'} (${nRows} row${nRows === 1 ? '' : 's'})${skipped ? `, ${skipped} skipped (not applicable)` : ''}`))
  await flushLibSave()
}

// ============ 状态序列化 / 持久化 / 命名配置 ============
// 场景自动保存：工作区恒对应配置列表里的一份，改动约 1 s 后写回 userData/configs.regen.json（见 useConfigAutosave）。
// localStorage 只记「上次打开的是哪一份」（{ activeId }）；v1.5.0 及以前这里存的是整份场景，载入时迁移一次（见 onMounted）。
const STATE_KEY = 'regen/last'

// _ 前缀键（行内部 id / 表格「＋增加」按全字段建行带出的计算列空键）一律剥离，不入场景
// ★ row.sla 是嵌套对象：从响应式行上浅拷出来的是 Vue 的 Proxy，结构化克隆过不了 ——
// saveConfig 走 IPC 当场抛「保存失败」。applyRowSla 内部 normRowSla 现造纯对象，顺手落平。
// row.cap（容量汇总的列入 / 载波数）同理：applyRowCap 现造纯对象
const stripRow = (r) => { const o = {}; for (const k of Object.keys(r)) if (!k.startsWith('_')) o[k] = r[k]; if (o.sla) applyRowSla(o, o.sla); if (o.cap) applyRowCap(o, o.cap); return o }
function serializeState() {
  // v3 场景 = 装了哪些模块（有序）+ 各模块的链路行（站址/链路量 + 各列引用的库条目 id）+ 模式/时窗等计算策略。
  // 三库是全局资产（userData/library.json），不再随场景存副本。没装的模块那张表就是空的。
  return {
    orbitType: 'REGEN', v: 3,
    linkMode: linkMode.value,
    modules: [...modules.value],
    tx: txStations.map(stripRow),
    rx: rxStations.map(stripRow),
    isl: islLinks.map(stripRow),
    laser: laserLinks.map(stripRow),
    satScope: satScope.value,   // 卫星参数归属：'link' 链路级（各行 satelliteId）/ 'config' 配置级（satId）
    satId: satId.value,
    geoMode: geoMode.value,
    geoHorizonHours: geoHorizonHours.value,
    ...geoT0State(geoT0Mode.value, geoT0ISO.value),   // 搜索起点：缺省（时间轴）不写，老场景载入再存逐字不变
    // SLA：采用值/勾选随行走（row.sla 由 stripRow 的「非 _ 键全存」自然带上），参数是场景级一份
    slaParams: { ...slaParams },
    capParams: normCapParams(capParams)   // 容量汇总：逐组（模块 × 卫星）的可用带宽与单价
  }
}
// 四张表（发信站 / 收信站 / 星间 / 激光，同屏只挂当前模块那一张）：载入配置时要清它们的撤销 / 重做栈
const txGridRef = ref(null), rxGridRef = ref(null), islGridRef = ref(null), laserGridRef = ref(null)
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // 换了一份内容（切换 / 新建 / 还原历史版本 / 导入）：表格撤销栈里存的是上一份的行，不清的话一按撤销
  // 就把它整张灌进当前配置、约 1 s 后自动写盘（模块不换时表格不重建，栈不会自己清）
  for (const g of [txGridRef, rxGridRef, islGridRef, laserGridRef]) if (g.value) g.value.clearHistory()
  // SLA 参数：旧场景没这一项 → 补缺省（normSlaParams 幂等，非法值也退缺省）
  Object.assign(slaParams, normSlaParams(st.slaParams))
  capParams.tp = normCapParams(st.capParams).tp   // 容量汇总参数：旧场景没这一项 → 空
  // 模块清单：v3 存 modules（有序、去重、只认四个 key）；v2 及以前按 hiddenModes 反推——四种全在，减去当时隐藏的，
  // 老配置打开来页签一个不少（隐藏的那几个连同它们的行在下次保存时才真正不存）。
  const mods = Array.isArray(st.modules)
    ? st.modules.filter((k, i, a) => MODE_KEYS.includes(k) && a.indexOf(k) === i)
    : MODE_KEYS.filter((k) => !(Array.isArray(st.hiddenModes) && st.hiddenModes.includes(k)))
  // 换场景：四个模块的结果全清（旧场景的结果对新场景没有意义；按行 _id 落表的映射一并删干净）。
  // 正显示着的详细预算（segments）不归哪个模块管，另清——新旧场景当前模块同名时 watch(linkMode) 不触发重取，
  // 不清就一直摆着上一份的瀑布、TSV 也照样能复制出来；聚焦行是上一份的行 _id，一并放掉。
  for (const k of MODE_KEYS) clearModuleResults(k)
  segments.value = []
  focusRowId.value = ''
  modules.value = mods
  linkMode.value = (st.linkMode && mods.includes(st.linkMode)) ? st.linkMode : (mods[0] || '')
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
      form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, modcodLabel: '', rateAnchor: 'info', rateAnchorValue: null, ...c.form }
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

  // row.sla 逐行深拷（applyRowSla 现造新对象、空的删键）：st 常常就是配置列表里那份 state，
  // 直接引用会让两处共用同一个 sla 对象，改采用值就地改掉了已保存的那份。
  // 合并默认：旧配置（G/T 尚在卫星侧时保存）的发信站行缺 G_Ts 一类字段，按默认补齐
  const mkRow = (fields, r) => { const o = { ...defaultsFor(fields), ...r, _id: 's' + (_sid++) }; applyRowSla(o, r.sla); applyRowCap(o, r.cap); return o }
  // 激光行只保留当前字段键（清除旧速率/调制/BER 等已删字段的惰性残留）
  const mkLaser = (r) => { const o = { ...defaultsFor(LASER_FIELDS), _id: 's' + (_sid++) }; for (const f of LASER_FIELDS) if (r[f.key] !== undefined) o[f.key] = r[f.key]; applyRowSla(o, r.sla); return o }
  // 装了的模块至少一条行（旧配置缺那张表 → 一条默认行，不留空表；上 / 下行默认行同 addModule 按默认站址写 R0.01% / 海拔）；
  // 没装的模块一行也不留
  const seed = (key, rows, mk) => {
    const arr = rowsOf(key)
    const src = mods.includes(key) ? ((rows && rows.length) ? rows : [seedDefaultSite(defaultsFor(fieldsOf(key)), defSite.value, sitesOf(key))]) : []
    arr.splice(0, arr.length, ...src.map(mk))
  }
  seed('uplink', txRows, (r) => mkRow(TX_FIELDS, r))
  seed('downlink', rxRows, (r) => mkRow(RX_FIELDS, r))
  seed('isl', islRows, (r) => mkRow(ISL_FIELDS, r))
  seed('laser', laserRows, mkLaser)
  satScope.value = st.satScope === 'config' ? 'config' : 'link'   // 旧场景无此字段 → 链路级（原口径）
  satId.value = st.satId || ''
  geoMode.value = st.geoMode === 'manual' ? 'manual' : 'auto'   // 旧场景无此字段 → 自动最差（原行为）
  if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
  // 搜索起点随场景：旧场景无此两键 → 时间轴（每份场景都显式落定，不沿用上一份的设置）
  geoT0Mode.value = normGeoT0Mode(st.geoT0Mode)
  geoT0ISO.value = normGeoT0ISO(st.geoT0ISO)
}
// 场景一变就交给自动保存（防抖写回当前配置）；「上次打开的是哪一份」随 activeId 记一笔
watch([txStations, rxStations, islLinks, laserLinks, satScope, satId, geoMode, geoHorizonHours, geoT0Mode, geoT0ISO, linkMode, modules, slaParams, capParams], () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* ignore */ } })

// —— 命名配置 CRUD ——
// 树本身的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js（见文件上方 useConfigTree(...) 注入点）。
// 这里只留本窗特有的几件：配置的自动名、空白配置的内容、确认框。
// 注意：Electron 渲染进程没有 window.prompt / confirm（静默返回 null → 早先「保存不了」的根因），一律用应用内弹窗。
// 自动名（名字随内容的配置用）：卫星名 + 装了的模块（按模块栏次序并列）+ 全部链路条数，按平台语言出字
const CFG_KIND = { uplink: ['再生上行', 'OBP Uplink'], downlink: ['再生下行', 'OBP Downlink'], isl: ['再生星间', 'OBP ISL'], laser: ['再生激光星间', 'OBP Optical ISL'] }
const kindText = (mods) => {
  const kinds = (mods || []).filter((k) => CFG_KIND[k]).map((k) => byLang(CFG_KIND[k][0], CFG_KIND[k][1]))
  return kinds.length ? kinds.join(byLang('+', ' + ')) : byLang('再生式', 'OBP')
}
function defaultCfgName() {
  // 卫星名称的出厂占位符「Satellite」不算星名，略去（与资源库条目自动命名同一口径）
  const s = [...new Set(sceneSatName.value.split(' / ').map((x) => x.trim()).filter((x) => !isSatNamePlaceholder(x)))].join(' / ')
  const n = modules.value.reduce((a, k) => a + rowsOf(k).length, 0)
  return (s ? s + ' ' : '') + `${kindText(modules.value)} ${n} ${byLang('条', n === 1 ? 'link' : 'links')}`
}
// 历史版本那一列读数：按【存档内容】出模块与条数（留档的是当时的场景，不是工作区）
const MOD_ROWS = { uplink: 'tx', downlink: 'rx', isl: 'isl', laser: 'laser' }
function cfgLabelOf(st) {
  if (!st || typeof st !== 'object') return ''
  const mods = Array.isArray(st.modules) ? st.modules : []
  const n = mods.reduce((a, k) => a + (Array.isArray(st[MOD_ROWS[k]]) ? st[MOD_ROWS[k]].length : 0), 0)
  return `${kindText(mods)} ${n} ${byLang('条', n === 1 ? 'link' : 'links')}`
}


// 默认（空白）配置内容：一个计算模块都没有（用户按需从模块栏添加），四张表都是空的，不内嵌三库。
// state.orbitType 照写：瀑布表/报表按它分体制（配置库的归属已改由文件分家决定，是另一件事）。
function blankState() {
  return {
    orbitType: 'REGEN', v: 3, linkMode: '', modules: [],
    tx: [], rx: [], isl: [], laser: [],
    satScope: 'link', satId: '',
    geoMode: 'manual', geoHorizonHours: 24,
    slaParams: { ...DEFAULT_SLA_PARAMS },
    capParams: { tp: {} }
  }
}
// 指纹只取「场景内容」字段（库是全局资产、结果列勾选是视图态，均不入指纹）。装了哪些模块是内容。
// SLA：采用值/勾选在四张表的行里（row.sla）自然计入；参数是场景级，显式列进来。
// 容量汇总参数同理（场景级）；规整后再比——旧场景没这一项与「一项都没填」是同一份内容
function fingerprintOf(s) {
  return stableStringify({ tx: s.tx, rx: s.rx, isl: s.isl, laser: s.laser, satScope: s.satScope || 'link', satId: s.satId || '', geoMode: s.geoMode || 'auto', geoHorizonHours: s.geoHorizonHours, geoT0: geoT0State(s.geoT0Mode, s.geoT0ISO), linkMode: s.linkMode, modules: s.modules, slaParams: s.slaParams, capParams: normCapParams(s.capParams) })
}
// 一份配置刚载入工作区：以当前内容为已落盘基线（useConfigTree 在载入 / 新建后调）
function setBaseline() { autosave.attach() }
function isDirty() { return autosave.isDirty() }
// 离开当前配置（切换 / 新建 / 副本）前：把没落盘的改动写进去；写不进去（盘满 / 文件被占用 / 未激活）才问一句
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}
const deviceId = ref('')
const shareConfigured = ref(false)
// —— 分享 / 导入（弹窗与全部流程在 components/LbShareDialog.vue，三窗共用）——
// 本窗口只提供「体制适配层」：本机有哪些配置与库、场景引用了哪些条目、并库后怎么改写引用。
const shareOpen = ref(false)
// 先把没落盘的改动写进去：分享框列的是配置列表里的存档，当前这份要与屏幕一致（结果才能随它带走）
async function openShareDlg() { await autosave.flush(); shareOpen.value = true }
const packBase = (c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })
// 卫星的 sanitize（shared/lbShare.js 的 shareNgsoSat，与 NGSO 共用）：ngsoSat.folder 是【本机】卫星树取星的节点 id
// （见 RegenSatPanel 的 tree 下拉），原样发过去只会指到对端另一颗星上，故打包时清空；取星来源随之由 'tree' 改标 'search'
// （有轨道根数时）——orbit / name / noradId 是自包含数据，照带不误，对端照样按这条轨道解几何。
// ★ 早先降成 'manual'：orbitSpecOf 只认「mode ≠ manual 且有 orbit」，对端于是丢了轨道、按表单圆轨道算。
const shareLib = {
  es: { arr: esConfigs, label: '地球站', keys: [], pack: packBase, makeNew: () => makeEsConfig('站型') },
  carrier: { arr: basebandConfigs, label: '载波', keys: [], pack: packBase, makeNew: () => makeBasebandConfig('载波') },
  sat: {
    arr: satConfigs, label: '卫星', keys: ['ngsoSat'],
    pack: (c) => ({ ...packBase(c), ngsoSat: normNgsoSat(c.ngsoSat) }),
    sanitize: (e) => ({ ...e, ngsoSat: shareNgsoSat(normNgsoSat(e.ngsoSat)) }),
    makeNew: () => makeSatConfig('卫星')
  }
}
// 再生式一个场景有四张表：地面上/下行（tx/rx）+ 星间微波（isl）+ 星间激光（laser）
function shareRefsOf(st) {
  if (!st || !(st.v >= 2)) return { es: [], carrier: [], sat: [] }
  const es = [], carrier = [], sat = []
  // 卫星按该场景的归属取：链路级引用各站行「卫星」列，配置级引用场景单选；星间行恒按行引用两端卫星
  const link = st.satScope !== 'config'
  for (const r of [...(st.tx || []), ...(st.rx || [])]) { es.push(r.stationId || ''); carrier.push(r.basebandId || ''); if (link) sat.push(r.satelliteId || '') }
  if (!link) sat.push(st.satId || '')
  for (const r of [...(st.isl || []), ...(st.laser || [])]) { carrier.push(r.basebandId || ''); sat.push(r.txSatelliteId || '', r.rxSatelliteId || '') }
  return { es, carrier, sat }
}
// 打包前把空引用钉成显式 id：'' 的意思是「用库里第一份」，到了对端就成了「用他库里第一份」
function sharePinRefs(st) {
  if (!st || !(st.v >= 2)) return st
  const s = JSON.parse(JSON.stringify(st))
  const link = s.satScope !== 'config'
  for (const r of [...(s.tx || []), ...(s.rx || [])]) {
    r.stationId = resolveRefId(esConfigs, r.stationId)
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
    if (link) r.satelliteId = resolveRefId(satConfigs, r.satelliteId)
  }
  if (!link) s.satId = resolveRefId(satConfigs, s.satId)
  for (const r of [...(s.isl || []), ...(s.laser || [])]) {
    r.basebandId = resolveRefId(basebandConfigs, r.basebandId)
    r.txSatelliteId = resolveRefId(satConfigs, r.txSatelliteId)
    r.rxSatelliteId = resolveRefId(satConfigs, r.rxSatelliteId)
  }
  return s
}
function shareRemap(state, idMap) {
  if (!state) return
  if (state.satId) state.satId = idMap.sat[state.satId] || ''
  // 容量汇总参数的组键里带卫星 id：随卫星一起换成对端库里的 id（对端没收的星，那组设置丢掉）
  if (state.capParams) state.capParams = remapCapParams(state.capParams, idMap.sat)
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
  // 不再给 getDraft：自动保存下工作区恒是某一份配置，没有「当前工作参数」这种草稿
  lib: shareLib,
  refsOf: shareRefsOf,
  pinRefs: sharePinRefs,
  remapState: shareRemap,
  saveConfig: (payload) => api.store.saveConfig('regen', payload),
  flushLib: flushLibSave,
  onImported: async ({ last, plan, idMap }) => {
    if (last) await autosave.flush()   // 换到导入的那份之前，当前配置的改动先落盘
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
// 交付级报告：流程在 shared/useLbReport.js（四窗共用），此处只接本窗数据源。
// 报告讲【整份配置】：装了几个模块就分几节（次序 = 模块栏次序），导出前把没算过 / 已过期的模块补算
// （beforeReport），取图时逐节切换工作台（activateSection）。链路自带 mode，各取数闭包按它找行 / 定口径。
// 几何上下文分两族：地面-空间（上/下行）传 geom+access+staGeo，空间-空间（星间）传 islGeo。
const vizRef = ref(null)
const appVersion = ref('')
const REGEN_MODE_LABEL = {
  uplink: ['给定工作点', 'Given operating point'],
  downlink: ['给定工作点 G/T', 'Given G/T operating point'],
  isl: ['给定 EIRP/G-T + 严格几何', 'Given EIRP/GT + rigorous geometry'],
  laser: ['给定灵敏度 + 光学功率预算', 'Given sensitivity + optical power budget']
}
const REGEN_FILE_NAME = {
  uplink: ['再生式上行链路预算报告', 'Regen_Uplink_Report'],
  downlink: ['再生式下行链路预算报告', 'Regen_Downlink_Report'],
  isl: ['再生式星间链路预算报告', 'Regen_ISL_Report'],
  laser: ['再生式激光星间链路预算报告', 'Regen_Laser_ISL_Report'],
  multi: ['再生式链路预算报告', 'Regen_Link_Budget_Report']
}
const modeCalcLabel = (k) => { const m = REGEN_MODE_LABEL[k] || REGEN_MODE_LABEL.uplink; return reportLang.value === 'en' ? m[1] : m[0] }
// 进报告的模块 = 装了且有链路行的（空表没东西可报），次序 = 模块栏次序
const reportModules = computed(() => modules.value.filter((k) => rowsOf(k).length))
const canReport = computed(() => reportModules.value.length > 0)
const reportLinkCount = computed(() => reportModules.value.reduce((n, k) => n + rowsOf(k).length, 0))
const reportSectionInfo = computed(() => reportModules.value.map((k) => ({ key: k, label: modeOf(k).label, count: rowsOf(k).length })))
// 导出前补算：没算过或输入已变的模块逐个算一遍（算过且未过期的原样用），进度写进对话框；
// 模块级报错（没卫星 / 没站）就中止导出——逐行的失败照旧作为「计算失败」链路进报告
async function computeMissing(step) {
  const todo = reportModules.value.filter((k) => !(linksBy[k] || []).length || staleBy[k])
  for (let i = 0; i < todo.length; i++) {
    const k = todo[i]
    if (step) step((reportLang.value === 'en' ? 'Computing: ' : '计算：') + modeOf(k).label, i, todo.length)
    await computeModule(k)
    if (errorBy[k]) throw new Error(modeOf(k).label + '：' + errorBy[k])
  }
}
let _selSnap = null   // 导出前各模块的选中行：取图会逐条切过去，结束后还原
const { reportDlg, reportVariant, openReportDialog, openSlaReportDialog, openCapReportDialog, submitReport } = useLbReport({
  api,
  orbitType: 'REGEN',
  regenMode: () => linkMode.value || 'uplink',
  fieldGroups: FIELD_GROUPS,
  nextTick,
  links: () => reportModules.value.flatMap((k) => linksBy[k] || []),
  canReport: () => canReport.value,
  sections: () => reportModules.value.map((k) => ({ key: k, regenMode: k, links: linksBy[k] || [] })),
  activeSection: () => linkMode.value,
  activateSection: async (k) => { if (k && modules.value.includes(k)) { linkMode.value = k; await nextTick() } },
  beforeReport: async (step) => { _selSnap = { ...selectedBy }; await computeMissing(step) },
  afterReport: async () => {
    if (_selSnap) { for (const k of MODE_KEYS) if (_selSnap[k] != null && _selSnap[k] < (linksBy[k] || []).length) selectedBy[k] = _selSnap[k]; _selSnap = null }
    await loadWaterfall()
  },
  selected: () => selected.value,
  setSelected: (i) => { selected.value = i },
  showViz: () => showViz.value,
  vizRef: () => vizRef.value,
  lang: () => reportLang.value,
  appVersion: () => appVersion.value,
  // 「输入参数」清单的取值源：留底入参按本链路所属模块投影到参与计算的字段上（regenDigestParams）——
  // 上行不印镜像的收信站群、下行不印上行占位、星间不印「发 / 收」两座假站；组外的键一律不交，对应那几组整块不出
  paramsFor: (l) => regenDigestParams(l && l.mode, (l && sweepParamsByRow.value[l.rowId]) || null),
  // 总报告「逐参数对照」头两行（标准 / 调制编码）：交出这条链路引用的载波表单，标准名由 useLbReport 解析
  //（四种链路行都挂 basebandId；激光那两行主进程整个不出，见 report.js summaryRows）
  carrierOf: (l) => {
    const row = rowOfLink(l)
    return row && row.basebandId !== undefined ? resolveBaseband(row.basebandId).form : null
  },
  basebandOpts: () => basebandOpts.value,
  // SLA 建议（§4）：逐链路出纯数据块（标签按报表语言翻好、速率/带宽按当前单位档格式化）
  slaFor: (l) => {
    const row = rowOfLink(l)
    return slaReportBlock(slaDerivedFor(l), row && row.sla, slaParams, reportLang.value,
      (v, u) => fmtQtyParts(v, u, unitAdaptive.value))
  },
  slaParams: () => slaParamRows(slaParams, reportLang.value),
  // 容量汇总（§2）：逐节（模块）一张，与弹窗同一份账；激光那一节没有容量口径（capModelOf 给 null → 不出）
  capFor: (key, lang, noOf) => capReportBlock(capModelOf(key), { lang, adaptive: unitAdaptive.value, noOf }),
  // 独立《容量汇总》报告：讲整份配置（逐模块一节，同总报告 §2）；激光那一节 capModelOf 给 null → 不出
  capModelFor: (key) => capModelOf(key),
  capDefaultName: (en) => {
    const s = sceneSatName.value || (en ? 'Results' : '结果')
    return en ? `REGEN_Capacity_${s.replace(/[^\w-]+/g, '_')}` : `再生式容量汇总_${s.replace(/[\\/:*?"<>|]/g, '_')}`
  },
  beforeSla: ensureSlaScanAll,   // 导出含 SLA 的报告前把每个模块的惰性扫描补齐
  // 「计算方式」一栏报的是这条链路所属模块的口径（上行/下行/星间/激光各一句）；求解策略随载波逐链路而定，
  // 另占「求解方式」一行（取计算时留底的那份入参，此后改库不改已出结果的口径）。星间/激光无求解方式——工作点由链路自身参数给定。
  calcFor: (l) => {
    const out = { mode: modeCalcLabel(l && l.mode) }
    const p = l && sweepParamsByRow.value[l.rowId]
    const key = (p && p.opt && p.opt.mode) || ''
    const info = CALC_MODES.find((m) => m.key === key)
    if (!info) return out
    out.solveMode = reportLang.value === 'en' ? info.enLabel : info.label
    out.targetMargin = key === 'margin' ? ((p.linkParams && p.linkParams.margin) || '') : ''
    return out
  },
  calc: () => ({
    // 场景级「计算方式」= 各模块口径并列（逐链路那一行由 calcFor 按各自模块给）
    mode: [...new Set(reportModules.value.map(modeCalcLabel))].join(' / ') || modeCalcLabel('uplink'),
    satelliteName: sceneSatName.value,
    frequencyBand: sceneBand.value
  }),
  extraLink: (l) => {
    const mode = l.mode || linkMode.value
    const isDown = mode === 'downlink'
    const isSpace = mode === 'isl' || mode === 'laser'
    const clone = (x) => (x ? JSON.parse(JSON.stringify(x)) : null)
    // 站址透传（上行取发信站、下行取收信站）→「几何关系」sheet 按 STK 口径标注坐标/最低仰角；
    // 取入算值（留空格即灰字那个值），与这条链路实际解的几何一致
    let staGeo = null
    if (!isSpace) {
      if (isDown) { const st = effRx(rxStations[l.ti] || {}); staGeo = { name: l.txName, lat: parseFloat(st.rxLatitude), lon: parseFloat(st.rxLongitude), altM: parseFloat(st.rxAltitude) || 0, minEl: parseFloat(st.rxMinElevation) || 0 } }
      else { const st = effTx(txStations[l.ti] || {}); staGeo = { name: l.txName, lat: parseFloat(st.latitude), lon: parseFloat(st.longitude), altM: parseFloat(st.altitude) || 0, minEl: parseFloat(st.minElevation) || 0 } }
    }
    return {
      // 下行的信号流向是「卫星 → 收信站」，链路两端名字据此对调（与结果区一致）
      txName: isDown ? l.satName : l.txName,
      rxName: isDown ? l.txName : l.satName,
      geom: clone(l.geom), islGeo: clone(l.islGeo), access: clone(l.access),
      staGeo, satName: l.satName
    }
  },
  // —— 独立《服务等级指标（SLA）》报告：不取图、不组瀑布，只把各链的 SLA 块与档位表组成模型（整份配置）——
  slaCount: () => slaCountAll.value,
  slaMonthly: () => (Number(slaParams.monthly) ? 1 : 0),
  slaComposition: (k) => slaComposition({ orbitType: 'REGEN', regenMode: k || linkMode.value || 'uplink', slaParams }, reportLang.value),
  slaExtra: (l) => slaReportExtra(l),
  slaDefaultName: (en) => slaDefaultNameOf(en),
  // 文件名：只装一个模块时沿用该模块的名字，装了几个就叫「再生式链路预算报告」
  defaultName: (en) => {
    const mods = reportModules.value
    const n = (mods.length === 1 ? REGEN_FILE_NAME[mods[0]] : null) || REGEN_FILE_NAME.multi
    const s = sceneSatName.value || (en ? 'Results' : '结果')
    return en ? `${n[1]}_${s.replace(/[^\w-]+/g, '_')}` : `${n[0]}_${s.replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  toastFile,
  setError: (m) => { if (linkMode.value) error.value = m; else toastError(m) }   // 没开模块时报错进常驻通知条（不随 4 s 回执消失）
})

// ============ 城市库 + 启动恢复 + 关窗守卫 ============
const cities = ref([])
onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  // 默认站址的降雨率 / 海拔先于配置载入：装上 / 补出的上下行默认行要按它写 R0.01% / 海拔
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
  if (last && (Array.isArray(last.modules) || Array.isArray(last.tx)) && last.activeId && last.activeId === activeId.value) { applyState(last); autosave.touch() }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* ignore */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  groundPreview.refresh()   // 站表实时列首填（默认站址取值已就位：站址留空的行也按它算）
  // 关窗：把场景与资源库挂起的写盘冲掉即放行（观感上秒关）；只有场景写不进磁盘时才问一句
  api?.regen?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    await flushLibSave()
    if (!ok && !(await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
    api.regen.confirmClose()
  })
  stopAutosaveListen = autosave.listen()   // 窗口失焦 / 页面隐藏时立即写盘
  window.addEventListener('keydown', onGlobalKey)   // Ctrl+Enter = 计算（按体制分发）
  window.addEventListener('focus', reloadSatTree)   // 单例窗口：切回本窗口即按卫星树重解已选星（3D 页改了根数 / 历元即跟上；同 NGSO / 端到端）
  window.addEventListener('focus', mergeLibFromDisk)   // 同上：并入别的窗口复制来的库条目
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
            <LbLibrary v-else-if="libTab === 'sat'" v-model="selSatId" layout="column" :items="satConfigs" :summary="satSummary" name-placeholder="卫星名（列表用）"
              auto-tip="所选卫星" :copy-targets="copyTargetsOf('sat')" @copy-to="(c, ns) => copyLibTo('sat', c, ns)"
              @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此卫星的副本" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此卫星（被引用时提示引用数）" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <!-- 取星只定轨道（卫星/天线树 / 星历搜索）；EIRP·G/T 逐行手填。
                   :key＝条目 id：换条目即重建编辑器——同一实例换 form，频段 watcher 会把「换条目」当成「改频段」套预设。 -->
              <template #default="{ cfg }"><RegenSatPanel :key="cfg.id" :form="cfg.form" :fields="SAT_FIELDS" :ngso-sat="cfg.ngsoSat" :sat-tree="satTree" /></template>
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

      <!-- ② 主区：MATLAB 式功能区 + 停靠面板 -->
      <section class="lb-col lb-build">
        <!-- 功能区：文件 · 计算 · 视图 · 导出 ‖ 状态位（计算方式随载波入资源库，功能区只留执行） -->
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <div class="lbr-form">
                <!-- 原第三行「工作点 · 随站型」是固定说明（CLAUDE.md），已删，三行竖排还会把功能区撑高一截；
                     其口径挪到本组组名「计算」的 title 上。★ 不并进下面「几何」的 title：英文界面按整串查词典，
                     拼出来的新串查不到，会译成中英夹杂的残句 -->
                <label title="几何来源（四种体制统一）：自动最差＝按卫星轨道解最差工况几何（星地：仰角字段作门限、斜距由求解器给出；星间：两星轨道解最差星间距离与互视可见度）；手动＝星地斜距与星间链路距离由表内逐行给定，不解算轨道"><span>几何</span>
                  <select v-model="geoMode" style="width: 86px"><option v-for="g in GEO_MODES" :key="g.v" :value="g.v">{{ g.l }}</option></select>
                </label>
                <label v-if="!geoManual" title="在此时窗内求几何最差工况并列出全部满足最低仰角的访问窗口（选星走 SGP4；手动圆轨道为示意）"><span>时窗</span>
                  <select v-model.number="geoHorizonHours" style="width: 86px"><option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option></select>
                </label>
              </div>
              <!-- 搜索起点另起一列（第三行会把功能区撑高）：指定档在下一行给时刻框 + 时区角标 -->
              <div v-if="!geoManual" class="lbr-form">
                <label title="搜索时窗起点：时间轴＝主窗口时间轴当前时刻；系统时钟＝点「计算」时的系统时间；指定＝给定时刻（随配置保存）"><span>起点</span>
                  <select v-model="geoT0Mode" style="width: 86px"><option v-for="m in GEO_T0_MODES" :key="m.v" :value="m.v">{{ m.l }}</option></select>
                </label>
                <div v-if="geoT0Mode === 'fixed'" class="lbr-row">
                  <input type="datetime-local" step="1" class="lbr-dt" title="搜索时窗起点" :value="t0Val" @input="t0Draft = $event.target.value" @blur="t0Commit" @keyup.enter="t0Commit" />
                  <TzPicker v-model="tzMode" :ms="t0RefMs" class="lbr-tz" title="时刻的时标时区：本机 / UTC / UTC±N">{{ t0TzTag }}</TzPicker>
                </div>
              </div>
              <button class="lbr-big primary" :disabled="computing || !linkMode" :title="linkMode ? `计算当前模块全部 ${nLinks} 条${modeLabel}链路（Ctrl+Enter）` : '尚无计算模块'" @click="computeActive">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
            </div>
            <div class="lbr-cap" title="功放与余量随站型设置——在各站所选「地球站配置」的发射参数（工作点）中">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <!-- 配置自动保存（无「保存」按钮）：这里是它的后悔药；写盘失败时旁边多出一枚告警，单击即重试 -->
              <button class="lbr-big" :disabled="!api || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
              <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
              <button class="lbr-big" :disabled="!api" title="分享 / 导入：配置（可多选）+ 资源库条目（可多选）——分享码 / 文件 / 发给用户ID" @click="openShareDlg"><Icon name="external-link" :size="16" />分享</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（卫星/天线树 / 城市库 / 载波信号选项 等）" @click="refreshLatest">
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
              <button class="lbr-big" :class="{ on: showViz }" :aria-pressed="showViz ? 'true' : 'false'" :title="showViz ? '隐藏详细预算的图表区（地理场图 + 链路视图）' : '显示详细预算的图表区：链路视图（3D 站星几何）+ 地理场图（站址经纬度；星间无地面站，仅输出链路视图）'" @click="showViz = !showViz"><Icon name="chart-line" :size="16" />图表</button>
            </div>
            <div class="lbr-cap">视图</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!nLinks" :title="nLinks ? '按当前计算结果给出 SLA 条款建议值：可用度 / 带宽与速率 / 时延与丢包 / 故障响应与恢复 / 发射合规（逐条可改采用值、可勾选列入报告）' : '暂无链路。'" @click="openSlaDlg">
                <Icon name="shield-check" :size="16" />
                SLA
              </button>
              <button class="lbr-big" :disabled="!nLinks || linkMode === 'laser'"
                :title="linkMode === 'laser' ? '星间激光链路无容量汇总' : (nLinks ? '容量汇总：逐转发器汇总容量与带宽，对照可用资源（可勾选链路，设载波数、可用资源与单价）' : '暂无链路。')" @click="openCapDlg">
                <Icon name="sigma" :size="16" />
                容量
              </button>
              <button class="lbr-big" :disabled="reportDlg.busy || !canReport" :title="canReport ? '生成整份配置的交付级报告（每个模块一节；未计算的模块在导出前自动补算）：Excel（总报告 + 几何关系 + 逐链路详情）/ Word / PDF（封面 · 目录 · 总报告 · 逐链路详情，含图）' : '尚无计算模块'" @click="openReportDialog"><Icon name="file-export" :size="16" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
              <button class="lbr-big" :disabled="!segments.length" title="复制当前瀑布表（TSV，可直接粘贴到 Excel / 报告）" @click="copyWaterfallTsv"><Icon name="copy" :size="16" />TSV</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <LbDispCtl />
        </div>

        <!-- 模块栏：装了的计算模块各一个页签（状态点 · 名字 · 链路数 · ×，可拖拽换序），末尾「＋ 添加模块」「导入链路」；
             一个都没装时分区流里是空态。页签次序 = 报告分节次序。 -->
        <div class="rlmode">
          <div v-for="m in activeModules" :key="m.key" class="rlmode-i" :class="{ on: linkMode === m.key, dragging: dragKey === m.key }" :title="m.tip"
               draggable="true" @click="linkMode = m.key"
               @dragstart="onModDragStart(m.key, $event)" @dragover.prevent="onModDragOver(m.key)" @dragend="onModDragEnd" @drop.prevent="onModDragEnd">
            <span v-if="modStatus(m.key)" class="rlmode-dot" :class="modStatus(m.key)" :title="modStatus(m.key) === 'stale' ? '输入已变' : '已计算'"></span>
            <span class="rlmode-lbl">{{ m.label }}</span>
            <span class="rlmode-n">{{ rowsOf(m.key).length }}</span>
            <span class="rlmode-x" title="移除该模块" @click.stop="removeModule(m.key)">
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" /></svg>
            </span>
          </div>
          <div class="rlmode-add-wrap">
            <button class="rlmode-add" :class="{ on: addMenuOpen }" :aria-pressed="addMenuOpen ? 'true' : 'false'" :disabled="!addableModes.length" :title="addableModes.length ? '添加计算模块' : '四种模块已全部添加'" @click.stop="addMenuOpen = !addMenuOpen">
              <svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 2v8M2 6h8" /></svg><span class="rlmode-add-t">添加模块</span>
            </button>
            <template v-if="addMenuOpen">
              <div class="rlmode-menu-mask menu-mask" @click="addMenuOpen = false"></div>
              <div class="rlmode-menu menu" role="menu" @click.stop>
                <div class="rlmode-menu-hd menu-hd">添加模块</div>
                <button v-for="m in LINK_MODES" :key="m.key" type="button" class="rlmode-menu-i menu-item" role="menuitem" :class="{ added: modules.includes(m.key) }" :title="m.tip" @click="addModule(m.key)">
                  <span class="rlmode-menu-ck menu-ck"><Icon v-if="modules.includes(m.key)" name="check" :size="12" /></span>{{ m.label }}
                </button>
              </div>
            </template>
          </div>
          <!-- 图上链路逐跳拆进各模块（缺的模块随之补装），故放在模块栏而非某张链路表的节头：一个模块都没装时也够得着 -->
          <button class="lb-mini" title="导入主窗口「目标间链路建链」中建立的链路" @click="linkImpOpen = true">导入链路</button>
        </div>

        <!-- 全宽分区流：当前模块的链路表分区 → 详细预算分区；没装模块时是空态 -->
        <div ref="flowEl" class="lbx-flow lbx-cards" :class="{ 'lbx-stale-res': !!(resultsStale && links.length) }">
          <div v-if="!activeModules.length" class="rlmode-empty">
            <div class="rlmode-empty-t">尚无计算模块。</div>
            <div class="rlmode-empty-btns">
              <button v-for="m in LINK_MODES" :key="m.key" class="rlmode-empty-b" :title="m.tip" @click="addModule(m.key)">
                <svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 2v8M2 6h8" /></svg>{{ m.label }}
              </button>
            </div>
          </div>
          <!-- 卫星分区：只在「统一指定」且是上/下行两个地面模块时出现（星间链路两端恒按行选星，无场景级卫星可言；
               逐链路指定时卫星在站表「卫星」列里逐行选，这里再报一颗星只会混淆）：卫星库单选 + 星名 + 频率 / 轨道读数 -->
          <LbSection v-if="!satLink && (linkMode === 'uplink' || linkMode === 'downlink')" id="sat" title="卫星">
            <template #actions>
              <button class="lb-mini" title="到资源库编辑当前卫星：取星定轨 + 频率极化 + 干扰系数" @click="editInLibrary('sat')">编辑参数</button>
            </template>
            <div class="lbx-satband">
              <div class="lbx-satline">
                <span class="lbx-satgut">配置</span>
                <div class="lbx-satmain">
                  <select class="lbx-satsel" :value="(curSat && curSat.id) || ''"
                    title="从卫星库选择本配置使用的卫星（统一指定：上/下行全部链路共用；轨道来源随卫星条目走）" @change="satId = $event.target.value">
                    <option v-for="o in satPickOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
                  </select>
                  <span v-if="curSat" class="lbx-satname" title="卫星名称：取星后由所选卫星确定" data-i18n-skip>{{ satNameOf(curSat) }}</span>
                  <span class="lbx-satnote">全部 {{ nLinks }} 条链路共用</span>
                </div>
              </div>
              <div v-for="ln in satBandLines" :key="ln.k" class="lbx-satline">
                <span class="lbx-satgut">{{ ln.label }}</span>
                <div class="lbx-satmain lbx-satkv">
                  <span v-for="k in ln.items" :key="k.key" class="lbx-kv" :title="k.tip || null">
                    <span class="lbx-kv-l">{{ k.label }}</span>
                    <span class="lbx-kv-v">{{ k.value }}<i v-if="k.unit" :class="{ tight: k.tight }">{{ k.unit }}</i></span>
                  </span>
                </div>
              </div>
            </div>
          </LbSection>
          <LbSection v-if="linkMode === 'uplink'" id="tx" title="发信站群" :count="txStations.length">
            <template #actions>
              <!-- 卫星的指定方式（场景级，上/下行共用一个开关）：统一指定＝上方「卫星」分区单选一颗；逐链路指定＝站表「卫星」列逐行选，上方分区收起 -->
              <span class="lbx-segwrap" title="卫星的指定方式（上/下行两个地面模块）：统一指定＝本配置仅使用一颗卫星（在上方「卫星」分区选择，全部链路共用，站表不出「卫星」列）；逐链路指定＝站表每行各选卫星（「卫星」列，上方分区随之收起）。星间微波 / 激光链路恒按行指定发射 / 接收卫星。切到逐链路指定：上/下行站表「卫星」列为空的行填入统一指定的卫星，已有选择的行不变；切到统一指定：全部链路改用当前站表首行所用的卫星">
                <span class="lbx-segl">卫星</span>
                <span class="lbu-seg"><button v-for="s in SAT_SCOPES" :key="s.v" :class="{ on: satScope === s.v }" :aria-pressed="(satScope === s.v) ? 'true' : 'false'" @click="setSatScope(s.v)">{{ s.l }}</button></span>
              </span>
              <button class="lb-mini" :disabled="!geoManual" title="斜距工具：按轨道高度 × 仰角计算斜距，可按各行仰角批量填入「斜距」列（几何=手动时可用）" @click="slantToolOpen = true">斜距工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="12" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" :class="{ dragging: !!colDrag.key }" @wheel="onColPickWheel">
                  <!-- 拖左侧把手换位＝改表里结果列的次序（本行读数同序）；勾选框只管显示与否 -->
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :class="{ dragging: colDrag.key === d.key }" :title="d.tip || d.label" @mousemove="colDragH.over($event, d.key)">
                    <span class="lbx-colpick-grip" title="拖动调整列序" @mousedown.left.prevent.stop="colDragH.start($event, d.key)" @click.prevent.stop><Icon name="grip-vertical" :size="12" /></span>
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
              <span class="lbx-gridbar" data-gridbar="regen.tx"></span>
            </template>
            <div class="lbx-grid">
              <StationGrid ref="txGridRef" grid-id="regen.tx" bar-to="[data-gridbar='regen.tx']" :focus-id="rowReadout ? rowReadout.rowId : ''" :stations="txStations" :fields="txGridFields" :ghost-of="ghostOf" :groups="GROUPS_STATION" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cell-sub="txCellSub" :cell-tag="txCellTag" :cities="cities" :city-search="citySearch" label="发信站" :auto-geo="autoGeoTx" :site-type="applySiteType" :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, satelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', stationId: 'station', satelliteId: 'sat' }" @edit-lib="editInLibrary" :row-menu-extra="txRowMenu" @xlsx-done="onXlsxDone" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'downlink'" id="rx" title="收信站群" :count="rxStations.length">
            <template #actions>
              <span class="lbx-segwrap" title="卫星的指定方式（上/下行两个地面模块）：统一指定＝本配置仅使用一颗卫星（在上方「卫星」分区选择，全部链路共用，站表不出「卫星」列）；逐链路指定＝站表每行各选卫星（「卫星」列，上方分区随之收起）。星间微波 / 激光链路恒按行指定发射 / 接收卫星。切到逐链路指定：上/下行站表「卫星」列为空的行填入统一指定的卫星，已有选择的行不变；切到统一指定：全部链路改用当前站表首行所用的卫星">
                <span class="lbx-segl">卫星</span>
                <span class="lbu-seg"><button v-for="s in SAT_SCOPES" :key="s.v" :class="{ on: satScope === s.v }" :aria-pressed="(satScope === s.v) ? 'true' : 'false'" @click="setSatScope(s.v)">{{ s.l }}</button></span>
              </span>
              <button class="lb-mini" :disabled="!geoManual" title="斜距工具：按轨道高度 × 仰角计算斜距，可按各行仰角批量填入「斜距」列（几何=手动时可用）" @click="slantToolOpen = true">斜距工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="12" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" :class="{ dragging: !!colDrag.key }" @wheel="onColPickWheel">
                  <!-- 拖左侧把手换位＝改表里结果列的次序（本行读数同序）；勾选框只管显示与否 -->
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :class="{ dragging: colDrag.key === d.key }" :title="d.tip || d.label" @mousemove="colDragH.over($event, d.key)">
                    <span class="lbx-colpick-grip" title="拖动调整列序" @mousedown.left.prevent.stop="colDragH.start($event, d.key)" @click.prevent.stop><Icon name="grip-vertical" :size="12" /></span>
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
              <span class="lbx-gridbar" data-gridbar="regen.rx"></span>
            </template>
            <div class="lbx-grid">
              <StationGrid ref="rxGridRef" grid-id="regen.rx" bar-to="[data-gridbar='regen.rx']" :focus-id="rowReadout ? rowReadout.rowId : ''" :stations="rxStations" :fields="rxGridFields" :ghost-of="ghostOf" :groups="GROUPS_STATION" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cell-sub="rxCellSub" :cities="cities" :city-search="citySearch" label="收信站" :auto-geo="autoGeoRx" :site-type="applySiteType" :select-options="{ basebandId: basebandSelectOptions, stationId: esSelectOptions, satelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', stationId: 'station', satelliteId: 'sat' }" @edit-lib="editInLibrary" :row-menu-extra="rxRowMenu" @xlsx-done="onXlsxDone" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'isl'" id="isl" title="星间链路群" :count="islLinks.length">
            <template #actions>
              <button class="lb-mini" :disabled="!geoManual" title="星间链路距离工具：两颗卫星在时间轴上的星间距离，可填入「星间链路距离」列（几何=手动时可用）" @click="islToolOpen = true">距离工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="12" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" :class="{ dragging: !!colDrag.key }" @wheel="onColPickWheel">
                  <!-- 拖左侧把手换位＝改表里结果列的次序（本行读数同序）；勾选框只管显示与否 -->
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :class="{ dragging: colDrag.key === d.key }" :title="d.tip || d.label" @mousemove="colDragH.over($event, d.key)">
                    <span class="lbx-colpick-grip" title="拖动调整列序" @mousedown.left.prevent.stop="colDragH.start($event, d.key)" @click.prevent.stop><Icon name="grip-vertical" :size="12" /></span>
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
              <span class="lbx-gridbar" data-gridbar="regen.isl"></span>
            </template>
            <div class="lbx-grid">
              <StationGrid ref="islGridRef" grid-id="regen.isl" bar-to="[data-gridbar='regen.isl']" :focus-id="rowReadout ? rowReadout.rowId : ''" :stations="islLinks" :fields="islGridFields" :groups="GROUPS_ISL" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cities="cities" :city-search="citySearch" label="星间链路" :show-import="false" :select-options="{ basebandId: basebandSelectOptions, txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" :lib-fields="{ basebandId: 'carrier', txSatelliteId: 'sat', rxSatelliteId: 'sat' }" @edit-lib="editInLibrary" :row-menu-extra="islRowMenu" @xlsx-done="onXlsxDone" @row-focus="onRowFocus" />
            </div>
            <LbCapFoot :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode === 'laser'" id="laser" title="星间激光链路群" :count="laserLinks.length">
            <template #actions>
              <button class="lb-mini" :disabled="!geoManual" title="星间链路距离工具：两颗卫星在时间轴上的星间距离，可填入「星间链路距离」列（几何=手动时可用）" @click="islToolOpen = true">距离工具</button>
              <span class="lbx-colpick-wrap">
                <button class="lb-mini" title="计算结果列：勾选显示列，底部可新建自定义公式列" @click="colPickOpen = !colPickOpen">结果列 <Icon name="chevron-down" :size="12" /></button>
                <div v-if="colPickOpen" class="lbx-colpick-mask" @click="colPickOpen = false" @wheel.prevent></div>
                <div v-if="colPickOpen" class="lbx-colpick" :class="{ dragging: !!colDrag.key }" @wheel="onColPickWheel">
                  <!-- 拖左侧把手换位＝改表里结果列的次序（本行读数同序）；勾选框只管显示与否 -->
                  <label v-for="d in curResultDefs" :key="d.key" class="lbx-colpick-i" :class="{ dragging: colDrag.key === d.key }" :title="d.tip || d.label" @mousemove="colDragH.over($event, d.key)">
                    <span class="lbx-colpick-grip" title="拖动调整列序" @mousedown.left.prevent.stop="colDragH.start($event, d.key)" @click.prevent.stop><Icon name="grip-vertical" :size="12" /></span>
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
              <span class="lbx-gridbar" data-gridbar="regen.laser"></span>
            </template>
            <div class="lbx-grid">
              <StationGrid ref="laserGridRef" grid-id="regen.laser" bar-to="[data-gridbar='regen.laser']" :focus-id="rowReadout ? rowReadout.rowId : ''" :stations="laserLinks" :fields="laserGridFields" :groups="GROUPS_LASER" :freeze-keys="false" :extra-values="gridVals" :cell-class="cellClassFn" :cities="cities" :city-search="citySearch" label="激光星间链路" :show-import="false" :select-options="{ txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" :lib-fields="{ txSatelliteId: 'sat', rxSatelliteId: 'sat' }" @edit-lib="editInLibrary" :row-menu-extra="laserRowMenu" @xlsx-done="onXlsxDone" @row-focus="onRowFocus" />
            </div>
            <!-- 激光星间不出容量汇总（载波带宽/频谱效率口径不适用），但本行读数照给 -->
            <LbCapFoot :readout="rowReadout" />
          </LbSection>
          <LbSection v-if="linkMode" id="detail" title="详细预算" :stale="!!(resultsStale && links.length)" :no="detailNo" :summary="sel && links.length ? pairLabel(sel) : ''">
            <template #nav>
              <button class="lb-mini lb-mini-ico" :disabled="!links.length || selected <= 0" title="上一条" @click="stepDetail(-1)"><Icon name="chevron-up" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" :disabled="!links.length || selected >= links.length - 1" title="下一条" @click="stepDetail(1)"><Icon name="chevron-down" :size="12" /></button>
            </template>
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
                <button v-if="sceneApi && islGeo.worst.worstISO && !islGeo.representative" class="lb-mini geo-loc"
                        title="主窗口时间轴拨到最差时刻 t* 并聚焦发射卫星；时间轴上标出 t* 与搜索时窗" @click="locateGeomInMain('isl')"><Icon name="locate-fixed" :size="12" />在主窗口定位</button>
                <TzPicker v-model="tzMode" :ms="geoRefMs" align="right" class="geo-tz"
                          title="时刻的时标时区：本机 / UTC / UTC±N">{{ tzSuffix }}</TzPicker>
              </div>
              <div class="geo-body">
                <div v-if="islGeo.worst.worstISO && !islGeo.representative" class="geo-row"><span class="geo-l" title="所有几何量取自该物理瞬间（互视样本中星间距离最大 → 最差 FSL）">最差时刻 t*</span><span class="geo-v" style="white-space:normal">{{ fmtInstant(islGeo.worst.worstISO, tzMode) }}</span></div>
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
                <div class="geo-sec" v-if="islGeo.elements && (islGeo.elements.tx || islGeo.elements.rx)" title="发射 / 接收各一列">两星轨道与运动</div>
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
                <TzPicker v-model="tzMode" :ms="geoRefMs" align="right" class="geo-tz"
                          title="时刻的时标时区：本机 / UTC / UTC±N">{{ tzSuffix }}</TzPicker>
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
                <button v-if="sceneApi && geom.search && geom.search.typicalISO" class="lb-mini geo-loc"
                        title="主窗口时间轴拨到典型时刻 t* 并聚焦该卫星；时间轴上标出 t* 与搜索时窗" @click="locateGeomInMain('ground')"><Icon name="locate-fixed" :size="12" />在主窗口定位</button>
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
              :show-geo="vizShowGeo" :geo-site="vizGeoSite" store-key="regen" :lang="reportLang" @exported="toastFile" /></div>
            <div class="lbx-doc-ref"><WaterfallTable :segments="segments" pick="rest" :lang="reportLang" /></div>
            </div>
          </LbSection>
        </div>
      </section>
    </div>

    <!-- 配置右键菜单 -->
    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
    />

    <!-- 历史版本（自动保存的后悔药）：还原 / 用那一版另建副本 -->
    <LbVersionsDialog v-model:open="verDlg.open" ns="regen" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />

    <!-- 导出报告：封面元信息 + 输出格式 + 是否含图（三窗共用组件）-->
    <LbCustomColsDialog :open="ccDlgOpen" :cols="customColsBy[linkMode] || []" :pool="customPool"
      :subtitle="(modeOf(linkMode) || {}).label || ''" :preview-fn="ccPreview"
      @update:cols="linkMode && (customColsBy[linkMode] = $event)" @close="ccDlgOpen = false" />

    <!-- 斜距工具（几何=手动 时可用）：算斜距 + 按各行仰角批量填 -->
    <LbSlantTool :open="slantToolOpen" :alt-km="slantToolAlt" :elev-deg="slantToolElev" :lat-deg="slantToolLat" :sta-alt-m="slantToolStaAlt"
      :row-count="slantSide.rows.length" :has-row="!!slantToolRow" :side-label="slantSide.label" @fill="applySlantFill" @close="slantToolOpen = false" />

    <!-- 星间链路距离工具（几何=手动 时可用）：两星轨道 → 时间轴上的星间距离 → 填入链路表 -->
    <LbIslRangeTool :open="islToolOpen" :sats="islToolSats" :row-count="islToolRows.length" :has-row="!!islToolRow"
      :default-hours="geoHorizonHours" :side-label="linkMode === 'laser' ? '星间激光' : '星间微波'"
      @fill="applyIslRangeFill" @close="islToolOpen = false" />

    <!-- SLA 建议：条款表 + SLA 参数 + 可用度档位扫描（四窗共用组件；链路由头部下拉选） -->
    <LbSlaDialog
      :open="slaOpen" :options="slaOpts" :index="slaIdx" :derived="slaDerived"
      :row-sla="slaRow && slaRow.sla" :params="slaParams" :adaptive="unitAdaptive" :all-on="slaAllOn"
      :error="error" :link-error="(slaLink && slaLink.error) || ''" :link-name="slaLinkName"
      @close="slaOpen = false" @pick="slaIdx = $event" @adopt="slaSetAdopt" @include="slaSetInclude"
      @param="slaSetParam" @toggle-all="slaToggleAll" :sla-count="slaCount" @clear="slaClear" @export="openSlaReportDialog" />

    <!-- 容量汇总：当前模块按卫星分组的三线表（三窗共用组件；再生式不出功率带宽，可用带宽要自己填） -->
    <LbCapDialog :open="capOpen" :model="capOpen ? capModel : null" :adaptive="unitAdaptive" :sub="capSub" :error="error"
      @close="capOpen = false" @include="capSetInclude" @count="capSetCount" @param="capSetParam"
      @toggle-all="capToggleAll" @reset="capReset" @export="openCapReportDialog" />

    <!-- 导入链路：星座 3D 主窗的图上链路（四窗共用组件；本窗只收每颗星都按再生的链路，逐跳拆进各模块）-->
    <LinkImportDialog v-if="linkImpOpen" kind="regen" @import="onLinkImport" @close="linkImpOpen = false" />

    <!-- 报告讲整份配置：体制副标题按装了的模块并列、链路数是各模块之和、读数行逐模块列条数 -->
    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="REGEN" :regen-mode="reportModules" :sections="reportSectionInfo"
      :sat-name="sceneSatName" :band="sceneBand" :link-count="reportLinkCount"
      :viz-available="showViz" :sla-count="slaCountAll" store-key="regen" :busy="reportDlg.busy" :progress="reportDlg.progress"
      @close="reportDlg.open = false" :variant="reportVariant" @submit="submitReport" />

    <ConfirmDialog />

    <!-- 分享 / 导入弹窗（三窗共用组件）：配置多选 + 资源库多选，分享码 / 文件 / 在线三条路共用同一份勾选 -->
    <LbShareDialog ref="shareRef" v-model:open="shareOpen" :ctx="shareCtx" :device-id="deviceId" :configured="shareConfigured" @toast="toastFile" />
    <WinStatusBar :n="N" :stale="resultsStale && links.length" stale-title="计算输入已被修改，结果列与详细预算对应修改前的参数">
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
    </WinStatusBar>
  </div>
</template>

<style scoped>
.lb-shell {
  /* 上行 / 下行 = lbPlotTheme.js 的 SERIES 蓝 / 赭（与链路视图、图表同一对，四窗一致） */
  --up: #15619b; --dn: #b8571a;
}
html[data-theme='dark'] .lb-shell { --up: #4a8fc9; --dn: #d2792f; }

/* 功能区「文件」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .app-icon { animation: ui-spin .7s linear infinite; transform-origin: 50% 50%; }
.geo-loc { flex: none; margin-left: auto; }


.lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; }


.rlmode { display: flex; align-items: center; gap: 4px; flex: none; padding: 8px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.rlmode-i { position: relative; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: var(--fs-3); font-weight: 600; padding: 6px 9px 6px 14px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
/* 悬停只作用于未选中页签：选中页签是 accent 实底、字色恒 var(--bg)，再套一层 var(--text) 就和底同色了 */
.rlmode-i:hover:not(.on) { color: var(--text); border-color: var(--border-strong); }
/* 选中页签填墨（老用户认得的身份）走 token：深色下 --sel-fill 压一档，不再是整块近白；悬停换 token 色而非提亮滤镜 */
.rlmode-i.on { background: var(--sel-fill); color: var(--sel-on); border-color: var(--sel-fill); }
.rlmode-i.on:hover { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.rlmode-i.dragging { opacity: .45; }
/* 状态点：已计算（实心）/ 输入已变（空心，警示色）；没算过不画 */
.rlmode-dot { flex: none; width: 7px; height: 7px; margin-left: -6px; border-radius: 50%; background: var(--ok); box-sizing: border-box; }
.rlmode-dot.stale { background: transparent; border: 1.5px solid var(--warn); }
.rlmode-i.on .rlmode-dot { background: var(--sel-on); }
.rlmode-i.on .rlmode-dot.stale { background: transparent; border-color: var(--sel-on); }
/* 链路条数：小号数字，与资源库页签的计数同一语言 */
.rlmode-n { font-family: var(--font-mono); font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-tight); padding: 1px 5px; border-radius: var(--r-ctl); background: var(--surface-2); color: var(--text-faint); border: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.rlmode-i.on .rlmode-n { background: color-mix(in srgb, var(--sel-on) 20%, transparent); color: var(--sel-on); border-color: transparent; }
.rlmode-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 1px; border-radius: var(--r-ctl); color: currentColor; opacity: .5; }
.rlmode-x svg { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; fill: none; }
.rlmode-i:hover .rlmode-x { opacity: .8; }
.rlmode-x:hover { opacity: 1; background: color-mix(in srgb, var(--danger) 16%, transparent); color: var(--danger); }
.rlmode-i.on .rlmode-x:hover { background: color-mix(in srgb, var(--sel-on) 28%, transparent); color: var(--sel-on); }
/* 「添加模块」随页签行拉满高度：定高 27px 比页签矮一截，两者底边对不齐 */
.rlmode-add-wrap { position: relative; display: inline-flex; align-self: stretch; }
.rlmode-add { display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: auto; min-height: 27px; padding: 0 10px 0 8px; font: inherit; font-size: var(--fs-3); font-weight: 600; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl); }
.rlmode-add svg { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; fill: none; }
.rlmode-add:hover:not(:disabled), .rlmode-add.on { color: var(--accent); border-color: var(--line-hover); }
.rlmode-add:disabled { opacity: .45; cursor: not-allowed; }
/* 「添加模块」菜单：外观走 controls.css 的菜单基线（.menu / .menu-item / .menu-hd / .menu-ck / .menu-mask）；
   这里只留挂在按钮下方的定位与宽度、已添加项弱一档的字色（悬停让给基线蓝块） */
.rlmode-menu { position: absolute; top: calc(100% + 5px); left: 0; min-width: 196px; animation-name: ui-float-in; }
.rlmode-menu-i.added { color: var(--text-faint); }
/* 空态：一句话 + 四个添加按钮（按钮是控件，不是说明文字） */
.rlmode-empty { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 56px 16px; }
.rlmode-empty-t { font-size: var(--fs-3); color: var(--text-faint); }
.rlmode-empty-btns { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.rlmode-empty-b { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: var(--fs-3); font-weight: 600; padding: 7px 12px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl); }
.rlmode-empty-b svg { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; fill: none; }
.rlmode-empty-b:hover { color: var(--accent); border-color: var(--line-hover); }

/* 链路表节内的说明条 */


/* 核心指标（.core-*）三线式样式统一在 styles/lbworkbench.css（三 App 共用，此处不再重复定义） */

/* 站星几何卡：三线语言（上下双线、题注行带栏目线、无底色），tx/rx 双列 */
.geo-card { margin-bottom: 12px; border-top: 2px solid var(--lb-rule-strong); border-bottom: 2px solid var(--lb-rule-strong); }
.geo-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 2px 4px; border-bottom: 1px solid var(--lb-rule); }
.geo-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.geo-tt { font-size: calc(var(--lb-fs, 11px) + 1px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); }
.geo-badge { flex: none; align-self: center; font-family: var(--font-mono); font-size: var(--fs-1); font-weight: 700; letter-spacing: var(--ls-tight); line-height: 1; padding: 2px 7px; border-radius: var(--r-ctl); background: var(--bg); color: var(--text-muted); border: 1px solid var(--border-strong); }
/* 时区角标：一枚可点的档位标（点开是本机 / UTC / UTC±N 的列表，见 TzPicker） */
.geo-tz { display: inline-flex; flex: none; align-items: center; padding: 3px 9px; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: var(--bg); color: var(--text-muted); font-size: var(--fs-2); line-height: 1; font-variant-numeric: tabular-nums; }
.geo-tz:hover, .geo-tz.open { color: var(--text); border-color: var(--line-hover); }
.geo-body { padding: 2px 2px 6px; }
.geo-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.geo-col { min-width: 0; }
.geo-col-hd { display: flex; align-items: baseline; gap: 6px; font-size: var(--lb-fs, 11px); font-weight: 700; padding: 3px 0 4px; border-bottom: 2px solid var(--border-strong); margin-bottom: 2px; }
/* 星间发射 / 接收：与上行 / 下行同一对 SERIES 蓝 / 赭（--up / --dn），绿色只留给状态 */
.geo-col-hd.tx { color: var(--up); border-bottom-color: var(--up); }
.geo-col-hd.rx { color: var(--dn); border-bottom-color: var(--dn); }
.geo-col-hd em { font-style: normal; font-weight: 500; font-size: calc(var(--lb-fs, 11px) - 1px); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.geo-col-na { font-size: var(--lb-fs, 11px); color: var(--text-faint); padding: 10px 0; }
.geo-col .geo-sec:first-of-type { border-top: none; padding-top: 3px; margin-top: 4px; }
.geo-sec { display: flex; align-items: baseline; gap: 7px; font-size: calc(var(--lb-fs, 11px) - 1px); font-weight: 600; color: var(--accent); margin: 8px 0 3px; padding-top: 5px; border-top: 1px solid var(--lb-rule-soft); letter-spacing: var(--ls-tight); }
.geo-sec-x { font-weight: 400; font-size: var(--fs-1); color: var(--text-faint); letter-spacing: var(--ls-tight); }
.geo-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 1.5px 0; }
.geo-l { font-size: var(--lb-fs, 11px); color: var(--text-muted); min-width: 0; }
.geo-l i { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); margin-left: 4px; letter-spacing: var(--ls-tight); }
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
.acc-clip { font-style: normal; font-size: var(--fs-1); color: var(--text-faint); margin-left: 5px; padding: 0 4px; border: 1px solid var(--border); border-radius: var(--r-ctl); }

</style>
