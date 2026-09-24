// 装配文档核心（三期契约 DESIGN3 E1–E4、§1 P1；装配调研 assembly-ux §3.1 / §3.5 / §6）。
//
// 纯 ESM、零 three 依赖、node / Worker / 主进程都能跑。装配件 = 「安装语义」文档（存在 meta.spec，spec.kind = 'assembly'），
// 位姿永远由语义解算：父件参数一改（平台体加宽），挂在它面上的子件跟着走。生成出口 buildAssembly 的返回键集合与
// paramBus.buildParamModel 完全相同，导出 / 缩略图 / 工作台 / 3D 球原样复用。
//
// ★ 文档（AssemblySpec，E1）：
//   { kind:'assembly', schema:1, domain:'spacecraft'|'ground'|'aircraft'|'ship'|'vehicle', name,
//     comps:[{ id, type, params, parent, attach:{mode, socket, face, uv, roll, mount}, t?, q?, sym?, name, massKg, material, hidden, locked }],
//     density:{DENSITY 覆盖}, massTargetKg }
//   · id：小写字母开头的字母数字（≤ 24 位，不含下划线——节点名 `${id}_${短名}` 靠第一个下划线切前缀，不会撞名）。
//   · 恰好一个根件（parent = null），根件位姿恒为单位阵 = 本体系原点（卫星：平台体几何中心）。
//   · attach.mode：
//       socket  —— 本件的 mount 插座贴父件插座：M = M_父 · 插座系 · Rz(roll) · (本件 mount 插座系)⁻¹
//       surface —— 贴父件的面，uv = 以面心为原点的面内偏移（米；柱面 uv0 = 沿轴、uv1 = 弧长）：M = M_父 · 面系(uv) · Rz(roll) · mount⁻¹
//       free    —— t / q 直接给（相对父件；可带 socket 或 face+uv 作锚：相对锚点系），roll 不用
//     归一件的 attach 恒为 {mode, socket, face, uv, roll, mount} 同一形状，不适用的键为 null（热路径单态读取，见 normAttach）。
//     插座系 / 面系：z = 朝外法向、x = 滚转零位（插座 up / 面 u）、y = z × x；本件 mount 插座系：z = −n（指向本件内部）。
//   · sym：{group, op:'mirrorXZ'|'mirrorYZ'|'radial', n?:2..8, axis?:'±X'|'±Y'|'±Z'}。只存主件，展开派生件 `${id}~k`；
//     主件的整棵子树跟着复制（子件派生 id `${子id}~k`、父为 `${父id}~k`）；不支持嵌套对称。派生件的节点前缀把 ~ 换成 -（`c3-1_…`）。
//
// ★ 镜像数学（assembly-ux §6 第 5 条；只换位姿 (S·R·S, S·t) 而不翻几何是错的）：
//   世界镜像 S（mirrorXZ = diag(1,−1,1)、mirrorYZ = diag(−1,1,1)，过本体系原点）。取一个局部镜面 S_l，派生件位姿
//   M' = S · M · S_l（真旋转，det = +1），几何按三档之一给出「关于 S_l 的局部镜像」：
//     hook  —— 组件的 mirror 钩子返回镜像参数（太阳翼：关于板宽方向 xz 面镜像 = 绕翼轴转角取反），重生成；
//     plane —— 组件在 S_l 上本来就对称（symmetricPlanes），几何原样复用（偏置反射面关于「母轴 + 偏置方向」面对称）；
//     bake  —— 烘焙：组件局部系里 S_l 作用在节点平移与朝向上，每个节点再取一个保留关节轴的节点局部镜面 S_m，
//              网格顶点 × S_m、法向 × S_m、三角形绕序翻转，节点矩阵 = S_l · R_i · S_m 仍是真旋转——
//              世界系里恰为「顶点乘 S、法向乘 S、绕序翻转」，glTF 不出现负行列式节点。
//   S_l 的挑法：钩子支持的面 → 对称面 → 三个局部面，同档内取法向与世界镜面法向最平行的那个。
//   径向对称：M'_k = Rot(axis, 360°·k/n) · M，几何原样。
//
// ★ IR 结构：根节点（卫星 'satellite'，矩阵 ROOT_MATRIX_BODY2MODEL，frame.q = DEFAULT_Q_MODEL2BODY；其它领域用 Q_YUP_ZENITH）
//   → 每个组件一个节点（名 = 前缀，矩阵 = 本体系位姿，平移已减几何中心）→ 组件的几何节点（`${前缀}_${短名}`，矩阵 = 组件局部）。
//   挂点节点挂在根下（本体系，agi.attachNodeMatrix 口径，与 paramBus 同）。关节 / 太阳翼组 / 部件名一律 `${前缀}_${短名}`，
//   只由组件 id 派生（改显示名不动）。IR 原点 = 几何中心，平移量在 specOriginBody（与 paramBus 同一口径）。
//
// ★ 热路径（编辑器拖动时每帧）：solvePose(doc, out) / combineMass(doc, out) 把解算计划、插座 / 面、组件生成结果缓存在 out 上
//   （不可枚举属性），只要领域、组件的 id / parent / type / sym 与参数值没变就命中缓存；位姿写进 out 里复用的 Float64Array(16)、
//   质量元写进复用的 TypedArray，稳态零分配（优化后新生代字节数不涨；单测按 new_space 实测把关）。
//   写法约束：热路径函数之间不传 / 不返回算出来的双精度数（未内联的调用会把它装箱成 HeapNumber），矩阵一律直接写数组，
//   余弦 / 正弦走模块级 Float64Array，不写模块级 let。参数比对按值（逐个参数键，NaN 视同 NaN），就地改参数对象也不会读到旧缓存。
//   两个函数都收未归一的文档，缺省推断与 normalizeAssembly 同一套（attachModeOf / symAxisOf / 自由件 t、q 缺省）。
//
// 导出：
//   ASM_SCHEMA, ASM_DOMAINS, ATTACH_MODES, SYM_OPS, SYM_AXES, ASM_ID_RE, COMP_ID_RE, NODE_NAME_RE, RESERVED_COMP_IDS, DOMAIN_FRAMES
//   newAsmId(rand?) → 'asm:<12 位十六进制>'（rand：() => [0,1)，注入以便测试确定性；缺省用 crypto）；isAsmId(id)
//   nextCompId(doc) → 'c<n>'；nodePrefix(expandedId) → 节点前缀
//   normalizeAssembly(doc) → 补缺省的深拷贝（幂等；JSON 口径：NaN / ±Infinity 变 null）；validateAssembly(doc) → {ok, errors, missing}
//     （非有限数查原文报，不靠归一件）
//   asmHash(doc) → 16 位十六进制（canon + FNV-1a 64，与 paramBus.specHash 同口径；只作缓存键，不作 id）
//   expandSymmetry(doc) → [{id, src, k, parent, prefix, sym}]（拓扑序：父在子前）
//   solvePose(doc, out?) → Map(id → {id, m:Float64Array(16) 列主序本体系位姿, mode, plane, bad})
//   combineMass(doc, out?) → {massKg, comBody, inertiaBody, count, warnings}（根件坐标系 = spec 原点，未减几何中心；
//     总质量为 0 时 comBody / inertiaBody 全 0，恒为有限数）
//   buildAssembly(doc) → 与 buildParamModel 同形的结果；非法抛 Error（code = 'SPEC_INVALID'，errors / missing）
//   buildComponent(type, params?, {density?}) → 单个组件在局部系的 {params, sockets, faces, ir, attachPoints, massKg, bbox}（编辑器缓存 / ghost 用）
//   componentFacts(type, params?, density?) → {bbox, massKg}（生成缓存轻层，不出 IR；属性面板自动质量用）
//   componentBox(type, params?, density?) → 组件局部包围盒 6 元（同上；对称判据用）
//   componentDensityKeys(type, params?) → 生成时读到的密度表键（同上；属性面板密度节用）
//   clearBuildCache() / buildCacheStats() → 清空 / 读模块级生成缓存（轻层 + 按字节限额的重层）
//   specToAssembly(spec, {warnings?}) → paramBus 整星 spec 转成的等价装配文档（质量逐项对得上）

import { getComponent, fillParams, checkParams, makeValuesEq, ASM_DOMAINS, PLANES } from './components/index.mjs'
import { satSpecToComps } from './components/sat.mjs'
import { canon, fnv1a64Hex, resolveDensity, DENSITY, MATERIALS, nonFiniteReport, validateSpec, normalizeSpec } from './paramBus.mjs'
import { DEFAULT_Q_MODEL2BODY, ROOT_MATRIX_BODY2MODEL, Q_YUP_ZENITH, mat4FromQuatT, quatConj, quatCanonical, defaultUpBody } from './bodyFrame.mjs'
import { attachNodeMatrix } from './agi.mjs'
import { createCtx, MB, worldPositions, meshArea, z0, isNum, isVec3 } from './meshKit.mjs'

// ───────────────────────────── 常量 ─────────────────────────────

export const ASM_SCHEMA = 1
export { ASM_DOMAINS }
export const ATTACH_MODES = Object.freeze(['socket', 'surface', 'free'])
export const SYM_OPS = Object.freeze(['mirrorXZ', 'mirrorYZ', 'radial'])
export const SYM_AXES = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
export const ASM_ID_RE = /^asm:[0-9a-f]{12}$/
export const COMP_ID_RE = /^[a-z][a-z0-9]{0,23}$/
export const NODE_NAME_RE = /^[A-Za-z0-9_+-]+$/

const M_YUP = Object.freeze(mat4FromQuatT(quatConj(Q_YUP_ZENITH)).map(z0))
/** 领域 → 根节点名 / frame.q_model2body / 根节点矩阵（本体 → 模型轴）。卫星沿用出厂 STK 映射；飞机 / 船 / 车 / 地球站用 Q_YUP_ZENITH（E5）。 */
export const DOMAIN_FRAMES = Object.freeze({
  spacecraft: Object.freeze({ root: 'satellite', q: DEFAULT_Q_MODEL2BODY, matrix: ROOT_MATRIX_BODY2MODEL }),
  ground: Object.freeze({ root: 'station', q: Q_YUP_ZENITH, matrix: M_YUP }),
  aircraft: Object.freeze({ root: 'aircraft', q: Q_YUP_ZENITH, matrix: M_YUP }),
  ship: Object.freeze({ root: 'ship', q: Q_YUP_ZENITH, matrix: M_YUP }),
  vehicle: Object.freeze({ root: 'vehicle', q: Q_YUP_ZENITH, matrix: M_YUP })
})
/** 组件 id 不能取根节点名（组件节点名 = id，会与根节点撞名）。 */
export const RESERVED_COMP_IDS = Object.freeze(Object.values(DOMAIN_FRAMES).map((f) => f.root))

