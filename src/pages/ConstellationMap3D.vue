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
import { clock, onTick, goLive, togglePlay, setTime as clockSetTime, stepBy as clockStepBy, setStep as clockSetStep, setSpeed as clockSetSpeed, releaseClock, resumeClock, effective as clockEff, capped as clockCapped, restoreState as clockRestore } from '../stores/simClock'
import { STEP_PRESETS, SPEED_PRESETS, cursorSnapSec, followWindow, snapMs, fmtStep, fmtStepShort, fmtRate, fmtOffset, rateFor } from '../shared/simClockCore.js'
import { logMsg } from '../stores/log'
import { alertMsg, appAlert, closeAlert } from '../stores/alert'
import { displaySatName } from '../viz/satName.js'
import { serializeGxt } from '../viz/gxt/serialize.js'
import { parseGxt } from '../viz/gxt/parse.js'
import { serializeKml } from '../viz/kml/serialize.js'
import { parseKmlPolys } from '../viz/kml/parse.js'
import Icon from '../components/Icon.vue'
import SatList from '../components/SatList.vue'
import MiniSendDialog from '../components/MiniSendDialog.vue'
import { MINI_COVERAGE_SATS, satKey, inMiniList } from '../shared/miniSatList.js'
defineOptions({ inheritAttrs: false })   // 不把父级传入的 title 落到根节点（去掉鼠标悬停的“星座3D”原生提示）
import { createGlobeScene } from '../viz/globe3d/scene.js'
import { createFlatCoverage } from '../viz/flatmap/flatCoverage.js'
import NAMES_ZH from '../viz/globe3d/data/country-names-zh.json'
import { LAND as LAND_MORANDI, LAND_UNIFORMS, LAND_DEFAULT } from '../viz/landPalette.js'
import { countryAt, currentLandColor } from '../viz/globe3d/countryPick.js'
import { useGrdCoverage } from '../viz/grd/useGrdCoverage.js'
import { useBeamSynth } from '../viz/grd/useBeamSynth.js'
import { useVisibility, orbitClass } from '../viz/vis/useVisibility.js'
import { useEnvField } from '../viz/env/useEnvField.js'
import { usePerfTable } from '../viz/grd/usePerfTable.js'
import { useShellCoverage } from '../viz/grd/useShellCoverage.js'
import { useSatPerfTable } from '../viz/grd/useSatPerfTable.js'
import { sampleBeamAtEcef } from '../viz/grd/coverage.js'
import SatCovPanel from '../components/SatCovPanel.vue'
import SatCovWindows from '../components/SatCovWindows.vue'
import SatCovShellPicker from '../components/SatCovShellPicker.vue'
import GrdSetSections from '../components/GrdSetSections.vue'
import { useGridSelect } from '../viz/grd/useGridSelect.js'
import ExcelGrid from '../components/ExcelGrid.vue'
import { sheetModel, exportSheets, importWorkbook, sheetToRecords, sheetToTsv, pickSheet, safeFileName } from '../shared/gridXlsx.js'
import { useMarkerTable, trajsFromSheets } from '../viz/markers/useMarkerTable.js'
import sat from '../viz/constellation/satellite.js'
import { sampleOrbitAdaptive } from '../viz/constellation/adaptiveSample.js'
import { solarGeometry } from '../viz/terminator.js'
import * as W from '../viz/wgs84.js'
import { parseOMMCsv, fetchGroupLiveOrSup } from '../viz/constellation/tle.js'
import { useCustomConstellations, customConstellationsToOmmRecords } from '../viz/constellation/useCustomConstellations.js'
import { useSatGroups } from '../viz/constellation/useSatGroups.js'
import { makeSatSetItem } from '../shared/satconMiniExport.js'
import { walkerCode, orbitPeriodMin, validateWalker } from '../viz/constellation/walker.js'
import { classifyOrbit } from '../shared/orbitClass.js'
import { fmtGeoSlot, geoSlotOfSatrec, geoSlotOfOmm } from '../shared/geoSlot.js'
import { byLang } from '../shared/i18n/lang.js'   // 空名占位是界面语汇，却画在打了 skip 的名字位上（呈现层翻不到），故在这里按语言出字

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
const showProvinces = ref(false)   // 显示中国省界/省名（默认关；勾选或存档恢复后经 ensureProvinces 加载数据）
let provincesLoaded = false
let provincesData = null
const showCities = ref(false)   // 显示中国地级市界 / 地级市名（默认关）
let citiesLoaded = false
let citiesData = null
// 晨昏线（昼夜分界）：默认关。时刻取时间轴当前值 calcAt()（非系统时钟）——拖时间轴 / 实时推进时随之移动，
// 与卫星星位同一个 UTC 时刻、同一个自转相位（GMST 复用 sat.gstime，见 viz/terminator.js）。
const termOn = ref(false)
const termNight = ref(true)     // 夜区半透明遮罩
const termLine = ref(true)      // 晨昏分界线
const termStyle = reactive({ nightColor: '#0a1120', nightOpacity: 0.42, lineColor: '#ffd27a', lineWidth: 1.2, lineOpacity: 0.75 })
const termSub = ref(null)       // 当前日下点 {lat, lon}，供侧栏读数（applyTerminator 时回填）
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

// 环境场（ITU 降雨率 / 零度等温线高度 / 海拔 / 水汽 / 云液态水）：一张等经纬栅格 +（可选）等值线。
// 【专用通道】画在最底层（气象/地形是背景量），与覆盖热力图、GRD 覆盖场互不覆写、可同屏共存。
const env = useEnvField({
  draw: (spec) => {
    if (spec && spec.canvas) {
      const o = { bbox: spec.bbox, alpha: spec.alpha, smooth: spec.smooth }
      if (scene) scene.setEnvRaster(spec.canvas, o)
      if (flat) flat.setEnvRaster(spec.canvas, o)
    } else { if (scene) scene.setEnvRaster(null); if (flat) flat.setEnvRaster(null) }
  },
  drawContours: (groups) => { if (scene) scene.setEnvContours(groups); if (flat) flat.setEnvContours(groups) },
  setAlpha: (a) => { if (scene) scene.setEnvAlpha(a); if (flat) flat.setEnvAlpha(a) }
})
// 光标读数：经纬度（状态栏固有）+ 当前环境场值（有图层时才有）
function onHoverLL(ll) {
  cursor.ll = ll
  cursor.env = ll ? env.readAt(ll.lat, ll.lon) : null
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
    for (const s of (g.sats || [])) { const id = String(s.noradId); if (!grpHit.has(id)) grpHit.set(id, gname) }
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
const countryNameSize = ref(1.0)  // 国家名/大洋名字号倍率（0.6–2.0）
const provNameSize = ref(0.6)     // 省名字号倍率（0.6–2.0）
const cityNameSize = ref(0.2)     // 地级市名字号倍率（小空间，默认偏小）
// 国界(海岸线)/省界/地级市界线样式：线宽 px / 颜色 / 透明度，同时作用于 3D 与平面图
// 地级市界默认更细更淡（线粗支持到 0.05），层级上从属于省界
const borderStyle = reactive({ natColor: '#a8a8a8', natWidth: 0.5, natOpacity: 1.0, provColor: '#878787', provWidth: 0.5, provOpacity: 0.7, cityColor: '#6b7280', cityWidth: 0.5, cityOpacity: 0.15 })
// 地名颜色/透明度：国家名 与 省名 与 地级市名 分开（大洋名维持固有蓝），同时作用于 3D 与平面图
const labelStyle = reactive({ countryColor: '#ffffff', countryOpacity: 1.0, provColor: '#f6fa00', provOpacity: 0.25, cityColor: '#9aa3b0', cityOpacity: 0.25 })
// 大海颜色（限蓝色系预设），同时作用于 3D 球体与平面图底色
// 蓝色系：中→浅（已删除最深档 #0d2b4d、#15426b，观感过暗）；末档 #a3ccff 为更亮的淡蓝（比 #92b6e4 更亮）
// 并设为默认底色；#aacbdf 为低饱和钢蓝、#92b6e4 为略深蓝，均保留可选。
const OCEAN_BLUES = ['#1b5a8c', '#1e6fa8', '#2a85c4', '#3d7ba6', '#5b7f9e', '#92b6e4', '#aacbdf', '#a3ccff']
const oceanColor = ref('#a3ccff')
// 大地颜色：基调方案（'morandi' 杂色循环 | '#rrggbb' 统一单色，预设见 landPalette.LAND_UNIFORMS，首个为 SATSOFT 米绿）
// + 逐国覆盖（优先级最高，含中国/冰盖），同时作用于 3D 球体与平面图。默认统一米黄（与 landPalette 模块默认一致）
const landScheme = ref(LAND_DEFAULT)
const landOverrides = reactive({})   // ISO 数字码 → '#rrggbb'
const landQuery = ref('')            // 逐国设色搜索框
const landPick = ref(null)           // 当前选中国家 { id, zh }
const HEX6 = /^#[0-9a-fA-F]{6}$/
// 可搜索国家列表（台湾并入中国不单列；中国/朝鲜/韩国用通称，与建图口径一致）
const COUNTRY_ZH = Object.keys(NAMES_ZH).filter((id) => id !== '158')
  .map((id) => ({ id, zh: id === '156' ? '中国' : id === '408' ? '朝鲜' : id === '410' ? '韩国' : NAMES_ZH[id][0] }))
  .sort((a, b) => a.zh.localeCompare(b.zh, 'zh-Hans-CN'))
const landHits = computed(() => {
  const q = landQuery.value.trim()
  if (!q || (landPick.value && landPick.value.zh === q)) return []
  return COUNTRY_ZH.filter((c) => c.zh.includes(q)).slice(0, 10)
})
// 选中国家取色器预填：已覆盖→覆盖色；统一基调→基调色；莫兰迪→该国当前实际循环色
const landPickColor = computed(() => {
  const p = landPick.value
  if (!p) return '#e4eccf'
  return landOverrides[p.id] || (landScheme.value !== 'morandi' ? landScheme.value : currentLandColor(p.id))
})
const landOvList = computed(() => Object.entries(landOverrides).map(([id, color]) => ({ id, color, zh: (COUNTRY_ZH.find((c) => c.id === id) || {}).zh || id })))
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
  return { id: null, name: '自定义星座', pattern: 'delta', T: 24, P: 6, F: 1, incl: 53, shape: 'circ', perigeeKm: 550, apogeeKm: 550, argp: 0, raan0: 0, m0: 0, color: '#4dabf7', colorByPlane: true }
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
// 只「算」不「推」：返回选中星 3D items（轨道/轨迹/足迹/在轨点），并写入 selGeomAll(2D)、selHl(primary 金色高亮环)
// 与 beam 夹断占位。实际提交交由 commitGeometry 与可见性叠加层、对星聚焦特效合并
//（三者共用 setSelectionSet / setFocusSatLLA / setHighlightLLA replace-all 通道，故必须一次性喂）。
let selHl = null   // primary 选中星的高亮环位置（null=无），由 footprintFor 回填
// —— 多选聚焦的细节分档 ——
// 每颗选中星每次刷新都要重算整圈轨道 + 足迹（一次 SGP4/采样点），故按颗数摊薄采样：
// 少量选中保持满细节，多了就降采样。线已在 3D 端按样式合批（见 scene.setSelectionSet），
// 对象数与颗数无关，剩下的成本主要就是这里的 SGP4。
const FOCUS_FULL_N = 24            // 这个颗数以内保持满细节（与单选完全一致）
const FOCUS_SAMPLE_BUDGET = 2880   // 超出后每次刷新的轨道采样点总预算（= 24 × 120）
const FOCUS_SAMPLE_MIN = 24        // 单颗采样下限：再少轨道圈就看得出折线
const FOCUS_FP_BUDGET = 1728       // 足迹分段总预算（= 24 × 72）
const FOCUS_FP_MIN = 18
// 逐颗一个 30px 星下点图标：几十颗尚可读，上百颗互相盖住只剩开销 → 超过就只留主选那一个
const FOCUS_ICON_MAX = 120
// 画几何的颗数上限：选中集本身不设限（信息卡、存为组、加入组都按全部算），
// 超出的只是不再画轨道/轨迹/足迹 —— 那个量级下叠画本就是一团糊，且每秒重算扛不住。
const FOCUS_GEOM_MAX = 600
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
function computeSelectedGeometry() {
  selGeomAll = []; selHl = null
  if (!scene || !selEntries.length) return []
  const now = calcAt(), gmstNow = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmstNow = sat.gstime(ccNow)   // 合成星按场景历元解算（跨会话稳定）
  const items = []
  let draw = selEntries
  if (selEntries.length > FOCUS_GEOM_MAX) {
    draw = selEntries.slice(0, FOCUS_GEOM_MAX)
    // 主选必须在画的这批里：高亮环与 beam ε=0 上限占位都由它回填（footprintFor 的 primary 分支）
    if (selEntry && !draw.includes(selEntry)) draw[draw.length - 1] = selEntry
  }
  const lod = focusLod(draw.length)
  draw.forEach((e) => {
    const rec = e.rec
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmstNow : gmstNow
    const periodMin = (2 * Math.PI) / rec.no
    // 一个周期自适应采样（大椭圆近地点段自动加密），轨道圈与轨迹共用
    const samples = sampleOrbitAdaptive(rec, t, periodMin, lod.samples, lod.stepDeg)
    const orbit = samples.map((s) => {
      const gd = sat.eciToGeodetic(s.pv.position, g)
      return { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), altKm: gd.height }
    })
    const track = samples.map((s) => ({ lat: s.lat, lon: s.lon }))
    const primary = e === selEntry
    const fp = footprintFor(rec, t, g, primary, lod.fpSeg)   // primary 顺带更新高亮环 + beam ε=0 上限占位
    // 选中星当前在轨位置：供 3D 在该处画大号「在轨点」（跟随星点原色，压在细轨道之上）
    let satPos = null
    try {
      const pvNow = sat.propagate(rec, t)
      if (pvNow && pvNow.position) {
        const gdN = sat.eciToGeodetic(pvNow.position, g)
        satPos = { lat: sat.degreesLat(gdN.latitude), lon: sat.degreesLong(gdN.longitude), altKm: gdN.height, color: satDotHex(e) }
      }
    } catch { satPos = null }
    selGeomAll.push({ track, footprint: fp })              // 全体几何缓存供 2D 平面图（每颗都画，非仅主星）
    items.push({ orbit, track, footprint: fp, primary, satPos })
  })
  return items
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
    const samples = sampleOrbitAdaptive(rec, t, (2 * Math.PI) / rec.no)     // 一周期自适应采样，与选中星同源
    const orbit = samples.map((q) => { const d = sat.eciToGeodetic(q.pv.position, g); return { lat: sat.degreesLat(d.latitude), lon: sat.degreesLong(d.longitude), altKm: d.height } })
    const track = samples.map((q) => ({ lat: q.lat, lon: q.lon }))
    const ecf = sat.eciToEcf(pv.position, g)
    const fp = footprintAtEcef([ecf.x, ecf.y, ecf.z], h)
    return { item: { orbit, track, footprint: fp, primary: false, satPos: { lat, lon, altKm: h, color } }, sub: { lat, lon }, flat: { track, footprint: fp } }
  } catch { return null }
}
function focusGeomStatic(node, color) {
  const lon = Number(node.lon), lat = Number(node.lat), h = Number(node.altKm)
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !(h > 0)) return null
  const fp = footprintAtEcef(W.geodeticToEcef(lon, lat, h), h)
  return { item: { footprint: fp, primary: false, satPos: { lat, lon, altKm: h, color } }, sub: { lat, lon }, flat: { footprint: fp } }
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

// 统一提交：把「聚焦星几何」与「可见性叠加层」合并后一次性喂给共用的 replace-all 通道
// （3D setSelectionSet / setFocusSatLLA、2D setFocusSat / setSelGeom），二者可同时呈现、各随时间轴移动。
// 修复：此前可见性激活时 buildSelectedGeometry / pushFocusSat 被 !vis.open 门控掉、且 buildVisibilityGeometry
// 无目标时清空整个通道 → 聚焦星星下点/轨迹消失、时间轴推进时不再更新。改为合并提交后二者不再互相覆盖。
function commitGeometry() {
  if (!scene) return
  const selItems = computeSelectedGeometry()
  const vg = vis.open.value ? computeVisibilityGeometry() : { items: [], subs: [] }
  const sf = computeSatcovFocusGeometry()               // 对星覆盖分析的聚焦特效（不在该视图时为空）
  scene.setSelectionSet([...selItems, ...vg.items, ...sf.items])
  // 金色高亮环：点选主星 + 对星聚焦的每颗星。整条通道每次全量重喂 —— 空选时喂空即清环，
  // 不再需要单独一句「无聚焦星就清环」（computeSelectedGeometry 空选不经 footprintFor，selHl 已置 null）
  scene.setHighlightLLA([...(selHl ? [selHl] : []), ...sf.rings])
  const focus = focusSubpoints()                        // 聚焦星星下点（白·默认大小；无选中时为 []）
  scene.setFocusSatLLA([...focus, ...vg.subs, ...sf.subs])   // + 可见星星下点（面板色/大小，每点自带 px/colorHex）
  if (flat) flat.setFocusSat([...focus, ...sf.subs2d])  // 2D 聚焦星下点；可见星走 overlaySpec 的 sats（redrawSats）
  pushSelGeomFlat(sf.flat)
}

// 聚焦卫星几何缓存列表（推 2D 平面图：覆盖范围 + 星下点轨迹，与 3D 同源，多选=每颗都缓存）
let selGeomAll = []
// extra：对星覆盖分析聚焦特效的几何（同款画法，与聚焦星并列，不入 selGeomAll 缓存）
function pushSelGeomFlat(extra) {
  if (flat) flat.setSelGeom(extra && extra.length ? [...selGeomAll, ...extra] : selGeomAll)
}

// 覆盖足迹圈，两种定义方式（fpMode）：
//   beam — 与 2D 同一套几何（全波束角 B，半角 η=B/2；地心半角 λ=arcsin(r/RE·sinη)−η，夹断到 ε=0 上限）
//   elev — 按地面最低仰角画等仰角环（0°=可见地平，与 beam 模式空值时的上限同界）
// 返回该星覆盖足迹点列（或 null）；primary=true 时顺带更新高亮环与 beam ε=0 上限占位。纯函数，不直接改场景足迹层（由 setSelectionSet 统一绘制）。
// seg：足迹分段数（多选时按颗数摊薄，见 focusLod）；省略取满细节。
function footprintFor(rec, now, gmstNow, primary, seg) {
  const pv = sat.propagate(rec, now)
  if (!pv || !pv.position) { if (primary) selHl = null; return null }
  const gd = sat.eciToGeodetic(pv.position, gmstNow)
  const lat0 = sat.degreesLat(gd.latitude), lon0 = sat.degreesLong(gd.longitude), h = gd.height
  if (primary) selHl = { lat: lat0, lon: lon0, altKm: h }
  if (!(h > 0)) return null
  const ecf = sat.eciToEcf(pv.position, gmstNow)   // 卫星 ECEF(km)，按 WGS84 椭球求足迹边
  const lim = {}
  const fp = footprintAtEcef([ecf.x, ecf.y, ecf.z], h, lim, seg)
  if (primary && lim.bMaxDeg != null) {
    // placeholder 常显 ε=0 上限；用户超限回写夹断值（锁定态不回写）
    const autoText = lim.bMaxDeg.toFixed(1)
    if (autoText !== beamAuto.value) beamAuto.value = autoText
    if (lim.clampText != null && !beamLock.value && lim.clampText !== beam.value) beam.value = lim.clampText
  }
  return fp
}
// 足迹的纯几何部分（按当前 fpMode 口径），不碰高亮环/占位符：footprintFor 与「对星覆盖分析聚焦特效」共用同一定义。
// ecef=卫星 ECEF(km)，h=轨道高度 km；lim=可选出参，回填 { bMaxDeg, clampText } 供调用方写占位符（仅 beam 模式）。
function footprintAtEcef(ecef, h, lim, seg) {
  if (!ecef || !(h > 0)) return null
  const n = seg > 0 ? Math.max(6, Math.round(seg / 2) * 2) : 72   // 取偶数：足迹虚线是隔段取一画一，奇数会丢掉末段
  if (fpMode.value === 'elev') {
    const raw = parseFloat(elevMin.value)
    const el = raw >= 0 && raw < 90 ? raw : 0
    const ring = W.isoElevationContourAt(ecef, el, Math.round(n * 5 / 3))   // 等仰角环满细节 120（=72×5/3），随 seg 同比摊薄
    return ring ? ring.map(([lon, lat]) => ({ lat, lon })) : null
  }
  const etaMax = Math.asin(clamp(RE / (RE + h), -1, 1))
  const bMaxDeg = 2 * etaMax / DEG
  const raw = parseFloat(beam.value)
  let bDeg, clampText = null
  if (!(raw > 0)) bDeg = bMaxDeg
  else if (raw > bMaxDeg) { bDeg = bMaxDeg; clampText = bMaxDeg.toFixed(1) }
  else bDeg = raw
  if (lim) { lim.bMaxDeg = bMaxDeg; lim.clampText = clampText }
  return W.footprintEllipsoid(ecef, (bDeg / 2) * DEG, n)
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
function refreshPositions() {
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
  resetBeam(); selEntries = []; selEntry = null; selected.value = null; selList.value = []; scene && scene.clearSelectionGeom(); selGeomAll = []; pushSelGeomFlat()
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
      if (pool.length) { searchPool = pool; poolReady = true; _poolByNorad = null; poolTick.value++ }   // 就绪信号：卫星组行内列表重映射补 GEO 定点标注
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
function closeCard() { selEntries = []; selEntry = null; selected.value = null; selList.value = []; resetBeam(); selGeomAll = []; pushMarkers(); commitGeometry(); saveSelection() }   // commitGeometry 清聚焦星几何/星下点；可见性叠加层（若开）保留

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
function slotByNorad(nid) {
  if (!poolReady) return ''
  if (!_poolByNorad) { _poolByNorad = new Map(); for (const en of searchPool) _poolByNorad.set(String(en.noradId), en) }
  const en = _poolByNorad.get(String(nid))
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
// 选中集不截断（信息卡、存为组、加入组都按全部算）；画多少细节由 focusLod / FOCUS_GEOM_MAX 分档决定。
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
  if (hit.length > FOCUS_GEOM_MAX) parts.push(`前 ${FOCUS_GEOM_MAX} 颗画轨道与足迹`)
  if (hit.length > FOCUS_ICON_MAX) parts.push('星下点图标只画主选那颗')
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
function onBeam(e) { beam.value = e.target.value; refreshFootprint() }
function onElevMin(e) { elevMin.value = e.target.value; refreshFootprint() }
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

// ===================== 时间轴 =====================
const track = ref(null)
// —— 可配置时间窗 + 自适应刻度尺（参考 Cesium Timeline / DAW scrubber）——
const PAST_FRAC = 0.25                                   // 窗口内展示的「过去」占比（可回看过去）
// 跨度上下限：2min ~ 30 天。★下限压到 2 min 是为了游标的秒级——600 px 上 2 min ＝ 0.2 s/px，
// 拖动吸附随之细到 1 s（见 cursorSnapSec）；原来的 10 min 下限只能吸到 5~10 s。
const WIN_MIN = 2, WIN_MAX = 43200
const WINDOW_PRESETS = [{ v: 10, l: '10m' }, { v: 60, l: '1h' }, { v: 360, l: '6h' }, { v: 1440, l: '24h' }, { v: 4320, l: '3d' }, { v: 10080, l: '7d' }]   // 时间窗预设
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
function trackDown(e) {
  if (!track.value) return
  track.value.focus()
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
  if (h) e.preventDefault()
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
// 拍率 = 倍速 ÷ 步长，夹在 [0.2, 30] —— 顶住时实际倍速打折，读数如实并列（见 clockEff/clockCapped）。
// 播放中游标跑出可见窗口 → 平移尺子把它接回来（不是夹住游标：夹住等于播放撞墙停住）。
const stepText = computed(() => fmtStep(clock.stepSec))
const speedText = computed(() => fmtRate(clock.speed) + '×')
// 三个数可能不一样：设定倍速（下拉里）/ 步长顶住后实际能达到的 / 机器真跑出来的。
// ★ 只在【和设定值不一样】时才出现这行读数 —— 一致时它就是旁边下拉里的同一个数，摆着只会让人以为
//   自己漏看了什么（截图里那个孤零零的「10×」正是这个毛病）。
const speedNote = computed(() => {
  const eff = clockEff.value, out = []
  if (clockCapped.value) out.push(`实际 ${fmtRate(eff)}×`)
  if (clock.mode === 'play' && clock.achieved > 0 && Math.abs(clock.achieved - eff) / eff > 0.12) out.push(`实测 ${fmtRate(clock.achieved)}×`)
  return out.join(' · ')
})
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
function toggleRotate() { autoRotate.value = !autoRotate.value; scene && scene.setAutoRotate(autoRotate.value) }
function setNameMode(m) { nameMode.value = m; scene && scene.setLabelMode(m); if (flat) flat.setNameMode(m) }
// 省界/市界：按开关加载数据（一次）并套用可见性。开关切换与「默认开启的无存档首启」共用同一路径
async function ensureProvinces() {
  if (showProvinces.value && !provincesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-provinces.json'); provincesData = mod.default || mod; scene && scene.setProvinces(provincesData); if (flat) flat.setProvinces(provincesData); provincesLoaded = true }
    catch (e) { /* 省界数据缺失 */ }
  }
  scene && scene.setProvincesVisible(showProvinces.value)
  if (flat) flat.setProvincesVisible(showProvinces.value)
}
async function ensureCities() {
  if (showCities.value && !citiesLoaded) {
    try { const mod = await import('../viz/globe3d/data/china-cities.json'); citiesData = mod.default || mod; scene && scene.setCities(citiesData); if (flat) flat.setCities(citiesData); citiesLoaded = true }
    catch (e) { /* 地级市数据缺失 */ }
  }
  scene && scene.setCitiesVisible(showCities.value)
  if (flat) flat.setCitiesVisible(showCities.value)
  applyNameScale()   // 套用当前地级市名字号（首次加载后生效）
}
async function toggleProvinces() { showProvinces.value = !showProvinces.value; await ensureProvinces() }
async function toggleCities() { showCities.value = !showCities.value; await ensureCities() }

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
    feedFlat()   // 内含 resize → base 就绪，之后才能正确 setView
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
  if (sideCtx() === 'satcov') satcov.recompute()   // 对星视图占着 2D 那块场（见 ownsFlatField）→ 上一行被闸住，改由它来喂
  env.redraw()      // 环境场：平面图是懒创建的，切过来时把当前图层（栅格+等值线）补喂一份
  applyTerminator() // 晨昏线：同上，平面图懒创建，切过来补喂当前时刻那一份（关着则清层）
  redrawSats()      // 卫星/仰角线图层（含 Polygon）
  syncEdit()        // 调点态（Polygon / 标记「调整点位置」）：切入平面图时接上拖拽
  commitGeometry()  // 聚焦卫星位置 + 覆盖范围 + 星下点轨迹（含可见性叠加层，若开）
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
// fmt: 'png2' | 'png4' | 'png6' | 'pdf' | 'gxt' | 'kml'。
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
    feedFlat()   // resize() 仅首帧 fit，已交互过的缩放/平移会保留 → view 模式即所见即所得
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
      const factor = fmt === 'png6' ? 6 : fmt === 'png4' ? 4 : 2
      const bytes = await renderFlatPNG(flat, { base: 2400, factor, view })
      await saveExport(bytes, `覆盖图_${tag}_${factor}x.png`, [{ name: 'PNG 图片', extensions: ['png'] }])
    }
  } catch (e) { console.error('导出失败', e); appAlert('导出失败：' + ((e && e.message) || e)) }
  finally { exporting.value = false; exportFlat.value = false }
}

// 3D 球体截图：把渲染分辨率抬到倍率再取一帧（机位/图层/主题一概不动 → 所见即所得）。
// 出的是 WebGL 画布本身，不含叠在它上面的 HTML 面板（聚焦卡片 / 图例）——与 2D 出图只画地图同口径。
// PNG 按菜单倍率（2×/4×/6×）；PDF 是一页一张位图（球面没有几何可矢量化），固定 4×。
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
      const r = await renderGlobePNG(scene, { factor: fmt === 'png6' ? 6 : fmt === 'png2' ? 2 : 4 })
      // 文件名写实际倍率：显存不够时 snapshot 会降档，此处如实反映（如 6 倍要不下来就写 4.7x）
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
function applyNameScale() { if (scene) scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value); if (flat) flat.setSizes({ nameScale: countryNameSize.value, provScale: provNameSize.value, cityScale: cityNameSize.value }) }
function setCountryNameSize(e) { countryNameSize.value = Number(e.target.value); applyNameScale() }
function setProvNameSize(e) { provNameSize.value = Number(e.target.value); applyNameScale() }
function setCityNameSize(e) { cityNameSize.value = Number(e.target.value); applyNameScale() }
// 国界/省界线样式 → 3D 与平面图。{ ...borderStyle } 取响应式对象快照传入两个渲染器。
function applyBorderStyle() { const s = { ...borderStyle }; if (scene) scene.setBorderStyle(s); if (flat) flat.setBorderStyle(s) }
// 地名颜色/透明度 → 3D 与平面图。
function applyLabelStyle() { const s = { ...labelStyle }; if (scene) scene.setLabelStyle(s); if (flat) flat.setLabelStyle(s) }
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
function toggleTerm() { termOn.value = !termOn.value; applyTerminator() }
function toggleTermNight() { termNight.value = !termNight.value; applyTerminator() }
function toggleTermLine() { termLine.value = !termLine.value; applyTerminator() }
// 大海颜色 → 3D 与平面图。
function setOceanColor(c) { oceanColor.value = c; if (scene) scene.setOceanColor(c); if (flat) flat.setOceanColor(c) }
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
  // 环境场：进入即取数并铺图层；离开只收面板不撤图层（气象/地形是底图性质的背景，切走还得看得见）
  if (side === 'env') env.openPanel()
  else if (env.open.value) env.close()
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
function satPosDone() { satPosEdit.value = null }
watch(satModal, () => { satPosEdit.value = null })   // 换一颗星/开关弹窗：草稿作废，免得串到下一格

const defaultElements = () => ({ altKm: 500, ecc: 0, incl: 53, raan: 0, argp: 0, ma: 0 })
function defaultSatDraft() {
  return { folder: null, name: '', lon: 0, lat: 0, altKm: GEO_ALT, color: '#ffffff', els: '5,10', noradId: null, posMode: 'fixed', elements: defaultElements(), elevWidth: 1.3, elevLabelSize: 18, iconSize: 10, labelSize: 4, iconShow: true, labelShow: true }
}
// hideViz：从文件管理器调起时为 true，隐藏可视化项（图标/字号/仰角线/颜色），其余功能（定位方式/星座关联）一致
function openAddSat(hideViz = false) { satModal.value = { ...defaultSatDraft(), hideViz }; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
// 编辑已有卫星（含预置星）：名称/位置/关联/仰角线/图标与标签大小都可改
function editSat(node, hideViz = false) { satModal.value = { folder: node.folder, name: node.satName, lon: node.lon, lat: node.lat, altKm: node.altKm, color: node.elevColor, els: node.els, noradId: node.noradId, kind: node.kind, posMode: node.elements ? 'orbit' : 'fixed', elements: node.elements ? { ...node.elements } : defaultElements(), elevWidth: node.elevWidth || 1.3, elevLabelSize: node.elevLabelSize || 18, iconSize: node.iconSize || 10, labelSize: node.labelSize || 4, iconShow: node.iconShow !== false, labelShow: node.labelShow !== false, hideViz }; satPick.value = false; satSearchKw.value = ''; satSearchRes.value = [] }
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
    const patch = { satName: (m.name || '卫星').trim() || '卫星', lon, lat, altKm, noradId: m.noradId || null, elements: orbit ? elements : null, els: m.els || '', elevColor: m.color || '#66ddff', elevWidth: Number(m.elevWidth) || 1.3, elevLabelSize: Number(m.elevLabelSize) || 18, iconSize: Number(m.iconSize) || 10, labelSize: Number(m.labelSize) || 4, iconShow: m.iconShow !== false, labelShow: m.labelShow !== false }
    if (m.kind !== 'preset') patch.kind = m.noradId ? 'linked' : (orbit ? 'orbit' : 'custom')
    grd.updateSatellite(m.folder, patch)
  } else {
    grd.addSatellite({ name: m.name, lon, lat, altKm, noradId: m.noradId, elements, els: m.els, color: m.color, elevWidth: m.elevWidth, elevLabelSize: m.elevLabelSize, iconSize: m.iconSize, labelSize: m.labelSize, iconShow: m.iconShow, labelShow: m.labelShow })
  }
  closeSatModal(); redrawSats()
  // 改星位＝天线基底变了：对星覆盖的壳层投影与聚焦特效都得跟着重算（对地那条由 updateSatellite 内的
  // reprojectSat 兜住；壳层是另一条通道，不重算就停在旧星位上）。同 toggleSatLabel：不按视图门控，
  // 没画过由 _painted 闸早退
  satcov.scheduleRecompute(); commitGeometry()
}
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
const stIconSize = ref(16)         // 地球站图标大小（5–60，默认 16）
const stFontSize = ref(17)         // 地球站名称字号（1–32）
const trajDotSize = ref(2.5)       // 轨迹圆点大小（半径口径，1–10，默认偏小）
const showPtLabel = ref(false)     // 是否显示点标记坐标文字（默认不显示；圆点不受影响）
const showStName = ref(false)      // 是否显示地球站名称文字（默认不显示；图标不受影响）
const showPtLayer = ref(true)      // 点标记图层显隐（小眼睛；隐藏仅停止渲染，数据保留并持久化）
const showStLayer = ref(true)      // 地球站图层显隐（小眼睛）
const showTrajLayer = ref(true)    // 航迹图层显隐（小眼睛）
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

// 全部聚焦卫星的实时星下点列表（多选=每颗一个，同款图标不分主次；主次区分靠轨道加粗+高亮环）
function focusSubpoints() {
  if (!selEntries.length) return []
  // 逐颗一个 30px 图标：几十颗尚可读，上百颗互相盖住只剩开销 → 超过 FOCUS_ICON_MAX 只画主选那一颗
  const list = selEntries.length > FOCUS_ICON_MAX ? (selEntry ? [selEntry] : []) : selEntries
  if (!list.length) return []
  const now = calcAt(), gmst = sat.gstime(now)
  const ccNow = ccTimeAt(now), ccGmst = sat.gstime(ccNow)   // 合成星按场景历元解算
  const out = []
  for (const e of list) {
    const cc = isCustomEntry(e), t = cc ? ccNow : now, g = cc ? ccGmst : gmst
    const pv = sat.propagate(e.rec, t)
    if (!pv || !pv.position) continue
    const gd = sat.eciToGeodetic(pv.position, g)
    out.push({ lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude) })
  }
  return out
}
// 聚焦星下点的推送已并入 commitGeometry（与可见性叠加层合并到共用 replace-all 通道，避免相互覆盖）。

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
const markSizes = () => ({ ptFont: markPtFont.value, stIcon: stIconSize.value, stFont: stFontSize.value, ptDot: markPtDot.value, trajDot: trajDotSize.value })
// 标记载荷构造器：坐标/名称是否带文字由 showPtLabel/showStName 决定（空串=圆点/图标保留、文字隐藏）。
// pushMarkers 与 feedFlat 共用，避免两处各写一份导致显隐口径不一致。
// 图层隐藏（小眼睛关）时返回空数组：仅停止渲染，points/stations/trajectories 原始数据不动、照常持久化。
// finite 守卫：批量表格里坐标可能暂空(null)——只渲染坐标齐全的点/站/航点，避免 NaN 画到画布
const finLL = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)
const markerPts = () => showPtLayer.value ? points.value.filter(finLL).map((p) => ({ lat: p.lat, lon: p.lon, label: showPtLabel.value ? fmtLL(p.lat, p.lon) : '', el: fmtElev(p.lat, p.lon) })) : []
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
const timeParts = computed(() => {
  const p = (n) => String(n).padStart(2, '0')
  const tag = tzUtc() ? 'UTC' : localTzLabel.value
  const d = new Date(clock.tMs)
  const md = `${p(tMon(d) + 1)}-${p(tDay(d))}`
  const hms = `${p(tHour(d))}:${p(tMin(d))}:${p(tSec(d))}`
  if (live.value) return { m: hms, s: `${md} 实时 ${tag}` }
  return { m: hms, s: `${md} ${atNow.value ? '此刻' : fmtOffset(relNowMs.value)} ${tag}` }
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
    nameMode: nameMode.value, countryName: countryNameSize.value, provName: provNameSize.value, cityName: cityNameSize.value, showProvinces: showProvinces.value, showCities: showCities.value, borderStyle: { ...borderStyle }, labelStyle: { ...labelStyle }, termOn: termOn.value, termNight: termNight.value, termLine: termLine.value, termStyle: { ...termStyle }, tzMode: tzMode.value, oceanColor: oceanColor.value, landScheme: landScheme.value, landOverrides: { ...landOverrides }, groupColors: { ...groupColors }, autoRotate: autoRotate.value, autoRotateSpeed: viewPrefs.autoRotateSpeed, live: live.value, clock: { stepSec: clock.stepSec, speed: clock.speed }, beamLock: beamLock.value, fpMode: fpMode.value, beam: beam.value, elevMin: elevMin.value, windowMin: windowMin.value,
    mkPt: markPtFont.value, mkStIcon: stIconSize.value, mkStFont: stFontSize.value, mkPtDot: markPtDot.value, mkTrajDot: trajDotSize.value,
    mkPtShow: showPtLabel.value, mkStShow: showStName.value,
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
  scene.setNameScale(countryNameSize.value, provNameSize.value, cityNameSize.value)
  if (s.borderStyle && typeof s.borderStyle === 'object') Object.assign(borderStyle, s.borderStyle)
  applyBorderStyle()
  if (s.labelStyle && typeof s.labelStyle === 'object') Object.assign(labelStyle, s.labelStyle)
  applyLabelStyle()
  // 大海颜色：恢复已存值。一次性默认升级——旧默认 #2a85c4（从未手动改过海色的旧快照）自动升到新的
  // 淡蓝默认 #a3ccff，让老用户更新后即用新默认海色；想要旧蓝再点回该色块即可。
  if (typeof s.oceanColor === 'string') setOceanColor(s.oceanColor === '#2a85c4' ? '#a3ccff' : s.oceanColor)
  // 大地颜色：基调 + 逐国覆盖。默认态（LAND_DEFAULT 且无覆盖）不触发陆地重建，避免启动白做一次
  if (s.landScheme === 'morandi' || (typeof s.landScheme === 'string' && HEX6.test(s.landScheme))) landScheme.value = s.landScheme
  if (s.landOverrides && typeof s.landOverrides === 'object') {
    for (const [k, v] of Object.entries(s.landOverrides)) if (typeof v === 'string' && HEX6.test(v)) landOverrides[k] = v
  }
  if (landScheme.value !== LAND_DEFAULT || Object.keys(landOverrides).length) applyLandColors(true)
  // 在轨现实星座分组配色（renderHasColor 由随后 loadGroup→rebuildRenderSet 一并算入）
  if (s.groupColors && typeof s.groupColors === 'object') {
    for (const [k, v] of Object.entries(s.groupColors)) if (groupColorable(k) && typeof v === 'string' && HEX6.test(v)) groupColors[k] = v.toLowerCase()
  }
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
  if (s.fpMode === 'elev') fpMode.value = 'elev'
  if (typeof s.beam === 'string') beam.value = s.beam
  if (typeof s.elevMin === 'string') elevMin.value = s.elevMin
  if (Number.isFinite(s.windowMin)) { windowMin.value = clamp(Math.round(s.windowMin), WIN_MIN, WIN_MAX); winStartMin.value = -PAST_FRAC * windowMin.value }
  if (typeof s.polyOpen === 'boolean') polyOpen.value = s.polyOpen
  // 省界/市界开关：默认开，存档里的显式 false 也要恢复；数据加载统一走挂载尾部的 ensureProvinces/ensureCities
  if (typeof s.showProvinces === 'boolean') showProvinces.value = s.showProvinces
  if (typeof s.showCities === 'boolean') showCities.value = s.showCities
  if (s.tzMode === 'utc' || s.tzMode === 'local') tzMode.value = s.tzMode   // 时间轴读数时区档位（仅显示）
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
// 「文件」菜单「导入 TLE 文件(CSV)」：与「文件管理 · 星历」的「导入星历」同一持久化通路——原生选文件 →
// 主进程 customSats.importFile 校验去重后落库 custom.json（每文件一组）。这样导入的星历既进「自定义卫星」
// 分组与搜索池，也能在文件管理里查看/改名/导出/删除。（旧路径只临时 ingest 到场景不落库，故文件管理看不到，
// 且只认 OMM CSV 不认真正的 TLE；改走此通路后两者一并修复。）
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
  covNav.importTle = importTleToLibrary   // 「文件」菜单「导入 TLE 文件(CSV)」入口 → 落库自定义卫星（贯通文件管理/搜索池）
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
  unsubClock = onTick(() => refreshPositions())
  resumeClock()   // 上次离开本页时若在实时/播放，回来接着走（时刻与模式都留在 store 里）
  // 「真实此刻」参考量的心跳：只写一个 ref（红色「此刻」标记的位置 + 偏移读数 + 此刻按钮的可用性），
  // 不碰星位、不碰场景。没有它的话，暂停期间这三样会冻在最后一拍上 —— 停十分钟后点「此刻」会发现按钮是灰的。
  nowBeat = setInterval(() => { nowStamp.value = Date.now() }, 1000)
  scene = createGlobeScene(el.value, { ...displayQuality.value })
  scene.setAutoRotate(autoRotate.value)
  scene.setLabelMode(nameMode.value)
  scene.setBorderStyle({ ...borderStyle })
  scene.setLabelStyle({ ...labelStyle })
  scene.setOceanColor(oceanColor.value)
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
  applyDisplayQuality()   // 套用当前画质档位（含低/中档的 50m 底图按需加载）
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
  cursor.ll = null; cursor.env = null; if (ro) ro.disconnect(); if (trackRo) trackRo.disconnect(); if (flat) flat.destroy(); if (scene) { scene.clearCoverage(); scene.destroy() }
})
</script>

