// 轨道壳层投影 —— 对星覆盖分析的几何核（无 Vue / DOM 依赖，可离线单测）。
//
// 与对地覆盖（coverage.js）最关键的口径差别，改这个文件前先读懂：
//   对地：整张网格先投到 WGS84 椭球得经纬度 → 再在【经纬度域】上切等值线/分带填充。
//   对星：等值线/分带填充切在【天线网格域 (X,Y)】上 → 切出来的顶点再逐点投到各壳层。
// 倒过来的三个理由：
//   ① bandGeometry 一行不用改就能吃参数域（把它的 lon/lat 两条数组换成 gridXY 的 gx/gy 即可）；
//   ② 一次几何、多壳复用——同一组顶点投到不同半径就是不同壳层的线，顶点量级几千，比整张网格便宜两个量级；
//   ③ 参数域以 boresight 为原点，永不跨极点/接缝。上方壳层的投影可以覆盖半个天球，
//      放在经纬度域里做半平面裁剪会在极点处退化，放在参数域里则完全不存在这个问题。
//
// 「壳层」= 地心球面 r = A + h（不是 WGS84 椭球+h）：壳层是概念面，用球与「轨道高度」口径一致，
// 且球面在任意方向上各向同性、求交只需一次开方。目标星取值走各自的真实 ECEF 位置，不吃这个近似。
import { A, B } from '../wgs84.js'
import { gridDir, invGridDir, gridDirs } from './coverage.js'

const R2D = 180 / Math.PI
const MARGIN_INF = 1e3        // 「恒相交」的裕度占位（卫星在壳内时每条射线都命中）

// ==================== 壳层几何常量 ====================
// 一个 (basis, R, hEx) 组合的全部预算量。逐格点热路径只读这里的标量，不再重复开方。
//   inside : 卫星在壳层【内】（R ≥ rS）——每条射线恰一个交点，全 4π 方向都落在壳上（反天底侧也照落）
//   cosA/sinA : 壳层对卫星张开的锥半角 α=asin(R/rS) 的余弦/正弦（inside 时无意义）
//   cosAe/sinAe : 地球（含排除高度 hEx）在【归一空间】张开的锥半角
// hExKm = 大气/临边排除高度：把椭球膨胀 hEx 后再判遮挡，0 = 纯几何。
export function shellGeom(basis, R, hExKm = 0) {
  const S = basis.S
  const rS = Math.hypot(S[0], S[1], S[2]) || 1
  const inside = R >= rS - 1e-6
  const sinA = inside ? 1 : R / rS
  const cosA = inside ? -1 : Math.sqrt(Math.max(0, 1 - sinA * sinA))
  // 地球遮挡在【归一空间】(x/a, y/a, z/b) 里算——该空间中椭球就是单位球，可以套同一个锥公式。
  // 归一空间的「角度」与真实角度单调同号、零点严格重合（相切在任何线性变换下不变），
  // 而我们只用它做 ①符号判断 ②线性插值找零点，故不影响边界位置。
  const ea = A + hExKm, eb = B + hExKm
  const Sn = [S[0] / ea, S[1] / ea, S[2] / eb]
  const rho = Math.hypot(Sn[0], Sn[1], Sn[2]) || 1
  const okE = rho > 1.000001
  return {
    S, rS, R, inside, sinA, cosA, ea, eb, Sn, rho,
    cosAe: okE ? Math.sqrt(Math.max(0, 1 - 1 / (rho * rho))) : 1,
    sinAe: okE ? 1 / rho : 1,
    noEarth: !okE            // 卫星在（膨胀后的）地球内：遮挡判据失效，一律按不遮挡处理
  }
}

// 该壳层是否只有一个交点（卫星在壳内 → 只有 far 支）
export const shellSingleBranch = (g) => g.inside

// 射线方向 d（ECEF 单位矢量）对壳层的【角度裕度】(rad 量纲)：>0 相交、=0 相切、<0 错过。
// 用 (cosθ − cosα)/sinα 而不是 acos 之差：无反三角函数，零点严格重合，近零处斜率≈1（与角度同量纲，
// 才能和地球裕度用 min() 合并——两者量纲不一致时，同一条边上二者都穿零的极罕见格子会插错位置）。
export function shellMargin(g, d) {
  if (g.inside) return MARGIN_INF
  const cd = -(g.S[0] * d[0] + g.S[1] * d[1] + g.S[2] * d[2]) / g.rS   // cos(与天底夹角)
  return (cd - g.cosA) / g.sinA
}

// 地球遮挡裕度：>0 表示这条射线【打中】地球（会挡住其后的一切）、<0 擦过或错过。
// 量纲与 shellMargin 一致（都除掉了各自的 sinα），故二者可以直接 min()。
export function earthMargin(g, d) {
  if (g.noEarth) return -MARGIN_INF
  const dx = d[0] / g.ea, dy = d[1] / g.ea, dz = d[2] / g.eb
  const dl = Math.hypot(dx, dy, dz) || 1
  const cd = -(dx * g.Sn[0] + dy * g.Sn[1] + dz * g.Sn[2]) / (dl * g.rho)
  return (cd - g.cosAe) / g.sinAe
}

// 合并裕度（喂给 bandGeometry 的 vis）：
//   near 支 —— 交点在地球【前面】，地球挡不住它，只受壳层本身约束；
//   far  支 / 上方壳层唯一交点 —— 交点在地球【后面】或远处，射线一旦打中地球就被挡 ⇒ 可见 ⟺ −mEarth ≥ 0。
export function visMargin(g, d, branch) {
  const ms = shellMargin(g, d)
  if (branch === 'near' && !g.inside) return ms
  const me = earthMargin(g, d)
  return ms < -me ? ms : -me
}

// 射线与壳层的交点参数 t（km，d 为单位矢量）。无交点返回 NaN。
// inside：唯一正根；否则近/远两支各一个正根。
export function shellT(g, d, branch) {
  const sd = g.S[0] * d[0] + g.S[1] * d[1] + g.S[2] * d[2]
  const c = g.rS * g.rS - g.R * g.R
  const disc = sd * sd - c
  if (disc < 0) return NaN
  const q = Math.sqrt(disc)
  if (g.inside) return -sd + q                     // c<0 → 一正一负，取正根
  if (sd >= 0) return NaN                          // 背离壳层
  return branch === 'near' ? (-sd - q) : (-sd + q)
}

// 方向 d → 壳层上的地心经纬度（度）+ 斜距。未命中返回 null。
// 注意返回的是【地心】纬度，不是大地纬度：壳层本就是地心球，3D 渲染端 llaToVec 也是纯地心球，
// 两边同源，喂进去精确落在壳上；千万别在这里换算成大地纬度（会把点抬离壳面）。
export function projectDir(g, d, branch) {
  const t = shellT(g, d, branch)
  if (!(t > 0)) return null
  const px = g.S[0] + t * d[0], py = g.S[1] + t * d[1], pz = g.S[2] + t * d[2]
  const r = Math.hypot(px, py, pz) || 1
  return { lon: Math.atan2(py, px) * R2D, lat: Math.asin(Math.max(-1, Math.min(1, pz / r))) * R2D, t, ecef: [px, py, pz] }
}

// boresight 方向 d 打在半径 R 壳层上的落点 {lon, lat, altKm}（地心经纬度，与壳层同口径）。
// 「空间点指向」用：切模式时由当前指向反推初值、3D 上拖拽时由光标落点反写指向点，两处都不能返回 null
// 让指向点凭空消失，故未命中时退到【相切垂足】再径向拉回壳面（方向不变，只把点放回壳上）。
// 支的选择：卫星在壳外取近侧支（面朝卫星那一支，与画面上看到的那片覆盖同一支）；壳在卫星之上只有一支。
export function boresightShellPoint(S, d, R) {
  const g = shellGeom({ S }, R, 0)
  const p = projectDir(g, d, g.inside ? 'far' : 'near') || projectDir(g, d, 'far')
  if (p) return { lon: p.lon, lat: p.lat, altKm: R - A }
  const t = -(S[0] * d[0] + S[1] * d[1] + S[2] * d[2])
  if (!(t > 0)) return null                     // 完全背离壳层（射线朝球心反方向）
  const px = S[0] + t * d[0], py = S[1] + t * d[1], pz = S[2] + t * d[2]
  const r = Math.hypot(px, py, pz) || 1
  return { lon: Math.atan2(py, px) * R2D, lat: Math.asin(Math.max(-1, Math.min(1, pz / r))) * R2D, altKm: R - A }
}

