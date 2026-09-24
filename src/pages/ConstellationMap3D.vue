<script setup>
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount, toRef, provide, toRaw, defineComponent, h as hVnode } from 'vue'
import { cursor } from '../stores/cursor'
import { view } from '../stores/view'
import { covNav } from '../stores/coveragePanels'
import { zoom } from '../stores/zoom'
import { effective as displayQuality, quality as displayTier } from '../stores/displayQuality'
import { viewPrefs, FRAME_MODES, VIEW_PREF_RANGE, VIEW_PREFS_REV } from '../stores/viewPrefs'
import { setGrdBridge, clearGrdBridge, fileBridge, bumpCustomSats } from '../stores/fileBridge'
import { shellUi, sideCtx, SAT_INFO_W_LIM } from '../stores/shellUi'
import { isSecOpen, toggleSec, setSecOpen, revealSection } from '../stores/panelSections'
import { registerCommands } from '../stores/commands'
import { kwId } from '../shared/cmdKeywords.js'
import { clock, onTick, goLive, togglePlay, setTime as clockSetTime, stepBy as clockStepBy, setStep as clockSetStep, setSpeed as clockSetSpeed, releaseClock, resumeClock, effective as clockEff, capped as clockCapped, restoreState as clockRestore } from '../stores/simClock'
import { STEP_PRESETS, SPEED_PRESETS, followWindow, snapMs, fmtStepShort, fmtRate, fmtOffset } from '../shared/simClockCore.js'
import { uiFont } from '../stores/uiFont'
import { logMsg, diagMsg } from '../stores/log'
import { alertMsg, appAlert, closeAlert } from '../stores/alert'
import { displaySatName } from '../viz/satName.js'
import { serializeGxt } from '../viz/gxt/serialize.js'
import { parseGxt } from '../viz/gxt/parse.js'
import { serializeKml } from '../viz/kml/serialize.js'
import { parseKmlPolys } from '../viz/kml/parse.js'
import Icon from '../components/Icon.vue'
import NumBox from '../components/NumBox.vue'
import TzPicker from '../components/TzPicker.vue'
import { tzOffMin, tzTag, tzParts, tzToMs, normTzMode } from '../shared/tz.js'
import SatList from '../components/SatList.vue'
import SatFilterBar from '../components/SatFilterBar.vue'
import SatLayersPanel from '../components/SatLayersPanel.vue'
import SatFinderDialog from '../components/SatFinderDialog.vue'
import { useSatSets } from '../viz/constellation/useSatSets.js'
import { ownerName } from '../shared/satcatCodes.js'
import { loadSatcatIndex } from '../shared/satcatIndex.js'
import { makePredicate, emptyFilters, normalize as normalizeFilters, isEmpty as isFilterEmpty } from '../shared/satFilter.js'
import MiniSendDialog from '../components/MiniSendDialog.vue'
import { MANUAL as COV_MANUAL, targetOptions as covTargetOptions, defaultTarget as covDefaultTarget, resolveTarget as resolveCovTarget, covUnit, parseCustoms, rememberTarget as rememberCovTarget } from '../shared/covMiniExport.js'
import { trajItemsOf } from '../shared/trajMiniExport.js'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
// 卫星 3D 模型：球面图标 / 跟随卫星（模型层挂 scene 的叠加层口子；纯逻辑来自 packages/core/models）
import { createModelLayer, satStateAt, sunStateAt, velInL, neighborInL, stationDirsInL, NEIGHBOR_KM } from '../viz/globe3d/modelLayer.js'
import { followFocusGeom } from '../viz/globe3d/followFocus.js'
import ModelSidePanel from '../components/ModelSidePanel.vue'
// 标记实体上球（P4：地球站 / 点标记 / 航迹载具挂模型；DESIGN3 E7–E11）：实体模型层 + 纯逻辑（运动 / 跟踪 / 字段规范化 / 说明行）
import ModelPickPop from '../components/ModelPickPop.vue'
import { thumbs as mdlThumbs, requestThumb as mdlRequestThumb } from '../components/modelThumbs.js'
import { createEntityLayer } from '../viz/globe3d/entityLayer.js'
// 平面图上挂了模型的站 / 点 / 载具：画这件模型的正射俯视图（离屏出图器，与 3D 模型图标同一份模型、同一套打光）
import { createEntitySprites } from '../viz/flatmap/entitySprites.js'
import { entityTemplateCatalog } from '@core/models/entityTemplates.mjs'
import { makeTrajState, CRUISE_ALT_M_DEFAULT, trajWaypointInfo, trajLine3, trajStartMs, trajEndMs, trajLengthM } from '@core/models/trajKinematics.mjs'
import { ENT_PX_MIN, ENT_PX_MAX, entityKey, normEntityModel, normTrack, normTrajMotion, sanitizeMarkers, trajMoving, trajEntityKind, trajLinePts, trajNoteOf, parseDateTimeText, partsToUtcMs, makeTrackState, pickTrackTarget, vehicleStateAt } from '@core/models/entityRuntime.mjs'
import NumIn from '../model/NumIn.vue'
import { createBodyRuntime, qB2LFromBasis, attEquivOf } from '../viz/models/bodyRuntime.js'
import { satKeyOf as coreSatKeyOf, grdSatKey, parseModelId, isValidSatKey } from '@core/models/schema.mjs'
import { match as matchModel } from '@core/models/autoMatch.mjs'
import { templateCatalog } from '@core/models/paramTemplates.mjs'
import { fleetCatalog, buildFleetModel, isFleetId } from '@core/models/fleet/index.mjs'
import { buildTemplateModel } from '@core/models/paramBus.mjs'
import { Q_BODY2L_NADIR, makeBasis } from '@core/models/attitude.mjs'
import { modelToBody, quatNormalize, defaultImportQ } from '@core/models/bodyFrame.mjs'
// 本体系 → 模型轴米的包围盒：与工作台「保存到库」写 geometry.bboxM 的是同一个函数（wbStore.paramGeomFields），读数逐位同源
import { bodyBoxToModelBox } from '../model/wbLogic.js'
import { IMAGERY_SOURCES, DEFAULT_IMAGERY, imagerySource, loadImagery } from '../viz/imagery.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
// 标记符号形状表（2D/3D 两个渲染器共用同一支画笔，见 viz/markers/markSymbols.js）
import { MARK_SHAPES, PT_DOT_K } from '../viz/markers/markSymbols.js'
import { LAND as LAND_MORANDI, LAND_UNIFORMS, LAND_DEFAULT, migrateLandOverrides } from '../viz/landPalette.js'
import { countryAt, currentLandColor, countryList } from '../viz/globe3d/countryPick.js'
import { BORDER_DEF, GRID_STEPS } from '../viz/geo/borderStyle.js'
import { onPovChange, getPov } from '../viz/geo/povResolver.js'
import { POV_META, CUSTOM_POV, povTableOf, normMapPov } from '../viz/geo/povList.js'
import { CUSTOMIZABLE_DISPUTES, OWNER_ZH } from '../viz/geo/frozen.js'
import { getMapPov, onMapPov, saveMapPov } from '../stores/mapPov.js'
import { admIndex, loadPack, mergePacks } from '../viz/geo/admPacks.js'
import { mapCrs, setMapCrs, MAP_CRS_DEF, lon0ToCenter, centerToLon0, projOpts, LOOK_MODES } from '../stores/mapCrs.js'
import { PROJECTIONS, projParams } from '../viz/geo/projection.js'
import { waterList } from '../viz/geo/waterNames.js'
import { CHAINS, CHAIN_DEF } from '../viz/geo/islandChains.js'
import { DATUMS } from '../viz/geo/datum.js'
import { FORMATS } from '../viz/geo/coordFormat.js'
import { useGrdCoverage } from '../viz/grd/useGrdCoverage.js'
import { useBeamSynth } from '../viz/grd/useBeamSynth.js'
import GaussModelFields from '../components/GaussModelFields.vue'   // 波束合成「高斯组」的方向图参数行（STK Gaussian）
import { useVisibility, orbitClass } from '../viz/vis/useVisibility.js'
import { useEnvField } from '../viz/env/useEnvField.js'
import { useLiveField } from '../viz/env/useLiveField.js'
import { usePerfTable } from '../viz/grd/usePerfTable.js'
import { useShellCoverage } from '../viz/grd/useShellCoverage.js'
import { createNoradResolver, foldersForNorads, linkedNodesOf, linkMissing as treeLinkMissing, followFolder as treeFollowFolder, ephGroupsToLoad, grdLivePayload, createLiveThrottle, focusStale, createFollowGate, synthGroupDrives, treeNavState, nodeLinkId } from '../viz/grd/treeLink.js'
import { syncTreeGeoEntries, TREE_GEO_LABEL } from '../viz/grd/treeGeo.js'
import { buildRecord as anBuildRecord, freshModel as anFreshModel } from '../viz/grd/gaussStk.js'   // 树上「新建高斯天线」（别名：波束合成那边也可能直接引这个模块）
import { useSatPerfTable } from '../viz/grd/useSatPerfTable.js'
import { sampleBeamAtEcef, satLookAt } from '../viz/grd/coverage.js'
import SatCovPanel from '../components/SatCovPanel.vue'
import { createPerfWinHost } from '../viz/grd/perfWinHost.js'
import SatCovShellPicker from '../components/SatCovShellPicker.vue'
import GrdSetSections from '../components/GrdSetSections.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { useCheckList } from '../shared/ui/useCheckList.js'
import ExcelGrid from '../components/ExcelGrid.vue'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, sheetToTsv, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { useMarkerTable, trajsFromSheets, TRAJ_NOTE_FIELDS, wpColKeys, normFirstPin, pinNoteOf } from '../viz/markers/useMarkerTable.js'
import { fmtTzTime, fmtTzTimeOff, parseTzText } from '../shared/tzText.js'
import sat from '../viz/constellation/satellite.js'
// 取位的唯一入口：satrec（SGP4）与星历点序列（插值）两种传播体都走它。
// 本文件从前有 15 处 sat.propagate，全部改到这里 —— 少改一处，点序列星就在那处静默出 NaN。
import { posAt, isEphemEntry, propagatorLabel, periodMinOf, keepInRenderSet } from '../viz/constellation/satPos.js'
import { metricsFromEntry } from '../shared/satrecMetrics.js'
import { tableFrom } from '../viz/constellation/ephemTable.js'
import { sampleOrbitAdaptive } from '../viz/constellation/adaptiveSample.js'
import { ringTtlMs } from '../viz/constellation/focusGeomCache.js'
import { createFocusGeomPool } from '../viz/constellation/focusGeomPool.js'
import { footprintRing } from '../viz/constellation/focusFootprint.js'
import { swathK, sectionOf, groundMotion, buildSwath, swathFlatGeom } from '../viz/constellation/focusSwath.js'
import { pf } from '../shared/num.js'
import { vecToLatLon, llaToVec } from '../viz/globe3d/focusLanes.js'
import { solarGeometry } from '../viz/terminator.js'
import { SPACE_DEF, spaceFromSaved } from '../viz/globe3d/spaceFx.js'
import * as W from '../viz/wgs84.js'
import { parseOMMCsv, fetchGroupLiveOrSup } from '../viz/constellation/tle.js'
import { useCustomConstellations, customConstellationsToOmmRecords, NORAD_BASE } from '../viz/constellation/useCustomConstellations.js'
import { useSatGroups } from '../viz/constellation/useSatGroups.js'
import { makeSatSetItem } from '../shared/satconMiniExport.js'
import { walkerCode, orbitPeriodMin, validateWalker } from '../viz/constellation/walker.js'
import OD from '../viz/constellation/orbitDesign.js'   // 轨道向导求解器（九种类型 -> 六根数）
import { classifyOrbit } from '../shared/orbitClass.js'
import { fmtGeoSlot, geoSlotOfSatrec, geoSlotOfOmm } from '../shared/geoSlot.js'
import { byLang, curLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字
import { onLangChange } from '../shared/i18n/runtime.js'   // 切界面语言时，地图上的地名跟着换语言（见 syncNameLang）

// 分组与「星座地图」(2D) 完全一致：同一份列表 / 顺序 / 默认「中国星网」。
const GROUPS = [
  { key: 'none', label: '无（不渲染星座）' },
  { key: 'all', label: '全部卫星' },
  { key: 'custom', label: '自定义卫星' },
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
// 可见性分析「卫星集」下拉的内置分组档（默认卫星组）：none 没有真实星、custom 在下拉里单列一项
const VIS_SAT_GROUPS = GROUPS.filter((g) => g.key !== 'none' && g.key !== 'custom')

const RE = 6378.137
const DEG = Math.PI / 180
const STORE_KEY = 'constellation3d/selection'
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

const g3el = ref(null)             // 本页根节点（position:relative 定位参照系，性能表浮窗默认坐标据此计算）
const el = ref(null)
const flatCanvas = ref(null)       // 平面覆盖图 canvas
const flatView = ref(false)        // 平面图 / 球体 切换
let flat = null                    // 平面渲染器实例
let covGeom = { lines: [], dots: [], labels: [], sats: [] }   // 覆盖几何（3D 与 平面图共用）
// 「当前分组」已不存在：地图 = 卫星集注册表里全部可见集的并集（见 satSets）；DEFAULT_GROUP 只用于旧存档迁移
const status = ref('')          // 卫星加载状态：仅显示在左侧星座面板 pstat 行（后台静默加载，不再弹中央横幅）；导出反馈不走此处
const satCount = ref(0)     // 该组卫星总数
const shownCount = ref(0)   // 实际渲染点数
const dataTime = ref('')
// 「实时」＝仿真时钟跟随系统时钟（clock.mode==='live'）。这里只读不写：改状态一律走时钟的 goLive/pause，
// 否则时钟自己的定时器与页面的标志位会各说各话。
const live = computed(() => clock.mode === 'live')
const nameMode = ref('off')   // 国名：'zh' | 'en' | 'off'（默认不显示）
// 水域注记两档，各自独立于国名：'zh' | 'en' | 'off'（默认不显示，与国名同）。
// ★ 老存档里没有这两个键 —— 那时洋名是跟着国名走的，故 restoreSettings 把 oceanMode 回落到存档的 nameMode，
//   升级前后图上一模一样；海域是新加的一层，老存档一律按「不显示」入场，不平白往人家的图上撒 70 个名字。
const oceanNameMode = ref('off')
const seaNameMode = ref('off')
// 逐条关掉的水域注记：{ id: true }。存「关掉的」不存「打开的」—— 以后表里新增的条目默认就是显示，
// 不会因为老存档里没记而整批消失。
const waterOff = reactive({})
// 一级/二级行政区：全球逐国懒加载（src/viz/globe3d/data/adm/{ISO3}-adm{1,2}.json）。
// 勾一个国家拉一个包，取消勾选只是不画、不卸载。默认只选中国。
const showProvinces = ref(false)   // 显示行政区（一级）界 / 名称（默认关）
// 二级行政区目前【只有中国】有包（地级市 332 个，民政部口径）。它因此不是一个独立图层，
// 而是「行政区里选中了中国」时才出现的一个附加档 —— 见 ensureAdm(2) 的三重门。
const showCities = ref(false)
const admSel1 = ref(['CHN'])       // 一级：选中的国家（ISO3）
// 名称档位：'local' 中文 | 'en' 英文 | 'off' 不显示。
// ★ 初值跟界面语言走（英文界面首启就该是英文地名）；有存档时 restoreSettings 覆盖它，
//   之后的切换由 syncNameLang 接手。
const admName1 = ref(curLang() === 'en' ? 'en' : 'local')
const admName2 = ref(curLang() === 'en' ? 'en' : 'local')
const admQuery1 = ref('')          // 国家搜索框
let provincesData = null
let citiesData = null
// 宇宙空间（地图设置 · 宇宙空间）：总开关 + 六项，各项拆开实现、各存各的字段 ——
//   星空 / 大气辉光 / 太阳：scene.setSpace（viz/globe3d/spaceFx.js，仅 3D）；地球影像：applyImagery（3D + 平面图，原「影像底图」并进来）；
//   晨昏效果：夜区按太阳高度角 0° → −18° 柔和压暗（3D 着色器 + 平面图栅格），卫星模型按太阳打光（关着 = 全亮）；
//   晨昏线：分界线 + 自带的硬边夜区阴影（3D + 平面图；阴影只在晨昏效果不勾时画，不叠两层）。
// 时刻取时间轴当前值 calcAt()（非系统时钟）——拖时间轴 / 实时推进时太阳、星空、晨昏随之移动，
// 与卫星星位同一个 UTC 时刻、同一个自转相位（GMST 复用 sat.gstime，见 viz/terminator.js）。
// 总开关出厂关；打开即得完整效果（前五项勾、晨昏线不勾）。老存档（termOn / termNight / termLine / termStyle）的迁移见 restoreSettings。
// 跟随卫星只改视角：这里的开关普通视图与跟随视图同一套，跟随不单独开 / 关任何一项。
// 出厂值 / 取值范围 / 存档迁移在 viz/globe3d/spaceFx.js（SPACE_DEF / spaceFromSaved，单测 modelSpaceEnv 守着）。
const spaceOn = ref(false)
const space = reactive({ ...SPACE_DEF })
const spaceSub = ref(null)      // 当前日下点 {lat, lon}，供侧栏读数（applySpace 时回填）
// 岛链参考线（第一 / 第二 / 第三）：默认整层不画，逐条可勾。表在 viz/geo/islandChains.js。
// ★ 它不是边界、不表达归属，故不进主权解算层那一套（边界线一节），自成一个可关的叠加层。
const chainOn = ref(false)
const chainOff = reactive({})   // { id: true } 逐条关掉的（存「关掉的」不存「打开的」，以后加链默认就显示）
// 线与名同一套样式：color / width / opacity / dash + name('zh'|'en'|'off') / nameSize
const chainStyle = reactive({ ...CHAIN_DEF })
// —— 时间轴：尺（窗口）与针（时刻）彻底分家 ——
// 针 = clock.tMs（全局仿真时钟，唯一真相）；尺 = baseTime 锚点 + winStartMin/windowMin 跨度。
// 游标偏移是【推出来的】不是存出来的：改造前 timeOffset(分钟) 既是显示位置又是时间来源，
// 于是「秒级」无处安放（整数分钟）、播放推进还得反写回它。现在它只是 tMs 在尺上的投影。
// ★ 锚点一律从 clock.tMs 取，不各自 Date.now()：两次 Date.now() 差 1 ms，游标偏移就成了「−0:00」
//   （0 与「几乎是 0」在读数上是两回事，后者还会让「此刻」按钮一直亮着）
const baseTime = ref(clock.tMs)    // 时间轴锚点：冻结时不变，实时时每拍跟随系统时钟
const offMs = computed(() => clock.tMs - baseTime.value)          // 游标相对锚点的偏移(ms，可负=过去)
const offMin = computed(() => offMs.value / 60000)                // 同上，分钟（尺的刻度单位）
const windowMin = ref(4320)      // 可见时间窗跨度(分钟)，用户可配(预设下拉/滚轮缩放)，持久化
const winStartMin = ref(-1080)   // 窗口左边缘相对锚点的偏移(分钟)，负=含过去；= -PAST_FRAC*windowMin
const trackWidthPx = ref(600)    // 时间轴轨道像素宽(ResizeObserver 驱动，供刻度自适应)
const nowStamp = ref(Date.now()) // 真实当前时刻(每次刷新更新)，用于「此刻」红标记
const keyword = ref('')
// ★ shallowRef 不用 ref：结果项里挂着卫星条目（item.en），深层响应式会把它连同 satrec 一起包成 Proxy ——
//   点结果聚焦时 selEntries 里存的就是 Proxy，喂给聚焦几何 Worker 时 postMessage 结构化克隆直接抛 DataCloneError，
//   整条聚焦管线当场哑掉（轨迹 / 覆盖圈全不画、时钟拍卡住）；与在球上点选拿到的原始条目也认不出是同一颗。
const searchResults = shallowRef([])
const selected = ref(null)
// 覆盖圈定义（常驻时间条，未聚焦卫星时置灰）：按「波束角」(星上全锥角) 或「最低仰角」(地球站约束) 二选一
const fpMode = ref('beam')     // 'beam' | 'elev'
const beam = ref('')
const beamAuto = ref('')
const beamLock = ref(false)
const elevMin = ref('')        // 最低仰角（度，空=0°地平线）
// 聚焦卫星显示样式（侧栏「显示设置 · 聚焦卫星」，3D 球体与 2D 平面图同一份；出厂值＝可自定义之前写死的那套画法）。
// 轨道线只在 3D 有：平面图画的是星下点轨迹与覆盖圈，轨道圈（惯性系那条闭合椭圆）在等距圆柱图上没有意义。
// 线型 solid | dash | dot；透明度 0~1；线宽/像素两边同口径（都是屏幕像素）。
const focusStyle = reactive({
  orbOn: true, orbColor: '#6f9fc8', orbWidth: 1.3, orbOpacity: 0.9, orbDash: 'solid',
  trkOn: true, trkColor: '#e8c074', trkWidth: 1.6, trkOpacity: 1, trkDash: 'solid', trkPeriods: 1,
  // 轨迹长度口径：rev＝圈数（trkPeriods，各星按自己的周期）；time＝时长（trkSpanMin 分钟，全体同一段）。任意正数，不设上限
  trkSpanMode: 'rev', trkSpanMin: 0,
  // 轨迹形式：line＝轨迹线；swath＝轨迹面（按覆盖圈口径沿轨迹扫过的覆盖带：两缘按上面的线样式描，带内按填充色/透明度）
  trkMode: 'line', trkFillColor: '#e8c074', trkFillOpacity: 0.3,
  fpOn: true, fpColor: '#b8e6fa', fpWidth: 1.6, fpOpacity: 1, fpDash: 'dash',
  fpFillColor: '#b8e6fa', fpFillOpacity: 0,
  // 覆盖锥（卫星→覆盖圈边界的锥体，仅 3D）：锥面透明度 0＝只留母线，母线根数 0＝只留锥面，不另设开关
  coneOn: false, coneFaceColor: '#b8e6fa', coneFaceOpacity: 0.75,
  coneGenCount: 0, coneGenColor: '#b8e6fa', coneGenWidth: 1, coneGenOpacity: 0.55, coneGenDash: 'solid',
  cloudOn: true, dotOn: true, dotPx: 13, subOn: true, subPx: 30, subColor: '#ffffff',
  ringOn: true, ringColor: '#ffd27a', ringPx: 26,
  // 卫星 3D 模型（「卫星模型」侧栏）：球面图标开关与大小（包围半径的屏幕像素 × 2）；跟随卫星时的 HUD 七项（出厂全关 —— NASA Eyes 式干净画面；
  // ISL = 与 500 km 内邻星的通视连线，地球站 = 标记层地球站里仰角 ≥ 0° 的方向；挂点 = 绑定表里各挂点的视轴射线与视场锥）；
  // followImagery：原「跟随时用影像底图」—— 已归地图设置 · 宇宙空间 · 地球影像（跟随只改视角），本页不再读；字段留着只为老存档不报错
  modelOn: true, modelPx: 28,
  hudAxes: false, hudLvlh: false, hudNadir: false, hudVel: false, hudSun: false, hudIsl: false, hudEs: false, hudMounts: false, followImagery: true
})
const FOCUS_STYLE_DEF = { ...focusStyle }   // 出厂值快照：侧栏「恢复默认」按它回填
const DASH_OPTS = [{ k: 'solid', label: '实线' }, { k: 'dash', label: '虚线' }, { k: 'dot', label: '点线' }, { k: 'dashdot', label: '点划线' }]
const apiOk = typeof window !== 'undefined' && !!(window.api && window.api.omm)
const covApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverage)
const grdApiOk = typeof window !== 'undefined' && !!(window.api && window.api.coverageGrd)

// ===================== 覆盖图（GEO 卫星，两级模型：卫星 → 批次） =====================
// covItems: 已添加的卫星 [{ folder, type:'EIRP'|'GT', band:'all'|频段, batches:[batch] }]
//   batch: { id, name, beams:[beamId], gains:[number], custom:'', mode:'gradient'|'solid'|'perGain', solid:'#hex', gainColors:{gain:'#hex'} }
const covOpen = toRef(covNav, 'covOpen')   // 右侧覆盖面板开关（GXT）；与顶栏按钮共用 covNav store

// 2D 那块场此刻有没有人看：平面图可见，或本次出图走的是 2D 平面图（「全球图」在 3D 视图下也走 flat，
// 见 exportMap→feedFlat；「3D 球体截图」不占这块场，故看的是 exportFlat 而非 exporting）。
// 两个覆盖视图的 2D 通道都拿它当闸——3D 视图下每拍往不可见画布烘 Path2D 是白做（运行时求值，无 TDZ）。
const flatActive = () => flatView.value || exportFlat.value
// 覆盖图（GRD）：实时原始场，渲染到星座3D 的 scene/flat（独立图层）
const grd = useGrdCoverage(() => scene, () => flat, () => flatView.value, {
  flatActive,
  // 对星指向（boreType='sat'/'satoff'）的目标解析：身份串 → 当前时刻 ECEF(km)。星历与时间轴都在本页，
  // 故由本页注入；useGrdCoverage 自己不碰 SGP4。见下方 satTargetEcef。
  getTargetEcef: (id) => satTargetEcef(id),
  // 「姿态 + 挂点」指向（boreType='att'，DESIGN2 §4）：本体姿态律 × 挂点 → 视轴与 up（标准 ECEF 单位矢量），见 grdAttAxes；
  // 挂点下拉候选与姿态律名给「天线 boresight」一节（GrdSetSections 另可经 inject 取同一份）
  getAttAxes: (meta, st) => grdAttAxes(meta, st),
  // 绑定还在路上（启动时经 IPC）：那一刻只能按缺省挂点 / nadir 解，W12 据此不写 attEquiv
  attReady: () => bodyRt.isLoaded(),
  getMountOptions: (antKey) => grdMountOptions(antKey),
  getAttLaw: (antKey) => grdAttLaw(antKey),
  // 切到「空间点」指向时，指向点默认落在哪层壳上（取对星覆盖分析里第一层显示中的壳层）
  defaultBoreAlt: () => satcovDragAlt(),
  // 2D 平面图只有一块 GRD 场，对地/对星共用 → 按当前【上下文视图】定归属（另一半见下面 satcov 的第 7 参）。
  // 用 sideCtx 不用 side：收起侧栏只是把面板藏起来，归属不该跟着翻（翻了就是「关个侧栏，图变了」）。
  ownsFlatField: () => sideCtx() !== 'satcov'
})
const { sats: grdSats, loading: grdLoading, s: grdS } = grd
const grdOpen = toRef(covNav, 'grdOpen')   // GRD 覆盖面板开关；与顶栏按钮共用 covNav store

// 波束合成（SATSOFT Gaussian Beam Model / Polygon 赋形）：草图放置 + 参数换算 + 生成天线入覆盖树。
// polys/satLivePos 在下方定义 → 用 getter 传入避免 TDZ（仅运行时调用）。
// refresh：草图轮廓变化 → 重画卫星层（含 sketchSpec）+ 同步拖拽手柄。
const bs = useBeamSynth({ grd, getPolys: () => polys.value, livePos: (n) => satLivePos(n), appAlert, refresh: () => { redrawSats(); syncEdit() } })
// 组名就地改：同上 —— 本组件每秒重渲染，:value 又是无条件回写，不用草稿顶住就会打一半被组里的旧名打回。
// 提交走 renameGroup（它自己去重；空名不改），提交后退出草稿，显示回到 curName（可能被去重改过）。
const bsNameEdit = ref(null)
function bsNameVal() { return bsNameEdit.value == null ? bs.curName.value : bsNameEdit.value }
function bsNameCommit() { const v = bsNameEdit.value; bsNameEdit.value = null; if (v != null) bs.renameGroup(bs.activeGroupId.value, v) }
watch(() => bs.activeGroupId.value, () => { bsNameEdit.value = null })

// ===================== 对星覆盖分析（波束打到轨道壳层上）=====================
// 与对地覆盖共用同一棵卫星/天线树与同一套【物理设置】（指向/极化/增益/路损，经 grd.getPerfContext 现取）；
// 只有【显示设置】（档位/填充/画哪些波束）各记一套。渲染走 scene 的壳层专用通道，与对地覆盖互不覆写。
// 两道闸分开传：panelOn（面板开着没有 → 面板读数要不要现算）与 ownsFlat（2D 那块场归不归自己）。
// 前者看 side（面板收起就没人看读数），后者看 sideCtx（收起侧栏不改归属）。场景内容自己按 _painted 存续，两者都不管。
const satcov = useShellCoverage(grd, () => scene, () => flat, () => flatView.value,
  () => shellUi.side === 'satcov', flatActive, () => sideCtx() === 'satcov')
const satPerf = useSatPerfTable()

// 可见性分析（复刻 STK Access / Coverage）：选目标（站/点/航迹/Polygon）→ 仰角门限 → 算可见卫星。
// 宿主能力全经 getter/箭头注入（避免 TDZ；stations/points/renderEntries 等在下方定义，仅运行时调用）。
// 卫星集按 vis.satSrc 分派：''=当前显示（renderEntries）；内置分组/卫星组/自定义卫星=异步解析缓存（见 visSatResolve）。
const vis = useVisibility({
  getStations: () => stations.value, getPoints: () => points.value, getTrajectories: () => trajectories.value,
  getPolys: () => polys.value, getSatSet: () => (vis.satSrc.value ? visSatCache : renderEntries),
  calcAt: () => calcAt(), ccTimeAt: (t) => ccTimeAt(t), isCustomEntry: (e) => isCustomEntry(e),
  refresh: () => { redrawSats(); commitGeometry() },
  // 覆盖分析 FOM 热力图【专用通道】：spec={id,fillBands,alpha} 画到 3D 球 + 2D 平面图；spec=null 清除（互不干扰 GRD 覆盖）。
  drawCov: (spec) => {
    if (spec && spec.fillBands && spec.fillBands.length) {
      const layer = { id: spec.id, fillBands: spec.fillBands }, opts = { alpha: spec.alpha }
      if (scene) scene.setCovGrid(layer, opts)
      if (flat) flat.setCovGrid(layer, opts)
    } else { if (scene) scene.clearCovGrid(); if (flat) flat.clearCovGrid() }
  },
  setCovAlpha: (a) => { if (scene) scene.setCovGridAlpha(a); if (flat) flat.setCovGridAlpha(a) }
})

// ===== 环境场渲染槽的归属闸 =====
// scene / flat 各只有【一个】setEnvRaster 槽，ITU 环境场与「实时气象」共用它（两张半透明场叠在
// 一起本来也读不了图），互斥由下方两条 watch 保证。但互斥只管 on 这个标志，管不了**写槽的次序**：
// 两个组合式各自的 redraw / clearLayer 在自己 on=false 时都会往槽里写 null，而 Vue 的 watcher 按
// 注册序跑、组合式内部那条恒排在页面这两条互斥 watch 之前，于是交接时后手会把先手刚画上的抹掉：
//   ★「实时气象开着 → 打开 ITU 环境场」：ITU 同步画上去 → 实时那条随即被关掉 → 它的 clearLayer
//     把槽清成 null。地图一片空白，而显示开关明明是开的（改配色等任一次 redraw 才回来）。
//   ★「实时气象开着 → 切 2D 平面图」：feedFlat 只补喂 env.redraw()，此时 env.on 必为 false，
//     那一句就把 2D 与 3D 的实时气象层一起清了。
// 故加这道闸：**画上去的那一方成为槽的主人，不是主人的一方不许清槽**。清槽只有主人自己做得到
// （关图层 / 取数失败 / 时钟走出已取时段）。两侧的 draw 一律走这里，别再各写一份。
let envSlotOwner = ''   // '' | 'itu' | 'live'
function envSlotDraw(who, spec) {
  if (spec && spec.canvas) {
    envSlotOwner = who
    const o = { bbox: spec.bbox, alpha: spec.alpha, smooth: spec.smooth }
    if (scene) scene.setEnvRaster(spec.canvas, o)
    if (flat) flat.setEnvRaster(spec.canvas, o)
    return
  }
  if (envSlotOwner && envSlotOwner !== who) return   // 槽是对方画的：交接期间不许替对方清掉
  envSlotOwner = ''
  if (scene) scene.setEnvRaster(null)
  if (flat) flat.setEnvRaster(null)
}

// 环境场（ITU 降雨率 / 零度等温线高度 / 海拔 / 水汽 / 云液态水）：一张等经纬栅格 +（可选）等值线。
// 【专用通道】画在最底层（气象/地形是背景量），与覆盖热力图、GRD 覆盖场互不覆写、可同屏共存。
const env = useEnvField({
  draw: (spec) => envSlotDraw('itu', spec),
  drawContours: (groups) => { if (scene) scene.setEnvContours(groups); if (flat) flat.setEnvContours(groups) },
  setAlpha: (a) => { if (scene) scene.setEnvAlpha(a); if (flat) flat.setEnvAlpha(a) }
})
// 实时/预报气象场（侧栏「实时气象」）。渲染通道与上面的 ITU 环境场**是同一条**：
// scene/flat 各只有一个 setEnvRaster 槽，两张半透明场叠在一起本来也读不了图，
// 故做成互斥（见下面两条 watch），而不是复制一整条渲染管线。
const envLive = useLiveField({
  draw: (spec) => envSlotDraw('live', spec),
  // 没有 drawContours：实时气象只出填色场，等值线是 ITU 环境场那一侧的事。
  // 切过来时对方那条 watch(on) 会自己把线撤掉，故这边不必再补一次清场。
  setAlpha: (a) => { if (scene) scene.setEnvAlpha(a); if (flat) flat.setEnvAlpha(a) },
  // 取完数若时钟落在已取时段之外，把它挪到第一帧——否则取完一片空白，看着像没生效
  setClock: (ms) => clockSetTime(ms),
  // 站点表「从标记导入」的来源：点标记 / 地球站 / 航迹。★ 给的是原始状态而不是 markerXxx()——
  // 后者会被图层开关过滤掉（关掉图层不等于不要这些站），且已把名字换成了显示用的文本。
  markers: () => ({ pts: points.value, sts: stations.value, trs: trajectories.value }),
  // 「区域＝Polygon」档的候选。polys 在下方定义 → getter 传入避免 TDZ（仅运行时调用）
  polys: () => polys.value,
  // 目标星搜索：与对地/对星覆盖分析同一个全量池（星座目录 + 卫星组 + 自定义星座）
  satSearch: (q, limit) => satcovSearch(q, limit),
  // 目标星在任意时刻的星下点与轨道高度。★ 星历与 SGP4 都在渲染端，主进程只收算好的位置 ——
  // 否则每换一帧就要把 satrec 过一次 IPC，且两边各存一份星历必然对不齐。
  satPosAt: (id, tMs) => liveSatPosAt(id, tMs),
  // 站点表「时间」列（航迹航点带进来的时刻）复制 / 导出时的格式：跟显示时区
  fmtTime: (ms) => fmtTzTime(ms, tzMode.value)
})
// 两张场互斥：谁被打开，谁把对方关掉（同一个渲染槽）
watch(() => env.on.value, (v) => { if (v && envLive.on.value) envLive.on.value = false })
watch(() => envLive.on.value, (v) => { if (v && env.on.value) env.on.value = false })

// 当前帧读数：帧号 / 帧时刻 / 起报时次 / 时钟是否落在已取时段内。
// ★ 起报时次不是装饰：同一个钟点，00Z 起报的 f012 与 12Z 起报的 f000 是两份不同的数据，
//   前者是十二小时前算出来的预报。看图的人有权知道自己在看哪一份。
// ★ 改这里的措辞要同步 shared/i18n/uiDict.data.js 的 PAT，而且**必须留一个固定的尾字面量**
//   （现在是 ` UTC` 与 ` h`）：本串首段自带一个 ` / `，而组合模式里 ` / ` 排在 ` · ` 之前，会先把
//   整行从斜杠处劈开成查不到表的碎片，故只能整串配模式；而整串模式若以槽位收尾、首字面量又只有
//   「第 」一个汉字，会被 uiDict.test.mjs 的锚定强度守卫拦下。两条约束合起来 = 结尾必须是死字面量。
const liveTimeText = computed(() => {
  const fi = envLive.frameInfo.value, sp = envLive.timeSpan.value
  if (!sp) return ''
  const pad = (n) => String(n).padStart(2, '0')
  const fmtT = (ms) => { const d = new Date(ms); return `${d.getUTCMonth() + 1}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00 UTC` }
  const cyc = sp.cycle ? ` · 起报 ${fmtT(sp.cycle)}` : ''
  if (!fi.inRange) return `当前时刻不在已获取时段内（${fmtT(sp.t0)} ~ ${fmtT(sp.t1)}）${cyc}`
  const fh = sp.cycle ? ` · +${Math.round((fi.t - sp.cycle) / 3600000)} h` : ''
  return `第 ${fi.idx + 1} / ${sp.n} 帧 · ${fmtT(fi.t)}${cyc}${fh}`
})
// 字节数读数（取数预算与缓存占用共用）
function lvMB(b) {
  const n = Number(b) || 0
  return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'
}
// —— 目标星搜索（「链路参数」分区的「在轨卫星」档）——
// 与对星跟踪的目标星搜索【同款】：全量池、防抖 200 ms + 序号守卫（先发后到的旧结果会盖掉新词的候选）、
// 一行一颗（星名 + 「来源 · NORAD」副行）、底下如实报命中总数。
const lvSatQ = ref('')
const lvSatCand = ref([])
const lvSatTotal = ref(0)
const lvSatBusy = ref(false)
let lvSatSeq = 0, lvSatTimer = null
watch(lvSatQ, (v) => {
  const q = String(v || '').trim()
  if (lvSatTimer) { clearTimeout(lvSatTimer); lvSatTimer = null }
  lvSatSeq++                                  // 作废在途结果（清空输入时尤其重要）
  if (!q) { lvSatCand.value = []; lvSatTotal.value = 0; lvSatBusy.value = false; return }
  lvSatBusy.value = true
  lvSatTimer = setTimeout(async () => {
    const seq = lvSatSeq
    let r = { items: [], total: 0 }
    try { r = (await satcovSearch(q, 60)) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== lvSatSeq) return
    lvSatCand.value = r.items || []; lvSatTotal.value = r.total || 0; lvSatBusy.value = false
  }, 200)
})
function lvPickSat(e) {
  envLive.satId.value = e.noradId ? 'n:' + e.noradId : 'm:' + e.name
  envLive.satName.value = e.name
  lvSatQ.value = ''
}
function lvClearSat() { envLive.satId.value = ''; envLive.satName.value = '' }
// 目标星此刻的星下点读数。★ 用的是**时钟时刻**而不是气象帧时刻：地图上的星画在时钟那一刻，
// 两者若不同源，LEO 的衰减足迹会与星标错开小半圈。
const lvSatPosText = computed(() => {
  const p = envLive.satPos.value
  if (!p) return ''
  const ll = `${Math.abs(p.lon).toFixed(2)}°${p.lon < 0 ? 'W' : 'E'} ${Math.abs(p.lat).toFixed(2)}°${p.lat < 0 ? 'S' : 'N'}`
  return `${ll} · ${p.altKm >= 1000 ? p.altKm.toFixed(0) : p.altKm.toFixed(1)} km`
})
// ===== 气象指标表：独立窗口（src/perf/MetTableWin.vue），宿主端接线在 viz/grd/perfWinHost.js =====
// 站点列表由弹窗编辑后整份发回 envLive.sites；读数随时钟由 envLive 自己刷、经 perfHost 推过去。
function openMetTable() { if (!perfHost.has()) { appAlert('需在桌面客户端中运行'); return } perfHost.open('met', '') }
// 站点数一变（增删行/粘贴/导入）就重算读数；深监听坐标改动同理
watch(() => envLive.sites.value.map((s) => s.id + ':' + s.lon + ',' + s.lat).join('|'), () => envLive.refreshSites())

// 光标读数：经纬度（状态栏固有）+ 当前环境场值（有图层时才有）
// 两张场互斥，故谁开着就读谁 —— 状态栏只有一格，不并列。
function onHoverLL(ll) {
  cursor.ll = ll
  cursor.env = ll ? (env.readAt(ll.lat, ll.lon) || envLive.readAt(ll.lat, ll.lon)) : null
  cursor.look = ll ? lookReadout(ll) : null
}
// 光标所在点【相对参考卫星】的视角读数。档位与参考卫星都在 mapCrs 里，几何走 coverage 的 satLookAt。
// ★ 地平线以外的点照给数值（天线系是纯几何的，那里仍有定义），可见与否连同地心角、斜距一起写进 title
//   —— 界面上只留数字，判定性的话不写（见 CLAUDE.md）。
function lookReadout(ll) {
  if (mapCrs.lookMode === 'off' || !mapCrs.subPt) return null      // 没设星下点就没有这一项：这两个角是相对它的
  if (!subOpen.value) return null                                    // 「星下点」收起＝关掉：准星不画，相对它的读数也不出
  const p = subPtPos.value
  if (!p) return null
  const k = satLookAt(p.lon, p.lat, p.alt, ll.lon, ll.lat)
  if (!k || !Number.isFinite(k.az)) return null
  const en = curLang() === 'en'
  const tail = ` · γ ${k.gamma.toFixed(2)}° · ${en ? 'slant range' : '斜距'} ${k.range.toFixed(0)} km`
    + (k.vis ? '' : (en ? ' · beyond the horizon' : ' · 地平线以外'))
  // ★ 两个量各带自己的名字（用户要的就是这个）：光看两个数分不清哪个是 az 哪个是 el
  const sep = en ? ': ' : '：'
  const who = p.name || (en ? 'the sub-satellite point' : '星下点')
  return mapCrs.lookMode === 'uv'
    ? {
      text: 'u' + sep + k.u.toFixed(4) + '   v' + sep + k.v.toFixed(4),
      title: (en ? 'Direction cosines of this point in the antenna frame of ' : '该点在 ')
        + who + (en ? ' (boresight = nadir)' : ' 的天线系里的方向余弦（boresight＝星下天底）') + tail
    }
    : {
      text: 'az' + sep + k.az.toFixed(2) + '°   el' + sep + k.el.toFixed(2) + '°',
      title: (en ? 'Azimuth / elevation of this point seen from ' : '从 ')
        + who + (en ? ' (antenna frame, boresight = nadir)' : ' 看该点的方位角 / 仰角（天线系，boresight＝星下天底）') + tail
    }
}
// 陆海掩膜要靠 P.1511 地形数据，未随包分发到位时（打包漏文件）该项不可用，置灰而不是静默失效
const envMaskAvail = computed(() => !env.field.value || env.field.value.maskAvail !== false)
// 切到手动值域：先把当前自动值域填进去，用户在这个基础上改，而不是从空白开始猜
function envManualInit() {
  const d = env.domain.value
  if (d && (env.manualLo.value === '' || env.manualHi.value === '')) {
    env.manualLo.value = String(Number(d[0].toFixed(3)))
    env.manualHi.value = String(Number(d[1].toFixed(3)))
  }
  env.domainMode.value = 'manual'
}
// 实时气象场切「手动值域」：先把当前自动值域填进去，用户在这个基础上改。
// ★ 跨帧可比这件事在实时场上是刚需（分位档下颜色每帧都在变，看不出雨区是移动还是增强），
//   但默认已由「业务档位」解决 —— 手动档只留给要盯某个特定区间的场合。
function liveManualInit() {
  const d = envLive.domain.value
  if (d && (envLive.manualLo.value === '' || envLive.manualHi.value === '')) {
    envLive.manualLo.value = String(Number(d[0].toFixed(3)))
    envLive.manualHi.value = String(Number(d[1].toFixed(3)))
  }
  envLive.domainMode.value = 'manual'
}

// 图例每一格的悬停说明：分级给区间，连续给该处的值
function envLegTitle(i) {
  const L = env.legend.value
  if (!L) return ''
  if (L.edges) return `${env.fmt(L.edges[i])} ~ ${env.fmt(L.edges[i + 1])} ${L.unit}`
  return `${env.fmt(L.lo + (L.hi - L.lo) * L.stops[i].u)} ${L.unit}`
}
// 可见性分析：可见星复用「聚焦特效」立体呈现——在轨道高度的绿点(satPos) + 目标→星视线斜线(2 点 orbit 走 lineFromLLA，
// 尊重每端高度)，经 scene.setSelectionSet 画（唯一能在轨道高度画卫星点的通道）。
// 只「算」不「推」：返回 { items(在轨点+视线), subs(星下点图标，各自带 px/colorHex) }，由 commitGeometry 与聚焦星几何合并后一次性提交，
// 二者共用同一 replace-all 通道却互不覆盖——可见性模式下聚焦某星，其星下点/轨迹/足迹照常显示、随时间轴移动。
function computeVisibilityGeometry() {
  if (!scene || !vis.open.value || vis.mode.value === 'coverage') return { items: [], subs: [] }
  const rs = vis.results.value, tp = vis.targetPoints()
  if (!rs.length || !tp.length) return { items: [], subs: [] }
  const tgt = tp[0]
  const hid = String(vis.hoveredId.value || '')
  const icm = /^#?([0-9a-f]{6})$/i.exec(String(vis.iconColor.value || '')), icNum = icm ? parseInt(icm[1], 16) : 0x4caf82
  const subPx = (Number(vis.iconSize.value) || 12) * 1.6   // 3D 星下点图标：大小×1.6对齐屏幕像素、颜色随面板（与 2D 一致）
  const items = [], subs = []
  for (const r of rs) {
    if (!Number.isFinite(r.subLon) || !Number.isFinite(r.subLat)) continue
    const hot = hid && String(r.noradId) === hid
    items.push({
      satPos: { lat: r.subLat, lon: r.subLon, altKm: r.altKm, color: hot ? '#efeae0' : (vis.iconColor.value || '#4caf82') },
      // 视线连线可关（showLines）：星多时几百根线糊成扇面；关线只影响呈现，在轨点/星下点/悬停高亮照常
      orbit: vis.showLines.value ? [{ lat: tgt.lat, lon: tgt.lon, altKm: 0 }, { lat: r.subLat, lon: r.subLon, altKm: r.altKm }] : null,
      // raw：这条是【目标→星的视线斜线】，不是聚焦星的轨道线 —— 钉出厂样式，不跟「显示设置 · 轨道线」变色/关掉
      raw: true,
      primary: hot
    })
    subs.push({ lat: r.subLat, lon: r.subLon, px: subPx, colorHex: icNum })
  }
  return { items, subs }
}
// 卫星集下拉选「当前显示」时的悬停读数：当前显示具体是谁（星座 / 自定义星座 / 卫星组 / 搜索 + 名称）
const visSatTitle = computed(() => {
  if (vis.satSrc.value) return ''
  const L = satSetLabel.value
  return `当前显示：${L.kind ? L.kind + ' · ' : ''}${L.name}`
})
// 可见性分析目标下拉：值形如 'kind|id'（kind ∈ station|point|traj|poly）→ 拆给 vis.setTarget
function visPickTarget(v) {
  const s = String(v == null ? '' : v), i = s.indexOf('|')
  if (i < 0) { vis.setTarget('', ''); return }
  vis.setTarget(s.slice(0, i), s.slice(i + 1))
}
// 仰角门限输入：允许临时清空（显示空、按 0° 算），非法输入保持原值——不卡在空/NaN
function visSetElev(v) { vis.minElev.value = (v === '' || v == null) ? '' : (Number.isFinite(Number(v)) ? Number(v) : vis.minElev.value) }
// 二期新加的界面词（挂点 / 姿态律）按语言直接出字：词典（uiDict）不归本页管，呈现层查不到就会在英文界面漏成中文。
// 读 langTick 建立依赖 —— 切语言时模板随之重渲染（byLang 本身读 localStorage，不是响应式）
const langTick = ref(0)
const offLangTick = onLangChange(() => { langTick.value++ })
function zhEn(zh, en) { void langTick.value; return byLang(zh, en) }
// 星下点图标大小：允许临时清空（空按默认 12 画），非法保持原值，1–64 钳制（负/超大像素会画坏图层）
function visSetIcon(v) { vis.iconSize.value = (v === '' || v == null) ? '' : (Number.isFinite(Number(v)) ? Math.min(64, Math.max(1, Number(v))) : vis.iconSize.value) }
// 方位角 → 八向罗盘文本
const VIS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
function visCompass(az) { const a = ((Number(az) % 360) + 360) % 360; return VIS_DIRS[Math.round(a / 45) % 8] }
// 分钟 → 简短时长文本（如 2h15m / 45m）
function visDur(min) { const m = Math.max(0, Math.round(Number(min) || 0)); const h = Math.floor(m / 60), mm = m % 60; return h ? h + 'h' + (mm < 10 ? '0' : '') + mm + 'm' : mm + 'm' }
// ==== 时段过境：绝对时刻呈现（UTC / 本地双轨；显示时区跟 vis.accessTz 开关，导出恒双时区）====
const p2t = (n) => (n < 10 ? '0' : '') + n
// 分钟 → 秒级时长文本（≥1h 归整到分：2h16m；<1h 带秒：7m07s）——过境单窗常只有几分钟，分钟取整会把 30s 的差抹平
function visDurS(min) {
  let s = Math.max(0, Math.round((Number(min) || 0) * 60))
  const h = Math.floor(s / 3600); s -= h * 3600
  const m = Math.floor(s / 60); s -= m * 60
  return h ? h + 'h' + p2t(m) + 'm' : m + 'm' + p2t(s) + 's'
}
// 双时区并排里「另一套」的档位：恒是 UTC ＋这一档。显示档位选了 UTC 时它退回本机——
// 否则详情卡 / title / 导出里两轨会是一模一样的两列。
const visAltTz = computed(() => (vis.accessTz.value === 'utc' ? 'local' : vis.accessTz.value))
// 另一套时刻的时区角标：'UTC+8'（半时区如 'UTC+5:30'）
function visTzTag(ms) { return tzTag(visAltTz.value, ms || vis.accessBaseMs.value || Date.now()) }
// 当前显示档位的角标（时基行上那枚选择器显示的就是它）
const visTzNow = computed(() => tzTag(vis.accessTz.value, vis.accessBaseMs.value || Date.now()))
// ms → 指定时区的日期分量；utc 省缺跟随显示档位（供表格），显式传值供双时区并排（详情卡 / title / 导出）
function visP(ms, utc) {
  const t = tzParts(ms, utc == null ? vis.accessTz.value : (utc ? 'utc' : visAltTz.value))
  return { y: t.y, mo: t.mo, da: t.d, h: t.h, mi: t.mi, se: t.s }
}
const visHms = (ms, utc) => { const p = visP(ms, utc); return p2t(p.h) + ':' + p2t(p.mi) + ':' + p2t(p.se) }
const visYmd = (ms, utc) => { const p = visP(ms, utc); return p.y + '-' + p2t(p.mo) + '-' + p2t(p.da) }
const visMdHms = (ms, utc) => { const p = visP(ms, utc); return p2t(p.mo) + '-' + p2t(p.da) + ' ' + p2t(p.h) + ':' + p2t(p.mi) + ':' + p2t(p.se) }
const visYmdHm = (ms, utc) => { const p = visP(ms, utc); return visYmd(ms, utc) + ' ' + p2t(p.h) + ':' + p2t(p.mi) }
// 相对分钟 → 绝对 ms（锚在本次计算的时窗起点；合成星窗口在相对轴上与甘特同轴，映射后与真实星可比）
const visAbsMs = (min) => vis.accessBaseMs.value + min * 60000
// 显示时区里 ms 落在时窗第几天（0=起算日）：跨日角标与日期分隔行同源
function visDayIdx(ms) {
  const a = visP(ms), b = visP(vis.accessBaseMs.value)
  return Math.round((Date.UTC(a.y, a.mo - 1, a.da) - Date.UTC(b.y, b.mo - 1, b.da)) / 86400000)
}
// 双时区完整读数（title 用）：'2026-08-17 22:38:05 UTC+8｜14:38:05 UTC'（同日省 UTC 侧日期）
function visBoth(ms) {
  const lp = visP(ms, false), up = visP(ms, true)
  const sameDay = lp.y === up.y && lp.mo === up.mo && lp.da === up.da
  return visYmd(ms, false) + ' ' + visHms(ms, false) + ' ' + visTzTag(ms) + '｜' + (sameDay ? '' : visYmd(ms, true) + ' ') + visHms(ms, true) + ' UTC'
}
const accEndMs = computed(() => vis.accessBaseMs.value + vis.accessKpi.value.horizonMin * 60000)
// 甘特绝对时间刻度：整点对齐（显示时区），档位取到 ≤6 个刻度；午夜刻度改标日期
const accAxis = computed(() => {
  const H = vis.accessKpi.value.horizonMin, base = vis.accessBaseMs.value
  if (!(H > 0) || !base || !vis.accessResults.value.length) return []
  const STEPS = [15, 30, 60, 120, 180, 240, 360, 720, 1440]
  const step = STEPS.find((s) => H / s <= 6) || 1440 * Math.ceil(H / 6 / 1440)
  const p = visP(base), stepMs = step * 60000
  const dayStart = base - ((p.h * 3600 + p.mi * 60 + p.se) * 1000) - (base % 1000)
  const out = [], endMs = base + H * 60000
  for (let t = dayStart + Math.ceil((base - dayStart) / stepMs) * stepMs; t <= endMs; t += stepMs) {
    const pct = (t - base) / (H * 60000) * 100
    if (pct < 2.5 || pct > 97.5) continue   // 端点值已在时窗读数行给出，贴边刻度只会被裁半
    const q = visP(t), midnight = q.h === 0 && q.mi === 0
    out.push({ pct, label: midnight ? p2t(q.mo) + '-' + p2t(q.da) : p2t(q.h) + ':' + p2t(q.mi), day: midnight })
  }
  return out
})
// 过境表行序（'time'=按 AOS 混排 + 日期分隔行；'sat'=按星分组）。行内预折好显示串，模板保持哑渲染
const accExpKey = ref('')   // 当前展开详情的行 key（''=全收起；点行切换）
const accHovKey = ref('')   // 悬停的过境窗 key（表格行 ⇆ 甘特段 段级 brush-and-link；星级联动仍走 vis.setHover）
const accGanttEl = ref(null)
function accToggle(k) { accExpKey.value = accExpKey.value === k ? '' : k }
// 点击过境行：甘特滚到该星那一行，让高亮段进入可见区。上向对齐要让开钉在容器顶的 sticky 刻度轴
function accScrollTo(nid) {
  const box = accGanttEl.value
  if (!box) return
  const row = [...box.querySelectorAll('.vis-grow[data-nid]')].find((el) => el.dataset.nid === String(nid))
  if (!row) return
  const axis = box.querySelector('.vis-gaxis')
  const cr = box.getBoundingClientRect(), rr = row.getBoundingClientRect()
  const topGuard = cr.top + (axis ? axis.getBoundingClientRect().height : 0)
  const d = rr.top < topGuard ? rr.top - topGuard : rr.bottom > cr.bottom ? rr.bottom - cr.bottom : 0
  if (d) box.scrollTo({ top: box.scrollTop + d, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}
watch(() => vis.accessResults.value, () => { accExpKey.value = ''; accHovKey.value = '' })
const accRows = computed(() => {
  const out = [], flat = []
  for (const s of vis.accessResults.value) for (let wi = 0; wi < s.windows.length; wi++) flat.push({ s, w: s.windows[wi], wi })
  const byTime = vis.accOrder.value !== 'sat'
  if (byTime) flat.sort((a, b) => a.w.startMin - b.w.startMin)
  let day = null
  for (const it of flat) {
    const sMs = visAbsMs(it.w.startMin), eMs = visAbsMs(it.w.endMin)
    const ds = visDayIdx(sMs), de = visDayIdx(eMs)
    if (byTime && ds !== day) { day = ds; out.push({ type: 'day', key: 'day' + ds, ms: sMs, d: ds }) }
    out.push({
      type: 'w', key: String(it.s.noradId) + '-' + it.wi, s: it.s, w: it.w,
      t1: visHms(sMs), t2: visHms(eMs), sup1: (!byTime && ds > 0) ? ds : 0, sup2: de > ds ? de - ds : 0,
      title: it.s.name + (it.s.slot ? ' · ' + it.s.slot : '')
        + '\nAOS ' + visBoth(sMs) + '\nLOS ' + visBoth(eMs)
        + '\n峰值 ' + visBoth(visAbsMs(it.w.peakMin)) + ' · ' + it.w.peakEl.toFixed(1) + '°'
        + '\n时长 ' + visDurS(it.w.durMin) + ' · AOS 相对 +' + visDur(it.w.startMin) + (it.w.truncated ? ' · 截至时窗末' : '')
    })
  }
  return out
})
// 甘特单段 title：双时区 AOS/LOS + 时长 + 峰仰角
function accSegTitle(w) {
  return 'AOS ' + visBoth(visAbsMs(w.startMin)) + '\nLOS ' + visBoth(visAbsMs(w.endMin)) + '\n时长 ' + visDurS(w.durMin) + ' · 最高 ' + w.peakEl.toFixed(0) + '°'
}
// 可见性侧栏分节头右侧读数（三模式各一套）。「时间覆盖」是严口径值，两种模式各有算法，定义一律写进 title——
// 只摆一个孤零零的百分数会被当成松口径的「够不够得着」误读（那是覆盖面积，恒偏大）。
const visCnt = computed(() => {
  const m = vis.mode.value
  if (m === 'coverage') {
    if (!vis.covData.value) return { text: vis.covBusy.value ? '计算中' : '未计算', title: '', on: false }
    const k = vis.covKpi.value
    if (!k) return { text: '', title: '', on: false }
    return {
      on: k.timePct > 0,   // 读数着绿只给「有覆盖」这一个事实；0% / 未计算保持淡灰
      text: k.timePct.toFixed(0) + '% 时间覆盖',
      title: `时间覆盖 ${k.timePct.toFixed(2)}%\n＝ 各网格「被覆盖时间占比」按面积（cos φ）加权平均，即区域 × 时窗的时空占比；从不被覆盖的格按 0 计入，不剔除。\n\n最差格 ${k.worstPct.toFixed(2)}% —— 区域内时间覆盖最低的那一点（为 0 说明存在整个时窗都覆盖不到的点）\n覆盖面积 ${k.coverPct.toFixed(2)}% —— 时窗内【曾经】被覆盖过的面积占比（松口径，一格只覆盖 1 个采样也算满，恒 ≥ 时间覆盖）`
    }
  }
  if (m === 'access') {
    const n = vis.accessResults.value.length
    if (!n) return { text: '0 星过境', title: '', on: false }
    const k = vis.accessKpi.value
    return {
      on: true,
      text: n + ' 星过境 · ' + k.pct.toFixed(0) + '% 时间覆盖',
      title: `时间覆盖 ${k.pct.toFixed(2)}%\n＝ ${n} 星共 ${k.passes} 次过境窗口【合并重叠】后的可见时长 ${visDur(k.coveredMin)} ÷ 时窗 ${visDur(k.horizonMin)}。多星同时可见只计一次——不是各次时长求和（求和会重复计数、可超 100%）。\n窗口边界取二分精炼后的 AOS/LOS，被时窗切断的过境只计窗内那一段。\n\n最长中断 ${visDur(k.maxGapMin)}（共 ${k.gapCount} 段，含时窗首尾）`
    }
  }
  return { text: vis.results.value.length + ' 颗', title: '', on: vis.results.value.length > 0 }
})
// 覆盖分析 FOM 读数格式化（时间类=整数分钟；≥100 取整；近整数取整；否则一位小数）
function covFmt(v, leg) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (leg && leg.time) return Math.round(v).toLocaleString()
  if (Math.abs(v) >= 100) return Math.round(v).toLocaleString()
  if (Math.abs(v - Math.round(v)) < 1e-6) return String(Math.round(v))
  return v.toFixed(1)
}
// 图例色带某档的值区间（鼠标悬停显示）：[lo+i/bands·跨度, lo+(i+1)/bands·跨度]
function covBandLabel(i, leg) {
  if (!leg) return ''
  const span = leg.hi - leg.lo, a = leg.lo + span * i / leg.bands, b = leg.lo + span * (i + 1) / leg.bands
  return covFmt(a, leg) + ' ~ ' + covFmt(b, leg) + (leg.unit ? ' ' + leg.unit : '')
}
// 时段过境（Access）导出 Excel（《三线表模板_TimesNewRoman_11pt》版式：摘要 / 过境明细 / 逐星汇总，UTC 与本地双时区）。
// 渲染端只组纯数据模型（IPC 过不了响应式代理——逐字段现造纯数据），版式在主进程 report.js buildVisAccessExcel。
async function exportAccessExcel() {
  const rows = vis.accessResults.value
  if (!rows || !rows.length) { appAlert('先点「计算过境」生成结果'); return }
  if (!(window.api && window.api.visAccess)) { appAlert('需在桌面客户端中运行'); return }
  const tk = vis.targetKind.value, tid = vis.targetId.value
  let tgtName = '目标'
  if (tk === 'station') tgtName = ((stations.value.find((x) => x.id === tid) || {}).name) || '地球站'
  else if (tk === 'point') { const p = points.value.find((x) => x.id === tid); tgtName = p ? (p.name || fmtLL(p.lat, p.lon)) : '点标记' }
  else if (tk === 'poly') tgtName = ((polys.value.find((x) => x.id === tid) || {}).name) || 'Polygon'
  const tp = vis.targetPoints()
  const L = satSetLabel.value, base = vis.accessBaseMs.value, k = vis.accessKpi.value
  const payload = {
    defaultName: '过境窗口_' + String(tgtName).replace(/[\\/:*?"<>|]/g, '_'),
    target: { name: String(tgtName), kind: tk, lat: tp.length ? tp[0].lat : null, lon: tp.length ? tp[0].lon : null },
    satSet: (L.kind ? L.kind + ' · ' : '') + L.name, scanned: vis.accessScanned.value,
    minElevDeg: Number(vis.minElev.value) || 0,
    baseMs: base, horizonMin: k.horizonMin,
    tzOffsetMin: tzOffMin(visAltTz.value, base), tzTag: visTzTag(base),
    kpi: { pct: k.pct, coveredMin: k.coveredMin, maxGapMin: k.maxGapMin, gapCount: k.gapCount, sats: k.sats, passes: k.passes },
    sats: rows.map((s) => ({
      name: String(s.name || ''), noradId: String(s.noradId == null ? '' : s.noradId), slot: String(s.slot || ''),
      windows: s.windows.map((w) => ({ startMin: w.startMin, endMin: w.endMin, durMin: w.durMin, peakMin: w.peakMin, peakEl: w.peakEl, truncated: !!w.truncated }))
    }))
  }
  const r = await window.api.visAccess.exportExcel(payload)
  if (r && !r.ok && !r.canceled) appAlert('导出失败：' + (r.error || '未知错误'))
}
async function toggleGrd() {
  grdOpen.value = !grdOpen.value
  if (grdOpen.value) { await grd.loadIndex(); grd.recompute(); redrawSats() }
}

// ===================== 性能指标表（SATSOFT Performance Table）：独立窗口 =====================
// 三张表（对地 / 对星 / 气象）的界面都在独立窗口（src/perf/*，一根天线一窗、可多开），本页只做数据与取值：
// perf / satPerf 是持久化桶 + 取值器，perfHost（viz/grd/perfWinHost.js）负责开窗、推状态、收操作。
const perf = usePerfTable()
const perfHost = createPerfWinHost({
  api: (typeof window !== 'undefined' && window.api && window.api.perfWin) || null,
  grd, perf, satPerf, satcov, envLive,
  scene: () => scene, flat: () => flat,
  // 标记原始状态（不经图层开关过滤，名字不换成显示文本）：弹窗的「导入标记 / 航迹」按这份列
  markers: () => ({ pts: points.value, sts: stations.value, trs: trajectories.value }),
  fmtLL: (lon, lat) => envLive.fmtLL(lon, lat),
  timeLabel: () => timeText.value, liveTimeText: () => liveTimeText.value,
  tzMode: () => tzMode.value, nowMs: () => clock.tMs,
  satcovSearch: (q, limit, exclude) => satcovSearch(q, limit, exclude),
  satcovTimes: () => satcovTimes(),
  // 对地性能表里带时刻的行（航迹航点）：源星 / 对星指向的目标星 / 姿态挂点按那一刻解 —— 与对星表时段扫描同一组钩子
  perfGeomEnv: (ctx) => ({ srcRec: satcovSourceRec(ctx), boreRec: satcovBoreRec(ctx), attAt: satcovAttAt(ctx) }),
  satcovResolveTargets: (ctx, key) => satcovResolveTargets(ctx, key),
  satcovAddInBeam: (key) => satcovAddInBeam(key),
  satcovScanWindows: (key) => satcovScanWindows(key),
  focusTarget: (t) => satcovFocusTarget(t), seekClock: (t) => satcovSeekClock(t)
})
// 树里每根天线下的「性能指标表」入口：开着的天线高亮（一根天线一窗，再点＝前置）
const perfOpenSet = computed(() => { void perfHost.ver.value; return new Set(perfHost.groundKeys()) })
const shellOpenSet = computed(() => { void perfHost.ver.value; return new Set(perfHost.shellKeys()) })
// 点天线下方「性能指标表」→ 开该天线的窗口（确保其方向图已载入再取值）
async function openPerf(sat, a) {
  const key = grd.keyOf(sat.folder, a.name)
  const ok = await grd.ensureAntLoaded(key)
  if (!ok) { appAlert('该天线方向图未就绪，无法生成性能表'); return }
  if (!perfHost.has()) { appAlert('需在桌面客户端中运行'); return }
  await perfHost.open('ground', key)
}
// 树里「性能指标表」行的眼睛：该表城市在地图上的标记与标签总开关（不看窗口开没开；关窗标记还在，眼睛关了才清）
function togglePerfCity(sat, a) {
  const key = grd.keyOf(sat.folder, a.name)
  perfHost.setCityShow(key, !perf.cityShowOf(key))
}

// ===================== 对星指向：目标星身份 ↔ 当前 ECEF =====================
// 身份串用 'n:<NORAD>'，没有编号的（自定义/合成星）退用 'm:<名字>'。存进天线设置里要跨会话稳定，
// 故不能存数组下标或对象引用。
const satIdOf = (e) => (e && e.noradId ? 'n:' + e.noradId : (e ? 'm:' + e.name : ''))
// 全量目录索引（NORAD / 名字 → 条目）：searchPool 一旦就绪就不再变，故只建一次。
// satEntryById 会被指向计算与聚焦特效【每帧】调到，两万多条上做线性 find 扛不住。
let _poolById = null, _poolByName = null
function poolIndexReady() {
  if (!poolReady) return false
  if (!_poolById) {
    _poolById = new Map(); _poolByName = new Map()
    for (const e of searchPool) {
      const n = String(e.noradId)
      if (!_poolById.has(n)) _poolById.set(n, e)
      if (!_poolByName.has(e.name)) _poolByName.set(e.name, e)
    }
  }
  return true
}
// 目标星不在场且全量目录还没建 → 后台拉一次；就绪后清帧缓存并重算（此前解析不到的指向这时才生效）
let _borePoolPending = false
function requestSearchPoolForBore() {
  if (poolReady || _borePoolPending || !apiOk) return
  _borePoolPending = true
  ensureSearchPool().finally(() => {
    _borePoolPending = false
    _tgtBucket = -1; _tgtMap = new Map()
    if (!poolReady) return                       // 离线/失败：别空转重算
    // 补一拍而不是各自重画：目标星解析通了只是其一，源星若也是刚解析通的关联星，meta 还停在
    // 存盘位置 —— recompute 只重画不修 meta，得走 tickLive 那条。一拍对齐全场（星位/覆盖/壳层/
    // 视轴/表），与「一次调用 = 一个时刻的完整画面」同口径；对星指向天线在 tickLive 里无条件
    // 标 moved，原先 recompute + commitGeometry 的职责全被这一拍覆盖。
    refreshPositions()
  })
}
// 天线树里的同步轨道定点星在星座里生成的那批条目（viz/grd/treeGeo.js；由 syncTreeGeo 按树重建，对象跨重建复用）。
// 普通变量不进 ref：条目要进选中集、喂聚焦几何 Worker，深响应读出来是 Proxy 会 DataCloneError。
// treeGeoIdMap（folder → 合成号串）是给树一侧（高亮 / 两钮 / 信息卡天线节）派生用的响应式镜像。
const treeGeoCache = new Map()     // folder → 条目
let treeGeoList = []               // 按树序
let treeGeoById = new Map()        // 合成号串 → 条目
const treeGeoIdMap = shallowRef(new Map())
// 身份串 → 卫星条目。★【全量】解析，不限于在场：对星跟踪的目标星可以是任何一颗目录星 /
// 自定义星座合成星 / 卫星组成员，它没被渲染出来不影响指向解算（与搜索池同一口径，见 satcovSearch）。
// 顺序＝在场（与点云同一批对象）→ 天线树定点星（小眼睛关着也在）→ 全量在轨目录 → 自定义星座（含隐藏的座，取最新一次生成的合成星）。
function satEntryById(id) {
  if (!id) return null
  const isN = id.startsWith('n:'), key = id.slice(2)
  const live = isN ? renderEntries.find((x) => String(x.noradId) === key) : renderEntries.find((x) => x.name === key)
  if (live) return live
  if (isN) { const tg = treeGeoById.get(key); if (tg) return tg }
  if (poolIndexReady()) { const e = isN ? _poolById.get(key) : _poolByName.get(key); if (e) return e }
  else requestSearchPoolForBore()
  return (isN ? customConst.findByNorad(key) : customConst.catalog().find((x) => x.name === key)) || null
}
/**
 * 「实时气象」的目标星：任意时刻的星下点 + 轨道高度（WGS-84 大地高，与 SGP4 出参同口径）。
 * 与对星跟踪共用 satEntryById 那条全量解析路 —— 目标星不必在场，池没就绪时它自己会去催加载。
 * ★ 星历与 SGP4 都留在渲染端：主进程只收算好的位置。否则每换一帧都要把 satrec 过一次 IPC，
 *   且两边各存一份星历必然对不齐。
 * ★ 整体 try 住：本函数会被 useLiveField 建 watch 时**在 setup 期就调一次**，那时目录相关的
 *   状态可能还没轮到初始化（TDZ）。此时如实返回 null（界面显示「星历未载入」），
 *   目录就绪后由 poolTick → satTick 那条 watch 触发重解，不静默拿 GEO 顶替。
 */
function liveSatPosAt(id, tMs) {
  if (!id) return null
  try {
    const e = satEntryById(id)
    if (!e || !e.rec) return null
    const t = new Date(Number(tMs) || Date.now())
    const pv = posAt(e, t)
    if (!pv || !pv.position) return null
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(t))
    const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude), altKm = gd.height
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altKm)) return null
    return { lat, lon, altKm, name: e.name }
  } catch { return null }            // 根数异常 / 已衰减 / setup 期：一律如实报不出来
}
// 帧内缓存：一次重算里 basisKeyOf + beamBasis 会反复问同一颗星，逐次 SGP4 太浪费。
// 桶宽 100 ms —— 实时档 calcAt() 每次调用都不同毫秒，不分桶就等于没缓存。
let _tgtBucket = -1, _tgtMap = new Map()
function satTargetEcef(id) {
  if (!id) return null
  const t = calcAt(), bucket = Math.floor(t.getTime() / 100)
  if (bucket !== _tgtBucket) { _tgtBucket = bucket; _tgtMap = new Map() }
  if (_tgtMap.has(id)) return _tgtMap.get(id)
  let P = null
  const e = satEntryById(id)
  if (e) {
    const cc = isCustomEntry(e), tm = cc ? ccTimeAt(t) : t
    try {
      const pv = posAt(e, tm)
      if (pv && pv.position) { const ecf = sat.eciToEcf(pv.position, sat.gstime(tm)); P = [ecf.x, ecf.y, ecf.z] }
    } catch { P = null }
  }
  _tgtMap.set(id, P)
  return P
}

// ===================== 卫星本体（二期）：GRD「姿态 + 挂点」/ 对星时段扫描的宿主注入 =====================
// 姿态 / 挂点 / 掩模的数学全在 bodyRt（src/viz/models/bodyRuntime.js → packages/core/models），这里只做「谁是哪颗星、此刻在哪」：
//   · GRD 天线 → 树节点 → 本体身份键：有 NORAD 的按 satcovSourceRec 同一顺序（liveEntryOf：在场 → 全量目录 → 自定义星座）
//     找到条目再 satKeyOf；orbit / custom / preset 星没有目录身份，用 grdsat:<folder>（D8）。
//   · 位置 / 速度：条目或轨道根数星按星历（TEME pv + 该时刻 GMST）；固定星按 meta 的星位（与覆盖基底 S 同一点），速度由 attitude
//     按 ω⊕ × r 合成（顺行赤道）。
//   · 挂点：天线设置里选的 boreMount → 否则 antennaRef 指向本天线（{kind:'grd', id:'folder|name'}）的那一副 → 否则缺省挂点
//     （视轴本体 +Z、up 本体 −Y；nadir 律下与手动天底逐位相等，D1）。
// ★ 在这里建（不在下面「卫星 3D 模型」那节）：本节的函数要在 setup 期就 provide 出去，而 bodyRt.onChange 的登记不能撞 TDZ。
//   绑定表的唯一缓存就是它（自己订 models:changed 的 bindings 广播重载）；模型那节的 modelBinds 只是它的镜像，见 onBodyRtChange
const bodyRt = createBodyRuntime({ api: (typeof window !== 'undefined' && window.api) || null, resolveTargetEcef: (k, t) => bodyTargetEcef(k, t) })
const bodyVer = ref(0)   // 绑定 / 掩模版本（挂点下拉之类的界面读它，绑定一变就重算）
bodyRt.onChange(() => { bodyVer.value++ })
function grdNodeOf(folder) { return folder ? (grdSats.value.find((x) => x.folder === folder) || null) : null }
// NORAD → 条目（与 liveEntryOf 同一顺序：在场 → 全量目录 → 自定义星座）。逐拍热路径（getAttAxes 未命中、对星瞬时表）
// 会反复问同一颗：在场集 / 全量池按数组引用记一张表（两者都是整份换新，不原地改），换了就作废；
// 自定义星座合成星不记（历元一改合成星整批重建，findByNorad 自己有签名缓存）
// 点序列星历（ephAll，不论图层显隐）排在全量目录之后，与 liveEntryOf 同一顺序
let _beMap = new Map(), _beSrcE = null, _beSrcP = null, _beSrcX = null, _bePoolIdx = null
function bodyEntryOf(noradId) {
  if (noradId == null || noradId === '') return null
  if (_beSrcE !== entries || _beSrcP !== searchPool || _beSrcX !== ephAll) { _beSrcE = entries; _beSrcP = searchPool; _beSrcX = ephAll; _beMap = new Map(); _bePoolIdx = null }
  const id = String(noradId)
  let e = _beMap.get(id)
  if (e === undefined) {
    e = entries.find((x) => String(x.noradId) === id) || null
    if (!e && searchPool.length) {
      if (!_bePoolIdx) { _bePoolIdx = new Map(); for (const en of searchPool) { const k = String(en.noradId); if (!_bePoolIdx.has(k)) _bePoolIdx.set(k, en) } }
      e = _bePoolIdx.get(id) || null
    }
    if (!e && ephAll.length) e = ephAll.find((x) => String(x.noradId) === id) || null
    _beMap.set(id, e)
  }
  return e || customConst.findByNorad(id) || null
}
// 条目 → 本体身份键（模型绑定 / 姿态 / 挂点）。天线树定点同步星的星座条目按它的 folder 认 grdsat:<folder> ——
// 与树上 GRD 天线同一个身份：在星座里给它挂的模型 / 姿态律，就是它那几根天线的本体（D8）
function satKeyOf(e) { return e && e._grdFolder ? grdSatKey(e._grdFolder) : coreSatKeyOf(e) }
function grdSatKeyOfNode(node, en) {
  if (!node) return null
  if (node.noradId) { const e = en !== undefined ? en : bodyEntryOf(node.noradId); return satKeyOf(e || { noradId: node.noradId, name: node.satName }) }
  return grdSatKey(node.folder)
}
// bodyRt 的时刻上下文：tMs 为场景时刻（太阳按它）；拿不到位置返回 null。
// 关联的是自定义星座合成星时，星位按场景历元轴（ccTimeAt，与 satLivePos / 覆盖 meta 同一口径），太阳仍按场景时刻。
// en：调用方已查到的条目（省一遍查找）；不给就按 node.noradId 查
function grdBodyCtx(node, meta, tMs, en) {
  const d = new Date(tMs)
  try {
    let rec = null, dp = d
    if (node && node.noradId) { rec = en !== undefined ? en : bodyEntryOf(node.noradId); if (rec && isCustomEntry(rec)) dp = ccTimeAt(d) }
    else if (node && node.elements) rec = orbitSatrec(node)
    if (rec) {
      const pv = posAt(rec, dp)
      if (pv && pv.position) return { pv, gmstRad: sat.gstime(dp), tMs }
    }
  } catch { /* 根数异常：退回存盘星位 */ }
  if (meta && Number.isFinite(meta.satLon) && Number.isFinite(meta.satAlt)) return { rEcef: W.geodeticToEcef(meta.satLon, meta.satLat || 0, meta.satAlt), tMs }
  if (node && Number.isFinite(node.lon)) return { rEcef: W.geodeticToEcef(node.lon, node.lat || 0, Number(node.altKm) || 35786), tMs }
  return null
}
const antRefHits = (m, antKey) => !!(m && m.antennaRef && m.antennaRef.kind === 'grd' && m.antennaRef.id === antKey)
function grdMountIdFor(satKey, antKey, st) {
  const want = st && typeof st.boreMount === 'string' ? st.boreMount : ''
  if (want && bodyRt.mountFor(satKey, want)) return want
  const hit = bodyRt.mountsFor(satKey).find((m) => antRefHits(m, antKey))
  return hit ? hit.id : ''
}
// hooks.getAttAxes(meta, st) → {z, up, S}（标准 ECEF 单位矢量；S = 解算用的星位 km）| null。逐波束热路径
// （syncBeamProj / peakPoint / beamRefPos…）会反复问同一根天线：按 calcAt 的 100 ms 分桶缓存（同 satTargetEcef），返回纯数组，不经响应式。
// ★ 缓存键带齐「这一刻的答案还取决于什么」：天线 + 挂点 + 星位（meta 的经纬高：固定星改星位、reprojectSat 之后立刻失效）
//   + 树节点身份（NORAD / 轨道根数：关联 / 解除关联 / 改根数立刻失效）。只靠时间桶的话，停表时同一个桶会一直命中旧星位的轴
let _attBucket = -1, _attMap = new Map()
function _elSig(el) {
  if (!el || typeof el !== 'object') return ''
  let s = ''
  for (const k in el) s += k + ':' + el[k] + ','
  return s
}
function grdAttAxes(meta, st) {
  if (!meta || !meta.folder) return null
  const tMs = calcAt().getTime(), bucket = Math.floor(tMs / 100)
  if (bucket !== _attBucket) { _attBucket = bucket; _attMap = new Map() }
  const antKey = meta.folder + '|' + meta.name
  const node = grdNodeOf(meta.folder)
  const ck = antKey + '|' + ((st && st.boreMount) || '') + '|' + meta.satLon + ',' + meta.satLat + ',' + meta.satAlt +
    '|' + (node ? (node.noradId || '') + ';' + _elSig(node.elements) + ';' + node.lon + ',' + node.lat + ',' + node.altKm : '')
  if (_attMap.has(ck)) return _attMap.get(ck)
  let r = null
  try {
    const en = node && node.noradId ? bodyEntryOf(node.noradId) : null
    const key = grdSatKeyOfNode(node, en) || grdSatKey(meta.folder)
    const ctx = key ? grdBodyCtx(node, meta, tMs, en) : null
    const mid = key ? grdMountIdFor(key, antKey, st) : ''
    const ax = ctx ? bodyRt.mountAxesAt(key, mid, ctx) : null
    // 附带项（W12 契约：有就用）：实际生效的律 / 律退过 / 实际生效的挂点 / 绑定内容签名（链路预算回填指纹）/ 本体三轴（指向误差绕它施加）
    r = ax ? { z: ax.z, up: ax.up, S: ax.S, law: ax.law, fallback: ax.fallback, mount: ax.mount, src: bodyRt.bindSigOf(key, mid), body: ax.body } : null
  } catch { r = null }
  _attMap.set(ck, r)
  return r
}
// 「挂点」下拉候选（GrdSetSections 经 inject('grdMountOptions') / hooks.getMountOptions 取）：缺省挂点在首位，
// antennaRef 指向本天线的挂点排前面（match: true）
function grdMountOptions(antKey) {
  void bodyVer.value
  const folder = String(antKey || '').split('|')[0]
  const key = grdSatKeyOfNode(grdNodeOf(folder)) || grdSatKey(folder)
  const hit = [], rest = []
  for (const m of (key ? bodyRt.mountsFor(key) : [])) {
    const match = antRefHits(m, antKey)
    ;(match ? hit : rest).push({ id: m.id, name: m.name || m.id, match })
  }
  return [{ id: '', name: zhEn('本体 +Z', 'Body +Z'), match: false }, ...hit, ...rest]
}
// 该天线所属星的姿态律（读数用：nadir / yawSteer / sun / inertial / target）
function grdAttLaw(antKey) {
  void bodyVer.value
  const folder = String(antKey || '').split('|')[0]
  const key = grdSatKeyOfNode(grdNodeOf(folder)) || grdSatKey(folder)
  return key ? bodyRt.attitudeFor(key).law : 'nadir'
}
provide('grdMountOptions', grdMountOptions)
provide('grdAttLaw', grdAttLaw)
// D9：att 档天线把「当前仿真时刻的等效手动指向」attEquiv {boreAz, boreEl, yaw} 写进自己的 cfg —— 主进程 sampler / 链路预算 / C·CI
// 不认姿态，照 azel 档吃它。
//   · 算：1 s 一次、带尾沿 —— 被节流掉的那一拍排一个定时器补上（停表后最后一次步进 / 拖游标一定写得进去）；
//     变化 ≥ 0.02° 才写。星位取解算姿态用的那个（getAttAxes 的 S），与轴同一时刻、同一颗星。
//   · 何时算：每拍（refreshPositions）＋ 离散事件立刻补一拍：切「姿态 + 挂点」/ 换挂点 / 改附加偏航（停表时没有下一拍）、
//     绑定到齐或改了（onBodyRtChange）。
//   · 绑定还没到（bodyRt 未 loaded）不写：那一刻只能按 nadir 解，写进去就是一份错的等效指向。
//   · 落盘（链路预算读 globe3d/settings）：有变化就排一次尾沿落盘 —— 停着 1.5 s、播放中最多 10 s 一次；离开本页时立刻落。
let _attEqT = 0, _attEqTrail = 0, _attEqSaveT = 0, _attEqSaveTimer = 0, _attEqSaveDue = 0
function grdAttTick(keys, force) {
  if (!bodyRt.isLoaded()) return
  const nowMs = Date.now()
  const wait = 1000 - (nowMs - _attEqT)
  if (!force && wait > 0) {
    if (!_attEqTrail) _attEqTrail = setTimeout(() => { _attEqTrail = 0; grdAttTick(grdLiveKeys(), true) }, wait)
    return
  }
  if (_attEqTrail) { clearTimeout(_attEqTrail); _attEqTrail = 0 }
  _attEqT = nowMs
  const seen = new Set()
  let dirty = false
  for (const key of keys) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    const ctx = grd.getPerfContext(key)
    const st = ctx && ctx.settings
    if (!st || st.boreType !== 'att' || !ctx.meta || ctx.noEph) continue   // 关联星此刻无星历：不按停着的旧星位回写等效指向
    const ax = grdAttAxes(ctx.meta, st)
    if (!ax) continue
    let lon = ctx.meta.satLon, lat = ctx.meta.satLat || 0, alt = ctx.meta.satAlt
    if (Array.isArray(ax.S)) { const g = W.ecefToGeodetic(ax.S[0], ax.S[1], ax.S[2]); if (Number.isFinite(g.lon) && Number.isFinite(g.h)) { lon = g.lon; lat = g.lat; alt = g.h } }
    const eq = attEquivOf(ax.z, ax.up, lon, lat, alt, Number(st.yaw) || 0)
    if (!eq) continue
    const r3 = (v) => Math.round(v * 1000) / 1000
    const nv = { boreAz: r3(eq.boreAz), boreEl: r3(eq.boreEl), yaw: r3(eq.yaw) }
    const ov = st.attEquiv
    const dAng = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180)
    if (ov && dAng(ov.boreAz, nv.boreAz) < 0.02 && dAng(ov.boreEl, nv.boreEl) < 0.02 && dAng(ov.yaw, nv.yaw) < 0.02) continue
    if (typeof grd.setAttEquiv === 'function') grd.setAttEquiv(key, nv)
    else st.attEquiv = nv
    dirty = true
  }
  if (dirty) attEqScheduleSave()
}
function attEqScheduleSave() {
  const now = Date.now()
  const due = clock.mode === 'play' || clock.mode === 'live' ? Math.max(now + 2000, _attEqSaveT + 10000) : now + 1500
  if (_attEqSaveTimer && _attEqSaveDue <= due) return
  if (_attEqSaveTimer) clearTimeout(_attEqSaveTimer)
  _attEqSaveDue = due
  _attEqSaveTimer = setTimeout(attEqFlushSave, due - now)
}
function attEqFlushSave() {
  if (_attEqSaveTimer) { clearTimeout(_attEqSaveTimer); _attEqSaveTimer = 0 }
  _attEqSaveT = Date.now()
  saveSettings()
}
// 离散事件（切档 / 换挂点 / 改偏航 / 绑定到齐）：下一个宏任务补一拍（等 grd 的指向 watch 与重投影先走完），不受 1 s 节流
let _attKickT = 0
function grdAttKick() {
  if (_attKickT) return
  _attKickT = setTimeout(() => { _attKickT = 0; grdAttTick(grdLiveKeys(), true) }, 30)
}
watch(() => [grd.active.value, grd.s.boreType, grd.s.boreMount, grd.s.yaw], grdAttKick)
// 停表：播放中排着的「最多 10 s 一次」落盘提前到 1.5 s 后（停下来的那一刻就是链路预算要读的时刻）
watch(() => clock.mode, (m) => { if (m === 'pause' && _attEqSaveTimer) attEqScheduleSave() })
function attEqUnload() { if (_attEqSaveTimer) attEqFlushSave() }
if (typeof window !== 'undefined') window.addEventListener('beforeunload', attEqUnload)
function grdLiveKeys() { return [...grd.selected.value, ...perfHost.liveKeys(), satcov.active.value || null, ...satcov.selected.value, grd.active.value || null] }
// 对星时段扫描的姿态钩子（W12 useSatPerfTable.makeGeom 消费 env.attAt）：att 档天线在任意时刻的挂点轴 {z, up}
// （与实时路 grdAttAxes 同一口径 —— 同一身份键、同一挂点选择，只是时刻由扫描给）；非 att 档 / 解不到 → null（W12 退天底）。
// 钩子的 tMs 是【源星自己的历元轴】（W12 已加 srcOff），这里不再换轴。只做姿态指向（本体遮挡不接入分析模块，用户 09-24 叫停）
function satcovAttAt(ctx) {
  const st = ctx && ctx.settings
  if (!st || st.boreType !== 'att' || !ctx.meta) return null
  const folder = ctx.meta.folder, node = grdNodeOf(folder)
  const satKey = grdSatKeyOfNode(node) || grdSatKey(folder)
  if (!satKey) return null
  const antKey = ctx.key || (folder + '|' + ctx.meta.name)
  const src = satcovSourceRec(ctx)
  const meta0 = { satLon: ctx.meta.satLon, satLat: ctx.meta.satLat || 0, satAlt: ctx.meta.satAlt }
  // 同一时刻只传播一次（扫描边界二分会反复问同一刻）；上下文对象只读，可以复用
  let _cT = NaN, _cC = null
  const ctxAt = (tMs) => {
    if (tMs === _cT) return _cC
    let c = null
    if (src && src.rec) {
      const d = new Date(tMs)
      let pv = null
      try { pv = posAt(src.rec, d) } catch { pv = null }
      c = pv && pv.position ? { pv, gmstRad: sat.gstime(d), tMs } : null
    } else c = { rEcef: W.geodeticToEcef(meta0.satLon, meta0.satLat, meta0.satAlt), tMs }
    _cT = tMs; _cC = c
    return c
  }
  const mount = grdMountIdFor(satKey, antKey, st)
  return (tMs) => {
    const c = ctxAt(tMs)
    const ax = c ? bodyRt.mountAxesAt(satKey, mount, c) : null
    return ax ? { z: ax.z, up: ax.up } : null
  }
}
// target 律的目标星（params.target = {kind:'sat', satKey}）→ 该时刻 ECEF（km）
let _bodyKeyCache = new Map(), _bodyKeySrc = null
function bodyTargetEcef(satKey, tMs) {
  if (!satKey) return null
  const d = new Date(tMs)
  try {
    if (satKey.startsWith('grdsat:')) {
      const node = grdNodeOf(satKey.slice(7))
      if (!node) return null
      const c = grdBodyCtx(node, null, tMs)
      if (!c) return null
      if (c.rEcef) return c.rEcef
      const ecf = sat.eciToEcf(c.pv.position, c.gmstRad)
      return [ecf.x, ecf.y, ecf.z]
    }
    let e = null
    const m = /^norad:(\d+)$/.exec(satKey)
    if (m) e = satEntryById('n:' + m[1])
    else {
      if (_bodyKeySrc !== renderEntries) { _bodyKeySrc = renderEntries; _bodyKeyCache = new Map() }
      if (_bodyKeyCache.has(satKey)) e = _bodyKeyCache.get(satKey)
      else { e = renderEntries.find((x) => satKeyOf(x) === satKey) || null; _bodyKeyCache.set(satKey, e) }
    }
    if (!e) return null
    // 自定义星座合成星走场景历元轴（ccTimeAt，与 satLivePos / 画面同一口径）
    const dp = isCustomEntry(e) ? ccTimeAt(d) : d
    const pv = posAt(e, dp)
    if (!pv || !pv.position) return null
    const ecf = sat.eciToEcf(pv.position, sat.gstime(dp))
    return [ecf.x, ecf.y, ecf.z]
  } catch { return null }
}

// ===================== 对星覆盖分析：目标星集 / 指标表浮窗 =====================
// 目标星集与可见性分析同源（renderEntries = 当前在场的星），排除源星自己。双历元：合成星按场景历元解算。
function satcovTimes() {
  const now = calcAt(), ccNow = ccTimeAt(now)
  return { now, gmst: sat.gstime(now), ccNow, ccGmst: sat.gstime(ccNow) }
}
// 指标表里时刻列的格式化：与时间轴读数同一套时区开关（tYear/tMon… 在本文件后段定义，
// 这个闭包只在渲染时才执行，届时早已就绪）。函数体里读了 tzMode.value → 切时区表格自动重排。
satPerf.setTimeFmt((ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0')
  return `${tYear(d)}-${p(tMon(d) + 1)}-${p(tDay(d))} ${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`
})
const satcovNowMs = computed(() => clock.tMs)
// 点序列星被对星覆盖拒收时的一句状态（§4.4：不进计算，只说明状态）。
// 同一颗星只报一次，免得逐拍刷屏。
const satcovRejSeen = new Set()
function satcovRejected(e) {
  const k = String((e && e.noradId) || (e && e.name) || '')
  if (!k || satcovRejSeen.has(k)) return
  satcovRejSeen.add(k)
  status.value = byLang('星历点序列不支持对星覆盖：', 'Ephemeris point sequences are not supported in satellite coverage: ') + ((e && e.name) || k)
}
function satcovEntries(ctx) {
  const selfName = ctx ? String(ctx.satName || '') : ''
  // 点序列星不进对星覆盖（§4.4 拒收清单）：壳层投影按轨道壳做，点序列没有壳的概念。
  return renderEntries.filter((e) => (!selfName || e.name !== selfName) && !isEphemEntry(e))
    .map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) }))
}
// picks（只存名字/NORAD）→ 活体条目。星历更新后按身份重新解析，解析不到的自动缺席。
// 解析走 satEntryById 的【全量】口径（在场 → 全量目录 → 自定义星座）：目标星是从全量目录里搜进来的，
// 若这里只认在场，加得进列表却算不出行，表面上像「这颗星没被照到」——静默算错，比报错还糟。
function satcovResolvePicks(key) {
  const out = []
  for (const p of satPerf.picksOf(key)) {
    const e = satEntryById(p.noradId ? 'n:' + p.noradId : 'm:' + p.name)
      || renderEntries.find((x) => x.name === p.name)      // 编号对不上了但名字还在（星历换版）
    if (e && isEphemEntry(e)) { satcovRejected(e); continue }
    if (e) out.push({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) })
  }
  return out
}
// ★「波束内的星」跟随时钟：目标集不是一次捞死的名单，而是【此刻真的落在方向图域里的那些星】。
// 每拍重算成员：星进波束就出现在表里，出去就消失 —— 这才是动态覆盖仿真该有的样子。
// 取值复用本拍已算好的 ECEF 快照（_tickEcef，见 refreshPositions），不重跑 SGP4。
let _tickEcef = null, _tickEcefN = 0
function satcovInBeamNow(ctx) {
  const out = []
  if (!ctx || !ctx.beams || !ctx.beams.length) return out
  // 成员判据＝落在【这一轮真画出来的那个波束】的方向图域内（与「加入波束内的星」按钮同一口径，
  // 也与画面所见一致）；表里的取值仍按全部波束取最大，两者口径不同是刻意的：看到的是这个波束照到谁，
  // 报的是这颗星在这根天线上最好能拿到多少。
  const fb = ctx.key === satcov.active.value ? satcov.focusBeam.value : null   // 没画（或不是聚焦天线）就退回第一个
  const bm = (fb && ctx.beams.find((b) => b.bi === fb.bi)) || ctx.beams[0]
  const dirOpts = { pol: ctx.settings.pol, gainOffset: 0, pathLoss: 'none' }
  const selfName = String(ctx.satName || '')
  const P = [0, 0, 0]
  // 快照与在场集对不上（刚换组/刚筛选，还没走过一拍）→ 就地传播一遍，宁可慢一次也不能少算星
  const fresh = _tickEcef && _tickEcefN === renderEntries.length
  const t = fresh ? null : satcovTimes()
  for (let k = 0; k < renderEntries.length; k++) {
    const e = renderEntries[k]
    if (selfName && e.name === selfName) continue       // 源星自己不算目标
    const cc = !!isCustomEntry(e)
    if (fresh) {
      const x = _tickEcef[k * 3]
      if (!Number.isFinite(x)) continue                 // 本拍传播失败的星（占位）
      P[0] = x; P[1] = _tickEcef[k * 3 + 1]; P[2] = _tickEcef[k * 3 + 2]
    } else {
      const pv = posAt(e, cc ? t.ccNow : t.now)
      if (!pv || !pv.position) continue
      const ecf = sat.eciToEcf(pv.position, cc ? t.ccGmst : t.gmst)
      P[0] = ecf.x; P[1] = ecf.y; P[2] = ecf.z
    }
    if (!sampleBeamAtEcef(bm.beam, ctx.igrid, ctx.basis, P, dirOpts)) continue
    if (isEphemEntry(e)) continue                    // 点序列星不进对星覆盖（§4.4 拒收清单）
    out.push({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: cc })
  }
  return out
}
// 本轮该算哪些目标星：点选档取用户名单，波束内档取此刻的成员（并把名单回填给浮窗显示）
function satcovResolveTargets(ctx, key) {
  const k = key || (ctx && ctx.key) || ''
  if (satPerf.targetModeOf(k) !== 'beam') return satcovResolvePicks(k)
  const list = satcovInBeamNow(ctx)
  satPerf.setBeamTargets(list.map((e) => ({ name: e.name, noradId: e.noradId, group: e.group })), k)
  return list
}
// 瞬时表逐窗重算 / 跟随仿真时钟：见 perfHost.refreshShell / shellClockTick（一行一颗星、当场重算，与画面同一时刻）。
// 「加入波束内的星」：扫一遍在场卫星，把当前落在方向图域里的加进目标库。
// 这是「全量」与「点选」之间的桥——先捞一批，再自己删到只剩关心的那几颗。
function satcovAddInBeam(key) {
  const k = key || satcov.active.value
  const ctx = k ? grd.getPerfContext(k) : null
  if (ctx && ctx.noEph) { status.value = '关联卫星当前无星历'; return }   // 源星此刻解不出：没有波束可取值，不是「没选天线」
  if (!ctx || !ctx.beams.length) { status.value = '先选一根天线'; return }
  const found = satcovInBeamNow(ctx).map((e) => ({ name: e.name, noradId: e.noradId, group: e.group }))
  const n = satPerf.addTargets(found, k)
  status.value = found.length ? `波束内 ${found.length} 星，新增 ${n} 个目标` : '当前波束内没有卫星'
}
// ---- 时间窗口（时段扫描）----
// 与瞬时表最大的不同：源星与目标星都要按【任意时刻】解算，故得把两者的星历（satrec）交给表模块，
// 不能只给一个当下的星下点。固定星（无 NORAD、无根数）没有星历 → 给 null，表模块按 ctx.meta 恒定处理。
function satcovSourceRec(ctx) {
  const folder = ctx && ctx.meta && ctx.meta.folder
  const node = folder ? grdSats.value.find((x) => x.folder === folder) : null
  if (!node) return null
  if (node.noradId) {
    const en = bodyEntryOf(node.noradId)   // 在场 → 全量目录 → 自定义星座（按数组引用记表，瞬时表逐拍问不再线性扫全量池）
    if (en && isEphemEntry(en)) { satcovRejected(en); return null }
    if (en) return { rec: en.rec, _cc: !!isCustomEntry(en) }
  } else if (node.elements) {
    try { return { rec: orbitSatrec(node), _cc: false } } catch { return null }
  }
  return null
}
// 对星指向（sat/satoff）的目标星星历：指向本身随时间走，扫描时每个时刻都要重解
function satcovBoreRec(ctx) {
  const st = ctx && ctx.settings
  if (!st || (st.boreType !== 'sat' && st.boreType !== 'satoff')) return null
  const e = satEntryById(st.boreSat)
  if (e && isEphemEntry(e)) { satcovRejected(e); return null }
  return e ? { rec: e.rec, _cc: !!isCustomEntry(e) } : null
}
async function satcovScanWindows(key) {
  const k = key || satcov.active.value
  const ctx = k ? grd.getPerfContext(k) : null
  if (!ctx) { status.value = '先选一根天线'; return }
  if (ctx.noEph) { status.value = '关联卫星当前无星历'; return }       // 源星解不出：时段扫描会把它当固定星钉在存盘旧位置上
  // 波束内档：目标 = 点「计算」那一刻在波束里的那批星（成员本身随时刻变，扫描得先钉住一份名单）
  const tgts = satcovResolveTargets(ctx, k)
  if (!tgts.length) { status.value = satPerf.targetModeOf(k) === 'beam' ? '当前波束内没有卫星' : '先加目标星'; return }
  // 姿态 + 挂点（att）档：挂点轴随扫描时刻由 bodyRt 解（satcovAttAt；非 att 档为 null）
  await satPerf.computeWindows(ctx, satPerf.getOpts(k), tgts, satcovTimes(), satcov.shells.value, satcov.s.hEx,
    { srcRec: satcovSourceRec(ctx), boreRec: satcovBoreRec(ctx), attAt: satcovAttAt(ctx) })
}
// 「同步到时间轴」：把主时间轴跳到时窗游标那一刻（与「跳到指定时刻」同一路径——窗口以该时刻重新居中）。
// 表本身不用动：win.on 档下 satcovClockTick 不接管，表仍是游标那一刻的数，这一步只是让画面追上表。
function satcovSeekClock(tMs) {
  if (!Number.isFinite(tMs)) return
  winStartMin.value = -PAST_FRAC * windowMin.value
  clockSetTime(tMs); baseTime.value = clock.tMs
}
// 指标表里点「聚焦」：旋转地球正对该星并选中（与搜索结果点选、双击定位同一路径）
async function satcovFocusTarget(t) {
  if (!t || !t.name) return
  const nid = t.noradId == null ? '' : String(t.noradId)
  let en = renderEntries.find((x) => (nid && String(x.noradId) === nid) || x.name === t.name)
  if (!en && nid) { await ensureSearchPool(); en = searchSource().find((x) => String(x.noradId) === nid) }
  if (!en) { status.value = `「${t.name}」不在当前星历中`; return }
  selectSat(en, true)
}

// 树里每根天线下的「对星性能指标表」入口：开该天线的独立窗口（一根天线一窗、可多开）
async function satcovOpenTable(sat, a) {
  if (!sat || !a) return
  satcov.setActive(sat, a)
  const key = grd.keyOf(sat.folder, a.name)
  const ok = await grd.ensureAntLoaded(key)
  if (!ok) { appAlert('该天线方向图未就绪，无法生成性能表'); return }
  if (!perfHost.has()) { appAlert('需在桌面客户端中运行'); return }
  await perfHost.open('shell', key)
}
// ---- 「从星座取」壳层挑选器 ----
// 候选池默认取【全量在轨目录】（searchSource：与主界面搜索同一个池，后台加载一次），
// 不受当前「星座分组」选择限制——选了 GEO 组照样能取 Starlink 的壳层。
// 高度取 satrec 的平均半长轴 a（地球半径为单位，WGS72）换算的平均轨道高度：与时刻无关、圆轨道即壳层半径，
// 比逐星 SGP4 出瞬时星下高度既快又稳（后者短周期抖几 km，会把一层打散成好几层）。
const RE_SGP4 = 6378.135
const satcovPickOpen = ref(false)
const satcovPickSrc = ref('all')          // 'all' 全量在轨目录 ｜ 'live' 当前在场卫星
const satcovPickLoading = ref(false)
const satcovPickPool = shallowRef([])
const satcovShellAlts = computed(() => satcov.shells.value.map((x) => x.altKm))
async function satcovLoadShellPool() {
  satcovPickLoading.value = true
  try {
    let src = renderEntries
    if (satcovPickSrc.value === 'all') { await ensureSearchPool(); src = searchSource() }
    const out = [], seen = new Set()
    for (const e of src) {
      const rec = e && e.rec
      if (!rec || !Number.isFinite(rec.a)) continue
      const id = String(e.noradId || e.name)
      if (seen.has(id)) continue
      seen.add(id)
      const altKm = (rec.a - 1) * RE_SGP4
      if (!(altKm > 0)) continue
      out.push({
        name: e.name, noradId: e.noradId, groupLabel: e.groupLabel || GROUP_LABEL[e.group] || '其他',
        altKm, incDeg: (rec.inclo || 0) * 180 / Math.PI, ecc: rec.ecco || 0, slot: geoSlotOfSatrec(rec)
      })
    }
    satcovPickPool.value = out
  } catch { satcovPickPool.value = [] } finally { satcovPickLoading.value = false }
}
async function satcovOpenPick() { satcovPickOpen.value = true; await satcovLoadShellPool() }
function satcovSetPickSrc(v) { satcovPickSrc.value = v; satcovLoadShellPool() }
function satcovAddPicked(items) {
  const n = satcov.addShells(items)
  satcovPickOpen.value = false
  status.value = n ? `新增 ${n} 层壳层` : '选中的壳层都已在库中'
}
// ---- 拖拽波束 ----
// 对地视图：光标落点在地球表面，落点即指向点。
// 对星视图：绕【源星】转方向（弧球），4π 全向可达。这里的高度只用来定「指向点离源星多远」——
//   空间点指向取它自己的高度，否则取第一层显示中的壳层，方向与它无关。
function satcovDragAlt() {
  const st = grd.s
  if (st.boreType === 'point' && Number.isFinite(st.borePtAlt)) return st.borePtAlt
  const sh = satcov.shells.value.find((x) => x.show) || satcov.shells.value[0]
  return sh ? sh.altKm : 550
}
const satcovDragOn = () => sideCtx() === 'satcov' && !flatView.value
// 拖拽回调分派：3D 的对星视图走绕星弧球（shellDrag），其余（含对星视图下的 2D 对地平面图）走原地表拖拽
function onBeamDragAny(ll, phase) {
  if (satcovDragOn()) grd.shellDrag(ll, phase, W.A + satcovDragAlt())
  else grd.beamDrag(ll, phase)
}
// 拖拽方式要在【按下之前】就设好（scene 在 pointerdown 当场起算）→ 相关量一变就同步。
// 对星视图给「源星 + 当前视轴落点」＝绕源星转方向；其余给 null ＝回到地表落点拾取。
function satcovSyncDragSphere() {
  if (!scene || !scene.setBeamDragPivot) return
  const m = satcovDragOn() ? grd.antMeta() : null
  scene.setBeamDragPivot(m ? {
    sat: { lon: m.satLon, lat: m.satLat || 0, altKm: m.satAlt },
    tip: grd.boreTip(W.A + satcovDragAlt())        // 当前视轴落点：只用来定「屏上转一度、波束转几度」的增益
  } : null)
}
watch(() => [sideCtx(), flatView.value, grd.dragBore.value, grd.active.value, grdS.boreType], satcovSyncDragSphere)
// 时间轴 / 星位变化后的刷新：只管源星动了要重投影；指标表按其「重算」走（一行一颗星，逐帧算不起）
function satcovTick(movedKeys) {
  if (movedKeys && movedKeys.size) {
    // 当场重算，不走 rAF 合帧：星位已经写进场景了，壳层再晚一帧就是「星在 t、场在 t−Δ」。
    // 合帧那条路留给【设置变更】（一次改动会连着触发好几个 watcher，合成一帧做完才划算）。
    for (const k of satcov.selected.value) if (movedKeys.has(k)) { satcov.recompute(); break }
  }
}
// 瞬时表随手重算（便宜）；时段表只标「输入已变」等用户点重算 —— 一次扫描是几十万次取值，不能跟着抖
// 换天线＝换一张表：目标星名单 / 来源档 / 时窗设置都切到那根天线自己那份（每张表各一份，新表从空白起）
// 聚焦特效的触发面：画哪些天线变了（点亮谁按此定）、指向模式/目标星变了（目标星那一端要跟着换）。
// 时间推进不在这里管——refreshPositions 每帧都会 commitGeometry。
// 不按视图门控：commitGeometry 是幂等的全量重喂，画不画由 satcov.selected 定（清空即自然收特效）——
// 加个 side 判据反而会在【清除绘图那一下正好不在该视图】时把特效留在场景里。
watch(() => [satcov.selected.value.join('|'), grd.selected.value.join('|'), grd.active.value, grdS.boreType, grdS.boreSat], () => commitGeometry())// ===== 目标星搜索（对星跟踪的目标星 / 指标表的目标星，两处共用）=====
// ★【全量】搜索，不限于「在场」：池 = 全量在轨目录（内置各星座分组 ∪ active ∪ 本地自定义卫星库）
//   ＋ 自定义星座合成星（含隐藏的座）；另按【卫星组】的组名命中该组全部成员（与自定义星座按星座名
//   命中全部成员同款）。选中的星不必被渲染出来——指向解算与指标表都按同一口径全量解析（satEntryById）。
// 全量目录是懒加载的（第一次搜索可能要等几秒联网/读缓存），故本函数是 async；防抖与竞态由调用方管。
// 返回纯数据（不含 satrec / 不是 Proxy）：{ items: [{name, noradId, group, tag}], total }
//   tag = 卫星组名 / 星座名 / 分组名；★ total 是【不截断】的命中总数（列表只列前 limit 条，
//   条数与主界面搜索/卫星组管理器同量级）——否则用户没法分辨「只有这几颗」与「被截断了」。
// exclude：要排除的身份串（指标表传「已在目标库里的星」）。★ 必须在这里排除、不能由调用方对结果再过滤——
//   列表是截断过的，对截断后的 60 条再滤掉已加入的，会在「全都加过了」时报成「没有匹配」，而目录里其实还剩一百多颗。
async function satcovSearch(q, limit = 60, exclude = null) {
  const kw = String(q || '').trim().toLowerCase()
  if (!kw) return { items: [], total: 0 }
  await ensureSearchPool()
  const cap = Math.max(1, limit)
  const skip = exclude && exclude.length ? new Set(exclude) : null
  // 卫星组：组名命中 → 该组成员整批进池（组名本身不是一条结果）
  const grpHit = new Map()
  for (const g of satGroups.list.value) {
    const gname = String(g.name || '')
    if (!gname.toLowerCase().includes(kw)) continue
    // 成员的 NORAD 键是 s.id（useSatGroups.normSats 的出参形状）——写成 s.noradId 会得到一串 "undefined"，
    // 组名命中后一颗也匹配不上，这条整批进池的通路就静默失效了。
    for (const s of (g.sats || [])) { const id = String(s.id != null ? s.id : s.noradId); if (!grpHit.has(id)) grpHit.set(id, gname) }
  }
  const match = (e) => e.name.toLowerCase().includes(kw) || String(e.noradId).includes(kw)
    || (e.groupLabel && e.groupLabel.toLowerCase().includes(kw)) || grpHit.has(String(e.noradId))
  const out = [], seen = new Set()
  let total = 0
  const push = (e) => {
    const k = e.noradId ? 'n:' + e.noradId : 'm:' + e.name
    if (seen.has(k) || (skip && skip.has(k))) return
    seen.add(k)
    total++
    if (out.length < cap) out.push({ name: e.name, noradId: e.noradId, group: e.group, tag: grpHit.get(String(e.noradId)) || e.groupLabel || GROUP_LABEL[e.group] || '', slot: geoSlotOfSatrec(e.rec) })   // slot 是纯字符串，保持结果无 satrec/Proxy
  }
  // 两轮都【扫到底】不提前 break：列表截断到 cap，命中总数照实数（两万多条上做 includes 是毫秒级）
  for (const e of renderEntries) if (match(e)) push(e)        // 在场的排前面
  for (const e of searchSource()) if (match(e)) push(e)
  return { items: out, total }
}
// ===== 浮窗拖拽：移动（标题栏）/ 缩放（右下角）/ 分隔（中缝）。统一一个临时 window 监听会话 =====
// 浮窗定位以 .g3（本页根，position:relative）为参照系，而非整个浏览器窗口：
// .g3 只是主内容区（活动栏/侧栏/菜单栏/工具栏/状态栏均不在其内），用 window.innerWidth/innerHeight
// 算出的默认坐标会偏出 .g3 实际可视范围（尤其侧栏展开时），窗口对不上地图区、甚至被裁掉一截。
function g3Size() {
  const r = g3el.value
  return r ? { w: r.clientWidth, h: r.clientHeight } : { w: window.innerWidth, h: window.innerHeight }
}
function perfDragSession(onMove) {
  const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); document.body.style.userSelect = '' }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}
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
// 聚焦天线的设置（极化 / 增益 / 路损 / 相对绝对 / 画哪些波束 / 指向）变了 → 该天线开着的表（对地 / 对星）与城市框重算。
// 指向每帧在变（拖拽）→ rAF 合帧，一帧最多重算一次。
watch(() => [grdS.pol, grdS.gainOffset, grdS.pathLoss, grdS.ctype, grdS.beamsToPlot], () => perfHost.onSettingsChanged(grd.active.value), { deep: true })
let _perfDragRaf = 0
watch(() => [grdS.boreType, grdS.boreLon, grdS.boreLat, grdS.boreAz, grdS.boreEl, grdS.yaw, grdS.boreLock, grdS.boreSat, grdS.boreOffAz, grdS.boreOffEl, grdS.borePtLon, grdS.borePtLat, grdS.borePtAlt],
  () => { if (_perfDragRaf) return; _perfDragRaf = requestAnimationFrame(() => { _perfDragRaf = 0; perfHost.onSettingsChanged(grd.active.value) }) })
// 解析天线同 key 就地换了方向图（「方向图」小节改效率 / θ3、高斯组拖波束自动同步）：上面三条都不触发（波束数不变 → beamsToPlot 不换；
// 固定星不随时钟动 → onMoved 不来；暂停档连 shellClockTick 也没有）→ 开着的表（对地 / 对星瞬时、时段游标）与城市框按新方向图重算。
// anRev 是全局修订号，分不出哪一副 → 全量刷（只刷开着的窗）；拖拽连发 → rAF 合帧，一帧最多一次。
let _perfAnRaf = 0
watch(grd.anRev, () => { if (_perfAnRaf) return; _perfAnRaf = requestAnimationFrame(() => { _perfAnRaf = 0; perfHost.refreshAll() }) })
// 电平配色 / 指向模式 / 波束名与电平名的内联改名都在 GrdSetSections.vue 里（两个覆盖分析视图共用那份 UI）
const covSats = ref([])           // 索引：[{folder,displayName,satName,lon,beams:[{band,beam,type,gains,file}...]}]
const covItems = ref([])          // 已添加卫星（两级结构）
const covCleared = ref(false)      // 「清除绘制」后置位：保留 covItems 但暂不绘制，避免切视图/重开面板时 GXT 覆盖自行复现（再次 redraw 即解除）。入 snapshot 持久化，使「清除后效果」跨重启保留
const covAddSel = ref('')         // 「添加卫星」下拉临时值
const showBeamLabels = ref(true)
const beamLabelSize = ref(16)     // 波束名字号（6–32，内部映射为标签 hpx）
const beamLabelBold = ref(false)  // 波束名粗体（3D 星位处的卫星名标签同走这一档）
const showBore = ref(true)        // 波束中心点
const boreSize = ref(5)           // 波束中心点大小（1–12，映射球半径）
const showContourLabels = ref(false) // 等值线数值标签
const contourLabelSize = ref(12)  // 数值标签字号（2–20）
const contourLabelBold = ref(false)
// 地名字号倍率的出厂值。三级按 1 : 0.8 : 0.65 排 —— 制图上相邻层级差一档是 15%~25%，不是几倍。
// ★ 旧值 1 / 0.6 / 0.2 的毛病不在「小」，在【二级永远读不出来】：屏幕字号 = min(基准 px × zf, 22) × 倍率，
//   22 那道封顶是乘倍率【之前】就钳掉的，于是二级的上限恒为 22 × 0.2 = 4.4 px —— 无论把地图放多大，
//   地级市名都到不了 5 px。认不出的名字比不画更糟：它还占着避让的位置，把邻居挤掉了。
//   新值下三级的屏幕上限是 22 / 17.6 / 14.3 px，这才是一条读得出来的层级。
// ★ 基准 px 各层不同（国家名 10~20 按线度给，一级 15，二级 11，见 mergePacks 的 px2d），倍率是叠在它上面的。
// ★ 水域两档的倍率也是 1.0 起：制图层级由【表里的基准 px】给（大洋 15 / 大海 11 / 海湾 9 / 海峡 7.5，
//   见 viz/geo/waterNames.js），不靠倍率去压 —— 倍率是留给用户的那一根旋钮，出厂就该在中性位。
const NAME_SIZE_DEF = { country: 1.0, prov: 0.8, city: 0.65, ocean: 1.0, sea: 1.0 }
const OLD_NAME_SIZE = { country: 1.0, prov: 0.6, city: 0.2 }   // 老存档迁移判据，见 restoreSettings
const countryNameSize = ref(NAME_SIZE_DEF.country)  // 国家名字号倍率（0.6–2.0）
const provNameSize = ref(NAME_SIZE_DEF.prov)        // 省名字号倍率（0.6–2.0）
const cityNameSize = ref(NAME_SIZE_DEF.city)        // 地级市名字号倍率（小空间，默认偏小）
const oceanNameSize = ref(NAME_SIZE_DEF.ocean)      // 大洋名字号倍率
const seaNameSize = ref(NAME_SIZE_DEF.sea)          // 海域名字号倍率（红海/地中海/波斯湾这一档）
// 国界(海岸线)/省界/地级市界线样式：线宽 px / 颜色 / 透明度，同时作用于 3D 与平面图
// 地级市界默认更细更淡（线粗下限与全库一致，0.1），层级上从属于省界
// 边界线样式：五类线（海岸/国界/未定界/停火线/主张线）各四项 + 两级行政区各三项 + 按缩放淡出开关。
// 出厂值收在 src/viz/geo/borderStyle.js（3D 球体与 2D 平面图共用同一份，两个视图不可能长歪）。
const borderStyle = reactive({ ...BORDER_DEF })
// 历代出厂样式，只用于「这一组没手动动过就升级」的比对（见 restoreSettings）。不参与任何渲染。
// 出厂值每改一版就往这里加一代 —— 停留在任何一代出厂值上的存档都能升到最新。
const BORDER_DEF_GENS = [
  {   // ① 初版：政治六类同色 #a8a8a8，海岸线 #8fa6b8 且最粗（层级反了）
    coastColor: '#8fa6b8', coastWidth: 1.0, coastOpacity: 0.85, coastDash: 'solid',
    admin0Color: '#a8a8a8', admin0Width: 1.6, admin0Opacity: 1.00, admin0Dash: 'solid',
    indefColor: '#a8a8a8', indefWidth: 1.6, indefOpacity: 0.95, indefDash: 'dash',
    locColor: '#a8a8a8', locWidth: 1.4, locOpacity: 0.90, locDash: 'dashdot',
    claimColor: '#a8a8a8', claimWidth: 1.8, claimOpacity: 0.90, claimDash: 'dash',
    provColor: '#a8a8a8', provWidth: 1.0, provOpacity: 0.80,
    cityColor: '#a8a8a8', cityWidth: 0.7, cityOpacity: 0.60
  },
  {   // ② 暖褐政治族 + 冷蓝海岸族（国界与海岸线不同色，用户要求改成同色）
    coastColor: '#5f86a3', coastWidth: 0.7, coastOpacity: 0.90, coastDash: 'solid',
    admin0Color: '#6b6259', admin0Width: 1.3, admin0Opacity: 1.00, admin0Dash: 'solid',
    indefColor: '#6b6259', indefWidth: 1.2, indefOpacity: 0.90, indefDash: 'dash',
    locColor: '#7a7168', locWidth: 1.1, locOpacity: 0.85, locDash: 'dashdot',
    claimColor: '#6b6259', claimWidth: 2.0, claimOpacity: 1.00, claimDash: 'solid',
    provColor: '#8b8177', provWidth: 0.8, provOpacity: 0.85,
    cityColor: '#a09890', cityWidth: 0.55, cityOpacity: 0.70
  }
]
const eqStyle = (a, b) => (typeof b === 'number' ? Math.abs(Number(a) - b) < 1e-6 : String(a).toLowerCase() === String(b).toLowerCase())
// 「本节恢复出厂样式」按分组回填
const BORDER_PARTS = {
  coast: ['coastColor', 'coastWidth', 'coastOpacity', 'coastDash'],
  admin0: ['admin0Color', 'admin0Width', 'admin0Opacity', 'admin0Dash'],
  indef: ['indefColor', 'indefWidth', 'indefOpacity', 'indefDash'],
  loc: ['locColor', 'locWidth', 'locOpacity', 'locDash'],
  claim: ['claimColor', 'claimWidth', 'claimOpacity', 'claimDash'],
  prov: ['provColor', 'provWidth', 'provOpacity'],
  city: ['cityColor', 'cityWidth', 'cityOpacity'],
  grid: ['gridColor', 'gridWidth', 'gridOpacity', 'gridDash', 'gridStep', 'gridOn']
}
// 面板「边界线」一节的主从列表：一行一类，选中哪行下面就出哪行的四项。
// ★ 顺序＝渲染次序（国界压在最上），两级行政区界也在这张表里 —— 它们同样是「边界线」，
//   原先散在「一级行政区」「二级行政区」两节里，等于同一件事分三处调。
const BORDER_ROWS = [
  { k: 'admin0', zh: '国界', tip: '两侧归属不同的边界；归属由「地图视角」解算' },
  { k: 'indef', zh: '未定界', tip: '任一侧归属为「争议」的边界，以及底图自带的未定界线' },
  { k: 'loc', zh: '停火线', tip: '实际控制线（Line of control），底图自带几何' },
  { k: 'claim', zh: '主张线', tip: '海上主张线（南海十段线）；画不画由「地图视角」的附加线开关决定' },
  { k: 'coast', zh: '海岸线', tip: '一侧无陆地邻居的边界；自然要素，与政治线分属两个色系' },
  { k: 'prov', zh: '一级行政区界', tip: '省 / 州 / 邦一级', nodash: true },
  { k: 'city', zh: '二级行政区界', tip: '中国地级市', nodash: true },
  { k: 'grid', zh: '经纬网', tip: '经线与纬线；间隔可调，也可整层关掉', vis: true, step: true }
]
const borderPick = ref('admin0')     // 主从列表当前选中的那一类
// 地名的主从列表：名称档位 / 字号 / 颜色 / 透明度四项，三级共用一套控件
// ★ 水域两档（大洋 / 海域）与国家名【彻底分开】：原先洋名跟着国名的档位走，想在图上只留洋名做不到。
//   两档各自还带一张逐条勾选的清单（water: 档位键），故「红海要不要出现」也是可选的。
const NAME_ROWS = [
  { k: 'country', zh: '国家名', modes: [['zh', '中文'], ['en', '英文'], ['off', '不显示']], min: 0.1, max: 3, step: 0.05 },
  { k: 'prov', zh: '一级行政区名', modes: [['local', '中文'], ['en', '英文'], ['off', '不显示']], min: 0.05, max: 3, step: 0.05 },
  { k: 'city', zh: '二级行政区名', modes: [['local', '中文'], ['en', '英文'], ['off', '不显示']], min: 0.05, max: 3, step: 0.05 },
  { k: 'ocean', zh: '大洋名', modes: [['zh', '中文'], ['en', '英文'], ['off', '不显示']], min: 0.1, max: 3, step: 0.05, water: 'ocean' },
  { k: 'sea', zh: '海域名', modes: [['zh', '中文'], ['en', '英文'], ['off', '不显示']], min: 0.1, max: 3, step: 0.05, water: 'sea', search: true }
]
const namePick = ref('country')
// 样式预设（一键套整组）：只动五类线的颜色与透明度，线宽/线型这类结构性区分不跟着变
const PRESET_TIP = '一键套用整组配色（线宽与线型不变）'
const BORDER_PRESETS = [
  { k: 'default', zh: '默认', tip: '回到出厂样式' },
  { k: 'print', zh: '印刷', tip: PRESET_TIP },
  { k: 'dark', zh: '暗色', tip: PRESET_TIP },
  { k: 'contrast', zh: '高对比', tip: PRESET_TIP },
  { k: 'lineart', zh: '白描', tip: '影像底图等深色底上的亮线配色（线宽与线型不变）' }
]
// 每套预设内部仍守着「明度即层级」：国界最深、行政区界依次退后、海岸线自成一族
const BORDER_PRESET_VAL = {
  print: { coastColor: '#41647d', admin0Color: '#332f2b', indefColor: '#332f2b', locColor: '#4a453f', claimColor: '#332f2b', provColor: '#615a52', cityColor: '#7d766d' },
  dark: { coastColor: '#7ba3bd', admin0Color: '#c4bbb0', indefColor: '#c4bbb0', locColor: '#a89f95', claimColor: '#c4bbb0', provColor: '#948b81', cityColor: '#7b736a' },
  contrast: { coastColor: '#1f5d85', admin0Color: '#111111', indefColor: '#111111', locColor: '#333333', claimColor: '#111111', provColor: '#4a4a4a', cityColor: '#6b6b6b' },
  // 白描：底图是整幅真彩影像时用。照片底把出厂那族冷蓝灰线整个吃掉 —— 拿 8k BMNG 实测（对比度按 WCAG 算）：
  // 出厂 #5f86a3 压在撒哈拉 1.25、阿拉伯沙漠 1.06、戈壁 1.30、青藏 1.38，等于没画；白描的国界在同样几处是 2.9 / 3.8 / 4.7 / 4.9。
  //   ★ 政治线抬到近白，且取【冷调】的近白：亮沙地本身是暖色，靠色相差才分得开，暖白 / 浅金压上去就是同一片。
  //   ★ 海岸线不跟着到白，留一档中青（冰盖 1.8、深海 9.4）：纯白在南极与格陵兰的冰上会消失，带彩度的青两边都站得住。
  //   ★ 层级仍是明度序，只是暗底上越亮越靠前：国界 .92 > 停火线 .74 > 一级 .61 > 海岸 .47 > 二级 .42。
  lineart: { coastColor: '#5cc4dd', admin0Color: '#f2f7fc', indefColor: '#f2f7fc', locColor: '#d6e0ea', claimColor: '#f2f7fc', provColor: '#c3cfdb', cityColor: '#9fb0c0' }
}
// 地名颜色/透明度：国家名 与 省名 与 地级市名 分开（大洋名维持固有蓝），同时作用于 3D 与平面图
// ★ 出厂值重定（旧值：一级 #f6fa00 / 0.25，二级 #9aa3b0 / 0.25）。0.25 那两档淡掉的只是【字面】，
//   套边【不】跟着透明（见 flatmap/flatCoverage.js 的 drawText，那是刻意的），读到的就成了
//   「满强度深色轮廓裹着一层淡芯」—— 两级行政区名等于白画。
//   故三级一律满不透明，轻重改由【颜色明度】给：那是唯一同时作用于字面与观感、又不会把字与套边拆开的旋钮。
// ★ 三级一律取亮色：套边色随底色现算（见 viz/labelHalo.js）且只会往深里算，不存在「深色注记」那一档
//   —— 深字压深边会糊成一团。实测（出厂米绿陆地 #e4eccf，套边现算出来是 rgb(31,35,21)）：字面对
//   【陆地】的对比恒在 1.0~2.1，对【套边】才是 7~16 —— 小字上眼睛看见的那圈背景就是套边，故层级按
//   「对套边的对比」排，越亮越靠前：国家名 16 > 一级 12.4 > 二级 11.1，再叠上字号 1 / 0.8 / 0.65。
// ★ 水域两档自成一族：冷蓝斜体，与陆上那三档（白 / 暖黄 / 灰蓝）分得开 —— 名字落在哪边一眼可辨。
//   两档之间照旧按明度排层级：大洋亮、海域退一档。
const LABEL_DEF = {
  countryColor: '#ffffff', countryOpacity: 1, provColor: '#ffdf8f', provOpacity: 1, cityColor: '#cfd8e2', cityOpacity: 1,
  oceanColor: '#96c3e6', oceanOpacity: 1, seaColor: '#86b0d4', seaOpacity: 1,
  countryBold: false, provBold: false, cityBold: false, oceanBold: false, seaBold: false   // 五档各自的字重（两个视图同一份）
}
const OLD_LABEL_DEF = { countryColor: '#ffffff', countryOpacity: 1.0, provColor: '#f6fa00', provOpacity: 0.25, cityColor: '#9aa3b0', cityOpacity: 0.25 }   // 老存档迁移判据
const labelStyle = reactive({ ...LABEL_DEF })
// 大海颜色（限蓝色系预设），同时作用于 3D 球体与平面图底色
// 蓝色系：中→浅（已删除最深档 #0d2b4d、#15426b，观感过暗）；末档 #a3ccff 为更亮的淡蓝（比 #92b6e4 更亮）
// 并设为默认底色；#aacbdf 为低饱和钢蓝、#92b6e4 为略深蓝，均保留可选。
const OCEAN_BLUES = ['#1b5a8c', '#1e6fa8', '#2a85c4', '#3d7ba6', '#5b7f9e', '#92b6e4', '#aacbdf', '#a3ccff']
const oceanColor = ref('#a3ccff')
// 地球影像（真彩卫星影像，2D/3D 同一份解码）。原「影像底图」一节，2026-09-24 用户定并进「宇宙空间 · 地球影像」：
// 开关 = 宇宙空间总开关 && 地球影像勾着（imageryOn 是算出来的，只读）；档位 / 亮度仍各存一份（存档 imagery.k / bright）。
// 默认关（宇宙空间出厂关）：16K 一张解码 537 MB + 上显存 716 MB，不该为没开这功能的人付这笔账 —— 图片「开了才去加载」。
const imageryOn = computed(() => !!(spaceOn.value && space.img))
const imageryKey = ref(DEFAULT_IMAGERY)
const imageryBright = ref(1)
let img2d = null, img3d = null   // 两个视图此刻各贴着哪一档（imagery.js 的源对象；null = 矢量底图）—— 去重：3D 重贴一次就是 716 MB 重传
let imgBusy = ''                 // 正在解码的那一份 url（''=空闲）：同一时刻只解一张，见 applyImagery
const imgFailed = new Set()      // 解码失败过的 url：本会话不再重试（否则回调里补跑会无限重解），该视图退到瓦片档
// 大地颜色：基调方案（'morandi' 杂色循环 | '#rrggbb' 统一单色，预设见 landPalette.LAND_UNIFORMS，首个为 SATSOFT 米绿）
// + 逐国覆盖（优先级最高，含中国/冰盖），同时作用于 3D 球体与平面图。默认统一米黄（与 landPalette 模块默认一致）
const landScheme = ref(LAND_DEFAULT)
const landOverrides = reactive({})   // 归属 ISO3 → '#rrggbb'（台湾/港澳恒并入 'CHN'）
const landQuery = ref('')            // 逐国设色搜索框
const landPick = ref(null)           // 当前选中国家 { id, zh }
const HEX6 = /^#[0-9a-fA-F]{6}$/
// ===================== 地图视角 =====================
// 视角是【全局设置】，与其它设置一起存在 settings.mapPov 里；这里是它唯一的操作入口
// —— 底图归属、国名、点选、逐国着色全按它解算，跟地图放在一起改才找得到。
// ★ 不进 viewPrefs 快照：那是「本页视图偏好」，视角是全局的，两处都存会打架。
const povCfg = reactive(normMapPov(getMapPov()))
const offMapPov = onMapPov((c) => { povCfg.id = c.id; povCfg.overrides = { ...c.overrides }; povCfg.layers = { ...c.layers } })
const povApply = () => saveMapPov(JSON.parse(JSON.stringify(povCfg)))
function setPovId(v) { povCfg.id = v; povApply() }
function setPovDispute(k, v) { if (v) povCfg.overrides[k] = v; else delete povCfg.overrides[k]; povApply() }
function togglePovLayer(k) { povCfg.layers[k] = !povCfg.layers[k]; povApply() }
// 当前视角声明了南海十段线才允许开关它（没声明就没这条线可开）
const povClaimAvail = computed(() => { const p = povTableOf(povCfg.id); return !!(p && p.lines && Array.isArray(p.lines.claim) && p.lines.claim.length) })
const povOwnerZh = (v) => OWNER_ZH[v] || v
const POV_LAYERS = [
  { k: 'claim', zh: '南海十段线', tip: '海上主张线；当前视角未声明主张线时不可用' },
  { k: 'loc', zh: '停火线', tip: '实际控制线（Line of control）' },
  { k: 'indefinite', zh: '未定界虚线', tip: '任一侧归属为「争议」的边界，以及底图自带的未定界线' }
]

// 视角/覆写改动的版本号：可搜索国家清单、取色器预填这些都跟着重算
const povTick = ref(0)
const offPovTick = onPovChange(() => {
  povTick.value++
  // 视角换了，行政区包里按 wv 分组的那部分（如只在「藏南不属中国」的视角下才有的阿鲁纳恰尔邦界）要重新过滤
  if (showProvinces.value) ensureAdm(1)
  if (showCities.value) ensureAdm(2)
})
// 可搜索国家列表：口径 = 当前视角下地图上确实画出来的那些国家（台湾/港澳并入中国不单列）
const COUNTRY_ZH = computed(() => { povTick.value; return countryList() })
const landHits = computed(() => {
  const q = landQuery.value.trim()
  if (!q || (landPick.value && landPick.value.zh === q)) return []
  return COUNTRY_ZH.value.filter((c) => c.zh.includes(q)).slice(0, 10)
})
// 选中国家取色器预填：已覆盖→覆盖色；统一基调→基调色；莫兰迪→该国当前实际循环色
const landPickColor = computed(() => {
  const p = landPick.value
  if (!p) return '#e4eccf'
  return landOverrides[p.id] || (landScheme.value !== 'morandi' ? landScheme.value : currentLandColor(p.id))
})
const landOvList = computed(() => Object.entries(landOverrides).map(([id, color]) => ({ id, color, zh: (COUNTRY_ZH.value.find((c) => c.id === id) || {}).zh || id })))
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
let selEntry = null       // 主选中（primary/active）：详情展开、beam 输入、跟随定位都作用于它
let selEntries = []        // 多选集合（含 primary）；裸点选=替换，Ctrl/Cmd/Shift 点选=增减
// 多选卡片列表。shallowRef：整批重建（每次刷新都换新数组，从不就地改），几百颗时不必再为每行建深代理
const selList = shallowRef([])
// 每颗一行 mini-card（名称+类型+关键指标），active=primary。
// 【别再加回行首色点】：地球上的选中轨道/足迹并不按这个色画（轨道走统一选中样式、在轨点走该星原本的分组色），
// 色点跟画面上任何东西都对不上，纯装饰。
function buildSelList() {
  selList.value = selEntries.map((e, idx) => {
    const c = cardFor(e) || {}
    return { idx, active: e === selEntry, name: e.name, noradId: e.noradId, syn: !!e._grdFolder, kind: c.kind || '', slot: c.slot || '', alt: c.alt || '—', incl: c.incl || '—' }
  })
}

// ===================== 自定义星座（仿 STK Walker 生成器） =====================
// 合成星并入点云叠加显示：其 entries 追加进 renderEntries，即自动获得星点渲染 / 点选 / 选中轨道·星下点·足迹。
const DEFAULT_SAT_RGB = [0x9f / 255, 0xd0 / 255, 0xef / 255]   // 默认星点色（与统一材质 0x9fd0ef 一致）
// 星点原色 → '#rrggbb'（卫星组配色 > 自定义星自身色 > 分组覆盖色 > 默认色，与 refreshPositions 的逐点取色链同序）；
// 供选中星「在轨点」大号圆点跟随星点原色
const satDotHex = (e) => { const c = (e && satGrpColor.size && satGrpColor.get(String(e.noradId))) || (e && e.color) || (e && groupRgb(e.group)) || DEFAULT_SAT_RGB; const h = (n) => Math.max(0, Math.min(255, Math.round(n * 255))).toString(16).padStart(2, '0'); return '#' + h(c[0]) + h(c[1]) + h(c[2]) }
let renderHasColor = false     // 渲染集是否含逐点色（有可见自定义星座或分组配色覆盖时为真 → 传 colors 给 setSatellites）
// —— 在轨现实星座「星点颜色」：按分组可改、可复位、持久化 ——
// 每个内置分组一条覆盖色；缺省=默认蓝。'none' 无星、'all' 由各星自身分组着色（故此二者不设独立色）。
const DEFAULT_SAT_HEX = '#9fd0ef'   // 与 DEFAULT_SAT_RGB / 统一材质 0x9fd0ef 一致
const groupColors = reactive({})    // 分组 key -> '#rrggbb'
const groupColorable = (key) => key !== 'none' && key !== 'all'
const groupColorHex = (key) => groupColors[key] || DEFAULT_SAT_HEX
const hasGroupColorOverrides = () => Object.keys(groupColors).length > 0
// '#rrggbb' -> [r,g,b] 0..1（供逐点顶点色）；无有效覆盖返回 null → 该星走默认色
function groupRgb(key) {
  const hex = groupColors[key]
  if (!hex || !HEX6.test(hex)) return null
  return [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255]
}
// 渲染集是否需逐点色 = 含自定义星 或 存在分组配色覆盖 或 存在卫星组配色
function recalcHasColor() { renderHasColor = renderEntries.some(isCustomEntry) || hasGroupColorOverrides() || satGrpColor.size > 0 }
function setGroupColor(key, hex) {
  if (!groupColorable(key) || !HEX6.test(hex)) return
  groupColors[key] = hex.toLowerCase()
  recalcHasColor(); refreshPositions()   // 无需重建集合，仅重算逐点色并重绘
}
function resetGroupColor(key) {
  if (!(key in groupColors)) return
  delete groupColors[key]
  recalcHasColor(); refreshPositions()
}
const customConst = useCustomConstellations(() => rebuildRenderSet())
const customList = customConst.list
// 「卫星组」：保存的命名卫星子集（来自筛选结果 / Ctrl 多选），可在星座列表下方重新显示
const satGroups = useSatGroups()
// —— 卫星组配色：NORAD → [r,g,b] 查表，插在逐点取色链最前（satGrpColor > e.color > groupRgb > 默认）。
// 常驻生效：不论这颗星此刻以哪个内置分组 / 筛选态渲染，组里给过色就按组色画 —— 组着色的意义就是在全集里认出它们。
// 组内逐颗覆盖色优先于任何组色；一星入多组时列表靠前的组先到先得。查表非响应式（每拍逐星查，不能背代理开销）。
const satGrpColor = new Map()
const hexRgbArr = (hex) => (typeof hex === 'string' && HEX6.test(hex)) ? [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255] : null
function rebuildSatGrpColor() {
  satGrpColor.clear()
  const gs = satGroups.list.value
  for (const g of gs) for (const s of g.sats) { const c = s.color ? hexRgbArr(s.color) : null; if (c && !satGrpColor.has(s.id)) satGrpColor.set(s.id, c) }
  for (const g of gs) { const c = hexRgbArr(g.color); if (!c) continue; for (const s of g.sats) if (!satGrpColor.has(s.id)) satGrpColor.set(s.id, c) }
}
// 组增删改（含成员/配色变动）→ 重建查表并即时重绘。sync：load/改色当拍生效，后续 rebuildRenderSet 读到的必是新表
watch(satGroups.list, () => { rebuildSatGrpColor(); recalcHasColor(); refreshPositions(); if (setsSeeded) { registerSets(); ensureSetsLoaded() } }, { deep: true, flush: 'sync' })
watch(customConst.list, () => { if (setsSeeded) registerSets() }, { deep: true })
function satGrpSetColor(g, hex) { satGroups.setColor(g.id, hex) }
function satGrpResetColor(g) { satGroups.setColor(g.id, '') }
function satGrpColorSats(g, ids, hex) { if (g && (ids || []).length) satGroups.colorSats(g.id, ids, hex) }
const satGrpRenameId = ref('')   // 正在行内重命名的组 id（''=无）
const satGrpRenameVal = ref('')  // 重命名输入值
const satGrpDelId = ref('')      // 待确认删除的组 id（两步删除防误删；''=无）
const satGrpRenameEl = ref(null)  // 重命名输入框 DOM（保存后自动聚焦选中）
const setRenameEl = (el) => { if (el) satGrpRenameEl.value = el }   // 函数式 template ref：只在挂载时记录，卸载(null)不清
// 「行内展开」：内置分组 / 卫星组 / 自定义星座 三处共用一套展开态，同一时刻只展开一处 ——
// 侧栏窄，同屏只该有一个上下文；也把「上万条列表」的内存与渲染开销钉死在一份上。
const expTag = ref('')            // ''=未展开 | 'g:<分组key>' | 's:<卫星组id>' | 'c:<自定义星座id>'
const expItems = shallowRef([])   // 内置分组的异步列表结果（原始数组，勿深响应式：三万条建代理就卡住了）
const expLoading = ref(false)
const expErr = ref('')
const expLabel = ref('')          // 展开源显示名：存为新组的默认名 / 在地图显示时的状态条标签
const grpListCache = new Map()    // 分组 key → 列表快照（会话内缓存：展开过一次不再读盘/联网）
let expSeq = 0                    // 异步竞态序号：结果回来时对不上当前展开源即丢弃
const expMenu = ref(null)         // 「加入组」弹出菜单 { x, y, sats:[{noradId,name}] }
// 「卫星组管理器」弹窗：组的完整增删改查。侧栏那套（存为组 / +加入 / -移出）依赖「当前渲染集 + 当前选中集」，
// 只能在星已经渲染出来时操作；管理器改为直接对【全量目录】和【组成员表】操作，与渲染态解耦：
// 新建空组 → 多次搜索累积勾选 → 一次性加入 → 组内逐颗/批量移出，全程不必先把星显示出来。
const sgmOpen = ref(false)        // 弹窗开关
const sgmId = ref('')             // 右栏正在编辑的组 id
const sgmNameVal = ref('')        // 组名输入（v-model；本页每秒重渲染，可编辑输入框不能用单向 :value）
const sgmNameEl = ref(null)       // 组名输入框 DOM（新建组后自动聚焦）
const sgmKw = ref('')             // 「搜索添加」关键词
const sgmRes = ref([])            // 搜索结果 [{ id, name, groupLabel }]
const sgmPick = ref([])           // 待加入暂存区 [{ id, name }]：跨多次搜索累积，点「加入本组」才落盘
const sgmSel = ref([])            // 成员表勾选的 NORAD（批量移出用）
const sgmMemKw = ref('')          // 成员表内过滤词
const sgmDelId = ref('')          // 组删除两步确认
const sgmBusy = ref(false)        // 搜索中（首次要拉全量目录）
const sgmPool = ref(new Map())    // NORAD -> 分组标签：打开时按当前星历快照，供成员表标注归属 / 是否还在星历里
let sgmTimer = null               // 搜索防抖
const SGM_MAX = 300               // 搜索结果条数上限（侧栏下拉是 40，管理器要能一次全选一批故放宽）
// 导入组卫星数（文件管理 custom.json 的权威计数）：挂载/导入/删除时刷新。单独决定「自定义卫星」分组
// 是否有数据——无导入星历则不在星座列表里出现（文件管理是导入库的唯一权威）。
// 【勿把自建星座 customList 并进来】：该分组 loadGroup 只读 omm.customCsv()（=导入库），自建 Walker 星座
// 只存 localStorage、从不进 custom.json，且 pickGroup 选内置组时会 showOnly(null) 隐藏全部自建星座 ——
// 一旦并入，生成一座星座就会多出一行点开必空（还提示「暂无自定义卫星」）的孤儿分组。自建星座在下方
// 「自定义星座」区独立管理与显隐，不占内置组列表的行。
const customImportCount = ref(0)
// 导入组清单（侧栏「导入星历」区块的数据源）：id / name / kind / format / visible / color / count / 时段
const importGroups = ref([])
async function refreshCustomImportCount() {
  try {
    const r = (apiOk && window.api.omm.customList) ? await window.api.omm.customList() : null
    customImportCount.value = (r && r.count) || 0
    importGroups.value = (r && r.groups) || []
    // 组色进 groupColors：entries 的 group 是 'ci:<组id>'，逐点取色链（satGrpColor > e.color >
    // groupRgb(e.group) > 默认）就能按组命中，不必给每颗星单独塞 color。
    for (const k of Object.keys(groupColors)) if (k.indexOf('ci:') === 0) delete groupColors[k]
    for (const g of importGroups.value) if (g.color && HEX6.test(g.color)) groupColors['ci:' + g.id] = g.color.toLowerCase()
  } catch { customImportCount.value = 0; importGroups.value = [] }
}

// 星历点序列的采样表缓存（组 id -> [{ key,name,noradId,eph }]）。表由主进程按 TEME 采好经 IPC 传来，
// 渲染端只插值（见 ephemTable.js 头注）。组内容一变就作废。
const ephTables = new Map()
// 关联星解析器（liveEntryOf）的来源版本：entries / searchPool / ephAll 都是普通变量（非响应式）—— 只靠引用变化，
// 依赖星位的 computed（2D 星下点、波束合成站数 / 赋形峰值 / PAM 扫描…）在暂停档里会一直捏着换源之前那份 null。
// 换源处（rebuildRenderSet / setSearchPool / 采样表缓存重建）自增，解析器的取源函数读它。
// ★ 放在这里（早于 liveEntryOf 与三个换源处）：poolTick / entSetVer 声明得更晚，在取源函数里读它们有 setup 期 TDZ 的口子。
const resolverVer = ref(0)
// 已载入的全部点序列星（不论图层显隐）扁平成一份：GRD 关联星解析（liveEntryOf / bodyEntryOf）的一路来源 ——
// 图层一关，那组星就出了 entries，但关联星的身份不该随地图显隐变。整份换新（解析器按引用判作废）。
let ephAll = []
function rebuildEphAll() { ephAll = [...ephTables.values()].flat(); resolverVer.value++ }
// 组 id → 在途的那次载入 { p }：图层载入与关联星补载（ensureLinkedEphTables）撞在一起时共用一次 IPC；
// 途中被作废（组内容换了）的那次载完不入缓存
const ephPending = new Map()
function invalidateEphTables(id) {
  if (id) { ephTables.delete(id); ephPending.delete(id) } else { ephTables.clear(); ephPending.clear() }
  rebuildEphAll()
}
async function ephemEntriesOf(gid) {
  if (ephTables.has(gid)) return ephTables.get(gid)
  const inflight = ephPending.get(gid)
  if (inflight) return inflight.p
  const job = { p: null }
  ephPending.set(gid, job)
  job.p = (async () => {
    let out = []
    try {
      const t = apiOk && window.api.omm.ephemTable ? await window.api.omm.ephemTable(gid) : null
      for (const s of ((t && t.sats) || [])) {
        const tab = tableFrom(s)
        if (!tab) continue
        out.push({ eph: tab, key: s.key, name: s.name, noradId: s.noradId, group: 'ci:' + gid, _ephGroup: gid })
      }
    } catch { out = [] }
    if (ephPending.get(gid) === job) { ephPending.delete(gid); ephTables.set(gid, out); rebuildEphAll() }
    return out
  })()
  return job.p
}

// 生成/编辑向导草稿（null=关闭）
// orbitType = 轨道向导的九种类型之一；'custom' 就是原来那套六根数表单（旧存档没有 design 字段，
// 读回时一律当 'custom'，行为与从前逐字一致）。design 存该类型自己的输入，供再编辑回显。
const constModal = ref(null)
function defaultConstDraft() {
  return {
    id: null, name: byLang('自定义星座', 'Custom Constellation'),
    orbitType: 'custom', design: OD.defaultInputs('custom'),
    pattern: 'delta', T: 24, P: 6, F: 1, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0,
    color: '#4dabf7', colorByPlane: true,
    pvAll: false,  // 聚焦档：false = 只把种子星放进选中集；true = 预览星座每一颗都进选中集（轨道线 / 轨迹 / 覆盖圈逐颗画）
    pvSolo: true   // 「仅预览」：向导开着时地图上只有正在生成的星座；关掉才叠加在当前显示的卫星上
  }
}
function openConstWizard(cfg) {
  if (cfg) {
    const d = cfg.design || null
    constModal.value = { ...defaultConstDraft(), id: cfg.id, name: cfg.name, color: cfg.color, colorByPlane: cfg.colorByPlane !== false, ...cfg.params,
      orbitType: (d && d.type) || 'custom', design: (d && d.inputs) ? { ...d.inputs } : OD.defaultInputs('custom') }
  } else constModal.value = defaultConstDraft()
}
// 换轨道类型：换一套缺省输入（'custom' 那一档用当前表单值回填，切过去不丢已填的根数）
function setOrbitType(t) {
  const m = constModal.value; if (!m || m.orbitType === t) return
  m.orbitType = t
  m.design = t === 'custom'
    ? { shape: m.shape, perigeeKm: m.perigeeKm, apogeeKm: m.apogeeKm, inclDeg: m.incl, argpDeg: m.argp, raanDeg: m.raan0, m0Deg: m.m0 }
    : OD.defaultInputs(t)
}
const setDesign = (k, v) => { const m = constModal.value; if (m) m.design = { ...m.design, [k]: v } }
// 当前草稿解出来的一组根数（null = 解不出来，读数区与预览都据此停住）
const constSolved = computed(() => {
  const m = constModal.value; if (!m) return null
  // 求解时刻 = 场景历元（各合成星 satrec 的历元就是它，见 useCustomConstellations.elementsToSatrec）：
  // 经度类轨道用 GMST(t0) 把经度换成 RAAN、地方时类用 t0 的太阳平黄经定 RAAN，而 M₀ 同样从 t0 起算 ——
  // 三者必须同一时刻。取仿真时钟会让整座星座偏 15°/h ×（时钟 − 历元）。历元串坏掉才退回时钟。
  const ep = new Date(customConst.scenarioEpoch.value)
  const t0 = isNaN(ep) ? calcAt().getTime() : ep.getTime()
  const inputs = m.orbitType === 'custom'
    ? { shape: m.shape, perigeeKm: m.perigeeKm, apogeeKm: m.apogeeKm, inclDeg: m.incl, argpDeg: m.argp, raanDeg: m.raan0, m0Deg: m.m0 }
    : m.design
  return OD.solveDesign(m.orbitType, inputs, t0, { gmst: sat.gstime(new Date(t0)) })
})
// 某一项输入有没有被判错（界面据此给红框）
const constFieldBad = (field) => {
  const s = constSolved.value
  return !!(s && !s.ok && s.errs.some((e) => e.field === field))
}
function closeConstWizard() {
  const editId = constModal.value && constModal.value.id
  constModal.value = null   // 触发 watch：撤预览 + 重建
  if (editId) nextTick(() => rebindSelection('cc_' + editId))   // 编辑现有星座取消：选中重绑回原版
}
// 草稿 → 生成参数（校验后调用）。
// 轨道向导的八种类型：先解出一组根数再交给既有的 seedToParams / generateConstellation —— 
// walker.js 一个字没改，向导只是换了一种【输入】方式。
function draftParams(m) {
  if (m.orbitType && m.orbitType !== 'custom') {
    const s = constSolved.value
    if (!s || !s.ok) return null
    return OD.seedToParams(s.seed, { pattern: m.pattern, T: m.T, P: m.P, F: m.F }, m.name)
  }
  return {
    pattern: m.pattern, T: Math.round(+m.T) || 1, P: Math.max(1, Math.round(+m.P) || 1), F: Math.round(+m.F) || 0,
    incl: +m.incl || 0, shape: m.shape, perigeeKm: +m.perigeeKm || 0,
    apogeeKm: m.shape === 'ellip' ? (+m.apogeeKm || +m.perigeeKm || 0) : (+m.perigeeKm || 0),
    argp: +m.argp || 0, raan0: +m.raan0 || 0, m0: +m.m0 || 0, name: m.name
  }
}
function saveConstWizard() {
  const m = constModal.value; if (!m) return
  const params = draftParams(m)
  if (!params) { const s = constSolved.value; appAlert((s && s.errs.map((e) => e.msg).join('；')) || '轨道解不出来'); return }
  const v = validateWalker(params)
  if (!v.ok) { appAlert(v.errs.join('；')); return }
  const draft = { name: m.name, params, color: m.color, colorByPlane: m.colorByPlane !== false,
    design: { type: m.orbitType || 'custom', inputs: { ...(m.design || {}) } } }
  // ★ 顺序即修复：customConst.add/update 会【同步】notify → rebuildRenderSet。向导还开着（pvSolo 默认开）
  //   而预览已撤时，那一趟走「仅预览」分支拿到空 renderEntries —— 此刻做任何重绑都只会把选中集丢光
  //   （rebindSelection 找不到就 closeCard），卡片与轨道线随之消失。故：先置提交标记 → 先关向导 →
  //   再撤预览 → 再落库 → 等新座真的进了可见集，最后才在【有提交版本的】渲染集上重绑。
  wizPreviewCommit()             // 先置位：constModal 的 watch（pre-flush，本函数跑完才执行）据此不再还原进向导前的选中集
  constModal.value = null        // 先关向导：此后 wizardSolo() 为假，任何重建都走并集分支
  customConst.setPreview(null)   // 撤实时预览，避免与提交版本重叠（watch 里还会再撤一次，幂等）
  let id = m.id
  if (m.id) customConst.update(m.id, draft); else { const cfg = customConst.add(draft); id = cfg.id }
  registerSets()
  if (!m.id) soloSet('c:' + id)  // 新建星座：仅显示它。satSets.ensure 只排序不置可见 —— 新座要到这一步才进
                                 //   可见集，所以重绑必须排在它后面（顶部「仅显示」标签一点就还原叠加）
  rebindSelection('cc_' + id)    // 选中的预览星重绑到提交版本，卡片/覆盖/星下点/轨迹不断
  saveSelection()                // 持久化的选中星还停在预览段的合成号上，换成提交版本
}
// 预览特效（轨道线 / 星下点轨迹 / 覆盖圈 / 覆盖锥 / 轨迹长度）就是「聚焦卫星」显示设置那一份 focusStyle：
// 向导里的开关直接改它、关向导不还原 —— 预览星与任何一颗聚焦星长得一样，两边永远同步。
// 编辑器打开时：参数变动实时预览到地球（防抖 140ms；非法参数撤预览）。关闭时撤预览。
let _cpvTimer = null
watch(constModal, (m) => {
  if (_cpvTimer) { clearTimeout(_cpvTimer); _cpvTimer = null }
  if (!m) { customConst.setPreview(null); rebuildRenderSet(); wizPreviewRelease(); return }
  _cpvTimer = setTimeout(() => {
    _cpvTimer = null
    const cur = constModal.value; if (!cur) return
    const params = draftParams(cur)
    if (!params || !validateWalker(params).ok) { customConst.setPreview(null); rebuildRenderSet(); wizPreviewSelect(); return }   // 解不出来：预览撤掉，预览星也从选中集退出（不然上一轮的轨道还挂在图上）
    customConst.setPreview({ id: cur.id, name: cur.name, color: cur.color, colorByPlane: cur.colorByPlane !== false, params })
    rebuildRenderSet()
    wizPreviewSelect()                  // 种子星进选中集 → 轨道线 / N 圈星下点轨迹 / 覆盖圈走聚焦几何管线随参数实时重画
  }, 140)
}, { deep: true })
// 向导实时预览：每面数 / 面间相位 / Walker 码 / 周期 / 校验提示
const constDerived = computed(() => {
  const m = constModal.value; if (!m) return null
  const single = m.pattern === 'single'
  const T = single ? 1 : (Math.round(+m.T) || 0)
  const P = (single || m.pattern === 'plane') ? 1 : Math.max(1, Math.round(+m.P) || 1)
  const F = (single || m.pattern === 'plane') ? 0 : (Math.round(+m.F) || 0)
  const S = single ? 1 : (Math.floor(T / P) || 0)
  const s = constSolved.value
  // 布局校验按【解出来的 params】判，解不出来就只报求解器的错（别再叠一层 Walker 的）
  const params = s && s.ok ? draftParams(m) : null
  const v = params ? validateWalker(params) : { warns: [], errs: [] }
  const warns = (s ? s.warns : []).concat(v.warns)
  const errs = (s && !s.ok ? s.errs.map((e) => e.msg) : []).concat(v.errs)
  return {
    S, total: single ? 1 : (m.pattern === 'plane' ? T : P * S),
    phase: (T ? F * 360 / T : 0).toFixed(1),
    code: params ? walkerCode(params) : '—',
    seed: s && s.ok ? s.seed : null,
    d: s && s.ok ? s.derived : null,
    warns, errs
  }
})
// LTAN 读数（hh:mm）；解不出来显示「—」
const ltanText = computed(() => {
  const d = constDerived.value && constDerived.value.d
  return d ? OD.formatHm(d.ltanHours) : '—'
})
const ORBIT_TYPES = OD.ORBIT_TYPES
const ccCode = (c) => walkerCode(c.params)
// ===== 向导预览：只看正在生成的星座 + 种子星自动成为选中 =====
// 聚焦几何管线（轨道线 / 星下点轨迹 / 覆盖圈）只画【选中集】里的星 —— 没有选中什么都不画，早先的预览就只剩
// 几颗小点混在当前分组里。现在：进向导那一刻记下原选中集；每轮预览把预览星座的种子星（第 1 面第 1 颗）
// 放进选中集（首次预览把地球转过来，之后改参数不再转动）；「仅预览」开着时 rebuildRenderSet 只渲染预览星座；
// 取消时原选中集还回去，生成 / 更新时选中已由 saveConstWizard 重绑到提交版本。
const PREVIEW_GROUP = 'cc___preview__'
const wizardSolo = () => !!(constModal.value && constModal.value.pvSolo !== false)
let _wizSavedSel = null      // 进向导那一刻的选中集（null = 不在向导里）
let _wizFaced = false        // 种子星是否已转到正面
let _wizCommitted = false    // 本次关向导是「生成 / 更新」而非取消
function wizPreviewCommit() { _wizCommitted = true }
let _wizAllMode = null       // 上一轮套用的聚焦档（null = 还没套过）：换档才整批重选，不换档尊重用户在预览星里的手动多选
function wizPreviewSelect() {
  if (_wizSavedSel === null) { _wizSavedSel = selEntries.slice(); _wizFaced = false; _wizCommitted = false; _wizAllMode = null }
  const pv = customConst.previewEntries()
  if (!pv.length) {                                                       // 参数非法 → 没有预览星，预览星从选中集退出
    if (selEntries.some((e) => e.group === PREVIEW_GROUP)) { selEntries = []; selEntry = null; closeCard() }
    return
  }
  const all = !!(constModal.value && constModal.value.pvAll)
  const modeChanged = _wizAllMode !== all
  _wizAllMode = all
  rebindSelection(PREVIEW_GROUP)                                          // 上一轮的预览对象按名重绑到这一轮（改名 / 减星会掉一部分）
  const kept = selEntries.filter((e) => e.group === PREVIEW_GROUP && renderEntries.includes(e))
  if (all) {
    // 「全部」：预览星座每一颗都进选中集（增减星 / 换档时整批重铺；已经是整批则不动）
    if (!modeChanged && kept.length === pv.length && kept.length === selEntries.length) return
    selEntries = pv.slice(); selEntry = pv[0]
    resetBeam(); refreshSelection(); _selSysVer = selVer.value   // 程序选的：波束合成不跟（见 _selSysVer）
    if (!_wizFaced) { faceEntries(pv); _wizFaced = true }
    saveSelection()
    return
  }
  if (kept.length && !modeChanged) {
    if (kept.length !== selEntries.length) { selEntries = kept; if (!kept.includes(selEntry)) selEntry = kept[kept.length - 1]; refreshSelection(); _selSysVer = selVer.value }
    return
  }
  selectSat(pv[0], !_wizFaced)                                            // 「种子星」：第 1 面第 1 颗；首次预览把地球转过来
  _selSysVer = selVer.value                                               // 这一版是程序选的种子星，不是用户点名的主选
  _wizFaced = true
}
function wizPreviewRelease() {
  const saved = _wizSavedSel; _wizSavedSel = null; _wizFaced = false
  if (saved === null) return
  if (_wizCommitted) { _wizCommitted = false; return }
  // 取消：还原进向导前的选中集。真实星对象一直在 entries 里；自定义星座的对象可能已重建，按「组 + 名」重绑，已不在场的丢掉
  const back = []
  for (const e of saved) {
    if (!isCustomEntry(e) || renderEntries.includes(e)) { back.push(e); continue }
    const m = renderEntries.find((x) => x.group === e.group && x.name === e.name)
    if (m) back.push(m)
  }
  selEntries = back; selEntry = back.length ? back[back.length - 1] : null
  if (!selEntry) { closeCard(); return }
  refreshSelection(); _selSysVer = selVer.value; saveSelection()
}
function removeConst(c) { expDrop('c:' + c.id); satSets.drop('c:' + c.id); customConst.remove(c.id); registerSets(); applySetsChanged() }
let ro = null, trackRo = null
let unsubClock = null, nowBeat = null   // nowBeat：1 Hz 心跳，只刷「真实此刻」参考量（见 nowStamp）
// 跨会话待恢复的选中集：{ ids:[satIdOf…], primary }。渲染集每加载出一集就从里面认领（哪一集先到就先画哪些），
// 全部认领完置 null；用户任何一次显式改选（saveSelection）也把它作废 —— 否则晚到的集会把旧存档里的星塞进新选中集。
let restoreSel = null

// 全平台取时刻的唯一入口：星位 / GRD 覆盖 / 对星壳层 / 可见性 / 晨昏线 / 两张指标表都从这里拿。
// 实时模式下时钟每拍把 tMs 对齐系统时间，故这里不再单独 new Date()——同一拍内多次调用得到同一时刻，
// 不会出现「星位算在 t，覆盖算在 t+3ms」的自相矛盾（改造前实时档就是这样，只是量级小看不出来）。
function calcAt() { return new Date(clock.tMs) }
// —— 自定义星座（合成星）时间模型（STK 口径）——
// 场景历元（customConst.scenarioEpoch，可设/持久化，默认当天 08:00）只作各合成星 satrec 的【固定设计历元】：
// 定 RAAN/MA 的惯性参考、跨会话稳定（RAAN 仍是真惯性升交点赤经，与真实 TLE/星历同参考）。
// 合成星与真实目录星【完全一样】按真实墙钟时刻 calcAt() 正向传播 —— 即从场景历元正向推算到时间轴当前时刻的
// 真实状态（STK：Scenario Epoch 定义星座 → 动画时刻正向演化）。故时间轴「此刻」＝真实当前时刻，显示的是
// 「场景历元建立的星座传播到此刻」的状态；绝对时刻在合成星 / 真实星 / NGSO 典型时刻之间同属一个（墙钟）系、
// 可直接互相对照（NGSO 典型时刻 t* 直接设进时间轴即与地图星下点吻合，不再需要场景历元偏移换算）。
const isCustomEntry = (e) => !!(e && e.group && e.group.indexOf('cc') === 0)   // 合成星 group='cc_<id>'（真实组均不以 cc 开头）
// 合成星传播时刻 = 墙钟当前时刻 calcAt()（与真实星同系）；设计历元固定在各星 satrec 内部（=场景历元），此处不再重锚。
function ccTimeAt(now) { return now || calcAt() }
// 场景历元编辑：<input datetime-local> 走本地时刻，内部存 ISO(UTC)；改动即重建全部合成星并按名重绑当前选中
const scenarioEpochLocal = computed({
  get: () => { const d = new Date(customConst.scenarioEpoch.value); if (isNaN(d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` },
  set: (v) => applyScenarioEpoch(new Date(v))
})
function applyScenarioEpoch(d) { if (!d || isNaN(d)) return; customConst.setScenarioEpoch(d.toISOString()); rebindSelection('') }
function scenarioEpochNow() { applyScenarioEpoch(new Date()) }

const fmtSlot = fmtGeoSlot   // °E/°W 格式化统一走 shared/geoSlot.js（模板日下点等处沿用旧名）
const fmtDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

// ===================== 信息卡（字段/顺序与 2D 完全一致） =====================
function cardFor(e) {
  const now = isCustomEntry(e) ? ccTimeAt() : calcAt(), gmst = sat.gstime(now)   // 合成星按场景历元解算
  const pv = posAt(e, now)
  if (!pv || !pv.position) return null
  const gd = sat.eciToGeodetic(pv.position, gmst), v = pv.velocity, r = pv.position
  const WE = 7.2921159e-5
  const speedAbs = v ? Math.hypot(v.x, v.y, v.z) : 0
  const speedRel = (v && r) ? Math.hypot(v.x + WE * r.y, v.y - WE * r.x, v.z) : 0
  // 星历点序列星没有 satrec：倾角 / 周期 / 近远地点由采样表算（shared/satrecMetrics.js 那一份算式，
  // 与「查找卫星」筛选器共用），Ω / ω / M 这类只有平根数才有的量一律留空 —— 不由位置反推假根数。
  const rec = e.rec || null
  const g = metricsFromEntry(e) || {}
  const periodMin = g.periodMin != null ? g.periodMin : null          // 轨道周期(min)，估不出为 null
  const meanMotion = g.meanMotion != null ? g.meanMotion : null       // 平均运动(rev/day)
  const apoKm = g.apogeeKm != null ? g.apogeeKm : null, perKm = g.perigeeKm != null ? g.perigeeKm : null
  const meanKm = (apoKm != null && perKm != null) ? (apoKm + perKm) / 2 : null
  // 轨道区制判定（GEO/IGSO/MEO/LEO/HEO）——严谨口径见 shared/orbitClass.js（先偏心率→再同步周期→高度带）
  // 星历星可能只有周期（classifyOrbit 据此推半长轴）；连周期都估不出就不给区制，不拿默认值冒充判定
  const kind = (periodMin != null || meanKm != null)
    ? classifyOrbit({ aKm: meanKm != null ? RE + meanKm : null, e: g.ecc, inclDeg: g.incl, perigeeAltKm: perKm, apogeeAltKm: apoKm, periodMin })
    : ''
  const ang = (x) => (x == null || !Number.isFinite(x) ? '' : (((x / DEG) % 360 + 360) % 360).toFixed(2))
  return {
    name: e.name, noradId: e._grdFolder ? '' : e.noradId, group: e.groupLabel || GROUP_LABEL[e.group] || '', kind,   // 天线树定点星的合成号不是 NORAD，不上信息栏
    slot: geoSlotOfSatrec(rec),   // GEO 才有定点标注（严区制判定，与分组无关；历元值缓存，不随时钟漂移）
    alt: gd.height.toFixed(0), lat: sat.degreesLat(gd.latitude).toFixed(2), lon: sat.degreesLong(gd.longitude).toFixed(2),
    hasEl: !!rec || periodMin != null || g.incl != null,   // 有没有可显示的根数行（星历星只可能有倾角 / 周期 / 平均运动）
    incl: g.incl != null ? g.incl.toFixed(2) : '', ecc: g.ecc != null ? g.ecc.toFixed(5) : '',
    period: periodMin != null ? periodMin.toFixed(1) : '', periodMinRaw: periodMin,
    perigee: perKm != null ? perKm.toFixed(0) : '', apogee: apoKm != null ? apoKm.toFixed(0) : '',
    meanMotion: meanMotion != null ? meanMotion.toFixed(4) : '',
    raan: rec ? ang(rec.nodeo) : '', argp: rec ? ang(rec.argpo) : '', ma: rec ? ang(rec.mo) : '',
    speedAbs: speedAbs.toFixed(3), speedRel: speedRel.toFixed(3),
    // 卫星信息栏新增读数（数据现成，不出判定）：半长轴 a = RE + (近地点 + 远地点)/2；
    // 历元取 satrec.jdsatepoch（星历点序列星没有 rec → 不出）；历元龄 = 本卡时刻 − 历元（合成星同样按 ccTimeAt 口径）
    aKm: meanKm != null ? (RE + meanKm).toFixed(0) : '',
    epochMs: epochMsOf(rec),
    epochAgeD: epochMsOf(rec) != null ? ((now - epochMsOf(rec)) / 864e5).toFixed(2) : ''
  }
}
// 定点星（rec.__fix）那份根数只供读数，历元只是读数参考、不是星历历元 → 不出历元 / 历元龄
function epochMsOf(rec) { return rec && !rec.__fix && Number.isFinite(rec.jdsatepoch) ? (rec.jdsatepoch + (rec.jdsatepochF || 0) - 2440587.5) * 864e5 : null }

// ===================== 选中几何：轨道圈 / 星下点轨迹 / 覆盖足迹 =====================
// 为所有选中星各画一组轨道圈/星下点轨迹/覆盖足迹；星下点轨迹/覆盖足迹固定原色多颗叠画，轨道圈固定原色仅 primary 加粗加亮区分聚焦星。
// 只「算」不「推」：几何由 Worker 池产出（预制顶点缓冲），提交交给 commitGeometry
// 与 beam 夹断占位。实际提交交由 commitGeometry 与可见性叠加层、对星聚焦特效合并
//（三者共用 setSelectionSet / setFocusSatLLA / setHighlightLLA replace-all 通道，故必须一次性喂）。

// —— 多选聚焦的细节分档 ——
// 少量选中保持满细节，多了就降采样。线已在 3D 端按样式合批（见 scene.setSelectionSet），
// 对象数与颗数无关。
// ★ 这一档现在只管【覆盖圈分段】与【轨迹节拍】：轨道圈与星下点轨迹都已上缓存（focusGeomCache），
//   逐拍不再重推，轨道圈的段数改由弦垂定（ringSegments），不再按颗数摊薄。
const FOCUS_FULL_N = 24            // 这个颗数以内保持满细节（与单选完全一致）
const FOCUS_SAMPLE_BUDGET = 2880   // 超出后每次刷新的轨道采样点总预算（= 24 × 120）
const FOCUS_SAMPLE_MIN = 24        // 单颗采样下限：再少轨道圈就看得出折线
const FOCUS_FP_BUDGET = 1728       // 足迹分段总预算（= 24 × 72）
const FOCUS_FP_MIN = 18
// 「画几何的颗数上限」FOCUS_GEOM_MAX 已取消：轨道圈/轨迹上缓存、等仰角线换求根路径之后，
// 逐拍开销不再随颗数把预算吃穿，选中多少就画多少（见 .focusharness/starlink.mjs 的前后对照表）。
// 轨迹圈数的总采样预算：圈数直接决定轨迹的点数，而这些点每拍都要重新拼成线段缓冲上传 —— 几百颗 ×
// 十圈是每拍十几 MB 的传输，故多选时按颗数收回来（单选/少量选中时 cap 远大于 10，用户设几圈就是几圈）。
// 恒保底 1 圈，与可自定义之前的画法一致。
// 曾取 12000（十圈滑杆时代）；圈数改成自由输入后放到 48000 —— 单选可到 400 圈，≥400 颗时仍是保底那 1 圈，
// 中间档（如 100 颗 × 4 圈）每拍多传的也只是一两 MB 的线段。
const FOCUS_TRACK_BUDGET = 48000
// 轨迹面另设一档顶点预算：带面是「每个采样点一条横断面 × K 段 × 两个三角形」（每格 18 个 float），比一条线重一两个
// 量级，多选时按颗数把圈数收回来。保底 0.25 圈，不像线那样保底 1 圈 —— 几百颗星各画一圈带面已经铺满全球。
// K 按主选星的远地点高度与当前覆盖圈口径估（与 Worker 里逐星算的同一个函数）。
const FOCUS_SWATH_BUDGET = 6e6
const fpOptNow = () => ({ mode: fpMode.value, beamDeg: parseFloat(beam.value), elevDeg: parseFloat(elevMin.value) })
const focusSwathK = (e) => swathK(e && e.rec && e.rec.alta > 0 ? e.rec.alta * RE : 0, fpOptNow())
// 轨迹长度口径：圈数档（trkSpanMode='rev'）＝每颗星各按自己的周期 × trkPeriods；时长档（'time'）＝全体同一段 trkSpanMin 分钟。
// 两档都先折成「圈数」再过预算（时长档按 periodMin 折算 —— 调用方给主选星 / 该星的周期）。输入本身不设上限，
// 预算夹断后实际画了多长由信息卡「轨迹周期」行如实显示。
const focusTrackPeriods = (n, samples, periodMin) => {
  let want
  if (focusStyle.trkSpanMode === 'time') { const m = Number(focusStyle.trkSpanMin); want = m > 0 && periodMin > 0 ? m / periodMin : 1 }
  else { const r = Number(focusStyle.trkPeriods); want = r > 0 ? r : 1 }
  const cap = FOCUS_TRACK_BUDGET / Math.max(1, n * Math.max(1, samples))
  let per = Math.min(want, Math.max(1, cap))
  if (focusStyle.trkOn && focusStyle.trkMode === 'swath') {
    const capS = FOCUS_SWATH_BUDGET / Math.max(1, n * Math.max(1, samples) * Math.max(2, focusSwathK(selEntry)) * 18)
    per = Math.min(per, Math.max(0.25, capS))
  }
  return Math.max(1e-3, per)
}
const focusLod = (n) => {
  const samples = n <= FOCUS_FULL_N ? 120 : clamp(Math.round(FOCUS_SAMPLE_BUDGET / n), FOCUS_SAMPLE_MIN, 120)
  return {
    samples,
    // 细分阈值随采样数放宽：近圆轨道相邻跳变 ≈ 384/N 度，阈值卡在它之上一点点 —— 否则
    // sampleOrbitAdaptive 会把降下去的点数原样二分补回来（120 点时正好落回原来的 4°）
    stepDeg: clamp(480 / samples, 4, 30),
    fpSeg: n <= FOCUS_FULL_N ? 72 : clamp(Math.round(FOCUS_FP_BUDGET / n), FOCUS_FP_MIN, 72)
  }
}
// —— 聚焦星几何：整条流水线摊给 Worker 池 ——
// 主线程这边只剩三件事：把选中集同步过去、把这一拍的参数算好、拿回 Float32Array 交给渲染器。
// 逐颗的活（SGP4、覆盖圈、顶点构建、点层分桶）全在 focusGeomTick.js 里，主线程与 Worker 跑的是同一份。
// ★ 时钟那条铁律由 refreshPositions 守：本拍几何没画完就不算一拍完（见那里的 await 与 scene.holdFrames）。
let geomPool = null
let poolEntries = null, poolPrimary = null
let ringEpoch = null          // 轨道圈参考历元：全体环共用一刻 —— 只有共用，整组才能只设一个四元数
let ringDirty = true          // 环的顶点要不要重来（线型/开关变了算，颜色/线宽不算：那是材质的事）
function syncPool(draw, primary) {
  let same = poolEntries && poolEntries.length === draw.length && poolPrimary === primary
  if (same) for (let i = 0; i < draw.length; i++) if (poolEntries[i] !== draw[i]) { same = false; break }
  if (same) return
  // ★ 选中集/主选一变，轨道圈就必须重建 —— 它是【缓存几何】，reRing 只认「首次 / ringDirty / TTL 到期」，
  //   不置这一句的话：裸点选换一颗星，画面上留着的还是上一颗的环，新那颗一根线也没有，
  //   而且暂停档 nowMs 不动、TTL 永远到不了期（实时档也要等 LEO 4.75 min / GEO 30 min）。
  //   主选变了同样算：主/非主两桶的线宽与透明度不同（orbP / orb），不重建就换不过来。
  ringDirty = true
  poolEntries = draw.slice(); poolPrimary = primary
  // eph 表与 satrec 一样是纯数据，结构化克隆得动 Worker；下游 focusGeomTick 走 posAt，两种都认。
  geomPool.setSats(draw.map((e) => ({ key: satIdOf(e), rec: e.eph || e.rec, cc: isCustomEntry(e), color: hexNum(satDotHex(e)) })),
    primary ? satIdOf(primary) : null)
}
// 只「算」不「推」：返回 Promise<{shards, ringBuild, spin} | null>；null＝这一拍被更新的一拍顶掉了，别画。
function startFocusGeometry() {
  if (!scene || !geomPool || !selEntries.length) { ringEpoch = null; poolEntries = null; return Promise.resolve({ shards: [], ringBuild: true, spin: 0 }) }
  const now = calcAt(), nowMs = now.getTime(), gmstNow = sat.gstime(now)
  const ccNow = ccTimeAt(now)
  const draw = selEntries                                     // 选中集全画：几何不再有颗数上限
  syncPool(draw, selEntry)
  const lod = focusLod(draw.length)
  // 星下点轨迹长度：圈数档给 per（各星按自己的周期），时长档给 spanMs（全体同一段；预算按主选星周期折算）
  const pMin = periodMinOf(selEntry) || 0         // 星历星走表内升交点估计；估不出为 0（按圈数档退化）
  const per = focusTrackPeriods(draw.length, lod.samples, pMin)
  const spanMs = focusStyle.trkSpanMode === 'time' && pMin > 0 ? per * pMin * 60000 : 0
  const orbOn = !!focusStyle.orbOn
  // TTL 取选中集里【最短】的那个（周期越短，重建时被换掉的环长占比越大）。
  // 估不出周期的星历星跳过：它的环是按表点连的，不随时间漂，全是这种星时 ttl 保持 Infinity ——
  // 只在首次 / ringDirty 时重建，这正确。
  let ttl = Infinity
  if (orbOn) for (let i = 0; i < draw.length; i++) { const pm = periodMinOf(draw[i]); if (!(pm > 0)) continue; const v = ringTtlMs(pm * 60000); if (v < ttl) ttl = v }
  const reRing = orbOn && (!ringEpoch || ringDirty || Math.abs(nowMs - ringEpoch.tMs) > ttl)   // 跳变/倒放取绝对值
  // ★ 重建标记在【这一份真的画上去】时才落账（见末尾 then）：这一拍被更新的一拍顶掉（compute 回 null）时 ringDirty 原样留着，
  //   下一拍照样重建。早先在这里就清 ringDirty / 换 ringEpoch —— 顶掉的恰好是重建那一拍时，后面几拍都判「不必重建」，
  //   暂停档 TTL 永远不到期，环就一直没有（或停在上一次的样子）；主线程一有几百毫秒的活（侧栏缩略图现场出图）就碰得上。
  const epoch = reRing ? { tMs: nowMs, gmst: gmstNow } : ringEpoch
  const p = {
    tMs: nowMs, gmst: gmstNow, ccTMs: ccNow.getTime(), ccGmst: sat.gstime(ccNow),
    lod, per, spanMs,
    ring: { on: orbOn, tMs: epoch ? epoch.tMs : nowMs, gmst: epoch ? epoch.gmst : gmstNow, rebuild: reRing, build: reRing },
    fp: fpOptNow(),
    style: {
      orbDash: focusStyle.orbDash,
      trkOn: !!focusStyle.trkOn, trkDash: focusStyle.trkDash, trkMode: focusStyle.trkMode, trkFillOn: focusStyle.trkFillOpacity > 0,
      fpOn: !!focusStyle.fpOn, fpDash: focusStyle.fpDash,
      fillOn: focusStyle.fpFillOpacity > 0,
      coneOn: !!focusStyle.coneOn, faceOn: focusStyle.coneFaceOpacity > 0,
      genCount: focusStyle.coneGenCount, genDash: focusStyle.coneGenDash,
      dotOn: !!focusStyle.dotOn, dotPx: focusStyle.dotPx,
      subOn: !!focusStyle.subOn, ringOn: !!focusStyle.ringOn
    },
    want2d: !!flat && flatActive()      // 平面图不在看时不打包它那份经纬折线（打了也是白打）
  }
  // spin = 参考 gmst − 当前 gmst：地球东转了 ΔGMST，环相对地球就反着转这么多（llaToVec 里 Y 是极轴）
  const spin = orbOn && epoch ? epoch.gmst - gmstNow : 0
  return geomPool.compute(p).then((shards) => {
    if (!shards) return null
    if (reRing) { ringEpoch = epoch; ringDirty = false }
    return { shards, ringBuild: reRing, spin }
  })
}
// 波束角档的 ε=0 上限：主选那颗由 Worker 一并回填（placeholder 常显上限；用户超限回写夹断值，锁定态不回写）
function applyBeamLimit(shards) {
  for (const sh of shards) {
    if (sh.bMaxDeg == null) continue
    const autoText = sh.bMaxDeg.toFixed(1)
    if (autoText !== beamAuto.value) beamAuto.value = autoText
    if (sh.clampText != null && !beamLock.value && sh.clampText !== beam.value) beam.value = sh.clampText
    return
  }
}
// 分片的 2D 打包 → 平面图要的对象形态（只在平面图真在看时才走到这里）
function flatGeomOf(shards) {
  const geom = [], subs = []
  for (const sh of shards) {
    const f = sh.flat
    if (!f) continue
    let sk = 0   // swSk 游标：逐星断面数−1 顺排
    for (let i = 0; i + 1 < f.trkOff.length; i++) {
      const track = [], footprint = []
      for (let j = f.trkOff[i]; j < f.trkOff[i + 1]; j++) track.push({ lat: f.trkLL[j * 2], lon: f.trkLL[j * 2 + 1] })
      for (let j = f.fpOff[i]; j < f.fpOff[i + 1]; j++) footprint.push({ lat: f.fpLL[j * 2], lon: f.fpLL[j * 2 + 1] })
      const la = f.sub[i * 2], lo = f.sub[i * 2 + 1]
      const sub = Number.isFinite(la) ? { lat: la, lon: lo } : null
      if (sub) subs.push(sub)
      // 轨迹面：横断面经纬块（每点 K+1 对 lat/lon）+ 逐步「非平移步」标志（切片填充用）+ 圆盘环（打转段与首尾端帽）
      //        + 轮廓折线（扫过区域的外边界，描边用）（见 focusSwath.swathFlatGeom）
      let swath = null, swRings = null, swLines = null
      const K = f.swK ? f.swK[i] : 0
      if (K > 0) {
        const m = K + 1, a0 = f.swOff[i] * 2, a1 = f.swOff[i + 1] * 2
        const ll = f.swLL.subarray(a0, a1), ns = Math.floor(ll.length / (m * 2)), nSt = Math.max(0, ns - 1)
        const skip = f.swSk ? f.swSk.subarray(sk, sk + nSt) : null
        sk += nSt
        swath = { K, ll, skip }
        const unpack = (off, pt, src) => {
          const out = []
          for (let r = off[i]; r < off[i + 1]; r++) {
            const pl = []
            for (let q = pt[r]; q < pt[r + 1]; q++) pl.push({ lat: src[q * 2], lon: src[q * 2 + 1] })
            out.push(pl)
          }
          return out
        }
        swRings = unpack(f.swRgOff, f.swRgPt, f.swRgLL)
        swLines = unpack(f.swLnOff, f.swLnPt, f.swLnLL)
      }
      geom.push({ track, footprint: footprint.length ? footprint : null, sub, swath, swRings, swLines })
    }
  }
  return { geom, subs }
}

// ===================== 对星覆盖分析：卫星「聚焦特效」（不弹信息卡）=====================
// 与点击星座卫星【同一套几何】：轨道圈 / 星下点轨迹 / 覆盖足迹 / 在轨点。区别只有两点——
//   · 不动 selEntries → 不弹信息卡、不改多选列表；
//   · 谁被点亮由本视图自己决定：小眼睛亮着【且】至少有一根天线画在壳层上的星（一棵树十几颗星
//     全套轨道圈只会糊成一团，故必须以「正在分析」为准），外加它对星跟踪的目标星（链路两端同时亮）。
// 关联星按星历实时解算，固定点星没有轨道、只出足迹与在轨点。
// NORAD → 条目：在场真实星 → 全量目录 → 自定义星座合成星(含隐藏)。O(1) 查表：四份来源（entries / searchPool 数组引用、
// 自定义星座 list 引用、场景历元）任一换了整张表作废（createNoradResolver，treeLink.js）。只按 String(NORAD) 比，不认名字。
// ★ 逐拍热路径：tickLive 每根天线问一次、redrawSats 每颗星问一次 —— 原先每次在两万多条的池上线性 find + 逐条 String()。
// eph：已载入的点序列星（含隐藏图层的组，见 ephAll）。读 resolverVer：换源后依赖星位的 computed 随之重算（暂停档也醒）。
const liveEntryOf = createNoradResolver(() => { void resolverVer.value; return { entries, pool: searchPool, eph: ephAll, ccList: customConst.list.value, ccEpoch: customConst.scenarioEpoch.value, ccFind: (id) => customConst.findByNorad(id) } })
function focusGeomOfRec(rec, isCc, color) {
  if (!rec) return null
  const now = calcAt(), t = isCc ? ccTimeAt(now) : now, g = sat.gstime(t)   // 合成星按场景历元解算
  try {
    const pv = posAt(rec, t)
    if (!pv || !pv.position) return null
    const gd = sat.eciToGeodetic(pv.position, g)
    const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude), h = gd.height
    // 自适应采样，与选中星同源（含「轨迹画几个周期」那档设置：轨道圈仍只取一个整周期）
    const periodMin = periodMinOf(rec)          // 星历表也认（估不出周期就没有「一整圈」可画）
    if (!(periodMin > 0)) return null
    const per = focusTrackPeriods(1, 120, periodMin)
    const samples = sampleOrbitAdaptive(rec, t, periodMin * Math.max(1, per), Math.round(120 * Math.max(1, per)))
    const t1 = t.getTime() + periodMin * 60000, tTrk = t.getTime() + periodMin * per * 60000
    const orbit = [], track = [], pts = []
    for (const q of samples) {
      const ms = q.t.getTime()
      if (ms <= t1 + 1) { const d = sat.eciToGeodetic(q.pv.position, g); orbit.push({ lat: sat.degreesLat(d.latitude), lon: sat.degreesLong(d.longitude), altKm: d.height }) }
      if (ms <= tTrk + 1) { track.push({ lat: q.lat, lon: q.lon }); pts.push(q) }
    }
    if (orbit.length > 1) orbit.push(orbit[0])   // 同上：轨道圈收口
    const ecf = sat.eciToEcf(pv.position, g)
    const fp = footprintAtEcef([ecf.x, ecf.y, ecf.z], h)
    // 轨迹面（与聚焦选中集同一份口径与同一套整理：focusSwath.sectionOf → buildSwath）：3D 收带面 / 圆盘 / 轮廓，
    // 2D 收 swathFlatGeom 出的经纬 / 逐步标志 / 圆盘环 / 轮廓折线
    let swath = null, flatSw = null
    if (focusStyle.trkOn && focusStyle.trkMode === 'swath' && pts.length > 1) {
      const fpo = fpOptNow(), K = swathK(Math.max(h, rec.alta > 0 ? rec.alta * RE : 0), fpo)
      const sp = pts.map((q) => { const m = groundMotion(q.pv, q.gmst); return { lat: q.lat, lon: q.lon, h: q.gd.height, az: m.az, gs: m.gs, hd: m.hd } })
      swath = buildSwath(sp, sp.map((q) => sectionOf(q, fpo, K)), K, fpo, 72, { fpOn: !!focusStyle.fpOn })
      flatSw = swathFlatGeom(swath)
    }
    return { item: { orbit, track, swath, footprint: fp, primary: false, satPos: { lat, lon, altKm: h, color } }, sub: { lat, lon }, flat: { track, ...(flatSw || {}), footprint: fp, sub: { lat, lon } } }
  } catch { return null }
}
function focusGeomStatic(node, color) {
  const lon = Number(node.lon), lat = Number(node.lat), h = Number(node.altKm)
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(h > 0)) return null
  const fp = footprintAtEcef(W.geodeticToEcef(lon, lat, h), h)
  return { item: { footprint: fp, primary: false, satPos: { lat, lon, altKm: h, color } }, sub: { lat, lon }, flat: { footprint: fp, sub: { lat, lon } } }
}
// 只「算」不「推」：返回 { items(3D), subs(3D 星下点图标), subs2d(2D 星下点图标), flat(2D 轨迹/足迹) }，
// 由 commitGeometry 与聚焦星几何、可见性叠加层合并后一次性提交（三者共用同一 replace-all 通道）。
// subs2d 只含【目标星】：源星在 2D 已由 redrawSats 画了自己的卫星图标（小眼睛的老作用），再叠一个就是重影。
// ★ 不看侧栏、也不看当前停在哪个视图：判据只有【画哪些天线】（satcov.selected）——与 3D 壳层场同一条
//   存续口径（场景内容离开面板不撤，要收走一律走「清除绘图」）。早先按 shellUi.side 门控，收起侧栏
//   壳层还在、配套的轨道线/星下点/高亮环却整批消失，成了「关个侧栏图少一半」。
// 覆盖图（GRD）里对星指向（sat / satoff）天线的目标星：只画高亮环（在轨高度），不带轨道/足迹。
// 范围＝画出来的天线（grd.selected）+ 聚焦天线；宿主星小眼睛关着的不算。已被点选的星（seen）环已在 lanes 里，跳过。
function grdBoreTargetRings(seen) {
  const keys = new Set([...grd.selected.value, grd.active.value].filter(Boolean))
  if (!keys.size) return []
  const out = [], done = new Set()
  for (const k of keys) {
    const st = (grd.getPerfContext(k) || {}).settings
    if (!st || (st.boreType !== 'sat' && st.boreType !== 'satoff') || !st.boreSat || done.has(st.boreSat)) continue
    const node = grdNodeOf(k.split('|')[0])
    if (node && !satVisible(node)) continue
    done.add(st.boreSat)
    const te = satEntryById(st.boreSat)
    if (te && seen.has(satIdOf(te))) continue
    const P = satTargetEcef(st.boreSat)
    if (!P) continue
    const g = W.ecefToGeodetic(P[0], P[1], P[2])
    if (Number.isFinite(g.lat) && Number.isFinite(g.lon) && Number.isFinite(g.h)) out.push({ lat: g.lat, lon: g.lon, altKm: g.h, bore: true })
  }
  return out
}
function computeSatcovFocusGeometry() {
  const empty = { items: [], subs: [], subs2d: [], flat: [], rings: [] }
  if (!scene) return empty
  // 一颗天线都没勾就早退：commitGeometry 每拍都走，没有这一句就是每帧把整棵树的 key 拼一遍白算
  if (!satcov.selected.value.length) { const r = grdBoreTargetRings(new Set(selEntries.map((e) => satIdOf(e)))); return r.length ? { ...empty, rings: r } : empty }
  const items = [], subs = [], subs2d = [], flatGeom = [], rings = []
  const seen = new Set(selEntries.map((e) => satIdOf(e)))   // 已被点选的星不重画一遍（几何完全一致）
  const add = (id, g, on2d) => {
    if (!g || (id && seen.has(id))) return
    if (id) seen.add(id)
    items.push(g.item); flatGeom.push(g.flat)
    if (g.item.satPos) rings.push(g.item.satPos)             // 金色高亮环：套在星本体上（在轨高度，不是星下点）
    if (g.sub) { subs.push(g.sub); if (on2d) subs2d.push(g.sub) }
  }
  for (const node of grdSats.value) {
    if (node.kind === 'elevline' || !satVisible(node)) continue
    const keys = (node.antennas || []).map((a) => grd.keyOf(node.folder, a.name)).filter((k) => satcov.selected.value.includes(k))
    if (!keys.length) continue
    const en = node.noradId ? liveEntryOf(node.noradId) : null
    if (node.noradId && !en) continue                    // 关联星不在当前星历：它的波束不画，特效也不按存盘旧位置画
    if (en) add(satIdOf(en), focusGeomOfRec(en.rec, isCustomEntry(en), satDotHex(en)), false)
    else if (node.elements) { let rec = null; try { rec = orbitSatrec(node) } catch { rec = null }; add('f:' + node.folder, focusGeomOfRec(rec, false, node.elevColor), false) }
    else add('f:' + node.folder, focusGeomStatic(node, node.elevColor), false)
    for (const k of keys) {
      const st = (grd.getPerfContext(k) || {}).settings
      if (!st || (st.boreType !== 'sat' && st.boreType !== 'satoff')) continue
      const te = satEntryById(st.boreSat)
      if (te) add(satIdOf(te), focusGeomOfRec(te.rec, isCustomEntry(te), satDotHex(te)), true)
    }
  }
  rings.push(...grdBoreTargetRings(seen))
  return { items, subs, subs2d, flat: flatGeom, rings }
}

// 统一提交：聚焦选中集（Worker 池）+ 可见性叠加层 + 对星聚焦特效，合并后一次性喂给两个渲染器。
// 三者共用 setSelectionSet / setHighlightLLA / setFocusSatLLA 这些 replace-all 通道，必须一次性喂，
// 否则后喂的会把先喂的整条清掉（此前可见性一激活聚焦星的星下点/轨迹就消失，根因就是这个）。
// ★ 返回 Promise：本拍的聚焦几何是异步算的，调用方（refreshPositions）必须等它 resolve 才算这一拍画完。
let lastGeom = null, geomPending = null
function commitGeometry() {
  if (!scene) return Promise.resolve()
  const vg = vis.open.value ? computeVisibilityGeometry() : { items: [], subs: [] }
  const sf = computeSatcovFocusGeometry()               // 对星覆盖分析的聚焦特效（不在该视图时为空）
  const pr = startFocusGeometry().then((g) => {
    if (!g) return                                       // 被更新的一拍顶掉了：这一份作废，新那次会画
    lastGeom = { g, vg, sf }
    pushGeom()
  })
  geomPending = pr
  return pr
}
// 把已算好的几何喂给两个渲染器（改样式时不必重算几何的那条路已并进 commitGeometry —— 线型/开关会改变顶点本身）
function pushGeom() {
  if (!scene || !lastGeom) return
  const { g, vg, sf } = lastGeom
  // 逐拍现算的少量条目（可见性视线/可见星点、对星聚焦特效）仍走老通道；聚焦选中集走预制顶点通道
  scene.setSelectionSet([...vg.items, ...sf.items])
  scene.setFocusLanes(g.shards, { ringBuild: g.ringBuild })
  scene.setOrbitRingSpin(g.spin || 0)   // 轨道圈：几何只在重建那拍换，平时每拍只设这一个四元数
  applyBeamLimit(g.shards)
  scene.setHighlightLLA(sf.rings)                                   // 聚焦星那批高亮环已在 lanes 里
  scene.setFocusSatLLA([...vg.subs, ...(focusStyle.subOn ? sf.subs : [])])
  if (flat) {
    const f = flatGeomOf(g.shards)                                  // 平面图不在看时 shards 里没打包，这里自然是空的
    flat.setFocusSat([...(focusStyle.subOn ? f.subs : []), ...sf.subs2d])
    flat.setSelGeom(sf.flat && sf.flat.length ? [...f.geom, ...sf.flat] : f.geom)
    flat.setBoreRings(sf.rings.filter((q) => q.bore).map((q) => ({ lat: q.lat, lon: q.lon, color: focusStyle.ringColor, px: focusStyle.ringPx })))
  }
}

// 足迹的纯几何部分（按当前 fpMode 口径）：本页与聚焦几何 Worker 共用 focusFootprint.js 那一份定义。
// ecef=卫星 ECEF(km)，h=轨道高度 km；lim=可选出参，回填 { bMaxDeg, clampText } 供调用方写占位符（仅 beam 模式）。
function footprintAtEcef(ecef, h, lim, seg) {
  return footprintRing(ecef, h, seg, { mode: fpMode.value, beamDeg: parseFloat(beam.value), elevDeg: parseFloat(elevMin.value) }, lim)
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
  if (wizardSolo()) {
    // 「仅预览」：向导开着时地图上只有正在生成的星座 —— 其它可见集一律让路
    renderEntries = customConst.previewEntries()
    renderHasColor = true
    satCount.value = renderEntries.length
    refreshPositions()
    return
  }
  // 地图 = 全部可见卫星集的并集，按 NORAD 去重；同号谁优先：自定义星座 > 导入组 > 搜索结果 > 卫星组 > 内置组。
  // 内置组 / 导入组的「剔除」（satSets.hiddenOf）在这里生效；点序列星【一律留在集里】，
  // 出了采样时段只是这一拍不画（渲染集不随时钟重建，剔出去就再也回不来了）。
  const now = calcAt()
  const out = [], seen = new Set()
  const add = (list, hidden) => {
    for (const e of list) {
      const k = String(e.noradId)
      if (seen.has(k) || (hidden && hidden.has(k))) continue
      if (!isCustomEntry(e) && !keepInRenderSet(e, now)) continue   // 只剔 SGP4 解不出来的；星历星留下，画不画逐拍由 refreshPositions 定
      seen.add(k); out.push(e)
    }
  }
  const vis = satSets.visible.value
  const editId = customConst.previewEditId()
  for (const c of customConst.list.value) if (vis.has('c:' + c.id) && c.id !== editId) add(customConst.satsOf(c.id))
  add(customConst.previewEntries())                                        // 向导「仅预览」关着时：预览叠在别的集之上
  // 天线树定点同步星：不入卫星集注册表（增删改名、显隐都归天线树管），显隐跟树上那颗星的小眼睛走
  add(treeGeoList.filter((e) => { const n = grdNodeOf(e._grdFolder); return !!n && satVisible(n) }))
  const real = []                                                          // 已加载的真实星（GRD 关联星解算 / 搜索池未就绪时的回退）
  for (const g of importGroups.value) {
    const id = 'i:' + g.id; if (!vis.has(id)) continue
    const list = g.kind === 'ephem' ? (ephTables.get(g.id) || []) : (impEntries.get(g.id) || [])
    add(list, satSets.hiddenOf(id)); for (const e of list) real.push(e)
  }
  if (vis.has('q')) add(filterEntries)
  for (const id of vis) if (id[0] === 's') { const c = sgEntries.get(id.slice(2)); if (c) add(c.entries) }
  for (const id of vis) if (id[0] === 'g') { const list = groupEntries.get(id.slice(2)) || []; add(list, satSets.hiddenOf(id)); for (const e of list) real.push(e) }
  entries = real
  entSetVer.value++   // 树上「关联星缺失」重判（见 linkMissSet）；本函数只在挂载后（有 scene）走到这里，声明早已就位
  resolverVer.value++   // 关联星解析换了源：依赖星位的 computed 重算
  renderEntries = out
  renderHasColor = out.some(isCustomEntry) || hasGroupColorOverrides() || satGrpColor.size > 0
  satCount.value = out.length
  dataTime.value = latestDataTime()
  refreshPositions()
  // 跨会话恢复选中（整个选中集，不只主选）：按 satIdOf 定位，哪一集先加载出来就先认领哪些；
  // 不转地球（保留上次的视角）、不重置覆盖圈口径（beam / elevMin 已由 restoreSettings 回填）。
  if (restoreSel) {
    const byId = new Map()
    for (const x of out) byId.set(satIdOf(x), x)
    const have = new Set(selEntries)
    const left = []
    let added = false
    for (const id of restoreSel.ids) {
      const e = byId.get(id)
      if (!e) { left.push(id); continue }
      if (!have.has(e)) { selEntries.push(e); have.add(e); added = true }
    }
    restoreSel.ids = left
    if (added) {
      const p = restoreSel.primary ? byId.get(restoreSel.primary) : null
      if (p && have.has(p)) selEntry = p
      else if (!selEntry || !have.has(selEntry)) selEntry = selEntries[selEntries.length - 1]
      refreshSelection(); _selSysVer = selVer.value   // 恢复出来的选中不是用户动作：波束合成不跟（openFor 已恢复它自己的组）
    }
    if (!left.length) restoreSel = null
  }
}

// 时间推进 / 实时刷新：只重算渲染集位置（不重建集合），并刷新选中几何/信息卡。
// ★ 一次调用 = 一个时刻的【完整】画面：星位、覆盖场、壳层、可见性、晨昏线、指标表全在这里面算完，
//   谁也不许延后到下一帧（延后就是「星在 t、场在 t−Δ」，用户一眼看得出来）。
//   算不过来怎么办？由时钟拉长两拍的间隔（simClockCore.nextDelayMs 的占用底线）—— 整体放慢，
//   而不是让画面里的东西各走各的。
// ★ 别在这里加名为 live 的形参：模块作用域已有 live（=clock.mode==='live' 的 computed），
//   同名形参会把它整个遮住，实时档的锚点跟随就此失效（这个坑踩过一次）。
// ★ async：聚焦几何摊给 Worker 池之后是异步产出的，而「一次时钟回调 = 一个时刻的完整画面」这条铁律
//   要求本拍没画完就不算完 —— 故函数末尾 await 本拍的几何，时钟那边也 await 本函数（见 onTick 处）。
//   期间由 scene.holdFrames 掐住出帧，杜绝「星在 t、轨道在 t−Δ」同框。跟不上就是拍率自然掉，由 achieved 如实读出。
async function refreshPositions() {
  if (!scene) return
  nowStamp.value = Date.now()                                          // 「此刻」红标记参考
  if (live.value) baseTime.value = clock.tMs                           // 实时：锚点随系统时钟滑动（游标恒钉在 0）
  else followCursor()                                                  // 播放推进跑出可见窗口 → 平移尺子接回来
  // 宇宙空间（太阳 / 星空 / 晨昏）随时间轴/实时移动。放在早退之前：一颗星都不显示时照样该走（它只跟时刻有关，与星无关）。
  if (spaceOn.value) applySpace()
  // 地球自转（惯性档）：一拍一次，与本拍星位同一帧上屏（外层 holdFrames 掐着出帧）。
  // ★ 与晨昏线一样放在早退【之前】：星座选「无」时地球照样该转 —— 它只跟时刻有关，与星无关。
  //   本拍的时刻与 GMST 就此定下，正常分支往下复用同一份，不再算第二遍（算两遍＝两个时刻同框的口子）。
  const now = calcAt(), gmst = sat.gstime(now)
  scene.setEarthSpin(gmst)
  // renderEntries 已含可见自定义星座（即使内置组选「无」也可能非空），故只按空判断，不再短路 'none'
  if (!renderEntries.length) {
    scene.setSatellites([]); shownCount.value = 0; _tickEcefN = 0
    if (vis.open.value) vis.recompute()
    commitGeometry()
    feedModels(now, gmst, null)
    if (hasLinkedElev() || vis.open.value) redrawSats()
    // 与正常分支同款带 extras 并接 satcovTick：GRD 关联星按星历解算不依赖在场星（satLivePos 走
    // 全量目录），「无」分组下时间推进照样要修 meta。早先这里无参 tickLive 且不接对星，对星那份
    // meta 停在恢复时的存盘位置——视轴/壳层错位，切分组前怎么播放都修不回来。
    const tk = grd.tickLive([...perfHost.liveKeys(), satcov.active.value || null, ...satcov.selected.value])
    perfHost.onMoved(tk.moved)
    satcovTick(tk.moved)
    perfHost.shellClockTick()
    grdAttTick(grdLiveKeys())   // D9：att 档天线的等效手动指向写回 cfg（节流）
    await geomPending
    return
  }
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)   // 合成星按固定场景历元解算（跨会话稳定）
  const n = renderEntries.length
  const positions = new Array(n)
  let drawn = 0                                                    // 本拍真画出来的颗数：星历星出时段那几拍只有占位，不算在内
  const colors = renderHasColor ? new Float32Array(n * 3) : null   // 有自定义星座时逐点上色（真实星取默认色）
  const sgOn = satGrpColor.size > 0   // 卫星组配色查表开关：没人着色时逐星免掉 String+Map.get
  // 本拍的在场星 ECEF 快照：只在【真有人要】时才存 ——「波束内的星」那个档开着才用得上。
  // ★ 无条件存是笔白账：7000 颗星每拍多 7000 次 ECI→ECEF 旋转 + 一次 168 KB 的写入，
  //   而绝大多数时候那张表根本没开。（这条是本轮改动自己引入的回归，别再无条件做。）
  const wantEcef = perfHost.shellBeamModeOpen()
  if (wantEcef) {
    if (!_tickEcef || _tickEcef.length < n * 3) _tickEcef = new Float64Array(Math.max(1024, n * 3))
    _tickEcefN = n
  } else _tickEcefN = 0
  // 跟随卫星：主星本拍状态先算好，逐星循环里顺手收 500 km 内的邻星（只在跟随时多这一份 ECEF 旋转）
  const fo = followPrep(now, gmst, ccNow, ccGmst)
  for (let k = 0; k < n; k++) {
    const e = renderEntries[k]
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    let pos
    try {
      const pv = posAt(e, t)
      if (pv && pv.position) {
        const gd = sat.eciToGeodetic(pv.position, g); pos = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }
        if (wantEcef) { const ecf = sat.eciToEcf(pv.position, g); _tickEcef[k * 3] = ecf.x; _tickEcef[k * 3 + 1] = ecf.y; _tickEcef[k * 3 + 2] = ecf.z }
        if (fo && pv.velocity) followCandidate(fo, e, pv, g)
        drawn++
      } else { pos = { lat: 0, lon: 0, altKm: -RE }; if (wantEcef) _tickEcef[k * 3] = NaN }   // 占位，保持索引对齐（落到地心不可见）
    } catch { pos = { lat: 0, lon: 0, altKm: -RE }; if (wantEcef) _tickEcef[k * 3] = NaN }
    positions[k] = pos
    if (colors) { const c = (sgOn && satGrpColor.get(String(e.noradId))) || e.color || groupRgb(e.group) || DEFAULT_SAT_RGB; colors[k * 3] = c[0]; colors[k * 3 + 1] = c[1]; colors[k * 3 + 2] = c[2] }
  }
  if (fo) fo.scanned = true   // 邻星已在上面的逐星循环里收齐
  scene.setSatellites(positions, colors)
  shownCount.value = drawn
  if (vis.open.value) vis.recompute()   // 可见性：可见星随时间轴/实时重算（commitGeometry 读取其结果）
  if (selEntry) {
    const c = cardFor(selEntry); if (c) selected.value = c
    buildSelList()
    // 随卫星移动刷新标记仰角：只重推点 / 站两层（航迹不随时间变，不再每拍整组重建；运动档载具由 feedEntities 挪）
    if (points.value.length || stations.value.length) pushMarkerLabels()
  } else if (stElevTracked()) pushMarkerLabels()   // 没有聚焦星时，站标签读指定跟踪星的仰角也要随时间刷新
  commitGeometry()   // 聚焦星几何 + 可见性叠加层合并提交：二者同时呈现、均随时间轴移动（聚焦星星下点/轨迹不再被可见性覆盖）
  feedModels(now, gmst, fo)   // 模型图标 / 跟随视图：与本拍星位同一时刻（落在 holdFrames 闸内）
  if (hasLinkedElev() || vis.open.value) redrawSats()   // 星座关联星仰角线 / 可见性目标点：随时间轴/实时跟踪
  // 星动 → GRD 覆盖随时间轴移动；两张性能指标表与对星壳层也随之重算（取值/几何都依赖星位推出的 basis）
  {
    const tk = grd.tickLive([...perfHost.liveKeys(), satcov.active.value || null, ...satcov.selected.value])
    const mv = tk.moved
    perfHost.onMoved(mv)
    satcovTick(mv)
    perfHost.shellClockTick()   // 对星侧的表与「波束内的星」跟随时钟（与画面同一时刻）
    grdAttTick(grdLiveKeys())   // D9：att 档天线的等效手动指向写回 cfg（节流）
  }
  if (satModal.value && satModal.value.noradId) liveTick.value++   // 关联星编辑中：驱动弹窗经纬度/高度刷新
  persistGrdLive()   // 写实时关联星当前星下点到轻量缓存，供链路预算窗口「导入时取新位置」
  await geomPending   // 本拍的聚焦几何画完，这一拍才算完（时钟据此排下一拍、并如实算实测倍速）
}

// ===================== 数据加载：按卫星集逐集加载，地图 = 可见集并集 =====================
// 内置组：缓存优先即时出图 + 后台静默联网刷新（无网 / 慢网也不卡）；'all' / 'other' 走 17 组并集（loadUniverse）。
// 加载结果只进 groupEntries（不再有「当前分组的 entries」），拼进渲染集的事由 rebuildRenderSet 做。
function buildEntries(sats, group) {
  const out = []
  for (const s of sats) {
    try { const r = sat.omm2satrec(s); if (r && !r.error) out.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || group || '' }) } catch { /* 该星星历坏了：跳过 */ }
  }
  return out
}
function ensureGroup(key) {
  if (!apiOk || !BUILTIN_KEYS.includes(key)) return Promise.resolve()
  if (groupEntries.has(key)) return Promise.resolve()
  if (groupPending.has(key)) return groupPending.get(key)
  const label = GROUP_LABEL[key] || key
  const merged = key === 'all' || key === 'other'
  const pick = (sats) => (key === 'other' ? sats.filter((x) => x._group === 'other') : sats)
  const put = (sats, at) => {
    const list = buildEntries(sats, key)
    groupEntries.set(key, list); groupFetchedAt.set(key, at || '')
    groupCounts.value = { ...groupCounts.value, [key]: list.length }
    rebuildRenderSet(); redrawSats()
    logMsg(`${label}：加载 ${list.length} 颗卫星（星历 ${at ? fmtDate(new Date(at)) : '—'}）`)
  }
  const p = (async () => {
    let shown = false, sig = ''
    try {
      if (merged) { const c = pick(await loadUniverse(true, { cacheOnly: true })); if (c.length) { put(c, universeFetchedAt); shown = true; sig = `${c.length}|${universeFetchedAt || ''}` } }
      else { const c = await fetchGroupLiveOrSup(key, { cacheOnly: true }); if (c && c.sats.length) { put(c.sats, c.fetchedAt); shown = true; sig = `${c.sats.length}|${c.fetchedAt || ''}` } }
    } catch { /* 本机没有这一组：交给下面联网 */ }
    if (!shown) status.value = `加载 ${label} …`
    try {
      let sats = [], at = ''
      if (merged) { sats = pick(await loadUniverse(shown)); at = universeFetchedAt || '' }
      else { const r = await fetchGroupLiveOrSup(key); sats = (r && r.sats) || []; at = (r && r.fetchedAt) || '' }
      if (!sats.length) { status.value = shown ? '' : `${label} 暂无数据`; return }
      // 联网版与已出图那版同源（联网失败回落到同一份本机数据）→ 跳过重建
      if (shown && `${sats.length}|${at}` === sig) { status.value = ''; return }
      put(sats, at); status.value = ''
    } catch (e) { if (!shown) status.value = `${label} 获取失败：${(e && e.message) || '网络不可达'}` }
  })().finally(() => groupPending.delete(key))
  groupPending.set(key, p)
  return p
}
// 卫星组：成员 NORAD → 全量池里的 entries（池就绪前先空着，就绪后 poolTick 变 → 重解）
async function ensureSatGroupEntries(id) {
  const g = satGroups.find(id); if (!g) return []
  const sig = g.sats.map((x) => x.id).join(',') + '|' + poolTick.value
  const c = sgEntries.get(id)
  if (c && c.sig === sig) return c.entries
  if (sgPending.has(id)) return sgPending.get(id)
  const p = (async () => {
    await ensureSearchPool()
    const want = new Set(g.sats.map((x) => String(x.id))), hit = [], seen = new Set()
    for (const en of searchSource()) { const nid = String(en.noradId); if (want.has(nid) && !seen.has(nid)) { seen.add(nid); hit.push(en) } }
    sgEntries.set(id, { sig: g.sats.map((x) => x.id).join(',') + '|' + poolTick.value, entries: hit })
    if (satSets.isVisible('s:' + id)) {
      rebuildRenderSet(); redrawSats()
      const miss = want.size - hit.length
      if (miss > 0) status.value = `${g.name}：显示 ${hit.length} 颗（另有 ${miss} 颗未在当前星历中找到）`
    }
    return hit
  })().finally(() => sgPending.delete(id))
  sgPending.set(id, p)
  return p
}
// 导入组：gp 组读该组的 OMM 记录建 satrec；点序列组读采样表（ephemEntriesOf 自带缓存）
async function ensureImportEntries(id) {
  const g = importGroups.value.find((x) => x.id === id); if (!g) return []
  if (g.kind === 'ephem') { const had = ephTables.has(id); const out = await ephemEntriesOf(id); if (!had && satSets.isVisible('i:' + id)) { rebuildRenderSet(); redrawSats() } return out }
  if (impEntries.has(id)) return impEntries.get(id)
  if (impPending.has(id)) return impPending.get(id)
  const p = (async () => {
    let recs = []
    try { recs = (apiOk && window.api.omm.customGroupRecords) ? ((await window.api.omm.customGroupRecords(id)) || []) : [] } catch { recs = [] }
    const out = buildEntries(recs, 'ci:' + id)
    impEntries.set(id, out)
    if (satSets.isVisible('i:' + id)) { rebuildRenderSet(); redrawSats() }
    return out
  })().finally(() => impPending.delete(id))
  impPending.set(id, p)
  return p
}
// 可见集里还没加载的都去加载（各自加载完自己会重建渲染集）
function ensureSetsLoaded() {
  for (const id of satSets.visible.value) {
    if (id[0] === 'g') ensureGroup(id.slice(2))
    else if (id[0] === 's') ensureSatGroupEntries(id.slice(2))
    else if (id[0] === 'i') ensureImportEntries(id.slice(2))
  }
}
// OMM 读数：可见内置组里最新的一份下载时间
function latestDataTime() {
  let best = ''
  for (const id of satSets.visible.value) { if (id[0] !== 'g') continue; const at = groupFetchedAt.get(id.slice(2)) || ''; if (at > best) best = at }
  return best ? fmtDate(new Date(best)) : ''
}

// 加载「全部在轨」全集并归类：各已知分组并集 ∪ active；返回归类后的卫星数组（_group 为分组或 'other'）
// silent=true：后台构建全量搜索库用，不写主状态栏
// opts.cacheOnly=true：只读本机星历（用户缓存 / 内置快照择新者），一律不联网 —— 供「先出图、后刷新」的第一段用。
//   联网那一版最坏要逐组付 3×30s 主端点 + 2×30s 补充端点（单组封顶两分半），17 组一轮下来能把进软件后的
//   第一屏拖到分钟级；这一档纯读盘，秒级就能交出一份可渲染的全集，联网版随后在后台整体替换
//   （见 ensureGroup / ensureSearchPool）。cacheOnly 时某组本机无数据 → 该组返回 null，跳过不算错。
async function loadUniverse(silent, opts = {}) {
  const cacheOnly = !!opts.cacheOnly
  const fopt = cacheOnly ? { cacheOnly: true } : undefined
  const setS = (t) => { if (!silent) status.value = t }
  const keys = GROUPS.filter((g) => !['all', 'other', 'none', 'custom'].includes(g.key)).map((g) => g.key)
  let done = 0
  setS(`加载全部卫星 0/${keys.length + 1} …`)
  const tick = () => { done++; setS(`加载全部卫星 ${done}/${keys.length + 1} …`) }
  const fetchedAts = []   // 各组实际下载落盘时间 → 合并视图取最新一份作为 OMM 显示时间
  let miss = 0            // 本次一份都没取到的组数（含 active）：>0 表示这份并集是残缺的
  const tasks = keys.map((key) => fetchGroupLiveOrSup(key, fopt)
    .then((p) => { tick(); if (!p) { miss++; return [] }; if (p.fetchedAt) fetchedAts.push(p.fetchedAt); for (const s of p.sats) s._group = key; return p.sats })
    .catch(() => { tick(); miss++; return [] }))
  const arrs = await Promise.all(tasks)
  // 并集（NORAD 去重）+ 分组归类映射
  const groupOf = new Map(), universe = new Map()
  for (const a of arrs) for (const s of a) {
    if (!groupOf.has(s.noradId)) groupOf.set(s.noradId, s._group)
    if (!universe.has(s.noradId)) universe.set(s.noradId, s)
  }
  // 全部在轨（CelesTrak GROUP=active）并入全集；active 被 403/不可达时自动退化为分组并集
  let active = []
  try { const ap = await fetchGroupLiveOrSup('active', fopt); if (ap) { active = ap.sats; if (ap.fetchedAt) fetchedAts.push(ap.fetchedAt) } else miss++ } catch { miss++ }
  tick()
  for (const s of active) if (!universe.has(s.noradId)) universe.set(s.noradId, s)
  // 本地自定义卫星库并入全集（永不联网）：以用户库为准覆盖同号目录星，归入 'custom' 组；保留文件内历元。
  // 这里只并 gp 组（customCsv 本就只吐 gp）：全集是一份 OMM 记录表，点序列星没有根数塞不进来，
  // 它们按导入组各自成集（ensureImportEntries），不进全集。
  try {
    const rawC = await window.api.omm.customCsv()
    const cs = rawC && rawC.text ? parseOMMCsv(rawC.text) : []
    for (const s of cs) { universe.set(s.noradId, s); groupOf.set(s.noradId, 'custom') }
  } catch { /* 无自定义库：忽略 */ }
  // 归类：在已知分组里的标该组，其余标“其他”
  for (const s of universe.values()) s._group = groupOf.get(s.noradId) || 'other'
  // 合并视图的下载时间：取各组最新一份（无则 null → 调用方回退 now）
  universeFetchedAt = fetchedAts.length ? fetchedAts.reduce((a, b) => (b > a ? b : a)) : null
  // —— 供「卫星组按真实星历核对成员」用的两项证据（只有它俩都成立才敢判某颗星离轨，见 satGrpSweep）——
  // 完整：每组与 active 都取到了数据。缺一组 → 那组的星会整批"缺席"，拿这份并集判离轨会误伤一大片。
  // cacheOnly 那一版一律不作数：它只是为了让第一屏立刻有星，整批可能是随包内置的旧快照，
  // 拿它判成员离轨没有意义 —— 判决只认联网那一版（后台跑完会重写这三个变量并触发 satGrpSweep）。
  universeIntact = !cacheOnly && miss === 0 && fetchedAts.length === keys.length + 1
  // 新鲜度按【最旧】一份算，不按最新：某组回落到旧缓存 / 内置快照时，不能拿别组的新时间去判它的星离轨。
  universeFetchedMin = fetchedAts.length ? fetchedAts.reduce((a, b) => (b < a ? b : a)) : null
  return [...universe.values()]
}
let universeFetchedAt = null   // loadUniverse 产出的“各组最新下载时间”，供 loadAll/loadOther 显示
let universeIntact = false     // 本次并集是否一组不缺（见上）
let universeFetchedMin = null  // 本次并集里最旧一份的下载时间（见上）

// ===================== 选择 / 搜索 =====================
// 全量搜索库：独立于当前组的显示集 entries，后台加载一次「全部在轨」并集，使主界面/GRD 搜索
// 不受当前分组（含「无」）限制，全量可搜。失败/未就绪时回退当前组 entries。
let searchPool = []
let poolReady = false, poolLoading = false, poolPromise = null
let filterEntries = []   // 搜索即筛选的显示集（命中星，跨分组，来自全量池）；非空 → renderEntries 渲染它而非当前分组
let filterTimer = null   // 输入即筛选的防抖计时器
const filterN = ref(0)   // 筛选命中数（模板状态提示；0 = 非筛选态）
const filterKw = ref('')   // 当前筛选词（独立于 keyword —— pickResult 会清 keyword 但筛选仍在，状态条据此显示）
// 卫星集「具体是谁」标签：给可见性分析「分析目标」区显式点出正在分析哪些星 —— 口径与 rebuildRenderSet 完全一致：
// 全部可见集的名字。lit＝这个 name 是界面词（内置组名）而不是用户数据；用户起的名字不翻。
const satSetLabel = computed(() => {
  void poolTick.value
  const ids = [...satSets.visible.value]
  const names = ids.map((id) => setName(id)).filter(Boolean)
  if (!names.length) return { kind: '', name: '无', lit: true }
  if (names.length === 1) {
    const k = ids[0][0]
    return { kind: k === 'g' ? '星座' : k === 's' ? '卫星组' : k === 'i' ? '导入星历' : k === 'c' ? '自定义星座' : '搜索', name: names[0], lit: k === 'g' && !satSets.nameOf(ids[0]) }
  }
  return { kind: '混合', name: names.join(' + ') }
})
// 【必须等在建的那一次】：早先「poolLoading 就早退」会让第二个调用方在池子只建了一半时就拿 searchSource()
// 回退到当前组 entries —— 表现是「点了没反应 / 说卫星不在星历中」，跨组的那批星明明在目录里。
async function ensureSearchPool() {
  if (poolReady || !apiOk) return
  if (poolPromise) { await poolPromise; return }
  const p = (async () => {
    poolLoading = true
    try {
      // 第一段：本机星历（用户缓存 / 内置快照）建池 —— 等在这儿的调用方（搜索、加入组、聚焦、
      // 可见性分析取星…）立刻放行，不必陪联网那一轮走完。单独兜错：这一段栽了也绝不能吞掉第二段。
      let ok = false
      try { ok = setSearchPool(await loadUniverse(true, { cacheOnly: true })) } catch { ok = false }
      // 第二段：后台联网刷新。第一段没建起来（本机连内置快照都没有）时必须等它，否则池永远不就绪。
      const online = refreshSearchPool()
      if (!ok) await online
    } catch { /* 离线/失败：回退当前组 */ } finally { poolLoading = false }
  })()
  poolPromise = p
  try { await p } finally { if (poolPromise === p) poolPromise = null }
}
// 用一批 OMM 记录建池并挂上（一颗都建不出来则原样不动）。返回是否建成。
function setSearchPool(sats) {
  const pool = []
  for (const s of sats || []) { try { const r = sat.omm2satrec(s); if (r && !r.error) pool.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || 'other' }) } catch { /* skip */ } }
  if (!pool.length) return false
  // ★ 三份索引一起作废：池不是「建一次就不变」—— ensureSearchPool 先用本机缓存建一版，联网那版回来再换一次。
  //   只清 _poolByNorad 会让 _poolById/_poolByName 一直指着上一版池的条目（指向解算、聚焦特效都走它）。
  searchPool = pool; poolReady = true; _poolByNorad = null; _poolById = null; _poolByName = null; poolTick.value++   // 就绪信号：卫星组行内列表重映射补 GEO 定点标注
  resolverVer.value++   // 关联星解析换了源（见 liveEntryOf）；补一拍与重绘见 onPoolSwapped（watch(poolTick)）
  grpListCache.delete('all'); grpListCache.delete('other')   // 「全部/其他」名录快照由同一份并集来，随池一起作废
  return true
}
// 后台联网重建全量池：拿到新目录才替换。幂等——已在飞的那次直接搭车，不重复跑一轮 17 组。
let poolOnlinePromise = null
function refreshSearchPool() {
  if (poolOnlinePromise) return poolOnlinePromise
  const p = (async () => {
    let sats = []
    try { sats = await loadUniverse(true) } catch { return }   // 静默：不打扰主状态栏
    // 只有联网这一版才敢拿去核对卫星组成员（判离轨）——缓存/内置快照那版 universeIntact 恒为假，
    // 三道闸自己会拦，这里再显式只在联网后调一次。
    if (setSearchPool(sats)) satGrpSweep()
  })().finally(() => { poolOnlinePromise = null })
  poolOnlinePromise = p
  return p
}
// 全量目录（或当前组）+ 自定义星座合成星（含隐藏，见「隐藏也算数」）。自定义星放最前，
// 确保在结果条数上限内一定先被扫到、搜得到；号段 900000+ 与真实目录不撞。
const searchSource = () => {
  const base = poolReady && searchPool.length ? searchPool : entries
  const cc = customConst.catalog()
  const head = treeGeoList.length ? treeGeoList.concat(cc) : cc   // 天线树定点星也搜得到（合成号不与目录撞）
  return head.length ? head.concat(base) : base
}

// 选中集的「非逐拍」信号：只在 refreshSelection / closeCard 里动（selected / selList 每拍整份重建，不能拿来 watch）。
//   selVer = 选中集版本号；selPrimNorad = 主选星 NORAD（字符串，'' = 无主选或主选无号）；selNoradList = 全体选中星的 NORAD。
// 树一侧（高亮 / 展开 / 波束合成跟随 / 信息卡天线节）只从这三个 ref 派生，永不回写选中集 —— 杜绝树↔星座来回触发。
const selVer = ref(0)
const selPrimNorad = ref('')
const selNoradList = shallowRef([])
// 向导预览星（PREVIEW_GROUP，号段 PREVIEW_BASE+i，提交后换号）没有联动身份：不进信号 —— 信息卡「天线」节不出、树不高亮、
// 波束合成不跟，也就没有入口去为它建一颗永远解不出的关联星
const linkIdOf = (e) => (e && e.group !== PREVIEW_GROUP && e.noradId != null && e.noradId !== '' ? String(e.noradId) : '')
function bumpSelSignal() {
  selPrimNorad.value = linkIdOf(selEntry)
  selNoradList.value = selEntries.map(linkIdOf).filter(Boolean)
  selVer.value++
}
// 波束合成跟随主选只认用户动作（闸见 treeLink.createFollowGate，watch(selVer) 里每版都喂）：
//   _selSysVer —— 程序性刷新产生的那一版 selVer（跨会话恢复选中 / 自定义星座重绑 / 向导预览），紧跟在那次 refreshSelection 之后记；
//   _primPickVer —— 用户显式点名主选（点选 / 设为主选）的那一版。
// 声明放在这里而不是 watcher 旁：rebuildRenderSet / 向导预览比那段代码先定义，别踩 TDZ。
let _selSysVer = -1, _primPickVer = -1
// focusTreeSat 防过期：_focusSeq 每次聚焦自增；_userSelTick 只在用户改选（selectSat / setPrimary / removeSel / closeCard /
// 侧栏「聚焦」expFocus / 跟随时换主选 startFollow / 绑模型并入选中集）里自增，
// 程序性刷新（refreshSelection / bumpSelSignal）不动它 —— 启动时陆续到的恢复选中不该作废用户刚点的树节点
let _focusSeq = 0, _userSelTick = 0
function selectSat(e, face, additive) {
  _userSelTick++
  if (additive && selEntries.length) {
    const i = selEntries.indexOf(e)
    if (i >= 0) { selEntries.splice(i, 1); if (selEntry === e) selEntry = selEntries[selEntries.length - 1] || null }   // 再点=移出
    else { selEntries.push(e); selEntry = e }                                                                          // 加入并设为主选
  } else {
    selEntries = [e]; selEntry = e                                                                                     // 裸点选=替换
  }
  if (!selEntry) { closeCard(); return }
  if (!additive) resetBeam()
  refreshSelection()
  if (selEntry === e) _primPickVer = selVer.value   // 点名了主选（裸点选 / Ctrl 加入）；Ctrl 再点移出不算
  if (face && scene) faceEntry(selEntry)
  saveSelection()
}
// 3D 点选的第二路：星座区没显示（所属集关着 / 被剔除 / 不在任何集里）、却被别的功能画在球上的星。
// 点云只装渲染集，这些星看得见点不中。只在点击那一刻由 scene 调用（pickExtraAt），不进逐拍。
// 来源与画它的地方一一对应：聚焦集（commitGeometry）· 可见性结果（computeVisibilityGeometry）·
// 天线树关联星名（redrawSats）· 对星覆盖源星 / 目标星（computeSatcovFocusGeometry）。在渲染集里的交给点云，这里跳过。
function pickExtraSats() {
  const cloud = focusStyle.cloudOn
  const inSet = new Set(), out = []
  if (cloud) for (const e of renderEntries) inSet.add(e.noradId ? 'n:' + e.noradId : 'm:' + e.name)
  const now = calcAt(), ccNow = ccTimeAt(now), gmst = sat.gstime(now), ccGmst = sat.gstime(ccNow)
  const push = (e, lla) => {
    if (!e || (!e.rec && !e.eph)) return
    const k = e.noradId ? 'n:' + e.noradId : 'm:' + e.name
    if (inSet.has(k)) return
    inSet.add(k)
    let p = lla
    if (!p) {
      const cc = isCustomEntry(e)
      try {
        const pv = posAt(e, cc ? ccNow : now)
        if (!pv || !pv.position) return
        const gd = sat.eciToGeodetic(pv.position, cc ? ccGmst : gmst)
        p = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }
      } catch { return }
    }
    out.push({ lat: p.lat, lon: p.lon, altKm: p.altKm, ref: e })
  }
  for (const e of selEntries) push(e)
  if (vis.open.value && vis.mode.value !== 'coverage' && vis.results.value.length) {
    const src = vis.satSrc.value ? visSatCache : renderEntries
    const byId = new Map()
    for (const e of src) byId.set(String(e.noradId), e)
    for (const r of vis.results.value) if (Number.isFinite(r.subLat)) push(byId.get(String(r.noradId)) || satEntryById('n:' + r.noradId), { lat: r.subLat, lon: r.subLon, altKm: r.altKm })
  }
  for (const node of grdSats.value) {
    if (!node.noradId || node.kind === 'elevline') continue
    const cov = satcov.selected.value.length && satVisible(node) && (node.antennas || []).some((a) => satcov.selected.value.includes(grd.keyOf(node.folder, a.name)))
    if (node.labelShow !== false || cov) push(liveEntryOf(node.noradId))
    if (!cov) continue
    for (const a of node.antennas || []) {
      const k = grd.keyOf(node.folder, a.name)
      if (!satcov.selected.value.includes(k)) continue
      const st = (grd.getPerfContext(k) || {}).settings
      if (st && (st.boreType === 'sat' || st.boreType === 'satoff')) push(satEntryById(st.boreSat))
    }
  }
  // 天线指向的目标星（覆盖图选中 / 当前天线，画的是 grdBoreTargetRings 那圈金环）：同一份口径
  for (const k of new Set([...grd.selected.value, grd.active.value, satcov.active.value].filter(Boolean))) {
    const st = (grd.getPerfContext(k) || {}).settings
    if (!st || (st.boreType !== 'sat' && st.boreType !== 'satoff') || !st.boreSat) continue
    const node = grdNodeOf(k.split('|')[0])
    if (node && !satVisible(node)) continue
    const te = satEntryById(st.boreSat)
    const P = te ? null : satTargetEcef(st.boreSat)
    if (te) push(te)
    else if (P) { const g = W.ecefToGeodetic(P[0], P[1], P[2]); const e = liveEntryOf(String(st.boreSat).replace(/^n:/, '')); if (e) push(e, { lat: g.lat, lon: g.lon, altKm: g.h }) }
  }
  return out
}
// 刷新主选卡片 + 全体几何 + 多选列表 + 标记 + 2D 聚焦
function refreshSelection() {
  if (following.value && selEntry !== followEntry) stopFollow()   // 主选换了：跟随目标就没了（不自动改跟新主选）
  const c = cardFor(selEntry); if (c) selected.value = c
  buildSelList()
  pushMarkers()
  commitGeometry()   // 选中星几何 + 星下点（含可见性叠加层，若开）合并提交
  refreshSelModel(); feedModelsNow()
  bumpSelSignal()    // 树联动信号（见 selVer）
}
// 旋转地球使某星正对视图
function faceEntry(e) {
  const now = isCustomEntry(e) ? ccTimeAt() : calcAt(), gmst = sat.gstime(now)   // 合成星按场景历元定位朝向
  const pv = posAt(e, now)
  if (!pv || !pv.position) return
  const gd = sat.eciToGeodetic(pv.position, gmst)
  const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude)
  const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180
  scene.faceTo({ x: -Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) })
}
// 卡片 mini-row：设为主选 / 移出
function setPrimary(row) { const e = selEntries[row.idx]; if (!e || e === selEntry) return; _userSelTick++; selEntry = e; refreshSelection(); _primPickVer = selVer.value; saveSelection() }
function removeSel(row) {
  const e = selEntries[row.idx]; if (!e) return
  _userSelTick++
  selEntries.splice(row.idx, 1)
  if (selEntry === e) selEntry = selEntries[selEntries.length - 1] || null
  if (!selEntry) { closeCard(); return }
  refreshSelection(); saveSelection()
}
// 编辑星座实时预览/提交/取消后：把仍指向旧对象的选中项按名字重绑到 renderEntries 里的新对象（覆盖/星下点/轨迹/卡片随之同步）
function rebindSelection(preferGroup) {
  if (!selEntries.length) return
  let changed = false, dropped = false
  const next = []
  for (const e of selEntries) {
    if (!e.group || e.group.indexOf('cc') !== 0) { next.push(e); continue }   // 只重绑自定义星座/预览星
    if (renderEntries.includes(e)) { next.push(e); continue }                  // 对象仍在场=无需重绑
    const m = renderEntries.find((x) => x.group === preferGroup && x.name === e.name)
           || renderEntries.find((x) => x.group && x.group.indexOf('cc') === 0 && x.name === e.name)
    if (m) { if (selEntry === e) selEntry = m; next.push(m); changed = true }
    else { dropped = true; if (selEntry === e) selEntry = null }               // 该槽位已不存在
  }
  selEntries = next
  if (!selEntries.length) { closeCard(); return }
  if (!selEntry || !selEntries.includes(selEntry)) selEntry = selEntries[selEntries.length - 1]
  // 掉了星（选中集变了 / 主选可能换了）也要刷：selPrimNorad / selNoradList 只在 refreshSelection 里跟，
  // 不刷就还指着掉了的那颗 —— 信息卡「天线」节与「＋」、树上高亮都在对着一颗已经不在选中集里的星
  if (changed || dropped) { refreshSelection(); _selSysVer = selVer.value }
}

function onSearch(e) {
  keyword.value = e.target.value
  const kw = keyword.value.trim().toLowerCase()
  if (filterTimer) clearTimeout(filterTimer)
  filterTimer = setTimeout(() => applyFilter(kw), 250)   // 输入即筛选显示（防抖 250ms；空词恢复分组）
  if (!kw) { searchResults.value = []; return }
  ensureSearchPool()   // 懒加载全量搜索库（幂等）
  const src = searchSource(), out = []
  for (let i = 0; i < src.length && out.length < 40; i++) {
    const en = src[i]
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw) || (en.groupLabel && en.groupLabel.toLowerCase().includes(kw))) {   // 自定义星座另按星座名(groupLabel)命中→列出全部成员
      // GEO 星逐颗标注定点经度（严区制判定，跨分组一律有效；非 GEO 为空串）
      out.push({ en, name: en.name, noradId: en.noradId, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || '', slot: geoSlotOfSatrec(en.rec) })
    }
  }
  searchResults.value = out
}
function clearSearch() {
  keyword.value = ''; searchResults.value = []
  if (filterTimer) { clearTimeout(filterTimer); filterTimer = null }
  if (!filterEntries.length && !filterN.value) return
  filterEntries = []; filterN.value = 0; filterKw.value = ''
  expDrop('q')
  if (satSets.solo.value && satSets.solo.value.id === 'q') satSets.restore((id) => id !== 'q')   // 仅显示的是搜索结果 → 还原之前的可见集合
  else { const v = new Set(satSets.visible.value); v.delete('q'); satSets.setVisible([...v]) }
  applySetsChanged()
}
// 搜索 / 查找的命中 → 「搜索结果」集：出现即「仅显示」它（顶部标签一点就还原叠加，状态显式）；label 给读数用
function showSearchHits(hit, label) {
  filterEntries = hit; filterN.value = hit.length; filterKw.value = String(label || '').trim()
  if (!(satSets.solo.value && satSets.solo.value.id === 'q')) satSets.soloOn('q')
  applySetsChanged()
}
// 搜索框即筛选：命中星（全量池，跨分组）成为「搜索结果」集；空词 = 清掉它。属性条件走「查找卫星」对话框（openFinder）。
async function applyFilter(kw) {
  const raw = String(kw == null ? filterKw.value : kw).trim()
  const k = raw.toLowerCase()
  if (!k) { clearSearch(); return }
  await ensureSearchPool()
  const hit = [], seen = new Set()
  for (const en of searchSource()) {
    if (!(en.name.toLowerCase().includes(k) || String(en.noradId).includes(k) || (en.groupLabel && en.groupLabel.toLowerCase().includes(k)))) continue
    const nid = String(en.noradId); if (seen.has(nid)) continue
    seen.add(nid); hit.push(en)
  }
  showSearchHits(hit, raw)
}
/* ===================== 搜索筛选条（SATCAT 过滤器） ===================== */
// 筛选状态存 localStorage：关掉软件再开，上次筛的那一组还在（与搜索关键词不同，筛选是「设定」不是「一次性动作」）
const SATFILTER_KEY = 'constellation3d/searchFilters'
const satFilters = reactive(emptyFilters())
const satcatIdx = shallowRef(null)     // Map(NORAD -> 编目行) 或 null
// searchPool 是普通变量（不是 ref），直接当 prop 传不会随池就绪重渲染 —— 靠 poolTick 兜一层
const satPoolForFilter = computed(() => { void poolTick.value; return searchPool })
try {
  const saved = JSON.parse(localStorage.getItem(SATFILTER_KEY) || 'null')
  if (saved) Object.assign(satFilters, normalizeFilters(saved))
} catch { /* 坏存档：就当没筛过 */ }
function onSatFilterChange(next) {
  Object.assign(satFilters, normalizeFilters(next))
  try { localStorage.setItem(SATFILTER_KEY, JSON.stringify(satFilters)) } catch { /* 存不下不影响用 */ }
}
// 编目索引按需取一次（只读本机缓存、绝不联网）；取不到就 null，筛选条把编目四项禁用
async function ensureSatcatIndex() {
  if (satcatIdx.value) return satcatIdx.value
  const idx = await loadSatcatIndex()
  satcatIdx.value = idx
  return idx
}
function pickResult(item) { searchResults.value = []; keyword.value = ''; selectSat(item.en, true) }
function closeCard() { _userSelTick++; stopFollow(); selEntries = []; selEntry = null; selected.value = null; selList.value = []; resetBeam(); pushMarkers(); commitGeometry(); saveSelection(); refreshSelModel(); feedModelsNow(); bumpSelSignal() }   // commitGeometry 清聚焦星几何/星下点；可见性叠加层（若开）保留

// ===================== 卫星 3D 模型：球面图标 / 跟随卫星 / 绑定（设计契约 §6.3）=====================
// 数据三路：
//   · 模型库 = 主进程 manifest（内置 < 远端 < 本机三层合并，带本机缓存状态）+ 参数化模板目录（运行时生成、不占文件）
//   · 绑定表 = userData/models.bindings.json（逐星：模型 自动 / 无 / 指定；二期的挂点 / 姿态律也在里面）
//   · 自动匹配 = autoMatch.match（名称 / NORAD / 轨道类别 → 模型 id），按 satKey 缓存，库或绑定一变整份作废
// 每拍（refreshPositions 尾，复用本拍 now / gmst，不做帧间插值）：聚焦星 → 图标（锚点 llaToVec 大地版、LVLH 按真 ECEF 的 r / v），
// 跟随中另给主星 + 500 km 内最近 ≤ 16 颗。太阳方向取 terminator.solarGeometry 的日下点，地影因子取 attitude.eclipseFactor。
const modelsApi = (typeof window !== 'undefined' && window.api && window.api.models) || null
let modelLayer = null
let offModelsChanged = null
const modelLib = shallowRef({ list: [], byId: new Map(), prefs: null })
let modelBinds = { prefs: null, bindings: {} }
const modelMatchCache = new Map()        // satKey → { id, rule }
const following = ref('')                // 正在跟随的星的 satKey（'' = 没在跟随）；只跟随主选星
let followEntry = null
const selModel = shallowRef(null)        // 主选星的模型信息（信息卡「模型」块 / 卫星模型侧栏）
const selSat = shallowRef(null)          // 主选星 { key, name }（侧栏「当前卫星」；selEntry 不是响应式的）

function modelNameOf(m) { return m ? byLang(m.titleZh || m.title || m.id, m.title || m.titleZh || m.id) : '' }
// 参数化模板目录 → 与 manifest 条目同形的精简条目（库网格 / 名称 / 自动匹配可用集）
const PARAM_CATALOG = (() => {
  try {
    return templateCatalog().map((t) => ({
      id: t.id, title: t.title, titleZh: t.titleZh, kind: t.kind || 'spacecraft', fidelity: 'parametric', origin: 'builtin',
      source: t.source || { kind: 'param', credit: '', license: '', redistributable: true }, tags: t.tags || [], aliases: t.aliases || [],
      units: { scaleToMeters: 1, sizeVerified: true }, geometry: t.geometry || null, massProps: t.massProps || null
    }))
  } catch { return [] }
})()
// 实体模板目录（地球站 / 飞机 / 船 / 车，ent:<id>，运行时 buildAssembly 现生成、没有文件）→ 同形条目：
// 挂到标记实体上用（侧栏「模型」小块 / 拖放）；自动匹配不收它（modelOf 的可用集把 ent: 排除，实体模板永不自动绑给卫星）
const ENT_CATALOG = (() => {
  try {
    return entityTemplateCatalog().map((t) => ({ ...t, origin: 'builtin', fidelity: 'parametric', units: { scaleToMeters: 1, sizeVerified: true }, geometry: null, massProps: null }))
  } catch { return [] }
})()
// 星座精模目录（fleet/，param:<型号>，运行时现生成、不占文件）→ 同形条目：星链 / 一网 / GPS / 北斗等星的自动匹配落在这里，库网格与名称也认它
const FLEET_CATALOG = (() => {
  try {
    return fleetCatalog().map((t) => ({
      id: t.id, title: t.title, titleZh: t.titleZh, kind: 'spacecraft', fidelity: 'parametric', origin: 'builtin',
      source: t.source, tags: t.tags, aliases: t.aliases, units: { scaleToMeters: 1, sizeVerified: true }, geometry: null, massProps: null
    }))
  } catch { return [] }
})()
async function loadModelLib() {
  if (!modelsApi) { const l0 = [...PARAM_CATALOG, ...FLEET_CATALOG, ...ENT_CATALOG]; modelLib.value = { list: l0, byId: new Map(l0.map((m) => [m.id, m])), prefs: null }; return }
  let r = null
  try { r = await modelsApi.manifest() } catch { r = null }
  const list = (r && Array.isArray(r.models)) ? r.models.slice() : []
  const have = new Set(list.map((m) => m.id))
  for (const p of PARAM_CATALOG) if (!have.has(p.id)) { list.push(p); have.add(p.id) }
  for (const p of [...FLEET_CATALOG, ...ENT_CATALOG]) if (!have.has(p.id)) { list.push(p); have.add(p.id) }
  modelLib.value = { list, byId: new Map(list.map((m) => [m.id, m])), prefs: (r && r.prefs) || null }
  modelMatchCache.clear()
  refreshSelModel(); feedModelsNow()
}
// 绑定表的唯一缓存在 bodyRt（src/viz/models/bodyRuntime.js，建在「卫星本体（二期）」那节）：它自己订 models:changed 的 bindings
// 广播重载，本页的 modelBinds 只是它的镜像（模型匹配 / 信息卡用）。二期的姿态律 / 挂点也从它取（图标与跟随的姿态、
// GRD「姿态 + 挂点」、对星时段扫描），绑定一变就在 onBodyRtChange 里把这几处一起刷新。
function loadModelBindings() { return bodyRt.reload() }
let _bodyRtT = 0
function onBodyRtChange(e) {
  if (!e) return
  if (e.type === 'bindings') {
    const b = bodyRt.bindingsAll()
    modelBinds = { prefs: b.prefs || null, bindings: b.bindings || {} }
    modelMatchCache.clear()
    _attBucket = -1; _attMap = new Map(); _bodyKeyCache.clear()
    refreshSelModel(); feedModelsNow()
  } else return   // 掩模事件：本页不查掩模（遮挡只在模型工作台里算 / 看），不必重画
  // 绑定到齐（启动时 grd.restoreState 往往早于绑定经 IPC 到达，那一刻「姿态 + 挂点」按天底投了影）：补一拍完整画面，
  // GRD 投影签名里带着姿态轴，变了自动重投；连续几次绑定广播合成一拍，再补一拍 D9 等效指向（停表时没有下一拍）
  clearTimeout(_bodyRtT)
  _bodyRtT = setTimeout(() => { if (scene) refreshPositions(); grdAttKick() }, 60)
}
bodyRt.onChange(onBodyRtChange)
let _libT = 0
function onModelsChanged(e) {
  if (!e) return
  if (e.type === 'bindings') return   // bodyRt 自己重载，重载完经 onBodyRtChange 回来
  if (e.type === 'download' && e.phase !== 'ready' && e.phase !== 'error') return   // 进度事件由侧栏自己接
  // 工作台存了元数据（本体轴 / 缩放 / 关节…）或清单变了（导入 / 移除 / 远端更新）：模型层丢掉元数据缓存，
  // 挂架项真变了的图标 / 跟随实例原位重挂（信息卡读数随下面的库重载一起刷新，两边对得上）
  if (modelLayer && e.type === 'meta') modelLayer.refreshModel(e.id || null)
  else if (modelLayer && e.type === 'manifest') modelLayer.refreshModel(null)
  if (entityLayer && (e.type === 'meta' || e.type === 'manifest')) entityLayer.refreshModel(e.type === 'meta' ? (e.id || null) : null)
  if (entSprites && (e.type === 'meta' || e.type === 'manifest')) entSprites.refreshModel(e.type === 'meta' ? (e.id || null) : null)   // 平面图俯视图同步换
  clearTimeout(_libT)
  _libT = setTimeout(loadModelLib, 250)
}
// 轨道区制（与 cardFor 同一份算式，不传播）：自动匹配用它认「GEO 通信星」
function orbitKindOf(e) {
  const g = metricsFromEntry(e) || {}
  const periodMin = g.periodMin != null ? g.periodMin : null
  const apoKm = g.apogeeKm != null ? g.apogeeKm : null, perKm = g.perigeeKm != null ? g.perigeeKm : null
  const meanKm = (apoKm != null && perKm != null) ? (apoKm + perKm) / 2 : null
  return (periodMin != null || meanKm != null)
    ? classifyOrbit({ aKm: meanKm != null ? RE + meanKm : null, e: g.ecc, inclDeg: g.incl, perigeeAltKm: perKm, apogeeAltKm: apoKm, periodMin })
    : ''
}
// 一颗星用哪个模型：{ id|null, auto, bound, frame }（bound：绑定表里写的 'auto' / null / id；没绑定为 'auto'）。
// frame：绑定表逐星的模型轴覆盖（model.frameOverride {q,t}）—— DESIGN §3.4，没写为 null。
// 图标大小不逐星：卫星模型一律跟全局「图标大小」focusStyle.modelPx（2026-09-25 用户定；老绑定里的 model.iconPx 不再读）
function modelOf(e) {
  const key = satKeyOf(e)
  if (!key) return { key: null, id: null, auto: true, bound: 'auto', frame: null }
  const b = modelBinds.bindings && modelBinds.bindings[key]
  const bm = b && b.model
  const bound = bm ? bm.id : 'auto'
  const frame = bm && bm.frameOverride && Array.isArray(bm.frameOverride.q) ? bm.frameOverride : null
  if (bound === null) return { key, id: null, auto: false, bound: null, frame }
  if (bound && bound !== 'auto') return { key, id: bound, auto: false, bound, frame }
  let hit = modelMatchCache.get(key)
  if (!hit) {
    const lib = modelLib.value
    hit = matchModel({ name: e.name, noradId: e.noradId, orbitKind: orbitKindOf(e), group: e.group },
      { available: autoAvailable(lib), prefs: modelBinds.prefs || lib.prefs || undefined })
    modelMatchCache.set(key, hit)
  }
  return { key, id: hit.id || null, auto: true, bound: 'auto', frame }
}
// 自动匹配的可用集：库里除实体模板（ent:）以外的全部 id；随库重载缓存一份（逐星匹配不再逐次建 Set）
let _autoAvailLib = null, _autoAvail = null
function autoAvailable(lib) {
  if (!lib.list.length) return null
  if (_autoAvailLib !== lib) {
    _autoAvailLib = lib; _autoAvail = new Set()
    for (const k of lib.byId.keys()) if (!String(k).startsWith('ent:')) _autoAvail.add(k)
  }
  return _autoAvail
}
// 模型层取不到主进程元数据时的兜底：库里的精简条目
function modelMetaOf(id) { return modelLib.value.byId.get(id) || null }
const fmtDim = (v) => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2))
// 参数化模板没有文件、库条目里也没有包围盒 / 质量：按模板生成一次（默认卫星模板冷启动 ~25 ms）取读数，按 id 缓存。
// 出参与库条目同口径（轴映射终案 ④）：paramBus 按本体系量的 bboxBody 经 frame 逆变换成【模型轴、米】的 bboxM，frame 原样带上
// —— 读数一律走 bodyDimsOf 的「模型轴 → 本体系」一条路，逐星 frameOverride 对模板也生效
const paramInfo = new Map()
function paramInfoOf(id) {
  if (!id || !id.startsWith('param:')) return null
  if (paramInfo.has(id)) return paramInfo.get(id)
  let v = null
  try {
    const r = isFleetId(id) ? buildFleetModel(id) : buildTemplateModel(id.slice(6))
    const bb = bodyBoxToModelBox(r.bboxBody, r.frame)
    if (bb) v = { geometry: { bboxM: bb }, massProps: r.massProps, units: { scaleToMeters: 1, sizeVerified: true }, frame: { ...r.frame, verified: true } }
  } catch { v = null }
  paramInfo.set(id, v)
  return v
}
// 包围盒八个角点逐个换系再取外包（轴向是 90° 倍数时精确；抹掉 1e-15 级舍入与 −0，同 wbLogic.boxCorners）。
// 反方向（模型轴 → 本体系）这里自己做，不用 wbLogic.bodyBoxOfMeta：缺 q 时要按来源兜底（defaultImportQ）、逐星 frameOverride 优先
function mapBox(bb, fn) {
  if (!bb || !Array.isArray(bb.min) || !Array.isArray(bb.max)) return null
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < 8; i++) {
    const p = fn([i & 1 ? bb.max[0] : bb.min[0], i & 2 ? bb.max[1] : bb.min[1], i & 4 ? bb.max[2] : bb.min[2]])
    if (!p) continue
    for (let k = 0; k < 3; k++) { if (p[k] < mn[k]) mn[k] = p[k]; if (p[k] > mx[k]) mx[k] = p[k] }
  }
  if (!Number.isFinite(mn[0])) return null
  const cl = (x) => { const r = Math.round(x * 1e9) / 1e9; return Math.abs(r - x) < 1e-12 ? (r === 0 ? 0 : r) : x }
  return { min: mn.map(cl), max: mx.map(cl) }
}
// 包围盒读数「本体系 X × Y × Z」（米）：
//   · geometry.bboxM 已经是米 —— 离线管线（scripts/nasa3d/build composeMeta）与主进程导入都在写入时乘过 scaleToMeters，这里不许再乘
//     （再乘一次 HST 成了 0.30 m、TERRA 成了 1 cm）；
//   · 轴向一律是【模型轴】（轴映射终案 ④：离线管线、主进程导入、工作台「保存到库」的参数化星 param:<specHash>、
//     内置模板条目、paramInfoOf 现生成的模板都是）—— 按 frame.q_model2body（逐星覆盖优先，缺省按来源）把八个角点转到本体系
//     再取外包盒；STK 映射下模型 (x, y, z) 是本体 (Y, Z, X)，不转就把 ISS 的 73.4 × 30.6 × 108.3 当成了 X × Y × Z。
// 来源口径（同 schema.normalizeMeta）：缺 kind 按 id 前缀补；stk: 前缀一律 stk-local；builtin 按前缀还原成 nasa / param
const SRC_BY_PREFIX = { nasa: 'nasa', param: 'param', user: 'user', stk: 'stk-local', community: 'community' }
function srcKindOf(m) {
  const pre = String((m && m.id) || '').split(':')[0]
  let k = (m && m.source && m.source.kind) || ''
  if (!k) k = SRC_BY_PREFIX[pre] || ''
  if (pre === 'stk') k = 'stk-local'
  if (k === 'builtin' && (pre === 'nasa' || pre === 'param')) k = pre
  return k
}
function bodyBoxOf(m, frameOv) {
  const bb = m && m.geometry && m.geometry.bboxM
  if (!bb || !Array.isArray(bb.min) || !Array.isArray(bb.max)) return null
  const f = m.frame || {}
  // 元数据缺 q 时的兜底按来源（轴映射终案 ②，bodyFrame.defaultImportQ；与主进程 schema.normalizeMeta 的兜底同口径：
  // builtin 按 id 前缀还原成 nasa / param，「带 AGI」= 关节 / 电池片组 / 不遮挡节点 / 挂点任一非空）
  const q = quatNormalize(frameOv && Array.isArray(frameOv.q) ? frameOv.q : (Array.isArray(f.q_model2body) ? f.q_model2body : defaultImportQ({
    sourceKind: srcKindOf(m),
    hasAgi: ['articulations', 'solarPanelGroups', 'noObscurationNodes', 'attachPoints'].some((k) => Array.isArray(m[k]) && m[k].length > 0),
    satsimFrame: null
  })))
  // 尺寸只看轴向：平移 t 对外包盒的边长无影响，这里不加
  return q ? mapBox(bb, (p) => modelToBody(p, q)) : null
}
function bodyDimsOf(m, frameOv) {
  const b = bodyBoxOf(m, frameOv)
  return b ? [0, 1, 2].map((k) => fmtDim(Math.abs(b.max[k] - b.min[k]))).join(' × ') : ''
}
function refreshSelModel() {
  const e = selEntry
  if (!e) { selModel.value = null; selSat.value = null; return }
  const mo = modelOf(e)
  selSat.value = { key: mo.key, name: e.name }
  const m0 = mo.id ? modelLib.value.byId.get(mo.id) || null : null
  const pi = m0 && !m0.geometry ? paramInfoOf(mo.id) : null
  const m = pi ? { ...m0, ...pi } : m0
  const dims = m ? bodyDimsOf(m, mo.frame) : ''
  const mp = m && m.massProps
  selModel.value = {
    id: mo.id, auto: mo.auto, bound: mo.bound, key: mo.key,
    name: mo.id ? (m ? modelNameOf(m) : mo.id) : '',
    title: m ? [m.title, m.titleZh].filter(Boolean).join(' / ') : '',
    fidelity: m ? m.fidelity : '', meta: m,
    sizeVerified: !!(m && m.units && m.units.sizeVerified), frameVerified: !!(m && m.frame && m.frame.verified),
    dims, mass: mp && Number(mp.massKg) > 0 ? Math.round(mp.massKg).toLocaleString('en-US') : '',
    // 二期：绑定里的姿态律与挂点（侧栏「当前卫星」读数；编辑走工作台卫星页）
    law: mo.key ? bodyRt.attitudeFor(mo.key).law : 'nadir',
    mounts: mo.key ? bodyRt.mountsFor(mo.key).length : 0,
    masks: mo.key ? bodyRt.mountsFor(mo.key).filter((x) => bodyRt.hasMask(x)).length : 0
  }
}
// 绑定写回：与已有绑定合并（二期的挂点 / 姿态律 / 质量特性不被这次改模型冲掉）；出 IPC 前现造纯数据。
// entry：显式给一颗星（拖放到卫星上，DESIGN3 E11）；缺省 = 主选星（侧栏 @bind 只传 id，行为不变）。
// 显式给的星不在聚焦集里 → 绑成功后加入聚焦集、不改主选（聚焦集为空时它同时当主选）——模型图标只画聚焦星，不加进来绑了也看不见
async function bindModel(id, entry) {
  const e = entry || selEntry
  if (!e || !modelsApi) return false
  const key = satKeyOf(e)
  if (!key) return false
  const old = (modelBinds.bindings && modelBinds.bindings[key]) || {}
  const b = JSON.parse(JSON.stringify({ ...old, model: { ...(old.model || {}), id }, mounts: old.mounts || [], attitude: old.attitude || { law: 'nadir', params: {} } }))
  try {
    const r = await modelsApi.bindingsSet({ satKey: key, binding: b })
    if (!(r && r.ok)) return false
    bodyRt.patchLocal(key, b)   // → onBodyRtChange：镜像、匹配缓存、信息卡、图标一起刷新
    if (entry && !selEntries.includes(entry)) {
      _userSelTick++
      selEntries.push(entry)
      const named = !selEntry
      if (named) selEntry = entry
      refreshSelection()
      if (named) _primPickVer = selVer.value   // 聚焦集原本为空：拖上去的这颗就是用户点名的主选（同 selectSat）
      saveSelection()
    }
    return true
  } catch { return false /* 未激活 / 主进程拒写：保持原绑定 */ }
}
function openModelWorkbench(o) {
  const p = o || {}
  try {
    if (!modelsApi || !modelsApi.open) return
    const tab = p.tab || (p.modelId ? 'model' : 'lib')   // 'sat'：卫星页（姿态律 / 挂点，二期），带 satKey 打开那颗星
    const r = modelsApi.open(JSON.parse(JSON.stringify({ tab, modelId: p.modelId || undefined, satKey: p.satKey || undefined })))
    if (r && r.catch) r.catch(() => {})   // 未激活：主进程回 {locked:true}（全局遮罩另行提示），这里静默
  } catch { /* ignore */ }
}
function setModelStyle(k, v) { focusStyle[k] = v; applyModelStyle() }
function resetModelStyle() { for (const f of FOCUS_PARTS.model) focusStyle[f] = FOCUS_STYLE_DEF[f]; applyModelStyle() }
function applyModelStyle() {
  if (!modelLayer) return
  modelLayer.setIconStyle({ on: focusStyle.modelOn, px: focusStyle.modelPx })
  modelLayer.setHud({ bodyAxes: focusStyle.hudAxes, lvlh: focusStyle.hudLvlh, nadir: focusStyle.hudNadir, velocity: focusStyle.hudVel, sun: focusStyle.hudSun, isl: focusStyle.hudIsl, es: focusStyle.hudEs, mounts: focusStyle.hudMounts })
  feedModelsNow()
  // 标记实体共用「显示」拨杆（大小不共用：标记的模型跟标记自己的图标大小，见 entIconPxOf）：
  // 开关一动，标签让位（载荷 iconPx）与平面图俯视图（m2d）随之重推；没有任何实体挂模型时载荷不变，不必推
  if (hasEntityModels()) pushMarkers()
}

// —— 每拍几何 ——
// 一颗星此刻的状态（算式在 modelLayer.satStateAt：锚点 llaToVec 大地版、LVLH 按真 ECEF r / 惯性速度、地影因子）
function satModelState(e, now, gmst, ccNow, ccGmst, sunE) {
  const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
  let pv = null
  try { pv = posAt(e, t) } catch { pv = null }
  return satStateAt(pv, g, sunE)
}
// 本体 → L（modelLayer 的 qB2L）：按绑定的姿态律（DESIGN2 §4 第一条）。没绑定 / 纯 nadir 直接给常量（与解算结果差 1e-16，
// 省一次解算）；太阳按场景时刻 tMs（与画面晨昏线同源）。st = satStateAt 的结果（rE / vE 已是 ECEF 轴向的真位置 / 惯性速度）
const _qbBasis = makeBasis()
function bodyQB2L(key, st, tMs) {
  if (!key || !st || bodyRt.isPlainNadir(key)) return Q_BODY2L_NADIR
  const b = bodyRt.attitudeBasisAt(key, { rEcef: st.rE, vInertialEcef: st.vE, tMs }, _qbBasis)
  return b ? qB2LFromBasis(b, st.qL2S) : Q_BODY2L_NADIR
}
// 挂点的视场全锥角（度）：挂点自己写了 fovDeg 就用它；参数化天线按 −3 dB 波束宽（hpbwDeg，或 70λ/D 估）；GRD / 标量天线不画锥（0）
function mountFovDeg(m) {
  if (Number(m.fovDeg) > 0) return Number(m.fovDeg)
  const r = m.antennaRef
  if (r && r.kind === 'param' && r.spec) {
    if (Number(r.spec.hpbwDeg) > 0) return Number(r.spec.hpbwDeg)
    const D = Number(r.spec.diameterM), f = Number(r.spec.freqGHz)
    if (D > 0 && f > 0) return 70 * (0.299792458 / f) / D
  }
  return 0
}
// HUD「挂点」：主星绑定里的挂点（本体系）。按绑定版本缓存同一个数组（HUD 按引用判「没变」）
let _hudMounts = { key: '', ver: -1, list: null }
function hudMountsOf(key) {
  if (!key) return null
  const ver = bodyRt.version()
  if (_hudMounts.key === key && _hudMounts.ver === ver) return _hudMounts.list
  const ms = bodyRt.mountsFor(key)
  const list = ms.length ? ms.map((m) => ({ name: m.name || m.id, posBody: m.posBody, dir: m.boresightBody, fovDeg: mountFovDeg(m) })) : null
  _hudMounts = { key, ver, list }
  return list
}
// 跟随中本拍要的东西：主星状态 + 候选邻星（refreshPositions 的逐星循环里顺手收，见那边）
function followPrep(now, gmst, ccNow, ccGmst) {
  if (!following.value || !followEntry || !modelLayer) return null
  const sn = sunStateAt(now)
  const st = satModelState(followEntry, now, gmst, ccNow, ccGmst, sn.sunE)
  if (!st) return null
  return { st, sn, cand: [], scanned: false, tMs: now.getTime(), now, gmst, ccNow, ccGmst }
}
function followCandidate(fo, e, pv, g) {
  if (e === followEntry) return
  const r = sat.eciToEcf(pv.position, g)
  const dx = r.x - fo.st.rE[0], dy = r.y - fo.st.rE[1], dz = r.z - fo.st.rE[2]
  const d2 = dx * dx + dy * dy + dz * dz
  if (d2 > NEIGHBOR_KM.max * NEIGHBOR_KM.max || d2 < NEIGHBOR_KM.min * NEIGHBOR_KM.min) return   // 500 km 外 / 1 km 内（对接件）不算邻星
  fo.cand.push({ e, pv, g, d2 })
}
// 拍外（进入跟随 / 改样式 / 换绑定）要邻星：同一时刻上一拍收过就直接用（时钟停着时改个 HUD 不该让邻星消失，
// 也不该为拖一下滑杆就把整个渲染集重扫一遍）；时刻变了才自己扫一遍渲染集
let followOthersCache = null   // { tMs, key, others }
function followScan(fo) {
  for (const e of renderEntries) {
    if (e === followEntry) continue
    const cc = isCustomEntry(e), t = cc ? fo.ccNow : fo.now, g = cc ? fo.ccGmst : fo.gmst
    let pv = null
    try { pv = posAt(e, t) } catch { pv = null }
    if (pv && pv.position && pv.velocity) followCandidate(fo, e, pv, g)
  }
  fo.scanned = true
}
function followStateOf(fo) {
  const st = fo.st
  let others
  const hit = !fo.scanned && followOthersCache && followOthersCache.tMs === fo.tMs && followOthersCache.key === following.value && followOthersCache.ver === bodyRt.version()
  if (hit) others = followOthersCache.others
  else {
    if (!fo.scanned) followScan(fo)
    others = []
    fo.cand.sort((a, b) => a.d2 - b.d2)
    for (const c of fo.cand.slice(0, 16)) {
      const nb = satStateAt(c.pv, c.g, fo.sn.sunE)
      if (!nb) continue
      const mo = modelOf(c.e)
      const n = neighborInL(st, nb, bodyQB2L(mo.key, nb, fo.tMs))   // 邻星本体 → 主星 L 系（邻星自己的姿态律）
      others.push({ key: mo.key || c.e.name, modelId: mo.id, frame: mo.frame, relL: n.relL, qB2L: n.qB2L, anchorS: n.anchorS, name: displaySatName(c.e.name) })
    }
    followOthersCache = { tMs: fo.tMs, key: following.value, ver: bodyRt.version(), others }
  }
  const mo = modelOf(followEntry)
  // HUD「地球站」：标记层地球站里此刻看得见主星的（仰角 ≥ 0°），近者优先 12 支（开关关着不算）
  const sts = focusStyle.hudEs ? stationDirsInL(st, stations.value, 12, 0) : null
  return { key: following.value, modelId: mo.id, frame: mo.frame, anchor: st.anchor, qL2S: st.qL2S, qB2L: bodyQB2L(mo.key, st, fo.tMs), velL: velInL(st), eclipse: st.ecl, altKm: st.altKm, others, stations: sts,
    mounts: focusStyle.hudMounts ? hudMountsOf(mo.key) : null, near: followNearOf(fo) }
}
// 主星自己的聚焦几何（轨道线 / 覆盖锥）：跟随时相机贴着主星几十米，环组里那条缓存粗弦、地球那一趟的近裁剪面都顶不住
// （2026-09-25 用户实拍：轨道线成了一条不穿过卫星的偏移竖线、覆盖锥整只不见，根因见 viz/globe3d/followFocus.js）。
// 按本拍现算一份精确的相对几何（与锚点同一时刻、同一口径）：轨道线远的那截给地球那一趟（scene.setFollowOrbit，顶替主选那条 orbP），
// 近的那截连同覆盖锥锥顶段给模型层局部那一趟（state.near，按同一张近平面切开）。覆盖锥的远端照旧由聚焦几何 Worker 画 ——
// 足迹口径与段数取这一拍喂给 Worker 的同一份（fpOptNow / focusLod），两截才接得上。
function followNearOf(fo) {
  const e = followEntry
  const cc = isCustomEntry(e), t = cc ? fo.ccNow : fo.now, g = cc ? fo.ccGmst : fo.gmst
  let ff = null
  try {
    ff = followFocusGeom(e, t, g, fo.st.anchor, {
      orbOn: !!focusStyle.orbOn, orbDash: focusStyle.orbDash,
      coneOn: !!focusStyle.coneOn, faceOn: focusStyle.coneFaceOpacity > 0, genCount: focusStyle.coneGenCount, genDash: focusStyle.coneGenDash,
      fp: fpOptNow(), fpSeg: focusLod(selEntries.length).fpSeg
    })
  } catch { ff = null }
  if (scene) scene.setFollowOrbit({ anchor: fo.st.anchor, segs: ff ? ff.orb : null })
  if (!ff) return null
  const lines = [], faces = []
  if (ff.orb) lines.push({ segs: ff.orb, color: hexNum(focusStyle.orbColor), width: focusStyle.orbWidth, opacity: focusStyle.orbOpacity })
  if (ff.gen) lines.push({ segs: ff.gen, color: hexNum(focusStyle.coneGenColor), width: focusStyle.coneGenWidth, opacity: focusStyle.coneGenOpacity })
  if (ff.face) faces.push({ tris: ff.face, color: hexNum(focusStyle.coneFaceColor), opacity: focusStyle.coneFaceOpacity })
  return lines.length || faces.length ? { lines, faces } : null
}
/** refreshPositions 尾：图标 + 跟随，一拍一次 */
function feedModels(now, gmst, fo) {
  if (!modelLayer || !scene) return
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)
  const sn = fo ? fo.sn : sunStateAt(now)
  modelLayer.setSun(sn.sunS, gmst)
  const list = []
  if (!flatView.value && focusStyle.modelOn && !following.value && selEntries.length) {
    // 主选排第一（超过 32 颗时保证主选有图标）
    const order = selEntry ? [selEntry, ...selEntries.filter((x) => x !== selEntry)] : selEntries
    for (const e of order) {
      if (list.length >= 32) break
      const mo = modelOf(e)
      if (!mo.id) continue
      const st = satModelState(e, now, gmst, ccNow, ccGmst, sn.sunE)
      if (!st) continue
      list.push({ key: mo.key || e.name, modelId: mo.id, frame: mo.frame, px: focusStyle.modelPx, anchor: st.anchor, qL2S: st.qL2S, qB2L: bodyQB2L(mo.key, st, now.getTime()), altKm: st.altKm, eclipse: st.ecl })
    }
  }
  modelLayer.setIcons(list)
  if (following.value) {
    const f = fo || followPrep(now, gmst, ccNow, ccGmst)
    if (f) modelLayer.follow(followStateOf(f))
  }
  feedEntities(now, sn)   // 标记实体（运动档载具 / 站天线跟踪 / 实体模型图标）：与本拍星位同一个 now（落在 holdFrames 闸内）
}
// 选中 / 绑定 / 样式变了：不等下一拍（时钟停着时可能永远等不到），当场按当前时刻喂一次
function feedModelsNow() {
  if (!modelLayer || !scene) return
  const now = calcAt()
  feedModels(now, sat.gstime(now), null)
}

// —— 跟随卫星（直切，不做相机飞行：用户 09-15 亲自回退过飞行）——
function startFollow(e) {
  if (!modelLayer || !scene || flatView.value) return
  if (e && e !== selEntry) {
    if (selEntries.includes(e)) { _userSelTick++; selEntry = e; refreshSelection(); saveSelection() }   // 换主选＝用户改选（同 setPrimary）
    // 追加式选中（加入聚焦集并设为主选）：右键跟随一颗没聚焦的星不许清掉用户整理好的多选集（替换式会连存盘一起冲掉）
    else selectSat(e, false, true)
  }
  if (!selEntry) return
  followEntry = selEntry
  following.value = satKeyOf(selEntry) || ('name:' + selEntry.name)
  const now = calcAt(), gmst = sat.gstime(now)
  const fo = followPrep(now, gmst, ccTimeAt(now), sat.gstime(ccTimeAt(now)))
  if (!fo) { following.value = ''; followEntry = null; return }
  modelLayer.setIcons([])
  modelLayer.follow(followStateOf(fo))
  scene.setFollowDriver(modelLayer.followDriver())   // 只换相机：地图内容、宇宙空间 / 晨昏一概不动（归地图设置的开关）
  zoom.value = modelLayer.getFollowZoom()
  refreshSelModel()
}
function stopFollow() {
  if (!following.value) return
  following.value = ''
  followEntry = null
  followOthersCache = null
  if (modelLayer) modelLayer.follow(null)
  if (scene) { scene.setFollowOrbit(null); scene.setFollowDriver(null) }   // 主选轨道线交还环组那条 orbP
  pushZoom()
  feedModelsNow()
}
function toggleFollow() { if (following.value) stopFollow(); else startFollow(selEntry) }
// 地球影像 → 两个视图，各自对齐到「此刻该用哪一档」（imageryPlan）。
// ★ 3D 球不上瓦片档：选「高精」（瓦片金字塔）时 3D 用 16K 整幅（2026-09-24 用户定「宇宙投影影像底图现在用的高精吧，改为16K」——
//   从太空看整颗球，整幅一次到位），平面图照旧吃瓦片（放大看细节靠它）；16K / 8K 两档 2D / 3D 同档。
//   显卡纹理上限不足 16384 时 scene.setImagery 自己缩到 8K。与跟随无关（跟随只改视角）。
// 不用解码的（关 / 瓦片档）当场给；整幅档要解码（16K 几秒）：同一时刻只解一张（两张并行就是两份 537 MB），
// 在飞的回来后按【那时】该用哪一档贴给还要它的视图，再补跑一遍（另一视图要另一张 / 期间又改过档）。
// 两个视图各记着自己贴的是哪一档（img2d / img3d），没变就不重贴 —— 3D 重贴一次就是 716 MB 重传，开关星空之类也会走到这里。
// 2D 平面图里 3D 球是藏着的：不去【开始】解码只给 3D 用的那张（~537 MB 解码 + 716 MB 显存全给一个看不见的球；存档恢复在 2D 时同理），
// 切回 3D（下面的 watch）再补；已经贴上的在切 2D 时不撤（切回来不必再等几秒），该撤的（关总开关 / 去勾 / 换档）照撤。
// ★ 判 2D 用 view.flat 不用 flatView：启动时 applySpaceStyle 跑在 applyFlat(true) 之前，那时 flatView 还是 false、view.flat 已恢复。
// force2d：投影 / 切口一改、平面图新建，2D 那边照原口径重给一遍，档位没变也给（在飞时记着，贴上为止）。
const IMG_3D_FULL = 'bm16k'
let img2dForce = false
function imageryPlan() {
  if (!imageryOn.value) return { s2: null, s3: null }
  const tiles = IMAGERY_SOURCES.find((x) => x.tiles) || null
  const ok = (s) => (s && !s.tiles && imgFailed.has(s.url) ? tiles : s)   // 解码失败过的整幅档退到瓦片档
  const s2 = imagerySource(imageryKey.value)
  return { s2: ok(s2), s3: ok(s2.tiles ? imagerySource(IMG_3D_FULL) : s2) }
}
function applyImagery(force2d) {
  if (force2d === true) img2dForce = true
  const { s2, s3 } = imageryPlan()
  const b = imageryBright.value
  let need = ''
  if (flat && (img2dForce || s2 !== img2d)) {
    if (!s2 || s2.tiles) { flat.setImagery(s2 ? { on: true, set: s2.tiles, maxZ: s2.maxZ, img: null, bright: b } : { on: false }); img2d = s2; img2dForce = false }
    else need = s2.url
  }
  if (scene && s3 !== img3d) {
    if (!s3 || s3.tiles) { scene.setImagery(s3 ? { on: true, set: s3.tiles, maxZ: s3.maxZ, img: null, bright: b } : { on: false, set: null, img: null }); img3d = s3 }
    else if (!need && !view.flat) need = s3.url
  }
  if (!need || imgBusy) return   // 在飞的那一张回来后会再跑一遍本函数
  imgBusy = need
  loadImagery(need).then((img) => {
    imgBusy = ''
    // 回来时开关 / 档位 / 视图都可能变了：只贴给「此刻仍要这一张」的视图
    const p = imageryPlan(), bb = imageryBright.value
    if (flat && p.s2 && p.s2.url === need) { flat.setImagery({ on: true, set: null, img, bright: bb }); img2d = p.s2; img2dForce = false }
    if (scene && p.s3 && p.s3.url === need && p.s3 !== img3d && !view.flat) { scene.setImagery({ on: true, set: null, img, bright: bb }); img3d = p.s3 }
    applyImagery()
  }, (e) => {
    imgBusy = ''
    imgFailed.add(need)
    logMsg('地球影像载入失败：' + (e && e.message ? e.message : e))
    applyImagery()
  })
}
watch(() => view.flat, (v) => { if (!v) applyImagery() })   // 切回 3D：2D 期间压着没贴的那张此刻补上

// ===================== 卫星组（保存筛选结果 / Ctrl 多选卫星为命名组，可再显示） =====================
// 存新组后自动进入行内重命名态并聚焦输入框（默认名已填好，用户直接改名或回车确认即可）
function satGrpFocusRename() { nextTick(() => { try { const el = satGrpRenameEl.value; if (el) { el.focus(); el.select() } } catch { /* ignore */ } }) }
function satGrpEnterRename(g) { satGrpDelId.value = ''; satGrpRenameId.value = g.id; satGrpRenameVal.value = g.name; satGrpFocusRename() }
// 把当前筛选显示集存成卫星组（快照命中星的 NORAD + 名称）
function saveFilterAsGroup() {
  if (!filterEntries.length) { appAlert('当前没有筛选结果可保存'); return }
  const sats = filterEntries.map((e) => ({ noradId: e.noradId, name: e.name }))
  const g = satGroups.add(sats, filterKw.value ? ('筛选 ' + filterKw.value) : '')
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}
// 把当前 Ctrl 多选卫星存成卫星组
function saveSelectionAsGroup() {
  if (!selEntries.length) { appAlert('当前没有选中的卫星'); return }
  const sats = selEntries.map((e) => ({ noradId: e.noradId, name: e.name }))
  const g = satGroups.add(sats, '')
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}
// 当前「选中的卫星」→ [{noradId,name}]：Ctrl 多选 / 单个聚焦星皆可（selEntries 两种情形都含）
function selSatsForGroup() {
  return (selEntries || []).filter((e) => e && e.noradId != null).map((e) => ({ noradId: e.noradId, name: e.name }))
}
// 把当前选中的卫星【加入】某组（去重追加）。来源优先：Ctrl/点选的选中集；否则用当前搜索筛选结果（批量加）。
function addSelToGroup(g) {
  let sats = selSatsForGroup()
  if (!sats.length && filterEntries.length) sats = filterEntries.map((e) => ({ noradId: e.noradId, name: e.name }))
  if (!sats.length) { appAlert('尚未选中卫星。'); return }
  const n = satGroups.append(g.id, sats)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已加入 ${n} 颗到卫星组「${g.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `所选卫星都已在「${g.name}」中`)
  if (n) ensureSatGroupEntries(g.id)   // 成员变了 → 该集在图上就重解
}
// 把当前选中的卫星【移出】某组（一般用于正在显示的组：点该组显示 → Ctrl 选要删的星 → 移出）
function removeSelFromGroup(g) {
  const ids = selSatsForGroup().map((s) => s.noradId)
  if (!ids.length) { appAlert('尚未选中要移出的卫星。'); return }
  const n = satGroups.removeSats(g.id, ids)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已从卫星组「${g.name}」移出 ${n} 颗（剩 ${gg ? gg.sats.length : '?'} 颗）` : '所选卫星不在该组中')
  if (n) ensureSatGroupEntries(g.id)
}
// 把地球转到一批星的「中心」：单位方向矢量取平均（星群铺满全球时合矢量趋零 → 没有中心可言，不动镜头）
function faceEntries(list) {
  if (!scene || !list || !list.length) return
  const now = calcAt(), gmst = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)
  let x = 0, y = 0, z = 0, n = 0
  for (const e of list) {
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    const pv = posAt(e, t)
    if (!pv || !pv.position) continue
    const gd = sat.eciToGeodetic(pv.position, g)
    const phi = (90 - sat.degreesLat(gd.latitude)) * DEG, theta = (sat.degreesLong(gd.longitude) + 180) * DEG
    x += -Math.sin(phi) * Math.cos(theta); y += Math.cos(phi); z += Math.sin(phi) * Math.sin(theta)
    n++
  }
  if (!n) return
  const m = Math.hypot(x, y, z)
  if (!(m > 1e-6)) return
  scene.faceTo({ x: x / m, y: y / m, z: z / m })
}
// —— 按最新真实星历核对全部卫星组：自动移除已离轨的成员 ——
// 跑在【全量池刚建成】那一刻（ensureSearchPool 末尾），一次扫全部组，与用户点没点开过某组无关。
// 判据链见 useSatGroups.reconcile；本函数只负责把「能不能信这份目录」这一关把住，以及把结果讲给用户听。
// 三道闸缺一不可：
//   · poolReady        —— 池真的建起来了
//   · universeIntact   —— 这份并集一组不缺（缺一组＝那组的星整批"缺席"，会误伤一大片）
//   · universeFetchedMin —— 拿得到「最旧一份」的下载时间，作为缺席证据的时间戳
// 离线时 offlineBest 会拿缓存/内置快照顶上，intact 仍可能为真 —— 那没关系：同一份数据的时间戳不变，
// reconcile 的「两次确认」要求 epoch 严格变新，重复跑同一份目录不会推进任何成员的判决。
function satGrpSweep() {
  if (!poolReady || !universeIntact || !universeFetchedMin) return
  if (!satGroups.list.value.length) return
  const idx = poolIndex()
  // 合成星（自定义星座，NORAD_BASE 起的号段）不属于真实星历，返回 null 让 reconcile 整支跳过
  const probe = (id) => (Number(id) >= NORAD_BASE ? null : idx.has(String(id)))
  let rep = []
  try { rep = satGroups.reconcile(probe, universeFetchedMin) } catch { return }
  for (const r of rep) {
    if (r.skipped) { logMsg(`卫星组「${r.name}」：${r.total} 颗里有 ${r.skipped} 颗不在最新星历中，占比过高，未自动移除`, 'warn'); continue }
    if (!r.removed.length) continue
    const who = r.removed.map((s) => `${s.name || 'NORAD'} (${s.id})`).join('、')
    logMsg(`卫星组「${r.name}」：已移除离轨的 ${r.removed.length} 颗 —— ${who}（剩 ${r.remain} 颗）`)
  }
}
function satGrpCommitRename(g) {
  satGroups.rename(g.id, satGrpRenameVal.value)
  satGrpRenameId.value = ''
}
// 两步删除：首次点击进入「确认」态，再点一次才真正删除
function satGrpDelete(g) {
  if (satGrpDelId.value !== g.id) { satGrpDelId.value = g.id; return }
  expDrop('s:' + g.id); satSets.drop('s:' + g.id)
  satGroups.remove(g.id)
  satGrpDelId.value = ''
  registerSets(); applySetsChanged()
}
// 搜索结果行的「+」：加入/移出选中集且【不清搜索框】，于是可以「搜 A → +、搜 B → +、…」把跨关键词的
// 卫星攒到一个选中集里，再点选中栏的「存为组」一次成组。裸点结果行仍是原行为（替换选中并转到该星）。
function toggleResultSel(item) { selectSat(item.en, false, true) }
const selNorads = computed(() => new Set(selList.value.map((s) => String(s.noradId))))

// ===================== 行内展开：卫星列表（虚拟滚动 + Excel 式多选） =====================
// 列表项：lc 预建小写供 SatList 逐次键入筛选（上万条时不能每次都 toLowerCase）；dot=行首色点（卫星组成员显示生效配色）
// slot=GEO 定点标注（'110.5°E'，非 GEO 空串）：进 sub（行右小字）与 tip，并并入 lc 让「110.5」也可搜。
function expMkItem(id, name, tip, dot, slot) {
  const nid = String(id), nm = name || ('NORAD ' + nid)
  const t = tip || (nm + ' · NORAD ' + nid)
  return { id: nid, name: nm, lc: (slot ? nm + ' ' + slot : nm).toLowerCase(), sub: slot ? slot + ' · ' + nid : nid, tip: slot ? t + ' · ' + slot : t, dot: dot || '' }
}
// 内置分组的卫星名录（只要名称+编号，不建 satrec）：'all'/'other' 走全集并集，'custom' 读本地导入库，
// 其余按组读 CelesTrak CSV（主进程缓存优先，无缓存才联网）。会话内缓存，展开过一次即刻打开。
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })   // STARLINK-999 排在 STARLINK-1007 前
async function grpSatList(key) {
  const hit = grpListCache.get(key)
  if (hit) return hit
  if (!apiOk) throw new Error('需在桌面客户端中运行')
  if (key === 'all' || key === 'other') {
    // 本机星历优先出名录（联网那一轮最坏是分钟级）；后台刷新拿到新目录时 setSearchPool 会清掉这份快照
    let uni = []
    try { uni = await loadUniverse(true, { cacheOnly: true }) } catch { uni = [] }
    if (!uni.length) uni = await loadUniverse(true)
    const all = [], oth = []
    for (const s of uni) {
      const it = expMkItem(s.noradId, s.name, `${s.name || ''} · ${GROUP_LABEL[s._group] || '其他'} · NORAD ${s.noradId}`, '', geoSlotOfOmm(s))
      all.push(it)
      if (s._group === 'other') oth.push(it)
    }
    all.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name)); oth.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name))
    grpListCache.set('all', all); grpListCache.set('other', oth)
    return key === 'all' ? all : oth
  }
  let sats = []
  if (key === 'custom') {
    const raw = await window.api.omm.customCsv()
    sats = raw && raw.text ? parseOMMCsv(raw.text) : []
  } else {
    let p = null
    try { p = await fetchGroupLiveOrSup(key, { cacheOnly: true }) } catch { p = null }
    if (!p) p = await fetchGroupLiveOrSup(key)
    sats = (p && p.sats) || []
  }
  const out = sats.map((s) => expMkItem(s.noradId, s.name, '', '', geoSlotOfOmm(s)))
  out.sort((a, b) => NAME_COLLATOR.compare(a.name, b.name))
  grpListCache.set(key, out)
  return out
}
// 卫星组成员 / 自定义星座合成星：本来就在内存里，按源数组的对象身份缓存映射结果 ——
// 成员没变就返回同一个数组，SatList 不会因无关的响应式变动（改名/切显隐）白清一次选择集。
let expMemCache = { src: null, out: [] }
// 卫星组成员只存 {id,name}：GEO 定点标注从全量搜索池反查。池未就绪先出无标注列表并后台建池（幂等），
// 就绪时 poolTick 翻号触发重映射补上标注；池仍缺该星（不在星历）→ 空串。
let _poolByNorad = null   // noradId → entry（池就绪后惰性建一次；池重建时随 poolTick 作废）
const poolTick = ref(0)
// 全量目录就绪 → 实时气象的目标星重解算。★ 不让 liveSatPosAt 自己去读 poolTick：它在 setup 期
// 就会被 watch 调一次，那时 poolTick 还没轮到声明（TDZ）。由这条 watch 显式转达，依赖关系也看得见。
watch(poolTick, () => { envLive.satTick.value++ })
// ★ 池换了一批（本机缓存版 → 联网版、文件管理导入 / 删除自定义卫星）→ 哪些关联星「解得出」可能变了：补一拍全场。
//   tickLive 让 GRD 那侧的逐拍备忘作废并按新池重解 —— 刚解析通的关联星 meta 从存盘位置挪到活位置、刚丢了的撤下，
//   表 / 壳层经 perfHost.onMoved / satcovTick 一并跟上。只清备忘不补拍不够：刚解析通的那颗 meta 还停在存盘位置，天线会画在那儿。
//   暂停档（出厂）没有时钟拍，不补就一直错到时间动。
//   redrawSats 无条件：refreshPositions 只在「有显示中的关联星 / 可见性开着」时重绘，图标名称都关着的关联星的波束合成草图也靠这一下。
//   挂载时那次 ensureSearchPool 的收尾也走这里；按 poolTick 记已补过的那一版，同一次换池不补两拍。
let _poolSwapSeen = 0
function onPoolSwapped() {
  if (!poolReady || !scene || _poolSwapSeen === poolTick.value) return
  _poolSwapSeen = poolTick.value
  relinkTick()
}
watch(poolTick, onPoolSwapped)
// 关联星的星历源变了（换池 / 隐藏点序列组的采样表载入）：补一拍全场 + 无条件重绘（理由见上）。
// 先走 refreshPositions：在跟踪的天线（画着的 / 开着表的 / 对星）这一拍挪位，表与壳层经它自己的 onMoved / satcovTick 跟上；
// 再 grd.invalidateLive：其余已载入的天线也按新源对一遍星位（它自己走一拍 tickLive），它报回的 moved 同样喂给表与壳层 ——
// 顺序反过来的话，refreshPositions 那一拍看到的是「已经挪过」，开着的表就漏刷了。
// grdLive 同理：这一拍按新源解算的星位 / noEph 必须落盘，不受 3 s 节流（启动时第一拍在池到齐前写下的 noEph，池 1–2 s 后到齐补的
// 这一拍若被节流吞掉，暂停档再没有时钟拍，链路预算窗口一直读到「无星历」）。渲染集为空时 refreshPositions 走早退分支不写 → 补写一次。
// ★ _grdLiveGate 声明在后面（persistGrdLive 旁）：relinkTick 只在挂载后（scene 就绪）才跑，不踩 TDZ。
function relinkTick() {
  if (!scene) return
  _grdLiveGate.due()
  refreshPositions()
  if (_grdLiveGate.pending()) persistGrdLive()
  if (typeof grd.invalidateLive === 'function') {
    const tk = grd.invalidateLive()
    if (tk && tk.moved && tk.moved.size) { perfHost.onMoved(tk.moved); satcovTick(tk.moved) }
  }
  redrawSats(); grd.recompute(); satcov.scheduleRecompute()
}
// ★ 池换了一批 → 停在屏上的搜索结果与筛选显示集按 NORAD 重映射到新池。
// 不重映射的后果：结果行里 item.en 还指着【上一版池】的条目，pickResult → selectSat(item.en) 选中的是
// 一颗已经不在渲染集里的孤儿星（星历也是旧的）。池的两段式更新（本机缓存一版、联网再一版）与跨天刷新、
// 文件管理导入都会走到这里，挂机越久越容易撞上。池里没有了的（离轨 / 编目变动）直接从结果里去掉。
watch(poolTick, () => {
  if (!poolReady) return
  const idx = poolIndex()
  const rs = searchResults.value
  if (rs.length) {
    let changed = 0
    const out = []
    for (const r of rs) {
      const en = idx.get(String(r.noradId))
      if (!en) { changed++; continue }                       // 池里没有了：去掉这一行
      if (en === r.en) { out.push(r); continue }
      changed++
      out.push({ ...r, en, slot: geoSlotOfSatrec(en.rec) })
    }
    if (changed) { searchResults.value = out; diagMsg('全量池更换：搜索结果重映射 ' + rs.length + ' → ' + out.length + ' 行') }
  }
  if (filterEntries.length) {
    let changed = 0
    const out = []
    for (const e of filterEntries) {
      const en = idx.get(String(e.noradId))
      if (!en) { if (e.noradId >= 900000) out.push(e); else changed++; continue }   // 自定义星座合成星不在池里，照留
      if (en !== e) changed++
      out.push(en)
    }
    if (changed) {
      filterEntries = out; filterN.value = out.length
      diagMsg('全量池更换：筛选显示集重映射，' + changed + ' 条改指新池')
      rebuildRenderSet(); redrawSats()
    }
  }
})
// NORAD → entry 索引，惰性建一次。只索引 searchPool（真实目录并集 ∪ active ∪ 本地自定义卫星库），
// 不含自定义星座合成星 —— 成员核对要的正是「真实星历」这条口径（合成星走 searchSource 那一路）。
function poolIndex() {
  if (!_poolByNorad) { _poolByNorad = new Map(); for (const en of searchPool) _poolByNorad.set(String(en.noradId), en) }
  return _poolByNorad
}
function slotByNorad(nid) {
  if (!poolReady) return ''
  const en = poolIndex().get(String(nid))
  return en ? geoSlotOfSatrec(en.rec) : ''
}
const expList = computed(() => {
  const tag = expTag.value
  if (!tag) return expItems.value
  if (tag === 'q') { void filterN.value; return filterEntries.map((e) => expMkItem(e.noradId, e.name, '', '', e.rec ? geoSlotOfSatrec(e.rec) : '')) }
  if (tag[0] === 'g' || tag[0] === 'i') { const h = satSets.hiddenOf(tag); return h.size ? expItems.value.filter((it) => !h.has(String(it.id))) : expItems.value }
  if (tag[0] === 's') {
    const g = satGroups.find(tag.slice(2))
    const src = g ? g.sats : null
    if (!src) return []
    const tick = poolTick.value              // 池就绪后重映射一次（补 GEO 定点标注）
    if (!poolReady) ensureSearchPool()       // 后台建池；就绪前列表先出（无标注）
    // 缓存键含组色：逐颗色变会换 sats 数组（colorSats 不可变更新），组色变则数组不动，得单独盯
    if (expMemCache.src !== src || expMemCache.gc !== g.color || expMemCache.tick !== tick) {
      // 组里只要有任何配色，未着色成员给透明占位点 —— 名字列对齐，不然行首参差
      const pad = (!!g.color || src.some((s) => s.color)) ? 'transparent' : ''
      expMemCache = { src, gc: g.color, tick, out: src.map((s) => expMkItem(s.id, s.name, '', s.color || g.color || pad, slotByNorad(s.id))) }
    }
    return expMemCache.out
  }
  if (tag[0] === 'c') {
    const src = customConst.satsOf(tag.slice(2))
    if (expMemCache.src !== src) expMemCache = { src, out: src.map((e) => expMkItem(e.noradId, e.name, `${e.name} · 第 ${(e.plane || 0) + 1} 轨道面 · NORAD ${e.noradId}`, '', geoSlotOfSatrec(e.rec))) }
    return expMemCache.out
  }
  return expItems.value
})
const expActions = computed(() => {
  const a = [
    { key: 'focus', label: '聚焦', icon: 'crosshair', title: '地图上只显示选中的这批星，并把地球转到它们那一面（单颗＝与双击一颗相同：选中并转过去）' },
    { key: 'addto', label: '加入组', icon: 'folder-plus', title: '把选中的卫星加入某个卫星组，或新建一组' }
  ]
  if (expTag.value[0] === 's') a.push({ key: 'rmfrom', label: '移出', icon: 'minus', title: '把选中的卫星从本组移出', tone: 'warn' })
  if (expTag.value[0] === 'g' || expTag.value[0] === 'i') a.push({ key: 'hide', label: '剔除', icon: 'eye-off', title: '把选中的卫星从本集剔除（菜单「恢复剔除」可撤）', tone: 'warn' })
  return a
})
// 把列表里选中的这批星解析成可渲染 entries。
// 内置分组【直接从该组自己的星历里现建 satrec】（只建选中的这几颗）—— 不必先花几秒把「全量搜索池」
// 建起来才动；跨组的卫星组 / 自定义星座合成星才回退全量池。
async function expResolve(sats, tagOverride) {
  const want = new Map((sats || []).map((s) => [String(s.noradId), s]))
  if (!want.size) return []
  const tag = tagOverride || expTag.value, key = tag.slice(2)
  // 自定义星座合成星本来就在内存里（build 有签名缓存）：直接挑，不必为它先建全量搜索池
  if (tag[0] === 'c') {
    const out = []
    for (const e of customConst.satsOf(key)) if (want.has(String(e.noradId))) out.push(e)
    if (out.length) return out
  }
  if (tag[0] === 'g' && key !== 'all' && key !== 'other' && apiOk) {
    try {
      let recs = []
      if (key === 'custom') { const raw = await window.api.omm.customCsv(); recs = raw && raw.text ? parseOMMCsv(raw.text) : [] }
      else { let p = null; try { p = await fetchGroupLiveOrSup(key, { cacheOnly: true }) } catch { p = null }; if (!p) p = await fetchGroupLiveOrSup(key); recs = (p && p.sats) || [] }
      const out = []
      for (const s of recs) {
        if (!want.has(String(s.noradId))) continue
        try { const r = sat.omm2satrec(s); if (r && !r.error) out.push({ rec: r, name: s.name, noradId: s.noradId, group: key }) } catch { /* 该星星历坏了：跳过 */ }
      }
      if (out.length) return out
    } catch { /* 取该组星历失败：回退全量池 */ }
  }
  // 导入组：点序列（ephem）星【不进全量搜索池】——loadUniverse 只并 gp 组（全集是一份 OMM 记录表，
  // 点序列星没有根数塞不进来），不走这一支就必然落到下面的全量池、然后报「都未找到」。
  // ensureImportEntries 两种 kind 都覆盖（ephem → ephemEntriesOf、gp → customGroupRecords），
  // 自带缓存，且返回的就是渲染集里那批 entry 对象本身 —— 选中集与图上星点是同一个对象。
  if (tag[0] === 'i') {
    try {
      const hit = [], got = new Set()
      for (const e of await ensureImportEntries(key)) {
        const nid = String(e.noradId)
        if (got.has(nid)) continue
        if (want.has(nid) || (e.key != null && want.has(String(e.key))) || (e.name && want.has(String(e.name)))) { got.add(nid); hit.push(e) }
      }
      if (hit.length) return hit
    } catch { /* 读该导入组失败：回退全量池 */ }
  }
  await ensureSearchPool()
  const out = [], seen = new Set()
  for (const en of searchSource()) {
    const nid = String(en.noradId)
    if (want.has(nid) && !seen.has(nid)) { seen.add(nid); out.push(en) }
  }
  return out
}
// ===================== 可见性分析·卫星集来源解析 =====================
// vis.satSrc 非空时把所选来源解析成 entries 缓存（与 renderEntries 同构），瞬时/过境/覆盖三模式共用。
// 解析与「行内展开→聚焦」同口径（grpSatList 名录 + expResolve）：内置分组走该组星历快路径、
// 自定义卫星走 custom.csv、卫星组按 NORAD 回全量池（含合成星，group 前缀 cc 自动双历元）。
let visSatCache = []
const visSatBusy = ref(false)
const visSatErr = ref('')
let visSatSeq = 0
async function visSatResolve() {
  const src = String(vis.satSrc.value || ''), seq = ++visSatSeq
  visSatErr.value = ''
  if (!src) { visSatCache = []; visSatBusy.value = false; vis.recompute(); redrawSats(); commitGeometry(); return }
  if (src[0] === 's' && !satGroups.find(src.slice(2))) { vis.satSrc.value = ''; return }   // 组已删 → 回退当前显示（watch 再走空分支）
  visSatBusy.value = true
  let ents = [], err = ''
  try {
    const roster = src[0] === 's'
      ? (satGroups.find(src.slice(2)).sats || []).map((s) => ({ noradId: s.id, name: s.name }))
      : (await grpSatList(src.slice(2))).map((it) => ({ noradId: it.id, name: it.name }))
    if (seq !== visSatSeq) return
    ents = await expResolve(roster, src)
  } catch (e) { err = (e && e.message) || String(e) }
  if (seq !== visSatSeq) return
  visSatCache = ents
  visSatErr.value = err ? ('加载失败：' + err) : (ents.length ? '' : '该卫星集在当前星历中没有找到卫星')
  visSatBusy.value = false
  vis.recompute(); redrawSats(); commitGeometry()
}
watch(() => vis.satSrc.value, visSatResolve)
// 正被分析的卫星组被删 → 回退「当前显示」，不留死 id
watch(() => satGroups.list.value.length, () => {
  const src = String(vis.satSrc.value || '')
  if (src[0] === 's' && !satGroups.find(src.slice(2))) vis.satSrc.value = ''
})
// 聚焦所选：地图只显示这批 → 把它们设为选中星（画轨道/星下点/足迹 + 信息卡逐颗列出）→ 地球转到它们那一面。
// 单颗与双击一颗完全同效；多颗只是把同一套动作施加到一批上，不是另一种行为。
// 选中集不截断（信息卡、存为组、加入组都按全部算）；画多少细节由 focusLod 分档决定。
// tagOverride：不经侧栏展开直接聚焦某一行时传该行的展开标记（'g:'/'s:'/'c:'），让 expResolve 走对应的快路径。
async function expFocus(sats, label, tagOverride) {
  status.value = `聚焦 ${sats.length} 颗：解析星历…`   // 卫星组/全部卫星要现建全量池，可能等几秒 —— 别让界面看起来没反应
  const hit = await expResolve(sats, tagOverride)
  if (!hit.length) { status.value = ''; appAlert(`「${label}」的卫星在当前星历中都未找到（可能未联网加载全量目录，或卫星已退役）`); return }
  // 聚焦的那一集要在图上：没开就打开（别的集不动）
  const tag = tagOverride || expTag.value
  if (tag && tag !== 'q' && satSets.order.value.includes(tag) && !satSets.isVisible(tag)) toggleSet(tag)
  // 选中（含主选）：直接铺 selEntries，与 selectSat 的多选路径同构。用户改选 → _userSelTick 自增（落选中这一刻才算，
  // 等解析那段不算）：还在等池的树聚焦（focusTreeSat）据此作废，不把这批聚焦冲掉
  _userSelTick++
  selEntries = hit
  selEntry = selEntries[0]
  resetBeam()
  refreshSelection()
  faceEntries(hit)     // 单颗时与 faceEntry 逐位一致；一批则转到它们的方向矢量均值
  saveSelection()
  const miss = sats.length - hit.length
  const tail = miss > 0 ? `（另有 ${miss} 颗未在当前星历中找到）` : ''
  status.value = `${label}：聚焦 ${hit.length} 颗${tail}`
  logMsg(`聚焦${label ? `「${label}」` : ''} ${hit.length} 颗${tail}`)
}
// 展开源被删（卫星组/自定义星座）→ 收起，别留着指向死 id 的展开态
const expDrop = (tag) => { if (expTag.value === tag) { expTag.value = ''; expItems.value = []; expErr.value = ''; expMenu.value = null } }
// 点行首箭头：展开/收起。只切列表，不动地图上渲染的是哪一组（那是点行本身的事）。
function expToggle(tag, label) {
  expMenu.value = null
  if (expTag.value === tag) { expTag.value = ''; expItems.value = []; expErr.value = ''; expLoading.value = false; return }
  expTag.value = tag; expLabel.value = label || ''; expErr.value = ''; expItems.value = []
  if (tag[0] === 'g' || tag[0] === 'i') expLoad(tag)
}
async function expLoad(tag) {
  const seq = ++expSeq
  expLoading.value = true
  try {
    const list = tag[0] === 'i' ? await impSatList(tag.slice(2)) : await grpSatList(tag.slice(2))
    if (seq !== expSeq || expTag.value !== tag) return
    expItems.value = list
  } catch (e) {
    if (seq !== expSeq || expTag.value !== tag) return
    expErr.value = '列表加载失败：' + ((e && e.message) || e)
  } finally { if (seq === expSeq) expLoading.value = false }
}
// 双击 / 回车：解回该星并聚焦（与搜索结果点选同一路径，未渲染的星也能定位）。
// row = 被展开的那一集（SatLayersPanel 随 activate 一并给出；查找对话框那条路没有，回落 expTag）。
// 导入的点序列星不在全量搜索池里，只有本集这条快路径找得到它；其余各集仍按原样走全量池，行为逐位不变。
async function expLocate(it, row) {
  const tag = String((row && row.id) || expTag.value || '')
  const nid = String(it.id)
  if (tag[0] === 'i') {
    let hit = null
    try { hit = (await ensureImportEntries(tag.slice(2))).find((e) => String(e.noradId) === nid || (e.key != null && String(e.key) === nid)) || null } catch { hit = null }
    if (hit) { selectSat(hit, true); return }
  }
  await ensureSearchPool()
  const en = searchSource().find((x) => String(x.noradId) === nid)
  if (!en) { appAlert(`「${it.name}」不在当前星历中（可能未联网加载全量目录，或卫星已退役）`); return }
  selectSat(en, true)
}
function expOnAction(key, p) {
  const sats = (p.items || []).map((it) => ({ noradId: it.id, name: it.name }))
  if (!sats.length) return
  if (key === 'focus') { expFocus(sats, expLabel.value || '所选卫星'); return }
  if (key === 'rmfrom') {
    const g = satGroups.find(expTag.value.slice(2)); if (!g) return
    const n = satGroups.removeSats(g.id, sats.map((s) => s.noradId))
    logMsg(n ? `已从卫星组「${g.name}」移出 ${n} 颗（剩 ${g.sats.length} 颗）` : '所选卫星不在该组中')
    if (n) ensureSatGroupEntries(g.id)
    return
  }
  if (key === 'hide') {
    // 内置组 / 导入组：把选中的成员剔出本集（覆盖层，菜单「恢复剔除」可撤）
    const tag = expTag.value; if (!(tag[0] === 'g' || tag[0] === 'i')) return
    satSets.hide(tag, sats.map((x) => x.noradId)); applySetsChanged()
    logMsg(`已从「${expLabel.value || setName(tag)}」剔除 ${sats.length} 颗`)
    return
  }
  if (key === 'addto') {
    // 菜单锚在按钮下沿，越界则翻到上方；宽度/行高与 .lmenu 样式一致
    const w = 200, h = Math.min(280, 34 + (satGroups.list.value.length + 1) * 25)
    const x = Math.max(6, Math.min(p.x, window.innerWidth - w - 6))
    const y = p.y + h > window.innerHeight - 8 ? Math.max(8, p.y - h - 28) : p.y
    expMenu.value = { x, y, sats }
  }
}
function expMenuTo(g) {
  const m = expMenu.value; if (!m) return
  expMenu.value = null
  const n = satGroups.append(g.id, m.sats)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已加入 ${n} 颗到卫星组「${g.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `所选卫星都已在「${g.name}」中`)
  if (n) ensureSatGroupEntries(g.id)   // 成员变了 → 该集在图上就重解
}
function expMenuNew() {
  const m = expMenu.value; if (!m) return
  expMenu.value = null
  const g = satGroups.add(m.sats, expLabel.value ? (expLabel.value + ' 选集') : '')
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}
// Esc 关「加入组」菜单：捕获阶段先拿到并截住，同一次 Esc 不再往下关别的层；输入法组字中的 Esc 归输入法
function onExpEsc(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); expMenu.value = null } }
watch(() => !!expMenu.value, (open) => {
  if (open) window.addEventListener('keydown', onExpEsc, true)
  else window.removeEventListener('keydown', onExpEsc, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onExpEsc, true))

// ===================== 卫星集：内置星座 / 卫星组 / 导入星历 / 自定义星座 摊成一张有序表 =====================
// 注册表 satSets 只记【顺序 / 可见集合 / 内置项覆盖层（改名 · 剔星 · 删除）】，本体仍在各自的库里；
// 内置组的颜色沿用 groupColors（随设置持久化，渲染取色链直接读它），故不在注册表里存第二份。
const satSets = useSatSets()
const SEARCH_LAYER_HEX = '#ffd166'
const BUILTIN_KEYS = GROUPS.filter((g) => g.key !== 'none' && g.key !== 'custom').map((g) => g.key)
const groupEntries = new Map()     // 内置组 key -> entries（已加载）
const groupPending = new Map()     // key -> Promise（在飞）
const groupFetchedAt = new Map()   // key -> ISO
const groupCounts = ref({})        // key -> 权威颗数（omm.list；加载后换成实际颗数）
const sgEntries = new Map()        // 卫星组 id -> { sig, entries }
const sgPending = new Map()
const impEntries = new Map()       // 导入组（gp）id -> entries
const impPending = new Map()
const satClip = ref(null)          // 剪贴板 { label, sats:[{noradId,name}], cfg:null|{name,params,color,colorByPlane,design} }
let setsSeeded = false

function setName(id) {
  const k = id[0], r = id.slice(2)
  if (id === 'q') return filterKw.value ? `搜索「${filterKw.value}」` : '搜索结果'
  if (k === 'g') return satSets.nameOf(id) || GROUP_LABEL[r] || r
  if (k === 's') { const g = satGroups.find(r); return g ? g.name : '' }
  if (k === 'i') { const g = importGroups.value.find((x) => x.id === r); return g ? g.name : '' }
  if (k === 'c') { const c = customConst.list.value.find((x) => x.id === r); return c ? c.name : '' }
  return ''
}
function setCount(id) {
  const k = id[0], r = id.slice(2), hidden = satSets.hiddenOf(id).size
  if (k === 'g') { const list = groupEntries.get(r); if (list) return Math.max(0, list.length - hidden); const c = groupCounts.value[r]; return c == null ? '' : Math.max(0, c - hidden) }
  if (k === 'i') { const g = importGroups.value.find((x) => x.id === r); return g ? Math.max(0, (g.count || 0) - hidden) : 0 }
  return 0
}
const impSub = (g) => (g.kind === 'ephem' ? `星历 · ${impDay(g.t0)} → ${impDay(g.t1)}` : `${g.formatLabel || g.format || '—'} · ${g.importedAt ? impDay(Date.parse(g.importedAt)) : '—'}`)
// 各库现有的集都登记进表（首轮按 内置 → 卫星组 → 导入 → 自定义 排在末尾；之后新出现的排最前）；本体没了的引用跟着掉
function registerSets() {
  const ids = [
    ...BUILTIN_KEYS.map((k) => 'g:' + k),
    ...satGroups.list.value.map((g) => 's:' + g.id),
    ...importGroups.value.map((g) => 'i:' + g.id),
    ...customConst.list.value.map((c) => 'c:' + c.id)
  ]
  const exists = new Set(ids)
  satSets.prune((id) => exists.has(id))
  satSets.ensure(ids, setsSeeded)
  setsSeeded = true
}
// 可见集合变了之后的统一收尾：持久化 → 把没加载的集加载起来 → 重建渲染集 → 重画 2D
function applySetsChanged() { satSets.persist(); ensureSetsLoaded(); rebuildRenderSet(); redrawSats() }
function toggleSet(id) { satSets.toggle(id); applySetsChanged() }
function soloSet(id) { satSets.soloOn(id); applySetsChanged() }
function restoreSets() { satSets.restore((id) => id !== 'q' || filterEntries.length > 0); applySetsChanged() }
function reorderSet(id, to) { satSets.move(id, to) }
// 首次进页：读注册表；没有存档就按旧存档迁移（「当前分组」+ 自定义星座 / 导入组各自的 visible 标志）
function initSatSets(legacy) {
  const had = satSets.load()
  registerSets()
  if (!had) {
    const vis = []
    const key = legacy && legacy.groupKey ? legacy.groupKey : GROUPS[DEFAULT_GROUP].key
    if (key === 'custom') { for (const g of importGroups.value) if (g.visible !== false) vis.push('i:' + g.id) }
    else if (BUILTIN_KEYS.includes(key)) vis.push('g:' + key)
    for (const c of customConst.list.value) if (c.visible !== false) vis.push('c:' + c.id)
    satSets.setVisible(vis)
  }
  applySetsChanged()
}
// 内置组的权威颗数（主进程 omm.list：缓存 / 内置快照都算）；加载过的组换成实际颗数
async function loadGroupCounts() {
  try {
    const rows = (apiOk && window.api.omm.list) ? await window.api.omm.list() : []
    const next = { ...groupCounts.value }
    for (const r of rows || []) { if (!r || r.kind === 'satcat' || !Number.isFinite(r.count)) continue; if (r.key === 'active') next.all = next.all == null ? r.count : next.all; else if (!(r.key in next)) next[r.key] = r.count }
    groupCounts.value = next
  } catch { /* 取不到就不显示 */ }
}

// —— 面板数据 ——
const setRows = computed(() => {
  void poolTick.value; void groupCounts.value
  const vis = satSets.visible.value, ov = satSets.items.value
  const rows = []
  for (const id of satSets.order.value) {
    const k = id[0], r = id.slice(2)
    if (k === 'g') {
      const g = GROUPS.find((x) => x.key === r); if (!g) continue
      const o = ov[id] || {}
      rows.push({ id, kind: 'builtin', name: o.name || g.label, count: setCount(id), sub: '', color: groupColors[r] || '', colorable: groupColorable(r), visible: vis.has(id), renamable: true, icon: 'satellite', iconTitle: 'CelesTrak 星历组（可改名 / 改色 / 剔除成员，菜单里可重置为出厂）', modified: !!(o.name || groupColors[r] || (o.hidden && o.hidden.length)) })
    } else if (k === 's') {
      const g = satGroups.find(r); if (!g) continue
      rows.push({ id, kind: 'group', name: g.name, count: g.sats.length, sub: '', color: g.color || '', colorable: true, visible: vis.has(id), renamable: true, icon: 'layers', iconTitle: '卫星组：按 NORAD 记录的成员集', modified: false })
    } else if (k === 'i') {
      const g = importGroups.value.find((x) => x.id === r); if (!g) continue
      const o = ov[id] || {}
      rows.push({ id, kind: 'import', name: g.name, count: setCount(id), sub: impSub(g), color: g.color || '', colorable: true, visible: vis.has(id), renamable: true, icon: g.kind === 'ephem' ? 'clock' : 'import', iconTitle: g.kind === 'ephem' ? '时间标签位置序列，按插值取位，不做轨道外推' : '导入的平均根数，走 SGP4', modified: !!(o.hidden && o.hidden.length) })
    } else if (k === 'c') {
      const c = customConst.list.value.find((x) => x.id === r); if (!c) continue
      rows.push({ id, kind: 'custom', name: c.name, count: customConst.count(c), sub: ccCode(c), color: c.color, colorable: true, visible: vis.has(id), renamable: true, icon: 'orbit', iconTitle: '自定义星座（轨道向导生成）', modified: false })
    }
  }
  return rows
})
const searchRow = computed(() => (filterN.value > 0 ? { id: 'q', kind: 'search', name: setName('q'), count: filterN.value, sub: '', color: SEARCH_LAYER_HEX, colorable: false, visible: satSets.visible.value.has('q'), renamable: false } : null))
// shown 取【本拍真画出来的】颗数，不是集合规模 —— 星历星在采样时段外仍留在集里（见 keepInRenderSet），
// 读 satCount 会在一个点都看不见时报出「显示 N 颗」。
const setSummary = computed(() => ({ shown: shownCount.value, layers: satSets.visible.value.size, dataTime: dataTime.value, status: status.value }))
const soloInfo = computed(() => (satSets.solo.value ? { id: satSets.solo.value.id, name: setName(satSets.solo.value.id) } : null))
const setSearch = computed(() => ({
  keyword: keyword.value,
  results: searchResults.value.map((r) => ({ noradId: r.noradId, name: r.name, groupLabel: r.groupLabel, slot: r.slot, picked: selNorads.value.has(String(r.noradId)), en: r.en })),
  finderActive: !isFilterEmpty(satFilters)
}))
const addItems = computed(() => {
  const out = [
    { key: 'group', label: '新建卫星组', icon: 'folder-plus' },
    { key: 'wizard', label: '生成星座…', icon: 'orbit' },
    { key: 'import', label: '导入星历文件…', icon: 'import' },
    { key: 'finder', label: '从目录查找…', icon: 'filter' }
  ]
  const removed = BUILTIN_KEYS.filter((k) => satSets.isRemoved('g:' + k))
  if (removed.length) { out.push({ sep: true }); for (const k of removed) out.push({ key: 'builtin:' + k, label: '找回 · ' + (GROUP_LABEL[k] || k), icon: 'satellite' }) }
  out.push({ sep: true }, { key: 'resetOrder', label: '恢复默认顺序', icon: 'undo-2' })
  return out
})
function setMenuItems(row) {
  const id = row.id, k = row.kind
  const order = satSets.order.value, idx = order.indexOf(id), n = order.length
  const head = [
    { key: 'solo', label: '仅显示这一集', icon: 'eye' },
    { key: 'focus', label: '聚焦', icon: 'crosshair' },
    { key: 'expand', label: expTag.value === id ? '收起成员' : '展开成员', icon: 'list' }
  ]
  if (k === 'search') return head.concat([{ sep: true }, { key: 'saveGroup', label: '存为卫星组', icon: 'folder-plus' }, { key: 'copy', label: '复制卫星', icon: 'copy' }, { sep: true }, { key: 'close', label: '关闭', icon: 'x' }])
  const clip = satClip.value
  const sel = selList.value.length
  const items = head.concat([
    { sep: true },
    { key: 'up', label: '上移', icon: 'arrow-up', disabled: idx <= 0 },
    { key: 'down', label: '下移', icon: 'arrow-down', disabled: idx < 0 || idx >= n - 1 },
    { sep: true },
    { key: 'rename', label: '重命名', icon: 'pencil' },
    { key: 'copy', label: '复制卫星', icon: 'copy' },
    clip ? { key: 'paste', label: k === 'group' ? '粘贴（加入本集）' : (k === 'custom' && clip.cfg) ? '粘贴星座副本' : '粘贴为新卫星组', icon: 'clipboard', hint: clip.label } : null,
    { key: 'saveGroup', label: '存为卫星组', icon: 'folder-plus' },
    { key: 'send', label: '发送到小程序…', icon: 'smartphone' },
    { sep: true }
  ])
  const hidden = satSets.hiddenOf(id).size
  const del = { key: 'delete', label: '删除', icon: 'trash', tone: 'danger' }
  if (k === 'builtin') items.push(
    hidden ? { key: 'unhide', label: `恢复剔除的 ${hidden} 颗`, icon: 'eye' } : null,
    (groupColors[id.slice(2)] || satSets.hasOverride(id)) ? { key: 'reset', label: '重置为出厂', icon: 'undo-2' } : null,
    del)
  if (k === 'group') items.push(
    { key: 'manage', label: '编辑成员…', icon: 'sliders-horizontal' },
    sel ? { key: 'addSel', label: `加入选中的 ${sel} 颗`, icon: 'plus' } : null,
    sel ? { key: 'rmSel', label: `移出选中的 ${sel} 颗`, icon: 'minus' } : null,
    { key: 'duplicate', label: '创建副本', icon: 'copy' },
    row.color ? { key: 'colorReset', label: '恢复默认颜色', icon: 'undo-2' } : null,
    del)
  if (k === 'import') items.push(
    hidden ? { key: 'unhide', label: `恢复剔除的 ${hidden} 颗`, icon: 'eye' } : null,
    { key: 'export', label: '导出…', icon: 'download' },
    row.color ? { key: 'colorReset', label: '恢复默认颜色', icon: 'undo-2' } : null,
    del)
  if (k === 'custom') items.push(
    { key: 'edit', label: '编辑…', icon: 'pencil' },
    { key: 'duplicate', label: '创建副本', icon: 'copy' },
    { key: 'export', label: '导出…', icon: 'download' },
    del)
  return items.filter(Boolean)
}
// 某一集的成员 [{noradId,name}]（内置组按需读名录；失败弹提示并返回 null）
async function setSatsOf(id) {
  const k = id[0], r = id.slice(2)
  try {
    if (id === 'q') return filterEntries.map((e) => ({ noradId: e.noradId, name: e.name }))
    if (k === 's') { const g = satGroups.find(r); return g ? g.sats.map((x) => ({ noradId: x.id, name: x.name })) : [] }
    if (k === 'c') return customConst.satsOf(r).map((e) => ({ noradId: e.noradId, name: e.name }))
    const hidden = satSets.hiddenOf(id)
    const list = k === 'i' ? await impSatList(r) : await grpSatList(r)
    return list.filter((it) => !hidden.has(String(it.id))).map((it) => ({ noradId: it.id, name: it.name }))
  } catch (e) { appAlert(`读取「${setName(id)}」的卫星名录失败：${(e && e.message) || e}`); return null }
}
async function setFocus(row) {
  status.value = `${row.name}：读取卫星名录…`
  const sats = await setSatsOf(row.id)
  if (!sats) { status.value = ''; return }
  if (!sats.length) { status.value = ''; appAlert(`「${row.name}」还没有卫星。`); return }
  expFocus(sats, row.name, row.id)
}
function pasteAsNewGroup(clip) {
  const g = satGroups.add(clip.sats, clip.label || '')
  if (g) { logMsg(`已粘贴为卫星组「${g.name}」：${g.sats.length} 颗`); registerSets(); toggleSet('s:' + g.id) }
}
function setPaste(row) {
  const clip = satClip.value; if (!clip) return
  const k = row.kind, r = row.id.slice(2)
  if (k === 'group') {
    const n = satGroups.append(r, clip.sats)
    const gg = satGroups.find(r)
    logMsg(n ? `已粘贴 ${n} 颗到卫星组「${row.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `剪贴板里的卫星都已在「${row.name}」中`)
    if (n) ensureSatGroupEntries(r)
    return
  }
  if (k === 'custom' && clip.cfg) {
    const cfg = customConst.add({ ...clip.cfg, name: clip.cfg.name + ' 副本' })
    logMsg(`已粘贴自定义星座「${cfg.name}」`)
    registerSets(); soloSet('c:' + cfg.id)
    return
  }
  pasteAsNewGroup(clip)
}
async function exportConst(id) {
  const c = customConst.list.value.find((x) => x.id === id); if (!c) return
  if (!apiOk || !window.api.omm.exportRecords) { status.value = '需在桌面客户端中运行'; return }
  try {
    const r = await window.api.omm.exportRecords(customConstellationsToOmmRecords(id), c.name, 'omm-csv')
    if (r && r.ok) logMsg(`导出「${c.name}」：${r.filePath}`)
    else if (r && !r.canceled) status.value = '导出失败：' + (r.error || '未知错误')
  } catch (e) { status.value = '导出失败：' + ((e && e.message) || e) }
}
async function setAction(key, row) {
  const id = row.id, k = row.kind, r = id.slice(2)
  if (key === 'solo') { soloSet(id); return }
  if (key === 'focus') { setFocus(row); return }
  if (key === 'expand') { expToggle(id, row.name); return }
  if (key === 'close') { clearSearch(); return }
  if (key === 'up') { satSets.moveBy(id, -1); return }
  if (key === 'down') { satSets.moveBy(id, 1); return }
  if (key === 'send') { sendSatsToMiniapp(); return }
  if (key === 'paste') { setPaste(row); return }
  if (key === 'colorReset') { setColorOf(row, ''); return }
  if (key === 'unhide') { satSets.unhide(id); applySetsChanged(); return }
  if (key === 'reset') { satSets.reset(id); if (k === 'builtin') resetGroupColor(r); applySetsChanged(); return }
  if (key === 'manage') { const g = satGroups.find(r); if (g) openSatGrpMgr(g); return }
  if (key === 'addSel') { const g = satGroups.find(r); if (g) addSelToGroup(g); return }
  if (key === 'rmSel') { const g = satGroups.find(r); if (g) removeSelFromGroup(g); return }
  if (key === 'edit') { const c = customConst.list.value.find((x) => x.id === r); if (c) openConstWizard(c); return }
  if (key === 'export') { if (k === 'import') { const g = importGroups.value.find((x) => x.id === r); if (g) impExport(g) } else if (k === 'custom') exportConst(r); return }
  if (key === 'duplicate') {
    if (k === 'group') { const c = satGroups.duplicate(r); if (c) { logMsg(`已复制卫星组「${row.name}」→「${c.name}」`); registerSets(); toggleSet('s:' + c.id) } }
    else if (k === 'custom') { const c = customConst.list.value.find((x) => x.id === r); if (c) { const cfg = customConst.add({ name: c.name + ' 副本', params: { ...c.params }, color: c.color, colorByPlane: c.colorByPlane !== false, design: c.design ? JSON.parse(JSON.stringify(c.design)) : undefined }); logMsg(`已复制自定义星座「${c.name}」→「${cfg.name}」`); registerSets(); soloSet('c:' + cfg.id) } }
    return
  }
  if (key === 'copy' || key === 'saveGroup') {
    const sats = await setSatsOf(id)
    if (!sats) return
    if (!sats.length) { appAlert(`「${row.name}」还没有卫星。`); return }
    if (key === 'copy') {
      const c = k === 'custom' ? customConst.list.value.find((x) => x.id === r) : null
      satClip.value = { label: row.name, sats, cfg: c ? { name: c.name, params: { ...c.params }, color: c.color, colorByPlane: c.colorByPlane !== false, design: c.design ? JSON.parse(JSON.stringify(c.design)) : undefined } : null }
      logMsg(`已复制「${row.name}」的 ${sats.length} 颗卫星`)
      return
    }
    const g = satGroups.add(sats, k === 'search' ? (filterKw.value ? '搜索 ' + filterKw.value : '') : row.name)
    if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); registerSets(); toggleSet('s:' + g.id) }
    return
  }
  if (key === 'delete') { setDelete(row) }
}
function setRename(row, name) {
  const k = row.kind, r = row.id.slice(2)
  if (k === 'builtin') { satSets.rename(row.id, name === (GROUP_LABEL[r] || r) ? '' : name); return }
  if (k === 'group') { satGroups.rename(r, name); return }
  if (k === 'custom') { customConst.update(r, { name }); return }
  if (k === 'import') { const g = importGroups.value.find((x) => x.id === r); if (g) { impRenameVal.value = name; impRenameId.value = g.id; impCommitRename(g) } }
}
async function setColorOf(row, hex) {
  const k = row.kind, r = row.id.slice(2)
  if (k === 'builtin') { if (hex) setGroupColor(r, hex); else resetGroupColor(r); return }
  if (k === 'group') { satGroups.setColor(r, hex || ''); return }
  if (k === 'custom') { customConst.update(r, hex ? { color: hex, colorByPlane: false } : { colorByPlane: true }); return }
  if (k === 'import') { const g = importGroups.value.find((x) => x.id === r); if (!g) return; if (hex) impSetColor(g, hex); else impResetColor(g) }
}
async function setDelete(row) {
  const k = row.kind, id = row.id, r = id.slice(2)
  expDrop(id)
  if (k === 'builtin') { satSets.drop(id, true); applySetsChanged(); logMsg(`已从卫星集里移除「${row.name}」（「＋」菜单可找回）`); return }
  if (k === 'group') { satSets.drop(id); satGroups.remove(r); registerSets(); applySetsChanged(); logMsg(`已删除卫星组「${row.name}」`); return }
  if (k === 'custom') { satSets.drop(id); customConst.remove(r); registerSets(); applySetsChanged(); logMsg(`已删除自定义星座「${row.name}」`); return }
  if (k === 'import') { const g = importGroups.value.find((x) => x.id === r); if (g) { satSets.drop(id); await impDelete(g) } }
}
function onAdd(key) {
  if (key === 'group') { openSatGrpMgr(); sgmNew(); return }
  if (key === 'wizard') { openConstWizard(); return }
  if (key === 'import') { importTleToLibrary(); return }
  if (key === 'finder') { openFinder(); return }
  if (key === 'resetOrder') { satSets.resetOrder(BUILTIN_KEYS.map((k) => 'g:' + k)); return }
  if (key.indexOf('builtin:') === 0) { const id = 'g:' + key.slice(8); satSets.restoreRemoved(id); satSets.toggle(id); applySetsChanged() }
}

// —— 「查找卫星」对话框：属性条件 + 关键词 → 结果表 → 显示为集 / 存为卫星组 / 加入组 ——
const finderOpen = ref(false)
const finderKw = ref('')
const finderTick = ref(0)
async function openFinder() {
  finderOpen.value = true
  if (!finderKw.value) finderKw.value = filterKw.value || keyword.value
  await ensureSearchPool(); await ensureSatcatIndex()
  finderTick.value++
}
const finderHits = computed(() => {
  void finderTick.value; void poolTick.value
  if (!finderOpen.value) return []
  const k = finderKw.value.trim().toLowerCase()
  const pred = makePredicate(satFilters, satcatIdx.value)
  if (!k && !pred) return []
  const out = [], seen = new Set()
  for (const en of searchSource()) {
    if (k && !(en.name.toLowerCase().includes(k) || String(en.noradId).includes(k) || (en.groupLabel && en.groupLabel.toLowerCase().includes(k)))) continue
    if (pred && !pred(en)) continue
    const nid = String(en.noradId); if (seen.has(nid)) continue
    seen.add(nid); out.push(en)
  }
  return out
})
const finderItems = computed(() => {
  const hits = finderHits.value, slotOk = hits.length <= 3000   // GEO 定点标注逐颗要传播一次：几千颗以内才做
  return hits.map((en) => expMkItem(en.noradId, en.name, `${en.name} · ${en.groupLabel || GROUP_LABEL[en.group] || ''} · NORAD ${en.noradId}`, '', slotOk && en.rec ? geoSlotOfSatrec(en.rec) : ''))
})
const finderGroups = computed(() => satGroups.list.value.map((g) => ({ id: g.id, name: g.name, count: g.sats.length })))
function finderLabel() {
  const f = normalizeFilters(satFilters), parts = []
  if (finderKw.value.trim()) parts.push(`「${finderKw.value.trim()}」`)
  if (f.owner) parts.push(ownerName(f.owner))
  if (f.type) parts.push(f.type)
  if (f.status) parts.push({ active: '运行', inactive: '停运', unknown: '未知', decayed: '已陨落' }[f.status] || f.status)
  if (f.orbit) parts.push(f.orbit)
  const rng = (a, b, u) => ((a != null || b != null) ? `${a ?? ''}–${b ?? ''}${u || ''}` : '')
  for (const t of [rng(f.launchFrom, f.launchTo, ''), rng(f.perigeeFrom, f.perigeeTo, ' km'), rng(f.apogeeFrom, f.apogeeTo, ' km'), rng(f.inclFrom, f.inclTo, '°'), rng(f.periodFrom, f.periodTo, ' min')]) if (t) parts.push(t)
  return parts.join(' · ')
}
function finderPick(items) {
  if (!items || !items.length) return finderHits.value
  const idx = new Map(finderHits.value.map((en) => [String(en.noradId), en]))
  return items.map((it) => idx.get(String(it.id))).filter(Boolean)
}
function finderShow(items) {
  const hit = finderPick(items)
  if (!hit.length) { appAlert('没有命中的卫星。'); return }
  keyword.value = ''; searchResults.value = []
  showSearchHits(hit, finderLabel())
  finderOpen.value = false
}
function finderSave(items) {
  const hit = finderPick(items)
  if (!hit.length) { appAlert('没有命中的卫星。'); return }
  const g = satGroups.add(hit.map((e) => ({ noradId: e.noradId, name: e.name })), finderLabel())
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); registerSets(); toggleSet('s:' + g.id) }
  finderOpen.value = false
}
function finderAddTo(g, items) {
  const sats = finderPick(items).map((e) => ({ noradId: e.noradId, name: e.name }))
  if (!sats.length) { appAlert('没有命中的卫星。'); return }
  if (!g) { const ng = satGroups.add(sats, finderLabel()); if (ng) { logMsg(`已存为卫星组「${ng.name}」：${ng.sats.length} 颗`); registerSets(); toggleSet('s:' + ng.id) } return }
  const n = satGroups.append(g.id, sats)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已加入 ${n} 颗到卫星组「${g.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `所选卫星都已在「${g.name}」中`)
  if (n) ensureSatGroupEntries(g.id)
}
function finderClear() { finderKw.value = ''; onSatFilterChange(emptyFilters()) }

// ===================== 卫星组管理器（新建 / 改名 / 复制 / 删除 + 搜索添加 + 成员移出） =====================
const sgmCur = computed(() => satGroups.list.value.find((g) => g.id === sgmId.value) || null)
const sgmPickIds = computed(() => new Set(sgmPick.value.map((s) => s.id)))
const sgmMemIds = computed(() => new Set((sgmCur.value ? sgmCur.value.sats : []).map((s) => s.id)))
const sgmSelIds = computed(() => new Set(sgmSel.value))
// 成员表：组里存的是 { NORAD, 名称 } 快照，故即使卫星已不在当前星历（未联网/已退役）也照样列得出来，
// 只是标注「未在当前星历」——查/删不依赖星历，避免「看不见就管不了」。
const sgmMembers = computed(() => {
  const g = sgmCur.value; if (!g) return []
  const k = sgmMemKw.value.trim().toLowerCase(), pool = sgmPool.value
  return g.sats
    .filter((s) => !k || (s.name || '').toLowerCase().includes(k) || s.id.includes(k))
    .map((s) => ({ id: s.id, name: s.name || ('NORAD ' + s.id), color: s.color || '', groupLabel: pool.get(s.id) || '', inPool: pool.has(s.id), slot: slotByNorad(s.id) }))
})
// —— 组着色（管理器）：快捷调色板（借自定义星座轨道面十色）+ 取色器 + 恢复默认（组色与逐颗覆盖一并清） ——
const SGM_PALETTE = customConst.PLANE_PALETTE
const sgmHasAnyColor = computed(() => { const g = sgmCur.value; return !!(g && (g.color || g.sats.some((s) => s.color))) })
function sgmResetAllColor() {
  const g = sgmCur.value; if (!g || !sgmHasAnyColor.value) return
  satGrpColorSats(g, g.sats.map((s) => s.id), '')
  satGrpResetColor(g)
}
// 打开时按当前星历快照一份 NORAD→分组标签（成员表标注用；不做响应式跟随，够用且不拖慢）
async function sgmSnapPool() {
  await ensureSearchPool()
  const m = new Map()
  for (const en of searchSource()) { const nid = String(en.noradId); if (!m.has(nid)) m.set(nid, en.groupLabel || GROUP_LABEL[en.group] || '') }
  sgmPool.value = m
}
function openSatGrpMgr(g) {
  sgmDelId.value = ''; sgmKw.value = ''; sgmRes.value = []; sgmPick.value = []; sgmSel.value = []; sgmMemKw.value = ''
  const want = (g && g.id) || sgmId.value
  const hit = satGroups.list.value.find((x) => x.id === want) || satGroups.list.value[0] || null
  sgmId.value = hit ? hit.id : ''
  sgmNameVal.value = hit ? hit.name : ''
  sgmOpen.value = true
  sgmSnapPool()
}
function closeSatGrpMgr() { sgmOpen.value = false; if (sgmTimer) { clearTimeout(sgmTimer); sgmTimer = null } }
function sgmFocusName() { nextTick(() => { try { const el = sgmNameEl.value; if (el) { el.focus(); el.select() } } catch { /* ignore */ } }) }
watch(sgmId, (id) => { const g = satGroups.find(id); sgmNameVal.value = g ? g.name : '' })
function sgmPickGroup(g) {
  if (sgmId.value === g.id) return
  sgmId.value = g.id; sgmSel.value = []; sgmMemKw.value = ''; sgmDelId.value = ''
}
function sgmNew() {
  const g = satGroups.create('')
  sgmId.value = g.id; sgmSel.value = []; sgmMemKw.value = ''; sgmDelId.value = ''
  logMsg(`已新建空卫星组「${g.name}」`)
  sgmFocusName()
}
function sgmCommitName() {
  const g = sgmCur.value; if (!g) return
  satGroups.rename(g.id, sgmNameVal.value)
}
function sgmDup(g) {
  const c = satGroups.duplicate(g.id)
  if (c) { sgmId.value = c.id; sgmSel.value = []; sgmMemKw.value = ''; logMsg(`已复制卫星组「${g.name}」→「${c.name}」`) }
}
function sgmDel(g) {
  if (sgmDelId.value !== g.id) { sgmDelId.value = g.id; return }
  expDrop('s:' + g.id); satSets.drop('s:' + g.id)
  satGroups.remove(g.id)
  registerSets(); applySetsChanged()
  sgmDelId.value = ''
  if (sgmId.value === g.id) { const f = satGroups.list.value[0]; sgmId.value = f ? f.id : ''; sgmSel.value = []; sgmMemKw.value = '' }
}
// 「搜索添加」：直接搜全量在轨目录（跨分组，与地图上显示的是哪一组无关）
function sgmOnSearch() {
  if (sgmTimer) { clearTimeout(sgmTimer); sgmTimer = null }
  const k = sgmKw.value.trim()
  if (!k) { sgmRes.value = []; sgmBusy.value = false; return }
  sgmBusy.value = true
  sgmTimer = setTimeout(async () => {
    sgmTimer = null
    try {
      await ensureSearchPool()
      if (!sgmPool.value.size) await sgmSnapPool()
      if (sgmKw.value.trim() !== k) return   // 等待期间用户又改了词 → 本次结果作废
      const kk = k.toLowerCase(), out = [], seen = new Set()
      // 管理器的搜索结果同样受筛选条约束（与侧栏共用一份 satFilters）
      const pred = makePredicate(satFilters, satcatIdx.value)
      for (const en of searchSource()) {
        if (out.length >= SGM_MAX) break
        if (!(en.name.toLowerCase().includes(kk) || String(en.noradId).includes(kk) || (en.groupLabel && en.groupLabel.toLowerCase().includes(kk)))) continue
        if (pred && !pred(en)) continue
        const nid = String(en.noradId); if (seen.has(nid)) continue
        seen.add(nid); out.push({ id: nid, name: en.name, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || '', slot: geoSlotOfSatrec(en.rec) })
      }
      sgmRes.value = out
    } finally { if (sgmKw.value.trim() === k) sgmBusy.value = false }
  }, 220)
}
// 管理器里改筛选：落库 + 重跑管理器搜索 + 同步侧栏那一路（两处是同一份筛选）
function onSgmFilterChange(next) {
  onSatFilterChange(next)
  sgmOnSearch()
}
function sgmTogglePick(it) {
  const i = sgmPick.value.findIndex((s) => s.id === it.id)
  if (i >= 0) sgmPick.value.splice(i, 1)
  else sgmPick.value.push({ id: it.id, name: it.name })
}
function sgmPickAllRes() {
  const have = sgmPickIds.value, mem = sgmMemIds.value, add = []
  for (const it of sgmRes.value) if (!have.has(it.id) && !mem.has(it.id)) add.push({ id: it.id, name: it.name })
  if (add.length) sgmPick.value = [...sgmPick.value, ...add]
}
function sgmAddPick() {
  const g = sgmCur.value
  if (!g) { appAlert('先在左侧新建或选中一个卫星组'); return }
  if (!sgmPick.value.length) { appAlert('尚未勾选要加入的卫星。'); return }
  const n = satGroups.append(g.id, sgmPick.value)
  logMsg(n ? `已加入 ${n} 颗到卫星组「${g.name}」（去重后共 ${g.sats.length} 颗）` : `勾选的卫星都已在「${g.name}」中`)
  sgmPick.value = []
  if (n) ensureSatGroupEntries(g.id)
}
function sgmToggleMem(id) {
  const i = sgmSel.value.indexOf(id)
  if (i >= 0) sgmSel.value.splice(i, 1); else sgmSel.value.push(id)
}
// 全选/反选：只针对当前过滤后可见的成员
function sgmToggleMemAll() {
  const vis = sgmMembers.value.map((m) => m.id)
  if (!vis.length) return
  const on = new Set(sgmSel.value)
  const allOn = vis.every((id) => on.has(id))
  if (allOn) { const kill = new Set(vis); sgmSel.value = sgmSel.value.filter((id) => !kill.has(id)) }
  else { vis.forEach((id) => on.add(id)); sgmSel.value = [...on] }
}
function sgmRemoveMem(ids) {
  const g = sgmCur.value; if (!g) return
  const kill = (ids || []).filter(Boolean)
  if (!kill.length) { appAlert('先勾选要移出的卫星'); return }
  const n = satGroups.removeSats(g.id, kill)
  const killSet = new Set(kill)
  sgmSel.value = sgmSel.value.filter((id) => !killSet.has(id))
  logMsg(n ? `已从卫星组「${g.name}」移出 ${n} 颗（剩 ${g.sats.length} 颗）` : '所选卫星不在该组中')
  if (n) ensureSatGroupEntries(g.id)
}
function sgmShow() {
  const g = sgmCur.value; if (!g) return
  if (!g.sats.length) { appAlert('该组还没有卫星。'); return }
  closeSatGrpMgr(); soloSet('s:' + g.id)   // 管理器里「显示该组」= 仅显示这一集（顶部标签可还原叠加）
}

// ===================== 覆盖圈（波束角 / 最低仰角） =====================
// 波束角/最低仰角是用户设置：控件常驻、换星不清空手动输入值；仅清与所选星绑定的上限占位。
// 锁定含义收敛为「超出该星上限时不回写夹断值」。
function resetBeam() { beamAuto.value = '' }
function refreshFootprint() { if (selEntries.length) commitGeometry() }   // beam/仰角改动 → 重算全体足迹（含可见性叠加层，若开）
// 覆盖圈口径两格（波束全锥角 / 最低仰角）：【失焦或回车】才生效，不逐键即时重算。
// 逐键重算的代价随聚焦颗数走：输「25」会先按「2」把全体覆盖圈算一遍，而 2° 的圈比 25° 大得多、更贵，
// 那个中间值又根本不是用户想看的。草稿只顶住框里的原文，不碰状态 —— 也顺带治了「本组件有秒级时间读数、
// 实时/播放时每秒重渲染，Vue 对 value 无条件回写会把半截输入改掉」那个老毛病（同 satPosEdit 的口径）。
const fpEdit = ref(null)              // { k:'beam'|'elev', text }：只存正在编辑的那一格
const fpVal = (k) => { const d = fpEdit.value; return d && d.k === k ? d.text : (k === 'beam' ? beam.value : elevMin.value) }
function fpInput(k, e) { fpEdit.value = { k, text: e.target.value } }
function fpCommit(k) {
  const d = fpEdit.value
  fpEdit.value = null
  if (!d || d.k !== k) return
  const cur = k === 'beam' ? beam.value : elevMin.value
  if (d.text === cur) return          // 值没变就不重算：回车提交后再失焦不会白算第二遍
  if (k === 'beam') beam.value = d.text; else elevMin.value = d.text
  refreshFootprint()
}
// 轨迹长度两格（圈数 / 时长）：与覆盖圈口径同一套「草稿 + 失焦/回车提交」（逐键重算会按半截数字把全体轨迹重铺一遍）。
// 任意正数都收（全角数字先归一），非数 / 非正 → 原值不动。
const trkEdit = ref(null)             // { k:'rev'|'time', text }
const trkVal = (k) => {
  const d = trkEdit.value
  if (d && d.k === k) return d.text
  const v = Number(k === 'rev' ? focusStyle.trkPeriods : focusStyle.trkSpanMin)
  return v > 0 ? String(+v.toFixed(3)) : ''
}
function trkInput(k, e) { trkEdit.value = { k, text: e.target.value } }
function trkCommit(k) {
  const d = trkEdit.value
  trkEdit.value = null
  if (!d || d.k !== k) return
  const v = pf(d.text)
  if (!(v > 0)) return
  if (k === 'rev') { if (v === focusStyle.trkPeriods) return; focusStyle.trkPeriods = v }
  else { if (v === focusStyle.trkSpanMin) return; focusStyle.trkSpanMin = v }
  applyFocusGeom()
}
// 切换长度口径：按主选星周期把当前长度换算到另一档，切换前后画的轨迹不变（没有聚焦星时各留各的值）
function setTrkSpanMode(m) {
  if (m !== 'time') m = 'rev'
  if (focusStyle.trkSpanMode === m) return
  const pMin = periodMinOf(selEntry) || 0        // 星历星走表内升交点估计
  if (pMin > 0) {
    if (m === 'time') { const r = Number(focusStyle.trkPeriods); focusStyle.trkSpanMin = +((r > 0 ? r : 1) * pMin).toFixed(1) }
    else { const t = Number(focusStyle.trkSpanMin); if (t > 0) focusStyle.trkPeriods = +(t / pMin).toFixed(3) }
  } else if (m === 'time' && !(Number(focusStyle.trkSpanMin) > 0)) focusStyle.trkSpanMin = 100
  trkEdit.value = null
  focusStyle.trkSpanMode = m
  applyFocusGeom()
}
// 波束全锥角 B(°) ↔ 最低仰角 ε(°)：同一覆盖圈的两种参数化，由卫星高度 h 唯一对应。
//   sin(B/2) = (RE/r)·cos ε，r=RE+h；B/2 ≥ asin(RE/r)（地平）时 ε=0。切换定义方式时按此换算，覆盖圈不变。
function selAltKm() {
  if (!selEntry) return null
  const now = isCustomEntry(selEntry) ? ccTimeAt() : calcAt(); const pv = posAt(selEntry, now)
  if (!pv || !pv.position) return null
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(now))
  return gd.height > 0 ? gd.height : null
}
function beamToElevDeg(Bdeg, h) {
  const x = ((RE + h) / RE) * Math.sin((Bdeg / 2) * DEG)
  return x >= 1 ? 0 : Math.acos(clamp(x, -1, 1)) / DEG          // 达/超地平 → ε=0
}
function elevToBeamDeg(eDeg, h) {
  return 2 * Math.asin(clamp((RE / (RE + h)) * Math.cos(eDeg * DEG), -1, 1)) / DEG
}
// 切换波束角/最低仰角：用聚焦星当前高度把当前值换算到另一参数，二者始终描述同一覆盖圈
function setFpMode(m) {
  if (fpMode.value === m) return
  fpEdit.value = null                 // 两格是 v-if/v-else，切换时旧输入框直接卸载、不会触发 blur → 草稿在这里作废
  const h = selAltKm()
  if (h != null) {
    const bMax = 2 * Math.asin(clamp(RE / (RE + h), -1, 1)) / DEG
    if (m === 'elev') {
      const b = parseFloat(beam.value)
      const Bdeg = b > 0 ? Math.min(b, bMax) : bMax             // beam 空=对地全视场=地平
      elevMin.value = beamToElevDeg(Bdeg, h).toFixed(1)
    } else {
      const ev = parseFloat(elevMin.value)
      const e = ev >= 0 && ev < 90 ? ev : 0
      beam.value = e <= 0 ? '' : elevToBeamDeg(e, h).toFixed(1)  // ε=0 → 全视场，回落到「自动」空值
    }
  }
  fpMode.value = m
  refreshFootprint()
}
function toggleBeamLock() { beamLock.value = !beamLock.value }
// 聚焦图例文案：标注当前覆盖圈的定义方式与取值，截图脱离 UI 也自明
const fpLegend = computed(() => {
  if (fpMode.value === 'elev') { const v = parseFloat(elevMin.value); return `覆盖范围 · 最低仰角 ${v >= 0 && v < 90 ? v : 0}°` }
  const b = beam.value || beamAuto.value
  return b ? `覆盖范围 · 波束角 ${b}°` : '覆盖范围'
})
// 轨迹图例：轨迹面档带上口径（带宽就是这个口径扫出来的），轨迹线档只写名字
const trkLegend = computed(() => {
  if (focusStyle.trkMode !== 'swath') return '星下点轨迹'
  if (fpMode.value === 'elev') { const v = parseFloat(elevMin.value); return `轨迹面 · 最低仰角 ${v >= 0 && v < 90 ? v : 0}°` }
  const b = beam.value || beamAuto.value
  return b ? `轨迹面 · 波束角 ${b}°` : '轨迹面'
})
// 信息卡「轨迹周期」：星下点轨迹实际画了几圈、合多长时间（圈数受多选时的采样预算约束，与图上画的一致）
const trkSpan = computed(() => {
  const c = selected.value
  if (!c || !(c.periodMinRaw > 0)) return null
  const n = Math.max(1, selList.value.length)
  const per = focusTrackPeriods(n, focusLod(n).samples, c.periodMinRaw)
  const min = per * c.periodMinRaw
  const f = min < 180 ? [min.toFixed(1), 'min'] : min < 72 * 60 ? [(min / 60).toFixed(2), 'h'] : [(min / 1440).toFixed(2), 'd']
  return { rev: +per.toFixed(2), v: f[0], u: f[1] }
})
// 图例色条：跟着显示设置取色与线型（点线在 18px 的短条上按 dotted 画，观感与图上一致）
// 点划线在 18px 的短条上画不出「长划-点」的节奏，退回 dashed（观感上仍是断线，与实线/点线可分）
const swStyle = (color, dash) => ({ borderColor: color, borderTopStyle: dash === 'dot' ? 'dotted' : (dash === 'dash' || dash === 'dashdot') ? 'dashed' : 'solid' })
const fpSwStyle = computed(() => swStyle(focusStyle.fpColor, focusStyle.fpDash))
// 轨迹面档的色条是一条「带」：上下两缘按线样式描，带内按填充色与透明度铺
const trkSwStyle = computed(() => {
  const s = swStyle(focusStyle.trkColor, focusStyle.trkDash)
  if (focusStyle.trkMode !== 'swath') return s
  const c = String(focusStyle.trkFillColor || '#e8c074').replace('#', '')
  const r = parseInt(c.slice(0, 2), 16) || 0, gg = parseInt(c.slice(2, 4), 16) || 0, b = parseInt(c.slice(4, 6), 16) || 0
  return { ...s, borderBottomStyle: s.borderTopStyle, backgroundColor: `rgba(${r},${gg},${b},${clamp(Number(focusStyle.trkFillOpacity) || 0, 0, 1)})` }
})

// ===================== 时间轴 =====================
const track = ref(null)
// —— 可配置时间窗 + 自适应刻度尺（参考 Cesium Timeline / DAW scrubber）——
const PAST_FRAC = 0.25                                   // 窗口内展示的「过去」占比（可回看过去）
// 跨度上下限：2min ~ 30 天。★下限压到 2 min 是为了游标的秒级——600 px 上 2 min ＝ 0.2 s/px，
// 拖动吸附随之细到 1 s（见 scrubSnapSec）；原来的 10 min 下限只能吸到 5~10 s。
const WIN_MIN = 2, WIN_MAX = 43200
// 时间窗预设。★ 只是【下拉里的常用档】，不是可选跨度的全集 —— 滚轮照样缩放到 2 min ~ 30 天之间任意值，
// 落到预设之外就在下拉里挂一条自定义档（isCustomWindow）。
const WINDOW_PRESETS = [{ v: 720, l: '12h' }, { v: 1440, l: '24h' }, { v: 2880, l: '2d' }, { v: 4320, l: '3d' }, { v: 10080, l: '7d' }]
const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 14400, 21600, 43200, 86400, 172800, 345600, 604800]   // 「整齐」刻度阶梯(秒)；10800 = 3h 档
// —— 时间轴读数时区：'local'（本机，默认）| 'utc' | 数字（相对 UTC 的固定偏移，分钟）——
// 只影响【显示】：Date 内部是 UTC 毫秒数，星位/晨昏线全程走 getUTC*，换档不改变任何计算结果。
// 加它是因为晨昏线、星历历元、过境窗口都是 UTC 口径，对国际时刻时需要直接读 UTC 而不是心算 −8；
// 固定偏移档则用于对着别的时区（落地站所在国、境外测控站）读时间轴。档位口径见 shared/tz.js。
const tzMode = ref('local')
// 一组「按当前档位取分量」的读数器：平移到「墙钟落在 UTC 字段上」再读 getUTC*，
// 一条路径同时覆盖 UTC / 本机 / 任意固定偏移（原来那种 utc?getUTC*:get* 的两分支在固定档下必错）
const tD = (d) => new Date(d.getTime() + tzOffMin(tzMode.value, d.getTime()) * 60000)
const tYear = (d) => tD(d).getUTCFullYear()
const tMon = (d) => tD(d).getUTCMonth()
const tDay = (d) => tD(d).getUTCDate()
const tHour = (d) => tD(d).getUTCHours()
const tMin = (d) => tD(d).getUTCMinutes()
const tSec = (d) => tD(d).getUTCSeconds()
// 当前档位角标（如 UTC / UTC+8）：本机档按当刻实际偏移取，夏令时与半时区都能如实标出
const tzLabel = computed(() => { void tzMode.value; return tzTag(tzMode.value, clock.tMs) })
// —— 刻度尺 v3（精密仪器）——
// 标签贴在各自刻线右侧 3px；刻度分三级（带字长刻线 / 6px 次刻 / 3px 细刻），只靠长短与灰阶区分。
// 主步长按【实测字宽】取（界面字体用户可改，不能按字符数估），标签最小间距 56px；多级格式同 OpenMCT：
// 主步长 ≥ 1 天或逢该档位午夜 → MM-DD（日界），否则 ≥ 1 min → HH:MM，否则 HH:MM:SS。
const LAB_PAD = 3, LAB_GAP = 6, FLIP_GAP = 16, LAB_MIN_STEP = 56, MID_MIN_PX = 14, TINY_MIN_PX = 6, TXT_CLEAR = 3, PIN_CLEAR = 4
const _lw = new Map(); let _lwCtx = null
function labW(s, stack) {                     // 10px 标签的实测宽（含 letter-spacing .01em）；按「字体|串」缓存
  const k = stack + '|' + s
  let w = _lw.get(k)
  if (w == null) {
    if (_lw.size > 500) _lw.clear()
    _lwCtx = _lwCtx || document.createElement('canvas').getContext('2d')
    _lwCtx.font = '10px ' + stack
    w = _lwCtx.measureText(s).width + 0.1 * s.length
    _lw.set(k, w)
  }
  return w
}
const _c1 = new Map()
function roC1Em(stack) {                      // 读数列 1 的定宽（em）：6×最宽数字 + 2×冒号 + 8×字距 —— 比例数字字体（Georgia 等）也不会逐帧变宽
  let v = _c1.get(stack)
  if (v == null) {
    _lwCtx = _lwCtx || document.createElement('canvas').getContext('2d')
    _lwCtx.font = '100px ' + stack
    let dg = 0
    for (let i = 0; i < 10; i++) dg = Math.max(dg, _lwCtx.measureText(String(i)).width)
    v = Math.ceil((6 * dg + 2 * _lwCtx.measureText(':').width) / 100 * 1000 + 8 * 10) / 1000
    _c1.set(stack, v)
  }
  return v
}
// o: { anchorMs, wStart, wMin, W, hp, snapX, tzOffMin(ms), parts(ms)→{mo,d,h,mi,s}, lw(s), nowX|null, pinX|null, tagSides: [] | ['r','l'] | ['l'] | ['r'], tagW }
// 返回 { labels:[{x,label,day,flip,st}], poles:[{x,day}], majors:[x], mids:[x], tinies:[x], tag:'l'|'r'|null }，x 均已落整设备像素
function computeRuler(o) {
  const { W } = o, p2 = (n) => String(n).padStart(2, '0')
  const span = o.wMin * 60, leftMs = o.anchorMs + o.wStart * 60000
  // 以左边缘所在日的午夜为对齐基准。★必须跟着 tzMode 走（UTC / 固定偏移档下按本地午夜对齐，刻度落在碎数上）
  const off = o.tzOffMin(leftMs) * 60000, d0 = new Date(leftMs + off)
  const epoch = (Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()) - off) / 1000
  const start = leftMs / 1000 - epoch, end = start + span, pps = W / span
  const pick = (w) => NICE.find((s) => s * pps >= Math.max(w + LAB_PAD + 12, LAB_MIN_STEP)) || NICE[NICE.length - 1]
  let main = pick(o.lw('00:00'))
  if (main < 60) main = pick(o.lw('00:00:00'))
  const div = (m, minPx) => { for (let i = NICE.indexOf(m) - 1; i >= 0; i--) { const s = NICE[i]; if (m % s === 0 && s * pps >= minPx && m / s <= 6) return s } return 0 }
  const mid = div(main, MID_MIN_PX), tiny = div(mid || main, TINY_MIN_PX)
  const px = (t) => o.snapX((t - start) * pps)
  const on = (t, s) => Math.abs(t / s - Math.round(t / s)) < 1e-9
  const cands = []
  for (let t = Math.ceil(start / main) * main; t <= end + 1e-6; t += main) {
    const x = px(t)
    if (x < 0 || x > W) continue
    const q = o.parts((epoch + t) * 1000), day = q.h === 0 && q.mi === 0 && q.s === 0
    const label = main >= 86400 || day ? `${p2(q.mo)}-${p2(q.d)}` : main >= 60 ? `${p2(q.h)}:${p2(q.mi)}` : `${p2(q.h)}:${p2(q.mi)}:${p2(q.s)}`
    cands.push({ x, label, day, w: o.lw(label) })
  }
  // 障碍：此刻线（含停在此刻时与它重合的游标）、实时档钉在 25% 的游标 —— 字与它们至少隔 3 / 4px，线永不穿字
  const obs = []
  if (o.nowX != null) obs.push([o.nowX - TXT_CLEAR, o.nowX + o.hp + TXT_CLEAR])
  if (o.pinX != null) obs.push([o.pinX - PIN_CLEAR, o.pinX + PIN_CLEAR])
  // taken: [左, 右, 左侧须留的空]。翻到刻线左侧的日界标签左边多留（FLIP_GAP）：否则「12:00  09-24|」读成一个时刻
  const taken = []
  const clearOf = (a, b, gapL) => taken.every(([l, r, gl]) => b + Math.max(LAB_GAP, gl) <= l || a - gapL >= r)
  const free = (a, b, gapL = LAB_GAP) => a >= 0 && b <= W && obs.every(([l, r]) => b <= l || a >= r) && clearOf(a, b, gapL)
  const labels = [], poles = [], majors = []
  const put = (c, side) => labels.push({ x: c.x, label: c.label, day: c.day, flip: side === 'l',
    st: side === 'l' ? { right: (W - c.x + LAB_PAD) + 'px' } : { left: (c.x + LAB_PAD) + 'px' } })
  // ① 日界：先右；右边被此刻 / 钉住的游标 / 右端占了就翻到刻线左侧；两边都不行才不写字 —— 日界刻线无论如何保持全高
  for (const c of cands) {
    if (!c.day) continue
    const R = [c.x + LAB_PAD, c.x + LAB_PAD + c.w], L = [c.x - LAB_PAD - c.w, c.x - LAB_PAD]
    const side = free(R[0], R[1]) ? 'r' : free(L[0], L[1], FLIP_GAP) ? 'l' : null
    if (side) { taken.push(side === 'r' ? [R[0], R[1], LAB_GAP] : [L[0], L[1], FLIP_GAP]); put(c, side) }
    poles.push({ x: c.x, day: true })
  }
  // ② 其余主刻：只挂右侧；放不下就退成 10px 短主刻
  for (const c of cands) {
    if (c.day) continue
    const R = [c.x + LAB_PAD, c.x + LAB_PAD + c.w]
    if (free(R[0], R[1])) { taken.push([R[0], R[1], LAB_GAP]); put(c, 'r'); poles.push({ x: c.x, day: false }) }
    else majors.push(c.x)
  }
  // ③「此刻」最后放、只让不抢：刻度标签一个都不因它挪动（它换边 / 隐现时尺上别的字纹丝不动）
  let tag = null
  if (o.nowX != null) {
    const n = o.nowX, box = { r: [n + o.hp + LAB_PAD, n + o.hp + LAB_PAD + o.tagW], l: [n - LAB_PAD - o.tagW, n - LAB_PAD] }
    for (const s of o.tagSides) { const [a, b] = box[s]; if (a >= 0 && b <= W && clearOf(a, b, LAB_GAP)) { tag = s; break } }
  }
  const mids = [], tinies = []
  if (mid) for (let t = Math.ceil(start / mid) * mid; t <= end + 1e-6; t += mid) if (!on(t, main)) mids.push(px(t))
  if (tiny) for (let t = Math.ceil(start / tiny) * tiny; t <= end + 1e-6; t += tiny) if (!on(t, mid || main)) tinies.push(px(t))
  return { labels, poles, majors, mids, tinies, tag }
}
const winEndMin = computed(() => winStartMin.value + windowMin.value)
const isCustomWindow = computed(() => !WINDOW_PRESETS.some((w) => w.v === windowMin.value))
function fmtSpan(min) {
  // 先把总时长取整到小时再拆天：零头小时单独取整会进位成 24（滚轮 4320×1.15ⁿ 到 11491 min 读成「7d24h」）
  if (min >= 1440) { const hT = Math.round(min / 60), d = Math.floor(hT / 24), rh = hT % 24; return rh ? `${d}d${rh}h` : `${d}d` }
  const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`
}
const customWinLabel = computed(() => fmtSpan(windowMin.value))
// 对星指标表窗口的时刻读数：取【时间轴游标】calcAt()，不是系统时钟（与晨昏线/可见性同口径）
const timeText = computed(() => {
  void tzMode.value
  const d = new Date(clock.tMs), p = (n) => String(n).padStart(2, '0')
  return `${tYear(d)}-${p(tMon(d) + 1)}-${p(tDay(d))} ${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))} ${tzLabel.value}`
})

// 悬停幽灵线 + 时间气泡（落点前先预览该处对应时间）
const hoverShow = ref(false), hoverX = ref(0), hoverF = ref(0)   // hoverF：指针在轨道上的比例（尺子在静止指针底下平移 / 缩放时，时刻片跟着现算）
const scrubbing = ref(false)   // 拖游标中：悬停影线 / 时刻提示让位给播放头本身（两根线一左一右跟着指针错位，读起来就是抖）
function onHover(e) {
  if (!track.value || scrubbing.value) return          // 拖动中影线 / 时刻片让位给游标本身（捕获期间 pointermove 也会进来）
  const r = track.value.getBoundingClientRect()
  if (Math.abs(r.left - trackLeft.value) > 0.01) trackLeft.value = r.left   // 位置自愈：ResizeObserver 只报尺寸不报位置
  const x = clamp(e.clientX - r.left, 0, r.width), f = r.width ? x / r.width : 0
  hoverX.value = snapX(x); hoverF.value = f; hoverShow.value = true
}
function onLeave() { hoverShow.value = false }
// 时刻片显示的就是【点下去会落的时刻】：与 trackToMs 同一吸附。按指针比例现算（不在 pointermove 里存串）——
// 实时档锚点每秒滑、播放中窗口翻页 / 滑动、键盘步进、滚轮缩放都会让尺子在静止的指针底下动，存下的串就过期了
const hoverLabel = computed(() => {
  if (!hoverShow.value) return ''
  const q = tzParts(snapMs(baseTime.value + (winStartMin.value + hoverF.value * windowMin.value) * 60000, snapSec.value * 1000), tzMode.value), p = (n) => String(n).padStart(2, '0')
  return `${p(q.mo)}-${p(q.d)} ${p(q.h)}:${p(q.mi)}:${p(q.s)}`
})
// 时刻片在标签行内（不再浮到地图上）：按实测宽夹在轨道两端之内
const tipLeft = computed(() => { const w = labW('00-00 00:00:00', uiFont.stack) + 10; return clamp(hoverX.value - w / 2, 0, Math.max(0, trackWidthPx.value - w)) })
// 时刻片压到的刻度标签 / 「此刻」整枚让掉（visibility，连衬底一起）—— 不留「09-」「12:0」半截字，也不在片外留一块
// 遮游标针的空白衬底。盒子与 computeRuler 同口径（左右各含 2px 衬底，再放 1px 量宽余量）。
// 返回串（让掉的标签序号，t = 此刻），只在片滑过标签边界时变 → 刻度层的 v-memo 平时照样整段跳过
const tipHideKey = computed(() => {
  if (!hoverShow.value || scrubbing.value) return ''
  const stack = uiFont.stack, a = tipLeft.value, b = a + labW('00-00 00:00:00', stack) + 10, rl = ruler.value, out = []
  const hit = (x0, x1) => x1 + 3 > a && x0 - 3 < b
  rl.labels.forEach((q, i) => { const w = labW(q.label, stack), x0 = q.flip ? q.x - LAB_PAD - w : q.x + LAB_PAD; if (hit(x0, x0 + w)) out.push(i) })
  if (rl.tag && nowX.value != null) { const w = Math.max(labW('此刻', stack), labW('Now', stack)), n = nowX.value + (rl.tag === 'r' ? hpPx.value + LAB_PAD : -LAB_PAD - w); if (hit(n, n + w)) out.push('t') }
  return out.join(',')
})
const tipHide = computed(() => new Set(tipHideKey.value ? tipHideKey.value.split(',') : []))
// 时刻片与握柄（±hdw/2）横向相交 → 握柄让掉；只在布尔翻转时改 class，逐帧仍只写 --ph-x
const tipOverHd = computed(() => {
  if (!hoverShow.value || scrubbing.value) return false
  const a = tipLeft.value, b = a + labW('00-00 00:00:00', uiFont.stack) + 10, h = Math.round(4 * hairDpr.value) / hairDpr.value
  return b + 1 > phX.value - h && a - 1 < phX.value + h   // 1px：片宽是 canvas 估的（DOM 里 tabular-nums 可能略宽）
})
// 刻度线 / 此刻线 / 游标针落整设备像素：1px 在 125% / 150% 缩放下是 1.25 / 1.5 设备像素，
// 被抗锯齿摊成深浅两列。宽度取「1 设备像素」折回 CSS px（游标针取 ≥2 设备像素，约等于原 1.5px）。
const hairDpr = ref(window.devicePixelRatio || 1)
// --hp = 1 设备像素、--php = 游标针（≥2 设备像素）、--hdw/--hdh = 握柄 12×9 设备像素（150%；100% 下 8×6，= 原三角尺寸）
const trackVars = computed(() => {
  const d = hairDpr.value, dev = (n) => Math.ceil(1e4 * n / d) / 1e4 + 'px'
  return { '--hp': dev(1), '--php': dev(Math.max(2, Math.round(1.5 * d))), '--hdw': dev(2 * Math.round(4 * d)), '--hdh': dev(Math.round(6 * d)) }
})
const trackLeft = ref(0)
// 轨道尺寸 / 位置 / dpr 一处量：宽用带小数的 getBoundingClientRect（原 clientWidth 取整，游标与指针差出小数像素）
function measureTrack() {
  hairDpr.value = window.devicePixelRatio || 1
  const el = track.value
  if (!el) return
  const r = el.getBoundingClientRect()
  trackLeft.value = r.left
  if (r.width) trackWidthPx.value = r.width
}
function onHairDpr() { measureTrack() }
// 轨道内坐标 → 落在整设备像素上的坐标（轨道左缘本身可能落在半设备像素上，故按绝对位置取整）
const snapX = (x) => { const d = hairDpr.value, l = trackLeft.value; return Math.round((l + x) * d) / d - l }
const hpPx = computed(() => Math.ceil(1e4 / hairDpr.value) / 1e4)
const phX = computed(() => snapX(clamp01((offMin.value - winStartMin.value) / windowMin.value) * trackWidthPx.value))   // 游标（逐帧）
const nowX = computed(() => {   // 此刻线；窗外为 null。取整后的数：只有跨过一个设备像素才往下游触发
  const W = trackWidthPx.value, x = ((nowStamp.value - baseTime.value) / 60000 - winStartMin.value) / windowMin.value * W
  return x >= 0 && x <= W ? snapX(x) : null
})
const nowInWin = computed(() => !live.value && nowX.value != null)   // 实时时游标即此刻，不另画红线
const pinX = computed(() => live.value ? snapX(clamp01(-winStartMin.value / windowMin.value) * trackWidthPx.value) : null)   // 实时档游标钉住的位置（不随时钟逐拍抖）
// 「此刻」挂哪边：停在此刻先右后左；离开此刻只挂游标反侧。取原始串 —— Vue 3.4+ 的 computed 值不变不往下游触发，
// 游标逐帧在走，这个量只在「游标跨过此刻 / atNow 翻转 / 进出窗口」时变
const tagKey = computed(() => !nowInWin.value ? '' : atNow.value ? 'rl' : (phX.value > nowX.value ? 'l' : 'r'))
let _rSig = '', _rVal = null
const ruler = computed(() => {
  const W = trackWidthPx.value, stack = uiFont.stack, lw = (s) => labW(s, stack)
  const r = computeRuler({
    anchorMs: baseTime.value, wStart: winStartMin.value, wMin: windowMin.value, W, hp: hpPx.value, snapX,
    tzOffMin: (ms) => tzOffMin(tzMode.value, ms), parts: (ms) => tzParts(ms, tzMode.value), lw,
    nowX: nowInWin.value ? nowX.value : null, pinX: pinX.value,
    tagSides: tagKey.value.split(''), tagW: Math.max(lw('此刻'), lw('Now'))
  })
  // 签名相同返回同一对象：实时 / 连续跟随档每拍都会重算，但落整像素后多数拍结果一样 → 模板 v-memo 整段跳过
  const sig = [W, r.tag, r.tinies.join(), r.mids.join(), r.majors.join(), r.poles.map((p) => p.x + (p.day ? 'd' : '')).join(), r.labels.map((l) => l.x + l.label + (l.flip ? '<' : '')).join()].join('|')
  if (sig === _rSig) return _rVal
  _rSig = sig; _rVal = r
  return r
})
const showSpan = computed(() => nowInWin.value && !atNow.value)
// 逐帧唯一写入：--ph-x（游标与偏移带都由它驱动）；--now-x 只在此刻跨过设备像素时变
// --x0 / --x1：窗口两端端刻的整设备像素位置（轨道左缘落在半设备像素上时 left:0 / right:0 会把 1 设备像素摊成两列）
const trackStyle = computed(() => ({ ...trackVars.value, '--ph-x': phX.value + 'px', '--now-x': (nowX.value ?? 0) + 'px',
  '--x0': snapX(0) + 'px', '--x1': (snapX(trackWidthPx.value) - hpPx.value) + 'px' }))

// 光标 x → 时刻(ms)。吸附一格 ≤ 1 设备像素（下限 1 s）：游标与指针偏差 ≤ 半格 + 半设备像素 < 0.6px。
// 原 cursorSnapSec 取「≥ 1px 的最小整齐档」，3d 窗口一格 15 min ≈ 1.4px，针最多落后指针 0.74px。
// 要精确到某一秒：缩窗口 / 用步进 / 直接键入时刻（跳到时刻）。
const SNAP_FINE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
function scrubSnapSec(windowMin, trackDevPx) {
  const perDev = Math.max(1, windowMin) * 60 / Math.max(1, trackDevPx)
  let s = SNAP_FINE[0]
  for (const v of SNAP_FINE) if (v <= perDev) s = v
  return s
}
const snapSec = computed(() => scrubSnapSec(windowMin.value, trackWidthPx.value * hairDpr.value))
function trackToMs(clientX) {
  const r = track.value.getBoundingClientRect()
  const ms = baseTime.value + (winStartMin.value + clamp01((clientX - r.left) / r.width) * windowMin.value) * 60000
  return snapMs(ms, snapSec.value * 1000)
}
// 拖动游标：指针捕获在轨道上（移出轨道 / 窗口仍连续），松手 / 取消 / 丢捕获 / 窗口失焦四路都收尾 —— scrubbing 永不卡在 true。
// 只认左键（右键 / 中键不再拖游标）。★ 播放中按下：拖动期间停表（releaseClock；模式仍是 play，走带图标与 aria 不闪），
// 松手从新时刻接着播（resumeClock 重置计时基准，不补拖动期间流逝的时间）—— 仍是「就地续播」，只是拖的那一下不走。
// 原来边拖边走：连续跟随档每拍把尺子从指针底下拖走（实测游标偏指针 −269…+86px）。实时中拖则退出实时（setTime 既有语义）。
// 焦点环只画给键盘。拖游标必须先 focus()（松手后方向键要接着能步进），但鼠标按下就描一圈
// 黑框（全局 :focus-visible 的 var(--accent) 在亮色主题就是 #1a1a1a）纯属噪声。
// 浏览器对「程序化 focus() 算不算 focus-visible」的判定跟着上一次交互方式走，指望不上——
// 这里自己记焦点从哪来：鼠标按下不画，Tab 进来或按过键才画。
const trackKb = ref(false)
let trackPtrFocus = false
// 窗口切走引起的 blur（document 已失焦）：记下环的状态，切回时浏览器补发的 focus 原样恢复，不当成键盘聚焦。
// 切回后焦点没回到尺子（别处抢了焦点）→ 那一拍 window focus 之后丢掉这份记忆，免得下回 Tab 进来沿用旧状态
let trackKbHeld = null
function onTrackFocus() {
  if (trackKbHeld != null) { trackKb.value = trackKbHeld; trackKbHeld = null; return }
  trackKb.value = !trackPtrFocus
}
function onTrackBlur() {
  trackKbHeld = document.hasFocus() ? null : trackKb.value
  trackKb.value = false
  if (trackKbHeld != null) window.addEventListener('focus', () => setTimeout(() => { trackKbHeld = null }), { once: true })
}
let scrubEnd = null   // 拖动中的收尾函数；页面卸载时 onBeforeUnmount 以 scrubEnd(false) 收掉且不续播
function trackDown(e) {
  if (!track.value || e.button !== 0 || scrubEnd) return
  const el = track.value, pid = e.pointerId
  trackPtrFocus = true
  el.focus({ preventScroll: true })
  trackPtrFocus = false
  trackKb.value = false          // 已经聚焦时 focus() 不再发事件（先按方向键再拿鼠标拖就是这一路），环得在这儿灭
  try { el.setPointerCapture(pid) } catch { /* 合成事件没有活指针 */ }
  const held = clock.mode === 'play'
  if (held) releaseClock()
  scrubbing.value = true         // 先于第一次设时刻：这一拍的 followCursor 就得让位
  hoverShow.value = false
  applyTimeMs(trackToMs(e.clientX))
  let x = e.clientX, raf = 0
  const flush = () => { raf = 0; applyTimeMs(trackToMs(x)) }
  const move = (ev) => {
    if (ev.pointerId !== pid) return
    if (!(ev.buttons & 1)) { end(true); return }   // 捕获没挂上 / up 丢在别处：键已松就收尾
    x = ev.clientX; if (!raf) raf = requestAnimationFrame(flush)   // 一帧最多设一次时刻
  }
  const up = (ev) => { if (ev.pointerId === pid) end(true) }
  const blur = () => end(true)
  function end(resume) {
    if (scrubEnd !== end) return
    scrubEnd = null
    if (raf) { cancelAnimationFrame(raf); raf = 0; if (resume) applyTimeMs(trackToMs(x)) }
    window.removeEventListener('pointermove', move, true)
    window.removeEventListener('pointerup', up, true)
    window.removeEventListener('pointercancel', up, true)
    el.removeEventListener('lostpointercapture', up)
    window.removeEventListener('blur', blur)
    try { if (el.hasPointerCapture(pid)) el.releasePointerCapture(pid) } catch { /* 已释放 */ }
    scrubbing.value = false
    // 按下时在播：松手从落点接着播
    if (resume && clock.mode === 'play') resumeClock()
  }
  scrubEnd = end
  // 监听挂 window 捕获阶段：捕获挂上时事件照样先经过这里；捕获没挂上（合成输入 / 个别指针设备）时移出轨道、在别处松手也收得到
  window.addEventListener('pointermove', move, true)
  window.addEventListener('pointerup', up, true)
  window.addEventListener('pointercancel', up, true)
  el.addEventListener('lostpointercapture', up)
  window.addEventListener('blur', blur)
}
// 可见窗口的两端落到【窗内】整毫秒：滚轮缩放后 winStartMin 带小数毫秒，钳到边上的时刻经 setTime 的 Math.round
// 会落到边外 <1 ms —— 下一拍 followCursor 就判「跑出窗口」整页平移 75%。钳在 [ceil(lo), floor(hi)] 里取整后仍在窗内
function winMsRange() {
  const lo = baseTime.value + winStartMin.value * 60000, hi = baseTime.value + winEndMin.value * 60000
  const a = Math.ceil(lo - 1e-6), b = Math.floor(hi + 1e-6)
  return a <= b ? [a, b] : [lo, hi]
}
// 设时刻（夹在可见窗口内——拖不到看不见的地方）。刷新由时钟的 tick 回调统一驱动，这里不自己调 refreshPositions。
function applyTimeMs(ms) {
  const [lo, hi] = winMsRange()
  clockSetTime(clamp(ms, lo, hi))
}
function applyTime(min) { applyTimeMs(baseTime.value + min * 60000) }   // 分钟口径的老入口（窗口两端跳转仍用）
function step(min) { applyTimeMs(clock.tMs + min * 60000) }
// 键盘(role=slider)：←→ 走一个【仿真步长】(Shift ×10)，PageUp/Down ±1h，Home/End 跳窗口两端，空格播放/暂停
function onTrackKey(e) {
  let h = true
  if (e.key === 'ArrowLeft') clockStepBy(e.shiftKey ? -10 : -1)
  else if (e.key === 'ArrowRight') clockStepBy(e.shiftKey ? 10 : 1)
  else if (e.key === 'PageDown') step(-60)
  else if (e.key === 'PageUp') step(60)
  else if (e.key === 'Home') applyTime(winStartMin.value)
  else if (e.key === 'End') applyTime(winEndMin.value)
  else if (e.key === ' ' || e.key === 'Spacebar') { if (!scrubEnd) togglePlay(1) }   // 拖动中空格不切播放（仍吞掉默认行为）
  else h = false
  if (h) { trackKb.value = true; e.preventDefault() }   // 键盘一上手就把焦点环点亮（此前可能是鼠标点进来的）
}
// 滚轮缩放跨度：以光标处时间为锚保持不动（实时态则保持「此刻」居 PAST_FRAC 处）。
// 一格鼠标滚轮（|Δ| ≥ 50）恒 ×1.15（同改造前）；触控板的小 Δ 按比例累积，攒满 0.4 格才动一次。
// winExact 记未取整的跨度：原来 2 min 处 ×1.15 取整回到 2（2→2.3→2），滚轮在最小跨度卡死出不来。
let wheelAcc = 0, winExact = null
function onWheel(e) {
  if (!track.value || !e.deltaY) return
  const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
  wheelAcc += Math.abs(dy) >= 50 ? Math.sign(dy) : dy / 100
  if (Math.abs(wheelAcc) < 0.4) return
  const k = Math.pow(1.15, clamp(wheelAcc, -3, 3))
  wheelAcc = 0
  const r = track.value.getBoundingClientRect(), f = clamp01((e.clientX - r.left) / r.width)
  const cursorOff = winStartMin.value + f * windowMin.value
  winExact = clamp((winExact ?? windowMin.value) * k, WIN_MIN, WIN_MAX)
  const w = Math.round(winExact)
  if (w === windowMin.value) return
  windowMin.value = w
  winStartMin.value = live.value ? -PAST_FRAC * w : cursorOff - f * w
  clampCursorIntoWindow()
  saveSettings()
}
watch(windowMin, (v) => { if (winExact != null && Math.round(winExact) !== v) winExact = null })   // 下拉 / 存档改了跨度：丢掉滚轮的零头
// 缩放/换跨度后游标可能落到窗外 → 夹回来（时刻本身被改动才通知时钟，避免每次滚轮都白刷一拍：
// 尺子变了星并没有动，刻度是 computed 自己会重算，7000 颗星的 SGP4 没必要跟着滚轮跑）
function clampCursorIntoWindow() {
  const [lo, hi] = winMsRange()
  const t = clamp(clock.tMs, lo, hi)
  if (t !== clock.tMs) clockSetTime(t)
}
// 预设/自定义跨度：窗口居中重置（含 PAST_FRAC 过去），游标夹入新范围
function setWindow(min) {
  windowMin.value = clamp(Math.round(min), WIN_MIN, WIN_MAX)
  winStartMin.value = -PAST_FRAC * windowMin.value
  clampCursorIntoWindow()
  saveSettings()
}
// 换锚点 + 设时刻（此刻 / 停在当前时刻 / 跳到时刻）。★先落锚点与窗口、再设时刻 —— clockSetTime 同步 emit → refreshPositions
// → followCursor：锚点还是旧的就会把新时刻当成「跑出窗口」、按旧锚点平移 winStartMin，换锚点之后窗口落在离游标几天远的地方
function reanchorAt(ms) {
  const t = Math.round(ms)            // 与 setTime 的取整一致 → clock.tMs === baseTime
  winStartMin.value = -PAST_FRAC * windowMin.value
  baseTime.value = t
  clockSetTime(t)
}
function resetTime() {
  if (atNow.value && !live.value) return
  reanchorAt(Date.now())
}
function toggleLive() {
  if (!live.value) { winStartMin.value = -PAST_FRAC * windowMin.value; goLive(); baseTime.value = clock.tMs }   // 实时档在 refreshPositions 里自己跟锚点
  else reanchorAt(Date.now())
}
// ===================== 仿真时钟走带（STK Animation 范式）=====================
// 步长 = 一拍走多少仿真秒（采样量子）；倍速 = 比真实时间快多少倍（STK 的 x Real Time）。
// 拍率 = 倍速 ÷ 步长，夹在 [0.2, 240] —— 顶住时实际推进倍速打折（见 simClock 的 effective）。
// 播放中游标跑出可见窗口 → 平移尺子把它接回来（不是夹住游标：夹住等于播放撞墙停住）。
const speedText = computed(() => fmtRate(clock.speed) + '×')
function setStepSec(v) { clockSetStep(v); saveSettings() }
function setSpeedVal(v) { clockSetSpeed(v); saveSettings() }
// 播放推进后把尺子跟上（订阅回调里调）。慢档翻页、快档连续滑动，见 followWindow。
function followCursor() {
  if (scrubbing.value) return          // 拖动中尺子不动、游标只跟指针；松手后下一拍再跟
  // 钳到窗口边上的时刻经 setTime 的 Math.round 可能落到边外 <1 ms（滚轮缩放后窗口两端是小数毫秒）：不算跑出窗口，否则整页平移 75%
  const lo = winStartMin.value, hi = winEndMin.value, e = 1 / 60000, o = offMin.value
  const off = o < lo && o > lo - e ? lo : o > hi && o < hi + e ? hi : o
  const ws = followWindow(off, lo, windowMin.value, PAST_FRAC, clock.mode === 'play' ? clockEff.value : 0)
  if (ws != null) winStartMin.value = ws
}
// —— 跳到指定时刻（精确到秒）——
// 拖游标的吸附粒度受像素限制（24 h 窗口下 1 px = 144 s），要落在某个确切的秒上只能键入。
// 入口就是时间读数本身：点开的面板头上是这个输入框，下面是时区档位（TzPicker 的 head 插槽）——
// 「现在是哪一刻」与「按哪个时区读」在同一处改，走带组里不再单挂一枚时钟键。
// 输入按当前时区档位解释（与时间轴读数同一个开关），跳过去后窗口以该时刻重新居中。
// 框里改过的时刻本会话记着：关掉重开照旧是它，不再被当前游标冲掉（连点几次跳转微调是常态）。
// 记的是绝对时刻不是那串字面 —— 中途换了时区档，重开时按新档重新格式化，指的仍是同一瞬间。
// ★ 改一下就记（@input），不等关面板时收：面板里点时区档是先换 tzMode 再关，关时再解析那串字面就按新档错开了几个钟头。
//   没改过的框不记：面板也是换时区的入口，只为换个时区点开一下，不该把当时的游标时刻钉成「填过的值」。
const gotoVal = ref('')
const gotoMs = ref(null)
const gotoInp = ref(null)
// 秒为 0 时省掉「:00」：与 datetime-local 自己规范化后的 value 同一写法。字面不同的话，播放中读数每拍重渲
// （框在读数的插槽里，跟着重渲），v-model 见两边不等就往正在键入的框里回写一次（实测 1.5 s 写 3 次）
function fmtGotoVal(ms) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0'), s = tSec(d)
  return `${tYear(d)}-${p(tMon(d) + 1)}-${p(tDay(d))}T${p(tHour(d))}:${p(tMin(d))}` + (s ? ':' + p(s) : '')
}
function parseGotoVal(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''))
  if (!m) return null
  const [, Y, Mo, D, h, mi, s] = m.map(Number)
  const t = tzToMs(tzMode.value, Y, Mo, D, h, mi, s || 0)
  return Number.isFinite(t) ? t : null
}
// 读数面板打开：预填（记着的时刻，没有就取游标，按当前时区档格式化），焦点进输入框 —— 鼠标点开的也能直接改、回车跳。
// Esc / 点面板外关由 TzPicker 管（document 级 Esc，焦点在框里照样收得到）
function onRoOpen() {
  roOpen.value = true
  gotoVal.value = fmtGotoVal(gotoMs.value != null ? gotoMs.value : clock.tMs)
  nextTick(() => gotoInp.value && gotoInp.value.focus({ preventScroll: true }))
}
function noteGoto(v) {
  const t = parseGotoVal(v)
  if (t != null) gotoMs.value = t
}
// 回车 / 跳转：落锚点与时刻、记住、收起面板（焦点交还读数块）。框里是半截值（解析不出）只收起不跳
function applyGoto() {
  const t = parseGotoVal(gotoVal.value)
  if (t != null) { reanchorAt(t); gotoMs.value = t }
  if (roEl.value) roEl.value.close()
}
// ===================== 坐标系（大地基准 / 坐标格式）+ 2D 画面中心 =====================
// 前两项只改读数与输入的呈现；画面中心决定平面图把哪条经线摆在正中（内部仍按切口 = 中心 − 180 存）。
// ★ 画面中心的控件摆在「地图设置 → 2D 投影」那一节，与投影档挨着 —— 它就是各投影的中央经线，
//   两个一起调才顺手；状态仍旧存在 mapCrs 里（与大地基准 / 坐标格式同一份）。
// 三项都不碰任何计算与导出。
function setCrsDatum(v) { setMapCrs({ datum: v }) }
function setCrsFmt(v) { setMapCrs({ fmt: v }) }
// 2D 画面中心经度：填的是【正中那条经线】，切口（左边缘）由它减 180° 得到。
// ★ 显示值钉在这个 ref 上，不拿 lon0 反算：±180 是同一条经线的两种写法，反算会把填进去的 180
//   折成 −180，看上去就像「填了就自己退回去」。填 180、显示 180。
const crsCenterShown = ref(lon0ToCenter(MAP_CRS_DEF.lon0))
const crsCenter = computed(() => crsCenterShown.value)
const crsCenterTag = computed(() => { const c = crsCenterShown.value; return Math.abs(c).toFixed(1) + '°' + (c < 0 ? 'W' : 'E') })
function setCrsCenter(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  dropFollow()                       // 自己动了画面就别再跟着星下点跑
  crsCenterShown.value = Math.max(-180, Math.min(180, n))
  setMapCrs({ lon0: centerToLon0(crsCenterShown.value) })
  if (flat) flat.setLon0(mapCrs.lon0)
}
// 常用画面中心。挑的是「一眼知道用来看什么」的那几条，不是均匀铺满经度：
//   0°   本初子午线，欧非居中（Robinson / Equal Earth 出图的通行画法）
//   60°E 印度洋 / 中东，看西亚—非洲之角一带的波束
//   105°E 中国全图的标准中央经线（Albers 设成它即得常规中国全图）
//   150°E 出厂档，亚太居中（本平台的主战场）
//   180°  太平洋居中，看跨日界线的星座与航迹不被接缝切断
//   -60°  美洲居中
//   -100° 北美居中
const CENTER_PRESETS = [
  { v: 0, zh: '0°' }, { v: 60, zh: '60°E' }, { v: 105, zh: '105°E' }, { v: 150, zh: '150°E' },
  { v: 180, zh: '180°' }, { v: -60, zh: '60°W' }, { v: -100, zh: '100°W' }
]
function resetCrs() { projSpin.value = false; setMapCrs(MAP_CRS_DEF); crsCenterShown.value = lon0ToCenter(mapCrs.lon0); if (flat) { flat.setRotateMode(false); flat.setLon0(mapCrs.lon0); flat.setProjection(mapCrs.proj, projOpts()) }; if (imageryOn.value) applyImagery(true) }
// 2D 投影档：只改平面图怎么画（3D 球体不受影响 —— 它本来就是球，没有投影这回事）
function setMapProj(k) { setMapCrs({ proj: k }); if (flat) flat.setProjection(mapCrs.proj, projOpts()); if (imageryOn.value) applyImagery(true) }

// ── 逐投影的可调参数 ───────────────────────────────────────────────────────
// 哪档摆哪几个控件由 projParams 说了算（见 geo/projection.js 的 PROJ_PARAMS）：
// 方位等距有「中心纬度」，阿尔伯斯有两条「标准纬线」，其余档一个都没有。
const projHasLat0 = computed(() => projParams(mapCrs.proj).includes('lat0'))
const projHasPar = computed(() => projParams(mapCrs.proj).includes('par1'))
const projLat0Tag = computed(() => { const v = mapCrs.lat0; return Math.abs(v).toFixed(1) + '°' + (v < 0 ? 'S' : 'N') })
function setProjLat0(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  dropFollow()
  setMapCrs({ lat0: Math.max(-90, Math.min(90, n)) })
  if (flat) flat.setProjParams(projOpts())
}
function setProjPar(i, v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return
  setMapCrs(i === 1 ? { par1: n } : { par2: n })
  if (flat) flat.setProjParams(projOpts())
}
// ===== 星下点 =====
// 「星下点」那一节展开着没有。★ 必须声明在下面那个 watch 之前 —— 它带 immediate，
//   注册当场就要读这个值，晚声明会撞 TDZ。
const subOpen = ref(false)
// 图上一个准星标记，光标的 az/el·u/v 按它算，方位等距的圆心也钉在它上面。三种来源见 stores/mapCrs。
// ★ sat / tree 两种来源【只存身份】，位置每拍按时钟解算 —— 存快照的话时间轴一走标记和读数就都错了。
const subPtPos = computed(() => {
  const sp = mapCrs.subPt
  if (!sp) return null
  if (sp.src === 'manual') return { lon: sp.lon, lat: sp.lat, alt: sp.alt, name: '' }
  void clock.tMs                                     // ★ 显式依赖时钟：时间轴一动，标记与读数跟着走
  if (sp.src === 'tree') {
    const n = grdSats.value.find((x) => x.folder === sp.folder)
    if (!n) return null
    const p = satLivePos(n)                          // 关联星走星历，固定星就是它自己那对经纬度
    if (!p || !Number.isFinite(p.lon)) return null
    return { lon: p.lon, lat: p.lat || 0, alt: p.altKm, name: n.satName || sp.name }
  }
  const e = satEntryById(sp.id)
  if (!e || !e.rec) return null
  const t = calcAt(), tm = isCustomEntry(e) ? ccTimeAt(t) : t
  try {
    const pv = posAt(e, tm)
    if (!pv || !pv.position) return null
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(tm))
    const lon = sat.degreesLong(gd.longitude), lat = sat.degreesLat(gd.latitude)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
    return { lon, lat, alt: gd.height, name: e.name || sp.name }
  } catch { return null }
})
const subPtName = computed(() => {
  const sp = mapCrs.subPt
  if (!sp) return ''
  if (sp.src === 'manual') return ''
  return (subPtPos.value && subPtPos.value.name) || sp.name || ''
})
// 标记上印的字：卫星来源印星名，手动点不印（它就是用户自己填的那对数）
const subPtLabel = computed(() => subPtName.value)
// 面板上「当前」那一格：星名 + 此刻的经纬度。卫星来源时它每拍都在变，正是要给人看的那个数。
const subPtRead = computed(() => {
  const p = subPtPos.value
  if (!p) return mapCrs.subPt ? '—' : ''
  const ll = Math.abs(p.lon).toFixed(2) + '°' + (p.lon < 0 ? 'W' : 'E') + '  ' + Math.abs(p.lat).toFixed(2) + '°' + (p.lat < 0 ? 'S' : 'N')
  return subPtName.value ? subPtName.value + '  ' + ll : ll
})

// ── 跟随 ───────────────────────────────────────────────────────────────────
// 星下点一动，画面（投影中心）跟着走。★ 必须节流：改投影中心＝整份重烘，LEO 每拍都改会直接卡死。
//   · 位移阈值 —— GEO 的星下点一天才漂几十分之一度，这一条让它几乎不触发；
//   · 时间闸  —— LEO 快的时候每秒扫几度，按这个节拍跟，画面是一跳一跳地追上去。
const FOLLOW_DEG = 0.25, FOLLOW_MS = 250
let followT = 0, followAt = null
// ★ keepView：跟随时【不许动缩放】—— 换平面的默认路子会 fit() 一次，时间轴每跳一下
//   就把用户放大看的那一块打回全图。投影中心在平面上的位置是固定的（方位等距即圆心 W/2,H/2），
//   故视图原样留着，圆心在屏幕上的位置也就不动，只有底下的地球在转。
function centerOnSubPt(p, keepView) {
  crsCenterShown.value = Math.max(-180, Math.min(180, p.lon))
  setMapCrs({ lon0: centerToLon0(p.lon), lat0: p.lat })
  // ★ 切口与投影参数一起递给 setLon0，一次重建：分开调 setLon0 + setProjParams 是两次整份重建
  //   （每次都把静态层四层缓存清光），跟随 LEO 时每拍两遍
  if (flat) flat.setLon0(mapCrs.lon0, keepView !== false, projOpts())
}
// 图上那枚准星：★ 只在「星下点」那一节【展开着】的时候画 —— 收起来就当没这回事，
//   免得一个记号长期挂在图上碍事。数据（mapCrs.subPt）不动，再点开就还在。
function pushSubMark() {
  if (!flat) return
  const p = subOpen.value ? subPtPos.value : null
  flat.setSubPoint(p ? { lon: p.lon, lat: p.lat } : null)
}
watch(subOpen, pushSubMark)
watch(subOpen, refreshLook)
watch(subPtPos, (p) => {
  pushSubMark()
  refreshLook()
  // ★ 跟随只在「星下点」那一节【展开着】的时候生效 —— 收起来就是关掉了：准星不画、画面也不跟。
  //   只看 subFollow 不看 subOpen 的话，关掉星下点之后时间轴一走，画面中心照样被卫星拖着跑
  //   （存档里带着 subPt + subFollow 读回来时同样如此）。
  if (!subOpen.value || !p || !mapCrs.subFollow || !mapCrs.subPt || mapCrs.subPt.src === 'manual') return
  const now = performance.now()
  const moved = !followAt || Math.abs(p.lon - followAt.lon) > FOLLOW_DEG || Math.abs(p.lat - followAt.lat) > FOLLOW_DEG
  if (!moved || now - followT < FOLLOW_MS) return
  followT = now; followAt = { lon: p.lon, lat: p.lat }
  centerOnSubPt(p, true)          // 跟随：缩放不动
}, { immediate: true })
// 用户自己动了画面 → 关掉跟随。否则下一拍又被拉回星下点，怎么拖都拖不走。
function dropFollow() { if (mapCrs.subFollow) setMapCrs({ subFollow: false }) }

// ── 设定星下点 ─────────────────────────────────────────────────────────────
function applySubPt(v) {
  setMapCrs({ subPt: v, subFollow: true })
  followT = 0; followAt = null
  const p = subPtPos.value
  if (p) { centerOnSubPt(p); pushSubMark() }
  refreshLook()
}
function clearSubPt() {
  setMapCrs({ subPt: null })
  subSrc.value = 'sat'; refQ.value = ''; refResults.value = []
  pushSubMark()
  cursor.look = null
}
// 来源页签（只是面板上摆哪一行输入，真正的来源以 mapCrs.subPt.src 为准）
const subSrc = ref('sat')
const SUB_SRCS = [{ k: 'manual', zh: '手动', en: 'Manual' }, { k: 'sat', zh: '搜索卫星', en: 'Search' }, { k: 'tree', zh: '卫星树', en: 'Sat tree' }]
function setSubSrc(k) { subSrc.value = k; refQ.value = ''; refResults.value = [] }

// ① 手动：经纬度 + 高度（高度不可省 —— az/el 是从卫星看的角）
const manLon = ref(''), manLat = ref(''), manAlt = ref('')
function applyManual() {
  const lon = Number(manLon.value), lat = Number(manLat.value)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return
  applySubPt({ src: 'manual', lon, lat, alt: Number(manAlt.value) })
}
// ② 搜索卫星：复用地图搜索那一套池子（ensureSearchPool + searchSource），不另建索引
const refQ = ref('')
const refResults = ref([])
let refTimer = 0
function onRefSearch(e) {
  refQ.value = e.target.value
  if (refTimer) clearTimeout(refTimer)
  refTimer = setTimeout(async () => {
    const kw = refQ.value.trim().toLowerCase()
    if (!kw) { refResults.value = []; return }
    await ensureSearchPool()
    const src = searchSource(), out = []
    for (let i = 0; i < src.length && out.length < 12; i++) {
      const en = src[i]
      if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw)) {
        out.push({ id: en.noradId ? 'n:' + en.noradId : en.name, name: en.name, noradId: en.noradId, slot: geoSlotOfSatrec(en.rec) })
      }
    }
    refResults.value = out
  }, 200)
}
function pickRefSat(r) {
  applySubPt({ src: 'sat', id: r.id, name: r.name })
  refQ.value = ''; refResults.value = []
}
// ③ 卫星树：覆盖图那棵树里的节点（仰角线那种不算 —— 它不是卫星）
const treeSats = computed(() => grdSats.value.filter((n) => n.kind !== 'elevline'))
function pickTreeSat(folder) {
  const n = treeSats.value.find((x) => x.folder === folder)
  if (n) applySubPt({ src: 'tree', folder: n.folder, name: n.satName })
}
// 地图上选中的那颗 —— 一键来源，省得再搜一遍
const projSatName = computed(() => (selected.value ? String(selected.value.name || '') : ''))
function useSelectedAsRef() {
  const e = selEntry
  if (!e) return
  applySubPt({ src: 'sat', id: e.noradId ? 'n:' + e.noradId : e.name, name: e.name })
}
// 参考卫星 / 档位一变就地重算读数 —— 否则鼠标不动的话状态栏还挂着上一颗星的数
function refreshLook() { cursor.look = cursor.ll ? lookReadout(cursor.ll) : null }
// 光标读数档
function setLookMode(k) { setMapCrs({ lookMode: k }); refreshLook() }
const subPtTitle = computed(() => (curLang() === 'en'
  ? 'Marked with a ⊕ on the map; the cursor az/el · u/v readout is measured from it, and the azimuthal-equidistant centre is pinned to it. For a satellite source only the identity is stored — the position is solved at the clock time, so the marker follows the timeline'
  : '图上画一个 ⊕ 标记，光标的 az/el·u/v 按它算，方位等距的圆心也钉在它上面。卫星来源只记身份，位置每拍按时钟解算，故标记跟着时间轴走'))
const lookTitle = computed(() => (curLang() === 'en'
  ? 'Extra cursor readout beside longitude/latitude, relative to the reference satellite: az/el is the antenna frame with boresight at nadir; u/v are the direction cosines of the same direction. Geocentric angle and slant range are in the readout tooltip'
  : '除经纬度外，光标额外读一项【相对参考卫星】的量：az/el 是 boresight 指星下天底的天线系方位角/仰角，u/v 是同一方向的方向余弦。地心角与斜距在读数的悬停提示里'))
// ★ 拼接串过不了 DOM 翻译层（它认的是整串），故这一条自己按语言生成
const projSatTitle = computed(() => {
  const nm = subPtName.value || projSatName.value
  const en = curLang() === 'en'
  if (!nm) return en ? 'Open the sub-satellite-point settings: source, cursor readout' : '展开星下点设置：来源、光标读数'
  return en
    ? 'Open the settings and put the projection centre back on the sub-satellite point of ' + nm + ', resuming follow — the radius on the map then reads the geocentric angle directly'
    : '展开设置，并把投影中心拉回 ' + nm + ' 的星下点、重新跟随；圆心一落在星下点，图上到圆心的距离就是地心角'
})
// 圆心一键钉到星下点：先认参考卫星，没设过就拿地图上选中的那颗（顺带记成参考卫星）。
// 圆心一落在星下点，图上到圆心的距离就是地心角 —— 这一档存在的理由。
// 「星下点」按钮：切换那一节的展开 —— 三行设置不常驻，点开才有（面板本来就挤）。
// 展开时若已经设过星下点，顺带把圆心拉回去并重新跟随（跟随关掉之后拖走了，用它拉回来）。
function projCenterToSat() {
  subOpen.value = !subOpen.value
  if (!subOpen.value) { dropFollow(); return }        // 关掉＝画面不再跟着星下点走（数据不动，再点开还在）
  // ★ 与「拖动调整」互斥：投影中心要么跟星下点、要么由手拖，最多开一个
  if (projSpin.value) { projSpin.value = false; if (flat) flat.setRotateMode(false) }
  const p = subPtPos.value
  if (p) { setMapCrs({ subFollow: true }); followT = 0; followAt = null; centerOnSubPt(p, true) }
}
// 「拖动调整」：开着的时候左键在图上拖动改的是投影中心，不是平移画面。
// 与「地球自转」那两档参考系是两回事，别混 —— 那个改的是相机所在的系。
const projSpin = ref(false)
function toggleProjSpin() {
  projSpin.value = !projSpin.value
  if (flat) flat.setRotateMode(projSpin.value)
  // ★ 与「星下点」互斥：开了手拖就收起星下点那一节（准星不画、跟随停掉），否则下一拍又被拉回去
  if (projSpin.value && subOpen.value) { subOpen.value = false; dropFollow() }
}
// 转动回调：拖动中逐帧只更新读数，松手那一次才是终值（两者都要写回 mapCrs，
// 否则拖完切个档就弹回旧中心）。crsCenterShown 跟着走，面板上的数字与图上恒一致。
function onFlatRotate(r) {
  if (!r) return
  dropFollow()
  crsCenterShown.value = ((r.lon0 + 180 + 180) % 360 + 360) % 360 - 180
  setMapCrs({ lon0: r.lon0, lat0: r.lat0 })
}
// 字段口径放 title（不占版面，见 CLAUDE.md）：逐档的用途与代价，以及“只改显示”这一条。
// ★ 写成 computed 而不是常量：title 是在 JS 里拼的串，不走 DOM 翻译层，
//   写成常量就永远停在启动时那个语言上、切语言不跟。
const projTitle = computed(() => (curLang() === 'en' ? [
  'Affects only how the 2D flat map is drawn; the 3D globe and every calculation / export are untouched.',
  'Equirectangular: factory default. Longitude and latitude used directly as Cartesian axes, so the graticule is two families of straight lines',
  'Mercator: conformal (no local distortion), the common convention for GIS and online tiles. Latitude clamped to ±85.05°, high-latitude areas exaggerated',
  'Equal Earth: equal-area. Use it alongside coverage-area readouts — areas are not inflated',
  'Robinson: a compromise, neither conformal nor equal-area; looks good in print',
  'Albers: equal-area conic, for regional sheets, both standard parallels adjustable. The central meridian follows the map centre — set it to 105°E for the conventional map of China',
  'Azimuthal Equidistant: the whole Earth inside one circle. Distance from the centre is proportional to the true geocentric angle and the rim is the antipode — put the centre on a sub-satellite point and the radius reads off the geocentric angle'
] : [
  '只作用于 2D 平面图的画法；3D 球体与一切计算 / 导出不受影响。',
  '等距圆柱：出厂档。经纬直接当直角坐标，经纬网是两族直线',
  '墨卡托：等角（局部不变形），GIS 与在线瓦片的通用口径。纬度钳到 ±85.05°，高纬面积夹大',
  '等积地球：等积。配覆盖面积读数看，面积不被拉大',
  '罗宾逊：既不等角也不等积的折中画法，出图好看',
  '阿尔伯斯：等积圆锥，区域图用，两条标准纬线可调。中央经线跟随「画面中心」，设成 105°E 即得常规中国全图',
  '方位等距：整个地球装在一个圆里。到圆心的图上距离正比于真实地心角、圆周即对跖点，圆心放在星下点时半径直接读地心角'
]).join('\n'))

// 参考系两档来回切：惯性视角（地球随仿真时钟东转）↔ 相机跟随（地面不动）。套到 scene 的活由 watch 干。
function toggleFrame() { viewPrefs.frame = viewPrefs.frame === 'inertial' ? 'fixed' : 'inertial' }
function setNameMode(m) { nameMode.value = m; scene && scene.setLabelMode(m); if (flat) flat.setNameMode(m) }
// 省界/市界：按开关加载数据（一次）并套用可见性。开关切换与「默认开启的无存档首启」共用同一路径
// 行政区图层：按选中的国家集合拉包、按当前视角过滤 groups、并成一份喂给两个渲染器。
// 字号：一级用 3D 世界高 0.02 / 2D 15px，二级更密故更小（0.012 / 11px）——与换源前一致。
// ★ 二级只有中国：三重门 —— 行政区图层开着 + 选中的国家里有中国 + 地级市这一档打开。
const admL2On = () => showCities.value && showProvinces.value && admSel1.value.includes('CHN')
// 常显国家：这些国家的一级/二级地名不参与避让的碰撞剔除 —— 挤到也照画，一个都不许消失。
// 中国的省与地级市是本平台的主用场景，宁可让相邻的名字挨得紧，也不能让某个省市在某个缩放下凭空不见。
const KEEP_ISO = ['CHN']
async function ensureAdm(lvl) {
  const on = lvl === 1 ? showProvinces.value : admL2On()
  const sel = lvl === 1 ? admSel1.value : ['CHN']
  const mode = lvl === 1 ? admName1.value : admName2.value
  if (on) {
    const packs = await Promise.all(sel.map((iso) => loadPack(lvl, iso)))
    const data = mergePacks(packs, getPov().id, mode, lvl === 1 ? 0.02 : 0.012, lvl === 1 ? 15 : 11, KEEP_ISO)
    if (lvl === 1) { provincesData = data; scene && scene.setProvinces(data); if (flat) flat.setProvinces(data) }
    else { citiesData = data; scene && scene.setCities(data); if (flat) flat.setCities(data) }
  }
  if (lvl === 1) { scene && scene.setProvincesVisible(on); if (flat) flat.setProvincesVisible(on) }
  else { scene && scene.setCitiesVisible(on); if (flat) flat.setCitiesVisible(on) }
  applyNameScale()   // 套用当前字号（首次加载后生效）
}
async function ensureProvinces() { await ensureAdm(1) }
async function ensureCities() { await ensureAdm(2) }
// 一级图层总开关：关掉时二级跟着退场（省界不在场，地级市界会悬在半空）
async function toggleProvinces() { showProvinces.value = !showProvinces.value; await ensureProvinces(); await ensureCities() }
async function toggleCities() { showCities.value = !showCities.value; await ensureCities() }
// 国家多选：改完整层重建（包已缓存，代价只是重建几何）。中国进出还牵动地级市那一档。
function admToggleCountry(iso) {
  const i = admSel1.value.indexOf(iso)
  admSel1.value = i >= 0 ? admSel1.value.filter((x) => x !== iso) : [...admSel1.value, iso]
  ensureAdm(1)
  if (iso === 'CHN') ensureAdm(2)
}
function admSetName(lvl, m) { (lvl === 1 ? admName1 : admName2).value = m; ensureAdm(lvl) }
// 切界面语言 → 地图上的国名与两级行政区名跟着换语言。
// 这三档的语义就是「地名用哪种语言写」：界面都切成英文了，图上还留着中文地名是割裂的。
// ★ 选了「不显示」的那一档不动 —— 那是用户明确关掉的，换语言不该把它打开。
// 用户想要「英文界面 + 中文地名」的话，切完语言再手动改一次即可（这三档照旧存进快照）。
function syncNameLang() {
  const en = curLang() === 'en'
  if (nameMode.value !== 'off') setNameMode(en ? 'en' : 'zh')
  if (admName1.value !== 'off') admSetName(1, en ? 'en' : 'local')
  if (admName2.value !== 'off') admSetName(2, en ? 'en' : 'local')
  if (oceanNameMode.value !== 'off') setWaterNameMode('ocean', en ? 'en' : 'zh')
  if (seaNameMode.value !== 'off') setWaterNameMode('sea', en ? 'en' : 'zh')
  if (chainStyle.name !== 'off') setChainName(en ? 'en' : 'zh')
  saveSettings()
}
const offLang = onLangChange(syncNameLang)
// 可选国家：只列本地确实有包的那些，名字取解算器口径（与地图上的国名一致）
const admHits = computed(() => {
  const q = admQuery1.value.trim()
  const have = new Set(admIndex.adm1 || [])
  const list = COUNTRY_ZH.value.filter((c) => have.has(c.id))
  const hit = q ? list.filter((c) => c.zh.includes(q) || c.id.includes(q.toUpperCase()) || (c.en || '').toLowerCase().includes(q.toLowerCase())) : list
  // ★ 不截断：没输入就把有包的国家全列出来（247 个），清单本身可滚。
  //   原来恒截到 12 条 —— 不打字就只能看到「阿尔巴尼亚」起那几个，等于逼着人先知道国名才能勾。
  //   已选中的排最前，勾过的永远在第一屏。
  const sel = new Set(admSel1.value)
  return [...hit].sort((a, b) => (sel.has(b.id) ? 1 : 0) - (sel.has(a.id) ? 1 : 0))
})
const admChips = computed(() => admSel1.value.map((id) => { const c = COUNTRY_ZH.value.find((x) => x.id === id) || {}; return { id, zh: c.zh || id, en: c.en || id } }))
const admHasCN = computed(() => admSel1.value.includes('CHN'))

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
  if (following.value && !flatView.value) return   // 跟随卫星期间不存视图：别把跟随机位写成下次启动的球面视图
  const kind = flatView.value ? 'flat' : 'globe'
  const m = activeMap()
  if (!m || !m.getView) return
  savedView[kind] = m.getView()
  if (_viewSaveTimer) clearTimeout(_viewSaveTimer)
  _viewSaveTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(savedView)) } catch { /* ignore */ } }, 300)
}
// 跟随卫星期间底部缩放条改控局部相机距离（1.2 倍包围半径 … 5 km，对数刻度，与球面缩放同一把 0–120% 的尺）
function pushZoom() {
  if (following.value && modelLayer && !flatView.value) { zoom.value = modelLayer.getFollowZoom(); return }
  const m = activeMap(); if (m && m.getZoom) zoom.value = m.getZoom()
}
function applyZoom(t) {
  if (following.value && modelLayer && !flatView.value) { modelLayer.setFollowZoom(t); zoom.value = t; return }
  const m = activeMap(); if (m && m.setZoom) { m.setZoom(t); zoom.value = t; saveView() }
}
// ============ 键盘方向键：3D ←→↑↓ 绕地心旋转相机；2D ←→↑↓ 移动视窗中心（东/西/南/北）。Shift 加速。 ============
// rAF 循环按住连续运动（无系统按键重复的首帧延迟），松开即停。窗口失焦或组件卸载时清空按键，避免卡键。
const NAV_ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
const navHeld = new Set()
let navRaf = 0
function navTick() {
  navRaf = 0
  if (!NAV_ARROWS.some((k) => navHeld.has(k))) return
  const fast = navHeld.has('Shift')
  const L = navHeld.has('ArrowLeft'), R = navHeld.has('ArrowRight'), U = navHeld.has('ArrowUp'), Dn = navHeld.has('ArrowDown')
  if (flatView.value && flat) {
    const s = fast ? 12 : 4                  // 每帧屏幕像素
    const dx = (R ? s : 0) - (L ? s : 0), dy = (Dn ? s : 0) - (U ? s : 0)
    if (dx || dy) flat.panByPixels(dx, dy)
  } else if (scene) {
    const s = fast ? 0.015 : 0.006          // 每帧弧度
    const dAz = (R ? s : 0) - (L ? s : 0), dPol = (Dn ? s : 0) - (U ? s : 0)
    if (dAz || dPol) scene.rotateBy(dAz, dPol)
  }
  saveView()                                // 防抖写盘：运动停止 300ms 后落一次
  navRaf = requestAnimationFrame(navTick)
}
function navStop() { navHeld.clear(); if (navRaf) { cancelAnimationFrame(navRaf); navRaf = 0 } }
function onNavKeyDown(e) {
  // Esc = 退出跟随卫星（焦点在输入框里的 Esc 归输入框；输入法组字中的归输入法）
  if (e.key === 'Escape' && following.value && !e.isComposing && !e.defaultPrevented) {
    const el = e.target
    if (!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))) { stopFollow(); return }
  }
  // Esc = 站点栅编辑态的出口：一次退框选/加站（选中的站保留），再一次清选。
  // 只在波束合成面板开着、且焦点不在输入框里时接管
  if (e.key === 'Escape' && bs.open.value) {
    const el = e.target
    if (!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable))) {
      if (bs.stEditOn.value || bs.stPick.value) { if (bs.stEditOn.value) bs.toggleStEdit(); if (bs.stPick.value) bs.toggleStPick(); return }
      if (bs.stSel.value.size) { bs.clearStSel(); return }
    }
  }
  if (e.key === 'Shift') { navHeld.add('Shift'); return }
  if (!NAV_ARROWS.includes(e.key)) return
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return   // 已被时间轴/表格等消费，或带修饰键 → 不接管
  const t = e.target
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return
  e.preventDefault()
  if (e.shiftKey) navHeld.add('Shift'); else navHeld.delete('Shift')
  navHeld.add(e.key)
  if (!navRaf) navRaf = requestAnimationFrame(navTick)
}
function onNavKeyUp(e) {
  navHeld.delete(e.key)
  if (e.key === 'Shift') navHeld.delete('Shift')
  if (navRaf && !NAV_ARROWS.some((k) => navHeld.has(k))) { cancelAnimationFrame(navRaf); navRaf = 0 }
}
// 球体 <-> 平面图 切换（顶栏「视图」按钮与覆盖面板按钮共用 view.flat）
function toggleFlat() { view.flat = !view.flat }
watch(() => view.flat, (v) => applyFlat(v))
// 平面图画布首帧画完才显形：v-show 一翻就露出画布底色（藏青块），而第一帧要等覆盖几何算完。
// 未就绪时透明且不吃指针，底下的球照常可见可拖；切回 3D 立即复位（快速来回切时不把隐藏的画布标成已就绪）。
const flatPainted = ref(false)
async function applyFlat(v) {
  if (v) stopFollow()   // 跟随卫星只在 3D 球体里有：切 2D 先退出（相机回到进入前的位姿）
  flatView.value = v
  // 切回 3D：先恢复 3D 渲染循环（切 2D 时已暂停），再补齐 3D 覆盖层。
  // 编辑电平时只 patch 了当前可见视图（recomputeActive），另一视图需在此一次性重算。
  // 卫星层（含波束合成草图）在 2D 期间挂起未同步 → 这里一次性补建（见 redrawSats 尾注）。
  if (!v) {
    flatPainted.value = false
    scene && scene.resume()
    if (satSpec3dDirty && scene) { scene.setSatLayer(satSpec3dPending); satSpec3dDirty = false; satSpec3dPending = null }
    // 2D 期间两个覆盖视图的 3D 通道都被闸着（recompute 的 isFlat 门）→ 切回必须各补一次全量，
    // 不能再只看面板开关：2D 里播放过的话，场景里的场还停在切走那一刻，星早走远了。
    grd.recompute()
    satcov.recompute()   // 内部 panelOn/_painted 闸自己管：没画过不推
    pushZoom(); return
  }
  await ensureCovIndex(); if (!covCleared.value) redraw()   // 已清除则切平面图不复现覆盖（covGeom 保持为空）
  await nextTick()
  if (ensureFlat()) {
    await feedFlat()   // 内含 resize → base 就绪，之后才能正确 setView；await＝等聚焦几何算完再画，切换不闪
    requestAnimationFrame(() => { if (flatView.value) flatPainted.value = true })
    // 首次进入平面图时恢复上次视图（缩放+平移中心）；之后切换保持当前，不再覆盖
    if (!viewRestoredFlat) { viewRestoredFlat = true; if (savedView.flat) flat.setView(savedView.flat) }
    pushZoom()
    scene && scene.pause()   // 平面图已就绪并盖住球面 → 暂停 3D 渲染循环，2D 不再被空转的 3D 拖慢
  }
}
// 平面渲染器：按需创建（绑定交互回调）。返回实例（flatCanvas 未就绪时返回 null）。
function ensureFlat() {
  if (!flat && flatCanvas.value) {
    flat = createFlatCoverage(flatCanvas.value)
    perfHost.pushBoxes()   // 平面渲染器是按需建的：性能指标表的城市层（框 + 标签）之前只推给了 3D，这里补推一份，否则切到平面图不见框
    flat.setRenderScale(displayQuality.value.pixelRatio); flat.setMapDetail(displayQuality.value.mapDetail, displayQuality.value.mapThin)
    flat.setWheelStep(viewPrefs.wheelStep2d)   // 平面渲染器按需建：滚轮比例在这里补推一次
    flat.setOnRightClick(onMapRightClick); flat.setOnHover(onHoverLL); flat.setOnBeamDrag(onBeamDragAny); flat.setBeamDragMode(grd.dragBore.value)
    flat.setOnLabelDrag(grd.labelDrag); flat.setLabelDragMode(grd.dragLabel.value)   // 拖拽等值线数值标签（沿线滑动）
    flat.setOnVertexDrag(onVertexDrag)   // 拖动单个顶点/标记点（Polygon 调点 或 标记「调整点位置」，分发）
    flat.setOnMarkerDrag(onMarkerDragged)   // 标记拖拽：压在符号上按住即拖（须先进「调整位置」/「调点」，见 markDragKinds）
    flat.setOnPolyMove(onPolyMoveDrag)       // Polygon 整体拖动：按住内部平移全部顶点
    flat.setOnPolyDraw(onPolyDraw); flat.setPolyDrawMode(!!(polyDrawId.value || activeTraj.value))   // Polygon/航迹绘制：左键按住沿路径连续加点
    flat.setOnPlace((ll) => bs.placeAt(ll)); flat.setPlaceMode(bs.placing.value)   // 波束合成放置：左键点击落波束（拖动仍平移）
    flat.setOnBoxSelect(bsOnBoxSelect); flat.setBoxSelectMode(bs.stEditOn.value)   // 站点栅框选（拖矩形选站，页面画橡皮筋）
    flat.setOnRotate(onFlatRotate); flat.setRotateMode(projSpin.value)   // 「拖动调整」：左键拖动改投影中心（见地图设置 → 2D 投影）
    pushSubMark()        // 星下点准星（切回 2D / 导出时也要有；那一节收起来时不画）
    flat.setOnZoom((t) => { if (flatView.value) { zoom.value = t; saveView(); grd.onZoomEnd() } })
    // GRD 分带填充的后端换了（换投影档 / 导出前后 / WebGL 上下文丢失恢复）→ 重算一轮几何，
    // 把填充换成另一种产物（GPU 网格 ↔ 分带多边形）。见 flatCoverage.fieldBackend。
    flat.setOnBackendChange(() => { grd.recompute() })
    flatCanvas.value.addEventListener('pointerup', saveView)   // 平移结束保存视图（平移中心）
    // 挂了模型的站 / 点 / 载具画模型俯视图：出图器在 onMounted 里已建好就当场接上，站的碟面指向补推一份（停表时等不到下一拍）
    if (entSprites && flat.setEntitySprites) { flat.setEntitySprites(entSprites); pushStationAims() }
  }
  return flat
}
// 把当前全部状态（底图选项/标记/覆盖几何/GRD 场/卫星层/聚焦星）喂给平面渲染器。
// 切到平面图与「导出（含 3D 视图下）」共用，保证导出所见即所得。
function feedFlat() {
  if (!flat) return
  flat.resize()
  // ★ 切口与投影先推：两者都会触发【整份重烘 + fit】，放在后面会把下面刚套上的
  //   视图 / 图层重新抻一遍；且存档恢复时 mapCrs 已经是目标值，不先推就按出厂档画了一帧。
  flat.setLon0(mapCrs.lon0)
  flat.setProjection(mapCrs.proj, projOpts())
  flat.setNameMode(nameMode.value)
  flat.setWaterMode({ ocean: oceanNameMode.value, sea: seaNameMode.value })
  flat.setWaterOff({ ...waterOff })
  flat.setChains({ on: chainOn.value, off: { ...chainOff }, ...chainStyle })
  if (provincesData) flat.setProvinces(provincesData)
  flat.setProvincesVisible(showProvinces.value)
  if (citiesData) flat.setCities(citiesData)
  // ★ 二级走 admL2On() 那道三重门，不是光看 showCities —— 「地级市开着、行政区总开关关着」时
  //   citiesData 还留在内存里（ensureAdm 只在开着时重建、从不清空），照 showCities 喂就会在切回
  //   平面图/导出时把整层市界市名画出来，而 3D 那边是关着的。
  flat.setCitiesVisible(admL2On())
  flat.setBorderStyle({ ...borderStyle })
  flat.setLabelStyle({ ...labelStyle })
  flat.setOceanColor(oceanColor.value)
  if (imageryOn.value) applyImagery(true)
  flat.setFocusStyle(focusStyle2D())
  flat.setMarkStyle(markSizes())
  flat.setMarkers(markerPts(), markerSts(), markerTrs())
  if (flat.setVehicleStates) flat.setVehicleStates(_movList.length ? _movList : null)   // 运动档载具此刻的位置（平面图懒创建，补喂一份）
  flat.setMarkerDrag(markDragKinds())
  flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value, oceanScale: oceanNameSize.value, seaScale: seaNameSize.value })
  flat.setGeom(covGeom)
  grd.recompute()   // GRD 覆盖：把当前选中天线的面+线喂给 flat（recompute 同时喂 scene/flat）
  if (sideCtx() === 'satcov') satcov.recompute()   // 对星视图占着 2D 那块场（见 ownsFlatField）→ 上一行被闸住，改由它来喂
  env.redraw()      // 环境场：平面图是懒创建的，切过来时把当前图层（栅格+等值线）补喂一份
  envLive.redraw()  // 实时气象场：同上。两张场共用一个槽，次序无所谓——归属闸挡着，关着的那一方清不掉对方
  applySpace()      // 宇宙空间（晨昏效果 / 晨昏线）：同上，平面图懒创建，切过来补喂当前时刻那一份（关着则清层）
  redrawSats()      // 卫星/仰角线图层（含 Polygon）
  syncEdit()        // 调点态（Polygon / 标记「调整点位置」）：切入平面图时接上拖拽
  // ★ 返回这次几何的 Promise：commitGeometry 已改异步（逐颗几何在 Worker 池里算），
  //   切平面图与出图两处都必须等它落定 —— 否则平面图会先画一帧空的（切换时闪一下），
  //   导出更严重：await nextTick() 等不到 Worker 回来，导出的 PNG/PDF 会缺整套聚焦几何。
  return commitGeometry()  // 聚焦卫星位置 + 覆盖范围 + 星下点轨迹（含可见性叠加层，若开）
}

// ===================== 覆盖图导出（高清 PNG / 矢量 PDF；「截图」在 3D 视图下抓球面） =====================
const exporting = ref(false)    // 出图/导数据进行中：互斥闸
const exportFlat = ref(false)   // 且本次走的是 2D 平面图那条（3D 球体截图不置位，见 flatActive）
// 发送到小程序：走共用的 MiniSendDialog（绑定账号直投 / 生成密钥两选一，见 sendToMiniapp）
const miniSendOpen = ref(false)
const miniSatOpen = ref(false)      // 星座（卫星组 / 自定义卫星 / 自定义星座）那一路，与覆盖快照各一个弹窗
const miniDeviceId = ref('')
const miniConfigured = ref(false)

let _pdfFonts   // undefined=未取；对象={cjk,latin,latinBold,latinItalic} 各面缺失为 null；null=取不到
async function getPdfFonts() {
  if (_pdfFonts !== undefined) return _pdfFonts
  try { const r = window.api && window.api.pdfFonts && await window.api.pdfFonts(); _pdfFonts = (r && r.ok) ? r : null }
  catch { _pdfFonts = null }
  return _pdfFonts
}
async function saveExport(bytes, defaultName, filters) {
  if (!(window.api && window.api.exportFile)) { appAlert('需在桌面客户端中运行'); return }
  const r = await window.api.exportFile({ defaultName, data: bytes, filters })
  // 成功/取消无需提示（已走系统保存对话框，用户自选路径即知结果）；仅失败弹错。
  if (r && !r.ok && !r.canceled) { const msg = (r && r.error) || '写入失败'; appAlert('导出失败：' + msg) }
}
// fmt: 'png2' | 'png4' | 'pdf' | 'gxt' | 'kml'。
// scope: 'world'(整幅世界图，默认) | 'view'(截图，当前视图所见即所得)。
//   world：无论当前在 2D 还是 3D，都按 2D 平面图导出整幅世界图（矢量）。
//   view ：2D 平面图下按屏幕缩放/平移出矢量图；3D 球体下抓球面那一帧（位图，见 exportGlobeShot）。
// gxt/kml 是数据导出（当前画面绘制的覆盖等值线，GXT+GRD 来源，同 collectGxt），与 scope 无关。
async function exportMap(fmt, scope) {
  if (exporting.value) return
  // 数据导出（GXT/KML）统一走 exportDrawn：覆盖等值线 + 协调区多边形一起导（所见即所得），与 scope 无关。
  if (fmt === 'gxt' || fmt === 'kml') { return exportDrawn(fmt) }
  const view = scope === 'view'
  if (view && !flatView.value) return exportGlobeShot(fmt)
  exporting.value = true; exportFlat.value = true
  try {
    await ensureCovIndex(); if (!covCleared.value) redraw()
    await nextTick()
    if (!ensureFlat()) { appAlert('地图渲染器未就绪，请切到 2D 平面图后重试'); return }
    // ★ 必须在 feedFlat 之前置位：导出走 exportRender 的 compat 回放，只认 fillBands；而 compat 是
    //   exportRender 内部才置的，几何层（feedFlat → grd.recompute）比它先跑。置位后 fieldBackend()
    //   恒答 'paths'，这一轮就照旧出分带多边形 → PNG/PDF 与改造前逐字节相同。
    flat.setExporting(true)
    await feedFlat()   // resize() 仅首帧 fit，已交互过的缩放/平移会保留 → view 模式即所见即所得
    await nextTick()
    const tag = view ? '截图' : '全球图'
    const { renderFlatPNG, renderFlatPDF } = await import('../viz/flatmap/exportFlat.js')
    if (fmt === 'pdf') {
      // 矢量 PDF【不跟】「设置」里的底图精度：那一档是给屏上帧率用的（出厂「高」= 50m），
      // 而 PDF 是拿来放大着看的交付件 —— 50m 的海岸线一放大就是折线。导出恒用 10m，画完复位
      // （见 exportFlat 的 withFinestBasemap；PNG 同此，两份出图不会一细一粗）。
      const fonts = await getPdfFonts()
      const bytes = await renderFlatPDF(flat, { base: 2400, fonts, view })
      await saveExport(bytes, `覆盖图_${tag}.pdf`, [{ name: 'PDF 矢量图', extensions: ['pdf'] }])
    } else {
      // 2×/4× 是倍率档；4K/8K 是【目标像素宽】档。后者存在的理由：倍率算出来的实际宽度随视口尺寸
      // 浮动（同一个 4× 在 1280 与 1920 宽的窗口上出的图不一样大），而交付方要的是「一张 8K 图」。
      //
      // ★ 「倍率封顶 4×、再往上是净负」那条旧判据只对【整幅贴图时代】成立 —— 那时影像恒为 2.45 km/px，
      //   放大不多一个真像素。上了瓦片金字塔后前提变了：以 L6 的 978 m/px 算，影像还能真正填满的
      //   宽度 = 视野经度跨度 ÷ 0.0088°，全球图 40960 px、中国全境约 7054 px。故全球/洲际图出 8K
      //   是实打实的；拉到省级以下再要 8K 仍然是空放大（矢量层照旧不多一个折点）。
      const TARGET = { png8k: 7680 }
      const targetW = TARGET[fmt] || 0
      const factor = targetW ? 0 : (fmt === 'png4' ? 4 : 2)
      const bytes = await renderFlatPNG(flat, { base: 2400, factor: factor || 2, targetW, view })
      // 文件名写【实际】出图宽：画布面积撞上 Chromium 的 268 MPix 上限时会被折回来，不报没渲染过的数
      const lbl = targetW ? `${bytes.outW}px` : `${factor}x`
      await saveExport(bytes, `覆盖图_${tag}_${lbl}.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
    }
  } catch (e) { console.error('导出失败', e); appAlert('导出失败：' + ((e && e.message) || e)) }
  finally {
    exporting.value = false; exportFlat.value = false
    // 复位后再重算一轮：屏上那份换回 GPU 网格（导出期间被换成了分带多边形）
    if (flat) { flat.setExporting(false); grd.recompute() }
  }
}

// 3D 球体截图：把渲染分辨率抬到倍率再取一帧（机位/图层/主题一概不动 → 所见即所得）。
// 出的是 WebGL 画布本身，不含叠在它上面的 HTML 面板（聚焦卡片 / 图例）——与 2D 出图只画地图同口径。
// PNG 按菜单倍率（2×/4×，见下面封顶那段注释）；PDF 是一页一张位图（球面没有几何可矢量化），固定 4×。
async function exportGlobeShot(fmt) {
  if (!scene) { appAlert('3D 视图未就绪'); return }
  exporting.value = true
  try {
    const { renderGlobePNG, renderGlobePDF } = await import('../viz/globe3d/exportGlobe.js')
    const tag = '3D截图'   // 文件名与 2D 那条同格式（覆盖图_全球图 / 覆盖图_截图）
    if (fmt === 'pdf') {
      const r = await renderGlobePDF(scene, { factor: 4 })
      await saveExport(r.bytes, `覆盖图_${tag}.pdf`, [{ name: 'PDF 文档', extensions: ['pdf'] }])
    } else {
      // 同样封顶 4×，这条还多一层硬理由：帧缓冲 ~32 MPix 的天花板（见 scene.js 的 snapshot）会把大画布上的
      // 高倍率请求全折回同一个值 —— 1500×950 上请求 6/8/10× 拿回来的是同一张 4.73× 的图（字节级相同）。
      // 且地名/图标是 fs=54 的纹理精灵，屏上约 4 倍过采样，4× 正好 1:1，再往上只是插值放大。
      const TARGET = { png8k: 7680 }
      const targetW = TARGET[fmt] || 0
      const r = await renderGlobePNG(scene, { factor: fmt === 'png2' ? 2 : 4, targetW })
      // 文件名写【实际】出图尺寸：3D 这条的 32 MPix 帧缓冲天花板会把高倍请求整体折回（实测
      // 1900×1150 上 4× 只出得到 3.2×），8K 档在多数窗口尺寸上也到不了 7680 —— 如实写渲出来的宽，
      // 不报一个没渲染过的数。用户看文件名就知道这台机器实际能出多大。
      const lbl = targetW ? `${r.w}px` : `${Math.round(r.factor * 10) / 10}x`
      await saveExport(r.bytes, `覆盖图_${tag}_${lbl}.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
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
function focusCovSat(it) { const idx = idxOf(it.folder); if (idx && idx.lon != null) scene.faceLonLat(idx.lon, 0) }

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
function applyNameScale() {
  if (scene) scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value, oceanNameSize.value, seaNameSize.value)
  if (flat) flat.setSizes({ nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value, oceanScale: oceanNameSize.value, seaScale: seaNameSize.value })
}
// 边界线样式 → 3D 与平面图。{ ...borderStyle } 取响应式对象快照传入两个渲染器。
function applyBorderStyle() { const s = { ...borderStyle }; if (scene) scene.setBorderStyle(s); if (flat) flat.setBorderStyle(s) }
function setBorderVal(k, v) { borderStyle[k] = v; applyBorderStyle() }
function toggleBorderFade() { borderStyle.fade = !borderStyle.fade; applyBorderStyle() }
// 分组 / 整节恢复出厂样式
function resetBorderPart(k) { for (const f of (BORDER_PARTS[k] || [])) borderStyle[f] = BORDER_DEF[f]; applyBorderStyle() }
function resetBorderAll() { Object.assign(borderStyle, BORDER_DEF); applyBorderStyle() }
// 样式预设：只套颜色，线宽与线型这类结构性区分不跟着变（那是五类线彼此可分的根据）
function applyBorderPreset(k) {
  if (k === 'default') return resetBorderAll()
  Object.assign(borderStyle, BORDER_PRESET_VAL[k] || {})
  applyBorderStyle()
}
// 地名颜色/透明度 → 3D 与平面图。
function applyLabelStyle() { const s = { ...labelStyle }; if (scene) scene.setLabelStyle(s); if (flat) flat.setLabelStyle(s) }
// 水域注记（大洋 / 海域）→ 3D 与平面图。档位与逐条显隐两件事分开推：前者只改可见性，
// 后者要重建精灵（决定造不造那一条），故别合并成一个入口。
function applyWaterMode() {
  const m = { ocean: oceanNameMode.value, sea: seaNameMode.value }
  if (scene) scene.setWaterMode(m)
  if (flat) flat.setWaterMode(m)
}
function applyWaterOff() {
  const o = { ...waterOff }   // ★ 出 IPC / 出模块前现造纯数据：响应式 Proxy 别往渲染器里递
  if (scene) scene.setWaterOff(o)
  if (flat) flat.setWaterOff(o)
}
function setWaterNameMode(k, m) { (k === 'ocean' ? oceanNameMode : seaNameMode).value = m; applyWaterMode() }
// 逐条勾选清单：勾上＝显示。清单按档位取（大洋 5 条 / 海域 70 条），带搜索框
const waterQuery = ref('')
const waterRows = (k) => {
  const q = waterQuery.value.trim().toLowerCase()
  const list = waterList(k)
  return q ? list.filter((w) => w.zh.includes(q) || w.en.toLowerCase().includes(q)) : list
}
const waterOn = (id) => !waterOff[id]
function toggleWater(id) { if (waterOff[id]) delete waterOff[id]; else waterOff[id] = true; applyWaterOff() }
function setWaterAll(k, on) {
  for (const w of waterRows(k)) { if (on) delete waterOff[w.id]; else waterOff[w.id] = true }
  applyWaterOff()
}
// 地名主从列表的取/存：国家名走 nameMode + countryNameSize，两级行政区走 admName* + prov/cityNameSize，
// 水域两档走 ocean/seaNameMode + ocean/seaNameSize。
// 各档的档位值域不同（国家与水域是 zh/en/off，行政区是 local/en/off），故档位由 NAME_ROWS[].modes 逐行给。
const NAME_SIZE_REF = { country: countryNameSize, prov: provNameSize, city: cityNameSize, ocean: oceanNameSize, sea: seaNameSize }
const nameRowMode = (k) => (k === 'country' ? nameMode.value : k === 'prov' ? admName1.value : k === 'city' ? admName2.value : k === 'ocean' ? oceanNameMode.value : seaNameMode.value)
function setNameRowMode(k, m) {
  if (k === 'country') setNameMode(m)
  else if (k === 'ocean' || k === 'sea') setWaterNameMode(k, m)
  else admSetName(k === 'prov' ? 1 : 2, m)
}
// 「地名」整节恢复出厂：五档的档位 / 字号 / 颜色 / 透明度，加上水域两档的逐条勾选，一起回出厂值。
// ★ 档位也一起回 —— 同 resetBorderAll 的口径：「本节恢复出厂」就是这一节里的每一项都回去，不挑着回。
//   出厂态是国家名与水域两档「不显示」、两级行政区名跟界面语言（见各自的初值）。
//   行政区图层的显隐不在这一节里（那是「行政区」一节的事），故不动 showProvinces / showCities。
function resetNameAll() {
  countryNameSize.value = NAME_SIZE_DEF.country
  provNameSize.value = NAME_SIZE_DEF.prov
  cityNameSize.value = NAME_SIZE_DEF.city
  oceanNameSize.value = NAME_SIZE_DEF.ocean
  seaNameSize.value = NAME_SIZE_DEF.sea
  Object.assign(labelStyle, LABEL_DEF)
  for (const k of Object.keys(waterOff)) delete waterOff[k]
  waterQuery.value = ''
  oceanNameMode.value = 'off'; seaNameMode.value = 'off'
  setNameMode('off')
  applyWaterMode(); applyWaterOff(); applyNameScale(); applyLabelStyle()
  const loc = curLang() === 'en' ? 'en' : 'local'
  admSetName(1, loc); admSetName(2, loc)
}
// 换一行就清掉搜索框：搜索是那一档清单的临时筛子，留着会让下一档看起来「少了一半」
function pickNameRow(k) { namePick.value = k; waterQuery.value = '' }
// 行尾读数：关着就写「不显示」；水域两档另报「勾了几条 / 共几条」，全勾则不报
function nameRowTag(r) {
  if (nameRowMode(r.k) === 'off') return byLang('不显示', 'Hidden')
  if (!r.water) return ''
  const all = waterList(r.water), on = all.filter((w) => waterOn(w.id)).length
  return on === all.length ? '' : on + ' / ' + all.length
}
const nameRowSize = (k) => (NAME_SIZE_REF[k] ? NAME_SIZE_REF[k].value : 1)
function setNameRowSize(k, v) {
  const n = Number(v)
  if (!Number.isFinite(n) || !NAME_SIZE_REF[k]) return
  NAME_SIZE_REF[k].value = n
  applyNameScale()
}
// 聚焦卫星样式 → 3D 与平面图。颜色两边口径不同：three.js 要数值、Canvas 要 CSS 串（同 termStyle 的做法）。
// 环色例外：它画进 canvas 纹理，3D 那边也收 CSS 串。
const focusStyle3D = () => ({
  orbOn: focusStyle.orbOn, orbColor: hexNum(focusStyle.orbColor), orbWidth: focusStyle.orbWidth, orbOpacity: focusStyle.orbOpacity, orbDash: focusStyle.orbDash,
  trkOn: focusStyle.trkOn, trkColor: hexNum(focusStyle.trkColor), trkWidth: focusStyle.trkWidth, trkOpacity: focusStyle.trkOpacity, trkDash: focusStyle.trkDash,
  trkMode: focusStyle.trkMode, trkFillColor: hexNum(focusStyle.trkFillColor), trkFillOpacity: focusStyle.trkFillOpacity,
  fpOn: focusStyle.fpOn, fpColor: hexNum(focusStyle.fpColor), fpWidth: focusStyle.fpWidth, fpOpacity: focusStyle.fpOpacity, fpDash: focusStyle.fpDash,
  fpFillColor: hexNum(focusStyle.fpFillColor), fpFillOpacity: focusStyle.fpFillOpacity,
  coneOn: focusStyle.coneOn, coneFaceColor: hexNum(focusStyle.coneFaceColor), coneFaceOpacity: focusStyle.coneFaceOpacity,
  coneGenCount: focusStyle.coneGenCount, coneGenColor: hexNum(focusStyle.coneGenColor), coneGenWidth: focusStyle.coneGenWidth, coneGenOpacity: focusStyle.coneGenOpacity, coneGenDash: focusStyle.coneGenDash,
  dotOn: focusStyle.dotOn, dotPx: focusStyle.dotPx, subPx: focusStyle.subPx, subColor: hexNum(focusStyle.subColor),
  ringOn: focusStyle.ringOn, ringColor: focusStyle.ringColor, ringPx: focusStyle.ringPx
})
const focusStyle2D = () => ({
  trkOn: focusStyle.trkOn, trkColor: focusStyle.trkColor, trkWidth: focusStyle.trkWidth, trkOpacity: focusStyle.trkOpacity, trkDash: focusStyle.trkDash,
  trkMode: focusStyle.trkMode, trkFillColor: focusStyle.trkFillColor, trkFillOpacity: focusStyle.trkFillOpacity,
  fpOn: focusStyle.fpOn, fpColor: focusStyle.fpColor, fpWidth: focusStyle.fpWidth, fpOpacity: focusStyle.fpOpacity, fpDash: focusStyle.fpDash,
  fpFillColor: focusStyle.fpFillColor, fpFillOpacity: focusStyle.fpFillOpacity,
  subOn: focusStyle.subOn, subPx: focusStyle.subPx, subColor: focusStyle.subColor
})
// 改样式/改圈数都走这里：样式在几何【重建】时才被读到，故改完立刻重喂一次，否则要等下一拍才生效。
// 圈数改的是几何本身（多采几个周期），同样由这次 commitGeometry 重算。
function applyFocusStyle() {
  if (scene) { scene.setFocusStyle(focusStyle3D()); scene.setSatPointsVisible(focusStyle.cloudOn) }
  if (flat) flat.setFocusStyle(focusStyle2D())
  ringDirty = true      // 线型/开关会改变顶点本身（颜色线宽不会，但分不开就一起重算 —— 上了 Worker 池之后不贵）
  commitGeometry()
  applyModelStyle()     // 模型图标 / HUD 不走几何，单独推给模型层（「默认」按钮也走这里）
}
// 「轨迹圈数」与分区「默认」：几何本身变了（多采几个周期；「默认」还会把线型回填成出厂值），
// 与改样式【同一条路】—— 别只调 commitGeometry：轨道圈是缓存几何，不置 ringDirty 就不会重建，
// 拖一下圈数滑杆轨道线就停在旧线型上、点一下「默认」更是要等 TTL 到期才回来。
function applyFocusGeom() { applyFocusStyle() }
// 分节恢复出厂样式（每节标题上那个「默认」）：只回填本节的字段，别人调好的不动。
// 覆盖圈那节不含口径（波束角/最低仰角是分析参数不是样式，见 fpMode/beam/elevMin）。
const FOCUS_PARTS = {
  orb: ['orbOn', 'orbColor', 'orbWidth', 'orbOpacity', 'orbDash'],
  trk: ['trkOn', 'trkMode', 'trkColor', 'trkWidth', 'trkOpacity', 'trkDash', 'trkFillColor', 'trkFillOpacity', 'trkPeriods', 'trkSpanMode', 'trkSpanMin'],
  fp: ['fpOn', 'fpColor', 'fpWidth', 'fpOpacity', 'fpDash', 'fpFillColor', 'fpFillOpacity'],
  cone: ['coneOn', 'coneFaceColor', 'coneFaceOpacity', 'coneGenCount', 'coneGenColor', 'coneGenWidth', 'coneGenOpacity', 'coneGenDash'],
  mk: ['cloudOn', 'dotOn', 'dotPx', 'subOn', 'subPx', 'subColor', 'ringOn', 'ringColor', 'ringPx'],
  model: ['modelOn', 'modelPx', 'hudAxes', 'hudLvlh', 'hudNadir', 'hudVel', 'hudSun', 'hudIsl', 'hudEs', 'hudMounts', 'followImagery']
}
function resetFocusPart(k) {
  for (const f of (FOCUS_PARTS[k] || [])) focusStyle[f] = FOCUS_STYLE_DEF[f]
  applyFocusGeom()
}
function toggleFocus(k) { focusStyle[k] = !focusStyle[k]; applyFocusStyle() }
function setFocusVal(k, v) { focusStyle[k] = v; applyFocusStyle() }
// 信息卡右上角齿轮：切到「聚焦卫星」侧栏视图（三节默认展开的照旧，收着的不强行掰开）
function openFocusSettings() { shellUi.side = 'focus' }
// 宇宙空间 → 3D 与平面图。时刻取【时间轴当前值】calcAt()，不是系统时钟：拖时间轴看某历史 / 未来时刻时太阳、星空、晨昏必须跟着走，
// 否则「那颗星当时在不在阳照区」就读错了。每次 refreshPositions（实时每秒 / 时间轴每次落点）调一次；总开关关着时逐件清层。
// 六项各走各的通道（setSpace / setNightShade / setTerminator），互不牵连。
// 颜色：three.js 要数值，Canvas 要 CSS 串 —— 同一份 space 样式各自转换，避免两处配色漂移。
const hexNum = (s) => parseInt(String(s || '#000000').replace('#', ''), 16) || 0
function applySpace() {
  const on = spaceOn.value
  const now = calcAt()
  spaceSub.value = on ? solarGeometry(now).sub : null
  const night = on && space.night, line = on && space.line
  // 晨昏线自带的夜区阴影（硬边）只在晨昏效果不勾时画：勾着时夜区归晨昏效果（柔和过渡带），不叠两层（2026-09-24 用户定）
  const shade = line && !night ? space.shadeOpacity : 0
  if (scene) {
    scene.setSpace(on ? { date: now, stars: space.stars ? { gain: space.starGain } : null, atmo: space.atmo ? { gain: space.atmoGain } : null, sun: space.sun ? { glare: space.sunGlare } : null } : null)
    scene.setNightShade(night ? now : null, { color: hexNum(space.nightColor), opacity: space.nightOpacity })
    scene.setTerminator(line ? now : null, { lineColor: hexNum(space.lineColor), lineWidth: space.lineWidth, lineOpacity: space.lineOpacity, shadeColor: hexNum(space.shadeColor), shadeOpacity: shade })
  }
  if (flat) {
    flat.setNightShade(night ? spaceSub.value : null, { color: space.nightColor, opacity: space.nightOpacity })
    flat.setTerminator(line ? now : null, { lineColor: space.lineColor, lineWidth: space.lineWidth, lineOpacity: space.lineOpacity, shadeColor: space.shadeColor, shadeOpacity: shade })
  }
  // 卫星模型的光照跟晨昏效果走（用户定「没有晨昏效果的情况下，地球和卫星应该全亮」）：
  // 勾着 = 按太阳打光 + 地影压暗；不勾 = 全亮（图标相机头灯、跟随影棚档）。每拍都调，层里没变就不动
  if (modelLayer) modelLayer.setSunLit(night)
  if (entityLayer) entityLayer.setSunLit(night)   // 标记实体模型同一口径（关 = 全亮；开 = 按当地太阳高度角打光 + 相机侧补光）
}
// 开关类改动（总开关 / 六项勾选 / 恢复默认）：重画之外，还要按「地球影像」那一项给 / 撤两个视图的影像
function applySpaceStyle() { applySpace(); applyImagery() }
// 标题栏搜索里点子项（fromCmd）：用户要的只是【这一项】。
//   总开关关着时去开某一项 → 开总开关、只勾这一项，其余几项的勾选先记下、暂时去勾（搜「晨昏线」只想看分界线，
//   不该连星空 / 大气 / 太阳 / 16K 影像一起上屏 —— 16K 解码几秒、~700 MB 显存）；
//   之后又从搜索里把它关掉、且已没有别的项勾着 → 总开关跟着关、记下的勾选原样还回去（回到点之前的样子）。
//   侧栏里亲手动总开关 / 勾选 / 恢复默认 = 用户接手，记下的那份作废（此后搜索关掉最后一项也不替他关总开关）。
const SPACE_ITEMS = ['stars', 'atmo', 'sun', 'img', 'night', 'line']
let spaceCmdSnap = null
function toggleSpace() { spaceCmdSnap = null; spaceOn.value = !spaceOn.value; applySpaceStyle() }
function setSpaceItem(k, v, fromCmd) {
  v = !!v
  if (!fromCmd) spaceCmdSnap = null
  if (fromCmd && v && !spaceOn.value) {
    spaceCmdSnap = Object.fromEntries(SPACE_ITEMS.map((x) => [x, space[x]]))
    for (const x of SPACE_ITEMS) space[x] = x === k
    spaceOn.value = true
  } else {
    space[k] = v
    if (fromCmd && !v && spaceCmdSnap && spaceOn.value && !SPACE_ITEMS.some((x) => space[x])) {
      spaceOn.value = false
      Object.assign(space, spaceCmdSnap)
      spaceCmdSnap = null
    }
  }
  applySpaceStyle()
}
// 本节恢复出厂（不动总开关）：地球影像并进来之后，它的档位 / 亮度也归本节
function resetSpace() { spaceCmdSnap = null; Object.assign(space, SPACE_DEF); setImageryKey(DEFAULT_IMAGERY); setImageryBright(1); applySpaceStyle() }
// 岛链 → 3D 与平面图。一个入口把整层开关 / 逐条显隐 / 样式一起推下去（渲染器只改给到的那几项）。
function applyChains() {
  const o = { on: chainOn.value, off: { ...chainOff }, ...chainStyle }   // ★ 响应式 Proxy 不出本模块
  if (scene) scene.setChains(o)
  if (flat) flat.setChains(o)
}
function toggleChains() { chainOn.value = !chainOn.value; applyChains() }
function toggleChain(id) { if (chainOff[id]) delete chainOff[id]; else chainOff[id] = true; applyChains() }
const chainVisible = (id) => !chainOff[id]
function setChainName(m) { chainStyle.name = m; applyChains() }
function resetChains() { Object.assign(chainStyle, CHAIN_DEF); for (const k of Object.keys(chainOff)) delete chainOff[k]; applyChains() }
// 大海颜色 → 3D 与平面图。
function setOceanColor(c) { oceanColor.value = c; if (scene) scene.setOceanColor(c); if (flat) flat.setOceanColor(c) }
// 档位 title：全用符号与通用缩写 → i18n 零负担（口径见 imagery.js 的源清单注释）。
// 瓦片档没有「整幅像素尺寸」这回事，报的是金字塔最深级与显存上界；3D 球上它换成整幅（见 applyImagery），尾巴补一句 3D 用哪张。
function imageryTitle(im) {
  const res = im.resKm < 1 ? Math.round(im.resKm * 1000) + ' m/px' : im.resKm + ' km/px'
  const size = im.tiles ? 'L0–L' + im.maxZ + ' · 512² tiles' : im.w + ' × ' + im.h
  const s3 = im.tiles ? imagerySource(IMG_3D_FULL) : null
  // 在线档标出「需联网」：这台机器上首次看一片新区域要等几秒，且涉密网可能整个不通
  return size + ' · ' + res + (im.online ? ' · 需联网' : '') + ' · ' + im.credit + ' · VRAM ≈ ' + im.vramMB + ' MB' + (s3 && !s3.tiles ? ' · 3D ' + s3.zh : '')
}
// 换档：先把要换掉的那一侧卸掉（显存），再按新档走一遍。set:null 同时把瓦片档的片与纹理一起放掉 ——
// 少了它，从瓦片档切到整幅档会两份显存并存（135 + 716 MB）。3D 那侧的档没变（高精 ↔ 16K，3D 都是 16K 整幅）就不碰它，省一次重传。
// ★ 旧写法的在飞闸是「有人在加载就走开」：16K 解码的那几秒里点另一档，新档一次都没去加载（旧纹理却已卸掉 → 影像消失），
//   在飞那次回来还把旧图塞回去（屏上 16K、高亮 8K）。现在回调里按「此刻该用哪一张」核对后再贴、再补跑（见 applyImagery）。
function setImageryKey(k) {
  if (imageryKey.value === k) return
  const before = imageryPlan()
  imageryKey.value = k
  const after = imageryPlan()
  if (flat && before.s2 !== after.s2) { flat.setImagery({ img: null, set: null, on: false }); img2d = null }
  if (scene && before.s3 !== after.s3) { scene.setImagery({ img: null, set: null, on: false }); img3d = null }
  applyImagery()
}
function setImageryBright(e) {
  const v = Number(e && e.target ? e.target.value : e)
  if (!Number.isFinite(v)) return
  imageryBright.value = v
  if (scene) scene.setImagery({ bright: v })
  if (flat) flat.setImagery({ bright: v })
}
// 大地颜色 → 3D 与平面图（写公共色板状态 + 两端重建陆地）。3D 重建三角网有数百 ms 量级，
// 取色器拖动会连发 input → 防抖合并；色块点击/删除等一次性操作立即执行（now=true）。
let landTimer = 0
function applyLandColors(now) {
  const s = { scheme: landScheme.value, overrides: { ...landOverrides } }
  if (landTimer) clearTimeout(landTimer)
  landTimer = setTimeout(() => { landTimer = 0; if (scene) scene.setLandColors(s); if (flat) flat.setLandColors(s) }, now ? 0 : 200)
}
function setLandScheme(v) { if (v === 'morandi' || HEX6.test(v)) { landScheme.value = v; applyLandColors(true) } }
function pickLandCountry(c) { landPick.value = { id: c.id, zh: c.zh }; landQuery.value = c.zh }
function setLandCountryColor(id, color) { if (HEX6.test(color)) { landOverrides[id] = color; applyLandColors() } }
function removeLandCountryColor(id) { delete landOverrides[id]; applyLandColors(true) }
function clearLandOverrides() { for (const k of Object.keys(landOverrides)) delete landOverrides[k]; applyLandColors(true) }
// 显示画质（全局档位）→ 应用到 3D / 2D / 覆盖网格。msaa 不在此（需重建上下文，由 3D 视图按 key 重挂载切换）。
function applyDisplayQuality() {
  const q = displayQuality.value
  if (scene) { scene.setPixelRatio(q.pixelRatio); scene.setRenderFps(q.fps); scene.setSphereDetail(q.sphereSeg); scene.setMapDetail(q.mapDetail, q.mapThin) }
  if (flat) { flat.setRenderScale(q.pixelRatio); flat.setMapDetail(q.mapDetail, q.mapThin) }
  grd.recompute()   // gridStride 变化 → 覆盖层按新步长重建（无选中层时为空操作）
}
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
    sats.push({ lon: idx.lon, name: idx.displayName, bold: beamLabelBold.value })   // 3D 星位处的卫星名：字重随「波束名」那档
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
            labels.push({ lon: top[0], lat: top[1], text: String(c.g), hpx: contourLabelSize.value / 533, color: '#ffffff', alt: 50, bold: contourLabelBold.value })
          }
        }
        if (showBore.value) for (const b of (d.bore || [])) { dots.push({ lon: b[0], lat: b[1] }); bores.push({ lon: b[0], lat: b[1], satLon: idx.lon }) }
        if (showBeamLabels.value && d.bore && d.bore[0]) labels.push({ lon: d.bore[0][0], lat: d.bore[0][1], text: r.beam, hpx: beamLabelSize.value / 533, bold: beamLabelBold.value })
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
        out.push({ name: r.beam, satName: idx.displayName, lon: idx.lon, band: r.band || '', type: it.type || 'EIRP', bore: d.bore || [], contours, emiRcp: 'E' })
      }
    }
  }
  if (grd && grd.exportContours) { try { out.push(...grd.exportContours()) } catch (e) { console.warn('GRD 导出等值线失败', e) } }
  return out
}

// 显示中的协调区多边形 → 与 collectGxt 同形的「波束」列表（按卫星名+轨位分组，组内每多边形一条闭合等值线，值=数值栏）。
// 用于把多边形并入统一 GXT 导出（每组一个 diagram，GeoMain 取该组卫星信息）。
function collectPolyBeams() {
  const list = polys.value.filter((pg) => pg.show !== false && pg.pts && pg.pts.length >= 3)
  if (!list.length) return []
  const groups = new Map()
  for (const pg of list) {
    const key = `${(pg.satName || '').trim()}|${(pg.satLon || '').toString().trim()}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(pg)
  }
  return [...groups.values()].map((gs) => {
    const g0 = gs[0], lonN = Number(g0.satLon)
    const contours = gs.map((pg) => { const v = Number(pg.value); return { g: Number.isFinite(v) ? v : 0, p: closeRing(pg.pts) } })
    return { name: 'Polygon', satName: (g0.satName || '').trim() || 'Polygon', lon: Number.isFinite(lonN) ? lonN : 0, bore: [], contours, emiRcp: 'E' }
  })
}

// 统一数据导出（所见即所得）：把当前画面绘制的一切——覆盖等值线（GXT/GRD 来源）+ 协调区多边形——合成一份 GXT/KML。
// GXT：覆盖波束 + 多边形组各自一个 diagram，拼接为多 diagram 文件。KML：覆盖等值线按档位渐变、多边形按各自颜色，同一 Document。
async function exportDrawn(fmt) {
  if (exporting.value) return
  const covBeams = collectGxt()
  const polyList = polys.value.filter((pg) => pg.show !== false && pg.pts && pg.pts.length >= 3)
  const polyBeams = collectPolyBeams()
  if (!covBeams.length && !polyBeams.length) { appAlert('当前画面没有可导出的覆盖等值线或协调区多边形'); return }
  exporting.value = true
  try {
    if (fmt === 'gxt') {
      const blocks = [...covBeams, ...polyBeams].map((b, i) => serializeGxt({ ...b, beamId: b.name || (i + 1) }))
      await saveExport(blocks.join('\r\n'), '当前绘制.gxt', [{ name: 'GXT 等值线', extensions: ['gxt'] }])
    } else {
      const text = serializeKml(covBeams, { name: '当前绘制', polys: polyList })
      await saveExport(text, '当前绘制.kml', [{ name: 'KML', extensions: ['kml'] }])
    }
  } catch (e) { console.error('导出失败', e); appAlert('导出失败：' + ((e && e.message) || e)) }
  finally { exporting.value = false }
}

// 采集「当前绘制状态」为发送到小程序的快照 JSON：覆盖层（每条等值线烘入 #RRGGBB 配色 + 频段/类型，
// 与 redraw 同口径的批次归一化）+ 协调区多边形（绕过 GXT、保真名称/数值/线色/填充）。
// 小程序据 coverage.beams 就地建「卫星→频段→波束→EIRP/GT」索引重绘，零配色/分档逻辑。
function buildMiniappSnapshot() {
  const beams = []
  for (const it of covItems.value) {
    const idx = idxOf(it.folder); if (!idx) continue
    const rowById = new Map(beamRowsOf(it).map((r) => [r.id, r]))
    for (const ba of it.batches) {
      const eff = batchEffGains(ba)
      const datas = []
      for (const id of ba.beams) {
        const r = rowById.get(id); if (!r) continue
        const d = covCache[r.file]; if (!d) continue
        datas.push({ r, d })
      }
      // 批次生效增益档极值（与 redraw 一致），供 contourColor 渐变归一
      const allG = []
      for (const { d } of datas) for (const c of d.contours) if (eff.has(c.g)) allG.push(c.g)
      const gmin = allG.length ? Math.min(...allG) : 0, gmax = allG.length ? Math.max(...allG) : 1
      for (const { r, d } of datas) {
        const contours = []
        for (const c of d.contours) {
          if (!eff.has(c.g)) continue
          contours.push({ g: c.g, color: hexToCss(contourColor(ba, c.g, gmin, gmax)), p: c.p })
        }
        if (!contours.length) continue
        beams.push({ satName: idx.displayName, lon: idx.lon, band: r.band || '', beam: r.beam || '', type: it.type || 'EIRP', emiRcp: 'E', bore: d.bore || [], contours })
      }
    }
  }
  // GRD 来源（天线方向图覆盖）：无频段/类型，按 EIRP 归桶、按本波束增益档做同款渐变配色
  if (grd && grd.exportContours) {
    try {
      for (const b of grd.exportContours()) {
        const gs = (b.contours || []).map((c) => c.g)
        const gmin = gs.length ? Math.min(...gs) : 0, gmax = gs.length ? Math.max(...gs) : 1
        const contours = (b.contours || []).map((c) => ({ g: c.g, color: hexToCss(gainHex(gmax > gmin ? (c.g - gmin) / (gmax - gmin) : 1)), p: c.p })).filter((c) => c.p && c.p.length >= 2)
        if (!contours.length) continue
        beams.push({ satName: b.satName || '', lon: b.lon, band: '', beam: b.name || '', type: 'EIRP', emiRcp: 'E', bore: b.bore || [], contours })
      }
    } catch (e) { console.warn('GRD 快照采集失败', e) }
  }
  const polygons = polys.value.filter((pg) => pg.show !== false && pg.pts && pg.pts.length >= 3).map((pg) => ({
    name: pg.name || '', value: (pg.value != null ? String(pg.value) : ''),
    satName: pg.satName || '', satLon: (pg.satLon != null ? String(pg.satLon) : ''),
    color: pg.color || '#3b82f6', fillOn: pg.fillOn !== false, fillColor: pg.fillColor || pg.color || '#3b82f6',
    fillOp: (typeof pg.fillOp === 'number' ? pg.fillOp : 0.18), labelSize: pg.labelSize || 16,
    pts: pg.pts.map((p) => [p[0], p[1]])   // 拷成纯数组：pg.pts 是 Vue 响应式 Proxy，直接进 IPC 会被 V8 ValueSerializer 拒绝（An object could not be cloned）
  }))
  // 自动命名：不同卫星名去重拼接（无覆盖层时退化为多边形/默认名），供小程序端列表展示
  const satNames = [...new Set(beams.map((b) => b.satName).filter(Boolean))]
  const name = satNames.length ? satNames.join('、') : (polygons.length ? '协调区多边形' : '覆盖快照')
  return { app: 'satsim', kind: 'gxt-snapshot', v: 1, name, createdAt: Date.now(), coverage: { beams }, polygons }
}

// 发送到小程序：打开共用的发送弹窗（与链路预算三窗、文件区同一个 MiniSendDialog）。
// 两种投法在那里选：投给已绑定的小程序账号（免密钥、自动同步），或生成一次性密钥。
// ★ 快照是【整块载荷】，没有 items[] —— 弹窗按 raw 形态收（见 MiniSendDialog 的 build 约定），
//   不套 makePack 的信封：它自带 kind='gxt-snapshot'，套上去小程序那边反而认不出来。
async function sendToMiniapp() {
  if (miniSendOpen.value) return
  if (!(window.api && window.api.share)) { appAlert('需在桌面客户端中运行'); return }
  // 先问「配没配」再开弹窗：没凭证时上传必然失败，与其让用户填完一轮再看到「发送失败」，
  // 不如一上来就说清是配置问题（凭证随安装包分发，见 electron/services/shareConfig.example.js）
  try {
    miniConfigured.value = !!(await window.api.share.configured())
    if (!miniConfigured.value) {
      appAlert('本机未配置在线分享凭证，无法发送到小程序。')
      return
    }
  } catch (e) { miniConfigured.value = true /* configured 本身失败则照常往下走，由上传阶段报错 */ }
  const snap = buildMiniappSnapshot()
  if (!snap.coverage.beams.length && !snap.polygons.length) { appAlert('当前画面没有可发送的覆盖等值线或多边形'); return }
  try { miniDeviceId.value = String((await window.api.app.deviceId()) || '') } catch (e) { /* 显示用，取不到无妨 */ }
  // 快照只在这里攒一次：弹窗里改目标星 / 改名每敲一个字都会重攒一次包，而 buildMiniappSnapshot
  // 要把画面上每条等值线过一遍。弹窗是模态的（遮罩盖住整页），打开期间画面不会变。
  miniSnap.value = snap
  miniCustomSats.value = readMiniCustomSats()
  miniSendOpen.value = true
}

// ===================== 星座 → 小程序「星座地图」 =====================
// 卫星组 / 自定义卫星（导入星历） / 自定义星座 三类，各打成一件「卫星集」（见 shared/satconMiniExport.js）。
// 与覆盖快照走同一条通道、同一个弹窗：绑定账号直投（自动同步、按 setId 覆盖）或生成一次性密钥。
// 载荷是 OMM 根数本身而非 NORAD 清单 —— 小程序那边照 omm2satrec 直接建 satrec，零联网。
let miniSatItems = []

// 卫星组只存了 NORAD 清单，发送前要按号找回根数。来源两处：
//   · 全量目录并集（loadUniverse 已含本地自定义卫星库，按 NORAD 覆盖同号目录星）
//   · 自定义星座合成星（号段 900000+，不在任何目录里，只能从参数展开）
async function satGroupRecordMap() {
  const map = new Map()
  try { for (const r of customConstellationsToOmmRecords()) map.set(String(r.noradId), r) } catch { /* 无自建星座 */ }
  try { for (const s of await loadUniverse(true)) map.set(String(s.noradId), s) } catch { /* 离线：只剩合成星能解出来 */ }
  return map
}

// 攒出发送弹窗的包内清单。次序＝侧栏从上到下：卫星组 → 自定义卫星 → 自定义星座。
async function buildMiniSatItems() {
  const items = []
  const groups = satGroups.list.value

  // 1) 卫星组（有组才去建全量目录 —— 那一步要联网/读缓存，没组时纯属白等）
  if (groups.length) {
    const map = await satGroupRecordMap()
    for (const g of groups) {
      const recs = []
      for (const s of g.sats) { const r = map.get(String(s.id)); if (r) recs.push(r) }
      const it = makeSatSetItem({ srcKind: 'group', id: g.id, name: g.name, records: recs, epochMode: 'file' })
      if (it) {
        // 解析不全时把差额写进名字之外的日志：包里少几颗而界面上不说，到手机上才发现就晚了
        if (it.count < g.sats.length) logMsg(`卫星组「${g.name}」：${g.sats.length} 颗中有 ${g.sats.length - it.count} 颗未在当前星历中找到，本次不发送这几颗`)
        items.push(it)
      } else logMsg(`卫星组「${g.name}」：没有一颗能解析出星历，已跳过`)
    }
  }

  // 2) 自定义卫星：「文件管理 · 星历」导入的每一个组各成一件（与那边逐条导出同口径）
  if (apiOk && window.api.omm.customGroupRecords) {
    try {
      const r = await window.api.omm.customList()
      for (const g of (r && r.groups) || []) {
        let recs = []
        try { recs = await window.api.omm.customGroupRecords(g.id) } catch { recs = [] }
        const it = makeSatSetItem({ srcKind: 'custom', id: g.id, name: g.name, records: recs, epochMode: 'file' })
        if (it) items.push(it)
      }
    } catch { /* 读不到自定义库：只发别的 */ }
  }

  // 3) 自定义星座（Walker）：按参数展开成 OMM 记录，历元＝场景历元（与本页渲染同口径）
  for (const c of customConst.list.value) {
    let recs = []
    try { recs = customConstellationsToOmmRecords(c.id) } catch { recs = [] }
    const it = makeSatSetItem({ srcKind: 'walker', id: c.id, name: c.name, records: recs, epochMode: 'scenario', epoch: customConst.scenarioEpoch.value })
    if (it) items.push(it)
  }

  return items
}

async function sendSatsToMiniapp() {
  if (miniSatOpen.value) return
  if (!(window.api && window.api.share)) { appAlert('需在桌面客户端中运行'); return }
  try {
    miniConfigured.value = !!(await window.api.share.configured())
    if (!miniConfigured.value) {
      appAlert('本机未配置在线分享凭证，无法发送到小程序。')
      return
    }
  } catch (e) { miniConfigured.value = true /* configured 本身失败则照常往下走，由上传阶段报错 */ }
  status.value = '整理卫星集…'
  let items = []
  try { items = await buildMiniSatItems() } catch (e) { appAlert('整理失败：' + ((e && e.message) || e)); return } finally { status.value = '' }
  if (!items.length) { appAlert('没有可发送的内容：还没有卫星组、导入的自定义卫星或自定义星座'); return }
  miniSatItems = items
  try { miniDeviceId.value = String((await window.api.app.deviceId()) || '') } catch (e) { /* 显示用，取不到无妨 */ }
  miniSatOpen.value = true
}
const buildMiniSatSend = () => ({ name: '星座地图数据', items: miniSatItems })

// ===================== 航迹 → 小程序「卫星覆盖 · 航迹」 =====================
// 标记层的航行 / 飞行航迹一条一件（见 shared/trajMiniExport.js）：内容清单逐条可勾，幂等键挂在航迹上，
// 平台改了哪条重发哪条、手机上就覆盖哪条。样式（整层两档色 / 逐条覆盖色 / 线粗 / 线型 / 圆点 / 图标 / 航迹名）
// 在这里按 markStyle 解析好随件送过去，手机上与这里同色同形。与上面两路同一个弹窗、同一条通道。
const miniTrajOpen = ref(false)
let miniTrajItems = []
async function sendTrajsToMiniapp() {
  if (miniTrajOpen.value) return
  if (!(window.api && window.api.share)) { appAlert('需在桌面客户端中运行'); return }
  try {
    miniConfigured.value = !!(await window.api.share.configured())
    if (!miniConfigured.value) {
      appAlert('本机未配置在线分享凭证，无法发送到小程序。')
      return
    }
  } catch (e) { miniConfigured.value = true /* configured 本身失败则照常往下走，由上传阶段报错 */ }
  // 打开时现攒：弹窗是模态的，打开期间航迹与样式都改不了（出 IPC 前 miniPack 会再深拷成纯数据）
  const items = trajItemsOf(trajectories.value, markStyle)
  if (!items.length) { appAlert('没有可发送的航迹。'); return }
  // 超过单条上限的（导入的航行日志）抽稀后再送：日志里记一笔原点数与送出点数，不静默少送
  for (const it of items) if (it.n0) logMsg(byLang(`航迹「${it.name}」${it.n0} 点，抽稀为 ${it.n} 点（容差 ${it.tolM} m）`, `Track “${it.name}”: ${it.n0} points thinned to ${it.n} (tolerance ${it.tolM} m)`))
  miniTrajItems = items
  try { miniDeviceId.value = String((await window.api.app.deviceId()) || '') } catch (e) { /* 显示用，取不到无妨 */ }
  miniTrajOpen.value = true
}
const buildMiniTrajSend = () => ({ name: '航迹数据', items: miniTrajItems })

// 「目标卫星」：这份覆盖挂到小程序哪颗星下。候选 / 解析 / 名称与幂等键 / 自定义星的记忆都在
// shared/covMiniExport.js（纯函数，有 Node 测试），这里只接画面状态。
// ★ 必须由人来定：快照里的星名是平台侧的叫法，小程序那边的波束是按 satelliteName 归类显示的，
//   对不上就是「导进去了却在任何一颗星下面都看不见」。
// ★★ 内置那段别改回平台自己的 SAT_PRESETS —— 那是超集（含 JCSAT 等小程序没有的星）且顺序不同，
//   两边下拉对不上，正是 2026-08-02 用户反馈的问题。
const MINI_CUSTOM_KEY = 'globe3d/miniCustomSats'  // 发送成功过的自定义目标星 [{ name, lon }]，最近的在前
const miniSnap = shallowRef(null)                 // 打开弹窗时攒的快照（shallow：几万个点的折线不必变响应式）
const miniCustomSats = ref([])
function readMiniCustomSats() {
  try { return parseCustoms(localStorage.getItem(MINI_CUSTOM_KEY)) } catch { return [] }
}
const miniBeams = () => (miniSnap.value && miniSnap.value.coverage.beams) || []
const miniSatOptions = computed(() => covTargetOptions({
  beams: miniBeams(),
  customs: miniCustomSats.value,
  // <optgroup> 的 label 是属性，呈现层只翻 title / placeholder 一类，故按语言现出字
  groups: { builtin: zhEn('小程序内置卫星', 'Mini Program built-in'), custom: zhEn('自定义卫星', 'Custom satellites') },
  manualLabel: '手动指定…'
}))
const miniPicks = computed(() => [
  { key: 'sat', label: '目标卫星', options: miniSatOptions.value, default: covDefaultTarget(miniBeams(), miniSatOptions.value) },
  { key: 'satName', label: '卫星名称', type: 'text', required: true, when: { sat: COV_MANUAL } },
  { key: 'satLon', label: '轨道位置', type: 'number', unit: '°E', min: -180, max: 360, required: true, title: '东经为正，负值表示西经', when: { sat: COV_MANUAL } }
])

// picked 是「目标卫星」等几项的选值；opts.name 是用户在清单里改过的名称（'' = 没改过，按目标星自动命名）
function buildMiniSend(picked, opts) {
  return covUnit(miniSnap.value || buildMiniappSnapshot(), resolveCovTarget(picked, miniSatOptions.value), opts && opts.name)
}

// 发送成功后记住非内置的目标星（手动指定的、画面里的），下次在「自定义卫星」段里直接选，不必再输
function onMiniSent({ picked }) {
  const list = rememberCovTarget(readMiniCustomSats(), resolveCovTarget(picked, miniSatOptions.value))
  if (!list) return
  try { localStorage.setItem(MINI_CUSTOM_KEY, JSON.stringify(list)) } catch { /* 记不住只是下次要重输 */ }
  miniCustomSats.value = list
}

// ===================== Polygon（协调区多边形，仿 SATSOFT Polygon Editor 精简版） =====================
// 频率协调常用做法：画一个多边形圈定区域，对整个区域标一个数值（通常为功率谱密度，数值含义与单位由
// 协调材料约定，软件不做定义）。绘制交互与轨迹一致：「＋ 绘制」后右键地图连续加顶点（3D / 2D 均可），
// 顶部横幅「完成」闭合。多边形挂在卫星/仰角线独立图层（redrawSats）：3D/2D/高清导出图均可见，
// 且不受覆盖图「清除绘制」影响。数据存 localStorage（与标记同策略），导出走现有 GXT/KML 序列化器。
const POLY_KEY = 'globe3d/polygons'
const POLY_COLORS = ['#e05252', '#3f7fd0', '#2f9e63', '#c78a2d', '#8a5fc9', '#2ba0a8']
const polys = ref([])           // [{ id, name, value, color, width, show, pts:[[lon,lat],...] }]
const polyDrawId = ref('')      // 正在绘制（右键加顶点）的多边形 id；''=不在绘制态
const polyEditId = ref('')      // 正在调整顶点（平面图拖动顶点）的多边形 id；与绘制/拖动态互斥
const polyMoveId = ref('')      // 正在整体拖动（平面图按住多边形内部拖）的多边形 id；与绘制/调整态互斥
const polyVertsOpen = ref('')   // 展开「顶点表」的多边形 id
const polyDotSize = ref(2.5)    // 顶点圆点半径（屏幕 px，绘制/调点时显示）
const polyOffAmt = ref(0.5)     // 「扩大/缩小」幅度（度，纬度当量）
const polyOpen = toRef(covNav, 'polyOpen')   // 右侧 Polygon 面板开关；与顶栏按钮共用 covNav store
const curPoly = () => polys.value.find((p) => p.id === polyDrawId.value)
const curEditPoly = () => polys.value.find((p) => p.id === polyEditId.value)
const curMovePoly = () => polys.value.find((p) => p.id === polyMoveId.value)
const closeRing = (pts) => { const f = pts[0], l = pts[pts.length - 1]; return (f[0] === l[0] && f[1] === l[1]) ? pts : [...pts, f] }
// 顶点均值作标签锚点。经度须跨 ±180° 短路展开后再平均——否则多边形骑跨东经 180° 时（部分顶点 ≈+180、部分 ≈−180）
// 直接算术平均会落到 ≈0°（地球背面），标签「乱飞」。以首点为基准把各经度展开到其 ±180° 邻域，平均后再归一回 [−180,180]。
const polyCentroid = (pts) => {
  const ref = pts[0][0]
  let sx = 0, sy = 0
  for (const p of pts) { let d = p[0] - ref; d = ((d % 360) + 540) % 360 - 180; sx += ref + d; sy += p[1] }
  let lon = sx / pts.length; lon = ((lon % 360) + 540) % 360 - 180
  return [lon, sy / pts.length]
}
// 折线加密：相邻顶点间按 ≤step 度步长线性插值（经度取短路方向，输出不回卷、由渲染器自行归一）。
// 2D 等距圆柱投影下插值点共线、视觉不变；3D 上让长边贴球面走——否则两远顶点间的直线弦会切入
// 地球内部，被深度测试遮挡（即「多边形在 3D 视图被地球模型挡住」的根源）。
const densifyDeg = (pts, step = 1) => {
  if (!pts || pts.length < 2) return pts
  const out = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i]
    let dlon = b[0] - a[0]; dlon = ((dlon % 360) + 540) % 360 - 180
    const dlat = b[1] - a[1]
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dlon), Math.abs(dlat)) / step))
    for (let j = 1; j <= n; j++) out.push([a[0] + dlon * j / n, a[1] + dlat * j / n])
  }
  return out
}
function togglePolyPanel() {
  polyOpen.value = !polyOpen.value
  if (!polyOpen.value) { polyEditStop(); polyMoveStop() }   // 关面板即退出调整/拖动（绘制态保留：横幅上有完成/取消）
}
function persistPolys() { try { localStorage.setItem(POLY_KEY, JSON.stringify({ polys: polys.value, dotSize: polyDotSize.value, offAmt: polyOffAmt.value })) } catch { /* ignore */ } }
function loadPolys() {
  try {
    const d = JSON.parse(localStorage.getItem(POLY_KEY) || 'null')
    const list = Array.isArray(d) ? d : (d && Array.isArray(d.polys) ? d.polys : null)   // 旧格式为裸数组，兼容
    if (list) polys.value = list.filter((p) => p && p.id && Array.isArray(p.pts))
    // 旧数据补默认：填充（开、色随线色、18% 不透明）与中央标注字号（16px）
    for (const p of polys.value) {
      if (p.fillOn === undefined) p.fillOn = true
      if (!p.fillColor) p.fillColor = p.color
      if (!Number.isFinite(Number(p.fillOp))) p.fillOp = 0.18
      if (!Number.isFinite(Number(p.labelSize))) p.labelSize = 16
    }
    if (d && !Array.isArray(d)) {
      if (Number.isFinite(d.dotSize)) polyDotSize.value = d.dotSize
      if (Number.isFinite(Number(d.offAmt))) polyOffAmt.value = d.offAmt
    }
  } catch { /* ignore */ }
}
function polyRefresh() { redrawSats(); syncEdit(); persistPolys() }
// 赋形面板就地改 Polygon「数值」= 该区覆盖值/目标电平（与协调区 Polygon 同一字段，改后持久化 + 重绘标签）
function setPolyVal(pg, v) { if (!pg) return; pg.value = (v == null ? '' : String(v)).trim(); polyRefresh() }
// 改线色：填充色若未单独设置（仍与线色一致）则跟着走，设置过就各改各的
function polySetColor(pg, v) {
  if (!pg.fillColor || pg.fillColor === pg.color) pg.fillColor = v
  pg.color = v; polyRefresh()
}
function polyStartDraw() {
  mkEditStop(); polyEditStop(); polyMoveStop(); stopSynthPlacement(); if (activeTraj.value) endTraj()   // 与标记「调整点位置」/调整/拖动/波束合成/航迹描绘态互斥
  const n = polys.value.length + 1
  const c = POLY_COLORS[(n - 1) % POLY_COLORS.length]
  const pg = { id: 'pg' + Date.now().toString(36) + n, name: 'Polygon ' + n, value: '', satName: '', satLon: '', color: c, fillOn: true, fillColor: c, fillOp: 0.18, width: 2, labelSize: 16, show: true, pts: [] }
  polys.value.push(pg); polyDrawId.value = pg.id
}
function polyContinue(pg) { mkEditStop(); polyEditStop(); polyMoveStop(); stopSynthPlacement(); if (activeTraj.value) endTraj(); pg.show = true; polyDrawId.value = pg.id; polyRefresh() }
function polyUndo() { const pg = curPoly(); if (pg && pg.pts.length) { pg.pts.pop(); polyRefresh() } }
function polyDone() {
  const pg = curPoly(); if (!pg) { polyDrawId.value = ''; return }
  if (pg.pts.length < 3) { appAlert('多边形至少需要 3 个顶点。'); return }
  polyDrawId.value = ''; polyRefresh()
}
function polyCancel() {
  const pg = curPoly(); polyDrawId.value = ''
  if (pg && pg.pts.length < 3) polys.value.splice(polys.value.indexOf(pg), 1)   // 未成形的直接丢弃
  polyRefresh()
}
function removePoly(pg) {
  if (polyDrawId.value === pg.id) polyDrawId.value = ''
  if (polyEditId.value === pg.id) polyEditId.value = ''
  if (polyMoveId.value === pg.id) polyMoveId.value = ''
  const i = polys.value.indexOf(pg); if (i >= 0) polys.value.splice(i, 1)
  polyRefresh()
}
function togglePoly(pg) {
  pg.show = !(pg.show !== false)
  if (!pg.show) { if (polyEditId.value === pg.id) polyEditId.value = ''; if (polyMoveId.value === pg.id) polyMoveId.value = '' }
  polyRefresh()
}
// ---- 调整顶点（仿 SATSOFT：选中多边形后直接拖动顶点）。在 2D 平面图进行，进入时自动切换视图 ----
function polyEditToggle(pg) {
  if (polyEditId.value === pg.id) { polyEditStop(); return }
  mkEditStop(); stopSynthPlacement()   // 与标记「调整点位置」/波束合成互斥
  if (polyDrawId.value) polyCancel()   // 与绘制态互斥
  polyMoveId.value = ''                // 与整体拖动互斥
  polyEditId.value = pg.id; pg.show = true
  if (!view.flat) view.flat = true     // 切到平面图（applyFlat→feedFlat 会同步编辑态到渲染器）
  polyRefresh()
}
function polyEditStop() { if (polyEditId.value) { polyEditId.value = ''; polyRefresh() } }
// ---- 整体拖动（仿 SATSOFT：按住多边形内部整体平移）。同样在 2D 平面图进行 ----
function polyMoveToggle(pg) {
  if (polyMoveId.value === pg.id) { polyMoveStop(); return }
  mkEditStop(); stopSynthPlacement()   // 与标记「调整点位置」/波束合成互斥
  if (polyDrawId.value) polyCancel()   // 与绘制态互斥
  polyEditId.value = ''                // 与调整顶点互斥
  polyMoveId.value = pg.id; pg.show = true
  if (!view.flat) view.flat = true
  polyRefresh()
}
function polyMoveStop() { if (polyMoveId.value) { polyMoveId.value = ''; polyRefresh() } }
// 把当前可拖拽的顶点（传引用，拖动实时生效）喂给平面渲染器做命中/拖拽。
// 波束合成「调整中心/删除波束」优先；否则回退到 Polygon 调点/整体拖动。二者互斥，共用同一 editVerts 槽。
// ★ 标记（点标记/地球站/航点）不占这个槽：它们走 setMarkerDrag/setOnMarkerDrag 那条路，抓符号本体、带起手差。
function syncEdit() {
  if (!flat) return
  if ((bs.adjusting.value || bs.deleting.value) && bs.open.value) {   // 波束合成调整中心/删除波束：手柄命中用波束中心快照（拖动时原地更新）
    bsEditPts = bs.beams.value.map((b) => [b.lon, b.lat])
    flat.setEditVerts({ pts: bsEditPts, px: MK_HANDLE_PX, move: false, cursor: bs.deleting.value ? 'pointer' : 'move' }); return
  }
  bsEditPts = null
  const pg = curEditPoly() || curMovePoly()
  flat.setEditVerts(pg ? { pts: pg.pts, px: polyDotSize.value, move: !!curMovePoly() } : null)
}
// 顶点拖拽回调分发：波束合成删除波束/调整中心→波束；否则→ Polygon 顶点（标记不走这条，见 syncEdit）
function onVertexDrag(vi, ll, phase) {
  if (bs.deleting.value && bs.open.value) {   // 删除波束：命中即删（按下 'start' 触发一次，拖动/抬起阶段不再处理）
    if (phase === 'start' && vi != null) bs.removeBeamAt(vi)
    return
  }
  if (bs.adjusting.value && bs.open.value) {
    bs.dragBeam(vi, ll, phase)
    // 命中快照回填用【波束实际坐标】（dragBeam 内可能相切吸附微调过），保证手柄与轮廓严格同步
    if (phase !== 'end' && vi != null && ll && bsEditPts && bsEditPts[vi]) {
      const b = bs.beams.value[vi]
      if (b) { bsEditPts[vi][0] = b.lon; bsEditPts[vi][1] = b.lat }
    }
    redrawSats(); return
  }
  onPolyVertexDrag(vi, ll, phase)
}
// Polygon 顶点拖拽：'move' 只改点+重绘（与平移同频，不写盘），'end' 统一持久化
function onPolyVertexDrag(vi, ll, phase) {
  const pg = curEditPoly(); if (!pg) return
  if (phase === 'end') { persistPolys(); return }
  if (vi == null || !ll || vi < 0 || vi >= pg.pts.length) return
  pg.pts[vi] = [ll.lon, ll.lat]
  redrawSats()
}
// 整体拖动回调（增量制）：'move' 全顶点平移+重绘，'end' 统一持久化
function onPolyMoveDrag(dlon, dlat, phase) {
  const pg = curMovePoly(); if (!pg) return
  if (phase === 'end') { persistPolys(); return }
  if (!dlon && !dlat) return
  for (const q of pg.pts) { q[0] += dlon; q[1] = clamp(q[1] + dlat, -89.9, 89.9) }
  redrawSats()
}
// hold-to-draw 回调：渲染器已按屏幕像素阈值节流上报（起笔/沿路径/收笔），页面每次追加一个点。
// 'move' 只实时预览（不落盘，避免高频写 localStorage）；'end' 统一持久化。与右键连续加点并存。
// Polygon 与航迹共用同一套绘制态（左键按住沿路径连续加点）——两者互斥，按当前活动态分发。
function onPolyDraw(ll, phase) {
  const pg = curPoly()
  if (pg) {   // Polygon 绘制中
    if (phase === 'end') { if (pg.pts.length) persistPolys(); return }
    if (!ll) return
    pg.pts.push([ll.lon, ll.lat]); redrawSats(); return
  }
  const t = curTraj()
  if (t) {   // 航迹描绘中：与 Polygon 同款左键拖动连续加航点
    if (phase === 'end') { persistMarkers(); return }
    if (!ll) return
    t.pts.push({ lat: ll.lat, lon: ll.lon }); pushMarkers(); return
  }
}
// ---- 复制多边形（仿 SATSOFT Copy）：副本整体偏移一点便于分辨，并直接进入整体拖动模式好摆放 ----
function polyCopy(pg) {
  const n = polys.value.length + 1
  const c = POLY_COLORS[(n - 1) % POLY_COLORS.length]
  const trackFill = !pg.fillColor || pg.fillColor === pg.color   // 填充色随线色 → 副本也随新线色
  const cp = {
    id: 'pg' + Date.now().toString(36) + n,
    name: (pg.name || 'Polygon') + ' 副本',
    value: pg.value, satName: pg.satName || '', satLon: pg.satLon || '',
    color: c, fillOn: pg.fillOn !== false, fillColor: trackFill ? c : pg.fillColor,
    fillOp: Number.isFinite(Number(pg.fillOp)) ? pg.fillOp : 0.18,
    width: pg.width || 2, labelSize: pg.labelSize || 16, labelBold: !!pg.labelBold, show: true,
    pts: pg.pts.map((p) => [p[0] + 3, clamp(p[1] - 3, -89.9, 89.9)])
  }
  polys.value.push(cp)
  polyMoveToggle(cp)   // 内含 polyRefresh + 持久化
}
// ---- 扩大 / 缩小（仿 SATSOFT Expand/Shrink：按幅度外扩/内收一圈，生成新多边形，原多边形保留） ----
// 平面近似：经度按质心纬度 cos 修正后，各顶点沿相邻两边外法线的角平分线偏移 d 度（纬度当量）；
// 直边处即垂直偏移 d，尖角处米特长度封顶 5|d| 防爆冲。d>0 外扩、d<0 内收。
function offsetPolyPts(pts, d) {
  const n = pts.length; if (n < 3) return null
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / n
  const cl = Math.max(0.2, Math.cos(lat0 * DEG))
  const P = pts.map((p) => [p[0] * cl, p[1]])
  let A = 0; for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; A += a[0] * b[1] - b[0] * a[1] }
  const sgn = A >= 0 ? 1 : -1   // 顶点绕向：CCW 时外法线在行进方向右侧，CW 反之
  const norm = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9; return [sgn * dy / L, -sgn * dx / L] }
  const out = []
  for (let i = 0; i < n; i++) {
    const p0 = P[(i - 1 + n) % n], p1 = P[i], p2 = P[(i + 1) % n]
    const n1 = norm(p0, p1), n2 = norm(p1, p2)
    const ux = n1[0] + n2[0], uy = n1[1] + n2[1], uu = ux * ux + uy * uy
    let ox, oy
    if (uu < 1e-9) { ox = n1[0] * d; oy = n1[1] * d }   // 180° 折返边：退化为单边法线
    else { const m = 2 * d / uu; ox = ux * m; oy = uy * m }
    const L = Math.hypot(ox, oy), cap = Math.abs(d) * 5
    if (L > cap) { ox *= cap / L; oy *= cap / L }
    out.push([(p1[0] + ox) / cl, clamp(p1[1] + oy, -89.9, 89.9)])
  }
  return out
}
function polyOffset(pg, sign) {
  const amt = Math.abs(Number(polyOffAmt.value))
  if (!amt || !Number.isFinite(amt)) { appAlert('「扩/缩幅度」需大于 0。'); return }
  if (pg.pts.length < 3) { appAlert('该多边形还未成形（至少 3 个顶点），不能扩/缩'); return }
  const pts = offsetPolyPts(pg.pts, amt * sign)
  if (!pts) return
  const n = polys.value.length + 1
  const c = POLY_COLORS[(n - 1) % POLY_COLORS.length]
  const trackFill = !pg.fillColor || pg.fillColor === pg.color
  polys.value.push({
    id: 'pg' + Date.now().toString(36) + n,
    name: `${pg.name || 'Polygon'}${sign > 0 ? '+' : '-'}${amt}°`,
    value: pg.value, satName: pg.satName || '', satLon: pg.satLon || '',
    color: c, fillOn: pg.fillOn !== false, fillColor: trackFill ? c : pg.fillColor,
    fillOp: Number.isFinite(Number(pg.fillOp)) ? pg.fillOp : 0.18,
    width: pg.width || 2, labelSize: pg.labelSize || 16, labelBold: !!pg.labelBold, show: true, pts
  })
  polyRefresh()
}
// 顶点表（仿 SATSOFT Table Edit）：文本框逐行「经度, 纬度」，失焦提交，整体校验通过才写回。
// ★ 编辑期间必须用草稿顶住：本组件模板里有秒级时间读数（timeParts ← clock.tMs），实时/播放时每秒
//   重渲染一次，而 Vue 对 <textarea> 的 value 是无条件回写 —— 不顶住的话改到一半就被库里的旧顶点打回。
//   校验没过时草稿【留着】（弹了框还把人家打的字清掉，等于白改一遍）。
const vertsDraft = ref(null)     // { id, text }
const polyVertsText = (pg) => pg.pts.map((p) => `${(+p[0]).toFixed(3)}, ${(+p[1]).toFixed(3)}`).join('\n')
function polyVertsVal(pg) { const d = vertsDraft.value; return d && d.id === pg.id ? d.text : polyVertsText(pg) }
function polyVertsEdit(pg, e) {
  const pts = []
  for (const raw of String(e.target.value).split(/\r?\n/)) {
    const s = raw.trim(); if (!s) continue
    const m = s.split(/[,;，；\s]+/).map(Number)
    if (m.length < 2 || !Number.isFinite(m[0]) || !Number.isFinite(m[1]) || Math.abs(m[0]) > 360 || Math.abs(m[1]) > 90) { appAlert('顶点格式有误：每行一个顶点「经度, 纬度」（度），如 116.4, 39.9'); return }
    pts.push([m[0], m[1]])
  }
  if (pts.length < 3) { appAlert('多边形至少需要 3 个顶点'); return }
  vertsDraft.value = null                 // 写回成功才退出草稿：此后显示跟着库里的顶点走
  pg.pts = pts; polyRefresh()
}
// 复制顶点为「两列」：逐行 经度<Tab>纬度——粘到 Excel / 表格会自动落进经度、纬度两个单元格（普通逗号复制只会挤进一格）。
function copyPolyVerts(pg) {
  if (!pg.pts.length) { appAlert('该多边形还没有顶点'); return }
  const text = pg.pts.map((p) => `${(+p[0]).toFixed(3)}\t${(+p[1]).toFixed(3)}`).join('\n')
  perfWriteClipboard(text)
}
// 文本框框选复制：把选中内容每行的「经度, 纬度」逗号分隔改写成 Tab（两列）写入剪贴板——显示仍是逗号（好读），
// 复制出去即两列，粘到 Excel 自动分成经度/纬度两列。未选中则走默认复制。
function onVertsCopy(e) {
  const ta = e.target
  const sel = ta.value.substring(ta.selectionStart, ta.selectionEnd)
  if (!sel || !e.clipboardData) return
  const two = sel.split(/\r?\n/).map((line) => line.replace(/\s*,\s*/, '\t')).join('\n')
  e.clipboardData.setData('text/plain', two); e.preventDefault()
}
// Polygon 面板「导出 GXT / KML」：与顶栏「导出」菜单同一功能——覆盖等值线 + 协调区多边形一起导（所见即所得）。
const exportPolys = (fmt) => exportDrawn(fmt)

// 闭合环 → 开放环：内部 pg.pts 不含末尾闭合重复点（导出时才由 closeRing 补），导入须去掉。
const openRing = (pts) => {
  if (!pts || pts.length < 2) return pts ? pts.slice() : []
  const f = pts[0], l = pts[pts.length - 1]
  return (f[0] === l[0] && f[1] === l[1]) ? pts.slice(0, -1) : pts.slice()
}
// 解析结果 → 一个协调区多边形对象（字段与 polyStartDraw 同构）。无色时按 POLY_COLORS 轮转配色。
function makeImportedPoly(r, n) {
  const c = (r.color && HEX6.test(r.color)) ? r.color : POLY_COLORS[(n - 1) % POLY_COLORS.length]
  const fillC = (r.fillColor && HEX6.test(r.fillColor)) ? r.fillColor : c
  const nm = (r.name && String(r.name).trim()) || ('Polygon ' + n)
  return {
    id: 'pg' + Date.now().toString(36) + n, name: nm,
    value: r.value != null ? String(r.value) : '', satName: r.satName || '', satLon: r.satLon != null ? String(r.satLon) : '',
    color: c, fillOn: r.fillOn !== false, fillColor: fillC,
    fillOp: (typeof r.fillOp === 'number' && r.fillOp >= 0 && r.fillOp <= 1) ? r.fillOp : 0.18,
    width: 2, labelSize: 16, labelBold: !!r.labelBold, show: true,
    pts: (r.pts || []).map((p) => [Number(p[0]), Number(p[1])]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  }
}
// Polygon 面板「导入」：原生框选 .gxt / .kml → 解析为协调区多边形，追加到列表（不覆盖已有）。
// GXT：每条等值线 = 一个多边形（值=gain，卫星/轨位取 GeoMain）；KML：每个 <Polygon> = 一个多边形（尽量还原名称/数值/颜色）。
async function importPolys() {
  if (!(window.api && window.api.poly && window.api.poly.open)) { appAlert('需在桌面客户端中运行'); return }
  let res
  try { res = await window.api.poly.open() } catch (e) { appAlert('导入失败：' + ((e && e.message) || e)); return }
  if (!res || res.canceled) return
  const added = [], errs = []
  let seq = polys.value.length
  for (const f of (res.files || [])) {
    if (f.error || !f.text) { errs.push((f.base || '文件') + '：' + (f.error || '空文件')); continue }
    try {
      if (f.ext === 'kml') {
        for (const r of parseKmlPolys(f.text)) { const pg = makeImportedPoly(r, ++seq); if (pg.pts.length >= 3) added.push(pg) }
      } else {
        const parsed = parseGxt(f.text)
        const meta = { satName: parsed.satName || '', satLon: Number.isFinite(parsed.lon) ? String(parsed.lon) : '' }
        for (const c of (parsed.contours || [])) {
          const pts = openRing(c.p)
          if (pts.length < 3) continue
          added.push(makeImportedPoly({ ...meta, value: Number.isFinite(c.g) ? String(c.g) : '', pts }, ++seq))
        }
      }
    } catch (e) { errs.push((f.base || '文件') + '：' + ((e && e.message) || e)) }
  }
  if (!added.length) { appAlert('未能导入多边形：' + (errs[0] || '文件里没有可识别的多边形')); return }
  polys.value.push(...added)
  persistPolys(); polyRefresh()
  appAlert(`已导入 ${added.length} 个多边形` + (errs.length ? `（${errs.length} 个文件失败：${errs[0]}）` : ''))
}

// ===================== 波束合成（SATSOFT Gaussian Beam Model / Polygon 赋形）独立侧栏视图 =====================
// 活动栏独立视图（side='beams'）：与覆盖分析解耦——本视图只管「草图 + 生成」，生成的天线
// 挂到所选卫星下、由覆盖分析视图管理显示/电平/导出（工具 → 产物的关系）。
// 与 Polygon/标记/覆盖各绘制态互斥；放置=地图右键放轮廓，调整=平面图拖动波束中心。
const bsTableOpen = ref(false)                                    // 波束批量表格浮窗
const bsTblWin = ref({ x: 0, y: 0, w: 560, h: 420, init: false })
// 轮廓与编号 / 频率计划 折叠状态迁到 panelSections store（跨会话持久化，键 bs-style / bs-freq，默认收起）
const bsFmt = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '—') // 读数格式化（无效 → 破折号）
// 当前「反射面参数」持有者：高斯档=激活波束设置（每设置一套反射面），赋形档=组级 p。诊断图/开关等据此取参。
const bsRefP = computed(() => (bs.mode.value === 'gauss' ? (bs.curSetting.value || bs.p) : bs.p))
// 站点栅编辑：框选橡皮筋（fixed 定位屏幕像素，flatCoverage 回调驱动）+ 目标偏置输入
const bsStBox = reactive({ on: false, x: 0, y: 0, w: 0, h: 0 })
const bsStGoal = ref('')
function bsOnBoxSelect(phase, r) {
  if (phase === 'start' || phase === 'move') {
    if (r) { bsStBox.on = true; bsStBox.x = Math.min(r.x0, r.x1); bsStBox.y = Math.min(r.y0, r.y1); bsStBox.w = Math.abs(r.x1 - r.x0); bsStBox.h = Math.abs(r.y1 - r.y0) }
    return
  }
  bsStBox.on = false
  if (r && r.a && r.b) bs.stBoxSelect(r.a, r.b, !!r.add, !!r.sub)
  else if (r && r.at) bs.stClickSelect(r.at, !!r.add, !!r.sub)   // 原地点击：命中站点=单选/增减选；未命中=清选（Ctrl/Alt 保持）
  else bs.clearStSel()
}
watch(() => bs.stEditOn.value, (v) => { if (flat) flat.setBoxSelectMode(v); if (!v) bsStBox.on = false })
// 「框选」开关：橡皮筋只在平面图上（3D 球面没有框选）→ 开启即切平面图 + 打开站点显示，
// 否则按钮亮着却没有任何东西可框（与「调整中心」同款处理）
function bsStEditToggle() {
  const on = !bs.stEditOn.value
  bs.toggleStEdit()
  if (on) { if (!view.flat) view.flat = true; if (bs.p.stShow === false) bs.p.stShow = true }
}
// 仿真频率「同设计」开关：取消勾选且尚无有效仿真频率时，以设计频率为起点（对齐 SATSOFT Sim Frequency 复选框；
// 已填过的仿真频率保留，反复勾选不覆写）
function bsSimSameToggle(v) {
  const rp = bsRefP.value; if (!rp) return
  rp.simSame = !!v
  if (!v && !(Number(rp.fSim) > 0)) rp.fSim = Number(rp.fGHz)
}
// —— 赋形反射面几何预览（对齐 SATSOFT Shaped Reflector 对话框小图：1/2 正视、2/2 侧视剖面）——
// v-html 内容全部由数值计算生成（无任何用户字符串），无注入面
const bsReflView = ref(1)
const bsReflSvg = computed(() => {
  const W = 248, H = 168
  const rp = bsRefP.value || bs.p
  const D = Number(rp.antD), F = Number(rp.foc)
  const open = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="var(--font-mono)">`
  if (!(D > 0) || !(F > 0)) return open + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-faint)" font-size="11">口径 / 焦距无效</text></svg>`
  const clr = Math.max(-0.5, Number(rp.offsetClr) || 0)
  const x1 = clr * D, x2 = x1 + D, xc = x1 + D / 2
  const s = []
  if (bsReflView.value === 1) {
    // 正视（从反射面背后朝地球看）：原点=父抛物面轴/馈源，X 轴向左、Y 轴向上，口径圆在 +X 侧
    const hx = Math.max(x2, 0) - Math.min(x1, 0)
    const sf = Math.min((W - 48) / Math.max(hx, 1e-6), (H - 28) / D)
    const X0 = W - 26, Yc = H / 2
    const cx = X0 - sf * xc, cy = Yc, r = sf * D / 2
    s.push(`<line x1="${X0}" y1="${Yc}" x2="12" y2="${Yc}" stroke="#e05252" stroke-opacity=".55"/>`)
    s.push(`<polygon points="6,${Yc} 14,${Yc - 3.5} 14,${Yc + 3.5}" fill="#e05252" fill-opacity=".7"/>`)
    s.push(`<text x="16" y="${Yc - 6}" fill="#e05252" fill-opacity=".8" font-size="11">X</text>`)
    s.push(`<line x1="${X0}" y1="${H - 8}" x2="${X0}" y2="10" stroke="#3fb77f" stroke-opacity=".6"/>`)
    s.push(`<polygon points="${X0},4 ${X0 - 3.5},12 ${X0 + 3.5},12" fill="#3fb77f" fill-opacity=".75"/>`)
    s.push(`<text x="${X0 - 14}" y="16" fill="#3fb77f" fill-opacity=".85" font-size="11">Y</text>`)
    s.push(`<circle cx="${cx.toFixed(1)}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="var(--text-muted)" stroke-width="1.2"/>`)
    s.push(`<circle cx="${X0}" cy="${Yc}" r="3" fill="none" stroke="#5ad1ff"/>`)
    const pol = String(rp.pol || 'linX')
    if (pol === 'linX') {
      s.push(`<line x1="${(cx + r * 0.4).toFixed(1)}" y1="${cy}" x2="${(cx - r * 0.5).toFixed(1)}" y2="${cy}" stroke="var(--text)" stroke-width="1.4"/>`)
      s.push(`<polygon points="${(cx - r * 0.58).toFixed(1)},${cy} ${(cx - r * 0.42).toFixed(1)},${cy - 3.5} ${(cx - r * 0.42).toFixed(1)},${cy + 3.5}" fill="var(--text)"/>`)
      s.push(`<text x="${(cx + r * 0.4 + 4).toFixed(1)}" y="${cy + 4}" fill="var(--text)" font-size="12">E</text>`)
    } else if (pol === 'linY') {
      s.push(`<line x1="${cx.toFixed(1)}" y1="${(cy + r * 0.4).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(cy - r * 0.5).toFixed(1)}" stroke="var(--text)" stroke-width="1.4"/>`)
      s.push(`<polygon points="${cx.toFixed(1)},${(cy - r * 0.58).toFixed(1)} ${(cx - 3.5).toFixed(1)},${(cy - r * 0.42).toFixed(1)} ${(cx + 3.5).toFixed(1)},${(cy - r * 0.42).toFixed(1)}" fill="var(--text)"/>`)
      s.push(`<text x="${(cx + 5).toFixed(1)}" y="${(cy + r * 0.4 + 2).toFixed(1)}" fill="var(--text)" font-size="12">E</text>`)
    } else {
      s.push(`<text x="${cx.toFixed(1)}" y="${(cy + r * 0.16).toFixed(1)}" text-anchor="middle" fill="var(--text)" font-size="${Math.max(14, r * 0.5).toFixed(0)}">${pol === 'rhcp' ? '↻' : '↺'}</text>`)
      s.push(`<text x="${(cx + r * 0.42).toFixed(1)}" y="${(cy - r * 0.3).toFixed(1)}" fill="var(--text)" font-size="12">E</text>`)
    }
  } else {
    // 侧视剖面（信息量对齐 SATSOFT Shaped Reflector 示意图）：z=x²/4F（z 轴向左=朝地球），馈源在焦点 (F,0)。
    // 两块半透明填充 = SATSOFT 红图同款光路：馈源照射锥（黄，F→截面）+ 反射后出射平行光柱（红，沿轴
    // 朝地球，右界贴反射面弧）；重叠区自然加深。取向保持航天器视角（SATSOFT 画在父抛物面 Rho-Z 数学系）。
    const zOf = (x) => x * x / (4 * F)
    const zMax = Math.max(F, zOf(x1), zOf(x2))
    const yMin = Math.min(x1, 0), yMax = Math.max(x2, 0)
    const ss = Math.min((W - 48) / Math.max(zMax, 1e-6), (H - 28) / Math.max(yMax - yMin, 1e-6))
    const px = (z) => W - 26 - ss * z, py = (x) => H - 14 - ss * (x - yMin)
    const pts = []
    for (let i = 0; i <= 32; i++) { const x = x1 + (x2 - x1) * i / 32; pts.push(`${px(zOf(x)).toFixed(1)},${py(x).toFixed(1)}`) }
    const fx = px(F), fy = py(0)
    const XL = 14                                  // 出射光柱左端（画幅左缘 = 朝地球方向）
    s.push(`<polygon points="${XL},${py(x2).toFixed(1)} ${[...pts].reverse().join(' ')} ${XL},${py(x1).toFixed(1)}" fill="#e05252" fill-opacity=".13"/>`)
    s.push(`<polygon points="${fx.toFixed(1)},${fy.toFixed(1)} ${pts.join(' ')}" fill="#f2c14e" fill-opacity=".15"/>`)
    s.push(`<line x1="${px(0).toFixed(1)}" y1="${fy.toFixed(1)}" x2="${(fx - 16).toFixed(1)}" y2="${fy.toFixed(1)}" stroke="var(--text-faint)" stroke-dasharray="3 3" stroke-opacity=".6"/>`)
    s.push(`<polyline points="${pts.join(' ')}" fill="none" stroke="var(--text)" stroke-width="1.6"/>`)
    s.push(`<line x1="${fx.toFixed(1)}" y1="${fy.toFixed(1)}" x2="${px(zOf(x1)).toFixed(1)}" y2="${py(x1).toFixed(1)}" stroke="#f2c14e" stroke-opacity=".55" stroke-dasharray="4 3"/>`)
    s.push(`<line x1="${fx.toFixed(1)}" y1="${fy.toFixed(1)}" x2="${px(zOf(x2)).toFixed(1)}" y2="${py(x2).toFixed(1)}" stroke="#f2c14e" stroke-opacity=".55" stroke-dasharray="4 3"/>`)
    s.push(`<circle cx="${fx.toFixed(1)}" cy="${fy.toFixed(1)}" r="3" fill="none" stroke="#5ad1ff"/>`)
    s.push(`<text x="${(fx + 6).toFixed(1)}" y="${(fy - 6).toFixed(1)}" fill="var(--text-faint)" font-size="10">馈源(F)</text>`)
    s.push(`<polygon points="14,${fy.toFixed(1)} 24,${(fy - 4).toFixed(1)} 24,${(fy + 4).toFixed(1)}" fill="var(--text-faint)" fill-opacity=".6"/>`)
    s.push(`<text x="30" y="${(fy - 6).toFixed(1)}" fill="var(--text-faint)" font-size="10">朝地球</text>`)
  }
  return open + s.join('') + '</svg>'
})
// —— 相控阵阵面示意图（1/2 阵面正视：Nx×Ny 单元排布；2/2 sin(u,v) 空间 Butler 波束栅）——
// v-html 内容全部由数值计算生成（无用户字符串），无注入面
const bsPamView = ref(1)
const bsPamSvg = computed(() => {
  const W = 248, H = 168
  const gp = bs.p
  const Nx = Math.round(Number(gp.pamNx)), Ny = Math.round(Number(gp.pamNy))
  const dx = Number(gp.pamDx), dy = Number(gp.pamDy), tri = gp.pamTri === true
  const open = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="var(--font-mono)">`
  if (!(Nx > 0) || !(Ny > 0) || !(dx > 0) || !(dy > 0)) return open + `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="var(--text-faint)" font-size="11">阵元数 / 间距无效</text></svg>`
  const s = []
  if (bsPamView.value === 1) {
    // 阵面正视：Nx×Ny 单元格点（矩形或三角错位），间距按 dx:dy 比例；大阵抽样示意
    const capNx = Math.min(Nx, 16), capNy = Math.min(Ny, 16)
    const spanX = (capNx - 1) * dx || 1, spanY = (capNy - 1) * dy || 1
    const sf = Math.min((W - 60) / spanX, (H - 44) / spanY)
    const ox = W / 2 - sf * spanX / 2, oy = (H - 16) / 2 - sf * spanY / 2 + 6
    const rEl = Math.max(1.4, Math.min(4, sf * Math.min(dx, dy) * 0.34))
    for (let j = 0; j < capNy; j++) {
      const off = (tri && j % 2) ? dx / 2 : 0
      const nCol = (tri && j % 2) ? capNx - 1 : capNx
      for (let i = 0; i < nCol; i++) {
        const cx = ox + sf * (i * dx + off), cy = oy + sf * (j * dy)
        s.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rEl.toFixed(1)}" fill="#5ad1ff" fill-opacity=".5" stroke="#5ad1ff" stroke-opacity=".85" stroke-width=".8"/>`)
      }
    }
    s.push(`<text x="${W / 2}" y="${H - 4}" text-anchor="middle" fill="var(--text-faint)" font-size="10">${Nx}×${Ny} 单元 · ${dx}×${dy} λ${tri ? ' · 三角晶格' : ''}${(Nx > capNx || Ny > capNy) ? ' （示意）' : ''}</text>`)
  } else {
    // sin(u,v) 空间：单位圆（可见区 u²+v²=1）+ Butler 波束峰格点（eq 6.14）
    const R = Math.min(W, H) / 2 - 18, cx0 = W / 2, cy0 = (H - 12) / 2
    s.push(`<circle cx="${cx0}" cy="${cy0}" r="${R}" fill="none" stroke="var(--text-muted)" stroke-width="1.1"/>`)
    s.push(`<line x1="${(cx0 - R).toFixed(1)}" y1="${cy0}" x2="${(cx0 + R).toFixed(1)}" y2="${cy0}" stroke="var(--text-faint)" stroke-opacity=".35"/>`)
    s.push(`<line x1="${cx0}" y1="${(cy0 - R).toFixed(1)}" x2="${cx0}" y2="${(cy0 + R).toFixed(1)}" stroke="var(--text-faint)" stroke-opacity=".35"/>`)
    // 大阵抽样：Butler 波束数 = Nx×Ny，上千即 SVG 卡死/OOM → 按步长抽样示意（位置仍用真实 n/m 算，密度不失真）
    const capN = 32
    const stN = Math.max(1, Math.ceil(Nx / capN)), stM = Math.max(1, Math.ceil(Ny / capN))
    for (let n = -Math.floor(Nx / 2); n <= Math.ceil(Nx / 2) - 1; n += stN) {
      for (let m = -Math.floor(Ny / 2); m <= Math.ceil(Ny / 2) - 1; m += stM) {
        const u = (2 * n + 1) / (2 * Nx * dx), v = (2 * m + 1) / (2 * Ny * dy)
        if (u * u + v * v >= 1) continue
        s.push(`<circle cx="${(cx0 + u * R).toFixed(1)}" cy="${(cy0 - v * R).toFixed(1)}" r="1.9" fill="#f2c14e" fill-opacity=".85"/>`)
      }
    }
    s.push(`<text x="${W / 2}" y="${H - 4}" text-anchor="middle" fill="var(--text-faint)" font-size="10">Butler 波束栅（sin 空间）· Δu = λ/Nd${(stN > 1 || stM > 1) ? '（抽样示意）' : ''}</text>`)
  }
  return open + s.join('') + '</svg>'
})
// 关闭页面所有绘制/编辑态（供进入波束合成放置/调整前清场）
function bsStopOtherModes() {
  mkEditStop(); polyEditStop(); polyMoveStop(); if (polyDrawId.value) polyCancel()
  if (activeTraj.value) endTraj()   // 结束航迹描绘（空航迹丢弃，退出绘制态）
}
// 反向：进入 Polygon/标记/航迹绘制态前，退出波束合成放置/调整（避免右键被波束放置抢走）。
function stopSynthPlacement() {
  if (bs.placing.value || bs.adjusting.value || bs.deleting.value) { bs.placing.value = false; bs.adjusting.value = false; bs.deleting.value = false; syncEdit() }
}
// 活动栏切到「波束合成」→ 载入卫星树（懒加载）+ 打开草图；离开 → 关草图（放置/调整态一并退出，数据保留）
watch(() => shellUi.side, async (side) => {
  if (side === 'beams') {
    await grd.loadIndex(false)   // 卫星下拉需要卫星树；不自动改动覆盖显示
    bs.openFor(grd.active.value ? grd.active.value.split('|')[0] : '')
  } else if (bs.open.value) { bs.close(); bsTableOpen.value = false }
  // 可见性分析：进入即打开（懒计算 + 画叠加层），离开即关闭（撤叠加层）。两态均经 commitGeometry 合并提交，
  // 聚焦星几何与可见性叠加层各自存续：进入可见性不再抹掉聚焦星，退出可见性聚焦星（若有）自动恢复。
  if (side === 'vis') { vis.openPanel(); commitGeometry() }
  else if (vis.open.value) { vis.close(); commitGeometry() }
  // 环境场：进入只支面板，图层画不画看总开关（缺省关，之后记住上次的选择——百万点栅格不该因为点进来看一眼就取）；
  // 离开只收面板不撤图层（气象/地形是底图性质的背景，切走还得看得见）
  if (side === 'env') env.openPanel()
  else if (env.open.value) env.close()
  // 实时气象：同上——进入只支面板，取数要花钱故必须用户点「取气象」，离开只收面板不撤图层
  if (side === 'envLive') envLive.openPanel()
  else if (envLive.open.value) envLive.close()
}, { immediate: true })
// 对星覆盖分析：进入即懒加载卫星树并按当前状态重绘（3D 壳层 + 2D 对地投影）。
// 3D 壳层与聚焦特效都是场景内容，离开不撤（要清空走面板的「清除绘图」）；但 2D 平面图只有一块场，
// 两个视图都往那儿画 → 离开时必须把它交还给对地视图，否则切回去平面图还留着对星那批层。
// ★ 盯 sideCtx 而非 shellUi.side：收起侧栏（side=''）不算离开——面板藏起来而已，2D 归属、指标表、
//   壳层挑选器一律留着；只有真切到别的视图才走交还那一支。
watch(() => sideCtx(), async (cur, prev) => {
  if (cur === 'satcov') { await grd.loadIndex(false); satcov.recompute(); commitGeometry() }
  else if (prev === 'satcov') {
    grd.recompute(); commitGeometry()          // 交还 2D 平面图
    satcovPickOpen.value = false
  }
}, { immediate: true })
// 「拖拽波束」是【对地覆盖分析 / 对星覆盖分析】这两个视图里的一个模态：开着的时候左键在图上拖的是
// 聚焦天线的指向，不是平移地图。带着它切到别的视图（Polygon / 标记 / 波束合成 / 地图设置…），
// 那边一拖就把指向拖歪了，而用户在那个上下文里根本不认为自己在改天线 —— 故离开这两个视图即关掉。
// ★ 同样盯 sideCtx 不盯 shellUi.side：收起侧栏只是把面板藏起来，模态该原样留着（与上一条同口径）。
//   对地 ↔ 对星互切也留着：那两个共用同一个聚焦天线与同一个开关（切【聚焦天线】才关，见 useGrdCoverage 的 watch(active)）。
const COV_SIDES = ['antenna', 'satcov']
watch(() => sideCtx(), (cur) => { if (!COV_SIDES.includes(cur) && grd.dragBore.value) grd.setDragBore(false) })
// 站点栅的编辑态（框选 / 加站 / 选区）属于波束合成这个视图：真离开它才退。收起侧栏时 side 为空、
// sideCtx 仍是 beams，bs.close() 只收面板不清选区（同上一条的口径）。
watch(() => sideCtx(), (cur, prev) => { if (prev === 'beams' && cur !== 'beams') bs.exitStEdit() })
// 「地图放置」开关：开启即清场并进入右键放置态（与调整互斥）
function bsPlaceToggle() {
  if (bs.placing.value) { bs.placing.value = false; return }
  bsStopOtherModes(); bs.adjusting.value = false; bs.deleting.value = false
  bs.placing.value = true
}
// 「调整中心」开关：开启即切平面图 + 清场 + 喂拖拽手柄（与放置互斥）
function bsAdjustToggle() {
  if (bs.adjusting.value) { bs.adjusting.value = false; syncEdit(); redrawSats(); return }
  if (!bs.beams.value.length) { appAlert('还没有波束可调整。'); return }
  bsStopOtherModes(); bs.placing.value = false; bs.deleting.value = false
  bs.adjusting.value = true
  if (!view.flat) view.flat = true   // 拖动在平面图进行
  syncEdit(); redrawSats()
}
// 「删除波束」开关：开启即切平面图 + 清场 + 喂手柄；点击命中的波束中心直接删除，可连续点删多个（与放置/调整互斥）
function bsDeleteToggle() {
  if (bs.deleting.value) { bs.deleting.value = false; syncEdit(); redrawSats(); return }
  if (!bs.beams.value.length) { appAlert('还没有波束可删除。'); return }
  bsStopOtherModes(); bs.placing.value = false; bs.adjusting.value = false
  bs.deleting.value = true
  if (!view.flat) view.flat = true   // 命中检测在平面图进行
  syncEdit(); redrawSats()
}
async function bsGenerate() {
  const key = await bs.generate()
  if (key) { bs.placing.value = false; bs.adjusting.value = false; bs.deleting.value = false; syncEdit(); redrawSats(); grd.recompute() }
}
// 导航器的卫星候选：卫星树里的真卫星（独立仰角线 kind 'elevline' 不是卫星，挂不了波束组）
const bsSats = computed(() => grdSats.value.filter((s) => s.kind !== 'elevline'))
// 导航器里【用户】换星 / 点组行 → 视图对准该星（focusTreeSat 由卫星树一侧定义）。
// 程序性的 openFor、自动同步、生成都不调 —— 镜头只跟用户的这两个动作走
function bsFocusSat(folder) {
  const n = bs.satNodeOf(folder)
  if (n && typeof focusTreeSat === 'function') focusTreeSat(n)
}
// 导航器卫星切换：定位该星首个波束组（或空态）
function bsSetSat(folder) { bs.setSat(folder); bsFocusSat(folder) }
function bsSelectGroup(g) { bs.selectGroup(g.id); bsFocusSat(g.satFolder) }
// 高斯组方向图参数面板 → 只收模型键（见 useBeamSynth.setStkModel）
function bsStkUpdate(m) { bs.setStkModel(m) }
// 新建波束组（多馈源 / 高斯 / 赋形 / 相控阵）
function bsAddGroup(m) {
  if (!bsSats.value.length) { appAlert('请先在覆盖分析视图添加卫星'); return }
  bs.addGroup(m)
}
// 删除波束组（直接删，不弹确认——confirm 会抢焦点；已生成的天线不受影响，仍在覆盖分析里可删）
function bsRemoveGroup(g) {
  bs.removeGroup(g.id)
}
// 波束设置改色（实时重绘草图）
function bsSetSettingColor(v) { const s = bs.curSetting.value; if (s) { s.color = v; redrawSats() } }
// 全部生成：当前卫星下每个组各出一根天线
async function bsGenerateAll() {
  const r = await bs.generateAll()
  if (r && r.ok) { bs.placing.value = false; bs.adjusting.value = false; bs.deleting.value = false; syncEdit(); redrawSats(); grd.recompute() }
}
// 生成后草图仍在，可继续微调再生成（同名更新）。切换模式/关面板时退出放置与调整态。
watch(() => bs.mode.value, () => { bs.placing.value = false; bs.exitStEdit(); if (bs.adjusting.value || bs.deleting.value) { bs.adjusting.value = false; bs.deleting.value = false; syncEdit() } redrawSats() })
watch(() => bs.open.value, (o) => { if (!o) { bs.placing.value = false; bs.adjusting.value = false; bs.deleting.value = false; syncEdit(); redrawSats() } })
// 放置态同步到两个渲染器：左键点击=落波束（拖动仍旋转/平移；右键放置并存）
watch(() => bs.placing.value, (v) => { if (scene) scene.setPlaceMode(v); if (flat) flat.setPlaceMode(v) })

// ---- 波束批量表格（Excel 网格，仿标记批量表格）：列 [经度, 纬度, 3dB-X, 3dB-Y, 旋转] ----
const BS_TBL_COLS = [
  { key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true },
  { key: 'thX', label: '3dB-X°', num: true }, { key: 'thY', label: '3dB-Y°', num: true }, { key: 'rot', label: '旋转°', num: true }
]
// 高斯组：只有经纬度可编辑；宽度列只读（= 设置模型 θ3），无旋转列
const BS_TBL_COLS_STK = BS_TBL_COLS.filter((c) => c.key !== 'rot').map((c) => (c.key === 'lon' || c.key === 'lat') ? c : { ...c, editable: false })
const bsTblCols = computed(() => (bs.mode.value === 'stk' ? BS_TBL_COLS_STK : BS_TBL_COLS))
// 高斯组宽度存的是不取整的 θ3，显示 / 复制取 4 位
const bsCellText = (r, c) => {
  const v = r[c.key]
  if (v == null) return ''
  if (bs.mode.value === 'stk' && (c.key === 'thX' || c.key === 'thY') && Number.isFinite(Number(v))) return String(+Number(v).toFixed(4))
  return String(v)
}
const bsGrid = useGridSelect({
  rows: () => bs.beams.value, cols: () => bsTblCols.value, cellText: bsCellText,
  onEdit: (id, key, val) => bs.tblUpdate(id, { [key]: val }),
  onPasteBlock: (a, k, t) => bs.tblPasteBlock(a, k, t),
  onPasteAppend: (t) => bs.tblPasteAppend(t),
  onClear: (cells) => cells.forEach(({ rowId, key }) => bs.tblUpdate(rowId, { [key]: (key === 'lon' || key === 'lat') ? '' : (key === 'rot' ? 0 : 1) })),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) bs.tblAddRow(at + k); return n },
  onDeleteRows: (ids) => { const s = new Set(ids); const before = bs.beams.value.length; bs.beams.value = bs.beams.value.filter((b) => !s.has(b.id)); return before - bs.beams.value.length },
  pushUndo: () => bs.pushUndo(), dropUndo: () => bs.dropUndo(), refresh: () => { redrawSats(); syncEdit() },
  undo: () => bs.undo(), redo: () => bs.redo()
})
function openBsTable() { bsTblWinInit(); bsTableOpen.value = true }
function bsTblWinInit() {
  if (bsTblWin.value.init) return
  const { w: vw, h: vh } = g3Size()
  const w = Math.min(560, vw - 48), h = Math.min(Math.round(vh * 0.5), vh - 48)
  bsTblWin.value = { x: Math.max(12, Math.round((vw - w) / 2)), y: Math.max(12, Math.round(vh * 0.2)), w, h, init: true }
}
function bsTblAddRow() {
  const ri = bsGrid.sel.value.ri, at = ri >= 0 ? ri + 1 : bs.beams.value.length
  bs.pushUndo(); bs.tblAddRow(at); redrawSats(); syncEdit()
  nextTick(() => { bsGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; bsGrid.focusGrid() })
}
async function bsTblPaste() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板'); return }
  bs.pushUndo()
  const n = bs.tblPasteAppend(text)
  if (n) { redrawSats(); syncEdit() } else { bs.dropUndo(); appAlert('剪贴板没有可识别的坐标（约定每行：经度 纬度 [宽X 宽Y 旋转]）') }
}
function bsTblClear() { if (!bs.beams.value.length) return; bs.pushUndo(); bs.beams.value = []; redrawSats(); syncEdit() }
function bsTblDelRow(id) { bs.pushUndo(); bs.beams.value = bs.beams.value.filter((b) => b.id !== id); redrawSats(); syncEdit() }
// 表尾「＋ 增加一行」：恒追加到末尾
function bsTblAddRowEnd() {
  const at = bs.beams.value.length
  bs.pushUndo(); bs.tblAddRow(at); redrawSats(); syncEdit()
  nextTick(() => { bsGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; bsGrid.focusGrid() })
}

// ---- 频率计划：波束信息列表（可多列复制到 Excel）----
// 每行 = 一个波束：整星连续编号 / 频率复用号(F#，未配色为空) / 经纬度 / 3dB 宽度 / 旋转。
// 显示紧凑（仿放置列表），复制按列展开为 TSV（带表头，粘进 Excel 自动分列）——同 copyPolyVerts 的「显示逗号、复制两列」思路。
const bsFreqRows = computed(() => bs.beams.value.map((b, i) => {
  const has = b.fc != null && b.fc >= 0
  return {
    id: b.id, no: bs.beamNumOffset.value + i + 1,
    fc: has ? b.fc + 1 : null, css: has ? bs.fcCss(b.fc) : null,
    lon: Number(b.lon), lat: Number(b.lat), thX: Number(b.thX), thY: Number(b.thY), rot: Number(b.rot) || 0
  }
}))
const bsFreqCopied = ref(false)
let bsFreqCopyTmr = null
function bsCopyFreqPlan() {
  const rows = bsFreqRows.value
  if (!rows.length) { appAlert('当前组还没有波束'); return }
  const fx = (v, n) => (Number.isFinite(v) ? v.toFixed(n) : '')
  const head = ['编号', '频率', '经度', '纬度', '3dB-X°', '3dB-Y°', '旋转°'].join('\t')
  const body = rows.map((r) => [r.no, r.fc != null ? 'F' + r.fc : '', fx(r.lon, 4), fx(r.lat, 4), fx(r.thX, 3), fx(r.thY, 3), fx(r.rot, 1)].join('\t')).join('\n')
  if (perfWriteClipboard(head + '\n' + body)) {
    bsFreqCopied.value = true
    if (bsFreqCopyTmr) clearTimeout(bsFreqCopyTmr)
    bsFreqCopyTmr = setTimeout(() => { bsFreqCopied.value = false }, 1600)
  } else appAlert('复制失败，请检查剪贴板权限')
}
// —— 相控阵赋形：星上激励指令表（测控上注 BFN）——
const bsPamExcitShown = computed(() => { const e = bs.pamExcit.value; return e && e.groupId === bs.activeGroupId.value ? e : null })
const bsPamExcitCopied = ref(false)
let bsPamExcitTmr = null
function bsPamExcitCopy() {
  const e = bsPamExcitShown.value
  if (!e || !e.rows.length) { appAlert('尚无激励指令：请先生成相控阵赋形天线'); return }
  const head = ['端口#', '指向经度', '指向纬度', '方位az°', '俯仰el°', '幅度dB(rel BFN)', '相位°', '功率占比%'].join('\t')
  const body = e.rows.map((r) => [r.port, r.lon, r.lat, r.az, r.el, r.ampDb, r.phaseDeg, r.powPct].join('\t')).join('\n')
  if (perfWriteClipboard(head + '\n' + body)) {
    bsPamExcitCopied.value = true
    if (bsPamExcitTmr) clearTimeout(bsPamExcitTmr)
    bsPamExcitTmr = setTimeout(() => { bsPamExcitCopied.value = false }, 1600)
  } else appAlert('复制失败，请检查剪贴板权限')
}
function bsExportPamExcit() {
  const csv = bs.pamExcitCsv()
  if (!csv) { appAlert('尚无激励指令：请先生成相控阵赋形天线'); return }
  const e = bsPamExcitShown.value
  const nm = (e && e.name ? e.name : '相控阵赋形').replace(/[\\/:*?"<>|]/g, '_')
  saveExport(csv, `星上激励指令_${nm}.csv`, [{ name: 'CSV（Excel 可打开）', extensions: ['csv'] }])
}
function bsTblDragMove(e) {
  if (e.button !== 0 || (e.target.closest && e.target.closest('.csx, .ptb, input, select, label'))) return
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, o = { ...bsTblWin.value }
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    const x = Math.max(-o.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx)))
    const y = Math.max(0, Math.min(vh - 32, o.y + (ev.clientY - sy)))
    bsTblWin.value = { ...bsTblWin.value, x, y }
  })
}
function bsTblDragResize(e, dir = 'se') {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, o = { ...bsTblWin.value }, minW = 360, minH = 240
  const E = dir.includes('e'), Wd = dir.includes('w'), S = dir.includes('s'), N = dir.includes('n')
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    let x = o.x, y = o.y, w = o.w, h = o.h
    const dx = ev.clientX - sx, dy = ev.clientY - sy
    if (E) w = Math.max(minW, Math.min(o.w + dx, vw - o.x - 6))
    if (S) h = Math.max(minH, Math.min(o.h + dy, vh - o.y - 6))
    if (Wd) { const right = o.x + o.w; x = Math.max(6, Math.min(o.x + dx, right - minW)); w = right - x }
    if (N) { const bottom = o.y + o.h; y = Math.max(0, Math.min(o.y + dy, bottom - minH)); h = bottom - y }
    bsTblWin.value = { ...bsTblWin.value, x, y, w, h }
  })
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

// 波束名 / 电平名的内联重命名（草稿缓冲防实时重渲染吞字）随「天线设置」一并搬进 GrdSetSections.vue。

// 仰角线显示开关（仰角值/颜色在卫星「✎」弹窗里编辑）
function toggleSatElev(node) { node.elevShow = !node.elevShow; redrawSats() }
// 小眼睛状态独立于「卫星设置」里的显示图标/显示卫星名两个开关：只要有一个开着就算亮着，两个都关了才算灭
const satVisible = (node) => node.iconShow !== false || node.labelShow !== false
// 一键同时隐藏/恢复图标+名称（各自的独立开关在「卫星设置」里）；卫星名开关也影响 3D 覆盖连线(卫星↔波束中心)，需重绘覆盖层。
// 对星覆盖分析里这个开关还兼「聚焦特效」的总闸（见 computeSatcovFocusGeometry），故在该视图另走一次壳层重算 + 几何提交。
function toggleSatLabel(node) {
  const next = !satVisible(node); node.labelShow = next; node.iconShow = next
  redrawSats()
  if (grdOpen.value) grd.recompute()
  satcov.scheduleRecompute(); commitGeometry()   // 无条件：壳层没画过时 scheduleRecompute 内部 _painted 闸自会早退
}
// 是否有显示中且位置随时间变化的卫星（星座关联星 / 轨道根数模拟星）：其仰角线/卫星名需随时间刷新位置
const hasLinkedElev = () => grdSats.value.some((s) => (s.noradId || s.elements) && (s.elevShow || satVisible(s)))
// 随 GRD「清除绘图」一并隐藏所有仰角线与卫星名（保留各星配置，再点亮即重绘）
function grdClearDrawing() {
  grd.clearDrawing()
  for (const s of grdSats.value) { s.elevShow = false; s.labelShow = false; s.iconShow = false }
  redrawSats()
}
// 添加/编辑卫星弹窗（null=关闭）+ 从星座点选/搜索状态
const satModal = ref(null)
// 独立仰角线弹窗（null=关闭）：与卫星弹窗脱钩，只有位置 + 仰角线参数，没有图标/卫星名/星座关联
const elevModal = ref(null)
const satPick = ref(false)
const satSearchKw = ref('')
const satSearchRes = ref([])
const liveTick = ref(0)   // 每次 refreshPositions 自增：驱动关联星编辑弹窗的经纬度/高度随星历实时刷新

// 编辑弹窗里展示的位置：关联星按星历实时解算（随 liveTick / 时间轴更新），否则取草稿手动输入值
const satModalPos = computed(() => {
  const m = satModal.value
  if (!m) return { lon: 0, lat: 0, altKm: 0 }
  if (m.noradId) {
    liveTick.value   // 触发依赖：实时/时间轴每秒自增
    const p = satLivePos({ noradId: m.noradId })   // 解不出 → null
    if (p && Number.isFinite(p.lon)) return { lon: +p.lon.toFixed(3), lat: +p.lat.toFixed(3), altKm: +p.altKm.toFixed(1) }
    // 此刻解不出（星历里没有 / 越出时段 / 池还没就绪）：三格留空 —— 不拿存储值冒充活位置（地图 / 覆盖此刻都当它没有星位）。
    // 只影响显示：提交（satPatchFrom）照旧读 m.lon/lat/altKm
    return { lon: '', lat: '', altKm: '' }
  }
  return { lon: m.lon, lat: m.lat, altKm: m.altKm }
})
// 位置三格（经度/纬度/轨道高度）就地编辑：正在输入的那一格用本地草稿顶住。
// 早先是 :value="satModalPos.x" + @input 直接 Number(...) 写回，两处会跳变：
//   ① 只打一个「-」（西经 / 南纬）时 <input type=number> 的 value 是【空串】（负号还在框里，但取不到），
//      Number('') = 0 写回状态 → 本组件重渲染 → Vue 对 value 无条件回写，把框改成「0」，负号没了；
//      接着打 45 就成了 +45 —— 西经打成东经，还不报错（实测：输 −45 得 +45）。
//   ② 本组件模板里有秒级时间读数（timeParts ← clock.tMs），实时/播放时【每秒重渲染一次】，
//      任何与状态不一字不差的中间输入（清空、前导 0）都会在下一秒被改写。
// 草稿：框里显示用户打的原文，半截/非法的不写状态，离开焦点即回落到已提交值。
const satPosEdit = ref(null)          // { k, text }：只存正在编辑的那一格
function satPosVal(k) { const d = satPosEdit.value; return d && d.k === k ? d.text : satModalPos.value[k] }
function satPosInput(k, e) {
  satPosEdit.value = { k, text: e.target.value }
  const v = Number(e.target.value)
  if (e.target.value !== '' && Number.isFinite(v) && satModal.value) satModal.value[k] = v
}
// 回车 / 失焦＝提交，当场生效。只在真打过字（有草稿）时提交：否则光是把焦点扫过经度框，
// 「添加卫星」那条就会凭空把星建出来。
function satPosDone() { const typed = !!satPosEdit.value; satPosEdit.value = null; if (typed) applySatLive() }
watch(satModal, () => { satPosEdit.value = null })   // 换一颗星/开关弹窗：草稿作废，免得串到下一格

const defaultElements = () => ({ altKm: 500, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0 })
function defaultSatDraft() {
  return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, color: '#ffffff', els: '5,10', noradId: null, posMode: 'fixed', elements: defaultElements(), elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, iconShow: true, labelShow: true, labelBold: false, elevLabelBold: false }
}
// hideViz：从文件管理器调起时为 true，隐藏可视化项（图标/字号/仰角线/颜色），其余功能（定位方式/星座关联）一致
function openAddSat(hideViz = false) { satModal.value = { ...defaultSatDraft(), hideViz }; satLiveSig = satPosSig(satModal.value); satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
// 编辑已有卫星（含预置星）：名称/位置/关联/仰角线/图标与标签大小都可改
function editSat(node, hideViz = false) {
  satModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, color: node.elevColor, els: node.els, noradId: node.noradId, kind: node.kind, posMode: node.elements ? 'orbit' : 'fixed', elements: node.elements ? { ...node.elements } : defaultElements(), elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18, iconSize: node.iconSize || 10, labelSize: node.labelSize || 4, iconShow: node.iconShow !== false, labelShow: node.labelShow !== false, labelBold: !!node.labelBold, elevLabelBold: !!node.elevLabelBold, hideViz }
  satLiveSig = satPosSig(satModal.value)
  satPick.value = false; satSearchKw.value = ''; satSearchRes.value = []
}
// 关窗＝就此打住。还压着一帧没提交的改动（刚松开滑块就点了 ×）就先补提交，别丢
function closeSatModal() { if (satLiveRaf) { cancelAnimationFrame(satLiveRaf); satLiveRaf = 0; commitSatLive() } satModal.value = null; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
function applyGeoAlt() { if (!satModal.value) return; satModal.value.altKm = GEO_ALT; satPosEdit.value = null; applySatLive() }   // 一键GEO：轨道高度设为 GEO

// ===== 改一处落一处：这个弹窗没有「保存 / 取消」=====
// 数值 / 文本框回车或失焦即提交、滑块随拖动走、勾选与取色当场生效，对着地图看结果；「×」只是关窗。
// 新建星在第一次提交时才建出来（此后与编辑同路），故「添加卫星」开了不动、直接关，不会留下东西。
let satLiveSig = ''         // 上次落库时的位置输入签名，见 satPosSig
let satLiveRaf = 0          // 每帧至多提交一次：滑块拖动期间不逐事件重画、不逐事件写 localStorage

// 位置输入签名：只取【用户能改的那一路】——关联星看 noradId、模拟星看根数、固定星看经纬高。
// 拖字号滑块时签名不变 → 补丁里就不带位置字段，天线覆盖与壳层都不必重算（关联星/模拟星的实时星历
// 每帧都不一样，位置字段一旦进补丁，updateSatellite 必然判成「星挪了」而逐帧重投影）。
const satPosSig = (m) => JSON.stringify(m.noradId ? ['linked', String(m.noradId)] : m.posMode === 'orbit' ? ['orbit', m.elements] : ['fixed', m.lon, m.lat, m.altKm])
// 显示项补丁（名称 / 仰角线样式 / 图标与卫星名），不含位置
function satViewPatch(m) {
  return { satName: (m.name || '卫星').trim() || '卫星', els: m.els || '', elevColor: m.color || '#66ddff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18, iconSize: Number(m.iconSize) || 10, labelSize: Number(m.labelSize) || 4, iconShow: m.iconShow !== false, labelShow: m.labelShow !== false, labelBold: !!m.labelBold, elevLabelBold: !!m.elevLabelBold }
}
// 由草稿构造整份补丁（位置 + 显示项）。alert=true 时非法输入弹框（「保存」走这条）；
// alert=false 静默返回 null（实时预览走这条，半截输入不打断）。
function satPatchFrom(m, alert) {
  let lon = Number(m.lon), lat = Number(m.lat), altKm = Number(m.altKm)
  // 关联星：取当前星历解算的位置作为存储回退值（无星座时按此投影），而非草稿里的陈旧值
  if (m.noradId) { const p = satLivePos({ noradId: m.noradId }); if (p && Number.isFinite(p.lon)) { lon = p.lon; lat = p.lat; altKm = p.altKm } }
  // 轨道根数模拟星：校验根数 → 试建 satrec → 取当前星下点作为静态回退位置（lon/lat/altKm）
  const orbit = !m.noradId && m.posMode === 'orbit'
  let elements = null
  if (orbit) {
    const el = m.elements || {}
    const alt = Number(el.altKm), ecc = Number(el.ecc), incl = Number(el.incl)
    if (!(alt > 0) || !(ecc >= 0 && ecc < 1) || !(incl >= 0 && incl <= 180)) { if (alert) appAlert('轨道根数非法：需 轨道高度>0、0≤偏心率<1、0≤倾角≤180'); return null }
    elements = { altKm: alt, ecc, incl, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0 }
    let rec; try { rec = elementsToSatrec(elements) } catch { rec = null }
    if (!rec || rec.error) { if (alert) appAlert('该组根数无法构造有效轨道（可能已衰减或超界），请调整'); return null }
    const now = calcAt(); const pv = posAt(rec, now)
    if (!pv || !pv.position) { if (alert) appAlert('轨道传播失败，请检查根数'); return null }
    const gd = sat.eciToGeodetic(pv.position, sat.gstime(now))
    lon = sat.degreesLong(gd.longitude); lat = sat.degreesLat(gd.latitude); altKm = gd.height
  }
  if (!validLon(lon) || !validLat(lat) || !(altKm > 0)) return null   // 非法输入不保存
  // 所有星（含预置）都可改名称/位置/关联/仰角线。预置星 kind 保持 'preset'（仍属平台数据、不在树里删）；
  // 自定义/星座/模拟星按定位方式切换 custom/linked/orbit。是否随时间跟踪由 noradId / elements 决定，与 kind 无关。
  const patch = { ...satViewPatch(m), lon, lat, altKm, noradId: m.noradId || null, elements: orbit ? elements : null }
  if (m.kind !== 'preset') patch.kind = m.noradId ? 'linked' : (orbit ? 'orbit' : 'custom')
  return patch
}
function applySatLive() {
  if (!satModal.value || satLiveRaf) return
  satLiveRaf = requestAnimationFrame(() => { satLiveRaf = 0; commitSatLive() })
}
function commitSatLive() {
  const m = satModal.value; if (!m) return
  // 新建星：第一次提交就把它建出来，之后 m.folder 有了，与编辑走同一条
  if (!m.folder) {
    const patch = satPatchFrom(m, true); if (!patch) return
    const created = grd.addSatellite({ name: m.name, lon: patch.lon, lat: patch.lat, altKm: patch.altKm, noradId: m.noradId, elements: patch.elements, els: m.els, color: m.color, elevWidth: m.elevWidth, elevLabelSize: m.elevLabelSize, iconSize: m.iconSize, labelSize: m.labelSize, iconShow: m.iconShow, labelShow: m.labelShow, labelBold: m.labelBold, elevLabelBold: m.elevLabelBold })
    if (!created) return
    m.folder = created.folder; m.kind = created.kind; satLiveSig = satPosSig(m)
    afterSatEdit(); return
  }
  const n = grdSats.value.find((x) => x.folder === m.folder)
  const moved = satPosSig(m) !== satLiveSig
  const patch = moved ? satPatchFrom(m, false) : satViewPatch(m)
  if (!patch) return   // 半截 / 非法输入：静默不落，等下一次提交
  // 图标 / 卫星名的显隐同 toggleSatLabel：卫星名开关还管 3D 覆盖连线(卫星↔波束中心)，对星覆盖里又兼「聚焦特效」总闸
  const visChanged = !n || patch.iconShow !== (n.iconShow !== false) || patch.labelShow !== (n.labelShow !== false)
  if (moved) satLiveSig = satPosSig(m)
  grd.updateSatellite(m.folder, patch)
  if (visChanged && grdOpen.value) grd.recompute()
  if (moved || visChanged) afterSatEdit(); else redrawSats()
}
// 一次编辑落库之后：改星位＝天线基底变了，对星覆盖的壳层投影与聚焦特效都得跟着重算（对地那条由
// updateSatellite 内的 reprojectSat 兜住；壳层是另一条通道，不重算就停在旧星位上）。同 toggleSatLabel：
// 不按视图门控，没画过由 _painted 闸早退
function afterSatEdit() { redrawSats(); satcov.scheduleRecompute(); commitGeometry() }

function removeSat(node) { grd.removeSatellite(node.folder); redrawSats() }

// ===================== 卫星 / 天线树 ↔ 星座 双向联动 =====================
// 身份：树按 folder、星座按 String(NORAD)，从不按星名或对象身份（纯逻辑见 viz/grd/treeLink.js）。
// 定位一律瞬时正对（selectSat(e,true) → faceEntry → scene.faceTo / scene.faceLonLat），不做镜头飞行（09-15 已回退）。
// 方向：树 → 星座只在用户动作里发生（点天线行 / 双击星名 / 新建天线）；星座 → 树只做派生显示（高亮 / 展开 / 滚动 /
//   波束合成跟随）。后者的 watcher 里绝不调 grd.setActive / selectSat —— 一次点选来回各走一趟就停，不会互相踢皮球。

// 树 → 星座：聚焦一颗树节点卫星。
//   关联星 → 按号解析条目（在场优先，同一批点云对象）→ 选中 + 瞬时正对 + 弹信息卡；池没就绪且没解到 → 等全量目录建好再试一次。
//     已在选中集里（按号）→ 只设为主选并正对，不冲掉用户的多选。
//   天线树定点同步星 → 同上，号是它的合成号（satEntryById 直接取到 treeGeo 条目，不用等池）。
//   其余（非同步定点星 / 轨道根数星）→ 星座里没有它，只把地球转到它此刻的星下点。
//   force=false（天线行点击顺带的）时看小眼睛：眼睛灭着＝这颗星不接到视图上，不动；双击星名 / 显式动作传 force。
// tick / fseq：调用方自己先等过一段（createGaussFor 等星历源 + 建天线）时，在它开始等之前捕获的 _userSelTick / _focusSeq ——
//   等的那几秒里用户另选了星 / 树上又点了别的 → 这次聚焦作废（判据见 treeLink.focusStale）。即时调用不传。
// additive：卫星行「聚焦」钮 Ctrl / Cmd / Shift 点 —— 同地图上 Ctrl 点：不在聚焦集里＝加入、设为主选并正对；已在＝移出。
// ★ 名字与签名给波束合成面板用（agent C），别改（只在选项对象里追加可选项）。
async function focusTreeSat(node, { force = false, tick = null, fseq = null, additive = false } = {}) {
  if (!node || node.kind === 'elevline') return
  if (!force && !satVisible(node)) return
  if (focusStale({ tick, fseq }, _userSelTick, _focusSeq)) return
  const seq = ++_focusSeq
  const id = nodeLinkId(node, treeGeoIdMap.value)   // 关联星的号 / 定点同步星的合成号；'' = 星座里没有它
  if (id) {
    const find = () => satEntryById('n:' + id) || liveEntryOf(id)
    let e = find()
    if (!e && !poolReady && apiOk) {
      const tick0 = _userSelTick
      await ensureSearchPool()
      // 等池那几秒里用户又点了别的树节点 / 在地球或搜索里另选了星：这一次作废，别把较新的选中冲掉、把地球转回去
      if (focusStale({ tick: tick0, fseq: seq }, _userSelTick, _focusSeq)) return
      e = find()
    }
    if (!e) { status.value = `关联卫星 NORAD ${id} 不在当前星历中`; return }
    const had = selEntries.find((x) => String(x.noradId) === id)
    if (additive) { selectSat(had || e, !had, true); _treeSelVer = selVer.value; return }   // 按号认已选的那一份，移出不正对
    if (had) {                                           // 已选中（可能是另一份同号对象）：设主选 + 正对，选中集不动
      if (had !== selEntry) { selEntry = had; refreshSelection(); saveSelection(); _treeSelVer = selVer.value }
      if (force) stopFollow()                            // 正跟随着它：显式聚焦＝退回球面再正对（跟随中 scene 不接 faceTo）
      if (scene) faceEntry(had)
      return
    }
    selectSat(e, true)
    _treeSelVer = selVer.value                           // 这一版选中集是树上点出来的：回显 watcher 不再去滚树（用户正看着那一行）
    return
  }
  if (force) stopFollow()   // 同上：跟随中 scene 不接 faceLonLat
  const p = satLivePos(node)
  if (p && scene) scene.faceLonLat(p.lon, p.lat)
}
// 对地树天线行：设为编辑对象（不转到导入时烘的旧峰值点）→ 再按卫星此刻位置聚焦
async function onTreeAntClick(sat, a) {
  await grd.setActive(sat, a, { face: false })
  focusTreeSat(sat)
}
// 树 → 星座：跟随一颗关联星 / 定点同步星（卫星行「跟随」钮）。startFollow 是追加式：并入聚焦集、设为主选，不冲掉用户的多选；
// 已在选中集里按号认那一份（别再并进一份同号对象）。正在跟随它 → 退出。星座里没有它的星 / 平面图不进来（钮置灰）。
async function followTreeSat(node) {
  const id = nodeLinkId(node, treeGeoIdMap.value)
  if (!id || flatView.value) return
  if (followLinkId.value === id) { stopFollow(); return }
  const tick0 = _userSelTick, seq = ++_focusSeq
  const find = () => selEntries.find((x) => String(x.noradId) === id) || satEntryById('n:' + id) || liveEntryOf(id)
  let e = find()
  if (!e && !poolReady && apiOk) {
    await ensureSearchPool()
    if (focusStale({ tick: tick0, fseq: seq }, _userSelTick, _focusSeq) || flatView.value) return   // 等池期间另选了星 / 切了平面图：作废
    e = find()
  }
  if (!e) { status.value = `关联卫星 NORAD ${id} 不在当前星历中`; return }
  startFollow(e)
  _treeSelVer = selVer.value
  if (!following.value) status.value = '关联卫星当前无星历'   // followPrep 此刻解不出星位
}
// 正在跟随的星的联动身份（NORAD 串，'' = 没在跟随）：两棵树「跟随」钮据此点亮。followEntry 与 following 同进同出
const followLinkId = computed(() => (following.value ? linkIdOf(followEntry) : ''))
// 两棵树卫星行「聚焦 / 跟随」两钮的状态（点亮 / 置灰 / 悬停说明，口径见 treeLink.treeNavState），按 folder 查
const treeNavMap = computed(() => {
  const cur = selFolderSet.value, miss = linkMissSet.value, followId = followLinkId.value, flat = flatView.value, geo = treeGeoIdMap.value
  const m = new Map()
  for (const n of grdSats.value) if (n && n.kind !== 'elevline') m.set(n.folder, treeNavState(n, { cur: cur.has(n.folder), miss: miss.has(n.folder), followId, flat, linkId: nodeLinkId(n, geo) }))
  return m
})
const treeNav = (n) => treeNavMap.value.get(n.folder) || treeNavState(n)
function onTreeFocusBtn(n, ev) { if (!treeNav(n).focusDis) focusTreeSat(n, { force: true, additive: !!(ev && (ev.ctrlKey || ev.metaKey || ev.shiftKey)) }) }
function onTreeFollowBtn(n) { if (!treeNav(n).followDis) followTreeSat(n) }

// 在某颗树节点卫星下新建一根解析高斯天线（STK Gaussian 出厂参数，单波束天底），落到编辑视图并聚焦该星。
// 星位取此刻活位置（记录里只作记录，取值只看波束）；关联星此刻解不出 → 拒建。返回新天线 key（失败 null）。
// guard：收尾那次聚焦的过期判据 { tick, fseq }（见 focusTreeSat）。调用方自己先等过（ensureLinkedFolder）就传它等之前捕获的那份；
//   不传则在这里进门时捕获 —— 下面等星历源 / 建天线那几秒里用户另选了星，天线照建，但不再把选中与地球拽回这颗星。
async function createGaussFor(node, guard) {
  if (!node || node.kind === 'elevline') return null
  const g = guard || { tick: _userSelTick, fseq: _focusSeq }
  let pos = satLivePos(node)
  if (!pos && node.noradId) { await awaitLinkEph(); pos = satLivePos(node) }   // 挂载后几秒星历源还在建：等它一下再判（同 focusTreeSat）
  if (!pos) { status.value = '关联卫星当前无星历'; return null }
  let key = null
  try {
    const record = anBuildRecord({
      sat: { name: node.satName, lon: pos.lon, lat: pos.lat, altKm: pos.altKm },
      models: [{ id: 'm1', name: '', ...anFreshModel() }],
      beams: [{ name: '', az: 0, el: 0, model: 'm1' }]
    })
    key = await grd.createAnalyticAntenna(node.folder, { name: byLang('高斯天线', 'Gaussian Antenna'), record, settings: { ctype: 'rel', levels: [-3] } })
  } catch (e) { status.value = (e && e.message) || String(e); return null }
  if (!key) return null
  // 对星视图的「画哪些」另存一份：在那边建的就顺手画到壳层上（同 sc.importGrd）
  if (shellUi.side === 'satcov' && !satcov.selected.value.includes(key)) satcov.selected.value = [...satcov.selected.value, key]
  if (shellUi.side !== 'antenna' && shellUi.side !== 'satcov') shellUi.side = 'antenna'
  redrawSats()
  focusTreeSat(node, { tick: g.tick, fseq: g.fseq })
  revealTreeFolder(node.folder)
  return key
}

// 星座条目 → 关联着它的树节点（同号多 folder 取树序第一个）；没有就照「添加卫星」弹窗新建关联星那一条（commitSatLive 新建分支）
// 建一颗：号 + 星名 + 此刻星历位置（只作存储回退值）+ 图标与名称显示，其余同弹窗默认草稿。
// 返回 { node, fresh }（fresh = 本次新建：调用方的动作没落成就用 dropFreshLinked 撤掉）；拒建返回 null。
// ★ 拒建一律判在新建之前（grd.addSatellite 当场落盘）：向导预览星（号段 PREVIEW_BASE+i，提交后换号）/ 号在星历里解不出 /
//   此刻解不出星位（点序列越出采样时段）—— 否则落一颗永远「缺失」的死节点，存的回退星位还是草稿的 0°/0°/GEO。
async function ensureLinkedFolder(en) {
  if (!en || en.noradId == null || en.noradId === '') return null
  const id = String(en.noradId)
  if (en.group === PREVIEW_GROUP) { status.value = `关联卫星 NORAD ${id} 不在当前星历中`; return null }
  if (grdApiOk) await grd.loadIndex(false)          // 树没载过：先载，免得新节点被随后的索引载入冲掉
  const hit = linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0]
  if (hit) return { node: hit, fresh: false }
  if (!liveEntryOf(id)) await awaitLinkEph()        // 挂载后几秒星历源还在建：等它一下再判（同 createGaussFor）
  if (!liveEntryOf(id)) { status.value = `关联卫星 NORAD ${id} 不在当前星历中`; return null }
  const pos = satLivePos({ noradId: id })
  if (!pos || !(pos.altKm > 0)) { status.value = '关联卫星当前无星历'; return null }   // 高度校验同 satPatchFrom
  const again = linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)[0] // 等星历那会儿别处可能已经建了一颗
  if (again) return { node: again, fresh: false }
  const m = { ...defaultSatDraft(), name: en.name || '', noradId: id }
  const created = grd.addSatellite({ name: m.name, lon: pos.lon, lat: pos.lat, altKm: pos.altKm, noradId: id, elements: null, els: m.els, color: m.color, elevWidth: m.elevWidth, elevLabelSize: m.elevLabelSize, iconSize: m.iconSize, labelSize: m.labelSize, iconShow: true, labelShow: true, labelBold: m.labelBold, elevLabelBold: m.elevLabelBold })
  if (!created) return null
  afterSatEdit()
  return { node: created, fresh: true }
}
// ensureLinkedFolder 为某个动作新建的关联星，动作没落成（取消文件框 / 建天线失败）→ 撤掉，别留一颗空星在树上和地图上。
// 按 folder 重取节点（不认对象身份）；期间已挂上天线的不动。返回是否撤了。
function dropFreshLinked(folder) {
  const n = grdNodeOf(folder)
  if (!n || n.antennas.length) return false
  removeSat(n)
  return true
}

// ---- 天线树定点同步星 → 星座条目（viz/grd/treeGeo.js）----
// 树一变（增删星 / 改经纬度·高度·名字 / 关联上星座 / 小眼睛）就按树重建条目表，渲染集跟着重建（显隐跟小眼睛）。
// 条目对象跨重建复用（就地换 name / rec）：选中集、跟随、聚焦几何 Worker 手里那一份不用重绑。
// 掉了的条目（节点删了 / 改成非同步高度 / 关联上了真星）若还在选中集里 → 移出（正跟随它 → 先退出跟随）；
// 仍在集里的某颗换了合成号（号段撞号顺延，极少）→ 补发一次联动信号，树上高亮 / 信息卡天线节跟上。
const _sameIds = (a, b) => { if (a.size !== b.size) return false; for (const [k, v] of a) if (b.get(k) !== v) return false; return true }
function syncTreeGeo() {
  const idsBefore = selEntries.filter((e) => e._grdFolder).map((e) => String(e.noradId)).join()
  const { list, byId, ids, gone } = syncTreeGeoEntries(grdSats.value, treeGeoCache)
  treeGeoList = list; treeGeoById = byId
  if (!_sameIds(treeGeoIdMap.value, ids)) treeGeoIdMap.value = ids
  const lost = new Set(gone)
  if (lost.size && selEntries.some((e) => lost.has(e))) {
    if (followEntry && lost.has(followEntry)) stopFollow()
    selEntries = selEntries.filter((e) => !lost.has(e))
    if (selEntry && lost.has(selEntry)) selEntry = selEntries[selEntries.length - 1] || null
    if (!selEntry) closeCard(); else { refreshSelection(); saveSelection() }
  } else if (idsBefore !== selEntries.filter((e) => e._grdFolder).map((e) => String(e.noradId)).join()) bumpSelSignal()
  rebuildRenderSet()
}
watch(() => grdSats.value.map((n) => (n && n.kind !== 'elevline' && !n.noradId && !n.elements ? `${n.folder}|${n.satName}|${n.lon}|${n.lat}|${n.altKm}|${satVisible(n) ? 1 : 0}` : '')).join('\n'), syncTreeGeo, { immediate: true })

// ---- 星座 → 树：派生显示 ----
// 渲染集版本：rebuildRenderSet 换了 entries（导入组显隐 / 自定义星座增删）时自增，「关联星缺失」据此重判
const entSetVer = ref(0)
// 选中集里的星关联着哪些 folder（一对多、号的字符串 / 数字混存都认）：两棵树的卫星行据此打 cur
const selFolderSet = computed(() => foldersForNorads(grdSats.value, selNoradList.value, treeGeoIdMap.value))
// 关联星在当前星历里找不到（全量目录就绪后才判）：卫星行挂一枚告警
const linkMissSet = computed(() => {
  void poolTick.value; void entSetVer.value
  const out = new Set()
  if (!poolReady) return out
  for (const n of grdSats.value) if (treeLinkMissing(n, true, liveEntryOf)) out.add(n.folder)
  return out
})
// 关联着点序列导入星（.e / OEM / SP3）的树节点：该组采样表不论图层显隐都载入（进 ephAll，liveEntryOf 那一路）——
// 图层关着（或存档里就是关着的）也不断联动。可见的组归卫星集那套加载（ensureImportEntries 载完自己重建渲染集），这里只补隐藏的。
// 树里改了关联 / 导入组清单换了 → 补载缺的那几组，载完补一拍全场（relinkTick）。
let _linkEphP = null
function ensureLinkedEphTables() {
  const ids = ephGroupsToLoad(importGroups.value, grdSats.value, (id) => ephTables.has(id) || satSets.isVisible('i:' + id))
  if (!ids.length) return _linkEphP || Promise.resolve()
  const p = Promise.all(ids.map((id) => ephemEntriesOf(id))).then(() => { entSetVer.value++; relinkTick() })
    .catch(() => {}).finally(() => { if (_linkEphP === p) _linkEphP = null })
  _linkEphP = p
  return p
}
watch([() => grdSats.value.map((n) => (n && n.kind !== 'elevline' && n.noradId != null ? String(n.noradId) : '')).join(','), importGroups], () => { ensureLinkedEphTables() })
// 关联星此刻解不出、可能只是星历源还没就绪（挂载后几秒全量目录在建 / 隐藏点序列组的表在载）：等它们一下再判。
// 新建高斯天线（createGaussFor）与 GRD 导入（grd.setEphReady → importGrd / createAnalyticAntenna）共用。
async function awaitLinkEph() {
  if (!poolReady && apiOk) await ensureSearchPool()
  if (_linkEphP) await _linkEphP
  if (ephPending.size) await Promise.all([...ephPending.values()].map((j) => j.p))   // 可见点序列组的表也还在载（ensureImportEntries）
}
// 把某个 folder 的卫星行滚进视野（两棵树都在 #side-view 里；另一棵是 v-show 藏着的 → 只认看得见的那一行）
function revealTreeFolder(folder, tries = 3) {
  if (!folder) return
  if (!grd.isExpanded(folder)) grd.expanded.value = { ...grd.expanded.value, [folder]: true }
  nextTick(() => {
    const root = document.getElementById('side-view') || document
    const row = [...root.querySelectorAll('.gsat[data-folder]')].find((el) => el.dataset.folder === folder && el.offsetParent !== null)
    if (row) row.scrollIntoView({ block: 'nearest' })
    else if (tries > 1) requestAnimationFrame(() => revealTreeFolder(folder, tries - 1))   // 视图刚切过来、树还没渲染出来
  })
}
let _treeSelVer = -1   // 由树上动作（focusTreeSat）产生的那一版 selVer
const bsFollowGate = createFollowGate()   // 波束合成跟随的放行闸：每一版 selVer 都喂（含别的视图），见 treeLink.createFollowGate
watch(selVer, (v) => {
  const side = shellUi.side
  const set = selFolderSet.value
  const followOk = bsFollowGate(selPrimNorad.value, { system: v === _selSysVer, picked: v === _primPickVer })
  // 树上点出来的选中：那一行用户正看着，别展开 / 滚动（点第 20 根天线时把卫星行滚上来，被点的那行反而滚出视野）
  if ((side === 'antenna' || side === 'satcov') && set.size && v !== _treeSelVer) {
    const add = {}
    let need = false
    for (const f of set) if (!grd.isExpanded(f)) { add[f] = true; need = true }
    if (need) grd.expanded.value = { ...grd.expanded.value, ...add }
    const first = grdSats.value.find((n) => set.has(n.folder))
    if (first) revealTreeFolder(first.folder)
  }
  // 波束合成视图跟随主选：【用户】换了 / 点名了主选（程序性刷新不算：启动恢复选中、星座重绑、向导预览）、主选星关联了 folder、
  // 导航器当前那颗不是同一颗、且没在放置 / 调整 / 删除 / 站点编辑 → 换过去
  if (followOk && side === 'beams' && bs.open.value && !bs.placing.value && !bs.adjusting.value && !bs.deleting.value && !bs.stEditOn.value && !bs.stPick.value) {
    const f = treeFollowFolder(grdSats.value, selPrimNorad.value, bs.satFolder.value, treeGeoIdMap.value)
    if (f) bs.setSat(f)
  }
})

// ---- 「＋」天线菜单（两棵树的卫星行 / 信息卡「天线」节）----
// 状态里只存身份（folder / NORAD 串），不存条目或节点对象：深响应 ref 读出来是 Proxy
const antAddMenu = ref(null)     // { x, y, right, src:'tree'|'card', folder, norad }
const antMenuEl = ref(null)      // 信息栏那一份菜单（src==='card'）的 DOM：按实测尺寸再夹一次
function openAntAddMenu(ev, src, payload) {
  const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : { left: 0, right: 0, bottom: 0, top: 0 }
  const w = 160, h = src === 'card' ? 88 : 64
  const x = Math.max(6, Math.min(src === 'card' ? r.right - w : r.left, window.innerWidth - w - 6))
  const y = r.bottom + 2 + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 2) : r.bottom + 2
  antAddMenu.value = { x, y, right: r.right, src, folder: (payload && payload.folder) || '', norad: (payload && payload.norad) || '' }
  if (src !== 'card') return
  nextTick(() => {   // 信息栏的「＋」贴窗口右缘，英文下菜单又比写死的 160 宽：按实际渲染尺寸右对齐按钮、夹进窗口
    const el = antMenuEl.value, m = antAddMenu.value
    if (!el || !m || m.src !== 'card') return
    const b = el.getBoundingClientRect()
    const nx = Math.max(6, Math.min(m.right - b.width, window.innerWidth - b.width - 6))
    const ny = Math.max(8, Math.min(m.y, window.innerHeight - b.height - 8))
    if (nx !== m.x || ny !== m.y) antAddMenu.value = { ...m, x: nx, y: ny }
  })
}
// Esc 关「＋」菜单（同 onExpEsc）：捕获阶段先拿到并截住 —— 一次 Esc 只关最上一层，跟随中也不会顺带退出跟随；输入法组字中的 Esc 归输入法
function onAntAddEsc(e) { if (e.key === 'Escape' && !e.isComposing) { e.stopPropagation(); antAddMenu.value = null } }
watch(() => !!antAddMenu.value, (open) => {
  if (open) window.addEventListener('keydown', onAntAddEsc, true)
  else window.removeEventListener('keydown', onAntAddEsc, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onAntAddEsc, true))
// 切视图即关：树上那份只是被 v-show 藏起来，不关的话回到对地视图它会在旧坐标上复现
watch(() => shellUi.side, () => { if (antAddMenu.value) antAddMenu.value = null })
async function antAddPick(kind) {
  const m = antAddMenu.value; antAddMenu.value = null
  if (!m) return
  const g = { tick: _userSelTick, fseq: _focusSeq }   // 在 ensureLinkedFolder 可能的等待之前捕获（见 createGaussFor 的 guard）
  let node = null, fresh = false
  if (m.src === 'tree') node = grdNodeOf(m.folder)
  else {
    const id = m.norad
    const en = (selEntry && String(selEntry.noradId) === id) ? selEntry : (satEntryById('n:' + id) || liveEntryOf(id))
    if (!en) { status.value = `关联卫星 NORAD ${id} 不在当前星历中`; return }
    const r = await ensureLinkedFolder(en)
    if (r) { node = r.node; fresh = r.fresh }
  }
  if (!node) return
  const folder = node.folder
  if (kind === 'gauss') { if (!(await createGaussFor(node, g)) && fresh) dropFreshLinked(folder); return }
  if (kind === 'synth') { await openBeamsWith(() => bs.setSat(folder)); return }   // 波束合成要的就是这颗星：新建的留着
  // 导入 GRD：对星视图里导入的一并画到壳层（sc.importGrd）；从信息卡发起且不在两个覆盖视图 → 落到对地视图
  // 为此新建的星：取消文件框 / 一个都没读进来 → 撤掉（dropFreshLinked 只撤仍然没有天线的）
  if (shellUi.side === 'satcov') { await satcov.importGrd(node); if (fresh) dropFreshLinked(folder); return }
  if (m.src === 'card' && shellUi.side !== 'antenna') shellUi.side = 'antenna'
  const keys = await grd.importGrd(node)
  if (fresh && !(Array.isArray(keys) && keys.length) && dropFreshLinked(folder)) return
  revealTreeFolder(folder)
}
// 两棵树的「＋」菜单里选了「高斯天线」（SatCovPanel 经 add-ant 事件过来）
function onTreeAddAnt(node, kind) { if (kind === 'gauss') createGaussFor(node) }

// ---- 切到波束合成视图再做一件事 ----
// 进视图的 watcher 会先 openFor（恢复「上次的组」），必须等它落了再选我们要的组 / 星，否则被它盖掉
function openBeamsWith(fn) {
  if (shellUi.side === 'beams' && bs.open.value) { fn(); return Promise.resolve() }
  return new Promise((resolve) => {
    let stop = null, t = 0
    const done = () => { if (stop) stop(); if (t) clearTimeout(t); stop = null; t = 0; fn(); resolve() }
    stop = watch(() => bs.open.value, (v) => { if (v) done() })
    t = setTimeout(done, 3000)                       // 兜底：树载入失败时 openFor 也会落，这里只防永远等下去
    shellUi.side = 'beams'
  })
}
// 「方向图」节「在波束合成中编辑」：切到波束合成并选中产出这根天线的那个组
function openSynthGroup(groupId) {
  if (!groupId || !bs.groups.value.some((g) => g.id === groupId)) { status.value = '该天线所属的波束合成组已不存在'; return }
  openBeamsWith(() => bs.selectGroup(groupId))
}
// 覆盖分析「方向图」节的只读判据（GrdSetSections 经 inject 取；两处挂载 —— 对地直挂、对星在 SatCovPanel 里 —— 共用这一份）：
// 波束合成组 groupId 还在世、且正驱动 key 这根天线才只读；组删了 / 天线是从别的工作区带来的 → 死 owner，天线就地可改。
// 读 bs.groups（load() 同步载入 localStorage，启动时不会误判成「组已不在」），调用方的 computed 随组增删 / 改名自动重算
provide('synthOwnerLive', (groupId, key) => synthGroupDrives(bs.groups.value, groupId, key, grd.keyOf))

// ---- 信息卡「天线」节：主选星关联的全部 folder 下的天线 ----
// 从稳定的 selPrimNorad + 树派生（信息卡对象每拍重建，不能从它派生）
const cardAntRows = computed(() => {
  const id = selPrimNorad.value
  if (!id) return []
  const nodes = linkedNodesOf(grdSats.value, id, treeGeoIdMap.value)
  const multi = nodes.length > 1
  const out = []
  for (const n of nodes) for (const a of n.antennas) out.push({ sat: n, a, key: grd.keyOf(n.folder, a.name), satName: multi ? n.satName : '' })
  return out
})
const fmtPeakDb = (v) => (Number.isFinite(+v) ? (+v).toFixed(2) : '—')

// ===================== 右侧「卫星信息栏」（.rdk-*）=====================
// 地图右侧、时间轴之上（时间轴仍通栏）。显隐只听 shellUi.satInfo，选中只换栏里的内容 —— 选星 / 取消时地图视口一个像素不动；
// 栏开合不改场景（聚焦几何 / 跟随 / 图例都不动，判据同「收起侧栏≠离开视图」）。
const RDK_SECS = ['rdk-live', 'rdk-el', 'rdk-ant', 'rdk-mdl']
function rdkSec(key, e) {   // 点节头 = 折叠 / 展开；Ctrl+点 = 只展开这一节、折叠其余（Blender 口径；聚焦集不参与）
  if (e && (e.ctrlKey || e.metaKey) && RDK_SECS.includes(key)) { for (const k of RDK_SECS) setSecOpen(k, k === key); return }
  toggleSec(key)
}
const rdkPriNo = computed(() => selList.value.findIndex((r) => r.active) + 1)
// 同族星只在尾段编号不同（ZHONGXING-26 / -10R、STARLINK-31402）：省略号只吃头段，含数字的尾段钉住
const RDK_TAIL = /^(.+?)([-_ ](?=[^-_ ]*\d)[^-_ ]{1,7})$/
const rdkName = (n) => { const m = RDK_TAIL.exec(n || ''); return m ? [m[1], m[2]] : [n || '', ''] }
const rdkRowTitle = (s) => `${s.name}${s.syn ? '' : ' · NORAD ' + s.noradId}${s.slot ? ' · ' + s.slot : ''}${s.alt ? ' · ' + s.alt + ' km' : ''}${s.incl ? ' · ' + s.incl + '°' : ''}`   // syn：天线树定点星（合成号不是 NORAD）
const rdkAbs = (v) => { const f = +v; return Number.isFinite(f) ? Math.abs(f).toFixed(2) : v }
const rdkNS = (v) => (+v < 0 ? '°S' : '°N')
const rdkEW = (v) => (+v < 0 ? '°W' : '°E')
const _p2 = (n) => String(n).padStart(2, '0')
// 「实时状态」节头的仿真时刻：读数对应哪一刻（显示时区与时间轴同源）
const rdkNowStr = computed(() => { const p = tzParts(clock.tMs, tzMode.value); return `${_p2(p.mo)}-${_p2(p.d)} ${_p2(p.h)}:${_p2(p.mi)}:${_p2(p.s)}` })
const rdkEp = computed(() => {   // 历元按显示时区：值 = [日期, 时刻]，时区角标挂在标签后
  const c = selected.value; if (!c || c.epochMs == null) return null
  const p = tzParts(c.epochMs, tzMode.value)
  return { d: `${p.y}-${_p2(p.mo)}-${_p2(p.d)}`, t: `${_p2(p.h)}:${_p2(p.mi)}:${_p2(p.s)}`, tz: tzTag(tzMode.value, c.epochMs) }
})
const rdkG1 = (c) => !!(c.aKm || c.ecc || c.incl || c.raan || c.argp || c.ma)   // 经典六根数
const rdkG2 = (c) => !!(c.meanMotion || c.period || c.perigee || c.apogee)         // 派生量
// 卫星组徽标：内置分组名要翻，用户星座名是数据不翻
const rdkGroupLit = computed(() => { const g = selected.value && selected.value.group; return !!g && (Object.values(GROUP_LABEL).includes(g) || g === TREE_GEO_LABEL) })
const rdkCopied = ref(false); let _rdkCopyT = 0
function rdkCopyNorad() {
  const id = selected.value && selected.value.noradId; if (!id) return
  perfWriteClipboard(String(id)); rdkCopied.value = true
  clearTimeout(_rdkCopyT); _rdkCopyT = setTimeout(() => { rdkCopied.value = false }, 1200)
}
function rdkAntAdd(ev) { setSecOpen('rdk-ant', true); openAntAddMenu(ev, 'card', { norad: selPrimNorad.value }) }   // 折叠态点「＋」先展开：新建的天线别落在看不见的地方
function rdkModelEdit() { revealSection('model', 'mdl-cur') }   // 先落到「卫星模型」侧栏的「当前卫星」节（侧栏收着就展开）；工作台从那一节再开
const rdkListEl = ref(null)
function rdkListKey(e) {   // ↑↓ / Home / End 换主选，Delete 移出；元素级 preventDefault 挡住 window 上的 onNavKeyDown（否则地球跟着转）
  const L = selList.value, i = L.findIndex((r) => r.active)
  if (!L.length) return
  let j = -1
  if (e.key === 'ArrowDown') j = Math.min(L.length - 1, i + 1)
  else if (e.key === 'ArrowUp') j = Math.max(0, i - 1)
  else if (e.key === 'Home') j = 0
  else if (e.key === 'End') j = L.length - 1
  else if (e.key === 'Delete') { e.preventDefault(); if (i >= 0) removeSel(L[i]); return }
  else return
  e.preventDefault()
  if (j >= 0 && j !== i) { setPrimary(L[j]); nextTick(() => { const r = rdkListEl.value && rdkListEl.value.querySelector('.pri'); if (r) r.scrollIntoView({ block: 'nearest' }) }) }
}

// ---- 「上一聚焦」：一格交换（电视「上一频道」语义），只存内存 ----
// 只在两类「会整批丢掉当前聚焦」的用户动作前记：地图上裸点换星、显式清空（信息栏 / 右键）。
// Ctrl/Shift 增减一颗、侧栏「聚焦」、向导预览都不记（增量可逆 / 有意为之 / 程序性）。
// 存条目引用（普通变量，不进 ref —— 深响应读出来是 Proxy，喂 Worker 会 DataCloneError）；恢复时照 wizPreviewRelease 重绑自定义星座。
let _prevFocus = null              // { list: Entry[], primary: Entry } | null
const prevFocusTag = ref('')       // 右键「上一聚焦」行尾读数：主选名 + 其余颗数（'' = 不出该项）
function snapFocus() {
  const list = selEntries.filter((e) => e.group !== PREVIEW_GROUP)
  return list.length ? { list, primary: list.includes(selEntry) ? selEntry : list[list.length - 1] } : null
}
function setPrevFocus(s) { _prevFocus = s; prevFocusTag.value = s ? s.primary.name + (s.list.length > 1 ? ' +' + (s.list.length - 1) : '') : '' }
function notePrevFocus() { const s = snapFocus(); if (s) setPrevFocus(s) }
// 真实星对象常驻；自定义星座在【星座全集】里按名重绑（含隐藏 —— 关掉眼睛不等于不存在，同 findByNorad「关联不因显隐中断」），
// 只有星座已删 / 星已不在才丢。不看 renderEntries：那是可见集，隐藏的星座与向导「仅预览」时会把整批星误判成不在场
function liveEntriesOf(list) {
  const out = []
  for (const e of list) {
    if (!isCustomEntry(e)) { out.push(e); continue }
    const pool = customConst.satsOf(e.group.slice(3))   // group = 'cc_' + 星座 id；build 签名缓存，不重新生成
    if (pool.includes(e)) { out.push(e); continue }
    const m = pool.find((x) => x.name === e.name)
    if (m) out.push(m)
  }
  return out
}
function swapPrevFocus() {
  const tgt = _prevFocus; if (!tgt) return
  const back = liveEntriesOf(tgt.list)
  if (!back.length) { setPrevFocus(null); return }
  const cur = snapFocus()
  const pri = back.includes(tgt.primary) ? tgt.primary
    : (back.find((x) => x.group === tgt.primary.group && x.name === tgt.primary.name) || back[back.length - 1])
  _userSelTick++   // 恢复＝用户改选（同 selectSat 的簿记）
  selEntries = back; selEntry = pri
  resetBeam(); refreshSelection(); _primPickVer = selVer.value; saveSelection()
  setPrevFocus(cur)   // 交换：再点一次回到刚才那一份（cur 为空＝刚才没有聚焦，该项随之消失）
}
function rdkClear() { notePrevFocus(); closeCard() }        // 信息栏「取消聚焦 / 全部取消」
function ctxClearFocus() { closeCtx(); rdkClear() }         // 右键「取消聚焦 / 全部取消聚焦」
function ctxPrevFocus() { closeCtx(); swapPrevFocus() }     // 右键「上一聚焦」

// ---- 画布点击的落点闸（配合「点空白不清空」）----
// scene.js 的 pointerup 拿【上一次】画布 pointerdown 的坐标比位移：按下若发生在别处（浮层遮罩在 mousedown 即拆、
// 窗口刚被激活、标题栏搜索下拉开着），抬起落在画布上也会被当成一次点选。这几种「顺手一点」只负责收起 / 激活，不改聚焦。
// window 捕获阶段：每一次按下都重新判一遍（不会残留上一次画布拖动留下的 true）。
let _pickArmed = false, _winFocusAt = 0
function onWinFocus() { _winFocusAt = performance.now() }
function onPickArmDown(e) {
  _pickArmed = e.button === 0 && !!el.value && el.value.contains(e.target) && document.hasFocus() &&
    performance.now() - _winFocusAt > 250 && !document.querySelector('.ms-pop')
}

// ---- 宽度：分隔条 / 窄档 / 横幅让位 / 2D 保中心 ----
const rdkEl = ref(null), rdkDrag = ref(false), rdkNarrow = ref(false)
let rdkRo = null, _rdkUp = null, _rdkKeepView = null
function rdkMeasure() {   // aside 实际显示宽（收起 = 0）→ 窄档类 + .g3 上的 --rdk-eff（横幅按地图区居中）
  const w = rdkEl.value ? Math.round(rdkEl.value.getBoundingClientRect().width) : 0
  rdkNarrow.value = w > 0 && w < 280
  if (g3el.value) g3el.value.style.setProperty('--rdk-eff', w + 'px')
}
function rdkKeepViewOnce() {   // 2D：本次开合前后保住地理中心（ro 回调里 resize 之后 setView）；两帧后作废
  if (!(flat && flatView.value)) return
  _rdkKeepView = flat.getView()
  requestAnimationFrame(() => requestAnimationFrame(() => { if (!rdkDrag.value) _rdkKeepView = null }))
}
watch(() => shellUi.satInfo, rdkKeepViewOnce, { flush: 'pre' })   // pre：DOM 变宽之前取视图
function rdkSplitDown(e) {
  if (!rdkEl.value) return
  const [lo, hi] = SAT_INFO_W_LIM
  const x0 = e.clientX, w0 = rdkEl.value.getBoundingClientRect().width   // 取显示宽（可能已被「地图保底 480」钳过）→ 起步无死区
  rdkDrag.value = true; document.documentElement.classList.add('ui-col-resize')
  if (flat && flatView.value) _rdkKeepView = flat.getView()
  let raf = 0, want = null
  const move = (ev) => {
    want = Math.round(Math.max(lo, Math.min(hi, w0 - (ev.clientX - x0))))
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (want != null) shellUi.satInfoW = want })
  }
  const up = () => {
    if (raf) cancelAnimationFrame(raf)
    if (want != null) shellUi.satInfoW = want
    rdkDrag.value = false; document.documentElement.classList.remove('ui-col-resize')
    document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); _rdkUp = null
    requestAnimationFrame(() => requestAnimationFrame(() => { if (!rdkDrag.value) _rdkKeepView = null }))
  }
  _rdkUp = up
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
}
function rdkSplitReset() { rdkKeepViewOnce(); shellUi.satInfoW = 300 }   // 双击分隔条：回出厂宽

// 点天线名：落到覆盖视图编辑它（已在对星视图就留在对星）；不转镜头（主选星就是它，已正对）
async function cardEditAnt(row) {
  const inShell = shellUi.side === 'satcov'
  if (!inShell) shellUi.side = 'antenna'
  if (inShell) await satcov.setActive(row.sat, row.a, { face: false })
  else await grd.setActive(row.sat, row.a, { face: false })
  revealTreeFolder(row.sat.folder)
}

// ---- 3D 右键压在一颗星上 ----
const ctxHasAnts = computed(() => {
  const m = ctxMenu.value
  if (!m || m.en < 0 || m.enRef == null) return false
  return linkedNodesOf(grdSats.value, m.enRef, treeGeoIdMap.value).some((n) => n.antennas.length)
})
function ctxSatEntry() {
  const m = ctxMenu.value
  const e = m && m.en >= 0 ? renderEntries[m.en] : null
  return e && e.noradId === m.enRef ? e : null          // 菜单开着期间渲染集可能换过：号对不上就不动（同 ctxFollow）
}
async function ctxNewGauss() {
  const e = ctxSatEntry(); closeCtx()
  if (!e) return
  const g = { tick: _userSelTick, fseq: _focusSeq }   // 在 ensureLinkedFolder 可能的等待之前捕获（见 createGaussFor 的 guard）
  const r = await ensureLinkedFolder(e)
  if (!r) return
  if (!(await createGaussFor(r.node, g)) && r.fresh) dropFreshLinked(r.node.folder)   // 为它新建的关联星，天线没建成 → 撤掉
}
async function ctxShowAntCov() {
  const e = ctxSatEntry(); closeCtx()
  if (!e) return
  const nodes = linkedNodesOf(grdSats.value, e.noradId, treeGeoIdMap.value).filter((n) => n.antennas.length)
  if (!nodes.length) return
  if (shellUi.side !== 'antenna') shellUi.side = 'antenna'   // 树已载入（天线只来自索引 / 快照），进视图的 toggleGrd 不会再重载
  for (const n of nodes) if (grd.satState(n) === 'none') await grd.toggleSatAll(n)
  revealTreeFolder(nodes[0].folder)
}

// ===== 独立仰角线：只画等仰角环的最小节点，与「卫星」弹窗（图标/卫星名/星座关联）脱钩 =====
function defaultElevDraft() { return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, els: '5,10', color: '#ffffff', elevWidth: 1.3, elevLabelSize: 18, elevLabelBold: false } }
function openAddElevLine() { elevModal.value = defaultElevDraft() }
function editElevLine(node) { elevModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, els: node.els, color: node.elevColor, elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18, elevLabelBold: !!node.elevLabelBold } }
function closeElevModal() { elevModal.value = null }
function applyElevGeoAlt() { if (elevModal.value) elevModal.value.altKm = GEO_ALT }   // 一键GEO：轨道高度设为 GEO
function saveElevModal() {
  const m = elevModal.value; if (!m) return
  const lon = Number(m.lon), lat = Number(m.lat), altKm = Number(m.altKm)
  if (!validLon(lon) || !validLat(lat) || !(altKm > 0)) return   // 非法输入不保存
  const patch = { satName: (m.name || '仰角线').trim() || '仰角线', lon, lat, altKm, els: m.els || '', elevColor: m.color || '#ffffff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18, elevLabelBold: !!m.elevLabelBold }
  if (m.folder) grd.updateSatellite(m.folder, patch)
  else grd.addElevLine(patch)
  closeElevModal(); redrawSats()
}

// ===== 轨道根数模拟星：用经典根数自建 satrec，复用 SGP4 引擎自行解算（不并入真实星座 entries）=====
const MU = 398600.4418   // 地球引力常数 km^3/s^2
// 星座共享历元：整个会话固定一个历元锚点，所有轨道根数模拟星都用它（不再逐星取 new Date()）。
//   SGP4 里平近点角/RAAN 从各星自身历元起算；逐星历元差 Δt 会给相对相位注入 n·Δt（550km 处约 0.06°/s，
//   1 分钟差≈3.8°、1 小时差≈228°，Walker 相对相位即被破坏）。全星共享同一历元 → 相对相位/相对 RAAN 精确保持，
//   绝对值取什么无所谓（整座星座只是刚性同步旋转）。刻意独立于 baseTime（后者进出实时会被重置）。
const SIM_EPOCH = new Date().toISOString()
// 经典轨道根数 → satrec（复用 omm2satrec；历元取共享锚点 SIM_EPOCH）。elements 角度单位 °，altKm 视作近地点高度（圆轨道 e=0 即轨道高度）。
function elementsToSatrec(el) {
  const ecc = Math.max(0, Math.min(0.999, Number(el.ecc) || 0))
  const a = (RE + (Number(el.altKm) || 0)) / (1 - ecc)   // 半长轴：a=(RE+hp)/(1-e)
  const n = Math.sqrt(MU / (a * a * a))                  // 平均运动 rad/s
  const meanMotion = 86400 * n / (2 * Math.PI)           // rev/day（omm2satrec 所需）
  return sat.omm2satrec({
    noradId: 'SIM', epoch: SIM_EPOCH,
    meanMotion, ecc, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0,
    argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, bstar: 0, mdot: 0, mddot: 0
  })
}
// 模拟星 satrec 缓存：根数签名不变则复用（改根数触发重建，但历元仍取共享 SIM_EPOCH，相位不跳变）
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
// ★ 关联星（node.noradId）解不出（星历里没有 / 已陨落 / SGP4 报错 / 点序列越出采样时段）→ 如实返回 null，
//   不再退回节点里存的 lon/lat/altKm —— 那是上次弹窗提交时的位置，不是上一拍的活位置，覆盖会一声不吭跳过去。
//   调用方一律按「此刻无星位」处理（与 useGrdCoverage.liveOf 同口径）：不画、不挪、不写、不拿来建天线。
function satLivePos(node) {
  if (!node) return null
  if (node.noradId) {
    const en = liveEntryOf(node.noradId)   // 自定义星座合成星(含隐藏)：关联后按合成星历实时跟踪
    if (!en) return null
    try {
      const now = isCustomEntry(en) ? ccTimeAt() : calcAt(); const pv = posAt(en, now)
      if (pv && pv.position) {
        const gd = sat.eciToGeodetic(pv.position, sat.gstime(now))
        const lon = sat.degreesLong(gd.longitude), lat = sat.degreesLat(gd.latitude), altKm = gd.height
        if (Number.isFinite(lon) && Number.isFinite(lat) && Number.isFinite(altKm)) return { lon, lat, altKm }
      }
    } catch { /* 根数异常 / 已衰减 */ }
    return null
  } else if (node.elements) {
    try { const now = calcAt(); const pv = posAt(orbitSatrec(node), now); if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, sat.gstime(now)); return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), altKm: gd.height } } } catch { /* 根数异常 → 回退静态值 */ }
  }
  return { lon: node.lon, lat: node.lat, altKm: node.altKm }
}

// 把实时关联星(linked/orbit)的【当前】星下点写入轻量缓存 globe3d/grdLive，供独立的链路预算窗口
// 在选星/导入时取到新位置（与覆盖分析同源 satLivePos）。固定星不写（其 lon 本就是真值）。节流 3s。
// 节流闸见 treeLink.createLiveThrottle：星历源换了（relinkTick 里 due()）的那一拍不受节流，池到齐前写下的 noEph 不许留住。
const _grdLiveGate = createLiveThrottle(3000)
function persistGrdLive() {
  const sats = (grd.sats && grd.sats.value) || []
  if (!sats.some((s) => s.noradId || s.elements)) return
  const nowMs = Date.now()
  if (!_grdLiveGate.pass(nowMs)) return
  // 关联星此刻解不出 → 进 noEph 一段（不写 pos）：链路预算窗口据此仍当它是实时星（回填指纹不翻、不按存盘旧星位取值），见 grdLivePayload
  const { pos, noEph } = grdLivePayload(sats, satLivePos)
  try { localStorage.setItem('globe3d/grdLive', JSON.stringify({ t: nowMs, pos, noEph })) } catch { /* ignore */ }
  fileBridge.liveTick++   // 驱动文件管理器 GRD 树行经度跟随实时
}

// 从星座点选：进入点选模式后，地图 onPick 命中的星填入弹窗（见 onMounted）
function toggleSatPick() { satPick.value = !satPick.value }
function pickEntryIntoModal(en) {
  if (!satModal.value || !en) return
  const p = satLivePos({ noradId: en.noradId })   // 借助同一解算路径取该星当前星下点/高度（解不出 → null）
  if (p && Number.isFinite(p.lon)) { satModal.value.lon = +p.lon.toFixed(3); satModal.value.lat = +p.lat.toFixed(3); satModal.value.altKm = +p.altKm.toFixed(1) }
  if (!satModal.value.name) satModal.value.name = en.name
  satModal.value.noradId = String(en.noradId)
  satPick.value = false
  applySatLive()   // 点选/搜索选星＝位置与关联当场落到地图上
}
function onSatSearch(e) {
  satSearchKw.value = e.target.value
  const kw = satSearchKw.value.trim().toLowerCase()
  if (!kw) { satSearchRes.value = []; return }
  ensureSearchPool()   // 懒加载全量搜索库（幂等）
  const src = searchSource(), out = []
  for (let i = 0; i < src.length && out.length < 30; i++) {
    const en = src[i]
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw) || (en.groupLabel && en.groupLabel.toLowerCase().includes(kw))) out.push({ en, name: en.name, noradId: en.noradId, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || '', slot: geoSlotOfSatrec(en.rec) })
  }
  satSearchRes.value = out
}
function pickSatSearch(r) { pickEntryIntoModal(r.en); satSearchKw.value = ''; satSearchRes.value = [] }

// 平面图期间挂起的 3D 卫星层 spec：2D 下 redrawSats 不再同步重建 3D 组（见函数尾注释），切回 3D 补喂
let satSpec3dPending = null, satSpec3dDirty = false
// 重绘仰角线独立图层（3D + 平面图共用同一 spec）；遍历卫星树每个点亮的卫星
function redrawSats() {
  if (!scene) return
  const lines = [], labels = [], sats = [], dots = [], fills = []
  for (const node of grdSats.value) {
    // 三项相互独立：卫星名由 labelShow 控、图标由 iconShow 控（2D 专用，3D 不画图标）；等仰角线由 elevShow 控且需填仰角值。
    const showLabel = node.labelShow !== false
    const showIcon = node.iconShow !== false
    const els = parseNums(node.els)
    const showElev = node.elevShow && els.length > 0
    if (!showLabel && !showIcon && !showElev) continue
    const p = (node.noradId || node.elements) ? satLivePos(node) : { lon: node.lon, lat: node.lat, altKm: node.altKm }
    if (!p || !Number.isFinite(p.lon) || !Number.isFinite(p.lat) || !(p.altKm > 0)) continue   // 关联星此刻无星历：图标 / 名称 / 仰角线都不画（不画在旧位置上）
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
        for (const b of best) if (b.q) labels.push({ lon: b.q[0], lat: b.q[1], text: elTxt, hpx: elHpx, color, alt: 40, bold: !!node.elevLabelBold })
      }
    }
    // 卫星名/图标：不依赖仰角值，名/图标各自独立开关（3D 只画名，2D 画图标+名，各自随 labelShow/iconShow 显隐）
    if (showLabel || showIcon) sats.push({ lon: p.lon, lat: p.lat, altKm: p.altKm, name: node.satName, color: colNum, nameColor: color, iconSize: node.iconSize || 30, labelSize: node.labelSize || 9, labelBold: !!node.labelBold, labelShow: showLabel, iconShow: showIcon })
  }
  // Polygon（协调区多边形）：挂同一独立图层，3D/2D 同步显示，不受覆盖图「清除绘制」影响。
  // 闭合环在此手动补首点并传 closed:false（2D 按折线画、不自动闭合；3D 亦无需重复闭合）。
  // 绘制/调点中的多边形画顶点圆点（px=屏幕恒定像素、r=3D 球面尺寸，大小随「顶点大小」设置）；
  // 闭合后在顶点均值处标「名称 数值」。
  for (const pg of polys.value) {
    const drawing = pg.id === polyDrawId.value, editing = pg.id === polyEditId.value || pg.id === polyMoveId.value
    if (!drawing && !editing && (pg.show === false || pg.pts.length < 3)) continue
    const colNum = cssToHex(pg.color)
    const ring = drawing ? pg.pts : closeRing(pg.pts)
    // under:true → 2D 平面图把边线画在国界/地名之下（与 GRD 等值线同层级）；3D 侧 renderOrder 6 < 国界 6.5 本就如此
    if (ring.length >= 2) lines.push({ p: densifyDeg(ring), color: colNum, width: pg.width || 2, opacity: 0.95, closed: false, under: true })
    // 区域填充：传未闭合原始顶点（3D earcut 三角化贴球、2D Path2D closePath），绘制中也实时预览；
    // 不透明度 0 视同关闭，跳过网格构建
    if (pg.fillOn !== false && pg.pts.length >= 3) {
      const op = Number.isFinite(Number(pg.fillOp)) ? Number(pg.fillOp) : 0.18
      if (op > 0) fills.push({ p: pg.pts, color: cssToHex(pg.fillColor || pg.color), opacity: op })
    }
    if (drawing || editing) for (const q of pg.pts) dots.push({ lon: q[0], lat: q[1], color: colNum, px: polyDotSize.value, r: polyDotSize.value * 0.0018 })
    const txt = [pg.name, pg.value].filter((x) => x != null && String(x).trim() !== '').join('  ')
    // top:true → 3D 里该标签关深度测试+半球剔除（不被地球模型裁切，转到背面才隐藏）；字号随各多边形 labelSize
    if (!drawing && txt && pg.pts.length >= 3) { const c = polyCentroid(pg.pts); labels.push({ lon: c[0], lat: c[1], text: txt, hpx: (Number(pg.labelSize) || 16) / 533, color: pg.color, alt: 40, top: true, bold: !!pg.labelBold }) }
  }
  // 波束合成草图（放置阶段的 3dB 椭圆轮廓 + 中心点 + 编号 + 频率配色填充）：与场合成同一几何链，所见即所得。
  const sk = bs.sketchSpec()
  if (sk) { if (sk.lines) lines.push(...sk.lines); if (sk.dots) dots.push(...sk.dots); if (sk.labels) labels.push(...sk.labels); if (sk.fills) fills.push(...sk.fills) }
  // 可见性分析叠加层：目标点高亮 + 可见星图标 + 目标→卫星连线（随时间轴实时）
  const vsk = vis.overlaySpec()
  if (vsk) { if (vsk.lines) lines.push(...vsk.lines); if (vsk.dots) dots.push(...vsk.dots); if (vsk.labels) labels.push(...vsk.labels); if (vsk.sats) sats.push(...vsk.sats) }
  // 波束合成「调整中心」/「删除波束」：在各波束中心叠可点击手柄圆环（与标记/Polygon 调点同款，平面图交互；调整=轮廓色，删除=警示红）
  if ((bs.adjusting.value || bs.deleting.value) && bs.open.value) for (const b of bs.beams.value) { if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) dots.push({ lon: b.lon, lat: b.lat, color: bs.deleting.value ? 0xe05252 : (cssToHex(bs.p.skColor) || 0x5ad1ff), px: MK_HANDLE_PX, r: MK_HANDLE_PX * 0.0018 }) }
  // 「调整位置」不再在标记正中叠手柄圆环：拖拽抓的是符号本体（命中区下限 11px，比 5px 手柄还大），
  // 那一圈只剩遮挡 —— 正好压在符号中心，图钉针尖、序号徽标一类全被它盖住。
  const spec = (lines.length || sats.length || dots.length || fills.length) ? { lines, dots, labels, sats, fills } : null
  // 2D 平面图激活时不同步重建 3D 卫星层：scene 已 pause，但 setSatLayer 的组重建（每个标签新建
  // canvas+texture）是同步开销，大波束群下拖拽每帧数百次分配 → 卡手。挂起到切回 3D 时一次性补建。
  if (flatView.value) { satSpec3dPending = spec; satSpec3dDirty = true }
  else { scene.setSatLayer(spec); satSpec3dDirty = false }
  if (flat) flat.setSatLayer(spec)
}

// ===================== 标记 / 地球站 / 轨迹 =====================
const MK_KEY = 'globe3d/markers'
const points = ref([])             // [{id,lat,lon,name?}]（名称可空）
const stations = ref([])           // [{id,lat,lon,name}]
const trajectories = ref([])       // [{id,name,kind,pts:[{lat,lon}]}]
const activeTraj = ref('')         // 当前编辑的轨迹 id
// 绘制态开关同步到两个渲染器：Polygon 或航迹描绘中 → 左键按住可沿路径连续加点（hold-to-draw）；退出→恢复平移/旋转（须在 activeTraj 声明后注册，否则 setup 期触发 TDZ）
watch([polyDrawId, activeTraj], ([pid, tid]) => { const on = !!(pid || tid); if (flat) flat.setPolyDrawMode(on); if (scene) scene.setPolyDrawMode(on) })
const ptLat = ref(''), ptLon = ref('')
const stLat = ref(''), stLon = ref(''), stName = ref('')
const wpLat = ref(''), wpLon = ref('')
// 标记层显示样式（侧栏「标记」三节，3D 球体与 2D 平面图同一份；出厂值＝可自定义之前写死的那套画法）。
// 尺寸口径一律【屏幕 px @100% 缩放】，两个渲染器各自按自己的缩放律联动（2D 的 iz / 3D 的 zoomK）。
// ★ 逐条覆盖：某个点可自带颜色（p.color，侧栏列表行内那枚色块），留空即跟这里的整层设置。
const markStyle = reactive({
  // 点标记：符号 / 颜色 / 透明度 / 大小 / 描边
  ptShape: 'circle', ptColor: '#ffd24a', ptOpacity: 1, ptDot: 3.5, ptEdge: 0.18, ptEdgeColor: '#ffffff',
  // 序号徽标（圈 1、圈 2）：序号＝点标记表格的行号（数组下标 +1，坐标留空的行照样占号），
  // 图上第 7 号就是表里第 7 行。关掉退回普通符号。
  ptIdxOn: true, ptIdx: 16, idxFill: '#ffd24a', idxFillOpacity: 0.62, idxRing: '#ffffff', idxInk: '#1b1205',
  // 名称 / 坐标标注（名称默认显示——没起名的点什么也不出；坐标默认不显示；两者同一行、共用下面这套字样）
  ptNameOn: true, ptLabelOn: false, ptFont: 14, ptLabelColor: '#ffffff', ptLabelOpacity: 1, ptLabelPos: 'up', ptBold: false,
  // 地球站：符号恒是那枚 Noto 天线（六色写实件，不换形状也不着色 —— 它是这层唯一的符号）
  stOpacity: 1, stIcon: 16,
  stLabelOn: false, stFont: 17, stLabelColor: '#ffffff', stLabelOpacity: 1, stLabelPos: 'down', stBold: false,
  // 航迹：线（航行/飞行两档色，某条航迹可自带覆盖色）+ 航点圆点 + 载具图标 + 航迹名
  tjSea: '#ff6a4a', tjFlight: '#5ad1ff', tjWidth: 2.2, tjOpacity: 0.95, tjDash: 'solid',
  tjDot: 4, tjDotSea: '#ff9a5a', tjDotFlight: '#5ad1ff',
  tjIconOn: true, tjIconPx: 26, tjIconSea: '#ff6a4a', tjIconFlight: '#5ad1ff',
  tjNameOn: false, tjNameFont: 13, tjNameColor: '#ffffff', tjNameBold: false,
  // 飞行航迹 3D 按实际高度画；「延伸到地面」＝航迹线到地面之间一道半透明垂幕（真实比例下高度靠它才看得出来）
  tjCurtain: true
})
const MARK_STYLE_DEF = { ...markStyle }   // 出厂值快照：各节标题上那个「默认」按它回填
// 分节恢复出厂样式：只回填本节的字段，别人调好的不动（同「聚焦卫星」那套）
const MARK_PARTS = {
  pt: ['ptShape', 'ptColor', 'ptOpacity', 'ptDot', 'ptEdge', 'ptEdgeColor', 'ptIdxOn', 'ptIdx', 'idxFill', 'idxFillOpacity', 'idxRing', 'idxInk', 'ptNameOn', 'ptLabelOn', 'ptFont', 'ptLabelColor', 'ptLabelOpacity', 'ptLabelPos', 'ptBold'],
  st: ['stOpacity', 'stIcon', 'stLabelOn', 'stFont', 'stLabelColor', 'stLabelOpacity', 'stLabelPos', 'stBold'],
  tj: ['tjSea', 'tjFlight', 'tjWidth', 'tjOpacity', 'tjDash', 'tjCurtain', 'tjDot', 'tjDotSea', 'tjDotFlight', 'tjIconOn', 'tjIconPx', 'tjIconSea', 'tjIconFlight', 'tjNameOn', 'tjNameFont', 'tjNameColor', 'tjNameBold']
}
// 标注摆位四档（上/下/左/右）与符号形状表：两个渲染器共用 viz/markers/markSymbols.js 那张表
const LABEL_POS = [{ k: 'up', zh: '上', en: 'Above' }, { k: 'down', zh: '下', en: 'Below' }, { k: 'left', zh: '左', en: 'Left' }, { k: 'right', zh: '右', en: 'Right' }]
const showPtLayer = ref(true)      // 点标记图层显隐（拨杆；隐藏仅停止渲染，数据保留并持久化）
const showStLayer = ref(true)      // 地球站图层显隐
const showTrajLayer = ref(true)    // 航迹图层显隐
// 「调整点位置」（仿 Polygon 调点）：在平面图上拖动圆点改坐标。'points'|'stations'|轨迹id，''=关闭；同一时刻仅一层可调、并与 Polygon 各态互斥。
const mkEditId = ref('')
const MK_HANDLE_PX = 5             // 可拖拽手柄圆环半径（屏幕恒定像素，比默认圆点略大便于抓取）
let bsEditPts = null              // 波束合成「调整中心」的 editVerts 快照（同上，拖动时原地更新）
let mkSeq = 1
const newId = () => 'm' + Date.now().toString(36) + (mkSeq++)   // 跨会话唯一，避免与已存数据撞 key

// 经度在前、纬度在后，保留两位小数
const fmtLL = (lat, lon) => (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) ? '—' : `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}, ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`
const validLat = (v) => Number.isFinite(v) && v >= -90 && v <= 90
const validLon = (v) => Number.isFinite(v) && v >= -180 && v <= 180

// 聚焦卫星相对地面点(lat,lon)的仰角；多选时取全部聚焦星中的最大仰角（即最「可见」/最高那颗）。未聚焦或全部不可解算时返回 null
function satElevAt(lat, lon) {
  if (!selEntries.length) return null
  const now = calcAt(), gmst = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)   // 合成星按场景历元解算
  const gs = { longitude: lon * DEG, latitude: lat * DEG, height: 0 }
  let best = null
  for (const e of selEntries) {
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    const pv = posAt(e, t)
    if (!pv || !pv.position) continue
    const el = sat.ecfToLookAngles(gs, sat.eciToEcf(pv.position, g)).elevation / DEG
    if (best == null || el > best) best = el
  }
  return best
}
// 标签用仰角文本：未聚焦返回空串（地平线以下显示负值即标识不可见）
const fmtElev = (lat, lon) => { const e = satElevAt(lat, lon); return e == null ? '' : `仰角 ${e.toFixed(1)}°` }
// 地球站标签方位 / 仰角：跟踪了具体卫星且勾了「方位角」/「仰角」→ 改读这颗星（仰角替换聚焦集最高仰角那份，一站只出一个数）；
// 都没勾仍走 fmtElev；只勾方位角时仰角照旧读聚焦集最高仰角
function stElevLabel(s) {
  const t = s.track, k = t && t.satKey
  const wantAz = !!(k && t.az), wantEl = !!(k && t.el)
  if (!wantAz && !wantEl) return fmtElev(s.lat, s.lon)
  const ecef = bodyTargetEcef(k, calcAt().getTime())
  const la = ecef ? sat.ecfToLookAngles({ longitude: s.lon * DEG, latitude: s.lat * DEG, height: 0 }, { x: ecef[0], y: ecef[1], z: ecef[2] }) : null
  const az = la ? la.azimuth / DEG : NaN, el = la ? la.elevation / DEG : NaN
  const out = []
  if (wantAz && Number.isFinite(az)) out.push(`方位 ${(((az % 360) + 360) % 360).toFixed(1)}°`)
  if (wantEl) { if (Number.isFinite(el)) out.push(`仰角 ${el.toFixed(1)}°`) }
  else { const e = fmtElev(s.lat, s.lon); if (e) out.push(e) }
  return out.join(' ')
}
const stElevTracked = () => stations.value.some((s) => s.track && (s.track.el || s.track.az))

// 聚焦星下点列表已并入 computeSelectedGeometry（与在轨点同一次 SGP4）—— 原先这里是整批星的第二趟推演；
// 推送则并在 commitGeometry（与可见性叠加层合到共用 replace-all 通道，避免相互覆盖）。

// 地图右键（3D 球体与 2D 平面图共用）：轨迹描绘中→直接加航点（连续右键描点）；否则→弹出右键菜单。
// ll：点击处经纬度（点在地球外为 null）；pos：屏幕坐标（菜单定位）。
const ctxMenu = ref(null)        // { x, y, ll, en } 右键菜单状态（null=隐藏）；en = 右键压着的那颗星（仅 3D，见 scene.pickSatAt）
function onMapRightClick(ll, pos, satIdx, entHit) {
  if (bs.placing.value) { if (ll) bs.placeAt(ll); return }   // 波束合成放置态：右键在此放一个波束轮廓，不弹菜单
  const pg = curPoly()
  if (pg) { if (ll) { pg.pts.push([ll.lon, ll.lat]); polyRefresh() } return }   // Polygon 绘制中：连续加顶点，不弹菜单
  const t = curTraj()
  if (t) { if (ll) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() } return }   // 描绘中：连续加点，不弹菜单
  // ★ 存下标不存条目：ctxMenu 是深响应 ref，条目放进去读出来就是 Proxy —— 进了 selEntries 喂聚焦几何 Worker 会 DataCloneError
  const en = (!flatView.value && Number.isInteger(satIdx) && satIdx >= 0 && renderEntries[satIdx]) ? satIdx : -1
  // 压着地球站 / 点标记 / 载具头：菜单首项给「模型…」（有模型再给「卸下模型」）。3D 由 scene 传第 4 参（跟随中为 null），2D / 旧版 scene 这里自己测
  const eh = entHit !== undefined ? entHit : (pos ? entHitAt(pos.x, pos.y, ['station', 'point', 'vehicle']) : null)
  const eo = eh ? entObjOf(eh.kind, eh.id) : null
  const ent = eo ? { kind: eh.kind === 'vehicle' ? 'traj' : eh.kind, id: eh.id, has: !!eo.model } : null
  // enPv：压着的是向导预览星（号段提交后换号，没有联动身份）→ 不给「新建高斯天线」
  ctxMenu.value = { x: pos ? pos.x : 0, y: pos ? pos.y : 0, ll: ll || null, en, enRef: en >= 0 ? renderEntries[en].noradId : null, enPv: en >= 0 && renderEntries[en].group === PREVIEW_GROUP, ent }
  nextTick(clampCtxMenu)   // 按菜单实际渲染尺寸夹紧到视口内：靠右/靠下边缘右键时不再被裁掉一截
}
function ctxFollow() {
  const m = ctxMenu.value; closeCtx()
  const e = m && m.en >= 0 ? renderEntries[m.en] : null
  if (e && e.noradId === m.enRef) startFollow(e)   // 菜单开着期间渲染集可能换过：号对不上就不动
}
function ctxStopFollow() { closeCtx(); stopFollow() }
// 右键压着实体：「模型…」在点击处开模型选择弹层；「卸下模型」直接删字段
function ctxEntModel() {
  const m = ctxMenu.value; closeCtx()
  const o = m && m.ent ? entObjOf(m.ent.kind, m.ent.id) : null
  if (o) pickPop.value = { kind: m.ent.kind, id: m.ent.id, anchor: { x: m.x, y: m.y, w: 0, h: 0 }, domain: pickDomainOf(m.ent.kind, o) }
}
function ctxEntUnmount() { const m = ctxMenu.value; closeCtx(); if (m && m.ent) setEntityModel(m.ent.kind, m.ent.id, null) }
const ctxMenuEl = ref(null)   // 右键菜单 DOM（量实际宽高用）
function clampCtxMenu() {
  const el = ctxMenuEl.value, m = ctxMenu.value
  if (!el || !m) return
  const r = el.getBoundingClientRect(), pad = 4
  const x = Math.max(pad, Math.min(m.x, window.innerWidth - r.width - pad))
  const y = Math.max(pad, Math.min(m.y, window.innerHeight - r.height - pad))
  if (x !== m.x || y !== m.y) ctxMenu.value = { ...m, x, y }
}
function closeCtx() { ctxMenu.value = null }
const ctxLL = () => ctxMenu.value && ctxMenu.value.ll
// —— 菜单动作（均在当前右键经纬度处执行）——
function ctxAddPoint() { const ll = ctxLL(); if (ll) addPoint(ll.lat, ll.lon); closeCtx() }
// 加地球站：弹出命名对话框（位置取右键处），确认后入库
const stPrompt = ref(null)       // { lat, lon } 待命名地球站；null=关闭
const stPromptName = ref('')
// 应用内提示弹窗（替代 Electron 原生 alert）：alertMsg/appAlert/closeAlert 见 stores/alert.js（GRD 等组合式同源）。
function ctxAddStation() { const ll = ctxLL(); if (ll) { stPrompt.value = { lat: ll.lat, lon: ll.lon }; stPromptName.value = '' } closeCtx() }
function confirmStation() {
  const p = stPrompt.value; if (!p) return
  stations.value.push({ id: newId(), lat: p.lat, lon: p.lon, name: (stPromptName.value || '').trim() || '地球站' })
  syncMarkers(); stPrompt.value = null; stPromptName.value = ''
}
function cancelStation() { stPrompt.value = null; stPromptName.value = '' }
// 新建一条轨迹并进入描绘态（之后连续右键加点，由顶部横幅「结束」收尾）
function ctxStartTraj(kind) { newTraj(kind); const ll = ctxLL(); if (ll) { const t = curTraj(); if (t) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() } } closeCtx() }
// 结束描绘：与 polyDone/polyCancel 同口径——空航迹（0 点）直接丢弃，不留空卡片
function endTraj() {
  const t = curTraj()
  if (t && (!t.pts || !t.pts.length)) removeTraj(t.id)
  activeTraj.value = ''
}
// 右键处开始绘制 Polygon：新建多边形并落第一个顶点（与 ctxStartTraj 同款，之后右键/左键拖动连续加点，横幅「完成」闭合）
function ctxStartPoly() { const ll = ctxLL(); polyStartDraw(); if (ll) { const pg = curPoly(); if (pg) { pg.pts.push([ll.lon, ll.lat]); polyRefresh() } } closeCtx() }
// —— 隐藏（右键菜单平铺项）：与「隐藏所有 Polygon」同口径，逐条置 show=false，数据保留，可在标记面板逐条重新打开 ——
function hidePoints() { if (mkEditId.value === 'points') mkEditId.value = ''; for (const p of points.value) p.show = false; syncMarkers() }
function hideStations() { if (mkEditId.value === 'stations') mkEditId.value = ''; for (const s of stations.value) s.show = false; syncMarkers() }
function hideTrajs() {
  if (mkEditId.value && mkEditId.value !== 'points' && mkEditId.value !== 'stations') mkEditId.value = ''
  if (activeTraj.value) endTraj()   // 结束描绘态（空航迹直接丢弃，同 polyCancel）
  for (const t of trajectories.value) t.show = false
  syncMarkers()
}
function ctxHidePoints() { hidePoints(); closeCtx() }
function ctxHideStations() { hideStations(); closeCtx() }
function ctxHideTrajs() { hideTrajs(); closeCtx() }
function ctxHideAllMk() { hidePoints(); hideStations(); hideTrajs(); closeCtx() }
// 逐条显隐（标记面板每行的拨杆）：隐藏时退出它的调点 / 描绘态（同 togglePoly）
function toggleMkItem(o) {
  o.show = !mkShown(o)
  if (!o.show && o.id) {
    if (mkEditId.value === o.id) mkEditId.value = ''
    if (activeTraj.value === o.id) endTraj()
  }
  syncMarkers()
}
// 隐藏所有 Polygon（不删除）：与逐个 togglePoly 同口径批量置 show=false，数据保留在 polys/localStorage，
// 可在 Polygon 面板重新逐个勾选显示。绘制中若有未成形多边形（<3 点）随 polyCancel 丢弃。
function ctxClearPolys() {
  if (polyDrawId.value) polyCancel()   // 结束绘制态（未成形的直接丢弃）
  polyEditId.value = ''; polyMoveId.value = ''; polyVertsOpen.value = ''
  for (const pg of polys.value) pg.show = false
  polyRefresh(); closeCtx()
}
function clearAllCoverage() { if (covApiOk) clearCoverage(); if (grdApiOk) grd.clearDrawing(); closeCtx() }
// 清除壳层覆盖：与对星面板「清除绘图」同口径 —— 只取消勾选的天线（壳层上的填充/等值线/波束射线随之
// 消失），壳层库、参照网与各天线设置一概保留。参照网不随之撤（它由壳层的 show 决定），要撤走下一条。
function ctxClearShellCov() { satcov.clearDrawing(); closeCtx() }
// 隐藏壳层参照网（不删壳层）：与对星面板「显示壳层参照网」是同一个开关，可在面板重新勾上。
function ctxHideShellGuides() { satcov.s.guides = false; closeCtx() }
// 右键处命中国家（点在多边形内判定）→ 打开地图设置并选中该国进入逐国设色
function ctxSetLandColor() {
  const ll = ctxLL(); closeCtx()
  if (!ll) return
  const c = countryAt(ll.lon, ll.lat)
  if (!c || !c.zh) { appAlert('该位置不在陆地国家范围内'); return }
  shellUi.side = 'geo'
  pickLandCountry(c)
}
// 推给两个渲染器的整层样式（渲染器只认屏幕 px 与 CSS 色串；逐条覆盖在载荷里逐条带）
const markSizes = () => ({
  ptShape: markStyle.ptShape, ptColor: markStyle.ptColor, ptOpacity: markStyle.ptOpacity, ptDot: markStyle.ptDot,
  ptEdge: markStyle.ptEdge, ptEdgeColor: markStyle.ptEdgeColor,
  ptIdx: markStyle.ptIdx, idxFill: markStyle.idxFill, idxFillOpacity: markStyle.idxFillOpacity, idxRing: markStyle.idxRing, idxInk: markStyle.idxInk,
  ptFont: markStyle.ptFont, ptLabelColor: markStyle.ptLabelColor, ptLabelOpacity: markStyle.ptLabelOpacity, ptLabelPos: markStyle.ptLabelPos, ptBold: markStyle.ptBold,
  stOpacity: markStyle.stOpacity, stIcon: markStyle.stIcon,
  stFont: markStyle.stFont, stLabelColor: markStyle.stLabelColor, stLabelOpacity: markStyle.stLabelOpacity, stLabelPos: markStyle.stLabelPos, stBold: markStyle.stBold,
  tjWidth: markStyle.tjWidth, tjOpacity: markStyle.tjOpacity, tjDash: markStyle.tjDash, tjDot: markStyle.tjDot,
  tjIconOn: markStyle.tjIconOn, tjIconPx: markStyle.tjIconPx,
  tjNameOn: markStyle.tjNameOn, tjNameFont: markStyle.tjNameFont, tjNameColor: markStyle.tjNameColor, tjNameBold: markStyle.tjNameBold,
  tjCurtain: markStyle.tjCurtain
})
// 改样式：整层设置推给两个渲染器并重画（不写盘 —— 随快照持久化，与聚焦卫星那套同口径）
function applyMarkStyle() { pushMarkers() }   // 落盘交给 watch(snapshot, saveSettings)
function resetMarkPart(k) { for (const f of (MARK_PARTS[k] || [])) markStyle[f] = MARK_STYLE_DEF[f]; applyMarkStyle() }
function toggleMark(k) { markStyle[k] = !markStyle[k]; applyMarkStyle() }
function setMarkVal(k, v) { markStyle[k] = v; applyMarkStyle() }
// 标记载荷构造器：坐标/名称是否带文字由 markStyle.ptLabelOn / stLabelOn 决定（空串=符号/图标保留、文字隐藏）。
// pushMarkers 与 feedFlat 共用，避免两处各写一份导致显隐口径不一致。
// 图层隐藏（拨杆关）时返回空数组：仅停止渲染，points/stations/trajectories 原始数据不动、照常持久化。
// finite 守卫：批量表格里坐标可能暂空(null)——只渲染坐标齐全的点/站/航点，避免 NaN 画到画布
const finLL = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
// 逐条显隐（与 Polygon 的 pg.show 同口径）：show === false = 隐藏，只停渲染、数据保留；缺字段 = 显示（老存档不变）
const mkShown = (o) => !!o && o.show !== false
// idx：序号取【原数组下标 +1】而非过滤后的位次 —— 表格的序号列就是行号，坐标留空的行照样占一个号，
// 按过滤后重编会让图上的号与表里的行整体错位。空串＝不画序号（退回普通圆点）。
// iconPx（可选）：这个实体此刻有模型图标在画 → 渲染器按图标外廓给文字让位；缺字段 = 现状（逐像素不变，见 entIconPxOf）
// m2d（可选，只有平面图认）：挂了模型且「卫星模型 · 显示」开着 → 平面图画这件模型的俯视图、不画通用符号（px 与 3D 图标同一个值）；
//   缺字段 = 通用符号（模型全关时平面图逐像素不变）
// 两者的 px 都是这一类标记自己的图标大小（entIconPxOf(类别)）：模型与图标共用一个设置
// 点标记文字：名称（起了名且开着）+ 坐标（开着），同一行
const ptLabelText = (p) => [markStyle.ptNameOn ? String(p.name || '').trim() : '', markStyle.ptLabelOn ? fmtLL(p.lat, p.lon) : ''].filter(Boolean).join('  ')
const markerPts = () => {
  if (!showPtLayer.value) return []
  const eo = entIconsOn(), m2 = !!focusStyle.modelOn, px = entIconPxOf('point')
  return points.value.map((p, i) => ({ p, i })).filter(({ p }) => mkShown(p) && finLL(p)).map(({ p, i }) => {
    const o = { id: p.id, lat: p.lat, lon: p.lon, idx: markStyle.ptIdxOn ? String(i + 1) : '', label: ptLabelText(p), el: fmtElev(p.lat, p.lon), color: p.color || '' }
    if (eo && p.model) o.iconPx = px
    if (m2 && p.model) o.m2d = { id: p.model.id, px }
    return o
  })
}
const markerSts = () => {
  if (!showStLayer.value) return []
  const eo = entIconsOn(), m2 = !!focusStyle.modelOn, px = entIconPxOf('station')
  return stations.value.filter((s) => mkShown(s) && finLL(s)).map((s) => {
    const o = { id: s.id, lat: s.lat, lon: s.lon, name: markStyle.stLabelOn ? s.name : '', el: stElevLabel(s) }
    if (eo && s.model) o.iconPx = px
    if (m2 && s.model) o.m2d = { id: s.model.id, px }
    return o
  })
}
// 航迹三样颜色（线/圆点/载具）在这里解析成数值：整层按航行/飞行两档，某条航迹自带 t.color 就整条改色
// （圆点与图标随之跟到那个色上 —— 一条航迹在图上是一件东西，改色只改一处）
// 运动档（有起始时刻 + 速度）另带 moving 与 line（大圆 0.5° 加密线，两个渲染器有 line 就画它；按编辑版本缓存，每拍不重复加密）
const markerTrs = () => {
  if (!showTrajLayer.value) return []
  const eo = entIconsOn() && markStyle.tjIconOn, m2 = !!focusStyle.modelOn && markStyle.tjIconOn, px = entIconPxOf('traj')
  return trajectories.value.filter(mkShown).map((t) => {
    const fl = t.kind === 'flight'
    const own = hexNum2(t.color)
    const o = {
      id: t.id, name: t.name || '', pts: (t.pts || []).filter(finLL), kind: t.kind,
      color: own != null ? own : hexNum(fl ? markStyle.tjFlight : markStyle.tjSea),
      dotColor: own != null ? own : hexNum(fl ? markStyle.tjDotFlight : markStyle.tjDotSea),
      iconColor: own != null ? own : hexNum(fl ? markStyle.tjIconFlight : markStyle.tjIconSea)
    }
    const line = trajLineOf(t)
    if (line) { o.moving = true; o.line = line }
    // 飞行航迹带实际高度（只有 3D 用：scene.setTrajectories 按它抬线 / 航点 / 航迹头；平面图不认这三个键）
    if (fl) { const h = traj3Of(t); if (h) { o.line3 = h.line3; o.ptAlts = h.ptAlts; o.headAltM = h.headAltM } }
    if (eo && t.model) o.iconPx = px
    if (m2 && t.model) o.m2d = { id: t.model.id, px }   // 平面图：航迹头画这件模型的俯视图（航迹图标开关关着就不画）
    return o
  })
}
// 飞行航迹的 3D 高度载荷（按编辑版本缓存：pushMarkers 清空、markerTrs 懒算 —— markerTrs 每拍都跑，剖面不重复算）：
//   line3 = 带实际高度的线（trajLine3：大圆加密 + 爬升顶点 / 下降起点等拐点），ptAlts = 各有效航点实际高度（与 finLL 过滤后的 pts 对齐），
//   headAltM = 航迹头（末航点）高度 —— 静止档载具停在那里；运动档由 feedEntities 每拍按时刻给
const traj3Cache = new Map()
function traj3Of(t) {
  if (traj3Cache.has(t.id)) return traj3Cache.get(t.id)
  let h = null
  try {
    const raw = toRaw(t), info = trajWaypointInfo(raw), line3 = trajLine3(raw)
    const ptAlts = info.filter(Boolean).map((e) => e.altM)
    if (line3.length > 1 && ptAlts.length) h = { line3, ptAlts, headAltM: ptAlts[ptAlts.length - 1] }
  } catch { h = null }
  traj3Cache.set(t.id, h)
  return h
}
// #rrggbb → 数值；空/非法 → null（逐条覆盖「没设」与「设成黑色」要分得开）
const hexNum2 = (c) => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? parseInt(String(c).slice(1), 16) : null)
// 哪几类标记此刻可以用鼠标拖：三类都【必须先点「调整位置」/ 航迹的「调点」】才解锁 —— 不进这个态时
// 压在标记上按住照常平移地图（原来是层可见即可直接拖，看图时极易把标记误挪走）。
// 航点给的是【航迹 id】而不是 true：正在调点的那条才可拖，别的航迹的航点不受影响。
function markDragKinds() {
  const id = mkEditId.value
  const tid = (id && id !== 'points' && id !== 'stations') ? id : ''
  return {
    point: showPtLayer.value && id === 'points',
    station: showStLayer.value && id === 'stations',
    waypoint: (showTrajLayer.value && tid) ? tid : false
  }
}
// 仅把标记推送到两个视图（含聚焦卫星仰角），不写入持久化；编辑 / 选星 / 改样式时整份重推（航迹组整组重建）。
// 每拍刷新仰角走 pushMarkerLabels（不重建航迹组）；运动档载具与实体模型在末尾 feedEntitiesNow 按当前时刻补一拍
function pushMarkers() {
  if (!scene) return
  trajLineCache.clear()   // 航迹可能改过：大圆加密线按这一版重算（markerTrs 里懒算，每条一次）
  traj3Cache.clear()      // 飞行航迹的实际高度载荷同理
  const pts = markerPts(), sts = markerSts(), trs = markerTrs()
  const st = markSizes()
  scene.setMarkStyle(st); scene.setMarkers(pts, sts); scene.setTrajectories(trs)
  const dk = markDragKinds()
  scene.setMarkerDrag(dk)
  if (flat) {
    flat.setMarkStyle(st); flat.setMarkers(pts, sts, trs)
    flat.setMarkerDrag(dk)
  }
  feedEntitiesNow()
}
// 每拍：只重推点 / 站两层（仰角标签随星动）。平面图的 setMarkers 一份载荷含三层，航迹那份照给（线走缓存）
function pushMarkerLabels() {
  if (!scene) return
  const pts = markerPts(), sts = markerSts()
  scene.setMarkers(pts, sts)
  if (flat) flat.setMarkers(pts, sts, markerTrs())
}
function syncMarkers() { pushMarkers(); persistMarkers(); syncEdit() }   // syncEdit：增删/改名后重建可拖拽快照（无编辑态时无副作用）

// ===================== 标记实体上球（DESIGN3 E7–E11 / P4）=====================
// 地球站 / 点标记 / 航迹载具挂 3D 模型。绑定【内联在标记对象上】（不进 models.bindings.json —— 那张表的键只认卫星）：
//   s.model = {id}（大小不逐个存：跟这一类标记的图标大小，见 entIconPxOf；老存档 / 老工作簿里的 model.px 进场摘掉，见 dropModelPx）、
//   s.track = {kind:'sat', satKey}（缺字段 = 跟主选星：聚焦集里此刻 WGS-84 仰角最高的一颗，滞回 0.5°，
//   最高仰角 < 0 收成停放姿态）；p.model；t.model、t.cruiseAltM（飞行缺省 10668 m 不写进对象）、t.speedKmh + t.t0Ms（运动档）。
// 每拍（feedModels 末尾，与星位同一个 now）：① 运动档载具沿大圆移动（3D 精灵 / 2D 图标）；② 站天线跟踪解算（侧栏读数用 WGS-84）；
// ③ 实体模型层（3D 球面屏幕定尺图标，px 为默认视角下的像素、随缩放联动；与标记精灵交叉淡化）；平面图画同一件模型的正射俯视图（entSprites，载荷 m2d）。模型开关与卫星模型共用「卫星模型 · 显示」拨杆。
let entityLayer = null
// 平面图的模型俯视图出图器（viz/flatmap/entitySprites.js）：借 modelLayer.source，平面图懒创建，两头谁后到谁接上（ensureFlat / onMounted）
let entSprites = null
const _aimList = [], _aimItems = new Map()   // 推给平面图的站指向 [{id, az, el, park}]（复用条目）
// 挂了模型的站此刻对星的画面口径方位 / 仰角 → 平面图（stTracks 本拍刚算过；站层关着 / 没有挂模型的站时推空表，平面图那份随之清掉）
function pushStationAims() {
  if (!flat || !flat.setStationAims) return
  _aimList.length = 0
  for (const [id, tr] of stTracks) {
    let a = _aimItems.get(id)
    if (!a) { a = { id, az: NaN, el: NaN, park: true }; _aimItems.set(id, a) }
    a.az = tr.aim.azDeg; a.el = tr.aim.elDeg; a.park = !!tr.park
    _aimList.push(a)
  }
  for (const id of _aimItems.keys()) if (!stTracks.has(id)) _aimItems.delete(id)
  flat.setStationAims(_aimList)
}
const vehStates = new Map()          // 航迹 id → makeTrajState()（每拍复用）
const stTracks = new Map()           // 站 id → makeTrackState()（滞回 / 目标 / 关节连续性按站保留）
const entItems = new Map()           // 实体键 st:/pt:/tr: → 推给实体层的项（复用对象，层只拷值）
const entList = []
const _focusCands = []               // [{key, ecef:[3]}]：聚焦集各星本拍 ECEF（km），复用
const _trkCands = new Map()          // satKey → [{key, ecef}]（显式跟踪某颗星：本拍缓存）
const trajLineCache = new Map()      // 航迹 id → 大圆加密线（null = 静止档）；pushMarkers 清空，markerTrs 懒算
const _movList = []                  // 运动档载具本拍状态 [{id, lat, lon, headingDeg, tan}]（updateVehicles / setVehicleStates 共用）
const _movItems = new Map()          // 航迹 id → _movList 的复用项
let _movWas = false
const _seenIds = new Set()
const _stLla = { lat: 0, lon: 0, altM: 0 }
const entRead = shallowRef(new Map())   // 站 id → {az, el, park, key}（WGS-84 读数，侧栏「跟踪」行）
const vehRead = shallowRef(new Map())   // 航迹 id → {moving, altM, sKm, totalKm, done, pre}（侧栏运动行读数）
// 正在运动的航迹 id：只在成员变了才换引用。页面模板只读它（亮「运动」摘要 / 出读数行），逐拍变的读数文本
// 交给 VehReadTxt 小组件自己读 vehRead —— 否则载具一动（航迹带了时间就动）每拍整页重渲染，航迹表格跟着卡
const vehOn = shallowRef(new Set())
const mdlDragHit = shallowRef(null)     // 拖模型悬停命中（entityAtScreen 结果）
const pickPop = ref(null)               // 模型选择弹层 {kind, id, anchor, domain}
// 实体模型此刻画不画：与卫星模型同一个「显示」拨杆；2D 视图、跟随卫星期间一律不画（精灵照常）
const entOnC = computed(() => !!focusStyle.modelOn && !flatView.value && !following.value)
const entIconsOn = () => entOnC.value && !!entityLayer
const clampPx = (v) => Math.max(ENT_PX_MIN, Math.min(ENT_PX_MAX, Math.round(v)))
// 标记挂的模型与这一类标记的图标共用一个大小（2026-09-25 用户定「标记的模型大小和图标大小公用统一设置」）：
//   地球站 = 地球站「大小」；航迹载具 = 航迹「载具图标 · 大小」；点标记 = 显示序号时「圈大小」、否则符号「大小」折成视觉直径
//   （PT_DOT_K，与两个渲染器同一份）。都是默认视角下的像素、随缩放联动（与精灵同一把尺）：3D 模型图标、2D 俯视图、文字让位都用它。
//   卫星模型侧栏的「图标大小」只管卫星。夹 8–256（模型图标下限：地球站调到 5 px 时模型取 8）
function entIconPxOf(kind) {
  const v = kind === 'station' ? markStyle.stIcon
    : kind === 'point' ? (markStyle.ptIdxOn ? markStyle.ptIdx : markStyle.ptDot * PT_DOT_K)
      : markStyle.tjIconPx
  return clampPx(Number.isFinite(v) ? v : 16)
}
// 逐个实体的模型像素（model.px）已不生效：老存档 / 老工作簿带进来的就地摘掉（导出的航迹说明行也就不再写「图标=NN px」）
function dropModelPx(o) { if (o && o.model && typeof o.model === 'object' && 'px' in o.model) delete o.model.px }
function hasEntityModels() {
  return points.value.some((p) => p.model) || stations.value.some((s) => s.model) || trajectories.value.some((t) => t.model)
}
// 进出 2D / 跟随 / 拨杆：标签让位（iconPx）跟着变，实体层开关也要当场给（时钟停着时等不到下一拍）
watch(entOnC, () => { if (hasEntityModels()) pushMarkers(); else feedEntitiesNow() })
// 切到标记侧栏：读数当场补一拍（停表时等不到下一拍）
watch(() => shellUi.side, (s) => { if (s === 'markers') feedEntitiesNow() })
function trajLineOf(t) {
  if (trajLineCache.has(t.id)) return trajLineCache.get(t.id)
  const line = trajLinePts(toRaw(t))
  trajLineCache.set(t.id, line)
  return line
}
// 聚焦集各星本拍 ECEF（合成星走场景历元轴，与画面 / satElevAt 同口径）；返回有效个数
function focusCandsAt(now) {
  const gmst = sat.gstime(now), ccNow = ccTimeAt(now), ccG = sat.gstime(ccNow)
  let n = 0
  for (const e of selEntries) {
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccG : gmst
    let pv = null
    try { pv = posAt(e, t) } catch { pv = null }
    if (!pv || !pv.position) continue
    const r = sat.eciToEcf(pv.position, g)
    let c = _focusCands[n]
    if (!c) { c = { key: '', ecef: [0, 0, 0] }; _focusCands[n] = c }
    c.key = satKeyOf(e) || ('name:' + e.name); c.ecef[0] = r.x; c.ecef[1] = r.y; c.ecef[2] = r.z
    n++
  }
  return n
}
function feedEntitiesNow() { if (scene) feedEntities(calcAt(), null) }
/**
 * 每拍（feedModels 末尾）/ 编辑后（pushMarkers 末尾）：载具状态 → 精灵 / 平面图；站跟踪；实体模型层。
 * @param {Date} now  本拍时刻（与星位同一个）
 * @param {object|null} sn  sunStateAt(now)（feedModels 已算好就传进来，免算第二遍）
 */
function feedEntities(now, sn) {
  if (!scene) return
  const tMs = now.getTime()
  // 侧栏读数（站跟踪 / 载具里程）只在标记视图开着时换引用：换一次就是整页重渲染一次，看不见的读数不必逐拍刷
  const wantRead = shellUi.side === 'markers'
  // ① 载具：运动档或挂了模型的航迹才算（静止档没模型的载具精灵原位不动，逐位同现状）
  _movList.length = 0
  _seenIds.clear()
  const vr = wantRead ? new Map() : null
  if (showTrajLayer.value) {
    const trs = trajectories.value
    for (let i = 0; i < trs.length; i++) {
      const t = toRaw(trs[i])
      if (!t || !t.id || !mkShown(t)) continue
      const mv = trajMoving(t)
      if (!mv && !t.model) continue
      let st = vehStates.get(t.id)
      if (!st) { st = makeTrajState(); vehStates.set(t.id, st) }
      vehicleStateAt(t, tMs, st)
      _seenIds.add(t.id)
      if (!st.ok) continue
      if (vr) vr.set(t.id, { moving: mv, altM: st.altM, sKm: st.s / 1000, totalKm: st.sTotal / 1000, done: !!st.done, pre: st.phase === 'pre' })
      if (!mv) continue
      let m = _movItems.get(t.id)
      if (!m) { m = { id: t.id, lat: 0, lon: 0, headingDeg: 0, tan: null, altM: NaN }; _movItems.set(t.id, m) }
      m.lat = st.lat; m.lon = st.lon; m.headingDeg = st.headingDeg; m.tan = st.hasTan ? st.tan : null
      m.altM = t.kind === 'flight' ? st.altM : NaN   // 3D 精灵按此刻实际高度抬（scene.updateVehicles；航行 NaN = 不抬）
      _movList.push(m)
    }
  }
  for (const id of vehStates.keys()) if (!_seenIds.has(id)) { vehStates.delete(id); _movItems.delete(id) }
  // ② 运动档载具位置推给两个渲染器（只含运动档；上一拍有、这一拍没了也推一次空表，把平面图那份清掉）
  if (_movList.length || _movWas) {
    if (scene.updateVehicles) scene.updateVehicles(_movList)
    if (flat && flat.setVehicleStates) flat.setVehicleStates(_movList.length ? _movList : null)
  }
  _movWas = _movList.length > 0
  if (vr && (vr.size || vehRead.value.size)) {
    vehRead.value = vr
    const on = vehOn.value
    let n = 0, same = true
    for (const [id, r] of vr) if (r.moving) { n++; if (!on.has(id)) { same = false; break } }
    if (!same || n !== on.size) { const s = new Set(); for (const [id, r] of vr) if (r.moving) s.add(id); vehOn.value = s }
  }
  // ③ 地球站天线跟踪（挂了模型的站）：目标 = 显式那颗星，或聚焦集里仰角最高的一颗；读数 WGS-84，画面按场景锚点
  const er = wantRead ? new Map() : null
  let nFocus = -1
  _trkCands.clear()
  _seenIds.clear()
  if (showStLayer.value) {
    const sts = stations.value
    for (let i = 0; i < sts.length; i++) {
      const s = toRaw(sts[i])
      if (!s || !s.model || !s.id || !mkShown(s) || !finLL(s)) continue
      let cands, n
      if (s.track && s.track.satKey) {
        cands = _trkCands.get(s.track.satKey)
        if (!cands) { const ecef = bodyTargetEcef(s.track.satKey, tMs); cands = ecef ? [{ key: s.track.satKey, ecef }] : []; _trkCands.set(s.track.satKey, cands) }
        n = cands.length
      } else {
        if (nFocus < 0) nFocus = focusCandsAt(now)
        cands = _focusCands; n = nFocus
      }
      let tr = stTracks.get(s.id)
      if (!tr) { tr = makeTrackState(); stTracks.set(s.id, tr) }
      _stLla.lat = s.lat; _stLla.lon = s.lon; _stLla.altM = 0
      pickTrackTarget(_stLla, cands, n, tr)
      _seenIds.add(s.id)
      if (er) er.set(s.id, { az: tr.look.azDeg, el: tr.look.elDeg, park: !!tr.park, key: tr.key })
    }
  }
  for (const id of stTracks.keys()) if (!_seenIds.has(id)) stTracks.delete(id)
  if (er && (er.size || entRead.value.size)) entRead.value = er
  pushStationAims()   // 平面图模型俯视图的碟面指向（与 3D 同一组画面口径角）
  // ④ 实体模型层（3D 球面屏幕定尺图标，随缩放联动）
  if (!entityLayer) return
  const on = entOnC.value
  entityLayer.setEnabled(on)
  if (!on) return
  entityLayer.setSun((sn || sunStateAt(now)).sunS)
  // 模型大小 = 这一类标记的图标大小（见 entIconPxOf）
  const pxSt = entIconPxOf('station'), pxPt = entIconPxOf('point'), pxTr = entIconPxOf('traj')
  _seenIds.clear()
  entList.length = 0
  const item = (key, kind) => {
    let it = entItems.get(key)
    if (!it) { it = { key, kind, modelId: '', px: pxSt, lat: 0, lon: 0, altM: 0, headingDeg: 0, pitchDeg: 0, aim: null, _aim: null }; entItems.set(key, it) }
    it.kind = kind
    _seenIds.add(key); entList.push(it)
    return it
  }
  if (showStLayer.value) {
    for (const s0 of stations.value) {
      const s = toRaw(s0)
      if (!s.model || !mkShown(s) || !finLL(s)) continue
      const tr = stTracks.get(s.id)
      const it = item(entityKey('station', s.id), 'station')
      it.modelId = s.model.id; it.px = pxSt; it.lat = s.lat; it.lon = s.lon; it.altM = 0; it.headingDeg = 0; it.pitchDeg = 0
      if (tr) {
        const a = it._aim || (it._aim = { dir: null, azDeg: 0, elDeg: 0, park: true })
        a.dir = tr.aim.dir; a.azDeg = tr.aim.azDeg; a.elDeg = tr.aim.elDeg; a.park = !!tr.park
        it.aim = a
      } else it.aim = null
    }
  }
  if (showPtLayer.value) {
    for (const p0 of points.value) {
      const p = toRaw(p0)
      if (!p.model || !mkShown(p) || !finLL(p)) continue
      const it = item(entityKey('point', p.id), 'point')
      it.modelId = p.model.id; it.px = pxPt; it.lat = p.lat; it.lon = p.lon; it.altM = 0; it.headingDeg = 0; it.pitchDeg = 0; it.aim = null
    }
  }
  if (showTrajLayer.value && markStyle.tjIconOn) {
    for (const t0 of trajectories.value) {
      const t = toRaw(t0)
      if (!t.model || !mkShown(t)) continue
      const st = vehStates.get(t.id)
      if (!st || !st.ok) continue
      const it = item(entityKey('traj', t.id), trajEntityKind(t))
      it.modelId = t.model.id; it.px = pxTr; it.lat = st.lat; it.lon = st.lon
      it.altM = Number.isFinite(st.altM) ? st.altM : 0
      it.headingDeg = Number.isFinite(st.headingDeg) ? st.headingDeg : 0
      it.pitchDeg = Number.isFinite(st.pitchDeg) ? st.pitchDeg : 0
      it.aim = null
    }
  }
  for (const k of entItems.keys()) if (!_seenIds.has(k)) entItems.delete(k)
  entityLayer.setEntities(entList)
}

// ---- 写入（都落 syncMarkers：推图 + 落盘 + 调点快照；pushMarkers 末尾已含实体刷新）----
// kind：'station' | 'point' | 'traj'（'vehicle' 当 'traj'）
function entObjOf(kind, id) {
  if (kind === 'station') return stations.value.find((x) => x.id === id) || null
  if (kind === 'point') return points.value.find((x) => x.id === id) || null
  if (kind === 'traj' || kind === 'vehicle') return trajectories.value.find((x) => x.id === id) || null
  return null
}
/** 挂 / 换 / 卸模型：modelId 为空 = 卸下（删字段）。只存 id —— 大小跟这一类标记的图标大小（entIconPxOf） */
function setEntityModel(kind, id, modelId) {
  const o = entObjOf(kind, id)
  if (!o) return false
  if (modelId == null || modelId === '') {
    if (!o.model) return false
    delete o.model
  } else {
    const m = normEntityModel({ id: modelId })
    if (!m) return false
    if (o.model && o.model.id === m.id && !('px' in o.model)) return true
    o.model = m
  }
  syncMarkers()
  return true
}
/** 站天线跟踪目标：null / {kind:'focus'} = 主选星（删字段）；{kind:'sat', satKey} = 固定跟这颗 */
function setStationTrack(id, track) {
  const s = stations.value.find((x) => x.id === id)
  if (!s) return
  const t = track && track.kind === 'sat' ? normTrack(track) : null
  if (t) s.track = t
  else if (s.track) delete s.track
  else return
  syncMarkers()
}
/** 航迹运动字段：patch 键 cruiseAltM / speedKmh / t0Ms，值 null = 删；写后按规范化删掉非法值与等于缺省的巡航高度 */
function setTrajMotion(id, patch) {
  const t = trajectories.value.find((x) => x.id === id)
  if (!t || !patch) return
  for (const k of ['cruiseAltM', 'speedKmh', 't0Ms']) {
    if (!(k in patch)) continue
    const v = patch[k]
    if (v == null || v === '' || !Number.isFinite(Number(v))) delete t[k]
    else t[k] = k === 't0Ms' ? Math.round(Number(v)) : Number(v)   // 起始时刻取整毫秒：说明行只到毫秒，带小数的往返会被截掉（裁定 §8-5）
  }
  normTrajMotion(t)
  syncMarkers()
}
// ---- 调整位置（点标记 / 地球站 / 航迹航点：进此态才可用鼠标拖，见 markDragKinds）----
const mkEditLabel = computed(() => {
  const id = mkEditId.value; if (!id) return ''
  if (id === 'points') return '点标记'
  if (id === 'stations') return '地球站'
  const t = trajectories.value.find((x) => x.id === id)
  return t ? `航迹「${t.name || ''}」` : ''
})
function mkRefresh() { pushMarkers(); redrawSats(); syncEdit() }   // 重画标记（移动点）+ 重建命中快照；不写盘（拖动 end 时统一持久化）
function mkEditToggle(key) {
  if (mkEditId.value === key) { mkEditStop(); return }
  if (key !== 'points' && key !== 'stations' && !trajectories.value.some((t) => t.id === key)) return
  polyEditStop(); polyMoveStop(); if (polyDrawId.value) polyCancel(); stopSynthPlacement(); if (activeTraj.value) endTraj()   // 与 Polygon 各态 / 波束合成 / 航迹描绘互斥（共用 editVerts 槽 / 绘制态）
  if (key === 'points') showPtLayer.value = true
  else if (key === 'stations') showStLayer.value = true
  else { showTrajLayer.value = true; const t = trajectories.value.find((x) => x.id === key); if (t && t.show === false) { t.show = true; persistMarkers() } }   // 调点即显示这条（同 polyEditToggle）
  mkEditId.value = key                // 拖拽闸：只有这一类标记在 2D / 3D 上可拖（见 markDragKinds）
  mkRefresh()
}
function mkEditStop() { if (mkEditId.value) { mkEditId.value = ''; mkRefresh() } }
// 标记直接拖拽（渲染器命中后回调）：'move' 改坐标 + 实时重绘（不写盘），'end' 统一持久化。
// target = { kind:'point'|'station'|'waypoint', id, tid }；按 id 找对象 —— 载荷是过滤过的，下标对不上原数组。
function onMarkerDragged(target, ll, phase) {
  if (phase === 'end') { persistMarkers(); return }
  if (!target || !ll) return
  let obj = null
  if (target.kind === 'point') obj = points.value.find((p) => p.id === target.id)
  else if (target.kind === 'station') obj = stations.value.find((x) => x.id === target.id)
  else if (target.kind === 'waypoint') {
    const t = trajectories.value.find((x) => x.id === target.tid)
    obj = t ? (t.pts || []).find((q) => q.id === target.id) : null
  }
  if (!obj) return
  obj.lat = clamp(ll.lat, -90, 90); obj.lon = ll.lon
  pushMarkers(); redrawSats()   // redrawSats：可见性叠加层等以标记为目标的图元跟着走
}
function persistMarkers() {
  try { localStorage.setItem(MK_KEY, JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })) } catch { /* ignore */ }
}
function loadMarkers() {
  try {
    const d = JSON.parse(localStorage.getItem(MK_KEY) || 'null')
    if (d) {
      // 实体字段（model / track / 航迹运动）只删非法值、不补缺省、不动别的字段：老存档过它原样不变
      try { sanitizeMarkers(d) } catch { /* 规范化失败不挡加载 */ }
      for (const k of ['points', 'stations', 'trajectories']) if (Array.isArray(d[k])) for (const o of d[k]) dropModelPx(o)   // 逐个实体的模型像素已不生效
      points.value = d.points || []; stations.value = d.stations || []; trajectories.value = d.trajectories || []
      mkTable.ensureWaypointIds()   // 老存档的航点没有 id；直接拖拽按 id 定位，进场先补齐
    }
  } catch { /* ignore */ }
}

function addPoint(lat, lon, face) {
  if (!validLat(lat) || !validLon(lon)) return
  points.value.push({ id: newId(), lat, lon }); syncMarkers()
  if (face && scene) scene.faceLonLat(lon, lat)
}
function addPointInput() { addPoint(parseFloat(ptLat.value), parseFloat(ptLon.value)); ptLat.value = ''; ptLon.value = '' }
function removePoint(id) { points.value = points.value.filter((p) => p.id !== id); syncMarkers() }
// 逐条覆盖：某个点 / 某条航迹自己的颜色。传空串＝清除覆盖，回到整层设置（侧栏色块右键）。
function setPointName(id, v) { const p = points.value.find((x) => x.id === id); if (p) { if (v) p.name = v; else delete p.name; syncMarkers() } }
function setPointColor(id, v) { const p = points.value.find((x) => x.id === id); if (p) { p.color = v || ''; syncMarkers() } }
function setTrajColor(id, v) { const t = trajectories.value.find((x) => x.id === id); if (t) { t.color = v || ''; syncMarkers() } }

function addStation() {
  const lat = parseFloat(stLat.value), lon = parseFloat(stLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  stations.value.push({ id: newId(), lat, lon, name: (stName.value || '').trim() || '地球站' })
  stLat.value = ''; stLon.value = ''; stName.value = ''; syncMarkers()
}
function setStationName(id, v) { const s = stations.value.find((x) => x.id === id); if (s) { s.name = v; syncMarkers() } }
function removeStation(id) { stations.value = stations.value.filter((s) => s.id !== id); syncMarkers() }

// 自动名：同类顺序编号，且不与现有名撞车 —— 航迹名就是导出 Excel 的工作表名，同名会被 Excel 改写成「…(2)」
function trajAutoName(kind) {
  const base = kind === 'flight' ? byLang('飞行', 'Flight') : byLang('航行', 'Maritime')
  const used = new Set(trajectories.value.map((t) => String(t.name || '')))
  let i = trajectories.value.length + 1
  while (used.has(base + i)) i++
  return base + i
}
function newTraj(kind) {
  mkEditStop(); polyEditStop(); polyMoveStop(); if (polyDrawId.value) polyCancel(); stopSynthPlacement()   // 与 Polygon 各态 / 标记调整 / 波束合成互斥（同 polyStartDraw）
  const t = { id: newId(), name: trajAutoName(kind), kind, pts: [] }
  trajectories.value.push(t); activeTraj.value = t.id
  return t
}
function curTraj() { return trajectories.value.find((t) => t.id === activeTraj.value) }
// 面板「编辑」：进描绘态，隐藏着的航迹随之显示（同 polyContinue）
function editTraj(t) { activeTraj.value = t.id; if (t.show === false) { t.show = true; syncMarkers() } }
function trajUndo() { const t = curTraj(); if (t && t.pts.length) { t.pts.pop(); syncMarkers() } }   // 撤销最后一个航点（与 polyUndo 一致）
function addWaypoint() {
  const t = curTraj(); if (!t) return
  const lat = parseFloat(wpLat.value), lon = parseFloat(wpLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  t.pts.push({ lat, lon }); wpLat.value = ''; wpLon.value = ''; syncMarkers()
}
function removeWaypoint(t, i) { t.pts.splice(i, 1); syncMarkers() }
// 航迹名画在图上（「显示航迹名」开着时）：以前靠每拍整份重推顺带刷新，每拍不再重建航迹组之后要显式推一次
function setTrajName(id, v) { const t = trajectories.value.find((x) => x.id === id); if (t) { t.name = v; persistMarkers(); if (markStyle.tjNameOn) pushMarkers() } }
function removeTraj(id) { if (mkEditId.value === id) mkEditId.value = ''; if (mkTrajId.value === id) mkTrajId.value = ''; trajectories.value = trajectories.value.filter((t) => t.id !== id); if (activeTraj.value === id) activeTraj.value = ''; syncMarkers() }
function clearAllMarkers() { mkEditId.value = ''; points.value = []; stations.value = []; trajectories.value = []; activeTraj.value = ''; mkTrajId.value = ''; syncMarkers() }

// ===================== 标记批量表格（Excel 模块，仿链路预算性能表：独立浮窗 + Excel 网格 + 批量粘贴/导入）=====================
// 航迹表格「时间」列按显示时区读写（本机 / UTC / UTC±N）；只敲时分时日期沿用该航点原来那天
const mkTable = useMarkerTable({ points, stations, trajectories, newId, sync: syncMarkers, parseTime: (s, ref) => parseTzText(s, tzMode.value, ref) })
const mkTableOpen = ref(false)                 // 浮窗开关
const mkTab = ref('points')                    // 当前分页：points | stations | traj
const mkTrajId = ref('')                       // 航迹分页当前编辑的航迹 id
const mkWin = ref({ x: 0, y: 0, w: 620, h: 460, init: false })
const mkCurTraj = () => trajectories.value.find((t) => t.id === mkTrajId.value)
// 三张网格列定义（末两列恒为 经度、纬度，供批量粘贴按「末两列=坐标」约定解析）
const mkPtCols = [{ key: 'name', label: '名称' }, { key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true }]
const mkStCols = [{ key: 'name', label: '名称' }, { key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true }]
const mkCellText = (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) }
// 航迹网格（导航日志口径：一行 = 到达该航点的那一段）：经度 / 纬度 / 高度（仅飞行）/ 时间 可编辑，
// 航段 / 累计 / 航向 / 地速为推算读数（只读）。高度、时间默认显示推算值（灰字），手填即钉住该航点，清空回推算；首行时间 = 航迹起始
const WP_COL_DEF = {
  lon: { key: 'lon', label: '经度', num: true },
  lat: { key: 'lat', label: '纬度', num: true },
  altM: { key: 'altM', label: '高度', num: true, unit: 'm', fix: 0 },
  tMs: { key: 'tMs', label: '时间' },
  legKm: { key: 'legKm', label: '航段', num: true, unit: 'km', fix: 1, editable: false },
  cumKm: { key: 'cumKm', label: '累计', num: true, unit: 'km', fix: 1, editable: false },
  crs: { key: 'crs', label: '航向', num: true, unit: '°', fix: 1, editable: false },
  gs: { key: 'gs', label: '地速', num: true, unit: 'km/h', fix: 0, editable: false }
}
const wpColsOf = (kind) => wpColKeys(kind).map((k) => WP_COL_DEF[k])
const mkWpCols = computed(() => { const t = mkCurTraj(); return wpColsOf(t ? t.kind : 'sea') })
// 当前航迹的逐航点读数（trajWaypointInfo：排程时刻 / 实际高度 / 段长 / 航向 / 段速）。经响应式代理读 ——
// 改航点 / 钉点 / 起始 / 速度 / 巡航高度 / 类型都会让它重算；航点 id → 读数
const mkWpInfo = computed(() => {
  const t = mkCurTraj(), m = new Map()
  if (!t) return m
  let info = []
  try { info = trajWaypointInfo(t) } catch { info = [] }
  t.pts.forEach((p, i) => { if (p && p.id) m.set(p.id, info[i] || null) })
  return m
})
// 一格的值（显示 = 编辑起手 = 复制 = 导出同一口径；导出另把时间写成带偏移的文本）
function wpCellVal(r, key, e) {
  switch (key) {
    case 'lon': case 'lat': return r[key]
    case 'altM': return Number.isFinite(r.altM) ? r.altM : (e ? Math.round(e.altM) : null)
    case 'tMs': return Number.isFinite(r.tMs) ? r.tMs : (e && Number.isFinite(e.tMs) ? e.tMs : null)
    case 'legKm': return e && Number.isFinite(e.legM) ? +(e.legM / 1000).toFixed(1) : null
    case 'cumKm': return e ? +(e.sM / 1000).toFixed(1) : null
    case 'crs': return e && Number.isFinite(e.courseDeg) ? +e.courseDeg.toFixed(1) : null
    case 'gs': return e && Number.isFinite(e.speedKmh) ? Math.round(e.speedKmh) : null
    default: return null
  }
}
function mkWpText(r, c) {
  const v = wpCellVal(r, c.key, mkWpInfo.value.get(r.id))
  if (v == null) return ''
  if (c.key === 'tMs') return fmtTzTime(v, tzMode.value)
  return c.fix != null && Number.isFinite(v) ? v.toFixed(c.fix) : String(v)
}
// 推算值灰字、钉住的值正常色、时刻不合时序（早于前一个定时航点，排程没用它）标红；只读推算列灰字
function mkWpClass(r, c) {
  const e = mkWpInfo.value.get(r.id)
  if (c.key === 'altM') return Number.isFinite(r.altM) ? null : 'wp-auto'
  if (c.key === 'tMs') return e && e.tBad ? 'wp-bad' : (e && e.tPinned ? null : 'wp-auto')
  return c.editable === false ? 'wp-calc' : null
}
function mkWpTip(r, c) {
  const e = mkWpInfo.value.get(r.id)
  if (c.key === 'tMs' && e && e.tBad) return byLang('该时刻不晚于前一个定时航点，未参与排程', 'Not later than the previous timed waypoint; ignored by the schedule')
  return null
}
const WP_HEAD_TIP = {
  altM: ['该航点的实际高度（飞行剖面：起降 0 m、按爬升率爬升、巡航、3° 下滑）；手填即钉住该点高度，清空回推算', 'Actual altitude at the waypoint (climb / cruise / 3° descent profile); type to pin, clear to recompute'],
  tMs: ['到达该航点的时刻（显示时区）；手填即钉住（首行即起始时刻），只敲时分沿用原日期，清空回推算。相邻两个定了时刻的航点之间按距离 ÷ 时差定地速', 'Time at the waypoint (display time zone); type to pin (first row = start), clear to recompute. Legs between timed waypoints take distance ÷ time as ground speed'],
  legKm: ['上一航点到本航点的测地线段长（WGS-84）', 'Geodesic length of the leg from the previous waypoint (WGS-84)'],
  cumKm: ['自首航点起的累计里程', 'Cumulative distance from the first waypoint'],
  crs: ['上一航点出发时的大圆航向（正北起顺时针）', 'Great-circle course when leaving the previous waypoint (clockwise from north)'],
  gs: ['到达本航点这一段的地速', 'Ground speed of the leg arriving at this waypoint']
}
function mkWpHeadTip(c) { const t = WP_HEAD_TIP[c.key]; return t ? byLang(t[0], t[1]) : c.label }
// 表格参数栏改运动参数：进表格自己的撤销栈（没改动就把刚压的快照丢掉）
function mkMotEdit(t, fn) {
  if (!t) return
  const sig = () => [t.t0Ms, t.speedKmh, t.cruiseAltM].join('|')
  const s0 = sig()
  mkTable.pushUndo(); fn()
  if (sig() === s0) mkTable.dropUndo()
}
// 参数栏读数：全程 / 历时 / 到达（经响应式代理读，改航点 / 钉点 / 起始 / 速度跟着刷）
function fmtDur(ms) {
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60
  if (d) return `${d} d ${h} h ${mi} min`
  return h ? `${h} h ${mi} min` : (m ? `${mi} min` : `${Math.round(ms / 1000)} s`)
}
const mkTrajRead = computed(() => {
  const t = mkCurTraj(); if (!t) return ''
  void mkWpInfo.value
  const L = trajLengthM(t), t0 = trajStartMs(t), t1 = trajEndMs(t), out = []
  if (L > 0) out.push(byLang('全程 ', 'Total ') + (L >= 100000 ? (L / 1000).toFixed(0) : (L / 1000).toFixed(1)) + ' km')
  if (Number.isFinite(t0) && Number.isFinite(t1)) {
    out.push(byLang('历时 ', 'Duration ') + fmtDur(t1 - t0))
    out.push(byLang('到达 ', 'Arrival ') + fmtTzTime(t1, tzMode.value))
  }
  return out.join(' · ')
})
// 点标记网格（可编辑：单格改 / 区域粘贴 / 清除，均落到 points，syncMarkers 实时推图+落盘）
// 逐层的「删若干行」：按 id 集合过滤，返回真正删掉的条数（撤销快照由内核统一压）
const mkDelIds = (getList, setList, ids) => { const s = new Set(ids); const before = getList().length; setList(getList().filter((r) => !s.has(r.id))); return before - getList().length }
const mkPtGrid = useGridSelect({
  gridId: 'mk-pt',
  rows: () => points.value, cols: () => mkPtCols, cellText: mkCellText,
  onEdit: (id, key, val) => mkTable.ptLayer.update(id, { [key]: val }),
  onPasteBlock: (a, k, t) => mkTable.ptLayer.pasteBlock(a, k, t),
  onPasteAppend: (t) => mkTable.ptLayer.pasteAppend(t),
  onClear: (cells) => cells.forEach(({ rowId, key }) => mkTable.ptLayer.update(rowId, { [key]: '' })),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) mkTable.ptLayer.addRow(at + k); return n },
  onDeleteRows: (ids) => mkDelIds(() => points.value, (a) => { points.value = a }, ids),
  pushUndo: () => mkTable.pushUndo(), dropUndo: () => mkTable.dropUndo(), refresh: () => syncMarkers(),
  undo: () => mkUndo(), redo: () => mkRedo()
})
const mkStGrid = useGridSelect({
  gridId: 'mk-st',
  rows: () => stations.value, cols: () => mkStCols, cellText: mkCellText,
  onEdit: (id, key, val) => mkTable.stLayer.update(id, { [key]: val }),
  onPasteBlock: (a, k, t) => mkTable.stLayer.pasteBlock(a, k, t),
  onPasteAppend: (t) => mkTable.stLayer.pasteAppend(t),
  onClear: (cells) => cells.forEach(({ rowId, key }) => mkTable.stLayer.update(rowId, { [key]: '' })),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) mkTable.stLayer.addRow(at + k); return n },
  onDeleteRows: (ids) => mkDelIds(() => stations.value, (a) => { stations.value = a }, ids),
  pushUndo: () => mkTable.pushUndo(), dropUndo: () => mkTable.dropUndo(), refresh: () => syncMarkers(),
  undo: () => mkUndo(), redo: () => mkRedo()
})
const mkWpGrid = useGridSelect({
  gridId: 'mk-wp',
  rows: () => { const t = mkCurTraj(); return t ? t.pts : [] }, cols: () => mkWpCols.value, cellText: mkWpText,
  onEdit: (id, key, val) => mkTable.wpUpdate(mkTrajId.value, id, { [key]: val }),
  onPasteBlock: (a, k, t) => mkTable.wpPasteBlock(mkTrajId.value, a, k, t),
  onPasteAppend: (t) => mkTable.wpPasteAppend(mkTrajId.value, t),
  onClear: (cells) => cells.forEach(({ rowId, key }) => mkTable.wpUpdate(mkTrajId.value, rowId, { [key]: '' })),
  onInsertRows: (at, n) => { if (!mkCurTraj()) return 0; for (let k = 0; k < n; k++) mkTable.wpAddRow(mkTrajId.value, at + k); return n },
  // 删掉首航点后，新首航点若带时刻钉点就接任起始（normFirstPin）
  onDeleteRows: (ids) => { const t = mkCurTraj(); if (!t) return 0; const s = new Set(ids); const before = t.pts.length; t.pts = t.pts.filter((p) => !s.has(p.id)); normFirstPin(t); return before - t.pts.length },
  pushUndo: () => mkTable.pushUndo(), dropUndo: () => mkTable.dropUndo(), refresh: () => syncMarkers(),
  undo: () => mkUndo(), redo: () => mkRedo()
})
const mkCurGrid = () => mkTab.value === 'stations' ? mkStGrid : mkTab.value === 'traj' ? mkWpGrid : mkPtGrid
// 三分页（点标记/地球站/航迹航点）：v-for 稳定 key 渲染各自网格，v-show 切换显示（实例常驻，选区/编辑态各自保留）
const mkPanes = computed(() => [
  { tab: 'points', grid: mkPtGrid, cols: mkPtCols, rows: points.value, text: mkCellText },
  { tab: 'stations', grid: mkStGrid, cols: mkStCols, rows: stations.value, text: mkCellText },
  { tab: 'traj', grid: mkWpGrid, cols: mkWpCols.value, rows: mkCurTraj() ? mkCurTraj().pts : [], text: mkWpText, cellClass: mkWpClass, cellTip: mkWpTip }
])
const mkCount = computed(() => mkTab.value === 'stations' ? stations.value.length : mkTab.value === 'traj' ? (mkCurTraj() ? mkCurTraj().pts.length : 0) : points.value.length)
// 「导出 Excel」可用性：航迹分页导的是全部航迹（不只当前这条），故按全部航点数算
const mkXlsxRows = computed(() => mkTab.value === 'traj' ? trajectories.value.reduce((n, t) => n + ((t.pts || []).length), 0) : mkCount.value)
function mkWinInit(tab) {
  if (mkWin.value.init) return
  const { w: vw, h: vh } = g3Size()
  // 航迹页 8 列（经纬度 / 高度 / 时间 + 四列推算）加左栏 156 px，起手就给宽一些；另两页只有两三列
  const w = Math.min(tab === 'traj' ? 920 : 620, vw - 48), h = Math.min(Math.round(vh * 0.62), vh - 48)
  mkWin.value = { x: Math.max(12, Math.round((vw - w) / 2)), y: Math.max(12, Math.round(vh * 0.16)), w, h, init: true }
}
function openMkTable(tab) {
  mkTable.ensureWaypointIds()   // 老航点补稳定 id（网格定位用）
  mkSetTab(tab || mkTab.value)
  mkTable.clearHistory()
  mkWinInit(mkTab.value); mkTableOpen.value = true
}
function closeMkTable() { mkTableOpen.value = false }
function mkSetTab(tab) {
  mkTab.value = tab
  if (tab === 'traj' && !mkCurTraj()) mkTrajId.value = trajectories.value.length ? trajectories.value[0].id : ''
}
function mkUndo() { mkTable.undo() }   // undo/redo 内部已 sync
function mkRedo() { mkTable.redo() }
// 「＋ 增加」：选中行下方插一行空行（无选中则末尾），选区落到新行首列，直接键入或粘贴
function mkAddRow() {
  const g = mkCurGrid(), ri = g.sel.value.ri
  const listLen = () => mkTab.value === 'traj' ? (mkCurTraj() ? mkCurTraj().pts.length : 0) : (mkTab.value === 'stations' ? stations.value.length : points.value.length)
  const at = ri >= 0 ? ri + 1 : listLen()
  mkTable.pushUndo()
  if (mkTab.value === 'traj') {
    if (!mkCurTraj()) { mkTable.dropUndo(); appAlert('请先选择或新建一条航迹'); return }
    mkTable.wpAddRow(mkTrajId.value, at)
  } else {
    (mkTab.value === 'stations' ? mkTable.stLayer : mkTable.ptLayer).addRow(at)
  }
  syncMarkers()
  nextTick(() => { g.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; g.focusGrid() })
}
// 「粘贴」：读剪贴板批量追加（约定末两列 = 经度、纬度，前面文本列依次为 名称等）
async function mkPaste() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请检查剪贴板权限'); return }
  mkTable.pushUndo()
  let n = 0
  if (mkTab.value === 'traj') { if (!mkCurTraj()) { mkTable.dropUndo(); appAlert('请先选择或新建一条航迹'); return } n = mkTable.wpPasteAppend(mkTrajId.value, text) }
  else if (mkTab.value === 'stations') n = mkTable.stLayer.pasteAppend(text)
  else n = mkTable.ptLayer.pasteAppend(text)
  if (n) syncMarkers(); else { mkTable.dropUndo(); appAlert('剪贴板没有可识别的经纬度数据（约定末两列为 经度、纬度）') }
}
function mkClear() {
  mkTable.pushUndo()
  if (mkTab.value === 'traj') { if (!mkCurTraj() || !mkCurTraj().pts.length) { mkTable.dropUndo(); return } mkTable.wpClear(mkTrajId.value) }
  else if (mkTab.value === 'stations') { if (!stations.value.length) { mkTable.dropUndo(); return } mkTable.stLayer.clear() }
  else { if (!points.value.length) { mkTable.dropUndo(); return } mkTable.ptLayer.clear() }
  syncMarkers()
}
function mkDelRow(id) {
  mkTable.pushUndo()
  if (mkTab.value === 'traj') mkTable.wpRemove(mkTrajId.value, id)
  else if (mkTab.value === 'stations') mkTable.stLayer.remove(id)
  else mkTable.ptLayer.remove(id)
  syncMarkers()
}
// 表尾「＋ 增加一行」：恒追加到末尾（行中插入走右键菜单 / 工具条的「增加」）
function mkAddRowEnd() {
  const g = mkCurGrid()
  const at = mkCount.value
  mkTable.pushUndo()
  if (mkTab.value === 'traj') { if (!mkCurTraj()) { mkTable.dropUndo(); appAlert('请先选择或新建一条航迹'); return } mkTable.wpAddRow(mkTrajId.value, at) }
  else (mkTab.value === 'stations' ? mkTable.stLayer : mkTable.ptLayer).addRow(at)
  syncMarkers()
  nextTick(() => { g.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; g.focusGrid() })
}
// ===== 标记批量表格 ⇄ Excel（点标记 / 地球站：当前分页一张表；航迹：一条航迹一张工作表，见下）=====
const mkPane = () => mkPanes.value.find((p) => p.tab === mkTab.value) || mkPanes.value[0]
const mkPaneName = () => (mkTab.value === 'stations' ? '地球站' : mkTab.value === 'traj' ? '航迹' : '点标记')
async function mkExportXlsx() {
  if (mkTab.value === 'traj') return mkExportTrajXlsx()
  const p = mkPane()
  if (!p || !p.rows.length) { appAlert('当前分页没有数据'); return }
  const sheets = [sheetModel({ name: mkPaneName(), cols: p.cols, rows: p.rows, value: (r, c) => r[c.key] })]
  const r = await exportSheets({ defaultName: safeFileName(mkPaneName(), '标记') + '.xlsx', title: '导出标记表格', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function mkImportXlsx() {
  if (mkTab.value === 'traj') return mkImportTrajXlsx()
  const p = mkPane(); if (!p) return
  const res = await importWorkbook({ title: '导入到' + mkPaneName() })
  if (!res || res.canceled) return
  if (!res.ok) { appAlert('导入失败：' + (res.error || '无法读取该文件')); return }
  const sheet = pickSheet(res.sheets, p.cols)
  if (!sheet) { appAlert('这份工作簿里没有数据'); return }
  const { records } = sheetToRecords(sheet, p.cols)
  const layer = mkTab.value === 'stations' ? mkTable.stLayer : mkTable.ptLayer
  mkTable.pushUndo()
  let n = 0
  if (records) {
    // 有表头：逐行新建再按列写入（走与单格编辑同一条 setter，坐标/文本的归一口径不另开一份）
    for (const rec of records) { const row = layer.addRow(mkCount.value); layer.update(row.id, rec); n++ }
  } else {
    n = layer.pasteAppend(sheetToTsv(sheet))
  }
  if (!n) { mkTable.dropUndo(); appAlert('没有读到数据（表头需含「经度 / 纬度」，或把经纬度放在最后两列）'); return }
  syncMarkers()
}

// ===== 航迹 ⇄ Excel（按工作表批量：一条航迹一张表，表名即航迹名；解析口径见 useMarkerTable.trajsFromSheets）=====
async function mkExportTrajXlsx() {
  const list = trajectories.value.filter((t) => (t.pts || []).length)
  if (!list.length) { appAlert('没有可导出的航迹（航迹都还没有航点）'); return }
  const tz = tzMode.value
  const sheets = list.map((t) => {
    // 与网格同列同值：高度 / 时间写实际值（推算的也写），时间带时区偏移（换台机器 / 换显示时区导回来不走样）；另带四列推算读数
    let info = []
    try { info = trajWaypointInfo(toRaw(t)) } catch { info = [] }
    const idx = new Map((t.pts || []).map((p, i) => [p, i]))
    return sheetModel({
      name: t.name || byLang('航迹', 'Track'), cols: wpColsOf(t.kind), rows: t.pts,
      value: (r, c) => {
        const v = wpCellVal(r, c.key, info[idx.get(r)] || null)
        return c.key === 'tMs' ? (Number.isFinite(v) ? fmtTzTimeOff(v, tz) : null) : v
      },
      // 航迹类型 + 航迹级字段（巡航高度 / 速度 / 起始时刻 / 模型 / 图标）：主进程把 note 单开成「说明」表，导回来照认。
      // 第一段恒是类型词（「飞行」「航行」），老版本导入器照样认类型。末尾两段是钉点清单（定时 / 定高：哪些航点的时刻 / 高度是用户定的）——
      // 高度 / 时间两列写的是实际值，导回来只把清单里那几格钉回去，往返同义
      note: trajNoteOf(t) + '; ' + pinNoteOf(t)
    })
  })
  const r = await exportSheets({ defaultName: safeFileName('航迹', '航迹') + '.xlsx', title: '导出航迹', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function mkImportTrajXlsx() {
  const res = await importWorkbook({ title: '导入航迹（一张工作表一条）' })
  if (!res || res.canceled) return
  if (!res.ok) { appAlert('导入失败：' + (res.error || '无法读取该文件')); return }
  const made = trajsFromSheets(res.sheets, {
    newId, taken: trajectories.value.map((t) => String(t.name || '')), fallbackName: byLang('航迹', 'Track'),
    parseTime: (s, ref) => parseTzText(s, tzMode.value, ref)
  })
  if (!made.length) { appAlert('没有读到航点（表头需含「经度 / 纬度」，或把经纬度放在最后两列）'); return }
  mkTable.pushUndo()
  const add = made.map((t) => {
    const o = { id: newId(), name: t.name, kind: t.kind, pts: t.pts }
    for (const k of TRAJ_NOTE_FIELDS) if (t[k] !== undefined) o[k] = t[k]   // 说明行透传的航迹级字段（只有合法项）
    dropModelPx(o)             // 老工作簿说明行里的「图标=NN px」：模型大小已跟航迹载具图标大小，不再逐条存
    return normTrajMotion(o)   // 手写的「巡航高度=10668 m」= 出厂缺省：不写进对象（与侧栏填 10668 同口径）
  })
  trajectories.value = [...trajectories.value, ...add]
  mkTrajId.value = add[0].id
  syncMarkers()
}
// ---- 航迹分页左栏（主从：左边一条条航迹，右边该航迹的航点网格）：新建 / 选中 / 改名 / 换类型 / 删除 ----
const mkRenameId = ref('')     // 正在改名的航迹 id（''=没有在改名）
const mkRenameVal = ref('')
function mkNewTraj(kind) {
  mkTable.pushUndo()
  const t = newTraj(kind); mkTrajId.value = t.id; syncMarkers()
  mkRenameStart(t)             // 新建即进改名态，名字当场敲掉（不满意自动名时省一次双击）
}
function mkRenameStart(t) {
  mkRenameId.value = t.id; mkRenameVal.value = t.name || ''
  nextTick(() => { const el = document.querySelector('.mtj-ren'); if (el) { el.focus(); el.select() } })
}
function mkRenameCancel() { mkRenameId.value = '' }
function mkRenameCommit() {
  const id = mkRenameId.value; if (!id) return   // esc 取消后紧跟的 blur 会再进来一次，靠这句挡掉
  mkRenameId.value = ''
  const t = trajectories.value.find((x) => x.id === id); if (!t) return
  const v = mkRenameVal.value.trim()
  if (!v || v === t.name) return
  mkTable.pushUndo(); t.name = v; syncMarkers()
}
function mkToggleKind(t) { mkTable.pushUndo(); t.kind = t.kind === 'flight' ? 'sea' : 'flight'; syncMarkers() }
// 删航迹：选中落到相邻一条（删完不至于右边空着）；误删走工具条的撤销
function mkDelTraj(t) {
  const i = trajectories.value.findIndex((x) => x.id === t.id); if (i < 0) return
  if (mkRenameId.value === t.id) mkRenameId.value = ''
  mkTable.pushUndo()
  removeTraj(t.id)             // 内部已 syncMarkers，并清掉 activeTraj / mkEditId / mkTrajId 的悬挂引用
  const list = trajectories.value
  mkTrajId.value = list.length ? list[Math.min(i, list.length - 1)].id : ''
}
// 浮窗拖拽/缩放（复用性能表的会话与坐标系换算 g3Size / perfDragSession）
function mkDragMove(e) {
  if (e.button !== 0 || (e.target.closest && e.target.closest('.csx, .ptb, .mk-tab, input, select, label'))) return
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, o = { ...mkWin.value }
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    const x = Math.max(-o.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx)))
    const y = Math.max(0, Math.min(vh - 32, o.y + (ev.clientY - sy)))
    mkWin.value = { ...mkWin.value, x, y }
  })
}
function mkDragResize(e, dir = 'se') {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, o = { ...mkWin.value }
  const minW = 320, minH = 220
  const E = dir.includes('e'), W = dir.includes('w'), S = dir.includes('s'), N = dir.includes('n')
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    let x = o.x, y = o.y, w = o.w, h = o.h
    const dx = ev.clientX - sx, dy = ev.clientY - sy
    if (E) w = Math.max(minW, Math.min(o.w + dx, vw - o.x - 6))
    if (S) h = Math.max(minH, Math.min(o.h + dy, vh - o.y - 6))
    if (W) { const right = o.x + o.w; x = Math.max(6, Math.min(o.x + dx, right - minW)); w = right - x }
    if (N) { const bottom = o.y + o.h; y = Math.max(0, Math.min(o.y + dy, bottom - minH)); h = bottom - y }
    mkWin.value = { ...mkWin.value, x, y, w, h }
  })
}

// 时间读数（双行定宽块，DAW 范式：主行=时刻/偏移量，副行=日期时间；tabular-nums 防拖动抖动）
// 时区随 tzMode 切换（仅显示）：副行末尾挂档位标记，避免「读到 08:00 却不知道是哪个 08:00」。
// ★ 主行改成【时刻本身】（HH:MM:SS），副行才是日期 + 相对真实此刻的偏移。
//   改造前主行是「相对时间轴锚点的偏移」：锚点会随「跳到时刻」搬家，跳到后天照样显示「此刻」——
//   偏移的参照必须是真实当前时刻，否则这个数读不出任何东西。近 1 min 内一律算「此刻」，
//   免得停着不动的表每秒把 −0:02 −0:03 数下去（那个抖动只是参照在走，不是仿真时刻在走）。
const relNowMs = computed(() => clock.tMs - nowStamp.value)
const atNow = computed(() => Math.abs(relNowMs.value) < 60000)
// ★ 副行拆成三格（日期 / 偏移量 / 时区档位）：偏移量是这条时间条上唯一会随拖动改变【宽度】的串
//   （"此刻" ⇄ "+1d4h32m" 差着几十像素，且 --font-mono 实为衬线栈、只有数字等宽），
//   读数块一鼓一缩就推着中间 flex:1 的尺子重排 —— 拖游标时整条时间条抽动的根因。
//   块宽在 CSS 里钉死，日期与时区常显，只有偏移量那一格富余时收缩。
const timeParts = computed(() => {
  const p = (n) => String(n).padStart(2, '0')
  const tag = tzLabel.value
  const d = new Date(clock.tMs)
  const md = `${p(tMon(d) + 1)}-${p(tDay(d))}`
  const hms = `${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`
  const off = live.value ? '实时' : (atNow.value ? '此刻' : fmtOffset(relNowMs.value))   // fmtOffset 各档串长 ≤ 10 字符，装得进定宽的 11ch 一格
  const offA = live.value ? byLang('实时', 'Live') : atNow.value ? byLang('此刻', 'Now') : off   // aria-valuetext 不经呈现层翻译，按语言直接出字
  return { m: hms, d: md, o: off, z: tag, s: `${md} ${off} ${tag}`, a: `${md} ${hms} ${tag} ${offA}` }   // a：aria-valuetext（含时刻）
})
function setTzMode(v) { tzMode.value = normTzMode(v, tzMode.value); saveSettings() }
const tzRefMs = computed(() => Math.floor(clock.tMs / 900000) * 900000)   // TzPicker 只用它取本机档角标：量化到 15 min，不再每帧重渲子组件
// —— 读数块：列 2 定宽 + 时区菜单展开态 ——
// 列 2 = max(11ch, 本字体下最宽可能串)：11ch 是按 Arial 定的，Palatino / Garamond / Segoe 的 d·h·m 比「0」宽，
// 「−99d23h59m」在这三种字体里顶出 11ch 被截。量的是 fmtOffset 每一档的最宽形态 + 最长时区角标，# 逐个换 0–9 取最宽 ——
// 不假设数字等宽；tabular-nums 只有排版引擎认（canvas 量不到），故借读数块本身实排一遍（每种字体一次，结果按字体栈缓存）
const roEl = ref(null)            // TzPicker 实例
// 读数块元素。★ 不能直接取 $el：TzPicker 模板顶上有注释，开发态下根是 Fragment，$el 是它的起始锚点（文本节点）
const roBlk = (c = roEl.value) => { let n = c && c.$el; while (n && n.nodeType !== 1) n = n.nextSibling; return n || null }
const roC2 = ref(0)               // 列 2 定宽下限（em，0 = 只用 CSS 的 11ch）
const RO_C2_PAT = ['−##d##h##m', '−##:##:##', '−####d##h', '−######d', '−######y', 'UTC+##:##', 'UTC−##:##']
const _c2 = new Map()
function measureRoC2() {
  const host = roBlk(), stack = uiFont.stack
  if (!host || !host.isConnected) return
  let v = _c2.get(stack)
  if (v == null) {
    const pr = document.createElement('span')
    pr.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;white-space:nowrap;pointer-events:none'
    host.appendChild(pr)                                  // 继承读数块的字体 / 字号 / tabular-nums；绝对定位不进网格，同步量完即摘
    const fs = parseFloat(getComputedStyle(pr).fontSize) || 10
    let w = 0
    for (const pat of RO_C2_PAT) for (let d = 0; d < 10; d++) { pr.textContent = pat.replace(/#/g, String(d)); w = Math.max(w, pr.getBoundingClientRect().width) }
    pr.remove()
    v = Math.ceil((w + 0.5) / fs * 1000) / 1000           // +0.5px：墨迹 / 取整的余量
    _c2.set(stack, v)
  }
  roC2.value = v
}
watch([() => uiFont.stack, roEl], measureRoC2, { flush: 'post' })   // 挂上 / 换界面字体后量（--font-ui 已由 uiFont 同步写到根上）
// 读数块 role=button 的 aria-expanded：跟 TzPicker 的 open / close 事件走（打开时顺带预填跳到时刻的框，见 onRoOpen）
const roOpen = ref(false)
const roStyle = computed(() => ({ '--ro-c1': String(roC1Em(uiFont.stack)), '--ro-c2': String(roC2.value) }))
const fwdPlaying = computed(() => clock.mode === 'play' && clock.dir > 0)
const revPlaying = computed(() => clock.mode === 'play' && clock.dir < 0)
// 倍速被步长顶住（拍率上限 240/s）时只在悬停提示里给出实际值 —— 界面不加字
const speedTitle = computed(() => clockCapped.value ? `仿真时间相对真实时间的倍数 · 实际 ×${fmtRate(clockEff.value)}` : '仿真时间相对真实时间的倍数')

// ===================== 持久化（记住分组 + 选中星） =====================
function saveSelection() {
  // 记【整个选中集】（satIdOf 键，含主选）：聚焦多颗 / 聚焦整个星座重开软件后原样回来。
  // selNorad 仍写着 —— 老版本只认它；分组 / 可见集合由 satSets 自己持久化，旧存档里的 groupKey 只在首次迁移时读一次。
  restoreSel = null   // 用户显式改选：待恢复的旧选中集作废（晚加载的集不再往里塞旧星）
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      selNorad: selEntry ? String(selEntry.noradId) : '',
      sel: selEntries.map(satIdOf).filter(Boolean),
      primary: selEntry ? satIdOf(selEntry) : ''
    }))
  } catch { /* ignore */ }
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
    nameMode: nameMode.value, countryName: countryNameSize.value, provName: provNameSize.value, cityName: cityNameSize.value,
    oceanMode: oceanNameMode.value, seaMode: seaNameMode.value, oceanName: oceanNameSize.value, seaName: seaNameSize.value, waterOff: { ...waterOff },
    chain: { on: chainOn.value, off: { ...chainOff }, style: { ...chainStyle } },
    showProvinces: showProvinces.value, showCities: showCities.value, admSel1: [...admSel1.value], admName1: admName1.value, admName2: admName2.value, borderStyle: { ...borderStyle }, labelStyle: { ...labelStyle }, spaceOn: spaceOn.value, space: { ...space }, tzMode: tzMode.value, crs: { ...mapCrs }, oceanColor: oceanColor.value, imagery: { on: imageryOn.value, k: imageryKey.value, bright: imageryBright.value }, landScheme: landScheme.value, landOverrides: { ...landOverrides }, groupColors: { ...groupColors }, viewRev: VIEW_PREFS_REV, frame: viewPrefs.frame, dragDamping: viewPrefs.dragDamping, wheelStep3d: viewPrefs.wheelStep3d, wheelStep2d: viewPrefs.wheelStep2d, live: live.value, clock: { stepSec: clock.stepSec, speed: clock.speed }, beamLock: beamLock.value, fpMode: fpMode.value, beam: beam.value, elevMin: elevMin.value, focusStyle: { ...focusStyle }, windowMin: windowMin.value,
    markStyle: { ...markStyle },
    mkPtLayer: showPtLayer.value, mkStLayer: showStLayer.value, mkTrajLayer: showTrajLayer.value,
    covOpen: covOpen.value, polyOpen: polyOpen.value,
    grdOpen: grdOpen.value, grd: grd.getState(), perf: perf.getState(),
    satcov: satcov.getState(), satPerf: satPerf.getState(),
    satcovUi: { pickSrc: satcovPickSrc.value },
    cov: {
      items: serializeCov(), cleared: covCleared.value,
      beamLabels: showBeamLabels.value, beamFont: beamLabelSize.value, beamBold: beamLabelBold.value, bore: showBore.value, boreSize: boreSize.value,
      contourLabels: showContourLabels.value, contourSize: contourLabelSize.value, contourBold: contourLabelBold.value
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
  // 老存档迁移：三个字号整组还是旧出厂值（1 / 0.6 / 0.2）的，升到新出厂值 —— 旧的二级封顶 4.4 px，
  // 那一层留着也读不出。判据是【整组精确相等】：动过任何一项都算用户自己的选择，原样保留。
  if (countryNameSize.value === OLD_NAME_SIZE.country && provNameSize.value === OLD_NAME_SIZE.prov && cityNameSize.value === OLD_NAME_SIZE.city) {
    countryNameSize.value = NAME_SIZE_DEF.country; provNameSize.value = NAME_SIZE_DEF.prov; cityNameSize.value = NAME_SIZE_DEF.city
  }
  // 地名字号下限：国家名 0.1、两级行政区 0.05。旧快照里存着更小的值，抬到各自下限 ——
  // 否则滑块拖不回去，读数与滑块位置对不上。
  if (countryNameSize.value < 0.1) countryNameSize.value = 0.1
  for (const r of [provNameSize, cityNameSize]) if (r.value < 0.05) r.value = 0.05
  // 水域两档。★ 老存档没有 oceanMode —— 那时洋名是跟着国名的档位走的，故回落到存档的 nameMode，
  //   升级前后图上一模一样；海域是新加的一层，老存档一律「不显示」入场（不平白撒 70 个名字上去）。
  const MODES = ['zh', 'en', 'off']
  if (MODES.includes(s.oceanMode)) oceanNameMode.value = s.oceanMode
  else if (MODES.includes(s.nameMode)) oceanNameMode.value = s.nameMode
  if (MODES.includes(s.seaMode)) seaNameMode.value = s.seaMode
  if (Number.isFinite(s.oceanName)) oceanNameSize.value = Math.max(0.1, s.oceanName)
  if (Number.isFinite(s.seaName)) seaNameSize.value = Math.max(0.1, s.seaName)
  if (s.waterOff && typeof s.waterOff === 'object') { for (const k of Object.keys(s.waterOff)) if (s.waterOff[k]) waterOff[k] = true }
  scene.setWaterOff({ ...waterOff })
  scene.setWaterMode({ ocean: oceanNameMode.value, sea: seaNameMode.value })
  scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value, oceanNameSize.value, seaNameSize.value)
  // 岛链（老存档没有这一段 → 保持出厂：整层不画）
  if (s.chain && typeof s.chain === 'object') {
    if (typeof s.chain.on === 'boolean') chainOn.value = s.chain.on
    if (s.chain.off && typeof s.chain.off === 'object') { for (const k of Object.keys(s.chain.off)) if (s.chain.off[k]) chainOff[k] = true }
    if (s.chain.style && typeof s.chain.style === 'object') {
      for (const k of ['color', 'dash', 'name']) if (typeof s.chain.style[k] === 'string') chainStyle[k] = s.chain.style[k]
      for (const k of ['width', 'opacity', 'nameSize']) if (Number.isFinite(s.chain.style[k])) chainStyle[k] = s.chain.style[k]
      if (typeof s.chain.style.nameBold === 'boolean') chainStyle.nameBold = s.chain.style.nameBold
    }
  }
  scene.setChains({ on: chainOn.value, off: { ...chainOff }, ...chainStyle })
  if (s.borderStyle && typeof s.borderStyle === 'object') Object.assign(borderStyle, s.borderStyle)
  // 线粗下限 2026-08-22 起全库统一到 0.1（市界那档原为 0.05，是唯一一处收紧的）。旧快照里存着
  // 0.05 这类低于新下限的值时，滑杆会显示成 0.1 而实际仍按 0.05 画——读数与画面对不上，且滑一下
  // 就再也回不去。恢复时就地夹进新区间，让两者始终一致。
  for (const k of Object.keys(borderStyle)) {
    if (/Width$/.test(k) && Number.isFinite(borderStyle[k])) borderStyle[k] = Math.min(8, Math.max(0.1, borderStyle[k]))
  }
  // 旧快照只有 nat*（国界+海岸合成一条）：把它落到国界那一组，海岸沿用出厂值 —— 两者已分家。
  if (s.borderStyle && s.borderStyle.natColor != null && s.borderStyle.admin0Color == null) {
    borderStyle.admin0Color = s.borderStyle.natColor
    if (Number.isFinite(s.borderStyle.natWidth)) borderStyle.admin0Width = Math.min(8, Math.max(0.1, s.borderStyle.natWidth))
    if (Number.isFinite(s.borderStyle.natOpacity)) borderStyle.admin0Opacity = s.borderStyle.natOpacity
  }
  for (const k of ['natColor', 'natWidth', 'natOpacity']) delete borderStyle[k]
  // 一次性默认升级：2026-08-27 之前那套出厂样式（政治六类同色 #a8a8a8、海岸线 #8fa6b8 且最粗、
  // 主张线走虚线）在实机上是「谁也不比谁重要 + 十段线打成一串麻点」。逐组比对：某一组【原样没动过】
  // 就换成新出厂值，动过的那组一个字段都不碰 —— 用户调过的样式不能被静默改掉。
  for (const [part, fields] of Object.entries(BORDER_PARTS)) {
    // ★ 必须有字段真的对上：经纬网这一组在历代出厂表里根本没有（新加的），
    //   只判「没定义就算过」的话它每次恢复都会被判成陈旧、把用户改过的网格样式抹掉。
    const stale = BORDER_DEF_GENS.some((gen) => fields.some((f) => gen[f] !== undefined) &&
      fields.every((f) => gen[f] === undefined || eqStyle(borderStyle[f], gen[f])))
    if (stale) for (const f of fields) borderStyle[f] = BORDER_DEF[f]
  }
  applyBorderStyle()
  if (s.labelStyle && typeof s.labelStyle === 'object') Object.assign(labelStyle, s.labelStyle)
  // 老存档迁移：地名配色整组还是旧出厂值的，升到新出厂值（同上，整组相等才动）
  if (Object.keys(OLD_LABEL_DEF).every((f) => labelStyle[f] === OLD_LABEL_DEF[f])) Object.assign(labelStyle, LABEL_DEF)
  applyLabelStyle()
  // 大海颜色：恢复已存值。一次性默认升级——旧默认 #2a85c4（从未手动改过海色的旧快照）自动升到新的
  // 淡蓝默认 #a3ccff，让老用户更新后即用新默认海色；想要旧蓝再点回该色块即可。
  if (typeof s.oceanColor === 'string') setOceanColor(s.oceanColor === '#2a85c4' ? '#a3ccff' : s.oceanColor)
  // 地球影像的档位 / 亮度（开关归宇宙空间，老存档的 imagery.on 由下面 spaceFromSaved 迁移；上屏在挂载处的 applySpaceStyle）
  if (s.imagery && typeof s.imagery === 'object') {
    imageryKey.value = imagerySource(s.imagery.k).k          // 存档里的源没了（换版本）→ 落回第一个，不留空
    if (Number.isFinite(Number(s.imagery.bright))) imageryBright.value = Math.max(0.05, Math.min(2, Number(s.imagery.bright)))
  }
  // 大地颜色：基调 + 逐国覆盖。默认态（LAND_DEFAULT 且无覆盖）不触发陆地重建，避免启动白做一次
  // 一次性默认升级：旧默认米黄 #e8e0c9（从未手动改过大地色的旧快照）自动升到新的米绿 #e4eccf，与海色同一手法
  if (s.landScheme === 'morandi' || (typeof s.landScheme === 'string' && HEX6.test(s.landScheme))) landScheme.value = s.landScheme === '#e8e0c9' ? LAND_DEFAULT : s.landScheme
  // 逐国大地颜色：老存档的键是 ISO 数字码（'156'），换成主权解算层后是 ISO3（'CHN'）→ 过一遍迁移
  if (s.landOverrides && typeof s.landOverrides === 'object') {
    for (const [k, v] of Object.entries(migrateLandOverrides(s.landOverrides))) landOverrides[k] = v
  }
  if (landScheme.value !== LAND_DEFAULT || Object.keys(landOverrides).length) applyLandColors(true)
  // 在轨现实星座分组配色（renderHasColor 由随后 loadGroup→rebuildRenderSet 一并算入）
  if (s.groupColors && typeof s.groupColors === 'object') {
    for (const [k, v] of Object.entries(s.groupColors)) if (groupColorable(k) && typeof v === 'string' && HEX6.test(v)) groupColors[k] = v.toLowerCase()
  }
  // 标记层样式：老存档把尺寸/显隐散成一堆 mk* 键，先按其迁移；新的 markStyle 对象随后覆盖
  if (Number.isFinite(s.mkPt)) markStyle.ptFont = s.mkPt
  if (Number.isFinite(s.mkPtDot)) markStyle.ptDot = s.mkPtDot
  if (Number.isFinite(s.mkPtIdx)) markStyle.ptIdx = s.mkPtIdx
  if (Number.isFinite(s.mkStIcon)) markStyle.stIcon = s.mkStIcon
  if (Number.isFinite(s.mkStFont)) markStyle.stFont = s.mkStFont
  // 圆点大小口径换过一次：老的 mkTrajDot 是半径系数（可见直径 = 值 × 18/32 × 2.5），新的 mkTrajDotPx
  // 直接就是直径。老存档按同一条换算折过来，屏上大小不变。
  if (Number.isFinite(s.mkTrajDotPx)) markStyle.tjDot = s.mkTrajDotPx
  else if (Number.isFinite(s.mkTrajDot)) markStyle.tjDot = Math.max(1, Math.min(60, Math.round(s.mkTrajDot * (18 / 32) * 2.5)))
  if (Number.isFinite(s.mkTrajIcon)) markStyle.tjIconPx = s.mkTrajIcon
  if (typeof s.mkPtShow === 'boolean') markStyle.ptLabelOn = s.mkPtShow
  if (typeof s.mkPtIdxShow === 'boolean') markStyle.ptIdxOn = s.mkPtIdxShow
  if (typeof s.mkStShow === 'boolean') markStyle.stLabelOn = s.mkStShow
  if (typeof s.mkTrajIconShow === 'boolean') markStyle.tjIconOn = s.mkTrajIconShow
  // 逐字段按类型合并（旧存档没这一项时全留出厂值 / 迁移值）
  if (s.markStyle && typeof s.markStyle === 'object') {
    for (const [k, v] of Object.entries(s.markStyle)) {
      const d = MARK_STYLE_DEF[k]
      if (d === undefined) continue
      if (typeof d === 'boolean') { if (typeof v === 'boolean') markStyle[k] = v }
      else if (typeof d === 'number') { if (Number.isFinite(v)) markStyle[k] = v }
      else if (typeof v === 'string' && v) markStyle[k] = v
    }
  }
  if (typeof s.mkPtLayer === 'boolean') showPtLayer.value = s.mkPtLayer
  if (typeof s.mkStLayer === 'boolean') showStLayer.value = s.mkStLayer
  if (typeof s.mkTrajLayer === 'boolean') showTrajLayer.value = s.mkTrajLayer
  syncMarkers()   // 以恢复后的尺寸重建标记（含坐标/名称显隐、各图层显隐）
  // 基础视图偏好：参考系只认两个枚举串，三个数各自钳到范围。老存档里残留的 autoRotate / autoRotateSpeed
  // 一律忽略 —— 那是【展示性】匀速旋转的开关，"开着" ≠ "想看惯性视角"，不迁移、不映射。
  // ★ 出厂档从「相机跟随」改成「惯性视角」那次：viewRev 比当前小的存档，里面的 frame 不认（那是旧
  //   出厂值顺手存下来的，不是用户挑的），按新出厂值入场；存过一次后就跟用户的选择走。
  if (s.viewRev >= VIEW_PREFS_REV && FRAME_MODES.includes(s.frame)) viewPrefs.frame = s.frame
  for (const k of ['dragDamping', 'wheelStep3d', 'wheelStep2d']) {
    const r = VIEW_PREF_RANGE[k]
    if (Number.isFinite(s[k])) viewPrefs[k] = Math.max(r.min, Math.min(r.max, Math.round(s[k])))
  }
  // 聚焦卫星显示样式：逐字段按类型合并（旧存档没这一项时全留出厂值），随后一次性推给两个渲染器
  if (s.focusStyle && typeof s.focusStyle === 'object') {
    for (const [k, v] of Object.entries(s.focusStyle)) {
      const d = FOCUS_STYLE_DEF[k]
      if (d === undefined) continue
      if (typeof d === 'boolean') { if (typeof v === 'boolean') focusStyle[k] = v }
      else if (typeof d === 'number') { if (Number.isFinite(v)) focusStyle[k] = v }
      else if (typeof v === 'string') focusStyle[k] = v
    }
    focusStyle.trkPeriods = Number(focusStyle.trkPeriods) > 0 ? Number(focusStyle.trkPeriods) : 1
    focusStyle.trkSpanMin = Number(focusStyle.trkSpanMin) > 0 ? Number(focusStyle.trkSpanMin) : 0
    if (focusStyle.trkSpanMode !== 'time') focusStyle.trkSpanMode = 'rev'   // 长度口径只认这两档
    if (focusStyle.trkMode !== 'swath') focusStyle.trkMode = 'line'         // 轨迹形式只认这两档
    // 区域填充早先是「布尔开关 + 固定浓度」，现改为一根透明度滑杆（0＝不填）：老存档显式关过就归 0
    if (s.focusStyle.fpFill === false) focusStyle.fpFillOpacity = 0
  }
  applyFocusGeom()
  if (typeof s.beamLock === 'boolean') beamLock.value = s.beamLock
  if (s.fpMode === 'elev') fpMode.value = 'elev'
  if (typeof s.beam === 'string') beam.value = s.beam
  if (typeof s.elevMin === 'string') elevMin.value = s.elevMin
  if (Number.isFinite(s.windowMin)) { windowMin.value = clamp(Math.round(s.windowMin), WIN_MIN, WIN_MAX); winStartMin.value = -PAST_FRAC * windowMin.value }
  if (typeof s.polyOpen === 'boolean') polyOpen.value = s.polyOpen
  // 省界/市界开关：默认开，存档里的显式 false 也要恢复；数据加载统一走挂载尾部的 ensureProvinces/ensureCities
  if (typeof s.showProvinces === 'boolean') showProvinces.value = s.showProvinces
  if (typeof s.showCities === 'boolean') showCities.value = s.showCities
  if (Array.isArray(s.admSel1)) admSel1.value = s.admSel1.filter((x) => typeof x === 'string')
  for (const [k, r] of [['admName1', admName1], ['admName2', admName2]]) if (s[k] === 'local' || s[k] === 'en' || s[k] === 'off') r.value = s[k]
  if (s.tzMode != null) tzMode.value = normTzMode(s.tzMode, tzMode.value)   // 时间轴读数时区档位（仅显示；可为固定偏移分钟数）
  if (s.crs && typeof s.crs === 'object') { setMapCrs(s.crs); crsCenterShown.value = lon0ToCenter(mapCrs.lon0) }   // 坐标系四档（只改呈现，见 stores/mapCrs）
  // 宇宙空间：新存档 spaceOn + space；老存档只有晨昏线那四个字段 → 迁移（旧 termOn=true 只开晨昏效果 / 晨昏线、
  // 星空 / 大气 / 太阳 / 地球影像不勾，别让老用户画面突变；旧 termOn=false 总开关关、子项按新出厂值）。口径见 spaceFromSaved
  { const sp = spaceFromSaved(s); if (sp) { spaceOn.value = sp.on; Object.assign(space, sp.space) } }
  clockRestore(s.clock)   // 步长/速率（播放态刻意不恢复：一开软件就自己跑起来会冲掉「上次看到哪」）
  if (s.live) goLive()
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
    beamLabelBold.value = c.beamBold === true
    showBore.value = c.bore !== false
    if (Number.isFinite(c.boreSize)) boreSize.value = c.boreSize
    showContourLabels.value = !!c.contourLabels
    if (Number.isFinite(c.contourSize)) contourLabelSize.value = c.contourSize
    contourLabelBold.value = c.contourBold === true
    // 上次「清除绘制」后退出 → 恢复卫星列表但保持空白（不复现覆盖），直到用户显式重绘
    if (c.cleared) covCleared.value = true
    else redraw()
  } else if (s.covOpen) { covOpen.value = true; await ensureCovIndex() }
  // 覆盖图（GRD）状态恢复：只要有保存的 GRD 状态就载入索引并恢复卫星树（含自定义/星座星）+
  // 天线设置 + 仰角线属性，使仰角线即便面板关闭也照常画在地图上；面板仅在上次开启时才展开。
  if (s.perf) perf.restoreState(s.perf)
  if (s.satPerf) satPerf.restoreState(s.satPerf)
  if (grdApiOk && s.grd) {
    await grd.loadIndex(false)
    await grd.restoreState(s.grd)
    if (s.grdOpen) grdOpen.value = true
    // 对星壳层状态在 grd 树恢复【之后】才能还原（restoreState 里要 ensureAntLoaded 那些天线）
    if (s.satcov) await satcov.restoreState(s.satcov)
    // 对星覆盖分析的页面级 UI：壳层挑选器的数据源、性能指标表浮窗。
    // 表只在【上次就停在这个视图】时才跟着回来——切走视图本就会关表（见 sideCtx 的 watch），
    // 在别的视图下把它弹出来既碍事、又要为一张看不见的表跑一遍取值。
    // 判据同样走 sideCtx：上次是「停在对星视图但把侧栏收起来了」的话，表照样跟着回来。
    if (s.satcovUi) {
      if (s.satcovUi.pickSrc === 'live' || s.satcovUi.pickSrc === 'all') satcovPickSrc.value = s.satcovUi.pickSrc
    }
    redrawSats()
    // 恢复链路把各天线 cache 的星位（meta）建在【存盘位置】上；星历缓存若抢先完成了第一次
    // refreshPositions（ingest 比逐文件读 GRD 快是常态），那一拍修正的 meta 已被这里的重建覆盖，
    // 而默认暂停态之后再无拍来修 —— 视轴/壳层/覆盖停在旧星位（「第一帧不对，播放一下就好」）。
    // 补一拍对齐；星历还没好时走空集早退，等 ingest 的那拍来修 —— 两种完成顺序都闭合。
    refreshPositions()
  } else if (s.grdOpen && grdApiOk) {
    grdOpen.value = true
    await grd.loadIndex(false)
    redrawSats()
  }
}

// ===================== 导入星历（TLE / OMM CSV）=====================
// 「文件」菜单「导入星历文件」：与「文件管理 · 星历」的「导入星历」同一持久化通路——原生选文件 →
// 主进程 customSats.importFile 按内容识别六种官方格式（OMM 的 CSV/JSON/KVN/XML 与 TLE/3LE）、校验去重后
// 落库 custom.json（每文件一组）。这样导入的星历既进「自定义卫星」分组与搜索池，也能在文件管理里
// 查看/改名/导出/删除。（旧路径只临时 ingest 到场景不落库，故文件管理看不到，且只认 OMM CSV；已修复。）
async function importTleToLibrary() {
  if (!apiOk || !window.api.omm.customImport) { status.value = '需在桌面客户端中运行'; return }
  let r
  try { r = await window.api.omm.customImport() } catch (e) { status.value = '导入失败：' + ((e && e.message) || e); return }
  if (!r || r.canceled) return
  if (!r.ok) { status.value = '导入失败：' + (r.error || '未知错误'); return }
  afterImport(r)
}
// 导入完成后的共同收尾（原生对话框与拖放两条路共用）：日志一行汇总 + 切到「自定义卫星」分组 + 刷新各处。
function afterImport(r) {
  const parts = []
  if (r.groups) parts.push(`${r.groups} 组 / ${r.sats} 颗`)
  if (r.replaced) parts.push(`替换 ${r.replaced}`)
  if (r.invalid) parts.push(`无效 ${r.invalid}`)
  if (r.ephem) parts.push(`星历 ${r.ephem}`)
  const errs = (r.errors || []).filter(Boolean)
  logMsg(`导入星历：${parts.length ? parts.join(' · ') : '无变化'}${errs.length ? `；${errs.length} 条失败：${errs[0]}` : ''}`, errs.length ? 'warn' : 'info')
  // 新导入的组直接进表并打开；已有组被替换则重解
  const before = new Set(importGroups.value.map((g) => g.id))
  invalidateEphTables(); impEntries.clear()
  refreshCustomImportCount().then(() => {
    registerSets()
    for (const g of importGroups.value) if (!before.has(g.id)) satSets.visible.value.add('i:' + g.id)
    satSets.setVisible([...satSets.visible.value])
    if (satSets.solo.value) satSets.solo.value = null
    applySetsChanged()
  })
  bumpCustomSats()
}

/* ===================== 星座栏「导入星历」区块 ===================== */
// 组内名单（展开箭头用）：gp 组读 OMM 记录，点序列组读采样表的元数据。
async function impSatList(gid) {
  const g = importGroups.value.find((x) => x.id === gid)
  if (!g) return []
  if (g.kind === 'ephem') {
    // 行 id 必须是 NORAD：剔除集（satSets.hide）、加入 / 存为卫星组（useSatGroups 按 NORAD 存成员）、
    // 聚焦（expResolve 按 NORAD 匹配）三处全按它对账，换成 key 会让卫星组存进一批查不到的死号，
    // 进而被 reconcile 判成「已离轨」自动移除。点序列星的合成 NORAD 由主进程无条件发放
    // （customSats.importEphem 的 String(base + i)），这里的 || s.key 只是坏数据兜底。
    return (g.sats || []).map((s) => expMkItem(s.noradId || s.key, s.name,
      `${s.name} · ${s.n} 点 · ${impDay(s.t0)} → ${impDay(s.t1)} · ${s.frame}`, '', null))
  }
  const recs = (apiOk && window.api.omm.customGroupRecords) ? await window.api.omm.customGroupRecords(gid) : []
  return (recs || []).map((r) => expMkItem(r.noradId, r.name, `${r.name} · NORAD ${r.noradId}`, '', slotByNorad(r.noradId)))
}
const impDelId = ref('')          // 两次点击确认删除（与卫星组同手感）
const impRenameId = ref('')
const impRenameVal = ref('')
const impDragOver = ref(false)
// 行读数：gp 组「N 颗 · 格式 · 历元日期」，点序列组「N 颗 · 星历 · 起 → 止」
const impDay = (ms) => { if (!Number.isFinite(ms)) return '—'; const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` }
function impRead(g) {
  const n = `${g.count} 颗`
  if (g.kind === 'ephem') return `${n} · 星历 · ${impDay(g.t0)} → ${impDay(g.t1)}`
  return `${n} · ${g.formatLabel || g.format || '—'} · ${g.importedAt ? impDay(Date.parse(g.importedAt)) : '—'}`
}
const impTitle = (g) => (g.kind === 'ephem'
  ? `${g.name}｜时间标签位置序列，按插值取位，不做轨道外推｜${g.formatLabel || g.format}｜${g.count} 颗｜${impDay(g.t0)} → ${impDay(g.t1)}`
  : `${g.name}｜平均根数，走 SGP4｜${g.formatLabel || g.format}｜${g.count} 颗`)
async function impRefreshAndRedraw(gid) {
  invalidateEphTables(gid); if (gid) impEntries.delete(gid); else impEntries.clear()
  await refreshCustomImportCount()
  registerSets(); applySetsChanged()
}
async function impSetColor(g, hex) {
  if (!HEX6.test(hex) || !apiOk || !window.api.omm.customUpdateGroup) return
  try { await window.api.omm.customUpdateGroup(g.id, { color: hex.toLowerCase() }) } catch { return }
  await impRefreshAndRedraw()
}
async function impResetColor(g) {
  if (!apiOk || !window.api.omm.customUpdateGroup) return
  try { await window.api.omm.customUpdateGroup(g.id, { color: '' }) } catch { return }
  await impRefreshAndRedraw()
}
function impEnterRename(g) { impDelId.value = ''; impRenameId.value = g.id; impRenameVal.value = g.name }
async function impCommitRename(g) {
  const nm = String(impRenameVal.value || '').trim()
  impRenameId.value = ''
  if (!nm || nm === g.name) return
  try { await window.api.omm.customRename(g.id, nm) } catch (e) { status.value = '改名失败：' + ((e && e.message) || e); return }
  await impRefreshAndRedraw()
}
async function impDelete(g) {
  try { await window.api.omm.customRemove(g.id) } catch (e) { status.value = '删除失败：' + ((e && e.message) || e); return }
  invalidateEphTables(g.id)
  await impRefreshAndRedraw(g.id)
  bumpCustomSats()
}
async function impExport(g) {
  if (!apiOk || !window.api.omm.customExportGroup) return
  const fmt = g.kind === 'ephem' ? (g.format === 'sp3' ? 'stk-e' : g.format) : g.format
  try {
    const r = await window.api.omm.customExportGroup(g.id, g.name, fmt)
    if (r && r.ok) logMsg(`导出「${g.name}」：${r.filePath}`)
    else if (r && !r.canceled) status.value = '导出失败：' + (r.error || '未知错误')
  } catch (e) { status.value = '导出失败：' + ((e && e.message) || e) }
}
// —— 拖放导入：文本由渲染端读好再传，不依赖 Electron 版本的 File.path ——
// 模型库卡片拖进来（application/x-satsim-model，DESIGN3 E11）另走一支：命中地球站 / 点标记 / 载具头 / 卫星才收，悬停高亮、松手挂模型；
// 文件拖入的描边（impDragOver）不亮。命中不受「调整位置」门控（entityAtScreen）
function impDragEnter(e) { if (mdlHas(e)) { mdlDragOverAt(e); return } if (impHasFiles(e)) { impDragOver.value = true; e.preventDefault() } }
function impDragOverH(e) { if (mdlHas(e)) { mdlDragOverAt(e); return } if (impHasFiles(e)) { impDragOver.value = true; e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy' } }
function impDragLeave(e) {
  if (mdlHas(e)) {
    // 在 .stage-wrap 的子元素之间穿行也会报 dragleave：离开 stage-wrap 本身才清
    const cur = e.currentTarget, rt = e.relatedTarget
    if (cur && rt && cur.contains && cur.contains(rt)) return
    if (cur && cur.getBoundingClientRect) { const r = cur.getBoundingClientRect(); if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return }
    mdlDragClear()
    return
  }
  impDragOver.value = false
}
const impHasFiles = (e) => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0)
async function onImpDrop(e) {
  impDragOver.value = false
  if (mdlHas(e)) { onModelDrop(e); return }
  if (!impHasFiles(e)) return
  e.preventDefault(); e.stopPropagation()
  if (!apiOk || !window.api.omm.customImportText) { status.value = '需在桌面客户端中运行'; return }
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
  if (!files.length) return
  const MAX = 64 * 1024 * 1024
  const payload = []
  for (const f of files) {
    if (f.size > MAX) { status.value = `${f.name} 超过 64 MB，未导入`; continue }
    try { payload.push({ name: f.name, text: await f.text() }) }
    catch (err) { status.value = `${f.name} 读取失败：${(err && err.message) || err}` }
  }
  if (!payload.length) return
  try {
    const r = await window.api.omm.customImportText(payload)
    if (r && r.ok) afterImport(r)
    else status.value = '导入失败：' + ((r && r.error) || '未知错误')
  } catch (err) { status.value = '导入失败：' + ((err && err.message) || err) }
}

// ---- 拖模型挂到实体上（DESIGN3 E11）：源 = 「卫星模型」侧栏库卡片；目标 = 地球站 / 点标记 / 航迹载具头 / 卫星（仅 3D） ----
const MDL_TYPE = 'application/x-satsim-model'
const mdlHas = (e) => !!(e && e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(MDL_TYPE))
const ENT_KINDS_DROP = ['station', 'point', 'vehicle', 'sat']
// 当前视图下压着哪个实体（不受「调整位置」门控）：{kind, id, …} | {kind:'sat', idx, …} | null；2D 没有卫星拾取
function entHitAt(x, y, kinds) {
  // 落点必须在当前视图的画布内：拾取按 NDC 算、不做视锥 / 屏外判定，右侧信息栏（也接拖放）上的坐标会擦中画布外看不见的星 / 站
  const cv = flatView.value ? flatCanvas.value : el.value
  const b = cv && cv.getBoundingClientRect()
  if (!b || x < b.left || x >= b.right || y < b.top || y >= b.bottom) return null
  const k = kinds || ENT_KINDS_DROP
  if (flatView.value) return flat && flat.entityAtScreen ? flat.entityAtScreen(x, y, k) : null
  return scene && scene.entityAtScreen ? scene.entityAtScreen(x, y, k) : null
}
const sameHit = (a, b) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.id === b.id && a.idx === b.idx)
let _mdlXY = '', _mdlColor = '', _mdlFlashT = 0
function mdlAccent() {
  if (!_mdlColor) { try { _mdlColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-ui').trim() } catch { _mdlColor = '' } }
  return _mdlColor || '#4da3ff'
}
// 高亮环只给当前视图那个渲染器（另一个清掉）；每次命中都重给一遍 —— 运动档载具拖着拖着会走，环要跟上
function mdlHighlight(h) {
  const o = { color: mdlAccent() }
  if (scene && scene.setDropHighlight) scene.setDropHighlight(flatView.value ? null : h, o)
  if (flat && flat.setDropHighlight) flat.setDropHighlight(flatView.value ? h : null, o)
}
// dragenter / dragover：始终接住（dragenter 不接的话后续 dragover 可能改投 body），能不能放由 dropEffect 定 ——
// 压着实体 = copy（高亮环），空白处 = none（光标显示禁止放下、松手不触发 drop）。
// dragover 在指针不动时也连发：坐标没变就沿用上一次的命中（每个新坐标至多测一次，dragover 的节奏本就不超过一帧一次）
function mdlDragOverAt(e) {
  e.preventDefault()
  // 上一次落点的反馈环还亮着（650 ms 内又拖起一张）：先收掉 —— 否则拖到空白处时命中没变（都是空），环一直钉在上一个实体上
  if (_mdlFlashT) { clearTimeout(_mdlFlashT); _mdlFlashT = 0; _mdlXY = ''; mdlHighlight(null) }
  _mdlColor = _mdlXY ? _mdlColor : ''   // 一次拖动开头重读机位色（主题可能切过）
  const k = e.clientX + ',' + e.clientY
  let h = mdlDragHit.value
  if (k !== _mdlXY) {
    _mdlXY = k
    h = entHitAt(e.clientX, e.clientY, ENT_KINDS_DROP)
    if (h || !sameHit(h, mdlDragHit.value)) mdlHighlight(h)
    mdlDragHit.value = h
  }
  if (e.dataTransfer) e.dataTransfer.dropEffect = h ? 'copy' : 'none'
}
function mdlDragClear() {
  _mdlXY = ''
  if (mdlDragHit.value) mdlDragHit.value = null
  mdlHighlight(null)
}
// 拖动在别处结束（落在侧栏 / Esc 取消）：收掉悬停高亮；落点反馈闪烁中不打断
function mdlDragEndAny() { if (!_mdlFlashT && (_mdlXY || mdlDragHit.value)) mdlDragClear() }
function onModelDrop(e) {
  e.preventDefault(); e.stopPropagation()
  let p = null
  try { p = JSON.parse(e.dataTransfer.getData(MDL_TYPE)) } catch { p = null }
  const h = entHitAt(e.clientX, e.clientY, ENT_KINDS_DROP)
  _mdlXY = ''; mdlDragHit.value = null
  if (!p || !parseModelId(p.id) || !h || !applyModelDrop(h, p.id)) { mdlHighlight(null); return }
  mdlFlash(h)
}
// 落点反馈：环在落点上再亮一会儿（650 ms）再收
function mdlFlash(h) {
  mdlHighlight(h)
  clearTimeout(_mdlFlashT)
  _mdlFlashT = setTimeout(() => { _mdlFlashT = 0; if (!mdlDragHit.value) mdlHighlight(null) }, 650)
}
function entTargetName(h) {
  if (!h) return ''
  if (h.kind === 'sat') { const e = renderEntries[h.idx]; return e ? displaySatName(e.name) : '' }
  const o = entObjOf(h.kind, h.id)
  if (!o) return ''
  if (h.kind === 'point') return byLang('点标记 ', 'Point ') + (points.value.indexOf(o) + 1)
  return o.name || ''
}
/** 按命中类型落绑定：站 / 点 / 载具写内联字段，卫星写 bindings（未聚焦的星绑后加入聚焦集） */
function applyModelDrop(h, id) {
  if (!h || !parseModelId(id)) return false
  let ok = false
  if (h.kind === 'station' || h.kind === 'point') ok = setEntityModel(h.kind, h.id, id)
  else if (h.kind === 'vehicle') ok = setEntityModel('traj', h.id, id)
  else if (h.kind === 'sat') { const en = Number.isInteger(h.idx) ? renderEntries[h.idx] : null; if (en) { bindModel(id, en); ok = true } }
  if (ok) logMsg(`${entTargetName(h)}：${mdlName(id)}`)
  return ok
}

// ---- 标记侧栏：「模型」小块 / 模型选择弹层 / 站「跟踪」/ 航迹运动行 ----
const CHIP_ICON = { ground: 'satellite-dish', aircraft: 'plane', ship: 'ship', vehicle: 'car' }
function mdlName(id) { const m = id ? modelLib.value.byId.get(id) : null; return m ? modelNameOf(m) : (id || '') }
function mdlThumb(id) { if (!id) return ''; const u = mdlThumbs.value.get(id); if (!u) mdlRequestThumb(id); return u || '' }
function chipIcon(o) { const m = o && o.model ? modelLib.value.byId.get(o.model.id) : null; return (m && CHIP_ICON[m.kind]) || 'box' }
function chipTitle(o) {
  if (!o || !o.model) return byLang('挂模型（也可从「卫星模型」侧栏拖一张卡片到图上的实体）', 'Attach a model (or drag a card from the Satellite Models panel onto the map)')
  return mdlName(o.model.id) + '\n' + byLang('点击更换；右键清除', 'Click to change; right-click to clear')
}
const pickDomainOf = (kind, o) => (kind === 'station' ? 'ground' : kind === 'traj' ? (o && o.kind === 'flight' ? 'aircraft' : 'ship') : '')
function openPickPop(ev, kind, o) {
  const el = ev && ev.currentTarget
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null
  const anchor = r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: ev ? ev.clientX : 0, y: ev ? ev.clientY : 0, w: 0, h: 0 }
  pickPop.value = { kind, id: o.id, anchor, domain: pickDomainOf(kind, o) }
}
const pickPopObj = computed(() => { const p = pickPop.value; return p ? entObjOf(p.kind, p.id) : null })
// 站「跟踪」下拉：主选星（缺字段）/ 聚焦集各星 / 已选定但不在聚焦集的那颗（保留显示，免得下拉里看不到当前值）
function satNameOfKey(key) {
  const m = /^norad:(\d+)$/.exec(key || '')
  const e = m ? satEntryById('n:' + m[1]) : renderEntries.find((x) => satKeyOf(x) === key)
  return e ? displaySatName(e.name) : key
}
function trackOpts(s) {
  const out = [], seen = new Set()
  for (const r of selList.value) {
    const e = selEntries[r.idx], k = e && satKeyOf(e)
    if (!k || seen.has(k)) continue
    seen.add(k); out.push({ key: k, name: displaySatName(e.name) })
  }
  const cur = s.track && s.track.satKey
  if (cur && !seen.has(cur)) out.push({ key: cur, name: satNameOfKey(cur) })
  return out
}
const vFocus = { mounted: (el) => el.focus() }   // 展开即可输入
// 跟踪目标选择：点当前值展开检索框。空词 = 主选星 + 聚焦集各星；有词 = 全量池检索（satcovSearch，与目标星搜索同款防抖 + 序号守卫）
const trkOpenId = ref('')
const trkQ = ref('')
const trkCand = ref([])
const trkTotal = ref(0)
const trkBusy = ref(false)
let trkSeq = 0, trkTimer = null
watch(trkQ, (v) => {
  const q = String(v || '').trim()
  if (trkTimer) { clearTimeout(trkTimer); trkTimer = null }
  trkSeq++
  if (!q) { trkCand.value = []; trkTotal.value = 0; trkBusy.value = false; return }
  trkBusy.value = true
  trkTimer = setTimeout(async () => {
    const seq = trkSeq
    let r = { items: [], total: 0 }
    try { r = (await satcovSearch(q, 60)) || { items: [], total: 0 } } catch { r = { items: [], total: 0 } }
    if (seq !== trkSeq) return
    trkCand.value = r.items || []; trkTotal.value = r.total || 0; trkBusy.value = false
  }, 200)
})
function trkToggle(s) { trkQ.value = ''; trkOpenId.value = trkOpenId.value === s.id ? '' : s.id }
function trkClose() { trkQ.value = ''; trkOpenId.value = '' }
function trkName(s) { const k = s.track && s.track.satKey; return k ? satNameOfKey(k) : '主选星' }
// 检索结果 → satKey：有 NORAD 走 norad:；无号的（自定义星座合成星）按名找到条目取它自己的键
function trkPickItem(s, it) {
  const e = satEntryById(it.noradId ? 'n:' + it.noradId : 'm:' + it.name)
  const k = e ? satKeyOf(e) : (it.noradId ? 'norad:' + it.noradId : '')
  if (k) pickTrack(s, k)
}
function pickTrack(s, k) {
  const el = !!(s.track && s.track.el), az = !!(s.track && s.track.az)
  trkClose()
  setStationTrack(s.id, k && isValidSatKey(k) ? { kind: 'sat', satKey: k, el, az } : null)
}
function setTrackElOn(s, on) { if (s.track && s.track.satKey) setStationTrack(s.id, { ...s.track, el: !!on }) }
function setTrackAzOn(s, on) { if (s.track && s.track.satKey) setStationTrack(s.id, { ...s.track, az: !!on }) }
function stReadTxt(id) {
  const r = entRead.value.get(id)
  if (!r || r.park || !Number.isFinite(r.az) || !Number.isFinite(r.el)) return '—'
  return r.az.toFixed(1) + '° · ' + r.el.toFixed(1) + '°'
}
function stReadTitle(id) {
  const r = entRead.value.get(id), nm = r && r.key ? satNameOfKey(r.key) : ''
  return byLang('方位 · 仰角（WGS-84）', 'Azimuth · elevation (WGS-84)') + (nm ? '\n' + nm : '')
}
// 跟踪读数逐拍变：单独成组件（组件根节点继承本页 scoped 属性，.u 样式照旧），页面模板不读 entRead
const StReadTxt = defineComponent({ props: { id: { type: [String, Number], required: true } }, setup: (p) => () => hVnode('span', { class: 'u', title: stReadTitle(p.id) }, stReadTxt(p.id)) })
// 航迹运动行：折叠态摘要（FL350 · 850 km/h · 08:00；静止档 —）+ 展开三行（巡航高度 / 速度 / 起始）+ 运动档读数
const motOpen = ref(new Set())   // 展开着的航迹 id（界面状态，不持久化）
function toggleMot(id) { const s = new Set(motOpen.value); if (s.has(id)) s.delete(id); else s.add(id); motOpen.value = s }
const pad2 = (n) => String(n).padStart(2, '0')
function fmtFL(m) { const fl = m / 0.3048 / 100; return Math.abs(fl - Math.round(fl)) < 0.05 ? 'FL' + String(Math.round(fl)).padStart(3, '0') : Math.round(m) + ' m' }
function motSummary(t) {
  const raw = toRaw(t)
  if (!trajMoving(raw)) return '—'
  // 出发时刻取排程（航点定了时刻时首航点可由外推得出，t0Ms 未必有）；航点定了时刻 = 逐段变速，报全程均速
  const t0 = trajStartMs(raw), p = tzParts(t0, tzMode.value), out = []
  const pinned = (t.pts || []).some((q) => q && Number.isFinite(q.tMs))
  if (t.kind === 'flight') out.push(fmtFL(Number.isFinite(t.cruiseAltM) ? t.cruiseAltM : CRUISE_ALT_M_DEFAULT))
  if (!pinned && Number.isFinite(t.speedKmh)) out.push(String(Number(t.speedKmh.toPrecision(6))) + ' km/h')
  else { const dt = trajEndMs(raw) - t0; if (dt > 0) out.push(byLang('均速 ', 'avg ') + String(Number((trajLengthM(raw) / dt * 3600).toPrecision(4))) + ' km/h') }
  out.push(pad2(p.h) + ':' + pad2(p.mi))
  return out.join(' · ')
}
function vehReadTxt(t) {
  const r = vehRead.value.get(t.id)
  if (!r || !r.moving) return ''
  const km = (v) => (v >= 100 ? v.toFixed(0) : v.toFixed(1))
  const d = km(r.sKm) + ' / ' + km(r.totalKm) + ' km'
  return t.kind === 'flight' ? byLang('高度 ', 'Alt ') + Math.round(r.altM) + ' m · ' + d : d
}
// 只渲染一段文本：逐拍重渲染的只是它自己
const VehReadTxt = defineComponent({ props: { t: { type: Object, required: true } }, setup: (p) => () => vehReadTxt(p.t) })
// 起始时刻文本框：草稿串 + 失焦 / 回车落值 + Esc 撤回（页面每秒重渲染，:value 直绑对象会吞输入 —— 聚焦期间显示草稿）。
// 显示按显示时区；输入不带时区按显示时区读，带 Z / ±hh:mm 按所写时区；清空 = 删字段；非法 = 回到原值
const t0Edit = ref({ id: '', text: '' })
function fmtT0(ms) {
  if (!Number.isFinite(ms)) return ''
  const p = tzParts(ms, tzMode.value)
  return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}:${pad2(p.s)}`
}
function t0Begin(t) { if (t0Edit.value.id !== t.id) t0Edit.value = { id: t.id, text: fmtT0(t.t0Ms) } }
function t0Input(t, v) { t0Edit.value = { id: t.id, text: v } }
function t0Commit(t) {
  const ed = t0Edit.value
  if (ed.id !== t.id) return
  t0Edit.value = { id: '', text: '' }
  const s = String(ed.text || '').trim()
  if (s === fmtT0(t.t0Ms)) return
  if (!s) { setTrajMotion(t.id, { t0Ms: null }); return }
  const d = parseDateTimeText(s)
  if (!d) return
  // 写了时区按所写；没写：本机档走 tzToMs（夏令时切换那两天同一墙钟偏移不同），UTC / 固定偏移档按档位偏移
  const ms = d.offMin != null ? partsToUtcMs(d, 0)
    : (tzMode.value === 'local' ? tzToMs('local', d.Y, d.Mo, d.D, d.h, d.mi, d.s) + (d.ms || 0) : partsToUtcMs(d, tzOffMin(tzMode.value, Date.now())))
  if (Number.isFinite(ms)) setTrajMotion(t.id, { t0Ms: ms })
}
function t0Enter(e, t) { t0Commit(t); t0Begin(t); if (e && e.target && e.target.select) nextTick(() => e.target.select()) }
function t0Esc(e) { t0Edit.value = { id: '', text: '' }; if (e && e.target) e.target.blur() }

// 验证台钩子（.modelharness/p4，真 Electron 整页）：只在 DEV 且地址带 ?harness=p4|w11 时挂到 __g3dHarness.p4（见 onMounted 尾）
function p4Harness() {
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }
  // 某实体此刻在屏上的位置（client 像素）：3D 先取实体层图标中心 / 精灵锚点投影作初值，再在邻域里按命中找中心；2D 在画布上粗扫再求命中区形心
  function screenOf(kind, id) {
    const k = kind === 'traj' ? 'vehicle' : kind
    const o = entObjOf(k, id)
    if (!o) return null
    const hitOk = (x, y) => { const h = entHitAt(x, y, [k]); return !!(h && h.kind === k && h.id === id) }
    const centroid = (x0, y0) => {
      let sx = 0, sy = 0, n = 0
      for (let y = y0 - 40; y <= y0 + 40; y += 2) for (let x = x0 - 40; x <= x0 + 40; x += 2) if (hitOk(x, y)) { sx += x; sy += y; n++ }
      return n ? { x: sx / n, y: sy / n } : { x: x0, y: y0 }
    }
    if (!flatView.value) {
      if (!scene || !el.value) return null
      const rc = el.value.getBoundingClientRect()
      const d = entityLayer && entityLayer._debug.entity(entityKey(k === 'vehicle' ? 'traj' : k, id))
      let g = null
      if (d && d.screen && d.alpha > 0) g = { x: rc.left + d.screen[0], y: rc.top + d.screen[1] }
      else {
        let lat = o.lat, lon = o.lon
        if (k === 'vehicle') {
          const st = vehStates.get(id)
          if (st && st.ok) { lat = st.lat; lon = st.lon } else { const p = (o.pts || []).filter(finLL); const hd = p[p.length - 1]; if (!hd) return null; lat = hd.lat; lon = hd.lon }
        }
        const v = llaToVec(lat, lon, 0).multiplyScalar(k === 'vehicle' ? 1.0025 : 1.0012).project(scene.getCamera())
        g = { x: rc.left + (v.x + 1) / 2 * rc.width, y: rc.top + (1 - v.y) / 2 * rc.height }
      }
      if (hitOk(g.x, g.y)) return centroid(g.x, g.y)
      for (let r = 2; r <= 48; r += 2) for (let a = 0; a < 16; a++) { const x = g.x + r * Math.cos(a * Math.PI / 8), y = g.y + r * Math.sin(a * Math.PI / 8); if (hitOk(x, y)) return centroid(x, y) }
      return null
    }
    const c = flatCanvas.value
    if (!c) return null
    const rc = c.getBoundingClientRect()
    for (let y = rc.top + 2; y < rc.bottom; y += 5) for (let x = rc.left + 2; x < rc.right; x += 5) if (hitOk(x, y)) return centroid(x, y)
    return null
  }
  return {
    markers: () => JSON.parse(JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })),
    setMarkers: (d) => { points.value = (d && d.points) || []; stations.value = (d && d.stations) || []; trajectories.value = (d && d.trajectories) || []; syncMarkers() },
    setEntityModel, setStationTrack, setTrajMotion,
    bindSat: (norad, id) => { const e = satEntryById('n:' + norad); return e ? bindModel(id, e) : null },
    entityStats: () => (entityLayer ? entityLayer.stats() : null),
    entity: (key) => (entityLayer ? entityLayer._debug.entity(key) : null),
    models: () => (entityLayer ? entityLayer._debug.models() : null),
    vehState: (tid) => { const s = vehStates.get(tid); return s ? { ...s, tan: s.tan.slice() } : null },
    stationLook: (sid) => { const s = stTracks.get(sid); return s ? { key: s.key, park: s.park, wgs: { az: s.look.azDeg, el: s.look.elDeg }, aim: { az: s.aim.azDeg, el: s.aim.elDeg, dir: Array.from(s.aim.dir) } } : null },
    entRead: () => Object.fromEntries(entRead.value), vehRead: () => Object.fromEntries(vehRead.value),
    // 页面侧每拍喂实体（载具状态 / 站跟踪 / 实体层）一次的耗时（ms）：n 次取中位
    feedMs: (n) => { const a = []; for (let i = 0; i < (n || 21); i++) { const t = performance.now(); feedEntitiesNow(); a.push(performance.now() - t) } a.sort((x, y) => x - y); return a[a.length >> 1] },
    hitAt: (x, y, kinds) => entHitAt(x, y, kinds),
    dragHit: () => mdlDragHit.value,
    screenOf,
    drop: (x, y, payload) => { const h = entHitAt(x, y, ENT_KINDS_DROP); if (!h || !payload || !parseModelId(payload.id) || !applyModelDrop(h, payload.id)) return null; mdlFlash(h); return h },
    setModelStyle: (k, v) => setModelStyle(k, v),
    // 某颗星在 ms 时刻的大地经纬高（km；与画面 / 跟踪同一份星历）：验收台把站放到 LEO 星下点用
    satLla: (norad, ms) => {
      const e = satEntryById('n:' + norad)
      if (!e) return null
      const d = new Date(ms), cc = isCustomEntry(e), t = cc ? ccTimeAt(d) : d
      const pv = posAt(e, t)
      if (!pv || !pv.position) return null
      const gd = sat.eciToGeodetic(pv.position, sat.gstime(t))
      return { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), hKm: gd.height }
    },
    // 航迹 Excel 导出 / 导入（与侧栏按钮同一函数；验收台在主进程里替掉保存 / 打开对话框）
    exportTrajXlsx: () => mkExportTrajXlsx(), importTrajXlsx: () => mkImportTrajXlsx(),
    selectAdd: (norad) => { const e = satEntryById('n:' + norad); if (e) selectSat(e, false, true); return !!e },
    selKeys: () => selEntries.map((e) => satKeyOf(e)), primaryKey: () => (selEntry ? satKeyOf(selEntry) : null),
    setFlat: async (on) => {
      on = !!on
      if (view.flat !== on) view.flat = on
      for (let i = 0; i < 200 && (flatView.value !== on || (on && !flatPainted.value)); i++) await new Promise((r) => setTimeout(r, 25))
      return flatView.value === on
    },
    snap3d: async () => { const r = await scene.snapshot(1); return b64(r.bytes) },
    snap2d: async () => {
      const c = flatCanvas.value
      if (!c) return null
      const bl = await new Promise((r) => c.toBlob(r, 'image/png'))
      return bl ? b64(new Uint8Array(await bl.arrayBuffer())) : null
    },
    perf: async (ms) => {
      const dts = [], t0 = performance.now()
      let last = t0
      await new Promise((res) => { const f = (t) => { dts.push(t - last); last = t; if (t - t0 < (ms || 3000)) requestAnimationFrame(f); else res() }; requestAnimationFrame(f) })
      dts.shift(); dts.sort((a, b) => a - b)
      const q = (p) => (dts.length ? dts[Math.min(dts.length - 1, Math.floor(p * dts.length))] : NaN)
      return { frames: dts.length, p50: q(0.5), p95: q(0.95), max: dts.length ? dts[dts.length - 1] : NaN, ent: entityLayer ? entityLayer.stats() : null, heapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null }
    }
  }
}

// ---- 顶部搜索框命令（本页登记；App.vue 登记菜单 / 视图 / 分区那些）----
// 带图层拨杆的分区：一条命令 = 拨一下拨杆 + 定位到该分区（勾 = 当前开着）。不带拨杆的分区由 App.vue 只做定位。
let offCmds = null
function pageCommands() {
  const sw = (id, view, key, label, on, fn, group, icon, keywords) => ({ id, label, icon, group, keywords, lock: true, check: on, run: () => { fn(); revealSection(view, key) } })
  return [
    { id: 'const.wizard', label: '生成星座…', icon: 'satellite', group: '星座', keywords: kwId('const.wizard'), lock: true, run: () => { shellUi.side = 'constellation'; openConstWizard() } },
    { id: 'const.frame', label: '地球自转', icon: 'rotate-cw', group: '星座', keywords: kwId('const.frame'), lock: true, check: viewPrefs.frame === 'inertial', run: toggleFrame },
    { id: 'const.live', label: '实时时钟', icon: 'clock', group: '星座', keywords: kwId('const.live'), lock: true, check: live.value, run: toggleLive },
    { id: 'const.sendMini', label: '发送卫星到小程序…', icon: 'external-link', group: '星座', keywords: kwId('const.sendMini'), lock: true, run: () => { shellUi.side = 'constellation'; sendSatsToMiniapp() } },
    { id: 'const.import', label: '导入星历…', icon: 'import', group: '星座', keywords: kwId('const.import'), lock: true, run: () => { shellUi.side = 'constellation'; importTleToLibrary() } },
    { id: 'const.finder', label: '查找卫星…', icon: 'filter', group: '星座', keywords: kwId('const.finder'), lock: true, run: () => { shellUi.side = 'constellation'; openFinder() } },
    { id: 'poly.draw', label: '绘制多边形', icon: 'hexagon', group: 'Polygon（协调区）', keywords: kwId('poly.draw'), lock: true, run: () => { shellUi.side = 'poly'; polyStartDraw() } },
    { id: 'poly.import', label: '导入多边形…', icon: 'import', group: 'Polygon（协调区）', keywords: kwId('poly.import'), lock: true, run: () => { shellUi.side = 'poly'; importPolys() } },
    { id: 'grd.addSat', label: '添加卫星…', icon: 'plus', group: '对地覆盖分析', keywords: kwId('grd.addSat'), lock: true, disabled: !covNav.grdAvail, run: () => { shellUi.side = 'antenna'; openAddSat() } },
    { id: 'grd.addElev', label: '添加仰角线…', icon: 'angle', group: '对地覆盖分析', keywords: kwId('grd.addElev'), lock: true, disabled: !covNav.grdAvail, run: () => { shellUi.side = 'antenna'; openAddElevLine() } },
    { id: 'mk.pointsTable', label: '点标记表格', icon: 'table', group: '标记', keywords: kwId('mk.pointsTable'), lock: true, run: () => { shellUi.side = 'markers'; openMkTable('points') } },
    { id: 'mk.stationsTable', label: '地球站表格', icon: 'table', group: '标记', keywords: kwId('mk.stationsTable'), lock: true, run: () => { shellUi.side = 'markers'; openMkTable('stations') } },
    sw('mk.points', 'markers', 'mk-points', '点标记', showPtLayer.value, togglePtLayer, '标记', 'map-pin', kwId('mk.points')),
    sw('mk.stations', 'markers', 'mk-stations', '地球站', showStLayer.value, toggleStLayer, '标记', 'map-pin', kwId('mk.stations')),
    sw('mk.traj', 'markers', 'mk-traj', '轨迹', showTrajLayer.value, toggleTrajLayer, '标记', 'move', kwId('mk.traj')),
    sw('geo.adm', 'geo', 'geo-adm', '行政区', showProvinces.value, toggleProvinces, '地图设置', 'map', kwId('geo.adm')),
    sw('geo.chain', 'geo', 'geo-chain', '岛链', chainOn.value, toggleChains, '地图设置', 'map', kwId('geo.chain')),
    sw('geo.space', 'geo', 'geo-space', '宇宙空间', spaceOn.value, toggleSpace, '地图设置', 'globe', kwId('geo.space')),
    // 六个子项同一写法；勾 = 此刻真的在画（总开关开着且本项勾着），点它 = 反过来；总开关关着时去开 = 开总开关且只开这一项（见 setSpaceItem）
    ...[['stars', '星空', 'star'], ['atmo', '大气辉光', 'globe'], ['sun', '太阳', 'sun'], ['img', '地球影像', 'image'], ['night', '晨昏效果', 'moon'], ['line', '晨昏线', 'sun']]
      .map(([k, label, icon]) => sw('geo.space.' + k, 'geo', 'geo-space', label, spaceOn.value && space[k], () => setSpaceItem(k, !(spaceOn.value && space[k]), true), '地图设置', icon, kwId('geo.space.' + k))),
    { id: 'geo.proj', label: '2D 投影', icon: 'map', group: '地图设置', keywords: kwId('geo.proj'), lock: true,
      children: PROJECTIONS.map((pj) => ({ id: 'geo.proj.' + pj.k, label: byLang(pj.zh, pj.en), keywords: [pj.en, pj.zh], check: mapCrs.proj === pj.k, run: () => { setMapProj(pj.k); revealSection('geo', 'geo-proj') } })) },
    sw('foc.orb', 'focus', 'foc-orb', '轨道线', focusStyle.orbOn, () => toggleFocus('orbOn'), '聚焦卫星', 'orbit', kwId('foc.orb')),
    sw('foc.trk', 'focus', 'foc-trk', '星下点轨迹', focusStyle.trkOn, () => toggleFocus('trkOn'), '聚焦卫星', 'crosshair', kwId('foc.trk')),
    sw('foc.fp', 'focus', 'foc-fp', '覆盖圈', focusStyle.fpOn, () => toggleFocus('fpOn'), '聚焦卫星', 'crosshair', kwId('foc.fp')),
    sw('foc.cone', 'focus', 'foc-cone', '覆盖锥', focusStyle.coneOn, () => toggleFocus('coneOn'), '聚焦卫星', 'crosshair', kwId('foc.cone')),
    // 卫星模型（侧栏 side='model'）：跟随卫星只在 3D 球体、且有主选星时可用
    { id: 'model.follow', label: '跟随当前卫星', icon: 'locate-fixed', group: '卫星模型', keywords: kwId('model.follow'), lock: true,
      disabled: flatView.value || !selected.value || !!following.value, run: () => startFollow(selEntry) },
    { id: 'model.unfollow', label: '退出跟随', icon: 'locate-fixed', group: '卫星模型', keywords: kwId('model.unfollow'), lock: true,
      disabled: !following.value, run: stopFollow },
    sw('model.show', 'model', 'mdl-disp', '显示卫星模型', focusStyle.modelOn, () => setModelStyle('modelOn', !focusStyle.modelOn), '卫星模型', 'box', kwId('model.show')),
    // 侧栏分区在 ModelSidePanel 组件里（cmd-index 只扫本页模板，抽不到），这里手工登记两条定位
    { id: 'sec.mdl-cur', label: '当前卫星', icon: 'box', group: '卫星模型', keywords: kwId('sec.mdl-cur'), lock: true, run: () => revealSection('model', 'mdl-cur') },
    { id: 'sec.mdl-lib', label: '模型库', icon: 'box', group: '卫星模型', keywords: kwId('sec.mdl-lib'), lock: true, run: () => revealSection('model', 'mdl-lib') }
  ]
}

// 画布首帧淡入：挂载时画布先透明，首帧落地后（两拍 rAF）淡入一次，之后画布上不再有任何过渡。
// 3D 会话建完场景即揭幕（不等 IPC）；上次停在 2D 的会话等平面图就绪再揭幕，免得先闪一下球 —— 1.5 s 兜底。
const stageShown = ref(false)
let revealT = 0
function revealStage() {
  if (stageShown.value) return
  clearTimeout(revealT)
  requestAnimationFrame(() => requestAnimationFrame(() => { stageShown.value = true }))
}
onMounted(async () => {
  perfHost.attach()   // 性能指标表窗口：收弹窗操作 / 关窗通知，认领主窗口重载前就开着的窗
  // 顶栏「视图」按钮右侧的覆盖图入口：注册可用性与切换回调（按钮渲染在 App.vue，状态走 covNav store）
  covNav.grdAvail = grdApiOk; covNav.covAvail = covApiOk
  covNav.toggleGrd = toggleGrd; covNav.toggleCov = toggleCoverage
  covNav.polyAvail = true; covNav.togglePoly = togglePolyPanel   // Polygon 面板（纯本地功能，不依赖 IPC）
  covNav.exportAvail = true; covNav.exportMap = exportMap   // 顶栏「导出图」入口（高清 PNG / 矢量 PDF）
  covNav.sendMiniapp = sendToMiniapp   // 顶栏「导出」菜单「发送到小程序」入口（覆盖层 + 多边形一份快照）
  covNav.sendTrajMiniapp = sendTrajsToMiniapp   // 同一菜单「发送航迹到小程序」（标记层航迹，一条一件）
  covNav.importTle = importTleToLibrary   // 「文件」菜单「导入星历文件」入口 → 落库自定义卫星（贯通文件管理/搜索池）
  // 顶部搜索框：星座搜索桥（「在星座中搜索“…”」）+ 只有本页够得着的命令（图层开关 / 绘制 / 投影档…）
  covNav.searchSats = (q) => onSearch({ target: { value: q } })
  ensureSatcatIndex()   // 取一次卫星编目索引（只读本机缓存）：筛选条的前四项靠它
  offCmds = registerCommands('globe3d', pageCommands)
  watch(status, (v) => { if (v) logMsg(v) })   // 加载进度/失败信息落日志窗格
  // 文件管理导入/删除自定义卫星 → 若正看 custom/all/other 分组则重载；并重建全量搜索库纳入新星。
  watch(() => fileBridge.customSatTick, async () => {
    invalidateEphTables(); impEntries.clear()   // 组内容可能整份换掉：缓存一律作废，可见的导入集重新加载
    await refreshCustomImportCount()
    registerSets(); applySetsChanged()
    poolReady = false; ensureSearchPool()
  })
  // 活动栏切换侧栏视图 → 首次进入时懒加载对应面板内容（复用原 toggle* 的索引加载/重绘逻辑）
  watch(() => shellUi.side, (s) => {
    if (s === 'gxt' && !covOpen.value) toggleCoverage()
    else if (s === 'antenna' && !grdOpen.value) toggleGrd()
    else if (s === 'poly' && !polyOpen.value) togglePolyPanel()
  }, { immediate: true })
  // ★ 全局仿真时钟接进来：一拍 = 一次全场重算（星位/覆盖/壳层/可见性/晨昏线/指标表都在 refreshPositions 里）。
  //   改造前只有「实时」档有一个 1 Hz 的 setInterval，冻结档全靠用户拖游标才动；现在时间本身会走。
  geomPool = createFocusGeomPool()   // 聚焦几何 Worker 池（拿不到 Worker 时就地同步跑同一份，见 focusGeomPool）
  unsubClock = onTick(async () => {
    // 出帧闸：本拍算完之前不出帧 —— 星位是同步算的、聚焦几何要等 Worker 回来，中间出一帧就是两个时刻同框
    if (scene) scene.holdFrames(true)
    try { await refreshPositions() } finally { if (scene) scene.holdFrames(false) }
  })
  resumeClock()   // 上次离开本页时若在实时/播放，回来接着走（时刻与模式都留在 store 里）
  // 「真实此刻」参考量的心跳：只写一个 ref（红色「此刻」标记的位置 + 偏移读数 + 此刻按钮的可用性），
  // 不碰星位、不碰场景。没有它的话，暂停期间这三样会冻在最后一拍上 —— 停十分钟后点「此刻」会发现按钮是灰的。
  nowBeat = setInterval(() => { nowStamp.value = Date.now() }, 1000)
  scene = createGlobeScene(el.value, { ...displayQuality.value })
  if (!view.flat) revealStage(); else revealT = setTimeout(revealStage, 1500)
  scene.setFrameMode(viewPrefs.frame)
  scene.setDragDamping(viewPrefs.dragDamping)
  scene.setWheelStep(viewPrefs.wheelStep3d)
  scene.setLabelMode(nameMode.value)
  scene.setWaterOff({ ...waterOff })
  scene.setWaterMode({ ocean: oceanNameMode.value, sea: seaNameMode.value })
  scene.setChains({ on: chainOn.value, off: { ...chainOff }, ...chainStyle })
  scene.setBorderStyle({ ...borderStyle })
  scene.setLabelStyle({ ...labelStyle })
  scene.setOceanColor(oceanColor.value)
  if (imageryOn.value) applyImagery()
  scene.setFocusStyle(focusStyle3D())
  scene.setSatPointsVisible(focusStyle.cloudOn)
  scene.setOnPick((index, point, additive, extra) => {
    const armed = _pickArmed; _pickArmed = false
    if (!armed) return   // 这一下不是落在画布上的完整点击（浮层遮罩 / 窗口刚激活 / 收起搜索下拉），见 onPickArmDown
    // extra＝点中的是渲染集之外、被别的功能画出来的星（见 pickExtraSats），直接是条目本身
    const en = extra || (index >= 0 ? renderEntries[index] : null)
    // 从星座点选模式：命中的星填入卫星编辑弹窗，不改变当前选中星
    if (satPick.value && satModal.value) { if (en) pickEntryIntoModal(en); return }
    // 点空白不改聚焦（原为清空，是「鼠标误操作失焦」的根因）。清空只走显式入口：信息栏「取消聚焦 / 全部取消」、
    // 右键菜单、移出最后一颗；误清 / 误换星可从右键「上一聚焦」找回
    if (!en) return
    if (!additive && !(selEntries.length === 1 && selEntries[0] === en)) notePrevFocus()   // 裸点换星：旧聚焦集进「上一聚焦」
    selectSat(en, false, additive)   // 裸点=替换聚焦；Ctrl/Cmd/Shift 点=加入/移出多选
  })
  scene.setPickExtras(pickExtraSats)
  // 鼠标实时经纬度（底部状态栏显示）+ 右键标点/加航点
  scene.setOnHover(onHoverLL)
  scene.setOnRightClick(onMapRightClick)
  scene.setOnBeamDrag(onBeamDragAny)   // 拖拽波束（GRD boresight）：对地拖地表落点、对星绕源星转方向
  satcovSyncDragSphere()
  scene.setOnLabelDrag(grd.labelDrag); scene.setLabelDragMode(grd.dragLabel.value)   // 拖拽等值线数值标签（沿线滑动）
  scene.setOnPolyDraw(onPolyDraw); scene.setPolyDrawMode(!!(polyDrawId.value || activeTraj.value))   // Polygon/航迹绘制：左键按住沿路径连续加点
  scene.setOnPlace((ll) => bs.placeAt(ll)); scene.setPlaceMode(bs.placing.value)   // 波束合成放置：左键点击落波束（拖动仍旋转）
  scene.setOnMarkerDrag(onMarkerDragged)   // 标记拖拽（2D 那侧在 flat 创建处注册）
  // 缩放进度条（底部状态栏）：注册当前页缩放能力，球体滚轮缩放回填进度条 + 记忆
  scene.setOnZoom((t) => { if (!flatView.value) { zoom.value = t; saveView(); grd.onZoomEnd() } })
  if (savedView.globe) scene.setView(savedView.globe)   // 恢复上次球体视图（朝向+缩放）
  // 卫星 3D 模型层：球面图标 + 跟随卫星（挂 scene 的叠加层口子；关着 / 没有图标时一个像素都不碰球面）
  modelLayer = createModelLayer({
    api: window.api || null,
    getQuality: () => ({ tier: displayTier.tier, ...displayQuality.value }),
    metaOf: modelMetaOf,
    onFollowZoom: (t) => { if (!flatView.value && following.value) zoom.value = t },
    onMaskChange: (on) => { if (scene) scene.setDotMask(on) }
  })
  scene.setOverlay(modelLayer.overlay)
  // 标记实体模型层（地球站 / 点标记 / 航迹载具挂的模型）：与卫星图标共用一份模型缓存 / 元数据 / 就绪通知（modelLayer.source），
  // 出帧插槽在宇宙空间主趟之后、卫星图标之前；标记精灵按实体键交叉淡化（spriteWeight）、拖放命中先问它（hitTest）
  try {
    if (modelLayer.source) {
      entityLayer = createEntityLayer({ source: modelLayer.source, getQuality: () => ({ tier: displayTier.tier }) })
      if (scene.setEntityOverlay) scene.setEntityOverlay(entityLayer.overlay)
      if (scene.setEntityProvider) scene.setEntityProvider({ weight: entityLayer.spriteWeight, hitTest: entityLayer.hitTest })
    }
  } catch (err) { entityLayer = null; console.warn('[globe3d] 实体模型层创建失败：' + ((err && err.message) || err)) }
  // 平面图的模型俯视图出图器：同样借 modelLayer.source（离屏渲染器等平面图第一次要图时才建）；平面图已经建过就当场接上
  try {
    if (modelLayer.source) {
      entSprites = createEntitySprites({ source: modelLayer.source })
      if (flat && flat.setEntitySprites) { flat.setEntitySprites(entSprites); pushStationAims() }
    }
  } catch (err) { entSprites = null; console.warn('[globe3d] 平面图模型俯视图出图器创建失败：' + ((err && err.message) || err)) }
  window.addEventListener('dragend', mdlDragEndAny)
  modelLayer.setDragDamping(viewPrefs.dragDamping)
  modelLayer.setWheelStep(viewPrefs.wheelStep3d)
  applyModelStyle()
  loadModelLib(); loadModelBindings()
  if (modelsApi && modelsApi.onChanged) offModelsChanged = modelsApi.onChanged(onModelsChanged)
  // 平移/旋转结束也保存视图（滚轮已由 onZoom 覆盖；拖拽无回调，故监听 pointerup）
  el.value.addEventListener('pointerup', saveView)
  // 方向键导航（3D 旋转 / 2D 平移视窗中心）：全局监听，失焦清键防卡键
  window.addEventListener('keydown', onNavKeyDown)
  window.addEventListener('keyup', onNavKeyUp)
  window.addEventListener('blur', navStop)
  zoom.avail = true; zoom.apply = applyZoom; pushZoom()
  grd.setLivePos(satLivePos)          // GRD 覆盖按星历/时间轴解算星下点+高度（关联星实时跟踪）
  // 导入 GRD / 新建解析天线时关联星解不出：先等星历源就绪再判（挂载后几秒全量目录在建时不误报「无星历」）
  if (typeof grd.setEphReady === 'function') grd.setEphReady(awaitLinkEph)
  // 注册到文件管理器：镜像 GRD 树 + 导出当前覆盖 + 改星后重绘 + 复用原版卫星弹窗（隐藏可视化项）
  setGrdBridge(grd, collectGxt, {
    redraw: redrawSats,
    openAddSat: () => openAddSat(true),
    openEditSat: (folder) => { const n = grdSats.value.find((s) => s.folder === folder); if (n) editSat(n, true) },
    livePos: (folder) => { const n = grdSats.value.find((s) => s.folder === folder); return n ? satLivePos(n) : null }   // 实时星下点（文件管理器树行经度用）
  })
  fileBridge.customConst = customConst   // 注入活「自定义星座」实例：文件管理改名等直接联动（改缓存失效+重渲染）
  // 用户在文件管理器导入/删除 GXT → 重新合并 covSats，使覆盖图(GXT)面板可选用新库
  watch(() => fileBridge.libraryTick, () => { if (covLoaded) mergeUserGxt() })
  loadMarkers(); syncMarkers()
  loadPolys()   // Polygon（协调区多边形）：随后 redrawSats() 一并绘制
  // 右侧信息栏开合 / 拖宽期间 _rdkKeepView 有值：2D resize 之后把地理中心放回去（3D 相机本就以画布中心为准）
  ro = new ResizeObserver(() => { if (scene) scene.resize(); if (flat && flatView.value) { flat.resize(); if (_rdkKeepView) flat.setView(_rdkKeepView) } }); ro.observe(el.value)
  if (rdkEl.value) { rdkMeasure(); rdkRo = new ResizeObserver(rdkMeasure); rdkRo.observe(rdkEl.value) }   // 右栏显示宽 → 窄档 / 横幅让位
  window.addEventListener('pointerdown', onPickArmDown, true)   // 画布点击落点闸（捕获阶段，每次按下重判）
  window.addEventListener('focus', onWinFocus)
  if (track.value) { measureTrack(); trackRo = new ResizeObserver(measureTrack); trackRo.observe(track.value) }   // 轨道宽 / 位置 / dpr → 刻度自适应
  window.addEventListener('resize', onHairDpr)   // 换显示器 / 改缩放：dpr 变了轨道宽不一定变，单靠 trackRo 接不住

  // 恢复上次选中星；旧存档里的「当前分组」只作首次迁移到卫星集注册表用
  let legacySel = null
  try {
    legacySel = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (legacySel) {
      // 新存档：整个选中集；老存档：只有主选的 NORAD
      const ids = Array.isArray(legacySel.sel) ? legacySel.sel.filter((s) => typeof s === 'string' && s) : (legacySel.selNorad ? ['n:' + legacySel.selNorad] : [])
      if (ids.length) restoreSel = { ids, primary: typeof legacySel.primary === 'string' && legacySel.primary ? legacySel.primary : (legacySel.selNorad ? 'n:' + legacySel.selNorad : '') }
    }
  } catch { legacySel = null }

  await restoreSettings()   // 恢复全部选项/设置（无感）
  await ensureProvinces(); await ensureCities()   // 按恢复后的省/市界开关加载数据并套用可见性（restoreSettings 只回填开关）
  customConst.load()   // 恢复自定义星座（按参数重建合成星，随后由 rebuildRenderSet 按可见集拼进渲染集）
  satGroups.load()     // 恢复已存卫星组
  await refreshCustomImportCount()   // 导入组清单（注册表登记要用）
  initSatSets(legacySel)   // 卫星集注册表：顺序 / 可见集合 / 覆盖层；没有存档就按旧存档迁移，然后按可见集逐集加载
  loadGroupCounts()
  // 后台构建全量搜索库（当日缓存命中则很快），与当前分组无关。
  // 就绪后补一拍：GRD 关联星不在当前分组时，此前 satLivePos 解析不到星历（liveEntryOf 的兜底
  // 顺序是 entries → searchPool）、meta 停在存盘位置，这一拍才把星位/视轴/壳层一并对齐。
  // ★ 另补一次全量重绘：此前解不出的关联星在 buildLayer 里整根跳过了；若它的活位置恰与存盘位置相同，tickLive 判「没挪」
  //   不会触发重算 —— 那根天线就一直不画。recompute / scheduleRecompute 让待画的关联天线这一拍一并上图。
  //   补拍与重绘统一在 onPoolSwapped（watch(poolTick) 也走它，同一版池只补一次）：此后联网版 / 文件管理换池同样补拍。
  ensureSearchPool().finally(onPoolSwapped)
  redrawSats()   // 恢复后立即绘制自定义卫星（关联卫星待 loadGroup 完成由 refreshPositions 跟踪）
  applyDisplayQuality()   // 套用当前画质档位（低/中/高档的 50m 底图按需加载，超高/极致档用静态 10m；110m 已于 v1.3.32 下线）
  applySpaceStyle()   // 宇宙空间：按恢复后的开关画一次（不依赖星历，故不等 loadGroup）；地球影像在这里顶上
  scene.setFrameMode(viewPrefs.frame)   // 存档里的参考系 / 拖拽阻尼 / 滚轮比例（restoreSettings 只回填 store）
  scene.setDragDamping(viewPrefs.dragDamping)
  scene.setWheelStep(viewPrefs.wheelStep3d)
  if (flat) flat.setWheelStep(viewPrefs.wheelStep2d)
  if (view.flat) await applyFlat(true)   // 恢复上次退出时的 2D 平面图（watch 不触发初始值，故挂载时主动套用一次）
  revealStage()
  watch(snapshot, saveSettings, { deep: true })   // 此后任意改动自动本地缓存
  watch(displayQuality, applyDisplayQuality, { deep: true })   // 画质档位变化 → 实时套用（msaa 除外，由重挂载处理）
  // 参考系换档（设置弹窗 / 侧栏小标 / 命令面板写的都是同一个 viewPrefs.frame）
  watch(() => viewPrefs.frame, (v) => { if (scene) scene.setFrameMode(v) })
  watch(() => viewPrefs.dragDamping, (v) => { if (scene) scene.setDragDamping(v); if (modelLayer) modelLayer.setDragDamping(v) })
  watch(() => viewPrefs.wheelStep3d, (v) => { if (scene) scene.setWheelStep(v); if (modelLayer) modelLayer.setWheelStep(v) })
  watch(() => viewPrefs.wheelStep2d, (v) => { if (flat) flat.setWheelStep(v) })
  // 验证台钩子（.modelharness/w11，真 Electron 整页验证，渲染端走 vite dev）：只在开发构建且地址带 ?harness=w11 时挂 ——
  // 打包件里 import.meta.env.DEV 恒 false，整段被摇掉。读数只读，动作走本页自己的函数
  if (import.meta.env.DEV && /[?&]harness=(w11|p4)\b/.test(window.location.search)) {
    window.__g3dHarness = {
      bodyRt, vis, grd,
      modelStats: () => (modelLayer ? modelLayer.stats() : null),
      sunL: () => (modelLayer ? modelLayer._sunL() : null),
      // 包围盒读数（轴映射终案 ④）：侧栏「当前卫星」那一格 / 任意库条目形状的 meta 走同一个 bodyDimsOf
      selDims: () => (selModel.value ? { id: selModel.value.id, dims: selModel.value.dims } : null),
      bodyDims: (m, frameOv) => bodyDimsOf(m, frameOv || null),
      paramInfo: (id) => paramInfoOf(id),
      followCam: (dir, dist) => { if (modelLayer) modelLayer.setFollowCamera({ dir, dist }) },
      basisOf: (norad, ms) => {
        const e = satEntryById('n:' + norad), key = e && satKeyOf(e)
        if (!key) return null
        const d = new Date(ms), pv = posAt(e, d)
        return pv && pv.position ? { key, basis: bodyRt.attitudeBasisAt(key, { pv, gmstRad: sat.gstime(d), tMs: ms }), sun: bodyRt.sunEcefLast() } : null
      },
      select: (norad) => { const e = satEntryById('n:' + norad); if (e) selectSat(e, true); return !!e },
      follow: () => { startFollow(selEntry); return !!following.value },
      unfollow: () => stopFollow(),
      seek: (ms) => satcovSeekClock(ms),
      nowMs: () => clock.tMs,
      attAxes: (meta, st) => grdAttAxes(meta, st),
      mountOptions: (antKey) => grdMountOptions(antKey),
      satcovAttAt: (key) => satcovAttAt(grd.getPerfContext(key)),
      attTick: () => { grdAttTick(grdLiveKeys(), true) },
      // D9 写回的内部状态：尾沿补拍 / 落盘定时器是否排着、上次落盘时刻
      attEqState: () => ({ trail: !!_attEqTrail, kick: !!_attKickT, saveTimer: !!_attEqSaveTimer, lastSave: _attEqSaveT }),
      // 某根天线存盘里的 attEquiv（链路预算读的就是这份 localStorage）
      savedAttEquiv: (key) => { try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); const walk = (o) => { if (!o || typeof o !== 'object') return null; if (Array.isArray(o)) { for (const x of o) { const r = walk(x); if (r) return r } return null } for (const [k, v] of Object.entries(o)) { if (k === key && v && typeof v === 'object' && 'attEquiv' in v) return v.attEquiv; const r = walk(v); if (r) return r } return null }; return walk(s) } catch { return null } },
      // 从全量池里找此刻星下点经度落在 [lo, hi] 的 GEO 星（对星瞬时表的目标）
      geoNear: (lo, hi, n) => { const out = [], d = calcAt(), g = sat.gstime(d); for (const e of searchPool) { if (out.length >= (n || 2)) break; const p = posAt(e, d); if (!p || !p.position) continue; const gd = sat.eciToGeodetic(p.position, g); const lon = sat.degreesLong(gd.longitude); if (gd.height > 35000 && gd.height < 36500 && lon >= lo && lon <= hi && Math.abs(sat.degreesLat(gd.latitude)) < 1) out.push({ noradId: e.noradId, name: e.name, group: e.group || '' }) } return out },
      satPerf, perfHost, satcovOpenTable: (folder, antName) => { const s = grdNodeOf(folder); const a = s && (s.antennas || []).find((x) => x.name === antName); return s && a ? satcovOpenTable(s, a).then(() => true) : false },
      satcovTimes: () => satcovTimes(), satcovResolveTargets: (key) => satcovResolveTargets(grd.getPerfContext(key), key),
      addStation: (lat, lon, name) => { const id = newId(); stations.value.push({ id, lat, lon, name: name || '地球站' }); syncMarkers(); return id },
      // GRD 树节点此刻的本体基底（与 getAttAxes 同一份星历 / 同一时刻）
      grdNodeBasis: (folder) => {
        const node = grdNodeOf(folder), key = grdSatKeyOfNode(node) || grdSatKey(folder), tMs = calcAt().getTime()
        const c = key ? grdBodyCtx(node, null, tMs) : null
        return c ? { key, basis: bodyRt.attitudeBasisAt(key, c) } : null
      },
      pauseClock: () => { if (clock.mode === 'play') togglePlay() },
      satGroups,
      // 天线树定点同步星（星座条目）：条目表 / 是否在渲染集 / 此刻星下点 / 本体身份与自动匹配的模型 / 绑模型
      tg: {
        list: () => treeGeoList.map((e) => ({ folder: e._grdFolder, id: String(e.noradId), name: e.name })),
        inRender: (id) => renderEntries.some((e) => String(e.noradId) === String(id)),
        sel: () => selEntries.map((e) => String(e.noradId)),
        pos: (id, ms) => { const e = treeGeoById.get(String(id)); if (!e) return null; const d = new Date(ms == null ? calcAt().getTime() : ms), pv = posAt(e, d); if (!pv) return null; const gd = sat.eciToGeodetic(pv.position, sat.gstime(d)); return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), altKm: gd.height } },
        model: (id) => { const e = treeGeoById.get(String(id)); if (!e) return null; const m = modelOf(e); return { key: m.key, id: m.id, auto: m.auto } },
        bind: (id, modelId) => { const e = treeGeoById.get(String(id)); return e ? bindModel(modelId, e) : false }
      },
      // W18 宇宙空间：场景 / 平面图（量帧时、逐像素比对）与本节的开关动作
      w18: { scene: () => scene, flat: () => flat, space, spaceOn, spaceSub, applySpace, applySpaceStyle, toggleSpace, setSpaceItem, spaceImgForced: () => !!(img3d && img3d.k === IMG_3D_FULL), img3d: () => (img3d ? img3d.k : ''), img2d: () => (img2d ? img2d.k : ''), setImageryKey, spaceCmdSnap: () => (spaceCmdSnap ? { ...spaceCmdSnap } : null) },
      // P4 标记实体上球（.modelharness/p4）：数据 / 写入 / 读数 / 命中 / 取帧 / 性能
      p4: p4Harness(),
      save: () => saveSettings()
    }
  }
})
onBeforeUnmount(() => {
  // 离开 3D 页：复位顶栏覆盖图入口（按钮随之隐藏），并关掉面板镜像状态
  covNav.grdAvail = false; covNav.covAvail = false; covNav.toggleGrd = null; covNav.toggleCov = null
  covNav.polyAvail = false; covNav.togglePoly = null
  covNav.exportAvail = false; covNav.exportMap = null; covNav.importTle = null; covNav.sendMiniapp = null; covNav.sendTrajMiniapp = null
  covNav.searchSats = null; if (offCmds) { offCmds(); offCmds = null }
  covNav.grdOpen = false; covNav.covOpen = false; covNav.polyOpen = false
  zoom.avail = false; zoom.apply = null   // 复位底部状态栏缩放进度条
  offLang(); offLangTick()
  // D9 等效指向：排着的补拍作废，排着的落盘立刻落（链路预算读的是盘上那份）
  if (_attEqTrail) { clearTimeout(_attEqTrail); _attEqTrail = 0 }
  if (_attKickT) { clearTimeout(_attKickT); _attKickT = 0 }
  if (_attEqSaveTimer) attEqFlushSave()
  window.removeEventListener('beforeunload', attEqUnload)
  if (_viewSaveTimer) { clearTimeout(_viewSaveTimer); _viewSaveTimer = null }
  if (el.value) el.value.removeEventListener('pointerup', saveView)
  if (flatCanvas.value) flatCanvas.value.removeEventListener('pointerup', saveView)
  window.removeEventListener('keydown', onNavKeyDown)
  window.removeEventListener('keyup', onNavKeyUp)
  window.removeEventListener('blur', navStop)
  window.removeEventListener('resize', onHairDpr)
  clearTimeout(revealT)
  navStop()

  clearGrdBridge()   // 离开 3D 页：注销文件管理器对活树/导出器的引用
  fileBridge.customConst = null
  // 离开本页：退订并停表。时刻本身保留在 store 里 —— 回来接着这个时刻，不弹回「此刻」。
  if (unsubClock) { unsubClock(); unsubClock = null }
  if (nowBeat) { clearInterval(nowBeat); nowBeat = null }
  if (scrubEnd) scrubEnd(false)   // 拖着游标离开本页：只摘监听，不续播（下面紧接着就停表）
  releaseClock()
  offPovTick(); offMapPov()   // 退订主权解算层与视角状态源
  // 模型层先于场景拆：退出跟随（相机归位、摘局部控件监听）→ 断开叠加层 → 释放模型实例与本 renderer 的 GPU 副本
  if (offModelsChanged) { offModelsChanged(); offModelsChanged = null }
  clearTimeout(_libT); clearTimeout(_bodyRtT)
  stopFollow()
  // 实体层先于模型层拆（它借用模型层的 source：先把借的实例还回去，模型层再整体释放）
  window.removeEventListener('dragend', mdlDragEndAny)
  clearTimeout(_mdlFlashT)
  if (entityLayer) {
    if (scene) { if (scene.setEntityProvider) scene.setEntityProvider(null); if (scene.setEntityOverlay) scene.setEntityOverlay(null) }
    entityLayer.dispose(); entityLayer = null
  }
  // 平面图的俯视图出图器同样借着 source：先摘下、还实例、放掉它自己的离屏上下文，模型层再整体释放
  if (entSprites) {
    if (flat && flat.setEntitySprites) flat.setEntitySprites(null)
    entSprites.dispose(); entSprites = null
  }
  if (modelLayer) { if (scene) scene.setOverlay(null); modelLayer.dispose(); modelLayer = null }
  bodyRt.dispose()
  if (typeof window !== 'undefined' && window.__g3dHarness) delete window.__g3dHarness
  // 右栏：拖分隔条途中卸载 → _rdkUp 摘监听并撤 html.ui-col-resize（别把整窗光标锁死）
  if (rdkRo) { rdkRo.disconnect(); rdkRo = null }; if (_rdkUp) _rdkUp(); clearTimeout(_rdkCopyT)
  window.removeEventListener('pointerdown', onPickArmDown, true); window.removeEventListener('focus', onWinFocus)
  cursor.ll = null; cursor.env = null; if (ro) ro.disconnect(); if (trackRo) trackRo.disconnect(); if (geomPool) { geomPool.dispose(); geomPool = null }; if (flat) flat.destroy(); if (scene) { scene.clearCoverage(); scene.destroy() }
})
</script>

<template>
  <div class="g3" :class="{ 'rdk-drag': rdkDrag }" ref="g3el">
    <div class="body">
      <div
        class="stage-wrap" :class="{ dragon: impDragOver, shown: stageShown }"
        @dragenter="impDragEnter" @dragover="impDragOverH" @dragleave="impDragLeave" @drop="onImpDrop"
      >
        <div ref="el" class="stage"></div>
        <canvas v-show="flatView" ref="flatCanvas" class="flat" :class="{ rdy: flatPainted }"></canvas>

        <!-- 聚焦卫星图例：色条＝地图上实际那两根线（颜色/线型随「显示设置 · 聚焦卫星」走），3D / 2D 同步显示 -->
        <div v-if="selected && (focusStyle.fpOn || focusStyle.trkOn)" class="focus-legend">
          <div v-if="focusStyle.fpOn" class="fl-row"><span class="fl-sw" :style="fpSwStyle"></span>{{ fpLegend }}</div>
          <div v-if="focusStyle.trkOn" class="fl-row"><span class="fl-sw" :class="{ band: focusStyle.trkMode === 'swath' }" :style="trkSwStyle"></span>{{ trkLegend }}</div>
        </div>

        <!-- 信息栏「天线」节的「＋」：与侧栏卫星行「＋」同一套条目，外加「波束合成」。菜单 position:fixed、取视口坐标，留在这里与所在容器无关 -->
        <template v-if="antAddMenu && antAddMenu.src === 'card'">
          <div class="lmenu-bd" @mousedown="antAddMenu = null" @contextmenu.prevent="antAddMenu = null"></div>
          <div ref="antMenuEl" class="lmenu antm" :style="{ left: antAddMenu.x + 'px', top: antAddMenu.y + 'px' }">
            <div class="lmi" @click="antAddPick('gauss')"><Icon name="waves" :size="12" /><span>高斯天线</span></div>
            <div class="lmi" @click="antAddPick('grd')"><Icon name="import" :size="12" /><span>导入 GRD…</span></div>
            <div class="lmi" @click="antAddPick('synth')"><Icon name="satellite-dish" :size="12" /><span>波束合成</span></div>
          </div>
        </template>
      </div>

      <!-- 侧栏视图（Teleport 到 App.vue #side-view）：活动栏图标切换，同屏只显示一个视图（v-show），
           标题显示在侧栏头部（App.vue），面板懒加载由 shellUi.side 的 watcher 触发原 toggle* -->
      <Teleport v-if="shellUi.side" to="#side-view">
        <!-- 星座：卫星搜索 + 旋转/实时开关 + 在轨/OMM 状态 + 分组列表 -->
        <div v-show="shellUi.side === 'constellation'" class="sview" :class="{ editing: constModal, dragon: impDragOver }" @dragenter="impDragEnter" @dragover="impDragOverH" @dragleave="impDragLeave" @drop="onImpDrop">
          <!-- 生成/编辑器内联面板：编辑器打开时侧栏切为此面板，地图保持可见 + 实时预览（仿 KeepTrack 停靠式） -->
          <div v-if="constModal" class="cedit">
            <div class="cehd">
              <span class="ceback" @click="closeConstWizard"><Icon name="chevron-left" :size="12" /> 返回</span>
              <span class="cetitle">{{ constModal.id ? '编辑星座' : '生成星座' }}</span>
              <span class="cesolo" :title="constModal.pvSolo !== false ? '地图上只显示正在生成的星座；关掉则叠加在当前显示的卫星上' : '叠加在当前显示的卫星上；打开则只显示正在生成的星座'"><button type="button" class="layersw" :class="{ on: constModal.pvSolo !== false }" role="switch" :aria-checked="constModal.pvSolo !== false ? 'true' : 'false'" @click="constModal.pvSolo = constModal.pvSolo === false"><i></i></button><span>仅预览</span></span>
              <span class="celive" title="改动实时预览到地球">● 实时</span>
            </div>
            <div class="cebody">
              <div class="cef"><label>轨道类型</label>
                <select class="ci" :value="constModal.orbitType" @change="setOrbitType($event.target.value)"
                  title="按 STK Orbit Wizard 的九种类型出题：给「设计意图」（高度 / 地方时 / 回归圈数 / 星下点经度…），解出六根数">
                  <option v-for="t in ORBIT_TYPES" :key="t.key" :value="t.key">{{ byLang(t.zh, t.en) }}</option>
                </select>
              </div>
              <div class="cef"><label>布局</label>
                <span class="seg3">
                  <span :class="{ on: constModal.pattern === 'single' }" @click="constModal.pattern = 'single'">单星</span>
                  <span :class="{ on: constModal.pattern === 'delta' }" @click="constModal.pattern = 'delta'">Delta</span>
                  <span :class="{ on: constModal.pattern === 'star' }" @click="constModal.pattern = 'star'">Star</span>
                  <span :class="{ on: constModal.pattern === 'plane' }" @click="constModal.pattern = 'plane'">单轨道面</span>
                </span>
              </div>
              <div class="cef"><label>星座名称</label><input class="ci" v-model="constModal.name" placeholder="星座名称" /></div>

              <!-- 轨道设计：每种类型只问自己要的那几项 -->
              <template v-if="constModal.orbitType !== 'custom'">
                <div class="cesec">轨道设计</div>
                <template v-if="constModal.orbitType === 'circular'">
                  <div class="cefv"><label>轨道倾角 i</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('inclDeg') }" :model-value="constModal.design.inclDeg" :min="0" :max="180" :step="0.1" @commit="v => setDesign('inclDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cefv"><label>轨道高度 h</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('altKm') }" :model-value="constModal.design.altKm" :min="80" :step="10" @commit="v => setDesign('altKm', v)" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>升交点赤经 Ω</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.raanDeg" :step="1" @commit="v => setDesign('raanDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'critical'">
                  <div class="cef"><label>方向</label>
                    <span class="seg3">
                      <span :class="{ on: constModal.design.direction !== 'retro' }" title="顺行 63.4349°" @click="setDesign('direction', 'pro')">顺行</span>
                      <span :class="{ on: constModal.design.direction === 'retro' }" title="逆行 116.5651°" @click="setDesign('direction', 'retro')">逆行</span>
                    </span>
                  </div>
                  <div class="cefv"><label>远地点高度 hₐ</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('apogeeKm') }" :model-value="constModal.design.apogeeKm" :step="10" @commit="v => setDesign('apogeeKm', v)" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>近地点高度 hₚ</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('perigeeKm') }" :model-value="constModal.design.perigeeKm" :min="80" :step="10" @commit="v => setDesign('perigeeKm', v)" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>升交点经度 λ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.anLonDeg" :min="-180" :max="180" :step="1" @commit="v => setDesign('anLonDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cefv"><label>近地点幅角 ω</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.argpDeg" :step="1" @commit="v => setDesign('argpDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'criticalSunSync'">
                  <div class="cefv"><label>近地点高度 hₚ</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('perigeeKm') }" :model-value="constModal.design.perigeeKm" :min="80" :step="10" @commit="v => setDesign('perigeeKm', v)" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>升交点经度 λ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.anLonDeg" :min="-180" :max="180" :step="1" @commit="v => setDesign('anLonDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cefv"><label>近地点幅角 ω</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.argpDeg" :step="1" @commit="v => setDesign('argpDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'geosync'">
                  <div class="cefv"><label>星下点经度 λ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.subLonDeg" :min="-180" :max="180" :step="0.1" @commit="v => setDesign('subLonDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cefv"><label>轨道倾角 i</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('inclDeg') }" :model-value="constModal.design.inclDeg" :min="0" :max="180" :step="0.1" @commit="v => setDesign('inclDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'molniya'">
                  <div class="cefv"><label>远地点经度 λₐ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.apogeeLonDeg" :min="-180" :max="180" :step="1" @commit="v => setDesign('apogeeLonDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cefv"><label>近地点高度 hₚ</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('perigeeKm') }" :model-value="constModal.design.perigeeKm" :min="80" :step="10" @commit="v => setDesign('perigeeKm', v)" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>近地点幅角 ω</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.argpDeg" :step="1" @commit="v => setDesign('argpDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'repeat'">
                  <div class="cefv"><label>轨道倾角 i</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('inclDeg') }" :model-value="constModal.design.inclDeg" :min="0" :max="180" :step="0.1" @commit="v => setDesign('inclDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cetpf">
                    <div><small>回归圈数 k</small><NumBox class="ci" :class="{ bad: constFieldBad('k') }" :model-value="constModal.design.k" :min="1" :step="1" @commit="v => setDesign('k', v)" /></div>
                    <div><small>回归天数 m</small><NumBox class="ci" :class="{ bad: constFieldBad('m') }" :model-value="constModal.design.m" :min="1" :step="1" @commit="v => setDesign('m', v)" /></div>
                  </div>
                  <div class="cefv"><label>升交点经度 λ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.anLonDeg" :min="-180" :max="180" :step="1" @commit="v => setDesign('anLonDeg', v)" /><span class="u">°</span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'repeatSunSync'">
                  <div class="cetpf">
                    <div><small>回归圈数 k</small><NumBox class="ci" :class="{ bad: constFieldBad('k') }" :model-value="constModal.design.k" :min="1" :step="1" @commit="v => setDesign('k', v)" /></div>
                    <div><small>回归天数 m</small><NumBox class="ci" :class="{ bad: constFieldBad('m') }" :model-value="constModal.design.m" :min="1" :step="1" @commit="v => setDesign('m', v)" /></div>
                  </div>
                  <div class="cefv"><label>升交点经度 λ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.design.anLonDeg" :min="-180" :max="180" :step="1" @commit="v => setDesign('anLonDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cef"><label>地方时</label>
                    <span class="seg3">
                      <span :class="{ on: constModal.design.localMode !== 'ltdn' }" @click="setDesign('localMode', 'ltan')">升交点</span>
                      <span :class="{ on: constModal.design.localMode === 'ltdn' }" @click="setDesign('localMode', 'ltdn')">降交点</span>
                    </span>
                  </div>
                  <div class="cefv"><label>{{ constModal.design.localMode === 'ltdn' ? 'LTDN' : 'LTAN' }}</label><div class="ceinp"><input class="ci" :class="{ bad: constFieldBad('localTime') }" :value="constModal.design.localTime" placeholder="hh:mm" title="平太阳时，与视太阳相差时差 ≤16 min" @change="e => setDesign('localTime', e.target.value)" @keyup.enter="e => setDesign('localTime', e.target.value)" /><span class="u"></span></div></div>
                </template>
                <template v-else-if="constModal.orbitType === 'sunSync'">
                  <div class="cef"><label>由谁定</label>
                    <span class="seg3">
                      <span :class="{ on: constModal.design.driver !== 'incl' }" @click="setDesign('driver', 'alt')">高度</span>
                      <span :class="{ on: constModal.design.driver === 'incl' }" @click="setDesign('driver', 'incl')">倾角</span>
                    </span>
                  </div>
                  <div v-if="constModal.design.driver !== 'incl'" class="cefv"><label>轨道高度 h</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('altKm') }" :model-value="constModal.design.altKm" :min="80" :step="10" @commit="v => setDesign('altKm', v)" /><span class="u">km</span></div></div>
                  <div v-else class="cefv"><label>轨道倾角 i</label><div class="ceinp"><NumBox class="ci" :class="{ bad: constFieldBad('inclDeg') }" :model-value="constModal.design.inclDeg" :min="90" :max="180" :step="0.01" @commit="v => setDesign('inclDeg', v)" /><span class="u">°</span></div></div>
                  <div class="cef"><label>地方时</label>
                    <span class="seg3">
                      <span :class="{ on: constModal.design.localMode !== 'ltdn' }" @click="setDesign('localMode', 'ltan')">升交点</span>
                      <span :class="{ on: constModal.design.localMode === 'ltdn' }" @click="setDesign('localMode', 'ltdn')">降交点</span>
                    </span>
                  </div>
                  <div class="cefv"><label>{{ constModal.design.localMode === 'ltdn' ? 'LTDN' : 'LTAN' }}</label><div class="ceinp"><input class="ci" :class="{ bad: constFieldBad('localTime') }" :value="constModal.design.localTime" placeholder="hh:mm" title="平太阳时，与视太阳相差时差 ≤16 min" @change="e => setDesign('localTime', e.target.value)" @keyup.enter="e => setDesign('localTime', e.target.value)" /><span class="u"></span></div></div>
                </template>
              </template>

              <!-- 自定义根数：原来那套六根数表单，一项不少（数字框统一换成 NumBox：草稿串 + 失焦落值） -->
              <template v-else>
                <div class="cesec">轨道尺寸与形状</div>
                <div class="cef"><label>轨道形状</label>
                  <span class="seg3">
                    <span :class="{ on: constModal.shape === 'circ' }" @click="constModal.shape = 'circ'">圆轨道</span>
                    <span :class="{ on: constModal.shape === 'ellip' }" @click="constModal.shape = 'ellip'">椭圆轨道</span>
                  </span>
                </div>
                <div class="cefv"><label>轨道倾角 i</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.incl" :min="0" :max="180" :step="0.1" @commit="v => constModal.incl = v" /><span class="u">°</span></div></div>
                <div class="cefv"><label>{{ constModal.shape === 'ellip' ? '近地点高度 hₚ' : '轨道高度 h' }}</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.perigeeKm" :min="80" :step="10" @commit="v => constModal.perigeeKm = v" /><span class="u">km</span></div></div>
                <template v-if="constModal.shape === 'ellip'">
                  <div class="cefv"><label>远地点高度 hₐ</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.apogeeKm" :step="10" @commit="v => constModal.apogeeKm = v" /><span class="u">km</span></div></div>
                  <div class="cefv"><label>近地点幅角 ω</label><div class="ceinp"><NumBox class="ci" :model-value="constModal.argp" :step="1" @commit="v => constModal.argp = v" /><span class="u">°</span></div></div>
                </template>
                <div class="cesec">星座定向与初始相位</div>
                <div class="cetpf">
                  <div><small>升交点赤经 Ω₀</small><NumBox class="ci" :model-value="constModal.raan0" :step="1" @commit="v => constModal.raan0 = v" /></div>
                  <div><small>初始平近点角 M₀</small><NumBox class="ci" :model-value="constModal.m0" :step="1" @commit="v => constModal.m0 = v" /></div>
                </div>
              </template>

              <!-- 布局参数：单星不问 T/P/F -->
              <template v-if="constModal.pattern !== 'single'">
                <div class="cesec">布局参数 (i : T/P/F)</div>
                <div class="cetpf">
                  <div><small>卫星总数 T</small><NumBox class="ci" :model-value="constModal.T" :min="1" :step="1" @commit="v => constModal.T = v" /></div>
                  <div v-if="constModal.pattern !== 'plane'"><small>轨道面数 P</small><NumBox class="ci" :model-value="constModal.P" :min="1" :step="1" @commit="v => constModal.P = v" /></div>
                  <div v-if="constModal.pattern !== 'plane'"><small>相位因子 F</small><NumBox class="ci" :model-value="constModal.F" :min="0" :step="1" @commit="v => constModal.F = v" /></div>
                </div>
              </template>

              <div class="cesec">显示外观</div>
              <label class="chk2"><input type="checkbox" v-model="constModal.colorByPlane" /><span>按轨道面配色</span></label>
              <div v-if="!constModal.colorByPlane" class="cef"><label>标识颜色</label><input class="clr" type="color" v-model="constModal.color" /></div>

              <div class="cesec">预览</div>
              <div class="cepv">
                <span class="pvsw"><button type="button" class="layersw" :class="{ on: focusStyle.orbOn }" role="switch" :aria-checked="focusStyle.orbOn ? 'true' : 'false'" :title="focusStyle.orbOn ? '隐藏轨道线' : '显示轨道线'" @click="toggleFocus('orbOn')"><i></i></button><span>轨道线</span></span>
                <span class="pvsw"><button type="button" class="layersw" :class="{ on: focusStyle.trkOn }" role="switch" :aria-checked="focusStyle.trkOn ? 'true' : 'false'" :title="focusStyle.trkOn ? '隐藏星下点轨迹' : '显示星下点轨迹'" @click="toggleFocus('trkOn')"><i></i></button><span>星下点轨迹</span></span>
                <span class="pvsw"><button type="button" class="layersw" :class="{ on: focusStyle.fpOn }" role="switch" :aria-checked="focusStyle.fpOn ? 'true' : 'false'" :title="focusStyle.fpOn ? '隐藏覆盖圈' : '显示覆盖圈'" @click="toggleFocus('fpOn')"><i></i></button><span>覆盖圈</span></span>
                <span class="pvsw"><button type="button" class="layersw" :class="{ on: focusStyle.coneOn }" role="switch" :aria-checked="focusStyle.coneOn ? 'true' : 'false'" :title="focusStyle.coneOn ? '隐藏覆盖锥' : '显示覆盖锥'" @click="toggleFocus('coneOn')"><i></i></button><span>覆盖锥</span></span>
              </div>
              <div class="cef"><label>聚焦</label>
                <span class="seg3">
                  <span :class="{ on: !constModal.pvAll }" title="只把预览星座的种子星（第 1 面第 1 颗）放进选中集" @click="constModal.pvAll = false">种子星</span>
                  <span :class="{ on: constModal.pvAll }" title="预览星座每一颗都进选中集，轨道线 / 星下点轨迹 / 覆盖圈逐颗画" @click="constModal.pvAll = true">全部</span>
                </span>
              </div>
              <div class="cef"><label>轨迹长度</label>
                <span class="seg3">
                  <span :class="{ on: focusStyle.trkSpanMode !== 'time' }" title="按轨道周期的倍数给长度" @click="setTrkSpanMode('rev')">轨迹圈数</span>
                  <span :class="{ on: focusStyle.trkSpanMode === 'time' }" title="按时长给长度（分钟）" @click="setTrkSpanMode('time')">轨迹周期</span>
                </span>
              </div>
              <div v-if="focusStyle.trkSpanMode !== 'time'" class="cefv"><label>轨迹圈数</label><div class="ceinp"><input class="ci" :value="trkVal('rev')" placeholder="1" @input="e => trkInput('rev', e)" @change="trkCommit('rev')" @blur="trkCommit('rev')" @keyup.enter="trkCommit('rev')" /><span class="u">圈</span></div></div>
              <div v-else class="cefv"><label>轨迹周期</label><div class="ceinp"><input class="ci" :value="trkVal('time')" placeholder="0" @input="e => trkInput('time', e)" @change="trkCommit('time')" @blur="trkCommit('time')" @keyup.enter="trkCommit('time')" /><span class="u">min</span></div></div>
              <div class="cef ceset"><span class="lnk" title="颜色 / 线粗 / 线型 / 覆盖圈口径等全部显示设置（与聚焦卫星同一份）" @click="openFocusSettings"><Icon name="sliders-horizontal" :size="12" /> 聚焦卫星显示设置…</span></div>

              <div v-if="constDerived" class="ceread" title="场景历元 t0">
                <div class="crcode">{{ constDerived.code }}</div>
                <div class="crsub">共 {{ constDerived.total }} 颗<template v-if="constModal.pattern !== 'plane' && constModal.pattern !== 'single'"> · 每面 {{ constDerived.S }} · 面间 {{ constDerived.phase }}°</template></div>
                <template v-if="constDerived.d">
                  <div class="crsub" data-i18n-skip>T = {{ constDerived.d.periodMin.toFixed(1) }} min · T_Ω = {{ constDerived.d.nodalPeriodMin.toFixed(1) }} min</div>
                  <div class="crsub" data-i18n-skip>a = {{ constDerived.d.aKm.toFixed(1) }} km · e = {{ constDerived.d.e.toFixed(6) }} · i = {{ constDerived.seed.inclDeg.toFixed(4) }}°</div>
                  <div class="crsub" data-i18n-skip>Ω = {{ constDerived.seed.raanDeg.toFixed(4) }}° · ω = {{ constDerived.seed.argpDeg.toFixed(4) }}° · M₀ = {{ constDerived.seed.m0Deg.toFixed(4) }}°</div>
                  <div class="crsub" data-i18n-skip>Ω̇ = {{ constDerived.d.raanRateDegDay >= 0 ? '+' : '' }}{{ constDerived.d.raanRateDegDay.toFixed(3) }} °/d · ω̇ = {{ constDerived.d.argpRateDegDay >= 0 ? '+' : '' }}{{ constDerived.d.argpRateDegDay.toFixed(3) }} °/d</div>
                  <div class="crsub" data-i18n-skip>LTAN {{ ltanText }}<template v-if="constDerived.d.repeat"> · 回归 {{ constDerived.d.repeat.k }}/{{ constDerived.d.repeat.m }}</template></div>
                  <div class="crsub" data-i18n-skip>星下点 λ = {{ constDerived.d.subLonDeg.toFixed(1) }}° · hₚ = {{ constDerived.d.perigeeKm.toFixed(1) }} km · hₐ = {{ constDerived.d.apogeeKm.toFixed(1) }} km</div>
                </template>
                <!-- 解不出来时这里就是那一句诊断（输入框同时加红框）；能解出来时才轮到 warns -->
                <div v-if="constDerived.errs.length" class="crwarn">{{ constDerived.errs.join('；') }}</div>
                <div v-else-if="constDerived.warns.length" class="crwarn">{{ constDerived.warns.join('；') }}</div>
              </div>
            </div>
            <div class="cefoot">
              <span class="cancel" @click="closeConstWizard">取消</span>
              <span class="save" @click="saveConstWizard">{{ constModal.id ? '更新' : '生成' }}</span>
            </div>
          </div>
          <template v-else>
            <!-- 卫星集面板：内置星座 / 卫星组 / 导入星历 / 自定义星座 一张有序表；地图 = 可见集并集 -->
            <SatLayersPanel
              :rows="setRows" :search-row="searchRow" :summary="setSummary" :solo="soloInfo" :expanded="expTag"
              :exp-items="expList" :exp-loading="expLoading" :exp-error="expErr" :exp-actions="expActions"
              :search="setSearch" :menu-items="setMenuItems" :add-items="addItems" :epoch="customList.length ? scenarioEpochLocal : null" :default-color="DEFAULT_SAT_HEX"
              @toggle="r => toggleSet(r.id)" @solo="r => soloSet(r.id)" @restore="restoreSets"
              @expand="r => expToggle(r.id, r.name)" @activate="setFocus" @action="setAction" @add="onAdd" @reorder="reorderSet"
              @color="setColorOf" @color-reset="r => setColorOf(r, '')" @rename="setRename"
              @search-input="v => onSearch({ target: { value: v } })" @search-clear="clearSearch" @search-pick="pickResult" @search-toggle-pick="toggleResultSel" @open-finder="openFinder"
              @epoch="v => applyScenarioEpoch(new Date(v))" @epoch-now="scenarioEpochNow"
              @list-action="(k, p) => expOnAction(k, p)" @list-activate="expLocate"
            />
            <SatFinderDialog
              :open="finderOpen" v-model:keyword="finderKw" :filters="satFilters" :satcat="satcatIdx" :pool="satPoolForFilter"
              :results="finderItems" :matched="finderHits.length" :groups="finderGroups" :reset-key="'finder' + finderTick"
              @update:filters="onSatFilterChange" @close="finderOpen = false" @show="finderShow" @save-group="finderSave" @add-to-group="finderAddTo" @clear="finderClear" @activate="expLocate"
            />
          <!-- 「加入组」弹出菜单：锚在成员表操作条按钮下沿；点遮罩关闭 -->
          <template v-if="expMenu">
            <div class="lmenu-bd" @mousedown="expMenu = null" @contextmenu.prevent="expMenu = null"></div>
            <div class="lmenu" :style="{ left: expMenu.x + 'px', top: expMenu.y + 'px' }">
              <div class="lmh">加入 {{ expMenu.sats.length }} 颗</div>
              <div class="lmi new" @click="expMenuNew"><Icon name="folder-plus" :size="12" /><span>新建组</span></div>
              <div v-for="g in satGroups.list.value" :key="g.id" class="lmi" :title="g.name" @click="expMenuTo(g)"><Icon name="layers" :size="12" /><span data-i18n-skip>{{ g.name }}</span><em>{{ g.sats.length }}</em></div>
            </div>
          </template>
          </template>
        </div>

        <!-- 覆盖等值线显示（GXT / KML 库） -->
        <div v-show="shellUi.side === 'gxt'" class="sview">
        <div v-if="covOpen" class="cov-side docked">
        <div class="sec">
          <div class="srow"><label>添加卫星</label>
            <select :value="covAddSel" @change="e => { covAddSel = e.target.value; addCovSat() }">
              <option value="" disabled>选择卫星…</option>
              <option v-for="s in covSats" :key="s.folder" :value="s.folder"
                      :disabled="covItems.some(i => i.folder === s.folder)">{{ s.displayName }}{{ s.lon != null ? `（${s.lon}°）` : '' }}</option>
            </select>
          </div>
          <div v-if="!covItems.length" class="tip">还没有卫星。</div>
        </div>

        <!-- 每颗已添加卫星 -->
        <div v-for="it in covItems" :key="it.id" class="sec satcard">
          <div class="sath">
            <span class="satn">{{ idxOf(it.folder)?.displayName }} <em v-if="idxOf(it.folder)?.lon != null">{{ idxOf(it.folder)?.lon }}°</em></span>
            <span class="seg sm">
              <span class="sg" :class="{ on: it.type === 'EIRP' }" @click="setItemType(it, 'EIRP')">EIRP</span>
              <span class="sg" :class="{ on: it.type === 'GT' }" @click="setItemType(it, 'GT')">G/T</span>
            </span>
            <span class="ic" title="定位" @click="focusCovSat(it)"><Icon name="crosshair" :size="12" /></span>
            <span class="ic del" title="移除该星" @click="removeCovSat(it)"><Icon name="x" :size="12" /></span>
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
              <span class="ic del" title="删除批次" @click="removeBatch(it, ba)"><Icon name="x" :size="12" /></span>
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
              <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" :value="ba.width" @input="e => onBatchWidth(it, ba, e)" /><span class="u">{{ ba.width }}</span></div>
            </template>
          </div>
          <div class="addbatch" @click="addBatch(it)"><Icon name="plus" :size="12" /> 新建批次</div>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="gxt-disp" :class="{ open: isSecOpen('gxt-disp', false) }" @click="toggleSec('gxt-disp', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('gxt-disp', false) }" :size="12" /><span>显示选项</span></div>
          <template v-if="isSecOpen('gxt-disp', false)">
          <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
          <div v-if="showBeamLabels" class="srow"><label>字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="beamLabelSize" @input="setBeamFont" /><span class="u">{{ beamLabelSize }}</span></div>
          <label v-if="showBeamLabels" class="chk2"><input type="checkbox" v-model="beamLabelBold" @change="redraw" /><span>粗体</span></label>
          <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
          <div v-if="showBore" class="srow"><label>大小</label><input class="rng" type="range" min="1" max="12" step="1" :value="boreSize" @input="setBoreSize" /><span class="u">{{ boreSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
          <div v-if="showContourLabels" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="20" step="1" :value="contourLabelSize" @input="setContourSize" /><span class="u">{{ contourLabelSize }}</span></div>
          <label v-if="showContourLabels" class="chk2"><input type="checkbox" v-model="contourLabelBold" @change="redraw" /><span>粗体</span></label>
          </template>
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
        </div>

        <!-- Polygon：协调区多边形的绘制 / 调点 / 扩缩 / 导出 -->
        <div v-show="shellUi.side === 'poly'" class="sview">
        <!-- 内容渲染直接跟活动栏 side 走（与外层标题/侧栏同源），不再依赖 polyOpen：后者存于另一份快照，
             与 shellUi.side 分处不同 localStorage，restoreSettings 会用旧快照的 false 覆盖活动栏刚打开的状态，
             导致侧栏有「Polygon（协调区）」标题却空白（偶发）。side==='poly' 即应显示，二者本就等价。 -->
        <div v-if="shellUi.side === 'poly'" class="cov-side poly-side docked">
        <div class="sec">
          <div class="sect acc" data-sec="poly-list" :class="{ open: isSecOpen('poly-list') }" @click="toggleSec('poly-list')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('poly-list') }" :size="12" /><span>协调区多边形</span><span class="lnk" title="从标准 GXT / KML 文件导入多边形（追加到列表，不影响已有；可多选）" @click.stop="importPolys"><Icon name="import" :size="12" /> 导入</span><span class="lnk" @click.stop="polyStartDraw"><Icon name="plus" :size="12" /> 绘制</span></div>
          <template v-if="isSecOpen('poly-list')">
          <div v-if="!polys.length && !polyDrawId" class="tip">暂无多边形。</div>
          <div v-for="pg in polys" :key="pg.id" class="plg" :class="{ act: polyDrawId === pg.id || polyEditId === pg.id || polyMoveId === pg.id, hid: pg.show === false }">
            <div class="plgh">
              <button type="button" class="layersw" :class="{ on: pg.show !== false }" role="switch" :aria-checked="pg.show !== false ? 'true' : 'false'" :title="pg.show !== false ? '隐藏该多边形（数据保留）' : '显示该多边形'" @click="togglePoly(pg)"><i></i></button>
              <input class="clr plgc" type="color" :value="pg.color" title="线条颜色（填充色未单独调过时跟随线色）" @input="polySetColor(pg, $event.target.value)" />
              <input class="plgn plgnm" v-model="pg.name" placeholder="名称" @change="polyRefresh" />
              <span class="plgi">{{ pg.pts.length }} 点</span>
              <span class="ic del" title="删除该多边形" @click="removePoly(pg)"><Icon name="x" :size="12" /></span>
            </div>
            <div class="plgg">
              <label class="plgf"><span class="plgl">数值</span><input class="plgv" v-model="pg.value" placeholder="如 -50" title="该区域标注的数值（如谱密度，单位不做定义）；导出 GXT 时作为该多边形等值线的值" @change="polyRefresh" /></label>
              <label class="plgf"><span class="plgl">轨位</span><input class="plgv" v-model="pg.satLon" placeholder="如 110.5" title="关联卫星轨道位置（东经为正，如 110.5 / -30）：导出 GXT 时写入 long_nom（GXT 必要信息）" @change="polyRefresh" /><span class="plgu">°E</span></label>
              <label class="plgf w2"><span class="plgl">卫星</span><input class="plgn" v-model="pg.satName" placeholder="关联卫星名称" title="关联卫星名称：导出 GXT 时写入 sat_name（GXT 必要信息）" @change="polyRefresh" /></label>
            </div>
            <div class="plgr sub">
              <span class="plgl">填充</span>
              <input type="checkbox" :checked="pg.fillOn !== false" title="显示 / 隐藏区域填充" @change="pg.fillOn = !(pg.fillOn !== false); polyRefresh()" />
              <input class="clr plgc" type="color" :value="pg.fillColor || pg.color" title="填充颜色（默认跟随线色，单独调整后两者独立）" @input="pg.fillColor = $event.target.value; polyRefresh()" />
              <input class="rng" type="range" min="0" max="1" step="0.01" :value="pg.fillOp != null ? pg.fillOp : 0.18" title="填充不透明度（0%＝透明）。与 GRD 覆盖重叠处只显示覆盖颜色，Polygon 在该处仅保留边线" @input="e => { pg.fillOp = Number(e.target.value); polyRefresh() }" />
              <span class="u pct">{{ Math.round((pg.fillOp != null ? pg.fillOp : 0.18) * 100) }}%</span>
            </div>
            <div class="plgr sub">
              <span class="plgl">线粗</span>
              <input class="rng" type="range" min="0.1" max="8" step="0.1" :value="pg.width" @input="e => { pg.width = Number(e.target.value); polyRefresh() }" />
              <span class="u">{{ pg.width }}</span>
              <span class="plgl">字号</span>
              <input class="rng" type="range" min="2" max="40" step="1" :value="pg.labelSize || 16" title="中央「名称 数值」标注字号（3D / 平面图同步）" @input="e => { pg.labelSize = Number(e.target.value); polyRefresh() }" />
              <span class="u">{{ pg.labelSize || 16 }}</span>
              <label class="chk-in" title="中央「名称 数值」标注粗体（3D / 平面图同步）"><input type="checkbox" :checked="!!pg.labelBold" @change="e => { pg.labelBold = e.target.checked; polyRefresh() }" /><span>粗体</span></label>
            </div>
            <div class="plgops">
              <span class="opb" :class="{ on: polyEditId === pg.id }" title="在平面图上直接拖动顶点调整位置" @click="polyEditToggle(pg)">{{ polyEditId === pg.id ? '完成调整' : '调整顶点' }}</span>
              <span class="opb" :class="{ on: polyMoveId === pg.id }" title="在平面图上按住多边形内部整体平移" @click="polyMoveToggle(pg)">{{ polyMoveId === pg.id ? '完成拖动' : '整体拖动' }}</span>
              <span class="opb" :class="{ on: polyDrawId === pg.id }" title="继续在地图上右键加顶点" @click="polyDrawId === pg.id ? null : polyContinue(pg)">{{ polyDrawId === pg.id ? '绘制中…' : '继续绘制' }}</span>
              <span class="opb" :class="{ on: polyVertsOpen === pg.id }" title="按坐标查看 / 编辑顶点" @click="vertsDraft = null; polyVertsOpen = polyVertsOpen === pg.id ? '' : pg.id">顶点表格</span>
              <span class="opb" title="复制出一个相同的多边形（整体略作偏移以便分辨），并直接进入整体拖动模式摆放" @click="polyCopy(pg)">复制</span>
              <span class="opb" title="按下方「扩/缩幅度」外扩一圈，生成新多边形（原多边形保留）" @click="polyOffset(pg, 1)">扩大</span>
              <span class="opb" title="按下方「扩/缩幅度」内收一圈，生成新多边形（原多边形保留）" @click="polyOffset(pg, -1)">缩小</span>
            </div>
            <div v-if="polyVertsOpen === pg.id" class="plgvt">
              <textarea class="plgta" :value="polyVertsVal(pg)" spellcheck="false" placeholder="每行一个顶点：经度, 纬度" @copy="onVertsCopy"
                        @input="vertsDraft = { id: pg.id, text: $event.target.value }" @change="polyVertsEdit(pg, $event)"></textarea>
              <span class="plgcp" title="复制全部顶点为两列（经度 ⇥ 纬度）：粘贴至 Excel / 表格自动分为经度、纬度两列" @click="copyPolyVerts(pg)"><Icon name="copy" :size="12" /> 复制两列</span>
            </div>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="poly-disp" :class="{ open: isSecOpen('poly-disp', false) }" @click="toggleSec('poly-disp', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('poly-disp', false) }" :size="12" /><span>显示与操作</span></div>
          <template v-if="isSecOpen('poly-disp', false)">
          <div class="srow"><label>顶点大小</label><input class="rng" type="range" min="1" max="12" step="0.5" :value="polyDotSize" @input="e => { polyDotSize = Number(e.target.value); polyRefresh() }" /><span class="u">{{ polyDotSize }}</span></div>
          <div class="srow"><label>扩/缩幅度</label><input class="ci" v-model="polyOffAmt" placeholder="如 0.5" @change="persistPolys" /><span class="u">°</span></div>
          </template>
        </div>

        <div class="csfoot">
          <span class="expb2" title="将当前绘制的覆盖等值线 + 协调区多边形一并导出为 GXT（所见即所得；多边形每个一条闭合等值线，值=数值栏）" @click="exportPolys('gxt')">导出 GXT</span>
          <span class="expb2" title="将当前绘制的覆盖等值线 + 协调区多边形一并导出为 KML（所见即所得；覆盖按档位渐变，多边形保留各自名称/数值/颜色）" @click="exportPolys('kml')">导出 KML</span>
          <span class="expb2" title="将当前绘制内容（覆盖等值线 + 显示中的多边形）作为一份快照发送到小程序，生成导入密钥" @click="sendToMiniapp">发送到小程序</span>
        </div>
        </div>
        </div>

        <!-- 卫星天线树（覆盖分析 GRD）：卫星 → 天线 → 性能指标表 -->
        <div v-show="shellUi.side === 'antenna'" class="sview">
        <div v-if="grdOpen" class="cov-side grd-side docked">
        <div class="sec">
          <div class="sect acc" data-sec="grd-tree" :class="{ open: isSecOpen('grd-tree') }" @click="toggleSec('grd-tree')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('grd-tree') }" :size="12" /><span>卫星 / 天线</span><span class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click.stop="openAddSat"><Icon name="plus" :size="12" /> 卫星</span><span class="lnk" title="只画等仰角线：填经纬度/轨道高度 + 仰角值即可，不建卫星图标/天线" @click.stop="openAddElevLine"><Icon name="plus" :size="12" /> 仰角线</span></div>
          <template v-if="isSecOpen('grd-tree')">
          <div class="gtree">
            <template v-for="sat in grdSats" :key="sat.folder">
              <div v-if="sat.kind === 'elevline'" class="gsat gsat-el">
                <Icon class="gsvg" name="angle" :size="16" />
                <span class="gsname" :title="sat.satName">{{ sat.satName }}</span>
                <span class="sdisp">
                  <span class="ic" :class="{ on: sat.elevShow }" :style="sat.elevShow ? { color: sat.elevColor } : {}" title="显示/隐藏该仰角线" @click.stop="toggleSatElev(sat)"><Icon name="angle" :size="12" /></span>
                </span>
                <span class="sacts">
                  <span class="ic" title="编辑仰角线" @click.stop="editElevLine(sat)"><Icon name="pencil" :size="12" /></span>
                  <span class="ic del" title="删除仰角线" @click.stop="removeSat(sat)"><Icon name="x" :size="12" /></span>
                </span>
              </div>
              <div v-else class="gsat" :class="{ exp: grd.isExpanded(sat.folder), cur: selFolderSet.has(sat.folder) }" :data-folder="sat.folder">
                <i class="tri" :class="{ open: grd.isExpanded(sat.folder) }" @click="grd.toggleExpand(sat.folder)"><Icon name="chevron-right" :size="12" /></i>
                <input type="checkbox" class="gck" :checked="grd.satState(sat) === 'all'" :indeterminate="grd.satState(sat) === 'some'" :disabled="!sat.antennas.length" :title="sat.antennas.length ? '全选 / 全不选该星天线' : '该星暂无天线'" @change="grd.toggleSatAll(sat)" />
                <!-- 卫星：与链路预算工作台模块图标同款几何（两翼 3×2 太阳能板 + 中央星体，整体 -20°） -->
                <svg class="gsvg sat-svg" viewBox="0 0 120 120" fill="currentColor" aria-hidden="true">
                  <g transform="rotate(-20 60 60)">
                    <rect x="8" y="41" width="10" height="16" rx="3" /><rect x="21" y="41" width="10" height="16" rx="3" /><rect x="34" y="41" width="10" height="16" rx="3" />
                    <rect x="8" y="63" width="10" height="16" rx="3" /><rect x="21" y="63" width="10" height="16" rx="3" /><rect x="34" y="63" width="10" height="16" rx="3" />
                    <rect x="76" y="41" width="10" height="16" rx="3" /><rect x="89" y="41" width="10" height="16" rx="3" /><rect x="102" y="41" width="10" height="16" rx="3" />
                    <rect x="76" y="63" width="10" height="16" rx="3" /><rect x="89" y="63" width="10" height="16" rx="3" /><rect x="102" y="63" width="10" height="16" rx="3" />
                    <rect x="49" y="35" width="22" height="50" rx="10" />
                  </g>
                </svg>
                <span class="gsname" @click="grd.toggleExpand(sat.folder)" @dblclick.stop="focusTreeSat(sat, { force: true })" :title="sat.satName">{{ sat.satName }}<em v-if="sat.antennas.length">{{ sat.antennas.length }}</em><i v-if="sat.elements" class="simtag" title="轨道根数模拟星：星下点随时间移动">轨</i></span>
                <span v-if="linkMissSet.has(sat.folder)" class="lmiss" :title="`关联卫星 NORAD ${sat.noradId} 不在当前星历中`"><Icon name="alert-triangle" :size="12" /></span>
                <!-- 视图开关：聚焦 / 跟随该星（对星树同款）＋ 显示卫星名 / 仰角线（色随该星颜色，在「✎」里改）；图标按钮，与右侧操作图标以竖线分组 -->
                <span class="sdisp">
                  <span class="ic" :class="{ on: treeNav(sat).focusOn, dis: treeNav(sat).focusDis }" :title="treeNav(sat).focusTip" @click.stop="onTreeFocusBtn(sat, $event)"><Icon name="crosshair" :size="12" /></span>
                  <span class="ic" :class="{ on: treeNav(sat).followOn, dis: treeNav(sat).followDis }" :title="treeNav(sat).followTip" @click.stop="onTreeFollowBtn(sat)"><Icon name="locate-fixed" :size="12" /></span>
                  <span class="ic" :class="{ on: satVisible(sat) }" title="显示/隐藏该卫星（图标 + 名称）；如需只隐藏图标或只隐藏名称，在「卫星设置」里单独勾选" @click.stop="toggleSatLabel(sat)"><Icon :name="satVisible(sat) ? 'eye' : 'eye-off'" :size="12" /></span>
                  <span class="ic" :class="{ on: sat.elevShow }" :style="sat.elevShow ? { color: sat.elevColor } : {}" title="显示/隐藏等仰角线（需先在「✎」里填仰角值，如 5,10）" @click.stop="toggleSatElev(sat)"><Icon name="angle" :size="12" /></span>
                </span>
                <span class="sacts">
                  <span class="ic" title="在该星下新建天线" @click.stop="openAntAddMenu($event, 'tree', { folder: sat.folder })"><Icon name="plus" :size="12" /></span>
                  <span class="ic" title="编辑卫星 / 仰角线 / 颜色" @click.stop="editSat(sat)"><Icon name="pencil" :size="12" /></span>
                  <span class="ic del" title="删除卫星（含其天线）" @click.stop="removeSat(sat)"><Icon name="x" :size="12" /></span>
                </span>
              </div>
              <div v-if="sat.kind !== 'elevline' && grd.isExpanded(sat.folder)" class="gbody">
                <div v-if="!sat.antennas.length" class="gant noant">暂无天线。</div>
                <template v-for="a in sat.antennas" :key="a.name">
                <div class="gant" :class="{ on: grd.isSelected(sat.folder, a.name), foc: grd.isActive(sat.folder, a.name) }" title="点击编辑该天线参数（不影响是否显示）" @click="onTreeAntClick(sat, a)">
                  <input type="checkbox" class="gck" title="勾选＝在地图上显示该天线覆盖范围" :checked="grd.isSelected(sat.folder, a.name)" @click.stop @change="grd.toggleAnt(sat, a)" />
                  <span class="ant-btn" :class="{ on: grd.isSelected(sat.folder, a.name) }" :title="grd.isSelected(sat.folder, a.name) ? '点击隐藏该天线覆盖范围' : '点击在地图上显示该天线覆盖范围'" @click.stop="grd.toggleAnt(sat, a)">
                    <svg v-if="grd.isSelected(sat.folder, a.name)" class="gsvg ant-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" /><path d="M17 13a6 6 0 0 0-6-6" /><path d="M21 13A10 10 0 0 0 11 3" />
                    </svg>
                    <svg v-else class="gsvg ant-svg ant-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 10a7.31 7.31 0 0 0 10 10Z" /><path d="m9 15 3-3" />
                    </svg>
                  </span>
                  <template v-if="grdEditAnt === grd.keyOf(sat.folder, a.name)">
                    <input class="aname-in" v-model="grdEditVal" @click.stop @keydown.enter="commitRenameAnt(sat, a)" @blur="commitRenameAnt(sat, a)" />
                    <span class="ic ok" title="确认重命名" @mousedown.prevent @click.stop="commitRenameAnt(sat, a)"><Icon name="check" :size="12" /></span>
                  </template>
                  <template v-else>
                    <span class="aname" title="双击重命名" @dblclick.stop="startRenameAnt(sat, a)" data-i18n-skip>{{ a.name }}</span>
                    <span v-if="grd.isActive(sat.folder, a.name)" class="afoc">编辑中</span>
                    <span class="sacts">
                      <span class="ic" title="重命名天线" @click.stop="startRenameAnt(sat, a)"><Icon name="pencil" :size="12" /></span>
                      <span class="ic del" title="删除天线" @click.stop="grd.removeAntenna(sat.folder, a.name)"><Icon name="x" :size="12" /></span>
                    </span>
                  </template>
                </div>
                <div class="gperf" :class="{ on: perfOpenSet.has(grd.keyOf(sat.folder, a.name)) }" title="打开该天线的性能指标表（独立窗口；再点＝前置）" @click.stop="openPerf(sat, a)">
                  <svg class="gsvg perf-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" />
                  </svg>
                  <span class="gperfn">性能指标表</span>
                  <!-- 眼睛：这张表的城市在地图上的标记与标签（总开关，随选项存盘；与表窗口开没开无关，关窗标记还在） -->
                  <span class="sdisp">
                    <span class="ic" :class="{ on: perf.cityShowOf(grd.keyOf(sat.folder, a.name)) }" title="显示/隐藏该表城市在地图上的标记与标签；只隐藏其一，在表窗口「城市设置」里勾选" @click.stop="togglePerfCity(sat, a)"><Icon :name="perf.cityShowOf(grd.keyOf(sat.folder, a.name)) ? 'eye' : 'eye-off'" :size="12" /></span>
                  </span>
                </div>
                </template>
              </div>
            </template>
          </div>
          </template>
        </div>

        <!-- 天线设置四区（波束/参数/电平/填充/指向/显示）＝ 与「对星覆盖分析」共用的同一个组件 -->
        <GrdSetSections :grd="grd" variant="ground" :sat-search="satcovSearch" @open-synth="openSynthGroup" />

        <div class="csfoot">
          <span v-if="grdLoading" class="cst">载入中…</span>
          <span class="cclr" title="清空地图上的填充/等值线/仰角线，保留各天线设置与卫星列表" @click="grdClearDrawing">清除绘图</span>
        </div>
        </div>
        <!-- 卫星行「＋」：新建天线的两条路（与 .lmenu 同一层级与视觉，锚在按钮下沿） -->
        <template v-if="antAddMenu && antAddMenu.src === 'tree'">
          <div class="lmenu-bd" @mousedown="antAddMenu = null" @contextmenu.prevent="antAddMenu = null"></div>
          <div class="lmenu antm" :style="{ left: antAddMenu.x + 'px', top: antAddMenu.y + 'px' }">
            <div class="lmi" @click="antAddPick('gauss')"><Icon name="waves" :size="12" /><span>高斯天线</span></div>
            <div class="lmi" @click="antAddPick('grd')"><Icon name="import" :size="12" /><span>导入 GRD…</span></div>
          </div>
        </template>
        </div>

        <!-- 对星覆盖分析：同一棵天线树，投影面从地球换成轨道壳层。面板整体在 SatCovPanel 里，
             对星性能指标表浮窗挂在页面根部。 -->
        <div v-show="shellUi.side === 'satcov'" class="sview">
          <SatCovPanel
            v-if="shellUi.side === 'satcov'"
            :sc="satcov" :grd="grd" :sat-count="shownCount" :sat-search="satcovSearch"
            :table-open-keys="shellOpenSet" :sat-vis="satVisible" :sel-folders="selFolderSet" :link-miss="linkMissSet" :follow-id="followLinkId" :flat="flatView" :geo-ids="treeGeoIdMap"
            @open-table="satcovOpenTable" @pick-shells="satcovOpenPick" @toggle-eye="toggleSatLabel"
            @add-sat="openAddSat()" @edit-sat="editSat" @remove-sat="removeSat"
            @focus-sat="(n, f, add) => focusTreeSat(n, { force: f, additive: !!add })" @follow-sat="followTreeSat" @add-ant="onTreeAddAnt" @open-synth="openSynthGroup" />
        </div>

        <!-- 波束合成（独立视图，SATSOFT 同款）：导航器（卫星 ▸ 波束组） ＋ 检查器（选中组/设置的编辑器）。
             一组＝一根天线，挂到该卫星下由「对地覆盖分析」视图管理显示/电平/指向/导出（工具 → 产物）。 -->
        <div v-show="shellUi.side === 'beams'" class="sview">
        <div v-if="shellUi.side === 'beams'" class="cov-side bs-side docked">

        <!-- ===== 导航器：卫星 + 波束组列表 ===== -->
        <div class="sec">
          <div class="srow"><label>卫星</label>
            <select :value="bs.satFolder.value" title="卫星来自「对地覆盖分析」视图" @change="e => bsSetSat(e.target.value)">
              <option v-if="!bsSats.length" value="">（暂无卫星）</option>
              <option v-for="st in bsSats" :key="st.folder" :value="st.folder">{{ st.satName }}</option>
            </select>
          </div>
          <div v-if="bs.satPos()" class="tip">星下点 {{ fmtGeoSlot(bs.satPos().lon) }}{{ Math.abs(bs.satPos().lat || 0) > 0.05 ? ', ' + bs.satPos().lat.toFixed(2) + '°N' : '' }} · 高度 {{ Math.round(bs.satPos().altKm).toLocaleString() }} km</div>
          <div class="bs-grps">
            <div v-for="g in bs.groupsForSat.value" :key="g.id" class="bs-grow" :class="{ on: g.id === bs.activeGroupId.value, hid: !g.pinned && g.id !== bs.activeGroupId.value }" @click="bsSelectGroup(g)">
              <span class="bs-gk" :class="g.mode">{{ g.mode === 'stk' ? '高斯' : g.mode === 'pam' ? '相控阵' : g.mode === 'gauss' ? '多馈源' : '赋形' }}</span>
              <span class="bs-gname" :title="g.name" data-i18n-skip>{{ g.name }}</span>
              <span class="bs-gcnt">{{ bs.groupStat(g).n }}{{ bs.groupStat(g).unit }}</span>
              <span class="gic" :title="g.pinned ? '取消常显（切换到其它组编辑时自动隐藏本组草图）' : (g.id === bs.activeGroupId.value ? '常显本组（切换到其它组编辑后仍保留显示，用于比对）' : '仅显示编辑中的组；点击常显本组草图以便和其它组比对')" @click.stop="bs.toggleGroupVisible(g.id)"><Icon :name="(g.pinned || g.id === bs.activeGroupId.value) ? 'eye' : 'eye-off'" :size="12" /></span>
              <span class="gic" title="复制该组" @click.stop="bs.duplicateGroup(g.id)"><Icon name="copy" :size="12" /></span>
              <span class="gic del" title="删除该组（不影响已生成的天线）" @click.stop="bsRemoveGroup(g)"><Icon name="x" :size="12" /></span>
            </div>
            <div v-if="!bs.groupsForSat.value.length" class="bs-empty">还没有波束组。</div>
          </div>
          <div class="bs-addrow">
            <span class="opb" :class="{ dis: !bsSats.length }" title="新建高斯波束组（STK Gaussian 天线模型：按真实离轴角的解析高斯方向图；口径 / 波束宽 / 峰值增益三选一驱动；生成后本组改动自动同步到天线）" @click="bsAddGroup('stk')">＋高斯组</span>
            <span class="opb" :class="{ dis: !bsSats.length }" title="新建多馈源反射面（点/椭圆波束群；一组内可多设置混合宽度，如 0.8+0.9+1.6°）" @click="bsAddGroup('gauss')">＋多馈源组</span>
            <span class="opb" :class="{ dis: !bsSats.length }" title="新建赋形反射面（Polygon 覆盖区并集，馈源阵赋形合成）" @click="bsAddGroup('shaped')">＋赋形组</span>
            <span class="opb" :class="{ dis: !bsSats.length }" title="新建相控阵（SATSOFT §6.5 PAM：矩形阵 + Butler 矩阵，sinc 波束群，可电扫到任意指向）" @click="bsAddGroup('pam')">＋相控阵组</span>
          </div>
          <div class="bs-navops">
            <span class="opb sm" :class="{ dis: !bs.groupsForSat.value.length }" title="当前卫星下每个组各生成一副天线" @click="bsGenerateAll"><Icon name="check" :size="12" /> 全部生成</span>
            <span class="opb sm" :class="{ dis: !bs.canUndo.value }" title="撤销（当前组）" @click="bs.undo"><Icon name="undo-2" :size="12" /> 撤销</span>
            <span class="opb sm" :class="{ dis: !bs.canRedo.value }" title="重做（当前组）" @click="bs.redo"><Icon name="redo-2" :size="12" /> 重做</span>
          </div>
        </div>

        <!-- ===== 检查器：选中组的编辑器（类型由节点决定，不再切 tab） ===== -->
        <template v-if="bs.hasGroup.value">
        <div class="sec">
          <div class="sect" data-sec="bs-mode"><span>{{ bs.mode.value === 'stk' ? '高斯波束 · STK' : bs.mode.value === 'pam' ? '相控阵' : bs.mode.value === 'gauss' ? '多馈源反射面' : '赋形反射面' }}</span></div>
          <div class="srow"><label>组名</label><input class="ci wide" :value="bsNameVal()" @input="bsNameEdit = $event.target.value" @change="bsNameCommit" @blur="bsNameCommit"
                 placeholder="天线名（同名再生成即更新；同星不可重名）" /></div>
        </div>

        <!-- 波束设置（波束类型选择器，上提）：每个设置 = 一种波束类型（= 一套独立反射面）；下面「天线参数」编辑当前设置的反射面 -->
        <!-- 高斯组（stk）共用这一块：每个设置 = 一个命名方向图模型，徽标上的宽度 = 模型 θ3 -->
        <div v-if="bs.mode.value === 'gauss' || bs.mode.value === 'stk'" class="sec">
          <div class="sect acc" data-sec="bs-settings" :class="{ open: isSecOpen('bs-settings') }" @click="toggleSec('bs-settings')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-settings') }" :size="12" /><span>波束设置</span><span class="bs-cnt">{{ bs.settings.value.length }} 种波束</span></div>
          <template v-if="isSecOpen('bs-settings')">
          <div class="bs-chips">
            <span v-for="s in bs.settings.value" :key="s.id" class="bs-chip" :class="{ on: s.id === bs.activeSettingId.value }" :title="'激活并按此波束类型放置：' + s.name" @click="bs.selectSetting(s.id)"><i :style="{ background: s.color }"></i>{{ s.name }}<em>{{ Number(s.thX).toFixed(2) }}°</em></span>
            <span class="bs-chip add" :title="bs.mode.value === 'stk' ? '新增一种波束类型（复制当前方向图参数，再改口径 / 波束宽 / 峰值增益）' : '新增一种波束类型（复制当前反射面，再改口径/馈源做出不同波束宽）'" @click="bs.addSetting()">＋</span>
          </div>
          <template v-if="bs.curSetting.value">
            <div class="srow"><label>设置名</label><input class="ci" :value="bs.curSetting.value.name" @input="e => bs.renameSetting(bs.curSetting.value.id, e.target.value)" /><input class="clr" type="color" :value="bs.curSetting.value.color" title="该波束类型轮廓/中心点颜色" @input="e => bsSetSettingColor(e.target.value)" /><span class="opb sm" :class="{ dis: bs.settings.value.length <= 1 }" title="删除本波束类型" @click="bs.removeSetting(bs.curSetting.value.id)">删除</span></div>
          </template>
          </template>
        </div>

        <!-- 高斯组方向图 = 当前波束设置的 STK Gaussian 模型（口径 / 波束宽 / 峰值增益三选一驱动；与覆盖分析「方向图」同一组参数行） -->
        <div v-if="bs.mode.value === 'stk' && bs.curSetting.value" class="sec">
          <div class="sect acc" data-sec="bs-stk" :class="{ open: isSecOpen('bs-stk') }" @click="toggleSec('bs-stk')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-stk') }" :size="12" /><span>方向图</span><span class="bs-cnt" data-i18n-skip>{{ bs.curSetting.value.name }}</span></div>
          <template v-if="isSecOpen('bs-stk')">
            <GaussModelFields :model="bs.curSetting.value" @update="bsStkUpdate" />
          </template>
        </div>

        <!-- 天线参数 = 当前波束设置的反射面（每设置一套独立反射面） -->
        <div v-if="bs.mode.value === 'gauss' && bs.curSetting.value" class="sec">
          <div class="sect acc" data-sec="bs-antp" :class="{ open: isSecOpen('bs-antp') }" @click="toggleSec('bs-antp')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-antp') }" :size="12" /><span>天线参数</span><span class="bs-cnt">{{ bs.curSetting.value.name }} · 解析反射面</span></div>
          <template v-if="isSecOpen('bs-antp')">
          <div class="srow"><label>设计频率</label><input class="ci" type="number" step="0.1" v-model.number="bs.curSetting.value.fGHz" /><span class="u">GHz</span><span class="bs-wl">{{ bsFmt(bs.refl.value && bs.refl.value.lamDesignCm, 2) }} cm</span></div>
          <div class="srow"><label>仿真频率</label>
            <label class="chk-in" title="勾选＝仿真频率同设计频率（方向图按设计频率计算）；取消可单独指定（波束宽/方向性随 λ 变化）"><input type="checkbox" :checked="bs.curSetting.value.simSame !== false" @change="bsSimSameToggle($event.target.checked)" /></label>
            <!-- SATSOFT 同款：勾选时输入框保持全宽、置灰、镜像显示设计频率实时值 -->
            <input v-if="bs.curSetting.value.simSame !== false" key="fsim-mirror" class="ci" type="number" :value="bs.curSetting.value.fGHz" disabled /><input v-else key="fsim-own" class="ci" type="number" step="0.1" v-model.number="bs.curSetting.value.fSim" /><span class="u">GHz</span><span class="bs-wl">{{ bsFmt(bs.refl.value && bs.refl.value.lamSimCm, 2) }} cm</span>
          </div>
          <!-- 口径 ⟷ 3dB 波束宽：二选一驱动（选中者填、另一者只读自动算，对齐 SATSOFT 单选按钮） -->
          <div class="srow bs-drv" :class="{ act: bs.curSetting.value.apDriver === 'aperture' }">
            <span class="rdo" :class="{ on: bs.curSetting.value.apDriver === 'aperture' }" @click="bs.curSetting.value.apDriver = 'aperture'" title="选此＝填口径，波束宽自动算"></span>
            <label @click="bs.curSetting.value.apDriver = 'aperture'">天线口径</label>
            <input class="ci" type="number" step="0.1" :disabled="bs.curSetting.value.apDriver !== 'aperture'" v-model.number="bs.curSetting.value.antD" /><span class="u">m</span>
          </div>
          <div class="srow bs-drv" :class="{ act: bs.curSetting.value.apDriver === 'beamwidth' }">
            <span class="rdo" :class="{ on: bs.curSetting.value.apDriver === 'beamwidth' }" @click="bs.curSetting.value.apDriver = 'beamwidth'" title="选此＝填 3dB 波束宽，口径自动算"></span>
            <label @click="bs.curSetting.value.apDriver = 'beamwidth'">3dB 宽</label>
            <input class="ci" type="number" step="0.01" :disabled="bs.curSetting.value.apDriver !== 'beamwidth'" v-model.number="bs.curSetting.value.bw3" /><span class="u">°</span>
          </div>
          <div class="bs-read"><span>口径 circular · F/D <b>{{ bsFmt(bs.refl.value && bs.refl.value.fd, 2) }}</b></span></div>
          <!-- 焦距 ⟷ 馈源间距：二选一驱动 -->
          <div class="srow bs-drv" :class="{ act: bs.curSetting.value.fdDriver === 'focal' }">
            <span class="rdo" :class="{ on: bs.curSetting.value.fdDriver === 'focal' }" @click="bs.curSetting.value.fdDriver = 'focal'" title="选此＝填焦距，馈源间距自动算"></span>
            <label @click="bs.curSetting.value.fdDriver = 'focal'">焦距</label>
            <input class="ci" type="number" step="0.1" :disabled="bs.curSetting.value.fdDriver !== 'focal'" v-model.number="bs.curSetting.value.foc" /><span class="u">m</span>
          </div>
          <div class="srow bs-drv" :class="{ act: bs.curSetting.value.fdDriver === 'feedspacing' }">
            <span class="rdo" :class="{ on: bs.curSetting.value.fdDriver === 'feedspacing' }" @click="bs.curSetting.value.fdDriver = 'feedspacing'" title="选此＝填馈源间距，焦距自动算"></span>
            <label @click="bs.curSetting.value.fdDriver = 'feedspacing'">馈源间距</label>
            <input class="ci" type="number" step="0.05" :disabled="bs.curSetting.value.fdDriver !== 'feedspacing'" v-model.number="bs.curSetting.value.feedSpacingWl" /><span class="u">WL</span>
          </div>
          <div class="srow"><label>馈源直径</label>
            <label class="chk-in" title="Auto＝馈源直径 = 馈源间距（多馈源恰好相接不交叠）；取消可手动输入——馈源直径是控制口径效率的核心：越大→边缘照射越低（更聚焦）→溢出越小、效率越高"><input type="checkbox" :checked="bs.curSetting.value.feedDiaAuto !== false" @change="bs.curSetting.value.feedDiaAuto = $event.target.checked" /><span>Auto</span></label>
            <input class="ci" type="number" step="0.05" :disabled="bs.curSetting.value.feedDiaAuto !== false" v-model.number="bs.curSetting.value.feedDiaWl" /><span class="u">WL</span>
          </div>
          <div v-if="bs.curSetting.value.feedDiaAuto === false && bs.refl.value && bs.refl.value.ok && Number(bs.curSetting.value.feedDiaWl) > bs.refl.value.feedSpacingWl + 1e-4" class="tip warn" title="单波束效率读数仍有效；多波束需加大波束间距或减小馈源直径">⚠ 馈源直径 &gt; 馈源间距（{{ bsFmt(bs.refl.value.feedSpacingWl, 2) }} WL）：多馈源会交叠。</div>
          <div class="srow"><label>馈源模型</label>
            <select v-model="bs.curSetting.value.feedModel">
              <option value="te11">circular TE11</option>
              <option value="potter">TE11+TM11 (Potter)</option>
            </select>
          </div>
          <div class="srow"><label>偏置净空/D</label><input class="ci" type="number" step="0.05" min="-0.5" v-model.number="bs.curSetting.value.offsetClr" title="偏置净空占口径直径的比例：0=贴轴偏置，-0.5=正馈（对称抛物面）" /><span class="u"></span></div>
          <div class="srow"><label>极化类型</label>
            <select v-model="bs.curSetting.value.pol">
              <option value="linX">线极化 X</option><option value="linY">线极化 Y</option>
              <option value="rhcp">右旋圆极化</option><option value="lhcp">左旋圆极化</option>
            </select>
          </div>
          <div class="bs-read2">
            <span>口径效率 <b>{{ bsFmt(bs.refl.value && bs.refl.value.effPct, 2) }}</b>%</span>
            <span>方向性 <b>{{ bsFmt(bs.refl.value && bs.refl.value.dirDbi, 2) }}</b> dBi</span>
            <span title="馈源在反射面边缘的照射电平（相对中心）：馈源直径决定它，它决定效率与波束宽">边缘照射 <b>{{ bsFmt(bs.refl.value && bs.refl.value.edgeDb, 2) }}</b> dB</span>
          </div>
          <div class="bs-read"><span title="仿真频率下的 3dB 波束宽（同设计时即设计波束宽）">波束宽 <b>{{ bsFmt(bs.refl.value && bs.refl.value.th3Sim, 3) }}</b>°</span><span>馈源 <b>{{ bsFmt(bs.refl.value && bs.refl.value.feedCm, 2) }}</b> cm</span><span>波束间距 <b>{{ bsFmt(bs.refl.value && bs.refl.value.beamSpacingDeg, 3) }}</b>° · 交叉 <b>{{ bsFmt(bs.crossX.value, 2) }}</b> dB</span></div>
          <div class="bs-refl" v-html="bsReflSvg"></div>
          <div class="bs-reflbar">
            <span class="pgb" @click="bsReflView = bsReflView === 1 ? 2 : 1">◀</span>
            <span class="bs-reflpg">{{ bsReflView }}/2</span>
            <span class="pgb" @click="bsReflView = bsReflView === 1 ? 2 : 1">▶</span>
            <span class="bs-reflcap">{{ bsReflView === 1 ? '从反射面背后朝地球方向看' : '反射面侧视图' }}</span>
          </div>
          </template>
        </div>

        <!-- 相控阵覆盖方式：点波束群（放置电扫波束）/ 赋形覆盖（Butler beamlet minimax → 星上激励指令） -->
        <div v-if="bs.mode.value === 'pam'" class="sec">
          <div class="srow"><label>覆盖方式</label>
            <span class="seg sm">
              <span class="sg" :class="{ on: bs.p.pamCover !== 'shaped' }" title="点/多波束群：在地图上放置电扫波束（每波束由阵面 Butler 电扫到该指向，sinc 旁瓣/栅瓣/扫描损失内建）" @click="bs.p.pamCover = 'spot'">点波束群</span>
              <span class="sg" :class="{ on: bs.p.pamCover === 'shaped' }" title="赋形覆盖：Polygon 覆盖区 → Butler beamlet minimax 合成赋形等值线，产出测控上注星上波束成形网络（BFN）的激励指令（SATSOFT §6.5 + §8/§9/§10）" @click="bs.p.pamCover = 'shaped'">赋形覆盖</span>
            </span>
          </div>
        </div>

        <!-- 相控阵天线参数（对齐 SATSOFT §6.5 / §6.5.1 对话框）：阵元数 / 间距 / 单元因子 / 晶格 → 波束宽·间距·交叉·栅瓣·方向性 -->
        <div v-if="bs.mode.value === 'pam'" class="sec">
          <div class="sect acc" data-sec="bs-pam" :class="{ open: isSecOpen('bs-pam') }" @click="toggleSec('bs-pam')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-pam') }" :size="12" /><span>天线参数</span><span class="bs-cnt">相控阵 · Butler 矩阵</span></div>
          <template v-if="isSecOpen('bs-pam')">
          <div class="srow"><label>辐射单元数</label><input class="ci" type="number" step="1" min="1" v-model.number="bs.p.pamNx" title="X 向（方位）单元数 Nx" /><span class="u">×</span><input class="ci" type="number" step="1" min="1" v-model.number="bs.p.pamNy" title="Y 向（俯仰）单元数 Ny" /></div>
          <div class="srow"><label>单元间距</label><input class="ci" type="number" step="0.05" min="0.1" v-model.number="bs.p.pamDx" title="X 向单元间距 dx（波长）" /><span class="u">×</span><input class="ci" type="number" step="0.05" min="0.1" v-model.number="bs.p.pamDy" title="Y 向单元间距 dy（波长）" /><span class="u">λ</span></div>
          <div class="srow"><label>设计频率</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.pamFGHz" /><span class="u">GHz</span></div>
          <div class="srow"><label>口径效率</label><input class="ci" type="number" step="1" min="1" max="100" v-model.number="bs.p.pamEff" title="口径效率（%）：50% ≈ 相对满口径 −3dB；补偿阵列损耗等" /><span class="u">%</span></div>
          <div class="srow"><label>单元因子 R</label><input class="ci" type="number" step="0.1" min="0" v-model.number="bs.p.pamR" title="单元功率方向图 cos^R(θ) 指数（典型 1.0–1.5）：越大扫描增益滚降越快" /><span class="u">cos^R θ</span></div>
          <label class="chk2"><input type="checkbox" v-model="bs.p.pamTri" /><span>三角晶格（等边 dx=√3/2·dy；Nx 需偶）</span></label>
          <div v-if="bs.p.pamTri && Math.round(Number(bs.p.pamNx)) % 2 !== 0" class="tip warn" title="SATSOFT 手册 §6.5.1">⚠ 三角晶格要求 X 向单元数 Nx 为偶数；当前 Nx={{ Math.round(Number(bs.p.pamNx)) }} 为奇数，已按矩形晶格计算。</div>
          <label class="chk2"><input type="checkbox" v-model="bs.p.pamElem" /><span>应用单元因子（关闭＝仅看阵因子 / 栅瓣）</span></label>
          <div class="bs-read2">
            <span>波束宽 <b>{{ bsFmt(bs.pam.value && bs.pam.value.th3xDeg, 2) }}×{{ bsFmt(bs.pam.value && bs.pam.value.th3yDeg, 2) }}</b>°</span>
            <span>方向性 <b :title="bs.pam.value && bs.pam.value.dirCorrDb < -0.05 ? '已按栅瓣分能修正 ' + bsFmt(bs.pam.value.dirCorrDb, 2) + ' dB（Hannon 公式原值 ' + bsFmt(bs.pam.value.dirDbi, 2) + ' dBi）' : ''">{{ bsFmt(bs.pam.value && (bs.pam.value.dirDbiCorr != null ? bs.pam.value.dirDbiCorr : bs.pam.value.dirDbi), 2) }}</b> dBi</span>
          </div>
          <div class="bs-read">
            <span>波束间距 <b :title="bs.pam.value && !bs.pam.value.beamSpacingXReal ? '波束间距落在 sin 空间外（Δu&gt;1），以方向余弦 u 显示（手册 §6.5.1）' : ''">{{ bs.pam.value && bs.pam.value.beamSpacingXReal ? bsFmt(bs.pam.value.beamSpacingXDeg, 2) + '°' : bsFmt(bs.pam.value && bs.pam.value.beamSpacingXU, 3) + ' u' }}</b> · 交叉 <b>{{ bsFmt(bs.pam.value && bs.pam.value.crossoverDb, 2) }}</b> dB</span>
            <span>阵尺寸 <b>{{ bsFmt(bs.pam.value && bs.pam.value.arrayDimXm, 2) }}×{{ bsFmt(bs.pam.value && bs.pam.value.arrayDimYm, 2) }}</b> m</span>
          </div>
          <div class="bs-read"><span title="第一栅瓣距原点的波束宽数（手册 §6.5.1：distance from origin in beamwidths；合成赋形时可填入 Beamlet Grid 的 Range 字段）。电扫超过无栅瓣可扫界 asin(1/d−1) 时栅瓣即进入实空间">第一栅瓣 <b>{{ bsFmt(bs.pam.value && bs.pam.value.gratingLobeBw, 1) }}</b> 波束宽{{ bs.pam.value && bs.pam.value.gratingInReal ? '（±' + bsFmt(bs.pam.value.gratingLobeDeg, 1) + '° 进实空间）' : '（天底圈外 · 无栅瓣可扫 ±' + bsFmt(bs.pam.value && bs.pam.value.scanMaxDeg, 1) + '°）' }}</span></div>
          <div v-if="bs.pam.value && bs.pam.value.gratingInReal" class="tip warn" title="栅瓣会形成重复波束；单元间距减至 &lt;1λ 可消除">⚠ 单元间距 ≥ 1λ：栅瓣进入实空间（±{{ bsFmt(bs.pam.value.gratingLobeDeg, 1) }}°），方向性读数已按分能修正。</div>
          <div v-else-if="bs.pamScanStat.value && bs.pamScanStat.value.over" class="tip warn">⚠ {{ bs.pamScanStat.value.over }} 个波束超无栅瓣可扫界 ±{{ bsFmt(bs.pamScanStat.value.scanMaxDeg, 1) }}°（最大离轴 {{ bsFmt(bs.pamScanStat.value.maxOffDeg, 1) }}°）——栅瓣进实空间，生成时峰值按分能修正。</div>
          <div class="bs-refl" v-html="bsPamSvg"></div>
          <div class="bs-reflbar">
            <span class="pgb" @click="bsPamView = bsPamView === 1 ? 2 : 1">◀</span>
            <span class="bs-reflpg">{{ bsPamView }}/2</span>
            <span class="pgb" @click="bsPamView = bsPamView === 1 ? 2 : 1">▶</span>
            <span class="bs-reflcap">{{ bsPamView === 1 ? '阵面正视：单元排布' : 'sin 空间：Butler 波束栅' }}</span>
          </div>
          </template>
        </div>

        <!-- —— 放置波束 → 轮廓编号 / 频率计划（多馈源 + 高斯组 + 相控阵点波束群共用；后两者折叠） —— -->
        <template v-if="bs.mode.value === 'gauss' || bs.mode.value === 'stk' || (bs.mode.value === 'pam' && bs.p.pamCover !== 'shaped')">
          <div class="sec">
            <div class="sect acc" data-sec="bs-place" :class="{ open: isSecOpen('bs-place') }" @click="toggleSec('bs-place')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-place') }" :size="12" /><span>放置波束</span><span class="bs-cnt">{{ bs.beams.value.length }} 个{{ bs.curSetting.value ? ' · 设置 ' + bs.curSetting.value.name : '' }}</span></div>
            <template v-if="isSecOpen('bs-place')">
            <div class="bs-ops">
              <span class="opb" :class="{ on: bs.placing.value }" title="开启后在地图上左键点击放置波束轮廓（拖动仍为旋转/平移，右键亦可放置；再次点击关闭）" @click="bsPlaceToggle">{{ bs.placing.value ? '放置中…点击地图' : '地图放置' }}</span>
              <span class="opb" :class="{ on: bs.adjusting.value }" title="在平面图上拖动波束中心调整位置：轮廓实时跟随指针，经过相切位置时自动吸附（可随时拖离）" @click="bsAdjustToggle">{{ bs.adjusting.value ? '完成调整' : '调整中心' }}</span>
              <span class="opb" title="打开波束批量表格：Excel 式框选/粘贴，从表格批量成群" @click="openBsTable">批量表格</span>
              <span class="opb" title="清空本组所有已放置波束（可撤销：批量表格 Ctrl+Z）" @click="bs.clearBeams">清空</span>
              <span class="opb danger" :class="{ on: bs.deleting.value }" title="开启后点击地图上的波束中心即可删除该波束，支持连续删除（误删可用上方「撤销」）；再次点击关闭" @click="bsDeleteToggle">{{ bs.deleting.value ? '删除中…点击波束' : '删除波束' }}</span>
            </div>
            <label class="chk2" title="点击或拖动至边界附近自动相切"><input type="checkbox" v-model="bs.p.snapTangent" /><span>相切吸附</span></label>
            <div class="bs-hex">
              <label>蜂窝布满</label>
              <select :value="bs.p.polyId" @change="e => bs.p.polyId = e.target.value">
                <option value="">选 Polygon…</option>
                <option v-for="pg in polys" :key="pg.id" :value="pg.id">{{ pg.name || 'Polygon' }}（{{ pg.pts.length }}点）</option>
              </select>
              <span class="opb sm" title="在所选 Polygon 内按间距六角布满（用激活设置的宽度）" @click="bs.hexFill">布满</span>
            </div>
            <div class="srow" v-if="bs.curSetting.value"><label>波束间距</label>
              <label class="chk-in" title="Auto＝波束间距 = 该设置的波束宽度 θ3dB（相邻波束 −3.01 dB 交叠）；取消可手动输入。间距下沉到每个波束设置（随其口径/波束宽变），故此处读写激活设置、Auto 显示实时算出值"><input type="checkbox" :checked="bs.curSetting.value.autoSpacing !== false" @change="bs.curSetting.value.autoSpacing = $event.target.checked" /><span>Auto</span></label>
              <input class="ci" type="number" step="0.1" :disabled="bs.curSetting.value.autoSpacing !== false" v-model.number="bs.curSetting.value.spacing" /><span class="u">°</span>
            </div>
            <div v-if="bs.beams.value.length > 60" class="tip">共 <b>{{ bs.beams.value.length }}</b> 个波束，列表过长已折叠。</div>
            <div v-else-if="bs.beams.value.length" class="bs-list">
              <div v-for="(b, i) in bs.beams.value" :key="b.id" class="bs-brow">
                <span class="bs-bi">{{ bs.beamNumOffset.value + i + 1 }}</span>
                <span class="bs-bll">{{ Number(b.lon).toFixed(2) }}, {{ Number(b.lat).toFixed(2) }}</span>
                <span class="bs-bth">{{ Number(b.thX).toFixed(1) }}×{{ Number(b.thY).toFixed(1) }}°<em v-if="b.rot"> ∠{{ b.rot }}</em></span>
                <span class="ic del" title="删除该波束" @click="bs.removeBeam(b.id)"><Icon name="x" :size="12" /></span>
              </div>
            </div>
            </template>
          </div>

          <!-- 轮廓与编号（折叠） -->
          <div class="sec">
            <div class="sect acc" data-sec="bs-style" :class="{ open: isSecOpen('bs-style', false) }" @click="toggleSec('bs-style', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-style', false) }" :size="12" /><span>轮廓与编号</span></div>
            <template v-if="isSecOpen('bs-style', false)">
              <div class="srow"><label>轮廓颜色</label><input class="clr" type="color" v-model="bs.p.skColor" title="草图轮廓与中心点基础色（各波束设置色 / 频率配色开启后被其覆盖）" />
                <span class="uw"><label class="lb2">线宽</label><input class="ci sm" type="number" step="0.1" min="0.1" max="5" v-model.number="bs.p.skWidth" /><span class="u">px</span></span>
              </div>
              <div class="srow"><label>线型</label>
                <span class="seg sm">
                  <span class="sg" :class="{ on: !bs.p.skDash }" @click="bs.p.skDash = false">实线</span>
                  <span class="sg" :class="{ on: bs.p.skDash }" title="虚线轮廓（2D/3D 一致；波束超过 300 个时自动改用实线以保证性能）" @click="bs.p.skDash = true">虚线</span>
                </span>
              </div>
              <label class="chk2"><input type="checkbox" v-model="bs.p.skNumShow" /><span>显示波束编号</span></label>
              <template v-if="bs.p.skNumShow">
                <div class="srow"><label>编号字号</label>
                  <span class="seg sm">
                    <span class="sg" :class="{ on: bs.p.skNumMode === 'auto' }" title="随各波束在图上的大小自动取字号：编号始终装在波束里，缩放联动，过小自动隐藏（避免相互重叠）" @click="bs.p.skNumMode = 'auto'">自适应</span>
                    <span class="sg" :class="{ on: bs.p.skNumMode === 'fixed' }" title="固定基准字号（世界尺寸，随地图缩放联动；与 Polygon 标签同口径）" @click="bs.p.skNumMode = 'fixed'">固定</span>
                  </span>
                  <input v-if="bs.p.skNumMode === 'auto'" class="ci sm" type="number" step="10" min="30" max="300" v-model.number="bs.p.skNumScale" /><span v-if="bs.p.skNumMode === 'auto'" class="u">%</span>
                  <input v-if="bs.p.skNumMode === 'fixed'" class="ci sm" type="number" step="1" min="4" max="64" v-model.number="bs.p.skNumSize" /><span v-if="bs.p.skNumMode === 'fixed'" class="u">px</span>
                </div>
                <label class="chk2"><input type="checkbox" v-model="bs.p.skNumBold" /><span>粗体</span></label>
                <div class="srow"><label>编号颜色</label><input class="clr" type="color" v-model="bs.p.skNumColor" /></div>
              </template>
            </template>
          </div>

          <!-- 频率计划（折叠） -->
          <div class="sec">
            <div class="sect acc" data-sec="bs-freq" :class="{ open: isSecOpen('bs-freq', false) }" @click="toggleSec('bs-freq', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-freq', false) }" :size="12" /><span>频率计划</span><span v-if="bs.fcStats.value.length" class="bs-cnt">{{ bs.fcStats.value.reduce((s, x) => s + x.count, 0) }} 已配色</span></div>
            <template v-if="isSecOpen('bs-freq', false)">
              <!-- 颜色数：七档写成纯数字（七个「N 色」在这条窄栏里放不下），含义与可达间距进 title。
                   ★ 档位取的是【有效前沿】而不是「凡复用因子都列」：同一个可达间距上只留最省频率的
                     那一档，单极化（奇数档）与双极化（偶数档）各算各的 —— 于是
                       单极化 3 / 7 / 9（1.73 / 2.65 / 3.00 d）· 双极化 4 / 8 / 12 / 16（2.00 / 2.65 / 3.46 / 4.00 d）
                     8 不是复用因子（取不到 √8，最远 √7 = 与七色同距），但它是【双极化那条线上
                     2.65d 这一档最省频率的】：4 频段 × 2 极化，每波束拿 1/4 频段，而七色只有 1/7。
                     10 被 8 支配（同样 2.65d 却要切 5 段频率），故不列 —— 这也正是上一轮撤掉它的理由。 -->
              <div class="srow"><label>颜色数</label>
                <span class="seg sm">
                  <span class="sg" :class="{ on: bs.p.fcN === 3 }" title="三色复用：同色最小间距 1.73× 波束间距（3 频段 × 单极化，每波束 1/3 频段）" @click="bs.p.fcN = 3">3</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 4 }" title="四色复用：同色最小间距 2.00× 波束间距（2 频段 × 2 极化，每波束 1/2 频段 —— 单波束带宽最大的一档，SATSOFT 四色填充）" @click="bs.p.fcN = 4">4</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 7 }" title="七色复用：同色最小间距 2.65× 波束间距（7 频段 × 单极化，每波束 1/7 频段；经典蜂窝 reuse-7）" @click="bs.p.fcN = 7">7</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 8 }" title="八色复用：同色最小间距 2.65× 波束间距（4 频段 × 2 极化，每波束 1/4 频段）。8 不是复用因子（无法取到 √8 的晶格间距），间距与七色相同——但同样的间距下它只切 4 段频率，每波束带宽是七色的近两倍，故双极化系统用八色而不是七色" @click="bs.p.fcN = 8">8</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 9 }" title="九色复用：同色最小间距 3.00× 波束间距（9 频段 × 单极化；经典 reuse-9，蜂窝格上的严格图案）" @click="bs.p.fcN = 9">9</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 12 }" title="十二色复用：同色最小间距 3.46× 波束间距（6 频段 × 2 极化，每波束 1/6 频段）" @click="bs.p.fcN = 12">12</span>
                  <span class="sg" :class="{ on: bs.p.fcN === 16 }" title="十六色复用：同色最小间距 4.00× 波束间距（8 频段 × 2 极化，每波束 1/8 频段；中星26 小波束那族即此格局）。配色板上 F1~F8 与 F9~F16 两两同色相分深浅，正好读成同一段频率的两个极化" @click="bs.p.fcN = 16">16</span>
                </span>
              </div>
              <div class="bs-ops">
                <span class="opb" title="按当前布局自动分配：同色波束的间距不小于 √N × 波束间距（N = 颜色数，即正六边形晶格的复用距离），蜂窝布局呈规则复用图案；拖拽微调后可重新分配（可撤销）" @click="bs.assignFreqPlan">自动分配</span>
                <span class="opb" title="清除本组所有波束的频率配色（可撤销）" @click="bs.clearFreqPlan">清除配色</span>
              </div>
              <label class="chk2"><input type="checkbox" v-model="bs.p.fcShow" /><span>显示配色（波束填充 + 轮廓着色）</span></label>
              <div v-if="bs.p.fcShow" class="srow"><label>填充透明</label><input class="ci sm" type="number" step="0.05" min="0" max="1" v-model.number="bs.p.fcOpacity" /><span class="u">0–1</span></div>
              <div v-if="bs.fcStats.value.length" class="bs-fcleg">
                <span v-for="s in bs.fcStats.value" :key="s.i" class="bs-fchip"><i :style="{ background: s.css }"></i>F{{ s.i + 1 }} <em>×{{ s.count }}</em></span>
              </div>
              <!-- 波束信息列表（可多列复制到 Excel）：编号 / 频率(F#) / 经纬度 / 3dB 宽度 —— 复制含旋转，共 7 列 -->
              <div v-if="bsFreqRows.length" class="bs-fplist">
                <div class="bs-fphd">
                  <span>波束信息 <em>{{ bsFreqRows.length }}</em></span>
                  <span class="bs-fpcp" :class="{ ok: bsFreqCopied }" title="复制全部波束为多列表格（编号 / 频率 / 经度 / 纬度 / 3dB-X / 3dB-Y / 旋转，Tab 分隔）：粘贴至 Excel 自动分为 7 列" @click="bsCopyFreqPlan"><Icon :name="bsFreqCopied ? 'check' : 'copy'" :size="12" /> {{ bsFreqCopied ? '已复制 ✓' : '复制表格' }}</span>
                </div>
                <div class="bs-fptbl">
                  <div class="bs-fpr bs-fph"><span class="c-no">#</span><span class="c-fc">频率</span><span class="c-ll">经度, 纬度</span><span class="c-th">3dB°</span></div>
                  <div v-for="r in bsFreqRows" :key="r.id" class="bs-fpr">
                    <span class="c-no">{{ r.no }}</span>
                    <span class="c-fc"><i v-if="r.css" :style="{ background: r.css }"></i>{{ r.fc != null ? 'F' + r.fc : '—' }}</span>
                    <span class="c-ll">{{ r.lon.toFixed(3) }}, {{ r.lat.toFixed(3) }}</span>
                    <span class="c-th">{{ r.thX.toFixed(1) }}×{{ r.thY.toFixed(1) }}<em v-if="r.rot"> ∠{{ r.rot }}</em></span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </template>

        <!-- —— 相控阵赋形：覆盖区域（Polygon + Use Polygon Labels）→ 生成后出星上激励指令（测控上注 BFN） —— -->
        <template v-if="bs.mode.value === 'pam' && bs.p.pamCover === 'shaped'">
          <div class="sec">
            <div class="sect acc" data-sec="bs-pcov" :class="{ open: isSecOpen('bs-pcov') }" @click="toggleSec('bs-pcov')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-pcov') }" :size="12" /><span>覆盖区域</span><span v-if="bs.p.polyIds.length" class="bs-cnt">{{ bs.p.polyIds.length }} 个</span></div>
            <template v-if="isSecOpen('bs-pcov')">
            <div v-if="polys.length" class="bs-plist">
              <div v-for="pg in polys" :key="pg.id" class="bs-prow">
                <label class="bs-pchk" :title="(pg.name || 'Polygon') + '（' + pg.pts.length + '点）'">
                  <input type="checkbox" :checked="bs.p.polyIds.includes(pg.id)" @change="bs.togglePoly(pg.id)" />
                  <span class="bs-pnm" data-i18n-skip>{{ pg.name || 'Polygon' }}</span>
                </label>
              </div>
            </div>
            <div v-if="!polys.length" class="tip">暂无 Polygon。</div>
            <div class="srow"><label>指向误差</label><input class="ci" type="number" step="0.05" min="0" v-model.number="bs.p.expandDeg" title="航天器指向误差（°）：合成前把覆盖区外扩此角度（SATSOFT Expand Coverage (Pointing Error)），保证卫星有指向误差时覆盖区内仍达标；空/0＝不外扩" /><span class="u">°</span></div>
            </template>
          </div>

          <!-- 站点栅（与反射面赋形档同一份交互的镜像——改动须两处同步；θ3=阵面波束宽，站点/修正机制全同） -->
          <div class="sec">
            <div class="sect acc" data-sec="bs-st" :class="{ open: isSecOpen('bs-st') }" @click="toggleSec('bs-st')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-st') }" :size="12" /><span>站点栅</span><span v-if="bs.stInfo.value" class="bs-cnt">{{ bs.stInfo.value.over ? '约 ' + bs.stInfo.value.over + ' 站 · 超上限' : (bs.stInfo.value.counts.c0 + bs.stInfo.value.counts.c1) + ' 站' }}</span></div>
            <template v-if="isSecOpen('bs-st')">
            <div class="srow"><label>显示</label>
              <label class="chk-in" title="在地图上显示站点栅（优化目标点阵）"><input type="checkbox" :checked="bs.p.stShow !== false" @change="bs.p.stShow = $event.target.checked" /><span>站点</span></label>
              <label class="chk-in" title="在站点上标注序号（SATSOFT Plot Station Number）"><input type="checkbox" :checked="bs.p.stNum === true" @change="bs.p.stNum = $event.target.checked" /><span>编号</span></label>
              <label class="chk-in" title="在偏置站上标注 ±dB 数值（默认关：偏置站只靠颜色区分，绿=抬高、紫=压低）"><input type="checkbox" :checked="bs.p.stGNum === true" @change="bs.p.stGNum = $event.target.checked" /><span>数值</span></label>
            </div>
            <div class="srow"><label>数字大小</label><input class="ci" type="number" step="1" min="5" max="24" v-model.number="bs.p.stNumSize" title="站点数字字号（px）：编号与偏置数值共用" /><span class="u">px</span></div>
            <label class="chk2"><input type="checkbox" v-model="bs.p.stNumBold" /><span>粗体</span></label>
            <div class="srow"><label>栅密度</label><input class="ci" type="number" step="0.5" min="0" v-model.number="bs.p.stDens" title="站点密度（站/阵面波束宽，SATSOFT Grid Density）：区内步距=θ3/密度，密度翻倍站点数变四倍；0＝每个 Polygon 在质心生成单站。手册 §9.1：1.7~2 足够，教程用 3~4；不设上限（§1.1.2 站点数 unlimited），只有 50 万站的兜底会拦下并报出数目" /><span class="u">/θ3</span></div>
            <div class="srow"><label>栅类型</label><select v-model="bs.p.stType" title="站点栅晶格类型（SATSOFT Type）"><option value="tri">三角栅</option><option value="rect">矩形栅</option></select></div>
            <div class="srow"><label>旋转</label><input class="ci" type="number" step="5" v-model.number="bs.p.stRot" title="站点栅朝向（SATSOFT Rotation）" /><span class="u">°</span></div>
            <div class="srow"><label>中心偏移</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.stXOff" title="中心站相对 boresight（＝覆盖区质心，SATSOFT Auto Position Boresight）的 X 位移" /><span class="u">,</span><input class="ci" type="number" step="0.1" v-model.number="bs.p.stYOff" title="中心站相对 boresight 的 Y 位移（SATSOFT Y Offset）" /><span class="u">°</span></div>
            <div class="srow"><label>生成</label>
              <label class="chk-in" title="在覆盖区多边形的顶点上生成边界站点（SATSOFT Add Border Points）：与栅密度无关——边界形状分辨率由多边形顶点密度决定"><input type="checkbox" :checked="bs.p.stBorder !== false" @change="bs.p.stBorder = $event.target.checked" /><span>边界点</span></label>
              <label class="chk-in" title="覆盖区外自动铺一圈抑制站（本引擎附加档）：SATSOFT 生成站点栅时站点全为 Contour，Sidelobe 站须手工指定"><input type="checkbox" :checked="bs.p.stSup === true" @change="bs.p.stSup = $event.target.checked" /><span>界外抑制</span></label>
            </div>
            <div class="srow"><label>站点大小</label><input class="ci" type="number" step="1" min="2" max="30" v-model.number="bs.p.stSizePct" title="站点符号大小（%阵面波束宽，SATSOFT Station Size）：仅显示符号，非物理量" /><span class="u">%</span></div>
            <div class="bs-strow">
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=并入已选；Alt+拖=从已选里减掉；点站点=选中该站、Ctrl+点=增减选、Alt+点=取消该站；点空处=清选）。Esc 或再点本钮退出框选，选中的站保留" @click="bsStEditToggle"><Icon name="crosshair" :size="12" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；Esc 或再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="12" /> 加站</span>
              <span class="opb sm" title="清除全部站点修正与手工站，回到自动站点栅（可撤销）" @click="bs.resetStations()">重置</span>
            </div>
            <div v-if="bs.stEditOn.value || bs.stSel.value.size" class="bs-strow">
              <span class="opb sm" title="选中全部站点（SATSOFT Select All Stations）" @click="bs.selectAllSt()">全选</span>
              <span class="opb sm" title="反转选中状态（SATSOFT Invert Selected State）" @click="bs.invertStSel()">反选</span>
              <span class="opb sm" :class="{ dis: !bs.stSel.value.size }" title="清空选中（Esc）" @click="bs.clearStSel()">清选</span>
            </div>
            <template v-if="bs.stSel.value.size">
            <div class="srow"><label>类型</label>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'cov' }" title="Contour：把该处增益抬到目标以上（生成站点栅时全部站点都是这一类；保留目标偏置）" @click="bs.applyStType('cov')">Contour</span>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'sup' }" title="抑制（SATSOFT Sidelobe）：把该处增益压到目标以下，用来在覆盖区外或邻区挖低旁瓣" @click="bs.applyStType('sup')">抑制</span>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'ex' }" title="排除（SATSOFT Excluded）：该站不进优化，画为灰空心；手工站=直接删除" @click="bs.applyStType('ex')">排除</span>
            </div>
            <div class="srow"><label>目标偏置</label><input class="ci" type="number" step="0.5" v-model.number="bsStGoal" title="对选中站点的目标偏置（dB，叠加在该处区域目标上）：正=局部抬高、负=压低、0=清除偏置。目标只看相对权重（SATSOFT §10.2）" /><span class="u">dB</span><span class="opb sm" @click="bs.applyStGoal(Number(bsStGoal) || 0)">应用</span></div>
            </template>
            <div v-if="bs.stSel.value.size || (bs.p.stOv || []).length || (bs.p.stAdd || []).length" class="bs-read"><span>选中 <b>{{ bs.stSel.value.size }}</b></span><span>修正 <b>{{ (bs.p.stOv || []).length }}</b></span><span>手工 <b>{{ (bs.p.stAdd || []).length }}</b></span><span v-if="bs.stSelOne.value"><template v-if="bs.stSelOne.value.add">手工 </template>{{ bs.stSelOne.value.type === 'sup' ? '抑制' : bs.stSelOne.value.type === 'ex' ? '排除' : 'Contour' }}<b v-if="bs.stSelOne.value.g"> {{ (bs.stSelOne.value.g > 0 ? '+' : '') + bs.stSelOne.value.g }} dB</b></span></div>
            </template>
          </div>

          <!-- 星上激励指令表（测控上注）：生成后可见 -->
          <div class="sec" v-if="bsPamExcitShown">
            <div class="sect acc" data-sec="bs-excit" :class="{ open: isSecOpen('bs-excit') }" @click="toggleSec('bs-excit')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-excit') }" :size="12" /><span>星上激励指令</span><span class="bs-cnt">{{ bsPamExcitShown.rows.length }} 端口</span></div>
            <template v-if="isSecOpen('bs-excit')">
              <div class="bs-read2">
                <span>峰值 <b>{{ bsFmt(bsPamExcitShown.peakDbi, 2) }}</b> dBi</span>
                <span>物理增益 <b>{{ bsFmt(bsPamExcitShown.physPeakDbi, 2) }}</b> dBi</span>
                <span>电扫 <b>{{ bsFmt(bsPamExcitShown.scanDeg, 1) }}</b>°</span>
              </div>
              <div class="bs-read"><span>边缘 <b>{{ bsFmt(bsPamExcitShown.value, 1) }}</b> dBi</span><span v-if="bsPamExcitShown.hotReport && bsPamExcitShown.hotReport.length" title="各峰值点实测抬升 / 请求增量（相控阵宽波束有物理上限，欠额见状态栏告警）">峰值点实现 <b>{{ bsPamExcitShown.hotReport.map(x => '+' + x.got + '/' + x.req).join(' · ') }}</b> dB</span></div>
              <div class="bs-excbar">
                <span class="bs-fpcp" :class="{ ok: bsPamExcitCopied }" title="复制激励指令表（Tab 分隔，粘贴至 Excel 自动分列）" @click="bsPamExcitCopy"><Icon :name="bsPamExcitCopied ? 'check' : 'copy'" :size="12" /> {{ bsPamExcitCopied ? '已复制 ✓' : '复制表格' }}</span>
                <span class="opb sm" title="导出 CSV（UTF-8 BOM，Excel 直接打开）供测控上注星上 BFN" @click="bsExportPamExcit"><Icon name="download" :size="12" /> 导出 CSV</span>
              </div>
              <!-- 真 <table>：可直接鼠标框选任意行列 → Ctrl+C，浏览器按 TSV 复制，粘进 Excel 自动分列 -->
              <div class="bs-exctbl">
                <table class="bs-exctable">
                  <thead><tr><th>端口#</th><th>指向经°</th><th>指向纬°</th><th>方位az°</th><th>俯仰el°</th><th>幅度dB</th><th>相位°</th><th>功率%</th></tr></thead>
                  <tbody>
                    <tr v-for="r in bsPamExcitShown.rows" :key="r.port">
                      <td>{{ r.port }}</td>
                      <td>{{ r.lon != null ? r.lon.toFixed(2) : '' }}</td>
                      <td>{{ r.lat != null ? r.lat.toFixed(2) : '' }}</td>
                      <td>{{ r.az }}</td>
                      <td>{{ r.el }}</td>
                      <td>{{ r.ampDb.toFixed(1) }}</td>
                      <td>{{ r.phaseDeg }}</td>
                      <td>{{ r.powPct.toFixed(1) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>
          </div>
        </template>

        <!-- —— Polygon 赋形：反射面模型（对齐 SATSOFT Shaped Reflector Model 对话框）→ 覆盖区域 → 波束中心 —— -->
        <template v-if="bs.mode.value === 'shaped'">
          <div class="sec">
            <div class="sect acc" data-sec="bs-refl" :class="{ open: isSecOpen('bs-refl') }" @click="toggleSec('bs-refl')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-refl') }" :size="12" /><span>反射面模型</span><span class="bs-cnt">单偏置反射面</span></div>
            <template v-if="isSecOpen('bs-refl')">
            <div class="srow"><label>口径直径</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.antD" /><span class="u">m</span></div>
            <div class="srow"><label>焦距</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.foc" /><span class="u">m</span></div>
            <!-- SATSOFT 三行制读数：Aperture circular · F/D ｜ 3 dB Beamwidth ｜ Feed Mode -->
            <div class="bs-read"><span>圆口径 F/D <b>{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.fd, 2) }}</b></span></div>
            <div class="bs-read"><span>均匀口径 3dB <b>{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.thetaUniDeg, 2) }}</b>°</span></div>
            <div class="srow"><label>馈电方式</label><span class="bs-ro">高斯波束馈源</span></div>
            <div class="srow"><label>馈源锥度</label><input class="ci" type="number" step="1" max="-1" v-model.number="bs.p.taper" title="馈源朝反射面边缘的照射锥度（dB，负值）：决定成分波束宽与馈源直径读数" /><span class="u">dB</span></div>
            <div class="srow"><label>设计频率</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.fGHz" /><span class="u">GHz</span><span class="bs-wl">{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.lamDesignCm, 2) }} cm</span></div>
            <div class="srow"><label>仿真频率</label>
              <label class="chk-in" title="勾选＝仿真频率同设计频率（方向图按设计频率计算）；取消可单独指定（波束宽随 λ 变化）"><input type="checkbox" :checked="bs.p.simSame !== false" @change="bsSimSameToggle($event.target.checked)" /></label>
              <!-- SATSOFT 同款：勾选时输入框保持全宽、置灰、镜像显示设计频率实时值 -->
              <input v-if="bs.p.simSame !== false" key="fsim-mirror" class="ci" type="number" :value="bs.p.fGHz" disabled /><input v-else key="fsim-own" class="ci" type="number" step="0.1" v-model.number="bs.p.fSim" /><span class="u">GHz</span><span class="bs-wl">{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.lamSimCm, 2) }} cm</span>
            </div>
            <div class="bs-read"><span>馈源直径 <b>{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.feedWl, 2) }}</b> WL · <b>{{ bsFmt(bs.shapedRefl.value && bs.shapedRefl.value.feedCm, 2) }}</b> cm</span></div>
            <div class="srow"><label>极化类型</label>
              <select v-model="bs.p.pol">
                <option value="linX">线极化 X</option><option value="linY">线极化 Y</option>
                <option value="rhcp">右旋圆极化</option><option value="lhcp">左旋圆极化</option>
              </select>
            </div>
            <div class="srow"><label>偏置净空/D</label><input class="ci" type="number" step="0.05" min="-0.5" v-model.number="bs.p.offsetClr" title="偏置净空占口径直径的比例：0=贴轴偏置，-0.5=正馈（对称抛物面）" /><span class="u"></span></div>
            <div class="bs-read"><span title="口径效率＝照射锥度效率×溢出效率，由馈源锥度决定（不可手动输入）；欧姆/表面残差按理想计≈1">口径效率 <b>{{ bsFmt(bs.shapedEff.value, 1) }}</b>%</span><span>成分波束 3dB 宽 <b>{{ bsFmt(bs.shapedTheta3.value, 3) }}</b>°</span></div>
            <div class="bs-refl" v-html="bsReflSvg"></div>
            <div class="bs-reflbar">
              <span class="pgb" @click="bsReflView = bsReflView === 1 ? 2 : 1">◀</span>
              <span class="bs-reflpg">{{ bsReflView }}/2</span>
              <span class="pgb" @click="bsReflView = bsReflView === 1 ? 2 : 1">▶</span>
              <span class="bs-reflcap">{{ bsReflView === 1 ? '从反射面背后朝地球方向看' : '反射面侧视图' }}</span>
            </div>
            </template>
          </div>

          <div class="sec">
            <div class="sect acc" data-sec="bs-cov" :class="{ open: isSecOpen('bs-cov') }" @click="toggleSec('bs-cov')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-cov') }" :size="12" /><span>覆盖区域</span><span v-if="bs.p.polyIds.length" class="bs-cnt">{{ bs.p.polyIds.length }} 个</span></div>
            <template v-if="isSecOpen('bs-cov')">
            <div v-if="polys.length" class="bs-plist">
              <div v-for="pg in polys" :key="pg.id" class="bs-prow">
                <label class="bs-pchk" :title="(pg.name || 'Polygon') + '（' + pg.pts.length + '点）'">
                  <input type="checkbox" :checked="bs.p.polyIds.includes(pg.id)" @change="bs.togglePoly(pg.id)" />
                  <span class="bs-pnm" data-i18n-skip>{{ pg.name || 'Polygon' }}</span>
                </label>
              </div>
            </div>
            <div v-if="!polys.length" class="tip">暂无 Polygon。</div>
            <div class="srow"><label>指向误差</label><input class="ci" type="number" step="0.05" min="0" v-model.number="bs.p.expandDeg" title="航天器指向误差（°）：合成前把覆盖区外扩此角度（SATSOFT Expand Coverage (Pointing Error)），保证卫星有指向误差时覆盖区内仍达标；空/0＝不外扩" /><span class="u">°</span></div>
            </template>
          </div>

          <!-- 站点栅（SATSOFT Station Grid §9.1 / Edit Stations §9.12）：黄方块=优化目标站（靶子），中心=精确控制点；
               与生成共用同一 buildStations（栅参数/外扩一致，所见即所用）。框选仅平面图（Ctrl=累加）；界外抑制带（开了也）不画。 -->
          <div class="sec">
            <div class="sect acc" data-sec="bs-st" :class="{ open: isSecOpen('bs-st') }" @click="toggleSec('bs-st')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('bs-st') }" :size="12" /><span>站点栅</span><span v-if="bs.stInfo.value" class="bs-cnt">{{ bs.stInfo.value.over ? '约 ' + bs.stInfo.value.over + ' 站 · 超上限' : (bs.stInfo.value.counts.c0 + bs.stInfo.value.counts.c1) + ' 站' }}</span></div>
            <template v-if="isSecOpen('bs-st')">
            <div class="srow"><label>显示</label>
              <label class="chk-in" title="在地图上显示站点栅（优化目标点阵）"><input type="checkbox" :checked="bs.p.stShow !== false" @change="bs.p.stShow = $event.target.checked" /><span>站点</span></label>
              <label class="chk-in" title="在站点上标注序号（SATSOFT Plot Station Number）"><input type="checkbox" :checked="bs.p.stNum === true" @change="bs.p.stNum = $event.target.checked" /><span>编号</span></label>
              <label class="chk-in" title="在偏置站上标注 ±dB 数值（默认关：偏置站只靠颜色区分，绿=抬高、紫=压低）"><input type="checkbox" :checked="bs.p.stGNum === true" @change="bs.p.stGNum = $event.target.checked" /><span>数值</span></label>
            </div>
            <div class="srow"><label>数字大小</label><input class="ci" type="number" step="1" min="5" max="24" v-model.number="bs.p.stNumSize" title="站点数字字号（px）：编号与偏置数值共用" /><span class="u">px</span></div>
            <label class="chk2"><input type="checkbox" v-model="bs.p.stNumBold" /><span>粗体</span></label>
            <div class="srow"><label>栅密度</label><input class="ci" type="number" step="0.5" min="0" v-model.number="bs.p.stDens" title="站点密度（站/成分波束宽，SATSOFT Grid Density）：区内步距=θ3/密度，密度翻倍站点数变四倍；0＝每个 Polygon 在质心生成单站。手册 §9.1：1.7~2 足够，教程用 3~4；不设上限（§1.1.2 站点数 unlimited），只有 50 万站的兜底会拦下并报出数目" /><span class="u">/θ3</span></div>
            <div class="srow"><label>栅类型</label><select v-model="bs.p.stType" title="站点栅晶格类型（SATSOFT Type）"><option value="tri">三角栅</option><option value="rect">矩形栅</option></select></div>
            <div class="srow"><label>旋转</label><input class="ci" type="number" step="5" v-model.number="bs.p.stRot" title="站点栅朝向（SATSOFT Rotation）" /><span class="u">°</span></div>
            <div class="srow"><label>中心偏移</label><input class="ci" type="number" step="0.1" v-model.number="bs.p.stXOff" title="中心站相对 boresight（＝覆盖区质心，SATSOFT Auto Position Boresight）的 X 位移" /><span class="u">,</span><input class="ci" type="number" step="0.1" v-model.number="bs.p.stYOff" title="中心站相对 boresight 的 Y 位移（SATSOFT Y Offset）" /><span class="u">°</span></div>
            <div class="srow"><label>生成</label>
              <label class="chk-in" title="在覆盖区多边形的顶点上生成边界站点（SATSOFT Add Border Points）：与栅密度无关——边界形状分辨率由多边形顶点密度决定"><input type="checkbox" :checked="bs.p.stBorder !== false" @change="bs.p.stBorder = $event.target.checked" /><span>边界点</span></label>
              <label class="chk-in" title="覆盖区外自动铺一圈抑制站（本引擎附加档）：SATSOFT 生成站点栅时站点全为 Contour，Sidelobe 站须手工指定"><input type="checkbox" :checked="bs.p.stSup === true" @change="bs.p.stSup = $event.target.checked" /><span>界外抑制</span></label>
            </div>
            <div class="srow"><label>站点大小</label><input class="ci" type="number" step="1" min="2" max="30" v-model.number="bs.p.stSizePct" title="站点符号大小（%成分波束宽，SATSOFT Station Size）：仅显示符号，非物理量" /><span class="u">%</span></div>
            <div class="bs-strow">
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=并入已选；Alt+拖=从已选里减掉；点站点=选中该站、Ctrl+点=增减选、Alt+点=取消该站；点空处=清选）。Esc 或再点本钮退出框选，选中的站保留" @click="bsStEditToggle"><Icon name="crosshair" :size="12" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；Esc 或再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="12" /> 加站</span>
              <span class="opb sm" title="清除全部站点修正与手工站，回到自动站点栅（可撤销）" @click="bs.resetStations()">重置</span>
            </div>
            <div v-if="bs.stEditOn.value || bs.stSel.value.size" class="bs-strow">
              <span class="opb sm" title="选中全部站点（SATSOFT Select All Stations）" @click="bs.selectAllSt()">全选</span>
              <span class="opb sm" title="反转选中状态（SATSOFT Invert Selected State）" @click="bs.invertStSel()">反选</span>
              <span class="opb sm" :class="{ dis: !bs.stSel.value.size }" title="清空选中（Esc）" @click="bs.clearStSel()">清选</span>
            </div>
            <template v-if="bs.stSel.value.size">
            <div class="srow"><label>类型</label>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'cov' }" title="Contour：把该处增益抬到目标以上（生成站点栅时全部站点都是这一类；保留目标偏置）" @click="bs.applyStType('cov')">Contour</span>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'sup' }" title="抑制（SATSOFT Sidelobe）：把该处增益压到目标以下，用来在覆盖区外或邻区挖低旁瓣" @click="bs.applyStType('sup')">抑制</span>
              <span class="opb sm" :class="{ on: bs.stSelType.value === 'ex' }" title="排除（SATSOFT Excluded）：该站不进优化，画为灰空心；手工站=直接删除" @click="bs.applyStType('ex')">排除</span>
            </div>
            <div class="srow"><label>目标偏置</label><input class="ci" type="number" step="0.5" v-model.number="bsStGoal" title="对选中站点的目标偏置（dB，叠加在该处区域目标上）：正=局部抬高、负=压低、0=清除偏置。目标只看相对权重（SATSOFT §10.2）" /><span class="u">dB</span><span class="opb sm" @click="bs.applyStGoal(Number(bsStGoal) || 0)">应用</span></div>
            </template>
            <div v-if="bs.stSel.value.size || (bs.p.stOv || []).length || (bs.p.stAdd || []).length" class="bs-read"><span>选中 <b>{{ bs.stSel.value.size }}</b></span><span>修正 <b>{{ (bs.p.stOv || []).length }}</b></span><span>手工 <b>{{ (bs.p.stAdd || []).length }}</b></span><span v-if="bs.stSelOne.value"><template v-if="bs.stSelOne.value.add">手工 </template>{{ bs.stSelOne.value.type === 'sup' ? '抑制' : bs.stSelOne.value.type === 'ex' ? '排除' : 'Contour' }}<b v-if="bs.stSelOne.value.g"> {{ (bs.stSelOne.value.g > 0 ? '+' : '') + bs.stSelOne.value.g }} dB</b></span></div>
            </template>
          </div>

        </template>

        <div class="sec">
          <div class="sect" data-sec="bs-gen"><span>生成天线</span></div>
          <span v-if="bs.mode.value === 'stk'" class="bs-gen" title="按本组波束与方向图参数在所选卫星下生成解析天线；生成后本组改动自动同步到该天线" @click="bsGenerate"><Icon name="check" :size="12" /> {{ bs.genAntExists.value ? '生成 / 更新此组' : '生成天线' }}</span>
          <span v-else class="bs-gen" title="按本组草图计算方向图（GRD），在所选卫星下生成/更新此组天线" @click="bsGenerate"><Icon name="check" :size="12" /> 生成 / 更新此组</span>
          <div v-if="bs.status.value" class="bs-status">{{ bs.status.value }}</div>
        </div>
        </template>

        <div v-else class="sec">
          <div class="bs-empty2">未选择波束组。</div>
        </div>

        </div>
        </div>

        <!-- 可见性分析（复刻 STK Access / Coverage）：选目标 → 仰角门限 → 卫星集 → 可见卫星清单。
             P1＝瞬时可见（随时间轴实时）；时段表(Access) / 覆盖热力图(Coverage) 为后续路线图。 -->
        <div v-show="shellUi.side === 'vis'" class="sview">
        <div v-if="shellUi.side === 'vis'" class="cov-side vis-side docked">

          <!-- 分析目标 + 参数 -->
          <div class="sec">
            <div class="sect" data-sec="vis-target"><span>分析目标</span></div>
            <!-- 卫星集来源可选：当前显示（跟随星座视图，悬停可见具体是谁）/ 默认卫星组（内置分组）/ 卫星组 / 自定义卫星。
                 三模式（瞬时/过境/覆盖）共用本集；非「当前显示」的来源异步解析成缓存（visSatResolve）。 -->
            <div class="srow vis-satset"><label>卫星集</label>
              <select class="vis-satsel" :value="vis.satSrc.value" :title="visSatTitle" @change="e => vis.satSrc.value = e.target.value">
                <option value="">当前显示</option>
                <optgroup label="默认卫星组">
                  <option v-for="g in VIS_SAT_GROUPS" :key="g.key" :value="'g:' + g.key">{{ g.label }}</option>
                </optgroup>
                <optgroup v-if="satGroups.list.value.length" label="卫星组">
                  <option v-for="g in satGroups.list.value" :key="g.id" :value="'s:' + g.id" data-i18n-skip>{{ g.name }}</option>
                </optgroup>
                <option value="g:custom">自定义卫星</option>
              </select>
              <s class="vis-satn">{{ visSatBusy ? '解析中' : ((vis.satCount.value || 0).toLocaleString() + ' 颗') }}</s>
            </div>
            <div v-if="visSatErr" class="tip">{{ visSatErr }}</div>
            <!-- 目标下拉恒占整行：选项是「地球站 / 点 / 航迹 / Polygon」的名字（用户自命名，长度不设限），
                 连占位那句「（选择地球站 / 点 / Polygon）」都比半行宽 —— 跟标签挤一行必然裁字 -->
            <div v-if="vis.mode.value !== 'coverage'" class="srow stack"><label>目标</label>
              <select :value="vis.targetKind.value + '|' + vis.targetId.value" @change="e => visPickTarget(e.target.value)">
                <option value="|">（选择地球站 / 点 / Polygon）</option>
                <optgroup v-if="stations.length" label="地球站">
                  <option v-for="s in stations" :key="s.id" :value="'station|' + s.id">{{ s.name || '地球站' }} · {{ fmtLL(s.lat, s.lon) }}</option>
                </optgroup>
                <optgroup v-if="points.length" label="点标记">
                  <option v-for="p in points" :key="p.id" :value="'point|' + p.id">{{ p.name ? p.name + ' · ' : '' }}{{ fmtLL(p.lat, p.lon) }}</option>
                </optgroup>
                <optgroup v-if="polys.length" label="Polygon（质心）">
                  <option v-for="pg in polys" :key="pg.id" :value="'poly|' + pg.id" data-i18n-skip>{{ pg.name }}</option>
                </optgroup>
              </select>
            </div>
            <div v-if="vis.mode.value !== 'coverage' && !stations.length && !points.length && !polys.length" class="tip">暂无可选目标。</div>
            <div class="srow" title="仰角 ≥ 该值判为可见 / 被覆盖"><label>仰角门限</label><input class="ci vis-elev" type="number" step="1" min="0" max="89" :value="vis.minElev.value" @input="e => visSetElev(e.target.value)" /><span class="u">°</span></div>
          </div>

          <!-- 可见卫星 / 覆盖：瞬时可见（now）/ 时段过境（access）/ 覆盖（coverage）三模式（复刻 STK Access / Coverage）-->
          <div class="sec">
            <div class="sect" data-sec="vis-list"><span>{{ vis.mode.value === 'coverage' ? '覆盖网格' : '可见卫星' }}</span><span class="vis-cnt" :class="{ on: visCnt.on }" :title="visCnt.title">{{ visCnt.text }}</span></div>
            <div class="seg sm vis-mode">
              <span class="sg" :class="{ on: vis.mode.value === 'now' }" @click="vis.setMode('now')">瞬时可见</span>
              <span class="sg" :class="{ on: vis.mode.value === 'access' }" title="未来一段时间内每颗星对目标的过境窗口（Access）" @click="vis.setMode('access')">时段过境</span>
              <span class="sg" :class="{ on: vis.mode.value === 'coverage' }" title="区域布设网格 → 逐胞元计算覆盖性能指标(FOM) → 热力图" @click="vis.setMode('coverage')">覆盖</span>
            </div>

            <!-- 瞬时可见（now）：KPI + 极坐标 sky 图 + 结果表 -->
            <template v-if="vis.mode.value === 'now'">
              <div v-if="!vis.hasTarget.value" class="tip">尚未选择分析目标。</div>
              <template v-else>
                <div class="vis-sum">
                  <span>可见 <b>{{ vis.kpi.value.count }}</b> <s>/ {{ vis.satCount.value.toLocaleString() }}</s></span>
                  <span v-if="vis.kpi.value.top">最高 <b>{{ vis.kpi.value.top.elevDeg.toFixed(1) }}°</b> <em :title="vis.kpi.value.top.name" data-i18n-skip>{{ vis.kpi.value.top.name }}</em></span>
                  <span v-if="vis.kpi.value.classes.length" class="vis-sumcls"><i v-for="c in vis.kpi.value.classes" :key="c.c">{{ c.c }} {{ c.n }}</i></span>
                </div>
                <div v-if="!vis.results.value.length" class="tip">当前时刻门限 {{ vis.minElev.value || 0 }}° 以上没有可见卫星。</div>
                <template v-else>
                  <div class="srow vis-icrow"><label>图标</label><input class="ci vis-elev" type="number" step="1" min="1" max="64" :value="vis.iconSize.value" @input="e => visSetIcon(e.target.value)" title="星下点图标大小（1–64）" /><input class="vis-clr" type="color" :value="vis.iconColor.value" @input="e => vis.iconColor.value = e.target.value" title="星下点图标 / 名字颜色（3D 与 2D 一致）" /><label class="chk-in" title="目标与各可见卫星之间的视线连线（卫星较多时建议关闭）"><input type="checkbox" :checked="vis.showLines.value" @change="vis.showLines.value = $event.target.checked" /><span>连线</span></label><label class="chk-in" title="卫星较多时建议关闭，避免名称相互重叠"><input type="checkbox" :checked="vis.showName.value" @change="vis.showName.value = $event.target.checked" /><span>名字</span></label></div>
                  <div v-if="vis.showName.value" class="srow vis-icrow"><label>名字大小</label><input class="vis-slider" type="range" min="1" max="12" step="1" :value="vis.nameSize.value" @input="e => vis.nameSize.value = Number(e.target.value)" /><span class="u">{{ vis.nameSize.value }}</span></div>
                  <label v-if="vis.showName.value" class="chk2"><input type="checkbox" :checked="vis.nameBold.value" @change="vis.nameBold.value = $event.target.checked" /><span>粗体</span></label>
                  <!-- 极坐标 sky 图：一点＝一颗可见星，角向＝方位（正北在上、顺时针），离心＝仰角（天顶在圆心、地平在外圈）；青虚线＝仰角门限 -->
                  <svg class="vis-sky" viewBox="0 0 100 100" aria-label="天空极坐标图">
                    <circle class="vis-sky-grid" cx="50" cy="50" r="44" />
                    <circle class="vis-sky-grid" cx="50" cy="50" r="29.3" />
                    <circle class="vis-sky-grid" cx="50" cy="50" r="14.7" />
                    <line class="vis-sky-grid" x1="50" y1="6" x2="50" y2="94" />
                    <line class="vis-sky-grid" x1="6" y1="50" x2="94" y2="50" />
                    <circle class="vis-sky-thr" cx="50" cy="50" :r="vis.skyThrR.value" />
                    <text class="vis-sky-lbl" x="50" y="3.4">N</text>
                    <text class="vis-sky-lbl" x="96.6" y="50.5">E</text>
                    <text class="vis-sky-lbl" x="50" y="97.6">S</text>
                    <text class="vis-sky-lbl" x="3.4" y="50.5">W</text>
                    <text class="vis-sky-el" x="51.4" y="22">30</text>
                    <text class="vis-sky-el" x="51.4" y="36.6">60</text>
                    <circle v-for="p in vis.skyPoints.value" :key="p.noradId" class="vis-sky-dot" :class="{ hi: p.hi, hov: String(vis.hoveredId.value) === String(p.noradId) }" :cx="p.x" :cy="p.y" r="1.7" @mouseenter="vis.setHover(p.noradId)" @mouseleave="vis.setHover('')"><title>{{ p.name }}</title></circle>
                  </svg>
                  <div class="vis-lhead">
                    <span class="vis-lname sortable" :class="{ on: vis.sortKey.value === 'name' }" @click="vis.setSort('name')">卫星</span>
                    <span class="vis-lc sortable" :class="{ on: vis.sortKey.value === 'class' }" @click="vis.setSort('class')" title="按轨道高度排序">类别</span>
                    <span class="sortable" :class="{ on: vis.sortKey.value === 'elev' }" @click="vis.setSort('elev')">仰角°</span>
                    <span class="sortable" :class="{ on: vis.sortKey.value === 'range' }" @click="vis.setSort('range')">斜距km</span>
                  </div>
                  <div class="vis-list">
                    <div v-for="r in vis.sortedResults.value" :key="r.noradId" class="vis-lrow" :class="{ hi: r.elevDeg >= 45, hov: String(vis.hoveredId.value) === String(r.noradId) }" @mouseenter="vis.setHover(r.noradId)" @mouseleave="vis.setHover('')" :title="r.name + (r.slot ? ' · ' + r.slot : '') + ' · #' + r.noradId + ' · 方位 ' + r.azDeg.toFixed(0) + '° ' + visCompass(r.azDeg) + ' · 高度 ' + Math.round(r.altKm).toLocaleString() + ' km'">
                      <span class="vis-lname" data-i18n-skip>{{ r.name }}</span>
                      <span class="vis-lc" :class="'oc-' + orbitClass(r.altKm)" data-i18n-skip>{{ r.slot || orbitClass(r.altKm) }}</span>
                      <span class="vis-lel">{{ r.elevDeg.toFixed(1) }}<i v-if="r.rising === true" class="vis-ud up" title="上升中">↑</i><i v-else-if="r.rising === false" class="vis-ud dn" title="下降中">↓</i></span>
                      <span>{{ Math.round(r.rangeKm).toLocaleString() }}</span>
                    </div>
                  </div>
                </template>
              </template>
            </template>

            <!-- 时段过境（access）：时窗 + 计算 + 甘特 + 过境列表 -->
            <template v-else-if="vis.mode.value === 'access'">
              <div v-if="!vis.hasTarget.value" class="tip">尚未选择分析目标。</div>
              <template v-else>
                <div class="srow"><label>时窗</label><input class="ci vis-elev" type="number" step="1" min="0.5" max="168" :value="vis.horizonH.value" @input="e => vis.horizonH.value = e.target.value" /><span class="u nw">小时</span><span class="opb sm" :class="{ dis: vis.accessBusy.value }" title="扫描卫星集在此时窗内对目标的全部过境（卫星越多越慢；上限 400 颗）" @click="vis.computeAccess()">计算过境</span></div>
                <div v-if="vis.accessResults.value.length && !vis.accessBusy.value" class="srow acc-exp"><span class="opb sm" title="按《三线表模板》导出 .xlsx：摘要 / 过境明细 / 逐星汇总，AOS·LOS·峰值均含 UTC 与本地两套时刻" @click="exportAccessExcel()">导出 Excel</span><span class="tip inl">{{ vis.accessResults.value.reduce((n, s) => n + s.windows.length, 0) }} 次过境</span></div>
                <div v-if="vis.accessBusy.value" class="tip">扫描过境窗口…</div>
                <div v-else-if="vis.accessMsg.value" class="tip">{{ vis.accessMsg.value }}</div>
                <template v-else-if="vis.accessResults.value.length">
                  <!-- 时间覆盖（严口径）：全部窗口合并去重后的可见时长 ÷ 实际时窗；最长中断含时窗首尾 -->
                  <div class="vis-sum">
                    <span :title="visCnt.title">时间覆盖 <b>{{ vis.accessKpi.value.pct.toFixed(1) }}%</b> <s>/ {{ visDur(vis.accessKpi.value.horizonMin) }}</s></span>
                    <span title="合并重叠后的可见总时长（多星同时可见只计一次，非各次时长求和）">合计可视 <b>{{ visDur(vis.accessKpi.value.coveredMin) }}</b></span>
                    <span :title="'时窗内共 ' + vis.accessKpi.value.gapCount + ' 段无星可见（含时窗首尾）'">最长中断 <b>{{ visDur(vis.accessKpi.value.maxGapMin) }}</b></span>
                  </div>
                  <!-- 时基行：UTC/本地显示切换（导出恒双时区，此开关只管屏上）+ 本次时窗的绝对起止 -->
                  <div class="vis-tbase">
                    <TzPicker class="vis-tzp" :model-value="vis.accessTz.value" :ms="vis.accessBaseMs.value"
                              title="过境时刻的显示时区：本机 / UTC / UTC±N（导出 Excel 恒双时区，此档位只管屏上）"
                              @update:model-value="v => vis.accessTz.value = v">{{ visTzNow }}</TzPicker>
                    <span class="vis-tspan" data-i18n-skip :title="'时窗起点 ' + visBoth(vis.accessBaseMs.value) + '\n时窗终点 ' + visBoth(accEndMs)">{{ visYmdHm(vis.accessBaseMs.value) }} → {{ visYmdHm(accEndMs) }}</span>
                  </div>
                  <div ref="accGanttEl" class="vis-gantt">
                    <!-- 绝对时间刻度轴（显示时区整点对齐；午夜刻度标日期）；钉在滚动容器顶，与条同一坐标系 -->
                    <div class="vis-grow vis-gaxis">
                      <span class="vis-gname"></span>
                      <span class="vis-gax" data-i18n-skip><s v-for="t in accAxis" :key="t.pct" class="vis-gtick" :class="{ day: t.day }" :style="{ left: t.pct + '%' }">{{ t.label }}</s></span>
                    </div>
                    <div v-for="s in vis.accessResults.value" :key="s.noradId" :data-nid="s.noradId" class="vis-grow" :class="{ hov: String(vis.hoveredId.value) === String(s.noradId) }" @mouseenter="vis.setHover(s.noradId)" @mouseleave="vis.setHover('')" :title="s.name + (s.slot ? ' · ' + s.slot : '') + ' · ' + s.windows.length + ' 次过境'">
                      <span class="vis-gname" data-i18n-skip>{{ s.name }}<s v-if="s.slot" class="vis-slot">{{ s.slot }}</s></span>
                      <span class="vis-gbar">
                        <i v-for="(w, wi) in s.windows" :key="wi" class="vis-gseg" :class="{ hi: w.peakEl >= 45, hov: accHovKey === String(s.noradId) + '-' + wi }" :style="{ left: (w.startMin / vis.accessKpi.value.horizonMin * 100) + '%', width: (Math.max(0.6, w.endMin - w.startMin) / vis.accessKpi.value.horizonMin * 100) + '%' }" :title="accSegTitle(w)" @mouseenter="accHovKey = String(s.noradId) + '-' + wi" @mouseleave="accHovKey = ''"></i>
                      </span>
                    </div>
                  </div>
                  <div class="vis-acc-hd">
                    <span class="vis-lname sortable" :class="{ on: vis.accOrder.value === 'sat' }" title="按卫星分组" @click="vis.accOrder.value = 'sat'">卫星</span>
                    <span class="sortable" :class="{ on: vis.accOrder.value !== 'sat' }" title="全部卫星按 AOS 时间混排" @click="vis.accOrder.value = 'time'">开始</span>
                    <span>结束</span>
                    <span>最高°</span>
                  </div>
                  <div class="vis-acc-list">
                    <template v-for="row in accRows" :key="row.key">
                      <div v-if="row.type === 'day'" class="vis-acc-day" data-i18n-skip>{{ visYmd(row.ms) }}<s v-if="row.d > 0">D+{{ row.d }}</s></div>
                      <template v-else>
                        <div class="vis-acc-row" :class="{ hov: String(vis.hoveredId.value) === String(row.s.noradId), exp: accExpKey === row.key }" @mouseenter="vis.setHover(row.s.noradId); accHovKey = row.key" @mouseleave="vis.setHover(''); accHovKey = ''" @click="accToggle(row.key); accScrollTo(row.s.noradId)" :title="row.title">
                          <span class="vis-lname" data-i18n-skip><i class="vis-cw">▸</i>{{ row.s.name }}<s v-if="row.s.slot" class="vis-slot">{{ row.s.slot }}</s></span>
                          <span>{{ row.t1 }}<s v-if="row.sup1" class="vis-dsup">+{{ row.sup1 }}</s></span>
                          <span>{{ row.t2 }}<s v-if="row.sup2" class="vis-dsup">+{{ row.sup2 }}</s></span>
                          <span :class="{ 'oc-hi': row.w.peakEl >= 45 }">{{ row.w.peakEl.toFixed(0) }}</span>
                        </div>
                        <!-- 行展开详情：AOS/峰值/LOS × 本地/UTC 全量时刻（年份见时基行；跨月才需月-日前缀） -->
                        <div v-if="accExpKey === row.key" class="vis-acc-det">
                          <div class="vexp-grid">
                            <span></span><span class="h" data-i18n-skip>{{ visTzTag() }}</span><span class="h" data-i18n-skip>UTC</span>
                            <span class="l">AOS</span><span class="t">{{ visMdHms(visAbsMs(row.w.startMin), false) }}</span><span class="t">{{ visMdHms(visAbsMs(row.w.startMin), true) }}</span>
                            <span class="l">峰值</span><span class="t">{{ visMdHms(visAbsMs(row.w.peakMin), false) }}</span><span class="t">{{ visMdHms(visAbsMs(row.w.peakMin), true) }}</span>
                            <span class="l">LOS</span><span class="t">{{ visMdHms(visAbsMs(row.w.endMin), false) }}</span><span class="t">{{ visMdHms(visAbsMs(row.w.endMin), true) }}</span>
                          </div>
                          <div class="vexp-foot"><span>时长 <b>{{ visDurS(row.w.durMin) }}</b></span><span>最高 <b>{{ row.w.peakEl.toFixed(1) }}°</b></span><span>AOS <b>+{{ visDur(row.w.startMin) }}</b></span><b v-if="row.w.truncated" class="vexp-tr">截至时窗末</b></div>
                        </div>
                      </template>
                    </template>
                  </div>
                </template>
              </template>
            </template>

            <!-- 覆盖（coverage）：区域网格 → FOM 热力图（复刻 STK Coverage）-->
            <template v-else>
              <div class="srow"><label>区域</label>
                <select :value="vis.covRegionKind.value" @change="e => vis.covRegionKind.value = e.target.value">
                  <option value="global">全球</option>
                  <option value="bounds">自定义边界</option>
                  <option value="poly" :disabled="!polys.length">Polygon 区域</option>
                </select>
              </div>
              <template v-if="vis.covRegionKind.value === 'bounds'">
                <div class="srow"><label>纬度</label><input class="ci cov-b" type="number" step="1" :value="vis.covLatMin.value" @input="e => vis.covLatMin.value = e.target.value" /><span class="u">~</span><input class="ci cov-b" type="number" step="1" :value="vis.covLatMax.value" @input="e => vis.covLatMax.value = e.target.value" /><span class="u">°N</span></div>
                <div class="srow"><label>经度</label><input class="ci cov-b" type="number" step="1" :value="vis.covLonMin.value" @input="e => vis.covLonMin.value = e.target.value" /><span class="u">~</span><input class="ci cov-b" type="number" step="1" :value="vis.covLonMax.value" @input="e => vis.covLonMax.value = e.target.value" /><span class="u">°E</span></div>
              </template>
              <div v-else-if="vis.covRegionKind.value === 'poly'" class="srow"><label>选择</label>
                <select :value="vis.covPolyId.value" @change="e => vis.covPolyId.value = e.target.value">
                  <option value="">（选择 Polygon）</option>
                  <option v-for="pg in polys" :key="pg.id" :value="pg.id" data-i18n-skip>{{ pg.name }}</option>
                </select>
              </div>
              <div class="srow"><label>网格步长</label><input class="ci cov-num" type="number" step="0.5" min="0.5" max="30" title="网格胞元间隔（度）：越小越细，耗时越长" :value="vis.covStep.value" @input="e => vis.covStep.value = e.target.value" /><span class="u">°</span></div>
              <div class="srow"><label>时窗</label><input class="ci cov-num" type="number" step="1" min="0.5" max="168" :value="vis.covHorizonH.value" @input="e => vis.covHorizonH.value = e.target.value" /><span class="u">小时</span></div>
              <div class="srow"><label>采样</label><input class="ci cov-num" type="number" step="10" min="10" max="600" title="时间步长（秒）：采样数=时窗÷步长，越大越快；覆盖统计 30–120s 足够" :value="vis.covSample.value" @input="e => vis.covSample.value = e.target.value" /><span class="u">秒</span></div>
              <div class="srow"><span class="opb sm" :title="vis.covBusy.value ? '点击取消当前计算' : '布设网格 → 逐胞元计算资产集（当前显示的卫星）覆盖 → FOM 热力图（网格越细、卫星越多耗时越长）'" @click="vis.covBusy.value ? vis.cancelCoverage() : vis.computeCoverage()">{{ vis.covBusy.value ? '取消' : '计算覆盖' }}</span><span v-if="vis.covData.value && !vis.covBusy.value" class="opb sm" title="清除覆盖热力图（保留区域/网格/时窗等参数，可重新计算）" @click="vis.clearCoverage()">清除覆盖</span><span v-if="vis.covMsg.value" class="tip inl cov-msg">{{ vis.covMsg.value }}</span></div>
              <template v-if="vis.covData.value">
                <div class="srow"><label>指标</label>
                  <select :value="vis.covFom.value" @change="e => vis.covFom.value = e.target.value">
                    <option v-for="f in vis.covFoms" :key="f.key" :value="f.key">{{ f.label }}</option>
                  </select>
                </div>
                <div class="srow"><label>配色</label>
                  <select class="cov-scheme" :value="vis.covScheme.value" @change="e => vis.covScheme.value = e.target.value">
                    <option value="turbo">Turbo</option>
                    <option value="jet">Jet</option>
                    <option value="viridis">Viridis</option>
                    <option value="inferno">Inferno</option>
                    <option value="gray">Gray</option>
                  </select>
                </div>
                <div class="srow"><label>透明度</label><input class="vis-slider cov-alpha" type="range" min="0.1" max="1" step="0.02" :value="vis.covAlpha.value" @input="e => vis.covAlpha.value = Number(e.target.value)" title="覆盖网格透明度（拖动即时生效）" /><span class="u">{{ Math.round(vis.covAlpha.value * 100) }}%</span></div>
                <div v-if="vis.covLegend.value" class="cov-legend">
                  <div class="cov-legbar"><i v-for="(c, ci) in vis.covLegend.value.colors" :key="ci" :style="{ background: 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')' }" :title="covBandLabel(ci, vis.covLegend.value)"></i></div>
                  <div class="cov-legsc"><span>{{ covFmt(vis.covLegend.value.lo, vis.covLegend.value) }}</span><b :title="vis.covLegend.value.label">{{ vis.covLegend.value.label }}{{ vis.covLegend.value.unit ? ' · ' + vis.covLegend.value.unit : '' }}</b><span>{{ covFmt(vis.covLegend.value.hi, vis.covLegend.value) }}</span></div>
                </div>
                <div v-if="vis.covKpi.value" class="vis-sum cov-kpi">
                  <span :title="visCnt.title">时间覆盖 <b>{{ vis.covKpi.value.timePct.toFixed(1) }}%</b> <s>（面积加权 · 最差格 {{ vis.covKpi.value.worstPct.toFixed(1) }}%）</s></span>
                  <span title="时窗内曾被覆盖过的面积占比（松口径：一格只覆盖 1 个采样也算满，恒 ≥ 时间覆盖）">覆盖面积 <b>{{ vis.covKpi.value.coverPct.toFixed(1) }}%</b></span>
                  <span>{{ vis.covKpi.value.label }} 极值 <b>{{ covFmt(vis.covKpi.value.min, vis.covLegend.value) }}</b> ~ <b>{{ covFmt(vis.covKpi.value.max, vis.covLegend.value) }}</b> {{ vis.covLegend.value ? vis.covLegend.value.unit : '' }}</span>
                  <span class="vis-sumcls"><s>网格 {{ vis.covKpi.value.cells.toLocaleString() }} 点</s></span>
                </div>
              </template>
            </template>
          </div>

        </div>
        </div>

        <!-- 环境场：ITU 气象 / 地形数据场（等经纬栅格 + 等值线），画在所有叠加层最底 -->
        <div v-show="shellUi.side === 'env'" class="sview">
        <div v-if="shellUi.side === 'env'" class="cov-side env-side docked" :class="{ hid: !env.on.value }">
          <!-- 图层总开关：置顶通栏、不随分区折叠而藏起（Mapbox Studio / ArcGIS 图层卡片同位）。
               关掉时下方分区整体压暗，让「面板还在、图层不画」这层因果一眼看得出来。 -->
          <button
            type="button" class="envsw" :class="{ on: env.on.value }"
            role="switch" :aria-checked="env.on.value ? 'true' : 'false'"
            :title="env.on.value ? '环境场已叠加在地图上（点击隐藏，参数与数据都保留）' : '环境场当前不叠加（点击显示）'"
            @click="env.on.value = !env.on.value"
          >
            <Icon class="envsw-i" :name="env.on.value ? 'eye' : 'eye-off'" :size="16" />
            <span class="envsw-t">显示环境场</span>
            <span class="layersw" :class="{ on: env.on.value }" aria-hidden="true"><i></i></span>
          </button>
          <div class="sec">
            <div class="sect acc" data-sec="env-src" :class="{ open: isSecOpen('env-src') }" @click="toggleSec('env-src')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('env-src') }" :size="12" /><span>数据场</span></div>
            <template v-if="isSecOpen('env-src')">
              <div class="srow"><label>字段</label>
                <select :value="env.key.value" @change="e => env.key.value = e.target.value">
                  <option v-for="d in env.defs.value" :key="d.key" :value="d.key">{{ d.label }}</option>
                </select>
              </div>
              <div class="srow" v-if="env.fieldOpt.value"><label>{{ env.fieldOpt.value.label }}</label>
                <select v-if="env.fieldOpt.value.name === 'rainy'" :value="env.optRainy.value" @change="e => env.optRainy.value = Number(e.target.value)">
                  <option v-for="o in env.fieldOpt.value.values" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
                <select v-else :value="env.optP.value" @change="e => env.optP.value = Number(e.target.value)">
                  <option v-for="o in env.fieldOpt.value.values" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>格距</label>
                <select :value="env.stepDeg.value" @change="e => env.stepDeg.value = Number(e.target.value)" title="成图格距：细于数据原生分辨率不会增加信息，仅增加耗时">
                  <option v-for="s in env.STEPS" :key="s.v" :value="s.v">{{ s.label }}</option>
                </select>
              </div>
              <div class="srow env-src"><span class="tip inl">{{ env.busy.value ? '取数中…' : env.srcNote.value }}</span></div>
              <div v-if="env.msg.value" class="srow"><span class="tip inl" :class="{ 'cov-msg': env.field.value && (!env.field.value.ready || env.field.value.fallback) }">{{ env.msg.value }}</span></div>
            </template>
          </div>

          <div class="sec">
            <div class="sect acc" data-sec="env-style" :class="{ open: isSecOpen('env-style') }" @click="toggleSec('env-style')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('env-style') }" :size="12" /><span>配色与值域</span></div>
            <template v-if="isSecOpen('env-style')">
              <div class="srow"><label>配色</label>
                <select class="cov-scheme" :value="env.scheme.value" @change="e => env.scheme.value = e.target.value">
                  <option v-for="s in env.SCHEMES" :key="s.v" :value="s.v">{{ s.label }}</option>
                </select>
                <label class="chk-in" title="色标反向（低值取暖端）"><input type="checkbox" v-model="env.invert.value" /><span>反相</span></label>
              </div>
              <div class="srow"><label>填色</label>
                <span class="seg">
                  <span class="sg" :class="{ on: env.bands.value === 0 }" title="连续渐变" @click="env.bands.value = 0">连续</span>
                  <span class="sg" :class="{ on: env.bands.value > 0 }" title="分级填色：档与档之间是硬边界，边界即等值线（工程读图）" @click="env.bands.value = env.bands.value > 0 ? env.bands.value : 8">分级</span>
                </span>
                <NumBox v-if="env.bands.value > 0" class="ci cov-num" :min="2" :max="24" :step="1" :model-value="env.bands.value" @commit="v => env.bands.value = v" /><span v-if="env.bands.value > 0" class="u">档</span>
              </div>
              <div class="srow"><label>值域</label>
                <span class="seg">
                  <span class="sg" :class="{ on: env.domainMode.value === 'p2p98' }" title="按 2%–98% 分位拉伸：长尾场（降雨率）以极值定域会使主区色差不可分辨" @click="env.domainMode.value = 'p2p98'">分位</span>
                  <span class="sg" :class="{ on: env.domainMode.value === 'minmax' }" title="全域极值" @click="env.domainMode.value = 'minmax'">极值</span>
                  <span class="sg" :class="{ on: env.domainMode.value === 'manual' }" title="手动指定上下限" @click="envManualInit()">手动</span>
                </span>
              </div>
              <div v-if="env.domainMode.value === 'manual'" class="srow"><label>上下限</label>
                <input class="ci cov-b" type="number" :value="env.manualLo.value" @input="e => env.manualLo.value = e.target.value" /><span class="u">~</span>
                <input class="ci cov-b" type="number" :value="env.manualHi.value" @input="e => env.manualHi.value = e.target.value" /><span class="u">{{ env.field.value ? env.field.value.unit : '' }}</span>
              </div>
              <div class="srow"><label>透明度</label><input class="vis-slider cov-alpha" type="range" min="0.1" max="1" step="0.02" :value="env.alpha.value" @input="e => env.alpha.value = Number(e.target.value)" title="环境场透明度（拖动即时生效）" /><span class="u">{{ Math.round(env.alpha.value * 100) }}%</span></div>
              <label class="chk2" :class="{ dis: !envMaskAvail }"><input type="checkbox" :disabled="!envMaskAvail" v-model="env.landOnly.value" /><span>海洋透明（按 P.1511 地形 ≤0 判海）</span></label>
              <div v-if="env.legend.value" class="cov-legend">
                <div class="cov-legbar"><i v-for="(s, si) in env.legend.value.stops" :key="si" :style="{ background: s.css }" :title="envLegTitle(si)"></i></div>
                <div class="cov-legsc"><span>{{ env.fmt(env.legend.value.lo) }}</span><b :title="env.legend.value.label">{{ env.legend.value.label }}{{ env.legend.value.unit ? ' · ' + env.legend.value.unit : '' }}</b><span>{{ env.fmt(env.legend.value.hi) }}</span></div>
              </div>
              <div v-if="env.stats.value" class="vis-sum cov-kpi">
                <span>极值 <b>{{ env.fmt(env.stats.value.min) }}</b> ~ <b>{{ env.fmt(env.stats.value.max) }}</b> {{ env.field.value.unit }}</span>
                <span>面积加权均值 <b>{{ env.fmt(env.stats.value.mean) }}</b> {{ env.field.value.unit }} <s>（cos φ 加权{{ env.landOnly.value && env.field.value.statsLand ? '，仅陆地' : '' }}）</s></span>
              </div>
            </template>
          </div>

          <div class="sec">
            <div class="sect acc" data-sec="env-contour" :class="{ open: isSecOpen('env-contour', false) }" @click="toggleSec('env-contour', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('env-contour', false) }" :size="12" /><span>等值线</span></div>
            <template v-if="isSecOpen('env-contour', false)">
              <label class="chk2"><input type="checkbox" v-model="env.contourOn.value" /><span>画等值线</span></label>
              <template v-if="env.contourOn.value">
                <div class="srow"><label>级差</label><input class="ci cov-num" type="number" min="0" step="any" :placeholder="env.field.value && env.field.value.contourStep ? String(env.field.value.contourStep) : '自动'" :value="env.contourStep.value" @input="e => env.contourStep.value = e.target.value" /><span class="u">{{ env.field.value ? env.field.value.unit : '' }}</span></div>
                <label class="chk2"><input type="checkbox" v-model="env.contourLabel.value" /><span>沿线标数值（仅平面图）</span></label>
                <label v-if="env.contourLabel.value" class="chk2"><input type="checkbox" v-model="env.contourBold.value" /><span>粗体</span></label>
                <div class="tip">共 {{ env.contours.value.length }} 档</div>
              </template>
            </template>
          </div>

        </div>
        </div>

        <!-- 实时气象：数值预报栅格驱动的实时/预报场，帧随全局时间轴走。
             与上面的 ITU 环境场共用同一套上色/提线/渲染通道，故读图习惯一致；差别在三处：
             ① 数据现取（一次请求一整块栅格，请求数 = 帧数，与格点数无关，故范围/格距/字段不花请求）；
             ② 有时间维（帧由全局仿真时钟就近选，不插值）；
             ③ 衰减场依赖卫星几何，且要一道最低仰角闸（擦地几何算得出 150 dB）。 -->
        <div v-show="shellUi.side === 'envLive'" class="sview">
        <div v-if="shellUi.side === 'envLive'" class="cov-side env-side docked" :class="{ hid: !envLive.on.value }">
          <button
            type="button" class="envsw" :class="{ on: envLive.on.value }"
            role="switch" :aria-checked="envLive.on.value ? 'true' : 'false'"
            :title="envLive.on.value ? '实时气象场已叠加于地图（点击隐藏，参数与已获取数据保留）' : '实时气象场未叠加（点击显示）'"
            @click="envLive.on.value = !envLive.on.value"
          >
            <Icon class="envsw-i" :name="envLive.on.value ? 'eye' : 'eye-off'" :size="16" />
            <span class="envsw-t">显示实时气象场</span>
            <span class="layersw" :class="{ on: envLive.on.value }" aria-hidden="true"><i></i></span>
          </button>

          <div class="sec">
            <div class="sect acc" data-sec="lv-fetch" :class="{ open: isSecOpen('lv-fetch') }" @click="toggleSec('lv-fetch')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('lv-fetch') }" :size="12" /><span>数据获取</span></div>
            <template v-if="isSecOpen('lv-fetch')">
              <div v-if="envLive.providers.value && !envLive.providers.value.field.ok" class="srow"><span class="tip inl cov-msg">{{ envLive.providers.value.field.message }}</span></div>
              <div class="srow"><label>区域</label>
                <select :value="envLive.region.value" @change="e => envLive.region.value = e.target.value" title="范围不影响请求数：单次请求获取整块栅格，请求数仅由帧数决定">
                  <option v-for="o in envLive.REGIONS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <!-- Polygon 档：取数窗仍是外接矩形（子集服务只吃 bbox），出图裁到多边形内 -->
              <template v-if="envLive.region.value === 'poly'">
                <div class="srow"><label>多边形</label>
                  <select :value="envLive.polyId.value" @change="e => envLive.polyId.value = e.target.value" title="取数窗为该多边形的外接矩形并各外扩一格；成图裁剪至多边形内，多边形外的格不计算">
                    <option value="">未选择</option>
                    <option v-for="p in envLive.polyList.value" :key="p.id" :value="p.id" data-i18n-skip>{{ p.name }}</option>
                  </select>
                </div>
                <div v-if="!envLive.polyList.value.length" class="srow"><span class="tip inl cov-msg">地图上还没有 Polygon</span></div>
              </template>
              <template v-if="envLive.region.value === 'cst'">
                <div class="srow"><label>纬度</label>
                  <NumBox class="ci cov-num" :min="-90" :max="89" :step="1" :model-value="envLive.custom.latMin" @commit="v => envLive.custom.latMin = v" /><span class="u">~</span>
                  <NumBox class="ci cov-num" :min="-89" :max="90" :step="1" :model-value="envLive.custom.latMax" @commit="v => envLive.custom.latMax = v" /><span class="u">°N</span>
                </div>
                <div class="srow"><label>经度</label>
                  <NumBox class="ci cov-num" :min="-180" :max="179" :step="1" :model-value="envLive.custom.lonMin" @commit="v => envLive.custom.lonMin = v" /><span class="u">~</span>
                  <NumBox class="ci cov-num" :min="-179" :max="180" :step="1" :model-value="envLive.custom.lonMax" @commit="v => envLive.custom.lonMax = v" /><span class="u">°E</span>
                </div>
              </template>
              <div v-if="envLive.region.value !== 'poly' || envLive.polyPts.value" class="srow"><span class="tip inl">{{ envLive.bbox.value.latMin }}~{{ envLive.bbox.value.latMax }}°N · {{ envLive.bbox.value.lonMin }}~{{ envLive.bbox.value.lonMax }}°E</span></div>
              <div class="srow"><label>格距</label>
                <select :value="envLive.res.value" @change="e => envLive.res.value = Number(e.target.value)" title="切换的是数据集而非抽稀：全球 0.25° 单帧约 38 MB，1° 约 2.3 MB。逐小时产品仅 0.25° 提供">
                  <option v-for="o in envLive.RES" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>时段</label>
                <select :value="envLive.hours.value" @change="e => envLive.hours.value = Number(e.target.value)" title="请求数 = 帧数，取数耗时仅由该项决定">
                  <option v-for="o in envLive.HOURS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>帧间隔</label>
                <select :value="envLive.stepH.value" @change="e => envLive.stepH.value = Number(e.target.value)" title="0.5° / 1° 产品仅提供逐 3 小时，选 1 小时将自动提升为 3 小时">
                  <option v-for="o in envLive.STEP_H" :key="o.v" :value="o.v" :disabled="envLive.res.value > 0.25 &amp;&amp; o.v < 3">{{ o.label }}</option>
                </select>
              </div>
              <div v-if="envLive.est.value && !envLive.est.value.error" class="srow">
                <span class="tip inl" :class="{ 'cov-msg': envLive.est.value.overHard }">{{ envLive.est.value.nx }}×{{ envLive.est.value.ny }} 格 · {{ envLive.est.value.nt }} 帧 · 内存 {{ lvMB(envLive.est.value.bytes) }} · 下载 {{ lvMB(envLive.est.value.dlBytes) }} · 预计 {{ envLive.est.value.etaSec }} s<template v-if="envLive.est.value.cached">（已缓存 {{ envLive.est.value.cached }} 帧）</template></span>
              </div>
              <div v-if="envLive.est.value && envLive.est.value.clipped" class="srow"><span class="tip inl cov-msg">逐小时产品仅至 {{ envLive.est.value.hourlyCap }} h，时段已截断</span></div>
              <div v-if="envLive.est.value && envLive.est.value.error" class="srow"><span class="tip inl cov-msg">{{ envLive.est.value.error }}</span></div>
              <div class="srow">
                <!-- 播放三角＝「开跑」：与对星覆盖窗口的「计算」按钮同一个记号（那处也是 play + 动词）。
                     取数是本面板唯一一个要等几十秒的动作，图标只给它，另两个保持纯文字。 -->
                <span class="mini act" :class="{ dis: envLive.loading.value }" @click="envLive.loading.value ? null : envLive.loadCube()"><Icon name="play" :size="12" /> {{ envLive.loading.value ? '获取中…' : '获取数据' }}</span>
                <span class="mini" title="请求一次栅格源，检验网络连通与起报时次" @click="envLive.testConn()">连通测试</span>
                <span class="mini" title="清除本地气象缓存分片" @click="envLive.clearCache()">清除缓存</span>
              </div>
              <div v-if="envLive.loading.value && envLive.progress.total" class="srow"><span class="tip inl">{{ envLive.progress.done }} / {{ envLive.progress.total }} 帧</span></div>
              <div v-if="envLive.usage.value && envLive.usage.value.files" class="srow"><span class="tip inl">本地缓存 {{ envLive.usage.value.files }} 帧 · {{ lvMB(envLive.usage.value.bytes) }}</span></div>
              <div v-if="envLive.msg.value" class="srow"><span class="tip inl">{{ envLive.msg.value }}</span></div>
              <div class="srow">
                <span class="mini" title="多站读数，随时间轴更新；指标可选、列可冻结；站点在表内增删与导入" @click="openMetTable()"><Icon name="table" :size="12" /> 气象指标表…</span>
              </div>
            </template>
          </div>

          <!-- 链路参数：目标星 + 频率 / 极化 / 最低仰角 / 传播模型。
               ★ 独立成节而不是挂在「数据场」下：这一组同时决定**衰减场**与**气象指标表**里的链路列，
                 摆在数据场里读起来像「只管这张图」。也不并进「数据获取」—— 那一节的全部读数都是
                 网络代价（请求数 / 下载量 / 缓存），而这一组一个请求都不花，只影响本地怎么算。
               ★ 目标星三档是本模块「普适性」的入口：只认 GEO 轨位等于只对静止轨道成立。 -->
          <div class="sec">
            <div class="sect acc" data-sec="lv-link" :class="{ open: isSecOpen('lv-link') }" @click="toggleSec('lv-link')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('lv-link') }" :size="12" /><span>链路参数</span></div>
            <template v-if="isSecOpen('lv-link')">
              <div class="srow"><label>目标</label>
                <select :value="envLive.satMode.value" @change="e => envLive.satMode.value = e.target.value" title="衰减逐点依赖几何。静止轨道位置走球面闭式（与链路预算 GSO 同源）；在轨卫星与手动星下点走 WGS-84 通用几何（与 NGSO 链路预算、可见性分析同源），故 LEO / MEO / HEO 与倾斜同步轨道同样适用">
                  <option value="geo">静止轨道位置</option>
                  <option value="sat">在轨卫星</option>
                  <option value="pos">手动星下点</option>
                </select>
              </div>
              <template v-if="envLive.satMode.value === 'geo'">
                <div class="srow"><label>轨位</label><NumBox class="ci cov-num" :min="-180" :max="180" :step="0.1" :model-value="Number(envLive.satLon.value)" @commit="v => envLive.satLon.value = String(v)" title="静止轨道定点经度，东经为正" /><span class="u">°E</span></div>
              </template>
              <template v-else-if="envLive.satMode.value === 'sat'">
                <div class="srow"><label>卫星</label>
                  <span class="tgtnm" :class="{ bad: envLive.satUnresolved.value }" :title="envLive.satName.value" data-i18n-skip>{{ envLive.satName.value || '未选择' }}</span>
                  <span v-if="envLive.satId.value" class="ic del" title="清除目标星" @click="lvClearSat()"><Icon name="x" :size="12" /></span>
                </div>
                <div class="srow"><input class="ci" v-model="lvSatQ" placeholder="搜索目标星：卫星名 / NORAD / 星座 / 卫星组" /></div>
                <div v-if="lvSatQ.trim()" class="sres lv-sres">
                  <div v-if="lvSatBusy" class="sres-e">搜索中…</div>
                  <div v-else-if="!lvSatCand.length" class="sres-e">没有匹配的卫星。</div>
                  <template v-else>
                    <div class="sres-list">
                      <div v-for="e in lvSatCand" :key="e.noradId || e.name" class="sitem" @click="lvPickSat(e)">
                        <div class="nm" :title="e.name" data-i18n-skip>{{ e.name }}</div>
                        <div class="sub">{{ e.tag }}<template v-if="e.noradId"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template></div>
                      </div>
                    </div>
                    <div class="sres-n">{{ lvSatTotal > lvSatCand.length ? ('命中 ' + lvSatTotal + ' 颗 · 列出前 ' + lvSatCand.length) : (lvSatTotal + ' 颗') }}</div>
                  </template>
                </div>
                <div v-if="envLive.satUnresolved.value" class="srow"><span class="tip inl cov-msg">目标星星历未载入</span></div>
              </template>
              <template v-else>
                <div class="srow"><label>星下点</label>
                  <NumBox class="ci cov-num" :min="-180" :max="180" :step="0.5" :model-value="Number(envLive.manSat.lon)" @commit="v => envLive.manSat.lon = v" /><span class="u">°E</span>
                  <NumBox class="ci cov-num" :min="-90" :max="90" :step="0.5" :model-value="Number(envLive.manSat.lat)" @commit="v => envLive.manSat.lat = v" /><span class="u">°N</span>
                </div>
                <div class="srow"><label>轨道高度</label><NumBox class="ci cov-num" :min="100" :max="400000" :step="50" :model-value="Number(envLive.manSat.altKm)" @commit="v => envLive.manSat.altKm = v" title="星下点处的大地高（椭球面以上），与 SGP4 出参同口径" /><span class="u">km</span></div>
              </template>
              <!-- 「星下点」独立成 span：与后面的坐标挤在同一个文本节点里就查不到词典（见 i18n 的三类漏译） -->
              <div v-if="lvSatPosText" class="srow"><span class="tip inl"><span>星下点</span> {{ lvSatPosText }}</span></div>
              <div class="srow"><label>频率</label><NumBox class="ci cov-num" :min="1" :max="60" :step="0.5" :model-value="Number(envLive.freq.value)" @commit="v => envLive.freq.value = String(v)" /><span class="u">GHz</span>
                <select class="cov-scheme" :value="envLive.pol.value" @change="e => envLive.pol.value = e.target.value" title="极化方式（ITU-R P.838 的 k / α 随极化取值）">
                  <option value="C">圆</option><option value="V">垂直</option><option value="H">水平</option>
                </select>
              </div>
              <div class="srow"><label>最低仰角</label>
                <select :value="envLive.minElev.value" @change="e => envLive.minElev.value = Number(e.target.value)" title="低于该仰角一律留白。掠地几何下斜路径长度发散，单格可达 150 dB；ITU-R P.618 / P.676 的路径近似在 5° 以下不成立，且孤立极值会压缩整条色带">
                  <option v-for="o in envLive.MIN_ELEVS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>路径模型</label>
                <select :value="envLive.pathModel.value" @change="e => envLive.pathModel.value = e.target.value" title="由格点雨强推算整条斜路径的口径。「统计折减」采用 ITU-R P.618 按 0.01% 超越概率标定的折减因子，用于瞬时值时对小雨偏高、对大雨偏低，两个方向均非上下界">
                  <option v-for="o in envLive.PATH_MODELS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>云衰</label>
                <select :value="envLive.cloudMode.value" @change="e => envLive.cloudMode.value = e.target.value" title="实测档取模式输出的柱云水（含冰相，偏高）；统计档取 ITU-R P.840 长期分布，与当前天气无关。数据源无柱云水时自动回退统计档，并在读数行标明">
                  <option v-for="o in envLive.CLOUD_MODES" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
            </template>
          </div>

          <div class="sec">
            <div class="sect acc" data-sec="lv-src" :class="{ open: isSecOpen('lv-src') }" @click="toggleSec('lv-src')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('lv-src') }" :size="12" /><span>数据场</span></div>
            <template v-if="isSecOpen('lv-src')">
              <div class="srow"><label>字段</label>
                <select :value="envLive.key.value" @change="e => envLive.key.value = e.target.value" title="切换字段不产生请求：单次获取已包含全部要素">
                  <optgroup v-for="g in envLive.defGroups.value" :key="g.label" :label="g.label">
                    <option v-for="d in g.items" :key="d.key" :value="d.key">{{ d.label }}</option>
                  </optgroup>
                </select>
              </div>
              <div class="srow"><label>渲染格距</label>
                <select :value="envLive.outStep.value" @change="e => envLive.outStep.value = Number(e.target.value)" title="在已获取的数据体上作双线性细化，本地计算、不联网。细于源格距的档位属插值，仅消除格点锯齿，不增加信息量">
                  <option v-for="o in envLive.OUT_STEPS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div class="srow"><label>渲染点数上限</label>
                <select :value="envLive.detail.value" @change="e => envLive.detail.value = Number(e.target.value)" title="衰减场逐格调用一次 ITU-R 引擎；点数上限是时间轴响应速度与成图细度之间的取舍。气象要素场不受此限">
                  <option v-for="o in envLive.DETAILS" :key="o.v" :value="o.v">{{ o.label }}</option>
                </select>
              </div>
              <div v-if="envLive.meta.value" class="srow"><span class="tip inl" :class="{ 'cov-msg': !envLive.frameInfo.value.inRange }">{{ liveTimeText }}</span></div>
              <div v-if="envLive.srcNote.value" class="srow env-src"><span class="tip inl">{{ envLive.busy.value ? '渲染中…' : envLive.srcNote.value }}</span></div>
            </template>
          </div>

          <div class="sec">
            <div class="sect acc" data-sec="lv-style" :class="{ open: isSecOpen('lv-style') }" @click="toggleSec('lv-style')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('lv-style') }" :size="12" /><span>配色与值域</span></div>
            <template v-if="isSecOpen('lv-style')">
              <div class="srow"><label>配色</label>
                <select class="cov-scheme" :value="envLive.scheme.value" @change="e => envLive.scheme.value = e.target.value" title="前四档为气象业务色阶：低值透明、按业务档位分色，叠加于影像底图即为常规云图效果。后五档为连续科学色图，全不透明">
                  <optgroup label="气象业务">
                    <option v-for="o in envLive.SCHEMES.slice(0, 4)" :key="o.v" :value="o.v">{{ o.label }}</option>
                  </optgroup>
                  <optgroup label="科学色图">
                    <option v-for="o in envLive.SCHEMES.slice(4)" :key="o.v" :value="o.v">{{ o.label }}</option>
                  </optgroup>
                </select>
                <label class="chk-in" title="色标反向（低值取暖端）"><input type="checkbox" v-model="envLive.invert.value" /><span>反相</span></label>
              </div>
              <div class="srow"><label>填色</label>
                <span class="seg">
                  <span class="sg" :class="{ on: envLive.bands.value === 0 }" title="连续渐变" @click="envLive.bands.value = 0">连续</span>
                  <span class="sg" :class="{ on: envLive.bands.value > 0 }" title="分级填色：档间为硬边界，边界即等值线" @click="envLive.bands.value = envLive.bands.value > 0 ? envLive.bands.value : 8">分级</span>
                </span>
                <NumBox v-if="envLive.bands.value > 0" class="ci cov-num" :min="2" :max="24" :step="1" :model-value="envLive.bands.value" @commit="v => envLive.bands.value = v" /><span v-if="envLive.bands.value > 0" class="u">档</span>
              </div>
              <div class="srow"><label>值域</label>
                <span class="seg">
                  <span class="sg" :class="{ on: envLive.domainMode.value === 'levels', dis: !envLive.hasLevels.value }" title="业务档位：值轴不等距、色轴等距，锚点由字段自带。同一数值在各帧恒为同一颜色，可跨帧比较" @click="envLive.hasLevels.value ? envLive.domainMode.value = 'levels' : null">档位</span>
                  <span class="sg" :class="{ on: envLive.domainMode.value === 'p2p98' }" title="按 2%–98% 分位拉伸：颜色随各帧数据分布变化，不可跨帧比较" @click="envLive.domainMode.value = 'p2p98'">分位</span>
                  <span class="sg" :class="{ on: envLive.domainMode.value === 'minmax' }" title="全域极值" @click="envLive.domainMode.value = 'minmax'">极值</span>
                  <span class="sg" :class="{ on: envLive.domainMode.value === 'manual' }" title="手动指定上下限" @click="liveManualInit()">手动</span>
                </span>
              </div>
              <div v-if="envLive.domainMode.value === 'manual'" class="srow"><label>上下限</label>
                <input class="ci cov-b" type="number" :value="envLive.manualLo.value" @input="e => envLive.manualLo.value = e.target.value" /><span class="u">~</span>
                <input class="ci cov-b" type="number" :value="envLive.manualHi.value" @input="e => envLive.manualHi.value = e.target.value" /><span class="u">{{ envLive.field.value ? envLive.field.value.unit : '' }}</span>
              </div>
              <div class="srow"><label>透明度</label><input class="vis-slider cov-alpha" type="range" min="0.1" max="1" step="0.02" :value="envLive.alpha.value" @input="e => envLive.alpha.value = Number(e.target.value)" title="整层不透明度；与气象色阶自带的逐像素透明度相乘" /><span class="u">{{ Math.round(envLive.alpha.value * 100) }}%</span></div>
              <label class="chk2" :class="{ dis: !envMaskAvail }"><input type="checkbox" :disabled="!envMaskAvail" v-model="envLive.landOnly.value" /><span>海洋透明（ITU-R P.1511 高程 ≤ 0 判为海域）</span></label>
              <div v-if="envLive.legend.value" class="cov-legend">
                <div class="cov-legbar" :class="{ stepped: envLive.legend.value.stepped }"><i v-for="(o, oi) in envLive.legend.value.stops" :key="oi" :style="{ background: o.css }"></i></div>
                <div v-if="envLive.legend.value.ticks" class="lv-legtick" :style="{ gridTemplateColumns: 'repeat(' + envLive.legend.value.ticks.length + ', 1fr)' }">
                  <span v-for="(t, ti) in envLive.legend.value.ticks" :key="ti">{{ envLive.fmt(t.v) }}</span>
                </div>
                <div class="cov-legsc"><span v-if="!envLive.legend.value.ticks">{{ envLive.fmt(envLive.legend.value.lo) }}</span><b :title="envLive.legend.value.label">{{ envLive.legend.value.label }}{{ envLive.legend.value.unit ? ' · ' + envLive.legend.value.unit : '' }}</b><span v-if="!envLive.legend.value.ticks">{{ envLive.fmt(envLive.legend.value.hi) }}</span></div>
              </div>
              <div v-if="envLive.stats.value" class="vis-sum cov-kpi">
                <span>极值 <b>{{ envLive.fmt(envLive.stats.value.min) }}</b> ~ <b>{{ envLive.fmt(envLive.stats.value.max) }}</b> {{ envLive.field.value.unit }}</span>
                <span>面积加权均值 <b>{{ envLive.fmt(envLive.stats.value.mean) }}</b> {{ envLive.field.value.unit }}</span>
              </div>
            </template>
          </div>

        </div>
        </div>

        <!-- 聚焦卫星：轨道线 / 星下点轨迹 / 覆盖圈 / 覆盖锥 / 卫星标记 的显示样式 -->
        <div v-show="shellUi.side === 'focus'" class="sview">
        <div class="cov-side focus-side docked">

        <div class="sec" :class="{ hid: !focusStyle.orbOn }">
          <div class="sect acc" data-sec="foc-orb" :class="{ open: isSecOpen('foc-orb') }" @click="toggleSec('foc-orb')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('foc-orb') }" :size="12" /><span>轨道线</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('orb')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.orbOn }" role="switch" :aria-checked="focusStyle.orbOn ? 'true' : 'false'" :title="focusStyle.orbOn ? '隐藏轨道线' : '显示轨道线'" @click.stop="toggleFocus('orbOn')"><i></i></button></div>
          <template v-if="isSecOpen('foc-orb')">
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="focusStyle.orbColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.orbColor }}</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="focusStyle.orbWidth" @input="applyFocusStyle" /><span class="u">{{ focusStyle.orbWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="focusStyle.orbOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.orbOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="轨道线线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: focusStyle.orbDash === d.k }" @click="setFocusVal('orbDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !focusStyle.trkOn }">
          <div class="sect acc" data-sec="foc-trk" :class="{ open: isSecOpen('foc-trk') }" @click="toggleSec('foc-trk')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('foc-trk') }" :size="12" /><span>星下点轨迹</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('trk')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.trkOn }" role="switch" :aria-checked="focusStyle.trkOn ? 'true' : 'false'" :title="focusStyle.trkOn ? '隐藏星下点轨迹' : '显示星下点轨迹'" @click.stop="toggleFocus('trkOn')"><i></i></button></div>
          <template v-if="isSecOpen('foc-trk')">
          <div class="srow"><label>形式</label>
            <span class="seg nseg" role="group" aria-label="星下点轨迹形式">
              <span class="sg" :class="{ on: focusStyle.trkMode !== 'swath' }" title="只画星下点轨迹线" @click="setFocusVal('trkMode', 'line')">轨迹线</span>
              <span class="sg" :class="{ on: focusStyle.trkMode === 'swath' }" title="按覆盖圈口径沿轨迹扫过的覆盖带（轨迹面）" @click="setFocusVal('trkMode', 'swath')">轨迹面</span>
            </span>
          </div>
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="focusStyle.trkColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkColor }}</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="focusStyle.trkWidth" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="focusStyle.trkOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="星下点轨迹线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: focusStyle.trkDash === d.k }" @click="setFocusVal('trkDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          <template v-if="focusStyle.trkMode === 'swath'">
          <div class="srow" title="带内填色；0＝不填"><label>区域填充</label><input class="rng" type="range" min="0" max="1" step="0.02" v-model.number="focusStyle.trkFillOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkFillOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>填充颜色</label><input class="clr" type="color" v-model="focusStyle.trkFillColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkFillColor }}</span></div>
          </template>
          <div class="srow"><label>轨迹长度</label>
            <span class="seg nseg" role="group" aria-label="星下点轨迹长度口径">
              <span class="sg" :class="{ on: focusStyle.trkSpanMode !== 'time' }" title="按轨道周期的倍数给长度" @click="setTrkSpanMode('rev')">轨迹圈数</span>
              <span class="sg" :class="{ on: focusStyle.trkSpanMode === 'time' }" title="按时长给长度（分钟）" @click="setTrkSpanMode('time')">轨迹周期</span>
            </span>
          </div>
          <div v-if="focusStyle.trkSpanMode !== 'time'" class="srow" title="从当前时刻起画几个轨道周期的星下点轨迹"><label>轨迹圈数</label><input class="ci" :value="trkVal('rev')" placeholder="1" @input="e => trkInput('rev', e)" @change="trkCommit('rev')" @blur="trkCommit('rev')" @keyup.enter="trkCommit('rev')" /><span class="u">圈</span></div>
          <div v-else class="srow" title="从当前时刻起画多长时间的星下点轨迹（分钟）"><label>轨迹周期</label><input class="ci" :value="trkVal('time')" placeholder="0" @input="e => trkInput('time', e)" @change="trkCommit('time')" @blur="trkCommit('time')" @keyup.enter="trkCommit('time')" /><span class="u">min</span></div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !focusStyle.fpOn }">
          <div class="sect acc" data-sec="foc-fp" :class="{ open: isSecOpen('foc-fp') }" @click="toggleSec('foc-fp')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('foc-fp') }" :size="12" /><span>覆盖圈</span><span class="lnk" title="本节恢复出厂样式（不动口径）" @click.stop="resetFocusPart('fp')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.fpOn }" role="switch" :aria-checked="focusStyle.fpOn ? 'true' : 'false'" :title="focusStyle.fpOn ? '隐藏覆盖圈' : '显示覆盖圈'" @click.stop="toggleFocus('fpOn')"><i></i></button></div>
          <template v-if="isSecOpen('foc-fp')">
          <div class="srow"><label>口径</label>
            <span class="seg nseg" role="group" aria-label="覆盖圈定义">
              <span class="sg" :class="{ on: fpMode === 'beam' }" title="按星上波束角（全锥角）画覆盖圈" @click="setFpMode('beam')">波束角</span>
              <span class="sg" :class="{ on: fpMode === 'elev' }" title="按地面最低仰角画覆盖圈（0°=地平线）" @click="setFpMode('elev')">最低仰角</span>
            </span>
          </div>
          <div v-if="fpMode === 'beam'" class="srow"><label>波束全锥角</label><input class="ci" :value="fpVal('beam')" :placeholder="beamAuto || '自动'" title="波束全锥角，空=对地全视场（失焦或回车生效）" @input="e => fpInput('beam', e)" @change="fpCommit('beam')" @blur="fpCommit('beam')" @keyup.enter="fpCommit('beam')" /><span class="u">°</span><span class="covlock" :class="{ on: beamLock }" :title="beamLock ? '已锁定：超出该星上限不截断' : '锁定：超出该星上限时不回写截断值'" @click="toggleBeamLock"><Icon :name="beamLock ? 'lock' : 'lock-open'" :size="12" /></span></div>
          <div v-else class="srow"><label>最低仰角</label><input class="ci" :value="fpVal('elev')" placeholder="0" title="最低仰角，0°=地平线（失焦或回车生效）" @input="e => fpInput('elev', e)" @change="fpCommit('elev')" @blur="fpCommit('elev')" @keyup.enter="fpCommit('elev')" /><span class="u">°</span></div>
          <div class="srow"><label>线颜色</label><input class="clr" type="color" v-model="focusStyle.fpColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.fpColor }}</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="focusStyle.fpWidth" @input="applyFocusStyle" /><span class="u">{{ focusStyle.fpWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="focusStyle.fpOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.fpOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="覆盖圈线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: focusStyle.fpDash === d.k }" @click="setFocusVal('fpDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          <div class="srow" title="圈内填色（画在 GRD 覆盖场之下，叠加区仍以覆盖图为准）；0＝不填"><label>区域填充</label><input class="rng" type="range" min="0" max="1" step="0.02" v-model.number="focusStyle.fpFillOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.fpFillOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>填充颜色</label><input class="clr" type="color" v-model="focusStyle.fpFillColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.fpFillColor }}</span></div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !focusStyle.coneOn }">
          <div class="sect acc" data-sec="foc-cone" :class="{ open: isSecOpen('foc-cone', false) }" @click="toggleSec('foc-cone', false)" title="卫星本体到覆盖圈边界的锥体（锥面＋母线），张角随上面的口径走；仅 3D 球体绘制"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('foc-cone', false) }" :size="12" /><span>覆盖锥</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('cone')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.coneOn }" role="switch" :aria-checked="focusStyle.coneOn ? 'true' : 'false'" :title="focusStyle.coneOn ? '隐藏覆盖锥' : '显示覆盖锥'" @click.stop="toggleFocus('coneOn')"><i></i></button></div>
          <template v-if="isSecOpen('foc-cone', false)">
          <div class="srow" title="锥侧面填色，0＝只留母线"><label>锥面</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="focusStyle.coneFaceOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneFaceOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>锥面颜色</label><input class="clr" type="color" v-model="focusStyle.coneFaceColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneFaceColor }}</span></div>
          <div class="srow" title="沿方位等分画几条母线，0＝只留锥面"><label>母线根数</label><input class="rng" type="range" min="0" max="36" step="1" v-model.number="focusStyle.coneGenCount" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneGenCount }}</span></div>
          <div class="srow"><label>母线颜色</label><input class="clr" type="color" v-model="focusStyle.coneGenColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneGenColor }}</span></div>
          <div class="srow"><label>母线线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="focusStyle.coneGenWidth" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneGenWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>母线透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="focusStyle.coneGenOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.coneGenOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>母线线型</label>
            <span class="seg nseg" role="group" aria-label="母线线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: focusStyle.coneGenDash === d.k }" @click="setFocusVal('coneGenDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="foc-mk" :class="{ open: isSecOpen('foc-mk', false) }" @click="toggleSec('foc-mk', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('foc-mk', false) }" :size="12" /><span>卫星标记</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('mk')">默认</span></div>
          <template v-if="isSecOpen('foc-mk', false)">
          <label class="chk2" title="整个星座的星点（仅 3D 球体）。关掉后地图上只剩聚焦星的标记，星点也不再可点选"><input type="checkbox" v-model="focusStyle.cloudOn" @change="applyFocusStyle" /><span>星座点云</span></label>
          <label class="chk2" title="卫星真实在轨位置上的大号圆点，颜色跟随该星在星座里的配色"><input type="checkbox" v-model="focusStyle.dotOn" @change="applyFocusStyle" /><span>在轨点</span></label>
          <div v-if="focusStyle.dotOn" class="srow sub"><label>大小</label><input class="rng" type="range" min="4" max="24" step="1" v-model.number="focusStyle.dotPx" @input="applyFocusStyle" /><span class="u">{{ focusStyle.dotPx }}</span></div>
          <label class="chk2"><input type="checkbox" v-model="focusStyle.subOn" @change="applyFocusStyle" /><span>星下点图标</span></label>
          <template v-if="focusStyle.subOn">
          <div class="srow sub"><label>大小</label><input class="rng" type="range" min="8" max="64" step="1" v-model.number="focusStyle.subPx" @input="applyFocusStyle" /><span class="u">{{ focusStyle.subPx }}</span></div>
          <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="focusStyle.subColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.subColor }}</span></div>
          </template>
          <label class="chk2" title="套在聚焦星本体上的圆环（在轨高度，不是星下点）"><input type="checkbox" v-model="focusStyle.ringOn" @change="applyFocusStyle" /><span>高亮环</span></label>
          <template v-if="focusStyle.ringOn">
          <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="focusStyle.ringColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.ringColor }}</span></div>
          <div class="srow sub"><label>大小</label><input class="rng" type="range" min="10" max="60" step="1" v-model.number="focusStyle.ringPx" @input="applyFocusStyle" /><span class="u">{{ focusStyle.ringPx }}</span></div>
          </template>
          </template>
        </div>

        </div>
        </div>

        <!-- 卫星模型：当前卫星的模型绑定 / 显示 / 模型库（独立组件，见 ModelSidePanel.vue） -->
        <div v-show="shellUi.side === 'model'" class="sview">
          <ModelSidePanel
            :sat="selSat" :model="selModel" :lib="modelLib.list" :following="!!following" :can-follow="!flatView" :st="focusStyle"
            @toggle-follow="toggleFollow" @bind="bindModel" @set-style="setModelStyle" @reset-style="resetModelStyle" @open-wb="openModelWorkbench"
          />
        </div>

        <!-- 地图设置：海陆配色 / 国界省界市界 / 名称标注 -->
        <div v-show="shellUi.side === 'geo'" class="sview">
        <div class="cov-side geo-side docked">
        <div class="sec">
          <div class="sect acc" data-sec="geo-proj" :class="{ open: isSecOpen('geo-proj', false) }" @click="toggleSec('geo-proj', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-proj', false) }" :size="12" /><span>2D 投影</span></div>
          <template v-if="isSecOpen('geo-proj', false)">
          <div class="srow"><label>投影</label>
            <select :value="mapCrs.proj" :title="projTitle" @change="setMapProj($event.target.value)">
              <option v-for="pj in PROJECTIONS" :key="pj.k" :value="pj.k">{{ byLang(pj.zh, pj.en) }}</option>
            </select>
          </div>
          <div class="srow"><label>画面中心</label><NumBox class="ci cov-b" :min="-180" :max="180" :step="0.5" :model-value="crsCenter" title="2D 平面图正中那条经线的经度（东正西负）；接缝随之落到它的对面。也是各投影的中央经线 —— Albers 设成 105°E 即得常规中国全图。3D 球体没有接缝，不受影响" @commit="setCrsCenter" /><span class="u">{{ crsCenterTag }}</span></div>
          <div v-if="projHasLat0" class="srow"><label>中心纬度</label><NumBox class="ci cov-b" :min="-90" :max="90" :step="0.5" :model-value="mapCrs.lat0" title="投影中心那一点的纬度（北正南负）；配上「画面中心」那条经线即圆心。3D 球体不受影响" @commit="setProjLat0" /><span class="u">{{ projLat0Tag }}</span></div>
          <div v-if="projHasPar" class="srow"><label>标准纬线</label>
            <NumBox class="ci cov-b" :min="-89.5" :max="89.5" :step="0.5" :model-value="mapCrs.par1" title="圆锥与球面相割的两条纬线，其上无变形。常规中国全图取 25°N / 47°N" @commit="(v) => setProjPar(1, v)" />
            <NumBox class="ci cov-b" :min="-89.5" :max="89.5" :step="0.5" :model-value="mapCrs.par2" title="圆锥与球面相割的两条纬线，其上无变形。常规中国全图取 25°N / 47°N" @commit="(v) => setProjPar(2, v)" />
          </div>
          <div class="srow stack"><label>常用</label>
            <span class="seg nseg" role="group" aria-label="常用画面中心">
              <span v-for="c in CENTER_PRESETS" :key="c.v" class="sg" :class="{ on: Math.abs(crsCenter - c.v) < 0.25 }" @click="setCrsCenter(c.v)">{{ c.zh }}</span>
            </span>
          </div>
          <div class="srow"><label>投影中心</label>
            <span class="seg nseg" role="group" aria-label="投影中心">
              <span class="sg" :class="{ on: projSpin }" title="开着之后在图上左键拖动改的是投影中心，不再平移画面；拖动过程中底图降到简版、覆盖场与影像暂不画，松手补全" @click="toggleProjSpin">拖动调整</span>
              <span class="sg" :class="{ on: subOpen }" :title="projSatTitle" @click="projCenterToSat">星下点</span>
            </span>
          </div>
          <template v-if="subOpen">
          <div class="srow"><label>星下点</label>
            <span class="seg nseg" role="group" aria-label="星下点来源">
              <span v-for="ss in SUB_SRCS" :key="ss.k" class="sg" :class="{ on: subSrc === ss.k }" :title="subPtTitle" @click="setSubSrc(ss.k)">{{ byLang(ss.zh, ss.en) }}</span>
            </span>
          </div>
          <template v-if="subSrc === 'manual'">
            <div class="srow sub"><label>经度</label><NumBox class="ci cov-b" :min="-180" :max="180" :step="0.5" :model-value="manLon" title="星下点经度（东正西负）" @commit="(v) => { manLon = v; applyManual() }" /><span class="u">°E</span></div>
            <div class="srow sub"><label>纬度</label><NumBox class="ci cov-b" :min="-90" :max="90" :step="0.5" :model-value="manLat" title="星下点纬度（北正南负）" @commit="(v) => { manLat = v; applyManual() }" /><span class="u">°N</span></div>
            <div class="srow sub"><label>高度</label><NumBox class="ci cov-b" :min="100" :max="500000" :step="100" :model-value="manAlt" title="卫星轨道高度。az/el 与 u/v 是【从卫星看】的角，只给经纬度算不出来；留空按 GEO 35786 km" @commit="(v) => { manAlt = v; applyManual() }" /><span class="u">km</span></div>
          </template>
          <template v-else-if="subSrc === 'tree'">
            <div class="srow sub"><label>卫星</label>
              <select :value="mapCrs.subPt && mapCrs.subPt.src === 'tree' ? mapCrs.subPt.folder : ''" :title="subPtTitle" @change="pickTreeSat($event.target.value)">
                <option value="" disabled>{{ byLang('从覆盖图卫星树选', 'From the coverage sat tree') }}</option>
                <option v-for="n in treeSats" :key="n.folder" :value="n.folder">{{ n.satName }}</option>
              </select>
            </div>
          </template>
          <template v-else>
            <div class="srow sub"><label>搜索</label>
              <input class="ci" :value="refQ" placeholder="卫星名 / NORAD" :title="subPtTitle" @input="onRefSearch" />
              <span v-if="projSatName" class="seg nseg"><span class="sg" :title="'用地图上选中的 ' + projSatName" @click="useSelectedAsRef">选中的</span></span>
            </div>
            <div v-if="refResults.length" class="ref-list">
              <div v-for="r in refResults" :key="r.id" class="ref-it" @click="pickRefSat(r)">
                <span class="rn">{{ r.name }}</span><span class="ru">{{ r.slot || r.noradId }}</span>
              </div>
            </div>
          </template>
          <div v-if="mapCrs.subPt" class="srow sub"><label>当前</label>
            <span class="ci ro" :title="subPtTitle">{{ subPtRead }}</span>
            <span class="seg nseg">
              <span class="sg" :class="{ on: mapCrs.subFollow, dis: mapCrs.subPt.src === 'manual' }" title="星下点一动，画面跟着走。自己拖过画面就自动关掉；再按「星下点」按钮可以重新跟上" @click="setMapCrs({ subFollow: !mapCrs.subFollow })">跟随</span>
              <span class="sg" title="取消星下点（标记与光标读数一并停掉）" @click="clearSubPt">清除</span>
            </span>
          </div>
          <div class="srow"><label>光标读数</label>
            <span class="seg nseg" role="group" aria-label="光标读数">
              <span v-for="m in LOOK_MODES" :key="m.k" class="sg" :class="{ on: mapCrs.lookMode === m.k, dis: m.k !== 'off' && !mapCrs.subPt }" :title="lookTitle" @click="setLookMode(m.k)">{{ byLang(m.zh, m.en) }}</span>
            </span>
          </div>
          </template>
          </template>
        </div>
        <div class="sec" :class="{ hid: !spaceOn }">
          <div class="sect acc" data-sec="geo-space" :class="{ open: isSecOpen('geo-space', false) }" @click="toggleSec('geo-space', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-space', false) }" :size="12" /><span>宇宙空间</span><span class="lnk" title="本节恢复出厂样式（不动总开关）" @click.stop="resetSpace">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: spaceOn }" role="switch" :aria-checked="spaceOn ? 'true' : 'false'" :title="spaceOn ? '关闭宇宙空间' : '开启宇宙空间'" @click.stop="toggleSpace"><i></i></button></div>
          <template v-if="isSecOpen('geo-space', false)">
          <label class="chk2" title="约 110 颗亮星按真实赤经赤纬与视星等、其余按星等计数律补足，另有银河带；静态不闪，随恒星时转动；仅 3D 球体"><input type="checkbox" :checked="space.stars" @change="setSpaceItem('stars', $event.target.checked)" /><span>星空</span></label>
          <div v-if="space.stars" class="srow sub"><label>星空亮度</label><input class="rng" type="range" min="0.2" max="2" step="0.05" v-model.number="space.starGain" @input="applySpace" /><span class="u">{{ space.starGain.toFixed(2) }}</span></div>
          <label class="chk2" title="地球临边的大气散射：昼侧亮蓝、夜侧几乎不见、晨昏线附近偏暖，与晨昏效果同一个太阳方向；仅 3D 球体"><input type="checkbox" :checked="space.atmo" @change="setSpaceItem('atmo', $event.target.checked)" /><span>大气辉光</span></label>
          <div v-if="space.atmo" class="srow sub"><label>辉光强度</label><input class="rng" type="range" min="0.2" max="2" step="0.05" v-model.number="space.atmoGain" @input="applySpace" /><span class="u">{{ space.atmoGain.toFixed(2) }}</span></div>
          <label class="chk2" title="日面 + 柔和眩光，沉到地球背后时淡出；仅 3D 球体"><input type="checkbox" :checked="space.sun" @change="setSpaceItem('sun', $event.target.checked)" /><span>太阳</span></label>
          <div v-if="space.sun" class="srow sub"><label>眩光强度</label><input class="rng" type="range" min="0" max="2" step="0.05" v-model.number="space.sunGlare" @input="applySpace" /><span class="u">{{ space.sunGlare.toFixed(2) }}</span></div>
          <label class="chk2" title="真彩卫星影像，3D 球体与平面图同一份；「高精」档平面图用瓦片金字塔、3D 球体用 16K 整幅（显卡纹理上限不足 16384 时自动落到 8K）"><input type="checkbox" :checked="space.img" @change="setSpaceItem('img', $event.target.checked)" /><span>地球影像</span></label>
          <div v-if="space.img" class="srow sub"><label>分辨率</label>
            <span class="seg nseg" role="group" aria-label="影像分辨率">
              <span v-for="im in IMAGERY_SOURCES" :key="im.k" class="sg" :class="{ on: imageryKey === im.k }" :title="imageryTitle(im)" @click="setImageryKey(im.k)">{{ im.zh }}</span>
            </span>
          </div>
          <div v-if="space.img" class="srow sub"><label>亮度</label><input class="rng" type="range" min="0.3" max="1.2" step="0.05" :value="imageryBright" title="压暗影像，让边界线与覆盖场看得清；100% 为原图" @input="setImageryBright" /><span class="u">{{ Math.round(imageryBright * 100) }}%</span></div>
          <label class="chk2" title="夜半球按太阳高度角从 0° 到 −18° 平滑压暗（民用 −6° / 航海 −12° / 天文 −18° 曙暮光），卫星模型按太阳方向受光、进地影变暗；不勾时地球与卫星全亮。3D 球体与平面图"><input type="checkbox" :checked="space.night" @change="setSpaceItem('night', $event.target.checked)" /><span>晨昏效果</span></label>
          <div v-if="space.night" class="srow sub"><label>夜区颜色</label><input class="clr" type="color" v-model="space.nightColor" @input="applySpace" /><span class="u">{{ space.nightColor }}</span></div>
          <div class="srow sub" v-if="space.night" title="太阳高度角 −18° 以下（全黑夜）的不透明度"><label>夜区强度</label><input class="rng" type="range" min="0" max="0.95" step="0.01" v-model.number="space.nightOpacity" @input="applySpace" /><span class="u">{{ space.nightOpacity.toFixed(2) }}</span></div>
          <label class="chk2" title="太阳中心高度角 0° 的昼夜分界线；晨昏效果不勾时自带一层夜区阴影（勾着时夜区归晨昏效果）。3D 球体与平面图"><input type="checkbox" :checked="space.line" @change="setSpaceItem('line', $event.target.checked)" /><span>晨昏线</span></label>
          <div v-if="space.line" class="srow sub"><label>线颜色</label><input class="clr" type="color" v-model="space.lineColor" @input="applySpace" /><span class="u">{{ space.lineColor }}</span></div>
          <div v-if="space.line" class="srow sub"><label>线粗</label><input class="rng" type="range" min="0.1" max="4" step="0.1" v-model.number="space.lineWidth" @input="applySpace" /><span class="u">{{ space.lineWidth.toFixed(1) }}</span></div>
          <div v-if="space.line" class="srow sub"><label>线透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="space.lineOpacity" @input="applySpace" /><span class="u">{{ space.lineOpacity.toFixed(2) }}</span></div>
          <div v-if="space.line && !space.night" class="srow sub"><label>夜区颜色</label><input class="clr" type="color" v-model="space.shadeColor" @input="applySpace" /><span class="u">{{ space.shadeColor }}</span></div>
          <div v-if="space.line && !space.night" class="srow sub" title="整个夜半球的不透明度；0 = 只画线"><label>夜区强度</label><input class="rng" type="range" min="0" max="0.95" step="0.01" v-model.number="space.shadeOpacity" @input="applySpace" /><span class="u">{{ space.shadeOpacity.toFixed(2) }}</span></div>
          <div class="srow" v-if="spaceSub" title="太阳直射点（时间轴当前时刻）"><label>日下点</label><span class="u">{{ fmtSlot(spaceSub.lon) + ' · ' + Math.abs(spaceSub.lat).toFixed(2) + '°' + (spaceSub.lat >= 0 ? 'N' : 'S') }}</span></div>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" data-sec="geo-ocean" :class="{ open: isSecOpen('geo-ocean') }" @click="toggleSec('geo-ocean')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-ocean') }" :size="12" /><span>配色</span></div>
          <template v-if="isSecOpen('geo-ocean')">
          <div class="bsub"><span>大海</span></div>
          <div class="swatches">
            <span v-for="c in OCEAN_BLUES" :key="c" class="sw" :class="{ on: oceanColor === c }" :style="{ background: c }" :title="c" @click="setOceanColor(c)"></span>
          </div>
          <div class="bsub"><span>大地</span></div>
          <div class="swatches">
            <span class="sw swmix" :class="{ on: landScheme === 'morandi' }" title="莫兰迪杂色（默认）" @click="setLandScheme('morandi')"></span>
            <span v-for="c in LAND_UNIFORMS" :key="c" class="sw" :class="{ on: landScheme === c }" :style="{ background: c }" :title="c" @click="setLandScheme(c)"></span>
          </div>
          <div class="srow"><label>自定义底色</label><input class="clr" type="color" :value="landScheme === 'morandi' ? '#e4eccf' : landScheme" @change="setLandScheme($event.target.value)" /><span class="u">{{ landScheme === 'morandi' ? '杂色' : landScheme }}</span></div>
          <div class="bsub"><span>逐国设色</span></div>
          <div class="srow"><label>国家</label><input class="ci" v-model="landQuery" placeholder="输入中文名搜索" /></div>
          <div class="mlist" v-if="landHits.length">
            <div v-for="c in landHits" :key="c.id" class="mrow rowlk" @click="pickLandCountry(c)"><span class="mc">{{ c.zh }}</span></div>
          </div>
          <template v-if="landPick">
            <div class="srow"><label>{{ landPick.zh }}</label><input class="clr" type="color" :value="landPickColor" @input="setLandCountryColor(landPick.id, $event.target.value)" /><span class="u">{{ landPickColor }}</span></div>
            <div class="swatches">
              <span v-for="c in LAND_MORANDI" :key="c" class="sw" :class="{ on: landOverrides[landPick.id] === c }" :style="{ background: c }" :title="c" @click="setLandCountryColor(landPick.id, c)"></span>
            </div>
          </template>
          <template v-if="landOvList.length">
            <div class="mlist">
              <div v-for="o in landOvList" :key="o.id" class="mrow"><span class="swd" :style="{ background: o.color }"></span><span class="mc rowlk" @click="pickLandCountry(o)">{{ o.zh }}</span><span class="del" @click="removeLandCountryColor(o.id)"><Icon name="x" :size="12" /></span></div>
            </div>
            <div class="bsub"><span class="lnk" @click="clearLandOverrides">全部恢复默认</span></div>
          </template>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" data-sec="geo-border" :class="{ open: isSecOpen('geo-border', false) }" @click="toggleSec('geo-border', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-border', false) }" :size="12" /><span>边界线</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetBorderAll">默认</span></div>
          <template v-if="isSecOpen('geo-border', false)">
          <div class="srow stack"><label>预设</label>
            <span class="seg nseg" role="group" aria-label="边界线样式预设">
              <span v-for="pr in BORDER_PRESETS" :key="pr.k" class="sg" :title="pr.tip" @click="applyBorderPreset(pr.k)">{{ pr.zh }}</span>
            </span>
          </div>
          <div class="mlist pick">
            <div v-for="r in BORDER_ROWS" :key="r.k" class="mrow rowlk" :class="{ active: borderPick === r.k }" :title="r.tip" @click="borderPick = r.k">
              <span class="bsw" :style="swStyle(borderStyle[r.k + 'Color'], r.nodash ? 'solid' : borderStyle[r.k + 'Dash'])"></span><span class="mc lbl">{{ r.zh }}</span>
            </div>
          </div>
          <template v-for="r in BORDER_ROWS" :key="'d' + r.k">
            <template v-if="borderPick === r.k">
              <div v-if="r.vis" class="swrow"><span>显示</span><button type="button" class="layersw" :class="{ on: borderStyle.gridOn !== false }" role="switch" :aria-checked="borderStyle.gridOn !== false ? 'true' : 'false'" @click="setBorderVal('gridOn', borderStyle.gridOn === false)"><i></i></button></div>
              <div v-if="r.step" class="srow"><label>间隔</label>
                <span class="seg nseg" role="group" aria-label="经纬网间隔">
                  <span v-for="g in GRID_STEPS" :key="g" class="sg" :class="{ on: borderStyle.gridStep === g }" @click="setBorderVal('gridStep', g)">{{ g }}°</span>
                </span>
              </div>
              <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="borderStyle[r.k + 'Color']" @input="applyBorderStyle" /><span class="u">{{ borderStyle[r.k + 'Color'] }}</span></div>
              <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="borderStyle[r.k + 'Width']" @input="applyBorderStyle" /><span class="u">{{ borderStyle[r.k + 'Width'].toFixed(1) }}</span></div>
              <div class="srow"><label>透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle[r.k + 'Opacity']" @input="applyBorderStyle" /><span class="u">{{ borderStyle[r.k + 'Opacity'].toFixed(2) }}</span></div>
              <div v-if="!r.nodash" class="srow stack"><label>线型</label>
                <span class="seg nseg" role="group" :aria-label="r.zh + '线型'">
                  <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: borderStyle[r.k + 'Dash'] === d.k }" @click="setBorderVal(r.k + 'Dash', d.k)">{{ d.label }}</span>
                </span>
              </div>
              <div class="srow"><label></label><span class="lnk" title="本类恢复出厂样式" @click="resetBorderPart(r.k)">恢复本类默认</span></div>
            </template>
          </template>
          <label class="chk2" title="全球视角下二级行政区界完全淡出、一级降到 0.3，拉近后线性恢复；国界与海岸线不参与"><input type="checkbox" :checked="borderStyle.fade" @change="toggleBorderFade" /><span>行政区界按缩放淡出</span></label>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="geo-name" :class="{ open: isSecOpen('geo-name', false) }" @click="toggleSec('geo-name', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-name', false) }" :size="12" /><span>地名</span><span class="lnk" title="本节恢复出厂设置" @click.stop="resetNameAll">默认</span></div>
          <template v-if="isSecOpen('geo-name', false)">
          <div class="mlist pick">
            <div v-for="r in NAME_ROWS" :key="r.k" class="mrow rowlk" :class="{ active: namePick === r.k }" @click="pickNameRow(r.k)">
              <span class="swd" :style="{ background: labelStyle[r.k + 'Color'] }"></span><span class="mc lbl">{{ r.zh }}</span><span class="cnt2">{{ nameRowTag(r) }}</span>
            </div>
          </div>
          <template v-for="r in NAME_ROWS" :key="'n' + r.k">
            <template v-if="namePick === r.k">
              <div class="srow"><label>名称</label>
                <span class="seg nseg" role="group" :aria-label="r.zh + '档位'">
                  <span v-for="m in r.modes" :key="m[0]" class="sg" :class="{ on: nameRowMode(r.k) === m[0] }" :title="m[0] === 'local' ? '数据源自带的中文名；没有中文名的单元回落英文' : ''" @click="setNameRowMode(r.k, m[0])">{{ m[1] }}</span>
                </span>
              </div>
              <div class="srow"><label>字号</label><input class="rng" type="range" :min="r.min" :max="r.max" :step="r.step" :value="nameRowSize(r.k)" @input="setNameRowSize(r.k, $event.target.value)" /><span class="u">{{ nameRowSize(r.k).toFixed(2) }}</span></div>
              <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="labelStyle[r.k + 'Color']" @input="applyLabelStyle" /><span class="u">{{ labelStyle[r.k + 'Color'] }}</span></div>
              <div class="srow"><label>透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle[r.k + 'Opacity']" @input="applyLabelStyle" /><span class="u">{{ labelStyle[r.k + 'Opacity'].toFixed(2) }}</span></div>
              <label class="chk2"><input type="checkbox" v-model="labelStyle[r.k + 'Bold']" @change="applyLabelStyle" /><span>粗体</span></label>
              <template v-if="r.water">
                <div v-if="r.search" class="srow"><label>搜索</label><input class="ci" v-model="waterQuery" placeholder="中文 / English" /></div>
                <div class="mlist tall">
                  <div v-for="w in waterRows(r.water)" :key="w.id" class="mrow rowlk" @click="toggleWater(w.id)">
                    <input type="checkbox" :checked="waterOn(w.id)" @click.stop="toggleWater(w.id)" /><span class="mc">{{ byLang(w.zh, w.en) }}</span>
                  </div>
                </div>
                <div class="bsub"><span class="lnk" @click="setWaterAll(r.water, true)">全选</span><span class="lnk" @click="setWaterAll(r.water, false)">全不选</span></div>
              </template>
            </template>
          </template>
          </template>
        </div>

        <div class="sec" :class="{ hid: !showProvinces }">
          <div class="sect acc" data-sec="geo-adm" :class="{ open: isSecOpen('geo-adm', false) }" @click="toggleSec('geo-adm', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-adm', false) }" :size="12" /><span>行政区</span><button type="button" class="layersw sect-layersw" :class="{ on: showProvinces }" role="switch" :aria-checked="showProvinces ? 'true' : 'false'" :title="showProvinces ? '隐藏行政区界 / 名称' : '显示行政区界 / 名称'" @click.stop="toggleProvinces"><i></i></button></div>
          <template v-if="isSecOpen('geo-adm', false)">
          <div class="srow"><label>国家</label><input class="ci" v-model="admQuery1" placeholder="搜索国家（中文 / English / ISO3）" /></div>
          <div class="mlist tall">
            <div v-for="c in admHits" :key="c.id" class="mrow rowlk" @click="admToggleCountry(c.id)">
              <input type="checkbox" :checked="admSel1.includes(c.id)" @click.stop="admToggleCountry(c.id)" /><span class="mc">{{ byLang(c.zh, c.en) }}</span><span class="cnt2">{{ c.id }}</span>
            </div>
          </div>
          <div v-if="admChips.length" class="mlist">
            <div v-for="o in admChips" :key="o.id" class="mrow"><span class="mc">{{ byLang(o.zh, o.en) }}</span><span class="del" @click="admToggleCountry(o.id)"><Icon name="x" :size="12" /></span></div>
          </div>
          <template v-if="admHasCN">
            <div class="bsub"><span>中国</span></div>
            <div class="swrow" title="民政部口径的 332 个地级行政区（市 / 自治州 / 盟 / 地区）；其余国家暂无二级行政区数据">
              <span>地级市</span>
              <button type="button" class="layersw" :class="{ on: showCities }" role="switch" :aria-checked="showCities ? 'true' : 'false'" @click="toggleCities"><i></i></button>
            </div>
          </template>
          </template>
        </div>

        <div class="sec" :class="{ hid: !chainOn }">
          <div class="sect acc" data-sec="geo-chain" :class="{ open: isSecOpen('geo-chain', false) }" @click="toggleSec('geo-chain', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-chain', false) }" :size="12" /><span>岛链</span><button type="button" class="layersw sect-layersw" :class="{ on: chainOn }" role="switch" :aria-checked="chainOn ? 'true' : 'false'" :title="chainOn ? '隐藏岛链' : '显示岛链'" @click.stop="toggleChains"><i></i></button></div>
          <template v-if="isSecOpen('geo-chain', false)">
          <div class="mlist">
            <div v-for="c in CHAINS" :key="c.id" class="mrow rowlk" @click="toggleChain(c.id)">
              <input type="checkbox" :checked="chainVisible(c.id)" @click.stop="toggleChain(c.id)" /><span class="mc">{{ byLang(c.zh, c.en) }}</span>
            </div>
          </div>
          <div class="srow"><label>名称</label>
            <span class="seg nseg" role="group" aria-label="岛链名档位">
              <span v-for="m in [['zh', '中文'], ['en', '英文'], ['off', '不显示']]" :key="m[0]" class="sg" :class="{ on: chainStyle.name === m[0] }" @click="setChainName(m[0])">{{ m[1] }}</span>
            </span>
          </div>
          <div v-if="chainStyle.name !== 'off'" class="srow"><label>字号</label><input class="rng" type="range" min="0.1" max="3" step="0.05" v-model.number="chainStyle.nameSize" @input="applyChains" /><span class="u">{{ chainStyle.nameSize.toFixed(2) }}</span></div>
          <label v-if="chainStyle.name !== 'off'" class="chk2"><input type="checkbox" v-model="chainStyle.nameBold" @change="applyChains" /><span>粗体</span></label>
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="chainStyle.color" @input="applyChains" /><span class="u">{{ chainStyle.color }}</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="chainStyle.width" @input="applyChains" /><span class="u">{{ chainStyle.width.toFixed(1) }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="chainStyle.opacity" @input="applyChains" /><span class="u">{{ chainStyle.opacity.toFixed(2) }}</span></div>
          <div class="srow stack"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="岛链线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: chainStyle.dash === d.k }" @click="chainStyle.dash = d.k; applyChains()">{{ d.label }}</span>
            </span>
          </div>
          <div class="srow"><label></label><span class="lnk" title="本节恢复出厂设置" @click="resetChains">恢复默认</span></div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="geo-crs" :class="{ open: isSecOpen('geo-crs', false) }" @click="toggleSec('geo-crs', false)"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-crs', false) }" :size="12" /><span>坐标系</span><span class="lnk" title="本节恢复出厂设置" @click.stop="resetCrs">默认</span></div>
          <template v-if="isSecOpen('geo-crs', false)">
          <div class="srow"><label>大地基准</label>
            <select :value="mapCrs.datum" title="只作用于读数与输入。CGCS2000 与 WGS-84 的差在厘米量级，低于任何一处显示精度，故不做几何变换、只标口径；GCJ-02 是真实非线性偏移，仅中国境内生效。任何存储、计算与导出都不受影响" @change="setCrsDatum($event.target.value)">
              <option v-for="d in DATUMS" :key="d.k" :value="d.k">{{ byLang(d.zh, d.en) }}</option>
            </select>
          </div>
          <div class="srow"><label>坐标格式</label>
            <select :value="mapCrs.fmt" title="只作用于地图内的坐标读数与输入框；内部照存十进制度" @change="setCrsFmt($event.target.value)">
              <option v-for="f in FORMATS" :key="f.k" :value="f.k">{{ byLang(f.zh, f.en) }}</option>
            </select>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" data-sec="geo-pov" :class="{ open: isSecOpen('geo-pov') }" @click="toggleSec('geo-pov')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('geo-pov') }" :size="12" /><span>地图视角</span></div>
          <template v-if="isSecOpen('geo-pov')">
          <div class="srow"><label>视角</label>
            <select :value="povCfg.id" title="底图的国界、陆地着色、点选与国名全部按该视角的归属表解算；「自定义」以中国视角为底再逐项覆写。台湾、香港、澳门、南海诸岛与钓鱼岛恒属中国，不随视角变" @change="setPovId($event.target.value)">
              <option v-for="p in POV_META" :key="p.id" :value="p.id">{{ byLang(p.zh, p.en) }}</option>
            </select>
          </div>
          <template v-if="povCfg.id === CUSTOM_POV">
            <div class="bsub"><span>争议区归属</span></div>
            <div v-for="g in CUSTOMIZABLE_DISPUTES" :key="g.key" class="srow sub dsp">
              <label :title="(g.full || g.zh) + ' · ' + g.en">{{ g.zh }}</label>
              <select :value="povCfg.overrides[g.key] || ''" :title="(g.full || g.zh) + ' · ' + g.en" @change="setPovDispute(g.key, $event.target.value)">
                <option value="">跟随底图默认</option>
                <option v-for="o in g.opts" :key="o" :value="o">{{ povOwnerZh(o) }}</option>
                <option value="none">不显示</option>
              </select>
            </div>
          </template>
          <div class="bsub"><span>附加线</span></div>
          <div v-for="L in POV_LAYERS" :key="L.k" class="swrow" :class="{ dis: L.k === 'claim' && !povClaimAvail }" :title="L.tip">
            <span>{{ L.zh }}</span>
            <button type="button" class="layersw" :class="{ on: povCfg.layers[L.k] }" role="switch" :aria-checked="povCfg.layers[L.k] ? 'true' : 'false'" :disabled="L.k === 'claim' && !povClaimAvail" @click="togglePovLayer(L.k)"><i></i></button>
          </div>
          </template>
        </div>
        </div>
        </div>

        <!-- 标记：点标记 / 地球站 / 轨迹（每节＝一层，样式整层可调 + 逐条可覆盖） -->
        <div v-show="shellUi.side === 'markers'" class="sview">
        <div class="cov-side mk-side docked">
        <div class="sec" :class="{ hid: !showPtLayer }">
          <div class="sect acc" data-sec="mk-points" :class="{ open: isSecOpen('mk-points') }" @click="toggleSec('mk-points')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mk-points') }" :size="12" /><span>点标记</span><span class="lnk tbl" title="打开点标记批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('points')"><Icon name="table" :size="12" />表格</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetMarkPart('pt')">默认</span><span v-if="points.length" class="lnk" :class="{ on: mkEditId === 'points' }" :title="mkEditId === 'points' ? '完成，退出拖动' : '解锁鼠标拖动：在图上直接拖标记改坐标'" @click.stop="mkEditToggle('points')">{{ mkEditId === 'points' ? '完成调整' : '调整位置' }}</span><button type="button" class="layersw sect-layersw" :class="{ on: showPtLayer }" role="switch" :aria-checked="showPtLayer ? 'true' : 'false'" :title="showPtLayer ? '隐藏点标记（数据保留）' : '显示点标记'" @click.stop="togglePtLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-points')">
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <label class="chk2" title="点标记画成带序号的圈（圈 1、圈 2）；序号即下方列表与点标记表格的行号"><input type="checkbox" v-model="markStyle.ptIdxOn" @change="applyMarkStyle" /><span>显示序号</span></label>
          <template v-if="markStyle.ptIdxOn">
            <div class="srow sub" :title="byLang('序号圈直径（默认视角下的像素）；挂了模型的点标记，模型按同一大小画', 'Badge diameter at the default view; attached models use the same size')"><label>圈大小</label><input class="rng" type="range" min="1" max="40" step="1" v-model.number="markStyle.ptIdx" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptIdx }}</span></div>
            <div class="srow sub"><label>盘颜色</label><input class="clr" type="color" v-model="markStyle.idxFill" @input="applyMarkStyle" /><span class="u">{{ markStyle.idxFill }}</span></div>
            <div class="srow sub"><label>盘透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.02" v-model.number="markStyle.idxFillOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.idxFillOpacity.toFixed(2) }}</span></div>
            <div class="srow sub"><label>圈颜色</label><input class="clr" type="color" v-model="markStyle.idxRing" @input="applyMarkStyle" /><span class="u">{{ markStyle.idxRing }}</span></div>
            <div class="srow sub"><label>数字颜色</label><input class="clr" type="color" v-model="markStyle.idxInk" @input="applyMarkStyle" /><span class="u">{{ markStyle.idxInk }}</span></div>
          </template>
          <template v-else>
            <div class="srow"><label>符号</label>
              <select :value="markStyle.ptShape" @change="setMarkVal('ptShape', $event.target.value)">
                <option v-for="sp in MARK_SHAPES" :key="sp.k" :value="sp.k">{{ byLang(sp.zh, sp.en) }}</option>
              </select>
            </div>
            <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="markStyle.ptColor" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptColor }}</span></div>
            <div class="srow" :title="byLang('符号大小；挂了模型的点标记，模型按同一大小画', 'Symbol size; attached models use the same size')"><label>大小</label><input class="rng" type="range" min="1" max="20" step="0.5" v-model.number="markStyle.ptDot" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptDot }}</span></div>
            <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="markStyle.ptOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptOpacity.toFixed(2) }}</span></div>
            <div class="srow" title="描边宽 ÷ 符号直径，0＝不描边"><label>描边</label><input class="rng" type="range" min="0" max="0.4" step="0.02" v-model.number="markStyle.ptEdge" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptEdge.toFixed(2) }}</span></div>
            <div v-if="markStyle.ptEdge > 0" class="srow"><label>描边颜色</label><input class="clr" type="color" v-model="markStyle.ptEdgeColor" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptEdgeColor }}</span></div>
          </template>
          <label class="chk2"><input type="checkbox" v-model="markStyle.ptNameOn" @change="applyMarkStyle" /><span>显示名称</span></label>
          <label class="chk2"><input type="checkbox" v-model="markStyle.ptLabelOn" @change="applyMarkStyle" /><span>显示坐标</span></label>
          <template v-if="markStyle.ptNameOn || markStyle.ptLabelOn">
            <div class="srow sub"><label>字号</label><input class="rng" type="range" min="1" max="32" step="1" v-model.number="markStyle.ptFont" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptFont }}</span></div>
            <label class="chk2 sub"><input type="checkbox" v-model="markStyle.ptBold" @change="applyMarkStyle" /><span>粗体</span></label>
            <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="markStyle.ptLabelColor" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptLabelColor }}</span></div>
            <div class="srow sub"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="markStyle.ptLabelOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.ptLabelOpacity.toFixed(2) }}</span></div>
            <div class="srow sub"><label>位置</label>
              <span class="seg nseg" role="group" aria-label="坐标标注位置">
                <span v-for="o in LABEL_POS" :key="o.k" class="sg" :class="{ on: markStyle.ptLabelPos === o.k }" @click="setMarkVal('ptLabelPos', o.k)">{{ byLang(o.zh, o.en) }}</span>
              </span>
            </div>
          </template>
          <div class="mlist">
            <div v-for="(p, i) in points" :key="p.id" class="mrow" :class="{ hid: p.show === false }"><button type="button" class="layersw" :class="{ on: p.show !== false }" role="switch" :aria-checked="p.show !== false ? 'true' : 'false'" :title="p.show !== false ? '隐藏该点标记（数据保留）' : '显示该点标记'" @click="toggleMkItem(p)"><i></i></button><span class="mno">{{ i + 1 }}</span><input class="sni" :value="p.name || ''" placeholder="名称" @change="e => setPointName(p.id, e.target.value.trim())" /><span class="mc2">{{ fmtLL(p.lat, p.lon) }}</span><input class="clr mkc" :class="{ ov: !!p.color }" type="color" :value="p.color || markStyle.ptColor" :title="p.color ? '该点自己的颜色（右键清除，回到整层设置）' : '只给这一个点设颜色（右键清除）'" @input="e => setPointColor(p.id, e.target.value)" @contextmenu.prevent="setPointColor(p.id, '')" /><span class="mchip" :class="{ on: !!p.model }" :title="chipTitle(p)" @click.stop="openPickPop($event, 'point', p)" @contextmenu.prevent.stop="setEntityModel('point', p.id, null)"><img v-if="p.model && mdlThumb(p.model.id)" :src="mdlThumb(p.model.id)" alt="" draggable="false" /><Icon v-else :name="chipIcon(p)" :size="12" /></span><span class="del" @click="removePoint(p.id)"><Icon name="x" :size="12" /></span></div>
          </div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !showStLayer }">
          <div class="sect acc" data-sec="mk-stations" :class="{ open: isSecOpen('mk-stations') }" @click="toggleSec('mk-stations')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mk-stations') }" :size="12" /><span>地球站</span><span class="lnk tbl" title="打开地球站批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('stations')"><Icon name="table" :size="12" />表格</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetMarkPart('st')">默认</span><span v-if="stations.length" class="lnk" :class="{ on: mkEditId === 'stations' }" :title="mkEditId === 'stations' ? '完成，退出拖动' : '解锁鼠标拖动：在图上直接拖图标改坐标'" @click.stop="mkEditToggle('stations')">{{ mkEditId === 'stations' ? '完成调整' : '调整位置' }}</span><button type="button" class="layersw sect-layersw" :class="{ on: showStLayer }" role="switch" :aria-checked="showStLayer ? 'true' : 'false'" :title="showStLayer ? '隐藏地球站（数据保留）' : '显示地球站'" @click.stop="toggleStLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-stations')">
          <div class="srow"><label>纬度</label><input class="ci" v-model="stLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="stLon" placeholder="-180 ~ 180" /></div>
          <div class="srow"><label>名称</label><input class="ci" v-model="stName" placeholder="如 北京站" /><span class="addb" @click="addStation">添加</span></div>
          <div class="srow" :title="byLang('地球站图标大小（默认视角下的像素）；挂了模型的站，模型按同一大小画', 'Station icon size at the default view; attached models use the same size')"><label>大小</label><input class="rng" type="range" min="5" max="60" step="1" v-model.number="markStyle.stIcon" @input="applyMarkStyle" /><span class="u">{{ markStyle.stIcon }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="markStyle.stOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.stOpacity.toFixed(2) }}</span></div>
          <label class="chk2"><input type="checkbox" v-model="markStyle.stLabelOn" @change="applyMarkStyle" /><span>显示名称</span></label>
          <template v-if="markStyle.stLabelOn">
            <div class="srow sub"><label>字号</label><input class="rng" type="range" min="1" max="32" step="1" v-model.number="markStyle.stFont" @input="applyMarkStyle" /><span class="u">{{ markStyle.stFont }}</span></div>
            <label class="chk2 sub"><input type="checkbox" v-model="markStyle.stBold" @change="applyMarkStyle" /><span>粗体</span></label>
            <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="markStyle.stLabelColor" @input="applyMarkStyle" /><span class="u">{{ markStyle.stLabelColor }}</span></div>
            <div class="srow sub"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="markStyle.stLabelOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.stLabelOpacity.toFixed(2) }}</span></div>
            <div class="srow sub"><label>位置</label>
              <span class="seg nseg" role="group" aria-label="名称位置">
                <span v-for="o in LABEL_POS" :key="o.k" class="sg" :class="{ on: markStyle.stLabelPos === o.k }" @click="setMarkVal('stLabelPos', o.k)">{{ byLang(o.zh, o.en) }}</span>
              </span>
            </div>
          </template>
          <div class="mlist">
            <template v-for="s in stations" :key="s.id">
              <div class="mrow" :class="{ hid: s.show === false }">
                <button type="button" class="layersw" :class="{ on: s.show !== false }" role="switch" :aria-checked="s.show !== false ? 'true' : 'false'" :title="s.show !== false ? '隐藏该地球站（数据保留）' : '显示该地球站'" @click="toggleMkItem(s)"><i></i></button>
                <input class="sni" :value="s.name" @input="e => setStationName(s.id, e.target.value)" />
                <span class="mc2">{{ fmtLL(s.lat, s.lon) }}</span>
                <span class="mchip" :class="{ on: !!s.model }" :title="chipTitle(s)" @click.stop="openPickPop($event, 'station', s)" @contextmenu.prevent.stop="setEntityModel('station', s.id, null)"><img v-if="s.model && mdlThumb(s.model.id)" :src="mdlThumb(s.model.id)" alt="" draggable="false" /><Icon v-else :name="s.model ? chipIcon(s) : 'box'" :size="12" /></span>
                <span class="del" @click="removeStation(s.id)"><Icon name="x" :size="12" /></span>
              </div>
              <!-- 挂了模型的站：天线跟踪哪颗星（缺省主选星 = 聚焦集里此刻仰角最高的一颗）+ WGS-84 方位 / 仰角读数 -->
              <div v-if="s.model" class="srow sub mtrk">
                <label>跟踪</label>
                <span class="trksel" :class="{ open: trkOpenId === s.id }" title="天线指向的卫星；主选星＝聚焦集里此刻仰角最高的一颗（仰角低于 0° 时停放）" @click="trkToggle(s)"><span class="nm" :data-i18n-skip="s.track && s.track.satKey ? '' : null">{{ trkName(s) }}</span><Icon name="chevron-down" :size="12" /></span>
                <label v-if="s.track && s.track.satKey" class="chk2 trkel" title="站标签的仰角改为对该星的仰角（不勾＝聚焦集最高仰角）"><input type="checkbox" :checked="!!s.track.el" @change="setTrackElOn(s, $event.target.checked)" /><span>仰角</span></label>
                <label v-if="s.track && s.track.satKey" class="chk2 trkel" title="站标签加对该星的方位角（WGS-84，正北起顺时针）"><input type="checkbox" :checked="!!s.track.az" @change="setTrackAzOn(s, $event.target.checked)" /><span>方位角</span></label>
                <StReadTxt :id="s.id" />
              </div>
              <div v-if="s.model && trkOpenId === s.id" class="mtrkpop">
                <input class="ci" v-model="trkQ" placeholder="搜索卫星：卫星名 / NORAD / 星座 / 卫星组" @keydown.esc="trkClose" v-focus />
                <div class="sres lv-sres">
                  <template v-if="!trkQ.trim()">
                    <div class="sres-list">
                      <div class="sitem" :class="{ on: !(s.track && s.track.satKey) }" @click="pickTrack(s, '')"><div class="nm">主选星</div></div>
                      <div v-for="o in trackOpts(s)" :key="o.key" class="sitem" :class="{ on: s.track && s.track.satKey === o.key }" @click="pickTrack(s, o.key)"><div class="nm" :title="o.name" data-i18n-skip>{{ o.name }}</div></div>
                    </div>
                  </template>
                  <div v-else-if="trkBusy" class="sres-e">搜索中…</div>
                  <div v-else-if="!trkCand.length" class="sres-e">没有匹配的卫星。</div>
                  <template v-else>
                    <div class="sres-list">
                      <div v-for="e in trkCand" :key="e.noradId || e.name" class="sitem" @click="trkPickItem(s, e)">
                        <div class="nm" :title="e.name" data-i18n-skip>{{ e.name }}</div>
                        <div class="sub">{{ e.tag }}<template v-if="e.noradId"><template v-if="e.tag"> · </template>NORAD {{ e.noradId }}</template></div>
                      </div>
                    </div>
                    <div class="sres-n">{{ trkTotal > trkCand.length ? ('命中 ' + trkTotal + ' 颗 · 列出前 ' + trkCand.length) : (trkTotal + ' 颗') }}</div>
                  </template>
                </div>
              </div>
            </template>
          </div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !showTrajLayer }">
          <div class="sect acc" data-sec="mk-traj" :class="{ open: isSecOpen('mk-traj') }" @click="toggleSec('mk-traj')"><Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('mk-traj') }" :size="12" /><span>轨迹</span>
            <span class="lnk tbl" title="打开航迹批量表格：逐航迹增删改航点，航点的高度 / 时刻 / 段长 / 航向 / 地速，Excel 批量导入导出" @click.stop="openMkTable('traj')"><Icon name="table" :size="12" />表格</span>
            <span class="lnk" title="本节恢复出厂样式" @click.stop="resetMarkPart('tj')">默认</span>
            <span class="lnk" @click.stop="newTraj('sea')">+航行</span>
            <span class="lnk" @click.stop="newTraj('flight')">+飞行</span>
            <span v-if="trajectories.length" class="lnk" title="发送航迹到小程序：逐条勾选，绑定账号直投或生成一次性密钥" @click.stop="sendTrajsToMiniapp">发送</span>
          <button type="button" class="layersw sect-layersw" :class="{ on: showTrajLayer }" role="switch" :aria-checked="showTrajLayer ? 'true' : 'false'" :title="showTrajLayer ? '隐藏航迹（数据保留）' : '显示航迹'" @click.stop="toggleTrajLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-traj')">
          <div class="bsub"><span>航迹线</span></div>
          <div class="srow sub"><label>航行色</label><input class="clr" type="color" v-model="markStyle.tjSea" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjSea }}</span></div>
          <div class="srow sub"><label>飞行色</label><input class="clr" type="color" v-model="markStyle.tjFlight" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjFlight }}</span></div>
          <div class="srow sub"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="markStyle.tjWidth" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjWidth.toFixed(1) }}</span></div>
          <div class="srow sub"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="markStyle.tjOpacity" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjOpacity.toFixed(2) }}</span></div>
          <div class="srow sub"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="航迹线线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: markStyle.tjDash === d.k }" @click="setMarkVal('tjDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          <label class="chk2" title="飞行航迹在 3D 球面上按实际高度画；勾上后航迹线与地面之间加一道半透明垂幕"><input type="checkbox" v-model="markStyle.tjCurtain" @change="applyMarkStyle" /><span>延伸到地面</span></label>
          <div class="bsub"><span>航点圆点</span></div>
          <div class="srow sub" title="0＝不画航点圆点"><label>大小</label><input class="rng" type="range" min="0" max="60" step="1" v-model.number="markStyle.tjDot" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjDot }}</span></div>
          <template v-if="markStyle.tjDot > 0">
            <div class="srow sub"><label>航行色</label><input class="clr" type="color" v-model="markStyle.tjDotSea" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjDotSea }}</span></div>
            <div class="srow sub"><label>飞行色</label><input class="clr" type="color" v-model="markStyle.tjDotFlight" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjDotFlight }}</span></div>
          </template>
          <label class="chk2" title="航迹头（末航点）上画一枚俯视矢量图标：航行＝船舶、飞行＝飞机，朝向取末段走向"><input type="checkbox" v-model="markStyle.tjIconOn" @change="applyMarkStyle" /><span>显示图标</span></label>
          <template v-if="markStyle.tjIconOn">
            <div class="srow sub" :title="byLang('载具图标大小（默认视角下的像素）；挂了模型的航迹，模型按同一大小画', 'Vehicle icon size at the default view; attached models use the same size')"><label>大小</label><input class="rng" type="range" min="1" max="60" step="1" v-model.number="markStyle.tjIconPx" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjIconPx }}</span></div>
            <div class="srow sub"><label>航行色</label><input class="clr" type="color" v-model="markStyle.tjIconSea" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjIconSea }}</span></div>
            <div class="srow sub"><label>飞行色</label><input class="clr" type="color" v-model="markStyle.tjIconFlight" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjIconFlight }}</span></div>
          </template>
          <label class="chk2" title="在航迹头旁标出航迹名"><input type="checkbox" v-model="markStyle.tjNameOn" @change="applyMarkStyle" /><span>显示航迹名</span></label>
          <template v-if="markStyle.tjNameOn">
            <div class="srow sub"><label>字号</label><input class="rng" type="range" min="1" max="32" step="1" v-model.number="markStyle.tjNameFont" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjNameFont }}</span></div>
            <label class="chk2 sub"><input type="checkbox" v-model="markStyle.tjNameBold" @change="applyMarkStyle" /><span>粗体</span></label>
            <div class="srow sub"><label>颜色</label><input class="clr" type="color" v-model="markStyle.tjNameColor" @input="applyMarkStyle" /><span class="u">{{ markStyle.tjNameColor }}</span></div>
          </template>
          <div v-for="t in trajectories" :key="t.id" class="tcard" :class="{ act: activeTraj === t.id, hid: t.show === false }">
            <div class="trow">
              <button type="button" class="layersw" :class="{ on: t.show !== false }" role="switch" :aria-checked="t.show !== false ? 'true' : 'false'" :title="t.show !== false ? '隐藏该航迹（数据保留）' : '显示该航迹'" @click="toggleMkItem(t)"><i></i></button>
              <span class="tk" :class="t.kind" :style="t.color ? { background: t.color } : null"></span>
              <input class="tni" :value="t.name" @input="e => setTrajName(t.id, e.target.value)" />
              <input class="clr mkc" :class="{ ov: !!t.color }" type="color" :value="t.color || (t.kind === 'flight' ? markStyle.tjFlight : markStyle.tjSea)" :title="t.color ? '这条航迹自己的颜色（右键清除，回到整层设置）' : '只给这一条航迹设颜色（右键清除）'" @input="e => setTrajColor(t.id, e.target.value)" @contextmenu.prevent="setTrajColor(t.id, '')" />
              <span class="mchip" :class="{ on: !!t.model }" :title="chipTitle(t)" @click.stop="openPickPop($event, 'traj', t)" @contextmenu.prevent.stop="setEntityModel('traj', t.id, null)"><img v-if="t.model && mdlThumb(t.model.id)" :src="mdlThumb(t.model.id)" alt="" draggable="false" /><Icon v-else :name="t.model ? chipIcon(t) : 'box'" :size="12" /></span>
              <span class="tsel" :class="{ on: activeTraj === t.id }" @click="editTraj(t)">{{ activeTraj === t.id ? '编辑中' : '编辑' }}</span>
              <span v-if="t.pts.length" class="tsel" :class="{ on: mkEditId === t.id }" :title="mkEditId === t.id ? '完成，退出拖动' : '解锁鼠标拖动：在图上直接拖航点改坐标'" @click="mkEditToggle(t.id)">{{ mkEditId === t.id ? '完成' : '调点' }}</span>
              <span class="del" @click="removeTraj(t.id)"><Icon name="x" :size="12" /></span>
            </div>
            <!-- 运动：有起始时刻 + 速度 = 载具随时钟沿大圆走（飞行按巡航高度剖面）；没给 = 钉在航迹头 -->
            <div class="tmot" :class="{ open: motOpen.has(t.id) }">
              <div class="tmh" :title="motOpen.has(t.id) ? '收起' : '运动：巡航高度 / 速度 / 起始时刻'" @click="toggleMot(t.id)"><Icon name="chevron-down" class="disc" :class="{ shut: !motOpen.has(t.id) }" :size="12" /><span class="tms" :class="{ on: vehOn.has(t.id) }">{{ motSummary(t) }}</span></div>
              <template v-if="motOpen.has(t.id)">
                <div v-if="t.kind === 'flight'" class="srow sub"><label>巡航高度</label><NumIn :model-value="Number.isFinite(t.cruiseAltM) ? t.cruiseAltM : null" allow-empty :min="0" :max="30000" :placeholder="String(CRUISE_ALT_M_DEFAULT)" title="飞行剖面的平飞高度；留空 = 10668 m（FL350）" @commit="(v) => setTrajMotion(t.id, { cruiseAltM: v })" /><span class="u">m</span></div>
                <div class="srow sub"><label>速度</label><NumIn :model-value="Number.isFinite(t.speedKmh) ? t.speedKmh : null" allow-empty :min="1" :max="5000" title="地速（WGS-84 测地线里程）；与起始时刻都给了载具才随时钟移动" @commit="(v) => setTrajMotion(t.id, { speedKmh: v })" /><span class="u">km/h</span></div>
                <div class="srow sub"><label>起始</label><input class="ci t0i" type="text" spellcheck="false" autocomplete="off" placeholder="YYYY-MM-DD HH:mm:ss" title="载具离开首航点的时刻（按显示时区；可带 Z 或 ±hh:mm）" :value="t0Edit.id === t.id ? t0Edit.text : fmtT0(t.t0Ms)" @focus="t0Begin(t)" @input="t0Input(t, $event.target.value)" @blur="t0Commit(t)" @keydown.enter.prevent="t0Enter($event, t)" @keydown.esc.prevent="t0Esc($event)" /><span class="lnk" title="设为当前仿真时刻" @click="setTrajMotion(t.id, { t0Ms: clock.tMs })">此刻</span></div>
                <div v-if="vehOn.has(t.id)" class="srow sub tmr"><span class="rdv" :title="t.kind === 'flight' ? '高度 · 已飞 / 全程' : '已航行 / 全程'"><VehReadTxt :t="t" /></span></div>
              </template>
            </div>
            <div class="twp">
              <span v-for="(p, i) in t.pts" :key="i" class="wp">{{ p.lat == null ? '—' : p.lat.toFixed(1) }},{{ p.lon == null ? '—' : p.lon.toFixed(1) }}<span class="wdel" @click="removeWaypoint(t, i)"><Icon name="x" :size="12" /></span></span>
              <span v-if="!t.pts.length" class="empty">无航点</span>
            </div>
          </div>
          <div v-if="activeTraj" class="srow">
            <label>航点</label>
            <input class="ci nrw" v-model="wpLat" placeholder="纬" />
            <input class="ci nrw" v-model="wpLon" placeholder="经" />
            <span class="addb" @click="addWaypoint">加点</span>
          </div>
          <div v-if="!trajectories.length" class="tip">暂无轨迹。</div>
          </template>
        </div>

        <div class="csfoot"><span class="cclr" @click="clearAllMarkers">清空全部</span></div>
        </div>
        </div>
      </Teleport>

      <!-- 右侧「卫星信息栏」：地图右侧、时间轴之上（时间轴仍通栏）。显隐只听 shellUi.satInfo，选中只换内容，地图视口不跳。
           放在侧栏 Teleport 区间之外、不打 data-sec、不写 shellUi.side === 形态（标题栏搜索索引的规则）；
           栏及其祖先禁 transform / filter / contain / container-type / will-change（「＋」菜单与右键菜单是 position:fixed） -->
      <div v-show="shellUi.satInfo" class="rdk-split" :class="{ on: rdkDrag }" title="拖动调整宽度（双击恢复）" @mousedown.prevent="rdkSplitDown" @dblclick="rdkSplitReset"></div>
      <aside
        v-show="shellUi.satInfo" ref="rdkEl" class="rdk" :class="{ narrow: rdkNarrow }" data-rdk="panel"
        :style="{ '--rdk-w': shellUi.satInfoW + 'px' }"
        @dragenter="impDragEnter" @dragover="impDragOverH" @dragleave="impDragLeave" @drop="onImpDrop"
      >
        <div class="rdk-hd">
          <span class="rdk-tt">卫星信息</span>
          <span v-if="flatView" class="rdk-ib dis" data-rdk="follow" title="跟随卫星（仅 3D 球体）"><Icon name="locate-fixed" :size="12" /></span>
          <span v-else-if="following" class="rdk-ib on" data-rdk="follow" title="退出跟随（Esc）" @click="toggleFollow"><Icon name="locate-fixed" :size="12" /></span>
          <span v-else class="rdk-ib" :class="{ dis: !selected }" data-rdk="follow" title="跟随卫星" @click="selected && toggleFollow()"><Icon name="locate-fixed" :size="12" /></span>
          <span class="rdk-ib" title="显示设置：轨道线 / 星下点轨迹 / 覆盖圈 / 卫星标记" @click="openFocusSettings"><Icon name="sliders-horizontal" :size="12" /></span>
          <span class="rdk-vr"></span>
          <span class="rdk-ib" title="收起信息栏（Ctrl+Alt+B）" @click="shellUi.satInfo = false"><Icon name="x" :size="12" /></span>
        </div>

        <div v-if="!selected" class="rdk-bd"><div class="rdk-empty">未聚焦卫星。</div></div>
        <template v-else-if="shellUi.satInfo">
          <!-- 钉住区：聚焦集（≥2 颗）+ 对象身份 —— 不随滚动，「取消聚焦 / 全部取消」恒在同一处 -->
          <div class="rdk-top">
            <div v-if="selList.length > 1" class="rdk-set" :class="{ shut: !isSecOpen('rdk-sel') }">
              <div class="rdk-sh" @click="rdkSec('rdk-sel', $event)">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('rdk-sel') }" :size="12" />
                <span class="rdk-st"><b>{{ selList.length }}</b><span>颗聚焦</span></span>
                <span class="rdk-sa"><span class="rdk-btn" data-rdk="unfocus" title="清空聚焦集" @click.stop="rdkClear">全部取消</span></span>
              </div>
              <div v-if="isSecOpen('rdk-sel')" ref="rdkListEl" class="rdk-list" tabindex="0" @keydown="rdkListKey">
                <div class="rdk-lr rdk-lh"><span class="no">#</span><span class="nm">卫星</span><span class="kd">区制</span><span class="al">高度<i>km</i></span><span></span></div>
                <div v-for="(s, i) in selList" :key="s.idx" class="rdk-lr" :class="{ pri: s.active }" data-rdk="sel-row" :title="rdkRowTitle(s)" @click="setPrimary(s)">
                  <span class="no">{{ i + 1 }}</span>
                  <span class="nm" data-i18n-skip><span class="h">{{ rdkName(s.name)[0] }}</span><span v-if="rdkName(s.name)[1]" class="t">{{ rdkName(s.name)[1] }}</span></span>
                  <span class="kd">{{ s.kind }}</span>
                  <span class="al">{{ s.alt }}</span>
                  <span class="x" title="移出该星" @click.stop="removeSel(s)"><Icon name="x" :size="12" /></span>
                </div>
              </div>
            </div>
            <div class="rdk-id">
              <div class="rdk-nr">
                <span v-if="selList.length > 1" class="rdk-no">#{{ rdkPriNo }}</span>
                <span class="rdk-nm" data-i18n-skip>{{ selected.name }}</span>
                <span v-if="selList.length <= 1" class="rdk-btn" data-rdk="unfocus" title="取消聚焦" @click="rdkClear">取消聚焦</span>
              </div>
              <div class="rdk-meta">
                <span v-if="selected.noradId" class="rdk-bdg cp" :class="{ ok: rdkCopied }" :title="rdkCopied ? '已复制' : '点击复制 NORAD 编号'" @click="rdkCopyNorad"><b>NORAD</b>{{ selected.noradId }}</span>
                <span v-if="selected.kind" class="rdk-bdg kind" title="轨道区制">{{ selected.kind }}</span>
                <!-- skip 挂在内层：挂外层会连 title 一起跳过翻译（运行时跳过 skip 元素自身的属性） -->
                <span v-if="selected.group && selected.group !== selected.kind" class="rdk-bdg" title="所属卫星组"><span :data-i18n-skip="rdkGroupLit ? null : ''">{{ selected.group }}</span></span>
                <span v-if="selected.slot" class="rdk-bdg geo"><b>定点</b>{{ selected.slot }}</span>
              </div>
            </div>
          </div>

          <!-- 滚动体：各节节头吸顶；折叠态存 panelSections（rdk-* 键），不打 data-sec -->
          <div class="rdk-bd">
            <section class="rdk-sec">
              <div class="rdk-sh" @click="rdkSec('rdk-live', $event)">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('rdk-live') }" :size="12" />
                <span class="rdk-st">实时状态</span>
                <span class="rdk-ts" title="读数对应的仿真时刻">{{ rdkNowStr }}</span>
              </div>
              <div v-if="isSecOpen('rdk-live')" class="rdk-kv">
                <div class="rdk-r" title="星下点纬度（WGS-84 大地纬度）"><span class="rdk-k">纬度</span><span class="rdk-s">φ</span><span class="rdk-v">{{ rdkAbs(selected.lat) }}</span><span class="rdk-u">{{ rdkNS(selected.lat) }}</span></div>
                <div class="rdk-r" title="星下点经度"><span class="rdk-k">经度</span><span class="rdk-s">λ</span><span class="rdk-v">{{ rdkAbs(selected.lon) }}</span><span class="rdk-u">{{ rdkEW(selected.lon) }}</span></div>
                <div class="rdk-r"><span class="rdk-k">轨道高度</span><span class="rdk-s">h</span><span class="rdk-v">{{ selected.alt }}</span><span class="rdk-u">km</span></div>
                <div class="rdk-r"><span class="rdk-k">对地速度</span><span class="rdk-s"></span><span class="rdk-v">{{ selected.speedRel }}</span><span class="rdk-u">km/s</span></div>
                <div class="rdk-r"><span class="rdk-k">惯性速度</span><span class="rdk-s"></span><span class="rdk-v">{{ selected.speedAbs }}</span><span class="rdk-u">km/s</span></div>
                <div v-if="focusStyle.trkOn && trkSpan" class="rdk-r" title="从当前时刻起画的轨迹圈数与时长"><span class="rdk-k">轨迹周期</span><span class="rdk-s"></span><span class="rdk-v">{{ trkSpan.rev }}<i>圈</i>·<span class="rdk-v2">{{ trkSpan.v }}</span></span><span class="rdk-u">{{ trkSpan.u }}</span></div>
              </div>
            </section>

            <section v-if="selected.hasEl" class="rdk-sec">
              <div class="rdk-sh" @click="rdkSec('rdk-el', $event)">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('rdk-el') }" :size="12" />
                <span class="rdk-st">轨道根数（开普勒）</span>
              </div>
              <div v-if="isSecOpen('rdk-el')" class="rdk-kv">
                <div v-if="selected.aKm" class="rdk-r"><span class="rdk-k">半长轴</span><span class="rdk-s">a</span><span class="rdk-v">{{ selected.aKm }}</span><span class="rdk-u">km</span></div>
                <div v-if="selected.ecc" class="rdk-r"><span class="rdk-k">偏心率</span><span class="rdk-s">e</span><span class="rdk-v">{{ selected.ecc }}</span><span class="rdk-u"></span></div>
                <div v-if="selected.incl" class="rdk-r"><span class="rdk-k">轨道倾角</span><span class="rdk-s">i</span><span class="rdk-v">{{ selected.incl }}</span><span class="rdk-u">°</span></div>
                <div v-if="selected.raan" class="rdk-r"><span class="rdk-k">升交点赤经</span><span class="rdk-s">Ω</span><span class="rdk-v">{{ selected.raan }}</span><span class="rdk-u">°</span></div>
                <div v-if="selected.argp" class="rdk-r"><span class="rdk-k">近地点幅角</span><span class="rdk-s">ω</span><span class="rdk-v">{{ selected.argp }}</span><span class="rdk-u">°</span></div>
                <div v-if="selected.ma" class="rdk-r"><span class="rdk-k">平近点角</span><span class="rdk-s">M</span><span class="rdk-v">{{ selected.ma }}</span><span class="rdk-u">°</span></div>
                <div v-if="rdkG1(selected) && rdkG2(selected)" class="rdk-hr"></div>
                <div v-if="selected.meanMotion" class="rdk-r"><span class="rdk-k">平均运动</span><span class="rdk-s">n</span><span class="rdk-v">{{ selected.meanMotion }}</span><span class="rdk-u">圈/日</span></div>
                <div v-if="selected.period" class="rdk-r"><span class="rdk-k">轨道周期</span><span class="rdk-s">T</span><span class="rdk-v">{{ selected.period }}</span><span class="rdk-u">min</span></div>
                <div v-if="selected.perigee" class="rdk-r"><span class="rdk-k">近地点高度</span><span class="rdk-s"></span><span class="rdk-v">{{ selected.perigee }}</span><span class="rdk-u">km</span></div>
                <div v-if="selected.apogee" class="rdk-r"><span class="rdk-k">远地点高度</span><span class="rdk-s"></span><span class="rdk-v">{{ selected.apogee }}</span><span class="rdk-u">km</span></div>
                <template v-if="rdkEp">
                  <div v-if="rdkG1(selected) || rdkG2(selected)" class="rdk-hr"></div>
                  <div class="rdk-r" title="星历历元（TLE / OMM 平根数的参考时刻）"><span class="rdk-k">历元<i class="tz" data-i18n-skip>{{ rdkEp.tz }}</i></span><span class="rdk-v dt" data-i18n-skip><span>{{ rdkEp.d }}</span> <span>{{ rdkEp.t }}</span></span></div>
                  <div v-if="selected.epochAgeD" class="rdk-r" title="当前时刻 − 历元"><span class="rdk-k">历元龄</span><span class="rdk-s"></span><span class="rdk-v">{{ selected.epochAgeD }}</span><span class="rdk-u">d</span></div>
                </template>
              </div>
            </section>

            <!-- 天线：主选星（按 NORAD）关联的全部树节点下的天线。勾选＝对地覆盖显示；点名＝到覆盖视图编辑；读数＝峰值增益 -->
            <section v-if="grdApiOk && selPrimNorad" class="rdk-sec">
              <div class="rdk-sh" @click="rdkSec('rdk-ant', $event)">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('rdk-ant') }" :size="12" />
                <span class="rdk-st">天线</span>
                <span class="rdk-sa"><span class="rdk-ib" title="为该星新建天线" @click.stop="rdkAntAdd"><Icon name="plus" :size="12" /></span></span>
              </div>
              <template v-if="isSecOpen('rdk-ant')">
                <div v-if="!cardAntRows.length" class="rdk-none">暂无天线。</div>
                <div v-else class="rdk-ants">
                  <div v-for="r in cardAntRows" :key="r.key" class="rdk-ar" :class="{ foc: grd.isActive(r.sat.folder, r.a.name) }">
                    <label class="rdk-ck" title="在地图上显示该天线覆盖范围" @mousedown.prevent><input type="checkbox" class="gck" :checked="grd.isSelected(r.sat.folder, r.a.name)" @click.stop @change="grd.toggleAnt(r.sat, r.a)" /></label>
                    <span class="rdk-an" :title="r.satName ? r.satName + ' · ' + r.a.name : r.a.name" @click="cardEditAnt(r)"><span data-i18n-skip>{{ r.a.name }}</span><em v-if="r.satName" data-i18n-skip>{{ r.satName }}</em></span>
                    <span class="rdk-v">{{ fmtPeakDb(r.a.peakDb) }}</span><span class="rdk-u">dBi</span>
                  </div>
                </div>
              </template>
            </section>

            <!-- 模型：名称 + 核定标记（悬停说明）+ 包围盒 / 质量读数；编辑… 跳到「卫星模型」侧栏（不直接开工作台） -->
            <section v-if="selModel" class="rdk-sec" data-rdk="model">
              <div class="rdk-sh" @click="rdkSec('rdk-mdl', $event)">
                <Icon name="chevron-down" class="disc" :class="{ shut: !isSecOpen('rdk-mdl') }" :size="12" />
                <span class="rdk-st">模型</span>
                <template v-if="selModel.id">
                  <span class="rdk-ok" :class="{ ok: selModel.sizeVerified }" :title="selModel.sizeVerified ? '尺寸已核定（有出处）' : '尺寸未核定'"><Icon name="ruler" :size="12" /></span>
                  <span class="rdk-ok" :class="{ ok: selModel.frameVerified }" :title="selModel.frameVerified ? '本体轴已核定' : '本体轴未核定'"><Icon name="axis-3d" :size="12" /></span>
                </template>
                <span class="rdk-sa"><span class="rdk-lnk" title="在卫星模型中编辑" @click.stop="rdkModelEdit">编辑…</span></span>
              </div>
              <div v-if="isSecOpen('rdk-mdl')" class="rdk-kv nosym">
                <div class="rdk-r"><span class="rdk-k">名称</span><span v-if="selModel.id" class="rdk-v txt" data-rdk="model-name" :title="selModel.title || selModel.name" data-i18n-skip>{{ selModel.name }}</span><span v-else class="rdk-v txt" data-rdk="model-name">无</span></div>
                <div v-if="selModel.dims" class="rdk-r" title="包围盒（本体系 X × Y × Z）"><span class="rdk-k">尺寸</span><span class="rdk-s"></span><span class="rdk-v"><template v-for="(d, k) in selModel.dims.split(' × ')" :key="k"><i v-if="k">×</i>{{ d }}</template></span><span class="rdk-u">m</span></div>
                <div v-if="selModel.mass" class="rdk-r"><span class="rdk-k">质量</span><span class="rdk-s"></span><span class="rdk-v">{{ selModel.mass }}</span><span class="rdk-u">kg</span></div>
              </div>
            </section>
          </div>
        </template>
      </aside>
    </div>

    <!-- 时间控制条：地图时间轴 + 实时徽标 + 覆盖圈定义（归属地图，置于地图正下方） -->
    <!-- 交互范式（YouTube LIVE / Cesium SYSTEM_CLOCK）：实时中时间轴与步进照常可用，操作即静默退出实时；徽标一键回实时 -->
    <div class="tl bottom">
      <!-- 两层：.tl-ruler 尺子通栏 / .tl-row 控件三组（左 实时·跨度｜中 读数·走带 真居中｜右 步长·倍速）；.tl 自己是 container query 的容器，所以间距写在子层上 -->
      <div class="tl-ruler">
        <div class="tb-track" :class="{ kbf: trackKb }" :style="trackStyle" ref="track" tabindex="0" role="slider" aria-label="仿真时间游标"
             :aria-valuemin="Math.round(winStartMin)" :aria-valuemax="Math.round(winEndMin)" :aria-valuenow="Math.round(offMin)" :aria-valuetext="timeParts.a"
             @pointerdown="trackDown" @wheel.prevent="onWheel" @keydown="onTrackKey" @pointermove="onHover" @pointerleave="onLeave"
             @focus="onTrackFocus" @blur="onTrackBlur">
          <!-- 刻度层：ruler 按签名记忆，同签名返回同一对象 → v-memo 整段跳过 diff（暂停时一拍都不重渲） -->
          <div class="tb-scale" v-memo="[ruler, tipHideKey]">
            <div class="tb-base"></div>
            <div v-for="(x, i) in ruler.tinies" :key="'y' + i" class="tb-t tiny" :style="{ left: x + 'px' }"></div>
            <div v-for="(x, i) in ruler.mids" :key="'n' + i" class="tb-t min" :style="{ left: x + 'px' }"></div>
            <div v-for="(x, i) in ruler.majors" :key="'j' + i" class="tb-t maj" :style="{ left: x + 'px' }"></div>
            <div v-for="(p, i) in ruler.poles" :key="'p' + i" class="tb-t pole" :class="{ day: p.day }" :style="{ left: p.x + 'px' }"></div>
            <div v-for="(l, i) in ruler.labels" :key="'l' + i" class="tb-lab" :class="{ day: l.day, ko: tipHide.has(String(i)) }" :style="l.st" data-i18n-skip>{{ l.label }}</div>
          </div>
          <div v-if="showSpan" class="tb-span"></div>
          <div v-if="nowInWin" class="tb-now" :class="{ flip: ruler.tag === 'l' }"><span v-if="ruler.tag" class="tag" :class="{ ko: tipHide.has('t') }">此刻</span></div>
          <div v-show="hoverShow && !scrubbing" class="tb-ghost" :style="{ left: hoverX + 'px' }"></div>
          <div class="tb-ph" :class="{ lv: live, grab: scrubbing, tipov: tipOverHd }"><span class="hd"></span></div>
          <div v-show="hoverShow && !scrubbing" class="tb-tipko" :style="{ left: tipLeft + 'px' }" aria-hidden="true" data-i18n-skip>{{ hoverLabel }}</div>
          <div v-show="hoverShow && !scrubbing" class="tb-tip" :style="{ left: tipLeft + 'px' }" data-i18n-skip>{{ hoverLabel }}</div>
        </div>
      </div>
      <div class="tl-row">
        <div class="tl-grp l">
          <button type="button" class="live-btn" :class="{ on: live }" :aria-pressed="live ? 'true' : 'false'" :title="live ? '实时中（跟随系统时间）· 点击停在当前时刻' : '回到实时（跟随系统时间）'" @click="toggleLive"><span class="ldot"></span>实时</button>
          <!-- 跨度：与右侧「步长 / 倍速」同一种带栏名的旋钮。下拉宽度恒定（滚轮挂上的自定义档也不撑宽），六档装在一格里。 -->
          <span class="clkg wspan" role="group" aria-label="时间窗跨度">
            <span class="ckl">跨度</span>
            <select class="cksel wsel" v-memo="[windowMin]" :value="windowMin" title="可见时间窗跨度（可回看过去 · 滚轮缩放）" @change="setWindow(Number($event.target.value))">
              <option v-for="w in WINDOW_PRESETS" :key="w.v" :value="w.v">{{ w.l }}</option>
              <option v-if="isCustomWindow" :value="windowMin">{{ customWinLabel }}</option>
            </select>
          </span>
        </div>
        <div class="tl-grp c">
          <!-- 读数块即按钮：点开的面板头上是「跳到指定时刻」（输入框 + 跳转），下面是时区档位。
               gap=3：读数块顶边恰在标尺基线下 4px，按默认 4px 空隙开出来面板底边正落在基线 / 偏移色带上，叠成灰 + 蓝两道边；
               3px 让面板压住基线与色带，底边只剩一道灰边，面板外与基线接齐 -->
          <TzPicker ref="roEl" class="tlab2 tzsw" :class="{ scrub: scrubbing }" :style="roStyle" :model-value="tzMode" :ms="tzRefMs" align="right" :gap="3"
                    tabindex="0" role="button" aria-haspopup="dialog" :aria-expanded="roOpen ? 'true' : 'false'"
                    title="跳到指定时刻 / 时刻显示时区（本机 / UTC / UTC±N；只改显示，星位与过境一律按 UTC 计算）"
                    @update:model-value="setTzMode" @open="onRoOpen" @close="roOpen = false"
                    @keydown.enter.prevent="$event.currentTarget.click()" @keydown.space.prevent="$event.currentTarget.click()"><span class="t1" data-i18n-skip>{{ timeParts.m }}</span><span class="t2"><span class="d" data-i18n-skip>{{ timeParts.d }}</span><span class="o" :class="{ lv: live }">{{ timeParts.o }}</span><span class="z" data-i18n-skip>{{ timeParts.z }}</span></span>
            <template #head><span class="rogo"><input ref="gotoInp" class="ci" type="datetime-local" step="1" v-model="gotoVal" @input="noteGoto($event.target.value)" @keydown.enter="applyGoto" /><button type="button" class="btn" @click="applyGoto">跳转</button></span></template>
          </TzPicker>
          <!-- 仿真时钟走带：反向连播 / 步退 / 播放·暂停 / 步进 ｜ 回到此刻 -->
          <span class="stg" role="group" aria-label="仿真时钟">
            <button type="button" class="st tic" :class="{ act: revPlaying }" :aria-pressed="revPlaying ? 'true' : 'false'" :title="revPlaying ? '暂停' : '反向播放'" @click="togglePlay(-1)"><Icon name="rewind" :size="12" /></button>
            <button type="button" class="st tic" title="后退一个步长" @click="clockStepBy(-1)"><Icon name="step-back" :size="12" /></button>
            <button type="button" class="st tic play" :class="{ act: fwdPlaying }" :aria-pressed="fwdPlaying ? 'true' : 'false'" :title="fwdPlaying ? '暂停' : '播放（空格）'" @click="togglePlay(1)"><Icon :name="fwdPlaying ? 'pause' : 'play'" :size="12" /></button>
            <button type="button" class="st tic" title="前进一个步长" @click="clockStepBy(1)"><Icon name="step-forward" :size="12" /></button>
            <button type="button" class="st now" :class="{ dis: !live && atNow }" :disabled="!live && atNow" title="回到当前时刻" @click="resetTime">此刻</button>
          </span>
        </div>
        <div class="tl-grp r">
          <!-- 步长 + 倍速。两个旋钮各带栏名 —— 光一个「1s」和一个「×10」摆在那里看不出是什么。 -->
          <span class="clkg" role="group" aria-label="仿真步长与倍速">
            <span class="ckl">步长</span>
            <select class="cksel ssel" v-memo="[clock.stepSec]" :value="clock.stepSec" title="每拍推进的仿真时间" @change="setStepSec(Number($event.target.value))">
              <option v-for="s in STEP_PRESETS" :key="s" :value="s">{{ fmtStepShort(s) }}</option>
              <option v-if="!STEP_PRESETS.includes(clock.stepSec)" :value="clock.stepSec">{{ fmtStepShort(clock.stepSec) }}</option>
            </select>
            <span class="ckl">倍速</span>
            <select class="cksel xsel" v-memo="[clock.speed, speedTitle]" :value="clock.speed" :title="speedTitle" @change="setSpeedVal(Number($event.target.value))">
              <option v-for="x in SPEED_PRESETS" :key="x" :value="x">×{{ fmtRate(x) }}</option>
              <option v-if="!SPEED_PRESETS.includes(clock.speed)" :value="clock.speed">{{ speedText }}</option>
            </select>
          </span>
        </div>
      </div>
    </div>

    <!-- 卫星编辑弹窗（单独对话框）；点选模式下折叠为顶部横幅，便于点击地图上的卫星 -->
    <!-- hideViz（从文件管理器调起）：浮到文件管理器之上与之共存（提升 z-index 并改 fixed 定位） -->
    <!-- 非 hideViz＝对着地图编辑：挂 sat-live 靠边停，改一处落一处的效果得看得见（见 applySatLive） -->
    <div v-if="satModal && !satPick" class="sat-mask" :class="{ 'sat-overlay': satModal.hideViz, 'sat-live': !satModal.hideViz }">
      <div class="sat-dlg">
        <div class="sdh sdh-win"><span class="sdt">{{ satModal.folder ? '编辑卫星' : '添加卫星' }}</span><button class="winx" type="button" aria-label="关闭" title="关闭" @click="closeSatModal"><Icon name="x" :size="12" /></button></div>
        <div class="sdbody">
          <div class="sdiv">卫星（图标 / 卫星名）</div>
          <div class="srow"><label>名称</label><input class="ci" v-model="satModal.name" placeholder="卫星名称" @change="applySatLive" @keyup.enter="applySatLive" /></div>
          <div v-if="!satModal.noradId" class="srow"><label>定位方式</label>
            <span class="pmode" :class="{ on: satModal.posMode !== 'orbit' }" @click="satModal.posMode = 'fixed'; applySatLive()">固定经纬度</span>
            <span class="pmode" :class="{ on: satModal.posMode === 'orbit' }" @click="satModal.posMode = 'orbit'; applySatLive()">轨道根数</span>
          </div>
          <template v-if="satModal.posMode !== 'orbit' || satModal.noradId">
            <div class="srow"><label>经度</label><input class="ci" type="number" step="0.1" :value="satPosVal('lon')" @input="satPosInput('lon', $event)" @change="satPosDone" @blur="satPosDone" @keyup.enter="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">°E</span></div>
            <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.1" :value="satPosVal('lat')" @input="satPosInput('lat', $event)" @change="satPosDone" @blur="satPosDone" @keyup.enter="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">°N</span></div>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="100" :value="satPosVal('altKm')" @input="satPosInput('altKm', $event)" @change="satPosDone" @blur="satPosDone" @keyup.enter="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">km</span><span v-if="!satModal.noradId" class="geobtn" title="设为标准 GEO 轨道高度 35786km（NASA 标称值）" @click="applyGeoAlt">一键GEO</span></div>
          </template>
          <template v-else>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="50" v-model.number="satModal.elements.altKm" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">km</span></div>
            <div class="srow"><label>偏心率</label><input class="ci" type="number" step="0.001" min="0" max="0.999" v-model.number="satModal.elements.ecc" @change="applySatLive" @keyup.enter="applySatLive" /></div>
            <div class="srow"><label>倾角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.incl" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
            <div class="srow"><label>升交点赤经</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.raan" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
            <div class="srow"><label>近地点幅角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.argp" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
            <div class="srow"><label>平近点角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.ma" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
          </template>
          <template v-if="!satModal.hideViz">
            <label class="chk2"><input type="checkbox" v-model="satModal.iconShow" @change="applySatLive" /><span>显示图标</span></label>
            <div v-if="satModal.iconShow !== false" class="srow"><label>图标大小</label><input class="rng" type="range" min="1" max="64" step="1" v-model.number="satModal.iconSize" @input="applySatLive" /><span class="u">{{ satModal.iconSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="satModal.labelShow" @change="applySatLive" /><span>显示卫星名</span></label>
            <div v-if="satModal.labelShow !== false" class="srow"><label>卫星名字号</label><input class="rng" type="range" min="1" max="30" step="1" v-model.number="satModal.labelSize" @input="applySatLive" /><span class="u">{{ satModal.labelSize }}</span></div>
            <label v-if="satModal.labelShow !== false" class="chk2"><input type="checkbox" v-model="satModal.labelBold" @change="applySatLive" /><span>卫星名粗体</span></label>

            <div class="sdiv">仰角线（等仰角环 / 角度标注）</div>
            <div class="srow"><label>仰角值</label><input class="ci" v-model="satModal.els" placeholder="如 5,10,20（0=地平）" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
            <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="satModal.elevWidth" @input="applySatLive" /><span class="u">{{ (satModal.elevWidth || 1.3).toFixed(1) }}</span></div>
            <div class="srow"><label>标注字号</label><input class="rng" type="range" min="1" max="35" step="1" v-model.number="satModal.elevLabelSize" @input="applySatLive" /><span class="u">{{ satModal.elevLabelSize || 18 }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="satModal.elevLabelBold" @change="applySatLive" /><span>标注粗体</span></label>

            <div class="sdiv">颜色（仰角线与卫星名共用）</div>
            <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="satModal.color" @input="applySatLive" /></div>
          </template>

          <div class="sdiv">从星座选取（可选）</div>
          <div class="srow"><span class="pickbtn" @click="toggleSatPick">在地图上点选卫星</span></div>
          <div class="srow"><input class="ci" :value="satSearchKw" placeholder="或搜索卫星名 / 编号" @input="onSatSearch" /></div>
          <div v-if="satSearchRes.length" class="sres">
            <div v-for="r in satSearchRes" :key="r.noradId" class="sresi" @click="pickSatSearch(r)">
              <span class="srn" data-i18n-skip>{{ r.name }}</span><em>{{ r.groupLabel }} · {{ r.noradId }}<template v-if="r.slot"> · {{ r.slot }}</template></em>
            </div>
          </div>
          <div v-if="satModal.noradId" class="tip2">已关联星座卫星 NORAD {{ satModal.noradId }}（仰角线随时间轴 / 实时跟踪）<span class="lnk" @click="satModal.noradId = null; applySatLive()">取消关联</span></div>
        </div>
      </div>
    </div>

    <!-- 独立仰角线弹窗：与「添加/编辑卫星」弹窗脱钩，只填位置 + 仰角线参数，不涉及图标/卫星名/星座关联 -->
    <div v-if="elevModal" class="sat-mask">
      <div class="sat-dlg el-dlg">
        <div class="sdh"><span>{{ elevModal.folder ? '编辑仰角线' : '添加仰角线' }}</span><span class="csx" @click="closeElevModal"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody">
          <div class="srow"><label>名称</label><input class="ci" v-model="elevModal.name" placeholder="如 5°仰角参考" /></div>
          <div class="srow"><label>经度</label><input class="ci" type="number" step="0.1" v-model.number="elevModal.lon" /><span class="u">°E</span></div>
          <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.1" v-model.number="elevModal.lat" /><span class="u">°N</span></div>
          <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="100" v-model.number="elevModal.altKm" /><span class="u">km</span><span class="geobtn" title="设为标准 GEO 轨道高度 35786km（NASA 标称值）" @click="applyElevGeoAlt">一键GEO</span></div>

          <div class="sdiv">仰角线（等仰角环 / 角度标注）</div>
          <div class="srow"><label>仰角值</label><input class="ci" v-model="elevModal.els" placeholder="如 5,10,20（0=地平）" /><span class="u">°</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="elevModal.elevWidth" /><span class="u">{{ (elevModal.elevWidth || 1.3).toFixed(1) }}</span></div>
          <div class="srow"><label>标注字号</label><input class="rng" type="range" min="1" max="35" step="1" v-model.number="elevModal.elevLabelSize" /><span class="u">{{ elevModal.elevLabelSize || 18 }}</span></div>
          <label class="chk2"><input type="checkbox" v-model="elevModal.elevLabelBold" /><span>标注粗体</span></label>
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="elevModal.color" /></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="closeElevModal">取消</span><span class="save" @click="saveElevModal">保存</span></div>
      </div>
    </div>
    <!-- 星座生成/编辑器已内联到左侧「星座」侧栏（见 .cedit），不再用居中弹窗（可对着地图实时调整） -->
    <!-- 模式横幅只报状态；怎么操作挂在 title 上（界面不写教学文字） -->
    <div v-if="satModal && satPick" class="sat-banner" title="点击地图上的卫星填入位置">
      点选模式<template v-if="flatView"> · 平面图无星点</template>
      <span class="lnk" @click="satPick = false">完成 / 取消</span>
    </div>

    <!-- 添加地球站命名对话框（右键菜单触发，位置取右键处） -->
    <div v-if="stPrompt" class="sat-mask">
      <div class="sat-dlg st-dlg">
        <div class="sdh"><span>添加地球站</span><span class="csx" @click="cancelStation"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody">
          <div class="srow"><label>名称</label><input class="ci" v-model="stPromptName" placeholder="如 北京站" autofocus @keyup.enter="confirmStation" /></div>
          <div class="srow"><label>位置</label><span class="u">{{ fmtLL(stPrompt.lat, stPrompt.lon) }}</span></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="cancelStation">取消</span><span class="save" @click="confirmStation">添加</span></div>
      </div>
    </div>

    <!-- 卫星组管理器：左＝组列表（新建/复制/删除），右＝当前组（改名 + 搜索添加 + 成员表移出）。
         与地图渲染态解耦：不必先把卫星显示出来，直接搜全量目录勾选入组；组成员是 {NORAD,名称} 快照，
         即使卫星已不在当前星历也列得出来、删得掉。 -->
    <div v-if="sgmOpen" class="sat-mask sat-overlay" @click.self="closeSatGrpMgr">
      <div class="sat-dlg sgm-dlg">
        <div class="sdh"><span>卫星组管理</span><span class="csx" @click="closeSatGrpMgr"><Icon name="x" :size="12" /></span></div>
        <div class="sgm-body">
          <div class="sgm-left">
            <div class="sgm-lt">全部组 <em>{{ satGroups.list.value.length }}</em>
              <span class="lnk" title="新建一个空组" @click="sgmNew"><Icon name="plus" :size="12" /> 新建</span>
            </div>
            <div class="sgm-glist">
              <div v-if="!satGroups.list.value.length" class="sgm-empty">还没有卫星组。</div>
              <div
                v-for="g in satGroups.list.value" :key="g.id"
                class="sgm-grow" :class="{ cur: g.id === sgmId }"
                @click="sgmPickGroup(g)"
              >
                <span class="gdot" :class="{ off: !g.color }" :style="g.color ? { background: g.color } : null"></span>
                <span class="gnm" :title="g.name" data-i18n-skip>{{ g.name }}</span>
                <span class="gcnt">{{ g.sats.length }}</span>
                <span class="gic" title="复制该组（含成员）" @click.stop="sgmDup(g)"><Icon name="copy" :size="12" /></span>
                <span class="gic del" :class="{ warn: sgmDelId === g.id }" :title="sgmDelId === g.id ? '再次点击确认删除' : '删除该组'" @click.stop="sgmDel(g)"><Icon name="trash" :size="12" /></span>
              </div>
            </div>
          </div>

          <div class="sgm-right">
            <template v-if="sgmCur">
              <div class="sgm-name">
                <label>组名</label>
                <input class="ci" ref="sgmNameEl" v-model="sgmNameVal" placeholder="卫星组名称" @input="sgmCommitName" @blur="sgmNameVal = (sgmCur ? sgmCur.name : '')" />
                <span class="gbtn" title="在地图上显示该组的卫星" @click="sgmShow"><Icon name="eye" :size="12" /> 显示</span>
              </div>

              <div class="sgm-clr">
                <label>着色</label>
                <span v-for="p in SGM_PALETTE" :key="p" class="pz" :class="{ on: sgmCur.color === p }" :style="{ background: p }" :title="p" @click="satGrpSetColor(sgmCur, p)"></span>
                <label class="pgclr lg" :title="'自定义颜色（' + (sgmCur.color || '未设置，随所属星座') + '）'">
                  <span class="pgsw" :class="{ unset: !sgmCur.color }" :style="sgmCur.color ? { background: sgmCur.color } : null"></span>
                  <input type="color" :value="sgmCur.color || DEFAULT_SAT_HEX" @input="e => satGrpSetColor(sgmCur, e.target.value)" />
                </label>
                <span class="hexv">{{ sgmCur.color || '—' }}</span>
                <span class="gbtn" :class="{ dis: !sgmHasAnyColor }" title="清除组色与全部逐颗颜色，回到随所属星座" @click="sgmResetAllColor"><Icon name="x" :size="12" /> 恢复默认</span>
              </div>

              <div class="sgm-sec" title="更换关键词可继续检索，勾选结果累计保留">搜索添加</div>
              <div class="sgm-srch">
                <input class="ci" v-model="sgmKw" placeholder="卫星名 / NORAD 编号 / 星座名，如 starlink、48274" @input="sgmOnSearch" />
                <span v-if="sgmRes.length" class="gbtn" title="将当前结果中未入组的全部勾选" @click="sgmPickAllRes">全选结果</span>
              </div>
              <SatFilterBar
                :model-value="satFilters" :satcat="satcatIdx" :pool="satPoolForFilter" :matched="-1"
                @update:model-value="onSgmFilterChange"
              />
              <div class="sgm-reslist">
                <div v-if="sgmBusy" class="sgm-empty">搜索中…</div>
                <div v-else-if="!sgmKw.trim()" class="sgm-empty">输入关键词搜索。</div>
                <div v-else-if="!sgmRes.length" class="sgm-empty">没有匹配的卫星。</div>
                <label v-for="it in sgmRes" :key="it.id" class="sgm-ck" :class="{ dim: sgmMemIds.has(it.id) }">
                  <!-- 已在组内 → 禁用且不显勾（勾选集是跨组暂存的，切组后可能含本组已有星，避免显示成「已勾选」误导） -->
                  <input type="checkbox" :checked="!sgmMemIds.has(it.id) && sgmPickIds.has(it.id)" :disabled="sgmMemIds.has(it.id)" @change="sgmTogglePick(it)" />
                  <span class="cn" :title="it.name" data-i18n-skip>{{ it.name }}</span>
                  <em>{{ it.groupLabel }} · {{ it.id }}<template v-if="it.slot"> · {{ it.slot }}</template></em>
                  <b v-if="sgmMemIds.has(it.id)">已在组内</b>
                </label>
              </div>
              <div class="sgm-pickbar">
                <span>已勾选 <b>{{ sgmPick.length }}</b> 颗</span>
                <span v-if="sgmPick.length" class="lnk" @click="sgmPick = []">清空勾选</span>
                <span class="save" :class="{ dis: !sgmPick.length }" @click="sgmAddPick"><Icon name="plus" :size="12" /> 加入本组</span>
              </div>

              <div class="sgm-sec">组内卫星 <em>{{ sgmCur.sats.length }} 颗</em></div>
              <div class="sgm-memtool">
                <input class="ci" v-model="sgmMemKw" placeholder="在组内过滤…" />
                <span class="gbtn" @click="sgmToggleMemAll">全选 / 反选</span>
                <label class="gbtn clr" :class="{ dis: !sgmSel.length }" :title="'为所选 ' + sgmSel.length + ' 颗单独指定颜色（优先于组色）'">
                  <Icon name="droplets" :size="12" /> 着色所选{{ sgmSel.length ? (' ' + sgmSel.length) : '' }}
                  <input type="color" :value="sgmCur.color || DEFAULT_SAT_HEX" @input="e => satGrpColorSats(sgmCur, sgmSel, e.target.value)" />
                </label>
                <span class="gbtn" :class="{ dis: !sgmSel.length }" title="清除所选卫星的单独颜色，回到组色" @click="satGrpColorSats(sgmCur, sgmSel, '')">清除着色</span>
                <span class="gbtn danger" :class="{ dis: !sgmSel.length }" @click="sgmRemoveMem(sgmSel)"><Icon name="minus" :size="12" /> 移出所选{{ sgmSel.length ? (' ' + sgmSel.length) : '' }}</span>
              </div>
              <div class="sgm-memlist">
                <div v-if="!sgmCur.sats.length" class="sgm-empty">该组还没有卫星。</div>
                <div v-else-if="!sgmMembers.length" class="sgm-empty">没有匹配的成员。</div>
                <label v-for="m in sgmMembers" :key="m.id" class="sgm-ck">
                  <input type="checkbox" :checked="sgmSelIds.has(m.id)" @change="sgmToggleMem(m.id)" />
                  <span class="pgclr" :title="m.color ? ('单独颜色（' + m.color + '）') : (sgmCur.color ? ('随组色（' + sgmCur.color + '）') : '未着色（随所属星座）')" @click.stop>
                    <span class="pgsw" :class="{ unset: !m.color && !sgmCur.color, inh: !m.color && !!sgmCur.color }" :style="(m.color || sgmCur.color) ? { background: m.color || sgmCur.color } : null"></span>
                    <input type="color" :value="m.color || sgmCur.color || DEFAULT_SAT_HEX" @input="e => satGrpColorSats(sgmCur, [m.id], e.target.value)" />
                  </span>
                  <span class="cn" :title="m.name" data-i18n-skip>{{ m.name }}</span>
                  <em :class="{ miss: !m.inPool }">{{ m.inPool ? m.groupLabel : '未在当前星历' }} · {{ m.id }}<template v-if="m.slot"> · {{ m.slot }}</template></em>
                  <span v-if="m.color" class="gic" title="清除单独颜色，回到组色" @click.stop.prevent="satGrpColorSats(sgmCur, [m.id], '')"><Icon name="droplets" :size="12" /></span>
                  <span class="gic del" title="从本组移出" @click.stop.prevent="sgmRemoveMem([m.id])"><Icon name="x" :size="12" /></span>
                </label>
              </div>
            </template>
            <div v-else class="sgm-empty big">还没有卫星组。</div>
          </div>
        </div>
        <div class="sdfoot"><span class="save" @click="closeSatGrpMgr">完成</span></div>
      </div>
    </div>

    <!-- 应用内提示弹窗（替代 Electron 原生 alert，避免关闭后输入框无法聚焦） -->
    <div v-if="alertMsg" class="sat-mask sat-overlay" @click.self="closeAlert">
      <div class="sat-dlg al-dlg">
        <div class="sdh"><span>提示</span><span class="csx" @click="closeAlert"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody"><p class="al-msg">{{ alertMsg }}</p></div>
        <div class="sdfoot"><span class="save" @click="closeAlert">确定</span></div>
      </div>
    </div>

    <!-- 发送到小程序：与链路预算三窗、文件区共用同一个弹窗（绑定账号直投 / 生成密钥） -->
    <MiniSendDialog
      v-model:open="miniSendOpen"
      :build="buildMiniSend"
      :picks="miniPicks"
      renamable
      :device-id="miniDeviceId"
      :configured="miniConfigured"
      key-hint="小程序「工具栏 → 卫星覆盖 → 导入」输入"
      @sent="onMiniSent"
      @toast="(m) => logMsg(m)"
    />

    <!-- 卫星组 / 自定义卫星 / 自定义星座 → 小程序「星座地图」（与上面同一个组件、同一条通道，各自一份清单） -->
    <MiniSendDialog
      v-model:open="miniSatOpen"
      :build="buildMiniSatSend"
      :device-id="miniDeviceId"
      :configured="miniConfigured"
      key-hint="小程序「工具栏 → 星座地图 → 导入」输入"
      @toast="(m) => logMsg(m)"
    />

    <!-- 航行 / 飞行航迹 → 小程序「卫星覆盖 · 航迹」（一条一件，内容清单逐条勾选） -->
    <MiniSendDialog
      v-model:open="miniTrajOpen"
      :build="buildMiniTrajSend"
      :device-id="miniDeviceId"
      :configured="miniConfigured"
      key-hint="小程序「工具栏 → 卫星覆盖 → 航迹 → 密钥导入」输入"
      @toast="(m) => logMsg(m)"
    />

    <!-- 轨迹描绘横幅：有正在编辑的轨迹时显示；与 Polygon 同款：右键逐点 / 左键沿路径拖动连续加点 -->
    <div v-if="activeTraj" class="traj-banner" title="右键地图连续加点，或按住左键沿路径拖动连续加点">
      正在描绘{{ curTraj() && curTraj().kind === 'flight' ? '飞行' : '航行' }}轨迹
      <span class="lnk" @click="trajUndo">撤销上点</span>
      <span class="lnk" @click="endTraj">结束</span>
    </div>

    <!-- Polygon 绘制横幅：绘制中提示右键加顶点，「完成」闭合成多边形 -->
    <div v-if="polyDrawId" class="traj-banner" title="右键地图连续加顶点，或按住左键沿路径拖动连续加点（至少 3 点）">
      正在绘制 Polygon「{{ curPoly() ? curPoly().name : '' }}」
      <span class="lnk" @click="polyUndo">撤销上点</span>
      <span class="lnk" @click="polyDone">完成</span>
      <span class="lnk" @click="polyCancel">取消</span>
    </div>

    <!-- 覆盖分析两种拖拽模式的横幅（与 Polygon 绘制同款）：开着就常显，「完成」退出该模式 -->
    <div v-if="grd.dragLabel.value" class="traj-banner" title="在地图上按住标签沿等值线拖动">
      正在拖动数值标签
      <span class="lnk" @click="grd.setDragLabel(false)">完成</span>
    </div>
    <div v-if="grd.dragBore.value" class="traj-banner" title="在地图上按住左键拖动改指向">
      正在拖拽波束「{{ grd.activeName() }}」
      <span class="lnk" @click="grd.setDragBore(false)">完成</span>
    </div>

    <!-- Polygon 调整顶点横幅：拖动地图上的顶点圆点调整位置 -->
    <div v-if="polyEditId" class="traj-banner" title="在平面图上拖动圆点改位置">
      正在调整「{{ curEditPoly() ? curEditPoly().name : '' }}」顶点
      <span class="lnk" @click="polyEditStop">完成</span>
    </div>

    <!-- Polygon 整体拖动横幅：按住多边形内部平移整个多边形 -->
    <div v-if="polyMoveId" class="traj-banner" title="在平面图上按住多边形内部拖动">
      正在整体拖动「{{ curMovePoly() ? curMovePoly().name : '' }}」
      <span class="lnk" @click="polyMoveStop">完成</span>
    </div>

    <!-- 标记「调整点位置」横幅：本态下该类标记才可用鼠标拖（点标记 / 地球站 / 航迹航点共用） -->
    <div v-if="mkEditId" class="traj-banner">
      正在调整{{ mkEditLabel }}位置
      <span class="lnk" @click="mkEditStop">完成</span>
    </div>

    <!-- 地图右键上下文菜单（3D / 平面图共用）；点击空白处或再次右键关闭 -->
    <template v-if="ctxMenu">
      <div class="ctx-mask" @click="closeCtx" @contextmenu.prevent="closeCtx"></div>
      <div ref="ctxMenuEl" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <!-- 跟随卫星（仅 3D）：跟随中首项是退出；否则右键压在一颗星上时首项是跟随它 -->
        <div v-if="!flatView && following" class="ctx-item" @click="ctxStopFollow">退出跟随<span class="ctx-kb">Esc</span></div>
        <div v-else-if="!flatView && ctxMenu.en >= 0" class="ctx-item" @click="ctxFollow">跟随卫星</div>
        <!-- 压在一颗星上：为它新建高斯天线（没有关联树节点就先建一颗关联星）/ 把它已有天线的覆盖显示出来 -->
        <template v-if="!flatView && ctxMenu.en >= 0 && grdApiOk">
          <div v-if="!ctxMenu.enPv" class="ctx-item" @click="ctxNewGauss">新建高斯天线</div>
          <div v-if="ctxHasAnts" class="ctx-item" @click="ctxShowAntCov">显示天线覆盖</div>
        </template>
        <div v-if="!flatView && (following || ctxMenu.en >= 0)" class="ctx-sep"></div>
        <!-- 压着地球站 / 点标记 / 载具头：挂 / 换 / 卸模型 -->
        <template v-if="ctxMenu.ent">
          <div class="ctx-item" @click="ctxEntModel">模型…</div>
          <div v-if="ctxMenu.ent.has" class="ctx-item" @click="ctxEntUnmount">卸下模型</div>
          <div class="ctx-sep"></div>
        </template>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddPoint">添加点标记（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddStation">添加地球站（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('sea')">添加航行轨迹</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('flight')">添加飞行轨迹</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartPoly">绘制 Polygon（协调区）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxSetLandColor">设置此国大地颜色</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" @click="ctxHidePoints">隐藏所有点标记</div>
        <div class="ctx-item" @click="ctxHideStations">隐藏所有地球站</div>
        <div class="ctx-item" @click="ctxHideTrajs">隐藏所有航迹</div>
        <div class="ctx-item" @click="ctxClearPolys">隐藏所有 Polygon</div>
        <div class="ctx-item" @click="ctxHideAllMk">隐藏所有标记</div>
        <div v-if="grdApiOk || covApiOk" class="ctx-item" @click="clearAllCoverage">清除所有覆盖图</div>
        <div v-if="grdApiOk" class="ctx-item" @click="ctxClearShellCov">清除壳层覆盖</div>
        <div v-if="grdApiOk" class="ctx-item" @click="ctxHideShellGuides">隐藏壳层参照网</div>
        <!-- 聚焦组放在菜单最末：破坏性项离弹出点（指针）最远，与首项「跟随卫星」隔开整张菜单 -->
        <template v-if="selected || prevFocusTag">
          <div class="ctx-sep"></div>
          <div v-if="prevFocusTag" class="ctx-item" @click="ctxPrevFocus">上一聚焦<span class="ctx-kb rdk-pf" data-i18n-skip>{{ prevFocusTag }}</span></div>
          <div v-if="selected && selList.length > 1" class="ctx-item" @click="ctxClearFocus">全部取消聚焦</div>
          <div v-else-if="selected" class="ctx-item" @click="ctxClearFocus">取消聚焦</div>
        </template>
      </div>
    </template>

    <!-- 模型选择弹层（标记侧栏「模型」小块 / 右键「模型…」）：落到标记对象的内联字段 -->
    <ModelPickPop
      v-if="pickPop && pickPopObj"
      :anchor="pickPop.anchor" :lib="modelLib.list" :domain="pickPop.domain"
      :value="pickPopObj.model ? pickPopObj.model.id : ''"
      @pick="(id) => setEntityModel(pickPop.kind, pickPop.id, id)" @clear="setEntityModel(pickPop.kind, pickPop.id, null)" @close="pickPop = null" />


    <!-- 「从星座取」壳层挑选器（全量在轨目录 → 归并成层 → 勾哪层加哪层） -->
    <SatCovShellPicker
      v-if="satcovPickOpen"
      :sats="satcovPickPool" :loading="satcovPickLoading" :source="satcovPickSrc" :existing="satcovShellAlts"
      @close="satcovPickOpen = false" @set-source="satcovSetPickSrc" @add="satcovAddPicked" />

    <!-- 标记批量表格（Excel 模块，仿性能表浮窗）：点标记 / 地球站 / 航迹 三分页，Excel 式框选·键盘导航·复制·编辑·区域粘贴，支持批量导入 -->
    <div v-if="mkTableOpen" class="perf-win mk-win" :style="{ left: mkWin.x + 'px', top: mkWin.y + 'px', width: mkWin.w + 'px', height: mkWin.h + 'px' }">
      <div class="perf-h" @mousedown="mkDragMove">
        <span class="perf-t">标记批量表格</span>
        <span class="mk-tabs">
          <span class="mk-tab" :class="{ on: mkTab === 'points' }" @click="mkSetTab('points')">点标记</span>
          <span class="mk-tab" :class="{ on: mkTab === 'stations' }" @click="mkSetTab('stations')">地球站</span>
          <span class="mk-tab" :class="{ on: mkTab === 'traj' }" @click="mkSetTab('traj')">航迹</span>
        </span>
        <span class="csx" @click="closeMkTable"><Icon name="x" :size="12" /></span>
      </div>

      <!-- 工具栏：撤销/重做/增加/粘贴/导入导出/清空。恒作用于右侧网格（航迹分页即当前那条航迹的航点），航迹本身的增删改在左栏 -->
      <div class="pin-h mk-toolbar">
        <span class="ptb" :class="{ dis: !mkTable.canUndo.value }" title="撤销 (Ctrl+Z)" @click="mkUndo"><Icon name="undo-2" :size="12" /></span>
        <span class="ptb" :class="{ dis: !mkTable.canRedo.value }" title="重做 (Ctrl+Y)" @click="mkRedo"><Icon name="redo-2" :size="12" /></span>
        <span class="ptb" :title="mkTab === 'traj' ? '在选中航点下方增加一行（直接键入或粘贴）' : '在选中行下方增加一行（直接键入或粘贴）'" @click="mkAddRow"><Icon name="plus" :size="12" /> 增加</span>
        <span class="ptb" title="从剪贴板批量追加（约定末两列 = 经度、纬度；地球站首列可为名称）" @click="mkPaste"><Icon name="clipboard" :size="12" /> 粘贴</span>
        <span class="ptb" :title="mkTab === 'traj' ? '从 Excel 批量导入航迹：一张工作表一条航迹，表名即航迹名' : '从 Excel 追加到当前分页（按表头匹配列；无表头时末两列作经纬度）'" @click="mkImportXlsx"><Icon name="import" :size="12" /> 导入 Excel</span>
        <span class="ptb" :class="{ dis: !mkXlsxRows }" :title="mkTab === 'traj' ? '把全部航迹导出为 Excel：一条航迹一张工作表' : '把当前分页导出为 Excel'" @click="mkExportXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
        <span class="ptb" :title="mkTab === 'traj' ? '清空当前航迹的航点（航迹本身保留）' : '清空当前分页列表'" @click="mkClear">清空</span>
        <span class="perf-cnt">{{ mkCount }} 行</span>
      </div>

      <!-- 表体：航迹分页是主从（左栏一条条航迹，右侧该航迹的航点网格）；点标记 / 地球站分页只有网格 -->
      <div class="mk-main">
        <aside v-if="mkTab === 'traj'" class="mk-trajs">
          <div class="mtj-h">
            <span class="mtj-ht">航迹</span>
            <span class="mtj-add" title="新建航行航迹" @click="mkNewTraj('sea')"><Icon name="plus" :size="12" />航行</span>
            <span class="mtj-add" title="新建飞行航迹" @click="mkNewTraj('flight')"><Icon name="plus" :size="12" />飞行</span>
          </div>
          <div class="mtj-list">
            <div v-for="t in trajectories" :key="t.id" class="mtj-row" :class="{ on: mkTrajId === t.id }"
                 @click="mkTrajId = t.id" @dblclick="mkRenameStart(t)">
              <span class="mtj-k" :class="t.kind === 'flight' ? 'flight' : 'sea'"
                    :title="t.kind === 'flight' ? '飞行航迹，点击改为航行' : '航行航迹，点击改为飞行'" @click.stop="mkToggleKind(t)"></span>
              <input v-if="mkRenameId === t.id" class="mtj-ren" :value="mkRenameVal" @click.stop @dblclick.stop
                     @input="e => mkRenameVal = e.target.value" @keyup.enter="mkRenameCommit" @keyup.esc="mkRenameCancel" @blur="mkRenameCommit" />
              <template v-else>
                <!-- 名字位打了 skip（用户自命名不翻），连带 title 也翻不到 → 后半句自己按语言出字 -->
                <span class="mtj-n" :title="(t.name || byLang('航迹', 'Track')) + byLang(' · 双击改名', ' · double-click to rename')" data-i18n-skip>{{ t.name || byLang('航迹', 'Track') }}</span>
                <span class="mtj-c">{{ (t.pts || []).length }}</span>
                <span class="mtj-x" title="删除该航迹" @click.stop="mkDelTraj(t)"><Icon name="x" :size="12" /></span>
              </template>
            </div>
            <div v-if="!trajectories.length" class="mtj-empty">还没有航迹。</div>
          </div>
        </aside>

        <div class="mk-col">
          <!-- 航迹页：当前航迹的运动参数（与侧栏「运动」栏改的是同一组字段）+ 全程 / 历时 / 到达读数 -->
          <div v-if="mkTab === 'traj' && mkCurTraj()" class="mk-tjbar">
            <template v-if="mkCurTraj().kind === 'flight'">
              <label>巡航高度</label><NumIn class="mkp-n" :model-value="Number.isFinite(mkCurTraj().cruiseAltM) ? mkCurTraj().cruiseAltM : null" allow-empty :min="0" :max="30000" :placeholder="String(CRUISE_ALT_M_DEFAULT)" title="飞行剖面的平飞高度；留空 = 10668 m（FL350）" @commit="(v) => mkMotEdit(mkCurTraj(), () => setTrajMotion(mkTrajId, { cruiseAltM: v }))" /><span class="u">m</span>
            </template>
            <label>速度</label><NumIn class="mkp-n" :model-value="Number.isFinite(mkCurTraj().speedKmh) ? mkCurTraj().speedKmh : null" allow-empty :min="1" :max="5000" title="地速（WGS-84 测地线里程）；航点定了时刻的段按时差反推，其余段按它推算" @commit="(v) => mkMotEdit(mkCurTraj(), () => setTrajMotion(mkTrajId, { speedKmh: v }))" /><span class="u">km/h</span>
            <label>起始</label><input class="ci t0i mkp-t" type="text" spellcheck="false" autocomplete="off" placeholder="YYYY-MM-DD HH:mm:ss" title="载具离开首航点的时刻（按显示时区；可带 Z 或 ±hh:mm）；与表格首行的时间是同一个数" :value="t0Edit.id === mkTrajId ? t0Edit.text : fmtT0(mkCurTraj().t0Ms)" @focus="t0Begin(mkCurTraj())" @input="t0Input(mkCurTraj(), $event.target.value)" @blur="mkMotEdit(mkCurTraj(), () => t0Commit(mkCurTraj()))" @keydown.enter.prevent="mkMotEdit(mkCurTraj(), () => t0Enter($event, mkCurTraj()))" @keydown.esc.prevent="t0Esc($event)" /><span class="lnk" title="设为当前仿真时刻" @click="mkMotEdit(mkCurTraj(), () => setTrajMotion(mkTrajId, { t0Ms: clock.tMs }))">此刻</span>
            <span class="mkp-r" data-i18n-skip>{{ mkTrajRead }}</span>
          </div>
          <!-- Excel 网格（见 src/components/ExcelGrid.vue）：三分页各一张，v-show 切换（实例常驻，选区/编辑态各自保留） -->
          <template v-for="p in mkPanes" :key="p.tab">
            <ExcelGrid v-show="mkTab === p.tab" class="pin-body mk-body eg-host" :grid="p.grid" :cols="p.cols"
                       :text="p.text" :cell-class="p.cellClass || null" :cell-tip="p.cellTip || null"
                       :head-tip="p.tab === 'traj' ? mkWpHeadTip : null" :actions-width="26"
                       :empty-text="p.tab === 'traj' && !mkCurTraj() ? '尚未选择航迹。' : '暂无数据。'"
                       add-label="增加一行" @add="mkAddRowEnd">
              <template #actions="{ row }">
                <span class="del" title="删除该行" @click="mkDelRow(row.id)"><Icon name="x" :size="12" /></span>
              </template>
            </ExcelGrid>
          </template>
        </div>
      </div>

      <div class="prh prh-n" @mousedown="mkDragResize($event, 'n')"></div>
      <div class="prh prh-s" @mousedown="mkDragResize($event, 's')"></div>
      <div class="prh prh-w" @mousedown="mkDragResize($event, 'w')"></div>
      <div class="prh prh-e" @mousedown="mkDragResize($event, 'e')"></div>
      <div class="prh prh-nw" @mousedown="mkDragResize($event, 'nw')"></div>
      <div class="prh prh-ne" @mousedown="mkDragResize($event, 'ne')"></div>
      <div class="prh prh-sw" @mousedown="mkDragResize($event, 'sw')"></div>
      <div class="perf-rsz" title="拖拽缩放窗口" @mousedown="mkDragResize($event, 'se')"></div>
    </div>

    <!-- 站点栅框选橡皮筋（平面图拖矩形，flatCoverage 回调驱动屏幕像素定位） -->
    <div v-if="bsStBox.on" class="bs-boxsel" :style="{ left: bsStBox.x + 'px', top: bsStBox.y + 'px', width: bsStBox.w + 'px', height: bsStBox.h + 'px' }"></div>

    <!-- 波束批量表格（Excel 网格）：经度 纬度 3dB-X 3dB-Y 旋转 -->
    <div v-if="bsTableOpen" class="perf-win mk-win" :style="{ left: bsTblWin.x + 'px', top: bsTblWin.y + 'px', width: bsTblWin.w + 'px', height: bsTblWin.h + 'px' }">
      <div class="perf-h" @mousedown="bsTblDragMove">
        <span class="perf-t">波束批量表格</span>
        <span class="csx" @click="bsTableOpen = false"><Icon name="x" :size="12" /></span>
      </div>
      <div class="pin-h mk-toolbar">
        <span class="ptb" :class="{ dis: !bs.canUndo.value }" title="撤销 (Ctrl+Z)" @click="bs.undo"><Icon name="undo-2" :size="12" /></span>
        <span class="ptb" :class="{ dis: !bs.canRedo.value }" title="重做 (Ctrl+Y)" @click="bs.redo"><Icon name="redo-2" :size="12" /></span>
        <span class="ptb" title="在选中行下方增加一行" @click="bsTblAddRow"><Icon name="plus" :size="12" /> 增加</span>
        <span class="ptb" title="从剪贴板批量追加（每行：经度 纬度 [宽X 宽Y 旋转]）" @click="bsTblPaste"><Icon name="clipboard" :size="12" /> 粘贴</span>
        <span class="ptb" title="清空全部波束" @click="bsTblClear">清空</span>
        <span class="perf-cnt">{{ bs.beams.value.length }} 波束</span>
      </div>
      <ExcelGrid class="pin-body mk-body eg-host" :grid="bsGrid" :cols="bsTblCols"
                 :text="bsCellText" :actions-width="26"
                 empty-text="暂无波束。" add-label="增加一行" @add="bsTblAddRowEnd">
        <template #actions="{ row }">
          <span class="del" title="删除该行" @click="bsTblDelRow(row.id)"><Icon name="x" :size="12" /></span>
        </template>
      </ExcelGrid>
      <div class="prh prh-n" @mousedown="bsTblDragResize($event, 'n')"></div>
      <div class="prh prh-s" @mousedown="bsTblDragResize($event, 's')"></div>
      <div class="prh prh-w" @mousedown="bsTblDragResize($event, 'w')"></div>
      <div class="prh prh-e" @mousedown="bsTblDragResize($event, 'e')"></div>
      <div class="prh prh-nw" @mousedown="bsTblDragResize($event, 'nw')"></div>
      <div class="prh prh-ne" @mousedown="bsTblDragResize($event, 'ne')"></div>
      <div class="prh prh-sw" @mousedown="bsTblDragResize($event, 'sw')"></div>
      <div class="perf-rsz" title="拖拽缩放窗口" @mousedown="bsTblDragResize($event, 'se')"></div>
    </div>

    <!-- 性能表选项弹窗（对标 SATSOFT Performance Table Options）：显示列 / 过滤 / 波束类型 / 计算口径 / 指向误差 -->
  </div>
</template>

<style scoped>
.g3 { display: flex; flex-direction: column; height: 100%; position: relative; }
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: var(--fs-4); }
.bar .t { font-family: var(--font-serif); font-size: var(--fs-5); }
.bar select { border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 3px 8px; }
.search { position: relative; }
.search input { border: 1px solid var(--field-border); background: var(--field-bg); padding: 3px 24px 3px 8px; outline: none; width: 180px; }
.search .clr { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: var(--fs-2); line-height: 1; cursor: pointer; color: var(--text-faint); }
.search .clr:hover { color: var(--text); }
.search .item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search .item:hover { background: var(--surface); }
.search .nm { font-size: var(--fs-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search .sub { color: var(--text-faint); font-size: var(--fs-2); }
/* 结果行「+」：加入选中集而不清搜索框（跨多次搜索攒一批，再「存为组」）；已在集中时显示 ✓ */
.meta { margin-left: auto; color: var(--text-faint); }
.tl.bottom { flex: none; border-top: 1px solid var(--border); background: var(--surface); container-type: inline-size; position: relative; font-size: var(--fs-3);
  --tl-red: #e05252;                                                  /* 此刻 / 实时 专用红（原 6 处写死值收成一处） */
  --tl-red-ink: color-mix(in srgb, #e05252 78%, var(--text));         /* 10–11px 红字：浅 ≈4.6:1 / 深 ≈4.8:1 */
  --tl-pole: var(--border-strong);                                    /* 带标签的长刻线 / 未标注主刻 / 细刻 / 基线 */
  --tl-pole-day: var(--text-faint);                                   /* 日界长刻线加深一档 */
  --tl-mid: var(--text-faint);                                        /* 次刻（6px）比长刻线深：长线是「引线」、短线是「刻度」 */
  --tl-lab: var(--text-muted);
  --tl-lab-day: color-mix(in srgb, var(--text) 88%, var(--surface));
  /* 纵向坐标（刻度尺内，CSS px）。两层：尺子独占上层（尺高 28，基线 26）；基线下方隔 6px 才是控件层 */
  --y-lab: 5px;     /* 标签行盒顶 */
  --y-cap: 6px;     /* 长刻线 / 此刻线的顶（握柄 y 0→6 之下） */
  --y-zone: 15px;   /* 标签行之下 = 刻度区的顶 */
  --y-base: 26px;   /* 基线：10px 主刻 16→26，与标签底（基线 13.5）留 2.5px */
}
/* 上层：刻度尺整条通栏，左右与控件层同一 12px 边距（尺子两端 = 实时键左缘 / 倍速右缘）。
   纵向节奏（CSS px，全为偶数 → 150% 下每条边落整设备像素）：边框 1 | 4 | 尺 28（基线 26）| 4 | 控件 22 | 4 = 63。
   尺上 4px：键盘环（y 1→3）与握柄（y 4 起）之间留 1px、与条顶边框之间留 1px */
.tl-ruler { padding: 4px 12px 0; }
/* 下层：左（实时 · 跨度）｜中（读数 · 走带，真居中）｜右（步长 · 倍速）。两侧 minmax(max-content,1fr)：放得下时中组居中，放不下时退成顺排、不溢出 */
.tl-row { display: grid; grid-template-columns: minmax(max-content, 1fr) auto minmax(max-content, 1fr); grid-auto-rows: var(--h-ctl); align-items: center; column-gap: 16px; padding: 4px 12px; }
.tl-grp { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.tl-grp.c { gap: 12px; }
.tl-grp.l { justify-self: start; }
.tl-grp.r { justify-self: end; }

/* —— 实时键：灭 = 灰点；亮 = 红点 + 红字 + 红框（无填充、无脉冲）—— */
.tl .live-btn { display: inline-flex; align-items: center; gap: 5px; height: var(--h-ctl); padding: 0 8px 0 7px; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: transparent; font: inherit; font-size: var(--fs-2); line-height: 1; cursor: pointer; color: var(--text-muted); flex: none; white-space: nowrap; user-select: none; transition: var(--t-state); }
.tl .live-btn:hover { border-color: var(--line-hover); color: var(--text); }
.tl .live-btn .ldot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex: none; }
.tl .live-btn.on { color: var(--tl-red-ink); border-color: color-mix(in srgb, var(--tl-red) 55%, transparent); }
.tl .live-btn.on .ldot { background: var(--tl-red); }

/* —— 带栏名的下拉：跨度 / 步长 / 倍速 —— */
.tl .clkg { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.tl .ckl { font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; user-select: none; }
.tl .cksel + .ckl { margin-left: 6px; }
.tl .cksel { background-color: var(--surface); color: var(--text-muted); border: 1px solid var(--field-border); border-radius: var(--r-ctl); font-size: var(--fs-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; padding: 0 21px 0 5px; cursor: pointer; outline: none; }
.tl .cksel:hover { color: var(--text); border-color: var(--field-border-hover); }
.tl .cksel.wsel { width: 68px; }        /* 定宽：滚轮会往里挂自定义档（最长「23h59m」11px Arial 39.8 + 5 + 21 + 2） */
.tl .cksel.ssel { min-width: 50px; }    /* 下限：预设档永不推尺子；只有存档里的非预设值（装载时一次）才可能更宽 */
.tl .cksel.xsel { min-width: 70px; }

/* ================= 刻度尺 ================= */
.tb-track { position: relative; height: calc(var(--y-base) + 2px); cursor: pointer; outline: none; touch-action: none; user-select: none; contain: layout; }
.tb-track:focus-visible:not(.kbf) { outline: none !important; }
.tb-track.kbf { outline: none !important; }
/* 命中区上探到条顶边框：从地图往下够握柄不会落进 4px 空档（伪元素的指针事件归轨道本身；只用 clientX，纵向无关） */
.tb-track::before { content: ''; position: absolute; left: 0; right: 0; top: -4px; height: 4px; }
/* 键盘环：上边在握柄之上（y −3→−1，离边框 1、离握柄 1），下边在基线之下（y 28→30，离基线 ≥1、离控件顶 2）。
   上下不对称 → 用伪元素画，不用 outline；压在握柄 / 标签 / 时刻片之上 */
.tb-track.kbf::after { content: ''; position: absolute; z-index: 6; left: -3px; right: -3px; top: -3px; bottom: -2px; border: 2px solid var(--accent-ui); border-radius: var(--r-box); pointer-events: none; }
.tb-scale { position: absolute; inset: 0; pointer-events: none; }
.tb-base { position: absolute; left: 0; right: 0; top: var(--y-base); height: var(--hp); background: var(--tl-pole); }
.tb-base::before, .tb-base::after { content: ''; position: absolute; bottom: 0; width: var(--hp); height: 6px; background: var(--tl-pole); }   /* 窗口两端的端刻 */
.tb-base::before { left: var(--x0, 0px); }
.tb-base::after { left: var(--x1, calc(100% - var(--hp))); }
.tb-t { position: absolute; width: var(--hp); }
.tb-t.tiny { top: calc(var(--y-base) - 3px); height: 3px; background: var(--tl-pole); }
.tb-t.min { top: calc(var(--y-base) - 6px); height: 6px; background: var(--tl-mid); }
.tb-t.maj { top: calc(var(--y-base) - 10px); height: 10px; background: var(--tl-pole); }                 /* 让掉标签的主刻 */
.tb-t.pole { top: var(--y-cap); height: calc(var(--y-base) - var(--y-cap)); background: var(--tl-pole); } /* 带标签的长刻线（日界无论有没有字都长） */
.tb-t.pole.day { background: var(--tl-pole-day); }
/* 标签压在游标针之上、自带面板色衬底（左右各 2px）：游标 / 影线从字后面穿过，字永远完整。
   行盒 y 6→14（行高 8px 时 10px 字的基线仍在 13.5，与原 top:5 / 行高 10 逐像素相同）：衬底不碰握柄（y 0→6） */
.tb-lab { position: absolute; z-index: 4; top: var(--y-cap); padding: 0 2px; margin: 0 -2px; background: var(--surface); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); line-height: 8px; letter-spacing: var(--ls-tight); color: var(--tl-lab); white-space: nowrap; }
.tb-lab.day { color: var(--tl-lab-day); }

/* 此刻：红发丝 + 标签行里的「此刻」（挂在游标反侧；左右都放不下只留红线） */
.tb-now { position: absolute; z-index: 1; left: var(--now-x); top: var(--y-cap); height: calc(var(--y-base) - var(--y-cap) + var(--hp)); width: var(--hp); background: var(--tl-red); pointer-events: none; }
.tb-now .tag { position: absolute; top: calc(var(--y-lab) - var(--y-cap)); left: calc(var(--hp) + 3px); font-family: var(--font-mono); font-size: var(--fs-1); line-height: 10px; color: var(--tl-red-ink); white-space: nowrap; }
.tb-now.flip .tag { left: auto; right: calc(var(--hp) + 3px); }

/* 偏移带：此刻 → 游标，压在基线上的 2 设备像素机位色 —— 读数偏移量的图形孪生。位置全由 CSS 变量算，逐帧只写 --ph-x */
.tb-span { position: absolute; z-index: 1; top: calc(var(--y-base) + var(--hp) - var(--php)); height: var(--php); left: min(var(--now-x), var(--ph-x)); width: calc(max(var(--now-x), var(--ph-x)) - min(var(--now-x), var(--ph-x))); background: var(--accent-ui); pointer-events: none; }

/* 游标：2 设备像素针 + 控件带上方的五边形握柄（整设备像素几何）。针在刻度标签之下穿过（见 .tb-lab） */
.tb-ph { position: absolute; z-index: 3; left: calc(var(--ph-x) - var(--php) / 2); top: 0; height: calc(var(--y-base) + var(--hp)); width: var(--php); pointer-events: none; --tl-ph: var(--accent); }
.tb-ph::after { content: ''; position: absolute; inset: 0; background: var(--tl-ph); }
.tb-ph .hd { position: absolute; z-index: 1; top: 0; left: 50%; width: var(--hdw); height: var(--hdh); transform: translateX(-50%); background: var(--tl-ph); clip-path: polygon(0 0, 100% 0, 100% 45%, 50% 100%, 0 45%); }
.tb-ph.lv { --tl-ph: var(--tl-red); }
.tb-ph.grab { --tl-ph: var(--accent-ui); }

/* 悬停：中性影线（刻度区）+ 标签行里的时刻片（不浮到地图上） */
.tb-ghost { position: absolute; z-index: 2; top: var(--y-zone); height: calc(var(--y-base) - var(--y-zone)); width: var(--hp); background: var(--text-faint); pointer-events: none; }
.tb-tip { position: absolute; z-index: 5; top: calc(var(--y-lab) - 2px); height: 14px; padding: 0 4px; display: flex; align-items: center; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); line-height: 1; letter-spacing: var(--ls-tight); color: var(--text); white-space: nowrap; pointer-events: none; }
/* 时刻片的面板色底衬：同一串字、同内距同边宽（边透明）→ 与片身逐像素同宽；纵向从轨道顶上 1px 一直到片底（y −1→17），
   片身之上这一段遮掉游标针 / 此刻线的顶端，片的圆角外也不透出底下的线。DOM 在 .tb-tip 之前，片身画在它上面 */
.tb-tipko { position: absolute; z-index: 5; top: -1px; height: calc(var(--y-lab) + 13px); padding: 0 4px; display: flex; align-items: flex-end; border: 1px solid transparent; background: var(--surface); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); line-height: 1; letter-spacing: var(--ls-tight); color: transparent; white-space: nowrap; pointer-events: none; user-select: none; }
/* 被时刻片压到的标签 / 「此刻」整枚让掉（连同衬底：片外不留一块把游标针切断的空白） */
.tb-lab.ko, .tb-now .tag.ko { visibility: hidden; }
.tb-ph.tipov .hd { visibility: hidden; }   /* 时刻片与握柄横向相交：握柄整枚让掉，不留被片边切开的半个五边形 */

/* ================= 读数：2×2 仪表表格 =================
   ┌ 时刻（15px）      时区（与时刻同基线）
   └ 日期              偏移（相对真实此刻）
   内容盒 = 22px 控件带：时刻大写顶 = 控件上缘，第二行基线 = 控件下缘。
   两列都定宽：列 1 = JS 按当前界面字体量出的「HH:MM:SS 最宽可能」（--ro-c1，单位 em），列 2 = max(11ch, 偏移 / 时区最宽可能 --ro-c2)；
   任何读数、任何字体下块宽恒定 → 尺子永不被推。DOM 仍是 .t1 + .t2(.d .o .z)，.t2 用 display: contents 让三格直接进网格 */
.tlab2 { --ro-fs: var(--fs-5); display: grid; grid-template-columns: calc(var(--ro-c1, 3.98) * var(--ro-fs)) max(11ch, calc(var(--ro-c2, 0) * 1em)); grid-template-rows: 12px 10px; column-gap: 7px; align-items: baseline; flex: none; height: 22px; padding: 2px 6px; margin: -2px -6px; box-sizing: content-box; border-radius: var(--r-box); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); line-height: 13px; color: var(--text-faint); white-space: nowrap; cursor: pointer; user-select: none; contain: layout; transition: background-color var(--dur-1) linear; }
.tlab2 .t2 { display: contents; }
.tlab2 .t1 { grid-area: 1 / 1; font-size: var(--ro-fs); line-height: 12px; letter-spacing: var(--ls-tight); color: var(--text); }
.tlab2 .z { grid-area: 1 / 2; color: var(--text-muted); transition: color var(--dur-1) linear; }
.tlab2 .d { grid-area: 2 / 1; }
.tlab2 .o { grid-area: 2 / 2; }
.tlab2 .o.lv { color: var(--tl-red-ink); }
.tlab2.scrub .o { color: var(--text); }
.tlab2:hover { background: var(--wash-hover); }
.tlab2.open { background: var(--wash-press); }
.tlab2:hover .z, .tlab2.open .z { color: var(--text); }
.tlab2:focus-visible { outline: 2px solid var(--accent-ui); outline-offset: -1px; }   /* 环 = 罩外 1px：上离基线 ≥2、下离状态栏边框 1 */
/* 读数面板头：跳到指定时刻（输入框 + 跳转）。插槽内容由本组件渲染 → scoped 照样打得到（节点随菜单 Teleport 到 body）。
   框左右内距 8：框边与档位的悬停罩同在菜单内 3px 处，框内文字与档位文字同在 12px 处（3 + 边 1 + 8 = 3 + 档位内距 9） */
.rogo { display: flex; align-items: center; gap: 6px; }
.rogo .ci { font-size: var(--fs-3); padding: 0 8px; background-color: var(--field-bg); color: var(--text);
            border: 1px solid var(--field-border); border-radius: var(--r-ctl); font-family: var(--font-mono); }

/* ================= 走带：一组分段键 =================
   运动四键（反播 / 步退 / 播放 / 步进）｜此刻：组间分隔线加深一档。跳到指定时刻在读数面板头上（点读数块） */
.tl .stg { display: inline-flex; align-items: stretch; height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; flex: none; }
.tl .stg .st { display: inline-flex; align-items: center; justify-content: center; width: 24px; padding: 0; border: 0; background: transparent; font: inherit; font-size: var(--fs-2); border-radius: 0; cursor: pointer; color: var(--text-muted); line-height: 1; white-space: nowrap; user-select: none; transition: var(--t-state); }
.tl .stg .st + .st { border-left: 1px solid var(--border); }
.tl .stg .st.play { width: 30px; color: var(--text); }
.tl .stg .st.now { width: auto; padding: 0 8px; color: var(--text); border-left-color: var(--border-strong); }
.tl .stg .st:hover { background: var(--wash-hover); color: var(--text); }
.tl .stg .st.act { color: var(--accent); background: var(--accent-ui-weak); }
.tl .stg .st.act:hover { background: color-mix(in srgb, var(--accent-ui) 22%, transparent); color: var(--text); }
.tl .stg .st:disabled, .tl .stg .st.dis { color: var(--text-faint); background: transparent; cursor: default; }
.tl .stg .st:focus-visible, .tl .live-btn:focus-visible { outline-offset: -2px; }
.tl .stg .app-icon { display: block; }

/* ================= 窄容器降级 =================
   两层以后尺子独占整行，窄档只为「控件层放得下」：阈值 = 上一档控件层的实测所需宽 + 8。
   所需宽按最宽的一档量：英文界面 + Verdana（西文里最宽，读数列宽也随界面字体变宽）——上一档所需 723.9 / 648.3 / 555.7 / 485.7 / 443.3。
   让位次序：收紧间距 / 走带键 / 读数 13px → 三个栏名（口径仍在各自 title）→ 跨度整格（滚轮照样缩放）→ 实时键只留指示灯 → 间距 / 走带键再收一档。
   （跳到时刻并进读数面板后走带组少一枚 24px 键，首档由 756 降到 732，原「藏跳到时刻」一档 678 取消，其后各档不变）
   走带五键、步长 / 倍速、读数四格、刻度尺任何档位都在。实测每档阈值 +1px 处右缘不溢出（中 / 英、出厂字体 / Verdana）。 */
@container (max-width: 732px) {
  .tl-ruler { padding-inline: 8px; }
  .tl-row { column-gap: 10px; padding-inline: 8px; }
  .tl-grp { gap: 6px; }
  .tl-grp.c { gap: 8px; }
  .tl .stg .st { width: 21px; }
  .tl .stg .st.play { width: 26px; }
  .tl .stg .st.now { width: auto; padding: 0 5px; }
  .tl .clkg { gap: 3px; }
  .tl .ckl { font-size: var(--fs-1); }
  .tl .cksel + .ckl { margin-left: 4px; }
  .tl .cksel { padding-left: 4px; }
  .tl .cksel.wsel { width: 64px; }
  .tl .cksel.ssel { min-width: 46px; }
  .tl .cksel.xsel { min-width: 66px; }
  .tlab2 { --ro-fs: var(--fs-4); column-gap: 6px; padding: 2px 4px; margin: -2px -4px; }   /* 罩 4 + 环 1 < 组距 8 */
}
@container (max-width: 657px) { .tl .ckl { display: none; } }
@container (max-width: 564px) { .tl .wspan { display: none; } }
@container (max-width: 494px) {
  .tl-ruler { padding-inline: 6px; }
  .tl-row { column-gap: 6px; padding-inline: 6px; }
  .tl-grp, .tl-grp.c { gap: 5px; }
  .tlab2 { padding: 2px 2px; margin: -2px -2px; }   /* 罩 2 + 环 1 < 组距 5 */
  .tl .tb-t.tiny { display: none; }
  .tl .live-btn { width: var(--h-ctl); padding: 0; justify-content: center; font-size: 0; gap: 0; }
}
/* 可见性分析侧栏拉到 560 时条宽可到 424（1024 窗口）：494 档最宽需 443.3（英文 + Verdana）→ 再收一档（阈值 = 443.3 + 8） */
@container (max-width: 452px) {
  .tl-ruler { padding-inline: 4px; }
  .tl-row { column-gap: 4px; padding-inline: 4px; }
  .tl-grp, .tl-grp.c { gap: 4px; }   /* 罩 2 + 环 1 < 组距 4 */
  .tl .stg .st { width: 19px; }
  .tl .stg .st.play { width: 23px; }
  .tl .stg .st.now { padding: 0 3px; }
  .tlab2 { column-gap: 4px; }
}
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-size: var(--fs-3); }
.mini.on { color: var(--text); border-color: var(--accent); }
.body { flex: 1; min-height: 0; display: flex; }
.stage-wrap { flex: 1; min-width: 0; position: relative; }
.stage { width: 100%; height: 100%; background: #070b12; }
/* 3D canvas 尺寸完全交给 CSS（renderer.setSize 已传 updateStyle=false 不写内联 px），
   渲染分辨率与布局解耦，避免内联像素值参与布局形成 resize 振荡 */
.stage :deep(canvas) { width: 100%; height: 100%; display: block; }
/* 首帧淡入（revealStage）：每次挂载一次，之后画布上没有任何过渡；减弱动效由全局守卫归零 */
.stage-wrap:not(.shown) .stage :deep(canvas) { opacity: 0; }
.stage-wrap.shown .stage :deep(canvas) { transition: opacity var(--dur-3) var(--ease-out); }
/* 平面图画布：首帧画完（flatPainted）才显形并接指针，之前露的是底下的球而不是一块藏青；2D→3D 瞬时 */
.flat { position: absolute; inset: 0; width: 100%; height: 100%; background: #070b12; opacity: 0; pointer-events: none; }
.flat.rdy { opacity: 1; pointer-events: auto; transition: opacity var(--dur-2) var(--ease-out); }
/* 聚焦卫星图例（左下，3D/2D 共用）：色条对应地图上实际绘制的覆盖范围线与星下点轨迹线 */
.focus-legend {
  position: absolute; left: 14px; bottom: 10px; display: flex; flex-direction: column; gap: 5px;
  /* 实底不毛玻璃：背景模糊压在逐帧重绘的画布上，每帧都要把底下的像素重新模糊一遍 */
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-float); padding: 7px 10px; font-size: var(--fs-2); color: var(--text-muted); pointer-events: none;
}
.fl-row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
/* 颜色/线型由 fpSwStyle / trkSwStyle 行内给（跟着显示设置走），这里只留几何 */
.fl-sw { width: 18px; height: 0; border-top: 2px solid; flex: none; }
/* 轨迹面档：色条是一条带 —— 上下两缘按线样式，带内颜色由 trkSwStyle 行内给 */
.fl-sw.band { height: 7px; border-top-width: 1.5px; border-bottom: 1.5px solid; }
/* 旧浮动信息卡的样式已随卡片删除；下面三条留着 —— 别处的列表还继承它们：
   卫星组管理器的 .cn（衬线 15px）、地图设置 / 标记视图的 .mlist > .mrow（悬停底色与指针） */
.cn { flex: 1 1 auto; min-width: 0; font-family: var(--font-serif); font-size: var(--fs-5); line-height: 1.3; overflow-wrap: anywhere; }
/* 左边原是 3px 透明边 + 6px 内距：盒子左侧开口。改 1px 实边 + 8px 内距，内容 x 不变；选中的 2px 竖条 = 边 + 1px 内阴影 */
.mrow { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border: 1px solid var(--border); border-left-width: 1px; padding-left: 8px; cursor: pointer; }
.mrow:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
.mrow.active { border-left-color: var(--accent-ui); box-shadow: inset 1px 0 0 var(--accent-ui); background: var(--accent-ui-weak); }

/* ===== 右侧「卫星信息栏」（地图右侧、时间轴之上）=====
   停靠面板不是浮卡：无圆角、无投影、无开合动画（过渡期间每帧都会 resize 画布）。
   栏及其祖先禁 transform / filter / backdrop-filter / contain / container-type / will-change：
   「＋」天线菜单与右键菜单是 position:fixed，任何一条都会给它们造新的包含块（裁掉 / 错位）。 */
/* 分隔条：镜像 App.vue 的 .vsplit —— 命中 5px、负外边距吃回净宽 0；悬停 150ms 后淡入细线，拖动中机位色 */
.rdk-split { position: relative; width: 5px; margin: 0 -2px 0 -3px; cursor: col-resize; flex: none; z-index: 5; }
.rdk-split::after { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: var(--border-strong); opacity: 0; transition: opacity var(--dur-2) linear; }
.rdk-split:hover::after { opacity: 1; transition-delay: .15s; }
.rdk-split.on::after { opacity: 1; background: var(--accent-ui); transition: none; }
.g3.rdk-drag .stage-wrap { pointer-events: none; }   /* 拖分隔条：画布不接指针（不刷光标经纬度、松手不被当成点选） */

.rdk {
  --rdk-pl: 14px;            /* 左内距（文字起跑线） */
  --rdk-pr: 4px;             /* 滚动体右内距；加常驻滚动槽 ≈ 视觉 14px，与左对称 */
  --rdk-uw: 30px;            /* 单位列：°N / km/s / 圈/日 / dBi 的最宽者 */
  --rdk-kw: 36px;            /* 聚焦集「区制」列 */
  --rdk-hw: 54px;            /* 聚焦集「高度 km」列 */
  --rdk-lw: 5em;             /* 标签列下限：中文五字（升交点赤经）；英文见下 */
  /* 地图保底 480：只钳显示值，不改存下的宽度（窗口放大后自动回到用户设的宽） */
  flex: none; width: clamp(240px, calc(100% - 480px), var(--rdk-w, 300px));
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
  background: var(--surface); border-left: 1px solid var(--border);
  font-size: var(--fs-3); color: var(--text);
}
html[lang="en"] .rdk { --rdk-uw: 44px; --rdk-kw: 46px; --rdk-hw: 66px; --rdk-lw: 9.5em; }

/* 栏头：逐值照抄 App.vue .dock-hd / .dock-tt / .dock-x（换前缀，值不变） */
.rdk-hd { display: flex; align-items: center; gap: 2px; height: 26px; padding: 0 5px 0 11px; flex: none; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.rdk-tt { flex: 1; min-width: 0; font-size: var(--fs-3); font-weight: 600; letter-spacing: var(--ls-label); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rdk-ib { width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; border-radius: var(--r-ctl); transition: var(--t-state); }
.rdk-ib:hover { background: var(--border); color: var(--text); }
.rdk-ib:active { box-shadow: var(--press); transition-duration: 0s; }
.rdk-ib.on { color: var(--accent-ui); background: var(--accent-ui-weak); }
.rdk-ib.on:hover { color: var(--accent-ui); background: color-mix(in srgb, var(--accent-ui) 22%, transparent); }
.rdk-ib.dis, .rdk-ib.dis:hover { background: transparent; color: var(--text-faint); opacity: .45; cursor: default; box-shadow: none; }
.rdk-vr { width: 1px; height: 12px; margin: 0 4px; flex: none; background: color-mix(in srgb, var(--border-strong) 50%, var(--border)); }

/* 描边文字钮（取消聚焦 / 全部取消）：与左栏栏脚「清除绘图」.cclr 同形，与栏头 × 形态、位置都分开 */
.rdk-btn { flex: none; height: 20px; padding: 0 8px; display: inline-flex; align-items: center; font-size: var(--fs-3); font-weight: 400; line-height: 1; color: var(--text-muted); white-space: nowrap; border: 1px solid var(--border); cursor: pointer; transition: var(--t-state); }
.rdk-btn:hover { border-color: var(--line-hover); color: var(--text); }
.rdk-btn:active { box-shadow: var(--press); transition-duration: 0s; }

/* 钉住区：聚焦集 + 对象身份（不随滚动） */
.rdk-top { flex: none; border-bottom: 1px solid var(--border); }
.rdk-set { padding: 0 var(--rdk-pl) 10px; border-bottom: 1px solid var(--border); }
.rdk-set.shut { padding-bottom: 0; }
.rdk-id { padding: 9px var(--rdk-pl) 10px; }
.rdk-nr { display: flex; align-items: flex-start; gap: 8px; }
.rdk-nm { flex: 1; min-width: 0; font-family: var(--font-serif); font-size: var(--fs-5); line-height: 20px; color: var(--text); overflow-wrap: anywhere; text-wrap: balance; }
.rdk-no { flex: none; margin-top: 2px; font-size: var(--fs-2); font-weight: 700; line-height: 16px; padding: 0 5px; border-radius: var(--r-ctl); background: var(--accent-ui); color: var(--bg); font-variant-numeric: tabular-nums; }
.rdk-meta { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.rdk-bdg { font-size: var(--fs-2); line-height: 16px; padding: 0 5px; white-space: nowrap; border: 1px solid var(--border-strong); color: var(--text); font-variant-numeric: tabular-nums; }
.rdk-bdg b { font-weight: 400; color: var(--text-faint); margin-right: 4px; }
.rdk-bdg.kind { border-color: var(--text-muted); }
/* 定点：全栏唯一的暖色，只有 GEO 星才出现 */
.rdk-bdg.geo { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 60%, transparent); }
.rdk-bdg.geo b { color: color-mix(in srgb, var(--warn) 75%, var(--surface)); }
.rdk-bdg.cp { cursor: copy; transition: border-color var(--dur-1) linear; }
.rdk-bdg.cp:hover { border-color: var(--line-hover); }
.rdk-bdg.cp.ok { border-color: var(--ok); }

/* 节头：chevron + 节名 + 行尾动作 / 读数；整行 28px 热区（与左栏 .sect.acc 同一手感，节名重一档：正文标签是 muted，节头靠字重跳出） */
.rdk-sh { position: relative; isolation: isolate; display: flex; align-items: center; gap: 5px; height: 28px; color: var(--text); cursor: pointer; user-select: none; }
.rdk-sh::before { content: ''; position: absolute; inset: 3px -6px; z-index: -1; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.rdk-sh:hover::before { background: color-mix(in srgb, var(--text) 5%, transparent); }
.rdk-sh:has(.rdk-sa:hover)::before { background: transparent; }
.rdk-sh > .disc { flex: none; color: var(--text-faint); }
.rdk-sh:hover > .disc { color: var(--text-muted); }
.rdk-st { font-weight: 600; white-space: nowrap; }
.rdk-st b { font-weight: 600; font-variant-numeric: tabular-nums; margin-right: 3px; }
.rdk-ok { display: inline-flex; color: var(--text-faint); }
.rdk-ok.ok { color: var(--ok); }
.rdk-st + .rdk-ok { margin-left: 2px; }
.rdk-sa { margin-left: auto; display: flex; align-items: center; gap: 2px; }
.rdk-sa .rdk-ib { margin-right: -3px; }          /* 18px 框里 12px 字形：外移 3px，字形右沿对齐内容右沿 */
.rdk-sa .rdk-ib:hover { background: var(--wash-hover); }
.rdk-ts { margin-left: auto; font-size: var(--fs-2); color: var(--text-faint); font-weight: 400; font-variant-numeric: tabular-nums; white-space: nowrap; }
.rdk-lnk { color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.rdk-lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }

/* 滚动体与分节：节头吸顶（1280 窗滚动长节时节名始终可见） */
.rdk-bd { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
.rdk-sec { padding: 0 var(--rdk-pr) 9px var(--rdk-pl); }
.rdk-sec + .rdk-sec { border-top: 1px solid var(--border); }
.rdk-bd .rdk-sh { position: sticky; top: 0; z-index: 2; background: var(--surface); margin: 0 calc(-1 * var(--rdk-pr)) 0 calc(-1 * var(--rdk-pl)); padding: 0 var(--rdk-pr) 0 var(--rdk-pl); }
.rdk-bd .rdk-sh::before { inset: 3px calc(var(--rdk-pr) - 6px) 3px calc(var(--rdk-pl) - 6px); }
.rdk-sec:has(> .rdk-sh:only-child) { padding-bottom: 0; }   /* 折叠态：只剩节头 */

/* 读数格：一节一张网格，行走 subgrid —— 标签 | 符号 | 数值（右齐 tabular）| 单位（定宽）；
   数字右沿 = 内容右沿 − 单位列，跨节恒齐（天线 dBi 也对在这条线上）；组间点线是跨四列的网格项 */
.rdk-kv { display: grid; grid-template-columns: minmax(min(var(--rdk-lw), 42%), auto) auto minmax(min-content, 1fr) var(--rdk-uw); }
.rdk-kv.nosym { grid-template-columns: max-content 0 minmax(min-content, 1fr) var(--rdk-uw); }   /* 模型节：标签只取内容宽，让位给文本值 */
.rdk-kv.nosym .rdk-s { padding: 0; }
.rdk-r { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: baseline; }
.rdk-k { color: var(--text-muted); line-height: 16px; padding-block: 3px; }
.rdk-k .tz { font-style: normal; font-size: var(--fs-2); color: var(--text-faint); margin-left: 5px; white-space: nowrap; }   /* 历元的时区角标挂标签后 */
.rdk-s { font-family: var(--font-serif); font-style: italic; font-size: var(--fs-4); line-height: 16px; padding: 3px 0 3px 8px; color: var(--text); }
.rdk-v { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: var(--ls-tight); white-space: nowrap; line-height: 16px; padding: 3px 0 3px 12px; user-select: text; }
.rdk-v i { font-style: normal; font-size: var(--fs-2); color: var(--text-faint); margin: 0 2px 0 3px; }
.rdk-v .rdk-v2 { margin-left: 3px; }
.rdk-u { font-size: var(--fs-2); color: var(--text-faint); line-height: 16px; padding: 3px 0 3px 4px; white-space: nowrap; }
.rdk-v.dt { grid-column: 2 / 4; white-space: normal; padding-left: 6px; letter-spacing: 0; }   /* 历元：日期、时刻各自不断，只在两者之间折 */
.rdk-v.dt > span { white-space: nowrap; }
.rdk-v.txt { grid-column: 2 / 4; justify-self: end; max-width: 100%; text-align: left; white-space: normal; overflow-wrap: anywhere; letter-spacing: 0; }
.rdk-hr { grid-column: 1 / -1; height: 0; margin: 3px 0; border-top: 1px dotted var(--border-strong); opacity: .7; }

/* 天线：勾选格 22×22 | 名称 | 峰值 | dBi（峰值右沿 = 读数右沿） */
.rdk-ants { display: grid; grid-template-columns: 22px minmax(0, 1fr) max-content var(--rdk-uw); }
.rdk-ar { position: relative; display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: start; }
.rdk-ck { width: 22px; height: 22px; margin-left: -4px; display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-ctl); cursor: pointer; }
.rdk-ck:hover { background: var(--wash-hover); }
.rdk-an { min-width: 0; padding: 3px 0 3px 3px; line-height: 16px; color: var(--text); cursor: pointer; overflow-wrap: anywhere; }
.rdk-an:hover { text-decoration: underline; text-underline-offset: 2px; }
.rdk-an em { display: inline-block; max-width: 100%; overflow-wrap: anywhere; font-style: normal; font-weight: 400; margin-left: 5px; font-size: var(--fs-2); color: var(--text-faint); }
.rdk-ar.foc .rdk-an { color: var(--accent-ui); font-weight: 600; }
.rdk-ar.foc::before { content: ''; position: absolute; left: -9px; top: 4px; height: 14px; width: 2px; background: var(--accent-ui); }
.rdk-none { color: var(--text-faint); line-height: 22px; }

/* 聚焦集（≥2 颗）：列头 20px 吸顶 + 22px 单行；主选只把序号格铺实底（当前行标识），× 常显淡色 */
/* 限高 = 表头 20 + 8 行 + 上下 1px 边框（border-box 下边框吃在限高里，不加这 2px 恰 8 颗时会出一条滚 2px 的滚动条）；
   scroll-padding-top = 表头高：键盘 ↑ / Home 换主选时 scrollIntoView 不把行滚到吸顶表头底下 */
.rdk-list { display: grid; grid-template-columns: 26px minmax(0, 1fr) var(--rdk-kw) var(--rdk-hw) 20px; max-height: calc(20px + 22px * 8 + 2px); overflow-y: auto; overflow-x: hidden; scroll-padding-top: 20px; border: 1px solid var(--border-strong); background: var(--bg); }
.rdk.narrow .rdk-list { grid-template-columns: 26px minmax(0, 1fr) var(--rdk-hw) 20px; }
.rdk.narrow .rdk-list .kd { display: none; }
.rdk-lr { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; height: 22px; border-top: 1px solid var(--border); cursor: pointer; transition: background-color var(--dur-1) linear; }
.rdk-lh { position: sticky; top: 0; z-index: 1; height: 20px; border-top: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); cursor: default; font-size: var(--fs-2); color: var(--text-muted); }
.rdk-lh + .rdk-lr { border-top: 0; }
.rdk-lr:not(.rdk-lh):hover { background: var(--wash-hover); }
.rdk-lr > span { min-width: 0; white-space: nowrap; }
.rdk-lr .no { align-self: stretch; display: flex; align-items: center; justify-content: center; border-right: 1px solid var(--border); font-size: var(--fs-1); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.rdk-lr.pri .no { background: var(--accent-ui); border-right-color: var(--accent-ui); color: var(--bg); font-weight: 700; }
.rdk-lr .nm { display: flex; padding-left: 7px; color: var(--text); }
.rdk-lh .nm { color: var(--text-muted); }
.rdk-lr .nm .h { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.rdk-lr .nm .t { flex: none; }
.rdk-lr .kd { padding-left: 6px; font-size: var(--fs-2); color: var(--text-muted); }
.rdk-lr .al { text-align: right; padding-right: 2px; font-variant-numeric: tabular-nums; color: var(--text); }
.rdk-lh .al { color: var(--text-muted); }
.rdk-lh .al i { font-style: normal; color: var(--text-faint); margin-left: 3px; }
.rdk-lr .x { justify-self: center; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); opacity: .6; border-radius: var(--r-ctl); cursor: pointer; }
.rdk-lr:hover .x { opacity: 1; }
.rdk-lr .x:hover { color: var(--danger); background: var(--wash-hover); }
.rdk-list:focus-visible { outline-offset: -2px; }

/* 空态：一句陈述 */
.rdk-empty { padding: 11px var(--rdk-pl); color: var(--text-faint); }
/* 覆盖圈口径行的锁（聚焦卫星面板）：锁住后超出该星上限也不回写截断值 */
.covlock { cursor: pointer; display: inline-flex; align-items: center; color: var(--text-faint); transition: color .12s ease; }
.covlock:hover { color: var(--text-muted); }
.covlock.on { color: var(--accent); }

/* 覆盖图：右侧停靠面板（挤压地球，独占右栏） */
/* 右侧边栏：与「设置弹窗」一致——surface 底色、统一表头/分区内边距与标题字号 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: var(--fs-3); }

/* ===== 侧栏视图（Teleport 到 App.vue #side-view；活动栏切换，同屏只显示一个） ===== */
.sview { display: flex; flex-direction: column; min-height: 0; }
/* 星座视图工具块：卫星搜索 + 旋转/实时开关 + 在轨/OMM 状态行 */
/* 搜索筛选状态条（确认感：小圆点 + 词 + 清除，克制不卡通） */
/* 「存为组」按钮：吃掉右推空间（清除紧随其后，故取消清除自身的 auto） */
/* 「发送到小程序」是动作不是开关（旁边两个是开关），故用强调色描边区分；字更长，多占一份宽度 */
/* 星座分组列表（grprow 而非 pgrow：后者是 GXT 逐档色行的既有类名，避免撞名） */
/* 星点颜色：小色块（覆盖原生取色器）+ 悬停复位×（仅有覆盖色时出现） */
/* .pgclr/.pgsw/.pgrst 是通用件：内置分组行 / 卫星组行 / 组管理器（着色区、成员行）共用 */
.pgclr { position: relative; flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.pgclr input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.pgsw { width: 11px; height: 11px; border-radius: var(--r-box); box-sizing: border-box; border: 1px solid rgba(0,0,0,.3); box-shadow: 0 0 0 1px rgba(255,255,255,.35); }
/* 未设置=斜线空块（随所属星座）；inh=随组色（成员行虚线描边，与单独色区分） */
.pgsw.unset { background: linear-gradient(135deg, transparent 44%, var(--text-faint) 44%, var(--text-faint) 56%, transparent 56%); box-shadow: none; border-color: var(--text-faint); }
.pgsw.inh { box-shadow: none; border: 1px dashed rgba(0,0,0,.45); }
/* 行首展开箭头（内置组 / 卫星组 / 自定义星座 三处同一枚）：只管展开卫星列表，与行本身的点击语义分开 */
/* 「加入组」弹出菜单：fixed 锚在操作条按钮下沿（侧栏祖先无 transform，不会被 overflow 裁掉） */
.lmenu-bd { position: fixed; inset: 0; z-index: 2190; }
/* 命令菜单口径：外框内距 3px、项圆角与外框同心（6 − 3 = 3）、机位色实底悬停；项左右内距各减 3px，文字 x 不动 */
.lmenu { position: fixed; z-index: 2200; width: 200px; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); padding: 3px; border-radius: var(--r-float); animation: ui-float-in var(--dur-2) var(--ease-out); }
.lmh { margin: -3px -3px 3px; padding: 3px 10px 5px; font-size: var(--fs-1); color: var(--text-faint); border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.lmi { display: flex; align-items: center; gap: 7px; padding: 4px 7px; font-size: var(--fs-3); color: var(--text); cursor: pointer; border-radius: var(--r-box); }
.lmi > svg { flex: none; color: var(--text-muted); }
.lmi:hover { background: var(--accent-ui); color: var(--bg); }
.lmi:hover > svg, .lmi:hover em { color: inherit; }
.lmi > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmi > em { flex: none; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lmi.new { color: var(--accent); border-bottom: 1px solid var(--border); }
.lmi.new:hover { color: var(--bg); }          /* 必须写在 .lmi.new 之后，否则「新建组」蓝底墨字 */
/* 「＋」新建天线菜单（卫星行 / 信息卡）：条目少，宽度随内容 */
.lmenu.antm { width: auto; min-width: 150px; }
/* 行右键菜单（内置星座 / 卫星组 / 自定义星座三类行共用）：与 .lmenu 同一层级与视觉，条目带图标 */
/* 自定义星座（仿 STK Walker 生成器）：侧栏区 + 列表 */
/* 拖文件进「导入星历」区块 / 地图时的描边高亮（token 色，不出提示字） */
.sview.dragon { outline: 1px dashed var(--accent-ui); outline-offset: -2px; background: var(--accent-ui-wash); }
/* 向导预览区：三个图层拨杆一行排开 */
.cepv { display: flex; flex-wrap: wrap; gap: 6px 14px; padding: 2px 12px 6px; }
/* 一个拨杆 + 一行名字；名字整行换行、不缩、不裁（侧栏不许显示不全） */
.cepv .pvsw { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.cef.ceset { margin-top: 2px; }
.cef.ceset .lnk { color: var(--accent); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-3); }
.cef.ceset .lnk:hover { text-decoration: underline; }
/* 解不出来的那一项：红框（诊断文字在读数区的 .crwarn 里） */
.cebody .ci.bad, .cebody .ci.bad input { border-color: var(--danger, #c0392b) !important; }
/* 地图上的放置高亮：墨色虚线压在深色球面上读不出，改机位色提亮一档 + 整幅淡罩（只在拖入期间存在，不吃指针） */
.stage-wrap.dragon { outline: 2px dashed color-mix(in srgb, var(--accent-ui) 55%, #fff); outline-offset: -6px; }
.stage-wrap.dragon::after { content: ''; position: absolute; inset: 0; z-index: 5; pointer-events: none; background: var(--accent-ui-weak); }
/* 卫星组：段头计数 + 新建/管理入口 + 行内重命名输入 + 删除确认高亮 */
/* 向导：预设条 + 汇总 */
.ccpreset { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0; }
.ccpz { border: 1px solid var(--border); color: var(--text-muted); padding: 2px 7px; font-size: var(--fs-2); cursor: pointer; border-radius: var(--r-box); }
.ccpz:hover { border-color: var(--line-hover); color: var(--text); }
.ccsum { margin-top: 10px; padding: 7px 9px; background: var(--surface-2); font-size: var(--fs-3); color: var(--text-muted); }
/* 内联生成/编辑面板（停靠式，地图保持可见 + 实时预览）；短标签左置、长标签上置，避免截断 */
.sview.editing { flex: 1; min-height: 0; }
.cedit { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cehd { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; }
.cehd .ceback { display: inline-flex; align-items: center; gap: 1px; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); }
.cehd .ceback:hover { color: var(--text); }
.cehd .cetitle { font-size: var(--fs-4); color: var(--text); font-weight: 600; }
.cehd .cesolo { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.cehd .celive { flex: none; font-size: var(--fs-1); color: var(--accent); letter-spacing: var(--ls-tight); }
.cebody { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.cesec { margin: 13px 0 8px; padding-top: 9px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-2); }
.cef { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cef > label { width: 68px; flex: none; color: var(--text-muted); font-size: var(--fs-3); }
.cef > .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
.cef > .u { flex: none; width: 16px; color: var(--text-muted); font-size: var(--fs-2); }
.cef > .clr { flex: 1; height: var(--h-ctl); }
.cefv { margin-bottom: 8px; }
.cefv > label { display: block; color: var(--text-muted); font-size: var(--fs-3); margin-bottom: 3px; }
.cefv .ceinp { display: flex; align-items: center; gap: 6px; }
.cefv .ceinp > .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
.cefv .ceinp > .u { flex: none; min-width: 18px; color: var(--text-muted); font-size: var(--fs-2); }   /* 单位列定宽：°、km、圈、空位的输入框右缘对齐 */
.cetpf { display: flex; gap: 8px; margin-bottom: 8px; }
.cetpf > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cetpf small { color: var(--text-muted); font-size: var(--fs-2); }
.cetpf .ci { width: 100%; box-sizing: border-box; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
/* 向导分段：与侧栏 .seg 同一种几何（连体外框 + 段间细线、--h-ctl 高、选中 --sel-fill、选中切换瞬时） */
/* 高度用 min-height + 段内 padding/line-height 撑（单行 16+4+2=22）：段名折行时整排长高，不被 overflow 裁掉 */
.seg3 { display: flex; flex: 1; min-height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.seg3 > span { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2px 4px; line-height: 16px; text-align: center; border: 0; cursor: pointer;
               font-size: var(--fs-3); color: var(--text-muted); transition: var(--t-state); }
.seg3 > span + span { border-left: 1px solid var(--border); }
.seg3 > span:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg3 > span:active:not(.on) { box-shadow: var(--press); transition-duration: 0s; }
.seg3 > span.on { background: var(--sel-fill); color: var(--sel-on); transition-duration: 0s; }
.seg3 > span.on, .seg3 > span.on + span { border-left-color: transparent; }
.ceread { margin-top: 13px; padding: 8px 10px; background: var(--surface-2); }
.ceread .crcode { color: var(--accent); font-weight: 600; font-size: var(--fs-4); font-variant-numeric: tabular-nums; }
.ceread .crsub { color: var(--text-muted); font-size: var(--fs-2); margin-top: 3px; line-height: 1.5; }
.ceread .crwarn { color: var(--warn); font-size: var(--fs-2); margin-top: 4px; line-height: 1.5; }
.cefoot { display: flex; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border); flex: none; }
/* 向导头尾钉住：侧栏整体滚动时「返回」与「生成 / 取消」始终够得着。页脚按钮落 --h-ctl-lg 主操作档；主按钮保持墨色（primary token） */
.cehd { position: sticky; top: 0; z-index: 2; background: var(--surface); }
.cefoot { position: sticky; bottom: 0; z-index: 2; background: var(--surface); }
.cefoot .cancel { margin-left: auto; display: inline-flex; align-items: center; height: var(--h-ctl-lg); box-sizing: border-box; padding: 0 14px;
                  border: 1px solid var(--border-strong); border-radius: var(--r-ctl); background: var(--bg); color: var(--text);
                  cursor: pointer; font-size: var(--fs-3); transition: var(--t-state); }
.cefoot .cancel:hover { border-color: var(--line-hover); }
.cefoot .save { display: inline-flex; align-items: center; height: var(--h-ctl-lg); box-sizing: border-box; padding: 0 18px;
                border: 1px solid var(--primary-fill); border-radius: var(--r-ctl); background: var(--primary-fill); color: var(--primary-on);
                cursor: pointer; font-size: var(--fs-3); transition: var(--t-state); }
.cefoot .save:hover { background: var(--primary-fill-hover); border-color: var(--primary-fill-hover); }
.cefoot .cancel:active, .cefoot .save:active { box-shadow: var(--press); transition-duration: 0s; }
/* 面板停靠形态：占满侧栏宽度、去左缘边框，滚动交给侧栏整体 */
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.csh { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: var(--fs-5); padding: 11px 16px; align-self: center; }
.flatbtn { align-self: center; margin-left: 10px; flex: none; border: 1px solid var(--border); padding: 2px 9px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; }
.flatbtn:hover { border-color: var(--line-hover); color: var(--text); }
.flatbtn.on { background: var(--sel-fill); color: var(--sel-on); border-color: var(--sel-fill); }
/* 关闭按钮：与「文件管理」一致——Windows 风矩形热区，悬停变红 */
.winx { width: 44px; margin-left: auto; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s; }
.winx:hover { background: #c42b1c; color: #fff; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
/* —— 竖向节奏：与 GrdSetSections.vue / SatCovPanel.vue 同一结果 ——
   相邻两件恒 8px、小标题上方拉开 12 下方收紧 6。那两处的 .sec 里只有这套通用行，故它们直接
   写成 `.sec > * + *` 三条；本页的 .sec 还装着波束合成 / 可见性分析那些自带间距的块
   （.bs-* / .vis-*，2~7px 逐块调过），一刀切会把它们全撑到 8px，故这里把间距挂回通用行自身
   —— 出来的行距一致，作用面只在通用行之间。改这一处必须三处对照。 */
/* ★ 换行与「标签列是下限不是定宽」两条口径在 styles/controls.css 的 .srow 里，四份副本同改。
   这里只重复必要的部分（本文件这份 scoped 副本特异度更高，不重复就压不住）。 */
.srow { --srow-lab: 70px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-bottom: 8px; }
.srow:last-child, .chk2:last-child { margin-bottom: 0; }
/* 勾选行的从属参数（透明度属于「显示等值线」、字号属于「显示波束名」…）：缩进 19px，标签正好
   落在父行文字的起跑线上（复选框 13 + gap 6）；标签列同步由 70 收到 51 —— 两者相加仍是 70，
   故控件列一动不动，三列网格不破。 */
.srow.sub { --srow-lab: 51px; padding-left: 19px; }
.chk2.sub { padding-left: 19px; }   /* 从属勾选行（字号之后的「粗体」）：与 .srow.sub 同一缩进 */
/* 恒定「标签自占一行、控件铺满下一行」的行（分辨率 / 预设 / 常用这些四档以上的）。
   一般的行不必写它 —— .srow 本身可换行，装不下时分段控件会自己掉下来。 */
.srow.stack > label { width: 100%; margin-bottom: 4px; }
.srow.stack > .seg, .srow.stack > select { flex: 1 1 100%; }
/* 堆叠行的标签属于下面的控件：上方拉开到 12、标签与控件之间只留行内 4px 行距（原 4 + 4 离控件比离上一行还远） */
.sec > .srow + .srow.stack, .sec > .chk2 + .srow.stack { margin-top: 12px; }
.sec > .srow + .srow.stack > label, .sec > .chk2 + .srow.stack > label { margin-bottom: 0; }
/* 争议区那一组的名字最长五个字（北塞浦路斯），51px 只装得下四个 —— 单独放宽，全称挂 title */
.srow.sub.dsp { --srow-lab: 78px; padding-left: 12px; }
/* 标签列：min-width 是对齐用的下限，长标签自己撑开而不是被 ellipsis 切掉（英文里「Generatrix
   Transparency」一类比列宽长得多，切完连着五行长得一模一样）。列宽走 --srow-lab，
   英文下由 controls.css 的 html[lang="en"] 抬高一档。 */
.srow label { color: var(--text-muted); min-width: var(--srow-lab); max-width: 100%; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); outline: none; color: var(--text); }
/* 下拉框的可读下限：挤到装不下最长选项时整件掉到下一行（.srow 可换行），而不是裁掉选项名 */
.srow select { min-width: 116px; }
/* 置灰但可读（SATSOFT 灰字镜像值）：faint 淡到读不出数，禁用态语义靠底色+虚线边框已足够 */
.srow .ci:disabled { background: var(--surface); color: var(--text-muted); cursor: not-allowed; border-style: dashed; }
/* 读数列：钉宽 + 右对齐 + 等宽数字。宽度随文字走（dB / ° / 0.56 / 5 各不同）时滑杆逐行长短
   不一，钉住之后所有滑杆等长。 */
.srow .u { flex: none; min-width: 34px; text-align: right; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 取色框后的色号读数：钉到最宽的小写 hex（约 47px，ch 随用户所选字体伸缩）——色条终点排成一条竖线，拖取色器时不再伸缩 */
.srow > .clr + .u { min-width: 7.5ch; }
/* 输入框后的尾随单位贴着值（仍占 34px 列，输入框右缘不动） */
.srow > .ci + .u:last-child { text-align: left; }
/* 行中分隔符（~、×、GHz、° 后面还跟着东西，如锁）收成自身宽，不占读数列 */
.srow > .ci + .u:not(:last-child) { min-width: 0; }
/* 分段控件：连体框 + 段间细线，选中段填墨。全库四处（主窗 / GRD 设置 / 壳层选择 / 对星窗口）
   原来各写各的——有的没圆角、有的没段间线、段内距 10 与 12 两种；此处收成一份口径，四处逐字一致。 */
/* 外框是按钮组的结构线（--border-strong，同 .btn），段间细线仍 --border；段高 16 + 2×2 + 2 = 22 = --h-ctl，
   另用 min-height 钉住：150% 缩放下 1px 边框只画 1 个设备像素，不钉就比同列的下拉框矮一像素。
   选中段走 --sel-fill：浅色下逐字节仍是墨，深色下压一档，不再是全屏最亮的近白块；选中切换瞬时 */
.seg { display: flex; box-sizing: border-box; min-height: var(--h-ctl); border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.seg .sg { padding: 2px 12px; line-height: 16px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: var(--t-state); }
.seg .sg + .sg { border-left: 1px solid var(--border); }
.seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg .sg:active:not(.on):not(.dis) { box-shadow: var(--press); transition-duration: 0s; }
.seg .sg.on { background: var(--sel-fill); color: var(--sel-on); transition-duration: 0s; }
/* 选中段是实底，两侧的分隔线压在墨块边上反而脏，去掉 */
.seg .sg.on, .seg .sg.on + .sg { border-left-color: transparent; }
/* 参考卫星：已选时那一格只显示名字（不可编辑），与输入框同高同框以免整行跳动 */
.srow .ci.ro { display: flex; align-items: center; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; cursor: default; }
/* 选星候选：贴在那一行下面的一小段列表，最多 12 条，超出滚动 */
.ref-list { max-height: 168px; overflow: auto; margin: -4px 0 8px; border: 1px solid var(--border); border-radius: var(--r-ctl); background: var(--surface); }
.ref-it { display: flex; align-items: center; gap: 8px; padding: 3px 8px; cursor: pointer; font-size: var(--fs-3); }
.ref-it:hover { background: var(--surface-2); }
.ref-it .rn { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.ref-it .ru { flex: none; color: var(--text-muted); font-variant-numeric: tabular-nums; }
/* 条件不成立的那一格（如没选中卫星时的「星下点」）：压暗并停掉点击，不从版面上消失 —— 一忽隐忽现按钮就会跳位 */
.seg .sg.dis, .seg .sg.dis:hover { color: var(--text-faint); opacity: .45; cursor: default; background: none; pointer-events: none; }
.nseg { font-size: var(--fs-3); }
.nseg .sg { padding: 2px 8px; }
/* 参数行里的分段控件：铺满它所在的那一行、段内等分；实在挤不下时段文字折行。
   连体件本身 nowrap 又不收缩，装不下时既不换行也不缩 —— 只会直接顶出侧栏被裁掉半个字
   （四条「线型」行的最后一档「点划线 / Dash-Dot」就是这么没的）。 */
.srow > .seg { flex: 1 1 auto; }
.srow > .seg > .sg { flex: 1 1 auto; text-align: center; padding-left: 4px; padding-right: 4px; white-space: normal; }
/* 层级：分区标题是墨色（不加粗），行尾动作（默认 / 表格 / 导入…）退一档浅灰，悬停才回墨 + 下划线；
   「调整位置」这类开关态动作点亮时走机位色 */
.sect { display: flex; align-items: center; margin: 12px 0 6px; color: var(--text); }
.sec > .sect:first-child { margin-top: 0; }
.sect .lnk { margin-left: auto; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); transition: color var(--dur-1) linear; }
.sect .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }   /* 与 SatCovPanel / GrdSetSections 同一手感 */
.sect .lnk.on { color: var(--accent-ui); font-weight: 600; text-decoration: none; }
/* 标记三节（点标记 / 地球站 / 轨迹）标题上的「表格」：批量表格是这三节的主入口，做成主题色小按钮（其余 .lnk 仍是灰字链接）；
   悬停转实底，实底上的字色走 var(--bg)（accent 实底控件的统一口径） */
.sect .lnk.tbl { display: inline-flex; align-items: center; gap: 3px; padding: 1px 7px; line-height: 16px; border-radius: var(--r-ctl);
  color: var(--accent-ui); font-weight: 600; background: color-mix(in srgb, var(--accent-ui) 13%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent-ui) 50%, transparent); transition: color var(--dur-1) linear, background-color var(--dur-1) linear; }
.sect .lnk.tbl:hover { color: var(--bg); background: var(--accent-ui); border-color: var(--accent-ui); text-decoration: none; }
.sect.acc .lnk .app-icon { color: inherit; }   /* 动作里的小图标跟字走，不吃 .sect.acc 给箭头的淡灰 */
/* 标记三节的标题行链子最多（表格 / 默认 / 调整位置 / ＋航行 / ＋飞行 + 拨杆）：侧栏拖窄时换行，
   不许把哪一个挤出视野（同 .srow 那条「整行可换行」的处置，见 sidebar-no-truncation） */
.mk-side .sect { flex-wrap: wrap; row-gap: 3px; }
/* 拨杆 .layersw 的画法在 styles/controls.css（设置窗也用同一件，只是大一号）；这里只放主窗的就位规则 */
/* 分区标题里的那颗：钉在行尾右对齐（与环境场开关条的拨杆落在同一条竖线上）。
   不能跟在分区名后面——「点标记/地球站/轨迹」名字不等长，拨杆会逐行左右错开。 */
/* 行尾动作靠右排成一列：只有第一个吃 auto 把整串推到右端，其后各隔 12px。
   原来每个 .lnk 都是 margin-left:auto —— 剩余空间被几个 auto 均分，「表格 / 默认 / 调整位置」在标题行里散开 */
.sect-layersw { margin-left: auto; }
.sect .lnk ~ .lnk, .sect .lnk ~ .sect-layersw { margin-left: 12px; }
.bsub .lnk ~ .lnk, .bsub .lnk ~ .cnt2 { margin-left: 12px; }
/* 一行一个图层开关：名字占满、拨杆贴右（与分区标题上的 .sect-layersw 同一手感，只是降一级） */
.swrow { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: var(--text); }
.swrow > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swrow.dis { color: var(--text-faint); }
.swrow.dis .layersw { opacity: .45; cursor: default; }
/* 图层关掉后分区体退到后景：参数照旧可改，只是当前不出图——因果落在同一屏里 */
.mk-side .sec > :not(.sect) { transition: opacity var(--dur-2) linear; }
.mk-side .sec.hid > :not(.sect) { opacity: .5; }
/* 天线设置区标题：撑满分区宽度的标题条（Blender Properties / VS Code 面板头同款），
   与其余 .sect 的纯文字小标题区分开，明确「以下均为当前聚焦天线的属性」 */
.setsect { margin: -12px -16px 10px; padding: 9px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.setsect .ant-svg { width: 14px; height: 14px; color: var(--accent); margin-right: 6px; }
.setsect .setlbl { color: var(--text); font-weight: 600; }
.setsect .setname { margin-left: 6px; color: var(--accent); font-weight: 600; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { max-height: 150px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 4px 6px; }
.chk { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.chk .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.empty { color: var(--text-faint); padding: 4px 0; }
.cnt { margin-top: 6px; color: var(--text-faint); font-size: var(--fs-3); }
.cnt .lnk2 { margin-left: 8px; color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; }
.chip { padding: 2px 7px; border: 1px solid var(--border); cursor: pointer; border-radius: var(--r-ctl); color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-2); }
.chip.on { color: var(--text); }
.chk2 { display: flex; align-items: center; gap: 6px; margin: 8px 0; cursor: pointer; }
/* 整行是 <label>、点字也能勾：悬停字的时候框也要给出同一档悬停反馈（与直接悬停框一致） */
.chk2:hover > input[type=checkbox]:not(:checked):not(:disabled), .chk-in:hover > input[type=checkbox]:not(:checked):not(:disabled) { border-color: var(--field-border-hover); }
.chk2:hover > input[type=checkbox]:checked:not(:disabled), .chk-in:hover > input[type=checkbox]:checked:not(:disabled) { background: var(--accent-ui-hover); border-color: var(--accent-ui-hover); }
.tip { color: var(--text-faint); font-size: var(--fs-2); margin-top: 4px; line-height: 1.5; }
.tip.warn { color: var(--warn, #d98a2b); }
/* 提示行贴着它说明的那一行（行距 8 收到 4），与下一行之间留回 8：归属一眼可辨 */
.sec > .srow + .tip, .sec > .chk2 + .tip { margin-top: -4px; }
.sec > .tip:not(:last-child) { margin-bottom: 8px; }
/* GRD 工程树：卫星 → 天线（二级层次，竖向引导线 + 统一缩进） */
.gtree { max-height: clamp(280px, 48vh, 620px); overflow-y: auto; }
/* 卫星行（节点头） */
.gsat { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 2px; color: var(--text); font-size: var(--fs-4); border-radius: var(--r-box); }
.gsat:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gsat .tri { font-style: normal; flex: none; width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: var(--fs-1); cursor: pointer; transition: transform .12s; }
.gsat .tri.open { transform: rotate(90deg); }
.gsat .gsname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; line-height: 1.3; cursor: pointer; }
.gsat .gsname:hover { color: var(--accent); }
.gsat .gsname em { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.gsat .gsname .simtag { font-style: normal; margin-left: 5px; padding: 0 4px; border: 1px solid var(--accent); border-radius: var(--r-ctl); color: var(--accent); font-size: var(--fs-1); vertical-align: middle; }
.gsvg { flex: none; width: 14px; height: 14px; }
.gsat .sat-svg { width: 18px; height: 18px; color: var(--text); opacity: .92; }   /* 跟随主题文字色；18px 比默认 .gsvg 大一档，14px 下看不出卫星轮廓 */
/* 星座选中集回显（cur）：左缘 2px 机位色竖条 + 星名转机位色；不铺底色 —— 与勾选（画不画）、天线行聚焦（.gant.foc 铺底）都分得开。
   SatCovPanel.vue 有同值副本，两处对照 */
.gsat.cur { box-shadow: inset 2px 0 0 var(--accent-ui); }
.gsat.cur .gsname { color: var(--accent-ui); }
/* 关联星不在当前星历：卫星行一枚告警（状态本身，说明在 title） */
.gsat .lmiss { flex: none; display: inline-flex; align-items: center; color: var(--warn); }
/* 卫星行显示开关（卫星名 / 仰角线）：图标按钮，与 .sacts 操作图标以竖线分组，语汇同 .gant .ant-btn（hover 底色淡入） */
.sdisp { flex: none; display: flex; align-items: center; gap: 1px; margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
.sdisp .ic { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: var(--r-box); color: var(--text-faint); opacity: .55; cursor: pointer; transition: opacity .12s, color .12s, background .12s; }
.sdisp .ic:hover { opacity: 1; color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.sdisp .ic.on { opacity: 1; color: var(--accent); }
/* 置灰（聚焦 / 跟随用不了：非关联星 / 关联星缺失 / 平面图）：不响应悬停，原因在 title */
.sdisp .ic.dis, .sdisp .ic.dis:hover { opacity: .22; color: var(--text-faint); background: none; cursor: default; }
.gant .ant-btn { display: flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px; margin: -2px 0; border-radius: var(--r-box); transition: background .12s; }
.gant .ant-btn:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.gant .ant-svg { width: 13px; height: 13px; color: var(--text-faint); transition: color .12s; }
.gant .ant-btn.on .ant-svg { color: var(--accent); }
.gant .ant-svg.ant-off { color: var(--text-faint); opacity: .7; }
.gant.foc .ant-svg { color: var(--accent); }
.gperf { display: flex; align-items: center; gap: 6px; margin: 0 0 2px 22px; padding: 2px 6px; color: var(--text-faint); cursor: pointer; font-size: var(--fs-2); border-radius: var(--r-box); transition: background .12s, color .12s; }
.gperf:hover { color: var(--text-muted); background: color-mix(in srgb, var(--text) 5%, transparent); }
.gperf .perf-svg { width: 12px; height: 12px; flex: none; }
.gperf .gperfn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gperf.on { color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.gperf.on .perf-svg { color: var(--accent); }
/* 行尾的眼睛（城市标记总开关）：与卫星行 .sdisp 同一件，贴右；负外边距抵掉 18px 的按钮高，行高不变 */
.gperf .sdisp { margin-left: auto; }
.gperf .sdisp .ic { margin: -2px 0; }

/* 性能指标表浮窗（几何由 JS 控制：可拖拽移动 / 右下角缩放 / 中缝分隔） */
.perf-win { position: absolute; left: 24px; top: 64px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-float); box-shadow: var(--shadow-3); z-index: 60; overflow: hidden; }
.perf-h { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; cursor: move; user-select: none; }
.perf-t { flex: 1; font-family: var(--font-serif); font-size: var(--fs-4); color: var(--text); }
.perf-t em { font-style: normal; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
.perf-h .csx { cursor: pointer; color: var(--text-faint); padding: 0 4px; position: relative; z-index: 5; }   /* 高于 NE 缩放角，保证可点关闭 */
.perf-h .csx:hover { color: var(--text); }
.ptb { font-size: var(--fs-3); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-card); padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.ptb:hover { color: var(--text); border-color: var(--line-hover); }
.ptb.add { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 55%, transparent); }
.ptb.dis { opacity: .38; pointer-events: none; }
.ptb.on { color: var(--accent); border-color: var(--accent); }
.perf-q { flex: 1; min-width: 110px; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 8px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; }
.perf-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; }

/* —— 波束合成（独立侧栏视图；SATSOFT Gaussian Beam Model / Polygon 赋形） —— */
.bs-side .tip b { color: var(--text-muted); font-weight: 600; }
.bs-tabs { display: flex; width: 100%; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.bs-tab { flex: 1; text-align: center; padding: 4px 0; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; user-select: none; }
.bs-tab + .bs-tab { border-left: 1px solid var(--border); }
.bs-tab:hover { color: var(--text); }
.bs-tab.on { background: var(--sel-fill); color: var(--sel-on); }
.bs-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
/* 标题行尾读数贴右、长了省略号收边（同 .vis-cnt），不许换行把标题行撑成两行 */
/* 标题读数贴右；长设置名放不下就在读数内折行，不截断（侧栏不许显示不全） */
.sect .bs-cnt { margin-left: auto; padding-left: 8px; min-width: 0; text-align: right; overflow-wrap: anywhere; }
.bs-plist { display: flex; flex-direction: column; gap: 1px; max-height: 172px; overflow-y: auto; margin: 4px 0 2px; padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-ctl); }
.bs-plist .chk2 { margin: 0; padding: 2px 0; }
.bs-read { display: flex; gap: 12px; flex-wrap: wrap; font-size: var(--fs-2); color: var(--text-muted); margin: 5px 0 2px; font-family: var(--font-mono); }
.bs-read b { color: var(--accent); font-weight: 600; }
/* 天线参数：算出读数（效率/方向性等强调） */
.bs-read2 { display: flex; gap: 14px; flex-wrap: wrap; font-size: var(--fs-3); color: var(--text-muted); margin: 7px 0 3px; font-family: var(--font-mono); }
.bs-read2 b { color: var(--accent); font-weight: 700; font-size: var(--fs-4); }
/* 天线参数：二选一驱动行（左侧单选点＝驱动，选中者可编辑、另一者只读自动算——对齐 SATSOFT 单选按钮） */
.bs-drv > label { width: 56px; cursor: pointer; }
.bs-drv.act > label { color: var(--text); }
/* 自绘单选点与 controls.css 的原生单选同一副：13px 框、字段描边、选中机位色实底 + 3px 字段底内圈（留 5px 圆点） */
.rdo { flex: none; width: var(--ctl-box); height: var(--ctl-box); border-radius: 50%; border: 1px solid var(--field-border); background: var(--field-bg); box-sizing: border-box; cursor: pointer; transition: border-color var(--dur-1) linear; }
.rdo:hover { border-color: var(--field-border-hover); }
.rdo.on { border-color: var(--accent-ui); background: var(--accent-ui); box-shadow: inset 0 0 0 3px var(--field-bg); }
.bs-prow { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.bs-pchk { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer; }
.bs-pchk input { margin: 0; flex: none; }
.bs-pnm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); }
.bs-pval { width: 52px; flex: none; text-align: right; }
.bs-pvu { flex: none; font-size: var(--fs-2); color: var(--text-muted); }
/* 峰点引导（连续目标场）行 */
.bs-hshead, .bs-hsrow { display: grid; grid-template-columns: 21px 1fr 1fr 1fr 1fr 18px 16px; gap: 4px; align-items: center; padding: 2px 0; }
.bs-hshead { font-size: var(--fs-1); color: var(--text-faint); padding: 3px 0 0; }
.bs-hshead span { text-align: center; }
.bs-hsn { font-size: var(--fs-2); color: #ff9a3c; font-family: var(--font-mono); }
.bs-hsrow .ci { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-2); color: var(--text); border-radius: var(--r-ctl); outline: none; text-align: right; }
.bs-hsrow .hic { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-faint); border: 1px solid transparent; border-radius: var(--r-box); padding: 2px; }
.bs-hsrow .hic:hover { color: var(--text); }
.bs-hsrow .hic.on { color: #ff9a3c; border-color: #ff9a3c; }
.bs-hsrow .hic.hdel:hover { color: var(--danger); }
.bs-ops { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-bottom: 5px; }
.bs-hex { display: flex; align-items: center; gap: 5px; margin: 5px 0; }
.bs-hex label { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.bs-hex select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); color: var(--text); padding: 2px 6px; font-size: var(--fs-3); border-radius: var(--r-ctl); outline: none; cursor: pointer; }
.bs-hex select:hover { border-color: var(--field-border-hover); }
.opb.sm { padding: 3px 10px; flex: none; }
.chk-in { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.chk-in input { margin: 0; }
/* 行内勾选框也是 <label>，会撞上参数行的「标签列宽」——它不是标签列，宽度只该随内容走，
   否则一个「反相」要占满整列宽（英文 92px），把它旁边的下拉挤到看不见选项 */
.srow .chk-in { min-width: 0; }
.bs-list { margin-top: 5px; max-height: 168px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); }
.bs-brow { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: var(--fs-2); border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-brow:last-child { border-bottom: none; }
.bs-bi { width: 20px; text-align: center; color: var(--accent); font-family: var(--font-mono); flex: none; }
.bs-bll { flex: 1; color: var(--text-muted); font-family: var(--font-mono); }
.bs-bth { color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); white-space: nowrap; }
.bs-bth em { color: var(--text-faint); font-style: normal; }
.bs-status { font-size: var(--fs-2); color: var(--accent); line-height: 1.5; margin-top: 5px; }
.bs-gen { display: flex; justify-content: center; align-items: center; gap: 5px; width: 100%; box-sizing: border-box; margin-top: 4px; background: var(--primary-fill); color: var(--primary-on); font-size: var(--fs-3); font-weight: 600; padding: 5px 0; border-radius: var(--r-ctl); cursor: pointer; user-select: none; transition: var(--t-state); }
/* 悬停走 token 而不是提亮滤镜 —— 后者在浅色墨底上几乎不变、深色近白底上还会冲出界 */
.bs-gen:hover { background: var(--primary-fill-hover); }
.bs-gen:active { box-shadow: var(--press); transition-duration: 0s; }
.ci.wide { width: 100%; }
/* 轮廓与编号样式行：同一行放两组「标签+短输入」；lb2=行内第二个标签 */
/* 允许换行 + 把「线宽/字号 + 输入 + 单位」打包成不可分割的 .uw 组：窄面板下整组整体折到次行，
   单位 px/% 永不被右边缘裁掉（此前 px 溢出被切）；宽度够时靠 margin-left:auto 贴右保持单行。 */
.bs-side .srow { flex-wrap: wrap; row-gap: 6px; }
.bs-side .srow .uw { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; margin-left: auto; }
.bs-side .srow .ci.sm { flex: none; width: 48px; }
.bs-side .srow .lb2 { flex: none; width: auto; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
/* 颜色输入固定小方块：全局 .clr 有两条冲突规则、后者 flex:1 会被行内其它控件挤成一条细线看不清色，这里锁定尺寸 */
.bs-side .srow .clr { flex: none; }
/* —— 赋形反射面模型（对齐 SATSOFT Shaped Reflector 对话框）：只读值 / 波长读数 / 几何预览图 —— */
.bs-ro { font-size: var(--fs-3); color: var(--text-muted); }
.bs-wl { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; }
/* 站点栅编辑：操作按钮行 + 平面图框选橡皮筋（fixed 屏幕像素，指针事件穿透） */
.bs-strow { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.bs-boxsel { position: fixed; z-index: 900; border: 1px dashed var(--accent); background: color-mix(in srgb, var(--accent-ui) 10%, transparent); pointer-events: none; }
.bs-refl { margin: 6px 0 2px; border: 1px solid var(--border); border-radius: var(--r-card); padding: 3px; background: color-mix(in srgb, var(--text) 3%, transparent); }
.bs-refl svg { width: 100%; display: block; }
.bs-reflbar { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 2px 0 0; }
.bs-reflbar .pgb { cursor: pointer; color: var(--text-muted); user-select: none; font-size: var(--fs-2); line-height: 1; padding: 2px 4px; transition: color var(--dur-1) linear; }
.bs-reflbar .pgb:hover { filter: none; color: var(--text); }
.bs-reflpg { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.bs-reflcap { font-size: var(--fs-1); color: var(--text-faint); margin-left: 4px; }
/* 频率计划图例：色块 + 色号 + 数量 */
.bs-fcleg { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 5px 0 2px; }
.bs-fchip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-2); color: var(--text-muted); font-family: var(--font-mono); }
.bs-fchip i { width: 10px; height: 10px; border-radius: var(--r-ctl); border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-fchip em { font-style: normal; color: var(--text-faint); }
/* 频率计划：波束信息列表（可多列复制到 Excel）——紧凑显示 4 列，复制展开为 7 列 TSV */
.bs-fplist { margin-top: 7px; }
.bs-fphd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.bs-fphd > span:first-child { font-size: var(--fs-2); color: var(--text-muted); }
.bs-fphd em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); }
.bs-fpcp { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border: 1px solid var(--border); border-radius: var(--r-ctl); color: var(--text-muted); font-size: var(--fs-2); cursor: pointer; white-space: nowrap; transition: color .12s, border-color .12s; }
.bs-fpcp:hover { border-color: var(--line-hover); color: var(--text); }
.bs-fpcp.ok { border-color: color-mix(in srgb, var(--ok) 60%, transparent); color: var(--ok); }
.bs-fptbl { max-height: 176px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); }
.bs-fpr { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: var(--fs-2); font-family: var(--font-mono); border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-fpr:last-child { border-bottom: none; }
.bs-fph { position: sticky; top: 0; background: var(--surface); color: var(--text-faint); font-size: var(--fs-1); z-index: 1; }
.bs-fpr .c-no { width: 24px; text-align: right; flex: none; color: var(--accent); }
.bs-fph.bs-fpr .c-no { color: var(--text-faint); }
.bs-fpr .c-fc { width: 42px; flex: none; display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); }
.bs-fpr .c-fc i { width: 9px; height: 9px; border-radius: var(--r-ctl); flex: none; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-fpr .c-ll { flex: 1; min-width: 0; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bs-fpr .c-th { flex: none; color: var(--text-faint); white-space: nowrap; }
.bs-fpr .c-th em { font-style: normal; }
/* 相控阵赋形：星上激励指令表 */
.bs-excbar { display: flex; gap: 6px; align-items: center; margin: 6px 0 5px; }
.bs-exctbl { max-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-ctl); }
/* 真 <table>：支持鼠标框选任意行列 → Ctrl+C（浏览器原生按 TSV 复制，粘进 Excel 自动分列） */
.bs-exctable { border-collapse: collapse; width: 100%; font-size: var(--fs-2); font-family: var(--font-mono); }
.bs-exctable th, .bs-exctable td { padding: 2px 7px; text-align: right; white-space: nowrap; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-exctable tbody tr:last-child td { border-bottom: none; }
.bs-exctable thead th { position: sticky; top: 0; background: var(--bg); color: var(--text-faint); font-weight: normal; z-index: 1; }
.bs-exctable td:first-child { color: var(--accent); }
.bs-exctable tbody tr:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* —— 导航器：波束组列表 + 新建/工具行 —— */
.bs-grps { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 5px; max-height: 190px; overflow-y: auto; }
.bs-grow { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--r-box); cursor: pointer; font-size: var(--fs-3); }
.bs-grow:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-grow.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 10%, transparent); }
.bs-grow.hid { opacity: .5; }
.bs-gk { flex: none; font-size: var(--fs-1); padding: 1px 5px; border-radius: var(--r-box); color: #fff; letter-spacing: var(--ls-tight); }
.bs-gk.gauss { background: #4f8fe8; }
.bs-gk.shaped { background: #3fb77f; }
.bs-gk.pam { background: #a06fdc; }
.bs-gk.stk { background: #f08a3c; }
.bs-gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.bs-grow.on .bs-gname { color: var(--accent); font-weight: 600; }
.bs-gcnt { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.bs-grow .gic { flex: none; display: inline-flex; color: var(--text-faint); opacity: 0; cursor: pointer; }
.bs-grow:hover .gic, .bs-grow.on .gic { opacity: .75; }
.bs-grow .gic:hover { color: var(--text); opacity: 1; }
.bs-grow .gic.del:hover { color: var(--danger); }
.bs-empty { padding: 10px 6px; text-align: center; color: var(--text-faint); font-size: var(--fs-2); border: 1px dashed var(--border); border-radius: var(--r-box); }
.bs-empty2 { padding: 6px 2px; color: var(--text-faint); font-size: var(--fs-3); line-height: 1.6; }
.bs-addrow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-bottom: 5px; }   /* 四种组 → 2×2 */
.bs-navops { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.bs-navops .opb { display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
.opb.dis { opacity: .4; pointer-events: none; }
/* —— 波束设置 chip 条 —— */
.bs-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 6px; }
.bs-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--r-box); font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.bs-chip:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-chip.on { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.bs-chip i { width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-chip em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-1); }
.bs-chip.add { color: var(--accent); font-weight: 600; padding: 3px 10px; }
/* —— 检查器折叠头 —— */
/* 图层关掉后分区体退到后景：参数照旧可改，只是当前不出图 —— 与标记面板同一条规则 */
.focus-side .sec > :not(.sect) { transition: opacity var(--dur-2) linear; }
.focus-side .sec.hid > :not(.sect) { opacity: .5; }
/* 覆盖圈口径行：数值输入按内容收窄（其余 .srow .ci 是铺满整行的搜索框类），后面跟单位与锁 */
.focus-side .srow .ci { flex: 0 1 76px; text-align: right; font-variant-numeric: tabular-nums; }
/* 口径留空＝按该星的对地全视场画，占位符里就是那个上限值：读成「自动值」而不是已填的数 */
.focus-side .srow .ci::placeholder { color: var(--text-faint); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }
/* 折叠标题整条是命中区：悬停给一块淡底。淡底画在 ::before 上、向外扩 3 / 6，标题盒本身的 12 / 6 外边距一字不改——
   不能靠「负外边距 + 内距」凑净值：内距挡住了与下一个兄弟外边距的折叠（.bsub 7、.chk2 8…），标题下的内容会整段下移。
   ::before 属于标题本身，扩出去的那圈同样算悬停 / 点击命中。.setsect 排除——它自有负边距色带。
   箭头不另写 transition（会压掉 .disc 的旋转过渡）；分区内容仍瞬时挂载 */
.sect.acc:not(.setsect) { position: relative; isolation: isolate; }
.sect.acc:not(.setsect)::before { content: ''; position: absolute; inset: -3px -6px; z-index: -1; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.sect.acc:not(.setsect):hover::before { background: color-mix(in srgb, var(--text) 5%, transparent); }
.sect.acc:not(.setsect):active::before { background: color-mix(in srgb, var(--text) 9%, transparent); transition-duration: 0s; }
/* 指针落在行尾动作 / 拨杆上时，整条的底让给它们自己的悬停（必须写在 hover / active 之后） */
.sect.acc:has(.lnk:hover, .layersw:hover, .lnk:active, .layersw:active)::before { background: transparent; }
.sect.acc:hover > .app-icon.disc { color: var(--text-muted); }

/* —— 可见性分析（Access / Coverage）：目标/参数 + KPI 摘要 + 可见星结果表 —— */
/* —— 环境场面板：结构与可见性分析同源，只多一个置顶的图层总开关和数据源标注行 —— */
/* 气象指标表的指标选择：只有一栏（显示列），比性能表的双栏窄 */
.met-opt-dlg { width: min(560px, 92vw); }
.met-po-cols { width: 100%; }
/* 数据来源清单：名目一栏 + 出处一栏。出处普遍比 .srow label 的 70px 长得多，故不复用 srow，
   走两列网格让右栏自己折行（型号名与 ITU-R 编号都不该被省略号截断）。 */
/* 业务档位图例的刻度：色轴等分，故刻度按等分格排，标签是锚点值本身（值轴不等距）。
   ★ 用 grid 而不是 space-between —— 后者会把首末两个标签顶到条子外面去，与它们标注的边界对不上。 */
.lv-legtick { display: grid; margin-top: 2px; font-size: var(--fs-1); line-height: 1.2; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.lv-legtick span { text-align: center; overflow: hidden; white-space: nowrap; transform: translateX(-50%); width: 200%; }
.lv-legtick span:first-child { transform: none; width: 100%; text-align: left; }
.lv-legtick span:last-child { transform: none; width: 100%; text-align: right; }
/* 分档图例：档与档之间留一道极细的缝，边界才读得出来（连续渐变条不需要） */
.cov-legbar.stepped i + i { box-shadow: inset 1px 0 0 var(--surface); }   /* 原先引用的面板色变量未定义且无兜底，整条失效 */
/* 站点实况读数 */
.lv-nm { flex: 1; min-width: 0; }
.lv-obs { margin: 6px 8px 2px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--bg-soft, transparent); }
.lv-obsh { font-size: var(--fs-2); color: var(--text-muted); margin-bottom: 4px; }
.lv-obsh + .lv-obsg { margin-bottom: 2px; }
.lv-obsg { display: grid; grid-template-columns: auto 1fr auto 1fr; gap: 2px 6px; align-items: baseline; font-size: var(--fs-2); }
.lv-obsg span { color: var(--text-faint); }
.lv-obsg b { color: var(--text); font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
/* 实况 vs 模式：0.25° 格值是 28 km 一片的平均，站址是那一个点 —— 差多少本身就是信息，故并列 */
.lv-cmp { display: grid; grid-template-columns: 1fr auto auto auto; gap: 6px; align-items: baseline; margin-top: 5px; padding-top: 5px; border-top: 1px solid var(--border); font-size: var(--fs-2); }
.lv-cmp span { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-cmp b { color: var(--text); font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.lv-cmp i { color: var(--text-faint); font-style: normal; }

.env-side .tip.inl { display: inline; margin-left: 0; }
/* 图层总开关：通栏开关条（Mapbox Studio / ArcGIS 图层卡片的位置与语汇）。
   环境场的显隐是本面板的一级动作，与「反相」「画等值线」这些参数级复选框不是一个量级，
   故从「数据场」分区里提出来置顶常驻——分区折叠也藏不住它，开面板第一眼就落在这里。 */
.env-side .envsw { display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 16px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-4); text-align: left; cursor: pointer; transition: background-color var(--dur-1) linear, color var(--dur-1) linear; }   /* 左缘竖条（box-shadow）是开关结论，瞬时 */
.env-side .envsw:hover { color: var(--text); background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.env-side .envsw:focus-visible { outline: 1px solid var(--accent); outline-offset: -3px; }
.env-side .envsw.on { color: var(--text); background: color-mix(in srgb, var(--accent-ui) 8%, var(--surface-2)); box-shadow: inset 2px 0 0 var(--accent-ui); }
.env-side .envsw.on:hover { background: color-mix(in srgb, var(--accent-ui) 13%, var(--surface-2)); }
.env-side .envsw-i { flex: none; color: var(--text-faint); transition: color var(--dur-1) linear; }
.env-side .envsw.on .envsw-i { color: var(--accent); }
.env-side .envsw-t { flex: 1; min-width: 0; font-weight: 600; }
/* 整条都是热区，故拨杆的 hover 由条子驱动（只悬到条子上、指针没压在拨杆上时也要亮） */
.env-side .envsw:hover .layersw { background: color-mix(in srgb, var(--text) 22%, var(--border-strong)); }
.env-side .envsw.on:hover .layersw { background: color-mix(in srgb, var(--text) 22%, var(--accent)); }
/* 环境场一个面板只有一层，故整面板跟着退到后景（标记面板是一分区一层，压暗落在分区上） */
.env-side .sec { transition: opacity var(--dur-2) linear; }   /* 挂在常态上：打开图层时也淡回，而不是只在关掉时淡出 */
.env-side.hid .sec { opacity: .5; }
.env-side .env-src { min-height: 16px; }
.env-side .chk2.dis { opacity: 0.45; cursor: not-allowed; }
.env-side .cov-num { flex: none; width: 54px; }
/* 环境场标签列放宽 2px（70 → 72）：个别中文标签刚好顶到列宽，控件列与其它行错开；英文档由 controls.css 另抬一档，这里只管中文 */
html:not([lang="en"]) .env-side .srow:not(.sub) { --srow-lab: 72px; }

/* 分节头读数：加了「x% 时间覆盖」后可能长过标题剩余宽度 → 省略号收边（完整定义在 title 里），不许换行顶开表头 */
.vis-side .sect .vis-cnt { margin-left: auto; padding-left: 8px; min-width: 0; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vis-side .sect .vis-cnt.on { color: var(--ok); }
/* 卫星集来源行：下拉（当前显示 / 默认卫星组 / 卫星组 / 自定义卫星）+ 颗数，与「目标」「仰角门限」同为分析设定行 */
/* 比通用下限再宽一档：选项里有「千帆星座 / Qianfan Constellation」这类整名，还有用户自命名的
   卫星组（长度不设限）。挤不下时整件掉到下一行（行尾还跟着颗数读数，故不用 stack 恒占两行） */
.vis-satset .vis-satsel { flex: 1; min-width: 150px; }
.vis-satset .vis-satn { flex: none; text-decoration: none; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-2); white-space: nowrap; }
.vis-side .tip.inl { display: inline; margin-left: 8px; }
.vis-side .vis-elev { flex: none; width: 58px; }
.vis-icrow { align-items: center; gap: 5px; }
.vis-icrow > label:first-child { flex: none; width: 46px; }
.vis-icrow .vis-slider { flex: 1; min-width: 30px; }
.vis-icrow .u { flex: none; min-width: 14px; text-align: right; }
.vis-icrow .chk-in { flex: none; }
/* 紧凑摘要（一行内联，去卡片——克制不卡通） */
.vis-sum { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; margin: 6px 0 7px; font-size: var(--fs-2); color: var(--text-faint); }
.vis-sum b { color: var(--text); font-weight: 600; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-sum s { text-decoration: none; }
.vis-sum em { font-style: normal; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 96px; display: inline-block; vertical-align: bottom; }
.vis-sumcls { display: inline-flex; gap: 9px; }
.vis-sumcls i { font-style: normal; color: var(--text-muted); font-family: var(--font-mono); }
/* 轨道类别配色（低饱和，纯文字着色、不加边框——去卡通） */
.oc-LEO { color: #6fb3e0; } .oc-MEO { color: #7fc4a0; } .oc-GEO { color: #d8a73a; } .oc-HEO { color: #c08fd0; }
/* 极坐标 sky 图：方位=角向、仰角=离心（天顶在圆心、地平在外圈） */
.vis-sky { display: block; width: 100%; max-width: 188px; margin: 4px auto 8px; }
.vis-sky-grid { fill: none; stroke: var(--border); stroke-width: 0.4; }
.vis-sky-thr { fill: none; stroke: var(--ok); stroke-width: 0.5; stroke-dasharray: 2 1.6; opacity: 0.65; }
.vis-sky-lbl { fill: var(--text-muted); font-size: 5px; text-anchor: middle; dominant-baseline: middle; }
.vis-sky-el { fill: var(--text-faint); font-size: 3.6px; text-anchor: start; dominant-baseline: middle; }
.vis-sky-dot { fill: color-mix(in srgb, var(--ok) 78%, transparent); cursor: pointer; transition: fill .1s; }
.vis-sky-dot.hi { fill: var(--ok); }
.vis-sky-dot.hov { fill: #efeae0; stroke: var(--ok); stroke-width: 0.6; }
/* 结果表：4 列（卫星 / 类别 / 仰角 / 斜距）——去方位列(交给 sky 图)、去仰角条(去卡通)，卫星名更宽 */
.vis-lhead, .vis-lrow { display: grid; grid-template-columns: 1fr 46px 56px 54px; gap: 6px; align-items: center; }   /* 类别列 46px：容下 GEO 定点经度「179.5°W」 */
.vis-lhead { font-size: var(--fs-1); color: var(--text-faint); padding: 3px 6px 4px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); z-index: 1; }
.vis-lhead > span:not(.vis-lname):not(.vis-lc) { text-align: right; }
.vis-lhead .vis-lc { text-align: center; }
.vis-lhead .sortable, .vis-acc-hd .sortable { cursor: pointer; user-select: none; }
.vis-lhead .sortable:hover, .vis-acc-hd .sortable:hover { color: var(--text-muted); }
.vis-lhead .sortable.on, .vis-acc-hd .sortable.on { color: var(--ok); }
.vis-list { max-height: 280px; overflow-y: auto; }
.vis-lrow { padding: 3px 6px; font-size: var(--fs-2); border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); color: var(--text-muted); }
.vis-lrow:last-child { border-bottom: none; }
.vis-lrow.hi { color: var(--text); font-weight: 600; }
.vis-lrow.hov { background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.vis-lrow > span:not(.vis-lname):not(.vis-lc):not(.vis-lel) { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-lname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* GEO 定点标注（'110.5°E'）：名字后的淡色小字，瞬时表 / 过境表 / 甘特共用 */
.vis-slot { text-decoration: none; margin-left: 5px; color: var(--text-faint); font-size: var(--fs-1); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-lc { text-align: center; font-size: var(--fs-1); }
.vis-lel { display: flex; align-items: center; justify-content: flex-end; gap: 3px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-ud { font-style: normal; font-size: var(--fs-1); width: 7px; display: inline-block; text-align: center; }
.vis-ud.up { color: var(--ok); } .vis-ud.dn { color: var(--text-faint); }
/* ACCESS 时段过境：mode 切换 + 甘特 + 过境列表 */
.vis-mode { margin: 8px 0; }
/* 三模式切换（瞬时可见 / 时段过境 / 覆盖）：等宽分段控件——锐边仪器风 + 凹槽轨道 + 活动段实色填充。
   ① 等宽 flex:1 铺满面板宽度（原为内容宽、左侧挤成一坨）；② 轨道给 --surface 凹槽感、活动段 --sel-fill 实填（浅色即墨，深色压一档）；
   ③ 活动段文字用 var(--bg) 而非写死 #fff——深色主题 accent≈白，写死白字=白底白字看不见；
   ④ 非活动段悬停给反馈；⑤ 段间加 1px 分隔线，紧邻活动块的分隔线转透明使实色边缘干净。
   仅作用于本控件：.seg.sm 复用面广，用 .seg.sm.vis-mode 提高特指度收窄作用域，不动通用 .seg。 */
.seg.sm.vis-mode { background: var(--surface); border-color: var(--border-strong); }
/* white-space: normal —— 三档挤不下时档名折行，而不是把最后一档顶出侧栏裁掉 */
.seg.sm.vis-mode .sg { flex: 1; min-width: 0; text-align: center; padding: 4px; font-size: var(--fs-3); line-height: 1.25; white-space: normal; color: var(--text-muted); transition: var(--t-state); }
.seg.sm.vis-mode .sg + .sg { border-left: 1px solid var(--border); }
.seg.sm.vis-mode .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg.sm.vis-mode .sg.on { background: var(--sel-fill); color: var(--sel-on); font-weight: 600; transition-duration: 0s; }
.seg.sm.vis-mode .sg.on, .seg.sm.vis-mode .sg.on + .sg { border-left-color: transparent; }
.vis-side .u.nw { flex: none; white-space: nowrap; }        /* 「小时」等单位不换行 */
.acc-exp { margin-top: -3px; }                              /* 导出行紧跟时窗行 */
.vis-gantt { margin: 6px 0 4px; display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
.vis-grow { display: grid; grid-template-columns: 78px 1fr; gap: 6px; align-items: center; font-size: var(--fs-2); padding: 2px 4px; border-radius: var(--r-box); }
.vis-grow.hov { background: color-mix(in srgb, var(--accent-ui) 14%, transparent); }
.vis-gname { min-width: 0; overflow-wrap: anywhere; word-break: break-word; line-height: 1.25; color: var(--text-muted); }
.vis-gbar { position: relative; height: 9px; background: color-mix(in srgb, var(--border) 45%, transparent); border-radius: var(--r-ctl); }
.vis-gseg { position: absolute; top: 1px; bottom: 1px; min-width: 1.5px; background: color-mix(in srgb, var(--ok) 55%, var(--text-faint)); border-radius: 1px; }
.vis-gseg.hi { background: var(--ok); }
/* 表格行 ⇆ 甘特段 段级联动：悬停的那次过境在甘特上提亮撑满（星级整行底色仍走 .vis-grow.hov） */
.vis-gseg.hov { background: var(--accent); top: 0; bottom: 0; z-index: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.vis-acc-hd, .vis-acc-row { display: grid; grid-template-columns: 1fr 58px 58px 30px; gap: 6px; align-items: center; }
.vis-acc-hd { font-size: var(--fs-1); color: var(--text-faint); padding: 3px 6px 4px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); z-index: 1; }
.vis-acc-hd > span:not(.vis-lname) { text-align: right; }
.vis-acc-list { max-height: 220px; overflow-y: auto; }
.vis-acc-row { padding: 3px 6px; font-size: var(--fs-2); border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); color: var(--text-muted); }
.vis-acc-row:last-child { border-bottom: none; }
.vis-acc-row.hov { background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.vis-acc-row > span:not(.vis-lname) { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
/* —— 时段过境：时基行（时区切换 + 时窗绝对起止）/ 甘特刻度轴 / 日期分隔 / 行展开详情 —— */
.vis-tbase { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; min-width: 0; }
/* 显示时区档位：一枚角标即按钮（点开是本机 / UTC / UTC±N 的列表，见 TzPicker） */
.vis-tzp { display: inline-flex; flex: none; align-items: center; padding: 1px 7px; border: 1px solid var(--border); border-radius: var(--r-card); color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-1); line-height: 1.6; }
.vis-tzp:hover, .vis-tzp.open { color: var(--text); border-color: var(--border-strong); }
.vis-tspan { color: var(--text-muted); font-size: var(--fs-2); font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vis-gaxis { position: sticky; top: 0; z-index: 2; background: var(--surface); }
.vis-gax { position: relative; height: 13px; }
.vis-gtick { position: absolute; top: 0; transform: translateX(-50%); font-size: var(--fs-1); line-height: 1; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-decoration: none; }
.vis-gtick::before { content: ''; display: block; width: 1px; height: 3px; background: color-mix(in srgb, var(--text-faint) 70%, transparent); margin: 0 auto 1px; }
.vis-gtick.day { color: var(--text-muted); }
.vis-acc-day { position: sticky; top: 0; z-index: 1; background: var(--surface); display: flex; align-items: center; gap: 6px; padding: 4px 6px 3px; font-size: var(--fs-1); color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: var(--ls-tight); }
.vis-acc-day::after { content: ''; flex: 1; border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.vis-acc-day s { text-decoration: none; color: var(--text-faint); }
.vis-acc-row { cursor: pointer; }
.vis-acc-row.exp { background: color-mix(in srgb, var(--accent-ui) 8%, transparent); border-bottom-color: transparent; }
.vis-dsup { text-decoration: none; font-size: 8px; vertical-align: super; color: var(--warn); margin-left: 1px; }
.vis-cw { font-style: normal; display: inline-block; margin-right: 3px; font-size: 8px; color: var(--text-faint); transition: transform .15s; transform-origin: 45% 50%; }
.vis-acc-row.exp .vis-cw { transform: rotate(90deg); }
.vis-acc-det { padding: 4px 8px 7px 15px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); background: color-mix(in srgb, var(--accent-ui) 5%, transparent); }
.vexp-grid { display: grid; grid-template-columns: 32px 1fr 1fr; gap: 1px 8px; font-size: var(--fs-2); align-items: baseline; }
.vexp-grid .h { color: var(--text-faint); font-size: var(--fs-1); font-family: var(--font-mono); }
.vexp-grid .l { color: var(--text-faint); font-size: var(--fs-1); }
.vexp-grid .t { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
.vexp-foot { margin-top: 4px; font-size: var(--fs-1); color: var(--text-faint); display: flex; flex-wrap: wrap; gap: 2px 10px; }
.vexp-foot b { font-weight: 600; color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vexp-foot .vexp-tr { color: var(--warn); font-family: inherit; }
.oc-hi { color: var(--ok); font-weight: 600; }
/* —— 覆盖分析（Coverage / FOM）：区域边界输入 + 配色 + 图例 + KPI —— */
.cov-num { flex: none; width: 100px; }
.cov-b { flex: none; width: 62px; }
/* min-width 与 .srow select 的 min-width:0 对着来（后者特异度更低）：色图 / 极化这几个下拉
   的选项是固定词表，缩到装不下就等于把选项名裁了，而 select 的裁切在 DOM 上量不出来 */
.cov-scheme { flex: none; width: 96px; }
.srow .cov-scheme { min-width: 96px; }
.cov-alpha { flex: 1; min-width: 40px; }
.cov-msg { color: var(--warn); }
.cov-legend { margin: 7px 0 6px; }
.cov-legbar { display: flex; height: 11px; border-radius: var(--r-box); overflow: hidden; border: 1px solid var(--border); }
.cov-legbar i { flex: 1 1 0; cursor: help; }
.cov-legsc { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin-top: 3px; font-size: var(--fs-1); color: var(--text-faint); }
.cov-legsc span { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.cov-legsc b { color: var(--text-muted); font-weight: 600; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cov-kpi { margin-top: 5px; }

/* —— 标记批量表格浮窗（复用 perf-win 骨架，加分页 tab / 航迹选择条；正文 3 张网格 v-show 切换） —— */
.mk-win { z-index: 61; }
.mk-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; flex: none; }
.mk-tab { padding: 2px 12px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; user-select: none; }
.mk-tab + .mk-tab { border-left: 1px solid var(--border); }
.mk-tab:hover { color: var(--text); }
.mk-tab.on { background: var(--sel-fill); color: var(--sel-on); }
/* 表体：航迹分页是主从两栏（左栏航迹、右侧航点网格），另两个分页只有网格 */
.mk-main { flex: 1; min-height: 0; display: flex; }
.mk-main > .pin-body { min-width: 0; }
/* 右侧一列：航迹页的参数栏 + 网格（另两页只有网格） */
.mk-col { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.mk-col > .pin-body { min-width: 0; min-height: 0; }
.mk-tjbar { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; padding: 5px 9px; border-bottom: 1px solid var(--border); font-size: var(--fs-2); color: var(--text-muted); }
.mk-tjbar > label { color: var(--text-muted); white-space: nowrap; }
.mk-tjbar > label ~ label { margin-left: 6px; }
.mk-tjbar .u { color: var(--text-faint); }
.mk-tjbar .mkp-n { width: 72px; }
.mk-tjbar .mkp-t { width: 148px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.mk-tjbar .lnk { color: var(--text-muted); cursor: pointer; }
.mk-tjbar .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.mk-tjbar .mkp-r { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 航迹网格：推算值 / 推算列灰字，钉住的值正常色，不合时序的时刻钉点标红 */
.mk-body :deep(td.wp-auto .eg-v), .mk-body :deep(td.wp-calc .eg-v) { color: var(--text-muted); }
.mk-body :deep(td.wp-bad .eg-v) { color: var(--danger); }
/* —— 航迹左栏 —— */
.mk-trajs { flex: none; width: 156px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 55%, transparent); }
.mtj-h { flex: none; display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 9px; border-bottom: 1px solid var(--border); }
.mtj-ht { flex: 1; font-size: var(--fs-2); color: var(--text-faint); }
.mtj-add { display: inline-flex; align-items: center; gap: 1px; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-box); padding: 1px 5px 1px 3px; cursor: pointer; white-space: nowrap; }
.mtj-add:hover { color: var(--accent); border-color: var(--line-hover); }
.mtj-list { flex: 1; min-height: 0; overflow-y: auto; padding: 3px 0; }
.mtj-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 9px; cursor: pointer; user-select: none; border-left: 2px solid transparent; }
.mtj-row:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.mtj-row.on { background: color-mix(in srgb, var(--accent-ui) 14%, transparent); border-left-color: var(--accent-ui); }
/* 类型点：航行=橙、飞行=蓝（与图上的航迹线同色），点一下换类型 */
.mtj-k { flex: none; width: 8px; height: 8px; border-radius: var(--r-ctl); cursor: pointer; }
.mtj-k.sea { background: #ff6a4a; }
.mtj-k.flight { background: #5ad1ff; }
.mtj-k:hover { outline: 2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset: 1px; }
.mtj-n { flex: 1; min-width: 0; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mtj-row.on .mtj-n { color: var(--text); }
.mtj-c { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.mtj-x { flex: none; display: inline-flex; color: var(--text-faint); opacity: 0; cursor: pointer; }
.mtj-row:hover .mtj-x { opacity: .8; }
.mtj-x:hover { color: var(--danger); }
.mtj-ren { flex: 1; min-width: 0; font: inherit; font-size: var(--fs-3); padding: 1px 4px; background: var(--field-bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-box); outline: none; }
.mtj-empty { padding: 8px 9px; font-size: var(--fs-2); color: var(--text-faint); }

/* —— 上：城市输入区（高度由 JS 控制，可经中缝拖拽） —— */
.perf-input { flex: none; display: flex; flex-direction: column; min-height: 0; }
/* 中缝分隔条（上下拖拽） */
.perf-split { flex: none; height: 7px; cursor: ns-resize; background: var(--border); display: flex; align-items: center; justify-content: center; }
.perf-split:hover { background: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.perf-split .grip { width: 30px; height: 2px; border-radius: var(--r-ctl); background: color-mix(in srgb, var(--text) 35%, transparent); }
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
.pin-t, .pr-t { font-size: var(--fs-3); font-weight: 600; color: var(--text-muted); white-space: nowrap; }
.pr-t em { margin-left: 4px; font-style: normal; font-size: var(--fs-1); font-weight: 400; color: var(--text-faint); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 0 5px; }
.pin-body { flex: 1; overflow: auto; outline: none; }

/* —— 下：只读性能结果表 —— */
.perf-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pr-h { border-bottom: 1px solid var(--border); }
.pr-cov { display: flex; align-items: center; gap: 4px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; cursor: pointer; }
.pr-cov.dis { opacity: .5; }
.pr-cov .ci { width: 52px; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-2); color: var(--text); border-radius: var(--r-card); outline: none; font-family: var(--font-mono); }
.pr-cov .ci:disabled { opacity: .45; }
.pr-cov .u { color: var(--text-faint); font-size: var(--fs-2); }
.pr-body { flex: 1; overflow: auto; }
/* —— Excel 网格 —— 表体（序号列/列头/单元格/填充柄/右键菜单）全在 src/components/ExcelGrid.vue，
   本页四张表（城市输入 / 性能结果 / 标记三分页 / 波束批量）共用那一份。这里只补插槽里的操作列图标：
   子组件渲染的节点带的是它自己的 scoped 标记，故一律走 :deep()。 */
.eg-host :deep(.eg-act .del) { cursor: pointer; color: var(--text-faint); opacity: 0; display: inline-flex; vertical-align: middle; }
.eg-host :deep(tbody tr:hover .del) { opacity: .8; }
.eg-host :deep(.eg-act .del:hover) { color: var(--danger); }
.eg-host :deep(tr.out td) { color: var(--text-faint); }

/* 性能表选项弹窗 */
.sat-mask.perf-opt-mask { z-index: 70; }   /* 提高特异性压过 .sat-mask(z40)，高于性能表浮窗(z60)避免被遮挡 */
.perf-opt-dlg { width: 700px; max-width: calc(100% - 32px); max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3); }
.perf-opt-dlg .sdh em { font-style: normal; font-family: var(--font-mono); font-size: var(--fs-3); color: var(--text-faint); }
.perf-opt-dlg .sdfoot .po-reset { margin-right: auto; }   /* 「恢复默认」推到左端，「完成」留在右端 */
.perf-opt-body { display: flex; gap: 12px; padding: 12px; overflow: auto; align-items: stretch; }
.po-card { border: 1px solid var(--border); border-radius: var(--r-float); padding: 8px 10px; background: color-mix(in srgb, var(--text) 2.5%, transparent); }
.po-ct { font-size: var(--fs-2); font-weight: 600; color: var(--text-muted); letter-spacing: var(--ls-tight); margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.po-cols { flex: 0 0 280px; display: flex; flex-direction: column; }
.po-scroll { flex: 1; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; align-content: start; }
.po-grp { display: contents; }
.po-gt { grid-column: 1 / -1; font-size: var(--fs-1); color: var(--text-faint); margin: 6px 0 1px; letter-spacing: var(--ls-tight); }
.po-gt:first-child { margin-top: 0; }
.po-ck { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: var(--fs-3); color: var(--text); cursor: pointer; min-width: 0; }
.po-ck span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-ck input { flex: none; }
.po-ck.dis { color: var(--text-faint); cursor: not-allowed; }
.po-ck em { color: var(--text-faint); font-style: normal; }
.po-right { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.po-chk { display: flex; align-items: center; gap: 6px; font-size: var(--fs-3); color: var(--text); cursor: pointer; padding: 1px 0; }
.po-row { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: var(--fs-3); }
.po-row label { flex: 0 0 64px; color: var(--text-muted); }
.po-row .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; }
.po-row .ci:disabled { opacity: .45; }
.po-row select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); }
.po-row .u { flex: none; color: var(--text-faint); font-size: var(--fs-2); }
.po-row .seg, .po-card > .seg { flex: 1; }

/* —— 城市输入区工具栏：城市组下拉 + 分隔条 —— */
.pin-sep { flex: none; width: 1px; align-self: stretch; margin: 2px 2px; background: var(--border); }
.pin-gsel { flex: none; max-width: 168px; border: 1px solid var(--field-border); background-color: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; cursor: pointer; }
.pin-gsel:hover { border-color: var(--field-border-hover); }
/* —— 城市组管理弹窗 —— */
.sat-mask.perf-grp-mask { z-index: 70; }   /* 压过性能表浮窗(z60)，避免被遮挡 */
.grp-dlg { width: 460px; max-width: calc(100% - 32px); }
.grp-save { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.grp-name { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 4px 8px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; }
.grp-name:focus { border-color: var(--accent-ui); }
.grp-save .save { flex: none; background: var(--primary-fill); color: var(--primary-on); padding: 4px 12px; cursor: pointer; font-size: var(--fs-3); border-radius: var(--r-card); white-space: nowrap; transition: var(--t-state); }
.grp-save .save:hover { background: var(--primary-fill-hover); }
.grp-save .save:active { box-shadow: var(--press); transition-duration: 0s; }
.grp-save .save.dis { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; pointer-events: none; }
.grp-list { max-height: 300px; overflow-y: auto; }
.grp-row { display: flex; align-items: center; gap: 6px; padding: 5px 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.grp-row.cur { background: color-mix(in srgb, var(--accent-ui) 10%, transparent); }
.grp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); color: var(--text); }
.grp-cnt { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.grp-row .gbtn { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 1px 7px; cursor: pointer; white-space: nowrap; }
.grp-row .gbtn:hover { color: var(--text); border-color: var(--line-hover); }
.grp-row .gic { flex: none; display: inline-flex; align-items: center; color: var(--text-faint); cursor: pointer; padding: 1px 2px; }
.grp-row .gic:hover { color: var(--text); }
.grp-row .gic.ok:hover { color: var(--accent); }
.grp-row .gic.del:hover { color: var(--danger); }
.grp-row .gic.del.warn { color: var(--danger); }
.grp-empty { padding: 18px 8px; text-align: center; font-size: var(--fs-3); color: var(--text-faint); font-style: italic; }
/* 「导入标记…」弹窗：两张勾选列表叠放各自限高，整窗随 .sat-dlg 滚；坐标列与波束列表的读数列同一副字 */
.mkpick-dlg { width: 440px; }
.mkpick-dlg .po-card + .po-card { margin-top: 8px; }
.mkpick-dlg .bplist { max-height: 220px; margin-top: 0; }
.mkpick-dlg .brow .bll { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.mkpick-dlg .sdfoot .save.dis { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; pointer-events: none; }

.gck { flex: none; width: 12px; height: 12px; margin: 0; cursor: pointer; }
.gck:disabled { opacity: .35; cursor: not-allowed; }
/* 展开后的子级容器：左侧一条淡引导线统辖「卫星显示开关 + 天线列表」，缩进统一 */
.gbody { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--border); margin-bottom: 2px; }
/* 天线行（叶子节点） */
.gant { display: flex; align-items: center; gap: 6px; padding: 3px 6px; margin: 1px 0; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); border-radius: var(--r-box); transition: background .12s, color .12s, box-shadow .12s; }
.gant:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.gant.on { color: var(--text); }                                                                          /* 已选中=绘制中 */
.gant.foc { color: var(--text); background: color-mix(in srgb, var(--accent-ui) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent-ui); font-weight: 600; }   /* 聚焦=编辑中 */
.gant .aname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: break-word; line-height: 1.35; }   /* 天线名显示全，过长换行不截断 */
.gant .aname-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--bg); padding: 1px 5px; font-size: var(--fs-3); color: var(--text); outline: none; }
.gant .afoc { flex: none; font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-tight); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-ctl); padding: 0 5px; line-height: 14px; }
.gant.noant { color: var(--text-faint); font-style: italic; cursor: default; padding-left: 6px; }
.gant.noant:hover { background: none; color: var(--text-faint); }
/* 行内次级操作（卫星行 ＋✎✕ / 天线行 ✎✕ 共用）：常驻但弱化淡灰，hover 该行变亮 */
.sacts { flex: none; display: flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 4px; }
.sacts .ic { font-size: var(--fs-2); color: var(--text-faint); opacity: .5; cursor: pointer; padding: 0; transition: opacity .12s, color .12s; }
.gsat:hover .sacts .ic, .gant:hover .sacts .ic { opacity: .9; }
.sacts .ic:hover { color: var(--text); opacity: 1; }
.sacts .ic.del:hover { color: var(--danger); }
/* 设置面板：当前编辑对象提示 */
.grd-side .sect .editing { margin-left: auto; font-size: var(--fs-1); font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-ctl); padding: 1px 6px; }
/* GRD 电平表 */
.glv { border: 1px solid var(--border); border-radius: var(--r-ctl); margin-top: 5px; }
.lvhdr { margin-left: auto; color: var(--text-faint); font-size: var(--fs-1); font-family: var(--font-mono); }
.glvrow { display: flex; align-items: center; gap: 5px; padding: 3px 6px; }
.glvrow + .glvrow { border-top: 1px solid var(--border); }
.glvrow .lvclr { width: 20px; height: 18px; }
.glvrow .lvval { width: 66px; flex: none; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-size: var(--fs-3); padding: 2px 6px; font-family: var(--font-mono); }
.glvrow .lvabs { flex: 1; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
/* 电平灰色列改可编辑名：默认透明看似纯文字，hover/focus 现边框；有自定义名时字色转常规、示意已命名 */
.glvrow .lvname { min-width: 0; border: 1px solid transparent; background: transparent; padding: 2px 5px; border-radius: var(--r-ctl); outline: none; }
.glvrow .lvname:hover { border-color: var(--border); }
.glvrow .lvname:focus { border-color: var(--accent-ui); background: var(--bg); color: var(--text); }
.glvrow .lvname.named { color: var(--text); }
.glvrow .ic.del { cursor: pointer; color: var(--text-faint); }
.glvrow .ic.del:hover { color: var(--danger); }
.glvadd { padding: 4px 7px; text-align: center; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); border-top: 1px solid var(--border); }
.glvadd:hover { color: var(--accent); background: var(--bg); }
/* Beams To Plot 多波束多选列表（SATSOFT 风格） */
/* 列表高度：原 132px 只露 ~5 行，几十个波束时勾选/改名要一直小幅滚动，难操作 → 放到 300px（~12 行）。
   仍是 max-height：波束少时照常按内容收缩，不留空框；右下角可竖向拖拽压扁，给下方「电平」等设置让位。
   同一类名亦用于性能表设置窗的「波束筛选」，两处一并加长。 */
/* 波束筛选勾选列表：与覆盖分析侧栏的 Beams To Plot、对星性能表同一套交互与样式（改动请三处对照）。
   position:relative 是给 offsetTop 定基准的（刷选按行的 offsetTop 二分查行，见 useCheckList）。 */
.bplist { position: relative; border: 1px solid var(--border); border-radius: var(--r-ctl); margin-top: 5px; max-height: 300px; min-height: 48px; overflow-y: auto; resize: vertical; outline: none; }
.bplist:focus-visible { box-shadow: inset 0 0 0 1px var(--accent-ui); }
.brow { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: default; font-size: var(--fs-3); user-select: none; }
.brow + .brow { border-top: 1px solid var(--border); }
.brow:hover { background: var(--bg); }
.brow.on { background: color-mix(in srgb, var(--accent-ui) 13%, transparent); }
.brow.on:hover { background: color-mix(in srgb, var(--accent-ui) 20%, transparent); }
.brow.cur { outline: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: -1px; }
/* 复选框只当显示件：所有指针交互都归行 —— 否则原生勾选框自带的那次切换会与刷选各翻一遍、互相抵消 */
.brow input[type=checkbox] { pointer-events: none; }
.brow .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.brow .bpk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
/* 性能表波束筛选：只读波束名（不可编辑，带省略号）——区别于卫星天线树里可改名的 .bnm-in */
.brow .pbnm { flex: 1; min-width: 0; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brow.on .pbnm { color: var(--text); }
/* Excel 式「(全选)」主行：置顶 sticky、随列表滚动常驻；三态复选框（全/半/无） */
.brow.ball { position: sticky; top: 0; z-index: 1; background: var(--bg); border-bottom: 1px solid var(--border); }
.brow.ball + .brow { border-top: 0; }
.brow .balln { flex: 1; color: var(--text); font-weight: 600; }
/* 两级覆盖：卫星卡 / 批次 */
.satcard { border-left: 2px solid var(--accent); }
.sath { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.satn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.satn em { color: var(--text-muted); font-style: normal; font-weight: 400; font-size: var(--fs-2); }
.seg.sm .sg { padding: 2px 7px; font-size: var(--fs-2); }
.ic { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 1px; }
.ic:hover { color: var(--text); }
.ic.del:hover { color: var(--danger); }
.ic.ok { color: var(--ok); font-weight: 700; }
.ic.ok:hover { color: color-mix(in srgb, var(--ok) 75%, var(--text)); }
.batch { border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 7px 8px; margin-top: 8px; }
.bah { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.bnm { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bnm:focus { border-color: var(--accent-ui); }
.rng { flex: 1; min-width: 0; }
/* .srow 里的取色框铺满整行（描边/内衬由 controls.css 基线给，这里只管铺开） */
.clr { flex: 1; min-width: 0; height: 22px; }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
/* 色块：描边从墨色混出（任何色块上都有一道边），选中是隔一圈纸色的墨环 —— 机位色环落在蓝色海洋色块上读不出 */
.sw { width: 24px; height: 24px; border-radius: var(--r-box); border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
      cursor: pointer; box-sizing: border-box; transition: border-color var(--dur-1) linear; }
.sw:hover { border-color: color-mix(in srgb, var(--text) 45%, transparent); }
.sw.on { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--sel-fill); }
.sw.swmix { background: conic-gradient(#8fa89b 0 25%, #9fb0c0 0 50%, #c0a99f 0 75%, #b0a98f 0); }
.swd { flex: none; width: 14px; height: 14px; border-radius: var(--r-box); border: 1px solid color-mix(in srgb, var(--text) 14%, transparent); }
.rowlk { cursor: pointer; }
.bsub { display: flex; align-items: center; gap: 8px; margin: 7px 0 4px; color: var(--text-muted); font-size: var(--fs-3); }
.bsub .lnk { color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.bsub .cnt2 { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2); }
/* 边界线分组的小色条图例：颜色/线型由 swStyle 行内给（跟着设置走），这里只留几何 */
.bsub .bsw { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; flex: 0 0 auto; }
.bsub .lnk { margin-left: auto; }
/* 行内链接（「恢复本类默认」、子标题行尾动作）：与分区标题行尾同一档——浅灰、可点、悬停回墨 + 下划线 */
.srow > .lnk, .bsub .lnk { color: var(--text-muted); cursor: pointer; transition: color var(--dur-1) linear; }
.srow > .lnk:hover, .bsub .lnk:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
/* 只有名字的子标题：名字后拉一条细线到行尾，读成「以下一组」的分组头而不是一行孤零零的灰字
   （排除「配色」那行：文字直写在 .bsub 里、唯一的 span 是分段控件，不是名字） */
.bsub:has(> span:only-child:not(.lnk):not(.seg))::after { content: ''; flex: 1 1 auto; min-width: 12px; border-top: 1px solid color-mix(in srgb, var(--border) 65%, transparent); }
.bq { display: block; width: 100%; box-sizing: border-box; margin-bottom: 5px; border: 1px solid var(--field-border); background: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bq:focus { border-color: var(--accent-ui); }
.chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.pglist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pgrow { display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; }
.addbatch { margin-top: 8px; text-align: center; border: 1px dashed var(--border); padding: 4px; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.addbatch:hover { border-color: var(--line-hover); background: var(--surface); }
.legend { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.legend .lrow { display: flex; align-items: center; gap: 6px; }
.legend .lname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-2); color: var(--text); }
.legend .lname em { color: var(--text-muted); font-style: normal; }
.legend .lsw { width: 22px; height: 10px; flex: none; border: 1px solid var(--border); }
.legend .lbar2 { width: 56px; height: 10px; flex: none; border: 1px solid var(--border); background: linear-gradient(to right, hsl(240,90%,55%), hsl(120,90%,55%), hsl(0,90%,55%)); }
.legend .lsc2 { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); flex: none; }
/* Polygon（协调区多边形）卡片：题头条（勾选/线色/名称/顶点数/删除）+ 两列信息栅格 + 样式滑杆 + 4列等宽操作网格 */
.plg { border: 1px solid var(--border); border-radius: var(--r-card); margin-top: 8px; padding: 0 9px 9px; background: color-mix(in srgb, var(--surface) 55%, transparent); }
.plg.act { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent-ui); }
/* 隐藏的多边形：卡身退到后景，卡头（拨杆/配色/名字/删除）留亮 —— 与标记分区、环境场同一套因果反馈 */
.plg > :not(.plgh) { transition: opacity .15s; }
.plg.hid > :not(.plgh) { opacity: .5; }
.plgh { display: flex; align-items: center; gap: 6px; margin: 0 -9px 8px; padding: 6px 9px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 60%, transparent); border-radius: var(--r-box) var(--r-box) 0 0; }
.plgh .plgnm { border-color: transparent; background: transparent; font-weight: 600; font-size: var(--fs-3); }
.plgh .plgnm:hover { border-color: var(--field-border-hover); }
.plgh .plgnm:focus { border-color: var(--accent-ui); background: var(--field-bg); }
.plgi { flex: none; color: var(--text-faint); font-size: var(--fs-2); font-family: var(--font-mono); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 0 7px; line-height: 15px; white-space: nowrap; }
.plgg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
.plgf { display: flex; align-items: center; gap: 5px; min-width: 0; }
.plgf.w2 { grid-column: 1 / -1; }
.plgr { display: flex; align-items: center; gap: 6px; }
.plgg + .plgr, .plgr + .plgr, .plgr + .plgops, .plgops + .plgr, .plgg + .plgops { margin-top: 7px; }
.plgr.sub { color: var(--text-muted); font-size: var(--fs-3); }
.plgr.sub .u { flex: none; color: var(--text-faint); font-size: var(--fs-2); min-width: 20px; text-align: right; font-family: var(--font-mono); }
.plgr.sub .u.pct { min-width: 30px; }
.plgl { flex: none; width: 26px; color: var(--text-muted); font-size: var(--fs-2); text-align: justify; text-align-last: justify; }
.plgu { flex: none; color: var(--text-faint); font-size: var(--fs-2); }
.plgn { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); outline: none; border-radius: var(--r-ctl); }
.plgv { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); outline: none; font-family: var(--font-mono); border-radius: var(--r-ctl); }
.plgn:focus, .plgv:focus { border-color: var(--accent-ui); }
.plgc { flex: none; width: 26px; }
/* 操作按钮组：4 列等宽网格（上排编辑态、下排生成类），整齐对位 */
.plgops { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; }
.opb { text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 0; cursor: pointer; font-size: var(--fs-2); border-radius: var(--r-ctl); white-space: nowrap; transition: color .12s, border-color .12s, background .12s; }
.opb:hover { border-color: var(--line-hover); color: var(--text); }
.opb.on { border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 10%, transparent); font-weight: 600; }
.opb.danger:hover { border-color: var(--danger); color: var(--danger); }
.opb.danger.on { border-color: color-mix(in srgb, var(--danger) 60%, transparent); color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); font-weight: 600; }
/* 成排等宽的按钮（网格里那几组）：钮名挤不下就折行。钮本身 white-space: nowrap，配上 1fr 轨道的
   auto 下限，长钮名（英文尤甚）会把整排顶出侧栏右沿 —— 轨道已改 minmax(0,1fr)，这里放开折行。 */
.bs-addrow .opb, .bs-navops .opb, .bs-ops .opb, .plgops .opb { white-space: normal; line-height: 1.3; }
.plgta { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 84px; resize: vertical; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text); font-family: var(--font-mono); font-size: var(--fs-2); padding: 4px 6px; outline: none; }
.plgta:focus { border-color: var(--accent-ui); }
/* 顶点表：文本框 + 右下「复制两列」按钮（Tab 分隔，粘到 Excel 自动分成经度/纬度两列） */
.plgvt { margin-top: 6px; display: flex; flex-direction: column; }
.plgvt .plgta { margin-top: 0; }
.plgcp { align-self: flex-end; display: inline-flex; align-items: center; gap: 4px; margin-top: 5px; padding: 2px 9px; border: 1px solid var(--border); border-radius: var(--r-ctl); color: var(--text-muted); font-size: var(--fs-2); cursor: pointer; white-space: nowrap; }
.plgcp:hover { border-color: var(--line-hover); color: var(--text); }
.expb2 { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 0; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-3); }
.expb2:hover { border-color: var(--line-hover); color: var(--text); }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }   /* 左右 16 = .sec，与分区内容同一条起跑线 */
/* 紧跟在分区后面时，上一节的 border-bottom 就是这条分隔线，自己不再画，否则叠成两像素粗线（侧栏停靠即按内容高，页脚恒贴着上一节） */
.sec + .csfoot { border-top: 0; }
.cst { font-size: var(--fs-2); color: var(--text-faint); }
.cclr { margin-left: auto; font-size: var(--fs-3); color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; }
.cclr:hover { border-color: var(--line-hover); color: var(--text); }

/* 标记面板 */
.addb { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-3); }
.addb:hover { background: var(--primary-fill); border-color: var(--primary-fill); color: var(--primary-on); }
/* 侧栏小按钮家族（.mini / .expb2 / .cclr / .opb 都是 span）：同一种结构线、同高 --h-ctl、同一套悬停 / 按下 */
.mini, .expb2, .cclr { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: var(--h-ctl);
                       padding-top: 0; padding-bottom: 0; border: 1px solid var(--border-strong); border-radius: var(--r-ctl);
                       color: var(--text-muted); white-space: nowrap; cursor: pointer; transition: var(--t-state); }
.opb { border-color: var(--border-strong); transition: var(--t-state); }
/* .expb2 在 .csfoot 里是 flex:1 三等分：放开折行、高度改下限，窄侧栏 / 英文长钮名折成两行而不顶出右沿（单行仍 16+4+2=22） */
.expb2 { white-space: normal; height: auto; min-height: var(--h-ctl); line-height: 16px; padding-top: 2px; padding-bottom: 2px; text-align: center; }
.mini:hover, .expb2:hover, .cclr:hover { border-color: var(--line-hover); color: var(--text); }
.mini:active, .expb2:active, .cclr:active, .opb:active { box-shadow: var(--press); transition-duration: 0s; }
.mini.dis { opacity: .45; pointer-events: none; }
.addb { transition: var(--t-state); }
.ci.nrw { width: 0; }
.mlist { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; }
/* 连体表：一圈外框 + 行间淡线，不再是一摞各自带框的小卡片（行无过渡） */
.mlist { gap: 0; border: 1px solid var(--border); border-radius: var(--r-ctl); }
.mlist:not(:has(> .mrow)) { border: 0; }                     /* 点 / 站列表空时不画空框 */
.mlist > .mrow { border: 0; padding: 7px 8px; }
.mlist > .mrow + .mrow { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
.mlist > .mrow.rowlk:active { background: var(--wash-hover); }
.mlist > .mrow.active { background: color-mix(in srgb, var(--accent-ui) 12%, transparent); box-shadow: inset 2px 0 0 var(--accent-ui); }
/* 主从列表（边界线七类 / 地名三级）条目固定，不滚 —— 150px 上限是给可能几十条的国家清单的 */
.mlist.pick { max-height: none; overflow: hidden; }   /* hidden 只为把行底裁进外框圆角，条目固定本就不滚 */
/* 列表后面直接跟参数行：.srow 只有下外边距，不补就是外框底线贴着下一格的输入框，读成一条双线；给行距同款 8 */
.mlist + .srow { margin-top: 8px; }
/* 国家清单：全量 247 条可滚，给足一屏的高度（150px 只够四行半，翻起来太碎） */
.mlist.tall { max-height: 260px; }
.mrow { display: flex; align-items: center; gap: 6px; }
.mrow .mc { flex: 1; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); }
/* 点标记序号：与图上的「圈 N」、点标记表格的行号同一个号（右对齐固定宽，坐标才对得齐） */
.mrow .mno { flex: none; min-width: 12px; margin-right: -3px; text-align: right; font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); }
/* 主从列表里的中文条目名：不用等宽（那是给代号/坐标的），按正文字号走 */
.mrow .mc.lbl { font-family: inherit; font-size: var(--fs-3); color: var(--text); }
.mrow .bsw { flex: 0 0 auto; width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; }
.mrow .cnt2 { margin-left: auto; flex: none; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
/* 图层关掉时整节压暗（与标记 / 聚焦两栏同一手感） */
.geo-side .sec > :not(.sect) { transition: opacity var(--dur-2) linear; }
.geo-side .sec.hid > :not(.sect) { opacity: .5; }
.mrow .mc2 { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
.mrow .sni { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); outline: none; color: var(--text); }
/* 逐条颜色（列表行 / 航迹卡里那枚小色块）：显示的是这一条【当前的实际颜色】——
   没单独设过就是整层设置那个色，设过了加一圈机位色描边，一眼看得出哪几条被单独改过。
   右键＝清除覆盖（回到整层设置）；这一层没有「留空」这种状态可供色轮表达，故靠右键。 */
.mrow .clr.mkc, .trow .clr.mkc { flex: none; width: 22px; height: 16px; min-width: 0; }
.mrow .clr.mkc.ov, .trow .clr.mkc.ov { border-color: var(--accent-ui); box-shadow: 0 0 0 1px var(--accent-ui); }
.del { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 2px; }
.del:hover { color: var(--danger); }
/* 隐藏的点 / 站 / 航迹：拨杆留亮，其余退到后景（同 .plg.hid） */
.mrow.hid > :not(.layersw), .tcard.hid > :not(.trow), .tcard.hid > .trow > :not(.layersw) { opacity: .5; }
.tcard { border: 1px solid var(--border); padding: 6px; margin-bottom: 6px; border-radius: var(--r-card); }
.tcard.act { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent-ui); }
.trow { display: flex; align-items: center; gap: 6px; }
.trow .tk { width: 10px; height: 10px; flex: none; border-radius: var(--r-ctl); }
.trow .tk.sea { background: #ff6a4a; }
.trow .tk.flight { background: #5ad1ff; }
.trow .tni { flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--field-border); background: transparent; outline: none; color: var(--text); font-size: var(--fs-3); }
.trow .tsel { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); padding: 1px 7px; cursor: pointer; border-radius: var(--r-ctl); }
.trow .tsel.on { color: var(--accent); border-color: var(--accent); }
.twp { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.twp .wp { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 1px 5px; }
.twp .wdel { margin-left: 4px; cursor: pointer; color: var(--text-faint); }
.twp .wdel:hover { color: var(--danger); }
/* 「模型」小块（点 / 站行、航迹卡）：没挂 = 淡色立方体；挂了 = 16 px 缩略图 + 机位色描边（与逐条色块「设过了」同一语言）。
   点开选模型，右键卸下 */
.mchip { flex: none; box-sizing: border-box; width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  border: 1px solid var(--border); border-radius: var(--r-box); color: var(--text-faint); background: var(--field-bg); overflow: hidden;
  transition: border-color var(--dur-1) linear, color var(--dur-1) linear, background-color var(--dur-1) linear; }
.mchip:hover { border-color: var(--border-strong); color: var(--text-muted); }
.mchip.on { border-color: var(--accent-ui); box-shadow: 0 0 0 1px var(--accent-ui); color: var(--accent-ui);
  background: radial-gradient(ellipse at 50% 38%, color-mix(in srgb, var(--text) 9%, var(--surface)) 0%, var(--surface) 80%); }
.mchip img { width: 16px; height: 16px; object-fit: contain; border-radius: 2px; }
/* 站「跟踪」行：挂在站行下面、同属一格（列表里不画分隔线），下一站前补线 */
.mlist > .mtrk { margin: 0; padding: 0 8px 7px 8px; --srow-lab: 34px; flex-wrap: nowrap; }
.mlist > .mtrk select { min-width: 0; }
/* 跟踪目标：select 同款外观的触发器，点开下挂检索框（原生 select 装不下全量池） */
.mlist > .mtrk .trksel { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; height: var(--h-ctl); padding: 0 6px 0 7px; border: 1px solid var(--field-border); border-radius: var(--r-ctl); background: var(--field-bg); color: var(--text); font-size: var(--fs-3); cursor: pointer; }
.mlist > .mtrk .trksel:hover, .mlist > .mtrk .trksel.open { border-color: var(--field-border-hover); }
.mlist > .mtrk .trksel .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mlist > .mtrk .trksel .icon, .mlist > .mtrk .trksel svg { flex: none; color: var(--text-faint); }
.mlist > .mtrk .trkel { flex: none; margin: 0; gap: 4px; white-space: nowrap; }
.mlist > .mtrkpop { padding: 0 8px 7px 42px; }
.mlist > .mtrkpop .ci { width: 100%; margin-bottom: 4px; }
.mlist > .mtrkpop .sres { margin-bottom: 0; }
.mlist > .mtrkpop .sitem.on .nm { color: var(--accent); }
.mlist > .mtrk .u { min-width: 88px; font-family: var(--font-mono); font-size: var(--fs-2); }
.mlist > .mtrk + .mrow, .mlist > .mtrkpop + .mrow { border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent); }
/* 航迹运动行：折叠态一行摘要（运动档着色），展开三行参数 + 读数 */
.tmot { margin-top: 5px; }
.tmh { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; color: var(--text-faint); margin-inline: -2px; padding: 1px 2px; border-radius: var(--r-box); transition: background-color var(--dur-1) linear; }
.tmh:hover { background: color-mix(in srgb, var(--text) 5%, transparent); color: var(--text-muted); }
.tmh .tms { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.tmh .tms.on { color: var(--accent-ui); }
.tmot.open > .tmh { margin-bottom: 6px; }
.tmot .srow.sub { --srow-lab: 56px; padding-left: 17px; margin-bottom: 6px; }
.tmot .srow.sub .u { min-width: 30px; }
.tmot .t0i { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.tmot .tmr { margin-bottom: 2px; }
.tmot .tmr .rdv { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); font-variant-numeric: tabular-nums; }

.lnknm { cursor: pointer; }
.lnknm:hover { color: var(--accent); }
.tip2 { color: var(--text-faint); font-size: var(--fs-2); line-height: 1.6; }
.tip2 .lnk { margin-left: 6px; color: var(--accent); cursor: pointer; }

/* 卫星编辑弹窗 */
.sat-mask { position: absolute; inset: 0; background: var(--scrim); display: flex; align-items: center; justify-content: center; z-index: 40; }
/* 编辑卫星：输入即生效（applySatLive），所以这一个弹窗不压暗、不居中、不吃鼠标——靠地图左边停着，
   球体照转照缩，改经度/仰角值/颜色当场在图上看结果。其余共用 .sat-mask 的弹窗不受影响 */
.sat-mask.sat-live { background: none; justify-content: flex-start; padding-left: 12px; pointer-events: none; }
.sat-mask.sat-live > .sat-dlg { pointer-events: auto; }
/* 编辑卫星没有页脚（改一处落一处，没有「保存 / 取消」可点），关闭键与「文件管理」同一颗：
   Windows 风矩形热区、贴着标题栏右上角、悬停变红。故这条标题栏不吃内边距，由标题自己带 */
.sdh.sdh-win { align-items: stretch; padding: 0; }
.sdh.sdh-win .sdt { padding: 11px 14px; align-self: center; }
/* 从文件管理器（z2000 浮层）调起时，提升到其上方并改 fixed，以便两个弹窗共存 */
.sat-mask.sat-overlay { position: fixed; z-index: 2100; }
/* 对话框框体：全软件一档（--r-card + --shadow-3 + 160ms 上浮入场）；遮罩走 --scrim、瞬时出现，出场瞬时 */
.sat-dlg { width: 320px; max-height: 86%; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-card); box-shadow: var(--shadow-3); display: flex; flex-direction: column; animation: ui-dlg-in var(--dur-3) var(--ease-out); }
.sdh { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); }
.sdh .csx { margin-left: auto; cursor: pointer; color: var(--text-faint); }
.sdbody { padding: 12px 14px; }
.sdbody .srow { --srow-lab: 64px; }
.geobtn { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: var(--fs-2); }
.geobtn:hover { background: var(--primary-fill); border-color: var(--primary-fill); color: var(--primary-on); }
.sdiv { margin: 12px 0 8px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-3); }
.sdbody .sdiv:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.pickbtn { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); }
.pickbtn:hover { border-color: var(--line-hover); color: var(--text); }
.pmode { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); }
.pmode:hover { border-color: var(--line-hover); color: var(--text); }
.pmode.on { border-color: var(--sel-fill); background: var(--sel-fill); color: var(--sel-on); }
.sres { border: 1px solid var(--border); max-height: 150px; overflow-y: auto; margin-bottom: 8px; }
.sresi { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); }
.sresi:hover { background: var(--bg); }
.sresi .srn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.sresi em { flex: none; font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
/* 实时气象「链路参数」的目标星选择：与对星跟踪（GrdSetSections）同款——一行一颗、星名 +
   「来源 · NORAD」副行、底下一行命中读数。★ 另起 .lv-sres 而不是直接用上面那个 .sres：
   那个是「添加卫星」弹窗里的紧凑单行下拉（自带 150px 滚动），这里的列表自己带滚动条，
   两层滚动叠在一起会滚不动内层。 */
.tgtnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: var(--fs-3); }
.tgtnm.bad { color: var(--warn); }
.lv-sres { max-height: none; overflow: visible; background: var(--bg); }
.lv-sres .sres-list { max-height: 210px; overflow-y: auto; }
.lv-sres .sitem { padding: 4px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.lv-sres .sitem:last-child { border-bottom: 0; }
.lv-sres .sitem:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.lv-sres .sitem .nm { font-size: var(--fs-3); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lv-sres .sitem .sub { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.lv-sres .sres-e { padding: 6px 8px; font-size: var(--fs-3); color: var(--text-faint); }
.lv-sres .sres-n { padding: 3px 8px; border-top: 1px solid var(--border); font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.sdfoot { display: flex; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
.sdfoot .cancel { margin-left: auto; color: var(--text-muted); border: 1px solid var(--border); padding: 4px 14px; cursor: pointer; font-size: var(--fs-3); }
.sdfoot .cancel:hover { color: var(--text); }
/* 墨色主按钮走 primary token：浅色逐字节仍是墨，深色压一档；悬停 / 禁用各有一档（span 充当按钮，按下罩就地写） */
.sdfoot .save { background: var(--primary-fill); color: var(--primary-on); padding: 4px 18px; cursor: pointer; font-size: var(--fs-3); transition: var(--t-state); }
.sdfoot .save:not(.ghost):hover { background: var(--primary-fill-hover); }
.sdfoot .save:active { box-shadow: var(--press); transition-duration: 0s; }
/* —— 卫星组管理器：左＝组列表，右＝改名 + 搜索添加 + 成员表 —— */
.sgm-dlg { width: 780px; max-width: calc(100% - 32px); height: 76vh; max-height: 660px; overflow: hidden; }
.sgm-body { flex: 1; min-height: 0; display: flex; }
.sgm-left { flex: 0 0 200px; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
.sgm-lt { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-size: var(--fs-3); color: var(--text-muted); border-bottom: 1px solid var(--border); flex: none; }
.sgm-lt em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); }
.sgm-lt .lnk { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; color: var(--accent); cursor: pointer; }
.sgm-glist { flex: 1; min-height: 0; overflow-y: auto; }
.sgm-grow { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); }
.sgm-grow:hover { background: var(--surface-2); color: var(--text); }
.sgm-grow.cur { background: color-mix(in srgb, var(--accent-ui) 14%, transparent); color: var(--text); }
.sgm-grow .gnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgm-grow .gcnt { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
/* 组色点：恒占位保持名字列对齐；未着色=空心圈 */
.sgm-grow .gdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.sgm-grow .gdot.off { box-shadow: inset 0 0 0 1px var(--text-faint); opacity: .45; }
.sgm-grow .gic { flex: none; display: inline-flex; color: var(--text-faint); cursor: pointer; padding: 1px; opacity: 0; }
.sgm-grow:hover .gic, .sgm-grow.cur .gic { opacity: 1; }
.sgm-grow .gic:hover { color: var(--text); }
.sgm-grow .gic.del:hover, .sgm-grow .gic.del.warn { color: var(--danger); }
.sgm-right { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 10px 12px; overflow: hidden; }
.sgm-name { display: flex; align-items: center; gap: 8px; flex: none; }
.sgm-name > label { flex: none; font-size: var(--fs-3); color: var(--text-muted); }
/* 着色行：十色快捷板 + 取色器 + 色号读数 + 恢复默认 */
.sgm-clr { display: flex; align-items: center; gap: 5px; flex: none; margin-top: 8px; }
.sgm-clr > label:first-child { flex: none; font-size: var(--fs-3); color: var(--text-muted); margin-right: 3px; }
.sgm-clr .pz { flex: none; width: 13px; height: 13px; border-radius: var(--r-box); cursor: pointer; box-sizing: border-box; border: 1px solid rgba(0,0,0,.3); }
.sgm-clr .pz:hover { box-shadow: 0 0 0 1px var(--text-muted); }
.sgm-clr .pz.on { box-shadow: 0 0 0 1.5px var(--accent); }
.sgm-clr .pgclr.lg { width: 18px; height: 18px; margin-left: 3px; }
.sgm-clr .pgclr.lg .pgsw { width: 15px; height: 15px; }
.sgm-clr .hexv { flex: none; min-width: 52px; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.sgm-clr .gbtn { margin-left: auto; }
/* 「着色所选」：gbtn 外观 + 铺满的隐形取色器（dis 时随 .gbtn.dis 一起失效） */
.sgm-right .gbtn.clr { position: relative; }
.sgm-right .gbtn.clr input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.sgm-sec { flex: none; margin: 11px 0 5px; font-size: var(--fs-2); color: var(--text-muted); }
.sgm-sec em { font-style: normal; color: var(--text-faint); }
.sgm-srch, .sgm-memtool { display: flex; align-items: center; gap: 6px; flex: none; }
.sgm-right .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; }
.sgm-right .ci:focus { border-color: var(--accent-ui); }
.sgm-right .gbtn { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 3px 8px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; }
.sgm-right .gbtn:hover { color: var(--text); border-color: var(--line-hover); }
.sgm-right .gbtn.danger:hover { color: var(--danger); border-color: var(--danger); }
.sgm-right .gbtn.dis { opacity: .4; pointer-events: none; }
.sgm-pickbar .save.dis { opacity: 1; background: var(--primary-fill-disabled); border-color: transparent; color: var(--primary-on); cursor: default; pointer-events: none; }
.sgm-reslist { flex: 1 1 42%; min-height: 76px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: var(--r-card); }
.sgm-memlist { flex: 1 1 58%; min-height: 76px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: var(--r-card); }
.sgm-ck { display: flex; align-items: center; gap: 7px; padding: 4px 8px; font-size: var(--fs-3); color: var(--text); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.sgm-ck:hover { background: var(--surface-2); }
.sgm-ck input { flex: none; }
.sgm-ck .cn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgm-ck em { flex: none; font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.sgm-ck em.miss { color: #d9a441; }
.sgm-ck b { flex: none; font-weight: 400; font-size: var(--fs-1); color: var(--accent); }
.sgm-ck.dim { color: var(--text-faint); }
.sgm-ck .gic { flex: none; display: inline-flex; color: var(--text-faint); cursor: pointer; padding: 1px; }
.sgm-ck .gic.del:hover { color: var(--danger); }
.sgm-pickbar { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 6px; font-size: var(--fs-3); color: var(--text-muted); }
.sgm-pickbar b { color: var(--text); }
.sgm-pickbar .lnk { color: var(--accent); cursor: pointer; }
.sgm-pickbar .save { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; background: var(--primary-fill); color: var(--primary-on); padding: 3px 12px; border-radius: var(--r-card); cursor: pointer; font-size: var(--fs-3); transition: var(--t-state); }
.sgm-pickbar .save:hover { background: var(--primary-fill-hover); }
.sgm-pickbar .save:active { box-shadow: var(--press); transition-duration: 0s; }
.sgm-empty { padding: 12px 10px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.6; }
.sgm-empty.big { margin: auto; text-align: center; max-width: 300px; }
.sgm-dlg .sdfoot { justify-content: flex-end; flex: none; }
/* 应用内提示弹窗：消息文本 + 右对齐「确定」 */
.al-dlg { width: 360px; }
.al-msg { margin: 0; font-size: var(--fs-4); line-height: 1.65; color: var(--text); }
.al-dlg .sdfoot { justify-content: flex-end; }
/* 发送到小程序：密钥展示 */
.sdfoot .save.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
.sat-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: var(--fs-3); color: var(--text); box-shadow: var(--shadow-2); }
.sat-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }
.traj-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: var(--fs-3); color: var(--text); box-shadow: var(--shadow-2); }
.traj-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }
/* 入场走独立的 translate 属性，不会冲掉横幅自身 transform: translateX(-50%) 的居中 */
.sat-banner, .traj-banner { animation: ui-float-in var(--dur-2) var(--ease-out); }
.sat-banner .lnk:hover, .traj-banner .lnk:hover { text-decoration: underline; }
/* 右侧信息栏开着时横幅按「地图区」居中（--rdk-eff 由 rdkMeasure 写在 .g3 上，收起为 0） */
.sat-banner, .traj-banner { left: calc((100% - var(--rdk-eff, 0px)) / 2); }

/* 地图右键上下文菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 60; }
/* 命令菜单口径（与菜单栏下拉同一套）：机位色实底悬停、项圆角与外框同心（外框 6 − 内距 3 = 3）；
   入场只淡入（光标处弹出、位置会翻转），不动 transform —— JS 对 ctxMenuEl 的量测不受影响 */
.ctx-menu { position: fixed; z-index: 61; min-width: 190px; max-height: calc(100vh - 8px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-float); box-shadow: var(--shadow-2); padding: 3px; font-size: var(--fs-4); color: var(--text); animation: ui-fade-in var(--dur-2) var(--ease-out); }
.ctx-item { padding: 5px 12px; border-radius: var(--r-box); cursor: pointer; white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ctx-item:hover { background: var(--accent-ui); color: var(--bg); }
.ctx-item.dis, .ctx-item.dis:hover { color: var(--text-faint); opacity: 1; cursor: default; background: none; }
.ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }
.ctx-kb { color: var(--text-faint); font-size: var(--fs-2); }
.ctx-item:hover .ctx-kb { color: inherit; opacity: .75; }
.ctx-kb.rdk-pf { max-width: 12em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }   /* 右键「上一聚焦」行尾：主选名是数据，可省略 */


</style>
