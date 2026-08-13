// 对星性能指标表 —— 对地那张表（usePerfTable）的孪生版本，两种口径：
//   【当前时刻】一行 = 一颗目标星，报此刻的取值；
//   【时间窗口】一行 = 一次「照到」的时段（或按目标星汇总），报窗口起止 / 时长 / 峰值时刻与峰值取值。
// 取值内核完全同源（sampleBeamAtParam），故与对地表的 Dir / Parameter / Min·Max Pointing / Xpol / Slope / AR
// 逐位同口径，差别只在目标点怎么来、以及遮挡怎么判：
//   · 地面站：目标点 = 经纬度贴椭球；遮挡 = 卫星是否在测站地平线以上；
//   · 目标星：目标点 = SGP4 解算的 ECEF；遮挡 = 星-星视线【线段】与地球椭球求交（losBlocked）。
//
// ★ 两条与对地那张表【刻意不同】的口径（都是为了把计算量压下来）：
//   ① 一行 = 一颗目标星，不是「目标星 × 波束」。多波束天线对同一颗星只报【取到最大方向性的那个波束】，
//      波束号/名单列一列。贵的那几列（Min/Max Pointing 要 72 次重采样、Xpol/Slope 各要 2~3 次）只对
//      胜出波束算一遍 —— 94 波束的 HTS 下这就是 94 倍的差距。
//   ② 目标星【由用户点选】，不是把在场的星全算一遍。星座动辄上千颗，全量 SGP4 + 逐星取值毫无意义，
//      而且结果一屏也读不完。想看哪颗加哪颗，或用「加入波束内的星」一次性把落在波束里的捞进来。
//
// ★ 时间窗口口径（时段扫描）：
//   · 判据 = 落在方向图域内 && Dir ≥ 门限 && 视线没被地球挡（遮挡可关）。门限两种口径：相对波束峰值
//     （默认 −3 dB，与画面上的等值线同一口径，换天线不用重设）或绝对 dBi。
//   · 扫描步长【由角位移反控】，不是固定秒数 —— 波束比地平锥窄两个量级，固定步长必漏短穿越。见 satcovScan.js。
//   · 窗内只在【峰值时刻】算一遍完整指标（贵列同理）：一次穿越报一行，报的是这次穿越最好的那一刻。
//   · 源星与目标星【两头都按各自星历走】；天线指向随之重算（锁定/跟随/对星跟踪各按其语义，见 boreSettingsAtPos）。
import { ref, reactive, computed } from 'vue'
import sat from '../constellation/satellite.js'
import { sampleBeamAtEcef, sampleBeamAtParam, invGridDir, perturbSpacecraft, antennaBasis, axialRatioDb, beamBasisFrom, boreSettingsAtPos } from './coverage.js'
import { losBlocked } from './shellProj.js'
import { scanWindows, summarize } from './satcovScan.js'
import { A } from '../wgs84.js'

const R2D = 180 / Math.PI
// 目标星上限：点选式下正常远不会碰到，留作「加入波束内的星」批量捞取时的兜底。
// 超出即截断，并在读数行明写截了多少 —— 静默截断会让人以为「就这么多星」。
const MAX_TARGETS = 500

let _tid = 1
const newTid = () => 'tg' + Date.now().toString(36) + (_tid++)