<template>
  <div class="g3" ref="g3el">
    <div class="body">
      <div class="stage-wrap">
        <div ref="el" class="stage"></div>
        <canvas v-show="flatView" ref="flatCanvas" class="flat"></canvas>

        <!-- 聚焦卫星图例：说明地图上为聚焦星绘制的覆盖范围(浅蓝虚线，示意非精确覆盖区)与星下点轨迹(金黄实线)，3D / 2D 同步显示 -->
        <div v-if="selected" class="focus-legend">
          <div class="fl-row"><span class="fl-sw cov"></span>{{ fpLegend }}</div>
          <div class="fl-row"><span class="fl-sw trk"></span>星下点轨迹</div>
        </div>

        <div v-if="selected" class="card" :class="{ collapsed: cardCollapsed }">
          <div class="ch" :title="cardCollapsed ? '展开' : '收起'" @click="cardCollapsed = !cardCollapsed">
            <span class="cc" :class="{ col: cardCollapsed }"><Icon name="chevron-down" :size="11" /></span>
            <span class="cn" :title="selList.length > 1 ? '' : selected.name">{{ selList.length > 1 ? (selList.length + ' 颗聚焦') : selected.name }}</span>
            <span class="cx" :title="selList.length > 1 ? '全部取消' : '取消聚焦'" @click.stop="closeCard"><Icon name="x" :size="12" /></span>
          </div>
          <!-- 多选：mini-card 列表（点行=设为主选看详情，×=移出）；单选时不显示，直接看详情 -->
          <div v-show="!cardCollapsed && selList.length > 1" class="msel">
            <div v-for="s in selList" :key="s.idx" class="mrow" :class="{ active: s.active }" @click="setPrimary(s)">
              <div class="mmain">
                <div class="mr1"><span class="mnm" :title="s.name" data-i18n-skip>{{ s.name }}</span><span class="mkind">{{ s.kind }}</span></div>
                <div class="msub">{{ s.noradId }}<template v-if="s.slot"> · {{ s.slot }}</template> · {{ s.alt }}km · {{ s.incl }}°</div>
              </div>
              <span class="mx" title="移出该星" @click.stop="removeSel(s)"><Icon name="x" :size="10" /></span>
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

          <div class="csec">覆盖圈</div>
          <div class="covdef">
            <span class="seg sm" role="group" aria-label="覆盖圈定义">
              <span class="sg" :class="{ on: fpMode === 'beam' }" title="按星上波束角（全锥角）画覆盖圈" @click="setFpMode('beam')">波束角</span>
              <span class="sg" :class="{ on: fpMode === 'elev' }" title="按地面最低仰角画覆盖圈（0°=地平线）" @click="setFpMode('elev')">最低仰角</span>
            </span>
            <span class="covin">
              <template v-if="fpMode === 'beam'">
                <input class="covi" :value="beam" :placeholder="beamAuto || '自动'" title="波束全锥角，空=对地全视场" @input="onBeam" />
                <span class="covu">°</span>
                <span class="covlock" :class="{ on: beamLock }" :title="beamLock ? '已锁定：超出该星上限不截断' : '锁定：超出该星上限时不回写截断值'" @click="toggleBeamLock"><Icon :name="beamLock ? 'lock' : 'lock-open'" :size="12" /></span>
              </template>
              <template v-else>
                <input class="covi" :value="elevMin" placeholder="0" title="最低仰角，0°=地平线" @input="onElevMin" />
                <span class="covu">°</span>
              </template>
            </span>
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
              <span class="ceback" @click="closeConstWizard"><Icon name="chevron-left" :size="13" /> 返回</span>
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
              <span v-if="keyword" class="clr" @click="clearSearch"><Icon name="x" :size="11" /></span>
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
              <span v-if="!filterGroupId" class="fsave" title="将当前筛选结果存为卫星组（可稍后重新显示）" @click="saveFilterAsGroup"><Icon name="folder-plus" :size="11" /> 存为组</span>
              <span class="fx" @click="clearSearch">清除</span>
            </div>
            <!-- 一颗也算数：单颗选中同样要能「存为组」（此前 ≥2 才出条，导致单星无法建组） -->
            <div v-if="selList.length" class="fbar selbar">
              <span class="fdot sel"></span>已选 <b>{{ selList.length }}</b> 颗卫星
              <span class="fsave" title="将选中的卫星存为卫星组（可稍后重新显示）" @click="saveSelectionAsGroup"><Icon name="folder-plus" :size="11" /> 存为组</span>
              <span class="fx" title="取消全部选择" @click="closeCard">清除</span>
            </div>
            <div class="pchips">
              <span class="mini" :class="{ on: autoRotate }" @click="toggleRotate">{{ autoRotate ? '旋转中' : '已停止' }}</span>
              <span class="mini" :class="{ on: live }" @click="toggleLive">{{ live ? '实时开' : '实时关' }}</span>
              <span class="mini act" title="把卫星组 / 自定义卫星 / 自定义星座发送到小程序「星座地图」（投给已绑定账号，或生成一次性密钥）" @click="sendSatsToMiniapp"><Icon name="external-link" :size="10" /> 发送到小程序</span>
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
              <span v-if="g.key !== 'none'" class="pgex" :title="expTag === 'g:' + g.key ? '收起卫星列表' : '展开卫星列表'" @click.stop="expToggle('g:' + g.key, g.label)"><Icon :name="expTag === 'g:' + g.key ? 'chevron-down' : 'chevron-right'" :size="13" /></span>
              <span v-else class="pgex none"></span>
              <span class="pgico"><Icon name="satellite" :size="12" /></span>
              <span class="pgn">{{ g.label }}</span>
              <template v-if="groupColorable(g.key)">
                <span v-if="groupColors[g.key]" class="pgrst" title="恢复默认星点色" @click.stop="resetGroupColor(g.key)"><Icon name="x" :size="10" /></span>
                <label class="pgclr" :title="'星点颜色（' + groupColorHex(g.key) + '）'" @click.stop>
                  <span class="pgsw" :style="{ background: groupColorHex(g.key) }"></span>
                  <input type="color" :value="groupColorHex(g.key)" @input="e => setGroupColor(g.key, e.target.value)" />
                </label>
              </template>
            </div>
            <SatList
              v-if="expTag === 'g:' + g.key"
              :items="expList" :loading="expLoading" :error="expErr" :actions="expActions" :rows="14"
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
                <span class="lnk" title="新建一个空组，然后在管理器里搜索添加卫星" @click="openSatGrpMgr(); sgmNew()"><Icon name="plus" :size="11" /> 新建</span>
                <span class="lnk" title="打开卫星组管理器：新建 / 改名 / 复制 / 删除 · 搜索添加卫星 · 逐颗或批量移出" @click="openSatGrpMgr()"><Icon name="sliders-horizontal" :size="11" /> 管理</span>
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
              <span class="pgex" :title="expTag === 's:' + g.id ? '收起成员列表' : '展开成员列表'" @click.stop="expToggle('s:' + g.id, g.name)"><Icon :name="expTag === 's:' + g.id ? 'chevron-down' : 'chevron-right'" :size="13" /></span>
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
                <span v-if="selList.length || (filterN && !filterGroupId)" class="ccic add" :title="'将当前' + (selList.length ? ('选中的 ' + selList.length) : ('筛选的 ' + filterN)) + ' 颗卫星加入本组（去重追加）'" @click.stop="addSelToGroup(g)"><Icon name="plus" :size="13" /></span>
                <span v-if="selList.length && filterGroupId === g.id" class="ccic del" :title="'将选中的 ' + selList.length + ' 颗从本组移出'" @click.stop="removeSelFromGroup(g)"><Icon name="minus" :size="13" /></span>
                <span class="ccic" title="管理成员：搜索添加 / 逐颗移出（无需先在地图上显示）" @click.stop="openSatGrpMgr(g)"><Icon name="sliders-horizontal" :size="11" /></span>
                <span class="ccic" title="重命名" @click.stop="satGrpEnterRename(g)"><Icon name="pencil" :size="11" /></span>
                <span class="ccic del" :class="{ warn: satGrpDelId === g.id }" :title="satGrpDelId === g.id ? '再次点击确认删除' : '删除该组'" @click.stop="satGrpDelete(g)"><Icon name="trash" :size="11" /></span>
                <span v-if="g.color" class="pgrst" title="恢复默认星点色" @click.stop="satGrpResetColor(g)"><Icon name="x" :size="10" /></span>
                <label class="pgclr" :title="'星点颜色（' + (g.color || '未设置，随所属星座') + '）'" @click.stop>
                  <span class="pgsw" :class="{ unset: !g.color }" :style="g.color ? { background: g.color } : null"></span>
                  <input type="color" :value="g.color || DEFAULT_SAT_HEX" @input="e => satGrpSetColor(g, e.target.value)" />
                </label>
              </template>
            </div>
            <SatList
              v-if="expTag === 's:' + g.id"
              :items="expList" :actions="expActions" :rows="14"
              :placeholder="'在「' + g.name + '」里筛选'" empty="该组还没有卫星。"
              @action="expOnAction" @activate="expLocate"
            />
            </template>
          </div>
          <!-- 自定义星座（仿 STK Walker 生成器）：星点 + 轨道圈叠加显示 -->
          <div class="ccsec">
            <div class="cchd"><span>自定义星座</span><span class="lnk" @click="openConstWizard()"><Icon name="plus" :size="11" /> 生成</span></div>
            <div class="ccep" title="全部自定义星座共用的「场景历元」。星座定向以此为准；拖时间轴仍从此历元向后推演。默认取电脑当天 08:00，每天自动更新；当天若手动改过则当天以手动值为准（次日回到该日 08:00）。RAAN 仍是惯性升交点赤经，与真实 TLE 同参考。">
              <label>场景历元</label>
              <input class="ci" type="datetime-local" v-model="scenarioEpochLocal" />
              <span class="lnk" title="取当前时刻为场景历元" @click="scenarioEpochNow">当前</span>
            </div>
            <div v-if="!customList.length" class="cctip">还没有自定义星座。</div>
            <template v-for="c in customList" :key="c.id">
            <div class="ccrow" :class="{ off: c.visible === false, sel: c.id === soloConst, exp: expTag === 'c:' + c.id }" title="点击单独显示该星座" @click="showConstAlone(c)" @contextmenu.prevent.stop="openRowMenu($event, 'cc', c)">
              <span class="pgex" :title="expTag === 'c:' + c.id ? '收起卫星列表' : '展开卫星列表'" @click.stop="expToggle('c:' + c.id, c.name)"><Icon :name="expTag === 'c:' + c.id ? 'chevron-down' : 'chevron-right'" :size="13" /></span>
              <span class="ccdot" :style="{ background: c.color }"></span>
              <span class="ccnm" :title="c.name" data-i18n-skip>{{ c.name }}</span>
              <span class="cccode">{{ ccCode(c) }}</span>
              <span class="ccic" :title="c.visible === false ? '显示' : '隐藏'" @click.stop="customConst.toggle(c.id)"><Icon :name="c.visible === false ? 'eye-off' : 'eye'" :size="12" /></span>
              <span class="ccic" title="编辑" @click.stop="openConstWizard(c)"><Icon name="pencil" :size="11" /></span>
              <span class="ccic del" title="删除" @click.stop="removeConst(c)"><Icon name="trash" :size="11" /></span>
            </div>
            <SatList
              v-if="expTag === 'c:' + c.id"
              :items="expList" :actions="expActions" :rows="14"
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
            <span class="ic del" title="移除该星" @click="removeCovSat(it)"><Icon name="x" :size="11" /></span>
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
              <span class="ic del" title="删除批次" @click="removeBatch(it, ba)"><Icon name="x" :size="11" /></span>
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
              <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.6" max="8" step="0.2" :value="ba.width" @input="e => onBatchWidth(it, ba, e)" /><span class="u">{{ ba.width }}</span></div>
            </template>
          </div>
          <div class="addbatch" @click="addBatch(it)"><Icon name="plus" :size="11" /> 新建批次</div>
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
          <div class="sect acc" :class="{ open: isSecOpen('poly-list') }" @click="toggleSec('poly-list')"><Icon :name="isSecOpen('poly-list') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>协调区多边形</span><span class="lnk" title="从标准 GXT / KML 文件导入多边形（追加到列表，不影响已有；可多选）" @click.stop="importPolys"><Icon name="import" :size="12" /> 导入</span><span class="lnk" style="margin-left:12px" @click.stop="polyStartDraw"><Icon name="plus" :size="11" /> 绘制</span></div>
          <template v-if="isSecOpen('poly-list')">
          <div v-if="!polys.length && !polyDrawId" class="tip">暂无多边形。</div>
          <div v-for="pg in polys" :key="pg.id" class="plg" :class="{ act: polyDrawId === pg.id || polyEditId === pg.id || polyMoveId === pg.id }">
            <div class="plgh">
              <input type="checkbox" :checked="pg.show !== false" title="在地图上显示 / 隐藏该多边形" @change="togglePoly(pg)" />
              <input class="clr plgc" type="color" :value="pg.color" title="线条颜色（填充色未单独调过时跟随线色）" @input="polySetColor(pg, $event.target.value)" />
              <input class="plgn plgnm" v-model="pg.name" placeholder="名称" @change="polyRefresh" />
              <span class="plgi">{{ pg.pts.length }} 点</span>
              <span class="ic del" title="删除该多边形" @click="removePoly(pg)"><Icon name="x" :size="11" /></span>
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
              <input class="rng" type="range" min="0.2" max="8" step="0.2" :value="pg.width" @input="e => { pg.width = Number(e.target.value); polyRefresh() }" />
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
              <span class="plgcp" title="复制全部顶点为两列（经度 ⇥ 纬度）：粘贴至 Excel / 表格自动分为经度、纬度两列" @click="copyPolyVerts(pg)"><Icon name="copy" :size="11" /> 复制两列</span>
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
          <div class="sect acc" :class="{ open: isSecOpen('grd-tree') }" @click="toggleSec('grd-tree')"><Icon :name="isSecOpen('grd-tree') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>卫星 / 天线</span><span class="lnk" title="添加自定义卫星，或从星座点选/搜索关联卫星" @click.stop="openAddSat"><Icon name="plus" :size="11" /> 卫星</span><span class="lnk" title="只画等仰角线：填经纬度/轨道高度 + 仰角值即可，不建卫星图标/天线" @click.stop="openAddElevLine"><Icon name="plus" :size="11" /> 仰角线</span></div>
          <template v-if="isSecOpen('grd-tree')">
          <div class="gtree">
            <template v-for="sat in grdSats" :key="sat.folder">
              <div v-if="sat.kind === 'elevline'" class="gsat gsat-el">
                <Icon class="gsvg" name="angle" :size="14" />
                <span class="gsname" :title="sat.satName">{{ sat.satName }}</span>
                <span class="sdisp">
                  <span class="ic" :class="{ on: sat.elevShow }" :style="sat.elevShow ? { color: sat.elevColor } : {}" title="显示/隐藏该仰角线" @click.stop="toggleSatElev(sat)"><Icon name="angle" :size="12" /></span>
                </span>
                <span class="sacts">
                  <span class="ic" title="编辑仰角线" @click.stop="editElevLine(sat)"><Icon name="pencil" :size="11" /></span>
                  <span class="ic del" title="删除仰角线" @click.stop="removeSat(sat)"><Icon name="x" :size="11" /></span>
                </span>
              </div>
              <div v-else class="gsat" :class="{ exp: grd.isExpanded(sat.folder) }">
                <i class="tri" :class="{ open: grd.isExpanded(sat.folder) }" @click="grd.toggleExpand(sat.folder)"><Icon name="chevron-right" :size="10" /></i>
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
                  <span class="ic" title="导入 GRD：在该星下新建天线" @click.stop="grd.importGrd(sat)"><Icon name="plus" :size="11" /></span>
                  <span class="ic" title="编辑卫星 / 仰角线 / 颜色" @click.stop="editSat(sat)"><Icon name="pencil" :size="11" /></span>
                  <span class="ic del" title="删除卫星（含其天线）" @click.stop="removeSat(sat)"><Icon name="x" :size="11" /></span>
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
                    <span class="ic ok" title="确认重命名" @mousedown.prevent @click.stop="commitRenameAnt(sat, a)"><Icon name="check" :size="11" /></span>
                  </template>
                  <template v-else>
                    <span class="aname" title="双击重命名" @dblclick.stop="startRenameAnt(sat, a)" data-i18n-skip>{{ a.name }}</span>
                    <span v-if="grd.isActive(sat.folder, a.name)" class="afoc">编辑中</span>
                    <span class="sacts">
                      <span class="ic" title="重命名天线" @click.stop="startRenameAnt(sat, a)"><Icon name="pencil" :size="11" /></span>
                      <span class="ic del" title="删除天线" @click.stop="grd.removeAntenna(sat.folder, a.name)"><Icon name="x" :size="11" /></span>
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
              <span class="gic" title="复制该组" @click.stop="bs.duplicateGroup(g.id)"><Icon name="copy" :size="11" /></span>
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
            <span class="opb sm" :class="{ dis: !bs.groupsForSat.value.length }" title="当前卫星下每个组各生成一副天线" @click="bsGenerateAll"><Icon name="check" :size="11" /> 全部生成</span>
            <span class="opb sm" :class="{ dis: !bs.canUndo.value }" title="撤销（当前组）" @click="bs.undo"><Icon name="undo-2" :size="11" /> 撤销</span>
            <span class="opb sm" :class="{ dis: !bs.canRedo.value }" title="重做（当前组）" @click="bs.redo"><Icon name="redo-2" :size="11" /> 重做</span>
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
                <span class="ic del" title="删除该波束" @click="bs.removeBeam(b.id)"><Icon name="x" :size="10" /></span>
              </div>
            </div>
            </template>
          </div>

          <!-- 轮廓与编号（折叠） -->
          <div class="sec">
            <div class="sect acc" :class="{ open: isSecOpen('bs-style', false) }" @click="toggleSec('bs-style', false)"><Icon :name="isSecOpen('bs-style', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轮廓与编号</span></div>
            <template v-if="isSecOpen('bs-style', false)">
              <div class="srow"><label>轮廓颜色</label><input class="clr" type="color" v-model="bs.p.skColor" title="草图轮廓与中心点基础色（各波束设置色 / 频率配色开启后被其覆盖）" />
                <span class="uw"><label class="lb2">线宽</label><input class="ci sm" type="number" step="0.5" min="0.5" max="5" v-model.number="bs.p.skWidth" /><span class="u">px</span></span>
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
                  <span class="bs-fpcp" :class="{ ok: bsFreqCopied }" title="复制全部波束为多列表格（编号 / 频率 / 经度 / 纬度 / 3dB-X / 3dB-Y / 旋转，Tab 分隔）：粘贴至 Excel 自动分为 7 列" @click="bsCopyFreqPlan"><Icon :name="bsFreqCopied ? 'check' : 'copy'" :size="11" /> {{ bsFreqCopied ? '已复制 ✓' : '复制表格' }}</span>
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
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=累加选择；点击站点=选中该站、Ctrl+点=增减选；点空处=清选；再点本钮退出）" @click="bs.toggleStEdit()"><Icon name="crosshair" :size="11" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="11" /> 加站</span>
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
                <span class="bs-fpcp" :class="{ ok: bsPamExcitCopied }" title="复制激励指令表（Tab 分隔，粘贴至 Excel 自动分列）" @click="bsPamExcitCopy"><Icon :name="bsPamExcitCopied ? 'check' : 'copy'" :size="11" /> {{ bsPamExcitCopied ? '已复制 ✓' : '复制表格' }}</span>
                <span class="opb sm" title="导出 CSV（UTF-8 BOM，Excel 直接打开）供测控上注星上 BFN" @click="bsExportPamExcit"><Icon name="download" :size="11" /> 导出 CSV</span>
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
              <span class="opb sm" :class="{ on: bs.stEditOn.value }" title="平面图上拖矩形框选站点（Ctrl+拖=累加选择；点击站点=选中该站、Ctrl+点=增减选；点空处=清选；再点本钮退出）" @click="bs.toggleStEdit()"><Icon name="crosshair" :size="11" /> 框选</span>
              <span class="opb sm" :class="{ on: bs.stPick.value }" title="地图点击添加 Contour 站点（可连续加；再点本钮退出）" @click="bs.toggleStPick()"><Icon name="plus" :size="11" /> 加站</span>
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
            <div v-if="vis.mode.value !== 'coverage'" class="srow"><label>目标</label>
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
        <div v-if="shellUi.side === 'env'" class="cov-side env-side docked">
          <div class="sec">
            <div class="sect acc" :class="{ open: isSecOpen('env-src') }" @click="toggleSec('env-src')"><Icon :name="isSecOpen('env-src') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>数据场</span></div>
            <template v-if="isSecOpen('env-src')">
              <label class="chk2 env-on"><input type="checkbox" v-model="env.on.value" /><span>在地图上显示环境场</span></label>
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
                <input v-if="env.bands.value > 0" class="ci cov-num" type="number" min="2" max="24" step="1" :value="env.bands.value" @input="e => env.bands.value = Math.max(2, Math.min(24, Number(e.target.value) || 8))" /><span v-if="env.bands.value > 0" class="u">档</span>
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

        <!-- 地图设置：海陆配色 / 国界省界市界 / 名称标注 -->
        <div v-show="shellUi.side === 'geo'" class="sview">
        <div class="cov-side geo-side docked">
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-ocean') }" @click="toggleSec('geo-ocean')"><Icon :name="isSecOpen('geo-ocean') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>大海颜色</span></div>
          <template v-if="isSecOpen('geo-ocean')">
          <div class="swatches">
            <span v-for="c in OCEAN_BLUES" :key="c" class="sw" :class="{ on: oceanColor === c }" :style="{ background: c }" :title="c" @click="setOceanColor(c)"></span>
          </div>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-land') }" @click="toggleSec('geo-land')"><Icon :name="isSecOpen('geo-land') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>大地颜色</span></div>
          <template v-if="isSecOpen('geo-land')">
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
              <div v-for="o in landOvList" :key="o.id" class="mrow"><span class="swd" :style="{ background: o.color }"></span><span class="mc rowlk" @click="pickLandCountry(o)">{{ o.zh }}</span><span class="del" @click="removeLandCountryColor(o.id)"><Icon name="x" :size="11" /></span></div>
            </div>
            <div class="bsub"><span class="lnk" @click="clearLandOverrides">全部恢复默认</span></div>
          </template>
          </template>
        </div>
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-country', false) }" @click="toggleSec('geo-country', false)"><Icon :name="isSecOpen('geo-country', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>国家（国界）</span></div>
          <template v-if="isSecOpen('geo-country', false)">
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
          <div class="srow"><label>国界线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="borderStyle.natWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.natWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>国界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.natOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.natOpacity.toFixed(2) }}</span></div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-prov', false) }" @click="toggleSec('geo-prov', false)"><Icon :name="isSecOpen('geo-prov', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>中国省（省界）</span></div>
          <template v-if="isSecOpen('geo-prov', false)">
          <label class="chk2"><input type="checkbox" :checked="showProvinces" @change="toggleProvinces" /><span>显示中国省界 / 省名</span></label>
          <div class="srow"><label>名字号</label><input class="rng" type="range" min="0.3" max="2" step="0.05" :value="provNameSize" @input="setProvNameSize" /><span class="u">{{ provNameSize.toFixed(2) }}</span></div>
          <div class="srow"><label>名颜色</label><input class="clr" type="color" v-model="labelStyle.provColor" @input="applyLabelStyle" /><span class="u">{{ labelStyle.provColor }}</span></div>
          <div class="srow"><label>名透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle.provOpacity" @input="applyLabelStyle" /><span class="u">{{ labelStyle.provOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>省界线颜色</label><input class="clr" type="color" v-model="borderStyle.provColor" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provColor }}</span></div>
          <div class="srow"><label>省界线粗</label><input class="rng" type="range" min="0.1" max="8" step="0.1" v-model.number="borderStyle.provWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provWidth.toFixed(1) }}</span></div>
          <div class="srow"><label>省界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.provOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.provOpacity.toFixed(2) }}</span></div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-city', false) }" @click="toggleSec('geo-city', false)"><Icon :name="isSecOpen('geo-city', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>中国地级市（地级市界）</span></div>
          <template v-if="isSecOpen('geo-city', false)">
          <label class="chk2"><input type="checkbox" :checked="showCities" @change="toggleCities" /><span>显示中国地级市界 / 地级市名</span></label>
          <div class="srow"><label>名字号</label><input class="rng" type="range" min="0.05" max="1.5" step="0.05" :value="cityNameSize" @input="setCityNameSize" /><span class="u">{{ cityNameSize.toFixed(2) }}</span></div>
          <div class="srow"><label>名颜色</label><input class="clr" type="color" v-model="labelStyle.cityColor" @input="applyLabelStyle" /><span class="u">{{ labelStyle.cityColor }}</span></div>
          <div class="srow"><label>名透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="labelStyle.cityOpacity" @input="applyLabelStyle" /><span class="u">{{ labelStyle.cityOpacity.toFixed(2) }}</span></div>
          <div class="srow"><label>市界线颜色</label><input class="clr" type="color" v-model="borderStyle.cityColor" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityColor }}</span></div>
          <div class="srow"><label>市界线粗</label><input class="rng" type="range" min="0.05" max="8" step="0.05" v-model.number="borderStyle.cityWidth" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityWidth.toFixed(2) }}</span></div>
          <div class="srow"><label>市界透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="borderStyle.cityOpacity" @input="applyBorderStyle" /><span class="u">{{ borderStyle.cityOpacity.toFixed(2) }}</span></div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('geo-term', false) }" @click="toggleSec('geo-term', false)"><Icon :name="isSecOpen('geo-term', false) ? 'chevron-down' : 'chevron-right'" :size="12" /><span>晨昏线（昼夜分界）</span></div>
          <template v-if="isSecOpen('geo-term', false)">
          <label class="chk2"><input type="checkbox" :checked="termOn" @change="toggleTerm" /><span>显示晨昏线 / 夜区</span></label>
          <template v-if="termOn">
          <label class="chk2"><input type="checkbox" :checked="termNight" @change="toggleTermNight" /><span>夜区遮罩</span></label>
          <div v-if="termNight" class="srow"><label>夜区颜色</label><input class="clr" type="color" v-model="termStyle.nightColor" @input="applyTerminator" /><span class="u">{{ termStyle.nightColor }}</span></div>
          <div v-if="termNight" class="srow"><label>夜区透明度</label><input class="rng" type="range" min="0" max="0.85" step="0.02" v-model.number="termStyle.nightOpacity" @input="applyTerminator" /><span class="u">{{ termStyle.nightOpacity.toFixed(2) }}</span></div>
          <label class="chk2"><input type="checkbox" :checked="termLine" @change="toggleTermLine" /><span>分界线</span></label>
          <div v-if="termLine" class="srow"><label>线颜色</label><input class="clr" type="color" v-model="termStyle.lineColor" @input="applyTerminator" /><span class="u">{{ termStyle.lineColor }}</span></div>
          <div v-if="termLine" class="srow"><label>线粗</label><input class="rng" type="range" min="0.2" max="4" step="0.1" v-model.number="termStyle.lineWidth" @input="applyTerminator" /><span class="u">{{ termStyle.lineWidth.toFixed(1) }}</span></div>
          <div v-if="termLine" class="srow"><label>线透明度</label><input class="rng" type="range" min="0" max="1" step="0.05" v-model.number="termStyle.lineOpacity" @input="applyTerminator" /><span class="u">{{ termStyle.lineOpacity.toFixed(2) }}</span></div>
          <div class="tip">
            日下点 {{ termSub ? fmtSlot(termSub.lon) + ' · ' + Math.abs(termSub.lat).toFixed(2) + '°' + (termSub.lat >= 0 ? 'N' : 'S') : '—' }}。
          </div>
          </template>
          </template>
        </div>
        </div>
        </div>

        <!-- 标记：点标记 / 地球站 / 轨迹 -->
        <div v-show="shellUi.side === 'markers'" class="sview">
        <div class="cov-side mk-side docked">
        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('mk-points') }" @click="toggleSec('mk-points')"><Icon :name="isSecOpen('mk-points') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>点标记</span><span class="eyebtn" :class="{ off: !showPtLayer }" :title="showPtLayer ? '隐藏点标记（数据保留）' : '显示点标记'" @click.stop="togglePtLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showPtLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span><span class="lnk" title="打开点标记批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('points')">表格</span><span v-if="points.length" class="lnk" :class="{ on: mkEditId === 'points' }" :title="mkEditId === 'points' ? '完成，退出拖动' : '在平面图上拖动圆点调整点标记位置'" @click.stop="mkEditToggle('points')">{{ mkEditId === 'points' ? '完成调整' : '调整位置' }}</span></div>
          <template v-if="isSecOpen('mk-points')">
          <div class="srow"><label>纬度</label><input class="ci" v-model="ptLat" placeholder="-90 ~ 90" /></div>
          <div class="srow"><label>经度</label><input class="ci" v-model="ptLon" placeholder="-180 ~ 180" /><span class="addb" @click="addPointInput">添加</span></div>
          <label class="chk2"><input type="checkbox" :checked="showPtLabel" @change="togglePtLabel" /><span>显示坐标</span></label>
          <div v-if="showPtLabel" class="srow"><label>坐标字号</label><input class="rng" type="range" min="1" max="32" step="1" :value="markPtFont" @input="setPtFont" /><span class="u">{{ markPtFont }}</span></div>
          <div class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="12" step="0.5" :value="markPtDot" @input="setPtDot" /><span class="u">{{ markPtDot }}</span></div>
          <div class="mlist">
            <div v-for="p in points" :key="p.id" class="mrow"><span class="mc">{{ fmtLL(p.lat, p.lon) }}</span><span class="del" @click="removePoint(p.id)"><Icon name="x" :size="11" /></span></div>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('mk-stations') }" @click="toggleSec('mk-stations')"><Icon :name="isSecOpen('mk-stations') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>地球站</span><span class="eyebtn" :class="{ off: !showStLayer }" :title="showStLayer ? '隐藏地球站（数据保留）' : '显示地球站'" @click.stop="toggleStLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showStLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span><span class="lnk" title="打开地球站批量表格（Excel：增删改 / 批量粘贴导入）" @click.stop="openMkTable('stations')">表格</span><span v-if="stations.length" class="lnk" :class="{ on: mkEditId === 'stations' }" :title="mkEditId === 'stations' ? '完成，退出拖动' : '在平面图上拖动图标调整地球站位置'" @click.stop="mkEditToggle('stations')">{{ mkEditId === 'stations' ? '完成调整' : '调整位置' }}</span></div>
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
              <span class="mc2">{{ fmtLL(s.lat, s.lon) }}</span><span class="del" @click="removeStation(s.id)"><Icon name="x" :size="11" /></span>
            </div>
          </div>
          </template>
        </div>

        <div class="sec">
          <div class="sect acc" :class="{ open: isSecOpen('mk-traj') }" @click="toggleSec('mk-traj')"><Icon :name="isSecOpen('mk-traj') ? 'chevron-down' : 'chevron-right'" :size="12" /><span>轨迹</span><span class="eyebtn" :class="{ off: !showTrajLayer }" :title="showTrajLayer ? '隐藏航迹（数据保留）' : '显示航迹'" @click.stop="toggleTrajLayer"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1 8C3 4.2 13 4.2 15 8C13 11.8 3 11.8 1 8Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2.1" fill="currentColor"/><path v-if="!showTrajLayer" d="M3 13 L13 3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></span>
            <span class="lnk" title="打开航迹批量表格（Excel：逐航迹增删改航点 / 批量粘贴导入）" @click.stop="openMkTable('traj')">表格</span>
            <span class="lnk" @click.stop="newTraj('sea')">+航行</span>
            <span class="lnk" @click.stop="newTraj('flight')">+飞行</span>
          </div>
          <template v-if="isSecOpen('mk-traj')">
          <div class="srow"><label>圆点大小</label><input class="rng" type="range" min="1" max="10" step="0.5" :value="trajDotSize" @input="setTrajDot" /><span class="u">{{ trajDotSize }}</span></div>
          <div v-for="t in trajectories" :key="t.id" class="tcard" :class="{ act: activeTraj === t.id }">
            <div class="trow">
              <span class="tk" :class="t.kind"></span>
              <input class="tni" :value="t.name" @input="e => setTrajName(t.id, e.target.value)" />
              <span class="tsel" :class="{ on: activeTraj === t.id }" @click="activeTraj = t.id">{{ activeTraj === t.id ? '编辑中' : '编辑' }}</span>
              <span v-if="t.pts.length" class="tsel" :class="{ on: mkEditId === t.id }" :title="mkEditId === t.id ? '完成，退出拖动' : '在平面图上拖动航点圆点调整位置'" @click="mkEditToggle(t.id)">{{ mkEditId === t.id ? '完成' : '调点' }}</span>
              <span class="del" @click="removeTraj(t.id)"><Icon name="x" :size="11" /></span>
            </div>
            <div class="twp">
              <span v-for="(p, i) in t.pts" :key="i" class="wp">{{ p.lat == null ? '—' : p.lat.toFixed(1) }},{{ p.lon == null ? '—' : p.lon.toFixed(1) }}<span class="wdel" @click="removeWaypoint(t, i)"><Icon name="x" :size="10" /></span></span>
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
        <span class="seg sm wseg" role="group" aria-label="时间窗跨度" title="可见时间窗跨度（可回看过去 · 滚轮缩放）">
          <span v-for="w in WINDOW_PRESETS" :key="w.v" class="sg" :class="{ on: windowMin === w.v }" @click="setWindow(w.v)">{{ w.l }}</span>
          <span v-if="isCustomWindow" class="sg on cust" title="滚轮缩放得到的自定义跨度">{{ customWinLabel }}</span>
        </span>
      </div>
      <div class="tb-track" ref="track" tabindex="0" role="slider" aria-label="仿真时间游标"
           :aria-valuemin="winStartMin" :aria-valuemax="winEndMin" :aria-valuenow="offMin" :aria-valuetext="timeParts.s"
           @pointerdown="trackDown" @wheel.prevent="onWheel" @keydown="onTrackKey" @pointermove="onHover" @pointerleave="onLeave">
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
        <span class="tlab2 tzsw" :title="tzMode === 'utc' ? '当前按 UTC 显示，点击切回本机时区 ' + localTzLabel + '（仅改显示；星位、晨昏线、过境窗口一律走 UTC 计算，与此开关无关）' : '当前按本机时区 ' + localTzLabel + ' 显示，点击切到 UTC（仅改显示；星位、晨昏线、过境窗口一律走 UTC 计算，与此开关无关）'" @click="toggleTz"><span class="t1">{{ timeParts.m }}</span><span class="t2">{{ timeParts.s }}</span></span>
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
        <!-- 步长 + 倍速。两个旋钮各带栏名 —— 光一个「1s」和一个「×10」摆在那里看不出是什么。
             右侧读数只在【设定值没达到】时出现：一致时它和左边的下拉是同一个数，纯属重复。 -->
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
          <span v-if="speedNote" class="ckx lag" :title="'拍率 ' + fmtRate(rateFor(clock.stepSec, clock.speed)) + ' 拍/s（上限 30）× 步长 ' + stepText">{{ speedNote }}</span>
        </span>
      </div>
    </div>

    <!-- 卫星编辑弹窗（单独对话框）；点选模式下折叠为顶部横幅，便于点击地图上的卫星 -->
    <!-- hideViz（从文件管理器调起）：浮到文件管理器之上与之共存（提升 z-index 并改 fixed 定位） -->
    <div v-if="satModal && !satPick" class="sat-mask" :class="{ 'sat-overlay': satModal.hideViz }">
      <div class="sat-dlg">
        <div class="sdh"><span>{{ satModal.folder ? '编辑卫星' : '添加卫星' }}</span><span class="csx" @click="closeSatModal"><Icon name="x" :size="12" /></span></div>
        <div class="sdbody">
          <div class="sdiv">卫星（图标 / 卫星名）</div>
          <div class="srow"><label>名称</label><input class="ci" v-model="satModal.name" placeholder="卫星名称" /></div>
          <div v-if="!satModal.noradId" class="srow"><label>定位方式</label>
            <span class="pmode" :class="{ on: satModal.posMode !== 'orbit' }" @click="satModal.posMode = 'fixed'">固定经纬度</span>
            <span class="pmode" :class="{ on: satModal.posMode === 'orbit' }" @click="satModal.posMode = 'orbit'">轨道根数</span>
          </div>
          <template v-if="satModal.posMode !== 'orbit' || satModal.noradId">
            <div class="srow"><label>经度</label><input class="ci" type="number" step="0.1" :value="satPosVal('lon')" @input="satPosInput('lon', $event)" @change="satPosDone" @blur="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">°E</span></div>
            <div class="srow"><label>纬度</label><input class="ci" type="number" step="0.1" :value="satPosVal('lat')" @input="satPosInput('lat', $event)" @change="satPosDone" @blur="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">°N</span></div>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="100" :value="satPosVal('altKm')" @input="satPosInput('altKm', $event)" @change="satPosDone" @blur="satPosDone" :disabled="!!satModal.noradId" :title="satModal.noradId ? '已关联星座卫星，位置随星历实时解算，不可手动输入' : ''" /><span class="u">km</span><span v-if="!satModal.noradId" class="geobtn" title="设为标准 GEO 轨道高度 35786km（NASA 标称值）" @click="applyGeoAlt">一键GEO</span></div>
          </template>
          <template v-else>
            <div class="srow"><label>轨道高度</label><input class="ci" type="number" step="50" v-model.number="satModal.elements.altKm" /><span class="u">km</span></div>
            <div class="srow"><label>偏心率</label><input class="ci" type="number" step="0.001" min="0" max="0.999" v-model.number="satModal.elements.ecc" /></div>
            <div class="srow"><label>倾角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.incl" /><span class="u">°</span></div>
            <div class="srow"><label>升交点赤经</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.raan" /><span class="u">°</span></div>
            <div class="srow"><label>近地点幅角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.argp" /><span class="u">°</span></div>
            <div class="srow"><label>平近点角</label><input class="ci" type="number" step="0.1" v-model.number="satModal.elements.ma" /><span class="u">°</span></div>
          </template>
          <template v-if="!satModal.hideViz">
            <label class="chk2"><input type="checkbox" v-model="satModal.iconShow" /><span>显示图标</span></label>
            <div v-if="satModal.iconShow !== false" class="srow"><label>图标大小</label><input class="rng" type="range" min="1" max="64" step="1" v-model.number="satModal.iconSize" /><span class="u">{{ satModal.iconSize }}</span></div>
            <label class="chk2"><input type="checkbox" v-model="satModal.labelShow" /><span>显示卫星名</span></label>
            <div v-if="satModal.labelShow !== false" class="srow"><label>卫星名字号</label><input class="rng" type="range" min="1" max="30" step="1" v-model.number="satModal.labelSize" /><span class="u">{{ satModal.labelSize }}</span></div>

            <div class="sdiv">仰角线（等仰角环 / 角度标注）</div>
            <div class="srow"><label>仰角值</label><input class="ci" v-model="satModal.els" placeholder="如 5,10,20（0=地平）" /><span class="u">°</span></div>
            <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.5" max="8" step="0.1" v-model.number="satModal.elevWidth" /><span class="u">{{ (satModal.elevWidth || 1.3).toFixed(1) }}</span></div>
            <div class="srow"><label>标注字号</label><input class="rng" type="range" min="1" max="35" step="1" v-model.number="satModal.elevLabelSize" /><span class="u">{{ satModal.elevLabelSize || 18 }}</span></div>

            <div class="sdiv">颜色（仰角线与卫星名共用）</div>
            <div class="srow"><label>颜色</label><input class="clr" type="color" v-model="satModal.color" /></div>
          </template>

          <div class="sdiv">从星座选取（可选）</div>
          <div class="srow"><span class="pickbtn" @click="toggleSatPick">在地图上点选卫星</span></div>
          <div class="srow"><input class="ci" :value="satSearchKw" placeholder="或搜索卫星名 / 编号" @input="onSatSearch" /></div>
          <div v-if="satSearchRes.length" class="sres">
            <div v-for="r in satSearchRes" :key="r.noradId" class="sresi" @click="pickSatSearch(r)">
              <span class="srn" data-i18n-skip>{{ r.name }}</span><em>{{ r.groupLabel }} · {{ r.noradId }}<template v-if="r.slot"> · {{ r.slot }}</template></em>
            </div>
          </div>
          <div v-if="satModal.noradId" class="tip2">已关联星座卫星 NORAD {{ satModal.noradId }}（仰角线随时间轴 / 实时跟踪）<span class="lnk" @click="satModal.noradId = null">取消关联</span></div>
        </div>
        <div class="sdfoot"><span class="cancel" @click="closeSatModal">取消</span><span class="save" @click="saveSatModal">保存</span></div>
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
          <div class="srow"><label>线粗</label><input class="rng" type="range" min="0.5" max="8" step="0.1" v-model.number="elevModal.elevWidth" /><span class="u">{{ (elevModal.elevWidth || 1.3).toFixed(1) }}</span></div>
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
              <span class="lnk" title="新建一个空组" @click="sgmNew"><Icon name="plus" :size="11" /> 新建</span>
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
                <span class="gic" title="复制该组（含成员）" @click.stop="sgmDup(g)"><Icon name="copy" :size="11" /></span>
                <span class="gic del" :class="{ warn: sgmDelId === g.id }" :title="sgmDelId === g.id ? '再次点击确认删除' : '删除该组'" @click.stop="sgmDel(g)"><Icon name="trash" :size="11" /></span>
              </div>
            </div>
          </div>

          <div class="sgm-right">
            <template v-if="sgmCur">
              <div class="sgm-name">
                <label>组名</label>
                <input class="ci" ref="sgmNameEl" v-model="sgmNameVal" placeholder="卫星组名称" @input="sgmCommitName" @blur="sgmNameVal = (sgmCur ? sgmCur.name : '')" />
                <span class="gbtn" title="在地图上显示该组的卫星" @click="sgmShow"><Icon name="eye" :size="11" /> 显示</span>
              </div>

              <div class="sgm-clr">
                <label>着色</label>
                <span v-for="p in SGM_PALETTE" :key="p" class="pz" :class="{ on: sgmCur.color === p }" :style="{ background: p }" :title="p" @click="satGrpSetColor(sgmCur, p)"></span>
                <label class="pgclr lg" :title="'自定义颜色（' + (sgmCur.color || '未设置，随所属星座') + '）'">
                  <span class="pgsw" :class="{ unset: !sgmCur.color }" :style="sgmCur.color ? { background: sgmCur.color } : null"></span>
                  <input type="color" :value="sgmCur.color || DEFAULT_SAT_HEX" @input="e => satGrpSetColor(sgmCur, e.target.value)" />
                </label>
                <span class="hexv">{{ sgmCur.color || '—' }}</span>
                <span class="gbtn" :class="{ dis: !sgmHasAnyColor }" title="清除组色与全部逐颗颜色，回到随所属星座" @click="sgmResetAllColor"><Icon name="x" :size="11" /> 恢复默认</span>
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
                <span class="save" :class="{ dis: !sgmPick.length }" @click="sgmAddPick"><Icon name="plus" :size="11" /> 加入本组</span>
              </div>

              <div class="sgm-sec">组内卫星 <em>{{ sgmCur.sats.length }} 颗</em></div>
              <div class="sgm-memtool">
                <input class="ci" v-model="sgmMemKw" placeholder="在组内过滤…" />
                <span class="gbtn" @click="sgmToggleMemAll">全选 / 反选</span>
                <label class="gbtn clr" :class="{ dis: !sgmSel.length }" :title="'为所选 ' + sgmSel.length + ' 颗单独指定颜色（优先于组色）'">
                  <Icon name="droplets" :size="11" /> 着色所选{{ sgmSel.length ? (' ' + sgmSel.length) : '' }}
                  <input type="color" :value="sgmCur.color || DEFAULT_SAT_HEX" @input="e => satGrpColorSats(sgmCur, sgmSel, e.target.value)" />
                </label>
                <span class="gbtn" :class="{ dis: !sgmSel.length }" title="清除所选卫星的单独颜色，回到组色" @click="satGrpColorSats(sgmCur, sgmSel, '')">清除着色</span>
                <span class="gbtn danger" :class="{ dis: !sgmSel.length }" @click="sgmRemoveMem(sgmSel)"><Icon name="minus" :size="11" /> 移出所选{{ sgmSel.length ? (' ' + sgmSel.length) : '' }}</span>
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
                  <span v-if="m.color" class="gic" title="清除单独颜色，回到组色" @click.stop.prevent="satGrpColorSats(sgmCur, [m.id], '')"><Icon name="droplets" :size="11" /></span>
                  <span class="gic del" title="从本组移出" @click.stop.prevent="sgmRemoveMem([m.id])"><Icon name="x" :size="11" /></span>
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
            <span class="del" title="删除该城市" @click="perfDelStation(row.id)"><Icon name="x" :size="11" /></span>
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
          <span class="ptb" title="复制整张结果表（含表头，TSV，可粘进 Excel）" @click="perfCopyResult"><Icon name="copy" :size="11" /> 复制全表</span>
          <span class="ptb" title="导出为 Excel（性能结果 + 城市输入两张工作表；数字列存真数字）" @click="perfExportResult"><Icon name="download" :size="11" /> 导出 Excel</span>
          <span class="ptb" :class="{ on: perfOptsOpen }" title="显示列 / 计算口径 / 指向误差" @click="perfOptsOpen = !perfOptsOpen"><Icon name="settings" :size="11" /> 选项…</span>
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
            <span class="mtj-add" title="新建航行航迹" @click="mkNewTraj('sea')"><Icon name="plus" :size="10" />航行</span>
            <span class="mtj-add" title="新建飞行航迹" @click="mkNewTraj('flight')"><Icon name="plus" :size="10" />飞行</span>
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
                <span class="mtj-x" title="删除该航迹" @click.stop="mkDelTraj(t)"><Icon name="x" :size="11" /></span>
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
              <span class="del" title="删除该行" @click="mkDelRow(row.id)"><Icon name="x" :size="11" /></span>
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
          <span class="del" title="删除该行" @click="bsTblDelRow(row.id)"><Icon name="x" :size="11" /></span>
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
              <div class="bplist">
                <label class="brow ball">
                  <input type="checkbox" :checked="perf.filteredAllOn(perfOpts)" :indeterminate="perf.filteredAnyOn(perfOpts) && !perf.filteredAllOn(perfOpts)" @change="perf.selectFiltered(perfOpts, !perf.filteredAllOn(perfOpts))" />
                  <span class="balln">{{ perf.beamQuery.value.trim() ? '(全选搜索结果)' : '(全选)' }}</span>
                  <span class="bpk">{{ perf.beamSelCount(perfOpts) }}/{{ perf.ctxBeams.value.length }}</span>
                </label>
                <label v-for="b in perf.filteredBeams()" :key="b.seq" class="brow" :class="{ on: perf.beamOn(perfOpts, b.bi) }">
                  <input type="checkbox" :checked="perf.beamOn(perfOpts, b.bi)" @change="perf.toggleBeam(perfOpts, b.bi)" />
                  <span class="bseq">{{ b.seq }}</span>
                  <span class="pbnm" :title="b.name" data-i18n-skip>{{ b.name }}</span>
                  <span class="bpk">{{ b.peakDb == null ? '—' : b.peakDb.toFixed(1) }}</span>
                </label>
                <div v-if="!perf.filteredBeams().length" class="empty">无匹配波束</div>
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
.bar { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--border); flex: none; font-size: 12.5px; }
.bar .t { font-family: var(--font-serif); font-size: 14px; }
.bar select { border: 1px solid var(--border); background: var(--bg); padding: 3px 8px; }
.search { position: relative; }
.search input { border: 1px solid var(--border); background: var(--bg); padding: 3px 24px 3px 8px; outline: none; width: 180px; }
.search .clr { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; font-size: 11px; line-height: 1; cursor: pointer; color: var(--text-faint); }
.search .clr:hover { color: var(--text); }
.search .panel { position: absolute; top: 28px; left: 0; width: 260px; max-height: 260px; overflow: auto; background: var(--bg); border: 1px solid var(--border-strong); z-index: 5; }
.search .item { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.search .item:hover { background: var(--surface); }
.search .itx { flex: 1; min-width: 0; }
.search .nm { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.search .sub { color: var(--text-faint); font-size: 11px; }
/* 结果行「+」：加入选中集而不清搜索框（跨多次搜索攒一批，再「存为组」）；已在集中时显示 ✓ */
.search .ipk { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; border: 1px solid var(--border); border-radius: 4px; color: var(--text-faint); }
.search .ipk:hover { border-color: var(--accent); color: var(--accent); }
.search .item.picked .ipk { border-color: var(--accent); background: var(--accent); color: var(--bg); }
.meta { margin-left: auto; color: var(--text-faint); }
.tl { display: flex; align-items: center; gap: 14px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex: none; font-size: 11.5px; }
/* 时间轴（专业刻度尺）：基线尺 + 主/次两级刻度 + 游标针(顶部握柄) + 悬停幽灵线 + 独立「此刻」标记 */
.tb-track { position: relative; flex: 1; min-width: 180px; height: 34px; cursor: pointer; outline: none; }
.tb-base { position: absolute; left: 0; right: 0; bottom: 3px; height: 1px; background: var(--border-strong); }
.tb-t { position: absolute; bottom: 3px; width: 1px; transform: translateX(-0.5px); }
.tb-t.maj { height: 11px; background: var(--text-muted); }
.tb-t.min { height: 6px; background: var(--border-strong); }
.tb-lab { position: absolute; top: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 10px; line-height: 1; color: var(--text-faint); white-space: nowrap; pointer-events: none; }
.tb-ph { position: absolute; top: 0; bottom: 3px; width: 1.5px; transform: translateX(-0.75px); background: var(--accent); pointer-events: none; }
.tb-ph .hd { position: absolute; top: -1px; left: 50%; transform: translateX(-50%); width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 6px solid var(--accent); }
.tb-ph.lv { background: #e05252; }
.tb-ph.lv .hd { border-top-color: #e05252; }
.tb-now { position: absolute; top: 12px; bottom: 3px; width: 1px; transform: translateX(-0.5px); background: #e05252; pointer-events: none; }
.tb-now .tag { position: absolute; top: -11px; left: 50%; transform: translateX(-50%); font-family: var(--font-mono); font-size: 10px; color: #e05252; white-space: nowrap; }
.tb-ghost { position: absolute; top: 10px; bottom: 3px; width: 1px; transform: translateX(-0.5px); background: var(--text-faint); opacity: 0.5; pointer-events: none; }
.tb-tip { position: absolute; top: -2px; transform: translate(-50%, -100%); background: var(--bg); border: 1px solid var(--border-strong); border-radius: 4px; padding: 1px 5px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 10px; color: var(--text); white-space: nowrap; pointer-events: none; z-index: 3; }
/* 时间条分区（左：实时+跨度 / 中：刻度尺 flex:1 / 右：读数+步进）——留白分组，不用竖线堆砌 */
.tl-grp { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.tl .wseg { font-family: var(--font-mono); }
.tl .wseg .sg.cust { cursor: default; }
/* 时间读数：双行定宽块（主行=时刻/偏移量，副行=日期时间），tabular-nums + min-width，拖动不抖、不参与伸缩 */
.tlab2 { display: inline-flex; flex-direction: column; justify-content: center; min-width: 96px; flex: none; font-family: var(--font-mono); font-variant-numeric: tabular-nums; line-height: 1.25; }
.tlab2 .t1 { font-size: 12px; color: var(--text); white-space: nowrap; }
.tlab2 .t2 { font-size: 9.5px; color: var(--text-faint); white-space: nowrap; }
/* 时区档位切换（本机时区 ⇄ UTC）：整块读数即按钮，副行末尾的档位标记就是当前态指示 */
.tlab2.tzsw { cursor: pointer; border-radius: 3px; padding: 0 4px; margin: 0 -4px; }
.tlab2.tzsw:hover { background: var(--hover, rgba(255, 255, 255, 0.06)); }
.tlab2.tzsw:hover .t2 { color: var(--text); }
/* 步进按钮组：共享外框(0.5px+圆角) + 内部细分隔线；hover 中性叠加(非 accent)、100ms 跟手 */
.tl .stg { display: inline-flex; align-items: stretch; border: 0.5px solid var(--border); border-radius: 4px; overflow: hidden; flex: none; }
.tl .stg .st { padding: 4px 7px; cursor: pointer; color: var(--text-muted); font-size: 11px; line-height: 1; white-space: nowrap; user-select: none; transition: background .12s ease, color .12s ease; }
.tl .stg .st + .st { border-left: 0.5px solid var(--border); }
.tl .stg .st:hover { background: color-mix(in srgb, var(--text) 8%, transparent); color: var(--text); }
.tl .stg .st:active { background: color-mix(in srgb, var(--text) 14%, transparent); }
.tl .stg .st.now { color: var(--text); }
.tl .stg .st.dis { color: var(--text-faint); pointer-events: none; }
/* 实时徽标：红=跟随系统时间(点击停在当前时刻)、灰=点击回实时；红仅此一处语义 */
.tl .live-btn { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border: 0.5px solid var(--border); border-radius: 4px; cursor: pointer; color: var(--text-muted); user-select: none; flex: none; white-space: nowrap; transition: color .12s ease, border-color .12s ease; }
.tl .live-btn:hover { border-color: var(--border-strong); color: var(--text); }
.tl .live-btn .ldot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); flex: none; }
.tl .live-btn.on { color: #e05252; border-color: color-mix(in srgb, #e05252 55%, transparent); }
.tl .live-btn.on .ldot { background: #e05252; animation: live-pulse 2s ease-in-out infinite; }
@keyframes live-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(224, 82, 82, 0.4); } 50% { box-shadow: 0 0 0 4px rgba(224, 82, 82, 0); } }
/* 仿真时钟走带：图标按钮与文字按钮同高同框（同一 .stg 里不能一个 12px 字一个 12px 图标各算各的行高） */
.tl .stg .st.tic { display: inline-flex; align-items: center; justify-content: center; padding: 4px 7px; }
.tl .stg .st.play { padding: 4px 9px; }
.tl .stg .st.act { color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
/* 步长 / 倍速：两个带栏名的下拉 + 一个只在设定值没达到时才出现的读数（不描边，它不是按钮） */
.tl .clkg { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.tl .ckl { font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.tl .ckl + .cksel { margin-right: 4px; }
.tl .cksel {
  background: var(--surface); color: var(--text-muted); border: 0.5px solid var(--border); border-radius: 4px;
  font-size: 11px; font-family: var(--font-mono); padding: 3px 4px; cursor: pointer; outline: none;
}
.tl .cksel:hover { color: var(--text); border-color: var(--border-strong); }
.tl .ckx { font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 11px; color: var(--text-faint); white-space: nowrap; }
.tl .ckx.lag { color: var(--warn); }   /* 设定倍速没达到（被步长顶住 / 机器跟不上）：读数变告警色 */
/* 跳到时刻：浮在时间条上方的小盒（时间条本身很矮，塞不进一个日期时间输入框） */
.tl .gotobox {
  position: absolute; right: 12px; bottom: calc(100% + 6px); z-index: 2200;   /* 压过 .lmenu-bd 的遮罩 */
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 8px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 6px; box-shadow: 0 6px 20px rgba(0, 0, 0, .28);
}
.tl .gotobox .ci { font-size: 11.5px; padding: 3px 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 4px; font-family: var(--font-mono); }
.tl .gotobox .ptb { font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; cursor: pointer; white-space: nowrap; }
.tl .gotobox .ptb:hover { color: var(--accent); border-color: var(--accent); }
/* 时间控制条置于地图正下方：分隔线换到上缘 */
.tl.bottom { border-bottom: 0; border-top: 1px solid var(--border); background: var(--surface); container-type: inline-size; position: relative; }
/* 窄容器（侧栏挤压）优雅降级：收紧内边距/竖线/时间轴下限，保证「最低仰角」输入始终可见 */
/* 让位次序（挤窄时按「越靠后越先走」）：刻度次线 → 时间窗大档预设 → 栏名 → 跳到时刻 → 时间窗预设。
   ★ 走带五个键、两个旋钮、以及「实际/实测倍速」读数任何档位都不许消失：
     前两者是这条时间条的功能本体；那行读数只在设定倍速没达到时才出现，恰恰是最该被看见的时候。 */
@container (max-width: 880px) {
  .tl { gap: 10px; }
  .tl-grp { gap: 6px; }
  .tl .tb-track { min-width: 130px; }
  .tl .tb-t.min { display: none; }
  .tl .stg .st { padding: 4px 5px; }
  .tl .stg .st.tic { padding: 4px 4px; }
  .tl .clkg { gap: 3px; }
  .tl .ckl { font-size: 10px; }
  .tl .cksel { font-size: 10.5px; padding: 3px 2px; }
  .tl .wseg .sg:nth-child(n+5) { display: none; }          /* 大档（3d/7d）先走：滚轮照样能缩放到任意跨度 */
  .tlab2 { min-width: 84px; }
}
@container (max-width: 760px) {
  .tl { gap: 8px; }
  .tl .wseg .sg:nth-child(n+3) { display: none; }           /* 只留 10m / 1h 两档 */
  .tl .stg .st.tic:last-child { display: none; }            /* 「跳到时刻」：键盘与拖动仍可定位 */
}
/* 最后一档才动栏名：没有栏名的「1s」「×10」谁也看不出是什么，能留就留 */
@container (max-width: 560px) {
  .tl .ckl { display: none; }                               /* 口径仍在两个下拉的悬停提示里 */
  .tl .wseg { display: none; }
}
.mini { padding: 3px 10px; border: 1px solid var(--border); cursor: pointer; color: var(--text-muted); font-size: 12px; }
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
  border-radius: 5px; padding: 7px 10px; font-size: 11px; color: var(--text-muted); pointer-events: none;
}
.fl-row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.fl-sw { width: 18px; height: 0; border-top: 2px solid; flex: none; }
.fl-sw.cov { border-color: #b8e6fa; border-top-style: dashed; }
.fl-sw.trk { border-color: #e8c074; }
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
.cc { flex: none; align-self: center; display: inline-flex; align-items: center; color: var(--text-faint); font-size: 10px; line-height: 1; transition: transform .15s; }
.cc.col { transform: rotate(-90deg); }
.ch:hover .cc { color: var(--text); }
.cn { flex: 1 1 auto; min-width: 0; font-family: var(--font-serif); font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.card.collapsed .cn { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cx { flex: none; display: inline-flex; align-items: center; cursor: pointer; color: var(--text-faint); line-height: 1.2; }
.cx:hover { color: var(--text); }
/* 多选 mini-card 列表（master–detail：点行=设为主选看详情，×=移出，active 高亮） */
.msel { display: flex; flex-direction: column; gap: 4px; margin-top: 9px; max-height: 230px; overflow-y: auto; }
.mrow { display: flex; align-items: center; gap: 7px; padding: 5px 6px; border: 1px solid var(--border); border-left: 3px solid transparent; cursor: pointer; }
.mrow:hover { background: color-mix(in srgb, var(--surface-2) 70%, transparent); }
.mrow.active { border-left-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.mrow .mmain { flex: 1; min-width: 0; }
.mrow .mr1 { display: flex; align-items: baseline; gap: 6px; }
.mrow .mnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text); }
.mrow .mkind { flex: none; font-size: 9.5px; color: var(--accent); border: 1px solid var(--accent); padding: 0 4px; }
.mrow .msub { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mrow .mx { flex: none; display: inline-flex; align-items: center; color: var(--text-faint); opacity: 0; cursor: pointer; }
.mrow:hover .mx { opacity: 1; }
.mrow .mx:hover { color: #ff6b6b; }
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
/* 卡片「覆盖圈」小节：分段(波束角/最低仰角) + 数值输入 + ° 后缀 + 锁 */
.covdef { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.covin { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.covi { width: 52px; border: 0; border-bottom: 1px solid var(--border-strong); background: transparent; outline: none; color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12px; text-align: right; padding: 1px 0; }
.covi:focus { border-bottom-color: var(--accent); }
.covu { color: var(--text-faint); font-size: 11px; }
.covlock { cursor: pointer; display: inline-flex; align-items: center; color: var(--text-faint); transition: color .12s ease; }
.covlock:hover { color: var(--text-muted); }
.covlock.on { color: var(--accent); }

/* 覆盖图：右侧停靠面板（挤压地球，独占右栏） */
/* 右侧边栏：与「设置弹窗」一致——surface 底色、统一表头/分区内边距与标题字号 */
.cov-side { width: 286px; flex: none; border-left: 1px solid var(--border-strong); background: var(--surface); overflow-y: auto; display: flex; flex-direction: column; font-size: 12px; }

/* ===== 侧栏视图（Teleport 到 App.vue #side-view；活动栏切换，同屏只显示一个） ===== */
.sview { display: flex; flex-direction: column; min-height: 0; }
/* 星座视图工具块：卫星搜索 + 旋转/实时开关 + 在轨/OMM 状态行 */
.ptool { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.ptool .search input { width: 100%; box-sizing: border-box; }
.ptool .search .panel { width: 100%; }
/* 搜索筛选状态条（确认感：小圆点 + 词 + 清除，克制不卡通） */
.fbar { display: flex; align-items: center; gap: 6px; margin: 2px 0 0; font-size: 11px; color: var(--text-muted); }
.fbar .fdot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.fbar b { color: var(--text); font-weight: 600; max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fbar .fx { margin-left: auto; color: var(--text-faint); cursor: pointer; padding: 0 2px; }
.fbar .fx:hover { color: var(--danger); }
/* 「存为组」按钮：吃掉右推空间（清除紧随其后，故取消清除自身的 auto） */
.fbar .fsave { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; color: var(--accent); cursor: pointer; padding: 1px 6px; border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); border-radius: 4px; white-space: nowrap; }
.fbar .fsave:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.fbar .fsave ~ .fx { margin-left: 0; }
.fbar.selbar .fdot.sel { background: var(--accent); }   /* 多选栏用强调色圆点，区别于筛选栏的绿点 */
.pchips { display: flex; gap: 6px; }
.pchips .mini { flex: 1; text-align: center; padding: 3px 0; }
/* 「发送到小程序」是动作不是开关（旁边两个是开关），故用强调色描边区分；字更长，多占一份宽度 */
.pchips .mini.act { flex: 1.7; display: inline-flex; align-items: center; justify-content: center; gap: 4px; white-space: nowrap;
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.pchips .mini.act:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.pstat { color: var(--text-faint); font-size: 11px; line-height: 1.5; }
/* 星座分组列表（grprow 而非 pgrow：后者是 GXT 逐档色行的既有类名，避免撞名） */
.pgl { padding: 4px 0 8px; }
.grprow { display: flex; align-items: center; gap: 7px; padding: 4px 12px 4px 6px; font-size: 12.5px; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.grprow:hover { background: var(--surface-2); color: var(--text); }
.grprow.sel { background: var(--accent); color: var(--bg); }
.grprow .pgico { flex: none; display: inline-flex; color: var(--text-faint); }
.grprow:hover .pgico, .grprow.sel .pgico { color: inherit; }
.grprow .pgn { flex: 1; overflow: hidden; text-overflow: ellipsis; }
/* 星点颜色：小色块（覆盖原生取色器）+ 悬停复位×（仅有覆盖色时出现） */
/* .pgclr/.pgsw/.pgrst 是通用件：内置分组行 / 卫星组行 / 组管理器（着色区、成员行）共用 */
.pgclr { position: relative; flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.pgclr input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.pgsw { width: 11px; height: 11px; border-radius: 3px; box-sizing: border-box; border: 1px solid rgba(0,0,0,.3); box-shadow: 0 0 0 1px rgba(255,255,255,.35); }
/* 未设置=斜线空块（随所属星座）；inh=随组色（成员行虚线描边，与单独色区分） */
.pgsw.unset { background: linear-gradient(135deg, transparent 44%, var(--text-faint) 44%, var(--text-faint) 56%, transparent 56%); box-shadow: none; border-color: var(--text-faint); }
.pgsw.inh { box-shadow: none; border: 1px dashed rgba(0,0,0,.45); }
.pgrst { flex: none; display: inline-flex; padding: 0 1px; color: var(--text-faint); cursor: pointer; opacity: 0; }
.grprow:hover .pgrst, .ccrow:hover .pgrst { opacity: 1; }
.pgrst:hover { color: #ff6b6b; }
.grprow.sel .pgrst, .ccrow.sel .pgrst { color: var(--bg); opacity: .85; }
/* 行首展开箭头（内置组 / 卫星组 / 自定义星座 三处同一枚）：只管展开卫星列表，与行本身的点击语义分开 */
.pgex { flex: none; width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); border-radius: 3px; }
.pgex:hover { color: var(--text); background: var(--bg); }
.pgex.none { visibility: hidden; }
.grprow:hover .pgex, .ccrow:hover .pgex { color: var(--text-muted); }
.grprow.sel .pgex, .ccrow.sel .pgex { color: inherit; }
.grprow.sel .pgex:hover, .ccrow.sel .pgex:hover { background: color-mix(in srgb, var(--bg) 30%, transparent); }
.grprow.exp:not(.sel), .ccrow.exp:not(.sel) { color: var(--text); }
/* 「加入组」弹出菜单：fixed 锚在操作条按钮下沿（侧栏祖先无 transform，不会被 overflow 裁掉） */
.lmenu-bd { position: fixed; inset: 0; z-index: 2190; }
.lmenu { position: fixed; z-index: 2200; width: 200px; max-height: 280px; overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 6px 20px rgba(0,0,0,.28); padding: 3px 0; }
.lmh { padding: 4px 10px 5px; font-size: 10.5px; color: var(--text-faint); border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
.lmi { display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.lmi:hover { background: var(--surface-2); color: var(--text); }
.lmi > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lmi > em { flex: none; font-style: normal; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.lmi.new { color: var(--accent); border-bottom: 1px solid var(--border); }
/* 行右键菜单（内置星座 / 卫星组 / 自定义星座三类行共用）：与 .lmenu 同一层级与视觉，条目带图标 */
.rmenu { position: fixed; z-index: 2200; min-width: 186px; max-width: 300px; max-height: calc(100vh - 8px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 6px 20px rgba(0,0,0,.28); padding: 3px 0; }
.rmh { display: flex; align-items: baseline; gap: 8px; padding: 4px 10px 5px; font-size: 10.5px; color: var(--text-faint); border-bottom: 1px solid var(--border); }
.rmh > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); }
.rmh > em { flex: none; font-style: normal; font-variant-numeric: tabular-nums; }
.rmi { display: flex; align-items: center; gap: 7px; padding: 5px 10px; font-size: 12px; color: var(--text-muted); cursor: pointer; }
.rmi > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rmi > em { flex: none; max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-style: normal; font-size: 10.5px; color: var(--text-faint); }
.rmi:hover { background: var(--surface-2); color: var(--text); }
.rmi.dis, .rmi.dis:hover { color: var(--text-faint); opacity: .45; cursor: default; background: none; }
.rmi.del { color: var(--danger); }
.rmi.del:hover { background: color-mix(in srgb, var(--danger) 14%, transparent); }
.rmi.del.arm { background: color-mix(in srgb, var(--danger) 18%, transparent); font-weight: 600; }
.rms { height: 1px; background: var(--border); margin: 3px 6px; }
/* 自定义星座（仿 STK Walker 生成器）：侧栏区 + 列表 */
.ccsec { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
.cchd { display: flex; align-items: center; justify-content: space-between; padding: 4px 12px; font-size: 11.5px; color: var(--text-muted); }
.cchd .lnk { cursor: pointer; color: var(--accent); display: inline-flex; align-items: center; gap: 3px; }
.cctip { padding: 2px 12px 6px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.ccep { display: flex; align-items: center; gap: 6px; padding: 2px 12px 6px; }
.ccep > label { flex: none; font-size: 11px; color: var(--text-muted); }
.ccep > .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 11px; color: var(--text); outline: none; }
.ccep > .lnk { flex: none; cursor: pointer; color: var(--accent); font-size: 11px; }
.ccrow { display: flex; align-items: center; gap: 6px; padding: 4px 12px 4px 6px; font-size: 12px; color: var(--text-muted); }
.ccrow:hover { background: var(--surface-2); color: var(--text); }
.ccrow.off { opacity: 0.5; }
.ccrow.sel { background: var(--accent); color: var(--bg); }
.ccrow.sel .cccode { color: var(--bg); opacity: 0.75; }
.ccrow.sel .ccic { color: var(--bg); }
.ccrow .ccdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.ccrow .ccnm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccrow .cccode { flex: none; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.ccrow .ccic { flex: none; display: inline-flex; cursor: pointer; color: var(--text-faint); padding: 1px; }
.ccrow .ccic:hover { color: var(--text); }
.ccrow .ccic.del:hover { color: #ff6b6b; }
.ccrow .ccic.add { color: var(--ok); }
.ccrow.sel .ccic.add { color: var(--bg); }
.ccrow .ccic.ok:hover { color: var(--accent); }
.ccrow.sel .ccic.del.warn { color: #ffd7d7; }
/* 卫星组：段头计数 + 新建/管理入口 + 行内重命名输入 + 删除确认高亮 */
.cchd .ccsub { font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.cchd .cchr { display: flex; align-items: center; gap: 9px; }
.ccrow .ccic.del.warn { color: #ff6b6b; }
.sgrow .sgnm-in { flex: 1; min-width: 0; border: 1px solid var(--accent); background: var(--bg); color: var(--text); font-size: 12px; padding: 1px 5px; border-radius: 3px; outline: none; }
/* 向导：预设条 + 汇总 */
.ccpreset { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0; }
.ccpz { border: 1px solid var(--border); color: var(--text-muted); padding: 2px 7px; font-size: 11px; cursor: pointer; border-radius: 3px; }
.ccpz:hover { border-color: var(--accent); color: var(--text); }
.ccsum { margin-top: 10px; padding: 7px 9px; background: var(--surface-2); font-size: 11.5px; color: var(--text-muted); }
.ccsum .cccode { color: var(--accent); font-weight: 600; }
/* 内联生成/编辑面板（停靠式，地图保持可见 + 实时预览）；短标签左置、长标签上置，避免截断 */
.sview.editing { flex: 1; min-height: 0; }
.cedit { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.cehd { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--border); flex: none; }
.cehd .ceback { display: inline-flex; align-items: center; gap: 1px; color: var(--text-muted); cursor: pointer; font-size: 12px; }
.cehd .ceback:hover { color: var(--text); }
.cehd .cetitle { font-size: 12.5px; color: var(--text); font-weight: 600; }
.cehd .celive { margin-left: auto; font-size: 10px; color: var(--accent); letter-spacing: .3px; }
.cebody { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px; }
.cesec { margin: 13px 0 8px; padding-top: 9px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 11px; }
.cef { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.cef > label { width: 68px; flex: none; color: var(--text-muted); font-size: 12px; }
.cef > .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 4px 7px; font-size: 12px; color: var(--text); outline: none; }
.cef > .u { flex: none; width: 16px; color: var(--text-muted); font-size: 11px; }
.cef > .clr { flex: 1; height: 24px; }
.cefv { margin-bottom: 8px; }
.cefv > label { display: block; color: var(--text-muted); font-size: 11.5px; margin-bottom: 3px; }
.cefv .ceinp { display: flex; align-items: center; gap: 6px; }
.cefv .ceinp > .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 4px 7px; font-size: 12px; color: var(--text); outline: none; }
.cefv .ceinp > .u { flex: none; color: var(--text-muted); font-size: 11px; }
.cetpf { display: flex; gap: 8px; margin-bottom: 8px; }
.cetpf > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cetpf small { color: var(--text-muted); font-size: 10.5px; }
.cetpf .ci { width: 100%; box-sizing: border-box; border: 1px solid var(--border); background: var(--bg); padding: 4px 6px; font-size: 12px; color: var(--text); outline: none; }
.seg3 { display: flex; flex: 1; }
.seg3 > span { flex: 1; text-align: center; border: 1px solid var(--border); border-left-width: 0; padding: 4px 0; cursor: pointer; font-size: 12px; color: var(--text-muted); }
.seg3 > span:first-child { border-left-width: 1px; }
.seg3 > span.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.seg3 > span:hover:not(.on) { color: var(--text); }
.ceread { margin-top: 13px; padding: 8px 10px; background: var(--surface-2); }
.ceread .crcode { color: var(--accent); font-weight: 600; font-size: 13px; font-variant-numeric: tabular-nums; }
.ceread .crsub { color: var(--text-muted); font-size: 11px; margin-top: 3px; line-height: 1.5; }
.ceread .crwarn { color: #e0a030; font-size: 11px; margin-top: 4px; line-height: 1.5; }
.cefoot { display: flex; gap: 10px; padding: 10px 12px; border-top: 1px solid var(--border); flex: none; }
.cefoot .cancel { margin-left: auto; color: var(--text-muted); border: 1px solid var(--border); padding: 4px 14px; cursor: pointer; font-size: 12px; }
.cefoot .cancel:hover { color: var(--text); }
.cefoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: 12px; }
/* 面板停靠形态：占满侧栏宽度、去左缘边框，滚动交给侧栏整体 */
.cov-side.docked { width: auto; border-left: 0; overflow: visible; }
.csh { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); }
.csn { font-family: var(--font-serif); font-size: 15px; padding: 11px 16px; align-self: center; }
.flatbtn { align-self: center; margin-left: 10px; flex: none; border: 1px solid var(--border); padding: 2px 9px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; }
.flatbtn:hover { border-color: var(--accent); color: var(--text); }
.flatbtn.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
/* 关闭按钮：与「文件管理」一致——Windows 风矩形热区，悬停变红 */
.winx { width: 44px; margin-left: auto; align-self: stretch; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background .12s, color .12s; }
.winx:hover { background: #c42b1c; color: #fff; }
.sec { padding: 12px 16px; border-bottom: 1px solid var(--border); }
.srow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.srow:last-child { margin-bottom: 0; }
/* 固定宽度需能容纳最长标签（如「升交点赤经」5 字）且不换行，原 36px 对 3 字以上标签会折行、拖乱整排对齐 */
.srow label { color: var(--text-muted); width: 70px; flex: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.srow select, .srow .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 3px 6px; font-size: 12px; outline: none; color: var(--text); }
/* 置灰但可读（SATSOFT 灰字镜像值）：faint 淡到读不出数，禁用态语义靠底色+虚线边框已足够 */
.srow .ci:disabled { background: var(--surface); color: var(--text-muted); cursor: not-allowed; border-style: dashed; }
.srow .u { color: var(--text-muted); }
.seg { display: flex; border: 1px solid var(--border); }
.seg .sg { padding: 3px 12px; cursor: pointer; color: var(--text-muted); }
.seg .sg.on { background: var(--accent); color: var(--bg); }
.nseg { font-size: 12px; }
.nseg .sg { padding: 3px 8px; }
.nseg .sg + .sg { border-left: 1px solid var(--border); }
.sect { display: flex; align-items: center; margin-bottom: 6px; color: var(--text-muted); }
.sect .lnk { margin-left: auto; color: var(--accent); cursor: pointer; font-size: 11.5px; }
.sect .lnk.on { font-weight: 600; text-decoration: underline; }
.sect .lnk:hover { text-decoration: underline; }   /* 与 SatCovPanel / GrdSetSections 同一手感 */
/* 分区标题旁的「小眼睛」显隐开关：睁眼=显示，闭眼（带斜杠/淡出）=隐藏 */
.eyebtn { display: inline-flex; align-items: center; margin-left: 7px; cursor: pointer; color: var(--text-muted); }
.eyebtn:hover { color: var(--text); }
.eyebtn.off { color: var(--text-faint); }
/* 天线设置区标题：撑满分区宽度的标题条（Blender Properties / VS Code 面板头同款），
   与其余 .sect 的纯文字小标题区分开，明确「以下均为当前聚焦天线的属性」 */
.setsect { margin: -12px -16px 10px; padding: 9px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
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
.tip.warn { color: var(--warn, #d98a2b); }
/* GRD 工程树：卫星 → 天线（二级层次，竖向引导线 + 统一缩进） */
.gtree { margin-top: 6px; max-height: clamp(280px, 48vh, 620px); overflow-y: auto; }
/* 卫星行（节点头） */
.gsat { display: flex; align-items: center; gap: 6px; padding: 4px 4px 4px 2px; color: var(--text); font-size: 13px; border-radius: 3px; }
.gsat:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.gsat .tri { font-style: normal; flex: none; width: 12px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: 9px; cursor: pointer; transition: transform .12s; }
.gsat .tri.open { transform: rotate(90deg); }
.gsat .gsname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; line-height: 1.3; cursor: pointer; }
.gsat .gsname:hover { color: var(--accent); }
.gsat .gsname em { font-style: normal; margin-left: 5px; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.gsat .gsname .simtag { font-style: normal; margin-left: 5px; padding: 0 4px; border: 1px solid var(--accent); border-radius: 2px; color: var(--accent); font-size: 10px; vertical-align: middle; }
.gsvg { flex: none; width: 14px; height: 14px; }
.gsat .sat-svg { width: 18px; height: 18px; color: var(--text); opacity: .92; }   /* 跟随主题文字色；18px 比默认 .gsvg 大一档，14px 下看不出卫星轮廓 */
/* 卫星行显示开关（卫星名 / 仰角线）：图标按钮，与 .sacts 操作图标以竖线分组，语汇同 .gant .ant-btn（hover 底色淡入） */
.sdisp { flex: none; display: flex; align-items: center; gap: 1px; margin-left: 4px; padding-left: 6px; border-left: 1px solid var(--border); }
.sdisp .ic { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 3px; color: var(--text-faint); opacity: .55; cursor: pointer; transition: opacity .12s, color .12s, background .12s; }
.sdisp .ic:hover { opacity: 1; color: var(--text); background: color-mix(in srgb, var(--text) 8%, transparent); }
.sdisp .ic.on { opacity: 1; color: var(--accent); }
.gant .ant-btn { display: flex; align-items: center; justify-content: center; flex: none; width: 18px; height: 18px; margin: -2px 0; border-radius: 3px; transition: background .12s; }
.gant .ant-btn:hover { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.gant .ant-svg { width: 13px; height: 13px; color: var(--text-faint); transition: color .12s; }
.gant .ant-btn.on .ant-svg { color: var(--accent); }
.gant .ant-svg.ant-off { color: var(--text-faint); opacity: .7; }
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

/* —— 波束合成（独立侧栏视图；SATSOFT Gaussian Beam Model / Polygon 赋形） —— */
.bs-side .tip b { color: var(--text-muted); font-weight: 600; }
.bs-tabs { display: flex; width: 100%; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; }
.bs-tab { flex: 1; text-align: center; padding: 4px 0; font-size: 11.5px; color: var(--text-muted); cursor: pointer; user-select: none; }
.bs-tab + .bs-tab { border-left: 1px solid var(--border); }
.bs-tab:hover { color: var(--text); }
.bs-tab.on { background: var(--accent); color: var(--bg); }
.bs-cnt { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.bs-plist { display: flex; flex-direction: column; gap: 1px; max-height: 172px; overflow-y: auto; margin: 4px 0 2px; padding: 3px 6px; border: 1px solid var(--border); border-radius: 4px; }
.bs-plist .chk2 { margin: 0; padding: 2px 0; }
.bs-read { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--text-muted); margin: 5px 0 2px; font-family: var(--font-mono); }
.bs-read b { color: var(--accent); font-weight: 600; }
/* 天线参数：算出读数（效率/方向性等强调） */
.bs-read2 { display: flex; gap: 14px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); margin: 7px 0 3px; font-family: var(--font-mono); }
.bs-read2 b { color: var(--accent); font-weight: 700; font-size: 12.5px; }
/* 天线参数：二选一驱动行（左侧单选点＝驱动，选中者可编辑、另一者只读自动算——对齐 SATSOFT 单选按钮） */
.bs-drv > label { width: 56px; cursor: pointer; }
.bs-drv.act > label { color: var(--text); }
.rdo { flex: none; width: 12px; height: 12px; border-radius: 50%; border: 1.5px solid var(--text-faint); box-sizing: border-box; cursor: pointer; transition: border-color .12s, background .12s; }
.rdo:hover { border-color: var(--text-muted); }
.rdo.on { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 2px var(--bg); }
.bs-prow { display: flex; align-items: center; gap: 6px; padding: 2px 0; }
.bs-pchk { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; cursor: pointer; }
.bs-pchk input { margin: 0; flex: none; }
.bs-pnm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.bs-pval { width: 52px; flex: none; text-align: right; }
.bs-pvu { flex: none; font-size: 11px; color: var(--text-muted); }
/* 峰点引导（连续目标场）行 */
.bs-hshead, .bs-hsrow { display: grid; grid-template-columns: 21px 1fr 1fr 1fr 1fr 18px 16px; gap: 4px; align-items: center; padding: 2px 0; }
.bs-hshead { font-size: 10px; color: var(--text-faint); padding: 3px 0 0; }
.bs-hshead span { text-align: center; }
.bs-hsn { font-size: 11px; color: #ff9a3c; font-family: var(--font-mono); }
.bs-hsrow .ci { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid var(--border); background: var(--bg); padding: 2px 4px; font-size: 11px; color: var(--text); border-radius: 3px; outline: none; text-align: right; }
.bs-hsrow .hic { display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-faint); border: 1px solid transparent; border-radius: 3px; padding: 2px; }
.bs-hsrow .hic:hover { color: var(--text); }
.bs-hsrow .hic.on { color: #ff9a3c; border-color: #ff9a3c; }
.bs-hsrow .hic.hdel:hover { color: #ff6a6a; }
.bs-ops { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; margin-bottom: 5px; }
.bs-hex { display: flex; align-items: center; gap: 5px; margin: 5px 0; }
.bs-hex label { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.bs-hex select { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); color: var(--text); padding: 2px 6px; font-size: 11.5px; border-radius: 4px; outline: none; cursor: pointer; }
.bs-hex select:hover { border-color: var(--accent); }
.opb.sm { padding: 3px 10px; flex: none; }
.chk-in { display: inline-flex; align-items: center; gap: 3px; font-size: 10.5px; color: var(--text-muted); white-space: nowrap; }
.chk-in input { margin: 0; }
.bs-list { margin-top: 5px; max-height: 168px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; }
.bs-brow { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: 11px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-brow:last-child { border-bottom: none; }
.bs-bi { width: 20px; text-align: center; color: var(--accent); font-family: var(--font-mono); flex: none; }
.bs-bll { flex: 1; color: var(--text-muted); font-family: var(--font-mono); }
.bs-bth { color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; white-space: nowrap; }
.bs-bth em { color: var(--text-faint); font-style: normal; }
.bs-status { font-size: 10.5px; color: var(--accent); line-height: 1.5; margin-top: 5px; }
.bs-gen { display: flex; justify-content: center; align-items: center; gap: 5px; width: 100%; box-sizing: border-box; margin-top: 4px; background: var(--accent); color: var(--bg); font-size: 12px; font-weight: 600; padding: 5px 0; border-radius: 4px; cursor: pointer; user-select: none; }
.bs-gen:hover { filter: brightness(1.08); }
.ci.wide { width: 100%; }
/* 轮廓与编号样式行：同一行放两组「标签+短输入」；lb2=行内第二个标签 */
/* 允许换行 + 把「线宽/字号 + 输入 + 单位」打包成不可分割的 .uw 组：窄面板下整组整体折到次行，
   单位 px/% 永不被右边缘裁掉（此前 px 溢出被切）；宽度够时靠 margin-left:auto 贴右保持单行。 */
.bs-side .srow { flex-wrap: wrap; row-gap: 6px; }
.bs-side .srow .uw { display: inline-flex; align-items: center; gap: 6px; flex: none; white-space: nowrap; margin-left: auto; }
.bs-side .srow .ci.sm { flex: none; width: 48px; }
.bs-side .srow .lb2 { flex: none; width: auto; font-size: 11px; color: var(--text-muted); white-space: nowrap; }
/* 颜色输入固定小方块：全局 .clr 有两条冲突规则、后者 flex:1 会被行内其它控件挤成一条细线看不清色，这里锁定尺寸 */
.bs-side .srow .clr { flex: none; width: 26px; height: 20px; background: none; }
/* —— 赋形反射面模型（对齐 SATSOFT Shaped Reflector 对话框）：只读值 / 波长读数 / 几何预览图 —— */
.bs-ro { font-size: 12px; color: var(--text-muted); }
.bs-wl { flex: none; font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; }
/* 站点栅编辑：操作按钮行 + 平面图框选橡皮筋（fixed 屏幕像素，指针事件穿透） */
.bs-strow { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.bs-boxsel { position: fixed; z-index: 900; border: 1px dashed var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); pointer-events: none; }
.bs-refl { margin: 6px 0 2px; border: 1px solid var(--border); border-radius: 4px; padding: 3px; background: color-mix(in srgb, var(--text) 3%, transparent); }
.bs-refl svg { width: 100%; display: block; }
.bs-reflbar { display: flex; align-items: center; justify-content: center; gap: 8px; margin: 2px 0 0; }
.bs-reflbar .pgb { cursor: pointer; color: var(--accent); user-select: none; font-size: 11px; line-height: 1; padding: 2px 4px; }
.bs-reflbar .pgb:hover { filter: brightness(1.2); }
.bs-reflpg { font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.bs-reflcap { font-size: 10px; color: var(--text-faint); margin-left: 4px; }
/* 频率计划图例：色块 + 色号 + 数量 */
.bs-fcleg { display: flex; flex-wrap: wrap; gap: 4px 10px; margin: 5px 0 2px; }
.bs-fchip { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text-muted); font-family: var(--font-mono); }
.bs-fchip i { width: 10px; height: 10px; border-radius: 2px; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-fchip em { font-style: normal; color: var(--text-faint); }
/* 频率计划：波束信息列表（可多列复制到 Excel）——紧凑显示 4 列，复制展开为 7 列 TSV */
.bs-fplist { margin-top: 7px; }
.bs-fphd { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.bs-fphd > span:first-child { font-size: 11px; color: var(--text-muted); }
.bs-fphd em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); }
.bs-fpcp { display: inline-flex; align-items: center; gap: 4px; padding: 2px 9px; border: 1px solid var(--border); border-radius: 2px; color: var(--text-muted); font-size: 11px; cursor: pointer; white-space: nowrap; transition: color .12s, border-color .12s; }
.bs-fpcp:hover { border-color: var(--accent); color: var(--text); }
.bs-fpcp.ok { border-color: color-mix(in srgb, #3fb77f 60%, transparent); color: #3fb77f; }
.bs-fptbl { max-height: 176px; overflow-y: auto; border: 1px solid var(--border); border-radius: 4px; }
.bs-fpr { display: flex; align-items: center; gap: 6px; padding: 2px 6px; font-size: 10.5px; font-family: var(--font-mono); border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-fpr:last-child { border-bottom: none; }
.bs-fph { position: sticky; top: 0; background: var(--surface); color: var(--text-faint); font-size: 10px; z-index: 1; }
.bs-fpr .c-no { width: 24px; text-align: right; flex: none; color: var(--accent); }
.bs-fph.bs-fpr .c-no { color: var(--text-faint); }
.bs-fpr .c-fc { width: 42px; flex: none; display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted); }
.bs-fpr .c-fc i { width: 9px; height: 9px; border-radius: 2px; flex: none; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-fpr .c-ll { flex: 1; min-width: 0; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bs-fpr .c-th { flex: none; color: var(--text-faint); white-space: nowrap; }
.bs-fpr .c-th em { font-style: normal; }
/* 相控阵赋形：星上激励指令表 */
.bs-excbar { display: flex; gap: 6px; align-items: center; margin: 6px 0 5px; }
.bs-exctbl { max-height: 220px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
/* 真 <table>：支持鼠标框选任意行列 → Ctrl+C（浏览器原生按 TSV 复制，粘进 Excel 自动分列） */
.bs-exctable { border-collapse: collapse; width: 100%; font-size: 10.5px; font-family: var(--font-mono); }
.bs-exctable th, .bs-exctable td { padding: 2px 7px; text-align: right; white-space: nowrap; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.bs-exctable tbody tr:last-child td { border-bottom: none; }
.bs-exctable thead th { position: sticky; top: 0; background: var(--panel, var(--bg)); color: var(--text-faint); font-weight: normal; z-index: 1; }
.bs-exctable td:first-child { color: var(--accent); }
.bs-exctable tbody tr:hover td { background: color-mix(in srgb, var(--accent) 8%, transparent); }
/* —— 导航器：波束组列表 + 新建/工具行 —— */
.bs-grps { display: flex; flex-direction: column; gap: 2px; margin: 6px 0 5px; max-height: 190px; overflow-y: auto; }
.bs-grow { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; font-size: 11.5px; }
.bs-grow:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-grow.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.bs-grow.hid { opacity: .5; }
.bs-gk { flex: none; font-size: 10px; padding: 1px 5px; border-radius: 3px; color: #fff; letter-spacing: .5px; }
.bs-gk.gauss { background: #4f8fe8; }
.bs-gk.shaped { background: #3fb77f; }
.bs-gk.pam { background: #a06fdc; }
.bs-gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.bs-grow.on .bs-gname { color: var(--accent); font-weight: 600; }
.bs-gcnt { flex: none; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.bs-grow .gic { flex: none; display: inline-flex; color: var(--text-faint); opacity: 0; cursor: pointer; }
.bs-grow:hover .gic, .bs-grow.on .gic { opacity: .75; }
.bs-grow .gic:hover { color: var(--text); opacity: 1; }
.bs-grow .gic.del:hover { color: #ff6a6a; }
.bs-empty { padding: 10px 6px; text-align: center; color: var(--text-faint); font-size: 11px; border: 1px dashed var(--border); border-radius: 4px; }
.bs-empty2 { padding: 6px 2px; color: var(--text-faint); font-size: 11.5px; line-height: 1.6; }
.bs-addrow { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; margin-bottom: 5px; }
.bs-navops { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
.bs-navops .opb { display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
.opb.dis { opacity: .4; pointer-events: none; }
/* —— 波束设置 chip 条 —— */
.bs-chips { display: flex; flex-wrap: wrap; gap: 5px; margin: 4px 0 6px; }
.bs-chip { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid var(--border); border-radius: 12px; font-size: 11px; color: var(--text-muted); cursor: pointer; white-space: nowrap; }
.bs-chip:hover { color: var(--text); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.bs-chip.on { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 12%, transparent); }
.bs-chip i { width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1px solid color-mix(in srgb, #fff 25%, transparent); }
.bs-chip em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; }
.bs-chip.add { color: var(--accent); font-weight: 600; padding: 3px 10px; }
/* —— 检查器折叠头 —— */
.sect.acc { cursor: pointer; user-select: none; gap: 5px; }
.sect.acc:hover { color: var(--text); }
.sect.acc .app-icon { flex: none; color: var(--text-faint); }

/* —— 可见性分析（Access / Coverage）：目标/参数 + KPI 摘要 + 可见星结果表 —— */
/* —— 环境场面板：结构与可见性分析同源，只多一个「显示总开关」和数据源标注行 —— */
.env-side .tip.inl { display: inline; margin-left: 0; }
.env-side .env-on { margin-top: 2px; }
.env-side .env-src { min-height: 16px; }
.env-side .chk2.dis { opacity: 0.45; cursor: not-allowed; }
.env-side .cov-num { flex: none; width: 54px; }

/* 分节头读数：加了「x% 时间覆盖」后可能长过标题剩余宽度 → 省略号收边（完整定义在 title 里），不许换行顶开表头 */
.vis-side .sect .vis-cnt { margin-left: auto; padding-left: 8px; min-width: 0; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vis-side .sect .vis-cnt.on { color: var(--ok); }
/* 卫星集来源行：下拉（当前显示 / 默认卫星组 / 卫星组 / 自定义卫星）+ 颗数，与「目标」「仰角门限」同为分析设定行 */
.vis-satset .vis-satsel { flex: 1; min-width: 0; }
.vis-satset .vis-satn { flex: none; text-decoration: none; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 11px; white-space: nowrap; }
.vis-side .tip.inl { display: inline; margin-left: 8px; }
.vis-side .vis-elev { flex: none; width: 58px; }
.vis-icrow { align-items: center; gap: 5px; }
.vis-icrow > label:first-child { flex: none; width: 46px; }
.vis-icrow .vis-slider { flex: 1; min-width: 30px; }
.vis-icrow .u { flex: none; min-width: 14px; text-align: right; }
.vis-clr { flex: none; width: 22px; height: 18px; padding: 0; border: 1px solid var(--border); border-radius: 3px; background: none; cursor: pointer; }
.vis-icrow .chk-in { flex: none; }
/* 紧凑摘要（一行内联，去卡片——克制不卡通） */
.vis-sum { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; margin: 6px 0 7px; font-size: 11px; color: var(--text-faint); }
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
.vis-lhead { font-size: 10px; color: var(--text-faint); padding: 3px 6px 4px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); z-index: 1; }
.vis-lhead > span:not(.vis-lname):not(.vis-lc) { text-align: right; }
.vis-lhead .vis-lc { text-align: center; }
.vis-lhead .sortable, .vis-acc-hd .sortable { cursor: pointer; user-select: none; }
.vis-lhead .sortable:hover, .vis-acc-hd .sortable:hover { color: var(--text-muted); }
.vis-lhead .sortable.on, .vis-acc-hd .sortable.on { color: var(--ok); }
.vis-list { max-height: 280px; overflow-y: auto; }
.vis-lrow { padding: 3px 6px; font-size: 11px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); color: var(--text-muted); }
.vis-lrow:last-child { border-bottom: none; }
.vis-lrow.hi { color: var(--text); font-weight: 600; }
.vis-lrow.hov { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.vis-lrow > span:not(.vis-lname):not(.vis-lc):not(.vis-lel) { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-lname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* GEO 定点标注（'110.5°E'）：名字后的淡色小字，瞬时表 / 过境表 / 甘特共用 */
.vis-slot { text-decoration: none; margin-left: 5px; color: var(--text-faint); font-size: 10px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-lc { text-align: center; font-size: 9.5px; }
.vis-lel { display: flex; align-items: center; justify-content: flex-end; gap: 3px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vis-ud { font-style: normal; font-size: 9px; width: 7px; display: inline-block; text-align: center; }
.vis-ud.up { color: var(--ok); } .vis-ud.dn { color: var(--text-faint); }
/* ACCESS 时段过境：mode 切换 + 甘特 + 过境列表 */
.vis-mode { margin: 8px 0; }
/* 三模式切换（瞬时可见 / 时段过境 / 覆盖）：等宽分段控件——锐边仪器风 + 凹槽轨道 + 活动段实色填充。
   ① 等宽 flex:1 铺满面板宽度（原为内容宽、左侧挤成一坨）；② 轨道给 --surface 凹槽感、活动段 --accent 实填；
   ③ 活动段文字用 var(--bg) 而非写死 #fff——深色主题 accent≈白，写死白字=白底白字看不见；
   ④ 非活动段悬停给反馈；⑤ 段间加 1px 分隔线，紧邻活动块的分隔线转透明使实色边缘干净。
   仅作用于本控件：.seg.sm 复用面广，用 .seg.sm.vis-mode 提高特指度收窄作用域，不动通用 .seg。 */
.seg.sm.vis-mode { background: var(--surface); border-color: var(--border); }
.seg.sm.vis-mode .sg { flex: 1; text-align: center; padding: 4px 6px; font-size: 11.5px; color: var(--text-muted); transition: background .12s ease, color .12s ease; }
.seg.sm.vis-mode .sg + .sg { border-left: 1px solid var(--border); }
.seg.sm.vis-mode .sg:hover:not(.on) { background: var(--surface-2); color: var(--text); }
.seg.sm.vis-mode .sg.on { background: var(--accent); color: var(--bg); font-weight: 600; }
.seg.sm.vis-mode .sg.on, .seg.sm.vis-mode .sg.on + .sg { border-left-color: transparent; }
.vis-side .u.nw { flex: none; white-space: nowrap; }        /* 「小时」等单位不换行 */
.acc-exp { margin-top: -3px; }                              /* 导出行紧跟时窗行 */
.vis-gantt { margin: 6px 0 4px; display: flex; flex-direction: column; gap: 2px; max-height: 190px; overflow-y: auto; }
.vis-grow { display: grid; grid-template-columns: 78px 1fr; gap: 6px; align-items: center; font-size: 10.5px; padding: 2px 4px; border-radius: 3px; }
.vis-grow.hov { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.vis-gname { min-width: 0; overflow-wrap: anywhere; word-break: break-word; line-height: 1.25; color: var(--text-muted); }
.vis-gbar { position: relative; height: 9px; background: color-mix(in srgb, var(--border) 45%, transparent); border-radius: 2px; }
.vis-gseg { position: absolute; top: 1px; bottom: 1px; min-width: 1.5px; background: color-mix(in srgb, var(--ok) 55%, var(--text-faint)); border-radius: 1px; }
.vis-gseg.hi { background: var(--ok); }
/* 表格行 ⇆ 甘特段 段级联动：悬停的那次过境在甘特上提亮撑满（星级整行底色仍走 .vis-grow.hov） */
.vis-gseg.hov { background: var(--accent); top: 0; bottom: 0; z-index: 1; box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 45%, transparent); }
.vis-acc-hd, .vis-acc-row { display: grid; grid-template-columns: 1fr 58px 58px 30px; gap: 6px; align-items: center; }
.vis-acc-hd { font-size: 10px; color: var(--text-faint); padding: 3px 6px 4px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); z-index: 1; }
.vis-acc-hd > span:not(.vis-lname) { text-align: right; }
.vis-acc-list { max-height: 220px; overflow-y: auto; }
.vis-acc-row { padding: 3px 6px; font-size: 11px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); color: var(--text-muted); }
.vis-acc-row:last-child { border-bottom: none; }
.vis-acc-row.hov { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.vis-acc-row > span:not(.vis-lname) { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
/* —— 时段过境：时基行（时区切换 + 时窗绝对起止）/ 甘特刻度轴 / 日期分隔 / 行展开详情 —— */
.vis-tbase { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; min-width: 0; }
.vis-tzseg { display: inline-flex; flex: none; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.vis-tzseg i { font-style: normal; padding: 1px 7px; cursor: pointer; color: var(--text-faint); font-family: var(--font-mono); font-size: 10px; line-height: 1.6; user-select: none; }
.vis-tzseg i + i { border-left: 1px solid var(--border); }
.vis-tzseg i.on { background: var(--accent); color: var(--bg); }
.vis-tspan { color: var(--text-muted); font-size: 10.5px; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.vis-gaxis { position: sticky; top: 0; z-index: 2; background: var(--surface); }
.vis-gax { position: relative; height: 13px; }
.vis-gtick { position: absolute; top: 0; transform: translateX(-50%); font-size: 9px; line-height: 1; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; text-decoration: none; }
.vis-gtick::before { content: ''; display: block; width: 1px; height: 3px; background: color-mix(in srgb, var(--text-faint) 70%, transparent); margin: 0 auto 1px; }
.vis-gtick.day { color: var(--text-muted); }
.vis-acc-day { position: sticky; top: 0; z-index: 1; background: var(--surface); display: flex; align-items: center; gap: 6px; padding: 4px 6px 3px; font-size: 9.5px; color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: .2px; }
.vis-acc-day::after { content: ''; flex: 1; border-top: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.vis-acc-day s { text-decoration: none; color: var(--text-faint); }
.vis-acc-row { cursor: pointer; }
.vis-acc-row.exp { background: color-mix(in srgb, var(--accent) 8%, transparent); border-bottom-color: transparent; }
.vis-dsup { text-decoration: none; font-size: 8px; vertical-align: super; color: var(--warn); margin-left: 1px; }
.vis-cw { font-style: normal; display: inline-block; margin-right: 3px; font-size: 8px; color: var(--text-faint); transition: transform .15s; transform-origin: 45% 50%; }
.vis-acc-row.exp .vis-cw { transform: rotate(90deg); }
.vis-acc-det { padding: 4px 8px 7px 15px; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); background: color-mix(in srgb, var(--accent) 5%, transparent); }
.vexp-grid { display: grid; grid-template-columns: 32px 1fr 1fr; gap: 1px 8px; font-size: 10.5px; align-items: baseline; }
.vexp-grid .h { color: var(--text-faint); font-size: 9px; font-family: var(--font-mono); }
.vexp-grid .l { color: var(--text-faint); font-size: 10px; }
.vexp-grid .t { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--text); white-space: nowrap; }
.vexp-foot { margin-top: 4px; font-size: 10px; color: var(--text-faint); display: flex; flex-wrap: wrap; gap: 2px 10px; }
.vexp-foot b { font-weight: 600; color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.vexp-foot .vexp-tr { color: var(--warn); font-family: inherit; }
.oc-hi { color: var(--ok); font-weight: 600; }
/* —— 覆盖分析（Coverage / FOM）：区域边界输入 + 配色 + 图例 + KPI —— */
.cov-num { flex: none; width: 100px; }
.cov-b { flex: none; width: 62px; }
.cov-scheme { flex: none; width: 96px; }
.cov-alpha { flex: 1; min-width: 40px; }
.cov-msg { color: var(--warn); }
.cov-legend { margin: 7px 0 6px; }
.cov-legbar { display: flex; height: 11px; border-radius: 3px; overflow: hidden; border: 1px solid var(--border); }
.cov-legbar i { flex: 1 1 0; cursor: help; }
.cov-legsc { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin-top: 3px; font-size: 10px; color: var(--text-faint); }
.cov-legsc span { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.cov-legsc b { color: var(--text-muted); font-weight: 600; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cov-kpi { margin-top: 5px; }

/* —— 标记批量表格浮窗（复用 perf-win 骨架，加分页 tab / 航迹选择条；正文 3 张网格 v-show 切换） —— */
.mk-win { z-index: 61; }
.mk-tabs { display: inline-flex; border: 1px solid var(--border); border-radius: 5px; overflow: hidden; flex: none; }
.mk-tab { padding: 2px 12px; font-size: 11.5px; color: var(--text-muted); cursor: pointer; user-select: none; }
.mk-tab + .mk-tab { border-left: 1px solid var(--border); }
.mk-tab:hover { color: var(--text); }
.mk-tab.on { background: var(--accent); color: var(--bg); }
/* 表体：航迹分页是主从两栏（左栏航迹、右侧航点网格），另两个分页只有网格 */
.mk-main { flex: 1; min-height: 0; display: flex; }
.mk-main > .pin-body { min-width: 0; }
/* —— 航迹左栏 —— */
.mk-trajs { flex: none; width: 156px; display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 55%, transparent); }
.mtj-h { flex: none; display: flex; align-items: center; gap: 4px; padding: 5px 6px 5px 9px; border-bottom: 1px solid var(--border); }
.mtj-ht { flex: 1; font-size: 11px; color: var(--text-faint); }
.mtj-add { display: inline-flex; align-items: center; gap: 1px; font-size: 10.5px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 3px; padding: 1px 5px 1px 3px; cursor: pointer; white-space: nowrap; }
.mtj-add:hover { color: var(--accent); border-color: var(--accent); }
.mtj-list { flex: 1; min-height: 0; overflow-y: auto; padding: 3px 0; }
.mtj-row { display: flex; align-items: center; gap: 6px; padding: 3px 6px 3px 9px; cursor: pointer; user-select: none; border-left: 2px solid transparent; }
.mtj-row:hover { background: color-mix(in srgb, var(--text) 5%, transparent); }
.mtj-row.on { background: color-mix(in srgb, var(--accent) 14%, transparent); border-left-color: var(--accent); }
/* 类型点：航行=橙、飞行=蓝（与图上的航迹线同色），点一下换类型 */
.mtj-k { flex: none; width: 8px; height: 8px; border-radius: 2px; cursor: pointer; }
.mtj-k.sea { background: #ff6a4a; }
.mtj-k.flight { background: #5ad1ff; }
.mtj-k:hover { outline: 2px solid color-mix(in srgb, var(--text) 35%, transparent); outline-offset: 1px; }
.mtj-n { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mtj-row.on .mtj-n { color: var(--text); }
.mtj-c { flex: none; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.mtj-x { flex: none; display: inline-flex; color: var(--text-faint); opacity: 0; cursor: pointer; }
.mtj-row:hover .mtj-x { opacity: .8; }
.mtj-x:hover { color: #ff6a6a; }
.mtj-ren { flex: 1; min-width: 0; font: inherit; font-size: 11.5px; padding: 1px 4px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: 3px; outline: none; }
.mtj-empty { padding: 8px 9px; font-size: 11px; color: var(--text-faint); }

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
/* —— Excel 网格 —— 表体（序号列/列头/单元格/填充柄/右键菜单）全在 src/components/ExcelGrid.vue，
   本页四张表（城市输入 / 性能结果 / 标记三分页 / 波束批量）共用那一份。这里只补插槽里的操作列图标：
   子组件渲染的节点带的是它自己的 scoped 标记，故一律走 :deep()。 */
.eg-host :deep(.eg-act .del) { cursor: pointer; color: var(--text-faint); opacity: 0; display: inline-flex; vertical-align: middle; }
.eg-host :deep(tbody tr:hover .del) { opacity: .8; }
.eg-host :deep(.eg-act .del:hover) { color: #ff6a6a; }
.eg-host :deep(tr.out td) { color: var(--text-faint); }

/* 性能表选项弹窗 */
.sat-mask.perf-opt-mask { z-index: 70; }   /* 提高特异性压过 .sat-mask(z40)，高于性能表浮窗(z60)避免被遮挡 */
.perf-opt-dlg { width: 700px; max-width: calc(100% - 32px); max-height: 88%; display: flex; flex-direction: column; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .55); }
.perf-opt-dlg .sdh em { font-style: normal; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-faint); }
.perf-opt-dlg .sdfoot .po-reset { margin-right: auto; }   /* 「恢复默认」推到左端，「完成」留在右端 */
.perf-opt-body { display: flex; gap: 12px; padding: 12px; overflow: auto; align-items: stretch; }
.po-card { border: 1px solid var(--border); border-radius: 6px; padding: 8px 10px; background: color-mix(in srgb, var(--text) 2.5%, transparent); }
.po-ct { font-size: 11px; font-weight: 600; color: var(--text-muted); letter-spacing: .3px; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.po-cols { flex: 0 0 280px; display: flex; flex-direction: column; }
.po-scroll { flex: 1; overflow: auto; display: grid; grid-template-columns: 1fr 1fr; gap: 0 10px; align-content: start; }
.po-grp { display: contents; }
.po-gt { grid-column: 1 / -1; font-size: 10px; color: var(--text-faint); margin: 6px 0 1px; letter-spacing: .5px; }
.po-gt:first-child { margin-top: 0; }
.po-ck { display: flex; align-items: center; gap: 5px; padding: 2px 0; font-size: 11.5px; color: var(--text); cursor: pointer; min-width: 0; }
.po-ck span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.po-ck input { flex: none; accent-color: var(--accent); }
.po-ck.dis { color: var(--text-faint); cursor: not-allowed; }
.po-ck em { color: var(--text-faint); font-style: normal; }
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

/* —— 城市输入区工具栏：城市组下拉 + 分隔条 —— */
.pin-sep { flex: none; width: 1px; align-self: stretch; margin: 2px 2px; background: var(--border); }
.pin-gsel { flex: none; max-width: 168px; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); border-radius: 4px; outline: none; cursor: pointer; }
.pin-gsel:hover { border-color: var(--accent); }
/* —— 城市组管理弹窗 —— */
.sat-mask.perf-grp-mask { z-index: 70; }   /* 压过性能表浮窗(z60)，避免被遮挡 */
.grp-dlg { width: 460px; max-width: calc(100% - 32px); }
.grp-save { display: flex; align-items: center; gap: 8px; padding-bottom: 10px; margin-bottom: 8px; border-bottom: 1px solid var(--border); }
.grp-name { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 4px 8px; font-size: 12px; color: var(--text); border-radius: 4px; outline: none; }
.grp-name:focus { border-color: var(--accent); }
.grp-save .save { flex: none; background: var(--accent); color: var(--bg); padding: 4px 12px; cursor: pointer; font-size: 11.5px; border-radius: 4px; white-space: nowrap; }
.grp-save .save.dis { opacity: .45; pointer-events: none; }
.grp-list { max-height: 300px; overflow-y: auto; }
.grp-row { display: flex; align-items: center; gap: 6px; padding: 5px 4px; border-bottom: 1px solid color-mix(in srgb, var(--border) 55%, transparent); }
.grp-row.cur { background: color-mix(in srgb, var(--accent) 10%, transparent); }
.grp-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text); }
.grp-cnt { flex: none; font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.grp-row .gbtn { flex: none; font-size: 11px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 1px 7px; cursor: pointer; white-space: nowrap; }
.grp-row .gbtn:hover { color: var(--text); border-color: var(--accent); }
.grp-row .gic { flex: none; display: inline-flex; align-items: center; color: var(--text-faint); cursor: pointer; padding: 1px 2px; }
.grp-row .gic:hover { color: var(--text); }
.grp-row .gic.ok:hover { color: var(--accent); }
.grp-row .gic.del:hover { color: #ff6a6a; }
.grp-row .gic.del.warn { color: #ff6a6a; }
.grp-empty { padding: 18px 8px; text-align: center; font-size: 11.5px; color: var(--text-faint); font-style: italic; }

.gck { flex: none; width: 12px; height: 12px; margin: 0; cursor: pointer; accent-color: var(--accent); }
.gck:disabled { opacity: .35; cursor: not-allowed; }
/* 展开后的子级容器：左侧一条淡引导线统辖「卫星显示开关 + 天线列表」，缩进统一 */
.gbody { margin-left: 9px; padding-left: 12px; border-left: 1px solid var(--border); margin-bottom: 2px; }
/* 天线行（叶子节点） */
.gant { display: flex; align-items: center; gap: 6px; padding: 3px 6px; margin: 1px 0; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-radius: 3px; transition: background .12s, color .12s, box-shadow .12s; }
.gant:hover { color: var(--text); background: color-mix(in srgb, var(--text) 6%, transparent); }
.gant.on { color: var(--text); }                                                                          /* 已选中=绘制中 */
.gant.foc { color: var(--text); background: color-mix(in srgb, var(--accent) 14%, transparent); box-shadow: inset 2px 0 0 var(--accent); font-weight: 600; }   /* 聚焦=编辑中 */
.gant .aname { flex: 1; min-width: 0; white-space: normal; overflow-wrap: break-word; word-break: break-word; line-height: 1.35; }   /* 天线名显示全，过长换行不截断 */
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
/* 电平灰色列改可编辑名：默认透明看似纯文字，hover/focus 现边框；有自定义名时字色转常规、示意已命名 */
.glvrow .lvname { min-width: 0; border: 1px solid transparent; background: transparent; padding: 2px 5px; border-radius: 2px; outline: none; }
.glvrow .lvname:hover { border-color: var(--border); }
.glvrow .lvname:focus { border-color: var(--accent); background: var(--bg); color: var(--text); }
.glvrow .lvname.named { color: var(--text); }
.glvrow .ic.del { cursor: pointer; color: var(--text-faint); }
.glvrow .ic.del:hover { color: #d66; }
.glvadd { padding: 4px 7px; text-align: center; color: var(--text-muted); cursor: pointer; font-size: 11.5px; border-top: 1px solid var(--border); }
.glvadd:hover { color: var(--accent); background: var(--bg); }
/* Beams To Plot 多波束多选列表（SATSOFT 风格） */
/* 列表高度：原 132px 只露 ~5 行，几十个波束时勾选/改名要一直小幅滚动，难操作 → 放到 300px（~12 行）。
   仍是 max-height：波束少时照常按内容收缩，不留空框；右下角可竖向拖拽压扁，给下方「电平」等设置让位。
   同一类名亦用于性能表设置窗的「波束筛选」，两处一并加长。 */
.bplist { border: 1px solid var(--border); border-radius: 2px; margin-top: 5px; max-height: 300px; min-height: 48px; overflow-y: auto; resize: vertical; }
.brow { display: flex; align-items: center; gap: 6px; padding: 2px 7px; cursor: pointer; font-size: 11.5px; }
.brow + .brow { border-top: 1px solid var(--border); }
.brow:hover { background: var(--bg); }
.brow.on .bnm-in { color: var(--text); }
.brow .bnm-in { flex: 1; min-width: 0; border: 1px solid transparent; background: transparent; color: var(--text-muted); font-size: 11.5px; padding: 1px 4px; border-radius: 2px; outline: none; }
.brow .bnm-in:hover { border-color: var(--border); }
.brow .bnm-in:focus { border-color: var(--accent); background: var(--bg); color: var(--text); }
.brow .bseq { flex: none; min-width: 20px; text-align: right; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.brow .bpk { flex: none; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
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
.sw.swmix { background: conic-gradient(#8fa89b 0 25%, #9fb0c0 0 50%, #c0a99f 0 75%, #b0a98f 0); }
.swd { flex: none; width: 14px; height: 14px; border-radius: 3px; border: 1px solid var(--border); }
.rowlk { cursor: pointer; }
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
/* Polygon（协调区多边形）卡片：题头条（勾选/线色/名称/顶点数/删除）+ 两列信息栅格 + 样式滑杆 + 4列等宽操作网格 */
.plg { border: 1px solid var(--border); border-radius: 4px; margin-top: 8px; padding: 0 9px 9px; background: color-mix(in srgb, var(--surface) 55%, transparent); }
.plg.act { border-color: var(--accent); box-shadow: inset 2px 0 0 var(--accent); }
.plgh { display: flex; align-items: center; gap: 6px; margin: 0 -9px 8px; padding: 6px 9px; border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--bg) 60%, transparent); border-radius: 3px 3px 0 0; }
.plgh .plgnm { border-color: transparent; background: transparent; font-weight: 600; font-size: 12px; }
.plgh .plgnm:hover { border-color: var(--border); }
.plgh .plgnm:focus { border-color: var(--accent); background: var(--bg); }
.plgi { flex: none; color: var(--text-faint); font-size: 10.5px; font-family: var(--font-mono); border: 1px solid var(--border); border-radius: 8px; padding: 0 7px; line-height: 15px; white-space: nowrap; }
.plgg { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 10px; }
.plgf { display: flex; align-items: center; gap: 5px; min-width: 0; }
.plgf.w2 { grid-column: 1 / -1; }
.plgr { display: flex; align-items: center; gap: 6px; }
.plgg + .plgr, .plgr + .plgr, .plgr + .plgops, .plgops + .plgr, .plgg + .plgops { margin-top: 7px; }
.plgr.sub { color: var(--text-muted); font-size: 11.5px; }
.plgr.sub .u { flex: none; color: var(--text-faint); font-size: 11px; min-width: 20px; text-align: right; font-family: var(--font-mono); }
.plgr.sub .u.pct { min-width: 30px; }
.plgl { flex: none; width: 26px; color: var(--text-muted); font-size: 11px; text-align: justify; text-align-last: justify; }
.plgu { flex: none; color: var(--text-faint); font-size: 11px; }
.plgn { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); outline: none; border-radius: 2px; }
.plgv { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 2px 6px; font-size: 11.5px; color: var(--text); outline: none; font-family: var(--font-mono); border-radius: 2px; }
.plgn:focus, .plgv:focus { border-color: var(--accent); }
.plgc { flex: none; width: 26px; }
/* 操作按钮组：4 列等宽网格（上排编辑态、下排生成类），整齐对位 */
.plgops { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; }
.opb { text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 0; cursor: pointer; font-size: 11px; border-radius: 2px; white-space: nowrap; transition: color .12s, border-color .12s, background .12s; }
.opb:hover { border-color: var(--accent); color: var(--text); }
.opb.on { border-color: color-mix(in srgb, var(--accent) 60%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); font-weight: 600; }
.opb.danger:hover { border-color: #e05252; color: #e05252; }
.opb.danger.on { border-color: color-mix(in srgb, #e05252 60%, transparent); color: #e05252; background: color-mix(in srgb, #e05252 10%, transparent); font-weight: 600; }
.plgta { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; min-height: 84px; resize: vertical; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-family: var(--font-mono); font-size: 11px; padding: 4px 6px; outline: none; }
.plgta:focus { border-color: var(--accent); }
/* 顶点表：文本框 + 右下「复制两列」按钮（Tab 分隔，粘到 Excel 自动分成经度/纬度两列） */
.plgvt { margin-top: 6px; display: flex; flex-direction: column; }
.plgvt .plgta { margin-top: 0; }
.plgcp { align-self: flex-end; display: inline-flex; align-items: center; gap: 4px; margin-top: 5px; padding: 2px 9px; border: 1px solid var(--border); border-radius: 2px; color: var(--text-muted); font-size: 11px; cursor: pointer; white-space: nowrap; }
.plgcp:hover { border-color: var(--accent); color: var(--text); }
.expb2 { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 3px 0; cursor: pointer; font-size: 11.5px; }
.expb2:hover { border-color: var(--accent); color: var(--text); }
.csfoot { margin-top: auto; display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--border); }
.cst { font-size: 11px; color: var(--text-faint); }
.cclr { margin-left: auto; font-size: 11.5px; color: var(--text-muted); border: 1px solid var(--border); padding: 3px 10px; cursor: pointer; }
.cclr:hover { border-color: var(--accent); color: var(--text); }

/* 标记面板 */
.addb { flex: none; border: 1px solid var(--accent); color: var(--accent); padding: 2px 8px; cursor: pointer; font-size: 11.5px; }
.addb:hover { background: var(--accent); color: var(--bg); }
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

.lnknm { cursor: pointer; }
.lnknm:hover { color: var(--accent); }
.tip2 { color: var(--text-faint); font-size: 11px; line-height: 1.6; }
.tip2 .lnk { margin-left: 6px; color: var(--accent); cursor: pointer; }

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
.geobtn:hover { background: var(--accent); color: var(--bg); }
.sdiv { margin: 12px 0 8px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: 11.5px; }
.sdbody .sdiv:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.pickbtn { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: 12px; }
.pickbtn:hover { border-color: var(--accent); color: var(--text); }
.pmode { flex: 1; text-align: center; border: 1px solid var(--border); color: var(--text-muted); padding: 4px 8px; cursor: pointer; font-size: 12px; }
.pmode:hover { border-color: var(--accent); color: var(--text); }
.pmode.on { border-color: var(--accent); background: var(--accent); color: var(--bg); }
.sres { border: 1px solid var(--border); max-height: 150px; overflow-y: auto; margin-bottom: 8px; }
.sresi { display: flex; align-items: center; gap: 6px; padding: 4px 8px; cursor: pointer; font-size: 11.5px; }
.sresi:hover { background: var(--bg); }
.sresi .srn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.sresi em { flex: none; font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.sdfoot { display: flex; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--border); }
.sdfoot .cancel { margin-left: auto; color: var(--text-muted); border: 1px solid var(--border); padding: 4px 14px; cursor: pointer; font-size: 12px; }
.sdfoot .cancel:hover { color: var(--text); }
.sdfoot .save { background: var(--accent); color: var(--bg); padding: 4px 18px; cursor: pointer; font-size: 12px; }
/* —— 卫星组管理器：左＝组列表，右＝改名 + 搜索添加 + 成员表 —— */
.sgm-dlg { width: 780px; max-width: calc(100% - 32px); height: 76vh; max-height: 660px; overflow: hidden; }
.sgm-body { flex: 1; min-height: 0; display: flex; }
.sgm-left { flex: 0 0 200px; min-width: 0; display: flex; flex-direction: column; border-right: 1px solid var(--border); }
.sgm-lt { display: flex; align-items: center; gap: 6px; padding: 8px 10px; font-size: 11.5px; color: var(--text-muted); border-bottom: 1px solid var(--border); flex: none; }
.sgm-lt em { font-style: normal; color: var(--text-faint); font-family: var(--font-mono); }
.sgm-lt .lnk { margin-left: auto; display: inline-flex; align-items: center; gap: 2px; color: var(--accent); cursor: pointer; }
.sgm-glist { flex: 1; min-height: 0; overflow-y: auto; }
.sgm-grow { display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; color: var(--text-muted); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent); }
.sgm-grow:hover { background: var(--surface-2); color: var(--text); }
.sgm-grow.cur { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); }
.sgm-grow .gnm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgm-grow .gcnt { flex: none; font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
/* 组色点：恒占位保持名字列对齐；未着色=空心圈 */
.sgm-grow .gdot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
.sgm-grow .gdot.off { box-shadow: inset 0 0 0 1px var(--text-faint); opacity: .45; }
.sgm-grow .gic { flex: none; display: inline-flex; color: var(--text-faint); cursor: pointer; padding: 1px; opacity: 0; }
.sgm-grow:hover .gic, .sgm-grow.cur .gic { opacity: 1; }
.sgm-grow .gic:hover { color: var(--text); }
.sgm-grow .gic.del:hover, .sgm-grow .gic.del.warn { color: #ff6a6a; }
.sgm-right { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 10px 12px; overflow: hidden; }
.sgm-name { display: flex; align-items: center; gap: 8px; flex: none; }
.sgm-name > label { flex: none; font-size: 11.5px; color: var(--text-muted); }
/* 着色行：十色快捷板 + 取色器 + 色号读数 + 恢复默认 */
.sgm-clr { display: flex; align-items: center; gap: 5px; flex: none; margin-top: 8px; }
.sgm-clr > label:first-child { flex: none; font-size: 11.5px; color: var(--text-muted); margin-right: 3px; }
.sgm-clr .pz { flex: none; width: 13px; height: 13px; border-radius: 3px; cursor: pointer; box-sizing: border-box; border: 1px solid rgba(0,0,0,.3); }
.sgm-clr .pz:hover { box-shadow: 0 0 0 1px var(--text-muted); }
.sgm-clr .pz.on { box-shadow: 0 0 0 1.5px var(--accent); }
.sgm-clr .pgclr.lg { width: 18px; height: 18px; margin-left: 3px; }
.sgm-clr .pgclr.lg .pgsw { width: 15px; height: 15px; }
.sgm-clr .hexv { flex: none; min-width: 52px; font-size: 10.5px; color: var(--text-faint); font-family: var(--font-mono); }
.sgm-clr .gbtn { margin-left: auto; }
/* 「着色所选」：gbtn 外观 + 铺满的隐形取色器（dis 时随 .gbtn.dis 一起失效） */
.sgm-right .gbtn.clr { position: relative; }
.sgm-right .gbtn.clr input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; opacity: 0; cursor: pointer; }
.sgm-sec { flex: none; margin: 11px 0 5px; font-size: 11px; color: var(--text-muted); }
.sgm-sec em { font-style: normal; color: var(--text-faint); }
.sgm-srch, .sgm-memtool { display: flex; align-items: center; gap: 6px; flex: none; }
.sgm-right .ci { flex: 1; min-width: 0; border: 1px solid var(--border); background: var(--bg); padding: 4px 8px; font-size: 12px; color: var(--text); border-radius: 4px; outline: none; }
.sgm-right .ci:focus { border-color: var(--accent); }
.sgm-right .gbtn { flex: none; font-size: 11px; color: var(--text-muted); border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; }
.sgm-right .gbtn:hover { color: var(--text); border-color: var(--accent); }
.sgm-right .gbtn.danger:hover { color: #ff6a6a; border-color: #ff6a6a; }
.sgm-right .gbtn.dis, .sgm-pickbar .save.dis { opacity: .4; pointer-events: none; }
.sgm-reslist { flex: 1 1 42%; min-height: 76px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: 4px; }
.sgm-memlist { flex: 1 1 58%; min-height: 76px; overflow-y: auto; margin-top: 6px; border: 1px solid var(--border); border-radius: 4px; }
.sgm-ck { display: flex; align-items: center; gap: 7px; padding: 4px 8px; font-size: 11.5px; color: var(--text); cursor: pointer; border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent); }
.sgm-ck:hover { background: var(--surface-2); }
.sgm-ck input { flex: none; accent-color: var(--accent); }
.sgm-ck .cn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sgm-ck em { flex: none; font-style: normal; color: var(--text-faint); font-family: var(--font-mono); font-size: 10.5px; }
.sgm-ck em.miss { color: #d9a441; }
.sgm-ck b { flex: none; font-weight: 400; font-size: 10px; color: var(--accent); }
.sgm-ck.dim { color: var(--text-faint); }
.sgm-ck .gic { flex: none; display: inline-flex; color: var(--text-faint); cursor: pointer; padding: 1px; }
.sgm-ck .gic.del:hover { color: #ff6a6a; }
.sgm-pickbar { display: flex; align-items: center; gap: 10px; flex: none; margin-top: 6px; font-size: 11.5px; color: var(--text-muted); }
.sgm-pickbar b { color: var(--text); }
.sgm-pickbar .lnk { color: var(--accent); cursor: pointer; }
.sgm-pickbar .save { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; background: var(--accent); color: var(--bg); padding: 3px 12px; border-radius: 4px; cursor: pointer; font-size: 11.5px; }
.sgm-empty { padding: 12px 10px; font-size: 11px; color: var(--text-faint); line-height: 1.6; }
.sgm-empty.big { margin: auto; text-align: center; max-width: 300px; }
.sgm-dlg .sdfoot { justify-content: flex-end; flex: none; }
/* 应用内提示弹窗：消息文本 + 右对齐「确定」 */
.al-dlg { width: 360px; }
.al-msg { margin: 0; font-size: 13px; line-height: 1.65; color: var(--text); }
.al-dlg .sdfoot { justify-content: flex-end; }
/* 发送到小程序：密钥展示 */
.sdfoot .save.ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
.sat-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: 12px; color: var(--text); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
.sat-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }
.traj-banner { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--surface); border: 1px solid var(--accent); padding: 7px 14px; font-size: 12px; color: var(--text); box-shadow: 0 6px 20px rgba(0,0,0,0.4); }
.traj-banner .lnk { margin-left: 10px; color: var(--accent); cursor: pointer; }

/* 地图右键上下文菜单 */
.ctx-mask { position: fixed; inset: 0; z-index: 60; }
.ctx-menu { position: fixed; z-index: 61; min-width: 190px; max-height: calc(100vh - 8px); overflow-y: auto; background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 8px 24px rgba(0,0,0,0.45); padding: 4px; font-size: 12px; color: var(--text); }
.ctx-item { padding: 6px 12px; cursor: pointer; white-space: nowrap; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ctx-item:hover { background: var(--bg); color: var(--accent); }
.ctx-item.dis, .ctx-item.dis:hover { color: var(--text-muted); opacity: 0.45; cursor: default; background: none; }
.ctx-sep { height: 1px; background: var(--border); margin: 4px 6px; }


</style>
