// 性能指标表（SATSOFT Performance Table）：独立站点库 + 逐站取值 + 选项（列/过滤/口径/指向误差）。
// 站点库与地图标记解耦（可一键导入标记）；每个天线一张表，且每张表的选项独立保存（optsByAnt）。
// 取值内核见 src/viz/grd/coverage.js：sampleBeamAt（反向采样方向图）、tiltBasis（指向误差扫描）。
import { ref, computed } from 'vue'
import { sampleBeamAt, perturbSpacecraft, dirToAzEl, axialRatioDb } from './coverage.js'

let _seq = 1
const newId = () => 'st' + Date.now().toString(36) + (_seq++)
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

// 全列定义（顺序即列序）。num=右对齐数字列，fix=小数位。默认显示集见 defaultOpts。
const COL_DEFS = [
  { key: 'no', label: 'No.', w: 44, num: true },
  { key: 'satNo', label: 'Sat No', w: 52, num: true },
  { key: 'satName', label: 'Satellite', w: 96 },
  { key: 'antNo', label: 'Ant No', w: 52, num: true },
  { key: 'antName', label: 'Antenna', w: 110 },
  { key: 'beamNo', label: '波束号', w: 56, num: true },
  { key: 'stationNo', label: '站号', w: 48, num: true },
  { key: 'country', label: '国家', w: 76 },
  { key: 'city', label: '城市', w: 88 },
  { key: 'desig', label: '代号', w: 72 },
  { key: 'lon', label: '经度', w: 128, num: true, fix: 2 },
  { key: 'lat', label: '纬度', w: 128, num: true, fix: 2 },
  { key: 'scAz', label: 'S/C Az', w: 64, num: true, fix: 2 },
  { key: 'scEl', label: 'S/C El', w: 64, num: true, fix: 2 },
  { key: 'u', label: 'u', w: 62, num: true, fix: 4 },
  { key: 'v', label: 'v', w: 62, num: true, fix: 4 },
  { key: 'dir', label: 'Dir(dB)', w: 74, num: true, fix: 2 },
  { key: 'param', label: 'Parameter', w: 84, num: true, fix: 2 },
  { key: 'minPt', label: 'Min Pointing', w: 92, num: true, fix: 2 },
  { key: 'maxPt', label: 'Max Pointing', w: 92, num: true, fix: 2 },
  { key: 'xpol', label: 'Xpol C/I(dB)', w: 92, num: true, fix: 2 },
  { key: 'slope', label: 'Slope(dB/°)', w: 86, num: true, fix: 2 },
  { key: 'ar', label: 'AR(dB)', w: 70, num: true, fix: 2 }   // 由复场相位算；预置烘焙天线无相位 → 显示 —
]

// 列分组（仅供选项弹窗排版）
const COL_GROUPS = [
  { title: '标识', keys: ['satNo', 'satName', 'antNo', 'antName', 'beamNo', 'stationNo'] },
  { title: '站点', keys: ['country', 'city', 'desig', 'lon', 'lat'] },
  { title: '几何', keys: ['scAz', 'scEl', 'u', 'v'] },
  { title: '性能', keys: ['dir', 'param', 'minPt', 'maxPt', 'xpol', 'slope', 'ar'] }
]

function defaultOpts() {
  const cols = {}
  for (const c of COL_DEFS) cols[c.key] = false
  // 默认列对标 SATSOFT 只读性能表：No / Beam No / City / Desig / Lon / Lat / Dir / Parameter / Min·Max Pointing
  for (const k of ['no', 'beamNo', 'city', 'desig', 'lon', 'lat', 'dir', 'param', 'minPt', 'maxPt']) cols[k] = true
  return {
    cols,
    // 覆盖过滤默认开：结果表只列「覆盖该城市的波束」（方向性≥阈值）。城市仍完整保留在上方输入区，
    // 故一个经纬度不再因多波束而膨胀成大量行——单波束→1 行，重叠区→数行（对标 SATSOFT）。
    filterOn: true, minDir: 50,                  // 过滤：低于最低方向性的记录不显示
    sameAsAnt: true, pol: 'RSS', unit: 'dB', pathLoss: 'none', gainOffset: 0,   // 参数计算口径
    pointAz: 0, pointEl: 0, pointYaw: 0           // 指向误差：方位/俯仰/偏航各自半幅(°)，完全自定 → Min/Max Pointing（误差区恒按椭圆算）
  }
}

