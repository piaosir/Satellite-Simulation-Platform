// 《空间态势报告》Word 的【SSA 专有样式层】（docs/空间态势报告样式规范_2026-10-15.md）。
//
// 共用件 reportDocxKit.js / reportStyle.js 一字不改（链路预算 / SLA 报告逐字节不变，§J.1）：
// SSA 偏离模板的取值全部收在这里 —— 正文 10.5 pt、表文 9 pt（密排 8 pt）、三线表 1.0 / 0.5 pt、
// 章首另起页、页眉印报告名、按内容量列宽、分组表头、合计行线、表下来源行、关键指标页。
// 每条取值的出处见规范对应小节（§C.1 字号、§E 表格、§B 版面、§G 关键指标）。
//
// ★ formatColumns / sourceLine / chapterNo 是 src/shared/ssaFormat.js 的【手写 CJS 副本】（主进程不吃渲染端 ESM，
//   仓库惯例同 adaptUnits / carrierRate），packages/core/test/ssaDocx.test.mjs 对拍两份。改一处必须改两处。
const {
  Paragraph, TextRun, Table, TableRow, TableCell, Header, ImageRun, Tab,
  AlignmentType, WidthType, BorderStyle, VerticalAlign, LineRuleType, TabStopType
} = require('docx')
const { TPL, half } = require('./reportStyle')
const { runFonts, pngSizeOf } = require('./reportDocxKit')

// —— 版心 ——
const CONTENT_TW = TPL.page.contentTw                                    // 纵向 160 mm
const CONTENT_LAND_TW = TPL.page.heightTw - TPL.page.marginTw.left - TPL.page.marginTw.right   // 横向 247 mm
const TW_PER_MM = 1440 / 25.4
const PX_PER_MM = 96 / 25.4

// —— 字号阶梯（§C.1）——
const SZ = { frontTitle: 16, h1: 14, h2: 12, body: 10.5, caption: 10.5, td: 9, tdDense: 8, note: 9, header: 9, kpiVal: 20, kpi: 9, ref: 10.5, toc: 10.5 }
// —— 三线表线宽（§E.1，单位 1/8 pt）：顶 / 底 1.0 pt、栏目 / 合计上 / 分组短线 0.5 pt ——
const RULE = { strong: 8, thin: 4 }
const INK = '222222', INK2 = '595959'

const B = (sz, color) => ({ style: BorderStyle.SINGLE, size: sz, color: color || INK })
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' }