const PLANE_AXIS = Object.freeze({ yz: 0, xz: 1, xy: 2 })
const DENS_KEYS = Object.freeze(Object.keys(DENSITY))
const DENS_EQ = makeValuesEq(DENS_KEYS)
const NO_PARAMS = Object.freeze({})
const PLAN = Symbol('asm.plan')
const MASS = Symbol('asm.mass')
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const hidden = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: false, writable: true, configurable: true })
// 热路径里的小判断一律不建闭包、不用变参 Math.hypot（V8 会为它分配）
const quatOk = (q) => Array.isArray(q) && q.length === 4 && isNum(q[0]) && isNum(q[1]) && isNum(q[2]) && isNum(q[3]) && q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3] > 1e-18
const vec3Ok = (v) => Array.isArray(v) && v.length === 3 && isNum(v[0]) && isNum(v[1]) && isNum(v[2])
const row3Ok = (r) => Array.isArray(r) && r.length === 3
/** 缓存比对：=== 之外把 NaN 视同 NaN（否则含 NaN 的非法参数每帧都判缓存失效、每帧重建）。 */
const same = (a, b) => a === b || (a !== a && b !== b)
// 缺省四元数 / 平移：故意不冻结——冻结数组的元素类型是通用标记型，与文档里的双精度数组在同一读取点混用会让优化代码把读出的双精度装箱（只读、从不改写）
const Q_ID = [0, 0, 0, 1], T_0 = [0, 0, 0]

// ───────────────────────────── 缺省推断（normalizeAssembly 与 solvePose / combineMass 共用一套） ─────────────────────────────

/** attach.mode 缺省推断：给了合法 mode 就用；否则有 socket → socket、有 face → surface、都没有 → free。 */
function attachModeOf(a) {
  if (!isObj(a)) return 'free'
  if (ATTACH_MODES.includes(a.mode)) return a.mode
  return typeof a.socket === 'string' ? 'socket' : typeof a.face === 'string' ? 'surface' : 'free'
}
/** 径向对称的缺省轴：飞机绕 +X（机身轴），其它领域绕 +Z。 */
const symAxisDefault = (domain) => (domain === 'aircraft' ? '+X' : '+Z')
/** sym.axis（原值；缺省按领域）。 */
const symAxisOf = (s, domain) => (s.axis === undefined ? symAxisDefault(domain) : s.axis)
/** sym.n（原值；缺省 2）。 */
const symNOf = (s) => (s.n === undefined ? 2 : s.n)
const domainOf = (doc) => (isObj(doc) && ASM_DOMAINS.includes(doc.domain) ? doc.domain : 'spacecraft')

// ───────────────────────────── id ─────────────────────────────

/**
 * 新装配件 id：'asm:<12 位十六进制>'。新建文档时生成、终身不变（E4：不用哈希作 id，编辑不断绑定）。
 * rand：() => [0,1) 的随机源（测试注入得确定结果）；缺省用 crypto.getRandomValues，没有就退回 Math.random。
 */
export function newAsmId(rand) {
  let s = ''
  if (typeof rand === 'function') {
    for (let i = 0; i < 12; i++) { const r = Number(rand()); s += Math.min(15, Math.max(0, Math.floor((Number.isFinite(r) ? r : 0) * 16))).toString(16) }
  } else {
    const b = new Uint8Array(6)
    if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') globalThis.crypto.getRandomValues(b)
    else for (let i = 0; i < 6; i++) b[i] = Math.floor(Math.random() * 256)
    for (const x of b) s += x.toString(16).padStart(2, '0')
  }
  return `asm:${s}`
}
export const isAsmId = (id) => typeof id === 'string' && ASM_ID_RE.test(id)

/** 下一个组件 id：'c' + (现有 c<n> 的最大 n + 1)。 */
export function nextCompId(doc) {
  let mx = 0
  for (const c of (isObj(doc) && Array.isArray(doc.comps) ? doc.comps : [])) {
    const m = c && typeof c.id === 'string' ? /^c(\d+)$/.exec(c.id) : null
    if (m) mx = Math.max(mx, Number(m[1]))
  }
  return `c${mx + 1}`
}
/** 展开后的 id（`c3` / `c3~1`）→ 节点前缀（`c3` / `c3-1`）。 */
export const nodePrefix = (id) => String(id).replace('~', '-')

// ───────────────────────────── 归一 / 校验 / 哈希 ─────────────────────────────

function normSym(s, id, domain) {
  if (!isObj(s)) return null
  const o = { group: typeof s.group === 'string' && s.group ? s.group : id, op: s.op }
  if (s.op === 'radial') { o.n = symNOf(s); o.axis = symAxisOf(s, domain) }
  return o
}
/**
 * 安装语义归一：恒为同一形状 {mode, socket, face, uv, roll, mount}，不适用的键为 null。
 * 形状统一是为热路径：各模式形状不同时 solvePose 读 roll 的点超过 4 种形状（V8 转通用读取），
 * roll 一旦是双精度，每读一次都复制出一个 HeapNumber；同一形状则优化代码直接读出双精度、不分配。
 */
function normAttach(a, isRoot) {
  const o = { mode: 'free', socket: null, face: null, uv: null, roll: 0, mount: null }
  if (isRoot) return o
  const s = isObj(a) ? a : {}
  const mode = attachModeOf(s)
  const uv = (v) => (Array.isArray(v) ? v.slice() : [0, 0])
  o.mode = mode
  if (mode === 'socket') o.socket = typeof s.socket === 'string' ? s.socket : ''
  else if (mode === 'surface') { o.face = typeof s.face === 'string' ? s.face : ''; o.uv = uv(s.uv) } else if (typeof s.socket === 'string' && s.socket) o.socket = s.socket
  else if (typeof s.face === 'string' && s.face) { o.face = s.face; o.uv = uv(s.uv) }
  if (mode !== 'free') { o.roll = s.roll === undefined ? 0 : s.roll; o.mount = typeof s.mount === 'string' && s.mount ? s.mount : null }
  return o
}
function normComp(c0, domain) {
  const c = isObj(c0) ? c0 : {}
  const def = getComponent(c.type)
  const parent = typeof c.parent === 'string' && c.parent ? c.parent : null
  const id = typeof c.id === 'string' ? c.id : ''
  const o = {
    id, type: typeof c.type === 'string' ? c.type : '',
    params: def ? fillParams(def, c.params) : (isObj(c.params) ? c.params : {}),
    parent, attach: normAttach(c.attach, parent === null),
    sym: normSym(c.sym, id, domain),
    name: typeof c.name === 'string' && c.name.trim() ? c.name : null,
    massKg: c.massKg === undefined ? null : c.massKg,
    material: c.material === undefined ? null : c.material,
    hidden: c.hidden === true, locked: c.locked === true
  }
  if (parent !== null && o.attach.mode === 'free') {
    o.t = c.t === undefined ? [0, 0, 0] : (Array.isArray(c.t) ? c.t.slice() : c.t)
    o.q = c.q === undefined ? [0, 0, 0, 1] : (quatOk(c.q) ? quatCanonical(c.q) : c.q)
  }
  return o
}

/**
 * 补缺省后的深拷贝（不改入参；幂等：normalizeAssembly(normalizeAssembly(x)) 与 normalizeAssembly(x) 逐字段相等）。
 * 参数按组件定义补缺省、丢掉定义外的键；非法值原样留着给 validateAssembly 报（与 paramBus.normalizeSpec 同一口径）。
 * 深拷贝走 JSON：NaN / ±Infinity 在这里变成 null（不可空参数随后回缺省、可空参数变「自动」），所以 validateAssembly 对非有限数查原文。
 */
export function normalizeAssembly(doc) {
  const d = isObj(doc) ? JSON.parse(JSON.stringify(doc)) : {}
  const domain = domainOf(d)
  const out = { kind: 'assembly', schema: ASM_SCHEMA, domain, name: typeof d.name === 'string' ? d.name : '', comps: [], density: {}, massTargetKg: null }
  if (Array.isArray(d.comps)) out.comps = d.comps.map((c) => normComp(c, domain))
  if (isObj(d.density)) for (const k of Object.keys(d.density).sort()) out.density[k] = d.density[k]
  if (d.massTargetKg !== undefined && d.massTargetKg !== null) out.massTargetKg = d.massTargetKg
  return out
}

/** 装配件稳定哈希（归一后规范化 JSON 的 FNV-1a 64，16 位十六进制）。只作缓存键（缩略图 / glb 去重），不作 id。 */
export const asmHash = (doc) => fnv1a64Hex(canon(normalizeAssembly(doc)))

const safe = (fn, dflt) => { try { return fn() || dflt } catch { return dflt } }

/**
 * 校验（归一后查；未知参数键、非法 mode 另查原文）。missing = 生成必需但为空（目前只有 'comps'）；errors = 值非法 / 结构错。
 * 文案只写状态本身（CLAUDE.md），会拼进 SPEC_INVALID 的 message 显示到状态栏。
 * @returns {{ok:boolean, errors:string[], missing:string[]}}
 */
export function validateAssembly(doc) {
  const raw = isObj(doc) ? doc : {}
  const d = normalizeAssembly(doc)
  const errors = [], missing = []
  if (raw.kind !== undefined && raw.kind !== 'assembly') errors.push(`kind：须为 assembly（得到 ${JSON.stringify(raw.kind)}）`)
  if (raw.schema !== undefined && raw.schema !== ASM_SCHEMA) errors.push(`schema：不支持 ${JSON.stringify(raw.schema)}`)
  if (raw.domain !== undefined && !ASM_DOMAINS.includes(raw.domain)) errors.push(`domain：未知 ${JSON.stringify(raw.domain)}`)
  if (raw.comps !== undefined && !Array.isArray(raw.comps)) errors.push('comps：须为数组')
  else if (!d.comps.length) missing.push('comps')
  for (const [k, v] of Object.entries(d.density)) {
    if (!Object.hasOwn(DENSITY, k)) errors.push(`density.${k}：未知键`)
    else if (!(isNum(v) && v >= 0)) errors.push(`density.${k}：须为非负数`)
  }
  // 非有限数在归一（JSON）时已变 null，查原文
  const nonFin = (v) => typeof v === 'number' && !Number.isFinite(v)
  if (nonFin(raw.massTargetKg) || (d.massTargetKg !== null && !(isNum(d.massTargetKg) && d.massTargetKg > 0))) errors.push('massTargetKg：须为正数或 null')
  const rawComps = Array.isArray(raw.comps) ? raw.comps : []
  const byId = new Map()
  d.comps.forEach((c, i) => {
    const okId = COMP_ID_RE.test(c.id)
    const p = okId ? c.id : `comps[${i}]`
    if (!okId) errors.push(`comps[${i}].id：须为小写字母开头的字母数字（≤ 24 位）`)
    else if (RESERVED_COMP_IDS.includes(c.id)) errors.push(`${p}.id：${c.id} 是保留名`)
    else if (byId.has(c.id)) errors.push(`${p}.id：重复`)
    else byId.set(c.id, c)
    const rc = isObj(rawComps[i]) ? rawComps[i] : {}
    if (isObj(rc.attach) && rc.attach.mode !== undefined && !ATTACH_MODES.includes(rc.attach.mode)) errors.push(`${p}.attach.mode：须为 socket / surface / free`)
    if (nonFin(rc.massKg) || (c.massKg !== null && !(isNum(c.massKg) && c.massKg > 0))) errors.push(`${p}.massKg：须为正数或 null`)
    if (isObj(rc.params)) for (const k of Object.keys(rc.params)) if (nonFin(rc.params[k])) errors.push(`${p}.params.${k}：须为有限数`)
    if (c.material !== null && !Object.hasOwn(MATERIALS, c.material)) errors.push(`${p}.material：未知材质 ${JSON.stringify(c.material)}`)
    const def = getComponent(c.type)
    if (!def) { errors.push(`${p}.type：未知组件 ${JSON.stringify(c.type)}`); return }
    if (!def.domain.includes(d.domain)) errors.push(`${p}.type：${c.type} 不能用于 ${d.domain}`)
    if (rc.params !== undefined && !isObj(rc.params)) errors.push(`${p}.params：须为对象`)
    else if (isObj(rc.params)) for (const k of Object.keys(rc.params)) if (!Object.hasOwn(def.params, k)) errors.push(`${p}.params.${k}：未知参数`)
    errors.push(...checkParams(def, c.params, `${p}.params`))
  })
  const roots = d.comps.filter((c) => c.parent === null)
  if (d.comps.length && !roots.length) errors.push('没有根件')
  if (roots.length > 1) errors.push(`根件多于一个：${roots.map((c) => c.id).join('、')}`)
  const n = d.comps.length
  for (const c of d.comps) {
    if (c.parent === null || !byId.has(c.id) || byId.get(c.id) !== c) continue
    const p = c.id
    if (!byId.has(c.parent)) { errors.push(`${p}.parent：找不到 ${c.parent}`); continue }
    let cur = c.parent, steps = 0
    while (cur !== null && cur !== c.id && byId.has(cur) && steps <= n) { cur = byId.get(cur).parent; steps++ }
    if (cur === c.id || steps > n) { errors.push(`${p}.parent：父子关系成环`); continue }
    const def = getComponent(c.type), pc = byId.get(c.parent), pdef = getComponent(pc.type)
    if (!def || !pdef) continue
    const a = c.attach
    const psock = safe(() => pdef.sockets(pc.params), []), pface = safe(() => pdef.faces(pc.params), []), csock = safe(() => def.sockets(c.params), [])
    if (a.socket !== null && !psock.some((s) => s.id === a.socket)) errors.push(`${p}.attach.socket：父件 ${c.parent} 没有插座 ${JSON.stringify(a.socket)}`)
    if (a.face !== null && !pface.some((f) => f.id === a.face)) errors.push(`${p}.attach.face：父件 ${c.parent} 没有面 ${JSON.stringify(a.face)}`)
    if (a.uv !== null && !(Array.isArray(a.uv) && a.uv.length === 2 && a.uv.every(isNum))) errors.push(`${p}.attach.uv：须为 [u, v]`)
    if (a.mode !== 'free') {
      if (!isNum(a.roll)) errors.push(`${p}.attach.roll：须为有限数`)
      const m = a.mount || def.mountSocket
      if (!csock.some((s) => s.id === m)) errors.push(`${p}.attach.mount：本件没有插座 ${JSON.stringify(m)}`)
    } else {
      if (!isVec3(c.t)) errors.push(`${p}.t：须为 [x,y,z]`)
      if (!quatOk(c.q)) errors.push(`${p}.q：须为非零四元数 [x,y,z,w]`)
    }
  }
  for (const c of d.comps) {
    if (!c.sym) continue
    const p = COMP_ID_RE.test(c.id) ? c.id : 'comps'
    if (c.parent === null) { errors.push(`${p}.sym：根件不能对称`); continue }
    if (!SYM_OPS.includes(c.sym.op)) { errors.push(`${p}.sym.op：须为 mirrorXZ / mirrorYZ / radial`); continue }
    if (c.sym.op === 'radial') {
      if (!(Number.isInteger(c.sym.n) && c.sym.n >= 2 && c.sym.n <= 8)) errors.push(`${p}.sym.n：须为 2–8 的整数`)
      if (!SYM_AXES.includes(c.sym.axis)) errors.push(`${p}.sym.axis：须为 ±X / ±Y / ±Z`)
    }
    let cur = c.parent, steps = 0
    while (cur !== null && byId.has(cur) && steps++ <= n) {
      const pc = byId.get(cur)
      if (pc.sym) { errors.push(`${p}.sym：祖先 ${cur} 已对称（不支持嵌套对称）`); break }
      cur = pc.parent
    }
  }
  return { ok: errors.length === 0 && missing.length === 0, errors, missing }
}

// ───────────────────────────── 4×4（列主序 Float64Array，写进调用方给的数组） ─────────────────────────────