// 天线系分量 (a,b,c) → ECEF 单位矢量（basis 正交归一，直接线性组合）
function toEcef(basis, a, b, c) {
  const { x, y, z } = basis
  const ex = x[0] * a + y[0] * b + z[0] * c, ey = x[1] * a + y[1] * b + z[1] * c, ez = x[2] * a + y[2] * b + z[2] * c
  const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
  return [ex * inv, ey * inv, ez * inv]
}

// ==================== 逐格点：裕度 + 斜距 ====================
// 只出 vis/slant 两条，【不出经纬度】——几何在参数域做，经纬度只在顶点上算（见文件头口径）。
// box（可选，与 useShellCoverage 的热区盒同一个）：只算该子矩形。out：上一帧缓冲，尺寸相同则原地复用。
// 另返回两个极值，供上层诊断「这层壳为什么没画出东西」——用户选错壳层时不能只留一片空白：
//   maxShellM < 0 → 波束根本没打到这层壳（方向全在相切锥外）
//   maxVis   < 0 → 打到了，但整片都被地球挡住（典型：天底波束 + 高于卫星的壳层）
export function shellGrid(set, igrid, basis, g, branch, box = null, out = null) {
  const { NX, NY } = set
  const N = NX * NY
  const dirs = gridDirs(set, igrid)
  const reuse = out && out.vis && out.vis.length === N
  const vis = reuse ? out.vis : new Float32Array(N)
  const slant = reuse ? out.slant : new Float32Array(N)
  let maxVis = -Infinity, maxShellM = -Infinity
  const { x, y, z } = basis
  const x0 = x[0], x1 = x[1], x2 = x[2], y0 = y[0], y1 = y[1], y2 = y[2], z0 = z[0], z1 = z[1], z2 = z[2]
  const S0 = g.S[0], S1 = g.S[1], S2 = g.S[2]
  const near = branch === 'near' && !g.inside
  const d = [0, 0, 0]
  const r0 = box ? box.r0 : 0, r1 = box ? box.r1 : NY - 1, c0 = box ? box.c0 : 0, c1 = box ? box.c1 : NX - 1
  for (let row = r0; row <= r1; row++) {
    const rowBase = row * NX
    for (let col = c0; col <= c1; col++) {
      const k = rowBase + col, o = k * 3
      const a = dirs[o], b = dirs[o + 1], cz = dirs[o + 2]
      const ex = x0 * a + y0 * b + z0 * cz, ey = x1 * a + y1 * b + z1 * cz, ez = x2 * a + y2 * b + z2 * cz
      const inv = 1 / (Math.hypot(ex, ey, ez) || 1)
      d[0] = ex * inv; d[1] = ey * inv; d[2] = ez * inv
      const ms = shellMargin(g, d)
      const mv = near ? ms : (ms < -earthMargin(g, d) ? ms : -earthMargin(g, d))
      vis[k] = mv
      if (ms > maxShellM) maxShellM = ms
      if (mv > maxVis) maxVis = mv
      const t = shellT(g, d, branch)
      slant[k] = t > 0 ? t : 0
    }
  }
  return { vis, slant, NX, NY, box, maxVis, maxShellM }
}

