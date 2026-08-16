// 链路预算报告的 Word 出口（.docx，主进程）。
//
// 版式照用户给的《技术文档标准模板.docx》：
//   封面（密级 / 文档编号 → 文档标题 / 副标题 → 编制单位 / 成文日期，右上角可贴 logo）
//   → 文档控制（签署 + 变更记录）→ 目录（Word 域，打开时自动生成页码）
//   → 正文（四级标题 + 正文 / 图号表号格式 / 三线表）
// 各样式的字号、字体、间距、缩进与表格边框全部取自 reportStyle.js（那里注了模板原值）。
// 字体：西文与数字 Times New Roman，中文标题与题注黑体、中文正文宋体（模板本身即此口径）。
// 表格一律三线表：顶线/底线 1.5 磅、栏目线 0.75 磅，无竖线、无底纹（模板「三线表」样式）。
//
// 与 PDF 的分工：PDF 的逐链路详情是屏幕排版的复刻（级联表 ‖ 图 两栏），Word 是流式文档，
// 故详情章按「级联主表 → 图 → 参考段各表」顺排。数字、题注编号、章节号三处一致。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, TableOfContents,
  Header, Footer, PageNumber, AlignmentType, WidthType, BorderStyle, VerticalAlign, ImageRun,
  PageOrientation, LineRuleType
} = require('docx')
const { TPL, half } = require('./reportStyle')

const FN = { ascii: TPL.font.latin, hAnsi: TPL.font.latin, cs: TPL.font.latin, eastAsia: TPL.font.cjkBody }
const FN_H = { ascii: TPL.font.latin, hAnsi: TPL.font.latin, cs: TPL.font.latin, eastAsia: TPL.font.cjkHeading }

