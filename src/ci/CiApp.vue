<script setup>
// 干扰分析（C/I）主壳。方案见 docs/干扰分析模块调研.md。
//
// 布局：顶部功能条 + 单栏文档流。四种模式做页签而非并列铺开——同屏一个上下文，
// 别把四张不相干的表堆在一页。
//
// 曾有一条常驻左侧栏放「本站 / 本链路」，当作四种模式的公共上下文——已删。四种模式吃进去的
// 根本不是同一套：C/CCI 一个字段都不用（取值点自带经纬）、C/XPI 只用站址、NGSO 不吃期望星
// 轨位与发信链。常驻侧栏等于请人填一堆对当前页毫无作用的格子，还让人以为结果受它影响。
// 现在每页只摆本页真吃的量：C/ASI 与 NGSO 页首各一条「本站与本链路」输入带（逐项按模式开合），
// C/XPI 的站址就坐在「在本站取值」按钮旁边，C/CCI 什么都不需要。
//
// 本窗口是只读计算器：读三库与 GRD、不写回。算出的 C/I 要用到链路预算里由使用者自己搬。
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import { fmtGeoSlot } from '../shared/orbitClass.js'
import { inputText, parseInput, endFromHours, hoursFromEnd } from '../shared/timeWindowInput.js'
import { useInterference, toolContextState } from './useInterference.js'
import CiGeoPanel from './CiGeoPanel.vue'
import ExcelGrid from '../components/ExcelGrid.vue'
import { useCiGrid, headTip, SRC_COLS, EXPL_COLS, PEER_COLS, PT_COLS, NG_COLS } from './ciInputGrids.js'
import { CCI_SOURCES, SOURCE_NAME, TABLE_COLS, DEF_COLS, planCols, colorCols, segsText } from './cciScheme.js'
import LbSurfacePlot from '../components/LbSurfacePlot.vue'
import CiCdfPlot from './CiCdfPlot.vue'
import CiSeriesPlot from './CiSeriesPlot.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import { askConfirm } from '../shared/ui/useConfirm.js'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import { stableStringify } from '../shared/configDirty.js'
import { byLang } from '../shared/i18n/lang.js'
import { useNotice } from '../shared/useNotice.js'
import { reportError } from '../shared/reportError.js'
import { surfacePngDataUrl } from '../shared/surfacePng.js'

// 本窗口的失败出口（reportError / 全局异常都落到这里，常驻到点 ×）。msg 那一行照旧是各页的过程读数。
const N = useNotice()
const I = useInterference()
const {
  MODES, REUSE_COLORS, mode, busy, msg, site, carrier, asi, ap8, xpi, cci, ngso,
  satLib, grdAntennas, currentAntenna, ngsoGrdBeams, geoData, hoveredId, satSearch, ngsoGroups, groupStats, groupErrs, groupsErr,
  stale
} = I
// C/CCI 场图出图：与链路预算地理场图同一条路径（shared/surfacePng.js，纸色白底、4 倍）
const cciPlot = ref(null)
const cciExporting = ref(false)
async function exportCciField() {
  const exportFile = window.api && window.api.exportFile
  if (!exportFile || !cciPlot.value || cciExporting.value) return
  cciExporting.value = true
  try {
    const url = await surfacePngDataUrl(cciPlot.value, 4)
    if (!url) { N.toastError('导出失败'); return }
    const data = new Uint8Array(await (await fetch(url)).arrayBuffer())
    const r = await exportFile({ defaultName: 'C-CCI 覆盖场图.png', data, filters: [{ name: 'PNG 图片', extensions: ['png'] }] })
    if (r && r.ok) { const fp = r.path || (Array.isArray(r.paths) && r.paths[0]) || r.filePath || ''; N.toastFile('已导出：' + String(fp).split(/[\\/]/).pop(), fp) }
    else if (r && !r.canceled) N.toastError('导出失败：' + (r.error || ''))
  } catch (e) { N.toastError('导出失败：' + ((e && e.message) || e)) } finally { cciExporting.value = false }
}
// 「输入已变」灯的悬停口径（与雨衰页同一句）
const STALE_TIP = '计算输入已被修改，以下数值对应修改前的参数'

// —— 主窗口带上下文打开（地图右键 / 卫星信息栏「分析 ▸ 干扰分析」）——
// 一份配置 = 一座本站 + 一条本链路。带来的 GSO 星（期望星轨位与星名）/ 站（取第一个，站名与站址）与当前配置不同
// → 另建一份配置承接（当前配置的改动先落盘），原配置一个字都不动：平台约定带上下文只追加或新建、不改动现有配置
// （electron/ipc/register.js 的 tool:open）。从前是原地写：「北京 干扰分析」被改成上海、随自动命名改名并自动存盘。
// 新配置 = 当前内容 + 带来的星 / 站：干扰星表、天线、载波等系统参数照旧沿用（与原地写时看到的一样），名字随内容。
// 带来的与当前完全相同 → 不新建，只换到看得见它的页签。停在 C/CCI 页（不吃本站与本链路）时换到 C/ASI。
// 结果随换配置清空（applyState → I.clearResults）。开窗时配置未载入则排队，载入后按到达次序逐个处理。
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
async function applyToolContext(c) {
  const cur = serializeState()
  const hit = toolContextState(cur, c)               // 写进星 / 站之后的内容（纯函数，cur 不动）
  if (!hit) return
  if (fingerprintOf(hit.state) !== fingerprintOf(cur)) {
    const n = await createAndOpen({ state: hit.state, nameAuto: true })
    if (!n) return                                   // 当前配置写盘失败且用户选了不离开：什么都不动
  }
  if (mode.value === 'cci') mode.value = 'asi'
  msg.value = hit.parts.join(' · ')
}
const _stopCtx = (typeof window !== 'undefined' && window.api && window.api.tools) ? window.api.tools.onContext(onToolContext) : null
onBeforeUnmount(() => { if (_stopCtx) _stopCtx() })

// ─── 配置列表（2026-10-15 起，与链路预算四窗 / 雨衰 / 日凌同一套：配置树 + 自动保存 + 历史版本）───
// 配置内容 = 四页的全部入参（useInterference 的 snapshot）；当前页签只是视图态，不进指纹（切页签不写盘）。
// 旧版只有一份隐式面板态（localStorage ci/state）：首次打开且一份配置都没有时，把它存成第一份配置，旧数据不丢。
const winApi = (typeof window !== 'undefined' && window.api) || null
const ORBIT_TYPE = 'CI'
function serializeState() { return { orbitType: ORBIT_TYPE, ...I.snapshot() } }
function applyState(st) {
  // 换了一份内容（切换 / 新建 / 还原历史版本 / 带上下文另建）：
  //   · 五张输入表的撤销栈存的是上一份的行——不清的话一按 Ctrl+Z 就把上一份的整张表换进来、约 1 s 后自动写盘；
  //   · 结果、取过的派生量与在途计算都是上一份的（见 useInterference.clearResults）。
  for (const g of [srcGrid, explGrid, peerGrid, ptGrid, ngGrid]) g.clearHistory()
  for (const g of [cciPlanGrid, cciTableGrid, cciColorGrid, cciDefGrid]) g.clearHistory()   // C/CCI 复用方案四张表
  I.clearResults()
  I.applySnapshot(I.blankSnapshot())   // 先回出厂，再套这一份：缺字段的旧配置不沿用上一份的值
  I.applySnapshot(st)
  I.refreshGroupStats()                // 这一份引用的星座补载实参统计（含上次没载成的）
}
function blankState() { return { orbitType: ORBIT_TYPE, ...I.blankSnapshot() } }
function fingerprintOf(st) { const { mode: _m, ...rest } = st || {}; return stableStringify(rest) }
const MODE_NAME = { asi: 'C/ASI', ap8: '协调触发', xpi: 'C/XPI', cci: 'C/CCI', ngso: 'NGSO' }
// 自动名（名字随内容的配置用）：「<本站> 干扰分析」，按平台语言出字
function defaultCfgName() { const nm = String(site.name || '').trim(); return (nm ? nm + ' ' : '') + byLang('干扰分析', 'Interference') }
function cfgLabelOf(st) { const nm = String((st && st.site && st.site.name) || '').trim(); return [nm, MODE_NAME[st && st.mode] || ''].filter(Boolean).join(' · ') }
function setBaseline() { autosave.attach() }
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${cfgTree.activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}
const toast = (m) => N.toast(m)
const cfgTree = useConfigTree({
  ns: 'ci', orbitType: ORBIT_TYPE, api: winApi, storageKey: 'ci/cfgExpanded',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName,
  autosave: true, onNameAuto: (id) => { if (id === activeId.value) autosave.flush() }
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, ctxMenu,
  loadConfigs, uniqueCfgName, selectConfig, ensureActive, duplicateItem, createAndOpen,
  toggleFolder, expandAll, collapseAll,
  addFolder, addBlankConfig, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, onCfgKey
} = cfgTree
const autosave = useConfigAutosave({
  ns: 'ci', api: winApi, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'ci', api: winApi, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})
watch([site, carrier, asi, ap8, xpi, cci, ngso], () => autosave.touch(), { deep: true })
const LAST_KEY = 'ci/lastConfig'
watch(activeId, (id) => { try { localStorage.setItem(LAST_KEY, String(id || '')) } catch (e) { /* ignore */ } })

// 左侧栏：配置列表（可拖宽 / 可收起）
const SIDE_KEY = 'ci/sideView'
const sideView = ref((() => { try { const v = localStorage.getItem(SIDE_KEY); return (v === 'configs' || v === '') ? v : 'configs' } catch (e) { return 'configs' } })())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref((() => { try { const n = Number(localStorage.getItem('ci/configsWidth')); return Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number.isFinite(n) && n > 0 ? n : 220)) } catch (e) { return 220 } })())
const sideResizing = ref(false)
function startResize(e) {
  const startX = e.clientX, startW = configsWidth.value
  sideResizing.value = true; document.documentElement.classList.add('ui-col-resize')
  const move = (ev) => { configsWidth.value = Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, startW + ev.clientX - startX)) }
  const up = () => {
    sideResizing.value = false; document.documentElement.classList.remove('ui-col-resize')
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem('ci/configsWidth', String(configsWidth.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}
// Ctrl+Enter = 计算（全部计算窗同一个键）
function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.isComposing && !busy.value) { e.preventDefault(); run() }
}
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
// 窗口状态栏的进行中读数（中性色）：NGSO 扫描给出进度
const busyText = computed(() => {
  if (!busy.value) return ''
  if (mode.value === 'ngso' && ngso.progressTotal) return `计算中… ${ngso.progress}/${ngso.progressTotal}`
  if (mode.value === 'cci' && cci.progressTotal) return `计算中… ${Math.floor(cci.progress / cci.progressTotal * 100)}%`
  return '计算中…'
})

onMounted(async () => {
  I.load(); I.loadLibraries(); I.loadGrdTree(); I.loadNgsoGroups()
  await loadConfigs()
  if (winApi && !configs.value.some((c) => c.type !== 'folder')) {
    // 首次打开（一份配置都没有）：旧版那份隐式面板态存成第一份配置
    await createAndOpen({ state: serializeState(), nameAuto: true })
  } else {
    let last = null
    try { last = localStorage.getItem(LAST_KEY) || null } catch (e) { last = null }
    const curMode = mode.value
    await ensureActive(last)
    mode.value = curMode   // 页签是视图态：沿用上次看的那一页，不随配置跳
  }
  stopAutosaveListen = autosave.listen()
  window.addEventListener('keydown', onGlobalKey)
  // 面板里引用的星座补载实参统计：载入了配置的路径 applyState 已补过（在飞的复用），这里兜住没挂上配置的情形
  // （浏览器预览 / 配置载入失败时只有 I.load() 读回的面板态）
  I.refreshGroupStats()
  flushToolContext()   // 配置已载入：处理开窗时随窗带来的主窗口上下文
})

// C/XPI 各段的来源标签（source 由引擎 ciXpi.resolveXpd 给出，算式在 term.note 里，挂 title）
const XPI_SRC = {
  grd: 'GRD 实测', p618: 'P.618-14 §4.1', manual: '手填',
  axialRatio: '轴比换算', levels: '共/交实测', align: '对准误差'
}
const XPI_SEG = { satellite: '卫星天线', earthStation: '地球站天线', rain: '降雨去极化' }
// 某一段实际按什么来源进的合成；这一段没给（缺失）就是「—」，不写成「手填」
const xpiSrcOf = (key) => { const t = xpi.result && (xpi.result.terms || []).find((x) => x.key === key); return t ? (XPI_SRC[t.source] || '手填') : '—' }
// C/XPI 随时间百分比（引擎按 P.618-14 §4.1 逐档算雨致 XPD、其余两段不变）：交给 CDF 图画，横轴 XPI、纵轴 p%
const xpiCdf = computed(() => ((xpi.curve || []).filter((c) => Number.isFinite(Number(c.xpiDb))).map((c) => ({ pct: c.pct, ciDb: c.xpiDb }))))
const xpiCdfMark = computed(() => (xpi.rainInfo && xpi.result && Number.isFinite(Number(xpi.rainInfo.pPct)) ? { [xpi.rainInfo.pPct]: xpi.result.xpiDb } : null))

// ─── 地球站方向图（C/ASI）与协调触发（RR 附录 8）页的悬停口径与读数 ───
const ES_PATTERN_TIP = '收信站与上行对等站共用。ITU-R S.465-6：协调与干扰评估用参考方向图（缺省）；RR 附录 8 附件 3：附录 8 规定的地球站方向图；ITU-R S.580-6：新建天线的设计目标，D/λ < 50 不适用；旧版：AP8 分段 + S.580 旁瓣（平台 v1.5.3 及之前的包络），近旁瓣比附录 8 附件 3 低 3–9 dB'
const AP8_GEOM_TIP = '附件 1/2 公式：斜距 d = 42644·√(1 − 0.2954·cosψ)、拓扑角与自由空间损耗按 RR 附录 8 附件 1、2（与 BR GIBC 同口径）；WGS84：椭球站址与真实斜距'
const AP4_PE_TIP = '发端站天线输入端的最大功率密度（附录 4：15 GHz 以下取最坏 4 kHz、以上取最坏 1 MHz 平均）；留空按功放 − 馈损 − 10lg(占用带宽) 均匀折算'
const AP8_LINK_TIP = '附录 4 申报的两组传输增益 γ 与链路等效噪温 T（附录 8 §2.4 两组取大）；只给 γ 时 T = Te + γ·Ts；γ 都留空则上下行分别与 6% 比（§2.2.1.2）'
const EW_TOL_TIP = '东西位置保持容差；两星各向对方挪一个容差后计算拓扑角与地心角（附录 8 §2.1）'
const REGEN_TIP = '星上变调制：上下行分别与 6% 比（附录 8 §2.2.1.2 / §3.2）'
const patLabel = (p) => (p && p.name ? `${p.name}（${p.edition}）` : '—')
// 本网指配频段的缺省（载波中心 ± 占用带宽 / 2）只作占位显示；实际缺省由引擎按同一口径补
const phBand = (fc, side) => {
  const half = Number(carrier.bandwidthHz) > 0 ? Number(carrier.bandwidthHz) / 2e9 : 0
  const v = Number(fc) + side * half
  return Number.isFinite(v) ? v.toFixed(4) : ''
}
const ap8MethodTip = (d) => (d && d.method === 'combined'
  ? '附录 8 式(3)：ΔT/T = (γ·ΔTs + ΔTe) / T，两组 (T, γ) 取大'
  : '附录 8 §2.2.1.2 / §3.2：ΔTs/Ts 与 ΔTe/Te 分别与 6% 比，取大')
