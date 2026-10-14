<script setup>
// 模型工作台 独立窗口（DESIGN §7）：顶部功能区 + 左栏（当前页签的表单 / 列表，可拖宽）+ 右侧常驻预览视口。
//
// 外壳照空间态势报告窗口的 .lb-* 一套（样式整段抄在本文件 scoped 里，理由见样式区注释）。页签表是数据：
// 二期的「卫星」「分析」两页只需往 TABS 里按 order 插一条，左栏组件按页签懒加载（defineAsyncComponent + KeepAlive）。
// 状态与编排在 wbStore.js（provide 给各页签）；画面在 src/viz/models/viewport.js。
// 关窗守卫（2026-10-06 任务书 §3.4）：主进程 close 时转来 modelwb:closeRequested → 待存的元数据 / 卫星绑定、全部签的草稿与入库作业落定
// （wb.flushForClose，至多 2.5 s；主进程另有 3 s 兜底）→ confirmClose 真关。来不及入库的改动下次开窗按草稿恢复。
// 设计页（2026-10-06 文档标签条）：功能区下方一条文档标签条（design/DocTabs.vue），设计页显示什么只由激活签决定；
// Ctrl+Tab / Ctrl+Shift+Tab 按签顺序切换、Ctrl+W 关闭激活签（捕获阶段统一处理，非设计页空操作）。
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, provide, defineAsyncComponent, nextTick } from 'vue'
import { askConfirm, confirmState } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import LbFontCtl from '../components/LbFontCtl.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import { useNotice } from '../shared/useNotice.js'
import { alertMsg, closeAlert } from '../stores/alert.js'
import { theme, setTheme } from '../stores/theme.js'
import { byLang, curLang } from '../shared/i18n/lang.js'
import { onLangChange } from '../shared/i18n/runtime.js'
import { createViewport, QUALITY } from '../viz/models/viewport.js'
import { createWorkbench } from './wbStore.js'
import { createSatStore } from './satStore.js'
import { disposeHeavy } from './anaHeavy.js'
import { useSatViewport, SAT_TABS } from './useSatViewport.js'
import { fmtInt, fmtNum, fmtBox, displayName, importRoute, sourceTag, bodyBoxOfMeta, previewLod } from './wbLogic.js'
import { createAsmSession } from './asmSession.js'
import { DOCK_W_MIN, DOCK_W_MAX } from './asmLogic.js'
import { DEFAULT_TEMPLATE_ID } from '@core/models/paramTemplates.mjs'
// 装配视图的功能区组 / 右侧 dock / 视口读数：只在设计页打开装配文档时出现，按需加载
const AsmRibbon = defineAsyncComponent(() => import('./asm/AsmRibbon.vue'))
const AsmDock = defineAsyncComponent(() => import('./asm/AsmDock.vue'))
const AsmReadout = defineAsyncComponent(() => import('./asm/AsmReadout.vue'))
const AsmCursor = defineAsyncComponent(() => import('./asm/AsmCursor.vue'))
// 设计页模型视图（导入件 / NASA / 已存参数化件 / 只读模板）：右侧 dock = 模型级属性各节；功能区「文档」组
const ModelDock = defineAsyncComponent(() => import('./design/ModelDock.vue'))
const ModelRibbon = defineAsyncComponent(() => import('./design/ModelRibbon.vue'))
const DocTabs = defineAsyncComponent(() => import('./design/DocTabs.vue'))
const NewMenu = defineAsyncComponent(() => import('./design/NewMenu.vue'))

const api = (typeof window !== 'undefined') ? window.api : null
const langNow = ref(curLang())
onLangChange(() => { langNow.value = curLang() })
const errText = (e) => (e && e.message) || String(e)
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v } catch { return d } }
const lsSet = (k, v) => { try { localStorage.setItem(k, v) } catch { /* 便利数据 */ } }

// ============ 窗内提示（唯一出口）============
// 通知条走 shared/useNotice（普通 4 s · 导出带「打开 · 在文件夹中显示」· 失败常驻），同时登记为本窗的
// reportError / 全局异常出口；导出页、JSON 节经 inject('notice') 发导出回执
const N = useNotice()
provide('notice', N)
const toast = N.toast
const hintText = ref('')
let _ht = null
function hint(msg) { hintText.value = msg; clearTimeout(_ht); _ht = setTimeout(() => (hintText.value = ''), 8000) }


const wb = createWorkbench({ toast, hint, askConfirm })
provide('wb', wb)
const { st, cur } = wb
// 二期「卫星」「分析」两页共用：当前卫星、绑定工作副本（模型 / 姿态律 / 挂点）、掩模缓存、轨道
const sat = createSatStore(wb)
provide('sat', sat)