// —— 样式表（id 前缀 Rpt/Cv，避免与模板自带的样式撞名）——
function paragraphStyles() {
  const line = { line: 360, lineRule: LineRuleType.AUTO }   // 模板 正文：1.5 倍行距
  // 模板各级标题：黑体，固定行距（标题 1/3 为 25 磅、标题 4 为 22 磅），段前后 6 磅。
  // 黑体本身已是重字面，模板未再加粗，此处照办。
  const head = (id, name, size, outline, lineTw) => ({
    id, name, basedOn: 'Normal', next: 'RptBody', quickFormat: true,
    run: { size: half(size), font: FN_H },
    paragraph: {
      spacing: { before: TPL.spacing.hBeforeTw, after: TPL.spacing.hAfterTw, line: lineTw, lineRule: LineRuleType.EXACT },
      keepNext: true, outlineLevel: outline
    }
  })
  return [
    // 文档标题：模板 文档标题（黑体 16pt 居中，段前后 2.5 磅）
    { id: 'RptTitle', name: 'Report Title', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.docTitle), font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: Object.assign({ before: 120, after: 240 }, line) } },
    head('RptH1', 'Report Heading 1', TPL.size.h1, 0, TPL.spacing.h1LineTw),
    head('RptH2', 'Report Heading 2', TPL.size.h2, 1, TPL.spacing.h1LineTw),
    head('RptH3', 'Report Heading 3', TPL.size.h3, 2, TPL.spacing.h3LineTw),
    head('RptH4', 'Report Heading 4', TPL.size.h4, 3, TPL.spacing.h4LineTw),
    // 正文：模板 正文（小四、1.5 倍行距、首行缩进 2 字符、两端对齐）
    { id: 'RptBody', name: 'Report Body', basedOn: 'Normal', next: 'RptBody', quickFormat: true,
      run: { size: half(TPL.size.body), font: FN },
      paragraph: { spacing: line, indent: { firstLine: TPL.spacing.bodyFirstLineTw }, alignment: AlignmentType.BOTH } },
    // 说明性文字：同正文但不缩进（表下注释、方法学脚注）——模板 正文中文
    { id: 'RptNote', name: 'Report Note', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.caption), font: FN, color: '595959' },
      paragraph: { spacing: { line: 300, lineRule: LineRuleType.AUTO, after: 60 }, alignment: AlignmentType.BOTH } },
    // 题注：模板 表号格式 / 图号格式（黑体 10.5pt 居中，段前后 50 行）。表题在表上方、图题在图下方。
    { id: 'RptCaption', name: 'Report Caption', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.caption), font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: TPL.spacing.captionBeforeTw, after: TPL.spacing.captionAfterTw, line: 300, lineRule: LineRuleType.AUTO }, keepNext: true } },
    // 图题跟在图下面，故它自己不 keepNext（keepNext 的是图那一段）
    { id: 'RptCaptionFig', name: 'Report Figure Caption', basedOn: 'RptCaption', next: 'RptBody',
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: TPL.spacing.captionBeforeTw, after: TPL.spacing.captionAfterTw, line: 300, lineRule: LineRuleType.AUTO } } },
    // 图：模板 AA图片（居中，1.5 倍行距）
    { id: 'RptFig', name: 'Report Figure', basedOn: 'Normal', next: 'RptCaptionFig',
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 0 }, keepNext: true } },
    // 表格文字：模板 表格格式（宋体 10.5pt，单倍行距，不缩进）
    { id: 'RptTd', name: 'Report Table Cell', basedOn: 'Normal', next: 'RptTd',
      run: { size: half(TPL.size.table), font: FN },
      paragraph: { spacing: { line: 240, lineRule: LineRuleType.AUTO }, indent: { firstLine: 0 }, alignment: AlignmentType.LEFT } },
    // 表头：三线表不加粗、不加底纹，只把中文换成黑体（模板的字体语言，又刚好补上一档视觉分隔）
    { id: 'RptTh', name: 'Report Table Head', basedOn: 'RptTd', next: 'RptTd',
      run: { size: half(TPL.size.table), font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER } },
    // 密排表：只给「逐参数对照」那张链路做列的宽表用（7 条链路 8 列，10.5pt 排不开）。
    // 级联/瀑布表不再走这一档——9pt + 10pt 固定行距挤得没法读，是用户 2026-08-02 点名的问题。
    { id: 'RptTdS', name: 'Report Table Cell Small', basedOn: 'Normal', next: 'RptTdS',
      run: { size: half(TPL.size.tableDense), font: FN },
      paragraph: { spacing: { line: 240, lineRule: LineRuleType.AUTO }, indent: { firstLine: 0 } } },
    { id: 'RptThS', name: 'Report Table Head Small', basedOn: 'RptTdS', next: 'RptTdS',
      run: { size: half(TPL.size.tableDense), font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { line: 240, lineRule: LineRuleType.AUTO } } },
    // 封面各栏（模板封面全部是「标题（Title）」样式：黑体 16pt 居中；顶部两行密级/编号是正文样式）
    { id: 'CvMeta', name: 'Cover Meta', basedOn: 'Normal',
      run: { size: half(TPL.size.coverMeta), font: FN },
      paragraph: { alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, spacing: Object.assign({}, line) } },
    { id: 'CvTitle', name: 'Cover Title', basedOn: 'Normal',
      run: { size: half(TPL.size.coverTitle), font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, indent: { firstLine: 0 }, spacing: { before: 120, after: 120, line: 300, lineRule: LineRuleType.AUTO } } },
    { id: 'CvSub', name: 'Cover Subtitle', basedOn: 'CvTitle', run: { size: half(TPL.size.coverSub), font: FN_H } },
    { id: 'CvOrg', name: 'Cover Org', basedOn: 'CvTitle', run: { size: half(TPL.size.coverOrg), font: FN_H } }
  ]
}

// —— 段落 / 单元格辅助 ——
const P = (text, style, opts) => new Paragraph(Object.assign({
  style, children: [new TextRun({ text: text == null ? '' : String(text) })]
}, opts || {}))

const B = (sz, color) => ({ style: BorderStyle.SINGLE, size: sz, color: color || 'auto' })
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' }