// —— 段落样式（id 前缀 Ssa，与模板 / 链路预算的 Rpt* 不撞名）——
function ssaParagraphStyles(doc) {
  const { FN, FN_H } = runFonts(doc)
  const exact = (pt) => ({ line: Math.round(pt * 20), lineRule: LineRuleType.EXACT })
  const auto = (mul) => ({ line: Math.round(240 * mul), lineRule: LineRuleType.AUTO })
  const S = (id, name, run, paragraph, extra) => Object.assign({ id, name, basedOn: 'Normal', run, paragraph }, extra || {})
  return [
    // 前置页标题（关键指标 / 目次）：三号黑体居中（GB/T 7713.3 表 E.1）
    S('SsaFront', 'SSA Front Title', { size: half(SZ.frontTitle), font: FN_H }, { alignment: AlignmentType.CENTER, spacing: Object.assign({ before: 0, after: 240 }, exact(25)), indent: { firstLine: 0 } }, { next: 'SsaBody' }),
    // 章：黑体 14 pt、固定 25 pt、段后 12 pt、另起页（§B.6）；大纲级 1，目录与导航窗格认它
    S('SsaH1', 'SSA Heading 1', { size: half(SZ.h1), font: FN_H }, { spacing: Object.assign({ before: 0, after: 240 }, exact(25)), keepNext: true, pageBreakBefore: true, outlineLevel: 0, indent: { firstLine: 0 } }, { next: 'SsaBody', quickFormat: true }),
    S('SsaH2', 'SSA Heading 2', { size: half(SZ.h2), font: FN_H }, { spacing: Object.assign({ before: 240, after: 120 }, exact(22)), keepNext: true, outlineLevel: 1, indent: { firstLine: 0 } }, { next: 'SsaBody', quickFormat: true }),
    S('SsaBody', 'SSA Body', { size: half(SZ.body), font: FN }, { spacing: auto(1.5), indent: { firstLine: 420 }, alignment: AlignmentType.BOTH }, { next: 'SsaBody' }),
    // 题注：黑体 10.5 pt 居中；表题在表上（段后 4 pt、keepNext 与表首行同页）、图题在图下
    S('SsaCapT', 'SSA Table Caption', { size: half(SZ.caption), font: FN_H }, { alignment: AlignmentType.CENTER, spacing: Object.assign({ before: 240, after: 80 }, auto(1)), keepNext: true, indent: { firstLine: 0 } }, { next: 'SsaBody' }),
    S('SsaCapF', 'SSA Figure Caption', { size: half(SZ.caption), font: FN_H }, { alignment: AlignmentType.CENTER, spacing: Object.assign({ before: 80, after: 240 }, auto(1)), indent: { firstLine: 0 } }, { next: 'SsaBody' }),
    S('SsaFig', 'SSA Figure', {}, { alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, keepNext: true, indent: { firstLine: 0 } }, { next: 'SsaCapF' }),
    // 表文 9 pt / 表头黑体 9 pt（不加粗：黑体再加粗 Word 合成假粗体）；密排 8 pt 固定 10.5 pt
    S('SsaTd', 'SSA Table Cell', { size: half(SZ.td), font: FN, color: INK }, { spacing: auto(1), indent: { firstLine: 0 } }, { next: 'SsaTd' }),
    S('SsaTh', 'SSA Table Head', { size: half(SZ.td), font: FN_H, color: INK }, { spacing: auto(1), indent: { firstLine: 0 } }, { next: 'SsaTd' }),
    S('SsaTdS', 'SSA Table Cell Dense', { size: half(SZ.tdDense), font: FN, color: INK }, { spacing: exact(10.5), indent: { firstLine: 0 } }, { next: 'SsaTdS' }),
    S('SsaThS', 'SSA Table Head Dense', { size: half(SZ.tdDense), font: FN_H, color: INK }, { spacing: exact(10.5), indent: { firstLine: 0 } }, { next: 'SsaTdS' }),
    // 表注（来源行）：宋体 9 pt 次级墨，左齐表左缘，段前 3 / 段后 12 pt（§E.5）
    S('SsaNote', 'SSA Table Note', { size: half(SZ.note), font: FN, color: INK2 }, { spacing: Object.assign({ before: 60, after: 240 }, auto(1)), indent: { firstLine: 0 } }, { next: 'SsaBody' }),
    // 键值读数：标签黑体次级墨 / 值正文墨，9 pt（§J.3）
    S('SsaKvCap', 'SSA Readout Caption', { size: half(SZ.caption), font: FN_H }, { spacing: Object.assign({ before: 240, after: 60 }, auto(1)), keepNext: true, indent: { firstLine: 0 } }, { next: 'SsaBody' }),
    S('SsaKvL', 'SSA Readout Label', { size: half(SZ.kpi), font: FN_H, color: INK2 }, { spacing: auto(1), indent: { firstLine: 0 } }),
    S('SsaKvV', 'SSA Readout Value', { size: half(SZ.kpi), font: FN, color: INK }, { spacing: auto(1), indent: { firstLine: 0 } }),
    // 关键指标格（§G.2）：标签黑体 9 pt / 数值 Arial 粗 20 pt / 对照行 9 pt 次级墨
    S('SsaKpiG', 'SSA KPI Group', { size: half(SZ.kpi), font: FN_H, color: INK2 }, { spacing: Object.assign({ before: 40, after: 40 }, auto(1)), indent: { firstLine: 0 } }),
    S('SsaKpiL', 'SSA KPI Label', { size: half(SZ.kpi), font: FN_H, color: INK }, { spacing: Object.assign({ before: 0, after: 20 }, auto(1)), indent: { firstLine: 0 } }),
    S('SsaKpiV', 'SSA KPI Value', { size: half(SZ.kpiVal), bold: true, font: { ascii: 'Arial', hAnsi: 'Arial', cs: 'Arial', eastAsia: FN_H.eastAsia } }, { spacing: Object.assign({ before: 0, after: 20 }, auto(1)), indent: { firstLine: 0 } }),
    S('SsaKpiD', 'SSA KPI Comparison', { size: half(SZ.kpi), font: FN, color: INK2 }, { spacing: Object.assign({ before: 0, after: 0 }, auto(1)), indent: { firstLine: 0 } }),
    S('SsaBasis', 'SSA Basis Line', { size: half(SZ.note), font: FN, color: INK2 }, { alignment: AlignmentType.CENTER, spacing: Object.assign({ before: 0, after: 200 }, auto(1)), indent: { firstLine: 0 } }),
    // 参考文献：五号、悬挂缩进 2 字、1.25 倍（GB/T 7713.3 表 E.1）
    S('SsaRef', 'SSA Reference', { size: half(SZ.ref), font: FN }, { spacing: Object.assign({ before: 0, after: 60 }, auto(1.25)), indent: { left: 420, hanging: 420 } }),
    // 目次两级
    S('SsaToc1', 'SSA TOC 1', { size: half(SZ.toc), font: FN_H }, { spacing: Object.assign({ before: 60, after: 0 }, exact(18)), indent: { firstLine: 0 } }),
    S('SsaHeaderText', 'SSA Header', { size: half(SZ.header), font: FN, color: INK2 }, { spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO }, indent: { firstLine: 0 } }),
    // 封面「数据截至」一行（§B.3）
    S('SsaCvAsOf', 'SSA Cover As-of', { size: half(12), font: FN, color: INK2 }, { alignment: AlignmentType.CENTER, spacing: { before: 120, after: 0 }, indent: { firstLine: 0 } })
  ]
}

