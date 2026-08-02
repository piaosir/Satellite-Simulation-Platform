// 报告版式档：从用户给的《技术文档标准模板.docx》里量出来的一套参数，
// Word / PDF / Excel 三个渲染器都照这一份走，于是三种文件是同一份文档的三种载体。
//
// 量法：解开模板的 word/styles.xml + document.xml，读各样式的 rFonts / sz / spacing / ind，
// 读 sectPr 的 pgSz / pgMar，读正文表格的 tblBorders。下面每一项都注了模板里的原值。
// 模板自带一张「样式速查表」，各样式的口径以那张表为准（见文件末尾的对照）。
//
// ★ CSS 那边（src/styles/lbreport.css）改不了 import JS，只能把同样的数抄一遍——改这里务必同步改那里，
//   两处都标了「模板」二字便于对照。
//
// 字体口径（模板 docDefaults + 各样式 rFonts，也是用户明确要求）：
//   西文与数字一律 Times New Roman；中文正文宋体、中文标题与题注黑体。

// twips（1/20 pt）→ pt / cm 换算
const TW = (t) => t / 20
const CM = (t) => t / 567

const TPL = {
  // —— 页面（模板 sectPr：pgSz 11906×16838 = A4；pgMar top 1276 / right 1418 / bottom 1701 / left 1418、
  //    header 851、footer 992）——
  page: {
    widthTw: 11906, heightTw: 16838,
    marginTw: { top: 1276, bottom: 1701, left: 1418, right: 1418, header: 851, footer: 992 },
    // 正文版心宽：A4 - 左右页边距 = 9070 tw = 16.0 cm（模板示例表 tblW 恰为 9070，可互相印证）
    contentTw: 11906 - 1418 * 2
  },
  // —— 字体 ——
  font: {
    latin: 'Times New Roman',      // 模板 docDefaults：ascii / hAnsi / cs
    cjkHeading: '黑体',             // 模板 标题 1–4 / 图号格式 / 表号格式 / 文档标题 的 eastAsia
    cjkBody: '宋体'                 // 模板 docDefaults 的 eastAsia
  },
  // —— 字号（pt；模板 w:sz 为半点，此处已折半）——
  size: {
    docTitle: 16,        // afd 文档标题：黑体 16pt 居中（正文中不参与编号的标题）
    h1: 14,              // 1  标题 1：黑体 14pt，段前后 6 磅，固定行距 25 磅
    h2: 12,              // 2  标题 2：黑体 12pt
    h3: 12,              // 3  标题 3：黑体 12pt，固定行距 25 磅
    h4: 12,              // 4  标题 4：黑体 12pt，固定行距 22 磅
    body: 12,            // a1 正文（Normal）：宋体 / TNR 小四
    caption: 10.5,       // a0 表号格式 / a  图号格式：黑体 10.5pt 居中
    table: 10.5,         // afb 表格格式：宋体 10.5pt
    tableDense: 9,       // 计算结果类密排表（模板无此物：45 行的级联单按 10.5pt 排不下，降一档）
    footer: 9,           // ad 页脚：宋体 9pt
    toc1: 12, toc2: 10.5, toc3: 10.5,
    // 封面（模板封面全部是「标题（Title）」样式：黑体 16pt 居中）
    coverTitle: 16, coverSub: 16, coverOrg: 16, coverMeta: 12
  },
  // —— 段落间距（模板 spacing：line 360 auto = 1.5 倍行距；before/after 为 twips）——
  spacing: {
    lineRule: 1.5,
    h1BeforeTw: 120, h1AfterTw: 120, h1LineTw: 500,   // 模板 标题 1：段前后 6 磅、固定行距 25 磅
    hBeforeTw: 120, hAfterTw: 120,
    h3LineTw: 500, h4LineTw: 440,                     // 模板 标题 3 / 标题 4 的固定行距
    captionBeforeTw: 120, captionAfterTw: 120,        // 模板 图号格式：段前后 50 行（120 tw）
    bodyFirstLineTw: 480,                             // 模板 正文：首行缩进 2 字符
    coverTopTw: 2400, coverMidTw: 3200                // 封面各组之间的留白（模板靠空 Title 段撑开）
  },
  // —— 表格 ——
  // 模板正文表一律「三线表」样式：顶线 / 底线 1.5 磅、栏目线 0.75 磅、无竖线、无底纹，
  // 表内文字 10.5pt 居中、垂直居中，单元格边距上下 45 / 左右 108 tw。
  table: {
    topSz: 12,                   // eighths of a point → 1.5pt（模板 tblBorders top/bottom sz=12）
    headSz: 6,                   // 0.75pt（模板 tblStylePr firstRow 的 bottom sz=6）
    botSz: 12,
    gridSz: 12, gridInnerSz: 4,  // 备用「网格型（Table Grid）」：外框 1.5pt、内线 0.5pt
    cellMarTw: { top: 45, bottom: 45, left: 108, right: 108 },
    widthPct: 100
  },
  // —— 封面（模板第一节：流式一栏，不是浮动表）——
  // 结构：顶部「密级：」「文档编号：」两行（正文样式，左对齐）→ 留白 → 文档标题 / 副标题
  //      （标题样式：黑体 16pt 居中）→ 留白 → 编制单位 → 成文日期。
  // ★ 单位 / 公司名 / 签署人一律留空由用户填，软件不预设任何单位名。
  // 编写 / 校对 / 审核 / 批准 与阶段、页数在新模板封面上没有栏位，移到「文档控制」页的签署表。
  cover: {
    // 右上角 logo：宽按 logoWpx、高按原图比例；高超过 logoMaxHpx 则改按高走（方形/竖长比的 logo）。
    // 高的上限刻意压在「标题行 + 副标题行」之内——Excel 的图浮在格子上、不占行高，
    // 再高就会盖住下面的正文。
    logoWpx: 140,
    logoMaxHpx: 46,
    // Word / PDF 走**页眉**，每一页右上角都有（含封面）。高度必须小于上页边距 2.25 cm，
    // 否则 Word 会把版心往下推、Chromium 会把页眉裁掉一截。
    logoHeaderHmm: 10,
    logoHeaderWmm: 40            // 横长比 logo 的宽度上限（先按高算，超宽再按宽收）
  },

  // —— 三线表的三档线（模板：顶/底 1.5pt、栏目线 0.75pt）——
  // hair 一档模板里没有，留给密排表内部的分组分隔线（级联单里「小计 / 余量」上方那条）。
  rule: { strongSz: 12, thinSz: 6, hairSz: 4 }
}

// 中文里「pt」在 docx 里一律是半点
const half = (pt) => Math.round(pt * 2)

module.exports = { TPL, TW, CM, half }
