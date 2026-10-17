// 干扰分析（C/I）—— 组合式逻辑层（仿 viz/vis/useVisibility.js）。
//
// 职责：四种模式的面板状态 + 调用主进程引擎 + 结果整形 + 持久化。
// 物理一概不在这里：全部经 window.api.interference.* 走 IPC 到 packages/core/utils/interference/。
// 渲染端不重写任何公式，也不维护 ESM 镜像——干扰的口径全靠 ITU 建议书钉死，两份实现必然漂移。
//
// 本模块是**只读消费者**：读三库（store.getLibrary）与 GRD 树，从不写回。算出来的 C/I
// 要用到链路预算里，由使用者自己搬——这是「只看不回填」的既定取舍，别在这里偷偷写库。

import { ref, reactive, computed, watch, markRaw } from 'vue'
// 「自定义星座」（星座页 Walker 生成器）：放置公式与场景历元一律复用星座3D 页那两个模块，
// 绝不在本窗口另写一遍——NGSO 链路预算的搜索池（ngso/satSearchPool.js）也是这么接的。
import { generateConstellation, validateWalker } from '../viz/constellation/walker.js'
import { resolveScenarioEpoch } from '../viz/constellation/useCustomConstellations.js'
import { customConstParams } from '../viz/constellation/customConstGen.js'   // 轨道向导地固 / 日固设计量按场景历元重解（与 3D 页同一出口）
import { fmtGeoSlot } from '../shared/orbitClass.js'   // 轨位 °E/°W 折算（西经不再写成负°E）
import { sceneNowMs } from '../shared/sceneClock.js'   // 「当前时刻」＝主窗口时间轴上的此刻（全软件一条时间线）
import { reportError, reportPartial } from '../shared/reportError.js'   // 失败进本窗通知条（CiApp 的 useNotice 登记出口）

const KEY = 'ci/panel'
const KEY_CI = 'ci/grdSats'          // 本窗口导入的方向图清单（不随配置走：是清单本身，不是界面偏好）
const CI_NODE = 'ci:analysis'        // 本窗口导入的方向图统一挂在这个节点下
const minuteIso = (ms) => new Date(Math.floor(ms / 60000) * 60000).toISOString()   // 取整分的 ISO（UTC）
// NGSO 面板态的版本号。v2 = 「抽样上限」的出厂默认由 200 改成留空（全量），见 load() 里的迁移。
const NGSO_STATE_V = 2

// 引擎告警上屏只留状态：按「；」「。」分段，去掉操作建议与口径解释段（引擎侧原文不动，导出/日志照旧）
const ADVICE_SEG = /^(若需|如需|建议|请|需增加|将步长降至|事件表已另按|AP8 为|尾部统计量|历元分散|块数这么少)/
function stateOnly(w) {
  const raw = String(w || '')
  const segs = raw.split(/[；。]/).map((x) => x.trim()).filter(Boolean)
  const kept = segs.map((x) => x.replace(/，(若需|如需|建议|请|需增加|块数这么少|将步长降至)[\s\S]*$/, '')).filter((x) => !ADVICE_SEG.test(x))
  if (!kept.length || (kept.length === segs.length && kept.every((x, i) => x === segs[i]))) return raw
  return kept.join('；') + '。'
}
const api = typeof window !== 'undefined' ? window.api : null

// 前四页算邻网对本网的干扰（C/I）；协调触发反过来算本网对邻网的 ΔT/T，排在最后
export const MODES = [
  { key: 'asi', label: 'C/ASI 邻星', tip: 'GEO 邻星对本网的干扰：下行取邻星下行 EIRP 密度，上行取邻网发端站的离轴 EIRP 密度' },
  { key: 'cci', label: 'C/CCI 同频', tip: '多波束同频干扰：选目标波束与其同频同极化波束，按 GRD 方向图在目标覆盖区内逐点算' },
  { key: 'xpi', label: 'C/XPI 极化', tip: '交叉极化：卫星侧(GRD P1/P2) ⊕ 地球站侧 ⊕ 雨致去极化 三源合成' },
  { key: 'ngso', label: 'NGSO 时变', tip: 'NGSO 干扰是随机过程：逐时刻扫描出 C/I 的 CDF 与 in-line 事件' },
  { key: 'ap8', label: '协调触发', tip: 'RR 附录 8 式(1)–(3)：本网对邻网的 ΔT/T（同频段、同传输方向）' }
]

// C/ASI 地球站方向图的可选 ID（与引擎 patterns.ES_PATTERNS 的键同表；读回配置时据此校验）
export const ES_PATTERN_IDS = ['S.465-6', 'RR-AP8-A3', 'S.580-6', 'S580-HYB']

let _srcSeq = 1
const blankSource = (o) => ({
  _id: 'is' + (_srcSeq++),
  enabled: true,
  name: '',
  lonDeg: '',
  eirpDensityDbWPerHz: '',
  polarization: '',                  // 邻星下行极化
  // 干扰载波的上行极化：留空 = 沿用下行的同/反极化关系（引擎 ciAsi.resolveUplinkPolarization 推定）。
  // 老配置的行没有这个字段，一律按留空算——从前上行拿下行极化去比，出厂配置因此多算 25 dB
  upPolarization: '',
  xpdDb: '',
  overlapFactor: '',
  // 上行 C/ASI 只吃这一个量：邻网地球站朝本星方向的离轴 EIRP 密度（下行吃上面的邻星下行 EIRP 密度）
  offAxisEirpDensityDbWPerHz: '',
  ...o
})

/**
 * 主窗口带来的上下文（地图右键 / 卫星信息栏「分析 ▸ 干扰分析」）写进一份配置内容 → 新的配置内容。
 * 纯函数，不碰 cur：窗口拿结果与当前内容比，不同才另建一份配置承接（平台约定带上下文不改动现有配置，见 CiApp）。
 *   GSO 星（有定点轨位的）→ 本链路的期望星轨位（两位小数）与星名；站（取第一个）→ 本站站名与站址；其余内容原样。
 *   停在 C/CCI 页（不吃本站与本链路）的换到 C/ASI，免得写了看不见。
 * 返回 { state, parts }（parts＝读数行的「星名 · 站名」）；既没带可用的星也没带站 → null。
 */
export function toolContextState(cur, c) {
  if (!cur || !c) return null
  const sat = c.sat && c.sat.slotLon != null && Number.isFinite(Number(c.sat.slotLon)) ? c.sat : null
  const s = c.sites && c.sites[0]
  if (!sat && !s) return null
  const st = JSON.parse(JSON.stringify(cur))
  st.site = st.site || {}; st.carrier = st.carrier || {}
  const parts = []
  if (sat) {
    st.carrier.satLonDeg = Math.round(Number(sat.slotLon) * 100) / 100
    st.carrier.satName = sat.name || ''
    parts.push(sat.name || fmtGeoSlot(st.carrier.satLonDeg))
  }
  if (s) {
    st.site.name = s.name || st.site.name
    st.site.lat = s.lat; st.site.lon = s.lon
    parts.push(st.site.name)
  }
  if (st.mode === 'cci') st.mode = 'asi'
  return { state: st, parts }
}

