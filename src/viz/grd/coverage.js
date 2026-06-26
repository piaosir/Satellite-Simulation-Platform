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
const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

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

// gridDir 的逆：天线系单位矢量 (a,b,c)（c=boresight 分量）→ 网格坐标 [X, Y]。
// 供「在站点方向上反查方向图值」用（性能指标表）。c<=0（boresight 背面）返回 null。
export function invGridDir(igrid, a, b, c) {
  if (!(c > 0)) return null
  if (igrid === 1) return (a * a + b * b <= 1) ? [a, b] : null   // u=X, v=Y
  if (igrid === 7) { const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a); return [ph / D2R, th / D2R] }
  if (igrid === 5) {   // th=hypot(az,el)(rad), ph=atan2(el,-az) → az=-th cosφ, el=th sinφ
    const th = Math.acos(Math.max(-1, Math.min(1, c))), ph = Math.atan2(b, a)
    return [(-th * Math.cos(ph)) / D2R, (th * Math.sin(ph)) / D2R]
  }
  let az, el
  switch (igrid) {
    case 4: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(-a, c); break          // [-sa ce, se, ca ce]
    case 9: el = Math.asin(Math.max(-1, Math.min(1, b))); az = Math.atan2(a, c); break            // [ sa ce, se, ca ce]
    case 6: el = Math.atan2(b, c); az = Math.atan2(-a, Math.hypot(b, c)); break                   // [-sa, ca se, ca ce]
    case 10: el = Math.atan2(b, c); az = Math.atan2(a, Math.hypot(b, c)); break                   // [ sa, ca se, ca ce]
    default: return null
  }
  return [az / D2R, el / D2R]
}

// 把姿态基底的 boresight(z) 倾斜一个小角 epsDeg（方位 phiDeg 在 x-y 面内）→ 新基底。
// 供性能指标表「指向误差扫描」(Min/Max Pointing)：在容差圆周上重采样方向图取最差/最好值。
// eps=0 原样返回。x/y 按与 antennaBasis 一致的约定重建（x=东向参考、y=z×x）。
export function tiltBasis(basis, epsDeg, phiDeg = 0) {
  if (!epsDeg) return basis
  const e = epsDeg * D2R, ph = phiDeg * D2R, { S, x, y, z } = basis
  const axis = add(sc(x, Math.cos(ph)), sc(y, Math.sin(ph)))     // 倾斜方向（x-y 面内）
  const z2 = nrm(add(sc(z, Math.cos(e)), sc(axis, Math.sin(e))))
  let x2 = crs([0, 0, 1], z2)
  x2 = (Math.hypot(x2[0], x2[1], x2[2]) > 1e-9) ? nrm(x2) : nrm(crs(y, z2))   // z2 近垂直时退用旧 y 定参考
  return { S, x: x2, y: crs(z2, x2), z: z2 }
}

