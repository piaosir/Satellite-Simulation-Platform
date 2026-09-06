// 链路预算报告 Word 出口的【通用排版件】：样式表、三线表、图与页眉页脚、封面与目录。
//
// 从 reportDocx.js 原样搬出来的（2026-09-06，零行为改动：抽取前后 out.docx 解出的
// word/document.xml 与 word/styles.xml 字节相同）。搬的理由是第二个 Word 出口 ——
// 独立的《服务等级指标（SLA）》报告（reportSlaDocx.js）—— 要用同一套版式，
// 照抄一份必然漂移（改一处忘一处），而这些件本身与「报告里印什么」无关。
//
// 版式口径（模板《技术文档标准模板.docx》）全部注在 reportStyle.js 与各函数头上，此处不再重复。
// ★ tocSection 的条目由调用方传入：两份报告的章节各不相同，目录该逐条对应【它自己】正文里
//   真正出现的 H1 / H2。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
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
    // 目录两级：一级（总报告 / 链路详情）黑体不缩进，二级缩进两字符走正文体
    { id: 'RptToc1', name: 'Report TOC 1', basedOn: 'Normal', next: 'RptToc1',
      run: { size: half(TPL.size.body), font: FN_H },
      paragraph: { spacing: { before: 120, after: 20, line: 300, lineRule: LineRuleType.AUTO }, indent: { firstLine: 0 } } },
    { id: 'RptToc2', name: 'Report TOC 2', basedOn: 'RptToc1', next: 'RptToc2',
      run: { size: half(TPL.size.body), font: FN },
      paragraph: { spacing: { before: 0, after: 20, line: 300, lineRule: LineRuleType.AUTO }, indent: { left: 480, firstLine: 0 } } },
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
// 目录页。★ 这里是【静态排版】，不是 Word 的 TOC 域：域在文档打开时是空的，要用户自己
// 右键「更新域」才填得出来 —— 没人会去点，交付出去的报告目录就是一整页空白。
// 页码不给：生成时不知道分页，写一个错的页码比不写更糟。
function tocSection(model, items) {
  const L = model.t || {}
  return {
    properties: sectPage(false, { start: 1, formatType: 'upperRoman' }),
    headers: { default: logoHeader((model.doc || {}).logo) }, footers: { default: pageFooter() },
    children: [
      P(L.contents || '目 录', 'RptTitle'),
      ...(items || []).map((it) => P((it.n ? it.n + '　' : '') + it.t, it.sub ? 'RptToc2' : 'RptToc1'))
    ]
  }
}
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
module.exports = {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, PageNumber, AlignmentType, WidthType, BorderStyle, VerticalAlign, ImageRun,
  PageOrientation, LineRuleType, TPL, half,
  FN, FN_H, paragraphStyles, P, B, NONE, docTable, bookTable, kvTable,
  pngSizeOf, figureParagraphs, logoHeader, pageFooter, sectPage, contentPx,
  coverSection, tocSection, nextTableNo, capTable
}
