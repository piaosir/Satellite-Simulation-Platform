<script setup>
// 端到端链路预算工作台（第四窗，多跳 / 混合转发）。
//
// 与前三窗的关系：三库（地球站 / 卫星 / 载波）与工作台范式照旧，独有的是「链」这个对象——
// 一行 = 一条端到端链路 = 节点序列 + hop 序列。计算只有正向电平递推一种（引擎 utils/linkChain.js），
// 因此功能区没有「计算方式」选择器：多跳下反算欠定，「该调哪个旋钮」由逐段余量排序（弱段高亮）承担。
// 几何全部手填（斜距 / 星间距离），留空即该行报错——不按轨道高度兜底换算。
import { ref, reactive, computed, onMounted, watch, nextTick } from 'vue'
import ActivationLock from '../components/ActivationLock.vue'
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import ConfigTreeMenu from '../components/ConfigTreeMenu.vue'
import { useConfigTree } from '../shared/useConfigTree.js'
import LbSection from '../components/LbSection.vue'
import LbLibrary from '../components/LbLibrary.vue'
import LbFontCtl from '../components/LbFontCtl.vue'
import LbSlantTool from '../components/LbSlantTool.vue'
import LbIslRangeTool from '../components/LbIslRangeTool.vue'
import LbReportDialog from '../components/LbReportDialog.vue'
import EarthStationPanel from '../components/EarthStationPanel.vue'
import BasebandPanel from '../ngso/BasebandPanel.vue'
import WaterfallTable from '../ngso/WaterfallTable.vue'
import ChainStrip from './ChainStrip.vue'
import E2eFields from './E2eFields.vue'
import E2eSatPanel from './E2eSatPanel.vue'
import { loadSatTree } from '../ngso/satTree.js'
import { fmtGeoSlot } from '../shared/orbitClass.js'   // 轨位 °E/°W 折算（西经不再写成负°E）
import {
  ES_FIELDS, ES_COMMON_FIELDS, ES_TX_FIELDS, ES_RX_FIELDS,
  SAT_FIELDS, SAT_TXP_FIELDS, SAT_REGEN_FIELDS, SAT_INTF_UP_FIELDS, SAT_INTF_DN_FIELDS,
  NODE_ES_FIELDS, NODE_ES_TX_FIELDS, NODE_DEMOD_FIELDS, HOP_GS_FIELDS, HOP_ISL_FIELDS, HOP_LASER_FIELDS, GS_SIDE_DEFAULTS,
  defaultsFor, newEsNode, newSatNode, newHop, hopTypeOf, isSpaceHop, intfKeysFor, thresholdEffLive, segmentsOf, buildChain, uid,
  blankNgsoSat, normNgsoSat, orbitSpecOf, defaultCarrier, chainInfoRate, serializeChainsState,
  orbitAltKmOf, gsoLookAngles, suggestIslRangeKm
} from './e2eParams.js'
import { useLbReport } from '../shared/useLbReport.js'
import { syncAutoNames, adoptAutoFlag, withAutoFlag, newCfgName, newFolderName, copyNameOf } from '../shared/lbAutoName.js'
import { byLang, isDefaultName } from '../shared/i18n/lang.js'   // 自动生成的名字是数据、呈现层翻不到，生成时就按平台语言出字
import { stableStringify } from '../shared/configDirty.js'
import { slantWgs84Max } from '../shared/slantRange.js'
import { pf } from '../shared/num.js'
import { getLang, onLangChange } from '../shared/i18n/runtime.js'

