// 实验 2：GSO 链路预算的球地球仰角 / 斜距（linkCalculator.calculateSatelliteAngle + 余弦定理斜距）
// 对 WGS84 椭球精确解（大地纬度 + 站高 + 椭球法线天顶）的偏差；并给 P.834 折射修正量级
const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const LC = require(path.join(ROOT, 'packages/core/utils/linkCalculator.js'))
const DEG = Math.PI / 180
const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F)
const R_GEO = 42164.17
function geod2ecef(latD, lonD, hKm) {
  const la = latD * DEG, lo = lonD * DEG, s = Math.sin(la), c = Math.cos(la)
  const N = A / Math.sqrt(1 - E2 * s * s)
  return [(N + hKm) * c * Math.cos(lo), (N + hKm) * c * Math.sin(lo), (N * (1 - E2) + hKm) * s]
}
function exact(latD, lonD, hKm, satLon) {
  const o = geod2ecef(latD, lonD, hKm)
  const s = [R_GEO * Math.cos(satLon * DEG), R_GEO * Math.sin(satLon * DEG), 0]
  const d = [s[0] - o[0], s[1] - o[1], s[2] - o[2]]
  const rng = Math.hypot(d[0], d[1], d[2])
  const la = latD * DEG, lo = lonD * DEG
  const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)]
  const e = [-Math.sin(lo), Math.cos(lo), 0]
  const n = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)]
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const el = Math.asin(dot(d, up) / rng) / DEG
  let az = Math.atan2(dot(d, e), dot(d, n)) / DEG; if (az < 0) az += 360
  return { el, az, rng }
}
function sphereSlant(latD, lonD, satLon) {
  const Re = 6378.137, r = 6378.137 + 35786
  const c = Math.cos(latD * DEG) * Math.cos((lonD - satLon) * DEG)
  return Math.sqrt(Re * Re + r * r - 2 * Re * r * c)
}
// ITU-R P.834-9 §1 式 (1)：τ(h,θ) 度，θ 为几何仰角（度），h 站高 km
const tauP834 = (h, th) => 1 / (1.314 + 0.6437 * th + 0.02869 * th * th + h * (0.2305 + 0.09428 * th + 0.01096 * th * th) + 0.008583 * h * h)

const ST = [
  ['北京', 39.90, 116.40, 0.05], ['哈尔滨', 45.75, 126.63, 0.15], ['漠河', 52.97, 122.53, 0.30],
  ['乌鲁木齐', 43.83, 87.62, 0.90], ['喀什', 39.47, 75.99, 1.29], ['拉萨', 29.65, 91.13, 3.65],
  ['三亚', 18.25, 109.50, 0.01], ['香港', 22.30, 114.17, 0.05]
]
const SATS = [76.5, 87.5, 101.4, 110.5, 125.0, 142.0, 163.0]
let maxDel = 0, maxDr = 0, worst = null
console.log('站点  卫星  球式仰角  椭球仰角  Δ仰角°  球式斜距  椭球斜距  Δ斜距km  ΔFSL dB  P834τ°')
for (const [nm, la, lo, h] of ST) {
  for (const sl of SATS) {
    const sp = LC.calculateSatelliteAngle(la, lo, sl)
    const ex = exact(la, lo, h, sl)
    if (ex.el < 0) continue
    const sr = sphereSlant(la, lo, sl)
    const dEl = sp.elevation - ex.el, dR = sr - ex.rng
    const dFsl = 20 * Math.log10(sr / ex.rng)
    if (Math.abs(dEl) > Math.abs(maxDel)) { maxDel = dEl; worst = [nm, sl, sp.elevation, ex.el] }
    if (Math.abs(dR) > Math.abs(maxDr)) maxDr = dR
    if ([87.5, 110.5, 163.0].includes(sl)) console.log(nm.padEnd(5), String(sl).padStart(5), sp.elevation.toFixed(3).padStart(8), ex.el.toFixed(3).padStart(8), dEl.toFixed(3).padStart(7), sr.toFixed(2).padStart(9), ex.rng.toFixed(2).padStart(9), dR.toFixed(2).padStart(7), dFsl.toFixed(4).padStart(8), tauP834(h, ex.el).toFixed(3).padStart(7))
  }
}
console.log('最大 |Δ仰角| = ' + maxDel.toFixed(3) + '°（' + worst[0] + ' → ' + worst[1] + '°E，球式 ' + worst[2].toFixed(3) + '° / 椭球 ' + worst[3].toFixed(3) + '°）；最大 |Δ斜距| = ' + maxDr.toFixed(2) + ' km')
console.log('P.834 折射 τ(h=0)：0°→' + tauP834(0, 0).toFixed(3) + '°  1°→' + tauP834(0, 1).toFixed(3) + '°  3°→' + tauP834(0, 3).toFixed(3) + '°  5°→' + tauP834(0, 5).toFixed(3) + '°  10°→' + tauP834(0, 10).toFixed(3) + '°  20°→' + tauP834(0, 20).toFixed(3) + '°  45°→' + tauP834(0, 45).toFixed(4) + '°')
// 大口径站 3 dB 波束宽（70λ/D）对照
for (const [f, D] of [[12.5, 9], [20, 9], [30, 13], [14, 13]]) console.log('  ' + f + ' GHz ' + D + ' m 天线 θ3dB = ' + (70 * 0.299792458 / f / D).toFixed(3) + '°')
