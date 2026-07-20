<script setup>
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import { useNavStore } from './stores/nav'
import { cursor } from './stores/cursor'
import { view } from './stores/view'
import { covNav } from './stores/coveragePanels'
import { zoom } from './stores/zoom'
import { shellUi as ui, toggleUi } from './stores/shellUi'
import { theme } from './stores/theme'
import { logStore, logMsg, clearLog } from './stores/log'
import { effective as displayQuality } from './stores/displayQuality'
import SettingsModal from './components/SettingsModal.vue'
import FileManager from './components/FileManager.vue'
import Icon from './components/Icon.vue'
import logoUrl from './assets/linklab-avatar-dark.png'
import LinkBudget from './pages/LinkBudget.vue'
import Configs from './pages/Configs.vue'
import History from './pages/History.vue'
import Settings from './pages/Settings.vue'
import Placeholder from './pages/Placeholder.vue'

// 重资源页面（Cesium / 高德）按需懒加载，避免其加载问题拖垮整个应用。
const ConstellationMap = defineAsyncComponent(() => import('./pages/ConstellationMap.vue'))
const ConstellationMap3D = defineAsyncComponent(() => import('./pages/ConstellationMap3D.vue'))
const ISL = defineAsyncComponent(() => import('./pages/ISL.vue'))

const nav = useNavStore()
const settingsOpen = ref(false)
const fileOpen = ref(false)
const aboutOpen = ref(false)
const appVersion = ref('')
const openMenu = ref('')     // 当前展开的菜单 key（''=全收起）；经典菜单栏：点击展开，展开后悬停即切换
const hint = ref('')         // 状态栏左侧提示文字（悬停菜单项/工具按钮时显示，默认「就绪」）

// ---- 侧栏（VS Code 活动栏范式：图标竖条切换视图，同屏只显示一个视图）----
// 视图内容由 3D 页 Teleport 挂入 #side-view；可用性来自 covNav（polyAvail 无 IPC 依赖，可兼作「页面已挂载」信号）
const pageReady = computed(() => covNav.polyAvail)
// 波束合成 / 卫星覆盖等值线（GXT）为低频功能，紧跟 Polygon 后排布
const sideViews = computed(() => [
  { key: 'constellation', label: '星座', icon: 'satellite', disabled: !pageReady.value, hint: '星座分组与卫星搜索' },
  { key: 'antenna', label: '覆盖分析', icon: 'satellite-dish', disabled: !covNav.grdAvail, hint: '卫星 → 天线 → 覆盖范围 / 性能指标表（GRD）' },
  { key: 'poly', label: 'Polygon（协调区）', icon: 'hexagon', disabled: !covNav.polyAvail, hint: '协调区多边形：绘制 / 调点 / 扩缩 / 导出' },
  { key: 'beams', label: '波束合成', icon: 'radio', disabled: !covNav.grdAvail, hint: '多馈源反射面 / 赋形反射面：设参数 → 点图放置轮廓 → 生成方向图天线（SATSOFT 同款）' },
  { key: 'gxt', label: '卫星覆盖等值线', icon: 'waves', disabled: !covNav.covAvail, hint: 'GEO 卫星覆盖等值线（GXT 库）' },
  { key: 'markers', label: '标记', icon: 'map-pin', disabled: !pageReady.value, hint: '点标记 / 地面站 / 轨迹' },
  { key: 'geo', label: '地图设置', icon: 'sliders-horizontal', disabled: !pageReady.value, hint: '海陆配色 / 国界省界 / 名称标注' }
])
const sideTitle = computed(() => sideViews.value.find((v) => v.key === ui.side)?.label || '')
function setSide(k) { ui.side = ui.side === k ? '' : k }

// 侧栏宽度拖拽（左右分隔条）
function splitDown(e) {
  const x0 = e.clientX; const w0 = ui.exw
  const move = (ev) => { ui.exw = Math.max(240, Math.min(420, w0 + ev.clientX - x0)) }
  const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up) }
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up)
}

// ---- 导出范围：记忆用户上次选择（'world'=整幅世界图，默认；'view'=截图，当前视图所见即所得）----
const EXP_SCOPE_KEY = 'exp-scope'
const expScope = ref((() => { try { const v = localStorage.getItem(EXP_SCOPE_KEY); return v === 'view' || v === 'world' ? v : 'world' } catch { return 'world' } })())
watch(expScope, (v) => { try { localStorage.setItem(EXP_SCOPE_KEY, v) } catch { /* ignore */ } })
const EXP_NAME = { png2: '高清 PNG · 2×', png4: '高清 PNG · 4×', png6: '高清 PNG · 6×', pdf: '矢量 PDF', gxt: '导出 GXT', kml: '导出 KML' }
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
function openSunOutage() { window.api?.sunOutage?.open?.() }

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
  constellation: ConstellationMap,
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

// 经度在前、纬度在后，保留两位小数
const fmtCoord = (ll) => `${Math.abs(ll.lon).toFixed(2)}°${ll.lon >= 0 ? 'E' : 'W'}  ${Math.abs(ll.lat).toFixed(2)}°${ll.lat >= 0 ? 'N' : 'S'}`

