// 时区图层的配色与线 / 字样式 —— 2D 平面图与 3D 球体共用这一份。
//
// 体例照 CIA《Standard Time Zones of the World》（2021 版；SatMaster 随带的 TIMEZONE.GIF 是它的 2013 版）：
//   · 打开即是一张时区图：陆地按时区实色铺满（盖住底图的陆地配色），海区按 15° 航海带铺同色相的浅调 —— 一眼看出分布；
//   · 四色循环，按【整点偏移 mod 4】取色（≡0 鼠尾草绿 / ≡1 沙黄 / ≡2 赤陶 / ≡3 青灰）：相邻整点必不同色，
//     同偏移全球同色（中国、蒙古东部、西澳、菲律宾都是 +8 的绿）；
//   · 半点 / 45 分区（印度、伊朗、尼泊尔、查塔姆…）用上下两个整点色的 45° 斜纹；
//   · 时区界是暖褐细线，航海带分界更细更浅，国际日期变更线是深色粗线。
// 色值取自 CIA 2021 矢量原图（逐区采样）；青灰略调冷，与沙黄、绿在屏幕上拉开。

import { relLum } from '../labelHalo.js'

export const TZ_HUE4 = [
  { land: '#C8D088', sea: '#DCE2C4' },   // ≡0 鼠尾草绿（UTC、±4、±8、±12）
  { land: '#E4C88C', sea: '#F2E6C8' },   // ≡1 沙黄
  { land: '#E0A480', sea: '#F2D4BE' },   // ≡2 赤陶
  { land: '#9FB8BE', sea: '#CEDBDD' }    // ≡3 青灰
]

// 线与字的两档墨色：
//   paper —— 时区色块铺着（浅色纸图）时：暖褐线、深褐字、白套边（CIA 图的体例）；
//   dark  —— 色块关着、底下是影像或深色陆地时：浅色线与字、深套边（halo null = 用渲染器自己的深底套边）。
export const TZ_INK = {
  paper: { land: '#7A5A46', sea: '#B09A84', idl: '#2B2320', text: '#3A2C22', sub: '#5E4A3C', halo: 'rgba(255,255,255,0.88)', hi: '#1F1915' },
  dark: { land: '#F2C49B', sea: '#C9B49E', idl: '#FFE2C2', text: '#FFE2C2', sub: '#F2D3B3', halo: null, hi: '#FFFFFF' }
}
export const TZ_DARK_LUM = 0.2   // 陆地底色相对亮度低于它算深底（与地图注记墨色分档同一判据量级）
// 色块不透明度 ≥ 0.5 时底子就是时区色（浅），按纸图墨色；否则看底图：影像一律深档，矢量底按陆地底色明度
export const tzInkFor = (imagery, landHex, fillAlpha) =>
  (fillAlpha >= 0.5 ? TZ_INK.paper : imagery || relLum(landHex) < TZ_DARK_LUM ? TZ_INK.dark : TZ_INK.paper)

export const TZ_W = { land: 1.0, sea: 0.6, idl: 2.0, hi: 1.5, hover: 2.0 }   // 线宽（CSS px）
export const TZ_STRIP_H = 18                                                // 2D 时区条高（CSS px）

const hexRgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const rgbHex = (r, g, b) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
export const mixHex = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t) }
export const rgba = (hex, a) => { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})` }

const hueAt = (h) => TZ_HUE4[((h % 4) + 4) % 4]

// 偏移（分钟）+ 陆 / 海 → { color, hatch, flat }：hatch 非空 = 斜纹的第二色（半点区）；flat = 矢量 PDF 等不支持图案时的实色
export function tzFillColor(off, k) {
  const key = k === 's' ? 'sea' : 'land'
  if (off % 60 === 0) { const c = hueAt(off / 60)[key]; return { color: c, hatch: null, flat: c } }
  const h0 = Math.floor(off / 60)
  const a = hueAt(h0)[key], b = hueAt(h0 + 1)[key]
  return { color: a, hatch: b, flat: mixHex(a, b, 0.5) }
}
// 时区条格子的底色：该航海带的浅调
export const tzBandColor = (h) => hueAt(h).sea