export function usePerfTable() {
  const stations = ref([])     // 共享站点库 [{ id, country, city, desig, lon, lat }]
  const rows = ref([])         // 当前天线的计算结果（compute 填充）
  const ctxInfo = ref(null)    // { satName, antName, beams }
  const query = ref('')        // 表内查询（国家/城市/代号）
  const optsByAnt = ref({})    // 天线 key → 选项（独立保存）
  const hidden = ref({})       // 已手动隐藏的行 id（站#波束）→ true；行为派生数据，仅内存态不存盘

  function getOpts(key) {
    if (!key) return defaultOpts()
    if (!optsByAnt.value[key]) optsByAnt.value[key] = defaultOpts()
    return optsByAnt.value[key]
  }
  const visibleColumns = (o) => COL_DEFS.filter((c) => o && o.cols && o.cols[c.key])

  // ===== 站点库 CRUD =====
  function addStation(p = {}) {
    const lon = num(p.lon), lat = num(p.lat)
    if (lon == null || lat == null) return null
    const s = { id: newId(), country: (p.country || '').trim(), city: (p.city || '').trim(), desig: (p.desig || '').trim(), lon, lat }
    stations.value = [...stations.value, s]
    return s
  }
  function updateStation(id, patch) {
    const s = stations.value.find((x) => x.id === id); if (!s) return
    if ('lon' in patch) { const v = num(patch.lon); if (v != null) s.lon = v }
    if ('lat' in patch) { const v = num(patch.lat); if (v != null) s.lat = v }
    for (const k of ['country', 'city', 'desig']) if (k in patch) s[k] = String(patch[k] == null ? '' : patch[k])
    stations.value = [...stations.value]
  }
  function removeStation(id) { stations.value = stations.value.filter((x) => x.id !== id) }

  // ===== 撤销/重做（以站点库为唯一数据源，行是派生的；调用方在每次用户操作前 pushUndo 一次）=====
  const undoStack = [], redoStack = []
  const canUndo = ref(false), canRedo = ref(false)
  const _sync = () => { canUndo.value = undoStack.length > 0; canRedo.value = redoStack.length > 0 }
  const _snap = () => ({ stations: stations.value.map((s) => ({ ...s })), hidden: { ...hidden.value } })
  const _apply = (s) => { stations.value = s.stations.map((x) => ({ ...x })); hidden.value = { ...s.hidden } }
  function pushUndo() { undoStack.push(_snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; _sync() }
  function dropUndo() { undoStack.pop(); _sync() }   // 操作未实际改动 → 丢弃刚压入的快照（不动 redo）
  function undo() { if (!undoStack.length) return false; redoStack.push(_snap()); _apply(undoStack.pop()); _sync(); return true }
  function redo() { if (!redoStack.length) return false; undoStack.push(_snap()); _apply(redoStack.pop()); _sync(); return true }
  function clearHistory() { undoStack.length = 0; redoStack.length = 0; _sync() }

  // Excel/表格粘贴：每行一站，单元格按 制表符 > 逗号 > 空白 切分；约定【末两列=经度、纬度】，
  // 之前的文本列依次填 国家/城市/代号。末两列非数字的行（表头/无效）自动跳过。返回新增条数。
  function parsePasted(text) {
    const out = []
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim(); if (!t) continue
      const c = (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : t.split(/\s+/))).map((x) => x.trim())
      if (c.length < 2) continue
      const lon = num(c[c.length - 2]), lat = num(c[c.length - 1])
      if (lon == null || lat == null) continue
      const head = c.slice(0, c.length - 2)
      out.push({ country: head[0] || '', city: head[1] || '', desig: head[2] || '', lon, lat })
    }
    return out
  }
  function addStationsBulk(text) {
    const parsed = parsePasted(text); if (!parsed.length) return 0
    const add = parsed.map((p) => ({ id: newId(), country: p.country, city: p.city, desig: p.desig, lon: p.lon, lat: p.lat }))
    stations.value = [...stations.value, ...add]
    return add.length
  }

  // Excel 式「定位粘贴」：以选中单元格为左上锚点，粘贴块按列向右、按行向下填充，
  // 超出现有站点的行自动新建。startKey 决定起始列，列序固定见 EDIT_COLS。
  const EDIT_COLS = ['country', 'city', 'desig', 'lon', 'lat']
  function parseGrid(text) {
    return String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '')
      .map((l) => (l.includes('\t') ? l.split('\t') : l.split(',')).map((x) => x.trim()))
  }
  function setStationCell(s, key, val) {
    if (key === 'lon' || key === 'lat') { const v = num(val); if (v != null) s[key] = v }
    else s[key] = String(val == null ? '' : val)
  }
  function pasteBlock(startId, startKey, text) {
    const grid = parseGrid(text); if (!grid.length) return 0
    const c0 = Math.max(0, EDIT_COLS.indexOf(startKey))
    const list = [...stations.value]
    let idx = startId ? list.findIndex((s) => s.id === startId) : list.length
    if (idx < 0) idx = list.length
    grid.forEach((cells, ri) => {
      let s = list[idx + ri]
      if (!s) { s = { id: newId(), country: '', city: '', desig: '', lon: 0, lat: 0 }; list[idx + ri] = s }
      cells.forEach((val, ci) => { const key = EDIT_COLS[c0 + ci]; if (key) setStationCell(s, key, val) })
    })
    stations.value = list.filter(Boolean)
    return grid.length
  }
  function clearStations() { stations.value = []; hidden.value = {} }
  // 仅隐藏当前行（站×波束），不影响同站其他波束行；id 稳定 → recompute 后仍生效。
  function removeRow(id) { if (id != null) hidden.value = { ...hidden.value, [id]: true } }

  // 从地图标记导入：地面站 name → 城市；点标记 → 仅经纬度。±1e-4 去重。返回新增条数。
  function importFromMarkers(points = [], mkStations = []) {
    const exists = (lon, lat) => stations.value.some((s) => Math.abs(s.lon - lon) < 1e-4 && Math.abs(s.lat - lat) < 1e-4)
    const add = []
    for (const p of mkStations) { const lon = num(p.lon), lat = num(p.lat); if (lon == null || lat == null || exists(lon, lat)) continue; add.push({ id: newId(), country: '', city: (p.name || '').trim() || '地面站', desig: '', lon, lat }) }
    for (const p of points) { const lon = num(p.lon), lat = num(p.lat); if (lon == null || lat == null || exists(lon, lat)) continue; add.push({ id: newId(), country: '', city: '', desig: '', lon, lat }) }
    if (add.length) stations.value = [...stations.value, ...add]
    return add.length
  }

  // ===== 逐站取值 =====
  // 指向误差 → 增益波动（物理最准：在误差区上【真实重采样方向图取极值】，非一阶线性化）。
  // 线性化(旧法)在峰值附近梯度→0 会误判 Min≈Max≈base，漏掉「偏指必掉增益」的二阶跌落，且强制对称；
  // 真实搜索：以名义姿态为中心，在【椭圆】误差区边界（半轴 Az×El，周上 N 点）× yaw 端点{−,0,+} 各采一次，
  //   加中心点（捕获峰值落在区内的情形）→ 取实采 dB 相对中心的最小/最大偏移 lo≤0≤hi。
  // 扰动经 perturbSpacecraft 施加于卫星刚体姿态；站点经纬度不动 → 斜距/增益偏置/路损在各采样间恒定，
  //   故 lo/hi 是纯方向图波动，与 rel/增益偏置等常数无关 → Min=baseDb+lo、Max=baseDb+hi（可不对称）。
  // 误差区固定为椭圆（TICRA 默认指向误差区），不再提供形状选项。
  const PT_N = 24       // 椭圆边界采样点数
  function pointMinMax(beam, igrid, basis, lon, lat, opts, baseDb, dAz, dEl, dYaw) {
    if (baseDb == null) return { min: null, max: null }
    if (!(dAz > 0) && !(dEl > 0) && !(dYaw > 0)) return { min: baseDb, max: baseDb }
    const at = (az, el, yaw) => {
      const b = (az || el || yaw) ? perturbSpacecraft(basis, az, el, yaw) : basis
      const r = sampleBeamAt(beam, igrid, b, lon, lat, opts)
      return r ? r.db : null
    }
    const center = at(0, 0, 0)
    if (center == null) return { min: baseDb, max: baseDb }
    let lo = 0, hi = 0
    const acc = (db) => { if (db == null) return; const d = db - center; if (d < lo) lo = d; if (d > hi) hi = d }
    const offs = []   // (Az,El) 椭圆边界偏移（半轴 dAz×dEl）
    for (let i = 0; i < PT_N; i++) { const t = (2 * Math.PI * i) / PT_N; offs.push([dAz * Math.cos(t), dEl * Math.sin(t)]) }
    const yaws = dYaw > 0 ? [0, dYaw, -dYaw] : [0]
    for (const [a, e] of offs) for (const y of yaws) acc(at(a, e, y))
    if (dYaw > 0) { acc(at(0, 0, dYaw)); acc(at(0, 0, -dYaw)) }   // 纯 yaw 端点（dAz=dEl=0 时的极值）
    return { min: baseDb + lo, max: baseDb + hi }
  }

  // 波束真峰值 dB（物理：真峰值在网格点之间，离散最大低估）。在所选极化的功率网格上找离散最大，
  // 再沿行/列各做抛物线顶点细化（可分离二次近似）后转 dB。按 beam×pol 记忆化（峰值与指向无关，
  // = 网格上场的最大值）。供「相对峰值」口径作扣减基准——同时修正旧 bm.peakDb 恒为 RSS 极化的不一致。
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
    const inc = (fm, f0, fp) => { const den = 2 * f0 - fm - fp; return den > 0 ? (fp - fm) * (fp - fm) / (8 * den) : 0 }   // 抛物线顶点相对 f0 的增量（concave 才有效）
    let peak = mv
    if (c > 0 && c < NX - 1) peak += inc(pw(mi - 1), mv, pw(mi + 1))
    if (r > 0 && r < NY - 1) peak += inc(pw(mi - NX), mv, pw(mi + NX))
    const db = peak > 0 ? 10 * Math.log10(peak) : null
    beam[k] = db
    return db
  }

  function compute(ctx, opts) {
    if (!ctx) { rows.value = []; ctxInfo.value = null; return }
    const o = opts || defaultOpts()
    const st = ctx.settings, same = o.sameAsAnt, igrid = ctx.igrid, icomp = ctx.icomp, basis = ctx.basis, meta = ctx.meta
    const polD = same ? st.pol : o.pol
    const dirOpts = { pol: polD, gainOffset: 0, pathLoss: 'none' }                                        // 纯方向性
    const parOpts = { pol: polD, gainOffset: same ? st.gainOffset : o.gainOffset, pathLoss: same ? st.pathLoss : o.pathLoss }  // 参数口径
    const rel = same && st.ctype === 'rel'
    const want = (k) => o.cols[k]
    const wantPt = want('minPt') || want('maxPt'), wantGeo = want('scAz') || want('scEl')
    // Parameter 单位换算（仅自定义口径时生效；Same as Antenna 恒为 dB）
    const unitOf = (db) => (same || o.unit === 'dB') ? db : (o.unit === 'power' ? Math.pow(10, db / 10) : Math.pow(10, db / 20))

    const out = []; let no = 1
    stations.value.forEach((s, si) => {
      const geo = wantGeo ? dirToAzEl(meta.satLon, meta.satLat || 0, meta.satAlt, s.lon, s.lat) : null
      for (const bm of ctx.beams) {
        const d = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, want('ar') ? { ...dirOpts, wantComp: true } : dirOpts)
        const dir = d ? d.db : null
        if (o.filterOn && (dir == null || dir < o.minDir)) continue                                       // 最低方向性过滤
        const p = (want('param') || wantPt) ? sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, parOpts) : null
        let param = p ? p.db : null
        if (param != null && rel) { const pk = refinedPeakDb(bm.beam, polD); if (pk != null) param -= pk }
        // Min/Max Pointing = 一阶梯度法，以 param 为中心对称展开（ΔG 是差分、与 rel/增益偏置等常数无关）。
        // 输入按【全幅误差】解释：实际半幅 = 输入/2（与 SATSOFT 一致，输入 0.06 → 用 ±0.03）。
        const pt = wantPt ? pointMinMax(bm.beam, igrid, basis, s.lon, s.lat, parOpts, param, o.pointAz / 2, o.pointEl / 2, o.pointYaw / 2) : { min: null, max: null }
        // Xpol C/I = 共极化/交叉极化 功率比（dB）
        let xpol = null
        if (want('xpol')) { const a = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, { pol: 'P1', gainOffset: 0, pathLoss: 'none' }); const b = sampleBeamAt(bm.beam, igrid, basis, s.lon, s.lat, { pol: 'P2', gainOffset: 0, pathLoss: 'none' }); xpol = (a && b) ? a.db - b.db : null }
        // Slope = 方向性对指向角的梯度幅值（中心差分，δ=0.1°）
        let slope = null
        if (want('slope') && dir != null) { const dd = 0.1; const ga = sampleBeamAt(bm.beam, igrid, perturbSpacecraft(basis, dd, 0, 0), s.lon, s.lat, dirOpts); const ge = sampleBeamAt(bm.beam, igrid, perturbSpacecraft(basis, 0, dd, 0), s.lon, s.lat, dirOpts); if (ga && ge) slope = Math.hypot(ga.db - dir, ge.db - dir) / dd }
        // AR 轴比：由复场相位算（预置烘焙天线无 comp → null）
        const ar = (want('ar') && d && d.comp) ? axialRatioDb(d.comp, icomp) : null
        out.push({
          id: s.id + '#' + bm.bi, no: no++,
          satNo: ctx.satNo, satName: ctx.satName, antNo: ctx.antNo, antName: ctx.antName,
          beamNo: bm.bi + 1, stationNo: si + 1,
          country: s.country, city: s.city, desig: s.desig, lon: s.lon, lat: s.lat,
          scAz: geo ? geo.az : null, scEl: geo ? geo.el : null, u: d ? d.u : null, v: d ? d.v : null,
          dir, param: param == null ? null : unitOf(param), minPt: pt.min, maxPt: pt.max, xpol, slope, ar,
          inPattern: d != null
        })
      }
    })
    rows.value = out
    ctxInfo.value = { satName: ctx.satName, antName: ctx.antName, beams: ctx.beams.length }
  }

  // 表内查询：国家/城市/代号 模糊（大小写不敏感）；空查询=全部。
  const filteredRows = computed(() => {
    const h = hidden.value
    const base = rows.value.filter((r) => !h[r.id])
    const q = query.value.trim().toLowerCase()
    if (!q) return base
    return base.filter((r) => [r.country, r.city, r.desig].some((v) => String(v || '').toLowerCase().includes(q)))
  })

  // ===== 持久化（站点库 + 各天线选项随页面快照存盘；表为派生数据不存）=====
  function getState() {
    return {
      stations: stations.value.map((s) => ({ country: s.country, city: s.city, desig: s.desig, lon: s.lon, lat: s.lat })),
      optsByAnt: JSON.parse(JSON.stringify(optsByAnt.value))
    }
  }
  function restoreState(st) {
    if (!st) return
    clearHistory()
    if (Array.isArray(st.stations)) stations.value = st.stations.map((s) => ({ id: newId(), country: s.country || '', city: s.city || '', desig: s.desig || '', lon: num(s.lon) || 0, lat: num(s.lat) || 0 }))
    if (st.optsByAnt && typeof st.optsByAnt === 'object') {
      const m = {}
      for (const k of Object.keys(st.optsByAnt)) m[k] = { ...defaultOpts(), ...st.optsByAnt[k], cols: { ...defaultOpts().cols, ...(st.optsByAnt[k].cols || {}) } }
      optsByAnt.value = m
    }
  }

  return {
    stations, rows, filteredRows, ctxInfo, query, optsByAnt, canUndo, canRedo,
    colDefs: COL_DEFS, colGroups: COL_GROUPS, getOpts, visibleColumns,
    addStation, updateStation, removeStation, removeRow, clearStations, addStationsBulk, pasteBlock, importFromMarkers,
    pushUndo, dropUndo, undo, redo, compute, getState, restoreState
  }
}
