// 覆盖填充面配色：dB → rgba。L2a（改色仅此层，亚帧）。
// 方案为近似采样点，线性插值即可（覆盖图只需视觉区分，不追求感知均匀严格性）。

const SCHEMES = {
  turbo: [[48, 18, 59], [62, 74, 211], [38, 168, 234], [33, 220, 169], [148, 237, 64], [241, 184, 41], [232, 92, 24], [148, 24, 17]],
  jet: [[0, 0, 131], [0, 60, 255], [0, 200, 255], [80, 255, 140], [230, 255, 40], [255, 120, 0], [150, 0, 0]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  inferno: [[0, 0, 4], [40, 11, 84], [101, 21, 110], [159, 42, 99], [212, 72, 66], [245, 125, 21], [250, 193, 39], [252, 255, 164]],
  gray: [[28, 30, 34], [120, 124, 130], [232, 236, 240]]
}
export const SCHEME_NAMES = Object.keys(SCHEMES)

function sample(stops, u) {
  const n = stops.length - 1
  if (u <= 0) return stops[0]
  if (u >= 1) return stops[n]
  const x = u * n, i = Math.floor(x), t = x - i, a = stops[i], b = stops[i + 1]
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// db 网格 + 域 [lo,hi] → rgba。floor: 低于该值（或 NaN）透明（无覆盖）。
export function fieldRgba(db, lo, hi, scheme = 'turbo', floor = null) {
  const stops = SCHEMES[scheme] || SCHEMES.turbo
  const N = db.length, rgba = new Uint8ClampedArray(N * 4), span = (hi - lo) || 1
  for (let k = 0; k < N; k++) {
    const v = db[k]
    if (v !== v || (floor != null && v < floor)) { rgba[k * 4 + 3] = 0; continue }
    const c = sample(stops, (v - lo) / span)
    rgba[k * 4] = c[0]; rgba[k * 4 + 1] = c[1]; rgba[k * 4 + 2] = c[2]; rgba[k * 4 + 3] = 255
  }
  return rgba
}

// 某 dB 在域内的 css 颜色（图例/等值线用）
export function colorAt(db, lo, hi, scheme = 'turbo') {
  const c = sample(SCHEMES[scheme] || SCHEMES.turbo, ((db - lo) / ((hi - lo) || 1)))
  return `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`
}

// 从方案均匀采样 n 档颜色（电平表/分带用），返回 [[r,g,b]...]（低→高）
export function schemeColorsRGB(scheme, n) {
  const stops = SCHEMES[scheme] || SCHEMES.turbo, out = []
  for (let i = 0; i < n; i++) out.push(sample(stops, n > 1 ? i / (n - 1) : 0.5).map((x) => x | 0))
  return out
}
export const rgbCss = (c) => `rgb(${c[0]},${c[1]},${c[2]})`
export function cssRgb(css) { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(css || ''); return m ? [+m[1], +m[2], +m[3]] : [255, 255, 255] }

// SATSOFT 式分带填充：levelsAsc 升序绝对电平，colorsAsc 同序 [r,g,b]。
// 点值落在 ≥levelsAsc[k] 的最高档→该色（嵌套带）；低于最低档→透明（无覆盖）。
export function fieldBands(db, levelsAsc, colorsAsc) {
  const N = db.length, rgba = new Uint8ClampedArray(N * 4)
  for (let k = 0; k < N; k++) {
    const v = db[k]
    if (v !== v) { rgba[k * 4 + 3] = 0; continue }
    let band = -1
    for (let i = 0; i < levelsAsc.length; i++) { if (v >= levelsAsc[i]) band = i; else break }
    if (band < 0) { rgba[k * 4 + 3] = 0; continue }
    const c = colorsAsc[band]
    rgba[k * 4] = c[0]; rgba[k * 4 + 1] = c[1]; rgba[k * 4 + 2] = c[2]; rgba[k * 4 + 3] = 255
  }
  return rgba
}
