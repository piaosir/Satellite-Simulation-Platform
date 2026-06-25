// GRD 覆盖计算核心：投影(L0) · 场标量(L1) · 等值线(L2b)。
// 几何全程 WGS84，复用 src/viz/wgs84.js。填充面着色(L2a) 在渲染层做。
// 见 docs/GRD导入与覆盖可视化设计.md（性能分层 §4、面+线 §5）。

import { geodeticToEcef, ecefToGeodetic, rayEllipsoid, rayEllipsoidMargin, A, E2, RS_GEO } from '../wgs84.js'

const D2R = Math.PI / 180, H = RS_GEO - A
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const nrm = (a) => sc(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1))

// 网格坐标 → 天线系单位矢量（第3轴=boresight）。权威 igrid 公式（GRD说明 §5）。
export function gridDir(igrid, X, Y) {
  if (igrid === 1) { const u = X, v = Y; return [u, v, Math.sqrt(Math.max(0, 1 - u * u - v * v))] }
  if (igrid === 7) { const ph = X * D2R, th = Y * D2R; return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)] }
  const az = X * D2R, el = Y * D2R, ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el)
  switch (igrid) {
    case 4: return [-sa * ce, se, ca * ce]
    case 6: return [-sa, ca * se, ca * ce]
    case 9: return [sa * ce, se, ca * ce]
    case 10: return [sa, ca * se, ca * ce]
    case 5: { const th = Math.hypot(az, el), ph = Math.atan2(el, -az); return [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)] }
    default: throw new Error('未支持的 igrid=' + igrid)
  }
}

// 天线姿态基底：默认 boresight=星下点(satLon,boreLat)；可设 boreLon/boreLat/yaw（WGS84）。
// satLat/altKm = 卫星真实纬度/轨道高度（默认 GEO 赤道）：足迹大小随高度变，LEO 远小于 GEO。
export function antennaBasis(satLon, boreLon = satLon, boreLat = 0, yawDeg = 0, satLat = 0, altKm = H) {
  const S = geodeticToEcef(satLon, satLat, altKm)
  const T = geodeticToEcef(boreLon, boreLat, 0)
  const z = nrm(sub(T, S))
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x)
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S, x, y, z }
}

// 天线系 r̂ → 大地经纬度（射线交 WGS84 椭球）；off-limb 返回 null。
export function project(dir, basis) {
  const { S, x, y, z } = basis
  const d = nrm(add(add(sc(x, dir[0]), sc(y, dir[1])), sc(z, dir[2])))
  const P = rayEllipsoid(S, d)
  if (!P) return null
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat, ecef: P }
}

// 每点天线系单位矢量（gridDir 结果展平成 Float32Array[N*3]）。只随网格几何/igrid 变，与指向(basis)无关，
// 故记忆化到 set 上——拖拽时 basis 每帧变但这张表不变，省掉逐点 sin/cos。
export function gridDirs(set, igrid) {
  if (set._dirs && set._dirsIgrid === igrid) return set._dirs
  const { XS, YS, XE, YE, NX, NY } = set
  const dx = (XE - XS) / (NX - 1), dy = (YE - YS) / (NY - 1)
  const N = NX * NY, dirs = new Float32Array(N * 3)
  for (let row = 0; row < NY; row++) {
    for (let col = 0; col < NX; col++) {
      const d = gridDir(igrid, XS + dx * col, YS + dy * row), o = (row * NX + col) * 3
      dirs[o] = d[0]; dirs[o + 1] = d[1]; dirs[o + 2] = d[2]
    }
  }
  set._dirs = dirs; set._dirsIgrid = igrid
  return dirs
}

