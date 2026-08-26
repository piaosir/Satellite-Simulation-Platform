// 坐标的显示格式与解析（双向）。五档：十进制度 / 度分秒 / UTM / MGRS / 高斯-克吕格（3°带、6°带）。
//
// ★ 铁律：平台内部一律 WGS-84 十进制度。本模块只在「读数往外出」与「用户往里填」这两端生效，
//   不碰任何存储、计算与导出。换格式不改变任何一个存下来的数。
// ★ 全部手写，不引 proj4。横轴墨卡托用 Krüger 级数（与 UTM/GK 官方一致），
//   往返误差在 |lat|<84° 全带内优于 1e-9 度，见 packages/core/test/coordFormat.test.mjs。
//
// UTM 与高斯-克吕格是同一套横轴墨卡托，差别只在三处：
//   带宽    UTM 6° / GK 可 6° 或 3°
//   中央子午线尺度  UTM 0.9996 / GK 1.0
//   假东    都 500 km；GK 的中国习惯在东坐标前冠带号（如 20500000），故本模块的 GK 带带号
const A = 6378137.0                    // WGS-84 长半轴
const F = 1 / 298.257223563
const E2 = F * (2 - F)
const N = F / (2 - F)

// Krüger 级数系数（到 6 阶，UTM 精度绰绰有余）
const A_BAR = A / (1 + N) * (1 + N * N / 4 + N * N * N * N / 64)
const ALPHA = [
  N / 2 - 2 / 3 * N ** 2 + 5 / 16 * N ** 3 + 41 / 180 * N ** 4,
  13 / 48 * N ** 2 - 3 / 5 * N ** 3 + 557 / 1440 * N ** 4,
  61 / 240 * N ** 3 - 103 / 140 * N ** 4,
  49561 / 161280 * N ** 4
]
const BETA = [
  N / 2 - 2 / 3 * N ** 2 + 37 / 96 * N ** 3 - 1 / 360 * N ** 4,
  1 / 48 * N ** 2 + 1 / 15 * N ** 3 - 437 / 1440 * N ** 4,
  17 / 480 * N ** 3 - 37 / 840 * N ** 4,
  4397 / 161280 * N ** 4
]
const DEG = Math.PI / 180
const wrapLon = (l) => ((l + 180) % 360 + 360) % 360 - 180

// 横轴墨卡托正算：经纬度(度) → { x 东, y 北 }（米，未加假东/假北）
export function tmForward(lon, lat, lon0, k0) {
  const phi = lat * DEG, dl = wrapLon(lon - lon0) * DEG
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - 2 * Math.sqrt(N) / (1 + N) * Math.atanh(2 * Math.sqrt(N) / (1 + N) * Math.sin(phi)))
  const xi0 = Math.atan(t / Math.cos(dl))
  const eta0 = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t))
  let xi = xi0, eta = eta0
  for (let j = 1; j <= 4; j++) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0)
    eta += ALPHA[j - 1] * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0)
  }
  return { x: k0 * A_BAR * eta, y: k0 * A_BAR * xi }
}
// 横轴墨卡托反算：{x,y}（未含假东/假北） → [lon, lat]（度）
export function tmInverse(x, y, lon0, k0) {
  const xi = y / (k0 * A_BAR), eta = x / (k0 * A_BAR)
  let xi1 = xi, eta1 = eta
  for (let j = 1; j <= 4; j++) {
    xi1 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta)
    eta1 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta)
  }
  const chi = Math.asin(Math.max(-1, Math.min(1, Math.sin(xi1) / Math.cosh(eta1))))
  // 由等角纬度 chi 反解大地纬度：级数（与 BETA 同源的 delta 系数）
  let phi = chi
  const D = [
    2 * N - 2 / 3 * N ** 2 - 2 * N ** 3 + 116 / 45 * N ** 4,
    7 / 3 * N ** 2 - 8 / 5 * N ** 3 - 227 / 45 * N ** 4,
    56 / 15 * N ** 3 - 136 / 35 * N ** 4,
    4279 / 630 * N ** 4
  ]
  for (let j = 1; j <= 4; j++) phi += D[j - 1] * Math.sin(2 * j * chi)
  const lam = Math.atan2(Math.sinh(eta1), Math.cos(xi1))
  return [wrapLon(lon0 + lam / DEG), phi / DEG]
}

// ---------- UTM ----------
export const utmZone = (lon) => Math.floor((wrapLon(lon) + 180) / 6) + 1
export const utmLon0 = (zone) => (zone - 1) * 6 - 180 + 3
const UTM_K0 = 0.9996
// UTM 纬度带字母（C…X，去掉 I 与 O）
const BANDS = 'CDEFGHJKLMNPQRSTUVWX'
export function utmBand(lat) {
  if (lat < -80 || lat >= 84) return null
  return BANDS[Math.max(0, Math.min(BANDS.length - 1, Math.floor((lat + 80) / 8)))]
}
export function toUtm(lon, lat) {
  const zone = utmZone(lon)
  const p = tmForward(lon, lat, utmLon0(zone), UTM_K0)
  return { zone, band: utmBand(lat), north: lat >= 0, e: p.x + 500000, n: p.y + (lat < 0 ? 10000000 : 0) }
}
export function fromUtm(zone, north, e, n) {
  return tmInverse(e - 500000, n - (north ? 0 : 10000000), utmLon0(zone), UTM_K0)
}

// ---------- MGRS ----------
// 100 km 方格字母：列按带号循环三组（AJS 起），行按带号奇偶两组（A / F 起），行字母 20 个一循环。
const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ']
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV'
export function toMgrs(lon, lat, digits = 5) {
  const u = toUtm(lon, lat)
  if (!u.band) return null
  const set = (u.zone - 1) % 3
  const col = COL_SETS[set][Math.floor(u.e / 100000) - 1]
  const rowShift = (u.zone % 2 === 0) ? 5 : 0     // 偶数带行字母从 F 起
  const row = ROW_LETTERS[(Math.floor(u.n / 100000) + rowShift) % 20]
  const d = Math.max(1, Math.min(5, digits | 0))
  const p = Math.pow(10, 5 - d)
  const ee = String(Math.floor((u.e % 100000) / p)).padStart(d, '0')
  const nn = String(Math.floor((u.n % 100000) / p)).padStart(d, '0')
  return u.zone + u.band + col + row + ee + nn
}
export function fromMgrs(str) {
  const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])\s*([A-HJ-NP-Z])\s*([A-HJ-NP-V])\s*(\d*)\s*$/i.exec(String(str || ''))
  if (!m) return null
  const zone = +m[1], band = m[2].toUpperCase(), col = m[3].toUpperCase(), row = m[4].toUpperCase()
  if (zone < 1 || zone > 60 || BANDS.indexOf(band) < 0) return null
  const set = (zone - 1) % 3
  const ci = COL_SETS[set].indexOf(col)
  if (ci < 0) return null
  const e100 = (ci + 1) * 100000
  const rowShift = (zone % 2 === 0) ? 5 : 0
  let ri = ROW_LETTERS.indexOf(row)
  if (ri < 0) return null
  ri = (ri - rowShift + 20) % 20
  // 行字母 20 个一循环（2000 km），用纬度带定位到正确的那一圈
  const latBase = (BANDS.indexOf(band) * 8 - 80)
  const approxN = tmForward(utmLon0(zone), latBase, utmLon0(zone), UTM_K0).y + (latBase < 0 ? 10000000 : 0)
  let n100 = ri * 100000
  while (n100 < approxN - 1000000) n100 += 2000000
  while (n100 > approxN + 1000000) n100 -= 2000000
  const rest = m[5] || ''
  if (rest.length % 2) return null
  const d = rest.length / 2
  const p = d ? Math.pow(10, 5 - d) : 100000
  const de = d ? +rest.slice(0, d) * p : 0
  const dn = d ? +rest.slice(d) * p : 0
  return fromUtm(zone, latBase >= 0, e100 + de, n100 + dn)
}

// ---------- 高斯-克吕格（3° 带 / 6° 带，带号冠在东坐标前） ----------
// ★ 带号按【中国习惯】从 0°E 起编：6° 带 n=⌊L/6⌋+1（1…60，中央子午线 6n−3）、
//   3° 带 n=round(L/3)（1…120，中央子午线 3n）。与 UTM 从 180°W 起编的那套不是一回事，别混。
export const gkZone = (lon, width) => {
  const L = ((wrapLon(lon) % 360) + 360) % 360
  if (width === 3) { const n = Math.round(L / 3); return n === 0 || n === 120 ? 120 : n }
  return Math.floor(L / 6) + 1
}
export const gkLon0 = (zone, width) => wrapLon(width === 3 ? zone * 3 : zone * 6 - 3)
export function toGk(lon, lat, width) {
  const zone = gkZone(lon, width)
  const p = tmForward(lon, lat, gkLon0(zone, width), 1)
  return { zone, e: p.x + 500000, n: p.y, eZoned: zone * 1000000 + p.x + 500000 }
}
export function fromGk(zone, e, n, width) {
  const ee = e > 1000000 ? e % 1000000 : e        // 允许带带号的东坐标
  return tmInverse(ee - 500000, n, gkLon0(zone, width), 1)
}

// ---------- 格式化 / 解析 总入口 ----------
export const FORMATS = [
  { k: 'deg', zh: '十进制度', en: 'Decimal degrees' },
  { k: 'dms', zh: '度分秒', en: 'DMS' },
  { k: 'utm', zh: 'UTM', en: 'UTM' },
  { k: 'mgrs', zh: 'MGRS', en: 'MGRS' },
  { k: 'gk3', zh: '高斯-克吕格 3°带', en: 'Gauss–Krüger 3°' },
  { k: 'gk6', zh: '高斯-克吕格 6°带', en: 'Gauss–Krüger 6°' }
]
export const isFormat = (k) => FORMATS.some((f) => f.k === k)

