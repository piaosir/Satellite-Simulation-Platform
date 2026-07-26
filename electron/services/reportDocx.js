// 链路预算报告的 Word 出口（.docx，主进程）。
//
// 版式照用户给的《文档格式模板（公开）.docx》——中国卫通标准公文格式：
//   封面（名称/单位/编写/校对/审核/批准 + 编号/阶段/密级/页数 + 公司名）
//   → 文档控制（变更记录）→ 目录（Word 域，打开时自动生成页码）→ 正文（五级标题 + 正文/题注/表格样式）
// 各样式的字号、字体、间距、缩进、表格边框与表头底纹全部取自 reportStyle.js（那里注了模板原值）。
// 字体：西文与数字 Times New Roman，中文标题黑体、中文正文宋体（模板本身即此口径）。
//
// 与 PDF 的分工：PDF 的逐链路详情是屏幕排版的复刻（级联表 ‖ 图 两栏），Word 是流式文档，
// 故详情章按「级联主表 → 图 → 参考段各表」顺排。数字、题注编号、章节号三处一致。
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, TableOfContents,
  Footer, PageNumber, AlignmentType, WidthType, BorderStyle, VerticalAlign, ImageRun,
  SimpleField, PageOrientation, LineRuleType, ShadingType
} = require('docx')
const { TPL, half } = require('./reportStyle')

const FN = { ascii: TPL.font.latin, hAnsi: TPL.font.latin, cs: TPL.font.latin, eastAsia: TPL.font.cjkBody }
const FN_H = { ascii: TPL.font.latin, hAnsi: TPL.font.latin, cs: TPL.font.latin, eastAsia: TPL.font.cjkHeading }

// —— 样式表（id 前缀 Rpt/Cv，避免与模板自带的 C503-* 撞名）——
function paragraphStyles() {
  const line = { line: 360, lineRule: LineRuleType.AUTO }   // 模板：1.5 倍行距
  const head = (id, name, size, outline, before, after) => ({
    id, name, basedOn: 'Normal', next: 'RptBody', quickFormat: true,
    run: { size: half(size), bold: true, font: FN_H },
    paragraph: { spacing: Object.assign({ before, after }, line), keepNext: true, outlineLevel: outline }
  })
  return [
    { id: 'RptTitle', name: 'Report Title', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.docTitle), bold: true, font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: Object.assign({ after: 240 }, line) } },
    head('RptH1', 'Report Heading 1', TPL.size.h1, 0, TPL.spacing.h1BeforeTw, TPL.spacing.h1AfterTw),
    head('RptH2', 'Report Heading 2', TPL.size.h2, 1, TPL.spacing.hBeforeTw, TPL.spacing.hAfterTw),
    head('RptH3', 'Report Heading 3', TPL.size.h3, 2, TPL.spacing.hBeforeTw, TPL.spacing.hAfterTw),
    head('RptH4', 'Report Heading 4', TPL.size.h4, 3, TPL.spacing.hBeforeTw, TPL.spacing.hAfterTw),
    // 正文：模板 CSPC-正文格式（小四、1.5 倍行距、首行缩进 2 字符）
    { id: 'RptBody', name: 'Report Body', basedOn: 'Normal', next: 'RptBody', quickFormat: true,
      run: { size: half(TPL.size.body), font: FN },
      paragraph: { spacing: line, indent: { firstLine: TPL.spacing.bodyFirstLineTw }, alignment: AlignmentType.BOTH } },
    // 说明性文字：同正文但不缩进（表下注释、方法学脚注）
    { id: 'RptNote', name: 'Report Note', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.caption), font: FN, color: '595959' },
      paragraph: { spacing: { line: 300, lineRule: LineRuleType.AUTO, after: 60 }, alignment: AlignmentType.BOTH } },
    // 题注：模板 caption（加粗居中黑体，前后 10 行距）
    { id: 'RptCaption', name: 'Report Caption', basedOn: 'Normal', next: 'RptBody',
      run: { size: half(TPL.size.caption), bold: true, font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: TPL.spacing.captionBeforeTw, after: TPL.spacing.captionAfterTw }, keepNext: true } },
    { id: 'RptFig', name: 'Report Figure', basedOn: 'Normal', next: 'RptCaption',
      paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 60, after: 0 }, keepNext: true } },
    // 表格文字：模板正文表格（10.5pt，单倍行距，不缩进）
    { id: 'RptTd', name: 'Report Table Cell', basedOn: 'Normal', next: 'RptTd',
      run: { size: half(TPL.size.table), font: FN },
      paragraph: { spacing: { line: 240, lineRule: LineRuleType.AUTO }, alignment: AlignmentType.LEFT } },
    { id: 'RptTh', name: 'Report Table Head', basedOn: 'RptTd', next: 'RptTd',
      run: { size: half(TPL.size.table), bold: true, font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER } },
    // 密排表（级联/瀑布：四十余行逐行可手算，降一档字号、行距压紧）
    { id: 'RptTdS', name: 'Report Table Cell Small', basedOn: 'Normal', next: 'RptTdS',
      run: { size: half(TPL.size.tableDense), font: FN },
      paragraph: { spacing: { line: 200, lineRule: LineRuleType.AUTO } } },
    { id: 'RptThS', name: 'Report Table Head Small', basedOn: 'RptTdS', next: 'RptTdS',
      run: { size: half(TPL.size.tableDense), bold: true, font: FN_H },
      paragraph: { alignment: AlignmentType.CENTER, spacing: { line: 200, lineRule: LineRuleType.AUTO } } },
    // 封面各栏（模板 C503-* 系列）
    { id: 'CvName', name: 'Cover Name', basedOn: 'Normal',
      run: { size: half(TPL.size.coverName), bold: true, font: FN },
      paragraph: { alignment: AlignmentType.LEFT, spacing: Object.assign({}, line) } },
    { id: 'CvLabel', name: 'Cover Label', basedOn: 'Normal',
      run: { size: half(TPL.size.coverLabel), bold: true, font: FN },
      paragraph: { alignment: AlignmentType.CENTER, spacing: Object.assign({}, line) } },
    { id: 'CvValue', name: 'Cover Value', basedOn: 'Normal',
      run: { size: half(TPL.size.coverValue), font: FN },
      paragraph: { alignment: AlignmentType.CENTER, spacing: Object.assign({}, line) } },
    { id: 'CvMeta', name: 'Cover Meta', basedOn: 'Normal',
      run: { size: half(TPL.size.coverMeta), font: FN },
      paragraph: { alignment: AlignmentType.CENTER, spacing: Object.assign({}, line) } },
    { id: 'CvOrg', name: 'Cover Org', basedOn: 'Normal',
      run: { size: half(TPL.size.coverOrg), bold: true, font: FN },
      paragraph: { alignment: AlignmentType.CENTER } }
  ]
}

// —— 段落 / 单元格辅助 ——
const P = (text, style, opts) => new Paragraph(Object.assign({
  style, children: [new TextRun({ text: text == null ? '' : String(text) })]
}, opts || {}))
const empty = (style) => new Paragraph({ style: style || 'RptTd', children: [] })

const B = (sz, color) => ({ style: BorderStyle.SINGLE, size: sz, color: color || 'auto' })
const GRID = (sz) => ({ top: B(sz), bottom: B(sz), left: B(sz), right: B(sz) })
const NONE = { style: BorderStyle.NONE, size: 0, color: 'auto' }

// 文档类表格（模板正文表：全边框 0.5pt、表头灰底加粗居中）
function docTable(head, rows, opts) {
  opts = opts || {}
  const sz = TPL.table.borderSz
  const dense = !!opts.dense
  const tdStyle = dense ? 'RptTdS' : 'RptTd'
  const thStyle = dense ? 'RptThS' : 'RptTh'
  const align = opts.align || []
  const cell = (text, i, isHead) => new TableCell({
    width: opts.widths ? { size: opts.widths[i], type: WidthType.PERCENTAGE } : undefined,
    shading: isHead ? { type: ShadingType.CLEAR, color: 'auto', fill: TPL.table.headFill } : undefined,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 20, bottom: 20, left: 60, right: 60 },
    children: [new Paragraph({
      style: isHead ? thStyle : tdStyle,
      alignment: isHead ? AlignmentType.CENTER : (align[i] === 'right' ? AlignmentType.RIGHT : align[i] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT),
      children: [new TextRun({ text: text == null ? '' : String(text), bold: isHead || undefined })]
    })]
  })
  const trs = []
  if (head && head.length) trs.push(new TableRow({ tableHeader: true, children: head.map((h, i) => cell(h, i, true)) }))
  for (const r of rows) trs.push(new TableRow({ children: r.map((v, i) => cell(v, i, false)) }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: GRID(sz),
    rows: trs
  })
}

