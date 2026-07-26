// 报表 .xlsx 的列宽 / 行高自适应（写盘前整本过一遍）。
//
// 为什么需要：exceljs 出的表，列宽与行高都是写死的常数——中英文标签、站名、ITU 建议书名长短差得远，
// 一套常数不可能同时合身。列窄了旁边有内容就被截断（Excel 只在邻格为空时才让文字溢出显示），
// 行高定死了 wrapText 也不会自己长高（合并单元格更是从来不自动行高），于是「第一眼信息不全」。
//
// 口径：**只增不减**。既有版式是设计过的（'#' 列窄、标题行高、三线表的疏密），本模块只在装不下时
// 把那一列 / 那一行放大到刚好装得下，不动装得下的地方——即出表版式与原来逐格一致，只是不再截断。
//
// 度量：Excel 的列宽单位 = 默认字体下字符 '0' 的宽度（约 7px）；行高单位 = 磅。故先把文本按
// 「每字符占多少 em × 字号」折算成像素再折成列宽单位。本报告全篇 Times New Roman + 中文回落宋体
// （见 report.js 的 FNT/CJK），em 表照此标定：数字 0.5、大写 0.7、小写 0.48、汉字/全角 1.0。
//
// 换行行数按「西文整词、汉字逐字」的贪心排版数，与 Excel 的断行口径接近；宁可估宽一点点
// （行略高、列略宽）也不能估窄——估窄就又截断了。

const PT2PX = 96 / 72
const PX_PER_UNIT = 7          // 一个列宽单位的像素数（Calibri 11 的 '0'）
const DEFAULT_COL_WIDTH = 8.43 // Excel 默认列宽（未显式设过宽度的列按此估）
const DEFAULT_FONT_SIZE = 11
const DEFAULT_ROW_HEIGHT = 15  // Excel 默认行高（磅）

// 全角判定（汉字 / 假名 / 谚文 / 全角标点，含全角空格 U+3000）
const WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x20000, 0x3fffd]
]
function isWide(c) {
  for (const [lo, hi] of WIDE_RANGES) if (c >= lo && c <= hi) return true
  return false
}
const NARROW = [0x2e, 0x2c, 0x3a, 0x3b, 0x27, 0x60, 0x21, 0x7c, 0xb7, 0x2018, 0x2019]  // . , : ; ' ` ! | ·
const MEDIUM = [0x28, 0x29, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x5c, 0x2d, 0x2013]          // ( ) [ ] { } / \ - –
// 单字符宽度（em，相对字号）
function charEm(c) {
  if (isWide(c)) return 1.0
  if (c >= 0x30 && c <= 0x39) return 0.5                       // 数字（TNR 等宽数字）
  if (c >= 0x41 && c <= 0x5a) return 0.70                      // 大写
  if (c >= 0x61 && c <= 0x7a) return 0.48                      // 小写
  if (c === 0x20) return 0.25                                  // 空格
  if (c === 0x2014 || c === 0x2015 || c === 0x2026) return 1.0 // 破折号 / 省略号（回落字体按全角出）
  if (c >= 0x2190 && c <= 0x21ff) return 1.0                   // 箭头 →↑↓（同上）
  if (NARROW.indexOf(c) > -1) return 0.25
  if (MEDIUM.indexOf(c) > -1) return 0.34
  return 0.55                                                  // 其余符号（°±×≈§ 等）取中
}

// 文本宽度（列宽单位）
function textUnits(text, sizePt) {
  const s = String(text)
  let em = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.codePointAt(i)
    if (c > 0xffff) i++
    em += charEm(c)
  }
  return em * sizePt * PT2PX / PX_PER_UNIT
}
// 最长一行的宽度（显式 \n 分行）
function maxLineUnits(text, sizePt) {
  let w = 0
  for (const line of String(text).split('\n')) w = Math.max(w, textUnits(line, sizePt))
  return w
}

// 逐个「不可分块」遍历：一段空白 / 一个全角字符（可逐字断）/ 一段连续西文（不断词）
function eachChunk(s, cb) {
  let i = 0
  while (i < s.length) {
    let j = i, kind
    const c0 = s.codePointAt(i)
    if (/\s/.test(s[i])) { kind = 'sp'; while (j < s.length && /\s/.test(s[j])) j++ }
    else if (isWide(c0)) { kind = 'w'; j = i + (c0 > 0xffff ? 2 : 1) }
    else { kind = 'n'; while (j < s.length && !/\s/.test(s[j]) && !isWide(s.codePointAt(j))) j++ }
    cb(s.slice(i, j), kind)
    i = j
  }
}
// 最长的不可断块（西文里最长的一个词）：换行格至少要有这么宽，否则 Excel 会把词从中间劈开
function maxChunkUnits(text, sizePt) {
  let w = 0
  eachChunk(String(text), (chunk, kind) => {
    if (kind === 'sp') return
    w = Math.max(w, textUnits(chunk, sizePt))
  })
  return w
}