// L0：把整张网格逐点投影成 lon/lat（+ 斜距，供路径损耗 + 地平裕度 vis）。仅指向变化时重算。
// vis>0 在地球可见面内、=0 恰在 0°仰角线、<0 越过地平。越过地平的点不再返回 NaN，而是落到
// 地平上的趋近点（位置连续），由 vis 符号区分——渲染层据此把覆盖精确切在 0°仰角线，无网格锯齿。
// 热路径（拖拽每帧）：复用缓存的天线系 dir 表，逐点只做 basis 旋转 + 射线求交，无 trig、无中间数组分配。
const R2D = 180 / Math.PI
export function projectGrid(set, igrid, basis) {
  const { NX, NY } = set
  const N = NX * NY, { S, x, y, z } = basis
  const dirs = gridDirs(set, igrid)
  const x0 = x[0], x1 = x[1], x2 = x[2], y0 = y[0], y1 = y[1], y2 = y[2], z0 = z[0], z1 = z[1], z2 = z[2]
  const S0 = S[0], S1 = S[1], S2 = S[2]
  const lon = new Float32Array(N), lat = new Float32Array(N), slant = new Float32Array(N), vis = new Float32Array(N)
  const d = [0, 0, 0]
  for (let k = 0; k < N; k++) {
    const o = k * 3, a = dirs[o], b = dirs[o + 1], c = dirs[o + 2]
    let ex = x0 * a + y0 * b + z0 * c, ey = x1 * a + y1 * b + z1 * c, ez = x2 * a + y2 * b + z2 * c
    const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
    d[0] = ex * inv; d[1] = ey * inv; d[2] = ez * inv
    const r = rayEllipsoidMargin(S, d), px = r.p[0], py = r.p[1], pz = r.p[2]
    // 内联大地纬度反算（4 次定点迭代，地表点早收敛——替代共享版 20 次，拖拽热路径省 80% 三角运算）
    const Rxy = Math.hypot(px, py)
    let glat = Math.atan2(pz, Rxy)
    for (let it = 0; it < 4; it++) { const sgl = Math.sin(glat); glat = Math.atan2(pz + A * E2 * sgl / Math.sqrt(1 - E2 * sgl * sgl), Rxy) }
    lon[k] = Math.atan2(py, px) * R2D; lat[k] = glat * R2D; vis[k] = r.m
    slant[k] = Math.hypot(px - S0, py - S1, pz - S2)
  }
  return { lon, lat, slant, vis, NX, NY }
}

// L1：极化取值 + 增益偏置 + 路径损耗 → dB 网格。pol: P1|P2|RSS|P1/P2|P2/P1。
// pathLoss: 'none' | 'relative'(h/Rs)² | 'absolute' 1/(4πRs²)；hNadir=星地最近距离(=H 近似)。
export function fieldDb(set, proj, { pol = 'P1', gainOffset = 0, pathLoss = 'none', hNadir = H } = {}) {
  const { P1, P2, NX, NY } = set, N = NX * NY, db = new Float32Array(N)
  let max = -Infinity, maxIdx = 0
  for (let k = 0; k < N; k++) {
    const p1 = P1[k], p2 = P2[k]
    let P
    if (pol === 'P1') P = p1
    else if (pol === 'P2') P = p2
    else if (pol === 'RSS') P = p1 + p2
    else if (pol === 'P1/P2') P = p2 > 0 ? p1 / p2 : 0
    else if (pol === 'P2/P1') P = p1 > 0 ? p2 / p1 : 0
    else P = p1
    if (!(P > 0)) { db[k] = NaN; continue }
    let v = 10 * Math.log10(P) + gainOffset
    if (pathLoss !== 'none' && proj) {
      const Rs = proj.slant[k]
      if (Rs > 0) v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / Rs) : -10 * Math.log10(4 * Math.PI * Rs * Rs)
    }
    db[k] = v
    if (v > max) { max = v; maxIdx = k }
  }
  return { db, max, maxIdx, NX, NY }
}

