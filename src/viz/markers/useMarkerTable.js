// 标记批量表格（Excel 模块）数据模型：点标记 / 地球站 / 航迹航点三套可编辑网格的增删改 + 批量粘贴 + 撤销重做。
// 与「链路预算性能表」同款交互内核（useGridSelect），此处只提供数据侧 CRUD/解析——渲染/命中/键盘交给 useGridSelect。
// 三套数据仍是页面里的 points / stations / trajectories 三个 ref（本模块受注入的引用，改后调 sync 落盘+推图）。
import { ref } from 'vue'
import { sheetToRecords, sheetToTsv } from '../../shared/gridXlsx.js'

// 空串/空白判 null（Number('')===0，否则粘贴块里的空单元格会把经纬度悄悄写成 0）
const num = (v) => { if (v == null || String(v).trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
// 单元格切分：制表符 > 逗号 > 空白（与性能表 parsePasted 同口径）
const splitCells = (t) => (t.includes('\t') ? t.split('\t') : (t.includes(',') ? t.split(',') : t.split(/\s+/))).map((x) => x.trim())
// 定位块粘贴的分行分列：每行用 splitCells（制表符 > 逗号 > 空白）。含制表符的（Excel 复制）恒按制表符切、
// 名称里的逗号/空格不误拆；不含制表符的（手敲/文本里的「经度, 纬度」列表）才退回逗号/空白——否则选中某行后
// Ctrl+V 逗号坐标会被当作单个单元格塞进经度列、解析成 null，表象是「有空白行时批量粘贴失效」。
const parseGrid = (text) => String(text || '').split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => splitCells(l))

// 航点批量解析：每行【末两列 = 经度、纬度】，解析不出坐标的行跳过。
// 剪贴板与「无表头工作表」共用这一条 —— 从 Excel 复制粘贴 和 导入 Excel 的行为必须逐字一致。
function parseWpLines(text, newId) {
  const add = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.trim(); if (!s) continue
    const c = splitCells(s); if (c.length < 2) continue
    const lon = num(c[c.length - 2]), lat = num(c[c.length - 1])
    if (lon == null || lat == null) continue
    add.push({ id: newId(), lat, lon })
  }
  return add
}

// ===== 航迹 ⇄ 工作簿（一张工作表一条航迹，表名即航迹名）=====
// 航迹的工作表列，与网格同序
export const TRAJ_SHEET_COLS = [{ key: 'lon', label: '经度' }, { key: 'lat', label: '纬度' }]
// 航行/飞行是【航迹】属性、不是航点属性，写不进「首行表头 + 纯数据」的数据表 → 导出时记在 note
// （主进程 buildGridWorkbook 会把 note 单开成一张「说明」表：一行 = 表名 + 说明）。
export const TRAJ_NOTE_SHEET = '说明'
// 手搓的工作簿没有说明表 → 退回按表名认（自动名就叫「航行1 / 飞行2」），仍认不出算航行
export const trajKindOf = (s) => (/飞行|flight/i.test(String(s == null ? '' : s)) ? 'flight' : 'sea')

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
 *   有表头（含「经度 / 纬度」）按表头取列，认不出退回位置约定（末两列 = 经纬度）；
 *   经纬度缺一个的行不算航点（残缺航点画不出来，只会在网格里当垃圾行）；
 *   一个航点都读不到的表整张丢掉 —— 工作簿里常混着无关的表，不能每张都造一条空航迹。
 * opts：newId 造航点 id；taken 现有航迹名（去重用）；fallbackName 表名为空时的兜底名。
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
  for (const s of data) {
    const nm = String(s.name || '').trim()
    const { records } = sheetToRecords(s, TRAJ_SHEET_COLS)
    let pts
    if (records) {
      pts = []
      for (const rec of records) { const lon = num(rec.lon), lat = num(rec.lat); if (lon != null && lat != null) pts.push({ id: mkId(), lat, lon }) }
    } else {
      pts = parseWpLines(sheetToTsv(s), mkId)
    }
    if (!pts.length) continue
    out.push({ name: uniqName(nm, used, opts.fallbackName), kind: trajKindOf(notes.has(nm) ? notes.get(nm) : nm), pts })
  }
  return out
}