export function useInterference() {
  const mode = ref('asi')
  const busy = ref(false)
  const msg = ref('')
  // 结果代次：换了一份配置（clearResults）就 +1。各计算开算时记下，回包时代次变了就丢——
  // 否则切走之后上一份迟到的结果照样落进这一份
  let _gen = 0

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

  // ---- C/ASI（邻网对本网：上行 = 邻网地球站离轴 EIRP 密度进本星，下行 = 邻星下行 EIRP 密度进本站）----
  const asi = reactive({
    applyPolarization: true,
    // 收信站参考方向图 ID（引擎 patterns.ES_PATTERNS），下行算本站天线对邻星方向的鉴别度用。缺省 ITU-R S.465-6——
    // 老配置没有这个字段，一律按缺省算（2026-10-17 订正：此前写死的「AP8/S.580」近旁瓣低 3–9 dB）
    esPattern: 'S.465-6',
    // 出厂上行离轴 EIRP 密度 −42.3 dBW/Hz：4.5 m、40 W、36 MHz 的同类站按 S.465-6 在 2.81° 处的旁瓣密度（原对等站模式的出厂值）
    sources: [
      blankSource({ name: '邻星 A', lonDeg: 113, eirpDensityDbWPerHz: -45, polarization: 'H', offAxisEirpDensityDbWPerHz: -42.3 }),
      blankSource({ name: '邻星 B', lonDeg: 108, eirpDensityDbWPerHz: -45, polarization: 'H', offAxisEirpDensityDbWPerHz: -42.3 })
    ],
    result: null
  })

  // ---- 协调触发（RR 附录 8 式(1)–(3) 原式，本网 → 邻网）----
  // 只放原式里的量（dB 值，T 用 K）：带撇号的属施扰方 = 本网，不带撇号的属受扰方 = 邻网。不取「本站与本链路」，
  // 不做几何 / 方向图推算。出厂取附录 8 附件 4 算例（ΔTs 145 K、ΔTe 3.6 K、ΔT/T 7.8%），可直接与原文对账。
  const AP8_DEF = { PeDb: -37, G1Dbi: 14.5, G2Dbi: 15.5, LuDb: 200, PsDb: -57, G3Dbi: 15.5, G4Dbi: 14.5, LdDb: 196, gammaDb: -15, TK: 105 }
  const ap8 = reactive({ ...AP8_DEF, result: null })

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
    // 雨致 XPD：'p618' 按本站、本星轨位、频率、极化与 p% 走平台雨衰核（P.618-14 §4.1）| 'manual' 手填（rainXpdDb）
    rainSource: 'p618',
    rainPct: 0.01,                    // 时间百分比 p（%）
    rainDir: 'down',                  // 取下行（收信频率 / 下行极化）还是上行（发信频率 / 上行极化）
    rainXpdDb: 22,
    rainInfo: null,                   // 引擎回的雨致 XPD 取值明细（仰角 / τ / R0.01 / Ap …）
    curve: null,                      // XPI 随时间百分比 [{pct, rainXpdDb, xpiDb}]
    result: null
  })

  // ---- C/CCI（目标波束：选一个目标波束、勾它的同频同极化波束，覆盖区内逐点算；口径见 core 的 interference/cciTarget.js）----
  const cci = reactive({
    antennaKey: '',                  // 选中的 GRD 天线（folder::name）；C/XPI 页的 GRD 取值共用这一项
    eocDb: 4,                        // 覆盖电平：覆盖区 = 目标波束不低于其峰值这么多
    picks: {},                       // 天线 key → { target: 原始下标 | null, co: [原始下标，升序] }
    tgtBeams: null,                  // 逐波束足迹 { key, level, beams:[{ idx, peakDb, peak, rings }] }（主进程回，不落盘）
    tgtBeamsErr: '',
    tgtResult: null,                 // 目标波束作业结果（不落盘）
    progress: 0, progressTotal: 0
  })

  // ---- NGSO ----
  const ngso = reactive({
    minElevDeg: 10,
    horizonH: 6,
    stepSec: 10,
    patternKind: 'average',
    applyPolarization: true,
    thresholdDb: 15,
    // 起始时刻（可自定义；不随配置存盘）：每次打开窗口取时间轴当前时刻（取整分），「此刻」再取一次；
    // 空串（旧调用方）= 计算时取时间轴当前时刻（sceneNowMs，本层填，引擎不碰 Date.now）。结束时刻 = 起始 + 时窗
    startIso: minuteIso(sceneNowMs()),
    inlineGuardDeg: '',              // 空 = 半功率半角（B4：in-line 由规避角定义，不由波束宽定义）
    // 历元编排（P3）。single = 单历元（旧行为）；repeat = 时窗按回归周期取；
    // monte-carlo = 在一条长基线上按 seed 抽 count 个起点，样本池合并出一条 CDF + 置信区间。
    epochs: { mode: 'single', count: 8, spanDays: 7, seed: 20260728, capDays: 7, convergeTolDb: 0.2, convergePct: 0.1 },
    // P4：噪声与门限。给了噪温才出 I/N、C/(N+I)、ΔT/T；门限留空的那一项就不算越限占比
    // （不编一个默认门限出来当结论——S.1323 的数值待官方 PDF 核对，见方案 §6）。
    noise: { mode: 'tsys', tSysK: 150, gOverTdBK: '' },
    criteria: { ciDb: '', iOverNDb: '', deltaTOverTPct: '' },
    // 可用度合成：干扰 CDF ⊗ 雨衰 CDF。雨衰分布走本平台的 P.618 引擎（NGSO 统计口径 §8）
    rain: { on: false, thresholdDb: 6, applyToInterference: 'none', cdf: null, cdfInfo: '' },
    // 卫星侧发射方向图与波束指向（A1）。默认 none = 各向同性满 EIRP = v1.3.6 行为（上界包络），
    // 旧面板态原样读回；改成 s1528/gaussian/grd 才开始计入卫星天线。
    satPattern: {
      mode: 'none', pointing: 'nadir',
      beamwidth3dBDeg: 4, peakGainDbi: '', s1528Section: '1.2', Ln: -25, farOutDbi: 0,
      satMode: 'LEO', dOverLambda: '', sidelobeFloorDb: -30,
      beamsPerSat: 32, cellSpacingKm: 200,
      coFreqFactor: 1,
      grdKey: '',                    // folder::name，与 C/CCI 页的天线树同源
      grdBeam: ''                    // 原始 GRD set 序号（0 基）；留空 = 全部波束取最大（上界）
    },
    // ★ 抽样上限默认**留空 = 全量**。首版默认 200，Starlink 这类星座下静默削掉 ~16 dB 聚合干扰，
    //   而且方向与「未计入卫星方向图」的高估反向、量级相近，默认配置下偶然对消——对上了也是巧合。
    //   算力由 estimateNgso + NGSO_MAX_WORK 去拦，拦下时建议缩短时窗 / 增大步长（只影响统计分辨率），
    //   减少干扰星数排在最后（那是直接伪造物理）。
    wanted: { source: 'group', group: '', limit: '', name: '本星座', altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1 },
    interferers: [
      { _id: 'ng1', enabled: true, source: 'group', group: '', limit: '', name: '干扰星座', altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1, eirpDensityDbWPerHz: -48, polarization: 'H', xpdDb: '', selfSystem: false }
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
    // 三体制各自独立的命名空间；干扰源取「卫星」那一类，三套都读进来供选。
    // ★ 链路预算各窗存库时卫星条目的键是 `sat`（serializeLibrary：{ es, carrier, sat, seq }，同 FileManager /
    //   model/satSources 的读法）；从前这里读 `satConfigs`（窗口里那个数组的变量名，不是存盘键），来源恒为空。
    //   老键一并认，免得哪份早期库文件真是那么存的。
    const out = []
    for (const ns of ['geo', 'ngso', 'regen']) {
      try {
        const lib = await api.store.getLibrary(ns)
        const list = (lib && Array.isArray(lib.sat) ? lib.sat : null) || (lib && Array.isArray(lib.satConfigs) ? lib.satConfigs : [])
        for (const s of list) {
          if (!s || !s.id) continue
          out.push({ ns, id: s.id, name: s.name || s.form?.satelliteName || s.id, form: s.form || {}, grd: s.grd || null })
        }
      } catch (e) { /* 该体制尚无库文件 */ }
    }
    satLib.value = out
  }

  // GRD 树三源合并：星座3D 页导入的 + 链路预算导入的 + 本窗口导入的
  // 星座3D 树里的实时星（关联星 / 轨道根数星）：星位取主窗口按时间轴此刻写的 globe3d/grdLive，覆盖存盘的旧快照
  // （口径逐字同链路预算 linkbudget/grdParam.js 的 loadSatTree：只认存盘树里此刻仍是实时星的节点；关联星此刻解不出星历 → noEph，不取值）。
  function loadGrdTree() {
    const read = (key, pick) => {
      try {
        const d = JSON.parse(localStorage.getItem(key) || 'null')
        return pick ? pick(d) : d
      } catch (e) { return null }
    }
    const nodes = []
    const g3 = read('globe3d/settings', (d) => d && d.grd)
    const lv = read('globe3d/grdLive')
    const live = (lv && lv.pos) || {}
    const gone = new Set(Array.isArray(lv && lv.noEph) ? lv.noEph.map(String) : [])
    for (const s of ((g3 && g3.sats) || [])) {
      const ants = (s.antennas || []).filter((a) => a && a.imported && a.file)
      if (!ants.length) continue
      const lp = (s.noradId || s.elements) ? live[s.folder] : undefined
      const noEph = !lp && !!s.noradId && gone.has(String(s.folder))
      const lon = lp ? Number(lp.lon) : (+s.lon || 0)
      const lat = lp ? Number(lp.lat) : (+s.lat || 0)
      const altKm = lp ? Number(lp.altKm) : (+s.altKm || 35786)
      // 实时星：天线基底也用实时星位（antennaSpec 先认天线记录里的 satLon/satLat/satAlt 快照）
      nodes.push({
        origin: '主窗口', folder: s.folder, satName: s.satName || s.folder, lon, lat, altKm, live: !!lp || noEph, noEph,
        antennas: lp ? ants.map((a) => ({ ...a, satLon: lon, satLat: lat, satAlt: altKm })) : ants
      })
    }
    for (const key of ['lb/grdSats', KEY_CI]) {
      const st = read(key)
      for (const s of ((st && st.sats) || [])) {
        const ants = (s.antennas || []).filter((a) => a && a.file)
        if (ants.length) nodes.push({ origin: key === KEY_CI ? '本窗口' : '链路预算', folder: s.folder, satName: s.satName || s.folder, lon: +s.lon || 0, lat: +s.lat || 0, altKm: +s.altKm || 35786, antennas: ants })
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

  /**
   * NGSO 卫星方向图选中的那副 GRD 的波束清单。
   *
   * 序号一律用**原始 GRD set 序号**（0 基）：星座3D 页删过波束的天线，其 cfg.keptSets 记的
   * 就是这个口径（见 grdSampler.makeSampleCtx），两处必须同源，否则删过波束的天线选出来的
   * 是另一个波束。没有 keptSets 就是 0..beams−1。
   */
  const ngsoGrdBeams = computed(() => {
    const a = grdAntennas.value.find((x) => x.key === ngso.satPattern.grdKey)
    if (!a) return []
    const cfg = grdTree.value.cfgs[a.node.folder + '::' + a.ant.name] || {}
    const kept = Array.isArray(cfg.keptSets) ? cfg.keptSets : null
    const idx = kept || Array.from({ length: Math.max(1, +a.ant.beams || 1) }, (_, i) => i)
    return idx.map((i) => ({ idx: i, label: `波束 ${i + 1}` }))
  })

  // 本窗口自己导入 GRD —— 与「引用已有」并列，不必非得从别处引
  async function importGrdHere() {
    if (!api || !api.coverageGrd || !api.coverageGrd.import) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true; msg.value = '选择 GRD 文件…'
    // 失败的逐个记下、最后一次报「n 成功 / m 失败：文件（原因）」—— 从前读不进的（f.error）直接跳过，
    // 「解析失败」又被后面那句「已导入」盖掉，用户看不到少了哪几副
    const failed = []
    try {
      const res = await api.coverageGrd.import()
      if (!res || res.canceled) { msg.value = ''; return }
      let st = null
      try { st = JSON.parse(localStorage.getItem(KEY_CI) || 'null') } catch (e) { st = null }
      if (!st || !Array.isArray(st.sats)) st = { sats: [] }
      // 本窗口导入的方向图不挂靠任何卫星库条目——干扰分析常要分析第三方/邻网的天线，
      // 那不是「我的某颗星」。统一落在一个分析用节点下。
      let node = st.sats.find((s) => s.folder === CI_NODE)
      if (!node) { node = { folder: CI_NODE, satName: '分析用方向图', lon: 0, lat: 0, altKm: 35786, antennas: [] }; st.sats.push(node) }
      // 卫星位置先沿用当前选中那副天线的（同一颗星的几副方向图常一起导入），视轴缺省天底；导入后在 C/CCI 页逐副改
      const refSat = currentAntenna.value ? antennaSpec(currentAntenna.value).sat : { lon: node.lon, lat: node.lat, alt: node.altKm }
      const added = []
      for (const f of (res.files || [])) {
        if (!f) continue
        const fname = String(f.base || f.file || f.name || '')
        if (f.error || !f.file) { failed.push({ name: fname, error: f.error || '读取失败' }); continue }
        let beams = 1
        try {
          const m = await api.linkBudget.grdMeta(f.file)
          if (m && m.ok && m.beams > 0) beams = m.beams
          else { failed.push({ name: fname, error: (m && m.error) || '解析失败' }); continue }
        } catch (e) { failed.push({ name: fname, error: e }); continue }
        let name = String(f.base || f.file).replace(/\.(grd|pat)$/i, '')
        while (node.antennas.some((a) => a.name === name)) name += '·'
        node.antennas.push({ name, file: f.file, beams, imported: true, satLon: refSat.lon, satLat: refSat.lat, satAlt: refSat.alt, cfg: { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 } })
        added.push(name)
      }
      // 这一份就是本窗口导入天线的清单本身（不只是界面偏好）：写不进去，重开窗口这几副就没了
      try { localStorage.setItem(KEY_CI, JSON.stringify(st)) } catch (e) { reportError('GRD 清单存盘失败', e) }
      loadGrdTree()
      if (added.length) {
        const first = grdAntennas.value.find((a) => a.ant.name === added[0])
        if (first) cci.antennaKey = first.key
        msg.value = `已导入 ${added.length} 副天线：${added.join('、')}`
      } else if (msg.value === '选择 GRD 文件…') msg.value = ''
      if (failed.length) reportPartial('导入 GRD', added.length, failed)
    } catch (e) {
      msg.value = ''
      reportError('导入 GRD', e)
    } finally { busy.value = false }
  }

  // 方向图的卫星几何 + 取值口径（与链路预算 grdParam.antennaSampleSpec 同口径）
  function antennaSpec(a, extraCfg) {
    if (!a) return null
    // 指向：主窗口的天线取 3D 页那份设置；本窗口导入的取天线记录自带的 cfg（见 setAntGeo）
    const cfg = { ...(a.ant.cfg || {}), ...(grdTree.value.cfgs[a.node.folder + '::' + a.ant.name] || {}), ...(extraCfg || {}) }
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

  // 本窗口导入的方向图不挂靠任何卫星库条目：卫星位置（轨位 / 纬度 / 高度）与视轴（指向模式 + 旋转）就在本窗口给，
  // 逐副记在 ci/grdSats 清单的天线记录上（satLon / satLat / satAlt + cfg）。主窗口 / 链路预算来的天线照它们那边的设置，这里只读。
  const antEditable = computed(() => !!(currentAntenna.value && currentAntenna.value.node.folder === CI_NODE))
  function setAntGeo(patch) {
    const a = currentAntenna.value
    if (!a || a.node.folder !== CI_NODE) return
    let st = null
    try { st = JSON.parse(localStorage.getItem(KEY_CI) || 'null') } catch (e) { st = null }
    const node = st && Array.isArray(st.sats) ? st.sats.find((x) => x.folder === CI_NODE) : null
    const ant = node && Array.isArray(node.antennas) ? node.antennas.find((x) => x.name === a.ant.name) : null
    if (!ant) return
    const p = patch || {}
    for (const k of ['satLon', 'satLat', 'satAlt']) if (k in p && Number.isFinite(+p[k])) ant[k] = +p[k]
    if (p.cfg) {
      const c = { ...(ant.cfg || {}) }
      for (const [k, v] of Object.entries(p.cfg)) c[k] = k === 'boreType' || k === 'boreMode' ? String(v) : (Number.isFinite(+v) ? +v : 0)
      ant.cfg = c
    }
    try { localStorage.setItem(KEY_CI, JSON.stringify(st)) } catch (e) { reportError('GRD 清单存盘失败', e); return }
    loadGrdTree()
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
      uplinkPolarization: s.upPolarization || undefined,   // 只有上行读；留空由引擎按下行关系推定
      xpdDb: numOr(s.xpdDb, undefined),
      overlapFactor: numOr(s.overlapFactor, undefined),
      offAxisEirpDensityDbWPerHz: numOr(s.offAxisEirpDensityDbWPerHz, undefined)
    }))
    // C/ASI 只算邻网对本网。本网对邻网的影响在「协调触发」页（附录 8 ΔT/T），这里不送
    return {
      downlink: {
        station,
        wanted: { lonDeg: +carrier.satLonDeg, eirpDbW: +carrier.eirpDbW, bandwidthHz: +carrier.bandwidthHz, polarization: carrier.dnPolarization },
        rx: { diameterM: +site.rxDiameterM, efficiency: +site.rxEfficiency / 100, freqGHz: +site.rxFreqGHz },
        interferers: srcs,
        applyPolarization: asi.applyPolarization,
        esPattern: asi.esPattern
      },
      uplink: {
        station,
        // 下行极化随带：源的上行极化留空时，引擎按「邻星下行 vs 本站下行」的关系推定上行
        wanted: { lonDeg: +carrier.satLonDeg, polarization: carrier.upPolarization, downlinkPolarization: carrier.dnPolarization },
        tx: { diameterM: +site.txDiameterM, efficiency: +site.txEfficiency / 100, freqGHz: +site.txFreqGHz, powerW: +site.txPowerW, feederLossDb: +site.txFeederLossDb, bandwidthHz: +carrier.bandwidthHz },
        interferers: srcs,
        // 上行干扰 = 邻网地球站朝本星方向的离轴 EIRP 密度，逐源直接给定（引擎 ciAsi.uplinkCAsi 的 explicit）
        sourceMode: 'explicit',
        applyPolarization: asi.applyPolarization
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 计算：协调触发（RR 附录 8 式(1)–(3)，引擎 interference/ap8Formula.js，走 ci:asi 通道 { downlink:false, ap8Formula }）
  // ---------------------------------------------------------------------------
  function ap8Payload() {
    const o = {}
    for (const k of Object.keys(AP8_DEF)) o[k] = numOr(ap8[k], null)
    return o
  }
  async function computeAp8() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    const gen = _gen
    const payload = ap8Payload()
    const fp = JSON.stringify(payload)
    const r = await api.interference.asi({ downlink: false, ap8Formula: payload })
    if (gen !== _gen) return
    if (!r || !r.ok || !r.ap8Formula) { msg.value = '计算失败：' + ((r && r.error) || '未知错误'); ap8.result = null; return }
    if (JSON.stringify(ap8Payload()) !== fp) return   // 回来前又改了格：等下一次（改格即重算，见下方监听）
    ap8.result = r.ap8Formula
    ranFp.ap8 = fp
    msg.value = r.ap8Formula.ok ? '' : '缺少输入：' + r.ap8Formula.missing.join('、')
  }
  // 改一格就重算（原式几步加减，主进程即回）；只在本页开着时算
  let _ap8T = null
  watch(() => (mode.value === 'ap8' ? JSON.stringify(ap8Payload()) : ''), (v) => {
    clearTimeout(_ap8T)
    if (v) _ap8T = setTimeout(computeAp8, 60)
  })

  async function computeAsi() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true; msg.value = ''
    const gen = _gen
    try {
      const payload = asiPayload()
      const fp = JSON.stringify(payload)          // 开算那一刻的入参（「输入已变」比的就是它，见文件末 stale）
      const r = await api.interference.asi(payload)
      if (gen !== _gen) return                    // 算的时候换了配置：上一份的结果不落到这一份（见 clearResults）
      if (!r || !r.ok) { msg.value = '计算失败：' + ((r && r.error) || '未知错误'); asi.result = null; return }
      asi.result = r
      ranFp.asi = fp
      const warns = [...((r.downlink && r.downlink.warnings) || []), ...((r.uplink && r.uplink.warnings) || [])]
      msg.value = warns.length ? stateOnly(warns[0]) : ''
    } finally { busy.value = false }
  }

  // ---------------------------------------------------------------------------
  // 计算：C/XPI
  // ---------------------------------------------------------------------------
  async function sampleXpiFromGrd() {
    const a = currentAntenna.value
    if (!a) { msg.value = '先选一副 GRD 方向图'; return }
    if (a.node.noEph) { msg.value = '关联卫星当前无星历'; return }   // 源星此刻解不出星位：不拿存盘旧星位顶替（同链路预算 grdParam）
    if (boreToSat(a)) { msg.value = BORE_SAT_MSG; return }
    if (!api || !api.linkBudget) { msg.value = '需在桌面客户端中运行'; return }
    busy.value = true
    const gen = _gen
    try {
      // 走专用的 grdSampleXpd：共极化分量由波束峰值判定（不假设是 P1），且取【服务波束】的
      // 共/交比。此前用 pol:'P1/P2' 走 sampleMax 是错的——既把共极化认反（真实文件多为 P2 才是
      // 共极化，取出来是负数），又在各波束的比值里取最大（跟该点实际收哪个波束无关）。
      const spec = antennaSpec(a)
      const at = xpiLoc()                         // 这个值是在哪个站址、哪副天线上取的（「输入已变」要认它）
      const r = await api.linkBudget.grdSampleXpd({ ...spec, points: [{ lon: +site.lon, lat: +site.lat }] })
      if (gen !== _gen) return
      const v = r && r.ok && Array.isArray(r.values) ? r.values[0] : null
      if (!v) { msg.value = '该站址落在方向图网格域外，或卫星不可见'; xpi.satGrdRatioDb = ''; xpi.satGrdDetail = null; return }
      xpi.satGrdRatioDb = v.xpdDb
      xpi.satGrdDetail = { ...v, at }
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
    const gen = _gen
    try {
      const satDb = xpi.satSource === 'grd' ? numOr(xpi.satGrdRatioDb, null) : numOr(xpi.satManualDb, null)
      // GRD 那一段按「取值时」的站址 / 天线记：之后站址或天线换了、却没重取，结果照样算过期
      const fp = fpXpi(xpi.satGrdDetail ? xpi.satGrdDetail.at : null)
      const r = await api.interference.xpi({
        satellite: satDb == null ? null : { db: satDb, source: xpi.satSource === 'grd' ? 'grd' : 'manual' },
        earthStation: esDesc(),
        rain: rainDesc()
      })
      if (gen !== _gen) return
      if (!r || !r.ok) { msg.value = '计算失败：' + ((r && r.error) || '未知错误'); xpi.result = null; xpi.rainInfo = null; xpi.curve = null; return }
      xpi.result = r.result
      xpi.rainInfo = r.rain || null
      xpi.curve = r.curve || null
      ranFp.xpi = fp
      if (!r.result) msg.value = '三段全缺 —— 至少给一段才能合成'
    } finally { busy.value = false }
  }

  // 雨致 XPD 那一段的给法：手填（标「手填」）或按 P.618-14 §4.1 计算（标「P.618-14 §4.1」）——两种来源分开标，
  // 不再把手填数送成 source:'p618'。计算所需的站址 / 轨位 / 频率 / 极化全取本页现值，公式在引擎（雨衰核同源）
  function rainDesc() {
    if (xpi.rainSource !== 'p618') return { mode: 'manual', db: numOr(xpi.rainXpdDb, null) }
    const up = xpi.rainDir === 'up'
    return {
      mode: 'p618', lat: +site.lat, lon: +site.lon, alt: +site.alt, satLonDeg: +carrier.satLonDeg,
      freqGHz: up ? +site.txFreqGHz : +site.rxFreqGHz, pol: up ? carrier.upPolarization : carrier.dnPolarization,
      pPct: numOr(xpi.rainPct, null)
    }
  }

  // ---------------------------------------------------------------------------
  // 计算：C/CCI（目标波束）
  // ---------------------------------------------------------------------------
  // 场在主进程分帧推进（进度 ci:cciProgress、结果 ci:cciDone，令牌作废迟到的帧）；逐波束值不过 IPC，每点在主进程折成一个数。
  const cciReq = (a, extra) => JSON.parse(JSON.stringify({ ...antennaSpec(a), ...(extra || {}) }))   // 现造纯数据：代理过不了结构化克隆
  let _cciToken = 0
  if (api && api.interference && api.interference.onCciProgress) {
    api.interference.onCciProgress((p) => {
      if (!p || p.token !== _cciToken) return
      cci.progress = p.done; cci.progressTotal = p.total
    })
    api.interference.onCciDone((p) => {
      if (!p || p.token !== _cciToken) return
      _cciToken = 0; busy.value = false; cci.progress = 0; cci.progressTotal = 0
      if (!p.ok) { msg.value = 'C/CCI 计算失败：' + (p.error || '未知错误'); return }
      applyCciTarget(p.result)
    })
  }
  function stopCciJob() {
    try {
      const p = api && api.interference && api.interference.cciCancel ? api.interference.cciCancel() : null
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch (e) { /* 主进程那头已收摊 */ }
  }
  async function cancelCci() {
    if (api && api.interference && api.interference.cciCancel) await api.interference.cciCancel()
    _cciToken = 0; busy.value = false; cci.progress = 0; cci.progressTotal = 0; msg.value = '已取消'
  }
  // 选择按天线分开记（换一副天线，目标与同频波束号就不是同一组了）；足迹随方向图 / 指向 / 覆盖电平取。
  const cciPick = computed(() => cci.picks[cci.antennaKey] || { target: null, co: [] })
  const cciTgtIdx = computed(() => (cci.tgtBeams && cci.tgtBeams.key === cci.antennaKey ? cci.tgtBeams.beams.map((b) => b.idx) : []))
  function pickOf(key) {
    if (!key) return null
    let p = cci.picks[key]
    if (!p || typeof p !== 'object') { p = { target: null, co: [] }; cci.picks[key] = p }
    if (!Array.isArray(p.co)) p.co = []
    return p
  }
  function setCciTarget(idx) {
    const p = pickOf(cci.antennaKey)
    if (!p) return
    const v = idx == null || idx === '' ? null : Number(idx)
    p.target = Number.isInteger(v) ? v : null
    if (p.target != null) p.co = p.co.filter((x) => x !== p.target)
  }
  function toggleCciCo(idx) {
    const p = pickOf(cci.antennaKey)
    const v = Number(idx)
    if (!p || !Number.isInteger(v) || v === p.target) return
    p.co = p.co.includes(v) ? p.co.filter((x) => x !== v) : [...p.co, v].sort((a, b) => a - b)
  }
  function clearCciCo() { const p = pickOf(cci.antennaKey); if (p) p.co = [] }
  // 整组设定（按波束号输入那一格）：原始下标，剔除目标与方向图里没有的
  function setCciCo(list) {
    const p = pickOf(cci.antennaKey)
    if (!p) return
    const have = new Set(cciTgtIdx.value)
    p.co = [...new Set((list || []).map(Number).filter((x) => Number.isInteger(x) && x !== p.target && (!have.size || have.has(x))))].sort((a, b) => a - b)
  }

  let _fpSeq = 0, _fpTimer = 0
  async function refreshCciBeams() {
    const a = currentAntenna.value
    const seq = ++_fpSeq
    if (!a) { cci.tgtBeams = null; cci.tgtBeamsErr = ''; return }
    if (a.node.noEph) { cci.tgtBeams = null; cci.tgtBeamsErr = '关联卫星当前无星历'; return }
    if (boreToSat(a)) { cci.tgtBeams = null; cci.tgtBeamsErr = BORE_SAT_MSG; return }
    if (!api || !api.interference || !api.interference.cciBeams) { cci.tgtBeams = null; cci.tgtBeamsErr = '需在桌面客户端中运行'; return }
    const level = Math.max(0.1, +cci.eocDb || 4)
    let r = null
    try { r = await api.interference.cciBeams(cciReq(a, { levelDb: level })) } catch (e) { r = { ok: false, error: (e && e.message) || String(e) } }
    if (seq !== _fpSeq) return
    if (!r || !r.ok) { cci.tgtBeams = null; cci.tgtBeamsErr = (r && r.error) || '方向图读取失败'; return }
    cci.tgtBeamsErr = ''
    // 整份替换、不逐项改：不进深层响应（几百个波束 × 几十个轮廓点，拖图时每帧都要遍历一遍）
    cci.tgtBeams = markRaw({ key: a.key, level: r.level, beams: r.beams || [] })
  }
  // 只在目标波束页上取；拖覆盖电平时按住 150 ms 再取（足迹要逐波束扫一遍网格）。进页时总取一次：
  // 天线也能在 C/XPI 页换（两页共用 cci.antennaKey），离页期间的变化这里补上（主进程按入参缓存，同参不重算）
  const cciFpWant = () => mode.value === 'cci'
  watch(() => [cci.antennaKey, currentAntenna.value ? JSON.stringify(antennaSpec(currentAntenna.value)) : '', cci.eocDb].join('\n'), () => {
    if (!cciFpWant()) return
    clearTimeout(_fpTimer)
    _fpTimer = setTimeout(refreshCciBeams, 150)
  })
  watch(cciFpWant, (on) => { if (on) refreshCciBeams() })

  // 入算的那份（只留方向图里还在的波束）
  function cciTgtPayload() {
    const p = cciPick.value
    const have = new Set(cciTgtIdx.value)
    return {
      target: p.target != null && have.has(p.target) ? p.target : null,
      cochannel: (p.co || []).filter((x) => x !== p.target && have.has(x))
    }
  }
  let _cciTgtFp = ''
  async function computeCciTarget() {
    const a = currentAntenna.value
    if (!a) { msg.value = '先选一副 GRD 方向图'; return }
    if (a.node.noEph) { msg.value = '关联卫星当前无星历'; return }
    if (boreToSat(a)) { msg.value = BORE_SAT_MSG; return }
    if (!api || !api.interference || !api.interference.cciStart) { msg.value = '需在桌面客户端中运行'; return }
    const pl = cciTgtPayload()
    if (pl.target == null) { msg.value = '先选目标波束'; return }
    if (!pl.cochannel.length) { msg.value = '先选同频同极化波束'; return }
    const gen = _gen
    if (_cciToken) { _cciToken = 0; stopCciJob() }
    busy.value = true; cci.progress = 0; cci.progressTotal = 0; msg.value = 'C/CCI 计算…'
    _cciTgtFp = fpCciTgt()
    let r = null
    try { r = await api.interference.cciStart(cciReq(a, { mode: 'target', ...pl, eocDb: Math.max(0.1, +cci.eocDb || 4) })) }
    catch (e) { busy.value = false; if (gen === _gen) msg.value = 'C/CCI 计算失败：' + ((e && e.message) || e); return }
    if (gen !== _gen) { busy.value = false; if (r && r.ok) stopCciJob(); return }
    if (!r || !r.ok) { busy.value = false; msg.value = 'C/CCI 计算失败：' + ((r && r.error) || '未知错误'); return }
    _cciToken = r.token
    cci.progressTotal = r.T
  }
  function applyCciTarget(res) {
    const f = res.field
    cci.tgtResult = {
      ...res,
      // 区外是 NaN：经 JSON 中转（导出 / 预览）会变成 null，Float64Array.from 再把 null 记成 0 —— 区外整块涂成最低色
      field: f ? { xs: Float64Array.from(f.xs), ys: Float64Array.from(f.ys), nx: f.nx, ny: f.ny, z: Float64Array.from(f.z, (v) => (v == null ? NaN : v)), valid: f.valid, min: f.min, max: f.max } : null
    }
    ranFp.cciTgt = _cciTgtFp
    msg.value = res.cover ? `C/CCI 完成：覆盖区 ${res.cover.toLocaleString('en-US')} 点 · ${(res.elapsedMs / 1000).toFixed(2)} s` : '覆盖区内无有效值。'
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
    // 起点：给了 startIso 用它，留空取主窗口时间轴上的此刻（场景时刻；实时档即系统钟）。walker 的设计历元取同一刻。
    const startMs = ngso.startIso ? Date.parse(ngso.startIso) : sceneNowMs()
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
        : { source: 'walker', name: g.name, altKm: +g.altKm, incl: +g.incl, planes: +g.planes, perPlane: +g.perPlane, phase: +g.phase, epoch: ngso.startIso || new Date(startMs).toISOString() }
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
      startMs,
      horizonSec: +ngso.horizonH * 3600,
      stepSec: +ngso.stepSec,
      patternKind: ngso.patternKind,
      applyPolarization: ngso.applyPolarization,
      inlineGuardDeg: numOr(ngso.inlineGuardDeg, undefined),
      satPattern: satPatternPayload(),
      noise: ngso.noise.mode === 'gt'
        ? { gOverTdBK: numOr(ngso.noise.gOverTdBK, null) }
        : { tSysK: numOr(ngso.noise.tSysK, null) },
      criteria: {
        ciDb: numOr(ngso.criteria.ciDb, undefined),
        iOverNDb: numOr(ngso.criteria.iOverNDb, undefined),
        deltaTOverTPct: numOr(ngso.criteria.deltaTOverTPct, undefined)
      },
      rain: (ngso.rain.on && ngso.rain.cdf && ngso.rain.cdf.length)
        ? {
          thresholdDb: numOr(ngso.rain.thresholdDb, null),
          applyToInterference: ngso.rain.applyToInterference || 'none',
          cdf: ngso.rain.cdf.map((d) => ({ pct: +d.pct, attenDb: +d.attenDb, noiseTempK: d.noiseTempK == null ? undefined : +d.noiseTempK }))
        }
        : undefined,
      seriesMaxPoints: 2000,
      // 历元只把「怎么抽」告诉主进程，起点（startMs）仍由本层给 —— 引擎与服务层都不碰 Date.now()
      epochs: {
        mode: ngso.epochs.mode || 'single',
        count: numOr(ngso.epochs.count, 8),
        spanDays: numOr(ngso.epochs.spanDays, 7),
        seed: numOr(ngso.epochs.seed, 20260728),
        capDays: numOr(ngso.epochs.capDays, 7),
        convergeTolDb: numOr(ngso.epochs.convergeTolDb, 0.2),
        convergePct: numOr(ngso.epochs.convergePct, 0.1)
      }
    }
  }

  /**
   * 卫星侧方向图配置 → 纯数据（出 IPC 前现造，切断响应式代理）。
   * GRD 只带**文件名**过去，采样器在主进程现建（函数过不了结构化克隆）。
   */
  function satPatternPayload() {
    const s = ngso.satPattern
    const out = { mode: s.mode || 'none', pointing: s.pointing || 'nadir', coFreqFactor: numOr(s.coFreqFactor, 1) }
    if (out.mode === 'none') return out
    if (out.mode === 'gaussian') {
      out.beamwidth3dBDeg = numOr(s.beamwidth3dBDeg, null)
      out.sidelobeFloorDb = numOr(s.sidelobeFloorDb, -30)
    } else if (out.mode === 's1528') {
      out.s1528Section = s.s1528Section || '1.2'
      out.beamwidth3dBDeg = numOr(s.beamwidth3dBDeg, null)
      out.peakGainDbi = numOr(s.peakGainDbi, undefined)
      out.farOutDbi = numOr(s.farOutDbi, 0)
      if (out.s1528Section === '1.3') {
        out.satMode = s.satMode || 'LEO'
        out.dOverLambda = numOr(s.dOverLambda, undefined)
      } else {
        out.Ln = numOr(s.Ln, -25)
      }
    } else if (out.mode === 'grd') {
      const a = grdAntennas.value.find((x) => x.key === s.grdKey)
      const spec = a ? antennaSpec(a) : null
      out.grdFile = spec ? spec.file : ''
      out.grdCfg = spec ? { ...spec.cfg } : {}
      // 多波束 GRD 必须点名用哪个波束（同频的那个）；留空即全部取最大，引擎会如实告警
      const b = numOr(s.grdBeam, null)
      if (b != null) out.grdBeam = Math.round(b)
    }
    if (out.pointing === 'cells') {
      out.beamsPerSat = numOr(s.beamsPerSat, 32)
      out.cellSpacingKm = numOr(s.cellSpacingKm, 200)
    }
    return out
  }

  /**
   * 取雨衰 CDF —— 可用度合成的另一半。
   *
   * 分布不自己造：走平台既有的 P.618 引擎，且用它的 **NGSO 统计口径（P.618-14 §8）**——
   * 那里的仰角不是一个手填的数，而是由「轨道高度 + 倾角 + 最低仰角」的长期仰角分布加权
   * 反解出的等效仰角，正是本页这个场景该用的口径。轨道参数取本星座的实参统计。
   * 逐档同时取回雨致噪温，噪声抬升因此不必再拿介质温度去推。
   */
  const RAIN_PCTS = [0.001, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 3, 5]
  async function loadRainCdf() {
    if (!api || !api.rainAttenuation) { msg.value = '需在桌面客户端中运行'; return }
    const gen = _gen
    const w = ngso.wanted
    busy.value = true
    try {
      // 轨道只按来源取，两档绝不互相顶替：
      //   Walker 档 → 手填的高度 / 倾角；
      //   星历档    → 本星座的实参统计。还没取回（开窗 / 切配置后的补载还在路上）就等它取回；取不回如实报。
      //   ★ 从前统计缺失时一路退回 Walker 那两格——星历档下它们是界面上看不见的出厂缺省 1200 km / 53°：
      //     重开窗口后配置里选着 Starlink，读数行却写「轨道 1200 km / 53.0°」，CDF 与可用度按这条假轨道算。
      // 高度与倾角要出自同一撮星，故整取占比最大的那个壳层；壳层缺失时才退回全体中位数。
      let altKm = null, incl = null
      if (w.source === 'walker') {
        altKm = numOr(w.altKm, null); incl = numOr(w.incl, null)
      } else if (w.group) {
        let st = groupStats.value[w.group]
        if (!st) {
          msg.value = `载入星座「${groupLabel(w.group)}」…`
          await fetchGroup(w.group, false)
          if (gen !== _gen) return                    // 等的时候换了配置：这一份不要了
          st = groupStats.value[w.group]
          if (!st) { msg.value = '载入失败：' + (groupErrs.value[w.group] || '未知'); return }
        }
        const sh = st.shells && st.shells[0]
        altKm = sh ? sh.altKmMed : st.altKmMed
        incl = sh ? sh.inclDeg : st.inclMed
      }
      if (!(altKm > 0) || !(incl >= 0)) { msg.value = '缺少本星座的轨道高度与倾角。'; return }
      const base = {
        lat: +site.lat, lon: +site.lon, altitude: +site.alt,
        freq: +site.rxFreqGHz, pol: carrier.dnPolarization === 'V' ? 'V' : (carrier.dnPolarization === 'H' ? 'H' : 'C'),
        diameter: +site.rxDiameterM, efficiency: +site.rxEfficiency,
        direction: 'down', systemNoiseTemp: numOr(ngso.noise.tSysK, 150), feederLoss: 0,
        ngsoStat: true, orbitAltKm: altKm, inclDeg: incl, minElevDeg: +ngso.minElevDeg
      }
      const cases = RAIN_PCTS.map((p) => ({ ...base, availability: 100 - p }))
      const r = await api.rainAttenuation.computeBatch(cases)
      if (gen !== _gen) return                        // 算的时候换了配置：按上一份站址 / 星座算的分布不落到这一份
      const rows = (r && (r.results || r)) || []
      const cdf = []
      for (let i = 0; i < RAIN_PCTS.length; i++) {
        const x = rows[i]
        if (!x || x.error || !Number.isFinite(Number(x.totalAttenItu))) continue
        cdf.push({ pct: RAIN_PCTS[i], attenDb: +Number(x.totalAttenItu).toFixed(4), noiseTempK: Number.isFinite(Number(x.rainNoiseTemp)) ? +Number(x.rainNoiseTemp).toFixed(3) : undefined })
      }
      if (!cdf.length) { ngso.rain.cdf = null; ngso.rain.cdfInfo = ''; msg.value = '雨衰分布获取失败。'; return }
      ngso.rain.cdf = cdf
      const eq = rows.find((x) => x && x.elevation != null)
      ngso.rain.cdfInfo = `P.618-14 §8 统计口径 · 等效仰角 ${eq ? Number(eq.elevation).toFixed(2) : '—'}° · 轨道 ${Math.round(altKm)} km / ${Number(incl).toFixed(1)}° · ${cdf.length} 档（${cdf[0].pct}%–${cdf[cdf.length - 1].pct}%）`
      msg.value = '雨衰分布已取回：' + ngso.rain.cdfInfo
    } catch (e) {
      if (gen !== _gen) return
      ngso.rain.cdf = null
      msg.value = '取雨衰分布出错：' + ((e && e.message) || e)
    } finally { busy.value = false }
  }

  async function estimateNgso() {
    if (!api || !api.interference) return
    const gen = _gen
    try {
      const r = await api.interference.ngsoEstimate(ngsoPayload())
      if (gen !== _gen) return                        // 预估期间换了配置：上一份的预估不落到这一份
      ngso.estimate = r && r.ok ? r : null
      if (r && !r.ok) msg.value = r.error || ''
    } catch (e) {
      if (gen !== _gen) return
      ngso.estimate = null
      msg.value = '预估失败：' + ((e && e.message) || e)
    }
  }

  // 星×样本 的上限。★ 这道门拦的不是「算不动」，而是「点下去看不到头」——扫描在主进程分帧跑，
  //   全程有进度条、随时可取消，窗口照常可交互，所以门槛该按「专业用户真正要跑的那一档」来定：
  //     · 全量 Starlink（~7 000 颗）× 24 h / 10 s ≈ 6×10⁷ —— 这是 NGSO 兼容性分析的起步算例，
  //       原先 3×10⁷ 的门限把它整个挡在门外，逼人去抽样（那是直接少算干扰源、伪造物理）；
  //     · 再叠 5 个历元的蒙卡 ≈ 3×10⁸ —— 按 ~5×10⁵ 次传播/秒计约十来分钟，可等；
  //   故取 3×10⁸。再往上（数小时）才真该拦下来重新设算例。
  const NGSO_MAX_WORK = 3e8
  let _ngsoToken = 0
  let _ngsoFp = ''
  /** 起始时刻取时间轴当前时刻（取整分） */
  function ngsoStartNow() { ngso.startIso = minuteIso(sceneNowMs()) }

  async function computeNgso() {
    if (!api || !api.interference) { msg.value = '需在桌面客户端中运行'; return }
    const gen = _gen
    await estimateNgso()
    if (gen !== _gen) return
    const est = ngso.estimate
    if (est && est.work > NGSO_MAX_WORK) {
      // ★ 建议的次序是有讲究的：缩短时窗 / 增大步长只降统计分辨率（分位数会被样本门禁如实标出），
      //   减少干扰星数则直接少算干扰源、伪造物理，所以排在最后并写明后果。
      const T = Math.round(+ngso.horizonH * 3600 / +ngso.stepSec)
      const ep = est.epochCount > 1 ? ` × ${est.epochCount} 历元` : ''
      msg.value = `计算量过大（${est.wantedCount + est.interfererCount} 颗星 × ${T.toLocaleString('en-US')} 采样${ep} = ${est.work.toLocaleString('en-US')}，超过上限 ${NGSO_MAX_WORK.toLocaleString('en-US')}）。`
      return
    }
    busy.value = true; ngso.result = null; ngso.progress = 0; msg.value = '扫描中…'
    _ngsoFp = fpNgso()                            // 开扫那一刻的入参；结果回来时才认（见 onNgsoDone）
    let r = null
    try { r = await api.interference.ngsoStart(ngsoPayload()) }
    catch (e) { busy.value = false; if (gen === _gen) msg.value = '启动出错：' + ((e && e.message) || e); return }
    if (gen !== _gen) {
      // 启动期间换了配置（clearResults 那时令牌还没到手，停不了它）：这一轮按上一份的入参在扫，停掉、不认
      busy.value = false
      if (r && r.ok) stopNgsoScan()
      return
    }
    if (!r || !r.ok) { busy.value = false; msg.value = '启动失败：' + ((r && r.error) || '未知错误'); return }
    _ngsoToken = r.token
    ngso.progressTotal = r.T
    if (r.warnings && r.warnings.length) msg.value = stateOnly(r.warnings[0])
  }

  async function cancelNgso() {
    if (api && api.interference) await api.interference.ngsoCancel()
    _ngsoToken = 0; busy.value = false; msg.value = '已取消'
  }
  // 让主进程停掉在跑的扫描（不等、不出声）：换配置时用，迟到的进度 / 结果另由令牌挡掉
  function stopNgsoScan() {
    try {
      const p = api && api.interference && api.interference.ngsoCancel ? api.interference.ngsoCancel() : null
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch (e) { /* 主进程那头已收摊 */ }
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
      ranFp.ngso = _ngsoFp
      const w = (p.result.warnings || [])[0]
      msg.value = w ? stateOnly(w) : `完成（${p.result.elapsedMs} ms，${p.result.samples} 个有效样本）`
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
        ? `本星 ${fmtGeoSlot(Number(carrier.satLonDeg)) || carrier.satLonDeg + '°E'} 两侧 ±${satSearch.spanDeg}° 内 ${r.count} 颗（按经度差排序）`
        : `两侧 ±${satSearch.spanDeg}° 内未找到卫星。`
    } finally { satSearch.busy = false }
  }

  // 把搜到的星加成干扰源。EIRP 密度星历里没有，留空由用户填——这是唯一必须人工给的量。
  function addNeighbor(s) {
    if (!s) return
    if (asi.sources.some((x) => x.name === s.name)) { satSearch.msg = `「${s.name}」已在表中`; return }
    putAt(asi.sources, blankSource({
      name: s.name, lonDeg: s.lonDeg,
      polarization: carrier.dnPolarization, upPolarization: carrier.upPolarization
    }))
    const slotTxt = fmtGeoSlot(Number(s.lonDeg)) || s.lonDeg + '°E'
    satSearch.msg = s.inclined
      ? `已加入「${s.name}」（${slotTxt}）—— 该星星下点纬度 ${s.latDeg}°，有倾角残余，按赤道面圆轨道近似计算 C/ASI 会有偏差`
      : `已添加「${s.name}」（${slotTxt}），下行 EIRP 密度未填写。`
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
  const groupErrs = ref({})           // key → 最近一次载入失败的原因（载入成功即删）：表里「加载中…」与「载入失败」靠它分开
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
        // validateWalker，与「生成」按钮同一把尺子。参数取 customConstParams：轨道向导里地固经度 / 地方时
        // 为设计量的星座按本次场景历元重解 RAAN（否则每过一天漂 0.9856°，与 3D 页对不上）。
        let gen = []
        try { const p = customConstParams(c, epoch); if (validateWalker(p).ok) gen = generateConstellation(p) } catch (e) { gen = [] }
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

  // 载入一组并记下实参统计（成功写 groupStats、失败写 groupErrs），不碰 busy / msg —— 出不出声由调用方定。
  // 同一组的非联网载入在飞时复用那一次：开窗 / 切配置的补载、用户在下拉里选组、「取雨衰分布」的等待撞在一起只发一次 IPC；
  // 联网刷新（online）照发——它要的就是重取。回包恒为对象（IPC 抛错折成 { ok:false, exc }），从不 reject。
  const _groupLoads = new Map()       // key → 在飞的 Promise<loadGroup 回包>
  function fetchGroup(key, online) {
    if (!key) return Promise.resolve(null)
    if (!online && _groupLoads.has(key)) return _groupLoads.get(key)
    const p = (async () => {
      let r
      if (!api || !api.interference || !api.interference.loadGroup) r = { ok: false, error: '需在桌面客户端中运行' }
      else {
        try { r = await api.interference.loadGroup(key, !!online, satGroupIds[key], ccSats[key]) }
        catch (e) { r = { ok: false, exc: e || new Error('未知错误'), error: (e && e.message) || String(e) } }
      }
      if (r && r.ok && r.stats) {
        groupStats.value = { ...groupStats.value, [key]: r.stats }
        if (key in groupErrs.value) { const next = { ...groupErrs.value }; delete next[key]; groupErrs.value = next }
      } else {
        // ok 却没有统计 = 一颗解得出轨道的星都没有（statsOf 回 null），对这张表来说与载入失败同办
        groupErrs.value = { ...groupErrs.value, [key]: (r && !r.ok && r.error) || (r && r.ok ? '无有效星历' : '未知') }
      }
      return r
    })()
    _groupLoads.set(key, p)
    const done = () => { if (_groupLoads.get(key) === p) _groupLoads.delete(key) }
    p.then(done, done)
    return p
  }

  // 当前面板引用的星座（本星座 + 各干扰星座里选了星历的行）里还没有实参统计的，后台补载（不出声）。
  // ★ 统计从前只在下拉 @change 时取：重开窗口 / 切配置 / 撤销把某行换回一个组 / 表格里把来源改回「星历」之后，
  //   配置里那几组的统计一直是空的 —— 干扰星座行永远停在「加载中…」，本星座的速览不出，「取雨衰分布」拿不到轨道。
  // 两条路：面板里新引用了哪个组就补哪个（下面的 watch，只补新出现的——载不成的组不因别处改动反复重试）；
  // 窗口在开窗末尾与 applyState 之后显式调 refreshGroupStats，补全部缺统计的组，顺带重试上次没载成的。
  function groupKeysInUse() {
    const keys = new Set()
    if (ngso.wanted.source === 'group' && ngso.wanted.group) keys.add(ngso.wanted.group)
    for (const g of ngso.interferers) if (g && g.source !== 'walker' && g.group) keys.add(g.group)
    return [...keys]
  }
  async function loadGroupStats(keys) {
    const todo = keys.filter((k) => !groupStats.value[k])
    if (!todo.length) return
    await Promise.all(todo.map((k) => fetchGroup(k, false)))
    await loadNgsoGroups()            // 下拉里的颗数随载入更新（同 ensureGroup）
  }
  function refreshGroupStats() { return loadGroupStats(groupKeysInUse()) }
  watch(() => groupKeysInUse().join('\n'), (now, prev) => {
    const had = new Set(String(prev || '').split('\n'))
    const added = String(now || '').split('\n').filter((k) => k && !had.has(k))
    if (added.length) loadGroupStats(added)
  })

  async function ensureGroup(key, online) {
    if (!api || !api.interference || !key) return
    busy.value = true; msg.value = `载入星座「${groupLabel(key)}」…`
    try {
      const r = await fetchGroup(key, online)
      await loadNgsoGroups()
      if (r && r.ok) {
        msg.value = `星座「${groupLabel(key)}」已载入 ${r.count} 颗（来源：${r.source || '缓存'}）`
          + (r.missing ? ` —— 另有 ${r.missing} 颗在编目与自定义星历中均未找到，已跳过` : '')
      } else if (r && r.exc) {
        // IPC 当场抛的（fetchGroup 已接住）：与下面的 catch 同一句
        const e = r.exc
        msg.value = `星座「${groupLabel(key)}」载入出错：${(e && e.message) || e}`
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
    // GRD 树顺带重读：实时星位跟上主窗口时间轴（同链路预算窗口）；卫星库也重读 —— 开窗时库还空、之后才在链路预算里
    // 建了卫星条目的，切回来「从卫星库导入」就出现（从前只在开窗时读一次）
    window.addEventListener('focus', () => { loadNgsoGroups(); loadGrdTree(); loadLibraries() })
  }

  // ---------------------------------------------------------------------------
  // 干扰源表格增删 + 从卫星库带入
  // ---------------------------------------------------------------------------
  // 增行：at 给了就插在该下标处（输入网格的「插入行」），否则追加到表尾；返回新行对象（粘贴续写用）
  // ★ _id 在表内必须唯一（网格按它定位行）：序号每次开窗从 1 起，而配置里读回的行带着上次的 is3 / p2 / ng4，撞号就顺延
  const putAt = (arr, row, at) => {
    const pre = String(row._id).replace(/\d+$/, '')
    while (arr.some((x) => x._id === row._id)) row._id = pre + (_srcSeq++)
    if (Number.isInteger(at) && at >= 0 && at < arr.length) arr.splice(at, 0, row); else arr.push(row)
    return arr.find((x) => x._id === row._id)   // 取回 reactive 代理（直接改 row 不触发更新）
  }
  function addSource(at) { return putAt(asi.sources, blankSource({ name: `邻星 ${asi.sources.length + 1}` }), at) }
  function removeSource(id) { const i = asi.sources.findIndex((s) => s._id === id); if (i >= 0) asi.sources.splice(i, 1) }
  function addFromLibrary(entry) {
    if (!entry) return
    const f = entry.form || {}
    putAt(asi.sources, blankSource({
      name: entry.name || '库条目',
      lonDeg: f.orbitPosition != null && f.orbitPosition !== '' ? f.orbitPosition : '',
      polarization: f.downlinkPolarization || '',
      upPolarization: f.uplinkPolarization || ''
    }))
    msg.value = `已从卫星库导入「${entry.name}」；EIRP 密度需另行填写（库中存放的是 SFD 与转发器参数，不含邻网谱密度）`
  }
  function addNgsoGroup(at) {
    return putAt(ngso.interferers, { _id: 'ng' + (_srcSeq++), enabled: true, source: 'group', group: '', limit: '', name: `干扰星座 ${ngso.interferers.length + 1}`, altKm: 1200, incl: 53, planes: 6, perPlane: 6, phase: 1, eirpDensityDbWPerHz: -48, polarization: 'H', xpdDb: '', selfSystem: false, group: '' }, at)
  }
  function removeNgsoGroup(id) { const i = ngso.interferers.findIndex((g) => g._id === id); if (i >= 0) ngso.interferers.splice(i, 1) }

  // ---------------------------------------------------------------------------
  // 持久化（面板态一键存取，仿 useVisibility）
  // ---------------------------------------------------------------------------
  // 面板态 = 配置内容（窗口的配置列表与自动保存直接拿它存取；localStorage 那份是「上次工作区」的镜像）
  function snapshot() {
    return JSON.parse(JSON.stringify({
        mode: mode.value,
        site: { ...site }, carrier: { ...carrier },
        asi: { applyPolarization: asi.applyPolarization, esPattern: asi.esPattern, sources: asi.sources },
        xpi: {
          satSource: xpi.satSource, satManualDb: xpi.satManualDb, rainXpdDb: xpi.rainXpdDb,
          rainSource: xpi.rainSource, rainPct: xpi.rainPct, rainDir: xpi.rainDir,
          esMode: xpi.esMode, earthStationDb: xpi.earthStationDb, esArDb: xpi.esArDb,
          esCoDb: xpi.esCoDb, esXpolDb: xpi.esXpolDb, esAlignOn: xpi.esAlignOn, esAlignDeg: xpi.esAlignDeg
        },
        ap8: Object.fromEntries(Object.entries(ap8).filter(([k]) => k !== 'result')),
        cci: { antennaKey: cci.antennaKey, eocDb: cci.eocDb, picks: cci.picks },
        ngso: { v: NGSO_STATE_V, minElevDeg: ngso.minElevDeg, horizonH: ngso.horizonH, stepSec: ngso.stepSec, patternKind: ngso.patternKind, applyPolarization: ngso.applyPolarization, thresholdDb: ngso.thresholdDb, inlineGuardDeg: ngso.inlineGuardDeg, satPattern: ngso.satPattern, epochs: ngso.epochs, noise: ngso.noise, criteria: ngso.criteria, rain: { on: ngso.rain.on, thresholdDb: ngso.rain.thresholdDb, applyToInterference: ngso.rain.applyToInterference }, wanted: ngso.wanted, interferers: ngso.interferers }
    }))
  }
  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(snapshot())) } catch (e) { /* 配额/隐私模式 */ }
  }
  function load() {
    let d = null
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null') } catch (e) { return }
    applySnapshot(d)
  }
  function applySnapshot(d) {
    if (!d || typeof d !== 'object') return
    if (MODES.some((m) => m.key === d.mode)) mode.value = d.mode
    Object.assign(site, d.site || {})
    Object.assign(carrier, d.carrier || {})
    if (d.asi) {
      asi.applyPolarization = d.asi.applyPolarization !== false
      if (Array.isArray(d.asi.sources) && d.asi.sources.length) asi.sources.splice(0, asi.sources.length, ...d.asi.sources)
      // 方向图：老配置没有这一项 → 留在缺省 S.465-6（订正后新老配置一律按此）
      if (ES_PATTERN_IDS.includes(d.asi.esPattern)) asi.esPattern = d.asi.esPattern
    }
    if (d.xpi) {
      Object.assign(xpi, d.xpi)
      // 旧配置没有 rainSource：那时雨致 XPD 只能手填、出厂 22 dB。恰好等于旧出厂值的（软件替用户填的）改走
      // P.618-14 §4.1 计算；用户自己填过别的数一律保留为手填（同 NGSO「抽样上限 200」的迁移口径）
      if (!('rainSource' in d.xpi)) xpi.rainSource = Number(d.xpi.rainXpdDb) === 22 ? 'p618' : 'manual'
    }
    if (d.ap8 && typeof d.ap8 === 'object') {
      for (const k of Object.keys(d.ap8)) if (k !== 'result' && k in ap8) ap8[k] = d.ap8[k]
    }
    if (d.cci) {
      // 老配置的复用方案字段（着色来源 / 频率计划 / 取值点 / 场图网格 …）一概不认：该页已撤
      const c = d.cci
      cci.antennaKey = c.antennaKey || ''
      cci.eocDb = Number.isFinite(+c.eocDb) && +c.eocDb > 0 ? +c.eocDb : 4
      const picks = {}
      if (c.picks && typeof c.picks === 'object') {
        for (const [k, v] of Object.entries(c.picks)) {
          if (!v || typeof v !== 'object') continue
          const t = Number(v.target)
          picks[k] = {
            target: v.target != null && Number.isInteger(t) ? t : null,
            co: Array.isArray(v.co) ? [...new Set(v.co.map(Number).filter((x) => Number.isInteger(x) && x !== t))].sort((a, b) => a - b) : []
          }
        }
      }
      cci.picks = picks
    }
    if (d.ngso) {
      Object.assign(ngso, { minElevDeg: d.ngso.minElevDeg ?? 10, horizonH: d.ngso.horizonH ?? 6, stepSec: d.ngso.stepSec ?? 10, patternKind: d.ngso.patternKind || 'average', applyPolarization: d.ngso.applyPolarization !== false, thresholdDb: d.ngso.thresholdDb ?? 15, inlineGuardDeg: d.ngso.inlineGuardDeg ?? '' })
      if (d.ngso.satPattern) Object.assign(ngso.satPattern, d.ngso.satPattern)
      if (d.ngso.epochs) Object.assign(ngso.epochs, d.ngso.epochs)
      if (d.ngso.noise) Object.assign(ngso.noise, d.ngso.noise)
      if (d.ngso.criteria) Object.assign(ngso.criteria, d.ngso.criteria)
      // 雨衰分布本身不落盘（是算出来的、且随站址/星座变），只记开关与门限，重开后点一下重取
      if (d.ngso.rain) Object.assign(ngso.rain, { ...d.ngso.rain, cdf: null, cdfInfo: '' })
      if (d.ngso.wanted) Object.assign(ngso.wanted, d.ngso.wanted)
      if (Array.isArray(d.ngso.interferers) && d.ngso.interferers.length) ngso.interferers.splice(0, ngso.interferers.length, ...d.ngso.interferers)
      // ★ 旧面板态迁移：v2 之前「抽样上限」的出厂默认是 200，那不是用户选的，是软件替他选的，
      //   而它会静默削掉十几 dB 的聚合干扰。故对没有版本号的旧存档，把**恰好等于旧默认值**的
      //   200 清成留空（全量）；用户自己填过别的数（哪怕 199 或 201）一律原样保留。
      if (!(d.ngso.v >= 2)) {
        const un200 = (o) => { if (o && Number(o.limit) === 200) o.limit = '' }
        un200(ngso.wanted)
        for (const g of ngso.interferers) un200(g)
      }
    }
  }

  // 出厂面板态（读盘之前拍下）：配置列表「添加空白配置」用它，切到一份缺字段的旧配置时也先回到它再套
  const BLANK = snapshot()
  const blankSnapshot = () => JSON.parse(JSON.stringify(BLANK))
  watch([mode, site, carrier, asi, ap8, xpi, cci, ngso], persist, { deep: true })

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
        patternMarks: dg.patternMarks || [],
        esPattern: dg.esPattern || null
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
        peerCurves: ug.peerCurves || [],
        esPattern: ug.esPattern || null
      } : null
    }
  })

  // ---------------------------------------------------------------------------
  // 「输入已变」（与链路预算 / 雨衰 / 日凌同一盏灯）：每页结果记下【开算那一刻】的入参指纹，现值对不上就亮。
  // 本窗不存配置、结果也不随入参自动重算——从主窗口「分析 ▸ 干扰分析」带进新星 / 新站后，入参与顶栏都换了，
  // 下面却还是上一次的数；手改入参同理。比的是指纹而不是「动过没有」：带进来的星站与现值相同、改了又改回，都不亮。
  // 指纹只取各页真正入算的量（站名 / 星名 / 门限线这类只影响显示的不进），且全是小对象，computed 逐次重算无负担。
  // ---------------------------------------------------------------------------
  const ranFp = reactive({ asi: '', ap8: '', xpi: '', cciTgt: '', ngso: '' })
  // C/XPI 卫星侧 GRD 那一段的取值位置：站址 + 天线。现值与取值时不同 ⇒ 表里「本站处 XPD」已不是本站的
  const xpiLoc = () => JSON.stringify([+site.lon, +site.lat, cci.antennaKey])
  function fpXpi(at) {
    const grd = xpi.satSource === 'grd'
    const has = grd && xpi.satGrdRatioDb !== '' && xpi.satGrdRatioDb != null
    return JSON.stringify({ src: xpi.satSource, sat: grd ? xpi.satGrdRatioDb : xpi.satManualDb, es: esDesc(), rain: rainDesc(), at: has ? (at || null) : null })
  }
  // 目标波束：方向图（含指向 / 取值口径）+ 目标 + 同频波束 + 覆盖电平
  const fpCciTgt = () => { const a = currentAntenna.value; return JSON.stringify({ a: a ? antennaSpec(a) : null, ...cciTgtPayload(), e: +cci.eocDb }) }
  // NGSO：不走 ngsoPayload —— 自定义星座会把成千颗星的根数整份带上，且起点留空时取的是走动的时间轴此刻
  const fpNgso = () => JSON.stringify({
    st: [site.lon, site.lat, site.alt], rx: [site.rxDiameterM, site.rxEfficiency, site.rxFreqGHz],
    car: [carrier.eirpDbW, carrier.bandwidthHz, carrier.dnPolarization],
    n: [ngso.minElevDeg, ngso.horizonH, ngso.stepSec, ngso.patternKind, ngso.applyPolarization, ngso.startIso, ngso.inlineGuardDeg],
    ep: ngso.epochs, noise: ngso.noise, cr: ngso.criteria,
    rain: [ngso.rain.on, ngso.rain.thresholdDb, ngso.rain.applyToInterference, ngso.rain.on ? ngso.rain.cdf : null],
    sp: ngso.satPattern, w: ngso.wanted, i: ngso.interferers
  })
  const stale = computed(() => ({
    asi: !!asi.result && JSON.stringify(asiPayload()) !== ranFp.asi,
    ap8: !!ap8.result && JSON.stringify(ap8Payload()) !== ranFp.ap8,
    xpi: !!xpi.result && fpXpi(xpiLoc()) !== ranFp.xpi,
    cciTgt: !!cci.tgtResult && fpCciTgt() !== ranFp.cciTgt,
    ngso: !!ngso.result && fpNgso() !== ranFp.ngso
  }))

  // 换了一份配置（切换 / 新建 / 还原历史版本 / 带上下文另建）：上一份的结果与派生量整套清掉，窗口的 applyState 调。
  // 各页结果、在本站取的 GRD 卫星侧 XPD、雨衰分布都是按上一份的站址 / 星座 / 天线算的——留着就是把 A 的数挂在 B 下面，
  // 而「输入已变」只在入参指纹对不上时亮：两份配置恰好同参时连灯都不亮。指纹随结果一并复位（灯灭）。
  // 在途的计算按代次作废（回包丢弃）；NGSO 扫描另让主进程停算，令牌清零后迟到的进度与结果都不认。
  function clearResults() {
    _gen++
    if (_ngsoToken) { _ngsoToken = 0; busy.value = false; stopNgsoScan() }
    asi.result = null
    ap8.result = null
    xpi.result = null; xpi.satGrdRatioDb = ''; xpi.satGrdDetail = null; xpi.rainInfo = null; xpi.curve = null
    if (_cciToken) { _cciToken = 0; busy.value = false; stopCciJob() }
    cci.tgtResult = null; cci.progress = 0; cci.progressTotal = 0
    ngso.result = null; ngso.estimate = null; ngso.progress = 0; ngso.progressTotal = 0
    ngso.rain.cdf = null; ngso.rain.cdfInfo = ''
    for (const k of Object.keys(ranFp)) ranFp[k] = ''
    msg.value = ''
  }

  // 对星指向（跟踪目标星 / 目标星 + 偏置）的方向图：主进程拿不到目标星此刻的星位，采样器对这两档一律不取值
  // （grdSampler.makeSampleCtx 返回 null）。在这里先拦下、给一句明确的状态，免得落成「域外 / 无同色波束」那类误导性的空结果。
  const BORE_SAT_MSG = '对星指向的方向图无法按地面点取值'
  function boreToSat(a) {
    const bt = a && (grdTree.value.cfgs[a.node.folder + '::' + a.ant.name] || {}).boreType
    return bt === 'sat' || bt === 'satoff'
  }

  const hoveredId = ref('')
  function setHover(id) { hoveredId.value = id || '' }

  return {
    MODES,
    mode, busy, msg, site, carrier, asi, ap8, xpi, cci, ngso,
    satLib, grdTree, grdAntennas, currentAntenna, ngsoGrdBeams,
    satSearch, searchNeighbors, addNeighbor,
    ngsoGroups, groupStats, groupErrs, groupsErr, loadNgsoGroups, ensureGroup, refreshGroupStats,
    loadLibraries, loadGrdTree, importGrdHere,
    computeAsi, computeAp8, computeXpi, sampleXpiFromGrd,
    computeNgso, cancelNgso, estimateNgso, loadRainCdf, ngsoStartNow,
    addSource, removeSource, addFromLibrary,
    addNgsoGroup, removeNgsoGroup,
    // C/CCI 目标波束；本窗口导入方向图的卫星位置与视轴
    antennaSpec, antEditable, setAntGeo, cancelCci,
    cciPick, cciTgtIdx, setCciTarget, toggleCciCo, clearCciCo, setCciCo, refreshCciBeams, computeCciTarget,
    geoData, hoveredId, setHover, load, persist, snapshot, applySnapshot, blankSnapshot, stale, clearResults
  }
}
