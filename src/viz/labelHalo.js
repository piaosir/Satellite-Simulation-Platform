// 地图注记描边（casing）色的单一来源：2D flatmap/flatCoverage.js 与 3D globe3d/scene.js 共用。
//
// 注记字面是白（国名）/ 黄（一级）/ 灰蓝（二级）那一套，不动；描边是把字从底图里「切」出来的那一圈，
// 原先恒定写死近黑 `rgba(6,11,18,1)`。恒定的问题：
//   · 底色是可改的（陆地七档预设 + 自定义 + 莫兰迪杂色，海色六档，还能开真彩影像），
//     一圈纯黑压在浅米绿上是最强对比、压在深色底上却与背景糊成一片，等于没描边；
//   · 纯黑与地图的冷灰蓝 / 米绿那一族色不同调，字被「割」出来而不是「垫」出来。
//
// 改成按底色现算，两条一起动：
//   ① 颜色 —— 保住底色的色相与一部分饱和度，把明度压到很低。得到的是「同一族里最深的那一档」，
//      与白字面的对比恒在 15:1 以上（远高于 WCAG 的 4.5:1），同时与地图同调。
//   ② 粗细 —— 浅底给足（描边是白字唯一的对比来源），深底收细到 0.75（字与底已有对比，
//      描边只需勾个边缘；再粗就纯粹是在啃字的笔画了）。

const HEX6 = /^#[0-9a-fA-F]{6}$/

function parseHex(hex) {
  if (typeof hex !== 'string' || !HEX6.test(hex.trim())) return null
  const n = parseInt(hex.trim().slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// sRGB 相对亮度（WCAG 2.x）：判「底色深浅」用这个，不用 HSL 的 L —— 后者不计人眼对绿的偏重
export function relLum(hex) {
  const c = parseHex(hex)
  if (!c) return 0.5
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn
  let h = 0
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60; if (h < 0) h += 360
  }
  const l = (mx + mn) / 2
  const s = d ? d / (1 - Math.abs(2 * l - 1)) : 0
  return [h, s, l]
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c } else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c } else if (h < 300) { r = x; b = c } else { r = c; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

// 底色 → 描边色。保色相、饱和度折半（深色高饱和会显脏），明度压到底色的 ~16% 并钳进 [0.03, 0.11]。
// 钳的上界保证白字面永远拉得开；下界保证在近黑底色上描边仍比背景深一点点、边缘不消失。
export function haloColor(bgHex) {
  const c = parseHex(bgHex)
  if (!c) return 'rgb(8,12,18)'
  const hsl = rgbToHsl(c[0], c[1], c[2])
  const l = Math.max(0.03, Math.min(0.11, hsl[2] * 0.16))
  const out = hslToRgb(hsl[0], hsl[1] * 0.55, l)
  return 'rgb(' + out[0] + ',' + out[1] + ',' + out[2] + ')'
}

// 底色 → 描边粗细系数。浅底 1.0（描边是白字唯一的对比来源，给足）；
// 深底收到 0.75（字与底已有对比，再粗只是在啃笔画）。0.45 相对亮度以上算浅底。
export function haloScale(bgHex) {
  const t = Math.max(0, Math.min(1, relLum(bgHex) / 0.45))
  return 0.75 + 0.25 * t
}

// 影像底图（真彩卫星影像）：深浅混杂且整体偏暗，任何「按单一底色算」都不成立 ——
// 退回恒定近黑 + 给足粗细，那是唯一在全幅都站得住的一套。
export const IMAGERY_HALO = 'rgb(8,12,18)'
export const IMAGERY_SCALE = 1