const P = (text, style, opts) => new Paragraph(Object.assign({ style, children: [new TextRun({ text: text == null ? '' : String(text) })] }, opts || {}))

// —— 数字格式化（src/shared/ssaFormat.js 的 CJS 副本，规则见那边头注）——
const THIN = ' '
const MINUS = '−'
const decOf = (v) => {
  const s = String(v)
  const i = s.indexOf('.')
  if (i < 0 || /e/i.test(s)) return 0
  return Math.min(3, s.length - i - 1)
}
function fmtQty(v, dec, group) {
  const neg = v < 0
  const s = Math.abs(v).toFixed(dec)
  const [ip, fp] = s.split('.')
  const body = (group && ip.length >= 4) ? ip.replace(/\B(?=(\d{3})+(?!\d))/g, THIN) : ip
  const zero = !/[1-9]/.test(s)
  return (neg && !zero ? MINUS : '') + body + (fp ? '.' + fp : '')
}
function formatColumns(rows, nCol, blankCols) {
  const list = Array.isArray(rows) ? rows : []
  const n = nCol || (list[0] ? list[0].length : 0)
  const blank = new Set(blankCols || [])
  const dec = []
  let max = 0
  for (let c = 0; c < n; c++) {
    let d = 0
    for (const r of list) {
      const v = r && r[c]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      d = Math.max(d, decOf(v))
      max = Math.max(max, Math.abs(v))
    }
    dec.push(d)
  }
  const groupAll = max >= 10000
  const group = dec.map(() => groupAll)
  return list.map((r) => {
    const out = []
    for (let c = 0; c < n; c++) {
      const v = r ? r[c] : null
      if (v == null || v === '') out.push(blank.has(c) ? '' : '—')
      else if (typeof v === 'number') out.push(Number.isFinite(v) ? fmtQty(v, dec[c], group[c]) : '—')
      else out.push(String(v))
    }
    return out
  })
}
function sourceLine(source, lang) {
  const en = lang === 'en'
  const map = en
    ? { SATCAT: 'SATCAT (CelesTrak)', GP: 'GP ephemeris (CelesTrak)', 'SATCAT+GP': 'SATCAT; GP ephemeris (CelesTrak)' }
    : { SATCAT: 'SATCAT（CelesTrak）', GP: 'GP 星历（CelesTrak）', 'SATCAT+GP': 'SATCAT；GP 星历（CelesTrak）' }
  const v = map[source]
  if (!v) return ''
  return en ? `Source: ${v}.` : `数据来源：${v}。`
}
function chapterNo(sec, k, lang) {
  const no = String((sec && sec.no) || '')
  if (!no) return String(k)
  if (sec.appendix) return no + k
  return no + (lang === 'en' ? '.' : '-') + k
}