// ==================== 参数域顶点 → 壳层 ====================
// 返回 (X,Y) → {lon,lat} 的映射闭包。未命中壳层时回退到「相切方向」的落点，
// 保证 bandGeometry 切在 vis=0 上的边界顶点不会因浮点误差丢点（丢一个点填充多边形就裂）。
export function shellMapper(igrid, basis, g, branch) {
  return (X, Y) => {
    const dd = gridDir(igrid, X, Y)
    const d = toEcef(basis, dd[0], dd[1], dd[2])
    let t = shellT(g, d, branch)
    if (!(t > 0)) {
      // 相切兜底：取射线到球心的垂足处（disc≈0 的极限位置），再径向投到壳面
      const sd = g.S[0] * d[0] + g.S[1] * d[1] + g.S[2] * d[2]
      t = -sd
      if (!(t > 0)) return null
    }
    const px = g.S[0] + t * d[0], py = g.S[1] + t * d[1], pz = g.S[2] + t * d[2]
    const r = Math.hypot(px, py, pz) || 1                // 相切兜底时 r 略小于 R；径向缩放不改方向，
    return { lon: Math.atan2(py, px) * R2D, lat: Math.asin(Math.max(-1, Math.min(1, pz / r))) * R2D }   // 故经纬度直接取方向即可
  }
}

// 细分判据：投影弦长 / R > MAX_ARC 就继续劈。0.035 rad ≈ 2°，与 3D 覆盖填充贴球细分同档
// （2° 弦下垂 ≈1.5e-4·R，肉眼不可见）。DEPTH_CAP 防止近相切处（投影被无限拉伸）无限细分。
const MAX_ARC = 0.035
const DEPTH_CAP = 8
const PARAM_EPS = 1e-9

// 三角形（参数域三顶点 + 已投影的三个点）递归细分，叶三角推进 out。
// 输出【独立三角形】（counts 全 3）：渲染端据此跳过自己那套经纬度域细分，
// 从而绕开「上方壳层投影跨极点/跨 ±180° 时经纬度域细分会横穿地球」的坑。
function subTri(ax, ay, A3, bx, by, B3, cx, cy, C3, map, depth, out) {
  const eAB = arc(A3, B3), eBC = arc(B3, C3), eCA = arc(C3, A3)
  const mx = Math.max(eAB, eBC, eCA)
  const pAB = Math.abs(ax - bx) + Math.abs(ay - by)
  const pBC = Math.abs(bx - cx) + Math.abs(by - cy)
  const pCA = Math.abs(cx - ax) + Math.abs(cy - ay)
  if (depth >= DEPTH_CAP || mx <= MAX_ARC || Math.max(pAB, pBC, pCA) < PARAM_EPS) {
    out.push(A3.lon, A3.lat, B3.lon, B3.lat, C3.lon, C3.lat)
    return
  }
  if (mx === eAB) {
    const mxp = (ax + bx) * 0.5, myp = (ay + by) * 0.5, M = map(mxp, myp) || A3
    subTri(ax, ay, A3, mxp, myp, M, cx, cy, C3, map, depth + 1, out)
    subTri(mxp, myp, M, bx, by, B3, cx, cy, C3, map, depth + 1, out)
  } else if (mx === eBC) {
    const mxp = (bx + cx) * 0.5, myp = (by + cy) * 0.5, M = map(mxp, myp) || B3
    subTri(bx, by, B3, mxp, myp, M, ax, ay, A3, map, depth + 1, out)
    subTri(mxp, myp, M, cx, cy, C3, ax, ay, A3, map, depth + 1, out)
  } else {
    const mxp = (cx + ax) * 0.5, myp = (cy + ay) * 0.5, M = map(mxp, myp) || C3
    subTri(cx, cy, C3, mxp, myp, M, bx, by, B3, map, depth + 1, out)
    subTri(mxp, myp, M, ax, ay, A3, bx, by, B3, map, depth + 1, out)
  }
}
// 两个壳层点之间的角距（rad）——同一球面上，用弦长/R 的等价量：直接用经纬度球面余弦太贵，
// 改用单位球弦长（经纬度→方向余弦），比 acos 便宜且单调等价。
function arc(P, Q) {
  const la = P.lat / R2D, lb = Q.lat / R2D, dlo = (P.lon - Q.lon) / R2D
  const ca = Math.cos(la), cb = Math.cos(lb)
  const dx = ca * Math.cos(dlo) - cb, dy = ca * Math.sin(dlo), dz = Math.sin(la) - Math.sin(lb)
  return Math.hypot(dx, dy, dz)
}

