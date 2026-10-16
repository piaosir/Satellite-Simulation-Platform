// 《空间态势报告》的 Word 出口（.docx，主进程）。
//
// 版式按 docs/空间态势报告样式规范_2026-10-15.md：SSA 自立样式层（reportSsaStyle.js），共用件 reportDocxKit.js
// 只取封面、页脚、字体与图尺寸工具 —— 链路预算 / SLA 两份报告逐字节不变（§J.1）。
//   封面（模板结构 + 「数据截至」一行，§B.3）
//   → 前置节：关键指标页 + 目次（小写罗马页码，§B.5 / §G）
//   → 正文：每章另起页（§B.6）、阿拉伯页码从 1 起；宽到 8 pt 密排也放不下的表（成员表 19 列）单独切横向节，页码续接（§B.2）
//   → 附录 A / B / C（续接，表号「表 A1」，§H）
//
// ★ 一个数都不算：章节、标题、列头、题注、每一格的字，全部由 shared/ssaReport.js 的 buildSsaModel 按语言
//   翻好、算好放进模型；屏上那份电子报告（SsaDoc.vue）与这份 Word 吃的是同一个模型。表格读数的格式化
//   （细空分组 / 固定小数位 / U+2212）由 reportSsaStyle.formatColumns 做，它与屏上 src/shared/ssaFormat.js 逐字同一套。
//
// 正文里的块（契约见 ssaReport.js 头注）：
//   kpi    → 关键指标表（只在前置节，§G.3）
//   kv     → 读数小标题 + 无线两列读数表（不占表号）
//   table  → 表题（表上，「表 3-2」按章编）+ 三线表 + 来源行（表下，§E.5）
//   figure → 图（按成图物理尺寸、不缩放，§F.1）+ 图题（图下，「图 3-1」按章编）；png 为 null 时整块跳过，图号也不占
//   refs   → 参考文献（GB/T 7714 顺序编码，§H.3）
// ★ 占表号的只有【非空的 table 块】（kv / kpi 不占、空表不印也不占），与屏上 SsaDoc.vue 逐字同一条规则 ——
//   两端各数各的，规则一分岔，同一张表就有两个号。packages/core/test/ssaDocx.test.mjs 的 screenNumbers() 是裁判。
// 纯数字：本文件不产出任何「达标 / 拥挤 / 正常 / 健康」一类文字判定（见仓库根 CLAUDE.md）。
const { Document, Packer, Paragraph, TextRun, Tab, PageOrientation } = require('docx')
const {
  paragraphStyles, characterStyles, coverSection, pageFooter, pngSizeOf, half, runFonts, TPL
} = require('./reportDocxKit')

// 节的页面（A4，模板页边距）。★ 不用 kit 的 sectPage：它横向时先把宽高对调再交给 docx，而 docx 9 见
//   orientation = LANDSCAPE 会再对调一次，落盘的 pgSz 又回到纵向尺寸（w 11906 / h 16838 + orient=landscape）。
//   这里照 docx 的约定给纵向宽高 + 方向，让它只对调一次。
const sectPage = (landscape, numbering) => ({
  page: {
    size: { orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT, width: TPL.page.widthTw, height: TPL.page.heightTw },
    margin: TPL.page.marginTw,
    pageNumbers: numbering || undefined
  }
})
const {
  ssaParagraphStyles, P, formatColumns, sourceLine, chapterNo, planTable,
  ssaTable, ssaKvTable, ssaKpiTable, ssaHeader, ssaFigure
} = require('./reportSsaStyle')

const SH = (v) => (v == null ? '' : String(v))

// 封面「密　　级 / 文档编号」：排版件要的字，不是报告数据，按 lang 现造（kit 的 coverSection 读 model.t）
const T = {
  zh: { cvClass: '密　　级', cvDocNo: '文档编号', contents: '目　次', asOf: '数据截至' },
  en: { cvClass: 'Classification', cvDocNo: 'Doc. No.', contents: 'Contents', asOf: 'Data as of' }
}
const L = (model) => (model.lang === 'en' ? T.en : T.zh)

// 行数上限只由模型自己截（成员表 b.capped，「大表行数」只管它）；这里照单全印，与屏上 SsaDoc 同一口径
// 附录「口径与判据」：判据列可折行（与屏上 isCriteriaTable 同一条正则）
const isCriteriaTable = (b) => /\.criteria$/.test(String(b.tableId || ''))

const ALIGN = { l: 'left', c: 'center', r: 'right' }
const alignOf = (a, nCol) => { const out = []; for (let i = 0; i < nCol; i++) out.push(ALIGN[a && a[i]] || (i === 0 ? 'left' : 'right')); return out }

// 章标题：「3　编目与轨道区制」/「附录 A　口径与判据」；英文两个半角空格
const headText = (model, s) => {
  const en = model.lang === 'en'
  if (s.appendix) return (en ? `Appendix ${s.no}  ` : `附录 ${s.no}　`) + (s.title || '')
  return s.no ? s.no + (en ? '  ' : '　') + (s.title || '') : (s.title || '')
}
const capT = (model, no, title) => (model.lang === 'en' ? `Table ${no}  ${title}` : `表 ${no}　${title}`)
const capF = (model, no, title) => (model.lang === 'en' ? `Figure ${no}  ${title}` : `图 ${no}　${title}`)
const totalTail = (model, total) => (!total ? '' : (model.lang === 'en' ? ` (${total} rows total)` : `（共 ${total} 条）`))

// ============================ 块 ============================

// table：返回 { landscape, parts }（landscape = 这张表要单独切横向节）
function tableBlock(model, sec, b, ctr) {
  const rows = b.rows || []
  if (!rows.length) return null      // 空表不印、不占号（与屏上同一条）
  const head = (b.head || []).map(SH)
  const capTotal = b.capped && Number(b.capped.total)
  const total = capTotal > 0 ? capTotal : 0
  const nCol = head.length || rows[0].length
  const cells = formatColumns(rows, nCol, b.blankCols)
  const wrapCols = isCriteriaTable(b) ? [2] : []
  const plan = planTable(head, cells, { widths: b.widths, wrapCols, align: alignOf(b.align, nCol) })
  const parts = [
    P(capT(model, chapterNo(sec, ++ctr.t, model.lang), b.caption || '') + totalTail(model, total), 'SsaCapT'),
    ssaTable(head, cells, {
      align: alignOf(b.align, nCol), pct: plan.pct, dense: plan.mode !== 'normal',
      headGroups: b.headGroups, rowRoles: b.rowRoles
    })
  ]
  const src = sourceLine(b.source, model.lang)
  if (src) parts.push(P(src, 'SsaNote'))
  else parts.push(new Paragraph({ style: 'SsaNote', children: [] }))   // 表后留同样的段后距
  return { landscape: plan.mode === 'landscape', parts }
}

function kvBlock(model, b) {
  const rows = (b.rows || []).map((r) => [r[0] == null || r[0] === '' ? '—' : String(r[0]), r[1] == null || r[1] === '' ? '—' : String(r[1])])
  if (!rows.length) return []
  const out = []
  if (b.caption) out.push(P(SH(b.caption), 'SsaKvCap'))
  out.push(ssaKvTable(rows))
  return out
}

function figureBlock(model, sec, b, ctr) {
  const f = (model.figures || {})[b.figId]
  const png = f && f.png
  if (!png || !pngSizeOf(png)) return []
  const mm = (f && Array.isArray(f.mm) && f.mm.length === 2) ? f.mm : [160, 80]
  return ssaFigure(png, capF(model, chapterNo(sec, ++ctr.f, model.lang), b.caption || ''), mm)
}

// 「[n]」与著录之间走制表符：悬挂缩进 2 字，续行与著录首字对齐
const refsBlock = (b) => (b.items || []).map((t, i) => new Paragraph({ style: 'SsaRef', children: [new TextRun({ children: ['[' + (i + 1) + ']', new Tab(), String(t)] })] }))

// ============================ 节 ============================

// 正文：逐章逐块排，遇到要横排的表就切节（纵 → 横 → 纵）。每段节都带页眉（报告名 + 台标）与页脚页码。
function bodySections(model) {
  const out = []
  let cur = []
  let first = true
  const flush = (landscape) => {
    if (!cur.length) return
    out.push({
      properties: Object.assign(sectPage(!!landscape, first ? { start: 1, formatType: 'decimal' } : undefined)),
      headers: { default: ssaHeader(model, !!landscape) },
      footers: { default: pageFooter() },
      children: cur
    })
    first = false
    cur = []
  }
  for (const sec of (model.sections || [])) {
    if (sec.key === 'summary') continue          // 关键指标页在前置节
    const ctr = { t: 0, f: 0 }                   // 表号 / 图号按章编（§D）
    const h1 = P(headText(model, sec), 'SsaH1')
    cur.push(h1)
    for (const b of (sec.blocks || [])) {
      if (!b || !b.type) continue
      if (b.type === 'kv') cur.push(...kvBlock(model, b))
      else if (b.type === 'figure') cur.push(...figureBlock(model, sec, b, ctr))
      else if (b.type === 'refs') cur.push(...refsBlock(b))
      else if (b.type === 'table') {
        const t = tableBlock(model, sec, b, ctr)
        if (!t) continue
        if (t.landscape) {
          // 横排表是本章第一块：章标题随它进横向节，不在纵向页上孤零零留一行
          const carry = cur.length && cur[cur.length - 1] === h1 ? [cur.pop()] : []
          flush(false)
          cur = carry.concat(t.parts)
          flush(true)
        } else cur.push(...t.parts)
      }
    }
  }
  flush(false)
  return out
}

// 前置节：关键指标页 + 目次（§B.5：小写罗马页码从 i 起）
function frontSection(model) {
  const children = []
  const sm = (model.sections || []).find((s) => s.key === 'summary')
  const kpi = sm && (sm.blocks || []).find((b) => b.type === 'kpi')
  if (kpi && (kpi.groups || []).some((g) => (g.items || []).length)) {
    children.push(P(sm.title || '', 'SsaFront'))
    if (kpi.caption) children.push(P(kpi.caption, 'SsaBasis'))
    // 组标题行右侧的对照期：「对照：一年前」/「vs a year earlier」（排版件要的字，按 lang 现给）
    const refPrefix = model.lang === 'en' ? '    vs ' : '　　对照：'
    children.push(ssaKpiTable((kpi.groups || []).filter((g) => (g.items || []).length).map((g) => Object.assign({}, g, { refPrefix }))))
  }
  // 目次：逐条对应正文里真出现的章标题（静态排版；Word 目录域待拍板，见样式规范 §B.4）
  const toc = (model.sections || []).filter((s) => s.key !== 'summary').map((s) => P(headText(model, s), 'SsaToc1'))
  children.push(new Paragraph({ style: 'SsaFront', pageBreakBefore: children.length > 0, children: [new TextRun({ text: L(model).contents })] }))
  children.push(...toc)
  return {
    properties: sectPage(false, { start: 1, formatType: 'lowerRoman' }),
    headers: { default: ssaHeader(model, false) },
    footers: { default: pageFooter() },
    children
  }
}

async function buildSsaDocx(model) {
  // 排版用字挂在一份浅拷上，不往调用方的模型上写：模型是纯数据、JSON 往返后要深相等
  const m = Object.assign({}, model, { t: Object.assign({}, L(model), model.t || {}) })
  const d = m.doc || {}
  const cover = coverSection(m)
  // 封面加「数据截至」一行（§B.3）：报告里每个数都是那一刻的快照
  const asOfText = m.data && m.data.asOfText
  if (asOfText) cover.children.push(P(L(m).asOf + '　' + asOfText, 'SsaCvAsOf'))
  const doc = new Document({
    creator: d.org || '',
    title: d.title || '',
    styles: {
      default: { document: { run: { font: runFonts(m.doc).FN, size: half(10.5) } } },
      paragraphStyles: paragraphStyles(m.doc).concat(ssaParagraphStyles(m.doc)),
      characterStyles: characterStyles(m.doc)
    },
    sections: [cover, frontSection(m), ...bodySections(m)]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildSsaDocx }
// 版心常量留给调用方 / 测试核对（不参与排版）
module.exports.TPL = TPL
