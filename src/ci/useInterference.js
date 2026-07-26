// 干扰分析（C/I）—— 组合式逻辑层（仿 viz/vis/useVisibility.js）。
//
// 职责：四种模式的面板状态 + 调用主进程引擎 + 结果整形 + 持久化。
// 物理一概不在这里：全部经 window.api.interference.* 走 IPC 到 packages/core/utils/interference/。
// 渲染端不重写任何公式，也不维护 ESM 镜像——干扰的口径全靠 ITU 建议书钉死，两份实现必然漂移。
//
// 本模块是**只读消费者**：读三库（store.getLibrary）与 GRD 树，从不写回。算出来的 C/I
// 要用到链路预算里，由使用者自己搬——这是「只看不回填」的既定取舍，别在这里偷偷写库。

import { ref, reactive, computed, watch } from 'vue'
// 「自定义星座」（星座页 Walker 生成器）：放置公式与场景历元一律复用星座3D 页那两个模块，
// 绝不在本窗口另写一遍——NGSO 链路预算的搜索池（ngso/satSearchPool.js）也是这么接的。
import { generateConstellation, validateWalker } from '../viz/constellation/walker.js'
import { resolveScenarioEpoch } from '../viz/constellation/useCustomConstellations.js'

const KEY = 'ci/panel'
const api = typeof window !== 'undefined' ? window.api : null

export const MODES = [
  { key: 'asi', label: 'C/ASI 邻星', tip: 'GEO 邻星干扰：拓扑角 + AP8 离轴包络，上下行 + ΔT/T 协调判据' },
  { key: 'cci', label: 'C/CCI 同频', tip: '多波束频率复用：同色波束在该点的旁瓣叠加，采用 GRD 实测方向图' },
  { key: 'xpi', label: 'C/XPI 极化', tip: '交叉极化：卫星侧(GRD P1/P2) ⊕ 地球站侧 ⊕ 雨致去极化 三源合成' },
  { key: 'ngso', label: 'NGSO 时变', tip: 'NGSO 干扰是随机过程：逐时刻扫描出 C/I 的 CDF 与 in-line 事件' }
]

export const REUSE_COLORS = [3, 4, 7]

let _srcSeq = 1
const blankSource = (o) => ({
  _id: 'is' + (_srcSeq++),
  enabled: true,
  name: '',
  lonDeg: '',
  eirpDensityDbWPerHz: '',
  polarization: '',
  xpdDb: '',
  overlapFactor: '',
  // 上行「对等站」模式用
  diameterM: '', powerW: '', bandwidthHz: '', feederLossDb: '',
  stationLon: '', stationLat: '',
  // 上行「逐站给定」模式用：干扰站朝本星方向的离轴 EIRP 密度
  offAxisEirpDensityDbWPerHz: '',
  ...o
})

