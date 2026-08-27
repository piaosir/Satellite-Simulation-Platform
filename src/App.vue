<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { useNavStore } from './stores/nav'
import { cursor } from './stores/cursor'
import { mapCrs, fmtLL, datumTag } from './stores/mapCrs.js'
import { view } from './stores/view'
import { covNav } from './stores/coveragePanels'
import { zoom, ZOOM_TMAX } from './stores/zoom'
import { shellUi as ui, toggleUi, sideWKey, SIDE_W_LIM } from './stores/shellUi'
import { theme } from './stores/theme'
import { logStore, logMsg, clearLog } from './stores/log'
import { effective as displayQuality } from './stores/displayQuality'
import { activation, activationLocked, initActivation, refreshActivation, activationText, lockTitle } from './stores/activation'
import SettingsModal from './components/SettingsModal.vue'
import MiniBindDialog from './components/MiniBindDialog.vue'
import MiniAboutDialog from './components/MiniAboutDialog.vue'
import AboutDialog from './components/AboutDialog.vue'
import FileManager from './components/FileManager.vue'
import Icon from './components/Icon.vue'
import logoUrl from './assets/linklab-avatar-dark.png'
import LinkBudget from './pages/LinkBudget.vue'
import Configs from './pages/Configs.vue'
import History from './pages/History.vue'
import Settings from './pages/Settings.vue'
import Placeholder from './pages/Placeholder.vue'

// 重资源页面（Cesium / 高德）按需懒加载，避免其加载问题拖垮整个应用。
const ConstellationMap3D = defineAsyncComponent(() => import('./pages/ConstellationMap3D.vue'))
const ISL = defineAsyncComponent(() => import('./pages/ISL.vue'))

const nav = useNavStore()
const settingsOpen = ref(false)
const bindOpen = ref(false)      // 绑定小程序账号（工具菜单，与设置平级）
const miniAboutOpen = ref(false) // 微信小程序介绍（帮助菜单，与关于平级）
const fileOpen = ref(false)
const aboutOpen = ref(false)
const appVersion = ref('')
const openMenu = ref('')     // 当前展开的菜单 key（''=全收起）；经典菜单栏：点击展开，展开后悬停即切换
const hint = ref('')         // 状态栏左侧提示文字（悬停菜单项/工具按钮时显示，默认「就绪」）

// ---- 侧栏（VS Code 活动栏范式：图标竖条切换视图，同屏只显示一个视图）----
// 视图内容由 3D 页 Teleport 挂入 #side-view；可用性来自 covNav（polyAvail 无 IPC 依赖，可兼作「页面已挂载」信号）
const pageReady = computed(() => covNav.polyAvail)
// 可见性分析紧跟 Polygon；天线波束合成 / 覆盖等值线显示（GXT · KML）为低频功能，排其后
const sideViews = computed(() => [
  { key: 'constellation', label: '星座', icon: 'satellite', disabled: !pageReady.value, hint: '星座分组与卫星搜索' },
  { key: 'antenna', label: '对地覆盖分析', icon: 'earth', disabled: !covNav.grdAvail, hint: '卫星 → 天线 → 波束在地球上的覆盖范围 / 性能指标表（GRD）' },
  { key: 'satcov', label: '对星覆盖分析', icon: 'orbit', disabled: !covNav.grdAvail, hint: '同一棵天线树 → 波束在各轨道壳层上的投影（含反天底侧）/ 对星性能指标表' },
  { key: 'poly', label: 'Polygon（协调区）', icon: 'hexagon', disabled: !covNav.polyAvail, hint: '协调区多边形：绘制 / 调点 / 扩缩 / 导出' },
  { key: 'vis', label: '可见性分析', icon: 'eye', disabled: !pageReady.value, hint: '选目标（地球站 / 点 / 航迹 / Polygon）→ 设仰角门限 → 算可见卫星（复刻 STK Access / Coverage）' },
  { key: 'beams', label: '天线波束合成', icon: 'satellite-dish', disabled: !covNav.grdAvail, hint: '多馈源反射面 / 赋形反射面：设参数 → 点图放置轮廓 → 生成方向图天线' },
  { key: 'gxt', label: 'GXT/KML 显示', icon: 'waves', disabled: !covNav.covAvail, hint: 'GEO 卫星覆盖等值线：显示 GXT / KML 覆盖库里的波束' },
  { key: 'markers', label: '标记', icon: 'map-pin', disabled: !pageReady.value, hint: '点标记 / 地球站 / 轨迹' },
  { key: 'env', label: '环境场', icon: 'cloud-rain', disabled: !pageReady.value, hint: 'ITU-R 环境数据场：R0.01% 降雨率 / 0°C 等温线高度 / 雨高 / 海拔 / 水汽密度 / 云液态水（栅格 + 等值线）' },
  { key: 'focus', label: '聚焦卫星', icon: 'crosshair', disabled: !pageReady.value, hint: '聚焦星画什么、怎么画：轨道线 / 星下点轨迹 / 覆盖圈（口径与填充）/ 覆盖锥 / 卫星标记' },
  { key: 'geo', label: '地图设置', icon: 'sliders-horizontal', disabled: !pageReady.value, hint: '海陆配色 / 国界省界 / 名称标注 / 晨昏线' }
])
const sideTitle = computed(() => sideViews.value.find((v) => v.key === ui.side)?.label || '')
function setSide(k) {
  if (activationLocked.value) { lockOpen.value = true; return }   // 侧栏视图全部在锁定范围（活动栏与「显示」菜单同入口）
  ui.side = ui.side === k ? '' : k
}

