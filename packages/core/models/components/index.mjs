// 装配组件注册表（三期契约 DESIGN3 E2；装配调研 assembly-ux §3.2）。
//
// 纯 ESM、零 three 依赖、node 可测。装配文档（assembly.mjs）里每个组件的 type 都在这里查定义；
// 各领域的组件定义放在同目录的 <领域>.mjs，模块加载时按下列顺序逐个登记（登记顺序即组件库卡片顺序）：
//   sat.mjs（2 个通用基本体 + 17 个卫星组件）+ satAntenna.mjs / satUnit.mjs / satWing.mjs（2026-10-08 补全的 16 个卫星天线 / 载荷 / 设备 /
//   机构件 + 4 种太阳翼 + 4 种星体（satBus.mjs）；
//   卫星件按 SAT_ORDER 排：结构 → 电源 → 天线 → 有效载荷 → 推进 → 姿轨控 → 热控）→ ground.mjs（13 个地球站组件）→ air.mjs
//   → sea.mjs → veh.mjs。非卫星领域共用的造型工具在 shapeKit.mjs（不登记组件，只供各领域文件 import）。
//
// ★ ComponentDef（登记时校验并冻结）：
//   {
//     type        'sat.wing' 一类的点分小写键（注册表主键，存进装配文档，终身不改名）
//     domain      允许出现在哪些领域的装配件里（ASM_DOMAINS 的子集）
//     title / titleZh  组件名（英 / 中；组件库卡片与结构树的缺省显示名）
//     role        部件角色（ir.PART_ROLES；组件库分组、缺省高亮用）
//     category?   组件库里的功能分组（COMPONENT_CATEGORIES 之一：结构与机构 / 电源 / 天线 / 有效载荷 / 推进 / 姿轨控 / 热控；卫星件都带）
//     aliases?    组件库搜索的别名（字符串数组：「全向」「QHA」「SAR」…）
//     presets?    常用型号（组件库里各占一张卡片，拖入即带这组参数）：[{id, titleZh, title, params, aliases?, category?}]
//                 id 为小写连字符键（库卡片键 `${type}#${id}`、缩略图缓存键用；终身不改名）；params 只写与缺省不同的键，
//                 登记时补缺省后过 checkParams；category 缺省同组件（体装电池片这类按用途归到别的小组时才给）
//     params      { key: ParamSpec }（见下）；键的顺序即属性面板顺序
//     mountSocket 本件拿哪个插座去贴父件（缺省 'root'）
//     sockets(p)  → [{id, pos, n, up, size, accepts, roll}]：插座（局部系；字段名同 assembly-ux §3.2）。
//                   n = 朝外单位法向（背离本件），up = 滚转零位（⟂ n）；size = 名义接口尺寸（米，> 0：吸附标记的绘制尺寸，不参与解算）；
//                   accepts = 可接的组件 type 前缀数组（null = 不限；只作吸附筛选，validateAssembly 不拦，见 socketAccepts）；
//                   roll = 滚转档（度，≥ 0：吸附时取该档的最近整数倍；0 = 不许滚转，恒 0°）。登记时按缺省参数查一遍形状
//     faces(p)    → [{id, kind:'plane', origin, n, u, v, halfU, halfV}
//                    | {id, kind:'cyl', origin, axis, ref, radius, halfU, halfV}]：可贴面（局部系）。
//                   平面：u × v = n，面内坐标 (uv0, uv1) 沿 (u, v)；柱面：uv0 = 沿轴高度、uv1 = 弧长（见 assembly.mjs faceFrame）
//     build(p, kit) → 生成上下文（meshKit.createCtx 同形：items / comps / parts / aps / arts / spg / warnings），全部在【组件局部系】；
//                   aps 的 upBody 可为 null = 到本体系再按 D1 缺省规则补（局部系里补会错）
//     mirror?(p, plane) / mirrorPlanes?  镜像钩子：mirrorPlanes 列出钩子支持的局部镜面（'yz' / 'xz' / 'xy'），
//                   mirror 返回「关于该局部面镜像后的几何」对应的参数（见 assembly.mjs 的镜像数学）
//     symmetricPlanes?  数组或 (p) => 数组：本件几何关于哪些局部面对称（镜像时不必烘焙）
//     unitMass?(p) → [{name, kind, massKg:1, com, I}]：自身没有质量元、装配件又手填了质量时的质量分布（按 1 kg 给，调用方缩放）
//     massSink?    本件哪个质量元吃「装配件目标质量」的余量（文档里首个带它、质量没手填的主件生效，不要求是根件；平台体 / 机身 / 船体 / 车体用）
//     busySockets?(p) → string[]：本件自己就占着的插座 id（自带馈源的反射面占焦点）：装配吸附 / 自动选位当它已占用（asmSnap.occupiedSocketKeys），
//                   不影响解算——已经挂在上面的子件照样合法
//     singleSockets? string[] | (p) => string[]：单件插座——装在上面的子件按设计只有一件（直升机尾桨），工具栏对称的缺省不作用于它
//                   （asmSnap.socketSingle；用户显式设对称照常生效）
//     passThrough? 贴在面上的薄件（散热面 / 体装电池片）：装配拖放时射线穿过它、装到后面的面上；别的接不了件的件会挡住落点
//     passThroughWhen?(p) → boolean：按参数判的薄件（基本体：纯外观且厚度 ≤ 5 mm 的对地贴片）；与 passThrough 合起来走
//                   passThroughOf(def, params)（布尔 passThrough 保持不变：老读法 `def.passThrough` 照旧只认整类薄件）
//     mountableFaces? false | (p) => boolean：本件的面可否作安装基面（缺省可以）。机构 / 小件 / 纯外观件的面不收件（面推断、
//                   面磁吸、取锚、属性面板「面」下拉都按它筛；与这些面心重合的通用插座一并不收，见 asmSnap.socketUsable）。
//                   面另可带 accepts（同插座：type 前缀数组，null / 缺 = 不限）；判据 faceAccepts(def, params, face, type)
//     validate?(p) → string[]：参数间的约束（单参数的范围由 ParamSpec 管）
//   }
//   柱面可带 full（整圆：|2·halfV − 2πr| < 1e-6·r）；不带时由 asmSnap.clampIO 按同一式子现判（局部弧夹紧、整圆回绕）。
//   局部坐标约定（DESIGN3 E2）：原点 = 安装基准点、局部 −Z 贴父面（mount 插座 n = −Z）、局部 +X 为滚转零位。
//   飞机 / 船 / 车 / 地球站（本体 +Z 向下的 FRD / NED 领域）的落法：局部系与领域本体同向，立件 mount 插座 n = +Z（朝下贴父面）、
//   吊挂件 n = −Z、横向对齐件 n = ∓Y（shapeKit latSocket / latMount）；根件单位位姿即本体系，子件滚转 0° 时与父件同向
//   （A3 SPEC §1.1、编排者 2026-09-24 确认 §12-5；按 E2 字面每个立件都会绕 X 转 180°，非对称件左右舷会反）。
//
// ★ ParamSpec：{ kind:'num'|'int'|'bool'|'enum', def, min?, gt?, max?, options?, nullable?, unit?, step?,
//                source:'illustrative'|URL, label, labelEn?, title?, optionLabels? }
//   optionLabels：{选项值: 显示名}（enum 的选项在属性面板 / 快速设置里显示的中文名；键须是 options 里的值）
//   min / max 闭区间，gt 为开下界；options 给 enum / int 的可选值；nullable = null 合法（含义由组件自己定：通常「自动」）。
//   label 是属性面板上的短标签；title 是悬停说明（界面零说明文字：口径只放悬停）。
//
// 导出：
//   ASM_DOMAINS, PARAM_KINDS, PLANES
//   registerComponent(def, {replace?}) → 冻结后的 def；getComponent(type) → def | null；getPreset(type, id) → 型号 | null
//   listComponents(domain?) → def[]（登记顺序）；componentTypes() → string[]
//   fillParams(def, raw) → 补缺省后的参数（只留定义里的键）；checkParams(def, params, prefix) → string[]
//   socketAccepts(socket, type) → 插座能否接该 type 的组件；makeValuesEq(keys) → 按值比对器（解算缓存用）
//   faceAccepts(def, params, face, type?) → 面可否作安装基面（组件 mountableFaces + 面级 accepts；type 缺省不查面级 accepts）
//   passThroughOf(def, params) → 该件是不是贴在面上的薄件（passThrough ‖ passThroughWhen(params)；params 须补过缺省）
//   登记后的 def 另带 keys（参数键列表）与 paramsEq（本组件参数的按值比对器）

