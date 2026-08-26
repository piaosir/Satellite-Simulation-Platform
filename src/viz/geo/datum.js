// 大地基准（仅作用于【显示与输入】的呈现层）。
//
// ★ 铁律：平台内部一律 WGS-84 十进制度。本模块只在「读数往外出」与「用户往里填」这两端做换算，
//   不碰任何存储、计算与导出 —— 换基准后导出的 KML / Excel / GXT / 报告必须与切换前字节一致。
//
// 三档：
//   wgs84     默认，恒等
//   cgcs2000  与 WGS-84 的差在厘米量级，远低于本平台任何一处显示精度（最细到 1e-6 度 ≈ 0.1 m）。
//             ★ 刻意【不做任何几何变换】——做了反而是拿噪声冒充精度。只改读数与报告里的口径标注。
//   gcj02     真实的非线性偏移（几十到几百米），只在中国境内生效（算法自带境内判定）。
//             正算用公开的标准算法；反算用迭代（不用近似反变换，那在边界附近误差大）。
const A = 6378245.0            // GCJ-02 用的是克拉索夫斯基椭球参数（算法本身就这么定义，不是笔误）
const EE = 0.00669342162296594323

export const DATUMS = [
  { k: 'wgs84', zh: 'WGS-84', en: 'WGS-84' },
  { k: 'cgcs2000', zh: 'CGCS2000', en: 'CGCS2000' },
  { k: 'gcj02', zh: 'GCJ-02', en: 'GCJ-02' }
]
export const isDatum = (k) => DATUMS.some((d) => d.k === k)
export const datumZh = (k) => (DATUMS.find((d) => d.k === k) || DATUMS[0]).zh

// 境外不偏移（GCJ-02 的定义如此）。这个粗框是算法原本就带的，不是精确国界。
export function outOfChina(lon, lat) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55)
}
function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return r
}
function tLon(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return r
}
// WGS-84 → GCJ-02
export function wgs2gcj(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat]
  let dLat = tLat(lon - 105, lat - 35), dLon = tLon(lon - 105, lat - 35)
  const rad = lat / 180 * Math.PI
  let magic = Math.sin(rad)
  magic = 1 - EE * magic * magic
  const sq = Math.sqrt(magic)
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sq) * Math.PI)
  dLon = (dLon * 180) / (A / sq * Math.cos(rad) * Math.PI)
  return [lon + dLon, lat + dLat]
}
// GCJ-02 → WGS-84：不动点迭代。正变换在中国范围内是强收缩的，10 轮已到 1e-9 度以下。
export function gcj2wgs(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat]
  let x = lon, y = lat
  for (let i = 0; i < 10; i++) {
    const [gx, gy] = wgs2gcj(x, y)
    const ex = gx - lon, ey = gy - lat
    if (Math.abs(ex) < 1e-11 && Math.abs(ey) < 1e-11) break
    x -= ex; y -= ey
  }
  return [x, y]
}

// 内部 WGS-84 → 显示值
export function toDisplay(lon, lat, datum) {
  return datum === 'gcj02' ? wgs2gcj(lon, lat) : [lon, lat]
}
// 显示/输入值 → 内部 WGS-84
export function fromDisplay(lon, lat, datum) {
  return datum === 'gcj02' ? gcj2wgs(lon, lat) : [lon, lat]
}
