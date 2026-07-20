<script setup>
import { ref, shallowRef, reactive, computed, onMounted, nextTick, watch } from 'vue'
import { SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, ISL_FIELDS, LASER_FIELDS, defaultsFor, buildRegenParams, buildRegenDownlinkParams, buildRegenIslParams, buildRegenLaserParams, eirpToPowerW, powerWToEirp, rxGtFromNoise } from './regenParams.js'
import { stableStringify } from '../shared/configDirty.js'
import { pf } from '../shared/num.js'   // 全角容错 parseFloat：手填圆轨道高度/倾角（经 sat 面板，不过 StationGrid 归一）也能吃全角数字
import { loadSatTree } from '../ngso/grdParam.js'
import { encodeShare, decodeShare, configFileText } from '../ngso/shareCode.js'
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import StationGrid from '../ngso/StationGrid.vue'
import BasebandPanel from '../ngso/BasebandPanel.vue'
import RegenSatPanel from './RegenSatPanel.vue'
import WaterfallTable from '../ngso/WaterfallTable.vue'

const api = typeof window !== 'undefined' ? window.api : null

// ============ 配置列表（多级文件夹树；持久化 orbitType='REGEN' 独立命名空间）============
const configs = ref([])
const activeId = ref(null)
const expandedFolders = ref(new Set(JSON.parse(localStorage.getItem('regen/expandedFolders') || '[]')))
function persistExpanded() { try { localStorage.setItem('regen/expandedFolders', JSON.stringify([...expandedFolders.value])) } catch (e) { /* ignore */ } }
function toggleFolder(f) { const s = new Set(expandedFolders.value); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); expandedFolders.value = s; persistExpanded() }
const configsCollapsed = ref(localStorage.getItem('regen/configsCollapsed') === '1')
watch(configsCollapsed, (v) => { try { localStorage.setItem('regen/configsCollapsed', v ? '1' : '0') } catch (e) { /* ignore */ } })
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('regen/configsWidth')) || 210)))
const configsResizing = ref(false)
function startResizeConfigs(e) {
  const startX = e.clientX, startW = configsWidth.value
  configsResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { configsWidth.value = Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, startW + (ev.clientX - startX))) }
  const up = () => {
    configsResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem('regen/configsWidth', String(configsWidth.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// ============ 再生式体制：上行（v1）/ 下行（广播）/ 星间链路 ============
const LINK_MODES = [
  { key: 'uplink', label: '再生式上行', ready: true, tip: '地球站 → 星上再生解调；链路总 C/N = 上行 C/(N+I)' },
  { key: 'downlink', label: '再生式下行（广播）', ready: true, tip: '星上再生 → 地球站接收；链路总 C/N = 下行 C/(N+I)' },
  { key: 'isl', label: '星间链路（微波）', ready: true, tip: '发射卫星 → 接收卫星，两星微波直连；几何严格（双 SGP4 + 地球临边遮挡）；合计 C/N = 星间单跳 C/N' },
  { key: 'laser', label: '星间链路（激光）', ready: true, tip: '发射卫星 → 接收卫星，相干 DP-QPSK 激光直连；第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；给定速率 → 链路余量；完整可用度（指向抖动+建链+相干多普勒+太阳规避）' }
]
const linkMode = ref('uplink')

// ============ 再生式模式标签：用户可关闭不需要的模式（× 需确认，避免误删），随配置保存/分享；「+」可恢复 ============
// 关闭 = 隐藏该标签（当前配置范围），不删除已填参数；至少保留一个模式。
const hiddenModes = ref([])                                                          // 当前配置下被隐藏的模式 key
const visibleModes = computed(() => LINK_MODES.filter((m) => !hiddenModes.value.includes(m.key)))
const hiddenModeList = computed(() => LINK_MODES.filter((m) => hiddenModes.value.includes(m.key)))
const addMenuOpen = ref(false)
async function requestHideMode(m) {
  if (visibleModes.value.length <= 1) { toast('至少保留一个再生式模式'); return }
  if (!(await askConfirm(`关闭「${m.label}」？将从标签栏移除该模式（可点「+」恢复），已填的对应参数保留不删。`))) return
  if (!hiddenModes.value.includes(m.key)) hiddenModes.value = [...hiddenModes.value, m.key]
  if (linkMode.value === m.key) { const first = visibleModes.value[0]; if (first) linkMode.value = first.key }  // 关的是当前标签 → 切到剩下第一个
}
function restoreMode(m) {
  hiddenModes.value = hiddenModes.value.filter((k) => k !== m.key)
  addMenuOpen.value = false
  if (m && m.ready) linkMode.value = m.key                                          // 恢复即聚焦，让用户看到它回来了
}

// ============ 卫星群（每颗 NGSO 式：搜索/天线树选星，无 EIRP 匹配；卫星 G/T 由发信站逐站手动输入）============
let _satSeq = 1
function makeSatConfig(name) { return { id: 'sat' + (_satSeq++), name, form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } } }
const satConfigs = reactive([makeSatConfig('卫星1')])
function resolveSatellite(id) {
  if (!id) return satConfigs[0]
  return satConfigs.find((c) => c.id === id) || satConfigs.find((c) => c.name === id) || satConfigs[0]
}
const satSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...satConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addSatConfig() { satConfigs.push(makeSatConfig('卫星' + (satConfigs.length + 1))) }
function duplicateSatConfig(cfg) { satConfigs.push({ id: 'sat' + (_satSeq++), name: cfg.name + ' 副本', form: JSON.parse(JSON.stringify(cfg.form)), ngsoSat: JSON.parse(JSON.stringify(cfg.ngsoSat)) }) }
function removeSatConfig(cfg) { if (satConfigs.length <= 1) return; const i = satConfigs.findIndex((c) => c.id === cfg.id); if (i >= 0) satConfigs.splice(i, 1) }
// 天线树（星座3D 导入的卫星）——作卫星轨道来源；切到「卫星群」时刷新
const satTree = ref(loadSatTree().sats)
function reloadSatTree() { try { satTree.value = loadSatTree().sats } catch (e) { /* keep */ } }

// ============ 载波信号配置库 ============
let _bbSeq = 1
function makeBasebandConfig(name) { return { id: 'bb' + (_bbSeq++), name, form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1 } } }
const basebandConfigs = reactive([makeBasebandConfig('默认')])
const basebandOpts = ref({})
function resolveBaseband(id) {
  if (!id) return basebandConfigs[0]
  return basebandConfigs.find((c) => c.id === id) || basebandConfigs.find((c) => c.name === id) || basebandConfigs[0]
}
const basebandSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...basebandConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addBasebandConfig() { basebandConfigs.push(makeBasebandConfig('配置' + (basebandConfigs.length + 1))) }
function duplicateBasebandConfig(cfg) { basebandConfigs.push({ id: 'bb' + (_bbSeq++), name: cfg.name + ' 副本', form: JSON.parse(JSON.stringify(cfg.form)) }) }
function removeBasebandConfig(cfg) { if (basebandConfigs.length <= 1) return; const i = basebandConfigs.findIndex((c) => c.id === cfg.id); if (i >= 0) basebandConfigs.splice(i, 1) }

// ============ 发信站群 ============
let _sid = 1
const newStation = (fields) => { const r = defaultsFor(fields); r._id = 's' + (_sid++); return r }
const txStations = reactive([newStation(TX_FIELDS)])

// —— 工作点列：EIRP(dBW) ⇄ 功放功率(W) 切换（换算保持物理工作点不变）——
const opMode = ref(localStorage.getItem('regen/opMode') === 'power' ? 'power' : 'eirp')
watch(opMode, (v) => { try { localStorage.setItem('regen/opMode', v) } catch (e) { /* ignore */ } })
// 传给 StationGrid 的字段：工作点列 label/unit 随 opMode 动态改
const txFieldsView = computed(() => TX_FIELDS.map((f) => f.key === 'opPoint'
  ? { ...f, label: opMode.value === 'power' ? '功放功率' : '工作点EIRP', unit: opMode.value === 'power' ? 'W' : 'dBW' }
  : f))
function fmtOp(n, isW) { if (!isFinite(n)) return ''; return isW ? String(Math.round(n * 1000) / 1000) : String(Math.round(n * 100) / 100) }
function setOpMode(m) {
  if (m === opMode.value) return
  for (const tx of txStations) {
    const v = parseFloat(tx.opPoint); if (isNaN(v)) continue
    const sat = resolveSatellite(tx.satelliteId); if (!sat) continue
    const conv = (opMode.value === 'eirp' && m === 'power') ? eirpToPowerW(v, tx, sat.form) : powerWToEirp(v, tx, sat.form)
    if (isFinite(conv)) tx.opPoint = fmtOp(conv, m === 'power')
  }
  opMode.value = m
}
// 某发信站的工作点 → 引擎 power 模式所需功放 W
function stationPowerW(tx, satForm) {
  return opMode.value === 'power' ? parseFloat(tx.opPoint) : eirpToPowerW(tx.opPoint, tx, satForm)
}

// ============ 收信站群（再生式下行）============
// 工作点 G/T 恒由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算得
// （不再支持「直接输入设备 G/T」——设备 G/T 系统噪温未知，无法自洽推出雨致 G/T 劣化）。
const rxStations = reactive([newStation(RX_FIELDS)])
// 收信站 G/T 只读列：随天线/噪温/馈线 + 所选卫星下行频率实时算出的晴空 G/T（与引擎 gOverTe 同口径），
// 让用户编辑参数时即时看到 G/T，无需先计算。传给 StationGrid 的 ro-values（{ _id: 值 }）。
const rxGtValues = computed(() => {
  const m = {}
  for (const rx of rxStations) {
    const sat = resolveSatellite(rx.satelliteId)
    const gt = sat ? rxGtFromNoise(rx, sat.form) : NaN
    m[rx._id] = isFinite(gt) ? (Math.round(gt * 100) / 100).toFixed(2) : ''
  }
  return m
})

// ============ 星间链路群（再生式微波 ISL）============
const islLinks = reactive([newStation(ISL_FIELDS)])
// ============ 星间激光链路群（再生式激光 / 相干 DP-QPSK）============
const laserLinks = reactive([newStation(LASER_FIELDS)])
// 某卫星配置 → 轨道来源 spec（选星→真实星历；未选→手动圆轨道）。上/下/星间共用。
function orbitSpecOf(sat) {
  const ns = sat && sat.ngsoSat
  const selectedStar = ns && ns.mode !== 'manual' && ns.orbit
  return selectedStar ? JSON.parse(JSON.stringify(ns.orbit))
    : { type: 'circular', altKm: pf(sat.form.orbitAltitude) || 0, inclDeg: pf(sat.form.orbitInclination) || 0 }
}
// 搜索时窗起点 t0：不再锚各星 TLE/场景历元，一律锚到「计算此刻」的墙钟绝对时（用户口径「从当前时间开始」扫描）。
// 每次计算前取一次、整批共用 → 同一张表内上下行/星间各行起点严格一致；轨道仍按 SGP4 从各自历元正推到该时刻（同属墙钟系）。
function searchT0ISO() { return new Date().toISOString() }
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

// 顶栏「刷新」：重新拉取主窗口的最新设置（GRD 卫星树 + 城市库/载波信号选项）。
// 与 GEO refreshLatest 同口径（去掉 GEO 特有的实时星位/只读 EIRP·G·T 扇出）。
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  try {
    reloadSatTree()   // 重读 globe3d/settings.grd（卫星树，作轨道来源）
    try { const c = api && await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    toast('已刷新最新设置')
  } finally { refreshing.value = false }
}

// ============ 编辑模块：载波信号 / 发信站群 / 卫星群 ============
const MODULES = computed(() => {
  const carrier = { key: 'carrier', label: '载波信号', icon: 'wave' }
  const sat = { key: 'sat', label: '卫星群', icon: 'sat' }
  // 顺序随信号流向：上行 地球站→星（发信站在前）；下行 星→地球站、星间 星→星（卫星群在前）
  if (linkMode.value === 'laser') return [sat, { key: 'laser', label: '星间激光链路群', icon: 'laser' }]
  if (linkMode.value === 'isl') return [carrier, sat, { key: 'isl', label: '星间链路群', icon: 'isl' }]
  if (linkMode.value === 'downlink') return [carrier, sat, { key: 'rx', label: '收信站群', icon: 'down' }]
  return [carrier, { key: 'tx', label: '发信站群', icon: 'up' }, sat]
})
const activeModule = ref('tx')
const moduleCount = (k) => (k === 'tx' ? txStations.length : k === 'rx' ? rxStations.length : k === 'isl' ? islLinks.length : k === 'laser' ? laserLinks.length : k === 'sat' ? satConfigs.length : basebandConfigs.length)
watch(activeModule, (m) => { if (m === 'sat') reloadSatTree() })
// 切换体制：站群/链路群模块随之切换（tx↔rx↔isl），保持「站群」标签聚焦；列表指标若不在新体制选项内则回退链路余量
watch(linkMode, (lm) => {
  const stationMod = lm === 'laser' ? 'laser' : lm === 'isl' ? 'isl' : lm === 'downlink' ? 'rx' : 'tx'
  // 若当前编辑模块不在新体制的模块集内（如激光无「载波信号」模块），回落到该体制的站群/链路群模块
  const modKeys = lm === 'laser' ? ['sat', 'laser'] : lm === 'isl' ? ['carrier', 'sat', 'isl'] : lm === 'downlink' ? ['carrier', 'sat', 'rx'] : ['carrier', 'tx', 'sat']
  if (!modKeys.includes(activeModule.value)) activeModule.value = stationMod
  if (!METRIC_OPTIONS.value.some((m) => m.key === metricKey.value)) metricKey.value = 'linkmargin'
  // 上/下行/星间三种口径的链路条数与结果列头都不同，旧体制的结果表不再适用——切换即清空，
  // 避免「上行结果套着下行列头」的串味显示（用户须在新体制下重新点算）。
  links.value = []; selected.value = 0; segments.value = []; error.value = ''
})

// ============ 几何搜索时窗（选星 SGP4 典型时刻 + 全部访问窗口）============
const geoHorizonHours = ref(Number(localStorage.getItem('regen/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('regen/horizonHours', String(v)) } catch (e) { /* ignore */ } })
const HORIZONS = [{ v: 6, l: '6 小时' }, { v: 12, l: '12 小时' }, { v: 24, l: '24 小时' }, { v: 48, l: '2 天' }, { v: 72, l: '3 天' }, { v: 120, l: '5 天' }, { v: 168, l: '7 天' }, { v: 336, l: '14 天' }, { v: 720, l: '30 天' }]

// ============ 计算结果（每个发信站一条上行链路）============
const links = shallowRef([])  // [{ ti, txName, satName, data, geom, access, margin, powerW, ok, error }]
const METRIC_OPTIONS_UP = [
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'paRecommendation', label: '功放功率 (W)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'carrierTotalCN', label: '上行 C/N (dB)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
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
const METRIC_OPTIONS = computed(() => (linkMode.value === 'laser' ? METRIC_OPTIONS_LASER : linkMode.value === 'isl' ? METRIC_OPTIONS_ISL : linkMode.value === 'downlink' ? METRIC_OPTIONS_DN : METRIC_OPTIONS_UP))
const metricKey = ref('linkmargin')
const metricLabel = computed(() => METRIC_OPTIONS.value.find((m) => m.key === metricKey.value)?.label || '')
function parseMetricLabel(label) { const m = /^(.*?)\s*\(([^)]+)\)$/.exec(label || ''); return m ? { title: m[1], unit: m[2] } : { title: label || '', unit: '' } }
function cellMetricList(l) {
  if (!l) return ''
  if (l.error) return '✕'
  if (metricKey.value === 'capacityMbps') { const kbps = capacityKbpsOf(l.data); return isFinite(kbps) ? (kbps / 1000).toFixed(3) : '—' }
  const v = l.data ? l.data[metricKey.value] : undefined
  if (v === undefined || v === null || v === '') return '—'
  const { title, unit } = parseMetricLabel(metricLabel.value)
  return `${title}：${v}${unit ? ' ' + unit : ''}`
}
const selected = ref(0)
const segments = ref([])
const computing = ref(false)
const error = ref('')
const nLinks = computed(() => (linkMode.value === 'laser' ? laserLinks.length : linkMode.value === 'isl' ? islLinks.length : linkMode.value === 'downlink' ? rxStations.length : txStations.length))
// 链路方向标签：上行=站→星，下行=星→站，星间=发射星→接收星（txName=发射星, satName=接收星）
function pairLabel(l) {
  if (!l) return ''
  return linkMode.value === 'downlink' ? `${l.satName} → ${l.txName}` : `${l.txName} → ${l.satName}`
}
// 体制短标签（上行/下行/星间）与逐条量词
const modeLabel = computed(() => (linkMode.value === 'laser' ? '激光星间' : linkMode.value === 'isl' ? '星间' : linkMode.value === 'downlink' ? '下行' : '上行'))

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
  if (w.oneWayDelayMs != null) { d.linkDelayResult = w.oneWayDelayMs.toFixed(3); d.linkDelayUpResult = (w.up.slantKm / _C_KMS * 1000).toFixed(3) }
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

// —— 时标格式化（访问窗口）——
const tzMode = ref('utc')
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function localOffsetLabel() { const off = -new Date().getTimezoneOffset(); const s = off >= 0 ? '+' : '−'; const h = Math.floor(Math.abs(off) / 60); const m = Math.abs(off) % 60; return 'UTC' + s + h + (m ? ':' + String(m).padStart(2, '0') : '') }
const tzSuffix = computed(() => (tzMode.value === 'utc' ? 'UTCG' : localOffsetLabel()))
function fmtInstant(iso, mode) {
  if (!iso) return '—'
  const d = new Date(iso); if (isNaN(d.getTime())) return String(iso)
  const loc = mode === 'local'; const p = (n, w = 2) => String(n).padStart(w, '0')
  const D = loc ? d.getDate() : d.getUTCDate(), MO = loc ? d.getMonth() : d.getUTCMonth(), Y = loc ? d.getFullYear() : d.getUTCFullYear()
  const H = loc ? d.getHours() : d.getUTCHours(), MI = loc ? d.getMinutes() : d.getUTCMinutes(), S = loc ? d.getSeconds() : d.getUTCSeconds()
  return `${D} ${UTCG_MON[MO]} ${Y} ${p(H)}:${p(MI)}:${p(S)}`
}
function fmtDur(min) { if (min == null || !isFinite(min)) return '—'; return min >= 60 ? (min / 60).toFixed(2) + ' h' : min.toFixed(1) + ' min' }

// ============ 容量汇总 ============
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult); const eta = parseFloat(d.spectralEfficiencyResult)
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN
}
const capacitySummary = computed(() => {
  const done = links.value.filter((l) => l && l.data && !l.error)
  let bwKHz = 0, capKbps = 0
  for (const l of done) {
    const bw = parseFloat(l.data.allocBandwidthResult); if (isFinite(bw)) bwKHz += bw
    const kbps = capacityKbpsOf(l.data); if (isFinite(kbps)) capKbps += kbps
  }
  return { count: done.length, failed: links.value.length - done.length, bwKHz, capKbps, avgEff: bwKHz > 0 ? capKbps / bwKHz : 0 }
})
function fmtCapacity(kbps) { const n = Number(kbps); if (!isFinite(n) || n <= 0) return { v: '0', u: 'kbps' }; if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'Gbps' }; if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'Mbps' }; return { v: n.toFixed(n >= 100 ? 1 : 2), u: 'kbps' } }
function fmtBandwidth(khz) { const n = Number(khz); if (!isFinite(n) || n <= 0) return { v: '0', u: 'kHz' }; if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'GHz' }; if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'MHz' }; return { v: n.toFixed(n >= 100 ? 1 : 3), u: 'kHz' } }
const capMain = computed(() => fmtCapacity(capacitySummary.value.capKbps))
const bwMain = computed(() => fmtBandwidth(capacitySummary.value.bwKHz))

