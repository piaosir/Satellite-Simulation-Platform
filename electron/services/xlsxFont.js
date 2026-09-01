// xlsx 的中西文字体归位（主进程共用）。
//
// 交付级报告（report.js）与通用表格导出（gridXlsx.js）都要「中文宋体 / 西文与数字 Times New Roman」，
// 而这件事在 xlsx 里只能靠富文本逐段挂字体来做，规则又细（全角空格算中文、间隔号跟中文走、
// 数字格不能富文本…）。两处各写一份必然漂移，故单抽本模块，两边同 require 一份。
//
// 字体口径来自《技术文档标准模板.docx》：西文与数字 Times New Roman；中文正文宋体、中文标题与题注黑体。
const FNT = 'Times New Roman'
const SONG = '宋体'          // 模板 docDefaults 的 eastAsia：中文正文与表内文字
const HEI = '黑体'           // 模板 标题 1–4 / 图号格式 / 表号格式：中文标题与题注

// ★ xlsx 的 <font> 只有一个 name 字段（不像 docx 分 ascii / eastAsia 两栏），一个单元格因此
// 只能有一种字体。要「中文宋体 + 西文数字 Times New Roman」，唯一的办法是把这一格写成**富文本**
// （sharedStrings 里逐段带 rPr），于是下面这一支：写盘前整本过一遍，把中西混排的字符串按
// 「中文段 / 西文段」切开，两段各挂各的字体；纯中文或纯西文的格不拆，只把 name 归位。
//
// 各表写格时用 name 表明意图：'黑体' = 中文标题/题注、'宋体' = 中文正文、TNR = 纯西文或数字。
// 数字格（value 是 number）不能富文本，本来也只有数字，一律 TNR。
const CJK_CH = /[⺀-〾ぁ-㏿㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/
// 破折号 / 省略号 / 箭头：TNR 里没有 →↑↓ 的字形，按中文字体走才不至于让 Excel 自己去回落。
// 中点 · (U+00B7) 是中文的间隔号，跟着中文段走——不然「　·　」会被切成三段，
// 中间那个点用 TNR 出来又小又高，与两侧全角空格对不齐。
const CJK_SYM = /[—―…·←-⇿]/
const isCjkCh = (ch) => CJK_CH.test(ch) || CJK_SYM.test(ch)
const hasCjk = (s) => { for (const ch of s) if (isCjkCh(ch)) return true; return false }
const hasLatin = (s) => { for (const ch of s) if (!isCjkCh(ch) && !/\s/.test(ch)) return true; return false }

// 切成交替的中文段 / 西文段。半角空白是中性的——归进当前段，免得「上行 C/N」被切成三段。
// ★ 全角空格（U+3000）不算中性：它是中文标点，用 TNR 渲染会缩成半角宽，
//   「1　逐参数对照」这类标题的对齐就散了。它落进 CJK_CH，随中文段走。
const NEUTRAL_SP = /[ \t\r\n]/
function splitCjkRuns(text) {
  const out = []
  let cur = null
  for (const ch of String(text)) {
    if (cur && NEUTRAL_SP.test(ch)) { cur.text += ch; continue }
    const k = isCjkCh(ch)
    if (cur && cur.cjk === k) cur.text += ch
    else { cur = { cjk: k, text: ch }; out.push(cur) }
  }
  return out
}

// 一格的字体归位。返回 true 表示把 value 换成了富文本。
function fixCellFont(cell) {
  const f = Object.assign({}, cell.font)
  const v = cell.value
  // 已经是富文本（本文件不主动写，留给未来）：只补 name 缺省
  if (v && typeof v === 'object' && Array.isArray(v.richText)) return false
  const cjkFont = (f.name === HEI) ? HEI : SONG
  const text = (typeof v === 'string') ? v : null
  if (text === null) {
    // 数字 / 日期 / 公式：不能走富文本。数字本来就只有西文；公式（详情索引的跳转链接）
    // 按缓存结果里有没有汉字选一种——那一格的文字是工作表名，常常是中文站名。
    const res = (v && typeof v === 'object' && v.formula !== undefined && v.result != null) ? String(v.result) : ''
    cell.font = Object.assign(f, { name: hasCjk(res) ? cjkFont : FNT })
    return false
  }
  if (!hasCjk(text)) { cell.font = Object.assign(f, { name: FNT }); return false }
  if (!hasLatin(text)) { cell.font = Object.assign(f, { name: cjkFont }); return false }
  // 混排：拆富文本。cell.font 仍写中文那一档——它是这一格的「默认字体」，
  // 自适应算宽（reportAutofit）与用户导出后续打的字都按它走。
  cell.value = {
    richText: splitCjkRuns(text).map((seg) => ({
      font: Object.assign({}, f, { name: seg.cjk ? cjkFont : FNT }),
      text: seg.text
    }))
  }
  cell.font = Object.assign(f, { name: cjkFont })
  return true
}

// 整本归位 + 换掉工作簿主题字体（Excel「正文/标题」的来源，exceljs 硬写 Calibri/Cambria）：
// 空白格与用户导出后新键入的内容也跟着是 TNR + 宋体。主题那一段走 exceljs 内部模块，故 try 兜底，
// 失败只是默认字体没换，已写入的单元格字体不受影响。
function applyBookFont(wb) {
  try {
    const theme1 = require('exceljs/lib/xlsx/xml/theme1.js')
    // 注意：wb.model 的 getter 每次现造一个对象，改它的字段无效——主题存在 wb._themes 上（writer 由此取）
    wb._themes = {
      theme1: String(theme1)
        .replace(/<a:latin typeface="(Calibri|Cambria)"\/>/g, `<a:latin typeface="${FNT}"/>`)
        .replace(/<a:ea typeface=""\/>/g, `<a:ea typeface="${SONG}"/>`)
    }
  } catch (e) { /* exceljs 内部结构变了就跳过，不影响导出 */ }
  wb.eachSheet((ws) => {
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => { fixCellFont(cell) })
    })
  })
  return wb
}

module.exports = { FNT, SONG, HEI, hasCjk, hasLatin, splitCjkRuns, fixCellFont, applyBookFont }