// 断行：汉字/全角字符可逐字断，西文整词不断，行末空白吃掉——与 Excel 的断行口径接近。
function wrapSegment(seg, sizePt, cap) {
  let lines = 1, cur = 0
  eachChunk(String(seg), (chunk, kind) => {
    const w = textUnits(chunk, sizePt)
    if (cur + w <= cap) { cur += w; return }
    if (kind === 'sp') { cur = cap; return }       // 行末空白不另起一行
    if (cur > 0) { lines++; cur = 0 }
    if (w > cap) {                                 // 单词比一整行还长：Excel 硬断
      const n = Math.ceil(w / cap)
      lines += n - 1
      cur = w - (n - 1) * cap
    } else cur = w
  })
  return lines
}
// 在给定可用宽度下的行数
function wrapCount(text, sizePt, capUnits) {
  const cap = Math.max(2, capUnits)
  let lines = 0
  for (const seg of String(text).split('\n')) lines += wrapSegment(seg, sizePt, cap)
  return Math.max(1, lines)
}
// 单行文字所需行高（磅）：字号 × 行距 + 上下留白
const lineHeight = (sizePt) => sizePt * 1.34 + 1.2

// 单元格的显示文本：数字按 numFmt 的小数位折算（写死的 '0.000' 一类），公式取缓存结果，
// 富文本 / 超链接取其文字。取不到就退回 String()。
function fmtNumber(n, numFmt) {
  const m = /^0(?:\.(0+))?$/.exec(String(numFmt || ''))
  if (m) return n.toFixed(m[1] ? m[1].length : 0)
  return String(n)
}
function cellText(cell) {
  const v = cell.value
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number') return fmtNumber(v, cell.numFmt)
  if (typeof v === 'boolean') return String(v)
  if (v instanceof Date) return v.toLocaleString()
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => (t && t.text) || '').join('')
    if (v.formula !== undefined || v.sharedFormula !== undefined) {
      const r = v.result
      return (r === undefined || r === null || typeof r === 'object') ? '' : String(r)
    }
    if (v.text !== undefined) return String(v.text)
    if (v.hyperlink !== undefined) return String(v.hyperlink)
    if (v.error !== undefined) return String(v.error)
  }
  return String(v)
}

// 合并区：exceljs 把它挂在 ws._merges（键为左上格地址）。内部结构变了就当没有合并区——
// 结果只是合并格不参与调整，不会出错。
function mergeMap(ws) {
  const m = new Map()
  try {
    const src = ws._merges || {}
    for (const key of Object.keys(src)) {
      const g = src[key]
      if (!g || typeof g.top !== 'number' || typeof g.left !== 'number') continue
      m.set(g.tl || key, { top: g.top, left: g.left, bottom: g.bottom, right: g.right })
    }
  } catch (e) { /* 结构变了：按无合并区处理 */ }
  return m
}

const nz = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d)

// 一张 sheet 的行高列宽自适应。opt:
//   minWidth/maxWidth  列宽夹逼（单位=列宽单位）
//   maxHeight          行高上限（磅）
//   spreadSpan         单行合并格「补缺口」的最大跨列数（跨得更宽的是整表标题，不参与）
function autofitSheet(ws, opt) {
  opt = opt || {}
  const minW = nz(opt.minWidth, 3)
  const maxW = nz(opt.maxWidth, 58)
  const maxH = nz(opt.maxHeight, 320)
  const padW = nz(opt.padWidth, 0.9)         // 单元格左右内边距 + 余量
  const padH = nz(opt.padHeight, 3)
  const spreadSpan = nz(opt.spreadSpan, 4)
  const maxWrapLines = nz(opt.maxWrapLines, 3)   // 换行格允许拆成几行（超了就把列放宽）
  const maxWrapW = nz(opt.maxWrapWidth, 22)      // 但为换行格放宽也就放到这么宽
  // 死区：差这么一点点就不动了。估算本就带余量，不设死区的话满篇都是 32→32.25、18→18.3
  // 一类看不出来的改动，反倒把「哪儿真的不够」淹了。
  const tolW = nz(opt.tolWidth, 0.35)
  const tolH = nz(opt.tolHeight, 1.5)
  const merges = mergeMap(ws)

  // —— 采集：每个有字的格（合并区的从格跳过，它的值只是主格的镜像）——
  const items = []
  const byRow = new Map()
  ws.eachRow({ includeEmpty: false }, (row) => {
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (cell.isMerged && cell.master && cell.master.address !== cell.address) return
      const text = cellText(cell)
      if (!text) return
      const size = nz(cell.font && cell.font.size, DEFAULT_FONT_SIZE)
      const span = merges.get(cell.address)
      const it = {
        cell,
        row: row.number,
        c1: cell.col,
        c2: span ? span.right : cell.col,
        rowSpan: span ? (span.bottom - span.top + 1) : 1,
        size,
        wrap: !!(cell.alignment && cell.alignment.wrapText),
        text,
        w: maxLineUnits(text, size) + padW
      }
      items.push(it)
      const arr = byRow.get(it.row)
      if (arr) arr.push(it); else byRow.set(it.row, [it])
    })
  })

  const widthOf = (c) => {
    const w = ws.getColumn(c).width
    return (typeof w === 'number' && w > 0) ? w : DEFAULT_COL_WIDTH
  }
  const setWidth = (c, w) => {
    ws.getColumn(c).width = Math.round(Math.min(maxW, Math.max(minW, w)) * 100) / 100
  }

  // —— 列宽：取该列「不换行的独立格」中最宽的一个 ——
  // 带 wrapText 的格（表头、说明段）原则上不参与：它们本就该靠换行解决，让它们撑宽列会把表撑散。
  const need = new Map()
  const claim = (c, w) => { if (w > (need.get(c) || 0)) need.set(c, w) }
  for (const it of items) {
    if (it.wrap || it.c1 !== it.c2) continue
    claim(it.c1, it.w)
  }
  // 换行格的下限：一格拆成七八行同样没法读（也会把整行撑得老高），故要求它至少能在
  // maxWrapLines 行内放下、且西文的词不被从中间劈开；上限 maxWrapWidth，免得长句子把列撑开。
  for (const it of items) {
    if (!it.wrap || it.c1 !== it.c2) continue
    claim(it.c1, Math.min(maxWrapW, Math.max(maxChunkUnits(it.text, it.size) + padW, it.w / maxWrapLines)))
  }
  for (const [c, w] of need) if (w > widthOf(c) + tolW) setWidth(c, w)

  // —— 单行合并且不换行的格（键值行的值一类）：整段宽度仍不够，就把缺口补给区间最后一列 ——
  for (const it of items) {
    if (it.wrap || it.c1 === it.c2 || it.rowSpan > 1) continue
    if (it.c2 - it.c1 + 1 > spreadSpan) continue
    let have = 0
    for (let c = it.c1; c <= it.c2; c++) have += widthOf(c)
    if (it.w > have + tolW) setWidth(it.c2, widthOf(it.c2) + (it.w - have))
  }

  // —— 兜底：撞上列宽上限还是装不下的格（超长站名一类），就地打开自动换行 ——
  // 截断是丢信息，换行只是行变高：宁可行高一点也不能让读者看不见后半截。
  for (const it of items) {
    if (it.wrap || it.rowSpan > 1) continue
    let have = 0
    for (let c = it.c1; c <= it.c2; c++) have += widthOf(c)
    if (it.w <= have + tolW) continue
    const al = it.cell.alignment || {}
    it.cell.alignment = Object.assign({}, al, { wrapText: true })
    it.wrap = true
  }

  // —— 行高：按最终列宽反推换行行数，取该行最高的一格 ——
  for (const [rn, arr] of byRow) {
    let hNeed = 0, multiline = false
    for (const it of arr) {
      if (it.rowSpan > 1) continue                 // 跨行合并（本报告没有）：不猜
      let avail = 0
      for (let c = it.c1; c <= it.c2; c++) avail += widthOf(c)
      const lines = it.wrap ? wrapCount(it.text, it.size, avail - padW) : 1
      if (lines > 1) multiline = true
      const h = lines * lineHeight(it.size) + padH
      if (h > hNeed) hNeed = h
    }
    const row = ws.getRow(rn)
    const cur = nz(row.height, 0)
    // 没设过行高的行由 Excel 自己按内容长高，只在「合并/换行确实要多行」时才写死一个够用的高度
    if (cur === 0 && !multiline && hNeed <= DEFAULT_ROW_HEIGHT) continue
    if (hNeed > cur + tolH) row.height = Math.min(maxH, Math.round(hNeed * 10) / 10)
  }
  return ws
}

// 整本过一遍
function autofitBook(wb, opt) {
  wb.eachSheet((ws) => autofitSheet(ws, opt))
  return wb
}

module.exports = { autofitSheet, autofitBook, textUnits, maxLineUnits, wrapCount, cellText }