// ---- 激活（终端设备侧）：未激活时仅保留地图拖拽/缩放与视图切换等常规操作，
//      功能入口（菜单/工具栏/活动栏/独立窗口）点击一律弹「未激活」。----
const lockOpen = ref(false)
const lockCopied = ref(false)
const actText = computed(() => activationText())
// 状态栏激活格：未激活 / 有截止期才占格；永久激活是常态不写字（刷新中的反馈除外）
const actCellOn = computed(() => activation.ready && (activation.busy || !activation.active || activation.expiresAt > 0))
// 激活后自动收掉锁窗（管理端开通 → 定时心跳或手动刷新拉到 → 就地解锁）
watch(() => activation.active, (v) => { if (v) lockOpen.value = false })
// 撤销/到期到达时就地收起已开的侧栏面板：入口 guard 只拦「下一次打开」，
// 开着的面板不收的话，撤销前打开的功能会一直可用
watch(activationLocked, (v) => { if (v && ui.side) ui.side = '' })
async function doRefreshActivation() {
  if (activation.busy) return
  logMsg('刷新激活状态…')
  await refreshActivation()
  logMsg(`激活状态：${activationText() || '未知'}`, activation.active ? 'info' : 'warn')
}
async function copyDeviceId() {
  try {
    await navigator.clipboard.writeText(activation.deviceId || '')
    lockCopied.value = true
    setTimeout(() => { lockCopied.value = false }, 1200)
  } catch { /* 剪贴板不可用 */ }
}
// 「特定动作」触发刷新：状态栏激活格连点 5 次 / 关于对话框设备ID连点 5 次 / Ctrl+Alt+A
const _taps = {}
function multiTap(key, n, fn) {
  const t = _taps[key] || (_taps[key] = { c: 0, timer: null })
  t.c++
  clearTimeout(t.timer)
  t.timer = setTimeout(() => { t.c = 0 }, 900)
  if (t.c >= n) { t.c = 0; fn() }
}

// 侧栏宽度拖拽（左右分隔条）——宽度按视图分轨（可见性分析独立记忆、上限更高），拖谁记谁
function splitDown(e) {
  const k = sideWKey(), [lo, hi] = SIDE_W_LIM[k]
  const x0 = e.clientX; const w0 = ui[k]
  const move = (ev) => { ui[k] = Math.max(lo, Math.min(hi, w0 + ev.clientX - x0)) }
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
}

// ---- 导出范围：记忆用户上次选择（'world'=整幅世界图，默认；'view'=截图，当前视图所见即所得）----
const EXP_SCOPE_KEY = 'exp-scope'
const expScope = ref((() => { try { const v = localStorage.getItem(EXP_SCOPE_KEY); return v === 'view' || v === 'world' ? v : 'world' } catch { return 'world' } })())
watch(expScope, (v) => { try { localStorage.setItem(EXP_SCOPE_KEY, v) } catch { /* ignore */ } })
// GXT/KML 导的是【对地】那套覆盖等值线（对星覆盖分析的壳层投影不在其中），故名字里带上限定
const EXP_NAME = { png2: '高清 PNG · 2×', png4: '高清 PNG · 4×', png6: '高清 PNG · 6×', pdf: '矢量 PDF', gxt: '导出 GXT（对地）', kml: '导出 KML（对地）' }
function doExport(fmt) {
  if (!covNav.exportMap) return
  logMsg(`导出：${EXP_NAME[fmt] || fmt}（${expScope.value === 'view' ? '截图' : '全球图'}）`)
  covNav.exportMap(fmt, expScope.value)
}
// 发送到小程序：把当前绘制状态（覆盖等值线 + 协调区多边形）上传云端，生成密钥供微信小程序导入
function doSendMiniapp() {
  if (!covNav.sendMiniapp) return
  logMsg('发送到小程序：上传当前绘制状态…')
  covNav.sendMiniapp()
}

// 计算菜单项 → 打开独立工作台窗口（GEO 链路预算 / NGSO 链路预算 / 再生式链路预算 / 日凌预报）
function openLinkBudget() { window.api?.linkBudget?.open?.() }
function openNgso() { window.api?.ngso?.open?.() }
function openRegen() { window.api?.regen?.open?.() }
function openE2e() { window.api?.e2e?.open?.() }
function openSunOutage() { window.api?.sunOutage?.open?.() }
function openRain() { window.api?.rainAttenuation?.open?.() }
function openCi() { window.api?.interference?.open?.() }
function openPfdMask() { window.api?.pfdMask?.open?.() }
function openFreqPlan() { window.api?.freqPlan?.open?.() }

function pickView(flat) {
  if (view.flat === flat) return
  view.flat = flat
  logMsg(`视图切换：${flat ? '2D 平面图' : '3D 球体'}`)
}

// MSAA 是 WebGL 上下文创建期参数，运行时不可改 → 把它并入当前页 key，切换 MSAA 时重挂载页面（一瞬重渲）。
// 页面状态由各自的本地缓存（reactive watch 持续保存）在重挂载时恢复，无感。
const pageKey = computed(() => `${nav.current}-msaa${displayQuality.value.msaa !== false ? 1 : 0}`)

const pageMap = {
  link: LinkBudget,
  globe3d: ConstellationMap3D,
  isl: ISL,
  configs: Configs,
  history: History,
  settings: Settings
}
const currentComponent = computed(() => pageMap[nav.current] || Placeholder)
const currentLabel = computed(
  () => nav.pages.find((p) => p.key === nav.current)?.label || ''
)