// 文档类表格（模板「三线表」样式：顶线 / 底线 1.5 磅、栏目线 0.75 磅，无竖线、无底纹）。
// 表内文字 10.5pt、垂直居中，单元格边距上下 45 / 左右 108 tw——全部照模板。
function docTable(head, rows, opts) {
  opts = opts || {}
  const strong = TPL.table.topSz, thin = TPL.table.headSz
  const dense = !!opts.dense
  const tdStyle = dense ? 'RptTdS' : 'RptTd'
  const thStyle = dense ? 'RptThS' : 'RptTh'
  const align = opts.align || []
  const M = TPL.table.cellMarTw
  const cell = (text, i, o) => new TableCell({
    width: opts.widths ? { size: opts.widths[i], type: WidthType.PERCENTAGE } : undefined,
    borders: { top: o.top ? B(o.top) : NONE, bottom: o.bottom ? B(o.bottom) : NONE, left: NONE, right: NONE },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: M.top, bottom: M.bottom, left: M.left, right: M.right },
    children: [new Paragraph({
      style: o.head ? thStyle : tdStyle,
      alignment: o.head ? AlignmentType.CENTER : (align[i] === 'right' ? AlignmentType.RIGHT : align[i] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT),
      // 关键行（分组行 / 小计 / 余量）换黑体，不加粗：三线表不许底纹，层次只能靠字体给，
      // 而黑体上再加粗会被 Word 合成成假粗体，糊成一团。
      children: [new TextRun({ text: text == null ? '' : String(text), font: o.key ? FN_H : undefined })]
    })]
  })
  const trs = []
  const hasHead = !!(head && head.length)
  // cantSplit：一行不许被分页拦腰截断
  if (hasHead) trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => cell(h, i, { head: true, top: strong, bottom: thin })) }))
  rows.forEach((r, ri) => {
    const first = !hasHead && ri === 0
    const last = ri === rows.length - 1
    const key = !!(opts.keyRows && opts.keyRows[ri])
    trs.push(new TableRow({ cantSplit: true, children: r.map((v, i) => cell(v, i, { top: first ? strong : 0, bottom: last ? strong : 0, key })) }))
  })
  // widthPct：三列的小表（输入参数）铺满 253mm 的横向版心会显得空旷，收窄并居中更像正式文档里的表
  return new Table({
    width: { size: opts.widthPct || 100, type: WidthType.PERCENTAGE },
    alignment: opts.widthPct ? AlignmentType.CENTER : undefined,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    rows: trs
  })
}

// 计算结果表（级联 / 瀑布）：同为三线表——题注下顶线、列头下栏目线、段末底线。
// 版式与 docTable 一致（10.5pt、模板的单元格边距、垂直居中），差别只在它多两样：
//   keyRows  关键行（小计 / 门限 / 余量 / 分段基准）换黑体——三线表不许底纹，层次只能靠字体给；
//   sepRows  小计与余量上方一条 0.75pt 分隔线，把四十余行切成几段。
function bookTable(head, rows, opts) {
  opts = opts || {}
  const align = opts.align || []
  const strong = TPL.rule.strongSz, thin = TPL.rule.thinSz
  const M = TPL.table.cellMarTw
  const mk = (text, i, o) => new TableCell({
    width: opts.widths ? { size: opts.widths[i], type: WidthType.PERCENTAGE } : undefined,
    borders: {
      top: o.top ? B(o.top) : NONE, bottom: o.bottom ? B(o.bottom) : NONE, left: NONE, right: NONE
    },
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: M.top, bottom: M.bottom, left: M.left, right: M.right },
    children: [new Paragraph({
      style: o.head ? 'RptTh' : 'RptTd',
      alignment: o.head ? AlignmentType.CENTER
        : (align[i] === 'right' ? AlignmentType.RIGHT : align[i] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT),
      children: [new TextRun({ text: text == null ? '' : String(text), font: o.key ? FN_H : undefined })]
    })]
  })
  const trs = []
  // cantSplit：一行不许被分页拦腰截断（数值与其标签分居两页是最难读的一种断法）
  if (head && head.length) {
    trs.push(new TableRow({ tableHeader: true, cantSplit: true, children: head.map((h, i) => mk(h, i, { head: true, top: strong, bottom: thin })) }))
  }
  rows.forEach((r, ri) => {
    const last = ri === rows.length - 1
    const key = !!(opts.keyRows && opts.keyRows[ri])
    const sep = !!(opts.sepRows && opts.sepRows[ri])
    trs.push(new TableRow({ cantSplit: true, children: r.map((v, i) => mk(v, i, { bottom: last ? strong : 0, top: sep ? thin : 0, key })) }))
  })
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: {
    top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE
  }, rows: trs })
}

