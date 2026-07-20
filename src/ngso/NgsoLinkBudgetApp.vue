<script setup>
import { ref, shallowRef, reactive, computed, onMounted, nextTick, watch } from 'vue'
import { SAT_FIELDS, CARRIER_FIELDS, TX_FIELDS, RX_FIELDS, defaultsFor, buildParams } from './ngsoParams.js'
import { loadSatTree, sampleAntennaParams, sampleAntennaParam } from './grdParam.js'
import { encodeShare, decodeShare, configFileText } from './shareCode.js'
import { findPoolByNorad } from './satSearchPool.js'
import { stableStringify } from '../shared/configDirty.js'
import Icon from '../components/Icon.vue'
import ConfigTree from '../components/ConfigTree.vue'
import StationGrid from './StationGrid.vue'
import BasebandPanel from './BasebandPanel.vue'
import NgsoSatellitePanel from './NgsoSatellitePanel.vue'
import WaterfallTable from './WaterfallTable.vue'

const api = typeof window !== 'undefined' ? window.api : null

// 配置列表（Phase 4）：命名配置持久化到 userData/configs.json（store.config.*）。CRUD 见下方 Phase 4 区。
// 列表已升级为「多级文件夹树」：configs 里同时含配置项与文件夹项 { type:'folder',name,parentId,orbitType:'NGSO' }。
const configs = ref([])
const activeId = ref(null)
// 展开的文件夹 id 集合（响应式 Set，跨会话记忆，ngso 命名空间）
const expandedFolders = ref(new Set(JSON.parse(localStorage.getItem('ngso/expandedFolders') || '[]')))
function persistExpanded() { try { localStorage.setItem('ngso/expandedFolders', JSON.stringify([...expandedFolders.value])) } catch (e) { /* ignore */ } }
function toggleFolder(f) { const s = new Set(expandedFolders.value); if (s.has(f.id)) s.delete(f.id); else s.add(f.id); expandedFolders.value = s; persistExpanded() }
// 配置列表可向左收起（记住状态）
const configsCollapsed = ref(localStorage.getItem('ngso/configsCollapsed') === '1')
watch(configsCollapsed, (v) => { try { localStorage.setItem('ngso/configsCollapsed', v ? '1' : '0') } catch (e) { /* ignore */ } })
// 配置栏宽度可拖拽调整（记住），应对多级文件夹深缩进后名称显示不全
const CFG_W_MIN = 180, CFG_W_MAX = 520
const configsWidth = ref(Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, Number(localStorage.getItem('ngso/configsWidth')) || 210)))
const configsResizing = ref(false)
function startResizeConfigs(e) {
  const startX = e.clientX, startW = configsWidth.value
  configsResizing.value = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'
  const move = (ev) => { configsWidth.value = Math.min(CFG_W_MAX, Math.max(CFG_W_MIN, startW + (ev.clientX - startX))) }
  const up = () => {
    configsResizing.value = false; document.body.style.cursor = ''; document.body.style.userSelect = ''
    window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up)
    try { localStorage.setItem('ngso/configsWidth', String(configsWidth.value)) } catch (e2) { /* ignore */ }
  }
  window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
}

// —— 共享参数（卫星）与多站（发信站群 / 收信站群）——
const satForm = reactive(defaultsFor(SAT_FIELDS))
const basebandOpts = ref({})

// —— 载波信号配置库（Phase 6）：载波由发信站调制器产生，故与发信站绑定（非收信站）——
// 每份配置 = 引擎参数(CARRIER_FIELDS，含系统余量) + UI 态(门限模式/频谱效率模式/DVB/MODCOD)。
// 「载波信号」模块以多张卡片同时展示/编辑全部配置（不再是单一表单+下拉切换）。
// 发信站表新增「载波信号配置」列选择使用哪一份；同一配置可被多个发信站共用，未选(空)即用第一份。
let _bbSeq = 1
function makeBasebandConfig(name) { return { id: 'bb' + (_bbSeq++), name, form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1 } } }
const basebandConfigs = reactive([makeBasebandConfig('默认')])
// 按 id 解析；正常路径（下拉选 / 粘贴 / 批量设值）StationGrid 已把存值归一化成合法 id，
// 这里按名称兜底匹配只是双保险（防御旧数据或遗漏路径）。都没命中则退到第一份默认配置。
function resolveBaseband(id) {
  if (!id) return basebandConfigs[0]
  return basebandConfigs.find((c) => c.id === id) || basebandConfigs.find((c) => c.name === id) || basebandConfigs[0]
}
const basebandSelectOptions = computed(() => [{ value: '', label: '（默认）' }, ...basebandConfigs.map((c) => ({ value: c.id, label: c.name }))])
function addBasebandConfig() { basebandConfigs.push(makeBasebandConfig('配置' + (basebandConfigs.length + 1))) }
function duplicateBasebandConfig(cfg) {
  basebandConfigs.push({ id: 'bb' + (_bbSeq++), name: cfg.name + ' 副本', form: JSON.parse(JSON.stringify(cfg.form)) })
}
function removeBasebandConfig(cfg) {
  if (basebandConfigs.length <= 1) return
  const idx = basebandConfigs.findIndex((c) => c.id === cfg.id)
  if (idx >= 0) basebandConfigs.splice(idx, 1)
}
let _sid = 1
const newStation = (fields) => { const r = defaultsFor(fields); r._id = 's' + (_sid++); return r }
const txStations = reactive([newStation(TX_FIELDS)])
const rxStations = reactive([newStation(RX_FIELDS)])

// —— 点击式 4 模块 ——（载波信号与发信站绑定，排在发信站左边）
const MODULES = [
  { key: 'carrier', label: '载波信号', icon: 'wave' },
  { key: 'tx', label: '发信站群', icon: 'up' },
  { key: 'sat', label: '卫星', icon: 'sat' },
  { key: 'rx', label: '收信站群', icon: 'down' }
]
const activeModule = ref('tx')
const moduleCount = (k) => (k === 'tx' ? txStations.length : k === 'rx' ? rxStations.length : 0)

// —— 计算方式 ——（enLabel 供导出 Excel 选英文时用，措辞对齐链路预算工程惯用语）
const CALC_MODES = [
  { key: 'margin', label: '设置余量', enLabel: 'Fixed Margin', tip: '输入余量 → 算功放功率' },
  { key: 'power', label: '设置功放大小', enLabel: 'Fixed PA Power', tip: '输入功放功率(W) → 反推余量' },
  { key: 'balance', label: '功带平衡', enLabel: 'Power-Bandwidth Balance', tip: '自动求功带平衡点的余量' },
  { key: 'overbalance', label: '功带平衡下超发', enLabel: 'Power-Bandwidth Balance with Overdrive', tip: '相对功带平衡超发 x dB → 自动算余量' }
]
const calcMode = ref('margin')
const targetPowerW = ref('')
const overDb = ref('0')
// 系统余量是「设置余量」模式的批量目标值，与 targetPowerW/overDb 同性质——批量计算的统一目标，
// 不随某份载波信号配置走（载波本身不需要知道你想算多少余量，那是计算策略的事）。
const targetMarginDb = ref('3.00')

// —— 链路配对方式：常规计算(按序号 1↔1，默认) / 矩阵计算(m×n 全配对) ——
const LINK_PAIR_MODES = [
  { key: 'sequential', label: '常规计算', enLabel: 'Sequential (1:1)', tip: '按序号 1↔1 配对：发1↔收1、发2↔收2…' },
  { key: 'matrix', label: '矩阵计算', enLabel: 'Full Matrix (m×n)', tip: 'm×n 全配对：每个发信站对每个收信站都算一条链路' }
]
const linkPairMode = ref('sequential')
const pairCount = computed(() => linkPairMode.value === 'sequential' ? Math.min(nTx.value, nRx.value) : nTx.value * nRx.value)

// —— 计算结果（m×n 链路矩阵）——
// shallowRef：避免 Vue 把每条链路的 data(引擎结果) 深度代理成 reactive，
// 否则传给 waterfall IPC 时结构化克隆会报 “could not be cloned”。
const links = shallowRef([])  // [{ ti, ri, txName, rxName, data, margin, ok, totalCN, thresholdCN, avail, powerW, metric, error }]
const resultMode = ref('margin') // 出结果时所用的计算方式（决定「自动」口径）
const resultPairMode = ref('sequential') // 出结果时所用的配对方式（决定矩阵/列表展示）
// 矩阵单元格显示哪个指标（默认「自动」= 设置余量显功放W、其它显余量dB）
const METRIC_OPTIONS = [
  { key: 'auto', label: '自动' },
  { key: 'linkmargin', label: '链路余量 (dB)' },
  { key: 'paRecommendation', label: '功放功率 (W)' },
  { key: 'capacityMbps', label: '容量 (Mbps)' },
  { key: 'spectralEfficiencyResult', label: '频谱效率 (bps/Hz)' },
  { key: 'carrierTotalCN', label: '合计 C/N (dB)' },
  { key: 'ebnoActualResult', label: 'Eb/N₀ (dB)' },
  { key: 'esnoActualResult', label: 'Es/N₀ (dB)' },
  { key: 'powerUsageRatio', label: '功率占用 (%)' },
  { key: 'bandwidthUsageRatio', label: '带宽占用 (%)' },
  { key: 'allocBandwidthResult', label: '载波带宽 (kHz)' },
  { key: 'PowerBWResult', label: '功率带宽 (kHz)' },
  { key: 'uplinkCN', label: '上行 C/N (dB)' },
  { key: 'downlinkCN', label: '下行 C/N (dB)' },
  { key: 'satellitePSDResult', label: '载波功率谱密度 (dBW/Hz)' },
  { key: 'selectedPowerWResult', label: '功放实际输出 (W)' }
]
const metricKey = ref('auto')
const metricLabel = computed(() => metricKey.value === 'auto'
  ? (resultMode.value === 'margin' ? '功放 W' : '余量 dB')
  : (METRIC_OPTIONS.find((m) => m.key === metricKey.value)?.label || ''))
function cellMetric(l) {
  if (!l) return ''
  if (l.error) return '✕'
  if (metricKey.value === 'auto') return l.metric
  if (metricKey.value === 'capacityMbps') {   // 派生指标：引擎结果里没有现成字段，由 η×B 换算
    const kbps = capacityKbpsOf(l.data)
    return isFinite(kbps) ? (kbps / 1000).toFixed(3) : '—'
  }
  const v = l.data ? l.data[metricKey.value] : undefined
  return (v === undefined || v === null || v === '') ? '—' : v
}
// METRIC_OPTIONS 的 label 统一是「标题 (单位)」格式，拆出标题/单位供列表显示用
function parseMetricLabel(label) {
  const m = /^(.*?)\s*\(([^)]+)\)$/.exec(label || '')
  return m ? { title: m[1], unit: m[2] } : { title: label || '', unit: '' }
}
// 常规计算结果列表专用：选「自动」时单看数字不知道对应哪个指标（margin 模式是功放功率，
// 其它模式是链路余量），矩阵模式靠表头角标统一标注即可，但列表逐行展示没有这层上下文，
// 改成「标题：数值 单位」；选了具体指标则该指标已经显式选中，数字本身不再有歧义，原样显示。
function cellMetricList(l) {
  if (!l) return ''
  if (l.error) return '✕'
  if (metricKey.value !== 'auto') return cellMetric(l)
  const v = l.metric
  if (v === undefined || v === null || v === '') return '—'
  const opt = METRIC_OPTIONS.find((m) => m.key === (resultMode.value === 'margin' ? 'paRecommendation' : 'linkmargin'))
  if (!opt) return v
  const { title, unit } = parseMetricLabel(opt.label)
  return `${title}：${v}${unit ? ' ' + unit : ''}`
}
// 矩阵十字定位：悬停坐标
const hoverTi = ref(-1)
const hoverRi = ref(-1)
function onCellHover(ti, ri) { hoverTi.value = ti; hoverRi.value = ri }
function clearHover() { hoverTi.value = -1; hoverRi.value = -1 }
const selected = ref(0)       // 当前查看的链路下标
const segments = ref([])      // 当前链路瀑布
const computing = ref(false)
const error = ref('')

const nTx = computed(() => txStations.length)
const nRx = computed(() => rxStations.length)
const cellAt = (ti, ri) => links.value.find((l) => l.ti === ti && l.ri === ri)
// 站表只读列：发信站 EIRP / 收信站 G/T —— 实时计算（输入变化即更新，无需点「计算」）。
// 每个发信站配参考收信站(首站)、每个收信站配参考发信站(首站)，按「设置余量」单算一次取引擎结果。
const txEirp = ref({})
const rxGt = ref({})
let _roT = null
let _suppressRO = false   // 刷新编排期间静默 watcher，避免表单/站点回填触发的重复扇出
async function refreshReadonly() {
  if (!api || !txStations.length || !rxStations.length) { txEirp.value = {}; rxGt.value = {}; return }
  // EIRP 用当前计算方式（与主计算/小程序一致，否则功带平衡等模式下解出的功率不同 → EIRP 对不上）
  const opt = { mode: calcMode.value, powerW: targetPowerW.value, overDb: overDb.value }
  // G/T 只与收信站天线/噪温有关，与余量/计算方式无关 → 固定走最便宜的「设置余量」单算，避免在
  // 功带平衡/超发模式下对每个收信站白跑数百次二分搜索。
  const gtOpt = { mode: 'margin' }
  const rx0 = rxStations[0], tx0 = txStations[0]
  const te = {}, rg = {}
  // 只读列保留两位小数（无法解析则原样保留）
  const fix2 = (v) => { const n = parseFloat(v); return isNaN(n) ? v : n.toFixed(2) }
  // 工作点 EIRP/G-T 只读列用 NGSO 引擎球形闭式几何（轨道高度+最低仰角，快），无需时窗 SGP4——
  // 与主计算口径基本一致，仅几何取闭式近似，避免只读列每次都跑双站互视搜索。
  for (const tx of txStations) {
    try { const { satParams, linkParams } = buildParams(satForm, resolveBaseband(tx.basebandId).form, tx, rx0); linkParams.margin = targetMarginDb.value; const r = await api.linkBudget.computeModeNGSO(satParams, linkParams, opt); if (r && r.success) te[tx._id] = fix2(r.data.stationEIRPResult) } catch (e) { /* skip */ }
  }
  for (const rx of rxStations) {
    try { const { satParams, linkParams } = buildParams(satForm, resolveBaseband(tx0.basebandId).form, tx0, rx); linkParams.margin = targetMarginDb.value; const r = await api.linkBudget.computeModeNGSO(satParams, linkParams, gtOpt); if (r && r.success) rg[rx._id] = fix2(r.data.gOverTeResult) } catch (e) { /* skip */ }
  }
  txEirp.value = te; rxGt.value = rg
}
function scheduleReadonly() { if (_suppressRO) return; clearTimeout(_roT); _roT = setTimeout(refreshReadonly, 350) }
watch([satForm, basebandConfigs, txStations, rxStations, calcMode, targetPowerW, overDb, targetMarginDb], scheduleReadonly, { deep: true })