const ap8ArcTip = computed(() => {
  const r = ap8.result
  if (!r) return ''
  const seg = { up: '上行', dn: '下行' }
  return r.arc.bands.map((b) => `${seg[b.key]} ${b.overlapMHz > 0 ? `${f(b.loGHz, 4)}–${f(b.hiGHz, 4)} GHz：${b.arcDeg == null ? '第 9) 项' : `第 ${b.item} 项 ±${b.arcDeg}°`}` : '无重叠'}`).join('；')
})
// 明细表：行 = 量，列 = 两个方向（本网 → 邻网 / 邻网 → 本网）。段名行只占位。超 6% 的百分数只着色
const PE_SRC = { ap4: '附录 4 最大功率密度', carrier: '按功放 − 馈损 − 10lg(占用带宽) 均匀折算' }
const EIRP_SRC = { given: '给定', carrier: '按载波 EIRP − 10lg(占用带宽)' }
const ap8Rows = computed(() => {
  const r = ap8.result
  if (!r) return []
  const D = [r.ownToOther, r.otherToOwn]
  const rows = []
  const grp = (label) => rows.push({ grp: true, label })
  const row = (label, unit, get, n, opt) => {
    const o = opt || {}
    rows.push({
      label, unit, strong: !!o.strong,
      cells: D.map((d) => {
        const v = get(d)
        return { text: f(v, n), bad: !!o.pct && Number.isFinite(Number(v)) && Number(v) > r.thresholdPct, title: o.title ? o.title(d) : null }
      })
    })
  }
  const any = (fn) => D.some(fn)
  const U = (d) => d.up || {}, Dn = (d) => d.dn || {}, C2 = (d) => d.caseII || {}
  if (any((d) => d.up)) {
    grp('Case I 上行 · ΔTs')
    row('频谱重叠', 'MHz', (d) => U(d).overlapMHz, 3)
    row('计算频率', 'GHz', (d) => U(d).fGHz, 4)
    row('发端站拓扑角 θt', '°', (d) => U(d).thetaTDeg, 3)
    row('发端功率密度 pe', 'dB(W/Hz)', (d) => U(d).peDbWPerHz, 2, { title: (d) => PE_SRC[U(d).peSource] || null })
    row('发端站旁瓣增益 g1(θt)', 'dBi', (d) => U(d).g1Dbi, 2)
    row('上行自由空间损耗 lu', 'dB', (d) => U(d).luDb, 2)
    row('受扰卫星接收增益 g2', 'dBi', (d) => U(d).g2Dbi, 2)
    row('ΔTs', 'K', (d) => U(d).deltaTsK, 3)
    row('受扰卫星噪温 Ts', 'K', (d) => U(d).tsK, 1)
    row('ΔTs/Ts（上行分量）', '%', (d) => d.independent.dTsOverTsPct, 3, { pct: true, strong: true })
  }
  if (any((d) => d.dn)) {
    grp('Case I 下行 · ΔTe')
    row('频谱重叠', 'MHz', (d) => Dn(d).overlapMHz, 3)
    row('计算频率', 'GHz', (d) => Dn(d).fGHz, 4)
    row('收端站拓扑角 θt', '°', (d) => Dn(d).thetaTDeg, 3)
    row('施扰卫星 EIRP 密度', 'dB(W/Hz)', (d) => Dn(d).satEirpDbWPerHz, 2, { title: (d) => EIRP_SRC[Dn(d).satEirpSource] || null })
    row('收端站旁瓣增益 g4(θt)', 'dBi', (d) => Dn(d).g4Dbi, 2)
    row('下行自由空间损耗 ld', 'dB', (d) => Dn(d).ldDb, 2)
    row('ΔTe', 'K', (d) => Dn(d).deltaTeK, 3)
    row('受扰收端站噪温 Te', 'K', (d) => Dn(d).teK, 1)
    row('ΔTe/Te（下行分量）', '%', (d) => d.independent.dTeOverTePct, 3, { pct: true, strong: true })
  }
  if (r.ownToOther.polarizationApplied) {
    grp('极化隔离 §2.2.3')
    row('Yu', '', (d) => d.yu, 2)
    row('Yd', '', (d) => d.yd, 2)
  }
  const nL = Math.max(0, ...D.map((d) => d.links.length))
  if (nL) {
    grp('ΔT/T = (γ·ΔTs + ΔTe) / T')
    const SUB = ['₁', '₂']
    for (let k = 0; k < nL; k++) {
      const L = (d) => d.links[k] || {}
      row('γ' + SUB[k], 'dB', (d) => L(d).gammaDb, 2)
      row('T' + SUB[k], 'K', (d) => L(d).noiseTempK, 1, { title: (d) => (L(d).tDerived ? 'T = Te + γ·Ts' : null) })
      row('ΔT' + SUB[k], 'K', (d) => L(d).deltaTK, 3)
      row('ΔT' + SUB[k] + '/T' + SUB[k], '%', (d) => L(d).pct, 3, { pct: true })
    }
    row('ΔT/T 取大', '%', (d) => d.combinedPct, 3, { pct: true, strong: true })
  }
  if (any((d) => d.caseII)) {
    grp('Case II 反向频段 · ΔTs')
    row('频谱重叠', 'MHz', (d) => C2(d).overlapMHz, 3)
    row('星间距离', 'km', (d) => C2(d).interSatKm, 1)
    row('星间损耗 ls', 'dB', (d) => C2(d).lsDb, 2)
    row('施扰卫星 EIRP 密度（朝受扰卫星）', 'dB(W/Hz)', (d) => C2(d).satEirpToSatDbWPerHz, 2)
    row('受扰卫星接收增益（朝施扰卫星）', 'dBi', (d) => C2(d).g2ToSatDbi, 2)
    row('ΔTs', 'K', (d) => C2(d).deltaTsK, 3)
    row('ΔTs/Ts', '%', (d) => C2(d).dTsOverTsPct, 3, { pct: true })
    if (any((d) => d.caseII && d.caseII.links.length)) row('ΔT/T 取大', '%', (d) => C2(d).combinedPct, 3, { pct: true, strong: true })
  }
  if (any((d) => d.esToEsOverlapMHz > 0)) row('地对地反向频谱重叠', 'MHz', (d) => d.esToEsOverlapMHz, 3)
  return rows
})

const f = (v, n = 2) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(n))
// 页首输入带的一行摘要：站名在这里才有落点（它不进任何算式，是给人认站用的）
const siteSummary = computed(() =>
  `${site.name || '本站'} · ${f(site.lon, 4)}°E ${f(site.lat, 4)}°N · 收 Ø${f(site.rxDiameterM, 1)} m @ ${f(site.rxFreqGHz, 2)} GHz`)
const fPct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v) >= 1 ? Number(v).toFixed(2) + '%' : Number(v).toFixed(3) + '%')
// 结果逐源明细里跟在干扰星名后的轨位标记：°E/°W 折算显示（「干扰星」表那一列仍按带符号 °E 录入，西经为负）
// —— 星名认人、轨位认星，两者挨着才看得出「哪颗星、离本星多远」。
const fSlot = (v) => (v == null || !Number.isFinite(Number(v)) ? '' : fmtGeoSlot(Number(v)))
// 上行逐源明细「极化 dB」格的悬停：这一源按哪个上行极化算的；干扰星表里上行极化留空、由下行关系推定的标出来
// （线/圆混用推不出具体字母，只标关系）。整串由词典 `${a} · ${b}` 组合模式逐段翻译
const upPolTip = (s) => {
  const p = s && (s.polarization || (s.polRelation === 'mixed' ? '线/圆混用' : ''))
  if (!p) return null
  return s.polInferred ? `${p} · 按下行关系推定` : p
}
const fDur = (s) => (s == null ? '—' : s < 60 ? s.toFixed(2) + ' s' : (s / 60).toFixed(2) + ' min')
const fTime = (ms) => { try { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z' } catch (e) { return '—' } }

// ─── NGSO 时段：起止时刻（UTC，与结果里的时刻同一口径）。结束时刻 ⇄ 时窗：改结束＝改时窗，改起始时窗不变 ───
// 读写与年份判据（半截年份 0002 不认）见 shared/timeWindowInput.js
const ngsoT0 = () => { const t = Date.parse(ngso.startIso || ''); return Number.isFinite(t) ? t : NaN }
const ngsoStartText = computed(() => inputText(ngsoT0(), 'utc'))
const ngsoEndText = computed(() => inputText(endFromHours(ngsoT0(), ngso.horizonH), 'utc'))
function setNgsoStart(v) { const t = parseInput(v, 'utc'); if (Number.isFinite(t)) ngso.startIso = new Date(t).toISOString() }
function setNgsoEnd(v) { const h = hoursFromEnd(ngsoT0(), parseInput(v, 'utc')); if (Number.isFinite(h)) ngso.horizonH = +h.toFixed(6) }

// ─── NGSO 分位数的样本支撑度（引擎的 percentileSupport）─────────────────────────
// 「样本不足」必须显示成「样本不足」，不能显示成一个看着完全正常的数字：
// 6 h / 10 s = 2161 个样本时，C/I(0.001%) 那一档对应 0.022 个样本——它就是最小值，
// 只是贴了个百分比标签，与 worst 差 0.003 dB。
const ngSup = (p) => {
  const r = ngso.result
  return (r && r.percentileSupport && r.percentileSupport[p]) || null
}
const ngSupTip = (p) => {
  const s = ngSup(p)
  if (!s) return ''
  if (!s.enough) return `样本不足：该档需 ≥ ${s.needSamples.toLocaleString('en-US')} 个样本，当前 ${(ngso.result.samples || 0).toLocaleString('en-US')} 个，有效样本 ${s.nEff.toExponential(2)} 个。延长时窗或减小步长后重算`
  if (s.weak) return `有效样本 ${s.nEff.toFixed(2)} 个，尾部估计不稳定`
  return `有效样本 ${s.nEff.toFixed(1)} 个`
}
// CDF 分位表的行：按数值升序（对象遍历会把整数键排在小数键前，1 → 5 → … → 0.001）。键保持原串，查 support / ci 时不变
const ngPctRows = computed(() => {
  const p = ngso.result && ngso.result.percentiles
  if (!p) return []
  return Object.keys(p).filter((k) => Number.isFinite(Number(k))).sort((a, b) => Number(a) - Number(b)).map((k) => [k, p[k]])
})
// 一年折合分钟数：p% 的时间 = 一年里多少分钟
const fYearMin = (p) => (Number(p) / 100 * 525600)
// 多历元的 bootstrap 95% 区间（只有多历元才有：单历元长跑的样本时间上高度相关，
// 对它做 bootstrap 会把区间报得比真实窄得多）
const ngCi = (p) => {
  const e = ngso.result && ngso.result.epochStats
  return (e && e.ciP && e.ciP[p]) || null
}
// 区间按【历元整块】重采样得出（逐样本 i.i.d. 会把区间窄一个数量级）。块数不足时区间宽度
// 主要反映块组合的种数而非真实不确定度，此时必须让用户改看逐历元的原始估值散布。
const ngCiLowRes = computed(() => {
  const e = ngso.result && ngso.result.epochStats
  if (!e || !e.ciP) return false
  return Object.values(e.ciP).some((c) => c && c.lowResolution)
})
const ngPerEpoch = computed(() => {
  const e = ngso.result && ngso.result.epochStats
  return ((e && e.perEpoch) || []).filter((v) => v != null && Number.isFinite(v)).map((v) => v.toFixed(2))
})

// 模板里的 @click 只能写表达式，写不了 if 语句——这类分支一律落到这里
function toggleSearch() {
  satSearch.open = !satSearch.open
  if (satSearch.open && !satSearch.hits.length) I.searchNeighbors()
}

// 星座下拉按来源分段（口径见 useInterference 的 loadNgsoGroups）：自己建的东西排在前面，
// 编目星座十几个排最后——找自己的东西不该先滚过一整屏 CelesTrak 组名。
//
// ⚠️ 空的段**不删掉**，留一条灰的空项。曾经是「items 为空就 filter 掉」，于是一个字都不留：
// 用户在星座页建了自定义星座、回到这里发现下拉里根本没有「自定义」这一段，只能得出「选不了」，
// 也看不出是没建还是坏了。四段永远在，缺什么一目了然。
// 空项只写一句陈述「无」——各段从哪儿来（星座页存组 / Walker 生成器 / 文件管理导入 / 联网取 CelesTrak）
// 曾写成操作教学挂在这一项上，按 CLAUDE.md 删掉（v1.5.0 上线前排查 #51）。
const SECTIONS = [
  { kind: 'satgroup', label: '卫星组', empty: '无' },
  { kind: 'ccustom', label: '自定义星座', empty: '无' },
  { kind: 'custom', label: '自定义星历', empty: '无' },
  { kind: 'omm', label: '编目星座', empty: '无' }
]
const groupSections = computed(() =>
  SECTIONS.map((s) => ({ ...s, items: ngsoGroups.value.filter((g) => (g.kind || 'omm') === s.kind) })))

// ─── 输入网格（ExcelGrid）：列定义与写值口径见 ciInputGrids.js；行对象形状不变 ───
const enabledSources = () => asi.sources.filter((x) => x.enabled)
const srcGrid = useCiGrid({ gridId: 'ci-src', list: () => asi.sources, cols: SRC_COLS, add: (at) => I.addSource(at), remove: (id) => I.removeSource(id) })
// 上行两张：行 = 已启用的干扰星（派生），不增删行；撤销快照取整张干扰星表
const explGrid = useCiGrid({ gridId: 'ci-expl', list: enabledSources, base: () => asi.sources, cols: EXPL_COLS })
const peerGrid = useCiGrid({ gridId: 'ci-peer', list: enabledSources, base: () => asi.sources, cols: PEER_COLS })
const ptGrid = useCiGrid({ gridId: 'ci-pts', list: () => cci.points, cols: PT_COLS, add: (at) => I.addCciPoint(at), remove: (id) => I.removeCciPoint(id) })
// ─── C/CCI 复用方案：行 = 方向图的存活波束（计划映射 / 逐波束表 / 色号三种摆法，按当前着色来源出一张）+ 色号定义 ───
const cciRowsList = () => I.cciRows.value
const CCI_PLAN_COLS = planCols({
  options: () => I.cciPlanOpts.value.map((x) => ({ value: x.value })),
  planText: (o) => I.cciPlanText(o),
  planParse: (v) => I.cciPlanParse(v),
  occText: (o, d) => I.cciOccText(o, d)
})
const CCI_COLOR_COLS = colorCols({ colorText: (o) => I.cciColorText(o) })
const cciPlanGrid = useCiGrid({ gridId: 'ci-cci-plan', list: cciRowsList, cols: CCI_PLAN_COLS })
const cciTableGrid = useCiGrid({ gridId: 'ci-cci-tab', list: cciRowsList, cols: TABLE_COLS })
const cciColorGrid = useCiGrid({ gridId: 'ci-cci-col', list: cciRowsList, cols: CCI_COLOR_COLS, editable: (o, c) => c.key !== 'mColor' || I.cciEffSource.value === 'manual' })
const cciDefGrid = useCiGrid({ gridId: 'ci-cci-def', list: () => cci.colorDefs, cols: DEF_COLS, add: (at) => I.addColorDef(at), remove: (id) => I.removeColorDef(id) })
// 自动匹配出来的计划波束、非手工来源的色号：读数压暗（手工指定的照常色）
const cciPlanCellClass = (r, c) => (c.editable === false || (c.key === 'plan' && !r.o.plan) ? 'ci-ro' : null)
const cciColorCellClass = (r, c) => (c.editable === false || (c.key === 'mColor' && I.cciEffSource.value !== 'manual') ? 'ci-ro' : null)
const cciBand = computed(() => (cci.dir === 'rtn' ? cci.bandR : cci.bandF))
const cciMatched = computed(() => { const m = I.cciMatch.value; return m ? m.map.size : 0 })
const cciShowColorDefs = computed(() => ['synth', 'manual', 'rotation'].includes(I.cciEffSource.value))
const cciFmt = (v) => (v === Infinity ? '∞' : f(v))
// 来源读数：「频率计划「中星26 前向」」「轮转 4 色」
const cciSrcText = (s) => (s ? (SOURCE_NAME[s.source] || '') + (s.source === 'freqPlan' && s.label ? `「${s.label}」` : '') + (s.source === 'rotation' ? ` ${s.colors} 色` : '') : '')
const CCI_NUM_SRC = new Set(['synth', 'manual', 'rotation'])
const cciReuseOf = (b, src) => (b.segs && b.segs.length ? segsText(b.segs) : (b.color == null ? '—' : (CCI_NUM_SRC.has(src) && /^\d+$/.test(String(b.color)) ? 'F' + (Number(b.color) + 1) : String(b.color))))
const cciPtsLine = computed(() => {
  const s = cci.result && cci.result.summary
  if (!s) return ''
  const parts = [`共 ${(s.beamIdx || []).length} 个存活波束`, '着色来源：' + cciSrcText(s)]
  if (s.floorPts) parts.push(`窗外计入 ${s.floorPts} 点`)
  if (s.unassigned) parts.push(`未指派 ${s.unassigned} 个波束`)
  return parts.join(' · ')
})
const cciFieldLine = computed(() => {
  const s = cci.stats
  if (!s) return ''
  const g = s.grid || {}
  const parts = ['着色来源：' + cciSrcText(s), (g.kind === 'user' ? '经纬网格 ' : '天线网格 ') + `${g.nx}×${g.ny}`, `有值 ${(s.valid || 0).toLocaleString('en-US')} 点`]
  if (s.floorPts) parts.push(`窗外计入 ${s.floorPts.toLocaleString('en-US')} 点`)
  if (s.unassigned) parts.push(`未指派 ${s.unassigned} 个波束`)
  if (s.dir === 'rtn' && s.trials) parts.push(`蒙特卡洛 ${s.trials} 次 · 种子 ${s.seed}`)
  parts.push(`${(s.elapsedMs / 1000).toFixed(2)} s`)
  return parts.join(' · ')
})
const cciBeamRows = computed(() => ((cci.stats && cci.stats.beams) || []).filter((b) => b.assigned))
const { cciRows, cciEffSource, cciPlanList, cciPlanAutoId } = I
const cciShowPlan = computed(() => cci.source === 'freqPlan' || (cci.source === 'auto' && cciPlanList.value.length > 0))
const cciPlanReading = computed(() => (I.cciPlan.value ? `已匹配 ${cciMatched.value} / ${cciRows.value.length} 个波束` : ''))
// NGSO 干扰星座：星历行的「名称 / 星座」显示所选星座、轨道五列显示星历实参（只读）；Walker 行照常可编辑
const groupLabel = (key) => { const x = ngsoGroups.value.find((gr) => gr.key === key); return x ? x.label : key }
// 没有统计时分两种：在载（加载中…）与载不成（载入失败：原因）——后者从前也显示「加载中…」，一直停在那里
const ngStatText = (o) => {
  const st = groupStats.value[o.group]
  if (st) return `${st.count} 颗 · ${st.altKmMed} km · ${st.inclMin}–${st.inclMax}° · ${st.periodMin} min`
  if (!o.group) return ''
  const err = groupErrs.value[o.group]
  return err ? '载入失败：' + err : '加载中…'
}
function ngText(o, c) {
  if (o.source === 'walker' || !(c.orbit || c.key === 'name')) return c.get(o)
  if (c.key === 'name') return o.group ? groupLabel(o.group) : '—'
  const st = groupStats.value[o.group]
  if (!st) return ''
  if (c.key === 'altKm') return String(st.altKmMed)
  if (c.key === 'incl') return st.inclMin === st.inclMax ? String(st.inclMin) : `${st.inclMin}–${st.inclMax}`
  return ''
}
const ngGrid = useCiGrid({
  gridId: 'ci-ngso', list: () => ngso.interferers, cols: NG_COLS, text: ngText,
  editable: (o, c) => o.source === 'walker' || !(c.orbit || c.key === 'name'),
  add: (at) => I.addNgsoGroup(at), remove: (id) => I.removeNgsoGroup(id)
})
// 星历行的星座选择（带分组的动态下拉，不进网格）：改活动格所在行；没有活动格时改第一条星历行
const ngPickRow = computed(() => {
  const a = ngGrid.activeRow.value
  if (a) return a.source === 'walker' ? null : a
  return ngso.interferers.find((x) => x.source !== 'walker') || null
})
const ngPickNo = computed(() => ngso.interferers.indexOf(ngPickRow.value) + 1)
// 网格的行样式 / 悬停读数（行 = { id, o }）
const offRow = (r) => (r.o.enabled === false ? 'off' : null)
const isBlank = (v) => v == null || v === ''
function cellTipOf(r, c) {
  if (c.blankTip && isBlank(r.o[c.key])) return c.blankTip
  return c.num ? null : String(c.get(r.o) || '') || null
}
function ngCellTip(r, c) {
  if (r.o.source !== 'walker' && (c.orbit || c.key === 'name')) return ngStatText(r.o) || null
  return cellTipOf(r, c)
}
const ngCellClass = (r, c) => (r.o.source !== 'walker' && (c.orbit || c.key === 'name') ? 'ci-ro' : null)
const roCellClass = (r, c) => (c.editable === false ? 'ci-ro' : null)

// 切页签时清掉上一页留下的过程读数（如 NGSO「计算量过大」）——那一行只对它那页成立。
// 有作业在跑时不清：那行是作业状态（扫描进度等），下一拍还会被刷新。
// 不用 watch(mode)：applyToolContext 先改 mode 再写 msg，pre 刷新的 watcher 会把刚写的那句清掉。
function setMode(k) {
  if (mode.value === k) return
  mode.value = k
  if (!busy.value) msg.value = ''
}

const run = () => {
  if (mode.value === 'asi') I.computeAsi()
  else if (mode.value === 'ap8') I.computeAp8()
  else if (mode.value === 'xpi') I.computeXpi()
  else if (mode.value === 'cci') I.computeCci()
  else I.computeNgso()
}
</script>

<template>
  <div class="lb-shell ci-root">
    <ActivationLock />
    <!-- 配置右键菜单（各工作台共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!winApi" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
    />
    <div class="lb-body">
    <aside v-show="sideView === 'configs'" class="lb-col lb-side lb-configs" :class="{ resizing: sideResizing }" :style="{ width: configsWidth + 'px' }">
      <div class="lb-col-hd">
        <span class="lb-cfg-hd-t">配置列表</span>
        <span class="lb-cfg-acts">
          <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!winApi" @click="addFolder(null)"><Icon name="folder-plus" :size="12" /></button>
          <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!winApi" @click="addBlankConfig(null)"><Icon name="plus" :size="12" /></button>
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
      <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResize($event)"></div>
    </aside>
    <section class="lb-col lb-build">
    <!-- ── 功能区 ── -->
    <div class="lbr">
      <div class="lbr-g">
        <div class="lbr-items">
          <button class="lbr-big primary" :disabled="busy" title="计算当前页（Ctrl+Enter）" @click="run">
            <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
            {{ busy ? '计算中…' : '计算' }}
          </button>
        </div>
        <div class="lbr-cap">计算</div>
      </div>
      <div class="lbr-g">
        <div class="lbr-items">
          <button class="lbr-big" :disabled="!winApi || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
          <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
          <button class="lbr-big" :class="{ on: sideView === 'configs' }" :aria-pressed="(sideView === 'configs') ? 'true' : 'false'" title="左侧栏显示「配置列表」" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
        </div>
        <div class="lbr-cap">文件</div>
      </div>
    </div>
    <nav class="lbx-tabs" role="tablist" aria-label="分析类型">
      <button
        v-for="m in MODES" :key="m.key" type="button" role="tab" :aria-selected="mode === m.key"
        class="lbx-tab" :class="{ on: mode === m.key }" :title="m.tip"
        @click="setMode(m.key)">{{ m.label }}</button>
    </nav>

    <main class="ci-main">
      <!-- ── 本站与本链路 ──
           只在真吃这些量的两页出现，且逐项按模式开合（见文件头：为什么不再做常驻侧栏）。
           C/XPI 只用站址，那两格坐在它自己的取值按钮旁；C/CCI 一格都不需要。 -->
      <section v-if="mode === 'asi' || mode === 'ap8' || mode === 'ngso'" class="ci-panel">
        <div class="ci-panel-hd">
          <h2>本站与本链路</h2>
          <span class="ci-hd-sum">{{ siteSummary }}</span>
        </div>
        <div class="ci-band">
          <div class="ci-bcol">
            <h3>本站</h3>
            <div class="srow"><label>站名</label><input v-model="site.name" class="ci" type="text" /><span class="u"></span></div>
            <div class="srow"><label>经度</label><input v-model.number="site.lon" class="ci" type="number" step="0.0001" /><span class="u">°E</span></div>
            <div class="srow"><label>纬度</label><input v-model.number="site.lat" class="ci" type="number" step="0.0001" /><span class="u">°N</span></div>
            <div class="srow"><label>海拔</label><input v-model.number="site.alt" class="ci" type="number" /><span class="u">m</span></div>
          </div>

          <div class="ci-bcol">
            <h3>收信链（下行）</h3>
            <div class="srow"><label>口径</label><input v-model.number="site.rxDiameterM" class="ci" type="number" step="0.1" /><span class="u">m</span></div>
            <div class="srow"><label>效率</label><input v-model.number="site.rxEfficiency" class="ci" type="number" /><span class="u">%</span></div>
            <div class="srow"><label>频率</label><input v-model.number="site.rxFreqGHz" class="ci" type="number" step="0.01" /><span class="u">GHz</span></div>
          </div>

          <div v-if="mode === 'asi' || mode === 'ap8'" class="ci-bcol">
            <h3>发信链（上行）</h3>
            <div class="srow"><label>口径</label><input v-model.number="site.txDiameterM" class="ci" type="number" step="0.1" /><span class="u">m</span></div>
            <div class="srow"><label>效率</label><input v-model.number="site.txEfficiency" class="ci" type="number" /><span class="u">%</span></div>
            <div class="srow"><label>频率</label><input v-model.number="site.txFreqGHz" class="ci" type="number" step="0.01" /><span class="u">GHz</span></div>
            <div class="srow"><label>功放</label><input v-model.number="site.txPowerW" class="ci" type="number" /><span class="u">W</span></div>
            <div class="srow"><label>馈损</label><input v-model.number="site.txFeederLossDb" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
          </div>

          <div class="ci-bcol">
            <h3>本链路载波</h3>
            <div v-if="mode === 'asi' || mode === 'ap8'" class="srow"><label>卫星轨位</label><input v-model.number="carrier.satLonDeg" class="ci" type="number" step="0.1" /><span class="u">°E</span></div>
            <div class="srow"><label>EIRP</label><input v-model.number="carrier.eirpDbW" class="ci" type="number" step="0.1" /><span class="u">dBW</span></div>
            <div class="srow"><label>占用带宽</label><input v-model.number="carrier.bandwidthHz" class="ci" type="number" /><span class="u">Hz</span></div>
            <div class="srow"><label>下行极化</label>
              <select v-model="carrier.dnPolarization" class="ci"><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
            </div>
            <div v-if="mode === 'asi' || mode === 'ap8'" class="srow"><label>上行极化</label>
              <select v-model="carrier.upPolarization" class="ci"><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ C/ASI ============ -->
      <template v-if="mode === 'asi'">
        <section class="ci-panel">
          <div class="ci-panel-hd">
            <h2>干扰星</h2>
            <div class="ci-hd-tools">
              <label class="ci-chk" :title="ES_PATTERN_TIP">地球站方向图
                <select v-model="asi.esPattern" class="ci-mini">
                  <option value="S.465-6">ITU-R S.465-6</option>
                  <option value="RR-AP8-A3">RR 附录 8 附件 3</option>
                  <option value="S.580-6">ITU-R S.580-6（设计目标）</option>
                  <option value="S580-HYB">AP8 分段 + S.580 旁瓣（旧版）</option>
                </select>
              </label>
              <label class="ci-chk"><input v-model="asi.applyPolarization" type="checkbox" />计入极化折减</label>
              <select v-if="satLib.length" class="ci-mini cmd-sel" @change="I.addFromLibrary(satLib[$event.target.value]); $event.target.value = ''">
                <option value="">从卫星库导入…</option>
                <option v-for="(s, i) in satLib" :key="s.ns + s.id" :value="i">{{ s.name }}（{{ s.ns }}）</option>
              </select>
              <button class="ci-btn" :class="{ on: satSearch.open }" :aria-pressed="satSearch.open ? 'true' : 'false'" @click="toggleSearch">搜索邻星…</button>
            </div>
          </div>
          <!-- 邻星搜索：直接用软件里的 GEO 星历，按与本星轨位的经度差排序 -->
          <div v-if="satSearch.open" class="ci-search">
            <div class="ci-search-hd">
              <input v-model="satSearch.q" class="search-field" type="text" placeholder="按星名过滤（留空 = 全部）" @keyup.enter="I.searchNeighbors()" />
              <label>范围 ±<input v-model.number="satSearch.spanDeg" type="number" step="1" style="width:56px" />°</label>
              <button class="ci-btn" :disabled="satSearch.busy" @click="I.searchNeighbors()">{{ satSearch.busy ? '搜索中…' : '搜索' }}</button>
              <span class="ci-search-msg">{{ satSearch.msg }}</span>
            </div>
            <div v-if="satSearch.hits.length" class="ci-search-list">
              <button
                v-for="h in satSearch.hits" :key="h.name"
                class="ci-hit" :title="h.inclined ? `星下点纬度 ${h.latDeg}° —— 有倾角残余，按赤道面近似会有偏差` : ''"
                @click="I.addNeighbor(h)">
                <b data-i18n-skip>{{ h.name }}</b>
                <span class="lon">{{ fmtGeoSlot(Number(h.lonDeg)) || h.lonDeg + '°E' }}</span>
                <span class="dl">Δ{{ h.dLon }}°</span>
                <span v-if="h.inclined" class="incl">倾</span>
              </button>
            </div>
          </div>

          <ExcelGrid class="ci-eg" :grid="srcGrid.g" :cols="SRC_COLS" :text="srcGrid.textOf" :row-class="offRow" :cell-tip="cellTipOf" :head-tip="headTip"
                     empty-text="暂无干扰星。" add-label="添加干扰星" del-label="删除所选行" @add="srcGrid.append()" />

          <div class="ci-sub">
            <h3>上行干扰源模型</h3>
            <div class="ci-radios">
              <label><input v-model="asi.uplinkMode" type="radio" value="peer" />对等站（工程估算）</label>
              <label><input v-model="asi.uplinkMode" type="radio" value="mask" />S.524 掩模（监管上界）</label>
              <label><input v-model="asi.uplinkMode" type="radio" value="explicit" />逐站给定</label>
            </div>
            <!-- 逐站给定：首版漏了这张表，导致该模式每条都因缺值被跳过、算不出数 -->
            <ExcelGrid v-if="asi.uplinkMode === 'explicit'" class="ci-eg" :grid="explGrid.g" :cols="EXPL_COLS" :text="explGrid.textOf"
                       :cell-class="roCellClass" :cell-tip="cellTipOf" :head-tip="headTip" empty-text="暂无已启用的干扰星。" />
            <ExcelGrid v-if="asi.uplinkMode === 'peer'" class="ci-eg" :grid="peerGrid.g" :cols="PEER_COLS" :text="peerGrid.textOf"
                       :cell-class="roCellClass" :cell-tip="cellTipOf" :head-tip="headTip" empty-text="暂无已启用的干扰星。" />
          </div>
        </section>

        <section v-if="asi.result" class="ci-panel">
          <h2>结果<span v-if="stale.asi" class="ci-stale" :title="STALE_TIP">输入已变</span></h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>下行 C/ASI</span><b>{{ f(asi.result.downlink && asi.result.downlink.ciDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>上行 C/ASI</span><b>{{ f(asi.result.uplink && asi.result.uplink.ciDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>收信站峰值增益</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.peakGainDbi) }}</b><i>dBi</i></div>
            <div class="ci-kpi"><span>主瓣宽度</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.beamwidth3dBDeg, 3) }}</b><i>°</i></div>
            <div class="ci-kpi"><span>期望星仰角</span><b>{{ f(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.wantedElevDeg, 1) }}</b><i>°</i></div>
            <div class="ci-kpi" :title="ES_PATTERN_TIP"><span>地球站方向图</span><b class="sm">{{ patLabel(asi.result.downlink && asi.result.downlink.geometry && asi.result.downlink.geometry.esPattern) }}</b></div>
          </div>

          <div class="ci-split">
            <div class="ci-split-l">
              <h3>下行逐源明细</h3>
              <table class="ci-tb res">
                <thead><tr><th>干扰星</th><th class="n">拓扑角 °</th><th class="n">经度差 °</th><th class="n">G(θ) dBi</th><th class="n">鉴别度 dB</th><th class="n">极化 dB</th><th class="n">C/I dB</th><th class="n">占比</th></tr></thead>
                <tbody>
                  <tr
                    v-for="s in (asi.result.downlink && asi.result.downlink.sources) || []" :key="s.id"
                    :class="{ hot: hoveredId === s.id, skip: s.skipped }"
                    @mouseenter="I.setHover(s.id)" @mouseleave="I.setHover('')">
                    <td>{{ s.name }}<span v-if="fSlot(s.lonDeg)" class="ci-slot" title="干扰星轨位（°E/°W）">{{ fSlot(s.lonDeg) }}</span></td>
                    <td class="num">{{ f(s.thetaDeg) }}</td>
                    <td class="dim num">{{ f(s.lonDiffDeg) }}</td>
                    <td class="num">{{ f(s.offAxisGainDbi) }}</td>
                    <td class="num">{{ f(s.discrimDb) }}</td>
                    <td class="num">{{ f(s.polDb, 1) }}</td>
                    <td class="num">{{ s.skipped ? '—' : f(s.ciDb) }}</td>
                    <td class="num">{{ s.skipped ? s.skipped : fPct(s.sharePct) }}</td>
                  </tr>
                </tbody>
              </table>

              <h3>上行逐源明细</h3>
              <table class="ci-tb res">
                <thead><tr><th>干扰源</th><th class="n">干扰站离轴角 °</th><th class="n">干扰密度 dBW/Hz</th><th>来源</th><th class="n">极化 dB</th><th class="n">C/I dB</th><th class="n">占比</th></tr></thead>
                <tbody>
                  <tr
                    v-for="s in (asi.result.uplink && asi.result.uplink.sources) || []" :key="s.id + 'u'"
                    :class="{ hot: hoveredId === s.id }"
                    @mouseenter="I.setHover(s.id)" @mouseleave="I.setHover('')">
                    <!-- 轨位标的是这一源所属的那颗干扰星（对等站模式下站址另有「站经度/站纬度」两列，别混） -->
                    <td>{{ s.name }}<span v-if="fSlot(s.lonDeg)" class="ci-slot" title="该源所属干扰星的轨位（°E/°W；非干扰站站址经度）">{{ fSlot(s.lonDeg) }}</span></td>
                    <!-- 施扰的是对方那座站：非共址时它看到的夹角与本站的拓扑角不是一个数 -->
                    <td class="num">{{ f(s.offAxisDeg) }}</td>
                    <td class="num">{{ f(s.interfererDensityDbWPerHz) }}</td>
                    <td class="dim">{{ s.maskBand ? 'S.524 ' + s.maskBand : (s.peer ? '对等站 Ø' + f(s.peer.diameterM, 1) + ' m' + (s.peer.coLocated ? '（共址）' : '') : '给定') }}</td>
                    <!-- 上行比的是干扰载波的上行极化；悬停标出按哪个极化算的、是否由下行关系推定 -->
                    <td class="num" :title="upPolTip(s)">{{ f(s.polDb, 1) }}</td>
                    <td class="num">{{ f(s.ciDb) }}</td>
                    <td class="num">{{ fPct(s.sharePct) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div class="ci-split-r">
              <h3>干扰几何</h3>
              <CiGeoPanel :down="geoData.down" :up="geoData.up" :hovered-id="hoveredId" @hover="I.setHover" />
            </div>
          </div>
        </section>
      </template>

      <!-- ============ 协调触发（RR 附录 8）============
           本网的站 / 星 / 载波取页首「本站与本链路」；这里只摆附录 8 另要的量。双向 ΔT/T 与附录 5 协调弧全在引擎（utils/itu/ap8.js）。 -->
      <template v-else-if="mode === 'ap8'">
        <section class="ci-panel">
          <div class="ci-panel-hd"><h2>协调触发（RR 附录 8）</h2></div>
          <div class="ci-band ap8">
            <div class="ci-bcol">
              <h3>计算设置</h3>
              <div class="srow" :title="AP8_GEOM_TIP"><label>几何口径</label>
                <select v-model="ap8.geometry" class="ci"><option value="rule">附件 1/2 公式</option><option value="wgs84">WGS84</option></select><span class="u"></span>
              </div>
              <div class="srow" title="本网服务区所在 ITU 区域，查附录 5 表 5-1 No.9.7 协调弧用"><label>ITU 区域</label>
                <select v-model.number="ap8.region" class="ci"><option :value="1">1</option><option :value="2">2</option><option :value="3">3</option></select><span class="u"></span>
              </div>
              <div class="srow" title="RR 附录 8 §2.2.3：仅在双方主管部门同意并已申报极化时计入"><label class="ci-chk"><input v-model="ap8.applyPolarization" type="checkbox" />计入极化隔离 Y</label></div>
            </div>

            <div class="ci-bcol">
              <h3>本网</h3>
              <div class="srow" :title="EW_TOL_TIP"><label>东西保持</label><input v-model="ap8.ownTolDeg" class="ci" type="number" step="0.01" min="0" /><span class="u">±°</span></div>
              <div class="srow"><label>上行频段</label><span class="ci-range"><input v-model="ap8.ownUpLo" class="ci" type="number" step="0.001" :placeholder="phBand(site.txFreqGHz, -1)" /><i>–</i><input v-model="ap8.ownUpHi" class="ci" type="number" step="0.001" :placeholder="phBand(site.txFreqGHz, 1)" /></span><span class="u">GHz</span></div>
              <div class="srow"><label>下行频段</label><span class="ci-range"><input v-model="ap8.ownDnLo" class="ci" type="number" step="0.001" :placeholder="phBand(site.rxFreqGHz, -1)" /><i>–</i><input v-model="ap8.ownDnHi" class="ci" type="number" step="0.001" :placeholder="phBand(site.rxFreqGHz, 1)" /></span><span class="u">GHz</span></div>
              <div class="srow" :title="AP4_PE_TIP"><label>发端功率密度</label><input v-model="ap8.ownPeDbWPerHz" class="ci" type="number" step="0.1" placeholder="按功放折算" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="本星朝邻网收端站方向的最大 EIRP 密度（附录 8 的 ps·g3）"><label>卫星 EIRP 密度</label><input v-model="ap8.ownSatEirpDen" class="ci" type="number" step="0.1" placeholder="按本链路载波" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="本星 EIRP 方向图（dBW）：在邻网收端站处取值，按占用带宽折成 EIRP 密度填入上一格"><label>EIRP 方向图</label>
                <select v-model="ap8.grdKey" class="ci">
                  <option value="">—</option>
                  <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }} · {{ a.origin }}</option>
                </select>
                <button class="ci-btn" :disabled="busy || !ap8.grdKey" @click="I.sampleAp8EirpFromGrd()">取值</button>
              </div>
              <div class="srow" title="本星朝邻网发端站方向的接收增益（附录 8 的 g2）"><label>卫星接收增益</label><input v-model="ap8.ownSatRxGainDbi" class="ci" type="number" step="0.1" placeholder="同邻星" /><span class="u">dBi</span></div>
              <div class="srow" title="本星接收 G/T，与接收增益一起反解卫星接收系统噪温 Ts"><label>卫星 G/T</label><input v-model="ap8.ownSatGt" class="ci" type="number" step="0.1" placeholder="同邻星" /><span class="u">dB/K</span></div>
              <div class="srow" title="本站接收系统噪温（附录 8 的 Te）"><label>收端站噪温</label><input v-model="ap8.ownTeK" class="ci" type="number" step="1" /><span class="u">K</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>γ₁</label><input v-model="ap8.ownG1" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>T₁</label><input v-model="ap8.ownT1" class="ci" type="number" step="1" placeholder="Te + γ·Ts" /><span class="u">K</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>γ₂</label><input v-model="ap8.ownG2" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>T₂</label><input v-model="ap8.ownT2" class="ci" type="number" step="1" placeholder="Te + γ·Ts" /><span class="u">K</span></div>
              <div class="srow" :title="REGEN_TIP"><label class="ci-chk"><input v-model="ap8.ownRegen" type="checkbox" />星上再生</label></div>
            </div>

            <div class="ci-bcol">
              <h3>邻网</h3>
              <div class="srow"><label>卫星轨位</label><input v-model.number="asi.coordLonDeg" class="ci" type="number" step="0.1" /><span class="u">°E</span></div>
              <div class="srow" :title="EW_TOL_TIP"><label>东西保持</label><input v-model="ap8.otherTolDeg" class="ci" type="number" step="0.01" min="0" /><span class="u">±°</span></div>
              <div class="srow"><label>上行频段</label><span class="ci-range"><input v-model="ap8.otherUpLo" class="ci" type="number" step="0.001" placeholder="同本网" /><i>–</i><input v-model="ap8.otherUpHi" class="ci" type="number" step="0.001" placeholder="同本网" /></span><span class="u">GHz</span></div>
              <div class="srow"><label>下行频段</label><span class="ci-range"><input v-model="ap8.otherDnLo" class="ci" type="number" step="0.001" placeholder="同本网" /><i>–</i><input v-model="ap8.otherDnHi" class="ci" type="number" step="0.001" placeholder="同本网" /></span><span class="u">GHz</span></div>
              <div class="srow"><label>上行极化</label>
                <select v-model="ap8.otherUpPol" class="ci"><option value="">同本网</option><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
              </div>
              <div class="srow"><label>下行极化</label>
                <select v-model="ap8.otherDnPol" class="ci"><option value="">同本网</option><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
              </div>
              <div class="srow" :title="AP4_PE_TIP"><label>发端功率密度</label><input v-model="ap8.otherPeDbWPerHz" class="ci" type="number" step="0.1" placeholder="同本网" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="邻星朝本站方向的最大 EIRP 密度（附录 8 的 p′s·g′3）；留空取干扰星表中同轨位一行的下行 EIRP 密度"><label>卫星 EIRP 密度</label><input v-model="ap8.otherSatEirpDen" class="ci" type="number" step="0.1" placeholder="按干扰星表" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="邻星朝本站方向的接收增益（附录 8 的 g′2）"><label>卫星接收增益</label><input v-model.number="asi.coordRxGain" class="ci" type="number" step="0.1" /><span class="u">dBi</span></div>
              <div class="srow" title="邻星接收 G/T，与接收增益一起反解卫星接收系统噪温 T′s"><label>卫星 G/T</label><input v-model.number="asi.coordGoverT" class="ci" type="number" step="0.1" /><span class="u">dB/K</span></div>
              <div class="srow"><label>地球站口径</label><input v-model="ap8.otherDiameterM" class="ci" type="number" step="0.1" placeholder="同本站" /><span class="u">m</span></div>
              <div class="srow"><label>地球站效率</label><input v-model="ap8.otherEfficiency" class="ci" type="number" step="1" placeholder="同本站" /><span class="u">%</span></div>
              <div class="srow" title="邻网收端站的主瓣增益（申报只给增益时填）；口径留空则按附录 8 附件 3 脚注 4 由增益估 D/λ（20lg(D/λ) ≈ Gmax − 7.7）"><label>收端站增益</label><input v-model="ap8.otherRxGainDbi" class="ci" type="number" step="0.1" placeholder="按口径与效率" /><span class="u">dBi</span></div>
              <div class="srow"><label>地球站经度</label><input v-model="ap8.otherLon" class="ci" type="number" step="0.0001" placeholder="同本站" /><span class="u">°E</span></div>
              <div class="srow"><label>地球站纬度</label><input v-model="ap8.otherLat" class="ci" type="number" step="0.0001" placeholder="同本站" /><span class="u">°N</span></div>
              <div class="srow" title="邻网收端站接收系统噪温（附录 8 的 T′e）"><label>收端站噪温</label><input v-model="ap8.otherTeK" class="ci" type="number" step="1" placeholder="同本站" /><span class="u">K</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>γ₁</label><input v-model="ap8.otherG1" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>T₁</label><input v-model="ap8.otherT1" class="ci" type="number" step="1" placeholder="Te + γ·Ts" /><span class="u">K</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>γ₂</label><input v-model="ap8.otherG2" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
              <div class="srow" :title="AP8_LINK_TIP"><label>T₂</label><input v-model="ap8.otherT2" class="ci" type="number" step="1" placeholder="Te + γ·Ts" /><span class="u">K</span></div>
              <div class="srow" :title="REGEN_TIP"><label class="ci-chk"><input v-model="ap8.otherRegen" type="checkbox" />星上再生</label></div>
            </div>

            <div class="ci-bcol">
              <h3>反向频段（Case II）</h3>
              <div class="srow" title="本星朝邻星方向的 EIRP 密度（附录 8 的 ps·g3(ηs′)）"><label>本星 EIRP 密度</label><input v-model="ap8.ownSatEirpToSat" class="ci" type="number" step="0.1" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="本星朝邻星方向的接收增益（附录 8 的 g2(δs′)）"><label>本星接收增益</label><input v-model="ap8.ownSatRxGainToSat" class="ci" type="number" step="0.1" /><span class="u">dBi</span></div>
              <div class="srow" title="邻星朝本星方向的 EIRP 密度（附录 8 的 p′s·g′3(ηs)）"><label>邻星 EIRP 密度</label><input v-model="ap8.otherSatEirpToSat" class="ci" type="number" step="0.1" /><span class="u">dB(W/Hz)</span></div>
              <div class="srow" title="邻星朝本星方向的接收增益（附录 8 的 g′2(δs)）"><label>邻星接收增益</label><input v-model="ap8.otherSatRxGainToSat" class="ci" type="number" step="0.1" /><span class="u">dBi</span></div>
            </div>
          </div>
        </section>

        <section v-if="ap8.result" class="ci-panel">
          <h2>结果<span v-if="stale.ap8" class="ci-stale" :title="STALE_TIP">输入已变</span></h2>
          <div class="ci-kpis">
            <div class="ci-kpi" :title="ap8MethodTip(ap8.result.ownToOther)"><span>本网 → 邻网 ΔT′/T′</span><b :class="{ 'st-bad': ap8.result.ownToOther.exceeds }">{{ f(ap8.result.ownToOther.headlinePct, 3) }}</b><i>%</i></div>
            <div class="ci-kpi" :title="ap8MethodTip(ap8.result.otherToOwn)"><span>邻网 → 本网 ΔT/T</span><b :class="{ 'st-bad': ap8.result.otherToOwn.exceeds }">{{ f(ap8.result.otherToOwn.headlinePct, 3) }}</b><i>%</i></div>
            <div class="ci-kpi"><span>轨位差</span><b :class="{ 'st-bad': ap8.result.arc.within }">{{ f(ap8.result.lonDiffDeg, 3) }}</b><i>°</i></div>
            <div class="ci-kpi" :title="ap8ArcTip"><span>协调弧 No.9.7</span><b>{{ ap8.result.arc.maxArcDeg == null ? '—' : '±' + ap8.result.arc.maxArcDeg }}</b><i>°</i></div>
            <div class="ci-kpi" title="计入两星东西保持容差后的地心角"><span>地心角 θg</span><b>{{ f(ap8.result.thetaGDeg, 3) }}</b><i>°</i></div>
            <div class="ci-kpi"><span>地球站方向图</span><b class="sm">{{ patLabel(ap8.result.pattern) }}</b></div>
          </div>
          <table class="ci-tb res ap8">
            <thead><tr><th></th><th class="n">本网 → 邻网</th><th class="n">邻网 → 本网</th></tr></thead>
            <tbody>
              <template v-for="(r, i) in ap8Rows" :key="i">
                <tr v-if="r.grp" class="grp"><th colspan="3">{{ r.label }}</th></tr>
                <tr v-else :class="{ strong: r.strong }">
                  <th>{{ r.label }}<span v-if="r.unit" class="ci-unit">{{ r.unit }}</span></th>
                  <td v-for="(c, j) in r.cells" :key="j" class="num" :class="{ 'st-bad': c.bad }" :title="c.title || null">{{ c.text }}</td>
                </tr>
              </template>
            </tbody>
          </table>
        </section>
      </template>

      <!-- ============ C/CCI ============ -->
      <template v-else-if="mode === 'cci'">
        <section class="ci-panel">
          <div class="ci-panel-hd">
            <h2>方向图与复用方案</h2>
            <div class="ci-hd-tools">
              <button class="ci-btn" @click="I.importGrdHere()">导入 GRD…</button>
              <button class="ci-btn" @click="I.loadGrdTree()">刷新列表</button>
            </div>
          </div>
          <div class="ci-form">
            <div class="srow wide"><label>方向图</label>
              <select v-model="cci.antennaKey" class="ci">
                <option value="">— 选一副天线 —</option>
                <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }} · {{ a.origin }}</option>
              </select>
            </div>
            <div class="srow"><label>链路方向</label>
              <div class="seg nseg" role="radiogroup" aria-label="链路方向">
                <button type="button" class="sg" role="radio" :aria-checked="cci.dir === 'fwd' ? 'true' : 'false'" :class="{ on: cci.dir === 'fwd' }" title="用户下行：该点服务波束与同频波束的发射电平之比" @click="cci.dir = 'fwd'">前向</button>
                <button type="button" class="sg" role="radio" :aria-checked="cci.dir === 'rtn' ? 'true' : 'false'" :class="{ on: cci.dir === 'rtn' }" title="用户上行：本波束接收方向图在同频他区终端处的增益，终端按功控到等接收谱密度" @click="cci.dir = 'rtn'">返向</button>
              </div>
            </div>
            <div class="srow"><label>着色来源</label>
              <select v-model="cci.source" class="ci" title="自动 = 频率计划 > 波束合成色号 > Excel 导入 > 手工 > 轮转，取第一个有数据的">
                <option v-for="s in CCI_SOURCES" :key="s.key" :value="s.key">{{ s.label }}</option>
              </select><span class="u"></span>
            </div>
            <div v-if="cciEffSource === 'rotation'" class="srow"><label>复用色数</label>
              <select v-model.number="cci.colors" class="ci">
                <option v-for="c in REUSE_COLORS" :key="c" :value="c">{{ c }} 色</option>
              </select><span class="u"></span>
            </div>
            <div class="srow"><label title="正交极化的同频波束、方向图没有交叉极化分量时采用的规格值">交叉极化鉴别</label><input v-model.number="cci.xpdDb" class="ci" type="number" step="1" /><span class="u">dB</span></div>
            <div class="srow"><label title="服务区 = 该点的服务波束且电平不低于其峰值减这么多；逐波束统计与返向终端落点都只取服务区内的点">服务区边缘</label><input v-model.number="cci.eocDb" class="ci" type="number" step="0.5" min="0" /><span class="u">dB</span></div>
            <div class="srow"><label title="比服务波束低这么多以上的干扰项忽略">忽略门限</label><input v-model.number="cci.floorDb" class="ci" type="number" /><span class="u">dB</span></div>
          </div>
          <p v-if="!grdAntennas.length" class="ci-note">暂无可用方向图。</p>

          <!-- 频率计划：逐波束段 + 极化由计划推出；GRD 波束 ↔ 计划波束按号 / 按名自动匹配，计划波束格可手改 -->
          <div v-if="cciShowPlan" class="ci-sub">
            <div class="ci-panel-hd">
              <h3>频率计划</h3>
              <span class="ci-hd-sum">{{ cciPlanReading }}</span>
            </div>
            <div class="ci-form">
              <div class="srow wide"><label>频率计划</label>
                <select v-model="cci.planId" class="ci">
                  <option value="">{{ cciPlanAutoId ? '本星第一份' : '— 选一份计划 —' }}</option>
                  <option v-for="p in cciPlanList" :key="p.id" :value="p.id">{{ p.name }}{{ p.satName ? ' · ' + p.satName : '' }}</option>
                </select>
              </div>
              <div class="srow"><label :title="cci.dir === 'rtn' ? '只取计划里落在这一段的上行占段；留空 = 不筛' : '只取计划里落在这一段的下行占段；留空 = 不筛'">{{ cci.dir === 'rtn' ? '返向频段起' : '前向频段起' }}</label><input v-model="cciBand.f1" class="ci" type="text" inputmode="decimal" /><span class="u">MHz</span></div>
              <div class="srow"><label :title="cci.dir === 'rtn' ? '只取计划里落在这一段的上行占段；留空 = 不筛' : '只取计划里落在这一段的下行占段；留空 = 不筛'">{{ cci.dir === 'rtn' ? '返向频段止' : '前向频段止' }}</label><input v-model="cciBand.f2" class="ci" type="text" inputmode="decimal" /><span class="u">MHz</span></div>
            </div>
            <ExcelGrid class="ci-eg" :grid="cciPlanGrid.g" :cols="CCI_PLAN_COLS" :text="cciPlanGrid.textOf" :cell-class="cciPlanCellClass" :cell-tip="cellTipOf" :head-tip="headTip"
                       empty-text="暂无波束。" />
          </div>

          <!-- 逐波束复用表：Excel 导入或直接录（前向 / 返向各一组色号 · 起止 · 极化） -->
          <div v-if="cciEffSource === 'excel'" class="ci-sub">
            <div class="ci-panel-hd">
              <h3>逐波束复用表</h3>
              <div class="ci-hd-tools"><button class="ci-btn" :disabled="!cciRows.length" @click="I.importCciTable()">导入 Excel…</button></div>
            </div>
            <ExcelGrid class="ci-eg" :grid="cciTableGrid.g" :cols="TABLE_COLS" :text="cciTableGrid.textOf" :cell-class="roCellClass" :cell-tip="cellTipOf" :head-tip="headTip"
                       empty-text="暂无波束。" />
          </div>

          <!-- 色号类来源（波束合成 / 手工 / 轮转）：逐波束色号 + 可选的色号定义（F# → 频段 × 极化） -->
          <div v-if="cciShowColorDefs" class="ci-sub">
            <h3>逐波束色号</h3>
            <ExcelGrid class="ci-eg" :grid="cciColorGrid.g" :cols="CCI_COLOR_COLS" :text="cciColorGrid.textOf" :cell-class="cciColorCellClass" :cell-tip="cellTipOf" :head-tip="headTip"
                       empty-text="暂无波束。" />
            <h3>色号定义</h3>
            <ExcelGrid class="ci-eg" :grid="cciDefGrid.g" :cols="DEF_COLS" :text="cciDefGrid.textOf" :cell-tip="cellTipOf" :head-tip="headTip"
                       empty-text="暂无色号定义。" add-label="添加色号" del-label="删除所选行" @add="cciDefGrid.append()" />
          </div>

          <h3>取值点</h3>
          <ExcelGrid class="ci-eg" :grid="ptGrid.g" :cols="PT_COLS" :text="ptGrid.textOf" :cell-tip="cellTipOf" :head-tip="headTip"
                     empty-text="暂无取值点。" add-label="添加取值点" del-label="删除所选行" @add="ptGrid.append()" />
        </section>

        <!-- 场图与逐站取值并排：同一副天线、同一套着色的两种读法——面上的分布与点上的读数。
             上下摆的时候，要核对某个点的数得先滚过一整张图，两个数还对不到一屏里。 -->
        <section class="ci-panel">
          <h2>覆盖场图与逐站取值</h2>
          <div class="ci-split cci">
            <div class="ci-split-l">
              <div class="ci-panel-hd">
                <h3>{{ cci.dir === 'rtn' ? '返向 C/CCI 覆盖场图' : 'C/CCI 覆盖场图' }}</h3>
                <span v-if="stale.cciField" class="ci-stale" :title="STALE_TIP">输入已变</span>
                <button class="ci-btn" :disabled="busy || !currentAntenna" @click="I.computeCciField()">计算场图</button>
                <button class="ci-btn" :disabled="!cci.field || cciExporting" title="导出为 PNG 图片（4 倍分辨率）" @click="exportCciField">导出</button>
              </div>
              <div class="ci-form">
                <div class="srow"><label>网格</label>
                  <div class="seg nseg" role="radiogroup" aria-label="网格">
                    <button type="button" class="sg" role="radio" :aria-checked="cci.grid === 'antenna' ? 'true' : 'false'" :class="{ on: cci.grid === 'antenna' }" title="方向图自身的角度网格（各波束窗口的并集），逐节点计算" @click="cci.grid = 'antenna'">天线网格</button>
                    <button type="button" class="sg" role="radio" :aria-checked="cci.grid === 'user' ? 'true' : 'false'" :class="{ on: cci.grid === 'user' }" title="按经纬范围与步长铺格" @click="cci.grid = 'user'">经纬网格</button>
                  </div>
                </div>
                <template v-if="cci.dir === 'rtn'">
                  <div class="srow"><label>终端位置</label>
                    <div class="seg nseg" role="radiogroup" aria-label="终端位置">
                      <button type="button" class="sg" role="radio" :aria-checked="cci.rtnMode === 'worst' ? 'true' : 'false'" :class="{ on: cci.rtnMode === 'worst' }" title="各同频波束的终端都落在其服务区内对本波束最不利的一点" @click="cci.rtnMode = 'worst'">最坏点</button>
                      <button type="button" class="sg" role="radio" :aria-checked="cci.rtnMode === 'mc' ? 'true' : 'false'" :class="{ on: cci.rtnMode === 'mc' }" title="每次试验在各同频波束的服务区内随机取一个终端位置" @click="cci.rtnMode = 'mc'">蒙特卡洛</button>
                    </div>
                  </div>
                  <template v-if="cci.rtnMode === 'mc'">
                    <div class="srow"><label>试验次数</label><input v-model.number="cci.mcTrials" class="ci" type="number" step="50" min="1" /><span class="u"></span></div>
                    <div class="srow"><label>随机种子</label><input v-model.number="cci.mcSeed" class="ci" type="number" step="1" /><span class="u"></span></div>
                  </template>
                </template>
              </div>
              <div v-if="cci.grid === 'user'" class="ci-grid inline">
                <label>经度起 °E<input v-model.number="cci.bounds.lonMin" type="number" step="1" /></label>
                <label>经度止 °E<input v-model.number="cci.bounds.lonMax" type="number" step="1" /></label>
                <label>纬度起 °N<input v-model.number="cci.bounds.latMin" type="number" step="1" /></label>
                <label>纬度止 °N<input v-model.number="cci.bounds.latMax" type="number" step="1" /></label>
                <label>网格步长 °<input v-model.number="cci.fieldStep" type="number" step="0.05" /></label>
              </div>
              <div v-if="cci.field" class="ci-fieldwrap">
                <LbSurfacePlot ref="cciPlot"
                  :xs="cci.field.xs" :ys="cci.field.ys" :nx="cci.field.nx" :ny="cci.field.ny" :z="cci.field.z"
                  x-label="经度" x-unit="°E" y-label="纬度" y-unit="°N"
                  :z-label="cci.stats && cci.stats.dir === 'rtn' ? '返向 C/CCI' : 'C/CCI'" z-unit="dB"
                  :basemap="true" palette="turbo" :level-count="9"
                  :bounds="{ x0: -180, x1: 180, y0: -90, y1: 90 }" />
              </div>
              <p v-else class="ci-note">尚未计算。</p>
              <p v-if="cciFieldLine" class="ci-note sm">{{ cciFieldLine }}</p>
            </div>

            <div class="ci-split-r">
              <div class="ci-panel-hd">
                <h3>逐站取值</h3>
                <span v-if="stale.cci" class="ci-stale" :title="STALE_TIP">输入已变</span>
              </div>
              <template v-if="cci.result">
                <div class="ci-tbwrap">
                  <table class="ci-tb res">
                    <thead><tr><th>取值点</th><th class="n">经度</th><th class="n">纬度</th><th>服务波束</th><th>复用</th><th class="n">C/CCI dB</th></tr></thead>
                    <tbody>
                      <tr v-for="(r, i) in cci.result.rows" :key="i">
                        <td data-i18n-skip>{{ r.name }}</td>
                        <td class="dim num">{{ f(r.lon, 4) }}</td>
                        <td class="dim num">{{ f(r.lat, 4) }}</td>
                        <td>{{ r.servingIdx == null ? '—' : '#' + (r.servingIdx + 1) }}</td>
                        <td class="dim" data-i18n-skip>{{ r.reuse || '—' }}</td>
                        <td class="num" :title="r.floored ? `窗外计入 ${r.floored} 项` : null">{{ r.noCo ? '∞' : f(r.cciDb) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <p v-if="cciPtsLine" class="ci-note sm">{{ cciPtsLine }}</p>
              </template>
              <p v-else class="ci-note">尚无逐点读数。</p>
            </div>
          </div>
        </section>

        <!-- 逐波束统计：服务区（服务波束且不低于其峰值「服务区边缘」dB）内的格点 -->
        <section v-if="cci.stats" class="ci-panel">
          <h2>逐波束统计<span v-if="stale.cciField" class="ci-stale" :title="STALE_TIP">输入已变</span></h2>
          <div class="ci-tbwrap tall">
            <table class="ci-tb res">
              <thead v-if="cci.stats.dir !== 'rtn'">
                <tr><th>波束</th><th>复用</th><th class="n" title="与本波束频段重叠的同频波束数">同频</th><th class="n">服务区点数</th><th class="n" title="服务区内的最小值（覆盖边缘最差）">最小 dB</th><th class="n">5% dB</th><th class="n">中位 dB</th></tr>
              </thead>
              <thead v-else>
                <tr><th>波束</th><th>复用</th><th class="n" title="与本波束频段重叠的同频波束数">同频</th><th class="n">服务区点数</th><th class="n" title="各同频波束的终端都落在对本波束最不利的位置">最坏点 dB</th><template v-if="cci.stats.trials"><th class="n">最小 dB</th><th class="n">5% dB</th><th class="n">中位 dB</th></template></tr>
              </thead>
              <tbody>
                <tr v-for="b in cciBeamRows" :key="b.idx">
                  <td>#{{ b.idx + 1 }}</td>
                  <td class="dim" data-i18n-skip>{{ cciReuseOf(b, cci.stats.source) }}</td>
                  <td class="num">{{ b.partners }}</td>
                  <td class="num">{{ b.cells }}</td>
                  <template v-if="cci.stats.dir !== 'rtn'">
                    <td class="num">{{ b.fwd ? cciFmt(b.fwd.min) : '—' }}</td>
                    <td class="num">{{ b.fwd ? cciFmt(b.fwd.p5) : '—' }}</td>
                    <td class="num">{{ b.fwd ? cciFmt(b.fwd.p50) : '—' }}</td>
                  </template>
                  <template v-else>
                    <td class="num">{{ b.rtnWorst == null ? '—' : cciFmt(b.rtnWorst) }}</td>
                    <template v-if="cci.stats.trials">
                      <td class="num">{{ b.rtnMc ? cciFmt(b.rtnMc.min) : '—' }}</td>
                      <td class="num">{{ b.rtnMc ? cciFmt(b.rtnMc.p5) : '—' }}</td>
                      <td class="num">{{ b.rtnMc ? cciFmt(b.rtnMc.p50) : '—' }}</td>
                    </template>
                  </template>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <!-- ============ C/XPI ============ -->
      <template v-else-if="mode === 'xpi'">
        <section class="ci-panel">
          <h2>三段来源</h2>
          <div class="ci-sub">
            <h3>① 卫星天线</h3>
            <div class="ci-radios">
              <label><input v-model="xpi.satSource" type="radio" value="grd" />由 GRD 方向图取（P1/P2 逐点实测）</label>
              <label><input v-model="xpi.satSource" type="radio" value="manual" />手填</label>
            </div>
            <!-- 站址就摆在取值按钮旁边：本页只吃这两个数，没必要为它挂一整条侧栏 -->
            <div v-if="xpi.satSource === 'grd'" class="ci-form">
              <div class="srow wide"><label>方向图</label>
                <select v-model="cci.antennaKey" class="ci">
                  <option value="">— 选一副天线 —</option>
                  <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }} · {{ a.origin }}</option>
                </select>
              </div>
              <div class="srow"><label>本站经度</label><input v-model.number="site.lon" class="ci" type="number" step="0.0001" /><span class="u">°E</span></div>
              <div class="srow"><label>本站纬度</label><input v-model.number="site.lat" class="ci" type="number" step="0.0001" /><span class="u">°N</span></div>
              <div class="srow"><label>本站处 XPD</label><input v-model="xpi.satGrdRatioDb" class="ci" type="number" readonly /><span class="u">dB</span></div>
              <div class="srow"><button class="ci-btn" :disabled="!currentAntenna" @click="I.sampleXpiFromGrd()">在本站取值</button></div>
            </div>
            <div v-else class="ci-form">
              <div class="srow"><label>卫星侧 XPI</label><input v-model.number="xpi.satManualDb" class="ci" type="number" step="0.5" /><span class="u">dB</span></div>
            </div>
          </div>

          <div class="ci-sub">
            <h3>② 地球站天线</h3>
            <div class="ci-radios">
              <label><input v-model="xpi.esMode" type="radio" value="manual" />直接填 XPI</label>
              <label><input v-model="xpi.esMode" type="radio" value="axialRatio" />由轴比换算（圆极化）</label>
              <label><input v-model="xpi.esMode" type="radio" value="levels" />由实测共/交极化电平</label>
            </div>
            <div v-if="xpi.esMode === 'axialRatio'" class="ci-form">
              <div class="srow"><label>轴比 AR</label><input v-model.number="xpi.esArDb" class="ci" type="number" step="0.05" min="0" /><span class="u">dB</span></div>
            </div>
            <div v-else-if="xpi.esMode === 'levels'" class="ci-form">
              <div class="srow"><label>共极化电平</label><input v-model.number="xpi.esCoDb" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
              <div class="srow"><label>交叉极化电平</label><input v-model.number="xpi.esXpolDb" class="ci" type="number" step="0.1" /><span class="u">dB</span></div>
            </div>
            <div v-else class="ci-form">
              <div class="srow"><label>地球站侧 XPI</label><input v-model.number="xpi.earthStationDb" class="ci" type="number" step="0.5" /><span class="u">dB</span></div>
            </div>
            <div class="ci-form gap-t">
              <div class="srow"><label class="ci-chk"><input v-model="xpi.esAlignOn" type="checkbox" />再计极化对准误差</label></div>
              <div v-if="xpi.esAlignOn" class="srow"><label>对准误差 τ</label><input v-model.number="xpi.esAlignDeg" class="ci" type="number" step="0.1" min="0" max="89" /><span class="u">°</span></div>
            </div>
            <p v-if="xpi.esTerm" class="ci-derived">
              地球站侧 XPI = <b>{{ f(xpi.esTerm.db) }}</b> dB
              <span v-if="xpi.esTerm.note">· {{ xpi.esTerm.note }}</span>
            </p>
            <p v-else class="ci-derived off">本段无有效值，不计入合成。</p>
          </div>

          <div class="ci-sub">
            <h3>③ 降雨去极化</h3>
            <div class="ci-radios">
              <label><input v-model="xpi.rainSource" type="radio" value="p618" />按 ITU-R P.618-14 §4.1 计算</label>
              <label><input v-model="xpi.rainSource" type="radio" value="manual" />手填</label>
            </div>
            <!-- 计算用的站址 / 轨位 / 频率 / 极化与「本站与本链路」是同一份；站址在卫星侧取 GRD 时已摆在上面，这里不重复 -->
            <div v-if="xpi.rainSource === 'p618'" class="ci-form">
              <div class="srow" title="年时间百分比：雨致 XPD 在 p% 的时间内劣于该值"><label>时间百分比 p</label><input v-model.number="xpi.rainPct" class="ci" type="number" step="0.001" min="0.001" max="5" /><span class="u">%</span></div>
              <div class="srow"><label>链路方向</label>
                <select v-model="xpi.rainDir" class="ci"><option value="down">下行</option><option value="up">上行</option></select><span class="u"></span>
              </div>
              <div class="srow"><label>卫星轨位</label><input v-model.number="carrier.satLonDeg" class="ci" type="number" step="0.1" /><span class="u">°E</span></div>
              <div v-if="xpi.rainDir === 'up'" class="srow"><label>上行频率</label><input v-model.number="site.txFreqGHz" class="ci" type="number" step="0.01" /><span class="u">GHz</span></div>
              <div v-else class="srow"><label>下行频率</label><input v-model.number="site.rxFreqGHz" class="ci" type="number" step="0.01" /><span class="u">GHz</span></div>
              <div v-if="xpi.rainDir === 'up'" class="srow"><label>上行极化</label>
                <select v-model="carrier.upPolarization" class="ci"><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
              </div>
              <div v-else class="srow"><label>下行极化</label>
                <select v-model="carrier.dnPolarization" class="ci"><option>H</option><option>V</option><option>L</option><option>R</option></select><span class="u"></span>
              </div>
              <template v-if="xpi.satSource !== 'grd'">
                <div class="srow"><label>本站经度</label><input v-model.number="site.lon" class="ci" type="number" step="0.0001" /><span class="u">°E</span></div>
                <div class="srow"><label>本站纬度</label><input v-model.number="site.lat" class="ci" type="number" step="0.0001" /><span class="u">°N</span></div>
              </template>
              <div class="srow"><label>本站海拔</label><input v-model.number="site.alt" class="ci" type="number" /><span class="u">m</span></div>
            </div>
            <div v-else class="ci-form">
              <div class="srow"><label>雨致 XPD</label><input v-model.number="xpi.rainXpdDb" class="ci" type="number" step="0.5" /><span class="u">dB</span></div>
            </div>
          </div>
        </section>

        <section v-if="xpi.result" class="ci-panel">
          <h2>结果<span v-if="stale.xpi" class="ci-stale" :title="STALE_TIP">输入已变</span></h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>总 C/XPI</span><b>{{ f(xpi.result.xpiDb) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>卫星侧来源</span><b class="sm">{{ xpiSrcOf('satellite') }}</b></div>
            <div class="ci-kpi"><span>雨致 XPD 来源</span><b class="sm">{{ xpi.rainInfo ? (xpi.rainInfo.source === 'p618' ? 'P.618-14 §4.1' : '手填') : '—' }}</b></div>
          </div>
          <div :class="{ 'ci-split': xpiCdf.length > 1 }">
            <div class="ci-split-l">
              <table class="ci-tb res">
                <thead><tr><th>分段</th><th class="n">XPI dB</th><th>来源</th><th class="n">占总干扰</th></tr></thead>
                <tbody>
                  <tr v-for="t in xpi.result.terms" :key="t.key">
                    <td>{{ t.label }}</td>
                    <td class="num">{{ f(t.db, 1) }}</td>
                    <td class="dim" :title="t.note || ''">{{ XPI_SRC[t.source] || '手填' }}</td>
                    <td class="num">{{ fPct(t.sharePct) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="xpi.result.missing && xpi.result.missing.length" class="ci-note sm">
                缺失未计入的段：{{ xpi.result.missing.map((k) => XPI_SEG[k] || k).join('、') }}。
              </p>
              <p v-if="xpi.rainInfo && xpi.rainInfo.source === 'p618'" class="ci-note sm">雨致 XPD：{{ xpi.rainInfo.xpdDb == null ? '—' : f(xpi.rainInfo.xpdDb) + ' dB' }} · {{ xpi.rainInfo.note }}</p>
            </div>
            <div v-if="xpiCdf.length > 1" class="ci-split-r">
              <CiCdfPlot
                title="C/XPI 随时间百分比" file-name="C-XPI 随时间百分比" x-label="C/XPI (dB)"
                :cdf="xpiCdf" :percentiles="xpiCdfMark" />
            </div>
          </div>
        </section>
      </template>

      <!-- ============ NGSO ============ -->
      <template v-else>
        <section class="ci-panel">
          <h2>本星座</h2>
          <div class="ci-radios">
            <label><input v-model="ngso.wanted.source" type="radio" value="group" />真实星座（软件星历）</label>
            <label><input v-model="ngso.wanted.source" type="radio" value="walker" />Walker 参数（方案比选）</label>
          </div>
          <div v-if="ngso.wanted.source === 'group'">
            <div class="ci-form">
              <div class="srow wide"><label>星座</label>
                <select v-model="ngso.wanted.group" class="ci" @change="I.ensureGroup(ngso.wanted.group)">
                  <option value="">— 选一个星座 —</option>
                  <optgroup v-for="s in groupSections" :key="s.label" :label="s.label">
                    <option v-for="g in s.items" :key="g.key" :value="g.key">{{ g.label }}{{ g.count ? `（${g.count} 颗）` : (g.available ? '（本地有数据）' : '（无数据，需联网）') }}</option>
                    <option v-if="!s.items.length" disabled>{{ s.empty }}</option>
                  </optgroup>
                </select>
              </div>
              <div class="srow" title="留空为全量。按倍率 K 抽样将使聚合干扰偏低约 10·lg K dB；受算力限制时应优先调整步长与时窗"><label>抽样上限</label><input v-model.number="ngso.wanted.limit" class="ci" type="number" placeholder="留空 = 全量" /><span class="u">颗</span></div>
              <div class="srow">
                <button class="ci-btn" title="重新读取主窗口「星座」视图的卫星组、自定义星座与编目列表；本窗口为单例，切换窗口返回时亦会自动重读" @click="I.loadNgsoGroups()">刷新列表</button>
                <button class="ci-btn" :disabled="!ngso.wanted.group" @click="I.ensureGroup(ngso.wanted.group, true)">联网刷新</button>
              </div>
            </div>
            <p v-if="groupsErr" class="ci-note sm err">编目星座 / 自定义星历读取失败：{{ groupsErr }}</p>
            <!-- 选了真实星座就不再要求填根数：轨道参数由星历直接给出，这里只读速览 -->
            <dl v-if="groupStats[ngso.wanted.group]" class="ci-stats">
              <div><dt>在轨</dt><dd>{{ groupStats[ngso.wanted.group].count }} 颗</dd></div>
              <div><dt>轨道高度</dt><dd>{{ groupStats[ngso.wanted.group].altKmMin }}–{{ groupStats[ngso.wanted.group].altKmMax }} km<span class="dim">（中位 {{ groupStats[ngso.wanted.group].altKmMed }}）</span></dd></div>
              <div><dt>倾角</dt><dd>{{ groupStats[ngso.wanted.group].inclMin }}–{{ groupStats[ngso.wanted.group].inclMax }}°</dd></div>
              <div><dt>轨道周期</dt><dd>{{ groupStats[ngso.wanted.group].periodMin }} min</dd></div>
              <!-- 壳层 = 同一倾角且高度落在同一主峰窗里的那一撮，高度与倾角同源（抬轨/离轨中的星不计入） -->
              <div class="wide"><dt>主壳层</dt><dd><template v-for="(x, i) in groupStats[ngso.wanted.group].shells.slice(0, 3)" :key="i"><span v-if="i">　</span><span>{{ x.inclDeg }}° / {{ x.altKmMed }} km × {{ x.count }} 颗</span></template></dd></div>
            </dl>
            <!-- 统计还没到：在载 / 载不成（开窗、切配置后自动补载，见 useInterference.refreshGroupStats） -->
            <p v-else-if="ngso.wanted.group" class="ci-note sm" :class="{ err: !!groupErrs[ngso.wanted.group] }">{{ ngStatText(ngso.wanted) }}</p>
          </div>
          <div v-else class="ci-form">
            <div class="srow"><label>名称</label><input v-model="ngso.wanted.name" class="ci" type="text" /><span class="u"></span></div>
            <div class="srow"><label>轨道高度</label><input v-model.number="ngso.wanted.altKm" class="ci" type="number" /><span class="u">km</span></div>
            <div class="srow"><label>倾角</label><input v-model.number="ngso.wanted.incl" class="ci" type="number" step="0.1" /><span class="u">°</span></div>
            <div class="srow"><label>轨道面数</label><input v-model.number="ngso.wanted.planes" class="ci" type="number" /><span class="u"></span></div>
            <div class="srow"><label>每面星数</label><input v-model.number="ngso.wanted.perPlane" class="ci" type="number" /><span class="u"></span></div>
            <div class="srow"><label>相位因子 F</label><input v-model.number="ngso.wanted.phase" class="ci" type="number" /><span class="u"></span></div>
          </div>
          <!-- 曾有两段说明（星座下拉四段的来源 / 抽样上限的偏差口径）铺在这里——已删。
               来源在下拉的分组标题里就写着，抽样偏差在输入框的 title 与运行时告警里都说了，
               铺成两段正文只是把面板顶长。 -->

          <h3>干扰星座</h3>
          <ExcelGrid class="ci-eg" :grid="ngGrid.g" :cols="NG_COLS" :text="ngGrid.textOf" :row-class="offRow" :cell-class="ngCellClass" :cell-tip="ngCellTip" :head-tip="headTip"
                     empty-text="暂无干扰星座。" add-label="添加星座" del-label="删除所选行" @add="ngGrid.append()" />
          <!-- 星历行的星座选择：带分组（含空段）的动态下拉，不进网格，改的是活动行 -->
          <div v-if="ngPickRow" class="srow ci-currow">
            <label>星座 <span class="ci-rowno">#{{ ngPickNo }}</span></label>
            <select v-model="ngPickRow.group" class="ci" @change="I.ensureGroup(ngPickRow.group)">
              <option value="">— 选星座 —</option>
              <optgroup v-for="s in groupSections" :key="s.label" :label="s.label">
                <option v-for="x in s.items" :key="x.key" :value="x.key">{{ x.label }}{{ x.count ? ` (${x.count})` : (x.available ? ' (本地)' : ' (无)') }}</option>
                <option v-if="!s.items.length" disabled>{{ s.empty }}</option>
              </optgroup>
            </select>
            <span v-if="ngStatText(ngPickRow)" class="ci-ro-read">{{ ngStatText(ngPickRow) }}</span>
          </div>

          <div class="ci-sub">
            <h3>扫描设置</h3>
            <div class="ci-form">
              <div class="srow wide" title="多历元蒙特卡洛：各起始历元从此时刻起在基线跨度内抽取"><label>起始时刻</label><input class="ci" type="datetime-local" :value="ngsoStartText" @change="setNgsoStart($event.target.value)" @blur="$event.target.value = ngsoStartText" /><span class="u">UTC</span><button class="ci-btn" title="起始时刻取时间轴当前时刻" @click="I.ngsoStartNow()">此刻</button></div>
              <div v-if="(ngso.epochs.mode || 'single') === 'single'" class="srow wide" title="改结束时刻＝改时窗；改起始时刻时窗不变"><label>结束时刻</label><input class="ci" type="datetime-local" :value="ngsoEndText" @change="setNgsoEnd($event.target.value)" @blur="$event.target.value = ngsoEndText" /><span class="u">UTC</span></div>
              <div class="srow"><label>最低仰角</label><input v-model.number="ngso.minElevDeg" class="ci" type="number" step="0.5" /><span class="u">°</span></div>
              <div class="srow"><label>时窗</label><input v-model.number="ngso.horizonH" class="ci" type="number" step="0.5" /><span class="u">h</span></div>
              <div class="srow"><label>步长</label><input v-model.number="ngso.stepSec" class="ci" type="number" step="0.1" /><span class="u">s</span></div>
              <div class="srow"><label>门限 C/I</label><input v-model.number="ngso.thresholdDb" class="ci" type="number" step="0.5" /><span class="u">dB</span></div>
              <div class="srow"><label>离轴包络</label>
                <select v-model="ngso.patternKind" class="ci">
                  <option value="average">S.1428（平均，NGSO 用）</option>
                  <option value="peak">AP8/S.580（峰值，对比用）</option>
                </select><span class="u"></span>
              </div>
              <div class="srow" title="in-line 事件的判定半角。留空取半功率半角，此时穿越时长 = 3 dB 全宽 / 视角速度"><label>in-line 规避角</label><input v-model="ngso.inlineGuardDeg" class="ci" type="number" step="0.01" placeholder="留空 = 半功率半角" /><span class="u">°</span></div>
              <div class="srow"><label class="ci-chk"><input v-model="ngso.applyPolarization" type="checkbox" />计入极化折减</label></div>
            </div>
          </div>

          <!-- ============ 噪声 · 门限 · 可用度（P4）============ -->
          <div class="ci-sub">
            <h3>噪声与判据</h3>
            <div class="ci-form">
              <div class="srow"><label>噪声给法</label>
                <select v-model="ngso.noise.mode" class="ci">
                  <option value="tsys">系统噪声温度 T_sys</option>
                  <option value="gt">由 G/T 反推</option>
                </select><span class="u"></span>
              </div>
              <div v-if="ngso.noise.mode === 'tsys'" class="srow"><label>T_sys</label><input v-model="ngso.noise.tSysK" class="ci" type="number" step="1" placeholder="留空 = 仅输出 C/I" /><span class="u">K</span></div>
              <div v-else class="srow" title="T_sys = 10^((G_peak − G/T)/10)，G_peak 为本站天线峰值增益"><label>G/T</label><input v-model="ngso.noise.gOverTdBK" class="ci" type="number" step="0.1" /><span class="u">dB/K</span></div>
              <div class="srow" title="仅用于「越限时间占比」的统计"><label>C/I 门限</label><input v-model="ngso.criteria.ciDb" class="ci" type="number" step="0.5" placeholder="留空 = 不统计" /><span class="u">dB</span></div>
              <div class="srow" title="门限数值须依 ITU-R S.1323 与具体协调场景确定"><label>I/N 门限</label><input v-model="ngso.criteria.iOverNDb" class="ci" type="number" step="0.1" placeholder="留空 = 不统计" /><span class="u">dB</span></div>
              <div class="srow" title="ΔT/T 与 I/N 为同一比值的两种表达"><label>ΔT/T 门限</label><input v-model="ngso.criteria.deltaTOverTPct" class="ci" type="number" step="0.5" placeholder="留空 = 不统计" /><span class="u">%</span></div>
            </div>

            <h3>可用度合成</h3>
            <div class="ci-form">
              <div class="srow"><label class="ci-chk"><input v-model="ngso.rain.on" type="checkbox" />合成可用度</label></div>
              <div class="srow" title="C/(N+I) 低于该值判为不可用"><label>可用门限</label><input v-model.number="ngso.rain.thresholdDb" class="ci" type="number" step="0.5" /><span class="u">dB</span></div>
              <div class="srow" title="干扰路径与本站路径的仰角不同，默认不施加雨衰（保守口径）"><label>干扰路径雨衰</label>
                <select v-model="ngso.rain.applyToInterference" class="ci">
                  <option value="none">不施加（保守）</option>
                  <option value="same">按同路径等量施加</option>
                </select><span class="u"></span>
              </div>
              <div class="srow"><button class="ci-btn" :disabled="busy" @click="I.loadRainCdf()">取雨衰分布</button></div>
            </div>
            <p v-if="ngso.rain.cdfInfo" class="ci-note sm">雨衰分布：{{ ngso.rain.cdfInfo }}</p>
            <p v-else-if="ngso.rain.on" class="ci-note sm">尚未取雨衰分布。</p>
          </div>

          <!-- ============ 历元编排 ============ -->
          <div class="ci-sub">
            <h3>仿真时长与历元</h3>
            <div class="ci-form">
              <div class="srow"><label>历元方式</label>
                <select v-model="ngso.epochs.mode" class="ci">
                  <option value="single" title="采用上方时窗">单历元</option>
                  <option value="repeat">按回归周期取时窗</option>
                  <option value="monte-carlo">多历元蒙特卡洛</option>
                </select><span class="u"></span>
              </div>
              <template v-if="ngso.epochs.mode === 'monte-carlo'">
                <div class="srow"><label>历元个数</label><input v-model.number="ngso.epochs.count" class="ci" type="number" step="1" min="2" /><span class="u"></span></div>
                <div class="srow" title="起始历元在该基线内抽取"><label>基线跨度</label><input v-model.number="ngso.epochs.spanDays" class="ci" type="number" step="1" min="1" /><span class="u">天</span></div>
                <div class="srow" title="相同种子与起点的两次计算结果逐位一致"><label>随机种子</label><input v-model.number="ngso.epochs.seed" class="ci" type="number" step="1" /><span class="u"></span></div>
                <div class="srow" title="目标分位连续两次变化小于该值判为收敛"><label>收敛判据</label><input v-model.number="ngso.epochs.convergeTolDb" class="ci" type="number" step="0.05" /><span class="u">dB</span></div>
                <div class="srow" title="用于判定收敛的分位档"><label>收敛分位</label><input v-model.number="ngso.epochs.convergePct" class="ci" type="number" step="0.01" /><span class="u">%</span></div>
              </template>
              <template v-else-if="ngso.epochs.mode === 'repeat'">
                <div class="srow" title="回归周期超过该上限时封顶，并输出实际覆盖率"><label>时窗上限</label><input v-model.number="ngso.epochs.capDays" class="ci" type="number" step="1" min="1" /><span class="u">天</span></div>
              </template>
            </div>
            <p v-if="ngso.epochs.mode === 'monte-carlo'" class="ci-note sm">计算量为单历元的 {{ ngso.epochs.count }} 倍。</p>
          </div>

          <!-- ============ 卫星发射天线（干扰源侧）============ -->
          <div class="ci-sub">
            <h3>卫星发射天线</h3>
            <div class="ci-form">
              <div class="srow"><label>方向图</label>
                <select v-model="ngso.satPattern.mode" class="ci">
                  <option value="none">各向同性满 EIRP（上界包络）</option>
                  <option value="s1528">ITU-R S.1528 参考方向图</option>
                  <option value="gaussian">高斯主瓣近似</option>
                  <option value="grd">GRD 实测方向图</option>
                </select><span class="u"></span>
              </div>
              <div v-if="ngso.satPattern.mode !== 'none'" class="srow"><label>波束指向</label>
                <select v-model="ngso.satPattern.pointing" class="ci">
                  <option value="nadir">星下点</option>
                  <option value="cells">地面小区网格</option>
                  <option value="worst">始终指向本站（上界）</option>
                </select><span class="u"></span>
              </div>
              <div class="srow" title="同频复用系数 × 波束时隙占空，线性作用于每颗干扰星的功率"><label>同频占空</label><input v-model.number="ngso.satPattern.coFreqFactor" class="ci" type="number" step="0.05" min="0.001" max="1" /><span class="u"></span></div>
              <template v-if="ngso.satPattern.mode === 's1528'">
                <div class="srow"><label>S.1528 分节</label>
                  <select v-model="ngso.satPattern.s1528Section" class="ci">
                    <option value="1.2">§1.2（LN 型包络）</option>
                    <option value="1.3">§1.3（LEO / MEO 型）</option>
                  </select><span class="u"></span>
                </div>
                <div class="srow"><label>3 dB 波束宽</label><input v-model.number="ngso.satPattern.beamwidth3dBDeg" class="ci" type="number" step="0.1" /><span class="u">°</span></div>
                <div class="srow" title="留空时由 ψb 反推：D/λ = √1200/ψb，Gm = 20lg(D/λ) + 7.974（隐含 η≈63%）"><label>峰值增益</label><input v-model="ngso.satPattern.peakGainDbi" class="ci" type="number" step="0.1" placeholder="留空 = 由波束宽反推" /><span class="u">dBi</span></div>
                <div v-if="ngso.satPattern.s1528Section === '1.2'" class="srow" title="S.1528 Table 1 仅给出四档；−30 dB 一档原文标注为待进一步研究"><label>近旁瓣 LN</label>
                  <select v-model.number="ngso.satPattern.Ln" class="ci">
                    <option :value="-15">−15</option><option :value="-20">−20</option>
                    <option :value="-25">−25</option><option :value="-30">−30（暂定）</option>
                  </select><span class="u">dB</span>
                </div>
                <template v-else>
                  <div class="srow"><label>轨道类型</label>
                    <select v-model="ngso.satPattern.satMode" class="ci"><option value="LEO">LEO</option><option value="MEO">MEO</option></select><span class="u"></span>
                  </div>
                  <div class="srow" title="S.1528 §1.3 仅给出 D/λ < 35 的形式"><label>D/λ</label><input v-model="ngso.satPattern.dOverLambda" class="ci" type="number" step="0.1" placeholder="留空 = 由 ψb 反推" /><span class="u"></span></div>
                </template>
                <div class="srow" title="远旁瓣电平 LF，S.1528 正文取 0 dBi"><label>远旁瓣</label><input v-model.number="ngso.satPattern.farOutDbi" class="ci" type="number" step="0.5" /><span class="u">dBi</span></div>
              </template>
              <template v-else-if="ngso.satPattern.mode === 'gaussian'">
                <div class="srow"><label>3 dB 波束宽</label><input v-model.number="ngso.satPattern.beamwidth3dBDeg" class="ci" type="number" step="0.1" /><span class="u">°</span></div>
                <div class="srow"><label>旁瓣底板</label><input v-model.number="ngso.satPattern.sidelobeFloorDb" class="ci" type="number" step="1" /><span class="u">dB</span></div>
              </template>
              <template v-else-if="ngso.satPattern.mode === 'grd'">
                <div class="srow wide"><label>方向图</label>
                  <select v-model="ngso.satPattern.grdKey" class="ci">
                    <option value="">— 选择天线 —</option>
                    <option v-for="a in grdAntennas" :key="a.key" :value="a.key">{{ a.label }}（{{ a.origin }}）</option>
                  </select>
                </div>
                <div v-if="ngsoGrdBeams.length > 1" class="srow" title="干扰计算的是与受扰载波同频的那一个波束，不是整副天线"><label>同频波束</label>
                  <select v-model="ngso.satPattern.grdBeam" class="ci">
                    <option value="">全部波束取最大（上界）</option>
                    <option v-for="b in ngsoGrdBeams" :key="b.idx" :value="b.idx">{{ b.label }}</option>
                  </select><span class="u"></span>
                </div>
              </template>
              <template v-if="ngso.satPattern.mode !== 'none' && ngso.satPattern.pointing === 'cells'">
                <div class="srow" title="每颗卫星同时激活的波束数"><label>同时波束数</label><input v-model.number="ngso.satPattern.beamsPerSat" class="ci" type="number" step="1" min="1" /><span class="u"></span></div>
                <div class="srow" title="地面小区间距"><label>小区间距</label><input v-model.number="ngso.satPattern.cellSpacingKm" class="ci" type="number" step="10" min="1" /><span class="u">km</span></div>
              </template>
            </div>
            <template v-if="ngso.satPattern.mode === 'grd'">
              <p v-if="ngsoGrdBeams.length > 1 && ngso.satPattern.grdBeam === ''" class="ci-warn">
                所选方向图含 <strong>{{ ngsoGrdBeams.length }} 个波束</strong>，当前按「全部波束取最大」计算。
              </p>
            </template>
            <p v-else-if="ngso.satPattern.mode === 'none'" class="ci-warn">未计入卫星发射方向图。</p>
          </div>
        </section>

        <section v-if="ngso.result" class="ci-panel">
          <h2>结果<span v-if="stale.ngso" class="ci-stale" :title="STALE_TIP">输入已变</span></h2>
          <div class="ci-kpis">
            <div class="ci-kpi"><span>C/I 中位</span><b>{{ f(ngso.result.medianCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi" :title="ngSupTip(0.1)">
              <span>C/I(0.1%)</span>
              <template v-if="ngso.result.percentiles && ngso.result.percentiles[0.1] != null">
                <b>{{ f(ngso.result.percentiles[0.1], 1) }}</b><i>dB</i>
                <i v-if="ngCi(0.1)">±{{ f((ngCi(0.1).hi - ngCi(0.1).lo) / 2, 1) }}</i>
              </template>
              <template v-else><b class="kpi-short">样本不足</b><i>需 ≥ {{ ngSup(0.1) ? ngSup(0.1).needSamples.toLocaleString('en-US') : '—' }} 样本</i></template>
            </div>
            <div class="ci-kpi"><span>C/I 最差</span><b>{{ f(ngso.result.worstCiDb, 1) }}</b><i>dB</i></div>
            <div class="ci-kpi"><span>服务可用度</span><b>{{ f(ngso.result.availabilityPct, 2) }}</b><i>%</i></div>
            <div class="ci-kpi"><span>in-line</span><b>{{ ngso.result.inlineCount }}</b><i>次 / {{ f(ngso.result.horizonSec / 3600, 1) }} h</i></div>
          </div>

          <p v-if="ngso.result.epochStats" class="ci-note sm">
            多历元：{{ ngso.result.epochStats.count }} 个起始历元
            <template v-if="ngso.result.epochStats.spanDays">（{{ ngso.result.epochStats.spanDays }} 天基线内按种子 {{ ngso.result.epochStats.seed }} 抽取）</template>，
            样本池合并共 {{ (ngso.result.samples || 0).toLocaleString('en-US') }} 个。
            <template v-if="ngso.result.epochStats.converged">
              目标分位 C/I({{ ngso.result.epochStats.convergePct }}%) 在第
              <strong>{{ ngso.result.epochStats.convergedAtEpoch }}</strong> 个历元收敛（各历元独立估值的均值 95% 区间宽
              {{ f(ngso.result.epochStats.ciWidthDb, 2) }} dB &lt; {{ ngso.result.epochStats.convergeTolDb }} dB）。
            </template>
            <template v-else>
              目标分位 C/I({{ ngso.result.epochStats.convergePct }}%) 至第 {{ ngso.result.epochStats.count }} 个历元<strong>仍未收敛</strong>（各历元独立估值散布过大，其均值
              95% 区间宽 {{ f(ngso.result.epochStats.ciWidthDb, 2) }} dB，未达 {{ ngso.result.epochStats.convergeTolDb }} dB）。
            </template>
          </p>
          <p v-if="ngCiLowRes" class="ci-warn">
            历元数 {{ ngso.result.epochStats.count }} 少于 8，95% 区间偏窄。
            <template v-if="ngPerEpoch.length">
              各历元独立估出的 C/I({{ ngso.result.epochStats.convergePct }}%) 依次为
              <strong>{{ ngPerEpoch.join(' / ') }}</strong> dB。
            </template>
          </p>
          <p v-if="ngso.result.repeatPeriodSec" class="ci-note sm">
            星座回归周期 <strong>{{ f(ngso.result.repeatPeriodSec / 86400, 2) }} 天</strong>
            （{{ ngso.result.repeatPeriodOrbits }} 圈，ITU-R S.1325-3 §2.7.3，精度 {{ ngso.result.repeatPeriodAccuracyDeg }}°）；
            本次扫描覆盖 <strong>{{ f(ngso.result.repeatCoveragePct, 2) }}%</strong>。
          </p>
          <p v-if="!ngso.result.satPatternActive" class="ci-warn">
            未计入卫星发射方向图。
            其中 {{ f(ngso.result.farShareNoPatternPct, 1) }}% 的聚合干扰来自离轴
            {{ ngso.result.farOffAxisDeg }}° 以外的干扰星。
          </p>
          <p v-else class="ci-note sm">
            卫星发射天线：{{ ngso.result.satPattern.shape }}，指向
            {{ { nadir: '星下点', cells: '地面小区网格', worst: '始终指向本站' }[ngso.result.satPattern.pointing] || ngso.result.satPattern.pointing }}
            <template v-if="ngso.result.satPattern.beamCount > 1">，{{ ngso.result.satPattern.beamCount }} 个波束中{{ ngso.result.satPattern.beamPick == null ? '按全部取最大' : `仅取第 ${ngso.result.satPattern.beamPick + 1} 个` }}</template>
            <template v-if="ngso.result.satPattern.coFreqFactor !== 1">，同频占空 {{ ngso.result.satPattern.coFreqFactor }}（{{ f(ngso.result.satPattern.coFreqDb, 2) }} dB）</template>
            <template v-if="ngso.result.satPattern.peakGainDerived">，<strong>峰值增益由波束宽反推</strong></template>。
            计入方向图后聚合干扰总能量下降 <strong>{{ f(ngso.result.satPatternReductionDb, 1) }} dB</strong>；
            离轴 {{ ngso.result.farOffAxisDeg }}° 以外的贡献占比由 {{ f(ngso.result.farShareNoPatternPct, 1) }}% 变为
            <strong>{{ f(ngso.result.farSharePct, 1) }}%</strong>。
          </p>
          <p v-if="ngso.result.perf" class="ci-note sm">
            算力：共 {{ (ngso.result.perf.totalPropagations || 0).toLocaleString('en-US') }} 次轨道传播，
            可见性粗筛保留 {{ f(ngso.result.perf.screenKeptPct, 0) }}%（粗步 {{ f(ngso.result.perf.coarseSec, 0) }} s，掩码自身 {{ (ngso.result.perf.screenPropagations || 0).toLocaleString('en-US') }} 次），
            耗时 {{ ngso.result.elapsedMs }} ms。
          </p>
          <div class="ci-split">
            <div class="ci-split-l">
              <h3>CDF 分位</h3>
              <table class="ci-tb res">
                <thead><tr>
                  <th class="n">超越时间</th><th class="n">C/I dB</th>
                  <th v-if="ngso.result.epochStats" class="n">95% 区间</th>
                  <th class="n">有效样本</th>
                  <th v-if="ngso.result.iOverN" class="n" title="I/N 越大越劣，取自分布高端">I/N dB</th>
                  <th v-if="ngso.result.cOverNI" class="n" title="链路口径">C/(N+I) dB</th>
                  <th v-if="ngso.result.deltaTOverT" class="n" title="与 I/N 为同一比值的百分数表达">ΔT/T %</th>
                  <th class="n">年折合 (min/年)</th>
                </tr></thead>
                <tbody>
                  <tr v-for="[k, v] in ngPctRows" :key="k" :class="{ 'pct-none': v === null, 'pct-weak': ngSup(k) && ngSup(k).weak }">
                    <td class="num">{{ k }} %</td>
                    <td class="num" :title="ngSupTip(k)">
                      <template v-if="v !== null">
                        {{ f(v, 2) }}<sup v-if="ngSup(k) && ngSup(k).weak" class="pct-flag">弱</sup><sup v-if="ngSup(k) && ngSup(k).sampled" class="pct-flag samp">抽</sup>
                      </template>
                      <span v-else class="pct-short">样本不足</span>
                    </td>
                    <td v-if="ngso.result.epochStats" class="num dim">
                      <template v-if="ngCi(k)">±{{ f((ngCi(k).hi - ngCi(k).lo) / 2, 2) }}</template>
                      <template v-else>—</template>
                    </td>
                    <td class="num dim" :title="ngSupTip(k)">
                      <template v-if="ngSup(k)">
                        <template v-if="ngSup(k).enough">{{ ngSup(k).nEff < 100 ? ngSup(k).nEff.toFixed(1) : Math.round(ngSup(k).nEff).toLocaleString('en-US') }}</template>
                        <!-- 「需 ≥」单独成节点：与数字挤在一个文本节点里，英文模式下整串查不到表 -->
                        <template v-else><span>需 ≥</span> {{ ngSup(k).needSamples.toLocaleString('en-US') }}</template>
                      </template>
                      <template v-else>—</template>
                    </td>
                    <td v-if="ngso.result.iOverN" class="num">{{ f(ngso.result.iOverN[k], 2) }}</td>
                    <td v-if="ngso.result.cOverNI" class="num">{{ f(ngso.result.cOverNI[k], 2) }}</td>
                    <td v-if="ngso.result.deltaTOverT" class="num">{{ f(ngso.result.deltaTOverT[k], 3) }}</td>
                    <td class="dim num">{{ f(fYearMin(k), 1) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="ngso.result.sampled" class="ci-note sm">
                干扰星座抽样 1/{{ f(ngso.result.samplingFactorMax, 1) }}，聚合干扰偏低约 {{ f(10 * Math.log10(ngso.result.samplingFactorMax), 1) }} dB。
              </p>
              <p v-if="ngso.result.esPattern && ngso.result.esPattern.fellBack" class="ci-warn" title="AP8 为静态单干扰源的峰值包络，用于动态多干扰源场景偏保守">
                收信站离轴包络已由 S.1428 <strong>退回 AP8/S.580</strong>：{{ ngso.result.esPattern.reason }}。
              </p>

              <h3 title="干扰星进入规避角以内的时段">in-line 穿越事件</h3>
              <p class="ci-note sm">
                规避角 {{ f(ngso.result.inlineGuardDeg, 3) }}° · 天线 3 dB 全宽 {{ f(ngso.result.beamwidth3dBDeg, 3) }}°<template v-if="ngso.result.inlineRefined"> · 细步 {{ f(ngso.result.inlineFineStepSec, 2) }} s</template>
              </p>
              <table v-if="ngso.result.inlineEvents.length" class="ci-tb res">
                <thead><tr><th>起始</th><th class="n">时长</th><th class="n">最近离轴 °</th><th class="n">该段最差 C/I dB</th></tr></thead>
                <tbody>
                  <tr v-for="(e, i) in ngso.result.inlineEvents.slice(0, 24)" :key="i">
                    <td class="dim">{{ fTime(e.startMs) }}</td>
                    <td class="num">{{ fDur(e.durationSec) }}</td>
                    <td class="num">{{ f(e.minThetaDeg, 3) }}</td>
                    <td class="num">{{ f(e.worstCiDb, 1) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-else class="ci-note sm">本时窗内无穿越事件。</p>
              <p class="ci-note sm">
                合计 {{ f(ngso.result.inlineTotalSec, 1) }} s，占时 {{ f(ngso.result.inlineDutyPct, 5) }}%，折合每天 {{ f(ngso.result.inlinePerDay, 1) }} 次。
              </p>

              <p v-if="ngso.result.cdfAliasRisk" class="ci-warn" :title="`CDF 完整覆盖穿越事件所需步长 ≤ ${f(ngso.result.recommendedStepSec, 2)} s`">
                步长 {{ ngso.result.stepSec }} s 大于 in-line 穿越时长 {{ f(ngso.result.crossingSec, 2) }} s
                （干扰星视角速度 {{ f(ngso.result.interfererRateDegPerSec, 3) }} °/s），
                <strong>CDF 尾部可能漏采穿越事件</strong>。
              </p>
              <template v-if="ngso.result.perGroup && ngso.result.perGroup.length">
                <h3>单源分解</h3>
                <table class="ci-tb res">
                  <thead><tr><th>干扰星座</th><th class="n">星数</th><th class="n">聚合份额</th><th class="n">时均 I₀ dBW/Hz</th><th class="n">单入最坏 dBW/Hz</th><th>最坏时刻</th></tr></thead>
                  <tbody>
                    <tr v-for="g in ngso.result.perGroup" :key="g.id">
                      <td data-i18n-skip>{{ g.name }}</td>
                      <td class="num dim">{{ g.count }}</td>
                      <td class="num">
                        {{ f(g.sharePct, 1) }}%
                        <span class="share-bar"><i :style="{ width: Math.max(0, Math.min(100, g.sharePct || 0)) + '%' }" /></span>
                      </td>
                      <td class="num">{{ f(g.iAggDbW, 2) }}</td>
                      <td class="num">{{ f(g.worstSingleEntryDbW, 2) }}</td>
                      <td class="dim">{{ g.worstAtMs ? fTime(g.worstAtMs) : '—' }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>

              <template v-if="ngso.result.breach && (ngso.result.breach.ciPct != null || ngso.result.breach.iOverNPct != null || ngso.result.breach.deltaTPct != null)">
                <h3>越限时间占比</h3>
                <table class="ci-tb res">
                  <thead><tr><th>判据</th><th class="n">门限</th><th class="n">越限时间</th><th class="n">年折合 (min/年)</th></tr></thead>
                  <tbody>
                    <tr v-if="ngso.result.breach.ciPct != null">
                      <td>C/I</td><td class="num">&lt; {{ ngso.result.breach.criteria.ciDb }} dB</td>
                      <td class="num">{{ f(ngso.result.breach.ciPct, 4) }}%</td>
                      <td class="dim num">{{ f(fYearMin(ngso.result.breach.ciPct), 1) }}</td>
                    </tr>
                    <tr v-if="ngso.result.breach.iOverNPct != null">
                      <td>I/N</td><td class="num">&gt; {{ ngso.result.breach.criteria.iOverNDb }} dB</td>
                      <td class="num">{{ f(ngso.result.breach.iOverNPct, 4) }}%</td>
                      <td class="dim num">{{ f(fYearMin(ngso.result.breach.iOverNPct), 1) }}</td>
                    </tr>
                    <tr v-if="ngso.result.breach.deltaTPct != null">
                      <td>ΔT/T</td><td class="num">&gt; {{ ngso.result.breach.criteria.deltaTOverTPct }}%</td>
                      <td class="num">{{ f(ngso.result.breach.deltaTPct, 4) }}%</td>
                      <td class="dim num">{{ f(fYearMin(ngso.result.breach.deltaTPct), 1) }}</td>
                    </tr>
                  </tbody>
                </table>
              </template>

              <template v-if="ngso.result.availability">
                <h3>可用度</h3>
                <table class="ci-tb res">
                  <thead><tr><th>口径</th><th class="n">可用度</th><th class="n">年不可用 (h/年)</th></tr></thead>
                  <tbody>
                    <tr><td>仅雨衰</td><td class="num">{{ f(ngso.result.availability.noInterferencePct, 4) }}%</td><td class="dim num">{{ f((100 - ngso.result.availability.noInterferencePct) / 100 * 8760, 2) }}</td></tr>
                    <tr class="strong"><td>计入干扰</td><td class="num">{{ f(ngso.result.availability.withInterferencePct, 4) }}%</td><td class="dim num">{{ f((100 - ngso.result.availability.withInterferencePct) / 100 * 8760, 2) }}</td></tr>
                    <tr><td>所需补偿余量</td><td class="num">{{ f(ngso.result.availability.extraMarginDb, 2) }} dB</td><td class="dim num"></td></tr>
                  </tbody>
                </table>
                <p class="ci-note sm">
                  门限 C/(N+I) = {{ ngso.result.availability.thresholdDb }} dB；
                  干扰路径雨衰{{ ngso.result.availability.applyToInterference === 'same' ? '按等量施加' : '不施加' }}；
                  雨致噪温抬升{{ ngso.result.availability.noiseRiseIncluded ? '已计入' : '未计入' }}。
                </p>
              </template>

            </div>

            <div class="ci-split-r">
              <CiCdfPlot
                title="C/I 累积分布" file-name="NGSO时变_CI累积分布"
                :cdf="ngso.result.cdf" :percentiles="ngso.result.percentiles"
                :median-ci-db="ngso.result.medianCiDb" :threshold-db="ngso.thresholdDb" />

              <template v-if="ngso.result.series && ngso.result.series.length">
                <CiSeriesPlot
                  title="C/I 时序" file-name="NGSO时变_CI时序"
                  :series="ngso.result.series" :threshold-db="ngso.thresholdDb"
                  metric="ci" :show-elev="true" />
                <template v-if="ngso.result.iOverN">
                  <CiSeriesPlot
                    title="I/N 时序" file-name="NGSO时变_IN时序"
                    :series="ngso.result.series" :threshold-db="ngso.result.breach && ngso.result.breach.criteria.iOverNDb"
                    metric="iOverN" :show-elev="false" />
                </template>
              </template>
            </div>
          </div>
        </section>
      </template>
    </main>
    </section>
    </div>
    <WinStatusBar :n="N" :busy="busyText">
      <span v-if="busy && mode === 'ngso' && ngso.progressTotal" class="ci-sbprog"><i :style="{ width: (ngso.progress / ngso.progressTotal * 100) + '%' }"></i></span>
      <button v-if="busy && mode === 'ngso'" type="button" class="btn sm ci-sbcancel" @click="I.cancelNgso()">取消</button>
      <span v-if="busy && mode === 'cci' && cci.progressTotal" class="ci-sbprog"><i :style="{ width: (cci.progress / cci.progressTotal * 100) + '%' }"></i></span>
      <button v-if="busy && mode === 'cci' && cci.progressTotal" type="button" class="btn sm ci-sbcancel" @click="I.cancelCci()">取消</button>
      <span v-if="msg" class="ci-sbmsg" :title="msg">{{ msg }}</span>
    </WinStatusBar>
    <LbVersionsDialog v-model:open="verDlg.open" ns="ci" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side…）、功能区 .lbr、页签 .lbx-tabs 都在 styles/lbworkbench.css */
.ci-root { font-size: var(--fs-4); }
.ci-root .lb-configs { background: var(--surface); }
/* 状态栏里的进度条（中性色）与「取消」、各页的过程读数 */
.ci-sbprog { flex: none; width: 90px; height: 4px; background: var(--surface-2); border-radius: var(--r-ctl); overflow: hidden; }
.ci-sbprog > i { display: block; height: 100%; background: var(--text-muted); transition: width var(--dur-2) linear; }
.ci-sbcancel { height: 18px; }
.ci-sbmsg { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); }
.ci-btn { font: inherit; font-size: var(--fs-3); height: var(--h-ctl); white-space: nowrap; padding: 0 10px; cursor: pointer; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl, 4px); }
.ci-btn:hover:not(:disabled) { border-color: var(--border-strong); }
.ci-btn:disabled { opacity: 0.5; cursor: default; }

/* 「输入已变」小灯（与链路预算 / 雨衰同一款）：出过结果后入参又变了 → 提醒重算。
   挂在「结果」h2 里时不吃标题的字号 / 字重；挂在 .ci-panel-hd 里时由 flex gap 隔开 */
.ci-stale { display: inline-block; flex: none; font-size: var(--fs-2); font-weight: 400; letter-spacing: 0; line-height: 1.5; padding: 0 7px; color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); border-radius: var(--r-ctl); background: color-mix(in srgb, var(--warn) 8%, transparent); vertical-align: middle; }
.ci-panel > h2 .ci-stale { margin-left: 10px; }

.ci-main { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 18px; }

.ci-panel { margin-bottom: 20px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-box); }
.ci-panel > h2, .ci-panel-hd h2 { margin: 0 0 10px; font-size: var(--fs-5); font-weight: 700; }
.ci-panel h3 { margin: 14px 0 6px; font-size: var(--fs-4); font-weight: 700; color: var(--text-muted); }
.ci-panel-hd { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.ci-panel-hd h2, .ci-panel-hd h3 { margin: 0; flex: none; }
.ci-hd-tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
/* min-width:0 不能省：flex 项默认 min-width:auto，nowrap 的长站名会把它顶出面板而不是省略号 */
.ci-hd-sum { margin-left: auto; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-3); color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-sub { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); }

/* 「本站与本链路」输入带：按分组横排，组内是参数行 .srow（标签左、控件、单位右）。
   列窄且可换行：宽屏不把四组拉成四条空旷的横幅。 */
/* 轨道上限钉死 248px：写 1fr 的话，窗口一宽或列数一少，剩余宽度全灌进标签与值之间的空当，
   一行读数拉成两头见不着的横幅。宽屏多出来的宽度宁可空在右边，也不摊给已经够宽的列。 */
.ci-band { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 248px)); gap: 10px 26px; }
.ci-bcol > h3 { margin: 0 0 5px; padding-bottom: 3px; font-size: var(--fs-3); font-weight: 700; letter-spacing: var(--ls-tight); color: var(--text-muted); border-bottom: 1px solid var(--border); }
/* 参数行（controls.css 的 .srow：标签 + 控件 + 单位 .u）。本站与本链路输入带与各页表单同一种画法；
   没有单位的行也留一个空 .u，控件右沿才对得齐。标签列宽是下限，长标签自己撑开 */
.ci-band .srow, .ci-form .srow, .ci-currow { font-size: var(--fs-3); }
.ci-band .srow { --srow-lab: 56px; margin-bottom: 3px; }
.ci-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 300px)); gap: 4px 26px; }
.ci-form .srow { --srow-lab: 92px; }
.ci-form .srow.wide { grid-column: 1 / -1; }
.ci-form .srow.wide > .ci { flex: 0 1 380px; }
.ci-form.gap-t { margin-top: 6px; }
.ci-form input.ci[readonly] { background-color: var(--surface-2); color: var(--text-muted); }

/* 可编辑输入网格（ExcelGrid）：列宽按列定义钉死，末尾填充列吃掉余宽——短数字列不再摊满整幅 */
.ci-eg { max-height: 320px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: var(--r-ctl); }
.ci-eg :deep(td.eg-c.ci-ro .eg-v) { color: var(--text-muted); }
.ci-eg :deep(tr.off td.eg-c .eg-v) { color: var(--text-faint); }
/* NGSO 星历行的星座选择（网格下方，改活动行） */
.ci-currow { --srow-lab: 56px; margin-top: 6px; }
.ci-currow > select.ci { flex: 0 1 340px; }
.ci-rowno { font-family: var(--font-mono); color: var(--text-faint); }
.ci-ro-read { color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }

.ci-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(148px, 1fr)); gap: 8px 10px; }
.ci-grid.inline { grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); margin-bottom: 8px; }
.ci-grid label { display: flex; flex-direction: column; gap: 3px; font-size: var(--fs-3); color: var(--text-muted); }
.ci-grid input, .ci-grid select { font: inherit; font-size: var(--fs-4); padding: 4px 6px; color: var(--text); background-color: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 4px); }
.ci-grid input:focus, .ci-grid select:focus { outline: none; border-color: var(--accent-ui); }

/* 功能条里的复选（.ci-hd-tools）不在 .ci-grid 下，吃不到那边的字号 / 字色：这里自带，两处读起来一样 */
.ci-chk { display: inline-flex; flex-direction: row !important; align-items: center; gap: 5px !important; font-size: var(--fs-3); color: var(--text-muted); cursor: pointer; }
/* 换算出来的那一段值：填在上面、结果就在下面一行，不用等点「计算」才知道自己填的等于多少 */
/* 左侧是 3px 色条：色条那一边取直角，圆角只留在右侧，免得色条两端被削成月牙 */
.ci-derived { margin: 9px 0 0; padding: 6px 10px; font-size: var(--fs-3); line-height: 1.5; color: var(--text); background: var(--surface-2); border-left: 3px solid var(--accent); border-radius: 0 var(--r-box) var(--r-box) 0; }
.ci-derived b { font-size: var(--fs-4); font-weight: 700; font-variant-numeric: tabular-nums; }
.ci-derived span { color: var(--text-muted); font-size: var(--fs-3); margin-left: 4px; }
.ci-derived.off { color: var(--text-muted); border-left-color: var(--border-strong); }
.ci-radios { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; font-size: var(--fs-3); }
.ci-radios label { display: flex; align-items: center; gap: 5px; cursor: pointer; }
.ci-mini { font: inherit; font-size: var(--fs-3); padding: 3px 6px; background-color: var(--field-bg); color: var(--text); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 4px); }

.ci-tb { width: 100%; border-collapse: collapse; font-size: var(--lb-fs, 12.5px); }
/* 表头左右 10px = 格 4px + 输入框描边 1px + 内距 5px：列名与框里的字同一条竖线起笔；
   结果表（.res）格内距 8px，表头跟着收到 8px。数值列表头 .n 右对齐，与右对齐的数字同侧 */
.ci-tb th { padding: 4px 10px; font-size: var(--fs-3); font-weight: 600; text-align: left; color: var(--text-muted); border-bottom: 1px solid var(--border-strong); white-space: nowrap; }
.ci-tb th.n { text-align: right; }
.ci-tb td { padding: 2px 4px; border-bottom: 1px solid var(--border); }
.ci-tb.res thead th { padding-left: 8px; padding-right: 8px; }
.ci-tb tr.skip { opacity: 0.55; }
.ci-tb tr.hot { background: var(--surface-2); }
.ci-tb.res td, .ci-tb.res th[scope], .ci-tb.res tbody th { padding: 3px 8px; }
.ci-tb.res tbody th { text-align: left; font-weight: 500; color: var(--text-muted); border-bottom: 1px solid var(--border); }
/* 结果表三线（与链路预算结果同一口径）：顶 / 底线 --lb-rule-strong、栏目线 --lb-rule、行间 --lb-rule-soft */
.ci-tb.res { width: auto; min-width: 50%; border-top: 1px solid var(--lb-rule-strong); border-bottom: 1px solid var(--lb-rule-strong); }
.ci-tb.res thead th { border-bottom-color: var(--lb-rule); }
.ci-tb.res td, .ci-tb.res tbody th { border-bottom-color: var(--lb-rule-soft); }
.ci-tb.res tbody tr:last-child > * { border-bottom-color: var(--lb-rule-strong); }
.ci-tb.res tr.strong { font-weight: 700; }
.ci-tb .num { text-align: right; font-variant-numeric: tabular-nums; }
.ci-tb .dim { color: var(--text-muted); }
/* 逐源明细里星名后的轨位标记：从属于名字的次要信息，压暗一档、不与名字断行。
   字号写 em 不写 px —— 表格本体跟着 --lb-fs 走（9~16px 可调），写死 px 会在小字号档与星名同高、
   两者糊成一串读不出主次 */
.ci-tb .ci-slot { margin-left: 6px; font-size: .87em; color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }

/* 结果读数行（照模型工作台 .md-kv）：「标签 … 数值 单位」一行一个，自动分栏。原先是满宽磁贴，
   1560 宽下每枚约 300 px 只装一个数 */
.ci-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 0 20px; margin-bottom: 12px; }
.ci-kpi { display: flex; align-items: baseline; gap: 6px; min-height: 24px; border-bottom: 1px solid var(--lb-rule-soft); }
.ci-kpi span { flex: 1; min-width: 0; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-kpi b { font-size: var(--fs-4); font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ci-kpi b.sm { font-size: var(--fs-3); }
/* 「样本不足」不是一个数，别把它排得像一个数 */
.ci-kpi b.kpi-short { font-size: var(--fs-3); font-weight: 600; color: var(--text-muted); }

/* 分位表的样本支撑度：不足的整行压暗并划掉数字位，弱支撑只给个上标 */
.ci-tb.res tr.pct-none td { color: var(--text-muted); }
.ci-tb.res tr.pct-weak td.num { color: var(--warn); }
.pct-short { font-size: var(--fs-2); color: var(--text-muted); }
.pct-flag { font-size: var(--fs-1); font-weight: 700; margin-left: 2px; color: var(--warn); }
.pct-flag.samp { color: var(--danger); }

/* 单源分解的份额条：数值旁附一条细条，便于横向比较各座的贡献占比 */
.share-bar { display: inline-block; width: 46px; height: 5px; margin-left: 6px; vertical-align: middle; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.share-bar i { display: block; height: 100%; background: var(--accent); }
.ci-kpi i { font-size: var(--fs-2); font-style: normal; color: var(--text-faint); white-space: nowrap; }

.ci-split { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(300px, 0.85fr); gap: 20px; align-items: start; }
/* C/CCI 那对：图是主体，逐站取值六列全是短数字（实测自然宽 312px），给够读的宽度就行 ——
   表的上界钉死 400px（余量留给长站名与「无同色波束 / 域外」那格），多出来的宽度一律归图：
   信箱式 1°:1° 下栏宽直接决定图的大小，写 fr 会让超宽屏白空一大片表。
   不写 fit-content：栏宽跟着表内容跳，改个取值点名字整张图就重排一次。 */
.ci-split.cci { grid-template-columns: minmax(0, 1fr) minmax(320px, 400px); }
/* 媒体查询里必须把 .cci 一起点名：单类选择器压不住 .ci-split.cci 的特异度，塌单栏会失效 */
@media (max-width: 1180px) { .ci-split, .ci-split.cci { grid-template-columns: 1fr; } }
/* 两栏的标题行等高：左栏「算这张图」比 h3 高一截（.ci-btn 实测 24 px，字号写死不随 --lb-fs），
   不钉住的话 flex 居中会把右栏的「逐站取值」抬高 5 px —— 两个同级小标题差半行，一眼看得出。 */
.ci-split.cci .ci-panel-hd { min-height: 24px; }
/* 表窄到装不下时自己横滚，别把整个 grid 顶宽（grid 项默认 min-width:auto） */
.ci-tbwrap { min-width: 0; overflow-x: auto; }
/* C/CCI 逐波束统计：几十到几百个波束，表自己纵滚，别把整页拉长 */
.ci-tbwrap.tall { max-height: 420px; overflow-y: auto; }

.ci-note { margin: 6px 0 0; font-size: var(--fs-3); line-height: 1.55; color: var(--text-muted); }
.ci-note.sm { font-size: var(--fs-2); }
/* 取数失败的原因行：不是提示语气，要看得出是出了事 */
.ci-note.err { color: var(--danger); }
.ci-note strong { color: var(--text); font-weight: 600; }
.ci-warn { margin: 8px 0 0; padding: 7px 10px; font-size: var(--fs-3); line-height: 1.55; color: var(--text); background: color-mix(in srgb, var(--warn) 12%, transparent); border-left: 3px solid var(--warn); border-radius: 0 var(--r-box) var(--r-box) 0; }
.ci-warn strong { font-weight: 700; }

.ci-fieldwrap { margin-top: 10px; }
/* 星座实参速览：选了真实星座后代替 Walker 输入格 */
.ci-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 4px 14px; margin: 8px 0 0; padding: 8px 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-box); }
.ci-stats > div { display: flex; gap: 7px; align-items: baseline; font-size: var(--fs-3); }
.ci-stats > div.wide { grid-column: 1 / -1; }
.ci-stats dt { flex: none; color: var(--text-muted); font-size: var(--fs-3); }
.ci-stats dd { margin: 0; font-variant-numeric: tabular-nums; }
.ci-stats .dim { color: var(--text-muted); }

/* 邻星搜索：结果按与本星轨位的经度差排序，最近的在前 */
.ci-search { margin: 8px 0 10px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r-box); }
.ci-search-hd { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ci-search-hd input[type=text] { flex: 1 1 200px; min-width: 160px; font: inherit; font-size: var(--fs-4); padding: 4px 7px; color: var(--text); background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 4px); }
.ci-search-hd input[type=number] { font: inherit; font-size: var(--fs-4); padding: 4px 5px; color: var(--text); background: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 4px); }
.ci-search-hd label { display: flex; align-items: center; gap: 3px; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
.ci-search-msg { font-size: var(--fs-3); color: var(--text-muted); }
.ci-search-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; max-height: 168px; overflow-y: auto; }
.ci-hit { display: inline-flex; align-items: baseline; gap: 6px; font: inherit; font-size: var(--fs-3); height: var(--h-ctl); white-space: nowrap; padding: 0 9px; cursor: pointer; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.ci-hit:hover { border-color: var(--line-hover); background: var(--surface); }
.ci-hit b { font-weight: 600; }
.ci-hit .lon { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.ci-hit .dl { color: var(--accent); font-variant-numeric: tabular-nums; }
.ci-hit .incl { padding: 0 4px; font-size: var(--fs-1); color: var(--warn); border: 1px solid currentColor; border-radius: var(--r-box); }
.ci-btn.on { background: var(--surface-2); border-color: var(--border-strong); font-weight: 600; }

/* 结果区超门限只着色（RR 附录 8 的 6% 等），不出文字判定 */
.ci-tb td.st-bad, .ci-kpi b.st-bad { color: var(--danger); font-weight: 700; }
/* 协调触发页：频段起止两格并排在一个参数行的控件位里 */
.ci-range { flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; }
.ci-range > input.ci { flex: 1 1 0; min-width: 0; }
.ci-range > i { font-style: normal; color: var(--text-faint); }
.ci-band.ap8 { grid-template-columns: repeat(auto-fill, minmax(260px, 300px)); }
.ci-band.ap8 .srow { --srow-lab: 84px; }
/* 单位列等宽（dB(W/Hz) 与 m 混排时输入框右沿对齐）；方向图下拉与「取值」同一行，下拉让出宽度 */
.ci-band.ap8 .srow > .u { min-width: 58px; }
.ci-band.ap8 .srow select { min-width: 0; }
/* 协调触发明细表：段名行压一条栏目线，量名后的单位压暗一档 */
.ci-tb.res tr.grp th { padding-top: 8px; font-weight: 700; color: var(--text); border-bottom-color: var(--lb-rule); }
.ci-tb .ci-unit { margin-left: 6px; font-size: .87em; font-weight: 400; color: var(--text-faint); }

</style>
