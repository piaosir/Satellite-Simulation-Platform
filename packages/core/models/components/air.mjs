// 飞机领域装配组件（三期契约 DESIGN3 §1 P1b、E5、E13；A3 规格 §4）。
//
// 纯 ESM、零 three 依赖、node 可测、确定性（同参数同 IR 字节；无随机数 / 时钟）。几何按真实结构比例参数化：
//   air.fuselage  机身：超椭圆截面放样（钝圆 / 尖 / 无人机卫通鼓包三种机头、机头下垂、上翘尾锥、APU 排气口），
//                 贴皮的风挡 / 舷窗带 / 舱门线（贴机身解析面，不是平板），翼身整流罩；根件，发 datum 挂点
//   air.wing      单侧机翼：NACA 翼型放样（1/4 弦后掠、上反、梢根比、内段后缘平直的转折、线性扭转、弯度），
//                 融合式 / 鲨鳍 / 斜削翼梢，襟翼滑轨整流罩；左翼由镜像钩子生成（整体 y 取反，逐位对称）
//   air.htail     平尾 / V 尾（整件含两侧）      air.vtail   垂尾 / 腹鳍（带背鳍整流）
//   air.nacelle   涡扇短舱 + 挂架：唇口 / 外罩 / 进气道 / 风扇（18 片宽弦扭转叶 + 轮毂 + 尖锥整流罩）/ 外涵道 / 分开或混合排气 / 扁底进气口
//   air.prop      螺旋桨：椭圆整流锥 + 扭转桨叶（按 0.75R 桨距角定几何螺距），关节 spin
//   air.radome    机载卫通天线罩：泪滴平面 × 低矮穹顶（底面可随机身圆柱下弯），罩内方位俯仰天线（关节 gimbal、挂点 boresight）
//   air.turret    光电球：吊挂座 + 方位筒 + 叉臂 + 球 + 窗口（关节 gimbal、挂点 boresight）
//
// ★ 局部坐标 = 飞机本体 FRD（+X 机头、+Y 右翼、+Z 向下；E5，assembly.mjs DOMAIN_FRAMES.aircraft），组件口径见 shapeKit.mjs 文件头：
//   机身原点 = 机身轴线的半长处（机身参考点，挂点 datum）；机翼 / 平尾原点 = 中线处翼根前缘，横向对齐（latMount n = −Y）
//   装机身 wing / htail 插座（latSocket n = +Y）后单位位姿；垂尾立装（mount n = +Z）；短舱 / 光电球吊装（mount n = −Z）。
//   尾吊短舱装机身 aftEng（latSocket）时解算为「局部 −Z → 本体 −Y」，挂架自动横置指向机身，同一几何两用。
// ★ 可指向天线（机载罩内天线、光电球）与地球站同一口径：挂点 boresight 在转动中心、静止 dir = +X、up = −Z；关节
//   azimuth（zRotate）+ elevation（xRotate），节点系 = ground.gimbalFrame('azel', +X, −Z)，驱动值走 ground.gimbalValues。
// ★ 对称面声明都是真的：凡声明 symmetricPlanes ['xz'] 的件，截面环一律用 shapeKit.superRing（左右逐位镜像），
//   贴花在右侧造好后整体镜像复制——量化比对不会因三角函数尾数错位。
//   短舱风扇是带安装角与扭转的真叶片（正面投影相邻叶片略有搭接，看不到辐条缝），有手性、不关于 xz 面对称，所以短舱
//   不声明对称面，改给镜像钩子（mirror 翻转 fanHand 旋向）：翼下短舱随机翼复制、尾吊短舱自带镜像都走 hook 档，
//   派生件 = 参数翻转后的逐位镜像（与机翼 side 钩子同一套数学）。螺旋桨桨叶带扭转、不声明对称面。
// ★ 缺省参数一律示意值（source:'illustrative'，取整数量级，口径进悬停 title）；只有卫通罩 GAT-5530 预设带出处（厂家数据表）。
//   内置目录不带相关型号（用户 2026-09-24 定），这里的缺省与预设都不指向那些型号。
//
// 导出：
//   AIR_COMPONENTS     组件定义（登记顺序即组件库卡片顺序）
//   AERO_RADOMES       机载卫通罩预设表（型号 → {L, W, H, sweptD, sweptH, source}；米）；GAT5530_URL
//   getFuselageSockets(p) → air.fuselage 的插座（p 可为未补缺省的原始参数）——模板数据派生垂尾高 / V 尾展长用
//   propReach(p)       → air.prop 沿 −X 的最大外伸（米；与 build 同一几何，逐顶点取最小 x）——无人机全机长 = 机身长 + 它

import { add, sub, scl, cross, len, nrm, reject, madd, clampN, z0, MB, box, comp, createCtx } from '../meshKit.mjs'
import {
  num, int, bool, enm, auto, D2R, sock, standSocket, hangSocket, latSocket, latMount,
  grid, cap, prism, mirrorY, orientTo, superRing, loft, roundRect, liftSurface,
  solidCompItems, shellMass, apLocal, put, putFramed, stage, datumAp, matOr, smooth01, mirrorCopyY, scaleMass
} from './shapeKit.mjs'
import { STAGE, gimbalFrame, azStage } from './ground.mjs'

// ───────────────────────────── 常量 / 预设 ─────────────────────────────

/** Viasat GAT-5530 数据表（罩 235 × 107 × 32 cm；天线扫掠体积 Ø99.7 × 28.7 cm）。 */
export const GAT5530_URL = 'https://www.viasat.com/content/dam/us-site/aviation/documents/815557_Global_Aero_Terminal_5530_Datasheet_005_web.pdf'
/** 机载卫通罩预设（米；厂家数据表逐字换算 cm × 0.01）。 */
export const AERO_RADOMES = Object.freeze({
  gat5530: Object.freeze({ L: 2.35, W: 1.07, H: 0.32, sweptD: 0.997, sweptH: 0.287, source: GAT5530_URL })
})

const WING_PAINT = matOr('paint_grey', 'white_paint')   // 机翼灰漆（材质键补上后自动升级）；无人机机身 / 光电球同用
const ACC = (...t) => Object.freeze([...t, 'prim.'])

// ───────────────────────────── 小工具（本领域私有） ─────────────────────────────

/** 补缺省（与 components/index.fillParams 同口径；这里不 import 注册表，防环）。 */
function fillLocal(def, raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const o = {}
  for (const [k, s] of Object.entries(def.params)) { const v = r[k]; o[k] = v === undefined || (v === null && !s.nullable) ? s.def : v }
  return o
}
/** 实心圆柱惯量（轴沿 x，半径 r、长 l），行主序 9 元。 */
const cylI = (m, r, l) => { const a = m * r * r / 2, b = m * (3 * r * r + l * l) / 12; return [a, 0, 0, 0, b, 0, 0, 0, b] }
const sphI = (m, r) => { const a = 0.4 * m * r * r; return [a, 0, 0, 0, a, 0, 0, 0, a] }

/**
 * 轴线平行 +X 的放样（回转体 / 下半压扁的回转体）：prof = [[x, r, kb?]]（kb = 下半径 / 半径，缺省 1；r = 0 收成极点），
 * 轴线 (y, z) = (0, zA)。out：'out' 径向朝外、'in' 径向朝内（进气道 / 涵道内壁），或常向量 / 函数。极点法向沿轴朝外端。
 */
function axisLoft(mb, prof, zA, seg, out = 'out') {
  const secs = prof.map(([x, r, kb = 1]) => ({ c: [x, 0, zA], ring: superRing(seg, r, r, r * kb, 2) }))
  const radial = (c) => [0, c[1], c[2] - zA]
  const o = out === 'in' ? (c) => scl(radial(c), -1) : out === 'out' ? radial : out
  const g = loft(mb, secs, { out: o })
  prof.forEach(([x, r], i) => {
    if (r !== 0) return
    const nb = prof[i === 0 ? 1 : i - 1], sg = x >= nb[0] ? 1 : -1
    for (let j = 0; j < seg; j++) { const q = 3 * (g.v0 + i * seg + j); mb.n[q] = sg; mb.n[q + 1] = 0; mb.n[q + 2] = 0 }
  })
  return g
}
/** 轴线平行 +X 的平面圆盘（x 处、半径 r、下半径比 kb），法向 ±X。 */
function axisDisc(mb, x, r, zA, seg, nx, kb = 1) {
  const ring = superRing(seg, r, r, r * kb, 2).map(([y, z]) => [x, y, zA + z])
  cap(mb, ring, [nx, 0, 0], [x, 0, zA])
}
/** 平环（轴平行 +X，x 处，内外半径），法向 ±X（两圈同点数，逐位对称）。 */
function axisRing(mb, x, rIn, rOut, zA, seg, nx, kb = 1) {
  const G = [rOut, rIn].map((r) => superRing(seg, r, r, r * kb, 2).map(([y, z]) => [x, y, zA + z]))
  grid(mb, G, { wrap: true, out: [nx, 0, 0] })
}
/** 竖轴圆柱（中心 (cx, 0)、半径 r、z1 → z2，两端封口）；环点取 superRing（关于 xz 面逐位对称）。 */
function cylZ(mb, cx, r, z1, z2, seg = 32) {
  const ring = superRing(seg, r, r, r, 2)
  const sec = (z) => ({ pts: ring.map(([y, zz]) => [cx - zz, y, z]) })
  return loft(mb, [sec(z1), sec(z2)], { out: (c) => [c[0] - cx, c[1], 0], capStart: true, capEnd: true })
}

// ───────────────────────────── 翼型截面（与 shapeKit.liftSurface 同一口径） ─────────────────────────────

/** NACA 四位对称翼型半厚（闭合后缘系数 −0.1036；与 shapeKit 内部同式）。 */
const nacaHalf = (x, t) => 5 * t * (0.2969 * Math.sqrt(x) - 0.1260 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x)
const camberAt = (x, m) => (m ? (x < 0.4 ? m / 0.16 * (0.8 * x - x * x) : m / 0.36 * (0.2 + 0.8 * x - x * x)) : 0)
/** 截面系：展向 s、扭转 tw（度）→ 弦向 ch（前缘 → 后缘）与上表面方向 up（liftSurface 同式）。 */
function secFrame(s, tw) {
  const sn = nrm(s), c0 = nrm(reject([-1, 0, 0], sn)), u0 = cross(c0, sn)
  const th = -(tw || 0) * D2R, ch = add(scl(c0, Math.cos(th)), scl(u0, Math.sin(th)))
  return { ch, up: cross(ch, sn) }
}
/** 站位 st 上弦向 xc 处的下表面点。 */
function lowerAt(st, xc) {
  const f = secFrame(st.s, st.tw), zl = camberAt(xc, st.cam || 0) - nacaHalf(xc, st.tc)
  return add(add(st.le, scl(f.ch, xc * st.c)), scl(f.up, zl * st.c))
}

// ───────────────────────────── air.fuselage 机身 ─────────────────────────────

/**
 * 机头剖面（s = 自机头尖起 / 机头段长）：上 / 下 / 宽三条母线各自 k(s) = (1 − (1 − s)^e)^p，截面中心下垂 droop·b0·(1 − s)²。
 * 上母线比下母线缓（风挡落在约 35° 的斜面上），机头尖约在机身高 37%（客机）处——侧视才像真机头，不是子弹头。
 */
const NOSE = Object.freeze({
  airliner: Object.freeze({ uE: 1.8, uP: 0.75, dE: 2.3, dP: 0.5, wE: 2.1, wP: 0.55, droop: 0.25 }),
  bizjet: Object.freeze({ uE: 1.7, uP: 0.85, dE: 2.0, dP: 0.62, wE: 1.9, wP: 0.62, droop: 0.12 }),
  uav: Object.freeze({ uE: 2.0, uP: 0.5, dE: 2.0, dP: 0.55, wE: 2.0, wP: 0.5, droop: 0.05 })
})
/** 无人机机头上部卫通鼓包（机头段 s ∈ [0,1]，s = 1 处归零与等直段相接）。 */
const uavBump = (s) => 0.45 * (Math.exp(-(((s - 0.55) / 0.25) ** 2)) - Math.exp(-((0.45 / 0.25) ** 2)) * s * s * s)

/** 机身几何：截面函数 sec(x) → {a 半宽, bUp 上半高, bDown 下半高, zc 截面中心 z}。 */
function fusGeom(p) {
  const L = p.lengthM, W = p.widthM, H = auto(p.heightM, 1.05 * W), a0 = W / 2, b0 = H / 2
  const Ln = p.noseFrac * L, Lt = p.tailFrac * L, xN = L / 2 - Ln, xT = -L / 2 + Lt
  const ns = NOSE[p.noseStyle] || NOSE.airliner, uav = p.noseStyle === 'uav', upS = p.tailUpsweep
  const sec = (x) => {
    if (x > xN) {
      const s = clampN((L / 2 - x) / Ln, 0, 1), k = (e, q) => (1 - (1 - s) ** e) ** q
      return { a: a0 * k(ns.wE, ns.wP), bUp: b0 * k(ns.uE, ns.uP) * (uav ? 1 + uavBump(s) : 1), bDown: b0 * k(ns.dE, ns.dP), zc: ns.droop * b0 * (1 - s) ** 2 }
    }
    if (x < xT) {
      const t = clampN((xT - x) / Lt, 0, 1), q = 1 - 0.92 * t ** 1.6
      return { a: a0 * q, bUp: b0 * q, bDown: b0 * q, zc: -upS * b0 * (1 - q) }
    }
    return { a: a0, bUp: b0, bDown: b0, zc: 0 }
  }
  const topZ = (x) => { const s = sec(x); return s.zc - s.bUp }
  const bellyZ = (x) => { const s = sec(x); return s.zc + s.bDown }
  return { L, W, H, a0, b0, Ln, Lt, xN, xT, sec, topZ, bellyZ }
}
/** 机身解析面上的点（θ 自顶 −Z 起向 +Y 转；上下半椭圆，与 superRing(e = 2) 同式）。 */
const fusP = (g, x, th) => { const s = g.sec(x), c = Math.cos(th); return [x, s.a * Math.sin(th), s.zc - (c >= 0 ? s.bUp : s.bDown) * c] }
/** 解析面点 + 外法向 + 周向弧长导数（差分）。 */
function fusFrame(g, x, th) {
  const hx = 1e-4 * g.L, ht = 1e-4
  const P = fusP(g, x, th), Px = sub(fusP(g, x + hx, th), fusP(g, x - hx, th)), Pt = sub(fusP(g, x, th + ht), fusP(g, x, th - ht))
  return { P, n: nrm(cross(Pt, Px)), ds: len(Pt) / (2 * ht) }
}
/** z 高度处的周向角（上半 / 下半椭圆分开解；越界返回 null）。 */
function thetaAtZ(g, x, z) {
  const s = g.sec(x), d = s.zc - z, b = d >= 0 ? s.bUp : s.bDown
  if (!(b > 1e-9)) return null
  const c = d / b
  return Math.abs(c) <= 1 ? Math.acos(c) : null
}
/** 贴皮贴花：以 (x, θ) 为中心、局部轮廓 outline（[[du, dv]]：du 沿 +X 米、dv 沿周向弧长米），沿法向浮起 lift，扇形三角化。 */
function skinDecal(mb, g, x, th, outline, lift) {
  const f = fusFrame(g, x, th)
  if (!(f.ds > 1e-6)) return
  const v0 = mb.vcount, t0 = mb.tcount
  mb.v(madd(f.P, f.n, lift), f.n, 0, 0)
  for (const [du, dv] of outline) { const q = fusFrame(g, x + du, th + dv / f.ds); mb.v(madd(q.P, q.n, lift), q.n, du, dv) }
  for (let j = 0; j < outline.length; j++) mb.t(v0, v0 + 1 + j, v0 + 1 + ((j + 1) % outline.length))
  orientTo(mb, t0, mb.tcount, f.n)
}
/** 贴皮四边片：(x0..x1) × (θ0..θ1) 的点阵（nx × nt 格），浮起 lift。 */
function skinQuad(mb, g, x0, x1, th0, th1, lift, nx = 3, nt = 3) {
  const G = []
  for (let i = 0; i <= nx; i++) {
    const x = x0 + (x1 - x0) * (i / nx), row = []
    for (let j = 0; j <= nt; j++) { const q = fusFrame(g, x, th0 + (th1 - th0) * (j / nt)); row.push(madd(q.P, q.n, lift)) }
    G.push(row)
  }
  grid(mb, G, { out: fusFrame(g, (x0 + x1) / 2, (th0 + th1) / 2).n })
}

/** 贴皮四角片：四角 [s(机头段), θ(度)]（前下 → 后下 → 后上 → 前上，任意一致顺序），(x, θ) 双线性插值成 nu × nv 格，浮起 lift。 */
function skinQuad4(mb, g, corners, lift, nu = 6, nv = 6) {
  const c = corners.map(([s, t]) => [g.L / 2 - s * g.Ln, t * D2R])
  const at = (u, v) => [0, 1].map((k) => (1 - u) * (1 - v) * c[0][k] + u * (1 - v) * c[1][k] + u * v * c[2][k] + (1 - u) * v * c[3][k])
  const G = []
  for (let i = 0; i <= nu; i++) {
    const row = []
    for (let j = 0; j <= nv; j++) { const [x, th] = at(i / nu, j / nv), q = fusFrame(g, x, th); row.push(madd(q.P, q.n, lift)) }
    G.push(row)
  }
  const [xm, tm] = at(0.5, 0.5)
  grid(mb, G, { out: fusFrame(g, xm, tm).n })
}
/** 风挡（右侧；左侧镜像复制）：每块四角 [s, θ°]——前风挡贴中线立柱、侧窗上缘向后微降。 */
const WINDSHIELD = Object.freeze({
  airliner: Object.freeze([
    [[0.33, 3], [0.49, 3], [0.53, 45], [0.40, 61]],
    [[0.435, 65], [0.605, 72], [0.59, 50.5], [0.555, 47.5]],
    [[0.63, 72.5], [0.765, 73], [0.75, 53.5], [0.615, 51]]
  ]),
  bizjet: Object.freeze([
    [[0.36, 3], [0.55, 3], [0.595, 45], [0.44, 54]],
    [[0.625, 75], [0.79, 76], [0.775, 52], [0.615, 49]]
  ]),
  uav: Object.freeze([])
})

/**
 * 等直段的可贴面：截面是椭圆（半宽 a0、半高 b0），装配的柱面只认圆，所以按顶 / 底 / 右 / 左四个顶点各取一段
 * 密切圆弧（顶底曲率半径 a0²/b0、两侧 b0²/a0，圆心相应偏离机身轴），弧长截到「圆弧沿法向离椭圆 ≤ 容差」为止（最多 ±90°）。
 * a0 = b0（正圆机身）时四段都是同心整圆的一部分、处处贴合。容差 = min(1 cm, 0.4 % × (a0 + b0))。
 */
function fuselageFaces(g) {
  const a0 = g.a0, b0 = g.b0, xm = (g.xN + g.xT) / 2, halfU = (g.xN - g.xT) / 2, tol = Math.min(0.01, 0.004 * (a0 + b0))
  // 截面平面内（e 沿顶点方向的半轴 A，w 沿另一半轴 Bw）：圆心在 e·(A − ρ)，ρ = Bw²/A；圆上点沿法向到椭圆的距离
  const arc = (A, Bw) => {
    const rho = (Bw * Bw) / A, c = A - rho
    const gap = (phi) => {
      const pe = c + rho * Math.cos(phi), pw = rho * Math.sin(phi), ne = Math.cos(phi), nw = Math.sin(phi)
      // (pe + s·ne)²/A² + (pw + s·nw)²/Bw² = 1 取离 0 最近的根
      const qa = (ne * ne) / (A * A) + (nw * nw) / (Bw * Bw), qb = 2 * ((pe * ne) / (A * A) + (pw * nw) / (Bw * Bw)), qc = (pe * pe) / (A * A) + (pw * pw) / (Bw * Bw) - 1
      const disc = Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc)), s1 = (-qb + disc) / (2 * qa), s2 = (-qb - disc) / (2 * qa)
      return Math.abs(s1) < Math.abs(s2) ? s1 : s2
    }
    let phi = 0
    const step = Math.PI / 360
    while (phi + step <= Math.PI / 2 + 1e-12 && Math.abs(gap(phi + step)) <= tol) phi += step
    return { rho, c, halfV: Math.max(step, phi) * rho }
  }
  const top = arc(b0, a0), side = arc(a0, b0)
  // 圆心 = 机身轴 + ref·c（c = A − ρ）：u1 = 0 处的面点 = ref·(c + ρ) = ref·A，恰是椭圆顶点
  const face = (id, ref, a) => ({ id, kind: 'cyl', origin: [z0(xm), z0(ref[1] * a.c), z0(ref[2] * a.c)], axis: [1, 0, 0], ref, radius: a.rho, halfU, halfV: a.halfV })
  return [face('skin', [0, 0, -1], top), face('belly', [0, 0, 1], top), face('sideR', [0, 1, 0], side), face('sideL', [0, -1, 0], side)]
}

/** 舱门位置与尺寸（按机身尺度推；右侧）。 */
function fusDoors(g, p) {
  if (!p.doors || p.noseStyle === 'uav') return []
  const biz = p.noseStyle === 'bizjet', sc = biz ? clampN(g.W / 2.8, 0.7, 1.2) : clampN(g.W / 3.95, 0.6, 1.2)
  const w = (biz ? 0.9 : 0.85) * sc, h = (biz ? 1.6 : 1.85) * sc, zf = (biz ? 0.42 : 0.35) * g.b0
  const x1 = g.xN - (biz ? 0.55 : 1.1) * sc, x2 = g.xT - 0.3 * g.Lt
  const xs = biz ? [x1] : g.L > 50 ? [x1, x1 - 0.22 * (x1 - x2), x1 - 0.62 * (x1 - x2), x2] : [x1, x2]
  return xs.map((x) => ({ x, w, h, zf }))
}

const fuselage = {
  type: 'air.fuselage', domain: ['aircraft'], title: 'Fuselage', titleZh: '机身', role: 'bus', massSink: 'fuselage',
  params: {
    lengthM: num(38, 'm', '机身长', { gt: 2, max: 100, title: '机头尖到尾锥端；模板取全机长' }),
    widthM: num(3.9, 'm', '机身宽', { gt: 0.3, max: 10, title: '等直段外廓宽' }),
    heightM: num(null, 'm', '机身高', { nullable: true, gt: 0.3, max: 12, title: '等直段外廓高；留空 = 宽 × 1.05' }),
    noseStyle: enm('airliner', ['airliner', 'bizjet', 'uav'], '机头', { title: 'airliner = 钝圆机头 + 风挡；bizjet = 尖机头；uav = 机头上部卫通鼓包、无舷窗' }),
    noseFrac: num(0.1, '', '机头段', { min: 0.04, max: 0.3, title: '机头段长 / 机身长' }),
    tailFrac: num(0.27, '', '尾锥段', { min: 0.1, max: 0.45, title: '尾锥段长 / 机身长' }),
    tailUpsweep: num(0.85, '', '尾部上翘', { min: 0, max: 1, title: '1 = 顶线平直、收缩全在机腹；0 = 上下对称收缩' }),
    windows: bool(true, '舷窗'),
    windowPitchM: num(0.53, 'm', '舷窗间距', { min: 0.3, max: 1.5 }),
    doors: bool(true, '舱门线'),
    fairing: bool(true, '翼身整流罩'),
    wingXFrac: num(0.36, '', '翼根位置', { min: 0.1, max: 0.8, title: '翼根前缘（中线处）距机头 / 机身长' }),
    wingZFrac: num(0.3, '', '机翼高低', { min: -0.9, max: 0.9, title: '翼根相对机身轴 / 半机身高；正 = 下单翼' }),
    htailXFrac: num(0.85, '', '平尾位置', { min: 0.5, max: 1, title: '平尾根前缘距机头 / 机身长' }),
    vtailXFrac: num(0.78, '', '垂尾位置', { min: 0.5, max: 1, title: '垂尾根前缘距机头 / 机身长' }),
    crownXFrac: num(0.45, '', '背部天线位置', { min: 0.1, max: 0.9, title: '背部插座距机头 / 机身长' }),
    aftEngXFrac: num(0.78, '', '尾吊发动机位置', { min: 0.5, max: 0.95, title: '尾吊短舱插座距机头 / 机身长' }),
    aftEngZFrac: num(-0.2, '', '尾吊发动机高低', { min: -1, max: 1, title: '相对该截面中心 / 半高；正 = 下' }),
    arealKgM2: num(40, 'kg/m²', '结构面密度', { gt: 0, max: 500, title: '蒙皮 + 框桁 + 系统按表面积折算' }),
    massKg: num(null, 'kg', '机身质量', { nullable: true, gt: 0, title: '留空按面密度；装配件给目标质量时由它吃余量' }),
    seg: int(48, '周向分段', { min: 16, max: 128 })
  },
  validate: (p) => (p.noseFrac + p.tailFrac < 0.9 ? [] : ['机头段与尾锥段过长']),
  sockets: (p) => {
    const g = fusGeom(p), L = g.L
    const xv = L / 2 - p.vtailXFrac * L, xh = L / 2 - p.htailXFrac * L, xe = L / 2 - p.aftEngXFrac * L, xc = L / 2 - p.crownXFrac * L, xk = L / 2 - 0.12 * L
    const se = g.sec(xe), ze = se.zc + p.aftEngZFrac * (p.aftEngZFrac < 0 ? se.bUp : se.bDown)
    const te = thetaAtZ(g, xe, ze), ye = te === null ? 0 : 0.98 * se.a * Math.sin(te)
    const sz = Math.max(0.2, 0.25 * g.W)
    return [
      sock('root', [0, 0, g.bellyZ(0)], [0, 0, 1], [1, 0, 0], sz, 90),
      latSocket('wing', [L / 2 - p.wingXFrac * L, 0, p.wingZFrac * g.b0], sz, ACC('air.wing')),
      latSocket('htail', [xh, 0, g.sec(xh).zc], sz, ACC('air.htail')),
      sock('vtail', [xv, 0, g.topZ(xv)], [0, 0, -1], [1, 0, 0], sz, 90, ACC('air.vtail')),
      sock('ventral', [xv, 0, g.bellyZ(xv)], [0, 0, 1], [1, 0, 0], sz, 90, ACC('air.vtail')),
      latSocket('aftEng', [xe, ye, ze], sz, ACC('air.nacelle')),
      sock('tail', [-L / 2, 0, g.sec(-L / 2).zc], [-1, 0, 0], [0, 0, -1], Math.max(0.1, 0.1 * g.W), 90, ACC('air.prop')),
      sock('crown', [xc, 0, g.topZ(xc)], [0, 0, -1], [1, 0, 0], sz, 90, ACC('air.radome', 'veh.cotm')),
      sock('chin', [xk, 0, g.bellyZ(xk)], [0, 0, 1], [1, 0, 0], sz, 90, ACC('air.turret'))
    ]
  },
  faces: (p) => fuselageFaces(fusGeom(p)),
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = fusGeom(p), seg = p.seg
    const part = { id: 'fuselage', name: '机身', role: 'bus' }
    // —— 蒙皮：机头 18 站（余弦加密到机头尖，尖端收成极点）+ 等直段 3 站 + 尾锥 14 站
    const xs = []
    for (let i = 0; i < 18; i++) { const s = i === 17 ? 1 : 1 - Math.cos((Math.PI / 2) * (i / 17)); xs.push(g.L / 2 - s * g.Ln) }
    for (const f of [0.25, 0.5, 0.75]) xs.push(g.xN - f * (g.xN - g.xT))
    for (let j = 0; j < 14; j++) xs.push(g.xT - (j / 13) ** 0.9 * g.Lt)
    const skin = new MB()
    const lf = loft(skin, xs.map((x) => { const s = g.sec(x); return { c: [x, 0, s.zc], ring: superRing(seg, s.a, s.bUp, s.bDown, 2) } }))
    for (let j = 0; j < seg; j++) { const q = 3 * (lf.v0 + j); skin.n[q] = 1; skin.n[q + 1] = 0; skin.n[q + 2] = 0 }   // 机头尖极点法向 +X
    const skinIt = put(ctx, 'skin', 'bus', part, p.noseStyle === 'uav' ? WING_PAINT : 'white_paint', skin)
    // 尾端 APU 排气口封口（深色）
    const cm = new MB(), last = lf.G[lf.G.length - 1], xe = xs[xs.length - 1]
    cap(cm, last, [-1, 0, 0], [xe, 0, g.sec(xe).zc])
    const capIt = put(ctx, 'tailcap', 'bus', part, 'dark_metal', cm)
    // —— 风挡 / 舷窗 / 舱门线（右侧造好后整体镜像复制）
    const wm = new MB(), dm = new MB(), lift = 0.004 + 0.0005 * g.W
    for (const q of WINDSHIELD[p.noseStyle] || []) skinQuad4(wm, g, q, 1.5 * lift)
    const doors = fusDoors(g, p)
    if (p.windows && p.noseStyle !== 'uav') {
      const biz = p.noseStyle === 'bizjet', sc = biz ? clampN(g.W / 2.8, 0.7, 1.2) : clampN(g.W / 3.95, 0.6, 1.2)
      const hw = (biz ? 0.26 : 0.115) * sc, hh = (biz ? 0.19 : 0.165) * sc, zw = (biz ? -0.08 : -0.2) * g.b0
      const outline = roundRect(hw, hh, Math.min(hw, hh) * (biz ? 0.95 : 0.6), 3)
      const xa = doors.length ? doors[0].x - doors[0].w / 2 - 0.6 * sc : g.xN - 0.6 * sc
      const xb = biz ? g.xT - 0.15 * g.Lt : (doors.length > 1 ? doors[doors.length - 1].x + doors[doors.length - 1].w / 2 + 0.6 * sc : g.xT - 0.3 * g.Lt)
      for (let x = xa; x >= xb; x -= p.windowPitchM) {
        if (doors.some((d) => Math.abs(x - d.x) < d.w / 2 + hw + 0.25 * sc)) continue
        const th = thetaAtZ(g, x, zw)
        if (th === null || th < 0.35 || th > 2.8) continue
        skinDecal(wm, g, x, th, outline, lift)
      }
    }
    for (const d of doors) {
      const tTop = thetaAtZ(g, d.x, d.zf - d.h), tBot = thetaAtZ(g, d.x, d.zf)
      if (tTop === null || tBot === null || !(tBot > tTop)) continue
      // 门框四条细条：竖边沿周向分 8 格贴皮（长条不能只取四角，弦会切进机身）
      const f = fusFrame(g, d.x, (tTop + tBot) / 2), lw = 0.018 + 0.004 * g.W, dt = lw / f.ds
      for (const sx of [1, -1]) skinQuad(dm, g, d.x + sx * d.w / 2 - lw, d.x + sx * d.w / 2 + lw, tTop - dt, tBot + dt, lift, 1, 8)
      for (const th of [tTop, tBot]) skinQuad(dm, g, d.x - d.w / 2 - lw, d.x + d.w / 2 + lw, th - dt, th + dt, lift, 2, 1)
    }
    mirrorCopyY(wm, 0, 0); mirrorCopyY(dm, 0, 0)
    put(ctx, 'windows', 'other', part, 'dark_metal', wm)
    put(ctx, 'doors', 'other', part, 'dark_metal', dm)
    // —— 翼身整流罩（机腹下扁长放样，逐位对称）：纵向轮廓两端平滑收拢 f = √(s(u/0.3)·s((1 − u)/0.3))（s = smooth01），
    //    前端贴着机腹渐出、不是钝鼓包；32 个截面、两端余弦加密；半宽 = 机身半宽，截面中心在机身轴下 0.35·b0
    if (p.fairing) {
      const fm = new MB(), xw = g.L / 2 - p.wingXFrac * g.L, f0 = xw + 0.06 * g.L, f1 = xw - 0.21 * g.L, n = 32, secs = []
      for (let i = 0; i <= n; i++) {
        const u = 0.5 * (1 - Math.cos((Math.PI * i) / n)), f = i === 0 || i === n ? 0 : Math.sqrt(smooth01(u / 0.3) * smooth01((1 - u) / 0.3))
        secs.push({ c: [f0 - u * (f0 - f1), 0, 0.35 * g.b0], ring: superRing(24, 0.5 * g.W * f, 0.4 * g.b0 * f, (0.55 * g.b0 + 0.12 * g.H) * f, 2) })
      }
      loft(fm, secs)
      put(ctx, 'fairing', 'other', { id: 'fairing', name: '翼身整流罩', role: 'other' }, 'white_paint', fm)
    }
    // —— 质量：蒙皮按面密度；给了总量就按闭合体积分布
    if (p.massKg !== null && p.massKg > 0) solidCompItems(ctx, 'fuselage', [skinIt, capIt], 1, p.massKg)
    else shellMass(ctx, 'fuselage', skinIt, p.arealKgM2)
    datumAp(ctx)
    return ctx
  }
}

/** air.fuselage 的插座（p 可为未补缺省的原始参数）。 */
export const getFuselageSockets = (p) => fuselage.sockets(fillLocal(fuselage, p))

// ───────────────────────────── air.wing 单侧机翼 ─────────────────────────────

/** 机翼平面形与翼梢几何（右翼，y ≥ 0；左翼由整体镜像得到）。 */
function wingGeom(p) {
  const span = p.spanM, b = span / 2, cR = auto(p.rootChordM, 0.2 * span), cT = p.taper * cR
  const G = p.dihedralDeg * D2R, tG = Math.tan(G)
  const wl = p.winglet, Hw = wl === 'blended' || wl === 'sharklet' ? auto(p.wingletHM, 0.065 * span) : 0
  const phE = (90 - p.wingletCantDeg) * D2R
  let Rt = 0, ls = 0, E = 0
  if (Hw > 0) {
    // 小翼前缘路径（y-上 平面）：自翼尖以角 Γ 起、半径 Rt 的过渡弧转到 φE = 90° − 外倾，再直段 ls；总升高 = Hw
    Rt = (wl === 'blended' ? 0.35 : 0.15) * Hw
    ls = Math.max(0, (Hw - Rt * (Math.cos(G) - Math.cos(phE))) / Math.sin(phE))
    E = Rt * (Math.sin(phE) - Math.sin(G)) + ls * Math.cos(phE)
  }
  const rake = wl === 'raked' ? 0.06 * b : 0
  const yTip = b - E - rake                       // 保证两翼尖（含翼梢）间距 = 翼展
  const yR = auto(p.rootYM, 0.055 * span)
  const yK = Math.min(p.kinkFrac * b, 0.95 * yTip), dY = yTip - yK
  // 外段 1/4 弦后掠 Λ 反推前缘后掠：tanΛ = T + 0.25(cT − cK)/ΔY，cK = cR − yK·T（内段前缘延续、后缘平直）
  const tq = Math.tan(p.sweepDeg * D2R)
  const T = dY > 1e-9 ? (tq - 0.25 * (cT - cR) / dY) / (1 + 0.25 * yK / dY) : tq
  const cK = cR - yK * T
  const xLE = (y) => -y * T
  const chord = (y) => (y <= yK ? cR - y * T : cK + (cT - cK) * (y - yK) / dY)
  const tcAt = (y) => p.tcRoot + (p.tcTip - p.tcRoot) * clampN(y / yTip, 0, 1)
  const twAt = (y) => p.twistDeg * clampN(y / yTip, 0, 1)
  const sW = [0, Math.cos(G), -Math.sin(G)]
  const st = (y) => ({ le: [xLE(y), y, -y * tG], c: chord(y), tc: tcAt(y), s: sW, tw: twAt(y), cam: 0.02 })
  return { span, b, cR, cT, G, tG, Hw, phE, Rt, ls, E, rake, yTip, yR, yK, dY, T, cK, xLE, chord, tcAt, twAt, sW, st }
}
/** 右翼全部站位（主翼 + 翼梢）。 */
function wingStations(g, p) {
  const ys = [0, g.yR, g.yK]
  const y0 = Math.max(g.yR, g.yK)
  for (const f of [0.25, 0.5, 0.75]) ys.push(y0 + f * (g.yTip - y0))
  ys.push(g.yTip)
  const u = [...new Set(ys.filter((y) => y >= 0 && y <= g.yTip))].sort((a, b) => a - b)
  const list = []
  for (const y of u) if (!list.length || y - list[list.length - 1] > 1e-6 * g.b) list.push(y)
  if (list[list.length - 1] !== g.yTip) list[list.length - 1] = g.yTip
  const S = list.map((y) => g.st(y))
  const tip = g.st(g.yTip)
  if (g.Hw > 0) {
    const S0 = g.Rt * (g.phE - g.G) + g.ls, tLE = Math.tan(40 * D2R), cEnd = (p.winglet === 'blended' ? 0.35 : 0.45) * g.cT
    const angs = (p.winglet === 'blended' ? [20, 45, 70] : [40]).map((d) => d * D2R).filter((a) => a > g.G + 0.03 && a < g.phE - 0.03)
    angs.push(g.phE)
    const at = (sp, a, dy, up) => ({ le: add(tip.le, [-tLE * sp, dy, -up]), c: g.cT + (cEnd - g.cT) * (S0 > 0 ? sp / S0 : 1), tc: 0.9 * p.tcTip, s: [0, Math.cos(a), -Math.sin(a)], tw: p.twistDeg, cam: 0.01 })
    for (const a of angs) S.push(at(g.Rt * (a - g.G), a, g.Rt * (Math.sin(a) - Math.sin(g.G)), g.Rt * (Math.cos(g.G) - Math.cos(a))))
    if (g.ls > 1e-9) {
      const dy = g.Rt * (Math.sin(g.phE) - Math.sin(g.G)) + g.ls * Math.cos(g.phE), up = g.Rt * (Math.cos(g.G) - Math.cos(g.phE)) + g.ls * Math.sin(g.phE)
      S.push(at(S0, g.phE, dy, up))
    }
  } else if (g.rake > 0) {
    const tR = Math.tan(Math.min(80 * D2R, Math.atan(g.T) + 25 * D2R))
    for (const f of [0.4, 0.75, 1]) {
      const y = g.yTip + f * g.rake
      S.push({ le: [tip.le[0] - f * g.rake * tR, y, -y * g.tG], c: g.cT * (1 - 0.85 * f ** 0.9), tc: p.tcTip, s: g.sW, tw: p.twistDeg, cam: 0.02 })
    }
  }
  return S
}
/** 平面投影面积（单侧，含机身内部分；主翼段按弦长折线积分）。 */
function wingArea(g) {
  const ys = [0, g.yK, g.yTip]
  let A = 0
  for (let i = 0; i < ys.length - 1; i++) A += (ys[i + 1] - ys[i]) * (g.chord(ys[i]) + g.chord(ys[i + 1])) / 2
  return A
}

const wing = {
  type: 'air.wing', domain: ['aircraft'], title: 'Wing', titleZh: '机翼', role: 'other',
  params: {
    side: enm('right', ['right', 'left'], '侧别', { title: '左翼由镜像生成' }),
    spanM: num(36, 'm', '翼展', { gt: 1, max: 100, title: '两翼尖间距（含翼梢小翼）；本件造单侧' }),
    rootChordM: num(null, 'm', '翼根弦长', { nullable: true, gt: 0, title: '机身中线处；留空 = 0.2 × 翼展' }),
    taper: num(0.24, '', '梢根比', { min: 0.05, max: 1 }),
    sweepDeg: num(25, '°', '后掠角', { min: -10, max: 60, title: '外段 1/4 弦线' }),
    dihedralDeg: num(5, '°', '上反角', { min: -15, max: 20 }),
    kinkFrac: num(0.35, '', '后缘转折', { min: 0, max: 0.7, title: '内段后缘平直的展向位置 / 半展；0 = 无转折' }),
    tcRoot: num(0.15, '', '翼根相对厚度', { min: 0.04, max: 0.25 }),
    tcTip: num(0.1, '', '翼尖相对厚度', { min: 0.04, max: 0.25 }),
    twistDeg: num(-3, '°', '梢部扭转', { min: -10, max: 5, title: '负 = 前缘下扭（自翼根 0 线性变到翼尖）' }),
    winglet: enm('blended', ['none', 'sharklet', 'blended', 'raked'], '翼梢', { title: 'sharklet = 小半径转折的鲨鳍小翼；blended = 大半径融合式小翼；raked = 斜削翼梢（无竖直段）' }),
    wingletHM: num(null, 'm', '小翼高', { nullable: true, gt: 0, max: 10, title: '翼尖到小翼顶的竖直高度；留空 = 0.065 × 翼展' }),
    wingletCantDeg: num(15, '°', '小翼外倾', { min: 0, max: 60, title: '偏离竖直' }),
    rootYM: num(null, 'm', '翼根外露', { nullable: true, min: 0, title: '机身半宽处的翼根站位；留空 = 0.055 × 翼展' }),
    engines: int(1, '每侧发动机挂点', { options: [0, 1, 2] }),
    engYFrac: num(0.32, '', '发动机展向位置', { min: 0.1, max: 0.9, title: '内侧挂点 / 半展' }),
    eng2YFrac: num(0.62, '', '外侧发动机位置', { min: 0.1, max: 0.95, title: '外侧挂点 / 半展（每侧 2 台时）' }),
    flapTracks: int(3, '襟翼滑轨整流罩', { min: 0, max: 8 }),
    arealKgM2: num(60, 'kg/m²', '结构面密度', { gt: 0, max: 600, title: '按平面投影面积折算' }),
    massKg: num(null, 'kg', '机翼质量', { nullable: true, gt: 0, title: '单侧；留空按面密度' })
  },
  validate: (p) => {
    const g = wingGeom(p), e = []
    if (p.engines === 2 && !(p.engYFrac < p.eng2YFrac)) e.push('发动机展向位置顺序不对')
    if (g.Hw >= 0.3 * g.b) e.push('小翼过高')
    if (!(g.cK > 0.05 * g.cR)) e.push('转折处弦长过小')
    if (!(g.yR < 0.9 * g.yTip)) e.push('翼根外露过大')
    if (p.engines >= 1 && !(Math.max(p.engYFrac, p.engines === 2 ? p.eng2YFrac : 0) * g.b < 0.95 * g.yTip)) e.push('发动机展向位置超出翼尖')
    return e
  },
  sockets: (p) => {
    const g = wingGeom(p), sg = p.side === 'left' ? -1 : 1
    const out = [latMount(Math.max(0.05, 0.3 * g.cR))]
    const eys = p.engines >= 1 ? [p.engYFrac * g.b, ...(p.engines === 2 ? [p.eng2YFrac * g.b] : [])] : []
    eys.forEach((y, i) => {
      const s = g.st(y), q = lowerAt(s, 0.12)
      out.push(sock(`eng${i + 1}`, [q[0], sg * q[1], q[2]], [0, 0, 1], [1, 0, 0], Math.max(0.1, 0.2 * s.c), 90, ACC('air.nacelle')))
    })
    const t = g.st(g.yTip), tc = add(t.le, scl(secFrame(t.s, t.tw).ch, 0.5 * t.c))
    out.push(sock('tip', [tc[0], sg * tc[1], tc[2]], [0, sg, 0], [1, 0, 0], Math.max(0.05, 0.3 * t.c), 90, ACC()))
    return out
  },
  mirror: (p, plane) => (plane === 'xz' ? { ...p, side: p.side === 'right' ? 'left' : 'right' } : { ...p }),
  mirrorPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = wingGeom(p)
    const part = { id: 'wing', name: '机翼', role: 'other' }
    const wm = new MB()
    liftSurface(wm, wingStations(g, p), 16)
    // 襟翼滑轨整流罩：后缘下方的独木舟形小放样体（长 0.45c、伸出后缘 0.25c、下探 0.1c）
    const fm = new MB(), nT = p.flapTracks, ya = g.yR + 0.1 * g.b, yb = Math.min(0.75 * g.b, 0.92 * g.yTip)
    if (nT > 0 && yb > ya) {
      for (let k = 0; k < nT; k++) {
        const y = nT === 1 ? (ya + yb) / 2 : ya + (yb - ya) * (k / (nT - 1)), s = g.st(y), f = secFrame(s.s, s.tw)
        const te = add(s.le, scl(f.ch, s.c)), c = s.c, secs = []
        for (let i = 0; i <= 10; i++) {
          const u = i / 10, hh = i === 0 || i === 10 ? 0 : Math.sin(Math.PI * u ** 0.75) ** 0.8, ww = i === 0 || i === 10 ? 0 : Math.sin(Math.PI * u ** 0.7) ** 0.5
          secs.push({ c: [te[0] + (0.2 - 0.45 * u) * c, y, te[2] + 0.01 * c], ring: superRing(10, 0.04 * c * ww, 0.03 * c * hh, 0.1 * c * hh, 2) })
        }
        loft(fm, secs)
      }
    }
    if (p.side === 'left') { mirrorY(wm, 0, 0); if (fm.vcount) mirrorY(fm, 0, 0) }
    const it = put(ctx, 'wing', 'other', part, WING_PAINT, wm)
    put(ctx, 'flaptracks', 'other', part, 'white_paint', fm)
    solidCompItems(ctx, 'wing', [it], 1, p.massKg !== null && p.massKg > 0 ? p.massKg : p.arealKgM2 * wingArea(g))
    return ctx
  }
}

// ───────────────────────────── air.htail 平尾 / V 尾 ─────────────────────────────

/** 无转折梯形翼面（右半）站位：根 / 中 / 梢（dihedral 按剪切 z = −y·tanΓ，两尖间距 = span）。 */
function tailStations(p, cR) {
  const b = p.spanM / 2, cT = p.taper * cR, G = p.dihedralDeg * D2R, tG = Math.tan(G), s = [0, Math.cos(G), -Math.sin(G)]
  const T = Math.tan(p.sweepDeg * D2R) - 0.25 * (cT - cR) / b
  return [0, 0.5, 1].map((f) => { const y = f * b; return { le: [-y * T, y, -y * tG], c: cR + (cT - cR) * f, tc: p.tcRoot + (p.tcTip - p.tcRoot) * f, s, tw: 0, cam: 0 } })
}

const htail = {
  type: 'air.htail', domain: ['aircraft'], title: 'Horizontal tail', titleZh: '平尾', role: 'other',
  params: {
    spanM: num(12.5, 'm', '展长', { gt: 0.3, max: 40, title: '两尖间距' }),
    rootChordM: num(null, 'm', '根弦长', { nullable: true, gt: 0, title: '中线处；留空 = 0.28 × 展长' }),
    taper: num(0.3, '', '梢根比', { min: 0.05, max: 1 }),
    sweepDeg: num(29, '°', '后掠角', { min: -10, max: 60, title: '1/4 弦线' }),
    dihedralDeg: num(6, '°', '上反角', { min: -15, max: 60, title: 'V 尾填 30–50' }),
    tcRoot: num(0.11, '', '根部相对厚度', { min: 0.04, max: 0.25 }),
    tcTip: num(0.09, '', '梢部相对厚度', { min: 0.04, max: 0.25 }),
    arealKgM2: num(30, 'kg/m²', '结构面密度', { gt: 0, max: 600, title: '按平面投影面积折算' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '两侧合计；留空按面密度' })
  },
  sockets: (p) => [latMount(Math.max(0.05, 0.3 * auto(p.rootChordM, 0.28 * p.spanM)))],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), cR = auto(p.rootChordM, 0.28 * p.spanM)
    const m = new MB()
    liftSurface(m, tailStations(p, cR), 14)
    mirrorCopyY(m, 0, 0)
    const it = put(ctx, 'htail', 'other', { id: 'htail', name: '平尾', role: 'other' }, WING_PAINT, m)
    const area = p.spanM * cR * (1 + p.taper) / 2
    solidCompItems(ctx, 'htail', [it], 1, p.massKg !== null && p.massKg > 0 ? p.massKg : p.arealKgM2 * area)
    return ctx
  }
}

// ───────────────────────────── air.vtail 垂尾 / 腹鳍 ─────────────────────────────

function vtailGeom(p) {
  const H = p.heightM, cR = auto(p.rootChordM, 1.0 * H), cT = p.taper * cR
  const T = Math.tan(p.sweepDeg * D2R) - 0.25 * (cT - cR) / H
  const xLE = (h) => -h * T, chord = (h) => cR + (cT - cR) * h / H
  return { H, cR, cT, T, xLE, chord }
}

const vtail = {
  type: 'air.vtail', domain: ['aircraft'], title: 'Vertical tail', titleZh: '垂尾', role: 'other',
  params: {
    heightM: num(6, 'm', '高', { gt: 0.2, max: 25, title: '根部安装面到顶' }),
    rootChordM: num(null, 'm', '根弦长', { nullable: true, gt: 0, title: '留空 = 1.0 × 高' }),
    taper: num(0.35, '', '梢根比', { min: 0.05, max: 1 }),
    sweepDeg: num(35, '°', '后掠角', { min: 0, max: 70, title: '1/4 弦线' }),
    tc: num(0.1, '', '相对厚度', { min: 0.04, max: 0.25 }),
    dorsal: bool(true, '背鳍整流', { title: '根前缘前方的低矮三角整流' }),
    arealKgM2: num(30, 'kg/m²', '结构面密度', { gt: 0, max: 600, title: '按侧面投影面积折算' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空按面密度' })
  },
  // tip = T 尾平尾的横向对齐插座（平尾 latMount 贴它、滚转 0° 同向）；top = 垂尾顶面弦中点（立装件：垂尾顶卫通罩）
  sockets: (p) => {
    const g = vtailGeom(p)
    return [
      standSocket(Math.max(0.05, 0.3 * g.cR), 90),
      latSocket('tip', [g.xLE(g.H) - 0.3 * g.cT, 0, -0.97 * g.H], Math.max(0.05, 0.3 * g.cT), ACC('air.htail')),
      sock('top', [g.xLE(g.H) - 0.5 * g.cT, 0, -g.H], [0, 0, -1], [1, 0, 0], Math.max(0.05, 0.6 * g.cT), 90, ACC('air.radome'))
    ]
  },
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = vtailGeom(p), s = [0, 0, -1]
    const st = []
    if (p.dorsal) {
      const dl = 0.5 * g.cR, hd = 0.12 * g.H
      st.push({ le: [dl, 0, 0], c: g.cR + dl, tc: p.tc * g.cR / (g.cR + dl), s, tw: 0 })
      st.push({ le: [g.xLE(hd), 0, -hd], c: g.chord(hd), tc: p.tc, s, tw: 0 })
    } else st.push({ le: [0, 0, 0], c: g.cR, tc: p.tc, s, tw: 0 })
    for (const f of [0.5, 1]) { const h = f * g.H; st.push({ le: [g.xLE(h), 0, -h], c: g.chord(h), tc: p.tc, s, tw: 0 }) }
    const m = new MB()
    liftSurface(m, st, 14)
    const it = put(ctx, 'vtail', 'other', { id: 'vtail', name: '垂尾', role: 'other' }, WING_PAINT, m)
    solidCompItems(ctx, 'vtail', [it], 1, p.massKg !== null && p.massKg > 0 ? p.massKg : p.arealKgM2 * g.H * (g.cR + g.cT) / 2)
    return ctx
  }
}

// ───────────────────────────── air.nacelle 涡扇短舱 + 挂架 ─────────────────────────────

/** 短舱几何：u = 自唇口起的相对长度 ∈ [0, 1]（x = xf − u·Ln）；半径一律按最大半径 R 的比例。 */
function nacGeom(p) {
  const D = p.diameterM, R = D / 2, Ln = auto(p.lengthM, 1.9 * D), ph = auto(p.pylonHM, 0.35 * D)
  const xf = p.overhangFrac * Ln, zA = ph + R, sep = p.exhaust === 'separate'
  const ue = sep ? 0.66 : 0.9, re = sep ? 0.84 : 0.72, um = 0.28, uf = 0.13
  const X = (u) => xf - u * Ln
  const rOut = (u) => (u <= um ? 0.92 + 0.08 * (1 - (1 - (u - 0.02) / (um - 0.02)) ** 2) : 1 - (1 - re) * ((u - um) / (ue - um)) ** 1.8)
  return { D, R, Ln, ph, xf, xr: xf - Ln, zA, sep, ue, re, um, uf, X, rOut, fr: p.fanFrac }
}

/**
 * 风扇叶排（示意比例）：轮毂半径 rh = 0.3·rF，叶根埋进轮毂、叶尖在 0.97·rF（直弦的梢角到 0.99·rF，不碰风扇面处的进气道内壁）；安装角（弦线离轴向）自叶根 35° 扭到叶尖 60°；
 * 弦长按「正面投影覆盖率 1.08」反推：c(r) = 1.08 × 2πr / (叶片数 × sin ξ(r))，相邻叶片正面略有搭接（宽弦风扇的样子）。
 * 叶排轴向深度 c·cos ξ 超过进气道 60% 时按比例缩弦（短进气道也不伸出唇口）。整流罩：轮毂环长 dh、尖锥长 spL（锥尖在唇口之后）。
 */
function fanLayout(g, nb) {
  const rF = g.fr * g.R, rh = 0.3 * rF, r0 = 0.97 * rh, r1 = 0.97 * rF, room = g.xf - g.X(g.uf)
  let st = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => {
    const r = r0 + (r1 - r0) * t, xi = (35 + 25 * t ** 0.9) * D2R
    return { t, r, xi, c: (1.08 * 2 * Math.PI * r) / (nb * Math.sin(xi)) }
  })
  const dMax = Math.max(...st.map((s) => s.c * Math.cos(s.xi))), k = Math.min(1, (0.6 * room) / dMax)
  if (k < 1) st = st.map((s) => ({ ...s, c: s.c * k }))
  const dh = 0.004 + st[0].c * Math.cos(st[0].xi) + 0.01 * rF
  return { rF, rh, st, dh, spL: Math.max(0.05 * rF, Math.min(0.7 * rF, 0.9 * room - dh)) }
}
/**
 * 扭转叶片（每片沿径向放样 NACA 截面，截面中点落在该叶的径向线上，后缘在风扇盘前 4 mm）。hand = ±1：旋向；
 * 翻转 hand = 扭转角与弧高一起取反 = 关于 xz 面的逐位镜像（叶片方位取 superRing，本身左右逐位对称）。
 */
function fanBlades(mb, fan, xF, zA, nb, hand) {
  for (const [qy, qz] of superRing(nb, 1, 1, 1, 2)) {
    const q = [0, qy, qz]
    liftSurface(mb, fan.st.map((s) => {
      const tw = (hand * s.xi) / D2R, ch = secFrame(q, tw).ch, c = s.c
      const mid = [xF + 0.004 + 0.5 * c * Math.cos(s.xi), qy * s.r, zA + qz * s.r]
      return { le: sub(mid, scl(ch, 0.5 * c)), c, tc: 0.09 - 0.055 * s.t, s: q, tw, cam: hand * 0.03 }
    }), 8)
  }
}

const nacelle = {
  type: 'air.nacelle', domain: ['aircraft'], title: 'Engine nacelle', titleZh: '发动机短舱', role: 'thruster',
  params: {
    diameterM: num(2.2, 'm', '短舱最大径', { gt: 0.2, max: 6 }),
    lengthM: num(null, 'm', '短舱长', { nullable: true, gt: 0, title: '唇口到尾锥尖；留空 = 1.9 × 最大径' }),
    fanFrac: num(0.82, '', '风扇面径比', { min: 0.5, max: 0.95, title: '风扇面径 / 短舱最大径' }),
    flatBottom: bool(false, '扁底进气口', { title: '进气口下缘压扁（低离地翼吊）' }),
    exhaust: enm('separate', ['separate', 'mixed'], '排气', { title: 'separate = 短风扇罩 + 核心机罩与尾锥伸出；mixed = 长罩混合排气' }),
    pylon: bool(true, '挂架'),
    pylonHM: num(null, 'm', '挂架高', { nullable: true, gt: 0, title: '短舱顶到安装点的净距；留空 = 0.35 × 最大径' }),
    overhangFrac: num(0.6, '', '前伸比', { min: 0, max: 1, title: '短舱伸到安装点前方的长度 / 短舱长' }),
    fanBlades: int(18, '风扇叶片数', { min: 12, max: 36, title: '宽弦风扇常见 16–24 片' }),
    fanHand: enm('right', ['right', 'left'], '风扇旋向', { title: '叶片扭向（从进气口看）；镜像复制的另一侧自动取反（几何逐位镜像）' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '含短舱与挂架；留空 = 820 × 最大径²' }),
    seg: int(48, '周向分段', { min: 16, max: 96 })
  },
  sockets: (p) => [hangSocket(Math.max(0.1, 0.4 * p.diameterM), 90)],
  // 风扇叶片有手性：不声明对称面；镜像钩子翻转旋向，其余几何关于 xz 面逐位对称，所以翻转旋向 = 关于 xz 面镜像
  mirror: (p, plane) => (plane === 'xz' ? { ...p, fanHand: p.fanHand === 'left' ? 'right' : 'left' } : { ...p }),
  mirrorPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), g = nacGeom(p), seg = p.seg, R = g.R, zA = g.zA, X = g.X
    const part = { id: 'nacelle', name: '发动机短舱', role: 'thruster' }
    const flat = p.flatBottom
    const kOut = (u) => (flat ? 1 - 0.18 * (1 - smooth01((u - 0.3) / (0.6 - 0.3))) : 1)
    const kIn = (u) => (flat ? 1 - 0.18 * (1 - clampN((u - 0.02) / (g.uf - 0.02), 0, 1)) : 1)
    // 外罩（白漆）
    const om = new MB(), outer = []
    for (let i = 0; i <= 22; i++) { const u = 0.02 + (g.ue - 0.02) * (i / 22) ** 1.5; outer.push([X(u), R * g.rOut(u), kOut(u)]) }
    axisLoft(om, outer, zA, seg, 'out')
    // 唇口（铝，半椭圆绕过前缘）
    const lm = new MB(), lip = []
    for (let i = 0; i <= 8; i++) { const a = Math.PI * (i / 8), u = 0.02 - 0.02 * Math.sin(a); lip.push([X(u), R * (0.885 + 0.035 * Math.cos(a)), flat ? 0.82 : 1]) }
    axisLoft(lm, lip, zA, seg, [1, 0, 0])
    // 进气道内壁（唇口内缘 → 风扇面）+ 外涵道外壁（风扇后 → 喷口内缘）
    const im = new MB(), inl = [], duct = []
    for (let i = 0; i <= 6; i++) { const t = i / 6, u = 0.02 + (g.uf - 0.02) * t; inl.push([X(u), R * (0.85 + (g.fr - 0.85) * smooth01(t)), kIn(u)]) }
    axisLoft(im, inl, zA, seg, 'in')
    for (let i = 0; i <= 8; i++) { const t = i / 8, u = g.uf + 0.01 + (g.ue - g.uf - 0.01) * t; duct.push([X(u), R * (Math.min(g.fr + 0.02, 0.97) + (g.re - 0.025 - Math.min(g.fr + 0.02, 0.97)) * t), kOut(u)]) }
    axisLoft(im, duct, zA, seg, 'in')
    // 风扇：深色盘（前后两面）+ 扭转宽弦叶片 + 轮毂环 + 尖锥整流罩；盘外到外涵道内壁的一圈是风扇机匣（随进气道同材质，
    // 叶尖外那道缝看到的是机匣而不是黑环）
    const fm = new MB(), xF = X(g.uf), rF = g.fr * R
    axisDisc(fm, xF, rF, zA, seg, 1)
    axisDisc(fm, xF - 0.004 * g.Ln, rF, zA, seg, -1)
    axisRing(im, xF, rF, R * Math.min(g.fr + 0.02, 0.97), zA, seg, 1)
    const bm = new MB(), fan = fanLayout(g, p.fanBlades)
    fanBlades(bm, fan, xF, zA, p.fanBlades, p.fanHand === 'left' ? -1 : 1)
    // 轮毂环（叶根所在，半径 rh、长 = 叶根轴向深度）接尖锥整流罩：r = rh·(1 − s)^0.85，锥尖在唇口之后
    const sm = new MB(), spin = [[xF + 0.002, fan.rh], [xF + fan.dh, fan.rh]]
    for (const s of [0.15, 0.3, 0.45, 0.6, 0.72, 0.84, 0.93, 1]) spin.push([xF + fan.dh + s * fan.spL, s === 1 ? 0 : fan.rh * (1 - s) ** 0.85])
    axisLoft(sm, spin, zA, seg, 'out')
    // 喷口后缘环（外罩 → 外涵道内壁）
    const nm = new MB()
    loft(nm, [{ c: [X(g.ue), 0, zA], ring: superRing(seg, R * g.re, R * g.re, R * g.re, 2) }, { c: [X(g.ue), 0, zA], ring: superRing(seg, R * (g.re - 0.025), R * (g.re - 0.025), R * (g.re - 0.025), 2) }], { out: [-1, 0, 0] })
    // 核心机罩 + 尾锥（钛）与核心喷口深色环
    const cm = new MB(), hm = new MB()
    if (g.sep) {
      axisLoft(cm, [[X(g.ue - 0.12), 0.64 * R], [X(g.ue - 0.04), 0.62 * R], [X(g.ue), 0.6 * R], [X(0.76), 0.53 * R], [X(0.86), 0.45 * R], [X(0.86), 0.43 * R]], zA, seg, 'out')
      axisLoft(cm, [[X(0.84), 0.37 * R], [X(0.88), 0.35 * R], [X(0.93), 0.26 * R], [X(0.97), 0.13 * R], [X(1), 0]], zA, seg, 'out')
      axisRing(hm, X(0.86), 0.358 * R, 0.43 * R, zA, seg, -1)
    } else {
      axisLoft(cm, [[X(0.84), 0.45 * R], [X(0.9), 0.4 * R], [X(0.95), 0.25 * R], [X(1), 0]], zA, seg, 'out')
      axisRing(hm, X(g.ue), 0.41 * R, R * (g.re - 0.025), zA, seg, -1)
    }
    // 挂架：对称翼型截面的竖直整流体，自短舱顶后段升到安装点（前缘后掠），顶截面埋进机翼 / 机身
    const pm = new MB()
    if (p.pylon) {
      const zb = zA - 0.7 * R, zt = -Math.max(0.05, 0.3 * g.ph)
      const xb0 = X(0.25), xb1 = X(g.ue - 0.02), xt0 = Math.min(xb0 - (zb - zt), 0.1 * g.Ln), xt1 = X(g.ue) - 0.1 * g.Ln
      const wb = 0.09 * g.D, wt = 0.07 * g.D, s = [0, 0, -1]
      if (xt0 > xt1 && xb0 > xb1) {
        liftSurface(pm, [
          { le: [xb0, 0, zb], c: xb0 - xb1, tc: Math.min(0.3, (2 * wb) / (xb0 - xb1)), s, tw: 0 },
          { le: [xt0, 0, zt], c: xt0 - xt1, tc: Math.min(0.3, (2 * wt) / (xt0 - xt1)), s, tw: 0 }
        ], 10)
      }
    }
    put(ctx, 'cowl', 'thruster', part, 'white_paint', om)
    put(ctx, 'lip', 'thruster', part, 'aluminum', lm)
    put(ctx, 'intake', 'thruster', part, 'titanium', im)
    put(ctx, 'fan', 'thruster', part, 'dark_metal', fm)
    put(ctx, 'blades', 'thruster', part, 'titanium', bm)
    put(ctx, 'spinner', 'thruster', part, 'aluminum', sm)
    put(ctx, 'nozzle', 'thruster', part, 'white_paint', nm)
    put(ctx, 'core', 'thruster', part, 'titanium', cm)
    put(ctx, 'exhaust', 'thruster', part, 'dark_metal', hm)
    put(ctx, 'pylon', 'boom', { id: 'pylon', name: '挂架', role: 'boom' }, 'white_paint', pm)
    const m = p.massKg !== null && p.massKg > 0 ? p.massKg : 820 * g.D * g.D
    comp(ctx, 'nacelle', 'solid', m, [X(0.45), 0, zA], cylI(m, 0.45 * g.D, g.Ln))
    return ctx
  }
}

// ───────────────────────────── air.prop 螺旋桨 ─────────────────────────────

function propGeom(p) {
  const D = p.diameterM, R = D / 2, sd = auto(p.spinnerDM, 0.14 * D), sr = sd / 2, hl = 1.5 * sd
  const P = 2 * Math.PI * 0.75 * R * Math.tan(p.pitchDeg * D2R)          // 几何螺距（0.75R 处桨距角 = pitchDeg）
  return { D, R, sr, hl, P, xb: -0.45 * hl, c0: p.chordFrac * D }
}
const BLADE_ST = Object.freeze([[0, 0.75, 0.3], [0.25, 1.0, 0.2], [0.45, 1.15, 0.12], [0.65, 1.1, 0.09], [0.85, 0.9, 0.07], [0.97, 0.65, 0.06], [1, 0.35, 0.06]])

function buildProp(p, ctx) {
  const g = propGeom(p)
  const part = { id: 'prop', name: '螺旋桨', role: 'thruster' }
  // 整流锥：底在安装面（x = 0），椭圆头朝 −X
  const sm = new MB(), prof = []
  for (const s of [0, 0.3, 0.55, 0.75, 0.88, 0.96, 1]) prof.push([-s * g.hl, s === 1 ? 0 : g.sr * Math.sqrt(1 - s * s)])
  axisLoft(sm, prof, 0, 32, 'out')
  axisDisc(sm, 0, g.sr, 0, 32, 1)
  // 桨叶：在 x = xb 的 y-z 面内径向放样；桨距轴在 0.3 弦；扭转 = 90° − β(r)，β = atan(P / 2πr)
  const bm = new MB(), n = p.blades
  for (let k = 0; k < n; k++) {
    const ph = (2 * Math.PI * k) / n, s = [0, Math.sin(ph), -Math.cos(ph)]
    const st = BLADE_ST.map(([f, cf, tc], i) => {
      const r = i === 0 ? 0.6 * g.sr : Math.max(f * g.R, 0.8 * g.sr + 1e-3 * i * g.R), c = cf * g.c0
      const beta = Math.atan2(g.P, 2 * Math.PI * r) / D2R, tw = 90 - beta, fr = secFrame(s, tw)
      return { le: sub(add([g.xb, 0, 0], scl(s, r)), scl(fr.ch, 0.3 * c)), c, tc, s, tw, cam: 0.03 }
    })
    liftSurface(bm, st, 10)
  }
  put(ctx, 'blades', 'thruster', part, 'dark_metal', bm)
  put(ctx, 'spinner', 'thruster', part, 'white_paint', sm)
  return g
}

const prop = {
  type: 'air.prop', domain: ['aircraft', 'ship'], title: 'Propeller', titleZh: '螺旋桨', role: 'thruster',
  params: {
    diameterM: num(2.7, 'm', '直径', { gt: 0.2, max: 8 }),
    blades: int(3, '桨叶数', { min: 2, max: 8 }),
    spinnerDM: num(null, 'm', '整流锥直径', { nullable: true, gt: 0, title: '留空 = 0.14 × 直径' }),
    chordFrac: num(0.07, '', '桨叶弦长比', { gt: 0.01, max: 0.3, title: '叶根弦长 / 直径' }),
    pitchDeg: num(25, '°', '桨距角', { min: 0, max: 60, title: '0.75 半径处，自旋转面量起' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 25 × 直径²' })
  },
  validate: (p) => (auto(p.spinnerDM, 0.14 * p.diameterM) < 0.6 * p.diameterM ? [] : ['整流锥直径过大']),
  sockets: (p) => [sock('root', [0, 0, 0], [1, 0, 0], [0, 0, -1], Math.max(0.05, auto(p.spinnerDM, 0.14 * p.diameterM)), 90)],
  build(p, kit) {
    const ctx = kit.createCtx(), g = buildProp(p, ctx)
    const m = p.massKg !== null && p.massKg > 0 ? p.massKg : 25 * g.D * g.D
    comp(ctx, 'prop', 'solid', m, [g.xb, 0, 0], [m * g.R * g.R / 6, 0, 0, 0, m * g.R * g.R / 12, 0, 0, 0, m * g.R * g.R / 12])
    ctx.arts.push({ name: 'spin', nodes: ['blades', 'spinner'], stages: [stage('spin', 'xRotate', -180, 180, 0)] })
    return ctx
  }
}

/** air.prop 沿 −X 的最大外伸（米；与 build 同一几何，逐顶点取最小 x 的相反数）。p 可为未补缺省的原始参数。 */
export function propReach(p) {
  const ctx = createCtx({ dens: {} })
  buildProp(fillLocal(prop, p), ctx)
  let mn = 0
  for (const it of ctx.items) for (let i = 0; i < it.mb.p.length; i += 3) if (it.mb.p[i] < mn) mn = it.mb.p[i]
  return -mn
}

// ───────────────────────────── air.radome 机载卫通天线罩 ─────────────────────────────

/** 罩的平面半宽 / 穹顶高沿 ξ（自前端起 / 罩长）的分布：钝圆前端、等剖面中段、泪滴收尖尾段。 */
const rdmW = (xi) => (xi <= 0 || xi >= 1 ? 0 : xi < 0.3 ? (1 - (1 - xi / 0.3) ** 2.5) ** 0.4 : xi <= 0.6 ? 1 : Math.cos((Math.PI / 2) * (xi - 0.6) / 0.4) ** 1.2)
const rdmH = (xi) => (xi <= 0 || xi >= 1 ? 0 : xi < 0.26 ? Math.sqrt(1 - (1 - xi / 0.26) ** 2) : xi <= 0.62 ? 1 : (1 - ((xi - 0.62) / 0.38) ** 1.6) ** 1.5)
const RDM_XI = Object.freeze([0, 0.006, 0.02, 0.045, 0.08, 0.12, 0.18, 0.24, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.94, 0.97, 0.99, 1])
const RDM_XA = 0.4   // 天线转轴在罩长 40% 处（局部原点）

function rdmDims(p) {
  const pr = p.model !== 'custom' ? AERO_RADOMES[p.model] : null
  return pr ? { L: pr.L, W: pr.W, H: pr.H, sD: pr.sweptD, sH: pr.sweptH } : { L: p.lengthM, W: p.widthM, H: p.heightM, sD: p.sweptDM, sH: p.sweptHM }
}

const radome = {
  type: 'air.radome', domain: ['aircraft'], title: 'Satcom radome', titleZh: '机载卫通罩', role: 'other',
  params: {
    model: enm('gat5530', ['gat5530', 'custom'], '型号', { source: GAT5530_URL, title: 'gat5530 = Viasat GAT-5530（罩 235 × 107 × 32 cm，扫掠体积 Ø99.7 × 28.7 cm）；custom = 按下面尺寸' }),
    lengthM: num(2.35, 'm', '长', { gt: 0, max: 10, source: GAT5530_URL, title: '型号 custom 时生效' }),
    widthM: num(1.07, 'm', '宽', { gt: 0, max: 5, source: GAT5530_URL, title: '型号 custom 时生效' }),
    heightM: num(0.32, 'm', '高', { gt: 0, max: 3, source: GAT5530_URL, title: '型号 custom 时生效' }),
    sweptDM: num(0.997, 'm', '天线扫掠径', { gt: 0, max: 5, source: GAT5530_URL, title: '型号 custom 时生效' }),
    sweptHM: num(0.287, 'm', '天线扫掠高', { gt: 0, max: 3, source: GAT5530_URL, title: '型号 custom 时生效' }),
    baseRadiusM: num(null, 'm', '底面曲率半径', { nullable: true, gt: 0, title: '贴机身顶部时 = 机身半高；留空 = 平底' }),
    antenna: bool(true, '内置天线'),
    translucent: bool(false, '半透明'),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 罩壳 12 kg/m² + 天线 40 kg/m²（扫掠面积，示意）' })
  },
  validate: (p) => {
    const d = rdmDims(p), e = []
    if (!(d.sD <= d.W && d.sD <= d.L)) e.push('天线扫掠径大于罩')
    if (!(d.sH < d.H)) e.push('天线扫掠高不小于罩高')
    if (p.baseRadiusM !== null && !(p.baseRadiusM > d.W / 2)) e.push('底面曲率半径小于半宽')
    return e
  },
  sockets: (p) => [standSocket(Math.max(0.1, rdmDims(p).W), 90)],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), d = rdmDims(p), seg = 48, q4 = seg / 4
    const Rb = p.baseRadiusM, baseZ = (y) => (Rb !== null && Rb > Math.abs(y) ? Rb - Math.sqrt(Rb * Rb - y * y) : 0)
    const part = { id: 'radome', name: '机载卫通罩', role: 'other' }
    // 截面：上半 = e = 3 超椭圆穹顶（高度随 ξ），下半 = 底面（平 / 随机身圆柱下弯）；穹顶与底面分网格（硬边）
    const dome = [], base = []
    for (const xi of RDM_XI) {
      const x = (RDM_XA - xi) * d.L, w = (d.W / 2) * rdmW(xi), h = d.H * rdmH(xi)
      const ring = superRing(seg, w, h, 0, 3).map(([y, z]) => [x, y, z0(z + baseZ(y))])
      dome.push([...ring.slice(3 * q4), ...ring.slice(0, q4 + 1)])
      base.push(ring.slice(q4, 3 * q4 + 1))
    }
    const dm = new MB(), bm = new MB()
    grid(dm, dome, { out: [0, 0, -1] })
    grid(bm, base, { out: [0, 0, 1] })
    const domeIt = put(ctx, 'dome', 'other', part, p.translucent ? 'glass' : 'white_paint', dm)
    put(ctx, 'base', 'other', part, 'white_paint', bm)
    shellMass(ctx, 'radome', domeIt, 12)
    if (p.antenna) {
      // 方位俯仰天线：转台 + 立柱（只转方位）；椭圆平板 + 铰座（方位 + 俯仰）。转动中心 = 扫掠体积中心
      const zc = -(0.02 + 0.5 * d.sH), ap = 0.47 * d.sD, bp = 0.45 * d.sH
      const ant = { id: 'antenna', name: '卫通天线', role: 'reflector' }
      const tm = new MB(); cylZ(tm, 0, 0.3 * d.sD, -0.012, -0.03, 32)
      const pm = new MB(); box(pm, [-0.045, 0, (-0.03 + zc) / 2], [0.016, 0.03, Math.max(0.005, (-0.03 - zc) / 2)])
      const hm = new MB(); box(hm, [-0.045, 0, zc], [0.022, 0.07, 0.028])
      const plm = new MB(), ring = superRing(48, ap, bp, bp, 2)
      loft(plm, [{ c: [-0.02, 0, zc], ring }, { c: [0.0, 0, zc], ring }], { capStart: true, capEnd: true })
      const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1]), o = [0, 0, zc]
      putFramed(ctx, 'plate', 'reflector', ant, 'dark_metal', plm, G, o)
      putFramed(ctx, 'hinge', 'boom', ant, 'dark_metal', hm, G, o)
      putFramed(ctx, 'turntable', 'boom', ant, 'dark_metal', tm, G, o)
      putFramed(ctx, 'post', 'boom', ant, 'dark_metal', pm, G, o)
      const [mn, mx, ini] = azStage(720)
      ctx.arts.push({ name: 'gimbal', nodes: ['plate', 'hinge'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini), stage(STAGE.el, 'xRotate', 0, 90, 45)] })
      ctx.arts.push({ name: 'azimuth', nodes: ['turntable', 'post'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
      ctx.parts.get('antenna').normalBody = [1, 0, 0]
      const ma = 40 * Math.PI * d.sD * d.sD / 4
      comp(ctx, 'antenna', 'solid', ma, [0, 0, zc], cylI(ma, 0.35 * d.sD, 0.2 * d.sH))
      apLocal(ctx, 'boresight', [0, 0, zc], [1, 0, 0], [0, 0, -1])
    } else apLocal(ctx, 'zenith', [0, 0, -d.H], [0, 0, -1], [1, 0, 0])
    if (p.massKg !== null && p.massKg > 0) scaleMass(ctx, p.massKg)
    return ctx
  }
}

// ───────────────────────────── air.turret 光电球 ─────────────────────────────

const turret = {
  type: 'air.turret', domain: ['aircraft'], title: 'EO/IR turret', titleZh: '光电球', role: 'sensor',
  params: {
    diameterM: num(0.55, 'm', '球径', { gt: 0.1, max: 2 }),
    yokeHM: num(null, 'm', '叉臂高', { nullable: true, gt: 0, title: '安装面到球顶；留空 = 0.35 × 球径' }),
    massKg: num(null, 'kg', '质量', { nullable: true, gt: 0, title: '留空 = 180 × 球径³' })
  },
  sockets: (p) => [hangSocket(Math.max(0.05, 0.72 * p.diameterM), 90)],
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx(), D = p.diameterM, R = D / 2, yh = auto(p.yokeHM, 0.35 * D), zb = yh + R
    const part = { id: 'turret', name: '光电球', role: 'sensor' }
    // 安装座（固定）
    const mm = new MB(); cylZ(mm, 0, 0.36 * D, 0, 0.05 * D, 32)
    // 方位筒 + 叉臂（只转方位）
    const hm = new MB(); cylZ(hm, 0, 0.3 * D, 0.05 * D, Math.max(0.06 * D, 0.85 * yh), 32)
    const am = new MB(), ya = R + 0.045 * D, tA = 0.03 * D
    for (const sy of [1, -1]) {
      const y = sy * ya
      prism(am, [[-0.14 * D, y - tA, 0.6 * yh], [0.14 * D, y - tA, 0.6 * yh], [0.14 * D, y + tA, 0.6 * yh], [-0.14 * D, y + tA, 0.6 * yh]],
        [[-0.1 * D, y - tA, zb + 0.12 * D], [0.1 * D, y - tA, zb + 0.12 * D], [0.1 * D, y + tA, zb + 0.12 * D], [-0.1 * D, y + tA, zb + 0.12 * D]])
    }
    const cm = new MB(); prism(cm, [[-0.14 * D, -ya, 0.6 * yh], [0.14 * D, -ya, 0.6 * yh], [0.14 * D, ya, 0.6 * yh], [-0.14 * D, ya, 0.6 * yh]], [[-0.14 * D, -ya, 0.6 * yh - 0.05 * D], [0.14 * D, -ya, 0.6 * yh - 0.05 * D], [0.14 * D, ya, 0.6 * yh - 0.05 * D], [-0.14 * D, ya, 0.6 * yh - 0.05 * D]])
    // 球（极点在 ±X）+ 耳轴 + 前窗（球冠，深色）
    const bm = new MB(), prof = [], wmb = new MB(), wprof = []
    for (let i = 0; i <= 16; i++) { const a = Math.PI * (i / 16); prof.push([R * Math.cos(a), i === 0 || i === 16 ? 0 : R * Math.sin(a)]) }
    axisLoft(bm, prof, zb, 40, 'out')
    for (let i = 0; i <= 5; i++) { const a = (32 * D2R) * (i / 5); wprof.push([1.006 * R * Math.cos(a), i === 0 ? 0 : 1.006 * R * Math.sin(a)]) }
    axisLoft(wmb, wprof, zb, 40, 'out')
    const tm = new MB()
    for (const sy of [1, -1]) loft(tm, [{ pts: superRing(20, 0.08 * D, 0.08 * D, 0.08 * D, 2).map(([a, b]) => [a, sy * (R - 0.02 * D), zb + b]) }, { pts: superRing(20, 0.08 * D, 0.08 * D, 0.08 * D, 2).map(([a, b]) => [a, sy * (ya - tA), zb + b]) }], { out: (c) => [c[0], 0, c[2] - zb], capStart: true, capEnd: true })
    const G = gimbalFrame('azel', [1, 0, 0], [0, 0, -1]), o = [0, 0, zb]
    put(ctx, 'mount', 'sensor', part, 'dark_metal', mm)
    putFramed(ctx, 'housing', 'sensor', part, WING_PAINT, hm, G, o)
    putFramed(ctx, 'yoke', 'sensor', part, WING_PAINT, am, G, o)
    putFramed(ctx, 'yokebridge', 'sensor', part, WING_PAINT, cm, G, o)
    putFramed(ctx, 'ball', 'sensor', part, WING_PAINT, bm, G, o)
    putFramed(ctx, 'window', 'sensor', part, 'dark_metal', wmb, G, o)
    putFramed(ctx, 'trunnions', 'sensor', part, 'dark_metal', tm, G, o)
    const [mn, mx, ini] = azStage(720)
    ctx.arts.push({ name: 'gimbal', nodes: ['ball', 'window', 'trunnions'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini), stage(STAGE.el, 'xRotate', -110, 10, -30)] })
    ctx.arts.push({ name: 'azimuth', nodes: ['housing', 'yoke', 'yokebridge'], stages: [stage(STAGE.az, 'zRotate', mn, mx, ini)] })
    ctx.parts.get('turret').normalBody = [1, 0, 0]
    const m = p.massKg !== null && p.massKg > 0 ? p.massKg : 180 * D * D * D
    comp(ctx, 'turret', 'solid', m, [0, 0, 0.85 * zb], sphI(m, 0.55 * R))
    apLocal(ctx, 'boresight', [0, 0, zb], [1, 0, 0], [0, 0, -1])
    return ctx
  }
}

export const AIR_COMPONENTS = Object.freeze([fuselage, wing, htail, vtail, nacelle, prop, radome, turret])
