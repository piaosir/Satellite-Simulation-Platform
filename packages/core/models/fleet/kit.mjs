// 星座卫星精模的造型件（在 meshKit 原语之上：倒角盒、挤出多边形、扫掠管、螺旋天线、抛物面、霍尔推力器、星敏、激光终端、
// 角反射器阵、太阳翼……）。纯 ESM、零 three 依赖，node / Worker / 渲染端共用；只 import meshKit（叶子模块），不碰 paramBus。
//
// ★ 坐标：几何一律 double，在调用方给的局部系里建；局部系 F = {o, x, y, z}（o 原点，x/y/z 为右手单位轴，均在【父系】下表示）。
//   toW(F, p) = o + x·p₀ + y·p₁ + z·p₂。节点矩阵 = colMajor([x, y, z], o)（meshKit 口径：R 的三列即三根轴）。
//   大多数零件直接在本体系里建（F = BODY，节点矩阵为单位阵）；要转动的（太阳翼、万向节上的天线）在自己的局部系里建，
//   节点矩阵 = 局部系，关节按 AGI 口径在节点局部系里转（paramBus 文件头「太阳翼节点为什么是平铺的」同一口径）。
// ★ 三角形一律逆时针朝外（材质缺省单面，背面剔除）：本文件的面片都经 tri / fan / quadPts 按给定法向自动定绕向，
//   调用方只管给点和外法向。meshKit 的 quad / box / frustum 自带正确绕向，直接用。
// ★ 这里只造网格（MB）。节点登记、部件、质量元、挂点由调用方（fleet/index.mjs 的 Builder）做——造型件与记账分开，
//   同一个造型件可以画在任意节点里。
//
// 导出（p / c / o 为三维点，d / n / u / v 为方向；长度一律米）：
//   向量：v3 add sub scl dot cross len nrm madd lerp reject axisAngle rotV
//   局部系：BODY frame(o,x,y,z) frameZX(o, z, xHint) frameXY(o, x, yHint) toW(F,p) dirW(F,d) sub-frame at(F, p, R?)
//   面片：tri(mb,a,b,c,n) fan(mb, pts, n) quadPts(mb, a,b,c,d, n)
//   体：obox(mb, F, c, h, faces?) bevelBox(mb, F, c, h, b) prism(mb, F, poly, z0, z1, {cap0, cap1, bevel?})
//        cyl(mb, p0, p1, r, seg, caps) cone(mb, p0, r0, p1, r1, seg, caps) disc(mb, c, n, r, seg) ring(mb, c, n, rIn, rOut, seg)
//        sweep(mb, pts, r, seg, {closed, caps}) torus(mb, c, n, R, r, seg, tubeSeg)
//   天线：helix(mb, base, axis, ref, {R, pitch, turns, wire, seg}) dishShell(mb, V, a, {D, f, t, na, nr})
//        dishRim(mb, V, a, {D, f, t, w, na}) hornPyr(mb, ap, dir, up, {aw, ah, tw, th, len}) hornCone = meshKit.horn
//        patchGrid(mb, F, {nx, ny, px, py, w, h, t}) 相控阵辐射单元栅格（凸起小方片）
//   执行机构 / 敏感器：hallThruster → {body, channel, pole} 三份 MB（三种材质）；starTracker → {body, baffle, lens}；
//        laserTerminal → {base, fork, tube, glass}；reflectorCorners(mb, F, {nx, ny, pitch, r, h}) 角反射器阵
//   结构：truss(mb, pts[], r, seg) 折线桁杆；hinge(mb, p, axis, r, len)
//   计量：meshArea2(mb) 网格面积；bboxOf(pts)

import { MB, quad, box, frustum, annulus, horn, perpPair } from '../meshKit.mjs'

export { MB }

// ───────────────────────────── 向量 ─────────────────────────────

export const v3 = (x, y, z) => [x, y, z]
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a) => Math.hypot(a[0], a[1], a[2])
export const nrm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0] }
export const madd = (p, a, k) => [p[0] + a[0] * k, p[1] + a[1] * k, p[2] + a[2] * k]
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export const reject = (a, n) => sub(a, scl(n, dot(a, n)))
/** 绕单位轴 k 转 deg（Rodrigues）。 */
export function rotV(v, k, deg) {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), kd = dot(k, v), kx = cross(k, v)
  return [v[0] * c + kx[0] * s + k[0] * kd * (1 - c), v[1] * c + kx[1] * s + k[1] * kd * (1 - c), v[2] * c + kx[2] * s + k[2] * kd * (1 - c)]
}
const DEG = Math.PI / 180

// ───────────────────────────── 局部系 ─────────────────────────────

/** 局部系：原点 o、右手单位轴 x / y / z（父系下）。不校验正交——调用方用 frameZX / frameXY 造。 */
export const frame = (o, x, y, z) => ({ o: o.slice(), x: x.slice(), y: y.slice(), z: z.slice() })
export const BODY = Object.freeze(frame([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]))
/** 以 z 为主轴、x 取 xHint 去掉 z 分量（xHint ∥ z 时退回 perpPair）。 */
export function frameZX(o, z, xHint) {
  const zz = nrm(z)
  let x = xHint ? reject(xHint, zz) : [0, 0, 0]
  if (len(x) < 1e-9) x = perpPair(zz)[0]
  x = nrm(x)
  return frame(o, x, cross(zz, x), zz)
}
/** 以 x 为主轴、y 取 yHint 去掉 x 分量。 */
export function frameXY(o, x, yHint) {
  const xx = nrm(x)
  let y = yHint ? reject(yHint, xx) : [0, 0, 0]
  if (len(y) < 1e-9) y = perpPair(xx)[0]
  y = nrm(y)
  return frame(o, xx, y, cross(xx, y))
}
export const toW = (F, p) => [
  F.o[0] + F.x[0] * p[0] + F.y[0] * p[1] + F.z[0] * p[2],
  F.o[1] + F.x[1] * p[0] + F.y[1] * p[1] + F.z[1] * p[2],
  F.o[2] + F.x[2] * p[0] + F.y[2] * p[1] + F.z[2] * p[2]
]
export const dirW = (F, d) => [
  F.x[0] * d[0] + F.y[0] * d[1] + F.z[0] * d[2],
  F.x[1] * d[0] + F.y[1] * d[1] + F.z[1] * d[2],
  F.x[2] * d[0] + F.y[2] * d[1] + F.z[2] * d[2]
]
/** 子系：原点取 F 里的点 p，轴取 F 的轴（不转）。 */
export const at = (F, p) => frame(toW(F, p), F.x, F.y, F.z)
/** F 绕自身某根轴（'x' | 'y' | 'z'）转 deg 后的新系（原点不动）。 */
export function turn(F, axis, deg) {
  const k = F[axis]
  return frame(F.o, rotV(F.x, k, deg), rotV(F.y, k, deg), rotV(F.z, k, deg))
}
/** meshKit / Builder 用的 R（三列 = 三根轴）。 */
export const RofF = (F) => [F.x.slice(), F.y.slice(), F.z.slice()]

// ───────────────────────────── 面片（按外法向自动定绕向） ─────────────────────────────

/** 三角形 a b c，外法向 n（绕向按 n 自动翻），顶点法向 = n（平面着色）。 */
export function tri(mb, a, b, c, n) {
  const f = dot(cross(sub(b, a), sub(c, a)), n) >= 0
  const i = mb.v(a, n), j = mb.v(b, n), k = mb.v(c, n)
  if (f) mb.t(i, j, k); else mb.t(i, k, j)
}
/** 凸多边形扇形三角化（pts 顺序任意方向，绕向按 n 定）。 */
export function fan(mb, pts, n) {
  if (pts.length < 3) return
  let cx = 0, cy = 0, cz = 0
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2] }
  const c = [cx / pts.length, cy / pts.length, cz / pts.length]
  const f = dot(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])), n) >= 0
  const ic = mb.v(c, n)
  const idx = pts.map((p) => mb.v(p, n))
  for (let k = 0; k < idx.length; k++) {
    const a = idx[k], b = idx[(k + 1) % idx.length]
    if (f) mb.t(ic, a, b); else mb.t(ic, b, a)
  }
}
/** 四边形 a b c d（按周边顺序），外法向 n。 */
export function quadPts(mb, a, b, c, d, n) {
  const f = dot(cross(sub(b, a), sub(c, a)), n) >= 0
  const i = mb.v(a, n), j = mb.v(b, n), k = mb.v(c, n), l = mb.v(d, n)
  if (f) { mb.t(i, j, k); mb.t(i, k, l) } else { mb.t(i, k, j); mb.t(i, l, k) }
}

// ───────────────────────────── 体 ─────────────────────────────

const FACE6 = ['+x', '-x', '+y', '-y', '+z', '-z']
/**
 * 局部系 F 里的轴对齐盒（中心 c、半边长 h），faces 缺省六面。平面着色，逆时针朝外。
 */
export function obox(mb, F, c, h, faces = FACE6) {
  const C = toW(F, c)
  const ax = scl(F.x, h[0]), ay = scl(F.y, h[1]), az = scl(F.z, h[2])
  for (const f of faces) {
    if (f === '+x') quad(mb, add(C, ax), ay, az)
    else if (f === '-x') quad(mb, sub(C, ax), az, ay)
    else if (f === '+y') quad(mb, add(C, ay), az, ax)
    else if (f === '-y') quad(mb, sub(C, ay), ax, az)
    else if (f === '+z') quad(mb, add(C, az), ax, ay)
    else if (f === '-z') quad(mb, sub(C, az), ay, ax)
  }
}
/**
 * 倒角盒：六个主面各内缩 b、十二条棱是 45° 斜面、八个角是三角面。硬边平面着色 —— 金属 / 漆面在棱上出一道高光，
 * 比直角盒「像真东西」得多（航天器本体的结构板边都有包边 / 圆角）。b 自动夹到最短半边长的 45 %。
 */
export function bevelBox(mb, F, c, h, b) {
  const bb = Math.max(0, Math.min(b, 0.45 * Math.min(h[0], h[1], h[2])))
  if (!(bb > 1e-6)) { obox(mb, F, c, h); return }
  const P = (x, y, z) => toW(F, [c[0] + x, c[1] + y, c[2] + z])
  const hx = h[0], hy = h[1], hz = h[2], ix = hx - bb, iy = hy - bb, iz = hz - bb
  // 主面
  for (const s of [1, -1]) {
    quadPts(mb, P(s * hx, -iy, -iz), P(s * hx, iy, -iz), P(s * hx, iy, iz), P(s * hx, -iy, iz), scl(F.x, s))
    quadPts(mb, P(-ix, s * hy, -iz), P(ix, s * hy, -iz), P(ix, s * hy, iz), P(-ix, s * hy, iz), scl(F.y, s))
    quadPts(mb, P(-ix, -iy, s * hz), P(ix, -iy, s * hz), P(ix, iy, s * hz), P(-ix, iy, s * hz), scl(F.z, s))
  }
  // 棱：沿 z 的四条（x、y 面之间）、沿 y 的四条（x、z 之间）、沿 x 的四条（y、z 之间）
  for (const sx of [1, -1]) for (const sy of [1, -1]) {
    const n = nrm(add(scl(F.x, sx), scl(F.y, sy)))
    quadPts(mb, P(sx * hx, sy * iy, -iz), P(sx * ix, sy * hy, -iz), P(sx * ix, sy * hy, iz), P(sx * hx, sy * iy, iz), n)
  }
  for (const sx of [1, -1]) for (const sz of [1, -1]) {
    const n = nrm(add(scl(F.x, sx), scl(F.z, sz)))
    quadPts(mb, P(sx * hx, -iy, sz * iz), P(sx * ix, -iy, sz * hz), P(sx * ix, iy, sz * hz), P(sx * hx, iy, sz * iz), n)
  }
  for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const n = nrm(add(scl(F.y, sy), scl(F.z, sz)))
    quadPts(mb, P(-ix, sy * hy, sz * iz), P(-ix, sy * iy, sz * hz), P(ix, sy * iy, sz * hz), P(ix, sy * hy, sz * iz), n)
  }
  // 角
  for (const sx of [1, -1]) for (const sy of [1, -1]) for (const sz of [1, -1]) {
    const n = nrm(add(add(scl(F.x, sx), scl(F.y, sy)), scl(F.z, sz)))
    tri(mb, P(sx * hx, sy * iy, sz * iz), P(sx * ix, sy * hy, sz * iz), P(sx * ix, sy * iy, sz * hz), n)
  }
}
/**
 * 直棱柱：F 的 xy 平面里的凸多边形 poly（[[x,y],…]，顺序任意）沿 z 从 z0 挤到 z1。侧面平面着色；cap0 / cap1 封底 / 顶。
 * 非凸多边形请拆成几个凸块分别挤。
 */
export function prism(mb, F, poly, z0, z1, o = {}) {
  const cap0 = o.cap0 !== false, cap1 = o.cap1 !== false
  const n = poly.length
  // 质心（用来判侧面外法向朝向）
  let cx = 0, cy = 0
  for (const q of poly) { cx += q[0]; cy += q[1] }
  cx /= n; cy /= n
  for (let k = 0; k < n; k++) {
    const a = poly[k], b = poly[(k + 1) % n]
    const ex = b[0] - a[0], ey = b[1] - a[1]
    let nx = ey, ny = -ex
    const mx = (a[0] + b[0]) / 2 - cx, my = (a[1] + b[1]) / 2 - cy
    if (nx * mx + ny * my < 0) { nx = -nx; ny = -ny }
    const nl = Math.hypot(nx, ny) || 1
    const nW = dirW(F, [nx / nl, ny / nl, 0])
    quadPts(mb, toW(F, [a[0], a[1], z0]), toW(F, [b[0], b[1], z0]), toW(F, [b[0], b[1], z1]), toW(F, [a[0], a[1], z1]), nW)
  }
  if (cap0) fan(mb, poly.map((q) => toW(F, [q[0], q[1], z0])), scl(F.z, z1 >= z0 ? -1 : 1))
  if (cap1) fan(mb, poly.map((q) => toW(F, [q[0], q[1], z1])), scl(F.z, z1 >= z0 ? 1 : -1))
}
/**
 * 放样：F 的 xy 平面里两圈顶点数相同的多边形 A（z = zA）与 B（z = zB）之间连侧面；每个四边形拆成两个平面三角形
 * （各自法向，硬边——隔热帐 / 天线罩那种「折面」观感就靠它）。capA / capB 封口（凸多边形）。
 */
export function loft(mb, F, A, zA, Bp, zB, o = {}) {
  const n = A.length
  let cx = 0, cy = 0
  for (const q of A) { cx += q[0]; cy += q[1] }
  cx /= n; cy /= n
  const zc = (zA + zB) / 2
  const C = toW(F, [cx, cy, zc])
  for (let k = 0; k < n; k++) {
    const a0 = toW(F, [A[k][0], A[k][1], zA]), a1 = toW(F, [A[(k + 1) % n][0], A[(k + 1) % n][1], zA])
    const b0 = toW(F, [Bp[k][0], Bp[k][1], zB]), b1 = toW(F, [Bp[(k + 1) % n][0], Bp[(k + 1) % n][1], zB])
    for (const [p, q, r] of [[a0, a1, b1], [a0, b1, b0]]) {
      let nn = nrm(cross(sub(q, p), sub(r, p)))
      const m = scl(add(add(p, q), r), 1 / 3)
      if (dot(nn, sub(m, C)) < 0) nn = scl(nn, -1)
      tri(mb, p, q, r, nn)
    }
  }
  if (o.capA) fan(mb, A.map((q) => toW(F, [q[0], q[1], zA])), scl(F.z, zB >= zA ? -1 : 1))
  if (o.capB) fan(mb, Bp.map((q) => toW(F, [q[0], q[1], zB])), scl(F.z, zB >= zA ? 1 : -1))
}
/** 正 n 边形（外接圆半径 r，第一个顶点在 +x 转 phaseDeg）。 */
export function ngon(n, r, phaseDeg = 0) {
  const out = []
  for (let k = 0; k < n; k++) { const t = (phaseDeg + 360 * k / n) * DEG; out.push([r * Math.cos(t), r * Math.sin(t)]) }
  return out
}
/** 圆柱（平滑侧面）。 */
export const cyl = (mb, p0, p1, r, seg = 24, cap0 = true, cap1 = true) => frustum(mb, p0, r, p1, r, seg, cap0, cap1, false)
/** 截锥（平滑侧面）。 */
export const cone = (mb, p0, r0, p1, r1, seg = 24, cap0 = true, cap1 = true) => frustum(mb, p0, r0, p1, r1, seg, cap0, cap1, false)
/** 圆盘（法向 n 一侧可见）。 */
export function disc(mb, c, n, r, seg = 24) {
  const nn = nrm(n), [e1, e2] = perpPair(nn)
  const ic = mb.v(c, nn)
  const first = mb.vcount
  for (let j = 0; j < seg; j++) {
    const t = 2 * Math.PI * j / seg
    mb.v(add(c, add(scl(e1, r * Math.cos(t)), scl(e2, r * Math.sin(t)))), nn)
  }
  for (let j = 0; j < seg; j++) mb.t(ic, first + j, first + ((j + 1) % seg))
}
/** 平环（法向 n 一侧可见）。 */
export const ring = (mb, c, n, rIn, rOut, seg = 32) => annulus(mb, c, nrm(n), rIn, rOut, seg, nrm(n))
/**
 * 扫掠管：沿折线 pts 扫一个半径 r 的圆（旋转最小化标架，管身平滑着色）。closed = 首尾相接；caps = 两端封口。
 */
export function sweep(mb, pts, r, seg = 8, o = {}) {
  const closed = !!o.closed, caps = o.caps !== false && !closed
  const n = pts.length
  if (n < 2) return
  const T = []
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)]
    T.push(nrm(sub(b, a)))
  }
  // 初始法向：与 T0 正交；之后按双反射法（rotation-minimizing frame）传递
  let N = perpPair(T[0])[0]
  const Ns = [N]
  for (let i = 1; i < n; i++) {
    const v1 = sub(pts[i], pts[i - 1]), c1 = dot(v1, v1)
    if (c1 < 1e-18) { Ns.push(N); continue }
    const rL = sub(N, scl(v1, 2 * dot(v1, N) / c1)), tL = sub(T[i - 1], scl(v1, 2 * dot(v1, T[i - 1]) / c1))
    const v2 = sub(T[i], tL), c2 = dot(v2, v2)
    N = c2 < 1e-18 ? rL : sub(rL, scl(v2, 2 * dot(v2, rL) / c2))
    N = nrm(reject(N, T[i]))
    Ns.push(N)
  }
  const base = mb.vcount
  for (let i = 0; i < n; i++) {
    const B = cross(T[i], Ns[i])
    for (let j = 0; j < seg; j++) {
      const t = 2 * Math.PI * j / seg, q = add(scl(Ns[i], Math.cos(t)), scl(B, Math.sin(t)))
      mb.v(madd(pts[i], q, r), q)
    }
  }
  const rings = closed ? n : n - 1
  for (let i = 0; i < rings; i++) {
    const i0 = base + i * seg, i1 = base + ((i + 1) % n) * seg
    for (let j = 0; j < seg; j++) {
      const a = i0 + j, b = i0 + (j + 1) % seg, c = i1 + j, d = i1 + (j + 1) % seg
      mb.t(a, b, d); mb.t(a, d, c)
    }
  }
  if (caps) {
    disc(mb, pts[0], scl(T[0], -1), r, seg)
    disc(mb, pts[n - 1], T[n - 1], r, seg)
  }
}
/** 圆环（管半径 r、环半径 R、环面法向 n）。 */
export function torus(mb, c, n, R, r, seg = 32, tubeSeg = 8) {
  const [e1, e2] = perpPair(nrm(n))
  const pts = []
  for (let j = 0; j < seg; j++) { const t = 2 * Math.PI * j / seg; pts.push(add(c, add(scl(e1, R * Math.cos(t)), scl(e2, R * Math.sin(t))))) }
  sweep(mb, pts, r, tubeSeg, { closed: true })
}

// ───────────────────────────── 天线 ─────────────────────────────

/**
 * 轴向模螺旋天线：底座 base、轴 axis（辐射方向）、ref = 起绕方向（⟂ axis 的参考向），半径 R、螺距 pitch、圈数 turns、线径 wire。
 * 右旋（沿 axis 看逆时针前进 = RHCP，导航星的 L 波段阵都是右旋圆极化）。返回末端点。
 */
export function helix(mb, base, axis, ref, { R, pitch, turns, wire, seg = 20, tubeSeg = 6 }) {
  const a = nrm(axis)
  let e1 = reject(ref || perpPair(a)[0], a); if (len(e1) < 1e-9) e1 = perpPair(a)[0]
  e1 = nrm(e1)
  const e2 = cross(a, e1)
  const nPts = Math.max(8, Math.ceil(turns * seg))
  const pts = []
  for (let i = 0; i <= nPts; i++) {
    const s = i / nPts, th = 2 * Math.PI * turns * s
    pts.push(add(add(base, scl(a, pitch * turns * s)), add(scl(e1, R * Math.cos(th)), scl(e2, R * Math.sin(th)))))
  }
  // 馈电段：从轴心直上到螺旋起点（真实螺旋天线的馈点在地板中心附近）
  sweep(mb, [base, pts[0]], wire, tubeSeg)
  sweep(mb, pts, wire, tubeSeg)
  return pts[pts.length - 1]
}
/**
 * 轴对称抛物面反射面（正馈）：顶点 V、轴 a（顶点 → 焦点）、口径 D、焦距 f、厚 t。
 * 凹面（朝焦点）与凸背面两层，法向各自朝外；口沿另画（dishRim）。na × nr 细分。
 * 返回 {F 焦点, rimZ 口面离顶点的高度}。
 */
export function dishShell(mb, V, a, { D, f, t = 0.01, na = 48, nr = 10, back = true }) {
  const aa = nrm(a), [e1, e2] = perpPair(aa)
  const R = D / 2
  const P = (r, th) => add(add(V, scl(aa, r * r / (4 * f))), add(scl(e1, r * Math.cos(th)), scl(e2, r * Math.sin(th))))
  const Nf = (r, th) => nrm(sub(aa, scl(add(scl(e1, Math.cos(th)), scl(e2, Math.sin(th))), r / (2 * f))))
  const grid = (off, sign) => {
    const base = mb.vcount
    for (let i = 0; i <= nr; i++) {
      const r = R * i / nr
      for (let j = 0; j < na; j++) {
        const th = 2 * Math.PI * j / na, n = Nf(r, th)
        mb.v(madd(P(r, th), n, off), scl(n, sign))
      }
    }
    for (let i = 0; i < nr; i++) {
      for (let j = 0; j < na; j++) {
        const a0 = base + i * na + j, a1 = base + i * na + (j + 1) % na, b0 = a0 + na, b1 = a1 + na
        if (sign > 0) { mb.t(a0, b0, b1); mb.t(a0, b1, a1) } else { mb.t(a0, b1, b0); mb.t(a0, a1, b1) }
      }
    }
  }
  grid(0, 1)
  if (back) grid(-t, -1)
  return { F: madd(V, aa, f), rimZ: R * R / (4 * f) }
}
/** 抛物面口沿：口面处宽 w 的外翻平环 + 两层之间的侧带。 */
export function dishRim(mb, V, a, { D, f, t = 0.01, w = 0.02, na = 48 }) {
  const aa = nrm(a), R = D / 2, z = R * R / (4 * f)
  const c = madd(V, aa, z)
  ring(mb, c, aa, R, R + w, na)
  cyl(mb, madd(c, aa, -t), c, R + w, na, false, false)
  ring(mb, madd(c, aa, -t), scl(aa, -1), R, R + w, na)
}
/**
 * 角锥喇叭（矩形口）：口面中心 ap、辐射方向 dir、口面 up 向（口宽 aw 沿 up×dir、口高 ah 沿 up）、喉部 tw × th、长 len。
 * 外壁四面 + 口沿（内壁省略——口面封一张深色面由调用方另画）。
 */
export function hornPyr(mb, ap, dir, up, { aw, ah, tw, th, len: L }) {
  const d = nrm(dir), u = nrm(reject(up, d)), r = cross(u, d)
  const t0 = madd(ap, d, -L)
  const A = (p, sr, su, w, h) => add(p, add(scl(r, sr * w / 2), scl(u, su * h / 2)))
  const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
  for (let k = 0; k < 4; k++) {
    const [s1, s2] = corners[k], [q1, q2] = corners[(k + 1) % 4]
    const a0 = A(t0, s1, s2, tw, th), b0 = A(t0, q1, q2, tw, th), a1 = A(ap, s1, s2, aw, ah), b1 = A(ap, q1, q2, aw, ah)
    const mid = scl(add(add(a0, b0), add(a1, b1)), 0.25), cen = madd(ap, d, -L / 2)
    const n = nrm(cross(sub(b0, a0), sub(a1, a0)))
    quadPts(mb, a0, b0, b1, a1, dot(n, sub(mid, cen)) >= 0 ? n : scl(n, -1))
  }
  quadPts(mb, A(t0, 1, 1, tw, th), A(t0, -1, 1, tw, th), A(t0, -1, -1, tw, th), A(t0, 1, -1, tw, th), scl(d, -1))
}
/**
 * 相控阵辐射单元栅格：F 的 xy 平面上 nx × ny 个小方片（边长 w × h、高 t，中心距 px × py），整体居中于 F 原点、凸向 +z。
 * 只画顶面与四个侧面（底面贴在阵面上看不见）。
 */
export function patchGrid(mb, F, { nx, ny, px, py, w, h, t, z0 = 0 }) {
  const x0 = -(nx - 1) * px / 2, y0 = -(ny - 1) * py / 2
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    obox(mb, F, [x0 + i * px, y0 + j * py, z0 + t / 2], [w / 2, h / 2, t / 2], ['+x', '-x', '+y', '-y', '+z'])
  }
}

// ───────────────────────────── 执行机构 / 敏感器 ─────────────────────────────

/**
 * 霍尔推力器（SPT / 霍尔效应）：出口中心 exit、喷流方向 dir、外半径 R、长 L。
 * 返回三份网格（不同材质）：body（外壳 + 后盖，金属）、channel（出口环形放电通道，深色陶瓷）、pole（中心磁极 + 外磁极环面，钛）、
 * 另挂一根空心阴极（cathode，并进 body）。
 */
export function hallThruster({ exit, dir, R, L, seg = 28 }) {
  const d = nrm(dir), back = madd(exit, d, -L)
  const [e1] = perpPair(d)
  const body = new MB(), channel = new MB(), pole = new MB()
  cyl(body, back, madd(exit, d, -0.002 * R / 0.05), R, seg, true, false)
  // 出口面：外磁极环（R·0.78 → R）、放电通道（R·0.48 → R·0.78，内凹 6 % L）、中心磁极（R·0.48 内）
  ring(pole, exit, d, R * 0.78, R, seg)
  const chIn = madd(exit, d, -0.06 * L)
  ring(channel, chIn, d, R * 0.48, R * 0.78, seg)
  frustum(channel, chIn, R * 0.78, exit, R * 0.78, seg, false, false, true)
  frustum(channel, chIn, R * 0.48, exit, R * 0.48, seg, false, false, false)
  disc(pole, madd(exit, d, 0.004 * R / 0.05), d, R * 0.44, seg)
  cyl(pole, exit, madd(exit, d, 0.004 * R / 0.05), R * 0.44, seg, false, false)
  // 空心阴极：出口旁侧、与轴成 15° 的细管
  const cBase = madd(add(exit, scl(e1, R * 1.25)), d, -0.35 * L)
  const cTip = madd(add(exit, scl(e1, R * 1.1)), d, 0.08 * L)
  cyl(body, cBase, cTip, R * 0.12, 12, true, true)
  cyl(body, madd(back, d, 0.15 * L), add(madd(back, d, 0.15 * L), scl(e1, R * 1.25)), R * 0.06, 8, true, true)
  return { body, channel, pole }
}
/**
 * 星敏感器：安装点 base（贴在结构面上）、视轴 dir、up（电子盒长边方向）、遮光罩口径 dB / 长 lB、电子盒 a × b × c。
 * 返回 {body（电子盒，金属）, baffle（遮光罩外壁 + 内壁，黑）, lens（镜头玻璃）}。
 */
export function starTracker({ base, dir, up, box: bx = [0.12, 0.12, 0.08], dB = 0.1, lB = 0.14, seg = 24 }) {
  const d = nrm(dir), F = frameZX(base, d, up)
  const body = new MB(), baffle = new MB(), lens = new MB()
  obox(body, F, [0, 0, bx[2] / 2], [bx[0] / 2, bx[1] / 2, bx[2] / 2])
  const b0 = toW(F, [0, 0, bx[2]]), b1 = toW(F, [0, 0, bx[2] + lB])
  frustum(baffle, b0, dB * 0.36, b1, dB / 2, seg, false, false, false)
  frustum(baffle, b0, dB * 0.34, b1, dB / 2 - 0.004, seg, false, false, true)
  ring(baffle, b1, d, dB / 2 - 0.004, dB / 2, seg)
  disc(lens, madd(b0, d, 0.004), d, dB * 0.34, seg)
  return { body, baffle, lens }
}
/**
 * 激光通信终端（粗瞄转台 + 望远镜）：底座 base、安装面法向 n、望远镜指向 look（在 n 半球内）、口径 D。
 * 返回 {base（转台座，金属）, fork（叉架，白）, tube（镜筒，白）, glass（窗口，深色玻璃）}。
 */