// 光标经纬度读数：档位（大地基准 / 坐标格式）由星座地图页的「坐标系」分节定，见 stores/mapCrs。
// 内部恒为 WGS-84 十进制度，这里只做呈现层换算。经度在前、纬度在后（十进制度档）。
const fmtCoord = (ll) => {
  const s = fmtLL(ll.lon, ll.lat, 2)
  if (mapCrs.fmt !== 'deg') return s
  return `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}  ${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}`
}

// 底部状态栏缩放进度条：拖动/按钮 → 设回当前活动地图（zoom.apply）；地图滚轮缩放回填 zoom.value。
const onZoomInput = (e) => { const t = Number(e.target.value); if (zoom.apply) zoom.apply(t) }
const stepZoom = (d) => { const t = Math.max(0, Math.min(ZOOM_TMAX, zoom.value + d)); if (zoom.apply) zoom.apply(t) }

// ---- 菜单栏（仿 SATSOFT 经典菜单：纯文字标题 + 下拉；不可用项置灰不隐藏）----
const menus = computed(() => [
  { key: 'file', label: '文件', items: [
    { label: '文件管理…', icon: 'folder-open', lock: true, hint: '管理轨道星历 / 天线方向图 / 频率计划 / GXT · KML 覆盖文件库（导入 / 导出 / 删除）', run: () => { fileOpen.value = true } },
    // 频率计划是「文件」不是「计算」：它与天线方向图平级、同挂在卫星下，本身不产出任何计算结果，
    // 只是被链路预算引用的一份资料。故归文件区，不留在计算菜单里。
    { label: '转发器频率计划…', icon: 'freq-plan', lock: true, hint: '转发器频率排布与频率分配表：挂在卫星下、与天线方向图平级；供链路预算引用，可导出 PNG / PDF（独立窗口）', run: openFreqPlan },
    { label: '导入星历文件…', icon: 'import', lock: true, disabled: !covNav.importTle, hint: '从本地文件导入卫星星历：OMM 的 CSV / JSON / KVN / XML 与 TLE / 3LE，按内容自动识别；离线或无法连接 CelesTrak 时使用', run: () => covNav.importTle?.() },
    { sep: true },
    { label: '退出', icon: 'log-out', hint: '关闭主窗口', run: () => window.close() }
  ] },
  { key: 'calc', label: '计算', items: [
    // 链路预算三工作台的专业命名：轨道维度（GSO 对地静止 / NGSO 非对地静止，ITU《无线电规则》口径）×
    // 转发体制维度（透明弯管转发 / 星上再生处理 OBP）——「GEO/NGSO/再生式」旧并列混淆了两个维度，已更正。
    { label: 'GSO 透明转发链路预算', icon: 'calculator', lock: true, hint: '对地静止轨道（GSO）· 透明弯管转发器：打开链路预算工作台（独立窗口）', run: openLinkBudget },
    { label: 'NGSO 透明转发链路预算', icon: 'ngso', lock: true, hint: '非对地静止轨道（NGSO，含 LEO/MEO/HEO）· 透明弯管转发器：打开链路预算工作台（独立窗口）', run: openNgso },
    { label: '再生处理（OBP）链路预算', icon: 'cpu', lock: true, hint: '星上再生处理转发器：上行 / 下行 / 星间微波 / 星间激光，链路预算解耦（独立窗口）', run: openRegen },
    { label: '端到端链路预算（多跳 / 混合转发）', icon: 'chain-hops', lock: true, hint: '任意节点链：多颗透明星 ISL 串联 / 透明与再生混用 / 双跳地面转接，按段结算取最弱段（独立窗口）', run: openE2e },
    { label: '日凌预报（GSO）', icon: 'sun', lock: true, hint: '打开日凌预报（独立窗口）', run: openSunOutage },
    { label: '雨衰计算', icon: 'droplets', lock: true, hint: '打开雨衰计算（独立窗口，通用于各类卫星）', run: openRain },
    { label: '干扰分析（C/I）', icon: 'radio-tower', lock: true, hint: 'C/ASI 邻星 · C/CCI 同频复用 · C/XPI 交叉极化 · NGSO 时变 CDF（独立窗口，只读计算器）', run: openCi },
    { label: 'PFD EIRP Mask 生成器', icon: 'table', lock: true, hint: 'ITU-R S.1503 掩模：下行 PFD / 星间 EIRP / 上行 EIRP 三种 + 系统运行参数，输出可提交的 XML（独立窗口）', run: openPfdMask }
  ] },
  { key: 'view', label: '视图', items: [
    { label: '3D 球体', icon: 'globe', check: !view.flat, hint: '三维地球视图', run: () => pickView(false) },
    { label: '2D 平面图', icon: 'map', check: view.flat, hint: '等经纬度平面世界图', run: () => pickView(true) },
    { sep: true },
    { label: '工具栏', check: ui.toolbar, hint: '显示 / 隐藏图标工具栏', run: () => toggleUi('toolbar') },
    { label: '侧栏', check: !!ui.side, hint: '显示 / 隐藏侧栏（活动栏图标可切换视图）', run: () => { ui.side = ui.side ? '' : 'constellation' } },
    { label: '日志窗格', check: ui.log, hint: '显示 / 隐藏底部日志窗格', run: () => toggleUi('log') }
  ] },
  // 显示 = 活动栏视图的菜单镜像（键盘/菜单党可达性）
  { key: 'display', label: '显示', items: sideViews.value.map((v) => (
    { label: v.label, icon: v.icon, check: ui.side === v.key, disabled: v.disabled, hint: v.hint, run: () => setSide(v.key) }
  )) },
  { key: 'export', label: '导出', items: [
    { label: EXP_NAME.png2, icon: 'image', lock: true, disabled: !covNav.exportAvail, hint: '导出 2 倍高清 PNG 图片', run: () => doExport('png2') },
    { label: EXP_NAME.png4, icon: 'image', lock: true, disabled: !covNav.exportAvail, hint: '导出 4 倍高清 PNG 图片', run: () => doExport('png4') },
    { label: EXP_NAME.png6, icon: 'image', lock: true, disabled: !covNav.exportAvail, hint: '导出 6 倍高清 PNG 图片', run: () => doExport('png6') },
    { label: EXP_NAME.pdf, icon: 'file-text', lock: true, disabled: !covNav.exportAvail, hint: '导出矢量 PDF 文档（3D 球体截图为位图 PDF，4 倍）', run: () => doExport('pdf') },
    { sep: true },
    { label: EXP_NAME.gxt, icon: 'layers', lock: true, disabled: !covNav.exportAvail, hint: '将当前绘制的覆盖等值线 + 协调区多边形一并导出为一个 GXT 文件（所见即所得）', run: () => doExport('gxt') },
    { label: EXP_NAME.kml, icon: 'layers', lock: true, disabled: !covNav.exportAvail, hint: '将当前绘制的覆盖等值线 + 协调区多边形一并导出为一个 Google KML 文件（所见即所得）', run: () => doExport('kml') },
    { sep: true },
    { label: '发送到小程序…', icon: 'upload', lock: true, disabled: !covNav.exportAvail, hint: '将当前绘制的覆盖等值线 + 协调区多边形上传至云端，生成密钥供微信小程序「卫星覆盖」导入', run: () => doSendMiniapp() }
  ] },
  { key: 'tools', label: '工具', items: [
    { label: '绑定小程序账号…', icon: 'wechat', lock: true, hint: '登记小程序端的认证码，此后「发送到小程序」可免密钥直接投递，接收方打开小程序后自动同步', run: () => { bindOpen.value = true } },
    { sep: true },
    { label: '设置…', icon: 'settings', hint: '外观主题 / 显示画质 / 单位等设置', run: () => { settingsOpen.value = true } }
  ] },
  { key: 'help', label: '帮助', items: [
    { label: '微信小程序 LinkLab…', icon: 'wechat', hint: '「LinkLab星链链路计算」手机端：链路预算 / AR 对星 / 覆盖图 / 星座地图，并可接收本平台发送的覆盖快照、链路配置与频率计划', run: () => { miniAboutOpen.value = true } },
    { sep: true },
    { label: '关于卫星仿真平台…', icon: 'info', hint: '版本与说明', run: () => { aboutOpen.value = true } }
  ] }
])
function runItem(it) {
  if (it.disabled) return
  openMenu.value = ''; hint.value = ''
  if (it.lock && activationLocked.value) { lockOpen.value = true; return }
  it.run && it.run()
}