// —— GRD 卫星树 + 天线匹配（Phase 3）——
// 卫星树来自「星座3D」页持久化（localStorage globe3d/settings.grd，同源共享）。选星后给
// 「卫星EIRP / 卫星G/T」各匹配一个天线：按每个收/发信站的经纬度取该天线多波束的【最大 Parameter】，
// 回填收信站「卫星EIRP」(rxEIRP) 与发信站「卫星G/T」(G_Ts)。站经纬度/匹配天线变化即重算。
const satTreeState = loadSatTree()
const satTree = ref(satTreeState.sats)
let grdCfgs = satTreeState.cfgs
const grdSel = reactive({ satFolder: '', eirpKey: '', gtKey: '' })
const grdSat = computed(() => satTree.value.find((s) => s.folder === grdSel.satFolder) || null)
const antByKey = (key) => {
  if (!key || !grdSat.value) return null
  const name = key.split('|')[1]
  const a = grdSat.value.antennas.find((x) => x.name === name)
  return a ? { node: grdSat.value, ant: a, cfg: grdCfgs[key] } : null
}
// 记录每个站上一次「自动回填」的 EIRP/G·T 值（键 = 站 _id）——用于区分自动值与用户手改值：
// 当前单元格 === 记录值 → 仍为自动，主计算会按该行 t* 逐链路精确重采覆盖；不等 → 用户手改，保留其值。
const grdAutoFilled = { eirp: {}, gt: {} }

// —— NGSO 卫星几何来源 ——
// mode: 'manual'（手动填轨道高度/倾角）| 'tree'（天线树导入的星，可导入 EIRP/GT + 轨道）| 'search'（搜索卫星，仅轨道根数，不导 EIRP/GT）
// orbit: 主进程 buildSatrec 的 spec（tree/search 且带轨道根数时非空）。选星后轨道高度/倾角只读「自动」。
const ngsoSat = reactive({ mode: 'manual', orbit: null, name: '', noradId: null })
const satSelected = computed(() => ngsoSat.mode !== 'manual' && !!ngsoSat.orbit)
// 互视最差几何的搜索时窗（小时），可配 6/12/24/72
const geoHorizonHours = ref(Number(localStorage.getItem('ngso/horizonHours')) || 24)
watch(geoHorizonHours, (v) => { try { localStorage.setItem('ngso/horizonHours', String(v)) } catch (e) { /* ignore */ } })

// 天线树节点 → 轨道 spec（异步，可能要联网反解 NORAD）。按 node.kind 分派，**只有真·静止星才走 GEO 静态几何**：
//   ① 节点带 NORAD（kind:'linked'）→ 到「搜索卫星」同一份共享候选池（findPoolByNorad）反解真实轨道根数——
//      树导入与搜索读同一份池，同一颗星两处几何一致。查不到（离线/不在 active 目录）→ 报因，不伪造 GEO。
//   ② 节点自带 OMM / 经典六根数（kind:'orbit'）→ 直接用真实轨道；
//   ③ 仅星下点快照：**只有 GEO 预置星('preset')与用户手放的固定点('custom')**才按真实星下点经纬高做静止几何
//      （这两类本就无轨道运动，静止几何是正确口径）；对「本应在动」的星绝不默认 GEO 静止解。
async function treeNodeOrbit(node) {
  if (!node) return null
  const kind = node.kind || ''
  if (node.noradId != null) {
    const rec = await findPoolByNorad(node.noradId)
    if (rec) {
      if (rec.orbitType === 'elements' && rec.elements) {
        const e = rec.elements
        return { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
      }
      return { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
    }
    // 关联星但星历库暂时查不到——不静默按 GEO 静止星处理，明确报因
    return { type: 'unresolved', noradId: node.noradId, reason: `关联星（NORAD ${node.noradId}）暂未在星历库解析到，无法确定其轨道（可能离线或本地缓存缺失）。请联网后在「搜索卫星」按 NORAD 重选，或改用手动轨道高度+倾角。` }
  }
  if (node.omm && node.omm.meanMotion) return Object.assign({ type: 'omm' }, node.omm)
  const el = node.elements
  if (el && el.altKm != null) {
    return { type: 'elements', altKm: Number(el.altKm), ecc: Number(el.ecc) || 0, incl: Number(el.incl) || 0, raan: Number(el.raan) || 0, argp: Number(el.argp) || 0, ma: Number(el.ma) || 0, epoch: node.epoch || null, noradId: node.noradId }
  }
  // 仅 GEO 预置星 / 用户固定点（无轨道运动）→ 真实星下点静止几何；kind 缺省（旧数据）也归此类兼容。
  if ((kind === 'preset' || kind === 'custom' || !kind) && node.altKm != null) {
    return { type: 'snapshot', lonDeg: Number(node.lon) || 0, latDeg: Number(node.lat) || 0, altKm: Number(node.altKm) || 0, noradId: node.noradId }
  }
  // 「本应在动」的星（linked/orbit）却拿不到轨道根数——报因而非默认 GEO 静止
  return { type: 'unresolved', noradId: node.noradId, reason: `卫星「${node.satName || node.folder}」缺少可用轨道根数，无法确定其轨道。请在「星座3D」页为其补充轨道根数（关联 NORAD 或填经典六根数），或改用手动轨道高度+倾角。` }
}
// 频段 → 上下行频率（GHz），供几何求解算多普勒
const upFreqGHz = () => parseFloat(satForm.centerFrequency) || 14.25
const dnFreqGHz = () => parseFloat(satForm.rxCenterFrequency) || 12.5

// 平均运动(rev/day) → 平均高度(km)：a=(μ/n²)^(1/3)，h≈a−Re（近圆轨道即圆轨道高度）
const _MU_G = 398600.4418, _RE_G = 6378.137
function altFromMeanMotion(revDay) {
  const n = (Number(revDay) || 0) * 2 * Math.PI / 86400
  if (!(n > 0)) return null
  return Math.cbrt(_MU_G / (n * n)) - _RE_G
}
// 天线树选星 → 记录轨道来源并回显轨道高度/倾角（只读「自动」）。异步：linked 星要联网按 NORAD 反解真实轨道。
async function applyTreeSatOrbit(node) {
  ngsoSat.mode = 'tree'; ngsoSat.orbit = null; ngsoSat.name = node.satName; ngsoSat.noradId = node.noradId || null
  satForm.satelliteName = node.satName
  const orbit = await treeNodeOrbit(node)
  ngsoSat.orbit = orbit
  if (orbit && orbit.type === 'elements') {
    if (orbit.altKm != null) satForm.orbitAltitude = String(Math.round(orbit.altKm))
    if (orbit.incl != null) satForm.orbitInclination = String(orbit.incl)
  } else if (orbit && orbit.type === 'omm') {
    const h = altFromMeanMotion(orbit.meanMotion); if (h != null) satForm.orbitAltitude = h.toFixed(0)
    if (orbit.incl != null) satForm.orbitInclination = String(orbit.incl)
  } else if (orbit && orbit.type === 'snapshot') {
    if (orbit.altKm != null) satForm.orbitAltitude = String(Math.round(orbit.altKm))
    satForm.orbitInclination = String(Math.abs(Number(orbit.latDeg) || 0).toFixed(2))
  }
}
// 搜索选星 → 仅轨道根数（不导 EIRP/GT），回显轨道高度/倾角。
// 两类记录：真实目录星（orbitType 'omm'，喂原始 OMM 根数走 SGP4）与本地自定义星座
// （orbitType 'elements'，经典六根数含偏心率/近地点幅角走 buildSatrec type:'elements'，
//  与星座3D 页 elementsToSatrec 完全同口径——HEO/椭圆几何因此精确）。
function pickSearchSat(rec) {
  ngsoSat.mode = 'search'; ngsoSat.name = rec.name; ngsoSat.noradId = rec.noradId || null
  if (rec.orbitType === 'elements' && rec.elements) {
    const e = rec.elements
    ngsoSat.orbit = { type: 'elements', altKm: Number(e.altKm) || 0, ecc: Number(e.ecc) || 0, incl: Number(e.incl) || 0, raan: Number(e.raan) || 0, argp: Number(e.argp) || 0, ma: Number(e.ma) || 0, epoch: rec.epoch || null, noradId: rec.noradId }
  } else {
    // 仅取 SGP4 所需 OMM 字段，剥离候选池的显示字段（apogeeKm/groupLabel/altName…）
    ngsoSat.orbit = { type: 'omm', name: rec.name, noradId: rec.noradId, epoch: rec.epoch, meanMotion: rec.meanMotion, ecc: rec.ecc, incl: rec.incl, raan: rec.raan, argp: rec.argp, ma: rec.ma, bstar: rec.bstar, mdot: rec.mdot, mddot: rec.mddot }
  }
  satForm.satelliteName = rec.name
  const h = altFromMeanMotion(rec.meanMotion); if (h != null) satForm.orbitAltitude = h.toFixed(0)
  if (rec.incl != null) satForm.orbitInclination = String(rec.incl)
  grdSel.satFolder = ''; grdSel.eirpKey = ''; grdSel.gtKey = ''   // 搜索模式不导入 EIRP/GT
}
function clearSatSelection() { ngsoSat.mode = 'manual'; ngsoSat.orbit = null; ngsoSat.name = ''; ngsoSat.noradId = null }

// 用平台 SGP4 精确几何覆盖引擎输出的几何量（斜距/仰角/方位/轨道高度/速度/多普勒/时延/周期），
// 确保结果几何一律取「本软件建模体系」的更精准值（轨道根数/最差时刻/互视窗口另由几何卡展示）。
const _C_KMS = 299792.458
function mergePlatformGeometry(d, geom) {
  const w = geom.worst, el = geom.elements
  d.slantRangeResult = w.up.slantKm.toFixed(2); d.rxSlantRangeResult = w.dn.slantKm.toFixed(2)
  d.elevationResult = w.up.elevDeg.toFixed(2); d.rxElevationResult = w.dn.elevDeg.toFixed(2)
  // 卫星高度：选星取典型时刻 t* 同一瞬间的高度（上下行相同）；手动圆轨道两站也相同
  if (w.up.altKm != null) d.orbitAltitudeUpResult = w.up.altKm.toFixed(1)
  if (w.dn.altKm != null) d.orbitAltitudeResult = w.dn.altKm.toFixed(1)
  if (w.speedInertialKmS != null) { d.orbitVelocityResult = w.speedInertialKmS.toFixed(3); d.orbitVelocityUpResult = d.orbitVelocityResult }
  if (w.speedGroundRelKmS != null) { d.groundRelVelResult = w.speedGroundRelKmS.toFixed(3); d.groundRelVelUpResult = d.groundRelVelResult }
  if (w.maxDopplerUpHz != null) d.maxDopplerUplinkResult = (w.maxDopplerUpHz / 1000).toFixed(3)
  if (w.maxDopplerDnHz != null) d.maxDopplerDownlinkResult = (w.maxDopplerDnHz / 1000).toFixed(3)
  if (w.oneWayDelayMs != null) {
    d.linkDelayResult = w.oneWayDelayMs.toFixed(3)
    d.linkDelayUpResult = (w.up.slantKm / _C_KMS * 1000).toFixed(3)
    d.linkDelayDownResult = (w.dn.slantKm / _C_KMS * 1000).toFixed(3)
  }
  if (el && el.periodMin != null) { d.orbitPeriodUpResult = el.periodMin.toFixed(2); d.orbitPeriodDownResult = d.orbitPeriodUpResult }
  // 覆盖地心半角 / 地面覆盖半径 / 天顶过境最大时长——单一真值源（用卫星真实倾角，替代旧引擎里 50° 默认）
  // 常驻可见（GEO/严格 ω_s≈ω_E）→ ∞（语言中立，专业；与几何卡 gPass、Excel 几何表同口径）
  const fmtPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)
  if (w.up.coverageHalfAngleDeg != null) {
    d.coverageHalfAngleUpResult = w.up.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusUpResult = w.up.coverageRadiusKm.toFixed(1)
    d.maxPassDurationUpResult = fmtPass(w.up.maxPassMin)
  }
  if (w.dn.coverageHalfAngleDeg != null) {
    d.coverageHalfAngleDownResult = w.dn.coverageHalfAngleDeg.toFixed(2)
    d.coverageRadiusDownResult = w.dn.coverageRadiusKm.toFixed(1)
    d.maxPassDurationDownResult = fmtPass(w.dn.maxPassMin)
  }
}
let _grdT = null
// 搜索时窗起点 t0：统一锚到「计算此刻」的墙钟绝对时（与再生式模块同口径，不再锚场景/TLE 历元）。
// 卫星仍按 SGP4 从各自设计历元（elements=场景历元 / omm=该星自身历元）正推到此刻，同属墙钟系 → t* 仍是绝对时、
// 可与星座3D 星下点对表（见 geoHasTimes 上方注释）。传入批级 t0ISO 令同批各链路起点一致；未传则各自取此刻。
function searchT0ISO() { return new Date().toISOString() }
// 选星（tree/search，真实轨道根数）→ 平台 SGP4 双站互视最差几何。与主计算 compute() 的「选星分支」
// 同口径（均锚计算此刻墙钟·同时窗长），抽出复用：既供主计算逐链路求 t*，也供 refreshGrdFill 求「代表性 t* 星下点」。
// 手动圆轨道(circular)不走这里（无相位、无单一时刻，也不导入天线）；未选星返回 null。
async function solveSelectedGeom(tx, rx, t0ISO) {
  if (!api || !satSelected.value || !ngsoSat.orbit) return null
  const orbitSpec = JSON.parse(JSON.stringify(ngsoSat.orbit))
  return await api.linkBudget.ngsoGeometry({
    orbit: orbitSpec,
    tx: { lonDeg: parseFloat(tx.longitude), latDeg: parseFloat(tx.latitude), altKm: (parseFloat(tx.altitude) || 0) / 1000, minElevDeg: parseFloat(tx.minElevation) || 0, freqGHz: upFreqGHz() },
    rx: { lonDeg: parseFloat(rx.rxLongitude), latDeg: parseFloat(rx.rxLatitude), altKm: (parseFloat(rx.rxAltitude) || 0) / 1000, minElevDeg: parseFloat(rx.rxMinElevation) || 0, freqGHz: dnFreqGHz() },
    t0ISO: t0ISO || searchT0ISO(), horizonHours: geoHorizonHours.value
  })
}
// 回填前若本就「无未保存改动」，回填后把基线推进到回填结果——否则实时星/GRD 自动重算出
// 的新值（非用户操作）会被指纹判定为改动，弹出误报的「未保存，是否保存？」。
// 若回填前已有用户自己的改动（isDirty 为真），则不触碰基线，改动仍会被正确提示保存。
//
// 采样卫星位置口径：EIRP/G·T 反映「卫星在某位置时对地面站的天线增益」，随卫星移动而变。为与性能指标表
// 的最差工况一致，站表这一列取【主链路(首发×首收)的 t* 星下点】作为卫星位置采样（代表性显示值）；
// 主计算 compute() 再对每条链路各自的 t* 逐行精确重采（见其中的 override）。选星不可行/未选星 → 回退
// 天线快照位置（原行为）。用户手改过的单元格予以保留（不被自动值覆盖）。
async function refreshGrdFill() {
  const wasClean = !isDirty()
  // 主链路 t* 星下点作为代表性采样位置（一次几何求解，全站共用；批量 IPC 采样保持单次）
  let satOv = null
  if (satSelected.value && txStations.length && rxStations.length) {
    try { const g = await solveSelectedGeom(txStations[0], rxStations[0]); if (g && g.feasible && g.subSat) satOv = { lon: g.subSat.lonDeg, lat: g.subSat.latDeg, alt: g.subSat.altKm } } catch (e) { /* 回退快照位置 */ }
  }
  // 单元格是否被用户手改（相对上次自动值）——手改则保留，不覆盖
  const isManual = (map, id, cur) => map[id] != null && String(cur) !== String(map[id])
  // 卫星EIRP 天线 → 各收信站经纬度取最大 Parameter，回填 rxEIRP（一次 IPC 批量采样全部站点）
  const eirp = antByKey(grdSel.eirpKey)
  if (eirp && rxStations.length) {
    const pts = rxStations.map((rx) => ({ lon: parseFloat(rx.rxLongitude), lat: parseFloat(rx.rxLatitude) }))
    const vals = await sampleAntennaParams(eirp.node, eirp.ant, eirp.cfg, pts, satOv)
    rxStations.forEach((rx, i) => {
      if (!(vals && vals[i] != null) || isManual(grdAutoFilled.eirp, rx._id, rx.rxEIRP)) return
      rx.rxEIRP = String(vals[i]); grdAutoFilled.eirp[rx._id] = String(vals[i])
    })
  }
  // 卫星G/T 天线 → 各发信站经纬度取最大 Parameter，回填 G_Ts
  const gt = antByKey(grdSel.gtKey)
  if (gt && txStations.length) {
    const pts = txStations.map((tx) => ({ lon: parseFloat(tx.longitude), lat: parseFloat(tx.latitude) }))
    const vals = await sampleAntennaParams(gt.node, gt.ant, gt.cfg, pts, satOv)
    txStations.forEach((tx, i) => {
      if (!(vals && vals[i] != null) || isManual(grdAutoFilled.gt, tx._id, tx.G_Ts)) return
      tx.G_Ts = String(vals[i]); grdAutoFilled.gt[tx._id] = String(vals[i])
    })
  }
  if (wasClean) setBaseline()
}
function scheduleGrdFill() { clearTimeout(_grdT); _grdT = setTimeout(refreshGrdFill, 300) }
// 链路窗口为单例复用：每次切到「卫星」模块时刷新卫星树，纳入此后在「星座3D」新导入的 GRD 天线。
// 若当前选中的卫星/天线已不在新树中则清空选择。
async function reloadSatTree() {
  const wasClean = !isDirty()
  const t = loadSatTree(); satTree.value = t.sats; grdCfgs = t.cfgs
  const cur = satTree.value.find((s) => s.folder === grdSel.satFolder)
  if (grdSel.satFolder && !cur) { grdSel.satFolder = ''; grdSel.eirpKey = ''; grdSel.gtKey = ''; if (ngsoSat.mode === 'tree') { ngsoSat.mode = 'manual'; ngsoSat.orbit = null } }
  else if (cur && ngsoSat.mode === 'tree') { await applyTreeSatOrbit(cur) }   // 天线树导入的星：刷新时同步名称/轨道（取新位置）
  // 实时星取新位置是系统自动同步，不算用户改动；若之前本就无未保存改动，基线随之推进，
  // 避免仅仅切到「卫星」模块或点「刷新」就被指纹判定为「未保存」。
  if (wasClean) setBaseline()
}
watch(activeModule, (m) => { if (m === 'sat') reloadSatTree() })

// 顶栏「刷新」：重新拉取主窗口的最新设置（GRD 卫星树/各天线设置/实时星位 + 城市库/载波信号选项），并按最新数据重算
const refreshing = ref(false)
async function refreshLatest() {
  refreshing.value = true
  _suppressRO = true        // 抑制下方表单/站点回填触发的 watcher，整套扇出最后只跑一次
  clearTimeout(_roT)
  try {
    reloadSatTree()   // 重读 globe3d/settings.grd（树/天线 cfg）+ grdLive 实时位置（数据未变则复用缓存，不重解析 GRD）
    try { const c = api && await api.linkBudget.cities(); if (c) cities.value = c } catch (e) { /* keep */ }
    try { const b = api && await api.linkBudget.baseband(); if (b) basebandOpts.value = b } catch (e) { /* keep */ }
    try { await refreshGrdFill() } catch (e) { /* keep */ }   // 直接回填(跳过防抖)，确保 EIRP/G·T 就绪后再算
    _suppressRO = false
    clearTimeout(_roT)        // 丢弃抑制期间可能挂起的计时器
    await refreshReadonly()   // 守卫解除后只跑一遍扇出
    toast('已刷新最新设置')
  } finally { _suppressRO = false; refreshing.value = false }
}
// 匹配天线/站经纬度变化 → 重算回填。仅看站经纬度（避免回填值本身再触发循环）。
watch(() => [grdSel.eirpKey, grdSel.gtKey,
  txStations.map((t) => t.longitude + ',' + t.latitude).join(';'),
  rxStations.map((r) => r.rxLongitude + ',' + r.rxLatitude).join(';')],
  scheduleGrdFill)
const sel = computed(() => links.value[selected.value] || null)
// 核心结果卡片（照搬小程序）：取当前选中链路的完整结果
const core = computed(() => (sel.value && !sel.value.error ? sel.value.data : null))
// 平台精确几何（选星时由 SGP4 双站互视最差几何求得；含轨道根数 / 最差互视时刻 / 互视窗口）
const geom = computed(() => (sel.value ? sel.value.geom : null))
// 站星几何时标：UTC / 本地 / 北京 可切换（默认 UTC 对标 STK；本地取运行机时区；北京=UTC+8 便于国内核对）
const tzMode = ref('utc')   // 'utc' | 'local' | 'beijing'
// 几何卡片是否含时刻字段（仅选星耦合模式给出典型时刻/互视窗口），无则不显示时区切换
const geoHasTimes = computed(() => {
  const g = geom.value
  return !!(g && g.coupled && g.search && (g.search.typicalISO || g.search.mutualWindow))
})
// 典型时刻 t* 一律是墙钟绝对时，可直接对表：自定义星座（elements）几何锚在场景历元，得到 t*=场景历元+Δ 的绝对时刻，
// 而星座3D 已让合成星按墙钟从场景历元正向传播（此刻=真实当前时刻、非场景历元），二者同属墙钟系 → 把时间轴设到 t*
// 即与地图星下点吻合，和真实目录星完全一致，无需再做「自场景历元偏移」的换算（旧时间模型下才需要）。
// 本地时区标签：按运行机偏移给出 UTC±H(:MM)，随时刻旁的时区角标显示
function localOffsetLabel() {
  const off = -new Date().getTimezoneOffset()
  const sign = off >= 0 ? '+' : '−'
  const h = Math.floor(Math.abs(off) / 60)
  const m = Math.abs(off) % 60
  return 'UTC' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '')
}
// 时标角标：UTC→'UTCG'（对标 STK）、北京→'UTC+8'、本地→运行机偏移
const tzSuffix = computed(() => (tzMode.value === 'utc' ? 'UTCG' : tzMode.value === 'beijing' ? 'UTC+8' : localOffsetLabel()))
// 时刻格式化（STK UTCG 版式）：D Mon YYYY HH:MM:SS.mmm，按 mode 取 UTC / 本地 / 北京(UTC+8) 字段（时区由区头角标标注）
const UTCG_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function fmtInstant(iso, mode) {
  if (!iso) return '—'
  const d0 = new Date(iso)
  if (isNaN(d0.getTime())) return String(iso)
  const loc = mode === 'local'
  // 北京=UTC+8（无夏令时）：整体 +8h 后读 UTC 字段即得北京本地表示；UTC/本地不偏移
  const d = mode === 'beijing' ? new Date(d0.getTime() + 8 * 3600000) : d0
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const D = loc ? d.getDate() : d.getUTCDate()
  const MO = loc ? d.getMonth() : d.getUTCMonth()
  const Y = loc ? d.getFullYear() : d.getUTCFullYear()
  const H = loc ? d.getHours() : d.getUTCHours()
  const MI = loc ? d.getMinutes() : d.getUTCMinutes()
  const S = loc ? d.getSeconds() : d.getUTCSeconds()
  const MS = loc ? d.getMilliseconds() : d.getUTCMilliseconds()
  return `${D} ${UTCG_MON[MO]} ${Y} ${p(H)}:${p(MI)}:${p(S)}.${p(MS, 3)}`
}
// 互视窗口持续时长：min，≥60 折算 h
function fmtDur(min) {
  if (min == null || !isFinite(min)) return '—'
  return min >= 60 ? (min / 60).toFixed(2) + ' h' : min.toFixed(1) + ' min'
}
const g2 = (n, p = 2) => (n == null || !isFinite(n)) ? '—' : Number(n).toFixed(p)
// 过境时长（几何卡）：GEO/常驻可见 → ∞（与瀑布 fmtPass、Excel 几何表同口径）
const gPass = (m) => (m == null || !isFinite(m)) ? '∞' : Number(m).toFixed(2)
const barW = (v) => { const n = parseFloat(v); return (isNaN(n) ? 0 : Math.min(100, Math.max(0, n))) + '%' }
const barClass = (v) => { const n = parseFloat(v); return n > 100 ? 'danger' : (n > 80 ? 'warn' : 'normal') }