// ============ 页签（数据驱动）============
// 2026-10 统一设计：原「模型」「生成」「装配」三页合并成「设计」——打开什么文档就在同一个工作区里编辑它：
// 左栏快速设置（驱动参数 / 主要参数）+ 组件库，中间视口，右栏结构树 + 属性（选根节点 = 模型级属性：质量特性、挂点、关节、太阳翼组…）。
const TABS = [
  { key: 'lib', order: 10, label: '库', icon: 'package', tip: '库：模型（内置 / 云端 / 本机 / STK / 参数化 / 装配）与组件（全部组件与常用型号）；双击在设计页打开（模板打开为模板签，编辑时自动创建副本；组件以此为根件新建装配件）', comp: defineAsyncComponent(() => import('./LibTab.vue')) },
  { key: 'import', order: 20, label: '导入', icon: 'file-import', tip: '导入 glb / glTF / OBJ / STL / FBX / STEP / IGES / BREP，或从本机 STK 目录导入', comp: defineAsyncComponent(() => import('./ImportTab.vue')) },
  { key: 'design', order: 30, label: '设计', icon: 'boxes', tip: '设计：快速设置驱动参数，或在结构树与属性面板中逐件编辑；选中根节点查看模型级属性', comp: defineAsyncComponent(() => import('./design/DesignSide.vue')) },
  { key: 'sat', order: 50, label: '卫星', icon: 'satellite', tip: '为卫星绑定模型、姿态律与挂点（天线安装位置：位置 / 视轴 / 视场 / 万向节 / 天线引用）', comp: defineAsyncComponent(() => import('./SatTab.vue')) },
  { key: 'ana', order: 60, label: '分析', icon: 'chart-line', tip: '当前卫星与选中挂点：本体遮挡掩模、万向节可达性、太阳翼功率、星侧太阳侵入', comp: defineAsyncComponent(() => import('./AnalysisTab.vue')) },
  { key: 'export', order: 70, label: '导出', icon: 'file-export', tip: '导出 glb（含 .gmdf / .satsim.json）、缩略图与三视图', comp: defineAsyncComponent(() => import('./ExportTab.vue')) }
].sort((a, b) => a.order - b.order)
const TAB_KEYS = TABS.map((t) => t.key)
// 旧页签键（URL ?tab= / 本机记住的 / 3D 页「在工作台中打开」）：模型 / 生成 / 装配 → 设计页（显示哪份文档由激活签 / 跳转目标定）
const LEGACY_TABS = { model: 'model', gen: 'asm', asm: 'asm' }
function tabFrom(k) {
  if (TAB_KEYS.includes(k)) return k
  if (Object.hasOwn(LEGACY_TABS, k)) return 'design'
  return null
}
const q0 = new URLSearchParams(location.search)
st.tab = tabFrom(q0.get('tab')) || tabFrom(lsGet('model/tab', 'lib')) || 'lib'
watch(() => st.tab, (v) => lsSet('model/tab', v))
const curTab = computed(() => TABS.find((t) => t.key === st.tab) || TABS[0])
const designOn = computed(() => st.tab === 'design')
// 左栏自己画页眉的页签（设计页「快速设置 | 组件」、库页「模型 | 组件」）：不套通用栏头、栏体不加内边距
const ownHd = computed(() => designOn.value || st.tab === 'lib')
// 设计页显示什么由激活签决定：装配签 = 装配视图；模型签 = 模型视图（cur）；没有签 = 空态（视口空、左右栏空、功能区只留「新建」「文件」）
const docKind = computed(() => wb.activeKind())
const modelOn = computed(() => designOn.value && docKind.value === 'model')
const emptyOn = computed(() => designOn.value && !docKind.value)
// 设计页模型签 / 导出页以 lod0 为准（部件三角形号、拾取、导出都按全精度几何）；正在加载的那一档挂上之后再升
watch(() => [st.tab, docKind.value, cur.id, cur.loading], () => { if (modelOn.value || st.tab === 'export') wb.ensureFullDetail() })