// 卫星刚体姿态去指向（严格按 TICRA SATSOFT 口径：de-pointing 由卫星 roll/pitch/yaw 指定，波束随卫星刚体转动）。
// 误差 (Az,El,Yaw) 绕【卫星体轴】施加：Yaw 绕天底轴(z_sc=指向地心)、El 绕东向轴(x_sc)、Az 绕北向轴(y_sc)；
// 同一旋转作用到该波束 basis 的 x/y/z（绕过卫星位置 S 的轴，S 不变）。对天底波束 ≈ 绕波束自身扰动；
// 对偏轴波束，Yaw 让波束沿弧平移（boresight 真位移 ~离轴角×yaw），绕波束自转无此效果——这是与旧实现的关键差异。
// 顺序 Yaw→El→Az（小角近似可交换）。Rodrigues 旋转保持正交归一。
export function perturbSpacecraft(basis, azDeg = 0, elDeg = 0, yawDeg = 0) {
  if (!azDeg && !elDeg && !yawDeg) return basis
  const { S } = basis
  const zsc = nrm(sc(S, -1))                                   // 天底：卫星指向地心
  let xsc = crs([0, 0, 1], zsc)
  xsc = (Math.hypot(xsc[0], xsc[1], xsc[2]) > 1e-9) ? nrm(xsc) : [1, 0, 0]   // 极区退化保护
  const ysc = crs(zsc, xsc)
  const rod = (v, k, ang) => { const c = Math.cos(ang), s = Math.sin(ang), kv = crs(k, v); return add(add(sc(v, c), sc(kv, s)), sc(k, dt(k, v) * (1 - c))) }
  const rot = (v) => { let r = v; if (yawDeg) r = rod(r, zsc, yawDeg * D2R); if (elDeg) r = rod(r, xsc, elDeg * D2R); if (azDeg) r = rod(r, ysc, azDeg * D2R); return r }
  return { S, x: rot(basis.x), y: rot(basis.y), z: rot(basis.z) }
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

// 方向式天线姿态：boresight 由「相对星下天底的 az/el 方向」直接给定（igrid6 约定），
// 不经过地表目标点 → boresight 可指向任意方向，包括越过地平的深空（El 超出地球张角即指深空）。
// 这是物理正确的指向基元：方向图照常逐点投影，命中地球的点出覆盖、越地平的点自然滚降（vis<0）。
export function antennaBasisAzEl(satLon, satLat = 0, altKm = H, azDeg = 0, elDeg = 0, yawDeg = 0) {
  const nb = antennaBasis(satLon, satLon, satLat, 0, satLat, altKm)   // 星下天底基底（z=天底, x=东, y=北）
  const dir = gridDir(6, azDeg, elDeg)                                // boresight 方向（天底系，az/el 偏置）
  const z = nrm([
    nb.x[0] * dir[0] + nb.y[0] * dir[1] + nb.z[0] * dir[2],
    nb.x[1] * dir[0] + nb.y[1] * dir[1] + nb.z[1] * dir[2],
    nb.x[2] * dir[0] + nb.y[2] * dir[1] + nb.z[2] * dir[2]
  ])
  let x = nrm(crs([0, 0, 1], z)), y = crs(z, x)                        // 与 geo 模式同一参考约定
  if (yawDeg) {
    const c = Math.cos(yawDeg * D2R), sn = Math.sin(yawDeg * D2R)
    const x2 = add(sc(x, c), sc(y, sn)), y2 = add(sc(y, c), sc(x, -sn)); x = x2; y = y2
  }
  return { S: nb.S, x, y, z }
}
// 地表点(lon,lat) → 该点相对星下天底的 az/el（geo↔azel 模式互换用）。任意地表点皆有定义（含地平内）。
export function dirToAzEl(satLon, satLat, altKm, lon, lat) {
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
  const w = nrm(sub(geodeticToEcef(lon, lat, 0), nb.S))
  const dx = dt(w, nb.x), dy = dt(w, nb.y), dz = dt(w, nb.z)
  return { az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D, el: Math.atan2(dy, dz) * R2D }
}
// 地表点(lon,lat) → 朝它的 boresight az/el，但把方向夹在可见圆盘内（越地平的点夹到地平切向）。
// 拖拽用：地表经纬度在地平附近映射非单调（过地平会回折），改用"夹到地平的方向"后单调，可一路拖到地平线。
export function surfaceAzEl(satLon, satLat, altKm, lon, lat) {
  const nb = antennaBasis(satLon, satLon, satLat || 0, 0, satLat || 0, altKm)
  const S = nb.S
  let w = nrm(sub(geodeticToEcef(lon, lat, 0), S))
  const wn = dt(w, nb.z)                                       // cos(与天底夹角)
  const aL = Math.asin(Math.min(1, A / Math.hypot(S[0], S[1], S[2])))   // 地平角半径(≈8.7° @GEO)
  if (Math.acos(Math.max(-1, Math.min(1, wn))) > aL) {        // 越地平 → 夹到地平切向(保留方位)
    const perp = nrm(sub(w, sc(nb.z, wn)))
    w = nrm(add(sc(nb.z, Math.cos(aL)), sc(perp, Math.sin(aL))))
  }
  const dx = dt(w, nb.x), dy = dt(w, nb.y), dz = dt(w, nb.z)
  return { az: Math.atan2(-dx, Math.hypot(dy, dz)) * R2D, el: Math.atan2(dy, dz) * R2D }
}
// boresight(az/el 方向) 在地表的落点；指向深空(越地平,不命中)时返回 null（供 tip 显示/模式互换）。
export function azElGround(satLon, satLat, altKm, azDeg, elDeg) {
  const basis = antennaBasisAzEl(satLon, satLat, altKm, azDeg, elDeg, 0)
  const P = rayEllipsoid(basis.S, basis.z)
  if (!P) return null
  const g = ecefToGeodetic(P[0], P[1], P[2])
  return { lon: g.lon, lat: g.lat }
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
// box（可选）= { r0,r1,c0,c1 }（含端点的行列范围）：只投影该子矩形（HTS 点波束的覆盖热区），其余点不算。
//   场 dB 与指向无关，故覆盖热区可在拖拽前算出（见 useGrdCoverage.beamBox），拖拽每帧只投影热区 → 大幅提速。
// out（可选）= 上一帧的 {lon,lat,slant,vis}：尺寸相同则原地复用，免去每帧 4×Float32Array(N) 分配（94 波束省大量 GC）。
// limbOutside（可选）：越地平点(vis<0)取未投影的最近趋近点（停在地平【外】），使覆盖填充能延伸到地平外、
//   再由 bandGeometry 用平滑地平弧裁剪，消除地平附近的月牙缝/锯齿。默认 false（旧行为：折叠到地平圆上）。
export function projectGrid(set, igrid, basis, box = null, out = null, limbOutside = false) {
  const { NX, NY } = set
  const N = NX * NY, { S, x, y, z } = basis
  const dirs = gridDirs(set, igrid)
  const x0 = x[0], x1 = x[1], x2 = x[2], y0 = y[0], y1 = y[1], y2 = y[2], z0 = z[0], z1 = z[1], z2 = z[2]
  const S0 = S[0], S1 = S[1], S2 = S[2]
  const reuse = out && out.lon && out.lon.length === N
  const lon = reuse ? out.lon : new Float32Array(N)
  const lat = reuse ? out.lat : new Float32Array(N)
  const slant = reuse ? out.slant : new Float32Array(N)
  const vis = reuse ? out.vis : new Float32Array(N)
  const d = [0, 0, 0]
  const r0 = box ? box.r0 : 0, r1 = box ? box.r1 : NY - 1, c0 = box ? box.c0 : 0, c1 = box ? box.c1 : NX - 1
  for (let row = r0; row <= r1; row++) {
    const rowBase = row * NX
    for (let col = c0; col <= c1; col++) {
      const k = rowBase + col
      const o = k * 3, a = dirs[o], b = dirs[o + 1], cz = dirs[o + 2]
      let ex = x0 * a + y0 * b + z0 * cz, ey = x1 * a + y1 * b + z1 * cz, ez = x2 * a + y2 * b + z2 * cz
      const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
      d[0] = ex * inv; d[1] = ey * inv; d[2] = ez * inv
      const r = rayEllipsoidMargin(S, d), P = (limbOutside && r.m < 0) ? r.pRaw : r.p, px = P[0], py = P[1], pz = P[2]
      // 内联大地纬度反算（4 次定点迭代，地表点早收敛——替代共享版 20 次，拖拽热路径省 80% 三角运算）
      const Rxy = Math.hypot(px, py)
      let glat = Math.atan2(pz, Rxy)
      for (let it = 0; it < 4; it++) { const sgl = Math.sin(glat); glat = Math.atan2(pz + A * E2 * sgl / Math.sqrt(1 - E2 * sgl * sgl), Rxy) }
      lon[k] = Math.atan2(py, px) * R2D; lat[k] = glat * R2D; vis[k] = r.m
      slant[k] = Math.hypot(px - S0, py - S1, pz - S2)
    }
  }
  return { lon, lat, slant, vis, NX, NY, box }
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

// Keys 立方卷积核（a=-0.5，标准 bicubic）：对带限/平滑数据精度高于双线性。
const keysW = (s) => { s = Math.abs(s); const a = -0.5; return s <= 1 ? ((a + 2) * s - (a + 3)) * s * s + 1 : (s < 2 ? ((a * s - 5 * a) * s + 8 * a) * s - 4 * a : 0) }
const clampI = (v, n) => (v < 0 ? 0 : (v > n - 1 ? n - 1 : v))
// 双三次插值（4×4 邻域，边界复制）。立方卷积在零点/陡坡附近可能轻微过冲（产生负功率）→ 由调用方回退双线性。
function bicubicAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0
  const wx = [keysW(1 + tx), keysW(tx), keysW(1 - tx), keysW(2 - tx)]
  const wy = [keysW(1 + ty), keysW(ty), keysW(1 - ty), keysW(2 - ty)]
  let acc = 0
  for (let j = 0; j < 4; j++) {
    const rr = clampI(r0 - 1 + j, NY) * NX
    let row = 0
    for (let i = 0; i < 4; i++) row += wx[i] * arr[rr + clampI(c0 - 1 + i, NX)]
    acc += wy[j] * row
  }
  return acc
}
function bilinearAt(arr, NX, NY, fc, fr) {
  const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(c0 + 1, NX - 1), r1 = Math.min(r0 + 1, NY - 1), tx = fc - c0, ty = fr - r0
  return arr[r0 * NX + c0] * (1 - tx) * (1 - ty) + arr[r0 * NX + c1] * tx * (1 - ty) + arr[r1 * NX + c0] * (1 - tx) * ty + arr[r1 * NX + c1] * tx * ty
}

// 轴比 AR(dB)：由两分量复振幅 comp={re1,im1,re2,im2} + icomp 决定的极化基算。
// icomp=3（圆极化基 R/L）：AR=(√P1+√P2)/|√P1−√P2|；icomp=1/2（线极化正交对 θ/φ 或 co/cx）：由 Stokes S3 求椭率角。
// 上限截断 60dB（近线极化 AR→∞）。comp 缺失（预置烘焙天线无相位）返回 null。
export function axialRatioDb(comp, icomp) {
  if (!comp) return null
  const { re1, im1, re2, im2 } = comp
  const p1 = re1 * re1 + im1 * im1, p2 = re2 * re2 + im2 * im2
  if (icomp === 3) {
    const a = Math.sqrt(p1), b = Math.sqrt(p2), den = Math.abs(a - b)
    return den < 1e-12 ? 60 : Math.min(60, 20 * Math.log10((a + b) / den))
  }
  const S0 = p1 + p2; if (!(S0 > 0)) return null
  const S3 = 2 * (re1 * im2 - im1 * re2)                       // 2·Im(E1*·E2)
  const chi = 0.5 * Math.asin(Math.max(-1, Math.min(1, S3 / S0)))   // 椭率角 ∈[-45°,45°]
  const t = Math.abs(Math.tan(chi))
  return t < 1e-6 ? 60 : Math.min(60, -20 * Math.log10(t))    // AR=1/|tanχ|
}

// 在地表站点(lon,lat)处反查单个波束的方向图值（性能指标表逐站取值内核）。
// 链路：站点 ECEF → 减卫星位置得视线方向 → 投到天线系 basis（转置）→ invGridDir 反解网格坐标 →
//   插值 → 极化/增益/路损 → dB。站点落在方向图域外/背面返回 null。
// 【插值域 = 复场（物理最准）】带限量是复电场 E（按口径采样到 Nyquist），功率 |E|² 带宽翻倍、
//   直接插功率相对网格欠采样 → 误差。故有复场(c1re..)时对 Re/Im 各做 bicubic 再平方得功率
//   （p=re²+im²≥0，无零点处的负过冲问题）；comp 也由此一并得到（AR 用，免重复插值）。
//   预置烘焙天线无复场 → 回退【对功率 P1/P2 做 bicubic】（过冲致非正时回退双线性）。
// beam: { P1,P2,[c1re,c1im,c2re,c2im], grid:{...} }；basis: { S,x,y,z }。
export function sampleBeamAt(beam, igrid, basis, lon, lat, { pol = 'RSS', gainOffset = 0, pathLoss = 'none', hNadir = H, wantComp = false } = {}) {
  const { S, x, y, z } = basis
  const P = geodeticToEcef(lon, lat, 0)
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2]
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
  const e = [ex / rs, ey / rs, ez / rs]
  // 地平遮挡（全轨道物理可见性）：卫星须在测站地方水平面之上（仰角≥0），否则视线被地球挡住 → 无效。
  // up=测站测地外法线，e 由卫星指向测站 → e·up>0 表示卫星在测站地平线【以下】（地球背面/对趾整片皆被排除）。
  // 必须独立判此：invGridDir 的 c>0 只能分前/后半球，无法区分「前方可见」与「前方穿过地球到背面对趾」(两者 e 同向)。
  const clat = Math.cos(lat * D2R), up = [clat * Math.cos(lon * D2R), clat * Math.sin(lon * D2R), Math.sin(lat * D2R)]
  if (dt(e, up) > 0) return null
  const a = dt(e, x), b = dt(e, y), c = dt(e, z)   // basis 正交 → 转置即逆，天线系分量
  const xy = invGridDir(igrid, a, b, c); if (!xy) return null
  const g = beam.grid, NX = g.NX, NY = g.NY
  const fc = (xy[0] - g.XS) / ((g.XE - g.XS) / (NX - 1))
  const fr = (xy[1] - g.YS) / ((g.YE - g.YS) / (NY - 1))
  if (fc < 0 || fc > NX - 1 || fr < 0 || fr > NY - 1) return null   // 站点在方向图网格域外
  let p1, p2, comp = null
  if (beam.c1re) {                                                   // 复场域插值（物理最准）：插 Re/Im → 平方
    const re1 = bicubicAt(beam.c1re, NX, NY, fc, fr), im1 = bicubicAt(beam.c1im, NX, NY, fc, fr)
    const re2 = bicubicAt(beam.c2re, NX, NY, fc, fr), im2 = bicubicAt(beam.c2im, NX, NY, fc, fr)
    p1 = re1 * re1 + im1 * im1; p2 = re2 * re2 + im2 * im2
    if (wantComp) comp = { re1, im1, re2, im2 }
  } else {                                                           // 无复场（预置烘焙）→ 回退功率域插值
    const samp = (arr) => { const v = bicubicAt(arr, NX, NY, fc, fr); return v > 0 ? v : bilinearAt(arr, NX, NY, fc, fr) }
    p1 = samp(beam.P1); p2 = samp(beam.P2)
  }
  let Pw
  if (pol === 'P1') Pw = p1
  else if (pol === 'P2') Pw = p2
  else if (pol === 'RSS') Pw = p1 + p2
  else if (pol === 'P1/P2') Pw = p2 > 0 ? p1 / p2 : 0
  else if (pol === 'P2/P1') Pw = p1 > 0 ? p2 / p1 : 0
  else Pw = p1
  if (!(Pw > 0)) return null
  let v = 10 * Math.log10(Pw) + gainOffset
  if (pathLoss !== 'none') v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / rs) : -10 * Math.log10(4 * Math.PI * rs * rs)
  return { db: v, u: a, v: b, slant: rs, comp }
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
// field={lon,lat,vis,db,NX,NY}；levelsAsc 升序绝对电平。返回 { fills:[band0,...], lines:[lvl0Segs,...] }：
//   fills[k] = 该档 [Lk,Lk+1) 环带的扁平几何 { verts:Float64Array[x0,y0,x1,y1,...], counts:Int32Array(各多边形顶点数) }
//             （多边形顺序拼接进 verts，counts[j] 给出第 j 个多边形的顶点数；与 shader band=k 同义）；
//   lines[k] = Lk 等值线段列表（[[lon,lat],[lon,lat]]，= fills 相邻档的公共边）。
// wantFills=false（只画等值线、不填充）时跳过逐档填充裁剪，只算线 → 关填充的大波束拖拽省一半工作量。
// 性能（拖拽热路径）：顶点存成扁平缓冲 [x,y,d,m,...]，clip 在复用的 ping-pong 缓冲间裁剪，全程零临时
//   对象分配（旧版每格每档 new 一堆 {x,y,d,m} → 13万点网格每帧几十万对象，GC 周期性卡顿的根因）。
const _BG_CAP = 16            // 单凸多边形最大顶点数（三角形经 vis+各档半平面裁剪后始终很小，16 足够）
const _bgBase = new Float64Array(_BG_CAP * 4)   // 三角形 / vis 裁剪后的基底
const _bgVis = new Float64Array(_BG_CAP * 4)
const _bgP = new Float64Array(_BG_CAP * 4)      // 逐档填充裁剪 ping-pong
const _bgQ = new Float64Array(_BG_CAP * 4)
// 分带填充输出零分配：各档顶点累加进复用的模块级 scratch（扁平 [x,y,...]），档内每个多边形的顶点数记入 _fillCnt。
// bandGeometry 末尾各档一次性 slice 成定长返回缓冲 → 每帧仅 ~2·nb 次分配，替代旧版逐多边形 new Array+[x,y]
// （大波束几十万小数组 → GC 周期性卡顿的根因；线/投影早已零分配，唯填充这条路漏网）。
const _EMPTY_F64 = new Float64Array(0), _EMPTY_I32 = new Int32Array(0)
const _fillBuf = [], _fillBufN = [], _fillCnt = [], _fillCntN = []
function _fillReset(nb) {
  for (let k = 0; k < nb; k++) {
    if (!_fillBuf[k]) { _fillBuf[k] = new Float64Array(2048); _fillCnt[k] = new Int32Array(128) }
    _fillBufN[k] = 0; _fillCntN[k] = 0
  }
}
function _fillGrowBuf(k, need) {
  const b = _fillBuf[k]
  if (need <= b.length) return b
  let cap = b.length * 2; while (cap < need) cap *= 2
  const nb = new Float64Array(cap); nb.set(b.subarray(0, _fillBufN[k])); return (_fillBuf[k] = nb)
}
function _fillPushCount(k, len) {
  let c = _fillCnt[k]
  if (_fillCntN[k] >= c.length) { const nc = new Int32Array(c.length * 2); nc.set(c); c = _fillCnt[k] = nc }
  c[_fillCntN[k]++] = len
}
function _fillPushFlat(k, src, len) {       // 从扁平 [x,y,d,m,...]（stride 4）追加 len 个顶点的 x,y
  const buf = _fillGrowBuf(k, _fillBufN[k] + len * 2); let o = _fillBufN[k]
  for (let i = 0; i < len; i++) { buf[o++] = src[i * 4]; buf[o++] = src[i * 4 + 1] }
  _fillBufN[k] = o; _fillPushCount(k, len)
}
function _fillPushLL(k, poly) {              // 从 [[lon,lat],...]（clipToHull 结果）追加
  const len = poly.length, buf = _fillGrowBuf(k, _fillBufN[k] + len * 2); let o = _fillBufN[k]
  for (let i = 0; i < len; i++) { buf[o++] = poly[i][0]; buf[o++] = poly[i][1] }
  _fillBufN[k] = o; _fillPushCount(k, len)
}
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180
// 升序数组 arr[0..nb) 中首个 > v 的下标（upper_bound，二分）。供按三角形 dB 跨度快速定位相交档区间。
const upperBound = (arr, nb, v) => { let lo = 0, hi = nb; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid } return lo }