// —— 容量汇总（独立模块）——
// 汇总本批次所有已成功计算的链路：总带宽 = Σ 各链路载波带宽；总容量 = Σ 各链路容量。
// 单链路容量 = 频谱效率 η(bps/Hz) × 载波带宽 B(kHz) = 容量(kbps)；各链路载波信号配置可不同（η 各异），
// 故逐链路相乘再求和，而非用单一 η 乘总带宽。engine 已按链路输出 allocBandwidthResult / spectralEfficiencyResult。
// capacityKbpsOf 是单链路口径的唯一出处：列表/矩阵「容量」指标、容量汇总都从这里换算。
function capacityKbpsOf(d) {
  if (!d) return NaN
  const bw = parseFloat(d.allocBandwidthResult)       // 载波带宽 kHz
  const eta = parseFloat(d.spectralEfficiencyResult)  // 频谱效率 bps/Hz
  return (isFinite(bw) && isFinite(eta)) ? eta * bw : NaN   // 容量 kbps
}
const capacitySummary = computed(() => {
  const done = links.value.filter((l) => l && l.data && !l.error)
  let bwKHz = 0, capKbps = 0
  for (const l of done) {
    const bw = parseFloat(l.data.allocBandwidthResult)
    if (isFinite(bw)) bwKHz += bw
    const kbps = capacityKbpsOf(l.data)
    if (isFinite(kbps)) capKbps += kbps
  }
  return {
    count: done.length,
    failed: links.value.length - done.length,
    bwKHz, capKbps,
    avgEff: bwKHz > 0 ? capKbps / bwKHz : 0   // 带宽加权平均频谱效率 bps/Hz
  }
})
// 自适应单位：容量 kbps→Mbps→Gbps；带宽 kHz→MHz→GHz
function fmtCapacity(kbps) {
  const n = Number(kbps)
  if (!isFinite(n) || n <= 0) return { v: '0', u: 'kbps' }
  if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'Gbps' }
  if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'Mbps' }
  return { v: n.toFixed(n >= 100 ? 1 : 2), u: 'kbps' }
}
function fmtBandwidth(khz) {
  const n = Number(khz)
  if (!isFinite(n) || n <= 0) return { v: '0', u: 'kHz' }
  if (n >= 1e6) return { v: (n / 1e6).toFixed(3), u: 'GHz' }
  if (n >= 1e3) return { v: (n / 1e3).toFixed(3), u: 'MHz' }
  return { v: n.toFixed(n >= 100 ? 1 : 3), u: 'kHz' }
}
const capMain = computed(() => fmtCapacity(capacitySummary.value.capKbps))
const bwMain = computed(() => fmtBandwidth(capacitySummary.value.bwKHz))

async function compute() {
  if (!api) { error.value = '引擎需在 Electron 中运行（npm run dev）'; return }
  if (!txStations.length || !rxStations.length) { error.value = '请至少各添加一个发信站和收信站'; return }
  computing.value = true; error.value = ''
  try {
    const mode = calcMode.value
    const opt = { mode, powerW: targetPowerW.value, overDb: overDb.value }
    const out = []
    // 链路配对集合：常规计算按序号 1↔1（min(发,收) 条）；矩阵计算 m×n 全配对
    const pairs = []
    if (linkPairMode.value === 'sequential') {
      const n = Math.min(txStations.length, rxStations.length)
      for (let i = 0; i < n; i++) pairs.push([i, i])
    } else {
      for (let ti = 0; ti < txStations.length; ti++) for (let ri = 0; ri < rxStations.length; ri++) pairs.push([ti, ri])
    }
    const geomT0ISO = searchT0ISO()   // 本批统一搜索时窗起点：计算此刻墙钟（同批各链路 t0 一致）
    for (const [ti, ri] of pairs) {
      const tx = txStations[ti], rx = rxStations[ri]
      const bbForm = resolveBaseband(tx.basebandId).form
      const { satParams, linkParams } = buildParams(satForm, bbForm, tx, rx)
      linkParams.margin = targetMarginDb.value   // 系统余量是批量目标值，不随载波信号配置走
      const txName = tx.earthStationLocation || ('发' + (ti + 1))
      const rxName = rx.rxEarthStationLocation || ('收' + (ri + 1))

      // —— 几何：选星→平台 SGP4 互视窗内【多候选几何】(两端+内部+几何t*)，逐候选跑真实链路预算取“余量最差”者；
      //    未选星→引擎球形闭式（单候选）。要点：几何最差(仰角)≠链路最差——弯管总 C/N=1/(1/CNup+1/CNdn)
      //    被【弱侧】主导，t* 仅按“仰角和最小”选一个窗口边缘，会漏掉“瓶颈站压最低仰角”的另一边缘工况；
      //    故遍历候选、按当前计算方式取最差（见 ngsoGeometry.coupledTypicalMoment 返回的 candidates）。
      let geom = null, candList = null
      if (satSelected.value) {
        // 选星→平台 SGP4 双站互视（t0/时窗口径见 solveSelectedGeom：统一锚计算此刻墙钟、与再生式同口径）。
        geom = await solveSelectedGeom(tx, rx, geomT0ISO)
        if (!(geom && geom.feasible)) {
          // 时窗内两站不同时可见：本条链路单星无法建链
          out.push({ ti, ri, txName, rxName, data: null, margin: '—', metric: '—', error: (geom && geom.reason) || '两站不互视', geom })
          continue
        }
        candList = (geom.candidates && geom.candidates.length) ? geom.candidates : [geom]
      } else {
        // 手动模式：虚拟圆轨道（轨道高度+倾角）→ 球形闭式最差几何（单候选，每站各自最低仰角，无 subSat）。
        // 每站按自身最低仰角取最差斜距；带上站址纬度 → 闭式判「纬度 vs 倾角」可见性（如赤道轨道看不到高纬站）。
        geom = await api.linkBudget.ngsoGeometry({
          orbit: { type: 'circular', altKm: parseFloat(satForm.orbitAltitude) || 0, inclDeg: parseFloat(satForm.orbitInclination) || 0 },
          tx: { latDeg: parseFloat(tx.latitude), minElevDeg: parseFloat(tx.minElevation) || 0, freqGHz: upFreqGHz() },
          rx: { latDeg: parseFloat(rx.rxLatitude), minElevDeg: parseFloat(rx.rxMinElevation) || 0, freqGHz: dnFreqGHz() }
        })
        if (!(geom && geom.feasible)) {
          // 手动几何不可行（轨道高度≤0 / 站址纬度超出轨道覆盖带）→ 明确报错，不再用兜底假高度静默算出误导结果
          out.push({ ti, ri, txName, rxName, data: null, margin: '—', metric: '—', error: (geom && geom.reason) || '手动轨道几何不可行', geom })
          continue
        }
        candList = [geom]
      }

      // 卫星 EIRP/G·T 随星下点变——按【给定候选】星下点重采增益写入该候选的 linkParams 副本；
      // 仅覆盖仍为「自动值」的单元格，用户手改过的（当前值≠上次自动值）保留其值；无 subSat（手动圆轨道）不采。
      const resampleAntennas = async (lp, subSat) => {
        if (!subSat) return
        const satOv = { lon: subSat.lonDeg, lat: subSat.latDeg, alt: subSat.altKm }
        const eirpAnt = antByKey(grdSel.eirpKey)
        if (eirpAnt && !(grdAutoFilled.eirp[rx._id] != null && String(rx.rxEIRP) !== String(grdAutoFilled.eirp[rx._id]))) {
          const v = await sampleAntennaParam(eirpAnt.node, eirpAnt.ant, eirpAnt.cfg, parseFloat(rx.rxLongitude), parseFloat(rx.rxLatitude), satOv)
          if (v != null) lp.rxEIRP = String(v)
        }
        const gtAnt = antByKey(grdSel.gtKey)
        if (gtAnt && !(grdAutoFilled.gt[tx._id] != null && String(tx.G_Ts) !== String(grdAutoFilled.gt[tx._id]))) {
          const v = await sampleAntennaParam(gtAnt.node, gtAnt.ant, gtAnt.cfg, parseFloat(tx.longitude), parseFloat(tx.latitude), satOv)
          if (v != null) lp.G_Ts = String(v)
        }
      }

      // 逐候选选“链路最差”几何。要点：本 NGSO 引擎是“给定余量→反解功放”的模型，达成余量被钉在目标值、
      //   对几何不敏感；几何只体现为【所需资源】，且上下行是两套口径——上行受限=所需功放(paDb)随上行 FSL 增，
      //   下行受限=转发器功率占用(pUse)随下行 FSL 增，二者在互视窗两端各自达峰。故：
      //   ① 排序统一用 margin 口径（最差几何=需资源最多者，与显示口径无关）跑各候选，顺带取达成上/下行 C/N；
      //   ② 瓶颈侧 = 全窗口【平均达成 C/N 更低】的一侧（弱侧主导总 C/N；取均值稳，不受 t* 落哪端影响）；
      //   ③ 越大越差：下行瓶颈看 pUse、上行瓶颈看 paDb（各自单调于该侧 FSL＋星下点增益，已 Node 双向验证）；
      //   ④ 最差候选再按用户当前计算方式出最终结果。单候选（手动圆轨道/快照星）直接算，跳过排序。
      let worstCand = null, worstLp = null, worstData = null
      if (candList.length === 1) {
        worstCand = candList[0]
        worstLp = Object.assign({}, linkParams)
        worstLp.distanceMode = 'slantRange'; worstLp.slantRange = worstCand.worst.up.slantKm; worstLp.minElevation = worstCand.worst.up.elevDeg
        worstLp.rxDistanceMode = 'slantRange'; worstLp.rxSlantRange = worstCand.worst.dn.slantKm; worstLp.rxMinElevation = worstCand.worst.dn.elevDeg
        await resampleAntennas(worstLp, worstCand.subSat)
      } else {
        const rankOpt = { mode: 'margin' }
        const rows = []
        for (const cand of candList) {
          const lp = Object.assign({}, linkParams)
          lp.distanceMode = 'slantRange'; lp.slantRange = cand.worst.up.slantKm; lp.minElevation = cand.worst.up.elevDeg
          lp.rxDistanceMode = 'slantRange'; lp.rxSlantRange = cand.worst.dn.slantKm; lp.rxMinElevation = cand.worst.dn.elevDeg
          await resampleAntennas(lp, cand.subSat)
          const rr = await api.linkBudget.computeModeNGSO(satParams, lp, rankOpt)
          if (!(rr && rr.success)) continue
          const dd = rr.data
          rows.push({ cand, lp, data: dd, paDb: parseFloat(dd.paRecommendationdBResult), pUse: parseFloat(dd.powerUsageRatio), upCN: parseFloat(dd.uplinkCN), dnCN: parseFloat(dd.downlinkCN) })
        }
        if (!rows.length) { out.push({ ti, ri, txName, rxName, data: null, margin: '—', metric: '—', error: '链路预算计算失败', geom }); continue }
        const meanOf = (f) => rows.reduce((s, x) => s + (isFinite(f(x)) ? f(x) : 0), 0) / rows.length
        const bottleneck = meanOf((x) => x.dnCN) < meanOf((x) => x.upCN) ? 'down' : 'up'
        const badnessOf = (x) => bottleneck === 'down' ? (isFinite(x.pUse) ? x.pUse : Infinity) : (isFinite(x.paDb) ? x.paDb : Infinity)
        let wr = rows[0]
        for (const x of rows) if (badnessOf(x) > badnessOf(wr)) wr = x
        worstCand = wr.cand; worstLp = wr.lp
        if (mode === 'margin') worstData = wr.data   // 用户口径即 margin → 直接复用排序结果，省一次计算
      }
      if (!worstData) {
        const r = await api.linkBudget.computeModeNGSO(satParams, worstLp, opt)
        if (!(r && r.success)) { out.push({ ti, ri, txName, rxName, data: null, margin: '—', metric: '—', error: (r && r.message) || '失败', geom }); continue }
        worstData = r.data
      }

      const d = worstData
      const worstGeom = worstCand
      mergePlatformGeometry(d, worstGeom)   // 报告“链路最差”候选的几何（斜距/星下点/时刻/时窗）
      const m = parseFloat(d.linkmargin)
      const pUse = parseFloat(d.powerUsageRatio); const bUse = parseFloat(d.bandwidthUsageRatio)
      // 合格判定：设置余量模式看资源是否够（功率/带宽占用 ≤100%）；其它模式看余量 ≥0
      const ok = mode === 'margin' ? (!(pUse > 100) && !(bUse > 100)) : (!isNaN(m) && m >= 0)
      out.push({
        ti, ri, txName, rxName, data: d, geom: worstGeom, margin: d.linkmargin, powerW: d.paRecommendation,
        metric: mode === 'margin' ? d.paRecommendation : d.linkmargin, ok,
        totalCN: d.carrierTotalCN, thresholdCN: d.thresholdCN, avail: d.systemAvailabilityResult
      })
    }
    resultMode.value = mode
    resultPairMode.value = linkPairMode.value
    links.value = out
    selected.value = 0
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
  segments.value = await api.linkBudget.waterfall({
    results: JSON.parse(JSON.stringify(l.data)), lang: 'zh', orbitType: 'NGSO',
    txLocation: String(l.txName || ''), rxLocation: String(l.rxName || '')
  })
}
function selectLink(ti, ri) {
  const idx = links.value.findIndex((l) => l.ti === ti && l.ri === ri)
  if (idx >= 0) { selected.value = idx; loadWaterfall() }
}

// —— 经纬度 → 降雨率/海拔自动填（与小程序一致；选址或改经纬度触发，逐站）——
// skip：粘贴/填充已显式带入的降雨/海拔列（整行复制场景），重算时跳过不覆盖
async function fillGeoRow(row, lonK, latK, rainK, elevK, skip) {
  if (!api) return
  const lat = parseFloat(row[latK]); const lon = parseFloat(row[lonK])
  if (isNaN(lat) || isNaN(lon)) return
  try {
    const g = await api.linkBudget.geoFill(lat, lon)
    if (!g) return
    if (g.rainRate !== null && g.rainRate !== undefined && !(skip && skip.has(rainK))) row[rainK] = String(g.rainRate)
    if (g.altitude !== null && g.altitude !== undefined && !(skip && skip.has(elevK))) row[elevK] = String(g.altitude)
  } catch (e) { /* 保留原值 */ }
}
// 城市关键词检索（城市名 / 省份 / 拼音缩写）——交给引擎 core.searchCities（与小程序口径一致）
const citySearch = (q) => (api ? api.linkBudget.searchCities(q) : Promise.resolve([]))
const autoGeoTx = (row, skip) => fillGeoRow(row, 'longitude', 'latitude', 'rainRate', 'altitude', skip)
const autoGeoRx = (row, skip) => fillGeoRow(row, 'rxLongitude', 'rxLatitude', 'rxRainRate', 'rxAltitude', skip)

// —— Phase 4：配置持久化（含卫星 / EIRP·GT 天线匹配选择）——
// ① 整盘工作台状态序列化（卫星/载波信号参数、发收信站群、计算方式、GRD 匹配选择、矩阵显示）。
// ② 自动保存「上次会话」到 localStorage：关掉再开窗口即原样恢复（卫星/天线选择不丢）。
// ③ 命名配置（配置列表）走 store.config.* 持久化到 userData/configs.json，可多套切换。
const STATE_KEY = 'ngso/last'
const notice = ref('')
let _noticeT = null
function toast(msg) { notice.value = msg; clearTimeout(_noticeT); _noticeT = setTimeout(() => (notice.value = ''), 4000) }

function serializeState() {
  return {
    orbitType: 'NGSO',   // 标记轨道体制：NGSO 窗口配置列表按此过滤，避免与 GEO 配置串号
    satForm: { ...satForm },
    basebandConfigs: basebandConfigs.map((c) => ({ id: c.id, name: c.name, form: { ...c.form } })),
    tx: txStations.map(({ _id, ...r }) => r), rx: rxStations.map(({ _id, ...r }) => r),
    calcMode: calcMode.value, targetPowerW: targetPowerW.value, overDb: overDb.value, targetMarginDb: targetMarginDb.value,
    linkPairMode: linkPairMode.value,
    grdSel: { ...grdSel }, ngsoSat: { mode: ngsoSat.mode, orbit: ngsoSat.orbit ? JSON.parse(JSON.stringify(ngsoSat.orbit)) : null, name: ngsoSat.name, noradId: ngsoSat.noradId },
    geoHorizonHours: geoHorizonHours.value, metricKey: metricKey.value, activeModule: activeModule.value
  }
}
function applyState(st) {
  if (!st || typeof st !== 'object') return
  if (st.satForm) Object.assign(satForm, st.satForm)
  if (Array.isArray(st.basebandConfigs) && st.basebandConfigs.length) {
    basebandConfigs.splice(0, basebandConfigs.length, ...st.basebandConfigs.map((c) => ({
      id: c.id || ('bb' + (_bbSeq++)), name: c.name || '配置',
      form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, ...c.form }
    })))
  } else if (st.carrierForm) {
    // 旧版单一载波信号表单（升级前保存的配置）：包成一份「默认」配置迁移
    basebandConfigs.splice(0, basebandConfigs.length, {
      id: 'bb' + (_bbSeq++), name: '默认',
      form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1, ...st.carrierForm }
    })
  }
  // 回填字段默认：旧配置缺某个（后加的）字段 → 显示其默认值（与基带库/再生式一致），空格不再算出界面上没有的数；
  // 已保存的显式空值('')仍覆盖默认 → 用户手动清空的格子保持空（不被默认回填）。
  if (Array.isArray(st.tx) && st.tx.length) txStations.splice(0, txStations.length, ...st.tx.map((r) => ({ ...defaultsFor(TX_FIELDS), ...r, _id: 's' + (_sid++) })))
  if (Array.isArray(st.rx) && st.rx.length) rxStations.splice(0, rxStations.length, ...st.rx.map((r) => ({ ...defaultsFor(RX_FIELDS), ...r, _id: 's' + (_sid++) })))
  if (st.calcMode) calcMode.value = st.calcMode
  if (st.targetPowerW != null) targetPowerW.value = st.targetPowerW
  if (st.overDb != null) overDb.value = st.overDb
  // 系统余量：新字段优先；否则从旧存档兜底取（曾短暂挂在 carrierForm.margin / 载波信号配置卡片里）
  if (st.targetMarginDb != null) targetMarginDb.value = st.targetMarginDb
  else if (st.carrierForm && st.carrierForm.margin != null) targetMarginDb.value = st.carrierForm.margin
  else if (basebandConfigs[0] && basebandConfigs[0].form.margin != null) targetMarginDb.value = basebandConfigs[0].form.margin
  if (st.linkPairMode) linkPairMode.value = st.linkPairMode
  if (st.geoHorizonHours != null) geoHorizonHours.value = Number(st.geoHorizonHours) || 24
  if (st.ngsoSat) { ngsoSat.mode = st.ngsoSat.mode || 'manual'; ngsoSat.orbit = st.ngsoSat.orbit || null; ngsoSat.name = st.ngsoSat.name || ''; ngsoSat.noradId = st.ngsoSat.noradId || null }
  if (st.metricKey) metricKey.value = st.metricKey
  if (st.activeModule) activeModule.value = st.activeModule
  if (st.grdSel) Object.assign(grdSel, st.grdSel)   // 最后置入：触发 GRD 回填联动
}
let _stateT = null
// 「上次会话」存盘要带上 activeId：否则重开窗口时配置列表没有任何一项被聚焦，
// 但工作区却显示着上次的内容，看起来像是内容跟列表对不上号（用户反馈的困惑点）。
function scheduleSaveState() { clearTimeout(_stateT); _stateT = setTimeout(() => { try { localStorage.setItem(STATE_KEY, JSON.stringify({ ...serializeState(), activeId: activeId.value })) } catch (e) { /* 配额满等忽略 */ } }, 600) }
watch([satForm, basebandConfigs, txStations, rxStations, calcMode, targetPowerW, overDb, targetMarginDb, linkPairMode, grdSel, metricKey, activeModule, activeId], scheduleSaveState, { deep: true })

// —— 命名配置 CRUD ——
// 注意：Electron 不支持 window.prompt（静默返回 null → 之前「保存不了」的根因）。改用应用内命名弹窗。
// 与 GEO 共用 configs.json：按体制过滤——文件夹按顶层 orbitType，配置按 state.orbitType。
// 关键：文件夹项无 state，必须按 type 判定，否则旧的「c.state.orbitType」过滤会把 NGSO 文件夹全滤掉。
async function loadConfigs() {
  try {
    const all = (api && await api.store.listConfigs()) || []
    configs.value = all.filter((it) => it && ((it.type === 'folder') ? (it.orbitType === 'NGSO') : (it.state && it.state.orbitType === 'NGSO')))
  } catch (e) { configs.value = [] }
  pruneExpanded()
}
// 剪除已不存在的文件夹 id，防展开集无限膨胀
function pruneExpanded() {
  const ids = new Set(configs.value.filter((c) => c.type === 'folder').map((c) => c.id))
  let changed = false
  for (const id of [...expandedFolders.value]) if (!ids.has(id)) { expandedFolders.value.delete(id); changed = true }
  if (changed) persistExpanded()
}
function defaultCfgName() { return (satForm.satelliteName ? satForm.satelliteName + ' ' : '') + `链路 ${nTx.value}×${nRx.value}` }
// 命名弹窗：保存为新配置
const cfgDlg = reactive({ open: false, name: '' })
function openSaveDlg() { if (!api) { toast('保存需在 Electron 中运行'); return } cfgDlg.name = defaultCfgName(); cfgDlg.open = true }
async function confirmCfgDlg() {
  const name = (cfgDlg.name || '').trim()
  if (!name) { toast('请输入配置名称'); return }
  const item = await api.store.saveConfig({ name, state: serializeState() })
  cfgDlg.open = false; await loadConfigs(); if (item && item.id) { activeId.value = item.id; setBaseline() }
  toast('已保存配置：' + name)
}
// 双击配置 → 原地改名（行内输入框）
const editing = reactive({ id: null, name: '' })
function startRename(c) {
  editing.id = c.id; editing.name = c.name
  nextTick(() => { const el = document.querySelector('.lb-tree-rename'); if (el) { el.focus(); el.select() } })
}
function cancelRename() { editing.id = null }
async function commitRename() {
  const id = editing.id; if (id == null) return
  const c = configs.value.find((x) => x.id === id)
  const nm = (editing.name || '').trim()
  editing.id = null
  // 只传 { id, name }：saveConfig 做 merge，既不动 state/parentId，又对文件夹（无 state）通用，且规避 Proxy 克隆报错
  if (c && nm && nm !== c.name) { await api.store.saveConfig({ id: c.id, name: nm }); await loadConfigs(); toast('已改名：' + nm) }
}
async function updateConfig() {
  if (!api || !activeId.value) return
  const c = configs.value.find((x) => x.id === activeId.value); if (!c) return
  await api.store.saveConfig({ id: c.id, name: c.name, state: serializeState() })
  setBaseline()
  await loadConfigs(); toast('已保存修改到：' + c.name)
}
// 存盘按钮：有当前配置则更新，否则保存为新（两个按钮都能把现有配置存下来）
async function saveCurrent() {
  if (!api) { toast('保存需在 Electron 中运行'); return }
  if (activeId.value) await updateConfig()
  else openSaveDlg()
}
// 点击配置 = 载入到工作台编辑（设为当前；随后改参数 + 点存盘即保存回该配置）。静默载入。
function applyConfig(c) { if (!c) return; activeId.value = c.id; applyState(c.state); setBaseline() }
// 守卫式选择：从已改动的现有配置离开前提示是否保存
async function selectConfig(c) {
  if (!c || c.id === activeId.value) return
  if (!(await guardedLeave())) return
  applyConfig(c)
}
async function removeConfig(id, e) {
  if (e) e.stopPropagation()
  if (!api) return
  await api.store.deleteConfig(id)
  if (activeId.value === id) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && cfgClip.value.id === id) cfgClip.value = null
  await loadConfigs()
}

// —— 文件夹（分组）——
// 通用确认弹窗（Electron 渲染进程无原生 confirm）
const confirmDlg = reactive({ open: false, msg: '' })
let _confirmResolve = null
function askConfirm(msg) { confirmDlg.msg = msg; confirmDlg.open = true; return new Promise((res) => { _confirmResolve = res }) }
function answerConfirm(ok) { confirmDlg.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok) }
// 新建文件夹：parentId 为空=根，否则建在该文件夹下；建后自动展开并进入改名（orbitType 标 NGSO）
async function addFolder(parentId = null) {
  if (!api) { toast('需在 Electron 中运行'); return }
  const item = await api.store.saveConfig({ type: 'folder', name: uniqueCfgName('新建文件夹'), parentId: parentId || null, orbitType: 'NGSO' })
  if (parentId) { expandedFolders.value.add(parentId) }
  if (item && item.id) expandedFolders.value.add(item.id)
  persistExpanded()
  await loadConfigs()
  if (item && item.id) startRename(item)
}
// 拖拽/粘贴移动：纯元数据操作，不载入、不走 guardedLeave（parentId 不入指纹，脏态与 baseline 不受影响）
async function onMove(payload) {
  if (!api || !payload || !payload.dragId) return
  await api.store.moveItem({ id: payload.dragId, parentId: payload.parentId, anchorId: payload.anchorId, position: payload.position })
  if (payload.position === 'inside' && payload.parentId) { expandedFolders.value.add(payload.parentId); persistExpanded() }
  await loadConfigs()
}
// 删除文件夹（级联删子项）：非空先确认，并清掉受影响的 activeId/baseline/剪贴板/展开态
async function removeFolder(folder) {
  if (!api || !folder) return
  const hasChildren = configs.value.some((c) => c.parentId === folder.id)
  if (hasChildren && !(await askConfirm(`删除文件夹「${folder.name}」及其中全部子项？此操作不可撤销。`))) return
  const removed = (await api.store.deleteFolder(folder.id)) || [folder.id]
  const rset = new Set(removed)
  if (activeId.value && rset.has(activeId.value)) { activeId.value = null; activeBaseline = '' }
  if (cfgClip.value && rset.has(cfgClip.value.id)) cfgClip.value = null
  for (const id of removed) expandedFolders.value.delete(id)
  persistExpanded()
  await loadConfigs()
  toast('已删除文件夹：' + folder.name)
}
// 列表项删除分发：文件夹级联删除，配置单删
function onDeleteItem(item) { if (!item) return; if (item.type === 'folder') removeFolder(item); else removeConfig(item.id) }
// 默认（空白）配置内容
function blankState() {
  return {
    orbitType: 'NGSO',
    satForm: defaultsFor(SAT_FIELDS),
    basebandConfigs: [{ name: '默认', form: { ...defaultsFor(CARRIER_FIELDS), rsCodeMode: 'fraction', dvbStandard: 'custom', modcodIndex: -1 } }],
    tx: [defaultsFor(TX_FIELDS)], rx: [defaultsFor(RX_FIELDS)],
    calcMode: 'margin', targetPowerW: '', overDb: '0', targetMarginDb: '3.00', linkPairMode: 'sequential',
    grdSel: { satFolder: '', eirpKey: '', gtKey: '' }, ngsoSat: { mode: 'manual', orbit: null, name: '', noradId: null },
    geoHorizonHours: 24, metricKey: 'auto', activeModule: 'tx'
  }
}
function uniqueCfgName(base) {
  const names = new Set(configs.value.map((c) => c.name))
  if (!names.has(base)) return base
  let i = 2; while (names.has(base + ' ' + i)) i++; return base + ' ' + i
}
// ＋ / 右键「添加空白配置」：新建一份默认参数配置并载入（parentId 非空=建在该文件夹内）
async function addBlankConfig(parentId = null) {
  if (!api) { toast('需在 Electron 中运行'); return }
  if (!(await guardedLeave())) return
  const state = blankState()
  const item = await api.store.saveConfig({ name: uniqueCfgName('新配置'), state, parentId: parentId || null })
  if (parentId) { expandedFolders.value.add(parentId); persistExpanded() }
  await loadConfigs()
  if (item && item.id) { activeId.value = item.id; applyState(state); setBaseline() }
  toast('已添加空白配置')
}

// —— 配置 复制 / 剪切 / 粘贴（含 Ctrl+C/X/V）——
// 剪贴板仅对「配置」（文件夹的移动/归并走拖拽或右键「粘贴到此文件夹」）——文件夹无 state，克隆会炸。
const cfgClip = shallowRef(null)   // { mode:'copy'|'cut', id, name, state }；shallowRef 避免 state 被再代理
function copyConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'copy', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已复制：' + c.name) }
function cutConfig(c) { if (!c || c.type === 'folder') return; cfgClip.value = { mode: 'cut', id: c.id, name: c.name, state: JSON.parse(JSON.stringify(c.state)) }; toast('已剪切：' + c.name + '（粘贴以换位置）') }
// 粘贴：复制=生成副本；剪切=移动原配置。into=true 且目标是文件夹 → 放入其内；否则放到目标之后；无目标=根末尾。
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
  await loadConfigs()
  toast('已粘贴')
}
// 配置面板内的 Ctrl+C/X/V（作用于当前聚焦配置；编辑/输入框中不拦截）
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

// —— 右键菜单 ——
const ctxMenu = reactive({ open: false, x: 0, y: 0, configId: null })
const ctxConfig = computed(() => (ctxMenu.configId ? configs.value.find((c) => c.id === ctxMenu.configId) : null))
const ctxIsFolder = computed(() => !!(ctxConfig.value && ctxConfig.value.type === 'folder'))
function openCtx(e, c) {
  e.preventDefault()
  ctxMenu.configId = c ? c.id : null
  ctxMenu.x = Math.min(e.clientX, window.innerWidth - 170)   // 防止贴右/下边溢出
  ctxMenu.y = Math.min(e.clientY, window.innerHeight - 230)
  ctxMenu.open = true
}
function ctxDo(fn) { ctxMenu.open = false; fn() }
// 导入一批分享来的配置（[{name,state}]）→ 各存为新配置；末条载入工作台
async function importConfigs(items) {
  if (!api) { toast('导入需在 Electron 中运行'); return 0 }
  let last = null
  for (const it of items) {
    // 深拷成纯对象：收件箱来的 it.state 是 Vue 响应式 Proxy，直接经 IPC 传给 saveConfig 会报「An object could not be cloned」
    const state = JSON.parse(JSON.stringify(it.state))
    const r = await api.store.saveConfig({ name: it.name || '导入配置', state })
    if (r) last = { item: r, state }
  }
  await loadConfigs()
  if (last) { if (last.item.id) activeId.value = last.item.id; applyState(last.state); setBaseline() }
  toast(items.length > 1 ? `已导入 ${items.length} 个配置` : ('已导入配置：' + (items[0] && items[0].name || '')))
  return items.length
}

// —— 改动检测 + 离开提示 + 恢复默认 ——
// 指纹只取「配置内容」字段（不含 activeModule/metricKey 等视图态），避免切模块/换矩阵指标误判为改动。
function fingerprintOf(s) {
  return stableStringify({ satForm: s.satForm, basebandConfigs: s.basebandConfigs, tx: s.tx, rx: s.rx, calcMode: s.calcMode, targetPowerW: s.targetPowerW, overDb: s.overDb, targetMarginDb: s.targetMarginDb, linkPairMode: s.linkPairMode, grdSel: s.grdSel })
}
function fingerprint() { return fingerprintOf(serializeState()) }
let activeBaseline = ''
function setBaseline() { activeBaseline = fingerprint() }
function isDirty() { return !!activeId.value && fingerprint() !== activeBaseline }
function activeName() { const c = configs.value.find((x) => x.id === activeId.value); return c ? c.name : '' }
// 离开当前（已改动的）配置前的三选一提示，返回是否可继续
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