// 键值表（报告信息 / 场景与假设）：同样走三线表，标签列左、值列左
const kvTable = (rows) => docTable(null, rows.map(([k, v]) => [k, v]), { widths: [26, 74] })

// —— 图 ——
// dataUrl → ImageRun。宽高按「像素（96 dpi）」给：docx 内部按 9525 EMU/px 折算。
function pngSizeOf(dataUrl) {
  try {
    const b64 = String(dataUrl).split(',').pop()
    const buf = Buffer.from(b64.slice(0, 64), 'base64')
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  } catch (e) { return null }
}
function figureParagraphs(dataUrl, caption, maxWpx, maxHpx) {
  const size = pngSizeOf(dataUrl)
  if (!size) return []
  let w = maxWpx, h = Math.round(maxWpx * size.h / size.w)
  if (h > maxHpx) { h = maxHpx; w = Math.round(maxHpx * size.w / size.h) }
  const data = Buffer.from(String(dataUrl).split(',').pop(), 'base64')
  return [
    // 图题在图**下方**（模板「图号格式」的口径，也是中文出版惯例）
    new Paragraph({ style: 'RptFig', children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })] }),
    P(caption, 'RptCaptionFig')
  ]
}

// —— 页眉的右上角 logo ——
// 每一页都有（含封面），故走 Header 而不是往正文里塞段落——正文段落只跟着它所在那一页走。
// 高度钉在 10 mm：上页边距是 2.25 cm，页眉超过它 Word 会把版心整体往下推。
// 矢量图已在渲染端栅格化成 PNG（docx 的图只吃位图）。
const MM_PX = (mm) => Math.round(mm / 25.4 * 96)
function logoHeader(logo) {
  const empty = new Header({ children: [new Paragraph({ children: [] })] })
  if (!logo || !logo.dataUrl) return empty
  const size = pngSizeOf(logo.dataUrl)
  if (!size || !size.w || !size.h) return empty
  let h = MM_PX(TPL.cover.logoHeaderHmm)
  let w = Math.round(h * size.w / size.h)
  const wMax = MM_PX(TPL.cover.logoHeaderWmm)
  if (w > wMax) { w = wMax; h = Math.round(w * size.h / size.w) }
  const data = Buffer.from(String(logo.dataUrl).split(',').pop(), 'base64')
  return new Header({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT, spacing: { after: 0, line: 240, lineRule: LineRuleType.AUTO },
      indent: { firstLine: 0 },
      children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })]
    })]
  })
}

// —— 页脚：模板 页脚样式（宋体 9pt），只有一个居中页码域 ——
const pageFooter = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ font: FN, size: half(TPL.size.footer), children: [PageNumber.CURRENT] })]
  })]
})

const sectPage = (landscape, numbering) => ({
  page: {
    size: landscape
      ? { orientation: PageOrientation.LANDSCAPE, width: TPL.page.heightTw, height: TPL.page.widthTw }
      : { orientation: PageOrientation.PORTRAIT, width: TPL.page.widthTw, height: TPL.page.heightTw },
    margin: TPL.page.marginTw,
    pageNumbers: numbering || undefined
  }
})

// 版心宽（像素，96 dpi）：twips → pt → px
const contentPx = (landscape) => Math.round(((landscape ? TPL.page.heightTw : TPL.page.widthTw) - TPL.page.marginTw.left - TPL.page.marginTw.right) / 15)

// ============================ 正文装配 ============================

