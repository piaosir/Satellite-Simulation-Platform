// 表格 ⇄ Excel 的渲染端一侧：出表模型、回表的表头匹配。
//
// 分工：主进程 electron/services/gridXlsx.js 只管刷格子/读格子，「哪一列是经度」这类口径全在这里。
// 与剪贴板那条路（parsePasted / pasteBlock）并存且同口径 —— 表头认不出来时，本模块把工作表转成
// 制表符文本原样交回既有的粘贴解析，行为与「从 Excel 复制粘贴」逐字一致，不另立一套解析。
//
// 表头约定：导出的首行 = 界面上的列标签（带单位，如「经度 (°E)」）。导回来按标签匹配列，
// 故用户在 Excel 里【调换列序、删掉不用的列】都认得；标签被改写到认不出时退回位置约定。

// 列标签（与界面表头同款：标签 + 括号单位）。unitOf 供动态单位列（Parameter 随口径变）覆盖。
export function colLabel(c, unitOf) {
  const u = unitOf ? unitOf(c) : c.unit
  return String(c.label == null ? c.key : c.label) + (u ? ' (' + u + ')' : '')
}

// 归一：去全部空白、全角括号转半角、去括号里的单位、小写。「经度 (°E)」「经度（°E）」「经度」→ 同一个键
const normKey = (s) => String(s == null ? '' : s)
  .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
  .replace(/\([^)]*\)\s*$/, '')
  .replace(/[*＊]/g, '')
  .replace(/\s+/g, '')
  .toLowerCase()

const isBlank = (v) => v == null || String(v).trim() === ''

/**
 * 出表模型的一张工作表。
 *   cols   [{ key, label, unit, num, fix, align }]
 *   rows   数据行
 *   value  (row, col) => 值：数字列返回 number 才能在 Excel 里参与计算，返回字符串亦可
 *   unitOf (col) => 单位（动态单位列用；缺省取 col.unit）
 * ★ col.w 是【屏上网格】的像素列宽，不往出表模型里带 —— Excel 的列宽单位是字符数，
 *   190 这样的像素值会撑出一列半屏宽。Excel 那边的列宽交给主进程的自适应算。
 */
export function sheetModel({ name, cols, rows, value, unitOf, note }) {
  const list = (cols || []).filter(Boolean)
  const val = value || ((r, c) => r[c.key])
  return {
    name: name || 'Sheet1',
    note: note || '',
    header: list.map((c) => colLabel(c, unitOf)),
    cols: list.map((c) => ({ num: !!c.num, fix: c.fix, align: c.align })),
    rows: (rows || []).map((r) => list.map((c) => {
      const v = val(r, c)
      if (v == null || v === '') return null
      if (typeof v === 'number') return Number.isFinite(v) ? v : null
      if (c.num) { const n = Number(String(v).replace(/[, ]/g, '')); if (Number.isFinite(n)) return n }
      return String(v)
    }))
  }
}

// 一次导出（走主进程保存框）。sheets = sheetModel() 的结果数组。返回 IPC 结果。
// style：'plain'（缺省，灰底表头+竖线+筛选器，供随手改数）| 'report'（三线表，与链路预算报告同款版式）
export async function exportSheets({ defaultName, title, sheets, style }) {
  const api = typeof window !== 'undefined' && window.api && window.api.gridXlsx
  if (!api) return { ok: false, error: '当前环境不支持导出 Excel' }
  return api.export({ defaultName, title, style, sheets: (sheets || []).filter(Boolean) })
}

// 一次导入（走主进程打开框）。返回 { ok, canceled?, error?, filePath, sheets:[{name, rows}] }
export async function importWorkbook(opt) {
  const api = typeof window !== 'undefined' && window.api && window.api.gridXlsx
  if (!api) return { ok: false, error: '当前环境不支持导入 Excel' }
  return api.import(opt || {})
}

/**
 * 在工作表前几行里找表头行，并把每一列对到 cols 的 key 上。
 * 返回 { row: 表头所在行下标, keys: [key|null …] }；找不到返回 null。
 * 判据：该行至少有 2 格（只有 1 列的表则 1 格）能对上列标签 —— 宁可判成「没有表头」退回位置约定，
 * 也不能把一行真数据错认成表头（那会静默吞掉一行）。
 */
