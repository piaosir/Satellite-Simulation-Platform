// 独立《容量汇总》报告的 Word 出口（.docx，主进程）。
//
// 版式与链路预算报告 / SLA 报告完全同一套（模板《技术文档标准模板.docx》）：封面、目录、三线表、页眉 logo、
// 页脚页码、题注在表上方 —— 全部取自 reportDocxKit.js，本文件只管【印什么】。A4 纵向。
//
// 章节：
//   1 汇总范围        键值表（体制 / 转发器数 / 列入·未列入·失败链路 / 单位档 / 版本 / 生成时间）
//   2 转发器资源汇总    参数 × 转发器矩阵（与总报告 §2 同一张表；分节时各节一张，转发器多时分段）
//   3 逐转发器明细      一组一张：逐链路 + 小计 / 可用 / 剩余
//   4 计算口径          参数 / 定义 / 计算式
// 表号全篇连续（nextTableNo）。
// 纯数字：本文件不产出任何「达标 / 合格 / 受限 / 满足」一类文字判定（见仓库根 CLAUDE.md）。
const { Document, Packer } = require('docx')
const {
  paragraphStyles, P, docTable, kvTable, coverSection, tocSection,
  logoHeader, pageFooter, sectPage, nextTableNo, capTable, TPL, half, runFonts, characterStyles
} = require('./reportDocxKit')
const { capGroupTitle } = require('./reportCap')

const bodySection = (model, children) => ({
  properties: sectPage(false, { start: 1 }),
  headers: { default: logoHeader((model.doc || {}).logo) },
  footers: { default: pageFooter() },
  children
})
const H = (text, level) => P(text, 'RptH' + level)
const table = (model, title, head, rows, opts) => (rows && rows.length
  ? [P(capTable(model, nextTableNo(model), 0, 1, title), 'RptCaption'), docTable(head, rows, opts || {})]
  : [])

// 1 汇总范围
function scopeSection(model) {
  const L = model.t || {}
  return [H('1　' + L.capScope, 1), kvTable(model.scope || [])]
}

// 2 转发器资源汇总：参数列 + 转发器列（≥ 2 组时末列合计）。一页最多摆 MAX_COL 个数值列——
// 再多首列就挤没了（同 SLA 总表的分段）；分段时每段都带参数列，合计列跟在最后一段。
const MAX_COL = 6
function matrixSection(model) {
  const L = model.t || {}
  const en = model.lang === 'en'
  const out = [H('2　' + L.capMatrix, 1)]
  ;(model.sections || []).forEach((s, si) => {
    if (model.multi) out.push(H('2.' + (si + 1) + '　' + s.title, 2))
    const mx = s.matrix
    if (mx.note) out.push(P(mx.note, 'RptNote'))
    const nv = mx.head.length - 1
    const title0 = L.capMatrix + (model.multi ? '　·　' + s.title : '')
    for (let a = 0; a < nv; a += MAX_COL) {
      const b = Math.min(nv, a + MAX_COL)
      const pick = (r) => [r[0], ...r.slice(1 + a, 1 + b)]
      const n = b - a
      const w = Math.min(18, Math.floor(66 / n))
      const title = nv > MAX_COL ? title0 + (en ? ` (${a + 1}–${b} of ${nv})` : `（${a + 1}–${b} / ${nv}）`) : title0
      out.push(...table(model, title, pick(mx.head), mx.rows.map(pick), {
        widths: [100 - w * n, ...Array.from({ length: n }, () => w)],
        align: ['left', ...Array.from({ length: n }, () => 'right')]
      }))
    }
  })
  return out
}

// 组的小节号：不分节 3.n，分节 3.节.n
const detailNo = (model, si, gi) => (model.multi ? `3.${si + 1}.${gi + 1}` : `3.${gi + 1}`)
// 3 逐转发器明细：九列（再生式七列）走密排档，纵向版心排得下
function detailSection(model) {
  const L = model.t || {}
  const out = [H('3　' + L.capDetail, 1)]
  ;(model.sections || []).forEach((s, si) => {
    if (model.multi) out.push(H('3.' + (si + 1) + '　' + s.title, 2))
    for (const [gi, g] of s.detail.entries()) {
      out.push(H(detailNo(model, si, gi) + '　' + g.name, 3))
      const nc = g.head.length
      const widths = nc >= 9 ? [6, 21, 14, 7, 10, 10, 10, 11, 11] : [6, 28, 18, 8, 13, 13, 14]
      out.push(...table(model, capGroupTitle(g, model.lang), g.head, g.rows,
        { widths: widths.length === nc ? widths : undefined, align: g.align, keyRows: g.keyRows, dense: true }))
    }
  })
  return out
}

// 4 计算口径
function defsSection(model) {
  const L = model.t || {}
  return [H('4　' + L.capDefs, 1), ...table(model, L.capDefs, [L.capTerm, L.capDefinition, L.capFormula],
    (model.definitions || []).map((d) => [d.term, d.definition, d.formula]), { widths: [18, 50, 32] })]
}

// 目录条目：逐条对应正文里真正出现的 H1 / H2
function tocItems(model) {
  const L = model.t || {}
  const it = [{ n: '1', t: L.capScope }, { n: '2', t: L.capMatrix }]
  const secs = model.sections || []
  if (model.multi) secs.forEach((s, i) => it.push({ n: '2.' + (i + 1), t: s.title, sub: true }))
  it.push({ n: '3', t: L.capDetail })
  // 分节时目录只到节（3.n），组（3.n.m）太细；不分节时组就是二级条目
  if (model.multi) secs.forEach((s, i) => it.push({ n: '3.' + (i + 1), t: s.title, sub: true }))
  else (secs[0] ? secs[0].detail : []).forEach((g, gi) => it.push({ n: detailNo(model, 0, gi), t: g.name, sub: true }))
  it.push({ n: '4', t: L.capDefs })
  return it
}

async function buildCapDocx(model) {
  model.__tblNo = 0     // 表号从头数（同一份模型可能被反复渲染）
  const doc = new Document({
    creator: (model.doc && model.doc.org) || '',
    title: (model.doc && model.doc.title) || '',
    description: model.schemeText || '',
    styles: {
      default: { document: { run: { font: runFonts(model.doc).FN, size: half(TPL.size.body) } } },
      paragraphStyles: paragraphStyles(model.doc),
      characterStyles: characterStyles(model.doc)
    },
    sections: [
      coverSection(model),
      tocSection(model, tocItems(model)),
      bodySection(model, [].concat(scopeSection(model), matrixSection(model), detailSection(model), defsSection(model)))
    ]
  })
  return Packer.toBuffer(doc)
}

module.exports = { buildCapDocx }