// ---- 工具栏（只放侧栏覆盖不到的动作：文件 / 计算窗口 / 视图切换 / 导出 / 设置；面板切换交给活动栏，不重复）----
const toolButtons = computed(() => [
  { icon: 'folder-open', tip: '文件管理', lock: true, run: () => { fileOpen.value = true } },
  // 与文件管理同组：频率计划挂在卫星下、与 GRD 天线平级，属文件区而非计算区
  { icon: 'freq-plan', tip: '转发器频率计划', lock: true, run: openFreqPlan },
  { sep: true },
  { icon: 'calculator', tip: 'GSO 透明转发链路预算', lock: true, run: openLinkBudget },
  { icon: 'ngso', tip: 'NGSO 透明转发链路预算', lock: true, run: openNgso },
  { icon: 'cpu', tip: '再生处理（OBP）链路预算', lock: true, run: openRegen },
  { icon: 'chain-hops', tip: '端到端链路预算（多跳 / 混合转发）', lock: true, run: openE2e },
  { icon: 'sun', tip: '日凌预报（GSO）', lock: true, run: openSunOutage },
  { icon: 'droplets', tip: '雨衰计算', lock: true, run: openRain },
  { icon: 'radio-tower', tip: '干扰分析（C/I）', lock: true, run: openCi },
  // ∠ 取「辐射功率随角度的上包络」之意：三种掩模的自变量恰好全是角度（α 角 / 天底角 / 方位仰角）
  { icon: 'table', tip: 'PFD EIRP Mask 生成器（ITU-R S.1503）', lock: true, run: openPfdMask },
  { sep: true },
  { icon: 'globe', tip: '3D 球体视图', on: !view.flat, run: () => pickView(false) },
  { icon: 'map', tip: '2D 平面图视图', on: view.flat, run: () => pickView(true) },
  { sep: true },
  { icon: 'image', tip: '导出高清 PNG（4×）', lock: true, disabled: !covNav.exportAvail, run: () => doExport('png4') },
  { icon: 'file-down', tip: '导出矢量 PDF', lock: true, disabled: !covNav.exportAvail, run: () => doExport('pdf') },
  { sep: true },
  { icon: 'wechat', tip: '绑定小程序账号', lock: true, run: () => { bindOpen.value = true } },
  { icon: 'settings', tip: '设置', run: () => { settingsOpen.value = true } }
])
function tbClick(b) {
  if (b.disabled) return
  if (b.lock && activationLocked.value) { lockOpen.value = true; return }
  b.run && b.run()
}