// ============ 左栏拖宽（320–640，默认 400）；设计页单独一档（三栏：快速设置 / 组件库 260–480，默认 320）============
const W_MIN = 320, W_MAX = 640
const AW_MIN = 260, AW_MAX = 480
const sideW = ref((() => { const n = Number(lsGet('model/sideWidth', '400')); return n > 0 ? Math.min(W_MAX, Math.max(W_MIN, n)) : 400 })())
const asmSideW = ref((() => { const n = Number(lsGet('model/asmSideWidth', '320')); return n > 0 ? Math.min(AW_MAX, Math.max(AW_MIN, n)) : 320 })())
const sideResizing = ref(false)
// 窗宽（装配页三栏按比例收窄、功能区溢出菜单都看它）
const winW = ref(typeof window !== 'undefined' ? window.innerWidth : 1600)
const onWinResize = () => { winW.value = window.innerWidth }
function startResize(e) {
  const asmNow = designOn.value
  const x0 = e.clientX, w0 = asmNow ? sideWEff.value : sideW.value
  const lo = asmNow ? AW_MIN : W_MIN, hi = asmNow ? AW_MAX : W_MAX
  sideResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { const v = Math.min(hi, Math.max(lo, w0 + ev.clientX - x0)); if (asmNow) asmSideW.value = v; else sideW.value = v }
  const up = () => {
    sideResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    if (asmNow) lsSet('model/asmSideWidth', String(asmSideW.value)); else lsSet('model/sideWidth', String(sideW.value))
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 预览视口 ============
const viewEl = ref(null)
let vp = null
const VIEWS = [
  { key: 'auto', label: '自动' }, { key: 'iso', label: '等轴' }, { key: 'front', label: '前（+X）' }, { key: 'back', label: '后（−X）' },
  { key: 'left', label: '左（−Y）' }, { key: 'right', label: '右（+Y）' }, { key: 'top', label: '顶（−Z）' }, { key: 'bottom', label: '底（+Z）' }
]
const view = ref('auto')
function applyView(v) { view.value = v; if (vp) vp.setView(v) }
const OVS = [
  { key: 'axes', label: '本体轴', icon: 'axis-3d', tip: '本体系三轴：X 速度方向、Y 按右手系补全、Z 天底' },
  { key: 'attach', label: '挂点', icon: 'locate-fixed', tip: '挂点：圆盘 + 视轴射线 + 名称' },
  { key: 'com', label: '质心', icon: 'weight', tip: '质心标记（有质量特性时）' },
  { key: 'parts', label: '部件', icon: 'layers', tip: '部件按角色着色' },
  { key: 'wireframe', label: '线框', icon: 'grid-3x3', tip: '网格线框' },
  { key: 'grid', label: '网格', icon: 'square-dashed-mouse-pointer', tip: '米制地面网格与接地阴影' }
]
const ov = reactive((() => {
  const d = { axes: true, lvlh: false, attach: true, com: true, parts: false, wireframe: false, grid: true, labels: true }
  try { const s = JSON.parse(lsGet('model/overlays', 'null')); if (s && typeof s === 'object') for (const k of Object.keys(d)) if (typeof s[k] === 'boolean') d[k] = s[k] } catch { /* 便利数据 */ }
  return d
})())
watch(ov, (v) => { lsSet('model/overlays', JSON.stringify(v)); if (vp) vp.setOverlays(vpOverlays()) }, { deep: true })
const light = ref(lsGet('model/light', 'studio') === 'sun' ? 'sun' : 'studio')
watch(light, (v) => { lsSet('model/light', v); if (vp) vp.setLight(v) })
const QUALITY_OPTS = [
  { key: 'low', label: '标准', tip: '直接渲染：无环境光遮蔽，适用于低性能显卡或超大模型' },
  { key: 'high', label: '高', tip: '4× 多重采样 + 环境光遮蔽（半分辨率）+ 接地阴影' },
  { key: 'ultra', label: '极致', tip: '8× 多重采样（显卡支持时）+ 全分辨率环境光遮蔽 + 4096 阴影贴图' }
]
const quality = ref(QUALITY[lsGet('model/quality', 'high')] ? lsGet('model/quality', 'high') : 'high')
watch(quality, (v) => { lsSet('model/quality', v); if (vp) vp.setQuality(v) })
provide('viewport', () => vp)
// 装配页会话（P3）：先于卫星页的视口联动建 —— 切页签时它的 watch 先跑，先借还视口，卫星页再喂
const asm = createAsmSession({ wb, getVp: () => vp, ov })
provide('asm', asm)
const asmOn = computed(() => designOn.value && docKind.value === 'asm')
// 设计页三栏：视口至少留 560 px——窗窄时左栏与 dock 按比例收窄（各不低于下限），不挤视口
const ASM_STAGE_MIN = 560
const asmCols = computed(() => {
  const side = asmSideW.value, dock = asm.ui.dockW
  const room = winW.value - ASM_STAGE_MIN - 2
  if (side + dock <= room) return { side, dock }
  const k = Math.max(0, room) / (side + dock)
  return { side: Math.max(AW_MIN, Math.round(side * k)), dock: Math.max(DOCK_W_MIN, Math.round(dock * k)) }
})
const sideWEff = computed(() => (designOn.value ? asmCols.value.side : sideW.value))
const dockWEff = computed(() => asmCols.value.dock)
// 功能区：装配页窗宽放不下整条功能区时把「视图」「字号」收进「⋯」溢出菜单，不靠横向滚动。
// 整条的宽度按屏上实量（界面字体 / 字号可调，不写死）：完整显示时量一次各组宽度之和，窗宽小于它就收
const lbrEl = ref(null)
const ribbonFullW = ref(1520)
const ribbonNarrow = computed(() => asmOn.value && winW.value < ribbonFullW.value)
function measureRibbon() {
  const el = lbrEl.value
  if (!el || !asmOn.value || ribbonNarrow.value) return
  let w = 0
  for (const c of el.children) w += c.getBoundingClientRect().width
  const cs = getComputedStyle(el)
  w += (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + 2
  if (w > 200) ribbonFullW.value = Math.ceil(w)
}
watch([asmOn, winW, ribbonNarrow], () => nextTick(measureRibbon))
// 装配页的功能区组是异步组件：插进来之后再量一次
let lbrMo = null
const moreMenu = ref(null)
function toggleMore(ev) {
  if (moreMenu.value) { moreMenu.value = null; return }
  const r = ev.currentTarget.getBoundingClientRect()
  moreMenu.value = { x: Math.max(4, Math.min(r.left, window.innerWidth - 360)), y: r.bottom + 2 }
}
watch(ribbonNarrow, (n) => { if (!n) moreMenu.value = null })
// 装配页的「渲染」下拉：光照 × 画质合成一个（省一行功能区宽度）
const RENDER_OPTS = computed(() => { const out = []; for (const l of [['studio', '影棚'], ['sun', '太阳']]) for (const q of QUALITY_OPTS) out.push({ key: l[0] + '|' + q.key, label: l[1] + ' · ' + q.label, tip: q.tip }); return out })
const renderKey = computed(() => light.value + '|' + quality.value)
function setRender(v) { const [l, q] = String(v).split('|'); if (l === 'studio' || l === 'sun') light.value = l; if (QUALITY[q]) quality.value = q }
// 「视图」组的叠加开关：装配页里「质心」「挂点」换成编辑器自己的质心十字 / 空闲插座标记
// 「本体轴」在装配页换成编辑器的原点三轴（像素恒定细线 + 字标）：视口那套按整件半径缩放的实心箭头装上长太阳翼后粗到压住星体
const ovOn = (k) => (asmOn.value && k === 'com' ? asm.ui.showCom : asmOn.value && k === 'attach' ? asm.ui.showSockets : asmOn.value && k === 'axes' ? asm.ui.showAxes : ov[k])
function ovToggle(k) {
  if (asmOn.value && k === 'com') asm.setShowCom(!asm.ui.showCom)
  else if (asmOn.value && k === 'attach') asm.setShowSockets(!asm.ui.showSockets)
  else if (asmOn.value && k === 'axes') asm.setShowAxes(!asm.ui.showAxes)
  else ov[k] = !ov[k]
}
// 装配视图里没有「部件」着色（编辑器按件自己画），开关不起作用 → 不给
const ovsNow = computed(() => (asmOn.value ? OVS.filter((o) => o.key !== 'parts') : OVS))
const ovLabel = (o) => (asmOn.value && o.key === 'attach' ? '接口' : o.label)
const ovTip = (o) => (asmOn.value && o.key === 'attach' ? '接口标记：选中件的空闲接口' : asmOn.value && o.key === 'com' ? '质心十字（随拖动实时更新）' : asmOn.value && o.key === 'axes' ? '本体原点三轴（屏幕恒定长度）' : o.tip)
// 视口自己的叠加：装配页关掉它的本体轴（由编辑器画）
const vpOverlays = () => ({ ...ov, axes: asmOn.value ? false : ov.axes })
// 右侧 dock 拖宽（左缘；260–520，存 model/asm/ui）
const dockResizing = ref(false)
function startDockResize(e) {
  const x0 = e.clientX, w0 = dockWEff.value
  dockResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { asm.ui.dockW = Math.min(DOCK_W_MAX, Math.max(DOCK_W_MIN, w0 - (ev.clientX - x0))) }
  const up = () => {
    dockResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
// 卫星 / 分析页 ↔ 预览：挂点叠加与点选、模型跟着卫星走、掩模球面片、天线视角
const satView = useSatViewport({ wb, sat, getVp: () => vp })
provide('satView', satView)

// 读数（运行时数据）：三角形 · 包围盒 · 质量 · 帧率
const rd = reactive({ tris: 0, fps: 0, frameMs: 0 })
let _rdT = 0
function pollStats() { if (!vp) return; const s = vp.stats(); rd.tris = s.tris; rd.fps = s.fps; rd.frameMs = s.frameMs }
// 包围盒读数取视口按屏上几何逐顶点量的（关节初值位姿）；视口还没量出来时退回元数据里的
const boxText = computed(() => { void cur.rev; void cur.geomRev; const v = cur.view; const b = (v && v.bboxM) || (cur.meta ? bodyBoxOfMeta(cur.meta) : null); return b ? fmtBox(b) : '' })
const massText = computed(() => { void cur.rev; const m = cur.meta && cur.meta.massProps; return m && Number.isFinite(m.massKg) ? fmtNum(m.massKg, 4) : '' })
const curTitle = computed(() => { void langNow.value; return cur.meta ? (displayName(cur.meta, langNow.value) || cur.id) : '' })
// 标题下只放短标签（来源 · 当前 LOD）；署名 / 许可 / 出处整句只进 title（CLAUDE.md：界面不放说明性句子）
const curSub = computed(() => {
  void langNow.value
  const m = cur.meta
  if (!m) return ''
  const bits = []
  const tag = sourceTag(m) || (cur.kind === 'tpl' || cur.kind === 'gen' ? byLang('参数化', 'Parametric') : '')
  if (tag) bits.push(tag)
  if (cur.kind === 'glb' && cur.lod) bits.push(cur.lod)
  return bits.join(' · ')
})
const curTip = computed(() => {
  const m = cur.meta
  if (!m || !m.source) return ''
  return [m.source.credit, m.source.license, m.source.url].filter(Boolean).join('\n')
})
const dlNow = computed(() => (cur.id ? st.dl[cur.id] : null))
const dlPct = computed(() => { const d = dlNow.value; return d && d.total ? Math.round((d.received / d.total) * 100) : null })

// ============ 文件：导入 / STK / 导出 ============
async function pickAndImport() {
  const files = await wb.call('pickFiles')
  if (!files || files === wb.LOCKED || !Array.isArray(files) || !files.length) return
  st.tab = 'import'
  wb.importFiles(files.map((f) => ({ path: f.path, name: f.name })))
}
function openStk() { st.tab = 'import'; nextTick(() => window.dispatchEvent(new CustomEvent('modelwb:stk'))) }
// 设计页没有签时功能区的「新建」（下拉与装配 / 模型视图共用 design/NewMenu.vue）
const newMenu = ref(null)
function openNew(ev) {
  const r = ev.currentTarget.getBoundingClientRect()
  newMenu.value = { x: Math.min(r.left, window.innerWidth - 176), y: r.bottom + 2 }
}
function openExport() { st.tab = 'export' }
// 「导出…」：设计页有签（导出对象 = 激活签）或当前有模型时可用；库页组件档的只读预览（cur.id = 'cmp:…'）不是导出候选
const canOpenExport = computed(() => (designOn.value ? !!wb.activeDocState() : !!cur.meta && !String(cur.id || '').startsWith('cmp:')))

// ============ 整窗拖放导入 ============
const dropOn = ref(false)
let dragDepth = 0
const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'))
function onDragEnter(e) { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropOn.value = true }
function onDragOver(e) { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
function onDragLeave(e) { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dropOn.value = false }
async function onDrop(e) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0; dropOn.value = false
  const files = Array.from(e.dataTransfer.files || [])
  if (!files.length) return
  // 本机路径经 preload（webUtils）从真实 File 取、并登记给主进程放行：主进程只读用户选过 / 拖进来的那几处目录。
  // OBJ 的 .mtl / 贴图、STEP 都要路径；拿不到时 glb / OBJ / STL / FBX 退回读字节
  let paths = []
  try { paths = (api && api.models && api.models.droppedPaths) ? await api.models.droppedPaths(files) : [] } catch { paths = [] }
  const out = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const p = typeof paths[i] === 'string' && paths[i] ? paths[i] : ''
    if (p) out.push({ path: p, name: f.name })
    else {
      const route = importRoute(f.name)
      if (route === 'cad') { out.push({ name: f.name }); continue }
      try { out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }) } catch (err) { hint(errText(err)) }
    }
  }
  st.tab = 'import'
  wb.importFiles(out)
}

// ============ 键盘：F 取景、1/3/7 前 / 右 / 顶（Blender 小键盘习惯）============
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return
  if (e.target && e.target.closest && e.target.closest('.eg-scroll')) return
  if (e.ctrlKey || e.altKey || e.metaKey) return
  // gizmo 拖动中不切视角（切了会打乱手柄的拖动平面）；放置中（拖入 / 重新放置）照常
  if (asmOn.value && asm.ui.dragging && asm.ui.dragKind === 'gizmo') return
  const k = e.key
  if (k === 'f' || k === 'F') { if (asmOn.value) asm.frameSelection(); else applyView(view.value); e.preventDefault() }
  else if (k === '1') applyView(e.shiftKey ? 'back' : 'front')
  else if (k === '3') applyView(e.shiftKey ? 'left' : 'right')
  else if (k === '7') applyView(e.shiftKey ? 'bottom' : 'top')
  else if (k === '0') applyView('auto')
}

// ============ 文档签键位：Ctrl+Tab / Ctrl+Shift+Tab 按签顺序切换，Ctrl+W 关闭激活签 ============
// 捕获阶段统一处理并 preventDefault（Ctrl+W 不落到窗口关闭、Tab 不移走焦点）；非设计页空操作。焦点在输入框：先 blur 提交再动作。
// 放置中 / gizmo 拖动中（编辑器 mode 不是 idle / hover）、应用内确认框开着时一律忽略。
function onDocKey(e) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return
  const k = e.key
  const isTab = k === 'Tab', isW = k === 'w' || k === 'W'
  if (!isTab && !isW) return
  e.preventDefault()
  e.stopPropagation()
  if (e.repeat && isW) return
  if (st.tab !== 'design' || confirmState.open) return
  if (asmOn.value && (asm.ui.dragging || (asm.ui.mode !== 'idle' && asm.ui.mode !== 'hover'))) return
  const a = document.activeElement
  if (a && a !== document.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) a.blur()
  if (isTab) wb.cycleDoc(e.shiftKey ? -1 : 1)
  else if (st.activeDoc) wb.closeDoc(st.activeDoc)
}

// ============ 关窗守卫（§3.4）============
let offClose = null, closing = false
async function onCloseRequested() {
  if (closing) return
  closing = true
  try {
    const a = document.activeElement
    if (a && a !== document.body && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) a.blur()   // 输入框里没提交的值先提交
    const satP = sat.flushSave()
    await Promise.race([Promise.all([wb.flushForClose(2500), Promise.resolve(satP).catch(() => null)]), new Promise((r) => setTimeout(r, 2600))])
  } catch (e) { console.warn('[modelwb] 关窗落定：' + errText(e)) } finally {
    closing = false
    try { await api.models.confirmClose() } catch { /* 主进程兜底关 */ }
  }
}

// ============ 外部目标（3D 页「编辑…」/ 侧栏「模型工作台」）============
// {tab?, modelId?, satKey?, name?}：带 satKey 的选中那颗星（没给 tab 时切到卫星页，模型跟着卫星绑定走：useSatViewport）。
// 落到设计页的（旧键 model / asm、3D 页侧栏「模型工作台」{tab:'model', satKey, modelId}）一律 = 库页双击：打开或激活该件的签——
// 设计页显示什么只由激活签决定，不在设计页上直接 wb.select（cur 与激活签对不上，编辑会落到签名以外的那件上）。
// 开签前先等开窗恢复（restoreDocs，与 ModelApp 挂载时同一个 Promise）：主进程在 did-finish-load 就送目标，恢复还没完时开的签与恢复出的同一签会各一份。
async function goTarget(t) {
  if (!t || typeof t !== 'object') return
  const tk = tabFrom(t.tab)   // 旧键 model / gen / asm → design
  const mid = typeof t.modelId === 'string' && t.modelId ? t.modelId : ''
  const sk = typeof t.satKey === 'string' && t.satKey ? t.satKey : ''
  // 没给页签、不带卫星、正停在设计页：同样按「在设计页打开」处理
  const toDesign = !!mid && (tk === 'design' || (!tk && !sk && st.tab === 'design'))
  if (sk) {
    if (!toDesign) {
      // 直接跳到导出页：导出对象 = 这一件（钉住，进导出页的缺省规则不覆盖）
      if (tk === 'export' && mid) wb.pinExportTarget('lib:' + mid)
      st.tab = tk || 'sat'
    }
    await sat.selectSat({ satKey: sk, label: typeof t.name === 'string' && t.name ? t.name : undefined })
    if (!mid) return
  }
  // 主窗口命令「参数化生成卫星模型」（旧键 gen）：打开 default-sat 模板签（已开 = 激活；原样不入库）
  if (t.tab === 'gen' && !mid && !sk) {
    if (!st.loaded) await wb.refresh()
    await wb.restoreDocs()
    wb.openTemplateTab(wb.templateEntryIdOf(DEFAULT_TEMPLATE_ID))
    return
  }
  if (mid) {
    if (!st.loaded) await wb.refresh()
    if (!wb.byId(mid)) await wb.refresh()
    if (toDesign) {
      await wb.restoreDocs()
      if (!wb.openInDesign(mid)) {
        hint(byLang('模型不在库中。', 'Model not in library.'))
        if (sk) st.tab = 'sat'
      }
      return
    }
    if (tk && !sk) {
      if (tk === 'export') wb.pinExportTarget('lib:' + mid)
      st.tab = tk
    }
    wb.select(mid, { lod: st.tab === 'export' ? 'lod0' : previewLod(wb.byId(mid)) })
    return
  }
  if (tk) st.tab = tk
}

onMounted(async () => {
  vp = createViewport(viewEl.value, { theme: theme.resolved === 'dark' ? 'dark' : 'light', mode: light.value, quality: quality.value })
  vp.setOverlays(vpOverlays())
  window.addEventListener('resize', onWinResize)
  if (lbrEl.value && typeof MutationObserver === 'function') { lbrMo = new MutationObserver(() => nextTick(measureRibbon)); lbrMo.observe(lbrEl.value, { childList: true }) }
  wb.setViewport(vp)
  _rdT = setInterval(pollStats, 500)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keydown', onDocKey, true)
  window.addEventListener('beforeunload', wb.flushSave)
  window.addEventListener('beforeunload', sat.flushSave)
  window.addEventListener('beforeunload', wb.flushAllDocs)
  wb.onTarget(goTarget)
  // 关窗守卫：主进程拦下 close 转来；落定后回 confirmClose（主进程 3 s 兜底，渲染端卡住也关得掉）
  if (api && api.models && typeof api.models.onCloseRequested === 'function') {
    try { offClose = api.models.onCloseRequested(onCloseRequested) } catch (e) { console.warn('[modelwb] 关窗守卫：' + errText(e)) }
  }
  await wb.refresh()
  // 上次的签（库件按 id 重读、模板签按模板重建、未入库文档按草稿恢复）：在装配会话起来、外部跳转之前恢复
  await wb.restoreDocs()
  sat.loadAll()
  satView.apply()
  asm.start()
  const mid = q0.get('modelId'), sk = q0.get('satKey')
  if (mid || sk) goTarget({ tab: q0.get('tab'), modelId: mid || undefined, satKey: sk || undefined, name: q0.get('name') || undefined })
  else if (q0.get('tab') === 'gen') goTarget({ tab: 'gen' })
  else if (SAT_TABS.includes(st.tab)) {
    // 上次停在卫星 / 分析页：接着上次那颗星
    try { const l = JSON.parse(lsGet('model/satLast', 'null')); if (l && l.satKey) sat.selectSat(l) } catch { /* 便利数据 */ }
  }
})
watch(() => theme.resolved, (t) => { if (vp) vp.setTheme(t === 'dark' ? 'dark' : 'light') })
watch(asmOn, () => { if (vp) vp.setOverlays(vpOverlays()) })
onBeforeUnmount(() => {
  clearInterval(_rdT)
  window.removeEventListener('resize', onWinResize)
  if (lbrMo) { lbrMo.disconnect(); lbrMo = null }
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keydown', onDocKey, true)
  window.removeEventListener('beforeunload', wb.flushSave)
  window.removeEventListener('beforeunload', sat.flushSave)
  window.removeEventListener('beforeunload', wb.flushAllDocs)
  if (offClose) { try { offClose() } catch { /* 无 */ } offClose = null }
  sat.dispose()
  disposeHeavy()
  asm.dispose()
  wb.dispose()
  if (vp) { vp.dispose(); vp = null }
})

// 调试 / 验证台句柄：开发态或 URL 带 wbHarness 时挂（打包版无 DevTools，挂了也无害）
if (import.meta.env.DEV || q0.has('wbHarness')) window.__modelwb = { wb, sat, satView, asm, vp: () => vp, ov, light, quality, view, applyView, setTheme, goTarget }
</script>

