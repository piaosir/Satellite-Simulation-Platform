// 「详细预算」一键整表复制（TSV，直接粘进 Excel / 报告）—— GSO / NGSO / 再生式 / 端到端 四窗共用一份。
//
// 早先四窗各抄一份，漂出了三处错：
//   ① 多列段的列头写死「上行 / 下行」，工况对照段其实是「晴空 / 降雨」、端到端逐段汇总是「C/(N+I) / 段余量」；
//   ② 端到端那份不出列头；
//   ③ 端到端那份把空串格滤掉再拼（filter(x => x !== '')）—— 符号列空着、或某一侧没有值时，后面的格整体左移，
//      数值跑到别人的列下面。
// 现在只此一份：列序与屏上 WaterfallTable 逐列一致（符号 | 项目 | 值… | 单位），空格一律保位。
//
// 列头规则与 WaterfallTable.headsOf 同一条：段带 heads 且条数等于列数就用它，否则按列数取缺省
// 「上行 / 下行（/ 合计）」。列头过 t()（报表语言）——core 已按语言翻好的 heads 在字典里查不到，原样返回。

const DEFAULT_HEADS = { 2: ['上行', '下行'], 3: ['上行', '下行', '合计'] }

// 多列段的列头（未翻译的原文；单列段没有列头，返回空数组）
export function waterfallHeads(seg) {
  if (!seg) return []
  return (Array.isArray(seg.heads) && seg.heads.length === seg.cols) ? seg.heads : (DEFAULT_HEADS[seg.cols] || [])
}

// 单元格文本：null / undefined 记空串；格内的制表符与换行压成空格，否则一格会在 Excel 里裂成两格 / 两行
const cell = (v) => (v === undefined || v === null ? '' : String(v).replace(/[\t\r\n]+/g, ' '))

/**
 * segments → TSV 文本（段与段之间空一行，与 Excel 详表同号同序）。
 * @param segments core.buildWaterfallSegments 的输出（四窗的 segments）
 * @param t        列头翻译（各窗传 lbDocT(报表语言)）；段标题 / 行标签 / 单位 core 取数时已按语言翻好
 */
export function waterfallTsv(segments, t = (s) => s) {
  const lines = []
  for (const seg of segments || []) {
    if (!seg) continue
    lines.push((seg.no ? '§' + seg.no + '  ' : '') + cell(seg.title))   // 章节号与屏幕 / Excel 同号同序
    const n = seg.cols >= 3 ? 3 : seg.cols >= 2 ? 2 : 1
    if (n >= 2) lines.push(['', ''].concat(waterfallHeads(seg).map((h) => cell(t(h))), ['']).join('\t'))
    for (const r of seg.rows || []) {
      const cells = [r.sign, r.label, r.up]
      if (n >= 2) cells.push(r.down)
      if (n === 3) cells.push(r.total)
      cells.push(r.unit)
      lines.push(cells.map(cell).join('\t'))
    }
    lines.push('')
  }
  return lines.join('\n')
}
