// 装配编辑器纯逻辑（packages/core/models/asmSnap.mjs）单测（P3 CONTRACT §9.1）。
//
// ① 吸附判据：compIdFor（前缀表 / 续号 / 保留名 / COMP_ID_RE / 表外兜底）、mountFor（focus → aperture）、pickNearest 半径边界、
//    滞回（3.9 px 不换、4.1 px 换）、faceInfer 五类（平面 + 柱面，网格从面心起算）、clampToFace、snapTo / snapAngle。
// ② 数学：twistDeg（纯扭转 / 纯摆动 / 混合，±180° 连续）、uvOnFace ↔ assembly 面系同式往返（经 solvePose 取面系，≤ 1e-12）、
//    faceAtHit 判据（含蒙皮容差）、mirrorHitToPrimary（映回主件、镜像两次复原）、symFromUi、liveBox / boxXform、aabbPairs、
//    m4ToQT / m4FromQT 往返、massCombine = 整份 combineMass（拖动质量预览）。
// ③ 文档命令：13 种 apply 命令的语义与拒收文案；位姿保持类（setMode / reparent / setRoot / splitSym）世界位姿不变；
//    addComp / removeComps / duplicateComps。
// ④ 零分配：pickNearest / hysteresis.offer / faceInferIO / clampIO / twistDeg / snapTo / snapAngle / uvOnFaceP / liveBox / faceAtHit /
//    mirrorHitToPrimary / massCombine 稳态不涨新生代（独立进程量，同 modelAssembly 的量法）。输入的双精度按编辑器的用法写进 io 对象 / 类型数组
//    （faceInfer / clampToFace / uvOnFace 的位置参数形式与 IO / 数组形式同一份算式）。
// 不联网。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as S from '../models/asmSnap.mjs'
import * as A from '../models/assembly.mjs'
import { getComponent, registerComponent, fillParams } from '../models/components/index.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（容差 ${tol}）`)
const nearM = (a, b, tol, msg) => { for (let i = 0; i < 16; i++) near(a[i], b[i], tol, `${msg}[${i}]`) }
const D2R = Math.PI / 180

// —— 小工具
const rotZ = (deg) => S.m4RotZ(new Float64Array(16), deg)
function rotX(deg) { const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R), o = S.m4Ident(new Float64Array(16)); o[5] = c; o[6] = s; o[9] = -s; o[10] = c; return o }
const mul = (a, b) => S.m4Mul(new Float64Array(16), a, b)
const xf = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]]
const rot = (M, p) => [M[0] * p[0] + M[4] * p[1] + M[8] * p[2], M[1] * p[0] + M[5] * p[1] + M[9] * p[2], M[2] * p[0] + M[6] * p[1] + M[10] * p[2]]
const BUS = { id: 'bus', type: 'sat.bus.box', parent: null }
const docOf = (comps, domain = 'spacecraft') => A.normalizeAssembly({ domain, comps })
const worldPoses = (doc) => { const m = new Map(); for (const [id, p] of A.solvePose(doc)) m.set(id, Float64Array.from(p.m)); return m }

// ═════════════════════════ ① 吸附判据 ═════════════════════════

t('compIdFor：前缀表、续号、保留名、COMP_ID_RE、表外兜底', () => {
  const empty = docOf([])
  const cases = { 'sat.bus.box': 'bus', 'sat.bus.cyl': 'bus', 'sat.wing': 'wing', 'sat.reflector': 'refl', 'sat.feed.horn': 'feed', 'sat.array.phased': 'arr', 'sat.tower': 'tower', 'sat.boom': 'boom', 'sat.thruster': 'thr', 'sat.radiator': 'rad', 'sat.sensor.star': 'star', 'sat.sensor.sun': 'sun', 'prim.box': 'box', 'prim.cyl': 'cyl', 'es.pedestal.azel': 'ped', 'es.refl.cass': 'refl', 'es.subrefl': 'sub', 'es.feed': 'feed', 'es.vsat.mount': 'mnt', 'air.fuselage': 'fus', 'air.nacelle': 'eng', 'sea.superstructure': 'brg', 'sea.vsat.radome': 'vsat', 'veh.cotm.flat': 'cotm', 'veh.driveaway': 'dw' }
  for (const [ty, id] of Object.entries(cases)) assert.equal(S.compIdFor(empty, ty), id, ty)
  const d = docOf([BUS, { id: 'wing', type: 'sat.wing', parent: 'bus', attach: { socket: '+Y' } }, { id: 'wing2', type: 'sat.wing', parent: 'bus', attach: { socket: '-Y' } }])
  assert.equal(S.compIdFor(d, 'sat.wing'), 'wing3')
  assert.equal(S.compIdFor(d, 'sat.bus.box'), 'bus2')
  // 保留名（根节点名）让开
  assert.equal(S.compIdFor(empty, 'foo.ship'), 'ship2')
  assert.equal(S.compIdFor(empty, 'foo.satellite'), 'satellite2')
  // 表外：末段去非字母数字、截 16 位、非字母开头补 c
  assert.equal(S.compIdFor(empty, 'foo.Bar-9x'), 'bar9x')
  assert.equal(S.compIdFor(empty, 'foo.9abc'), 'c9abc')
  assert.equal(S.compIdFor(empty, 'foo.abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnop')
  // used 集合：一次造多个
  const used = new Set()
  assert.deepEqual([S.compIdFor(empty, 'prim.box', used), S.compIdFor(empty, 'prim.box', used), S.compIdFor(empty, 'prim.box', used)], ['box', 'box2', 'box3'])
  for (const id of [...used, 'wing3', 'ship2', 'c9abc']) assert.ok(A.COMP_ID_RE.test(id) && !A.RESERVED_COMP_IDS.includes(id), id)
})

t('mountFor：父插座 focus 且子件有 aperture → aperture；其余 = def.mountSocket', () => {
  const horn = getComponent('sat.feed.horn'), wing = getComponent('sat.wing'), refl = getComponent('sat.reflector')
  const focus = refl.sockets(fillParams(refl, {})).find((s) => s.id === 'focus')
  assert.equal(S.mountFor(horn, {}, focus), 'aperture')
  assert.equal(S.mountFor(wing, {}, { id: '+Y' }), wing.mountSocket)
  assert.equal(S.mountFor(refl, {}, { id: '+X' }), 'back')
  assert.equal(S.mountFor(getComponent('prim.box'), {}, focus), 'root', '没有 aperture 插座的件照 mountSocket')
  assert.equal(S.mountFor(horn, {}, null), horn.mountSocket)
})

t('pickNearest：半径闭区间、NaN 跳过、取最近', () => {
  const xs = new Float64Array([100, 118, NaN, 105]), ys = new Float64Array([100, 100, 100, 104])
  assert.equal(S.pickNearest(xs, ys, 4, 100, 100, 18), 0)
  assert.equal(S.pickNearest(xs, ys, 2, 118, 100, 18), 1)
  assert.equal(S.pickNearest(xs, ys, 1, 118, 100, 18), 0, '恰在半径上算进')
  assert.equal(S.pickNearest(xs, ys, 1, 118.001, 100, 18), -1, '出半径')
  assert.equal(S.pickNearest(xs, ys, 3, 100, 101, 0.5), -1)
  assert.equal(S.pickNearest(new Float64Array([NaN]), new Float64Array([NaN]), 1, 0, 0, 1e9), -1)
  assert.equal(S.pickNearest(xs, ys, 4, 104, 103, 18), 3)
})

t('滞回：新候选好 3.9 px 不换、好 4.1 px 换；当前候选只刷新代价；reset 后直接换', () => {
  const h = S.createHysteresis(S.HYSTERESIS_PX)
  assert.equal(h.offer(7, 10), true); assert.equal(h.key, 7)
  assert.equal(h.offer(9, 6.1), false); assert.equal(h.key, 7)
  assert.equal(h.offer(7, 12), false); assert.equal(h.cost, 12)
  assert.equal(h.offer(9, 8.1), false, '12 − 8.1 = 3.9')
  assert.equal(h.offer(9, 7.9), true, '12 − 7.9 = 4.1'); assert.equal(h.key, 9)
  h.reset(); assert.equal(h.key, -1)
  assert.equal(h.offer(3, 1000), true)
})

t('faceInfer 五类（平面）：面心 / 边中点 / 角点 / 网格（面心起算）/ 自由', () => {
  const f = { id: '+Z', kind: 'plane', origin: [0, 0, 0], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: 1, halfV: 0.5 }
  const o = { u: 0, v: 0, kind: -1 }
  S.faceInfer(f, 0.05, 0.03, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [0, 0, S.INFER.CENTER])
  S.faceInfer(f, 0.95, 0.45, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [1, 0.5, S.INFER.CORNER])
  S.faceInfer(f, -0.93, 0.02, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [-1, 0, S.INFER.EDGE])
  S.faceInfer(f, 0.02, -0.46, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [0, -0.5, S.INFER.EDGE])
  S.faceInfer(f, 0.43, 0.27, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [0.45, 0.25, S.INFER.GRID])
  S.faceInfer(f, 0.024, 0.037, 1000, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [0, 0.05, S.INFER.GRID], '网格从面心起算')
  S.faceInfer(f, 0.43, 0.27, 100, 12, 0, o); assert.deepEqual([o.u, o.v, o.kind], [0.43, 0.27, S.INFER.FREE])
  // 角点与边中点都在半径内：取更近的
  S.faceInfer(f, 1, 0.4, 20, 12, 0, o); assert.deepEqual([o.u, o.v, o.kind], [1, 0.5, S.INFER.CORNER])
  S.faceInfer(f, 1, 0.1, 20, 12, 0, o); assert.deepEqual([o.u, o.v, o.kind], [1, 0, S.INFER.EDGE])
})

t('faceInfer（柱面）：轴向中线 / 端线 / 参考母线 / 网格', () => {
  const f = { id: 'side', kind: 'cyl', origin: [0, 0, 0.5], axis: [0, 0, 1], ref: [1, 0, 0], radius: 0.2, halfU: 0.5, halfV: Math.PI * 0.2 }
  const o = { u: 0, v: 0, kind: -1 }
  S.faceInfer(f, 0.05, 0.3, 100, 12, 0.05, o); assert.deepEqual([o.u, o.kind], [0, S.INFER.CENTER]); near(o.v, 0.3, 1e-12, 'v 网格')
  S.faceInfer(f, 0.46, 0.05, 100, 12, 0.05, o); assert.deepEqual([o.u, o.v, o.kind], [0.5, 0, S.INFER.EDGE])
  S.faceInfer(f, -0.47, -0.61, 100, 12, 0, o); assert.deepEqual([o.u, o.v, o.kind], [-0.5, -0.61, S.INFER.EDGE])
  S.faceInfer(f, 0.27, 0.33, 100, 12, 0.1, o); assert.deepEqual([o.u, o.v, o.kind], [0.3, 0.3, S.INFER.GRID])
})

t('clampToFace：平面夹紧、柱面轴向夹紧 + 弧向回绕', () => {
  const pf = { kind: 'plane', halfU: 1, halfV: 0.5 }, cf = { kind: 'cyl', radius: 0.2, halfU: 0.5, halfV: Math.PI * 0.2 }
  const o = { u: 0, v: 0 }
  S.clampToFace(pf, 2, -3, o); assert.deepEqual([o.u, o.v], [1, -0.5])
  S.clampToFace(pf, 0.3, 0.2, o); assert.deepEqual([o.u, o.v], [0.3, 0.2])
  S.clampToFace(cf, -0.7, Math.PI * 0.2 + 0.1, o); near(o.u, -0.5, 0, 'u'); near(o.v, -Math.PI * 0.2 + 0.1, 1e-12, '回绕')
  S.clampToFace(cf, 0.1, -Math.PI * 0.2, o); near(o.v, Math.PI * 0.2, 1e-12, '−πr 归到 +πr')
})

t('snapTo / snapAngle：十进制尘、−0、区间 (−180, 180]', () => {
  assert.equal(S.snapTo(0.29, 0.05), 0.3)
  assert.equal(S.snapTo(-0.001, 0.05), 0)
  assert.ok(!Object.is(S.snapTo(-0.001, 0.05), -0))
  assert.equal(S.snapTo(0.123, 0), 0.123)
  assert.equal(S.snapAngle(187, 15), 180)
  assert.equal(S.snapAngle(-187, 15), 180)
  assert.equal(S.snapAngle(200, 15), -165)
  assert.equal(S.snapAngle(-181, 0), 179)
  assert.equal(S.snapAngle(-180, 0), 180)
  assert.equal(S.snapAngle(22, 15), 15)
  assert.equal(S.snapAngle(23, 15), 30)
  assert.equal(S.snapAngle(-7.6, 15), -15)
})

// ═════════════════════════ ② 数学 ═════════════════════════

t('twistDeg：纯扭转 = 转角（±180° 连续）、纯摆动 = 0、摆动·扭转取扭转；x / y 轴同理', () => {
  for (const a of [0, 30, -150, 179, -179, 179.9999, -179.9999, 90, -90]) near(S.twistDeg(rotZ(a)), a, 1e-9, `z ${a}`)
  near(S.twistDeg(rotZ(180)), 180, 1e-9, '180')
  near(S.twistDeg(rotX(40)), 0, 1e-12, '纯摆动')
  near(S.twistDeg(mul(rotX(40), rotZ(70))), 70, 1e-9, 'Rx·Rz 的 z 扭转')
  near(S.twistDeg(mul(rotX(-65), rotZ(-120))), -120, 1e-9, 'Rx·Rz（负）')
  near(S.twistDeg(rotX(33), 0), 33, 1e-9, 'x 轴')
  const ry = S.m4Ident(new Float64Array(16)), c = Math.cos(-50 * D2R), s = Math.sin(-50 * D2R)
  ry[0] = c; ry[2] = -s; ry[8] = s; ry[10] = c
  near(S.twistDeg(ry, 1), -50, 1e-9, 'y 轴')
})

t('m4ToQT ↔ m4FromQT 往返、m4InvRigid（含镜像）', () => {
  const M = mul(mul(rotZ(37), rotX(-112)), rotZ(-8)); M[12] = 1.5; M[13] = -2; M[14] = 0.25
  const q = [0, 0, 0, 0], tt = [0, 0, 0]
  S.m4ToQT(M, q, tt)
  assert.ok(q[3] >= 0)
  nearM(S.m4FromQT(new Float64Array(16), q, tt), M, 1e-12, '往返')
  const Mi = S.m4InvRigid(new Float64Array(16), M)
  nearM(mul(M, Mi), S.m4Ident(new Float64Array(16)), 1e-12, '刚体逆')
  const R = Float64Array.from(M); R[4] = -R[4]; R[5] = -R[5]; R[6] = -R[6]   // 镜像一列
  nearM(mul(R, S.m4InvRigid(new Float64Array(16), R)), S.m4Ident(new Float64Array(16)), 1e-12, '镜像逆')
})

t('uvOnFace ↔ assembly 面系（经 solvePose 取面系）同式往返 ≤ 1e-12：平面 + 柱面', () => {
  // 平面：盒贴平台 +Y 面（盒的 mount 插座在原点、法向 −Z：mount 系 = 单位阵 → 件位姿 = 面系(uv)）
  const d = docOf([BUS, { id: 'box', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Y', uv: [0.3, -0.2] } }])
  const P = worldPoses(d), bus = getComponent('sat.bus.box'), f = bus.faces(fillParams(bus, {})).find((x) => x.id === '+Y')
  nearM(P.get('box'), S.faceFrame(new Float64Array(16), f, 0.3, -0.2), 1e-12, 'faceFrame = assembly 面系')
  const F0 = S.faceFrame(new Float64Array(16), f, 0, 0), o = { u: 0, v: 0, d: 0 }
  const M = P.get('box')
  S.uvOnFace(f, F0, M[12], M[13], M[14], o)
  near(o.u, 0.3, 1e-12, 'u'); near(o.v, -0.2, 1e-12, 'v'); near(o.d, 0, 1e-12, 'd')
  const o3 = { u: 0, v: 0, d: 0 }
  S.uvOnFaceP(f, F0, [M[12], M[13], M[14]], o3)
  assert.deepEqual(o3, o, '数组形式同一结果')
  // 柱面：盒贴杆件侧面（杆件自由安装在平台 +X 面上方、带转角）
  const d2 = docOf([BUS, { id: 'boom', type: 'sat.boom', parent: 'bus', attach: { mode: 'free', face: '+X', uv: [0.1, 0.2] }, t: [0.05, -0.1, 0], q: [0.2, 0.1, -0.3, 0.9] },
    { id: 'box', type: 'prim.box', parent: 'boom', attach: { mode: 'surface', face: 'side', uv: [0.21, 0.037] }, params: { xM: 0.02, yM: 0.02, zM: 0.02 } }])
  const P2 = worldPoses(d2), boom = getComponent('sat.boom'), cf = boom.faces(fillParams(boom, {}))[0]
  const Fb = mul(P2.get('boom'), S.faceFrame(new Float64Array(16), cf, 0.21, 0.037))
  nearM(P2.get('box'), Fb, 1e-12, '柱面面系 = assembly')
  const Fb0 = mul(P2.get('boom'), S.faceFrame(new Float64Array(16), cf, 0, 0)), Mb = P2.get('box')
  S.uvOnFace(cf, Fb0, Mb[12], Mb[13], Mb[14], o)
  near(o.u, 0.21, 1e-12, '柱面 u'); near(o.v, 0.037, 1e-12, '柱面 v'); near(o.d, 0, 1e-12, '柱面 d')
})

t('faceAtHit：法向点积 ≥ 0.95、离面 ≤ tol、面内 1.05 倍边界；柱面按径向；多面取离面最近', () => {
  const bus = getComponent('sat.bus.box'), faces = bus.faces(fillParams(bus, {}))   // 半边 1 / 1 / 1.5
  const M = mul(rotZ(30), rotX(20)); M[12] = 3; M[13] = -1; M[14] = 2
  const o = { u: 0, v: 0, d: 0 }
  const fy = faces.findIndex((f) => f.id === '+Y'), f = faces[fy]
  const pl = [f.origin[0] + 0.2 * f.u[0] + 0.4 * f.v[0], f.origin[1] + 0.2 * f.u[1] + 0.4 * f.v[1], f.origin[2] + 0.2 * f.u[2] + 0.4 * f.v[2]]
  const p = xf(M, pl), nrm = rot(M, [0, 1, 0])
  assert.equal(S.faceAtHit(faces, M, p, nrm, 0.002, o), fy)
  near(o.u, 0.2, 1e-12, 'u'); near(o.v, 0.4, 1e-12, 'v')
  // 法向偏 20°（cos = 0.94 < 0.95）→ 不认
  const tilted = rot(M, [0, Math.cos(20 * D2R), Math.sin(20 * D2R)])
  assert.equal(S.faceAtHit(faces, M, p, tilted, 0.002, o), -1)
  const ok = rot(M, [0, Math.cos(15 * D2R), Math.sin(15 * D2R)])
  assert.equal(S.faceAtHit(faces, M, p, ok, 0.002, o), fy, 'cos 15° = 0.966 认')
  // 离面 3 mm（tol 2 mm）→ 不认
  assert.equal(S.faceAtHit(faces, M, xf(M, [pl[0], pl[1] + 0.003, pl[2]]), nrm, 0.002, o), -1)
  // 蒙皮：面外侧 out.skin 以内认（MLI 离结构面 2 cm），内侧仍只让 tol；tol 缺省走 out.tol
  const os = { u: 0, v: 0, d: 0, tol: 0.002, skin: 0.025 }
  assert.equal(S.faceAtHit(faces, M, xf(M, [pl[0], pl[1] + 0.02, pl[2]]), nrm, undefined, os), fy)
  near(os.d, 0.02, 1e-12, '离面距离'); near(os.u, 0.2, 1e-12, '蒙皮上 u 不变')
  assert.equal(S.faceAtHit(faces, M, xf(M, [pl[0], pl[1] + 0.03, pl[2]]), nrm, undefined, os), -1, '出蒙皮')
  assert.equal(S.faceAtHit(faces, M, xf(M, [pl[0], pl[1] - 0.003, pl[2]]), nrm, undefined, os), -1, '内侧只让 tol')
  // 出面 1.05 倍 → 不认；1.04 倍 → 认
  const fu = f.halfU
  assert.equal(S.faceAtHit(faces, M, xf(M, [f.origin[0] + 1.06 * fu * f.u[0], f.origin[1], f.origin[2] + 1.06 * fu * f.u[2]]), nrm, 0.002, o), -1)
  assert.equal(S.faceAtHit(faces, M, xf(M, [f.origin[0] + 1.04 * fu * f.u[0], f.origin[1], f.origin[2] + 1.04 * fu * f.u[2]]), nrm, 0.002, o), fy)
  // 柱面
  const boom = getComponent('sat.boom'), cf = boom.faces(fillParams(boom, {}))
  const lp = [0.025 * Math.cos(0.7), 0.025 * Math.sin(0.7), 0.3]
  assert.equal(S.faceAtHit(cf, M, xf(M, lp), rot(M, [Math.cos(0.7), Math.sin(0.7), 0]), 0.0005, o), 0)
  near(o.u, 0.3 - 0.5, 1e-12, '柱面轴向')
  const F = mul(M, S.faceFrame(new Float64Array(16), cf[0], o.u, o.v))
  const w = xf(M, lp)
  near(F[12], w[0], 1e-12, '柱面 uv 回到命中点 x'); near(F[13], w[1], 1e-12, 'y'); near(F[14], w[2], 1e-12, 'z')
  assert.equal(S.faceAtHit(cf, M, xf(M, lp), rot(M, [0, 0, 1]), 0.0005, o), -1, '法向沿轴不认')
})

t('mirrorHitToPrimary：派生件上的点映回主件对应点；镜像两次复原；径向同理', () => {
  const d = docOf([BUS, { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y', roll: 25 }, params: { tiltDeg: 12 }, sym: { op: 'mirrorXZ' } }])
  const poses = A.solvePose(d), Mp = poses.get('w').m, pd = poses.get('w~1')
  const G = Float64Array.from(pd.m), ax = S.planeAxis(pd.plane)
  G[4 * ax] = -G[4 * ax]; G[4 * ax + 1] = -G[4 * ax + 1]; G[4 * ax + 2] = -G[4 * ax + 2]
  const l = [0.1, 0.2, 1.5], ln = [0.6, 0, 0.8]
  // 渲染等式：派生件（主件几何 × G）= 世界镜像（y 取反）× 主件
  const pw = xf(Mp, l), dw = xf(G, l)
  near(dw[0], pw[0], 1e-12, 'x'); near(dw[1], -pw[1], 1e-12, 'y 取反'); near(dw[2], pw[2], 1e-12, 'z')
  const oP = [0, 0, 0], oN = [0, 0, 0]
  S.mirrorHitToPrimary(pd.m, Mp, pd.plane, dw, rot(G, ln), oP, oN)
  const nw = rot(Mp, ln)
  for (let k = 0; k < 3; k++) { near(oP[k], pw[k], 1e-12, `点 ${k}`); near(oN[k], nw[k], 1e-12, `法向 ${k}`) }
  // 就地（输入输出同一数组）
  const pp = dw.slice(), nn = rot(G, ln)
  S.mirrorHitToPrimary(pd.m, Mp, pd.plane, pp, nn, pp, nn)
  for (let k = 0; k < 3; k++) near(pp[k], pw[k], 1e-12, `就地 ${k}`)
  // 主件自己：plane = null、derived = primary → 恒等
  S.mirrorHitToPrimary(Mp, Mp, null, pw, nw, oP, oN)
  for (let k = 0; k < 3; k++) near(oP[k], pw[k], 1e-12, `恒等 ${k}`)
  // 径向
  const d3 = docOf([BUS, { id: 'th', type: 'sat.thruster', parent: 'bus', attach: { mode: 'surface', face: '-Z', uv: [0.5, 0.2] }, sym: { op: 'radial', n: 3 } }])
  const p3 = A.solvePose(d3), M0 = p3.get('th').m, M2 = p3.get('th~2')
  assert.equal(M2.plane, null)
  const q = xf(M2.m, l)
  S.mirrorHitToPrimary(M2.m, M0, M2.plane, q, [0, 0, 1], oP, oN)
  const q0 = xf(M0, l)
  for (let k = 0; k < 3; k++) near(oP[k], q0[k], 1e-12, `径向 ${k}`)
})

t('symFromUi：无 → null；镜像 → {op}；径向 n 夹紧取整、轴按领域', () => {
  assert.equal(S.symFromUi('none', 3, 'spacecraft'), null)
  assert.deepEqual(S.symFromUi('mirrorXZ', 3, 'spacecraft'), { op: 'mirrorXZ' })
  assert.deepEqual(S.symFromUi('mirrorYZ', 3, 'aircraft'), { op: 'mirrorYZ' })
  assert.deepEqual(S.symFromUi('radial', 4, 'spacecraft'), { op: 'radial', n: 4, axis: '+Z' })
  assert.deepEqual(S.symFromUi('radial', 4, 'aircraft'), { op: 'radial', n: 4, axis: '+X' })
  assert.deepEqual(S.symFromUi('radial', 12, 'ship'), { op: 'radial', n: 8, axis: '+Z' })
  assert.deepEqual(S.symFromUi('radial', 1.2, 'ground'), { op: 'radial', n: 2, axis: '+Z' })
})

t('liveBox / boxXform：旋转 90° 的盒外包精确；隐藏件（空盒）跳过；一件都没有写全 0', () => {
  const boxes = new Float64Array([-1, -0.5, 0, 1, 0.5, 2, Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity, 0, 0, 0, 1, 1, 1])
  const mats = new Float64Array(48)
  mats.set(rotZ(90), 0); mats.set(S.m4Ident(new Float64Array(16)), 16)
  const T = S.m4Ident(new Float64Array(16)); T[12] = 5; mats.set(T, 32)
  const out = new Float64Array(6)
  S.liveBox(boxes, mats, 3, out)
  assert.deepEqual([...out], [-0.5, -1, 0, 6, 1, 2])
  S.liveBox(boxes, mats, 1, out)
  assert.deepEqual([...out], [-0.5, -1, 0, 0.5, 1, 2])
  S.liveBox(boxes.subarray(6), mats.subarray(16), 1, out)
  assert.deepEqual([...out], [0, 0, 0, 0, 0, 0])
})

t('aabbPairs：严格重叠才算、贴边不算、skip 生效', () => {
  const b = new Float64Array([0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5, 2, 2, 2, 1, 0, 0, 2, 1, 1, 5, 5, 5, 6, 6, 6])
  assert.deepEqual(S.aabbPairs(b, 4), [[0, 1], [1, 2]], '0 与 2 贴边不算')
  assert.deepEqual(S.aabbPairs(b, 4, (i, j) => i === 0 && j === 1), [[1, 2]])
})

t('massCombine：静态部分 + 拖动件按渲染矩阵放 n 份 = 整份文档 combineMass（镜像钩子件 / 径向 / 空静态）', () => {
  const full = docOf([BUS,
    { id: 'w', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y', roll: 30 }, params: { tiltDeg: 17 }, sym: { op: 'mirrorXZ' } },
    { id: 'bx', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0.3, -0.2], roll: 10 }, massKg: 40 }])
  const cmp = (moving, extraCheck) => {
    const cm = A.combineMass(full)
    const stat = docOf(full.comps.filter((c) => c.id !== moving).map((c) => JSON.parse(JSON.stringify(c))))
    const mc = full.comps.find((c) => c.id === moving)
    const loc = docOf([{ ...JSON.parse(JSON.stringify(mc)), parent: null, attach: null, sym: null, t: undefined, q: undefined }])
    const a0 = S.massPack(A.combineMass(stat), new Float64Array(13)), a1 = S.massPack(A.combineMass(loc), new Float64Array(13))
    const P = A.solvePose(full), ids = [...P.keys()].filter((id) => S.primaryIdOf(id) === moving)
    const mats = new Float64Array(16 * ids.length)
    ids.forEach((id, k) => { const p = P.get(id), m = Float64Array.from(p.m), ax = S.planeAxis(p.plane); if (ax >= 0) { m[4 * ax] = -m[4 * ax]; m[4 * ax + 1] = -m[4 * ax + 1]; m[4 * ax + 2] = -m[4 * ax + 2] } mats.set(m, 16 * k) })
    const out = S.massCombine(a0, a1, mats, ids.length, new Float64Array(13))
    near(out[0], cm.massKg, 1e-9 * cm.massKg, `${moving} 质量`)
    for (let k = 0; k < 3; k++) near(out[1 + k], cm.comBody[k], 1e-9, `${moving} 质心 ${k}`)
    const scale = Math.max(...cm.inertiaBody.flat().map(Math.abs))
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) near(out[4 + 3 * r + c], cm.inertiaBody[r][c], 1e-9 * scale, `${moving} I${r}${c}`)
  }
  cmp('w')   // 镜像钩子件（翼转角取反）：派生份按「主件几何 × 镜面列取反的矩阵」放
  cmp('bx')  // 手填质量的贴面件
  const rad = docOf([BUS, { id: 'th', type: 'sat.thruster', parent: 'bus', attach: { mode: 'surface', face: '-Z', uv: [0.5, 0.2], roll: 20 }, sym: { op: 'radial', n: 3 } }])
  const cm = A.combineMass(rad)
  const P = A.solvePose(rad), mats = new Float64Array(48)
  ;['th', 'th~1', 'th~2'].forEach((id, k) => mats.set(P.get(id).m, 16 * k))
  const a1 = S.massPack(A.combineMass(docOf([{ id: 'th', type: 'sat.thruster', parent: null }])), new Float64Array(13))
  const out = S.massCombine(S.massPack(A.combineMass(docOf([BUS])), new Float64Array(13)), a1, mats, 3, new Float64Array(13))
  near(out[0], cm.massKg, 1e-9 * cm.massKg, '径向质量')
  for (let k = 0; k < 3; k++) near(out[1 + k], cm.comBody[k], 1e-9, `径向质心 ${k}`)
  const z = S.massCombine(new Float64Array(13), new Float64Array(13), mats, 3, new Float64Array(13).fill(7))
  assert.ok(z.every((v) => v === 0), '总质量 0 写全 0')
})

// ═════════════════════════ ③ 文档命令 ═════════════════════════

const wingDoc = () => docOf([BUS, { id: 'wing', type: 'sat.wing', parent: 'bus', attach: { mode: 'socket', socket: '+Y', roll: 0 }, params: { tiltDeg: 20 }, sym: { op: 'mirrorXZ' } },
  { id: 'refl', type: 'sat.reflector', parent: 'bus', attach: { mode: 'socket', socket: '+X' }, params: { diameterM: 1.6, feed: 'none' } },
  { id: 'feed', type: 'sat.feed.horn', parent: 'refl', attach: { mode: 'socket', socket: 'focus', mount: 'aperture' } },
  { id: 'box', type: 'prim.box', parent: 'bus', attach: { mode: 'surface', face: '+Z', uv: [0.3, -0.2], roll: 15 } }])

t('setParams / rename / setHidden / setLocked / setMaterial / setMass / setDoc：语义、合并键、拒收文案', () => {
  const d = wingDoc()
  let r = S.applyCmd(d, { type: 'setParams', id: 'refl', params: { diameterM: 2 } })
  assert.ok(r.ok && r.changed); assert.equal(S.compById(r.doc, 'refl').params.diameterM, 2); assert.equal(r.mergeKey, 'refl|diameterM')
  assert.equal(S.compById(d, 'refl').params.diameterM, 1.6, '不改入参')
  r = S.applyCmd(d, { type: 'setParams', id: 'refl', params: { focalM: null } }); assert.ok(r.ok && !r.changed, '可空参数置 null = 自动（本来就是）')
  assert.equal(S.applyCmd(d, { type: 'setParams', id: 'refl', params: { nope: 1 } }).error, '未知参数 nope。')
  r = S.applyCmd(d, { type: 'setParams', id: 'refl', params: { diameterM: -1 } }); assert.ok(r.ok, '非法值照样提交（红染）')
  r = S.applyCmd(d, { type: 'rename', id: 'box', name: '  电子盒 ' }); assert.equal(S.compById(r.doc, 'box').name, '电子盒')
  r = S.applyCmd(r.doc, { type: 'rename', id: 'box', name: '   ' }); assert.equal(S.compById(r.doc, 'box').name, null)
  r = S.applyCmd(d, { type: 'setHidden', ids: ['box', 'wing~1'], on: true })
  assert.ok(S.compById(r.doc, 'box').hidden && S.compById(r.doc, 'wing').hidden, '派生 id 换主件')
  const locked = S.applyCmd(d, { type: 'setLocked', ids: ['box'], on: true }).doc
  assert.equal(S.applyCmd(locked, { type: 'setParams', id: 'box', params: { xM: 1 } }).error, '件已锁定。')
  assert.ok(S.applyCmd(locked, { type: 'setHidden', ids: ['box'], on: true }).ok, '锁定件可隐藏')
  assert.equal(S.compById(S.applyCmd(locked, { type: 'setLocked', ids: ['box'], on: false }).doc, 'box').locked, false, '可解锁')
  assert.equal(S.applyCmd(d, { type: 'setMaterial', id: 'box', material: 'unobtainium' }).error, '未知材质。')
  assert.equal(S.compById(S.applyCmd(d, { type: 'setMaterial', id: 'box', material: 'carbon' }).doc, 'box').material, 'carbon')
  assert.equal(S.applyCmd(d, { type: 'setMass', id: 'box', massKg: 0 }).error, '质量须为正数。')
  assert.equal(S.compById(S.applyCmd(d, { type: 'setMass', id: 'box', massKg: 12.5 }).doc, 'box').massKg, 12.5)
  r = S.applyCmd(d, { type: 'setDoc', patch: { name: 'X', massTargetKg: 3000, density: { busVolume: 90, towerAreal: 3 } } })
  assert.equal(r.doc.name, 'X'); assert.equal(r.doc.massTargetKg, 3000); assert.deepEqual(r.doc.density, { busVolume: 90, towerAreal: 3 })
  r = S.applyCmd(r.doc, { type: 'setDoc', patch: { massTargetKg: null, density: { busVolume: null } } })
  assert.equal(r.doc.massTargetKg, null); assert.deepEqual(r.doc.density, { towerAreal: 3 })
  assert.equal(S.applyCmd(d, { type: 'nope' }).error, '未知命令。')
  assert.equal(S.applyCmd(d, { type: 'rename', id: 'zzz', name: 'a' }).error, '找不到组件。')
  assert.equal(S.applyCmd(d, { type: 'setSym', id: 'bus', sym: { op: 'mirrorXZ' } }).error, '根件不能对称。')
})

t('setMode：socket → free → surface → socket 世界位姿不变；没有面 / 插座时拒收', () => {
  const d = wingDoc(), P0 = worldPoses(d)
  let r = S.applyCmd(d, { type: 'setMode', id: 'refl', mode: 'free' })
  assert.ok(r.ok); assert.equal(S.compById(r.doc, 'refl').attach.mode, 'free')
  nearM(worldPoses(r.doc).get('refl'), P0.get('refl'), 1e-12, '→free')
  nearM(worldPoses(r.doc).get('feed'), P0.get('feed'), 1e-12, '子件跟着不动')
  r = S.applyCmd(r.doc, { type: 'setMode', id: 'refl', mode: 'surface' })
  assert.ok(r.ok); const a = S.compById(r.doc, 'refl').attach
  assert.equal(a.mode, 'surface'); assert.equal(a.face, '+X')
  nearM(worldPoses(r.doc).get('refl'), P0.get('refl'), 1e-9, '→surface')
  r = S.applyCmd(r.doc, { type: 'setMode', id: 'refl', mode: 'socket' })
  assert.equal(S.compById(r.doc, 'refl').attach.socket, '+X')
  nearM(worldPoses(r.doc).get('refl'), P0.get('refl'), 1e-9, '→socket')
  // 贴面件（带滚转）换插座：取最近空闲插座、滚转反算
  r = S.applyCmd(d, { type: 'setMode', id: 'box', mode: 'free' })
  const Pb = worldPoses(r.doc).get('box')
  nearM(Pb, P0.get('box'), 1e-12, 'box → free')
  // 馈源件（父件反射面没有面）→ surface 拒收
  assert.equal(S.applyCmd(d, { type: 'setMode', id: 'feed', mode: 'surface' }).error, '没有可贴的面。')
  // 反射面唯一的插座 focus 已被 feed 占着之外没有别的兼容插座：feed 自己占的不算占用
  assert.ok(S.applyCmd(S.applyCmd(d, { type: 'setMode', id: 'feed', mode: 'free' }).doc, { type: 'setMode', id: 'feed', mode: 'socket' }).ok)
  assert.equal(S.applyCmd(d, { type: 'setMode', id: 'bus', mode: 'free' }).error, '根件没有安装方式。')
})

t('reparent：保持世界位姿、方式变自由；成环 / 嵌套对称 / 根件拒收', () => {
  const d = wingDoc(), P0 = worldPoses(d)
  let r = S.applyCmd(d, { type: 'reparent', id: 'box', parent: 'refl' })
  assert.ok(r.ok); const c = S.compById(r.doc, 'box')
  assert.equal(c.parent, 'refl'); assert.equal(c.attach.mode, 'free')
  nearM(worldPoses(r.doc).get('box'), P0.get('box'), 1e-12, '世界位姿')
  assert.equal(S.applyCmd(d, { type: 'reparent', id: 'refl', parent: 'feed' }).error, '父子关系成环。')
  assert.equal(S.applyCmd(d, { type: 'reparent', id: 'refl', parent: 'refl' }).error, '父子关系成环。')
  assert.equal(S.applyCmd(d, { type: 'reparent', id: 'bus', parent: 'box' }).error, '根件不能改父件。')
  // 自带对称的件挂到对称子树里 → 拒
  const d2 = S.applyCmd(d, { type: 'setSym', id: 'box', sym: { op: 'mirrorYZ' } }).doc
  assert.equal(S.applyCmd(d2, { type: 'reparent', id: 'box', parent: 'wing' }).error, '不支持嵌套对称。')
  assert.equal(S.applyCmd(d2, { type: 'reparent', id: 'box', parent: 'wing~1' }).error, '不支持嵌套对称。', '派生 id 换主件再判')
  assert.ok(S.applyCmd(d, { type: 'reparent', id: 'box', parent: 'wing' }).ok, '不带对称的件可以挂进对称子树')
})

t('setRoot：新根落到原点、轴对齐；全部世界位姿左乘 inv(M_新根)；路径上的件改自由', () => {
  const d = wingDoc(), P0 = worldPoses(d)
  const r = S.applyCmd(d, { type: 'setRoot', id: 'feed' })
  assert.ok(r.ok, r.error)
  const P1 = worldPoses(r.doc), inv = S.m4InvRigid(new Float64Array(16), P0.get('feed'))
  nearM(P1.get('feed'), S.m4Ident(new Float64Array(16)), 1e-12, '新根单位阵')
  for (const id of ['bus', 'refl', 'box']) nearM(P1.get(id), mul(inv, P0.get(id)), 1e-9, id)
  assert.equal(S.compById(r.doc, 'feed').parent, null)
  assert.equal(S.compById(r.doc, 'refl').parent, 'feed'); assert.equal(S.compById(r.doc, 'refl').attach.mode, 'free')
  assert.equal(S.compById(r.doc, 'bus').parent, 'refl'); assert.equal(S.compById(r.doc, 'bus').attach.mode, 'free')
  assert.equal(S.compById(r.doc, 'box').attach.mode, 'surface', '不在路径上的件安装语义不变')
  assert.ok(A.validateAssembly(r.doc).ok)
  assert.equal(S.applyCmd(d, { type: 'setRoot', id: 'wing' }).error, '对称件不能设为根。')
})

t('setSym：嵌套拒收；splitSym：钩子件参数镜像、位姿 = 原派生件；烘焙件拒收', () => {
  const d = wingDoc()
  // 件原点在对称面 / 轴上（馈源在 +X 反射面焦点上，y = 0）：副本与原件重合 → 拒收；换一面（YZ，x ≠ 0）照收
  assert.equal(S.applyCmd(d, { type: 'setSym', id: 'feed', sym: { op: 'mirrorXZ' } }).error, '件在对称面上。')
  assert.equal(S.applyCmd(d, { type: 'setSym', id: 'feed', sym: { op: 'mirrorYZ' } }).ok, true)
  assert.equal(S.applyCmd(d, { type: 'setSym', id: 'box', sym: { op: 'mirrorXZ' } }).ok, true)
  assert.equal(S.onSymLocus({ op: 'radial', axis: '+X' }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]), true, '径向：在轴上')
  assert.equal(S.onSymLocus({ op: 'radial', axis: '+Z' }, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]), false)
  const d2 = S.applyCmd(d, { type: 'setSym', id: 'refl', sym: { op: 'radial', n: 3 } }).doc
  assert.deepEqual(S.compById(d2, 'refl').sym, { group: 'refl', op: 'radial', n: 3, axis: '+Z' })
  assert.equal(S.applyCmd(d2, { type: 'setSym', id: 'feed', sym: { op: 'mirrorXZ' } }).error, '不支持嵌套对称。')
  assert.equal(S.applyCmd(d, { type: 'setSym', id: 'refl', sym: { op: 'radial', n: 9 } }).error, '径向份数须为 2–8。')
  // 拆分：翼（钩子）
  const P0 = A.solvePose(d)
  const r = S.applyCmd(d, { type: 'splitSym', id: 'wing' })
  assert.ok(r.ok, r.error)
  const w2 = r.doc.comps.find((c) => c.type === 'sat.wing' && c.id !== 'wing')
  assert.equal(w2.id, 'wing2'); assert.equal(w2.attach.mode, 'free'); assert.equal(w2.sym, null)
  assert.equal(w2.params.tiltDeg, -20, '钩子镜像参数')
  assert.equal(S.compById(r.doc, 'wing').sym, null)
  nearM(A.solvePose(r.doc).get('wing2').m, P0.get('wing~1').m, 1e-9, '位姿 = 原派生件')
  // 子树跟着拆：给翼挂一个太阳敏，拆后敏感器副本挂在翼副本上
  const d3 = S.addComp(d, { type: 'sat.sensor.sun', parent: 'wing', attach: { mode: 'free' }, t: [0.1, 0, 0.5], q: [0, 0, 0, 1] }).doc
  const P3 = A.solvePose(d3)
  const r3 = S.applyCmd(d3, { type: 'splitSym', id: 'wing' })
  assert.ok(r3.ok, r3.error)
  const s2 = r3.doc.comps.find((c) => c.type === 'sat.sensor.sun' && c.id !== 'sun')
  assert.equal(s2.parent, 'wing2')
  nearM(A.solvePose(r3.doc).get(s2.id).m, P3.get('sun~1').m, 1e-9, '子件副本位姿')
  // 烘焙件：登记一个不声明对称面、没有钩子的变体
  registerComponent({ ...getComponent('prim.box'), type: 'test.asymbox', symmetricPlanes: [] }, { replace: true })
  const d4 = docOf([BUS, { id: 'ab', type: 'test.asymbox', parent: 'bus', attach: { mode: 'socket', socket: '+Y' }, sym: { op: 'mirrorXZ' } }])
  assert.equal(A.solvePose(d4).get('ab~1').mode, 'bake')
  assert.equal(S.applyCmd(d4, { type: 'splitSym', id: 'ab' }).error, '该组件不能拆分对称。')
  assert.equal(S.applyCmd(d, { type: 'splitSym', id: 'refl' }).error, '该组件没有对称。')
})

t('setAttach：合并安装字段；自由件带 t / q；根件拒收', () => {
  const d = wingDoc()
  let r = S.applyCmd(d, { type: 'setAttach', id: 'box', attach: { uv: [0.1, 0.1], roll: 45 } })
  assert.deepEqual(S.compById(r.doc, 'box').attach, { mode: 'surface', socket: null, face: '+Z', uv: [0.1, 0.1], roll: 45, mount: null })
  r = S.applyCmd(d, { type: 'setAttach', id: 'box', attach: { mode: 'free' }, t: [0, 0, 2], q: [0, 0, 0.3826834323650898, 0.9238795325112867] })
  const c = S.compById(r.doc, 'box')
  assert.equal(c.attach.mode, 'free'); assert.deepEqual(c.t, [0, 0, 2])
  r = S.applyCmd(d, { type: 'setAttach', id: 'box', attach: { mode: 'socket', socket: '-Y' } })
  assert.equal(S.compById(r.doc, 'box').attach.socket, '-Y'); assert.equal(S.compById(r.doc, 'box').attach.uv, null)
  assert.equal(S.applyCmd(d, { type: 'setAttach', id: 'bus', attach: { roll: 1 } }).error, '根件没有安装方式。')
})

t('addComp / removeComps / duplicateComps：id、父子、根件与锁定规则、对称组', () => {
  let r = S.addComp(docOf([]), { type: 'sat.bus.box', parent: null })
  assert.ok(r.ok); assert.equal(r.id, 'bus')
  assert.equal(S.addComp(r.doc, { type: 'prim.box', parent: null }).error, '已有根件。')
  assert.equal(S.addComp(r.doc, { type: 'es.nope', parent: 'bus' }).error, '未知组件。')
  const d = wingDoc()
  r = S.addComp(d, { type: 'prim.box', parent: 'wing', attach: { mode: 'free' }, sym: { op: 'mirrorYZ' } })
  assert.equal(S.compById(r.doc, r.id).sym, null, '父件在对称子树里：不叠对称')
  r = S.addComp(d, { type: 'prim.box', parent: 'bus', attach: { mode: 'socket', socket: '-X' }, sym: { op: 'mirrorYZ' } })
  assert.deepEqual(S.compById(r.doc, r.id).sym, { group: r.id, op: 'mirrorYZ' })
  assert.equal(S.removeComps(d, ['bus']).error, '根件不能删除。')
  assert.ok(S.removeComps(docOf([BUS]), ['bus']).ok, '只剩根件时可删')
  r = S.removeComps(d, ['refl', 'wing~1'])
  assert.deepEqual(r.removed.sort(), ['feed', 'refl', 'wing'])
  assert.deepEqual(r.doc.comps.map((c) => c.id), ['bus', 'box'])
  const dl = S.applyCmd(d, { type: 'setLocked', ids: ['feed'], on: true }).doc
  assert.equal(S.removeComps(dl, ['refl']).error, '件已锁定。', '子树里有锁定件')
  r = S.duplicateComps(d, ['refl', 'feed'])
  assert.ok(r.ok); assert.deepEqual(r.roots, ['refl2'])
  const f2 = S.compById(r.doc, 'feed2')
  assert.equal(f2.parent, 'refl2'); assert.equal(S.compById(r.doc, 'refl2').parent, 'bus')
  r = S.duplicateComps(d, ['wing'])
  assert.deepEqual(S.compById(r.doc, 'wing2').sym, { group: 'wing2', op: 'mirrorXZ' })
  assert.equal(S.duplicateComps(d, ['bus']).error, '根件不能复制。')
  assert.ok(A.validateAssembly(r.doc).ok)
})

t('freeSocketsOf / usedSocketKeys / attachFromWorld：占用与兼容；滚转反算', () => {
  const d = wingDoc()
  const used = S.usedSocketKeys(d)
  assert.ok(used.has('bus|+Y') && used.has('bus|+X') && used.has('refl|focus'))
  const ids = S.freeSocketsOf(d, 'bus', 'prim.box').map((s) => s.id).sort()
  assert.deepEqual(ids, ['+Z', '-X', '-Y', '-Z'])
  assert.deepEqual(S.freeSocketsOf(d, 'refl', 'sat.wing').map((s) => s.id), [], 'focus 只接馈源类')
  assert.deepEqual(S.freeSocketsOf(d, 'refl', 'sat.feed.horn', 'feed').map((s) => s.id), ['focus'], '自己占的不算')
  // 滚转反算：把翼装到 +Y 插座、滚转 30°，世界位姿交给 attachFromWorld 应回 30
  const d2 = S.applyCmd(d, { type: 'setAttach', id: 'wing', attach: { roll: 30 } }).doc
  const P = worldPoses(d2), bus = getComponent('sat.bus.box'), s = bus.sockets(fillParams(bus, {})).find((x) => x.id === '+Y')
  const r = S.attachFromWorld(S.compById(d2, 'wing'), P.get('bus'), P.get('wing'), 'socket', s)
  near(r.attach.roll, 30, 1e-9, 'roll'); assert.equal(r.attach.socket, '+Y')
})

// ═════════════════════════ ④ 零分配 ═════════════════════════

t('setParams：插座 / 面随参数消失 → 子件改自由（保持世界位姿、同一条命令）；本件安装插座消失 → 本件改自由；解算无孤儿', () => {
  const base = getComponent('prim.box')
  registerComponent({
    ...base, type: 'test.sockbox',
    params: { ...base.params, extra: { kind: 'bool', def: true, source: 'illustrative', label: '附加' } },
    sockets: (p) => [...base.sockets(p), ...(p.extra ? [{ id: 'x1', pos: [0.1, 0.12, p.zM], n: [0, 0, 1], up: [1, 0, 0], size: 0.1, accepts: null, roll: 90 }] : [])],
    faces: (p) => (p.extra ? base.faces(p) : base.faces(p).filter((f) => f.id !== '+Y'))
  }, { replace: true })
  const d = docOf([BUS,
    { id: 'sb', type: 'test.sockbox', parent: 'bus', attach: { mode: 'socket', socket: '+X' } },
    { id: 'k1', type: 'prim.box', parent: 'sb', attach: { mode: 'socket', socket: 'x1', roll: 90 }, params: { xM: 0.1, yM: 0.1, zM: 0.1 } },
    { id: 'k2', type: 'prim.box', parent: 'sb', attach: { mode: 'surface', face: '+Y', uv: [0.05, 0.02] }, params: { xM: 0.1, yM: 0.1, zM: 0.1 } },
    { id: 'k3', type: 'prim.box', parent: 'sb', attach: { mode: 'socket', socket: '-Y' }, params: { xM: 0.1, yM: 0.1, zM: 0.1 } }])
  const P0 = worldPoses(d)
  const r = S.applyCmd(d, { type: 'setParams', id: 'sb', params: { extra: false } })
  assert.ok(r.ok && r.changed, r.error)
  assert.deepEqual([...r.freed].sort(), ['k1', 'k2'], '只有挂在消失插座 / 面上的子件改自由')
  const P1 = A.solvePose(r.doc)
  for (const id of ['k1', 'k2', 'k3']) { assert.equal(P1.get(id).bad, null, id + ' 无孤儿'); nearM(P1.get(id).m, P0.get(id), 1e-9, id + ' 世界位姿不变') }
  assert.equal(S.compById(r.doc, 'k1').attach.mode, 'free'); assert.equal(S.compById(r.doc, 'k3').attach.mode, 'socket')
  assert.ok(A.validateAssembly(r.doc).ok, A.validateAssembly(r.doc).errors.join('；'))
  // 本件的安装插座（mount = x1）消失 → 本件改自由
  const d2 = docOf([BUS, { id: 'sb', type: 'test.sockbox', parent: 'bus', attach: { mode: 'socket', socket: '+Z', mount: 'x1' } }])
  const Q0 = worldPoses(d2)
  const r2 = S.applyCmd(d2, { type: 'setParams', id: 'sb', params: { extra: false } })
  assert.deepEqual(r2.freed, ['sb'])
  nearM(A.solvePose(r2.doc).get('sb').m, Q0.get('sb'), 1e-9, '本件世界位姿不变')
  // 插座集合不变的参数改动：不带 freed
  assert.equal(S.applyCmd(d, { type: 'setParams', id: 'sb', params: { xM: 0.6 } }).freed, undefined)
})

t('计划过继：拓扑变了（换父）只重建计划、不重跑组件生成——100 件文档拾起件时父件来回切，combineMass 每次 ≤ 1 ms', () => {
  const comps = [BUS]
  for (let i = 0; i < 99; i++) comps.push({ id: 'k' + i, type: i % 3 ? 'prim.box' : 'sat.reflector', parent: i < 5 ? 'bus' : 'k' + (i % 5), attach: { mode: 'free' }, t: [0.3 * (i % 7), 0.2 * (i % 5), 0.4 + 0.1 * i], q: [0, 0, 0, 1], params: i % 3 ? { xM: 0.2 + 0.001 * i } : { diameterM: 1 + 0.01 * i, feed: 'none' } })
  const d = docOf(comps)
  const out = {}
  A.combineMass(d, out)   // 预热：生成全部件
  const mv = S.compById(d, 'k50')
  const ms = []
  for (let r = 0; r < 20; r++) {
    mv.parent = r % 2 ? 'k1' : 'k2'
    const t0 = performance.now()
    A.combineMass(d, out)
    ms.push(performance.now() - t0)
  }
  ms.sort((a, b) => a - b)
  assert.ok(ms[10] <= 1, `换父后 combineMass 中位 ${ms[10].toFixed(3)} ms`)
  // 新文档 / 新 out（拾起的静态 / 移动子树文档）：模块级生成缓存命中
  const t1 = performance.now()
  A.combineMass(docOf(comps.filter((c) => c.id !== 'k60')), {})
  assert.ok(performance.now() - t1 < 15, `新 out 的 combineMass ${(performance.now() - t1).toFixed(2)} ms`)
})

t('热路径零分配（独立进程量 new_space）：pickNearest / offer / faceInferIO / clampIO / twistDeg / snapTo / snapAngle / uvOnFaceP / liveBox / faceAtHit / mirrorHitToPrimary / massCombine', () => {
  const url = new URL('../models/asmSnap.mjs', import.meta.url).href
  const src = [
    `import * as S from '${url}'`,
    "import v8 from 'node:v8'",
    "const newSpace = () => v8.getHeapSpaceStatistics().find((s) => s.space_name === 'new_space').space_used_size",
    'const perFrame = (f, frames) => { const d = []; for (let w = 0; w < 25; w++) { const a = newSpace(); for (let i = 0; i < frames; i++) f(i); const b = newSpace(); if (b >= a) d.push((b - a) / frames) } d.sort((x, y) => x - y); return d.length ? d[d.length >> 1] : Infinity }',
    'const N = 64, xs = new Float64Array(N), ys = new Float64Array(N)',
    'for (let i = 0; i < N; i++) { xs[i] = (i * 37) % 500; ys[i] = (i * 91) % 400 }',
    'const h = S.createHysteresis(4)',
    "const pf = { id: '+Z', kind: 'plane', origin: [0, 0, 1], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: 1, halfV: 0.5 }",
    "const cf = { id: 'side', kind: 'cyl', origin: [0, 0, 0.5], axis: [0, 0, 1], ref: [1, 0, 0], radius: 0.2, halfU: 0.5, halfV: Math.PI * 0.2 }",
    'const faces = [pf, cf]',
    "const o = { u: 0.5, v: 0.5, kind: 0, ppm: 150.5, d: 0.5, tol: 0.002 }, o2 = { u: 0.5, v: 0.5 }",
    'const M = S.m4RotZ(new Float64Array(16), 33); M[12] = 1; M[13] = 2; M[14] = 3',
    'const F = S.faceFrame(new Float64Array(16), pf, 0, 0)',
    'const B = 32, boxes = new Float64Array(6 * B), mats = new Float64Array(16 * B), out6 = new Float64Array(6)',
    'for (let i = 0; i < B; i++) { boxes.set([-1, -1, -1, 1, 1, 1], 6 * i); mats.set(M, 16 * i); mats[16 * i + 12] = i }',
    'const p = new Float64Array([1, 2, 4]), nn = new Float64Array([0, 0, 1]), oP = new Float64Array(3), oN = new Float64Array(3)',
    'const acc = new Float64Array(1), q3 = new Float64Array([0.3, -0.2, 1.01])',
    'const ma0 = new Float64Array([100, 0.1, 0.2, 0.3, 5, 0.1, 0, 0.1, 6, 0, 0, 0, 7]), ma1 = new Float64Array([10, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1]), mout = new Float64Array(13), mats4 = new Float64Array(32)',
    'mats4.set(M, 0); mats4.set(M, 16); mats4[20] = -mats4[20]; mats4[21] = -mats4[21]; mats4[22] = -mats4[22]',
    // 编辑器的用法：算出来的双精度写进 io 对象 / 类型数组再交给函数（不经实参传：未内联的调用会把双精度实参装箱，那是调用方的账）
    // 每个被测函数单独一个帧函数、单独一段顶层循环量（与 modelAssembly 同一量法）。几个大函数挤进一个帧函数时，
    // TurboFan 的内联决策会随并发编译的时机在两次运行间摇摆，没被内联的那一处会装箱一个双精度（16 B）——那是调用方内联预算的账
    'const F_ = {',
    '  pickNearest: (i) => { S.pickNearest(xs, ys, N, (i * 7) % 500, (i * 3) % 400, 18) },',
    '  offer: (i) => { h.offer(i % 5, i % 17) },',
    '  faceInferIO: (i) => { o.u = 0.002 * (i % 900) - 0.9; o.v = 0.001 * (i % 700) - 0.35; o.ppm = 150 + (i % 50); S.faceInferIO(pf, o, 12, 0.05); o.u = 0.002 * (i % 900) - 0.9; S.faceInferIO(cf, o, 12, 0.05) },',
    '  clampIO: (i) => { o2.u = 0.006 * (i % 900) - 2.7; o2.v = 0.009 * (i % 800) - 3.6; S.clampIO(cf, o2); o2.u = 0.006 * (i % 900) - 2.7; S.clampIO(pf, o2) },',
    '  uvOnFaceP: (i) => { q3[0] = 0.3 + 0.0001 * (i % 100); S.uvOnFaceP(pf, F, q3, o); S.uvOnFaceP(cf, F, q3, o) },',
    '  liveBox: (i) => { S.liveBox(boxes, mats, B, out6) },',
    '  faceAtHit: (i) => { S.faceAtHit(faces, M, p, nn, undefined, o) },',
    '  mirrorHitToPrimary: (i) => { S.mirrorHitToPrimary(M, M, (i & 1) ? "xz" : null, p, nn, oP, oN) },',
    '  massCombine: (i) => { mats4[12] = 0.001 * (i % 100); S.massCombine(ma0, ma1, mats4, 2, mout) },',
    '  scalars: (i) => { o.u = 0.002 * (i % 900) - 0.9; o2.v = 0.001 * (i % 700) - 0.35; acc[0] += S.twistDeg(M) + S.snapTo(o.u, 0.05) + S.snapAngle(o2.v * 100, 15) }',
    '}',
    'const noop = () => {}',
    'const res = {}',
    'for (const k of Object.keys(F_)) {',
    '  const fn = F_[k]',
    '  let got = Infinity',
    '  for (let round = 0; round < 4 && got > 4; round++) { for (let i = 0; i < 20000; i++) fn(i); for (let i = 0; i < 2000; i++) noop(i); got = perFrame(fn, 200) - perFrame(noop, 200) }',
    '  res[k] = got',
    '}',
    'console.log(JSON.stringify({ res, acc: Number.isFinite(acc[0]) }))'
  ].join('\n')
  const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8', timeout: 120000 }).trim().split('\n').pop())
  assert.ok(res.acc)
  assert.equal(Object.keys(res.res).length, 10)
  for (const [k, v] of Object.entries(res.res)) assert.ok(v <= 4, `${k} 每帧分配 ${v.toFixed(1)} B`)
})

console.log(`modelAsmSnap: ${n} 项通过`)
