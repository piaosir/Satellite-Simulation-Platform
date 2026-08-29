// 画布 / 离页 SVG 的字体栈（canvas 与导出用的 SVG 取不到 CSS 变量，只能手工镜像 global.css）。
//
// 口径（2026-08-29 定）：**屏上跟界面走无衬线，导出跟报告走衬线**。
//   图在屏幕上是界面的一部分，用户就地读它，字体理应与周围的表、标签同族；
//   同一张图导进报告后，周围换成了正文，字体就该跟正文同族。
// 故凡是「屏上一份、导出一份」的图（雨衰曲线 / 地理场图 / 频率计划图 / 干扰四图 / 3D 链路视图）
// 一律两条路径分别取下面两个常量，不要再共用一个。
//
// ★ 这两串是 styles/global.css 里 --font-ui / --font-doc 的手工副本，改那边必须改这里。★
export const UI_FONT_STACK = 'Arial, Helvetica, DengXian, "等线", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif'
export const DOC_FONT_STACK = '"Times New Roman", Times, "SimSun", "宋体", serif'

// 界面字体现在是可选的（设置 → 界面字体，stores/uiFont.js 把选择写成 <html> 行内 --font-ui），
// 所以屏上那一路不能再吃上面的常量，要实时问一次当前生效值；取不到（无 DOM / 没写过）才用出厂串。
export function uiFontStack() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim()
    return v || UI_FONT_STACK
  } catch (e) { return UI_FONT_STACK }
}

// 链路预算工作台数据区字号（--lb-fs）：GSO / NGSO / 再生式三窗共享。
// CSS 默认值在 styles/lbworkbench.css 的 :root（11px）；此处仅当用户调过时在 <html> 写行内变量覆盖，
// localStorage 持久化 + storage 事件跨窗即时同步（三窗同源，与 globe3d/settings.grd 共享机制相同）。
const KEY = 'lb/fontSize'
export const LB_FONT_DEFAULT = 11
export const LB_FONT_MIN = 8
export const LB_FONT_MAX = 20

const clamp = (n) => Math.min(LB_FONT_MAX, Math.max(LB_FONT_MIN, Math.round(n)))

export function getLbFontSize() {
  try {
    const n = parseFloat(localStorage.getItem(KEY))
    return isFinite(n) ? clamp(n) : LB_FONT_DEFAULT
  } catch (e) { return LB_FONT_DEFAULT }
}

function apply(px) {
  document.documentElement.style.setProperty('--lb-fs', px + 'px')
}

export function setLbFontSize(px) {
  const v = clamp(px)
  try { localStorage.setItem(KEY, String(v)) } catch (e) { /* ignore */ }
  apply(v)
  return v
}

// 窗口启动时套用已存字号，并监听其它链路预算窗口的改动（storage 事件只在别的窗口触发）
export function initLbFontSize(onChange) {
  apply(getLbFontSize())
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return
    const v = getLbFontSize()
    apply(v)
    if (onChange) onChange(v)
  })
}