// 分带填充：参数域多边形（bandGeometry 输出）→ 壳层上的【预细分三角形】。
// bands = [{color, verts:Float64Array[X,Y,...], counts:Int32Array}] → 同结构，但 verts 是 [lon,lat,...]、counts 全 3。
export function tessellateFills(bands, map) {
  const out = []
  for (const fb of bands) {
    const verts = fb.verts, counts = fb.counts
    const tri = []
    let vi = 0
    for (let j = 0; j < counts.length; j++) {
      const plen = counts[j]
      const ax = verts[vi * 2], ay = verts[vi * 2 + 1], A3 = map(ax, ay)
      if (A3) for (let q = 1; q < plen - 1; q++) {         // 扇形三角化（凸多边形）
        const bx = verts[(vi + q) * 2], by = verts[(vi + q) * 2 + 1]
        const cx = verts[(vi + q + 1) * 2], cy = verts[(vi + q + 1) * 2 + 1]
        const B3 = map(bx, by), C3 = map(cx, cy)
        if (B3 && C3) subTri(ax, ay, A3, bx, by, B3, cx, cy, C3, map, 0, tri)
      }
      vi += plen
    }
    if (!tri.length) continue
    const nTri = tri.length / 6
    out.push({ color: fb.color, verts: Float64Array.from(tri), counts: Int32Array.from({ length: nTri }, () => 3) })
  }
  return out
}

// 等值线：参数域线段 → 壳层上的（细分后）线段串。
export function tessellateSegs(segs, map) {
  const out = []
  for (const sg of segs) {
    const A3 = map(sg[0][0], sg[0][1]), B3 = map(sg[1][0], sg[1][1])
    if (!A3 || !B3) continue
    splitSeg(sg[0][0], sg[0][1], A3, sg[1][0], sg[1][1], B3, map, 0, out)
  }
  return out
}
function splitSeg(ax, ay, A3, bx, by, B3, map, depth, out) {
  if (depth >= DEPTH_CAP || arc(A3, B3) <= MAX_ARC || (Math.abs(ax - bx) + Math.abs(ay - by)) < PARAM_EPS) {
    out.push([[A3.lon, A3.lat], [B3.lon, B3.lat]])
    return
  }
  const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, M = map(mx, my)
  if (!M) { out.push([[A3.lon, A3.lat], [B3.lon, B3.lat]]); return }
  splitSeg(ax, ay, A3, mx, my, M, map, depth + 1, out)
  splitSeg(mx, my, M, bx, by, B3, map, depth + 1, out)
}

// 目标点（ECEF）→ 天线网格域坐标 [X,Y]；落在 boresight 背面或域外返回 null
export function dirToParam(igrid, basis, P) {
  const S = basis.S
  const ex = P[0] - S[0], ey = P[1] - S[1], ez = P[2] - S[2]
  const rs = Math.hypot(ex, ey, ez); if (!(rs > 0)) return null
  const e = [ex / rs, ey / rs, ez / rs]
  return invGridDir(igrid, dot(e, basis.x), dot(e, basis.y), dot(e, basis.z))
}

// 视线 S→P 是否被地球（膨胀 hEx）挡住。段内求交（不是无限射线）——目标星可能在地球【前面】，
// 那条射线延长后终究会打到地球，但那与遮挡无关，必须限定 t∈(0,1)。
export function losBlocked(S, P, hExKm = 0) {
  const a = A + hExKm, b = B + hExKm
  const ox = S[0] / a, oy = S[1] / a, oz = S[2] / b
  const dx = (P[0] - S[0]) / a, dy = (P[1] - S[1]) / a, dz = (P[2] - S[2]) / b
  const qa = dx * dx + dy * dy + dz * dz
  if (!(qa > 0)) return false
  const qb = 2 * (ox * dx + oy * dy + oz * dz), qc = ox * ox + oy * oy + oz * oz - 1
  const disc = qb * qb - 4 * qa * qc
  if (disc < 0) return false
  const sd = Math.sqrt(disc), t1 = (-qb - sd) / (2 * qa), t2 = (-qb + sd) / (2 * qa)
  return (t1 > 1e-9 && t1 < 1 - 1e-9) || (t2 > 1e-9 && t2 < 1 - 1e-9)
}