<template>
  <div class="lb-shell md-shell" @dragenter="onDragEnter" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <ActivationLock />
    <!-- 功能区 -->
    <div ref="lbrEl" class="lbr">
      <div class="lbr-g">
        <div class="lbr-items">
          <button v-for="t in TABS" :key="t.key" class="lbr-big" :class="{ on: st.tab === t.key }" :aria-pressed="(st.tab === t.key) ? 'true' : 'false'" :title="t.tip" @click="st.tab = t.key">
            <Icon :name="t.icon" :size="16" />{{ t.label }}
          </button>
        </div>
        <div class="lbr-cap">页签</div>
      </div>

      <AsmRibbon v-if="asmOn" />
      <ModelRibbon v-else-if="modelOn" />
      <div v-else-if="emptyOn" class="lbr-g asm-rb" data-grp="doc">
        <div class="lbr-items">
          <button class="lbr-big" data-act="new" title="新建：空白文档或从模板新建" @click="openNew">
            <Icon name="plus" :size="16" />新建
          </button>
        </div>
        <div class="lbr-cap">文档</div>
      </div>

      <div v-if="!ribbonNarrow && !emptyOn" class="lbr-g" :class="{ asm: asmOn }" data-grp="view">
        <div class="lbr-items">
          <div class="lbr-form">
            <label><span>视角</span>
              <select :value="view" title="切换到该视角并取景（自动：选取太阳电池面可见、画面占比最大的 3/4 视角，与模型库缩略图一致）；键盘 F 重新取景，1 / 3 / 7 为前 / 右 / 顶（Shift 取反向），0 为自动" @change="applyView($event.target.value)">
                <option v-for="v in VIEWS" :key="v.key" :value="v.key">{{ v.label }}</option>
              </select>
            </label>
            <template v-if="asmOn">
              <label><span>渲染</span>
                <select data-act="render" :value="renderKey" title="光照 · 画质（影棚：环境反射 + 主光 / 补光 / 轮廓光 + 软阴影；太阳：单一硬平行光 + 地球反照）" @change="setRender($event.target.value)">
                  <option v-for="o in RENDER_OPTS" :key="o.key" :value="o.key" :title="o.tip">{{ o.label }}</option>
                </select>
              </label>
              <label><span>姿态</span>
                <span class="lbu-seg">
                  <button data-act="pose-zero" :class="{ on: !asm.ui.posePreview }" :aria-pressed="(!asm.ui.posePreview) ? 'true' : 'false'" title="零位：按关节零位编辑（接口 / 面安装 / 拾取 / 干涉检查基于同一几何）" @click="asm.setPosePreview(false)">零位</button>
                  <button data-act="pose-init" :class="{ on: asm.ui.posePreview }" :aria-pressed="asm.ui.posePreview ? 'true' : 'false'" title="初值：按关节初值姿态预览（预览时不可编辑）" @click="asm.setPosePreview(true)">初值</button>
                </span>
              </label>
            </template>
            <template v-else>
              <label><span>光照</span>
                <span class="lbu-seg">
                  <button :class="{ on: light === 'studio' }" :aria-pressed="(light === 'studio') ? 'true' : 'false'" title="影棚：环境反射 + 主光 / 补光 / 轮廓光 + 软阴影" @click="light = 'studio'">影棚</button>
                  <button :class="{ on: light === 'sun' }" :aria-pressed="(light === 'sun') ? 'true' : 'false'" title="太阳：单一硬平行光 + 地球反照，暗面近黑" @click="light = 'sun'">太阳</button>
                </span>
              </label>
              <label><span>画质</span>
                <select v-model="quality" :title="(QUALITY_OPTS.find((x) => x.key === quality) || {}).tip">
                  <option v-for="o in QUALITY_OPTS" :key="o.key" :value="o.key" :title="o.tip">{{ o.label }}</option>
                </select>
              </label>
            </template>
          </div>
          <div class="md-ovgrid">
            <button v-for="o in ovsNow" :key="o.key" type="button" class="md-tg" :class="{ on: ovOn(o.key) }" :aria-pressed="(ovOn(o.key)) ? 'true' : 'false'" :title="ovTip(o)" @click="ovToggle(o.key)">
              <Icon :name="o.icon" :size="12" /><span>{{ ovLabel(o) }}</span>
            </button>
          </div>
        </div>
        <div class="lbr-cap">视图</div>
      </div>
      <div v-if="ribbonNarrow && !emptyOn" class="lbr-g" data-grp="more">
        <div class="lbr-items">
          <button class="lbr-big" data-act="ribbon-more" :class="{ on: !!moreMenu }" :aria-pressed="(!!moreMenu) ? 'true' : 'false'" title="视图 · 字号" @click="toggleMore">
            <Icon name="ellipsis" :size="16" />视图
          </button>
        </div>
        <div class="lbr-cap">更多</div>
      </div>

      <!-- 文件组：装配视图里功能区组多，收成两列小钮（不撑宽功能区） -->
      <div class="lbr-g" :class="{ 'asm-rb': asmOn }" data-grp="file">
        <div class="lbr-items">
          <template v-if="!asmOn">
            <button class="lbr-big" data-act="import" :disabled="!api" title="选择模型文件导入（glb / glTF / OBJ / STL / FBX / STEP / IGES / BREP）；也可直接拖入窗口" @click="pickAndImport">
              <Icon name="file-import" :size="16" />导入文件…
            </button>
            <button class="lbr-big" data-act="import-stk" :disabled="!api" title="从本机 STK 安装目录导入 glb（不可导出、不可分发）" @click="openStk">
              <Icon name="satellite" :size="16" />从 STK 导入…
            </button>
            <button class="lbr-big" data-act="export" :disabled="!canOpenExport" title="导出当前模型" @click="openExport">
              <Icon name="file-export" :size="16" />导出…
            </button>
          </template>
          <template v-else>
            <div class="asm-rb-col">
              <button class="asm-tg" data-act="import" :disabled="!api" title="选择模型文件导入（glb / glTF / OBJ / STL / FBX / STEP / IGES / BREP）；也可直接拖入窗口" @click="pickAndImport">
                <Icon name="file-import" :size="12" /><span>导入文件…</span>
              </button>
              <button class="asm-tg" data-act="import-stk" :disabled="!api" title="从本机 STK 安装目录导入 glb（不可导出、不可分发）" @click="openStk">
                <Icon name="satellite" :size="12" /><span>从 STK 导入…</span>
              </button>
            </div>
            <div class="asm-rb-col">
              <button class="asm-tg" data-act="export" :disabled="!canOpenExport" title="导出当前装配件（未入库时先入库）" @click="openExport">
                <Icon name="file-export" :size="12" /><span>导出…</span>
              </button>
            </div>
          </template>
        </div>
        <div class="lbr-cap">文件</div>
      </div>

      <LbFontCtl v-if="!ribbonNarrow && !emptyOn" />

    </div>

    <!-- 文档标签条（设计页；横跨三栏） -->
    <DocTabs v-if="designOn && st.docs.length" />

    <div class="lb-body">
      <aside class="lb-col lb-side md-side" :class="{ resizing: sideResizing }" :style="{ width: sideWEff + 'px' }">
        <div v-if="!ownHd" class="lb-col-hd"><span class="lb-cfg-hd-t">{{ curTab.label }}</span></div>
        <div class="lb-col-bd md-side-bd" :class="{ dsg: ownHd }">
          <KeepAlive>
            <component :is="curTab.comp" :key="curTab.key" />
          </KeepAlive>
        </div>
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize"></div>
      </aside>
      <section class="lb-col lb-build md-stage" :class="{ sun: light === 'sun' }">
        <div ref="viewEl" class="md-view"></div>
        <!-- 装配状态片（视口顶部居中、不挡鼠标）：吸附 / 穿插 / 命令失败的状态短语 + 入库中 / 未保存 -->
        <div v-if="asmOn && (asm.ui.status.text || wb.asm.saving || wb.asm.saveErr)" class="asm-stchip">
          <span v-if="asm.ui.status.text" class="asm-st" :class="asm.ui.status.kind" data-asm-status>{{ asm.ui.status.text }}</span>
          <span v-if="wb.asm.saving" class="asm-st busy" title="入库中"><span class="md-spin"></span></span>
          <span v-if="wb.asm.saveErr" class="asm-st warn" :title="wb.asm.saveErr" data-asm-save-err><Icon name="alert-triangle" :size="12" />未保存</span>
        </div>
        <AsmReadout v-if="asmOn" :fps="rd.fps" :frame-ms="rd.frameMs" />
        <AsmCursor v-if="asmOn" />
        <!-- 视口左上的标题只在库 / 导入 / 卫星 / 分析 / 导出页显示：设计页由标签条显示文档名 -->
        <div v-if="cur.meta && !designOn" class="md-cap">
          <div class="md-cap-t" :title="curTip" data-i18n-skip>{{ curTitle }}</div>
          <div v-if="curSub" class="md-cap-s" data-i18n-skip>{{ curSub }}</div>
        </div>
        <div v-if="emptyOn" class="md-empty">未打开文档。</div>
        <div v-else-if="!asmOn && !cur.meta && !cur.loading && !cur.error" class="md-empty">{{ cur.blank || '未选择模型。' }}</div>
        <div v-if="!asmOn && !emptyOn && cur.loading" class="md-load">
          <span class="md-spin"></span>
          <span v-if="dlPct != null" data-i18n-skip>{{ dlPct }}%</span>
        </div>
        <div v-if="!asmOn && !emptyOn && cur.error && !cur.loading" class="md-err"><Icon name="alert-triangle" :size="12" /> <span>{{ cur.error }}</span></div>
        <div v-if="cur.meta && !asmOn && !emptyOn" class="md-read">
          <span class="md-rk">三角形</span><span class="md-rv" data-i18n-skip>{{ fmtInt(rd.tris) }}</span>
          <template v-if="boxText"><span class="md-rs">·</span><span class="md-rk">包围盒</span><span class="md-rv" data-i18n-skip>{{ boxText }}</span><span class="md-ru">m</span></template>
          <template v-if="massText"><span class="md-rs">·</span><span class="md-rk">质量</span><span class="md-rv" data-i18n-skip>{{ massText }}</span><span class="md-ru">kg</span></template>
          <template v-if="rd.fps"><span class="md-rs">·</span><span class="md-rv" :title="'帧 CPU ' + rd.frameMs + ' ms'">{{ Math.round(rd.fps) }}</span><span class="md-ru">fps</span></template>
        </div>
      </section>
      <aside v-if="designOn" class="lb-col asm-dockcol" :class="{ resizing: dockResizing }" :style="{ width: dockWEff + 'px' }">
        <div class="asm-dockcol-rz" title="拖动调整栏宽" @mousedown.prevent="startDockResize"></div>
        <AsmDock v-if="asmOn" />
        <ModelDock v-else-if="modelOn" />
      </aside>
    </div>

    <Teleport to="body">
      <div v-if="moreMenu" class="lb-ctx-mask menu-mask" @mousedown="moreMenu = null" @contextmenu.prevent="moreMenu = null">
        <div class="lb-ctx md-more menu" :style="{ left: moreMenu.x + 'px', top: moreMenu.y + 'px' }" @mousedown.stop>
          <div class="lbr-form">
            <label><span>视角</span>
              <select :value="view" @change="applyView($event.target.value)">
                <option v-for="v in VIEWS" :key="v.key" :value="v.key">{{ v.label }}</option>
              </select>
            </label>
            <label><span>渲染</span>
              <select :value="renderKey" @change="setRender($event.target.value)">
                <option v-for="o in RENDER_OPTS" :key="o.key" :value="o.key" :title="o.tip">{{ o.label }}</option>
              </select>
            </label>
            <label><span>姿态</span>
              <span class="lbu-seg">
                <button :class="{ on: !asm.ui.posePreview }" :aria-pressed="(!asm.ui.posePreview) ? 'true' : 'false'" title="零位：按关节零位编辑" @click="asm.setPosePreview(false)">零位</button>
                <button :class="{ on: asm.ui.posePreview }" :aria-pressed="asm.ui.posePreview ? 'true' : 'false'" title="初值：按关节初值姿态预览（预览时不可编辑）" @click="asm.setPosePreview(true)">初值</button>
              </span>
            </label>
          </div>
          <div class="md-ovgrid">
            <button v-for="o in ovsNow" :key="o.key" type="button" class="md-tg" :class="{ on: ovOn(o.key) }" :aria-pressed="(ovOn(o.key)) ? 'true' : 'false'" :title="ovTip(o)" @click="ovToggle(o.key)">
              <Icon :name="o.icon" :size="12" /><span>{{ ovLabel(o) }}</span>
            </button>
          </div>
          <div class="md-more-font"><LbFontCtl /></div>
        </div>
      </div>
    </Teleport>

    <NewMenu v-if="newMenu" :x="newMenu.x" :y="newMenu.y" @close="newMenu = null" />

    <div v-if="dropOn" class="md-drop"><div class="md-drop-in"><Icon name="file-import" :size="30" /><span>导入</span></div></div>

    <WinStatusBar :n="N" :busy="st.busy || ''">
      <span v-if="hintText" class="lb-hint"><Icon name="alert-triangle" :size="12" /> <span>{{ hintText }}</span></span>
      <span v-if="cur.saveErr" class="lb-hint" :title="cur.saveErr"><Icon name="alert-triangle" :size="12" /> 未保存</span>
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 需在桌面客户端中运行</span>
    </WinStatusBar>
    <ConfirmDialog />
    <div v-if="alertMsg" class="lb-mask" @click.self="closeAlert">
      <div class="lb-dlg">
        <div class="lb-dlg-hd">提示</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">{{ alertMsg }}</div></div>
        <div class="lb-dlg-ft"><button class="lb-mini primary" @click="closeAlert">确定</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini / .lb-dlg…）在 styles/lbworkbench.css，此处只留本窗的变体 */
