// 链路预算报告的 Word 出口（.docx，主进程）。
//
// 版式照用户给的《技术文档标准模板.docx》：
//   封面（密级 / 文档编号 → 文档标题 / 副标题 → 编制单位 / 成文日期，右上角可贴 logo）
//   → 文档控制（签署 + 变更记录）→ 目录（静态排版，见 tocSection 头注）
//   → 正文（四级标题 + 正文 / 图号表号格式 / 三线表）
// 各样式的字号、字体、间距、缩进与表格边框全部取自 reportStyle.js（那里注了模板原值）。
// 字体：西文与数字 Times New Roman，中文标题与题注黑体、中文正文宋体（模板本身即此口径）。
// 表格一律三线表：顶线/底线 1.5 磅、栏目线 0.75 磅，无竖线、无底纹（模板「三线表」样式）。
//
// 与 PDF 的分工：PDF 的逐链路详情是屏幕排版的复刻（级联表 ‖ 图 两栏），Word 是流式文档，
// 故详情章按「级联主表 → 图 → 参考段各表」顺排。数字、题注编号、章节号三处一致。
const { Document, Packer, Paragraph, TextRun } = require('docx')
const { TPL, half } = require('./reportStyle')
// 通用排版件（样式表 / 三线表 / 图与页眉页脚 / 封面与目录 / 表号）都在 kit 里，
// 与《服务等级指标（SLA）》那份报告共用同一套 —— 见 reportDocxKit.js 头注。
const {
  FN, paragraphStyles, P, docTable, bookTable, kvTable,
  figureParagraphs, logoHeader, pageFooter, sectPage, contentPx,
  coverSection, tocSection, nextTableNo, capTable
} = require('./reportDocxKit')

// ============================ 正文装配 ============================

// 目录条目：逐条对应下面正文里真正出现的 H1 / H2（章号的跳号也照抄 —— 没有容量统计时
// 正文本就是 1、3、4）。
function tocItems(model) {
  const L = model.t || {}
  const sum = model.summary || { stats: [] }
  const items = [{ t: L.master }, { n: '1', t: L.compare, sub: true }]
  if (sum.stats && sum.stats.length) items.push({ n: '2', t: L.capacity, sub: true })
  items.push({ n: '3', t: L.refs, sub: true })
  if (model.hasSla) items.push({ n: '4', t: L.sla, sub: true })
  items.push({ t: L.detail })
  for (const l of (model.links || [])) {
    items.push({ n: '#' + l.no, t: (l.txName || '') + ' → ' + (l.rxName || ''), sub: true })
  }
  return items
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
  // SLA 建议（§4）：条款（含单位）做行、链路做列，格里是采用值（留空即建议值）。
  // 没有任何链路带 sla ⇒ 整节不出、表号不占（口径与 Excel / PDF 一致）。
  const sm = model.hasSla ? model.slaMatrix : null
  if (sm && sm.rows.length) {
    const links = model.links || []
    children.push(P('4　' + L.sla, 'RptH2'))
    children.push(P(capTable(model, nextTableNo(model), 0, 1, L.sla), 'RptCaption'))
    const head = [L.slaTerm, ...links.map((l) => '#' + l.no + '　' + (l.txName || '') + ' → ' + (l.rxName || ''))]
    const rows = [], bold = []
    for (const row of sm.rows) {
      // 分组行换黑体不加粗（三线表不许底纹，层次只能靠字体给）
      if (row.group) { rows.push([row.label, ...links.map(() => '')]); bold.push(true); continue }
      rows.push([row.label, ...row.values.map((v) => fmtVal(v))]); bold.push(false)
    }
    const rest = links.length ? Math.floor(60 / links.length) : 60
    children.push(docTable(head, rows, {
      dense: true, keyRows: bold,
      widths: [40, ...links.map(() => rest)],
      align: ['left', ...links.map(() => 'right')]
    }))
    const sp = model.slaParams || []
    if (sp.length) children.push(P(L.slaParams + '　' + sp.map((x) => `${x.label} ${x.value}${x.unit ? ' ' + x.unit : ''}`).join('　·　'), 'RptNote'))
  }
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
    // SLA 建议：条款 / 计算依据 / 建议值 / 采用值 / 单位 五列三线表（表号接在输入参数各块之后）
    const sr = (l.sla && l.sla.rows) || []
    if (sr.length) {
      children.push(P(L.sla, 'RptH3'))
      children.push(P(capTable(model, l.no + '-' + ((l.inputs || []).length + 1), 0, 1, L.sla), 'RptCaption'))
      const rows = [], bold = []
      let grp = ''
      for (const row of sr) {
        if (row.groupLabel && row.groupLabel !== grp) { grp = row.groupLabel; rows.push([grp, '', '', '', '']); bold.push(true) }
        rows.push([row.label + (row.sub ? '　' + row.sub : ''), row.basis, row.suggest, row.adopt, row.unit]); bold.push(false)
      }
      children.push(docTable([L.slaTerm, L.slaBasis, L.slaSuggest, L.slaAdopt, L.unit], rows,
        { widths: [26, 30, 16, 16, 12], align: ['left', 'right', 'right', 'right', 'left'], keyRows: bold, widthPct: 80 }))
    }
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
    // 不设 features.updateFields：文档里已没有域（目录是静态排的，页脚只有页码），
    // 留着只会让 Word 每次打开都弹一次「是否更新域」
    // 封面 → 目录 → 总报告 → 逐链路详情。文档控制页（签署 / 变更记录 / 页数）2026-08-02 按用户要求去掉。
    sections: [
      coverSection(model),
      tocSection(model, tocItems(model)),
      masterTablesSection(model),
      masterTailSection(model),
      detailSection(model)
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildReportDocx }
