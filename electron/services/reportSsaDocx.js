// 《空间态势报告》的 Word 出口（.docx，主进程）。
//
// 版式与链路预算 / SLA 两份报告完全同一套（模板《技术文档标准模板.docx》）：封面、目录、
// 三线表、页眉 logo、页脚页码、表题在表上方而图题在图下方 —— 全部取自 reportDocxKit.js，
// 本文件只管【印什么】。
//
// ★ 一个数都不算：章节、标题、列头、题注、每一格的字，全部由 shared/ssaReport.js 的
//   buildSsaModel 按语言翻好、算好放进模型（见 SSA 模块内部契约 §1 §5）。屏上那份电子报告
//   与这份 Word 吃的是同一个模型 —— 口径只有一处，两边必然同数。
//
// 正文即 model.sections 的顺序，每章一个 H1；章内三种块按契约 §5 映射：
//   kv     → kvTable（标签 26% / 值 74%；caption 照印，不占表号）
//   table  → capTable（表上方）+ docTable 三线表
//   figure → figureParagraphs(model.figures[figId].png)，png 为 null（用户没勾「含图」
//            或那张图没栅格化成功）时整块跳过，图号也不占
// （2026-09-17 删了第四型 note：附录「口径与判据」本是唯一的使用者，已升格成正式 table。）
// 表号与图号各自全篇连续。★ 占表号的只有【非空的 table 块】（kv 不占、空表不印也不占），
// 与屏上 SsaDoc.vue 逐字同一条规则 —— 两端各数各的，规则一分岔，同一张表就有两个号。
// 纯数字：本文件不产出任何「达标 / 拥挤 / 正常 / 健康」一类文字判定（见仓库根 CLAUDE.md）。
const { Document, Packer } = require('docx')
const {
  paragraphStyles, characterStyles, P, docTable, kvTable, coverSection, tocSection,
  logoHeader, pageFooter, sectPage, figureParagraphs, pngSizeOf, contentPx,
  nextTableNo, capTable, TPL, half, runFonts
} = require('./reportDocxKit')

// —— 小工具 ——
// 数据格：空与 null 一律印破折号（三线表里留一格真空白，读者分不清是「没有」还是漏印了）
const S = (v) => (v == null || v === '' ? '—' : String(v))
// 表头格：不补破折号 —— 矩阵类表的左上角本就该是空的
const SH = (v) => (v == null ? '' : String(v))

// 封面「密　　级 / 文档编号」、目录页标题、表号图号的「表 / 图」：这三样是【排版件】要的字，
// 不是报告数据，故契约 §1 的模型里没有（链路预算那边由 labelBundle 随模型带 model.t）。
// kit 的 coverSection / tocSection / capTable 都读 model.t，这里按 lang 现造一份最小的补上。
const T = {
  zh: { cvClass: '密　　级', cvDocNo: '文档编号', contents: '目 录', table: '表', figure: '图' },
  en: { cvClass: 'Classification', cvDocNo: 'Doc. No.', contents: 'Contents', table: 'Table', figure: 'Figure' }
}
const L = (model) => (model.lang === 'en' ? T.en : T.zh)

// 一张表最多印多少行 —— 取【模型自己的 opts.rowCap】（界面上那项「大表行数」），不再另设一套：
// Word 端小、屏上大的话，题注里「（共 N 条）」这句读数在两边说的就不是同一件事。
// 模型多半已经按同一个 rowCap 截过（capped），这里是第二道闸：模型没截而超了的在这里截。
const ROW_CAP_DEF = 500
const rowCapOf = (model) => {
  const n = Math.floor(Number(model && model.opts && model.opts.rowCap))
  return Number.isFinite(n) && n >= 10 ? n : ROW_CAP_DEF
}

// 图在版心里的尺寸上限（像素，96 dpi）：宽 = 版心宽（A4 纵向 16.0 cm），高 = 82 mm ——
// 一页正文里「图 + 图题 + 一段表」摆得下的上限，再高每张图就独占一页。
const FIG_MAX_W = contentPx(false)
const FIG_MAX_H = Math.round(82 / 25.4 * 96)

// 节：A4 纵向 + 页眉 logo + 页脚页码（全篇不需横向：最宽的表也只有九列）
const bodySection = (model, children) => ({
  properties: sectPage(false, { start: 1 }),
  headers: { default: logoHeader((model.doc || {}).logo) },
  footers: { default: pageFooter() },
  children
})

const H = (text, level) => P(text, 'RptH' + level)

// 章标题「1　编目总览」：中文用全角空格（同 SLA 报告），英文用两个半角空格（同 capTable 的
// 英文题注）—— 全角空格夹在纯西文行里宽得突兀。
const heading = (model, no, title) => (no ? no + (model.lang === 'en' ? '  ' : '　') + title : title)

// 图号全篇连续。kit 只给了表号计数器（nextTableNo），图号在这里照同一个手法数。
const nextFigNo = (model) => { model.__figNo = (model.__figNo || 0) + 1; return model.__figNo }
const capFigure = (model, no, title) => (model.lang === 'en'
  ? `Figure ${no}  ${title}`
  : `${L(model).figure} ${no}　${title}`)

// 「（共 N 条）」/「(N rows total)」：纸上这张只是全表的前若干行时的读数（含运行时数据，不是判定）
const totalTail = (model, total) => (!total ? '' : (model.lang === 'en' ? ` (${total} rows total)` : `（共 ${total} 条）`))

// 契约 §1 的 align 是 'l' | 'c' | 'r' 逐列；docTable 认的是 'left' | 'right' | 'center'。
// 缺省口径也在契约里：首列左（名称）、其余右（数）。
const ALIGN = { l: 'left', c: 'center', r: 'right' }
function alignOf(a, nCol) {
  const out = []
  for (let i = 0; i < nCol; i++) out.push(ALIGN[a && a[i]] || (i === 0 ? 'left' : 'right'))
  return out
}

// 契约 §1 的 widths 是**相对权重**，docTable 要的是百分比：按权重和归一，末列吃掉舍入余数
// （逐列各自 Math.round，加起来会差一两个点，Word 按 pct 排版时最后一列就少一条缝）。
// 缺省等分。权重悬殊到末列被挤成 0 / 负数时退回等分 —— 负的 w:w 是非法 OOXML，Word 直接报文档损坏。
function widthsOf(w, nCol) {
  if (!nCol) return undefined
  const equal = () => {
    const p = []
    let used = 0
    for (let i = 0; i < nCol - 1; i++) { const v = Math.round(100 / nCol); p.push(v); used += v }
    return p.concat(100 - used)
  }
  if (!Array.isArray(w) || w.length !== nCol) return equal()
  const src = w.map((v) => (Number(v) > 0 ? Number(v) : 0))
  const sum = src.reduce((s, v) => s + v, 0)
  if (!(sum > 0)) return equal()
  const pct = []
  let used = 0
  for (let i = 0; i < nCol - 1; i++) { const v = Math.max(1, Math.round(src[i] / sum * 100)); pct.push(v); used += v }
  const last = 100 - used
  return last >= 1 ? pct.concat(last) : equal()
}

// emphasisRows → docTable 的 keyRows：三线表不许底纹，
// 层次只能靠字体给（中文换标题那一档、不加粗，见 kit 的 docTable 头注）。
// warnCells（历元龄 > 7 天）在 Word 里不着色 —— 纸上只印数，与 SLA 报告同一口径。
// （契约 §1 仍有 emphasisRows 这一项，但 2026-09-17 删掉「重点所有者」之后模型里暂无产地，通路留着。）
function keyRowsOf(idx, n) {
  if (!Array.isArray(idx) || !idx.length) return undefined
  const out = new Array(n).fill(false)
  for (const i of idx) if (i >= 0 && i < n) out[i] = true
  return out
}

// ============================ 三种块 ============================

// ★ 附录「口径与判据」不吃「大表行数」这道闸：它不是「全表的一截」，它是定义 —— 截掉几条，
//   交付出去的 Word 就少几条判据，而屏上（SsaDoc 的静态三线表分支根本不走 rowCap）照印全份，
//   同一份报告两边的判据条数对不上。判据表 15～21 行，而这一项的合法下限是 10，调小是常规操作。
//   与屏上 SsaDoc.vue 的 isCriteriaTable 同一条正则口径（改一处必须两处一起改）。
const isCriteriaTable = (b) => /\.criteria$/.test(String(b.tableId || ''))

// table：题注（表上方，表号全篇连续）+ 三线表。
// 行数封顶 rowCap：模型自己截过的照用它的 capped.total，没截而超的在这里截，两种都在题注后
// 补「（共 N 条）」—— 读者得知道纸上这张是全表的一截。
function tableBlock(model, b) {
  const all = b.rows || []
  if (!all.length) return []      // 空表不印（与 SLA 报告同：没有数就没有这张表）
  const head = (b.head || []).map(SH)
  const cap = isCriteriaTable(b) ? Infinity : rowCapOf(model)
  const rows = all.length > cap ? all.slice(0, cap) : all
  const capTotal = b.capped && Number(b.capped.total)
  const total = capTotal > 0 ? capTotal : (all.length > rows.length ? all.length : 0)
  const nCol = head.length || rows[0].length
  const capText = capTable(model, nextTableNo(model), 0, 1, b.caption || '') + totalTail(model, total)
  return [P(capText, 'RptCaption'), docTable(head.length ? head : null, rows.map((r) => r.map(S)), {
    widths: widthsOf(b.widths, nCol),
    align: alignOf(b.align, nCol),
    keyRows: keyRowsOf(b.emphasisRows, rows.length)
  })]
}

// kv 块：标签 / 值两列（kit 的 kvTable）。★ 不占表号：kvTable 是「标签 26% / 值 74%」的排版件，
// 不是正文引用得到的「表 N」（SLA 报告的「报告口径」那块同样不编号）。屏上的 SsaDoc.vue 也不给它
// 编号 —— 两端各数各的，规则必须同一条，否则从第 1 章起两边的表号就整体错开（原先 Word 给 kv
// 编号、又跳过空表，全量报告屏上 12 个号、Word 18 个）。caption 照印，只是不带号。
function kvBlock(model, b) {
  const rows = (b.rows || []).map((r) => [S(r[0]), S(r[1])])
  if (!rows.length) return []
  const out = []
  if (b.caption) out.push(P(SH(b.caption), 'RptCaption'))
  out.push(kvTable(rows))
  return out
}

// figure 块：图在上、图题在下（模板「图号格式」的口径）。png 由渲染端在导出前把 spec 栅格化
// 后填进 model.figures[figId].png；没有它（没勾「含图」/ dataUrl 坏了）整块跳过，图号不占。
function figureBlock(model, b) {
  const f = (model.figures || {})[b.figId]
  const png = f && f.png
  if (!png || !pngSizeOf(png)) return []
  return figureParagraphs(png, capFigure(model, nextFigNo(model), b.caption || ''), FIG_MAX_W, FIG_MAX_H)
}

// 一章：H1 + 逐块。块全被跳过的章仍留标题 —— 目录里有它，正文里少一章读者会当成漏印。
function sectionBody(model, sec) {
  const out = [H(heading(model, sec.no || '', sec.title || ''), 1)]
  for (const b of (sec.blocks || [])) {
    if (!b || !b.type) continue
    if (b.type === 'kv') out.push(...kvBlock(model, b))
    else if (b.type === 'table') out.push(...tableBlock(model, b))
    else if (b.type === 'figure') out.push(...figureBlock(model, b))
  }
  return out
}

// 目录条目：逐条对应正文里真出现的标题（静态排版，不是 Word 的 TOC 域，理由见 kit 的 tocSection
// 头注）。契约 §1 的块里没有「子标题」这一型 —— 组章的小节号写在块题注里（「G1.1 概况」），
// 故本报告只有 H1 一级，目录就是章节清单本身。
// 章号不走 tocSection 的 n 栏：它拼的是全角空格，英文版目录就会与正文的章标题两个样。
// 整串交给 t，目录行与正文 H1 逐字相同。
const tocItems = (model) => (model.sections || []).map((s) => ({ t: heading(model, s.no || '', s.title || '') }))

async function buildSsaDocx(model) {
  // 表号 / 图号的计数器与排版用字都挂在一份浅拷上，不往调用方的模型上写：契约 §1 说模型是
  // 纯数据、JSON 往返后要深相等，而同一份模型可能被反复渲染（先看后导、中英各出一份）。
  const m = Object.assign({}, model, { t: Object.assign({}, L(model), model.t || {}), __tblNo: 0, __figNo: 0 })
  const d = m.doc || {}
  const doc = new Document({
    creator: d.org || '',
    title: d.title || '',
    // 字体随这份报告的模型走（导出报告对话框「字体」三档；缺省即模板口径）。
    // 封面主标题不在其列：固定 Arial + 黑体 20pt 加粗（TPL.title，用户 2026-09-07 定，不给选）。
    styles: {
      default: { document: { run: { font: runFonts(m.doc).FN, size: half(TPL.size.body) } } },
      paragraphStyles: paragraphStyles(m.doc),
      characterStyles: characterStyles(m.doc)
    },
    sections: [
      coverSection(m),
      tocSection(m, tocItems(m)),
      bodySection(m, [].concat(...(m.sections || []).map((s) => sectionBody(m, s))))
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildSsaDocx }
