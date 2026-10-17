<script setup>
// 端到端链路预算工作台（第四窗，多跳 / 混合转发）。
//
// 与前三窗的关系：三库（地球站 / 卫星 / 载波）与工作台范式照旧，独有的是「链」这个对象——
// 一行 = 一条端到端链路 = 节点序列 + hop 序列。计算只有正向电平递推一种（引擎 utils/linkChain.js），
// 因此功能区没有「计算方式」选择器：多跳下反算欠定，「该调哪个旋钮」由逐段余量排序（弱段高亮）承担。
// 几何全部手填（斜距 / 星间距离），留空即该行报错——不按轨道高度兜底换算。
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { askConfirm, confirmState } from '../shared/ui/useConfirm.js'   // 确认框（全平台一份）
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import CityPicker from '../components/CityPicker.vue'   // 站名旁「典型城市…」：与三窗 / 性能指标表同一份选点对话框
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import { useConfigAutosave } from '../shared/useConfigAutosave.js'
import { useConfigVersions } from '../shared/useConfigVersions.js'
import LbVersionsDialog from '../components/LbVersionsDialog.vue'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import LbDispCtl from '../components/LbDispCtl.vue'
import WinStatusBar from '../components/WinStatusBar.vue'
import { isUnitAdaptive, onUnitModeChange } from '../shared/lbUnitMode.js'   // 结果显示单位档（功能区「单位」，出厂锁定）
import { lbDocT } from '../shared/lbDocI18n.js'
import { waterfallTsv } from '../shared/lbWaterfallTsv.js'   // 详细预算整表复制（四窗一份）
import LbSlantTool from '../components/LbSlantTool.vue'
import LbIslRangeTool from '../components/LbIslRangeTool.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import BasebandPanel from '../ngso/BasebandPanel.vue'
import WaterfallTable from '../ngso/WaterfallTable.vue'
import LbSlaDialog from '../components/LbSlaDialog.vue'
import { deriveSla, normSlaParams, applyRowSla, setAdopt, setInclude, setAllInclude, clearAdopt, slaIncludeCount, slaChainSamplesFor, chainHopAvails, slaReportBlock, slaParamRows, DEFAULT_SLA_PARAMS , slaScanReportRows, slaComposition} from '../shared/lbSla.js'   // SLA 建议（四窗共用纯逻辑）
import { fmtQty, fmtQtyParts } from '../shared/adaptUnits.js'
import ChainStrip from './ChainStrip.vue'
import E2eFields from './E2eFields.vue'
import E2eSatPanel, { treeNodeOrbit, orbitToForm } from './E2eSatPanel.vue'   // 后两者：刷新卫星树时重解已选星（与面板选星同一份代码）
import { loadSatTree } from '../ngso/satTree.js'
import { loadCustomSats } from '../ngso/satSearchPool.js'   // 自定义星座星（现读，历元按当天场景历元规则解析）
import { pickedTreeNode, scenarioEpochPatch, pinCircularEpoch } from '../shared/lbTreeOrbit.js'
import { GEO_T0_MODES, normGeoT0Mode, normGeoT0ISO, geoT0State, resolveGeoT0ISO, sceneSecondISO, t0InputValue, parseT0Input } from '../shared/geoT0.js'   // 自动几何的搜索起点：时间轴 / 系统时钟 / 指定
import TzPicker from '../components/TzPicker.vue'
import { tzTag, normTzMode } from '../shared/tz.js'
import { fmtGeoSlot } from '../shared/orbitClass.js'   // 轨位 °E/°W 折算（西经不再写成负°E）
import {
  ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS,
  SAT_FIELDS, SAT_TXP_FIELDS, SAT_REGEN_FIELDS, SAT_INTF_UP_FIELDS, SAT_INTF_DN_FIELDS,
  NODE_ES_FIELDS, NODE_ES_TX_FIELDS, NODE_DEMOD_FIELDS, HOP_GS_FIELDS, HOP_ISL_FIELDS, HOP_LASER_FIELDS, GS_SIDE_DEFAULTS,
  defaultsFor, newEsNode, newSatNode, newHop, hopTypeOf, isSpaceHop, intfKeysFor, thresholdEffLive, segmentsOf, buildChain, uid,
  blankNgsoSat, normNgsoSat, orbitSpecOf, defaultCarrier, chainInfoRate, serializeChainsState,
  orbitAltKmOf, gsoLookAngles, suggestIslRangeKm
} from './e2eParams.js'
// 链路条的拓扑编辑（插入 / 删除 / 端点改型 / 端点外接 + 跳参数播种 + 体制移交）与 GSO 门限口径：纯数据逻辑在这份模块里
import { ensureSegCarriers, normEndpointKinds, insertNodeAt, removeNodeAt, toggleEndpointAt, extendEndAt, autoGeoMinElev } from './e2eChainEdit.js'
import { useLbReport } from '../shared/useLbReport.js'
import { syncAutoNames, adoptAutoFlag, withAutoFlag, newCfgName, newFolderName, copyNameOf } from '../shared/lbAutoName.js'
import { byLang, isDefaultName } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import { cityName, citySubtitle } from '../shared/cityName.js'   // 城市名同理（英文界面报 Beijing，选中后写进站名的也是它）
import { stableStringify } from '../shared/configDirty.js'
import { slantWgs84Max } from '../shared/slantRange.js'
import { pf } from '../shared/num.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'
// 图上链路导入（星座 3D 主窗「链路」视图建的链 → 本窗一条条链，见下方 importChains）
import LinkImportDialog from '../components/LinkImportDialog.vue'
import { esStationType } from '../shared/lbStationType.js'
import { radomeLossDb } from '../../packages/core/models/mapLinks.mjs'
import { findPoolByNorad, orbitSpecOf as poolOrbitSpecOf } from '../ngso/satSearchPool.js'   // 别名：e2eParams 另有一个按库条目出 spec 的 orbitSpecOf
import { isSatNamePlaceholder } from '../shared/lbAutoName.js'
import { validateRows } from '../shared/lbValidate.js'   // D6：计算前数值预校验（不是数 / 越出字段范围）
import { useNotice } from '../shared/useNotice.js'
import { reportError, reportPartial } from '../shared/reportError.js'
import { LIB_WINDOWS, libCopyTargets, copyLibEntry, externalLibEntries } from '../shared/lbShare.js'

const api = typeof window !== 'undefined' ? window.api : null
// 通知条（shared/useNotice.js）：toast＝普通回执，toastFile＝导出回执（附「打开 · 在文件夹中显示」），toastError＝常驻错误；
// 调用即把本窗登记为 reportError 的出口。必须先于下面的 useConfigTree（它要拿 toast）——const 不像函数声明那样提升。
const N = useNotice()
const { toast, toastFile, toastError } = N
const LIB_NS = 'e2e'
const ORBIT = 'E2E'

// ============ 左侧栏：配置列表 / 资源库（VS Code 活动栏范式，同屏一个上下文）============
const SIDE_KEY = 'e2e/sideView'
const sideView = ref((() => { const v = localStorage.getItem(SIDE_KEY); return (v === 'configs' || v === 'library' || v === '') ? v : 'configs' })())
watch(sideView, (v) => { try { localStorage.setItem(SIDE_KEY, v) } catch (e) { /* ignore */ } })
function toggleSide(v) { sideView.value = sideView.value === v ? '' : v }
const CFG_W_MIN = 180, CFG_W_MAX = 520, LIB_W_MIN = 300, LIB_W_MAX = 760
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('e2e/configsWidth')) || 210)))
const libWidth = ref(Math.min(LIB_W_MAX, Math.max(LIB_W_MIN, Number(localStorage.getItem('e2e/libWidth')) || 460)))
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
    try { localStorage.setItem(lib ? 'e2e/libWidth' : 'e2e/configsWidth', String(w.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 三库（全局资产，命名空间 'e2e'）============
let _esSeq = 1, _satSeq = 1
// 老场景迁移用：曾经有过一个「载波体制库」，体制现已下放到节点（见 e2eParams 的 CARRIER_FIELDS 头注）。
// 库本身不再有 UI，但存盘里那份原样留着（_legacyCarrierLib 读进来又写回去），供尚未打开过的老场景迁移。
let _legacyCarrierLib = []
const _legacyCarriers = new Map()   // id → form
const makeEsConfig = (name) => withAutoFlag({ id: 'es' + (_esSeq++), name: name || '', form: { ...defaultsFor(ES_FIELDS) } }, 'es')
// 卫星条目自带轨道来源 ngsoSat（GSO 走定点经度、NGSO 可手填或选星，见 E2eSatPanel）——
// 轨道是这颗星的属性，随库条目走，引用它的场景一致
const makeSatConfig = (name) => withAutoFlag({ id: 'sat' + (_satSeq++), name: name || '', form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: blankNgsoSat() }, 'sat')
const esConfigs = reactive([makeEsConfig('默认')])
const satConfigs = reactive([makeSatConfig('卫星1')])
const resolveEs = (id) => (id ? (esConfigs.find((c) => c.id === id) || esConfigs[0]) : esConfigs[0])
const resolveSat = (id) => (id ? (satConfigs.find((c) => c.id === id) || satConfigs[0]) : satConfigs[0])
// 引用悬空（库条目被删）：解析回退到第一份，行上打标（不崩，行标错误见 rowRefWarn）
const refDangling = (arr, id) => !!id && !arr.some((c) => c.id === id)

const esOptions = computed(() => [{ value: '', label: '（默认）' }, ...esConfigs.map((c) => ({ value: c.id, label: c.name }))])
const satOptions = computed(() => [{ value: '', label: '（默认）' }, ...satConfigs.map((c) => ({ value: c.id, label: c.name }))])

function addEsConfig() { esConfigs.push(makeEsConfig()); syncAutoNames(esConfigs, 'es') }
function addSatConfig() { satConfigs.push(makeSatConfig()); syncAutoNames(satConfigs, 'sat') }
function dupCfg(arr, cfg, pre, seqBump, extra) {
  arr.push({ id: pre + seqBump(), name: cfg.nameAuto ? '' : copyNameOf(cfg.name), nameAuto: !!cfg.nameAuto, form: JSON.parse(JSON.stringify(cfg.form)), ...(extra || {}) })
}
function duplicateEsConfig(c) { dupCfg(esConfigs, c, 'es', () => _esSeq++); syncAutoNames(esConfigs, 'es') }
function duplicateSatConfig(c) { dupCfg(satConfigs, c, 'sat', () => _satSeq++, { ngsoSat: normNgsoSat(c.ngsoSat) }); syncAutoNames(satConfigs, 'sat') }
async function removeLibEntry(arr, cfg, kind) {
  if (arr.length <= 1) return
  const n = refCount(kind, cfg.id)
  if (n > 0 && !(await askConfirm(`「${cfg.name}」正被 ${n} 处链路引用，删除后相关引用将回退到库中第一份配置。确定删除？`))) return
  const i = arr.indexOf(cfg); if (i >= 0) arr.splice(i, 1)
  _libGone.add(cfg.id)   // 获焦并库（mergeLibFromDisk）不许把它从盘上的旧副本里捡回来
}
// 本会话删掉的库条目 id（见 mergeLibFromDisk）
const _libGone = new Set()
function refCount(kind, id) {
  let n = 0
  const scan = (rows) => {
    for (const r of rows || []) {
      if (!r) continue
      for (const nd of r.nodes || []) {
        if (kind === 'es' && nd.kind === 'es' && nd.esId === id) n++
        if (kind === 'sat' && nd.kind !== 'es' && nd.satId === id) n++
      }
    }
  }
  scan(chains)
  for (const c of configs.value) { const st = c && c.state; if (st && Array.isArray(st.chains)) scan(st.chains) }
  return n
}
function removeEsConfig(c) { removeLibEntry(esConfigs, c, 'es') }
function removeSatConfig(c) { removeLibEntry(satConfigs, c, 'sat') }

let _libLoaded = false, _libT = null
function serializeLibrary() {
  return JSON.parse(JSON.stringify({
    es: esConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form })),
    carrier: _legacyCarrierLib,
    sat: satConfigs.map((c) => ({ id: c.id, name: c.name, nameAuto: !!c.nameAuto, form: c.form, ngsoSat: normNgsoSat(c.ngsoSat) })),
    seq: { es: _esSeq, sat: _satSeq }
  }))
}
function scheduleLibSave() {
  if (!_libLoaded || !api) return
  clearTimeout(_libT)
  _libT = setTimeout(() => { api.store.saveLibrary(LIB_NS, serializeLibrary()).catch((e) => reportError('资源库保存失败', e)) }, 500)   // 写盘失败常驻通知条
}
// 关窗前冲刷挂起的那次防抖写盘：库改动不入场景指纹，guardedLeave 拦不住它，改完 0.5 秒内关窗就丢
async function flushLibSave() {
  if (!_libLoaded || !api) return
  clearTimeout(_libT)
  try { await api.store.saveLibrary(LIB_NS, serializeLibrary()) } catch (e) { reportError('资源库保存失败', e) }   // 关窗途中失败不阻断，但要报出来
}
function applyLibrary(lib) {
  if (!lib) return
  if (Array.isArray(lib.es) && lib.es.length) esConfigs.splice(0, esConfigs.length, ...lib.es.map((c, i) => ({ id: c.id || ('esb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('es', c), form: { ...defaultsFor(ES_FIELDS), ...c.form } })))
  if (Array.isArray(lib.carrier)) {   // 老库：只留作迁移字典，不再进 UI
    _legacyCarrierLib = lib.carrier
    for (const c of lib.carrier) if (c && c.id) _legacyCarriers.set(c.id, c.form || {})
  }
  if (Array.isArray(lib.sat) && lib.sat.length) satConfigs.splice(0, satConfigs.length, ...lib.sat.map((c, i) => ({ id: c.id || ('satb' + (i + 1)), name: c.name || '', nameAuto: adoptAutoFlag('sat', c), form: { ...defaultsFor(SAT_FIELDS), ...c.form }, ngsoSat: normNgsoSat(c.ngsoSat) })))
  syncAutoNames(esConfigs, 'es'); syncAutoNames(satConfigs, 'sat')
  if (lib.seq) { _esSeq = Math.max(_esSeq, lib.seq.es || 1); _satSeq = Math.max(_satSeq, lib.seq.sat || 1) }
}
watch([esConfigs, satConfigs], () => {
  syncAutoNames(esConfigs, 'es'); syncAutoNames(satConfigs, 'sat')
  scheduleLibSave()
}, { deep: true, immediate: true })

const LIB_TABS = [
  { key: 'station', label: '地球站', tip: '站型收发射频参数库：链上地球站节点按引用套用' },
  { key: 'sat', label: '卫星', tip: '卫星库：轨道（GSO/NGSO）+ 透明转发器组 + 再生组 + 干扰八项，链上卫星节点按引用套用（行内可覆盖）' }
]
const libTab = ref('station')
const selEsId = ref(''), selSatId = ref('')
function editInLibrary(kind, id) {
  sideView.value = 'library'; libTab.value = kind
  if (kind === 'sat') selSatId.value = id || ''
  else selEsId.value = id || ''
}
const esSummary = (c) => [c.form.antennaDiameter ? c.form.antennaDiameter + ' m' : '', c.form.opPowerW ? c.form.opPowerW + ' W' : ''].filter(Boolean).join(' · ')
// 卫星条目摘要：先报轨道（GSO 报定点经度、NGSO 报选星名或高度/倾角），再报射频要点
const satOrbitBrief = (c) => {
  const f = c.form || {}
  if ((f.orbitClass || 'GSO') === 'GSO') return f.orbitLongitude !== '' && f.orbitLongitude != null ? `GSO ${fmtGeoSlot(Number(f.orbitLongitude)) || f.orbitLongitude + '°E'}` : 'GSO'
  const ns = c.ngsoSat
  if (ns && ns.mode !== 'manual' && ns.orbit) return `NGSO ${ns.name || ''}`.trim()
  return `NGSO ${f.orbitAltitude || '—'} km/${f.orbitInclination || '—'}°`
}
const satSummary = (c) => [satOrbitBrief(c), c.form.frequencyBand, c.form.gt ? 'G/T ' + c.form.gt : '', c.form.eirpSat ? 'EIRPs ' + c.form.eirpSat : ''].filter(Boolean).join(' · ')

// ============ 链路（一行 = 一条端到端链路）============
// 节点的出厂占位名（用户还没给这个站起名时叫的名字）。与库条目的兜底名同一性质：是界面语汇，
// 却以数据身份存进 configs.json、显示在检查器的「站点名称」输入框里 ⇒ 中英各备一份、生成时出对语言。
const NODE_NAMES = { es: ['地球站', 'Earth Station'], tx: ['发信站', 'Tx Station'], rx: ['收信站', 'Rx Station'], relay: ['转接站', 'Relay Station'] }
const nodeName = (k) => byLang(...NODE_NAMES[k])
function defaultChain(name) {
  const a = newEsNode(nodeName('tx')), s = newSatNode('txp'), b = newEsNode(nodeName('rx'))
  b.longitude = '109.5'; b.latitude = '18.25'
  const h1 = newHop('rf'), h2 = newHop('rf')
  Object.assign(h1, GS_SIDE_DEFAULTS.up); h1.slantRange = '39500'; h1.elevation = '25'
  Object.assign(h2, GS_SIDE_DEFAULTS.down); h2.slantRange = '38800'; h2.elevation = '32'
  // 载波体制落在【链首节点】上（含这条业务的信息速率，全程守恒）；下游再生节点建时照抄它
  a.carrier = defaultCarrier()
  return { _id: uid('c'), name: name || '', nameAuto: true, nodes: [a, s, b], hops: [h1, h2] }
}
// 每个段起点都得有一份具体的体制：ensureSegCarriers（e2eChainEdit.js）没有就整套照抄链首＝「和第一跳一致」。
// 链首那份体制（唯一定义业务速率的地方）
const headCarrier = computed(() => (cur.value && cur.value.nodes[0] && cur.value.nodes[0].carrier) || null)
const chains = reactive([defaultChain()])
const curIdx = ref(0)
const cur = computed(() => chains[curIdx.value] || null)
const sel = reactive({ type: 'node', index: 0 })
const results = reactive({})     // _id → 引擎 data
const errors = reactive({})      // _id → 报错文本
const curResult = computed(() => (cur.value ? results[cur.value._id] || null : null))
// 信息速率不守恒（3GPP 段的速率由本段物理层参数定，链首钉不住）：引擎逐段比对后报出，这里只陈述数字
const rateMismatchText = computed(() => {
  const d = curResult.value
  const mm = d && Array.isArray(d.rateMismatch) ? d.rateMismatch : []
  if (!mm.length) return ''
  return mm.map((m) => `第 ${m.seg} 段信息速率 ${m.rateKbps.toFixed(3)} kbps ≠ 链首 ${m.headKbps.toFixed(3)} kbps`).join('；')
})

// 链路自动命名：没起过名就随节点走（「发信站→收信站 · 1星2跳」），用户改过一次即钉死。
// 名字是数据（存进 configs.json、显示在 <input> 与打了 skip 的名字位上），呈现层翻不到 ⇒ 生成时按语言出字。
function chainAutoName(row) {
  if (!row) return ''
  const a = row.nodes[0], b = row.nodes[row.nodes.length - 1]
  const nSat = row.nodes.filter((n) => n.kind !== 'es').length
  const head = `${a && a.name ? a.name : ''}→${b && b.name ? b.name : ''}`
  const n = row.hops.length
  return `${head} · ` + byLang(`${nSat}星${n}跳`, `${nSat} sat${nSat > 1 ? 's' : ''}, ${n} hop${n > 1 ? 's' : ''}`)
}
function syncChainNames() {
  const used = new Set()
  for (const r of chains) {
    if (r.nameAuto === false) { used.add(r.name); continue }
    let nm = chainAutoName(r)
    if (used.has(nm)) { let i = 2; while (used.has(nm + ' ' + i)) i++; nm = nm + ' ' + i }
    r.name = nm; used.add(nm)
  }
}
function renameChain(row, v) {
  const nm = (v || '').trim()
  if (!nm) { row.nameAuto = true; syncChainNames(); return }
  row.nameAuto = false; row.name = nm
}
// ★ 这里曾引用一个不存在的 ensureChainRate（三轮的迁移函数，四轮删了定义漏了调用点）——
//   点「＋ 链路」当场 ReferenceError，按钮看起来没反应。新链的体制由 defaultChain/ensureSegCarriers 保证。
function addChain() { const c = defaultChain(); ensureSegCarriers(c); chains.push(c); syncChainNames(); curIdx.value = chains.length - 1; sel.type = 'node'; sel.index = 0 }
function duplicateChain(i) {
  const src = chains[i]; if (!src) return
  const copy = JSON.parse(JSON.stringify(src))
  copy._id = uid('c'); copy.name = src.nameAuto ? '' : copyNameOf(src.name)
  copy.nodes.forEach((n) => { n._id = uid('n') }); copy.hops.forEach((h) => { h._id = uid('h') })
  chains.splice(i + 1, 0, copy); syncChainNames(); curIdx.value = i + 1
}
function removeChain(i) {
  if (chains.length <= 1) return
  const id = chains[i]._id
  chains.splice(i, 1)
  delete results[id]; delete errors[id]
  curIdx.value = Math.min(curIdx.value, chains.length - 1)
}

// —— 链路条编辑：插入 / 删除 / 类型切换 ——
// 改拓扑的数据逻辑（跳参数按新类型重新播种、链首换人时移交业务体制、端点卫星归一为再生类）在
// e2eChainEdit.js，口径与踩过的坑见那边的头注；这里只建节点（站名按语言、站址按角色）、出提示、收尾刷新。
// 改拓扑即作废这条链上一次解出的自动几何：它是按【旧的】跳序解的，跳的增删会让它整体错位，
// 挂在新拓扑上显示就是张冠李戴。结果本身照旧留着（另有「输入已变」提示），只清几何。
function clearSolved(row) { if (row) delete geoSolved[row._id] }
// 编辑被挡住时的提示（e2eChainEdit 回提示键；文案留在窗口这一侧）
const EDIT_BLOCKED = {
  relayOnSpaceHop: '地面转接站仅能插在星间跳上（两端须是卫星）',
  minNodes: '链最少 2 个节点',
  esEsAfterRemove: '删除后将出现地球站直连地球站（非卫星链路）',
  esEs: '地球站不能直连地球站'
}
function afterEdit(row, r) {
  if (!r.ok) { if (r.error) toast(EDIT_BLOCKED[r.error] || r.error); return }
  clearSolved(row); syncChainNames(); markStale()
  sel.type = 'node'; sel.index = r.sel
}
function insertNode(hopIdx, kind) {
  const row = cur.value; if (!row) return
  const nd = kind === 'es' ? newEsNode(nodeName('relay')) : newSatNode(kind)
  if (kind === 'es') { nd.longitude = '104.0'; nd.latitude = '30.6' }
  afterEdit(row, insertNodeAt(row, hopIdx, nd))
}
function removeAt(kind, i) {
  const row = cur.value; if (!row) return
  if (kind !== 'node') return
  afterEdit(row, removeNodeAt(row, i))
}
function toggleKind(i) {
  const row = cur.value; if (!row) return
  const nd = row.nodes[i]; if (!nd || nd.kind === 'es') return
  // 端点卫星恒按「载荷直发 / 解调结算」口径（透明转发在链端没有来波或去处），不给切透明
  if (i === 0 || i === row.nodes.length - 1) { toast('端点卫星按载荷直发 / 解调结算口径，不设透明转发'); return }
  nd.kind = nd.kind === 'txp' ? 'regen' : 'txp'
  ensureSegCarriers(row); markStale()
}
// 端点在「地球站 ⇄ 卫星」之间切换：链两端不必是地球站——载波可以从星上发起（星上载荷直发），
// 也可以在星上解调结算（只算上行段）。切完相邻那一跳的类型会变（星地 ⇄ 星间），照例重新播种。
// 出厂占位站名切换端点时不带过去（「发信站」挂在卫星头上是张冠李戴）；用户自己起的名跟着走。
const PLACEHOLDER_NODE_NAMES = Object.values(NODE_NAMES).flat()
function toggleEndpoint(i) {
  const row = cur.value; if (!row) return
  const last = row.nodes.length - 1
  if (i !== 0 && i !== last) return
  const old = row.nodes[i]
  let nd
  if (old.kind === 'es') nd = newSatNode('regen', old.name && !PLACEHOLDER_NODE_NAMES.includes(old.name) ? old.name : '')
  else {
    nd = newEsNode(nodeName(i === 0 ? 'tx' : 'rx'))
    if (i !== 0) { nd.longitude = '109.5'; nd.latitude = '18.25' }
  }
  afterEdit(row, toggleEndpointAt(row, i, nd))
}

// 端点向外接一个节点：链首往前接、链尾往后接（链两端不必是地球站，故两种都可接）。
// 地球站直连地球站不是卫星链路 ⇒ 端点已是地球站时只让接卫星（菜单里也据此隐藏）。
function extendEnd(i, kind) {
  const row = cur.value; if (!row) return
  const head = i === 0
  const nd = kind === 'es' ? newEsNode(nodeName(head ? 'tx' : 'rx')) : newSatNode('regen')
  if (kind === 'es' && !head) { nd.longitude = '109.5'; nd.latitude = '18.25' }
  afterEdit(row, extendEndAt(row, i, nd))
}
function toggleLink(i) {
  const row = cur.value; if (!row) return
  const h = row.hops[i]; if (!h) return
  h.link = h.link === 'laser' ? 'rf' : 'laser'
  markStale()
}
function onSelect(s) { sel.type = s.type; sel.index = s.index }

// ============ 检查器 ============
const selNode = computed(() => (cur.value && sel.type === 'node') ? cur.value.nodes[sel.index] : null)
const selHop = computed(() => (cur.value && sel.type === 'hop') ? cur.value.hops[sel.index] : null)
const selHopType = computed(() => {
  if (!cur.value || sel.type !== 'hop') return null
  return hopTypeOf(cur.value.nodes[sel.index], cur.value.nodes[sel.index + 1], cur.value.hops[sel.index])
})
const selHopFields = computed(() => {
  const t = selHopType.value
  const base = (t === 'laser') ? HOP_LASER_FIELDS : (t === 'isl') ? HOP_ISL_FIELDS : HOP_GS_FIELDS
  if (geoManual.value) return base
  // 几何=自动：距离由求解器给出（不再是输入项，见 e2-auto 读数行），仰角字段此时是【最低仰角】门限
  return base
    .filter((f) => f.key !== 'slantRange' && f.key !== 'rangeKm')
    .map((f) => (f.key === 'elevation'
      ? { ...f, label: '最低仰角', tip: '本跳的最低工作仰角门限：自动几何据此解最差工况（斜距最大的那一刻）' }
      : f))
})
// 卫星节点：库条目做底、行内 ov 覆盖（空值 = 跟随库；占位符显示库里的数）
const selSatBase = computed(() => (selNode.value && selNode.value.kind !== 'es') ? (resolveSat(selNode.value.satId) || {}).form || {} : {})
// 地球站节点：库条目做底（功放功率的节点级覆盖用它当占位符）
const selEsBase = computed(() => (selNode.value && selNode.value.kind === 'es') ? (resolveEs(selNode.value.esId) || {}).form || {} : {})
// 链路条节点卡片的参数预览：行内 ov 优先、库条目兜底（EIRP / G/T 一眼可见，不用点进检查器）
function satVal(nd, key) {
  const ov = (nd && nd.ov) || {}
  if (ov[key] !== undefined && ov[key] !== null && ov[key] !== '') return ov[key]
  const f = ((satCfgOf(nd) || {}).form) || {}
  const v = f[key]
  return (v === '' || v == null) ? null : v
}
const selSatFields = computed(() => (selNode.value && selNode.value.kind === 'regen') ? SAT_REGEN_FIELDS : SAT_TXP_FIELDS)
// 干扰只显示【这颗星在这个位置上真正入账】的那几项：判据在 e2eParams.intfKeysFor（逐条对齐引擎口径）。
// 不生效的项不摆——摆着就是一排不进任何算式的数，读者无从分辨哪几个真在算。库里那份仍是全集
// （卫星的属性与它今天挂在链上哪个位置无关），改这几项去资源库编辑器。
const selIntfFields = computed(() => {
  if (!cur.value || !selNode.value || selNode.value.kind === 'es') return []
  const keys = intfKeysFor(cur.value.nodes, cur.value.hops, sel.index)
  return [...SAT_INTF_UP_FIELDS, ...SAT_INTF_DN_FIELDS].filter((f) => keys.includes(f.key))
})
// ============ 站名 ＝ 选址 ============
// 站名输入框本身就是城市搜索框（中文名 / 省份 / 拼音首字母 / 英文名 / 国家，含国际城市与航天地面站），
// 选中一条即把城市名与站址经纬度一并写入。站名与站址本是一件事，不再分成「站名」+「选址」两个控件。
// ★ 回车只在【显式高亮了某一条】时才落值（cityAt 仅由 ↑↓ / 悬停设定，每次检索复位 -1）——
//   否则用户敲完自定义站名顺手回车，就被下拉第一条把名字与经纬度一起改掉了。
const NODE_ES_SITE_FIELDS = NODE_ES_FIELDS.filter((f) => f.key !== 'name')
const cityOpen = ref(false)
const cityHits = ref([])
const cityAt = ref(-1)
const cityPopEl = ref(null)
const cityDlg = ref(false)   // 「典型城市…」对话框（CityPicker 单选：点一行即把站名与站址写入当前节点）
let cityTimer = null
// 检索走引擎 core.searchCities（与三窗、雨衰页同一套口径）；拿不到就退回本地城市表过滤
function cityLocal(q) {
  const all = cities.value || []
  if (!q) return all
  const s = q.toLowerCase()
  return all.filter((c) => [c.name, c.en, c.country, c.countryEn, c.py].some((x) => String(x || '').toLowerCase().includes(s)))
}
async function cityQuery(kw) {
  const q = String(kw || '').trim()
  let list = null
  if (api) { try { list = await api.linkBudget.searchCities(q) } catch (e) { list = null } }
  if (!Array.isArray(list)) list = cityLocal(q)
  cityHits.value = list.slice(0, 60)
  cityAt.value = -1
  cityFlip()
}
// 检查器整块坐在可滚动的 .lbx-flow 面板里：贴着面板下沿的节点，下拉往下开就被裁掉半截。
// 故按【所在裁剪盒内的上下余量】决定往哪边开、能开多高——命中列表恒完整可见，不靠用户去滚面板。
const CITY_POP_H = 236
const cityUp = ref(false)
const cityMaxH = ref(CITY_POP_H)
async function cityFlip() {
  await nextTick()
  const wrap = cityPopEl.value && cityPopEl.value.parentElement
  if (!wrap) return
  const r = wrap.getBoundingClientRect()
  let top = 0, bottom = window.innerHeight
  for (let el = wrap.parentElement; el; el = el.parentElement) {
    const cs = getComputedStyle(el)
    if (/(auto|scroll|hidden|clip)/.test(cs.overflowY)) {
      const b = el.getBoundingClientRect()
      top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom)
    }
  }
  const below = bottom - r.bottom, above = r.top - top
  const up = below < CITY_POP_H && above > below
  cityUp.value = up
  cityMaxH.value = Math.max(96, Math.min(CITY_POP_H, (up ? above : below) - 8))
}
function cityFocus() { cityOpen.value = true; cityQuery('') }   // 聚焦先给默认城市序（＝原「选址」下拉那份）
function cityInput() {
  cityOpen.value = true
  if (cityTimer) clearTimeout(cityTimer)
  const kw = (selNode.value && selNode.value.name) || ''
  cityTimer = setTimeout(() => cityQuery(kw), 140)
}
function cityClose() { cityOpen.value = false; cityAt.value = -1; if (cityTimer) { clearTimeout(cityTimer); cityTimer = null } }
function cityMove(d) {
  cityOpen.value = true
  const n = cityHits.value.length
  if (!n) return
  const at = cityAt.value < 0 ? (d > 0 ? -1 : 0) : cityAt.value
  cityAt.value = (at + d + n) % n
}
function cityEnter(e) {
  if (!cityOpen.value) return
  const c = cityAt.value >= 0 ? cityHits.value[cityAt.value] : null
  if (c) { e.preventDefault(); pickCity(c) } else cityClose()
}
function pickCity(c) {
  const nd = selNode.value
  if (!c || !nd || nd.kind !== 'es') return
  nd.name = cityName(c)
  nd.longitude = String(c.lon != null ? c.lon : c.longitude)
  nd.latitude = String(c.lat != null ? c.lat : c.latitude)
  cityClose(); markStale()   // 站址跟着城市走，降雨率/海拔由站址扫描接手（见下方 scanSites）
}
// 下拉行右侧的站址读数：与单元格同一套记法（经度恒为 °E 轴，西经记负；纬度北正南负）
const cityGeo = (c) => `${(+c.lon).toFixed(1)}°E ${(+c.lat).toFixed(1)}°N`
const citySub = citySubtitle
watch(cityAt, async (i) => {
  if (i < 0) return
  await nextTick()
  const el = cityPopEl.value && cityPopEl.value.children[i]
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
})
watch([() => sel.type, () => sel.index], () => cityClose())

// ============ 站址 → 降雨率 / 海拔（ITU 自动取值）============
// 这两项由经纬度唯一确定：R0.01% 取 ITU-R P.837，海拔取 P.1511 地形高程——与三窗、雨衰页
// 同一条 geoFill 通道。★ 变化锚定【经纬度这两个数】本身：只要它们变了（打字 / 选城市 / 粘贴 /
// 新建节点），降雨率与海拔就跟着变，不必失焦、不看是谁改的。取回来的值仍可手改，手改后到下次
// 动经纬度之前不再动它。取不到（数据未就绪 / 通道异常）保留原值，绝不写 0 兜底。
// ★ 载入存盘场景只记指纹、不重取：用户存下来的手改值优先（与几何建议值 scanGeoSeeds 同一条口径）。
const SITE_WAIT = 300        // 逐键敲的中间态（「1」「11」「116」…）收成一次：键还在敲就不打 IPC，停手即取
const _siteFp = new Map()    // node._id → 上次排过取值的站址 'lon|lat'（坐标不成数时记空串）
const _siteSeq = new Map()   // node._id → 请求序号：连改站址时只认最后一次回来的那份，防乱序
const _sitePend = new Map()  // node._id → 待取的请求 { lat, lon, rain, alt, timer }
// 排一次取值。★ 降雨率/海拔的快照在【发现站址变了】这一刻取，不在发请求那一刻：改完经纬度顺手
// 去改海拔的，等值回来时现值已不等于快照 ⇒ 那一格不覆盖，手填照旧压过自动值。
function scheduleSite(nd, lat, lon) {
  const pend = _sitePend.get(nd._id) || { rain: nd.rainRate, alt: nd.altitude }
  if (pend.timer) clearTimeout(pend.timer)
  pend.lat = lat; pend.lon = lon
  pend.timer = setTimeout(() => { _sitePend.delete(nd._id); fillSite(nd, pend) }, SITE_WAIT)
  _sitePend.set(nd._id, pend)
}
async function fillSite(nd, pend) {
  if (!api) return
  const seq = (_siteSeq.get(nd._id) || 0) + 1
  _siteSeq.set(nd._id, seq)
  let g = null
  try { g = await api.linkBudget.geoFill(pend.lat, pend.lon) } catch (e) { g = null }
  if (!g || _siteSeq.get(nd._id) !== seq) return
  if (g.rainRate != null && nd.rainRate === pend.rain) nd.rainRate = String(g.rainRate)
  if (g.altitude != null && nd.altitude === pend.alt) nd.altitude = String(g.altitude)
  // 站址取到的降雨率 / 海拔与手改一样随自动保存落盘（屏幕上是什么，盘上就是什么）。
  // ★ 不在这里推进基线：自动保存下那等于把它标成已落盘，它就永远写不进去
}
// 全链扫描。mode：
//   'live'  —— 站址与上次不同就重取（常态：打字 / 选城市 / 粘贴 / 新建或复制节点都走这条）；
//   'prime' —— 只记指纹（载入存盘场景：存盘值优先）；
//   'all'   —— 全部按站址重取（出厂默认场景：没有存盘值可优先）。
function scanSites(mode) {
  const seen = new Set()
  for (const row of chains) {
    for (const nd of row.nodes) {
      if (nd.kind !== 'es') continue
      seen.add(nd._id)
      const prev = _siteFp.get(nd._id)
      const lat = pf(nd.latitude), lon = pf(nd.longitude)
      // 清空一格打算重敲的中途：坐标暂时不成数 ⇒ 不取值也不清值，等敲成数了这一轮自会跟上
      if (!isFinite(lat) || !isFinite(lon)) { _siteFp.set(nd._id, ''); continue }
      const fp = lon + '|' + lat
      _siteFp.set(nd._id, fp)
      if (mode === 'all' || (mode === 'live' && prev !== fp)) scheduleSite(nd, lat, lon)
    }
  }
  for (const k of [..._siteFp.keys()]) {
    if (seen.has(k)) continue
    const p = _sitePend.get(k)
    if (p && p.timer) clearTimeout(p.timer)      // 节点已删：在途的那次取值连带作废
    _siteFp.delete(k); _siteSeq.delete(k); _sitePend.delete(k)
  }
}
// 站址就是链上的数据：盯 chains 即可，与「谁改的、改完有没有失焦」无关
watch(chains, () => scanSites('live'), { deep: true })

const nodeIsRelay = computed(() => !!(cur.value && selNode.value && selNode.value.kind === 'es' && sel.index > 0 && sel.index < cur.value.nodes.length - 1))

// —— 逐段载波体制 ——
// 再生类节点解调-重调即可换调制：它出发的那一段用它自己选的体制（不选＝跟随链路那份）。
// 段起点＝发信站 / 再生卫星 / 地面转接站 / 链首卫星，与引擎的分段口径同一套（segmentsOf）。
const segRanges = computed(() => segmentsOf((cur.value && cur.value.nodes) || []))
// 该节点【起】的段（发侧：在这里重新编码调制）与【止】的段（收侧：在这里解调）
const selSegIndex = computed(() => (cur.value && sel.type === 'node') ? segRanges.value.findIndex((s) => s.from === sel.index) : -1)
const selEndSegIndex = computed(() => (cur.value && sel.type === 'node') ? segRanges.value.findIndex((s) => s.to === sel.index) : -1)
// 本段那份体制：段起点节点自己那份，没有就是链首那份（＝和第一跳一致）
const segCarrierForm = (si) => {
  const sg = segRanges.value[si]
  const nd = (sg && cur.value) ? cur.value.nodes[sg.from] : null
  return (nd && nd.carrier) || headCarrier.value || {}
}
// 收侧那台解调器的实际门限 C/N = 入段体制的门限 C/N + 本节点的解调实现损失。
// 两项都只由这个面板上看得见的输入定，故就地算——没点过计算也有数，改体制 / 填损失当场跟上
// （口径与算式见 e2eParams.thresholdEffLive；门限 C/N 与门限 Es/N₀ 同值，那里有推导）。
// 纯激光段没有 C/N 门限（判据是接收光功率对所需接收功率）⇒ 不出这一行。
const selThresholdEff = computed(() => {
  if (!cur.value || selEndSegIndex.value < 0) return null
  const nodes = cur.value.nodes, i = sel.index
  if (i > 0 && hopTypeOf(nodes[i - 1], nodes[i], cur.value.hops[i - 1]) === 'laser') return null
  return thresholdEffLive(segCarrierForm(selEndSegIndex.value), (selNode.value || {}).demodLossDb)
})
// 段标尺上的体制名：业务速率（全链同一个）+ 本段调制与码率
function segCarrierName(si) {
  const f = segCarrierForm(si)
  const r = chainInfoRate(cur.value)
  const rate = (r !== null && isFinite(r)) ? fmtQtyRate(r) : ''
  return [rate, [f.modulation, f.fec].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
}
// kbps 读数自适应：≥1000 报 Mbps（与三窗结果列的档位口径一致）。
// 受功能区「单位」档节制（出厂锁定＝一律 kbps）；走 ref 而不是直接问 lbUnitMode，
// 否则切档时模板里这些读数不会重渲染。
const unitAdaptive = ref(isUnitAdaptive())
const fmtQtyRate = (kbps) => (unitAdaptive.value && Math.abs(kbps) >= 1000 ? (kbps / 1000).toFixed(3).replace(/\.?0+$/, '') + ' Mbps' : String(Number(kbps.toFixed(3))) + ' kbps')

// ============ 几何：手动 / 自动 ============
// 与 NGSO / 再生式两窗同一套口径，差别只在这里逐跳各解各的（一条链上每一跳的星、站、频率都不同）：
//   · 星地跳——按该跳卫星的轨道 + 地面端站址解最差工况：GSO 走静止几何（定点经度 → 斜距/仰角）、
//     NGSO 选星走平台 SGP4/SDP4、NGSO 手填走圆轨道闭式。此档下「仰角」字段是【最低仰角】门限。
//   · 星间跳——按两端卫星轨道解时窗内最差（最大）星间距离（双 SGP4 + 地球临边遮挡判可见）。
// ★ 自动档不改用户单元格：解出来的几何只写进【送算的那份链描述子】与 geoSolved（供检查器/链路条
//   显示），切回手动仍是用户自己填的那两个数——两档互不覆盖，切换不丢数。
const GEO_MODES = [{ v: 'manual', l: '手动' }, { v: 'auto', l: '自动最差' }]
const geoMode = ref(localStorage.getItem('e2e/geoMode') === 'auto' ? 'auto' : 'manual')
watch(geoMode, (v) => { try { localStorage.setItem('e2e/geoMode', v) } catch (e) { /* ignore */ } })
const geoManual = computed(() => geoMode.value === 'manual')
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 168, l: '7 天' }]
const geoHorizonHours = ref(Number(localStorage.getItem('e2e/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('e2e/horizonHours', String(v)) } catch (e) { /* ignore */ } })
// 搜索时窗起点（场景级，随场景存档；口径见 shared/geoT0.js）：时间轴 / 系统时钟 / 指定。
// 切到「指定」而还没有时刻时，以时间轴此刻（取整到秒）作初值。
const geoT0Mode = ref('scene')
const geoT0ISO = ref('')
watch(geoT0Mode, (m) => { if (m === 'fixed' && !normGeoT0ISO(geoT0ISO.value)) geoT0ISO.value = sceneSecondISO() })
// 「起点 = 指定」的时刻框按这个时区档位显示与解释（换档不改所指的瞬间；记在本机，同 NGSO / 再生式两窗的时标档位）。
// 草稿只在回车 / 失焦提交：datetime-local 每敲一键就发一次 input，年份段键到一半是 0002 —— 逐键提交会把公元 2 年落进场景。
const TZ_KEY = 'e2e/geo/tz'
const tzMode = ref(normTzMode((() => { try { return localStorage.getItem(TZ_KEY) } catch (e) { return null } })(), 'utc'))
watch(tzMode, (v) => { try { localStorage.setItem(TZ_KEY, String(v)) } catch (e) { /* ignore */ } })
const t0Draft = ref(null)
const t0Val = computed(() => (t0Draft.value != null ? t0Draft.value : t0InputValue(geoT0ISO.value, tzMode.value)))
const t0RefMs = computed(() => { const t = Date.parse(geoT0ISO.value); return Number.isFinite(t) ? t : Date.now() })
const t0TzTag = computed(() => (tzMode.value === 'utc' ? 'UTCG' : tzTag(tzMode.value, t0RefMs.value)))
function t0Commit() {
  const typed = t0Draft.value; t0Draft.value = null
  const iso = typed == null ? null : parseT0Input(typed, tzMode.value)
  if (iso) geoT0ISO.value = iso
}
// 卫星树（星座3D 页导入的星，作 NGSO 取星来源之一；窗口重获焦点时刷新）
const satTree = ref(loadSatTree().sats)
const geoSolved = reactive({})   // 链路_id → [{ slantRange, elevation } | { rangeKm }]，自动档解出的几何

const satCfgOf = (nd) => (nd && nd.kind !== 'es') ? resolveSat(nd.satId) : null
const satOrbitOf = (nd) => orbitSpecOf(satCfgOf(nd), satTree.value)
const satLabelOf = (nd) => (nd && (nd.name || ((satCfgOf(nd) || {}).name) || '')) || ''

// —— 手动几何的派生建议值（口径见 e2eParams.js 的 gsoLookAngles/suggestIslRangeKm 头注）——
// 换卫星 / 改仰角 / 改站址纬度海拔 ⇒ 斜距自动重算；GSO 星地跳连仰角一起回填（真几何，站与星定了
// 它就定了）；星间跳按两星轨道给建议距离。触发指纹只含【几何输入】，不含斜距/距离本身——
// 用户手改的格子在下一次几何输入变化前保持不动。自动档不扫（红线：自动档不改用户单元格）。
const _geoSeedFp = new Map()   // hop._id → 上次见到的几何输入指纹
function hopSeedInfo(row, i) {
  const a = row.nodes[i], b = row.nodes[i + 1], h = row.hops[i]
  const t = hopTypeOf(a, b, h)
  if (t === 'up' || t === 'down') {
    const es = t === 'up' ? a : b, satNode = t === 'up' ? b : a
    const spec = satOrbitOf(satNode)
    const lat = pf(es.latitude), altM = pf(es.altitude) || 0
    if (!spec || !isFinite(lat)) return null
    const empty = h.slantRange === '' || h.slantRange == null
    if (spec.type === 'snapshot') {
      const lon = pf(es.longitude)
      if (!isFinite(lon)) return null
      const g = gsoLookAngles(lon, lat, altM / 1000, spec.lonDeg)
      if (!g) return null                     // GSO 不可见：不动格子、不编数
      return {
        fp: `gso|${spec.lonDeg}|${lon}|${lat}|${altM}`, empty,
        apply: () => { h.slantRange = g.slantKm.toFixed(2); h.elevation = g.elevDeg.toFixed(2) }
      }
    }
    const altKm = orbitAltKmOf(spec), elev = pf(h.elevation)
    if (!(altKm > 0) || !isFinite(elev)) return null
    const d = slantWgs84Max(lat, altM / 1000, elev, altKm)
    if (!(d > 0)) return null
    return {
      fp: `ngso|${altKm.toFixed(1)}|${elev}|${lat}|${altM}`, empty,
      apply: () => { h.slantRange = d.toFixed(2) }
    }
  }
  if (t === 'isl' || t === 'laser') {
    const sa = satOrbitOf(a), sb = satOrbitOf(b)
    const d = suggestIslRangeKm(sa, sb)
    if (!(d > 0)) return null
    const key = (s2) => (s2.type === 'snapshot' ? 'g' + s2.lonDeg : 'n' + (orbitAltKmOf(s2) || ''))
    return {
      fp: `isl|${key(sa)}|${key(sb)}`,
      empty: h.rangeKm === '' || h.rangeKm == null,
      apply: () => { h.rangeKm = d.toFixed(1) }
    }
  }
  return null
}
function scanGeoSeeds(prime) {
  if (!geoManual.value) return
  const seen = new Set()
  for (const row of chains) {
    for (let i = 0; i < row.hops.length; i++) {
      const h = row.hops[i]
      seen.add(h._id)
      const info = hopSeedInfo(row, i)
      if (!info) { _geoSeedFp.delete(h._id); continue }
      const prev = _geoSeedFp.get(h._id)
      if (prev === info.fp) continue
      _geoSeedFp.set(h._id, info.fp)
      if (prime) continue                              // 场景载入：只记指纹，存盘值优先
      // 几何输入变了（prev 有值）⇒ 重算回填；新出现的跳只在格子为空时给建议值
      //（复制链路 / 载入分享包带来的既有数不动）
      if (prev !== undefined || info.empty) info.apply()
    }
  }
  for (const k of [..._geoSeedFp.keys()]) if (!seen.has(k)) _geoSeedFp.delete(k)
}
watch([chains, satConfigs, geoMode], () => scanGeoSeeds(false), { deep: true })
const stationGeoOf = (nd, hop) => ({
  lonDeg: pf(nd.longitude), latDeg: pf(nd.latitude), altKm: (pf(nd.altitude) || 0) / 1000,
  minElevDeg: pf(hop.elevation) || 0, freqGHz: pf(hop.frequency) || 14
})
// 解一条链的全部跳几何，就地写进 chain（送算的那份纯数据）。失败即返回报因，绝不兜底编数。
// 时窗起点按场景的「起点」设置取（shared/geoT0.js，与 NGSO / 再生式同口径）：时间轴此刻 / 点「计算」时的系统时间 / 指定时刻。
async function solveChainGeometry(row, chain) {
  const t0ISO = resolveGeoT0ISO(geoT0Mode.value, geoT0ISO.value)
  const solved = []
  for (let i = 0; i < row.hops.length; i++) {
    const a = row.nodes[i], b = row.nodes[i + 1], h = row.hops[i]
    const t = hopTypeOf(a, b, h)
    if (t === 'up' || t === 'down') {
      const es = (t === 'up') ? a : b, satNode = (t === 'up') ? b : a
      const orbit = satOrbitOf(satNode)
      if (!orbit) return { error: `第 ${i + 1} 跳：卫星「${satLabelOf(satNode)}」没有可用轨道（GSO 需定点经度；NGSO 需轨道高度或选一颗星）` }
      const st = stationGeoOf(es, h)
      // 站址与最低仰角是自动几何的两个必备入参：缺了求解器会按 0 兜底，那就成了「悄悄按赤道
      // 0°N/0°E、0° 仰角算」——宁可报因
      if (!isFinite(st.lonDeg) || !isFinite(st.latDeg)) return { error: `第 ${i + 1} 跳：地球站「${es.name || ''}」缺经纬度，无法解几何` }
      if (!isFinite(pf(h.elevation))) return { error: `第 ${i + 1} 跳缺最低仰角（°）——自动几何按它解最差工况` }
      // GSO 跳：这一格多半是手动档按真几何回填的两位小数（就近取整可高出真值 0.005°），门限按显示分辨率的一半放宽
      // （口径见 e2eChainEdit.autoGeoMinElev）；NGSO 门限决定最差斜距，原样
      st.minElevDeg = autoGeoMinElev(orbit, st.minElevDeg)
      let g = null
      try { g = await api.linkBudget.ngsoGeometry({ orbit, tx: st, rx: st, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { g = null }
      if (!g || !g.feasible) return { error: `第 ${i + 1} 跳几何无解：${(g && g.reason) || '求解失败'}` }
      const w = g.worst.up
      chain.hops[i].slantRange = w.slantKm.toFixed(2)
      chain.hops[i].elevation = w.elevDeg.toFixed(2)
      // tISO / win：本跳几何取自的那一刻（典型时刻 t*）与本次搜索时窗，供「在主窗口定位」（C3）
      solved.push({ slantRange: w.slantKm.toFixed(2), elevation: w.elevDeg.toFixed(2), method: g.method || '', tISO: (g.search && g.search.typicalISO) || '', win: g.search ? { t0ISO: g.search.t0ISO, hours: g.search.horizonHours } : null })
    } else {
      // 手动圆轨道历元钉到本链 t0（pinCircularEpoch）：主进程星间端点缺历元按计算那一刻补，与时间轴上的 t0 不同步
      const orbitA = pinCircularEpoch(satOrbitOf(a), t0ISO), orbitB = pinCircularEpoch(satOrbitOf(b), t0ISO)
      if (!orbitA || !orbitB) return { error: `第 ${i + 1} 跳：星间两端须各有可用轨道（「${satLabelOf(!orbitA ? a : b)}」缺轨道）` }
      let g = null
      try { g = await api.linkBudget.islGeometry({ orbitA, orbitB, t0ISO, horizonHours: geoHorizonHours.value, freqGHz: pf(h.frequency) || 23 }) } catch (e) { g = null }
      if (!g || !g.feasible) return { error: `第 ${i + 1} 跳星间几何无解：${(g && g.reason) || '求解失败'}` }
      // 两端解到同一位置（同一颗星 / 同一定点经度）时距离为 0：报因，别把 0 写进引擎再报「缺距离」
      if (!(g.worst.rangeKm > 0)) return { error: `第 ${i + 1} 跳星间距离解得 0 km（两端是同一颗星或同一定点经度）` }
      chain.hops[i].rangeKm = g.worst.rangeKm.toFixed(1)
      // 手动圆轨道（representative）的时刻只是示意，不给定位
      solved.push({ rangeKm: g.worst.rangeKm.toFixed(1), method: g.method || '', visibleFrac: g.visibility ? g.visibility.visibleFrac : null,
        tISO: (!g.representative && g.worst.worstISO) || '', win: g.search ? { t0ISO: g.search.t0ISO, hours: g.search.horizonHours } : null })
    }
  }
  return { solved }
}
// 本跳在自动档解出的几何（检查器/链路条读它显示；手动档为空）
const solvedHop = (rowId, i) => (geoSolved[rowId] || [])[i] || null
const curSolvedHop = computed(() => (cur.value && sel.type === 'hop') ? solvedHop(cur.value._id, sel.index) : null)

// ============ 计算 ============
const computing = ref(false)
const resultsStale = ref(false)
// 输入代次：每次 markStale +1（有没有结果都记）。compute 开算时记下、算完比一次 —— 算的途中改了链，
// 灯就保持亮（早先算完一律熄灯，期间那一笔改动从此不认账）
let _inGen = 0
function markStale() { _inGen++; if (Object.keys(results).length) resultsStale.value = true }

// —— 计算前预校验（D6）——
// 数值格不是数、或越出字段范围（schema 的 min / max，口径见 shared/lbValidate.js）：引擎按前缀解析会静默算出错数，
// 故开算前逐链查一遍——各跳（按跳的类型取字段表；自动几何下距离不是输入，不查）、地球站节点（站址 / 功放 / 解调）、
// 卫星节点的行内覆盖值。坏链不送引擎、该链结果清空并写明是哪一格；通知条常驻列出前 3 处与总数。
function chainBadItems(row) {
  const items = []
  const take = (where, fields, obj) => { for (const b of validateRows(fields, [obj || {}])) items.push(`${where} · ${b.label}：${b.msg}`) }
  ;(row.nodes || []).forEach((nd, k) => {
    const where = `节点 ${k + 1}`
    if (nd.kind === 'es') { take(where, NODE_ES_SITE_FIELDS, nd); take(where, NODE_ES_TX_FIELDS, nd) }
    else take(where, nd.kind === 'regen' ? SAT_REGEN_FIELDS : SAT_TXP_FIELDS, nd.ov)
    take(where, NODE_DEMOD_FIELDS, nd)
  })
  ;(row.hops || []).forEach((h, k) => {
    const t = hopTypeOf(row.nodes[k], row.nodes[k + 1], h)
    let fs = t === 'laser' ? HOP_LASER_FIELDS : t === 'isl' ? HOP_ISL_FIELDS : HOP_GS_FIELDS
    if (!geoManual.value) fs = fs.filter((f) => f.key !== 'slantRange' && f.key !== 'rangeKm')
    take(`第 ${k + 1} 跳`, fs, h)
  })
  return items
}
async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return }
  computing.value = true
  try {
    // 开算前先让已排队的「输入已变」监听跑完（点「计算」之前那一笔改动不算「期间」），再记输入代次
    await nextTick()
    const gen0 = _inGen
    // 链快照：本批只算开算那一刻的这些链（逐链几何与引擎之间有多次 IPC 往返，期间增删链不许让遍历跳行 / 重行）
    const jobChains = chains.slice()
    const chainOf = {}     // 送进引擎的那份链描述子（自动档已注入解出的几何），SLA 档位扫描要照它重跑
    // D6：逐链数值预校验（见 chainBadItems）——坏链不送引擎，该链结果清空并写明是哪一格；其余链照算
    const valItems = []
    const badChains = new Map()
    jobChains.forEach((row, ci) => {
      const items = chainBadItems(row)
      if (!items.length) return
      badChains.set(row, items.join('；'))
      for (const it of items) valItems.push(`第 ${ci + 1} 条链路 · ${it}`)
    })
    const valMsg = valItems.length ? valItems.slice(0, 3).join('；') + `；共 ${valItems.length} 处` : ''
    if (valMsg) toastError(valMsg)
    for (const row of jobChains) {
      const gone = () => !chains.includes(row)   // 期间被删掉的链：不再算、也不往结果表里落
      if (gone()) continue
      if (badChains.has(row)) { delete results[row._id]; delete geoSolved[row._id]; errors[row._id] = badChains.get(row); continue }
      const chain = buildChain(row, { es: resolveEs, sat: resolveSat })
      // 自动档：先按各跳的星与站解几何，写进这份链描述子（用户单元格不动）
      delete geoSolved[row._id]
      if (!geoManual.value) {
        const g = await solveChainGeometry(row, chain)
        if (gone()) continue
        if (g.error) { delete results[row._id]; errors[row._id] = g.error; continue }
        geoSolved[row._id] = g.solved
      }
      let r
      try { r = await api.linkBudget.chainCompute(chain) } catch (err) { r = { success: false, message: (err && err.message) || String(err) } }
      if (gone()) continue
      if (r && r.success) { results[row._id] = r.data; delete errors[row._id]; chainOf[row._id] = chain }
      else { delete results[row._id]; errors[row._id] = (r && r.message) || '计算失败' }
    }
    // 算的途中输入又变了：这批结果对应的是开算那一刻，灯保持亮。没有结果就无所谓过期（同 markStale）——
    // 算的途中换了配置，本批的链全不在了，灯不该替一份还没算过的配置亮着
    resultsStale.value = _inGen !== gen0 && Object.keys(results).length > 0
    const done = jobChains.filter((r) => chains.includes(r))
    const bad = done.filter((r) => errors[r._id]).length
    // 有校验报错时通知条留着它（常驻），不拿「已计算」回执顶掉
    if (valMsg) toastError(valMsg)
    else toast(bad ? `已计算 ${done.length} 条，其中 ${bad} 条报错` : `已计算 ${done.length} 条链路`)
    // SLA 档位扫描只在用得着时跑、且不 await（每链 9 档 = 9 次整链重算，不该跟着每次「计算」全表跑）
    _slaChainOf = chainOf
    invalidateSlaScan()
    if (slaWanted()) ensureSlaScan()
  } finally { computing.value = false }
}

// SLA 可用度档位扫描：整表一次批量 IPC（见 core 的 scanSlaTiers）。
// 端到端按同一个 k 缩放链上全部地球站节点的可用度（星间跳不参与），使系统可用度恰为该档；
// 不钉工作点——正向电平递推本就没有自由变量。会话态、不入存档；随结果一起过期。
// ★ 出 IPC 前必须现造纯数据：Vue 的 Proxy 过不了结构化克隆，invoke 当场抛且无 catch 时全静默。
let _slaChainOf = {}                 // 最近一次计算送进引擎的链描述子（按行 _id），惰性扫描要照它重跑
let _slaScanGen = 0, _slaScanDone = -1, _slaScanRun = null, _slaScanRunGen = -1
function invalidateSlaScan() { _slaScanGen++; for (const k of Object.keys(slaScanByRow)) delete slaScanByRow[k] }
// ★ 只认弹窗开着。别拿 slaCount 当闸：includeOf 缺键即「入报告」，任何算出结果的行都算勾了条款，
//   slaCount 恒等于有结果的行数 → 闸恒开，每次「计算」都全表 9 档扫一遍（2026-09-07 深审 #3）。
//   档位表与 MIR 之外没有别的消费者：导出含 SLA 的报告走 beforeSla 现补，弹窗打开时 ensureSlaScan。
const slaWanted = () => slaOpen.value
// 把当前这批结果的档位表补齐（已齐就直接返回）；弹窗打开、导出报告前调
async function ensureSlaScan() {
  if (_slaScanDone === _slaScanGen) return
  if (_slaScanRun) {
    if (_slaScanRunGen === _slaScanGen) return _slaScanRun
    await _slaScanRun
    return ensureSlaScan()
  }
  const gen = _slaScanGen
  _slaScanRunGen = gen
  _slaScanRun = refreshSlaScan(_slaChainOf, gen).finally(() => { _slaScanRun = null })
  return _slaScanRun
}
async function refreshSlaScan(chainOf, gen) {
  if (!api || !api.linkBudget.slaScanBatch) return
  const jobs = []
  for (const row of chains) {
    const d = results[row._id]
    const chain = chainOf[row._id]
    if (!d || !chain) continue
    const samples = slaChainSamplesFor(chainHopAvails(d))
    if (!samples.length) continue
    jobs.push({ rowId: row._id, spec: { engine: 'chain', chain, samples } })
  }
  if (!jobs.length) { if (gen === _slaScanGen) _slaScanDone = gen; return }
  try {
    const res = await api.linkBudget.slaScanBatch(JSON.parse(JSON.stringify(jobs.map((j) => j.spec))))
    if (gen !== _slaScanGen) return        // 期间又算过一轮：这份已过期
    jobs.forEach((j, i) => { if (res && res[i]) slaScanByRow[j.rowId] = res[i] })
    _slaScanDone = gen
  } catch (e) { /* 扫不出就不出档位表，结果本身不受影响 */ }
}

// ============ 详细预算文档区 ============
const segments = ref([])
const reportLang = ref(getLang())
onLangChange((l) => { reportLang.value = l; refreshDoc() })
// 自动生成的名字跟着换语言：库条目的兜底名、还挂着出厂占位名的节点、以及由节点名拼出的链路名。
// 全都只动「用户没起过名」的那些（库看 nameAuto、节点看是不是占位名、链路看 nameAuto），
// 用户自己起的名字一个不碰。名字确实变了 ⇒ 场景照常转脏，存不存由用户定。
onLangChange(() => {
  syncAutoNames(esConfigs, 'es'); syncAutoNames(satConfigs, 'sat')
  for (const row of chains) {
    for (const nd of row.nodes) {
      for (const k in NODE_NAMES) if (isDefaultName(nd.name, ...NODE_NAMES[k])) { nd.name = nodeName(k); break }
    }
  }
  syncChainNames()
})
async function refreshDoc() {
  const d = curResult.value
  if (!api || !d) { segments.value = []; return }
  let segs = []
  try { segs = await api.linkBudget.waterfall({ results: JSON.parse(JSON.stringify(d)), lang: reportLang.value, orbitType: ORBIT, adaptUnits: isUnitAdaptive() }) } catch (e) { segs = [] }
  // 等回包期间换了链 / 换了配置（结果已清）：这份是上一条的，不往上贴
  if (curResult.value === d) segments.value = segs
}
watch([curResult, curIdx], refreshDoc)
// 功能区「单位」档改动（本窗切换或别的链路预算窗改的）：速率读数就地跟上 + 详细预算重取一次。
// 不碰引擎——档位只管显示，数值一个没变。
let _offUnitMode = null
onMounted(() => { _offUnitMode = onUnitModeChange((v) => { unitAdaptive.value = v; refreshDoc() }) })
onBeforeUnmount(() => { if (_offUnitMode) _offUnitMode() })

// 拼表在 shared/lbWaterfallTsv.js（四窗一份）：多列段出列头（逐段汇总「C/(N+I) / 段余量」取段自带的 heads），
// 空格保位——早先这里把空串格滤掉再拼，符号列空着或某侧没值时整行左移、与列头错位
async function copyWaterfallTsv() {
  if (!segments.value.length) return
  try { await navigator.clipboard.writeText(waterfallTsv(segments.value, lbDocT(reportLang.value))); toast('已复制详细预算（TSV）') }
  catch (e) { toast('复制失败') }
}

// ============ SLA 建议 ============
// 功能区「导出 › SLA」→ LbSlaDialog，纯逻辑在 shared/lbSla.js。建议值只从链结果推导（本窗没有
// 「留底入参」那一层：链描述子由 buildChain 现组，可用度/频率/极化都能从 hops[] 与 transponders[]
// 直接读回）。带宽逐透明星一行，不合成链级数；MIR = CIR（逐段体制可不同，不做 ACM 外推）。
// 可用度构成按链上实际的实体数计：地球站几个就乘几个（链首按发信射频、其余按收信射频），卫星几颗
// 就乘几颗 —— 三跳的链比单跳多两个环节，承诺值本就该低一截。
// 采用值/勾选存在链上（row.sla），随场景与分享包自然带走；SLA 参数是场景级。
// ★ 弹窗自带链路下拉（slaIdx），与左侧链列表的聚焦项（curIdx）分开走：填 SLA 不该把详细预算
//   和拓扑图一起拽到别的链上去。打开时对齐到当前聚焦链，之后各走各的。
const slaParams = reactive({ ...DEFAULT_SLA_PARAMS })
const slaScanByRow = reactive({})     // 会话态：可用度档位扫描（compute 后批量求得，不入存档）
const slaOpen = ref(false)
const slaIdx = ref(0)
// 只列【算过】的链（有结果或有报错）：没算过的既没有数也没有报错，进了下拉就是一片空白
const slaOpts = computed(() => chains
  .map((row, i) => ({ i, row, label: `#${i + 1} ${row.name || ''}` }))
  .filter((o) => results[o.row._id] || errors[o.row._id])
  .map((o) => ({ i: o.i, label: o.label })))
const slaChain = computed(() => chains[slaIdx.value] || null)
const slaLinkName = computed(() => (slaChain.value ? (slaChain.value.name || '') : ''))
const slaLinkError = computed(() => (slaChain.value ? (errors[slaChain.value._id] || '') : ''))
// 结果是否对应「此刻这套输入」：输入已变、有链既没结果也没报错 → 补算一遍。
// 正在算（用户刚点过「计算」）就等它算完再判，不并发再起一轮。
function computeIdle() {
  if (!computing.value) return Promise.resolve()
  return new Promise((res) => { const stop = watch(computing, (v) => { if (!v) { stop(); res() } }) })
}
const allComputed = () => chains.every((r) => results[r._id] || errors[r._id])
async function ensureFreshResults(step) {
  await computeIdle()
  if (!resultsStale.value && allComputed()) return true
  if (step) step(reportLang.value === 'en' ? 'Computing…' : '计算…', 0, 1)
  await compute()
  return !resultsStale.value && allComputed()
}
// 建议值必须出自「此刻这套输入」：没算过或输入已变，先算一遍再开
async function openSlaDlg() {
  if (!(await ensureFreshResults())) return
  // 对齐到当前聚焦链；它要是还没算过（不在下拉里），退到第一条算过的 —— 否则下拉框空着、
  // 正文也空着，看着像坏了
  const i0 = Math.min(Math.max(0, curIdx.value), Math.max(0, chains.length - 1))
  const opts = slaOpts.value
  slaIdx.value = opts.some((o) => o.i === i0) ? i0 : (opts.length ? opts[0].i : i0)
  slaOpen.value = true
  ensureSlaScan()
}
// 删链后下标可能越界：退回第一条，免得弹窗里一片空白、看着像算漏了
watch(() => chains.length, (n) => { if (slaIdx.value >= n) slaIdx.value = 0 })
function slaDerivedFor(row) {
  const d = row ? results[row._id] : null
  if (!d) return null
  const nds = row.nodes || []
  return deriveSla({
    orbitType: 'E2E',
    data: d, ok: !errors[row._id], error: errors[row._id] || '',
    resolvedMargin: parseFloat(d.e2eMarginResult),
    params: null,
    carrierForm: (nds[0] && nds[0].carrier) || {},
    modcodRows: [],
    scan: slaScanByRow[row._id] || null,
    fp: null,
    slaParams,
    esCount: nds.filter((n) => n && n.kind === 'es').length,
    satCount: nds.filter((n) => n && n.kind !== 'es').length
  })
}
const slaDerived = computed(() => slaDerivedFor(slaChain.value))
const slaCount = computed(() => chains.reduce((n, row) => n + (results[row._id] && slaIncludeCount(slaDerivedFor(row), row.sla) ? 1 : 0), 0))

// —— 独立《服务等级指标（SLA）》报告 ——
// 逐链路的附加料：载波体制（决定引用哪几份标准）/ MODCOD / 档位表（综合与中断按考核周期算好）
function slaReportExtra(l) {
  const row = chains.find((r) => r._id === l.rowId)
  const f = ((row && row.nodes && row.nodes[0] && row.nodes[0].carrier)) || {}
  return { carrierStd: f.dvbStandard || 'custom', modcod: f.modcodLabel || '', scan: slaScanReportRows(row ? slaDerivedFor(row) : null) }
}
function slaDefaultNameOf(en) {
  const n = (cur.value && cur.value.name) || ''
  return en
    ? `E2E_SLA_${(n || 'Results').replace(/[^\w-]+/g, '_')}`
    : `端到端服务等级指标_${(n || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
}
// row.sla 挂在链上，会被「结果过期」那条深监听盯到——但采用值是【结论】不是引擎入参，
// 改它一个字也不会让已出的结果失效。故写完把过期灯还原（深监听是 pre-flush，nextTick 时它已跑过）。
function slaTouch(fn) { const keep = resultsStale.value; fn(); nextTick(() => { resultsStale.value = keep }) }
function slaSetAdopt(e) { const r = slaChain.value; if (r) slaTouch(() => applyRowSla(r, setAdopt(r.sla, e.key, e.value))) }
function slaSetInclude(e) { const r = slaChain.value; if (r) slaTouch(() => applyRowSla(r, setInclude(r.sla, e.key, e.value))) }
function slaSetParam(e) { if (e.value != null) slaParams[e.key] = e.value }
function slaToggleAll(on) { const r = slaChain.value; if (r) slaTouch(() => applyRowSla(r, setAllInclude(r.sla, slaDerived.value, on))) }
// 「重置」两件事一起做：本条链路的采用值清空（回到建议值）+ SLA 参数回到缺省 ——
// 参数是场景级的，可它只在这个弹窗里露面，另设一颗按钮反而找不着。
function slaClear() {
  slaTouch(() => {
    const r = slaChain.value
    if (r) applyRowSla(r, clearAdopt(r.sla))
    Object.assign(slaParams, DEFAULT_SLA_PARAMS)
  })
}
const slaAllOn = computed(() => {
  const r = slaChain.value, d = slaDerived.value
  if (!r || !d) return true
  return d.order.every((k) => !(r.sla && r.sla.include && r.sla.include[k] === false))
})

// ============ 交付级报告（Excel / Word / PDF）============
// 流程与三窗共用（shared/useLbReport.js → shared/lbReport.js 组模型 → 主进程三个渲染器），
// 此处只把本窗的数据源接上去。两处与三窗不同，都是本窗的事实而不是新口径：
//   ① 一条【链】就是三窗口径里的一条【链路】：#N、发信站 → 收信站取链首/链尾节点名。
//   ② 不带 inputs（三窗的「输入参数」块走各自的 FIELD_GROUPS + 单条链路一份入参）——
//      端到端的入参逐节点、逐跳各一份，而它们已经由瀑布的 cls:'param' 三段（载波与调制 /
//      逐跳几何与时延 / 收发链参数）逐项列全了。另立一份字段字典只会与表单漂移。
//   ③ 没有图表区（本窗不出地理场图 / 链路视图），故 vizAvailable=false、恒不带图。
// segments 交给主进程按 orbitType 现补（同一个 buildWaterfallSegments，与屏幕同源），
// 于是「全部链」都有全量段，而不只是屏幕上正看着的那一条。
// 只收【算过】的链（有结果或有报错）：没算过的既没有数也没有报错，进了报告就是一张空详情表。
// 报错的照旧带上——三窗也带，详情表会写明「计算失败：…」，不让一条链在报告里静默消失。
const reportLinks = computed(() => chains
  .filter((row) => results[row._id] || errors[row._id])
  .map((row) => {
    const nds = row.nodes || []
    const d = results[row._id]
    // #N 由 useLbReport 按导出序编（与三窗同一口径），此处不自带序号
    return {
      rowId: row._id,
      txName: (nds[0] && nds[0].name) || '', rxName: (nds[nds.length - 1] && nds[nds.length - 1].name) || '',
      ok: !!d, error: errors[row._id] || '',
      // ★ 出 IPC 前必须是纯数据：Vue 的 Proxy 过不了结构化克隆
      data: d ? JSON.parse(JSON.stringify(d)) : null
    }
  }))
const { reportDlg, reportVariant, openReportDialog, openSlaReportDialog, submitReport } = useLbReport({
  api,
  orbitType: ORBIT,
  fieldGroups: [],
  nextTick,
  links: () => reportLinks.value,
  // 报告讲【全部链、当前输入】：没算过 / 输入已变的导出前先补算（口径同再生式 computeMissing）。
  // 逐链报错照旧作为「计算失败」进报告。
  canReport: () => chains.length > 0,
  beforeReport: async (step) => { if (!(await ensureFreshResults(step))) throw new Error('计算失败') },
  selected: () => curIdx.value,
  setSelected: (i) => { curIdx.value = i },
  showViz: () => false,
  vizRef: () => null,
  lang: () => reportLang.value,
  appVersion: () => appVersion.value,
  paramsFor: () => null,
  // 总报告「逐参数对照」头两行（标准 / 调制编码）：逐段交出该段起点节点那份载波体制（段切割与
  // buildChain 同一口径：段起点没有自己那份就照抄链首），标准名由 useLbReport 解析、调制编码取引擎逐段回显
  carrierOf: (l) => {
    const row = chains.find((r) => r._id === l.rowId)
    if (!row) return null
    const nds = row.nodes || []
    const head = { ...defaultCarrier(), ...((nds[0] && nds[0].carrier) || null) }
    return segmentsOf(nds).map((sg) => ({ ...head, ...((nds[sg.from] && nds[sg.from].carrier) || null) }))
  },
  basebandOpts: () => basebandOpts.value,
  // SLA 建议（§4）：逐条链出纯数据块（标签按报表语言翻好、速率/带宽按当前单位档格式化）
  slaFor: (l) => {
    const row = chains.find((r) => r._id === l.rowId)
    return slaReportBlock(slaDerivedFor(row), row && row.sla, slaParams, reportLang.value,
      (v, u) => fmtQtyParts(v, u, unitAdaptive.value))
  },
  slaParams: () => slaParamRows(slaParams, reportLang.value),
  beforeSla: ensureSlaScan,   // 导出含 SLA 的报告前把惰性扫描补齐
  // 卫星名/频段留空：一条链跨几颗星、上下行各一个频段，取其一填进封面就是以偏概全。
  // 计算方式是本窗唯一的那一种，如实报出。
  calc: () => ({ satelliteName: '', frequencyBand: '', mode: reportLang.value === 'en' ? 'Forward level recursion' : '正向电平递推' }),
  // —— 独立《服务等级指标（SLA）》报告：不取图、不组瀑布，只把各链的 SLA 块与档位表组成模型 ——
  slaCount: () => slaCount.value,
  slaMonthly: () => (Number(slaParams.monthly) ? 1 : 0),
  slaComposition: () => {
    const row = chains.find((r) => results[r._id]) || chains[0]
    const nds = (row && row.nodes) || []
    return slaComposition({
      orbitType: ORBIT, slaParams,
      esCount: nds.filter((n) => n && n.kind === 'es').length,
      satCount: nds.filter((n) => n && n.kind !== 'es').length
    }, reportLang.value)
  },
  slaExtra: (l) => slaReportExtra(l),
  slaDefaultName: (en) => slaDefaultNameOf(en),
  defaultName: (en) => {
    const n = (cur.value && cur.value.name) || ''
    return en
      ? `E2E_Link_Budget_Report_${(n || 'Results').replace(/[^\w-]+/g, '_')}`
      : `端到端链路预算报告_${(n || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  toastFile,
  setError: (m) => toastError(m)   // 导出失败等进常驻通知条（不随 4 s 回执消失）
})

// ============ 工具：斜距 / 星间距离 ============
const slantToolOpen = ref(false)
const islToolOpen = ref(false)
// 斜距工具挂在【当前选中的星地跳】上：工具交回的是轨道高度，斜距按该跳地面端的站址纬度/海拔
// 与本跳仰角走 WGS-84「绕站一圈最大值」算出（口径与 NGSO / 再生式两窗完全一致，见 shared/slantRange.js）。
// scope='all' 时把本链路全部星地跳按各自的站址与仰角一起填。
const gsHops = computed(() => {
  if (!cur.value) return []
  const out = []
  cur.value.hops.forEach((h, i) => {
    const t = hopTypeOf(cur.value.nodes[i], cur.value.nodes[i + 1], h)
    if (t === 'up' || t === 'down') out.push({ hop: h, es: t === 'up' ? cur.value.nodes[i] : cur.value.nodes[i + 1] })
  })
  return out
})
const slantToolPair = computed(() => {
  if (!cur.value || sel.type !== 'hop') return null
  const t = selHopType.value
  if (t !== 'up' && t !== 'down') return null
  return { hop: cur.value.hops[sel.index], es: t === 'up' ? cur.value.nodes[sel.index] : cur.value.nodes[sel.index + 1] }
})
// 轨道 spec → 代表高度：orbitAltKmOf 已上移到 e2eParams.js（几何建议值与斜距工具共用）
// 工具初值的轨道高度：优先取本跳那颗星【自己的轨道】（GSO 35786 / NGSO 选星或手填的高度）——
// 卫星库有了轨道之后，这个数不该再靠斜距反推。星没有轨道时才退回由斜距 + 仰角反推一个量级。
const slantToolAlt = computed(() => {
  const p = slantToolPair.value
  if (!p) return 1145
  if (cur.value && sel.type === 'hop') {
    const t = selHopType.value
    const satNode = (t === 'up') ? cur.value.nodes[sel.index + 1] : cur.value.nodes[sel.index]
    const h = orbitAltKmOf(satOrbitOf(satNode))
    if (h > 0) return Math.round(h)
  }
  const d = pf(p.hop.slantRange), e = pf(p.hop.elevation)
  if (!(d > 0) || !isFinite(e)) return 1145
  const lat = pf(p.es.latitude) || 0, alt = (pf(p.es.altitude) || 0) / 1000
  // 由「绕站一圈最大斜距」单调递增反解轨道高度（二分，够工具初值用）
  let lo = 100, hi = 45000
  for (let k = 0; k < 60; k++) { const mid = (lo + hi) / 2; if (slantWgs84Max(lat, alt, e, mid) < d) lo = mid; else hi = mid }
  return Math.round((lo + hi) / 2)
})
function applySlantFill({ altKm, scope }) {
  const list = scope === 'row' ? [slantToolPair.value].filter(Boolean) : gsHops.value
  let n = 0
  for (const { hop, es } of list) {
    const d = slantWgs84Max(pf(es.latitude) || 0, (pf(es.altitude) || 0) / 1000, pf(hop.elevation), altKm)
    if (d > 0) { hop.slantRange = d.toFixed(2); n++ }
  }
  slantToolOpen.value = false
  markStale()
  toast(n ? `已按各跳站址与仰角填入 ${n} 处斜距（轨道高度 ${Number(altKm).toFixed(0)} km）` : '没有可填的星地跳')
}
const spaceHops = computed(() => {
  if (!cur.value) return []
  return cur.value.hops.filter((h, i) => isSpaceHop(hopTypeOf(cur.value.nodes[i], cur.value.nodes[i + 1], h)))
})
// 距离工具的两端候选＝卫星库条目，各带自己的轨道（GSO 定点 / NGSO 选星或手填）；
// 库里那颗星没有可用轨道时 orbit 为 null，工具里退回「自定义轨道」四项。
const islToolSats = computed(() => satConfigs.map((c) => ({ id: c.id, name: c.name || c.form.satelliteName || c.id, orbit: orbitSpecOf(c, satTree.value), summary: satSummary(c) })))
const islToolHop = computed(() => (sel.type === 'hop' && isSpaceHop(selHopType.value)) ? cur.value.hops[sel.index] : null)
// 打开工具时两端直接落在本跳那两颗星上
const islToolSrc = computed(() => {
  if (!cur.value || sel.type !== 'hop' || !isSpaceHop(selHopType.value)) return { a: '', b: '' }
  const a = cur.value.nodes[sel.index], b = cur.value.nodes[sel.index + 1]
  const idOf = (nd) => ((satCfgOf(nd) || {}).id || '')
  return { a: idOf(a), b: idOf(b) }
})
function applyIslRangeFill({ rangeKm, scope }) {
  const list = scope === 'row' ? [islToolHop.value].filter(Boolean) : spaceHops.value
  let n = 0
  for (const h of list) { if (rangeKm > 0) { h.rangeKm = Number(rangeKm).toFixed(1); n++ } }
  islToolOpen.value = false
  markStale()
  toast(n ? `已填入 ${n} 处星间链路距离` : '没有可填的星间跳')
}

// ============ 场景持久化 ============
const STATE_KEY = 'e2e/last'
// 配置列表：持久化到 userData/configs.e2e.json（store.config.*，各工作台一份互不见面）。
// 树的全部行为（增删改移 / 剪贴板 / 右键 / 键盘）在 shared/useConfigTree.js，五个工作台共用一份。
// ★ 本窗早先自建了一份精简树，漏掉的东西是实打实的故障：onMove 把 ConfigTree 的 dragId 原样
//   透传给期待 id 的 IPC（拖拽整条静默失效）、右键 @context 没接（.prevent 还把系统菜单一并吃掉）、
//   剪贴板整套没有、新建配置不载入也不展开父级（存进去了却看不见，随后「保存」写回的还是旧配置）。
//   收进公共实现后这些一次补齐。
// 场景自动保存（2026-10-06 起取代「保存」按钮）：工作区恒对应一份配置，改动约 1 s 后写回（shared/useConfigAutosave.js）；
// 后悔药是历史版本（shared/useConfigVersions.js + LbVersionsDialog）。localStorage 只记「上次打开的是哪一份」。
const cfgTree = useConfigTree({
  ns: 'e2e', orbitType: ORBIT, api, storageKey: 'e2e/expandedFolders',
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
  ns: 'e2e', api, activeId, itemById: cfgTree.itemById, serialize: serializeState, fingerprint: fingerprintOf,
  autoName: defaultCfgName, uniqueName: uniqueCfgName, summarize: (st) => ({ label: cfgLabelOf(st) }), toast
})
const { error: saveError } = autosave
let stopAutosaveListen = null
onBeforeUnmount(() => { if (stopAutosaveListen) stopAutosaveListen(); autosave.dispose() })
const { verDlg, openVersions, restoreVersion, duplicateVersion } = useConfigVersions({
  ns: 'e2e', api, tree: cfgTree, autosave, applyState, summarize: (st) => ({ label: cfgLabelOf(st) }), fingerprint: fingerprintOf, toast
})

// 老场景迁移（体制曾经是库引用 + 链级速率）：把引用解析成节点上那份体制，链级速率落到链首。
// 迁完就地把老字段删掉，存回去时不再带它们。
function migrateCarriers(row) {
  if (!row || !row.nodes || !row.nodes.length) return
  const legacy = (id) => (id && _legacyCarriers.get(id)) || null
  for (let i = 0; i < row.nodes.length; i++) {
    const nd = row.nodes[i]
    if (!nd.carrier) {
      const f = legacy(nd.basebandId) || (i === 0 ? legacy(row.basebandId) : null)
      if (f) nd.carrier = { ...defaultCarrier(), ...JSON.parse(JSON.stringify(f)) }
    }
    delete nd.basebandId; delete nd.rateAdapt
  }
  if (row.nodes[0].carrier && row.infoRate) row.nodes[0].carrier.infoRate = String(row.infoRate)
  delete row.basebandId; delete row.infoRate
  ensureSegCarriers(row)
}
// 场景出口（存盘 / 指纹 / localStorage 三处共用）。纯数据的保证在 e2eParams 那一侧，
// 见 serializeChainsState 的头注：节点上的 carrier / ov 是嵌套对象，浅拷会漏响应式 Proxy 出去。
// 搜索起点两键并在场景顶层：缺省（时间轴）不写，老场景载入再存逐字不变（指纹即整份场景）
function serializeState() { return Object.assign(serializeChainsState(chains, geoMode.value, { ...slaParams }), geoT0State(geoT0Mode.value, geoT0ISO.value)) }
// 「新建空白配置」当场用出厂默认造的那份场景（见下方 blankState）：它不是【存过盘的场景】，
// 里头的降雨率/海拔是 schema 默认值而非用户定过的数 ⇒ 载入后照站址取一遍，别把出厂值当成手改值供着。
// 按引用认这一份：saveConfig 半路失败没走到 applyState 时，也不会误伤下一次真正的载入。
let _blankSt = null
function applyState(st) {
  if (!st || !Array.isArray(st.chains) || !st.chains.length) return
  const fresh = st === _blankSt
  _blankSt = null
  // ★ 先深拷一份再往 chains 里搬：st 常常就是 configs 里那条配置的 state（本身是响应式的），
  //   而下面 { ...n } 是浅拷 —— 不拷的话链上节点的 carrier / ov 会与「配置列表里已保存的那份」
  //   共用同一个对象，之后在链上改体制就地改掉了那份，「不保存」再切回来时改动还在。
  st = JSON.parse(JSON.stringify(st))
  // 老场景（无此字段）一律回手动——它们的结果本就是手填几何算出来的，不静默改口径
  geoMode.value = st.geoMode === 'auto' ? 'auto' : 'manual'
  // 搜索起点：旧场景无此两键 → 时间轴（每份场景都显式落定，不沿用上一份的设置）
  geoT0Mode.value = normGeoT0Mode(st.geoT0Mode)
  geoT0ISO.value = normGeoT0ISO(st.geoT0ISO)
  // SLA 参数：旧场景没这一项 → 补缺省（normSlaParams 幂等，非法值也退缺省）
  Object.assign(slaParams, normSlaParams(st.slaParams))
  // 档位扫描随结果作废：推进代次（在途那批回来按代次丢弃）、留底的链描述子一并放掉
  invalidateSlaScan()
  _slaChainOf = {}
  chains.splice(0, chains.length, ...st.chains.map((c) => {
    const row = {
      _id: uid('c'), name: c.name || '', nameAuto: c.nameAuto !== false,
      nodes: (c.nodes || []).map((n) => ({ ...n, _id: uid('n') })),
      hops: (c.hops || []).map((h) => ({ ...h, _id: uid('h') }))
    }
    applyRowSla(row, c.sla)   // 空的删键：留个 sla:{} 会让存量场景的指纹平白变一次
    return row
  }))
  // 端点卫星归一为再生类：老场景里删端点留下的透明星端点，卡片 / 检查器显示的 EIRPs / SFD 并不进算式
  // （引擎在端点一律按再生算），载入即对齐——算出的数不变
  for (const row of chains) { normEndpointKinds(row); migrateCarriers(row) }
  scanGeoSeeds(true)   // 只记录载入态的几何指纹：存盘值优先，此后的输入改动才触发建议值回填
  scanSites(fresh ? 'all' : 'prime')   // 站址取值同理：存盘场景认存盘值，出厂空白场景照站址取
  curIdx.value = 0; sel.type = 'node'; sel.index = 0
  // 上一份的结果态整套清掉：结果 / 报错 / 自动档解出的几何（按链 _id 落表，新链 _id 全换新）/ 详细预算；
  // 「输入已变」灯复位——不复位的话它一直亮着（换上来的这份根本还没算过，没有「结果过期」可言）
  for (const k of Object.keys(results)) delete results[k]
  for (const k of Object.keys(errors)) delete errors[k]
  for (const k of Object.keys(geoSolved)) delete geoSolved[k]
  segments.value = []
  resultsStale.value = false
  syncChainNames()
}
// SLA 的采用值/勾选在 chains 里（row.sla）自然被这条深监听盯住；参数是场景级，另列进来。
// ★ 只跟存盘，不 markStale：改 SLA 建议的采用值不会让引擎结果失效（它是结论不是入参）。
// 场景一变就交给自动保存（防抖写回当前配置）；「上次打开的是哪一份」随 activeId 记一笔
watch([chains, activeId, geoMode], () => { syncChainNames(); markStale(); autosave.touch() }, { deep: true })
watch([geoT0Mode, geoT0ISO], () => { markStale(); autosave.touch() })
watch(slaParams, () => autosave.touch(), { deep: true })
watch(activeId, (id) => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: id || null })) } catch (e) { /* ignore */ } })
// 库条目与搜索时窗同样是计算输入：改了就亮「输入已变」
watch([esConfigs, satConfigs, geoHorizonHours], () => markStale(), { deep: true })

// 场景指纹：只认序列化后的场景（三库是全局资产、不入指纹，库有自己的防抖写盘，关窗另有 flushLibSave 兜底）
function fingerprintOf(st) { return stableStringify(st) }
// 一份配置刚载入工作区：以当前内容为已落盘基线（useConfigTree 在载入 / 新建后调）
function setBaseline() { autosave.attach() }

// —— 命名配置 CRUD ——
// 树本身的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js（见文件上方 useConfigTree(...) 注入点）。
// 这里只留本窗特有的几件：配置的自动名、空白配置的内容、确认框。
// 空白场景放一条默认链（站-星-站）而不是空数组：本窗口的工作对象就是链，
// 一条都没有的场景选中后无处可编辑，反倒像「载入没生效」。
// 自动名（名字随内容的配置用），按平台语言出字；cfgLabelOf 是同一句话按【存档内容】出（历史版本那一列读数）
function defaultCfgName() { return byLang(`端到端 ${chains.length} 条`, `${chains.length} End-to-End Link${chains.length === 1 ? '' : 's'}`) }
function cfgLabelOf(st) {
  const n = st && Array.isArray(st.chains) ? st.chains.length : 0
  return byLang(`端到端 ${n} 条`, `${n} End-to-End Link${n === 1 ? '' : 's'}`)
}
function blankState() { _blankSt = serializeChainsState([defaultChain()], 'manual', { ...DEFAULT_SLA_PARAMS }); return _blankSt }

// 离开当前配置（切换 / 新建 / 副本）前：把没落盘的改动写进去；写不进去（盘满 / 文件被占用 / 未激活）才问一句
async function guardedLeave() {
  if (await autosave.flush()) return true
  return await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要离开？`)
}

// ============ 链路列表（上区）============
const rowRefWarn = (row) => {
  const bad = []
  for (const nd of row.nodes) {
    if (nd.kind === 'es' && refDangling(esConfigs, nd.esId)) bad.push('地球站')
    if (nd.kind !== 'es' && refDangling(satConfigs, nd.satId)) bad.push('卫星')
  }
  return bad.length ? `引用悬空：${[...new Set(bad)].join(' / ')}（已回退到库中第一份）` : ''
}
const segCountOf = (row) => segmentsOf(row.nodes).length
const cellNum = (v) => (v === '' || v == null ? '—' : v)
const marginCls = (v) => { const n = parseFloat(v); return isFinite(n) && n < 0 ? 'st-bad' : '' }   // 只有负余量转危险色；正值中性（四窗同口径）
// 注：转发器功率/带宽占比不进这张表——那是【某一颗透明星】的资源账，不是端到端的量，
// 链上有几颗星就有几份，取个最大值当"链的占比"是编出来的指标。它挂在链路条的星卡片上
// （见 ChainStrip 的占比条）与详细预算的「透明转发器占用」段里，各归各位。

const cities = ref([])
const basebandOpts = ref({})
const appVersion = ref('')
const deviceId = ref('')
const refreshing = ref(false)
async function refreshLatest() {
  if (refreshing.value || !api) return
  refreshing.value = true
  // 逐项取：某项失败不拦其余各项（取不到的保留原值），但不再一律报「已刷新」——失败的如实列出（A5）
  const failed = []
  let ok = 0
  const step = async (name, fn) => { try { await fn(); ok++ } catch (e) { failed.push({ name, error: e }) } }
  try {
    await step('城市库', async () => { const c = await api.linkBudget.cities(); if (c) cities.value = c })
    await step('载波信号选项', async () => { const b = await api.linkBudget.baseband(); if (b) basebandOpts.value = b })
    reloadSatTree()
    if (failed.length) reportPartial('刷新最新设置', ok, failed)
    else toast('已刷新最新设置')
  } finally { refreshing.value = false }
}
onBeforeUnmount(() => { window.removeEventListener('focus', reloadSatTree); window.removeEventListener('focus', mergeLibFromDisk) })
// 别的链路预算窗口「复制到端到端库」写的是盘上的 library.json；本窗口内存里那份不知道，下次整写会把它冲掉。
// 故获焦时把盘上有、内存里没有、本会话也没删过的条目并进来（只认新增，见 shared/lbShare.js externalLibEntries）。
async function mergeLibFromDisk() {
  if (!_libLoaded || !api) return
  let lib = null
  try { lib = await api.store.getLibrary(LIB_NS) } catch (e) { return }   // 读不到就下次获焦再并，不打扰
  if (!lib) return
  const fresh = (kind, arr) => externalLibEntries(lib, kind, arr).filter((c) => !_libGone.has(c.id))
  const es = fresh('es', esConfigs), sat = fresh('sat', satConfigs)
  for (const c of es) esConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('es', c), form: { ...defaultsFor(ES_FIELDS), ...c.form } })
  for (const c of sat) satConfigs.push({ id: c.id, name: c.name || '', nameAuto: adoptAutoFlag('sat', c), form: { ...defaultsFor(SAT_FIELDS), ...c.form }, ngsoSat: normNgsoSat(c.ngsoSat) })
  const n = es.length + sat.length
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
// 卫星树来自主窗口「星座3D」页（localStorage 同源共享）：窗口重获焦点即重读，
// 纳入此后新导入的星。树里暂时没有的节点不清空所选——已存的轨道根数照常参与计算。
// 链上用着的、取自卫星树的星按树里现在的节点重解轨道（口径同 NGSO reloadSatTree：3D 页改了根数 / 历元即跟上）；
// 自定义星座星（搜索选的，或树里关联到合成号的）换成当前场景历元（见 shared/lbTreeOrbit.js）。轨道只在真变了时写（免得自动保存空转）；
// 关联星此刻反解不出（离线）不拿 unresolved 顶掉已存的轨道。
async function reloadSatTree() {
  try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ }
  const targets = new Set()
  for (const row of chains) for (const nd of (row.nodes || [])) { const c = satCfgOf(nd); if (c) targets.add(c) }
  let cust = null
  const custSats = () => { if (!cust) { try { cust = loadCustomSats().sats } catch (e) { cust = [] } } return cust }
  for (const c of targets) {
    const ns = c.ngsoSat
    if (!ns || ns.mode === 'manual' || ((c.form && c.form.orbitClass) || 'GSO') === 'GSO') continue   // GSO 只认定点经度，不取星
    const node = pickedTreeNode(ns, satTree.value)
    if (node) {
      let orbit = null
      try { orbit = await treeNodeOrbit(node) } catch (e) { orbit = null }   // 反解失败：留着已存的轨道
      if (ns.mode !== 'tree' || ns.folder !== node.folder) continue   // 反解期间用户另选了星：不拿旧节点顶掉新选的
      if (orbit && orbit.type !== 'unresolved') {
        // 先换成当前场景历元再比（候选池按窗口缓存，历元可能是旧的）：否则每次刷新都「写旧→换新」两遍，结果标过期、库空存一次
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

// ============ 导入图上链路 ============
// 星座 3D 主窗「链路」视图建的 STK Chain 式单向链路 → 本窗一条条链（载荷形状见 packages/core/models/mapLinks.mjs 的 chainPayload）。
// 两个入口：链路列表「导入链路」对话框拉取 / tool:open 的 ctx.links 推送。对话框那条也走 onToolContext 的队列——
// 库与配置载入完（onMounted 末尾 flushToolContext）之前一律排队：_libLoaded 之前加进库的条目会被随后载入的库整份顶掉。
// 口径：只追加，既有的链与库条目一字不动；当前配置只有一条没动过的出厂默认链时由导入的链顶替（isFactoryChain）。
//   星：satEntryForCtx 库里找同一颗（NORAD → 天线树 folder → GSO 同名同轨位 → 同轨道类型同名），没有就新建并定轨，定完才落链：
//       GSO（载荷 geo 且带定点经度）只认定点经度；NGSO 取星同资源库取星器（天线树节点 → treeNodeOrbit；目录星 → 星历池按 NORAD），
//       取不到退回手动轨道（高度 / 倾角取主窗口那一拍的值）。同一批里同一颗星（satKey）只解一次；解不出的那颗星所在链路算跳过。
//   站：站名 / 经纬度入节点（降雨率 / 海拔由 scanSites 按站址取）；带天线口径 → 按口径对号地球站库（shared/lbStationType.js），
//       没带口径沿用缺省引用（库第一份，同新建节点）。本窗的地球站库没有损耗字段，天线罩记不进库条目：
//       罩损（mapLinks.radomeLossDb，按该跳频率分档）并进与它相邻的星地跳「其他损耗」——自它发出的上行跳、进它的下行跳。
//   跳：按类型播种（同 e2eChainEdit.reseedHop：星地按上 / 下行侧向默认，星间 / 激光走星间默认）；斜距 / 星间距离留空，手动档由 scanGeoSeeds 给建议值。
//   节点：链端卫星恒为再生（与引擎端点归一同口径），中间卫星按载荷的转发方式；体制落链首（defaultCarrier），段起点照抄。
const _ctxQueue = []
let _ctxReady = false, _ctxChain = Promise.resolve()
// 失败不再静默（A5）：从地图带对象进来没成，通知条常驻报因
function onToolContext(c) { if (!_ctxReady) { _ctxQueue.push(c); return } _ctxChain = _ctxChain.then(() => applyToolContext(c)).catch((e) => { reportError('载入地图带入的对象', e) }) }
function flushToolContext() { _ctxReady = true; for (const c of _ctxQueue.splice(0)) onToolContext(c) }
async function applyToolContext(c) {
  if (c && c.links) await importChains(c.links)   // 本窗只收图上链路
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
// 链上卫星节点在主窗口里的身份：GSO 按星名（定点星多在主窗口的编目里）；NGSO 只有取过星的才在主场景里有这颗星
function satIdentOfNode(nd) {
  const c = satCfgOf(nd)
  if (!c) return null
  const f = c.form || {}
  if ((f.orbitClass || 'GSO') === 'GSO') {
    const name = String(f.satelliteName || '').trim()
    return name && !isSatNamePlaceholder(name) ? { name } : null
  }
  const ns = c.ngsoSat
  if (!ns || ns.mode === 'manual' || !ns.orbit) return null
  const name = ns.name || f.satelliteName || ''
  return (name || ns.noradId != null) ? { norad: ns.noradId != null ? ns.noradId : undefined, name } : null
}
// 链路列表行「在主窗口定位」：聚焦链上第一颗卫星，画面正对链首地球站
async function locateChainInMain(i) {
  const row = chains[i]
  if (!row) return
  const satNode = (row.nodes || []).find((n) => n.kind !== 'es')
  const id = satNode ? satIdentOfNode(satNode) : null
  if (id) await sceneCmd('focusSat', id)
  const es = (row.nodes || []).find((n) => n.kind === 'es')
  const lat = es ? pf(es.latitude) : NaN, lon = es ? pf(es.longitude) : NaN
  if (Number.isFinite(lat) && Number.isFinite(lon)) await sceneCmd('faceLonLat', { lat, lon, name: String(es.name || '') })
}
// 检查器「自动几何」：本跳几何取自的那一刻（星地跳＝典型时刻 t*，星间跳＝最差时刻）。主窗口时间轴拨过去、
// 聚焦本跳的卫星（星间跳取发端），并在时间轴上标出 t* 与本次搜索时窗（同 src + label 覆盖上一次的标记）
async function locateHopInMain() {
  const h = curSolvedHop.value, row = cur.value
  if (!h || !row) return
  const t = Date.parse(h.tISO)
  if (!Number.isFinite(t)) return
  const s0 = h.win ? Date.parse(h.win.t0ISO) : NaN, hh = h.win ? Number(h.win.hours) : 0
  if (Number.isFinite(s0) && hh > 0) await sceneCmd('markTime', { t0: s0, t1: s0 + hh * 3600000, label: '搜索时窗', src: 'e2e' })
  await sceneCmd('markTime', { t0: t, label: 't*', src: 'e2e' })
  await sceneCmd('seekClock', { tMs: t })
  const a = row.nodes[sel.index], b = row.nodes[sel.index + 1]
  const id = satIdentOfNode(a && a.kind !== 'es' ? a : b)
  if (id) await sceneCmd('focusSat', id)
}
const linkImpOpen = ref(false)
const onLinkImport = (list) => onToolContext({ links: list })

const ctxNameKey = (s) => String(s || '').trim().toLowerCase()
const isGsoCfg = (c) => ((c && c.form && c.form.orbitClass) || 'GSO') === 'GSO'
const lonGap = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180)   // 经度差（°，跨 ±180° 取近端）
// 载荷的星节点 → satEntryForCtx 认的形状（noradId 恒为字符串，缺项一律空值）
const ctxSatOf = (n) => ({
  name: String(n.name || '').trim(), noradId: n.noradId == null ? '' : String(n.noradId), folder: n.folder ? String(n.folder) : '',
  geo: n.geo === true, slotLon: Number.isFinite(n.slotLon) ? n.slotLon : null,
  altKm: Number.isFinite(n.altKm) ? n.altKm : null, inclDeg: Number.isFinite(n.inclDeg) ? n.inclDeg : null
})
// 星历池记录 → 条目存的轨道 spec（字段同 E2eSatPanel.pickSearch；星历点序列走 satSearchPool 的唯一出口，取不到返回 null）
function searchOrbitOf(rec) {
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    return { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
  }
  if (rec.orbitType === 'ephem') { try { return poolOrbitSpecOf(rec) } catch (e) { return null } }
  return { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
}
// 卫星库条目：找同一颗，没有就新建并定轨（返回响应式代理）。星名为空 / 出厂占位名「Satellite」不参与按名认星；
// 按名认星只认同轨道类型的条目——同名的 NGSO 条目拿给 GSO 星用（或反过来），几何整个是错的。
async function satEntryForCtx(s) {
  const node = s.folder ? satTree.value.find((n) => n.folder === s.folder) : null
  const gso = s.geo && s.slotLon != null
  const nm = isSatNamePlaceholder(s.name) ? '' : ctxNameKey(s.name)
  const hit = (s.noradId && satConfigs.find((c) => c.ngsoSat && c.ngsoSat.noradId != null && String(c.ngsoSat.noradId) === s.noradId)) ||
    (node && satConfigs.find((c) => c.ngsoSat && c.ngsoSat.folder === node.folder)) ||
    (gso && nm && satConfigs.find((c) => isGsoCfg(c) && [c.form.satelliteName, c.name].some((v) => ctxNameKey(v) === nm) && lonGap(pf(c.form.orbitLongitude), s.slotLon) <= 0.01 + 1e-9)) ||
    (nm && satConfigs.find((c) => isGsoCfg(c) === gso && ctxNameKey(c.form.satelliteName) === nm))
  if (hit) return hit
  satConfigs.push(makeSatConfig())
  const cfg = satConfigs[satConfigs.length - 1]   // 取回响应式代理：定轨回填才触发重绘与存盘
  const f = cfg.form, ns = cfg.ngsoSat
  if (nm) f.satelliteName = s.name
  if (gso) {
    f.orbitClass = 'GSO'
    f.orbitLongitude = String(Math.round(s.slotLon * 100) / 100)
  } else {
    f.orbitClass = 'NGSO'
    // 先落主窗口那一拍的高度 / 倾角：取星成功由 orbitToForm 覆盖；取不到（离线 / 合成星 / 未解析）它就是手动轨道
    if (s.altKm != null) f.orbitAltitude = String(Math.round(s.altKm))
    if (s.inclDeg != null) f.orbitInclination = String(Math.round(s.inclDeg * 100) / 100)
    if (node) {   // 同资源库「卫星/天线树」取星（E2eSatPanel.onPickTree）
      ns.mode = 'tree'; ns.name = node.satName; ns.noradId = node.noradId || null; ns.folder = node.folder
      f.satelliteName = node.satName
      let orbit = null
      try { orbit = await treeNodeOrbit(node) } catch (e) { orbit = null }
      if (ns.mode === 'tree' && ns.folder === node.folder) { ns.orbit = orbit; orbitToForm(f, orbit) }
    } else if (s.noradId) {   // 同资源库「星历搜索」取星（E2eSatPanel.pickSearch）
      let rec = null
      try { rec = await findPoolByNorad(s.noradId) } catch (e) { rec = null }
      const orbit = rec ? searchOrbitOf(rec) : null
      if (orbit) {
        ns.mode = 'search'; ns.name = rec.name; ns.noradId = rec.noradId || null; ns.folder = ''; ns.orbit = orbit
        f.satelliteName = rec.name
        orbitToForm(f, orbit)
      }
    }
  }
  syncAutoNames(satConfigs, 'sat')
  return cfg
}
// 站型对号（只按口径）→ 库条目 id；站没带口径返回 ''（沿用缺省引用＝库第一份，同新建节点）。
// 新条目当场落库（id 规则同 duplicateEsConfig）：同一批里下一个同口径的站就命中它，不再另建一份。
function esIdForSite(p) {
  const t = esStationType(esConfigs, { diaM: Number(p.diaM), radome: p.radome === true, prefer: esConfigs[0], lossKeys: null })
  if (!t) return ''
  if (t.hit) return t.hit.id
  esConfigs.push({ id: 'es' + (_esSeq++), name: t.make.name, nameAuto: t.make.nameAuto, form: t.make.form })
  syncAutoNames(esConfigs, 'es')
  return esConfigs[esConfigs.length - 1].id
}
// 本窗收任何有效链路。推来的 ctx.links 只经主进程清洗过形状，结构判据（同 mapLinks.linkIssues）在这里再校一遍：
// ≥ 2 节点、跳数 = 节点数 − 1、站有经纬度、相邻不同为地球站、相邻不为同一颗星、跳类型与两端相符、激光跳两端须为再生卫星（链端卫星恒再生）
const okSite = (p) => !!p && p.t === 'es' && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon))
function chainFits(c) {
  const ps = c && Array.isArray(c.nodes) ? c.nodes : [], hs = c && Array.isArray(c.hops) ? c.hops : []
  const last = ps.length - 1
  if (ps.length < 2 || hs.length !== last) return false
  if (!ps.every((p) => okSite(p) || (!!p && p.t === 'sat'))) return false
  const regenAt = (i) => ps[i].t === 'sat' && (i === 0 || i === last || ps[i].regen === true)
  for (let i = 0; i < last; i++) {
    const a = ps[i], b = ps[i + 1], t = hs[i] && hs[i].type
    if (a.t === 'es' && b.t === 'es') return false
    const want = a.t === 'es' ? ['up'] : b.t === 'es' ? ['down'] : ['isl', 'laser']
    if (!want.includes(t)) return false
    if (a.t === 'sat' && b.t === 'sat' && String(a.key || '') !== '' && String(a.key) === String(b.key)) return false
    if (t === 'laser' && !(regenAt(i) && regenAt(i + 1))) return false
  }
  return true
}
// 航迹代表点带实际高度（altM）的站节点：海拔写它，站址取值只补降雨率、不按地形改写海拔（见 importChains 末尾的 _sitePend 预置）
const ALT_KEEP = Object.freeze({})
// 载荷 → 一条链（纯数据；ents[i] = 第 i 个节点所用的卫星库条目，站节点为 null）；fixAlt（可缺）收集带实际高度的站节点
function chainFromPayload(c, ents, fixAlt) {
  const ps = c.nodes, last = ps.length - 1
  const nodes = ps.map((p, i) => {
    if (p.t === 'es') {
      const nd = newEsNode(String(p.name || '').trim() || nodeName(i === 0 ? 'tx' : i === last ? 'rx' : 'relay'))
      nd.longitude = String(p.lon); nd.latitude = String(p.lat)
      if (Number.isFinite(p.altM)) { nd.altitude = String(Math.round(p.altM)); if (fixAlt) fixAlt.push(nd) }
      nd.esId = esIdForSite(p)
      // 功放功率：站带了就写成节点级覆盖（库条目不动）；只在本站发出上行时有意义（链尾收信站不写）
      const w = Number(p.pwrW)
      if (i < last && Number.isFinite(w) && w > 0) nd.opPowerW = String(w)
      return nd
    }
    const nd = newSatNode(i === 0 || i === last || p.regen === true ? 'regen' : 'txp', String(p.name || '').trim())
    nd.satId = ents[i].id
    return nd
  })
  const hops = c.hops.map((hp, i) => {
    const t = hp.type
    const h = newHop(t === 'laser' ? 'laser' : 'rf')
    Object.assign(h, isSpaceHop(t) ? defaultsFor(HOP_ISL_FIELDS) : GS_SIDE_DEFAULTS[t])
    if ((t === 'up' && ps[i].radome === true) || (t === 'down' && ps[i + 1].radome === true)) {
      h.miscLoss = String(Math.round(((pf(h.miscLoss) || 0) + radomeLossDb(pf(h.frequency))) * 100) / 100)
    }
    return h
  })
  nodes[0].carrier = defaultCarrier()
  const own = c.nameAuto === false ? String(c.name || '').trim() : ''
  const row = { _id: uid('c'), name: own, nameAuto: !own, nodes, hops }
  ensureSegCarriers(row)
  return row
}
// 没动过的出厂默认链（新建配置自带的那条站-星-站）：与 defaultChain() 逐项相同（_id、自动链名不论，占位站名哪种语言都算）。
// 工作台自己推出来的值不算改动：站址自动取到的降雨率 / 海拔（同 scanSites 那条 geoFill 通道按站址现取一次比对）、
// 手动几何的派生建议值（在副本上按 hopSeedInfo 同式现推；apply 只写它推出来的那几格，先垫空认出是哪几格）。
const GEO_KEYS = ['slantRange', 'elevation', 'rangeKm']
async function isFactoryChain(row) {
  if (!row || row.nameAuto === false || row.sla) return false
  const ref = defaultChain()
  if (row.nodes.length !== ref.nodes.length || row.hops.length !== ref.hops.length) return false
  const bare = (o) => { const r = JSON.parse(JSON.stringify(o)); delete r._id; return r }
  const phName = (v) => { for (const k in NODE_NAMES) if (isDefaultName(v, ...NODE_NAMES[k])) return '#' + k; return v }
  const dry = JSON.parse(JSON.stringify(row))
  const derived = dry.hops.map((h, i) => {
    const info = hopSeedInfo(dry, i)
    if (!info) return {}
    for (const k of GEO_KEYS) h[k] = undefined
    info.apply()
    const o = {}
    for (const k of GEO_KEYS) if (h[k] !== undefined) o[k] = h[k]
    return o
  })
  for (let i = 0; i < ref.hops.length; i++) {
    const a = bare(row.hops[i]), b = bare(ref.hops[i]), d = derived[i]
    for (const k of Object.keys(d)) if (a[k] === d[k]) a[k] = b[k]
    if (stableStringify(a) !== stableStringify(b)) return false
  }
  for (let i = 0; i < ref.nodes.length; i++) {
    const a = bare(row.nodes[i]), b = bare(ref.nodes[i])
    const site = a.kind === 'es' && b.kind === 'es'
    const got = site ? { rainRate: a.rainRate, altitude: a.altitude } : null
    if (site) { a.name = phName(a.name); b.name = phName(b.name); a.rainRate = b.rainRate; a.altitude = b.altitude }
    if (stableStringify(a) !== stableStringify(b)) return false
    if (!site || (got.rainRate === b.rainRate && got.altitude === b.altitude)) continue
    let g = null
    if (api) { try { g = await api.linkBudget.geoFill(pf(b.latitude), pf(b.longitude)) } catch (e) { g = null } }
    for (const k of ['rainRate', 'altitude']) {
      if (got[k] !== b[k] && !(g && g[k] != null && got[k] === String(g[k]))) return false
    }
  }
  return true
}
async function importChains(list) {
  const all = Array.isArray(list) ? list : []
  const fit = all.filter(chainFits)
  let skipped = all.length - fit.length
  const byKey = new Map(), jobs = []
  for (const c of fit) {
    const ents = []
    for (const p of c.nodes) {
      if (p.t !== 'sat') { ents.push(null); continue }
      const k = String(p.key || '')
      let e = null
      if (k && byKey.has(k)) e = byKey.get(k)
      else {
        try { e = await satEntryForCtx(ctxSatOf(p)) } catch (err) { e = null }
        if (k) byKey.set(k, e)
      }
      if (!e) break
      ents.push(e)
    }
    if (ents.length !== c.nodes.length) { skipped++; continue }
    jobs.push({ c, ents })
  }
  if (!jobs.length) { toast(byLang('没有可导入的链路', 'No applicable links')); return }
  // 顶替判定是最后一个 await：其后建链、改表一气呵成，中途不让出主线程
  const lone = chains.length === 1 ? chains[0] : null
  let swap = false
  if (lone) { try { swap = await isFactoryChain(lone) } catch (e) { swap = false } }
  const fixAlt = []
  const rows = jobs.map(({ c, ents }) => chainFromPayload(c, ents, fixAlt))
  if (swap && chains.length === 1 && chains[0] === lone) {
    chains.splice(0, 1)
    delete results[lone._id]; delete errors[lone._id]; delete geoSolved[lone._id]
  }
  // 带实际高度的站：先预置一份「海拔不认」的取值快照（ALT_KEEP 与任何现值都不等），scanSites 发现新站址时沿用它 → 只补降雨率
  for (const nd of fixAlt) _sitePend.set(nd._id, { rain: nd.rainRate, alt: ALT_KEEP })
  const at = chains.length
  chains.push(...rows)
  syncChainNames()
  curIdx.value = at; sel.type = 'node'; sel.index = 0
  const n = new Set(jobs.map((j, i) => j.c.grp || '#' + i)).size, nChains = rows.length   // 一条图上链路（grp）可展开成多条链（支路）
  toast(byLang(
    `已导入 ${n} 条链路${nChains > n ? `（${nChains} 条链）` : ''}${skipped ? `，${skipped} 条不适用已跳过` : ''}`,
    `Imported ${n} link${n === 1 ? '' : 's'}${nChains > n ? ` (${nChains} chains)` : ''}${skipped ? `, ${skipped} skipped (not applicable)` : ''}`))
  await flushLibSave()   // 新链引用的库条目先落盘（库改动不入场景指纹，见 flushLibSave 头注）
}

function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compute() }
}

onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  try { const lib = api && await api.store.getLibrary(LIB_NS); if (lib) applyLibrary(lib) } catch (e) { reportError('读取资源库失败', e) }   // 保持默认库，但得让人知道
  _libLoaded = true
  scheduleLibSave()
  await loadConfigs()
  // 打开上次那份配置；它没了就开树上第一份，一份都没有就新建一份空白配置（工作区恒对应一份配置；
  // 新建的空白配置在 applyState 里按站址取一遍降雨率 / 海拔，存盘场景一律存盘值优先）。
  // 迁移（v1.5.0 及以前「上次会话」存的是整份场景）：
  //   · 对应的配置还在 → 把那份没点保存的改动接上，随即由自动保存写盘（写盘前先给它留一档「打开时」）；
  //   · 不属于任何配置的草稿（旧版本本窗会原样恢复它）→ 落成一份新配置并打开，升级后第一眼看到的与升级前一致；
  //     与某份已存配置逐字相同的不另落，直接打开那一份。
  let last = null
  try { last = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') } catch (e) { last = null }
  const oldScene = !!(last && Array.isArray(last.chains) && last.chains.length)
  if (oldScene && !last.activeId && api) {
    const draft = { ...last }
    delete draft.activeId
    const fp = stableStringify(draft)
    const same = configs.value.find((c) => c.type !== 'folder' && c.state && stableStringify(c.state) === fp)
    if (same) await ensureActive(same.id)
    else await cfgTree.createAndOpen({ state: draft, name: cfgLabelOf(draft), nameAuto: true })
  }
  await ensureActive(last && last.activeId)
  if (oldScene && last.activeId && last.activeId === activeId.value) { applyState(last); autosave.touch() }
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ activeId: activeId.value || null })) } catch (e) { /* ignore */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  for (const row of chains) migrateCarriers(row)   // 老库读进来之后再迁一次（体制引用 → 节点上那份）
  syncChainNames()
  // 关窗：把场景与资源库挂起的写盘冲掉即放行（观感上秒关）；只有场景写不进磁盘时才问一句
  api?.e2e?.onCloseRequested?.(async () => {
    const ok = await autosave.flush()
    await flushLibSave()
    if (!ok && !(await askConfirm(`「${activeName()}」的改动未能写入磁盘（${saveError.value}）。仍要关闭窗口？`))) return
    api.e2e.confirmClose()
  })
  stopAutosaveListen = autosave.listen()   // 窗口失焦 / 页面隐藏 / 刷新前立即写盘
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('focus', reloadSatTree)
  window.addEventListener('focus', mergeLibFromDisk)   // 单例窗口：切回本窗口即并入别的窗口复制来的库条目
  flushToolContext()   // 库与配置已载入：处理开窗时随窗带来的图上链路、以及载入期间对话框排进队的导入
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api" autosave
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @duplicate="duplicateItem" @versions="(it) => openVersions(it.id)"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
    />
    <!-- 历史版本（自动保存的后悔药）：还原 / 用那一版另建副本 -->
    <LbVersionsDialog v-model:open="verDlg.open" ns="e2e" :cfg-id="verDlg.id" :cfg-name="verDlg.name" @restore="restoreVersion" @duplicate="duplicateVersion" />
    <div class="lb-body">
      <!-- ① 左侧栏：配置列表 / 资源库 二选一 -->
      <aside v-show="sideView" class="lb-col lb-side" :class="[sideView === 'library' ? 'lb-lib' : 'lb-configs', { resizing: sideResizing }]" :style="{ width: sideWidth + 'px' }">
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
          <div v-if="deviceId" class="lb-myid" title="本机用户 ID">本机标识：<b>{{ deviceId }}</b></div>
        </template>
        <template v-else>
          <div class="lb-col-hd">
            <span class="lb-cfg-hd-t">资源库</span>
            <span class="lb-cfg-acts">
              <button class="lb-mini lb-mini-ico" title="新增配置"
                      @click="libTab === 'station' ? addEsConfig() : addSatConfig()"><Icon name="plus" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏资源库" @click="sideView = ''"><Icon name="x" :size="12" /></button>
            </span>
          </div>
          <nav class="lb-lib-tabs">
            <button v-for="t in LIB_TABS" :key="t.key" class="lbx-subtab" :class="{ on: libTab === t.key }" :aria-pressed="(libTab === t.key) ? 'true' : 'false'" :title="t.tip" @click="libTab = t.key">
              {{ t.label }}<span class="lbx-tab-n">{{ t.key === 'station' ? esConfigs.length : satConfigs.length }}</span>
            </button>
          </nav>
          <div class="lb-libpane">
            <LbLibrary v-if="libTab === 'station'" v-model="selEsId" layout="column" :items="esConfigs" :summary="esSummary" name-placeholder="站型名称"
                       auto-tip="天线口径" :copy-targets="copyTargetsOf('es')" @copy-to="(c, ns) => copyLibTo('es', c, ns)"
                       @add="addEsConfig" @duplicate="duplicateEsConfig" @remove="removeEsConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此配置的副本" @click="duplicateEsConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此配置" :disabled="esConfigs.length <= 1" @click="removeEsConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><EarthStationPanel :form="cfg.form" :common-fields="ES_COMMON_FIELDS" :tx-fields="ES_TX_FIELDS" :rx-fields="ES_RX_FIELDS" /></template>
            </LbLibrary>
            <LbLibrary v-else v-model="selSatId" layout="column" :items="satConfigs" :summary="satSummary" name-placeholder="卫星名（列表用）"
                       auto-tip="卫星名称" :copy-targets="copyTargetsOf('sat')" @copy-to="(c, ns) => copyLibTo('sat', c, ns)"
                       @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="创建此卫星的副本" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 创建副本</button>
                <button class="lb-mini" title="删除此卫星" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><E2eSatPanel :form="cfg.form" :ngso-sat="cfg.ngsoSat" :sat-tree="satTree" /></template>
            </LbLibrary>
          </div>
        </template>
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResizeSide"></div>
      </aside>

      <!-- ② 主区 -->
      <section class="lb-col lb-build">
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <div class="lbr-form">
                <!-- 原第三行「算法 · 正向递推」是固定说明（CLAUDE.md），已删，三行竖排还会把功能区撑高一截；
                     其口径挪到本组组名「计算」的 title 上。★ 不并进下面「几何」的 title：英文界面按整串查词典，
                     拼出来的新串查不到，会译成中英夹杂的残句 -->
                <label title="几何来源：自动最差＝按各跳卫星的轨道解最差工况（GSO 静止几何 / NGSO 选星走 SGP4 / NGSO 手填走圆轨道闭式；星间跳按两星轨道取时窗内最大距离），此时「仰角」字段是最低仰角门限；手动＝斜距与仰角、星间距离由各跳自己填"><span>几何</span>
                  <select v-model="geoMode" style="width: 86px"><option v-for="g in GEO_MODES" :key="g.v" :value="g.v">{{ g.l }}</option></select>
                </label>
                <label v-if="!geoManual" title="从起点起在此时窗内解最差工况几何"><span>时窗</span>
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
              <button class="lbr-big primary" :disabled="computing" :title="`计算全部 ${chains.length} 条链路（Ctrl+Enter）`" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
              <!-- 几何工具统一挂在「计算」组（三窗同一处、同一枚图标）：只服务于手动几何档 -->
              <button class="lbr-big" :disabled="!gsHops.length || !geoManual" title="斜距工具：按站址纬度/海拔/仰角与轨道高度计算 WGS-84 最大斜距（绕站一圈取最大），填入本跳或本链路全部星地跳（几何=自动时斜距由求解器给出，本工具仅服务于手动档）" @click="slantToolOpen = true"><Icon name="ruler-dimension-line" :size="16" />斜距</button>
              <button class="lbr-big" :disabled="!spaceHops.length || !geoManual" title="星间距离工具：两星轨道在时间轴上的星间距离，填入本跳或本链路全部星间跳（几何=自动时距离由求解器给出，本工具仅服务于手动档）" @click="islToolOpen = true"><Icon name="ruler-dimension-line" :size="16" />星间距离</button>
            </div>
            <div class="lbr-cap" title="端到端仅有正向电平递推一种算法：多跳下反算欠定（目标余量可由发信站功放、任一透明星回退、任一再生星 EIRP 补足）">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <!-- 配置自动保存（无「保存」按钮）：这里是它的后悔药；写盘失败时旁边多出一枚告警，单击即重试 -->
              <button class="lbr-big" :disabled="!api || !activeId" title="历史版本：自动留存于打开时、编辑中每 10 分钟、还原前" @click="openVersions(activeId)"><Icon name="history" :size="16" />历史版本</button>
              <button v-if="saveError" class="lbr-big lbx-savefail" :title="'配置未能写入磁盘：' + saveError + '。单击重试'" @click="autosave.flush()"><Icon name="alert-triangle" :size="16" />未写入</button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（城市库 / 载波信号选项）" @click="refreshLatest">
                <Icon name="refresh-cw" :size="16" />
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" :aria-pressed="(sideView === 'configs') ? 'true' : 'false'" :title="sideView === 'configs' ? '隐藏左侧「配置列表」栏（腾出工作区宽度）' : '左侧栏显示「配置列表」'" @click="toggleSide('configs')"><Icon name="panel-left" :size="16" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ on: sideView === 'library' }" :aria-pressed="(sideView === 'library') ? 'true' : 'false'" :title="`资源库：地球站 ${esConfigs.length} · 卫星 ${satConfigs.length}`" @click="toggleSide('library')"><Icon name="folder-open" :size="16" />资源库</button>
            </div>
            <div class="lbr-cap">视图</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!chains.length" :title="chains.length ? '按当前计算结果给出 SLA 条款建议值：可用度 / 带宽与速率 / 时延与丢包 / 故障响应与恢复 / 发射合规（逐条可改采用值、可勾选列入报告）' : '暂无链路。'" @click="openSlaDlg">
                <Icon name="shield-check" :size="16" />
                SLA
              </button>
              <button class="lbr-big" :disabled="reportDlg.busy || !chains.length" :title="chains.length ? '生成交付级报告：Excel（总报告 + 逐链路详情）/ Word（封面 · 目录 · 正文）/ PDF（封面 · 目录 · 总报告 · 逐链路详情）' : '暂无链路。'" @click="openReportDialog"><Icon name="file-export" :size="16" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
              <button class="lbr-big" :disabled="!segments.length" title="复制当前详细预算（TSV，可直接粘贴到 Excel）" @click="copyWaterfallTsv"><Icon name="copy" :size="16" />TSV</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <LbDispCtl />
        </div>

        <div class="lbx-flow lbx-cards" :class="{ 'lbx-stale-res': !!(resultsStale) }">
          <!-- 上：链路列表 -->
          <LbSection id="links" title="端到端链路" :count="chains.length">
            <template #actions>
              <button class="lb-mini" title="新增一条链路（站-星-站）" @click="addChain">＋ 链路</button>
              <button class="lb-mini" title="导入主窗口「目标间链路建链」中建立的链路" @click="linkImpOpen = true">导入链路</button>
            </template>
            <div class="e2-tbl-wrap">
              <table class="e2-tbl">
                <thead>
                  <tr>
                    <th class="c-idx">#</th>
                    <th class="c-nm">名称</th>
                    <th class="c-n" title="该链的业务信息速率（kbps）：在链首节点的载波参数中填写，穿过各再生节点全程守恒；各段的符号率与占用带宽由它与该段 MODCOD 推出">业务速率 (kbps)</th>
                    <th class="c-n" title="链上节点数（发信站 + 中继 + 收信站）">节点数</th>
                    <th class="c-n" title="被再生类节点（再生卫星 / 地面转接站）切出的段数">段数</th>
                    <th class="c-n" title="端到端余量 = 最弱段余量（各段独立解调，比特透传）">最弱段余量 (dB)</th>
                    <th class="c-n" title="各星地 hop 站址可用度之积（各段雨区独立假设）；星间段不贡献可用度损失。地面转接站上下行同址同雨，独立乘积为保守包络">系统可用度 (%)</th>
                    <th class="c-n" title="各段设计误码率之和：各段独立解调、比特透传，误码一旦产生下游无法恢复">端到端 BER</th>
                    <th class="c-n" title="Σ hop 传播时延（距离/c）+ Σ 再生类节点处理时延">端到端时延 (ms)</th>
                    <th class="c-act"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, i) in chains" :key="row._id" :class="{ on: i === curIdx }" @click="curIdx = i">
                    <td class="c-idx">{{ i + 1 }}</td>
                    <td class="c-nm">
                      <input class="e2-in" :value="row.name" data-i18n-skip :title="rowRefWarn(row)" placeholder="链路名称" @input="renameChain(row, $event.target.value)" />
                      <!-- 引用悬空（库条目被删、已回退到第一份）：光靠输入框的 title 藏得太深，行上给个看得见的标记。
                           title 挂在外层 span 上——SVG 元素的 title 属性浏览器不当 tooltip 渲染。 -->
                      <span v-if="rowRefWarn(row)" class="e2-refwarn" :title="rowRefWarn(row)"><Icon name="alert-triangle" :size="12" /></span>
                    </td>
                    <td class="c-n">{{ cellNum(chainInfoRate(row)) }}</td>
                    <td class="c-n">{{ row.nodes.length }}</td>
                    <td class="c-n">{{ segCountOf(row) }}</td>
                    <td class="c-n c-res" :class="marginCls(results[row._id] && results[row._id].e2eMarginResult)">{{ cellNum(results[row._id] && results[row._id].e2eMarginResult) }}</td>
                    <td class="c-n c-res">{{ cellNum(results[row._id] && results[row._id].systemAvailabilityResult) }}</td>
                    <td class="c-n c-res">{{ cellNum(results[row._id] && results[row._id].e2eBerResult) }}</td>
                    <td class="c-n c-res">{{ cellNum(results[row._id] && results[row._id].e2eDelayResult) }}</td>
                    <td class="c-act">
                      <span v-if="errors[row._id]" class="e2-err" :title="errors[row._id]"><Icon name="alert-triangle" :size="12" /></span>
                      <button v-if="sceneApi" class="lb-mini lb-mini-ico" title="在主窗口定位" @click.stop="locateChainInMain(i)"><Icon name="locate-fixed" :size="12" /></button>
                      <button class="lb-mini lb-mini-ico" title="复制此链路" @click.stop="duplicateChain(i)"><Icon name="copy" :size="12" /></button>
                      <button class="lb-mini lb-mini-ico" title="删除此链路" :disabled="chains.length <= 1" @click.stop="removeChain(i)"><Icon name="x" :size="12" /></button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="cur && errors[cur._id]" class="lb-err">{{ errors[cur._id] }}</div>
            <div v-if="rateMismatchText" class="lb-err">{{ rateMismatchText }}</div>
          </LbSection>

          <!-- 中：链路条编辑器 ‖ 右：检查器 -->
          <LbSection id="chain" title="链路构成" flow="chain" :no="cur ? curIdx + 1 : 0" :summary="cur ? cur.name : ''">
            <div class="e2-mid">
              <div class="e2-strip">
                <ChainStrip :row="cur" :result="curResult" :sel="sel"
                            :sat-name="(nd) => (resolveSat(nd.satId) || {}).name"
                            :sat-val="satVal"
                            :es-name="(nd) => (resolveEs(nd.esId) || {}).name"
                            :seg-carrier="segCarrierName"
                            :solved="cur ? geoSolved[cur._id] : null"
                            @select="onSelect" @insert="insertNode" @remove="removeAt"
                            @toggle-kind="toggleKind" @toggle-link="toggleLink" @toggle-endpoint="toggleEndpoint" @extend-end="extendEnd" />
              </div>
              <aside class="e2-insp">
                <div class="e2-insp-hd">
                  <span class="e2-insp-t">{{ sel.type === 'node' ? '节点' : 'hop' }}</span>
                  <span class="e2-insp-s" data-i18n-skip>{{ sel.type === 'node' ? (selNode && selNode.name) : (selHopType === 'up' ? '星地上行' : selHopType === 'down' ? '星地下行' : selHopType === 'laser' ? '星间激光' : '星间微波') }}</span>
                </div>
                <div v-if="!cur" class="e2-insp-none">暂无链路。</div>
                <template v-else-if="sel.type === 'node' && selNode">
                  <!-- 收侧：解调器（按上一段体制解调，实际门限 = 理论门限 + 本机实现损失） -->
                  <template v-if="selEndSegIndex >= 0">
                    <div class="e2-sub">解调（入）</div>
                    <div class="e2-ref">
                      <span class="e2-ref-l" title="从上一段进来的那条载波：本节点按它的体制解调">入段体制</span>
                      <span class="e2-ro" data-i18n-skip>{{ segCarrierName(selEndSegIndex) }}</span>
                    </div>
                    <E2eFields :fields="NODE_DEMOD_FIELDS" :form="selNode" />
                    <div v-if="selThresholdEff !== null" class="e2-ref">
                      <span class="e2-ref-l" title="本节点解调器实际要求的载噪比门限 = 入段体制的门限 C/N + 本节点解调实现损失。噪声带宽取符号率，故门限 C/N 与门限 Es/N₀ 同值（= Eb/N₀ + 10·lg(FEC×帧效率×调制因子÷扩频增益)）">实际门限 C/N</span>
                      <span class="e2-ro">{{ selThresholdEff }} dB</span>
                    </div>
                  </template>
                  <!-- 发侧：编码调制器（本节点发出的那一段用什么体制；链首那份还定义业务速率） -->
                  <template v-if="selSegIndex >= 0 && selNode.carrier">
                    <div class="e2-sub">调制（出）</div>
                    <div v-if="sel.index > 0" class="e2-ref">
                      <span class="e2-ref-l" title="全链同一个业务速率：仅在链首节点填写，本节点仅更换调制方式 / 码率">业务速率</span>
                      <span class="e2-ro">{{ chainInfoRate(cur) != null ? fmtQtyRate(chainInfoRate(cur)) : '—' }}</span>
                    </div>
                    <BasebandPanel :form="selNode.carrier" :options="basebandOpts" :calc-modes="[]" :rate-locked="sel.index > 0" />
                  </template>
                  <div class="e2-sub">{{ selNode.kind === 'es' ? '地球站' : '卫星' }}</div>
                  <!-- 地球站节点 -->
                  <template v-if="selNode.kind === 'es'">
                    <div class="e2-ref">
                      <span class="e2-ref-l">地球站</span>
                      <select v-model="selNode.esId" class="e2-sel wide"><option v-for="o in esOptions" :key="o.value" :value="o.value">{{ o.label }}</option></select>
                      <button class="e2-edit" title="在资源库中编辑该站型" @click="editInLibrary('station', selNode.esId)"><Icon name="external-link" :size="12" /></button>
                    </div>
                    <div v-if="nodeIsRelay" class="e2-tagline">地面转接站</div>
                    <!-- 功放快调：段起点（发信站 / 转接站上行侧）才有电平意义；空＝跟随库，占位显示库值 -->
                    <E2eFields v-if="selSegIndex >= 0" :fields="NODE_ES_TX_FIELDS" :form="selNode" :base="selEsBase" />
                    <!-- 站名 ＝ 选址：输入即搜城市（中文名 / 拼音 / 英文名 / 国家），选中把经纬度一并填上 -->
                    <div class="e2-ref">
                      <span class="e2-ref-l" title="站名。输入城市名（中文 / 拼音首字母 / 英文 / 国家）即检索，选中后站址经纬度一并填入">站名</span>
                      <div class="e2-city">
                        <div class="e2-city-row">
                          <input v-model="selNode.name" class="e2-in wide" data-i18n-skip
                                 @focus="cityFocus" @input="cityInput" @blur="cityClose"
                                 @keydown.down.prevent="cityMove(1)" @keydown.up.prevent="cityMove(-1)"
                                 @keydown.enter="cityEnter" @keydown.esc="cityClose" />
                          <button class="e2-cityb" title="典型城市…" @click="cityDlg = true"><Icon name="map-pin" :size="12" /></button>
                        </div>
                        <div v-if="cityOpen && cityHits.length" ref="cityPopEl" class="e2-city-pop"
                             :class="{ up: cityUp }" :style="{ maxHeight: cityMaxH + 'px' }">
                          <button v-for="(c, ci) in cityHits" :key="c.name" class="e2-city-i" :class="{ on: ci === cityAt }" :aria-pressed="(ci === cityAt) ? 'true' : 'false'"
                                  data-i18n-skip @mousedown.prevent="pickCity(c)" @mouseenter="cityAt = ci">
                            <span class="e2-city-n">{{ cityName(c) }}</span>
                            <span class="e2-city-x">{{ citySub(c) }}</span>
                            <span class="e2-city-g">{{ cityGeo(c) }}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                    <E2eFields :fields="NODE_ES_SITE_FIELDS" :form="selNode" />
                  </template>
                  <!-- 卫星节点（透明 / 再生） -->
                  <template v-else>
                    <div class="e2-ref">
                      <span class="e2-ref-l">卫星</span>
                      <select v-model="selNode.satId" class="e2-sel wide"><option v-for="o in satOptions" :key="o.value" :value="o.value">{{ o.label }}</option></select>
                      <button class="e2-edit" title="在资源库中编辑该卫星" @click="editInLibrary('sat', selNode.satId)"><Icon name="external-link" :size="12" /></button>
                    </div>
                    <div class="e2-ref">
                      <span class="e2-ref-l">名称</span>
                      <input v-model="selNode.name" class="e2-in wide" data-i18n-skip :placeholder="selSatBase.satelliteName || ''" />
                    </div>
                    <div class="e2-tagline">{{ selNode.kind === 'regen' ? '再生（解调-重调，切段）' : '透明（变频放大转发）' }}</div>
                    <E2eFields :fields="selSatFields" :form="selNode.ov" :base="selSatBase" />
                    <template v-if="selIntfFields.length">
                      <div class="e2-sub">干扰</div>
                      <E2eFields :fields="selIntfFields" :form="selNode.ov" :base="selSatBase" />
                    </template>
                  </template>
                </template>
                <template v-else-if="sel.type === 'hop' && selHop">
                  <E2eFields :fields="selHopFields" :form="selHop" />
                  <!-- 自动几何：本跳解出来的斜距/仰角（或星间距离）——用户单元格不动，这里报实际送算的那份 -->
                  <div v-if="!geoManual && curSolvedHop" class="e2-auto">
                    <span class="e2-auto-l" title="按本跳卫星轨道与站址解出的最差工况几何（送入引擎的即为该几何；上方单元格是手动档的值，不被覆盖）">自动几何</span>
                    <template v-if="curSolvedHop.rangeKm">{{ curSolvedHop.rangeKm }} km</template>
                    <template v-else>{{ curSolvedHop.slantRange }} km · {{ curSolvedHop.elevation }}°</template>
                    <em v-if="curSolvedHop.method">{{ curSolvedHop.method }}</em>
                    <button v-if="sceneApi && curSolvedHop.tISO" class="lb-mini e2-loc" title="主窗口时间轴拨到本跳几何取自的时刻 t* 并聚焦本跳卫星；时间轴上标出 t* 与搜索时窗"
                            @click="locateHopInMain"><Icon name="locate-fixed" :size="12" />在主窗口定位</button>
                  </div>
                </template>
              </aside>
            </div>
          </LbSection>

          <!-- 下：结果文档区 -->
          <LbSection id="detail" title="详细预算" :stale="!!(resultsStale)" :no="cur ? curIdx + 1 : 0" :summary="cur ? cur.name : ''">
            <template #nav>
              <button class="lb-mini lb-mini-ico" :disabled="curIdx <= 0" title="上一条" @click="curIdx = curIdx - 1"><Icon name="chevron-up" :size="12" /></button>
              <button class="lb-mini lb-mini-ico" :disabled="curIdx >= chains.length - 1" title="下一条" @click="curIdx = curIdx + 1"><Icon name="chevron-down" :size="12" /></button>
            </template>
            <div v-if="cur && errors[cur._id]" class="lb-err">{{ errors[cur._id] }}</div>
            <div v-else-if="!segments.length" class="lb-placeholder">尚无预算结果。</div>
            <div v-else class="lbx-doc e2-doc">
              <div class="lbx-doc-main"><WaterfallTable :segments="segments" pick="cascade" :lang="reportLang" /></div>
              <div class="lbx-doc-ref"><WaterfallTable :segments="segments" pick="rest" :lang="reportLang" /></div>
            </div>
          </LbSection>
        </div>
      </section>
    </div>

    <LbSlantTool :open="slantToolOpen" :alt-km="slantToolAlt"
                 :elev-deg="slantToolPair ? slantToolPair.hop.elevation : 25"
                 :lat-deg="slantToolPair ? slantToolPair.es.latitude : (cur && cur.nodes[0] ? cur.nodes[0].latitude : 0)"
                 :sta-alt-m="slantToolPair ? slantToolPair.es.altitude : (cur && cur.nodes[0] ? cur.nodes[0].altitude : 0)"
                 :row-count="gsHops.length" :has-row="!!slantToolPair" side-label="星地跳"
                 @fill="applySlantFill" @close="slantToolOpen = false" />
    <LbIslRangeTool :open="islToolOpen" :sats="islToolSats" :src-a="islToolSrc.a" :src-b="islToolSrc.b"
                    :row-count="spaceHops.length" :has-row="!!islToolHop" :default-hours="24" side-label="星间跳"
                    @fill="applyIslRangeFill" @close="islToolOpen = false" />

    <!-- 交付级报告：元信息 / 输出格式与三窗同一个对话框。viz-available=false —— 本窗没有图表区，
         「包含图件」一栏据此置灰，导出必定无图。 -->
    <!-- SLA 建议：条款表 + SLA 参数 + 可用度档位扫描（四窗共用组件；链由头部下拉选） -->
    <LbSlaDialog
      :open="slaOpen" :options="slaOpts" :index="slaIdx" :derived="slaDerived"
      :row-sla="slaChain && slaChain.sla" :params="slaParams" :adaptive="unitAdaptive" :all-on="slaAllOn"
      :link-error="slaLinkError" :link-name="slaLinkName"
      @close="slaOpen = false" @pick="slaIdx = $event" @adopt="slaSetAdopt" @include="slaSetInclude"
      @param="slaSetParam" @toggle-all="slaToggleAll" :sla-count="slaCount" @clear="slaClear" @export="openSlaReportDialog" />

    <!-- 典型城市…（站名旁的按钮）：CityPicker 单选，点一行即把站名与站址一并写入当前节点 -->
    <CityPicker v-if="cityDlg" single @add="pickCity($event[0])" @close="cityDlg = false" />
    <!-- 导入链路（链路列表的按钮）：星座 3D 主窗建的图上链路，勾选后经 onLinkImport 排进上下文队列 -->
    <LinkImportDialog v-if="linkImpOpen" kind="e2e" @import="onLinkImport" @close="linkImpOpen = false" />

    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="E2E"
                    :link-count="chains.length" :viz-available="false" :sla-count="slaCount" store-key="e2e"
                    :busy="reportDlg.busy" :progress="reportDlg.progress"
                    @close="reportDlg.open = false" :variant="reportVariant" @submit="submitReport" />

    <ConfirmDialog />
    <WinStatusBar :n="N" :stale="resultsStale" stale-title="计算输入已被修改，结果对应修改前的参数">
      <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
    </WinStatusBar>
  </div>
</template>

<style scoped>
/* 窗口骨架（.lb-shell / .lb-body / .lb-col / .lb-side / .lb-mini / .lb-dlg…）在 styles/lbworkbench.css，此处只留本窗的变体 */
.lb-shell {
  /* 上行 / 下行 = lbPlotTheme.js 的 SERIES 蓝 / 赭（与链路视图、图表同一对，四窗一致） */
  --up: #15619b; --dn: #b8571a;
}
html[data-theme='dark'] .lb-shell { --up: #4a8fc9; --dn: #d2792f; }

/* 功能区「文件」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .app-icon { animation: ui-spin .7s linear infinite; transform-origin: 50% 50%; }
.e2-loc { flex: none; margin-left: auto; align-self: center; }


.lb-placeholder { color: var(--text-faint); font-size: var(--fs-3); text-align: center; line-height: 1.7; }


/* —— 链路列表：三线表（顶/底粗线 + 列头线），无竖线无底色，与详细预算同一套排版语言 —— */
.e2-tbl-wrap { overflow-x: auto; }
.e2-tbl { width: 100%; border-collapse: collapse; font-size: var(--lb-fs, 11px); font-variant-numeric: tabular-nums; }
.e2-tbl th { text-align: right; font-weight: 600; color: var(--text-muted); padding: 3px 8px; white-space: nowrap; border-bottom: 1px solid var(--lb-rule); }
/* 顶线不再画：节头（LbSection）下缘已是一条 2px 题线，紧贴着再来一条就成了双粗线 */
.e2-tbl thead tr { border-top: 0; }
.e2-tbl tbody tr { border-bottom: 1px solid var(--lb-rule-soft); cursor: pointer; }
.e2-tbl tbody tr:last-child { border-bottom: 2px solid var(--lb-rule-strong); }
.e2-tbl tbody tr:hover { background: var(--surface); }
.e2-tbl tbody tr.on { background: var(--surface-2); }
/* 当前行的序号格整格点亮——与另三窗 StationGrid 的 tr.cur > td.sg-sel 同一枚标记，
   下方「链路构成」「详细预算」节头那两枚 #n 与它同形。tr.on 原有的整行灰底保留。 */
.e2-tbl tbody tr.on > td.c-idx { background: var(--accent-fill); color: var(--accent-on); font-weight: 700; }
.e2-tbl td { padding: 2px 8px; text-align: right; color: var(--text); white-space: nowrap; }
/* 行号列：--text-faint 在明暗两主题分别只有 2.5 / 3.1，而它是「第几条链路」的定位列，
   不是装饰——退一档到 muted（5.4 / 6.8），全窗其余文本与控件也一律 ≥4.5。 */
.e2-tbl .c-idx { width: 30px; text-align: left; color: var(--text-muted); }
.e2-tbl .c-nm { text-align: left; min-width: 180px; }
.e2-tbl th.c-nm, .e2-tbl th.c-lib, .e2-tbl th.c-idx { text-align: left; }
.e2-tbl .c-lib { text-align: left; min-width: 150px; }
.e2-tbl .c-n { min-width: 96px; }
.e2-tbl .c-act { width: 100px; text-align: right; }   /* 定位 / 复制 / 删除 三枚钮 + 报错标记 */
/* 名称格：让出输入框自身的 1px 边 + 3px 内距，框里的字与列头「名称」左缘对齐 */
.e2-tbl td.c-nm { padding-left: 4px; }
/* 行尾动作钮平时无框（一列框墙是噪声），悬停 / 当前行才浮出；按钮自身悬停仍描深一档 */
.e2-tbl .c-act .lb-mini-ico { background: transparent; border-color: transparent; }
.e2-tbl tbody tr:hover .c-act .lb-mini-ico:not(:disabled),
.e2-tbl tbody tr.on .c-act .lb-mini-ico:not(:disabled) { background: var(--bg); border-color: var(--border); }
.e2-tbl tbody tr .c-act .lb-mini-ico:hover:not(:disabled) { border-color: var(--border-strong); }
.e2-tbl td.st-bad { color: var(--danger); font-weight: 600; }
.e2-tbl td.st-ok { color: var(--ok); font-weight: 600; }
/* 行内错误标记：与 .e2-refwarn 同一枚三角（危险色），不再用「✕」——那与同格的删除 × 同形同位 */
.e2-err { color: var(--danger); display: inline-flex; vertical-align: middle; margin-right: 4px; }
.e2-refwarn { color: var(--warn); display: inline-flex; vertical-align: middle; margin-left: 3px; }
.e2-in {
  width: 100%; font: inherit; font-size: inherit; padding: 1px 3px; color: var(--text);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.e2-in:hover { background: var(--field-bg); border-color: var(--field-border-hover); }
.e2-in:focus { outline: none; background: var(--field-bg); border-color: var(--accent-ui); }
.e2-in.wide { width: 100%; }
.e2-in.num { text-align: right; font-variant-numeric: tabular-nums; }
.e2-libsel { display: inline-flex; align-items: center; gap: 3px; width: 100%; }
.e2-sel {
  flex: 1; min-width: 0; font: inherit; font-size: inherit; padding: 1px 3px; cursor: pointer;
  color: var(--text); background-color: var(--field-bg); border: 1px solid var(--field-border); border-radius: var(--r-ctl, 2px);
}
.e2-sel:focus { outline: none; border-color: var(--accent-ui); }
.e2-sel.wide { flex: 1; }
/* 「去资源库编辑」小钮：可点的控件一律不用 --text-faint —— 深色下只有 3.1:1，
   而它是 11px 的纯图标，本就最难认。muted 起步，hover 再抬到 accent。 */
.e2-edit {
  flex: none; display: inline-flex; align-items: center; padding: 1px 3px; cursor: pointer;
  color: var(--text-muted); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.e2-edit:hover { color: var(--accent); border-color: var(--border); }

/* —— 中区：链路条 ‖ 检查器 —— */
.e2-mid { display: flex; align-items: flex-start; gap: 14px; }
.e2-strip { flex: 1 1 auto; min-width: 0; }
.e2-insp { flex: 0 0 340px; min-width: 0; border-left: 1px solid var(--lb-rule-soft); padding-left: 12px; }
/* 载波参数面板下放到检查器里。行式排版（标签左、数值右）由 styles/lbworkbench.css 的
   .lbx-flow 那套统管，这里只管两件它管不到的事：
   ① ★ 恒定【单列】。这块的数值框是全局钉死的 112px，检查器又只有 340px：一旦排成两列，
      每格 ~155px 扣掉数值框只剩 ~35px 给标签，「误码率 (1×10⁻ⁿ)」要 75px ⇒ 整屏标签全被
      省略号砍掉（用户实拍即此症）。单列下标签得 200+px，再长的括注也放得下。
   ② 密排：定高行 + 行间发丝线 + 无框数值，与本窗检查器其余读数行同一套。
   scoped 盖不到子组件，故用 :deep()。 */
.e2-insp :deep(.bb-modcod), .e2-insp :deep(.bb-grid), .e2-insp :deep(.bb-rt) {
  grid-template-columns: 1fr; gap: 2px 16px; margin-bottom: 6px;
}
.e2-insp :deep(.bb-rt) { padding-top: 5px; }
.e2-insp :deep(.bb-f) { min-height: 21px; padding: 0; gap: 8px; border-bottom: 1px solid var(--lb-rule-soft); }
.e2-insp :deep(.bb-l) { font-size: var(--fs-3); line-height: 1.25; }
.e2-insp :deep(.bb-i) { font-size: var(--fs-3); padding: 2px 4px; background-color: transparent; border-color: transparent; }
.e2-insp :deep(.bb-i:hover) { background-color: var(--wash-hover); border-color: var(--border); }
.e2-insp :deep(.bb-i:focus) { background-color: var(--bg); border-color: var(--accent-ui); }
/* 速率链：非锚点＝算出来的，退一档；锁定档（下游段）整列都是读数 */
.e2-insp :deep(.bb-rt .bb-i) { color: var(--text-muted); }
.e2-insp :deep(.bb-rt .bb-i.bb-anch) { color: var(--text); }
.e2-insp :deep(.bb-i[readonly]) { cursor: not-allowed; }
.e2-insp :deep(.bb-ntn) { font-size: var(--fs-2); line-height: 1.45; }
.e2-insp-hd { display: flex; align-items: baseline; gap: 6px; padding-bottom: 3px; margin-bottom: 5px; border-bottom: 1px solid var(--lb-rule); }
.e2-insp-t { font-size: var(--fs-3); font-weight: 700; letter-spacing: var(--ls-label); color: var(--text); }
.e2-insp-s { font-size: var(--fs-2); color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-insp-none { font-size: var(--fs-3); color: var(--text-faint); }
.e2-ref { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
/* 站名 ＝ 选址：输入框就是搜索框，命中项浮在其下（检索结果是数据，不占常驻版面） */
.e2-city { position: relative; flex: 1; min-width: 0; }
.e2-city-row { display: flex; align-items: stretch; gap: 4px; }
.e2-cityb { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 20px; padding: 0; cursor: pointer; color: var(--text-faint); background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px); }
.e2-cityb:hover { color: var(--accent); background: var(--field-bg); border-color: var(--field-border-hover); }
.e2-city-pop {
  position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 2px);
  overflow-y: auto; padding: 2px;   /* 高度上界随余量算，见 cityFlip */
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px);
  box-shadow: var(--shadow-2);
}
.e2-city-pop.up { top: auto; bottom: calc(100% + 2px); }
.e2-city-i {
  display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 2px 5px; cursor: pointer; text-align: left;
  color: var(--text); background: transparent; border: 0; border-radius: var(--r-ctl, 2px);
}
/* 选项拾取器（spec P3 第二类）：光标项是机位色淡罩 + 原字色，不是命令菜单那种实底——
   与右键菜单分得开；次级字（省份 / 经纬度）保持各自的退档色 */
.e2-city-i.on { background: color-mix(in srgb, var(--accent-ui) 16%, var(--bg)); color: var(--text); }
.e2-city-n { flex: none; font-size: var(--fs-3); }
.e2-city-x { flex: 1; min-width: 0; font-size: var(--fs-2); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-city-g { flex: none; font-size: var(--fs-2); color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 行首标签列：四字标签（业务速率 / 入段体制 / 解调实现…）在 42px 下会折行，给到 60px 并钉住不换行。
   ★ 是 min-width 不是 width：定死宽度时更长的标签（实际门限 C/N）会溢出去压在读数上。
   四字及以下一律吃满 60px ⇒ 读数列照旧对齐，只有超长那一行把自己的读数往右推。 */
.e2-ref-l { flex: none; min-width: 60px; font-size: var(--fs-3); color: var(--text-muted); white-space: nowrap; }
/* 只读读数（入段体制 / 实际门限 / 本段速率）：与输入行同高，无框 */
.e2-ro { flex: 1; min-width: 0; font-size: var(--fs-3); color: var(--text); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-tagline { font-size: var(--fs-2); color: var(--text-faint); margin: 2px 0 5px; }
.e2-sub { margin: 8px 0 3px; padding-bottom: 2px; font-size: var(--fs-3); letter-spacing: var(--ls-label); color: var(--text-muted); border-bottom: 1px solid var(--lb-rule); }
/* 自动几何读数行：解出来的斜距/仰角（送进引擎的那份），与上方手动单元格并存互不覆盖 */
.e2-auto { display: flex; align-items: baseline; gap: 6px; margin-top: 6px; font-size: var(--fs-3); color: var(--text); font-variant-numeric: tabular-nums; }
.e2-auto-l { flex: none; min-width: 4em; font-size: var(--fs-3); color: var(--text-muted); }
.e2-auto em { font-style: normal; font-size: var(--fs-2); color: var(--text-muted); }

/* 详细预算区的端到端专属排版（.e2-doc）不在这里：PDF 打印页（src/report/ReportApp.vue）
   要画同一张表，写成本组件的 scoped 规则它就吃不到。故整块存在 styles/lbworkbench.css
   的 .e2-doc 一节——那批规则全部带 .e2-doc 前缀，三窗的 DOM 上没有这个类，压不到它们。 */
</style>