// 底部状态栏缩放进度条：拖动/按钮 → 设回当前活动地图（zoom.apply）；地图滚轮缩放回填 zoom.value。
const onZoomInput = (e) => { const t = Number(e.target.value); if (zoom.apply) zoom.apply(t) }
const stepZoom = (d) => { const t = Math.max(0, Math.min(1, zoom.value + d)); if (zoom.apply) zoom.apply(t) }

// ---- 菜单栏（仿 SATSOFT 经典菜单：纯文字标题 + 下拉；不可用项置灰不隐藏）----
const menus = computed(() => [
  { key: 'file', label: '文件', items: [
    { label: '文件管理…', icon: 'folder-open', hint: '管理 GRD / GXT 覆盖文件库（导入 / 导出 / 删除）', run: () => { fileOpen.value = true } },
    { label: '导入 TLE 文件(CSV)…', icon: 'import', disabled: !covNav.importTle, hint: '从本地 CSV（CelesTrak「FORMAT=csv」的 OMM 文件）导入卫星星历，离线/连不上 celestrak 时用', run: () => covNav.importTle?.() },
    { sep: true },
    { label: '退出', icon: 'log-out', hint: '关闭主窗口', run: () => window.close() }
  ] },
  { key: 'calc', label: '计算', items: [
    { label: '地球静止轨道卫星（GEO）链路预算', icon: 'calculator', hint: '打开链路预算工作台（独立窗口）', run: openLinkBudget },
    { label: '非地球静止轨道卫星（NGSO）链路预算', icon: 'square-function', hint: '打开 NGSO 链路预算工作台（独立窗口）', run: openNgso },
    { label: '再生式链路预算', icon: 'cpu', hint: '打开再生式链路预算工作台（再生式上行 / 下行 / 星间链路，独立窗口）', run: openRegen },
    { label: '日凌预报（GEO）', icon: 'sun', hint: '打开日凌预报（独立窗口）', run: openSunOutage }
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
    { label: EXP_NAME.png2, icon: 'image', disabled: !covNav.exportAvail, hint: '导出 2 倍高清 PNG 图片', run: () => doExport('png2') },
    { label: EXP_NAME.png4, icon: 'image', disabled: !covNav.exportAvail, hint: '导出 4 倍高清 PNG 图片', run: () => doExport('png4') },
    { label: EXP_NAME.png6, icon: 'image', disabled: !covNav.exportAvail, hint: '导出 6 倍高清 PNG 图片', run: () => doExport('png6') },
    { label: EXP_NAME.pdf, icon: 'file-text', disabled: !covNav.exportAvail, hint: '导出矢量 PDF 文档', run: () => doExport('pdf') },
    { sep: true },
    { label: EXP_NAME.gxt, icon: 'layers', disabled: !covNav.exportAvail, hint: '把当前绘制的覆盖等值线 + 协调区多边形一起导出为一个 GXT 文件（所见即所得）', run: () => doExport('gxt') },
    { label: EXP_NAME.kml, icon: 'layers', disabled: !covNav.exportAvail, hint: '把当前绘制的覆盖等值线 + 协调区多边形一起导出为一个 Google KML 文件（所见即所得）', run: () => doExport('kml') },
    { sep: true },
    { label: '发送到小程序…', icon: 'upload', disabled: !covNav.exportAvail, hint: '把当前绘制的覆盖等值线 + 协调区多边形上传云端，生成密钥供微信小程序「卫星覆盖」导入', run: () => doSendMiniapp() }
  ] },
  { key: 'tools', label: '工具', items: [
    { label: '设置…', icon: 'settings', hint: '外观主题 / 显示画质 / 单位等设置', run: () => { settingsOpen.value = true } }
  ] },
  { key: 'help', label: '帮助', items: [
    { label: '关于卫星仿真平台…', icon: 'info', hint: '版本与说明', run: () => { aboutOpen.value = true } }
  ] }
])
function runItem(it) { if (it.disabled) return; openMenu.value = ''; hint.value = ''; it.run && it.run() }

// ---- 工具栏（只放侧栏覆盖不到的动作：文件 / 计算窗口 / 视图切换 / 导出 / 设置；面板切换交给活动栏，不重复）----
const toolButtons = computed(() => [
  { icon: 'folder-open', tip: '文件管理', run: () => { fileOpen.value = true } },
  { sep: true },
  { icon: 'calculator', tip: 'GEO 链路预算', run: openLinkBudget },
  { icon: 'square-function', tip: 'NGSO 链路预算', run: openNgso },
  { icon: 'cpu', tip: '再生式链路预算', run: openRegen },
  { icon: 'sun', tip: '日凌预报（GEO）', run: openSunOutage },
  { sep: true },
  { icon: 'globe', tip: '3D 球体视图', on: !view.flat, run: () => pickView(false) },
  { icon: 'map', tip: '2D 平面图视图', on: view.flat, run: () => pickView(true) },
  { sep: true },
  { icon: 'image', tip: '导出高清 PNG（4×）', disabled: !covNav.exportAvail, run: () => doExport('png4') },
  { icon: 'file-down', tip: '导出矢量 PDF', disabled: !covNav.exportAvail, run: () => doExport('pdf') },
  { sep: true },
  { icon: 'settings', tip: '设置', run: () => { settingsOpen.value = true } }
])

