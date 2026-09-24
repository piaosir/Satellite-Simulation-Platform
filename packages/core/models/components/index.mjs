// 装配组件注册表（三期契约 DESIGN3 E2；装配调研 assembly-ux §3.2）。
//
// 纯 ESM、零 three 依赖、node 可测。装配文档（assembly.mjs）里每个组件的 type 都在这里查定义；
// 各领域的组件定义放在同目录的 <领域>.mjs，模块加载时按下列顺序逐个登记（登记顺序即组件库卡片顺序）：
//   sat.mjs（2 个通用基本体 + 13 个卫星组件）→ ground.mjs（13 个地球站组件）→ air.mjs（8 个飞机组件）→ sea.mjs（6 个船舶组件）
//   → veh.mjs（3 个车辆组件）。非卫星领域共用的造型工具在 shapeKit.mjs（不登记组件，只供各领域文件 import）。
//
// ★ ComponentDef（登记时校验并冻结）：
//   {
//     type        'sat.wing' 一类的点分小写键（注册表主键，存进装配文档，终身不改名）
//     domain      允许出现在哪些领域的装配件里（ASM_DOMAINS 的子集）
//     title / titleZh  组件名（英 / 中；组件库卡片与结构树的缺省显示名）
//     role        部件角色（ir.PART_ROLES；组件库分组、缺省高亮用）
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
//     validate?(p) → string[]：参数间的约束（单参数的范围由 ParamSpec 管）
//   }
//   局部坐标约定（DESIGN3 E2）：原点 = 安装基准点、局部 −Z 贴父面（mount 插座 n = −Z）、局部 +X 为滚转零位。
//   飞机 / 船 / 车 / 地球站（本体 +Z 向下的 FRD / NED 领域）的落法：局部系与领域本体同向，立件 mount 插座 n = +Z（朝下贴父面）、
//   吊挂件 n = −Z、横向对齐件 n = ∓Y（shapeKit latSocket / latMount）；根件单位位姿即本体系，子件滚转 0° 时与父件同向
//   （A3 SPEC §1.1、编排者 2026-09-24 确认 §12-5；按 E2 字面每个立件都会绕 X 转 180°，非对称件左右舷会反）。
//
// ★ ParamSpec：{ kind:'num'|'int'|'bool'|'enum', def, min?, gt?, max?, options?, nullable?, unit?, step?,
//                source:'illustrative'|URL, label, labelEn?, title? }
//   min / max 闭区间，gt 为开下界；options 给 enum / int 的可选值；nullable = null 合法（含义由组件自己定：通常「自动」）。
//   label 是属性面板上的短标签；title 是悬停说明（界面零说明文字：口径只放悬停）。
//
// 导出：
//   ASM_DOMAINS, PARAM_KINDS, PLANES
//   registerComponent(def, {replace?}) → 冻结后的 def；getComponent(type) → def | null
//   listComponents(domain?) → def[]（登记顺序）；componentTypes() → string[]
//   fillParams(def, raw) → 补缺省后的参数（只留定义里的键）；checkParams(def, params, prefix) → string[]
//   socketAccepts(socket, type) → 插座能否接该 type 的组件；makeValuesEq(keys) → 按值比对器（解算缓存用）
//   登记后的 def 另带 keys（参数键列表）与 paramsEq（本组件参数的按值比对器）

import { PART_ROLES } from '../ir.mjs'
import { SAT_COMPONENTS, PRIM_COMPONENTS } from './sat.mjs'
import { GROUND_COMPONENTS } from './ground.mjs'
import { AIR_COMPONENTS } from './air.mjs'
import { SEA_COMPONENTS } from './sea.mjs'
import { VEH_COMPONENTS } from './veh.mjs'

/** 装配件领域（DESIGN3 E5：卫星用本体 +X 速度 +Z 天底；飞机 / 船 / 车 FRD；地球站 NED）。 */
export const ASM_DOMAINS = Object.freeze(['spacecraft', 'ground', 'aircraft', 'ship', 'vehicle'])
export const PARAM_KINDS = Object.freeze(['num', 'int', 'bool', 'enum'])
/** 局部镜面 → 镜面法向所在的局部轴下标（'yz' 翻 x、'xz' 翻 y、'xy' 翻 z）。 */
export const PLANES = Object.freeze(['yz', 'xz', 'xy'])

const TYPE_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isV3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const SOCKET_ID_RE = /^[A-Za-z0-9_+-]+$/

/** 插座 s 能否接 type 组件：accepts 为 null 不限，否则 type 以其中某个前缀开头。 */
export const socketAccepts = (s, type) => !s || s.accepts == null || (typeof type === 'string' && s.accepts.some((p) => type.startsWith(p)))

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
  if (typeof def.build !== 'function') throw new Error(`组件 ${type}：缺 build`)
  if (!isObj(def.params)) throw new Error(`组件 ${type}：params 须为对象`)
  for (const [k, s] of Object.entries(def.params)) checkSpec(type, k, s)
  for (const f of ['sockets', 'faces', 'mirror', 'unitMass', 'validate']) {
    if (def[f] !== undefined && typeof def[f] !== 'function') throw new Error(`组件 ${type}：${f} 须为函数`)
  }
  if (def.mirror && !(Array.isArray(def.mirrorPlanes) && def.mirrorPlanes.length && def.mirrorPlanes.every((p) => PLANES.includes(p)))) throw new Error(`组件 ${type}：有 mirror 钩子须给 mirrorPlanes`)
  const sp = def.symmetricPlanes
  if (sp !== undefined && typeof sp !== 'function' && !(Array.isArray(sp) && sp.every((p) => PLANES.includes(p)))) throw new Error(`组件 ${type}：symmetricPlanes 非法`)
  const params = {}
  for (const [k, s] of Object.entries(def.params)) params[k] = Object.freeze({ ...s, options: s.options ? Object.freeze(s.options.slice()) : undefined })
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
    symmetricPlanes: Array.isArray(sp) ? Object.freeze(sp.slice()) : sp
  })
  REG.set(type, out)
  return out
}

export const getComponent = (type) => (typeof type === 'string' && REG.get(type)) || null
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

for (const d of [...PRIM_COMPONENTS, ...SAT_COMPONENTS, ...GROUND_COMPONENTS, ...AIR_COMPONENTS, ...SEA_COMPONENTS, ...VEH_COMPONENTS]) registerComponent(d)
