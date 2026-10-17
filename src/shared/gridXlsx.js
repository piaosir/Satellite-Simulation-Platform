// 表格 ⇄ Excel 的渲染端一侧：出表模型、回表的表头匹配。
//
// 分工：主进程 electron/services/gridXlsx.js 只管刷格子/读格子，「哪一列是经度」这类口径全在这里。
// 与剪贴板那条路（parsePasted / pasteBlock）并存且同口径 —— 表头认不出来时，本模块把工作表转成
// 制表符文本原样交回既有的粘贴解析，行为与「从 Excel 复制粘贴」逐字一致，不另立一套解析。
//
// 表头约定：导出的首行 = 界面上的列标签（带单位，如「经度 (°E)」）。导回来按标签匹配列，
// 故用户在 Excel 里【调换列序、删掉不用的列】都认得；标签被改写到认不出时退回位置约定。
// 一张表里同名的列（链路表发、收两侧的「经度」）表头前加列组名作侧别：「发信站·经度 (°E)」「收信站·经度 (°E)」。

// 列组前缀与标签之间的分隔符（「收信站·经度 (°E)」）
export const GROUP_SEP = '·'

// 列标签（与界面表头同款：标签 + 括号单位）。unitOf 供动态单位列（Parameter 随口径变）覆盖。
// groupLabel：同名列的侧别前缀——链路表发、收两侧都有「经度」「地球站配置」，单看标签导回来分不清是哪一侧，
// 故同名的那几列借列组名写成「收信站·经度 (°E)」。只有调用方判定为同名的列才给（见 sameNameKeys），
// 不重名的列表头与从前逐字一致。
export function colLabel(c, unitOf) {
  const u = unitOf ? unitOf(c) : c.unit
  const g = c.groupLabel ? String(c.groupLabel) + GROUP_SEP : ''
  return g + String(c.label == null ? c.key : c.label) + (u ? ' (' + u + ')' : '')
}

// 归一：去全部空白、全角括号转半角、去括号里的单位、小写，各式间隔点统一成「·」。
// 「经度 (°E)」「经度（°E）」「经度」→ 同一个键；「收信站・经度」（Excel 里换了日文间隔点）→「收信站·经度」
const normKey = (s) => String(s == null ? '' : s)
  .replace(/[（）]/g, (ch) => (ch === '（' ? '(' : ')'))
  .replace(/\([^)]*\)\s*$/, '')
  .replace(/[*＊]/g, '')
  .replace(/[・•‧∙⋅･]/g, GROUP_SEP)
  .replace(/\s+/g, '')
  .toLowerCase()

const isBlank = (v) => v == null || String(v).trim() === ''

// 同名列：标签归一后（normKey）撞名的那些列的 key 集合。调用方只给这些列挂 groupLabel（见 colLabel）。
// ★ 按表的全部列算，不按「这次导出的可见列」算：藏掉发信站「经度」只导收信站那一列时，它的表头也得带侧别——
//   不带的话导回来按出现次序会对到发信站那一侧。
export function sameNameKeys(cols) {
  const list = (cols || []).filter(Boolean)
  const nameOf = (c) => normKey(c.label == null ? c.key : c.label)
  const cnt = new Map()
  for (const c of list) { const n = nameOf(c); cnt.set(n, (cnt.get(n) || 0) + 1) }
  return new Set(list.filter((c) => cnt.get(nameOf(c)) > 1).map((c) => c.key))
}

/**
 * 出表模型的一张工作表。
 *   cols   [{ key, label, unit, num, fix, align, groupLabel? }]（groupLabel 见 colLabel：同名列的侧别前缀）
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

// ---- 英文表头 ----
// 英文界面下导出的首行 = 该列表头在 uiDict EXACT 中的译文（整串查不到再按「标签 (单位)」拆开查）；
// 导回时中英两套表头都认（findHeader 把每列标签的英文也挂上）。直接查 EXACT 而不走 runtime 的 t()：
// 导出与导回用同一张表才对得上，且导回时不管当前是什么语言都要认得英文表头。
// 词典是动态 import（~1 MB）：中文档导出不加载；导入时加载一次（中文档也要认英文文件）。
let EN_OF = null
async function loadHeaderDict() {
  if (EN_OF) return EN_OF
  try { EN_OF = (await import('./i18n/uiDict.data.js')).EXACT || null } catch { EN_OF = null }
  return EN_OF
}
// 测试 / 调用方可直接注入一张 { 中文: 英文 } 表
export function setHeaderDict(exact) { EN_OF = exact || null }
const hasEn = (k) => Object.prototype.hasOwnProperty.call(EN_OF, k)
const HAN = /[一-鿿]/
// 标签 → 英文：整串查；查不到且带侧别前缀（「收信站·经度」，见 colLabel）时两段各查一次、用「 · 」拼回——
// 前缀段必须查得到（查不到说明这个「·」不是我们加的前缀，宁可整串认不出）；标签段不含汉字（R0.01%）时原样。
function labelEn(lab) {
  if (hasEn(lab)) return EN_OF[lab]
  const i = lab.indexOf(GROUP_SEP)
  if (i <= 0) return null
  const g = lab.slice(0, i).trim()
  const rest = lab.slice(i + GROUP_SEP.length).trim()
  if (!rest || !hasEn(g)) return null
  const restEn = hasEn(rest) ? EN_OF[rest] : (HAN.test(rest) ? null : rest)
  return restEn == null ? null : EN_OF[g] + ' · ' + restEn
}
// 表头 → 英文；查不到返回 null
export function headerEn(h) {
  if (!EN_OF || h == null) return null
  const k = String(h).replace(/\s+/g, ' ').trim()
  if (!k) return null
  if (hasEn(k)) return EN_OF[k]
  const m = /^(.*?)\s*[(（]([^()（）]*)[)）]$/.exec(k)
  const lab = labelEn(m ? m[1].trim() : k)
  if (lab == null) return null
  if (!m) return lab
  const unit = hasEn(m[2]) ? EN_OF[m[2]] : m[2]
  return lab + ' (' + unit + ')'
}
const uiLangEn = () => { try { return localStorage.getItem('ui-lang') === 'en' } catch { return false } }
// 对话框标题：英文档按 EXACT 翻（主进程那边再按对话框对照表兜一次），查不到原样
const titleOf = (t) => (t && EN_OF && Object.prototype.hasOwnProperty.call(EN_OF, String(t).trim()) ? EN_OF[String(t).trim()] : t)

// 一次导出（走主进程保存框）。sheets = sheetModel() 的结果数组。返回 IPC 结果。
// style：'plain'（缺省，灰底表头+竖线+筛选器，供随手改数）| 'report'（三线表，与链路预算报告同款版式）
export async function exportSheets({ defaultName, title, sheets, style }) {
  const api = typeof window !== 'undefined' && window.api && window.api.gridXlsx
  if (!api) return { ok: false, error: '当前环境不支持导出 Excel' }
  let list = (sheets || []).filter(Boolean)
  const en = uiLangEn()
  if (en && await loadHeaderDict()) {
    list = list.map((sh) => (Array.isArray(sh.header)
      ? Object.assign({}, sh, { header: sh.header.map((h) => headerEn(h) || h) })
      : sh))
    title = titleOf(title)
  }
  return api.export({ defaultName, title, style, sheets: list, lang: en ? 'en' : 'zh' })
}

// 一次导入（走主进程打开框）。返回 { ok, canceled?, error?, filePath, sheets:[{name, rows}] }
export async function importWorkbook(opt) {
  const api = typeof window !== 'undefined' && window.api && window.api.gridXlsx
  if (!api) return { ok: false, error: '当前环境不支持导入 Excel' }
  await loadHeaderDict()     // 导回时认英文表头要用（findHeader 是同步的，先把表备好）
  const o = Object.assign({}, opt || {})
  const en = uiLangEn()
  if (en && o.title) o.title = titleOf(o.title)
  o.lang = en ? 'en' : 'zh'
  return api.import(o)
}

/**
 * 在工作表前几行里找表头行，并把每一列对到 cols 的 key 上。
 * 返回 { row: 表头所在行下标, keys: [key|null …] }；找不到返回 null。
 * 判据：该行至少有 2 格（只有 1 列的表则 1 格）能对上列标签 —— 宁可判成「没有表头」退回位置约定，
 * 也不能把一行真数据错认成表头（那会静默吞掉一行）。
 *
 * 同名列（链路表发、收两侧都叫「经度」）：一个名字下挂着几个 key（按 cols 的列序）。带侧别的表头
 * （「收信站·经度」，cols 给了 groupLabel 时认得）只对得上它自己那一列；不带侧别的老文件按出现次序
 * 依次对到各同名列——第一个「经度」归发信站、第二个归收信站，与导出时的列序一致。
 */
export function findHeader(rows, cols) {
  const list = (cols || []).filter(Boolean)
  const byName = new Map()       // 归一名 → [key …]
  const put = (name, key) => {
    const n = normKey(name)
    if (!n) return
    const l = byName.get(n)
    if (!l) byName.set(n, [key])
    else if (!l.includes(key)) l.push(key)
  }
  for (const c of list) {
    const base = c.groupLabel ? Object.assign({}, c, { groupLabel: '' }) : c
    const names = [c.key, c.label, colLabel(base), ...(c.alias || []),
      c.label != null ? headerEn(c.label) : null, headerEn(colLabel(base))]
    if (c.groupLabel) {
      // 侧别写法：中文「收信站·经度」与英文「Rx station · Longitude」各挂一份；别名同样可带侧别
      const side = colLabel(c)
      names.push(side, headerEn(side))
      for (const a of (c.alias || [])) names.push(colLabel({ label: a, groupLabel: c.groupLabel }))
    }
    for (const nm of names) put(nm, c.key)
  }
  const need = Math.min(2, list.length)
  const scan = Math.min(3, rows.length)
  for (let i = 0; i < scan; i++) {
    const cells = rows[i] || []
    const cand = cells.map((v) => byName.get(normKey(v)) || null)
    const hit = cand.filter(Boolean).length
    if (hit >= need) return { row: i, keys: assignKeys(cand) }
  }
  return null
}

// 表头各格的候选 key → 每格落定一个 key（落不下的置空）。
//   ① 先落只有一个候选的格（带侧别的表头 / 本就不重名的列）；同一个 key 两格都要时只认第一格，
//      后面的置空 —— 否则后写的会盖掉前面的值；
//   ② 再按出现次序，把同名格依次对到还空着的同名 key 上（老文件的「经度」「经度」）。
// 两遍走：表头里侧别写法与老写法混排、或列序被调过时，①先把认得准的占住，②才不会抢错。
function assignKeys(cand) {
  const used = new Set()
  const keys = cand.map((l) => (l && l.length === 1 && !used.has(l[0]) ? (used.add(l[0]), l[0]) : null))
  cand.forEach((l, i) => {
    if (!l || l.length < 2) return
    const k = l.find((x) => !used.has(x))
    if (k) { used.add(k); keys[i] = k }
  })
  return keys
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
