// 报告版式档：从用户给的《文档格式模板（公开）.docx》（中国卫通标准公文模板）里量出来的一套参数，
// Word / PDF / Excel 三个渲染器都照这一份走，于是三种文件是同一份文档的三种载体。
//
// 量法：解开模板的 word/styles.xml + document.xml，读各样式的 rFonts / sz / spacing / ind，
// 读 sectPr 的 pgSz / pgMar，读正文表格的 tblBorders 与表头 shd。下面每一项都注了模板里的原值。
//
// ★ CSS 那边（src/styles/lbreport.css）改不了 import JS，只能把同样的数抄一遍——改这里务必同步改那里，
//   两处都标了「模板」二字便于对照。
//
// 字体口径（与用户要求一致）：西文与数字一律 Times New Roman；中文标题黑体、中文正文宋体
// （模板 docDefaults 的 eastAsia=SimSun，各级标题 rFonts eastAsia=SimHei）。

// twips（1/20 pt）→ pt / cm 换算
const TW = (t) => t / 20
const CM = (t) => t / 567

const TPL = {
  // —— 页面（模板 sectPr：pgSz 11906×16838 = A4；pgMar top/bottom 1440、left/right 1797、header 851、footer 737）——
  page: {
    widthTw: 11906, heightTw: 16838,
    marginTw: { top: 1440, bottom: 1440, left: 1797, right: 1797, header: 851, footer: 737 },
    // 正文版心宽：A4 - 左右页边距 = 8312 tw = 14.66 cm
    contentTw: 11906 - 1797 * 2
  },
  // —— 字体 ——
  font: {
    latin: 'Times New Roman',      // 模板：各样式 rFonts ascii/hAnsi
    cjkHeading: 'SimHei',          // 模板：标题 1–5 / 题注 / Title 的 eastAsia（黑体）
    cjkBody: 'SimSun'              // 模板：docDefaults eastAsia（宋体）
  },
  // —— 字号（pt；模板 w:sz 为半点，此处已折半）——
  size: {
    docTitle: 16,        // aff0 Title：16pt 加粗居中黑体（「目 录」一类）
    h1: 14,              // 10 heading 1
    h2: 14,              // 2  heading 2
    h3: 12,              // 3  heading 3
    h4: 12,              // 4  heading 4
    h5: 12,              // 5  heading 5
    body: 12,            // CSPC-2 CSPC-正文格式（小四）
    caption: 10.5,       // afb caption（继承 Normal 的 21 半点）
    toc1: 12, toc2: 10, toc3: 10,
    table: 10.5,         // 正文表格文字（afff7 Plain Text，继承 Normal）
    tableDense: 9,       // 计算结果类密排表（模板无此物：45 行的级联单按 10.5pt 排不下，降一档）
    coverName: 18,       // C503--of3 封面-名称
    coverLabel: 15,      // C503--of  封面-标签（单位/编写/校对/审核/批准）
    coverValue: 12,      // C503--of1 封面-内容
    coverMeta: 15,       // C503--of4 封面-编号/阶段/密级/页数
    coverOrg: 22         // C503--2   封面-单位名称
  },
  // —— 段落间距（模板 spacing：line 360 auto = 1.5 倍行距；before/after 为 twips）——
  spacing: {
    lineRule: 1.5,
    h1BeforeTw: 374, h1AfterTw: 120,     // 模板 heading 1
    hBeforeTw: 120, hAfterTw: 120,       // 模板 heading 2–5
    captionBeforeTw: 31, captionAfterTw: 31,
    bodyFirstLineTw: 480                 // CSPC-2：首行缩进 2 字符
  },
  // —— 表格（模板正文示例表：全边框 sz=4 即 0.5pt；表头底纹 BFBFBF、加粗居中）——
  table: {
    borderSz: 4,                 // eighths of a point → 0.5pt
    borderSzOuter: 12,           // 变更记录表外框 1.5pt
    borderSzInner: 6,            // 变更记录表内线 0.75pt
    headFill: 'BFBFBF',
    widthPct: 100
  },
  // —— 封面（模板第一节量出来的绝对位置；A4 高 16838 tw）——
  // 结构：一个 1.5pt 外框（模板是一张 9574×13674 的单格表）里浮着四组内容 +
  // 左页边距上一条「会签」条（模板是 VML 文本框）。
  cover: {
    frameSz: 12,                 // 外框 1.5pt
    frameWTw: 9574, frameHTw: 13674,
    metaYTw: 1200, metaWTw: [1435, 2697],    // 右上：编号/阶段/密级/页数（右对齐）
    nameYTw: 2875, nameWTw: [1440, 6782],    // 名称：标签 + 两条下划线（居中）
    signYTw: 6115, signWTw: [1270, 4125],    // 单位/编写/校对/审核/批准（居中）
    orgYTw: 11861,                            // 底部公司名
    hqYTw: 6600, hqXTw: 300, hqRows: 4        // 左页边距的会签条
  },

  // —— 计算结果表沿用三线表（booktabs）——
  // 模板的表是全网格 + 灰底表头，本报告的「文档类」表（报告信息/链路清单/输入参数…）照此办；
  // 但逐行可手算的级联/瀑布表仍用三线表：那是用户此前明确定下的口径（密排表靠线的层级差分层，
  // 加满网格与灰底会把四十多行压成一堵墙），改这一条前先问。
  rule: { strongSz: 12, thinSz: 4, hairSz: 4 }
}

// 中文里「pt」在 docx 里一律是半点
const half = (pt) => Math.round(pt * 2)

module.exports = { TPL, TW, CM, half }