import { PART_ROLES } from '../ir.mjs'
import { SAT_COMPONENTS, PRIM_COMPONENTS } from './sat.mjs'
import { GROUND_COMPONENTS } from './ground.mjs'
import { AIR_COMPONENTS } from './air.mjs'
import { SEA_COMPONENTS } from './sea.mjs'
import { VEH_COMPONENTS } from './veh.mjs'
import { SAT_ANTENNA_COMPONENTS } from './satAntenna.mjs'
import { SAT_UNIT_COMPONENTS } from './satUnit.mjs'
import { SAT_WING_COMPONENTS } from './satWing.mjs'
import { SAT_BUS_COMPONENTS } from './satBus.mjs'

/** 装配件领域（DESIGN3 E5：卫星用本体 +X 速度 +Z 天底；飞机 / 船 / 车 FRD；地球站 NED）。 */
export const ASM_DOMAINS = Object.freeze(['spacecraft', 'ground', 'aircraft', 'ship', 'vehicle'])
export const PARAM_KINDS = Object.freeze(['num', 'int', 'bool', 'enum'])
/** 局部镜面 → 镜面法向所在的局部轴下标（'yz' 翻 x、'xz' 翻 y、'xy' 翻 z）。 */
export const PLANES = Object.freeze(['yz', 'xz', 'xy'])
/** 组件库功能分组键（顺序即组件库里的分组顺序；显示名在渲染端 asmLogic.CATEGORY_LABELS） */
export const COMPONENT_CATEGORIES = Object.freeze(['structure', 'power', 'antenna', 'payload', 'propulsion', 'aocs', 'thermal'])
/** 卫星组件的登记顺序（= 组件库卡片顺序；表外的卫星件排在表内各件之后，按原顺序） */
export const SAT_ORDER = Object.freeze([
  'sat.bus.box', 'sat.bus.cyl', 'sat.bus.hex', 'sat.bus.prism', 'sat.bus.trap', 'sat.bus.flat', 'sat.bus.cubesat', 'sat.bus.sphere', 'sat.bus.module', 'sat.tower', 'sat.boom', 'sat.dock',
  'sat.wing', 'sat.wing.hinged', 'sat.wing.flex', 'sat.wing.rosa', 'sat.wing.circular',
  'sat.reflector', 'sat.antenna.gimbal', 'sat.array.phased', 'sat.antenna.slot', 'sat.antenna.helix', 'sat.antenna.omni', 'sat.antenna.lpda', 'sat.antenna.ttc', 'sat.antenna.despun',
  'sat.feed.horn', 'sat.feed.cluster', 'sat.antenna.shroud',
  'sat.lct', 'sat.camera', 'sat.instrument', 'sat.lra',
  'sat.thruster', 'sat.ep.arm', 'sat.tank',
  'sat.sensor.star', 'sat.sensor.sun', 'sat.sensor.earth', 'sat.sensor.mag',
  'sat.radiator', 'sat.visor'
])

const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
const PRESET_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const SOCKET_ID_RE = /^[A-Za-z0-9_+-]+$/

/** 插座 s 能否接 type 组件：accepts 为 null 不限，否则 type 以其中某个前缀开头。 */
export const socketAccepts = (s, type) => !s || s.accepts == null || (typeof type === 'string' && s.accepts.some((p) => type.startsWith(p)))

/**
 * 面 face 可否作安装基面：组件 mountableFaces 为 false / 函数返回假 → 否；面带 accepts 时 type 须匹配其中某个前缀（type 不给不查）。
 * params 须是补过缺省的参数（fillParams）。
 */
export function faceAccepts(def, params, face, type) {
  if (!def || !face) return false
  const mf = def.mountableFaces
  if (mf === false) return false
  if (typeof mf === 'function') { try { if (!mf(params)) return false } catch { return false } }
  return face.accepts == null || typeof type !== 'string' || (Array.isArray(face.accepts) && face.accepts.some((p) => type.startsWith(p)))
}

/**
 * 件是不是「贴在面上的薄件」（拖放时射线穿过它再找）：整类薄件 passThrough === true，或 passThroughWhen(params) 为真。
 * params 须是补过缺省的参数（fillParams）；不分配（编辑器拖动热路径可调，passThroughWhen 自身也须不分配）。
 */
export function passThroughOf(def, params) {
  if (!def) return false
  if (def.passThrough === true) return true
  const f = def.passThroughWhen
  if (typeof f !== 'function' || !params) return false
  try { return f(params) === true } catch { return false }
}

/** 插座描述的形状（登记时按缺省参数查；返回问题短语列表）。 */
function checkSockets(list) {
  if (!Array.isArray(list)) return ['sockets 须返回数组']
  const out = [], ids = new Set()
  for (const s of list) {
    const id = isObj(s) ? s.id : undefined
    if (typeof id !== 'string' || !SOCKET_ID_RE.test(id)) { out.push(`插座 id 非法：${JSON.stringify(id)}`); continue }
    if (ids.has(id)) out.push(`插座 ${id} 重复`)
    ids.add(id)
    if (!isV3(s.pos) || !isV3(s.n) || !isV3(s.up)) out.push(`插座 ${id}：pos / n / up 须为 [x,y,z]`)
    if (!(isNum(s.size) && s.size > 0)) out.push(`插座 ${id}：size 须为正数`)
    if (!(isNum(s.roll) && s.roll >= 0)) out.push(`插座 ${id}：roll 须为非负数`)
    if (!(s.accepts === null || (Array.isArray(s.accepts) && s.accepts.every((x) => typeof x === 'string' && x)))) out.push(`插座 ${id}：accepts 须为 null 或前缀数组`)
  }
  return out
}

const REG = new Map()

/**
 * 按值比对器 eq(r, v)：r 的 keys[j] 键逐个等于 v[j]（=== 之外 NaN 视同 NaN）。r 须为对象（没有就传空对象）。
 * 装配件解算缓存每帧都要比参数：比对器在登记时建好（闭包的 Context 只分配这一次），热路径里调用不分配。
 */
export function makeValuesEq(keys) {
  const ks = Object.freeze(keys.slice())
  return (r, v) => {
    for (let j = 0; j < ks.length; j++) { const a = r[ks[j]], b = v[j]; if (!(a === b || (a !== a && b !== b))) return false }
    return true
  }
}

function checkSpec(type, key, s) {
  const bad = (m) => { throw new Error(`组件 ${type}：参数 ${key} ${m}`) }
  if (!isObj(s)) bad('定义须为对象')
  if (!PARAM_KINDS.includes(s.kind)) bad(`kind 非法（${s.kind}）`)
  if (s.options !== undefined && !(Array.isArray(s.options) && s.options.length)) bad('options 须为非空数组')
  if (s.kind === 'enum' && !Array.isArray(s.options)) bad('enum 须给 options')
  if (s.def === null) { if (!s.nullable) bad('缺省为 null 却未标 nullable') } else {
    const e = checkValue(s, s.def)
    if (e) bad(`缺省值 ${JSON.stringify(s.def)} ${e}`)
  }
  if (typeof s.label !== 'string' || !s.label) bad('缺 label')
  if (typeof s.source !== 'string' || !s.source) bad('缺 source')
  if (s.optionLabels !== undefined) {
    if (!isObj(s.optionLabels) || !Array.isArray(s.options)) bad('optionLabels 须为对象且参数须有 options')
    for (const [k, v] of Object.entries(s.optionLabels)) {
      if (!s.options.some((o) => String(o) === k)) bad(`optionLabels 的键 ${k} 不在 options 里`)
      if (typeof v !== 'string' || !v) bad(`optionLabels.${k} 须为非空字符串`)
    }
  }
}

/** 单个值是否符合 ParamSpec；合法返回 null，否则返回状态短语。 */
function checkValue(s, v) {
  if (v === null) return s.nullable ? null : '不可为空'
  switch (s.kind) {
    case 'bool': return typeof v === 'boolean' ? null : '须为布尔'
    case 'enum': return s.options.includes(v) ? null : `须为 ${s.options.map((o) => JSON.stringify(o)).join(' / ')} 之一`
    case 'int':
      if (!Number.isInteger(v)) return '须为整数'
      if (Array.isArray(s.options) && !s.options.includes(v)) return `须为 ${s.options.join(' / ')} 之一`
      break
    default:
      if (!isNum(v)) return '须为有限数'
  }
  if (isNum(s.min) && v < s.min) return `须 ≥ ${s.min}`
  if (isNum(s.gt) && !(v > s.gt)) return `须 > ${s.gt}`
  if (isNum(s.max) && v > s.max) return `须 ≤ ${s.max}`
  return null
}