const sel = computed(() => links.value[selected.value] || null)
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))
const geom = computed(() => (sel.value ? sel.value.geom : null))
const access = computed(() => (sel.value ? sel.value.access : null))
const islGeo = computed(() => (sel.value ? sel.value.islGeo : null))

// ============ 计算（逐发信站一条上行链路；工作点给定 → 求余量）============
async function compute() {
  if (!api) { error.value = '引擎需在桌面客户端中运行'; return }
  if (linkMode.value === 'laser') return computeLaser()
  if (linkMode.value === 'isl') return computeIsl()
  const isDown = linkMode.value === 'downlink'
  const stations = isDown ? rxStations : txStations
  if (!stations.length) { error.value = isDown ? '请至少添加一个收信站' : '请至少添加一个发信站'; return }
  if (!satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const t0ISO = searchT0ISO()   // 本批上下行统一起点：计算此刻墙钟
    for (let ti = 0; ti < stations.length; ti++) {
      const st = stations[ti]
      const sat = resolveSatellite(st.satelliteId)
      const bbForm = resolveBaseband(st.basebandId).form
      const satName = (sat && (sat.form.satelliteName || sat.name)) || '卫星'
      // 轨道来源：选星→真实星历；未选→手动圆轨道（上/下行共用）
      const ns = sat.ngsoSat
      const selectedStar = ns && ns.mode !== 'manual' && ns.orbit
      const orbitSpec = selectedStar ? JSON.parse(JSON.stringify(ns.orbit))
        : { type: 'circular', altKm: pf(sat.form.orbitAltitude) || 0, inclDeg: pf(sat.form.orbitInclination) || 0 }

      if (isDown) {
        // ===== 再生式下行：星上再生 → 收信站接收；工作点 = 收信站 G/T =====
        const rxName = st.rxEarthStationLocation || ('收' + (ti + 1))
        const { satParams, linkParams } = buildRegenDownlinkParams(sat.form, bbForm, st)
        const freqGHz = parseFloat(sat.form.rxCenterFrequency) || 12.5   // 下行频率（几何多普勒/FSL）
        const stationGeo = { lonDeg: parseFloat(st.rxLongitude), latDeg: parseFloat(st.rxLatitude), altKm: (parseFloat(st.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(st.rxMinElevation) || 0, freqGHz }
        const geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
        if (!(geo && geo.feasible)) {
          out.push({ ti, txName: rxName, satName, data: null, margin: '—', metric: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
        }
        // 下行几何注入（单站：收=发，up/dn 同值）
        linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.dn.slantKm; linkParams.rxMinElevation = geo.worst.dn.elevDeg
        linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.dn.slantKm; linkParams.minElevation = geo.worst.dn.elevDeg
        let acc = null
        try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
        const r = await api.linkBudget.computeRegenDownlink(satParams, linkParams, { mode: 'power' })
        if (r && r.success) {
          const d = r.data
          mergePlatformGeometry(d, geo)
          const m = parseFloat(d.linkmargin)
          out.push({ ti, txName: rxName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, metric: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
        } else {
          out.push({ ti, txName: rxName, satName, data: null, margin: '—', metric: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
        }
        continue
      }

      // ===== 再生式上行：地球站 → 星上再生解调；工作点 = 发射 EIRP/功放 =====
      const txName = st.earthStationLocation || ('发' + (ti + 1))
      const { satParams, linkParams } = buildRegenParams(sat.form, bbForm, st)
      const powerW = stationPowerW(st, sat.form)
      if (!(powerW > 0)) {
        out.push({ ti, txName, satName, data: null, margin: '—', metric: '—', error: '工作点无效（EIRP/功放 需可解析为正功率）', geom: null, access: null }); continue
      }
      const freqGHz = parseFloat(sat.form.centerFrequency) || 14.25
      const stationGeo = { lonDeg: parseFloat(st.longitude), latDeg: parseFloat(st.latitude), altKm: (parseFloat(st.altitude) || 0) / 1000, minElevDeg: parseFloat(st.minElevation) || 0, freqGHz }
      const geo = await api.linkBudget.ngsoGeometry({ orbit: orbitSpec, tx: stationGeo, rx: stationGeo, t0ISO, horizonHours: geoHorizonHours.value })
      if (!(geo && geo.feasible)) {
        out.push({ ti, txName, satName, data: null, margin: '—', metric: '—', error: (geo && geo.reason) || '轨道几何不可行', geom: geo, access: null }); continue
      }
      linkParams.distanceMode = 'slantRange'; linkParams.slantRange = geo.worst.up.slantKm; linkParams.minElevation = geo.worst.up.elevDeg
      linkParams.rxDistanceMode = 'slantRange'; linkParams.rxSlantRange = geo.worst.up.slantKm; linkParams.rxMinElevation = geo.worst.up.elevDeg
      let acc = null
      try { acc = await api.linkBudget.accessWindows({ orbit: orbitSpec, station: stationGeo, t0ISO, horizonHours: geoHorizonHours.value }) } catch (e) { acc = null }
      const r = await api.linkBudget.computeRegenUplink(satParams, linkParams, { mode: 'power', powerW })
      if (r && r.success) {
        const d = r.data
        mergePlatformGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, txName, satName, data: d, geom: geo, access: acc, margin: d.linkmargin, powerW: d.paRecommendation, metric: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, txName, satName, data: null, margin: '—', metric: '—', error: (r && r.message) || '失败', geom: geo, access: acc })
      }
    }
    const prevSel = sel.value
    links.value = out
    // 计算后保持当前查看位置（按原发/收下标对定位；配对数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.ti === prevSel.ti && l.ri === prevSel.ri) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

// 再生式星间：逐条星间链路（发射卫星 → 接收卫星）。几何为核心：两星轨道 → 严格互视最差距离/可见度。
async function computeIsl() {
  if (!islLinks.length) { error.value = '请至少添加一条星间链路'; return }
  if (!satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const t0ISO = searchT0ISO()   // 本批星间统一起点：与上下行同口径，计算此刻墙钟
    for (let ti = 0; ti < islLinks.length; ti++) {
      const link = islLinks[ti]
      const txSat = resolveSatellite(link.txSatelliteId)
      const rxSat = resolveSatellite(link.rxSatelliteId)
      const bbForm = resolveBaseband(link.basebandId).form
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      const orbitA = orbitSpecOf(txSat), orbitB = orbitSpecOf(rxSat)
      const freqGHz = parseFloat(link.islFreq) || 23
      const am = parseFloat(link.islAtmMargin); const atmMarginKm = isNaN(am) ? 100 : am
      // 两星几何（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）
      const geo = await api.linkBudget.islGeometry({ orbitA, orbitB, t0ISO, horizonHours: geoHorizonHours.value, freqGHz, atmMarginKm })
      if (!(geo && geo.feasible)) {
        out.push({ ti, txName, satName: rxName, data: null, margin: '—', metric: '—', error: (geo && geo.reason) || '两星几何不可行/时窗内不互视', geom: null, islGeo: geo, access: null }); continue
      }
      const { satParams, linkParams } = buildRegenIslParams(txSat.form, bbForm, link)
      satParams.islHopDistance = geo.worst.rangeKm     // 几何最差距离注入
      const visPct = (geo.visibility.visibleFrac || 0) * 100
      const r = await api.linkBudget.computeRegenIsl(satParams, linkParams, { visibilityPct: visPct })
      if (r && r.success) {
        const d = r.data
        mergeIslGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, txName, satName: rxName, data: d, geom: null, islGeo: geo, access: null, margin: d.linkmargin, metric: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, txName, satName: rxName, data: null, margin: '—', metric: '—', error: (r && r.message) || '失败', geom: null, islGeo: geo, access: null })
      }
    }
    const prevSel = sel.value
    links.value = out
    // 计算后保持当前查看位置（按原发/收下标对定位；配对数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.ti === prevSel.ti && l.ri === prevSel.ri) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

// 再生式激光星间：逐条激光链路（发射卫星 → 接收卫星）。几何复用两星互视最差距离/可见度；
// 链路预算走第一性原理光学预算（P_rx 链 + 光子/bit 灵敏度）；给定速率 → 链路余量。
async function computeLaser() {
  if (!laserLinks.length) { error.value = '请至少添加一条激光星间链路'; return }
  if (!satConfigs.length) { error.value = '请至少添加一颗卫星'; return }
  computing.value = true; error.value = ''
  try {
    const out = []
    const t0ISO = searchT0ISO()
    for (let ti = 0; ti < laserLinks.length; ti++) {
      const link = laserLinks[ti]
      const txSat = resolveSatellite(link.txSatelliteId)
      const rxSat = resolveSatellite(link.rxSatelliteId)
      const txName = (txSat && (txSat.form.satelliteName || txSat.name)) || '发射星'
      const rxName = (rxSat && (rxSat.form.satelliteName || rxSat.name)) || '接收星'
      const orbitA = orbitSpecOf(txSat), orbitB = orbitSpecOf(rxSat)
      // 光频（GHz）= c/λ：喂几何求解器使 maxDopplerHz 为相干光多普勒
      const lambdaNm = parseFloat(link.wavelengthNm) || 1550
      const optFreqGHz = 2.99792458e8 / lambdaNm    // = c[m/s]/λ[nm] → GHz（c/λ 的 GHz 数值）
      const am = parseFloat(link.islAtmMargin); const atmMarginKm = isNaN(am) ? 100 : am
      // 两星几何（双 SGP4 + 地球临边遮挡 → 最差星间距离 + 互视可见度 + 访问窗口）
      const geo = await api.linkBudget.islGeometry({ orbitA, orbitB, t0ISO, horizonHours: geoHorizonHours.value, freqGHz: optFreqGHz, atmMarginKm })
      if (!(geo && geo.feasible)) {
        out.push({ ti, txName, satName: rxName, data: null, margin: '—', metric: '—', error: (geo && geo.reason) || '两星几何不可行/时窗内不互视', geom: null, islGeo: geo, access: null }); continue
      }
      const laserParams = buildRegenLaserParams(txSat.form, link)
      laserParams.islHopDistance = geo.worst.rangeKm          // 几何最差距离注入
      const visPct = (geo.visibility.visibleFrac || 0) * 100
      const r = await api.linkBudget.computeRegenLaser(laserParams, { visibilityPct: visPct, rangeRateKmS: geo.worst.rangeRateKmS })
      if (r && r.success) {
        const d = r.data
        mergeLaserGeometry(d, geo)
        const m = parseFloat(d.linkmargin)
        out.push({ ti, txName, satName: rxName, data: d, geom: null, islGeo: geo, access: null, margin: d.linkmargin, metric: d.linkmargin, ok: !isNaN(m) && m >= 0, totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult })
      } else {
        out.push({ ti, txName, satName: rxName, data: null, margin: '—', metric: '—', error: (r && r.message) || '失败', geom: null, islGeo: geo, access: null })
      }
    }
    const prevSel = sel.value
    links.value = out
    // 计算后保持当前查看位置（按原发/收下标对定位；配对数变化则夹取原下标），不再跳回第一条
    let keepIdx = prevSel ? out.findIndex((l) => l.ti === prevSel.ti && l.ri === prevSel.ri) : -1
    if (keepIdx < 0) keepIdx = Math.min(selected.value, out.length - 1)
    selected.value = keepIdx < 0 ? 0 : keepIdx
    await loadWaterfall()
  } catch (e) {
    error.value = String(e)
  } finally {
    computing.value = false
  }
}

async function loadWaterfall() {
  const l = sel.value
  if (!l || !l.data) { segments.value = []; return }
  segments.value = await api.linkBudget.waterfall({ results: JSON.parse(JSON.stringify(l.data)), lang: 'zh', orbitType: 'REGEN', txLocation: String(l.txName || '') })
}
function selectLink(idx) { if (idx >= 0 && idx < links.value.length) { selected.value = idx; loadWaterfall() } }

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

// ============ 状态序列化 / 持久化 / 命名配置 ============
const STATE_KEY = 'regen/last'
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

function serializeState() {
  return {
    orbitType: 'REGEN',
    linkMode: linkMode.value,
    hiddenModes: [...hiddenModes.value],
    satConfigs: satConfigs.map((c) => ({ id: c.id, name: c.name, form: { ...c.form }, ngsoSat: { mode: c.ngsoSat.mode, orbit: c.ngsoSat.orbit ? JSON.parse(JSON.stringify(c.ngsoSat.orbit)) : null, name: c.ngsoSat.name, noradId: c.ngsoSat.noradId, folder: c.ngsoSat.folder || '' } })),
    basebandConfigs: basebandConfigs.map((c) => ({ id: c.id, name: c.name, form: { ...c.form } })),
    tx: txStations.map(({ _id, ...r }) => r),
    rx: rxStations.map(({ _id, ...r }) => r),
    isl: islLinks.map(({ _id, ...r }) => r),
    laser: laserLinks.map(({ _id, ...r }) => r),
    opMode: opMode.value, geoHorizonHours: geoHorizonHours.value,
    metricKey: metricKey.value, activeModule: activeModule.value
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  // 隐藏模式：过滤掉未知 key；旧配置无该字段 → 全部显示
  hiddenModes.value = Array.isArray(st.hiddenModes) ? st.hiddenModes.filter((k) => LINK_MODES.some((m) => m.key === k)) : []
  if (st.linkMode) linkMode.value = st.linkMode
  if (hiddenModes.value.includes(linkMode.value)) { const first = visibleModes.value[0]; if (first) linkMode.value = first.key }  // 兜底：活动模式恰被隐藏
  if (Array.isArray(st.satConfigs) && st.satConfigs.length) {
    satConfigs.splice(0, satConfigs.length, ...st.satConfigs.map((c) => ({
      id: c.id || ('sat' + (_satSeq++)), name: c.name || '卫星',
      form: { ...defaultsFor(SAT_FIELDS), ...c.form },
      // folder：tree 选星回显用；兼容旧配置（曾把 tree folder 存于 gtAnt.folder）
      ngsoSat: c.ngsoSat ? { mode: c.ngsoSat.mode || 'manual', orbit: c.ngsoSat.orbit || null, name: c.ngsoSat.name || '', noradId: c.ngsoSat.noradId || null, folder: c.ngsoSat.folder || (c.gtAnt && c.gtAnt.folder) || '' } : { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' }
    })))
  }
  if (Array.isArray(st.basebandConfigs) && st.basebandConfigs.length) {
    basebandConfigs.splice(0, basebandConfigs.length, ...st.basebandConfigs.map((c) => ({
      id: c.id || ('bb' + (_bbSeq++)), name: c.name || '配置',
      form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, ...c.form }
    })))
  }
  // 合并 TX 默认：旧配置（G/T 尚在卫星侧时保存）的发信站行缺 G_Ts，按默认补齐，避免下沉后该列为空
  if (Array.isArray(st.tx) && st.tx.length) txStations.splice(0, txStations.length, ...st.tx.map((r) => ({ ...defaultsFor(TX_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 收信站群：旧配置（仅上行）无 rx 字段 → 保留默认一站，避免下行模式空表
  if (Array.isArray(st.rx) && st.rx.length) rxStations.splice(0, rxStations.length, ...st.rx.map((r) => ({ ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 星间链路群：旧配置无 isl 字段 → 保留默认一条
  if (Array.isArray(st.isl) && st.isl.length) islLinks.splice(0, islLinks.length, ...st.isl.map((r) => ({ ...defaultsFor(ISL_FIELDS), ...r, _id: 's' + (_sid++) })))
  // 激光星间链路群：旧配置无 laser 字段 → 保留默认一条；只保留当前字段键（清除旧速率/调制/BER 等已删字段的惰性残留）
  if (Array.isArray(st.laser) && st.laser.length) {
    const lkeys = LASER_FIELDS.map((f) => f.key)
    laserLinks.splice(0, laserLinks.length, ...st.laser.map((r) => {
      const o = { ...defaultsFor(LASER_FIELDS), _id: 's' + (_sid++) }
      for (const k of lkeys) if (r[k] !== undefined) o[k] = r[k]
      return o
    }))
  }
  if (st.opMode) opMode.value = st.opMode
  if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
  if (st.metricKey) metricKey.value = st.metricKey
  if (st.activeModule) activeModule.value = st.activeModule
}
let _stateT = null
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* ignore */ } }, 600) }
watch([satConfigs, basebandConfigs, txStations, rxStations, islLinks, laserLinks, opMode, geoHorizonHours, metricKey, activeModule, linkMode, hiddenModes, activeId], scheduleSaveState, { deep: true })

async function loadConfigs() {
  try {
    const all = (api && await api.store.listConfigs()) || []
    configs.value = all.filter((it) => it && ((it.type === 'folder') ? (it.orbitType === 'REGEN') : (it.state && it.state.orbitType === 'REGEN')))
  } catch (e) { configs.value = [] }
  pruneExpanded()
}
function pruneExpanded() {
  const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
  let changed = false
  for (const id of [...expandedFolders.value]) if (!ids.has(id)) { expandedFolders.value.delete(id); changed = true }
  if (changed) persistExpanded()
}
function defaultCfgName() { const s = satConfigs[0] && satConfigs[0].form.satelliteName; const kind = linkMode.value === 'laser' ? '再生激光星间' : linkMode.value === 'isl' ? '再生星间' : linkMode.value === 'downlink' ? '再生下行' : '再生上行'; const unit = (linkMode.value === 'isl' || linkMode.value === 'laser') ? '条' : '站'; return (s ? s + ' ' : '') + `${kind} ${nLinks.value} ${unit}` }
const cfgDlg = reactive({ open: false, name: '' })
function openSaveDlg() { if (!api) { toast('保存需在桌面客户端中运行'); return } cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
async function confirmCfgDlg() {
  const name = (cfgDlg.name || '').trim()
  if (!name) { toast('请输入配置名称'); return }
  const item = await api.store.saveConfig({ name, state: serializeState() })
  cfgDlg.open = false; await loadConfigs(); if (item && item.id) { activeId.value = item.id; setBaseline() }
  toast('已保存配置：' + name)
}
const editing = reactive({ id: null, name: '' })
function startRename(c) { editing.id = c.id; editing.name = c.name; nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } }) }
function cancelRename() { editing.id = null }
async function commitRename() {
  const id = editing.id; if (id == null) return
  const c = configs.value.find((x) => x.id === id); const nm = (editing.name || '').trim(); editing.id = null
  if (c && nm && nm !== c.name) { await api.store.saveConfig({ id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
}
async function updateConfig() {
  if (!api || !activeId.value) return
  const c = configs.value.find((x) => x.id === activeId.value); if (!c) return
  await api.store.saveConfig({ id: c.id, name: c.name, state: serializeState() })
  setBaseline(); await loadConfigs(); toast('已保存修改到：' + c.name)
}
async function saveCurrent() { if (!api) { toast('保存需在桌面客户端中运行'); return } if (activeId.value) await updateConfig(); else openSaveDlg() }
function applyConfig(c) { if (!c) return; activeId.value = c.id; applyState(c.state); setBaseline() }
async function selectConfig(c) { if (!c || c.id === activeId.value) return; if (!(await guardedLeave())) return; applyConfig(c) }
async function removeConfig(id, e) {
  if (e) e.stopPropagation(); if (!api) return
  await api.store.deleteConfig(id)
  if (activeId.value === id) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && cfgClip.value.id === id) cfgClip.value = null
  await loadConfigs()
}
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
async function addFolder(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  const item = await api.store.saveConfig({ type: 'folder', name: uniqueCfgName('新建文件夹'), parentId: parentId || null, orbitType: 'REGEN' })
  if (parentId) expandedFolders.value.add(parentId)
  if (item && item.id) expandedFolders.value.add(item.id)
  persistExpanded(); await loadConfigs(); if (item && item.id) startRename(item)
}
async function onMove(payload) {
  if (!api || !payload || !payload.dragId) return
  await api.store.moveItem({ id: payload.dragId, parentId: payload.parentId, anchorId: payload.anchorId, position: payload.position })
  if (payload.position === 'inside' && payload.parentId) { expandedFolders.value.add(payload.parentId); persistExpanded() }
  await loadConfigs()
}
async function removeFolder(folder) {
  if (!api || !folder) return
  const hasChildren = configs.value.some((c) => c.parentId === folder.id)
  if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
  const removed = (await api.store.deleteFolder(folder.id)) || [folder.id]
  const rset = new Set(removed)
  if (activeId.value && rset.has(activeId.value)) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && rset.has(cfgClip.value.id)) cfgClip.value = null
  for (const id of removed) expandedFolders.value.delete(id)
  persistExpanded(); await loadConfigs(); toast('已删除文件夹：' + folder.name)
}
function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }
function blankState() {
  return {
    orbitType: 'REGEN', linkMode: 'uplink', hiddenModes: [],
    satConfigs: [{ name: '卫星1', form: { ...defaultsFor(SAT_FIELDS) }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null, folder: '' } }],
    basebandConfigs: [{ name: '默认', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1 } }],
    tx: [defaultsFor(TX_FIELDS)],
    rx: [defaultsFor(RX_FIELDS)],
    isl: [defaultsFor(ISL_FIELDS)],
    laser: [defaultsFor(LASER_FIELDS)],
    opMode: 'eirp', geoHorizonHours: 24, metricKey: 'linkmargin', activeModule: 'tx'
  }
}
function uniqueCfgName(base) { const names = new Set(configs.value.map((c) => c.name)); if (!names.has(base)) return base; let i = 2; while (names.has(base + ' ' + i)) i++; return base + ' ' + i }
async function addBlankConfig(parentId = null) {
  if (!api) { toast('需在桌面客户端中运行'); return }
  if (!(await guardedLeave())) return
  const state = blankState()
  const item = await api.store.saveConfig({ name: uniqueCfgName('新配置'), state, parentId: parentId || null })
  if (parentId) { expandedFolders.value.add(parentId); persistExpanded() }
  await loadConfigs(); if (item && item.id) { activeId.value = item.id; applyState(state); setBaseline() }
  toast('已添加空白配置')
}
const cfgClip = shallowRef(null)
function copyConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'copy', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已复制：' + c.name) }
function cutConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'cut', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已剪切：' + c.name + '（粘贴以换位置）') }
async function pasteConfig(targetId, into = false) {
  const clip = cfgClip.value; if (!clip || !api) return
  let movingId
  if (clip.mode === 'copy') { const item = await api.store.saveConfig({ name: uniqueCfgName(clip.name + ' 副本'), state: JSON.parse(JSON.stringify(clip.state)) }); movingId = item && item.id }
  else movingId = clip.id
  if (movingId) {
    const target = (targetId && targetId !== movingId) ? configs.value.find((c) => c.id === targetId) : null
    if (into && target && target.type === 'folder') await api.store.moveItem({ id: movingId, parentId: target.id, anchorId: null, position: 'inside' })
    else if (target) await api.store.moveItem({ id: movingId, parentId: null, anchorId: target.id, position: 'after' })
    else await api.store.moveItem({ id: movingId, parentId: null, anchorId: null, position: 'inside' })
    if (into && target && target.type === 'folder') { expandedFolders.value.add(target.id); persistExpanded() }
  }
  if (clip.mode === 'cut') cfgClip.value = null
  await loadConfigs(); toast('已粘贴')
}
function onCfgKey(e) {
  if (!(e.ctrlKey || e.metaKey)) return
  if (editing.id != null) return
  const t = e.target && e.target.tagName
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return
  const c = activeId.value && configs.value.find((x) => x.id === activeId.value)
  const k = e.key.toLowerCase()
  if (k === 'c') { if (c) { copyConfig(c); e.preventDefault() } }
  else if (k === 'x') { if (c) { cutConfig(c); e.preventDefault() } }
  else if (k === 'v') { if (cfgClip.value) { pasteConfig(activeId.value || null); e.preventDefault() } }
}
const ctxMenu = reactive({ open: false, x: 0, y: 0, configId: null })
const ctxConfig = computed(() => (ctxMenu.configId ? configs.value.find((c) => c.id === ctxMenu.configId) : null))
const ctxIsFolder = computed(() => !!(ctxConfig.value && ctxConfig.value.type === 'folder'))
function openCtx(e, c) { e.preventDefault(); ctxMenu.configId = c ? c.id : null; ctxMenu.x = Math.min(e.clientX, window.innerWidth - 170); ctxMenu.y = Math.min(e.clientY, window.innerHeight - 230); ctxMenu.open = true }
function ctxDo(fn) { ctxMenu.open = false; fn() }
async function importConfigs(items) {
  if (!api) { toast('导入需在桌面客户端中运行'); return 0 }
  let last = null
  for (const it of items) {
    const state = JSON.parse(JSON.stringify(it.state))
    const r = await api.store.saveConfig({ name: it.name || '导入配置', state })
    if (r) last = { item: r, state }
  }
  await loadConfigs()
  if (last) { if (last.item.id) activeId.value = last.item.id; applyState(last.state); setBaseline() }
  toast(items.length > 1 ? `已导入 ${items.length} 个配置` : ('已导入配置：' + (items[0] && items[0].name || '')))
  return items.length
}
function fingerprintOf(s) {
  return stableStringify({ satConfigs: s.satConfigs, basebandConfigs: s.basebandConfigs, tx: s.tx, rx: s.rx, isl: s.isl, laser: s.laser, opMode: s.opMode, geoHorizonHours: s.geoHorizonHours, linkMode: s.linkMode, hiddenModes: s.hiddenModes })
}
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
function setBaseline() { activeBaseline = fingerprint() }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
function activeName() { const c = configs.value.find((x) => x.id === activeId.value); return c ? c.name : '' }
const leaveDlg = reactive({ open: false, name: '' })
let _leaveResolve = null
function askLeave(name) { return new Promise((res) => { leaveDlg.name = name; leaveDlg.open = true; _leaveResolve = res }) }
function leaveAnswer(ans) { leaveDlg.open = false; const r = _leaveResolve; _leaveResolve = null; if (r) r(ans) }
async function guardedLeave() {
  if (!isDirty()) return true
  const ans = await askLeave(activeName())
  if (ans === 'cancel') return false
  if (ans === 'save') await updateConfig()
  return true
}
const deviceId = ref('')
const shareConfigured = ref(false)
const shareDlg = reactive({ open: false, tab: 'offline', code: '', recip: '', sending: false, loadingInbox: false, inbox: [], inboxMsg: '' })
function shareItems() { const c = activeId.value && configs.value.find((x) => x.id === activeId.value); return [c ? { name: c.name, state: c.state } : { name: defaultCfgName(), state: serializeState() }] }
function shareLabel(items) { const n = (items || shareItems()).length; return n > 1 ? `${n} 个配置` : ((items || shareItems())[0].name) }
function openShareDlg() { const items = shareItems(); shareDlg.code = encodeShare(items); shareDlg.recip = ''; shareDlg.open = true }
async function copyShareCode() { try { await navigator.clipboard.writeText(shareDlg.code); toast('分享码已复制，可发给对方') } catch (e) { toast('复制失败，请手动选择文本复制') } }
async function exportConfigFile() {
  if (!api) return
  const items = shareItems()
  const r = await api.exportFile({ defaultName: (shareLabel(items) || '配置').replace(/[\\/:*?"<>|]/g, '_') + '.lbcfg', data: configFileText(items), filters: [{ name: '链路预算配置', extensions: ['lbcfg', 'json'] }] })
  if (r && r.ok) toast('已导出配置文件：' + r.filePath)
  else if (r && !r.canceled) toast('导出失败：' + (r.error || ''))
}
const importText = ref('')
async function importFromCode() { try { const items = decodeShare(importText.value); await importConfigs(items); shareDlg.open = false; importText.value = '' } catch (e) { toast('解析失败：' + (e.message || e)) } }
async function importFromClipboard() { try { importText.value = await navigator.clipboard.readText() } catch (e) { /* manual */ } if (importText.value) importFromCode() }
async function importConfigFile() {
  if (!api) return
  const r = await api.linkBudget.openConfig()
  if (!r || r.canceled) return
  if (!r.ok) { toast('读取失败：' + (r.error || '')); return }
  try { const items = decodeShare(r.text); await importConfigs(items); shareDlg.open = false } catch (e) { toast('解析失败：' + (e.message || e)) }
}
async function sendOnline() {
  if (!api || !shareConfigured.value) { toast('在线分享未配置'); return }
  const rid = (shareDlg.recip || '').trim(); if (!rid) { toast('请输入对方用户ID'); return }
  const items = shareItems(); const label = shareLabel(items)
  const payload = JSON.parse(JSON.stringify({ from: deviceId.value, name: label, items }))
  shareDlg.sending = true
  try { const r = await api.share.send(rid, payload); if (r && r.ok) toast(`已发送「${label}」给 ${rid}`); else toast('发送失败：' + ((r && r.error) || '未知错误')) }
  catch (e) { toast('发送失败：' + (e.message || e)) } finally { shareDlg.sending = false }
}
async function loadInbox() {
  if (!api || !shareConfigured.value) return
  shareDlg.loadingInbox = true; shareDlg.inboxMsg = ''
  try { const r = await api.share.inbox(deviceId.value); if (r && r.ok) { shareDlg.inbox = r.items || []; if (!shareDlg.inbox.length) shareDlg.inboxMsg = '收件箱为空' } else shareDlg.inboxMsg = '获取失败：' + ((r && r.error) || '') }
  catch (e) { shareDlg.inboxMsg = '获取失败：' + (e.message || e) } finally { shareDlg.loadingInbox = false }
}
async function acceptInbox(item) {
  const items = (item.items && item.items.length) ? item.items : (item.state ? [{ name: item.name, state: item.state }] : [])
  if (items.length) await importConfigs(items)
  try { await api.share.remove(deviceId.value, item.id) } catch (e) { /* ignore */ }
  shareDlg.inbox = shareDlg.inbox.filter((x) => x.id !== item.id)
}
async function dismissInbox(item) { try { await api.share.remove(deviceId.value, item.id) } catch (e) { /* ignore */ } shareDlg.inbox = shareDlg.inbox.filter((x) => x.id !== item.id) }
watch(() => shareDlg.tab, (t) => { if (t === 'online' && shareConfigured.value) loadInbox() })

// ============ 结果 Excel 导出 ============
const exporting = ref(false)
const exportLang = ref(localStorage.getItem('regen/exportLang') || 'zh')
watch(exportLang, (v) => { try { localStorage.setItem('regen/exportLang', v) } catch (e) { /* ignore */ } })
async function exportExcel() {
  if (!api) { error.value = '导出需在桌面客户端中运行'; return }
  if (!links.value.length) { toast('请先点「计算」生成结果'); return }
  exporting.value = true
  try {
    const en = exportLang.value === 'en'
    const mode = linkMode.value
    const isDown = mode === 'downlink', isIsl = mode === 'isl', isLaser = mode === 'laser'
    const isSpace = isIsl || isLaser   // 空间-空间体制（星间微波/激光）：几何走两星 islGeo，无地球站
    const satName = (satConfigs[0] && satConfigs[0].form.satelliteName) || (en ? 'Results' : '结果')
    const nmeta = isLaser
      ? { title: en ? 'Regenerative Laser Inter-Satellite Link Budget' : '再生式激光星间链路预算结果', mode: en ? 'Given rate + optical power budget' : '给定速率 + 光学功率预算', pairMode: en ? 'Per-link laser ISL' : '逐条激光星间' }
      : isIsl
        ? { title: en ? 'Regenerative Inter-Satellite Link Budget' : '再生式星间链路预算结果', mode: en ? 'Given EIRP/GT + rigorous geometry' : '给定 EIRP/G-T + 严格几何', pairMode: en ? 'Per-link ISL' : '逐条星间' }
        : isDown
          ? { title: en ? 'Regenerative Downlink Link Budget' : '再生式下行链路预算结果', mode: en ? 'Given G/T operating point' : '给定工作点 G/T', pairMode: en ? 'Per-station downlink' : '逐站下行' }
          : { title: en ? 'Regenerative Uplink Link Budget' : '再生式上行链路预算结果', mode: en ? 'Given operating point' : '给定工作点', pairMode: en ? 'Per-station uplink' : '逐站上行' }
    const enName = isLaser ? 'Regen_Laser_ISL' : isIsl ? 'Regen_ISL' : isDown ? 'Regen_Downlink' : 'Regen_Uplink'
    const zhName = isLaser ? '再生式激光星间链路预算' : isIsl ? '再生式星间链路预算' : isDown ? '再生式下行链路预算' : '再生式上行链路预算'
    const clone = (o) => (o ? JSON.parse(JSON.stringify(o)) : null)
    // 站址透传（上行取发信站、下行取收信站）→「几何关系」sheet 按 STK 口径标注地球站坐标/最低仰角
    const staGeoOf = (l) => {
      if (isSpace) return null
      if (isDown) { const st = rxStations[l.ti] || {}; return { name: l.txName, lat: parseFloat(st.rxLatitude), lon: parseFloat(st.rxLongitude), altM: parseFloat(st.rxAltitude) || 0, minEl: parseFloat(st.rxMinElevation) || 0 } }
      const st = txStations[l.ti] || {}; return { name: l.txName, lat: parseFloat(st.latitude), lon: parseFloat(st.longitude), altM: parseFloat(st.altitude) || 0, minEl: parseFloat(st.minElevation) || 0 }
    }
    const payload = {
      orbitType: 'REGEN', regenMode: mode,
      defaultName: en ? `${enName}_${satName.replace(/[^\w-]+/g, '_')}.xlsx` : `${zhName}_${satName.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`,
      lang: exportLang.value, pairMode: 'sequential',
      params: { satelliteName: satName, frequencyBand: (satConfigs[0] && satConfigs[0].form.frequencyBand) || '' },
      meta: nmeta,
      // 上行：发信站→卫星；下行：卫星→收信站；星间：发射星→接收星（l.txName=地球站/发射星, l.satName=卫星/接收星）
      // 几何上下文分两族：地面-空间(上/下行)传 geom+access+staGeo+satName；空间-空间(星间/激光)传 islGeo
      links: links.value.map((l) => ({
        ti: l.ti, ri: 0,
        txName: isDown ? l.satName : l.txName, rxName: isDown ? l.txName : l.satName,
        ok: !!l.ok, error: l.error || '',
        data: clone(l.data),
        geom: clone(l.geom),          // 站星几何（上行/下行）
        islGeo: clone(l.islGeo),      // 两星几何（星间微波/激光）
        access: clone(l.access),      // 单站访问窗口（上行/下行）
        staGeo: staGeoOf(l),          // 地球站坐标（上行/下行）
        satName: l.satName            // 卫星名（几何 sheet 轨道根数/多普勒表标注）
      }))
    }
    const r = await api.linkBudget.exportExcel(payload)
    if (r && r.ok) toast('已导出：' + r.filePath)
    else if (r && !r.canceled) error.value = '导出失败：' + (r.error || '未知错误')
  } catch (e) { error.value = '导出失败：' + String(e) } finally { exporting.value = false }
}

// ============ 城市库 + 启动恢复 + 关窗守卫 ============
const cities = ref([])
onMounted(async () => {
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  await loadConfigs()
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      // 基线取「规整后的已存配置」：先 applyState(c.state) 走一遍与实时相同的规整管线再 setBaseline，
      // 而非直接指纹原始 c.state——否则旧版本配置一打开就因补默认/裁字段被误判「已改」。
      // 随后 applyState(st) 恢复上次会话（可能含未保存编辑）：若 st 与已存配置一致则判定干净、不误报；
      // 若确有未保存改动，实时指纹与基线不同，仍会正确提示保存。
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
    }
  } catch (e) { /* ignore */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  api?.regen?.onCloseRequested?.(async () => { if (await guardedLeave()) api.regen.confirmClose() })
})
</script>

<template>
  <div class="lb-shell">
    <header class="lb-topbar">
      <span class="lb-brand">再生式链路预算</span>
      <span class="lb-sub">工作台</span>
      <button class="lb-refresh" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（GRD 卫星树 / 天线设置 / 城市库 / 载波信号选项 等）" @click="refreshLatest">
        <svg viewBox="0 0 16 16" class="lb-refresh-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
      </button>
      <span class="lb-spacer"></span>
      <span class="lb-note" v-if="notice">{{ notice }}</span>
      <span class="lb-hint" v-if="!api"><Icon name="alert-triangle" :size="12" /> 引擎需在桌面客户端中运行</span>
    </header>

    <div class="lb-body">
      <!-- ① 配置列表 -->
      <aside class="lb-col lb-configs" :class="{ collapsed: configsCollapsed, resizing: configsResizing }" :style="configsCollapsed ? null : { width: configsWidth + 'px' }">
        <button v-if="configsCollapsed" class="lb-cfg-expand" title="展开配置列表" @click="configsCollapsed = false">
          <span class="lb-cfg-chev"><Icon name="chevron-right" :size="14" /></span><span class="lb-cfg-expand-t">配置列表</span>
        </button>
        <template v-else>
        <div class="lb-col-hd">
          <span class="lb-cfg-hd-t">配置列表</span>
          <span class="lb-cfg-acts">
            <button class="lb-mini" title="分享 / 导入配置" :disabled="!api" @click="openShareDlg">分享</button>
            <button class="lb-mini lb-mini-ico" :title="activeId ? '保存修改到当前配置' : '保存为新配置'" :disabled="!api" @click="saveCurrent">
              <svg viewBox="0 0 16 16" class="lb-ico-svg"><path d="M2.5 2.5h8l3 3v8h-11z" /><path d="M5 2.5v4h5v-4" /><rect x="5" y="9" width="6" height="4.5" /></svg>
            </button>
            <button class="lb-mini lb-mini-ico" title="新建文件夹" :disabled="!api" @click="addFolder(null)"><Icon name="folder-plus" :size="13" /></button>
            <button class="lb-mini lb-mini-ico" title="添加空白配置" :disabled="!api" @click="addBlankConfig(null)"><Icon name="plus" :size="13" /></button>
          </span>
        </div>
        <div class="lb-col-bd" tabindex="0" @keydown="onCfgKey" @contextmenu="openCtx($event, null)">
          <ConfigTree
            :items="configs" :active-id="activeId" :editing-id="editing.id" :editing-name="editing.name"
            :expanded="expandedFolders"
            :cut-id="cfgClip && cfgClip.mode === 'cut' ? cfgClip.id : null"
            @select="selectConfig" @toggle="toggleFolder" @delete="onDeleteItem" @move="onMove"
            @add-folder="addFolder" @add-config="addBlankConfig" @context="openCtx"
            @rename-start="startRename" @rename-input="editing.name = $event" @rename-commit="commitRename" @rename-cancel="cancelRename"
          />
        </div>
        <div v-if="deviceId" class="lb-myid" :title="'本机用户 ID（用于在线分享）'">我的ID：<b>{{ deviceId }}</b></div>
        </template>
        <div v-if="!configsCollapsed" class="lb-cfg-resizer" title="拖动调整配置栏宽度" @mousedown.prevent="startResizeConfigs"></div>
      </aside>

      <!-- ② 体制选择 + 链路模块 + 参数 -->
      <section class="lb-col lb-build">
        <div class="rlmode">
          <div v-for="m in visibleModes" :key="m.key" class="rlmode-i" :class="{ on: linkMode === m.key, disabled: !m.ready }" :title="m.tip"
               @click="m.ready ? (linkMode = m.key) : null">
            <span class="rlmode-lbl">{{ m.label }}</span><span v-if="!m.ready" class="rlmode-todo">开发中</span>
            <span v-if="visibleModes.length > 1" class="rlmode-x" title="关闭该模式（可从「+」恢复）" @click.stop="requestHideMode(m)">
              <svg viewBox="0 0 12 12" width="10" height="10"><path d="M3 3l6 6M9 3l-6 6" /></svg>
            </span>
          </div>
          <div v-if="hiddenModeList.length" class="rlmode-add-wrap">
            <button class="rlmode-add" :class="{ on: addMenuOpen }" title="恢复已关闭的再生式模式" @click.stop="addMenuOpen = !addMenuOpen">
              <svg viewBox="0 0 12 12" width="11" height="11"><path d="M6 2v8M2 6h8" /></svg>
            </button>
            <template v-if="addMenuOpen">
              <div class="rlmode-menu-mask" @click="addMenuOpen = false"></div>
              <div class="rlmode-menu" @click.stop>
                <div class="rlmode-menu-hd">恢复模式</div>
                <button v-for="m in hiddenModeList" :key="m.key" class="rlmode-menu-i" @click="restoreMode(m)">{{ m.label }}</button>
              </div>
            </template>
          </div>
        </div>

        <template v-if="linkMode === 'uplink' || linkMode === 'downlink' || linkMode === 'isl' || linkMode === 'laser'">
          <div class="mods">
            <template v-for="(m, i) in MODULES" :key="m.key">
              <button class="mod" :class="{ on: activeModule === m.key }" @click="activeModule = m.key">
                <span class="mod-ico">
                  <svg v-if="m.icon === 'sat'" viewBox="0 0 120 120" class="mic-sat">
                    <g transform="rotate(-20 60 60)">
                      <rect x="8" y="41" width="10" height="16" rx="3" /><rect x="21" y="41" width="10" height="16" rx="3" /><rect x="34" y="41" width="10" height="16" rx="3" />
                      <rect x="8" y="63" width="10" height="16" rx="3" /><rect x="21" y="63" width="10" height="16" rx="3" /><rect x="34" y="63" width="10" height="16" rx="3" />
                      <rect x="76" y="41" width="10" height="16" rx="3" /><rect x="89" y="41" width="10" height="16" rx="3" /><rect x="102" y="41" width="10" height="16" rx="3" />
                      <rect x="76" y="63" width="10" height="16" rx="3" /><rect x="89" y="63" width="10" height="16" rx="3" /><rect x="102" y="63" width="10" height="16" rx="3" />
                      <rect x="49" y="35" width="22" height="50" rx="10" />
                    </g>
                  </svg>
                  <svg v-else viewBox="0 0 20 20" class="mic">
                    <template v-if="m.icon === 'up'"><line x1="10" y1="17" x2="10" y2="4" /><path d="M5.5,8.5 L10,4 L14.5,8.5" /></template>
                    <template v-else-if="m.icon === 'down'"><line x1="10" y1="3" x2="10" y2="16" /><path d="M5.5,11.5 L10,16 L14.5,11.5" /></template>
                    <template v-else-if="m.icon === 'isl'"><circle cx="5" cy="6" r="2.3" /><circle cx="15" cy="14" r="2.3" /><line x1="6.9" y1="7.5" x2="13.1" y2="12.5" /></template>
                    <template v-else-if="m.icon === 'laser'"><circle cx="4" cy="6" r="2.1" /><circle cx="16" cy="14" r="2.1" /><line x1="5.7" y1="7.4" x2="14.3" y2="12.6" stroke-dasharray="1.4 1.4" /><line x1="5.7" y1="6.2" x2="14.3" y2="11.4" opacity="0.45" /><line x1="5.7" y1="8.6" x2="14.3" y2="13.8" opacity="0.45" /></template>
                    <template v-else><path d="M2,10 Q5,2 8,10 T14,10 T20,10" /></template>
                  </svg>
                </span>
                <span class="mod-t">{{ m.label }}</span>
                <span class="mod-n">{{ moduleCount(m.key) }}</span>
              </button>
              <span v-if="i < MODULES.length - 1" class="mod-wire"><Icon name="chevron-right" :size="12" /></span>
            </template>
          </div>

          <div class="lb-edit">
            <div v-if="activeModule === 'tx'" class="tx-wrap">
              <div class="tx-optbar">
                <span class="tx-optl">工作点</span>
                <div class="seg">
                  <button class="seg-i" :class="{ on: opMode === 'eirp' }" title="按工作点 EIRP(dBW) 输入" @click="setOpMode('eirp')">EIRP (dBW)</button>
                  <button class="seg-i" :class="{ on: opMode === 'power' }" title="按功放功率(W) 输入（与 EIRP 自动换算）" @click="setOpMode('power')">功放 (W)</button>
                </div>
                <span class="tx-opttip">给定每站工作点 → 计算上行余量；切换即按各站天线/馈线/回退换算，保持物理工作点不变。</span>
              </div>
              <StationGrid :stations="txStations" :fields="txFieldsView" :cities="cities" :city-search="citySearch" label="发信站" :auto-geo="autoGeoTx" :select-options="{ basebandId: basebandSelectOptions, satelliteId: satSelectOptions }" />
            </div>
            <div v-else-if="activeModule === 'rx'" class="tx-wrap">
              <div class="tx-optbar">
                <span class="tx-optl">工作点 G/T</span>
                <span class="tx-opttip">收信站 G/T 由天线口径/效率 + 天线噪温 + 接收机噪温 + 馈线损耗按引擎口径算得（含精确雨致 G/T 劣化）；末列「G/T」为随参数实时更新的晴空 G/T 只读预览。</span>
              </div>
              <StationGrid :stations="rxStations" :fields="RX_FIELDS" :cities="cities" :city-search="citySearch" label="收信站" :auto-geo="autoGeoRx" ro-label="G/T" ro-unit="dB/K" :ro-values="rxGtValues" :select-options="{ basebandId: basebandSelectOptions, satelliteId: satSelectOptions }" />
            </div>
            <div v-else-if="activeModule === 'isl'" class="tx-wrap">
              <p class="isl-tip">星间链路：<b>发射卫星 → 接收卫星</b>（两星均选自「卫星群」）。几何由两星轨道严格求解（双 SGP4 传播 + 地球临边遮挡）取最差星间距离与互视可见度；发射 EIRP 在发射卫星、接收 G/T 在接收卫星。<b>选真实卫星</b>几何才严谨；两颗同参数手动圆轨道相位缺省相同会重合报错。</p>
              <StationGrid :stations="islLinks" :fields="ISL_FIELDS" :cities="cities" :city-search="citySearch" label="星间链路" :show-import="false" :select-options="{ basebandId: basebandSelectOptions, txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" />
            </div>
            <div v-else-if="activeModule === 'laser'" class="tx-wrap">
              <StationGrid :stations="laserLinks" :fields="LASER_FIELDS" :cities="cities" :city-search="citySearch" label="激光星间链路" :show-import="false" :select-options="{ txSatelliteId: satSelectOptions, rxSatelliteId: satSelectOptions }" />
            </div>
            <div v-else-if="activeModule === 'carrier'" class="bb-wrap">
              <div class="bb-toolbar">
                <span class="bb-count">{{ basebandConfigs.length }} 份载波信号配置</span>
                <span class="lb-spacer"></span>
                <button class="lb-mini" title="新增配置" @click="addBasebandConfig"><Icon name="plus" :size="12" /> 新增配置</button>
              </div>
              <p class="bb-tip">载波由发信站调制器产生，与发信站绑定：「发信站群」表的「载波信号配置」列为每个发信站单独选择使用哪一份，同一份可被多个发信站共用。</p>
              <div class="bb-cards">
                <div v-for="cfg in basebandConfigs" :key="cfg.id" class="bb-card">
                  <div class="bb-card-hd">
                    <input v-model="cfg.name" class="bb-card-name" placeholder="配置名称" />
                    <span class="lb-spacer"></span>
                    <button class="lb-mini" title="复制此配置" @click="duplicateBasebandConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                    <button class="lb-mini" title="删除此配置" :disabled="basebandConfigs.length <= 1" @click="removeBasebandConfig(cfg)">删除</button>
                  </div>
                  <div class="bb-card-bd"><BasebandPanel :form="cfg.form" :options="basebandOpts" /></div>
                </div>
              </div>
            </div>
            <div v-else class="bb-wrap">
              <div class="bb-toolbar">
                <span class="bb-count">{{ satConfigs.length }} 颗卫星</span>
                <span class="lb-spacer"></span>
                <button class="lb-mini" title="新增卫星" @click="addSatConfig"><Icon name="plus" :size="12" /> 新增卫星</button>
              </div>
              <p class="bb-tip">卫星群：每颗卫星一份配置，支持「搜索卫星 / 天线树导入」选星定轨道。「发信站群」表的「卫星」列为每站选择上行到哪颗星；卫星 G/T 在该表逐站手动输入（同一颗星服务不同站因波束位置不同而 G/T 各异）。</p>
              <div class="bb-cards">
                <div v-for="cfg in satConfigs" :key="cfg.id" class="bb-card">
                  <div class="bb-card-hd">
                    <input v-model="cfg.name" class="bb-card-name" placeholder="卫星名（列表用）" />
                    <span class="lb-spacer"></span>
                    <button class="lb-mini" title="复制此卫星" @click="duplicateSatConfig(cfg)"><Icon name="copy" :size="12" /> 复制</button>
                    <button class="lb-mini" title="删除此卫星" :disabled="satConfigs.length <= 1" @click="removeSatConfig(cfg)">删除</button>
                  </div>
                  <div class="bb-card-bd"><RegenSatPanel :form="cfg.form" :fields="SAT_FIELDS" :ngso-sat="cfg.ngsoSat" :sat-tree="satTree" /></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 几何搜索时窗 + 计算按钮（已删除计算方式选择：工作点直接给定）-->
          <div class="lb-foot">
            <div class="modebar">
              <label class="pf pf-mode"><span class="pf-l">几何搜索时窗</span>
                <select v-model.number="geoHorizonHours" class="pf-i"><option v-for="h in HORIZONS" :key="h.v" :value="h.v">{{ h.l }}</option></select>
                <i class="pf-u"></i>
              </label>
              <span class="foot-tip">在此时窗内求几何最差工况并列出全部满足最低仰角的访问窗口（选星走 SGP4；手动圆轨道为示意）。</span>
            </div>
            <button class="lb-calc" :disabled="computing" @click="compute">{{ computing ? '计算中…' : `计算（${nLinks} 条${modeLabel}链路）` }}</button>
          </div>
        </template>
      </section>

      <!-- ③ 结果区 -->
      <section class="lb-col lb-result">
        <div class="lb-col-hd">
          <span>计算结果</span>
          <span class="lb-spacer"></span>
          <select v-model="exportLang" class="lb-lang-sel" title="导出语言 / Export language">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
          <button class="lb-mini" :disabled="exporting || !links.length" :title="links.length ? '导出 Excel' : '先计算再导出'" @click="exportExcel">{{ exporting ? '导出中…' : '导出 Excel' }}</button>
        </div>
        <div class="lb-col-bd">
          <div v-if="error" class="lb-err">{{ error }}</div>
          <div v-else-if="!links.length" class="lb-placeholder">填写参数后点击「计算」<br />生成再生式{{ modeLabel }}链路结果</div>
          <template v-else>
            <div v-if="capacitySummary.count && linkMode !== 'laser'" class="cap-sum">
              <div class="cap-sum-hd">
                <span class="cap-sum-t">容量汇总</span>
                <span class="cap-sum-n">{{ capacitySummary.count }} 条链路<template v-if="capacitySummary.failed"> · {{ capacitySummary.failed }} 条失败已排除</template></span>
              </div>
              <div class="cap-sum-main">
                <span class="cap-sum-ml">总容量</span>
                <span class="cap-sum-big">{{ capMain.v }}<i>{{ capMain.u }}</i></span>
              </div>
              <div class="cap-sum-sub">
                <div class="cap-sum-item"><span class="cap-sum-l">总带宽</span><span class="cap-sum-v">{{ bwMain.v }} <i>{{ bwMain.u }}</i></span></div>
                <div class="cap-sum-item"><span class="cap-sum-l">平均频谱效率</span><span class="cap-sum-v">{{ capacitySummary.avgEff.toFixed(3) }} <i>bps/Hz</i></span></div>
              </div>
            </div>

            <div v-if="links.length > 1" class="seq-wrap">
              <div class="mtx-ctl">
                <span>列表显示</span>
                <select v-model="metricKey" class="mtx-sel">
                  <option v-for="m in METRIC_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </div>
              <div class="seq-list">
                <div v-for="(l, idx) in links" :key="idx" class="seq-row"
                     :class="[l.error ? 'err' : (l.ok ? 'ok' : 'bad'), { sel: idx === selected }]"
                     @click="selectLink(idx)">
                  <span class="seq-idx">#{{ idx + 1 }}</span>
                  <span class="seq-name">{{ pairLabel(l) }}</span>
                  <span class="seq-val">{{ cellMetricList(l) }}</span>
                </div>
              </div>
              <p class="mtx-tip">逐{{ linkMode === 'isl' ? '条' : '站' }}{{ modeLabel }} · 点击查看瀑布 · 当前：{{ pairLabel(sel) }}</p>
            </div>

            <div v-if="sel && sel.error" class="lb-err">链路 {{ pairLabel(sel) }} 计算失败：{{ sel.error }}</div>
            <template v-else-if="core">
              <div v-if="core.linkType === 'laser'" class="core-card">
                <div class="core-row"><span class="core-l">链路余量</span><span class="core-v" :class="{ danger: +core.linkmargin < 0 }">{{ core.linkmargin }} dB</span></div>
                <div class="core-row"><span class="core-l">接收光功率 P_rx</span><span class="core-v">{{ core.laserPrxResult }} dBm</span></div>
                <div class="core-row"><span class="core-l">所需接收功率 P_req</span><span class="core-v">{{ core.laserPreqResult }} dBm</span></div>
                <div class="core-row"><span class="core-l">自由空间损耗 L_PS</span><span class="core-v">{{ core.laserFslResult }} dB</span></div>
                <div class="core-row"><span class="core-l">发射增益 G_tx</span><span class="core-v">{{ core.laserGTxResult }} dBi</span></div>
                <div class="core-row"><span class="core-l">接收增益 G_rx</span><span class="core-v">{{ core.laserGRxResult }} dBi</span></div>
                <div class="core-row"><span class="core-l">星间距离（最差）</span><span class="core-v">{{ core.laserDistResult }} km</span></div>
                <div class="core-row"><span class="core-l">互视可见度</span><span class="core-v">{{ core.laserVisibleFracResult }} %</span></div>
              </div>
              <div v-else-if="core.linkType === 'isl'" class="core-card">
                <div class="core-row"><span class="core-l">链路余量</span><span class="core-v" :class="{ danger: +core.linkmargin < 0 }">{{ core.linkmargin }} dB</span></div>
                <div class="core-row"><span class="core-l">星间 C/N</span><span class="core-v">{{ core.carrierTotalCN }} dB</span></div>
                <div class="core-row"><span class="core-l">门限 C/N</span><span class="core-v">{{ core.thresholdCN }} dB</span></div>
                <div class="core-row"><span class="core-l">发射 EIRP</span><span class="core-v">{{ core.islRfEirpResult }} dBW</span></div>
                <div class="core-row"><span class="core-l">接收 G/T</span><span class="core-v">{{ core.islRfGtResult }} dB/K</span></div>
                <div class="core-row"><span class="core-l">星间距离（最差）</span><span class="core-v">{{ core.islRfDistResult }} km</span></div>
                <div class="core-row"><span class="core-l">互视可见度</span><span class="core-v">{{ core.islVisibleFracResult }} %</span></div>
                <div class="core-row"><span class="core-l">误码率</span><span class="core-v">{{ core.berResult }}</span></div>
              </div>
              <div v-else-if="core.linkType === 'downlink'" class="core-card">
                <div class="core-row"><span class="core-l">链路余量</span><span class="core-v" :class="{ danger: +core.linkmargin < 0 }">{{ core.linkmargin }} dB</span></div>
                <div class="core-row"><span class="core-l">收信站 G/T</span><span class="core-v">{{ core.gOverTeResult }} dB/K</span></div>
                <div class="core-row"><span class="core-l">下行 C/N</span><span class="core-v">{{ core.carrierTotalCN }} dB</span></div>
                <div class="core-row"><span class="core-l">门限 C/N</span><span class="core-v">{{ core.thresholdCN }} dB</span></div>
                <div class="core-row"><span class="core-l">下行可用度</span><span class="core-v">{{ core.downlinkAvailabilityResult }} %</span></div>
                <div class="core-row"><span class="core-l">卫星功率谱密度</span><span class="core-v">{{ core.satellitePSDResult }} dBW/Hz</span></div>
                <div class="core-row"><span class="core-l">到达地面 PFD</span><span class="core-v">{{ core.arrivalPFDAtGroundResult }} dBW/m²</span></div>
                <div class="core-row"><span class="core-l">误码率</span><span class="core-v">{{ core.berResult }}</span></div>
              </div>
              <div v-else class="core-card">
                <div class="core-row"><span class="core-l">链路余量</span><span class="core-v" :class="{ danger: +core.linkmargin < 0 }">{{ core.linkmargin }} dB</span></div>
                <div class="core-row"><span class="core-l">功放实际</span><span class="core-v">{{ core.paRecommendation }} W</span></div>
                <div class="core-row"><span class="core-l">上行 C/N</span><span class="core-v">{{ core.carrierTotalCN }} dB</span></div>
                <div class="core-row"><span class="core-l">门限 C/N</span><span class="core-v">{{ core.thresholdCN }} dB</span></div>
                <div class="core-row"><span class="core-l">上行可用度</span><span class="core-v">{{ core.uplinkAvailabilityResult }} %</span></div>
                <div class="core-row"><span class="core-l">地球站 EIRP</span><span class="core-v">{{ core.stationEIRPResult }} dBW</span></div>
                <div class="core-row"><span class="core-l">功率谱密度</span><span class="core-v">{{ core.stationPSDResult }} dBW/Hz</span></div>
                <div class="core-row"><span class="core-l">误码率</span><span class="core-v">{{ core.berResult }}</span></div>
              </div>

              <!-- 星间几何 + 互视可见度（两星微波 ISL，最差工况）-->
              <div v-if="islGeo && islGeo.feasible" class="geo-card">
                <div class="geo-top">
                  <div class="geo-title">
                    <span class="geo-tt">星间几何（最差工况）</span>
                    <span class="geo-badge" :title="islGeo.representative ? '手动圆轨道：几何示意' : '双 SGP4/SDP4 传播 + 地球临边遮挡'">{{ islGeo.method }}</span>
                  </div>
                  <div class="geo-tz" role="group" aria-label="时区切换">
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                  </div>
                </div>
                <div class="geo-body">
                  <div v-if="islGeo.worst.worstISO && !islGeo.representative" class="geo-row"><span class="geo-l" title="所有几何量取自这一物理瞬间（互视样本中星间距离最大 → 最差 FSL）">最差时刻 t*</span><span class="geo-v" style="white-space:normal">{{ fmtInstant(islGeo.worst.worstISO, tzMode) }}</span></div>
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
                  <div class="geo-sec" v-if="islGeo.elements && (islGeo.elements.tx || islGeo.elements.rx)">两星轨道与运动<span class="geo-sec-x">发射 / 接收各一列</span></div>
                  <div v-if="islGeo.elements && (islGeo.elements.tx || islGeo.elements.rx)" class="geo-2col">
                    <div v-for="side in [{ k: 'tx', name: sel.txName, alt: islGeo.worst.txAltKm, spd: islGeo.worst.txSpeedKmS, gspd: islGeo.worst.txGroundSpeedKmS, el: islGeo.elements.tx }, { k: 'rx', name: sel.satName, alt: islGeo.worst.rxAltKm, spd: islGeo.worst.rxSpeedKmS, gspd: islGeo.worst.rxGroundSpeedKmS, el: islGeo.elements.rx }]" :key="side.k" class="geo-col">
                      <div class="geo-col-hd" :class="side.k">{{ side.k === 'tx' ? '发射卫星' : '接收卫星' }}<em>{{ side.name }}</em></div>
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
                  <div class="geo-tz" role="group" aria-label="时区切换">
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                  </div>
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
                几何提示：{{ geom.reason }}。请检查卫星轨道高度与发信站纬度（赤道轨道看不到高纬站），或调整最低仰角/搜索时窗。
              </div>

              <WaterfallTable :segments="segments" />
            </template>
          </template>
        </div>
      </section>
    </div>

    <!-- 配置右键菜单 -->
    <div v-if="ctxMenu.open" class="lb-ctx-mask" @click="ctxMenu.open = false" @contextmenu.prevent="ctxMenu.open = false">
      <div class="lb-ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop>
        <template v-if="ctxIsFolder">
          <button class="lb-ctx-i" @click="ctxDo(() => startRename(ctxConfig))">重命名</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addFolder(ctxMenu.configId))">新建子文件夹</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addBlankConfig(ctxMenu.configId))">在此新建配置</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(ctxMenu.configId, true))">粘贴到此文件夹</button>
          <button class="lb-ctx-i danger" @click="ctxDo(() => removeFolder(ctxConfig))">删除文件夹（含子项）</button>
        </template>
        <template v-else-if="ctxConfig">
          <button class="lb-ctx-i" @click="ctxDo(() => startRename(ctxConfig))">重命名</button>
          <button class="lb-ctx-i" @click="ctxDo(() => copyConfig(ctxConfig))">复制</button>
          <button class="lb-ctx-i" @click="ctxDo(() => cutConfig(ctxConfig))">剪切</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(ctxMenu.configId))">粘贴到此后</button>
          <button class="lb-ctx-i danger" @click="ctxDo(() => removeConfig(ctxConfig.id))">删除</button>
        </template>
        <template v-else>
          <button class="lb-ctx-i" @click="ctxDo(() => addFolder(null))">新建文件夹</button>
          <button class="lb-ctx-i" @click="ctxDo(() => addBlankConfig(null))">添加空白配置</button>
          <button class="lb-ctx-i" :disabled="!api" @click="ctxDo(openSaveDlg)">保存当前为新配置</button>
          <button v-if="cfgClip" class="lb-ctx-i" @click="ctxDo(() => pasteConfig(null))">粘贴{{ cfgClip.mode === 'cut' ? '（移动到末尾）' : '' }}</button>
        </template>
        <div class="lb-ctx-sep"></div>
        <button class="lb-ctx-i" @click="ctxDo(() => { configsCollapsed = true })">收起配置栏</button>
      </div>
    </div>

    <!-- 命名弹窗 -->
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

    <!-- 离开已改动配置提示 -->
    <div v-if="leaveDlg.open" class="lb-mask" @click="leaveAnswer('cancel')">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">配置已修改</div>
        <div class="lb-dlg-bd"><div class="lb-share-row">「<b>{{ leaveDlg.name }}</b>」有未保存的修改，是否保存？</div></div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="leaveAnswer('cancel')">取消</button>
          <button class="lb-mini" @click="leaveAnswer('discard')">不保存</button>
          <button class="lb-mini primary" @click="leaveAnswer('save')">保存</button>
        </div>
      </div>
    </div>

    <!-- 通用确认弹窗 -->
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

    <!-- 分享 / 导入弹窗 -->
    <div v-if="shareDlg.open" class="lb-mask" @click="shareDlg.open = false">
      <div class="lb-dlg lb-dlg-wide" @click.stop>
        <div class="lb-dlg-hd">配置分享 / 导入<span class="lb-dlg-sp"></span>
          <span class="lb-dlg-id" v-if="deviceId">我的ID：<b>{{ deviceId }}</b></span>
        </div>
        <div class="lb-tabs">
          <button class="lb-tab" :class="{ on: shareDlg.tab === 'offline' }" @click="shareDlg.tab = 'offline'">线下（分享码 / 文件）</button>
          <button class="lb-tab" :class="{ on: shareDlg.tab === 'online' }" @click="shareDlg.tab = 'online'">线上（按用户ID）</button>
        </div>
        <div v-if="shareDlg.tab === 'offline'" class="lb-dlg-bd">
          <div class="lb-share-row">分享对象：<b>{{ shareLabel() }}</b>（当前聚焦配置 / 工作参数）</div>
          <label class="lb-share-l">分享码（复制发给对方，对方粘贴即可导入）</label>
          <textarea class="lb-area" :value="shareDlg.code" readonly rows="3" @focus="$event.target.select()"></textarea>
          <div class="lb-share-acts">
            <button class="lb-mini primary" @click="copyShareCode">复制分享码</button>
            <button class="lb-mini" @click="exportConfigFile">导出为文件（.lbcfg）</button>
            <button class="lb-mini" @click="importConfigFile">从文件导入</button>
          </div>
          <label class="lb-share-l">导入：粘贴分享码后点「导入」</label>
          <textarea v-model="importText" class="lb-area" rows="3" placeholder="在此粘贴 LBCFG1... 分享码"></textarea>
          <div class="lb-share-acts">
            <button class="lb-mini" @click="importFromClipboard">从剪贴板粘贴并导入</button>
            <button class="lb-mini primary" :disabled="!importText.trim()" @click="importFromCode">导入</button>
          </div>
        </div>
        <div v-else class="lb-dlg-bd">
          <template v-if="shareConfigured">
            <div class="lb-share-row">把「<b>{{ shareLabel() }}</b>」通过互联网发给对方，只需对方的用户ID。</div>
            <label class="lb-share-l">对方用户ID</label>
            <div class="lb-share-acts">
              <input v-model="shareDlg.recip" class="lb-input" style="flex:1" placeholder="例如 3F9A2C7B10" @keyup.enter="sendOnline" />
              <button class="lb-mini primary" :disabled="shareDlg.sending || !shareDlg.recip.trim()" @click="sendOnline">{{ shareDlg.sending ? '发送中…' : '发送' }}</button>
            </div>
            <div class="lb-inbox-hd">
              <span>我的收件箱</span>
              <button class="lb-mini" :disabled="shareDlg.loadingInbox" @click="loadInbox">{{ shareDlg.loadingInbox ? '刷新中…' : '刷新' }}</button>
            </div>
            <div v-if="shareDlg.inboxMsg" class="lb-share-l">{{ shareDlg.inboxMsg }}</div>
            <ul v-if="shareDlg.inbox.length" class="lb-inbox">
              <li v-for="it in shareDlg.inbox" :key="it.id">
                <span class="lb-inbox-nm" :title="'来自 ' + (it.from || '未知')">{{ it.name }}<i v-if="it.items && it.items.length > 1"> · {{ it.items.length }} 个</i><i v-if="it.from"> · 来自 {{ it.from }}</i></span>
                <button class="lb-mini primary" @click="acceptInbox(it)">接收</button>
                <button class="lb-mini" @click="dismissInbox(it)">忽略</button>
              </li>
            </ul>
          </template>
          <div v-else class="lb-share-note">在线分享功能尚未配置；当前可先用「线下分享码」即时分享。</div>
        </div>
        <div class="lb-dlg-ft"><button class="lb-mini" @click="shareDlg.open = false">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--font-sans);
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  --up: #3f6d8c; --dn: #97672f;
  --r-ctl: 2px; --r-box: 3px; --r-modal: 4px;
}
html[data-theme='dark'] .lb-shell { --ok: #6f9d85; --warn: #b59a5e; --danger: #c08079; --up: #82a9c6; --dn: #c9a26a; }

.lb-topbar { display: flex; align-items: center; gap: 10px; height: 32px; flex: none; padding: 0 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
.lb-brand { font-family: var(--font-serif); font-size: 13px; letter-spacing: .5px; line-height: 1; }
.lb-sub { color: var(--text-faint); font-size: 11px; letter-spacing: .5px; line-height: 1; }
.lb-refresh { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; cursor: pointer; background: transparent; color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-refresh:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-refresh:disabled { opacity: .45; cursor: not-allowed; }
.lb-refresh-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
.lb-refresh.spin .lb-refresh-svg { animation: lb-spin .7s linear infinite; transform-origin: 50% 50%; }
@keyframes lb-spin { to { transform: rotate(360deg); } }
.lb-spacer { flex: 1; }
.lb-hint { color: var(--warn); font-size: 11px; display: inline-flex; align-items: center; gap: 4px; }
.lb-note { color: var(--ok); font-size: 11px; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lb-body { flex: 1; display: flex; min-height: 0; }
.lb-col { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--border); }
.lb-col:last-child { border-right: none; }
.lb-configs { width: 210px; flex: none; position: relative; transition: width .15s ease; }
.lb-configs.collapsed { width: 26px; min-width: 26px; }
.lb-configs.resizing { transition: none; user-select: none; }
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
.lb-configs .lb-col-bd { padding: 10px 8px; scrollbar-width: thin; }
.lb-cfg-hd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-cfg-chev { font-size: 14px; line-height: 1; display: inline-flex; align-items: center; }
.lb-cfg-expand { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 0; cursor: pointer; background: var(--surface); color: var(--text-muted); border: 0; }
.lb-cfg-expand:hover { color: var(--text); background: var(--surface-2); }
.lb-cfg-expand .lb-cfg-chev { font-size: 16px; }
.lb-cfg-expand-t { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 3px; }
.lb-build { flex: 1; min-width: 460px; }
.lb-result { width: 440px; flex: none; }

.lb-col-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; flex: none; padding: 0 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.lb-col-bd { flex: 1; overflow: auto; padding: 12px; }
.lb-lang-sel { font: inherit; font-size: 11px; text-transform: none; letter-spacing: normal; line-height: 1; padding: 3px 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-lang-sel:focus { outline: none; border-color: var(--accent); }
.lb-mini { font: inherit; font-size: 11px; line-height: 1; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-mini:disabled { opacity: .45; cursor: not-allowed; }
.lb-placeholder { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; }
.lb-cfg-acts { display: flex; gap: 4px; }
.lb-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.lb-ctx { position: fixed; min-width: 150px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.lb-ctx-i { font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl); white-space: nowrap; }
.lb-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.lb-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.lb-ctx-i.danger:hover { color: var(--danger); }
.lb-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; }
.lb-ico-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; }
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-mono); color: var(--text); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; }

.lb-mask { position: fixed; inset: 0; z-index: 300; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.28); }
.lb-dlg { width: 380px; display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); overflow: hidden; }
.lb-dlg-wide { width: 460px; }
.lb-dlg-hd { display: flex; align-items: center; gap: 8px; padding: 10px 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); background: var(--surface-2); border-bottom: 1px solid var(--border); }
.lb-dlg-sp { flex: 1; }
.lb-dlg-id { font-size: 11px; letter-spacing: normal; text-transform: none; color: var(--text-muted); }
.lb-dlg-id b { font-family: var(--font-mono); color: var(--text); }
.lb-dlg-bd { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.lb-dlg-ft { display: flex; justify-content: flex-end; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.lb-input { font: inherit; font-size: 12px; padding: 6px 9px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-input:focus { outline: none; border-color: var(--accent); }
.lb-mini.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.lb-mini.primary:hover:not(:disabled) { opacity: .88; }
.lb-tabs { display: flex; gap: 4px; padding: 8px 12px 0; }
.lb-tab { flex: 1; font: inherit; font-size: 12px; padding: 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-tab.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.lb-share-row { font-size: 12px; color: var(--text-muted); }
.lb-share-l { font-size: 11px; color: var(--text-faint); margin-top: 2px; }
.lb-area { font-family: var(--font-mono); font-size: 11px; padding: 6px 8px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); resize: vertical; word-break: break-all; }
.lb-area:focus { outline: none; border-color: var(--accent); }
.lb-share-acts { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.lb-share-note { font-size: 11px; color: var(--warn); line-height: 1.6; margin-top: 4px; }
.lb-inbox-hd { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; padding-top: 8px; border-top: 1px dashed var(--border); font-size: 12px; color: var(--text-muted); }
.lb-inbox { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow: auto; }
.lb-inbox li { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border: 1px solid var(--border); border-radius: var(--r-ctl); font-size: 12px; }
.lb-inbox-nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-inbox-nm i { color: var(--text-faint); font-style: normal; font-size: 11px; }

.rlmode { display: flex; align-items: center; gap: 4px; flex: none; padding: 8px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.rlmode-i { position: relative; display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; font-weight: 600; padding: 6px 9px 6px 14px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.rlmode-i:hover:not(.disabled) { color: var(--text); border-color: var(--border-strong); }
.rlmode-i.on { background: var(--accent); color: var(--bg); border-color: var(--accent); }
.rlmode-i.disabled { opacity: .55; cursor: not-allowed; }
.rlmode-todo { font-size: 9px; font-weight: 700; margin-left: 1px; padding: 1px 5px; border-radius: 999px; background: var(--surface-2); color: var(--text-faint); border: 1px solid var(--border); vertical-align: 1px; }
.rlmode-i.on .rlmode-todo { background: rgba(255,255,255,.2); color: #fff; border-color: transparent; }
.rlmode-x { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-left: 1px; border-radius: 4px; color: currentColor; opacity: .5; }
.rlmode-x svg { stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; fill: none; }
.rlmode-i:hover .rlmode-x { opacity: .8; }
.rlmode-x:hover { opacity: 1; background: rgba(214,69,69,.16); color: #d64545; }
.rlmode-i.on .rlmode-x:hover { background: rgba(255,255,255,.28); color: #fff; }
.rlmode-add-wrap { position: relative; display: inline-flex; }
.rlmode-add { display: inline-flex; align-items: center; justify-content: center; width: 27px; height: 27px; padding: 0; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--r-ctl); }
.rlmode-add svg { stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; fill: none; }
.rlmode-add:hover, .rlmode-add.on { color: var(--accent); border-color: var(--accent); }
.rlmode-menu-mask { position: fixed; inset: 0; z-index: 40; }
.rlmode-menu { position: absolute; top: calc(100% + 5px); left: 0; z-index: 41; min-width: 156px; display: flex; flex-direction: column; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-modal); box-shadow: 0 8px 24px rgba(0,0,0,.18); }
.rlmode-menu-hd { font-size: 10px; font-weight: 600; letter-spacing: .5px; color: var(--text-faint); padding: 4px 8px 6px; }
.rlmode-menu-i { text-align: left; font: inherit; font-size: 12px; font-weight: 500; padding: 6px 8px; cursor: pointer; background: transparent; color: var(--text); border: none; border-radius: var(--r-ctl); }
.rlmode-menu-i:hover { background: var(--surface-2); }

.mods { display: flex; align-items: center; flex: none; gap: 2px; padding: 8px 12px; background: var(--surface); border-bottom: 1px solid var(--border); overflow-x: auto; }
.mod { display: flex; align-items: center; gap: 6px; padding: 6px 11px; cursor: pointer; font: inherit; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); white-space: nowrap; }
.mod:hover { border-color: var(--border-strong); color: var(--text); }
.mod.on { border-color: var(--border-strong); background: var(--surface-2); color: var(--text); box-shadow: inset 0 -2px 0 var(--accent); }
.mod-ico { width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; color: var(--text-faint); }
.mod.on .mod-ico { color: var(--text); }
.mic { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.mic-sat { width: 18px; height: 18px; fill: currentColor; }
.mod-t { font-size: 12px; font-weight: 600; }
.mod-n { font-family: var(--font-mono); font-size: 11px; min-width: 17px; text-align: center; padding: 1px 4px; border-radius: var(--r-ctl); background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); }
.mod.on .mod-n { background: var(--bg); color: var(--text); }
.mod-wire { color: var(--text-faint); font-size: 12px; padding: 0 1px; display: inline-flex; align-items: center; }

.lb-edit { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.tx-wrap { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tx-optbar { display: flex; align-items: center; gap: 10px; flex: none; margin-bottom: 6px; flex-wrap: wrap; }
.tx-optl { font-size: 12px; color: var(--text-muted); font-weight: 600; }
.tx-opttip { font-size: 11px; color: var(--text-faint); }
.isl-tip { font-size: 11px; color: var(--text-faint); line-height: 1.6; margin: 0 0 8px; flex: none; }
.isl-tip b { color: var(--text-muted); font-weight: 600; }
.bb-wrap { max-width: 620px; }
.bb-toolbar { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.bb-count { font-size: 12px; color: var(--text-muted); }
.bb-tip { font-size: 11px; color: var(--text-faint); line-height: 1.6; margin: 0 0 10px; }
.bb-cards { display: flex; flex-direction: column; gap: 10px; }
.bb-card { border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); overflow: hidden; }
.bb-card-hd { display: flex; align-items: center; gap: 6px; padding: 5px 8px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.bb-card-name { flex: none; width: 160px; font: inherit; font-size: 12px; font-weight: 600; padding: 4px 7px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.bb-card-name:focus { outline: none; border-color: var(--accent); }
.bb-card-bd { padding: 10px 10px 4px; }
.bb-card-bd :deep(.bb) { max-width: none; }
.pf { display: grid; grid-template-columns: 1fr 110px 36px; align-items: center; gap: 6px; margin-bottom: 6px; }
.pf-l { font-size: 12px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pf-i { font: inherit; font-size: 12px; padding: 4px 7px; width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.pf-i:focus { outline: none; border-color: var(--accent); }
.pf-i.mono { font-family: var(--font-mono); }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }

.seg { display: flex; gap: 2px; }
.seg-i { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.seg-i:hover { color: var(--text); border-color: var(--border-strong); }
.seg-i.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }

.lb-foot { flex: none; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
.modebar { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; }
.modebar .pf { flex: none; width: 236px; margin-bottom: 0; }
.modebar .pf.pf-mode { width: 236px; grid-template-columns: auto 120px 8px; }
.foot-tip { font-size: 11px; color: var(--text-faint); flex: 1; min-width: 0; }
.lb-calc { width: 100%; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .5px; padding: 8px; cursor: pointer; background: var(--accent); color: var(--bg); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-calc:hover:not(:disabled) { opacity: .88; }
.lb-calc:disabled { opacity: .5; cursor: not-allowed; }

.rl-todo { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px; color: var(--text-faint); text-align: center; }
.rl-todo-t { font-size: 14px; font-weight: 600; color: var(--text-muted); }
.rl-todo-s { font-size: 12px; line-height: 1.6; max-width: 320px; }

.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }
.mtx-ctl { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--text-muted); }
.mtx-sel { font: inherit; font-size: 12px; padding: 3px 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.mtx-sel:focus { outline: none; border-color: var(--accent); }
.mtx-tip { margin: 6px 0 0; font-size: 11px; color: var(--text-faint); }
.seq-wrap { margin-bottom: 14px; }
.seq-list { display: flex; flex-direction: column; max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-box); }
.seq-row { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 12px; cursor: pointer; border-bottom: 1px solid var(--border); }
.seq-row:last-child { border-bottom: none; }
.seq-row:hover { background: var(--surface-2); }
.seq-row.sel { background: color-mix(in srgb, var(--accent) 8%, var(--bg)); outline: 1.5px solid var(--accent); outline-offset: -1.5px; }
.seq-idx { flex: none; width: 26px; font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); }
.seq-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.seq-val { flex: none; min-width: 64px; text-align: right; font-family: var(--font-mono); font-weight: 600; }
.seq-row.ok .seq-val { color: var(--ok); }
.seq-row.bad .seq-val { color: var(--danger); }
.seq-row.err .seq-val { color: var(--text-faint); }

/* 结果核心卡：链路余量 + 细指标（与 GEO 一致的两列网格，字号略小） */
.core-card { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-bottom: 14px; padding: 9px 12px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); }
.core-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; white-space: nowrap; overflow: hidden; }
.core-l { font-size: 11px; color: var(--text-muted); flex-shrink: 0; }
.core-v { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text); text-align: right; overflow: hidden; text-overflow: ellipsis; }
.core-v.danger { color: var(--danger); }

.geo-card { margin-bottom: 14px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); overflow: hidden; }
.geo-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 12px; background: var(--surface-2); border-bottom: 1px solid var(--border); }
.geo-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.geo-tt { font-size: 12px; font-weight: 700; letter-spacing: .3px; color: var(--text); }
.geo-badge { flex: none; align-self: center; font-family: var(--font-mono); font-size: 10px; font-weight: 700; letter-spacing: .5px; line-height: 1; padding: 2px 7px; border-radius: 999px; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border-strong); }
.geo-tz { display: inline-flex; flex: none; border: 1px solid var(--border-strong); border-radius: var(--r-ctl); overflow: hidden; }
.geo-tzb { font: inherit; font-size: 11px; line-height: 1; padding: 3px 9px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 0; }
.geo-tzb + .geo-tzb { border-left: 1px solid var(--border); }
.geo-tzb:hover:not(.on) { color: var(--text); }
.geo-tzb.on { background: var(--accent); color: var(--bg); font-weight: 600; }
.geo-body { padding: 5px 12px 10px; }
.geo-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 0 18px; }
.geo-col { min-width: 0; }
.geo-col-hd { display: flex; align-items: baseline; gap: 6px; font-size: 12px; font-weight: 700; padding: 3px 0 5px; border-bottom: 2px solid var(--border-strong); margin-bottom: 2px; }
.geo-col-hd.tx { color: var(--accent); border-bottom-color: var(--accent); }
.geo-col-hd.rx { color: #16a34a; border-bottom-color: #16a34a; }
.geo-col-hd em { font-style: normal; font-weight: 500; font-size: 11px; color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.geo-col-na { font-size: 12px; color: var(--text-faint); padding: 12px 0; }
.geo-col .geo-sec:first-of-type { border-top: none; padding-top: 3px; margin-top: 4px; }
.geo-sec { display: flex; align-items: baseline; gap: 7px; font-size: 11px; font-weight: 600; color: var(--accent); margin: 11px 0 4px; padding-top: 8px; border-top: 1px dashed var(--border); letter-spacing: .3px; }
.geo-sec-x { font-weight: 400; font-size: 10px; color: var(--text-faint); letter-spacing: .2px; }
.geo-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 2.5px 0; }
.geo-l { font-size: 12px; color: var(--text-muted); min-width: 0; }
.geo-l i { font-style: normal; font-size: 10px; color: var(--text-faint); margin-left: 4px; letter-spacing: .2px; }
.geo-v { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-v i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 5px; }
.geo-v.geo-inf { font-size: 18px; line-height: 1; }
.geo-v.danger { color: var(--danger); }
.geo-row.hi { background: var(--bg-soft, rgba(127,127,127,.06)); margin: 0 -6px; padding: 2.5px 6px; border-radius: 4px; }
.geo-row.hi .geo-l { color: var(--text); font-weight: 600; }
.geo-row.hi .geo-v { font-size: 12.5px; }
.geo-note { padding: 10px 12px; font-size: 11px; color: var(--text-muted); line-height: 1.6; font-family: inherit; font-weight: 400; }

/* 访问窗口列表 */
.acc-sum { font-size: 12px; color: var(--text-muted); line-height: 1.6; }
.acc-sum b { color: var(--text); font-family: var(--font-mono); }
.acc-note { color: var(--text-faint); font-size: 11px; }
.acc-none { font-size: 12px; color: var(--warn); line-height: 1.6; }
.acc-list { margin-top: 8px; border: 1px solid var(--border); border-radius: var(--r-ctl); overflow: hidden; }
.acc-hd, .acc-row { display: grid; grid-template-columns: 26px 1fr 64px 62px; gap: 6px; align-items: center; padding: 4px 8px; font-size: 11px; }
.acc-hd { background: var(--surface-2); color: var(--text-faint); font-weight: 600; }
.acc-row { border-top: 1px solid var(--border); color: var(--text-muted); }
.acc-row .mono { font-family: var(--font-mono); }
.acc-c1 { color: var(--text-faint); }
.acc-c3, .acc-c4 { text-align: right; }
.acc-clip { font-style: normal; font-size: 9px; color: var(--text-faint); margin-left: 5px; padding: 0 4px; border: 1px solid var(--border); border-radius: 999px; }

.cap-sum { margin-bottom: 14px; padding: 11px 13px; border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: var(--r-box); background: var(--surface); }
.cap-sum-hd { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.cap-sum-t { font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; color: var(--text-muted); }
.cap-sum-n { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cap-sum-main { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding-bottom: 9px; border-bottom: 1px dashed var(--border); }
.cap-sum-ml { font-size: 12px; color: var(--text-muted); flex: none; }
.cap-sum-big { font-family: var(--font-mono); font-size: 24px; font-weight: 700; line-height: 1; color: var(--accent); text-align: right; overflow: hidden; text-overflow: ellipsis; }
.cap-sum-big i { font-size: 12px; font-weight: 600; font-style: normal; margin-left: 4px; color: var(--text-muted); }
.cap-sum-sub { display: grid; grid-template-columns: 1fr 1fr; gap: 3px 16px; margin-top: 8px; }
.cap-sum-item { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; min-width: 0; }
.cap-sum-l { font-size: 12px; color: var(--text-muted); flex: none; }
.cap-sum-v { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.cap-sum-v i { font-size: 11px; font-weight: 400; font-style: normal; color: var(--text-faint); }
</style>