// L2b：marching-squares 在 dB 网格上按电平取等值线段，端点经投影网格映射到 lon/lat。
// levels: 绝对 dB 数组（相对峰值时由调用方 = max + rel 传入）。返回 [{g, segs:[[[lon,lat],[lon,lat]]...]}]。
export function contourLines(field, proj, levels) {
  const { db, NX, NY } = field
  const vis = proj.vis
  const out = []
  const ll = (ia, ib, t) => [proj.lon[ia] + (proj.lon[ib] - proj.lon[ia]) * t, proj.lat[ia] + (proj.lat[ib] - proj.lat[ia]) * t]
  for (const g of levels) {
    const segs = []
    for (let row = 0; row < NY - 1; row++) {
      for (let col = 0; col < NX - 1; col++) {
        const i00 = row * NX + col, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
        const v0 = db[i00], v1 = db[i10], v2 = db[i11], v3 = db[i01]   // BL,BR,TR,TL
        if (v0 !== v0 || v1 !== v1 || v2 !== v2 || v3 !== v3) continue  // 任一 NaN 跳过（增益无效）
        // 四角全部越过地平 → 该格在可见地球外，跳过；含可见角的格保留，使填充环能沿 0°仰角线闭合
        if (vis && vis[i00] < 0 && vis[i10] < 0 && vis[i11] < 0 && vis[i01] < 0) continue
        const pts = []
        if ((v0 < g) !== (v1 < g)) pts.push(ll(i00, i10, (g - v0) / (v1 - v0)))   // bottom
        if ((v1 < g) !== (v2 < g)) pts.push(ll(i10, i11, (g - v1) / (v2 - v1)))   // right
        if ((v2 < g) !== (v3 < g)) pts.push(ll(i11, i01, (g - v2) / (v3 - v2)))   // top
        if ((v3 < g) !== (v0 < g)) pts.push(ll(i01, i00, (g - v3) / (v0 - v3)))   // left
        if (pts.length === 2) segs.push([pts[0], pts[1]])
        else if (pts.length === 4) { segs.push([pts[0], pts[1]]); segs.push([pts[2], pts[3]]) }
      }
    }
    out.push({ g, segs })
  }
  return out
}

