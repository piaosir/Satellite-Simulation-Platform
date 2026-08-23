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

// 地心球坐标(度,度,km) -> ECEF(km)：r = A + hKm，纬度是【地心】纬度。
// 轨道壳层（shellProj.js）与「空间点指向」共用这一套口径——壳层是概念球面，不是椭球+h；
// 拿 geodeticToEcef 去算壳层上的点会在中纬度偏出十几 km（椭球扁率），投影就落不回壳面。
export function geocentricToEcef(lonDeg, latDeg, hKm = 0) {
  const lat = latDeg * DEG, lon = lonDeg * DEG, r = A + hKm, cl = Math.cos(lat)
  return [r * cl * Math.cos(lon), r * cl * Math.sin(lon), r * Math.sin(lat)]
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
// 另返回 pRaw：命中时同 p；未命中时 = 未投影的最近趋近点（停在椭球【外】，h>0）。pRaw 让越地平网格点
//   保留在地平【外】的经纬度（而非折叠到地平圆上），使覆盖填充能延伸到地平外、再被平滑地平弧精确裁剪——
//   否则填充止于地平圆内接折线，与真实地平弧之间会留月牙缝（地平附近锯齿/毛刺的根因）。
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
    if (t >= 0) { const p = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]; return { p, m: disc, pRaw: p } }
  }
  const t = -b / (2 * a)   // 未命中：取最近趋近点；p 投到椭球得地平点，pRaw 保留地平外原点
  const pRaw = [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]]
  return { p: projectToSurface(pRaw), m: disc < 0 ? disc : -1, pRaw }
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
// 以地心星下点方向为锥轴，逐方位在「地心角 rho」上求根，使该地面点对卫星的椭球仰角 == ElDeg。
// 适用任意经纬度/轨道高度（GEO、IGSO、LEO…均可）。ElDeg=0 即可见地平（足迹边界）。
export function isoElevationContourAt(satEcef, ElDeg, N = 160) {
  const sx = satEcef[0], sy = satEcef[1], sz = satEcef[2]
  const r = Math.sqrt(sx * sx + sy * sy + sz * sz)
  if (!(r > A)) return null                        // 卫星须在地表之上
  const u0 = [sx / r, sy / r, sz / r]              // 地心星下点方向（单位矢量）
  const [e1, e2] = basisAround(u0)
  // 热循环里的量全摊成局部标量：一条线要取样上千次，数组下标与临时对象都是纯开销
  const ux = u0[0], uy = u0[1], uz = u0[2]
  const ax = e1[0], ay = e1[1], az = e1[2], bx = e2[0], by = e2[1], bz = e2[2]
  const A2 = A * A, B2 = B * B
  // 地心角 rho 处的椭球面点（ECEF）。复用同一块三元组，不逐次新建数组。
  const _p = [0, 0, 0]
  const surfAt = (cb, sb, rho) => {
    const c = Math.cos(rho), s = Math.sin(rho)
    const wx = c * ux + s * (cb * ax + sb * bx)
    const wy = c * uy + s * (cb * ay + sb * by)
    const wz = c * uz + s * (cb * az + sb * bz)
    const k = 1 / Math.sqrt((wx * wx + wy * wy) / A2 + (wz * wz) / B2)   // 沿地心方向投到椭球面
    _p[0] = wx * k; _p[1] = wy * k; _p[2] = wz * k
    return _p
  }
  // 求根判据 f(rho) = sin(仰角) − sin(ElDeg)，随 rho 单调减，f>0 即「仰角高于目标」。
  // ★ 比正弦不比角度：asin 单调，两者严格同号，于是每次取样省掉一个 asin。
  // ★ 全程 ECEF：地面点的大地天顶＝椭球法线 [x/A², y/A², z/B²] 归一化，这是闭式的，与 geodeticUp(lon,lat) 恒等。
  //   改造前这一步是「投影 → ecefToGeodetic(20 次定点迭代) → geodeticToEcef 正算回去 → geodeticUp 再算一遍法线」，
  //   而求根每方位要调它几十次 —— 一条 120 点的等仰角线要跑三十万次三角函数，「最低仰角档比波束角档卡」全出在这里。
  // ★ 全用 sqrt 不用 hypot：hypot 带溢出保护的分级缩放，在这个 km 量级的热循环里是三五倍的白开销。
  const sinTarget = Math.sin(ElDeg * DEG)
  const fAt = (cb, sb, rho) => {
    const c = Math.cos(rho), s = Math.sin(rho)
    const wx = c * ux + s * (cb * ax + sb * bx)
    const wy = c * uy + s * (cb * ay + sb * by)
    const wz = c * uz + s * (cb * az + sb * bz)
    const k = 1 / Math.sqrt((wx * wx + wy * wy) / A2 + (wz * wz) / B2)
    const px = wx * k, py = wy * k, pz = wz * k
    const dx = sx - px, dy = sy - py, dz = sz - pz
    const nx = px / A2, ny = py / A2, nz = pz / B2
    const nn = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
    const dd = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
    const q = (dx * nx + dy * ny + dz * nz) / (nn * dd)
    return (q > 1 ? 1 : q < -1 ? -1 : q) - sinTarget
  }
  // 点恒在椭球面上（surfAt 已沿地心方向投过去），大地经纬度就有闭式：法线 [x/A², y/A², z/B²] 的方位与仰角。
  // 不必再走 ecefToGeodetic 的 20 次定点迭代 —— 那是给任意高度的点用的，这里每方位白跑二十轮 sin+sqrt+atan2。
  const geoOn = (p) => [Math.atan2(p[1], p[0]) / DEG, Math.atan2(p[2] * A2, Math.sqrt(p[0] * p[0] + p[1] * p[1]) * B2) / DEG]
  if (fAt(1, 0, 1e-4) < 0) return null   // 目标仰角超过该星可达上限（近星下点仍达不到）
  // 该高度的可见地平地心角上限（球近似 rho_limb=acos(Re/r)），留少量裕度以保 0°（地平）也能收敛到
  const rhoLimb = Math.acos(Math.max(-1, Math.min(1, A / r)))
  const RHO_MAX = Math.min(rhoLimb + 0.03, Math.PI / 2 + 0.05)
  // 收敛判据 1.5e-11 rad ≈ 0.1 mm：比改造前 26 次定步长二分的 2.4e-8 rad（≈0.15 m）还细两个量级，
  // 精度只增不减 —— 这一档改的是【收敛路径】，不是精度。
  const TOL = 1.5e-11
  const out = []
  let rhoPrev = -1                       // 上一方位的解：等仰角线沿方位是光滑的，它就是这一方位的极好初值
  const SPAN0 = 0.03                     // 初始括号半宽（rad）；框不住按 ×5 外扩两轮，仍不成就退回全区间
  for (let k = 0; k <= N; k++) {
    const beta = (k / N) * 2 * Math.PI
    const cb = Math.cos(beta), sb = Math.sin(beta)
    // ---- 括号：先拿上一方位的解开一个窄窗，两端符号一验就把全区间求根压成窄区间求根 ----
    let lo = 0, hi = RHO_MAX, flo = Infinity, fhi = Infinity
    if (rhoPrev >= 0) {
      for (let d = SPAN0, a = 0; a < 3; a++, d *= 5) {
        const x1 = Math.min(RHO_MAX, rhoPrev + d)
        const f1 = fAt(cb, sb, x1)
        if (f1 > 0) { lo = x1; flo = f1; if (x1 >= RHO_MAX) break; continue }   // 根在窗右边：左端抬到 x1
        const x0 = Math.max(lo, rhoPrev - d)
        const f0 = x0 > lo || flo === Infinity ? fAt(cb, sb, x0) : flo
        if (f0 > 0) { lo = x0; flo = f0; hi = x1; fhi = f1; break }             // 框住了
        hi = x0; fhi = f0                                                       // 根在窗左边：右端压到 x0
      }
    }
    // hi 被收窄过时 fhi 必 ≤0（见上），故这条只在 hi 仍是 RHO_MAX 时可能成立 —— 与改造前同一判据
    if (fhi === Infinity) fhi = fAt(cb, sb, hi)
    if (fhi > 0) { out.push(geoOn(surfAt(cb, sb, hi))); rhoPrev = hi; continue }
    if (flo === Infinity) flo = fAt(cb, sb, lo)
    // ---- Illinois（带下垂的试位法）：光滑单调函数上超线性收敛，且始终保持括号。实测每方位 ~9.5 次取样（原 27 次）。
    //      wRef/stall 是停滞兜底：连着 3 步没把区间砍到一半就强制二分一次，最坏退化为二分而不是原地打转。----
    let side = 0, wRef = hi - lo, stall = 0
    for (let it = 0; it < 48 && hi - lo > TOL; it++) {
      const w = hi - lo
      let mid
      if (stall >= 3) { mid = lo + w * 0.5; stall = 0 }
      else {
        mid = lo + w * (flo / (flo - fhi))
        const g = w * 1e-3                                   // 逼近端点时强制退回区间内部，避免取样落在端点上
        mid = mid < lo + g ? lo + g : (mid > hi - g ? hi - g : mid)
      }
      const fm = fAt(cb, sb, mid)
      if (fm > 0) { lo = mid; flo = fm; if (side > 0) fhi *= 0.5; side = 1 }
      else { hi = mid; fhi = fm; if (side < 0) flo *= 0.5; side = -1 }
      if (hi - lo <= wRef * 0.5) { wRef = hi - lo; stall = 0 } else stall++
    }
    rhoPrev = (lo + hi) / 2
    out.push(geoOn(surfAt(cb, sb, rhoPrev)))
  }
  return out
}

// 等仰角线（WGS84）：GEO 卫星(赤道, satLon)，目标仰角 ElDeg -> 地表等值线 [[lon,lat]...]。
// = isoElevationContourAt 以 GEO 赤道点为卫星位置的特例（保留旧签名，GXT/GRD 沿用）。
export function isoElevationContour(satLonDeg, ElDeg, N = 160) {
  return isoElevationContourAt(geodeticToEcef(satLonDeg, 0, RS_GEO - A), ElDeg, N)
}