const S0 = new Float64Array(16), S1 = new Float64Array(16), S2 = new Float64Array(16), S3 = new Float64Array(16)
function ident(o) { o.fill(0); o[0] = o[5] = o[10] = o[15] = 1; return o }
function copy16(o, a) { for (let i = 0; i < 16; i++) o[i] = a[i]; return o }
/** o = a · b（o 不得与 a / b 同一数组）。 */
function mul(o, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[4 * c], b1 = b[4 * c + 1], b2 = b[4 * c + 2], b3 = b[4 * c + 3]
    o[4 * c] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    o[4 * c + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    o[4 * c + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    o[4 * c + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return o
}
// 以下矩阵构造全部直接写数组元素、只收数组 / 对象 / Smi 实参：TurboFan 的内联预算一满（solvePrimary 内联的东西多），
// 没被内联的调用会把算出来的双精度实参装箱成 HeapNumber——setCols(12 个双精度) 一类每帧几百字节。角度也不以实参传（见 CS）。
/** 尾行 [0,0,0,1]（列主序第 3 / 7 / 11 / 15 元）。 */
function affineTail(o) { o[3] = 0; o[7] = 0; o[11] = 0; o[15] = 1 }
/** 刚体逆（o 不得与 a 同一数组）。 */
function invRigid(o, a) {
  o[0] = a[0]; o[1] = a[4]; o[2] = a[8]
  o[4] = a[1]; o[5] = a[5]; o[6] = a[9]
  o[8] = a[2]; o[9] = a[6]; o[10] = a[10]
  o[12] = -(o[0] * a[12] + o[4] * a[13] + o[8] * a[14])
  o[13] = -(o[1] * a[12] + o[5] * a[13] + o[9] * a[14])
  o[14] = -(o[2] * a[12] + o[6] * a[13] + o[10] * a[14])
  affineTail(o)
  return o
}
// 转角走模块级 Float64Array 传递：CS[2] = 角度（度，调用方写），rotAxis 读它、把余弦 / 正弦写回 CS[0] / CS[1]
// （写模块级 let、或把双精度当实参传给没内联的函数，都会装箱）。90° 的整数倍取精确值（0°/180° 翻面零误差，镜像 / 径向 2 与整星逐位相同）。
const CS = new Float64Array(3)
/** 绕 ±X / ±Y / ±Z 转 CS[2] 度（过原点）。 */
function rotAxis(o, axis) {
  const deg = CS[2], r = ((deg % 360) + 360) % 360
  if (r === 0) { CS[0] = 1; CS[1] = 0 } else if (r === 90) { CS[0] = 0; CS[1] = 1 } else if (r === 180) { CS[0] = -1; CS[1] = 0 } else if (r === 270) { CS[0] = 0; CS[1] = -1 } else { const t = deg * Math.PI / 180; CS[0] = Math.cos(t); CS[1] = Math.sin(t) }
  const c = CS[0], s = axis[0] === '-' ? -CS[1] : CS[1]
  o.fill(0); o[15] = 1
  if (axis[1] === 'X') { o[0] = 1; o[5] = c; o[6] = s; o[9] = -s; o[10] = c } else if (axis[1] === 'Y') { o[0] = c; o[2] = -s; o[5] = 1; o[8] = s; o[10] = c } else { o[0] = c; o[1] = s; o[4] = -s; o[5] = c; o[10] = 1 }
  return o
}
/** 绕 +Z 转 attach.roll 度（非有限数按 0；在这里读 roll，不以实参传角度）。 */
function rotRoll(o, a) {
  const r = a.roll
  CS[2] = isNum(r) ? r : 0
  return rotAxis(o, '+Z')
}
/** 四元数 [x,y,z,w]（先归一）+ 平移 → o。 */
function fromQT(o, q, t) {
  const n = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]), x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n
  o[0] = 1 - 2 * (y * y + z * z); o[1] = 2 * (x * y + w * z); o[2] = 2 * (x * z - w * y)
  o[4] = 2 * (x * y - w * z); o[5] = 1 - 2 * (x * x + z * z); o[6] = 2 * (y * z + w * x)
  o[8] = 2 * (x * z + w * y); o[9] = 2 * (y * z - w * x); o[10] = 1 - 2 * (x * x + y * y)
  o[12] = t[0]; o[13] = t[1]; o[14] = t[2]
  affineTail(o)
  return o
}
/** 以 z = sz·n、x = up 去掉 z 分量（退化取 X / Y）建系，原点 p。 */
function frameZX(o, p, n, up, sz) {
  let zx = n[0] * sz, zy = n[1] * sz, zz = n[2] * sz
  const zl = Math.sqrt(zx * zx + zy * zy + zz * zz)
  if (!(zl > 0)) return false
  zx /= zl; zy /= zl; zz /= zl
  let k = up[0] * zx + up[1] * zy + up[2] * zz
  let xx = up[0] - k * zx, xy = up[1] - k * zy, xz = up[2] - k * zz, xl = Math.sqrt(xx * xx + xy * xy + xz * xz)
  if (!(xl > 1e-9)) {
    const ax = Math.abs(zx) < 0.9 ? 1 : 0, ay = 1 - ax
    k = ax * zx + ay * zy; xx = ax - k * zx; xy = ay - k * zy; xz = -k * zz; xl = Math.sqrt(xx * xx + xy * xy + xz * xz)
  }
  xx /= xl; xy /= xl; xz /= xl
  o[0] = xx; o[1] = xy; o[2] = xz
  o[4] = zy * xz - zz * xy; o[5] = zz * xx - zx * xz; o[6] = zx * xy - zy * xx
  o[8] = zx; o[9] = zy; o[10] = zz
  o[12] = p[0]; o[13] = p[1]; o[14] = p[2]
  affineTail(o)
  return true
}
/** 面系（面内坐标 uv）：平面 z = n、x = u、y = v；柱面 z = 径向、x = 轴、y = z × x（uv1 沿 +y 走）。 */
function faceFrameAt(o, f, uv) {
  const u0 = uv && isNum(uv[0]) ? uv[0] : 0, u1 = uv && isNum(uv[1]) ? uv[1] : 0
  const g = f.origin
  if (f.kind === 'cyl') {
    const a = f.axis, rf = f.ref, r = f.radius, ph = -u1 / r, c = Math.cos(ph), s = Math.sin(ph)
    const wx = a[1] * rf[2] - a[2] * rf[1], wy = a[2] * rf[0] - a[0] * rf[2], wz = a[0] * rf[1] - a[1] * rf[0]
    const rx = c * rf[0] + s * wx, ry = c * rf[1] + s * wy, rz = c * rf[2] + s * wz
    o[0] = a[0]; o[1] = a[1]; o[2] = a[2]
    o[4] = ry * a[2] - rz * a[1]; o[5] = rz * a[0] - rx * a[2]; o[6] = rx * a[1] - ry * a[0]
    o[8] = rx; o[9] = ry; o[10] = rz
    o[12] = g[0] + a[0] * u0 + rx * r; o[13] = g[1] + a[1] * u0 + ry * r; o[14] = g[2] + a[2] * u0 + rz * r
  } else {
    const u = f.u, v = f.v, n = f.n
    o[0] = u[0]; o[1] = u[1]; o[2] = u[2]
    o[4] = v[0]; o[5] = v[1]; o[6] = v[2]
    o[8] = n[0]; o[9] = n[1]; o[10] = n[2]
    o[12] = g[0] + u[0] * u0 + v[0] * u1; o[13] = g[1] + u[1] * u0 + v[1] * u1; o[14] = g[2] + u[2] * u0 + v[2] * u1
  }
  affineTail(o)
  return o
}
function findId(list, id) { for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null }

// ───────────────────────────── 解算计划（展开对称 + 拓扑序） ─────────────────────────────

const EMPTY_GEO = Object.freeze({ vals: [], params: {}, sockets: [], faces: [], symPlanes: [] })

function buildPlan(doc) {
  const comps = isObj(doc) && Array.isArray(doc.comps) ? doc.comps : []
  const n = comps.length, domain = domainOf(doc)
  const plan = { n, domain, ids: [], parents: [], types: [], symOps: [], symNs: [], symAxes: [], srcs: comps.slice(), entries: [], byId: new Map() }
  const idx = new Map()
  comps.forEach((c0, i) => {
    const c = isObj(c0) ? c0 : {}, s = isObj(c.sym) ? c.sym : null
    plan.ids.push(c.id); plan.parents.push(typeof c.parent === 'string' && c.parent ? c.parent : null); plan.types.push(c.type)
    plan.symOps.push(s ? s.op : null); plan.symNs.push(s ? s.n : undefined); plan.symAxes.push(s ? s.axis : undefined)
    if (typeof c.id === 'string' && !idx.has(c.id)) idx.set(c.id, i)
  })
  let root = -1
  for (let i = 0; i < n; i++) if (plan.parents[i] === null && idx.get(plan.ids[i]) === i) { root = i; break }
  const kids = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    const p = plan.parents[i]
    if (p !== null && idx.get(plan.ids[i]) === i && idx.has(p) && idx.get(p) !== i) kids[idx.get(p)].push(i)
  }
  const order = [], seen = new Uint8Array(n), stack = root >= 0 ? [root] : []
  while (stack.length) {
    const i = stack.pop()
    if (seen[i]) continue
    seen[i] = 1; order.push(i)
    for (let j = kids[i].length - 1; j >= 0; j--) stack.push(kids[i][j])
  }
  const symOf = new Array(n).fill(null)
  for (const i of order) {
    const s = isObj(comps[i].sym) ? comps[i].sym : null, p = plan.parents[i]
    const inh = p !== null ? symOf[idx.get(p)] : null
    if (inh) symOf[i] = { ...inh, own: false }   // 子树跟着主件复制（嵌套对称以祖先为准，validate 另报）
    else if (s && p !== null && SYM_OPS.includes(s.op)) {
      // 缺省与 normSym 同一套；非法 n / axis（validate 另报）按缺省摆
      const radial = s.op === 'radial', sn = symNOf(s), sa = symAxisOf(s, domain)
      symOf[i] = { op: s.op, n: radial ? (Number.isInteger(sn) && sn >= 2 && sn <= 8 ? sn : 2) : 2, axis: radial && SYM_AXES.includes(sa) ? sa : symAxisDefault(domain), own: true }
    }
  }
  for (const i of order) {
    const c = comps[i], sy = symOf[i], cnt = sy ? sy.n : 1, p = plan.parents[i], k0 = plan.entries.length
    for (let k = 0; k < cnt; k++) {
      const id = k === 0 ? c.id : `${c.id}~${k}`
      const parentId = p === null ? null : (k === 0 || sy.own ? p : `${p}~${k}`)
      plan.entries.push({ id, k, ci: i, def: getComponent(c.type), parentId, parentIdx: -1, primaryIdx: k0, sym: k ? sy : null, prefix: nodePrefix(id), pose: null, geo: null, base: null, bc: null })
      plan.byId.set(id, plan.entries.length - 1)
    }
  }
  for (const e of plan.entries) e.parentIdx = e.parentId === null ? -1 : (plan.byId.has(e.parentId) ? plan.byId.get(e.parentId) : -1)
  return plan
}

/** 计划是否还适用（按值比领域与逐组件的 id / parent / type / sym），适用就顺手刷新组件对象引用（不新建对象）。 */
function planOk(plan, doc, comps) {
  if (!Array.isArray(comps) || plan.n !== comps.length || plan.domain !== domainOf(doc)) return false
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]
    if (!isObj(c) || c.id !== plan.ids[i] || (typeof c.parent === 'string' && c.parent ? c.parent : null) !== plan.parents[i] || c.type !== plan.types[i]) return false
    const s = isObj(c.sym) ? c.sym : null
    if (!same(s ? s.op : null, plan.symOps[i]) || !same(s ? s.n : undefined, plan.symNs[i]) || !same(s ? s.axis : undefined, plan.symAxes[i])) return false
  }
  for (let i = 0; i < comps.length; i++) plan.srcs[i] = comps[i]
  return true
}
function getPlan(doc, holder) {
  const comps = isObj(doc) && Array.isArray(doc.comps) ? doc.comps : []
  const old = holder[PLAN]
  if (old && planOk(old, doc, comps)) return old
  const plan = buildPlan(doc)
  if (old) adoptCaches(plan, old)
  hidden(holder, PLAN, plan)
  return plan
}
/**
 * 拓扑变了（换父 / 加删件 / 撤销重做）整份重建计划时，按「id + 组件定义相同」把旧条目的插座面缓存（geo）、生成缓存（base）、
 * 派生件缓存（bc）过继给新条目：geoOf / baseBuild 用参数值与密度复核、builtFor 复核 base 身份与 plane / mode，过继不会用错；
 * 于是换父件、加一件时只有真正变了的件重跑生成（整星不再每次重跑三十来件）。
 */
function adoptCaches(plan, old) {
  const E = plan.entries, O = old.entries
  for (let i = 0; i < E.length; i++) {
    const e = E[i], j = old.byId.get(e.id)
    if (j === undefined) continue
    const o = O[j]
    if (o.def !== e.def || o.k !== e.k) continue
    e.geo = o.geo; e.base = o.base; e.bc = o.bc
  }
}

// 热路径函数里不写闭包：被闭包捕获的局部变量会让 V8 在每次调用入口分配 Context（命中缓存也照样分配），
// 缓存失效时才走的慢路径一律拆成单独函数（makeGeo / rebuildBase；参数原值快照统一走 snapValues）。

/** 参数原值快照（缓存比对用）。 */
function snapValues(keys, raw) { const v = new Array(keys.length); for (let j = 0; j < keys.length; j++) v[j] = raw[keys[j]]; return v }

function makeGeo(def, raw) {
  const params = fillParams(def, raw)
  return { vals: snapValues(def.keys, raw), params, sockets: safe(() => def.sockets(params), []), faces: safe(() => def.faces(params), []), symPlanes: safe(() => (typeof def.symmetricPlanes === 'function' ? def.symmetricPlanes(params) : def.symmetricPlanes), []) }
}
/** 组件的插座 / 面 / 对称面（按参数值缓存在条目上）。 */
function geoOf(plan, e) {
  const def = e.def
  if (!def) return EMPTY_GEO
  const c = plan.srcs[e.ci], raw = isObj(c.params) ? c.params : NO_PARAMS, g = e.geo
  if (g && def.paramsEq(raw, g.vals)) return g
  return (e.geo = makeGeo(def, raw))
}

// ───────────────────────────── 位姿解算 ─────────────────────────────

function solvePrimary(plan, e, p) {
  const c = plan.srcs[e.ci], a = isObj(c.attach) ? c.attach : NO_PARAMS
  p.plane = null
  if (e.parentIdx < 0) { ident(p.m); p.mode = 'root'; return }
  const pe = plan.entries[e.parentIdx], pg = geoOf(plan, pe)
  const mode = attachModeOf(a)
  p.mode = mode
  // 锚点 / 安装系（父件局部）→ S0
  if (typeof a.socket === 'string' && a.socket && (mode !== 'surface')) {
    const s = findId(pg.sockets, a.socket)
    if (!s || !frameZX(S0, s.pos, s.n, s.up, 1)) { p.bad = 'socket'; ident(S0) }
  } else if (typeof a.face === 'string' && a.face && mode !== 'socket') {
    const f = findId(pg.faces, a.face)
    if (f) faceFrameAt(S0, f, a.uv); else { p.bad = 'face'; ident(S0) }
  } else if (mode !== 'free') { p.bad = mode === 'socket' ? 'socket' : 'face'; ident(S0) } else ident(S0)
  if (mode === 'free') {
    // t / q 缺省与 normComp 同（原点、单位四元数）；给了但非法才算解算失败
    const q = c.q === undefined ? Q_ID : quatOk(c.q) ? c.q : null, t = c.t === undefined ? T_0 : vec3Ok(c.t) ? c.t : null
    if (!q || !t) { p.bad = 'free'; ident(S1) } else fromQT(S1, q, t)
    mul(S2, S0, S1)
  } else {
    mul(S1, S0, rotRoll(S2, a))
    const g = geoOf(plan, e), mid = typeof a.mount === 'string' && a.mount ? a.mount : (e.def ? e.def.mountSocket : 'root')
    const ms = findId(g.sockets, mid)
    if (!ms || !frameZX(S3, ms.pos, ms.n, ms.up, -1)) { p.bad = 'mount'; ident(S3) }
    mul(S2, S1, invRigid(S0, S3))
  }
  mul(p.m, pe.pose.m, S2)
}

/** 同档内挑法向与世界镜面法向（本体轴 na）最平行的局部面。 */
function bestPlane(M, na, list) {
  let best = null, bs = -1
  for (let i = 0; i < list.length; i++) {
    const j = PLANE_AXIS[list[i]]
    if (j === undefined) continue
    const sc = Math.abs(M[na + 4 * j])
    if (sc > bs + 1e-12) { bs = sc; best = list[i] }
  }
  return best
}

function solveDerived(plan, e, p) {
  const pe = plan.entries[e.primaryIdx], M = pe.pose.m, sy = e.sym
  if (sy.op === 'radial') { CS[2] = (360 * e.k) / sy.n; mul(p.m, rotAxis(S0, sy.axis), M); p.mode = 'radial'; p.plane = null; return }
  const na = sy.op === 'mirrorXZ' ? 1 : 0
  const def = e.def, g = geoOf(plan, pe)
  let mode = 'bake', pl = null
  if (def && def.mirror) { pl = bestPlane(M, na, def.mirrorPlanes); mode = 'hook' }
  if (!pl && g.symPlanes.length) { pl = bestPlane(M, na, g.symPlanes); mode = 'plane' }
  if (!pl) { pl = bestPlane(M, na, PLANES); mode = 'bake' }
  // M' = S · M · S_l：S 取反第 na 行（含平移），S_l 取反第 ax 列
  copy16(p.m, M)
  for (let j = 0; j < 4; j++) p.m[na + 4 * j] = -p.m[na + 4 * j]
  const ax = PLANE_AXIS[pl]
  for (let r = 0; r < 3; r++) p.m[r + 4 * ax] = -p.m[r + 4 * ax]
  for (let i = 0; i < 16; i++) if (p.m[i] === 0) p.m[i] = 0   // 抹 −0
  p.mode = mode; p.plane = pl
}

/**
 * 全部组件（含对称派生件）的本体系位姿。out 传同一个 Map 反复调用时复用条目、数组与缓存（拖动热路径不新建对象）；
 * 文档里已删掉的 id 会从 out 里删掉。结构错误不抛（validateAssembly 负责报）：找不到插座 / 面 / mount 的条目 bad 非空，按单位阵摆。
 * @returns {Map<string, {id:string, m:Float64Array, mode:string, plane:string|null, bad:string|null}>}
 */
export function solvePose(doc, out) {
  const res = out instanceof Map ? out : new Map()
  const plan = getPlan(doc, res)
  const E = plan.entries
  for (let i = 0; i < E.length; i++) {
    const e = E[i]
    let p = res.get(e.id)
    if (!p) { p = { id: e.id, m: new Float64Array(16), mode: 'root', plane: null, bad: null }; res.set(e.id, p) }
    e.pose = p
    p.bad = null
    if (e.k === 0) solvePrimary(plan, e, p)
    else solveDerived(plan, e, p)
  }
  if (res.size !== E.length) for (const k of [...res.keys()]) if (!plan.byId.has(k)) res.delete(k)
  return res
}

/** 对称展开（拓扑序：父在子前；主件后紧跟它的派生件）。 */
export function expandSymmetry(doc) {
  const plan = buildPlan(doc)
  return plan.entries.map((e) => ({ id: e.id, src: plan.ids[e.ci], k: e.k, parent: e.parentId, prefix: e.prefix, sym: e.sym ? { op: e.sym.op, n: e.sym.n, axis: e.sym.op === 'radial' ? e.sym.axis : null } : null }))
}

// ───────────────────────────── 组件生成（局部系）与缓存 ─────────────────────────────

const kitFor = (dens) => ({ dens, createCtx: (extra) => createCtx({ ...(extra || {}), dens }) })

/** 跑组件 build 并整理：名字查验、每个网格节点的局部坐标、局部包围盒、质量合计。 */
function runBuild(def, params, dens) {
  // 顺手记下生成时读了密度表的哪些键（属性面板「密度」节只列用得着的键：不必为此另跑一遍生成）
  const used = new Set()
  const rec = new Proxy(dens, { get(t, k) { if (typeof k === 'string') used.add(k); return t[k] } })
  const ctx = def.build(params, kitFor(rec))
  const bad = (n) => { throw new Error(`组件 ${def.type} 内部名「${n}」只能含 [A-Za-z0-9_+-]`) }
  const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const items = ctx.items.map((it) => {
    if (!NODE_NAME_RE.test(it.name)) bad(it.name)
    const o = { name: it.name, role: it.role, partId: it.part ? it.part.id : null, mat: it.mat, mb: it.mb, R: it.R, t: it.t, P: null }
    if (it.mb && it.mb.tcount) {
      o.P = worldPositions(it.mb, it.R, it.t)
      for (let i = 0; i < o.P.length; i += 3) for (let k = 0; k < 3; k++) { const v = o.P[i + k]; if (v < bb[k]) bb[k] = v; if (v > bb[k + 3]) bb[k + 3] = v }
    }
    return o
  })
  for (const a of ctx.aps) if (!NODE_NAME_RE.test(a.name)) bad(a.name)
  let massKg = 0
  for (const q of ctx.comps) massKg += q.massKg
  return {
    params, items, comps: ctx.comps, parts: [...ctx.parts.values()], aps: ctx.aps, arts: ctx.arts, spg: ctx.spg,
    warnings: ctx.warnings, bbox: bb, massKg, unit: null, densKeys: DENS_KEYS.filter((k) => used.has(k))
  }
}

/**
 * 烘焙镜像（局部镜面 plane）：节点平移 / 朝向左乘 S_l，网格顶点与法向乘节点局部镜面 S_m（保留关节轴：zRotate 节点翻 x，
 * 其余翻 z），三角形绕序翻转；节点矩阵 S_l·R·S_m 为真旋转。质量元 / 挂点 / 部件法向与拟合几何左乘 S_l。
 */
function bakeBuilt(b, plane) {
  const ax = PLANE_AXIS[plane]
  const Sv = (v) => { const o = v.slice(); o[ax] = -o[ax]; return o }
  const zAxisNodes = new Set()
  for (const a of b.arts) for (const st of a.stages) if (st.type === 'zRotate') for (const nd of a.nodes) zAxisNodes.add(nd)
  const bb = b.bbox.slice()
  bb[ax] = -b.bbox[ax + 3]; bb[ax + 3] = -b.bbox[ax]
  // 轻结果（items = null，只做质量 / 包围盒）：只翻质量元、部件、挂点与包围盒
  const items = !b.items ? null : b.items.map((it) => {
    const m = zAxisNodes.has(it.name) ? 0 : 2
    const R = it.R.map((col, j) => { const v = Sv(col); return j === m ? v.map((x) => -x) : v })
    const o = { ...it, R, t: Sv(it.t), mb: it.mb, P: null }
    if (it.mb && it.mb.tcount) {
      const src = it.mb, mb = new MB()
      mb.p = src.p.slice(); mb.n = src.n.slice(); mb.uv = src.uv.slice(); mb.idx = src.idx.slice()
      for (let i = m; i < mb.p.length; i += 3) { mb.p[i] = -mb.p[i]; mb.n[i] = -mb.n[i] }
      for (let i = 0; i < mb.idx.length; i += 3) { const t = mb.idx[i + 1]; mb.idx[i + 1] = mb.idx[i + 2]; mb.idx[i + 2] = t }
      o.mb = mb
      o.P = worldPositions(mb, R, o.t)
    }
    return o
  })
  const sI = (I) => I.map((v, i) => ((Math.floor(i / 3) === ax) !== (i % 3 === ax) ? -v : v))
  return {
    params: b.params, items,
    comps: b.comps.map((q) => ({ ...q, com: Sv(q.com), I: sI(q.I) })),
    parts: b.parts.map((p) => ({ ...p, nodes: p.nodes.slice(), ...(p.normalBody ? { normalBody: Sv(p.normalBody) } : {}), ...(p.fitted ? { fitted: { ...p.fitted, vertexBody: Sv(p.fitted.vertexBody), axisBody: Sv(p.fitted.axisBody), focusBody: Sv(p.fitted.focusBody) } } : {}) })),
    aps: b.aps.map((a) => ({ ...a, posBody: Sv(a.posBody), dirBody: Sv(a.dirBody), upBody: a.upBody ? Sv(a.upBody) : null })),
    arts: b.arts, spg: b.spg, warnings: b.warnings, bbox: bb, massKg: b.massKg, unit: null, densKeys: b.densKeys, bakePlane: plane
  }
}

// 模块级生成缓存：键 = type | 参数值（fillParams 后按 def.keys）| 密度表取值。计划过继（adoptCaches）管同一个 holder；
// 这一层管新文档 / 新 out（拾起时的静态 / 移动子树文档、拖入件的单件文档、属性面板的自动质量）——同一组件同一参数只生成一次。
// 结果只读（buildAssembly / collectMass / buildComponent 都只读它；b.unit 是按参数确定的惰性派生量）。分两层：
//   轻层（≤ 512 条）：params / comps / parts / aps / arts / spg / warnings / bbox / massKg —— 质量合成（编辑器每帧读数、计划过继）
//     与包围盒判据只用这些，items = null；主线程常驻也就几 MB。
//   重层（按估算字节数：有 document 的主线程 ≤ 12 MB，Worker / node ≤ 96 MB）：完整结果（再加 items：网格数组 mb 与局部坐标 P）——
//     只有出 IR（buildAssembly / buildComponent）要。网格数组是 push 出来的 JS 数组（容量有富余、住在 JS 堆里），整星几十件就是
//     几十 MB：主线程只留一小撮，反复导出的 Worker 里多留。clearBuildCache() 两层一起清（编辑器 dispose / 离开装配页）。
const LIGHT_LRU_CAP = 512
const HEAVY_LRU_BYTES = (typeof document !== 'undefined' ? 12 : 96) * 1048576
const lightLru = new Map(), heavyLru = new Map()
let heavyBytes = 0
const densKeys = new WeakMap()
function densKeyOf(dens) {
  let k = densKeys.get(dens)
  if (k === undefined) { k = DENS_KEYS.map((x) => dens[x]).join(','); densKeys.set(dens, k) }
  return k
}
/** 完整生成结果的 JS 堆占用估算（字节）：网格数组元素 × 8 字节 × 1.25（push 出来的数组容量有富余）。 */
function builtBytes(b) {
  let n = 0
  for (const it of b.items) { if (it.mb) n += it.mb.p.length + it.mb.n.length + it.mb.uv.length + it.mb.idx.length; if (it.P) n += it.P.length }
  return n * 10
}
const lightOf = (b) => ({ params: b.params, items: null, comps: b.comps, parts: b.parts, aps: b.aps, arts: b.arts, spg: b.spg, warnings: b.warnings, bbox: b.bbox, massKg: b.massKg, unit: null, densKeys: b.densKeys })
function touch(m, k, v) { m.delete(k); m.set(k, v) }
function putLight(key, l) {
  lightLru.set(key, l)
  while (lightLru.size > LIGHT_LRU_CAP) lightLru.delete(lightLru.keys().next().value)
}
function putHeavy(key, b) {
  const bytes = builtBytes(b)
  if (bytes > HEAVY_LRU_BYTES / 3) return
  heavyLru.set(key, { b, bytes }); heavyBytes += bytes
  while (heavyBytes > HEAVY_LRU_BYTES && heavyLru.size) {
    const k0 = heavyLru.keys().next().value
    heavyBytes -= heavyLru.get(k0).bytes
    heavyLru.delete(k0)
  }
}
/**
 * 取组件生成结果：full = true 要完整结果（含 items，出 IR 用）；否则给轻结果（items = null；已有完整结果的也可能直接给完整的，
 * 调用方只当它是轻的读）。
 */
function cachedBuild(def, params, dens, full) {
  const key = def.type + '|' + JSON.stringify(snapValues(def.keys, params)) + '|' + densKeyOf(dens)
  const h = heavyLru.get(key)
  if (h) {
    touch(heavyLru, key, h)
    if (full) return h.b
    let l = lightLru.get(key)
    if (l) touch(lightLru, key, l); else { l = lightOf(h.b); putLight(key, l) }
    return l
  }
  if (!full) { const l = lightLru.get(key); if (l) { touch(lightLru, key, l); return l } }
  const b = runBuild(def, params, dens)
  putHeavy(key, b)
  let l = lightLru.get(key)
  if (!l) { l = lightOf(b); putLight(key, l) }
  return full ? b : l
}
/**
 * 清空模块级生成缓存。缺省两层一起清（编辑器 dispose / 离开装配页）；o.heavyOnly = 只清重层（编辑器换文档：上一份文档的网格数组
 * 已经进了编辑器自己的几何缓存，这里不必再留一份；轻层留着给质量合成 / 计划过继）。
 */
export function clearBuildCache(o) {
  if (!(o && o.heavyOnly)) lightLru.clear()
  heavyLru.clear(); heavyBytes = 0
}
/** 生成缓存规模（验证台 / 单测读数）。 */
export function buildCacheStats() { return { light: lightLru.size, heavy: heavyLru.size, heavyBytes, heavyCap: HEAVY_LRU_BYTES } }
/**
 * 组件局部的几个小量：{bbox:6 元 [minx,miny,minz,maxx,maxy,maxz]（没有几何 null）, massKg}——走生成缓存的轻层，不出 IR
 * （buildComponent 每次都把网格拷成类型数组，属性面板的「自动质量」、对称判据用不着）。未知组件 / 参数非法 / 生成失败 null。
 */
export function componentFacts(type, params, density) {
  const def = getComponent(type)
  if (!def) return null
  const p = fillParams(def, params)
  if (checkParams(def, p).length) return null
  try {
    const b = cachedBuild(def, p, resolveDensity(density), false)
    return { bbox: Number.isFinite(b.bbox[0]) ? b.bbox.slice() : null, massKg: b.massKg }
  } catch { return null }
}
/**
 * 组件按参数生成时实际读了密度表的哪些键（DENSITY 键序；未知组件 / 参数非法 / 生成失败 []）。走生成缓存的轻层：
 * 编辑器里已生成过的件直接命中，不另跑生成。属性面板「密度」节用。
 */
export function componentDensityKeys(type, params) {
  const def = getComponent(type)
  if (!def) return []
  const p = fillParams(def, params)
  if (checkParams(def, p).length) return []
  try { return cachedBuild(def, p, resolveDensity(null), false).densKeys.slice() } catch { return [] }
}
/** 组件局部包围盒（6 元，新数组；componentFacts 的 bbox）。对称判据（asmSnap.symCoincides）用。 */
export function componentBox(type, params, density) {
  const f = componentFacts(type, params, density)
  return f ? f.bbox : null
}

function rebuildBase(e0, def, raw, dens, full) {
  const built = cachedBuild(def, fillParams(def, raw), dens, full)
  e0.base = { vals: snapValues(def.keys, raw), dens, built }
  return built
}
/** 主件（k = 0）的生成结果：按参数值 + 密度表取值缓存在条目上（full 时须是带 items 的完整结果）。 */
function baseBuild(plan, e0, dens, full) {
  const def = e0.def, c = plan.srcs[e0.ci], raw = isObj(c.params) ? c.params : NO_PARAMS, b = e0.base
  if (b && b.dens === dens && def.paramsEq(raw, b.vals) && (!full || b.built.items)) return b.built
  return rebuildBase(e0, def, raw, dens, full)
}
/** 任一条目（含派生）的局部生成结果：plane / radial 复用主件；hook 用镜像参数重生成；bake 烘焙主件。full：须带 items（出 IR）。 */
function builtFor(plan, e, dens, full) {
  const base = baseBuild(plan, plan.entries[e.primaryIdx], dens, full)
  const mode = e.pose.mode
  if (e.k === 0 || mode === 'plane' || mode === 'radial') return base
  const bc = e.bc
  if (bc && bc.base === base && bc.plane === e.pose.plane && bc.mode === mode && (!full || bc.built.items)) return bc.built
  const built = mode === 'hook' ? cachedBuild(e.def, fillParams(e.def, e.def.mirror(base.params, e.pose.plane)), dens, full) : bakeBuilt(base, e.pose.plane)
  e.bc = { base, plane: e.pose.plane, mode, built }
  return built
}

/** 密度表取值（按文档 density 的原值缓存）。 */
function densFor(doc, st) {
  const src = isObj(doc) && isObj(doc.density) ? doc.density : NO_PARAMS
  if (st.dens && DENS_EQ(src, st.densRaw)) return st.dens
  st.dens = resolveDensity(src)
  st.densRaw = snapValues(DENS_KEYS, src)
  return st.dens
}

// ───────────────────────────── 质量合成 ─────────────────────────────

function newMassState() {
  return { poses: new Map(), dens: null, densRaw: [], n: 0, cap: 0, m: null, c: null, I: null, sink: -1, other: 0, warn: null, names: null, kinds: null, msg: null, msgWarn: null, msgTarget: null, msgOther: 0 }
}
function ensureCap(st, n) {
  if (st.cap >= n) return
  const cap = Math.max(64, 2 * n), m = new Float64Array(cap), c = new Float64Array(3 * cap), I = new Float64Array(9 * cap)
  if (st.m) { m.set(st.m); c.set(st.c); I.set(st.I) }
  st.m = m; st.c = c; st.I = I; st.cap = cap
}
/**
 * 单位质量分布（组件自身无质量元、装配件手填了质量时）：组件的 unitMass，没有就按局部包围盒中心的质点。
 * 烘焙件（b.bakePlane）的 unitMass 是按主件参数在未镜像局部系里给的，这里同样过局部镜面（质心翻该轴、惯量翻交叉项）；
 * 包围盒兜底用的 b.bbox 已经是镜像后的，不再翻。钩子件的 b.params 就是镜像参数，plane / radial 件几何与主件相同，都不用翻。
 */
function unitElems(def, b) {
  if (def.unitMass) {
    const list = def.unitMass(b.params)
    if (!b.bakePlane) return list
    const ax = PLANE_AXIS[b.bakePlane]
    return list.map((q) => ({ ...q, com: q.com.map((v, k) => (k === ax ? z0(-v) : v)), I: q.I.map((v, i) => ((Math.floor(i / 3) === ax) !== (i % 3 === ax) ? z0(-v) : v)) }))
  }
  const bb = b.bbox, c = Number.isFinite(bb[0]) ? [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2] : [0, 0, 0]
  return [{ name: 'mass', kind: 'point', massKg: 1, com: c, I: [0, 0, 0, 0, 0, 0, 0, 0, 0] }]
}

/**
 * 全部质量元换到本体系（根件坐标系、spec 原点）写进 st；目标质量的余量由「首个带 def.massSink、且质量没被手填的主件」吃掉
 * （按解算顺序：根件是平台体 / 机身 / 船体 / 车体时就是根件）。不要求是根：结构树里「设为根」换到别的件上，平台体照样吃余量、总质量不跳。
 */