const api = typeof window !== 'undefined' ? window.api : null
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
  sideResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { w.value = Math.min(max, Math.max(min, startW + (ev.clientX - startX))) }
  const up = () => {
    sideResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
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
  if (n > 0 && !(await askConfirm(`「${cfg.name}」正被 ${n} 处链路引用，删除后这些引用将回退到库中第一份配置。确定删除？`))) return
  const i = arr.indexOf(cfg); if (i >= 0) arr.splice(i, 1)
}
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
  _libT = setTimeout(() => { api.store.saveLibrary(LIB_NS, serializeLibrary()).catch((e) => toast('资源库保存失败：' + ((e && e.message) || e))) }, 500)
}
// 关窗前冲刷挂起的那次防抖写盘：库改动不入场景指纹，guardedLeave 拦不住它，改完 0.5 秒内关窗就丢
async function flushLibSave() {
  if (!_libLoaded || !api) return
  clearTimeout(_libT)
  try { await api.store.saveLibrary(LIB_NS, serializeLibrary()) } catch (e) { /* 关窗途中失败不阻断 */ }
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
// 每个段起点都得有一份具体的体制（面板要有值可编辑）：没有就整套照抄链首＝「和第一跳一致」。
// 只是 UI 便利——引擎侧缺了也会回落链首那份（见 e2eParams 的 buildChain）。
function ensureSegCarriers(row) {
  if (!row || !row.nodes.length) return
  if (!row.nodes[0].carrier) row.nodes[0].carrier = defaultCarrier()
  for (const sg of segmentsOf(row.nodes)) {
    const nd = row.nodes[sg.from]
    if (nd && !nd.carrier) nd.carrier = JSON.parse(JSON.stringify(row.nodes[0].carrier))
  }
}
// 链首那份体制（唯一定义业务速率的地方）
const headCarrier = computed(() => (cur.value && cur.value.nodes[0] && cur.value.nodes[0].carrier) || null)
const chains = reactive([defaultChain()])
const curIdx = ref(0)
const cur = computed(() => chains[curIdx.value] || null)
const sel = reactive({ type: 'node', index: 0 })
const results = reactive({})     // _id → 引擎 data
const errors = reactive({})      // _id → 报错文本
const curResult = computed(() => (cur.value ? results[cur.value._id] || null : null))

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
// hop 的类型由两端节点定死，改拓扑就可能把一跳从星地变成星间（或反过来）。故每次改完都按
// 新类型给相关跳「重新播种」：变成星间的换星间默认（23 GHz / 45 dBW / 12 dB/K / 1 dB，
// ★ 距离留空——几何全部手填，留空即报错，绝不替用户编一个数），变回星地的承接原星地那套频率/
// 极化/斜距/仰角。不播种就会出现「星间跳挂着 14.25 GHz 上行频率」这种串味参数。
// ★ 承接分【有向】与【无向】两类：几何量（斜距/仰角/附加损耗）与方向无关，一律承接；频率与
//   极化是有向的——新跳与来源跳反向（链首接卫星把上行跳换成下行跳）或来源本是星间跳时，承接过来
//   就是「下行跳挂着上行的 14.25 GHz/V」这种串味参数，此时取新跳这一侧的默认值。
function reseedHop(row, i, gs, gsFromType) {
  const h = row.hops[i]; if (!h) return
  const t = hopTypeOf(row.nodes[i], row.nodes[i + 1], h)
  if (!t) return
  if (isSpaceHop(t)) { Object.assign(h, defaultsFor(HOP_ISL_FIELDS)); return }
  if (!gs) return
  const from = (gsFromType === undefined) ? gs.fromType : gsFromType
  h.slantRange = gs.slantRange; h.elevation = gs.elevation; h.miscLoss = gs.miscLoss
  if (from === t) { h.frequency = gs.frequency; h.polarization = gs.polarization }
  else { const d = GS_SIDE_DEFAULTS[t] || {}; h.frequency = d.frequency; h.polarization = d.polarization }
}
// 承接给新跳的星地参数 + 它的【来源跳类型】（up/down/isl/laser，由 hopTypeOf 在改拓扑前算出）
const gsParamsOf = (h, fromType) => ({
  frequency: h.frequency, polarization: h.polarization,
  slantRange: h.slantRange, elevation: h.elevation, miscLoss: h.miscLoss, fromType
})
// 改拓扑即作废这条链上一次解出的自动几何：它是按【旧的】跳序解的，跳的增删会让它整体错位，
// 挂在新拓扑上显示就是张冠李戴。结果本身照旧留着（另有「输入已变」提示），只清几何。
function clearSolved(row) { if (row) delete geoSolved[row._id] }
function insertNode(hopIdx, kind) {
  const row = cur.value; if (!row) return
  const old = row.hops[hopIdx]
  const oldType = hopTypeOf(row.nodes[hopIdx], row.nodes[hopIdx + 1], old)
  // 地面转接站的入跳是星地下行、出跳是星地上行 ⇒ 只能插在星间跳上；插在星地跳上会造出
  // 「地球站 → 地球站」这种非卫星链路（引擎会直接拒绝），故这里先挡住。
  if (kind === 'es' && !isSpaceHop(oldType)) { toast('地面转接站只能插在星间跳上（两端须是卫星）'); return }
  const nd = kind === 'es' ? newEsNode(nodeName('relay')) : newSatNode(kind)
  if (kind === 'es') { nd.longitude = '104.0'; nd.latitude = '30.6'; nd.name = nodeName('relay') }
  // 拆出来的两跳里，与原跳同向的那一跳全承接（另一跳必是星间跳，走星间默认）
  const gs = isSpaceHop(oldType) ? null : gsParamsOf(old, oldType)
  row.nodes.splice(hopIdx + 1, 0, nd)
  row.hops.splice(hopIdx + 1, 0, newHop('rf'))
  reseedHop(row, hopIdx, gs, oldType); reseedHop(row, hopIdx + 1, gs, oldType)
  ensureSegCarriers(row); clearSolved(row); syncChainNames(); markStale()
  sel.type = 'node'; sel.index = hopIdx + 1
}
function removeAt(kind, i) {
  const row = cur.value; if (!row) return
  if (kind !== 'node') return
  if (row.nodes.length <= 2) { toast('链最少 2 个节点'); return }
  const last = row.nodes.length - 1
  // 端点：删它连带删相邻那一跳，链就此缩短（链端不必是地球站，故端点也可删）
  if (i === 0) { row.nodes.splice(0, 1); row.hops.splice(0, 1) }
  else if (i === last) { row.nodes.splice(last, 1); row.hops.splice(last - 1, 1) }
  else {
    // 删中间节点会把它两侧的节点接到一起——若两侧都是地球站，接出来就是「地球站直连地球站」
    // 这种非卫星链路（引擎会拒）。与 insertNode 的前置 toast 同一处理哲学：当场挡住，不等点计算。
    const after = row.nodes.slice(0, i).concat(row.nodes.slice(i + 1))
    for (let k = 0; k + 1 < after.length; k++) {
      if (after[k].kind === 'es' && after[k + 1].kind === 'es') { toast('删除后将出现地球站直连地球站（非卫星链路）'); return }
    }
    const oldType = hopTypeOf(row.nodes[i - 1], row.nodes[i], row.hops[i - 1])
    const gs = gsParamsOf(row.hops[i - 1], oldType)
    row.nodes.splice(i, 1)
    row.hops.splice(i, 1)                  // 删节点即删它右侧那一跳，左侧那跳接上下游
    reseedHop(row, i - 1, gs, oldType)     // 接上下游后类型可能变（如两星间去掉转接站 ⇒ 星地变星间）
  }
  ensureSegCarriers(row); clearSolved(row); syncChainNames(); markStale()
  sel.type = 'node'; sel.index = Math.min(i, row.nodes.length - 1)
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
  const hopIdx = (i === 0) ? 0 : last - 1
  // 端点切成地球站前先看相邻那个：也是地球站就挡住（与 extendEnd 同一条口径、同一句文案）
  if (old.kind !== 'es') {
    const nb = row.nodes[i === 0 ? 1 : last - 1]
    if (nb && nb.kind === 'es') { toast('地球站不能直连地球站'); return }
  }
  const oldType = hopTypeOf(row.nodes[hopIdx], row.nodes[hopIdx + 1], row.hops[hopIdx])
  const gs = gsParamsOf(row.hops[hopIdx], oldType)
  if (old.kind === 'es') {
    row.nodes[i] = newSatNode('regen', old.name && !PLACEHOLDER_NODE_NAMES.includes(old.name) ? old.name : '')
  } else {
    const es = newEsNode(nodeName(i === 0 ? 'tx' : 'rx'))
    if (i !== 0) { es.longitude = '109.5'; es.latitude = '18.25' }
    row.nodes[i] = es
  }
  // 体制跟着这个位置走：链首换了人，业务定义（含信息速率）不能跟着没了
  if (old.carrier) row.nodes[i].carrier = JSON.parse(JSON.stringify(old.carrier))
  reseedHop(row, hopIdx, gs, oldType)
  ensureSegCarriers(row); clearSolved(row); syncChainNames(); markStale()
  sel.type = 'node'; sel.index = i
}

// 端点向外接一个节点：链首往前接、链尾往后接（链两端不必是地球站，故两种都可接）。
// 地球站直连地球站不是卫星链路 ⇒ 端点已是地球站时只让接卫星（菜单里也据此隐藏）。
function extendEnd(i, kind) {
  const row = cur.value; if (!row) return
  const head = i === 0
  const old = row.nodes[i]
  if (kind === 'es' && old.kind === 'es') { toast('地球站不能直连地球站'); return }
  const nd = kind === 'es' ? newEsNode(nodeName(head ? 'tx' : 'rx')) : newSatNode('regen')
  if (kind === 'es' && !head) { nd.longitude = '109.5'; nd.latitude = '18.25' }
  const h = newHop('rf')
  // 相邻那一跳（承接的来源）与它的类型：在改拓扑前算好——链首接一颗星会让原本的上行跳
  // 在新跳这一侧变成下行，方向反转下频率/极化不能承接（见 reseedHop）
  const nearIdx = head ? 0 : row.hops.length - 1
  const near = row.hops[nearIdx]
  const nearType = near ? hopTypeOf(row.nodes[nearIdx], row.nodes[nearIdx + 1], near) : null
  if (head) { row.nodes.unshift(nd); row.hops.unshift(h) } else { row.nodes.push(nd); row.hops.push(h) }
  const hopIdx = head ? 0 : row.hops.length - 1
  // 新跳按其类型播种：星地跳承接相邻那跳的几何（频率/极化按侧向定），星间跳走星间默认（距离仍留空）
  reseedHop(row, hopIdx, near ? gsParamsOf(near, nearType) : null, nearType)
  ensureSegCarriers(row); clearSolved(row); syncChainNames(); markStale()
  sel.type = 'node'; sel.index = head ? 0 : row.nodes.length - 1
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
  nd.name = c.name
  nd.longitude = String(c.lon != null ? c.lon : c.longitude)
  nd.latitude = String(c.lat != null ? c.lat : c.latitude)
  cityClose(); markStale()   // 站址跟着城市走，降雨率/海拔由站址扫描接手（见下方 scanSites）
}
// 下拉行右侧的站址读数：与单元格同一套记法（经度恒为 °E 轴，西经记负；纬度北正南负）
const cityGeo = (c) => `${(+c.lon).toFixed(1)}°E ${(+c.lat).toFixed(1)}°N`
const citySub = (c) => [c.en, c.country].filter(Boolean).join(' · ')
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
  const clean = !isDirty()
  let wrote = false
  if (g.rainRate != null && nd.rainRate === pend.rain) { nd.rainRate = String(g.rainRate); wrote = true }
  if (g.altitude != null && nd.altitude === pend.alt) { nd.altitude = String(g.altitude); wrote = true }
  // 自动取值不是「用户的改动」：取值前本就干净（刚载入 / 刚新建）就把脏态基线推到新值，
  // 否则会「什么都没改却提示未保存」（GEO 窗的 GRD 回填踩过同一个坑，同一套修法）
  if (wrote && clean) setBaseline()
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
// kbps 读数自适应：≥1000 报 Mbps（与三窗结果列的档位口径一致）
const fmtQtyRate = (kbps) => (Math.abs(kbps) >= 1000 ? (kbps / 1000).toFixed(3).replace(/\.?0+$/, '') + ' Mbps' : String(Number(kbps.toFixed(3))) + ' kbps')

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
// 卫星树（星座3D 页导入的星，作 NGSO 取星来源之一；窗口重获焦点时刷新）
const satTree = ref(loadSatTree().sats)
const geoSolved = reactive({})   // 链路_id → [{ slantRange, elevation } | { rangeKm }]，自动档解出的几何

const satCfgOf = (nd) => (nd && nd.kind !== 'es') ? resolveSat(nd.satId) : null
const satOrbitOf = (nd) => orbitSpecOf(satCfgOf(nd))
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
async function solveChainGeometry(row, chain) {
  const t0ISO = new Date().toISOString()
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
      let g = null
      try { g = await api.linkBudget.ngsoGeometry({ orbit, tx: st, rx: st, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { g = null }
      if (!g || !g.feasible) return { error: `第 ${i + 1} 跳几何无解：${(g && g.reason) || '求解失败'}` }
      const w = g.worst.up
      chain.hops[i].slantRange = w.slantKm.toFixed(2)
      chain.hops[i].elevation = w.elevDeg.toFixed(2)
      solved.push({ slantRange: w.slantKm.toFixed(2), elevation: w.elevDeg.toFixed(2), method: g.method || '' })
    } else {
      const orbitA = satOrbitOf(a), orbitB = satOrbitOf(b)
      if (!orbitA || !orbitB) return { error: `第 ${i + 1} 跳：星间两端须各有可用轨道（「${satLabelOf(!orbitA ? a : b)}」缺轨道）` }
      let g = null
      try { g = await api.linkBudget.islGeometry({ orbitA, orbitB, t0ISO, horizonHours: geoHorizonHours.value, freqGHz: pf(h.frequency) || 23 }) } catch (e) { g = null }
      if (!g || !g.feasible) return { error: `第 ${i + 1} 跳星间几何无解：${(g && g.reason) || '求解失败'}` }
      // 两端解到同一位置（同一颗星 / 同一定点经度）时距离为 0：报因，别把 0 写进引擎再报「缺距离」
      if (!(g.worst.rangeKm > 0)) return { error: `第 ${i + 1} 跳星间距离解得 0 km（两端是同一颗星或同一定点经度）` }
      chain.hops[i].rangeKm = g.worst.rangeKm.toFixed(1)
      solved.push({ rangeKm: g.worst.rangeKm.toFixed(1), method: g.method || '', visibleFrac: g.visibility ? g.visibility.visibleFrac : null })
    }
  }
  return { solved }
}
// 本跳在自动档解出的几何（检查器/链路条读它显示；手动档为空）
const solvedHop = (rowId, i) => (geoSolved[rowId] || [])[i] || null
const curSolvedHop = computed(() => (cur.value && sel.type === 'hop') ? solvedHop(cur.value._id, sel.index) : null)

// ============ 计算 ============
const computing = ref(false)
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }
const resultsStale = ref(false)
function markStale() { if (Object.keys(results).length) resultsStale.value = true }

async function compute() {
  if (!api) { toast('计算需在桌面客户端中运行'); return }
  computing.value = true
  try {
    for (const row of chains) {
      const chain = buildChain(row, { es: resolveEs, sat: resolveSat })
      // 自动档：先按各跳的星与站解几何，写进这份链描述子（用户单元格不动）
      delete geoSolved[row._id]
      if (!geoManual.value) {
        const g = await solveChainGeometry(row, chain)
        if (g.error) { delete results[row._id]; errors[row._id] = g.error; continue }
        geoSolved[row._id] = g.solved
      }
      let r
      try { r = await api.linkBudget.chainCompute(chain) } catch (err) { r = { success: false, message: (err && err.message) || String(err) } }
      if (r && r.success) { results[row._id] = r.data; delete errors[row._id] }
      else { delete results[row._id]; errors[row._id] = (r && r.message) || '计算失败' }
    }
    resultsStale.value = false
    const bad = chains.filter((r) => errors[r._id]).length
    toast(bad ? `已计算 ${chains.length} 条，其中 ${bad} 条报错` : `已计算 ${chains.length} 条链路`)
  } finally { computing.value = false }
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
  try { segments.value = await api.linkBudget.waterfall({ results: JSON.parse(JSON.stringify(d)), lang: reportLang.value, orbitType: ORBIT }) } catch (e) { segments.value = [] }
}
watch([curResult, curIdx], refreshDoc)

function copyWaterfallTsv() {
  const lines = []
  for (const s of segments.value) {
    lines.push((s.no ? '§' + s.no + ' ' : '') + s.title)
    for (const r of s.rows) lines.push([r.sign || '', r.label, r.up, s.cols >= 2 ? r.down : '', s.cols >= 3 ? r.total : '', r.unit].filter((x) => x !== '').join('\t'))
    lines.push('')
  }
  try { navigator.clipboard.writeText(lines.join('\n')); toast('已复制详细预算（TSV）') } catch (e) { toast('复制失败') }
}

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
const { reportDlg, openReportDialog, runReport } = useLbReport({
  api,
  orbitType: ORBIT,
  fieldGroups: [],
  nextTick,
  links: () => reportLinks.value,
  selected: () => curIdx.value,
  setSelected: (i) => { curIdx.value = i },
  showViz: () => false,
  vizRef: () => null,
  lang: () => reportLang.value,
  appVersion: () => appVersion.value,
  paramsFor: () => null,
  // 卫星名/频段留空：一条链跨几颗星、上下行各一个频段，取其一填进封面就是以偏概全。
  // 计算方式是本窗唯一的那一种，如实报出。
  calc: () => ({ satelliteName: '', frequencyBand: '', mode: reportLang.value === 'en' ? 'Forward level recursion' : '正向电平递推' }),
  defaultName: (en) => {
    const n = (cur.value && cur.value.name) || ''
    return en
      ? `E2E_Link_Budget_Report_${(n || 'Results').replace(/[^\w-]+/g, '_')}`
      : `端到端链路预算报告_${(n || '结果').replace(/[\\/:*?"<>|]/g, '_')}`
  },
  toast,
  setError: (m) => toast(m)
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
const islToolSats = computed(() => satConfigs.map((c) => ({ id: c.id, name: c.name || c.form.satelliteName || c.id, orbit: orbitSpecOf(c), summary: satSummary(c) })))
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
const cfgTree = useConfigTree({
  ns: 'e2e', orbitType: ORBIT, api, storageKey: 'e2e/expandedFolders',
  toast, blankState, serializeState, applyState, setBaseline, guardedLeave, askConfirm, defaultCfgName
})
const {
  configs, activeId, focusId, expandedFolders, editing, cfgClip, cfgDlg, ctxMenu,
  loadConfigs, uniqueCfgName, activeName, applyConfig, selectConfig,
  openSaveDlg, confirmCfgDlg, updateConfig, saveCurrent,
  toggleFolder, expandFolder, expandAll, collapseAll, persistExpanded,
  addFolder, addBlankConfig, removeConfig, removeFolder, onDeleteItem, onMove, moveToRoot,
  startRename, commitRename, cancelRename,
  copyItem, cutItem, pasteConfig, ctxItem, ctxIsFolder, openCtx, closeCtx, ctxDo, onCfgKey
} = cfgTree

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
function serializeState() { return serializeChainsState(chains, geoMode.value) }
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
  chains.splice(0, chains.length, ...st.chains.map((c) => ({
    _id: uid('c'), name: c.name || '', nameAuto: c.nameAuto !== false,
    nodes: (c.nodes || []).map((n) => ({ ...n, _id: uid('n') })),
    hops: (c.hops || []).map((h) => ({ ...h, _id: uid('h') }))
  })))
  for (const row of chains) migrateCarriers(row)
  scanGeoSeeds(true)   // 只记录载入态的几何指纹：存盘值优先，此后的输入改动才触发建议值回填
  scanSites(fresh ? 'all' : 'prime')   // 站址取值同理：存盘场景认存盘值，出厂空白场景照站址取
  curIdx.value = 0; sel.type = 'node'; sel.index = 0
  for (const k of Object.keys(results)) delete results[k]
  for (const k of Object.keys(errors)) delete errors[k]
  segments.value = []
  syncChainNames()
}
let _stateT = null
// 工作状态落 localStorage 的唯一出口。关窗 / 刷新前必须同步冲刷一次：600ms 防抖窗内的改动
// 若不冲刷，「保存修改 → 关窗 → 重开」会被更旧的 localStorage 快照盖回去（重开时 applyState(st)
// 叠在已保存配置之上），看起来就是保存没生效。
function flushSaveState() {
  clearTimeout(_stateT)
  try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* ignore */ }
}
function scheduleSaveState() {
  clearTimeout(_stateT)
  _stateT = setTimeout(() => { flushSaveState(); dirtyFlag.value = isDirty() }, 600)
}
watch([chains, activeId, geoMode], () => { syncChainNames(); markStale(); scheduleSaveState() }, { deep: true })
// 库条目与搜索时窗同样是计算输入：改了就亮「输入已变」
watch([esConfigs, satConfigs, geoHorizonHours], () => markStale(), { deep: true })

// 场景指纹：只认序列化后的场景（三库是全局资产、不入指纹，故关窗另有 flushLibSave 兜底）
function fingerprint() { return stableStringify(serializeState()) }
let activeBaseline = ''
const dirtyFlag = ref(false)
function setBaseline() { activeBaseline = fingerprint(); dirtyFlag.value = false }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }

// —— 命名配置 CRUD ——
// 树本身的增删改移 / 剪贴板 / 右键 / 键盘全在 shared/useConfigTree.js（见文件上方 useConfigTree(...) 注入点）。
// 这里只留本窗特有的两件：保存为新配置的预填名、空白配置的内容。
// 空白场景放一条默认链（站-星-站）而不是空数组：本窗口的工作对象就是链，
// 一条都没有的场景选中后无处可编辑，反倒像「载入没生效」。
function defaultCfgName() { return byLang(`端到端 ${chains.length} 条`, `${chains.length} End-to-End Links`) }
function blankState() { _blankSt = serializeChainsState([defaultChain()], 'manual'); return _blankSt }

const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await new Promise((res) => { leaveDlg.name = activeName(); leaveDlg.open = true; _leaveResolve = res })
  if (ans === 'cancel') return false
  // 选了「保存」而没存进去就不放行：改动还在窗口里，用户看到失败提示后可重试或改选「不保存」。
  // （放行＝当场丢数据，而这条路上的失败恰恰是最不该静默的那种。）
  if (ans === 'save') return await updateConfig()
  return true
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
const marginCls = (v) => { const n = parseFloat(v); return isFinite(n) ? (n < 0 ? 'st-bad' : 'st-ok') : '' }
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
  try {
    try { const c = await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    reloadSatTree()
    toast('已刷新最新设置')
  } finally { refreshing.value = false }
}
// 卫星树来自主窗口「星座3D」页（localStorage 同源共享）：窗口重获焦点即重读，
// 纳入此后新导入的星。树里暂时没有的节点不清空所选——已存的轨道根数照常参与计算。
function reloadSatTree() { try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ } }

function onGlobalKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); compute() }
}

onMounted(async () => {
  try { appVersion.value = (api && await api.app.version()) || '' } catch (e) { appVersion.value = '' }
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  try { const lib = api && await api.store.getLibrary(LIB_NS); if (lib) applyLibrary(lib) } catch (e) { /* 保持默认库 */ }
  _libLoaded = true
  scheduleLibSave()
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
      else applyState(st)
    }
  } catch (e) { /* ignore */ }
  // 没有可恢复的工作状态 ⇒ 台面上这条是出厂默认链：按站址取一遍降雨率/海拔
  //（存盘场景走 applyState 里那条，一律存盘值优先）
  if (!_siteFp.size) scanSites('all')
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  for (const row of chains) migrateCarriers(row)   // 老库读进来之后再迁一次（体制引用 → 节点上那份）
  syncChainNames()
  // 关窗序：守卫（可保存/取消）→ 冲刷工作状态（防抖窗内的改动）→ 冲刷资源库 → 放行关闭
  api?.e2e?.onCloseRequested?.(async () => {
    // 守卫里抛错就不放行，但必须把因由说出来——否则表现是「点了保存，窗口既不关也没动静」
    let go = false
    try { go = await guardedLeave() } catch (e) { toast('关闭前保存失败：' + errText(e)); return }
    if (!go) return
    flushSaveState(); await flushLibSave(); api.e2e.confirmClose()
  })
  window.addEventListener('keydown', onGlobalKey)
  window.addEventListener('focus', reloadSatTree)
  window.addEventListener('beforeunload', flushSaveState)   // 开发态刷新 / 兜底
})
</script>

<template>
  <div class="lb-shell">
    <ActivationLock />
    <!-- 配置右键菜单（五窗共用一份，条目与快捷键一致） -->
    <ConfigTreeMenu
      :menu="ctxMenu" :item="ctxItem" :is-folder="ctxIsFolder" :clip="cfgClip" :has-api="!!api"
      @close="closeCtx" @rename="startRename" @new-folder="addFolder" @new-config="addBlankConfig"
      @save-new="openSaveDlg" @cut="cutItem" @copy="copyItem" @paste="pasteConfig" @move-root="moveToRoot"
      @delete="onDeleteItem" @expand-all="expandAll" @collapse-all="collapseAll" @hide="sideView = ''"
    />
    <div class="lb-body">
      <!-- ① 左侧栏：配置列表 / 资源库 二选一 -->
      <aside v-show="sideView" class="lb-col lb-side" :class="[sideView === 'library' ? 'lb-lib' : 'lb-configs', { resizing: sideResizing }]" :style="{ width: sideWidth + 'px' }">
        <template v-if="sideView !== 'library'">
          <div class="lb-col-hd">
            <span class="lb-cfg-hd-t">配置列表</span>
            <span class="lb-cfg-acts">
              <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏配置列表" @click="sideView = ''"><Icon name="x" :size="13" /></button>
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
                      @click="libTab === 'station' ? addEsConfig() : addSatConfig()"><Icon name="plus" :size="13" /></button>
              <button class="lb-mini lb-mini-ico" title="隐藏资源库" @click="sideView = ''"><Icon name="x" :size="13" /></button>
            </span>
          </div>
          <nav class="lb-lib-tabs">
            <button v-for="t in LIB_TABS" :key="t.key" class="lbx-subtab" :class="{ on: libTab === t.key }" :title="t.tip" @click="libTab = t.key">
              {{ t.label }}<span class="lbx-tab-n">{{ t.key === 'station' ? esConfigs.length : satConfigs.length }}</span>
            </button>
          </nav>
          <div class="lb-libpane">
            <LbLibrary v-if="libTab === 'station'" v-model="selEsId" layout="column" :items="esConfigs" :summary="esSummary" name-placeholder="站型名称"
                       auto-tip="天线口径" @add="addEsConfig" @duplicate="duplicateEsConfig" @remove="removeEsConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此配置" @click="duplicateEsConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此配置" :disabled="esConfigs.length <= 1" @click="removeEsConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><EarthStationPanel :form="cfg.form" :common-fields="ES_COMMON_FIELDS" :tx-fields="ES_TX_FIELDS" :rx-fields="ES_RX_FIELDS" /></template>
            </LbLibrary>
            <LbLibrary v-else v-model="selSatId" layout="column" :items="satConfigs" :summary="satSummary" name-placeholder="卫星名（列表用）"
                       auto-tip="卫星名称" @add="addSatConfig" @duplicate="duplicateSatConfig" @remove="removeSatConfig" @toast="toast">
              <template #editor-actions="{ cfg }">
                <button class="lb-mini" title="复制此卫星" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                <button class="lb-mini" title="删除此卫星" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
              </template>
              <template #default="{ cfg }"><E2eSatPanel :form="cfg.form" :ngso-sat="cfg.ngsoSat" :sat-tree="satTree" /></template>
            </LbLibrary>
          </div>
          <div class="lb-lib-foot" :title="(LIB_TABS.find((t) => t.key === libTab) || {}).tip">{{ (LIB_TABS.find((t) => t.key === libTab) || {}).tip }}</div>
        </template>
        <div class="lb-cfg-resizer" title="拖动调整栏宽" @mousedown.prevent="startResizeSide"></div>
      </aside>

      <!-- ② 主区 -->
      <section class="lb-col lb-build">
        <div class="lbr">
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!api" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" @click="saveCurrent">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
                保存<span v-if="dirtyFlag" class="lbx-dirty" title="有未保存的修改"></span>
              </button>
              <button class="lbr-big" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（城市库 / 载波信号选项）" @click="refreshLatest">
                <svg viewBox="0 0 16 16" class="lbr-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
                刷新
              </button>
              <button class="lbr-big" :class="{ on: sideView === 'configs' }" title="左侧栏显示「配置列表」" @click="toggleSide('configs')"><Icon name="panel-left" :size="15" />配置列表</button>
            </div>
            <div class="lbr-cap">文件</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <div class="lbr-form">
                <label title="几何来源：自动最差＝按各跳卫星的轨道解最差工况（GSO 静止几何 / NGSO 选星走 SGP4 / NGSO 手填走圆轨道闭式；星间跳按两星轨道取时窗内最大距离），此时「仰角」字段是最低仰角门限；手动＝斜距与仰角、星间距离由各跳自己填"><span>几何</span>
                  <select v-model="geoMode" style="width: 86px"><option v-for="g in GEO_MODES" :key="g.v" :value="g.v">{{ g.l }}</option></select>
                </label>
                <label v-if="!geoManual" title="从计算此刻起在此时窗内解最差工况几何"><span>时窗</span>
                  <select v-model.number="geoHorizonHours" style="width: 76px"><option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option></select>
                </label>
                <label title="端到端只有正向电平递推一种算法：多跳下反算欠定（目标余量可由发信站功放、任一透明星回退、任一再生星 EIRP 去凑）"><span>算法</span><span class="lbr-u">正向递推</span></label>
              </div>
              <button class="lbr-big primary" :disabled="computing" :title="`计算全部 ${chains.length} 条链路（Ctrl+Enter）`" @click="compute">
                <svg viewBox="0 0 16 16" class="lbr-svg fill"><path d="M4 2.5 13 8 4 13.5z" /></svg>
                {{ computing ? '计算中…' : '计算' }}
              </button>
            </div>
            <div class="lbr-cap">计算</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :class="{ on: sideView === 'library' }" :title="`资源库：地球站 ${esConfigs.length} · 卫星 ${satConfigs.length}`" @click="toggleSide('library')"><Icon name="folder-open" :size="15" />资源库</button>
              <button class="lbr-big" :disabled="!gsHops.length || !geoManual" title="斜距工具：按站址纬度/海拔/仰角与轨道高度算 WGS-84 最大斜距（绕站一圈取最大），填入本跳或本链路全部星地跳（几何=自动时斜距由求解器给出，本工具只服务手动档）" @click="slantToolOpen = true"><Icon name="arrow-left-right" :size="15" />斜距</button>
              <button class="lbr-big" :disabled="!spaceHops.length || !geoManual" title="星间距离工具：两星轨道在时间轴上的星间距离，填入本跳或本链路全部星间跳（几何=自动时距离由求解器给出，本工具只服务手动档）" @click="islToolOpen = true"><Icon name="satellite-dish" :size="15" />星间距离</button>
            </div>
            <div class="lbr-cap">视图 / 工具</div>
          </div>
          <div class="lbr-g">
            <div class="lbr-items">
              <button class="lbr-big" :disabled="!segments.length" title="复制当前详细预算（TSV，可直接粘贴到 Excel）" @click="copyWaterfallTsv"><Icon name="file-text" :size="15" />TSV</button>
              <button class="lbr-big" :disabled="reportDlg.busy || !reportLinks.length" :title="reportLinks.length ? '生成交付级报告：Excel（总报告 + 逐链路详情）/ Word（封面 · 目录 · 正文）/ PDF（封面 · 目录 · 总报告 · 逐链路详情）' : '尚无计算结果'" @click="openReportDialog"><Icon name="file-down" :size="15" />{{ reportDlg.busy ? '生成中…' : '报告' }}</button>
            </div>
            <div class="lbr-cap">导出</div>
          </div>
          <LbFontCtl />
          <div class="lbr-status">
            <span v-if="notice" class="lb-note">{{ notice }}</span>
            <span v-if="!api" class="lb-hint"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
            <span v-if="resultsStale" class="lbx-stale" title="计算输入已被修改，结果对应修改前的参数">输入已变</span>
          </div>
        </div>

        <div class="lbx-flow lbx-cards">
          <!-- 上：链路列表 -->
          <LbSection id="links" title="端到端链路" :count="chains.length" summary="一行一条：节点链 + 段结算">
            <template #actions>
              <button class="lb-mini" title="新增一条链路（站-星-站）" @click="addChain">＋ 链路</button>
            </template>
            <div class="e2-tbl-wrap">
              <table class="e2-tbl">
                <thead>
                  <tr>
                    <th class="c-idx">#</th>
                    <th class="c-nm">名称</th>
                    <th class="c-n" title="这条链的业务信息速率（kbps）：在链首节点的载波参数里填，穿过各再生节点全程守恒；各段的符号率与占用带宽由它与该段 MODCOD 推出">业务速率 (kbps)</th>
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
                    <td class="c-n" :class="marginCls(results[row._id] && results[row._id].e2eMarginResult)">{{ cellNum(results[row._id] && results[row._id].e2eMarginResult) }}</td>
                    <td class="c-n">{{ cellNum(results[row._id] && results[row._id].systemAvailabilityResult) }}</td>
                    <td class="c-n">{{ cellNum(results[row._id] && results[row._id].e2eBerResult) }}</td>
                    <td class="c-n">{{ cellNum(results[row._id] && results[row._id].e2eDelayResult) }}</td>
                    <td class="c-act">
                      <span v-if="errors[row._id]" class="e2-err" :title="errors[row._id]">✕</span>
                      <button class="lb-mini lb-mini-ico" title="复制此链路" @click.stop="duplicateChain(i)"><Icon name="copy" :size="12" /></button>
                      <button class="lb-mini lb-mini-ico" title="删除此链路" :disabled="chains.length <= 1" @click.stop="removeChain(i)"><Icon name="x" :size="12" /></button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="cur && errors[cur._id]" class="lb-err">{{ errors[cur._id] }}</div>
          </LbSection>

          <!-- 中：链路条编辑器 ‖ 右：检查器 -->
          <LbSection id="chain" title="链路构成" flow="chain" :summary="cur ? cur.name : ''">
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
                <div v-if="!cur" class="e2-insp-none">还没有链路。</div>
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
                      <span class="e2-ref-l" title="全链同一个业务速率：只在链首节点填，本节点只换调制方式 / 码率">业务速率</span>
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
                      <button class="e2-edit" title="在资源库中编辑该站型" @click="editInLibrary('station', selNode.esId)"><Icon name="external-link" :size="11" /></button>
                    </div>
                    <div v-if="nodeIsRelay" class="e2-tagline">地面转接站</div>
                    <!-- 功放快调：段起点（发信站 / 转接站上行侧）才有电平意义；空＝跟随库，占位显示库值 -->
                    <E2eFields v-if="selSegIndex >= 0" :fields="NODE_ES_TX_FIELDS" :form="selNode" :base="selEsBase" />
                    <!-- 站名 ＝ 选址：输入即搜城市（中文名 / 拼音 / 英文名 / 国家），选中把经纬度一并填上 -->
                    <div class="e2-ref">
                      <span class="e2-ref-l" title="站名。输入城市名（中文 / 拼音首字母 / 英文 / 国家）即检索，选中后站址经纬度一并填入">站名</span>
                      <div class="e2-city">
                        <input v-model="selNode.name" class="e2-in wide" data-i18n-skip
                               @focus="cityFocus" @input="cityInput" @blur="cityClose"
                               @keydown.down.prevent="cityMove(1)" @keydown.up.prevent="cityMove(-1)"
                               @keydown.enter="cityEnter" @keydown.esc="cityClose" />
                        <div v-if="cityOpen && cityHits.length" ref="cityPopEl" class="e2-city-pop"
                             :class="{ up: cityUp }" :style="{ maxHeight: cityMaxH + 'px' }">
                          <button v-for="(c, ci) in cityHits" :key="c.name" class="e2-city-i" :class="{ on: ci === cityAt }"
                                  data-i18n-skip @mousedown.prevent="pickCity(c)" @mouseenter="cityAt = ci">
                            <span class="e2-city-n">{{ c.name }}</span>
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
                      <button class="e2-edit" title="在资源库中编辑该卫星" @click="editInLibrary('sat', selNode.satId)"><Icon name="external-link" :size="11" /></button>
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
                    <span class="e2-auto-l" title="按本跳卫星轨道与站址解出的最差工况几何（送进引擎的就是这份；上方单元格是手动档的值，不被覆盖）">自动几何</span>
                    <template v-if="curSolvedHop.rangeKm">{{ curSolvedHop.rangeKm }} km</template>
                    <template v-else>{{ curSolvedHop.slantRange }} km · {{ curSolvedHop.elevation }}°</template>
                    <em v-if="curSolvedHop.method">{{ curSolvedHop.method }}</em>
                  </div>
                  <div v-if="geoManual" class="e2-tools">
                    <button v-if="!isSpaceHop(selHopType)" class="lb-mini" title="按站址纬度/海拔/仰角/轨道高度算 WGS-84 最大斜距，填入本跳" @click="slantToolOpen = true">斜距工具</button>
                    <button v-else class="lb-mini" title="两星轨道在时间轴上的星间距离，填入本跳" @click="islToolOpen = true">距离工具</button>
                  </div>
                </template>
              </aside>
            </div>
          </LbSection>

          <!-- 下：结果文档区 -->
          <LbSection id="detail" title="详细预算" :summary="cur ? cur.name : ''">
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
    <LbReportDialog :open="reportDlg.open" :lang="reportLang" orbit-type="E2E"
                    :link-count="reportLinks.length" :viz-available="false" store-key="e2e"
                    :busy="reportDlg.busy" :progress="reportDlg.progress"
                    @close="reportDlg.open = false" @submit="runReport" />

    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <div class="lb-dlg-bd"><input v-model="cfgDlg.name" class="lb-input" placeholder="配置名称" @keyup.enter="confirmCfgDlg" /></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini primary" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b data-i18n-skip>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini primary" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <div v-if="confirmDlg.open" class="lb-mask" @click="answerConfirm(false)">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">确认</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">{{ confirmDlg.msg }}</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="answerConfirm(false)">取消</button>
          <button class="lb-mini primary" @click="answerConfirm(true)">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* —— 工作台外壳（.lb-* 一族）——
   这套类是四个链路预算窗口共用的「壳」，但它们从来是各 App 在自己的 <style scoped> 里各写一份
   （scoped 会给选择器缀上 data-v-，别的组件根本吃不到）。本窗口刚建起来时漏了这一层，后果在
   深色主题下最刺眼：按钮退回浏览器默认样式——UA 给的是浅灰实底，而字色继承自 .lb-shell 的近白
   墨色，于是「白底白字」。故照 RegenLinkBudgetApp 的同名规则原样补齐（改动须与另三窗同步）。 */
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--lb-serif);
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  --up: #3f6d8c; --dn: #97672f;
  --r-ctl: 2px; --r-box: 3px; --r-modal: 4px;
}
html[data-theme='dark'] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; --up: #82a9c6; --dn: #c9a26a; }