// 封面：照模板第一节的结构还原——流式一栏，不是浮动表。
//   （右上角 logo，用户上传时才有）
//   密　　级：xxx
//   文档编号：xxx
//   ……留白……
//   报告名（模板「标题（Title）」：黑体 16pt 居中）—— 全篇唯一的一行主标题
//   ……留白……
//   编制单位
//   成文日期
// ★ 2026-08-02 用户定：封面**不要副标题**（体制名与报告名里的「链路预算」重复），
//   一个醒目的主标题即可；项目名、公司名、签署栏一并去掉（新模板封面本就没有这些栏位）。
// ★ 编制单位来自用户填写 —— 软件不预设任何单位名。
function coverSection(model) {
  const d = model.doc || {}
  const L = model.t || {}
  const gap = (tw) => new Paragraph({ style: 'CvTitle', spacing: { before: tw }, children: [] })
  const children = []
  children.push(P(L.cvClass + '：' + (d.classification || ''), 'CvMeta'))
  children.push(P(L.cvDocNo + '：' + (d.docNo || ''), 'CvMeta'))
  children.push(gap(TPL.spacing.coverTopTw))
  children.push(P(d.title || '', 'CvTitle'))
  children.push(gap(TPL.spacing.coverMidTw))
  if (d.org) children.push(P(d.org, 'CvOrg'))
  children.push(P(d.date || '', 'CvSub'))
  // 封面也有页眉 logo——用户要的是「每一页右上角」，封面不该是例外；
  // 页脚不给（封面不编页码，模板亦然）。
  return { properties: sectPage(false), headers: { default: logoHeader(d.logo) }, children }
}

function tocSection(model) {
  const L = model.t || {}
  return {
    properties: sectPage(false, { start: 1, formatType: 'upperRoman' }),
    headers: { default: logoHeader((model.doc || {}).logo) }, footers: { default: pageFooter() },
    children: [
      P(L.contents || '目 录', 'RptTitle'),
      new TableOfContents('Contents', { hyperlink: true, headingStyleRange: '1-3' }),
      P(model.lang === 'en'
        ? '(In Word: right-click the table of contents → Update Field to fill in page numbers.)'
        : '（在 Word 中右键目录 → 更新域，即可填入页码。）', 'RptNote')
    ]
  }
}

// 链路清单 + 逐参数对照（横向：宽表）
function masterTablesSection(model) {
  const L = model.t || {}
  const links = model.links || []
  const sum = model.summary || { metrics: [] }
  const children = [P(L.master, 'RptH1'), P('1　' + L.compare, 'RptH2')]
  const CL = 7
  const lchunks = []
  for (let i = 0; i < links.length; i += CL) lchunks.push({ from: i, items: links.slice(i, i + CL) })
  const cmpNo = nextTableNo(model)     // 续表共用一个表号（表 n-1 / 表 n-2 …）
  lchunks.forEach((ck, ci) => {
    children.push(P(capTable(model, cmpNo, ci, lchunks.length, L.compare), 'RptCaption'))
    const head = [L.param, ...ck.items.map((l) => '#' + l.no + '　' + (l.txName || '') + ' → ' + (l.rxName || ''))]
    const rows = sum.metrics.map((m) => [m.label, ...ck.items.map((l, i) => fmtVal(m.values[ck.from + i]))])
    const rest = Math.floor(66 / ck.items.length)
    children.push(docTable(head, rows, {
      dense: true, widths: [34, ...ck.items.map(() => rest)],
      align: ['left', ...ck.items.map(() => 'right')]
    }))
  })
  return { properties: sectPage(true, { start: 1, formatType: 'decimal' }), headers: { default: logoHeader((model.doc || {}).logo) }, footers: { default: pageFooter() }, children }
}

// 容量与统计 + 计算模型与参考（纵向）
function masterTailSection(model) {
  const L = model.t || {}
  const sum = model.summary || { stats: [] }
  const m = model.method || { basis: [], refGroups: [], constants: [] }
  const children = []
  if (sum.stats && sum.stats.length) {
    children.push(P('2　' + L.capacity, 'RptH2'))
    if (sum.statsTitle) children.push(P(sum.statsTitle, 'RptNote'))
    children.push(P(capTable(model, nextTableNo(model), 0, 1, L.capacity), 'RptCaption'))
    children.push(docTable([L.param, L.value], sum.stats.map((s) => [s.label, s.value]), { widths: [60, 40], align: ['left', 'right'] }))
  }
  // 方法学章节：报告的权威性所在——逐段说明算法口径，再列引用建议书与常数基准
  children.push(P('3　' + L.refs, 'RptH2'))
  children.push(P('3.1　' + L.mBasis, 'RptH3'))
  for (const b of m.basis) {
    children.push(new Paragraph({ style: 'RptH4', children: [new TextRun({ text: b.title })] }))
    children.push(P(b.text, 'RptBody'))
  }
  children.push(P('3.2　' + L.mRefs, 'RptH3'))
  children.push(P(capTable(model, nextTableNo(model), 0, 1, L.mRefs), 'RptCaption'))
  const refRows = []
  const refBold = []
  for (const g of m.refGroups) {
    refRows.push([g.group, '', '']); refBold.push(true)         // 类别行：三线表不许底纹，靠加粗分组
    for (const r of g.items) { refRows.push([r.id, r.title, r.use]); refBold.push(false) }
  }
  children.push(docTable([L.mId, L.mTitle, L.mUse], refRows, { widths: [26, 38, 36], keyRows: refBold }))
  children.push(P('3.3　' + L.mConst, 'RptH3'))
  children.push(P(capTable(model, nextTableNo(model), 0, 1, L.mConst), 'RptCaption'))
  children.push(docTable([L.param, L.mSymbol, L.mValue, L.unit, L.mSrc],
    m.constants.map((c) => [c.name, c.symbol, c.value, c.unit, c.src]),
    { widths: [30, 12, 20, 14, 24], align: ['left', 'center', 'right', 'left', 'left'] }))
  return { properties: sectPage(false), headers: { default: logoHeader((model.doc || {}).logo) }, footers: { default: pageFooter() }, children }
}

// 逐链路详情（横向）：输入参数 → 级联主表 → 图 → 参考段各表
// 次序照 Excel 的详情表：一条链路先看它是拿什么算的（输入），再看算出什么（结果）。
// 输入按块竖排（参数 / 数值 / 单位 三列），与 Excel 逐块往下排完全一致。
function detailSection(model) {
  const L = model.t || {}
  const links = model.links || []
  const children = [P(L.detail, 'RptH1')]
  const maxW = Math.round(contentPx(true) * 0.52)
  const maxH = Math.round(contentPx(true) * 0.30)
  links.forEach((l, li) => {
    children.push(P('#' + l.no + '　' + (l.txName || '') + ' → ' + (l.rxName || ''), 'RptH2'))
    if (l.error) {
      children.push(P(L.calcFailed + '：' + l.error + '　—　' + L.noResult, 'RptNote'))
      return
    }
    if (l.inputs && l.inputs.length) {
      children.push(P(L.inputs, 'RptH3'))
      // 详情章的表号按「链路序号-块序号」编（与图号同一套），不占全文连续号——
      // 一条链路的表与图因此自成一组，读者从题注就知道它属于哪条链路。
      // 与级联表同一档字号（10.5pt）与单元格边距——输入表原来走 9pt 密排档，和结果表一样难读。
      // 三列的小表收窄到六成版心并居中：铺满 253mm 的横向版心时，参数名与数值会被拉开半页。
      l.inputs.forEach((blk, bi) => {
        children.push(P(capTable(model, l.no + '-' + (bi + 1), 0, 1, blk.title), 'RptCaption'))
        children.push(docTable([L.param, L.value, L.unit], blk.rows.map((r) => [r.label, r.value, r.unit]),
          { widths: [52, 26, 22], align: ['left', 'right', 'left'], widthPct: 60 }))
      })
      children.push(P(L.results, 'RptH3'))
    }
    const segs = l.segments || []
    const cascade = segs.filter((s) => s && s.role === 'cascade')
    const rest = segs.filter((s) => s && s.role !== 'cascade')
    for (const seg of cascade) children.push(...segTable(model, seg))
    ;(l.figures || []).forEach((f, fi) => {
      if (!f || !f.dataUrl) return
      children.push(...figureParagraphs(f.dataUrl, capFigure(model, l.no, fi, f.title), maxW, maxH))
    })
    for (const seg of rest) children.push(...segTable(model, seg))
  })
  return { properties: sectPage(true), headers: { default: logoHeader((model.doc || {}).logo) }, footers: { default: pageFooter() }, children }
}

// 一个瀑布段 → 题注 + 三线表
function segTable(model, seg) {
  if (!seg || !seg.rows || !seg.rows.length) return []
  const L = model.t || {}
  const cols = seg.cols || 1
  const vh = cols >= 3 ? [L.uplink || '上行', L.downlink || '下行', L.total || '合计']
    : cols >= 2 ? [L.uplink || '上行', L.downlink || '下行'] : [L.value]
  const heads = (Array.isArray(seg.heads) && seg.heads.length === cols) ? seg.heads : vh
  const head = [L.param, ...heads, L.unit]
  // 端到端级联的两级分组行（head=段 / shead=跳·透明转发·收发站）与小计/余量同走 keyRows：
  // bookTable 的 keyRows 就是「换黑体不加粗」，正是三线表里唯一允许的分组手法（不许底纹）。
  // 段标题另上一条 0.75pt 分隔线（sepRows），跳标题不画——十来跳各一条会把表切成横带。
  // ★ 不认识的 kind 一律按普通行走，行不会丢。
  const strongKind = ['base', 'sub', 'chk', 'kpi', 'margin', 'head', 'shead']
  const rows = seg.rows.map((r) => {
    const vals = cols >= 3 ? [r.up, r.down, r.total] : cols >= 2 ? [r.up, r.down] : [r.up]
    return [(r.sign ? r.sign + ' ' : '') + (r.label || ''), ...vals.map((v) => (v == null ? '' : String(v))), r.unit || '']
  })
  const keyRows = seg.rows.map((r) => strongKind.indexOf(r.kind) > -1)
  const sepRows = seg.rows.map((r, i) => (r.kind === 'head' ? i > 0 : ['sub', 'margin'].indexOf(r.kind) > -1))
  // 列宽：参数列占四成（最长的标签是「上行大气衰减 (P.676)」一类，约 14 字），
  // 数值列均分，单位列留够 dBW/m² 这种量纲。总和钉在 100，别让 Word 自己去凑。
  const n = heads.length
  const vw = Math.floor(46 / n)
  return [
    P((seg.no ? '§' + seg.no + '　' : '') + (seg.title || ''), 'RptCaption'),
    bookTable(head, rows, {
      keyRows, sepRows,
      widths: [100 - vw * n - 12, ...heads.map(() => vw), 12],
      align: ['left', ...heads.map(() => 'right'), 'left']
    })
  ]
}

// —— 小工具 ——
const fmtVal = (v) => (v == null || v === '' ? '—' : String(v))
// 表号全文连续（模板口径）。一张逻辑表取一次号，续表共用（表 n-1 / 表 n-2 …）；
// 详情章的表另按「链路序号-块序号」编，不走这个计数器。
const nextTableNo = (model) => { model.__tblNo = (model.__tblNo || 0) + 1; return model.__tblNo }
function capTable(model, no, i, total, title) {
  const L = model.t || {}
  const en = model.lang === 'en'
  const seq = total > 1 ? `${no}-${i + 1}` : String(no)
  const cont = i > 0 ? (L.continued || (en ? '(continued)' : '（续）')) : ''
  return en ? `Table ${seq}  ${title}${cont ? ' ' + cont : ''}` : `${L.table || '表'} ${seq}　${title}${cont}`
}
function capFigure(model, linkNo, i, title) {
  const en = model.lang === 'en'
  return en ? `Figure ${linkNo}-${i + 1}  ${title}` : `${(model.t || {}).figure || '图'} ${linkNo}-${i + 1}　${title}`
}

async function buildReportDocx(model) {
  model.__tblNo = 0     // 表号从头数（同一份模型可能被反复渲染）
  const doc = new Document({
    creator: (model.doc && model.doc.org) || '',
    title: (model.doc && model.doc.title) || '',
    description: (model.scheme && model.scheme.label) || '',
    styles: {
      default: {
        document: { run: { font: FN, size: half(TPL.size.body) } }
      },
      paragraphStyles: paragraphStyles()
    },
    features: { updateFields: true },     // 打开时提示更新域 → 目录页码自动填
    // 封面 → 目录 → 总报告 → 逐链路详情。文档控制页（签署 / 变更记录 / 页数）2026-08-02 按用户要求去掉。
    sections: [
      coverSection(model),
      tocSection(model),
      masterTablesSection(model),
      masterTailSection(model),
      detailSection(model)
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildReportDocx }
