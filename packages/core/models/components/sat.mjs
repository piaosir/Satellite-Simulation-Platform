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
// ★ 安装基面 / 接口收件清单（2026-10 设计页交互重构 §3.3.1「accepts 收紧」，逐个核对后的结论）：
//   · 星体 box / cyl / hex、天线塔：面全可装，面心通用接口不限（大件，不动）。
//   · prim.box / prim.cyl：通用积木，接口不限；hasMass 关（纯外观件：模板里的立方星导轨、对地贴片、反射面铰座 hinge、地球敏感器
//     esensor）面不作安装基面（mountableFaces），与面心重合的通用接口随之不收。其中厚度 ≤ THIN_M（5 mm）的纯外观件（对地贴片）
//     是贴在面上的薄件（passThroughWhen）：拖放时射线穿过它装到后面的面上，不在星体面心留下装不上的死区。
//   · 馈源喇叭 aperture：只收馈源链（sat.feed.*）与基本体占位（星上无副反射面组件）。
//   · 杆件 tip：只收天线（反射面、馈源、相控阵）/ 基本体（磁强计一类杆端载荷的占位）；星敏 / 太敏是体装件、不收（模板里的
//     馈源支架 / 展开臂两端都接着结构，杆尖不该成为星敏的落点，§5-9）；侧柱面照常可装（夹装磁强计一类）。
//   · 相控阵 front（辐射面）：只收基本体占位（罩 / 遮光板）。
//   · 反射面 focus：馈源类与基本体（原样）；back 是安装端。太阳翼 / 推力器 / 散热面 / 星敏 / 太敏：只有自身安装接口、没有面。
//
// ★ 缺省参数全部是示意值（source:'illustrative'），取整数量级；不沿用任何具体型号 / 平台的尺寸（2026-09-24 用户：不内置中国型号）。
//   细节档（SADA、轭杆、板厚、反射面边缘厚……）取 paramTemplates.DETAIL_PRESETS.geo，与生成页同一套示意值。
//
// ★ 名字：组件内部的节点 / 挂点 / 关节 / 太阳翼组名是短名（'bus' / 'wing_1_cells' / 'axis' / 'focus'），
//   装配件出 IR 时一律加组件前缀 `${前缀}_`（assembly.mjs）；这里的短名只能含 [A-Za-z0-9_+-]。
//
// 导出：
//   SAT_COMPONENTS  17 个卫星组件定义（sat.bus.box / sat.bus.cyl / sat.bus.hex / sat.bus.trap / sat.bus.flat / sat.wing / sat.reflector / sat.feed.horn /
//                   sat.array.phased / sat.tower / sat.boom / sat.thruster / sat.radiator / sat.sensor.star / sat.sensor.sun /
//                   sat.sensor.earth / sat.antenna.ttc）；2026-10-08 补全的天线 / 载荷 / 设备件在 satAntenna.mjs、satUnit.mjs
//   每个卫星组件带 category（组件库分组：structure 结构与机构 / power 电源 / antenna 天线 / payload 有效载荷 / propulsion 推进 /
//   aocs 姿轨控 / thermal 热控）与 aliases（组件库搜索的别名）；枚举参数带 optionLabels（属性面板选项的中文名）
//   PRIM_COMPONENTS 通用基本体（prim.box / prim.cyl，所有领域可用）
//   FACE_FRAMES     盒面 id → {n, u}（面坐标系约定，单测与编辑器共用）
//   reflectorFrame(p) → 反射面局部系几何（specToAssembly 由母抛物面位姿反推组件位姿用）
//   satSpecToComps(spec) → {comps, warnings}：paramBus 整星 spec（已 normalizeSpec）→ 装配组件列表（specToAssembly 的内核）

import {
  isNum, isVec3, add, sub, scl, dot, cross, len, nrm, reject, madd, clampN, z0, IDR, rApply,
  MB, quad, box, frustum, tube, annulus, horn, uniq, addItem, comp, boxComp, plateComp, rodComp, shellComp, pointComp, perpPair, paraLayout,
  shellProps, worldPositions
} from '../meshKit.mjs'
import {
  buildWing, buildReflector, buildFeed, MATERIALS, SOLAR_EFFICIENCY_DEFAULT, defaultSidePanelAt, addHw, feedHornGeom, feedSupportRods, feedSupportR, busAdapter,
  sideArmGeom, rcsLayout, geoSensorLayout, deckSpots, deckKeepOfFeed, deckKeepOfDeck, hornShellMass, feedApDefault, ttcAntenna, epThruster, extraHornLen, towerFinish
} from '../paramBus.mjs'
import { feedHorn as hwFeedHorn, feedChain as hwFeedChain, bellNozzle as hwBellNozzle, starTrackerHead as hwStarTracker, wedgeMount as hwWedge, sunSensor as hwSunSensor, earthSensor as hwEarthSensor, rcsPod as hwRcsPod, rcsThruster as hwRcsThruster, backingLink, concaveCap as hwConcaveCap } from '../hardware.mjs'
import { DETAIL_PRESETS } from '../paramTemplates.mjs'
import { lambdaOf, arrayPanel, pyramidHorn, latticeMast } from '../antennas.mjs'
import { prism as kitPrism, obox as kitBox } from '../fleet/kit.mjs'
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
// 星体热控多层只列多层隔热材料（审查 P2：原先把混凝土、橡胶、电池片也列进来）；'none' = 不包覆
const MLI_OPTIONS = ['none', ...['mli_gold', 'mli_silver', 'mli_black', 'kapton_black'].filter((k) => MATERIALS[k])]

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
/** 柱面（轴 axis、圆周零位 ref、半径 r；uv0 = 沿轴高度，uv1 = 弧长）。卫星侧的柱面都是整圆（full：弧向回绕不夹紧）。 */
const cylFace = (id, origin, axis, ref, radius, halfU) => ({ id, kind: 'cyl', origin, axis, ref, radius, halfU, halfV: Math.PI * radius, full: true })
/** 基本体的面：纯外观件（hasMass 关）不作安装基面。 */
const primMountable = (p) => p.hasMass !== false
/** 纯外观薄件的厚度上限（米）：对地贴片 3 mm；铰座 / 地敏方块 / 导轨（≥ 8.5 mm）不算薄件。 */
const THIN_M = 0.005
// 基本体的「贴在面上的薄件」（ComponentDef.passThroughWhen）：纯外观、某一向厚度 ≤ THIN_M。逐个比较不调变参 Math.min（编辑器热路径可调）
const primBoxThin = (p) => p.hasMass === false && (p.xM <= THIN_M || p.yM <= THIN_M || p.zM <= THIN_M)
const primCylThin = (p) => p.hasMass === false && p.hM <= THIN_M

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

const HAS_MASS = bool(true, '计质量', { title: '关 = 纯外观件（无质量）；开 = 体积 × 平台体等效体密度（density.busVolume）。组件「质量」手动指定时按指定值' })

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
  mountableFaces: primMountable,
  passThroughWhen: primBoxThin,
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
  mountableFaces: primMountable,
  passThroughWhen: primCylThin,
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
  mli: enm('mli_gold', MLI_OPTIONS, '热控多层', { title: '星体多层隔热组件（MLI）外表面；无 = 不包覆' }),
  massKg: num(null, 'kg', '星体质量', { nullable: true, gt: 0, title: '星体（含未单列的载荷与推进剂）质量；留空按体密度估算；装配件指定目标质量时由其承担质量差额' }),
  mliOffM: num(G.mliOffM, 'm', 'MLI 离面', { min: 0, max: 0.5 })
}

/**
 * 盒式平台体的结构盒半边长：xM / yM / zM 是外包络（质量元按包络算，与 paramBus 同），结构盒每侧内缩 insetXYM、两端各内缩 insetZM
 * （立方星：包络 = 导轨外缘，结构盒让出导轨与端脚）。式子与 paramBus.buildCubesatLayout 的 hb 逐式相同；内缩为 0 时恰为包络半边长。
 */
const busHalf = (p) => [p.xM / 2 - p.insetXYM, p.yM / 2 - p.insetXYM, (p.zM - 2 * p.insetZM) / 2]
const ENV_NOTE = '外包络；质量按包络体积估算，结构盒按内缩量缩进'

const busBox = {
  type: 'sat.bus.box', domain: SAT, title: 'Bus (box)', titleZh: '星体（箱形）', role: 'bus', category: 'structure', family: 'body',
  aliases: ['平台', '本体', '卫星平台', '立方星', 'bus'],
  presets: [
    { id: 'small', titleZh: '小卫星平台', title: 'Small satellite bus', aliases: ['小卫星', '微小卫星', '小平台'], params: { xM: 0.8, yM: 0.8, zM: 1.0, mli: 'mli_silver' } }
  ],
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
    insetXYM: num(0, 'm', '侧面内缩', { min: 0, title: '结构盒四个侧面相对包络的内缩量（为立方星导轨留出空间）；安装面 / 接口位于结构盒上' }),
    insetZM: num(0, 'm', '端面内缩', { min: 0, title: '结构盒两端相对包络的内缩量（立方星导轨端脚）；安装面 / 接口位于结构盒上' })
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
    const busPart = { id: 'bus', name: '星体', role: 'bus' }
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
      busAdapter(ctx, busPart, h, Math.min(p.adapterDM / 2, 0.45 * Math.min(2 * h[0], 2 * h[1])), p.adapterHM)
    }
    apLocal(ctx, 'nadir_center', [0, 0, h[2]], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -h[2]], [0, 0, -1])
    return ctx
  }
}

const busCyl = {
  type: 'sat.bus.cyl', domain: SAT, title: 'Bus (cylinder)', titleZh: '星体（圆柱形）', role: 'bus', category: 'structure', family: 'body',
  aliases: ['平台', '本体', '自旋', 'bus'],
  presets: [
    { id: 'drum', titleZh: '自旋稳定太阳鼓', title: 'Spin-stabilized solar drum', aliases: ['自旋', '太阳鼓', 'MSG', '风云二号'], params: { drumCells: true, dM: 3.2, hM: 2.4, mli: 'none' } }
  ],
  params: {
    dM: num(2.0, 'm', '直径', { gt: 0 }),
    hM: num(3.0, 'm', '高', { gt: 0 }),
    seg: int(48, '分段', { min: 8, max: 128 }),
    mli: busCommon.mli, massKg: busCommon.massKg, mliOffM: busCommon.mliOffM,
    drumCells: bool(false, '体装太阳电池', { title: '自旋稳定星的「太阳鼓」：圆柱侧面整圈贴电池片（单独构成太阳翼组，随星体自旋）' }),
    cellFrac: num(0.9, '', '电池覆盖高度比', { gt: 0, max: 1, title: '电池带高度 / 圆柱高' }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '电池片效率', { min: 0, max: 100, title: '电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）' })
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
    const busPart = { id: 'bus', name: '星体', role: 'bus' }
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
    if (p.drumCells) {
      // 太阳鼓：侧面电池带（离 MLI 外 3 mm），单独一个太阳翼组；质量按电池片面密度
      const rc = r + (p.mli !== 'none' ? p.mliOffM : 0) + 0.003, hc = hz * p.cellFrac
      const cm = new MB(); frustum(cm, [0, 0, -hc], rc, [0, 0, hc], rc, p.seg, false, false)
      const it = addItem(ctx, { name: 'bus_cells', role: 'solarArray', part: { id: 'cells', name: '体装太阳电池', role: 'solarArray' }, mat: 'solar_cell', mb: cm })
      const sp = shellComp(ctx, 'bus_cells', it, dens.cellAreal)
      ctx.parts.get('cells').areaM2 = sp.area
      ctx.spg.push({ name: 'cells', nodes: ['bus_cells'], efficiency: p.efficiency })
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
  type: 'sat.bus.hex', domain: SAT, title: 'Bus (hexagonal)', titleZh: '星体（六棱柱形）', role: 'bus', category: 'structure', family: 'body',
  aliases: ['平台', '本体', '六边形', 'bus'],
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
    const busPart = { id: 'bus', name: '星体', role: 'bus' }
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

// ───────────────────────────── 星体：梯形截面 / 扁平板式（2026-10-08 补全） ─────────────────────────────
//
// 梯形截面：一网 Arrow、全球星二代、O3b 第一代那种「对地面宽、背地面窄」的长棱柱（截面在 YZ 平面，沿 X 挤出）。
// 扁平板式：星链那种切角矩形薄板（对地面大面积装相控阵 / 镜面膜，背地面加强肋，太阳翼与关口站天线挂在边上）。
// 两者原点都取包围盒中心（作根件时 = 本体系原点），安装接口取背地面（−Z）面心，与箱形星体同一约定。

/** 梯形截面星体的面（局部系）：对地面 +Z（宽 Wn）、背地面 −Z（宽 Wz）、两个斜侧面 ±Y、两个端面 ±X（梯形按内接矩形给尺寸） */
function trapFaces(p) {
  const L = p.lengthM, Wn = p.nadirWM, Wz = p.zenithWM, D = p.depthM
  const sl = Math.hypot((Wn - Wz) / 2, D)
  const face = (id, origin, n, u, halfU, halfV) => ({ id, kind: 'plane', origin: vz(origin), n: vz(n), u: vz(u), v: vz(cross(n, u)), halfU, halfV })
  const out = [face('+Z', [0, 0, D / 2], [0, 0, 1], [1, 0, 0], L / 2, Wn / 2), face('-Z', [0, 0, -D / 2], [0, 0, -1], [1, 0, 0], L / 2, Wz / 2)]
  for (const s of [1, -1]) {
    // 斜侧面外法向 ∝ (0, s·D, (Wz − Wn)/2)；滚转零位取 +Z 在面内的投影
    const n = [0, s * D / sl, (Wz - Wn) / 2 / sl], u = nrm(reject([0, 0, 1], n))
    out.push(face(s > 0 ? '+Y' : '-Y', [0, s * (Wn + Wz) / 4, 0], n, u, sl / 2, L / 2))
  }
  for (const s of [1, -1]) out.push(face(s > 0 ? '+X' : '-X', [s * L / 2, 0, 0], [s, 0, 0], [0, 0, 1], D / 2, Math.min(Wn, Wz) / 2))
  return out
}

const busTrap = {
  type: 'sat.bus.trap', domain: SAT, title: 'Bus (trapezoidal prism)', titleZh: '星体（梯形截面）', role: 'bus', category: 'structure', family: 'body',
  aliases: ['平台', '本体', '梯形', '棱柱', '一网', '全球星', 'bus'],
  params: {
    lengthM: num(1.3, 'm', '长', { gt: 0, title: '沿局部 X（飞行方向）的长度' }),
    nadirWM: num(1.0, 'm', '对地面宽', { gt: 0, title: '+Z 面（对地面）沿 Y 的宽度' }),
    zenithWM: num(0.65, 'm', '背地面宽', { gt: 0, title: '−Z 面（背地面）沿 Y 的宽度' }),
    depthM: num(0.95, 'm', '高', { gt: 0, title: '对地面到背地面的距离（沿 Z）' }),
    mli: busCommon.mli, massKg: busCommon.massKg, mliOffM: busCommon.mliOffM
  },
  mountSocket: '-Z',
  sockets: (p) => trapFaces(p).map((f) => sock(f.id, f.origin, f.n, f.u, 2 * Math.min(f.halfU, f.halfV))),
  faces: trapFaces,
  massSink: 'bus',
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const L = p.lengthM, Wn = p.nadirWM, Wz = p.zenithWM, D = p.depthM
    const busPart = { id: 'bus', name: '星体', role: 'bus' }
    // 截面在 (Y, Z)、沿 X 挤出：棱柱局部系 x = 本体 Y、y = 本体 Z、z = 本体 X
    const Fp = { o: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] }
    const sec = [[-Wn / 2, D / 2], [Wn / 2, D / 2], [Wz / 2, -D / 2], [-Wz / 2, -D / 2]]
    const mb = new MB(); kitPrism(mb, Fp, sec, -L / 2, L / 2)
    addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: 'aluminum', mb })
    // 质量：等效体密度 × 梯形棱柱体积；惯量按截面平均宽的盒、质心在梯形形心高度
    const V = L * D * (Wn + Wz) / 2, zc = -D / 2 + (D / 3) * (Wz + 2 * Wn) / (Wz + Wn)
    boxComp(ctx, 'bus', isNum(p.massKg) ? p.massKg : dens.busVolume * V, [0, 0, zc], [L / 2, (Wn + Wz) / 4, D / 2])
    if (p.mli !== 'none') {
      const o = p.mliOffM, mm = new MB()
      kitPrism(mm, Fp, [[-Wn / 2 - o, D / 2 + o], [Wn / 2 + o, D / 2 + o], [Wz / 2 + o, -D / 2 - o], [-Wz / 2 - o, -D / 2 - o]], -L / 2 - o, L / 2 + o)
      const it = addItem(ctx, { name: 'bus_mli', role: 'bus', part: busPart, mat: p.mli, mb: mm })
      shellComp(ctx, 'bus_mli', it, dens.mliAreal)
    }
    apLocal(ctx, 'nadir_center', [0, 0, D / 2], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -D / 2], [0, 0, -1])
    return ctx
  }
}

/** 扁平板式星体的切角矩形轮廓（半长 a × 半宽 b、切角 c，逆时针） */
const chamRect = (a, b, c) => [[-a + c, -b], [a - c, -b], [a, -b + c], [a, b - c], [a - c, b], [-a + c, b], [-a, b - c], [-a, -b + c]]
function flatFaces(p) {
  const a = p.xM / 2, b = p.yM / 2, h = p.zM / 2, c = Math.min(p.chamferM, 0.45 * Math.min(p.xM, p.yM))
  const face = (id, origin, n, u, halfU, halfV) => ({ id, kind: 'plane', origin: vz(origin), n, u, v: vz(cross(n, u)), halfU, halfV })
  return [
    face('+Z', [0, 0, h], [0, 0, 1], [1, 0, 0], a - c / 2, b - c / 2), face('-Z', [0, 0, -h], [0, 0, -1], [1, 0, 0], a - c / 2, b - c / 2),
    face('+X', [a, 0, 0], [1, 0, 0], [0, 0, 1], h, b - c), face('-X', [-a, 0, 0], [-1, 0, 0], [0, 0, 1], h, b - c),
    face('+Y', [0, b, 0], [0, 1, 0], [0, 0, 1], h, a - c), face('-Y', [0, -b, 0], [0, -1, 0], [0, 0, 1], h, a - c)
  ]
}

const busFlat = {
  type: 'sat.bus.flat', domain: SAT, title: 'Bus (flat panel)', titleZh: '星体（扁平板式）', role: 'bus', category: 'structure', family: 'body',
  aliases: ['平台', '本体', '扁平', '平板', '星链', '堆叠', 'bus'],
  params: {
    xM: num(1.3, 'm', 'X 边长', { gt: 0 }), yM: num(2.8, 'm', 'Y 边长', { gt: 0 }), zM: num(0.2, 'm', '厚', { gt: 0, title: '沿 Z（对地面到背地面）' }),
    chamferM: num(0.1, 'm', '切角', { min: 0, title: '四角切角边长；0 = 直角' }),
    nadir: enm('aluminum', ['aluminum', 'white_paint', 'mli_silver', 'radiator'], '对地面', { optionLabels: { aluminum: '抛光铝', white_paint: '白漆', mli_silver: '银色 MLI', radiator: 'OSR 镜面' }, title: '对地面外表面（降亮度设计常贴介质镜面膜：选 OSR 镜面）' }),
    body: enm('dark_metal', ['dark_metal', 'aluminum', 'mli_gold', 'mli_black', 'white_paint'], '侧面与背地面', { optionLabels: { dark_metal: '深灰阳极化', aluminum: '本色铝', mli_gold: '金色 MLI', mli_black: '黑色 MLI', white_paint: '白漆' } }),
    ribs: bool(true, '背地面加强肋', { title: '背地面纵横加强肋（等栅格结构）' }),
    massKg: busCommon.massKg
  },
  validate: (p) => (p.chamferM < 0.45 * Math.min(p.xM, p.yM) ? [] : ['切角过大']),
  mountSocket: '-Z',
  sockets: (p) => flatFaces(p).map((f) => sock(f.id, f.origin, f.n, f.u, 2 * Math.min(f.halfU, f.halfV))),
  faces: flatFaces,
  massSink: 'bus',
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const a = p.xM / 2, b = p.yM / 2, h = p.zM / 2, c = Math.min(p.chamferM, 0.45 * Math.min(p.xM, p.yM))
    const busPart = { id: 'bus', name: '星体', role: 'bus' }
    const F0 = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }
    const outline = c > 1e-6 ? chamRect(a, b, c) : [[-a, -b], [a, -b], [a, b], [-a, b]]
    const mb = new MB(); kitPrism(mb, F0, outline, -h, h, { cap0: true, cap1: false })
    addItem(ctx, { name: 'bus', role: 'bus', part: busPart, mat: p.body, mb })
    // 对地面（单独一层：抛光铝 / 镜面膜，离结构面 3 mm）
    const nm = new MB(); kitPrism(nm, F0, outline.map(([x, y]) => [x * 0.995, y * 0.995]), h, h + 0.003, { cap0: false, cap1: true })
    addItem(ctx, { name: 'bus_nadir', role: 'bus', part: busPart, mat: p.nadir, mb: nm })
    if (p.ribs) {
      // 背地面加强肋：纵向两道 + 横向按 0.4 m 间距（肋高 = 板厚 0.1、不小于 1 cm）
      const rm = new MB(), rh = Math.max(0.01, 0.1 * p.zM), rw = Math.max(0.008, 0.012 * Math.min(p.xM, p.yM))
      const along = p.yM >= p.xM
      const L1 = along ? b : a, L2 = along ? a : b
      const nT = Math.max(2, Math.round((2 * L1) / 0.4))
      for (let k = 1; k < nT; k++) {
        const t = -L1 + (2 * L1 * k) / nT
        kitBox(rm, F0, along ? [0, t, -h - rh / 2] : [t, 0, -h - rh / 2], along ? [L2 - c, rw / 2, rh / 2] : [rw / 2, L2 - c, rh / 2])
      }
      for (const s of [-0.45, 0.45]) kitBox(rm, F0, along ? [s * 2 * L2 / 2, 0, -h - rh / 2] : [0, s * 2 * L2 / 2, -h - rh / 2], along ? [rw / 2, L1 - c, rh / 2] : [L1 - c, rw / 2, rh / 2])
      addItem(ctx, { name: 'bus_ribs', role: 'bus', part: busPart, mat: 'dark_metal', mb: rm })
    }
    const A = 4 * a * b - 2 * c * c
    boxComp(ctx, 'bus', isNum(p.massKg) ? p.massKg : dens.busVolume * A * p.zM, [0, 0, 0], [a, b, h])
    apLocal(ctx, 'nadir_center', [0, 0, h + 0.003], [0, 0, 1])
    apLocal(ctx, 'zenith_center', [0, 0, -h], [0, 0, -1])
    return ctx
  }
}

// ───────────────────────────── 太阳翼 ─────────────────────────────

// buildWing 在「整星口径」里建 +Y 翼（翼展 +Y、电池面 −Z、铰点 0）；再整体换到组件局部系：
// x_L = z_C、y_L = x_C、z_L = y_C（轴置换，逐位精确）→ 翼展 +Z_L、电池面 −X_L。
const Q_WING = [[0, 1, 0], [0, 0, 1], [1, 0, 0]]

const wing = {
  type: 'sat.wing', domain: SAT, title: 'Rigid solar array wing', titleZh: '刚性太阳翼', role: 'solarArray', category: 'power',
  aliases: ['太阳翼', '帆板', '太阳电池阵', '太阳能', '电池翼', '刚性', '板式', 'solar', 'rigid'],
  presets: [
    { id: 'cross', titleZh: '十字形太阳翼', title: 'Cross-shaped solar array wing', aliases: ['十字', '侧板', '大功率'], params: { sidePanels: 2 } },
    { id: 'paddle', titleZh: '单板太阳翼', title: 'Single-paddle solar array wing', aliases: ['单板', '小卫星', '低轨'], params: { panels: 1, panelHM: 1.6, panelWM: 1.0, yokeLenM: 0.4, sadaLenM: 0.15, sadaDM: 0.16 } },
    { id: 'multicol', titleZh: '多列折叠太阳翼', title: 'Multi-column folding solar array wing', aliases: ['多列', '双列'], params: { panels: 5, panelHM: 1.3, panelWM: 2.4, columns: 2, yokeLenM: 0.6, hinges: true } },
    { id: 'si-trap', titleZh: '硅电池太阳翼', title: 'Silicon-cell solar array wing', aliases: ['硅电池', '东三', '北斗二号', '梯形连接架'], params: { panels: 3, panelHM: 2.2, panelWM: 1.72, yokeLenM: 1.55, yoke: 'trap', cellType: 'si', frame: true, hinges: true } },
    { id: 'scissor', titleZh: '剪叉式展开太阳翼', title: 'Scissor-deployed solar array wing', aliases: ['剪叉', '星链 V2', 'V2 Mini'], params: { panels: 6, panelHM: 2.2, panelWM: 4.2, columns: 2, yoke: 'scissor', yokeLenM: 2.4, hinges: true } },
    { id: 'concentrator', titleZh: '聚光型太阳翼', title: 'Concentrator solar array wing', aliases: ['聚光', '反光板', '波音 702'], params: { panels: 5, concentrator: true } }
  ],
  params: {
    panels: int(4, '板数', { min: 1, max: 20 }),
    panelHM: num(3.0, 'm', '板长', { gt: 0, title: `沿翼展；${GEO_NOTE}` }),
    panelWM: num(2.0, 'm', '板宽', { gt: 0, title: GEO_NOTE }),
    sidePanels: int(0, '侧板', { options: [0, 2] }),
    sidePanelAt: int(null, '侧板位置', { nullable: true, min: 1, max: 20, title: '侧板挂在第几块（自翼根数起）；留空 = 倒数第二块（外侧还有一块，十字形翼）' }),
    yokeLenM: num(G.yokeLenM, 'm', '连接架长度', { min: 0, title: '连接架（轭）：太阳翼驱动机构（SADA）外端至第一块基板内缘；0 = 无连接架' }),
    gapM: num(G.gapM, 'm', '板间缝', { min: 0 }),
    tiltDeg: num(0, '°', '绕翼轴转角', { min: -180, max: 180, title: '0° 电池面朝安装面滚转零位的反方向' }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '电池片效率', { min: 0, max: 100, title: '电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）' }),
    articulate: bool(true, '转动关节'),
    sadaLenM: num(G.sadaLenM, 'm', 'SADA 长', { min: 0 }),
    sadaDM: num(G.sadaDM, 'm', 'SADA 直径', { min: 0 }),
    yokeRodDM: num(G.yokeRodDM, 'm', '连接架杆径', { gt: 0 }),
    panelTM: num(G.panelTM, 'm', '基板厚', { gt: 0 }),
    cellMarginM: num(G.cellMarginM, 'm', '电池片边距', { min: 0 }),
    sadaMassKg: num(null, 'kg', 'SADA 质量', { nullable: true, gt: 0 }),
    // 2026-10-08「太阳翼种类补全」：可选外形（缺省值 = 与整星 paramBus 逐字节相同的老样子）
    yoke: enm('auto', ['auto', 'v', 'trap', 'rod', 'scissor'], '连接架形式', { optionLabels: { auto: '自动', v: 'V 形', trap: '梯形', rod: '单杆', scissor: '剪叉式' }, title: '自动：连接架长 ≥ 0.3 m 画 V 形双杆、更短画单杆；梯形：梯形框 + 交叉斜撑（东三平台、北斗二号）；剪叉式：交叉杆逐节伸出的展开架（星链 V2 Mini）' }),
    columns: int(1, '每块板列数', { min: 1, max: 4, title: '每块基板沿板宽分几列（多列折叠翼）' }),
    cellType: enm('gaas', ['gaas', 'si'], '电池片', { optionLabels: { gaas: '三结砷化镓', si: '硅' }, title: '三结砷化镓：深蓝近黑（现役主流）；硅：亮蓝、带白色汇流条（东三平台、北斗二号、早期卫星）' }),
    bothFaces: bool(false, '双面电池', { title: '基板背面也贴电池片' }),
    frame: bool(false, '板框', { title: '每块基板四周的碳纤维压条框' }),
    hinges: bool(false, '板间铰链', { title: '相邻基板之间（及侧板与主板之间）的展开铰链' }),
    concentrator: bool(false, '聚光板', { title: '每块基板两条长边各一条外倾 60° 的反光板，把阳光聚到电池上（波音 702 早期型号）' })
  },
  validate: (p) => [
    ...(p.sadaLenM > 0 && !(p.sadaDM > 0) ? ['SADA 直径须为正数'] : []),
    ...(p.sidePanels === 2 && Number.isInteger(p.sidePanelAt) && p.sidePanelAt > p.panels ? ['侧板位置超过板数'] : []),
    ...(p.concentrator && p.sidePanels === 2 ? ['聚光板不能与侧板同时使用'] : []),
    ...(p.columns > 1 && (p.panelWM - (p.columns - 1) * p.gapM) / p.columns <= 0.02 ? ['列太窄（板宽不够分列）'] : [])
  ],
  // 根部接口：有 SADA 取 SADA 直径，没有（铰链展开板）取板宽
  sockets: (p) => [ROOT_SOCKET(p.sadaLenM > 0 && p.sadaDM > 0 ? p.sadaDM : p.panelWM)],
  // 几何关于局部 xz 面（板宽方向）对称，唯一带手性的参数是绕翼轴转角：关于 xz 面镜像 = 转角取反
  mirrorPlanes: ['xz'],
  mirror: (p, plane) => (plane === 'xz' ? { ...p, tiltDeg: p.tiltDeg === 0 ? 0 : -p.tiltDeg } : null),
  build(p, kit) {
    const ctx = kit.createCtx()
    const w = { side: '+Y', panels: p.panels, panelHM: p.panelHM, panelWM: p.panelWM, sidePanels: p.sidePanels, yokeLenM: p.yokeLenM, gapM: p.gapM, tiltDeg: p.tiltDeg, efficiency: p.efficiency, hingeBody: [0, 0, 0] }
    // 侧板位置：留空按整星同一缺省（倒数第二块 → 十字形，paramBus.defaultSidePanelAt）
    if (p.sidePanels === 2) w.sidePanelAt = Number.isInteger(p.sidePanelAt) ? p.sidePanelAt : defaultSidePanelAt(p.panels)
    buildWing(ctx, w, {
      sadaLenM: p.sadaLenM, sadaDM: p.sadaDM, yokeRodDM: p.yokeRodDM, panelTM: p.panelTM, cellMarginM: p.cellMarginM, articulate: p.articulate, sadaMassKg: p.sadaMassKg,
      yokeStyle: p.yoke, columns: p.columns, cellMat: p.cellType === 'si' ? 'cell_si' : 'solar_cell', bothFaces: p.bothFaces, frame: p.frame, hinges: p.hinges, concentrator: p.concentrator
    })
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

const FEED_ACCEPTS = Object.freeze(['sat.feed.', 'sat.array.', 'es.feed', 'prim.'])
/** 馈源喇叭口面：馈源链（星载馈源 + 地面站馈源 es.feed；星上没有副反射面组件）+ 基本体占位。 */
const FEED_CHAIN_ACCEPTS = Object.freeze(['sat.feed.', 'es.feed', 'prim.'])
/**
 * 杆件端部：天线（反射面、馈源、相控阵、全向 / 螺旋 / 测控 / 双轴指向天线）+ 磁强计 + 基本体（杆端载荷占位）。星敏 / 太敏不收：两者都是体装件（星敏要装在
 * 刚性光学基座上），而模板里的杆件多是馈源支架 / 展开臂这类两端都接着结构的撑杆，杆端收敏感器会让拖星敏时候选里冒出一串
 * 埋在反射面 / 星体里的杆尖（任务书 §5-9 验收；§3.3.1「杆 tip 只收敏感器 / 天线 / 小件」按组件核对后的落地清单）。
 * 2026-10-12 组件不限领域：另收地面站反射面 / 馈源与阵列族（平板动中通一类，'@array'）。
 */
const TIP_ACCEPTS = Object.freeze(['sat.reflector', 'sat.feed.', 'sat.array.', 'sat.antenna.', 'sat.sensor.mag', 'es.refl.', 'es.feed', '@array', 'prim.'])
/** 相控阵辐射面：只收基本体占位（罩 / 遮光板）。 */
const ARRAY_FRONT_ACCEPTS = Object.freeze(['prim.'])

const reflector = {
  type: 'sat.reflector', domain: SAT, title: 'Reflector antenna', titleZh: '反射面天线', role: 'reflector', category: 'antenna', family: 'reflector',
  aliases: ['反射面', '抛物面', '偏置', '赋形', '网状', '可展开', '格里高利', '多波束', 'reflector', '碟形'],
  presets: [
    { id: 'mesh-perimeter', titleZh: '周边桁架网状反射面', title: 'Perimeter-truss mesh reflector', aliases: ['AstroMesh', '大型可展开', '网状'], params: { surface: 'mesh', diameterM: 9 } },
    { id: 'mesh-radial', titleZh: '径向肋网状反射面', title: 'Radial-rib mesh reflector', aliases: ['伞状', '径向肋', '网状'], params: { surface: 'mesh', diameterM: 9, meshStyle: 'radial' } },
    { id: 'mesh-modular', titleZh: '构架式网状反射面', title: 'Modular-truss mesh reflector', aliases: ['模块化', '构架', '网状'], params: { surface: 'mesh', diameterM: 6, meshStyle: 'modular' } },
    { id: 'gregorian', titleZh: '格里高利双反射面天线', title: 'Gregorian dual-reflector antenna', aliases: ['双反射面', '副反射面', 'Gregorian'], params: { subDM: 0.6 } }
  ],
  params: {
    diameterM: num(2.5, 'm', '口径', { gt: 0 }),
    focalM: num(null, 'm', '焦距', { nullable: true, gt: 0, title: '留空按焦径比' }),
    fD: num(G.fdSolid, '', '焦径比', { gt: 0 }),
    offsetHM: num(null, 'm', '偏置高度', { nullable: true, min: 0, title: '偏置高度（口径中心到母轴距离）；0 = 正馈；留空 = 半口径 + 0.1 m（下缘净空 0.1 m）' }),
    surface: enm('auto', ['auto', 'solid', 'mesh'], '反射面', { title: 'auto：口径大于网状门限按网状', optionLabels: { auto: '自动', solid: '实面', mesh: '网状' } }),
    meshStyle: enm('perimeter', ['perimeter', 'radial', 'modular'], '网状形式', { title: '周边桁架式：口缘一圈可展开环形桁架张紧金属网（AstroMesh 类）；径向肋式：中心毂 + 径向肋撑网、肋间网面外缘呈扇贝形（伞状）；构架式：三角网格模块化双层桁架', optionLabels: { perimeter: '周边桁架式', radial: '径向肋式', modular: '构架式' } }),
    back: bool(true, '背壳'),
    front: enm('white', ['white', 'sunshield', 'silver'], '正面外观', { title: '白漆反射面；锗膜遮阳罩：锗镀黑聚酰亚胺（深灰，口缘浅灰压边带）；银色遮阳罩：金色压边线，对地板反射面常见', optionLabels: { white: '白漆', sunshield: '锗膜遮阳罩', silver: '银色遮阳罩' } }),
    rear: enm('cfrp', ['cfrp', 'mli_gold', 'mli_black'], '背面外观', { title: '本色碳纤维（近黑）或背面整包多层隔热', optionLabels: { cfrp: '碳纤维', mli_gold: '金色 MLI', mli_black: '黑色 MLI' } }),
    backing: enm('ring8', ['ring8', 'none'], '背架', { title: '八边形箱形梁环框（金色 MLI 包覆，口径 0.72 D）；实面才有', optionLabels: { ring8: '八边形环框', none: '无' } }),
    support: enm('none', ['none', 'rect'], '支撑框', { title: '东西侧展开反射面的矩形支撑框 + 四个压紧释放点垫块（展开臂接在内侧横梁上）；实面才有', optionLabels: { none: '无', rect: '矩形支撑框' } }),
    feed: enm('horn', ['horn', 'array', 'none'], '自带馈源', { optionLabels: { horn: '喇叭', array: '平面阵', none: '无' } }),
    feedApertureM: num(null, 'm', '馈源口径', { nullable: true, gt: 0 }),
    subDM: num(null, 'm', '副反射面口径', { nullable: true, gt: 0, title: '格里高利双反射面：凹面副反射面在焦点外侧，自带喇叭移到第二焦点、口面朝副面；留空 = 单偏置。副面口径常取主面的 0.15–0.3' }),
    shellM: num(G.shellM, 'm', '边缘厚', { gt: 0 }),
    trussDepthFrac: num(G.meshTrussDepthFrac, '', '桁架深 / 口径', { gt: 0 }),
    trussRodFrac: num(G.meshTrussRodFrac, '', '桁架杆半径 / 口径', { gt: 0 }),
    meshAboveDM: num(G.meshAboveDM, 'm', '网状门限', { gt: 0 }),
    detailScale: num(G.reflDetailScale, '', '附件比例', { gt: 0 })
  },
  mountSocket: 'back',
  sockets(p) {
    const g = reflectorFrame(p)
    // 焦点插座的名义尺寸 = 自带馈源口径（缺省式同 paramBus.feedHornGeom：0.03 × 焦距）；只接馈源类与基本体
    const fa = isNum(p.feedApertureM) ? p.feedApertureM : feedApDefault(g.f, g.k)
    return [sock('back', [0, 0, 0], [0, 0, -1], [1, 0, 0], 0.2 * g.Dm), sock('focus', g.F, nrm(sub(g.F, g.Pc)), [1, 0, 0], fa, 15, FEED_ACCEPTS)]
  },
  // 偏置抛物面关于「母轴 + 偏置方向」所在平面（局部 xz）对称；正馈另关于 yz 对称。格里高利的第二焦点偏在局部 ±y 一侧：不对称
  symmetricPlanes: (p) => (isNum(p.subDM) && p.subDM > 0 && p.feed === 'horn' ? [] : reflectorFrame(p).dc === 0 ? ['yz', 'xz'] : ['xz']),
  // 带自带馈源时焦点已经有馈源：焦点接口算占用（装配时不再往上叠第二个馈源）
  busySockets: (p) => (p.feed !== 'none' ? ['focus'] : []),
  build(p, kit) {
    const ctx = kit.createCtx({ D: { shellM: p.shellM, meshTrussDepthFrac: p.trussDepthFrac, meshTrussRodFrac: p.trussRodFrac } })
    const g = reflectorFrame(p)
    const L = paraLayout(g.F, g.a, g.u, g.f, g.Dm, g.dc, g.k)
    L.mesh = g.mesh
    // 背架 / 支撑框接在背壳上：没有背壳就都不画
    const rear = !g.mesh && p.back
    buildReflector(ctx, { front: p.front, rear: p.rear, backing: rear ? p.backing : 'none', support: rear ? p.support : 'none', meshStyle: p.meshStyle }, 0, L)
    if (!g.mesh && !p.back) dropItems(ctx, ['reflector_1_back', 'reflector_1_rim'])
    if (isNum(p.subDM) && p.subDM > 0 && p.feed === 'horn') {
      // 格里高利：副面中心 S 在焦点外侧（主面口径中心 → 焦点的延长线上），第二焦点 F2 从 S 看与 S→F 成 40°、偏向局部 ±y，
      // 距 S 1.2 D_s；副面法向平分 S→F 与 S→F2（调研 components.md §1-V2）。副面质量按面密度记在副面中心
      const sD = p.subDM, w = nrm(sub(L.F, L.Pc)), S = madd(L.F, w, 0.45 * sD + 0.15 * g.k)
      const v1 = nrm(sub(L.F, S)), F2 = madd(S, nrm(add(scl(v1, Math.cos(40 * Math.PI / 180)), scl(L.e2, Math.sin(40 * Math.PI / 180)))), 1.2 * sD)
      const nS = nrm(add(v1, nrm(sub(F2, S))))
      const part = { id: 'reflector_1', name: '反射面 1', role: 'reflector' }
      const cap = addHw(ctx, 'reflector_1_sub', part, 'reflector', 'reflector', (put) => hwConcaveCap(put, { center: S, n: nS, D: sD, sh: 0.6 * p.shellM }))
      pointComp(ctx, 'reflector_1_sub', ctx.dens.reflectorAreal * cap.ret.area, S)
      L.feedAt = F2; L.feedDir = nrm(sub(S, F2))
    }
    if (p.feed !== 'none') buildFeed(ctx, { feedType: p.feed, feedApertureM: p.feedApertureM }, 0, L, null)
    for (const a of ctx.aps) a.upBody = null
    renameCtx(ctx, (n) => (n === 'reflector_1_focus' ? 'focus' : n.replace(/^reflector_1/, 'reflector').replace(/^feed_1/, 'feed')), (s) => s.replace(/ 1$/, ''))
    return ctx
  }
}

// ───────────────────────────── 馈源 / 相控阵 / 塔 / 杆 ─────────────────────────────

// 馈源喇叭长度缺省：2.12 × 口径（窄张角 12° 波纹锥喇叭；hardware.feedHorn / paramBus.feedHornGeom 同一比例）。
// 质量按外包锥面 × 面密度（paramBus.hornShellMass：造型细部不改质量模型，整星的侧挂 / 对地板 / 显式喇叭同式）
const feedLen = (p) => (p.kind === 'patch' ? 0.005 : isNum(p.lengthM) ? p.lengthM : (p.kind === 'pyramid' ? 1.5 : 2.12) * p.apertureM)
/** 角锥喇叭 E 面口径（沿局部 y）：留空 = 0.74 × 口径（标准增益喇叭 B/A 比例） */
const pyrB = (p) => (isNum(p.apertureBM) ? p.apertureBM : 0.74 * p.apertureM)

const feedHorn = {
  type: 'sat.feed.horn', domain: SAT, title: 'Horn antenna', titleZh: '喇叭天线', role: 'feed', category: 'antenna', family: 'horn',
  aliases: ['馈源', '喇叭', '波纹喇叭', '角锥喇叭', '标准增益', '地球覆盖', '全球波束', '信标', 'horn', 'feed'],
  presets: [
    { id: 'pyramid', titleZh: '角锥喇叭天线', title: 'Pyramidal horn antenna', aliases: ['角锥', '标准增益'], params: { kind: 'pyramid', apertureM: 0.12 } }
  ],
  params: {
    kind: enm('horn', ['horn', 'pyramid', 'patch'], '形式', { title: '圆锥喇叭：波纹 / 光壁圆锥（馈源、对地板信标 / 全球波束喇叭）；角锥喇叭：矩形口面标准增益喇叭；贴片：平面馈源', optionLabels: { horn: '圆锥喇叭', pyramid: '角锥喇叭', patch: '贴片' } }),
    apertureM: num(0.074, 'm', '口径', { gt: 0, title: '口面内径（角锥喇叭为 H 面口宽，沿局部 X）；Ku 单馈源 60–90 mm、C 频段 180–270 mm、Ka 35–55 mm（按反射面焦径比与边缘照射电平定）' }),
    apertureBM: num(null, 'm', '口面高', { nullable: true, gt: 0, title: '角锥喇叭 E 面口宽（沿局部 Y）；留空 = 0.74 × 口径' }),
    lengthM: num(null, 'm', '长度', { nullable: true, gt: 0, title: '法兰面至口面；留空：圆锥喇叭 2.12 × 口径（窄张角波纹锥喇叭）、角锥喇叭 1.5 × 口径' }),
    style: enm('terraced', ['terraced', 'smooth', 'ribbed', 'profiled'], '外形', { title: '圆锥喇叭外形：台阶锥（机加波纹喇叭减重外形）/ 平滑锥 / 外环肋近圆柱（E3000 对地板白漆喇叭）/ 光壁样条（多模喇叭）', optionLabels: { terraced: '台阶锥', smooth: '平滑锥', ribbed: '外环肋', profiled: '光壁样条' } }),
    finish: enm('gold_metal', ['gold_metal', 'aluminum', 'white_paint', 'mli_gold', 'mli_black'], '外表面', { title: '阿洛丁 / 镀金、本色铝、白漆、金色 / 黑色 MLI（在轨多包 MLI）', optionLabels: { gold_metal: '镀金', aluminum: '本色铝', white_paint: '白漆', mli_gold: '金色 MLI', mli_black: '黑色 MLI' } }),
    cap: enm('none', ['none', 'ge', 'white'], '口面遮阳膜', { title: '锗膜：锗镀黑聚酰亚胺（深灰）；白膜：白漆膜', optionLabels: { none: '无', ge: '锗膜', white: '白膜' } }),
    chain: enm('linear', ['none', 'linear', 'cp'], '馈电链', { title: '圆锥喇叭之后的极化器 / 正交模变换器：线极化 = 方盒带四个波导端口；圆极化 = 细圆柱带两个端口', optionLabels: { none: '无', linear: '线极化', cp: '圆极化' } }),
    seg: int(24, '分段', { min: 6, max: 96 })
  },
  // root = 喉部（贴面安装）；aperture = 口面中心（接反射面焦点插座时用它当 mount：口面朝口径中心）。
  // aperture 作父接口只收馈源链与基本体占位（星敏 / 推力器之类不往喇叭口上装）
  sockets: (p) => [ROOT_SOCKET(p.apertureM, 15), sock('aperture', [0, 0, feedLen(p)], [0, 0, 1], [1, 0, 0], p.apertureM, 15, FEED_CHAIN_ACCEPTS)],
  symmetricPlanes: (p) => (p.kind === 'patch' || p.kind === 'pyramid' ? ['yz', 'xz'] : evenSym(p.seg)),
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const L = feedLen(p), part = { id: 'feed', name: '馈源', role: 'feed' }
    if (p.kind === 'pyramid') {
      // 角锥喇叭：四块梯形壁 + 喉部矩形波导与方法兰（antennas.pyramidHorn）；质量 = 四壁面积 × 喇叭面密度（点质量在壁的形心高）
      const A = p.apertureM, B = pyrB(p), fin = p.finish || 'gold_metal'
      addHw(ctx, 'feed', part, 'feed', fin, (put) => pyramidHorn(put, { A, B, L, mat: { body: fin, inner: 'black_paint', flange: 'aluminum' } }))
      const a = Math.max(0.01, 0.16 * A), b = a / 2, sl = Math.hypot(0.84 * L, (A - a) / 2)
      pointComp(ctx, 'feed', dens.hornAreal * (A + B + a + b) * sl, [0, 0, 0.62 * L])
      const pp = ctx.parts.get('feed'); pp.areaM2 = A * B; pp.normalBody = [0, 0, 1]
      return ctx
    }
    if (p.kind === 'patch') {
      // 与 paramBus 显式附加馈源的 patchArray 同式：两片正方形（口面 + 背面），面密度按喇叭板
      const m = new MB(), a = p.apertureM / 2, [e1, e2] = perpPair([0, 0, 1])
      quad(m, [0, 0, L], scl(e1, a), scl(e2, a)); quad(m, [0, 0, 0], scl(e2, a), scl(e1, a))
      const it = addItem(ctx, { name: 'feed', role: 'feed', part, mat: 'white_paint', mb: m })
      const sp = shellComp(ctx, 'feed', it, dens.hornAreal)
      const pp = ctx.parts.get('feed'); pp.areaM2 = sp.area; pp.normalBody = [0, 0, 1]
      return ctx
    }
    // 波纹锥喇叭（hardware.feedHorn）+ 可选馈电链（伸到安装面以下：装在对地板上时进到星体里，挂在反射面焦点上时露在喇叭后）
    const fin = p.finish || 'gold_metal'
    addHw(ctx, 'feed', part, 'feed', fin, (put) => {
      const hh = hwFeedHorn(put, { ap: [0, 0, L], dir: [0, 0, 1], up: [1, 0, 0], D: p.apertureM, L, style: p.style || 'terraced', mat: { body: fin, rim: 'gold_metal', inner: 'black_paint' }, cap: p.cap === 'none' ? null : p.cap, seg: Math.max(12, p.seg) })
      if (p.chain && p.chain !== 'none') hwFeedChain(put, { throat: hh.throat, dir: [0, 0, 1], up: [1, 0, 0], D: p.apertureM, kind: p.chain === 'cp' ? 'cp' : 'linear', seg: 16 })
    })
    const sp = hornShellMass(ctx, 'feed', [0, 0, L], [0, 0, 1], p.apertureM, L)
    const pp = ctx.parts.get('feed'); pp.areaM2 = sp.area; pp.normalBody = [0, 0, 1]
    return ctx
  }
}

// 相控阵：阵元间距缺省（贴片 / 圆贴片 / 交叉偶极子 0.6 λ——±45° 左右扫描不出栅瓣的常用取值；喇叭单元 1.1 λ）
const arrayPitch = (p) => (isNum(p.pitchM) ? p.pitchM : (p.face === 'horn' ? 1.1 : 0.6) * lambdaOf(p.freqGHz))
/**
 * 分块行列（行沿局部 Y、列沿局部 X）：给了行数按它；留空取「不小于 √块数 的最小约数」作行数——块数 2 → 2 行 1 列、4 → 2 × 2，
 * 与旧版（分块 1 / 2 / 4）逐位相同；质数块数排成一列。
 */
function tileGrid(p) {
  const n = p.tiles
  let rows = Number.isInteger(p.tileRows) ? p.tileRows : 0
  if (!rows) { rows = n; for (let k = Math.ceil(Math.sqrt(n) - 1e-9); k <= n; k++) if (n % k === 0) { rows = k; break } }
  return { rows, cols: Math.max(1, Math.round(n / rows)) }
}
const ARRAY_SHAPES = { rect: '矩形', chamfer: '切角矩形', hex: '六边形', oct: '八边形', circle: '圆形' }
const ARRAY_FACES = { patch: '方形贴片', disc: '圆形贴片', horn: '喇叭单元', dipole: '交叉偶极子', radome: '天线罩（白）', sunshield: '锗膜遮阳罩' }

const arrayPhased = {
  type: 'sat.array.phased', domain: SAT, title: 'Phased array antenna', titleZh: '相控阵天线', role: 'feed', category: 'antenna', family: 'array',
  aliases: ['相控阵', '有源相控阵', '平面阵', '直接辐射阵', 'DRA', 'SAR', '阵面', '数字波束成形', 'phased array'],
  presets: [
    { id: 'disc-oct', titleZh: '圆贴片相控阵', title: 'Circular-patch phased array', aliases: ['圆贴片', '八边形'], params: { face: 'disc', shape: 'oct' } },
    { id: 'horn', titleZh: '喇叭单元相控阵', title: 'Horn-element phased array', aliases: ['喇叭阵', 'Ku'], params: { face: 'horn', freqGHz: 12 } },
    { id: 'dipole-l', titleZh: 'L 频段偶极子相控阵', title: 'L-band dipole phased array', aliases: ['偶极子阵', 'L 频段', '移动通信'], params: { face: 'dipole', freqGHz: 1.6 } },
    { id: 'radome', titleZh: '天线罩相控阵', title: 'Radome-covered phased array', aliases: ['星链', 'Starlink', '用户阵', '切角'], params: { face: 'radome', shape: 'chamfer', frameMat: 'white_paint' } },
    { id: 'sunshield', titleZh: '遮阳罩相控阵', title: 'Sunshield-covered phased array', aliases: ['锗膜', '遮阳罩', '六边形'], params: { face: 'sunshield', shape: 'hex' } },
    { id: 'tiled', titleZh: '分块展开相控阵', title: 'Deployable tiled phased array', aliases: ['SAR', '直连手机', '大阵面', '展开阵面'], params: { tiles: 6, wM: 2.7, hM: 2.3, freqGHz: 2 } },
    { id: 'ka', titleZh: 'Ka 频段相控阵', title: 'Ka-band phased array', aliases: ['Ka'], params: { freqGHz: 20 } }
  ],
  params: {
    wM: num(1.0, 'm', '宽', { gt: 0, title: '阵面外廓沿局部 X 的尺寸（分块时为整阵）' }),
    hM: num(1.0, 'm', '长', { gt: 0, title: '阵面外廓沿局部 Y 的尺寸（分块时为整阵）' }),
    shape: enm('rect', ['rect', 'chamfer', 'hex', 'oct', 'circle'], '外廓', { title: '阵面外廓（内接于宽 × 长）：切角矩形为星链式阵面块；六边形 / 八边形 / 圆形用于单块阵面', optionLabels: ARRAY_SHAPES }),
    face: enm('patch', ['patch', 'disc', 'horn', 'dipole', 'radome', 'sunshield'], '阵面形式', { title: '裸露阵元（贴片 / 喇叭单元 / 交叉偶极子）或罩面（天线罩 / 锗膜遮阳罩，在轨阵面多为罩面，不画阵元）', optionLabels: ARRAY_FACES }),
    freqGHz: num(4, 'GHz', '工作频率', { gt: 0, title: '阵元间距按它推算（λ = c / f）：L 1.6 / S 2.2 / C 4 / X 8 / Ku 12 / Ka 20 GHz' }),
    tiles: int(1, '分块', { min: 1, max: 64, title: '子阵 / 展开板块数（块间留缝）；SAR 天线、直连手机大阵面多由多块板展开拼成' }),
    tM: num(0.015, 'm', '厚', { gt: 0, title: '阵面板厚（含 T/R 组件层）' }),
    gapM: num(0.02, 'm', '块间缝', { min: 0 }),
    standoffM: num(0.01, 'm', '离面', { min: 0 }),
    pitchM: num(null, 'm', '阵元间距', { nullable: true, gt: 0, title: '相邻阵元中心距；留空：贴片 / 偶极子 0.6 λ、喇叭单元 1.1 λ。阵元很多时按比例放大画出的间距（每块最多画 2400 个）' }),
    lattice: enm('tri', ['rect', 'tri'], '栅格', { title: '三角（交错）栅格比矩形栅格省约 13 % 阵元；喇叭单元恒为矩形栅格', optionLabels: { rect: '矩形栅格', tri: '三角栅格' } }),
    tileRows: int(null, '分块行数', { nullable: true, min: 1, max: 64, title: '沿局部 Y 的块数；留空按近似正方排布' }),
    faceMat: enm(null, ['white_paint', 'radome', 'mli_gold', 'kapton_black', 'black_paint', 'dark_metal'], '阵面底色', { nullable: true, title: '介质基板 / 罩面颜色；留空按阵面形式（贴片 / 偶极子白、天线罩白色介质罩、遮阳罩深灰、喇叭口黑）', optionLabels: { white_paint: '白', radome: '天线罩白', mli_gold: '金色聚酰亚胺', kapton_black: '黑色聚酰亚胺', black_paint: '黑', dark_metal: '深灰金属' } }),
    elemMat: enm(null, ['gold_metal', 'copper', 'aluminum', 'white_paint'], '阵元外表面', { nullable: true, title: '留空：贴片 / 偶极子镀金、喇叭隔墙本色铝', optionLabels: { gold_metal: '镀金', copper: '裸铜', aluminum: '本色铝', white_paint: '白漆' } }),
    frameMat: enm('mli_gold', ['mli_gold', 'mli_silver', 'mli_black', 'aluminum', 'white_paint', 'dark_metal'], '边框与侧面', { optionLabels: { mli_gold: '金色 MLI', mli_silver: '银色 MLI', mli_black: '黑色 MLI', aluminum: '本色铝', white_paint: '白漆', dark_metal: '深灰金属' } })
  },
  validate: (p) => {
    const e = []
    const { rows, cols } = tileGrid(p)
    if (Number.isInteger(p.tileRows) && p.tiles % p.tileRows !== 0) e.push('分块数须为分块行数的整数倍')
    if (p.tiles > 1 && !['rect', 'chamfer'].includes(p.shape)) e.push('分块仅适用于矩形 / 切角矩形外廓')
    if (!(p.wM - p.gapM * (cols - 1) > 0 && p.hM - p.gapM * (rows - 1) > 0)) e.push('块间缝超过阵面尺寸')
    return e
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.hM)), sock('front', [0, 0, p.standoffM + p.tM], [0, 0, 1], [1, 0, 0], Math.min(p.wM, p.hM), 90, ARRAY_FRONT_ACCEPTS)],
  symmetricPlanes: ['yz', 'xz'],
  // 质量：每块按阵面面密度 × 外廓面积（矩形块与旧版逐位相同：plateComp(面密度 × 宽 × 长)；其余外廓按等面积等宽长比的方板求惯量）
  build(p, kit) {
    const ctx = kit.createCtx()
    const { dens } = ctx
    const { rows, cols } = tileGrid(p)
    const part = { id: 'array', name: '相控阵天线', role: 'feed' }
    const legacy = p.shape === 'rect' && p.face === 'radome' && p.faceMat === 'white_paint' && p.frameMat === 'white_paint'
    let r = null
    addHw(ctx, 'array', part, 'feed', legacy ? 'white_paint' : p.frameMat, (put) => {
      r = arrayPanel(put, { w: p.wM, h: p.hM, t: p.tM, z0: p.standoffM, shape: p.shape, face: p.face, lattice: p.lattice, pitch: arrayPitch(p), tilesX: cols, tilesY: rows, gap: p.gapM, faceMat: p.faceMat, elemMat: p.elemMat, frameMat: p.frameMat })
    })
    const tw = (p.wM - p.gapM * (cols - 1)) / cols, th = (p.hM - p.gapM * (rows - 1)) / rows
    let k = 0
    for (const T of r.tiles) {
      const c = [T.cx, T.cy, p.standoffM + p.tM / 2]
      if (p.shape === 'rect') plateComp(ctx, `array_${++k}`, dens.arrayAreal * tw * th, c, IDR, tw, th)
      else { const s = Math.sqrt(T.area / (tw * th)); plateComp(ctx, `array_${++k}`, dens.arrayAreal * T.area, c, IDR, tw * s, th * s) }
    }
    const pp = ctx.parts.get('array'); pp.areaM2 = r.area; pp.normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', [0, 0, p.standoffM + p.tM], [0, 0, 1])
    return ctx
  }
}