export function useInterference() {
  const mode = ref('asi')
  const busy = ref(false)
  const msg = ref('')

  // ---- 本站与本链路（四种模式共用的公共上下文）----
  const site = reactive({
    name: '本站', lon: 116.4074, lat: 39.9042, alt: 0,
    rxDiameterM: 4.5, rxEfficiency: 65, rxFreqGHz: 12.5,
    txDiameterM: 4.5, txEfficiency: 65, txFreqGHz: 14.25,
    txPowerW: 40, txFeederLossDb: 3.5
  })
  const carrier = reactive({
    satLonDeg: 110.5, satName: '',
    eirpDbW: 50, bandwidthHz: 36e6,
    dnPolarization: 'H', upPolarization: 'V'
  })

  // ---- C/ASI ----
  const asi = reactive({
    applyPolarization: true,
    uplinkMode: 'peer',              // 'peer' 工程估算 | 'mask' S.524 监管上界 | 'explicit'
    sources: [
      blankSource({ name: '邻星 A', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H', diameterM: 4.5, powerW: 40, bandwidthHz: 36e6, feederLossDb: 3.5 }),
      blankSource({ name: '邻星 B', lonDeg: 108, eirpDensityDbWPerHz: -45, polarization: 'H', diameterM: 4.5, powerW: 40, bandwidthHz: 36e6, feederLossDb: 3.5 })
    ],
    // 协调判据（施扰侧）：对哪颗邻星、它的 G/T 与接收增益
    coordLonDeg: 113, coordGoverT: 2, coordRxGain: 30,
    result: null
  })

  // ---- C/XPI ----
  const xpi = reactive({
    satSource: 'grd',                // 'grd' 走方向图 P1/P2 | 'manual'
    satGrdRatioDb: '', satGrdDetail: null, satManualDb: 26,
    // 地球站侧：三种等价给法 + 可叠加的对准误差。换算全在引擎（ciXpi.resolveXpd），
    // 这里只组装描述子，esTerm 是引擎回的解析结果（边填边看）
    esMode: 'manual',                // 'manual' 直接填 | 'axialRatio' 轴比 | 'levels' 实测共/交电平
    earthStationDb: 30,
    esArDb: 0.8,
    esCoDb: 0, esXpolDb: -30,
    esAlignOn: false, esAlignDeg: 1,
    esTerm: null,
    rainXpdDb: 22,
    result: null
  })

  // ---- C/CCI ----
  const cci = reactive({
    antennaKey: '',                  // 选中的 GRD 天线（folder::name）
    colors: 4,
    servingIdx: null,                // null = 取该点最强
    floorDb: 60,
    points: [{ _id: 'p1', name: '本站', lon: 116.4074, lat: 39.9042 }],
    result: null,                    // { rows:[{name,lon,lat,cciDb,servingIdx}], coloring, beamIdx }
    coloringOverride: null,          // 手工指派：{原始下标: 颜色号}
    // 覆盖场图
    bounds: { lonMin: 70, lonMax: 140, latMin: 15, latMax: 55 },
    fieldStep: 1,
    field: null
  })

  // ---- NGSO ----
  const ngso = reactive({
    minElevDeg: 10,
    horizonH: 6,
    stepSec: 10,
    patternKind: 'average',
    applyPolarization: true,
    thresholdDb: 15,
    startIso: '',                    // 空 = 计算时取当前时刻（本层填，引擎不碰 Date.now）
    wanted: { source: 'group', group: '', limit: 200, name: '本星座', altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1 },
    interferers: [
      { _id: 'ng1', enabled: true, source: 'group', group: '', limit: 200, name: '干扰星座', altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1, eirpDensityDbWPerHz: -48, polarization: 'H', xpdDb: '', selfSystem: false }
    ],
    progress: 0, progressTotal: 0,
    estimate: null,
    result: null
  })

  // ---------------------------------------------------------------------------
  // 库与 GRD 树（只读）
  // ---------------------------------------------------------------------------
  const satLib = ref([])             // 卫星库条目（可作干扰源来源）
  const grdTree = ref({ sats: [], cfgs: {} })

  async function loadLibraries() {
    if (!api || !api.store) return
    // 三体制各自独立的命名空间；干扰源取「卫星」那一类，三套都读进来供选
    const out = []
    for (const ns of ['geo', 'ngso', 'regen']) {
      try {
        const lib = await api.store.getLibrary(ns)
        for (const s of ((lib && lib.satConfigs) || [])) {
          out.push({ ns, id: s.id, name: s.name || s.form?.satelliteName || s.id, form: s.form || {}, grd: s.grd || null })
        }
      } catch (e) { /* 该体制尚无库文件 */ }
    }
    satLib.value = out
  }

  // GRD 树三源合并：星座3D 页导入的 + 链路预算导入的 + 本窗口导入的
  function loadGrdTree() {
    const read = (key, pick) => {
      try {
        const d = JSON.parse(localStorage.getItem(key) || 'null')
        return pick ? pick(d) : d
      } catch (e) { return null }
    }
    const nodes = []
    const g3 = read('globe3d/settings', (d) => d && d.grd)
    for (const s of ((g3 && g3.sats) || [])) {
      const ants = (s.antennas || []).filter((a) => a && a.imported && a.file)
      if (ants.length) nodes.push({ origin: '星座3D', folder: s.folder, satName: s.satName || s.folder, lon: +s.lon || 0, lat: +s.lat || 0, altKm: +s.altKm || 35786, antennas: ants })
    }
    for (const key of ['lb/grdSats', 'ci/grdSats']) {
      const st = read(key)
      for (const s of ((st && st.sats) || [])) {
        const ants = (s.antennas || []).filter((a) => a && a.file)
        if (ants.length) nodes.push({ origin: key === 'ci/grdSats' ? '本窗口' : '链路预算', folder: s.folder, satName: s.satName || s.folder, lon: +s.lon || 0, lat: +s.lat || 0, altKm: +s.altKm || 35786, antennas: ants })
      }
    }
    grdTree.value = { sats: nodes, cfgs: (g3 && g3.cfgs) || {} }
  }

  const grdAntennas = computed(() => {
    const out = []
    for (const s of grdTree.value.sats) {
      for (const a of s.antennas) {
        out.push({
          key: s.folder + '::' + a.name,
          label: `${s.satName} · ${a.name}（${a.beams || 1} 波束）`,
          origin: s.origin,
          node: s, ant: a
        })
      }
    }
    return out
  })
  const currentAntenna = computed(() => grdAntennas.value.find((a) => a.key === cci.antennaKey) || null)

  // 本窗口自己导入 GRD —— 与「引用已有」并列，不必非得从别处引
  async function importGrdHere() {
    if (!api || !api.coverageGrd || !api.coverageGrd.import) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true; msg.value = '选择 GRD 文件…'
    try {
      const res = await api.coverageGrd.import()
      if (!res || res.canceled) { msg.value = ''; return }
      const KEY_CI = 'ci/grdSats'
      let st = null
      try { st = JSON.parse(localStorage.getItem(KEY_CI) || 'null') } catch (e) { st = null }
      if (!st || !Array.isArray(st.sats)) st = { sats: [] }
      // 本窗口导入的方向图不挂靠任何卫星库条目——干扰分析常要分析第三方/邻网的天线，
      // 那不是「我的某颗星」。统一落在一个分析用节点下。
      let node = st.sats.find((s) => s.folder === 'ci:analysis')
      if (!node) { node = { folder: 'ci:analysis', satName: '分析用方向图', lon: 0, lat: 0, altKm: 35786, antennas: [] }; st.sats.push(node) }
      const added = []
      for (const f of (res.files || [])) {
        if (!f || f.error || !f.file) continue
        let beams = 1
        try {
          const m = await api.linkBudget.grdMeta(f.file)
          if (m && m.ok && m.beams > 0) beams = m.beams
          else { msg.value = (f.base || f.file) + '：解析失败'; continue }
        } catch (e) { msg.value = (f.base || f.file) + '：解析失败'; continue }
        let name = String(f.base || f.file).replace(/\.(grd|pat)$/i, '')
        while (node.antennas.some((a) => a.name === name)) name += '·'
        node.antennas.push({ name, file: f.file, beams, imported: true, satLon: node.lon, satLat: node.lat, satAlt: node.altKm })
        added.push(name)
      }
      try { localStorage.setItem(KEY_CI, JSON.stringify(st)) } catch (e) { /* 配额 */ }
      loadGrdTree()
      if (added.length) {
        const first = grdAntennas.value.find((a) => a.ant.name === added[0])
        if (first) cci.antennaKey = first.key
        msg.value = `已导入 ${added.length} 副天线：${added.join('、')}`
      }
    } finally { busy.value = false }
  }

  // 方向图的卫星几何 + 取值口径（与链路预算 grdParam.antennaSampleSpec 同口径）
  function antennaSpec(a, extraCfg) {
    if (!a) return null
    const cfg = { ...(grdTree.value.cfgs[a.node.folder + '::' + a.ant.name] || {}), ...(extraCfg || {}) }
    return {
      file: String(a.ant.file),
      sat: {
        lon: Number.isFinite(+a.ant.satLon) ? +a.ant.satLon : a.node.lon,
        lat: Number.isFinite(+a.ant.satLat) ? +a.ant.satLat : a.node.lat,
        alt: Number.isFinite(+a.ant.satAlt) ? +a.ant.satAlt : a.node.altKm
      },
      cfg
    }
  }

  // ---------------------------------------------------------------------------
  // 计算：C/ASI
  // ---------------------------------------------------------------------------
  const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) && v !== '' && v !== null ? n : d }

  function asiPayload() {
    const station = { lon: +site.lon, lat: +site.lat, alt: +site.alt }
    const srcs = asi.sources.filter((s) => s.enabled).map((s) => ({
      id: s._id, name: s.name || s._id,
      lonDeg: numOr(s.lonDeg, 0),
      eirpDensityDbWPerHz: numOr(s.eirpDensityDbWPerHz, null),
      polarization: s.polarization || undefined,
      xpdDb: numOr(s.xpdDb, undefined),
      overlapFactor: numOr(s.overlapFactor, undefined),
      offAxisEirpDensityDbWPerHz: numOr(s.offAxisEirpDensityDbWPerHz, undefined),
      diameterM: numOr(s.diameterM, undefined),
      powerW: numOr(s.powerW, undefined),
      bandwidthHz: numOr(s.bandwidthHz, undefined),
      feederLossDb: numOr(s.feederLossDb, undefined),
      stationLon: numOr(s.stationLon, undefined),
      stationLat: numOr(s.stationLat, undefined)
    }))
    return {
      downlink: {
        station,
        wanted: { lonDeg: +carrier.satLonDeg, eirpDbW: +carrier.eirpDbW, bandwidthHz: +carrier.bandwidthHz, polarization: carrier.dnPolarization },
        rx: { diameterM: +site.rxDiameterM, efficiency: +site.rxEfficiency / 100, freqGHz: +site.rxFreqGHz },
        interferers: srcs,
        applyPolarization: asi.applyPolarization
      },
      uplink: {
        station,
        wanted: { lonDeg: +carrier.satLonDeg, polarization: carrier.upPolarization },
        tx: { diameterM: +site.txDiameterM, efficiency: +site.txEfficiency / 100, freqGHz: +site.txFreqGHz, powerW: +site.txPowerW, feederLossDb: +site.txFeederLossDb, bandwidthHz: +carrier.bandwidthHz },
        interferers: srcs,
        sourceMode: asi.uplinkMode,
        applyPolarization: asi.applyPolarization
      },
      coordination: {
        station,
        tx: { diameterM: +site.txDiameterM, efficiency: +site.txEfficiency / 100, freqGHz: +site.txFreqGHz, powerW: +site.txPowerW, feederLossDb: +site.txFeederLossDb, bandwidthHz: +carrier.bandwidthHz },
        wanted: { lonDeg: +carrier.satLonDeg },
        victim: { lonDeg: +asi.coordLonDeg, gOverTDbPerK: +asi.coordGoverT, rxGainDbi: +asi.coordRxGain }
      }
    }
  }

  async function computeAsi() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true; msg.value = ''
    try {
      const r = await api.interference.asi(asiPayload())
      if (!r || !r.ok) { msg.value = '计算失败：' + ((r && r.error) || '未知错误'); asi.result = null; return }
      asi.result = r
      const warns = [...((r.downlink && r.downlink.warnings) || []), ...((r.uplink && r.uplink.warnings) || [])]
      msg.value = warns.length ? warns[0] : ''
    } finally { busy.value = false }
  }

  // ---------------------------------------------------------------------------
  // 计算：C/XPI
  // ---------------------------------------------------------------------------
  async function sampleXpiFromGrd() {
    const a = currentAntenna.value
    if (!a) { msg.value = '先选一副 GRD 方向图'; return }
    if (!api || !api.linkBudget) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true
    try {
      // 走专用的 grdSampleXpd：共极化分量由波束峰值判定（不假设是 P1），且取【服务波束】的
      // 共/交比。此前用 pol:'P1/P2' 走 sampleMax 是错的——既把共极化认反（真实文件多为 P2 才是
      // 共极化，取出来是负数），又在各波束的比值里取最大（跟该点实际收哪个波束无关）。
      const spec = antennaSpec(a)
      const r = await api.linkBudget.grdSampleXpd({ ...spec, points: [{ lon: +site.lon, lat: +site.lat }] })
      const v = r && r.ok && Array.isArray(r.values) ? r.values[0] : null
      if (!v) { msg.value = '该站址落在方向图网格域外，或卫星不可见'; xpi.satGrdRatioDb = ''; xpi.satGrdDetail = null; return }
      xpi.satGrdRatioDb = v.xpdDb
      xpi.satGrdDetail = v
      msg.value = `卫星侧 XPD = ${v.xpdDb.toFixed(2)} dB（服务波束 #${v.servingIdx}，共极化分量 P${v.coPolIndex}：共 ${v.coPolDb.toFixed(1)} / 交 ${v.xPolDb.toFixed(1)} dB）`
    } finally { busy.value = false }
  }

  /**
   * 地球站侧那一段的「给法」描述子。渲染端只组装描述子，轴比/实测电平/对准误差的换算
   * 一律由引擎 ciXpi.resolveXpd 做——本模块不重写公式、不维护镜像（见文件头）。
   */
  function esDesc() {
    const d = { mode: xpi.esMode }
    if (xpi.esMode === 'axialRatio') d.axialRatioDb = numOr(xpi.esArDb, null)
    else if (xpi.esMode === 'levels') { d.coPolDb = numOr(xpi.esCoDb, null); d.xPolDb = numOr(xpi.esXpolDb, null) }
    else d.db = numOr(xpi.earthStationDb, null)
    if (xpi.esAlignOn) d.alignDeg = numOr(xpi.esAlignDeg, null)
    return d
  }

  // 边填边看：描述子一变就去引擎要这一段的解析结果。防抖 + 序号闸（IPC 是异步的，
  // 连打几个字会有多个在飞，回来的次序不保证——只认最后一次发出去的那个）
  let _esTimer = 0, _esSeq = 0
  async function refreshEsTerm() {
    if (!api || !api.interference || !api.interference.xpiTerm) { xpi.esTerm = null; return }
    const seq = ++_esSeq
    const r = await api.interference.xpiTerm(esDesc())
    if (seq !== _esSeq) return
    xpi.esTerm = r && r.ok ? r.term : null
  }
  watch(() => JSON.stringify(esDesc()), () => {
    clearTimeout(_esTimer)
    _esTimer = setTimeout(refreshEsTerm, 120)
  }, { immediate: true })

  async function computeXpi() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true
    try {
      const satDb = xpi.satSource === 'grd' ? numOr(xpi.satGrdRatioDb, null) : numOr(xpi.satManualDb, null)
      const r = await api.interference.xpi({
        satellite: satDb == null ? null : { db: satDb, source: xpi.satSource === 'grd' ? 'grd' : 'manual' },
        earthStation: esDesc(),
        rain: numOr(xpi.rainXpdDb, null) == null ? null : { db: +xpi.rainXpdDb, source: 'p618' }
      })
      if (!r || !r.ok) { msg.value = '计算失败：' + ((r && r.error) || '未知错误'); xpi.result = null; return }
      xpi.result = r.result
      if (!r.result) msg.value = '三段全缺 —— 至少给一段才能合成'
    } finally { busy.value = false }
  }

  // ---------------------------------------------------------------------------
  // 计算：C/CCI
  // ---------------------------------------------------------------------------
  async function computeCci() {
    const a = currentAntenna.value
    if (!a) { msg.value = '先选一副 GRD 方向图'; return }
    if (!api || !api.linkBudget) { msg.value = '需在桌面客户端中运行'; return }
    const pts = cci.points.filter((p) => Number.isFinite(+p.lon) && Number.isFinite(+p.lat))
    if (!pts.length) { msg.value = '至少给一个取值点'; return }
    busy.value = true; msg.value = ''
    try {
      const spec = antennaSpec(a)
      const r = await api.linkBudget.grdSampleCci({
        ...spec,
        points: pts.map((p) => ({ lon: +p.lon, lat: +p.lat })),
        colors: cci.colors,
        // 浅拷贝而不是直接给：手工指派存在 reactive 里，代理过不了 IPC 的结构化克隆（见 satGroupIds 的头注）
        coloring: cci.coloringOverride ? { ...cci.coloringOverride } : undefined,
        servingIdx: cci.servingIdx,
        floorDb: +cci.floorDb
      })
      if (!r || !r.ok) { msg.value = 'C/CCI 计算失败：' + ((r && r.error) || '未知错误'); cci.result = null; return }
      cci.result = {
        rows: pts.map((p, i) => ({ name: p.name || `点${i + 1}`, lon: +p.lon, lat: +p.lat, cciDb: r.cci[i], servingIdx: r.serving[i] })),
        coloring: r.coloring, beamIdx: r.beamIdx || [], colors: r.colors
      }
      const none = cci.result.rows.filter((x) => x.cciDb == null).length
      if (none === cci.result.rows.length) msg.value = '所有点都算不出 —— 检查站址是否落在方向图覆盖内，或该色下无同色波束'
    } finally { busy.value = false }
  }

  // C/CCI 覆盖场图：铺一张经纬网格逐格算 C/CCI。
  //
  // 为什么必须走 grdSampleCci 而不是逐波束取回来自己合成：一张 81×61 的网格是 4941 格 ×
  // 几十个波束 = 二十万个数，搬过 IPC 是纯浪费——合成只需要一个标量。主进程算完直接回一个
  // 长度 = 格数的数组（见 electron/services/grd.js 的 sampleCci）。
  const CCI_MAX_CELLS = 20000   // 格数上限：超了先拦下并给可操作建议（口径同覆盖分析）
  async function computeCciField() {
    const a = currentAntenna.value
    if (!a) { msg.value = '先选一副 GRD 方向图'; return }
    if (!api || !api.linkBudget) { msg.value = '需在桌面客户端中运行'; return }
    const b = cci.bounds
    const step = Math.max(0.05, +cci.fieldStep || 1)
    const nx = Math.floor((+b.lonMax - +b.lonMin) / step) + 1
    const ny = Math.floor((+b.latMax - +b.latMin) / step) + 1
    if (!(nx > 1 && ny > 1)) { msg.value = '经纬范围不合法'; return }
    if (nx * ny > CCI_MAX_CELLS) {
      msg.value = `网格 ${nx}×${ny} = ${(nx * ny).toLocaleString()} 格过多（上限 ${CCI_MAX_CELLS.toLocaleString()}）——增大步长或缩小范围`
      return
    }
    busy.value = true; msg.value = `C/CCI 场计算… ${nx}×${ny} 格`
    try {
      const xs = new Float64Array(nx), ys = new Float64Array(ny)
      for (let i = 0; i < nx; i++) xs[i] = +b.lonMin + i * step
      for (let j = 0; j < ny; j++) ys[j] = +b.latMin + j * step
      const pts = []
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push({ lon: xs[i], lat: ys[j] })
      const spec = antennaSpec(a)
      const r = await api.linkBudget.grdSampleCci({
        ...spec, points: pts,
        colors: cci.colors, coloring: cci.coloringOverride ? { ...cci.coloringOverride } : undefined,
        servingIdx: cci.servingIdx, floorDb: +cci.floorDb
      })
      if (!r || !r.ok) { msg.value = 'C/CCI 场计算失败：' + ((r && r.error) || '未知错误'); cci.field = null; return }
      // 算不出的格（域外 / 无同色波束）留 NaN —— LbSurfacePlot 会留白，绝不涂色
      const z = new Float64Array(nx * ny)
      let n = 0
      for (let k = 0; k < z.length; k++) { const v = r.cci[k]; z[k] = v == null ? NaN : v; if (v != null) n++ }
      cci.field = { xs, ys, nx, ny, z, coloring: r.coloring, beamIdx: r.beamIdx || [], colors: r.colors, valid: n }
      msg.value = n ? `C/CCI 场完成：${nx}×${ny} 格，${n} 格有值` : '整张图都算不出——检查方向图覆盖范围与复用色数（色数≥波束数时没有同色波束）'
    } finally { busy.value = false }
  }

  // ---------------------------------------------------------------------------
  // 计算：NGSO 时变（长任务：启动 → 进度 → 结果）
  // ---------------------------------------------------------------------------
  function ngsoPayload() {
    // 来源三取一：
    //   'cc:' 自定义星座 → 逐颗六根数（合成星没有 TLE，主进程也读不到那份 localStorage）；
    //   其余 group      → 主进程按 key 解析星历，satIds 只对「我的卫星组」有意义（其余为 undefined）；
    //   walker         → 只有设计参数时的方案比选。
    // 出 IPC 的东西一律现造纯对象/纯数组（切断任何响应式代理），口径同本文件其余几处 payload：
    // 结构化克隆搬不动 Vue 的代理，一旦漏进去就是 invoke 当场抛（见 satGroupIds 的头注）。
    const grp = (g) => {
      if (g.source === 'group' && String(g.group || '').startsWith('cc:')) {
        const cc = ccSats[g.group] || []
        return {
          source: 'elements', name: groupLabel(g.group), limit: numOr(g.limit, undefined),
          epoch: (cc[0] && cc[0].epoch) || undefined,
          sats: cc.map((s) => ({
            noradId: s.noradId, name: s.name, epoch: s.epoch,
            elements: { altKm: +s.elements.altKm, ecc: +s.elements.ecc, incl: +s.elements.incl, raan: +s.elements.raan, argp: +s.elements.argp, ma: +s.elements.ma }
          }))
        }
      }
      return g.source === 'group'
        ? { source: 'group', group: g.group, limit: numOr(g.limit, undefined), satIds: satGroupIds[g.group] ? satGroupIds[g.group].map(String) : undefined }
        : { source: 'walker', name: g.name, altKm: +g.altKm, incl: +g.incl, planes: +g.planes, perPlane: +g.perPlane, phase: +g.phase, epoch: ngso.startIso || new Date().toISOString() }
    }
    return {
      station: { lon: +site.lon, lat: +site.lat, alt: +site.alt },
      rx: { diameterM: +site.rxDiameterM, efficiency: +site.rxEfficiency / 100, freqGHz: +site.rxFreqGHz },
      wanted: { ...grp(ngso.wanted), eirpDbW: +carrier.eirpDbW, bandwidthHz: +carrier.bandwidthHz, polarization: carrier.dnPolarization },
      interferers: ngso.interferers.filter((g) => g.enabled).map((g) => ({
        ...grp(g), id: g._id, name: g.name,
        eirpDensityDbWPerHz: numOr(g.eirpDensityDbWPerHz, null),
        polarization: g.polarization || undefined,
        xpdDb: numOr(g.xpdDb, undefined),
        selfSystem: !!g.selfSystem
      })),
      minElevDeg: +ngso.minElevDeg,
      startMs: ngso.startIso ? Date.parse(ngso.startIso) : Date.now(),
      horizonSec: +ngso.horizonH * 3600,
      stepSec: +ngso.stepSec,
      patternKind: ngso.patternKind,
      applyPolarization: ngso.applyPolarization
    }
  }

  async function estimateNgso() {
    if (!api || !api.interference) return
    try {
      const r = await api.interference.ngsoEstimate(ngsoPayload())
      ngso.estimate = r && r.ok ? r : null
      if (r && !r.ok) msg.value = r.error || ''
    } catch (e) {
      ngso.estimate = null
      msg.value = '预估失败：' + ((e && e.message) || e)
    }
  }

  const NGSO_MAX_WORK = 3e7   // 星×样本 的上限；超过先拦下并给可操作建议（口径同覆盖分析）
  let _ngsoToken = 0

  async function computeNgso() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    await estimateNgso()
    const est = ngso.estimate
    if (est && est.work > NGSO_MAX_WORK) {
      msg.value = `计算量过大（${est.wantedCount + est.interfererCount} 颗星 × ${Math.round(+ngso.horizonH * 3600 / +ngso.stepSec)} 采样 = ${est.work.toLocaleString()}）——请缩短时窗 / 增大步长 / 减少干扰星数`
      return
    }
    busy.value = true; ngso.result = null; ngso.progress = 0; msg.value = '扫描中…'
    let r = null
    try { r = await api.interference.ngsoStart(ngsoPayload()) }
    catch (e) { busy.value = false; msg.value = '启动出错：' + ((e && e.message) || e); return }
    if (!r || !r.ok) { busy.value = false; msg.value = '启动失败：' + ((r && r.error) || '未知错误'); return }
    _ngsoToken = r.token
    ngso.progressTotal = r.T
    if (r.warnings && r.warnings.length) msg.value = r.warnings[0]
  }

  async function cancelNgso() {
    if (api && api.interference) await api.interference.ngsoCancel()
    _ngsoToken = 0; busy.value = false; msg.value = '已取消'
  }

  // 订阅主进程推回的进度与结果（窗口生命周期内只订一次）
  if (api && api.interference && api.interference.onNgsoProgress) {
    api.interference.onNgsoProgress((p) => {
      if (!p || p.token !== _ngsoToken) return
      ngso.progress = p.done; ngso.progressTotal = p.total
      msg.value = `扫描中… ${p.done} / ${p.total}`
    })
    api.interference.onNgsoDone((p) => {
      if (!p || p.token !== _ngsoToken) return
      busy.value = false
      if (!p.ok) { msg.value = '扫描失败：' + (p.error || '未知错误'); return }
      ngso.result = p.result
      const w = (p.result.warnings || [])[0]
      msg.value = w || `完成（${p.result.elapsedMs} ms，${p.result.samples} 个有效样本）`
    })
  }

  // ---------------------------------------------------------------------------
  // 星历接入：邻星搜索 + 星座组
  // ---------------------------------------------------------------------------
  //
  // 邻星轨位不该让人去别处查了再手抄——软件里本就有 GEO 星历。搜索按「与本星轨位的经度差」
  // 排序，最近的排最前，正是 C/ASI 关心的次序。
  const satSearch = reactive({ open: false, q: '', spanDeg: 15, busy: false, iso: '', hits: [], msg: '' })

  async function searchNeighbors() {
    if (!api || !api.interference || !api.interference.geoNeighbors) { satSearch.msg = '需在桌面客户端中运行'; return }
    satSearch.busy = true; satSearch.msg = ''
    try {
      const r = await api.interference.geoNeighbors({
        lonDeg: +carrier.satLonDeg, spanDeg: +satSearch.spanDeg, q: satSearch.q, online: false
      })
      if (!r || !r.ok) { satSearch.hits = []; satSearch.msg = '搜索失败：' + ((r && r.error) || '未知'); return }
      satSearch.hits = r.sats || []
      satSearch.iso = r.iso || ''
      satSearch.msg = satSearch.hits.length
        ? `本星 ${carrier.satLonDeg}°E 两侧 ±${satSearch.spanDeg}° 内 ${r.count} 颗（按经度差排序）`
        : `两侧 ±${satSearch.spanDeg}° 内没搜到——放宽范围，或先在主窗口「星座」页加载 GEO 组`
    } finally { satSearch.busy = false }
  }

  // 把搜到的星加成干扰源。EIRP 密度星历里没有，留空由用户填——这是唯一必须人工给的量。
  function addNeighbor(s) {
    if (!s) return
    if (asi.sources.some((x) => x.name === s.name)) { satSearch.msg = `「${s.name}」已在表里`; return }
    asi.sources.push(blankSource({
      name: s.name, lonDeg: s.lonDeg,
      polarization: carrier.dnPolarization,
      diameterM: site.rxDiameterM, powerW: site.txPowerW, bandwidthHz: carrier.bandwidthHz, feederLossDb: site.txFeederLossDb
    }))
    satSearch.msg = s.inclined
      ? `已加入「${s.name}」（${s.lonDeg}°E）—— 该星星下点纬度 ${s.latDeg}°，有倾角残余，按赤道面圆轨道近似算 C/ASI 会有偏差`
      : `已加入「${s.name}」（${s.lonDeg}°E）—— 请补它的下行 EIRP 密度`
  }

  // NGSO 星座组 + 各组的实参统计（选了真实星座就不必再填根数，这些数由星历直接给出）
  //
  // 四类来源合成一个列表，key 自带前缀区分（口径见主进程 interference.js 的 parseKey）：
  //   裸 key        CelesTrak 编目组      主进程给
  //   'custom:<id>' 文件管理导入的星历组   主进程给（记录在 custom.json）
  //   'sg:<id>'     星座页「我的卫星组」   本层给 —— 组存在渲染端 localStorage，主进程看不到
  //   'cc:<id>'     星座页「自定义星座」   本层给 —— 同上，且星是按 Walker 参数合成的（无 TLE）
  const ngsoGroups = ref([])
  const groupStats = ref({})          // key → { count, altKmMin/Max/Med, inclMin/Max/Med, periodMin, shells }
  const groupsErr = ref('')           // 主进程那两段取不回来时的原因（空段不能静默消失，见 CiApp 的下拉）

  // ⚠️ 这两张表**故意不是 ref/reactive**：它们的内容要原样过 IPC，而 Vue 的响应式代理
  // （ref({...}) 会深层 reactive）**结构化克隆不了** —— ipcRenderer.invoke 直接抛
  // 「[object Array] could not be cloned」。曾经这里是 ref：于是选「我的卫星组」时
  // loadGroup 一调就抛，ensureGroup 只有 try/finally 没有 catch，异常成了没人接的 promise
  // rejection，界面停在「载入星座…」再没有下文——看起来就是「这一段选不了」（编目星座那段
  // 因为 satIds 是 undefined 反而一直是好的，故障看着更像「只有我的组坏了」）。
  // 界面一个字都不用它俩，没有任何理由让它们进响应式系统。
  let satGroupIds = {}                // 'sg:<id>' → [NORAD]；payload 与 loadGroup 都要随请求带过去
  let ccSats = {}                     // 'cc:<id>' → [{ noradId, name, elements, epoch }]；同上

  // 「我的卫星组」：星座页的组管理器只记录 NORAD + 名称（见 viz/constellation/useSatGroups.js）。
  // 本窗口与主窗口同源，localStorage 直接读得到；成员的 satrec 由主进程从 active 全量编目
  // + 自定义星历解析回来——这里不碰星历，只负责把编目号带过去。
  const SAT_GROUPS_KEY = 'constellation3d/satGroups'
  function readSatGroups() {
    try {
      const blob = JSON.parse(localStorage.getItem(SAT_GROUPS_KEY) || 'null')
      if (!blob || !Array.isArray(blob.items)) return []
      return blob.items
        .map((g) => ({
          id: g && g.id,
          name: (g && g.name) || '卫星组',
          satIds: ((g && g.sats) || []).map((s) => String((s && s.id) || '')).filter(Boolean)
        }))
        .filter((g) => g.id && g.satIds.length)      // 空组不列：选了也算不出东西
    } catch (e) { return [] }                        // 隐私模式 / 坏数据 → 当作没有
  }

  // 「自定义星座」：星座页 Walker 生成器建的合成星座（useCustomConstellations.js）。这类星没有 TLE，
  // 只有一组设计参数——在此按同一份 generateConstellation 展开成逐颗经典六根数，连同**场景历元**
  // （resolveScenarioEpoch，与 3D 页同规则）一起交给引擎。历元不透传的话，合成星在地固系的指向
  // 会与星座3D 页看到的不是同一回事（同一个坑 satSearchPool.js 的头注里也记着）。
  const CUSTOM_CONSTS_KEY = 'constellation3d/customConsts'
  const CC_NORAD_BASE = 900000, CC_NORAD_STEP = 10000
  function readCustomConsts() {
    try {
      const blob = JSON.parse(localStorage.getItem(CUSTOM_CONSTS_KEY) || 'null')
      if (!blob || !Array.isArray(blob.items)) return []
      const epoch = resolveScenarioEpoch(blob)
      const out = []
      let base = CC_NORAD_BASE
      for (const c of blob.items) {
        if (!c || !c.id) continue
        const b = Number.isFinite(c.noradBase) ? c.noradBase : base
        base += CC_NORAD_STEP
        // 参数不合法的座不列（近地点 0 / 面数大于总数…）：generateConstellation 对这类入参会
        // 兜底成一颗高度 0 的星，列出来只会让人选到一个算不出东西的东西。判据用向导那套
        // validateWalker，与「生成」按钮同一把尺子。
        let gen = []
        try { if (validateWalker(c.params || {}).ok) gen = generateConstellation(c.params || {}) } catch (e) { gen = [] }
        if (!gen.length) continue                    // 参数生成不出星：与空组同办，不列
        const name = String((c.name || '自定义星座')).trim() || '自定义星座'
        out.push({
          id: c.id, name, epoch,
          sats: gen.map((s, i) => ({ noradId: b + i, name: s.name || `${name}-${i + 1}`, elements: s.elements, epoch }))
        })
      }
      return out
    } catch (e) { return [] }
  }

  async function loadNgsoGroups() {
    // 渲染端那两段（我的卫星组 / 自定义星座）先就位：主进程那两段取不回来也不该把它们一起丢掉
    const mine = readSatGroups()
    const consts = readCustomConsts()
    satGroupIds = Object.fromEntries(mine.map((g) => [`sg:${g.id}`, g.satIds]))
    ccSats = Object.fromEntries(consts.map((c) => [`cc:${c.id}`, c.sats]))
    const list = [
      ...mine.map((g) => ({ key: `sg:${g.id}`, label: g.name, count: g.satIds.length, available: true, kind: 'satgroup' })),
      ...consts.map((c) => ({ key: `cc:${c.id}`, label: c.name, count: c.sats.length, available: true, kind: 'ccustom' }))
    ]
    groupsErr.value = ''
    if (api && api.interference && api.interference.groups) {
      try {
        const r = await api.interference.groups()
        if (r && r.ok) list.push(...r.groups)
        else groupsErr.value = (r && r.error) || '主进程没给出星座列表'
      } catch (e) {
        // 早先这里没有 try：IPC 一抛，整个 loadNgsoGroups 连带下面的赋值一起 reject，
        // 下拉就永远是空的、且一个字的提示都没有（未捕获的 promise 静默失败）。
        groupsErr.value = (e && e.message) || String(e)
      }
    } else groupsErr.value = '需在桌面客户端中运行（编目星座与自定义星历经 IPC 取）'
    ngsoGroups.value = list
  }

  const groupLabel = (key) => {
    const g = ngsoGroups.value.find((x) => x.key === key)
    return (g && g.label) || key
  }

  async function ensureGroup(key, online) {
    if (!api || !api.interference || !key) return
    busy.value = true; msg.value = `载入星座「${groupLabel(key)}」…`
    try {
      const r = await api.interference.loadGroup(key, !!online, satGroupIds[key], ccSats[key])
      await loadNgsoGroups()
      if (r && r.ok) {
        if (r.stats) groupStats.value = { ...groupStats.value, [key]: r.stats }
        msg.value = `星座「${groupLabel(key)}」已载入 ${r.count} 颗（来源：${r.source || '缓存'}）`
          + (r.missing ? ` —— 另有 ${r.missing} 颗在编目与自定义星历里都找不到，已跳过` : '')
      } else msg.value = '载入失败：' + ((r && r.error) || '未知')
    } catch (e) {
      // 没有这个 catch 的时候，IPC 一抛就没人接，界面永远停在「载入星座…」——错在哪看不出来
      msg.value = `星座「${groupLabel(key)}」载入出错：${(e && e.message) || e}`
    } finally { busy.value = false }
  }

  // 列表要能重取：干扰分析是**单例窗口**（关掉才会重新 mount），而卫星组 / 自定义星座是在主窗口
  // 「星座」页里随时增删的。只在 onMounted 取一次的话，开着本窗口去建的组永远进不来——用户看到的
  // 就是「我明明建了组，这儿选不到」。两条路一起兜：
  //   ① storage 事件：同源的另一个窗口写 localStorage 时本窗口会收到 → 建完组立刻出现在下拉里；
  //   ② 窗口重新获得焦点：从主窗口切回来就再读一次（storage 事件在个别情形下不触发时的兜底）。
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (e) => {
      if (!e || (e.key !== SAT_GROUPS_KEY && e.key !== CUSTOM_CONSTS_KEY)) return
      loadNgsoGroups()
    })
    window.addEventListener('focus', () => { loadNgsoGroups() })
  }

  // ---------------------------------------------------------------------------
  // 干扰源表格增删 + 从卫星库带入
  // ---------------------------------------------------------------------------
  function addSource() { asi.sources.push(blankSource({ name: `邻星 ${asi.sources.length + 1}` })) }
  function removeSource(id) { const i = asi.sources.findIndex((s) => s._id === id); if (i >= 0) asi.sources.splice(i, 1) }
  function addFromLibrary(entry) {
    if (!entry) return
    const f = entry.form || {}
    asi.sources.push(blankSource({
      name: entry.name || '库条目',
      lonDeg: f.orbitPosition != null && f.orbitPosition !== '' ? f.orbitPosition : '',
      polarization: f.downlinkPolarization || '',
      bandwidthHz: f.transponderBandwidth ? Number(f.transponderBandwidth) * 1e6 : ''
    }))
    msg.value = `已从卫星库带入「${entry.name}」——EIRP 密度需自行填写（库里存的是 SFD/转发器参数，不含邻网谱密度）`
  }
  function addCciPoint() { cci.points.push({ _id: 'p' + (_srcSeq++), name: `点${cci.points.length + 1}`, lon: '', lat: '' }) }
  function removeCciPoint(id) { const i = cci.points.findIndex((p) => p._id === id); if (i >= 0) cci.points.splice(i, 1) }
  function addNgsoGroup() {
    ngso.interferers.push({ _id: 'ng' + (_srcSeq++), enabled: true, source: 'group', group: '', limit: 200, name: `干扰星座 ${ngso.interferers.length + 1}`, altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1, eirpDensityDbWPerHz: -48, polarization: 'H', xpdDb: '', selfSystem: false, group: '' })
  }
  function removeNgsoGroup(id) { const i = ngso.interferers.findIndex((g) => g._id === id); if (i >= 0) ngso.interferers.splice(i, 1) }

  // ---------------------------------------------------------------------------
  // 持久化（面板态一键存取，仿 useVisibility）
  // ---------------------------------------------------------------------------
  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        mode: mode.value,
        site: { ...site }, carrier: { ...carrier },
        asi: { applyPolarization: asi.applyPolarization, uplinkMode: asi.uplinkMode, sources: asi.sources, coordLonDeg: asi.coordLonDeg, coordGoverT: asi.coordGoverT, coordRxGain: asi.coordRxGain },
        xpi: {
          satSource: xpi.satSource, satManualDb: xpi.satManualDb, rainXpdDb: xpi.rainXpdDb,
          esMode: xpi.esMode, earthStationDb: xpi.earthStationDb, esArDb: xpi.esArDb,
          esCoDb: xpi.esCoDb, esXpolDb: xpi.esXpolDb, esAlignOn: xpi.esAlignOn, esAlignDeg: xpi.esAlignDeg
        },
        cci: { antennaKey: cci.antennaKey, colors: cci.colors, floorDb: cci.floorDb, points: cci.points, coloringOverride: cci.coloringOverride, bounds: cci.bounds, fieldStep: cci.fieldStep },
        ngso: { minElevDeg: ngso.minElevDeg, horizonH: ngso.horizonH, stepSec: ngso.stepSec, patternKind: ngso.patternKind, applyPolarization: ngso.applyPolarization, thresholdDb: ngso.thresholdDb, wanted: ngso.wanted, interferers: ngso.interferers }
      }))
    } catch (e) { /* 配额/隐私模式 */ }
  }
  function load() {
    let d = null
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null') } catch (e) { return }
    if (!d) return
    if (MODES.some((m) => m.key === d.mode)) mode.value = d.mode
    Object.assign(site, d.site || {})
    Object.assign(carrier, d.carrier || {})
    if (d.asi) {
      asi.applyPolarization = d.asi.applyPolarization !== false
      if (['peer', 'mask', 'explicit'].includes(d.asi.uplinkMode)) asi.uplinkMode = d.asi.uplinkMode
      if (Array.isArray(d.asi.sources) && d.asi.sources.length) asi.sources.splice(0, asi.sources.length, ...d.asi.sources)
      asi.coordLonDeg = d.asi.coordLonDeg ?? asi.coordLonDeg
      asi.coordGoverT = d.asi.coordGoverT ?? asi.coordGoverT
      asi.coordRxGain = d.asi.coordRxGain ?? asi.coordRxGain
    }
    if (d.xpi) Object.assign(xpi, d.xpi)
    if (d.cci) {
      Object.assign(cci, { antennaKey: d.cci.antennaKey || '', colors: d.cci.colors || 4, floorDb: d.cci.floorDb ?? 60, coloringOverride: d.cci.coloringOverride || null, fieldStep: d.cci.fieldStep ?? 1 })
      if (d.cci.bounds) Object.assign(cci.bounds, d.cci.bounds)
      if (Array.isArray(d.cci.points) && d.cci.points.length) cci.points.splice(0, cci.points.length, ...d.cci.points)
    }
    if (d.ngso) {
      Object.assign(ngso, { minElevDeg: d.ngso.minElevDeg ?? 10, horizonH: d.ngso.horizonH ?? 6, stepSec: d.ngso.stepSec ?? 10, patternKind: d.ngso.patternKind || 'average', applyPolarization: d.ngso.applyPolarization !== false, thresholdDb: d.ngso.thresholdDb ?? 15 })
      if (d.ngso.wanted) Object.assign(ngso.wanted, d.ngso.wanted)
      if (Array.isArray(d.ngso.interferers) && d.ngso.interferers.length) ngso.interferers.splice(0, ngso.interferers.length, ...d.ngso.interferers)
    }
  }

  watch([mode, site, carrier, asi, xpi, cci, ngso], persist, { deep: true })

  // 干扰几何两张图的数据：下行 = 本站接收天线方向图；上行 = 干扰站离轴 EIRP 密度 + S.524 掩模。
  // 曲线一概由引擎给，这里只做形状搬运——渲染端复算方向图必与引擎漂移。
  const geoData = computed(() => {
    const d = asi.result && asi.result.downlink
    const u = asi.result && asi.result.uplink
    const dg = (d && d.geometry) || null
    const ug = (u && u.geometry) || null
    return {
      down: dg ? {
        sources: d.sources || [],
        peakGainDbi: dg.peakGainDbi,
        beamwidth3dBDeg: dg.beamwidth3dBDeg,
        patternCurve: dg.patternCurve || [],
        patternMarks: dg.patternMarks || []
      } : null,
      up: ug ? {
        sources: u.sources || [],
        sourceMode: ug.sourceMode,
        ownDensityDbWPerHz: ug.ownDensityDbWPerHz,
        maskCurve: ug.maskCurve || [],
        maskMarks: ug.maskMarks || [],
        maskBand: ug.maskBand,
        maskAuthoritative: !!ug.maskAuthoritative,
        maskPhi0Deg: ug.maskPhi0Deg,
        peerCurves: ug.peerCurves || []
      } : null
    }
  })

  const hoveredId = ref('')
  function setHover(id) { hoveredId.value = id || '' }

  return {
    MODES, REUSE_COLORS,
    mode, busy, msg, site, carrier, asi, xpi, cci, ngso,
    satLib, grdTree, grdAntennas, currentAntenna,
    satSearch, searchNeighbors, addNeighbor,
    ngsoGroups, groupStats, groupsErr, loadNgsoGroups, ensureGroup,
    loadLibraries, loadGrdTree, importGrdHere,
    computeAsi, computeXpi, computeCci, computeCciField, sampleXpiFromGrd,
    computeNgso, cancelNgso, estimateNgso,
    addSource, removeSource, addFromLibrary,
    addCciPoint, removeCciPoint, addNgsoGroup, removeNgsoGroup,
    geoData, hoveredId, setHover, load, persist
  }
}
