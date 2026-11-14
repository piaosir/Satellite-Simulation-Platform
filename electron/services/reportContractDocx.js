// Link-report-only Word style, measured from the user's retained service
// contract. Do not change the shared SSA/grid/document template to style these
// reports. The source contract's parties, commercial terms and data are absent.
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, Header, Footer, ImageRun,
  PageNumber, AlignmentType, WidthType, BorderStyle, VerticalAlign, PageOrientation, TableLayoutType, LineRuleType } = require('docx')
const { TPL: BASE, half, fontsOf } = require('./reportStyle')
const TPL = { ...BASE, page: { widthTw: 11906, heightTw: 16838, contentTw: 9072,
  marginTw: { top: 1417, bottom: 1417, left: 1417, right: 1417, header: 851, footer: 992 } },
  size: { ...BASE.size, docTitle: 18, body: 12, table: 10.5, tableDense: 10, caption: 10.5 },
  title: { latin: 'Times New Roman', cjk: '宋体', size: 18, bold: true } }
function runFonts(doc) {
  const f = fontsOf(doc), custom = doc && doc.fonts
  const fn = { ascii: f.latin, hAnsi: f.latin, cs: f.latin, eastAsia: f.cjkBody }
  return { FN: fn, FN_H: { ...fn, eastAsia: custom?.cjkHeading || '宋体' } }
}
const titleStyle = {
  run: { font: { ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: '宋体' }, size: 36, bold: true, color: '000000' },
  paragraph: { alignment: AlignmentType.CENTER, indent: { firstLine: 0 }, spacing: { before: 60, after: 180, line: 280 }, keepNext: true }
}
const defaultStyles = (doc) => ({ document: { run: { font: runFonts(doc).FN, size: 24 } }, title: titleStyle })
function paragraphStyles(doc) {
  const { FN, FN_H } = runFonts(doc)
  const body = { indent: { firstLine: 480 }, spacing: { line: 360, after: 60 }, alignment: AlignmentType.BOTH }
  const heading = (id, size, outline) => ({ id, name: id, basedOn: 'Normal', next: 'RptBody',
    run: { font: FN_H, size: half(size), bold: true, color: '000000' },
    paragraph: { indent: { firstLine: 0 }, spacing: { before: 120, after: 60, line: 240 }, keepNext: true, outlineLevel: outline } })
  return [
    heading('RptH1', 12, 0), heading('RptH2', 12, 1), heading('RptH3', 11, 2), heading('RptH4', 10.5, 3),
    { id: 'RptBody', name: 'Report Body', basedOn: 'Normal', paragraph: body },
    { id: 'RptNote', name: 'Report Note', basedOn: 'Normal', run: { font: FN, size: 20 },
      paragraph: { indent: { firstLine: 0 }, spacing: { line: 240, after: 60 }, alignment: AlignmentType.LEFT } },
    { id: 'RptCaption', name: 'Report Caption', basedOn: 'RptNote', run: { font: FN_H, size: 21, bold: true },
      paragraph: { alignment: AlignmentType.LEFT, indent: { firstLine: 0 }, spacing: { before: 90, after: 30, line: 240 }, keepNext: true } },
    { id: 'RptCaptionFig', name: 'Report Figure Caption', basedOn: 'RptNote', paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 30, after: 90, line: 240 } } },
    { id: 'RptFig', name: 'Report Figure', basedOn: 'RptNote', paragraph: { alignment: AlignmentType.CENTER, spacing: { before: 30, after: 0 }, keepNext: true } },
    ...['RptTd', 'RptTh', 'RptTdS', 'RptThS'].map((id) => ({ id, name: id, basedOn: 'Normal',
      run: { font: id.includes('Th') ? FN_H : FN, size: 21, bold: id.includes('Th') },
      paragraph: { indent: { firstLine: 0 }, spacing: { before: 20, after: 20, line: 240 }, alignment: AlignmentType.LEFT } }))
  ]
}
const characterStyles = (doc) => [{ id: 'RptKey', name: 'Report Key Run', run: { font: runFonts(doc).FN_H, bold: true } }]
const P = (text, style = 'RptBody', opts = {}) => new Paragraph({ style, children: [new TextRun(String(text ?? ''))], ...opts })
const align = (v) => v === 'right' ? AlignmentType.RIGHT : v === 'center' ? AlignmentType.CENTER : AlignmentType.LEFT
function docTable(head, rows, opts = {}) {
  const widths = opts.widths || (head || rows[0] || []).map(() => 100 / (head || rows[0]).length)
  const border = { style: BorderStyle.SINGLE, size: 4, color: '000000' }
  const make = (values, header, index) => new TableRow({ tableHeader: header, cantSplit: true, children: values.map((v, i) => new TableCell({
    width: { size: widths[i], type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER,
    borders: { top: border, bottom: border, left: border, right: border },
    margins: { top: 20, bottom: 20, left: 70, right: 70 },
    shading: { fill: header ? 'D9D9D9' : 'FFFFFF' },
    children: [new Paragraph({ style: header ? 'RptTh' : 'RptTd', alignment: align(opts.align?.[i]),
      spacing: { before: 0, after: 0, line: 240, lineRule: LineRuleType.AUTO },
      keepNext: header || !!opts.groupRows?.[index] || ((opts.keepTogether || index >= rows.length - 3) && index < rows.length - 1),
      children: [new TextRun({ text: v == null ? '' : String(v), style: opts.keyRows?.[index] ? 'RptKey' : undefined })] })]
  })) })
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, layout: TableLayoutType.FIXED,
    columnWidths: widths.map((w) => Math.round(TPL.page.contentTw * w / 100)),
    rows: [...(head?.length ? [make(head, true, -1)] : []), ...rows.map((r, i) => make(r, false, i))] })
}
const sectPage = (landscape = false, pageNumbers) => ({ page: { size: { orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
  width: TPL.page.widthTw, height: TPL.page.heightTw }, margin: TPL.page.marginTw, pageNumbers } })
function logoHeader(logo) {
  const image = require('./reportLogoImage').fitLogo(logo, 151, 30)
  return new Header({ children: [new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: 0, line: 240 },
    children: image ? [new ImageRun({ type: 'png', data: image.data, transformation: { width: image.width, height: image.height } })] : [] })] })
}
const pageFooter = () => new Footer({ children: [new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ size: 18, children: [PageNumber.CURRENT] })] })] })
module.exports = { Document, Packer, Paragraph, TextRun, ImageRun, AlignmentType, TPL, half, runFonts, defaultStyles, paragraphStyles, characterStyles,
  P, docTable, bookTable: docTable, kvTable: (rows) => docTable(null, rows, { widths: [28, 72] }), sectPage, logoHeader, pageFooter }
