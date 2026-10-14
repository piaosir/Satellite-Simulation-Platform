// 出图「纸」色板：一切交付物（PNG、Word / PDF / Excel 报告里的图件）的唯一底色来源。
//
// 交付物与屏幕主题解耦：专业深色（含跟随系统深色）下屏上是黑底，但导出的图要贴进白纸报告，
// 一律按纸色出。取值 = report.html 实际生效的那套浅色（global.css 基础 :root，report.html 钉
// data-theme="light"、不带 skin）。global.css 基础 :root 改了这里要同步（paperTheme.test 守门）。
//
// 两种用法：
//   · 画布 / WebGL 直接取色：PAPER.bg、PAPER.text …
//   · DOM / SVG 出图：withPaper(el, fn) —— 把纸色板以 CSS 变量内联到 el 上，同步执行 fn（期间
//     getComputedStyle 读到的就是纸色），随即撤掉。同步完成，屏幕上不会闪一帧。
import { SERIES_LIGHT } from './lbPlotTheme.js'

export const PAPER = Object.freeze({
  bg: '#ffffff',
  surface: '#eeedea',
  surface2: '#e4e3de',
  text: '#1a1a1a',
  textMuted: '#6b6b66',
  textFaint: '#86867f',
  border: '#d3d2cc',
  borderStrong: '#adaca4',
  accent: '#1a1a1a',
  accentUi: '#2f5d8a',
  ok: '#1d7a52',
  warn: '#9a6a00',
  danger: '#a32d2d',
  series: SERIES_LIGHT,
})

// CSS 变量名 → 纸色（只列图上会用到的颜色类 token；字号、间距与主题无关，不碰）
export const PAPER_VARS = Object.freeze({
  '--bg': PAPER.bg,
  '--surface': PAPER.surface,
  '--surface-2': PAPER.surface2,
  '--text': PAPER.text,
  '--text-muted': PAPER.textMuted,
  '--text-faint': PAPER.textFaint,
  '--border': PAPER.border,
  '--border-strong': PAPER.borderStrong,
  '--accent': PAPER.accent,
  '--accent-ui': PAPER.accentUi,
  '--accent-fill': PAPER.accentUi,
  '--accent-on': PAPER.bg,
  '--ok': PAPER.ok,
  '--warn': PAPER.warn,
  '--danger': PAPER.danger,
  // lbworkbench.css 的三档表线（color-mix(--text, --bg)），写成字面量免得依赖祖先
  '--lb-rule-strong': 'color-mix(in srgb, ' + PAPER.text + ' 84%, ' + PAPER.bg + ')',
  '--lb-rule': 'color-mix(in srgb, ' + PAPER.text + ' 42%, ' + PAPER.bg + ')',
  '--lb-rule-soft': 'color-mix(in srgb, ' + PAPER.text + ' 15%, ' + PAPER.bg + ')',
  '--plot-s0': PAPER.series[0],
  '--plot-s1': PAPER.series[1],
  '--plot-s2': PAPER.series[2],
})

/** 在 el 上临时套纸色板执行 fn（同步）；返回 fn 的返回值。fn 抛错也会撤掉。 */
export function withPaper(el, fn) {
  if (!el || !el.style) return fn()
  const prev = {}
  for (const k of Object.keys(PAPER_VARS)) { prev[k] = el.style.getPropertyValue(k); el.style.setProperty(k, PAPER_VARS[k]) }
  try { return fn() } finally {
    for (const k of Object.keys(PAPER_VARS)) { if (prev[k]) el.style.setProperty(k, prev[k]); else el.style.removeProperty(k) }
  }
}