.lb-note { color: var(--ok); font-size: var(--fs-2); max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; padding: 10px 0; }

/* —— 本窗口专有 —— */
.md-side-bd { padding: 10px 10px 16px; display: flex; flex-direction: column; min-height: 0; }
/* 设计页 / 库页左栏：页眉（快速设置 | 组件、模型 | 组件）与滚动区由 DesignSide / LibTab 自己排 */
.md-side-bd.dsg { padding: 0; overflow: hidden; }
.md-stage { position: relative; overflow: hidden; }
.md-view { position: absolute; inset: 0; overflow: hidden; }
/* 视口上的 DOM 读数层：不挡鼠标（除了需要悬停看 title 的标题） */
.md-cap { position: absolute; left: 12px; top: 10px; max-width: calc(100% - 180px); pointer-events: none; }
.md-cap-t { font-size: var(--fs-5, 15px); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text); text-shadow: 0 0 6px var(--bg), 0 0 2px var(--bg); pointer-events: auto; width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-cap-s { margin-top: 2px; font-size: var(--fs-2); color: var(--text-muted); text-shadow: 0 0 5px var(--bg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-read { position: absolute; left: 12px; bottom: 9px; display: flex; align-items: baseline; gap: 5px; padding: 3px 8px; font-size: var(--fs-2); color: var(--text-muted);
  background: color-mix(in srgb, var(--bg) 78%, transparent); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: var(--r-box); pointer-events: none; }
.md-rv { color: var(--text); font-family: var(--font-mono); font-variant-numeric: tabular-nums; pointer-events: auto; }
.md-ru { color: var(--text-faint); }
.md-rs { color: var(--text-faint); }
.md-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text-faint); font-size: var(--fs-3); pointer-events: none; }
/* 装配页空文档：视口中心是本体原点（本体轴与落点网格从这里画起），空态文字放到原点上方，不压轴线 */
.md-load { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: var(--fs-3); color: var(--text-muted);
  background: color-mix(in srgb, var(--bg) 85%, transparent); border: 1px solid var(--border); border-radius: var(--r-card); font-variant-numeric: tabular-nums; pointer-events: none; }