const tower = {
  type: 'sat.tower', domain: SAT, title: 'Antenna tower', titleZh: '天线塔', role: 'boom', category: 'structure', family: 'truss',
  aliases: ['塔', '支架', '天线塔', 'tower'],
  params: {
    wM: num(G.towerWM, 'm', '截面边长', { gt: 0 }), hM: num(1.0, 'm', '高', { gt: 0 }),
    finish: enm('mli_gold', ['mli_gold', 'mli_silver', 'mli_black', 'white_paint', 'aluminum'], '外表面', { title: '在轨的塔 / 支架多裹平台同色多层隔热（金 / 银 / 黑），白漆、本色铝少见', optionLabels: { mli_gold: '金色 MLI', mli_silver: '银色 MLI', mli_black: '黑色 MLI', white_paint: '白漆', aluminum: '本色铝' } })
  },
  sockets: (p) => [ROOT_SOCKET(p.wM), sock('top', [0, 0, p.hM], [0, 0, 1], [1, 0, 0], p.wM), ...boxSockets([0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+X', '-X', '+Y', '-Y'])],
  faces: (p) => boxFaces([0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+X', '-X', '+Y', '-Y', '+Z']),
  symmetricPlanes: ['yz', 'xz'],
  // 与 paramBus.buildReflectors 的天线塔同式（五面盒、对地板塔面密度）
  build(p, kit) {
    const ctx = kit.createCtx()
    const tm = new MB()
    box(tm, [0, 0, p.hM / 2], [p.wM / 2, p.wM / 2, p.hM / 2], ['+x', '-x', '+y', '-y', '+z'])
    const it = addItem(ctx, { name: 'tower', role: 'boom', part: { id: 'tower', name: '天线塔', role: 'boom' }, mat: p.finish || 'mli_gold', mb: tm })
    shellComp(ctx, 'tower', it, ctx.dens.towerAreal)
    return ctx
  }
}

const boom = {
  type: 'sat.boom', domain: SAT, title: 'Boom / mast', titleZh: '杆件', role: 'boom', category: 'structure', family: 'truss',
  aliases: ['杆', '撑杆', '伸展臂', '展开臂', '桁架', '支杆', 'boom', 'mast'],
  presets: [
    { id: 'lattice', titleZh: '三角桁架伸展臂', title: 'Coilable lattice boom', aliases: ['盘绕式', '桁架', '磁强计杆'], params: { style: 'lattice', dM: 0.3, lengthM: 3, canister: true } }
  ],
  params: {
    lengthM: num(1.0, 'm', '长', { gt: 0 }), dM: num(0.05, 'm', '直径', { gt: 0, title: '圆管外径；桁架式为纵杆所在外接圆直径' }),
    style: enm('tube', ['tube', 'lattice'], '形式', { title: '圆管：碳纤维管撑杆；桁架：三角桁架伸展臂（盘绕式 / 铰接式，磁强计杆、大型网状天线展开臂）', optionLabels: { tube: '圆管', lattice: '三角桁架' } }),
    finish: enm('carbon', ['carbon', 'aluminum', 'titanium', 'white_paint', 'black_paint', 'mli_gold', 'gold_metal'], '外表面', { optionLabels: { carbon: '碳纤维', aluminum: '本色铝', titanium: '钛合金', white_paint: '白漆', black_paint: '消光黑漆', mli_gold: '金色 MLI', gold_metal: '镀金' } }),
    canister: bool(false, '收拢筒', { title: '桁架根部的伸展臂收拢筒（盘绕式伸展臂展开后留在星上）' }),
    seg: int(10, '分段', { min: 3, max: 64 })
  },
  sockets: (p) => [ROOT_SOCKET(p.dM, 15), sock('tip', [0, 0, p.lengthM], [0, 0, 1], [1, 0, 0], p.dM, 15, TIP_ACCEPTS)],
  faces: (p) => [cylFace('side', [0, 0, p.lengthM / 2], [0, 0, 1], [1, 0, 0], p.dM / 2, p.lengthM / 2)],
  // 桁架式的斜撑逐节交替（有旋向）：不声明对称面，镜像时烘焙
  symmetricPlanes: (p) => (p.style === 'lattice' ? [] : evenSym(p.seg)),
  // 质量 = 线密度 × 长（rodComp，与 paramBus 展开臂 / 馈源支架同一口径；桁架式同口径）
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'boom', name: '杆', role: 'boom' }
    if (p.style === 'lattice') {
      addHw(ctx, 'boom', part, 'boom', p.finish || 'carbon', (put) => latticeMast(put, { L: p.lengthM, r: p.dM / 2, n: 3, rod: Math.max(0.0015, 0.025 * p.dM), canister: p.canister, mat: p.finish || 'carbon' }))
    } else {
      const m = new MB(); tube(m, [0, 0, 0], [0, 0, p.lengthM], p.dM / 2, p.seg)
      addItem(ctx, { name: 'boom', role: 'boom', part, mat: p.finish || 'carbon', mb: m })
    }
    rodComp(ctx, 'boom', [0, 0, 0], [0, 0, p.lengthM])
    return ctx
  }
}

// ───────────────────────────── 推力器 / 散热面 / 敏感器 ─────────────────────────────

/** 推力器三型的缺省（细节档示意值；质量取 paramBus.DENSITY 的 laeMass / rcsMass / epMass，可由装配件 density 覆盖）。 */
const THRUSTER = Object.freeze({
  lae: Object.freeze({ exitDM: G.laeExitDM, lengthM: G.laeLenM, seg: 32, frac: 0.4, massKey: 'laeMass', name: '远地点发动机' }),
  // 单只 10 N 缺省按 ArianeGroup S10 实测：出口内径 35 mm、法兰到出口 78 mm（双喷管支架按细节档 rcsExitDM 0.05 的名义尺寸缩放）
  rcs: Object.freeze({ exitDM: 0.035, lengthM: 0.08, seg: 12, frac: 0.4, massKey: 'rcsMass', name: '姿轨控推力器' }),
  ep: Object.freeze({ exitDM: DETAIL_PRESETS.leo.thrusterDM, lengthM: DETAIL_PRESETS.leo.thrusterLenM, seg: 20, frac: 0.5, massKey: 'epMass', name: '电推力器' })
})
const thrOf = (p) => {
  const K = THRUSTER[p.kind]
  return { K, er: (isNum(p.exitDM) ? p.exitDM : K.exitDM) / 2, L: isNum(p.lengthM) ? p.lengthM : K.lengthM, seg: Number.isInteger(p.seg) ? p.seg : K.seg, frac: isNum(p.massAtFrac) ? p.massAtFrac : K.frac }
}

const thruster = {
  type: 'sat.thruster', domain: SAT, title: 'Thruster', titleZh: '推力器', role: 'thruster', category: 'propulsion', family: 'thruster',
  aliases: ['发动机', '喷管', '姿控', '远地点', '霍尔', '电推', 'thruster', 'LAE', 'RCS'],
  presets: [
    { id: 'lae', titleZh: '远地点发动机', title: 'Apogee engine', aliases: ['LAE', '490 N', '主发动机'], params: { kind: 'lae' } },
    { id: 'rcs-pair', titleZh: '双喷管姿控推力器', title: 'Paired RCS thrusters', aliases: ['主备', '双喷管'], params: { pair: true } },
    { id: 'hall', titleZh: '霍尔电推力器', title: 'Hall-effect thruster', aliases: ['霍尔', '电推', 'SPT'], params: { kind: 'ep' } }
  ],
  params: {
    kind: enm('rcs', ['lae', 'rcs', 'ep'], '类型', { title: '远地点发动机：400–500 N（钟形喷管，燃烧室缩在安装面以内）；姿控推力器：10 N 双组元；电推力器：霍尔推力器', optionLabels: { lae: '远地点发动机', rcs: '姿控推力器', ep: '电推力器' } }),
    exitDM: num(null, 'm', '喷口直径', { nullable: true, gt: 0, title: '喷管出口直径（电推力器为放电通道直径）；留空按类型取示意值' }),
    lengthM: num(null, 'm', '长', { nullable: true, gt: 0, title: '安装面到喷口出口面的距离；留空按类型取示意值' }),
    pair: bool(false, '双喷管支架', { title: '姿控推力器：A/B 主备两只并排装在一块 MLI 小支架上（GEO 平台常见）' }),
    seg: int(null, '分段', { nullable: true, min: 6, max: 96 }),
    massAtFrac: num(null, '', '质心位置', { nullable: true, min: 0, max: 1, title: '质心沿喷流方向距安装点的长度比例；留空按类型取值' })
  },
  sockets: (p) => [ROOT_SOCKET(2 * thrOf(p).er, 15)],
  // 钟形喷管 / 双喷管支架关于两个面都对称；霍尔推力器的两只阴极挂在 +Y 一侧，只关于 yz 对称
  symmetricPlanes: (p) => (p.kind === 'ep' ? ['yz'] : evenSym(thrOf(p).seg)),
  // 喷流沿局部 +Z；造型与 paramBus 的远地点发动机 / 姿轨控支架 / 显式推力器 / 电推力器同式（hardware.bellNozzle / rcsPod / hallThruster）
  build(p, kit) {
    const ctx = kit.createCtx()
    const { K, er, L, seg, frac } = thrOf(p)
    const part = { id: 'thruster', name: K.name, role: 'thruster' }
    const main = p.kind === 'lae' ? 'dark_metal' : p.kind === 'ep' ? 'aluminum' : p.pair ? 'mli_gold' : 'titanium'
    addHw(ctx, 'thruster', part, 'thruster', main, (put) => {
      if (p.kind === 'lae') hwBellNozzle(put, { exit: [0, 0, L], dir: [0, 0, 1], up: [1, 0, 0], kind: 'lae', De: 2 * er, seg })
      else if (p.kind === 'ep') epThruster(put, [0, 0, 0], [0, 0, 1], [1, 0, 0], 2 * er, L)
      else if (p.pair) hwRcsPod(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], scale: 2 * er / 0.05 })
      else hwRcsThruster(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], De: 2 * er, L, seg })
    })
    pointComp(ctx, 'thruster', ctx.dens[K.massKey], [0, 0, L * frac])
    return ctx
  }
}

const radiator = {
  type: 'sat.radiator', domain: SAT, title: 'Radiator / body cells', titleZh: '散热面', role: 'radiator', category: 'thermal',
  aliases: ['散热', '热控', 'OSR', '体装电池', '电池片', 'radiator'],
  presets: [
    { id: 'cells', titleZh: '体装电池片', title: 'Body-mounted solar cells', aliases: ['体装', '电池片'], category: 'power', params: { kind: 'cells' } }
  ],
  params: {
    wM: num(1.0, 'm', '宽', { gt: 0 }),
    hM: num(1.0, 'm', '长', { gt: 0 }),
    tM: num(0, 'm', '厚', { min: 0 }),
    kind: enm('radiator', ['radiator', 'cells'], '面型', { title: '体装电池片单独构成太阳翼组', optionLabels: { radiator: '散热面', cells: '体装电池片' } }),
    standoffM: num(0.004, 'm', '离面', { min: -0.1, max: 0.5 }),
    efficiency: num(SOLAR_EFFICIENCY_DEFAULT, '%', '电池片效率', { min: 0, max: 100, title: '电池片光电转换效率（AGI 太阳翼组 efficiency，百分数）' })
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.hM))],
  symmetricPlanes: ['yz', 'xz'],
  // 贴在面上的薄板：装配拖放时射线穿过它、装到后面那个面上（不接件，也不挡件）
  passThrough: true,
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