function dmsOne(v, posC, negC, secDigits) {
  const s = v < 0 ? negC : posC
  let x = Math.abs(v)
  let d = Math.floor(x); x = (x - d) * 60
  let m = Math.floor(x); let sec = (x - m) * 60
  const p = Math.pow(10, secDigits)
  sec = Math.round(sec * p) / p
  if (sec >= 60) { sec -= 60; m += 1 }
  if (m >= 60) { m -= 60; d += 1 }
  return d + '°' + String(m).padStart(2, '0') + '′' + sec.toFixed(secDigits).padStart(secDigits ? 3 + secDigits : 2, '0') + '″' + s
}

// 经纬度（WGS-84 十进制度）→ 显示串。digits 只对十进制度与度分秒的末位有意义。
export function formatLonLat(lon, lat, fmt, digits = 4) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return ''
  switch (fmt) {
    case 'dms':
      return dmsOne(lat, 'N', 'S', Math.max(0, digits - 2)) + ' ' + dmsOne(lon, 'E', 'W', Math.max(0, digits - 2))
    case 'utm': {
      const u = toUtm(lon, lat)
      return u.zone + (u.band || '') + ' ' + Math.round(u.e) + 'E ' + Math.round(u.n) + 'N'
    }
    case 'mgrs':
      return toMgrs(lon, lat, 5) || ''
    case 'gk3': case 'gk6': {
      const w = fmt === 'gk3' ? 3 : 6
      const g = toGk(lon, lat, w)
      return g.zone + '带 ' + Math.round(g.eZoned) + 'E ' + Math.round(g.n) + 'N'
    }
    default:
      return lat.toFixed(digits) + (lat >= 0 ? '°N ' : '°S ') + Math.abs(lon).toFixed(digits) + (lon >= 0 ? '°E' : '°W')
  }
}

// 显示串 → [lon, lat]（WGS-84 十进制度）；解析不了返回 null。
// 十进制度与度分秒都接受「纬 经」与「经 纬」两种次序：带 N/S/E/W 时按字母定，纯数字时按「纬 经」。
export function parseLonLat(str, fmt) {
  const s = String(str || '').trim()
  if (!s) return null
  if (fmt === 'mgrs') return fromMgrs(s)
  if (fmt === 'utm') {
    const m = /^\s*(\d{1,2})\s*([C-HJ-NP-X])?\s+(-?[\d.]+)\s*E?\s+(-?[\d.]+)\s*N?\s*$/i.exec(s)
    if (!m) return null
    const band = m[2] ? m[2].toUpperCase() : null
    const north = band ? BANDS.indexOf(band) >= BANDS.indexOf('N') : +m[4] < 10000000 / 2
    return fromUtm(+m[1], north, +m[3], +m[4])
  }
  if (fmt === 'gk3' || fmt === 'gk6') {
    const w = fmt === 'gk3' ? 3 : 6
    const m = /^\s*(\d{1,3})\s*带?\s+(-?[\d.]+)\s*E?\s+(-?[\d.]+)\s*N?\s*$/i.exec(s)
    if (!m) return null
    return fromGk(+m[1], +m[2], +m[3], w)
  }
  // 十进制度 / 度分秒：两遍。
  // ★ 一遍到底会出错：分与秒那两组是可选的，遇上「39.9073 116.3912」正则会贪心地把第二个数
  //   当成第一个数的「分」，于是只抓到一个坐标。故先按【必须带度符号】的严格 DMS 抓一遍，
  //   抓不满两组再退回「纯数值 + 可选半球字母」。
  const grab = (re) => {
    const out = []
    let m
    re.lastIndex = 0
    while (out.length < 2 && (m = re.exec(s)) !== null) {
      if (re.lastIndex === m.index) re.lastIndex++
      const sign = m[1][0] === '-' ? -1 : 1
      let v = Math.abs(+m[1]) + (m[2] ? +m[2] / 60 : 0) + (m[3] ? +m[3] / 3600 : 0)
      v *= sign
      const h = (m[m.length - 1] || '').toUpperCase()
      if (h === 'S' || h === 'W') v = -Math.abs(v)
      else if (h === 'N' || h === 'E') v = Math.abs(v)
      out.push({ v, h })
    }
    return out
  }
  let out = grab(/(-?\d+(?:\.\d+)?)\s*[°d]\s*(?:(\d+(?:\.\d+)?)\s*[′'m]\s*(?:(\d+(?:\.\d+)?)\s*[″"s]?)?)?\s*([NSEWnsew])?/g)
  if (out.length < 2) out = grab(/(-?\d+(?:\.\d+)?)\s*°?\s*()()([NSEWnsew])?/g)
  if (out.length < 2) return null
  const byLetter = out.find((x) => x.h === 'E' || x.h === 'W')
  if (byLetter) {
    const lonv = byLetter.v, latv = out.find((x) => x !== byLetter).v
    return [wrapLon(lonv), Math.max(-90, Math.min(90, latv))]
  }
  return [wrapLon(out[1].v), Math.max(-90, Math.min(90, out[0].v))]   // 纯数字：纬 经
}