// 日志窗格：新条目自动滚到底
const logEl = ref(null)
watch(() => logStore.items.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight })
})

function onKey(e) {
  if (e.key === 'Escape') { openMenu.value = ''; hint.value = '' }
  // 「特定动作」之三：Ctrl+Alt+A 刷新激活状态
  else if (e.ctrlKey && e.altKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); doRefreshActivation() }
}

// 自定义标题栏：把原生窗口控制按钮（Windows 覆盖式）的配色同步到当前主题，避免暗色下亮色三键突兀。
// 直接读 --surface/--text，主题色一改这里自动跟随，无需在两处维护色值。
function syncTitleOverlay() {
  if (!window.api?.win?.setOverlay) return
  const cs = getComputedStyle(document.documentElement)
  const color = cs.getPropertyValue('--surface').trim()
  const symbolColor = cs.getPropertyValue('--text').trim()
  if (color && symbolColor) window.api.win.setOverlay({ color, symbolColor })
}
watch(() => theme.resolved, () => nextTick(syncTitleOverlay))

// 星历取数链路跑在主进程（CelesTrak 直连 / 云镜像兜底 / 众包回传），把它的操作明细接进日志窗格，
// 让「这批星历到底哪来的、为什么走了兜底」在界面上可自证，而不是只留在用户看不到的主进程 console 里。
// 【必须在 setup 阶段订阅，不能放进 onMounted】：Vue 里子组件的 onMounted 先于父组件执行，
// 而星座页一挂载就发起取数 —— 订阅晚一步，开头几行（如「命中当日本地缓存」）就丢了。
window.api?.omm?.onLog?.((p) => logMsg(p && p.text, (p && p.level) || 'info'))

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.api?.app?.version?.().then((v) => { appVersion.value = v || '' }).catch(() => { /* 浏览器直跑无 IPC */ })
  syncTitleOverlay()
  initActivation()
  logMsg('卫星仿真平台就绪')
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="shell">
    <!-- ① 菜单栏：经典文字菜单（点击展开，展开后悬停切换，Esc/点空白收起） -->
    <header class="menubar">
      <img class="brand" :src="logoUrl" alt="卫星仿真平台" title="卫星仿真平台" draggable="false" />
      <nav class="menus">
        <span v-for="m in menus" :key="m.key" class="mwrap">
          <span
            class="mtitle" :class="{ on: openMenu === m.key }"
            @click.stop="openMenu = openMenu === m.key ? '' : m.key"
            @mouseenter="openMenu && openMenu !== m.key && (openMenu = m.key)"
          >{{ m.label }}</span>
          <div v-if="openMenu === m.key" class="mpanel" @click.stop>
            <div v-if="m.key === 'export'" class="vscope">
              <span class="vsp" :class="{ on: expScope === 'world' }" title="整幅世界平面图（当前在 3D 球体下也按 2D 平面图出）" @click="expScope = 'world'">全球图</span>
              <span class="vsp" :class="{ on: expScope === 'view' }" title="当前视图所见即所得：3D 球体出球面位图，2D 平面图出矢量图" @click="expScope = 'view'">截图</span>
            </div>
            <template v-for="(it, i) in m.items" :key="i">
              <div v-if="it.sep" class="msep"></div>
              <div
                v-else class="mitem" :class="{ dis: it.disabled }"
                @click="runItem(it)"
                @mouseenter="hint = it.disabled ? '' : (it.hint || '')" @mouseleave="hint = ''"
              >
                <span class="ck"><Icon v-if="it.check" name="check" :size="12" /></span>
                <span class="mico"><Icon v-if="it.icon" :name="it.icon" :size="13" /></span>
                <span class="mlbl">{{ it.label }}</span>
              </div>
            </template>
          </div>
        </span>
      </nav>
      <div v-if="openMenu" class="vmask" @click="openMenu = ''"></div>
    </header>

    <!-- ② 工具栏：常用操作图标（视图菜单可隐藏） -->
    <div v-if="ui.toolbar" class="toolbar">
      <template v-for="(b, i) in toolButtons" :key="i">
        <span v-if="b.sep" class="tsep"></span>
        <button
          v-else class="tbtn" :class="{ on: b.on, dis: b.disabled }" :title="b.tip"
          @mouseenter="hint = b.disabled ? '' : b.tip" @mouseleave="hint = ''"
          @click="tbClick(b)"
        ><Icon :name="b.icon" :size="15" /></button>
      </template>
      <span class="tgrow"></span>
      <button class="tbtn" :class="{ on: ui.log }" title="日志窗格" @click="toggleUi('log')"><Icon name="panel-bottom" :size="15" /></button>
    </div>

    <div class="body">
      <!-- ③ 活动栏：图标竖条，点击切换侧栏视图（再点当前项收起侧栏）—— VS Code 范式 -->
      <nav class="actbar">
        <button
          v-for="v in sideViews" :key="v.key"
          class="actbtn" :class="{ on: ui.side === v.key, dis: v.disabled }" :title="v.label"
          @mouseenter="hint = v.disabled ? '' : v.hint" @mouseleave="hint = ''"
          @click="!v.disabled && setSide(v.key)"
        ><Icon :name="v.icon" :size="18" :stroke-width="1.7" /></button>
      </nav>

      <!-- ④ 侧栏：单视图（标题 = 当前视图名），内容由 3D 页 Teleport 挂入。
           用 v-show 而非 v-if：#side-view 必须常驻 DOM。3D 页是异步组件（defineAsyncComponent），
           且 pageKey（nav.current / msaa）变化会整页重挂载 → 其 Teleport 随之卸载重建；而 Teleport 只在
           自身挂载时用 querySelector 解析一次 to 目标、之后不重试。若目标被 v-if 卸载，重挂载/异步时序错位下
           就会解析落空 → 侧栏偶发空白（刷新才好）。目标常驻即可根除此竞态（收起时靠 v-show 隐藏，节点不销毁）。 -->
      <aside v-show="ui.side" class="dock sidebar" :style="{ width: ui[sideWKey()] + 'px' }">
        <div class="dock-hd">
          <span class="dock-tt">{{ sideTitle }}</span>
          <span class="dock-x" title="收起侧栏" @click="ui.side = ''"><Icon name="x" :size="12" /></span>
        </div>
        <div class="dock-bd sbody">
          <div id="side-view" class="sv"></div>
        </div>
      </aside>
      <div v-if="ui.side" class="vsplit" @mousedown.prevent="splitDown"></div>

      <div class="main-col">
        <!-- overflow 必须为 hidden：地图页 height:100% 从不滚动，若为 auto，窗口化时亚像素溢出
             会触发滚动条出现→内容区变窄→canvas 重设尺寸→溢出消失→滚动条消失…形成持续抖动回路。
             需要滚动的页面（配置管理/历史记录等）由其内部容器自行 overflow-y: auto。 -->
        <main class="content">
          <component :is="currentComponent" :key="pageKey" :title="currentLabel" />
        </main>

        <!-- ⑤ 底部「日志」窗格（默认收起，工具栏/视图菜单开启） -->
        <div v-if="ui.log" class="dock logdock">
          <div class="dock-hd">
            <span class="dock-tt">日志</span>
            <span class="dock-x" title="清空日志" @click="clearLog()"><Icon name="trash" :size="11" /></span>
            <span class="dock-x" title="关闭（视图菜单可恢复）" @click="toggleUi('log')"><Icon name="x" :size="12" /></span>
          </div>
          <div ref="logEl" class="loglines">
            <div v-for="(l, i) in logStore.items" :key="i" class="ln" :class="l.level">
              <span class="ts">{{ l.ts }}</span>{{ l.text }}
            </div>
            <div v-if="!logStore.items.length" class="ln dim">— 暂无日志 —</div>
          </div>
        </div>
      </div>
    </div>

    <SettingsModal v-if="settingsOpen" @close="settingsOpen = false" />
    <MiniBindDialog v-if="bindOpen" @close="bindOpen = false" @toast="(m) => logMsg(m)" />
    <!-- 帮助 → 微信小程序：介绍页里可直接转到绑定（两者是同一件事的两步） -->
    <MiniAboutDialog v-if="miniAboutOpen" @close="miniAboutOpen = false" @bind="miniAboutOpen = false; bindOpen = true" />
    <FileManager v-if="fileOpen" @close="fileOpen = false" />

    <!-- 帮助 → 关于（设备ID 复制钮连点 5 次 = 刷新激活状态的「特定动作」之二） -->
    <AboutDialog
      v-if="aboutOpen" :version="appVersion" :act-text="actText"
      @close="aboutOpen = false" @refresh="doRefreshActivation()" @tap="multiTap('about', 5, doRefreshActivation)"
    />

    <!-- 未激活：功能入口点击统一落到这里（地图拖拽/缩放等常规操作不受限） -->
    <div v-if="lockOpen" class="about-mask" @click.self="lockOpen = false">
      <div class="about">
        <div class="ab-name">{{ lockTitle() }}</div>
        <div class="ab-ver mono ab-id" :title="lockCopied ? '已复制' : '点击复制设备ID'" @click="copyDeviceId">
          设备ID {{ activation.deviceId || '—' }}<span v-if="lockCopied" class="ab-copied">已复制</span>
        </div>
        <div class="lk-btns">
          <button class="ab-close" :disabled="activation.busy" @click="doRefreshActivation()">{{ activation.busy ? '刷新中…' : '刷新激活状态' }}</button>
          <button class="ab-close" @click="lockOpen = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ⑥ 状态栏：左激活状态 + 提示，右侧凹陷读数格（视图 / 缩放 / 光标经纬度） -->
    <footer class="statusbar">
      <!-- 激活状态（纯文字）：连点 5 次 = 刷新激活状态的「特定动作」之一 -->
      <span
        v-if="actCellOn" class="sb-actv" :class="activation.active ? 'a-on' : 'a-off'"
        :title="`设备ID ${activation.deviceId}`" @click="multiTap('cell', 5, doRefreshActivation)"
      >{{ activation.busy ? '刷新中…' : actText }}</span>
      <span class="hint">{{ hint || (activationLocked ? '' : '就绪') }}</span>
      <span class="cells">
        <span class="cell">{{ view.flat ? '2D 平面图' : '3D 球体' }}</span>
        <span v-if="zoom.avail" class="cell zoomctl" title="地图缩放（拖动精细调节，滚轮亦可）">
          <button class="zbtn" title="缩小" @click="stepZoom(-0.01)"><Icon name="minus" :size="10" /></button>
          <input class="zrange" type="range" min="0" :max="ZOOM_TMAX" step="0.001" :value="zoom.value" @input="onZoomInput" />
          <button class="zbtn" title="放大" @click="stepZoom(0.01)"><Icon name="plus" :size="10" /></button>
          <span class="zpct">{{ Math.round(zoom.value * 100) }}%</span>
        </span>
        <!-- 环境场读数：只在图层开着且光标在图上时出现（没有图层时不占位，状态栏不留空格子） -->
        <span v-if="cursor.env" class="cell envval" :title="`${cursor.env.label}：取自当前环境场栅格（格距 ${cursor.env.step >= 1 ? cursor.env.step.toFixed(0) : cursor.env.step.toFixed(3)}°，双线性）；精确取值以链路预算的逐点查表为准`">
          <span class="ekey">{{ cursor.env.short }}</span>
          <span class="cval">{{ cursor.env.text }}</span>
          <span class="eunit">{{ cursor.env.unit }}</span>
        </span>
        <span class="cell coord">
          <Icon class="cur" name="cursor-arrow" :size="13" />
          <span class="cval">{{ cursor.ll ? fmtCoord(cursor.ll) : '——°  ——°' }}</span>
          <span v-if="cursor.ll && datumTag()" class="eunit">{{ datumTag() }}</span>
        </span>
      </span>
    </footer>
  </div>