// 星敏感器光学头的基准尺寸（hardware.starTrackerHead 缺省）：底板边长 / 遮光罩外径 / 底座以上的遮光罩长
const STAR_REF = Object.freeze({ hydra: [0.135, 0.147, 0.228], cone: [0.17, 0.156, 0.147] })
const sensorStar = {
  type: 'sat.sensor.star', domain: SAT, title: 'Star tracker', titleZh: '星敏感器', role: 'sensor', category: 'aocs',
  aliases: ['星敏', '星跟踪器', 'star tracker'],
  presets: [
    { id: 'cone', titleZh: '锥形遮光罩星敏感器', title: 'Star tracker (conical baffle)', aliases: ['锥形遮光罩'], params: { type: 'cone' } }
  ],
  params: {
    type: enm('hydra', ['hydra', 'cone'], '型式', { title: '圆柱遮光罩：方底座 + 镜筒 + 外银内黑圆柱罩（Sodern Hydra 类 Ø0.147 × 0.283 m）；锥形遮光罩：方盒 + 外扩锥罩（ASTRO APS 类 0.154 见方 × 0.237 m）', optionLabels: { hydra: '圆柱遮光罩', cone: '锥形遮光罩' } }),
    bodyM: num(0.135, 'm', '本体边长', { gt: 0, title: '底板边长' }),
    hoodDM: num(0.147, 'm', '遮光罩口径', { gt: 0, title: '遮光罩外径（锥形取口部）' }),
    hoodLenM: num(0.228, 'm', '遮光罩长', { gt: 0, title: '底座以上的镜筒 + 遮光罩长' }),
    cantDeg: num(0, '°', '斜装角', { min: 0, max: 60, title: '楔形座把视轴从安装面法向朝局部 +X 斜过去的角度（GEO 星敏视轴离南北向约 35°，多装在楔形座上）' }),
    seg: int(24, '分段', { min: 6, max: 96 })
  },
  sockets: (p) => [ROOT_SOCKET(p.bodyM)],
  // 接插件座在局部 +X 一侧：只关于 xz 对称
  symmetricPlanes: ['xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'sensor', name: '星敏感器', role: 'sensor' }
    const ref = STAR_REF[p.type] || STAR_REF.hydra
    const c = (p.cantDeg || 0) * Math.PI / 180, dir = [Math.sin(c), 0, Math.cos(c)]
    let top = null
    addHw(ctx, 'sensor', part, 'sensor', 'aluminum', (put) => {
      // 整体比例取底板边长（底座高度随它），遮光罩口径 / 长再各自相对它伸缩
      const k = p.bodyM / ref[0]
      const base = c > 1e-9 ? hwWedge(put, { base: [0, 0, 0], n: [0, 0, 1], top: dir, size: 1.33 * ref[0] * k, up: [1, 0, 0] }).top : [0, 0, 0]
      top = hwStarTracker(put, { base, dir, up: [1, 0, 0], type: p.type, scale: k, kr: p.hoodDM / ref[1] / k, kz: p.hoodLenM / ref[2] / k, seg: p.seg }).aperture
    })
    ctx.parts.get('sensor').normalBody = dir
    apLocal(ctx, 'boresight', top, dir)
    return ctx
  },
  unitMass: (p) => [boxElem('body', 1, [0, 0, p.bodyM / 2], [p.bodyM / 2, p.bodyM / 2, p.bodyM / 2])]
}

// 太阳敏感器基准尺寸（hardware.sunSensor 缺省）：宽 / 长 / 高
const SUN_REF = Object.freeze({ fss: [0.104, 0.094, 0.052], css: [0.11, 0.11, 0.032] })
const sensorSun = {
  type: 'sat.sensor.sun', domain: SAT, title: 'Sun sensor', titleZh: '太阳敏感器', role: 'sensor', category: 'aocs',
  aliases: ['太敏', 'sun sensor'],
  presets: [
    { id: 'css', titleZh: '粗太阳敏感器', title: 'Coarse sun sensor', aliases: ['粗太敏'], params: { type: 'css' } }
  ],
  params: {
    type: enm('fss', ['fss', 'css'], '型式', { title: '精太阳敏感器：金色圆角盒 + 方镶框黑凹窗 + 玻璃；粗太阳敏感器：金色托盘 + 四面 22° 电池金字塔', optionLabels: { fss: '精太阳敏感器', css: '粗太阳敏感器' } }),
    wM: num(0.104, 'm', '宽', { gt: 0 }), lM: num(0.094, 'm', '长', { gt: 0 }), tM: num(0.052, 'm', '高', { gt: 0 })
  },
  sockets: (p) => [ROOT_SOCKET(Math.min(p.wM, p.lM))],
  symmetricPlanes: (p) => (p.type === 'css' ? ['yz', 'xz'] : ['xz']),
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'sensor', name: '太阳敏感器', role: 'sensor' }
    const ref = SUN_REF[p.type] || SUN_REF.fss
    let top = null
    addHw(ctx, 'sensor', part, 'sensor', 'gold_metal', (put) => { top = hwSunSensor(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], type: p.type, kx: p.wM / ref[0], ky: p.lM / ref[1], kz: p.tM / ref[2] }).top })
    ctx.parts.get('sensor').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', top, [0, 0, 1])
    return ctx
  },
  unitMass: (p) => [boxElem('body', 1, [0, 0, p.tM / 2], [p.wM / 2, p.lM / 2, p.tM / 2])]
}

// 地球敏感器基准尺寸（hardware.earthSensor）：底边长 / 高
const EARTH_REF = Object.freeze({ ires: [0.17, 0.156], std15: [0.206, 0.172] })
const sensorEarth = {
  type: 'sat.sensor.earth', domain: SAT, title: 'Earth sensor', titleZh: '地球敏感器', role: 'sensor', category: 'aocs',
  aliases: ['地敏', '红外地平仪', 'earth sensor'],
  presets: [
    { id: 'std15', titleZh: '双侧窗地球敏感器', title: 'Earth sensor (dual side windows)', aliases: ['双侧窗'], params: { type: 'std15' } }
  ],
  params: {
    type: enm('ires', ['ires', 'std15'], '型式', { title: '顶窗式：金色盒 + 顶面偏置窗（Leonardo IRES-C 类 0.170 × 0.164 × 0.156 m）；双侧窗式：黑色倒角方座 + 铝罩、两侧窗（Sodern STD 15 类 0.206 见方 × 0.172 m）', optionLabels: { ires: '顶窗式', std15: '双侧窗式' } }),
    scale: num(1, '', '尺寸比例', { gt: 0 })
  },
  sockets: (p) => [ROOT_SOCKET((EARTH_REF[p.type] || EARTH_REF.ires)[0] * p.scale)],
  symmetricPlanes: (p) => (p.type === 'std15' ? ['yz', 'xz'] : []),
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'sensor', name: '地球敏感器', role: 'sensor' }
    let top = null
    addHw(ctx, 'sensor', part, 'sensor', p.type === 'std15' ? 'black_paint' : 'gold_metal', (put) => { top = hwEarthSensor(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], type: p.type, scale: p.scale }).top })
    ctx.parts.get('sensor').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', top, [0, 0, 1])
    return ctx
  },
  unitMass: (p) => { const [w, hh] = EARTH_REF[p.type] || EARTH_REF.ires, a = w * p.scale / 2, z = hh * p.scale / 2; return [boxElem('body', 1, [0, 0, z], [a, a, z])] }
}

const antennaTtc = {
  type: 'sat.antenna.ttc', domain: SAT, title: 'TT&C antenna', titleZh: '测控天线', role: 'feed', category: 'antenna', family: 'wire',
  aliases: ['测控', '遥测遥控', 'TT&C', '双锥', '全向', '宽波束'],
  presets: [
    { id: 'bicone', titleZh: '双锥测控天线', title: 'Biconical TT&C antenna', aliases: ['双锥'], params: { kind: 'bicone' } }
  ],
  params: {
    kind: enm('wca', ['wca', 'bicone'], '型式', { title: '宽波束喇叭：「管」形喇叭（欧洲平台对地 / 背地各一，Ku 频段 Ø ≤ 0.125 m、本色铝）；双锥：双锥全向天线 + 琥珀色圆极化套筒（北美平台，装在对地板桅杆上）', optionLabels: { wca: '宽波束喇叭', bicone: '双锥' } }),
    band: enm('Ku', ['Ku', 'C'], '频段', { title: 'C 频段约放大 2.5–2.8 倍', optionLabels: { Ku: 'Ku 频段', C: 'C 频段' } }),
    mastLenM: num(0.45, 'm', '桅杆长', { min: 0, title: '0 = 直接装在面上' }),
    polarizer: bool(true, '极化套筒', { title: '双锥外的圆极化套筒' }),
    scale: num(1, '', '尺寸比例', { gt: 0 })
  },
  sockets: (p) => [ROOT_SOCKET(0.072 * p.scale)],
  symmetricPlanes: ['yz', 'xz'],
  build(p, kit) {
    const ctx = kit.createCtx()
    const part = { id: 'antenna', name: '测控天线', role: 'feed' }
    let top = null
    addHw(ctx, 'antenna', part, 'feed', 'aluminum', (put) => { top = ttcAntenna(put, { base: [0, 0, 0], dir: [0, 0, 1], up: [1, 0, 0], kind: p.kind, band: p.band, mastLen: p.mastLenM, polarizer: p.polarizer, scale: p.scale }).top })
    ctx.parts.get('antenna').normalBody = [0, 0, 1]
    apLocal(ctx, 'boresight', top, [0, 0, 1])
    return ctx
  }
}

export const PRIM_COMPONENTS = Object.freeze([primBox, primCyl])
export const SAT_COMPONENTS = Object.freeze([busBox, busCyl, busHex, busTrap, busFlat, wing, reflector, feedHorn, arrayPhased, tower, boom, thruster, radiator, sensorStar, sensorSun, sensorEarth, antennaTtc])

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
/** 以 d 为 +Z、x 取 up 去掉 d 分量的局部系（与 hardware 的 axisFrame 同一口径：造型件按它排开的方向对得上）。 */
function frameZU(d, up) {
  const z = nrm(d), x = nrm(reject(up, z))
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
const focalOf = (r, D) => (isNum(r.focalM) ? r.focalM : (isMeshRefl(r, D) ? D.fdMesh : r.mount === 'deck' ? D.fdSolid : D.fdSide) * r.diameterM)
const deckOffset = (r, D) => (isNum(r.offsetHM) ? r.offsetHM : r.diameterM / 2 + 0.1 * D.reflDetailScale)
const slotSign = (slot) => (slot.startsWith('-') || slot === 'deck-Y' ? -1 : 1)
const slotOffsetDir = (slot) => (slot.startsWith('deck') ? [0, slotSign(slot), 0] : [slotSign(slot), 0, 0])
const feedArraySize = (r, Dm, k) => (isNum(r.feedApertureM) ? r.feedApertureM : clampN(0.12 * Dm, 0.6 * k, 2.0 * k))

/**
 * 列表条目（反射面 / 馈源 / 杆件 / 推力器 / 散热面）的稳定序号：条目带正整数 uid 且不重复就用它；没带的取「下标 + 1」
 * （与加 uid 之前逐位相同），撞号时递补最小的空号。驱动装配件（drive.mjs）靠它让组件 id 不随增删中间条目而错位——
 * 删掉第 2 副反射面后，第 3 副仍叫 refl3，用户对它的改写不会被第 2 副继承。
 * @returns {number[]} 与 list 等长
 */
function serialsOf(list) {
  const used = new Set(), out = list.map(() => 0)
  list.forEach((x, i) => {
    const u = x && Number.isInteger(x.uid) && x.uid > 0 && x.uid < 1e6 ? x.uid : 0
    if (u && !used.has(u)) { used.add(u); out[i] = u }
  })
  let next = 1
  for (let i = 0; i < list.length; i++) {
    if (out[i]) continue
    let k = i + 1
    if (used.has(k)) { while (used.has(next)) next++; k = next }
    used.add(k); out[i] = k
  }
  return out
}

/**
 * paramBus 整星 spec（须已 normalizeSpec 且 validateSpec 通过）→ 装配组件列表（未归一；specToAssembly 再 normalizeAssembly）。
 * 组件 id 用可读短名（bus / wing1 / refl1 / arm1a …），都满足装配组件 id 规则；列表条目的序号见 serialsOf，太阳翼按装在哪一面
 * （+Y → wing1、−Y → wing2；同参数的一对合成 wing1 + 对称）。
 * 另出两张表给驱动装配件（drive.mjs）：
 *   links：{组件 id: {参数键: [{p: spec 路径, m: 映射}]}}——该组件参数与 spec 字段一一对应（照抄、或取反 / 换型），改它等于改 spec；
 *          映射 m：'id' 照抄、'neg' 取反（镜像翼的转角）、'mesh' 反射面型式 ↔ spec.mesh 布尔、'mli' 平台体包覆 ↔ bus.mli + detail.mli。
 *          由细节档或别的量推算出来的参数（轭杆径、展开臂长、相控阵块尺寸…）不进表。
 *   items：{组件 id: [spec 列表条目路径]}——该组件就是 spec 某个列表条目（删它 = 删条目）；对称的一对翼对应两条。
 * @returns {{comps:object[], warnings:string[], links:object, items:object}}
 */
export function satSpecToComps(s) {
  const D = DETAIL_PRESETS[s.detailPreset]
  const comps = [], warnings = [], links = {}, items = {}
  const put = (c) => { comps.push(c); return c }
  /** 记一条参数联动：link(组件 id, 参数键, spec 路径, 映射?)；同一参数可连多条（对称翼） */
  const link = (id, key, p, m = 'id') => {
    const L = links[id] || (links[id] = {})
    ;(L[key] || (L[key] = [])).push({ p, m })
  }
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
  link('bus', 'xM', 'bus.xM'); link('bus', 'yM', 'bus.yM'); link('bus', 'zM', 'bus.zM'); link('bus', 'massKg', 'bus.massKg')
  if (geo) { link('bus', 'mli', 'bus.mli', 'mli'); link('bus', 'radiators', 'detail.radiators'); link('bus', 'adapter', 'detail.adapter') }

  // —— GEO：远地点发动机 + 8 个姿轨控推力器 + 对地板喇叭 / 地球敏感器
  if (geo && s.detail.thrusters) {
    put({ id: 'lae', type: 'sat.thruster', parent: 'bus', attach: surf('-Z', [0, 0]), params: { kind: 'lae', exitDM: D.laeExitDM, lengthM: D.laeLenM } })
    // 8 处 A/B 双喷管姿控支架（paramBus.rcsLayout）：背地面四角斜出的挂在 −Z 面上（面内偏移随平台尺寸走）、自由姿态给喷流方向
    // 与两喷管排开方向；东西面的贴面装（面系 u = +Z 就是排开方向）
    const fz = face('-Z')
    rcsLayout(h).forEach((q, i) => {
      const id = `rcs${i + 1}`, params = { kind: 'rcs', exitDM: D.rcsExitDM, lengthM: D.rcsLenM, pair: true }
      if (q.face === '-Z') {
        const uv = [dot(sub(q.p, fz.t), fz.R[0]), dot(sub(q.p, fz.t), fz.R[1])]
        const anchor = { R: fz.R, t: add(fz.t, add(scl(fz.R[0], uv[0]), scl(fz.R[1], uv[1]))) }
        const r = rel(anchor, frameZU(q.d, q.up), q.p)
        put({ id, type: 'sat.thruster', parent: 'bus', attach: { mode: 'free', face: '-Z', uv: uv.map(z0) }, t: r.t, q: r.q, params })
      } else {
        const F = face(q.face)
        put({ id, type: 'sat.thruster', parent: 'bus', attach: surf(q.face, [dot(sub(q.p, F.t), F.R[0]), dot(sub(q.p, F.t), F.R[1])]), params })
      }
    })
  }
  // 对地板小喇叭（台阶锥本色铝、无馈电链——链在星体里）与地球敏感器（paramBus.buildDeckHorns 同式）：组件先占顺序位，
  // 落点（deckSpots：避开塔 / 反射面 / 馈源与支架 / 测控天线）等反射面群解算完再填
  const deckComps = []
  if (geo && s.detail.deckHorns > 0) {
    const n = s.detail.deckHorns
    for (let i = 0; i < Math.min(n, 3); i++) deckComps[i] = put({ id: `horn${i + 1}`, type: 'sat.feed.horn', parent: 'bus', attach: null, params: { kind: 'horn', apertureM: D.hornApM, lengthM: D.hornLenM, style: 'terraced', finish: 'aluminum', chain: 'none', seg: 20 } })
    deckComps[3] = put({ id: 'esensor', type: 'sat.sensor.earth', parent: 'bus', attach: null, params: { type: 'ires', scale: D.hornApM / 0.12 } })
  }
  if (geo && s.detail.sensors !== false) {
    // 星敏两头（北板对地端、楔形座斜装）+ 测控天线（对地板桅杆 / 背地面对角）：paramBus.buildGeoSensors 同一布局
    const SL = geoSensorLayout(h, D, s.detail.ttc)
    SL.stars.forEach((q, i) => put({ id: `star${i + 1}`, type: 'sat.sensor.star', parent: 'bus', attach: surf('-Y', q.uv, z0(Math.round(q.rollDeg * 1e9) / 1e9)), params: { type: 'hydra', bodyM: 0.135 * SL.ks, hoodDM: 0.147 * SL.ks, hoodLenM: 0.228 * SL.ks, cantDeg: q.cantDeg, seg: 32 } }))
    SL.ttc.forEach((q, i) => put({ id: `ttc${i + 1}`, type: 'sat.antenna.ttc', parent: 'bus', attach: surf(q.face, q.uv), params: { kind: q.kind, band: 'Ku', mastLenM: q.mastLen, polarizer: true, scale: SL.ks } }))
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
          // 外观与整星（paramBus 平板 LEO 的白色相控阵块）逐位相同：矩形外廓 + 白色罩面 + 白边框（arrayPanel 的旧版兼容路径）
          put({ id: `array${++k}`, type: 'sat.array.phased', parent: 'bus', attach: surf('+Z', [cx, cy]), params: { wM: 2 * tx, hM: 2 * ty, tM: D.phasedTileTM, tiles: 1, standoffM: 0.01, shape: 'rect', face: 'radome', faceMat: 'white_paint', frameMat: 'white_paint' } })
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
      panels: w.panels, panelHM: w.panelHM, panelWM: w.panelWM, sidePanels: w.sidePanels, sidePanelAt: w.sidePanels === 2 && Number.isInteger(w.sidePanelAt) ? w.sidePanelAt : null, yokeLenM: w.yokeLenM, gapM: w.gapM, tiltDeg: w.tiltDeg, efficiency: w.efficiency,
      articulate: true, sadaLenM: D.sadaLenM, sadaDM: D.sadaDM, yokeRodDM: D.yokeRodDM, panelTM: D.panelTM, cellMarginM: D.cellMarginM
    })
    const same = (a, b) => ['panels', 'panelHM', 'panelWM', 'sidePanels', 'sidePanelAt', 'yokeLenM', 'gapM', 'efficiency'].every((k) => a[k] === b[k])
    const wp_ = s.wings.find((w) => w.side === '+Y'), wm = s.wings.find((w) => w.side === '-Y')
    const place = (w) => (isVec3(w.hingeBody)
      ? (() => { const F = face(w.side); return { attach: { mode: 'free' }, t: w.hingeBody.slice(), q: quatOf(F.R) } })()
      : { attach: surf(w.side, [0, 0]) })
    let sym = null
    if (wp_ && wm && !isVec3(wp_.hingeBody) && !isVec3(wm.hingeBody) && same(wp_, wm)) {
      if (wm.tiltDeg === -wp_.tiltDeg) sym = { group: 'wings', op: 'mirrorXZ' }
      else if (wm.tiltDeg === wp_.tiltDeg) sym = { group: 'wings', op: 'radial', n: 2, axis: '+Z' }
    }
    const WING_KEYS = ['panels', 'panelHM', 'panelWM', 'sidePanels', 'sidePanelAt', 'yokeLenM', 'gapM', 'efficiency']
    if (sym) {
      put({ id: 'wing1', type: 'sat.wing', parent: 'bus', ...place(wp_), params: wp(wp_), sym })
      const ip = s.wings.indexOf(wp_), im = s.wings.indexOf(wm)
      for (const key of WING_KEYS) { link('wing1', key, `wings[${ip}].${key}`); link('wing1', key, `wings[${im}].${key}`) }
      link('wing1', 'tiltDeg', `wings[${ip}].tiltDeg`); link('wing1', 'tiltDeg', `wings[${im}].tiltDeg`, sym.op === 'mirrorXZ' ? 'neg' : 'id')
      items.wing1 = [`wings[${ip}]`, `wings[${im}]`]
    } else {
      // 各自装：按装在哪一面取 id（+Y → wing1、−Y → wing2），与条目在数组里的先后无关；同面重复（非法 spec）退回下标
      const taken = new Set()
      s.wings.forEach((w, i) => {
        let id = w.side === '+Y' ? 'wing1' : w.side === '-Y' ? 'wing2' : `wing${i + 1}`
        if (taken.has(id)) { let n = 3; while (taken.has(`wing${n}`)) n++; id = `wing${n}` }
        taken.add(id)
        put({ id, type: 'sat.wing', parent: 'bus', ...place(w), params: wp(w) })
        for (const key of [...WING_KEYS, 'tiltDeg']) link(id, key, `wings[${i}].${key}`)
        items[id] = [`wings[${i}]`]
      })
    }
  }

  // —— 反射面群（与 paramBus.buildReflectors / reflectorLayout / buildFeed 支架 / buildReflectorArm 逐式相同）
  const refl = s.reflectors || []
  const deckKeep = []
  let deckTower = null
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
      put({ id: 'tower', type: 'sat.tower', parent: 'bus', attach: surf('+Z', [0, 0]), params: { wM: tw, hM: towerH, finish: towerFinish(s) } })
      link('tower', 'wM', 'tower.wM'); link('tower', 'hM', 'tower.hM')
      towerTop = { R: ID.R, t: [0, 0, hRefl[2] + towerH] }
      deckTower = { tw, towerH }
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
    const rs = serialsOf(refl)
    refl.forEach((r, i) => {
      const L = layouts[i], n = rs[i]
      const sideSolid = L.mount === 'side' && !L.mesh
      const params = {
        diameterM: L.D, focalM: L.f, fD: G.fdSolid, offsetHM: L.dc, surface: L.mesh ? 'mesh' : 'solid', back: true,
        front: r.front || 'white', rear: r.rear || 'cfrp', backing: 'ring8', support: sideSolid ? 'rect' : 'none',
        feed: r.feedType, feedApertureM: isNum(r.feedApertureM) ? r.feedApertureM : null,
        shellM: D.shellM, trussDepthFrac: D.meshTrussDepthFrac, trussRodFrac: D.meshTrussRodFrac, meshAboveDM: D.meshAboveDM, detailScale: k
      }
      const rid = `refl${n}`
      for (const key of ['diameterM', 'focalM', 'offsetHM', 'feedApertureM']) link(rid, key, `reflectors[${i}].${key}`)
      link(rid, 'feed', `reflectors[${i}].feedType`)
      // 型式只在 spec 说了算时联动：口径超过网状门限的一律网状（isMeshRefl），这时改成实面只能算本件改写
      if (!(r.diameterM > D.meshAboveDM)) link(rid, 'surface', `reflectors[${i}].mesh`, 'mesh')
      items[rid] = [`reflectors[${i}]`]
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
      // 馈源支架（paramBus.buildFeed / feedSupportRods：侧挂 = 三脚架落到对地板、塔馈 = 两根撑杆接塔顶）；第一根沿用老 id sup<n>
      const dir = nrm(sub(L.Pc, L.F))
      const back = r.feedType === 'array' ? madd(L.F, dir, -0.08 * k) : feedHornGeom(r, L).back
      const tTop = r.mount === 'deck' && !r.posBody ? hRefl[2] + towerH : null
      const hh = hRefl
      L.h = hh
      feedSupportRods(back, L, tTop).forEach(([p0, p1], j) => rodTo(j ? `sup${n}${String.fromCharCode(97 + j)}` : `sup${n}`, p0, p1, 2 * feedSupportR(L), 8))
      deckKeep.push(...deckKeepOfFeed(r, L, back, tTop))
      // 展开臂（paramBus.buildReflectorArm）：侧挂实面 = 侧壁上的两轴展开机构（hinge<n>）+ 一根直臂到支撑框内侧横梁（arm<n>a），都裹金色 MLI
      if (sideSolid) {
        L.link = backingLink(L, { sh: D.shellM, backing: 'ring8', support: 'rect' })
        const g = sideArmGeom(L)
        const sg = L.s
        const Rh = [[0, 1, 0], [0, 0, sg], [sg, 0, 0]]
        const rh = rel(ID, Rh, g.base)
        put({ id: `hinge${n}`, type: 'prim.box', parent: 'bus', attach: { mode: 'free' }, t: rh.t, q: rh.q, params: { xM: 0.25 * g.k, yM: 0.2 * g.k, zM: 0.288 * g.k, hasMass: false }, material: 'mli_gold' })
        child(`arm${n}a`, 'sat.boom', frameZ(sub(g.link, g.out)), g.out, { lengthM: len(sub(g.link, g.out)), dM: 2 * g.r, seg: 12 }, { material: 'mli_gold' })
        return
      }
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

  if (deckComps.length) {
    const spots = deckSpots(hRefl, D, deckKeep.concat(deckKeepOfDeck(hRefl, D, deckTower ? deckTower.tw : null, deckTower ? deckTower.towerH : null, s.detail.ttc, s.detail.sensors !== false)), s.detail.deckHorns)
    deckComps.forEach((c, i) => { c.attach = surf('+Z', spots[i]) })
  }

  // —— 显式附加件（feeds / booms / thrusters / radiators），全部相对平台体中心
  const busPose = ID
  const fs_ = serialsOf(s.feeds), bs = serialsOf(s.booms), ts = serialsOf(s.thrusters), ras = serialsOf(s.radiators)
  s.feeds.forEach((f, i) => {
    const d = nrm(f.dirBody), id = `feedx${fs_[i]}`
    if (f.kind === 'patchArray') { const r = rel(busPose, frameZ(d), f.posBody); put({ id, type: 'sat.feed.horn', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'patch', apertureM: f.apertureM } }) }
    else {
      // paramBus.buildExtras：口面在 posBody、台阶锥阿洛丁金色喇叭 + 线极化馈电链
      const Lh = extraHornLen(f.apertureM), r = rel(busPose, frameZ(d), madd(f.posBody, d, -Lh))
      put({ id, type: 'sat.feed.horn', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'horn', apertureM: f.apertureM, lengthM: Lh, style: 'terraced', finish: 'gold_metal', chain: 'linear', seg: 24 } })
    }
    link(id, 'apertureM', `feeds[${i}].apertureM`)
    items[id] = [`feeds[${i}]`]
  })
  s.booms.forEach((b, i) => {
    const r = rel(busPose, frameZ(sub(b.toBody, b.fromBody)), b.fromBody), id = `boomx${bs[i]}`
    put({ id, type: 'sat.boom', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { lengthM: len(sub(b.toBody, b.fromBody)), dM: b.dM, seg: 10 } })
    link(id, 'dM', `booms[${i}].dM`)
    items[id] = [`booms[${i}]`]
  })
  s.thrusters.forEach((t, i) => {
    const r = rel(busPose, frameZ(t.dirBody), t.posBody), id = `thrx${ts[i]}`
    put({ id, type: 'sat.thruster', parent: 'bus', attach: { mode: 'free' }, t: r.t, q: r.q, params: { kind: 'rcs', exitDM: t.exitDM, lengthM: t.lengthM, seg: 16, massAtFrac: 0 } })
    link(id, 'exitDM', `thrusters[${i}].exitDM`); link(id, 'lengthM', `thrusters[${i}].lengthM`)
    items[id] = [`thrusters[${i}]`]
  })
  s.radiators.forEach((r, i) => {
    // paramBus 把显式散热面放在包络面外 6 mm；平台体的面在结构盒上，离面补上「包络 − 结构盒」（非立方星为 0）
    const Fr = FACE_FRAMES[r.face], [e1] = perpPair(Fr.n), ax = axisOf(Fr.n), id = `radx${ras[i]}`
    const roll = Math.atan2(dot(cross(Fr.u, e1), Fr.n), dot(Fr.u, e1)) * 180 / Math.PI
    put({ id, type: 'sat.radiator', parent: 'bus', attach: surf(r.face, [0, 0], z0(Math.round(roll * 1e9) / 1e9)), params: { kind: 'radiator', wM: r.wM, hM: r.hM, tM: 0, standoffM: 0.006 + (h[ax] - hs[ax]) } })
    link(id, 'wM', `radiators[${i}].wM`); link(id, 'hM', `radiators[${i}].hM`)
    items[id] = [`radiators[${i}]`]
  })
  if (s.wings && s.wings.length > 2) warnings.push(`翼数 ${s.wings.length} 超出南北两翼`)
  return { comps, warnings, links, items }
}