// ==================== 壳层候选（从星座取） ====================
// 一堆卫星 → 若干层轨道壳。「从星座取」要让人在加壳层【之前】就看清取的是哪些星座、哪些星，故连
// 星座计数与卫星清单一并带出。sats = [{ name, noradId, groupLabel, altKm, incDeg, ecc }]，
// altKm 取【平均轨道高度】(a−RE)：与时刻无关、圆轨道即壳层半径，比瞬时星下点高度稳（后者随 J2
// 短周期抖几 km，会把一层打散成好几层）。
//
// ★ 归并走【密度找峰】，不是「相邻差 ≤ tol 就并成一串」的单链聚类。喂全量在轨目录时单链必炸：
//   400~900 km 上万颗星的高度几乎连续，隔 60 km 一定有星接龙，整个 LEO 会串成一个几千颗的桶，
//   中位数毫无意义。这里先打直方图，按【计数降序】取峰做种子（种子彼此至少隔 tolKm），再把每颗星
//   归到最近的种子——真正的星座壳（Starlink 550、OneWeb 1200）自然各占一层，弥散的背景星按 tol
//   间距分层，层数受 高度跨度/tol 约束。
export function shellCandidates(sats, tolKm = 60, binKm = 5) {
  const v = (sats || []).filter((s) => s && Number.isFinite(s.altKm) && s.altKm > 0).sort((p, q) => p.altKm - q.altKm)
  if (!v.length) return []
  const tol = Math.max(1, tolKm), bw = Math.max(0.5, Math.min(binKm, tol / 4))
  const lo = v[0].altKm
  const hist = new Map()
  for (const s of v) { const b = Math.floor((s.altKm - lo) / bw); hist.set(b, (hist.get(b) || 0) + 1) }
  const seeds = []
  for (const [b] of [...hist.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0])) {
    const c = lo + (b + 0.5) * bw
    if (seeds.some((x) => Math.abs(x - c) < tol)) continue      // 已被更高的峰吃掉
    seeds.push(c)
  }
  seeds.sort((a, b) => a - b)
  const buckets = seeds.map(() => [])
  let k = 0
  for (const s of v) {                                          // 星与种子都已升序 → 单指针推进取最近
    while (k + 1 < seeds.length && Math.abs(seeds[k + 1] - s.altKm) <= Math.abs(seeds[k] - s.altKm)) k++
    buckets[k].push(s)
  }
  return buckets.filter((b) => b.length).map((b) => {
    const byGrp = new Map()
    let incLo = Infinity, incHi = -Infinity, eccMax = 0
    for (const s of b) {
      const g = s.groupLabel || '其他'
      byGrp.set(g, (byGrp.get(g) || 0) + 1)
      if (Number.isFinite(s.incDeg)) { if (s.incDeg < incLo) incLo = s.incDeg; if (s.incDeg > incHi) incHi = s.incDeg }
      if (Number.isFinite(s.ecc) && s.ecc > eccMax) eccMax = s.ecc
    }
    return {
      altKm: +b[(b.length / 2) | 0].altKm.toFixed(1), n: b.length,
      loKm: +b[0].altKm.toFixed(1), hiKm: +b[b.length - 1].altKm.toFixed(1),
      incLo: incLo === Infinity ? null : +incLo.toFixed(1),
      incHi: incHi === -Infinity ? null : +incHi.toFixed(1),
      eccMax: +eccMax.toFixed(4),
      groups: [...byGrp.entries()].map(([name, n]) => ({ name, n })).sort((p, q) => q.n - p.n || (p.name < q.name ? -1 : 1)),
      sats: b
    }
  })
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