// 计算结果表（三线表：题注下顶线、列头下栏目线、段末底线；无竖线无底色）
// —— 用户此前定下的口径：密排的逐行手算单靠线的层级差分层，加满网格与灰底会压成一堵墙。
function bookTable(head, rows, opts) {
  opts = opts || {}
  const align = opts.align || []
  const strong = TPL.rule.strongSz, thin = TPL.rule.thinSz
  const mk = (text, i, o) => new TableCell({
    width: opts.widths ? { size: opts.widths[i], type: WidthType.PERCENTAGE } : undefined,
    borders: {
      top: o.top ? B(o.top) : NONE, bottom: o.bottom ? B(o.bottom) : NONE, left: NONE, right: NONE
    },
    margins: { top: 10, bottom: 10, left: 40, right: 40 },
    children: [new Paragraph({
      style: o.head ? 'RptThS' : 'RptTdS',
      alignment: o.head ? (i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT)
        : (align[i] === 'right' ? AlignmentType.RIGHT : align[i] === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT),
      children: [new TextRun({ text: text == null ? '' : String(text), bold: (o.head || o.bold) || undefined })]
    })]
  })
  const trs = []
  if (head && head.length) trs.push(new TableRow({ tableHeader: true, children: head.map((h, i) => mk(h, i, { head: true, top: strong, bottom: thin })) }))
  rows.forEach((r, ri) => {
    const last = ri === rows.length - 1
    const bold = !!(opts.boldRows && opts.boldRows[ri])
    const sep = !!(opts.sepRows && opts.sepRows[ri])
    trs.push(new TableRow({ children: r.map((v, i) => mk(v, i, { bottom: last ? strong : 0, top: sep ? thin : 0, bold })) }))
  })
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: {
    top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE
  }, rows: trs })
}

// 键值表（报告信息 / 场景与假设）：模板里这类是两列全边框表
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
    new Paragraph({ style: 'RptFig', children: [new ImageRun({ data, type: 'png', transformation: { width: w, height: h } })] }),
    P(caption, 'RptCaption')
  ]
}

// —— 页脚：模板 footer 只有一个居中页码域 ——
const pageFooter = () => new Footer({
  children: [new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ font: FN, size: half(TPL.size.caption), children: [PageNumber.CURRENT] })]
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