// 日志窗格：新条目自动滚到底
const logEl = ref(null)
watch(() => logStore.items.length, () => {
  nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight })
})

function onKey(e) { if (e.key === 'Escape') { openMenu.value = ''; hint.value = '' } }

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

onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.api?.app?.version?.().then((v) => { appVersion.value = v || '' }).catch(() => { /* 浏览器直跑无 IPC */ })
  syncTitleOverlay()
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
              <span class="vsp" :class="{ on: expScope === 'world' }" @click="expScope = 'world'">全球图</span>
              <span class="vsp" :class="{ on: expScope === 'view' }" @click="expScope = 'view'">截图</span>
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
          @click="!b.disabled && b.run()"
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
      <aside v-show="ui.side" class="dock sidebar" :style="{ width: ui.exw + 'px' }">
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
    <FileManager v-if="fileOpen" @close="fileOpen = false" />

    <!-- 帮助 → 关于 -->
    <div v-if="aboutOpen" class="about-mask" @click.self="aboutOpen = false">
      <div class="about">
        <div class="ab-name">卫星仿真平台</div>
        <div v-if="appVersion" class="ab-ver mono">版本 {{ appVersion }}</div>
        <div class="ab-desc">卫星链路预算 · 星座可视化 · 覆盖分析 · 日凌预报</div>
        <button class="ab-close" @click="aboutOpen = false">确定</button>
      </div>
    </div>

    <!-- ⑥ 状态栏：左提示 + 右侧凹陷读数格（视图 / 缩放 / 光标经纬度） -->
    <footer class="statusbar">
      <span class="hint">{{ hint || '就绪' }}</span>
      <span class="cells">
        <span class="cell">{{ view.flat ? '2D 平面图' : '3D 球体' }}</span>
        <span v-if="zoom.avail" class="cell zoomctl" title="地图缩放（拖动精细调节，滚轮亦可）">
          <button class="zbtn" title="缩小" @click="stepZoom(-0.01)"><Icon name="minus" :size="10" /></button>
          <input class="zrange" type="range" min="0" max="1" step="0.001" :value="zoom.value" @input="onZoomInput" />
          <button class="zbtn" title="放大" @click="stepZoom(0.01)"><Icon name="plus" :size="10" /></button>
          <span class="zpct">{{ Math.round(zoom.value * 100) }}%</span>
        </span>
        <span class="cell coord">
          <Icon class="cur" name="cursor-arrow" :size="13" />
          <span class="cval">{{ cursor.ll ? fmtCoord(cursor.ll) : '——°  ——°' }}</span>
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
.vsp { flex: 1; text-align: center; cursor: pointer; padding: 3px 6px; border-radius: 2px; font-size: 12px; color: var(--text-muted); border: 1px solid var(--border); }
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
  border-radius: 2px; padding: 0; cursor: pointer;
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
.dock-tt { flex: 1; font-size: 11.5px; font-weight: 600; letter-spacing: .5px; color: var(--text-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.dock-x { width: 18px; height: 18px; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--text-faint); cursor: pointer; border-radius: 2px; }
.dock-x:hover { background: var(--border); color: var(--text); }
.sbody { flex: 1; overflow-y: auto; overflow-x: hidden; }
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
.ln.dim { color: var(--text-faint); }
.ln .ts { color: var(--text-faint); margin-right: 9px; }

/* ===== 关于对话框 ===== */
.about-mask { position: fixed; inset: 0; z-index: 200; background: rgba(0,0,0,0.28); display: flex; align-items: center; justify-content: center; }
.about {
  min-width: 300px; padding: 26px 34px 22px; text-align: center;
  background: var(--surface); border: 1px solid var(--border-strong); box-shadow: 0 10px 32px rgba(0,0,0,0.3);
}
.ab-name { font-family: var(--font-serif); font-size: 19px; letter-spacing: .6px; }
.ab-ver { margin-top: 8px; font-size: 12px; color: var(--text-muted); }
.ab-desc { margin-top: 6px; font-size: 12px; color: var(--text-faint); }
.ab-close { margin-top: 18px; padding: 4px 22px; border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); cursor: pointer; border-radius: 2px; }
.ab-close:hover { border-color: var(--accent); }

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
.cell.coord { color: var(--text); }
.cell.coord .cur { flex: none; }
.cell.coord .cval { font-family: var(--font-mono); font-weight: 600; letter-spacing: .3px; min-width: 150px; }
.zoomctl .zbtn { width: 15px; height: 15px; display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); cursor: pointer; border-radius: 2px; }
.zoomctl .zbtn:hover { color: var(--text); border-color: var(--accent); }
.zoomctl .zrange { width: 110px; height: 3px; cursor: pointer; accent-color: var(--accent); }
.zoomctl .zpct { width: 32px; text-align: right; font-family: var(--font-mono); color: var(--text-muted); }
</style>
