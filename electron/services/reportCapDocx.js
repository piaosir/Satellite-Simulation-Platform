// A short capacity brief: resource totals and link allocation from the existing
// snapshot, without a cover, contents, duplicate ledgers or formulas.
const { Document, Packer } = require('docx')
const { paragraphStyles, characterStyles, defaultStyles, P, docTable, logoHeader, pageFooter, sectPage } = require('./reportContractDocx')
const { buildCompactReport } = require('./reportCompact')

async function buildCapDocx(model) {
  const brief = buildCompactReport({ ...model, kind: 'cap' }), doc = model.doc || {}
  const children = [P(brief.title, 'Title', { spacing: { before: 0, after: 140 } })]
  for (let i = 0; i < brief.meta.length; i += 3) {
    children.push(P(brief.meta.slice(i, i + 3).map((r) => r.label + ': ' + r.value).join('　　'), 'RptNote', { spacing: { before: 0, after: 60, line: 240 } }))
  }
  for (const table of brief.tables) {
    children.push(P(table.title, 'RptH2', { spacing: { before: 100, after: 50, line: 260 } }))
    children.push(docTable(table.head, table.rows, { widths: table.widths, align: table.align, keyRows: table.groupRows }))
  }
  for (const note of brief.notes) children.push(P(note, 'RptNote', { spacing: { before: 60, after: 0, line: 240 } }))
  return Packer.toBuffer(new Document({
    creator: doc.org || '', title: brief.title, description: model.schemeText || '',
    styles: {
      default: defaultStyles(doc),
      paragraphStyles: paragraphStyles(doc), characterStyles: characterStyles(doc)
    },
    sections: [{ properties: sectPage(brief.landscape), headers: { default: logoHeader(doc.logo) }, footers: { default: pageFooter() }, children }]
  }))
}

module.exports = { buildCapDocx }
