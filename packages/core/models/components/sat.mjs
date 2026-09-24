// 卫星领域装配组件（三期契约 DESIGN3 E2 / §1 P1；装配调研 assembly-ux §4「卫星（13）」）+ 两个通用基本体。
//
// 纯 ESM、零 three 依赖。几何与质量元一律复用 meshKit 原语与 paramBus 的子生成器（buildWing / buildReflector / buildFeed），
// 平台体的「结构盒 + MLI + 南北散热面 + 对接环」按 paramBus.buildGeoBus 的式子逐项照写，立方星的内缩结构盒按 buildCubesatLayout
// 的 hb 照写（xM / yM / zM 是包络、质量元按包络，结构盒由 insetXYM / insetZM 缩进）——specToAssembly 转出来的装配件
// 与原参数化整星质量逐项对得上（modelAssembly 单测对拍全部模板）。
// 基本体（prim.*）缺省按「体积 × 平台体等效体密度」计质量，hasMass 关 = 纯外观件。
//
// ★ 局部坐标（DESIGN3 E2）：原点 = 安装基准点、局部 −Z 贴父面（mount 插座 n = −Z）、局部 +X = 滚转零位。
//   例外只在「原点」：平台体（bus.*）原点取几何中心（作根件时 = 本体系原点，与 paramBus / assembly-ux §3.3「卫星用几何中心」一致），
//   作子件时照样由 mount 插座（−Z 面心）定位，安装语义不受影响。
//   太阳翼：翼展沿局部 +Z、电池面朝局部 −X、板宽沿局部 ±Y，原点 = 铰点（SADA 根部）。
//   反射面：原点 = 口径中心背后 shellM 处（安装基准 back），局部 +Z = 口径中心处的抛物面法向 nc，局部 +X = 偏置方向在
//     ⟂nc 平面上的投影；母抛物面轴 a 在局部系里是 (sin θ, 0, cos θ)（tan θ = dc / 2f，正馈 θ = 0）。
//
// ★ 面坐标系（插座 up / 贴面 u 的约定，= 滚转零位）：侧面（±X / ±Y）取 +Z，±Z 面取 +X；v = n × u。
//   于是太阳翼装在盒的 +Y 面、滚转 0° 时与 paramBus 的 +Y 翼逐位相同，装在 −Y 面、滚转 0° 时与 −Y 翼相同。
//
// ★ 缺省参数全部是示意值（source:'illustrative'），取整数量级；不沿用任何具体型号 / 平台的尺寸（2026-09-24 用户：不内置中国型号）。
//   细节档（SADA、轭杆、板厚、反射面边缘厚……）取 paramTemplates.DETAIL_PRESETS.geo，与生成页同一套示意值。
//
// ★ 名字：组件内部的节点 / 挂点 / 关节 / 太阳翼组名是短名（'bus' / 'wing_1_cells' / 'axis' / 'focus'），
//   装配件出 IR 时一律加组件前缀 `${前缀}_`（assembly.mjs）；这里的短名只能含 [A-Za-z0-9_+-]。
//
// 导出：
//   SAT_COMPONENTS  13 个卫星组件定义（sat.bus.box / sat.bus.cyl / sat.bus.hex / sat.wing / sat.reflector / sat.feed.horn /
//                   sat.array.phased / sat.tower / sat.boom / sat.thruster / sat.radiator / sat.sensor.star / sat.sensor.sun）
//   PRIM_COMPONENTS 通用基本体（prim.box / prim.cyl，所有领域可用）
//   FACE_FRAMES     盒面 id → {n, u}（面坐标系约定，单测与编辑器共用）
//   reflectorFrame(p) → 反射面局部系几何（specToAssembly 由母抛物面位姿反推组件位姿用）
//   satSpecToComps(spec) → {comps, warnings}：paramBus 整星 spec（已 normalizeSpec）→ 装配组件列表（specToAssembly 的内核）

import {
  isNum, isVec3, add, sub, scl, dot, cross, len, nrm, reject, madd, clampN, z0, IDR, rApply,
  MB, quad, box, frustum, tube, annulus, horn, uniq, addItem, comp, boxComp, plateComp, rodComp, shellComp, pointComp, perpPair, paraLayout
} from '../meshKit.mjs'
import { buildWing, buildReflector, buildFeed, MATERIALS, SOLAR_EFFICIENCY_DEFAULT } from '../paramBus.mjs'
import { DETAIL_PRESETS } from '../paramTemplates.mjs'
import { matToQuat } from '../bodyFrame.mjs'

const ALL_DOMAINS = ['spacecraft', 'ground', 'aircraft', 'ship', 'vehicle']
const SAT = ['spacecraft']
const G = DETAIL_PRESETS.geo
const ILL = 'illustrative'
const GEO_NOTE = '示意值（GEO 通信平台量级的整数）'

// ───────────────────────────── 参数定义小工具 ─────────────────────────────

const num = (def, unit, label, o = {}) => ({ kind: 'num', def, unit, label, source: ILL, ...o })
const int = (def, label, o = {}) => ({ kind: 'int', def, unit: '', label, source: ILL, ...o })
const bool = (def, label, o = {}) => ({ kind: 'bool', def, label, source: ILL, ...o })
const enm = (def, options, label, o = {}) => ({ kind: 'enum', def, options, label, source: ILL, ...o })
const MLI_OPTIONS = ['none', ...Object.keys(MATERIALS)]

// ───────────────────────────── 插座 / 面 ─────────────────────────────

/** 盒面约定：n = 面外法向，u = 滚转零位（侧面 +Z、±Z 面 +X），v = n × u。 */
export const FACE_FRAMES = Object.freeze({
  '+X': Object.freeze({ n: [1, 0, 0], u: [0, 0, 1] }), '-X': Object.freeze({ n: [-1, 0, 0], u: [0, 0, 1] }),
  '+Y': Object.freeze({ n: [0, 1, 0], u: [0, 0, 1] }), '-Y': Object.freeze({ n: [0, -1, 0], u: [0, 0, 1] }),
  '+Z': Object.freeze({ n: [0, 0, 1], u: [1, 0, 0] }), '-Z': Object.freeze({ n: [0, 0, -1], u: [1, 0, 0] })
})
const FACE_IDS = ['+X', '-X', '+Y', '-Y', '+Z', '-Z']
const axisOf = (v) => (v[0] !== 0 ? 0 : v[1] !== 0 ? 1 : 2)
const vz = (v) => v.map(z0)

/** 插座描述（assembly-ux §3.2）：size = 名义接口尺寸（米）、roll = 滚转档（度）、accepts = 可接的 type 前缀（null = 不限）。 */
const sock = (id, pos, n, up, size, roll = 90, accepts = null) => ({ id, pos, n, up, size, accepts, roll })
const ROOT_SOCKET = (size, roll = 90) => sock('root', [0, 0, 0], [0, 0, -1], [1, 0, 0], size, roll)
/** 盒（中心 c、半边长 h）的若干面。 */
function boxFaces(c, h, ids = FACE_IDS) {
  return ids.map((id) => {
    const { n, u } = FACE_FRAMES[id]
    const v = vz(cross(n, u))
    return { id, kind: 'plane', origin: vz(madd(c, n, h[axisOf(n)])), n: n.slice(), u: u.slice(), v, halfU: h[axisOf(u)], halfV: h[axisOf(v)] }
  })
}
const boxSockets = (c, h, ids = FACE_IDS) => boxFaces(c, h, ids).map((f) => sock(f.id, f.origin, f.n, f.u, 2 * Math.min(f.halfU, f.halfV)))
/** 柱面（轴 axis、圆周零位 ref、半径 r；uv0 = 沿轴高度，uv1 = 弧长）。 */
const cylFace = (id, origin, axis, ref, radius, halfU) => ({ id, kind: 'cyl', origin, axis, ref, radius, halfU, halfV: Math.PI * radius })

// ───────────────────────────── 上下文后处理 ─────────────────────────────

/** 局部挂点：up 为 null = 到本体系再按 D1 缺省规则补（组件局部系里补会错）。 */
function apLocal(ctx, name, pos, dir, up = null) {
  const d = nrm(dir)
  let u = null
  if (up) { const r = reject(up, d); if (len(r) > 1e-6) u = nrm(r) }
  ctx.aps.push({ name: uniq(ctx, name), posBody: pos.slice(), dirBody: d, upBody: u })
}

/** 改名（节点 / 质量元 / 部件 / 挂点 / 关节 / 太阳翼组一起改；pn 改部件显示名）。改完查重。 */
function renameCtx(ctx, fn, pn = (s) => s) {
  const names = new Set()
  const put = (n) => { if (names.has(n)) throw new Error(`组件内部名重复：${n}`); names.add(n); return n }
  for (const it of ctx.items) {
    it.name = put(fn(it.name))
    if (it.part) it.part = { ...it.part, id: fn(it.part.id), name: pn(it.part.name || '') }
  }
  for (const c of ctx.comps) c.name = fn(c.name)
  const parts = new Map()
  for (const p of ctx.parts.values()) { p.id = fn(p.id); p.name = pn(p.name); p.nodes = p.nodes.map(fn); parts.set(p.id, p) }
  ctx.parts = parts
  for (const a of ctx.aps) a.name = put(fn(a.name))
  for (const a of ctx.arts) { a.name = fn(a.name); a.nodes = a.nodes.map(fn) }
  for (const g of ctx.spg) { g.name = fn(g.name); g.nodes = g.nodes.map(fn) }
  ctx.names = names
}

/** 删掉若干节点（连带部件节点表）。 */
function dropItems(ctx, list) {
  const drop = new Set(list)
  ctx.items = ctx.items.filter((it) => !drop.has(it.name))
  for (const p of ctx.parts.values()) p.nodes = p.nodes.filter((n) => !drop.has(n))
  for (const n of list) ctx.names.delete(n)
}

