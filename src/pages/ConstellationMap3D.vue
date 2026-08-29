<script setup>
import { ref, reactive, shallowRef, computed, watch, nextTick, onMounted, onBeforeUnmount, toRef } from 'vue'
import { cursor } from '../stores/cursor'
import { view } from '../stores/view'
import { covNav } from '../stores/coveragePanels'
import { zoom } from '../stores/zoom'
import { effective as displayQuality } from '../stores/displayQuality'
import { viewPrefs } from '../stores/viewPrefs'
import { setGrdBridge, clearGrdBridge, fileBridge, bumpCustomSats } from '../stores/fileBridge'
import { shellUi, sideCtx } from '../stores/shellUi'
import { isSecOpen, toggleSec } from '../stores/panelSections'
import { clock, onTick, goLive, togglePlay, setTime as clockSetTime, stepBy as clockStepBy, setStep as clockSetStep, setSpeed as clockSetSpeed, releaseClock, resumeClock, effective as clockEff, restoreState as clockRestore } from '../stores/simClock'
import { STEP_PRESETS, SPEED_PRESETS, cursorSnapSec, followWindow, snapMs, fmtStepShort, fmtRate, fmtOffset } from '../shared/simClockCore.js'
import { logMsg } from '../stores/log'
import { alertMsg, appAlert, closeAlert } from '../stores/alert'
import { displaySatName } from '../viz/satName.js'
import { serializeGxt } from '../viz/gxt/serialize.js'
import { parseGxt } from '../viz/gxt/parse.js'
import { serializeKml } from '../viz/kml/serialize.js'
import { parseKmlPolys } from '../viz/kml/parse.js'
import Icon from '../components/Icon.vue'
import NumBox from '../components/NumBox.vue'
import SatList from '../components/SatList.vue'
import MiniSendDialog from '../components/MiniSendDialog.vue'
import { MINI_COVERAGE_SATS, satKey, inMiniList } from '../shared/miniSatList.js'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
import { IMAGERY_SOURCES, DEFAULT_IMAGERY, imagerySource, loadImagery } from '../viz/imagery.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
import { LAND as LAND_MORANDI, LAND_UNIFORMS, LAND_DEFAULT, migrateLandOverrides } from '../viz/landPalette.js'
import { countryAt, currentLandColor, countryList } from '../viz/globe3d/countryPick.js'
import { BORDER_DEF, GRID_STEPS } from '../viz/geo/borderStyle.js'
import { onPovChange, getPov } from '../viz/geo/povResolver.js'
import { POV_META, CUSTOM_POV, povTableOf, normMapPov } from '../viz/geo/povList.js'
import { CUSTOMIZABLE_DISPUTES, OWNER_ZH } from '../viz/geo/frozen.js'
import { getMapPov, onMapPov, saveMapPov } from '../stores/mapPov.js'
import { admIndex, loadPack, mergePacks } from '../viz/geo/admPacks.js'
import { mapCrs, setMapCrs, MAP_CRS_DEF, lon0ToCenter, centerToLon0 } from '../stores/mapCrs.js'
import { waterList } from '../viz/geo/waterNames.js'
import { CHAINS, CHAIN_DEF } from '../viz/geo/islandChains.js'
import { DATUMS } from '../viz/geo/datum.js'
import { FORMATS } from '../viz/geo/coordFormat.js'
import { useGrdCoverage } from '../viz/grd/useGrdCoverage.js'
import { useBeamSynth } from '../viz/grd/useBeamSynth.js'
import { useVisibility, orbitClass } from '../viz/vis/useVisibility.js'
import { useEnvField } from '../viz/env/useEnvField.js'
import { useLiveField } from '../viz/env/useLiveField.js'
import { usePerfTable } from '../viz/grd/usePerfTable.js'
import { useShellCoverage } from '../viz/grd/useShellCoverage.js'
import { useSatPerfTable } from '../viz/grd/useSatPerfTable.js'
import { sampleBeamAtEcef } from '../viz/grd/coverage.js'
import SatCovPanel from '../components/SatCovPanel.vue'
import SatCovWindows from '../components/SatCovWindows.vue'
import SatCovShellPicker from '../components/SatCovShellPicker.vue'
import GrdSetSections from '../components/GrdSetSections.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import { useCheckList } from '../shared/ui/useCheckList.js'
import ExcelGrid from '../components/ExcelGrid.vue'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, sheetToTsv, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { useMarkerTable, trajsFromSheets } from '../viz/markers/useMarkerTable.js'
import sat from '../viz/constellation/satellite.js'
import { sampleOrbitAdaptive } from '../viz/constellation/adaptiveSample.js'
import { ringTtlMs } from '../viz/constellation/focusGeomCache.js'
import { createFocusGeomPool } from '../viz/constellation/focusGeomPool.js'
import { footprintRing } from '../viz/constellation/focusFootprint.js'
import { solarGeometry } from '../viz/terminator.js'
import * as W from '../viz/wgs84.js'
import { parseOMMCsv, fetchGroupLiveOrSup } from '../viz/constellation/tle.js'
import { useCustomConstellations, customConstellationsToOmmRecords, NORAD_BASE } from '../viz/constellation/useCustomConstellations.js'
import { useSatGroups } from '../viz/constellation/useSatGroups.js'
import { makeSatSetItem } from '../shared/satconMiniExport.js'
import { walkerCode, orbitPeriodMin, validateWalker } from '../viz/constellation/walker.js'
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
const groupIndex = ref(DEFAULT_GROUP)
const status = ref('')          // 卫星加载状态：仅显示在左侧星座面板 pstat 行（后台静默加载，不再弹中央横幅）；导出反馈不走此处
const satCount = ref(0)     // 该组卫星总数
const shownCount = ref(0)   // 实际渲染点数
const dataTime = ref('')
// 「实时」＝仿真时钟跟随系统时钟（clock.mode==='live'）。这里只读不写：改状态一律走时钟的 goLive/pause，
// 否则时钟自己的定时器与页面的标志位会各说各话。
const live = computed(() => clock.mode === 'live')
const nowTick = ref(0)      // 每拍自增：驱动时间条上随时刻走的读数（时钟推进 / 实时 / 拖游标都算一拍）
const autoRotate = toRef(viewPrefs, 'autoRotate')   // 自转开关：以 viewPrefs 为单一真相（设置弹窗共享）
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
// 晨昏线（昼夜分界）：默认关。时刻取时间轴当前值 calcAt()（非系统时钟）——拖时间轴 / 实时推进时随之移动，
// 与卫星星位同一个 UTC 时刻、同一个自转相位（GMST 复用 sat.gstime，见 viz/terminator.js）。
const termOn = ref(false)
const termNight = ref(true)     // 夜区半透明遮罩
const termLine = ref(true)      // 晨昏分界线
const termStyle = reactive({ nightColor: '#0a1120', nightOpacity: 0.42, lineColor: '#ffd27a', lineWidth: 1.2, lineOpacity: 0.75 })
const termSub = ref(null)       // 当前日下点 {lat, lon}，供侧栏读数（applyTerminator 时回填）
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
const searchResults = ref([])
const selected = ref(null)
const cardCollapsed = ref(false)   // 信息卡收起/展开（点标题栏切换）
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
  fpOn: true, fpColor: '#b8e6fa', fpWidth: 1.6, fpOpacity: 1, fpDash: 'dash',
  fpFillColor: '#b8e6fa', fpFillOpacity: 0,
  // 覆盖锥（卫星→覆盖圈边界的锥体，仅 3D）：锥面透明度 0＝只留母线，母线根数 0＝只留锥面，不另设开关
  coneOn: false, coneFaceColor: '#b8e6fa', coneFaceOpacity: 0.75,
  coneGenCount: 0, coneGenColor: '#b8e6fa', coneGenWidth: 1, coneGenOpacity: 0.55, coneGenDash: 'solid',
  cloudOn: true, dotOn: true, dotPx: 13, subOn: true, subPx: 30, subColor: '#ffffff',
  ringOn: true, ringColor: '#ffd27a', ringPx: 26
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
const satcovTableOpen = ref(false)

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
  satPosAt: (id, tMs) => liveSatPosAt(id, tMs)
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
// ===== 气象指标表（浮窗，与「性能指标表」同一套外壳与交互）=====
// 上：站点输入（可编辑 —— 站名 / 经度 / 纬度，先经后纬）；下：只读读数表，列 = 用户勾选的气象与链路指标。
// ★ 与性能指标表的唯一结构差别：读数**跟随时间轴** —— 时钟一动，下表整表重算（见 useLiveField 的 watch）。
const metTblOpen = ref(false)
const metWin = ref({ x: 0, y: 0, w: 820, h: 500, init: false })
const metInputH = ref(148)
const metOptsOpen = ref(false)
const metInCols = [
  { key: 'name', label: '站名' },
  { key: 'lon', label: '经度', num: true, unit: '°E' },
  { key: 'lat', label: '纬度', num: true, unit: '°N' }
]
// 站点库写入：经纬度是数字列（空串＝清空，非数字文本不落库）；站名随便填
function metSiteUpdate(id, key, val) {
  const s = envLive.sites.value.find((x) => x.id === id)
  if (!s) return
  if (key === 'name') { s.name = String(val == null ? '' : val); return }
  const t = String(val == null ? '' : val).trim()
  if (t === '') { s[key] = null; return }
  const n = Number(t)
  if (Number.isFinite(n)) s[key] = key === 'lat' ? Math.max(-90, Math.min(90, n)) : Math.max(-180, Math.min(180, n))
}
// id 走 useLiveField 那一支（时间戳 + 单调自增号）：这里建的与「从标记导入」建的是同一批站点，
// 两处必须共用同一个计数器。原先各自拼一个随机后缀，一次粘贴几十行就会撞出重复 id（见那边的注释）。
const metNewSite = (o) => ({ id: envLive.nextSiteId(), name: '', lon: null, lat: null, src: 'manual', ...o })
function metAddRow(at) {
  const list = envLive.sites.value
  const i = at == null || at < 0 || at > list.length ? list.length : at
  list.splice(i, 0, metNewSite({}))
}
// 区域粘贴：以锚点为左上角按列铺开（与性能表城市输入同口径）
function metPasteBlock(anchorId, startKey, text) {
  const list = envLive.sites.value
  const r0 = list.findIndex((x) => x.id === anchorId); if (r0 < 0) return 0
  const c0 = metInCols.findIndex((c) => c.key === startKey); if (c0 < 0) return 0
  const grid = String(text || '').replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((l) => l.split('\t'))
  grid.forEach((cells, dr) => {
    const ri = r0 + dr
    while (ri >= list.length) list.push(metNewSite({}))
    cells.forEach((v, dc) => { const c = metInCols[c0 + dc]; if (c) metSiteUpdate(list[ri].id, c.key, v) })
  })
  return grid.length
}
// 整块追加：≥2 列时按「末两列 = 经度、纬度」解析（与标记表/性能表的批量粘贴约定一致），
// 前面若还有一列就当站名。只有两列时即「经度 纬度」。
function metPasteAppend(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').trim().split('\n')
  let n = 0
  for (const l of lines) {
    const p = l.split(/\t|\s*,\s*|\s{2,}/).map((x) => x.trim()).filter((x) => x !== '')
    if (p.length < 2) continue
    const lat = Number(p[p.length - 1]), lon = Number(p[p.length - 2])
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
    envLive.sites.value.push(metNewSite({ name: p.length > 2 ? p.slice(0, p.length - 2).join(' ') : envLive.fmtLL(lon, lat), lon, lat }))
    n++
  }
  return n
}
const metInGrid = useGridSelect({
  gridId: 'met-in',
  rows: () => envLive.sites.value,
  cols: () => metInCols,
  cellText: (r, c) => (r[c.key] == null ? '' : String(r[c.key])),
  onEdit: (id, key, val) => metSiteUpdate(id, key, val),
  onPasteBlock: metPasteBlock,
  onPasteAppend: metPasteAppend,
  onClear: (cells) => cells.forEach(({ rowId, key }) => metSiteUpdate(rowId, key, '')),
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) metAddRow(at + k); return n },
  onDeleteRows: (ids) => { const s = new Set(ids); const before = envLive.sites.value.length; envLive.sites.value = envLive.sites.value.filter((x) => !s.has(x.id)); return before - envLive.sites.value.length },
  refresh: () => envLive.refreshSites()
})
const metResGrid = useGridSelect({
  gridId: 'met-res',
  rows: () => envLive.metRows.value,
  cols: () => envLive.metCols.value,
  readOnly: true,
  cellText: (r, c) => envLive.metText(r, c)
})
// 站点数一变（增删行/粘贴/导入）就重算读数；深监听坐标改动同理
watch(() => envLive.sites.value.map((s) => s.id + ':' + s.lon + ',' + s.lat).join('|'), () => envLive.refreshSites())

function metWinInit() {
  if (metWin.value.init) return
  const { w: vw, h: vh } = g3Size()
  const w = Math.min(820, vw - 48), h = Math.min(Math.round(vh * 0.66), vh - 48)
  metWin.value = { x: Math.max(12, Math.round((vw - w) / 2)), y: Math.max(12, Math.round(vh * 0.14)), w, h, init: true }
}
function openMetTable() { metWinInit(); metTblOpen.value = true; envLive.refreshSites(true) }
function closeMetTable() { metTblOpen.value = false; metOptsOpen.value = false }
function metDragMove(e) {
  if (e.button !== 0 || (e.target.closest && e.target.closest('.csx, .ptb, input, select, label'))) return
  e.preventDefault()
  const sx = e.clientX, sy = e.clientY, o = { ...metWin.value }
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    metWin.value = { ...metWin.value,
      x: Math.max(-o.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx))),
      y: Math.max(0, Math.min(vh - 32, o.y + (ev.clientY - sy))) }
  })
}
function metDragResize(e, dir = 'se') {
  if (e.button !== 0) return
  e.preventDefault(); e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, o = { ...metWin.value }
  const minW = 420, minH = 260
  const E = dir.includes('e'), W = dir.includes('w'), S = dir.includes('s'), N = dir.includes('n')
  perfDragSession((ev) => {
    const { w: vw, h: vh } = g3Size()
    let x = o.x, y = o.y, w = o.w, h = o.h
    const dx = ev.clientX - sx, dy = ev.clientY - sy
    if (E) w = Math.max(minW, Math.min(o.w + dx, vw - o.x - 6))
    if (S) h = Math.max(minH, Math.min(o.h + dy, vh - o.y - 6))
    if (W) { const nx = Math.min(o.x + dx, o.x + o.w - minW); w = o.w + (o.x - nx); x = nx }
    if (N) { const ny = Math.min(o.y + dy, o.y + o.h - minH); h = o.h + (o.y - ny); y = Math.max(0, ny) }
    metWin.value = { ...metWin.value, x, y, w, h }
  })
}
function metDragSplit(e) {
  if (e.button !== 0) return
  e.preventDefault()
  const sy = e.clientY, h0 = metInputH.value
  perfDragSession((ev) => {
    metInputH.value = Math.max(80, Math.min(metWin.value.h - 150, h0 + (ev.clientY - sy)))
  })
}
// 和风列对应的时刻与口径。★ 和风与模式取的是**同一个**时刻（都跟时间轴），
// 但和风按点源只有「本小时＝实况观测」与「未来＝逐小时预报」两段，故口径要摆出来。
const metObsAtText = computed(() => {
  const t = envLive.obsAt.value
  if (!t) return ''
  const d = new Date(t), p = (n) => String(n).padStart(2, '0')
  const kinds = new Set()
  for (const r of envLive.metRows.value) if (r.oKind) kinds.add(r.oKind)
  const k = kinds.size === 1 ? [...kinds][0] : (kinds.size ? '观测＋预报' : '')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}${k ? ' · ' + k : ''}`
})
const metColDef = (k) => envLive.MET_COL_DEFS.find((c) => c.key === k) || null
const metColLabel = (k) => { const c = metColDef(k); return c ? c.label + (c.unit ? '（' + c.unit + '）' : '') : k }
// 链路量离不开几何：没指定目标卫星（或选的星解算不出来）时这些指标勾了也没值，故置灰并在 title 里说明
const metColSatOff = (k) => { const c = metColDef(k); return !!(c && c.sat) && !envLive.satReady.value }
// 和风列要点过按钮才有值。不禁用（勾上再去取也合理），只置灰提示。
const metColObsOff = (k) => { const c = metColDef(k); return !!(c && c.obs) && !envLive.obsAt.value }
const metColOff = (k) => metColSatOff(k) || metColObsOff(k)
const metColTip = (k) => {
  const c = metColDef(k)
  if (metColSatOff(k)) return '须先在侧栏「链路参数」指定目标卫星'
  if (metColObsOff(k)) return '须先在表内执行「获取和风数据」'
  return (c && c.tip) || (c ? c.label : k)
}
// 复制整张读数表为 TSV（含表头，可直接粘进 Excel）——行序取屏幕上排过序的那一份
function metCopyResult() {
  const txt = envLive.metTsv(metResGrid.rows.value)
  perfWriteClipboard(txt)
  logMsg('已复制气象指标表（' + metResGrid.rows.value.length + ' 行）')
}
async function metExportXlsx() {
  const cols = envLive.metCols.value
  if (!cols.length) { appAlert('当前未显示任何指标列'); return }
  const m = envLive.siteMeta.value
  const note = m ? `${m.model} · ${new Date(m.frameT).toISOString().slice(0, 16).replace('T', ' ')}Z` : ''
  const sheets = [
    sheetModel({ name: '气象指标', cols, rows: metResGrid.rows.value, value: metXlsxVal, unitOf: (c) => c.unit, note }),
    sheetModel({ name: '站点输入', cols: metInCols, rows: envLive.sites.value, value: (r, c) => r[c.key] })
  ]
  const r = await exportSheets({ defaultName: safeFileName('气象指标表', '气象指标表') + '.xlsx', title: '导出气象指标表', sheets })
  if (r && r.ok) logMsg('已导出 ' + r.path)
}
// 导出时数字列存真数字（不是格式化后的字符串），文本列原样
const metXlsxVal = (r, c) => {
  if (!c.num) return c.key === 'ptype' ? (envLive.PTYPE_ZH[r.ptype] || '') : (r[c.key] == null ? '' : String(r[c.key]))
  const v = Number(r[c.key]) * (c.mul || 1)
  return Number.isFinite(v) ? v : ''
}
async function metImportXlsx() {
  const res = await importWorkbook({ title: '导入站点' })
  if (!res || !res.ok) { if (res && res.message) appAlert(res.message); return }
  const sheet = pickSheet(res.sheets, metInCols)
  if (!sheet) { appAlert('该工作簿中没有可识别的站点表'); return }
  const { records } = sheetToRecords(sheet, metInCols)
  let n = 0
  for (const rec of records) {
    const lon = Number(rec.lon), lat = Number(rec.lat)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    envLive.sites.value.push(metNewSite({ name: String(rec.name || '').trim() || envLive.fmtLL(lon, lat), lon, lat }))
    n++
  }
  logMsg(n ? `导入 ${n} 站` : '无可导入的行（需经度、纬度两列）')
}
async function metPasteBtn() {
  let txt = ''
  try { txt = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请在表格内按 Ctrl+V'); return }
  const n = metPasteAppend(txt)
  logMsg(n ? `粘贴 ${n} 站` : '剪贴板中没有可解析的坐标（每行至少两列，末两列为经度、纬度）')
}

// 光标读数：经纬度（状态栏固有）+ 当前环境场值（有图层时才有）
// 两张场互斥，故谁开着就读谁 —— 状态栏只有一格，不并列。
function onHoverLL(ll) {
  cursor.ll = ll
  cursor.env = ll ? (env.readAt(ll.lat, ll.lon) || envLive.readAt(ll.lat, ll.lon)) : null
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
// 本地时区标签：'UTC+8'（半时区如 'UTC+5:30'）。跟系统时区当期偏移
function visTzTag(ms) {
  const off = -new Date(ms || vis.accessBaseMs.value || Date.now()).getTimezoneOffset()
  const a = Math.abs(off)
  return 'UTC' + (off < 0 ? '-' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + p2t(a % 60) : '')
}
// ms → 指定时区的日期分量；utc 省缺跟随显示开关（供表格），显式传值供双时区并排（详情卡 / title / 导出）
function visP(ms, utc) {
  const u = utc == null ? vis.accessTz.value === 'utc' : utc, d = new Date(ms)
  return u
    ? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, da: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), se: d.getUTCSeconds() }
    : { y: d.getFullYear(), mo: d.getMonth() + 1, da: d.getDate(), h: d.getHours(), mi: d.getMinutes(), se: d.getSeconds() }
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
  if (d) box.scrollTo({ top: box.scrollTop + d, behavior: 'smooth' })
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
    if (!vis.covData.value) return { text: vis.covBusy.value ? '计算中' : '未计算', title: '' }
    const k = vis.covKpi.value
    if (!k) return { text: '', title: '' }
    return {
      text: k.timePct.toFixed(0) + '% 时间覆盖',
      title: `时间覆盖 ${k.timePct.toFixed(2)}%\n＝ 各网格「被覆盖时间占比」按面积（cos φ）加权平均，即区域 × 时窗的时空占比；从不被覆盖的格按 0 计入，不剔除。\n\n最差格 ${k.worstPct.toFixed(2)}% —— 区域内时间覆盖最低的那一点（为 0 说明存在整个时窗都覆盖不到的点）\n覆盖面积 ${k.coverPct.toFixed(2)}% —— 时窗内【曾经】被覆盖过的面积占比（松口径，一格只覆盖 1 个采样也算满，恒 ≥ 时间覆盖）`
    }
  }
  if (m === 'access') {
    const n = vis.accessResults.value.length
    if (!n) return { text: '0 星过境', title: '' }
    const k = vis.accessKpi.value
    return {
      text: n + ' 星过境 · ' + k.pct.toFixed(0) + '% 时间覆盖',
      title: `时间覆盖 ${k.pct.toFixed(2)}%\n＝ ${n} 星共 ${k.passes} 次过境窗口【合并重叠】后的可见时长 ${visDur(k.coveredMin)} ÷ 时窗 ${visDur(k.horizonMin)}。多星同时可见只计一次——不是各次时长求和（求和会重复计数、可超 100%）。\n窗口边界取二分精炼后的 AOS/LOS，被时窗切断的过境只计窗内那一段。\n\n最长中断 ${visDur(k.maxGapMin)}（共 ${k.gapCount} 段，含时窗首尾）`
    }
  }
  return { text: vis.results.value.length + ' 颗', title: '' }
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
  else if (tk === 'point') { const p = points.value.find((x) => x.id === tid); tgtName = p ? fmtLL(p.lat, p.lon) : '点标记' }
  else if (tk === 'poly') tgtName = ((polys.value.find((x) => x.id === tid) || {}).name) || 'Polygon'
  const tp = vis.targetPoints()
  const L = satSetLabel.value, base = vis.accessBaseMs.value, k = vis.accessKpi.value
  const payload = {
    defaultName: '过境窗口_' + String(tgtName).replace(/[\\/:*?"<>|]/g, '_'),
    target: { name: String(tgtName), kind: tk, lat: tp.length ? tp[0].lat : null, lon: tp.length ? tp[0].lon : null },
    satSet: (L.kind ? L.kind + ' · ' : '') + L.name, scanned: vis.accessScanned.value,
    minElevDeg: Number(vis.minElev.value) || 0,
    baseMs: base, horizonMin: k.horizonMin,
    tzOffsetMin: -new Date(base).getTimezoneOffset(), tzTag: visTzTag(base),
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

// ===================== 性能指标表（SATSOFT Performance Table，第 1 期）=====================
const perf = usePerfTable()
const perfKey = ref('')                 // 当前打开表的天线 key（''=关闭）；每个天线一张独立表
const perfOptsOpen = ref(false)         // 「性能表选项」弹窗开关
const perfGrpOpen = ref(false)          // 「城市组」管理弹窗开关
const perfGroupSel = ref('')            // 城市输入区工具栏「城市组」下拉当前值（=最近载入的组 id，''=未选）
const perfNewGrpName = ref('')          // 新建城市组的名称输入
const perfGrpRenameId = ref('')         // 正在重命名的城市组 id（''=无）
const perfGrpRenameVal = ref('')        // 重命名输入值
const perfGrpDelId = ref('')            // 待确认删除的城市组 id（两步删除防误删；''=无）
// 浮窗几何（可拖拽移动 / 右下角缩放）+ 中缝分隔（城市输入区高度，px）。首次打开按视口初始化一次。
const perfWin = ref({ x: 0, y: 0, w: 760, h: 560, init: false })
const perfInputH = ref(190)
const perfCols = computed(() => perfKey.value ? perf.visibleColumns(perf.getOpts(perfKey.value)) : [])   // 当前显示的列
const perfOpts = computed(() => perfKey.value ? perf.getOpts(perfKey.value) : null)                      // 当前天线选项（弹窗 v-model）
// 「波束筛选」勾选列表：点 / 按住拖刷 / Shift 连选 / 键盘，与覆盖分析侧栏的 Beams To Plot、
// 对星性能指标表同一份口径（shared/ui/useCheckList.js）。
const pbEl = ref(null)
const pbRows = computed(() => perf.filteredBeams())
const pbList = useCheckList({
  rows: () => pbRows.value,
  idOf: (b) => b.bi,
  isOn: (bi) => perf.beamOn(perfOpts.value, bi),
  current: () => perf.beamSelIds(perfOpts.value),
  commit: (ids) => perf.setBeamSel(perfOpts.value, ids),
  el: () => pbEl.value
})
const { isOn: pbOn, onCount: pbCount, allOn: pbAllOn, anyOn: pbAnyOn, painting: pbPainting, cur: pbCur, onRowDown: pbDown, onHeadDown: pbHeadDown, onKey: pbKey } = pbList
watch(perfKey, () => pbList.reset())   // 换天线＝换一张表、换一份勾选集，暂态与锚点就地丢掉

// 重算当前表（站点库/天线设置/选中波束/选项变化时调用）
function refreshPerf() { if (perfKey.value) perf.compute(grd.getPerfContext(perfKey.value), perf.getOpts(perfKey.value)) }
// 点天线下方「性能指标表」→ 打开该天线的表（确保其方向图已载入再取值）
async function openPerf(sat, a) {
  const key = grd.keyOf(sat.folder, a.name)
  const ok = await grd.ensureAntLoaded(key)
  if (!ok) { appAlert('该天线方向图未就绪，无法生成性能表'); return }
  perfKey.value = key
  perf.beamQuery.value = ''   // 新表：清空波束筛选搜索词（波束数/含义随天线变）
  ensurePerfCities()          // 载入城市库（供城市名→经纬度自动补全）；只载一次
  perfWinInit()
  refreshPerf()
}
// 城市库（约 360 座国内城市，与 GEO 链路预算共用同一 IPC 源）：首次开表时按需载入并注入 perf。
let _perfCitiesLoaded = false
async function ensurePerfCities() {
  if (_perfCitiesLoaded) return
  _perfCitiesLoaded = true
  try { const c = window.api && window.api.linkBudget && await window.api.linkBudget.cities(); if (c && c.length) { perf.setCities(c); if (perf.applyCityGeoAll()) refreshPerf() } }
  catch { _perfCitiesLoaded = false }   // 载入失败（无 IPC 等）→ 允许下次开表重试；自动补全暂不可用
}
function closePerf() { perfKey.value = '' }

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
// 身份串 → 卫星条目。★【全量】解析，不限于在场：对星跟踪的目标星可以是任何一颗目录星 /
// 自定义星座合成星 / 卫星组成员，它没被渲染出来不影响指向解算（与搜索池同一口径，见 satcovSearch）。
// 顺序＝在场（与点云同一批对象）→ 全量在轨目录 → 自定义星座（含隐藏的座，取最新一次生成的合成星）。
function satEntryById(id) {
  if (!id) return null
  const isN = id.startsWith('n:'), key = id.slice(2)
  const live = isN ? renderEntries.find((x) => String(x.noradId) === key) : renderEntries.find((x) => x.name === key)
  if (live) return live
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
    const pv = sat.propagate(e.rec, t)
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
      const pv = sat.propagate(e.rec, tm)
      if (pv && pv.position) { const ecf = sat.eciToEcf(pv.position, sat.gstime(tm)); P = [ecf.x, ecf.y, ecf.z] }
    } catch { P = null }
  }
  _tgtMap.set(id, P)
  return P
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
function satcovEntries(ctx) {
  const selfName = ctx ? String(ctx.satName || '') : ''
  return renderEntries.filter((e) => !selfName || e.name !== selfName)
    .map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: !!isCustomEntry(e) }))
}
// picks（只存名字/NORAD）→ 活体条目。星历更新后按身份重新解析，解析不到的自动缺席。
// 解析走 satEntryById 的【全量】口径（在场 → 全量目录 → 自定义星座）：目标星是从全量目录里搜进来的，
// 若这里只认在场，加得进列表却算不出行，表面上像「这颗星没被照到」——静默算错，比报错还糟。
function satcovResolvePicks() {
  const out = []
  for (const p of satPerf.picks.value) {
    const e = satEntryById(p.noradId ? 'n:' + p.noradId : 'm:' + p.name)
      || renderEntries.find((x) => x.name === p.name)      // 编号对不上了但名字还在（星历换版）
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
  const fb = satcov.focusBeam.value                     // 没画就退回第一个
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
      let pv
      try { pv = sat.propagate(e.rec, cc ? t.ccNow : t.now) } catch { continue }
      if (!pv || !pv.position) continue
      const ecf = sat.eciToEcf(pv.position, cc ? t.ccGmst : t.gmst)
      P[0] = ecf.x; P[1] = ecf.y; P[2] = ecf.z
    }
    if (!sampleBeamAtEcef(bm.beam, ctx.igrid, ctx.basis, P, dirOpts)) continue
    out.push({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group, _cc: cc })
  }
  return out
}
// 本轮该算哪些目标星：点选档取用户名单，波束内档取此刻的成员（并把名单回填给浮窗显示）
function satcovResolveTargets(ctx) {
  if (satPerf.targetMode.value !== 'beam') return satcovResolvePicks()
  const list = satcovInBeamNow(ctx)
  satPerf.setBeamTargets(list.map((e) => ({ name: e.name, noradId: e.noradId, group: e.group })))
  return list
}
function satcovRefreshTable() {
  if (!satcovTableOpen.value) return
  const key = satcov.active.value
  const ctx = key ? grd.getPerfContext(key) : null
  if (!ctx) { satPerf.compute(null); satPerf.setBeamTargets([]); return }
  // 时间窗口档：表钉在【游标时刻】，不能被「按当前时钟重算」冲掉（目标星/口径改了由「输入已变」提示重扫）；
  // 还没扫过就空着 —— 留一批当前时刻的数在时窗档下，看着就像是时窗里的数
  if (satPerf.win.on) {
    if (satPerf.winInfo.value) satPerf.seekCursor(satPerf.win.cursorMs); else satPerf.clearRows()
    return
  }
  satPerf.compute(ctx, satPerf.getOpts(key), satcovResolveTargets(ctx), satcovTimes(), satcov.shells.value, satcov.s.hEx)
}
// ===== 瞬时表跟随仿真时钟（预算自适应）=====
// 改造前这张表只在【源星移动】时重算，时间推进它是不动的 —— 目标星在动、几何在变、取值早就不是这个数了。
// 现在每拍跟着走。代价按实测耗时自适应：一次重算超过一拍间隔的 1/3，就按比例跳拍（宁可少刷几帧，
// 也不能让表把时钟拖慢——时钟一慢，画面上的星就跟不上真实速率，那是把显示问题变成物理问题）。
// 时段表（几十万次取值）不跟：它只在用户点「计算」时跑，输入变了亮「输入已变」。
// 表也当场重算，与星位、覆盖场同一个时刻 —— 表脚的 satPerf.stampMs 因此恒等于画面时刻。
// （曾按预算跳帧，于是表里的数比画面旧一两拍。省下的那点算力换不来这个代价：
//   一屏之内两个时刻，比慢一点糟得多。要省算力就整体放慢，那是时钟占用底线的事。）
function satcovClockTick() {
  if (!satcovTableOpen.value || satPerf.win.on) return
  satcovRefreshTable()
}
// 「加入波束内的星」：扫一遍在场卫星，把当前落在方向图域里的加进目标库。
// 这是「全量」与「点选」之间的桥——先捞一批，再自己删到只剩关心的那几颗。
function satcovAddInBeam() {
  const key = satcov.active.value
  const ctx = key ? grd.getPerfContext(key) : null
  if (!ctx || !ctx.beams.length) { status.value = '先选一根天线'; return }
  const found = satcovInBeamNow(ctx).map((e) => ({ name: e.name, noradId: e.noradId, group: e.group }))
  const n = satPerf.addTargets(found)
  status.value = found.length ? `波束内 ${found.length} 星，新增 ${n} 个目标` : '当前波束内没有卫星'
  satcovRefreshTable()
}
// ---- 时间窗口（时段扫描）----
// 与瞬时表最大的不同：源星与目标星都要按【任意时刻】解算，故得把两者的星历（satrec）交给表模块，
// 不能只给一个当下的星下点。固定星（无 NORAD、无根数）没有星历 → 给 null，表模块按 ctx.meta 恒定处理。
function satcovSourceRec(ctx) {
  const folder = ctx && ctx.meta && ctx.meta.folder
  const node = folder ? grdSats.value.find((x) => x.folder === folder) : null
  if (!node) return null
  if (node.noradId) {
    const en = entries.find((x) => String(x.noradId) === String(node.noradId))
      || searchPool.find((x) => String(x.noradId) === String(node.noradId))
      || customConst.findByNorad(node.noradId)
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
  return e ? { rec: e.rec, _cc: !!isCustomEntry(e) } : null
}
async function satcovScanWindows() {
  const key = satcov.active.value
  const ctx = key ? grd.getPerfContext(key) : null
  if (!ctx) { status.value = '先选一根天线'; return }
  // 波束内档：目标 = 点「计算」那一刻在波束里的那批星（成员本身随时刻变，扫描得先钉住一份名单）
  const tgts = satcovResolveTargets(ctx)
  if (!tgts.length) { status.value = satPerf.targetMode.value === 'beam' ? '当前波束内没有卫星' : '先加目标星'; return }
  await satPerf.computeWindows(ctx, satPerf.getOpts(key), tgts, satcovTimes(), satcov.shells.value, satcov.s.hEx,
    { srcRec: satcovSourceRec(ctx), boreRec: satcovBoreRec(ctx) })
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
  autoRotate.value = false
}

// 浮窗以 .g3 为参照系（与对地性能指标表同款），开窗前把当前可视尺寸递过去
const satcovHost = ref({ w: 0, h: 0 })
async function satcovOpenTable() {
  if (!satcovTableOpen.value) satcovHost.value = g3Size()
  satcovTableOpen.value = !satcovTableOpen.value
  if (satcovTableOpen.value) { await nextTick(); satcovRefreshTable() }
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
watch(() => satcov.active.value, () => satcovRefreshTable())
watch(satcovTableOpen, (v) => { if (v) satcovRefreshTable() })
// 聚焦特效的触发面：画哪些天线变了（点亮谁按此定）、指向模式/目标星变了（目标星那一端要跟着换）。
// 时间推进不在这里管——refreshPositions 每帧都会 commitGeometry。
// 不按视图门控：commitGeometry 是幂等的全量重喂，画不画由 satcov.selected 定（清空即自然收特效）——
// 加个 side 判据反而会在【清除绘图那一下正好不在该视图】时把特效留在场景里。
watch(() => [satcov.selected.value.join('|'), grd.active.value, grdS.boreType, grdS.boreSat], () => commitGeometry())
// 目标库变动（加/删/清空）→ 表重算；切目标来源（点选 ↔ 波束内）同理
watch(() => satPerf.picks.value, () => satcovRefreshTable(), { deep: true })
watch(satPerf.targetMode, () => satcovRefreshTable())
// ===== 目标星搜索（对星跟踪的目标星 / 指标表的目标星，两处共用）=====
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
function perfWinInit() {
  if (perfWin.value.init) return
  const { w: vw, h: vh } = g3Size()
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
    const { w: vw, h: vh } = g3Size()
    const x = Math.max(-o.w + 96, Math.min(vw - 48, o.x + (ev.clientX - sx)))   // 不让完全拖出 .g3 可视范围
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
    const { w: vw, h: vh } = g3Size()
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
// Excel/链路预算式「＋ 增加」：在选中行下方插入一行空行（无选中则末尾），选区落到新行首列，直接键入或粘贴
function perfAddRow() {
  perf.pushUndo()
  const ri = perfInGrid.sel.value.ri
  const at = ri >= 0 ? ri + 1 : perf.stations.value.length
  perf.addEmptyStation(at)
  nextTick(() => { perfInGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; perfInGrid.focusGrid() })
}
// 表尾「＋ 增加一行」：恒追加到末尾（行中插入走右键菜单 / 工具条的「增加」）
function perfAddRowEnd() {
  perf.pushUndo()
  const at = perf.stations.value.length
  perf.addEmptyStation(at)
  nextTick(() => { perfInGrid.sel.value = { ar: at, ac: 0, ri: at, ci: 0 }; perfInGrid.focusGrid() })
}
function perfImportMarkers() { perf.pushUndo(); const n = perf.importFromMarkers(points.value, stations.value); if (!n) { perf.dropUndo(); appAlert('没有可导入的新标记（点标记/地球站）') } refreshPerf() }
function perfImportTrajs() { perf.pushUndo(); const n = perf.importFromTrajectories(trajectories.value); if (!n) { perf.dropUndo(); appAlert('没有可导入的新航点（航迹为空或已全部导入）') } refreshPerf() }
// 「粘贴」按钮：直接读剪贴板批量加站（需浏览器授权剪贴板读取）
async function perfPasteBtn() {
  let text = ''
  try { text = await navigator.clipboard.readText() } catch { appAlert('无法读取剪贴板，请检查剪贴板权限'); return }
  perf.pushUndo()
  const n = perf.addStationsBulk(text)
  if (n) refreshPerf(); else { perf.dropUndo(); appAlert('剪贴板没有可识别的经纬度数据（约定末两列为 经度、纬度）') }
}
// ===== 城市组：把当前城市列表存成命名预设，选组即载入（替换）并重算结果，供不同天线复用 =====
function perfOpenGroups() { perfGrpDelId.value = ''; perfGrpRenameId.value = ''; perfNewGrpName.value = ''; perfGrpOpen.value = true }
function perfCreateGroup() {
  if (!perf.stations.value.length) { appAlert('当前城市列表为空，无法存为组'); return }
  const id = perf.addCityGroup(perfNewGrpName.value)
  if (id) { perfNewGrpName.value = ''; perfGroupSel.value = id }
}
function perfLoadGroup(g) {
  if (!g) return
  perf.pushUndo()
  const n = perf.loadCityGroup(g.id)
  perfGroupSel.value = g.id
  refreshPerf()
  if (!n) appAlert('该城市组为空')
}
// 工具栏下拉：选中某组即载入（替换当前列表，可撤销）
function perfLoadGroupSel() {
  const g = perfGroupSel.value ? perf.cityGroups.value.find((x) => x.id === perfGroupSel.value) : null
  if (g) perfLoadGroup(g)
}
function perfAppendGroup(g) {
  if (!g) return
  perf.pushUndo()
  const n = perf.appendCityGroup(g.id)
  if (n) refreshPerf(); else { perf.dropUndo(); appAlert('该组城市已全部在当前列表中（按坐标去重）') }
}
function perfOverwriteGroup(g) {
  if (!g) return
  if (!perf.stations.value.length) { appAlert('当前城市列表为空，无法覆盖'); return }
  perf.overwriteCityGroup(g.id)
}
function perfStartRenameGroup(g) { perfGrpDelId.value = ''; perfGrpRenameId.value = g.id; perfGrpRenameVal.value = g.name }
function perfCommitRenameGroup(g) { if (perf.renameCityGroup(g.id, perfGrpRenameVal.value)) perfGrpRenameId.value = '' }
// 两步删除：首次点击进入「确认」态，再点一次才真正删除，避免误删已精心整理的城市组
function perfDeleteGroup(g) {
  if (perfGrpDelId.value !== g.id) { perfGrpDelId.value = g.id; return }
  perf.removeCityGroup(g.id)
  if (perfGroupSel.value === g.id) perfGroupSel.value = ''
  perfGrpDelId.value = ''
}
// ===== 两张表都用 Excel 式交互（框选 / 键盘导航 / 复制 / 编辑·粘贴·清除）=====
// 城市输入网格列（可编辑）；行 = perf.stations，行 id 即站点 id。
const perfInCols = [
  { key: 'country', label: '国家' },
  { key: 'city', label: '城市' },
  { key: 'desig', label: '代号' },
  { key: 'lon', label: '经度', num: true, unit: '°E' },
  { key: 'lat', label: '纬度', num: true, unit: '°N' }
]
// 上：城市输入（可编辑）——单格编辑/区域粘贴/清除均落到站点库，深 watch 自动重算结果表。
const perfInGrid = useGridSelect({
  gridId: 'perf-in',
  rows: () => perf.stations.value,
  cols: () => perfInCols,
  cellText: (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) },
  // 编辑城市名后，若精确命中城市库 → 自动补全经纬度（与 GEO 链路预算一致）。commitEdit 仅在值真正改变时才调 onEdit，
  // 故只有城市名确有变动才会触发补全；且与前面的 pushUndo 同属一次撤销（一次 Ctrl+Z 同时还原城市名与经纬度）。
  onEdit: (id, key, val) => { perf.updateStation(id, { [key]: val }); if (key === 'city') perf.applyCityGeo(id) },
  onPasteBlock: (anchorId, startKey, text) => perf.pasteBlock(anchorId, startKey, text),
  onPasteAppend: (text) => perf.addStationsBulk(text),
  onClear: (cells) => cells.forEach(({ rowId, key }) => perf.updateStation(rowId, { [key]: '' })),
  // 右键菜单的插入/删除行（撤销快照由内核统一压，这里不再自己 pushUndo）
  onInsertRows: (at, n) => { for (let k = 0; k < n; k++) perf.addEmptyStation(at + k); return n },
  onDeleteRows: (ids) => { const s = new Set(ids); const before = perf.stations.value.length; perf.stations.value = perf.stations.value.filter((x) => !s.has(x.id)); return before - perf.stations.value.length },
  pushUndo: () => perf.pushUndo(), dropUndo: () => perf.dropUndo(), refresh: () => refreshPerf(),
  undo: () => perfUndo(), redo: () => perfRedo()   // 表内 Ctrl+Z / Ctrl+Y（与工具栏按钮同源）
})
// 下：性能结果（只读）——框选 + 复制 + 键盘导航；行 = filteredRows。
const perfResGrid = useGridSelect({
  gridId: 'perf-res',
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
  const head = cols.map((c) => { const u = perfColUnit(c); return c.label + (u ? '(' + u + ')' : '') }).join('\t')   // 复制表头带单位，与显示一致
  const body = rows.map((r) => cols.map((c) => perfCellText(r, c)).join('\t')).join('\n')
  if (!perfWriteClipboard(head + '\n' + body)) appAlert('复制失败，请检查剪贴板权限')
}
// ===== 性能指标表 ⇄ Excel =====
// 出表值：数字列写【真数字】（在 Excel 里能直接算），文本列原样。
const perfXlsxVal = (r, c) => { const v = r[c.key]; if (v == null || v === '') return null; return (c.num && typeof v === 'number') ? v : String(v) }
const perfCtxName = () => (perf.ctxInfo.value ? perf.ctxInfo.value.satName + '_' + perf.ctxInfo.value.antName : '性能指标表')
function perfCitySheet() { return sheetModel({ name: '城市输入', cols: perfInCols, rows: perf.stations.value, value: perfXlsxVal }) }
async function perfExportCities() {
  if (!perf.stations.value.length) { appAlert('城市列表为空'); return }
  const r = await exportSheets({ defaultName: safeFileName('城市列表_' + perfCtxName(), '城市列表') + '.xlsx', title: '导出城市列表', sheets: [perfCitySheet()] })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function perfExportResult() {
  if (!perfCols.value.length) { appAlert('当前没有显示任何列'); return }
  const c = perf.ctxInfo.value
  const note = [c ? '卫星 ' + c.satName : '', c ? '天线 ' + c.antName : '', c ? c.beams + ' 波束' : ''].filter(Boolean).join(' · ')
  const sheets = [
    sheetModel({ name: '性能结果', cols: perfCols.value, rows: perfResGrid.rows.value, value: perfXlsxVal, unitOf: perfColUnit, note }),
    perfCitySheet()
  ]
  const r = await exportSheets({ defaultName: safeFileName('性能指标表_' + perfCtxName(), '性能指标表') + '.xlsx', title: '导出性能指标表', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
// 导入城市列表：按表头匹配「国家/城市/代号/经度/纬度」；认不出表头就退回剪贴板那条位置约定（末两列=经纬度）。
// replace=true 覆盖当前列表，否则追加。导入后对「只有城市名、没坐标」的行补一次城市库坐标（幂等，不覆盖已有坐标）。
async function perfImportCities(replace) {
  const res = await importWorkbook({ title: replace ? '导入城市列表（覆盖）' : '导入城市列表（追加）' })
  if (!res || res.canceled) return
  if (!res.ok) { appAlert('导入失败：' + (res.error || '无法读取该文件')); return }
  const sheet = pickSheet(res.sheets, perfInCols)
  if (!sheet) { appAlert('这份工作簿里没有数据'); return }
  const { records } = sheetToRecords(sheet, perfInCols)
  perf.pushUndo()
  if (replace) perf.clearStations()
  let n = 0
  if (records) {
    for (const rec of records) {
      const s = perf.addEmptyStation()
      perf.updateStation(s.id, { country: rec.country || '', city: rec.city || '', desig: rec.desig || '', lon: rec.lon, lat: rec.lat })
      n++
    }
  } else {
    n = perf.addStationsBulk(sheetToTsv(sheet))
  }
  if (!n) { perf.dropUndo(); appAlert('没有读到数据（表头需含「经度 / 纬度」，或把经纬度放在最后两列）'); return }
  await ensurePerfCities()
  perf.applyCityGeoAll()
  refreshPerf()
}
const perfFix = (v, n) => (v == null ? '—' : v.toFixed(n == null ? 2 : n))
// 结果表格内显示文本：数字列按列定义的小数位，取不到值显示破折号（复制/导出走各自口径，见 perfResGrid.cellText / perfXlsxVal）
function perfResText(r, c) {
  if (c.num) return c.fix != null ? perfFix(r[c.key], c.fix) : (r[c.key] == null ? '—' : String(r[c.key]))
  return r[c.key] || ''
}
const perfColDef = (k) => perf.colDefs.find((c) => c.key === k)
// 列单位：param（Parameter）随参数计算口径动态——dB / 功率 / 电压（与选项弹窗单位切换同口径，Same as Antenna 恒 dB）；
// 其余列取列定义里的静态 unit（经纬度/角度 °、dir/xpol/slope/ar/min·maxPt 等 dB/…）。无量纲列（u/v）返回空。
function perfColUnit(c) {
  if (!c) return ''
  if (c.key === 'param') {
    const o = perfOpts.value
    if (!o || o.sameAsAnt || o.unit === 'dB') return 'dB'
    return o.unit === 'power' ? '功率' : o.unit === 'voltage' ? '电压' : 'dB'
  }
  return c.unit || ''
}
const perfColLabel = (k) => { const c = perfColDef(k); if (!c) return k; return c.label + (c.unit ? '(' + c.unit + ')' : '') }   // 选项弹窗列名带（静态）单位
const perfColNa = (k) => { const c = perfColDef(k); return !!(c && c.na) }
// 逃生口：把当前天线的表选项重置为出厂默认（列/口径/指向误差/波束筛选）——继承机制不合意时一键回默认
function perfResetOpts() { if (!perfKey.value) return; perf.resetOpts(perfKey.value); perf.beamQuery.value = ''; refreshPerf() }
// 站点库 / 天线设置（极化/增益/路损/相对绝对）/ 选中波束 / 表选项 变化 → 表重算（仅表开启时）
watch(() => perf.stations.value, () => refreshPerf(), { deep: true })
watch(() => perf.optsByAnt.value, () => refreshPerf(), { deep: true })
// 记住当前表的列/口径/指向误差设置，作为「下一个新天线」的默认模板 → 换天线不必重设（beamSel 在 rememberOpts 内已剔除，不跨天线继承）
watch(perfOpts, () => { if (perfKey.value) perf.rememberOpts(perfKey.value) }, { deep: true })
watch(() => [grdS.pol, grdS.gainOffset, grdS.pathLoss, grdS.ctype, grdS.beamsToPlot], () => { if (perfKey.value === grd.active.value) refreshPerf() }, { deep: true })
// 拖拽波束/改指向时性能表随图实时刷新（取值依赖指向推出的 basis）。boresight 每帧变 → rAF 合帧，一帧最多重算一次，
// 避免逐帧全量取值（每站×每波束，含 Min/Max Pointing 的椭圆扫描）把主线程打满。仅当该表正是聚焦天线才刷。
let _perfDragRaf = 0
function scheduleRefreshPerf() { if (_perfDragRaf) return; _perfDragRaf = requestAnimationFrame(() => { _perfDragRaf = 0; refreshPerf() }) }
watch(() => [grdS.boreType, grdS.boreLon, grdS.boreLat, grdS.boreAz, grdS.boreEl, grdS.yaw], () => { if (perfKey.value && perfKey.value === grd.active.value) scheduleRefreshPerf() })
// 电平配色 / 指向模式 / 波束名与电平名的内联改名都在 GrdSetSections.vue 里（两个覆盖分析视图共用那份 UI）
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
  oceanColor: '#96c3e6', oceanOpacity: 1, seaColor: '#86b0d4', seaOpacity: 1
}
const OLD_LABEL_DEF = { countryColor: '#ffffff', countryOpacity: 1.0, provColor: '#f6fa00', provOpacity: 0.25, cityColor: '#9aa3b0', cityOpacity: 0.25 }   // 老存档迁移判据
const labelStyle = reactive({ ...LABEL_DEF })
// 大海颜色（限蓝色系预设），同时作用于 3D 球体与平面图底色
// 蓝色系：中→浅（已删除最深档 #0d2b4d、#15426b，观感过暗）；末档 #a3ccff 为更亮的淡蓝（比 #92b6e4 更亮）
// 并设为默认底色；#aacbdf 为低饱和钢蓝、#92b6e4 为略深蓝，均保留可选。
const OCEAN_BLUES = ['#1b5a8c', '#1e6fa8', '#2a85c4', '#3d7ba6', '#5b7f9e', '#92b6e4', '#aacbdf', '#a3ccff']
const oceanColor = ref('#a3ccff')
// 影像底图（真彩卫星影像整幅贴图，2D/3D 同一份）。默认关：8192×4096 一张解码 + 上显存约 180 MB，
// 不该为没开这功能的人付这笔账 —— 故图片是「首次开启时才去加载」的懒加载。
const imageryOn = ref(false)
const imageryKey = ref(DEFAULT_IMAGERY)
const imageryBright = ref(1)
let imageryLoading = ''      // 正在加载的那一份的 url（''=空闲）。存 url 不存布尔：见 applyImagery
let imageryPending = false   // 加载期间又改过档 → 这一次回来后自己补跑一遍
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
    return { idx, active: e === selEntry, name: e.name, noradId: e.noradId, kind: c.kind || '', slot: c.slot || '', alt: c.alt || '—', incl: c.incl || '—' }
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
const soloConst = ref(null)   // 当前「单独显示」的自定义星座 id（行高亮）
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
watch(satGroups.list, () => { rebuildSatGrpColor(); recalcHasColor(); refreshPositions() }, { deep: true, flush: 'sync' })
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
async function refreshCustomImportCount() {
  try { const r = (apiOk && window.api.omm.customList) ? await window.api.omm.customList() : null; customImportCount.value = (r && r.count) || 0 }
  catch { customImportCount.value = 0 }
}
const hasCustomData = computed(() => customImportCount.value > 0)

// 生成/编辑向导草稿（null=关闭）
const constModal = ref(null)
function defaultConstDraft() {
  return { id: null, name: byLang('自定义星座', 'Custom Constellation'), pattern: 'delta', T: 24, P: 6, F: 1, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0, color: '#4dabf7', colorByPlane: true }
}
function openConstWizard(cfg) {
  if (cfg) constModal.value = { ...defaultConstDraft(), id: cfg.id, name: cfg.name, color: cfg.color, colorByPlane: cfg.colorByPlane !== false, ...cfg.params }
  else constModal.value = defaultConstDraft()
}
function closeConstWizard() {
  const editId = constModal.value && constModal.value.id
  constModal.value = null   // 触发 watch：撤预览 + 重建
  if (editId) nextTick(() => rebindSelection('cc_' + editId))   // 编辑现有星座取消：选中重绑回原版
}
// 草稿 → 生成参数（校验后调用）
function draftParams(m) {
  return {
    pattern: m.pattern, T: Math.round(+m.T) || 1, P: Math.max(1, Math.round(+m.P) || 1), F: Math.round(+m.F) || 0,
    incl: +m.incl || 0, shape: m.shape, perigeeKm: +m.perigeeKm || 0,
    apogeeKm: m.shape === 'ellip' ? (+m.apogeeKm || +m.perigeeKm || 0) : (+m.perigeeKm || 0),
    argp: +m.argp || 0, raan0: +m.raan0 || 0, m0: +m.m0 || 0, name: m.name
  }
}
function saveConstWizard() {
  const m = constModal.value; if (!m) return
  const v = validateWalker(m)
  if (!v.ok) { appAlert(v.errs.join('；')); return }
  customConst.setPreview(null)   // 撤实时预览，避免与提交版本重叠
  const draft = { name: m.name, params: draftParams(m), color: m.color, colorByPlane: m.colorByPlane !== false }
  let id = m.id
  if (m.id) customConst.update(m.id, draft); else { const cfg = customConst.add(draft); id = cfg.id }
  rebindSelection('cc_' + id)   // 选中的预览星重绑到提交版本，卡片/覆盖/星下点/轨迹不断
  constModal.value = null
  if (!m.id) showConstAlone({ id })   // 新建星座：生成后单独显示（与「选哪个看哪个」一致，不叠加内置组）；编辑则保持当前显示
}
// 编辑器打开时：参数变动实时预览到地球（防抖 140ms；非法参数撤预览）。关闭时撤预览。
let _cpvTimer = null
watch(constModal, (m) => {
  if (_cpvTimer) { clearTimeout(_cpvTimer); _cpvTimer = null }
  if (!m) { customConst.setPreview(null); rebuildRenderSet(); return }
  _cpvTimer = setTimeout(() => {
    _cpvTimer = null
    const cur = constModal.value; if (!cur) return
    if (!validateWalker(cur).ok) { customConst.setPreview(null); rebuildRenderSet(); return }
    customConst.setPreview({ id: cur.id, name: cur.name, color: cur.color, colorByPlane: cur.colorByPlane !== false, params: draftParams(cur) })
    rebuildRenderSet()
    rebindSelection('cc___preview__')   // 选中该星座的星 → 随参数实时更新覆盖/星下点/轨迹/卡片
  }, 140)
}, { deep: true })
// 向导实时预览：每面数 / 面间相位 / Walker 码 / 周期 / 校验提示
const constDerived = computed(() => {
  const m = constModal.value; if (!m) return null
  const T = Math.round(+m.T) || 0, P = m.pattern === 'plane' ? 1 : Math.max(1, Math.round(+m.P) || 1), F = Math.round(+m.F) || 0
  const S = Math.floor(T / P) || 0
  const v = validateWalker(m)
  return { S, total: m.pattern === 'plane' ? T : P * S, phase: (T ? F * 360 / T : 0).toFixed(1), code: walkerCode(m), periodMin: orbitPeriodMin(m).toFixed(1), warns: v.warns, errs: v.errs }
})
const ccCode = (c) => walkerCode(c.params)
// 点击自定义星座行 → 单独显示该星座（内置组切「无」，仅该星座可见）
function showConstAlone(c) {
  const noneIdx = GROUPS.findIndex((g) => g.key === 'none')
  // 必须先退出筛选态（搜索 / 卫星组显示）：筛选态下 rebuildRenderSet 只渲染命中星、不叠加自定义星座，
  // 不清就会「点了没反应」。pickGroup 内部会 clearSearch，但已在「无」时它早退（i===groupIndex）什么都不做 —— 故 else 补清。
  if (noneIdx >= 0 && groupIndex.value !== noneIdx) pickGroup(noneIdx)   // 切「无」（会清 soloConst 高亮 + 清筛选）
  else clearSearch()
  soloConst.value = c.id
  customConst.showOnly(c.id)   // 仅该星座可见 → persist + 重建渲染集
}
function removeConst(c) { expDrop('c:' + c.id); customConst.remove(c.id) }
let ro = null, trackRo = null
let unsubClock = null, nowBeat = null   // nowBeat：1 Hz 心跳，只刷「真实此刻」参考量（见 nowStamp）
let pendingNorad = null, pendingNoFace = false

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

const curKey = () => GROUPS[groupIndex.value].key
const fmtSlot = fmtGeoSlot   // °E/°W 格式化统一走 shared/geoSlot.js（模板日下点等处沿用旧名）
const fmtDate = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` }

// ===================== 信息卡（字段/顺序与 2D 完全一致） =====================
function cardFor(e) {
  const now = isCustomEntry(e) ? ccTimeAt() : calcAt(), gmst = sat.gstime(now)   // 合成星按场景历元解算
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
  // 轨道区制判定（GEO/IGSO/MEO/LEO/HEO）——严谨口径见 shared/orbitClass.js（先偏心率→再同步周期→高度带）
  const kind = classifyOrbit({ aKm: RE + meanKm, e: rec.ecco, inclDeg: rec.inclo / DEG, perigeeAltKm: perKm, apogeeAltKm: apoKm, periodMin })
  return {
    name: e.name, noradId: e.noradId, group: e.groupLabel || GROUP_LABEL[e.group] || GROUP_LABEL[curKey()] || '', kind,
    slot: geoSlotOfSatrec(e.rec),   // GEO 才有定点标注（严区制判定，与分组无关；历元值缓存，不随时钟漂移）
    alt: gd.height.toFixed(0), lat: sat.degreesLat(gd.latitude).toFixed(2), lon: sat.degreesLong(gd.longitude).toFixed(2),
    incl: (rec.inclo / DEG).toFixed(2), ecc: rec.ecco.toFixed(5), period: periodMin.toFixed(1),
    perigee: perKm.toFixed(0), apogee: apoKm.toFixed(0), meanMotion: meanMotion.toFixed(4),
    raan: (((rec.nodeo / DEG) % 360 + 360) % 360).toFixed(2), argp: (((rec.argpo / DEG) % 360 + 360) % 360).toFixed(2),
    ma: (((rec.mo / DEG) % 360 + 360) % 360).toFixed(2),
    speedAbs: speedAbs.toFixed(3), speedRel: speedRel.toFixed(3)
  }
}

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
const FOCUS_TRACK_BUDGET = 12000
const focusTrackPeriods = (n, samples) => {
  const want = clamp(Number(focusStyle.trkPeriods) || 1, 0.25, 10)
  const cap = FOCUS_TRACK_BUDGET / Math.max(1, n * Math.max(1, samples))
  return Math.max(0.25, Math.min(want, Math.max(1, cap)))
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
  geomPool.setSats(draw.map((e) => ({ key: satIdOf(e), rec: e.rec, cc: isCustomEntry(e), color: hexNum(satDotHex(e)) })),
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
  const per = focusTrackPeriods(draw.length, lod.samples)      // 星下点轨迹画几个周期（用户可设）
  const orbOn = !!focusStyle.orbOn
  // TTL 取选中集里【最短】的那个（周期越短，重建时被换掉的环长占比越大）
  let ttl = Infinity
  if (orbOn) for (let i = 0; i < draw.length; i++) { const v = ringTtlMs((2 * Math.PI) / draw[i].rec.no * 60000); if (v < ttl) ttl = v }
  const reRing = orbOn && (!ringEpoch || ringDirty || Math.abs(nowMs - ringEpoch.tMs) > ttl)   // 跳变/倒放取绝对值
  if (reRing) { ringEpoch = { tMs: nowMs, gmst: gmstNow }; ringDirty = false }
  const p = {
    tMs: nowMs, gmst: gmstNow, ccTMs: ccNow.getTime(), ccGmst: sat.gstime(ccNow),
    lod, per,
    ring: { on: orbOn, tMs: ringEpoch ? ringEpoch.tMs : nowMs, gmst: ringEpoch ? ringEpoch.gmst : gmstNow, rebuild: reRing, build: reRing },
    fp: { mode: fpMode.value, beamDeg: parseFloat(beam.value), elevDeg: parseFloat(elevMin.value) },
    style: {
      orbDash: focusStyle.orbDash,
      trkOn: !!focusStyle.trkOn, trkDash: focusStyle.trkDash,
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
  const spin = orbOn && ringEpoch ? ringEpoch.gmst - gmstNow : 0
  return geomPool.compute(p).then((shards) => (shards ? { shards, ringBuild: reRing, spin } : null))
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
    for (let i = 0; i + 1 < f.trkOff.length; i++) {
      const track = [], footprint = []
      for (let j = f.trkOff[i]; j < f.trkOff[i + 1]; j++) track.push({ lat: f.trkLL[j * 2], lon: f.trkLL[j * 2 + 1] })
      for (let j = f.fpOff[i]; j < f.fpOff[i + 1]; j++) footprint.push({ lat: f.fpLL[j * 2], lon: f.fpLL[j * 2 + 1] })
      const la = f.sub[i * 2], lo = f.sub[i * 2 + 1]
      const sub = Number.isFinite(la) ? { lat: la, lon: lo } : null
      if (sub) subs.push(sub)
      geom.push({ track, footprint: footprint.length ? footprint : null, sub })
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
const liveEntryOf = (noradId) => entries.find((x) => String(x.noradId) === String(noradId))
  || searchPool.find((x) => String(x.noradId) === String(noradId))
  || customConst.findByNorad(noradId) || null       // 自定义星座合成星(含隐藏)
function focusGeomOfRec(rec, isCc, color) {
  if (!rec) return null
  const now = calcAt(), t = isCc ? ccTimeAt(now) : now, g = sat.gstime(t)   // 合成星按场景历元解算
  try {
    const pv = sat.propagate(rec, t)
    if (!pv || !pv.position) return null
    const gd = sat.eciToGeodetic(pv.position, g)
    const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude), h = gd.height
    // 自适应采样，与选中星同源（含「轨迹画几个周期」那档设置：轨道圈仍只取一个整周期）
    const periodMin = (2 * Math.PI) / rec.no, per = focusTrackPeriods(1, 120)
    const samples = sampleOrbitAdaptive(rec, t, periodMin * Math.max(1, per), Math.round(120 * Math.max(1, per)))
    const t1 = t.getTime() + periodMin * 60000, tTrk = t.getTime() + periodMin * per * 60000
    const orbit = [], track = []
    for (const q of samples) {
      const ms = q.t.getTime()
      if (ms <= t1 + 1) { const d = sat.eciToGeodetic(q.pv.position, g); orbit.push({ lat: sat.degreesLat(d.latitude), lon: sat.degreesLong(d.longitude), altKm: d.height }) }
      if (ms <= tTrk + 1) track.push({ lat: q.lat, lon: q.lon })
    }
    if (orbit.length > 1) orbit.push(orbit[0])   // 同上：轨道圈收口
    const ecf = sat.eciToEcf(pv.position, g)
    const fp = footprintAtEcef([ecf.x, ecf.y, ecf.z], h)
    return { item: { orbit, track, footprint: fp, primary: false, satPos: { lat, lon, altKm: h, color } }, sub: { lat, lon }, flat: { track, footprint: fp, sub: { lat, lon } } }
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
function computeSatcovFocusGeometry() {
  const empty = { items: [], subs: [], subs2d: [], flat: [], rings: [] }
  // 一颗天线都没勾就早退：commitGeometry 每拍都走，没有这一句就是每帧把整棵树的 key 拼一遍白算
  if (!scene || !satcov.selected.value.length) return empty
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
  const now = calcAt()
  const filtering = filterEntries.length > 0
  const base = filtering ? filterEntries : entries   // 搜索筛选态：渲染命中星（跨分组），否则渲染当前分组
  const valid = []
  for (const e of base) {
    try { const pv = sat.propagate(e.rec, now); if (pv && pv.position) valid.push(e) } catch { /* skip */ }
  }
  if (filtering) {
    renderEntries = valid          // 只显示命中星（含命中的自定义星；不再叠加全部自定义星座）
    renderHasColor = true          // 逐点按各自分组/自定义色上色
  } else {
    const custom = customConst.entriesForRender()   // 自定义星座合成星追加在真实星之后（点云索引对齐 renderEntries）
    renderEntries = custom.length ? valid.concat(custom) : valid
    renderHasColor = custom.length > 0 || hasGroupColorOverrides() || satGrpColor.size > 0
  }
  satCount.value = base.length
  refreshPositions()
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
  nowTick.value++                                                      // 一拍一次：驱动随时刻走的读数
  if (live.value) baseTime.value = clock.tMs                           // 实时：锚点随系统时钟滑动（游标恒钉在 0）
  else followCursor()                                                  // 播放推进跑出可见窗口 → 平移尺子接回来
  // 晨昏线随时间轴/实时移动。放在早退之前：一颗星都不显示时晨昏线照样该走（它只跟时刻有关，与星无关）。
  if (termOn.value) applyTerminator()
  // renderEntries 已含可见自定义星座（即使内置组选「无」也可能非空），故只按空判断，不再短路 'none'
  if (!renderEntries.length) {
    scene.setSatellites([]); shownCount.value = 0; _tickEcefN = 0
    if (vis.open.value) vis.recompute()
    commitGeometry()
    if (hasLinkedElev() || vis.open.value) redrawSats()
    // 与正常分支同款带 extras 并接 satcovTick：GRD 关联星按星历解算不依赖在场星（satLivePos 走
    // 全量目录），「无」分组下时间推进照样要修 meta。早先这里无参 tickLive 且不接对星，对星那份
    // meta 停在恢复时的存盘位置——视轴/壳层错位，切分组前怎么播放都修不回来。
    const tk = grd.tickLive([perfKey.value || null, satcov.active.value || null, ...satcov.selected.value])
    if (perfKey.value && tk.moved && tk.moved.has(perfKey.value)) refreshPerf()
    satcovTick(tk.moved)
    satcovClockTick()
    await geomPending
    return
  }
  const now = calcAt(), gmst = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)   // 合成星按固定场景历元解算（跨会话稳定）
  const n = renderEntries.length
  const positions = new Array(n)
  const colors = renderHasColor ? new Float32Array(n * 3) : null   // 有自定义星座时逐点上色（真实星取默认色）
  const sgOn = satGrpColor.size > 0   // 卫星组配色查表开关：没人着色时逐星免掉 String+Map.get
  // 本拍的在场星 ECEF 快照：只在【真有人要】时才存 ——「波束内的星」那个档开着才用得上。
  // ★ 无条件存是笔白账：7000 颗星每拍多 7000 次 ECI→ECEF 旋转 + 一次 168 KB 的写入，
  //   而绝大多数时候那张表根本没开。（这条是本轮改动自己引入的回归，别再无条件做。）
  const wantEcef = satcovTableOpen.value && satPerf.targetMode.value === 'beam'
  if (wantEcef) {
    if (!_tickEcef || _tickEcef.length < n * 3) _tickEcef = new Float64Array(Math.max(1024, n * 3))
    _tickEcefN = n
  } else _tickEcefN = 0
  for (let k = 0; k < n; k++) {
    const e = renderEntries[k]
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    let pos
    try {
      const pv = sat.propagate(e.rec, t)
      if (pv && pv.position) {
        const gd = sat.eciToGeodetic(pv.position, g); pos = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }
        if (wantEcef) { const ecf = sat.eciToEcf(pv.position, g); _tickEcef[k * 3] = ecf.x; _tickEcef[k * 3 + 1] = ecf.y; _tickEcef[k * 3 + 2] = ecf.z }
      } else { pos = { lat: 0, lon: 0, altKm: -RE }; if (wantEcef) _tickEcef[k * 3] = NaN }   // 占位，保持索引对齐（落到地心不可见）
    } catch { pos = { lat: 0, lon: 0, altKm: -RE }; if (wantEcef) _tickEcef[k * 3] = NaN }
    positions[k] = pos
    if (colors) { const c = (sgOn && satGrpColor.get(String(e.noradId))) || e.color || groupRgb(e.group) || DEFAULT_SAT_RGB; colors[k * 3] = c[0]; colors[k * 3 + 1] = c[1]; colors[k * 3 + 2] = c[2] }
  }
  scene.setSatellites(positions, colors)
  shownCount.value = n
  if (vis.open.value) vis.recompute()   // 可见性：可见星随时间轴/实时重算（commitGeometry 读取其结果）
  if (selEntry) {
    const c = cardFor(selEntry); if (c) selected.value = c
    buildSelList()
    if (points.value.length || stations.value.length) pushMarkers()   // 随卫星移动刷新标记仰角
  }
  commitGeometry()   // 聚焦星几何 + 可见性叠加层合并提交：二者同时呈现、均随时间轴移动（聚焦星星下点/轨迹不再被可见性覆盖）
  if (hasLinkedElev() || vis.open.value) redrawSats()   // 星座关联星仰角线 / 可见性目标点：随时间轴/实时跟踪
  // 星动 → GRD 覆盖随时间轴移动；两张性能指标表与对星壳层也随之重算（取值/几何都依赖星位推出的 basis）
  {
    const tk = grd.tickLive([perfKey.value || null, satcov.active.value || null, ...satcov.selected.value])
    const mv = tk.moved
    if (perfKey.value && mv && mv.has(perfKey.value)) refreshPerf()
    satcovTick(mv)
    satcovClockTick()   // 对星侧的表与「波束内的星」跟随时钟（与画面同一时刻，见其注释）
  }
  if (satModal.value && satModal.value.noradId) liveTick.value++   // 关联星编辑中：驱动弹窗经纬度/高度刷新
  persistGrdLive()   // 写实时关联星当前星下点到轻量缓存，供链路预算窗口「导入时取新位置」
  await geomPending   // 本拍的聚焦几何画完，这一拍才算完（时钟据此排下一拍、并如实算实测倍速）
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
  if (entries.length) logMsg(`${payloadGroup === 'import' ? '导入文件' : (GROUP_LABEL[payloadGroup] || '星座')}：加载 ${entries.length} 颗卫星（星历 ${dataTime.value}）`)
  // 跨分组/恢复选中：按 NORAD 定位
  if (pendingNorad) {
    const e = entries.find((x) => String(x.noradId) === String(pendingNorad))
    const noFace = pendingNoFace
    pendingNorad = null; pendingNoFace = false
    if (e) { selectSat(e, !noFace) }
  }
}

async function loadGroup() {
  if (!apiOk) { status.value = '需在桌面客户端中运行'; return }
  const g = GROUPS[groupIndex.value]
  filterEntries = []; filterN.value = 0; filterKw.value = ''; filterGroupId.value = ''   // 切分组 → 退出搜索筛选态（含卫星组显示）
  resetBeam(); selEntries = []; selEntry = null; selected.value = null; selList.value = []; scene && scene.clearSelectionGeom(); poolEntries = null; lastGeom = null   // 这条清的是渲染器不是缓存：lastGeom 一并作废，免得随后改样式把清掉的星按旧缓存重喂回来
  // 「无」：不加载/不传播/不渲染任何卫星，省 SGP4 与点渲染开销（覆盖图、地球照常）
  if (g.key === 'none') {
    entries = []; satCount.value = 0
    rebuildRenderSet()   // 仅渲染可见的自定义星座（若有），否则清空点云
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
  // 「自定义卫星」：读本地库 OMM CSV（文件管理导入的 OMM/TLE），永不联网。导入的星历【保留文件内历元】，
  // 与内置真实组同口径按各自历元正向传播到此刻（自建星座才用场景历元，二者互不影响）。
  if (g.key === 'custom') {
    try {
      const rawC = await window.api.omm.customCsv()
      const sats = rawC && rawC.text ? parseOMMCsv(rawC.text) : []
      if (sats.length) { ingest(sats, 'custom', (rawC && rawC.fetchedAt) || new Date().toISOString()); status.value = '' }
      else { entries = []; rebuildRenderSet(); redrawSats(); dataTime.value = '—'; status.value = '暂无自定义卫星——请在「文件管理 · 星历」导入 OMM / TLE' }
    } catch (e) { entries = []; rebuildRenderSet(); status.value = '自定义卫星读取失败：' + ((e && e.message) || e) }
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
  const keys = GROUPS.filter((g) => !['all', 'other', 'none', 'custom'].includes(g.key)).map((g) => g.key)
  let done = 0
  setS(`加载全部卫星 0/${keys.length + 1} …`)
  const tick = () => { done++; setS(`加载全部卫星 ${done}/${keys.length + 1} …`) }
  const fetchedAts = []   // 各组实际下载落盘时间 → 合并视图取最新一份作为 OMM 显示时间
  let miss = 0            // 本次一份都没取到的组数（含 active）：>0 表示这份并集是残缺的
  const tasks = keys.map((key) => fetchGroupLiveOrSup(key)
    .then((p) => { tick(); if (p.fetchedAt) fetchedAts.push(p.fetchedAt); for (const s of p.sats) s._group = key; return p.sats })
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
  try { const ap = await fetchGroupLiveOrSup('active'); active = ap.sats; if (ap.fetchedAt) fetchedAts.push(ap.fetchedAt) } catch { miss++ }
  tick()
  for (const s of active) if (!universe.has(s.noradId)) universe.set(s.noradId, s)
  // 本地自定义卫星库并入全集（永不联网）：以用户库为准覆盖同号目录星，归入 'custom' 组；保留文件内历元。
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
  universeIntact = miss === 0 && fetchedAts.length === keys.length + 1
  // 新鲜度按【最旧】一份算，不按最新：某组回落到旧缓存 / 内置快照时，不能拿别组的新时间去判它的星离轨。
  universeFetchedMin = fetchedAts.length ? fetchedAts.reduce((a, b) => (b < a ? b : a)) : null
  return [...universe.values()]
}
let universeFetchedAt = null   // loadUniverse 产出的“各组最新下载时间”，供 loadAll/loadOther 显示
let universeIntact = false     // 本次并集是否一组不缺（见上）
let universeFetchedMin = null  // 本次并集里最旧一份的下载时间（见上）
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
let poolReady = false, poolLoading = false, poolPromise = null
let filterEntries = []   // 搜索即筛选的显示集（命中星，跨分组，来自全量池）；非空 → renderEntries 渲染它而非当前分组
let filterTimer = null   // 输入即筛选的防抖计时器
const filterN = ref(0)   // 筛选命中数（模板状态提示；0 = 非筛选态）
const filterKw = ref('')   // 当前筛选词（独立于 keyword —— pickResult 会清 keyword 但筛选仍在，状态条据此显示）
const filterGroupId = ref('')   // 非空=当前筛选显示集来自某个已存「卫星组」（状态条改标签 + 组列表高亮）；被搜索/换组清掉
// 卫星集「具体是谁」标签：给可见性分析「分析目标」区显式点出正在分析哪些星——口径与 rebuildRenderSet 完全一致：
//   搜索/卫星组筛选态优先（filterN>0）；否则=内置分组（非「无」）+ 全部可见自定义星座（可叠加，故可能多来源）。
// 用于让用户一眼知道 238 颗到底是 Starlink / 某自定义星座 / 某卫星组 / 搜索结果，而非只看到裸数字。
// lit＝这个 name 是界面词而不是用户数据（缺省占位、内置分组名），英文模式下该翻；
// 用户起的名字（自定义星座 / 卫星组 / 搜索词）不翻，故渲染处按它决定挂不挂 i18n-skip。
const satSetLabel = computed(() => {
  if (filterN.value > 0) {
    return filterGroupId.value
      ? { kind: '卫星组', name: filterKw.value || '未命名组', lit: !filterKw.value }
      : { kind: '搜索', name: filterKw.value || '关键词', lit: !filterKw.value }
  }
  const g = GROUPS[groupIndex.value]
  const names = []
  if (g && g.key !== 'none') names.push(g.label)         // 「无（不渲染星座）」不计入——它没有真实星
  for (const c of customConst.list.value) if (c.visible !== false) names.push(c.name)
  if (!names.length) return { kind: '', name: '无', lit: true }
  if (names.length === 1) return { kind: (g && g.key === 'none') ? '自定义星座' : '星座', name: names[0], lit: !!(g && g.key !== 'none') }
  return { kind: '混合', name: names.join(' + ') }        // 内置组叠加自定义星座 / 多座自定义星座并显
})
// 【必须等在建的那一次】：早先「poolLoading 就早退」会让第二个调用方在池子只建了一半时就拿 searchSource()
// 回退到当前组 entries —— 表现是「点了没反应 / 说卫星不在星历中」，跨组的那批星明明在目录里。
async function ensureSearchPool() {
  if (poolReady || !apiOk) return
  if (poolPromise) { await poolPromise; return }
  const p = (async () => {
    poolLoading = true
    try {
      const sats = await loadUniverse(true)   // 静默：不打扰主状态栏
      const pool = []
      for (const s of sats) { try { const r = sat.omm2satrec(s); if (r && !r.error) pool.push({ rec: r, name: s.name, noradId: s.noradId, group: s._group || 'other' }) } catch { /* skip */ } }
      if (pool.length) {
        searchPool = pool; poolReady = true; _poolByNorad = null; poolTick.value++   // 就绪信号：卫星组行内列表重映射补 GEO 定点标注
        satGrpSweep()   // 拿到最新目录的这一刻，顺手按它核对全部卫星组的成员（自身把三道闸，不满足即空转）
      }
    } catch { /* 离线/失败：回退当前组 */ } finally { poolLoading = false }
  })()
  poolPromise = p
  try { await p } finally { if (poolPromise === p) poolPromise = null }
}
// 全量目录（或当前组）+ 自定义星座合成星（含隐藏，见「隐藏也算数」）。自定义星放最前，
// 确保在结果条数上限内一定先被扫到、搜得到；号段 900000+ 与真实目录不撞。
const searchSource = () => {
  const base = poolReady && searchPool.length ? searchPool : entries
  const cc = customConst.catalog()
  return cc.length ? cc.concat(base) : base
}

function selectSat(e, face, additive) {
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
  if (face && scene) faceEntry(selEntry)
  saveSelection()
}
// 刷新主选卡片 + 全体几何 + 多选列表 + 标记 + 2D 聚焦
function refreshSelection() {
  const c = cardFor(selEntry); if (c) selected.value = c
  buildSelList()
  pushMarkers()
  commitGeometry()   // 选中星几何 + 星下点（含可见性叠加层，若开）合并提交
}
// 旋转地球使某星正对视图
function faceEntry(e) {
  const now = isCustomEntry(e) ? ccTimeAt() : calcAt(), gmst = sat.gstime(now)   // 合成星按场景历元定位朝向
  const pv = sat.propagate(e.rec, now)
  if (!pv || !pv.position) return
  const gd = sat.eciToGeodetic(pv.position, gmst)
  const lat = sat.degreesLat(gd.latitude), lon = sat.degreesLong(gd.longitude)
  const phi = (90 - lat) * Math.PI / 180, theta = (lon + 180) * Math.PI / 180
  scene.faceTo({ x: -Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) })
  autoRotate.value = false
}
// 卡片 mini-row：设为主选 / 移出
function setPrimary(row) { const e = selEntries[row.idx]; if (!e || e === selEntry) return; selEntry = e; refreshSelection(); saveSelection() }
function removeSel(row) {
  const e = selEntries[row.idx]; if (!e) return
  selEntries.splice(row.idx, 1)
  if (selEntry === e) selEntry = selEntries[selEntries.length - 1] || null
  if (!selEntry) { closeCard(); return }
  refreshSelection(); saveSelection()
}
// 编辑星座实时预览/提交/取消后：把仍指向旧对象的选中项按名字重绑到 renderEntries 里的新对象（覆盖/星下点/轨迹/卡片随之同步）
function rebindSelection(preferGroup) {
  if (!selEntries.length) return
  let changed = false
  const next = []
  for (const e of selEntries) {
    if (!e.group || e.group.indexOf('cc') !== 0) { next.push(e); continue }   // 只重绑自定义星座/预览星
    if (renderEntries.includes(e)) { next.push(e); continue }                  // 对象仍在场=无需重绑
    const m = renderEntries.find((x) => x.group === preferGroup && x.name === e.name)
           || renderEntries.find((x) => x.group && x.group.indexOf('cc') === 0 && x.name === e.name)
    if (m) { if (selEntry === e) selEntry = m; next.push(m); changed = true }
    else if (selEntry === e) selEntry = null                                   // 该槽位已不存在
  }
  selEntries = next
  if (!selEntries.length) { closeCard(); return }
  if (!selEntry || !selEntries.includes(selEntry)) selEntry = selEntries[selEntries.length - 1]
  if (changed) refreshSelection()
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
      out.push({ en, name: en.name, noradId: en.noradId, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || GROUP_LABEL[curKey()] || '', slot: geoSlotOfSatrec(en.rec) })
    }
  }
  searchResults.value = out
}
function clearSearch() {
  keyword.value = ''; searchResults.value = []
  if (filterTimer) { clearTimeout(filterTimer); filterTimer = null }
  if (filterEntries.length) { filterEntries = []; filterN.value = 0; filterKw.value = ''; filterGroupId.value = ''; rebuildRenderSet(); redrawSats() }   // 退出筛选态（含卫星组显示）→ 恢复当前分组
}
// 搜索即筛选显示：命中星（全量池，跨分组）作为临时显示集渲染到 3D；空词恢复当前分组。可见性分析「当前显示的星」随之变。
async function applyFilter(kw) {
  const k = String(kw || '').trim().toLowerCase()
  if (!k) { if (filterEntries.length) { filterEntries = []; filterN.value = 0; filterKw.value = ''; filterGroupId.value = ''; rebuildRenderSet(); redrawSats() } return }
  await ensureSearchPool()
  const src = searchSource(), hit = [], seen = new Set()
  for (const en of src) {
    if (!(en.name.toLowerCase().includes(k) || String(en.noradId).includes(k) || (en.groupLabel && en.groupLabel.toLowerCase().includes(k)))) continue
    const nid = String(en.noradId); if (seen.has(nid)) continue
    seen.add(nid); hit.push(en)
  }
  filterEntries = hit; filterN.value = hit.length; filterKw.value = String(kw).trim(); filterGroupId.value = ''   // 键入关键词 → 退出卫星组显示态
  rebuildRenderSet(); redrawSats()
}
function pickResult(item) { searchResults.value = []; keyword.value = ''; selectSat(item.en, true) }
function closeCard() { selEntries = []; selEntry = null; selected.value = null; selList.value = []; resetBeam(); pushMarkers(); commitGeometry(); saveSelection() }   // commitGeometry 清聚焦星几何/星下点；可见性叠加层（若开）保留

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
  if (!sats.length && filterEntries.length && filterGroupId.value !== g.id) sats = filterEntries.map((e) => ({ noradId: e.noradId, name: e.name }))
  if (!sats.length) { appAlert('尚未选中卫星。'); return }
  const n = satGroups.append(g.id, sats)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已加入 ${n} 颗到卫星组「${g.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `所选卫星都已在「${g.name}」中`)
  if (n && filterGroupId.value === g.id && gg) showSatGroup(gg)   // 正在看这组 → 刷新显示纳入新星
}
// 把当前选中的卫星【移出】某组（一般用于正在显示的组：点该组显示 → Ctrl 选要删的星 → 移出）
function removeSelFromGroup(g) {
  const ids = selSatsForGroup().map((s) => s.noradId)
  if (!ids.length) { appAlert('尚未选中要移出的卫星。'); return }
  const n = satGroups.removeSats(g.id, ids)
  const gg = satGroups.find(g.id)
  logMsg(n ? `已从卫星组「${g.name}」移出 ${n} 颗（剩 ${gg ? gg.sats.length : '?'} 颗）` : '所选卫星不在该组中')
  if (n && filterGroupId.value === g.id) { (gg && gg.sats.length) ? showSatGroup(gg) : clearSearch() }
}
// 已解析好的 entries → 变成「筛选显示集」（跨分组、点选、覆盖圈、可见性全部照常）
function showEntries(hit, label, groupId) {
  if (!hit || !hit.length) return false
  keyword.value = ''; searchResults.value = []
  if (filterTimer) { clearTimeout(filterTimer); filterTimer = null }
  filterEntries = hit; filterN.value = hit.length; filterKw.value = label; filterGroupId.value = groupId || ''
  soloConst.value = null
  rebuildRenderSet(); redrawSats()
  return true
}
// 把地球转到一批星的「中心」：单位方向矢量取平均（星群铺满全球时合矢量趋零 → 没有中心可言，不动镜头）
function faceEntries(list) {
  if (!scene || !list || !list.length) return
  const now = calcAt(), gmst = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)
  let x = 0, y = 0, z = 0, n = 0
  for (const e of list) {
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    let pv = null
    try { pv = sat.propagate(e.rec, t) } catch { pv = null }
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
  autoRotate.value = false
}
// 按 NORAD 集显示到地图。sats=[{id|noradId}]；label=状态条标签；groupId 非空表示这批来自某个已存卫星组（组行随之高亮）。
async function showNorads(sats, label, groupId) {
  const arr = sats || []
  if (!arr.length) return false
  await ensureSearchPool()
  const want = new Set(arr.map((s) => String(s.noradId != null ? s.noradId : s.id)))
  const src = searchSource(), hit = [], seen = new Set()
  for (const en of src) {
    const nid = String(en.noradId)
    if (want.has(nid) && !seen.has(nid)) { seen.add(nid); hit.push(en) }
  }
  if (!hit.length) { appAlert(`「${label}」的卫星在当前星历中都未找到（可能未联网加载全量目录，或卫星已退役）`); return false }
  showEntries(hit, label, groupId)
  const miss = want.size - hit.length
  status.value = miss > 0 ? `${label}：显示 ${hit.length} 颗（另有 ${miss} 颗未在当前星历中找到）` : ''
  return true
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
// 显示某卫星组
async function showSatGroup(g) {
  if (!g) return
  if (!(g.sats || []).length) { appAlert(`卫星组「${g.name}」还没有卫星。`); return }
  await showNorads(g.sats, g.name, g.id)
}
// 点击组行：已在显示→再点退出（回到当前分组）；否则显示该组
function toggleSatGroup(g) {
  satGrpRenameId.value = ''; satGrpDelId.value = ''   // 切换显示 → 收起任何未完成的行内改名/删除确认
  if (filterGroupId.value === g.id) clearSearch(); else showSatGroup(g)
}
function satGrpCommitRename(g) {
  if (satGroups.rename(g.id, satGrpRenameVal.value)) {
    if (filterGroupId.value === g.id) filterKw.value = satGrpRenameVal.value.trim() || filterKw.value   // 正在显示的组改名 → 同步状态条标签
  }
  satGrpRenameId.value = ''
}
// 两步删除：首次点击进入「确认」态，再点一次才真正删除
function satGrpDelete(g) {
  if (satGrpDelId.value !== g.id) { satGrpDelId.value = g.id; return }
  if (filterGroupId.value === g.id) clearSearch()   // 正在显示的组被删 → 退出显示态
  expDrop('s:' + g.id)
  satGroups.remove(g.id)
  satGrpDelId.value = ''
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
    const uni = await loadUniverse(true)
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
  showEntries(hit, label, '')
  // 选中（含主选）：直接铺 selEntries，与 selectSat 的多选路径同构
  selEntries = hit
  selEntry = selEntries[0]
  resetBeam()
  refreshSelection()
  faceEntries(hit)     // 单颗时与 faceEntry 逐位一致；一批则转到它们的方向矢量均值
  saveSelection()
  const miss = sats.length - hit.length
  const parts = []
  if (miss > 0) parts.push(`另有 ${miss} 颗未在当前星历中找到`)
  const tail = parts.length ? `（${parts.join('；')}）` : ''
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
  if (tag[0] === 'g') expLoad(tag)
}
async function expLoad(tag) {
  const seq = ++expSeq
  expLoading.value = true
  try {
    const list = await grpSatList(tag.slice(2))
    if (seq !== expSeq || expTag.value !== tag) return
    expItems.value = list
  } catch (e) {
    if (seq !== expSeq || expTag.value !== tag) return
    expErr.value = '列表加载失败：' + ((e && e.message) || e)
  } finally { if (seq === expSeq) expLoading.value = false }
}
// 双击 / 回车：按 NORAD 从全量池解回该星并聚焦（与搜索结果点选同一路径，未渲染的星也能定位）
async function expLocate(it) {
  await ensureSearchPool()
  const nid = String(it.id)
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
    if (n && filterGroupId.value === g.id) { g.sats.length ? showSatGroup(g) : clearSearch() }
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
  if (n && filterGroupId.value === g.id && gg) showSatGroup(gg)   // 正在看这组 → 刷新显示纳入新星
}
function expMenuNew() {
  const m = expMenu.value; if (!m) return
  expMenu.value = null
  const g = satGroups.add(m.sats, expLabel.value ? (expLabel.value + ' 选集') : '')
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}

// ===================== 侧栏行右键菜单（内置星座 / 卫星组 / 自定义星座三类行共用一套） =====================
// kind: 'grp'=内置星座行（obj=GROUPS 项，idx=下标） | 'sg'=卫星组行 | 'cc'=自定义星座行。
// 剪贴板只有一份：复制卫星只填 sats；复制自定义星座另填 cfg —— 于是能粘出一座同参数的新星座，
// 也能把它的合成星粘进卫星组。删除走菜单内两步确认（与行内删除按钮同口径，不做一击即删）。
const rowMenu = ref(null)       // { x, y, kind, obj, idx }；null=隐藏
const rowMenuEl = ref(null)
const rowMenuArm = ref(false)   // 删除已进入确认态
const satClip = ref(null)       // { label, sats:[{noradId,name}], cfg:null|{name,params,color,colorByPlane} }
function openRowMenu(e, kind, obj, idx) {
  satGrpRenameId.value = ''; satGrpDelId.value = ''   // 收起未完成的行内改名/删除确认
  expMenu.value = null; ctxMenu.value = null
  rowMenuArm.value = false
  rowMenu.value = { x: e.clientX, y: e.clientY, kind, obj, idx: idx == null ? -1 : idx }
  nextTick(() => {   // 按实际渲染尺寸夹进视口：靠下边缘右键时不被裁掉一截
    const el = rowMenuEl.value, m = rowMenu.value
    if (!el || !m) return
    const r = el.getBoundingClientRect(), pad = 4
    const x = Math.max(pad, Math.min(m.x, window.innerWidth - r.width - pad))
    const y = Math.max(pad, Math.min(m.y, window.innerHeight - r.height - pad))
    if (x !== m.x || y !== m.y) rowMenu.value = { ...m, x, y }
  })
}
function closeRowMenu() { rowMenu.value = null; rowMenuArm.value = false }
const rowMenuName = (m) => !m ? '' : (m.kind === 'grp' ? m.obj.label : m.obj.name)
const rowMenuTag = (m) => !m ? '' : (m.kind === 'sg' ? 's:' + m.obj.id : (m.kind === 'cc' ? 'c:' + m.obj.id : 'g:' + m.obj.key))
// 菜单里能显示的颗数：卫星组/自定义星座当场就知道；内置星座要读名录，未读过则不显示计数
const rowMenuCount = computed(() => {
  const m = rowMenu.value; if (!m) return null
  if (m.kind === 'sg') return m.obj.sats.length
  if (m.kind === 'cc') return customConst.count(m.obj)
  const hit = grpListCache.get(m.obj.key)
  return hit ? hit.length : null
})
const rowMenuHasSats = computed(() => { const m = rowMenu.value; return !!m && !(m.kind === 'grp' && m.obj.key === 'none') })
// 该行代表的一批卫星（内置星座按需读名录，会话内缓存；失败弹提示并返回 null）
async function rowMenuSats(m) {
  if (!m) return []
  if (m.kind === 'sg') return (m.obj.sats || []).map((s) => ({ noradId: s.id, name: s.name }))
  if (m.kind === 'cc') return customConst.satsOf(m.obj.id).map((e) => ({ noradId: e.noradId, name: e.name }))
  return (await grpSatList(m.obj.key)).map((it) => ({ noradId: it.id, name: it.name }))
}
async function rowMenuTake(m) {
  try { return await rowMenuSats(m) }
  catch (e) { appAlert(`读取「${rowMenuName(m)}」的卫星名录失败：${(e && e.message) || e}`); return null }
}
// —— 菜单动作 ——
async function rowMenuFocus() {
  const m = rowMenu.value; if (!m) return
  closeRowMenu()
  const label = rowMenuName(m)
  status.value = `${label}：读取卫星名录…`
  const sats = await rowMenuTake(m)
  if (!sats) { status.value = ''; return }
  if (!sats.length) { status.value = ''; appAlert(`「${label}」还没有卫星。`); return }
  expFocus(sats, label, rowMenuTag(m))
}
async function rowMenuCopySats() {
  const m = rowMenu.value; if (!m) return
  closeRowMenu()
  const label = rowMenuName(m)
  const sats = await rowMenuTake(m)
  if (!sats) return
  if (!sats.length) { appAlert(`「${label}」还没有卫星。`); return }
  satClip.value = { label, sats, cfg: null }
  logMsg(`已复制「${label}」的 ${sats.length} 颗卫星`)
}
function rowMenuCopyConst() {
  const m = rowMenu.value; if (!m || m.kind !== 'cc') return
  const c = m.obj
  closeRowMenu()
  satClip.value = {
    label: c.name,
    sats: customConst.satsOf(c.id).map((e) => ({ noradId: e.noradId, name: e.name })),
    cfg: { name: c.name, params: { ...c.params }, color: c.color, colorByPlane: c.colorByPlane !== false }
  }
  logMsg(`已复制自定义星座「${c.name}」`)
}
function pasteAsNewGroup(clip) {
  const g = satGroups.add(clip.sats, clip.label || '')
  if (g) { logMsg(`已粘贴为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}
// 粘贴：卫星组行=加入本组（去重追加）；自定义星座行=粘一座同参数的新星座；内置星座行=粘成新的卫星组
function rowMenuPaste() {
  const m = rowMenu.value, clip = satClip.value; if (!m || !clip) return
  closeRowMenu()
  if (m.kind === 'sg') {
    const n = satGroups.append(m.obj.id, clip.sats)
    const gg = satGroups.find(m.obj.id)
    logMsg(n ? `已粘贴 ${n} 颗到卫星组「${m.obj.name}」（去重后共 ${gg ? gg.sats.length : '?'} 颗）` : `剪贴板里的卫星都已在「${m.obj.name}」中`)
    if (n && filterGroupId.value === m.obj.id && gg) showSatGroup(gg)
    return
  }
  if (m.kind === 'cc') {
    if (!clip.cfg) { pasteAsNewGroup(clip); return }   // 剪贴板里是一批卫星 → 只能落成卫星组
    const cfg = customConst.add({ ...clip.cfg, name: clip.cfg.name + ' 副本' })
    logMsg(`已粘贴自定义星座「${cfg.name}」`)
    showConstAlone(cfg)
    return
  }
  pasteAsNewGroup(clip)
}
async function rowMenuSaveGroup() {
  const m = rowMenu.value; if (!m) return
  closeRowMenu()
  const label = rowMenuName(m)
  const sats = await rowMenuTake(m)
  if (!sats) return
  if (!sats.length) { appAlert(`「${label}」还没有卫星。`); return }
  const g = satGroups.add(sats, label)
  if (g) { logMsg(`已存为卫星组「${g.name}」：${g.sats.length} 颗`); satGrpEnterRename(g) }
}
function rowMenuShow() {
  const m = rowMenu.value; if (!m) return
  closeRowMenu()
  if (m.kind === 'grp') { pickGroup(m.idx); return }
  if (m.kind === 'sg') { toggleSatGroup(m.obj); return }
  showConstAlone(m.obj)
}
function rowMenuExpand() {
  const m = rowMenu.value; if (!m) return
  const tag = rowMenuTag(m), label = rowMenuName(m)
  closeRowMenu()
  expToggle(tag, label)
}
function rowMenuDup() {
  const m = rowMenu.value; if (!m) return
  closeRowMenu()
  if (m.kind === 'sg') {
    const c = satGroups.duplicate(m.obj.id)
    if (c) { logMsg(`已复制卫星组「${m.obj.name}」→「${c.name}」`); satGrpEnterRename(c) }
    return
  }
  if (m.kind === 'cc') {
    const c = m.obj
    const cfg = customConst.add({ name: c.name + ' 副本', params: { ...c.params }, color: c.color, colorByPlane: c.colorByPlane !== false })
    logMsg(`已复制自定义星座「${c.name}」→「${cfg.name}」`)
    showConstAlone(cfg)
  }
}
function rowMenuRename() { const m = rowMenu.value; if (!m || m.kind !== 'sg') return; const g = m.obj; closeRowMenu(); satGrpEnterRename(g) }
function rowMenuManage() { const m = rowMenu.value; if (!m || m.kind !== 'sg') return; const g = m.obj; closeRowMenu(); openSatGrpMgr(g) }
function rowMenuEdit() { const m = rowMenu.value; if (!m || m.kind !== 'cc') return; const c = m.obj; closeRowMenu(); openConstWizard(c) }
function rowMenuToggleVis() { const m = rowMenu.value; if (!m || m.kind !== 'cc') return; const id = m.obj.id; closeRowMenu(); customConst.toggle(id) }
function rowMenuResetColor() { const m = rowMenu.value; if (!m || m.kind !== 'grp') return; const k = m.obj.key; closeRowMenu(); resetGroupColor(k) }
function rowMenuAddSel() {
  const m = rowMenu.value; if (!m || m.kind !== 'sg') return
  const g = m.obj; closeRowMenu(); addSelToGroup(g)
}
// 两步删除：首次点击进入确认态（菜单不关），再点一次才真正删除
function rowMenuDelete() {
  const m = rowMenu.value; if (!m) return
  if (!rowMenuArm.value) { rowMenuArm.value = true; return }
  closeRowMenu()
  if (m.kind === 'sg') {
    const g = m.obj
    if (filterGroupId.value === g.id) clearSearch()   // 正在显示的组被删 → 退出显示态
    expDrop('s:' + g.id)
    satGroups.remove(g.id)
    logMsg(`已删除卫星组「${g.name}」`)
    return
  }
  if (m.kind === 'cc') {
    const c = m.obj
    if (soloConst.value === c.id) soloConst.value = null
    removeConst(c)
    logMsg(`已删除自定义星座「${c.name}」`)
  }
}

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
  if (satGroups.rename(g.id, sgmNameVal.value) && filterGroupId.value === g.id) filterKw.value = g.name   // 正在显示的组改名 → 同步状态条标签
}
function sgmDup(g) {
  const c = satGroups.duplicate(g.id)
  if (c) { sgmId.value = c.id; sgmSel.value = []; sgmMemKw.value = ''; logMsg(`已复制卫星组「${g.name}」→「${c.name}」`) }
}
function sgmDel(g) {
  if (sgmDelId.value !== g.id) { sgmDelId.value = g.id; return }
  if (filterGroupId.value === g.id) clearSearch()
  expDrop('s:' + g.id)
  satGroups.remove(g.id)
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
      for (const en of searchSource()) {
        if (out.length >= SGM_MAX) break
        if (!(en.name.toLowerCase().includes(kk) || String(en.noradId).includes(kk) || (en.groupLabel && en.groupLabel.toLowerCase().includes(kk)))) continue
        const nid = String(en.noradId); if (seen.has(nid)) continue
        seen.add(nid); out.push({ id: nid, name: en.name, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || '', slot: geoSlotOfSatrec(en.rec) })
      }
      sgmRes.value = out
    } finally { if (sgmKw.value.trim() === k) sgmBusy.value = false }
  }, 220)
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
  if (n && filterGroupId.value === g.id) showSatGroup(g)   // 正在看这组 → 刷新显示纳入新星
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
  if (n && filterGroupId.value === g.id) { g.sats.length ? showSatGroup(g) : clearSearch() }
}
function sgmShow() {
  const g = sgmCur.value; if (!g) return
  if (!g.sats.length) { appAlert('该组还没有卫星。'); return }
  closeSatGrpMgr(); showSatGroup(g)
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
// 波束全锥角 B(°) ↔ 最低仰角 ε(°)：同一覆盖圈的两种参数化，由卫星高度 h 唯一对应。
//   sin(B/2) = (RE/r)·cos ε，r=RE+h；B/2 ≥ asin(RE/r)（地平）时 ε=0。切换定义方式时按此换算，覆盖圈不变。
function selAltKm() {
  if (!selEntry) return null
  const now = isCustomEntry(selEntry) ? ccTimeAt() : calcAt(); const pv = sat.propagate(selEntry.rec, now)
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
// 图例色条：跟着显示设置取色与线型（点线在 18px 的短条上按 dotted 画，观感与图上一致）
// 点划线在 18px 的短条上画不出「长划-点」的节奏，退回 dashed（观感上仍是断线，与实线/点线可分）
const swStyle = (color, dash) => ({ borderColor: color, borderTopStyle: dash === 'dot' ? 'dotted' : (dash === 'dash' || dash === 'dashdot') ? 'dashed' : 'solid' })
const fpSwStyle = computed(() => swStyle(focusStyle.fpColor, focusStyle.fpDash))
const trkSwStyle = computed(() => swStyle(focusStyle.trkColor, focusStyle.trkDash))

// ===================== 时间轴 =====================
const track = ref(null)
// —— 可配置时间窗 + 自适应刻度尺（参考 Cesium Timeline / DAW scrubber）——
const PAST_FRAC = 0.25                                   // 窗口内展示的「过去」占比（可回看过去）
// 跨度上下限：2min ~ 30 天。★下限压到 2 min 是为了游标的秒级——600 px 上 2 min ＝ 0.2 s/px，
// 拖动吸附随之细到 1 s（见 cursorSnapSec）；原来的 10 min 下限只能吸到 5~10 s。
const WIN_MIN = 2, WIN_MAX = 43200
// 时间窗预设。★ 只是【下拉里的常用档】，不是可选跨度的全集 —— 滚轮照样缩放到 2 min ~ 30 天之间任意值，
// 落到预设之外就在下拉里挂一条自定义档（isCustomWindow）。
const WINDOW_PRESETS = [{ v: 720, l: '12h' }, { v: 1440, l: '24h' }, { v: 2880, l: '2d' }, { v: 4320, l: '3d' }, { v: 10080, l: '7d' }]
const NICE = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 345600, 604800]   // 「整齐」刻度阶梯(秒)
const _mod = (x, y) => x - y * Math.round(x / y)
// —— 时间轴读数时区：'local'（本机时区，默认）| 'utc' ——
// 只影响【显示】：Date 内部是 UTC 毫秒数，星位/晨昏线全程走 getUTC*，切这个开关不改变任何计算结果。
// 加它是因为晨昏线、星历历元、过境窗口都是 UTC 口径，对国际时刻时需要直接读 UTC 而不是心算 −8。
const tzMode = ref('local')
const tzUtc = () => tzMode.value === 'utc'
// 一组「按当前时区档位取分量」的读数器：UTC 档走 getUTC*，本地档走 getXxx（口径与切换前逐字一致）
const tYear = (d) => (tzUtc() ? d.getUTCFullYear() : d.getFullYear())
const tMon = (d) => (tzUtc() ? d.getUTCMonth() : d.getMonth())
const tDay = (d) => (tzUtc() ? d.getUTCDate() : d.getDate())
const tHour = (d) => (tzUtc() ? d.getUTCHours() : d.getHours())
const tMin = (d) => (tzUtc() ? d.getUTCMinutes() : d.getMinutes())
const tSec = (d) => (tzUtc() ? d.getUTCSeconds() : d.getSeconds())
// 本机时区标签（如 UTC+8）：来自 Windows「时间和语言 → 时区」，仅用于显示，不参与任何计算
const localTzLabel = computed(() => {
  const off = -new Date().getTimezoneOffset()
  const s = off >= 0 ? '+' : '−', h = Math.floor(Math.abs(off) / 60), m = Math.abs(off) % 60
  return 'UTC' + s + h + (m ? ':' + String(m).padStart(2, '0') : '')
})
function fmtTick(ms, wMin) {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0')
  const mid = tHour(d) === 0 && tMin(d) === 0 && tSec(d) === 0
  if (wMin > 5760) return `${p(tMon(d) + 1)}-${p(tDay(d))}`                                                           // >4 天：只显日期
  if (wMin > 120) return mid ? `${p(tMon(d) + 1)}-${p(tDay(d))}` : `${p(tHour(d))}:${p(tMin(d))}`                     // 2h~4 天：整日显日期，否则 HH:MM
  return `${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`                                                                 // ≤2h：HH:MM:SS
}
// 自适应刻度：日历阶梯 + 每~80px 一主刻度 + 对齐整点整日 + 主/次两级 + 标签防重叠（左→右贪心抽稀）
function computeTicks(anchorMs, wStart, wMin, trackPx) {
  const span = wMin * 60, leftMs = anchorMs + wStart * 60000
  // 以左边缘所在日的午夜为对齐基准。★必须跟着 tzMode 走：UTC 档下若仍按本地午夜对齐，
  // 刻度会落在 UTC 的非整点上（东八区就是每格差 8 小时的零头），标签一片 xx:00 之外的碎数。
  const d = new Date(leftMs)
  const epoch = (tzUtc() ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 1000
  const start = leftMs / 1000 - epoch, end = start + span
  const ideal = span / Math.max(1, trackPx / 80)
  const main = NICE.find((s) => s >= ideal) || NICE[NICE.length - 1]
  const mi = NICE.indexOf(main)
  let sub = 0
  for (let i = mi - 1; i >= 0; i--) if (Math.abs(_mod(main, NICE[i])) < 1e-6) { sub = NICE[i]; break }
  const pxOf = (t) => trackPx * (t - start) / span
  const minor = [], major = [], labels = []
  for (let t = Math.ceil(start / main) * main; t <= end + 1e-6; t += main) {
    major.push({ x: pxOf(t) }); labels.push({ x: pxOf(t), label: fmtTick((epoch + t) * 1000, wMin) })
  }
  if (sub && trackPx * (sub / span) >= 6) {
    for (let t = Math.ceil(start / sub) * sub; t <= end + 1e-6; t += sub) { if (Math.abs(_mod(t, main)) < 1e-6) continue; minor.push({ x: pxOf(t) }) }
  }
  const outL = []; let lastRight = -1e9
  for (const l of labels) {
    const w = l.label.length * 6.6
    if (l.x - w / 2 > lastRight) {
      lastRight = l.x - w / 2 + w + 6
      outL.push({ x: l.x, label: l.label, align: l.x < w / 2 ? 'translateX(0)' : l.x > trackPx - w / 2 ? 'translateX(-100%)' : 'translateX(-50%)' })
    }
  }
  return { minor, major, labels: outL }
}
const ticks = computed(() => { void nowTick.value; return computeTicks(baseTime.value, winStartMin.value, windowMin.value, trackWidthPx.value) })
const winEndMin = computed(() => winStartMin.value + windowMin.value)
const timePct = computed(() => clamp((offMin.value - winStartMin.value) / windowMin.value, 0, 1) * 100)   // 游标位置(%)
const nowPct = computed(() => { void nowTick.value; return ((nowStamp.value - baseTime.value) / 60000 - winStartMin.value) / windowMin.value * 100 })
const nowInWin = computed(() => !live.value && nowPct.value >= 0 && nowPct.value <= 100)   // 实时时游标即此刻，不另画红线
const isCustomWindow = computed(() => !WINDOW_PRESETS.some((w) => w.v === windowMin.value))
function fmtSpan(min) {
  if (min >= 1440) { const d = Math.floor(min / 1440), rh = Math.round((min - d * 1440) / 60); return rh ? `${d}d${rh}h` : `${d}d` }
  const h = Math.floor(min / 60), m = min % 60; return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`
}
const customWinLabel = computed(() => fmtSpan(windowMin.value))
// 对星指标表窗口的时刻读数：取【时间轴游标】calcAt()，不是系统时钟（与晨昏线/可见性同口径）
const timeText = computed(() => {
  void tzMode.value
  const d = new Date(clock.tMs), p = (n) => String(n).padStart(2, '0')
  return `${tYear(d)}-${p(tMon(d) + 1)}-${p(tDay(d))} ${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))} ${tzUtc() ? 'UTC' : localTzLabel.value}`
})

// 悬停幽灵线 + 时间气泡（落点前先预览该处对应时间）
const hoverShow = ref(false), hoverX = ref(0), hoverLabel = ref('')
function onHover(e) {
  if (!track.value) return
  const r = track.value.getBoundingClientRect(), x = clamp(e.clientX - r.left, 0, r.width), f = r.width ? x / r.width : 0
  const dd = new Date(baseTime.value + (winStartMin.value + f * windowMin.value) * 60000), p = (n) => String(n).padStart(2, '0')
  hoverX.value = x; hoverLabel.value = `${p(tMon(dd) + 1)}-${p(tDay(dd))} ${p(tHour(dd))}:${p(tMin(dd))}:${p(tSec(dd))}`; hoverShow.value = true
}
function onLeave() { hoverShow.value = false }

// 光标 x → 时刻(ms)。★ 秒级：吸附粒度按「1 像素 ≈ 1 格」自适应（cursorSnapSec），窗口越窄越细，
// 最细 1 s；24 h 窗口下吸到秒毫无意义（一像素就是两分钟），要精确到秒请缩窗口 / 用步进 / 直接键入时刻。
const snapSec = computed(() => cursorSnapSec(windowMin.value, trackWidthPx.value))
function trackToMs(clientX) {
  const r = track.value.getBoundingClientRect()
  const ms = baseTime.value + (winStartMin.value + clamp01((clientX - r.left) / r.width) * windowMin.value) * 60000
  return snapMs(ms, snapSec.value * 1000)
}
// 拖动游标(查看时刻)；pointer 监听挂 document，移出轨道仍连续。
// ★ 播放中拖游标＝就地续播（STK 拖动画游标同款），不再被静默停成暂停；实时中拖则退出实时。
// 焦点环只画给键盘。拖游标必须先 focus()（松手后方向键要接着能步进），但鼠标按下就描一圈
// 黑框（全局 :focus-visible 的 var(--accent) 在亮色主题就是 #1a1a1a）纯属噪声。
// 浏览器对「程序化 focus() 算不算 focus-visible」的判定跟着上一次交互方式走，指望不上——
// 这里自己记焦点从哪来：鼠标按下不画，Tab 进来或按过键才画。
const trackKb = ref(false)
let trackPtrFocus = false
function onTrackFocus() { trackKb.value = !trackPtrFocus }
function trackDown(e) {
  if (!track.value) return
  trackPtrFocus = true
  track.value.focus({ preventScroll: true })
  trackPtrFocus = false
  trackKb.value = false          // 已经聚焦时 focus() 不再发事件（先按方向键再拿鼠标拖就是这一路），环得在这儿灭
  applyTimeMs(trackToMs(e.clientX))
  const move = (ev) => applyTimeMs(trackToMs(ev.clientX))
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up)
}
// 设时刻（夹在可见窗口内——拖不到看不见的地方）。刷新由时钟的 tick 回调统一驱动，这里不自己调 refreshPositions。
function applyTimeMs(ms) {
  const lo = baseTime.value + winStartMin.value * 60000, hi = baseTime.value + winEndMin.value * 60000
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
  else if (e.key === ' ' || e.key === 'Spacebar') togglePlay(1)
  else h = false
  if (h) { trackKb.value = true; e.preventDefault() }   // 键盘一上手就把焦点环点亮（此前可能是鼠标点进来的）
}
// 滚轮缩放跨度：以光标处时间为锚保持不动（实时态则保持「此刻」居 PAST_FRAC 处）
function onWheel(e) {
  if (!track.value || !e.deltaY) return
  const r = track.value.getBoundingClientRect(), f = clamp01((e.clientX - r.left) / r.width)
  const cursorOff = winStartMin.value + f * windowMin.value
  windowMin.value = Math.round(clamp(windowMin.value * (e.deltaY > 0 ? 1.15 : 1 / 1.15), WIN_MIN, WIN_MAX))
  winStartMin.value = live.value ? -PAST_FRAC * windowMin.value : cursorOff - f * windowMin.value
  clampCursorIntoWindow()
  saveSettings()
}
// 缩放/换跨度后游标可能落到窗外 → 夹回来（时刻本身被改动才通知时钟，避免每次滚轮都白刷一拍：
// 尺子变了星并没有动，刻度是 computed 自己会重算，7000 颗星的 SGP4 没必要跟着滚轮跑）
function clampCursorIntoWindow() {
  const lo = baseTime.value + winStartMin.value * 60000, hi = baseTime.value + winEndMin.value * 60000
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
function resetTime() {
  if (atNow.value && !live.value) return
  winStartMin.value = -PAST_FRAC * windowMin.value
  clockSetTime(Date.now()); baseTime.value = clock.tMs
}
function toggleLive() {
  const on = !live.value
  winStartMin.value = -PAST_FRAC * windowMin.value
  if (on) goLive(); else clockSetTime(Date.now())
  baseTime.value = clock.tMs
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
  const ws = followWindow(offMin.value, winStartMin.value, windowMin.value, PAST_FRAC,
    clock.mode === 'play' ? clockEff.value : 0)
  if (ws != null) winStartMin.value = ws
}
// —— 跳到指定时刻（精确到秒）——
// 拖游标的吸附粒度受像素限制（24 h 窗口下 1 px = 144 s），要落在某个确切的秒上只能键入。
// 输入按当前时区档位解释（与时间轴读数同一个开关），跳过去后窗口以该时刻重新居中。
const gotoOpen = ref(false)
const gotoVal = ref('')
function openGoto() {
  const d = new Date(clock.tMs), p = (n) => String(n).padStart(2, '0')
  gotoVal.value = `${tYear(d)}-${p(tMon(d) + 1)}-${p(tDay(d))}T${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`
  gotoOpen.value = !gotoOpen.value
}
function applyGoto() {
  const v = String(gotoVal.value || '')
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(v)
  if (!m) { gotoOpen.value = false; return }
  const [, Y, Mo, D, h, mi, s] = m.map(Number)
  const t = tzUtc() ? Date.UTC(Y, Mo - 1, D, h, mi, s || 0) : new Date(Y, Mo - 1, D, h, mi, s || 0).getTime()
  if (!Number.isFinite(t)) { gotoOpen.value = false; return }
  winStartMin.value = -PAST_FRAC * windowMin.value
  clockSetTime(t); baseTime.value = clock.tMs
  gotoOpen.value = false
}
// ===================== 坐标系（大地基准 / 坐标格式 / 2D 画面中心） =====================
// 前两项只改读数与输入的呈现；画面中心决定平面图把哪条经线摆在正中（内部仍按切口 = 中心 − 180 存）。
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
  crsCenterShown.value = Math.max(-180, Math.min(180, n))
  setMapCrs({ lon0: centerToLon0(crsCenterShown.value) })
  if (flat) flat.setLon0(mapCrs.lon0)
}
// 常用中心：本初子午线 / 中国居中 / 太平洋居中
const CENTER_PRESETS = [{ v: 0, zh: '0°' }, { v: 105, zh: '105°E' }, { v: 180, zh: '180°' }]
function resetCrs() { setMapCrs(MAP_CRS_DEF); crsCenterShown.value = lon0ToCenter(mapCrs.lon0); if (flat) flat.setLon0(mapCrs.lon0) }

function toggleRotate() { autoRotate.value = !autoRotate.value; scene && scene.setAutoRotate(autoRotate.value) }
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
  // ★ 不截断：没输入就把有包的国家全列出来（251 个），清单本身可滚。
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
  const kind = flatView.value ? 'flat' : 'globe'
  const m = activeMap()
  if (!m || !m.getView) return
  savedView[kind] = m.getView()
  if (_viewSaveTimer) clearTimeout(_viewSaveTimer)
  _viewSaveTimer = setTimeout(() => { try { localStorage.setItem(VIEW_KEY, JSON.stringify(savedView)) } catch { /* ignore */ } }, 300)
}
function pushZoom() { const m = activeMap(); if (m && m.getZoom) zoom.value = m.getZoom() }
function applyZoom(t) { const m = activeMap(); if (m && m.setZoom) { m.setZoom(t); zoom.value = t; saveView() } }
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
async function applyFlat(v) {
  flatView.value = v
  // 切回 3D：先恢复 3D 渲染循环（切 2D 时已暂停），再补齐 3D 覆盖层。
  // 编辑电平时只 patch 了当前可见视图（recomputeActive），另一视图需在此一次性重算。
  // 卫星层（含波束合成草图）在 2D 期间挂起未同步 → 这里一次性补建（见 redrawSats 尾注）。
  if (!v) {
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
    flat.setRenderScale(displayQuality.value.pixelRatio); flat.setMapDetail(displayQuality.value.mapDetail, displayQuality.value.mapThin)
    flat.setOnRightClick(onMapRightClick); flat.setOnHover(onHoverLL); flat.setOnBeamDrag(onBeamDragAny); flat.setBeamDragMode(grd.dragBore.value)
    flat.setOnLabelDrag(grd.labelDrag); flat.setLabelDragMode(grd.dragLabel.value)   // 拖拽等值线数值标签（沿线滑动）
    flat.setOnVertexDrag(onVertexDrag)   // 拖动单个顶点/标记点（Polygon 调点 或 标记「调整点位置」，分发）
    flat.setOnPolyMove(onPolyMoveDrag)       // Polygon 整体拖动：按住内部平移全部顶点
    flat.setOnPolyDraw(onPolyDraw); flat.setPolyDrawMode(!!(polyDrawId.value || activeTraj.value))   // Polygon/航迹绘制：左键按住沿路径连续加点
    flat.setOnPlace((ll) => bs.placeAt(ll)); flat.setPlaceMode(bs.placing.value)   // 波束合成放置：左键点击落波束（拖动仍平移）
    flat.setOnBoxSelect(bsOnBoxSelect); flat.setBoxSelectMode(bs.stEditOn.value)   // 站点栅框选（拖矩形选站，页面画橡皮筋）
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
  flat.setWaterMode({ ocean: oceanNameMode.value, sea: seaNameMode.value })
  flat.setWaterOff({ ...waterOff })
  flat.setChains({ on: chainOn.value, off: { ...chainOff }, ...chainStyle })
  if (provincesData) flat.setProvinces(provincesData)
  flat.setProvincesVisible(showProvinces.value)
  if (citiesData) flat.setCities(citiesData)
  flat.setCitiesVisible(showCities.value)
  flat.setBorderStyle({ ...borderStyle })
  flat.setLabelStyle({ ...labelStyle })
  flat.setOceanColor(oceanColor.value)
  if (imageryOn.value) applyImagery()
  flat.setFocusStyle(focusStyle2D())
  flat.setMarkers(markerPts(), markerSts(), markerTrs())
  flat.setSizes({ beamFont: beamLabelSize.value, contourFont: contourLabelSize.value, dotSize: boreSize.value, showBore: showBore.value, nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value, oceanScale: oceanNameSize.value, seaScale: seaNameSize.value, ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value, ptDot: markPtDot.value, ptIdx: markPtIdx.value, trajDot: trajDotSize.value, trajIcon: showTrajIcon.value, trajIconPx: trajIconSize.value })
  flat.setGeom(covGeom)
  grd.recompute()   // GRD 覆盖：把当前选中天线的面+线喂给 flat（recompute 同时喂 scene/flat）
  if (sideCtx() === 'satcov') satcov.recompute()   // 对星视图占着 2D 那块场（见 ownsFlatField）→ 上一行被闸住，改由它来喂
  env.redraw()      // 环境场：平面图是懒创建的，切过来时把当前图层（栅格+等值线）补喂一份
  envLive.redraw()  // 实时气象场：同上。两张场共用一个槽，次序无所谓——归属闸挡着，关着的那一方清不掉对方
  applyTerminator() // 晨昏线：同上，平面图懒创建，切过来补喂当前时刻那一份（关着则清层）
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
    await feedFlat()   // resize() 仅首帧 fit，已交互过的缩放/平移会保留 → view 模式即所见即所得
    await nextTick()
    const tag = view ? '截图' : '全球图'
    const { renderFlatPNG, renderFlatPDF } = await import('../viz/flatmap/exportFlat.js')
    if (fmt === 'pdf') {
      // 矢量 PDF 按「设置」里的底图精度导出（flat 实例已随 displayQuality 同步精度）：
      // 10m 更清晰但点数约 5.5× → 导出更慢、文件更大；如需更快可在设置里调到 50m/110m。
      const fonts = await getPdfFonts()
      const bytes = await renderFlatPDF(flat, { base: 2400, fonts, view })
      await saveExport(bytes, `覆盖图_${tag}.pdf`, [{ name: 'PDF 矢量图', extensions: ['pdf'] }])
    } else {
      // 倍率封顶 4×：再往上是净负。这条是矢量重放，线宽与抽稀阈值都按屏幕 px 走 —— 倍率提高不多画一个
      // 折点，内容与 4× 逐点相同（实测同一段海岸线的折点数/线粗一致），只是同样的边画在更多像素上。
      // 4× 的笔画过渡已细到 0.45 CSS px，600dpi 下约 0.02mm；6× 的代价是文件 +61%、位图 396MB。
      const factor = fmt === 'png4' ? 4 : 2
      const bytes = await renderFlatPNG(flat, { base: 2400, factor, view })
      await saveExport(bytes, `覆盖图_${tag}_${factor}x.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
    }
  } catch (e) { console.error('导出失败', e); appAlert('导出失败：' + ((e && e.message) || e)) }
  finally { exporting.value = false; exportFlat.value = false }
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
      const r = await renderGlobePNG(scene, { factor: fmt === 'png2' ? 2 : 4 })
      // 文件名写实际倍率：画布够大时 4× 也会撞上 32 MPix 的天花板被降档（实测 1900×1150 只出得到
      // 3.2×），此处如实反映（写 覆盖图_3D截图_3.2x.png），不报一个没渲染过的数
      const factor = Math.round(r.factor * 10) / 10
      await saveExport(r.bytes, `覆盖图_${tag}_${factor}x.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
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
  fpOn: focusStyle.fpOn, fpColor: hexNum(focusStyle.fpColor), fpWidth: focusStyle.fpWidth, fpOpacity: focusStyle.fpOpacity, fpDash: focusStyle.fpDash,
  fpFillColor: hexNum(focusStyle.fpFillColor), fpFillOpacity: focusStyle.fpFillOpacity,
  coneOn: focusStyle.coneOn, coneFaceColor: hexNum(focusStyle.coneFaceColor), coneFaceOpacity: focusStyle.coneFaceOpacity,
  coneGenCount: focusStyle.coneGenCount, coneGenColor: hexNum(focusStyle.coneGenColor), coneGenWidth: focusStyle.coneGenWidth, coneGenOpacity: focusStyle.coneGenOpacity, coneGenDash: focusStyle.coneGenDash,
  dotOn: focusStyle.dotOn, dotPx: focusStyle.dotPx, subPx: focusStyle.subPx, subColor: hexNum(focusStyle.subColor),
  ringOn: focusStyle.ringOn, ringColor: focusStyle.ringColor, ringPx: focusStyle.ringPx
})
const focusStyle2D = () => ({
  trkOn: focusStyle.trkOn, trkColor: focusStyle.trkColor, trkWidth: focusStyle.trkWidth, trkOpacity: focusStyle.trkOpacity, trkDash: focusStyle.trkDash,
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
}
// 「轨迹圈数」与分区「默认」：几何本身变了（多采几个周期；「默认」还会把线型回填成出厂值），
// 与改样式【同一条路】—— 别只调 commitGeometry：轨道圈是缓存几何，不置 ringDirty 就不会重建，
// 拖一下圈数滑杆轨道线就停在旧线型上、点一下「默认」更是要等 TTL 到期才回来。
function applyFocusGeom() { applyFocusStyle() }
// 分节恢复出厂样式（每节标题上那个「默认」）：只回填本节的字段，别人调好的不动。
// 覆盖圈那节不含口径（波束角/最低仰角是分析参数不是样式，见 fpMode/beam/elevMin）。
const FOCUS_PARTS = {
  orb: ['orbOn', 'orbColor', 'orbWidth', 'orbOpacity', 'orbDash'],
  trk: ['trkOn', 'trkColor', 'trkWidth', 'trkOpacity', 'trkDash', 'trkPeriods'],
  fp: ['fpOn', 'fpColor', 'fpWidth', 'fpOpacity', 'fpDash', 'fpFillColor', 'fpFillOpacity'],
  cone: ['coneOn', 'coneFaceColor', 'coneFaceOpacity', 'coneGenCount', 'coneGenColor', 'coneGenWidth', 'coneGenOpacity', 'coneGenDash'],
  mk: ['cloudOn', 'dotOn', 'dotPx', 'subOn', 'subPx', 'subColor', 'ringOn', 'ringColor', 'ringPx']
}
function resetFocusPart(k) {
  for (const f of (FOCUS_PARTS[k] || [])) focusStyle[f] = FOCUS_STYLE_DEF[f]
  applyFocusGeom()
}
function toggleFocus(k) { focusStyle[k] = !focusStyle[k]; applyFocusStyle() }
function setFocusVal(k, v) { focusStyle[k] = v; applyFocusStyle() }
// 信息卡右上角齿轮：切到「聚焦卫星」侧栏视图（三节默认展开的照旧，收着的不强行掰开）
function openFocusSettings() { shellUi.side = 'focus' }
// 晨昏线 / 夜区 → 3D 与平面图。时刻取【时间轴当前值】calcAt()，不是系统时钟：
// 拖时间轴看某历史/未来时刻时，晨昏线必须跟着走，否则「那颗星当时在不在阳照区」就读错了。
// 每次 refreshPositions（实时每秒 / 时间轴每次落点）调用一次；关闭时传 null 清层。
// 颜色：three.js 要数值，Canvas 要 CSS 串 —— 同一份 termStyle 各自转换，避免两处配色漂移。
const hexNum = (s) => parseInt(String(s || '#000000').replace('#', ''), 16) || 0
function applyTerminator() {
  if (!termOn.value) {
    termSub.value = null
    if (scene) scene.setTerminator(null)
    if (flat) flat.setTerminator(null)
    return
  }
  const now = calcAt()
  termSub.value = solarGeometry(now).sub
  const common = { night: termNight.value, line: termLine.value, nightOpacity: termStyle.nightOpacity, lineWidth: termStyle.lineWidth, lineOpacity: termStyle.lineOpacity }
  if (scene) scene.setTerminator(now, { ...common, nightColor: hexNum(termStyle.nightColor), lineColor: hexNum(termStyle.lineColor) })
  if (flat) flat.setTerminator(now, { ...common, nightColor: termStyle.nightColor, lineColor: termStyle.lineColor })
}
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
function toggleTerm() { termOn.value = !termOn.value; applyTerminator() }
function toggleTermNight() { termNight.value = !termNight.value; applyTerminator() }
function toggleTermLine() { termLine.value = !termLine.value; applyTerminator() }
// 大海颜色 → 3D 与平面图。
function setOceanColor(c) { oceanColor.value = c; if (scene) scene.setOceanColor(c); if (flat) flat.setOceanColor(c) }
// 影像底图：把当前开关/源/亮度推给两个视图。关着的时候只推 on:false，不去碰图片（懒加载的前提）。
//
// ★ 在飞闸不能是一个布尔的「有人在加载就走开」：16K 那张 13 MB 的 JPEG 解码要好几秒，正是这几秒里
//   用户最可能去点另一档。旧写法有两处后果 ——
//     ① 新的那一档【一次都没去加载】（撞上闸直接 return），而 setImageryKey 已经先把旧纹理卸了，
//        影像就此消失，得再点一次别的档才回得来；
//     ② 在飞那次回来后照旧把【旧图】塞回去，于是屏上是 16K、档位高亮在 8K，显存也还是那一档。
//   故改成：闸上记 url（认得出「在飞的是不是就是要的那一份」）+ 一个 pending 标志（回来后补跑），
//   并在应用前再核对一次「这一份仍是当前选中的那一档」。
async function applyImagery() {
  if (!imageryOn.value) {
    if (scene) scene.setImagery({ on: false })
    if (flat) flat.setImagery({ on: false })
    return
  }
  const src = imagerySource(imageryKey.value)
  if (imageryLoading) {
    // 在飞的就是这一份 → 等它回来即可；是别的一份 → 记一笔，由它在 finally 里补跑
    if (imageryLoading !== src.url) imageryPending = true
    return
  }
  imageryLoading = src.url
  try {
    const img = await loadImagery(src.url)
    // 回来时开关/档位都可能已经变了：只认「仍是当前选中的那一份」，否则丢弃（由 pending 那一路去补）
    if (imageryOn.value && imagerySource(imageryKey.value).url === src.url) {
      if (scene) scene.setImagery({ on: true, img, bright: imageryBright.value })
      if (flat) flat.setImagery({ on: true, img, bright: imageryBright.value })
    }
  } catch (e) {
    // 只有「失败的正是当前这一档」才关开关报错；用户已经切走的那一份失败了与他无关
    if (imagerySource(imageryKey.value).url === src.url) {
      imageryOn.value = false
      logMsg('影像底图载入失败：' + (e && e.message ? e.message : e))
    }
  } finally {
    imageryLoading = ''
    if (imageryPending) { imageryPending = false; applyImagery() }
  }
}
function toggleImagery() { imageryOn.value = !imageryOn.value; applyImagery() }
function setImageryKey(k) {
  if (imageryKey.value === k) return
  imageryKey.value = k
  // 换源：先把旧纹理卸掉（显存），再按新源走一遍加载
  if (scene) scene.setImagery({ img: null, on: false })
  if (flat) flat.setImagery({ img: null, on: false })
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
function setPtFont(e) { markPtFont.value = Number(e.target.value); syncMarkers() }
function setPtDot(e) { markPtDot.value = Number(e.target.value); syncMarkers() }
function setPtIdx(e) { markPtIdx.value = Number(e.target.value); syncMarkers() }
function setStIcon(e) { stIconSize.value = Number(e.target.value); syncMarkers() }
function setStFont(e) { stFontSize.value = Number(e.target.value); syncMarkers() }
function setTrajDot(e) { trajDotSize.value = Number(e.target.value); syncMarkers() }
function setTrajIcon(e) { trajIconSize.value = Number(e.target.value); syncMarkers() }
function togglePtLabel() { showPtLabel.value = !showPtLabel.value; syncMarkers() }
function togglePtIndex() { showPtIndex.value = !showPtIndex.value; syncMarkers() }
function toggleStName() { showStName.value = !showStName.value; syncMarkers() }
function togglePtLayer() { showPtLayer.value = !showPtLayer.value; syncMarkers() }
function toggleStLayer() { showStLayer.value = !showStLayer.value; syncMarkers() }
function toggleTrajLayer() { showTrajLayer.value = !showTrajLayer.value; syncMarkers() }
function toggleTrajIcon() { showTrajIcon.value = !showTrajIcon.value; syncMarkers() }
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

// 「这份覆盖算哪颗星的」候选 = 【小程序「卫星覆盖」页那 24 颗】，顺序照抄（见 shared/miniSatList.js）。
// ★ 必须由人来定：快照里的星名是平台侧的叫法，小程序那边的波束是按 satelliteName 归类显示的，
//   对不上就是「导进去了却在任何一颗星下面都看不见」。
// ★★ 别改回平台自己的 SAT_PRESETS —— 那是超集（含 JCSAT 等小程序没有的星）且顺序不同，
//   两边下拉对不上，正是 2026-08-02 用户反馈的问题。
// ★★★ 画面里出现的星名若不在那 24 颗里，仍然给出来但标「小程序没有 · 将新建」：
//   小程序收到不认识的名字会按送过去的轨位自动登记成自定义卫星（见那边的 _ensureSatName），
//   所以这条路是通的，只是要让人知道这一下会在手机上多出一颗星。
const miniSatOptions = computed(() => {
  const known = MINI_COVERAGE_SATS.map((s) => ({ value: s.name, label: `${s.name}（${fmtGeoSlot(s.lon)}）`, lon: s.lon }))
  // 画面里画的是哪颗星：不在那 24 颗里的排到最前 —— 多半就是这次要发的那颗
  const extra = []
  const seen = new Set()
  try {
    for (const b of (buildMiniappSnapshot().coverage.beams || [])) {
      const n = String(b.satName || '').trim()
      if (!n || seen.has(satKey(n)) || inMiniList(n)) continue
      seen.add(satKey(n))
      const p = Number(b.lon)
      extra.push({ value: n, label: `${n}${Number.isFinite(p) ? `（${fmtGeoSlot(p)}）` : ''} · 小程序没有，将新建`, lon: Number.isFinite(p) ? p : null })
    }
  } catch (e) { /* 画面还没有覆盖层 */ }
  return [...extra, ...known]
})

// 默认选中：画面里那颗星若正好是那 24 颗之一就选它（最常见），否则选第一个候选
const miniSatDefault = computed(() => {
  try {
    for (const b of (buildMiniappSnapshot().coverage.beams || [])) {
      const hit = MINI_COVERAGE_SATS.find((s) => satKey(s.name) === satKey(b.satName))
      if (hit) return hit.name
    }
  } catch (e) { /* ignore */ }
  const o = miniSatOptions.value
  return o.length ? o[0].value : ''
})

// 弹窗打开的那一刻现攒快照（这中间用户可能又改了画面）；picked.sat 是上面选的目标星
function buildMiniSend(picked) {
  const snap = buildMiniappSnapshot()
  const satName = String((picked && picked.sat) || '').trim()
  const hit = miniSatOptions.value.find((o) => o.value === satName)
  if (satName) snap.target = { satName, satLon: hit && hit.lon != null ? hit.lon : null }
  return {
    name: satName ? `${satName} 覆盖` : snap.name,
    raw: snap,
    label: '覆盖快照',
    // 幂等键按【目标星】走：反复给同一颗星发覆盖就是要更新手机上那一份，不是再堆一份；
    // 换一颗星才算新的一件。
    sync: 'gxt:' + (satName || snap.name || '覆盖快照')
  }
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
// 把当前可拖拽的顶点/标记点（传引用，拖动实时生效）喂给平面渲染器做命中/拖拽。
// 「调整点位置」的标记/地球站/航迹优先；否则回退到 Polygon 调点/整体拖动。三者互斥，共用同一 editVerts 槽。
function syncEdit() {
  if (!flat) return
  const mt = mkEditTarget()
  if (mt) { mkEditPts = mt.src.map((p) => [p.lon, p.lat]); flat.setEditVerts({ pts: mkEditPts, px: MK_HANDLE_PX, move: false }); return }
  mkEditPts = null
  if ((bs.adjusting.value || bs.deleting.value) && bs.open.value) {   // 波束合成调整中心/删除波束：手柄命中用波束中心快照（拖动时原地更新）
    bsEditPts = bs.beams.value.map((b) => [b.lon, b.lat])
    flat.setEditVerts({ pts: bsEditPts, px: MK_HANDLE_PX, move: false, cursor: bs.deleting.value ? 'pointer' : 'move' }); return
  }
  bsEditPts = null
  const pg = curEditPoly() || curMovePoly()
  flat.setEditVerts(pg ? { pts: pg.pts, px: polyDotSize.value, move: !!curMovePoly() } : null)
}
// 顶点拖拽回调分发：调整点位置→标记；波束合成调整中心→波束；否则→ Polygon 顶点
function onVertexDrag(vi, ll, phase) {
  if (mkEditId.value) { onMkVertexDrag(vi, ll, phase); return }
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
    width: pg.width || 2, labelSize: pg.labelSize || 16, show: true,
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
    width: pg.width || 2, labelSize: pg.labelSize || 16, show: true, pts
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
    width: 2, labelSize: 16, show: true,
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
  if (r && r.a && r.b) bs.stBoxSelect(r.a, r.b, !!r.add)
  else if (r && r.at) bs.stClickSelect(r.at, !!r.add)   // 原地点击：命中站点=单选/增减选；未命中=清选（Ctrl 保持）
  else bs.clearStSel()
}
watch(() => bs.stEditOn.value, (v) => { if (flat) flat.setBoxSelectMode(v); if (!v) bsStBox.on = false })
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
    satcovTableOpen.value = false
    satcovPickOpen.value = false
  }
}, { immediate: true })
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
// 导航器卫星切换：定位该星首个波束组（或空态）
function bsSetSat(folder) { bs.setSat(folder) }
// 新建波束组（高斯/赋形）
function bsAddGroup(m) {
  if (!grdSats.value.length) { appAlert('请先在覆盖分析视图添加卫星'); return }
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
watch(() => bs.mode.value, () => { bs.placing.value = false; if (bs.adjusting.value || bs.deleting.value) { bs.adjusting.value = false; bs.deleting.value = false; syncEdit() } redrawSats() })
watch(() => bs.open.value, (o) => { if (!o) { bs.placing.value = false; bs.adjusting.value = false; bs.deleting.value = false; syncEdit(); redrawSats() } })
// 放置态同步到两个渲染器：左键点击=落波束（拖动仍旋转/平移；右键放置并存）
watch(() => bs.placing.value, (v) => { if (scene) scene.setPlaceMode(v); if (flat) flat.setPlaceMode(v) })

// ---- 波束批量表格（Excel 网格，仿标记批量表格）：列 [经度, 纬度, 3dB-X, 3dB-Y, 旋转] ----
const bsTblCols = [
  { key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true },
  { key: 'thX', label: '3dB-X°', num: true }, { key: 'thY', label: '3dB-Y°', num: true }, { key: 'rot', label: '旋转°', num: true }
]
const bsCellText = (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) }
const bsGrid = useGridSelect({
  rows: () => bs.beams.value, cols: () => bsTblCols, cellText: bsCellText,
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
    const p = satLivePos({ noradId: m.noradId })
    if (Number.isFinite(p.lon)) return { lon: +p.lon.toFixed(3), lat: +p.lat.toFixed(3), altKm: +p.altKm.toFixed(1) }
    return { lon: m.lon, lat: m.lat, altKm: m.altKm }   // 星历未就绪：回退到存储值
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
  return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, color: '#ffffff', els: '5,10', noradId: null, posMode: 'fixed', elements: defaultElements(), elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, iconShow: true, labelShow: true }
}
// hideViz：从文件管理器调起时为 true，隐藏可视化项（图标/字号/仰角线/颜色），其余功能（定位方式/星座关联）一致
function openAddSat(hideViz = false) { satModal.value = { ...defaultSatDraft(), hideViz }; satLiveSig = satPosSig(satModal.value); satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
// 编辑已有卫星（含预置星）：名称/位置/关联/仰角线/图标与标签大小都可改
function editSat(node, hideViz = false) {
  satModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, color: node.elevColor, els: node.els, noradId: node.noradId, kind: node.kind, posMode: node.elements ? 'orbit' : 'fixed', elements: node.elements ? { ...node.elements } : defaultElements(), elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18, iconSize: node.iconSize || 10, labelSize: node.labelSize || 4, iconShow: node.iconShow !== false, labelShow: node.labelShow !== false, hideViz }
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
  return { satName: (m.name || '卫星').trim() || '卫星', els: m.els || '', elevColor: m.color || '#66ddff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18, iconSize: Number(m.iconSize) || 10, labelSize: Number(m.labelSize) || 4, iconShow: m.iconShow !== false, labelShow: m.labelShow !== false }
}
// 由草稿构造整份补丁（位置 + 显示项）。alert=true 时非法输入弹框（「保存」走这条）；
// alert=false 静默返回 null（实时预览走这条，半截输入不打断）。
function satPatchFrom(m, alert) {
  let lon = Number(m.lon), lat = Number(m.lat), altKm = Number(m.altKm)
  // 关联星：取当前星历解算的位置作为存储回退值（无星座时按此投影），而非草稿里的陈旧值
  if (m.noradId) { const p = satLivePos({ noradId: m.noradId }); if (Number.isFinite(p.lon)) { lon = p.lon; lat = p.lat; altKm = p.altKm } }
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
    const now = calcAt(); const pv = sat.propagate(rec, now)
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
    const created = grd.addSatellite({ name: m.name, lon: patch.lon, lat: patch.lat, altKm: patch.altKm, noradId: m.noradId, elements: patch.elements, els: m.els, color: m.color, elevWidth: m.elevWidth, elevLabelSize: m.elevLabelSize, iconSize: m.iconSize, labelSize: m.labelSize, iconShow: m.iconShow, labelShow: m.labelShow })
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

// ===== 独立仰角线：只画等仰角环的最小节点，与「卫星」弹窗（图标/卫星名/星座关联）脱钩 =====
function defaultElevDraft() { return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, els: '5,10', color: '#ffffff', elevWidth: 1.3, elevLabelSize: 18 } }
function openAddElevLine() { elevModal.value = defaultElevDraft() }
function editElevLine(node) { elevModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, els: node.els, color: node.elevColor, elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18 } }
function closeElevModal() { elevModal.value = null }
function applyElevGeoAlt() { if (elevModal.value) elevModal.value.altKm = GEO_ALT }   // 一键GEO：轨道高度设为 GEO
function saveElevModal() {
  const m = elevModal.value; if (!m) return
  const lon = Number(m.lon), lat = Number(m.lat), altKm = Number(m.altKm)
  if (!validLon(lon) || !validLat(lat) || !(altKm > 0)) return   // 非法输入不保存
  const patch = { satName: (m.name || '仰角线').trim() || '仰角线', lon, lat, altKm, els: m.els || '', elevColor: m.color || '#ffffff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18 }
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
function satLivePos(node) {
  if (node.noradId) {
    const en = liveEntryOf(node.noradId)   // 自定义星座合成星(含隐藏)：关联后按合成星历实时跟踪
    if (en) { const now = isCustomEntry(en) ? ccTimeAt() : calcAt(); const pv = sat.propagate(en.rec, now); if (pv && pv.position) { const gd = sat.eciToGeodetic(pv.position, sat.gstime(now)); return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), altKm: gd.height } } }
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
    if (en.name.toLowerCase().includes(kw) || String(en.noradId).includes(kw) || (en.groupLabel && en.groupLabel.toLowerCase().includes(kw))) out.push({ en, name: en.name, noradId: en.noradId, groupLabel: en.groupLabel || GROUP_LABEL[en.group] || GROUP_LABEL[curKey()] || '', slot: geoSlotOfSatrec(en.rec) })
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
    // 卫星名/图标：不依赖仰角值，名/图标各自独立开关（3D 只画名，2D 画图标+名，各自随 labelShow/iconShow 显隐）
    if (showLabel || showIcon) sats.push({ lon: p.lon, lat: p.lat, altKm: p.altKm, name: node.satName, color: colNum, nameColor: color, iconSize: node.iconSize || 30, labelSize: node.labelSize || 9, labelShow: showLabel, iconShow: showIcon })
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
    if (!drawing && txt && pg.pts.length >= 3) { const c = polyCentroid(pg.pts); labels.push({ lon: c[0], lat: c[1], text: txt, hpx: (Number(pg.labelSize) || 16) / 533, color: pg.color, alt: 40, top: true }) }
  }
  // 波束合成草图（放置阶段的 3dB 椭圆轮廓 + 中心点 + 编号 + 频率配色填充）：与场合成同一几何链，所见即所得。
  const sk = bs.sketchSpec()
  if (sk) { if (sk.lines) lines.push(...sk.lines); if (sk.dots) dots.push(...sk.dots); if (sk.labels) labels.push(...sk.labels); if (sk.fills) fills.push(...sk.fills) }
  // 可见性分析叠加层：目标点高亮 + 可见星图标 + 目标→卫星连线（随时间轴实时）
  const vsk = vis.overlaySpec()
  if (vsk) { if (vsk.lines) lines.push(...vsk.lines); if (vsk.dots) dots.push(...vsk.dots); if (vsk.labels) labels.push(...vsk.labels); if (vsk.sats) sats.push(...vsk.sats) }
  // 波束合成「调整中心」/「删除波束」：在各波束中心叠可点击手柄圆环（与标记/Polygon 调点同款，平面图交互；调整=轮廓色，删除=警示红）
  if ((bs.adjusting.value || bs.deleting.value) && bs.open.value) for (const b of bs.beams.value) { if (Number.isFinite(b.lat) && Number.isFinite(b.lon)) dots.push({ lon: b.lon, lat: b.lat, color: bs.deleting.value ? 0xe05252 : (cssToHex(bs.p.skColor) || 0x5ad1ff), px: MK_HANDLE_PX, r: MK_HANDLE_PX * 0.0018 }) }
  // 「调整点位置」：在被编辑的标记/地球站/航迹各点上叠一圈可拖拽手柄圆环（屏幕恒定像素，仅平面图交互）
  const mkT = mkEditTarget()
  if (mkT) for (const p of mkT.src) { if (Number.isFinite(p.lat) && Number.isFinite(p.lon)) dots.push({ lon: p.lon, lat: p.lat, color: mkT.color, px: MK_HANDLE_PX, r: MK_HANDLE_PX * 0.0018 }) }
  const spec = (lines.length || sats.length || dots.length || fills.length) ? { lines, dots, labels, sats, fills } : null
  // 2D 平面图激活时不同步重建 3D 卫星层：scene 已 pause，但 setSatLayer 的组重建（每个标签新建
  // canvas+texture）是同步开销，大波束群下拖拽每帧数百次分配 → 卡手。挂起到切回 3D 时一次性补建。
  if (flatView.value) { satSpec3dPending = spec; satSpec3dDirty = true }
  else { scene.setSatLayer(spec); satSpec3dDirty = false }
  if (flat) flat.setSatLayer(spec)
}

// ===================== 标记 / 地球站 / 轨迹 =====================
const MK_KEY = 'globe3d/markers'
const points = ref([])             // [{id,lat,lon}]
const stations = ref([])           // [{id,lat,lon,name}]
const trajectories = ref([])       // [{id,name,kind,pts:[{lat,lon}]}]
const activeTraj = ref('')         // 当前编辑的轨迹 id
// 绘制态开关同步到两个渲染器：Polygon 或航迹描绘中 → 左键按住可沿路径连续加点（hold-to-draw）；退出→恢复平移/旋转（须在 activeTraj 声明后注册，否则 setup 期触发 TDZ）
watch([polyDrawId, activeTraj], ([pid, tid]) => { const on = !!(pid || tid); if (flat) flat.setPolyDrawMode(on); if (scene) scene.setPolyDrawMode(on) })
const ptLat = ref(''), ptLon = ref('')
const stLat = ref(''), stLon = ref(''), stName = ref('')
const wpLat = ref(''), wpLon = ref('')
const markPtFont = ref(14)         // 点标记坐标字号（1–32）
const markPtDot = ref(3.5)         // 点标记圆点大小（半径口径，1–12，默认偏小）
const markPtIdx = ref(16)          // 点标记序号圈直径（屏幕 px @100% 缩放，1–40）
const stIconSize = ref(16)         // 地球站图标大小（5–60，默认 16）
const stFontSize = ref(17)         // 地球站名称字号（1–32）
const trajDotSize = ref(4)         // 轨迹圆点大小（1–60，与「图标大小」同一把尺；实心圆偏重，画出来取该数的一半作直径）
const trajIconSize = ref(26)       // 航迹头的载具图标大小（屏幕 px @100% 缩放，1–60）
const showPtLabel = ref(false)     // 是否显示点标记坐标文字（默认不显示；圆点不受影响）
// 点标记画成带序号的圈（圈 1、圈 2）：序号＝点标记表格的行号（数组下标 +1，坐标留空的行照样占号），
// 图上第 7 号就是表里第 7 行。关掉退回普通圆点。
const showPtIndex = ref(true)
const showStName = ref(false)      // 是否显示地球站名称文字（默认不显示；图标不受影响）
const showPtLayer = ref(true)      // 点标记图层显隐（小眼睛；隐藏仅停止渲染，数据保留并持久化）
const showStLayer = ref(true)      // 地球站图层显隐（小眼睛）
const showTrajLayer = ref(true)    // 航迹图层显隐（小眼睛）
// 航迹头（末航点）上的载具图标：航行＝船舶、飞行＝飞机（形状见 viz/vehicleSymbol.js，2D/3D 同一份）
const showTrajIcon = ref(true)
// 「调整点位置」（仿 Polygon 调点）：在平面图上拖动圆点改坐标。'points'|'stations'|轨迹id，''=关闭；同一时刻仅一层可调、并与 Polygon 各态互斥。
const mkEditId = ref('')
const MK_HANDLE_PX = 5             // 可拖拽手柄圆环半径（屏幕恒定像素，比默认圆点略大便于抓取）
let mkEditPts = null              // 喂给 editVerts 的 [lon,lat] 快照（与 src 同序；拖动时原地更新以保持命中同步）
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
    const pv = sat.propagate(e.rec, t)
    if (!pv || !pv.position) continue
    const el = sat.ecfToLookAngles(gs, sat.eciToEcf(pv.position, g)).elevation / DEG
    if (best == null || el > best) best = el
  }
  return best
}
// 标签用仰角文本：未聚焦返回空串（地平线以下显示负值即标识不可见）
const fmtElev = (lat, lon) => { const e = satElevAt(lat, lon); return e == null ? '' : `仰角 ${e.toFixed(1)}°` }

// 聚焦星下点列表已并入 computeSelectedGeometry（与在轨点同一次 SGP4）—— 原先这里是整批星的第二趟推演；
// 推送则并在 commitGeometry（与可见性叠加层合到共用 replace-all 通道，避免相互覆盖）。

// 地图右键（3D 球体与 2D 平面图共用）：轨迹描绘中→直接加航点（连续右键描点）；否则→弹出右键菜单。
// ll：点击处经纬度（点在地球外为 null）；pos：屏幕坐标（菜单定位）。
const ctxMenu = ref(null)        // { x, y, ll } 右键菜单状态（null=隐藏）
function onMapRightClick(ll, pos) {
  if (bs.placing.value) { if (ll) bs.placeAt(ll); return }   // 波束合成放置态：右键在此放一个波束轮廓，不弹菜单
  const pg = curPoly()
  if (pg) { if (ll) { pg.pts.push([ll.lon, ll.lat]); polyRefresh() } return }   // Polygon 绘制中：连续加顶点，不弹菜单
  const t = curTraj()
  if (t) { if (ll) { t.pts.push({ lat: ll.lat, lon: ll.lon }); syncMarkers() } return }   // 描绘中：连续加点，不弹菜单
  ctxMenu.value = { x: pos ? pos.x : 0, y: pos ? pos.y : 0, ll: ll || null }
  nextTick(clampCtxMenu)   // 按菜单实际渲染尺寸夹紧到视口内：靠右/靠下边缘右键时不再被裁掉一截
}
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
// —— 清除（右键菜单平铺项）——
function clearPoints() { if (mkEditId.value === 'points') mkEditId.value = ''; points.value = []; syncMarkers(); closeCtx() }
function clearStations() { if (mkEditId.value === 'stations') mkEditId.value = ''; stations.value = []; syncMarkers(); closeCtx() }
function clearTrajs() { if (mkEditId.value && mkEditId.value !== 'points' && mkEditId.value !== 'stations') mkEditId.value = ''; trajectories.value = []; activeTraj.value = ''; mkTrajId.value = ''; syncMarkers(); closeCtx() }
// 隐藏所有 Polygon（不删除）：与逐个 togglePoly 同口径批量置 show=false，数据保留在 polys/localStorage，
// 可在 Polygon 面板重新逐个勾选显示。绘制中若有未成形多边形（<3 点）随 polyCancel 丢弃。
function ctxClearPolys() {
  if (polyDrawId.value) polyCancel()   // 结束绘制态（未成形的直接丢弃）
  polyEditId.value = ''; polyMoveId.value = ''; polyVertsOpen.value = ''
  for (const pg of polys.value) pg.show = false
  polyRefresh(); closeCtx()
}
function clearAllMk() { clearAllMarkers(); closeCtx() }
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
const markSizes = () => ({ ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value, ptDot: markPtDot.value, ptIdx: markPtIdx.value, trajDot: trajDotSize.value, trajIcon: showTrajIcon.value, trajIconPx: trajIconSize.value })
// 标记载荷构造器：坐标/名称是否带文字由 showPtLabel/showStName 决定（空串=圆点/图标保留、文字隐藏）。
// pushMarkers 与 feedFlat 共用，避免两处各写一份导致显隐口径不一致。
// 图层隐藏（小眼睛关）时返回空数组：仅停止渲染，points/stations/trajectories 原始数据不动、照常持久化。
// finite 守卫：批量表格里坐标可能暂空(null)——只渲染坐标齐全的点/站/航点，避免 NaN 画到画布
const finLL = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
// idx：序号取【原数组下标 +1】而非过滤后的位次 —— 表格的序号列就是行号，坐标留空的行照样占一个号，
// 按过滤后重编会让图上的号与表里的行整体错位。空串＝不画序号（退回普通圆点）。
const markerPts = () => showPtLayer.value ? points.value.map((p, i) => ({ p, i })).filter(({ p }) => finLL(p)).map(({ p, i }) => ({ lat: p.lat, lon: p.lon, idx: showPtIndex.value ? String(i + 1) : '', label: showPtLabel.value ? fmtLL(p.lat, p.lon) : '', el: fmtElev(p.lat, p.lon) })) : []
const markerSts = () => showStLayer.value ? stations.value.filter(finLL).map((s) => ({ lat: s.lat, lon: s.lon, name: showStName.value ? s.name : '', el: fmtElev(s.lat, s.lon) })) : []
const markerTrs = () => showTrajLayer.value ? trajectories.value.map((t) => ({ pts: (t.pts || []).filter(finLL), kind: t.kind, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a })) : []
// 仅把标记推送到两个视图（含聚焦卫星仰角），不写入持久化；供时间推进/选星刷新仰角调用
function pushMarkers() {
  if (!scene) return
  const pts = markerPts(), sts = markerSts(), trs = markerTrs()
  scene.setMarkers(pts, sts, markSizes()); scene.setTrajectories(trs, markSizes())
  if (flat) { flat.setMarkers(pts, sts, trs); flat.setSizes(markSizes()) }
}
function syncMarkers() { pushMarkers(); persistMarkers(); syncEdit() }   // syncEdit：增删/改名后重建可拖拽快照（无编辑态时无副作用）
// ---- 调整点位置（点标记 / 地球站 / 航迹航点：拖动圆点改坐标，仿 Polygon 调点，2D 平面图进行） ----
// 当前可调图层：{ kind, src:[{lat,lon,...}], color }；src 为活动数组引用（拖动直接改数据）
function mkEditTarget() {
  const id = mkEditId.value; if (!id) return null
  if (id === 'points') return { kind: 'points', src: points.value, color: 0xffd27a }
  if (id === 'stations') return { kind: 'stations', src: stations.value, color: 0x5ad1ff }
  const t = trajectories.value.find((x) => x.id === id)
  if (t) return { kind: 'traj', src: t.pts, color: t.kind === 'flight' ? 0x5ad1ff : 0xff6a4a }
  return null
}
const mkEditLabel = computed(() => {
  const id = mkEditId.value; if (!id) return ''
  if (id === 'points') return '点标记'
  if (id === 'stations') return '地球站'
  const t = trajectories.value.find((x) => x.id === id)
  return t ? `航迹「${t.name || ''}」` : ''
})
function mkRefresh() { pushMarkers(); redrawSats(); syncEdit() }   // 重画标记（移动点）+ 手柄 + 重建命中快照；不写盘（拖动 end 时统一持久化）
function mkEditToggle(key) {
  if (mkEditId.value === key) { mkEditStop(); return }
  if (key !== 'points' && key !== 'stations' && !trajectories.value.some((t) => t.id === key)) return
  polyEditStop(); polyMoveStop(); if (polyDrawId.value) polyCancel(); stopSynthPlacement(); if (activeTraj.value) endTraj()   // 与 Polygon 各态 / 波束合成 / 航迹描绘互斥（共用 editVerts 槽 / 绘制态）
  if (key === 'points') showPtLayer.value = true
  else if (key === 'stations') showStLayer.value = true
  else showTrajLayer.value = true
  mkEditId.value = key
  if (!view.flat) view.flat = true     // 拖点在平面图进行（applyFlat→feedFlat 会同步编辑态到渲染器）
  mkRefresh()
}
function mkEditStop() { if (mkEditId.value) { mkEditId.value = ''; mkEditPts = null; mkRefresh() } }
// 拖动某点：'move' 改坐标 + 实时重绘（不写盘），'end' 统一持久化
function onMkVertexDrag(vi, ll, phase) {
  const t = mkEditTarget(); if (!t) return
  if (phase === 'end') { persistMarkers(); return }
  if (vi == null || !ll || vi < 0 || vi >= t.src.length) return
  const p = t.src[vi]; p.lat = clamp(ll.lat, -90, 90); p.lon = ll.lon
  if (mkEditPts && mkEditPts[vi]) { mkEditPts[vi][0] = p.lon; mkEditPts[vi][1] = p.lat }   // 同步快照，保持后续命中一致
  pushMarkers(); redrawSats()
}
function persistMarkers() {
  try { localStorage.setItem(MK_KEY, JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })) } catch { /* ignore */ }
}
function loadMarkers() {
  try {
    const d = JSON.parse(localStorage.getItem(MK_KEY) || 'null')
    if (d) { points.value = d.points || []; stations.value = d.stations || []; trajectories.value = d.trajectories || [] }
  } catch { /* ignore */ }
}

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
function trajUndo() { const t = curTraj(); if (t && t.pts.length) { t.pts.pop(); syncMarkers() } }   // 撤销最后一个航点（与 polyUndo 一致）
function addWaypoint() {
  const t = curTraj(); if (!t) return
  const lat = parseFloat(wpLat.value), lon = parseFloat(wpLon.value)
  if (!validLat(lat) || !validLon(lon)) return
  t.pts.push({ lat, lon }); wpLat.value = ''; wpLon.value = ''; syncMarkers()
}
function removeWaypoint(t, i) { t.pts.splice(i, 1); syncMarkers() }
function setTrajName(id, v) { const t = trajectories.value.find((x) => x.id === id); if (t) { t.name = v; persistMarkers() } }
function removeTraj(id) { if (mkEditId.value === id) mkEditId.value = ''; if (mkTrajId.value === id) mkTrajId.value = ''; trajectories.value = trajectories.value.filter((t) => t.id !== id); if (activeTraj.value === id) activeTraj.value = ''; syncMarkers() }
function clearAllMarkers() { mkEditId.value = ''; points.value = []; stations.value = []; trajectories.value = []; activeTraj.value = ''; mkTrajId.value = ''; syncMarkers() }

// ===================== 标记批量表格（Excel 模块，仿链路预算性能表：独立浮窗 + Excel 网格 + 批量粘贴/导入）=====================
const mkTable = useMarkerTable({ points, stations, trajectories, newId, sync: syncMarkers })
const mkTableOpen = ref(false)                 // 浮窗开关
const mkTab = ref('points')                    // 当前分页：points | stations | traj
const mkTrajId = ref('')                       // 航迹分页当前编辑的航迹 id
const mkWin = ref({ x: 0, y: 0, w: 620, h: 460, init: false })
const mkCurTraj = () => trajectories.value.find((t) => t.id === mkTrajId.value)
// 三张网格列定义（末两列恒为 经度、纬度，供批量粘贴按「末两列=坐标」约定解析）
const mkPtCols = [{ key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true }]
const mkStCols = [{ key: 'name', label: '名称' }, { key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true }]
const mkWpCols = [{ key: 'lon', label: '经度', num: true }, { key: 'lat', label: '纬度', num: true }]
const mkCellText = (r, c) => { const v = r[c.key]; return v == null ? '' : String(v) }
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
  rows: () => { const t = mkCurTraj(); return t ? t.pts : [] }, cols: () => mkWpCols, cellText: mkCellText,
  onEdit: (id, key, val) => mkTable.wpUpdate(mkTrajId.value, id, { [key]: val }),
  onPasteBlock: (a, k, t) => mkTable.wpPasteBlock(mkTrajId.value, a, k, t),
  onPasteAppend: (t) => mkTable.wpPasteAppend(mkTrajId.value, t),
  onClear: (cells) => cells.forEach(({ rowId, key }) => mkTable.wpUpdate(mkTrajId.value, rowId, { [key]: '' })),
  onInsertRows: (at, n) => { if (!mkCurTraj()) return 0; for (let k = 0; k < n; k++) mkTable.wpAddRow(mkTrajId.value, at + k); return n },
  onDeleteRows: (ids) => { const t = mkCurTraj(); if (!t) return 0; const s = new Set(ids); const before = t.pts.length; t.pts = t.pts.filter((p) => !s.has(p.id)); return before - t.pts.length },
  pushUndo: () => mkTable.pushUndo(), dropUndo: () => mkTable.dropUndo(), refresh: () => syncMarkers(),
  undo: () => mkUndo(), redo: () => mkRedo()
})
const mkCurGrid = () => mkTab.value === 'stations' ? mkStGrid : mkTab.value === 'traj' ? mkWpGrid : mkPtGrid
// 三分页（点标记/地球站/航迹航点）：v-for 稳定 key 渲染各自网格，v-show 切换显示（实例常驻，选区/编辑态各自保留）
const mkPanes = computed(() => [
  { tab: 'points', grid: mkPtGrid, cols: mkPtCols, rows: points.value },
  { tab: 'stations', grid: mkStGrid, cols: mkStCols, rows: stations.value },
  { tab: 'traj', grid: mkWpGrid, cols: mkWpCols, rows: mkCurTraj() ? mkCurTraj().pts : [] }
])
const mkCount = computed(() => mkTab.value === 'stations' ? stations.value.length : mkTab.value === 'traj' ? (mkCurTraj() ? mkCurTraj().pts.length : 0) : points.value.length)
// 「导出 Excel」可用性：航迹分页导的是全部航迹（不只当前这条），故按全部航点数算
const mkXlsxRows = computed(() => mkTab.value === 'traj' ? trajectories.value.reduce((n, t) => n + ((t.pts || []).length), 0) : mkCount.value)
function mkWinInit() {
  if (mkWin.value.init) return
  const { w: vw, h: vh } = g3Size()
  const w = Math.min(620, vw - 48), h = Math.min(Math.round(vh * 0.62), vh - 48)
  mkWin.value = { x: Math.max(12, Math.round((vw - w) / 2)), y: Math.max(12, Math.round(vh * 0.16)), w, h, init: true }
}
function openMkTable(tab) {
  mkTable.ensureWaypointIds()   // 老航点补稳定 id（网格定位用）
  mkSetTab(tab || mkTab.value)
  mkTable.clearHistory()
  mkWinInit(); mkTableOpen.value = true
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
  const sheets = list.map((t) => sheetModel({
    name: t.name || byLang('航迹', 'Track'), cols: mkWpCols, rows: t.pts, value: (r, c) => r[c.key],
    note: t.kind === 'flight' ? '飞行' : '航行'   // 航迹类型：主进程把 note 单开成「说明」表，导回来照认
  }))
  const r = await exportSheets({ defaultName: safeFileName('航迹', '航迹') + '.xlsx', title: '导出航迹', sheets })
  if (r && r.error) appAlert('导出失败：' + r.error)
}
async function mkImportTrajXlsx() {
  const res = await importWorkbook({ title: '导入航迹（一张工作表一条）' })
  if (!res || res.canceled) return
  if (!res.ok) { appAlert('导入失败：' + (res.error || '无法读取该文件')); return }
  const made = trajsFromSheets(res.sheets, {
    newId, taken: trajectories.value.map((t) => String(t.name || '')), fallbackName: byLang('航迹', 'Track')
  })
  if (!made.length) { appAlert('没有读到航点（表头需含「经度 / 纬度」，或把经纬度放在最后两列）'); return }
  mkTable.pushUndo()
  const add = made.map((t) => ({ id: newId(), name: t.name, kind: t.kind, pts: t.pts }))
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
  const tag = tzUtc() ? 'UTC' : localTzLabel.value
  const d = new Date(clock.tMs)
  const md = `${p(tMon(d) + 1)}-${p(tDay(d))}`
  const hms = `${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`
  const off = live.value ? '实时' : (atNow.value ? '此刻' : fmtOffset(relNowMs.value))
  return { m: hms, d: md, o: off, z: tag, s: `${md} ${off} ${tag}` }   // s 仍供 aria-valuetext 用
})
function toggleTz() { tzMode.value = tzUtc() ? 'local' : 'utc' }

// ===================== 持久化（记住分组 + 选中星） =====================
function saveSelection() {
  // 分组按 key 持久化（groupIndex 仅作旧版兼容读取）：GROUPS 增删项后不再错位。
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ groupKey: GROUPS[groupIndex.value] ? GROUPS[groupIndex.value].key : '', groupIndex: groupIndex.value, selNorad: selEntry ? String(selEntry.noradId) : '' })) } catch { /* ignore */ }
}
// 资源管理器「星座」树行点击切换分组（原顶栏下拉已并入树）
function pickGroup(i) {
  if (!Number.isInteger(i) || i < 0 || i >= GROUPS.length) return
  if (i === groupIndex.value) {
    // 筛选态（搜索命中 / 卫星组显示）下所有内置组行都不高亮（sel 带 !filterN），用户回点「当前这一组」
    // 意在退出筛选回到该组；直接早退会点了没反应。分组数据仍在 entries 里，只需退筛选、无需重载。
    if (filterEntries.length) { soloConst.value = null; customConst.showOnly(null); clearSearch() }
    return
  }
  soloConst.value = null            // 选内置组 → 清除自定义星座的单独显示高亮
  customConst.showOnly(null)        // 并隐藏全部自定义星座：选哪个看哪个，内置组不再叠加自定义星座（如需叠加对比，用列表行内「眼睛」单独开）
  groupIndex.value = i; clearSearch()
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
    nameMode: nameMode.value, countryName: countryNameSize.value, provName: provNameSize.value, cityName: cityNameSize.value,
    oceanMode: oceanNameMode.value, seaMode: seaNameMode.value, oceanName: oceanNameSize.value, seaName: seaNameSize.value, waterOff: { ...waterOff },
    chain: { on: chainOn.value, off: { ...chainOff }, style: { ...chainStyle } },
    showProvinces: showProvinces.value, showCities: showCities.value, admSel1: [...admSel1.value], admName1: admName1.value, admName2: admName2.value, borderStyle: { ...borderStyle }, labelStyle: { ...labelStyle }, termOn: termOn.value, termNight: termNight.value, termLine: termLine.value, termStyle: { ...termStyle }, tzMode: tzMode.value, crs: { ...mapCrs }, oceanColor: oceanColor.value, imagery: { on: imageryOn.value, k: imageryKey.value, bright: imageryBright.value }, landScheme: landScheme.value, landOverrides: { ...landOverrides }, groupColors: { ...groupColors }, autoRotate: autoRotate.value, autoRotateSpeed: viewPrefs.autoRotateSpeed, live: live.value, clock: { stepSec: clock.stepSec, speed: clock.speed }, beamLock: beamLock.value, fpMode: fpMode.value, beam: beam.value, elevMin: elevMin.value, focusStyle: { ...focusStyle }, windowMin: windowMin.value,
    mkPt: markPtFont.value, mkStIcon: stIconSize.value, mkStFont: stFontSize.value, mkPtDot: markPtDot.value, mkPtIdx: markPtIdx.value, mkTrajDotPx: trajDotSize.value, mkTrajIcon: trajIconSize.value,
    mkPtShow: showPtLabel.value, mkPtIdxShow: showPtIndex.value, mkStShow: showStName.value, mkTrajIconShow: showTrajIcon.value,
    mkPtLayer: showPtLayer.value, mkStLayer: showStLayer.value, mkTrajLayer: showTrajLayer.value,
    covOpen: covOpen.value, polyOpen: polyOpen.value,
    grdOpen: grdOpen.value, grd: grd.getState(), perf: perf.getState(),
    satcov: satcov.getState(), satPerf: satPerf.getState(),
    satcovUi: { table: satcovTableOpen.value, pickSrc: satcovPickSrc.value },
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
  if (s.imagery && typeof s.imagery === 'object') {
    imageryKey.value = imagerySource(s.imagery.k).k          // 存档里的源没了（换版本）→ 落回第一个，不留空
    if (Number.isFinite(Number(s.imagery.bright))) imageryBright.value = Math.max(0.05, Math.min(2, Number(s.imagery.bright)))
    imageryOn.value = !!s.imagery.on
    applyImagery()
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
  if (Number.isFinite(s.mkPt)) markPtFont.value = s.mkPt
  if (Number.isFinite(s.mkPtDot)) markPtDot.value = s.mkPtDot
  if (Number.isFinite(s.mkPtIdx)) markPtIdx.value = s.mkPtIdx
  if (Number.isFinite(s.mkStIcon)) stIconSize.value = s.mkStIcon
  if (Number.isFinite(s.mkStFont)) stFontSize.value = s.mkStFont
  // 圆点大小口径换过一次：老的 mkTrajDot 是半径系数（可见直径 = 值 × 18/32 × 2.5），新的 mkTrajDotPx
  // 直接就是直径。老存档按同一条换算折过来，屏上大小不变。
  if (Number.isFinite(s.mkTrajDotPx)) trajDotSize.value = s.mkTrajDotPx
  else if (Number.isFinite(s.mkTrajDot)) trajDotSize.value = Math.max(1, Math.min(60, Math.round(s.mkTrajDot * (18 / 32) * 2.5)))
  if (Number.isFinite(s.mkTrajIcon)) trajIconSize.value = s.mkTrajIcon
  if (typeof s.mkPtShow === 'boolean') showPtLabel.value = s.mkPtShow
  if (typeof s.mkPtIdxShow === 'boolean') showPtIndex.value = s.mkPtIdxShow
  if (typeof s.mkStShow === 'boolean') showStName.value = s.mkStShow
  if (typeof s.mkTrajIconShow === 'boolean') showTrajIcon.value = s.mkTrajIconShow
  if (typeof s.mkPtLayer === 'boolean') showPtLayer.value = s.mkPtLayer
  if (typeof s.mkStLayer === 'boolean') showStLayer.value = s.mkStLayer
  if (typeof s.mkTrajLayer === 'boolean') showTrajLayer.value = s.mkTrajLayer
  syncMarkers()   // 以恢复后的尺寸重建标记（含坐标/名称显隐、各图层显隐）
  if (typeof s.autoRotate === 'boolean') { autoRotate.value = s.autoRotate; scene.setAutoRotate(autoRotate.value) }
  if (Number.isFinite(s.autoRotateSpeed)) { viewPrefs.autoRotateSpeed = s.autoRotateSpeed; scene.setAutoRotateSpeed(s.autoRotateSpeed) }
  // 聚焦卫星显示样式：逐字段按类型合并（旧存档没这一项时全留出厂值），随后一次性推给两个渲染器
  if (s.focusStyle && typeof s.focusStyle === 'object') {
    for (const [k, v] of Object.entries(s.focusStyle)) {
      const d = FOCUS_STYLE_DEF[k]
      if (d === undefined) continue
      if (typeof d === 'boolean') { if (typeof v === 'boolean') focusStyle[k] = v }
      else if (typeof d === 'number') { if (Number.isFinite(v)) focusStyle[k] = v }
      else if (typeof v === 'string') focusStyle[k] = v
    }
    focusStyle.trkPeriods = clamp(Number(focusStyle.trkPeriods) || 1, 0.25, 10)
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
  if (s.tzMode === 'utc' || s.tzMode === 'local') tzMode.value = s.tzMode   // 时间轴读数时区档位（仅显示）
  if (s.crs && typeof s.crs === 'object') { setMapCrs(s.crs); crsCenterShown.value = lon0ToCenter(mapCrs.lon0) }   // 坐标系三档（只改呈现，见 stores/mapCrs）
  // 晨昏线：默认关，存档里显式 true 才开；样式逐字段合并（旧存档缺字段时保留默认值）
  if (typeof s.termOn === 'boolean') termOn.value = s.termOn
  if (typeof s.termNight === 'boolean') termNight.value = s.termNight
  if (typeof s.termLine === 'boolean') termLine.value = s.termLine
  if (s.termStyle && typeof s.termStyle === 'object') {
    for (const k of ['nightColor', 'lineColor']) if (typeof s.termStyle[k] === 'string') termStyle[k] = s.termStyle[k]
    for (const k of ['nightOpacity', 'lineWidth', 'lineOpacity']) if (Number.isFinite(s.termStyle[k])) termStyle[k] = s.termStyle[k]
  }
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
      if (s.satcovUi.table && sideCtx() === 'satcov') {
        satcovHost.value = g3Size()
        satcovTableOpen.value = true
        await nextTick(); satcovRefreshTable()
      }
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
  const parts = []
  if (r.groups) parts.push(`${r.groups} 组 / ${r.sats} 颗`)
  if (r.replaced) parts.push(`替换 ${r.replaced}`)
  if (r.invalid) parts.push(`无效 ${r.invalid}`)
  const errs = (r.errors || []).filter(Boolean)
  logMsg(`导入星历：${parts.length ? parts.join(' · ') : '无变化'}${errs.length ? `；${errs.length} 条失败：${errs[0]}` : ''}`, errs.length ? 'warn' : 'info')
  // 切到「自定义卫星」分组立即可见（保留旧路径导入即见的体验）；bumpCustomSats 同步刷新文件管理 + 搜索池。
  const ci = GROUPS.findIndex((g) => g.key === 'custom')
  if (ci >= 0) pickGroup(ci)
  bumpCustomSats()
}

onMounted(async () => {
  // 顶栏「视图」按钮右侧的覆盖图入口：注册可用性与切换回调（按钮渲染在 App.vue，状态走 covNav store）
  covNav.grdAvail = grdApiOk; covNav.covAvail = covApiOk
  covNav.toggleGrd = toggleGrd; covNav.toggleCov = toggleCoverage
  covNav.polyAvail = true; covNav.togglePoly = togglePolyPanel   // Polygon 面板（纯本地功能，不依赖 IPC）
  covNav.exportAvail = true; covNav.exportMap = exportMap   // 顶栏「导出图」入口（高清 PNG / 矢量 PDF）
  covNav.sendMiniapp = sendToMiniapp   // 顶栏「导出」菜单「发送到小程序」入口（覆盖层 + 多边形一份快照）
  covNav.importTle = importTleToLibrary   // 「文件」菜单「导入星历文件」入口 → 落库自定义卫星（贯通文件管理/搜索池）
  watch(status, (v) => { if (v) logMsg(v) })   // 加载进度/失败信息落日志窗格
  // 文件管理导入/删除自定义卫星 → 若正看 custom/all/other 分组则重载；并重建全量搜索库纳入新星。
  watch(() => fileBridge.customSatTick, () => {
    const k = curKey()
    if (k === 'custom' || k === 'all' || k === 'other') loadGroup()
    poolReady = false; ensureSearchPool()
    refreshCustomImportCount()   // 导入组增删 → 刷新权威计数（决定「自定义卫星」分组显隐）
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
  scene.setAutoRotate(autoRotate.value)
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
  scene.setOnAutoRotateOff(() => { autoRotate.value = false })
  scene.setOnPick((index, point, additive) => {
    // 从星座点选模式：命中的星填入卫星编辑弹窗，不改变当前选中星
    if (satPick.value && satModal.value) { if (index >= 0) { const en = renderEntries[index]; if (en) pickEntryIntoModal(en) } return }
    if (index < 0) { if (!additive) closeCard(); return }   // 点空白=清空（按住修饰键点空白不清空）
    const en = renderEntries[index]; if (!en) return
    selectSat(en, false, additive)   // 裸点=替换聚焦；Ctrl/Cmd/Shift 点=加入/移出多选
  })
  // 鼠标实时经纬度（底部状态栏显示）+ 右键标点/加航点
  scene.setOnHover(onHoverLL)
  scene.setOnRightClick(onMapRightClick)
  scene.setOnBeamDrag(onBeamDragAny)   // 拖拽波束（GRD boresight）：对地拖地表落点、对星绕源星转方向
  satcovSyncDragSphere()
  scene.setOnLabelDrag(grd.labelDrag); scene.setLabelDragMode(grd.dragLabel.value)   // 拖拽等值线数值标签（沿线滑动）
  scene.setOnPolyDraw(onPolyDraw); scene.setPolyDrawMode(!!(polyDrawId.value || activeTraj.value))   // Polygon/航迹绘制：左键按住沿路径连续加点
  scene.setOnPlace((ll) => bs.placeAt(ll)); scene.setPlaceMode(bs.placing.value)   // 波束合成放置：左键点击落波束（拖动仍旋转）
  // 缩放进度条（底部状态栏）：注册当前页缩放能力，球体滚轮缩放回填进度条 + 记忆
  scene.setOnZoom((t) => { if (!flatView.value) { zoom.value = t; saveView() } })
  if (savedView.globe) scene.setView(savedView.globe)   // 恢复上次球体视图（朝向+缩放）
  // 平移/旋转结束也保存视图（滚轮已由 onZoom 覆盖；拖拽无回调，故监听 pointerup）
  el.value.addEventListener('pointerup', saveView)
  // 方向键导航（3D 旋转 / 2D 平移视窗中心）：全局监听，失焦清键防卡键
  window.addEventListener('keydown', onNavKeyDown)
  window.addEventListener('keyup', onNavKeyUp)
  window.addEventListener('blur', navStop)
  zoom.avail = true; zoom.apply = applyZoom; pushZoom()
  grd.setLivePos(satLivePos)          // GRD 覆盖按星历/时间轴解算星下点+高度（关联星实时跟踪）
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
  ro = new ResizeObserver(() => { if (scene) scene.resize(); if (flat && flatView.value) flat.resize() }); ro.observe(el.value)
  if (track.value) { trackWidthPx.value = track.value.clientWidth || 600; trackRo = new ResizeObserver(() => { if (track.value) trackWidthPx.value = track.value.clientWidth || trackWidthPx.value }); trackRo.observe(track.value) }   // 轨道宽 → 刻度自适应

  // 恢复上次分组 + 选中星
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    if (saved) {
      let gi = -1
      if (saved.groupKey) gi = GROUPS.findIndex((g) => g.key === saved.groupKey)   // 优先按 key 恢复（抗增删错位）
      // 旧版仅存 groupIndex：本次在索引 2 处插入了「自定义卫星」，旧索引 ≥2 需 +1 精确还原原选择
      else if (Number.isInteger(saved.groupIndex)) gi = saved.groupIndex >= 2 ? saved.groupIndex + 1 : saved.groupIndex
      if (gi >= 0 && gi < GROUPS.length) groupIndex.value = gi
    }
    if (saved && saved.selNorad) { pendingNorad = saved.selNorad; pendingNoFace = true }
  } catch { /* ignore */ }

  await restoreSettings()   // 恢复全部选项/设置（无感）
  await ensureProvinces(); await ensureCities()   // 按恢复后的省/市界开关加载数据并套用可见性（restoreSettings 只回填开关）
  customConst.load()   // 恢复自定义星座（按参数重建合成星，随后由 loadGroup→rebuildRenderSet 一并渲染）
  satGroups.load()   // 恢复已存卫星组（仅列表；显示由用户点击组行触发）
  refreshCustomImportCount()   // 权威导入组计数（决定「自定义卫星」分组是否在星座列表出现）
  loadGroup()
  // 后台构建全量搜索库（当日缓存命中则很快），与当前分组无关。
  // 就绪后补一拍：GRD 关联星不在当前分组时，此前 satLivePos 解析不到星历（liveEntryOf 的兜底
  // 顺序是 entries → searchPool）、meta 停在存盘位置，这一拍才把星位/视轴/壳层一并对齐。
  ensureSearchPool().finally(() => { if (poolReady) refreshPositions() })
  redrawSats()   // 恢复后立即绘制自定义卫星（关联卫星待 loadGroup 完成由 refreshPositions 跟踪）
  applyDisplayQuality()   // 套用当前画质档位（含低/中档的 110m、高/超高档的 50m 底图按需加载）
  applyTerminator()   // 晨昏线：按恢复后的开关画一次（不依赖星历，故不等 loadGroup）
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
  covNav.polyAvail = false; covNav.togglePoly = null
  covNav.exportAvail = false; covNav.exportMap = null; covNav.importTle = null; covNav.sendMiniapp = null
  covNav.grdOpen = false; covNav.covOpen = false; covNav.polyOpen = false
  zoom.avail = false; zoom.apply = null   // 复位底部状态栏缩放进度条
  offLang()
  if (_viewSaveTimer) { clearTimeout(_viewSaveTimer); _viewSaveTimer = null }
  if (el.value) el.value.removeEventListener('pointerup', saveView)
  if (flatCanvas.value) flatCanvas.value.removeEventListener('pointerup', saveView)
  window.removeEventListener('keydown', onNavKeyDown)
  window.removeEventListener('keyup', onNavKeyUp)
  window.removeEventListener('blur', navStop)
  navStop()

  clearGrdBridge()   // 离开 3D 页：注销文件管理器对活树/导出器的引用
  fileBridge.customConst = null
  // 离开本页：退订并停表。时刻本身保留在 store 里 —— 回来接着这个时刻，不弹回「此刻」。
  if (unsubClock) { unsubClock(); unsubClock = null }
  if (nowBeat) { clearInterval(nowBeat); nowBeat = null }
  releaseClock()
  offPovTick(); offMapPov()   // 退订主权解算层与视角状态源
  cursor.ll = null; cursor.env = null; if (ro) ro.disconnect(); if (trackRo) trackRo.disconnect(); if (geomPool) { geomPool.dispose(); geomPool = null }; if (flat) flat.destroy(); if (scene) { scene.clearCoverage(); scene.destroy() }
})
</script>

<template>
  <div class="g3" ref="g3el">
    <div class="body">
      <div class="stage-wrap">
        <div ref="el" class="stage"></div>
        <canvas v-show="flatView" ref="flatCanvas" class="flat"></canvas>

        <!-- 聚焦卫星图例：色条＝地图上实际那两根线（颜色/线型随「显示设置 · 聚焦卫星」走），3D / 2D 同步显示 -->
        <div v-if="selected && (focusStyle.fpOn || focusStyle.trkOn)" class="focus-legend">
          <div v-if="focusStyle.fpOn" class="fl-row"><span class="fl-sw" :style="fpSwStyle"></span>{{ fpLegend }}</div>
          <div v-if="focusStyle.trkOn" class="fl-row"><span class="fl-sw" :style="trkSwStyle"></span>星下点轨迹</div>
        </div>

        <div v-if="selected" class="card" :class="{ collapsed: cardCollapsed }">
          <div class="ch" :title="cardCollapsed ? '展开' : '收起'" @click="cardCollapsed = !cardCollapsed">
            <span class="cc" :class="{ col: cardCollapsed }"><Icon name="chevron-down" :size="12" /></span>
            <span class="cn" :title="selList.length > 1 ? '' : selected.name">{{ selList.length > 1 ? (selList.length + ' 颗聚焦') : selected.name }}</span>
            <span class="cg" title="显示设置：轨道线 / 星下点轨迹 / 覆盖圈 / 卫星标记" @click.stop="openFocusSettings"><Icon name="sliders-horizontal" :size="12" /></span>
            <span class="cx" :title="selList.length > 1 ? '全部取消' : '取消聚焦'" @click.stop="closeCard"><Icon name="x" :size="12" /></span>
          </div>
          <!-- 多选：mini-card 列表（点行=设为主选看详情，×=移出）；单选时不显示，直接看详情 -->
          <div v-show="!cardCollapsed && selList.length > 1" class="msel">
            <div v-for="s in selList" :key="s.idx" class="mrow" :class="{ active: s.active }" @click="setPrimary(s)">
              <div class="mmain">
                <div class="mr1"><span class="mnm" :title="s.name" data-i18n-skip>{{ s.name }}</span><span class="mkind">{{ s.kind }}</span></div>
                <div class="msub">{{ s.noradId }}<template v-if="s.slot"> · {{ s.slot }}</template> · {{ s.alt }}km · {{ s.incl }}°</div>
              </div>
              <span class="mx" title="移出该星" @click.stop="removeSel(s)"><Icon name="x" :size="12" /></span>
            </div>
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
            <div class="row"><span class="k">轨道高度</span><span class="v">{{ selected.alt }}<i>km</i></span></div>
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

      <!-- 侧栏视图（Teleport 到 App.vue #side-view）：活动栏图标切换，同屏只显示一个视图（v-show），
           标题显示在侧栏头部（App.vue），面板懒加载由 shellUi.side 的 watcher 触发原 toggle* -->
      <Teleport v-if="shellUi.side" to="#side-view">
        <!-- 星座：卫星搜索 + 旋转/实时开关 + 在轨/OMM 状态 + 分组列表 -->
        <div v-show="shellUi.side === 'constellation'" class="sview" :class="{ editing: constModal }">
          <!-- 生成/编辑器内联面板：编辑器打开时侧栏切为此面板，地图保持可见 + 实时预览（仿 KeepTrack 停靠式） -->
          <div v-if="constModal" class="cedit">
            <div class="cehd">
              <span class="ceback" @click="closeConstWizard"><Icon name="chevron-left" :size="12" /> 返回</span>
              <span class="cetitle">{{ constModal.id ? '编辑星座' : '生成星座' }}</span>
              <span class="celive" title="改动实时预览到地球">● 实时</span>
            </div>
            <div class="cebody">
              <div class="cef"><label>星座名称</label><input class="ci" v-model="constModal.name" placeholder="星座名称" /></div>
              <div class="cef"><label>星座构型</label>
                <span class="seg3">
                  <span :class="{ on: constModal.pattern === 'delta' }" @click="constModal.pattern = 'delta'">Delta</span>
                  <span :class="{ on: constModal.pattern === 'star' }" @click="constModal.pattern = 'star'">Star</span>
                  <span :class="{ on: constModal.pattern === 'plane' }" @click="constModal.pattern = 'plane'">单轨道面</span>
                </span>
              </div>

              <div class="cesec">Walker 构型参数 (i : T/P/F)</div>
              <div class="cetpf">
                <div><small>卫星总数 T</small><input class="ci" type="number" min="1" step="1" v-model.number="constModal.T" /></div>
                <div v-if="constModal.pattern !== 'plane'"><small>轨道面数 P</small><input class="ci" type="number" min="1" step="1" v-model.number="constModal.P" /></div>
                <div v-if="constModal.pattern !== 'plane'"><small>相位因子 F</small><input class="ci" type="number" min="0" step="1" v-model.number="constModal.F" /></div>
              </div>
              <div class="cef"><label>轨道倾角 i</label><input class="ci" type="number" step="0.1" v-model.number="constModal.incl" /><span class="u">°</span></div>

              <div class="cesec">轨道尺寸与形状</div>
              <div class="cef"><label>轨道形状</label>
                <span class="seg3">
                  <span :class="{ on: constModal.shape === 'circ' }" @click="constModal.shape = 'circ'">圆轨道</span>
                  <span :class="{ on: constModal.shape === 'ellip' }" @click="constModal.shape = 'ellip'">椭圆轨道</span>
                </span>
              </div>
              <div class="cefv"><label>{{ constModal.shape === 'ellip' ? '近地点高度 hₚ' : '轨道高度 h' }}</label><div class="ceinp"><input class="ci" type="number" step="10" v-model.number="constModal.perigeeKm" /><span class="u">km</span></div></div>
              <template v-if="constModal.shape === 'ellip'">
                <div class="cefv"><label>远地点高度 hₐ</label><div class="ceinp"><input class="ci" type="number" step="10" v-model.number="constModal.apogeeKm" /><span class="u">km</span></div></div>
                <div class="cefv"><label>近地点幅角 ω</label><div class="ceinp"><input class="ci" type="number" step="1" v-model.number="constModal.argp" /><span class="u">°</span></div></div>
              </template>

              <div class="cesec">星座定向与初始相位</div>
              <div class="cetpf">
                <div><small>升交点赤经 Ω₀</small><input class="ci" type="number" step="1" v-model.number="constModal.raan0" /></div>
                <div><small>初始平近点角 M₀</small><input class="ci" type="number" step="1" v-model.number="constModal.m0" /></div>
              </div>

              <div class="cesec">显示外观</div>
              <label class="chk2"><input type="checkbox" v-model="constModal.colorByPlane" /><span>按轨道面配色</span></label>
              <div v-if="!constModal.colorByPlane" class="cef"><label>标识颜色</label><input class="clr" type="color" v-model="constModal.color" /></div>

              <div v-if="constDerived" class="ceread">
                <div class="crcode">{{ constDerived.code }}</div>
                <div class="crsub">共 {{ constDerived.total }} 颗<template v-if="constModal.pattern !== 'plane'"> · 每面 {{ constDerived.S }} · 面间 {{ constDerived.phase }}°</template> · 周期 {{ constDerived.periodMin }} min</div>
                <div v-if="constDerived.warns.length" class="crwarn">{{ constDerived.warns.join('；') }}</div>
              </div>
            </div>
            <div class="cefoot">
              <span class="cancel" @click="closeConstWizard">取消</span>
              <span class="save" @click="saveConstWizard">{{ constModal.id ? '更新' : '生成' }}</span>
            </div>
          </div>
          <template v-else>
          <div class="ptool">
            <div class="search">
              <input :value="keyword" placeholder="搜索名 / 编号（即筛选显示）" @input="onSearch" />
              <span v-if="keyword" class="clr" @click="clearSearch"><Icon name="x" :size="12" /></span>
              <div v-if="searchResults.length" class="panel">
                <div v-for="item in searchResults" :key="item.noradId" class="item" :class="{ picked: selNorads.has(String(item.noradId)) }" @click="pickResult(item)">
                  <div class="itx">
                    <div class="nm" data-i18n-skip>{{ item.name }}</div>
                    <div class="sub">{{ item.groupLabel }} · NORAD {{ item.noradId }}<span v-if="item.slot"> · {{ item.slot }}</span></div>
                  </div>
                  <!-- 「+」＝加入选中集但不清搜索框：换关键词再点「+」可跨多次搜索攒出一批，再「存为组」 -->
                  <span
                    class="ipk"
                    :title="selNorads.has(String(item.noradId)) ? '已在选中集中，点击移出' : '加入选中集（可继续换词搜索累积，之后点「存为组」）'"
                    @click.stop="toggleResultSel(item)"
                  ><Icon :name="selNorads.has(String(item.noradId)) ? 'check' : 'plus'" :size="12" /></span>
                </div>
              </div>
            </div>
            <div v-if="filterN" class="fbar">
              <span class="fdot"></span>
              <template v-if="filterGroupId">查看组 <b>{{ filterKw }}</b> · {{ filterN }} 颗</template>
              <template v-else>已筛选 <b>{{ filterKw }}</b> · 显示 {{ filterN }} 颗</template>
              <span v-if="!filterGroupId" class="fsave" title="将当前筛选结果存为卫星组（可稍后重新显示）" @click="saveFilterAsGroup"><Icon name="folder-plus" :size="12" /> 存为组</span>
              <span class="fx" @click="clearSearch">清除</span>
            </div>
            <!-- 一颗也算数：单颗选中同样要能「存为组」（此前 ≥2 才出条，导致单星无法建组） -->
            <div v-if="selList.length" class="fbar selbar">
              <span class="fdot sel"></span>已选 <b>{{ selList.length }}</b> 颗卫星
              <span class="fsave" title="将选中的卫星存为卫星组（可稍后重新显示）" @click="saveSelectionAsGroup"><Icon name="folder-plus" :size="12" /> 存为组</span>
              <span class="fx" title="取消全部选择" @click="closeCard">清除</span>
            </div>
            <div class="pchips">
              <span class="mini" :class="{ on: autoRotate }" @click="toggleRotate">{{ autoRotate ? '旋转中' : '已停止' }}</span>
              <span class="mini" :class="{ on: live }" @click="toggleLive">{{ live ? '实时开' : '实时关' }}</span>
              <span class="mini act" title="把卫星组 / 自定义卫星 / 自定义星座发送到小程序「星座地图」（投给已绑定账号，或生成一次性密钥）" @click="sendSatsToMiniapp"><Icon name="external-link" :size="12" /> 发送到小程序</span>
            </div>
            <div class="pstat"><template v-if="filterN">筛选显示 {{ filterN }} 颗（清空搜索恢复）</template><template v-else>在轨 {{ satCount }}<template v-if="shownCount && shownCount < satCount"> · 渲染 {{ shownCount }}</template></template>
              <template v-if="dataTime"> · OMM {{ dataTime }}</template>
              <template v-if="status"> · {{ status }}</template></div>
          </div>
          <div class="pgl">
            <template v-for="(g, i) in GROUPS" :key="g.key">
            <!-- 「自定义卫星」分组数据驱动：无导入星历（文件管理 custom.json 为空）时不显示，与该分组实际
                 加载的内容（omm.customCsv）对齐；自建星座不计入（见 hasCustomData 注释）。
                 但当前若正选中它则保留一行（避免选中项被隐藏成孤儿态）。其余内置组恒显示。 -->
            <template v-if="g.key !== 'custom' || hasCustomData || i === groupIndex">
            <div
              class="grprow" :class="{ sel: i === groupIndex && !filterN, exp: expTag === 'g:' + g.key }"
              @click="pickGroup(i)"
              @contextmenu.prevent.stop="openRowMenu($event, 'grp', g, i)"
            >
              <!-- 箭头只管展开卫星列表，不切换地图上渲染的分组（那是点行本身的事） -->
              <span v-if="g.key !== 'none'" class="pgex" :title="expTag === 'g:' + g.key ? '收起卫星列表' : '展开卫星列表'" @click.stop="expToggle('g:' + g.key, g.label)"><Icon :name="expTag === 'g:' + g.key ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
              <span v-else class="pgex none"></span>
              <span class="pgico"><Icon name="satellite" :size="12" /></span>
              <span class="pgn">{{ g.label }}</span>
              <template v-if="groupColorable(g.key)">
                <span v-if="groupColors[g.key]" class="pgrst" title="恢复默认星点色" @click.stop="resetGroupColor(g.key)"><Icon name="x" :size="12" /></span>
                <label class="pgclr" :title="'星点颜色（' + groupColorHex(g.key) + '）'" @click.stop>
                  <span class="pgsw" :style="{ background: groupColorHex(g.key) }"></span>
                  <input type="color" :value="groupColorHex(g.key)" @input="e => setGroupColor(g.key, e.target.value)" />
                </label>
              </template>
            </div>
            <SatList
              v-if="expTag === 'g:' + g.key"
              :items="expList" :reset-key="expTag" :loading="expLoading" :error="expErr" :actions="expActions" :rows="14"
              :placeholder="'在 ' + g.label + ' 里筛选'"
              @action="expOnAction" @activate="expLocate"
            />
            </template>
            </template>
          </div>
          <!-- 卫星组：保存的命名卫星子集，点击行重新显示。恒显示（含零组）——空态下也要有「新建 / 管理」入口，
               否则第一个组只能从筛选栏 / 选中栏诞生，没星可选时就无从下手。 -->
          <div class="ccsec">
            <div class="cchd"><span>卫星组</span>
              <span class="cchr">
                <span v-if="satGroups.list.value.length" class="ccsub">{{ satGroups.list.value.length }} 组</span>
                <span class="lnk" title="新建一个空组，然后在管理器里搜索添加卫星" @click="openSatGrpMgr(); sgmNew()"><Icon name="plus" :size="12" /> 新建</span>
                <span class="lnk" title="打开卫星组管理器：新建 / 改名 / 复制 / 删除 · 搜索添加卫星 · 逐颗或批量移出" @click="openSatGrpMgr()"><Icon name="sliders-horizontal" :size="12" /> 管理</span>
              </span>
            </div>
            <div v-if="!satGroups.list.value.length" class="cctip">还没有卫星组。</div>
            <template v-for="g in satGroups.list.value" :key="g.id">
            <div
              class="ccrow sgrow" :class="{ sel: filterGroupId === g.id, exp: expTag === 's:' + g.id }"
              :title="filterGroupId === g.id ? '再次点击退出显示' : ('显示该组的 ' + g.sats.length + ' 颗卫星')"
              @click="toggleSatGroup(g)"
              @contextmenu.prevent.stop="openRowMenu($event, 'sg', g)"
            >
              <span class="pgex" :title="expTag === 's:' + g.id ? '收起成员列表' : '展开成员列表'" @click.stop="expToggle('s:' + g.id, g.name)"><Icon :name="expTag === 's:' + g.id ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
              <template v-if="satGrpRenameId === g.id">
                <span class="ccic"><Icon name="layers" :size="12" /></span>
                <input
                  class="sgnm-in" v-model="satGrpRenameVal" @click.stop
                  :ref="setRenameEl"
                  @keydown.enter="satGrpCommitRename(g)" @keydown.esc.stop="satGrpRenameId = ''"
                />
                <span class="ccic ok" title="确认重命名" @click.stop="satGrpCommitRename(g)"><Icon name="check" :size="12" /></span>
                <span class="ccic" title="取消" @click.stop="satGrpRenameId = ''"><Icon name="x" :size="12" /></span>
              </template>
              <template v-else>
                <span class="ccic"><Icon name="layers" :size="12" /></span>
                <span class="ccnm" :title="g.name" data-i18n-skip>{{ g.name }}</span>
                <span class="cccode">{{ g.sats.length }} 颗</span>
                <span v-if="selList.length || (filterN && !filterGroupId)" class="ccic add" :title="'将当前' + (selList.length ? ('选中的 ' + selList.length) : ('筛选的 ' + filterN)) + ' 颗卫星加入本组（去重追加）'" @click.stop="addSelToGroup(g)"><Icon name="plus" :size="12" /></span>
                <span v-if="selList.length && filterGroupId === g.id" class="ccic del" :title="'将选中的 ' + selList.length + ' 颗从本组移出'" @click.stop="removeSelFromGroup(g)"><Icon name="minus" :size="12" /></span>
                <span class="ccic" title="管理成员：搜索添加 / 逐颗移出（无需先在地图上显示）" @click.stop="openSatGrpMgr(g)"><Icon name="sliders-horizontal" :size="12" /></span>
                <span class="ccic" title="重命名" @click.stop="satGrpEnterRename(g)"><Icon name="pencil" :size="12" /></span>
                <span class="ccic del" :class="{ warn: satGrpDelId === g.id }" :title="satGrpDelId === g.id ? '再次点击确认删除' : '删除该组'" @click.stop="satGrpDelete(g)"><Icon name="trash" :size="12" /></span>
                <span v-if="g.color" class="pgrst" title="恢复默认星点色" @click.stop="satGrpResetColor(g)"><Icon name="x" :size="12" /></span>
                <label class="pgclr" :title="'星点颜色（' + (g.color || '未设置，随所属星座') + '）'" @click.stop>
                  <span class="pgsw" :class="{ unset: !g.color }" :style="g.color ? { background: g.color } : null"></span>
                  <input type="color" :value="g.color || DEFAULT_SAT_HEX" @input="e => satGrpSetColor(g, e.target.value)" />
                </label>
              </template>
            </div>
            <SatList
              v-if="expTag === 's:' + g.id"
              :items="expList" :reset-key="expTag" :actions="expActions" :rows="14"
              :placeholder="'在「' + g.name + '」里筛选'" empty="该组还没有卫星。"
              @action="expOnAction" @activate="expLocate"
            />
            </template>
          </div>
          <!-- 自定义星座（仿 STK Walker 生成器）：星点 + 轨道圈叠加显示 -->
          <div class="ccsec">
            <div class="cchd"><span>自定义星座</span><span class="lnk" @click="openConstWizard()"><Icon name="plus" :size="12" /> 生成</span></div>
            <div class="ccep" title="全部自定义星座共用的「场景历元」。星座定向以此为准；拖时间轴仍从此历元向后推演。默认取电脑当天 08:00，每天自动更新；当天若手动改过则当天以手动值为准（次日回到该日 08:00）。RAAN 仍是惯性升交点赤经，与真实 TLE 同参考。">
              <label>场景历元</label>
              <input class="ci" type="datetime-local" v-model="scenarioEpochLocal" />
              <span class="lnk" title="取当前时刻为场景历元" @click="scenarioEpochNow">当前</span>
            </div>
            <div v-if="!customList.length" class="cctip">还没有自定义星座。</div>
            <template v-for="c in customList" :key="c.id">
            <div class="ccrow" :class="{ off: c.visible === false, sel: c.id === soloConst, exp: expTag === 'c:' + c.id }" title="点击单独显示该星座" @click="showConstAlone(c)" @contextmenu.prevent.stop="openRowMenu($event, 'cc', c)">
              <span class="pgex" :title="expTag === 'c:' + c.id ? '收起卫星列表' : '展开卫星列表'" @click.stop="expToggle('c:' + c.id, c.name)"><Icon :name="expTag === 'c:' + c.id ? 'chevron-down' : 'chevron-right'" :size="12" /></span>
              <span class="ccdot" :style="{ background: c.color }"></span>
              <span class="ccnm" :title="c.name" data-i18n-skip>{{ c.name }}</span>
              <span class="cccode">{{ ccCode(c) }}</span>
              <span class="ccic" :title="c.visible === false ? '显示' : '隐藏'" @click.stop="customConst.toggle(c.id)"><Icon :name="c.visible === false ? 'eye-off' : 'eye'" :size="12" /></span>
              <span class="ccic" title="编辑" @click.stop="openConstWizard(c)"><Icon name="pencil" :size="12" /></span>
              <span class="ccic del" title="删除" @click.stop="removeConst(c)"><Icon name="trash" :size="12" /></span>
            </div>
            <SatList
              v-if="expTag === 'c:' + c.id"
              :items="expList" :reset-key="expTag" :actions="expActions" :rows="14"
              :placeholder="'在「' + c.name + '」里筛选'"
              @action="expOnAction" @activate="expLocate"
            />
            </template>
          </div>
          <!-- 「加入组」弹出菜单：锚在列表操作条按钮下沿；点遮罩关闭 -->
          <template v-if="expMenu">
            <div class="lmenu-bd" @mousedown="expMenu = null" @contextmenu.prevent="expMenu = null"></div>
            <div class="lmenu" :style="{ left: expMenu.x + 'px', top: expMenu.y + 'px' }">
              <div class="lmh">加入 {{ expMenu.sats.length }} 颗</div>
              <div class="lmi new" @click="expMenuNew"><Icon name="folder-plus" :size="12" /><span>新建组</span></div>
              <div v-for="g in satGroups.list.value" :key="g.id" class="lmi" :title="g.name" @click="expMenuTo(g)"><Icon name="layers" :size="12" /><span data-i18n-skip>{{ g.name }}</span><em>{{ g.sats.length }}</em></div>
            </div>
          </template>

          <!-- 行右键菜单：内置星座 / 卫星组 / 自定义星座三类行共用一套，按 kind 出不同条目 -->
          <template v-if="rowMenu">
            <div class="lmenu-bd" @mousedown="closeRowMenu" @contextmenu.prevent="closeRowMenu"></div>
            <div ref="rowMenuEl" class="rmenu" :style="{ left: rowMenu.x + 'px', top: rowMenu.y + 'px' }">
              <div class="rmh"><span>{{ rowMenuName(rowMenu) }}</span><em v-if="rowMenuCount != null">{{ rowMenuCount }} 颗</em></div>
              <div class="rmi" :class="{ dis: !rowMenuHasSats }" @click="rowMenuHasSats && rowMenuFocus()"><Icon name="crosshair" :size="12" /><span>聚焦</span></div>
              <div class="rmi" @click="rowMenuShow">
                <Icon name="eye" :size="12" />
                <span v-if="rowMenu.kind === 'sg'">{{ filterGroupId === rowMenu.obj.id ? '退出显示' : '显示该组' }}</span>
                <span v-else-if="rowMenu.kind === 'cc'">单独显示</span>
                <span v-else>显示该星座</span>
              </div>
              <div v-if="rowMenu.kind === 'cc'" class="rmi" @click="rowMenuToggleVis"><Icon :name="rowMenu.obj.visible === false ? 'eye-off' : 'eye'" :size="12" /><span>{{ rowMenu.obj.visible === false ? '取消隐藏' : '隐藏' }}</span></div>
              <div v-if="rowMenuHasSats" class="rmi" @click="rowMenuExpand"><Icon :name="expTag === rowMenuTag(rowMenu) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>{{ expTag === rowMenuTag(rowMenu) ? '收起卫星列表' : '展开卫星列表' }}</span></div>
              <div class="rms"></div>
              <div v-if="rowMenu.kind === 'cc'" class="rmi" @click="rowMenuCopyConst"><Icon name="copy" :size="12" /><span>复制星座</span></div>
              <div class="rmi" :class="{ dis: !rowMenuHasSats }" @click="rowMenuHasSats && rowMenuCopySats()"><Icon name="copy" :size="12" /><span>复制卫星</span></div>
              <div class="rmi" :class="{ dis: !satClip }" @click="satClip && rowMenuPaste()">
                <Icon name="clipboard" :size="12" />
                <span v-if="rowMenu.kind === 'sg'">粘贴（加入本组）</span>
                <span v-else-if="rowMenu.kind === 'cc'">粘贴{{ satClip && satClip.cfg ? '星座副本' : '为新卫星组' }}</span>
                <span v-else>粘贴为新卫星组</span>
                <em v-if="satClip">{{ satClip.label }}</em>
              </div>
              <div v-if="rowMenu.kind !== 'grp'" class="rmi" @click="rowMenuDup"><Icon name="copy" :size="12" /><span>创建副本</span></div>
              <div v-if="rowMenu.kind !== 'sg'" class="rmi" :class="{ dis: !rowMenuHasSats }" @click="rowMenuHasSats && rowMenuSaveGroup()"><Icon name="folder-plus" :size="12" /><span>存为卫星组</span></div>
              <div v-if="rowMenu.kind === 'sg' && selList.length" class="rmi" @click="rowMenuAddSel"><Icon name="plus" :size="12" /><span>加入选中的 {{ selList.length }} 颗</span></div>
              <!-- 内置星座行下面这段常常整段没有条目（只有配过色才出一条）→ 分隔线跟着条件出，避免菜单尾巴上挂一条空线 -->
              <div v-if="rowMenu.kind !== 'grp' || (groupColorable(rowMenu.obj.key) && groupColors[rowMenu.obj.key])" class="rms"></div>
              <div v-if="rowMenu.kind === 'sg'" class="rmi" @click="rowMenuRename"><Icon name="pencil" :size="12" /><span>重命名</span></div>
              <div v-if="rowMenu.kind === 'sg'" class="rmi" @click="rowMenuManage"><Icon name="sliders-horizontal" :size="12" /><span>管理成员…</span></div>
              <div v-if="rowMenu.kind === 'cc'" class="rmi" @click="rowMenuEdit"><Icon name="pencil" :size="12" /><span>编辑…</span></div>
              <div v-if="rowMenu.kind === 'grp' && groupColorable(rowMenu.obj.key) && groupColors[rowMenu.obj.key]" class="rmi" @click="rowMenuResetColor"><Icon name="x" :size="12" /><span>恢复默认星点色</span></div>
              <div v-if="rowMenu.kind !== 'grp'" class="rmi del" :class="{ arm: rowMenuArm }" @click="rowMenuDelete"><Icon name="trash" :size="12" /><span>{{ rowMenuArm ? '再次点击确认删除' : '删除' }}</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('gxt-disp', false) }" @click="toggleSec('gxt-disp', false)"><Icon :name="isSecOpen('gxt-disp', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>显示选项</span></div>
          <template v-if="isSecOpen('gxt-disp', false)">
          <label class="chk2"><input type="checkbox" :checked="showBeamLabels" @change="toggleBeamLabels" /><span>显示波束名</span></label>
          <div v-if="showBeamLabels" class="srow"><label>字号</label><input class="rng" type="range" min="6" max="32" step="1" :value="beamLabelSize" @input="setBeamFont" /><span class="u">{{ beamLabelSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showBore" @change="toggleBore" /><span>显示波束中心</span></label>
          <div v-if="showBore" class="srow"><label>大小</label><input class="rng" type="range" min="1" max="12" step="1" :value="boreSize" @input="setBoreSize" /><span class="u">{{ boreSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showContourLabels" @change="toggleContourLabels" /><span>显示数值标签</span></label>
          <div v-if="showContourLabels" class="srow"><label>字号</label><input class="rng" type="range" min="2" max="20" step="1" :value="contourLabelSize" @input="setContourSize" /><span class="u">{{ contourLabelSize }}</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('poly-list') }" @click="toggleSec('poly-list')"><Icon :name="isSecOpen('poly-list') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>协调区多边形</span><span class="lnk" title="从标准 GXT / KML 文件导入多边形（追加到列表，不影响已有；可多选）" @click.stop="importPolys"><Icon name="import" :size="12" /> 导入</span><span class="lnk" style="margin-left:12px" @click.stop="polyStartDraw"><Icon name="plus" :size="12" /> 绘制</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('poly-disp', false) }" @click="toggleSec('poly-disp', false)"><Icon :name="isSecOpen('poly-disp', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>显示与操作</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('grd-tree') }" @click="toggleSec('grd-tree')"><Icon :name="isSecOpen('grd-tree') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>卫星 / 天线</span><span class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click.stop="openAddSat"><Icon name="plus" :size="12" /> 卫星</span><span class="lnk" title="只画等仰角线：填经纬度/轨道高度 + 仰角值即可，不建卫星图标/天线" @click.stop="openAddElevLine"><Icon name="plus" :size="12" /> 仰角线</span></div>
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
              <div v-else class="gsat" :class="{ exp: grd.isExpanded(sat.folder) }">
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
                <span class="gsname" @click="grd.toggleExpand(sat.folder)" :title="sat.satName">{{ sat.satName }}<em v-if="sat.antennas.length">{{ sat.antennas.length }}</em><i v-if="sat.elements" class="simtag" title="轨道根数模拟星：星下点随时间移动">轨</i></span>
                <!-- 显示开关（卫星名 / 仰角线）：图标按钮，色随该星颜色（在「✎」里改），与右侧操作图标以竖线分组 -->
                <span class="sdisp">
                  <span class="ic" :class="{ on: satVisible(sat) }" title="显示/隐藏该卫星（图标 + 名称）；如需只隐藏图标或只隐藏名称，在「卫星设置」里单独勾选" @click.stop="toggleSatLabel(sat)"><Icon :name="satVisible(sat) ? 'eye' : 'eye-off'" :size="12" /></span>
                  <span class="ic" :class="{ on: sat.elevShow }" :style="sat.elevShow ? { color: sat.elevColor } : {}" title="显示/隐藏等仰角线（需先在「✎」里填仰角值，如 5,10）" @click.stop="toggleSatElev(sat)"><Icon name="angle" :size="12" /></span>
                </span>
                <span class="sacts">
                  <span class="ic" title="导入 GRD：在该星下新建天线" @click.stop="grd.importGrd(sat)"><Icon name="plus" :size="12" /></span>
                  <span class="ic" title="编辑卫星 / 仰角线 / 颜色" @click.stop="editSat(sat)"><Icon name="pencil" :size="12" /></span>
                  <span class="ic del" title="删除卫星（含其天线）" @click.stop="removeSat(sat)"><Icon name="x" :size="12" /></span>
                </span>
              </div>
              <div v-if="sat.kind !== 'elevline' && grd.isExpanded(sat.folder)" class="gbody">
                <div v-if="!sat.antennas.length" class="gant noant">暂无天线。</div>
                <template v-for="a in sat.antennas" :key="a.name">
                <div class="gant" :class="{ on: grd.isSelected(sat.folder, a.name), foc: grd.isActive(sat.folder, a.name) }" title="点击编辑该天线参数（不影响是否显示）" @click="grd.setActive(sat, a)">
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
          </template>
        </div>

        <!-- 天线设置四区（波束/参数/电平/填充/指向/显示）＝ 与「对星覆盖分析」共用的同一个组件 -->
        <GrdSetSections :grd="grd" variant="ground" :sat-search="satcovSearch" />

        <div class="csfoot">
          <span v-if="grdLoading" class="cst">载入中…</span>
          <span class="cclr" title="清空地图上的填充/等值线/仰角线，保留各天线设置与卫星列表" @click="grdClearDrawing">清除绘图</span>
        </div>
        </div>
        </div>

        <!-- 对星覆盖分析：同一棵天线树，投影面从地球换成轨道壳层。面板整体在 SatCovPanel 里，
             对星性能指标表浮窗挂在页面根部。 -->
        <div v-show="shellUi.side === 'satcov'" class="sview">
          <SatCovPanel
            v-if="shellUi.side === 'satcov'"
            :sc="satcov" :grd="grd" :sat-count="shownCount" :sat-search="satcovSearch"
            :table-open="satcovTableOpen" :sat-vis="satVisible"
            @open-table="satcovOpenTable" @pick-shells="satcovOpenPick" @toggle-eye="toggleSatLabel"
            @add-sat="openAddSat()" @edit-sat="editSat" @remove-sat="removeSat" />
        </div>

        <!-- 波束合成（独立视图，SATSOFT 同款）：导航器（卫星 ▸ 波束组） ＋ 检查器（选中组/设置的编辑器）。
             一组＝一根天线，挂到该卫星下由「对地覆盖分析」视图管理显示/电平/指向/导出（工具 → 产物）。 -->
        <div v-show="shellUi.side === 'beams'" class="sview">
        <div v-if="shellUi.side === 'beams'" class="cov-side bs-side docked">

        <!-- ===== 导航器：卫星 + 波束组列表 ===== -->
        <div class="sec">
          <div class="srow"><label>卫星</label>
            <select :value="bs.satFolder.value" title="卫星来自「对地覆盖分析」视图" @change="e => bsSetSat(e.target.value)">
              <option v-if="!grdSats.length" value="">（暂无卫星）</option>
              <option v-for="st in grdSats" :key="st.folder" :value="st.folder">{{ st.satName }}</option>
            </select>
          </div>
          <div v-if="bs.satPos()" class="tip">星下点 {{ fmtGeoSlot(bs.satPos().lon) }}{{ Math.abs(bs.satPos().lat || 0) > 0.05 ? ', ' + bs.satPos().lat.toFixed(2) + '°N' : '' }} · 高度 {{ Math.round(bs.satPos().altKm).toLocaleString() }} km</div>
          <div class="bs-grps">
            <div v-for="g in bs.groupsForSat.value" :key="g.id" class="bs-grow" :class="{ on: g.id === bs.activeGroupId.value, hid: !g.pinned && g.id !== bs.activeGroupId.value }" @click="bs.selectGroup(g.id)">
              <span class="bs-gk" :class="g.mode">{{ g.mode === 'pam' ? '相控阵' : g.mode === 'gauss' ? '多馈源' : '赋形' }}</span>
              <span class="bs-gname" :title="g.name" data-i18n-skip>{{ g.name }}</span>
              <span class="bs-gcnt">{{ bs.groupStat(g).n }}{{ bs.groupStat(g).unit }}</span>
              <span class="gic" :title="g.pinned ? '取消常显（切换到其它组编辑时自动隐藏本组草图）' : (g.id === bs.activeGroupId.value ? '常显本组（切换到其它组编辑后仍保留显示，用于比对）' : '仅显示编辑中的组；点击常显本组草图以便和其它组比对')" @click.stop="bs.toggleGroupVisible(g.id)"><Icon :name="(g.pinned || g.id === bs.activeGroupId.value) ? 'eye' : 'eye-off'" :size="12" /></span>
              <span class="gic" title="复制该组" @click.stop="bs.duplicateGroup(g.id)"><Icon name="copy" :size="12" /></span>
              <span class="gic del" title="删除该组（不影响已生成的天线）" @click.stop="bsRemoveGroup(g)"><Icon name="x" :size="12" /></span>
            </div>
            <div v-if="!bs.groupsForSat.value.length" class="bs-empty">还没有波束组。</div>
          </div>
          <div class="bs-addrow">
            <span class="opb" :class="{ dis: !grdSats.length }" title="新建多馈源反射面（点/椭圆波束群；一组内可多设置混合宽度，如 0.8+0.9+1.6°）" @click="bsAddGroup('gauss')">＋多馈源组</span>
            <span class="opb" :class="{ dis: !grdSats.length }" title="新建赋形反射面（Polygon 覆盖区并集，馈源阵赋形合成）" @click="bsAddGroup('shaped')">＋赋形组</span>
            <span class="opb" :class="{ dis: !grdSats.length }" title="新建相控阵（SATSOFT §6.5 PAM：矩形阵 + Butler 矩阵，sinc 波束群，可电扫到任意指向）" @click="bsAddGroup('pam')">＋相控阵组</span>
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
          <div class="sect"><span>{{ bs.mode.value === 'pam' ? '相控阵' : bs.mode.value === 'gauss' ? '多馈源反射面' : '赋形反射面' }}</span></div>
          <div class="srow"><label>组名</label><input class="ci wide" :value="bsNameVal()" @input="bsNameEdit = $event.target.value" @change="bsNameCommit" @blur="bsNameCommit"
                 placeholder="天线名（同名再生成即更新；同星不可重名）" /></div>
        </div>

        <!-- 波束设置（波束类型选择器，上提）：每个设置 = 一种波束类型（= 一套独立反射面）；下面「天线参数」编辑当前设置的反射面 -->
        <div v-if="bs.mode.value === 'gauss'" class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('bs-settings') }" @click="toggleSec('bs-settings')"><Icon :name="isSecOpen('bs-settings') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>波束设置</span><span class="bs-cnt">{{ bs.settings.value.length }} 种波束</span></div>
          <template v-if="isSecOpen('bs-settings')">
          <div class="bs-chips">
            <span v-for="s in bs.settings.value" :key="s.id" class="bs-chip" :class="{ on: s.id === bs.activeSettingId.value }" :title="'激活并按此波束类型放置：' + s.name" @click="bs.selectSetting(s.id)"><i :style="{ background: s.color }"></i>{{ s.name }}<em>{{ Number(s.thX).toFixed(2) }}°</em></span>
            <span class="bs-chip add" title="新增一种波束类型（复制当前反射面，再改口径/馈源做出不同波束宽）" @click="bs.addSetting()">＋</span>
          </div>
          <template v-if="bs.curSetting.value">
            <div class="srow"><label>设置名</label><input class="ci" :value="bs.curSetting.value.name" @input="e => bs.renameSetting(bs.curSetting.value.id, e.target.value)" /><input class="clr" type="color" :value="bs.curSetting.value.color" title="该波束类型轮廓/中心点颜色" @input="e => bsSetSettingColor(e.target.value)" /><span class="opb sm" :class="{ dis: bs.settings.value.length <= 1 }" title="删除本波束类型" @click="bs.removeSetting(bs.curSetting.value.id)">删除</span></div>
          </template>
          </template>
        </div>

        <!-- 天线参数 = 当前波束设置的反射面（每设置一套独立反射面） -->
        <div v-if="bs.mode.value === 'gauss' && bs.curSetting.value" class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('bs-antp') }" @click="toggleSec('bs-antp')"><Icon :name="isSecOpen('bs-antp') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>天线参数</span><span class="bs-cnt">{{ bs.curSetting.value.name }} · 解析反射面</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('bs-pam') }" @click="toggleSec('bs-pam')"><Icon :name="isSecOpen('bs-pam') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>天线参数</span><span class="bs-cnt">相控阵 · Butler 矩阵</span></div>
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

        <!-- —— 放置波束 → 轮廓编号 / 频率计划（高斯 + 相控阵点波束群共用；后两者折叠） —— -->
        <template v-if="bs.mode.value === 'gauss' || (bs.mode.value === 'pam' && bs.p.pamCover !== 'shaped')">
          <div class="sec">
            <div class="sect acc" :class="{ open: isSecOpen('bs-place') }" @click="toggleSec('bs-place')"><Icon :name="isSecOpen('bs-place') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>放置波束</span><span class="bs-cnt">{{ bs.beams.value.length }} 个{{ bs.curSetting.value ? ' · 设置 ' + bs.curSetting.value.name : '' }}</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-style', false) }" @click="toggleSec('bs-style', false)"><Icon :name="isSecOpen('bs-style', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轮廓与编号</span></div>
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
                <div class="srow"><label>编号颜色</label><input class="clr" type="color" v-model="bs.p.skNumColor" /></div>
              </template>
            </template>
          </div>

          <!-- 频率计划（折叠） -->
          <div class="sec">
            <div class="sect acc" :class="{ open: isSecOpen('bs-freq', false) }" @click="toggleSec('bs-freq', false)"><Icon :name="isSecOpen('bs-freq', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>频率计划</span><span v-if="bs.fcStats.value.length" class="bs-cnt">{{ bs.fcStats.value.reduce((s, x) => s + x.count, 0) }} 已配色</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-pcov') }" @click="toggleSec('bs-pcov')"><Icon :name="isSecOpen('bs-pcov') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>覆盖区域</span><span v-if="bs.p.polyIds.length" class="bs-cnt">{{ bs.p.polyIds.length }} 个</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-st') }" @click="toggleSec('bs-st')"><Icon :name="isSecOpen('bs-st') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>站点栅</span><span v-if="bs.stInfo.value" class="bs-cnt">{{ bs.stInfo.value.over ? '约 ' + bs.stInfo.value.over + ' 站 · 超上限' : (bs.stInfo.value.counts.c0 + bs.stInfo.value.counts.c1) + ' 站' }}</span></div>
            <template v-if="isSecOpen('bs-st')">
            <div class="srow"><label>显示</label>
              <label class="chk-in" title="在地图上显示站点栅（优化目标点阵）"><input type="checkbox" :checked="bs.p.stShow !== false" @change="bs.p.stShow = $event.target.checked" /><span>站点</span></label>
              <label class="chk-in" title="在站点上标注序号（SATSOFT Plot Station Number）"><input type="checkbox" :checked="bs.p.stNum === true" @change="bs.p.stNum = $event.target.checked" /><span>编号</span></label>
              <label class="chk-in" title="在偏置站上标注 ±dB 数值（默认关：偏置站只靠颜色区分，绿=抬高、紫=压低）"><input type="checkbox" :checked="bs.p.stGNum === true" @change="bs.p.stGNum = $event.target.checked" /><span>数值</span></label>
            </div>
            <div class="srow"><label>数字大小</label><input class="ci" type="number" step="1" min="5" max="24" v-model.number="bs.p.stNumSize" title="站点数字字号（px）：编号与偏置数值共用" /><span class="u">px</span></div>
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
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=累加选择；点击站点=选中该站、Ctrl+点=增减选；点空处=清选；再点本钮退出）" @click="bs.toggleStEdit()"><Icon name="crosshair" :size="12" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="12" /> 加站</span>
              <span class="opb sm" title="清空选中" @click="bs.clearStSel()">清选</span>
              <span class="opb sm" title="清除全部站点修正与手工站（回到自动站点栅）" @click="bs.resetStations()">重置</span>
            </div>
            <template v-if="bs.stSel.value.size">
            <div class="bs-strow">
              <span class="opb sm" title="选中站点还原为 Contour（抬到目标；保留目标偏置）" @click="bs.applyStType('cov')">Contour</span>
              <span class="opb sm" title="选中站点转抑制（Sidelobe：该处场强被压低）" @click="bs.applyStType('sup')">抑制</span>
              <span class="opb sm" title="选中站点排除（不参与优化，画为灰空心；手工站=直接删除）" @click="bs.applyStType('ex')">排除</span>
            </div>
            <div class="srow"><label>目标偏置</label><input class="ci" type="number" step="0.5" v-model.number="bsStGoal" title="对选中站点的目标偏置（dB，叠加在该处区域目标上）：正=局部抬高、负=压低、0=清除偏置。目标只看相对权重（SATSOFT §10.2）" /><span class="u">dB</span><span class="opb sm" @click="bs.applyStGoal(Number(bsStGoal) || 0)">应用</span></div>
            </template>
            <div v-if="bs.stSel.value.size || (bs.p.stOv || []).length || (bs.p.stAdd || []).length" class="bs-read"><span>选中 <b>{{ bs.stSel.value.size }}</b></span><span>修正 <b>{{ (bs.p.stOv || []).length }}</b></span><span>手工 <b>{{ (bs.p.stAdd || []).length }}</b></span><span v-if="bs.stSelOne.value"><template v-if="bs.stSelOne.value.add">手工 </template>{{ bs.stSelOne.value.type === 'sup' ? '抑制' : bs.stSelOne.value.type === 'ex' ? '排除' : 'Contour' }}<b v-if="bs.stSelOne.value.g"> {{ (bs.stSelOne.value.g > 0 ? '+' : '') + bs.stSelOne.value.g }} dB</b></span></div>
            </template>
          </div>

          <!-- 星上激励指令表（测控上注）：生成后可见 -->
          <div class="sec" v-if="bsPamExcitShown">
            <div class="sect acc" :class="{ open: isSecOpen('bs-excit') }" @click="toggleSec('bs-excit')"><Icon :name="isSecOpen('bs-excit') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>星上激励指令</span><span class="bs-cnt">{{ bsPamExcitShown.rows.length }} 端口</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-refl') }" @click="toggleSec('bs-refl')"><Icon :name="isSecOpen('bs-refl') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>反射面模型</span><span class="bs-cnt">单偏置反射面</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-cov') }" @click="toggleSec('bs-cov')"><Icon :name="isSecOpen('bs-cov') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>覆盖区域</span><span v-if="bs.p.polyIds.length" class="bs-cnt">{{ bs.p.polyIds.length }} 个</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('bs-st') }" @click="toggleSec('bs-st')"><Icon :name="isSecOpen('bs-st') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>站点栅</span><span v-if="bs.stInfo.value" class="bs-cnt">{{ bs.stInfo.value.over ? '约 ' + bs.stInfo.value.over + ' 站 · 超上限' : (bs.stInfo.value.counts.c0 + bs.stInfo.value.counts.c1) + ' 站' }}</span></div>
            <template v-if="isSecOpen('bs-st')">
            <div class="srow"><label>显示</label>
              <label class="chk-in" title="在地图上显示站点栅（优化目标点阵）"><input type="checkbox" :checked="bs.p.stShow !== false" @change="bs.p.stShow = $event.target.checked" /><span>站点</span></label>
              <label class="chk-in" title="在站点上标注序号（SATSOFT Plot Station Number）"><input type="checkbox" :checked="bs.p.stNum === true" @change="bs.p.stNum = $event.target.checked" /><span>编号</span></label>
              <label class="chk-in" title="在偏置站上标注 ±dB 数值（默认关：偏置站只靠颜色区分，绿=抬高、紫=压低）"><input type="checkbox" :checked="bs.p.stGNum === true" @change="bs.p.stGNum = $event.target.checked" /><span>数值</span></label>
            </div>
            <div class="srow"><label>数字大小</label><input class="ci" type="number" step="1" min="5" max="24" v-model.number="bs.p.stNumSize" title="站点数字字号（px）：编号与偏置数值共用" /><span class="u">px</span></div>
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
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=累加选择；点击站点=选中该站、Ctrl+点=增减选；点空处=清选；再点本钮退出）" @click="bs.toggleStEdit()"><Icon name="crosshair" :size="12" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="12" /> 加站</span>
              <span class="opb sm" title="清空选中" @click="bs.clearStSel()">清选</span>
              <span class="opb sm" title="清除全部站点修正与手工站（回到自动站点栅）" @click="bs.resetStations()">重置</span>
            </div>
            <template v-if="bs.stSel.value.size">
            <div class="bs-strow">
              <span class="opb sm" title="选中站点还原为 Contour（抬到目标；保留目标偏置）" @click="bs.applyStType('cov')">Contour</span>
              <span class="opb sm" title="选中站点转抑制（Sidelobe：该处场强被压低）" @click="bs.applyStType('sup')">抑制</span>
              <span class="opb sm" title="选中站点排除（不参与优化，画为灰空心；手工站=直接删除）" @click="bs.applyStType('ex')">排除</span>
            </div>
            <div class="srow"><label>目标偏置</label><input class="ci" type="number" step="0.5" v-model.number="bsStGoal" title="对选中站点的目标偏置（dB，叠加在该处区域目标上）：正=局部抬高、负=压低、0=清除偏置。目标只看相对权重（SATSOFT §10.2）" /><span class="u">dB</span><span class="opb sm" @click="bs.applyStGoal(Number(bsStGoal) || 0)">应用</span></div>
            </template>
            <div v-if="bs.stSel.value.size || (bs.p.stOv || []).length || (bs.p.stAdd || []).length" class="bs-read"><span>选中 <b>{{ bs.stSel.value.size }}</b></span><span>修正 <b>{{ (bs.p.stOv || []).length }}</b></span><span>手工 <b>{{ (bs.p.stAdd || []).length }}</b></span><span v-if="bs.stSelOne.value"><template v-if="bs.stSelOne.value.add">手工 </template>{{ bs.stSelOne.value.type === 'sup' ? '抑制' : bs.stSelOne.value.type === 'ex' ? '排除' : 'Contour' }}<b v-if="bs.stSelOne.value.g"> {{ (bs.stSelOne.value.g > 0 ? '+' : '') + bs.stSelOne.value.g }} dB</b></span></div>
            </template>
          </div>

        </template>

        <div class="sec">
          <div class="sect"><span>生成天线</span></div>
          <span class="bs-gen" title="按本组草图计算方向图（GRD），在所选卫星下生成/更新此组天线" @click="bsGenerate"><Icon name="check" :size="12" /> 生成 / 更新此组</span>
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
            <div class="sect"><span>分析目标</span></div>
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
                  <option v-for="p in points" :key="p.id" :value="'point|' + p.id">{{ fmtLL(p.lat, p.lon) }}</option>
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
            <div class="sect"><span>{{ vis.mode.value === 'coverage' ? '覆盖网格' : '可见卫星' }}</span><span class="vis-cnt on" :title="visCnt.title">{{ visCnt.text }}</span></div>
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
                    <span class="vis-tzseg"><i :class="{ on: vis.accessTz.value !== 'utc' }" title="本地时区" data-i18n-skip @click="vis.accessTz.value = 'local'">{{ visTzTag() }}</i><i :class="{ on: vis.accessTz.value === 'utc' }" data-i18n-skip @click="vis.accessTz.value = 'utc'">UTC</i></span>
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
            <div class="sect acc" :class="{ open: isSecOpen('env-src') }" @click="toggleSec('env-src')"><Icon :name="isSecOpen('env-src') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>数据场</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('env-style') }" @click="toggleSec('env-style')"><Icon :name="isSecOpen('env-style') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>配色与值域</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('env-contour', false) }" @click="toggleSec('env-contour', false)"><Icon :name="isSecOpen('env-contour', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>等值线</span></div>
            <template v-if="isSecOpen('env-contour', false)">
              <label class="chk2"><input type="checkbox" v-model="env.contourOn.value" /><span>画等值线</span></label>
              <template v-if="env.contourOn.value">
                <div class="srow"><label>级差</label><input class="ci cov-num" type="number" min="0" step="any" :placeholder="env.field.value && env.field.value.contourStep ? String(env.field.value.contourStep) : '自动'" :value="env.contourStep.value" @input="e => env.contourStep.value = e.target.value" /><span class="u">{{ env.field.value ? env.field.value.unit : '' }}</span></div>
                <label class="chk2"><input type="checkbox" v-model="env.contourLabel.value" /><span>沿线标数值（仅平面图）</span></label>
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
            <div class="sect acc" :class="{ open: isSecOpen('lv-fetch') }" @click="toggleSec('lv-fetch')"><Icon :name="isSecOpen('lv-fetch') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>数据获取</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('lv-link') }" @click="toggleSec('lv-link')"><Icon :name="isSecOpen('lv-link') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>链路参数</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('lv-src') }" @click="toggleSec('lv-src')"><Icon :name="isSecOpen('lv-src') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>数据场</span></div>
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
            <div class="sect acc" :class="{ open: isSecOpen('lv-style') }" @click="toggleSec('lv-style')"><Icon :name="isSecOpen('lv-style') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>配色与值域</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('foc-orb') }" @click="toggleSec('foc-orb')"><Icon :name="isSecOpen('foc-orb') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轨道线</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('orb')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.orbOn }" role="switch" :aria-checked="focusStyle.orbOn ? 'true' : 'false'" :title="focusStyle.orbOn ? '隐藏轨道线' : '显示轨道线'" @click.stop="toggleFocus('orbOn')"><i></i></button></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('foc-trk') }" @click="toggleSec('foc-trk')"><Icon :name="isSecOpen('foc-trk') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>星下点轨迹</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('trk')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.trkOn }" role="switch" :aria-checked="focusStyle.trkOn ? 'true' : 'false'" :title="focusStyle.trkOn ? '隐藏星下点轨迹' : '显示星下点轨迹'" @click.stop="toggleFocus('trkOn')"><i></i></button></div>
          <template v-if="isSecOpen('foc-trk')">
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="focusStyle.trkColor" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkColor }}</span></div>
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="focusStyle.trkWidth" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>透明度</label><input class="rng" type="range" min="0.05" max="1" step="0.05" v-model.number="focusStyle.trkOpacity" @input="applyFocusStyle" /><span class="u">{{ focusStyle.trkOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>线型</label>
            <span class="seg nseg" role="group" aria-label="星下点轨迹线型">
              <span v-for="d in DASH_OPTS" :key="d.k" class="sg" :class="{ on: focusStyle.trkDash === d.k }" @click="setFocusVal('trkDash', d.k)">{{ d.label }}</span>
            </span>
          </div>
          <div class="srow" title="从当前时刻起画几个轨道周期的星下点轨迹（0.25 圈起，可到 10 圈）"><label>轨迹圈数</label><input class="rng" type="range" min="0.25" max="10" step="0.25" v-model.number="focusStyle.trkPeriods" @input="applyFocusGeom" /><span class="u">{{ +focusStyle.trkPeriods.toFixed(2) }}</span></div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !focusStyle.fpOn }">
          <div class="sect acc" :class="{ open: isSecOpen('foc-fp') }" @click="toggleSec('foc-fp')"><Icon :name="isSecOpen('foc-fp') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>覆盖圈</span><span class="lnk" title="本节恢复出厂样式（不动口径）" @click.stop="resetFocusPart('fp')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.fpOn }" role="switch" :aria-checked="focusStyle.fpOn ? 'true' : 'false'" :title="focusStyle.fpOn ? '隐藏覆盖圈' : '显示覆盖圈'" @click.stop="toggleFocus('fpOn')"><i></i></button></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('foc-cone', false) }" @click="toggleSec('foc-cone', false)" title="卫星本体到覆盖圈边界的锥体（锥面＋母线），张角随上面的口径走；仅 3D 球体绘制"><Icon :name="isSecOpen('foc-cone', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>覆盖锥</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('cone')">默认</span><button type="button" class="layersw sect-layersw" :class="{ on: focusStyle.coneOn }" role="switch" :aria-checked="focusStyle.coneOn ? 'true' : 'false'" :title="focusStyle.coneOn ? '隐藏覆盖锥' : '显示覆盖锥'" @click.stop="toggleFocus('coneOn')"><i></i></button></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('foc-mk', false) }" @click="toggleSec('foc-mk', false)"><Icon :name="isSecOpen('foc-mk', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>卫星标记</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetFocusPart('mk')">默认</span></div>
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

        <!-- 地图设置：海陆配色 / 国界省界市界 / 名称标注 -->
        <div v-show="shellUi.side === 'geo'" class="sview">
        <div class="cov-side geo-side docked">
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-img', false) }" @click="toggleSec('geo-img', false)"><Icon :name="isSecOpen('geo-img', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>影像底图</span><button type="button" class="layersw sect-layersw" :class="{ on: imageryOn }" role="switch" :aria-checked="imageryOn ? 'true' : 'false'" :title="imageryOn ? '关闭影像底图，回到矢量海陆配色' : '开启影像底图（真彩卫星影像，2D / 3D 同步）'" @click.stop="toggleImagery"><i></i></button></div>
          <template v-if="isSecOpen('geo-img', false)">
          <div class="srow stack"><label>分辨率</label>
            <span class="seg nseg" role="group" aria-label="影像分辨率">
              <span v-for="im in IMAGERY_SOURCES" :key="im.k" class="sg" :class="{ on: imageryKey === im.k }" :title="im.w + ' × ' + im.h + ' · ' + im.resKm + ' km/px · ' + im.credit + ' · VRAM ≈ ' + im.vramMB + ' MB'" @click="setImageryKey(im.k)">{{ im.zh }}</span>
            </span>
          </div>
          <div class="srow"><label>亮度</label><input class="rng" type="range" min="0.3" max="1.2" step="0.05" :value="imageryBright" title="压暗影像，让边界线与覆盖场看得清；100% 为原图" @input="setImageryBright" /><span class="u">{{ Math.round(imageryBright * 100) }}%</span></div>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-ocean') }" @click="toggleSec('geo-ocean')"><Icon :name="isSecOpen('geo-ocean') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>配色</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('geo-border', false) }" @click="toggleSec('geo-border', false)"><Icon :name="isSecOpen('geo-border', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>边界线</span><span class="lnk" title="本节恢复出厂样式" @click.stop="resetBorderAll">默认</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('geo-name', false) }" @click="toggleSec('geo-name', false)"><Icon :name="isSecOpen('geo-name', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>地名</span><span class="lnk" title="本节恢复出厂设置" @click.stop="resetNameAll">默认</span></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('geo-adm', false) }" @click="toggleSec('geo-adm', false)"><Icon :name="isSecOpen('geo-adm', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>行政区</span><button type="button" class="layersw sect-layersw" :class="{ on: showProvinces }" role="switch" :aria-checked="showProvinces ? 'true' : 'false'" :title="showProvinces ? '隐藏行政区界 / 名称' : '显示行政区界 / 名称'" @click.stop="toggleProvinces"><i></i></button></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('geo-chain', false) }" @click="toggleSec('geo-chain', false)"><Icon :name="isSecOpen('geo-chain', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>岛链</span><button type="button" class="layersw sect-layersw" :class="{ on: chainOn }" role="switch" :aria-checked="chainOn ? 'true' : 'false'" :title="chainOn ? '隐藏岛链' : '显示岛链'" @click.stop="toggleChains"><i></i></button></div>
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
          <div class="sect acc" :class="{ open: isSecOpen('geo-crs', false) }" @click="toggleSec('geo-crs', false)"><Icon :name="isSecOpen('geo-crs', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>坐标系</span><span class="lnk" title="本节恢复出厂设置" @click.stop="resetCrs">默认</span></div>
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
          <div class="srow"><label>画面中心</label><NumBox class="ci cov-b" :min="-180" :max="180" :step="0.5" :model-value="crsCenter" title="2D 平面图正中那条经线的经度（东正西负）；接缝随之落到它的对面。3D 球体没有接缝，不受影响" @commit="setCrsCenter" /><span class="u">{{ crsCenterTag }}</span></div>
          <div class="srow stack"><label>常用</label>
            <span class="seg nseg" role="group" aria-label="常用画面中心">
              <span v-for="c in CENTER_PRESETS" :key="c.v" class="sg" :class="{ on: Math.abs(crsCenter - c.v) < 0.25 }" @click="setCrsCenter(c.v)">{{ c.zh }}</span>
            </span>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-term', false) }" @click="toggleSec('geo-term', false)"><Icon :name="isSecOpen('geo-term', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>晨昏线（昼夜分界）</span><button type="button" class="layersw sect-layersw" :class="{ on: termOn }" role="switch" :aria-checked="termOn ? 'true' : 'false'" :title="termOn ? '隐藏晨昏线 / 夜区' : '显示晨昏线 / 夜区'" @click.stop="toggleTerm"><i></i></button></div>
          <template v-if="isSecOpen('geo-term', false)">
          <template v-if="termOn">
          <div class="swrow"><span>夜区遮罩</span><button type="button" class="layersw" :class="{ on: termNight }" role="switch" :aria-checked="termNight ? 'true' : 'false'" @click="toggleTermNight"><i></i></button></div>
          <div v-if="termNight" class="srow"><label>夜区颜色</label><input class="clr" type="color" v-model="termStyle.nightColor" @input="applyTerminator" /><span class="u">{{ termStyle.nightColor }}</span></div>
          <div v-if="termNight" class="srow"><label>夜区透明度</label><input class="rng" type="range" min="0" max="0.85" step="0.02" v-model.number="termStyle.nightOpacity" @input="applyTerminator" /><span class="u">{{ termStyle.nightOpacity.toFixed(2) }}</span></div>
          <div class="swrow"><span>分界线</span><button type="button" class="layersw" :class="{ on: termLine }" role="switch" :aria-checked="termLine ? 'true' : 'false'" @click="toggleTermLine"><i></i></button></div>
          <div v-if="termLine" class="srow"><label>线颜色</label><input class="clr" type="color" v-model="termStyle.lineColor" @input="applyTerminator" /><span class="u">{{ termStyle.lineColor }}</span></div>
          <div v-if="termLine" class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="4" step="0.1" v-model.number="termStyle.lineWidth" @input="applyTerminator" /><span class="u">{{ termStyle.lineWidth.toFixed(1) }}</span></div>
          <div v-if="termLine" class="srow"><label>线透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="termStyle.lineOpacity" @input="applyTerminator" /><span class="u">{{ termStyle.lineOpacity.toFixed(2) }}</span></div>
          <div class="tip">
            日下点 {{ termSub ? fmtSlot(termSub.lon) + ' · ' + Math.abs(termSub.lat).toFixed(2) + '°' + (termSub.lat >= 0 ? 'N' : 'S') : '—' }}。
          </div>
          </template>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-pov') }" @click="toggleSec('geo-pov')"><Icon :name="isSecOpen('geo-pov') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>地图视角</span></div>
          <template v-if="isSecOpen('geo-pov')">
          <div class="srow"><label>视角</label>
            <select :value="povCfg.id" title="底图的国界、陆地着色、点选与国名全部按该视角的归属表解算；「自定义」以中国视角为底再逐项覆写。台湾、香港、澳门恒属中国，不随视角变" @change="setPovId($event.target.value)">
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

        <!-- 标记：点标记 / 地球站 / 轨迹 -->
        <div v-show="shellUi.side === 'markers'" class="sview">
        <div class="cov-side mk-side docked">
        <div class="sec" :class="{ hid: !showPtLayer }">
          <div class="sect acc" :class="{ open: isSecOpen('mk-points') }" @click="toggleSec('mk-points')"><Icon :name="isSecOpen('mk-points') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>点标记</span><span class="lnk" title="打开点标记批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('points')">表格</span><span v-if="points.length" class="lnk" :class="{ on: mkEditId === 'points' }" :title="mkEditId === 'points' ? '完成，退出拖动' : '在平面图上拖动圆点调整点标记位置'" @click.stop="mkEditToggle('points')">{{ mkEditId === 'points' ? '完成调整' : '调整位置' }}</span><button type="button" class="layersw sect-layersw" :class="{ on: showPtLayer }" role="switch" :aria-checked="showPtLayer ? 'true' : 'false'" :title="showPtLayer ? '隐藏点标记（数据保留）' : '显示点标记'" @click.stop="togglePtLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-points')">
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <label class="chk2"><input type="checkbox" :checked="showPtLabel" @change="togglePtLabel" /><span>显示坐标</span></label>
          <div v-if="showPtLabel" class="srow"><label>坐标字号</label><input class="rng" type="range" min="1" max="32" step="1" :value="markPtFont" @input="setPtFont" /><span class="u">{{ markPtFont }}</span></div>
          <label class="chk2" title="点标记画成带序号的圈（圈 1、圈 2）；序号即下方列表与点标记表格的行号"><input type="checkbox" :checked="showPtIndex" @change="togglePtIndex" /><span>显示序号</span></label>
          <div v-if="showPtIndex" class="srow"><label>序号圈大小</label><input class="rng" type="range" min="1" max="40" step="1" :value="markPtIdx" @input="setPtIdx" /><span class="u">{{ markPtIdx }}</span></div>
          <div v-else class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="12" step="0.5" :value="markPtDot" @input="setPtDot" /><span class="u">{{ markPtDot }}</span></div>
          <div class="mlist">
            <div v-for="(p, i) in points" :key="p.id" class="mrow"><span class="mno">{{ i + 1 }}</span><span class="mc">{{ fmtLL(p.lat, p.lon) }}</span><span class="del" @click="removePoint(p.id)"><Icon name="x" :size="12" /></span></div>
          </div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !showStLayer }">
          <div class="sect acc" :class="{ open: isSecOpen('mk-stations') }" @click="toggleSec('mk-stations')"><Icon :name="isSecOpen('mk-stations') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>地球站</span><span class="lnk" title="打开地球站批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('stations')">表格</span><span v-if="stations.length" class="lnk" :class="{ on: mkEditId === 'stations' }" :title="mkEditId === 'stations' ? '完成，退出拖动' : '在平面图上拖动图标调整地球站位置'" @click.stop="mkEditToggle('stations')">{{ mkEditId === 'stations' ? '完成调整' : '调整位置' }}</span><button type="button" class="layersw sect-layersw" :class="{ on: showStLayer }" role="switch" :aria-checked="showStLayer ? 'true' : 'false'" :title="showStLayer ? '隐藏地球站（数据保留）' : '显示地球站'" @click.stop="toggleStLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-stations')">
          <div class="srow"><label>纬度</label><input class="ci" v-model="stLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="stLon" placeholder="-180 ~ 180" /></div>
          <div class="srow"><label>名称</label><input class="ci" v-model="stName" placeholder="如 北京站" /><span class="addb" @click="addStation">添加</span></div>
          <div class="srow"><label>图标大小</label><input class="rng" type="range" min="5" max="60" step="1" :value="stIconSize" @input="setStIcon" /><span class="u">{{ stIconSize }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="showStName" @change="toggleStName" /><span>显示名称</span></label>
          <div v-if="showStName" class="srow"><label>名称字号</label><input class="rng" type="range" min="1" max="32" step="1" :value="stFontSize" @input="setStFont" /><span class="u">{{ stFontSize }}</span></div>
          <div class="mlist">
            <div v-for="s in stations" :key="s.id" class="mrow">
              <input class="sni" :value="s.name" @input="e => setStationName(s.id, e.target.value)" />
              <span class="mc2">{{ fmtLL(s.lat, s.lon) }}</span><span class="del" @click="removeStation(s.id)"><Icon name="x" :size="12" /></span>
            </div>
          </div>
          </template>
        </div>

        <div class="sec" :class="{ hid: !showTrajLayer }">
          <div class="sect acc" :class="{ open: isSecOpen('mk-traj') }" @click="toggleSec('mk-traj')"><Icon :name="isSecOpen('mk-traj') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轨迹</span>
            <span class="lnk" title="打开航迹批量表格（Excel：逐航迹增删改航点 / 批量粘贴导入）" @click.stop="openMkTable('traj')">表格</span>
            <span class="lnk" @click.stop="newTraj('sea')">+航行</span>
            <span class="lnk" @click.stop="newTraj('flight')">+飞行</span>
          <button type="button" class="layersw sect-layersw" :class="{ on: showTrajLayer }" role="switch" :aria-checked="showTrajLayer ? 'true' : 'false'" :title="showTrajLayer ? '隐藏航迹（数据保留）' : '显示航迹'" @click.stop="toggleTrajLayer"><i></i></button></div>
          <template v-if="isSecOpen('mk-traj')">
          <label class="chk2" title="航迹头（末航点）上画一枚俯视矢量图标：航行＝船舶、飞行＝飞机，朝向取末段走向"><input type="checkbox" :checked="showTrajIcon" @change="toggleTrajIcon" /><span>显示图标</span></label>
          <div v-if="showTrajIcon" class="srow"><label>图标大小</label><input class="rng" type="range" min="1" max="60" step="1" :value="trajIconSize" @input="setTrajIcon" /><span class="u">{{ trajIconSize }}</span></div>
          <div class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="60" step="1" :value="trajDotSize" @input="setTrajDot" /><span class="u">{{ trajDotSize }}</span></div>
          <div v-for="t in trajectories" :key="t.id" class="tcard" :class="{ act: activeTraj === t.id }">
            <div class="trow">
              <span class="tk" :class="t.kind"></span>
              <input class="tni" :value="t.name" @input="e => setTrajName(t.id, e.target.value)" />
              <span class="tsel" :class="{ on: activeTraj === t.id }" @click="activeTraj = t.id">{{ activeTraj === t.id ? '编辑中' : '编辑' }}</span>
              <span v-if="t.pts.length" class="tsel" :class="{ on: mkEditId === t.id }" :title="mkEditId === t.id ? '完成，退出拖动' : '在平面图上拖动航点圆点调整位置'" @click="mkEditToggle(t.id)">{{ mkEditId === t.id ? '完成' : '调点' }}</span>
              <span class="del" @click="removeTraj(t.id)"><Icon name="x" :size="12" /></span>
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
    </div>

    <!-- 时间控制条：地图时间轴 + 实时徽标 + 覆盖圈定义（归属地图，置于地图正下方） -->
    <!-- 交互范式（YouTube LIVE / Cesium SYSTEM_CLOCK）：实时中时间轴与步进照常可用，操作即静默退出实时；徽标一键回实时 -->
    <div class="tl bottom">
      <div class="tl-grp">
        <span class="live-btn" :class="{ on: live }" :title="live ? '实时中（跟随系统时间）· 点击停在当前时刻' : '回到实时（跟随系统时间）'" @click="toggleLive"><span class="ldot"></span>实时</span>
        <!-- 跨度：与右侧「步长 / 倍速」同一种带栏名的旋钮。分段按钮换档就换宽度（"12h"→"24h"→自定义 "1d5h"），
             推着中间 flex:1 的尺子重排；窄容器下还得靠 container query 逐档藏预设（3d/7d 先没）。
             一个下拉宽度恒定，且任何宽度下六档全在。 -->
        <span class="clkg wspan" role="group" aria-label="时间窗跨度">
          <span class="ckl">跨度</span>
          <select class="cksel wsel" :value="windowMin" title="可见时间窗跨度（可回看过去 · 滚轮缩放）" @change="setWindow(Number($event.target.value))">
            <option v-for="w in WINDOW_PRESETS" :key="w.v" :value="w.v">{{ w.l }}</option>
            <option v-if="isCustomWindow" :value="windowMin">{{ customWinLabel }}</option>
          </select>
        </span>
      </div>
      <div class="tb-track" :class="{ kbf: trackKb }" ref="track" tabindex="0" role="slider" aria-label="仿真时间游标"
           :aria-valuemin="winStartMin" :aria-valuemax="winEndMin" :aria-valuenow="offMin" :aria-valuetext="timeParts.s"
           @pointerdown="trackDown" @wheel.prevent="onWheel" @keydown="onTrackKey" @pointermove="onHover" @pointerleave="onLeave"
           @focus="onTrackFocus" @blur="trackKb = false">
        <div class="tb-base"></div>
        <div v-for="(t, i) in ticks.minor" :key="'n' + i" class="tb-t min" :style="{ left: t.x + 'px' }"></div>
        <div v-for="(t, i) in ticks.major" :key="'j' + i" class="tb-t maj" :style="{ left: t.x + 'px' }"></div>
        <div v-for="(t, i) in ticks.labels" :key="'l' + i" class="tb-lab" :style="{ left: t.x + 'px', transform: t.align }">{{ t.label }}</div>
        <div v-if="nowInWin" class="tb-now" :style="{ left: nowPct + '%' }"><span class="tag">此刻</span></div>
        <div class="tb-ph" :class="{ lv: live }" :style="{ left: timePct + '%' }"><span class="hd"></span></div>
        <div v-show="hoverShow" class="tb-ghost" :style="{ left: hoverX + 'px' }"></div>
        <div v-show="hoverShow" class="tb-tip" :style="{ left: hoverX + 'px' }">{{ hoverLabel }}</div>
      </div>
      <div class="tl-grp">
        <span class="tlab2 tzsw" :title="tzMode === 'utc' ? '当前按 UTC 显示，点击切回本机时区 ' + localTzLabel + '（仅改显示；星位、晨昏线、过境窗口一律走 UTC 计算，与此开关无关）' : '当前按本机时区 ' + localTzLabel + ' 显示，点击切到 UTC（仅改显示；星位、晨昏线、过境窗口一律走 UTC 计算，与此开关无关）'" @click="toggleTz"><span class="t1">{{ timeParts.m }}</span><span class="t2"><span class="d">{{ timeParts.d }}</span><span class="o">{{ timeParts.o }}</span><span class="z">{{ timeParts.z }}</span></span></span>
        <!-- 仿真时钟走带：反向连播 / 步退 / 播放·暂停 / 步进 / 回到此刻 / 跳到时刻 -->
        <span class="stg" role="group" aria-label="仿真时钟">
          <span class="st tic" :class="{ act: clock.mode === 'play' && clock.dir < 0 }" title="反向播放" @click="togglePlay(-1)"><Icon name="rewind" :size="12" /></span>
          <span class="st tic" title="后退一个步长" @click="clockStepBy(-1)"><Icon name="step-back" :size="12" /></span>
          <span class="st tic play" :class="{ act: clock.mode === 'play' && clock.dir > 0 }" :title="clock.mode === 'play' ? '暂停' : '播放（空格）'" @click="togglePlay(1)"><Icon :name="clock.mode === 'play' ? 'pause' : 'play'" :size="12" /></span>
          <span class="st tic" title="前进一个步长" @click="clockStepBy(1)"><Icon name="step-forward" :size="12" /></span>
          <span class="st now" :class="{ dis: !live && atNow }" title="回到当前时刻" @click="resetTime">此刻</span>
          <span class="st tic" :class="{ act: gotoOpen }" title="跳到指定时刻" @click="openGoto"><Icon name="clock" :size="12" /></span>
        </span>
        <template v-if="gotoOpen">
          <div class="lmenu-bd" @mousedown="gotoOpen = false" @contextmenu.prevent="gotoOpen = false"></div>
          <div class="gotobox">
            <input class="ci" type="datetime-local" step="1" v-model="gotoVal" @keydown.enter="applyGoto" @keydown.esc="gotoOpen = false" />
            <span class="ptb" @click="applyGoto">跳转</span>
          </div>
        </template>
        <!-- 步长 + 倍速。两个旋钮各带栏名 —— 光一个「1s」和一个「×10」摆在那里看不出是什么。 -->
        <span class="clkg" role="group" aria-label="仿真步长与倍速">
          <span class="ckl">步长</span>
          <select class="cksel" :value="clock.stepSec" title="每拍推进的仿真时间" @change="setStepSec(Number($event.target.value))">
            <option v-for="s in STEP_PRESETS" :key="s" :value="s">{{ fmtStepShort(s) }}</option>
            <option v-if="!STEP_PRESETS.includes(clock.stepSec)" :value="clock.stepSec">{{ fmtStepShort(clock.stepSec) }}</option>
          </select>
          <span class="ckl">倍速</span>
          <select class="cksel" :value="clock.speed" title="仿真时间相对真实时间的倍数" @change="setSpeedVal(Number($event.target.value))">
            <option v-for="x in SPEED_PRESETS" :key="x" :value="x">×{{ fmtRate(x) }}</option>
            <option v-if="!SPEED_PRESETS.includes(clock.speed)" :value="clock.speed">{{ speedText }}</option>
          </select>
        </span>
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

            <div class="sdiv">仰角线（等仰角环 / 角度标注）</div>
            <div class="srow"><label>仰角值</label><input class="ci" v-model="satModal.els" placeholder="如 5,10,20（0=地平）" @change="applySatLive" @keyup.enter="applySatLive" /><span class="u">°</span></div>
            <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="satModal.elevWidth" @input="applySatLive" /><span class="u">{{ (satModal.elevWidth || 1.3).toFixed(1) }}</span></div>
            <div class="srow"><label>标注字号</label><input class="rng" type="range" min="1" max="35" step="1" v-model.number="satModal.elevLabelSize" @input="applySatLive" /><span class="u">{{ satModal.elevLabelSize || 18 }}</span></div>

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
          <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="elevModal.color" /></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="closeElevModal">取消</span><span class="save" @click="saveElevModal">保存</span></div>
      </div>
    </div>
    <!-- 星座生成/编辑器已内联到左侧「星座」侧栏（见 .cedit），不再用居中弹窗（可对着地图实时调整） -->
    <div v-if="satModal && satPick" class="sat-banner">
      点选模式：点击地图上的卫星填入位置{{ flatView ? '（平面图无星点，请切回球体或用搜索）' : '' }}
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
      :picks="[{ key: 'sat', label: '算哪颗星', options: miniSatOptions, default: miniSatDefault }]"
      :device-id="miniDeviceId"
      :configured="miniConfigured"
      key-hint="小程序「工具栏 → 卫星覆盖 → 导入」输入"
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

    <!-- 轨迹描绘横幅：有正在编辑的轨迹时显示；与 Polygon 同款：右键逐点 / 左键沿路径拖动连续加点 -->
    <div v-if="activeTraj" class="traj-banner">
      正在描绘{{ curTraj() && curTraj().kind === 'flight' ? '飞行' : '航行' }}轨迹 · 右键地图连续加点，或按住左键沿路径拖动连续加点
      <span class="lnk" @click="trajUndo">撤销上点</span>
      <span class="lnk" @click="endTraj">结束</span>
    </div>

    <!-- Polygon 绘制横幅：绘制中提示右键加顶点，「完成」闭合成多边形 -->
    <div v-if="polyDrawId" class="traj-banner">
      正在绘制 Polygon「{{ curPoly() ? curPoly().name : '' }}」 · 右键地图连续加顶点，或按住左键沿路径拖动连续加点（至少 3 点）
      <span class="lnk" @click="polyUndo">撤销上点</span>
      <span class="lnk" @click="polyDone">完成</span>
      <span class="lnk" @click="polyCancel">取消</span>
    </div>

    <!-- Polygon 调整顶点横幅：拖动地图上的顶点圆点调整位置 -->
    <div v-if="polyEditId" class="traj-banner">
      正在调整「{{ curEditPoly() ? curEditPoly().name : '' }}」顶点 · 在平面图上拖动圆点改位置
      <span class="lnk" @click="polyEditStop">完成</span>
    </div>

    <!-- Polygon 整体拖动横幅：按住多边形内部平移整个多边形 -->
    <div v-if="polyMoveId" class="traj-banner">
      正在整体拖动「{{ curMovePoly() ? curMovePoly().name : '' }}」 · 在平面图上按住多边形内部拖动
      <span class="lnk" @click="polyMoveStop">完成</span>
    </div>

    <!-- 标记「调整点位置」横幅：拖动平面图上的圆点改坐标（点标记 / 地球站 / 航迹航点共用） -->
    <div v-if="mkEditId" class="traj-banner">
      正在调整{{ mkEditLabel }}位置 · 在平面图上拖动圆点改坐标
      <span class="lnk" @click="mkEditStop">完成</span>
    </div>

    <!-- 地图右键上下文菜单（3D / 平面图共用）；点击空白处或再次右键关闭 -->
    <template v-if="ctxMenu">
      <div class="ctx-mask" @click="closeCtx" @contextmenu.prevent="closeCtx"></div>
      <div ref="ctxMenuEl" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }">
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddPoint">添加点标记（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxAddStation">添加地球站（当前经纬度）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('sea')">添加航行轨迹</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartTraj('flight')">添加飞行轨迹</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxStartPoly">绘制 Polygon（协调区）</div>
        <div class="ctx-item" :class="{ dis: !ctxMenu.ll }" @click="ctxSetLandColor">设置此国大地颜色</div>
        <div class="ctx-sep"></div>
        <div class="ctx-item" @click="clearPoints">清除点标记</div>
        <div class="ctx-item" @click="clearStations">清除地球站</div>
        <div class="ctx-item" @click="clearTrajs">清除航迹</div>
        <div class="ctx-item" @click="ctxClearPolys">隐藏所有 Polygon</div>
        <div class="ctx-item" @click="clearAllMk">清除所有标记</div>
        <div v-if="grdApiOk || covApiOk" class="ctx-item" @click="clearAllCoverage">清除所有覆盖图</div>
        <div v-if="grdApiOk" class="ctx-item" @click="ctxClearShellCov">清除壳层覆盖</div>
        <div v-if="grdApiOk" class="ctx-item" @click="ctxHideShellGuides">隐藏壳层参照网</div>
      </div>
    </template>

    <!-- 对星覆盖分析：对星性能指标表浮窗 -->
    <SatCovWindows
      :sc="satcov" :sp="satPerf" :table-open="satcovTableOpen"
      :time-label="timeText" :sat-search="satcovSearch" :host-size="satcovHost"
      :tz-utc="tzMode === 'utc'" :now-ms="satcovNowMs"
      @close-table="satcovTableOpen = false"
      @recompute-table="satcovRefreshTable" @add-in-beam="satcovAddInBeam" @seek-clock="satcovSeekClock"
      @scan-windows="satcovScanWindows" @focus-target="satcovFocusTarget" />

    <!-- 「从星座取」壳层挑选器（全量在轨目录 → 归并成层 → 勾哪层加哪层） -->
    <SatCovShellPicker
      v-if="satcovPickOpen"
      :sats="satcovPickPool" :loading="satcovPickLoading" :source="satcovPickSrc" :existing="satcovShellAlts"
      @close="satcovPickOpen = false" @set-source="satcovSetPickSrc" @add="satcovAddPicked" />

    <!-- 性能指标表（独立浮窗，每个天线一张）。对标 SATSOFT 两步法、合为一窗：
         上 = 城市输入区（增删改）；下 = 只读性能结果表（仅列覆盖该城市的波束）。 -->
    <div v-if="perfKey" class="perf-win" :style="{ left: perfWin.x + 'px', top: perfWin.y + 'px', width: perfWin.w + 'px', height: perfWin.h + 'px' }">
      <div class="perf-h" @mousedown="perfDragMove">
        <span class="perf-t">性能指标表
          <em v-if="perf.ctxInfo.value">· {{ perf.ctxInfo.value.satName }} / {{ perf.ctxInfo.value.antName }} · {{ perf.ctxInfo.value.beams }} 波束</em>
        </span>
        <span class="csx" @click="closePerf"><Icon name="x" :size="12" /></span>
      </div>

      <!-- 上：城市输入区（第一步——输入城市列表；每个经纬度 = 一行城市，不随波束膨胀） -->
      <section class="perf-input" :style="{ height: perfInputH + 'px' }">
        <div class="pin-h">
          <span class="pin-t">城市输入</span>
          <span class="ptb" :class="{ dis: !perf.canUndo.value }" title="撤销 (Ctrl+Z)" @click="perfUndo"><Icon name="undo-2" :size="12" /></span>
          <span class="ptb" :class="{ dis: !perf.canRedo.value }" title="重做 (Ctrl+Y)" @click="perfRedo"><Icon name="redo-2" :size="12" /></span>
          <span class="ptb" title="在选中行下方增加一行（直接在表格里键入或粘贴）" @click="perfAddRow"><Icon name="plus" :size="12" /> 增加</span>
          <span class="ptb" title="将地图上的点标记 / 地球站导入为城市" @click="perfImportMarkers"><Icon name="import" :size="12" /> 从标记导入</span>
          <span class="ptb" title="将地图上的航迹航点导入为城市（每个航点一行，城市名取「航迹名#序号」）" @click="perfImportTrajs"><Icon name="import" :size="12" /> 导入航迹</span>
          <span class="ptb" title="从剪贴板粘贴表格（末两列=经度、纬度，可含 国家/城市/代号）批量添加" @click="perfPasteBtn"><Icon name="clipboard" :size="12" /> 粘贴</span>
          <span class="ptb" title="从 Excel 追加城市（按表头匹配列；无表头时末两列作经纬度）" @click="perfImportCities(false)"><Icon name="import" :size="12" /> 导入 Excel</span>
          <span class="ptb" :class="{ dis: !perf.stations.value.length }" title="把城市列表导出为 Excel" @click="perfExportCities"><Icon name="download" :size="12" /> 导出 Excel</span>
          <span class="ptb" title="清空城市列表" @click="perfClearStations">清空</span>
          <span class="pin-sep"></span>
          <select class="pin-gsel" v-model="perfGroupSel" @change="perfLoadGroupSel" title="选择一个已存的城市组即载入（替换当前城市列表）进行查询">
            <option value="">载入城市组…</option>
            <option v-for="g in perf.cityGroups.value" :key="g.id" :value="g.id">{{ g.name }}（{{ g.cities.length }}）</option>
          </select>
          <span class="ptb" title="城市组：将当前城市列表存为新组，或重命名 / 覆盖 / 删除已有组" @click="perfOpenGroups"><Icon name="layers" :size="12" /> 城市组…</span>
          <span class="perf-cnt">{{ perf.stations.value.length }} 城市</span>
        </div>
        <!-- Excel 式网格（见 src/components/ExcelGrid.vue）：序号列选行 / 拖拽框选 / 键盘导航 / 复制粘贴 / 填充柄 / 右键插入删除行 -->
        <ExcelGrid class="pin-body eg-host" :grid="perfInGrid" :cols="perfInCols" :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))"
                   :actions-width="26" empty-text="暂无城市。" add-label="增加一行"
                   @add="perfAddRowEnd">
          <template #actions="{ row }">
            <span class="del" title="删除该城市" @click="perfDelStation(row.id)"><Icon name="x" :size="12" /></span>
          </template>
        </ExcelGrid>
      </section>

      <!-- 中缝：上下拖拽调整城市输入区 / 结果区的高度比例 -->
      <div class="perf-split" title="拖拽调整上下高度" @mousedown="perfDragSplit"><span class="grip"></span></div>

      <!-- 下：只读性能结果表（第二步——输出；仅列覆盖该城市的波束） -->
      <section class="perf-result">
        <div class="pr-h">
          <span class="pr-t">性能结果<em>只读</em></span>
          <label class="pr-cov"><input type="checkbox" v-model="perfOpts.filterOn" title="仅列方向性≥阈值（覆盖该城市）的波束" /> 仅覆盖波束</label>
          <!-- 选项里的数字框一律 .lazy（绑 change 而非 input）：optsByAnt 上挂着深 watch → 每敲一个字符就
               整表重算一次（逐站×逐波束重采方向图，指向误差那几项更是每格 72 次），而且中途拿的是半截数字
               （想输 63.6，途中先按 6 / 63 / 636 各算一遍）。失焦或回车才生效；▲▼ 微调与上下方向键仍即时
               生效——它们按规范 input 与 change 一起发（已实测）。 -->
          <label class="pr-cov" :class="{ dis: !perfOpts.filterOn }">阈值<input class="ci" type="number" step="0.5" v-model.lazy.number="perfOpts.minDir" :disabled="!perfOpts.filterOn" /><span class="u">dB</span></label>
          <input class="perf-q" v-model="perf.query.value" placeholder="查询：国家 / 城市 / 代号" />
          <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="perfCopyResult"><Icon name="copy" :size="12" /> 复制全表</span>
          <span class="ptb" title="导出为 Excel（性能结果 + 城市输入两张工作表；数字列存真数字）" @click="perfExportResult"><Icon name="download" :size="12" /> 导出 Excel</span>
          <span class="ptb" :class="{ on: perfOptsOpen }" title="显示列 / 计算口径 / 指向误差" @click="perfOptsOpen = !perfOptsOpen"><Icon name="settings" :size="12" /> 选项…</span>
          <span class="perf-cnt">{{ perf.filteredRows.value.length }} 行</span>
        </div>
        <!-- 只读 Excel 网格：框选 / 键盘导航 / Ctrl+A 全选 / Ctrl+C 复制选区 / 点列头排序（不可编辑） -->
        <ExcelGrid class="pr-body eg-host" :grid="perfResGrid" :cols="perfCols" :text="perfResText"
                   :serial="!perfCols.some((c) => c.key === 'no')" :head-unit="perfColUnit"
                   :head-tip="(c) => (c.na ? '本数据仅含功率（无相位），AR 暂不可算' : (c.tip || c.label))"
                   :row-class="(r) => (r.inPattern ? null : 'out')"
                   :empty-text="perf.stations.value.length ? '没有波束覆盖这些城市。' : '暂无城市。'" />
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


    <!-- 气象指标表（浮窗，与性能指标表同一套外壳）：上＝站点输入（可编辑，先经后纬），
         下＝只读读数表，列由「选项」勾选。★ 读数跟随时间轴 —— 时钟一动整表重算。 -->
    <div v-if="metTblOpen" class="perf-win mk-win" :style="{ left: metWin.x + 'px', top: metWin.y + 'px', width: metWin.w + 'px', height: metWin.h + 'px' }">
      <div class="perf-h" @mousedown="metDragMove">
        <span class="perf-t">气象指标表
          <em v-if="envLive.siteMeta.value">· {{ envLive.siteMeta.value.model }} · {{ liveTimeText }}</em>
          <em v-else-if="!envLive.meta.value">· 尚未获取气象数据</em>
        </span>
        <span class="csx" @click="closeMetTable"><Icon name="x" :size="12" /></span>
      </div>

      <!-- 上：站点输入 -->
      <section class="perf-input" :style="{ height: metInputH + 'px' }">
        <div class="pin-h">
          <span class="pin-t">站点输入</span>
          <span class="ptb" title="在末尾增加一行（可直接键入或粘贴）" @click="metAddRow(null)"><Icon name="plus" :size="12" /> 增加</span>
          <span class="ptb" title="导入地图点标记为站点" @click="envLive.importMarkers('pt')"><Icon name="import" :size="12" /> 点标记</span>
          <span class="ptb" title="导入地图地球站为站点（含站名）" @click="envLive.importMarkers('st')"><Icon name="import" :size="12" /> 地球站</span>
          <span class="ptb" title="导入地图航迹航点为站点（每航点一行，站名取「航迹名 #序号」）；读数为当前时刻沿该航线各点的衰减" @click="envLive.importMarkers('traj')"><Icon name="import" :size="12" /> 航迹</span>
          <span class="ptb" title="从剪贴板粘贴（每行至少两列，末两列为经度、纬度，其余作站名）" @click="metPasteBtn"><Icon name="clipboard" :size="12" /> 粘贴</span>
          <span class="ptb" title="自 Excel 追加站点（按表头匹配 站名 / 经度 / 纬度）" @click="metImportXlsx"><Icon name="import" :size="12" /> 导入 Excel</span>
          <span class="ptb" title="清空站点列表" @click="envLive.clearSites()">清空</span>
          <span class="perf-cnt">{{ envLive.sites.value.length }} 站</span>
        </div>
        <ExcelGrid class="pin-body eg-host" :grid="metInGrid" :cols="metInCols"
                   :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))"
                   :actions-width="26" empty-text="还没有站点。" add-label="增加一行"
                   @add="metAddRow(null)">
          <template #actions="{ row }">
            <span class="del" title="删除该站" @click="envLive.delSite(row.id)"><Icon name="x" :size="12" /></span>
          </template>
        </ExcelGrid>
      </section>

      <div class="perf-split" title="拖拽调整上下高度" @mousedown="metDragSplit"><span class="grip"></span></div>

      <!-- 下：只读读数表 -->
      <section class="perf-result">
        <div class="pr-h">
          <span class="pr-t">计算结果<em>只读 · 随时间轴更新</em></span>
          <!-- 和风与左侧模式列是两个数据源，都取时间轴当前时刻。花钱的只有点这一下：逐小时接口
               一次回一整条时间轴，取过之后再拖时间轴只在已取序列里查值，不再发请求。 -->
          <span class="ptb" :class="{ dis: envLive.obsBusy.value || !envLive.sites.value.length || (envLive.providers.value && !envLive.providers.value.point.ok) }"
                :title="(envLive.providers.value && !envLive.providers.value.point.ok) ? envLive.providers.value.point.message : '向和风天气请求各站在时间轴当前时刻的值，写入「和风」列组（逐站各一次请求，按站计费；本小时取实况观测，未来取逐小时预报，无历史数据。取一次即覆盖整条时间轴，之后拖动时间轴不再发请求）'"
                @click="(envLive.obsBusy.value || !envLive.sites.value.length || (envLive.providers.value && !envLive.providers.value.point.ok)) ? null : envLive.fetchObsAll()">
            <!-- 这里用不带字样的那朵云：11px 下 LIVE 四个字母只有 3 px 高，糊成一团反而更脏 -->
            <Icon name="cloud-rain" :size="12" /> {{ envLive.obsBusy.value ? '获取中…' : `获取和风数据（${envLive.sites.value.length} 站）` }}</span>
          <!-- 「和风」单独成元素：与后面的时刻挤在同一个文本节点里就查不到词典（见 i18n 的三类漏译） -->
          <span v-if="metObsAtText" class="perf-cnt" :title="'和风列对应的时刻与口径，与左侧模式列同一时刻'"><span>和风</span> {{ metObsAtText }}</span>
          <span v-if="envLive.siteMsg.value" class="perf-cnt">{{ envLive.siteMsg.value }}</span>
          <span class="ptb" title="复制整张结果表（含表头，TSV，可粘贴至 Excel）" @click="metCopyResult"><Icon name="copy" :size="12" /> 复制全表</span>
          <span class="ptb" title="导出为 Excel（计算结果 + 站点输入两张工作表；数字列写入数值）" @click="metExportXlsx"><Icon name="download" :size="12" /> 导出 Excel</span>
          <span class="ptb" :class="{ on: metOptsOpen }" title="选择显示的气象与链路指标" @click="metOptsOpen = !metOptsOpen"><Icon name="settings" :size="12" /> 指标…</span>
          <span v-if="envLive.siteBusy.value" class="perf-cnt">计算中…</span>
          <span v-else class="perf-cnt">{{ envLive.metRows.value.length }} 行</span>
        </div>
        <ExcelGrid class="pr-body eg-host" :grid="metResGrid" :cols="envLive.metCols.value" :text="envLive.metText"
                   :head-tip="(c) => (c.tip || c.label)"
                   :row-class="(r) => (r.note && r.totalDb == null ? 'out' : null)"
                   :empty-text="envLive.sites.value.length ? (envLive.meta.value ? '当前时刻不在已获取的气象时段内。' : '尚未获取气象数据。') : '还没有站点。'" />
      </section>

      <div class="prh prh-n" @mousedown="metDragResize($event, 'n')"></div>
      <div class="prh prh-s" @mousedown="metDragResize($event, 's')"></div>
      <div class="prh prh-w" @mousedown="metDragResize($event, 'w')"></div>
      <div class="prh prh-e" @mousedown="metDragResize($event, 'e')"></div>
      <div class="prh prh-nw" @mousedown="metDragResize($event, 'nw')"></div>
      <div class="prh prh-ne" @mousedown="metDragResize($event, 'ne')"></div>
      <div class="prh prh-sw" @mousedown="metDragResize($event, 'sw')"></div>
      <div class="perf-rsz" title="拖拽缩放窗口" @mousedown="metDragResize($event, 'se')"></div>
    </div>

    <!-- 指标选择：只换「看哪些量」，表的其余交互与性能指标表完全一致 -->
    <div v-if="metOptsOpen" class="sat-mask perf-opt-mask" @click.self="metOptsOpen = false">
      <div class="perf-opt-dlg met-opt-dlg">
        <div class="sdh"><span>显示指标</span><span class="csx" @click="metOptsOpen = false"><Icon name="x" :size="12" /></span></div>
        <div class="perf-opt-body">
          <section class="po-card po-cols met-po-cols">
            <div class="po-scroll">
              <div v-for="grp in envLive.MET_COL_GROUPS" :key="grp.title" class="po-grp">
                <div class="po-gt">{{ grp.title }}</div>
                <label v-for="k in grp.keys" :key="k" class="po-ck"
                       :class="{ dis: metColOff(k) }" :title="metColTip(k)">
                  <input type="checkbox" :checked="envLive.siteCols.value.includes(k)" @change="envLive.toggleSiteCol(k)" />
                  <span>{{ metColLabel(k) }}</span>
                </label>
              </div>
            </div>
          </section>
        </div>
        <div class="sdfoot"><span class="save ghost po-reset" title="恢复出厂勾选" @click="envLive.resetSiteCols()">恢复默认</span><span class="save" @click="metOptsOpen = false">完成</span></div>
      </div>
    </div>

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

        <!-- Excel 网格（见 src/components/ExcelGrid.vue）：三分页各一张，v-show 切换（实例常驻，选区/编辑态各自保留） -->
        <template v-for="p in mkPanes" :key="p.tab">
          <ExcelGrid v-show="mkTab === p.tab" class="pin-body mk-body eg-host" :grid="p.grid" :cols="p.cols"
                     :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))" :actions-width="26"
                     :empty-text="p.tab === 'traj' && !mkCurTraj() ? '尚未选择航迹。' : '暂无数据。'"
                     add-label="增加一行" @add="mkAddRowEnd">
            <template #actions="{ row }">
              <span class="del" title="删除该行" @click="mkDelRow(row.id)"><Icon name="x" :size="12" /></span>
            </template>
          </ExcelGrid>
        </template>
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
                 :text="(r, c) => (r[c.key] == null ? '' : String(r[c.key]))" :actions-width="26"
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
    <div v-if="perfOptsOpen && perfOpts" class="sat-mask perf-opt-mask" @click.self="perfOptsOpen = false">
      <div class="perf-opt-dlg">
        <div class="sdh"><span>性能表选项<em v-if="perf.ctxInfo.value"> · {{ perf.ctxInfo.value.antName }}</em></span><span class="csx" @click="perfOptsOpen = false"><Icon name="x" :size="12" /></span></div>
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
          </section>

          <!-- 右：计算设置 -->
          <div class="po-right">
            <!-- 波束筛选（复用卫星天线树同款「搜索+全选+勾选列表」模块）：默认全选=不筛选，仅勾选的波束进表 -->
            <section v-if="perf.ctxBeams.value.length > 1" class="po-card">
              <div class="po-ct">波束筛选</div>
              <input class="ci bq" :value="perf.beamQuery.value" placeholder="搜索：波束名，或序号 1-62、1,3,5、1-10,20-30" @input="e => perf.beamQuery.value = e.target.value" />
              <!-- 整行都是勾选热区，按住左键拖＝刷选（长按多选）；复选框只当显示件，见 useCheckList -->
              <div
                ref="pbEl" class="bplist" :class="{ painting: pbPainting }" tabindex="0"
                title="点一行翻勾选 · 按住拖＝刷选一片 · Shift 点＝连选一段 · Ctrl+A 全选"
                @keydown="pbKey"
              >
                <div class="brow ball" @mousedown="pbHeadDown">
                  <input type="checkbox" :checked="pbAllOn()" :indeterminate="pbAnyOn() && !pbAllOn()" />
                  <span class="balln">{{ perf.beamQuery.value.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
                  <span class="bpk">{{ pbCount }}/{{ perf.ctxBeams.value.length }}</span>
                </div>
                <div
                  v-for="(b, bi) in pbRows" :key="b.seq"
                  class="brow bitem" :class="{ on: pbOn(b.bi), cur: pbCur === bi }"
                  @mousedown="pbDown($event, bi)"
                >
                  <input type="checkbox" :checked="pbOn(b.bi)" />
                  <span class="bseq">{{ b.seq }}</span>
                  <span class="pbnm" :title="b.name" data-i18n-skip>{{ b.name }}</span>
                  <span class="bpk">{{ b.peakDb == null ? '—' : b.peakDb.toFixed(1) }}</span>
                </div>
                <div v-if="!pbRows.length" class="empty">无匹配波束</div>
              </div>
            </section>

            <section class="po-card">
              <div class="po-ct">过滤</div>
              <label class="po-chk"><input type="checkbox" v-model="perfOpts.filterOn" /><span>剔除低于最低方向性的记录</span></label>
              <div class="po-row"><label>最低方向性</label><input class="ci" type="number" step="0.5" v-model.lazy.number="perfOpts.minDir" :disabled="!perfOpts.filterOn" /><span class="u">dB</span></div>
            </section>

            <section class="po-card">
              <div class="po-ct">参数计算</div>
              <label class="po-chk"><input type="checkbox" v-model="perfOpts.sameAsAnt" /><span>与天线当前设置一致</span></label>
              <template v-if="!perfOpts.sameAsAnt">
                <div class="po-row"><label>极化</label><select v-model="perfOpts.pol"><option value="P1">P1 共极化</option><option value="P2">P2 交叉</option><option value="RSS">RSS 合成</option><option value="P1/P2">P1/P2</option><option value="P2/P1">P2/P1</option></select></div>
                <div class="po-row"><label>单位</label><span class="seg sm"><span class="sg" :class="{ on: perfOpts.unit === 'dB' }" @click="perfOpts.unit = 'dB'">dB</span><span class="sg" :class="{ on: perfOpts.unit === 'power' }" @click="perfOpts.unit = 'power'">功率</span><span class="sg" :class="{ on: perfOpts.unit === 'voltage' }" @click="perfOpts.unit = 'voltage'">电压</span></span></div>
                <div class="po-row"><label>路径损耗</label><select v-model="perfOpts.pathLoss"><option value="none">无</option><option value="relative">相对(h/Rs)²</option><option value="absolute">通量密度</option></select></div>
                <div class="po-row"><label>增益偏置</label><input class="ci" type="number" step="0.5" v-model.lazy.number="perfOpts.gainOffset" /><span class="u">dB</span></div>
              </template>
            </section>

            <section class="po-card">
              <div class="po-ct">指向误差 · Min/Max Pointing</div>
              <div class="po-row"><label>方位 Az</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="perfOpts.pointAz" /><span class="u">°</span></div>
              <div class="po-row"><label>俯仰 El</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="perfOpts.pointEl" /><span class="u">°</span></div>
              <div class="po-row"><label>偏航 Yaw</label><input class="ci" type="number" step="any" min="0" v-model.lazy.number="perfOpts.pointYaw" /><span class="u">°</span></div>
            </section>
          </div>
        </div>
        <div class="sdfoot"><span class="save ghost po-reset" title="将当前天线的表选项恢复为默认值（列 / 口径 / 指向误差 / 波束筛选）" @click="perfResetOpts">恢复默认</span><span class="save" @click="perfOptsOpen = false">完成</span></div>
      </div>
    </div>

    <!-- 城市组管理弹窗：把当前城市列表存成命名预设，随时载入(替换)/追加/覆盖/重命名/删除；组随页面快照存盘、跨天线共享 -->
    <div v-if="perfGrpOpen" class="sat-mask perf-grp-mask" @click.self="perfGrpOpen = false">
      <div class="sat-dlg grp-dlg">
        <div class="sdh"><span>城市组</span><span class="csx" @click="perfGrpOpen = false"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody">
          <div class="grp-save">
            <input class="grp-name" v-model="perfNewGrpName" :placeholder="'新组名称（默认：城市组 ' + (perf.cityGroups.value.length + 1) + '）'" @keydown.enter="perfCreateGroup" />
            <span class="save" :class="{ dis: !perf.stations.value.length }" @click="perfCreateGroup">存当前 {{ perf.stations.value.length }} 城市为新组</span>
          </div>
          <div class="grp-list">
            <div v-for="g in perf.cityGroups.value" :key="g.id" class="grp-row" :class="{ cur: perfGroupSel === g.id }">
              <template v-if="perfGrpRenameId === g.id">
                <input class="grp-name f1" v-model="perfGrpRenameVal" @keydown.enter="perfCommitRenameGroup(g)" @keydown.esc="perfGrpRenameId = ''" />
                <span class="gic ok" title="确认重命名" @click="perfCommitRenameGroup(g)"><Icon name="check" :size="12" /></span>
                <span class="gic" title="取消" @click="perfGrpRenameId = ''"><Icon name="x" :size="12" /></span>
              </template>
              <template v-else>
                <span class="grp-nm" :title="g.name" data-i18n-skip>{{ g.name }}</span>
                <span class="grp-cnt">{{ g.cities.length }} 城市</span>
                <span class="gbtn" title="载入：用此组城市替换当前列表（可撤销）" @click="perfLoadGroup(g)">载入</span>
                <span class="gbtn" title="追加此组城市到当前列表（按坐标去重）" @click="perfAppendGroup(g)">追加</span>
                <span class="gbtn" title="用当前城市列表覆盖此组" @click="perfOverwriteGroup(g)">覆盖</span>
                <span class="gic" title="重命名" @click="perfStartRenameGroup(g)"><Icon name="pencil" :size="12" /></span>
                <span class="gic del" :class="{ warn: perfGrpDelId === g.id }" :title="perfGrpDelId === g.id ? '再次点击确认删除' : '删除此组'" @click="perfDeleteGroup(g)"><Icon name="trash" :size="12" /></span>
              </template>
            </div>
            <div v-if="!perf.cityGroups.value.length" class="grp-empty">还没有城市组。</div>
          </div>
        </div>
        <div class="sdfoot"><span class="save" @click="perfGrpOpen = false">完成</span></div>
      </div>
    </div>
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
.search .panel { position: absolute; top: 28px; left: 0; width: 260px; max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--border-strong); z-index: 5; }
.search .item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search .item:hover { background: var(--surface); }
.search .itx { flex: 1; min-width: 0; }
.search .nm { font-size: var(--fs-4); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search .sub { color: var(--text-faint); font-size: var(--fs-2); }
/* 结果行「+」：加入选中集而不清搜索框（跨多次搜索攒一批，再「存为组」）；已在集中时显示 ✓ */
.search .ipk { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 1px solid var(--border); border-radius: var(--r-card); color: var(--text-faint); }
.search .ipk:hover { border-color: var(--accent); color: var(--accent); }
.search .item.picked .ipk { border-color: var(--accent); background: var(--accent); color: var(--bg); }
.meta { margin-left: auto; color: var(--text-faint); }
.tl { display: flex; align-items: center; gap: 14px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex: none; font-size: var(--fs-3); }
/* 时间轴（专业刻度尺）：基线尺 + 主/次两级刻度 + 游标针(顶部握柄) + 悬停幽灵线 + 独立「此刻」标记 */
.tb-track { position: relative; flex: 1; min-width: 180px; height: 34px; cursor: pointer; outline: none; }
/* 焦点环：全局 :focus-visible 那条带 !important，这里同样带 !important 才压得住（controls.css 头注有言在先）。
   拖动是 pointerdown 里 focus() 取的焦点，不该描框；键盘来的由 .kbf 点亮（见 onTrackFocus / onTrackKey）。 */
.tb-track:focus-visible:not(.kbf) { outline: none !important; }
.tb-track.kbf { outline: 1px solid var(--accent) !important; outline-offset: 1px; border-radius: var(--r-card); }
.tb-base { position: absolute; left: 0; right: 0; bottom: 3px; height: 1px; background: var(--border-strong); }
.tb-t { position: absolute; bottom: 3px; width: 1px; transform: translateX(-0.5px); }
.tb-t.maj { height: 11px; background: var(--text-muted); }
.tb-t.min { height: 6px; background: var(--border-strong); }
.tb-lab { position: absolute; top: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); line-height: 1; color: var(--text-faint); white-space: nowrap; pointer-events: none; }
.tb-ph { position: absolute; top: 0; bottom: 3px; width: 1.5px; transform: translateX(-0.75px); background: var(--accent); pointer-events: none; }
.tb-ph .hd { position: absolute; top: -1px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 6px solid var(--accent); }
.tb-ph.lv { background: #e05252; }
.tb-ph.lv .hd { border-top-color: #e05252; }
.tb-now { position: absolute; top: 12px; bottom: 3px; width: 1px; transform: translateX(-0.5px); background: #e05252; pointer-events: none; }
.tb-now .tag { position: absolute; top: -11px; left: 50%; transform: translateX(-50%); font-family: var(--font-mono); font-size: var(--fs-1); color: #e05252; white-space: nowrap; }
.tb-ghost { position: absolute; top: 10px; bottom: 3px; width: 1px; transform: translateX(-0.5px); background: var(--text-faint); opacity: 0.5; pointer-events: none; }
.tb-tip { position: absolute; top: -2px; transform: translate(-50%, -100%); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-card); padding: 1px 5px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: var(--fs-1); color: var(--text); white-space: nowrap; pointer-events: none; z-index: 3; }
/* 时间条分区（左：实时+跨度 / 中：刻度尺 flex:1 / 右：读数+步进）——留白分组，不用竖线堆砌 */
.tl-grp { display: inline-flex; align-items: center; gap: 8px; flex: none; }
/* 时间读数：双行【定宽】块（主行=时刻，副行=日期 · 偏移量 · 时区档位），tabular-nums + 固定宽度，
   拖动不抖、不参与伸缩。宽度是 min-width 不行 —— 副行的偏移量会顶出这个下限（见 timeParts 处注）。 */
.tlab2 { display: inline-flex; flex-direction: column; justify-content: center; width: 122px; flex: none; font-family: var(--font-mono); font-variant-numeric: tabular-nums; line-height: 1.25; }
.tlab2 .t1 { font-size: var(--fs-3); color: var(--text); white-space: nowrap; }
.tlab2 .t2 { display: flex; align-items: baseline; gap: 4px; font-size: var(--fs-1); color: var(--text-faint); white-space: nowrap; }
.tlab2 .t2 .d, .tlab2 .t2 .z { flex: none; }
.tlab2 .t2 .o { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }   /* 极端偏移量(+365d…)只收缩这一格，不撑块宽 */
/* 时区档位切换（本机时区 ⇄ UTC）：整块读数即按钮，副行末尾的档位标记就是当前态指示 */
.tlab2.tzsw { cursor: pointer; border-radius: var(--r-box); padding: 0 4px; margin: 0 -4px; }
.tlab2.tzsw:hover { background: var(--hover, rgba(255, 255, 255, 0.06)); }
.tlab2.tzsw:hover .t2 { color: var(--text); }
/* 步进按钮组：共享外框(0.5px+圆角) + 内部细分隔线；hover 中性叠加(非 accent)、100ms 跟手 */
.tl .stg { display: inline-flex; align-items: stretch; border: 0.5px solid var(--border); border-radius: var(--r-card); overflow: hidden; flex: none; }
.tl .stg .st { padding: 4px 7px; cursor: pointer; color: var(--text-muted); font-size: var(--fs-2); line-height: 1; white-space: nowrap; user-select: none; transition: background .12s ease, color .12s ease; }
.tl .stg .st + .st { border-left: 0.5px solid var(--border); }
.tl .stg .st:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.tl .stg .st:active { background: color-mix(in srgb, var(--text) 14%, transparent); }
.tl .stg .st.now { color: var(--text); }
.tl .stg .st.dis { color: var(--text-faint); pointer-events: none; }
/* 实时徽标：红=跟随系统时间(点击停在当前时刻)、灰=点击回实时；红仅此一处语义 */
.tl .live-btn { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 0.5px solid var(--border); border-radius: var(--r-card); cursor: pointer; color: var(--text-muted); user-select: none; flex: none; white-space: nowrap; transition: color .12s ease, border-color .12s ease; }
.tl .live-btn:hover { border-color: var(--border-strong); color: var(--text); }
.tl .live-btn .ldot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex: none; }
.tl .live-btn.on { color: #e05252; border-color: color-mix(in srgb, #e05252 55%, transparent); }
.tl .live-btn.on .ldot { background: #e05252; animation: live-pulse 2s ease-in-out infinite; }
@keyframes live-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(224, 82, 82, 0.4); } 50% { box-shadow: 0 0 0 4px rgba(224, 82, 82, 0); } }
/* 仿真时钟走带：图标按钮与文字按钮同高同框（同一 .stg 里不能一个 12px 字一个 12px 图标各算各的行高） */
.tl .stg .st.tic { display: inline-flex; align-items: center; justify-content: center; padding: 4px 7px; }
.tl .stg .st.play { padding: 4px 9px; }
.tl .stg .st.act { color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 14%, transparent); }
/* 步长 / 倍速：两个带栏名的下拉 */
.tl .clkg { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.tl .ckl { font-size: var(--fs-2); color: var(--text-faint); white-space: nowrap; }
.tl .ckl + .cksel { margin-right: 4px; }
.tl .cksel {
  background-color: var(--surface); color: var(--text-muted); border: 0.5px solid var(--field-border); border-radius: var(--r-card);
  font-size: var(--fs-2); font-family: var(--font-mono); padding: 3px 4px; cursor: pointer; outline: none;
}
.tl .cksel:hover { color: var(--text); border-color: var(--border-strong); }
/* 跨度定宽：select 的宽度取【最宽的那个 option】，而滚轮缩放会往里挂一条自定义档，标签每滚一格都在变
   （"1d5h"→"23h59m"→"29d23h"）—— 不钉死就是滚一下推着中间 flex:1 的尺子重排一次。
   66px 量自最长的 "23h59m"（11px 衬线栈 64px）＋2px 余量；右内距 21px 是 controls.css 给箭头钉死的，别算漏。
   步长/倍速两个不钉：它们的档位是定死的，宽度只随最宽 option 走，换档不会变宽（自定义值只在装载时出现一次）。 */
.tl .cksel.wsel { width: 66px; }
/* 跳到时刻：浮在时间条上方的小盒（时间条本身很矮，塞不进一个日期时间输入框） */
.tl .gotobox {
  position: absolute; right: 12px; bottom: calc(100% + 6px); z-index: 2200;   /* 压过 .lmenu-bd 的遮罩 */
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-float); box-shadow: var(--shadow-2);
}
.tl .gotobox .ci { font-size: var(--fs-3); padding: 0 7px; background: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-card); font-family: var(--font-mono); }
.tl .gotobox .ptb { font-size: var(--fs-3); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-card); padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.tl .gotobox .ptb:hover { color: var(--accent); border-color: var(--accent); }
/* 时间控制条置于地图正下方：分隔线换到上缘 */
.tl.bottom { border-bottom: 0; border-top: 1px solid var(--border); background: var(--surface); container-type: inline-size; position: relative; }
/* 窄容器（侧栏挤压）优雅降级：收紧内边距/竖线/时间轴下限，保证「最低仰角」输入始终可见 */
/* 让位次序（挤窄时按「越靠后越先走」）：刻度次线 → 栏名 → 跳到时刻 → 跨度整格。
   ★ 走带五个键与步长/倍速两个旋钮任何档位都不许消失：它们是这条时间条的功能本体。
     跨度改成下拉后不必再逐档藏预设了 —— 六档装在一格里，宽度还恒定；只在最窄档整格让位（同改造前）。 */
@container (max-width: 880px) {
  .tl { gap: 10px; }
  .tl-grp { gap: 6px; }
  .tl .tb-track { min-width: 130px; }
  .tl .tb-t.min { display: none; }
  .tl .stg .st { padding: 4px 5px; }
  .tl .stg .st.tic { padding: 4px 4px; }
  .tl .clkg { gap: 3px; }
  .tl .ckl { font-size: var(--fs-1); }
  .tl .cksel { font-size: var(--fs-2); padding: 3px 2px; }
  .tl .cksel.wsel { width: 62px; }        /* 10.5px 下 "23h59m" 量得 60px */
  .tlab2 { width: 108px; }
}
@container (max-width: 760px) {
  .tl { gap: 8px; }
  .tl .stg .st.tic:last-child { display: none; }            /* 「跳到时刻」：键盘与拖动仍可定位 */
}
/* 最后一档才动栏名：没有栏名的「24h」「1s」「×10」谁也看不出是什么，能留就留 */
@container (max-width: 560px) {
  .tl .ckl { display: none; }                               /* 口径仍在三个下拉的悬停提示里 */
  .tl .wspan { display: none; }                             /* 跨度整格让位（同改造前）：滚轮照样能缩放到任意跨度 */
}
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-size: var(--fs-3); }
.mini.on { color: var(--text); border-color: var(--accent); }
.body { flex: 1; min-height: 0; display: flex; }
.stage-wrap { flex: 1; min-width: 0; position: relative; }
.stage { width: 100%; height: 100%; background: #070b12; }
/* 3D canvas 尺寸完全交给 CSS（renderer.setSize 已传 updateStyle=false 不写内联 px），
   渲染分辨率与布局解耦，避免内联像素值参与布局形成 resize 振荡 */
.stage :deep(canvas) { width: 100%; height: 100%; display: block; }
.flat { position: absolute; inset: 0; width: 100%; height: 100%; background: #0b1a2b; }
/* 聚焦卫星图例（左下，3D/2D 共用）：色条对应地图上实际绘制的覆盖范围线与星下点轨迹线 */
.focus-legend {
  position: absolute; left: 14px; bottom: 10px; display: flex; flex-direction: column; gap: 5px;
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  backdrop-filter: blur(10px) saturate(1.1); -webkit-backdrop-filter: blur(10px) saturate(1.1);
  border: 1px solid color-mix(in srgb, var(--border-strong) 60%, transparent);
  border-radius: var(--r-float); padding: 7px 10px; font-size: var(--fs-2); color: var(--text-muted); pointer-events: none;
}
.fl-row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
/* 颜色/线型由 fpSwStyle / trkSwStyle 行内给（跟着显示设置走），这里只留几何 */
.fl-sw { width: 18px; height: 0; border-top: 2px solid; flex: none; }
.card {
  position: absolute; right: 14px; top: 14px; width: 256px;
  max-height: calc(100% - 28px); overflow-y: auto;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  backdrop-filter: blur(14px) saturate(1.1); -webkit-backdrop-filter: blur(14px) saturate(1.1);
  border: 1px solid color-mix(in srgb, var(--border-strong) 70%, transparent);
  border-radius: var(--r-float); padding: 11px 13px; font-size: var(--fs-3);
  box-shadow: var(--shadow-3);
}
.ch { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.cc { flex: none; align-self: center; display: inline-flex; align-items: center; color: var(--text-faint); font-size: var(--fs-1); line-height: 1; transition: transform .15s; }
.cc.col { transform: rotate(-90deg); }
.ch:hover .cc { color: var(--text); }
.cn { flex: 1 1 auto; min-width: 0; font-family: var(--font-serif); font-size: var(--fs-5); line-height: 1.3; overflow-wrap: anywhere; }
.card.collapsed .cn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx { flex: none; display: inline-flex; align-items: center; cursor: pointer; color: var(--text-faint); line-height: 1.2; }
.cx:hover { color: var(--text); }
/* 卡头齿轮：与关闭叉同一档淡墨，进「显示设置 · 聚焦卫星」 */
.cg { flex: none; display: inline-flex; align-items: center; cursor: pointer; color: var(--text-faint); line-height: 1.2; }
.cg:hover { color: var(--accent); }
/* 多选 mini-card 列表（master–detail：点行=设为主选看详情，×=移出，active 高亮） */
.msel { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; max-height: 230px; overflow-y: auto; }
.mrow { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border: 1px solid var(--border); border-left: 3px solid transparent; cursor: pointer; }
.mrow:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
.mrow.active { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.mrow .mmain { flex: 1; min-width: 0; }
.mrow .mr1 { display: flex; align-items: baseline; gap: 6px; }
.mrow .mnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); color: var(--text); }
.mrow .mkind { flex: none; font-size: var(--fs-1); color: var(--accent); border: 1px solid var(--accent); padding: 0 4px; }
.mrow .msub { font-family: var(--font-mono); font-size: var(--fs-1); color: var(--text-faint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .mx { flex: none; display: inline-flex; align-items: center; color: var(--text-faint); opacity: 0; cursor: pointer; }
.mrow:hover .mx { opacity: 1; }
.mrow .mx:hover { color: #ff6b6b; }
.cmeta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.badge { font-family: var(--font-mono); font-size: var(--fs-2); padding: 1px 6px; border: 1px solid var(--border); color: var(--text-muted); }
.badge.kind { color: var(--accent); border-color: var(--accent); }
.badge.geo { color: #ffd24a; border-color: #ffd24a; }
.csec { margin: 11px 0 5px; padding-top: 8px; border-top: 1px solid var(--border); font-size: var(--fs-2); letter-spacing: var(--ls-caps); color: var(--text-faint); }
.rows { display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.row .k { color: var(--text-muted); white-space: nowrap; }
.row .k em { font-style: italic; font-family: var(--font-serif); color: var(--accent); margin-left: 3px; font-size: var(--fs-4); }
.row .v { font-family: var(--font-mono); color: var(--text); white-space: nowrap; text-align: right; }
.row .v i { font-style: normal; color: var(--text-faint); font-size: var(--fs-2); margin-left: 3px; }
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
.ptool { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.ptool .search input { width: 100%; box-sizing: border-box; }
.ptool .search .panel { width: 100%; }
/* 搜索筛选状态条（确认感：小圆点 + 词 + 清除，克制不卡通） */
.fbar { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; font-size: var(--fs-2); color: var(--text-muted); }
.fbar .fdot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.fbar b { color: var(--text); font-weight: 600; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fbar .fx { margin-left: auto; color: var(--text-faint); cursor: pointer; padding: 0 2px; }
.fbar .fx:hover { color: var(--danger); }
/* 「存为组」按钮：吃掉右推空间（清除紧随其后，故取消清除自身的 auto） */
.fbar .fsave { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; color: var(--accent); cursor: pointer; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: var(--r-card); white-space: nowrap; }
.fbar .fsave:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.fbar .fsave ~ .fx { margin-left: 0; }
.fbar.selbar .fdot.sel { background: var(--accent); }   /* 多选栏用强调色圆点，区别于筛选栏的绿点 */
.pchips { display: flex; gap: 6px; }
.pchips .mini { flex: 1; text-align: center; padding: 3px 0; }
/* 「发送到小程序」是动作不是开关（旁边两个是开关），故用强调色描边区分；字更长，多占一份宽度 */
.pchips .mini.act { flex: 1.7; display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap;
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.pchips .mini.act:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.pstat { color: var(--text-faint); font-size: var(--fs-2); line-height: 1.5; }
/* 星座分组列表（grprow 而非 pgrow：后者是 GXT 逐档色行的既有类名，避免撞名） */
.pgl { padding: 4px 0 8px; }
.grprow { display: flex; align-items: center; gap: 7px; padding: 4px 12px 4px 6px; font-size: var(--fs-4); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.grprow:hover { background: var(--surface-2); color: var(--text); }
.grprow.sel { background: var(--accent); color: var(--bg); }
.grprow .pgico { flex: none; display: inline-flex; color: var(--text-faint); }
.grprow:hover .pgico, .grprow.sel .pgico { color: inherit; }
.grprow .pgn { flex: 1; overflow: hidden; text-overflow: ellipsis; }
/* 星点颜色：小色块（覆盖原生取色器）+ 悬停复位×（仅有覆盖色时出现） */
/* .pgclr/.pgsw/.pgrst 是通用件：内置分组行 / 卫星组行 / 组管理器（着色区、成员行）共用 */
.pgclr { position: relative; flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.pgclr input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.pgsw { width: 11px; height: 11px; border-radius: var(--r-box); box-sizing: border-box; border: 1px solid rgba(0,0,0,.3); box-shadow: 0 0 0 1px rgba(255,255,255,.35); }
/* 未设置=斜线空块（随所属星座）；inh=随组色（成员行虚线描边，与单独色区分） */
.pgsw.unset { background: linear-gradient(135deg, transparent 44%, var(--text-faint) 44%, var(--text-faint) 56%, transparent 56%); box-shadow: none; border-color: var(--text-faint); }
.pgsw.inh { box-shadow: none; border: 1px dashed rgba(0,0,0,.45); }
.pgrst { flex: none; display: inline-flex; padding: 0 1px; color: var(--text-faint); cursor: pointer; opacity: 0; }
.grprow:hover .pgrst, .ccrow:hover .pgrst { opacity: 1; }
.pgrst:hover { color: #ff6b6b; }
.grprow.sel .pgrst, .ccrow.sel .pgrst { color: var(--bg); opacity: .85; }
/* 行首展开箭头（内置组 / 卫星组 / 自定义星座 三处同一枚）：只管展开卫星列表，与行本身的点击语义分开 */
.pgex { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: var(--r-box); }
.pgex:hover { color: var(--text); background: var(--bg); }
.pgex.none { visibility: hidden; }
.grprow:hover .pgex, .ccrow:hover .pgex { color: var(--text-muted); }
.grprow.sel .pgex, .ccrow.sel .pgex { color: inherit; }
.grprow.sel .pgex:hover, .ccrow.sel .pgex:hover { background: color-mix(in srgb, var(--bg) 30%, transparent); }
.grprow.exp:not(.sel), .ccrow.exp:not(.sel) { color: var(--text); }
/* 「加入组」弹出菜单：fixed 锚在操作条按钮下沿（侧栏祖先无 transform，不会被 overflow 裁掉） */
.lmenu-bd { position: fixed; inset: 0; z-index: 2190; }
.lmenu { position: fixed; z-index: 2200; width: 200px; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); padding: 3px 0; }
.lmh { padding: 4px 10px 5px; font-size: var(--fs-2); color: var(--text-faint); border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.lmi { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; }
.lmi:hover { background: var(--surface-2); color: var(--text); }
.lmi > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmi > em { flex: none; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lmi.new { color: var(--accent); border-bottom: 1px solid var(--border); }
/* 行右键菜单（内置星座 / 卫星组 / 自定义星座三类行共用）：与 .lmenu 同一层级与视觉，条目带图标 */
.rmenu { position: fixed; z-index: 2200; min-width: 186px; max-width: 300px; max-height: calc(100vh - 8px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-2); padding: 3px 0; }
.rmh { display: flex; align-items: baseline; gap: 8px; padding: 4px 10px 5px; font-size: var(--fs-2); color: var(--text-faint); border-bottom: 1px solid var(--border); }
.rmh > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.rmh > em { flex: none; font-style: normal; font-variant-numeric: tabular-nums; }
.rmi { display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; }
.rmi > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rmi > em { flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; font-size: var(--fs-2); color: var(--text-faint); }
.rmi:hover { background: var(--surface-2); color: var(--text); }
.rmi.dis, .rmi.dis:hover { color: var(--text-faint); opacity: .45; cursor: default; background: none; }
.rmi.del { color: var(--danger); }
.rmi.del:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); }
.rmi.del.arm { background: color-mix(in srgb, var(--danger) 18%, transparent); font-weight: 600; }
.rms { height: 1px; background: var(--border); margin: 3px 6px; }
/* 自定义星座（仿 STK Walker 生成器）：侧栏区 + 列表 */
.ccsec { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
.cchd { display: flex; align-items: center; justify-content: space-between; padding: 4px 12px; font-size: var(--fs-3); color: var(--text-muted); }
.cchd .lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; }
.cctip { padding: 2px 12px 6px; font-size: var(--fs-2); color: var(--text-faint); line-height: 1.5; }
.ccep { display: flex; align-items: center; gap: 6px; padding: 2px 12px 6px; }
.ccep > label { flex: none; font-size: var(--fs-2); color: var(--text-muted); }
.ccep > .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-2); color: var(--text); outline: none; }
.ccep > .lnk { flex: none; cursor: pointer; color: var(--accent); font-size: var(--fs-2); }
.ccrow { display: flex; align-items: center; gap: 6px; padding: 4px 12px 4px 6px; font-size: var(--fs-3); color: var(--text-muted); }
.ccrow:hover { background: var(--surface-2); color: var(--text); }
.ccrow.off { opacity: 0.5; }
.ccrow.sel { background: var(--accent); color: var(--bg); }
.ccrow.sel .cccode { color: var(--bg); opacity: 0.75; }
.ccrow.sel .ccic { color: var(--bg); }
.ccrow .ccdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.ccrow .ccnm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccrow .cccode { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ccrow .ccic { flex: none; display: inline-flex; cursor: pointer; color: var(--text-faint); padding: 1px; }
.ccrow .ccic:hover { color: var(--text); }
.ccrow .ccic.del:hover { color: #ff6b6b; }
.ccrow .ccic.add { color: var(--ok); }
.ccrow.sel .ccic.add { color: var(--bg); }
.ccrow .ccic.ok:hover { color: var(--accent); }
.ccrow.sel .ccic.del.warn { color: #ffd7d7; }
/* 卫星组：段头计数 + 新建/管理入口 + 行内重命名输入 + 删除确认高亮 */
.cchd .ccsub { font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.cchd .cchr { display: flex; align-items: center; gap: 9px; }
.ccrow .ccic.del.warn { color: #ff6b6b; }
.sgrow .sgnm-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--field-bg); color: var(--text); font-size: var(--fs-3); padding: 1px 5px; border-radius: var(--r-box); outline: none; }
/* 向导：预设条 + 汇总 */
.ccpreset { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0; }
.ccpz { border: 1px solid var(--border); color: var(--text-muted); padding: 2px 7px; font-size: var(--fs-2); cursor: pointer; border-radius: var(--r-box); }
.ccpz:hover { border-color: var(--accent); color: var(--text); }
.ccsum { margin-top: 10px; padding: 7px 9px; background: var(--surface-2); font-size: var(--fs-3); color: var(--text-muted); }
.ccsum .cccode { color: var(--accent); font-weight: 600; }
/* 内联生成/编辑面板（停靠式，地图保持可见 + 实时预览）；短标签左置、长标签上置，避免截断 */
.sview.editing { flex: 1; min-height: 0; }
.cedit { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cehd { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; }
.cehd .ceback { display: inline-flex; align-items: center; gap: 1px; color: var(--text-muted); cursor: pointer; font-size: var(--fs-3); }
.cehd .ceback:hover { color: var(--text); }
.cehd .cetitle { font-size: var(--fs-4); color: var(--text); font-weight: 600; }
.cehd .celive { margin-left: auto; font-size: var(--fs-1); color: var(--accent); letter-spacing: var(--ls-tight); }
.cebody { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.cesec { margin: 13px 0 8px; padding-top: 9px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-2); }
.cef { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cef > label { width: 68px; flex: none; color: var(--text-muted); font-size: var(--fs-3); }
.cef > .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
.cef > .u { flex: none; width: 16px; color: var(--text-muted); font-size: var(--fs-2); }
.cef > .clr { flex: 1; height: 24px; }
.cefv { margin-bottom: 8px; }
.cefv > label { display: block; color: var(--text-muted); font-size: var(--fs-3); margin-bottom: 3px; }
.cefv .ceinp { display: flex; align-items: center; gap: 6px; }
.cefv .ceinp > .ci { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
.cefv .ceinp > .u { flex: none; color: var(--text-muted); font-size: var(--fs-2); }
.cetpf { display: flex; gap: 8px; margin-bottom: 8px; }
.cetpf > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cetpf small { color: var(--text-muted); font-size: var(--fs-2); }
.cetpf .ci { width: 100%; box-sizing: border-box; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-3); color: var(--text); outline: none; }
.seg3 { display: flex; flex: 1; }
.seg3 > span { flex: 1; text-align: center; border: 1px solid var(--border); border-left-width: 0; padding: 4px 0; cursor: pointer; font-size: var(--fs-3); color: var(--text-muted); }
.seg3 > span:first-child { border-left-width: 1px; }
.seg3 > span.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.seg3 > span:hover:not(.on) { color: var(--text); }
.ceread { margin-top: 13px; padding: 8px 10px; background: var(--surface-2); }
.ceread .crcode { color: var(--accent); font-weight: 600; font-size: var(--fs-4); font-variant-numeric: tabular-nums; }
.ceread .crsub { color: var(--text-muted); font-size: var(--fs-2); margin-top: 3px; line-height: 1.5; }
.ceread .crwarn { color: #e0a030; font-size: var(--fs-2); margin-top: 4px; line-height: 1.5; }
.cefoot { display: flex; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border); flex: none; }
.cefoot .cancel { margin-left: auto; color: var(--text-muted); border: 1px solid var(--border); padding: 4px 14px; cursor: pointer; font-size: var(--fs-3); }
.cefoot .cancel:hover { color: var(--text); }
.cefoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: var(--fs-3); }
/* 面板停靠形态：占满侧栏宽度、去左缘边框，滚动交给侧栏整体 */
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.csh { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: var(--fs-5); padding: 11px 16px; align-self: center; }
.flatbtn { align-self: center; margin-left: 10px; flex: none; border: 1px solid var(--border); padding: 2px 9px; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; }
.flatbtn:hover { border-color: var(--accent); color: var(--text); }
.flatbtn.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
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
/* 恒定「标签自占一行、控件铺满下一行」的行（分辨率 / 预设 / 常用这些四档以上的）。
   一般的行不必写它 —— .srow 本身可换行，装不下时分段控件会自己掉下来。 */
.srow.stack > label { width: 100%; margin-bottom: 4px; }
.srow.stack > .seg, .srow.stack > select { flex: 1 1 100%; }
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
/* 分段控件：连体框 + 段间细线，选中段填墨。全库四处（主窗 / GRD 设置 / 壳层选择 / 对星窗口）
   原来各写各的——有的没圆角、有的没段间线、段内距 10 与 12 两种；此处收成一份口径，四处逐字一致。 */
.seg { display: flex; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.seg .sg { padding: 3px 12px; cursor: pointer; color: var(--text-muted); user-select: none; white-space: nowrap; transition: background .12s, color .12s; }
.seg .sg + .sg { border-left: 1px solid var(--border); }
.seg .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg .sg.on { background: var(--accent); color: var(--bg); }
/* 选中段是实底，两侧的分隔线压在墨块边上反而脏，去掉 */
.seg .sg.on, .seg .sg.on + .sg { border-left-color: transparent; }
.nseg { font-size: var(--fs-3); }
.nseg .sg { padding: 3px 8px; }
.nseg .sg + .sg { border-left: 1px solid var(--border); }
/* 参数行里的分段控件：铺满它所在的那一行、段内等分；实在挤不下时段文字折行。
   连体件本身 nowrap 又不收缩，装不下时既不换行也不缩 —— 只会直接顶出侧栏被裁掉半个字
   （四条「线型」行的最后一档「点划线 / Dash-Dot」就是这么没的）。 */
.srow > .seg { flex: 1 1 auto; }
.srow > .seg > .sg { flex: 1 1 auto; text-align: center; padding-left: 4px; padding-right: 4px; white-space: normal; }
.sect { display: flex; align-items: center; margin: 12px 0 6px; color: var(--text-muted); }
.sec > .sect:first-child { margin-top: 0; }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.sect .lnk.on { font-weight: 600; text-decoration: underline; }
.sect .lnk:hover { text-decoration: underline; }   /* 与 SatCovPanel / GrdSetSections 同一手感 */
/* 拨杆 .layersw 的画法在 styles/controls.css（设置窗也用同一件，只是大一号）；这里只放主窗的就位规则 */
/* 分区标题里的那颗：钉在行尾右对齐（与环境场开关条的拨杆落在同一条竖线上）。
   不能跟在分区名后面——「点标记/地球站/轨迹」名字不等长，拨杆会逐行左右错开。 */
.sect-layersw { margin-left: 10px; }
/* 一行一个图层开关：名字占满、拨杆贴右（与分区标题上的 .sect-layersw 同一手感，只是降一级） */
.swrow { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: var(--text); }
.swrow > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swrow.dis { color: var(--text-faint); }
.swrow.dis .layersw { opacity: .45; cursor: default; }
/* 图层关掉后分区体退到后景：参数照旧可改，只是当前不出图——因果落在同一屏里 */
.mk-side .sec > :not(.sect) { transition: opacity .15s; }
.mk-side .sec.hid > :not(.sect) { opacity: .5; }
/* 天线设置区标题：撑满分区宽度的标题条（Blender Properties / VS Code 面板头同款），
   与其余 .sect 的纯文字小标题区分开，明确「以下均为当前聚焦天线的属性」 */
.setsect { margin: -12px -16px 10px; padding: 9px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.setsect .ant-svg { width: 14px; height: 14px; color: var(--accent); margin-right: 6px; }
.setsect .setlbl { color: var(--text); font-weight: 600; }
.setsect .setname { margin-left: 6px; color: var(--accent); font-weight: 600; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.list { max-height: 150px; overflow-y: auto; border: 1px solid var(--border); padding: 4px 6px; }
.chk { display: flex; align-items: center; gap: 6px; padding: 2px 0; cursor: pointer; }
.chk .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); }
.empty { color: var(--text-faint); padding: 4px 0; }
.cnt { margin-top: 6px; color: var(--text-faint); font-size: var(--fs-3); }
.cnt .lnk2 { margin-left: 8px; color: var(--accent); cursor: pointer; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; max-height: 120px; overflow-y: auto; }
.chip { padding: 2px 7px; border: 1px solid var(--border); cursor: pointer; border-radius: var(--r-ctl); color: var(--text-muted); font-family: var(--font-mono); font-size: var(--fs-2); }
.chip.on { color: var(--text); }
.chk2 { display: flex; align-items: center; gap: 6px; margin: 8px 0; cursor: pointer; }
.tip { color: var(--text-faint); font-size: var(--fs-2); margin-top: 4px; line-height: 1.5; }
.tip.warn { color: var(--warn, #d98a2b); }
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
/* 卫星行显示开关（卫星名 / 仰角线）：图标按钮，与 .sacts 操作图标以竖线分组，语汇同 .gant .ant-btn（hover 底色淡入） */
.sdisp { flex: none; display: flex; align-items: center; gap: 1px; margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
.sdisp .ic { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: var(--r-box); color: var(--text-faint); opacity: .55; cursor: pointer; transition: opacity .12s, color .12s, background .12s; }
.sdisp .ic:hover { opacity: 1; color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.sdisp .ic.on { opacity: 1; color: var(--accent); }
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

/* 性能指标表浮窗（几何由 JS 控制：可拖拽移动 / 右下角缩放 / 中缝分隔） */
.perf-win { position: absolute; left: 24px; top: 64px; display: flex; flex-direction: column; background: var(--panel, var(--bg)); border: 1px solid var(--border); border-radius: var(--r-float); box-shadow: var(--shadow-3); z-index: 60; overflow: hidden; }
.perf-h { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; cursor: move; user-select: none; }
.perf-t { flex: 1; font-family: var(--font-serif); font-size: var(--fs-4); color: var(--text); }
.perf-t em { font-style: normal; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
.perf-h .csx { cursor: pointer; color: var(--text-faint); padding: 0 4px; position: relative; z-index: 5; }   /* 高于 NE 缩放角，保证可点关闭 */
.perf-h .csx:hover { color: var(--text); }
.ptb { font-size: var(--fs-3); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-card); padding: 2px 8px; cursor: pointer; white-space: nowrap; }
.ptb:hover { color: var(--text); border-color: var(--accent); }
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
.bs-tab.on { background: var(--accent); color: var(--bg); }
.bs-cnt { font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.bs-plist { display: flex; flex-direction: column; gap: 1px; max-height: 172px; overflow-y: auto; margin: 4px 0 2px; padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-card); }
.bs-plist .chk2 { margin: 0; padding: 2px 0; }
.bs-read { display: flex; gap: 12px; flex-wrap: wrap; font-size: var(--fs-2); color: var(--text-muted); margin: 5px 0 2px; font-family: var(--font-mono); }
.bs-read b { color: var(--accent); font-weight: 600; }
/* 天线参数：算出读数（效率/方向性等强调） */
.bs-read2 { display: flex; gap: 14px; flex-wrap: wrap; font-size: var(--fs-3); color: var(--text-muted); margin: 7px 0 3px; font-family: var(--font-mono); }
.bs-read2 b { color: var(--accent); font-weight: 700; font-size: var(--fs-4); }
/* 天线参数：二选一驱动行（左侧单选点＝驱动，选中者可编辑、另一者只读自动算——对齐 SATSOFT 单选按钮） */
.bs-drv > label { width: 56px; cursor: pointer; }
.bs-drv.act > label { color: var(--text); }
.rdo { flex: none; width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--text-faint); box-sizing: border-box; cursor: pointer; transition: border-color .12s, background .12s; }
.rdo:hover { border-color: var(--text-muted); }
.rdo.on { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 2px var(--bg); }
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
.bs-hsrow .ci { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--field-border); background: var(--field-bg); padding: 0 7px; font-size: var(--fs-2); color: var(--text); border-radius: var(--r-box); outline: none; text-align: right; }
.bs-hsrow .hic { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-faint); border: 1px solid transparent; border-radius: var(--r-box); padding: 2px; }
.bs-hsrow .hic:hover { color: var(--text); }
.bs-hsrow .hic.on { color: #ff9a3c; border-color: #ff9a3c; }
.bs-hsrow .hic.hdel:hover { color: #ff6a6a; }
.bs-ops { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5px; margin-bottom: 5px; }
.bs-hex { display: flex; align-items: center; gap: 5px; margin: 5px 0; }
.bs-hex label { font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.bs-hex select { flex: 1; min-width: 0; border: 1px solid var(--field-border); background-color: var(--field-bg); color: var(--text); padding: 2px 6px; font-size: var(--fs-3); border-radius: var(--r-card); outline: none; cursor: pointer; }
.bs-hex select:hover { border-color: var(--accent); }
.opb.sm { padding: 3px 10px; flex: none; }
.chk-in { display: inline-flex; align-items: center; gap: 3px; font-size: var(--fs-2); color: var(--text-muted); white-space: nowrap; }
.chk-in input { margin: 0; }
/* 行内勾选框也是 <label>，会撞上参数行的「标签列宽」——它不是标签列，宽度只该随内容走，
   否则一个「反相」要占满整列宽（英文 92px），把它旁边的下拉挤到看不见选项 */
.srow .chk-in { min-width: 0; }
.bs-list { margin-top: 5px; max-height: 168px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-card); }
.bs-brow { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: var(--fs-2); border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-brow:last-child { border-bottom: none; }
.bs-bi { width: 20px; text-align: center; color: var(--accent); font-family: var(--font-mono); flex: none; }
.bs-bll { flex: 1; color: var(--text-muted); font-family: var(--font-mono); }
.bs-bth { color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-2); white-space: nowrap; }
.bs-bth em { color: var(--text-faint); font-style: normal; }
.bs-status { font-size: var(--fs-2); color: var(--accent); line-height: 1.5; margin-top: 5px; }
.bs-gen { display: flex; justify-content: center; align-items: center; gap: 5px; width: 100%; box-sizing: border-box; margin-top: 4px; background: var(--accent); color: var(--bg); font-size: var(--fs-3); font-weight: 600; padding: 5px 0; border-radius: var(--r-card); cursor: pointer; user-select: none; }
.bs-gen:hover { filter: brightness(1.08); }
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
.bs-reflbar .pgb { cursor: pointer; color: var(--accent); user-select: none; font-size: var(--fs-2); line-height: 1; padding: 2px 4px; }
.bs-reflbar .pgb:hover { filter: brightness(1.2); }
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
.bs-fpcp:hover { border-color: var(--accent); color: var(--text); }
.bs-fpcp.ok { border-color: color-mix(in srgb, #3fb77f 60%, transparent); color: #3fb77f; }
.bs-fptbl { max-height: 176px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--r-card); }
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
.bs-exctbl { max-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-card); }
/* 真 <table>：支持鼠标框选任意行列 → Ctrl+C（浏览器原生按 TSV 复制，粘进 Excel 自动分列） */
.bs-exctable { border-collapse: collapse; width: 100%; font-size: var(--fs-2); font-family: var(--font-mono); }
.bs-exctable th, .bs-exctable td { padding: 2px 7px; text-align: right; white-space: nowrap; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-exctable tbody tr:last-child td { border-bottom: none; }
.bs-exctable thead th { position: sticky; top: 0; background: var(--panel, var(--bg)); color: var(--text-faint); font-weight: normal; z-index: 1; }
.bs-exctable td:first-child { color: var(--accent); }
.bs-exctable tbody tr:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* —— 导航器：波束组列表 + 新建/工具行 —— */
.bs-grps { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 5px; max-height: 190px; overflow-y: auto; }
.bs-grow { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: var(--r-card); cursor: pointer; font-size: var(--fs-3); }
.bs-grow:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-grow.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 10%, transparent); }
.bs-grow.hid { opacity: .5; }
.bs-gk { flex: none; font-size: var(--fs-1); padding: 1px 5px; border-radius: var(--r-box); color: #fff; letter-spacing: var(--ls-tight); }
.bs-gk.gauss { background: #4f8fe8; }
.bs-gk.shaped { background: #3fb77f; }
.bs-gk.pam { background: #a06fdc; }
.bs-gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.bs-grow.on .bs-gname { color: var(--accent); font-weight: 600; }
.bs-gcnt { flex: none; font-size: var(--fs-1); color: var(--text-faint); font-family: var(--font-mono); }
.bs-grow .gic { flex: none; display: inline-flex; color: var(--text-faint); opacity: 0; cursor: pointer; }
.bs-grow:hover .gic, .bs-grow.on .gic { opacity: .75; }
.bs-grow .gic:hover { color: var(--text); opacity: 1; }
.bs-grow .gic.del:hover { color: #ff6a6a; }
.bs-empty { padding: 10px 6px; text-align: center; color: var(--text-faint); font-size: var(--fs-2); border: 1px dashed var(--border); border-radius: var(--r-card); }
.bs-empty2 { padding: 6px 2px; color: var(--text-faint); font-size: var(--fs-3); line-height: 1.6; }
.bs-addrow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-bottom: 5px; }
.bs-navops { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; }
.bs-navops .opb { display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
.opb.dis { opacity: .4; pointer-events: none; }
/* —— 波束设置 chip 条 —— */
.bs-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 6px; }
.bs-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--border); border-radius: var(--r-pill); font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.bs-chip:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-chip.on { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent-ui) 12%, transparent); }
.bs-chip i { width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-chip em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-1); }
.bs-chip.add { color: var(--accent); font-weight: 600; padding: 3px 10px; }
/* —— 检查器折叠头 —— */
/* 图层关掉后分区体退到后景：参数照旧可改，只是当前不出图 —— 与标记面板同一条规则 */
.focus-side .sec > :not(.sect) { transition: opacity .15s; }
.focus-side .sec.hid > :not(.sect) { opacity: .5; }
/* 覆盖圈口径行：数值输入按内容收窄（其余 .srow .ci 是铺满整行的搜索框类），后面跟单位与锁 */
.focus-side .srow .ci { flex: 0 1 76px; text-align: right; font-variant-numeric: tabular-nums; }
.focus-side .srow .u { min-width: 12px; }
/* 口径留空＝按该星的对地全视场画，占位符里就是那个上限值：读成「自动值」而不是已填的数 */
.focus-side .srow .ci::placeholder { color: var(--text-faint); }
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }

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
.cov-legbar.stepped i + i { box-shadow: inset 1px 0 0 var(--panel); }
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
.env-side .envsw { display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 16px; border: 0; border-bottom: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted); font-size: var(--fs-4); text-align: left; cursor: pointer; transition: background .13s, color .13s, box-shadow .13s; }
.env-side .envsw:hover { color: var(--text); background: color-mix(in srgb, var(--text) 5%, var(--surface-2)); }
.env-side .envsw:focus-visible { outline: 1px solid var(--accent); outline-offset: -3px; }
.env-side .envsw.on { color: var(--text); background: color-mix(in srgb, var(--accent-ui) 8%, var(--surface-2)); box-shadow: inset 2px 0 0 var(--accent-ui); }
.env-side .envsw.on:hover { background: color-mix(in srgb, var(--accent-ui) 13%, var(--surface-2)); }
.env-side .envsw-i { flex: none; color: var(--text-faint); transition: color .13s; }
.env-side .envsw.on .envsw-i { color: var(--accent); }
.env-side .envsw-t { flex: 1; min-width: 0; font-weight: 600; }
/* 整条都是热区，故拨杆的 hover 由条子驱动（只悬到条子上、指针没压在拨杆上时也要亮） */
.env-side .envsw:hover .layersw { background: color-mix(in srgb, var(--text) 22%, var(--border-strong)); }
.env-side .envsw.on:hover .layersw { background: color-mix(in srgb, var(--text) 22%, var(--accent)); }
/* 环境场一个面板只有一层，故整面板跟着退到后景（标记面板是一分区一层，压暗落在分区上） */
.env-side.hid .sec { opacity: .5; transition: opacity .15s; }
.env-side .env-src { min-height: 16px; }
.env-side .chk2.dis { opacity: 0.45; cursor: not-allowed; }
.env-side .cov-num { flex: none; width: 54px; }

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
   ① 等宽 flex:1 铺满面板宽度（原为内容宽、左侧挤成一坨）；② 轨道给 --surface 凹槽感、活动段 --accent 实填；
   ③ 活动段文字用 var(--bg) 而非写死 #fff——深色主题 accent≈白，写死白字=白底白字看不见；
   ④ 非活动段悬停给反馈；⑤ 段间加 1px 分隔线，紧邻活动块的分隔线转透明使实色边缘干净。
   仅作用于本控件：.seg.sm 复用面广，用 .seg.sm.vis-mode 提高特指度收窄作用域，不动通用 .seg。 */
.seg.sm.vis-mode { background: var(--surface); border-color: var(--border); }
/* white-space: normal —— 三档挤不下时档名折行，而不是把最后一档顶出侧栏裁掉 */
.seg.sm.vis-mode .sg { flex: 1; min-width: 0; text-align: center; padding: 4px; font-size: var(--fs-3); line-height: 1.25; white-space: normal; color: var(--text-muted); transition: background .12s ease, color .12s ease; }
.seg.sm.vis-mode .sg + .sg { border-left: 1px solid var(--border); }
.seg.sm.vis-mode .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg.sm.vis-mode .sg.on { background: var(--accent); color: var(--bg); font-weight: 600; }
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
.vis-tzseg { display: inline-flex; flex: none; border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; }
.vis-tzseg i { font-style: normal; padding: 1px 7px; cursor: pointer; color: var(--text-faint); font-family: var(--font-mono); font-size: var(--fs-1); line-height: 1.6; user-select: none; }
.vis-tzseg i + i { border-left: 1px solid var(--border); }
.vis-tzseg i.on { background: var(--accent); color: var(--bg); }
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
.mk-tab.on { background: var(--accent); color: var(--bg); }
/* 表体：航迹分页是主从两栏（左栏航迹、右侧航点网格），另两个分页只有网格 */
.mk-main { flex: 1; min-height: 0; display: flex; }
.mk-main > .pin-body { min-width: 0; }
/* —— 航迹左栏 —— */
.mk-trajs { flex: none; width: 156px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 55%, transparent); }
.mtj-h { flex: none; display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 9px; border-bottom: 1px solid var(--border); }
.mtj-ht { flex: 1; font-size: var(--fs-2); color: var(--text-faint); }
.mtj-add { display: inline-flex; align-items: center; gap: 1px; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-box); padding: 1px 5px 1px 3px; cursor: pointer; white-space: nowrap; }
.mtj-add:hover { color: var(--accent); border-color: var(--accent); }
.mtj-list { flex: 1; min-height: 0; overflow-y: auto; padding: 3px 0; }
.mtj-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 9px; cursor: pointer; user-select: none; border-left: 2px solid transparent; }
.mtj-row:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.mtj-row.on { background: color-mix(in srgb, var(--accent-ui) 14%, transparent); border-left-color: var(--accent); }
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
.mtj-x:hover { color: #ff6a6a; }
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
.pr-t em { margin-left: 4px; font-style: normal; font-size: var(--fs-1); font-weight: 400; color: var(--text-faint); border: 1px solid var(--border); border-radius: var(--r-pill); padding: 0 5px; }
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
.eg-host :deep(.eg-act .del:hover) { color: #ff6a6a; }
.eg-host :deep(tr.out td) { color: var(--text-faint); }

/* 性能表选项弹窗 */
.sat-mask.perf-opt-mask { z-index: 70; }   /* 提高特异性压过 .sat-mask(z40)，高于性能表浮窗(z60)避免被遮挡 */
.perf-opt-dlg { width: 700px; max-width: calc(100% - 32px); max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-float); box-shadow: var(--shadow-3); }
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
.pin-gsel:hover { border-color: var(--accent); }
/* —— 城市组管理弹窗 —— */
.sat-mask.perf-grp-mask { z-index: 70; }   /* 压过性能表浮窗(z60)，避免被遮挡 */
.grp-dlg { width: 460px; max-width: calc(100% - 32px); }
.grp-save { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.grp-name { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 4px 8px; font-size: var(--fs-3); color: var(--text); border-radius: var(--r-card); outline: none; }
.grp-name:focus { border-color: var(--accent-ui); }
.grp-save .save { flex: none; background: var(--accent); color: var(--bg); padding: 4px 12px; cursor: pointer; font-size: var(--fs-3); border-radius: var(--r-card); white-space: nowrap; }
.grp-save .save.dis { opacity: .45; pointer-events: none; }
.grp-list { max-height: 300px; overflow-y: auto; }
.grp-row { display: flex; align-items: center; gap: 6px; padding: 5px 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.grp-row.cur { background: color-mix(in srgb, var(--accent-ui) 10%, transparent); }
.grp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-3); color: var(--text); }
.grp-cnt { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-family: var(--font-mono); }
.grp-row .gbtn { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); padding: 1px 7px; cursor: pointer; white-space: nowrap; }
.grp-row .gbtn:hover { color: var(--text); border-color: var(--accent); }
.grp-row .gic { flex: none; display: inline-flex; align-items: center; color: var(--text-faint); cursor: pointer; padding: 1px 2px; }
.grp-row .gic:hover { color: var(--text); }
.grp-row .gic.ok:hover { color: var(--accent); }
.grp-row .gic.del:hover { color: #ff6a6a; }
.grp-row .gic.del.warn { color: #ff6a6a; }
.grp-empty { padding: 18px 8px; text-align: center; font-size: var(--fs-3); color: var(--text-faint); font-style: italic; }

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
.gant .afoc { flex: none; font-size: var(--fs-1); font-weight: 600; letter-spacing: var(--ls-tight); color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-pill); padding: 0 5px; line-height: 14px; }
.gant.noant { color: var(--text-faint); font-style: italic; cursor: default; padding-left: 6px; }
.gant.noant:hover { background: none; color: var(--text-faint); }
/* 行内次级操作（卫星行 ＋✎✕ / 天线行 ✎✕ 共用）：常驻但弱化淡灰，hover 该行变亮 */
.sacts { flex: none; display: flex; align-items: center; gap: 8px; margin-left: auto; padding-left: 4px; }
.sacts .ic { font-size: var(--fs-2); color: var(--text-faint); opacity: .5; cursor: pointer; padding: 0; transition: opacity .12s, color .12s; }
.gsat:hover .sacts .ic, .gant:hover .sacts .ic { opacity: .9; }
.sacts .ic:hover { color: var(--text); opacity: 1; }
.sacts .ic.del:hover { color: #e66; }
/* 设置面板：当前编辑对象提示 */
.grd-side .sect .editing { margin-left: auto; font-size: var(--fs-1); font-weight: 600; color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent); border-radius: var(--r-pill); padding: 1px 6px; }
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
.glvrow .ic.del:hover { color: #d66; }
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
.ic.del:hover { color: #e66; }
.ic.ok { color: #5fbf6a; font-weight: 700; }
.ic.ok:hover { color: #7ddc88; }
.batch { border: 1px solid var(--border); padding: 7px 8px; margin-top: 8px; }
.bah { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.bnm { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bnm:focus { border-color: var(--accent-ui); }
.rng { flex: 1; min-width: 0; }
/* .srow 里的取色框铺满整行（描边/内衬由 controls.css 基线给，这里只管铺开） */
.clr { flex: 1; min-width: 0; height: 22px; }
.swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sw { width: 24px; height: 24px; border-radius: var(--r-box); border: 1px solid var(--border); cursor: pointer; box-sizing: border-box; }
.sw:hover { border-color: var(--accent); }
.sw.on { border: 2px solid var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.sw.swmix { background: conic-gradient(#8fa89b 0 25%, #9fb0c0 0 50%, #c0a99f 0 75%, #b0a98f 0); }
.swd { flex: none; width: 14px; height: 14px; border-radius: var(--r-box); border: 1px solid var(--border); }
.rowlk { cursor: pointer; }
.bsub { display: flex; align-items: center; gap: 8px; margin: 7px 0 4px; color: var(--text-muted); font-size: var(--fs-3); }
.bsub .lnk { color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.bsub .cnt2 { margin-left: auto; color: var(--text-faint); font-size: var(--fs-2); }
/* 边界线分组的小色条图例：颜色/线型由 swStyle 行内给（跟着设置走），这里只留几何 */
.bsub .bsw { width: 18px; height: 0; border-top-width: 2px; border-top-style: solid; flex: 0 0 auto; }
.bsub .lnk { margin-left: auto; }
.bq { display: block; width: 100%; box-sizing: border-box; margin-bottom: 5px; border: 1px solid var(--field-border); background: var(--field-bg); padding: 3px 6px; font-size: var(--fs-3); color: var(--text); outline: none; }
.bq:focus { border-color: var(--accent-ui); }
.chip .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
.pglist { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.pgrow { display: flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); cursor: pointer; }
.addbatch { margin-top: 8px; text-align: center; border: 1px dashed var(--border); padding: 4px; color: var(--accent); cursor: pointer; font-size: var(--fs-3); }
.addbatch:hover { border-color: var(--accent); background: var(--surface); }
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
.plgi { flex: none; color: var(--text-faint); font-size: var(--fs-2); font-family: var(--font-mono); border: 1px solid var(--border); border-radius: var(--r-pill); padding: 0 7px; line-height: 15px; white-space: nowrap; }
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
.opb:hover { border-color: var(--accent); color: var(--text); }
.opb.on { border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent-ui) 10%, transparent); font-weight: 600; }
.opb.danger:hover { border-color: #e05252; color: #e05252; }
.opb.danger.on { border-color: color-mix(in srgb, #e05252 60%, transparent); color: #e05252; background: color-mix(in srgb, #e05252 10%, transparent); font-weight: 600; }
/* 成排等宽的按钮（网格里那几组）：钮名挤不下就折行。钮本身 white-space: nowrap，配上 1fr 轨道的
   auto 下限，长钮名（英文尤甚）会把整排顶出侧栏右沿 —— 轨道已改 minmax(0,1fr)，这里放开折行。 */
.bs-addrow .opb, .bs-navops .opb, .bs-ops .opb, .plgops .opb { white-space: normal; line-height: 1.3; }
.plgta { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 84px; resize: vertical; border: 1px solid var(--field-border); background: var(--field-bg); color: var(--text); font-family: var(--font-mono); font-size: var(--fs-2); padding: 4px 6px; outline: none; }
.plgta:focus { border-color: var(--accent-ui); }
/* 顶点表：文本框 + 右下「复制两列」按钮（Tab 分隔，粘到 Excel 自动分成经度/纬度两列） */
.plgvt { margin-top: 6px; display: flex; flex-direction: column; }
.plgvt .plgta { margin-top: 0; }
.plgcp { align-self: flex-end; display: inline-flex; align-items: center; gap: 4px; margin-top: 5px; padding: 2px 9px; border: 1px solid var(--border); border-radius: var(--r-ctl); color: var(--text-muted); font-size: var(--fs-2); cursor: pointer; white-space: nowrap; }
.plgcp:hover { border-color: var(--accent); color: var(--text); }
.expb2 { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 0; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-3); }
.expb2:hover { border-color: var(--accent); color: var(--text); }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.cst { font-size: var(--fs-2); color: var(--text-faint); }
.cclr { margin-left: auto; font-size: var(--fs-3); color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; }
.cclr:hover { border-color: var(--accent); color: var(--text); }

/* 标记面板 */
.addb { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; border-radius: var(--r-ctl); font-size: var(--fs-3); }
.addb:hover { background: var(--accent); color: var(--bg); }
.ci.nrw { width: 0; }
.mlist { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; max-height: 150px; overflow-y: auto; }
/* 主从列表（边界线七类 / 地名三级）条目固定，不滚 —— 150px 上限是给可能几十条的国家清单的 */
.mlist.pick { max-height: none; overflow: visible; }
/* 国家清单：全量 251 条可滚，给足一屏的高度（150px 只够四行半，翻起来太碎） */
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
.geo-side .sec.hid > :not(.sect) { opacity: .5; }
.mrow .mc2 { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-faint); }
.mrow .sni { flex: 1; min-width: 0; border: 1px solid var(--field-border); background: var(--field-bg); padding: 2px 6px; font-size: var(--fs-3); outline: none; color: var(--text); }
.del { flex: none; cursor: pointer; color: var(--text-faint); padding: 0 2px; }
.del:hover { color: #e26a6a; }
.tcard { border: 1px solid var(--border); padding: 6px; margin-bottom: 6px; }
.tcard.act { border-color: var(--accent); }
.trow { display: flex; align-items: center; gap: 6px; }
.trow .tk { width: 10px; height: 10px; flex: none; border-radius: var(--r-ctl); }
.trow .tk.sea { background: #ff6a4a; }
.trow .tk.flight { background: #5ad1ff; }
.trow .tni { flex: 1; min-width: 0; border: 0; border-bottom: 1px solid var(--field-border); background: transparent; outline: none; color: var(--text); font-size: var(--fs-3); }
.trow .tsel { flex: none; font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); padding: 1px 7px; cursor: pointer; border-radius: var(--r-ctl); }
.trow .tsel.on { color: var(--accent); border-color: var(--accent); }
.twp { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
.twp .wp { font-family: var(--font-mono); font-size: var(--fs-2); color: var(--text-muted); border: 1px solid var(--border); padding: 1px 5px; }
.twp .wdel { margin-left: 4px; cursor: pointer; color: var(--text-faint); }
.twp .wdel:hover { color: #e26a6a; }

.lnknm { cursor: pointer; }
.lnknm:hover { color: var(--accent); }
.tip2 { color: var(--text-faint); font-size: var(--fs-2); line-height: 1.6; }
.tip2 .lnk { margin-left: 6px; color: var(--accent); cursor: pointer; }

/* 卫星编辑弹窗 */
.sat-mask { position: absolute; inset: 0; background: rgba(4,8,14,0.55); display: flex; align-items: center; justify-content: center; z-index: 40; }
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
.sat-dlg { width: 320px; max-height: 86%; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3); display: flex; flex-direction: column; }
.sdh { display: flex; align-items: center; padding: 11px 14px; border-bottom: 1px solid var(--border); font-family: var(--font-serif); font-size: var(--fs-5); }
.sdh .csx { margin-left: auto; cursor: pointer; color: var(--text-faint); }
.sdbody { padding: 12px 14px; }
.sdbody .srow { --srow-lab: 64px; }
.geobtn { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: var(--fs-2); }
.geobtn:hover { background: var(--accent); color: var(--bg); }
.sdiv { margin: 12px 0 8px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--fs-3); }
.sdbody .sdiv:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.pickbtn { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); }
.pickbtn:hover { border-color: var(--accent); color: var(--text); }
.pmode { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: var(--fs-3); }
.pmode:hover { border-color: var(--accent); color: var(--text); }
.pmode.on { border-color: var(--accent); background: var(--accent); color: var(--bg); }
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
.tgtnm.bad { color: #d08b5a; }
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
.sdfoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: var(--fs-3); }
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
.sgm-grow .gic.del:hover, .sgm-grow .gic.del.warn { color: #ff6a6a; }
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
.sgm-right .gbtn:hover { color: var(--text); border-color: var(--accent); }
.sgm-right .gbtn.danger:hover { color: #ff6a6a; border-color: #ff6a6a; }
.sgm-right .gbtn.dis, .sgm-pickbar .save.dis { opacity: .4; pointer-events: none; }
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
.sgm-ck .gic.del:hover { color: #ff6a6a; }
.sgm-pickbar { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 6px; font-size: var(--fs-3); color: var(--text-muted); }
.sgm-pickbar b { color: var(--text); }
.sgm-pickbar .lnk { color: var(--accent); cursor: pointer; }
.sgm-pickbar .save { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; background: var(--accent); color: var(--bg); padding: 3px 12px; border-radius: var(--r-card); cursor: pointer; font-size: var(--fs-3); }
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

/* 地图右键上下文菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 60; }
.ctx-menu { position: fixed; z-index: 61; min-width: 190px; max-height: calc(100vh - 8px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: var(--shadow-3); padding: 4px; font-size: var(--fs-3); color: var(--text); }
.ctx-item { padding: 6px 12px; cursor: pointer; white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ctx-item:hover { background: var(--bg); color: var(--accent); }
.ctx-item.dis, .ctx-item.dis:hover { color: var(--text-muted); opacity: 0.45; cursor: default; background: none; }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }


</style>