// —— 配置分享（线下：分享码 / 文件；线上：按用户ID 走 COS 信箱）——
const deviceId = ref('')   // 本机用户ID（按 MAC 派生；管理员机器由主进程硬编码为 master1/2/3，不可改）
const shareConfigured = ref(false)
const shareDlg = reactive({ open: false, tab: 'offline', code: '', recip: '', sending: false, loadingInbox: false, inbox: [], inboxMsg: '' })
// 分享对象数组：当前聚焦的配置；没有则当前工作参数
function shareItems() {
  const c = activeId.value && configs.value.find((x) => x.id === activeId.value)
  return [c ? { name: c.name, state: c.state } : { name: defaultCfgName(), state: serializeState() }]
}
function shareLabel(items) { const n = (items || shareItems()).length; return n > 1 ? `${n} 个配置` : ((items || shareItems())[0].name) }
function openShareDlg() { const items = shareItems(); shareDlg.code = encodeShare(items); shareDlg.recip = ''; shareDlg.open = true }
async function copyShareCode() {
  try { await navigator.clipboard.writeText(shareDlg.code); toast('分享码已复制，可发给对方') }
  catch (e) { toast('复制失败，请手动选择文本复制') }
}
async function exportConfigFile() {
  if (!api) return
  const items = shareItems()
  const r = await api.exportFile({ defaultName: (shareLabel(items) || '配置').replace(/[\\/:*?"<>|]/g, '_') + '.lbcfg', data: configFileText(items), filters: [{ name: '链路预算配置', extensions: ['lbcfg', 'json'] }] })
  if (r && r.ok) toast('已导出配置文件：' + r.filePath)
  else if (r && !r.canceled) toast('导出失败：' + (r.error || ''))
}
const importText = ref('')
async function importFromCode() {
  try { const items = decodeShare(importText.value); await importConfigs(items); shareDlg.open = false; importText.value = '' }
  catch (e) { toast('解析失败：' + (e.message || e)) }
}
async function importFromClipboard() {
  try { importText.value = await navigator.clipboard.readText() } catch (e) { /* 用户手动粘贴 */ }
  if (importText.value) importFromCode()
}
async function importConfigFile() {
  if (!api) return
  const r = await api.linkBudget.openConfig()
  if (!r || r.canceled) return
  if (!r.ok) { toast('读取失败：' + (r.error || '')); return }
  try { const items = decodeShare(r.text); await importConfigs(items); shareDlg.open = false }
  catch (e) { toast('解析失败：' + (e.message || e)) }
}
// 线上：发送给对方用户ID（可一次发多个）
async function sendOnline() {
  if (!api || !shareConfigured.value) { toast('在线分享未配置'); return }
  const rid = (shareDlg.recip || '').trim()
  if (!rid) { toast('请输入对方用户ID'); return }
  const items = shareItems()
  const label = shareLabel(items)
  // 必须深拷成纯对象：items 里的 config.state 是 Vue 响应式 Proxy，直接经 IPC 结构化克隆会报
  // 「An object could not be cloned」。
  const payload = JSON.parse(JSON.stringify({ from: deviceId.value, name: label, items }))
  shareDlg.sending = true
  try {
    const r = await api.share.send(rid, payload)
    if (r && r.ok) toast(`已发送「${label}」给 ${rid}`)
    else toast('发送失败：' + ((r && r.error) || '未知错误'))
  } catch (e) { toast('发送失败：' + (e.message || e)) } finally { shareDlg.sending = false }
}
// 线上：拉取我的收件箱
async function loadInbox() {
  if (!api || !shareConfigured.value) return
  shareDlg.loadingInbox = true; shareDlg.inboxMsg = ''
  try {
    const r = await api.share.inbox(deviceId.value)
    if (r && r.ok) { shareDlg.inbox = r.items || []; if (!shareDlg.inbox.length) shareDlg.inboxMsg = '收件箱为空' }
    else shareDlg.inboxMsg = '获取失败：' + ((r && r.error) || '')
  } catch (e) { shareDlg.inboxMsg = '获取失败：' + (e.message || e) } finally { shareDlg.loadingInbox = false }
}
async function acceptInbox(item) {
  // 兼容多配置 bundle（items）与旧单条（state）
  const items = (item.items && item.items.length) ? item.items : (item.state ? [{ name: item.name, state: item.state }] : [])
  if (items.length) await importConfigs(items)
  try { await api.share.remove(deviceId.value, item.id) } catch (e) { /* 忽略清理失败 */ }
  shareDlg.inbox = shareDlg.inbox.filter((x) => x.id !== item.id)
}
async function dismissInbox(item) {
  try { await api.share.remove(deviceId.value, item.id) } catch (e) { /* 忽略 */ }
  shareDlg.inbox = shareDlg.inbox.filter((x) => x.id !== item.id)
}
// 切到线上 tab 自动拉一次收件箱
watch(() => shareDlg.tab, (t) => { if (t === 'online' && shareConfigured.value) loadInbox() })

// —— Phase 5/6：计算结果 Excel 导出（链路汇总 + 详细计算结果；按当前配对方式/语言选择生成不同版式）——
const exporting = ref(false)
// 导出语言：中文 / English（学术英文译法，与瀑布详情表的 WF_DICT 同源）。记住上次选择。
const exportLang = ref(localStorage.getItem('ngso/exportLang') || 'zh')
watch(exportLang, (v) => { try { localStorage.setItem('ngso/exportLang', v) } catch (e) { /* ignore */ } })
async function exportExcel() {
  if (!api) { error.value = '导出需在 Electron 中运行'; return }
  if (!links.value.length) { toast('请先点「计算」生成结果'); return }
  exporting.value = true
  try {
    const en = exportLang.value === 'en'
    const calcModeInfo = CALC_MODES.find((m) => m.key === resultMode.value)
    const pairModeInfo = LINK_PAIR_MODES.find((m) => m.key === resultPairMode.value)
    const payload = {
      orbitType: 'NGSO',
      defaultName: en
        ? `NGSO_Link_Budget_${(satForm.satelliteName || 'Results').replace(/[^\w-]+/g, '_')}.xlsx`
        : `NGSO链路预算_${(satForm.satelliteName || '结果').replace(/[\\/:*?"<>|]/g, '_')}.xlsx`,
      lang: exportLang.value,
      pairMode: resultPairMode.value,
      params: { satelliteName: satForm.satelliteName, frequencyBand: satForm.frequencyBand },
      meta: {
        title: en ? 'NGSO Link Budget Results' : 'NGSO 链路预算结果',
        mode: (calcModeInfo && (en ? calcModeInfo.enLabel : calcModeInfo.label)) || resultMode.value,
        pairMode: (pairModeInfo && (en ? pairModeInfo.enLabel : pairModeInfo.label)) || resultPairMode.value
      },
      links: links.value.map((l) => {
        // 站址经纬/最低仰角随链路透传 → 「几何关系」sheet 按 STK 口径标注发/收地球站坐标
        const tx = txStations[l.ti] || {}, rx = rxStations[l.ri] || {}
        return {
          ti: l.ti, ri: l.ri, txName: l.txName, rxName: l.rxName, ok: !!l.ok, error: l.error || '',
          data: l.data ? JSON.parse(JSON.stringify(l.data)) : null,
          geom: l.geom ? JSON.parse(JSON.stringify(l.geom)) : null,  // NGSO 平台几何（轨道根数/典型时刻 t*/互视窗口/覆盖）→ 几何关系 sheet
          txGeo: { name: l.txName, lat: parseFloat(tx.latitude), lon: parseFloat(tx.longitude), altM: parseFloat(tx.altitude) || 0, minEl: parseFloat(tx.minElevation) || 0 },
          rxGeo: { name: l.rxName, lat: parseFloat(rx.rxLatitude), lon: parseFloat(rx.rxLongitude), altM: parseFloat(rx.rxAltitude) || 0, minEl: parseFloat(rx.rxMinElevation) || 0 }
        }
      })
    }
    const r = await api.linkBudget.exportExcel(payload)
    if (r && r.ok) toast('已导出：' + r.filePath)
    else if (r && !r.canceled) error.value = '导出失败：' + (r.error || '未知错误')
  } catch (e) { error.value = '导出失败：' + String(e) } finally { exporting.value = false }
}

// 城市库
const cities = ref([])
onMounted(async () => {
  try { cities.value = (api && await api.linkBudget.cities()) || [] } catch (e) { cities.value = [] }
  try { basebandOpts.value = (api && await api.linkBudget.baseband()) || {} } catch (e) { basebandOpts.value = {} }
  await loadConfigs()
  // 「上次会话」只在能确定它属于哪个仍然存在的命名配置时才恢复并聚焦该配置——哪怕含未保存的
  // 编辑，也按该配置已保存的内容算基线，离开时仍会正确提示「未保存」。
  // 否则（从没聚焦过配置，或聚焦的配置已被删）一律保持工作区默认初始状态、不应用任何内容：
  // 避免「列表没有任何一项被选中，工作区却显示着不知道属于谁的内容」误导用户。
  try {
    const raw = localStorage.getItem(STATE_KEY)
    if (raw) {
      const st = JSON.parse(raw)
      const c = st.activeId && configs.value.find((x) => x.id === st.activeId)
      // 基线取「规整后的已存配置」：先 applyState(c.state) 走一遍与实时相同的规整管线再 setBaseline，
      // 而非直接指纹原始 c.state——否则旧版本配置一打开就因补默认/裁字段被误判「已改」。
      // 随后 applyState(st) 恢复上次会话（可能含未保存编辑）：一致则判干净、不误报；确有改动仍正确提示。
      if (c) { activeId.value = c.id; applyState(c.state); setBaseline(); applyState(st) }
    }
  } catch (e) { /* 损坏忽略 */ }
  try { deviceId.value = (api && await api.app.deviceId()) || '' } catch (e) { deviceId.value = '' }
  try { shareConfigured.value = !!(api && await api.share.configured()) } catch (e) { shareConfigured.value = false }
  refreshReadonly()
  // 关窗守卫：主进程拦截原生关闭动作后转发到这里，复用与内部切换配置同一套「取消/不保存/保存」
  // 弹窗（guardedLeave/isDirty），答完（或本就无未保存改动）才回调 confirmClose() 真正关闭窗口。
  api?.ngso?.onCloseRequested?.(async () => {
    if (await guardedLeave()) api.ngso.confirmClose()
  })
})
</script>

<template>
  <div class="lb-shell">
    <header class="lb-topbar">
      <span class="lb-brand">非地球静止轨道卫星（NGSO）链路预算</span>
      <span class="lb-sub">工作台</span>
      <button class="lb-refresh" :class="{ spin: refreshing }" :disabled="!api" title="刷新最新设置（GRD 卫星树 / 天线设置 / 实时星位 等）" @click="refreshLatest">
        <svg viewBox="0 0 16 16" class="lb-refresh-svg"><path d="M13 8a5 5 0 1 1-1.46-3.54" /><path d="M13 2.6v2.6h-2.6" /></svg>
      </button>
      <span class="lb-spacer"></span>
      <span class="lb-note" v-if="notice">{{ notice }}</span>
      <span class="lb-hint" v-if="!api"><Icon name="alert-triangle" :size="12" /> 引擎需在 Electron 中运行</span>
    </header>

    <div class="lb-body">
      <!-- ① 配置列表（可向左收起 / 可拖拽调宽） -->
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
        <!-- 右缘拖拽调宽手柄（独立元素，不参与上面的 v-if/v-else 链）-->
        <div v-if="!configsCollapsed" class="lb-cfg-resizer" title="拖动调整配置栏宽度" @mousedown.prevent="startResizeConfigs"></div>
      </aside>

      <!-- ② 链路模块 + 参数（合并） -->
      <section class="lb-col lb-build">
        <!-- 点击式模块流程 -->
        <div class="mods">
          <template v-for="(m, i) in MODULES" :key="m.key">
            <button class="mod" :class="{ on: activeModule === m.key }" @click="activeModule = m.key">
              <span class="mod-ico">
                <!-- 卫星：复用 2D 地图 drawSatIcon 的几何（两翼 3×2 太阳能板 + 中央星体，整体 -20°） -->
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
                  <template v-else><path d="M2,10 Q5,2 8,10 T14,10 T20,10" /></template>
                </svg>
              </span>
              <span class="mod-t">{{ m.label }}</span>
              <span v-if="m.key === 'tx' || m.key === 'rx'" class="mod-n">{{ moduleCount(m.key) }}</span>
            </button>
            <span v-if="i < MODULES.length - 1" class="mod-wire"><Icon name="chevron-right" :size="12" /></span>
          </template>
        </div>

        <!-- 选中模块的编辑器 -->
        <div class="lb-edit">
          <StationGrid v-if="activeModule === 'tx'" :stations="txStations" :fields="TX_FIELDS" :cities="cities" :city-search="citySearch" label="发信站" :auto-geo="autoGeoTx" ro-label="工作点EIRP" ro-unit="dBW" :ro-values="txEirp" :select-options="{ basebandId: basebandSelectOptions }" />
          <StationGrid v-else-if="activeModule === 'rx'" :stations="rxStations" :fields="RX_FIELDS" :cities="cities" :city-search="citySearch" label="收信站" :auto-geo="autoGeoRx" ro-label="工作点G/T" ro-unit="dB/K" :ro-values="rxGt" />
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
          <NgsoSatellitePanel v-else :form="satForm" :fields="SAT_FIELDS" :sat-tree="satTree" :sel="grdSel"
            :ngso-sat="ngsoSat" :sat-selected="satSelected" :horizon-hours="geoHorizonHours"
            :on-pick-tree="applyTreeSatOrbit" :on-pick-search="pickSearchSat" :on-clear="clearSatSelection"
            :on-horizon="(h) => { geoHorizonHours = h }" />
        </div>

        <!-- 计算方式 + 计算按钮 -->
        <div class="lb-foot">
          <div class="pairbar">
            <span class="pf-l">链路配对</span>
            <div class="seg">
              <button v-for="pm in LINK_PAIR_MODES" :key="pm.key" class="seg-i" :class="{ on: linkPairMode === pm.key }" :title="pm.tip" @click="linkPairMode = pm.key">{{ pm.label }}</button>
            </div>
            <span class="pairbar-desc">{{ linkPairMode === 'sequential' ? '按序号 1↔1 配对：发1↔收1、发2↔收2…；两侧数量不等时按较少一方配对' : '每个发信站与每个收信站两两配对，共 m×n 条链路' }}</span>
          </div>
          <div class="modebar">
            <label class="pf pf-mode"><span class="pf-l">计算方式</span>
              <select v-model="calcMode" class="pf-i"><option v-for="m in CALC_MODES" :key="m.key" :value="m.key">{{ m.label }}</option></select>
              <i class="pf-u"></i>
            </label>
            <!-- 第二槽位始终占位（功带平衡显「自动」），切换计算方式不再跳版 -->
            <label class="pf">
              <template v-if="calcMode === 'margin'"><span class="pf-l">系统余量</span><input v-model="targetMarginDb" class="pf-i mono" placeholder="3.00" /><i class="pf-u">dB</i></template>
              <template v-else-if="calcMode === 'power'"><span class="pf-l">功放功率</span><input v-model="targetPowerW" class="pf-i mono" placeholder="瓦特" /><i class="pf-u">W</i></template>
              <template v-else-if="calcMode === 'overbalance'"><span class="pf-l">超发量</span><input v-model="overDb" class="pf-i mono" /><i class="pf-u">dB</i></template>
              <template v-else><span class="pf-l">系统余量</span><input class="pf-i mono" value="自动" disabled /><i class="pf-u">dB</i></template>
            </label>
          </div>
          <button class="lb-calc" :disabled="computing" @click="compute">
            {{ computing ? '计算中…' : (linkPairMode === 'sequential' ? `计算（${pairCount} 条链路）` : `计算（矩阵 ${nTx}×${nRx} = ${pairCount} 条链路）`) }}
          </button>
        </div>
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
          <button class="lb-mini" :disabled="exporting || !links.length" :title="links.length ? '导出 Excel（链路汇总 + 详细计算结果）' : '先计算再导出'" @click="exportExcel">{{ exporting ? '导出中…' : '导出 Excel' }}</button>
        </div>
        <div class="lb-col-bd">
          <div v-if="error" class="lb-err">{{ error }}</div>
          <div v-else-if="!links.length" class="lb-placeholder">填写参数后点击「计算」<br />生成链路结果</div>
          <template v-else>
            <!-- 容量汇总（独立模块）：汇总本批次全部已计算链路的总带宽与总容量（自适应单位）-->
            <div v-if="capacitySummary.count" class="cap-sum">
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

            <!-- 常规计算（默认）：按序号 1↔1 配对的结果列表，点选查看瀑布 -->
            <div v-if="resultPairMode === 'sequential' && links.length > 1" class="seq-wrap">
              <div class="mtx-ctl">
                <span>列表显示</span>
                <select v-model="metricKey" class="mtx-sel">
                  <option v-for="m in METRIC_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
              </div>
              <div class="seq-list">
                <div v-for="(l, idx) in links" :key="idx" class="seq-row"
                     :class="[l.error ? 'err' : (l.ok ? 'ok' : 'bad'), { sel: idx === selected }]"
                     @click="selectLink(l.ti, l.ri)">
                  <span class="seq-idx">#{{ idx + 1 }}</span>
                  <span class="seq-name">{{ l.txName }} → {{ l.rxName }}</span>
                  <span class="seq-val">{{ cellMetricList(l) }}</span>
                </div>
              </div>
              <p class="mtx-tip">常规计算 · 按序号 1↔1 配对 · 点击查看瀑布 · 当前：{{ sel?.txName }} → {{ sel?.rxName }}</p>
            </div>

            <!-- m×n 矩阵（矩阵计算）：单元格=链路余量，点选查看瀑布 -->
            <div v-else-if="resultPairMode === 'matrix' && (nTx > 1 || nRx > 1)" class="mtx-wrap">
              <div class="mtx-ctl">
                <span>矩阵显示</span>
                <select v-model="metricKey" class="mtx-sel">
                  <option v-for="m in METRIC_OPTIONS" :key="m.key" :value="m.key">{{ m.label }}</option>
                </select>
                <span v-if="hoverTi >= 0" class="mtx-coord">(T{{ hoverTi + 1 }},R{{ hoverRi + 1 }})</span>
              </div>
              <div class="mtx-scroll" @mouseleave="clearHover">
                <table class="mtx">
                  <thead>
                    <tr>
                      <th class="mtx-corner">{{ metricLabel }}</th>
                      <th v-for="(rx, ri) in rxStations" :key="ri" :class="{ hi: ri === hoverRi }">
                        R{{ ri + 1 }}<span v-if="rx.rxEarthStationLocation" class="mtx-hname">-{{ rx.rxEarthStationLocation }}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(tx, ti) in txStations" :key="ti">
                      <th :class="{ hi: ti === hoverTi }">T{{ ti + 1 }}<span v-if="tx.earthStationLocation" class="mtx-hname">-{{ tx.earthStationLocation }}</span></th>
                      <td v-for="(rx, ri) in rxStations" :key="ri"
                          :class="['mtx-cell', cellAt(ti, ri)?.error ? 'err' : (cellAt(ti, ri)?.ok ? 'ok' : 'bad'), { sel: sel && sel.ti === ti && sel.ri === ri, rowhi: ti === hoverTi, colhi: ri === hoverRi }]"
                          @mouseenter="onCellHover(ti, ri)" @click="selectLink(ti, ri)">{{ cellMetric(cellAt(ti, ri)) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p class="mtx-tip">悬停十字定位 · 行=发信站 列=收信站 · 单元格 = {{ metricLabel }} · 点击查看瀑布 · 当前：{{ sel?.txName }} → {{ sel?.rxName }}</p>
            </div>

            <div v-if="sel && sel.error" class="lb-err">链路 {{ sel.txName }} → {{ sel.rxName }} 计算失败：{{ sel.error }}</div>
            <template v-else-if="core">
              <div class="core-card">
                <div class="core-row"><span class="core-l">功放建议</span><span class="core-v">{{ core.paRecommendation }} W</span></div>
                <div class="core-row"><span class="core-l">链路余量</span><span class="core-v">{{ core.linkmargin }} dB</span></div>
                <div class="core-barrow">
                  <div class="core-row"><span class="core-l">带宽占比</span><span class="core-v" :class="{ danger: +core.bandwidthUsageRatio > 100 }">{{ core.bandwidthUsageRatio }}%</span></div>
                  <div class="core-bar"><div class="core-bar-fill" :class="barClass(core.bandwidthUsageRatio)" :style="{ width: barW(core.bandwidthUsageRatio) }"></div></div>
                </div>
                <div class="core-barrow">
                  <div class="core-row"><span class="core-l">功率占比</span><span class="core-v" :class="{ danger: +core.powerUsageRatio > 100 }">{{ core.powerUsageRatio }}%</span></div>
                  <div class="core-bar"><div class="core-bar-fill" :class="barClass(core.powerUsageRatio)" :style="{ width: barW(core.powerUsageRatio) }"></div></div>
                </div>
                <div class="core-row"><span class="core-l">载波带宽</span><span class="core-v">{{ core.allocBandwidthResult }} kHz</span></div>
                <div class="core-row"><span class="core-l">功率带宽</span><span class="core-v">{{ core.PowerBWResult }} kHz</span></div>
                <div class="core-row"><span class="core-l">载波总C/N</span><span class="core-v">{{ core.carrierTotalCN }} dB</span></div>
                <div class="core-row"><span class="core-l">门限C/N</span><span class="core-v">{{ core.thresholdCN }} dB</span></div>
              </div>

              <!-- 平台精确几何：选星=单一典型时刻 t*(SGP4/SDP4，两站同刻·仰角尽量贴近各自最低)；手动圆轨道=闭式球面(每站各自最低仰角) -->
              <div v-if="geom && geom.feasible" class="geo-card">
                <div class="geo-top">
                  <div class="geo-title">
                    <span class="geo-tt">卫星几何</span>
                    <span class="geo-badge" title="平台精确传播器：satellite.js 统一 SGP4/SDP4，225 min 自动切深空">{{ geom.method }}</span>
                  </div>
                  <div v-if="geoHasTimes" class="geo-tz" role="group" aria-label="时区切换" title="切换典型时刻 / 互视窗口的时标（UTC / 运行机本地 / 北京 UTC+8）">
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'utc' }" @click="tzMode = 'utc'">UTC</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'local' }" @click="tzMode = 'local'">本地</button>
                    <button type="button" class="geo-tzb" :class="{ on: tzMode === 'beijing' }" @click="tzMode = 'beijing'">北京</button>
                  </div>
                </div>

                <div class="geo-body">
                  <!-- 互视访问（选星耦合：典型时刻 t* / 两站互视窗口起止·持续，STK UTCG 时标）-->
                  <template v-if="geom.coupled && geom.search">
                    <div class="geo-sec">互视访问<span class="geo-sec-x">{{ tzMode === 'utc' ? 'UTCG' : tzSuffix }}</span></div>
                    <div v-if="geom.search.typicalISO" class="geo-trow"><span class="geo-l" title="所有几何量取自这一物理瞬间；此刻两站同时可见、仰角尽量贴近各自最低仰角（通常一站正压最低、另一站略高）。t* 为墙钟绝对时——在「星座3D」页把时间轴设到此刻，即可与地图星下点直接核对（自定义星座同理：合成星已按场景历元正向传播到时间轴时刻，无需偏移换算）。">典型时刻 t*</span><span class="geo-time">{{ fmtInstant(geom.search.typicalISO, tzMode) }}</span></div>
                    <div v-if="geom.search.subSatLonDeg != null" class="geo-trow"><span class="geo-l" title="t* 该刻卫星星下点（经纬）。导入卫星天线时，卫星EIRP/G·T 即把卫星置于此位置对各站取天线增益，与本行斜距/FSL/C·N 同一瞬间">t* 星下点</span><span class="geo-time">{{ g2(geom.search.subSatLonDeg, 3) }}°E, {{ g2(geom.search.subSatLatDeg, 3) }}°N</span></div>
                    <template v-if="geom.search.mutualWindow">
                      <div class="geo-trow"><span class="geo-l" title="发信站与收信站同时满足各自最低仰角的时段（含 t* 的那次过境）——即两站可经该星建链的时间窗口范围">互视窗口 · 起始</span><span class="geo-time">{{ fmtInstant(geom.search.mutualWindow.startISO, tzMode) }}</span></div>
                      <div class="geo-trow"><span class="geo-l">互视窗口 · 结束</span><span class="geo-time">{{ fmtInstant(geom.search.mutualWindow.endISO, tzMode) }}<span v-if="geom.search.mutualWindow.clipped" class="geo-clip" title="窗口被搜索时窗边界切断，非完整过境">clipped</span></span></div>
                      <div class="geo-trow"><span class="geo-l">互视窗口 · 持续</span><span class="geo-time">{{ fmtDur(geom.search.mutualWindow.durationMin) }}</span></div>
                    </template>
                  </template>

                  <div class="geo-sec">站星几何<span class="geo-sec-x">{{ geom.coupled ? '典型时刻 t*' : '最差工况' }}</span></div>
                  <div class="geo-duo">
                    <span class="geo-duh"></span>
                    <span class="geo-duh geo-up">↑ 上行</span>
                    <span class="geo-duh geo-dn">↓ 下行</span>
                    <span class="geo-l" :title="geom.coupled ? '同一典型时刻 t* 两站各自对卫星的仰角：两站同时可见、都尽量贴近各自最低仰角（通常一站正压最低、另一站略高）' : '各站在「≥ 自身最低仰角」约束下的最差工况仰角（圆轨道=最低仰角门限）'">对卫星仰角</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.elevDeg) }}<i>°</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.elevDeg) }}<i>°</i></span>
                    <span class="geo-l" :title="geom.coupled ? 't* 该刻两站各自的星地斜距（同一物理瞬间）' : '仰角约束下的最大星地斜距（各站独立取，最坏几何）'">星地斜距</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.slantKm) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.slantKm) }}<i>km</i></span>
                    <span class="geo-l" :title="geom.coupled ? 't* 该刻卫星高度（同一瞬间，上下行相同）' : ''">卫星高度</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.altKm, 1) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.altKm, 1) }}<i>km</i></span>
                    <span class="geo-l" title="覆盖地心半角 λ = arccos((Re/r)·cosε) − ε（该仰角门限下卫星对地心张成的地面覆盖带半角）">覆盖地心半角</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.coverageHalfAngleDeg) }}<i>°</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.coverageHalfAngleDeg) }}<i>°</i></span>
                    <span class="geo-l" title="地面覆盖半径 = Re·λ（星下点到覆盖带边缘的地表大圆弧长）">地面覆盖半径</span>
                    <span class="geo-vu">{{ g2(geom.worst.up.coverageRadiusKm, 1) }}<i>km</i></span>
                    <span class="geo-vd">{{ g2(geom.worst.dn.coverageRadiusKm, 1) }}<i>km</i></span>
                    <span class="geo-l" title="最大过境时长(天顶) = 2λ/|ω_s − ω_E·cos i|；GEO / 严格常驻可见为 ∞">最大过境时长</span>
                    <span class="geo-vu" :class="{ 'geo-inf': geom.worst.up.maxPassMin == null }">{{ gPass(geom.worst.up.maxPassMin) }}<i v-if="geom.worst.up.maxPassMin != null">min</i></span>
                    <span class="geo-vd" :class="{ 'geo-inf': geom.worst.dn.maxPassMin == null }">{{ gPass(geom.worst.dn.maxPassMin) }}<i v-if="geom.worst.dn.maxPassMin != null">min</i></span>
                  </div>

                  <div class="geo-row"><span class="geo-l">单程链路时延</span><span class="geo-v">{{ g2(geom.worst.oneWayDelayMs, 3) }}<i>ms</i></span></div>

                  <div class="geo-sec">卫星运动</div>
                  <div v-if="geom.worst.speedInertialKmS != null" class="geo-row"><span class="geo-l">轨道速度<i>惯性系</i></span><span class="geo-v">{{ g2(geom.worst.speedInertialKmS, 3) }}<i>km/s</i></span></div>
                  <div v-if="geom.worst.speedGroundRelKmS != null" class="geo-row"><span class="geo-l">相对地面速度<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-v">{{ g2(geom.worst.speedGroundRelKmS, 3) }}<i>km/s</i></span></div>
                  <div v-if="geom.worst.maxDopplerUpHz != null" class="geo-duo geo-duo-tight"><span class="geo-l" :title="geom.dopplerEstimate ? '圆轨道无相位，闭式估算 f·v_radial/c' : (geom.coupled ? (geom.method + ' 取典型时刻 t* 该刻 ECEF 斜距变化率（含地球自转）；t* 多在低仰角、range-rate 近峰值') : (geom.method + ' 沿星历求 ECEF 斜距变化率（含地球自转）'))">{{ geom.coupled ? '多普勒频移' : '最大多普勒' }}<i v-if="geom.dopplerEstimate">估算</i></span><span class="geo-vu">±{{ g2(geom.worst.maxDopplerUpHz / 1000, 3) }}<i>kHz</i></span><span class="geo-vd">±{{ g2(geom.worst.maxDopplerDnHz / 1000, 3) }}<i>kHz</i></span></div>

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
                几何提示：{{ geom.reason }}。可增大搜索时窗、改选卫星，或取消选星改用手动轨道高度 + 最低仰角（闭式球面最差几何）。
              </div>
              <div v-else class="geo-card geo-note">
                当前为手动轨道模式：几何按「每站自身最低仰角处的最大斜距」闭式球面给出（轨道高度 + 各站最低仰角，Re=6378.137 km），斜距/仰角见下方瀑布表。选星后此处显示所选星的最差工况几何（圆轨道走闭式球面、偏心/HEO 走 SGP4/SDP4）与轨道根数。
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

    <!-- 命名弹窗：保存为新配置（替代 Electron 不支持的 window.prompt）-->
    <div v-if="cfgDlg.open" class="lb-mask" @click="cfgDlg.open = false">
      <div class="lb-dlg" @click.stop>
        <div class="lb-dlg-hd">保存为新配置</div>
        <div class="lb-dlg-bd">
          <input v-model="cfgDlg.name" class="lb-input" placeholder="配置名称" @keyup.enter="confirmCfgDlg" />
        </div>
        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="cfgDlg.open = false">取消</button>
          <button class="lb-mini primary" @click="confirmCfgDlg">保存</button>
        </div>
      </div>
    </div>

    <!-- 离开已改动配置的提示（保存 / 不保存 / 取消）-->
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

    <!-- 通用确认弹窗（删除文件夹等）-->
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


    <!-- 分享 / 导入弹窗：线下（分享码 / 文件）+ 线上（按用户ID，开发中）-->
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
            <button class="lb-mini" @click="exportConfigFile">导出为文件(.lbcfg)</button>
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
          <div v-else class="lb-share-note">在线分享未配置：需在 electron/services/shareConfig.js 填入仅授权 share/* 的 COS 子账号密钥（见 shareConfig.example.js）。配置后即可按用户ID收发。当前可先用「线下分享码」即时分享。</div>
        </div>

        <div class="lb-dlg-ft">
          <button class="lb-mini" @click="shareDlg.open = false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 浅色精密仪器风：页内统一圆角/字号尺度，并就地覆写语义色（仅本页生效，不影响主窗口/地图）。 */