const COL_DEFS = [
  { key: 'no', label: 'No.', w: 44, num: true, fix: 0 },
  { key: 'satName', label: '源卫星', w: 96 },
  { key: 'antName', label: '天线', w: 100 },
  { key: 'tgtName', label: '目标卫星', w: 128 },
  { key: 'noradId', label: 'NORAD', w: 68, num: true, fix: 0 },
  { key: 'group', label: '分组', w: 88 },
  { key: 'tgtAlt', label: '高度', w: 78, num: true, fix: 1, unit: 'km', tip: '目标星大地高（WGS84 椭球面以上）' },
  { key: 'shell', label: '壳层', w: 84, tip: '按地心半径就近归入的轨道壳层；未建对应壳层显示 —' },
  { key: 'tgtLon', label: '星下点经度', w: 92, num: true, fix: 2, unit: '°E' },
  { key: 'tgtLat', label: '星下点纬度', w: 92, num: true, fix: 2, unit: '°N' },
  { key: 'state', label: '状态', w: 66, tip: '空=正常取到值；域外=该方向不在方向图网格内；背面=在视轴背后；遮挡=星-星视线被地球挡住' },
  { key: 'beamNo', label: '波束号', w: 56, num: true, fix: 0, tip: '取到最大方向性的那个波束' },
  { key: 'beamName', label: '波束', w: 110, tip: '取到最大方向性的那个波束' },
  { key: 'scAz', label: 'S/C Az', w: 66, num: true, fix: 3, unit: '°', tip: '源星天底系下、指向该目标星的方位角（星下点方向为 0）' },
  { key: 'scEl', label: 'S/C El', w: 66, num: true, fix: 3, unit: '°', tip: '源星天底系下、指向该目标星的俯仰角（星下点方向为 0）' },
  { key: 'offAxis', label: '离轴角', w: 70, num: true, fix: 3, unit: '°', tip: '目标方向与波束 boresight 的夹角' },
  { key: 'u', label: 'u', w: 62, num: true, fix: 4 },
  { key: 'v', label: 'v', w: 62, num: true, fix: 4 },
  { key: 'slant', label: '斜距', w: 88, num: true, fix: 1, unit: 'km' },
  { key: 'dir', label: 'Dir', w: 74, num: true, fix: 2, unit: 'dB' },
  { key: 'param', label: 'Parameter', w: 84, num: true, fix: 2, unit: 'dB' },
  { key: 'minPt', label: 'Min Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'maxPt', label: 'Max Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'xpol', label: 'Xpol C/I', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'slope', label: 'Slope', w: 86, num: true, fix: 2, unit: 'dB/°' },
  { key: 'ar', label: 'AR', w: 70, num: true, fix: 2, unit: 'dB' }
]
const COL_GROUPS = [
  { title: '标识', keys: ['satName', 'antName', 'tgtName', 'noradId', 'group'] },
  { title: '目标', keys: ['tgtAlt', 'shell', 'tgtLon', 'tgtLat', 'state'] },
  { title: '波束', keys: ['beamNo', 'beamName'] },
  { title: '几何', keys: ['scAz', 'scEl', 'offAxis', 'u', 'v', 'slant'] },
  { title: '性能', keys: ['dir', 'param', 'minPt', 'maxPt', 'xpol', 'slope', 'ar'] }
]
// —— 时段视图：一行 = 一次「照到」的时段。窗内的指标一律取【峰值时刻】那一瞬（贵列同理，见文件头）——
const WIN_COLS = [
  { key: 'no', label: 'No.', w: 44, num: true, fix: 0 },
  { key: 'satName', label: '源卫星', w: 96 },
  { key: 'antName', label: '天线', w: 100 },
  { key: 'tgtName', label: '目标卫星', w: 128 },
  { key: 'noradId', label: 'NORAD', w: 68, num: true, fix: 0 },
  { key: 'group', label: '分组', w: 88 },
  { key: 'winNo', label: '窗口', w: 52, num: true, fix: 0, tip: '该目标星在本时窗内的第几次' },
  { key: 'startAt', label: '开始', w: 152, time: true },
  { key: 'endAt', label: '结束', w: 152, time: true },
  { key: 'startMin', label: '起始', w: 78, num: true, fix: 2, unit: '+min', tip: '相对时窗起点的分钟数' },
  { key: 'durMin', label: '时长', w: 78, num: true, fix: 2, unit: 'min' },
  { key: 'trunc', label: '截断', w: 56, tip: '该端点不是真实穿越，而是撞上了时窗端点或星历断档' },
  { key: 'peakAt', label: '峰值时刻', w: 152, time: true },
  { key: 'peakMin', label: '峰值', w: 78, num: true, fix: 2, unit: '+min' },
  { key: 'dir', label: '峰值 Dir', w: 82, num: true, fix: 2, unit: 'dB' },
  { key: 'meanDir', label: '均值 Dir', w: 82, num: true, fix: 2, unit: 'dB', tip: '窗内按时间加权的功率平均（线性域平均后转 dB），非 dB 直接平均' },
  { key: 'param', label: '峰值 Parameter', w: 104, num: true, fix: 2, unit: 'dB' },
  { key: 'minOff', label: '最小离轴角', w: 92, num: true, fix: 3, unit: '°', tip: '按扫描采样取，未二次精炼' },
  { key: 'beamNo', label: '波束号', w: 56, num: true, fix: 0 },
  { key: 'beamName', label: '波束', w: 110 },
  { key: 'offAxis', label: '峰值离轴角', w: 92, num: true, fix: 3, unit: '°' },
  { key: 'slant', label: '峰值斜距', w: 90, num: true, fix: 1, unit: 'km' },
  { key: 'tgtAlt', label: '高度', w: 78, num: true, fix: 1, unit: 'km' },
  { key: 'shell', label: '壳层', w: 84 },
  { key: 'tgtLon', label: '星下点经度', w: 92, num: true, fix: 2, unit: '°E' },
  { key: 'tgtLat', label: '星下点纬度', w: 92, num: true, fix: 2, unit: '°N' },
  { key: 'scAz', label: 'S/C Az', w: 66, num: true, fix: 3, unit: '°' },
  { key: 'scEl', label: 'S/C El', w: 66, num: true, fix: 3, unit: '°' },
  { key: 'u', label: 'u', w: 62, num: true, fix: 4 },
  { key: 'v', label: 'v', w: 62, num: true, fix: 4 },
  { key: 'minPt', label: 'Min Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'maxPt', label: 'Max Pointing', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'xpol', label: 'Xpol C/I', w: 92, num: true, fix: 2, unit: 'dB' },
  { key: 'slope', label: 'Slope', w: 86, num: true, fix: 2, unit: 'dB/°' },
  { key: 'ar', label: 'AR', w: 70, num: true, fix: 2, unit: 'dB' }
]
const WIN_GROUPS = [
  { title: '标识', keys: ['satName', 'antName', 'tgtName', 'noradId', 'group'] },
  { title: '时段', keys: ['winNo', 'startAt', 'endAt', 'startMin', 'durMin', 'trunc'] },
  { title: '峰值', keys: ['peakAt', 'peakMin', 'dir', 'meanDir', 'param', 'minOff'] },
  { title: '波束', keys: ['beamNo', 'beamName'] },
  { title: '几何', keys: ['offAxis', 'slant', 'tgtAlt', 'shell', 'tgtLon', 'tgtLat', 'scAz', 'scEl', 'u', 'v'] },
  { title: '性能', keys: ['minPt', 'maxPt', 'xpol', 'slope', 'ar'] }
]
// —— 汇总视图：一行 = 一颗目标星，报它在整个时窗里的统计 ——
const SUM_COLS = [
  { key: 'no', label: 'No.', w: 44, num: true, fix: 0 },
  { key: 'satName', label: '源卫星', w: 96 },
  { key: 'antName', label: '天线', w: 100 },
  { key: 'tgtName', label: '目标卫星', w: 128 },
  { key: 'noradId', label: 'NORAD', w: 68, num: true, fix: 0 },
  { key: 'group', label: '分组', w: 88 },
  { key: 'nWin', label: '窗口数', w: 64, num: true, fix: 0 },
  { key: 'totMin', label: '总时长', w: 84, num: true, fix: 2, unit: 'min' },
  { key: 'pct', label: '占比', w: 70, num: true, fix: 2, unit: '%', tip: '照到的总时长 ÷ 时窗长度' },
  { key: 'maxWinMin', label: '最长', w: 78, num: true, fix: 2, unit: 'min' },
  { key: 'minWinMin', label: '最短', w: 78, num: true, fix: 2, unit: 'min' },
  { key: 'avgWinMin', label: '平均', w: 78, num: true, fix: 2, unit: 'min' },
  { key: 'maxGapMin', label: '最长空档', w: 92, num: true, fix: 2, unit: 'min', tip: '两次照到之间的最长间隔；含时窗首尾（开头/末尾没被照到也算一段）' },
  { key: 'gapCount', label: '空档数', w: 64, num: true, fix: 0 },
  { key: 'firstAt', label: '首次开始', w: 152, time: true },
  { key: 'dir', label: '全窗峰值 Dir', w: 100, num: true, fix: 2, unit: 'dB' },
  { key: 'peakAt', label: '峰值时刻', w: 152, time: true },
  { key: 'beamName', label: '峰值波束', w: 110 },
  { key: 'state', label: '状态', w: 76, tip: '空=有窗口；无窗口=整个时窗内都没达到门限' },
  { key: 'tgtAlt', label: '高度', w: 78, num: true, fix: 1, unit: 'km' },
  { key: 'shell', label: '壳层', w: 84 }
]
const SUM_GROUPS = [
  { title: '标识', keys: ['satName', 'antName', 'tgtName', 'noradId', 'group'] },
  { title: '统计', keys: ['nWin', 'totMin', 'pct', 'maxWinMin', 'minWinMin', 'avgWinMin', 'maxGapMin', 'gapCount', 'firstAt'] },
  { title: '峰值', keys: ['dir', 'peakAt', 'beamName'] },
  { title: '目标', keys: ['state', 'tgtAlt', 'shell'] }
]
// 角步进档 → 「几倍网格步距」。网格步距是方向图自身的分辨率，比它还细的结构本就不存在；
// 标准档 2 格 = 任何一个方向图特征至少被采到 2 次。窗口窄于 2×角步进就可能被漏（见 satcovScan 测试③）。
const RES_K = { coarse: 4, std: 2, fine: 1 }

function colMap(defs, on) {
  const m = {}
  for (const c of defs) m[c.key] = false
  for (const k of on) m[k] = true
  return m
}
function defaultOpts() {
  return {
    cols: colMap(COL_DEFS, ['no', 'tgtName', 'tgtAlt', 'shell', 'state', 'beamName', 'offAxis', 'slant', 'dir', 'param']),
    winCols: colMap(WIN_COLS, ['no', 'tgtName', 'winNo', 'startAt', 'durMin', 'peakAt', 'dir', 'beamName', 'minOff']),
    sumCols: colMap(SUM_COLS, ['no', 'tgtName', 'nWin', 'totMin', 'pct', 'maxGapMin', 'dir', 'peakAt']),
    // 目标由用户点选 → 默认【不过滤】：选了却不显示比多显示几行更糟。想只看照到的，勾上过滤。
    filterOn: false, minDir: 0,
    sameAsAnt: true, pol: 'RSS', pathLoss: 'none', gainOffset: 0,
    pointAz: 0, pointEl: 0, pointYaw: 0,
    beamSel: null                    // null = 在全部波束里取最大；否则只在选中的波束里取
  }
}

export function useSatPerfTable() {
  const rows = ref([])
  const ctxInfo = ref(null)
  const ctxBeams = ref([])
  const query = ref('')
  const optsByAnt = ref({})
  const note = ref('')               // 运行时读数（目标星数 / 截断 / 耗时），面板一行显示

  // ===== 目标星库（用户点选，随页面快照存盘）=====
  // 只存身份（名字 + NORAD），不存 satrec —— 星历会更新，每次取值时由页面按名字/编号重新解析。
  const picks = ref([])
  const pickedNames = computed(() => picks.value.map((p) => p.name))
  const hasPick = (name, noradId) => picks.value.some((p) => (noradId && p.noradId === noradId) || p.name === name)
  function addTarget(e) {
    if (!e || !e.name || hasPick(e.name, e.noradId)) return false
    picks.value = [...picks.value, { id: newTid(), name: e.name, noradId: e.noradId || null, group: e.group || '' }]
    return true
  }
  // 批量加入（「加入波束内的星」）：返回真正新增的数量；超上限即截断，由调用方在读数行说明
  function addTargets(list) {
    let n = 0
    const next = picks.value.slice()
    for (const e of (list || [])) {
      if (next.length >= MAX_TARGETS) break
      if (!e || !e.name || next.some((p) => (e.noradId && p.noradId === e.noradId) || p.name === e.name)) continue
      next.push({ id: newTid(), name: e.name, noradId: e.noradId || null, group: e.group || '' }); n++
    }
    if (n) picks.value = next
    return n
  }
  function removeTarget(id) { picks.value = picks.value.filter((p) => p.id !== id) }
  function clearTargets() { picks.value = [] }

  let optsTemplate = null
  const cloneOpts = (o) => JSON.parse(JSON.stringify(o))
  function getOpts(key) {
    if (!key) return defaultOpts()
    if (!optsByAnt.value[key]) {
      const base = defaultOpts()
      optsByAnt.value[key] = optsTemplate
        ? { ...base, ...cloneOpts(optsTemplate), cols: { ...base.cols, ...(optsTemplate.cols || {}) }, winCols: { ...base.winCols, ...(optsTemplate.winCols || {}) }, sumCols: { ...base.sumCols, ...(optsTemplate.sumCols || {}) }, beamSel: null }
        : base
    }
    return optsByAnt.value[key]
  }
  function rememberOpts(key) { const o = key && optsByAnt.value[key]; if (o) optsTemplate = cloneOpts({ ...o, beamSel: null }) }
  function resetOpts(key) { if (key) optsByAnt.value = { ...optsByAnt.value, [key]: defaultOpts() } }
  const visibleColumns = (o) => COL_DEFS.filter((c) => o && o.cols && o.cols[c.key])

  // ===== 单元格文本：网格显示 / TSV 导出 / 复制走同一条口径（时刻列的时区由宿主注入）=====
  let _fmtTime = (ms) => {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }
  function setTimeFmt(fn) { if (typeof fn === 'function') _fmtTime = fn }
  function fmtCell(c, v) {
    if (v == null || v === '') return ''
    if (c.time) return Number.isFinite(v) ? _fmtTime(v) : ''
    if (c.num && typeof v === 'number') return Number.isFinite(v) ? v.toFixed(c.fix != null ? c.fix : 2) : ''
    return String(v)
  }

  // 指向误差 → 增益波动：与对地表同一套（椭圆误差区边界 × yaw 端点实采方向图取极值，非一阶线性化）。
  const PT_N = 24
  function pointMinMax(beam, igrid, basis, P, opts, baseDb, dAz, dEl, dYaw) {
    if (baseDb == null) return { min: null, max: null }
    if (!(dAz > 0) && !(dEl > 0) && !(dYaw > 0)) return { min: baseDb, max: baseDb }
    const at = (az, el, yaw) => {
      const b = (az || el || yaw) ? perturbSpacecraft(basis, az, el, yaw) : basis
      const r = sampleBeamAtEcef(beam, igrid, b, P, opts)
      return r ? r.db : null
    }
    const center = at(0, 0, 0)
    if (center == null) return { min: baseDb, max: baseDb }
    let lo = 0, hi = 0
    const acc = (db) => { if (db == null) return; const d = db - center; if (d < lo) lo = d; if (d > hi) hi = d }
    const yaws = dYaw > 0 ? [0, dYaw, -dYaw] : [0]
    for (let i = 0; i < PT_N; i++) {
      const t = (2 * Math.PI * i) / PT_N, a = dAz * Math.cos(t), e = dEl * Math.sin(t)
      for (const y of yaws) acc(at(a, e, y))
    }
    if (dYaw > 0) { acc(at(0, 0, dYaw)); acc(at(0, 0, -dYaw)) }
    return { min: baseDb + lo, max: baseDb + hi }
  }

  // 真峰值 dB（相对峰值口径的扣减基准）：与对地表同法，按 beam×pol 记忆化
  function refinedPeakDb(beam, pol) {
    const k = '_pk_' + pol
    if (beam[k] !== undefined) return beam[k]
    const { P1, P2, grid } = beam, NX = grid.NX, NY = grid.NY, N = NX * NY
    const pw = (i) => { const a = P1[i], b = P2 ? P2[i] : 0
      return pol === 'P1' ? a : pol === 'P2' ? b : pol === 'RSS' ? a + b : pol === 'P1/P2' ? (b > 0 ? a / b : 0) : pol === 'P2/P1' ? (a > 0 ? b / a : 0) : a }
    let mi = 0, mv = -Infinity
    for (let i = 0; i < N; i++) { const v = pw(i); if (v > mv) { mv = v; mi = i } }
    if (!(mv > 0)) { beam[k] = null; return null }
    const r = (mi / NX) | 0, c = mi % NX
    const inc = (fm, f0, fp) => { const den = 2 * f0 - fm - fp; return den > 0 ? (fp - fm) * (fp - fm) / (8 * den) : 0 }
    let peak = mv
    if (c > 0 && c < NX - 1) peak += inc(pw(mi - 1), mv, pw(mi + 1))
    if (r > 0 && r < NY - 1) peak += inc(pw(mi - NX), mv, pw(mi + NX))
    beam[k] = peak > 0 ? 10 * Math.log10(peak) : null
    return beam[k]
  }

  // ==================== 取值内核（瞬时表与时段表共用）====================
  // 一次建好本轮的全部口径量（极化/路径损耗/波束筛选/网格盒/壳层表），之后逐目标只调它的方法。
  // ★ 方向 → 网格坐标只算一次，再按各波束的网格盒剪枝逐波束插值：94 波束的 HTS 下，一个方向通常只落在
  //   一两个波束的盒子里，其余本来就返回 null（剪枝不改结果，只是不做无用功）。
  function perfCalc(ctx, o, shells, hExKm) {
    const st = ctx.settings, same = o.sameAsAnt, igrid = ctx.igrid, icomp = ctx.icomp
    const polD = same ? st.pol : o.pol
    const dirOpts = { pol: polD, gainOffset: 0, pathLoss: 'none' }
    const parOpts = { pol: polD, gainOffset: same ? st.gainOffset : o.gainOffset, pathLoss: same ? st.pathLoss : o.pathLoss }
    const rel = same && st.ctype === 'rel'
    const beamAllow = Array.isArray(o.beamSel) ? new Set(o.beamSel) : null
    const beams = ctx.beams.filter((b) => !beamAllow || beamAllow.has(b.bi))
    const shellList = (shells || []).map((x) => ({ name: x.name, R: A + x.altKm }))
    // 预筛用的网格域【并集】：多波束 GRD 各 set 的 XS/XE 可以不同，拿 beams[0] 当门会误杀落在别的波束域里的星
    let gx0 = Infinity, gx1 = -Infinity, gy0 = Infinity, gy1 = -Infinity, cell = Infinity
    for (const bm of beams) {
      const g = bm.beam && bm.beam.grid; if (!g) continue
      gx0 = Math.min(gx0, g.XS, g.XE); gx1 = Math.max(gx1, g.XS, g.XE)
      gy0 = Math.min(gy0, g.YS, g.YE); gy1 = Math.max(gy1, g.YS, g.YE)
      if (g.NX > 1) cell = Math.min(cell, Math.abs(g.XE - g.XS) / (g.NX - 1))
      if (g.NY > 1) cell = Math.min(cell, Math.abs(g.YE - g.YS) / (g.NY - 1))
    }
    const hasBounds = gx0 <= gx1 && gy0 <= gy1
    // 域的角半径（外接圆）：时段扫描在域外按「离域还有多远」放大步长，宁可估大（只是慢一点，不会漏）
    const domRadDeg = hasBounds
      ? Math.min(170, Math.hypot(Math.max(Math.abs(gx0), Math.abs(gx1)), Math.max(Math.abs(gy0), Math.abs(gy1))) + 2)
      : 170
    const gridCell = Number.isFinite(cell) ? cell : 0.1

    // 目标点 → 天线系方向余弦 + 网格坐标 + 斜距（一次算完，多波束共用）
    function aim(basis, P) {
      const S = basis.S, x = basis.x, y = basis.y, z = basis.z
      const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2]
      const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
      const ax = ex / rs, ay = ey / rs, az = ez / rs
      const a = ax * x[0] + ay * x[1] + az * x[2]
      const b = ax * y[0] + ay * y[1] + az * y[2]
      const c = ax * z[0] + ay * z[1] + az * z[2]
      return { a, b, c, rs, xy: invGridDir(igrid, a, b, c) }
    }
    const inDomain = (xy) => !!xy && (!hasBounds || (xy[0] >= gx0 && xy[0] <= gx1 && xy[1] >= gy0 && xy[1] <= gy1))
    // 逐波束取最大：byRel=true 时按【相对各自峰值】比大小（时段门限的相对口径），否则按绝对 Dir
    function sampleMax(xy, rs, byRel) {
      let win = null, best = -Infinity, db = null, relDb = null
      for (const bm of beams) {
        const g = bm.beam.grid
        if (xy[0] < Math.min(g.XS, g.XE) || xy[0] > Math.max(g.XS, g.XE) || xy[1] < Math.min(g.YS, g.YE) || xy[1] > Math.max(g.YS, g.YE)) continue
        const r = sampleBeamAtParam(bm.beam, xy, rs, dirOpts); if (!r) continue
        let m = r.db, rl = null
        if (byRel) { const pk = refinedPeakDb(bm.beam, polD); rl = pk == null ? null : r.db - pk; m = rl == null ? -Infinity : rl }
        if (m > best) { best = m; win = bm; db = r.db; relDb = rl }
      }
      return win ? { bm: win, db, rel: relDb } : null
    }
    // 壳层归属按【地心半径】就近（壳层本就是地心球），容差 ±5% 半径差
    function shellOf(P) {
      let name = '—', bestD = Infinity
      const rGeo = Math.hypot(P[0], P[1], P[2])
      for (const s of shellList) { const d = Math.abs(rGeo - s.R); if (d < bestD && d < s.R * 0.05) { bestD = d; name = s.name } }
      return name
    }
    // 某时刻、某目标星的完整指标（瞬时表逐星、时段表逐窗的峰值时刻共用）。填进 row，返回胜出波束。
    function fillRow(row, basis, P, meta, want) {
      const am = aim(basis, P)
      if (!am) { row.state = '背面'; return null }
      row.offAxis = Math.acos(Math.max(-1, Math.min(1, am.c))) * R2D
      row.slant = am.rs
      if (want('scAz') || want('scEl')) {
        // 源星天底系（与对地表 scAz/scEl 同一参照：星下点方向为 0，不是 boresight）
        const nb = antennaBasis(meta.satLon, meta.satLon, meta.satLat || 0, 0, meta.satLat || 0, meta.satAlt)
        const S = basis.S, ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2], rs = am.rs
        const dx = (ex * nb.x[0] + ey * nb.x[1] + ez * nb.x[2]) / rs
        const dy = (ex * nb.y[0] + ey * nb.y[1] + ez * nb.y[2]) / rs
        const dz = (ex * nb.z[0] + ey * nb.z[1] + ez * nb.z[2]) / rs
        row.scAz = Math.atan2(-dx, Math.hypot(dy, dz)) * R2D; row.scEl = Math.atan2(dy, dz) * R2D
      }
      if (!inDomain(am.xy)) { row.state = am.xy ? '域外' : '背面'; return null }
      const w = sampleMax(am.xy, am.rs, false)
      if (!w) { row.state = '域外'; return null }
      const beam = w.bm.beam
      row.beamNo = w.bm.seq || w.bm.bi + 1; row.beamName = w.bm.name
      row.u = am.a; row.v = am.b; row.dir = w.db
      if (want('ar')) { const d2 = sampleBeamAtEcef(beam, ctx.igrid, basis, P, { ...dirOpts, wantComp: true }); row.ar = (d2 && d2.comp) ? axialRatioDb(d2.comp, icomp) : null }
      const wantPt = want('minPt') || want('maxPt')
      const p = (want('param') || wantPt) ? sampleBeamAtParam(beam, am.xy, am.rs, parOpts) : null
      let param = p ? p.db : null
      if (param != null && rel) { const pk = refinedPeakDb(beam, polD); if (pk != null) param -= pk }
      row.param = param
      if (wantPt) { const pt = pointMinMax(beam, ctx.igrid, basis, P, parOpts, param, o.pointAz / 2, o.pointEl / 2, o.pointYaw / 2); row.minPt = pt.min; row.maxPt = pt.max }
      if (want('xpol')) {
        const a1 = sampleBeamAtParam(beam, am.xy, am.rs, { pol: 'P1', gainOffset: 0, pathLoss: 'none' })
        const b1 = sampleBeamAtParam(beam, am.xy, am.rs, { pol: 'P2', gainOffset: 0, pathLoss: 'none' })
        row.xpol = (a1 && b1) ? a1.db - b1.db : null
      }
      if (want('slope')) {
        const dd = 0.1
        const ga = sampleBeamAtEcef(beam, ctx.igrid, perturbSpacecraft(basis, dd, 0, 0), P, dirOpts)
        const ge = sampleBeamAtEcef(beam, ctx.igrid, perturbSpacecraft(basis, 0, dd, 0), P, dirOpts)
        if (ga && ge) row.slope = Math.hypot(ga.db - w.db, ge.db - w.db) / dd
      }
      return w
    }
    return { aim, inDomain, sampleMax, shellOf, fillRow, dirOpts, parOpts, rel, polD, beams, domRadDeg, gridCell, hasBounds }
  }

  // 目标星的地理量（星下点经纬度 / 高度）：SGP4 的 ECI 结果直接换算，避免 ECEF 再反解
  function geoOf(pv, gm) {
    const gd = sat.eciToGeodetic(pv.position, gm)
    return { lon: sat.degreesLong(gd.longitude), lat: sat.degreesLat(gd.latitude), alt: gd.height }
  }

  // ==================== 当前时刻：逐星取值（一行 = 一颗目标星，波束取最大）====================
  // ctx     — grd.getPerfContext(key)（含 basis / meta / settings / beams）
  // targets — [{rec, name, noradId, group, _cc}]：调用方按 picks 解析出来的活体条目（解析不到的自动缺席）
  // times   — { now, gmst, ccNow, ccGmst }（双历元：真实星按 now、合成/自定义星按 ccNow）
  // shells  — [{altKm, name}]（只用于「壳层」列的就近归属，不参与取值）
  // hExKm   — 遮挡判据的大气排除高度
  function compute(ctx, opts, targets, times, shells, hExKm = 0) {
    if (!ctx) { rows.value = []; ctxInfo.value = null; ctxBeams.value = []; note.value = ''; return }
    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0)
    const o = opts || defaultOpts()
    ctxBeams.value = ctx.beams.map((b) => ({ bi: b.bi, seq: b.seq || b.bi + 1, name: b.name, peakDb: b.peakDb }))
    const calc = perfCalc(ctx, o, shells, hExKm)
    const want = (k) => o.cols[k]
    const basis = ctx.basis, meta = ctx.meta

    const all = targets || []
    const use = all.length > MAX_TARGETS ? all.slice(0, MAX_TARGETS) : all
    const out = []
    let no = 1, inBeam = 0, occluded = 0
    for (const e of use) {
      const t = e._cc ? times.ccNow : times.now
      const gm = e._cc ? times.ccGmst : times.gmst
      let pv
      try { pv = sat.propagate(e.rec, t) } catch { continue }
      if (!pv || !pv.position) continue
      const ecf = sat.eciToEcf(pv.position, gm)
      const P = [ecf.x, ecf.y, ecf.z]
      const blocked = losBlocked(basis.S, P, hExKm)
      if (blocked) occluded++
      const g = geoOf(pv, gm)
      const base = {
        id: e.noradId || e.name, no: no++,
        satName: ctx.satName, antName: ctx.antName,
        tgtName: e.name, noradId: e.noradId, group: e.group,
        tgtAlt: g.alt, shell: calc.shellOf(P), tgtLon: g.lon, tgtLat: g.lat,
        scAz: null, scEl: null, offAxis: null, slant: null,
        beamNo: null, beamName: '', u: null, v: null,
        dir: null, param: null, minPt: null, maxPt: null, xpol: null, slope: null, ar: null, state: ''
      }
      const w = calc.fillRow(base, basis, P, meta, want)
      if (w) {
        inBeam++
        base.state = blocked ? '遮挡' : ''
        if (o.filterOn && base.dir < o.minDir) { no--; continue }
      }
      out.push(base)
    }
    rows.value = out
    ctxInfo.value = { satName: ctx.satName, antName: ctx.antName, beams: ctx.beams.length }
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0)
    note.value = `${all.length} 目标 · ${inBeam} 落入方向图 · ${occluded} 被遮挡 · ${out.length} 行 · ${ms} ms`
      + (all.length > MAX_TARGETS ? ` · 已截断至前 ${MAX_TARGETS} 个` : '')
  }

  // ==================== 时间窗口：时段扫描 ====================
  const win = reactive({
    on: false,              // false = 当前时刻，true = 时间窗口
    view: 'seg',            // 'seg' 时段 | 'sum' 汇总
    startMs: null,          // null = 跟随时间轴当前时刻
    durH: 24,
    thrMode: 'rel',         // 'rel' 相对波束峰值 | 'abs' 绝对 dBi
    thrRel: -3, thrAbs: 0,
    losOn: true,            // 视线被地球挡住 = 出窗
    res: 'std',             // 角步进档：coarse / std / fine
    gantt: true,
    busy: false, progress: 0, msg: ''
  })
  const winRows = ref([])
  const sumRows = ref([])
  const winNote = ref('')
  const winInfo = ref(null)   // { t0Ms, t1Ms, thrDb, nWin, samples, ms, budgetHit, minStepHit, truncated }
  const winThr = () => (win.thrMode === 'rel' ? Number(win.thrRel) : Number(win.thrAbs)) || 0
  // 「输入已变」＝当前输入的指纹 ≠ 出这份结果时的指纹。用指纹而不是一个 stale 标志位 + watcher：
  // 标志位靠 watcher 时序，「改完参数当场点计算」这种同一拍里的操作，watcher 可能在扫描【之后】才刷，
  // 结果刚算完就自称过期。指纹是当场比对，谁先谁后都不会错判。
  const winFp = ref('')
  const winSig = (key) => [key || '', win.durH, win.startMs, win.thrMode, winThr(), win.losOn ? 1 : 0, win.res,
    picks.value.map((p) => p.noradId || p.name).join(',')].join('|')
  const winStaleFor = (key) => !winInfo.value || winFp.value !== winSig(key)
  let _winToken = 0
  function cancelWindows() { _winToken++; win.busy = false; win.msg = '已取消' }

  // ctx/opts/targets/times/shells/hExKm 同 compute；env 补上时段扫描才需要的东西：
  //   env.srcRec   — 源星 {rec,_cc}；固定星（无星历）给 null → 源星位置恒取 ctx.meta
  //   env.boreRec  — 对星指向（sat/satoff）的目标星 {rec,_cc}；非该模式或解析不到给 null
  //   env.onDone   — 扫完回调（宿主刷新读数用）
  async function computeWindows(ctx, opts, targets, times, shells, hExKm = 0, env = {}) {
    const token = ++_winToken
    if (!ctx) { winRows.value = []; sumRows.value = []; winInfo.value = null; win.msg = ''; winNote.value = ''; return }
    const o = opts || defaultOpts()
    ctxBeams.value = ctx.beams.map((b) => ({ bi: b.bi, seq: b.seq || b.bi + 1, name: b.name, peakDb: b.peakDb }))
    ctxInfo.value = { satName: ctx.satName, antName: ctx.antName, beams: ctx.beams.length }
    const all = targets || []
    if (!all.length) { winRows.value = []; sumRows.value = []; winInfo.value = null; win.msg = ''; winNote.value = ''; winFp.value = ''; return }

    const t0 = (typeof performance !== 'undefined' ? performance.now() : 0)
    win.busy = true; win.progress = 0; win.msg = ''
    const calc = perfCalc(ctx, o, shells, hExKm)
    const want = (k) => o.winCols[k] || o.sumCols[k]
    const thr = winThr(), byRel = win.thrMode === 'rel'
    const t0Ms = Number.isFinite(win.startMs) ? win.startMs : times.now.getTime()
    const durH = Math.max(0.02, Math.min(720, Number(win.durH) || 24))
    const t1Ms = t0Ms + durH * 3600 * 1000
    const ccOff = times.ccNow && times.now ? times.ccNow.getTime() - times.now.getTime() : 0
    const angStep = Math.max(0.01, Math.min(1, RES_K[win.res] * calc.gridCell))
    const st0 = ctx.settings, meta0 = ctx.meta

    // —— 任意时刻的源星位置：有星历按星历走，固定星恒定。口径与实时路一致（星下点 lon/lat/alt）——
    const srcRec = env.srcRec || null
    const baseMeta = { satLon: meta0.satLon, satLat: meta0.satLat || 0, satAlt: meta0.satAlt }
    const srcMetaAt = srcRec
      ? (tMs) => {
        const d = new Date(tMs + (srcRec._cc ? ccOff : 0))
        let pv
        try { pv = sat.propagate(srcRec.rec, d) } catch { return null }
        if (!pv || !pv.position) return null
        const g = geoOf(pv, sat.gstime(d))
        return { satLon: g.lon, satLat: g.lat, satAlt: g.alt }
      }
      : () => baseMeta
    const ecefAt = (rec, tMs) => {
      const d = new Date(tMs)
      let pv
      try { pv = sat.propagate(rec, d) } catch { return null }
      if (!pv || !pv.position) return null
      const e = sat.eciToEcf(pv.position, sat.gstime(d))
      return [e.x, e.y, e.z]
    }
    const boreRec = env.boreRec || null
    const boreAt = (tMs) => (boreRec ? ecefAt(boreRec.rec, tMs + (boreRec._cc ? ccOff : 0)) : null)
    const needBore = st0.boreType === 'sat' || st0.boreType === 'satoff'
    // 某时刻的天线基底：源星走到哪 → 指向字段按各自语义重算 → 基底
    const basisAt = (tMs, m) => beamBasisFrom(m, boreSettingsAtPos(st0, baseMeta, { lon: m.satLon, lat: m.satLat }), needBore ? boreAt(tMs) : null)

    const use = all.length > MAX_TARGETS ? all.slice(0, MAX_TARGETS) : all
    const segs = [], sums = [], bands = []
    let no = 1, samples = 0, budgetHit = false, minStepHit = false, lastYield = t0
    for (let i = 0; i < use.length; i++) {
      if (token !== _winToken) return                    // 被新的计算或取消作废
      const e = use[i]
      const tOff = e._cc ? ccOff : 0
      const evalAt = (tMs) => {
        const m = srcMetaAt(tMs); if (!m) return null
        const basis = basisAt(tMs, m)
        const P = ecefAt(e.rec, tMs + tOff); if (!P) return null
        const am = calc.aim(basis, P); if (!am) return null
        let val = null
        if (calc.inDomain(am.xy)) {
          const w = calc.sampleMax(am.xy, am.rs, byRel)
          if (w) val = byRel ? w.rel : w.db
        }
        const blocked = win.losOn ? losBlocked(basis.S, P, hExKm) : false
        return { d: [am.a, am.b, am.c], on: val != null && val >= thr && !blocked, val }
      }
      const r = scanWindows(evalAt, t0Ms, t1Ms, { domRadDeg: calc.domRadDeg, angStepDeg: angStep, thrDb: thr })
      samples += r.samples; budgetHit = budgetHit || r.budgetHit; minStepHit = minStepHit || r.minStepHit
      const idBase = e.noradId || e.name

      // 每个窗口在【峰值时刻】算一遍完整指标（贵列同理）：一次穿越报一行，报的是这次穿越最好的那一刻
      const wrows = []
      for (let k = 0; k < r.windows.length; k++) {
        const w = r.windows[k]
        const row = {
          id: idBase + '#' + k, no: no++, satName: ctx.satName, antName: ctx.antName,
          tgtName: e.name, noradId: e.noradId, group: e.group,
          winNo: k + 1, startAt: w.startMs, endAt: w.endMs,
          startMin: (w.startMs - t0Ms) / 60000, durMin: w.durMin,
          trunc: (w.truncStart ? '起' : '') + (w.truncEnd ? '止' : ''),
          peakAt: w.peakMs, peakMin: (w.peakMs - t0Ms) / 60000,
          meanDir: null, minOff: w.minOff, state: '',
          tgtAlt: null, shell: '—', tgtLon: null, tgtLat: null,
          scAz: null, scEl: null, offAxis: null, slant: null, beamNo: null, beamName: '', u: null, v: null,
          dir: null, param: null, minPt: null, maxPt: null, xpol: null, slope: null, ar: null
        }
        const m = srcMetaAt(w.peakMs)
        const d = new Date(w.peakMs + tOff)
        let pv
        try { pv = sat.propagate(e.rec, d) } catch { pv = null }
        if (m && pv && pv.position) {
          const gm = sat.gstime(d), ecf = sat.eciToEcf(pv.position, gm)
          const P = [ecf.x, ecf.y, ecf.z], g = geoOf(pv, gm)
          row.tgtAlt = g.alt; row.tgtLon = g.lon; row.tgtLat = g.lat; row.shell = calc.shellOf(P)
          calc.fillRow(row, basisAt(w.peakMs, m), P, m, want)
          // 相对口径下，扫描里的 val 是「相对各自波束峰值」的量；均值按同一口径折回绝对 dB，与 Dir 列可比
          if (w.meanVal != null && row.dir != null && w.peakVal != null) row.meanDir = row.dir + (w.meanVal - w.peakVal)
        } else row.state = '星历缺失'
        wrows.push(row)
      }
      segs.push(...wrows)

      const s = summarize(r.windows, t0Ms, t1Ms)
      const pk = wrows.length ? wrows.reduce((a, b) => ((b.dir != null && (a == null || a.dir == null || b.dir > a.dir)) ? b : a), null) : null
      sums.push({
        id: idBase, no: sums.length + 1, satName: ctx.satName, antName: ctx.antName,
        tgtName: e.name, noradId: e.noradId, group: e.group,
        nWin: s.nWin, totMin: s.totMin, pct: s.pct,
        maxWinMin: s.maxWinMin, minWinMin: s.minWinMin, avgWinMin: s.avgWinMin,
        maxGapMin: s.maxGapMin, gapCount: s.gapCount, firstAt: s.firstMs,
        dir: pk ? pk.dir : null, peakAt: pk ? pk.peakAt : null, beamName: pk ? pk.beamName : '',
        tgtAlt: pk ? pk.tgtAlt : null, shell: pk ? pk.shell : '—',
        state: s.nWin ? '' : '无窗口'
      })
      bands.push({ id: idBase, name: e.name, nWin: r.windows.length, segs: r.windows.map((w) => ({ a: (w.startMs - t0Ms) / (t1Ms - t0Ms), b: (w.endMs - t0Ms) / (t1Ms - t0Ms) })) })

      const now = (typeof performance !== 'undefined' ? performance.now() : 0)
      win.progress = (i + 1) / use.length
      win.msg = `扫描 ${i + 1} / ${use.length}`
      if (now - lastYield > 24) { await new Promise((res) => setTimeout(res, 0)); lastYield = (typeof performance !== 'undefined' ? performance.now() : 0) }
    }
    if (token !== _winToken) return
    winRows.value = segs
    sumRows.value = sums
    const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - t0)
    winInfo.value = {
      t0Ms, t1Ms, thrDb: thr, thrMode: win.thrMode, angStep, bands,
      nTarget: use.length, nWin: segs.length, nLit: sums.filter((x) => x.nWin > 0).length,
      samples, ms, budgetHit, minStepHit, truncated: all.length > MAX_TARGETS
    }
    win.busy = false; win.progress = 1; winFp.value = winSig(ctx.key)
    win.msg = ''
    // 读数分两份：瞬时表随手重算会覆盖 note，扫描结果的读数得单独存，否则一刷新就没了
    winNote.value = `${use.length} 目标 · ${winInfo.value.nLit} 有窗口 · ${segs.length} 个时段 · 取值 ${samples.toLocaleString()} 次 · ${ms} ms`
      + ` · 角步进 ${angStep.toFixed(3)}°`
      + (budgetHit ? ' · 已达取值预算（可能漏窗）' : '') + (minStepHit ? ' · 已到步长下限（可能漏窗）' : '')
      + (all.length > MAX_TARGETS ? ` · 已截断至前 ${MAX_TARGETS} 个` : '')
    if (typeof env.onDone === 'function') env.onDone()
  }

  // ===== 当前视图（列定义 / 行 / 分组）：三张表共用一套渲染与复制路径 =====
  const viewMode = computed(() => (!win.on ? 'now' : (win.view === 'sum' ? 'sum' : 'seg')))
  const colDefsOf = (m) => (m === 'now' ? COL_DEFS : m === 'seg' ? WIN_COLS : SUM_COLS)
  const colGroupsOf = (m) => (m === 'now' ? COL_GROUPS : m === 'seg' ? WIN_GROUPS : SUM_GROUPS)
  const colKeyOf = (m) => (m === 'now' ? 'cols' : m === 'seg' ? 'winCols' : 'sumCols')
  const viewCols = (o) => { const m = viewMode.value, ck = colKeyOf(m); return colDefsOf(m).filter((c) => o && o[ck] && o[ck][c.key]) }
  const viewRows = computed(() => (viewMode.value === 'now' ? rows.value : viewMode.value === 'seg' ? winRows.value : sumRows.value))
  const footNote = computed(() => (win.on ? winNote.value : note.value))

  const filteredRows = computed(() => {
    const q = query.value.trim().toLowerCase()
    const src = viewRows.value
    if (!q) return src
    return src.filter((r) => [r.tgtName, r.group, r.noradId].some((v) => String(v || '').toLowerCase().includes(q)))
  })

  // ==================== 波束筛选（与对地表同款）====================
  const beamQuery = ref('')
  function parseBeamSeq(qs) {
    const set = new Set()
    for (const part of qs.split(/[,，\s]+/)) {
      if (!part) continue
      const m = part.match(/^(\d+)\s*[-~]\s*(\d+)$/)
      if (m) { const a = +m[1], b = +m[2]; for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i) }
      else if (/^\d+$/.test(part)) set.add(+part)
      else return null
    }
    return set.size ? set : null
  }
  function filteredBeams() {
    const all = ctxBeams.value, q = beamQuery.value.trim()
    if (!q) return all
    const seq = parseBeamSeq(q)
    if (seq) return all.filter((b) => seq.has(b.seq || b.bi + 1))
    const ql = q.toLowerCase()
    return all.filter((b) => String(b.name).toLowerCase().includes(ql))
  }
  const beamOn = (o, bi) => !o || o.beamSel == null || o.beamSel.includes(bi)
  const beamSelCount = (o) => (!o || o.beamSel == null) ? ctxBeams.value.length : o.beamSel.length
  const allBi = () => ctxBeams.value.map((b) => b.bi)
  const filteredAllOn = (o) => { const f = filteredBeams(); return f.length > 0 && f.every((b) => beamOn(o, b.bi)) }
  const filteredAnyOn = (o) => filteredBeams().some((b) => beamOn(o, b.bi))
  function normSel(arr) { const all = allBi(); const st = new Set(arr); if (all.length && all.every((i) => st.has(i))) return null; return [...st].sort((a, b) => a - b) }
  const materialize = (o) => (o.beamSel == null ? allBi() : o.beamSel.slice())
  function toggleBeam(o, bi) { if (!o) return; const st = new Set(materialize(o)); st.has(bi) ? st.delete(bi) : st.add(bi); o.beamSel = normSel([...st]) }
  function selectFiltered(o, on) {
    if (!o) return
    const ids = filteredBeams().map((b) => b.bi), st = new Set(materialize(o))
    if (on) ids.forEach((i) => st.add(i)); else ids.forEach((i) => st.delete(i))
    o.beamSel = normSel([...st])
  }

  // 复制为 TSV（表头 + 可见列），与对地表同款；时刻列走与网格同一条格式化口径
  function toTsv(cols) {
    const head = cols.map((c) => c.label + (c.unit ? `(${c.unit})` : '')).join('\t')
    const body = filteredRows.value.map((r) => cols.map((c) => fmtCell(c, r[c.key])).join('\t'))
    return [head, ...body].join('\n')
  }

  function getState() {
    return {
      optsByAnt: JSON.parse(JSON.stringify(optsByAnt.value)),
      optsTemplate: optsTemplate ? cloneOpts(optsTemplate) : null,
      picks: picks.value.map((p) => ({ name: p.name, noradId: p.noradId, group: p.group })),
      // startMs 同样要存：钉住的时窗起点是用户【显式设过】的时刻（null = 跟随时间轴），
      // 漏存就等于每次重开都被悄悄放回「跟随」，扫出来的时段与上次对不上。
      win: { on: win.on, view: win.view, startMs: win.startMs, durH: win.durH, thrMode: win.thrMode, thrRel: win.thrRel, thrAbs: win.thrAbs, losOn: win.losOn, res: win.res, gantt: win.gantt }
    }
  }
  function restoreState(st) {
    if (!st) return
    if (Array.isArray(st.picks)) picks.value = st.picks.filter((p) => p && p.name).map((p) => ({ id: newTid(), name: p.name, noradId: p.noradId || null, group: p.group || '' }))
    const fill = (c) => ({ ...defaultOpts(), ...c, cols: { ...defaultOpts().cols, ...(c.cols || {}) }, winCols: { ...defaultOpts().winCols, ...(c.winCols || {}) }, sumCols: { ...defaultOpts().sumCols, ...(c.sumCols || {}) } })
    if (st.optsByAnt && typeof st.optsByAnt === 'object') {
      const m = {}
      for (const k of Object.keys(st.optsByAnt)) m[k] = fill(st.optsByAnt[k])
      optsByAnt.value = m
    }
    optsTemplate = (st.optsTemplate && typeof st.optsTemplate === 'object') ? { ...fill(st.optsTemplate), beamSel: null } : null
    if (st.win && typeof st.win === 'object') {
      for (const k of ['on', 'view', 'durH', 'thrMode', 'thrRel', 'thrAbs', 'losOn', 'res', 'gantt']) if (st.win[k] !== undefined) win[k] = st.win[k]
      win.startMs = Number.isFinite(st.win.startMs) ? st.win.startMs : null   // 非有限值一律回到「跟随时间轴」
    }
  }

  return {
    rows, filteredRows, ctxInfo, ctxBeams, query, note, optsByAnt,
    picks, pickedNames, hasPick, addTarget, addTargets, removeTarget, clearTargets,
    colDefs: COL_DEFS, colGroups: COL_GROUPS, getOpts, visibleColumns, rememberOpts, resetOpts,
    beamQuery, filteredBeams, beamOn, beamSelCount, filteredAllOn, filteredAnyOn, toggleBeam, selectFiltered,
    compute, toTsv, getState, restoreState, setTimeFmt, fmtCell, footNote,
    // 时间窗口
    win, winRows, sumRows, winNote, winInfo, computeWindows, cancelWindows, winStaleFor, winThr,
    viewMode, viewCols, viewRows, colDefsOf, colGroupsOf, colKeyOf
  }
}