export function laserTerminal({ base, n, look, D, seg = 24 }) {
  const nn = nrm(n), lk = nrm(look)
  const baseM = new MB(), fork = new MB(), tube = new MB(), glass = new MB()
  const hB = 0.55 * D, rB = 0.75 * D
  cyl(baseM, base, madd(base, nn, hB), rB, seg, false, true)
  // 俯仰轴心：转台上方 0.6 D；镜筒长 1.6 D、半径 0.55 D，沿 look
  const piv = madd(base, nn, hB + 0.6 * D)
  const [s1] = perpPair(lk)
  const side = nrm(reject(cross(nn, lk).every((x) => Math.abs(x) < 1e-9) ? s1 : cross(nn, lk), lk))
  for (const s of [1, -1]) {
    const arm = madd(piv, side, s * 0.7 * D)
    sweep(fork, [madd(base, nn, hB), madd(add(base, scl(side, s * 0.7 * D)), nn, hB), arm], 0.09 * D, 8)
  }
  const t0 = madd(piv, lk, -0.6 * D), t1 = madd(piv, lk, 1.0 * D)
  cyl(tube, t0, t1, 0.55 * D, seg, true, false)
  frustum(tube, t1, 0.55 * D, madd(t1, lk, 0.25 * D), 0.62 * D, seg, false, false, false)
  frustum(tube, t1, 0.5 * D, madd(t1, lk, 0.25 * D), 0.58 * D, seg, false, false, true)
  disc(glass, madd(t1, lk, 0.02 * D), lk, 0.5 * D, seg)
  return { base: baseM, fork, tube, glass }
}
/**
 * 激光角反射器阵（LRA）：F 的 xy 面上 nx × ny 个角锥棱镜（圆口深色玻璃），中心距 pitch、口半径 r、露出高度 hh；
 * 返回 {plate（安装板）, cubes（棱镜口）}。板边长按栅格外扩一个 pitch。
 */
export function reflectorCorners({ F, nx, ny, pitch, r, hh = 0.004, plateT = 0.01, hexStagger = true }) {
  const plate = new MB(), cubes = new MB()
  const W = (nx + (hexStagger ? 0.5 : 0)) * pitch + pitch * 0.4, H = ny * pitch * (hexStagger ? 0.866 : 1) + pitch * 0.4
  obox(plate, F, [0, 0, plateT / 2], [W / 2, H / 2, plateT / 2], ['+x', '-x', '+y', '-y', '+z'])
  const py = hexStagger ? pitch * 0.866 : pitch
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = (i - (nx - 1) / 2) * pitch + (hexStagger && j % 2 ? pitch / 2 : 0) - (hexStagger ? pitch / 4 : 0)
    const y = (j - (ny - 1) / 2) * py
    const c0 = toW(F, [x, y, plateT]), c1 = toW(F, [x, y, plateT + hh])
    cyl(cubes, c0, c1, r, 12, false, true)
  }
  return { plate, cubes }
}

// ───────────────────────────── 结构 ─────────────────────────────

/** 折线桁杆（每段一根圆管，段间不做圆角）。 */
export function truss(mb, pts, r, seg = 8) {
  for (let i = 0; i + 1 < pts.length; i++) cyl(mb, pts[i], pts[i + 1], r, seg, true, true)
}
/** 铰链：以 p 为中心、沿 axis 长 L、半径 r 的圆柱。 */
export const hinge = (mb, p, axis, r, L, seg = 12) => cyl(mb, madd(p, nrm(axis), -L / 2), madd(p, nrm(axis), L / 2), r, seg, true, true)
/** 直角盒（本体系 / 任意局部系）简写：中心 c、半边长 h。 */
export const boxAt = (mb, F, c, h, faces) => obox(mb, F, c, h, faces)
export { box, quad, frustum, horn, annulus, perpPair }

// ───────────────────────────── 计量 ─────────────────────────────

/** 网格面积（MB 的局部坐标）。 */
export function meshArea2(mb) {
  let A = 0
  const p = mb.p, idx = mb.idx
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    A += len(cross([p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]], [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]])) / 2
  }
  return A
}
/** 网格的有向体积（闭合网格 > 0 表示绕向朝外正确；单测查造型件用）。 */
export function signedVolume(mb) {
  let V = 0
  const p = mb.p, idx = mb.idx
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    V += dot([p[a], p[a + 1], p[a + 2]], cross([p[b], p[b + 1], p[b + 2]], [p[c], p[c + 1], p[c + 2]])) / 6
  }
  return V
}