.lb-shell {
  display: flex; flex-direction: column; height: 100vh;
  background: var(--bg); color: var(--text); font-family: var(--font-sans);
  /* 降饱和的语义色（更接近灰，避免红绿黄过艳） */
  --ok: #4a7a62; --warn: #8a7038; --danger: #9c5751;
  /* 上行/下行分列的克制冷暖角标色（仅用于图例与箭头，数值仍取中性 text） */
  --up: #3f6d8c; --dn: #97672f;
  /* 统一圆角尺度 */
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
/* 右缘拖拽手柄：调整配置栏宽度 */
.lb-cfg-resizer { position: absolute; top: 0; right: 0; width: 6px; height: 100%; cursor: col-resize; z-index: 6; }
.lb-cfg-resizer:hover, .lb-configs.resizing .lb-cfg-resizer { background: var(--accent); opacity: .35; }
/* 配置栏表头更紧凑，给「配置列表」标题留足空间 */
.lb-configs .lb-col-hd { padding: 0 8px; gap: 6px; }
/* 细滚动条：树可横向滚动看全名，且尽量不与右缘拖拽手柄抢占 */
.lb-configs .lb-col-bd { padding: 10px 8px; scrollbar-width: thin; }
.lb-cfg-hd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-cfg-collapse { flex: none; padding: 3px 5px; }
.lb-cfg-chev { font-size: 14px; line-height: 1; display: inline-flex; align-items: center; }
/* 收起态：整列变成一根可点击竖条 */
.lb-cfg-expand { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 10px 0; cursor: pointer; background: var(--surface); color: var(--text-muted); border: 0; }
.lb-cfg-expand:hover { color: var(--text); background: var(--surface-2); }
.lb-cfg-expand .lb-cfg-chev { font-size: 16px; }
.lb-cfg-expand-t { writing-mode: vertical-rl; font-size: 11px; letter-spacing: 3px; }
.lb-build { flex: 1; min-width: 460px; }
.lb-result { width: 424px; flex: none; }

.lb-col-hd { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 30px; flex: none; padding: 0 12px; font-size: 11px; font-weight: 600; letter-spacing: 1px; text-transform: uppercase; background: var(--surface-2); border-bottom: 1px solid var(--border); color: var(--text-muted); }
.lb-col-bd { flex: 1; overflow: auto; padding: 12px; }
.lb-lang-sel { font: inherit; font-size: 11px; text-transform: none; letter-spacing: normal; line-height: 1; padding: 3px 6px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.lb-lang-sel:focus { outline: none; border-color: var(--accent); }
.lb-mini { font: inherit; font-size: 11px; line-height: 1; padding: 3px 8px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.lb-mini:hover:not(:disabled) { color: var(--text); border-color: var(--border-strong); }
.lb-mini:disabled { opacity: .45; cursor: not-allowed; }
.lb-empty, .lb-placeholder { color: var(--text-faint); font-size: 12px; text-align: center; line-height: 1.7; }
.lb-cfg-acts { display: flex; gap: 4px; }
.lb-cfg-list { list-style: none; margin: 0; padding: 0; }
.lb-cfg-list li { display: flex; align-items: center; gap: 6px; padding: 6px 6px 6px 9px; font-size: 12px; cursor: pointer; border-radius: var(--r-ctl); color: var(--text-muted); }
.lb-cfg-list li:hover { background: var(--surface-2); color: var(--text); }
.lb-cfg-list li.on { background: var(--surface-2); color: var(--text); box-shadow: inset 2px 0 0 var(--accent); }
.lb-cfg-nm { flex: 1; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.lb-cfg-ico { flex: none; font: inherit; font-size: 13px; line-height: 1; padding: 0 4px; cursor: pointer; background: transparent; color: var(--text-faint); border: 0; border-radius: var(--r-ctl); opacity: 0; display: inline-flex; align-items: center; }
.lb-cfg-list li:hover .lb-cfg-ico { opacity: 1; }
.lb-cfg-ico:hover { color: var(--text); }
.lb-cfg-ico.del:hover { color: var(--danger); }
.lb-cfg-list { user-select: none; }
.lb-cfg-list li { cursor: pointer; }
.lb-cfg-list li.cut { opacity: .5; }
/* 右键菜单 */
.lb-ctx-mask { position: fixed; inset: 0; z-index: 400; }
.lb-ctx { position: fixed; min-width: 150px; padding: 4px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-box); box-shadow: 0 6px 20px rgba(0,0,0,.22); display: flex; flex-direction: column; }
.lb-ctx-i { font: inherit; font-size: 12px; text-align: left; padding: 6px 10px; cursor: pointer; background: transparent; color: var(--text); border: 0; border-radius: var(--r-ctl); white-space: nowrap; }
.lb-ctx-i:hover:not(:disabled) { background: var(--surface-2); }
.lb-ctx-i:disabled { opacity: .45; cursor: not-allowed; }
.lb-ctx-i.danger:hover { color: var(--danger); }
.lb-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
.lb-cfg-rename { flex: 1; min-width: 0; font: inherit; font-size: 12px; padding: 2px 5px; background: var(--bg); color: var(--text); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-cfg-rename:focus { outline: none; }
.lb-cfg-hint { padding: 2px 6px 8px; font-size: 11px; color: var(--text-faint); line-height: 1.5; }
.lb-cfg-acts { display: flex; gap: 3px; }
.lb-cfg-acts i { font-style: normal; }
.lb-mini-ico { display: inline-flex; align-items: center; justify-content: center; padding: 3px 5px; }
.lb-ico-svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linejoin: round; }
.lb-myid { flex: none; display: flex; align-items: center; gap: 4px; padding: 6px 12px; font-size: 11px; color: var(--text-muted); border-top: 1px solid var(--border); background: var(--surface); white-space: nowrap; overflow: hidden; }
.lb-myid b { font-family: var(--font-mono); color: var(--text); letter-spacing: .5px; overflow: hidden; text-overflow: ellipsis; }

/* 弹窗（命名 / 分享） */
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

/* 模块流程条：扁平分段标签 */
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
.form { max-width: 420px; }
/* 载波信号配置库：工具条 + 多张卡片同时展示/编辑 */
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
.pf-i:disabled { color: var(--text-faint); background: var(--surface-2); cursor: default; }
.pf-u { font-size: 11px; color: var(--text-faint); font-style: normal; }

.lb-foot { flex: none; padding: 8px 12px; border-top: 1px solid var(--border); background: var(--surface); }
/* 链路配对方式：常规计算(默认 1↔1) / 矩阵计算(m×n)——扁平分段标签 */
.pairbar { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
.seg { display: flex; gap: 2px; }
.seg-i { font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; background: var(--bg); color: var(--text-muted); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.seg-i:hover { color: var(--text); border-color: var(--border-strong); }
.seg-i.on { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); }
.pairbar-desc { font-size: 11px; color: var(--text-faint); }
/* 计算方式：两个等宽槽位固定排布，切换方式不跳版 */
.modebar { display: flex; gap: 14px; align-items: center; margin-bottom: 10px; }
.modebar .pf { flex: none; width: 236px; margin-bottom: 0; }
/* 计算方式选择框加长，刚好装下「功带平衡下超发」 */
.modebar .pf.pf-mode { width: 250px; grid-template-columns: auto 134px 8px; }
.lb-calc { width: 100%; font: inherit; font-size: 12px; font-weight: 600; letter-spacing: .5px; padding: 8px; cursor: pointer; background: var(--accent); color: var(--bg); border: 1px solid var(--accent); border-radius: var(--r-ctl); }
.lb-calc:hover:not(:disabled) { opacity: .88; }
.lb-calc:disabled { opacity: .5; cursor: not-allowed; }

/* 结果 */
.lb-err { color: var(--danger); font-size: 12px; padding: 8px; }
.mtx-wrap { margin-bottom: 14px; }
.mtx-ctl { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 12px; color: var(--text-muted); }
.mtx-sel { font: inherit; font-size: 12px; padding: 3px 6px; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--r-ctl); }
.mtx-sel:focus { outline: none; border-color: var(--accent); }
.mtx-coord { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); margin-left: auto; }
.mtx-scroll { max-height: 320px; overflow: auto; border: 1px solid var(--border); border-radius: var(--r-box); }
.mtx { border-collapse: separate; border-spacing: 0; font-size: 12px; }
.mtx th, .mtx td { border-right: 1px solid var(--border); border-bottom: 1px solid var(--border); padding: 4px 9px; background: var(--bg); }
.mtx th { color: var(--text-muted); font-weight: 600; white-space: nowrap; background: var(--surface-2); }
.mtx thead th { position: sticky; top: 0; z-index: 2; text-align: center; }
.mtx tbody th { position: sticky; left: 0; z-index: 1; text-align: left; }
.mtx-corner { position: sticky; left: 0; top: 0; z-index: 3; font-size: 11px; color: var(--text-faint); font-weight: 400; letter-spacing: normal; }
.mtx-hname { font-size: 11px; font-weight: 400; color: var(--text-muted); }
.mtx th.hi { background: color-mix(in srgb, var(--accent) 12%, var(--surface-2)); color: var(--text); }
.mtx-cell { font-family: var(--font-mono); text-align: right; cursor: pointer; }
.mtx-cell.ok { color: var(--ok); }
.mtx-cell.bad { color: var(--danger); }
.mtx-cell.err { color: var(--text-faint); text-align: center; }
.mtx-cell.rowhi, .mtx-cell.colhi { background: color-mix(in srgb, var(--accent) 5%, var(--bg)); }
.mtx-cell.sel { outline: 1.5px solid var(--accent); outline-offset: -1.5px; font-weight: 600; }
.mtx-tip { margin: 6px 0 0; font-size: 11px; color: var(--text-faint); }

/* 常规计算结果列表（序号 1↔1 配对） */
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

/* 核心结果卡片 */
.core-card { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 18px; margin-bottom: 14px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-box); background: var(--surface); }
.core-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; white-space: nowrap; overflow: hidden; }
.core-l { font-size: 12px; color: var(--text-muted); flex-shrink: 0; }
.core-v { font-family: var(--font-mono); font-size: 13px; font-weight: 600; color: var(--text); text-align: right; overflow: hidden; text-overflow: ellipsis; }
.core-v.danger { color: var(--danger); }
/* 平台精确几何卡 */
/* 站星几何卡片：浅色仪器风。顶栏放标题+传播器徽章+UTC/本地切换；正文上行/下行分列对齐。 */
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
.geo-sec { display: flex; align-items: baseline; gap: 7px; font-size: 11px; font-weight: 600; color: var(--accent); margin: 11px 0 4px; padding-top: 8px; border-top: 1px dashed var(--border); letter-spacing: .3px; }
.geo-sec:first-child { border-top: none; padding-top: 0; margin-top: 3px; }
.geo-sec-x { font-weight: 400; font-size: 10px; color: var(--text-faint); letter-spacing: .2px; }

