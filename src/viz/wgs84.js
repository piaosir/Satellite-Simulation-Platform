// WGS84 大地测量工具 —— 平台「几何」统一基准。
// 约定：所有由物理几何反算/正算的经纬度都走这里（GRD 覆盖投影、覆盖足迹圈、等仰角线…）。
// 渲染层（3D 球 / 2D 等距圆柱）仍按 geodetic-纬度-贴球 的标准约定绘制，喂入的经纬度均为大地坐标。
// 链路预算数值保持其自有球面常量，不受本模块影响。
//
// 椭球：WGS84（与 satellite.js 的 eciToGeodetic / geodeticToEcf 同源，保证全平台一致）。

export const A = 6378.137                 // 长半轴（赤道半径）km
export const B = 6356.7523142             // 短半轴（极半径）km
export const F = (A - B) / A              // 扁率
export const E2 = 2 * F - F * F           // 第一偏心率平方
export const RS_GEO = 42164.17            // GEO 地心距 km（标准）
const DEG = Math.PI / 180

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n] }

// 大地坐标(度,度,km) -> ECEF(km)
export function geodeticToEcef(lonDeg, latDeg, hKm = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG
  const sl = Math.sin(lat), cl = Math.cos(lat)
  const N = A / Math.sqrt(1 - E2 * sl * sl)
  return [
    (N + hKm) * cl * Math.cos(lon),
    (N + hKm) * cl * Math.sin(lon),
    (N * (1 - E2) + hKm) * sl
  ]
}

// ECEF(km) -> 大地坐标 {lon(度), lat(度), h(km)}（定点迭代，与 satellite.js 同法）
export function ecefToGeodetic(x, y, z) {
  const R = Math.hypot(x, y)
  const lon = Math.atan2(y, x)
  let lat = Math.atan2(z, R), C = 1
  for (let k = 0; k < 20; k++) {
    const s = Math.sin(lat)
    C = 1 / Math.sqrt(1 - E2 * s * s)
    lat = Math.atan2(z + A * C * E2 * s, R)
  }
  return { lon: lon / DEG, lat: lat / DEG, h: R / Math.cos(lat) - A * C }
}

// 椭球表面法线方向（大地「天顶」单位矢量）
export function geodeticUp(lonDeg, latDeg) {
  const lat = latDeg * DEG, lon = lonDeg * DEG, cl = Math.cos(lat)
  return [cl * Math.cos(lon), cl * Math.sin(lon), Math.sin(lat)]
}

// 射线 o + t·d（ECEF km）与 WGS84 椭球面(h=0)求最近交点；未命中返回 null。
export function rayEllipsoid(o, d) {
  const ox = o[0] / A, oy = o[1] / A, oz = o[2] / B
  const dx = d[0] / A, dy = d[1] / A, dz = d[2] / B
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (ox * dx + oy * dy + oz * dz)
  const c = ox * ox + oy * oy + oz * oz - 1
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t < 0) return null
  return [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]
}

// 把任意点沿地心方向投到椭球面（掠地平兜底用）
function projectToSurface(p) {
  const s = 1 / Math.hypot(p[0] / A, p[1] / A, p[2] / B)
  return [p[0] * s, p[1] * s, p[2] * s]
}

// 射线 o + t·d（ECEF km）与 WGS84 椭球求交，并返回「地平裕度」m（含正负号）：
//   m = 判别式 disc = b²−4ac。 m>0 命中地球内侧、m=0 恰切（=地球可见地平/0°仰角线）、m<0 掠地平外。
// 始终返回一个椭球面点 p：命中取真实交点；未命中(或反向)取最近趋近点投到椭球（即地平上的点）。
// 用途：覆盖网格逐点既能落地又带「是否越过地平」的连续标量，供 3D 片元 discard / 2D 裁剪精确切在 0°仰角线。
export function rayEllipsoidMargin(o, d) {
  const ox = o[0] / A, oy = o[1] / A, oz = o[2] / B
  const dx = d[0] / A, dy = d[1] / A, dz = d[2] / B
  const a = dx * dx + dy * dy + dz * dz
  const b = 2 * (ox * dx + oy * dy + oz * dz)
  const c = ox * ox + oy * oy + oz * oz - 1
  const disc = b * b - 4 * a * c
  if (disc >= 0) {
    const t = (-b - Math.sqrt(disc)) / (2 * a)
    if (t >= 0) return { p: [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]], m: disc }
  }
  const t = -b / (2 * a)   // 未命中：取最近趋近点，再投到椭球得地平点
  const px = o[0] + t * d[0], py = o[1] + t * d[1], pz = o[2] + t * d[2]
  return { p: projectToSurface([px, py, pz]), m: disc < 0 ? disc : -1 }
}

