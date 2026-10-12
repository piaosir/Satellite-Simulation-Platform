// 飞机领域装配组件·旋翼机与垂直起降（直升机 / 多旋翼 / 复合翼）：air.rotor、air.heli、air.mrbody、air.boom。
//
// 纯 ESM、零 three 依赖、node 可测、确定性（同参数同 IR 字节）。只 import meshKit / shapeKit，不 import air.mjs（air.mjs 反过来
// 把本文件的件排进 AIR_COMPONENTS，登记顺序即组件库卡片顺序）。局部坐标与 air.mjs 同口径：飞机本体 FRD（+X 机头、+Y 右、+Z 向下）。
//   air.rotor   旋翼：直升机主旋翼 / 尾桨（全铰接 / 无铰桨毂、等弦长桨叶 + 桨尖型式、线性扭转、锥度角）与多旋翼 / 升力螺旋桨
//               （电机罩式小桨毂、中段宽两端收窄的桨叶、按几何桨距扭转）。立装（mount n = +Z），桨轴沿局部 −Z；关节 spin（绕局部 Z）；
//               挂点 hub（桨盘中心，dir = 桨轴朝外）。旋向有手性：先按 ccw 造好，cw 整体关于 xz 面镜像（mirrorY），镜像钩子翻转旋向，
//               派生件 = 原件关于 xz 面的逐位镜像（与机翼 side、短舱 fanHand 同一套）。
//   air.heli    直升机机身：超椭圆截面放样（机头 / 座舱 / 后机身过渡 / 尾梁）、发动机与主减速器整流罩、贴皮风挡 / 舷窗 / 滑门框、
//               进气格栅与排气管、一体垂尾（按尾桨轴高反解高度）+ 腹鳍、平尾（两侧 / 单侧、端板）、起落架（浮筒式收放 / 滑橇 / 无）。
//               根件，发 datum 挂点（座舱截面中心的机身长中点）。主旋翼轴 = 尾桨轴前方「尾桨力臂」处，整流罩以主旋翼轴为基准。
//   air.mrbody  多旋翼机体：中心机体 + 4 / 6 / 8 根旋臂（X / + 布局）+ 臂端电机（电机顶 = 旋翼接口 m1…）+ 起落架 + GNSS 天线 / 顶置电池。根件。
//   air.boom    旋翼撑杆：复合翼机翼下方的纵向撑杆，前后电机（旋翼接口 fwd / aft），后电机前移时尾端可接垂尾（双尾撑）。吊装（mount n = −Z）。
// ★ 对称面声明都是真的：凡声明 symmetricPlanes ['xz'] 的件，右半造好后整体镜像复制（mirrorCopyY），中线上的件取关于 xz 面
//   逐位对称的截面（superRing / 平面内扫掠），量化比对不会因三角函数尾数错位。直升机单侧平尾时不声明。
// ★ 缺省参数一律示意值（source:'illustrative'，取整数量级，口径进悬停 title）；有出处的尺寸由实体模板按「出处尺寸 × 示意比例」给。
//
// 导出：
//   ROTORCRAFT            {rotor, heli, mrbody, boom} 四个组件定义（air.mjs 排进 AIR_COMPONENTS）
//   rotorHubT(p)          → 旋翼桨毂半厚（米；p 可为未补缺省的原始参数）：桨毂顶 = 安装面上方 旋翼轴高 + 3 × 半厚（compact 为 2.62 ×）
//   getHeliSockets(p)     → air.heli 的插座（p 可为未补缺省的原始参数）——模板按旋翼头高度反解旋翼轴高时用

import { add, sub, scl, cross, len, nrm, madd, clampN, z0, MB } from '../meshKit.mjs'
import {
  num, int, bool, enm, auto, D2R, sock, standSocket, hangSocket, planeFace, grid, cap, lathe, torus, prism, superRing, loft,
  airfoilRing, liftSurface, smoothNormals, orientTo, mirrorY, mirrorCopyY, tubeAlong, solidCompItems, shellMass, apLocal, put,
  stage, datumAp, matOr, smooth01, roundRect, extrude
} from './shapeKit.mjs'

const ACC = (...t) => Object.freeze([...t, 'prim.'])
const GREY = matOr('paint_grey', 'white_paint')
const spow = (v, q) => (v === 0 ? 0 : Math.sign(v) * Math.abs(v) ** q)
/** NACA 四位对称翼型半厚（与 shapeKit 同式）。 */
const nacaHalf = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x)

/** 补缺省（与 components/index.fillParams 同口径；这里不 import 注册表，防环）。 */
function fillLocal(def, raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const o = {}
  for (const [k, s] of Object.entries(def.params)) { const v = r[k]; o[k] = v === undefined || (v === null && !s.nullable) ? s.def : v }
  return o
}

// ───────────────────────────── 共用小工具 ─────────────────────────────

/**
 * 翼型截面放样（截面系逐站给定，桨叶这类弦向不沿 −X 的升力面用）：st = {le 前缘点, ch 弦向单位向量（前缘 → 后缘）,
 * up 上表面单位法向, c 弦长, tc 相对厚度, cam 弧高}。两端封口；按最近截面形心定向朝外（与 shapeKit.liftSurface 同一套）。
 */
function foilLoft(mb, stations, n = 12) {
  const v0 = mb.vcount, t0 = mb.tcount
  const G = stations.map((st) => airfoilRing(n, st.tc, st.cam || 0).map(([xc, zc]) => add(add(st.le, scl(st.ch, xc * st.c)), scl(st.up, zc * st.c))))
  const nj = G[0].length
  for (let i = 0; i < G.length; i++) for (let j = 0; j < nj; j++) mb.v(G[i][j], [0, 0, 1], j, i)
  for (let i = 0; i < G.length - 1; i++) {
    for (let j = 0; j < nj; j++) {
      const j1 = (j + 1) % nj, a = v0 + i * nj + j, b = v0 + (i + 1) * nj + j, c = v0 + (i + 1) * nj + j1, d = v0 + i * nj + j1
      mb.t(a, b, c); mb.t(a, c, d)
    }
  }
  const tl = mb.tcount
  const cen = G.map((ring) => scl(ring.reduce((s, q) => add(s, q), [0, 0, 0]), 1 / ring.length))
  orientTo(mb, t0, tl, (q) => {
    let best = 0, bd = Infinity
    for (let i = 0; i < cen.length; i++) { const d = len(sub(q, cen[i])); if (d < bd) { bd = d; best = i } }
    return sub(q, cen[best])
  })
  smoothNormals(mb, v0, t0)
  const k = G.length - 1
  cap(mb, G[0], nrm(sub(cen[0], cen[1])), cen[0])
  cap(mb, G[k], nrm(sub(cen[k], cen[k - 1])), cen[k])
}

/**
 * 平面折线扫圆管（两端封口）：pts 在法向为 pn 的平面内（滑橇管 pn = Y、拱形横管 pn = X）；截面零位取 pn，环点 = P + r(pn·cos + (t × pn)·sin)。
 * 关于 xz 面对称的点列（y 逐位取反）扫出的点集逐位对称。
 */
function sweepTube(mb, pts, r, pn, seg = 12) {
  const secs = pts.map((p, i) => {
    const t = nrm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])), e2 = cross(t, pn), ring = []
    for (let j = 0; j < seg; j++) { const a = (2 * Math.PI * j) / seg; ring.push(add(p, add(scl(pn, r * Math.cos(a)), scl(e2, r * Math.sin(a)))).map(z0)) }
    return { pts: ring }
  })
  const near = (c) => { let best = 0, bd = Infinity; for (let i = 0; i < pts.length; i++) { const d = len(sub(c, pts[i])); if (d < bd) { bd = d; best = i } } return sub(c, pts[best]) }
  loft(mb, secs, { out: near, capStart: true, capEnd: true })
}

/** 超椭圆截面体（sec(x) → {a, bUp, bDown, zc, e}）上的点：θ 自顶（−Z）起向 +Y 转（与 superRing 同式）。 */
function secP(sec, x, th) {
  const s = sec(x), q = 2 / s.e, c = Math.cos(th)
  return [x, s.a * spow(Math.sin(th), q), s.zc - (c >= 0 ? s.bUp : s.bDown) * spow(c, q)]
}
/** 截面体上的点 + 外法向 + 周向弧长导数（差分；h = 步长基准，米）。 */
function secFrame(sec, x, th, h) {
  const hx = 1e-4 * h, ht = 1e-4
  const P = secP(sec, x, th), Px = sub(secP(sec, x + hx, th), secP(sec, x - hx, th)), Pt = sub(secP(sec, x, th + ht), secP(sec, x, th - ht))
  return { P, n: nrm(cross(Pt, Px)), ds: len(Pt) / (2 * ht) }
}
/** 截面体上的四角片：corners = [[x, θ°] × 4]（一致顺序），(x, θ) 双线性插值成 nu × nv 格，沿法向浮起 lift。 */
function secQuad(mb, sec, corners, lift, h, nu = 6, nv = 6) {
  const c = corners.map(([x, t]) => [x, t * D2R])
  const at = (u, v) => [0, 1].map((k) => (1 - u) * (1 - v) * c[0][k] + u * (1 - v) * c[1][k] + u * v * c[2][k] + (1 - u) * v * c[3][k])
  const G = []
  for (let i = 0; i <= nu; i++) {
    const row = []
    for (let j = 0; j <= nv; j++) { const [x, t] = at(i / nu, j / nv), q = secFrame(sec, x, t, h); row.push(madd(q.P, q.n, lift)) }
    G.push(row)
  }
  const [xm, tm] = at(0.5, 0.5)
  grid(mb, G, { out: secFrame(sec, xm, tm, h).n })
}
/**
 * 截面体上的贴花：中心 (x, θ)、轮廓 [[du 沿 +X 米, dv 沿周向弧长米]]，浮起 lift。按 nr 圈同心缩放的轮廓分层三角化、每个顶点都落回曲面
 * （大窗口跨过侧壁的弯曲，只做一圈扇形的话平三角形会沉进蒙皮）。
 */
function secDecal(mb, sec, x, th, outline, lift, h, nr = 3) {
  const f0 = secFrame(sec, x, th, h)
  if (!(f0.ds > 1e-6)) return
  const v0 = mb.vcount, t0 = mb.tcount, n = outline.length
  mb.v(madd(f0.P, f0.n, lift), f0.n, 0, 0)
  for (let k = 1; k <= nr; k++) {
    const f = k / nr
    for (const [du, dv] of outline) { const q = secFrame(sec, x + f * du, th + (f * dv) / f0.ds, h); mb.v(madd(q.P, q.n, lift), q.n, f * du, f * dv) }
  }
  for (let j = 0; j < n; j++) mb.t(v0, v0 + 1 + j, v0 + 1 + ((j + 1) % n))
  for (let k = 1; k < nr; k++) {
    const a = v0 + 1 + (k - 1) * n, b = v0 + 1 + k * n
    for (let j = 0; j < n; j++) { const j1 = (j + 1) % n; mb.t(a + j, b + j, b + j1); mb.t(a + j, b + j1, a + j1) }
  }
  orientTo(mb, t0, mb.tcount, f0.n)
}
/** 截面上表面在横向 |y| 处的 z（超出半宽 → 截面中心）。 */
function upperZ(s, y) {
  const r = Math.abs(y) / s.a
  return r >= 1 ? s.zc : s.zc - s.bUp * (1 - r ** s.e) ** (1 / s.e)
}
/** 放样两端的极点环法向：首环 nFirst、末环 nLast（极点只被一个三角形引用，差分法向会歪）。 */
function poleNormals(mb, lf, seg, nFirst, nLast) {
  const set = (row, n) => { for (let j = 0; j < seg; j++) { const q = 3 * (lf.v0 + row * seg + j); mb.n[q] = n[0]; mb.n[q + 1] = n[1]; mb.n[q + 2] = n[2] } }
  if (nFirst) set(0, nFirst)
  if (nLast) set(lf.G.length - 1, nLast)
}

// ───────────────────────────── air.rotor 旋翼 ─────────────────────────────

/** 直升机桨叶桨尖段站位：[r / R, 弦长系数, 相对厚度, 前缘后移（× 参考弦长）]。 */
const HELI_TIPS = Object.freeze({
  square: Object.freeze([[0.9, 1, 0.11, 0], [1, 1, 0.1, 0]]),
  swept: Object.freeze([[0.92, 1, 0.11, 0], [0.97, 0.85, 0.1, 0.12], [1, 0.55, 0.09, 0.32]]),
  tapered: Object.freeze([[0.82, 1, 0.11, 0], [0.92, 0.75, 0.1, 0.05], [1, 0.45, 0.09, 0.1]])
})
/** 螺旋桨型桨叶站位：[r / R, 弦长系数（× 最大弦长）, 相对厚度]。 */
const PROP_ST = Object.freeze([[0.2, 0.92, 0.15], [0.35, 1, 0.12], [0.5, 0.94, 0.1], [0.68, 0.78, 0.085], [0.84, 0.58, 0.075], [0.95, 0.38, 0.065], [1, 0.18, 0.06]])

function rotorGeom(p) {
  const D = p.diameterM, R = D / 2, prop = p.planform === 'propeller', compact = p.hub === 'compact'
  const hubR = auto(p.hubDM, (compact ? 0.08 : 0.1) * D) / 2
  const mastH = auto(p.mastHM, compact ? 0 : 0.05 * D)
  const hubT = (compact ? 0.42 : 0.22) * hubR                       // 桨毂半厚
  const zh = -(mastH + hubT)                                         // 桨盘平面（桨毂中心）
  const c0 = p.chordFrac * R, beta = p.coningDeg * D2R, e = 0.9 * hubR
  const Pg = 2 * Math.PI * 0.75 * R * Math.tan(p.pitchDeg * D2R)     // 螺旋桨型：几何桨距（0.75R 处桨距角 = pitchDeg）
  const theta = prop ? (r) => Math.atan2(Pg, 2 * Math.PI * Math.max(r, 1e-9)) / D2R : (r) => p.pitchDeg + p.twistDeg * (r / R - 0.75)
  // 站位 [水平半径 r, 弦长系数, 相对厚度, 前缘后移]（r 严格递增）
  const st = prop
    ? [[e + 0.02 * R, 0.5, 0.22, 0], ...PROP_ST.map(([f, cf, tc]) => [f * R, cf, tc, 0])]
    : [[e + 0.01 * R, 0.4, 0.35, 0], [Math.max(e + 0.06 * R, 0.15 * R), 0.62, 0.2, 0], [Math.max(e + 0.12 * R, 0.22 * R), 1, 0.12, 0], [0.55 * R, 1, 0.12, 0],
        ...(HELI_TIPS[p.tip] || HELI_TIPS.square).map(([f, cf, tc, sw]) => [f * R, cf, tc, sw])]
  const S = []
  for (const s of st) if (!S.length || s[0] > S[S.length - 1][0] + 1e-6 * R) S.push(s)
  return { D, R, prop, compact, hubR, mastH, hubT, zh, c0, beta, e, theta, st: S, pa: prop ? 0.35 : 0.25, cam: prop ? 0.04 : 0 }
}

/** 第 k 片桨叶（方位 ψ，ccw = 从桨毂一侧看逆时针）的截面站：水平半径 r 处，桨距 θ(r)，挥舞铰在 0.9 桨毂半径处。 */
function bladeStations(g, psi) {
  const cs = Math.cos(psi), sn = Math.sin(psi), cb = Math.cos(g.beta), sb = Math.sin(g.beta)
  const s = [cs * cb, sn * cb, -sb], m = [sn, -cs, 0], u = nrm(cross(s, m))
  const hinge = [g.e * cs, g.e * sn, g.zh]
  return g.st.map(([r, cf, tc, sw]) => {
    const th = g.theta(r) * D2R, ct = Math.cos(th), si = Math.sin(th)
    const ch = add(scl(m, -ct), scl(u, -si)), up = add(scl(u, ct), scl(m, -si))
    const A = madd(hinge, s, (r - g.e) / cb), c = cf * g.c0
    return { le: madd(A, ch, sw * g.c0 - g.pa * c), ch, up, c, tc, cam: g.cam }
  })
}

const rotor = {
  type: 'air.rotor', domain: ['aircraft'], title: 'Rotor', titleZh: '旋翼', role: 'thruster', category: 'propulsion', family: 'powerplant',
  aliases: ['旋翼', '桨叶', '尾桨', 'rotor'],
  params: {
    diameterM: num(11, 'm', '旋翼直径', { gt: 0.1, max: 30, title: '桨尖轨迹圆直径' }),
    blades: int(4, '桨叶数', { min: 2, max: 8 }),
    planform: enm('helicopter', ['helicopter', 'propeller'], '桨叶型式', { title: 'helicopter = 直升机等弦长桨叶（线性扭转）；propeller = 多旋翼 / 升力螺旋桨（中段宽、两端收窄，按几何桨距扭转）' }),
    chordFrac: num(0.075, '', '弦长比', { min: 0.02, max: 0.4, title: '桨叶弦长 / 旋翼半径（螺旋桨型取最大弦长）' }),
    tip: enm('swept', ['square', 'swept', 'tapered'], '桨尖', { title: '直升机桨叶桨尖：square = 矩形；swept = 后掠；tapered = 梯形收窄' }),
    pitchDeg: num(8, '°', '桨距角', { min: -10, max: 45, title: '0.75 半径处，自桨盘平面量起' }),
    twistDeg: num(-10, '°', '负扭转', { min: -30, max: 10, title: '直升机桨叶的线性扭转（桨尖相对桨根）；螺旋桨型按几何桨距扭转、不用此项' }),
    coningDeg: num(2, '°', '锥度角', { min: -5, max: 15, title: '桨叶相对桨盘平面的上翘角' }),
    hub: enm('articulated', ['articulated', 'hingeless', 'compact'], '桨毂', { title: 'articulated = 全铰接（弹性轴承 + 桨叶间减摆器）；hingeless = 无铰星形桨毂；compact = 电机罩式小桨毂（多旋翼 / 升力螺旋桨）' }),
    hubDM: num(null, 'm', '桨毂直径', { nullable: true, gt: 0, title: '留空 = 0.1 × 旋翼直径（compact 为 0.08 ×）' }),
    mastHM: num(null, 'm', '旋翼轴高', { nullable: true, min: 0, title: '安装面到桨毂下缘；留空 = 0.05 × 旋翼直径（compact 为 0）' }),
    hand: enm('ccw', ['ccw', 'cw'], '旋向', { title: '从桨毂一侧看：ccw = 逆时针；cw = 顺时针。镜像复制的另一侧自动取反' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '含桨叶与桨毂；留空 = 0.7 × 直径^2.5（螺旋桨型 0.25 ×）' })
  },
  validate: (p) => (rotorGeom(p).hubR < 0.3 * p.diameterM / 2 ? [] : ['桨毂直径过大']),
  sockets: (p) => [standSocket(Math.max(0.02, 1.2 * rotorGeom(p).hubR), 15)],
  // 桨叶有手性：不声明对称面；镜像钩子翻转旋向（cw 几何 = ccw 几何关于 xz 面逐位镜像）
  mirror: (p, plane) => (plane === 'xz' ? { ...p, hand: p.hand === 'cw' ? 'ccw' : 'cw' } : { ...p }),
  mirrorPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = rotorGeom(p), N = p.blades, hr = g.hubR, zh = g.zh, T = g.hubT
    const part = { id: 'rotor', name: '旋翼', role: 'thruster' }
    const psis = []
    for (let k = 0; k < N; k++) psis.push((2 * Math.PI * k) / N)
    const rad = (psi, r, z) => [r * Math.cos(psi), r * Math.sin(psi), z]
    // —— 桨叶
    const bm = new MB()
    for (const psi of psis) foilLoft(bm, bladeStations(g, psi), 12)
    // —— 旋翼头 / 旋翼轴 / 自动倾斜器 / 变距拉杆
    const hm = new MB(), mm = new MB(), sm = new MB(), lm = new MB()
    const armBox = (psi, r0, r1, w, h, z) => {
      const q = [Math.cos(psi), Math.sin(psi), 0], t = [-Math.sin(psi), Math.cos(psi), 0]
      const P = (r, sw, sh) => add(add(scl(q, r), scl(t, (sw * w) / 2)), [0, 0, z + (sh * h) / 2])
      prism(hm, [P(r0, -1, 1), P(r1, -1, 1), P(r1, 1, 1), P(r0, 1, 1)], [P(r0, -1, -1), P(r1, -1, -1), P(r1, 1, -1), P(r0, 1, -1)])
    }
    if (g.compact) {
      // 电机罩式：扁圆柱 + 顶部桨帽
      lathe(hm, [[0, 0], [0, 0.96 * hr], [0.12 * T, hr], [1.88 * T, hr], [2 * T, 0.9 * hr], [2 * T, 0]], 32, [0, 0, 0], [0, 0, -1])
      lathe(hm, [[1.95 * T, 0], [1.95 * T, 0.42 * hr], [2.25 * T, 0.38 * hr], [2.5 * T, 0.24 * hr], [2.62 * T, 0]], 24, [0, 0, 0], [0, 0, -1])
    } else {
      if (g.mastH > 1e-6) {
        // 旋翼轴：底部整流锥 + 轴（轴顶伸进桨毂）
        lathe(mm, [[0, 0], [0, 0.46 * hr], [0.3 * g.mastH, 0.24 * hr], [g.mastH + 0.4 * T, 0.2 * hr], [g.mastH + 0.4 * T, 0]], 32, [0, 0, 0], [0, 0, -1])
        // 自动倾斜器：不动环 + 转动环 + 中间盘
        const zs = -0.45 * g.mastH
        lathe(sm, [[0, 0], [0, 0.36 * hr], [0.16 * hr, 0.36 * hr], [0.16 * hr, 0]], 32, [0, 0, zs + 0.03 * hr], [0, 0, -1])
        torus(sm, [0, 0, zs], [0, 0, 1], 0.42 * hr, 0.06 * hr, 32, 8)
        torus(sm, [0, 0, zs - 0.13 * hr], [0, 0, 1], 0.38 * hr, 0.05 * hr, 32, 8)
        // 变距拉杆：转动环 → 各桨叶变距摇臂（前缘一侧）
        for (const psi of psis) {
          const lead = psi - (0.42 * Math.PI) / Math.max(3, N)
          tubeAlong(lm, rad(lead, 0.38 * hr, zs - 0.13 * hr), rad(lead, 0.7 * hr, zh + 0.6 * T), 0.035 * hr, 8)
        }
      }
      // 桨毂中心体 + 顶盖
      lathe(hm, [[0, 0], [0, 0.48 * hr], [0.2 * T, 0.55 * hr], [1.8 * T, 0.55 * hr], [2 * T, 0.48 * hr], [2 * T, 0]], 32, [0, 0, zh + T], [0, 0, -1])
      lathe(hm, [[1.98 * T, 0], [1.98 * T, 0.46 * hr], [2.4 * T, 0.4 * hr], [2.8 * T, 0.24 * hr], [3 * T, 0]], 32, [0, 0, zh + T], [0, 0, -1])
      for (const psi of psis) {
        // 桨叶支臂（全铰接：粗支臂 + 弹性轴承；无铰：扁平柔性梁）+ 变距摇臂
        if (p.hub === 'articulated') {
          armBox(psi, 0.3 * hr, g.e, 0.34 * hr, 1.5 * T, zh)
          lathe(hm, [[0, 0], [0, 0.1 * hr], [0.04 * hr, 0.16 * hr], [0.22 * hr, 0.16 * hr], [0.26 * hr, 0.1 * hr], [0.26 * hr, 0]], 16, rad(psi, 0.5 * hr, zh), [Math.cos(psi), Math.sin(psi), 0])
        } else armBox(psi, 0.3 * hr, g.e, 0.28 * hr, 0.8 * T, zh)
        const lead = psi - (0.42 * Math.PI) / Math.max(3, N)
        tubeAlong(hm, rad(psi, 0.72 * hr, zh), rad(lead, 0.72 * hr, zh + 0.6 * T), 0.06 * hr, 8)
      }
      // 桨叶间减摆器（全铰接、3 片以上）
      if (p.hub === 'articulated' && N >= 3) {
        for (let k = 0; k < N; k++) {
          const a = psis[k], b = a + (2 * Math.PI) / N, d = 0.22 * (b - a)
          tubeAlong(hm, rad(a + d, 0.8 * hr, zh - 0.55 * T), rad(b - d, 0.8 * hr, zh - 0.55 * T), 0.07 * hr, 10)
        }
      }
    }
    if (p.hand === 'cw') for (const mb of [bm, hm, mm, sm, lm]) if (mb.vcount) mirrorY(mb, 0, 0)
    const bIt = put(ctx, 'blades', 'thruster', part, 'dark_metal', bm)
    const hIt = put(ctx, 'head', 'thruster', part, 'titanium', hm)
    const mIt = put(ctx, 'mast', 'boom', part, 'titanium', mm)
    const sIt = put(ctx, 'swash', 'boom', part, 'dark_metal', sm)
    const lIt = put(ctx, 'links', 'boom', part, 'titanium', lm)
    const m = p.massKg !== null && p.massKg > 0 ? p.massKg : (g.prop ? 0.25 : 0.7) * g.D ** 2.5
    solidCompItems(ctx, 'blades', [bIt], 1, 0.6 * m)
    solidCompItems(ctx, 'head', [hIt, mIt, sIt, lIt].filter(Boolean), 1, 0.4 * m)
    ctx.arts.push({ name: 'spin', nodes: [bIt, hIt, lIt].filter(Boolean).map((it) => it.name), stages: [stage('spin', 'zRotate', -180, 180, 0)] })
    apLocal(ctx, 'hub', [0, 0, zh], [0, 0, -1], [1, 0, 0])
    return ctx
  }
}

/** 旋翼桨毂半厚（米）；p 可为未补缺省的原始参数。桨毂顶在安装面上方 旋翼轴高 + 3 × 半厚（compact：2.62 ×）。 */
export const rotorHubT = (p) => rotorGeom(fillLocal(rotor, p)).hubT

// ───────────────────────────── air.heli 直升机机身 ─────────────────────────────

const E_CAB = 2.8   // 座舱段截面超椭圆指数（方中带圆）

/**
 * 直升机机身几何。截面 sec(x) → {a 半宽, bUp, bDown, zc, e}：机头（下母线钝、上母线先缓后陡 = 风挡）→ 座舱等直段 → 后机身过渡
 * （机腹先上扫、顶线后收）→ 尾梁（圆截面，锥度 + 上扬）。垂尾按「尾桨轴高」反解高度、按「最后端 = 机身尾端」定位置（尾梁止于垂尾根部后缘）；
 * 主旋翼轴 = 尾桨轴前方「尾桨力臂」处；整流罩以主旋翼轴为基准前 35 % 后 65 %。
 */
function heliGeom(p) {
  const L = p.lengthM, W = p.widthM, H = p.heightM, a0 = W / 2, b0 = H / 2
  const Ln = p.noseFrac * L, Lc = p.cabinFrac * L, La = p.aftFrac * L
  const xN = L / 2, xC0 = xN - Ln, xC1 = xC0 - Lc, xB0 = xC1 - La
  const rb0 = auto(p.boomDM, 0.34 * H) / 2, rb1 = p.boomTaper * rb0
  const zBA = p.boomZFrac * b0, tUp = Math.tan(p.boomUpDeg * D2R), zTip = 0.15 * b0
  // 垂尾平面形（根弦 cR、梢根比、前缘后掠）；高度由尾桨轴高反解（尾桨轴在垂尾 trZFrac 高处），迭代收敛（尾梁锥度 / 上扬与垂尾位置互相影响很弱）
  const cR = auto(p.finChordM, 0.1 * L), cT = p.finTaper * cR, tS = Math.tan(p.finSweepDeg * D2R), tcF = 0.14
  const trH = auto(p.trHM, 1.35 * H), zT = b0 - trH
  let Hf = 1.2 * H, xLE0 = 0, xT = 0, zRoot = 0, zAxF = 0
  for (let it = 0; it < 8; it++) {
    xLE0 = -L / 2 + Math.max(cR, Math.max(0, Hf) * tS + cT)
    xT = xLE0 - cR
    const xm = xLE0 - 0.5 * cR, w = clampN((xB0 - xm) / Math.max(1e-9, xB0 - xT), 0, 1)
    zAxF = zBA - (xB0 - xm) * tUp
    zRoot = zAxF - (rb0 + (rb1 - rb0) * w)
    Hf = (zRoot - zT) / p.trZFrac
  }
  const HfOk = Math.max(Hf, 0.05 * H)
  const boomSec = (x) => {
    const w = clampN((xB0 - x) / Math.max(1e-9, xB0 - xT), 0, 1), r = rb0 + (rb1 - rb0) * w
    return { a: r, bUp: r, bDown: r, zc: zBA - (xB0 - x) * tUp, e: 2 }
  }
  const CAB = { a: a0, bUp: b0, bDown: b0, zc: 0, e: E_CAB }
  const noseSec = (x) => {
    const t = clampN((xN - x) / Ln, 0, 1)
    const fT = 0.45 * Math.sin((Math.PI / 2) * t) ** 0.7 + 0.55 * smooth01((t - 0.45) / 0.5), fB = (1 - (1 - t) ** 2.4) ** 0.5
    const zTop = zTip + (-b0 - zTip) * fT, zBot = zTip + (b0 - zTip) * fB, hh = (zBot - zTop) / 2
    return { a: a0 * (1 - (1 - t) ** 2.2) ** 0.5, bUp: hh, bDown: hh, zc: (zTop + zBot) / 2, e: 2 + (E_CAB - 2) * smooth01(t) }
  }
  const aftSec = (x) => {
    const v = clampN((xC1 - x) / La, 0, 1), sv = smooth01(v)
    const zTop = -b0 + (zBA - rb0 + b0) * sv, zBot = b0 + (zBA + rb0 - b0) * (1 - (1 - v) ** 1.8), hh = (zBot - zTop) / 2
    return { a: a0 + (rb0 - a0) * sv ** 0.85, bUp: hh, bDown: hh, zc: (zTop + zBot) / 2, e: E_CAB - (E_CAB - 2) * sv }
  }
  const sec = (x) => (x > xC0 ? noseSec(x) : x >= xC1 ? CAB : x >= xB0 ? aftSec(x) : boomSec(x))
  const topZ = (x) => { const s = sec(x); return s.zc - s.bUp }
  const bellyZ = (x) => { const s = sec(x); return s.zc + s.bDown }
  // 尾桨轴（垂尾侧面，trZFrac 高处的 45 % 弦长）
  const hT = zRoot - zT, cAt = (h) => cR + ((cT - cR) * h) / HfOk, leAt = (h) => xLE0 - h * tS
  const xTR = leAt(hT) - 0.45 * cAt(hT), yTR = nacaHalf(0.45, tcF) * cAt(hT), sgT = p.trSide === 'left' ? -1 : 1
  // 主旋翼轴与整流罩
  const xR = xTR + auto(p.trArmM, 0.62 * L)
  const dL = auto(p.deckLM, 0.4 * L), dH = auto(p.deckHM, 0.32 * H), dA = p.deckWFrac * a0
  const xd0 = xR + 0.35 * dL, xd1 = xR - 0.65 * dL
  const deckSec = (x) => {
    const u = clampN((xd0 - x) / dL, 0, 1), s = sec(x)
    const h = dH * Math.min(smooth01(u / 0.2) ** 0.6, smooth01((1 - u) / 0.42) ** 0.8)
    const a = Math.min(0.9 * s.a, dA * (0.72 + 0.28 * Math.min(smooth01(u / 0.3), smooth01((1 - u) / 0.45))))
    const zs = upperZ(s, a) + 0.012 * H, top = s.zc - s.bUp - h
    return { a, bUp: Math.max(1e-4 * H, zs - top), bDown: 0.12 * H, zc: zs, e: 2.4 }
  }
  const deckTop = (x) => { const s = deckSec(x); return s.zc - s.bUp }
  return {
    L, W, H, a0, b0, Ln, Lc, La, xN, xC0, xC1, xB0, xT, rb0, rb1, zBA, cR, cT, tS, tcF, Hf, HfOk, xLE0, zRoot, zAxF,
    zT, hT, xTR, yTR, sgT, xR, dL, xd0, xd1, sec, topZ, bellyZ, deckSec, deckTop, cAt, leAt
  }
}

/** 平尾右半站位（根在中线 y = 0，梢在 span / 2）。 */
function stabStations(x0, z, span, c, taper) {
  const b = span / 2, s = [0, 1, 0]
  return [0, 0.5, 1].map((f) => ({ le: [x0 - 0.06 * c * f, f * b, z], c: c * (1 + (taper - 1) * f), tc: 0.12, s, tw: 0, cam: 0 }))
}

const heli = {
  type: 'air.heli', domain: ['aircraft'], title: 'Helicopter fuselage', titleZh: '直升机机身', role: 'bus', category: 'structure', family: 'body', massSink: 'heli',
  aliases: ['直升机', '机身', '旋翼机', 'helicopter'],
  params: {
    lengthM: num(13, 'm', '机身长', { gt: 3, max: 40, title: '机头到尾端（含垂尾），不含旋翼' }),
    widthM: num(2.2, 'm', '机身宽', { gt: 0.5, max: 6, title: '座舱段外廓宽' }),
    heightM: num(1.9, 'm', '座舱高', { gt: 0.5, max: 6, title: '座舱段机腹到舱顶的外廓高（不含整流罩）' }),
    noseFrac: num(0.16, '', '机头段', { min: 0.05, max: 0.35, title: '机头段长 / 机身长' }),
    cabinFrac: num(0.3, '', '座舱段', { min: 0.05, max: 0.6, title: '座舱等直段长 / 机身长' }),
    aftFrac: num(0.12, '', '后机身段', { min: 0.03, max: 0.4, title: '座舱到尾梁的过渡段长 / 机身长' }),
    boomDM: num(null, 'm', '尾梁根部直径', { nullable: true, gt: 0.05, title: '留空 = 0.34 × 座舱高' }),
    boomTaper: num(0.6, '', '尾梁梢根比', { min: 0.2, max: 1 }),
    boomZFrac: num(-0.35, '', '尾梁高低', { min: -0.9, max: 0.5, title: '尾梁根部轴线相对座舱截面中心 / 半高；负 = 偏上' }),
    boomUpDeg: num(1.5, '°', '尾梁上扬角', { min: -5, max: 10 }),
    trHM: num(null, 'm', '尾桨轴高', { nullable: true, gt: 0, title: '座舱机腹到尾桨轴的高度，垂尾高随之确定；留空 = 1.35 × 座舱高' }),
    trZFrac: num(0.78, '', '尾桨在垂尾上的位置', { min: 0.3, max: 0.98, title: '尾桨轴所在高度 / 垂尾高' }),
    trSide: enm('left', ['left', 'right'], '尾桨侧', { title: '尾桨装在垂尾的哪一侧' }),
    trArmM: num(null, 'm', '尾桨力臂', { nullable: true, gt: 0, title: '主旋翼轴到尾桨轴的纵向距离；留空 = 0.62 × 机身长' }),
    finChordM: num(null, 'm', '垂尾根弦长', { nullable: true, gt: 0, title: '留空 = 0.1 × 机身长' }),
    finTaper: num(0.65, '', '垂尾梢根比', { min: 0.2, max: 1 }),
    finSweepDeg: num(38, '°', '垂尾前缘后掠角', { min: 0, max: 65 }),
    ventral: bool(true, '腹鳍', { title: '尾梁末端下方的小腹鳍与尾橇' }),
    stab: enm('both', ['both', 'right', 'left', 'none'], '平尾', { title: 'both = 两侧对称；right / left = 仅单侧（装在垂尾侧面）；none = 无' }),
    stabSpanM: num(null, 'm', '平尾展长', { nullable: true, gt: 0, title: '两尖间距（单侧时为单侧长 × 2）；留空 = 0.24 × 机身长' }),
    stabChordM: num(null, 'm', '平尾弦长', { nullable: true, gt: 0, title: '留空 = 0.3 × 平尾展长' }),
    stabHFrac: num(0, '', '平尾高度', { min: 0, max: 1, title: '0 = 装在尾梁上；> 0 = 装在垂尾上的高度 / 垂尾高' }),
    endplates: bool(false, '平尾端板'),
    deckLM: num(null, 'm', '整流罩长', { nullable: true, gt: 0, title: '发动机与主减速器整流罩；留空 = 0.4 × 机身长' }),
    deckHM: num(null, 'm', '整流罩高', { nullable: true, gt: 0, title: '高出舱顶的高度；留空 = 0.32 × 座舱高' }),
    deckWFrac: num(0.7, '', '整流罩宽', { min: 0.3, max: 0.95, title: '整流罩宽 / 机身宽' }),
    engines: int(2, '发动机数', { options: [1, 2], title: '1 = 尾部居中一个排气口；2 = 两侧各一个排气管' }),
    gear: enm('sponson', ['sponson', 'skid', 'none'], '起落架', { title: 'sponson = 浮筒式短翼舱（机轮收起）；skid = 滑橇；none = 无' }),
    gearHM: num(null, 'm', '滑橇离机腹', { nullable: true, gt: 0, title: '机腹到滑橇管中心；留空 = 0.38 × 座舱高' }),
    windows: bool(true, '舷窗'),
    doors: bool(true, '舱门线'),
    arealKgM2: num(35, 'kg/m²', '结构面密度', { gt: 0, max: 500, title: '蒙皮 + 框桁 + 系统按表面积折算' }),
    massKg: num(null, 'kg', '机身质量', { nullable: true, gt: 0, title: '留空按面密度估算；装配件指定目标质量时由其承担质量差额' }),
    seg: int(40, '周向分段', { min: 16, max: 96 })
  },
  validate: (p) => {
    if (!(p.noseFrac + p.cabinFrac + p.aftFrac < 0.85)) return ['机头、座舱与后机身段过长']
    const g = heliGeom(p), e = []
    if (!(g.xT < g.xB0 - 0.1 * g.L)) e.push('尾梁过短')
    if (!(g.Hf > 0.15 * g.H)) e.push('尾桨轴高过小')
    if (!(g.xd0 < g.xN - 0.3 * g.Ln && g.xd1 > g.xT + 0.25 * (g.xB0 - g.xT))) e.push('主旋翼轴位置超出机身')
    return e
  },
  sockets: (p) => {
    const g = heliGeom(p), sz = Math.max(0.1, 0.12 * g.W), xk = g.xN - 0.45 * g.Ln, xc = (g.xd1 + g.xLE0) / 2
    return [
      sock('root', [(g.xC0 + g.xC1) / 2, 0, g.b0], [0, 0, 1], [1, 0, 0], sz, 90),   // 座舱机腹中点（尾桨轴高 / 旋翼头高的基准）
      sock('rotor', [g.xR, 0, g.deckTop(g.xR)], [0, 0, -1], [1, 0, 0], sz, 15, ACC('air.rotor')),
      sock('trotor', [g.xTR, g.sgT * g.yTR, g.zT], [0, g.sgT, 0], [1, 0, 0], Math.max(0.05, 0.25 * g.cAt(g.hT)), 15, ACC('air.rotor')),
      sock('chin', [xk, 0, g.bellyZ(xk)], [0, 0, 1], [1, 0, 0], Math.max(0.08, 0.18 * g.W), 90, ACC('air.turret')),
      sock('crown', [xc, 0, g.topZ(xc)], [0, 0, -1], [1, 0, 0], Math.max(0.05, 0.8 * g.rb0), 90, ACC('air.radome', '@array', '@wire'))
    ]
  },
  faces: (p) => {
    const g = heliGeom(p), xm = (g.xC0 + g.xC1) / 2, hu = 0.45 * g.Lc, hv = 0.3 * g.H
    return [planeFace('+Y', [xm, g.a0, 0], hu, hv, 'sideR'), planeFace('-Y', [xm, -g.a0, 0], hu, hv, 'sideL')]
  },
  symmetricPlanes: (p) => (p.stab === 'left' || p.stab === 'right' ? [] : ['xz']),
  // 尾桨只装一侧：飞机装配件缺省的镜像 XZ 不作用于装在尾桨轴上的件（asmSnap.socketSingle）
  singleSockets: ['trotor'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = heliGeom(p), seg = p.seg, sec = g.sec, L = g.L
    const part = { id: 'heli', name: '机身', role: 'bus' }
    // —— 蒙皮：机头 16 站（余弦加密到机头尖，尖端收成极点）+ 座舱 3 站 + 后机身 10 站 + 尾梁 6 站，尾端封口
    const xs = []
    for (let i = 0; i < 16; i++) { const s = i === 15 ? 1 : 1 - Math.cos((Math.PI / 2) * (i / 15)); xs.push(g.xN - s * g.Ln) }
    for (const f of [0.33, 0.67, 1]) xs.push(g.xC0 - f * g.Lc)
    for (let j = 1; j <= 10; j++) xs.push(g.xC1 - (j / 10) * g.La)
    for (let j = 1; j <= 6; j++) xs.push(g.xB0 - (j / 6) * (g.xB0 - g.xT))
    const skin = new MB()
    const lf = loft(skin, xs.map((x) => { const s = sec(x); return { c: [x, 0, s.zc], ring: superRing(seg, s.a, s.bUp, s.bDown, s.e) } }))
    poleNormals(skin, lf, seg, [1, 0, 0], null)
    const skinIt = put(ctx, 'skin', 'bus', part, 'white_paint', skin)
    const cm = new MB()
    cap(cm, lf.G[lf.G.length - 1], [-1, 0, 0], [g.xT, 0, sec(g.xT).zc])
    const capIt = put(ctx, 'tailcap', 'bus', part, 'white_paint', cm)
    // —— 发动机 / 主减速器整流罩（以主旋翼轴为基准，两端收在舱顶里）
    const deck = { id: 'deck', name: '发动机整流罩', role: 'bus' }, dm = new MB(), dsec = g.deckSec, dxs = []
    for (let i = 0; i <= 18; i++) dxs.push(g.xd0 - g.dL * (0.5 - 0.5 * Math.cos((Math.PI * i) / 18)))
    loft(dm, dxs.map((x) => { const s = dsec(x); return { c: [x, 0, s.zc], ring: superRing(seg, s.a, s.bUp, s.bDown, s.e) } }), { capStart: true, capEnd: true })
    const dIt = put(ctx, 'deck', 'bus', deck, 'white_paint', dm)
    // —— 进气格栅 / 排气管（右侧造好后镜像；单发时尾部居中一个排气口）
    const lift = 0.004 + 0.0006 * g.W, im = new MB(), em = new MB()
    secQuad(im, dsec, [[g.xd0 - 0.14 * g.dL, 58], [g.xd0 - 0.3 * g.dL, 58], [g.xd0 - 0.3 * g.dL, 82], [g.xd0 - 0.14 * g.dL, 82]], lift, L, 4, 4)
    mirrorCopyY(im, 0, 0)
    const xe = g.xd0 - 0.8 * g.dL, re = 0.065 * g.W
    if (p.engines === 2) {
      const s0 = secP(dsec, xe, 72 * D2R)
      lathe(em, [[-0.02 * g.W, 0], [-0.02 * g.W, re], [0.12 * g.W, re], [0.17 * g.W, 1.12 * re], [0.17 * g.W, 0]], 24, [s0[0], s0[1] - 0.03 * g.W, s0[2]], nrm([-0.55, 0.62, -0.56]))
      mirrorCopyY(em, 0, 0)
    } else {
      lathe(em, [[-0.02 * g.W, 0], [-0.02 * g.W, 1.3 * re], [0.14 * g.W, 1.3 * re], [0.19 * g.W, 1.45 * re], [0.19 * g.W, 0]], 24, [xe, 0, g.deckTop(xe) + 0.04 * g.H], nrm([-0.86, 0, -0.5]))
    }
    put(ctx, 'intakes', 'other', deck, 'dark_metal', im)
    put(ctx, 'exhaust', 'thruster', deck, 'dark_metal', em)
    // —— 风挡 / 侧窗 / 颔窗 / 客舱舷窗 / 滑门框（右侧造好后镜像）
    const wm = new MB(), fm = new MB(), Xn = (s) => g.xN - s * g.Ln
    if (p.windows) {
      for (const pane of [
        [[0.56, 3], [0.9, 3], [0.97, 50], [0.62, 58]],
        [[0.68, 64], [1.1, 66], [1.1, 97], [0.72, 99]],
        [[0.6, 106], [0.88, 104], [0.88, 126], [0.66, 130]]
      ]) secQuad(wm, sec, pane.map(([s, t]) => [Xn(s), t]), 1.5 * lift, L)
      const hw = 0.11 * g.Lc, hh = 0.16 * g.H, out = roundRect(hw, hh, 0.5 * Math.min(hw, hh), 3)
      for (const f of [0.22, 0.5, 0.78]) secDecal(wm, sec, g.xC0 - f * g.Lc, 72 * D2R, out, lift, L)
    }
    if (p.doors) {
      const x0 = g.xC0 - 0.08 * g.Lc, x1 = g.xC0 - 0.64 * g.Lc, t0 = 60, t1 = 140, lw = 0.012 + 0.004 * g.W, dt = lw / (0.5 * g.H) / D2R
      for (const x of [x0, x1]) secQuad(fm, sec, [[x - lw, t0], [x + lw, t0], [x + lw, t1], [x - lw, t1]], lift, L, 1, 8)
      for (const t of [t0, t1]) secQuad(fm, sec, [[x1 - lw, t - dt], [x0 + lw, t - dt], [x0 + lw, t + dt], [x1 - lw, t + dt]], lift, L, 8, 1)
    }
    mirrorCopyY(wm, 0, 0); mirrorCopyY(fm, 0, 0)
    put(ctx, 'windows', 'other', part, 'dark_metal', wm)
    put(ctx, 'doors', 'other', part, 'dark_metal', fm)
    // —— 垂尾（根截面埋到尾梁轴线）+ 腹鳍与尾橇
    const tail = { id: 'tail', name: '尾翼', role: 'other' }, finm = new MB(), up = [0, 0, -1], zr = g.zRoot, rIn = g.zAxF - zr
    liftSurface(finm, [
      { le: [g.xLE0 + rIn * g.tS, 0, g.zAxF], c: g.cR, tc: g.tcF, s: up, tw: 0 },
      { le: [g.xLE0, 0, zr], c: g.cR, tc: g.tcF, s: up, tw: 0 },
      { le: [g.leAt(0.5 * g.HfOk), 0, zr - 0.5 * g.HfOk], c: g.cAt(0.5 * g.HfOk), tc: g.tcF, s: up, tw: 0 },
      { le: [g.leAt(g.HfOk), 0, zr - g.HfOk], c: g.cT, tc: 0.9 * g.tcF, s: up, tw: 0 }
    ], 14)
    if (p.ventral) {
      const vH = 0.32 * g.HfOk, vc = 0.55 * g.cR, xv = g.xT + 0.85 * g.cR, zb = g.zAxF, rB = g.rb1, dn = [0, 0, 1]
      liftSurface(finm, [
        { le: [xv, 0, zb], c: vc, tc: 0.12, s: dn, tw: 0 },
        { le: [xv - 0.25 * vc, 0, zb + rB + 0.5 * vH], c: 0.8 * vc, tc: 0.12, s: dn, tw: 0 },
        { le: [xv - 0.55 * vc, 0, zb + rB + vH], c: 0.5 * vc, tc: 0.1, s: dn, tw: 0 }
      ], 10)
      tubeAlong(finm, [xv - 0.6 * vc, 0, zb + rB + 0.96 * vH], [xv - 1.1 * vc, 0, zb + rB + 0.96 * vH], 0.035 * vH + 0.004, 12)
    }
    const finIt = put(ctx, 'fin', 'other', tail, 'white_paint', finm)
    // —— 平尾（两侧 / 单侧；端板）
    const stm = new MB(), span = auto(p.stabSpanM, 0.24 * L), sc = auto(p.stabChordM, 0.3 * span)
    if (p.stab !== 'none') {
      const onFin = p.stabHFrac > 0, hs = p.stabHFrac * g.HfOk
      const x0 = onFin ? g.leAt(hs) - 0.15 * g.cAt(hs) + 0.25 * sc : g.xLE0 + 0.9 * sc
      const z = onFin ? zr - hs : sec(x0 - 0.5 * sc).zc
      liftSurface(stm, stabStations(x0, z, span, sc, 0.85), 12)
      if (p.endplates) {
        const b = span / 2, ce = 0.85 * sc, hEp = 0.42 * ce
        liftSurface(stm, [-1, 0, 1].map((f) => ({ le: [x0 - 0.06 * sc - 0.05 * ce - 0.12 * ce * f, b, z - f * hEp], c: ce * (1 - 0.15 * Math.abs(f)), tc: 0.1, s: up, tw: 0 })), 10)
      }
      if (p.stab === 'both') mirrorCopyY(stm, 0, 0)
      else if (p.stab === 'left') mirrorY(stm, 0, 0)
    }
    const stIt = put(ctx, 'stab', 'other', tail, 'white_paint', stm)
    // —— 起落架：浮筒式短翼舱（机轮收在里面）/ 滑橇（两根滑橇管 + 两道拱形横管）
    const gm = new MB()
    if (p.gear === 'sponson') {
      const ls = 0.62 * g.Lc, xs0 = g.xC1 + 0.38 * g.Lc, sw = 0.15 * g.W, sh = 0.17 * g.H, ys = g.a0 + 0.3 * sw, zs = g.b0 - 0.85 * sh, secs = []
      for (let i = 0; i <= 14; i++) {
        const u = 0.5 - 0.5 * Math.cos((Math.PI * i) / 14), f = i === 0 || i === 14 ? 0 : Math.sqrt(smooth01(u / 0.28) * smooth01((1 - u) / 0.42))
        secs.push({ c: [xs0 - u * ls, ys, zs], ring: superRing(24, sw * f, sh * f, sh * f, 2.6) })
      }
      poleNormals(gm, loft(gm, secs), 24, [1, 0, 0], [-1, 0, 0])
      mirrorCopyY(gm, 0, 0)
    } else if (p.gear === 'skid') {
      const zs = g.b0 + auto(p.gearHM, 0.38 * g.H), yS = 0.6 * g.W, rs = 0.018 * g.W + 0.004
      const xf = g.xC0 + 0.3 * g.Ln, xr = g.xC1 - 0.25 * g.La, upT = 0.16 * g.H, path = []
      for (let i = 0; i <= 5; i++) { const a = (Math.PI / 2) * (i / 5); path.push([xf + upT * Math.cos(a), yS, zs - 0.9 * upT * (1 - Math.sin(a))]) }
      path.push([xr, yS, zs], [xr - 0.25 * upT, yS, zs - 0.12 * upT])
      sweepTube(gm, path, rs, [0, 1, 0])
      mirrorCopyY(gm, 0, 0)
      for (const x of [g.xC0 - 0.12 * g.Lc, g.xC1 + 0.18 * g.Lc]) {
        const half = [], zb = g.bellyZ(x) - 0.02 * g.H
        for (let k = 0; k <= 6; k++) { const t = k / 6; half.push([x, yS * (1 - t), zs + (zb - zs) * Math.sin((Math.PI / 2) * t) ** 0.7]) }
        sweepTube(gm, [...half.map((q) => [q[0], z0(-q[1]), q[2]]), ...half.slice(0, -1).reverse()], 1.15 * rs, [1, 0, 0])
      }
    }
    const gIt = put(ctx, 'gear', 'other', { id: 'gear', name: '起落架', role: 'other' }, p.gear === 'skid' ? 'aluminum' : 'white_paint', gm)
    // —— 质量：蒙皮按面密度（给了总量就按闭合体积分布）；整流罩、尾翼、起落架另计（示意）
    if (p.massKg !== null && p.massKg > 0) solidCompItems(ctx, 'heli', [skinIt, capIt], 1, p.massKg)
    else shellMass(ctx, 'heli', skinIt, p.arealKgM2)
    shellMass(ctx, 'deck', dIt, 0.6 * p.arealKgM2)
    const tailArea = (g.HfOk * (g.cR + g.cT)) / 2 + (stIt ? span * sc : 0)
    solidCompItems(ctx, 'tail', [finIt, stIt].filter(Boolean), 1, 18 * tailArea)
    if (gIt) solidCompItems(ctx, 'gear', [gIt], 1, (p.gear === 'skid' ? 0.012 : 0.02) * L * L * g.W)
    datumAp(ctx)
    return ctx
  }
}

/** air.heli 的插座（p 可为未补缺省的原始参数）。 */
export const getHeliSockets = (p) => heli.sockets(fillLocal(heli, p))

// ───────────────────────────── air.mrbody 多旋翼机体 ─────────────────────────────

function mrGeom(p) {
  const wb = p.wheelbaseM, R = wb / 2
  const bL = auto(p.bodyLM, 0.36 * wb), bW = auto(p.bodyWM, 0.3 * wb), bH = auto(p.bodyHM, 0.14 * wb)
  const armR = auto(p.armDM, 0.036 * wb) / 2, mD = auto(p.motorDM, 0.09 * wb), mH = auto(p.motorHM, 0.05 * wb)
  const n = p.arms, phi0 = p.layout === 'x' ? Math.PI / n : 0
  const hl = bL / 2, a0 = bW / 2, up0 = 0.55 * bH, dn0 = 0.45 * bH
  const sec = (x) => {
    const r = clampN(Math.abs(x) / hl, 0, 1)
    return { a: a0 * (1 - r ** 4) ** 0.25, bUp: up0 * (1 - r ** 3) ** (1 / 3), bDown: dn0 * (1 - r ** 4) ** 0.25, zc: 0, e: 3.2 }
  }
  const r0 = 0.6 * Math.min(hl, a0), rise = Math.tan(p.armRiseDeg * D2R)
  const armZ = (r) => -(r - r0) * rise
  // 臂方位 φ 自 +X 向 +Y；sin φ 抹零（中线上的臂单独造，y > 0 的造好后镜像出 y < 0 的）。y < 0 的臂端位置取镜像伙伴的 (x, −y)，
  // 与镜像出来的网格逐位一致（伙伴：x 布局 n − 1 − i、+ 布局 n − i）
  const arms = []
  for (let i = 0; i < n; i++) {
    const phi = phi0 + (2 * Math.PI * i) / n, c = Math.cos(phi), s = Math.sin(phi)
    arms.push({ i, c: Math.abs(c) < 1e-12 ? 0 : c, s: Math.abs(s) < 1e-12 ? 0 : s })
  }
  for (const a of arms) {
    const b = a.s < 0 ? arms[(p.layout === 'x' ? n - 1 - a.i : n - a.i) % n] : a
    a.xy = [z0(R * b.c), z0(a.s < 0 ? -(R * b.s) : R * b.s)]
  }
  const zMb = armZ(R) - 0.75 * armR, zMt = zMb - mH                  // 电机座面 / 电机顶（旋翼接口）
  const batH = 0.045 * wb, zBat = -0.8 * up0 - batH
  const gH = 0.07 * wb, puck = 0.014 * wb, xG = -0.62 * hl, zG0 = -sec(xG).bUp
  const zTop = Math.min(-up0, p.battery ? zBat : 0, p.gnss ? zG0 - gH - puck : 0, zMt)
  const zGround = p.heightM !== null && p.heightM > 0 ? zTop + p.heightM : dn0 + 0.24 * wb
  return { wb, R, bL, bW, bH, hl, a0, up0, dn0, sec, armR, mD, mH, n, arms, r0, armZ, zMb, zMt, zBat, gH, puck, xG, zG0, zTop, zGround }
}
const mrbody = {
  type: 'air.mrbody', domain: ['aircraft'], title: 'Multirotor airframe', titleZh: '多旋翼机体', role: 'bus', category: 'structure', family: 'body', massSink: 'body',
  aliases: ['多旋翼', '四旋翼', '无人机', '机体', 'drone', 'multirotor', 'UAV'],
  params: {
    arms: int(4, '旋臂数', { options: [4, 6, 8] }),
    layout: enm('x', ['x', 'plus'], '布局', { title: 'x = 机头朝向两臂之间；plus = 机头沿一根旋臂' }),
    wheelbaseM: num(0.9, 'm', '轴距', { gt: 0.1, max: 5, title: '对角电机轴线间距' }),
    bodyLM: num(null, 'm', '机体长', { nullable: true, gt: 0, title: '中心机体长；留空 = 0.36 × 轴距' }),
    bodyWM: num(null, 'm', '机体宽', { nullable: true, gt: 0, title: '留空 = 0.3 × 轴距' }),
    bodyHM: num(null, 'm', '机体高', { nullable: true, gt: 0, title: '留空 = 0.14 × 轴距' }),
    armDM: num(null, 'm', '旋臂管径', { nullable: true, gt: 0, title: '留空 = 0.036 × 轴距' }),
    armRiseDeg: num(0, '°', '旋臂上反角', { min: -15, max: 20 }),
    motorDM: num(null, 'm', '电机直径', { nullable: true, gt: 0, title: '留空 = 0.09 × 轴距' }),
    motorHM: num(null, 'm', '电机高', { nullable: true, gt: 0, title: '留空 = 0.05 × 轴距' }),
    heightM: num(null, 'm', '全高', { nullable: true, gt: 0, title: '地面到机体最高点（不含桨叶），起落架高随之确定；留空 = 起落架取 0.24 × 轴距' }),
    gear: enm('skid', ['skid', 'legs', 'none'], '起落架', { title: 'skid = 两侧 T 形脚架；legs = 各臂下支腿；none = 无' }),
    gnss: bool(true, 'GNSS 天线'),
    battery: bool(true, '顶置电池'),
    massKg: num(null, 'kg', '机体质量', { nullable: true, gt: 0, title: '不含旋翼；留空 = 4 × 轴距²；装配件指定目标质量时由其承担质量差额' })
  },
  validate: (p) => {
    const g = mrGeom(p), e = []
    if (!(g.R > Math.max(g.hl, g.a0) + 0.5 * g.mD)) e.push('轴距过小')
    if (p.gear !== 'none' && !(g.zGround - g.dn0 > 0.03 * g.wb)) e.push('全高过小')
    return e
  },
  sockets: (p) => {
    const g = mrGeom(p), out = [sock('root', [0, 0, g.zGround], [0, 0, 1], [1, 0, 0], Math.max(0.03, 0.2 * g.bW), 15)]
    for (const a of g.arms) out.push(sock(`m${a.i + 1}`, [a.xy[0], a.xy[1], g.zMt], [0, 0, -1], [1, 0, 0], Math.max(0.02, 0.5 * g.mD), 15, ACC('air.rotor')))
    const xk = 0.36 * g.hl, xt = 0.78 * g.hl
    out.push(sock('gimbal', [xk, 0, g.sec(xk).bDown], [0, 0, 1], [1, 0, 0], Math.max(0.02, 0.3 * g.bW), 90, ACC('air.turret')))
    out.push(sock('top', [xt, 0, -g.sec(xt).bUp], [0, 0, -1], [1, 0, 0], Math.max(0.02, 0.2 * g.bW), 90, ACC('@wire', '@array')))
    return out
  },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = mrGeom(p), part = { id: 'body', name: '机体', role: 'bus' }
    // —— 中心机体（超椭圆平面 × 超椭圆截面，两端收成极点）
    const bm = new MB(), xs = []
    for (let i = 0; i <= 20; i++) xs.push(z0(-g.hl * Math.cos((Math.PI * i) / 20)))
    const lf = loft(bm, xs.map((x) => { const s = g.sec(x); return { c: [x, 0, 0], ring: superRing(40, s.a, s.bUp, s.bDown, s.e) } }))
    poleNormals(bm, lf, 40, [-1, 0, 0], [1, 0, 0])
    const bodyIt = put(ctx, 'body', 'bus', part, GREY, bm)
    // —— 旋臂 + 电机（中线上的单独造；y > 0 的造好后镜像出 y < 0 的）
    const am = new MB(), mm = new MB()
    const armOf = (a) => tubeAlong(am, [g.r0 * a.c, g.r0 * a.s, g.armZ(g.r0)], [g.R * a.c, g.R * a.s, g.armZ(g.R)], g.armR, 16)
    const motorOf = (a) => {
      const rm = g.mD / 2, h = g.mH + 0.9 * g.armR
      lathe(mm, [[0, 0], [0, 0.82 * rm], [0.3 * h, 0.86 * rm], [0.36 * h, rm], [0.92 * h, rm], [h, 0.82 * rm], [h, 0]], 24, [a.xy[0], a.xy[1], g.zMb + 0.9 * g.armR], [0, 0, -1])
    }
    for (const a of g.arms) if (a.s === 0) { armOf(a); motorOf(a) }
    const av = am.vcount, at = am.tcount, mv = mm.vcount, mt = mm.tcount
    for (const a of g.arms) if (a.s > 0) { armOf(a); motorOf(a) }
    mirrorCopyY(am, av, at); mirrorCopyY(mm, mv, mt)
    const armPart = { id: 'arms', name: '旋臂', role: 'boom' }
    const armIt = put(ctx, 'arms', 'boom', armPart, 'carbon', am)
    const motIt = put(ctx, 'motors', 'thruster', armPart, 'dark_metal', mm)
    // —— 顶置电池 / GNSS 天线
    const tm = new MB()
    if (p.battery) extrude(tm, roundRect(0.26 * g.bL, 0.3 * g.bW, 0.08 * g.bW, 3), -0.8 * g.up0, g.zBat)
    if (p.gnss) {
      tubeAlong(tm, [g.xG, 0, g.zG0 + 0.01 * g.wb], [g.xG, 0, g.zG0 - g.gH], 0.008 * g.wb, 12)
      lathe(tm, [[0, 0], [0, 0.045 * g.wb], [0.008 * g.wb, 0.05 * g.wb], [0.012 * g.wb, 0.036 * g.wb], [g.puck, 0]], 24, [g.xG, 0, g.zG0 - g.gH], [0, 0, -1])
    }
    const topIt = put(ctx, 'top', 'other', part, 'dark_metal', tm)
    // —— 起落架
    const gm = new MB(), zg = g.zGround
    if (p.gear === 'skid') {
      const yF = 0.24 * g.wb, rF = 0.011 * g.wb, yB = 0.3 * g.bW, hx = 0.2 * g.wb
      for (const sx of [1, -1]) tubeAlong(gm, [sx * 0.12 * g.wb, yB, 0.85 * g.dn0], [sx * 0.12 * g.wb, yF, zg - rF], 0.9 * rF, 12)
      tubeAlong(gm, [hx, yF, zg - rF], [-hx, yF, zg - rF], rF, 12)
      mirrorCopyY(gm, 0, 0)
    } else if (p.gear === 'legs') {
      const rl = 0.008 * g.wb, leg = (a) => { const r = 0.62 * g.R; tubeAlong(gm, [r * a.c, r * a.s, g.armZ(r)], [r * a.c, r * a.s, zg - rl], rl, 10) }
      for (const a of g.arms) if (a.s === 0) leg(a)
      const v = gm.vcount, t = gm.tcount
      for (const a of g.arms) if (a.s > 0) leg(a)
      mirrorCopyY(gm, v, t)
    }
    const gIt = put(ctx, 'gear', 'other', { id: 'gear', name: '起落架', role: 'other' }, 'carbon', gm)
    // —— 质量：缺省 4 × 轴距²，按闭合体积分布
    solidCompItems(ctx, 'body', [bodyIt, armIt, motIt, topIt, gIt].filter(Boolean), 1, p.massKg !== null && p.massKg > 0 ? p.massKg : 4 * g.wb * g.wb)
    datumAp(ctx)
    return ctx
  }
}

// ───────────────────────────── air.boom 旋翼撑杆 ─────────────────────────────

function boomGeom(p) {
  const L = p.lengthM, D = p.diameterM, R = D / 2
  const xF = p.fwdFrac * L, xA = xF - L
  const mD = auto(p.motorDM, 1.5 * D), mH = auto(p.motorHM, D)
  const xf = xF - 0.6 * mD, xr = Math.max(xA + 0.6 * mD, -p.rearMotorFrac * (L - xF))
  return { L, D, R, xF, xA, mD, mH, xf, xr, end: !p.rearMotor || p.rearMotorFrac <= 0.85, xe: xA + 3 * R }
}

const boom = {
  type: 'air.boom', domain: ['aircraft'], title: 'Rotor boom', titleZh: '旋翼撑杆', role: 'boom', category: 'structure', family: 'truss',
  aliases: ['撑杆', '旋翼撑杆', '机臂', '尾撑', 'boom', 'arm'],
  params: {
    lengthM: num(2.4, 'm', '撑杆长', { gt: 0.2, max: 20 }),
    diameterM: num(0.08, 'm', '撑杆直径', { gt: 0.01, max: 1 }),
    fwdFrac: num(0.42, '', '前伸比', { min: 0, max: 1, title: '安装点前方的撑杆长度 / 撑杆长' }),
    frontMotor: bool(true, '前电机'),
    rearMotor: bool(true, '后电机'),
    rearMotorFrac: num(1, '', '后电机位置', { min: 0.2, max: 1, title: '后电机距安装点 / 安装点后方撑杆长；1 = 撑杆尾端（≤ 0.85 时尾端可接垂尾）' }),
    motorDM: num(null, 'm', '电机直径', { nullable: true, gt: 0, title: '留空 = 1.5 × 撑杆直径' }),
    motorHM: num(null, 'm', '电机高', { nullable: true, gt: 0, title: '撑杆顶面到电机顶；留空 = 撑杆直径' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '含电机；留空 = 15 × 撑杆长 × 直径 + 60 × 电机直径² × 电机数' })
  },
  validate: (p) => {
    const g = boomGeom(p)
    return g.L > 2 * g.mD + 6 * g.R ? [] : ['撑杆过短']
  },
  sockets: (p) => {
    const g = boomGeom(p), ms = Math.max(0.02, 0.6 * g.mD), out = [hangSocket(Math.max(0.03, 2 * g.D), 90)]
    if (p.frontMotor) out.push(sock('fwd', [g.xf, 0, -g.mH], [0, 0, -1], [1, 0, 0], ms, 15, ACC('air.rotor')))
    if (p.rearMotor) out.push(sock('aft', [g.xr, 0, -g.mH], [0, 0, -1], [1, 0, 0], ms, 15, ACC('air.rotor')))
    if (g.end) out.push(sock('end', [g.xe, 0, 0], [0, 0, -1], [1, 0, 0], Math.max(0.02, 1.2 * g.D), 90, ACC('air.vtail')))
    return out
  },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = boomGeom(p), R = g.R, part = { id: 'boom', name: '旋翼撑杆', role: 'boom' }
    // —— 撑杆：圆截面回转体（轴线 z = R，顶面贴安装面 z = 0），尾端收尖、前端卵形
    const prof = [[g.xA, 0], [g.xA + 0.6 * R, 0.5 * R], [g.xA + 1.6 * R, 0.88 * R], [g.xA + 3 * R, R]]
    for (let i = 0; i <= 5; i++) { const a = (Math.PI / 2) * (i / 5); prof.push([g.xF - 1.5 * R * Math.cos(a), i === 5 ? 0 : R * Math.cos(a) ** 0.6]) }
    const bm = new MB()
    lathe(bm, prof, 24, [0, 0, R], [1, 0, 0])
    const bIt = put(ctx, 'tube', 'boom', part, 'white_paint', bm)
    // —— 电机（撑杆顶面上的电机座 + 外转子，座底埋进撑杆）
    const mm = new MB(), rm = g.mD / 2, h = 0.4 * R + g.mH
    const motor = (x) => lathe(mm, [[0, 0], [0, 0.9 * rm], [0.4 * R, rm], [0.4 * R + 0.55 * g.mH, rm], [0.4 * R + 0.62 * g.mH, 0.92 * rm], [h, 0.85 * rm], [h, 0]], 24, [x, 0, 0.4 * R], [0, 0, -1])
    if (p.frontMotor) motor(g.xf)
    if (p.rearMotor) motor(g.xr)
    const mIt = put(ctx, 'motors', 'thruster', part, 'dark_metal', mm)
    const m = p.massKg !== null && p.massKg > 0 ? p.massKg : 15 * g.L * g.D + 60 * g.mD * g.mD * ((p.frontMotor ? 1 : 0) + (p.rearMotor ? 1 : 0))
    solidCompItems(ctx, 'boom', [bIt, mIt].filter(Boolean), 1, m)
    return ctx
  }
}

export const ROTORCRAFT = Object.freeze({ rotor, heli, mrbody, boom })