// 封面：照模板逐组还原（位置量自模板第一节的浮动表，见 reportStyle.js 的 TPL.cover）。
//   外框 1.5pt ─┬ 右上：编 号 / 阶 段 / 密 级 / 页 数（标签无框、值压下划线）
//               ├ 上中：名 称（18pt 加粗居中，两条下划线：报告名 / 项目名）
//               ├ 中部：单 位 / 编 写 / 校 对 / 审 核 / 批 准（15pt 标签 + 12pt 值压下划线）
//               └ 底部：公司名（22pt 加粗居中）
//   左页边距另有一条「会 签」栏（模板是 VML 文本框，此处用浮动表落在页左侧）。
// 单位 / 公司名 / 签署人全部来自用户填写 —— 软件不预设任何单位名。
function coverSection(model) {
  const d = model.doc || {}
  const L = model.t || {}
  const C = TPL.cover
  const sz = TPL.table.borderSz
  const noB = { top: NONE, bottom: NONE, left: NONE, right: NONE }
  const underline = { top: NONE, bottom: B(sz), left: NONE, right: NONE }
  const cellT = (children, w, borders) => new TableCell({
    width: { size: w, type: WidthType.DXA }, borders: borders || noB,
    verticalAlign: VerticalAlign.BOTTOM, children
  })
  const row2 = (label, labelStyle, value, valueStyle, widths, h) => new TableRow({
    height: { value: h, rule: 'atLeast' },
    children: [cellT([P(label, labelStyle)], widths[0]), cellT([P(value, valueStyle)], widths[1], underline)]
  })
  // 浮动表：与模板同样锚在页面上（横向居中 / 右对齐 + 绝对纵坐标）
  const floatTbl = (rows, widths, float) => new Table({
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE },
    float: Object.assign({ horizontalAnchor: 'margin', verticalAnchor: 'page', overlap: 'never', leftFromText: 180, rightFromText: 180 }, float),
    rows
  })

  // ① 右上：编号 / 阶段 / 密级 / 页数（页数是 NUMPAGES 域，Word 打开时自己算）
  const metaTbl = floatTbl([
    row2(L.cvDocNo, 'CvMeta', d.docNo || '', 'CvMeta', C.metaWTw, 540),
    row2(L.cvStage, 'CvMeta', d.stage || '', 'CvMeta', C.metaWTw, 540),
    row2(L.cvClass, 'CvMeta', d.classification || '', 'CvMeta', C.metaWTw, 540),
    new TableRow({
      height: { value: 540, rule: 'atLeast' },
      children: [
        cellT([P(L.cvPages, 'CvMeta')], C.metaWTw[0]),
        cellT([new Paragraph({ style: 'CvMeta', alignment: AlignmentType.CENTER, children: [new SimpleField('NUMPAGES')] })], C.metaWTw[1], underline)
      ]
    })
  ], C.metaWTw, { absoluteVerticalPosition: C.metaYTw, relativeHorizontalPosition: 'right' })

  // ② 名称：两条下划线（第一行报告名、第二行项目名——模板同款两行）
  const nameTbl = floatTbl([
    row2(L.cvName, 'CvLabel', d.title || '', 'CvName', C.nameWTw, 811),
    row2('', 'CvLabel', d.project || '', 'CvName', C.nameWTw, 811)
  ], C.nameWTw, { absoluteVerticalPosition: C.nameYTw, relativeHorizontalPosition: 'center' })

  // ③ 单位 / 编写 / 校对 / 审核 / 批准
  const signTbl = floatTbl([
    row2(L.cvDept, 'CvLabel', d.org || '', 'CvValue', C.signWTw, 890),
    row2(L.cvPrepared, 'CvLabel', d.preparedBy || '', 'CvValue', C.signWTw, 890),
    row2(L.cvChecked, 'CvLabel', d.checkedBy || '', 'CvValue', C.signWTw, 890),
    row2(L.cvApproved, 'CvLabel', d.approvedBy || '', 'CvValue', C.signWTw, 890),
    row2(L.cvRatified, 'CvLabel', d.ratifiedBy || '', 'CvValue', C.signWTw, 890)
  ], C.signWTw, { absoluteVerticalPosition: C.signYTw, relativeHorizontalPosition: 'center' })

  // ④ 左页边距的「会 签」栏：标签 + 若干空格，供落笔会签
  const hqW = 760
  const hqTbl = new Table({
    columnWidths: [hqW],
    width: { size: hqW, type: WidthType.DXA },
    borders: GRID(sz),
    float: {
      horizontalAnchor: 'page', verticalAnchor: 'page', overlap: 'never',
      absoluteHorizontalPosition: C.hqXTw, absoluteVerticalPosition: C.hqYTw
    },
    rows: Array.from({ length: C.hqRows }, () => new TableRow({
      height: { value: 700, rule: 'atLeast' },
      children: [new TableCell({ width: { size: hqW, type: WidthType.DXA }, borders: GRID(sz), children: [empty('CvValue')] })]
    }))
  })

  // 外框：模板是一张 9574×13674 的单格表；Word 里用等效的页面边框（1.5pt 四边）。
  // ★ borders 必须挂在 properties.page 下（docx 的 SectionProperties 从 page 里取它），
  //   挂在 properties 顶层会被静默忽略——踩过一次，pgBorders 压根不出现在 XML 里。
  const coverProps = sectPage(false)
  // offsetFrom:'text' + space 24pt：框线落在版心外 0.85cm 处，与模板那张比版心宽约 1cm 的框位置相当
  //（offsetFrom:'page' 的 space 上限只有 31pt，够不到模板那 2cm，反而离纸边太近）
  const edge = { style: BorderStyle.SINGLE, size: C.frameSz, color: 'auto', space: 24 }
  coverProps.page.borders = {
    pageBorders: { display: 'allPages', offsetFrom: 'text', zOrder: 'front' },
    pageBorderTop: edge, pageBorderBottom: edge, pageBorderLeft: edge, pageBorderRight: edge
  }
  return {
    properties: coverProps,
    children: [
      metaTbl, nameTbl, signTbl, hqTbl,
      // 会签标签（挨着左侧那条栏），随后留白到底部落公司名与日期
      new Paragraph({ style: 'CvValue', alignment: AlignmentType.LEFT, children: [new TextRun({ text: L.hqSign, bold: true })] }),
      new Paragraph({ style: 'CvOrg', spacing: { before: 6200 }, children: [new TextRun({ text: d.company || '' })] }),
      P(d.date || '', 'CvValue')
    ]
  }
}

// 文档控制（变更记录）：模板里这一页是外框 1.5pt、内线 0.75pt 的表
function controlSection(model) {
  const d = model.doc || {}
  const L = model.t || {}
  const head = [L.chgVer || '版本号', L.chgDate || '日期', L.chgAuthor || '作者',
    L.chgWhere || '段落、图或表', L.chgKind || '增加/修改/删除', L.chgDesc || '简单描述', L.chgReq || '更改申请单号']
  const rows = [[d.appVersion || '', d.date || '', d.preparedBy || '', '—', L.chgAdd || '增加', L.chgCreate || '创建文档', '—']]
  const t = docTable(head, rows, { widths: [10, 13, 10, 17, 16, 20, 14], align: ['center', 'center', 'center', 'left', 'center', 'left', 'center'] })
  return {
    properties: sectPage(false, { start: 1, formatType: 'upperRoman' }),
    footers: { default: pageFooter() },
    children: [P(L.docControl || '文档控制', 'RptTitle'), P(L.changeLog || '变更记录', 'RptH2'), t]
  }
}