// 大地点对卫星(ECEF)的仰角（度，椭球法线为基准）
export function elevationDeg(lonDeg, latDeg, satEcef) {
  const obs = geodeticToEcef(lonDeg, latDeg, 0)
  const r = sub(satEcef, obs)
  const up = geodeticUp(lonDeg, latDeg)
  return Math.asin(Math.max(-1, Math.min(1, dot(r, up) / Math.hypot(r[0], r[1], r[2])))) / DEG
}

// 与 d0 正交的一组基
function basisAround(d0) {
  const ref = Math.abs(d0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
  const e1 = norm(cross(d0, ref))
  return [e1, cross(d0, e1)]
}

// 覆盖足迹圈（WGS84）：卫星 ECEF(km)、星上锥半角 eta(rad) -> 地面边缘 [{lat,lon}...]。
// 以地心天底(−S 方向)为锥轴，逐方位射线交椭球；掠地平未命中时取最近趋近点投影到椭球。
export function footprintEllipsoid(satEcef, eta, N = 72) {
  const d0 = norm([-satEcef[0], -satEcef[1], -satEcef[2]])
  const [e1, e2] = basisAround(d0)
  const ce = Math.cos(eta), se = Math.sin(eta), out = []
  for (let k = 0; k <= N; k++) {
    const az = (k / N) * 2 * Math.PI, c = Math.cos(az), s = Math.sin(az)
    const dir = [
      ce * d0[0] + se * (c * e1[0] + s * e2[0]),
      ce * d0[1] + se * (c * e1[1] + s * e2[1]),
      ce * d0[2] + se * (c * e1[2] + s * e2[2])
    ]
    let hit = rayEllipsoid(satEcef, dir)
    if (!hit) {
      const a = dot(dir, dir)
      const t = -dot(satEcef, dir) / a
      hit = projectToSurface([satEcef[0] + t * dir[0], satEcef[1] + t * dir[1], satEcef[2] + t * dir[2]])
    }
    const gd = ecefToGeodetic(hit[0], hit[1], hit[2])
    out.push({ lat: gd.lat, lon: gd.lon })
  }
  return out
}

// 等仰角线（WGS84，任意卫星 ECEF）：卫星位置 satEcef(km)、目标仰角 ElDeg -> 地表等值线 [[lon,lat]...]。
// 以地心星下点方向为锥轴，逐方位在「地心角 rho」上二分，使该地面点对卫星的椭球仰角 == ElDeg。
// 适用任意经纬度/轨道高度（GEO、IGSO、LEO…均可）。ElDeg=0 即可见地平（足迹边界）。
export function isoElevationContourAt(satEcef, ElDeg, N = 160) {
  const r = Math.hypot(satEcef[0], satEcef[1], satEcef[2])
  if (!(r > A)) return null                        // 卫星须在地表之上
  const u0 = [satEcef[0] / r, satEcef[1] / r, satEcef[2] / r]   // 地心星下点方向（单位矢量）
  const [e1, e2] = basisAround(u0)
  const groundAt = (beta, rho) => {                // 方位 beta、地心角 rho 处的地面大地点
    const c = Math.cos(rho), s = Math.sin(rho), cb = Math.cos(beta), sb = Math.sin(beta)
    const w = [
      c * u0[0] + s * (cb * e1[0] + sb * e2[0]),
      c * u0[1] + s * (cb * e1[1] + sb * e2[1]),
      c * u0[2] + s * (cb * e1[2] + sb * e2[2])
    ]
    const p = projectToSurface(w)
    return ecefToGeodetic(p[0], p[1], p[2])
  }
  const elAt = (beta, rho) => { const g = groundAt(beta, rho); return elevationDeg(g.lon, g.lat, satEcef) }
  if (elAt(0, 1e-4) < ElDeg) return null           // 目标仰角超过该星可达上限（近星下点仍达不到）
  // 该高度的可见地平地心角上限（球近似 rho_limb=acos(Re/r)），留少量裕度以保 0°（地平）也能二分到
  const rhoLimb = Math.acos(Math.max(-1, Math.min(1, A / r)))
  const RHO_MAX = Math.min(rhoLimb + 0.03, Math.PI / 2 + 0.05)
  const out = []
  for (let k = 0; k <= N; k++) {
    const beta = (k / N) * 2 * Math.PI
    let lo = 0, hi = RHO_MAX
    if (elAt(beta, hi) > ElDeg) { const g = groundAt(beta, hi); out.push([g.lon, g.lat]); continue }
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (elAt(beta, mid) > ElDeg) lo = mid; else hi = mid }
    const g = groundAt(beta, (lo + hi) / 2)
    out.push([g.lon, g.lat])
  }
  return out
}

// 等仰角线（WGS84）：GEO 卫星(赤道, satLon)，目标仰角 ElDeg -> 地表等值线 [[lon,lat]...]。
// = isoElevationContourAt 以 GEO 赤道点为卫星位置的特例（保留旧签名，GXT/GRD 沿用）。
export function isoElevationContour(satLonDeg, ElDeg, N = 160) {
  return isoElevationContourAt(geodeticToEcef(satLonDeg, 0, RS_GEO - A), ElDeg, N)
}
