// 报告字体：导出报告对话框「字体」三档（西文与数字 / 中文正文 / 中文标题与题注）的候选表与合成。
//
// ★ 按【窗口】各存各的（GSO / NGSO / 再生式 / 端到端互相独立，与该窗口的元信息同一前缀 storeKey），
//   不是全局设置——用户 2026-09-07 定的口径：报告字体属于「这一次导出」，与界面字体（stores/uiFont.js）
//   是两回事，那一面管屏幕，这一面管交出去的文件。候选表复用 uiFont 的两张。
// 出厂 = 《技术文档标准模板》口径（Times New Roman / 宋体 / 黑体，即 electron/services/reportStyle.js 的 TPL.font）。
// 三档都在出厂值时 composeReportFonts 返回 null、模型不带 fonts，主进程照旧走模板默认——
// 没改过的产出逐字节不变，验证台（.rpharness）也不受影响。
// ★ xlsx / docx 只写字体名，对方机器没装就被替换；PDF 由生成报告这台机器的 Chromium 嵌入字体，
//   故候选表要过可用性检测（uiFont.availableFonts），但三个出厂档恒在列——它们就是模板口径。
import { LATIN_FONTS, CJK_FONTS, availableFonts } from '../stores/uiFont'

export const REPORT_FONT_DEF = { latin: 'tnr', cjkBody: 'simsun', cjkHead: 'simhei' }
export const REPORT_FONT_SLOTS = ['latin', 'cjkBody', 'cjkHead']

const listOf = (slot) => (slot === 'latin' ? LATIN_FONTS : CJK_FONTS)
// 某一档当前选中的字体条目；键认不出（存档来自更老的候选表）就回出厂档
export const reportFontOf = (slot, key) => listOf(slot).find((f) => f.key === key) || listOf(slot).find((f) => f.key === REPORT_FONT_DEF[slot])
export function normReportFontSel(sel) {
  const o = {}
  for (const s of REPORT_FONT_SLOTS) o[s] = reportFontOf(s, sel && sel[s]).key
  return o
}
export const isReportFontDefault = (sel) => REPORT_FONT_SLOTS.every((s) => normReportFontSel(sel)[s] === REPORT_FONT_DEF[s])

// 下拉候选：可用性检测后的两张表，三个出厂档恒在列；按原表次序取，别让补回来的出厂档跑到末尾
export function reportFontOptions() {
  const a = availableFonts()
  const withDef = (list, all, keys) => all.filter((f) => keys.indexOf(f.key) > -1 || list.indexOf(f) > -1)
  return {
    latin: withDef(a.latin, LATIN_FONTS, [REPORT_FONT_DEF.latin]),
    cjk: withDef(a.cjk, CJK_FONTS, [REPORT_FONT_DEF.cjkBody, REPORT_FONT_DEF.cjkHead])
  }
}
// 字体名按报表语言取：中文面有英文本名（SimSun / SimHei…）的英文报告用本名
export const reportFontLabel = (f, lang) => (lang === 'en' && f && f.en ? f.en : (f ? f.label : ''))

// 交给报告模型的那份（doc.fonts）：出厂值 → null（主进程走模板默认）；否则三个字体名（xlsx / docx 写盘用）
// 与两条 CSS 栈（PDF 打印页：西文面在前、中文面在后，浏览器逐字形回落——拉丁字形命中前一段，汉字落到后一段）
export function composeReportFonts(sel) {
  if (isReportFontDefault(sel)) return null
  const n = normReportFontSel(sel)
  const L = reportFontOf('latin', n.latin), B = reportFontOf('cjkBody', n.cjkBody), H = reportFontOf('cjkHead', n.cjkHead)
  const tail = L.serif ? 'serif' : 'sans-serif'
  return {
    latin: L.label, cjkBody: B.label, cjkHeading: H.label,
    cssBody: `${L.stack}, ${B.stack}, ${tail}`,
    cssHead: `${L.stack}, ${H.stack}, ${tail}`
  }
}