function tocSection(model) {
  const L = model.t || {}
  return {
    properties: sectPage(false, { formatType: 'upperRoman' }),
    footers: { default: pageFooter() },
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
  lchunks.forEach((ck, ci) => {
    children.push(P(capTable(model, 1, ci, lchunks.length, L.compare), 'RptCaption'))
    const head = [L.param, ...ck.items.map((l) => '#' + l.no + '　' + (l.txName || '') + ' → ' + (l.rxName || ''))]
    const rows = sum.metrics.map((m) => [m.label, ...ck.items.map((l, i) => fmtVal(m.values[ck.from + i]))])
    const rest = Math.floor(66 / ck.items.length)
    children.push(docTable(head, rows, {
      dense: true, widths: [34, ...ck.items.map(() => rest)],
      align: ['left', ...ck.items.map(() => 'right')]
    }))
  })
  return { properties: sectPage(true, { start: 1, formatType: 'decimal' }), footers: { default: pageFooter() }, children }
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
  children.push(P(capTable(model, 2, 0, 1, L.mRefs), 'RptCaption'))
  const refRows = []
  for (const g of m.refGroups) {
    refRows.push([g.group, '', ''])
    for (const r of g.items) refRows.push([r.id, r.title, r.use])
  }
  children.push(docTable([L.mId, L.mTitle, L.mUse], refRows, { widths: [26, 38, 36] }))
  children.push(P('3.3　' + L.mConst, 'RptH3'))
  children.push(P(capTable(model, 3, 0, 1, L.mConst), 'RptCaption'))
  children.push(docTable([L.param, L.mSymbol, L.mValue, L.unit, L.mSrc],
    m.constants.map((c) => [c.name, c.symbol, c.value, c.unit, c.src]),
    { widths: [30, 12, 20, 14, 24], align: ['left', 'center', 'right', 'left', 'left'] }))
  return { properties: sectPage(false), footers: { default: pageFooter() }, children }
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
      for (const blk of l.inputs) {
        children.push(P(blk.title, 'RptCaption'))
        children.push(docTable([L.param, L.value, L.unit], blk.rows.map((r) => [r.label, r.value, r.unit]),
          { dense: true, widths: [56, 26, 18], align: ['left', 'right', 'left'] }))
      }
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
  return { properties: sectPage(true), footers: { default: pageFooter() }, children }
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
  const strongKind = ['base', 'sub', 'chk', 'kpi', 'margin']
  const rows = seg.rows.map((r) => {
    const vals = cols >= 3 ? [r.up, r.down, r.total] : cols >= 2 ? [r.up, r.down] : [r.up]
    return [(r.sign ? r.sign + ' ' : '') + (r.label || ''), ...vals.map((v) => (v == null ? '' : String(v))), r.unit || '']
  })
  const boldRows = seg.rows.map((r) => strongKind.indexOf(r.kind) > -1)
  const sepRows = seg.rows.map((r) => ['sub', 'margin'].indexOf(r.kind) > -1)
  const n = head.length
  const vw = Math.floor(44 / (n - 2))
  return [
    P((seg.no ? '§' + seg.no + '　' : '') + (seg.title || ''), 'RptCaption'),
    bookTable(head, rows, {
      boldRows, sepRows,
      widths: [46, ...heads.map(() => vw), 10],
      align: ['left', ...heads.map(() => 'right'), 'left']
    })
  ]
}

// —— 小工具 ——
function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date()
  return isNaN(d.getTime()) ? '' : d.toLocaleString()
}
const fmtVal = (v) => (v == null || v === '' ? '—' : String(v))
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
  const doc = new Document({
    creator: (model.doc && model.doc.company) || (model.doc && model.doc.org) || '',
    title: (model.doc && model.doc.title) || '',
    description: (model.doc && model.doc.project) || '',
    styles: {
      default: {
        document: { run: { font: FN, size: half(TPL.size.body) } }
      },
      paragraphStyles: paragraphStyles()
    },
    features: { updateFields: true },     // 打开时提示更新域 → 目录页码自动填
    sections: [
      coverSection(model),
      controlSection(model),
      tocSection(model),
      masterTablesSection(model),
      masterTailSection(model),
      detailSection(model)
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildReportDocx }
