// 空间态势报告：表格读数格式化（样式规范 2026-10-15 §E.3）—— 屏上纸面一份。
//
// ★ electron/services/reportSsaStyle.js 的 formatColumns 是本文件的【手写 CJS 副本】（主进程不吃渲染端 ESM，
//   仓库惯例同 adaptUnits / carrierRate）。两边逐字同一套规则，packages/core/test/ssaDocx.test.mjs 对拍。改一处必须改两处。
//
// 规则（模型存原值，格式化只在渲染端做 —— 表格视图复制给 Excel 的是原值）：
//   · 只格式化 number 型的格；字符串原样（NORAD、国际编号、年份、日期、百分数串在模型里就是串，它们是标识不是量）；
//   · 每列小数位固定 = 该列数值里最多的小数位（封顶 3），右对齐即小数点对齐；
//   · 分组：【整张表】里有绝对值 ≥ 10000 的数时，表内 ≥ 1000 的数一律以 U+2009 细空每三位分组；否则都不分（四位数习惯不分）。
//     按整张表而不是逐列判：逐列判时同一行里「20 126」与「2296」并排（真编目区制表实测），读起来像两套口径；
//   · 负号 U+2212；
//   · 没有这个量（null / 空串）印「—」；blankCols 里的列空串印空白（判据表「类别」只在组首行出现）。

export const THIN = '\u2009'
export const MINUS = '\u2212'

const decOf = (v) => {
  const s = String(v)
  const i = s.indexOf('.')
  if (i < 0 || /e/i.test(s)) return 0
  return Math.min(3, s.length - i - 1)
}

/** 一个数 → 读数串：dec 位小数；group = 本列需要分组（|v| ≥ 1000 的整数部分每三位一个细空）。 */
export function fmtQty(v, dec, group) {
  const neg = v < 0
  const s = Math.abs(v).toFixed(dec)
  const [ip, fp] = s.split('.')
  const body = (group && ip.length >= 4) ? ip.replace(/\B(?=(\d{3})+(?!\d))/g, THIN) : ip
  const zero = !/[1-9]/.test(s)
  return (neg && !zero ? MINUS : '') + body + (fp ? '.' + fp : '')
}

/** 整张表的格 → 读数串（二维数组）。blankCols：这些列的空串印空白不印「—」。 */
export function formatColumns(rows, nCol, blankCols) {
  const list = Array.isArray(rows) ? rows : []
  const n = nCol || (list[0] ? list[0].length : 0)
  const blank = new Set(blankCols || [])
  const dec = []
  let max = 0
  for (let c = 0; c < n; c++) {
    let d = 0
    for (const r of list) {
      const v = r && r[c]
      if (typeof v !== 'number' || !Number.isFinite(v)) continue
      d = Math.max(d, decOf(v))
      max = Math.max(max, Math.abs(v))
    }
    dec.push(d)
  }
  const groupAll = max >= 10000
  const group = dec.map(() => groupAll)
  return list.map((r) => {
    const out = []
    for (let c = 0; c < n; c++) {
      const v = r ? r[c] : null
      if (v == null || v === '') out.push(blank.has(c) ? '' : '—')
      else if (typeof v === 'number') out.push(Number.isFinite(v) ? fmtQty(v, dec[c], group[c]) : '—')
      else out.push(String(v))
    }
    return out
  })
}

/** 表下来源行（样式规范 §E.5：只写来源，不写读表指南）。 */
export function sourceLine(source, lang) {
  const en = lang === 'en'
  const map = en
    ? { SATCAT: 'SATCAT (CelesTrak)', GP: 'GP ephemeris (CelesTrak)', 'SATCAT+GP': 'SATCAT; GP ephemeris (CelesTrak)' }
    : { SATCAT: 'SATCAT（CelesTrak）', GP: 'GP 星历（CelesTrak）', 'SATCAT+GP': 'SATCAT；GP 星历（CelesTrak）' }
  const v = map[source]
  if (!v) return ''
  return en ? `Source: ${v}.` : `数据来源：${v}。`
}

/** 章内编号（样式规范 §D）：正文章「3-2」（英文 3.2）、附录「A1」、无章号的前置部分按序号。 */
export function chapterNo(sec, k, lang) {
  const no = String((sec && sec.no) || '')
  if (!no) return String(k)
  if (sec.appendix) return no + k
  return no + (lang === 'en' ? '.' : '-') + k
}