// —— 列宽（§E.6）：按内容量，模型 widths 只作下限权重 ——
// 字宽估计与 ssaChartSvg.textW 同一把尺：汉字与全角 1 em、其余 0.5 em（数字 / 拉丁，TNR 量级）。
const CJK_RE = /[⺀-￯]/
function textEm(s) {
  let w = 0
  // 汉字按 1.08 em：Word 的中文字面宽满 1 em，再加字间与单元格边距的舍入，按 1 em 量正好卡在折行边上（实测表头「国际编号」被折成两行）
  for (const ch of String(s == null ? '' : s)) w += CJK_RE.test(ch) ? 1.08 : (/[ .,:;'!|\-·]/.test(ch) ? 0.3 : 0.55)
  return w
}
const WRAP_MAX_MM = 45
// 量一张表：给 9 pt 与 8 pt 两档的自然宽（mm），判档（normal / dense / landscape），再给出百分比列宽
function planTable(head, cells, opts) {
  const n = head.length
  const wrap = new Set(opts.wrapCols || [])
  // 显式点名的折行列（判据表的「判据」）独得铺满版心的余宽；没点名时余宽分给全部折行列
  const extraTo = (opts.wrapCols && opts.wrapCols.length) ? new Set(opts.wrapCols) : null
  // 文字列可折行（§E.6）：左对齐、且格里有成句的文字（含空格或汉字、长于 12 个字符）的列 —— 发射场全称、
  // 主要载荷、母体名这类；数值列与标识列（NORAD、国际编号、日期）不折行
  const al = opts.align || []
  for (let c = 1; c < n; c++) {
    if (al[c] && al[c] !== 'left') continue
    if (cells.some((r) => { const t = String(r[c] || ''); return t.length > 12 && (/\s/.test(t) || CJK_RE.test(t)) })) wrap.add(c)
  }
  const nat = (pt, padMm) => {
    const emMm = pt * 25.4 / 72
    const w = []
    for (let c = 0; c < n; c++) {
      const hm = textEm(head[c]) * emMm + 1.0      // 表头另留 1 mm：表头折行比数据折行难看得多
      let m = 0
      for (const r of cells) m = Math.max(m, textEm(r[c]))
      let mm = Math.max(hm, m * emMm) + 2 * padMm
      if (wrap.has(c)) mm = Math.min(mm, WRAP_MAX_MM)
      w.push(mm)
    }
    return w
  }
  // 判档与分宽：数值 / 标识列按自然宽（不折行）；可折行列先拿自然宽（封顶 45 mm），版心不够时往下压、
  // 每列最少 WRAP_MIN_MM —— 只有压到底仍放不下，才降 8 pt 密排；密排仍放不下才切横向节（§E.6 第 3–5 步）
  const portMm = CONTENT_TW / TW_PER_MM, landMm = CONTENT_LAND_TW / TW_PER_MM
  const WRAP_MIN_MM = 18
  const fits = (w, total) => {
    let fixed = 0, wrapMin = 0
    for (let c = 0; c < n; c++) { if (wrap.has(c)) wrapMin += Math.min(w[c], WRAP_MIN_MM); else fixed += w[c] }
    return fixed + wrapMin <= total
  }
  let mode = 'normal'
  let w = nat(SZ.td, 1.9)
  if (opts.forceDense || !fits(w, portMm)) { mode = 'dense'; w = nat(SZ.tdDense, 1.0) }
  if (!fits(w, portMm)) mode = 'landscape'
  const totalMm = mode === 'landscape' ? landMm : portMm
  let fixed = 0, wrapNat = 0
  for (let c = 0; c < n; c++) { if (wrap.has(c)) wrapNat += w[c]; else fixed += w[c] }
  const avail = totalMm - fixed
  if (wrapNat > avail && wrapNat > 0) {
    // 折行列按自然宽比例压进剩余宽度，每列不低于 WRAP_MIN_MM
    const k = avail / wrapNat
    for (let c = 0; c < n; c++) if (wrap.has(c)) w[c] = Math.max(Math.min(w[c], WRAP_MIN_MM), w[c] * k)
  }
  // 铺满版心：余量有折行列时全给折行列（整句判据、长名最需要宽度），没有就按比例放大
  const sum = w.reduce((x, y) => x + y, 0) || 1
  let pct
  if (sum < totalMm && wrap.size) {
    const extra = totalMm - sum
    const to = extraTo || wrap
    const wn = w.filter((_, c) => to.has(c)).reduce((x, y) => x + y, 0) || 1
    pct = w.map((x, c) => (x + (to.has(c) ? extra * x / wn : 0)) / totalMm * 100)
  } else pct = w.map((x) => x / sum * 100)
  // 末列吃掉舍入余数
  const r = pct.map((x) => Math.max(1, Math.round(x * 10) / 10))
  const s2 = r.reduce((x, y) => x + y, 0)
  r[r.length - 1] = Math.max(1, Math.round((r[r.length - 1] + 100 - s2) * 10) / 10)
  return { mode, pct: r }
}

const colAlign = (a) => (a === 'right' ? AlignmentType.RIGHT : a === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT)

/**
 * SSA 三线表（§E）。cells = 已格式化的串；opts:
 *   align[]（'left'|'right'|'center'）、pct[]（列宽百分比）、dense、headGroups[{label,from,to}]、
 *   rowRoles{ri:'total'|'other'|'group'}。
 * 线：表头首行顶 1.0 pt；表头末行（或跨两行的格）底 0.5 pt；合计行顶 0.5 pt；末行底 1.0 pt；分组短线 = 组名段落下边框 0.5 pt、左右各缩 1 mm。
 */
function ssaTable(head, cells, opts) {
  const o = opts || {}
  const align = o.align || []
  const dense = !!o.dense
  const td = dense ? 'SsaTdS' : 'SsaTd', th = dense ? 'SsaThS' : 'SsaTh'
  const M = dense ? { top: 30, bottom: 30, left: 57, right: 57 } : { top: 45, bottom: 45, left: 108, right: 108 }
  const width = (i, span) => {
    if (!o.pct) return undefined
    let s = 0
    for (let k = i; k < i + (span || 1); k++) s += o.pct[k] || 0
    return { size: s, type: WidthType.PERCENTAGE }
  }
  const cell = (text, i, c) => new TableCell({
    width: width(i, c.span),
    columnSpan: c.span && c.span > 1 ? c.span : undefined,
    rowSpan: c.rowSpan && c.rowSpan > 1 ? c.rowSpan : undefined,
    borders: { top: c.top ? B(c.top) : NONE, bottom: c.bottom ? B(c.bottom) : NONE, left: NONE, right: NONE },
    verticalAlign: c.head ? VerticalAlign.BOTTOM : VerticalAlign.CENTER,
    margins: M,
    children: [new Paragraph({
      style: c.head ? th : td,
      alignment: c.group ? AlignmentType.CENTER : colAlign(align[i]),
      // 分组短线：组名段落的下边框，两端各缩 1 mm（booktabs 的 cmidrule(lr)）
      border: c.group ? { bottom: { style: BorderStyle.SINGLE, size: RULE.thin, color: INK, space: 1 } } : undefined,
      indent: c.group ? { left: 57, right: 57, firstLine: 0 } : undefined,
      spacing: c.groupFirst ? { before: 60 } : undefined,
      children: [new TextRun({ text: text == null ? '' : String(text), style: c.key ? 'RptKey' : undefined })]
    })]
  })
  const trs = []
  const groups = Array.isArray(o.headGroups) ? o.headGroups : []
  if (head && head.length) {
    if (groups.length) {
      const top = [], bottom = []
      let ci = 0
      while (ci < head.length) {
        const g = groups.find((x) => x.from === ci)
        if (g) {
          top.push(cell(g.label, ci, { head: true, top: RULE.strong, span: g.to - g.from + 1, group: true }))
          for (let k = g.from; k <= g.to; k++) bottom.push(cell(head[k], k, { head: true, bottom: RULE.thin }))
          ci = g.to + 1
        } else {
          top.push(cell(head[ci], ci, { head: true, top: RULE.strong, bottom: RULE.thin, rowSpan: 2 }))
          ci++
        }
      }
      trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: top }))
      trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: bottom }))
    } else {
      trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, i, { head: true, top: RULE.strong, bottom: RULE.thin })) }))
    }
  }
  const roles = o.rowRoles || {}
  cells.forEach((r, ri) => {
    const last = ri === cells.length - 1
    const role = roles[ri]
    const first = !(head && head.length) && ri === 0
    trs.push(new TableRow({
      cantSplit: true,
      children: r.map((v, i) => cell(v, i, {
        top: first ? RULE.strong : (role === 'total' ? RULE.thin : 0),
        bottom: last ? RULE.strong : 0,
        key: role === 'total',
        groupFirst: role === 'group'
      }))
    }))
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: trs
  })
}

// 键值读数：两列无线，标签列 30 mm（§J.3）
function ssaKvTable(rows) {
  const labelPct = Math.round(30 * TW_PER_MM / CONTENT_TW * 1000) / 10
  const cell = (text, style, pct) => new TableCell({
    width: { size: pct, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
    margins: { top: 20, bottom: 20, left: 0, right: 108 },
    children: [P(text, style)]
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: rows.map(([k, v]) => new TableRow({ cantSplit: true, children: [cell(k, 'SsaKvL', labelPct), cell(v, 'SsaKvV', 100 - labelPct)] }))
  })
}

// 关键指标表（§G.3）：每组一行组名（跨四列）+ 一行四格；线：表顶 1.0 pt、组间 0.5 pt、表底 1.0 pt
function ssaKpiTable(groups) {
  const cols = 4
  const pct = 100 / cols
  const trs = []
  groups.forEach((g, gi) => {
    const firstGroup = gi === 0, lastGroup = gi === groups.length - 1
    trs.push(new TableRow({
      cantSplit: true,
      children: [new TableCell({
        columnSpan: cols, width: { size: 100, type: WidthType.PERCENTAGE },
        borders: { top: B(firstGroup ? RULE.strong : RULE.thin), bottom: NONE, left: NONE, right: NONE },
        margins: { top: 60, bottom: 0, left: 57, right: 57 },
        children: [new Paragraph({ style: 'SsaKpiG', children: [new TextRun({ text: g.title || '' }), ...(g.refLabel ? [new TextRun({ text: (g.refPrefix || '　　对照：') + g.refLabel })] : [])] })]
      })]
    }))
    const items = (g.items || []).slice(0, cols)
    while (items.length < cols) items.push(null)
    trs.push(new TableRow({
      cantSplit: true,
      children: items.map((it) => new TableCell({
        width: { size: pct, type: WidthType.PERCENTAGE },
        borders: { top: NONE, bottom: lastGroup ? B(RULE.strong) : NONE, left: NONE, right: NONE },
        margins: { top: 40, bottom: 120, left: 57, right: 57 },
        children: it ? [
          P(it.label, 'SsaKpiL'),
          P(it.value, 'SsaKpiV'),
          P(it.note ? it.note : [it.ref, it.delta, it.pct].filter((x) => x != null && x !== '').join('　'), 'SsaKpiD')
        ] : [P('', 'SsaKpiD')]
      }))
    }))
  })
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: trs
  })
}

// 页眉（§B.5）：左报告名（密级非空时其后加「 · 密级」）9 pt 次级墨，右台标 10 mm；无页眉线。
// 用右对齐制表位把台标推到版心右缘（纵向 / 横向各用各的版心宽）。
function ssaHeader(model, landscape) {
  const d = model.doc || {}
  const name = String(d.title || '')
  const text = (name.length > 30 ? name.slice(0, 30) + '…' : name) + (d.classification ? '  ·  ' + d.classification : '')
  const runs = [new TextRun({ text })]
  const lg = d.logo
  if (lg && lg.dataUrl) {
    const size = pngSizeOf(lg.dataUrl)
    if (size && size.w && size.h) {
      let h = Math.round(10 * PX_PER_MM)
      let w = Math.round(h * size.w / size.h)
      const wMax = Math.round(40 * PX_PER_MM)
      if (w > wMax) { w = wMax; h = Math.round(w * size.h / size.w) }
      runs.push(new TextRun({ children: [new Tab()] }))
      runs.push(new ImageRun({ data: Buffer.from(String(lg.dataUrl).split(',').pop(), 'base64'), type: 'png', transformation: { width: w, height: h } }))
    }
  }
  return new Header({
    children: [new Paragraph({
      style: 'SsaHeaderText',
      tabStops: [{ type: TabStopType.RIGHT, position: landscape ? CONTENT_LAND_TW : CONTENT_TW }],
      children: runs
    })]
  })
}

// 图：按成图物理尺寸放（§F.1），不缩放 —— 图内 8 pt 字放进 Word 仍是 8 pt
function ssaFigure(dataUrl, caption, mm) {
  const size = pngSizeOf(dataUrl)
  if (!size) return []
  const w = Math.round(mm[0] * PX_PER_MM)
  const h = Math.round(mm[1] * PX_PER_MM)
  const data = Buffer.from(String(dataUrl).split(',').pop(), 'base64')
  return [
    new Paragraph({ style: 'SsaFig', children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })] }),
    P(caption, 'SsaCapF')
  ]
}

module.exports = {
  SZ, RULE, CONTENT_TW, CONTENT_LAND_TW,
  ssaParagraphStyles, P, formatColumns, fmtQty, sourceLine, chapterNo, planTable,
  ssaTable, ssaKvTable, ssaKpiTable, ssaHeader, ssaFigure
}