// L2 统一几何：在同一套三角化 + 逐三角形线性插值上，既切出「分带填充多边形」又取「分带边界(等值线)」。
// 填充与线由同一组顶点插值生成 → 二者逐三角形精确重合；无位图、无对角线/鞍点/接缝分歧（旧 field 着色法
// 的根因）。地平裁剪：先按 vis≥0 裁三角；接缝：每格三个外角相对首角解缠，不再整格丢弃 → 跨 ±180° 无缺口。
// field={lon,lat,vis,db,NX,NY}；levelsAsc 升序绝对电平。返回 { fills:[band0Polys,...], lines:[lvl0Segs,...] }：
//   fills[k] = 该档 [Lk,Lk+1) 环带的多边形列表（每多边形 = [[lon,lat]...]，与 shader band=k 同义）；
//   lines[k] = Lk 等值线段列表（[[lon,lat],[lon,lat]]，= fills 相邻档的公共边）。
export function bandGeometry(field, levelsAsc) {
  const { lon, lat, vis, db, NX, NY } = field
  const nb = levelsAsc.length
  const fills = Array.from({ length: nb }, () => [])
  const lines = Array.from({ length: nb }, () => [])
  if (!nb || !NX || !NY) return { fills, lines }
  const L0 = levelsAsc[0]
  // 顶点 {x:lon(解缠), y:lat, d:db, m:vis}；外三角相对首角解缠经度
  const corner = (i, refLon) => {
    let L = lon[i]
    if (refLon != null) { while (L - refLon > 180) L -= 360; while (L - refLon < -180) L += 360 }
    return { x: L, y: lat[i], d: db[i], m: vis ? vis[i] : 1 }
  }
  // Sutherland-Hodgman：凸多边形按某标量 val 与阈值 t 半平面裁剪（keepGE: 留 val≥t，否则留 val≤t）
  const clip = (poly, val, t, keepGE) => {
    if (poly.length < 2) return []
    const out = []
    for (let i = 0; i < poly.length; i++) {
      const A = poly[i], B = poly[(i + 1) % poly.length]
      const va = val(A), vb = val(B)
      const ina = keepGE ? va >= t : va <= t, inb = keepGE ? vb >= t : vb <= t
      if (ina) out.push(A)
      if (ina !== inb) {
        const s = (t - va) / (vb - va)
        out.push({ x: A.x + (B.x - A.x) * s, y: A.y + (B.y - A.y) * s, d: A.d + (B.d - A.d) * s, m: A.m + (B.m - A.m) * s })
      }
    }
    return out
  }
  const getD = (p) => p.d, getM = (p) => p.m
  const emitTri = (t0, t1, t2) => {
    if (t0.d !== t0.d || t1.d !== t1.d || t2.d !== t2.d) return        // 任一角增益无效
    if (t0.m < 0 && t1.m < 0 && t2.m < 0) return                       // 整三角越地平
    if (!(Math.max(t0.d, t1.d, t2.d) >= L0)) return                    // 全部低于最低档 → 无覆盖
    let base = [t0, t1, t2]
    if (t0.m < 0 || t1.m < 0 || t2.m < 0) base = clip(base, getM, 0, true)   // 沿 0°仰角线裁
    if (base.length < 3) return
    for (let k = 0; k < nb; k++) {
      let poly = clip(base, getD, levelsAsc[k], true)                  // d ≥ Lk
      if (k < nb - 1 && poly.length) poly = clip(poly, getD, levelsAsc[k + 1], false)  // 且 d ≤ Lk+1（顶档不封顶）
      if (poly.length >= 3) fills[k].push(poly.map((p) => [p.x, p.y]))
    }
    for (let k = 0; k < nb; k++) {                                     // 各档等值线 = base 上 d==Lk 的穿越段
      const L = levelsAsc[k], seg = []
      for (let i = 0; i < base.length; i++) {
        const A = base[i], B = base[(i + 1) % base.length]
        if ((A.d < L) !== (B.d < L)) { const s = (L - A.d) / (B.d - A.d); seg.push([A.x + (B.x - A.x) * s, A.y + (B.y - A.y) * s]) }
      }
      if (seg.length === 2) lines[k].push([seg[0], seg[1]])            // 凸多边形上恰 0 或 2 个穿越
    }
  }
  for (let row = 0; row < NY - 1; row++) {
    for (let col = 0; col < NX - 1; col++) {
      const i00 = row * NX + col, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
      const a = corner(i00), b = corner(i10, a.x), c = corner(i11, a.x), d = corner(i01, a.x)
      emitTri(a, b, c); emitTri(a, c, d)                              // 沿 a–c 对角线三角化（填充/线同源）
    }
  }
  return { fills, lines }
}

// 相对峰值电平 → 绝对电平（rel 一般为负，如 [-1,-2,-3,-4,-5]）
export const relLevels = (max, rels) => rels.map((r) => max + r)

// 把某电平的 marching-squares 线段拼成闭合环（端点量化匹配）。用于「分带填充多边形」，
// 使填充边界与等值线由同一组线段构成 → 填充与线精确重合、无网格毛刺。
export function stitchLoops(segs) {
  if (!segs || !segs.length) return []
  const key = (p) => Math.round(p[0] * 20000) + ',' + Math.round(p[1] * 20000)
  const ends = new Map()
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i) } })
  const used = new Array(segs.length).fill(false), loops = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const loop = [segs[i][0], segs[i][1]]
    let curK = key(segs[i][1]); const startK = key(segs[i][0])
    for (let g = 0; g < segs.length; g++) {
      let nj = -1
      for (const j of (ends.get(curK) || [])) { if (!used[j]) { nj = j; break } }
      if (nj < 0) break
      used[nj] = true
      const s = segs[nj], next = key(s[0]) === curK ? s[1] : s[0]
      loop.push(next); curK = key(next)
      if (curK === startK) break
    }
    loops.push(loop)
  }
  return loops
}
