// 非卫星四个领域（地球站 / 飞机 / 船 / 车）装配组件共用的造型工具（三期契约 DESIGN3 §1 P1b、E2、E5；A3 规格 §3）。
//
// 纯 ESM、零 three 依赖、node 可测；确定性（无 Math.random / Date / 本地化格式；伪随机一律走 rng(hash32(参数))）。
// 只 import meshKit / paramBus（MATERIALS）/ ir（MATERIAL_KEYS），不 import 任何 components/*.mjs（防环）。
//
// ★ 来源：「参数 / 插座 / 面 / 网格 / 升力面 / 质量 / 登记 / 集装箱」各段是 components/ground.mjs 原文逐字搬来的
//   （只把 D2R 与 stage 改为导出、ISO_BOX 追加 40ftHC 键），式子与先后顺序一个都没动——地球站组件的 IR 字节靠它们。
//   ground.mjs 换成从这里 import 之后，搬迁前后 11 件缺省 + 拼装样例的 IR 必须逐字节相同（A3 规格 §3.1 验收）。
//   末段「新增」是 A3 规格 §3.2 定死签名的十来个工具（air / sea / veh 共用）。
//
// ★ 局部坐标（非卫星领域统一，与 E5 本体轴同向）：+X 前（机头 / 船艏 / 车头 / 北）、+Y 右（右舷 / 东）、+Z 向下；原点 = 安装基准点。
//   立在父面上的件 mount 插座 n = +Z（朝下贴父面）；吊挂件 n = −Z（朝上贴父面）；横向对齐件（机翼 / 平尾装机身中线）
//   子件 latMount n = −Y、父件 latSocket n = +Y。这是 E2「局部 −Z 贴父面」在 +Z 向下领域的等价落法：根件单位位姿即本体系，
//   子件滚转 0° 时与父件同向，模板直接按本体坐标搭。顶面约定：n = −Z、u = +X、v = n × u = −Y（贴顶面的 uv[1] 正向 = 左 / 西）。
//
// 导出：
//   参数：ILL ISO668 num int bool enm auto D2R
//   插座 / 面：sock standSocket hangSocket FRD_FACES planeFace faceSocket boxFacesUp latSocket latMount
//   网格：smoothNormals flipTris orientTo grid cap lathe torus prism tubeAlong mirrorY xform toFrame
//         superRing loft extrude roundRect decal wheel
//   升力面：airfoilRing liftSurface
//   质量：solidProps solidCompItems solidComp shellMass
//   登记：apLocal put putFramed stage datumAp
//   集装箱：ISO_BOX containerMeshes
//   其它：rng hash32 matOr
//   集成期合并（原 air / sea / veh / ground 各写一份的私有工具）：smooth01 mirrorCopyY beam appendMB scaleMass

import {
  isNum, add, sub, scl, dot, cross, len, nrm, reject, madd, clampN, z0, IDR,
  MB, quad, box, tube, uniq, addItem, comp, shellComp, perpPair, worldPositions, rApply
} from '../meshKit.mjs'
import { MATERIALS } from '../paramBus.mjs'
import { MATERIAL_KEYS } from '../ir.mjs'

// ───────────────────────────── 参数定义小工具 ─────────────────────────────

export const ILL = 'illustrative'
/** ISO 668:2020（系列 1 集装箱：分类、尺寸与额定值）——20 ft / 40 ft 外形尺寸的标准出处。 */
export const ISO668 = 'https://www.iso.org/standard/76912.html'
export const num = (def, unit, label, o = {}) => ({ kind: 'num', def, unit, label, source: ILL, ...o })
export const int = (def, label, o = {}) => ({ kind: 'int', def, unit: '', label, source: ILL, ...o })
export const bool = (def, label, o = {}) => ({ kind: 'bool', def, label, source: ILL, ...o })
export const enm = (def, options, label, o = {}) => ({ kind: 'enum', def, options, label, source: ILL, ...o })
/** 可空参数：null → 推算值。 */
export const auto = (v, f) => (isNum(v) ? v : f)
export const D2R = Math.PI / 180

// ───────────────────────────── 插座 / 面（FRD / NED 同向局部系） ─────────────────────────────

/** 插座（字段同 assembly-ux §3.2）。 */
export const sock = (id, pos, n, up, size, roll = 90, accepts = null) => ({ id, pos: pos.map(z0), n: n.map(z0), up: up.map(z0), size, accepts, roll })
/** 立在父面上的件：原点 = 底面安装点，n = +Z（朝下贴父面），滚转零位 +X。 */
export const standSocket = (size, roll = 15) => sock('root', [0, 0, 0], [0, 0, 1], [1, 0, 0], size, roll)
/** 吊挂件：原点 = 顶部安装点，n = −Z（朝上贴父面）。 */
export const hangSocket = (size, roll = 15) => sock('root', [0, 0, 0], [0, 0, -1], [1, 0, 0], size, roll)
/** 面坐标系约定：n = 面外法向、u = 滚转零位；v = n × u。 */
export const FRD_FACES = Object.freeze({
  top: Object.freeze({ n: [0, 0, -1], u: [1, 0, 0] }),
  bottom: Object.freeze({ n: [0, 0, 1], u: [1, 0, 0] }),
  '+Y': Object.freeze({ n: [0, 1, 0], u: [1, 0, 0] }),
  '-Y': Object.freeze({ n: [0, -1, 0], u: [1, 0, 0] }),
  '+X': Object.freeze({ n: [1, 0, 0], u: [0, 0, -1] }),
  '-X': Object.freeze({ n: [-1, 0, 0], u: [0, 0, -1] })
})
/** 平面可贴面（kind 取 FRD_FACES 的键；id 缺省同 kind）。 */
export function planeFace(kind, origin, halfU, halfV, id = kind) {
  const f = FRD_FACES[kind]
  return { id, kind: 'plane', origin: origin.map(z0), n: f.n.slice(), u: f.u.slice(), v: cross(f.n, f.u).map(z0), halfU, halfV }
}
/** 面心插座（与面同坐标系）。 */
export const faceSocket = (f, size, roll = 90, accepts = null) => sock(f.id, f.origin, f.n, f.u, size, roll, accepts)
/** 底面中心在原点、向上长高 H 的盒（长 L 沿 X、宽 W 沿 Y）的顶面与四个侧面。 */
export function boxFacesUp(L, W, H, kinds = ['top', '+X', '-X', '+Y', '-Y']) {
  const o = { top: [0, 0, -H], '+X': [L / 2, 0, -H / 2], '-X': [-L / 2, 0, -H / 2], '+Y': [0, W / 2, -H / 2], '-Y': [0, -W / 2, -H / 2] }
  const hu = { top: [L / 2, W / 2], '+X': [H / 2, W / 2], '-X': [H / 2, W / 2], '+Y': [L / 2, H / 2], '-Y': [L / 2, H / 2] }
  return kinds.map((k) => planeFace(k, o[k], hu[k][0], hu[k][1]))
}

// ───────────────────────────── 网格工具 ─────────────────────────────

/**
 * 从顶点 v0 起按三角形 [t0, 末) 面积加权重算光滑法向（没有非退化三角形引用的顶点保留原法向）。
 * 只统计 t0 之后的三角形：同一段网格内部光滑，段与段之间是硬边（材质分界、折角都这样分段）。
 */
export function smoothNormals(mb, v0, t0) {
  const n = mb.vcount - v0
  if (n <= 0) return
  const acc = new Float64Array(3 * n), P = mb.p, I = mb.idx
  for (let k = 3 * t0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2]
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2]
    const ux = P[3 * b] - ax, uy = P[3 * b + 1] - ay, uz = P[3 * b + 2] - az
    const vx = P[3 * c] - ax, vy = P[3 * c + 1] - ay, vz = P[3 * c + 2] - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    for (const q of [a, b, c]) if (q >= v0) { const o = 3 * (q - v0); acc[o] += nx; acc[o + 1] += ny; acc[o + 2] += nz }
  }
  for (let i = 0; i < n; i++) {
    const o = 3 * i, l = Math.hypot(acc[o], acc[o + 1], acc[o + 2])
    if (l > 1e-14) { const q = 3 * (v0 + i); mb.n[q] = acc[o] / l; mb.n[q + 1] = acc[o + 1] / l; mb.n[q + 2] = acc[o + 2] / l }
  }
}
/** 翻转三角形 [t0, t1) 的绕序。 */
export function flipTris(mb, t0, t1 = mb.tcount) {
  for (let k = 3 * t0; k < 3 * t1; k += 3) { const t = mb.idx[k + 1]; mb.idx[k + 1] = mb.idx[k + 2]; mb.idx[k + 2] = t }
}
/**
 * 按「朝外参考」定绕序：Σ 面积法向 · out(三角形质心) < 0 就整段翻转。out 为向量（常量方向）或函数 (质心) → 向量。
 * 这一步在算光滑法向之前做（法向由绕序决定）。
 */
export function orientTo(mb, t0, t1, out) {
  const P = mb.p, I = mb.idx
  let s = 0
  for (let k = 3 * t0; k < 3 * t1; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2]
    const u = [P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], v = [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]
    const nn = cross(u, v)
    const o = typeof out === 'function' ? out([(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3]) : out
    s += dot(nn, o)
  }
  if (s < 0) flipTris(mb, t0, t1)
}
/**
 * 点阵曲面：G[i][j]（每行点数相同）；wrap = 列首尾相接（闭合环、不重复顶点）。out 定朝外（见 orientTo）。
 * uv 米制：u = 中间行上累计弧长、v = 中间列上累计长度。推入后按三角形重算光滑法向。
 * @returns {{v0:number, t0:number, t1:number}}
 */
export function grid(mb, G, { wrap = false, out = null } = {}) {
  const v0 = mb.vcount, t0 = mb.tcount, ni = G.length, nj = G[0].length
  const im = Math.floor(ni / 2), jm = Math.floor(nj / 2)
  const U = [0], V = [0]
  for (let j = 1; j < nj; j++) U.push(U[j - 1] + len(sub(G[im][j], G[im][j - 1])))
  for (let i = 1; i < ni; i++) V.push(V[i - 1] + len(sub(G[i][jm], G[i - 1][jm])))
  for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) mb.v(G[i][j], [0, 0, 1], U[j], V[i])
  const J = wrap ? nj : nj - 1
  // 收成一点的极点行（lathe / loft / 截面收口）整行顶点重合：两个顶点重合（逐分量差 ≤ 1e-9 + 2e-7 × 量级，IR 存 float32 后
  // 就是同一个数）的三角形面积为 0，不出
  const P = mb.p, eq = (a, b) => Math.abs(a - b) <= 1e-9 + 2e-7 * Math.max(Math.abs(a), Math.abs(b))
  const same = (i, k) => eq(P[3 * i], P[3 * k]) && eq(P[3 * i + 1], P[3 * k + 1]) && eq(P[3 * i + 2], P[3 * k + 2])
  const tri = (a, b, c) => { if (!(same(a, b) || same(b, c) || same(a, c))) mb.t(a, b, c) }
  for (let i = 0; i < ni - 1; i++) {
    for (let j = 0; j < J; j++) {
      const j1 = (j + 1) % nj, a = v0 + i * nj + j, b = v0 + (i + 1) * nj + j, c = v0 + (i + 1) * nj + j1, d = v0 + i * nj + j1
      tri(a, b, c); tri(a, c, d)
    }
  }
  if (out) orientTo(mb, t0, mb.tcount, out)
  smoothNormals(mb, v0, t0)
  return { v0, t0, t1: mb.tcount }
}
/**
 * 平面环封口（扇形，另起顶点 = 硬边）。normal = 朝外法向（定绕序）；center 缺省取环平均。
 */
export function cap(mb, ring, normal, center = null) {
  const c = center || scl(ring.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / ring.length)
  const [e1, e2] = perpPair(nrm(normal))
  const v0 = mb.vcount, t0 = mb.tcount
  mb.v(c, normal, 0, 0)
  for (const p of ring) { const d = sub(p, c); mb.v(p, normal, dot(d, e1), dot(d, e2)) }
  for (let j = 0; j < ring.length; j++) mb.t(v0, v0 + 1 + j, v0 + 1 + ((j + 1) % ring.length))
  orientTo(mb, t0, mb.tcount, normal)
}
/** 轴 d 过 o 的点 → 径向分量（回转体朝外参考）。 */
const radialOut = (o, d) => (c) => reject(sub(c, o), d)
/**
 * 回转体：prof = [[s, r], …]（沿轴 s、半径 r），轴 o + d·s，e1 为 0° 方向（缺省 perpPair）；seg 段；
 * inward = true 法向朝轴（内壁）。r = 0 的端点收成极点（法向设为 ∓d）。
 */
export function lathe(mb, prof, seg, o = [0, 0, 0], d = [1, 0, 0], { e1 = null, inward = false } = {}) {
  const dd = nrm(d), [a, b] = e1 ? [nrm(reject(e1, dd)), null] : perpPair(dd)
  const bb = b || cross(dd, a)
  const G = prof.map(([s, r]) => {
    const row = []
    for (let j = 0; j < seg; j++) { const th = (2 * Math.PI * j) / seg; row.push(add(madd(o, dd, s), add(scl(a, r * Math.cos(th)), scl(bb, r * Math.sin(th))))) }
    return row
  })
  const ro = radialOut(o, dd)
  const g = grid(mb, G, { wrap: true, out: inward ? (c) => scl(ro(c), -1) : ro })
  // 极点：法向沿轴、朝外端（按相邻点的 s 判断是哪一端）
  prof.forEach(([s, r], i) => {
    if (r !== 0) return
    const nb = prof[i === 0 ? 1 : i - 1]
    const sgn = (s >= nb[0] ? 1 : -1) * (inward ? -1 : 1)
    for (let j = 0; j < seg; j++) { const q = 3 * (g.v0 + i * seg + j); mb.n[q] = dd[0] * sgn; mb.n[q + 1] = dd[1] * sgn; mb.n[q + 2] = dd[2] * sgn }
  })
  return g
}
/** 圆环管（中心 c、轴 d、大半径 R、管半径 r）。 */
export function torus(mb, c, d, R, r, segMaj = 48, segMin = 10) {
  const dd = nrm(d), [a, b] = perpPair(dd)
  const G = []
  for (let i = 0; i <= segMaj; i++) {
    const th = (2 * Math.PI * i) / segMaj, q = add(scl(a, Math.cos(th)), scl(b, Math.sin(th)))
    const row = []
    for (let j = 0; j < segMin; j++) { const ps = (2 * Math.PI * j) / segMin; row.push(add(add(c, scl(q, R + r * Math.cos(ps))), scl(dd, r * Math.sin(ps)))) }
    G.push(row)
  }
  return grid(mb, G, { wrap: true, out: (p) => { const w = sub(p, c), pr = nrm(reject(w, dd)); return sub(w, scl(pr, R)) } })
}
/** 六面体（底面四点 b[4]、顶面四点 t[4]，同向排列）：凸体，法向朝外（按体心定向）。 */
export function prism(mb, b4, t4) {
  const cen = scl([...b4, ...t4].reduce((s, p) => add(s, p), [0, 0, 0]), 1 / 8)
  const faces = [[b4[0], b4[1], b4[2], b4[3]], [t4[0], t4[1], t4[2], t4[3]]]
  for (let k = 0; k < 4; k++) { const k1 = (k + 1) % 4; faces.push([b4[k], b4[k1], t4[k1], t4[k]]) }
  for (const f of faces) {
    const v0 = mb.vcount, t0 = mb.tcount
    const nn = nrm(cross(sub(f[1], f[0]), sub(f[2], f[0])))
    const fc = scl(f.reduce((s, p) => add(s, p), [0, 0, 0]), 0.25)
    const outn = dot(nn, sub(fc, cen)) >= 0 ? nn : scl(nn, -1)
    const [e1, e2] = perpPair(outn)
    for (const p of f) mb.v(p, outn, dot(p, e1), dot(p, e2))
    mb.t(v0, v0 + 1, v0 + 2); mb.t(v0, v0 + 2, v0 + 3)
    orientTo(mb, t0, mb.tcount, outn)
  }
}
/** 两点间实心圆管（封口）。 */
export const tubeAlong = (mb, p0, p1, r, seg = 12) => { if (len(sub(p1, p0)) > 1e-9) tube(mb, p0, p1, r, seg) }
/** 顶点 [v0, 末) 关于 xz 面镜像（y 取反），三角形 [t0, 末) 绕序翻转（镜像后仍朝外）。 */
export function mirrorY(mb, v0, t0) {
  for (let i = 3 * v0; i < mb.p.length; i += 3) { mb.p[i + 1] = -mb.p[i + 1]; mb.n[i + 1] = -mb.n[i + 1] }
  flipTris(mb, t0)
}
/** 顶点 [v0, 末) 变换 p' = t + R·p（R 为列向量形式），法向 n' = R·n。 */
export function xform(mb, v0, R, t) {
  for (let i = 3 * v0; i < mb.p.length; i += 3) {
    const p = rApply(R, [mb.p[i], mb.p[i + 1], mb.p[i + 2]]), n = rApply(R, [mb.n[i], mb.n[i + 1], mb.n[i + 2]])
    mb.p[i] = p[0] + t[0]; mb.p[i + 1] = p[1] + t[1]; mb.p[i + 2] = p[2] + t[2]
    mb.n[i] = n[0]; mb.n[i + 1] = n[1]; mb.n[i + 2] = n[2]
  }
}
/** 整个网格从组件局部系换到节点系 (R, t)：p' = Rᵀ(p − t)（节点矩阵取 R、t 后世界位置不变）。 */
export function toFrame(mb, R, t) {
  for (let i = 0; i < mb.p.length; i += 3) {
    const d = [mb.p[i] - t[0], mb.p[i + 1] - t[1], mb.p[i + 2] - t[2]], n = [mb.n[i], mb.n[i + 1], mb.n[i + 2]]
    for (let k = 0; k < 3; k++) { mb.p[i + k] = dot(R[k], d); mb.n[i + k] = dot(R[k], n) }
  }
  return mb
}

// ───────────────────────────── 升力面（机翼 / 尾翼 / 翼梢小翼 / 舵 / 桨叶） ─────────────────────────────

/** NACA 四位数对称翼型半厚（闭合后缘版系数 −0.1036），x ∈ [0, 1]。 */
const nacaHalf = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x)
/**
 * 翼型截面环（弦向 xc：0 前缘 → 1 后缘；zc 上为正、按弦长归一）：从后缘沿上表面到前缘、再沿下表面回后缘（后缘一点）。
 * 余弦分布，n 为单侧点数（含前缘、不含后缘）。camber = 最大弧高 / 弦长（NACA 四位中弧线，最大弧高在 40% 弦长）。
 */
export function airfoilRing(n, t, camber = 0) {
  const xs = []
  for (let i = 0; i < n; i++) xs.push(0.5 * (1 - Math.cos(Math.PI * (i / n))))   // 0 … < 1
  const cam = (x) => (camber ? (x < 0.4 ? camber / 0.16 * (0.8 * x - x * x) : camber / 0.36 * (0.2 + 0.8 * x - x * x)) : 0)
  const ring = [[1, 0]]
  for (let i = n - 1; i >= 1; i--) ring.push([xs[i], cam(xs[i]) + nacaHalf(xs[i], t)])
  ring.push([0, 0])
  for (let i = 1; i < n; i++) ring.push([xs[i], cam(xs[i]) - nacaHalf(xs[i], t)])
  return ring
}
/**
 * 升力面放样。stations[k] = {le:[x,y,z] 前缘点, c 弦长, tc 相对厚度, s:[展向单位向量], tw 扭转角（度，前缘抬起为正）, cam?}。
 * 弦向 ĉ = −X 绕 s 转 −tw（前缘抬起），上表面方向 û = ĉ × s；截面点 = le + ĉ·(xc·c) + û·(zc·c)。
 * 两端截面封口（翼根 / 翼尖）。整体按体积定向朝外。返回 {v0, t0, t1}。n = 翼型单侧点数。
 */
export function liftSurface(mb, stations, n = 14) {
  const v0 = mb.vcount, t0 = mb.tcount
  const G = stations.map((st) => {
    const s = nrm(st.s), c0 = nrm(reject([-1, 0, 0], s)), u0 = cross(c0, s)
    const th = -(st.tw || 0) * D2R, ch = add(scl(c0, Math.cos(th)), scl(u0, Math.sin(th))), up = cross(ch, s)
    return airfoilRing(n, st.tc, st.cam || 0).map(([xc, zc]) => add(add(st.le, scl(ch, xc * st.c)), scl(up, zc * st.c)))
  })
  // 放样：环为闭合（后缘一点只出现一次，环首尾相接）
  const nj = G[0].length
  const g0 = mb.vcount
  for (let i = 0; i < G.length; i++) for (let j = 0; j < nj; j++) mb.v(G[i][j], [0, 0, 1], j, i)
  for (let i = 0; i < G.length - 1; i++) {
    for (let j = 0; j < nj; j++) {
      const j1 = (j + 1) % nj, a = g0 + i * nj + j, b = g0 + (i + 1) * nj + j, c = g0 + (i + 1) * nj + j1, d = g0 + i * nj + j1
      mb.t(a, b, c); mb.t(a, c, d)
    }
  }
  const tl = mb.tcount
  // 封口前先按体积定向放样面：暂时加两个扇形算有向体积
  const capOf = (ring) => { const cc = scl(ring.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / ring.length); return cc }
  const c0 = capOf(G[0]), c1 = capOf(G[G.length - 1])
  // 放样面的「朝外」参考：点离本截面形心
  const secC = G.map(capOf)
  orientTo(mb, t0, tl, (p) => {
    let best = 0, bd = Infinity
    for (let i = 0; i < secC.length; i++) { const dd = len(sub(p, secC[i])); if (dd < bd) { bd = dd; best = i } }
    return sub(p, secC[best])
  })
  smoothNormals(mb, v0, t0)
  const sOut0 = nrm(sub(c0, secC[Math.min(1, secC.length - 1)])), sOut1 = nrm(sub(c1, secC[Math.max(0, secC.length - 2)]))
  cap(mb, G[0], sOut0, c0)
  cap(mb, G[G.length - 1], sOut1, c1)
  return { v0, t0, t1: mb.tcount, sections: G }
}

// ───────────────────────────── 质量特性 ─────────────────────────────

/**
 * 闭合朝外三角网（可跨多个网格累加）的体积、质心、对质心惯量（单位密度，本体轴，行主序 9 元）。
 * 四面体（原点 + 三角形）积分：∫x² = V/10·(Σxᵢ² + Σ_{i<j} xᵢxⱼ)、∫xy = V/20·(Σ2xᵢyᵢ + Σ_{i≠j} xᵢyⱼ)。
 * @param {Array<{P:Float64Array|number[], idx:number[]}>} parts
 */
export function solidProps(parts) {
  let V = 0, sx = 0, sy = 0, sz = 0, xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0
  for (const { P, idx } of parts) {
    for (let k = 0; k < idx.length; k += 3) {
      const a = 3 * idx[k], b = 3 * idx[k + 1], c = 3 * idx[k + 2]
      const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2]
      const v = (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6
      V += v
      sx += v * (ax + bx + cx) / 4; sy += v * (ay + by + cy) / 4; sz += v * (az + bz + cz) / 4
      xx += v / 10 * (ax * ax + bx * bx + cx * cx + ax * bx + ax * cx + bx * cx)
      yy += v / 10 * (ay * ay + by * by + cy * cy + ay * by + ay * cy + by * cy)
      zz += v / 10 * (az * az + bz * bz + cz * cz + az * bz + az * cz + bz * cz)
      xy += v / 20 * (2 * (ax * ay + bx * by + cx * cy) + ax * by + ay * bx + ax * cy + ay * cx + bx * cy + by * cx)
      yz += v / 20 * (2 * (ay * az + by * bz + cy * cz) + ay * bz + az * by + ay * cz + az * cy + by * cz + bz * cy)
      zx += v / 20 * (2 * (az * ax + bz * bx + cz * cx) + az * bx + ax * bz + az * cx + ax * cz + bz * cx + bx * cz)
    }
  }
  if (!(V > 0)) return { V: 0, com: [0, 0, 0], I: [0, 0, 0, 0, 0, 0, 0, 0, 0] }
  const c = [sx / V, sy / V, sz / V]
  // 对原点：Ixx = ∫(y²+z²)、Ixy = −∫xy …；再移到质心（减 V(|c|²E − c cᵀ)）
  const Io = [yy + zz, -xy, -zx, -xy, xx + zz, -yz, -zx, -yz, xx + yy]
  const c2 = dot(c, c), cc = [c[0] * c[0], c[0] * c[1], c[0] * c[2], c[1] * c[0], c[1] * c[1], c[1] * c[2], c[2] * c[0], c[2] * c[1], c[2] * c[2]]
  const I = Io.map((v, i) => v - V * ((i % 4 === 0 ? c2 : 0) - cc[i]))
  return { V, com: c, I }
}
/** 若干节点（addItem 的返回）合成一个实心质量元：密度 × 体积（闭合朝外网格，节点局部 → 组件局部）。体积非正时记警告跳过。 */
export function solidCompItems(ctx, name, items, density, massKg = null) {
  const sp = solidProps(items.map((it) => ({ P: worldPositions(it.mb, it.R, it.t), idx: it.mb.idx })))
  if (!(sp.V > 0)) { ctx.warnings.push(`${name}：网格不闭合，未计质量`); return sp }
  const m = isNum(massKg) && massKg > 0 ? massKg : density * sp.V
  comp(ctx, name, 'solid', m, sp.com, sp.I.map((v) => v * m / sp.V))
  return sp
}
export const solidComp = (ctx, name, it, density, massKg = null) => solidCompItems(ctx, name, [it], density, massKg)
/** 薄壳质量（面密度 × 面积），返回面积。 */
export const shellMass = (ctx, name, it, areal) => shellComp(ctx, name, it, areal).area

// ───────────────────────────── 关节 stage（名 / 类型 / 限位 / 初值） ─────────────────────────────

/** 关节级（glTF AGI_articulations 口径；初值夹进限位）。 */
export const stage = (name, type, min, max, init) => ({ name, type, minimumValue: z0(min), maximumValue: z0(max), initialValue: z0(clampN(init, min, max)) })

// ───────────────────────────── 组件内部登记小工具 ─────────────────────────────

/** 挂点（局部系；up 为 null = 到本体系按 D1 缺省补）。 */
export function apLocal(ctx, name, pos, dir, up = null) {
  const d = nrm(dir)
  let u = null
  if (up) { const r = reject(up, d); if (len(r) > 1e-6) u = nrm(r) }
  ctx.aps.push({ name: uniq(ctx, name), posBody: pos.map(z0), dirBody: d.map(z0), upBody: u ? u.map(z0) : null })
}
/** 登记一个几何节点（mb 为空时不登记，返回 null）。 */
export function put(ctx, name, role, part, mat, mb, R = IDR, t = [0, 0, 0]) {
  if (!mb || !mb.tcount) return null
  return addItem(ctx, { name, role, part, mat, mb, R, t })
}
/** 一组网格在局部系建好后换到关节节点系 G（原点 o）再登记：节点矩阵 = (G, o)，世界位置不变。 */
export function putFramed(ctx, name, role, part, mat, mb, G, o) {
  if (!mb || !mb.tcount) return null
  toFrame(mb, G, o)
  return addItem(ctx, { name, role, part, mat, mb, R: G, t: o.slice() })
}

// ───────────────────────────── 集装箱（ISO 668） ─────────────────────────────

/** ISO 668 系列 1 集装箱外形（m）：10 ft = 1D、20 ft = 1C、40 ft = 1A、40 ft 高箱 = 1AAA；宽 8 ft、高 8 ft 6 in（高箱 9 ft 6 in）。 */
export const ISO_BOX = Object.freeze({
  '10ft': Object.freeze({ L: 2.991, W: 2.438, H: 2.591 }),
  '20ft': Object.freeze({ L: 6.058, W: 2.438, H: 2.591 }),
  '40ft': Object.freeze({ L: 12.192, W: 2.438, H: 2.591 }),
  '40ftHC': Object.freeze({ L: 12.192, W: 2.438, H: 2.896 })
})

/** 集装箱式箱体（壁板 / 角柱 / 角件 / 上下边梁；container 另加瓦楞与货门，shelter 另加侧门与空调）。坐标：底面中心在原点、向上长。 */
export function containerMeshes(Lx, Wy, Hz, form, seg = { corr: true }) {
  const walls = new MB(), frame = new MB(), detail = new MB()
  const c = 0.12   // 角柱截面（示意，ISO 1161 角件量级）
  // 顶 / 底 / 四壁（壁板略内缩于角柱外缘）
  const inset = 0.025, hx = Lx / 2 - inset, hy = Wy / 2 - inset
  box(walls, [0, 0, -Hz / 2], [hx, hy, Hz / 2 - 0.03])
  if (form === 'container' && seg.corr) {
    // 长边瓦楞：梯形波（节距 0.278 m、深 0.036 m，示意）
    const pitch = 0.278, dep = 0.036, nC = Math.max(2, Math.floor((2 * hx - 2 * c) / pitch))
    for (const sy of [1, -1]) {
      for (let k = 0; k < nC; k++) {
        const x0 = -hx + c + k * pitch + 0.25 * pitch, w = 0.5 * pitch
        box(detail, [x0 + w / 2, sy * (hy + dep / 2), -Hz / 2], [w / 2 - 0.02, dep / 2, Hz / 2 - 0.16], [sy > 0 ? '+y' : '-y', '+x', '-x'])
      }
    }
  }
  // 角柱 + 上下边梁 + 端梁 + 角件
  for (const sx of [1, -1]) for (const sy of [1, -1]) box(frame, [sx * (Lx / 2 - c / 2), sy * (Wy / 2 - c / 2), -Hz / 2], [c / 2, c / 2, Hz / 2])
  for (const sy of [1, -1]) for (const z of [-c / 2, -Hz + c / 2]) box(frame, [0, sy * (Wy / 2 - c / 2), z], [Lx / 2 - c, c / 2, c / 2])
  for (const sx of [1, -1]) for (const z of [-c / 2, -Hz + c / 2]) box(frame, [sx * (Lx / 2 - c / 2), 0, z], [c / 2, Wy / 2 - c, c / 2])
  if (form === 'container') {
    // 货门（−X 端）：两扇门板 + 四根锁杆
    for (const sy of [1, -1]) box(detail, [-Lx / 2 + 0.012, sy * (Wy / 4 - 0.02), -Hz / 2], [0.012, Wy / 4 - 0.07, Hz / 2 - 0.17], ['-x'])
    for (const y of [-0.62, -0.28, 0.28, 0.62]) tubeAlong(detail, [-Lx / 2 - 0.03, y * Wy / 2, -0.1], [-Lx / 2 - 0.03, y * Wy / 2, -Hz + 0.1], 0.014, 8)
  } else {
    // 方舱：侧门（+Y 面近 −X 端）+ 端墙两台空调 + 走线箱
    box(detail, [-Lx / 2 + 0.9, Wy / 2 + 0.01, -1.05], [0.45, 0.012, 1.0], ['+y'])
    for (const y of [-Wy / 4, Wy / 4]) box(detail, [Lx / 2 + 0.2, y, -Hz * 0.55], [0.2, 0.42, 0.38])
    box(detail, [-Lx / 2 - 0.08, 0, -Hz + 0.45], [0.08, 0.3, 0.2])
  }
  return { walls, frame, detail }
}

// ───────────────────────────── 新增（A3 规格 §3.2：签名定死） ─────────────────────────────

/** 计划材质键存在（ir.MATERIAL_KEYS 与 paramBus.MATERIALS 都有）就用，否则回退。模块加载时查一次。 */
const MAT_OK = new Set(MATERIAL_KEYS.filter((k) => Object.hasOwn(MATERIALS, k)))
export const matOr = (key, fallback) => (MAT_OK.has(key) ? key : fallback)

/** 横向对齐插座：父件 latSocket（n +Y、up +X）↔ 子件 latMount（n −Y、up +X），roll 90。 */
export const latSocket = (id, pos, size, accepts = null) => sock(id, pos, [0, 1, 0], [1, 0, 0], size, 90, accepts)
export const latMount = (size) => sock('root', [0, 0, 0], [0, -1, 0], [1, 0, 0], size, 90)
/** datum 挂点（局部原点，dir +X、up −Z）：实体上球的锚点（船 = 水线、飞机 = 机身参考点、车 = 地面）。 */
export const datumAp = (ctx, pos = [0, 0, 0]) => apLocal(ctx, 'datum', pos, [1, 0, 0], [0, 0, -1])

/** 小量抹零（三角函数在 90° 整数倍处的 1e-16 尾数；保证镜像对称点逐位相反）。 */
const snap = (v) => (Math.abs(v) < 1e-12 ? 0 : v)

/**
 * 超椭圆截面环（截面平面 = 局部 y-z，y 右、z 下）：|y/a|^e + |z/b|^e = 1，上半 b = bUp（−Z 侧）、下半 b = bDown。
 * n 点，θ_j = 2πj/n 自顶（−Z）起向 +Y 转；返回 [[y, z], …]。a 或 b 为 0 时收成一点（极点）。
 * 左右两半按 j ↔ n − j 逐位镜像（y 取反、z 相同），关于 xz 面对称的件量化比对不会因三角函数尾数错位。
 */
export function superRing(n, a, bUp, bDown, e = 2) {
  const q = 2 / e, pw = (v) => (v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** q)
  const out = []
  for (let j = 0; j < n; j++) {
    const jj = 2 * j <= n ? j : n - j, sg = 2 * j <= n ? 1 : -1
    const th = (2 * Math.PI * jj) / n, s = snap(Math.sin(th)), c = snap(Math.cos(th))
    const y = a * pw(s), z = -(c >= 0 ? bUp : bDown) * pw(c)
    out.push([z0(sg * y), z0(z)])
  }
  return out
}

/** 环的 Newell 法向（未归一）。 */
function newell(ring) {
  const nn = [0, 0, 0]
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    nn[0] += (a[1] - b[1]) * (a[2] + b[2]); nn[1] += (a[2] - b[2]) * (a[0] + b[0]); nn[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return nn
}
const ringMean = (ring) => scl(ring.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / ring.length)
const isPoleRing = (ring) => ring.every((p) => len(sub(p, ring[0])) < 1e-12)

/**
 * 截面放样：sections = [{c:[x,y,z], ring:[[dy,dz]…]} | {pts:[[x,y,z]…]}]（每截面点数相同、同向）；闭合环（wrap）。
 * out 缺省 = 离最近截面中心的径向（同 liftSurface 口径）；capStart / capEnd 用 cap() 封口（极点截面不必封）。
 * 返回 {v0, t0, t1, G}；内部调 grid()（光滑法向、米制 uv）。t1 含封口。
 */
export function loft(mb, sections, { out = null, capStart = false, capEnd = false } = {}) {
  const G = sections.map((s) => (s.pts ? s.pts.map((p) => [p[0], p[1], p[2]]) : s.ring.map(([dy, dz]) => [s.c[0], s.c[1] + dy, s.c[2] + dz])))
  const cen = sections.map((s, i) => (s.c ? [s.c[0], s.c[1], s.c[2]] : ringMean(G[i])))
  const o = out || ((p) => {
    let best = 0, bd = Infinity
    for (let i = 0; i < cen.length; i++) { const d = len(sub(p, cen[i])); if (d < bd) { bd = d; best = i } }
    return sub(p, cen[best])
  })
  const g = grid(mb, G, { wrap: true, out: o })
  const capAt = (i, nb) => {
    if (isPoleRing(G[i])) return
    let nn = newell(G[i])
    if (!(len(nn) > 1e-14)) return
    nn = nrm(nn)
    if (dot(nn, sub(cen[i], cen[nb])) < 0) nn = scl(nn, -1)
    cap(mb, G[i], nn, cen[i])
  }
  if (G.length > 1) {
    if (capStart) capAt(0, 1)
    if (capEnd) capAt(G.length - 1, G.length - 2)
  }
  return { v0: g.v0, t0: g.t0, t1: mb.tcount, G }
}

/** 二维多边形（逆时针）耳切三角化 → 顶点下标三元组（确定性；退化时退回扇形）。 */
function earClip(P) {
  const idx = P.map((_, i) => i), tris = []
  const a2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const inTri = (p, a, b, c) => a2(a, b, p) >= -1e-14 && a2(b, c, p) >= -1e-14 && a2(c, a, p) >= -1e-14
  let guard = 0
  while (idx.length > 3 && guard++ < 100000) {
    let cut = false
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length]
      const A = P[i0], B = P[i1], C = P[i2]
      if (!(a2(A, B, C) > 1e-14)) continue
      let hit = false
      for (const j of idx) { if (j !== i0 && j !== i1 && j !== i2 && inTri(P[j], A, B, C)) { hit = true; break } }
      if (hit) continue
      tris.push([i0, i1, i2]); idx.splice(k, 1); cut = true; break
    }
    if (!cut) { for (let k = 1; k < idx.length - 1; k++) tris.push([idx[0], idx[k], idx[k + 1]]); return tris }
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]])
  return tris
}
/** 去掉首尾相接的重复点（< 1e-12 m）。 */
function dedupe2(pts) {
  const out = []
  for (const p of pts) { const q = out[out.length - 1]; if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-12) out.push([p[0], p[1]]) }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-12) out.pop()
  return out
}

/**
 * 平面轮廓拉伸（outline = [[x,y]…] 任意绕向；z0 → z1，z1 < z0 = 向上）：侧面 + 顶底封口，各自硬边、法向朝外。
 * 顶面轮廓可平移 [dx, dy] 与缩放 scale（关于局部原点缩放，再平移；烟囱倾斜 / 收分）。
 * 侧面在折角 > 35° 处断开（硬边），平缓处光滑（圆角矩形的圆角是光滑的）。封口按耳切三角化（凹多边形也对）。
 * 返回 {v0, t0, t1}。
 */
export function extrude(mb, outline, z0_, z1, { dx = 0, dy = 0, scale = 1, capTop = true, capBottom = true } = {}) {
  const P = dedupe2(outline), n = P.length
  const v0 = mb.vcount, t0 = mb.tcount
  if (n < 3 || z1 === z0_) return { v0, t0, t1: t0 }
  let A = 0
  for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; A += a[0] * b[1] - b[0] * a[1] }
  const ccw = A > 0, Pc = ccw ? P : P.slice().reverse()
  const bot = Pc.map(([x, y]) => [x, y, z0_]), top = Pc.map(([x, y]) => [x * scale + dx, y * scale + dy, z1])
  const h = z1 - z0_, flip = h < 0     // 逆时针 + 向 +Z 拉伸时 (b_k, b_k+1, t_k+1) 朝外
  // 折角
  const sharp = Pc.map((p, i) => {
    const a = Pc[(i + n - 1) % n], b = Pc[(i + 1) % n]
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [b[0] - p[0], b[1] - p[1]]
    const c = (e1[0] * e2[0] + e1[1] * e2[1]) / (Math.hypot(e1[0], e1[1]) * Math.hypot(e2[0], e2[1]) || 1)
    return c < Math.cos(35 * Math.PI / 180)
  })
  const starts = []
  for (let i = 0; i < n; i++) if (sharp[i]) starts.push(i)
  const strips = starts.length ? starts.map((s, k) => { const e = starts[(k + 1) % starts.length]; const L = ((e - s + n) % n) || n; const ids = []; for (let q = 0; q <= L; q++) ids.push((s + q) % n); return ids })
    : [[...Array(n).keys(), 0]]
  for (const ids of strips) {
    const sv = mb.vcount, st = mb.tcount
    let u = 0
    ids.forEach((i, q) => {
      if (q) u += len(sub(bot[i], bot[ids[q - 1]]))
      mb.v(bot[i], [0, 0, 1], u, 0); mb.v(top[i], [0, 0, 1], u, Math.abs(h))
    })
    for (let q = 0; q < ids.length - 1; q++) {
      const b0 = sv + 2 * q, t0q = b0 + 1, b1 = b0 + 2, t1q = b0 + 3
      if (!flip) { mb.t(b0, b1, t1q); mb.t(b0, t1q, t0q) } else { mb.t(b0, t1q, b1); mb.t(b0, t0q, t1q) }
    }
    smoothNormals(mb, sv, st)
  }
  const tris = earClip(Pc)
  const capRing = (ring, nz) => {
    const cv = mb.vcount, ct = mb.tcount
    for (const p of ring) mb.v(p, [0, 0, nz], p[0], p[1])
    for (const [a, b, c] of tris) mb.t(cv + a, cv + b, cv + c)
    orientTo(mb, ct, mb.tcount, [0, 0, nz])
  }
  const sg = h > 0 ? 1 : -1
  if (capTop) capRing(top, sg)
  if (capBottom) capRing(bot, -sg)
  return { v0, t0, t1: mb.tcount }
}

/** 圆角矩形轮廓（半长 hx、半宽 hy、圆角半径 r、每角 k 段）→ [[x,y]…]（逆时针；关于两轴逐位对称）。 */
export function roundRect(hx, hy, r, k = 4) {
  const rr = clampN(r, 0, Math.min(hx, hy)), ax = hx - rr, ay = hy - rr
  const Q = []
  // 四分之一圆弧点：前半算、后半按 45° 线交换坐标（Q[k − i] = (sin, cos)），四个角逐位互为镜像
  for (let i = 0; i <= k; i++) {
    const ii = 2 * i <= k ? i : k - i, a = (Math.PI / 2) * (ii / k), c = snap(Math.cos(a)), s = 2 * ii === k ? c : snap(Math.sin(a))
    Q.push(2 * i <= k ? [c, s] : [s, c])
  }
  const pts = []
  if (!(rr > 0)) return [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]]
  for (const [c, s] of Q) pts.push([ax + rr * c, ay + rr * s])
  for (const [c, s] of Q) pts.push([-ax - rr * s, ay + rr * c])
  for (const [c, s] of Q) pts.push([-ax - rr * c, -ay - rr * s])
  for (const [c, s] of Q) pts.push([ax + rr * s, -ay - rr * c])
  return dedupe2(pts).map((p) => p.map(z0))
}

/** 贴花：中心 c、朝外法向 n、面内 u 方向、半尺寸 hu × hv 的四边形，沿 n 浮起 lift（防 z-fighting）。 */
export function decal(mb, c, n, u, hu, hv, lift = 0.004) {
  const nn = nrm(n), uu = nrm(reject(u, nn)), vv = cross(nn, uu)
  quad(mb, madd(c, nn, lift), scl(uu, hu), scl(vv, hv))
}

/**
 * 轮子：中心 c、轴向 axis（朝外侧）、胎外半径 rTire、胎宽 width、轮辋半径 rRim；返回 {tire: MB, rim: MB}（分材质）。
 * 胎用 lathe 圆角剖面（胎侧鼓出）+ 内圈胎唇；轮辋 = 外侧内凹盘（带轮毂盖，极点收口）+ 内侧封板 + 5 辐（六面体）。
 */
export function wheel(c, axis, rTire, width, rRim, seg = 32) {
  const d = nrm(axis), w = width, rr = Math.min(rRim, 0.97 * rTire)
  const h = rTire - rr, rs = Math.min(0.22 * w, 0.35 * h)
  const tire = new MB(), rim = new MB()
  // 胎：内侧胎唇 → 胎侧（鼓出）→ 胎肩圆角 → 胎面 → 对侧
  const prof = []
  const side = (sg) => {
    const pts = []
    for (let i = 0; i <= 4; i++) { const t = i / 4, r = rr + (h - rs) * t; pts.push([sg * (0.44 * w + 0.06 * w * Math.sin(Math.PI * t)), r]) }
    for (let i = 1; i <= 4; i++) { const a = (Math.PI / 2) * (i / 4); pts.push([sg * (0.5 * w - rs + rs * Math.cos(a)), rTire - rs + rs * Math.sin(a)]) }
    return pts
  }
  prof.push(...side(-1))
  prof.push(...side(1).reverse())
  lathe(tire, prof, seg, c, d)
  lathe(tire, [[0.44 * w, 0.995 * rr], [-0.44 * w, 0.995 * rr]], seg, c, d, { inward: true })
  // 轮辋：外侧内凹盘（轮毂盖收成极点）
  lathe(rim, [[0.36 * w, 0.985 * rr], [0.3 * w, 0.9 * rr], [0.14 * w, 0.4 * rr], [0.16 * w, 0.22 * rr], [0.22 * w, 0.12 * rr], [0.24 * w, 0]], seg, c, d)
  // 内侧封板（看不穿）
  cap(rim, (() => { const [e1, e2] = perpPair(d), ring = []; for (let j = 0; j < seg; j++) { const th = (2 * Math.PI * j) / seg; ring.push(add(madd(c, d, -0.3 * w), add(scl(e1, 0.985 * rr * Math.cos(th)), scl(e2, 0.985 * rr * Math.sin(th))))) } return ring })(), scl(d, -1), madd(c, d, -0.3 * w))
  // 5 辐：沿盘面斜向，浮出盘面
  const [e1, e2] = perpPair(d)
  const pt = (s, r, tq, q, tn) => add(add(madd(c, d, s), scl(q, r)), scl(tn, tq))
  for (let k = 0; k < 5; k++) {
    const ph = (2 * Math.PI * k) / 5, q = add(scl(e1, Math.cos(ph)), scl(e2, Math.sin(ph))), tn = cross(d, q)
    const sA = 0.16 * w, rA = 0.25 * rr, wA = 0.09 * rr, sB = 0.31 * w, rB = 0.88 * rr, wB = 0.055 * rr, lift = 0.05 * w
    prism(rim, [pt(sA, rA, -wA, q, tn), pt(sB, rB, -wB, q, tn), pt(sB, rB, wB, q, tn), pt(sA, rA, wA, q, tn)],
      [pt(sA + lift, rA, -wA, q, tn), pt(sB + lift, rB, -wB, q, tn), pt(sB + lift, rB, wB, q, tn), pt(sA + lift, rA, wA, q, tn)])
  }
  return { tire, rim }
}

/** mulberry32；seed 取整数（参数派生）。返回 () => [0, 1)。 */
export function rng(seed) {
  let a = (Math.trunc(Number(seed)) || 0) >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** FNV-1a 32 位（字符串或数字数组；数组按 String(元素) 以逗号连接）→ uint32（给 rng 造种子）。 */
export function hash32(x) {
  const s = Array.isArray(x) ? x.map((v) => String(v)).join(',') : String(x)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h ^= c & 0xff; h = Math.imul(h, 0x01000193)
    if (c > 0xff) { h ^= c >>> 8; h = Math.imul(h, 0x01000193) }
  }
  return h >>> 0
}

// ───────────────────────────── 集成期合并（air / sea / veh / ground 原各写一份的私有工具） ─────────────────────────────

/** 平滑阶跃 3t² − 2t³（t 先夹到 [0, 1]）。区间写法 smooth01((x − a) / (b − a)) 与 air.mjs 原 smooth01(a, b, x) 同式。 */
export const smooth01 = (t) => { const u = clampN(t, 0, 1); return u * u * (3 - 2 * u) }
/**
 * 顶点 [v0, 末) 复制一份关于 xz 面镜像（y 取反、法向 y 取反、绕序翻转）追加到同一网格：右半造好后补左半，两半逐位对称
 * （镜像值过 z0，中线上的点不出 −0）。
 */
export function mirrorCopyY(mb, v0, t0) {
  const nv = mb.vcount, nt = mb.tcount, off = nv - v0
  for (let i = v0; i < nv; i++) {
    mb.p.push(mb.p[3 * i], z0(-mb.p[3 * i + 1]), mb.p[3 * i + 2]); mb.n.push(mb.n[3 * i], z0(-mb.n[3 * i + 1]), mb.n[3 * i + 2]); mb.uv.push(mb.uv[2 * i], mb.uv[2 * i + 1])
  }
  for (let k = t0; k < nt; k++) mb.idx.push(mb.idx[3 * k] + off, mb.idx[3 * k + 2] + off, mb.idx[3 * k + 1] + off)
}
/** 两点间矩形截面梁（截面 a × b，⟂ 梁轴、perpPair 定向——关于含 X 轴的面镜像时顶点集合对称；prism 闭合朝外）。 */
export function beam(mb, p0, p1, a, b = a) {
  const [e1, e2] = perpPair(nrm(sub(p1, p0))), h = a / 2, k = b / 2
  const sq = (c) => [add(c, add(scl(e1, -h), scl(e2, -k))), add(c, add(scl(e1, h), scl(e2, -k))), add(c, add(scl(e1, h), scl(e2, k))), add(c, add(scl(e1, -h), scl(e2, k)))]
  prism(mb, sq(p0), sq(p1))
}
/** 网格 b 追加进 a（同一节点多件合并；b 的索引按 a 原有顶点数平移）。 */
export function appendMB(a, b) {
  const o = a.vcount
  a.p.push(...b.p); a.n.push(...b.n); a.uv.push(...b.uv)
  for (const i of b.idx) a.idx.push(i + o)
}
/** 组件全部质量元按比例缩放到目标总质量（组件自己的 massKg 参数；装配件级 massKg 由 assembly.mjs 另行缩放）。 */
export function scaleMass(ctx, target) {
  let m = 0
  for (const q of ctx.comps) m += q.massKg
  if (!(m > 0) || !(target > 0)) return
  const k = target / m
  for (const q of ctx.comps) { q.massKg *= k; q.I = q.I.map((v) => v * k) }
}