// Sutherland-Hodgman：把凸多边形 srcFlat（扁平 [x,y,d,m,...]，len 顶点，只取 x=lon,y=lat）裁到
// 凸窗口 hull（{ ring:[[u,lat]...] CCW, satLon }，u=lon−satLon 解缠空间——绕过 ±180° 接缝）。
// 用途：把延伸到地平外的填充三角形，沿密采样的平滑地平弧（凸包）精确切到 0°仰角线，填充边缘=地平弧、无月牙缝。
// 返回裁剪后 [[lon,lat]...]（已转回标准经度）或 null（裁空）。窗口须凸+CCW。
function clipToHull(srcFlat, len, hull) {
  const R = hull.ring, nh = R.length, ref = hull.satLon
  if (nh < 3) return null
  let poly = new Array(len)
  for (let i = 0; i < len; i++) poly[i] = [wrap180(srcFlat[i * 4] - ref), srcFlat[i * 4 + 1]]   // → u 空间
  for (let e = 0; e < nh && poly.length; e++) {
    const ax = R[e][0], ay = R[e][1], bx = R[(e + 1) % nh][0], by = R[(e + 1) % nh][1]
    const ex = bx - ax, ey = by - ay
    const out = []
    let prev = poly[poly.length - 1], prevIn = ex * (prev[1] - ay) - ey * (prev[0] - ax) >= 0
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], curIn = ex * (cur[1] - ay) - ey * (cur[0] - ax) >= 0
      if (prevIn !== curIn) {                                   // 边跨窗口 → 插入交点
        const dx = cur[0] - prev[0], dy = cur[1] - prev[1], den = dx * ey - dy * ex
        const t = den !== 0 ? ((ax - prev[0]) * ey - (ay - prev[1]) * ex) / den : 0
        out.push([prev[0] + dx * t, prev[1] + dy * t])
      }
      if (curIn) out.push(cur)
      prev = cur; prevIn = curIn
    }
    poly = out
  }
  if (poly.length < 3) return null
  for (const p of poly) p[0] += ref                            // u → 经度（保持多边形内连续，勿逐点 wrap：
  return poly                                                  //   否则跨 ±180° 顶点裂成 +179/−179，2D 直线横扫全图）
}
// box（可选，与 projectGrid 同一个）：只遍历覆盖热区的格子，跳过大片无覆盖区（HTS 提速）。
// hull（可选）：该卫星的平滑地平弧凸包 { ring:[[u,lat]...] CCW, satLon }（见 useGrdCoverage.satHull）。
//   提供时跨地平三角形的填充沿此弧裁剪（边缘平滑、无锯齿）；缺省则回退到逐三角形 0°仰角线半平面裁剪。
export function bandGeometry(field, levelsAsc, wantFills = true, box = null, hull = null) {
  const { lon, lat, vis, db, NX, NY } = field
  const nb = levelsAsc.length
  const lines = Array.from({ length: nb }, () => [])
  if (!nb || !NX || !NY) return { fills: Array.from({ length: nb }, () => ({ verts: _EMPTY_F64, counts: _EMPTY_I32 })), lines }
  _fillReset(nb)
  const L0 = levelsAsc[0]
  // Sutherland-Hodgman：凸多边形(src 扁平缓冲, len 顶点数)按分量 ci(2=d,3=m) 与阈值 t 半平面裁剪写入 dst，返回新顶点数。
  // keepGE: 留分量≥t，否则留≤t。顶点 4 分量 [x,y,d,m] 全程线性插值（与旧 {x,y,d,m} 版逐位等价）。
  const clip = (src, len, ci, t, keepGE, dst) => {
    let out = 0
    for (let i = 0; i < len; i++) {
      const ai = i * 4, bi = ((i + 1) % len) * 4
      const va = src[ai + ci], vb = src[bi + ci]
      const ina = keepGE ? va >= t : va <= t, inb = keepGE ? vb >= t : vb <= t
      if (ina) { const o = out * 4; dst[o] = src[ai]; dst[o + 1] = src[ai + 1]; dst[o + 2] = src[ai + 2]; dst[o + 3] = src[ai + 3]; out++ }
      if (ina !== inb) {
        const s = (t - va) / (vb - va), o = out * 4
        dst[o] = src[ai] + (src[bi] - src[ai]) * s
        dst[o + 1] = src[ai + 1] + (src[bi + 1] - src[ai + 1]) * s
        dst[o + 2] = src[ai + 2] + (src[bi + 2] - src[ai + 2]) * s
        dst[o + 3] = src[ai + 3] + (src[bi + 3] - src[ai + 3]) * s
        out++
      }
    }
    return out
  }
  // 把三角形载入 _bgBase（外两角相对首角 ax 解缠经度），返回 false 表示该三角整体可跳过
  const loadTri = (i0, i1, i2) => {
    const d0 = db[i0], d1 = db[i1], d2 = db[i2]
    if (d0 !== d0 || d1 !== d1 || d2 !== d2) return false              // 任一角增益无效
    const m0 = vis ? vis[i0] : 1, m1 = vis ? vis[i1] : 1, m2 = vis ? vis[i2] : 1
    if (m0 < 0 && m1 < 0 && m2 < 0) return false                       // 整三角越地平
    if (!(Math.max(d0, d1, d2) >= L0)) return false                   // 全部低于最低档 → 无覆盖
    const ax = lon[i0]
    let l1 = lon[i1]; while (l1 - ax > 180) l1 -= 360; while (l1 - ax < -180) l1 += 360
    let l2 = lon[i2]; while (l2 - ax > 180) l2 -= 360; while (l2 - ax < -180) l2 += 360
    _bgBase[0] = ax; _bgBase[1] = lat[i0]; _bgBase[2] = d0; _bgBase[3] = m0
    _bgBase[4] = l1; _bgBase[5] = lat[i1]; _bgBase[6] = d1; _bgBase[7] = m1
    _bgBase[8] = l2; _bgBase[9] = lat[i2]; _bgBase[10] = d2; _bgBase[11] = m2
    return true
  }
  const useHull = !!(hull && hull.ring && hull.ring.length >= 3)
  const emitTri = (i0, i1, i2) => {
    if (!loadTri(i0, i1, i2)) return
    const crossLimb = _bgBase[3] < 0 || _bgBase[7] < 0 || _bgBase[11] < 0
    // 该三角形 dB∈[dmin,dmax] 只可能与 [kLo,kHi] 档相交（其余档裁空/裁满，纯属浪费）→ 二分定位后只遍历这几档。
    // 电平多时这是关键提速：把每三角形的 O(nb) 裁剪降到 O(相交档数)（通常 1~3 档）。kLo/kHi 同时用于填充与等值线。
    const dmin = Math.min(_bgBase[2], _bgBase[6], _bgBase[10]), dmax = Math.max(_bgBase[2], _bgBase[6], _bgBase[10])
    const kHi = upperBound(levelsAsc, nb, dmax) - 1                       // 最高一档 Lk ≤ dmax（loadTri 已保证 dmax ≥ L0 → kHi ≥ 0）
    const kLo = Math.max(0, upperBound(levelsAsc, nb, dmin) - 1)         // 最低相交档：低于此的档上边界 Lk+1 ≤ dmin，整体在三角形外
    // 线基底：跨地平时沿 0°仰角线半平面裁（等值线不溢出地平）；线不依赖 hull。
    let lineBase = _bgBase, lineLen = 3
    if (crossLimb) { lineLen = clip(_bgBase, 3, 3, 0, true, _bgVis); lineBase = _bgVis }
    if (wantFills) {
      // 填充基底：有平滑地平弧(hull) → 用未裁三角形(顶点已延伸到地平外，limbOutside)，逐档裁后再沿弧 SH 裁，
      //   填充边缘=地平弧、无月牙缝；无 hull 时回退到 0°仰角线半平面裁的基底（旧行为，可能有锯齿）。
      const fillHull = crossLimb && useHull
      const fb = (crossLimb && !useHull) ? lineBase : _bgBase
      const fbLen = (crossLimb && !useHull) ? lineLen : 3
      if (fbLen >= 3) for (let k = kLo; k <= kHi; k++) {
        let len = clip(fb, fbLen, 2, levelsAsc[k], true, _bgP)         // d ≥ Lk
        let cur = _bgP
        if (k < nb - 1 && len) { len = clip(_bgP, len, 2, levelsAsc[k + 1], false, _bgQ); cur = _bgQ }  // 且 d ≤ Lk+1（顶档不封顶）
        if (len < 3) continue
        if (fillHull) { const poly = clipToHull(cur, len, hull); if (poly && poly.length >= 3) _fillPushLL(k, poly) }
        else _fillPushFlat(k, cur, len)
      }
    }
    if (lineLen >= 3) for (let k = kLo; k <= kHi; k++) {              // 各档等值线 = lineBase 上 d==Lk 的穿越段（仅相交档）
      const L = levelsAsc[k]
      let cnt = 0, x0 = 0, y0 = 0, x1 = 0, y1 = 0
      for (let i = 0; i < lineLen; i++) {
        const ai = i * 4, bi = ((i + 1) % lineLen) * 4
        const da = lineBase[ai + 2], dbb = lineBase[bi + 2]
        if ((da < L) !== (dbb < L)) {
          const s = (L - da) / (dbb - da)
          const x = lineBase[ai] + (lineBase[bi] - lineBase[ai]) * s, y = lineBase[ai + 1] + (lineBase[bi + 1] - lineBase[ai + 1]) * s
          if (cnt === 0) { x0 = x; y0 = y } else { x1 = x; y1 = y }
          cnt++
        }
      }
      if (cnt === 2) lines[k].push([[x0, y0], [x1, y1]])               // 凸多边形上恰 0 或 2 个穿越
    }
  }
  // 格子范围：box 给定则限于热区（点投影也只在此区，索引一致）；否则全网格。
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  for (let row = rA; row < rB; row++) {
    for (let col = cA; col < cB; col++) {
      const i00 = row * NX + col, i10 = i00 + 1, i01 = i00 + NX, i11 = i01 + 1
      emitTri(i00, i10, i11); emitTri(i00, i11, i01)                  // 沿 a–c 对角线三角化（填充/线同源）
    }
  }
  // 各档 scratch 一次性拷成定长返回缓冲（每帧仅 ~2·nb 次分配）。空档返回共享空数组，免分配。
  const fills = new Array(nb)
  for (let k = 0; k < nb; k++) {
    const n = _fillBufN[k] || 0, m = _fillCntN[k] || 0
    fills[k] = { verts: n ? _fillBuf[k].slice(0, n) : _EMPTY_F64, counts: m ? _fillCnt[k].slice(0, m) : _EMPTY_I32 }
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
