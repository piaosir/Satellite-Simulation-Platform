// 标记批量表格（Excel 模块）数据模型：点标记 / 地球站 / 航迹航点三套可编辑网格的增删改 + 批量粘贴 + 撤销重做。
// 与「链路预算性能表」同款交互内核（useGridSelect），此处只提供数据侧 CRUD/解析——渲染/命中/键盘交给 useGridSelect。
// 三套数据仍是页面里的 points / stations / trajectories 三个 ref（本模块受注入的引用，改后调 sync 落盘+推图）。
import { ref } from 'vue'
import { sheetToRecords, sheetToTsv } from '../../shared/gridXlsx.js'
// 说明行「飞行; 巡航高度=10668 m; 速度=850 km/h; 起始=…; 模型=…; 图标=… px」的解析（DESIGN3 E7；相对路径：node 单测直接 import）
import { parseTrajNote, WP_ALT_M_MIN, CRUISE_ALT_M_MAX } from '../../../packages/core/models/entityRuntime.mjs'
import { trajWaypointInfo } from '../../../packages/core/models/trajKinematics.mjs'

// 空串/空白判 null（Number('')===0，否则粘贴块里的空单元格会把经纬度悄悄写成 0）
const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
// 单元格切分：制表符 > 逗号 > 空白（与性能表 parsePasted 同口径）
const splitCells = (t) => (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : t.split(/\s+/))).map((x) => x.trim())
// 定位块粘贴的分行分列：每行用 splitCells（制表符 > 逗号 > 空白）。含制表符的（Excel 复制）恒按制表符切、
// 名称里的逗号/空格不误拆；不含制表符的（手敲/文本里的「经度, 纬度」列表）才退回逗号/空白——否则选中某行后
// Ctrl+V 逗号坐标会被当作单个单元格塞进经度列、解析成 null，表象是「有空白行时批量粘贴失效」。
const parseGrid = (text) => String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => splitCells(l))

// ===== 航迹表格的列（2026-09-24「表格功能更全面，包括时间信息」）=====
// 航点一行：经度 / 纬度 / 高度（仅飞行）/ 时间 可编辑；航段 / 累计 / 航向 / 地速是推算读数（只读，按航迹排程与剖面现算）。
// 高度、时间两格默认显示推算值，手填 = 钉住该航点（高度钉点 p.altM、时刻钉点 p.tMs；首航点的时刻就是航迹起始 t0Ms），清空回推算。
export const WP_CALC_KEYS = Object.freeze(['legKm', 'cumKm', 'crs', 'gs'])
export function wpColKeys(kind) { return kind === 'flight' ? ['lon', 'lat', 'altM', 'tMs', ...WP_CALC_KEYS] : ['lon', 'lat', 'tMs', ...WP_CALC_KEYS] }
const okWpAlt = (v) => v != null && v >= WP_ALT_M_MIN && v <= CRUISE_ALT_M_MAX
const finLL = (p) => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon)
// 首航点的时刻钉点 = 航迹起始：挪到 t0Ms 上（排程只认一个起点口径；侧栏「起始」与表格首行改的是同一个数）
export function normFirstPin(t) {
  const p0 = t && Array.isArray(t.pts) ? t.pts.find(finLL) : null
  if (p0 && Number.isFinite(p0.tMs)) { t.t0Ms = Math.round(p0.tMs); delete p0.tMs }
  return t
}

// 表头行识别（粘贴块的第一行是表头时）：含「经度」「纬度」两格即是，顺带认高度 / 时间两列（带单位也认）
const HEAD_ALIAS = { lon: ['经度', 'lon', 'longitude'], lat: ['纬度', 'lat', 'latitude'], altM: ['高度', 'alt', 'altitude', 'altm'], tMs: ['时间', '时刻', 'time'] }
const headKey = (v) => String(v == null ? '' : v).replace(/[（(][^)）]*[)）]/g, '').replace(/\s+/g, '').toLowerCase()
function headerMap(cells) {
  const m = {}
  cells.forEach((v, i) => { const k = headKey(v); for (const key of Object.keys(HEAD_ALIAS)) if (m[key] == null && HEAD_ALIAS[key].includes(k)) m[key] = i })
  return m.lon != null && m.lat != null ? m : null
}

// 航点批量解析。三种写法（从上到下优先）：
//   ① 有表头行（含「经度」「纬度」）：按表头认列（高度 / 时间两列可有可无），此后各行照此取
//   ② 与本表网格同列数（从航迹表格整行复制出来的）：按网格列序取，推算列忽略
//   ③ 其余：【末两列 = 经度、纬度】（剪贴板与「无表头工作表」的老约定），前面的列忽略；只有两列时即经纬度
// 解析不出坐标的行跳过。剪贴板与「无表头工作表」共用这一条 —— 从 Excel 复制粘贴 和 导入 Excel 的行为必须逐字一致。
// opt.layout = 网格列 key 序（wpColKeys）；opt.parseTime(text, refMs) → ms（时间文本按显示时区读；只敲时分时日期沿用上一行）
function parseWpLines(text, newId, opt = {}) {
  const add = []
  let head = null, prevMs = Number.isFinite(opt.refMs) ? opt.refMs : NaN
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue
    const c = splitCells(s); if (c.length < 2) continue
    const h = headerMap(c)
    if (h) { head = h; continue }
    let lon, lat, alt = null, tt = null
    if (head) {
      lon = num(c[head.lon]); lat = num(c[head.lat])
      if (head.altM != null) alt = c[head.altM]
      if (head.tMs != null) tt = c[head.tMs]
    } else if (Array.isArray(opt.layout) && c.length === opt.layout.length) {
      const L = opt.layout, ia = L.indexOf('altM'), it = L.indexOf('tMs')
      lon = num(c[L.indexOf('lon')]); lat = num(c[L.indexOf('lat')])
      if (ia >= 0) alt = c[ia]
      if (it >= 0) tt = c[it]
    } else { lon = num(c[c.length - 2]); lat = num(c[c.length - 1]) }
    if (lon == null || lat == null) continue
    const p = { id: newId(), lat, lon }
    const a = num(alt)
    if (okWpAlt(a)) p.altM = a
    if (tt != null && String(tt).trim() !== '' && typeof opt.parseTime === 'function') {
      const ms = opt.parseTime(String(tt), prevMs)
      if (Number.isFinite(ms)) { p.tMs = Math.round(ms); prevMs = p.tMs }
    }
    add.push(p)
  }
  return add
}

// ===== 航迹 ⇄ 工作簿（一张工作表一条航迹，表名即航迹名）=====
// 航迹工作表的坐标列（必有）；高度 / 时间是可选列（TRAJ_SHEET_OPT_COLS）。导出时另带四列推算读数，导入时忽略
export const TRAJ_SHEET_COLS = [{ key: 'lon', label: '经度' }, { key: 'lat', label: '纬度' }]
export const TRAJ_SHEET_OPT_COLS = [
  { key: 'altM', label: '高度', unit: 'm', alias: ['alt', 'altitude'] },
  { key: 'tMs', label: '时间', alias: ['时刻', 'time'] }
]
// 说明行里的钉点清单（本平台导出时写：定时 = 时刻是用户定的航点、定高 = 高度是用户定的航点，按【坐标有效的航点】从 1 数）。
// 导出的高度 / 时间两列是实际值（推算的也写），导回来靠这两份清单只把原来钉住的那几格钉回去 —— 往返逐格同义；
// 手搓的工作簿没有清单（null）→ 填了的高度 / 时间一律当钉点（那就是用户给的数据）。
export function pinListOf(note, key) {
  const m = new RegExp('(?:^|;)\\s*' + key + '\\s*[=:：]\\s*([^;]*)').exec(String(note == null ? '' : note).normalize('NFKC'))
  if (!m) return null
  return m[1].split(/[,，\s]+/).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
}
export function pinNoteOf(t) {
  const pts = t && Array.isArray(t.pts) ? t.pts : []
  const tl = [], al = []
  let j = 0
  for (const p of pts) {
    if (!finLL(p)) continue
    j++
    if (j === 1 ? Number.isFinite(t.t0Ms) || Number.isFinite(p.tMs) : Number.isFinite(p.tMs)) tl.push(j)
    if (Number.isFinite(p.altM)) al.push(j)
  }
  return '定时=' + tl.join(',') + (t && t.kind === 'flight' ? '; 定高=' + al.join(',') : '')
}
// 航行/飞行是【航迹】属性、不是航点属性，写不进「首行表头 + 纯数据」的数据表 → 导出时记在 note
// （主进程 buildGridWorkbook 会把 note 单开成一张「说明」表：一行 = 表名 + 说明）。
export const TRAJ_NOTE_SHEET = '说明'
// 手搓的工作簿没有说明表 → 退回按表名认（自动名就叫「航行1 / 飞行2」），仍认不出算航行
export const trajKindOf = (s) => (/飞行|flight/i.test(String(s == null ? '' : s)) ? 'flight' : 'sea')
// 说明行里透传到航迹对象上的航迹级字段（页面 mkImportTrajXlsx 按同一张表挑）
export const TRAJ_NOTE_FIELDS = Object.freeze(['cruiseAltM', 'speedKmh', 't0Ms', 'model'])

// 重名加序号：工作表重名会被 Excel 改写，同名两条航迹在列表里也分不清
function uniqName(base, used, fallback) {
  const b = String(base == null ? '' : base).trim() || fallback || '航迹'
  let out = b
  if (used.has(out)) { let k = 2; while (used.has(b + ' (' + k + ')')) k++; out = b + ' (' + k + ')' }
  used.add(out)
  return out
}

/**
 * 一份工作簿的工作表 → 一批待建航迹 [{ name, kind, pts }]。
 *   有表头（含「经度 / 纬度」）按表头取列（高度 / 时间两列可有可无），认不出退回位置约定（末两列 = 经纬度）；
 *   经纬度缺一个的行不算航点（残缺航点画不出来，只会在网格里当垃圾行）；
 *   一个航点都读不到的表整张丢掉 —— 工作簿里常混着无关的表，不能每张都造一条空航迹。
 *   高度 / 时间：说明行带钉点清单（定时 / 定高）时只钉清单里那几个航点，没有清单时填了就钉；首航点的时刻落到 t0Ms。
 * opts：newId 造航点 id；taken 现有航迹名（去重用）；fallbackName 表名为空时的兜底名；
 *       parseTime(text, refMs) → ms（时间文本；页面按显示时区装，不给就不读时间列）。
 */
export function trajsFromSheets(sheets, opts = {}) {
  const mkId = opts.newId || (() => 'wp' + Math.random().toString(36).slice(2))
  const used = new Set(opts.taken || [])
  const notes = new Map(), data = []
  for (const s of sheets || []) {
    if (!s) continue
    if (String(s.name || '').trim() === TRAJ_NOTE_SHEET) {   // 说明表不是数据：只取它记的航迹类型
      for (const row of s.rows || []) if (row && row[0] != null) notes.set(String(row[0]).trim(), String(row[1] == null ? '' : row[1]))
      continue
    }
    if (s.rows && s.rows.length) data.push(s)
  }
  const out = []
  const parseTime = typeof opts.parseTime === 'function' ? opts.parseTime : null
  for (const s of data) {
    const nm = String(s.name || '').trim()
    const note = notes.has(nm) ? notes.get(nm) : null
    const pinT = pinListOf(note, '定时'), pinA = pinListOf(note, '定高')
    const { records } = sheetToRecords(s, [...TRAJ_SHEET_COLS, ...TRAJ_SHEET_OPT_COLS])
    let pts
    if (records) {
      pts = []
      let j = 0, prevMs = NaN
      for (const rec of records) {
        const lon = num(rec.lon), lat = num(rec.lat)
        if (lon == null || lat == null) continue
        j++
        const p = { id: mkId(), lat, lon }
        const a = num(rec.altM)
        if (okWpAlt(a) && (!pinA || pinA.includes(j))) p.altM = a
        if (parseTime && rec.tMs != null && String(rec.tMs).trim() !== '') {
          const ms = parseTime(String(rec.tMs), prevMs)
          if (Number.isFinite(ms)) { prevMs = ms; if (!pinT || pinT.includes(j)) p.tMs = Math.round(ms) }
        }
        pts.push(p)
      }
    } else {
      pts = parseWpLines(sheetToTsv(s), mkId, { parseTime })
    }
    if (!pts.length) continue
    // 说明行第一段是类型词（老工作簿只有这一段：parseTrajNote 与 trajKindOf 同式，结果不变）；随后的航迹级字段
    // （巡航高度 / 速度 / 起始时刻 / 模型）只挑解析出来的合法项透传 —— 缺字段 = 现状，缺省值不写进对象
    const extra = note != null ? parseTrajNote(note) : { kind: trajKindOf(nm) }
    const o = { name: uniqName(nm, used, opts.fallbackName), kind: extra.kind, pts }
    for (const k of TRAJ_NOTE_FIELDS) if (extra[k] !== undefined) o[k] = extra[k]
    if (o.kind !== 'flight') for (const p of pts) delete p.altM             // 航行没有高度
    normFirstPin(o)                                                         // 首航点的时刻 → 起始
    out.push(o)
  }
  return out
}

// parseTime(text, refMs) → UTC ms | NaN：航迹表格「时间」列的读法（页面按显示时区装；只敲时分时日期取 refMs 那天）
export function useMarkerTable({ points, stations, trajectories, newId, sync, parseTime }) {
  // 坐标写入：合法数字→写入；空串→清空(null，该行暂不参与渲染)；非数字文本→保留原值（坐标列不存文本）
  function setCoord(obj, key, val) {
    const v = num(val)
    if (v != null) obj[key] = v
    else if (String(val == null ? '' : val).trim() === '') obj[key] = null
  }

  // 航点原为 {lat,lon}（无 id），网格需稳定行 id 定位编辑/粘贴 → 首次开表补 id（非破坏性，持久化照带）
  function ensureWaypointIds() {
    let n = 0
    for (const t of trajectories.value) {
      if (!Array.isArray(t.pts)) continue
      for (const p of t.pts) if (p && !p.id) { p.id = newId(); n++ }
    }
    return n
  }

  // ===== 撤销 / 重做（快照三层全量；调用方在每次用户操作前 pushUndo 一次，无实际改动则 dropUndo）=====
  const undoStack = [], redoStack = []
  const canUndo = ref(false), canRedo = ref(false)
  const _flags = () => { canUndo.value = undoStack.length > 0; canRedo.value = redoStack.length > 0 }
  const _snap = () => JSON.stringify({ points: points.value, stations: stations.value, trajectories: trajectories.value })
  const _apply = (s) => { const d = JSON.parse(s); points.value = d.points || []; stations.value = d.stations || []; trajectories.value = d.trajectories || [] }
  function pushUndo() { undoStack.push(_snap()); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; _flags() }
  function dropUndo() { undoStack.pop(); _flags() }
  function undo() { if (!undoStack.length) return false; redoStack.push(_snap()); _apply(undoStack.pop()); _flags(); sync(); return true }
  function redo() { if (!redoStack.length) return false; undoStack.push(_snap()); _apply(redoStack.pop()); _flags(); sync(); return true }
  function clearHistory() { undoStack.length = 0; redoStack.length = 0; _flags() }

  // ===== 通用行操作工厂（点标记 / 地球站共用；航迹航点因嵌套单列另写）=====
  // cols：该网格列 key 顺序（末尾恒为 'lon','lat'）；makeEmpty：新建一行空对象；setCell：写一格。
  function makeLayer(getList, setList, cols, makeEmpty, setCell) {
    // 追加式批量（无选区/空表）：每行一条，约定【末两列=经度、纬度】，之前的文本列依次填非坐标列。末两列非数字的行跳过。
    function pasteAppend(text) {
      const textCols = cols.slice(0, cols.length - 2)   // 坐标之外的文本列（点标记 / 地球站均为['name']）
      const add = []
      for (const line of String(text || '').split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue
        const c = splitCells(t); if (c.length < 2) continue
        const lon = num(c[c.length - 2]), lat = num(c[c.length - 1])
        if (lon == null || lat == null) continue
        const head = c.slice(0, c.length - 2)
        const row = makeEmpty()
        textCols.forEach((k, i) => setCell(row, k, head[i] || ''))   // ★ 走 setCell：颜色/形状两列有取值规范，直接塞字符串会写进非法值
        row.lon = lon; row.lat = lat
        add.push(row)
      }
      if (add.length) setList([...getList(), ...add])
      return add.length
    }
    // Excel 式定位块粘贴：以锚点行/列为左上角向右下填充，超出的行自动新建。切列只认制表符。
    function pasteBlock(anchorId, startKey, text) {
      const grid = parseGrid(text); if (!grid.length) return 0
      const c0 = Math.max(0, cols.indexOf(startKey))
      const list = [...getList()]
      let idx = anchorId ? list.findIndex((r) => r.id === anchorId) : list.length
      if (idx < 0) idx = list.length
      grid.forEach((cells, ri) => {
        let r = list[idx + ri]
        if (!r) { r = makeEmpty(); list[idx + ri] = r }
        cells.forEach((val, ci) => { const key = cols[c0 + ci]; if (key) setCell(r, key, val) })
      })
      setList(list.filter(Boolean))
      return grid.length
    }
    function addRow(at) {
      const list = [...getList()]
      const i = (at == null || at < 0 || at > list.length) ? list.length : at
      const r = makeEmpty(); list.splice(i, 0, r); setList(list)
      return r
    }
    function update(id, patch) {
      const r = getList().find((x) => x.id === id); if (!r) return
      for (const k of Object.keys(patch)) setCell(r, k, patch[k])
      setList([...getList()])
    }
    function remove(id) { setList(getList().filter((r) => r.id !== id)) }
    function clear() { setList([]) }
    return { pasteAppend, pasteBlock, addRow, update, remove, clear }
  }

  // ---- 点标记：列 [名称, 经度, 纬度]（名称可空：新建不必起名，事后在表格或侧栏列表里补）----
  // 逐条颜色（p.color）不进表格 —— 它在侧栏列表行内那枚色块上改
  const PT_COLS = ['name', 'lon', 'lat']
  const ptLayer = makeLayer(
    () => points.value, (a) => { points.value = a }, PT_COLS,
    () => ({ id: newId(), lat: null, lon: null }),
    (r, k, v) => { if (k === 'lon' || k === 'lat') setCoord(r, k, v); else { const t = String(v == null ? '' : v).trim(); if (t) r.name = t; else delete r.name } }
  )

  // ---- 地球站：列 [名称, 经度, 纬度] ----
  const ST_COLS = ['name', 'lon', 'lat']
  const stLayer = makeLayer(
    () => stations.value, (a) => { stations.value = a }, ST_COLS,
    () => ({ id: newId(), name: '', lat: null, lon: null }),
    (r, k, v) => { if (k === 'lon' || k === 'lat') setCoord(r, k, v); else r[k] = String(v == null ? '' : v) }
  )

  // ---- 航迹航点：对某条航迹的 pts 操作。坐标列恒为 [经度, 纬度]；网格整列序见 wpColKeys（高度 / 时间 / 推算四列）----
  const WP_COLS = ['lon', 'lat']
  const trajOf = (id) => trajectories.value.find((t) => t.id === id)
  const isFirstWp = (t, p) => t.pts.find(finLL) === p
  // 该航点此刻的排程时刻（改时间只敲时分时取它的日期）：排不出程退起始、再退现在
  function refTimeOf(t, p) {
    const i = t.pts.indexOf(p)
    let e = null
    try { e = i >= 0 ? trajWaypointInfo(t)[i] : null } catch { e = null }
    if (e && Number.isFinite(e.tMs)) return e.tMs
    return Number.isFinite(t.t0Ms) ? t.t0Ms : Date.now()
  }
  // 写一格：经纬度照旧；高度 = 高度钉点（空 → 删钉点回推算，越界不落）；时间 = 时刻钉点（首航点即起始 t0Ms；空 → 删）；推算列不落
  function wpSetCell(t, p, key, val) {
    if (key === 'lon' || key === 'lat') { setCoord(p, key, val); return }
    const blank = val == null || String(val).trim() === ''
    if (key === 'altM') {
      if (blank) { delete p.altM; return }
      const a = num(val)
      if (okWpAlt(a)) p.altM = a
      return
    }
    if (key === 'tMs') {
      if (blank) { if (isFirstWp(t, p)) delete t.t0Ms; delete p.tMs; return }
      const ms = typeof val === 'number' ? val : (typeof parseTime === 'function' ? parseTime(String(val), refTimeOf(t, p)) : NaN)
      if (Number.isFinite(ms)) p.tMs = Math.round(ms)
    }
  }
  function wpAddRow(trajId, at) {
    const t = trajOf(trajId); if (!t) return null
    const i = (at == null || at < 0 || at > t.pts.length) ? t.pts.length : at
    const p = { id: newId(), lat: null, lon: null }; t.pts.splice(i, 0, p)
    return p
  }
  function wpUpdate(trajId, id, patch) {
    const t = trajOf(trajId); if (!t) return
    const p = t.pts.find((x) => x.id === id); if (!p) return
    for (const k of Object.keys(patch)) wpSetCell(t, p, k, patch[k])
    normFirstPin(t)
  }
  function wpRemove(trajId, id) { const t = trajOf(trajId); if (t) { t.pts = t.pts.filter((p) => p.id !== id); normFirstPin(t) } }
  function wpClear(trajId) { const t = trajOf(trajId); if (t) t.pts = [] }
  function wpPasteAppend(trajId, text) {
    const t = trajOf(trajId); if (!t) return 0
    const last = [...t.pts].reverse().find((p) => Number.isFinite(p.tMs))
    const add = parseWpLines(text, newId, { layout: wpColKeys(t.kind), parseTime, refMs: last ? last.tMs : t.t0Ms })
    if (t.kind !== 'flight') for (const p of add) delete p.altM
    if (add.length) { t.pts = [...t.pts, ...add]; normFirstPin(t) }
    return add.length
  }
  // Excel 式定位块粘贴：按【这条航迹的网格列序】从锚点格向右下填（推算列那几格落空），超出的行新建
  function wpPasteBlock(trajId, anchorId, startKey, text) {
    const t = trajOf(trajId); if (!t) return 0
    const grid = parseGrid(text); if (!grid.length) return 0
    const cols = wpColKeys(t.kind)
    const c0 = Math.max(0, cols.indexOf(startKey))
    const list = [...t.pts]
    let idx = anchorId ? list.findIndex((p) => p.id === anchorId) : list.length
    if (idx < 0) idx = list.length
    grid.forEach((cells, ri) => {
      let p = list[idx + ri]
      if (!p) { p = { id: newId(), lat: null, lon: null }; list[idx + ri] = p }
      cells.forEach((val, ci) => { const key = cols[c0 + ci]; if (key) wpSetCell(t, p, key, val) })
    })
    t.pts = list.filter(Boolean)
    normFirstPin(t)
    return grid.length
  }

  return {
    canUndo, canRedo, pushUndo, dropUndo, undo, redo, clearHistory, ensureWaypointIds,
    PT_COLS, ST_COLS, WP_COLS,
    ptLayer, stLayer,
    wpAddRow, wpUpdate, wpRemove, wpClear, wpPasteAppend, wpPasteBlock
  }
}