.geo-row, .geo-trow { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 2.5px 0; }
.geo-l { font-size: 12px; color: var(--text-muted); min-width: 0; }
.geo-l i { font-style: normal; font-size: 10px; color: var(--text-faint); margin-left: 4px; letter-spacing: .2px; }
.geo-v, .geo-time { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-v i, .geo-time i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 5px; }
.geo-clip { font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: .4px; color: var(--text-faint); margin-left: 7px; padding: 1px 5px; border: 1px solid var(--border); border-radius: 999px; vertical-align: 1px; }
.geo-v-updn { display: inline-flex; gap: 11px; }
.geo-v-updn .up { color: var(--up); }
.geo-v-updn .dn { color: var(--dn); }

/* 核心几何三行：标签 + 上行 + 下行三列对齐，值取中性色，靠图例色区分方向 */
.geo-duo { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: baseline; column-gap: 16px; row-gap: 3px; margin: 4px 0 2px; }
/* 多普勒行复用双列格与站星几何列对齐，但夹在卫星运动的单列行之间，去掉分节块专用的上下外边距，回归 geo-row 行距 */
.geo-duo.geo-duo-tight { margin: 2.5px 0; }
.geo-duo .geo-l { grid-column: 1; }
.geo-duh { font-size: 10px; font-weight: 600; letter-spacing: .3px; text-align: right; color: var(--text-faint); padding-bottom: 1px; }
.geo-duh.geo-up { color: var(--up); }
.geo-duh.geo-dn { color: var(--dn); }
.geo-vu, .geo-vd { font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text); text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.geo-vu i, .geo-vd i { font-style: normal; font-weight: 500; color: var(--text-faint); margin-left: 4px; }
/* 常驻可见 ∞：等宽 12px 下符号偏小，单独放大（不加粗，字重同其它数值）*/
.geo-vu.geo-inf, .geo-vd.geo-inf { font-size: 18px; line-height: 1; }

.geo-note { padding: 10px 12px; font-size: 11px; color: var(--text-muted); line-height: 1.6; font-family: inherit; font-weight: 400; }
.core-barrow { display: flex; flex-direction: column; }
.core-barrow .core-row { padding-bottom: 2px; }
.core-bar { width: 100%; height: 3px; background: var(--surface-2); border-radius: 1px; overflow: hidden; }
.core-bar-fill { height: 100%; transition: width .5s cubic-bezier(.4, 0, .2, 1); min-width: 2px; opacity: .85; }
.core-bar-fill.normal { background: var(--ok); }
.core-bar-fill.warn { background: var(--warn); }
.core-bar-fill.danger { background: var(--danger); }

/* 容量汇总（独立模块）：批量链路的总带宽 / 总容量，置于结果区顶部，accent 左边框自成一块 */
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