export function findHeader(rows, cols) {
  const list = (cols || []).filter(Boolean)
  const byName = new Map()
  for (const c of list) {
    for (const k of [c.key, c.label, colLabel(c), ...(c.alias || [])]) {
      const n = normKey(k)
      if (n && !byName.has(n)) byName.set(n, c.key)
    }
  }
  const need = Math.min(2, list.length)
  const scan = Math.min(3, rows.length)
  for (let i = 0; i < scan; i++) {
    const cells = rows[i] || []
    const keys = cells.map((v) => byName.get(normKey(v)) || null)
    const hit = keys.filter(Boolean).length
    if (hit >= need) {
      // 同一个 key 命中两列（表头里有重名）时只认第一列，后面的置空 —— 否则后写的会盖掉前面的值
      const seen = new Set()
      return { row: i, keys: keys.map((k) => (k && !seen.has(k) ? (seen.add(k), k) : null)) }
    }
  }
  return null
}

// 一份工作簿里挑该导入哪张表：按表头能对上几列打分（自家导出的工作簿常有好几张表），
// 一张都对不上就退回第一张有数据的表（交给位置约定）。
// 命中数打平时再比【命中占该表列数的比例】：导目标星时，「性能结果」表也含目标卫星/NORAD/分组三列，
// 光比命中数会跟只有这几列的「目标星」表打平并按先后取错表；比例把「整张表就是这个」挑出来。
export function pickSheet(sheets, cols) {
  const list = (sheets || []).filter((s) => s && s.rows && s.rows.length)
  if (!list.length) return null
  let best = null, bestHit = 0, bestRatio = 0
  for (const s of list) {
    const h = findHeader(s.rows, cols)
    const hit = h ? h.keys.filter(Boolean).length : 0
    if (!hit) continue
    const width = (h && (s.rows[h.row] || []).length) || hit
    const ratio = hit / Math.max(1, width)
    if (hit > bestHit || (hit === bestHit && ratio > bestRatio)) { bestHit = hit; bestRatio = ratio; best = s }
  }
  return best || list[0]
}

/**
 * 工作表 → 记录数组。
 *   有表头：按表头匹配的列 key 取值（列序随便调、多余列忽略、缺的列留空）
 *   无表头：返回 null，由调用方退回剪贴板那条位置约定（sheetToTsv + 既有 pasteAppend）
 * 值一律转成字符串交给既有的 setter（数字/全角归一等口径保持单一来源）。
 */
export function sheetToRecords(sheet, cols) {
  const rows = (sheet && sheet.rows) || []
  if (!rows.length) return { records: [], header: null }
  const head = findHeader(rows, cols)
  if (!head) return { records: null, header: null }
  const out = []
  for (let i = head.row + 1; i < rows.length; i++) {
    const cells = rows[i] || []
    const rec = {}
    let any = false
    head.keys.forEach((k, ci) => {
      if (!k) return
      const v = cells[ci]
      if (isBlank(v)) { rec[k] = ''; return }
      rec[k] = String(v)
      any = true
    })
    if (any) out.push(rec)
  }
  return { records: out, header: head }
}

// 工作表 → 制表符文本（无表头时的兜底：原样喂给既有的剪贴板解析，行为与「从 Excel 复制粘贴」一致）
export function sheetToTsv(sheet, opts) {
  const rows = (sheet && sheet.rows) || []
  const skip = (opts && opts.skipRows) || 0
  return rows.slice(skip).map((cells) => (cells || []).map((v) => (v == null ? '' : String(v))).join('\t')).join('\n')
}

// 文件名里的非法字符（Windows）→ 下划线；空名给兜底
export function safeFileName(s, fallback) {
  const t = String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  return t || (fallback || '表格')
}

/**
 * 工作表名的合法化 —— electron/services/gridXlsx.js 里 safeSheetName 的【渲染端镜像】，
 * 两份必须逐字一致（Excel 的硬约束：不许 : \ / ? * [ ]，且最长 31 字符；重名加 (2)(3)… ）。
 *
 * ★ 为什么渲染端也要有一份：以「表名＝标准名」做往返的表（MODCOD 表就是），导出时名字若被主进程
 *   改写过（超长截断 / 非法字符换成 ·），再把同一个文件导回来就按名字对不上号了 —— 表现是
 *   「导出→原样导入」凭空多出一个同名的自定义标准，而不是覆盖原来那个。调用方拿这一支【预演】
 *   一遍导出名，即可用同一把尺子做匹配。
 * used：Set，跨多张表累积已占用的名字（不传即不做重名消歧）。
 */
export function safeSheetName(name, used) {
  let s = String(name == null ? '' : name).replace(/[:\\/?*[\]]/g, '·').trim() || 'Sheet'
  if (s.length > 31) s = s.slice(0, 31)
  if (!used) return s
  let out = s, k = 2
  while (used.has(out)) { const tail = '(' + k++ + ')'; out = s.slice(0, 31 - tail.length) + tail }
  used.add(out)
  return out
}