export function useMarkerTable({ points, stations, trajectories, newId, sync }) {
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
      const textCols = cols.slice(0, cols.length - 2)   // 坐标之外的文本列（点标记为空、地球站为['name']）
      const add = []
      for (const line of String(text || '').split(/\r?\n/)) {
        const t = line.trim(); if (!t) continue
        const c = splitCells(t); if (c.length < 2) continue
        const lon = num(c[c.length - 2]), lat = num(c[c.length - 1])
        if (lon == null || lat == null) continue
        const head = c.slice(0, c.length - 2)
        const row = makeEmpty()
        textCols.forEach((k, i) => { row[k] = head[i] || '' })
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

  // ---- 点标记：列 [经度, 纬度] ----
  const PT_COLS = ['lon', 'lat']
  const ptLayer = makeLayer(
    () => points.value, (a) => { points.value = a }, PT_COLS,
    () => ({ id: newId(), lat: null, lon: null }),
    (r, k, v) => setCoord(r, k, v)   // 点标记全是坐标列
  )

  // ---- 地球站：列 [名称, 经度, 纬度] ----
  const ST_COLS = ['name', 'lon', 'lat']
  const stLayer = makeLayer(
    () => stations.value, (a) => { stations.value = a }, ST_COLS,
    () => ({ id: newId(), name: '', lat: null, lon: null }),
    (r, k, v) => { if (k === 'lon' || k === 'lat') setCoord(r, k, v); else r[k] = String(v == null ? '' : v) }
  )

  // ---- 航迹航点：对某条航迹的 pts 操作（列 [经度, 纬度]）----
  const WP_COLS = ['lon', 'lat']
  const trajOf = (id) => trajectories.value.find((t) => t.id === id)
  function wpAddRow(trajId, at) {
    const t = trajOf(trajId); if (!t) return null
    const i = (at == null || at < 0 || at > t.pts.length) ? t.pts.length : at
    const p = { id: newId(), lat: null, lon: null }; t.pts.splice(i, 0, p)
    return p
  }
  function wpUpdate(trajId, id, patch) {
    const t = trajOf(trajId); if (!t) return
    const p = t.pts.find((x) => x.id === id); if (!p) return
    for (const k of Object.keys(patch)) setCoord(p, k, patch[k])
  }
  function wpRemove(trajId, id) { const t = trajOf(trajId); if (t) t.pts = t.pts.filter((p) => p.id !== id) }
  function wpClear(trajId) { const t = trajOf(trajId); if (t) t.pts = [] }
  function wpPasteAppend(trajId, text) {
    const t = trajOf(trajId); if (!t) return 0
    const add = parseWpLines(text, newId)
    if (add.length) t.pts = [...t.pts, ...add]
    return add.length
  }
  function wpPasteBlock(trajId, anchorId, startKey, text) {
    const t = trajOf(trajId); if (!t) return 0
    const grid = parseGrid(text); if (!grid.length) return 0
    const c0 = Math.max(0, WP_COLS.indexOf(startKey))
    const list = [...t.pts]
    let idx = anchorId ? list.findIndex((p) => p.id === anchorId) : list.length
    if (idx < 0) idx = list.length
    grid.forEach((cells, ri) => {
      let p = list[idx + ri]
      if (!p) { p = { id: newId(), lat: null, lon: null }; list[idx + ri] = p }
      cells.forEach((val, ci) => { const key = WP_COLS[c0 + ci]; if (key) setCoord(p, key, val) })
    })
    t.pts = list.filter(Boolean)
    return grid.length
  }

  return {
    canUndo, canRedo, pushUndo, dropUndo, undo, redo, clearHistory, ensureWaypointIds,
    PT_COLS, ST_COLS, WP_COLS,
    ptLayer, stLayer,
    wpAddRow, wpUpdate, wpRemove, wpClear, wpPasteAppend, wpPasteBlock
  }
}
