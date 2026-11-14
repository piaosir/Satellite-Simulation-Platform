// Contract-style solution report. Keep all technical inputs and results while
// letting tables flow continuously, without cover/TOC pages or repeated essays.
const { Document, Packer, Paragraph, ImageRun, AlignmentType, TPL, half, paragraphStyles,
  characterStyles, runFonts, defaultStyles, P, docTable, sectPage, logoHeader, pageFooter } = require('./reportContractDocx')
const { buildReportPresentation } = require('./reportPresentation')
const { buildCompactReport } = require('./reportCompact')
const { pngSizeOf } = require('./reportDocxKit')
const S = (v) => v === null || v === undefined || v === '' ? '—' : String(v)

function inputTable(link, L) {
  const rows = [], groups = []
  for (const b of link.inputs || []) {
    if (!(b.rows || []).length) continue
    rows.push([b.title, '', '']); groups.push(true)
    for (const r of b.rows) { rows.push([r.label, S(r.value), r.unit || '']); groups.push(false) }
  }
  return rows.length ? [P(L.inputs, 'RptH2'), docTable([L.param, L.value, L.unit], rows,
    { widths: [53, 31, 16], align: ['left', 'right', 'left'], keyRows: groups, groupRows: groups })] : []
}
function segmentTable(seg, L) {
  const cols = seg.cols || 1
  const fallback = cols === 3 ? [L.uplink, L.downlink, L.total] : cols === 2 ? [L.uplink, L.downlink] : [L.value]
  const heads = Array.isArray(seg.heads) && seg.heads.length === cols ? seg.heads : fallback
  const rows = (seg.rows || []).map((r) => [(r.sign ? r.sign + ' ' : '') + (r.label || ''),
    ...['up', 'down', 'total'].slice(0, cols).map((k) => r[k] == null ? '' : String(r[k])), r.unit || ''])
  if (!rows.length) return []
  const keys = seg.rows.map((r) => ['head', 'shead', 'base', 'sub', 'chk', 'kpi', 'margin'].includes(r.kind))
  const groups = seg.rows.map((r) => ['head', 'shead'].includes(r.kind)), valueWidth = cols === 3 ? 15 : cols === 2 ? 21 : 30
  return [P((seg.no ? '§' + seg.no + ' ' : '') + (seg.title || ''), 'RptCaption'),
    docTable([L.param, ...heads, L.unit], rows, { widths: [100 - cols * valueWidth - 13, ...heads.map(() => valueWidth), 13],
      align: ['left', ...heads.map(() => 'right'), 'left'], keyRows: keys, groupRows: groups })]
}
async function overview(model) {
  const en = model.lang === 'en', L = model.t || {}, p = buildReportPresentation(model), d = model.doc || {}
  const out = [P(d.title || p.eyebrow, 'Title')]
  const meta = [[L.cvDocNo, d.docNo], [L.org, d.org], [L.date, d.date], [L.cvClass, d.classification]]
    .filter((r) => r[1]).map((r) => r[0] + '：' + r[1]).join('　　')
  if (meta) out.push(P(meta, 'RptNote'))
  out.push(P(en ? '1 Solution overview' : '一、方案概述', 'RptH1'), P(p.intro, 'RptBody'))
  if (p.facts.length) out.push(P(p.facts.map((r) => r.label + '：' + r.value).join('；'), 'RptNote'))
  const schedule = (model.links || []).map((l) => {
    const route = l.topology?.nodes?.length ? l.topology.nodes.map((n) => n.name).join(' → ') : [l.txName, l.rxName].map(S).join(' → ')
    const r = p.routes.find((r) => r.no === '#' + l.no)
    return ['#' + l.no, route, r?.carrier || '—', r?.margin || '—']
  })
  if (schedule.length) out.push(docTable([L.link, en ? 'Communications path' : '通信路径', en ? 'Carrier' : '载波', en ? 'Margin dB' : '余量 dB'], schedule,
    { widths: [8, 51, 25, 16], align: ['left', 'left', 'left', 'right'] }))
  const reference = require('./reportTopologyReference').topologyReference(model)
  if (reference) {
    const w = model.scheme?.orbitType === 'REGEN' ? 590 : 510, h = Math.round(w * reference.h / reference.w)
    out.push(new Paragraph({ style: 'RptFig', alignment: AlignmentType.CENTER, children: [new ImageRun({ type: reference.type || 'png', data: reference.data,
      transformation: { width: w, height: h }, altText: { title: reference.title, description: reference.caption, name: 'ReferenceTopology' } })] }),
    P(reference.caption, 'RptCaptionFig'))
  }
  const cascades = await require('./reportCascadeTopology').cascadeTopologyFigures(model)
  if (cascades.length) out.push(P(en ? 'Actual cascade topology' : '实际级联拓扑', 'RptH2'))
  for (const figure of cascades) {
    const w = 590, h = Math.round(w * figure.h / figure.w)
    out.push(new Paragraph({ style: 'RptFig', alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: figure.data,
      transformation: { width: w, height: h }, altText: { title: figure.title, description: figure.caption, name: `CascadeTopology-${figure.linkNo}-${figure.part}` } })] }),
    P(figure.caption, 'RptCaptionFig'))
  }
  out.push(P(en ? '2 Key link results' : '二、链路主要结果', 'RptH1'))
  const sections = model.sections?.length > 1 ? model.sections : [{ summary: model.summary, title: '' }]
  for (const [si, section] of sections.entries()) {
    const links = model.sections?.length > 1 ? (model.links || []).filter((l) => l.sec === si) : model.links || []
    if (section.title) out.push(P(section.title, 'RptH2'))
    for (let from = 0; from < links.length; from += 4) {
      const part = links.slice(from, from + 4), metrics = (section.summary || {}).metrics || []
      if (metrics.length) out.push(docTable([L.param, ...part.map((l) => '#' + l.no)], metrics.map((r) => [r.label, ...r.values.slice(from, from + part.length)]),
        { widths: [44, ...part.map(() => 56 / part.length)], align: ['left', ...part.map(() => 'right')] }))
    }
    const cap = (section.summary || {}).cap
    if (cap?.head?.length && cap.rows?.length) out.push(P(L.capacity, 'RptH2'), docTable(cap.head, cap.rows,
      { widths: [36, ...cap.head.slice(1).map(() => 64 / (cap.head.length - 1))] }))
  }
  if (model.hasSla) for (const t of buildCompactReport({ ...model, kind: 'sla' }).tables) out.push(P(t.title, 'RptH2'),
    docTable(t.head, t.rows, { widths: t.widths, align: t.align, keyRows: t.groupRows, groupRows: t.groupRows }))
  return out
}
async function buildReportDocx(model) {
  const en = model.lang === 'en', L = model.t || {}, children = await overview(model)
  children.push(P(en ? '3 Detailed link budgets' : '三、详细链路预算', 'RptH1'))
  for (const l of model.links || []) {
    children.push(P('#' + l.no + ' ' + [l.txName, l.rxName].map(S).join(' → '), 'RptH2'))
    if (l.error || !l.data) { children.push(P(l.error || L.noResult, 'RptNote')); continue }
    children.push(...inputTable(l, L), P(L.results, 'RptH2'))
    for (const seg of l.segments || []) children.push(...segmentTable(seg, L))
    for (const f of l.figures || []) {
      if (!f.dataUrl) continue
      const size = pngSizeOf(f.dataUrl)
      if (!size?.w || !size?.h) continue
      const k = Math.min(540 / size.w, 230 / size.h)
      children.push(new Paragraph({ style: 'RptFig', children: [new ImageRun({ type: 'png', data: Buffer.from(f.dataUrl.split(',').pop(), 'base64'),
        transformation: { width: Math.round(size.w * k), height: Math.round(size.h * k) } })] }), P(f.title, 'RptCaptionFig'))
    }
  }
  const ids = (model.method?.refGroups || []).flatMap((g) => (g.items || []).map((r) => r.id))
  if (ids.length) children.push(P((en ? 'Calculation references: ' : '计算依据：') + [...new Set(ids)].join('；'), 'RptNote'))
  const doc = new Document({ creator: model.doc?.org || '', title: model.doc?.title || '',
    styles: { default: defaultStyles(model.doc),
      paragraphStyles: paragraphStyles(model.doc), characterStyles: characterStyles(model.doc) },
    sections: [{ properties: sectPage(false), headers: { default: logoHeader(model.doc?.logo) }, footers: { default: pageFooter() }, children }] })
  return Packer.toBuffer(doc)
}
module.exports = { buildReportDocx }