/** 3×3 张量（行主序 9 元）按旋转 R（列向量形式）转：M·I·Mᵀ，M[i][j] = R[j][i]。 */
function rotTensor(R, I) {
  const M = (i, j) => R[j][i]
  const o = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0
    for (let k = 0; k < 3; k++) for (let l = 0; l < 3; l++) s += M(i, k) * I[3 * k + l] * M(j, l)
    o[3 * i + j] = s
  }
  return o
}

/** 整个上下文左乘旋转 R（列向量形式）：节点局部系、质量元、部件法向 / 拟合几何、挂点。R 为轴置换时结果逐位精确。 */
function transformCtx(ctx, R) {
  const rv = (v) => rApply(R, v)
  for (const it of ctx.items) { it.R = [rv(it.R[0]), rv(it.R[1]), rv(it.R[2])]; it.t = rv(it.t) }
  for (const c of ctx.comps) { c.com = rv(c.com); c.I = rotTensor(R, c.I) }
  for (const p of ctx.parts.values()) {
    if (p.normalBody) p.normalBody = rv(p.normalBody)
    if (p.fitted) p.fitted = { ...p.fitted, vertexBody: rv(p.fitted.vertexBody), axisBody: rv(p.fitted.axisBody), focusBody: rv(p.fitted.focusBody) }
  }
  for (const a of ctx.aps) { a.posBody = rv(a.posBody); a.dirBody = rv(a.dirBody); if (a.upBody) a.upBody = rv(a.upBody) }
}

// 质量元小工具（unitMass 用，按 1 kg 给）
const boxElem = (name, m, c, h) => ({ name, kind: 'box', massKg: m, com: c, I: [m * ((2 * h[1]) ** 2 + (2 * h[2]) ** 2) / 12, 0, 0, 0, m * ((2 * h[0]) ** 2 + (2 * h[2]) ** 2) / 12, 0, 0, 0, m * ((2 * h[0]) ** 2 + (2 * h[1]) ** 2) / 12] })
const cylElem = (name, m, c, r, hh) => { const it = m * (3 * r * r + hh * hh) / 12; return { name, kind: 'cylinder', massKg: m, com: c, I: [it, 0, 0, 0, it, 0, 0, 0, m * r * r / 2] } }
const evenSym = (seg) => (seg % 2 === 0 ? ['yz', 'xz'] : ['xz'])

// ───────────────────────────── 通用基本体 ─────────────────────────────
//
// 缺省计质量：体积 × 平台体等效体密度（DENSITY.busVolume，示意值；装配件 density.busVolume 可覆盖）——非卫星领域在 P1 只有这两件，
// 纯基本体的文档也要能生成（总质量 0 会被 buildAssembly 拒收）。hasMass 关 = 纯外观件（specToAssembly 的导轨 / 贴片 / 铰座用）。

const HAS_MASS = bool(true, '计质量', { title: '关 = 纯外观件（无质量）；开 = 体积 × 平台体等效体密度（density.busVolume）。组件「质量」手填时按手填值' })

const primBox = {
  type: 'prim.box', domain: ALL_DOMAINS, title: 'Box', titleZh: '盒', role: 'other',
  params: {
    xM: num(0.5, 'm', '长', { gt: 0, labelEn: 'X' }),
    yM: num(0.5, 'm', '宽', { gt: 0, labelEn: 'Y' }),
    zM: num(0.5, 'm', '高', { gt: 0, labelEn: 'Z' }),
    hasMass: HAS_MASS
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.xM, p.yM)), ...boxSockets([0, 0, p.zM / 2], [p.xM / 2, p.yM / 2, p.zM / 2], ['+X', '-X', '+Y', '-Y', '+Z'])],
  faces: (p) => boxFaces([0, 0, p.zM / 2], [p.xM / 2, p.yM / 2, p.zM / 2], ['+X', '-X', '+Y', '-Y', '+Z']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const c = [0, 0, p.zM / 2], h = [p.xM / 2, p.yM / 2, p.zM / 2]
    const mb = new MB(); box(mb, c, h)
    addItem(ctx, { name: 'box', role: 'other', part: { id: 'box', name: '盒', role: 'other' }, mat: 'aluminum', mb })
    if (p.hasMass) boxComp(ctx, 'box', ctx.dens.busVolume * p.xM * p.yM * p.zM, c, h)
    return ctx
  },
  unitMass: (p) => [boxElem('box', 1, [0, 0, p.zM / 2], [p.xM / 2, p.yM / 2, p.zM / 2])],
  symmetricPlanes: ['yz', 'xz']
}

const primCyl = {
  type: 'prim.cyl', domain: ALL_DOMAINS, title: 'Cylinder', titleZh: '柱', role: 'other',
  params: {
    dM: num(0.3, 'm', '直径', { gt: 0 }),
    hM: num(0.5, 'm', '高', { gt: 0 }),
    seg: int(32, '分段', { min: 6, max: 128 }),
    hasMass: HAS_MASS
  },
  sockets: (p) => [ROOT_SOCKET(p.dM, 15), sock('+Z', [0, 0, p.hM], [0, 0, 1], [1, 0, 0], p.dM, 15)],
  faces: (p) => [
    { id: '+Z', kind: 'plane', origin: [0, 0, p.hM], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: p.dM / 2, halfV: p.dM / 2 },
    cylFace('side', [0, 0, p.hM / 2], [0, 0, 1], [1, 0, 0], p.dM / 2, p.hM / 2)
  ],
  build(p, kit) {
    const ctx = kit.createCtx()
    const mb = new MB(); frustum(mb, [0, 0, 0], p.dM / 2, [0, 0, p.hM], p.dM / 2, p.seg, true, true)
    addItem(ctx, { name: 'cyl', role: 'other', part: { id: 'cyl', name: '柱', role: 'other' }, mat: 'aluminum', mb })
    if (p.hasMass) {
      const r = p.dM / 2, e = cylElem('cyl', ctx.dens.busVolume * Math.PI * r * r * p.hM, [0, 0, p.hM / 2], r, p.hM)
      comp(ctx, 'cyl', 'cylinder', e.massKg, e.com, e.I)
    }
    return ctx
  },
  unitMass: (p) => [cylElem('cyl', 1, [0, 0, p.hM / 2], p.dM / 2, p.hM)],
  symmetricPlanes: (p) => evenSym(p.seg)
}

// ───────────────────────────── 平台体 ─────────────────────────────

const busCommon = {
  mli: enm('mli_gold', MLI_OPTIONS, 'MLI 包覆', { title: 'none = 不包覆' }),
  massKg: num(null, 'kg', '结构质量', { nullable: true, gt: 0, title: '留空按体密度估算；装配件给了目标质量时由它吃余量' }),
  mliOffM: num(G.mliOffM, 'm', 'MLI 离面', { min: 0, max: 0.5 })
}

/**
 * 盒式平台体的结构盒半边长：xM / yM / zM 是外包络（质量元按包络算，与 paramBus 同），结构盒每侧内缩 insetXYM、两端各内缩 insetZM
 * （立方星：包络 = 导轨外缘，结构盒让出导轨与端脚）。式子与 paramBus.buildCubesatLayout 的 hb 逐式相同；内缩为 0 时恰为包络半边长。
 */
const busHalf = (p) => [p.xM / 2 - p.insetXYM, p.yM / 2 - p.insetXYM, (p.zM - 2 * p.insetZM) / 2]
const ENV_NOTE = '外包络；质量按包络体积估算，结构盒按内缩量缩进'

const busBox = {
  type: 'sat.bus.box', domain: SAT, title: 'Bus (box)', titleZh: '平台体·盒', role: 'bus',
  params: {
    xM: num(2.0, 'm', 'X 边长', { gt: 0, title: ENV_NOTE + '；' + GEO_NOTE }),
    yM: num(2.0, 'm', 'Y 边长', { gt: 0, title: ENV_NOTE + '；' + GEO_NOTE }),
    zM: num(3.0, 'm', 'Z 边长', { gt: 0, title: ENV_NOTE + '；' + GEO_NOTE }),
    mli: busCommon.mli,
    radiators: bool(true, '南北散热面'),
    adapter: bool(true, '对接环'),
    massKg: busCommon.massKg,
    mliOffM: busCommon.mliOffM,
    radiatorFrac: num(G.radiatorFrac, '', '散热面占比', { gt: 0, max: 1 }),
    adapterDM: num(G.adapterDM, 'm', '对接环直径', { gt: 0 }),
    adapterHM: num(G.adapterHM, 'm', '对接环高', { gt: 0 }),
    insetXYM: num(0, 'm', '侧面内缩', { min: 0, title: '结构盒四个侧面各比包络缩进多少（立方星导轨让位）；面 / 插座贴在结构盒上' }),
    insetZM: num(0, 'm', '端面内缩', { min: 0, title: '结构盒两端各比包络缩进多少（立方星导轨端脚）；面 / 插座贴在结构盒上' })
  },
  validate: (p) => (p.xM > 2 * p.insetXYM && p.yM > 2 * p.insetXYM && p.zM > 2 * p.insetZM ? [] : ['内缩超过边长']),
  mountSocket: '-Z',
  sockets: (p) => boxSockets([0, 0, 0], busHalf(p)),
  faces: (p) => boxFaces([0, 0, 0], busHalf(p)),
  massSink: 'bus',
  symmetricPlanes: ['yz', 'xz'],
  // 与 paramBus.buildGeoBus（内缩为 0）/ buildCubesatLayout 的结构盒逐式相同（specToAssembly 质量对拍靠它）
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const h = busHalf(p)
    const busPart = { id: 'bus', name: '平台体', role: 'bus' }
    const mb = new MB(); box(mb, [0, 0, 0], h)
    addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
    boxComp(ctx, 'bus', isNum(p.massKg) ? p.massKg : dens.busVolume * p.xM * p.yM * p.zM, [0, 0, 0], [p.xM / 2, p.yM / 2, p.zM / 2])
    if (p.mli !== 'none') {
      const o = p.mliOffM, mm = new MB()
      quad(mm, [h[0] + o, 0, 0], [0, h[1] * 0.985, 0], [0, 0, h[2] * 0.985])
      quad(mm, [-h[0] - o, 0, 0], [0, 0, h[2] * 0.985], [0, h[1] * 0.985, 0])
      quad(mm, [0, 0, h[2] + o], [h[0] * 0.985, 0, 0], [0, h[1] * 0.985, 0])
      quad(mm, [0, 0, -h[2] - o], [0, h[1] * 0.985, 0], [h[0] * 0.985, 0, 0])
      const it = addItem(ctx, { name: 'bus_mli', role: 'bus', part: busPart, mat: p.mli, mb: mm })
      shellComp(ctx, 'bus_mli', it, dens.mliAreal)
    }
    if (p.radiators) {
      for (const s of [1, -1]) {
        const side = s > 0 ? '+Y' : '-Y', rm = new MB(), fx = h[0] * p.radiatorFrac, fz = h[2] * p.radiatorFrac
        if (s > 0) quad(rm, [0, h[1] + 0.004, 0], [0, 0, fz], [fx, 0, 0]); else quad(rm, [0, -h[1] - 0.004, 0], [fx, 0, 0], [0, 0, fz])
        const it = addItem(ctx, { name: `radiator_${side}`, role: 'radiator', part: { id: `radiator_${side}`, name: `散热面 ${side}`, role: 'radiator' }, mat: 'radiator', mb: rm })
        const sp = shellComp(ctx, `radiator_${side}`, it, dens.radiatorAreal)
        ctx.parts.get(`radiator_${side}`).normalBody = [0, s, 0]
        ctx.parts.get(`radiator_${side}`).areaM2 = sp.area
      }
    }
    if (p.adapter) {
      const rOut = Math.min(p.adapterDM / 2, 0.45 * Math.min(2 * h[0], 2 * h[1])), rIn = rOut * 0.94, hh = p.adapterHM
      const am = new MB(), c0 = [0, 0, -h[2]], c1 = [0, 0, -h[2] - hh]
      frustum(am, c0, rOut, c1, rOut, 48, false, false, false)
      frustum(am, c0, rIn, c1, rIn, 48, false, false, true)
      annulus(am, c1, [0, 0, -1], rIn, rOut, 48, [0, 0, -1])
      addItem(ctx, { name: 'bus_adapter', role: 'bus', part: busPart, mat: 'aluminum', mb: am })
    }
    apLocal(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
    return ctx
  }
}

const busCyl = {
  type: 'sat.bus.cyl', domain: SAT, title: 'Bus (cylinder)', titleZh: '平台体·柱', role: 'bus',
  params: {
    dM: num(2.0, 'm', '直径', { gt: 0 }),
    hM: num(3.0, 'm', '高', { gt: 0 }),
    seg: int(48, '分段', { min: 8, max: 128 }),
    mli: busCommon.mli, massKg: busCommon.massKg, mliOffM: busCommon.mliOffM
  },
  mountSocket: '-Z',
  sockets(p) {
    const r = p.dM / 2, hz = p.hM / 2, sd = Math.min(p.hM, p.dM)
    return [
      sock('+Z', [0, 0, hz], [0, 0, 1], [1, 0, 0], p.dM, 15), sock('-Z', [0, 0, -hz], [0, 0, -1], [1, 0, 0], p.dM, 15),
      sock('+X', [r, 0, 0], [1, 0, 0], [0, 0, 1], sd), sock('-X', [-r, 0, 0], [-1, 0, 0], [0, 0, 1], sd),
      sock('+Y', [0, r, 0], [0, 1, 0], [0, 0, 1], sd), sock('-Y', [0, -r, 0], [0, -1, 0], [0, 0, 1], sd)
    ]
  },
  faces(p) {
    const r = p.dM / 2, hz = p.hM / 2
    return [
      { id: '+Z', kind: 'plane', origin: [0, 0, hz], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: r, halfV: r },
      { id: '-Z', kind: 'plane', origin: [0, 0, -hz], n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0], halfU: r, halfV: r },
      cylFace('side', [0, 0, 0], [0, 0, 1], [1, 0, 0], r, hz)
    ]
  },
  massSink: 'bus',
  symmetricPlanes: (p) => evenSym(p.seg),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const r = p.dM / 2, hz = p.hM / 2
    const busPart = { id: 'bus', name: '平台体', role: 'bus' }
    const mb = new MB(); frustum(mb, [0, 0, -hz], r, [0, 0, hz], r, p.seg, true, true)
    addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
    const m = isNum(p.massKg) ? p.massKg : dens.busVolume * Math.PI * r * r * p.hM
    const e = cylElem('bus', m, [0, 0, 0], r, p.hM)
    comp(ctx, 'bus', 'cylinder', m, e.com, e.I)
    if (p.mli !== 'none') {
      const mm = new MB(), ro = r + p.mliOffM
      frustum(mm, [0, 0, -hz * 0.985], ro, [0, 0, hz * 0.985], ro, p.seg, false, false)
      const it = addItem(ctx, { name: 'bus_mli', role: 'bus', part: busPart, mat: p.mli, mb: mm })
      shellComp(ctx, 'bus_mli', it, dens.mliAreal)
    }
    apLocal(ctx, 'nadir_center', [0, 0, hz], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -hz], [0, 0, -1])
    return ctx
  }
}

/** 正六棱柱（对边距 s，侧面法向 0°/60°/…/300°，side0 朝 +X）。 */
function hexGeom(p) {
  const a = p.acrossFlatsM / 2, R = a / Math.cos(Math.PI / 6), hz = p.hM / 2
  const sides = []
  for (let k = 0; k < 6; k++) {
    const th = (k * Math.PI) / 3, n = [Math.cos(th), Math.sin(th), 0].map(z0)
    sides.push({ id: `side${k}`, n, origin: scl(n, a).map(z0), v: vz(cross(n, [0, 0, 1])) })
  }
  const corners = []
  for (let k = 0; k < 6; k++) { const th = (k * Math.PI) / 3 - Math.PI / 6; corners.push([R * Math.cos(th), R * Math.sin(th)]) }
  return { a, R, hz, sides, corners }
}

const busHex = {
  type: 'sat.bus.hex', domain: SAT, title: 'Bus (hexagonal)', titleZh: '平台体·六棱', role: 'bus',
  params: {
    acrossFlatsM: num(2.0, 'm', '对边距', { gt: 0 }),
    hM: num(3.0, 'm', '高', { gt: 0 }),
    mli: busCommon.mli, massKg: busCommon.massKg, mliOffM: busCommon.mliOffM
  },
  mountSocket: '-Z',
  sockets(p) {
    const g = hexGeom(p)
    return [...g.sides.map((s) => sock(s.id, s.origin, s.n, [0, 0, 1], Math.min(p.hM, g.R))), sock('+Z', [0, 0, g.hz], [0, 0, 1], [1, 0, 0], p.acrossFlatsM, 60), sock('-Z', [0, 0, -g.hz], [0, 0, -1], [1, 0, 0], p.acrossFlatsM, 60)]
  },
  faces(p) {
    const g = hexGeom(p)
    return [
      ...g.sides.map((s) => ({ id: s.id, kind: 'plane', origin: s.origin, n: s.n, u: [0, 0, 1], v: s.v, halfU: g.hz, halfV: g.R / 2 })),
      { id: '+Z', kind: 'plane', origin: [0, 0, g.hz], n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], halfU: g.a, halfV: g.R },
      { id: '-Z', kind: 'plane', origin: [0, 0, -g.hz], n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0], halfU: g.a, halfV: g.R }
    ]
  },
  massSink: 'bus',
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const g = hexGeom(p)
    const busPart = { id: 'bus', name: '平台体', role: 'bus' }
    const mb = new MB()
    for (const s of g.sides) quad(mb, s.origin, [0, 0, g.hz], scl(s.v, g.R / 2))
    for (const zs of [1, -1]) {
      const n = [0, 0, zs], c = mb.v([0, 0, zs * g.hz], n, 0, 0), ring = mb.vcount
      for (const [x, y] of g.corners) mb.v([x, y, zs * g.hz], n, x, y)
      for (let k = 0; k < 6; k++) { const a = ring + k, b = ring + ((k + 1) % 6); if (zs > 0) mb.t(c, a, b); else mb.t(c, b, a) }
    }
    addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
    // 实心正六棱柱：面积 (3√3/2)R²；对轴 I = m·5R²/12，横向 m(5R²/24 + h²/12)
    const V = 1.5 * Math.sqrt(3) * g.R * g.R * p.hM
    const m = isNum(p.massKg) ? p.massKg : dens.busVolume * V
    const it = m * (5 * g.R * g.R / 24 + p.hM * p.hM / 12)
    comp(ctx, 'bus', 'hexPrism', m, [0, 0, 0], [it, 0, 0, 0, it, 0, 0, 0, m * 5 * g.R * g.R / 12])
    if (p.mli !== 'none') {
      const mm = new MB()
      for (const s of g.sides) quad(mm, madd(s.origin, s.n, p.mliOffM), [0, 0, g.hz * 0.985], scl(s.v, g.R / 2 * 0.985))
      const im = addItem(ctx, { name: 'bus_mli', role: 'bus', part: busPart, mat: p.mli, mb: mm })
      shellComp(ctx, 'bus_mli', im, dens.mliAreal)
    }
    apLocal(ctx, 'nadir_center', [0, 0, g.hz], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -g.hz], [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 太阳翼 ─────────────────────────────

// buildWing 在「整星口径」里建 +Y 翼（翼展 +Y、电池面 −Z、铰点 0）；再整体换到组件局部系：
// x_L = z_C、y_L = x_C、z_L = y_C（轴置换，逐位精确）→ 翼展 +Z_L、电池面 −X_L。
const Q_WING = [[0, 1, 0], [0, 0, 1], [1, 0, 0]]

const wing = {
  type: 'sat.wing', domain: SAT, title: 'Solar array wing', titleZh: '太阳翼', role: 'solarArray',
  params: {
    panels: int(4, '板数', { min: 1, max: 20 }),
    panelHM: num(3.0, 'm', '板长', { gt: 0, title: `沿翼展；${GEO_NOTE}` }),
    panelWM: num(2.0, 'm', '板宽', { gt: 0, title: GEO_NOTE }),
    sidePanels: int(0, '侧板', { options: [0, 2] }),
    yokeLenM: num(G.yokeLenM, 'm', '轭长', { min: 0 }),
    gapM: num(G.gapM, 'm', '板间缝', { min: 0 }),
    tiltDeg: num(0, '°', '绕翼轴转角', { min: -180, max: 180, title: '0° 电池面朝安装面滚转零位的反方向' }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '效率', { min: 0, max: 100 }),
    articulate: bool(true, '转动关节'),
    sadaLenM: num(G.sadaLenM, 'm', 'SADA 长', { min: 0 }),
    sadaDM: num(G.sadaDM, 'm', 'SADA 直径', { min: 0 }),
    yokeRodDM: num(G.yokeRodDM, 'm', '轭杆直径', { gt: 0 }),
    panelTM: num(G.panelTM, 'm', '基板厚', { gt: 0 }),
    cellMarginM: num(G.cellMarginM, 'm', '电池片边距', { min: 0 }),
    sadaMassKg: num(null, 'kg', 'SADA 质量', { nullable: true, gt: 0 })
  },
  validate: (p) => (p.sadaLenM > 0 && !(p.sadaDM > 0) ? ['SADA 直径须为正数'] : []),
  // 根部接口：有 SADA 取 SADA 直径，没有（铰链展开板）取板宽
  sockets: (p) => [ROOT_SOCKET(p.sadaLenM > 0 && p.sadaDM > 0 ? p.sadaDM : p.panelWM)],
  // 几何关于局部 xz 面（板宽方向）对称，唯一带手性的参数是绕翼轴转角：关于 xz 面镜像 = 转角取反
  mirrorPlanes: ['xz'],
  mirror: (p, plane) => (plane === 'xz' ? { ...p, tiltDeg: p.tiltDeg === 0 ? 0 : -p.tiltDeg } : null),
  build(p, kit) {
    const ctx = kit.createCtx()
    const w = { side: '+Y', panels: p.panels, panelHM: p.panelHM, panelWM: p.panelWM, sidePanels: p.sidePanels, yokeLenM: p.yokeLenM, gapM: p.gapM, tiltDeg: p.tiltDeg, efficiency: p.efficiency, hingeBody: [0, 0, 0] }
    buildWing(ctx, w, { sadaLenM: p.sadaLenM, sadaDM: p.sadaDM, yokeRodDM: p.yokeRodDM, panelTM: p.panelTM, cellMarginM: p.cellMarginM, articulate: p.articulate, sadaMassKg: p.sadaMassKg })
    for (const a of ctx.aps) a.upBody = null
    renameCtx(ctx, (n) => (n === 'wing_+Y_axis' ? 'axis' : n.replace(/^wing_\+Y/, 'wing')), (s) => s.replace(/ \+Y$/, ''))
    transformCtx(ctx, Q_WING)
    return ctx
  }
}

// ───────────────────────────── 反射面 ─────────────────────────────

/**
 * 反射面组件的局部系几何（全部在局部系；P 系 = 母抛物面系：顶点 0、轴 +Z、偏置 +X）。
 * @returns {{Dm, f, dc, k, mesh, s, c, B:number[], F, a, u, Pc}}  B = 安装基准在 P 系的坐标；
 *   局部系 = P 系绕 Y 转 −θ 并平移到 B：x_L = (c,0,s)_P、y_L = (0,1,0)_P、z_L = (−s,0,c)_P。
 */
export function reflectorFrame(p) {
  const Dm = p.diameterM, k = p.detailScale
  const f = isNum(p.focalM) ? p.focalM : p.fD * Dm
  const dc = isNum(p.offsetHM) ? p.offsetHM : Dm / 2 + 0.1 * k
  const mesh = p.surface === 'mesh' || (p.surface === 'auto' && Dm > p.meshAboveDM)
  const g = dc / (2 * f), nn = Math.hypot(g, 1), s = g / nn, c = 1 / nn
  const sh = p.shellM
  const B = [dc + s * sh, 0, dc * dc / (4 * f) - c * sh]
  const toL = (v) => { const w0 = v[0] - B[0], w2 = v[2] - B[2]; return [c * w0 + s * w2, v[1], -s * w0 + c * w2] }
  const dirL = (v) => [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]]
  return { Dm, f, dc, k, mesh, s, c, B, F: toL([0, 0, f]), a: dirL([0, 0, 1]), u: dirL([1, 0, 0]), Pc: toL([dc, 0, dc * dc / (4 * f)]) }
}

const FEED_ACCEPTS = Object.freeze(['sat.feed.', 'sat.array.', 'prim.'])

const reflector = {
  type: 'sat.reflector', domain: SAT, title: 'Reflector antenna', titleZh: '反射面', role: 'reflector',
  params: {
    diameterM: num(2.5, 'm', '口径', { gt: 0 }),
    focalM: num(null, 'm', '焦距', { nullable: true, gt: 0, title: '留空按焦径比' }),
    fD: num(G.fdSolid, '', '焦径比', { gt: 0 }),
    offsetHM: num(null, 'm', '偏置', { nullable: true, min: 0, title: '口径中心到母轴距离；0 = 正馈；留空 = 半口径 + 0.1 m' }),
    surface: enm('auto', ['auto', 'solid', 'mesh'], '反射面', { title: 'auto：口径大于网状门限按网状' }),
    back: bool(true, '背壳'),
    feed: enm('horn', ['horn', 'array', 'none'], '自带馈源'),
    feedApertureM: num(null, 'm', '馈源口径', { nullable: true, gt: 0 }),
    shellM: num(G.shellM, 'm', '边缘厚', { gt: 0 }),
    trussDepthFrac: num(G.meshTrussDepthFrac, '', '桁架深 / 口径', { gt: 0 }),
    trussRodFrac: num(G.meshTrussRodFrac, '', '桁架杆半径 / 口径', { gt: 0 }),
    meshAboveDM: num(G.meshAboveDM, 'm', '网状门限', { gt: 0 }),
    detailScale: num(G.reflDetailScale, '', '附件比例', { gt: 0 })
  },
  mountSocket: 'back',
  sockets(p) {
    const g = reflectorFrame(p)
    // 焦点插座的名义尺寸 = 自带馈源口径（缺省式同 paramBus.buildFeed 喇叭）；只接馈源类与基本体
    const fa = isNum(p.feedApertureM) ? p.feedApertureM : clampN(0.08 * g.Dm, 0.1 * g.k, 0.4 * g.k)
    return [sock('back', [0, 0, 0], [0, 0, -1], [1, 0, 0], 0.2 * g.Dm), sock('focus', g.F, nrm(sub(g.F, g.Pc)), [1, 0, 0], fa, 15, FEED_ACCEPTS)]
  },
  // 偏置抛物面关于「母轴 + 偏置方向」所在平面（局部 xz）对称；正馈另关于 yz 对称
  symmetricPlanes: (p) => (reflectorFrame(p).dc === 0 ? ['yz', 'xz'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx({ D: { shellM: p.shellM, meshTrussDepthFrac: p.trussDepthFrac, meshTrussRodFrac: p.trussRodFrac } })
    const g = reflectorFrame(p)
    const L = paraLayout(g.F, g.a, g.u, g.f, g.Dm, g.dc, g.k)
    L.mesh = g.mesh
    buildReflector(ctx, {}, 0, L)
    if (!g.mesh && !p.back) dropItems(ctx, ['reflector_1_back', 'reflector_1_rim'])
    if (p.feed !== 'none') buildFeed(ctx, { feedType: p.feed, feedApertureM: p.feedApertureM }, 0, L, null)
    for (const a of ctx.aps) a.upBody = null
    renameCtx(ctx, (n) => (n === 'reflector_1_focus' ? 'focus' : n.replace(/^reflector_1/, 'reflector').replace(/^feed_1/, 'feed')), (s) => s.replace(/ 1$/, ''))
    return ctx
  }
}

// ───────────────────────────── 馈源 / 相控阵 / 塔 / 杆 ─────────────────────────────

const feedLen = (p) => (p.kind === 'patch' ? 0.005 : isNum(p.lengthM) ? p.lengthM : 1.6 * p.apertureM)

const feedHorn = {
  type: 'sat.feed.horn', domain: SAT, title: 'Feed horn', titleZh: '馈源喇叭', role: 'feed',
  params: {
    kind: enm('horn', ['horn', 'patch'], '形式'),
    apertureM: num(0.2, 'm', '口径', { gt: 0 }),
    lengthM: num(null, 'm', '长度', { nullable: true, gt: 0, title: '留空 = 1.6 × 口径' }),
    seg: int(24, '分段', { min: 6, max: 96 })
  },
  // root = 喉部（贴面安装）；aperture = 口面中心（接反射面焦点插座时用它当 mount：口面朝口径中心）
  sockets: (p) => [ROOT_SOCKET(p.apertureM, 15), sock('aperture', [0, 0, feedLen(p)], [0, 0, 1], [1, 0, 0], p.apertureM, 15)],
  symmetricPlanes: (p) => (p.kind === 'patch' ? ['yz', 'xz'] : evenSym(p.seg)),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const m = new MB(), L = feedLen(p)
    if (p.kind === 'patch') {
      // 与 paramBus 显式附加馈源的 patchArray 同式：两片正方形（口面 + 背面），面密度按喇叭板
      const a = p.apertureM / 2, [e1, e2] = perpPair([0, 0, 1])
      quad(m, [0, 0, L], scl(e1, a), scl(e2, a)); quad(m, [0, 0, 0], scl(e2, a), scl(e1, a))
    } else horn(m, [0, 0, L], [0, 0, 1], p.apertureM / 2, L, p.seg)
    const it = addItem(ctx, { name: 'feed', role: 'feed', part: { id: 'feed', name: '馈源', role: 'feed' }, mat: p.kind === 'patch' ? 'white_paint' : 'aluminum', mb: m })
    const sp = shellComp(ctx, 'feed', it, dens.hornAreal)
    const part = ctx.parts.get('feed'); part.areaM2 = sp.area; part.normalBody = [0, 0, 1]
    return ctx
  }
}

const arrayPhased = {
  type: 'sat.array.phased', domain: SAT, title: 'Phased array panel', titleZh: '相控阵面', role: 'feed',
  params: {
    wM: num(1.0, 'm', '宽', { gt: 0 }),
    hM: num(1.0, 'm', '长', { gt: 0 }),
    tM: num(0.015, 'm', '厚', { gt: 0 }),
    tiles: int(1, '分块', { options: [1, 2, 4] }),
    gapM: num(0.02, 'm', '块间缝', { min: 0 }),
    standoffM: num(0.01, 'm', '离面', { min: 0 })
  },
  validate: (p) => {
    const nx = p.tiles >= 4 ? 2 : 1, ny = p.tiles >= 2 ? 2 : 1
    return p.wM - p.gapM * (nx - 1) > 0 && p.hM - p.gapM * (ny - 1) > 0 ? [] : ['块间缝超过阵面尺寸']
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.hM)), sock('front', [0, 0, p.standoffM + p.tM], [0, 0, 1], [1, 0, 0], Math.min(p.wM, p.hM))],
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const nx = p.tiles >= 4 ? 2 : 1, ny = p.tiles >= 2 ? 2 : 1
    const tw = (p.wM - p.gapM * (nx - 1)) / nx, th = (p.hM - p.gapM * (ny - 1)) / ny
    const am = new MB()
    let k = 0, area = 0
    for (let ix = 0; ix < nx; ix++) {
      for (let iy = 0; iy < ny; iy++) {
        const c = [-p.wM / 2 + tw / 2 + ix * (tw + p.gapM), -p.hM / 2 + th / 2 + iy * (th + p.gapM), p.standoffM + p.tM / 2]
        box(am, c, [tw / 2, th / 2, p.tM / 2], ['+x', '-x', '+y', '-y', '+z'])
        plateComp(ctx, `array_${++k}`, dens.arrayAreal * tw * th, c, IDR, tw, th)
        area += tw * th
      }
    }
    addItem(ctx, { name: 'array', role: 'feed', part: { id: 'array', name: '相控阵面', role: 'feed' }, mat: 'white_paint', mb: am })
    const part = ctx.parts.get('array'); part.areaM2 = area; part.normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, p.standoffM + p.tM], [0, 0, 1])
    return ctx
  }
}

const tower = {
  type: 'sat.tower', domain: SAT, title: 'Antenna tower', titleZh: '天线塔', role: 'boom',
  params: { wM: num(G.towerWM, 'm', '截面边长', { gt: 0 }), hM: num(1.0, 'm', '高', { gt: 0 }) },
  sockets: (p) => [ROOT_SOCKET(p.wM), sock('top', [0, 0, p.hM], [0, 0, 1], [1, 0, 0], p.wM), ...boxSockets([0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+X', '-X', '+Y', '-Y'])],
  faces: (p) => boxFaces([0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+X', '-X', '+Y', '-Y', '+Z']),
  symmetricPlanes: ['yz', 'xz'],
  // 与 paramBus.buildReflectors 的天线塔同式（五面盒、对地板塔面密度）
  build(p, kit) {
    const ctx = kit.createCtx()
    const tm = new MB()
    box(tm, [0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+x', '-x', '+y', '-y', '+z'])
    const it = addItem(ctx, { name: 'tower', role: 'boom', part: { id: 'tower', name: '天线塔', role: 'boom' }, mat: 'white_paint', mb: tm })
    shellComp(ctx, 'tower', it, ctx.dens.towerAreal)
    return ctx
  }
}

const boom = {
  type: 'sat.boom', domain: SAT, title: 'Boom', titleZh: '杆件', role: 'boom',
  params: { lengthM: num(1.0, 'm', '长', { gt: 0 }), dM: num(0.05, 'm', '直径', { gt: 0 }), seg: int(10, '分段', { min: 3, max: 64 }) },
  sockets: (p) => [ROOT_SOCKET(p.dM, 15), sock('tip', [0, 0, p.lengthM], [0, 0, 1], [1, 0, 0], p.dM, 15)],
  faces: (p) => [cylFace('side', [0, 0, p.lengthM / 2], [0, 0, 1], [1, 0, 0], p.dM / 2, p.lengthM / 2)],
  symmetricPlanes: (p) => evenSym(p.seg),
  // 质量 = 线密度 × 长（rodComp，与 paramBus 展开臂 / 馈源支架同一口径）
  build(p, kit) {
    const ctx = kit.createCtx()
    const m = new MB(); tube(m, [0, 0, 0], [0, 0, p.lengthM], p.dM / 2, p.seg)
    addItem(ctx, { name: 'boom', role: 'boom', part: { id: 'boom', name: '杆', role: 'boom' }, mat: 'carbon', mb: m })
    rodComp(ctx, 'boom', [0, 0, 0], [0, 0, p.lengthM])
    return ctx
  }
}

// ───────────────────────────── 推力器 / 散热面 / 敏感器 ─────────────────────────────

/** 推力器三型的缺省（细节档示意值；质量取 paramBus.DENSITY 的 laeMass / rcsMass / epMass，可由装配件 density 覆盖）。 */
const THRUSTER = Object.freeze({
  lae: Object.freeze({ exitDM: G.laeExitDM, lengthM: G.laeLenM, seg: 32, frac: 0.4, massKey: 'laeMass', mat: 'titanium', name: '远地点发动机' }),
  rcs: Object.freeze({ exitDM: G.rcsExitDM, lengthM: G.rcsLenM, seg: 12, frac: 0.4, massKey: 'rcsMass', mat: 'titanium', name: '姿轨控推力器' }),
  ep: Object.freeze({ exitDM: DETAIL_PRESETS.leo.thrusterDM, lengthM: DETAIL_PRESETS.leo.thrusterLenM, seg: 20, frac: 0.5, massKey: 'epMass', mat: 'dark_metal', name: '电推力器' })
})
const thrOf = (p) => {
  const K = THRUSTER[p.kind]
  return { K, er: (isNum(p.exitDM) ? p.exitDM : K.exitDM) / 2, L: isNum(p.lengthM) ? p.lengthM : K.lengthM, seg: Number.isInteger(p.seg) ? p.seg : K.seg, frac: isNum(p.massAtFrac) ? p.massAtFrac : K.frac }
}

const thruster = {
  type: 'sat.thruster', domain: SAT, title: 'Thruster', titleZh: '推力器', role: 'thruster',
  params: {
    kind: enm('rcs', ['lae', 'rcs', 'ep'], '类型'),
    exitDM: num(null, 'm', '喷口直径', { nullable: true, gt: 0, title: '留空按类型取示意值' }),
    lengthM: num(null, 'm', '长', { nullable: true, gt: 0, title: '留空按类型取示意值' }),
    seg: int(null, '分段', { nullable: true, min: 6, max: 96 }),
    massAtFrac: num(null, '', '质心位置', { nullable: true, min: 0, max: 1, title: '质点沿喷流方向离安装点的长度比例；留空按类型' })
  },
  sockets: (p) => [ROOT_SOCKET(2 * thrOf(p).er, 15)],
  symmetricPlanes: (p) => evenSym(thrOf(p).seg),
  // 喷流沿局部 +Z；三种外形与 paramBus 的远地点发动机 / 姿轨控推力器 / 电推力器同式
  build(p, kit) {
    const ctx = kit.createCtx()
    const { K, er, L, seg, frac } = thrOf(p)
    const m = new MB(), p0 = [0, 0, 0], p1 = [0, 0, L]
    if (p.kind === 'lae') {
      frustum(m, p0, er * 0.35, p1, er, seg, true, false, false)
      frustum(m, p0, er * 0.35 * 0.85, p1, er * 0.94, seg, false, false, true)
    } else if (p.kind === 'ep') frustum(m, p0, er, p1, er * 0.8, seg, false, true, false)
    else frustum(m, p0, er * 0.35, p1, er, seg, true, false, false)
    addItem(ctx, { name: 'thruster', role: 'thruster', part: { id: 'thruster', name: K.name, role: 'thruster' }, mat: K.mat, mb: m })
    pointComp(ctx, 'thruster', ctx.dens[K.massKey], [0, 0, L * frac])
    return ctx
  }
}

const radiator = {
  type: 'sat.radiator', domain: SAT, title: 'Radiator / body cells', titleZh: '散热面', role: 'radiator',
  params: {
    wM: num(1.0, 'm', '宽', { gt: 0 }),
    hM: num(1.0, 'm', '长', { gt: 0 }),
    tM: num(0, 'm', '厚', { min: 0 }),
    kind: enm('radiator', ['radiator', 'cells'], '面型', { title: 'cells = 体装电池片（单独成太阳翼组）' }),
    standoffM: num(0.004, 'm', '离面', { min: -0.1, max: 0.5 }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '效率', { min: 0, max: 100 })
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.hM))],
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const cells = p.kind === 'cells'
    const m = new MB(), w = p.wM / 2, h = p.hM / 2
    if (p.tM > 0) box(m, [0, 0, p.standoffM + p.tM / 2], [w, h, p.tM / 2], ['+x', '-x', '+y', '-y', '+z'])
    else quad(m, [0, 0, p.standoffM], [w, 0, 0], [0, h, 0])
    const name = cells ? 'cells' : 'radiator', role = cells ? 'solarArray' : 'radiator'
    addItem(ctx, { name, role, part: { id: name, name: cells ? '体装电池片' : '散热面', role }, mat: cells ? 'solar_cell' : 'radiator', mb: m })
    plateComp(ctx, name, (cells ? dens.cellAreal : dens.radiatorAreal) * p.wM * p.hM, [0, 0, p.standoffM + (p.tM > 0 ? p.tM / 2 : 0)], IDR, p.wM, p.hM)
    const part = ctx.parts.get(name); part.areaM2 = p.wM * p.hM; part.normalBody = [0, 0, 1]
    if (cells) ctx.spg.push({ name: 'cells', nodes: ['cells'], efficiency: p.efficiency })
    return ctx
  }
}

const sensorStar = {
  type: 'sat.sensor.star', domain: SAT, title: 'Star tracker', titleZh: '星敏感器', role: 'sensor',
  params: {
    bodyM: num(0.12, 'm', '本体边长', { gt: 0 }),
    hoodDM: num(0.1, 'm', '遮光罩口径', { gt: 0 }),
    hoodLenM: num(0.15, 'm', '遮光罩长', { gt: 0 }),
    seg: int(24, '分段', { min: 6, max: 96 })
  },
  sockets: (p) => [ROOT_SOCKET(p.bodyM)],
  symmetricPlanes: (p) => evenSym(p.seg),
  build(p, kit) {
    const ctx = kit.createCtx()
    const b = p.bodyM, r1 = p.hoodDM / 2, r0 = r1 * 0.7, top = [0, 0, b + p.hoodLenM]
    const bm = new MB(); box(bm, [0, 0, b / 2], [b / 2, b / 2, b / 2])
    const part = { id: 'sensor', name: '星敏感器', role: 'sensor' }
    addItem(ctx, { name: 'body', role: 'sensor', part, mat: 'dark_metal', mb: bm })
    const hm = new MB()
    frustum(hm, [0, 0, b], r0, top, r1, p.seg, false, false, false)
    frustum(hm, [0, 0, b], r0 * 0.95, top, r1 * 0.95, p.seg, false, false, true)
    addItem(ctx, { name: 'hood', role: 'sensor', part, mat: 'mli_black', mb: hm })
    ctx.parts.get('sensor').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', top, [0, 0, 1])
    return ctx
  },
  unitMass: (p) => [boxElem('body', 1, [0, 0, p.bodyM / 2], [p.bodyM / 2, p.bodyM / 2, p.bodyM / 2])]
}

const sensorSun = {
  type: 'sat.sensor.sun', domain: SAT, title: 'Sun sensor', titleZh: '太阳敏感器', role: 'sensor',
  params: { wM: num(0.06, 'm', '宽', { gt: 0 }), lM: num(0.06, 'm', '长', { gt: 0 }), tM: num(0.02, 'm', '高', { gt: 0 }) },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.lM))],
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'sensor', name: '太阳敏感器', role: 'sensor' }
    const bm = new MB(); box(bm, [0, 0, p.tM / 2], [p.wM / 2, p.lM / 2, p.tM / 2])
    addItem(ctx, { name: 'body', role: 'sensor', part, mat: 'dark_metal', mb: bm })
    const wm = new MB(); quad(wm, [0, 0, p.tM + 0.0005], [p.wM * 0.3, 0, 0], [0, p.lM * 0.3, 0])
    addItem(ctx, { name: 'window', role: 'sensor', part, mat: 'glass', mb: wm })
    ctx.parts.get('sensor').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, p.tM], [0, 0, 1])
    return ctx
  },
  unitMass: (p) => [boxElem('body', 1, [0, 0, p.tM / 2], [p.wM / 2, p.lM / 2, p.tM / 2])]
}

export const PRIM_COMPONENTS = Object.freeze([primBox, primCyl])
export const SAT_COMPONENTS = Object.freeze([busBox, busCyl, busHex, wing, reflector, feedHorn, arrayPhased, tower, boom, thruster, radiator, sensorStar, sensorSun])

// ───────────────────────────── paramBus 整星 spec → 装配组件 ─────────────────────────────
//
// 逐条复刻 paramBus 三个布局族的摆放规则（槽位 / 净空 / 塔高 / 展开臂 / 馈源支架……这些都不导出，只能照式重写），
// 让转出来的装配件与原整星「质量元一一对应」：总质量、质心、惯量都对得上（单测对拍全部模板）。
// 立方星：平台体 xM / yM / zM 取导轨包络、结构盒按细节档内缩（insetXYM / insetZM，与 paramBus 的 hb 同式），质量元按包络；
// 导轨、对地贴片、铰座、地球敏感器是无质量外观件（prim.* 且 hasMass 关），与原生成器一样只画不计质量。

const colsToRows = (R) => [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]]
/** 旋转（列向量形式）→ 规范四元数 [x,y,z,w]。 */
const quatOf = (R) => {
  const q = matToQuat(colsToRows(R))
  if (!q) throw new Error('satSpecToComps：位姿不是旋转矩阵（内部错误）')
  return q
}
const mulR = (A, B) => [rApply(A, B[0]), rApply(A, B[1]), rApply(A, B[2])]
const trR = (R) => colsToRows(R)   // 列向量形式的转置 = 行向量形式重读
/** 子位姿（本体系 {R,t}）相对父位姿的 t / q。 */
function rel(parent, R, t) {
  const Rt = trR(parent.R)
  return { t: rApply(Rt, sub(t, parent.t)).map(z0), q: quatOf(mulR(Rt, R)) }
}
/** 以 d 为 +Z 的确定性局部系（x 取 X 或 Y 去掉 d 分量）。 */
function frameZ(d) {
  const z = nrm(d), [x] = perpPair(z)
  return [x, cross(z, x), z]
}
/** 盒面插座 / 面心坐标系（与 assembly.mjs 解算同一口径：z = n、x = u、y = z × x）。 */
function faceFrame(id, h) {
  const { n, u } = FACE_FRAMES[id]
  return { R: [u.slice(), vz(cross(n, u)), n.slice()], t: vz(scl(n, h[axisOf(n)])) }
}
const ID = { R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }

/** paramBus 的反射面布局小式子（与 paramBus 私有函数逐式相同）。 */
const isMeshRefl = (r, D) => r.mesh === true || r.diameterM > D.meshAboveDM
const focalOf = (r, D) => (isNum(r.focalM) ? r.focalM : (isMeshRefl(r, D) ? D.fdMesh : D.fdSolid) * r.diameterM)
const deckOffset = (r, D) => (isNum(r.offsetHM) ? r.offsetHM : r.diameterM / 2 + 0.1 * D.reflDetailScale)
const slotSign = (slot) => (slot.startsWith('-') || slot === 'deck-Y' ? -1 : 1)
const slotOffsetDir = (slot) => (slot.startsWith('deck') ? [0, slotSign(slot), 0] : [slotSign(slot), 0, 0])
const feedArraySize = (r, Dm, k) => (isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.12 * Dm, 0.6 * k, 2.0 * k))

/**
 * paramBus 整星 spec（须已 normalizeSpec 且 validateSpec 通过）→ 装配组件列表（未归一；specToAssembly 再 normalizeAssembly）。
 * 组件 id 用可读短名（bus / wing1 / refl1 / arm1a …），都满足装配组件 id 规则。
 * @returns {{comps:object[], warnings:string[]}}
 */
export function satSpecToComps(s) {
  const D = DETAIL_PRESETS[s.detailPreset]
  const comps = [], warnings = []
  const put = (c) => { comps.push(c); return c }
  const X = s.bus.xM, Y = s.bus.yM, Z = s.bus.zM
  const h = [X / 2, Y / 2, Z / 2]
  const geo = s.layout === 'geo', leo = s.layout === 'leo-flat', cub = s.layout === 'cubesat'
  const surf = (face, uv, roll = 0) => ({ mode: 'surface', face, uv: uv.map(z0), roll })
  // 平台体组件的结构盒半边长 hs（面 / 插座都在它上面）：立方星内缩，其余布局 = h（逐位相同）
  const insetXY = cub ? D.bodyInsetM : 0, insetZ = cub ? D.railFootM : 0
  const hs = [X / 2 - insetXY, Y / 2 - insetXY, (Z - 2 * insetZ) / 2]
  const face = (id) => faceFrame(id, hs)

  // —— 平台体
  const bus = { xM: X, yM: Y, zM: Z, mli: 'none', radiators: false, adapter: false, massKg: isNum(s.bus.massKg) ? s.bus.massKg : null, insetXYM: insetXY, insetZM: insetZ }
  if (geo) Object.assign(bus, { mli: s.detail.mli && s.bus.mli ? s.bus.mli : 'none', radiators: !!s.detail.radiators, adapter: !!s.detail.adapter, mliOffM: D.mliOffM, radiatorFrac: D.radiatorFrac, adapterDM: D.adapterDM, adapterHM: D.adapterHM })
  put({ id: 'bus', type: 'sat.bus.box', parent: null, params: bus, ...(cub ? { material: 'dark_metal' } : {}) })

  // —— GEO：远地点发动机 + 8 个姿轨控推力器 + 对地板喇叭 / 地球敏感器
  if (geo && s.detail.thrusters) {
    put({ id: 'lae', type: 'sat.thruster', parent: 'bus', attach: surf('-Z', [0, 0]), params: { kind: 'lae', exitDM: D.laeExitDM, lengthM: D.laeLenM } })
    const inset = Math.min(0.15, 0.2 * Math.min(h[0], h[1]))
    const rcs = { kind: 'rcs', exitDM: D.rcsExitDM, lengthM: D.rcsLenM }
    let i = 0
    const fz = face('-Z')
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        // 背地面四角斜出：挂在 −Z 面上（面内偏移随平台尺寸走），自由姿态给喷流方向
        const p = [sx * (h[0] - inset), sy * (h[1] - inset), -h[2]], d = nrm([sx * 0.35, sy * 0.35, -1])
        const uv = [dot(sub(p, fz.t), fz.R[0]), dot(sub(p, fz.t), fz.R[1])]
        const anchor = { R: fz.R, t: add(fz.t, add(scl(fz.R[0], uv[0]), scl(fz.R[1], uv[1]))) }
        const r = rel(anchor, frameZ(d), p)
        put({ id: `rcs${++i}`, type: 'sat.thruster', parent: 'bus', attach: { mode: 'free', face: '-Z', uv: uv.map(z0) }, t: r.t, q: r.q, params: { ...rcs } })
      }
    }
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        const id = sx > 0 ? '+X' : '-X', F = face(id), p = [sx * h[0], sy * (h[1] - inset), -h[2] + inset]
        put({ id: `rcs${++i}`, type: 'sat.thruster', parent: 'bus', attach: surf(id, [dot(sub(p, F.t), F.R[0]), dot(sub(p, F.t), F.R[1])]), params: { ...rcs } })
      }
    }
  }
  if (geo && s.detail.deckHorns > 0) {
    const spots = [[0.76, 0.6], [-0.76, -0.6], [0.76, -0.6], [-0.76, 0.6]], n = s.detail.deckHorns
    for (let i = 0; i < Math.min(n, 3); i++) put({ id: `horn${i + 1}`, type: 'sat.feed.horn', parent: 'bus', attach: surf('+Z', [spots[i][0] * h[0], spots[i][1] * h[1]]), params: { kind: 'horn', apertureM: D.hornApM, lengthM: D.hornLenM, seg: 20 } })
    const e = Math.max(0.04, D.hornApM * 0.6)
    put({ id: 'esensor', type: 'prim.box', parent: 'bus', attach: surf('+Z', [spots[3][0] * h[0], spots[3][1] * h[1]]), params: { xM: e, yM: e, zM: e, hasMass: false }, material: 'dark_metal' })
  }

  // —— LEO 平板：对地面相控阵块、背速度面电推力器
  if (leo) {
    const nT = s.phasedArray.tiles
    if (nT > 0) {
      const nx = nT >= 4 ? 2 : 1, ny = nT >= 2 ? 2 : 1, fr = D.phasedTileFrac * (nT === 1 ? 2 : 1)
      const tx = Math.min(h[0] * 2 * fr, (2 * h[0]) / nx * 0.92) / 2, ty = Math.min(h[1] * 2 * fr, (2 * h[1]) / ny * 0.92) / 2
      let k = 0
      for (let ix = 0; ix < nx; ix++) {
        for (let iy = 0; iy < ny; iy++) {
          const cx = nx === 1 ? 0 : (ix === 0 ? -h[0] / 2 : h[0] / 2), cy = ny === 1 ? 0 : (iy === 0 ? -h[1] / 2 : h[1] / 2)
          put({ id: `array${++k}`, type: 'sat.array.phased', parent: 'bus', attach: surf('+Z', [cx, cy]), params: { wM: 2 * tx, hM: 2 * ty, tM: D.phasedTileTM, tiles: 1, standoffM: 0.01 } })
        }
      }
    }
    if (s.detail.thrusters) put({ id: 'ep', type: 'sat.thruster', parent: 'bus', attach: surf('-X', [0, 0]), params: { kind: 'ep', exitDM: D.thrusterDM, lengthM: D.thrusterLenM } })
  }

  // —— 立方星：导轨（无质量外观件）、体装电池片、对地贴片、背地端展开板
  let hRefl = h
  if (cub) {
    const rw = D.railWM, zb = Z - 2 * D.railFootM
    let i = 0
    for (const sx of [1, -1]) for (const sy of [1, -1]) put({ id: `rail${++i}`, type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: [sx * (X / 2 - rw / 2), sy * (Y / 2 - rw / 2), -Z / 2], q: [0, 0, 0, 1], params: { xM: rw, yM: rw, zM: Z, hasMass: false }, material: 'aluminum' })
    if (s.cubesat.bodyCells) {
      // 贴结构盒侧面、离面 cellLiftM（paramBus：hb + lift），落在导轨包络以内
      const fr = D.bodyCellFrac
      for (const [id, half] of [['+X', Y / 2], ['-X', Y / 2], ['+Y', X / 2], ['-Y', X / 2]]) {
        put({ id: `cells${id[0] === '+' ? 'p' : 'm'}${id[1].toLowerCase()}`, type: 'sat.radiator', parent: 'bus', attach: surf(id, [0, 0]), params: { kind: 'cells', wM: 2 * hs[2] * fr, hM: 2 * (half - rw) * fr, tM: 0, standoffM: D.cellLiftM, efficiency: SOLAR_EFFICIENCY_DEFAULT } })
      }
    }
    hRefl = [X / 2, Y / 2, hs[2]]
    if (!s.reflectors.some((r) => r.mount === 'deck' && !r.posBody)) {
      const pw = Math.min(D.patchWM, X * 0.5) / 2
      put({ id: 'patch', type: 'prim.box', parent: 'bus', attach: surf('+Z', [0, 0]), params: { xM: 2 * pw, yM: 2 * pw, zM: 0.003, hasMass: false }, material: 'white_paint' })
    }
    if (s.cubesat.deployPanels === 2) {
      // 铰线在导轨包络（y = ±Y/2）上：以结构盒 +Y 面为锚、沿面法向再外移「包络 − 结构盒」
      const p = { panels: 1, panelHM: zb, panelWM: X - 2 * rw, sidePanels: 0, yokeLenM: 0, gapM: 0, tiltDeg: 0, efficiency: SOLAR_EFFICIENCY_DEFAULT, articulate: false, sadaLenM: 0, sadaDM: 0, yokeRodDM: 0.004, panelTM: D.panelTM, cellMarginM: D.cellMarginM }
      put({ id: 'panel1', type: 'sat.wing', parent: 'bus', attach: { mode: 'free', face: '+Y', uv: [z0(-zb / 2 - D.panelTM / 2), 0] }, t: [0, 0, Y / 2 - hs[1]], q: [0, 0, 0, 1], params: p, sym: { group: 'panels', op: 'mirrorXZ' } })
    }
  }

  // —— 太阳翼（GEO / LEO）：一对同参数翼 → 镜像 XZ（转角互为相反数）或径向 2（转角相同且非 0）；否则各自装
  if (!cub && Array.isArray(s.wings) && s.wings.length) {
    const wp = (w) => ({
      panels: w.panels, panelHM: w.panelHM, panelWM: w.panelWM, sidePanels: w.sidePanels, yokeLenM: w.yokeLenM, gapM: w.gapM, tiltDeg: w.tiltDeg, efficiency: w.efficiency,
      articulate: true, sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM
    })
    const same = (a, b) => ['panels', 'panelHM', 'panelWM', 'sidePanels', 'yokeLenM', 'gapM', 'efficiency'].every((k) => a[k] === b[k])
    const wp_ = s.wings.find((w) => w.side === '+Y'), wm = s.wings.find((w) => w.side === '-Y')
    const place = (w) => (isVec3(w.hingeBody)
      ? (() => { const F = face(w.side); return { attach: { mode: 'free' }, t: w.hingeBody.slice(), q: quatOf(F.R) } })()
      : { attach: surf(w.side, [0, 0]) })
    let sym = null
    if (wp_ && wm && !isVec3(wp_.hingeBody) && !isVec3(wm.hingeBody) && same(wp_, wm)) {
      if (wm.tiltDeg === -wp_.tiltDeg) sym = { group: 'wings', op: 'mirrorXZ' }
      else if (wm.tiltDeg === wp_.tiltDeg) sym = { group: 'wings', op: 'radial', n: 2, axis: '+Z' }
    }
    if (sym) put({ id: 'wing1', type: 'sat.wing', parent: 'bus', ...place(wp_), params: wp(wp_), sym })
    else s.wings.forEach((w, i) => put({ id: `wing${i + 1}`, type: 'sat.wing', parent: 'bus', ...place(w), params: wp(w) }))
  }

  // —— 反射面群（与 paramBus.buildReflectors / reflectorLayout / buildFeed 支架 / buildReflectorArm 逐式相同）
  const refl = s.reflectors || []
  if (refl.length) {
    const k = D.reflDetailScale
    const deck = refl.filter((r) => r.mount === 'deck' && !r.posBody)
    let th = 0
    for (const r of deck) {
      const f = focalOf(r, D), dc = deckOffset(r, D), near = Math.max(0, dc - r.diameterM / 2)
      th = Math.max(th, f - near * near / (4 * f) + 0.15 * k)
    }
    const towerH = s.tower && isNum(s.tower.hM) ? s.tower.hM : th
    const tw = s.tower && isNum(s.tower.wM) ? s.tower.wM : D.towerWM
    let towerTop = null
    if (deck.length || (s.tower && isNum(s.tower.hM))) {
      // 塔座在对地板 = 平台体结构盒 +Z 面（hRefl[2] 与 hs[2] 逐位相同）
      put({ id: 'tower', type: 'sat.tower', parent: 'bus', attach: surf('+Z', [0, 0]), params: { wM: tw, hM: towerH } })
      towerTop = { R: ID.R, t: [0, 0, hRefl[2] + towerH] }
    }
    const order = refl.map((r, i) => i).sort((a, b) => (refl[a].slot.endsWith('2') ? 1 : 0) - (refl[b].slot.endsWith('2') ? 1 : 0) || a - b)
    const resolved = new Map(), layouts = []
    for (const i of order) {
      const r = refl[i], hh = hRefl
      const a = nrm(r.boresightBody), Dm = r.diameterM, mesh = isMeshRefl(r, D), f = focalOf(r, D), side = r.mount === 'side', sg = slotSign(r.slot)
      const u0 = r.offsetDirBody != null ? r.offsetDirBody : slotOffsetDir(r.slot)
      const u = nrm(reject(u0, a))
      let F, dc
      if (side) {
        const outer = r.slot.endsWith('2')
        const pair = refl.some((q) => q !== r && q.mount === 'side' && !q.posBody && (q.slot === (outer ? r.slot.slice(0, 2) : r.slot + '2')))
        const yF = pair ? (outer ? -hh[1] / 2 : hh[1] / 2) : 0
        const inner = outer ? resolved.get(r.slot.slice(0, 2)) : null
        dc = isNum(r.offsetHM) ? r.offsetHM : (inner ? inner.dc + inner.D / 2 + Dm / 2 + 0.3 * k : Dm / 2 + D.feedInsetM + D.wallGapM)
        const standoff = r.feedType === 'array' ? Math.max(D.feedStandoffM, 0.75 * feedArraySize(r, Dm, k)) : D.feedStandoffM
        F = r.posBody ? r.posBody.slice() : [sg * (hh[0] - D.feedInsetM), yF, hh[2] + standoff]
      } else {
        dc = deckOffset(r, D)
        F = r.posBody ? r.posBody.slice() : [0, sg * (tw / 2 + 0.1 * k), hh[2] + towerH]
      }
      const L = paraLayout(F, a, u, f, Dm, dc, k)
      L.mount = r.mount; L.s = sg; L.mesh = mesh
      if (!r.posBody) resolved.set(r.slot, L)
      layouts[i] = L
    }
    refl.forEach((r, i) => {
      const L = layouts[i], n = i + 1
      const params = {
        diameterM: L.D, focalM: L.f, fD: G.fdSolid, offsetHM: L.dc, surface: L.mesh ? 'mesh' : 'solid', back: true,
        feed: r.feedType, feedApertureM: isNum(r.feedApertureM) ? r.feedApertureM : null,
        shellM: D.shellM, trussDepthFrac: D.meshTrussDepthFrac, trussRodFrac: D.meshTrussRodFrac, meshAboveDM: D.meshAboveDM, detailScale: k
      }
      // 组件位姿：局部系 = P 系（u, e2, a；原点 V）绕 Y 转 −θ 再平移到安装基准 B（reflectorFrame）
      const g = reflectorFrame(params)
      const RP = [L.u, L.e2, L.a]
      const Rc = [rApply(RP, [g.c, 0, g.s]), rApply(RP, [0, 1, 0]), rApply(RP, [-g.s, 0, g.c])]
      const tc = add(L.V, rApply(RP, g.B))
      const pose = { R: Rc, t: tc }
      let anchor, attach
      if (r.posBody) { anchor = ID; attach = { mode: 'free' } }
      else if (L.mount === 'side') { const id = L.s > 0 ? '+X' : '-X'; anchor = face(id); attach = { mode: 'free', socket: id } }
      else { anchor = towerTop; attach = { mode: 'free', socket: 'top' } }
      const rr = rel(anchor, Rc, tc)
      put({ id: `refl${n}`, type: 'sat.reflector', parent: attach.socket === 'top' ? 'tower' : 'bus', attach, t: rr.t, q: rr.q, params })
      // 挂在反射面下的附件（馈源支架 / 展开臂 / 铰座）：位姿相对反射面
      const child = (id, type, R, t, p, extra = {}) => { const q = rel(pose, R, t); put({ id, type, parent: `refl${n}`, attach: { mode: 'free' }, t: q.t, q: q.q, params: p, ...extra }) }
      const rodTo = (id, p0, p1, dM, seg) => child(id, 'sat.boom', frameZ(sub(p1, p0)), p0, { lengthM: len(sub(p1, p0)), dM, seg })
      // 馈源支架（paramBus.buildFeed：侧挂竖直落到对地板、塔馈水平接塔顶）
      const dir = nrm(sub(L.Pc, L.F))
      let back
      if (r.feedType === 'array') back = madd(L.F, dir, -0.08 * k)
      else { const ap = isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.08 * L.D, 0.1 * k, 0.4 * k); back = madd(L.F, dir, -1.6 * ap) }
      const tTop = r.mount === 'deck' && !r.posBody ? hRefl[2] + towerH : null
      const hh = hRefl
      const foot = tTop ? [0, clampN(back[1], -0.2 * k, 0.2 * k), tTop] : [clampN(back[0], -hh[0] + 0.05 * k, hh[0] - 0.05 * k), clampN(back[1], -hh[1] + 0.05 * k, hh[1] - 0.05 * k), hh[2]]
      if (len(sub(foot, back)) > 0.02 * k) rodTo(`sup${n}`, back, foot, 2 * Math.max(0.01 * k, 0.02 * Math.min(1, L.D / 2.5)), 8)
      // 展开臂（paramBus.buildReflectorArm）
      const R = L.D / 2, rodR = Math.max(0.015 * k, 0.025 * Math.min(2, L.D / 2.5))
      const behind = L.mesh ? D.meshTrussDepthFrac * L.D : D.shellM
      const bk = (x1, x2, off) => madd(L.P(x1, x2), L.N(x1, x2), -(behind + off))
      const edge = L.mesh ? 1 : 0.96
      const A = bk(L.dc - R * edge, 0, L.mesh ? 0 : 0.04 * k)
      const segs = []
      if (L.mount === 'side') {
        const hinge = [L.s * hh[0], clampN(L.F[1], -hh[1] + 0.1 * k, hh[1] - 0.1 * k), clampN(A[2], -hh[2] + 0.1 * k, hh[2] - 0.1 * k)]
        segs.push([hinge, A])
        if (L.mesh) segs.push([hinge, L.P(L.dc - R, 0)])
        else segs.push([A, bk(L.dc, 0, 0.12 * k)])
        const e = 0.12 * k
        // 铰座装在平台体侧面上（一半嵌进侧板）：父件取平台体——穿插检测的「父子安装对」口径把这一对自然跳过，
        // 展开臂从铰座伸出的端接由杆件端点容差兜住（asmClash）
        const rh = rel(ID, ID.R, sub(hinge, [0, 0, e / 2]))
        put({ id: `hinge${n}`, type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: rh.t, q: rh.q, params: { xM: e, yM: e, zM: e, hasMass: false }, material: 'carbon' })
      } else {
        const Cf = bk(L.dc + R * edge, 0, L.mesh ? 0 : 0.04 * k)
        const deckA = [A[0], A[1], hh[2]], deckC = [clampN(Cf[0], -hh[0], hh[0]), clampN(Cf[1], -hh[1] + 0.05 * k, hh[1] - 0.05 * k), hh[2]]
        if (A[2] - hh[2] > 0.02 * k) segs.push([deckA, A])
        segs.push([deckC, Cf])
        if (!L.mesh) segs.push([A, bk(L.dc, 0, 0.12 * k)])
      }
      segs.forEach(([p0, p1], j) => { if (len(sub(p1, p0)) > 0.01 * k) rodTo(`arm${n}${String.fromCharCode(97 + j)}`, p0, p1, 2 * rodR, 10) })
    })
  }

  // —— 显式附加件（feeds / booms / thrusters / radiators），全部相对平台体中心
  const busPose = ID
  s.feeds.forEach((f, i) => {
    const d = nrm(f.dirBody)
    if (f.kind === 'patchArray') { const r = rel(busPose, frameZ(d), f.posBody); put({ id: `feedx${i + 1}`, type: 'sat.feed.horn', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'patch', apertureM: f.apertureM } }) }
    else { const r = rel(busPose, frameZ(d), madd(f.posBody, d, -1.6 * f.apertureM)); put({ id: `feedx${i + 1}`, type: 'sat.feed.horn', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'horn', apertureM: f.apertureM, lengthM: 1.6 * f.apertureM, seg: 20 } }) }
  })
  s.booms.forEach((b, i) => { const r = rel(busPose, frameZ(sub(b.toBody, b.fromBody)), b.fromBody); put({ id: `boomx${i + 1}`, type: 'sat.boom', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { lengthM: len(sub(b.toBody, b.fromBody)), dM: b.dM, seg: 10 } }) })
  s.thrusters.forEach((t, i) => { const r = rel(busPose, frameZ(t.dirBody), t.posBody); put({ id: `thrx${i + 1}`, type: 'sat.thruster', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'rcs', exitDM: t.exitDM, lengthM: t.lengthM, seg: 16, massAtFrac: 0 } }) })
  s.radiators.forEach((r, i) => {
    // paramBus 把显式散热面放在包络面外 6 mm；平台体的面在结构盒上，离面补上「包络 − 结构盒」（非立方星为 0）
    const Fr = FACE_FRAMES[r.face], [e1] = perpPair(Fr.n), ax = axisOf(Fr.n)
    const roll = Math.atan2(dot(cross(Fr.u, e1), Fr.n), dot(Fr.u, e1)) * 180 / Math.PI
    put({ id: `radx${i + 1}`, type: 'sat.radiator', parent: 'bus', attach: surf(r.face, [0, 0], z0(Math.round(roll * 1e9) / 1e9)), params: { kind: 'radiator', wM: r.wM, hM: r.hM, tM: 0, standoffM: 0.006 + (h[ax] - hs[ax]) } })
  })
  if (s.wings && s.wings.length > 2) warnings.push(`翼数 ${s.wings.length} 超出南北两翼`)
  return { comps, warnings }
}