/**
 * 登记组件定义（校验 + 冻结）。重复 type 抛错，除非 opts.replace（单测注册变体时用）。
 * @returns {object} 冻结后的定义（另带 keys：参数键列表）
 */
export function registerComponent(def, opts = {}) {
  if (!isObj(def)) throw new Error('组件定义须为对象')
  const type = def.type
  if (typeof type !== 'string' || !TYPE_RE.test(type)) throw new Error(`组件 type 非法：${type}`)
  if (REG.has(type) && !opts.replace) throw new Error(`组件 ${type} 重复登记`)
  if (!Array.isArray(def.domain) || !def.domain.length || !def.domain.every((d) => ASM_DOMAINS.includes(d))) throw new Error(`组件 ${type}：domain 非法`)
  if (!PART_ROLES.includes(def.role)) throw new Error(`组件 ${type}：role 非法（${def.role}）`)
  if (def.category !== undefined && !COMPONENT_CATEGORIES.includes(def.category)) throw new Error(`组件 ${type}：category 非法（${def.category}）`)
  if (def.aliases !== undefined && !(Array.isArray(def.aliases) && def.aliases.every((x) => typeof x === 'string' && x))) throw new Error(`组件 ${type}：aliases 须为字符串数组`)
  if (typeof def.build !== 'function') throw new Error(`组件 ${type}：缺 build`)
  if (!isObj(def.params)) throw new Error(`组件 ${type}：params 须为对象`)
  for (const [k, s] of Object.entries(def.params)) checkSpec(type, k, s)
  for (const f of ['sockets', 'faces', 'mirror', 'unitMass', 'validate', 'busySockets', 'passThroughWhen']) {
    if (def[f] !== undefined && typeof def[f] !== 'function') throw new Error(`组件 ${type}：${f} 须为函数`)
  }
  if (def.mirror && !(Array.isArray(def.mirrorPlanes) && def.mirrorPlanes.length && def.mirrorPlanes.every((p) => PLANES.includes(p)))) throw new Error(`组件 ${type}：有 mirror 钩子须给 mirrorPlanes`)
  if (def.mountableFaces !== undefined && typeof def.mountableFaces !== 'boolean' && typeof def.mountableFaces !== 'function') throw new Error(`组件 ${type}：mountableFaces 须为布尔或函数`)
  const ssk = def.singleSockets
  if (ssk !== undefined && typeof ssk !== 'function' && !(Array.isArray(ssk) && ssk.every((x) => typeof x === 'string' && x))) throw new Error(`组件 ${type}：singleSockets 须为插座 id 数组或函数`)
  const sp = def.symmetricPlanes
  if (sp !== undefined && typeof sp !== 'function' && !(Array.isArray(sp) && sp.every((p) => PLANES.includes(p)))) throw new Error(`组件 ${type}：symmetricPlanes 非法`)
  const params = {}
  for (const [k, s] of Object.entries(def.params)) params[k] = Object.freeze({ ...s, options: s.options ? Object.freeze(s.options.slice()) : undefined, optionLabels: s.optionLabels ? Object.freeze({ ...s.optionLabels }) : undefined })
  const presets = checkPresets(type, def.presets, { keys: Object.keys(params), params, validate: def.validate })
  if (def.sockets) {
    const dflt = {}
    for (const [k, s] of Object.entries(params)) dflt[k] = s.def
    const socks = def.sockets(dflt), bad = checkSockets(socks), ms = def.mountSocket || 'root'
    if (!bad.length && !socks.some((s) => s.id === ms)) bad.push(`mountSocket ${JSON.stringify(ms)} 不在插座里`)
    if (bad.length) throw new Error(`组件 ${type}：${bad.join('；')}`)
  }
  const out = Object.freeze({
    title: type, titleZh: type, mountSocket: 'root',
    sockets: () => [], faces: () => [],
    ...def,
    params: Object.freeze(params),
    keys: Object.freeze(Object.keys(params)),
    paramsEq: makeValuesEq(Object.keys(params)),
    mirrorPlanes: def.mirrorPlanes ? Object.freeze(def.mirrorPlanes.slice()) : undefined,
    symmetricPlanes: Array.isArray(sp) ? Object.freeze(sp.slice()) : sp,
    singleSockets: Array.isArray(ssk) ? Object.freeze(ssk.slice()) : ssk,
    aliases: Array.isArray(def.aliases) ? Object.freeze(def.aliases.slice()) : undefined,
    presets
  })
  REG.set(type, out)
  return out
}