</template>

<style scoped>
.shell { display: flex; flex-direction: column; height: 100%; }

/* ===== ① 菜单栏 ===== */
.menubar {
  position: relative; display: flex; align-items: stretch; gap: 10px; height: 32px;
  padding: 0 10px 0 12px; background: var(--surface);
  border-bottom: 1px solid var(--border); flex: none;
  /* 自定义标题栏：整条即窗口拖拽区（双击最大化由原生 WCO 处理）；
     右侧留出 Windows 原生窗口控制按钮（覆盖式）宽度，菜单永不被三键遮挡。
     env(titlebar-area-width) 仅在启用 titleBarOverlay 时存在，回退 100vw → 右内边距归零（浏览器直跑无碍）。 */
  -webkit-app-region: drag;
  padding-right: calc(10px + 100vw - env(titlebar-area-width, 100vw));
}
/* 可交互元素排除出拖拽区，否则点击会被窗口拖拽吞掉（品牌名留作拖拽把手，不排除）。 */
.mtitle, .mpanel, .vmask { -webkit-app-region: no-drag; }
/* 品牌 = LOGO（原文字标题已并入原生标题栏并删除，避免与窗口标题重复）。
   logo.png 为深色墨稿：浅色主题直用；深色主题反相为浅色，避免深底不可见。 */
.brand { align-self: center; height: 20px; width: auto; padding-right: 8px; display: block; user-select: none; -webkit-user-drag: none; }
:root[data-theme='dark'] .brand { filter: invert(1) brightness(1.06); }
.menus { display: flex; align-items: stretch; }
.mwrap { position: relative; display: flex; }
.mtitle { display: flex; align-items: center; padding: 0 11px; font-size: 12.5px; color: var(--text); cursor: default; }
.mtitle:hover { background: var(--surface-2); }
.mtitle.on { background: var(--accent); color: var(--bg); }
.mpanel {
  position: absolute; top: 100%; left: 0; z-index: 100; min-width: 200px;
  background: var(--surface); border: 1px solid var(--border-strong);
  box-shadow: 2px 4px 14px rgba(0,0,0,0.25); padding: 3px;
}
.mitem { display: flex; align-items: center; gap: 6px; padding: 5px 12px 5px 6px; font-size: 12.5px; color: var(--text); cursor: default; white-space: nowrap; }
.mitem:hover { background: var(--accent); color: var(--bg); }
.mitem.dis, .mitem.dis:hover { background: transparent; color: var(--text-faint); }
.mitem .ck { width: 14px; flex: none; display: inline-flex; justify-content: center; }
.mitem .mico { width: 16px; flex: none; display: inline-flex; justify-content: center; color: var(--text-faint); }
.mitem:hover .mico { color: inherit; }
.mitem.dis .mico { color: var(--text-faint); }
.msep { height: 1px; background: var(--border); margin: 3px 6px; }
.vscope { display: flex; gap: 4px; padding: 3px 4px 6px; border-bottom: 1px solid var(--border); margin-bottom: 3px; }
.vsp { flex: 1; text-align: center; cursor: pointer; padding: 3px 6px; border-radius: var(--r-ctl); font-size: 12px; color: var(--text-muted); border: 1px solid var(--border); }
.vsp:hover { color: var(--text); border-color: var(--accent); }
.vsp.on { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }
.vmask { position: fixed; inset: 0; z-index: 99; }