/* 功能区「文件」组的刷新按钮：取数中图标旋转（按钮本体走公共 .lbr-big） */
.lbr-big.spin .lbr-svg { animation: lb-spin .7s linear infinite; transform-origin: 50% 50%; }
@keyframes lb-spin { to { transform: rotate(360deg); } }
.lb-hint { color: var(--warn); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.lb-note { color: var(--ok); font-size: 11px; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lb-body { flex: 1; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.lb-col:last-child { border-right: none; }
.lb-side { flex: none; position: relative; transition: width .15s ease; }
.lb-side.resizing { transition: none; user-select: none; }
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
.lb-configs .lb-col-bd { padding: 10px 8px; scrollbar-width: thin; }
.lb-cfg-hd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-build { flex: 1; min-width: 460px; }

.lb-col-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; flex: none; padding: 0 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.lb-col-bd { flex: 1; overflow: auto; padding: 12px; }
.lb-mini { font: inherit; font-size: 11px; line-height: 1; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-mini:disabled { opacity: .45; cursor: not-allowed; }
.lb-mini.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.lb-mini.primary:hover:not(:disabled) { opacity: .88; }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; }
.lb-placeholder { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; }
.lb-cfg-acts { display: flex; gap: 4px; }
/* 右键菜单（.lb-ctx*）不在这儿：它同时被本组件与 ChainStrip 用，scoped 只盖得住自己那半边，
   故收进公共表 styles/lbworkbench.css（前三窗各自 scoped 的同名规则特异度更高，不受影响）。 */
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-mono); color: var(--text); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; }

.lb-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.lb-dlg { width: 380px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.lb-dlg-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lb-dlg-bd { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-dlg-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-input { font: inherit; font-size: 12px; padding: 6px 9px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-input:focus { outline: none; border-color: var(--accent); }
.lb-share-row { font-size: 12px; color: var(--text-muted); }
.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }

/* —— 链路列表：三线表（顶/底粗线 + 列头线），无竖线无底色，与详细预算同一套排版语言 —— */
.e2-tbl-wrap { overflow-x: auto; }
.e2-tbl { width: 100%; border-collapse: collapse; font-size: var(--lb-fs, 11px); font-variant-numeric: tabular-nums; }
.e2-tbl th { text-align: right; font-weight: 600; color: var(--text-muted); padding: 3px 8px; white-space: nowrap; border-bottom: 1px solid var(--lb-rule); }
.e2-tbl thead tr { border-top: 2px solid var(--lb-rule-strong); }
.e2-tbl tbody tr { border-bottom: 1px solid var(--lb-rule-soft); cursor: pointer; }
.e2-tbl tbody tr:last-child { border-bottom: 2px solid var(--lb-rule-strong); }
.e2-tbl tbody tr:hover { background: var(--surface); }
.e2-tbl tbody tr.on { background: var(--surface-2); }
.e2-tbl td { padding: 2px 8px; text-align: right; color: var(--text); white-space: nowrap; }
/* 行号列：--text-faint 在明暗两主题分别只有 2.5 / 3.1，而它是「第几条链路」的定位列，
   不是装饰——退一档到 muted（5.4 / 6.8），全窗其余文本与控件也一律 ≥4.5。 */
.e2-tbl .c-idx { width: 30px; text-align: left; color: var(--text-muted); }
.e2-tbl .c-nm { text-align: left; min-width: 180px; }
.e2-tbl th.c-nm, .e2-tbl th.c-lib, .e2-tbl th.c-idx { text-align: left; }
.e2-tbl .c-lib { text-align: left; min-width: 150px; }
.e2-tbl .c-n { min-width: 96px; }
.e2-tbl .c-act { width: 74px; text-align: right; }
.e2-tbl td.st-bad { color: var(--danger); font-weight: 600; }
.e2-tbl td.st-ok { color: var(--ok); font-weight: 600; }
.e2-err { color: var(--danger); margin-right: 4px; }
.e2-refwarn { color: var(--warn); display: inline-flex; vertical-align: middle; margin-left: 3px; }
.e2-in {
  width: 100%; font: inherit; font-size: inherit; padding: 1px 3px; color: var(--text);
  background: transparent; border: 1px solid transparent; border-radius: var(--r-ctl, 2px);
}
.e2-in:hover { background: var(--bg); border-color: var(--border); }
.e2-in:focus { outline: none; background: var(--bg); border-color: var(--accent); }
.e2-in.wide { width: 100%; }
.e2-in.num { text-align: right; font-variant-numeric: tabular-nums; }
.e2-libsel { display: inline-flex; align-items: center; gap: 3px; width: 100%; }
.e2-sel {
  flex: 1; min-width: 0; font: inherit; font-size: inherit; padding: 1px 3px; cursor: pointer;
  color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-ctl, 2px);
}
.e2-sel:focus { outline: none; border-color: var(--accent); }
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
.e2-insp :deep(.bb-l) { font-size: 11.5px; line-height: 1.25; }
.e2-insp :deep(.bb-i) { font-size: 11.5px; padding: 2px 4px; background: transparent; border-color: transparent; }
.e2-insp :deep(.bb-i:hover) { background: var(--bg); border-color: var(--border); }
.e2-insp :deep(.bb-i:focus) { background: var(--bg); border-color: var(--accent); }
/* 速率链：非锚点＝算出来的，退一档；锁定档（下游段）整列都是读数 */
.e2-insp :deep(.bb-rt .bb-i) { color: var(--text-muted); }
.e2-insp :deep(.bb-rt .bb-i.bb-anch) { color: var(--text); }
.e2-insp :deep(.bb-i[readonly]) { cursor: not-allowed; }
.e2-insp :deep(.bb-ntn) { font-size: 10.5px; line-height: 1.45; }
.e2-insp-hd { display: flex; align-items: baseline; gap: 6px; padding-bottom: 3px; margin-bottom: 5px; border-bottom: 1px solid var(--lb-rule); }
.e2-insp-t { font-size: 11.5px; font-weight: 700; letter-spacing: 1px; color: var(--text); }
.e2-insp-s { font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-insp-none { font-size: 11.5px; color: var(--text-faint); }
.e2-ref { display: flex; align-items: center; gap: 5px; margin-bottom: 4px; }
/* 站名 ＝ 选址：输入框就是搜索框，命中项浮在其下（检索结果是数据，不占常驻版面） */
.e2-city { position: relative; flex: 1; min-width: 0; }
.e2-city-pop {
  position: absolute; z-index: 30; left: 0; right: 0; top: calc(100% + 2px);
  overflow-y: auto; padding: 2px;   /* 高度上界随余量算，见 cityFlip */
  background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box, 3px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, .18);
}
.e2-city-pop.up { top: auto; bottom: calc(100% + 2px); }
.e2-city-i {
  display: flex; align-items: baseline; gap: 6px; width: 100%; padding: 2px 5px; cursor: pointer; text-align: left;
  color: var(--text); background: transparent; border: 0; border-radius: var(--r-ctl, 2px);
}
/* accent 实底上的字一律 var(--bg)：写死 #fff 在浅色主题下就是白底白字 */
.e2-city-i.on { background: var(--accent); color: var(--bg); }
.e2-city-i.on .e2-city-x, .e2-city-i.on .e2-city-g { color: var(--bg); opacity: .82; }
.e2-city-n { flex: none; font-size: 11.5px; }
.e2-city-x { flex: 1; min-width: 0; font-size: 10.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-city-g { flex: none; font-size: 10.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 行首标签列：四字标签（业务速率 / 入段体制 / 解调实现…）在 42px 下会折行，给到 60px 并钉住不换行。
   ★ 是 min-width 不是 width：定死宽度时更长的标签（实际门限 C/N）会溢出去压在读数上。
   四字及以下一律吃满 60px ⇒ 读数列照旧对齐，只有超长那一行把自己的读数往右推。 */
.e2-ref-l { flex: none; min-width: 60px; font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
/* 只读读数（入段体制 / 实际门限 / 本段速率）：与输入行同高，无框 */
.e2-ro { flex: 1; min-width: 0; font-size: 11.5px; color: var(--text); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.e2-tagline { font-size: 11px; color: var(--text-faint); margin: 2px 0 5px; }
.e2-sub { margin: 8px 0 3px; padding-bottom: 2px; font-size: 11.5px; letter-spacing: 1px; color: var(--text-muted); border-bottom: 1px solid var(--lb-rule); }
.e2-tools { margin-top: 8px; display: flex; gap: 6px; }
/* 自动几何读数行：解出来的斜距/仰角（送进引擎的那份），与上方手动单元格并存互不覆盖 */
.e2-auto { display: flex; align-items: baseline; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--text); font-variant-numeric: tabular-nums; }
.e2-auto-l { flex: none; width: 42px; font-size: 11.5px; color: var(--text-muted); }
.e2-auto em { font-style: normal; font-size: 10.5px; color: var(--text-muted); }

/* 详细预算区的端到端专属排版（.e2-doc）不在这里：PDF 打印页（src/report/ReportApp.vue）
   要画同一张表，写成本组件的 scoped 规则它就吃不到。故整块存在 styles/lbworkbench.css
   的 .e2-doc 一节——那批规则全部带 .e2-doc 前缀，三窗的 DOM 上没有这个类，压不到它们。 */
</style>