function collectMass(plan, dens, doc, st, withNames) {
  // 目标质量在这里读（不从调用方以实参传进来：双精度字段读出来再当实参传给未内联的函数会装箱）
  const target = isObj(doc) ? doc.massTargetKg : null
  let n = 0
  st.sink = -1; st.warn = null
  if (withNames) { st.names = []; st.kinds = [] }
  const E = plan.entries
  for (let i = 0; i < E.length; i++) {
    const e = E[i]
    if (!e.def) continue
    const c = plan.srcs[e.ci], b = builtFor(plan, e, dens), M = e.pose.m
    const ov = isNum(c.massKg) && c.massKg > 0 ? c.massKg : 0
    let list = b.comps, k = 1
    if (ov > 0) {
      if (b.massKg > 0) k = ov / b.massKg
      else { if (!b.unit) b.unit = unitElems(e.def, b); list = b.unit; k = ov }
    }
    const sinkName = st.sink < 0 && e.k === 0 && e.def.massSink && !isNum(b.params.massKg) && !(ov > 0) ? e.def.massSink : null
    for (let j = 0; j < list.length; j++) {
      const q = list[j]
      ensureCap(st, n + 1)
      st.m[n] = q.massKg * k
      const x = q.com[0], y = q.com[1], z = q.com[2], o = 3 * n
      st.c[o] = M[0] * x + M[4] * y + M[8] * z + M[12]
      st.c[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]
      st.c[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
      // I_b = R·(k·I)·Rᵀ，R 的 (r, s) 元 = M[r + 4s]
      const I = q.I, oi = 9 * n
      for (let r = 0; r < 3; r++) {
        for (let s2 = 0; s2 < 3; s2++) {
          let sum = 0
          for (let a = 0; a < 3; a++) {
            const Mra = M[r + 4 * a]
            if (Mra === 0) continue
            for (let bb = 0; bb < 3; bb++) sum += Mra * I[3 * a + bb] * M[s2 + 4 * bb]
          }
          st.I[oi + 3 * r + s2] = sum * k
        }
      }
      if (withNames) { st.names.push(`${e.prefix}_${q.name}`); st.kinds.push(q.kind) }
      if (sinkName && q.name === sinkName && st.sink < 0) st.sink = n
      n++
    }
  }
  st.n = n
  if (isNum(target) && target > 0) {
    if (st.sink < 0) st.warn = 'nosink'
    else {
      let other = 0
      for (let i = 0; i < n; i++) if (i !== st.sink) other += st.m[i]
      const mb = target - other
      st.other = other
      if (mb > 0.05 * target) {
        const kk = mb / st.m[st.sink], oi = 9 * st.sink
        st.m[st.sink] = mb
        for (let i = 0; i < 9; i++) st.I[oi + i] *= kk
      } else st.warn = 'small'
    }
  }
}
const massWarning = (st, target) => (st.warn === 'nosink' ? `目标质量 ${target} kg 未生效：没有可吃余量的平台体` :st.warn === 'small' ? `目标质量 ${target} kg 小于其余组件合计 ${st.other.toFixed(1)} kg 的 1.05 倍，平台体按密度表估算` : null)

/**
 * 合计：总质量、质心、对质心惯量（对称化、抹 −0），写进 out（复用其数组）。与 paramBus 同一累加口径。
 * 总质量为 0（空文档、只有无质量外观件）时质心 / 惯量写全 0，不出 NaN（编辑器每帧读数照常显示）。
 * 抹 −0 用「+ 0」（−0 + 0 = +0，其余值不变），不调 z0：热路径里不向可能未内联的函数传算出来的双精度数。
 */
function sumMass(st, out) {
  let M = 0, sx = 0, sy = 0, sz = 0
  for (let i = 0; i < st.n; i++) { const m = st.m[i]; M += m; sx += m * st.c[3 * i]; sy += m * st.c[3 * i + 1]; sz += m * st.c[3 * i + 2] }
  const pos = M > 0, inv = pos ? 1 / M : 0, cx = sx * inv, cy = sy * inv, cz = sz * inv
  let i00 = 0, i01 = 0, i02 = 0, i10 = 0, i11 = 0, i12 = 0, i20 = 0, i21 = 0, i22 = 0
  for (let i = 0; i < st.n; i++) {
    const m = st.m[i], dx = st.c[3 * i] - cx, dy = st.c[3 * i + 1] - cy, dz = st.c[3 * i + 2] - cz, d2 = dx * dx + dy * dy + dz * dz, o = 9 * i
    i00 += st.I[o] + m * (d2 - dx * dx); i01 += st.I[o + 1] - m * dx * dy; i02 += st.I[o + 2] - m * dx * dz
    i10 += st.I[o + 3] - m * dy * dx; i11 += st.I[o + 4] + m * (d2 - dy * dy); i12 += st.I[o + 5] - m * dy * dz
    i20 += st.I[o + 6] - m * dz * dx; i21 += st.I[o + 7] - m * dz * dy; i22 += st.I[o + 8] + m * (d2 - dz * dz)
  }
  const a01 = (i01 + i10) / 2, a02 = (i02 + i20) / 2, a12 = (i12 + i21) / 2
  const com = Array.isArray(out.comBody) && out.comBody.length === 3 ? out.comBody : (out.comBody = [0, 0, 0])
  let I = out.inertiaBody
  if (!(Array.isArray(I) && I.length === 3 && row3Ok(I[0]) && row3Ok(I[1]) && row3Ok(I[2]))) I = out.inertiaBody = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  if (pos) {
    com[0] = cx + 0; com[1] = cy + 0; com[2] = cz + 0
    I[0][0] = i00 + 0; I[0][1] = a01 + 0; I[0][2] = a02 + 0; I[1][0] = a01 + 0; I[1][1] = i11 + 0; I[1][2] = a12 + 0; I[2][0] = a02 + 0; I[2][1] = a12 + 0; I[2][2] = i22 + 0
    out.massKg = M
  } else {
    com[0] = 0; com[1] = 0; com[2] = 0
    for (let r = 0; r < 3; r++) { I[r][0] = 0; I[r][1] = 0; I[r][2] = 0 }
    out.massKg = 0
  }
  return out
}

/**
 * 实时质量特性（编辑器每帧读数用）：总质量、质心、对质心惯量，坐标 = 根件坐标系（spec 原点，未减几何中心）。
 * out 传同一个对象反复调用时复用缓存与数组（不新建对象）。与 buildAssembly 的 massProps 同一套数（后者再减 specOriginBody）。
 * @returns {{massKg:number, comBody:number[], inertiaBody:number[][], count:number, warnings:string[]}}
 */
export function combineMass(doc, out) {
  const o = isObj(out) ? out : {}
  let st = o[MASS]
  if (!st) { st = newMassState(); hidden(o, MASS, st) }
  solvePose(doc, st.poses)
  const plan = st.poses[PLAN]
  collectMass(plan, densFor(doc, st), doc, st, false)
  sumMass(st, o)
  o.count = st.n
  if (st.warn) {
    // 告警文案按（类型, 目标, 余量）缓存：同一告警每帧复用同一个字符串与数组
    const target = doc.massTargetKg
    if (!(st.msg && st.msgWarn === st.warn && st.msgTarget === target && (st.warn !== 'small' || st.msgOther === st.other) && Array.isArray(o.warnings) && o.warnings.length === 1 && o.warnings[0] === st.msg)) {
      st.msg = massWarning(st, target); st.msgWarn = st.warn; st.msgTarget = target; st.msgOther = st.other
      o.warnings = [st.msg]
    }
  } else if (!Array.isArray(o.warnings) || o.warnings.length) o.warnings = []
  return o
}

// ───────────────────────────── 生成出口 ─────────────────────────────

function specErr(msg, errors, missing) {
  const err = new Error(msg)
  err.code = 'SPEC_INVALID'; err.errors = errors; err.missing = missing
  return err
}
const colsOf = (M) => [[M[0], M[1], M[2]], [M[4], M[5], M[6]], [M[8], M[9], M[10]]]
const apply3 = (M, v) => [M[0] * v[0] + M[4] * v[1] + M[8] * v[2], M[1] * v[0] + M[5] * v[1] + M[9] * v[2], M[2] * v[0] + M[6] * v[1] + M[10] * v[2]]
const nrm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0] }
/** 挂点上向：给了且不与视轴平行就取去掉视轴分量后的单位向量，否则按 D1 缺省（与 meshKit.addAp 同一规则，只是在本体系里补）。 */
function resolveUp(dir, up) {
  if (up) {
    const k = up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2], r = [up[0] - k * dir[0], up[1] - k * dir[1], up[2] - k * dir[2]]
    if (Math.hypot(r[0], r[1], r[2]) > 1e-6) return nrm3(r)
  }
  return defaultUpBody(dir)
}

/** IR 材质表（按 MaterialKey 去重；与 paramBus 同一材质库）。 */
function matTable(ir) {
  const idx = new Map()
  return (key) => {
    if (!idx.has(key)) {
      const d = MATERIALS[key]
      const m = { name: key, key, color: d.color.slice(), metalness: d.metalness, roughness: d.roughness }
      if (d.doubleSided) m.doubleSided = true
      if (isNum(d.opacity)) m.opacity = d.opacity
      ir.materials.push(m); idx.set(key, ir.materials.length - 1)
    }
    return idx.get(key)
  }
}
const meshOf = (name, mb, material) => ({ name, position: Float32Array.from(mb.p), normal: Float32Array.from(mb.n), uv: Float32Array.from(mb.uv), index: Uint32Array.from(mb.idx), material })
const colMajorArr = (R, t) => [R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, t[0], t[1], t[2], 1].map(z0)

/**
 * 装配文档 → 与 buildParamModel 同形的结果：
 *   { ir, attachPoints, articulations, solarPanelGroups, massProps, parts, frame, bboxBody, boundingRadiusM, specOriginBody, specHash, spec, warnings }
 * 所有 *Body 坐标在输出本体系（原点 = 几何中心）；文档坐标 = 输出坐标 + specOriginBody。specHash = asmHash、spec = 归一后的文档。
 * 文档非法、组件生成失败或结果含非有限数时抛 Error（code = 'SPEC_INVALID'，errors / missing）。
 */