.md-err { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 70%; display: flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: var(--fs-3); color: var(--danger);
  background: color-mix(in srgb, var(--bg) 88%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border)); border-radius: var(--r-card); }
.md-spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--text) 18%, transparent); border-top-color: var(--accent-ui); animation: ui-spin .7s linear infinite; flex: none; }
.md-stage.sun .md-cap-t { color: #e9edf3; text-shadow: 0 0 6px #000, 0 0 2px #000; }
.md-stage.sun .md-cap-s, .md-stage.sun .md-empty { color: #97a0ad; text-shadow: 0 0 4px #000; }
.md-stage.sun .md-read { color: #97a0ad; background: rgba(8, 10, 14, 0.72); border-color: rgba(255, 255, 255, 0.12); }
.md-stage.sun .md-rv { color: #e9edf3; }
.md-stage.sun .md-ru, .md-stage.sun .md-rs { color: #6d7684; }
/* 功能区「视图」组：叠加开关 3 × 2 小拨钮（开＝机位色描边 + 底色抬一档） */
.md-ovgrid { display: grid; grid-template-columns: repeat(3, auto); gap: 2px 3px; padding: 0 2px 0 6px; }
.md-tg { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 6px; font: inherit; font-size: var(--fs-2); line-height: 1; cursor: pointer; white-space: nowrap;
  color: var(--text-muted); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl); transition: var(--t-state); }
.md-tg:hover { color: var(--text); border-color: var(--border); background: var(--wash-hover); }
.md-tg.on { color: var(--text); background: var(--surface-2); border-color: var(--border-strong); box-shadow: inset 0 -2px 0 var(--accent-ui); transition-duration: 0s; }
.lbr-form select { min-width: 88px; }
.lbr-g[data-grp="view"].asm .lbr-form select { min-width: 78px; }
.lbr-form .lbu-seg > button { height: 20px; padding: 0 9px; }
/* 装配页：右侧 dock 列（结构树 + 属性），左缘拖宽 */
.asm-dockcol { flex: none; position: relative; min-width: 0; }
.asm-dockcol.resizing { user-select: none; }
.asm-dockcol-rz { position: absolute; top: 0; left: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.asm-dockcol-rz:hover, .asm-dockcol.resizing .asm-dockcol-rz { background: var(--accent); opacity: .35; }
/* 装配状态片：视口顶部居中，与读数同一种底（不挡鼠标；未保存那格悬停看原因） */
.asm-stchip { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; max-width: calc(100% - 360px); min-width: 0;
  padding: 3px 10px; font-size: var(--fs-2); color: var(--text-muted); pointer-events: none;
  background: color-mix(in srgb, var(--bg) 82%, transparent); border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); border-radius: var(--r-box); }
.asm-st { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.asm-st.snap { color: var(--accent-ui); }
.asm-st.warn { color: var(--warn); pointer-events: auto; }
.asm-st.clash, .asm-st.error { color: var(--danger); }
.md-stage.sun .asm-stchip { color: #97a0ad; background: rgba(8, 10, 14, 0.72); border-color: rgba(255, 255, 255, 0.12); }
/* 窄窗「⋯」溢出菜单：视图组 + 字号挪进来 */
.md-more { display: flex; flex-direction: column; gap: 8px; padding: 8px 10px; min-width: 300px; }
.md-more .lbr-form { padding: 0; gap: 4px; }
.md-more .md-ovgrid { padding: 0; }
.md-more-font :deep(.lbr-g) { padding: 0; }
.md-more-font :deep(.lbr-g::after) { display: none; }
.md-more-font :deep(.lbr-cap) { text-align: left; }
/* 整窗拖放 */
.md-drop { position: fixed; inset: 0; z-index: var(--z-pop); display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--accent-ui) 10%, transparent); pointer-events: none; }
.md-drop-in { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 22px 34px; color: var(--accent-ui); font-size: var(--fs-4); font-weight: 600;
  background: var(--bg); border: 2px dashed var(--accent-ui); border-radius: var(--r-float); box-shadow: var(--shadow-2); }
</style>
