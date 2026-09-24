// 网格原语 + 质量元 + 生成上下文（三期契约 DESIGN3 §1 P0：从 paramBus.mjs 零漂移抽出，整星生成器与装配组件共用）。
//
// 纯 ESM、零 three 依赖、node / Worker / 主进程都能跑；只依赖 bodyFrame.mjs（挂点上向的 D1 缺省规则）。
//
// ★ 零漂移：下面「向量 / 网格 / 质量特性 / 登记 / 输出」各段是 paramBus 原文逐字搬来的（只加 export、给共享常量加冻结），
//   浮点运算的式子与先后顺序一个都没动——整星 IR 的每个字节都靠它们。改这里任何一处运算都会让
//   packages/core/test/fixtures/models/parambus.golden.json 失配；有意改几何时按 modelMeshKit.test.mjs 文件头重录金标准。
//   这些函数每次调用都新建数组，是「生成期」工具，不进逐帧热路径（装配器拖动时只改组件节点矩阵，不重跑它们）。
//
// ★ 坐标：几何一律在【本体系】（或组件局部系）里建，double 存；局部系 R = [列 x, 列 y, 列 z]（各为父系下的单位向量），
//   world = t + R·local。网格 uv 以米计（电池片栅格按米制重复）。IR 需要的 Float32 / Uint32 由调用方出口时再转。
//
// ★ 生成上下文 ctx（createCtx 造，整星与单个组件同形——组件 build(params, kit) 的产物与 paramBus ctx 一致）：
//   { items:[{name, role, part, mat, mb, R, t}], names:Set, comps:[{name, kind, massKg, com, I}],
//     parts:Map(id → {id, name, role, nodes, areaM2, normalBody?, fitted?}), aps:[{name, posBody, dirBody, upBody}],
//     arts:[{name, nodes, stages}], spg:[{name, nodes, efficiency}], warnings:[], dens:{密度表取值}, …调用方附加字段 }
//   节点名与挂点名共用 names：uniq 遇空名 / 重名直接抛（生成器内部错误）。多个组件要各开一个 ctx、合并时再加组件 id 前缀。
//   质量元（comps）的 com / I 都在 ctx 的坐标系（本体系、spec 原点）里，I 为对自身质心、行主序 9 元。
//
// ★ 反射面母抛物面（与 segment.mjs / paramBus 一致）：顶点 V、单位轴 a（顶点 → 焦点）、焦距 f，焦点 F = V + f·a；
//   口径面坐标 (x1, x2) 沿单位偏置方向 u（⟂ a）与 e2 = a×u；偏置口径面中心在 (dc, 0)（GRASP 口径 offset）。
//
// 导出：
//   向量 / 3×3：isNum isVec3 add sub scl dot cross len nrm reject madd clampN z0 EX EY EZ IDR rApply rotAboutLocalY
//               m3zero m3add outer pAxis rotInertia
//   网格：MB（累加器）quad BOX_FACES box perpPair frustum tube annulus horn
//   质量特性：worldPositions shellProps meshArea
//   上下文与登记：createCtx uniq addItem comp boxComp plateComp rodComp shellComp pointComp addAp
//   抛物面：paraLayout(F, a, u, f, D, dc, k) → {F, a, u, e2, V, f, D, dc, Pc, nc, P(x1,x2), N(x1,x2), k}（前提不满足抛错）
//   输出：colMajor(R, t) → 列主序 4×4（抹 −0）

import { defaultUpBody } from './bodyFrame.mjs'

// ───────────────────────────── 向量 / 矩阵小工具（double，数组） ─────────────────────────────

export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
export const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const len = (a) => Math.hypot(a[0], a[1], a[2])
export const nrm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0] }
export const reject = (a, n) => sub(a, scl(n, dot(a, n)))          // a 去掉沿单位向量 n 的分量
export const madd = (p, a, k) => [p[0] + a[0] * k, p[1] + a[1] * k, p[2] + a[2] * k]
export const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
export const z0 = (v) => (v === 0 ? 0 : v)                          // 抹掉 −0（输出 JSON 干净）
export const EX = Object.freeze([1, 0, 0]), EY = Object.freeze([0, 1, 0]), EZ = Object.freeze([0, 0, 1])
// 局部系 R = [列 x, 列 y, 列 z]（各为本体系下的单位向量）；world = t + R·local
export const IDR = Object.freeze([EX, EY, EZ])
export const rApply = (R, v) => [R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2], R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2], R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2]]
// 绕局部 y 转 deg：x' = c·x − s·z，z' = s·x + c·z（即 R·Ry(θ)）
export const rotAboutLocalY = (R, deg) => {
  const t = deg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t)
  return [add(scl(R[0], c), scl(R[2], -s)), R[1], add(scl(R[0], s), scl(R[2], c))]
}
// 3×3（行主序扁平 9 元）
export const m3zero = () => [0, 0, 0, 0, 0, 0, 0, 0, 0]
export const m3add = (A, B) => A.map((v, i) => v + B[i])
export const outer = (a, b) => [a[0] * b[0], a[0] * b[1], a[0] * b[2], a[1] * b[0], a[1] * b[1], a[1] * b[2], a[2] * b[0], a[2] * b[1], a[2] * b[2]]
/** 平行轴：质点 m 在 d 处对原点的惯量 m(|d|²I − d dᵀ)。 */
export const pAxis = (m, d) => { const d2 = dot(d, d); const o = outer(d, d); return [m * (d2 - o[0]), -m * o[1], -m * o[2], -m * o[3], m * (d2 - o[4]), -m * o[5], -m * o[6], -m * o[7], m * (d2 - o[8])] }
/** 局部对角惯量 diag(a,b,c) 转到本体系：R·diag·Rᵀ（R 列为局部轴）。 */
export function rotInertia(R, a, b, c) {
  const I = m3zero(), dg = [a, b, c]
  for (let k = 0; k < 3; k++) { const o = outer(R[k], R[k]); for (let i = 0; i < 9; i++) I[i] += dg[k] * o[i] }
  return I
}

// ───────────────────────────── 网格构建 ─────────────────────────────

/** 网格累加器：顶点 double 存（质量积分用），出 IR 时才转 Float32。uv 以米计（电池片栅格按米制重复）。 */
export class MB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.idx = [] }
  get vcount() { return this.p.length / 3 }
  get tcount() { return this.idx.length / 3 }
  v(p, n, u = 0, w = 0) {
    const l = len(n) || 1
    this.p.push(p[0], p[1], p[2]); this.n.push(n[0] / l, n[1] / l, n[2] / l); this.uv.push(u, w)
    return this.vcount - 1
  }
  t(a, b, c) { this.idx.push(a, b, c) }
}

/** 矩形 c±u±v，法向 u×v（逆时针朝外），uv 米制。 */
export function quad(mb, c, u, v) {
  const n = cross(u, v), lu = 2 * len(u), lv = 2 * len(v)
  const a = mb.v(sub(sub(c, u), v), n, 0, 0)
  const b = mb.v(sub(add(c, u), v), n, lu, 0)
  const d = mb.v(add(add(c, u), v), n, lu, lv)
  const e = mb.v(add(sub(c, u), v), n, 0, lv)
  mb.t(a, b, d); mb.t(a, d, e)
}
export const BOX_FACES = Object.freeze({
  '+x': (h) => [[h[0], 0, 0], [0, h[1], 0], [0, 0, h[2]]],
  '-x': (h) => [[-h[0], 0, 0], [0, 0, h[2]], [0, h[1], 0]],
  '+y': (h) => [[0, h[1], 0], [0, 0, h[2]], [h[0], 0, 0]],
  '-y': (h) => [[0, -h[1], 0], [h[0], 0, 0], [0, 0, h[2]]],
  '+z': (h) => [[0, 0, h[2]], [h[0], 0, 0], [0, h[1], 0]],
  '-z': (h) => [[0, 0, -h[2]], [0, h[1], 0], [h[0], 0, 0]]
})
/** 轴对齐盒（局部系），h = 半边长；faces 缺省六面。 */
export function box(mb, c, h, faces = ['+x', '-x', '+y', '-y', '+z', '-z']) {
  for (const f of faces) { const [o, u, v] = BOX_FACES[f](h); quad(mb, add(c, o), u, v) }
}
/** 与 d 正交的一对单位向量（确定性：先试 X 再试 Y）。 */
export function perpPair(d) {
  const a = Math.abs(d[0]) < 0.9 ? EX : EY
  const e1 = nrm(reject(a, d)), e2 = cross(d, e1)
  return [e1, e2]
}
/**
 * 截锥 p0(r0) → p1(r1)，seg 段；cap0 / cap1 封口；inward=true 法向朝内（喇叭内壁）。
 * 侧面外法向 = q·h + d·(r0−r1) 归一（q 为径向单位向量），圆柱时退化为 q。
 */