/**
 * 常用型号表的校验与冻结（d = 冻结中的 {keys, params, validate}）：id 小写连字符且不重复、中英文名非空、别名为字符串数组、
 * 分组合法、参数键都在定义里且补缺省后过 checkParams（含组件自己的约束）。
 */
function checkPresets(type, list, d) {
  if (list === undefined) return undefined
  if (!Array.isArray(list)) throw new Error(`组件 ${type}：presets 须为数组`)
  const ids = new Set()
  return Object.freeze(list.map((p) => {
    const bad = (m) => { throw new Error(`组件 ${type}：型号 ${isObj(p) ? p.id : '?'} ${m}`) }
    if (!isObj(p) || typeof p.id !== 'string' || !PRESET_ID_RE.test(p.id)) bad('id 非法')
    if (ids.has(p.id)) bad('重复')
    ids.add(p.id)
    if (typeof p.titleZh !== 'string' || !p.titleZh || typeof p.title !== 'string' || !p.title) bad('缺 titleZh / title')
    if (p.aliases !== undefined && !(Array.isArray(p.aliases) && p.aliases.every((x) => typeof x === 'string' && x))) bad('aliases 须为字符串数组')
    if (p.category !== undefined && !COMPONENT_CATEGORIES.includes(p.category)) bad(`category 非法（${p.category}）`)
    if (!isObj(p.params)) bad('params 须为对象')
    for (const k of Object.keys(p.params)) if (!d.keys.includes(k)) bad(`参数 ${k} 不在组件定义里`)
    const errs = checkParams(d, fillParams(d, p.params), 'params')
    if (errs.length) bad(errs.join('；'))
    return Object.freeze({
      id: p.id, titleZh: p.titleZh, title: p.title, params: Object.freeze({ ...p.params }),
      ...(p.aliases ? { aliases: Object.freeze(p.aliases.slice()) } : {}), ...(p.category ? { category: p.category } : {})
    })
  }))
}

export const getComponent = (type) => (typeof type === 'string' && REG.get(type)) || null
/** 组件的常用型号（没有 → null） */
export function getPreset(type, id) {
  const d = getComponent(type)
  return (d && Array.isArray(d.presets) && d.presets.find((p) => p.id === id)) || null
}
export function listComponents(domain) {
  const all = [...REG.values()]
  return domain ? all.filter((d) => d.domain.includes(domain)) : all
}
export const componentTypes = () => [...REG.keys()]

/**
 * 补缺省：只留定义里的键；缺（undefined）→ def；null 且不可空 → def；其余原样（非法值留给 checkParams 报）。
 * 不改入参；结果是新对象（参数都是标量，无需深拷贝）。
 */
export function fillParams(def, raw) {
  const out = {}
  const r = isObj(raw) ? raw : {}
  for (const k of def.keys) {
    const s = def.params[k], v = r[k]
    out[k] = v === undefined || (v === null && !s.nullable) ? s.def : v
  }
  return out
}

/** 逐参数查值域 + 组件自己的约束。prefix 拼在每条前面（如 'c3.params'）。 */
export function checkParams(def, params, prefix = 'params') {
  const errors = []
  for (const k of def.keys) {
    const e = checkValue(def.params[k], params[k])
    if (e) errors.push(`${prefix}.${k}：${e}`)
  }
  if (!errors.length && def.validate) for (const e of def.validate(params) || []) errors.push(`${prefix}：${e}`)
  return errors
}

const SAT_ALL = [...SAT_COMPONENTS, ...SAT_ANTENNA_COMPONENTS, ...SAT_UNIT_COMPONENTS, ...SAT_WING_COMPONENTS, ...SAT_BUS_COMPONENTS]
const satRank = (d) => { const i = SAT_ORDER.indexOf(d.type); return i < 0 ? SAT_ORDER.length + SAT_ALL.indexOf(d) : i }
const SAT_SORTED = SAT_ALL.slice().sort((a, b) => satRank(a) - satRank(b))
for (const d of [...PRIM_COMPONENTS, ...SAT_SORTED, ...GROUND_COMPONENTS, ...AIR_COMPONENTS, ...SEA_COMPONENTS, ...VEH_COMPONENTS]) registerComponent(d)