/* ===== ② 工具栏 ===== */
.toolbar {
  display: flex; align-items: center; gap: 2px; height: 34px;
  padding: 0 8px; background: var(--surface); border-bottom: 1px solid var(--border); flex: none;
}
.tbtn {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid transparent; background: transparent; color: var(--text-muted);
  border-radius: var(--r-ctl); padding: 0; cursor: pointer;
}
.tbtn:hover { border-color: var(--border-strong); background: var(--bg); color: var(--text); }
.tbtn.on { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.tbtn.dis, .tbtn.dis:hover { border-color: transparent; background: transparent; color: var(--text-faint); opacity: .45; cursor: default; }
.tsep { width: 1px; height: 18px; background: var(--border-strong); margin: 0 5px; flex: none; }
.tgrow { flex: 1; }

/* ===== ③ 活动栏 ===== */
.body { display: flex; flex: 1; min-height: 0; }
.actbar {
  width: 40px; flex: none; display: flex; flex-direction: column; align-items: center;
  padding: 6px 0; gap: 2px; background: var(--surface); border-right: 1px solid var(--border);
}
.actbtn {
  width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-left: 2px solid transparent; border-right: 2px solid transparent;
  background: transparent; color: var(--text-faint); padding: 0; cursor: pointer;
}
.actbtn:hover { color: var(--text); }
.actbtn.on { color: var(--text); border-left-color: var(--accent); }
.actbtn.dis, .actbtn.dis:hover { color: var(--text-faint); opacity: .35; cursor: default; }

/* ===== ④⑤ 停靠窗格（侧栏 / 日志） ===== */
.dock { background: var(--surface); display: flex; flex-direction: column; min-height: 0; }
.sidebar { flex: none; border-right: 1px solid var(--border); }
.dock-hd {
  display: flex; align-items: center; gap: 2px; height: 26px; padding: 0 5px 0 11px;
  background: var(--surface-2); border-bottom: 1px solid var(--border); flex: none;
}
.dock-tt { flex: 1; font-size: 11.5px; font-weight: 600; letter-spacing: var(--ls-tight); color: var(--text-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dock-x { width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; border-radius: var(--r-ctl); }
.dock-x:hover { background: var(--border); color: var(--text); }
/* scrollbar-gutter: stable —— 恒定预留竖滚动条槽位：侧栏面板内容（如可见性「瞬时可见」随时间轴每帧重算，
   可见星条数变化 → 面板高度增减 → 竖滚动条忽隐忽现）时，Windows 经典滚动条占 ~15px 会令内容宽度左右跳动；
   预留槽位后宽度恒定，消除拖时间轴时的横向抖动。 */
.sbody { flex: 1; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
/* Teleport 目标容器：3D 页把当前视图内容挂进来；空时（页面未挂载）显示占位 */
.sv { display: flex; flex-direction: column; min-height: 100%; }
.sv:empty::after {
  content: '（星座地图加载后，这里显示对应视图）';
  padding: 12px; font-size: 12px; color: var(--text-faint);
}
.vsplit { width: 5px; margin: 0 -2px; cursor: col-resize; flex: none; z-index: 5; }
.vsplit:hover { background: var(--border-strong); }

.main-col { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.content { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }

.logdock { flex: none; height: 110px; border-top: 1px solid var(--border); }
.loglines {
  flex: 1; overflow-y: auto; padding: 3px 9px;
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; user-select: text;
}
.ln { white-space: nowrap; color: var(--text-muted); }
.ln.warn { color: var(--warn); }
.ln.error { color: var(--danger); }
.ln.dim { color: var(--text-faint); }
.ln .ts { color: var(--text-faint); margin-right: 9px; }

/* ===== 关于对话框 ===== */
.about-mask { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.28); display: flex; align-items: center; justify-content: center; }
.about {
  min-width: 300px; padding: 26px 34px 22px; text-align: center;
  background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 10px 32px rgba(0,0,0,0.3);
}
.ab-name { font-family: var(--font-serif); font-size: 19px; letter-spacing: var(--ls-tight); }
.ab-ver { margin-top: 8px; font-size: 12px; color: var(--text-muted); }
.ab-close { margin-top: 18px; padding: 4px 22px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; border-radius: var(--r-ctl); }
.ab-close:hover { border-color: var(--accent); }
.ab-close:disabled { opacity: .5; cursor: default; }
.ab-id { cursor: pointer; user-select: text; font-size: 15px; }
.ab-id:hover { color: var(--text); }
.ab-copied { margin-left: 8px; color: var(--ok); font-size: 11px; }
.lk-btns { display: flex; gap: 10px; justify-content: center; }

/* 状态栏激活状态（左侧纯文字，无背景框） */
.sb-actv { flex: none; cursor: default; font-variant-numeric: tabular-nums; }
.sb-actv.a-on { color: var(--ok); }
.sb-actv.a-off { color: var(--danger); }

/* ===== ⑥ 状态栏 ===== */
.statusbar {
  display: flex; align-items: center; gap: 10px; height: 26px;
  padding: 0 8px 0 12px; background: var(--surface);
  border-top: 1px solid var(--border); flex: none;
  font-size: 11.5px; color: var(--text-muted);
}
.hint { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cells { display: flex; align-items: center; gap: 6px; flex: none; }
.cell {
  display: inline-flex; align-items: center; gap: 6px; height: 19px; padding: 0 9px;
  border: 1px solid var(--border-strong); background: var(--bg);
  box-shadow: inset 0 1px 2px rgba(0,0,0,0.06); color: var(--text-muted);
}
/* 环境场读数格：量名（灰）+ 数值（等宽白）+ 单位（灰），与经纬度格同一档视觉重量 */
.cell.envval { color: var(--text); gap: 5px; }
.cell.envval .ekey, .cell.envval .eunit { color: var(--text-faint); font-size: 11px; }
.cell.envval .cval { font-family: var(--font-mono); font-weight: 600; font-variant-numeric: tabular-nums; }
.cell.coord { color: var(--text); }
.cell.coord .cur { flex: none; }
.cell.coord .cval { font-family: var(--font-mono); font-weight: 600; letter-spacing: var(--ls-tight); min-width: 150px; }
.zoomctl .zbtn { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); cursor: pointer; border-radius: var(--r-ctl); }
.zoomctl .zbtn:hover { color: var(--text); border-color: var(--accent); }
.zoomctl .zrange { width: 110px; }
.zoomctl .zpct { width: 32px; text-align: right; font-family: var(--font-mono); color: var(--text-muted); }
</style>
