// 环境场栅格上色 —— 值 → RGBA 等经纬位图（纯函数，无 DOM 依赖，便于单测）。
//
// 场值从主进程一次取回后常驻，改配色 / 改值域 / 改档数一律只重跑这里（亚帧），不再走 IPC；
// 这与 GRD 覆盖填充的 L2a 分层是同一套思路。
//
// 配色表复用 viz/grd/colormap.js 的方案（Turbo/Jet/Viridis/Inferno/Gray），
// 采成 256 级查找表后逐像素查表——百万像素下比逐像素插值省一半时间。

import { schemeColorsRGB, SCHEME_NAMES } from '../grd/colormap.js'
import { isMetScheme, metLut, levelNorm } from './metPalette.js'

export { SCHEME_NAMES }
export { levelNorm, levelTicks, isMetScheme, MET_SCHEMES } from './metPalette.js'

const LUT_N = 256
const lutCache = new Map()

// 256 级查找表（Uint8Array, **4 字节/级 RGBA**）；invert=true 时整表倒序。
// ★ 科学色图（turbo 等）一律 alpha=255，是否透明由 colorize 的 opacity 一个数说了算；
//   气象业务色阶自带逐级 alpha（低值透明），故这里统一成四通道 —— 两族色标走同一条上色路径，
//   否则 colorize 里要分叉两遍循环。
export function colorLut(scheme, invert) {
  if (isMetScheme(scheme)) return metLut(scheme, invert)
  const key = scheme + (invert ? '|i' : '')
  let lut = lutCache.get(key)
  if (lut) return lut
  const stops = schemeColorsRGB(scheme, LUT_N)
  lut = new Uint8Array(LUT_N * 4)
  for (let i = 0; i < LUT_N; i++) {
    const c = stops[invert ? LUT_N - 1 - i : i]
    lut[i * 4] = c[0]; lut[i * 4 + 1] = c[1]; lut[i * 4 + 2] = c[2]; lut[i * 4 + 3] = 255
  }
  lutCache.set(key, lut)
  return lut
}

// 某归一化位置的 css 颜色（图例、等值线用）。shade<1 压暗：
// 等值线取「自己那一档的色」是本软件的制图口径，但线若与它所压的那片填充同色就看不见了，
// 压暗一档既保住色相归属、又把线从面里分出来（不加衬底——衬底一律没有）。
export function lutCss(scheme, invert, u, shade) {
  const lut = colorLut(scheme, invert)
  // 只取 RGB：等值线要在任何档位都看得见，而气象色阶低端的 alpha 接近 0 —— 线不能跟着一起隐形
  const k = Math.max(0, Math.min(LUT_N - 1, Math.round(u * (LUT_N - 1)))) * 4
  const f = shade > 0 ? shade : 1
  return f === 1
    ? `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`
    : `rgb(${Math.round(lut[k] * f)},${Math.round(lut[k + 1] * f)},${Math.round(lut[k + 2] * f)})`
}

/**
 * 自动值域。
 *   'p2p98'  按 2%–98% 分位拉伸（默认）：降雨率这类长尾场（全球 98% 的地方 <80 mm/h，
 *            极大值却能到 140+）用极值定域会把主区压成一个颜色。
 *   'minmax' 全域极值，读图要覆盖极端值时用。
 * 返回 [lo, hi]；统计缺失或退化时返回 null。
 */
export function autoDomain(stats, mode) {
  if (!stats) return null
  let lo, hi
  if (mode === 'minmax') { lo = stats.min; hi = stats.max }
  else { lo = stats.p2; hi = stats.p98 }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  if (hi <= lo) { hi = stats.max; lo = stats.min }
  if (hi <= lo) { hi = lo + 1 }
  return [lo, hi]
}

/**
 * 值栅格 → RGBA 位图。
 * @param {Float32Array} values 行 0 = 北
 * @param {Uint8Array|null} land 陆海掩膜（1=陆），landOnly 时用
 * @param {object} o { lo, hi, scheme, invert, bands(0=连续), landOnly, opacity(0~1，整层再乘一道),
 *                     levels(升序锚点数组；给了就走锚点归一，lo/hi 不参与) }
 * @returns {Uint8ClampedArray} 长度 = values.length × 4
 */
export function colorize(values, land, o) {
  const lo = o.lo, hi = o.hi, span = (hi - lo) || 1
  const lut = colorLut(o.scheme || 'turbo', !!o.invert)
  const bands = Math.max(0, Math.round(o.bands || 0))
  const landOnly = !!o.landOnly && !!land
  // 整层不透明度在这里只作**乘数**：色阶自带的逐级 alpha 表达「这儿有没有天气」，
  // 这个数表达「这层图压多重」，两件事各管各的，相乘才都保得住。
  const mul = Math.max(0, Math.min(1, o.opacity != null ? o.opacity : 1))
  const lv = Array.isArray(o.levels) && o.levels.length > 1 ? o.levels : null
  const N = values.length
  const out = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) {
    const v = values[i]
    if (v !== v || (landOnly && !land[i])) continue     // 透明（out 默认全 0）
    let u = lv ? levelNorm(v, lv) : (v - lo) / span
    u = u < 0 ? 0 : u > 1 ? 1 : u
    // 分级填色：落进第 k 档 → 取该档中点色，档与档之间是硬边（边界即等值线，工程读图）
    if (bands > 0) u = (Math.min(bands - 1, Math.floor(u * bands)) + 0.5) / bands
    const k = ((u * (LUT_N - 1) + 0.5) | 0) * 4
    const p = i * 4
    out[p] = lut[k]; out[p + 1] = lut[k + 1]; out[p + 2] = lut[k + 2]; out[p + 3] = lut[k + 3] * mul
  }
  return out
}

// 图例色标：分级 → 每档一色；连续 → 32 级近似渐变。返回 [{ css, u }]（低→高）
// ★ 气象色阶带 alpha 时，图例也**照实带 alpha 出** —— 图上低值是半透明的，图例却画成实色，
//   人就会以为那一档在图上是纯色块，反而读错。让面板底色透上来才是真的。
export function legendStops(scheme, invert, bands) {
  const n = bands > 0 ? bands : 32
  const lut = colorLut(scheme, invert)
  const out = []
  for (let i = 0; i < n; i++) {
    const u = bands > 0 ? (i + 0.5) / n : i / (n - 1)
    const k = Math.max(0, Math.min(LUT_N - 1, Math.round(u * (LUT_N - 1)))) * 4
    const a = lut[k + 3]
    out.push({
      u,
      css: a >= 255 ? `rgb(${lut[k]},${lut[k + 1]},${lut[k + 2]})`
        : `rgba(${lut[k]},${lut[k + 1]},${lut[k + 2]},${(a / 255).toFixed(3)})`
    })
  }
  return out
}

// 分档边界值（分级填色时图例上的刻度）
export function bandEdges(lo, hi, bands) {
  const n = Math.max(1, Math.round(bands || 0))
  const out = []
  for (let i = 0; i <= n; i++) out.push(lo + (hi - lo) * i / n)
  return out
}

/**
 * 栅格取值（状态栏读数）：双线性，行 0 = 北。
 * 注意这是**已显示的那张栅格**的值——格距比原生数据粗时与引擎取数会有微差，界面须如实说明。
 */
export function valueAt(field, lat, lon) {
  if (!field || !field.values) return NaN
  const { nx, ny, bbox } = field
  let x = lon
  const span = bbox.lonMax - bbox.lonMin
  if (span >= 359.9) { while (x < bbox.lonMin) x += 360; while (x >= bbox.lonMin + 360) x -= 360 }
  const fi = (x - bbox.lonMin) / span * nx - 0.5
  const fj = (bbox.latMax - lat) / (bbox.latMax - bbox.latMin) * ny - 0.5
  if (fi < -0.5 || fi > nx - 0.5 || fj < -0.5 || fj > ny - 0.5) return NaN
  const i0 = Math.max(0, Math.min(nx - 1, Math.floor(fi))), j0 = Math.max(0, Math.min(ny - 1, Math.floor(fj)))
  const i1 = Math.min(nx - 1, i0 + 1), j1 = Math.min(ny - 1, j0 + 1)
  const u = Math.max(0, Math.min(1, fi - i0)), v = Math.max(0, Math.min(1, fj - j0))
  const z = field.values
  const a = z[j0 * nx + i0], b = z[j0 * nx + i1], c = z[j1 * nx + i0], d = z[j1 * nx + i1]
  if (a !== a || b !== b || c !== c || d !== d) return NaN
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

// 读数格式化：按字段小数位，顺带给大数加千分位（海拔 8848 m 这类）
export function fmtValue(v, dec) {
  if (!Number.isFinite(v)) return '—'
  const d = Number.isFinite(dec) ? dec : 2
  const s = v.toFixed(d)
  return Math.abs(v) >= 10000 ? Number(s).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : s
}

/**
 * RGBA → canvas（等经纬位图）。渲染端拿它给 2D drawImage / 3D 贴图球用。
 * 传入 canvas 可复用（换配色不重新分配）。
 */
export function rasterCanvas(rgba, nx, ny, canvas) {
  const cv = canvas && canvas.width === nx && canvas.height === ny ? canvas : Object.assign(document.createElement('canvas'), { width: nx, height: ny })
  const ctx = cv.getContext('2d')
  ctx.putImageData(new ImageData(rgba, nx, ny), 0, 0)
  return cv
}