export function buildAssembly(doc) {
  const v = validateAssembly(doc)
  if (!v.ok) throw specErr(`装配件不完整或非法：${[...v.missing.map((p) => p + ' 缺'), ...v.errors].join('；')}`, v.errors, v.missing)
  const d = normalizeAssembly(doc)
  const frameDef = DOMAIN_FRAMES[d.domain]
  const st = newMassState()
  solvePose(d, st.poses)
  const plan = st.poses[PLAN]
  const E = plan.entries
  const badPose = E.filter((e) => e.pose.bad).map((e) => `${e.id}：位姿解算失败（${e.pose.bad}）`)
  if (badPose.length) throw specErr(`装配件不完整或非法：${badPose.join('；')}`, badPose, [])
  const dens = densFor(d, st)
  const warnings = []
  const builts = E.map((e) => {
    try { return builtFor(plan, e, dens, true) } catch (err) { throw specErr(`组件 ${e.id} 生成失败：${err.message}`, [`${e.id}：${err.message}`], []) }
  })

  // —— 质量特性（本体系 spec 原点）
  collectMass(plan, dens, d, st, true)
  const mw = massWarning(st, d.massTargetKg)
  if (mw) warnings.push(mw)
  const mp = sumMass(st, {})
  if (!(mp.massKg > 0)) throw specErr('装配件总质量为 0', ['装配件总质量为 0'], [])

  // —— 包围盒（本体系）→ 几何中心
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  E.forEach((e, i) => {
    const M = e.pose.m
    for (const it of builts[i].items) {
      if (!it.P) continue
      const P = it.P
      for (let j = 0; j < P.length; j += 3) {
        const x = P[j], y = P[j + 1], z = P[j + 2]
        const w = [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]
        for (let k = 0; k < 3; k++) { if (w[k] < mn[k]) mn[k] = w[k]; if (w[k] > mx[k]) mx[k] = w[k] }
      }
    }
  })
  const c = [0, 1, 2].map((k) => (mn[k] + mx[k]) / 2)
  const sh = (p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]].map(z0)

  const massProps = {
    massKg: mp.massKg, comBody: sh(mp.comBody), inertiaBody: mp.inertiaBody, source: 'components', confidence: 'low',
    components: st.names.map((name, i) => ({ name, kind: st.kinds[i], massKg: st.m[i], comBody: sh([st.c[3 * i], st.c[3 * i + 1], st.c[3 * i + 2]]) }))
  }

  // —— IR：根 → 组件节点（本体系位姿）→ 几何节点（组件局部）；挂点节点挂根下
  const ir = { units: 'm', unitHint: 'm', sourceFormat: 'param', materials: [], meshes: [], nodes: [] }
  const matOf = matTable(ir)
  ir.nodes.push({ name: frameDef.root, parent: -1, matrix: frameDef.matrix.slice(), role: 'other', extras: { asmRoot: true } })
  const attachPoints = [], articulations = [], solarPanelGroups = [], parts = []
  const apNodes = []
  E.forEach((e, i) => {
    const b = builts[i], M = e.pose.m, comp = plan.srcs[e.ci], pre = e.prefix
    const R = colsOf(M), T = sh([M[12], M[13], M[14]])
    const extras = { asmComp: e.id, type: e.def.type }
    if (comp.name) extras.asmName = comp.name
    if (comp.hidden) extras.hidden = true
    ir.nodes.push({ name: pre, parent: 0, matrix: colMajorArr(R, T), extras })
    const ci = ir.nodes.length - 1
    const matKey = comp.material && MATERIALS[comp.material] ? comp.material : null
    for (const it of b.items) {
      const node = { name: `${pre}_${it.name}`, parent: ci, matrix: colMajorArr(it.R, it.t) }
      if (it.role) node.role = it.role
      if (it.partId) node.extras = { part: `${pre}_${it.partId}` }
      if (it.mb && it.mb.tcount) { ir.meshes.push(meshOf(node.name, it.mb, matOf(matKey || it.mat))); node.mesh = ir.meshes.length - 1 }
      ir.nodes.push(node)
    }
    for (const a of b.aps) {
      const dir = nrm3(apply3(M, a.dirBody)), up = resolveUp(dir, a.upBody ? apply3(M, a.upBody) : null)
      const pos = sh(apply3(M, a.posBody).map((x, k) => x + M[12 + k]))
      const name = `${pre}_${a.name}`
      apNodes.push({ name, parent: 0, matrix: attachNodeMatrix(pos, dir, up), extras: { attachPoint: true } })
      attachPoints.push({ name, node: name, posBody: pos, dirBody: dir.map(z0), upBody: up.map(z0) })
    }
    for (const a of b.arts) articulations.push({ name: `${pre}_${a.name}`, nodes: a.nodes.map((n) => `${pre}_${n}`), stages: a.stages.map((q) => ({ ...q })) })
    for (const g of b.spg) solarPanelGroups.push({ name: `${pre}_${g.name}`, nodes: g.nodes.map((n) => `${pre}_${n}`), efficiency: g.efficiency })
    const disp = comp.name || null
    for (const p of b.parts) {
      let area = p.areaM2
      if (!(area > 0)) { area = 0; for (const it of b.items) if (p.nodes.includes(it.name) && it.P) area += meshArea(it.P, it.mb.idx) }
      const o = { id: `${pre}_${p.id}`, name: disp ? `${disp} · ${p.name}` : `${p.name} ${pre}`, role: p.role, nodes: p.nodes.map((n) => `${pre}_${n}`), areaM2: area }
      if (p.normalBody) o.normalBody = nrm3(apply3(M, p.normalBody)).map(z0)
      if (p.fitted) {
        const f = p.fitted, pt = (v) => sh(apply3(M, v).map((x, k) => x + M[12 + k]))
        o.fitted = { ...f, vertexBody: pt(f.vertexBody), focusBody: pt(f.focusBody), axisBody: nrm3(apply3(M, f.axisBody)).map(z0) }
      }
      parts.push(o)
    }
    for (const w of b.warnings) warnings.push(`${pre}：${w}`)
  })
  for (const n of apNodes) ir.nodes.push(n)

  const bmin = sh(mn), bmax = sh(mx)
  const res = {
    ir, attachPoints, articulations, solarPanelGroups, massProps, parts,
    frame: { q_model2body: frameDef.q.slice(), t_model2body: [0, 0, 0], verified: true },
    bboxBody: { min: bmin, max: bmax },
    boundingRadiusM: Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) / 2,
    specOriginBody: c.map(z0),
    specHash: asmHash(d),
    spec: d,
    warnings
  }
  const bad = nonFiniteReport(res)
  if (bad.length) throw specErr(`生成结果含非有限数：${bad.slice(0, 6).join('、')}${bad.length > 6 ? ` 等 ${bad.length} 处` : ''}`, [`生成结果含非有限数：${bad.join('、')}`], [])
  return res
}

/**
 * 单个组件在自身局部系的生成结果（编辑器按 type + 参数缓存、拖入 ghost 用；不进装配文档）。
 * IR 根节点 'component' 为单位阵，几何节点名为短名；attachPoints 在局部系（上向按 D1 缺省在局部系补，仅供预览）。
 * @returns {{params, sockets, faces, symmetricPlanes, ir, attachPoints, massKg, bbox:{min,max}}}
 */
export function buildComponent(type, params, opts = {}) {
  const def = getComponent(type)
  if (!def) throw specErr(`未知组件「${type}」`, [`未知组件「${type}」`], [])
  const p = fillParams(def, params)
  const errs = checkParams(def, p)
  if (errs.length) throw specErr(`组件参数非法：${errs.join('；')}`, errs, [])
  const b = cachedBuild(def, p, resolveDensity(opts.density), true)
  const ir = { units: 'm', unitHint: 'm', sourceFormat: 'param', materials: [], meshes: [], nodes: [{ name: 'component', parent: -1, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], role: 'other' }] }
  const matOf = matTable(ir)
  for (const it of b.items) {
    const node = { name: it.name, parent: 0, matrix: colMajorArr(it.R, it.t) }
    if (it.role) node.role = it.role
    if (it.mb && it.mb.tcount) { ir.meshes.push(meshOf(it.name, it.mb, matOf(it.mat))); node.mesh = ir.meshes.length - 1 }
    ir.nodes.push(node)
  }
  const attachPoints = b.aps.map((a) => { const dir = nrm3(a.dirBody); return { name: a.name, posBody: a.posBody.slice(), dirBody: dir, upBody: resolveUp(dir, a.upBody) } })
  const sp = typeof def.symmetricPlanes === 'function' ? def.symmetricPlanes(p) : (def.symmetricPlanes || [])
  return {
    params: p, sockets: def.sockets(p), faces: def.faces(p), symmetricPlanes: sp.slice(), ir, attachPoints, massKg: b.massKg,
    bbox: { min: b.bbox.slice(0, 3), max: b.bbox.slice(3) },
    // 关节（局部短名，与 ir 几何节点名同）：编辑器「初值姿态」预览按它摆（P3 契约 §2.4；装配件入库时由 buildAssembly 按前缀改名）
    articulations: b.arts.map((a) => ({ name: a.name, nodes: a.nodes.slice(), stages: a.stages.map((q) => ({ ...q })) }))
  }
}

/**
 * paramBus 整星 spec → 等价装配文档（便于从生成页模板起步再手改；DESIGN3 §1 P1）。
 * 质量元一一对应（总质量、质心、惯量与 buildParamModel 对得上）；spec 非法抛 SPEC_INVALID（与 buildParamModel 同）。
 * opts.warnings（数组）收转换告警。返回归一后的文档（不含 id：id 由调用方 newAsmId 生成）。
 */
export function specToAssembly(spec, opts = {}) {
  const v = validateSpec(spec)
  if (!v.ok) throw specErr(`参数不完整或非法：${[...v.missing.map((p) => p + ' 缺'), ...v.errors].join('；')}`, v.errors, v.missing)
  const s = normalizeSpec(spec)
  const r = satSpecToComps(s)
  if (Array.isArray(opts.warnings)) opts.warnings.push(...r.warnings)
  return normalizeAssembly({ kind: 'assembly', schema: ASM_SCHEMA, domain: 'spacecraft', name: typeof s.name === 'string' ? s.name : '', comps: r.comps, density: s.density, massTargetKg: isNum(s.massTargetKg) ? s.massTargetKg : null })
}