export function frustum(mb, p0, r0, p1, r1, seg, cap0 = false, cap1 = false, inward = false) {
  const ax = sub(p1, p0), h = len(ax), d = nrm(ax)
  const [e1, e2] = perpPair(d)
  const base = mb.vcount
  const circ = 2 * Math.PI * Math.max(r0, r1)
  for (let j = 0; j <= seg; j++) {
    const th = (2 * Math.PI * j) / seg, q = add(scl(e1, Math.cos(th)), scl(e2, Math.sin(th)))
    let n = nrm(add(scl(q, h), scl(d, r0 - r1)))
    if (inward) n = scl(n, -1)
    mb.v(madd(p0, q, r0), n, (circ * j) / seg, 0)
    mb.v(madd(p1, q, r1), n, (circ * j) / seg, h)
  }
  for (let j = 0; j < seg; j++) {
    const b0 = base + 2 * j, t0 = b0 + 1, b1 = b0 + 2, t1 = b0 + 3
    if (!inward) { mb.t(b0, b1, t0); mb.t(b1, t1, t0) } else { mb.t(b0, t0, b1); mb.t(b1, t0, t1) }
  }
  const cap = (pc, r, nrmv, flip) => {
    if (r <= 0) return
    const c = mb.v(pc, nrmv, 0, 0), ring = mb.vcount
    for (let j = 0; j < seg; j++) {
      const th = (2 * Math.PI * j) / seg, q = add(scl(e1, Math.cos(th)), scl(e2, Math.sin(th)))
      mb.v(madd(pc, q, r), nrmv, q[0] * r, q[1] * r)
    }
    for (let j = 0; j < seg; j++) { const a = ring + j, b = ring + ((j + 1) % seg); if (flip) mb.t(c, b, a); else mb.t(c, a, b) }
  }
  if (cap0) cap(p0, r0, scl(d, -1), true)
  if (cap1) cap(p1, r1, d, false)
}
export const tube = (mb, p0, p1, r, seg = 10) => frustum(mb, p0, r, p1, r, seg, true, true)
/** 平环（法向 nrmv 一侧可见），中心 c、内外半径、与 d 正交的平面。 */
export function annulus(mb, c, d, rIn, rOut, seg, nrmv) {
  const [e1, e2] = perpPair(d)
  const base = mb.vcount
  for (let j = 0; j < seg; j++) {
    const th = (2 * Math.PI * j) / seg, q = add(scl(e1, Math.cos(th)), scl(e2, Math.sin(th)))
    mb.v(madd(c, q, rOut), nrmv, q[0] * rOut, q[1] * rOut); mb.v(madd(c, q, rIn), nrmv, q[0] * rIn, q[1] * rIn)
  }
  const facing = dot(nrmv, d) > 0
  for (let j = 0; j < seg; j++) {
    const o0 = base + 2 * j, i0 = o0 + 1, o1 = base + 2 * ((j + 1) % seg), i1 = o1 + 1
    if (facing) { mb.t(o0, o1, i0); mb.t(o1, i1, i0) } else { mb.t(o0, i0, o1); mb.t(o1, i0, i1) }
  }
}
/** 喇叭：外壁 + 内壁 + 口沿 + 喉部封口（闭合壳，单面材质即可两面都有东西看）。throat → aperture 沿 dir。 */
export function horn(mb, aperture, dir, ra, lenM, seg = 24) {
  const d = nrm(dir), throat = madd(aperture, d, -lenM), rt = ra * 0.3, wall = Math.max(0.002, ra * 0.04)
  frustum(mb, throat, rt + wall, aperture, ra + wall, seg, true, false, false)
  frustum(mb, throat, rt, aperture, ra, seg, false, false, true)
  annulus(mb, aperture, d, ra, ra + wall, seg, d)
}

// ───────────────────────────── 质量特性积分 ─────────────────────────────

/** 网格世界坐标（本体系，spec 原点）：world = t + R·local。 */
export function worldPositions(mb, R, t) {
  const out = new Float64Array(mb.p.length)
  for (let i = 0; i < mb.p.length; i += 3) {
    const w = rApply(R, [mb.p[i], mb.p[i + 1], mb.p[i + 2]])
    out[i] = w[0] + t[0]; out[i + 1] = w[1] + t[1]; out[i + 2] = w[2] + t[2]
  }
  return out
}
/**
 * 薄壳质量特性（面密度 areal）：精确三角形二阶矩 ∫ r rᵀ dA = A/12·(aaᵀ+bbᵀ+ccᵀ+ssᵀ)，s=a+b+c。
 * @returns {{area, massKg, com, I}}（I 为对自身质心、本体轴，行主序 9 元）
 */
export function shellProps(P, idx, areal, triFrom = 0, triTo = idx.length / 3) {
  let A = 0; const S = [0, 0, 0]; let M2 = m3zero()
  for (let t = triFrom; t < triTo; t++) {
    const ia = idx[3 * t] * 3, ib = idx[3 * t + 1] * 3, ic = idx[3 * t + 2] * 3
    const a = [P[ia], P[ia + 1], P[ia + 2]], b = [P[ib], P[ib + 1], P[ib + 2]], c = [P[ic], P[ic + 1], P[ic + 2]]
    const ar = len(cross(sub(b, a), sub(c, a))) / 2
    if (!(ar > 0)) continue
    A += ar
    const s = add(add(a, b), c)
    S[0] += ar * s[0] / 3; S[1] += ar * s[1] / 3; S[2] += ar * s[2] / 3
    M2 = m3add(M2, [outer(a, a), outer(b, b), outer(c, c), outer(s, s)].reduce(m3add).map((v) => v * ar / 12))
  }
  if (!(A > 0)) return { area: 0, massKg: 0, com: [0, 0, 0], I: m3zero() }
  const m = areal * A, com = scl(S, 1 / A)
  const tr = M2[0] + M2[4] + M2[8]
  const Io = [tr - M2[0], -M2[1], -M2[2], -M2[3], tr - M2[4], -M2[5], -M2[6], -M2[7], tr - M2[8]].map((v) => v * areal)
  const Pc = pAxis(m, com)
  return { area: A, massKg: m, com, I: Io.map((v, i) => v - Pc[i]) }
}
export function meshArea(P, idx) {
  let A = 0
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3, ib = idx[t + 1] * 3, ic = idx[t + 2] * 3
    A += len(cross([P[ib] - P[ia], P[ib + 1] - P[ia + 1], P[ib + 2] - P[ia + 2]], [P[ic] - P[ia], P[ic + 1] - P[ia + 1], P[ic + 2] - P[ia + 2]])) / 2
  }
  return A
}

// ───────────────────────────── 生成上下文与登记（节点 / 部件 / 质量元 / 挂点） ─────────────────────────────

/**
 * 新建生成上下文（形状见文件头）。extra 里的字段（spec / D 细节档 / dens 密度表取值 / hRefl …）原样挂上，
 * 登记用的容器一律新建（extra 里同名的会被覆盖）。
 */
export function createCtx(extra = {}) {
  return { ...extra, items: [], names: new Set(), comps: [], parts: new Map(), aps: [], arts: [], spg: [], warnings: [] }
}
export function uniq(ctx, name) {
  if (!name || ctx.names.has(name)) throw new Error(`paramBus：节点名「${name}」为空或重复（生成器内部错误）`)
  ctx.names.add(name)
  return name
}
/** 登记一个几何节点（空网格也登记为占位节点——便于关节 / 挂点引用；但通常 mb 非空）。 */
export function addItem(ctx, { name, role, part, mat, mb, R = IDR, t = [0, 0, 0] }) {
  uniq(ctx, name)
  const it = { name, role, part, mat, mb, R, t }
  ctx.items.push(it)
  if (part) {
    let p = ctx.parts.get(part.id)
    if (!p) { p = { id: part.id, name: part.name || part.id, role: part.role || role, nodes: [], areaM2: 0 }; ctx.parts.set(part.id, p) }
    p.nodes.push(name)
  }
  return it
}
export const comp = (ctx, name, kind, massKg, com, I) => { if (massKg > 0) ctx.comps.push({ name, kind, massKg, com, I }) }
export const boxComp = (ctx, name, m, c, h) => comp(ctx, name, 'box', m, c, [m * ((2 * h[1]) ** 2 + (2 * h[2]) ** 2) / 12, 0, 0, 0, m * ((2 * h[0]) ** 2 + (2 * h[2]) ** 2) / 12, 0, 0, 0, m * ((2 * h[0]) ** 2 + (2 * h[1]) ** 2) / 12])
/** 薄板：局部 x 向宽 w、y 向长 h，法向局部 z。 */
export const plateComp = (ctx, name, m, c, R, w, h) => comp(ctx, name, 'plate', m, c, rotInertia(R, m * h * h / 12, m * w * w / 12, m * (w * w + h * h) / 12))
export function rodComp(ctx, name, p0, p1) {
  const L = len(sub(p1, p0)); if (!(L > 0)) return
  const m = ctx.dens.boomLinear * L, d = nrm(sub(p1, p0)), o = outer(d, d), k = m * L * L / 12
  comp(ctx, name, 'rod', m, scl(add(p0, p1), 0.5), [k * (1 - o[0]), -k * o[1], -k * o[2], -k * o[3], k * (1 - o[4]), -k * o[5], -k * o[6], -k * o[7], k * (1 - o[8])])
}
export function shellComp(ctx, name, it, areal, triFrom, triTo) {
  const P = worldPositions(it.mb, it.R, it.t)
  const sp = shellProps(P, it.mb.idx, areal, triFrom, triTo)
  comp(ctx, name, 'shell', sp.massKg, sp.com, sp.I)
  return sp
}
export const pointComp = (ctx, name, m, c) => comp(ctx, name, 'point', m, c, m3zero())
/**
 * 记一个挂点（本体系、spec 原点）。上向：显式给了且不与视轴平行就取它去掉视轴分量后的单位向量；否则按二期 D1 缺省
 * （defaultUpBody：本体 −Y 的投影，GEO 对地挂点即正北；视轴 ∥ ±Y 时取 +X）——与 schema / exporter / agi 同一条规则，
 * 生成的挂点与「手填挂点经 normalizeMeta 兜底」逐位相同，「姿态 + 挂点」指向在赤道 GEO 与手动天底档零跳变。
 */
export function addAp(ctx, name, posBody, dirBody, upBody) {
  const d = nrm(dirBody)
  const u = upBody ? reject(upBody, d) : null
  const up = u && len(u) > 1e-6 ? nrm(u) : defaultUpBody(d)
  ctx.aps.push({ name: uniq(ctx, name), posBody: posBody.slice(), dirBody: d, upBody: up })
}

// ───────────────────────────── 偏置抛物面 ─────────────────────────────

const PARA_TOL = 1e-9   // paraLayout 前提检查的容差（单位长度 / 正交）

/**
 * 偏置抛物面几何（全部 double）。从 paramBus.reflectorLayout 尾部原样拆出：槽位 / 净空 / 塔高那些整星语义留在 paramBus，
 * 这里只管「给定焦点与轴，求顶点、口径面点与法向」，装配器的反射面组件直接用。
 * 前提：a 为单位向量，u 为单位向量且 ⟂ a，f > 0，D > 0，dc / k 有限（k > 0）。这里【只查不改】——不满足就抛错
 * （非单位轴生成的已不是以 F 为焦点的抛物面，出口的非有限数兜底也查不出）；不在这里归一，是因为再归一一次
 * 会让整星几何差 1 ulp、金标准失配。容差 1e-9 远宽于 nrm / reject 的舍入（~1e-15），整星路径不会误伤。
 * @param {number[]} F  焦点（= 馈源相位中心）
 * @param {number[]} a  母抛物面单位轴（顶点 → 焦点，= 波束视轴）
 * @param {number[]} u  单位偏置方向（自母轴指向口径中心，⟂ a）
 * @param {number} f    焦距（m）
 * @param {number} D    偏置口径面直径（m，只随结果带走）
 * @param {number} dc   口径面中心到母轴的距离（m，GRASP offset）
 * @param {number} [k]  附件尺寸缩放（细节档 reflDetailScale；只随结果带走，缺省 1）
 * @returns {{F, a, u, e2, V, f, D, dc, Pc, nc, P:(x1:number,x2:number)=>number[], N:(x1:number,x2:number)=>number[], k}}
 *   P(x1, x2) = 口径面坐标处的抛物面点，N(x1, x2) = 该点单位法向（朝凹侧 / 焦点一侧）；Pc = P(dc, 0)、nc = N(dc, 0)。
 */
export function paraLayout(F, a, u, f, D, dc, k = 1) {
  const bad = !isVec3(F) ? '焦点 F 须为有限三维向量'
    : !isVec3(a) || !(Math.abs(dot(a, a) - 1) <= PARA_TOL) ? '母轴 a 须为单位向量'
      : !isVec3(u) || !(Math.abs(dot(u, u) - 1) <= PARA_TOL) ? '偏置方向 u 须为单位向量'
        : !(Math.abs(dot(a, u)) <= PARA_TOL) ? '偏置方向 u 须与母轴 a 正交'
          : !(isNum(f) && f > 0) ? '焦距 f 须为正有限数'
            : !(isNum(D) && D > 0) ? '口径 D 须为正有限数'
              : !isNum(dc) ? '偏置 dc 须为有限数'
                : !(isNum(k) && k > 0) ? '附件缩放 k 须为正有限数' : null
  if (bad) throw new Error(`meshKit.paraLayout：${bad}（生成器内部错误）`)
  const e2 = cross(a, u)
  const V = madd(F, a, -f)
  const P = (lat1, lat2) => { const pl = add(scl(u, lat1), scl(e2, lat2)); return add(add(V, pl), scl(a, dot(pl, pl) / (4 * f))) }
  const N = (lat1, lat2) => nrm(sub(a, scl(add(scl(u, lat1), scl(e2, lat2)), 1 / (2 * f))))
  const Pc = P(dc, 0), nc = N(dc, 0)
  return { F, a, u, e2, V, f, D, dc, Pc, nc, P, N, k }
}

// ───────────────────────────── 输出 ─────────────────────────────

/** 局部系 R（列向量）+ 平移 t → 列主序 4×4 节点矩阵（抹 −0，输出 JSON 干净）。 */
export function colMajor(R, t) {
  return [R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, t[0], t[1], t[2], 1].map(z0)
}
