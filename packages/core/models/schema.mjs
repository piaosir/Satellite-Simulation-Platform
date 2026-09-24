// ModelMeta（模型元数据）与绑定表的默认值 / 校验 / 归一（任务书 §4.1–4.2；设计契约 §3.2、§3.4、§3.5、T10）。
//
// 为什么集中在这里：同一份 ModelMeta 要在五处被读写——离线管线出 manifest、主进程存 .satsim.json、
// 远端 manifest 过闸、工作台编辑、导出写进 glb 的 extras.satsim。口径若各写一份，迟早出现「工作台存得进、
// 主进程拒收」或「远端塞进一个 redistributable=false 条目没人拦」。
//
// 三个动作的分工：
//   validateMeta  只判不改：{ok, errors, warnings}。errors = 硬伤（进不了库 / 过不了闸），warnings = 能用但可疑。
//   normalizeMeta 只改不判：补默认、裁非法值、按白名单丢未知键，永远返回一份完整可用的 ModelMeta，不抛。
//   defaultMeta   = normalizeMeta(partial) 的语义化别名：新建条目用。
// 用法：外来数据（远端 manifest、用户 JSON 导入、glb 里的 extras.satsim）先 validate 决定收不收，
// 收了再 normalize 落盘；自己生成的直接 defaultMeta。
//
// 授权相关的硬规则（四道闸的数据基础，改动前必读 DESIGN §0-1）：
//   · source.kind === 'stk-local' ⇔ id 以 'stk:' 开头；二者任一成立，redistributable 必须为 false、license 为 'AGI SLA'。
//     normalizeMeta 朝「不可分发」方向纠正（宁可错拦，不可错放）。
//   · isRedistributable 只认 redistributable === true 且不是 STK 来源。
//
// 导出：
//   SCHEMA_VERSION, MODEL_KINDS, MODEL_GROUPS, FIDELITIES, SOURCE_KINDS, MASS_SOURCES, CONFIDENCES, LOD_KEYS,
//   ATTITUDE_LAWS, SHA256_RE, DEFAULT_Q_MODEL2BODY（转出 bodyFrame 的唯一真值源）, DEFAULT_PREFS, NASA_LICENSE
//   parseModelId, isValidModelId, nasaModelId, paramModelId, userModelId, stkModelId
//   defaultMeta, validateMeta, normalizeMeta, slimMeta, isRedistributable, importDefaultQOf（按类别 / 来源的导入缺省 q）
//   三期装配（DESIGN3 E1–E5）：ASM_DOMAIN_KINDS（装配领域 → kind）、isAssemblySpec(spec)、asmModelRefs(spec)（装配文档引用的库模型 id）
//   validateBindings, satKeyOf, grdSatKey, lbSatKey, isValidSatKey, SATKEY_NORAD_MAX
//   二期 mount / 姿态律：normalizeMount, defaultMount, normalizeAttitude, GIMBAL_TYPES, ANTENNA_REF_KINDS, BODY_AXES,
//     DEFAULT_SYS_TEMP_K, DEFAULT_GIMBAL_LIMITS, MASK_SIG_RE, ATTITUDE_PARAM_DEFAULTS

import { PART_ROLES, UNIT_HINTS } from './ir.mjs'
import { DEFAULT_Q_MODEL2BODY, quatIsUnit, quatCanonical, defaultUpBody, isUpDegenerate, defaultImportQ } from './bodyFrame.mjs'
import { STAGE_TYPES, agiNameOk } from './agi.mjs'
import { DEFAULT_MODEL_ID, resolveParamModelId } from './paramTemplates.mjs'   // 纯数据模块、无导入：不成环

export { DEFAULT_Q_MODEL2BODY }

export const SCHEMA_VERSION = 2
// 契约 §3.2（覆盖任务书 §4.1 的 body：NASA 的 body 组整组不收）。
// 三期（DESIGN3 E5/E6）追加实体三类 aircraft / ship / vehicle：STK 本机 Air / Sea / Land 件与装配页的飞机 / 船舶 / 车辆装配件。
// 地球站沿用 'ground'（A3 SPEC §12-2 编排者裁定：不另设 station 别名——'station' 在这里是空间站）。
export const MODEL_KINDS = Object.freeze(['spacecraft', 'station', 'ground', 'launcher', 'component', 'deepspace', 'crewed', 'other', 'aircraft', 'ship', 'vehicle'])
export const MODEL_GROUPS = Object.freeze(['spacecraft', 'deepspace', 'station', 'component', 'ground', 'crewed', 'launcher', 'aircraft', 'ship', 'vehicle'])
/** 装配领域（assembly.mjs ASM_DOMAINS）→ 入库 kind / group。schema 不 import assembly.mjs（防环、主进程不加载组件库），这里手写同一张表，单测对账。 */
export const ASM_DOMAIN_KINDS = Object.freeze({ spacecraft: 'spacecraft', ground: 'ground', aircraft: 'aircraft', ship: 'ship', vehicle: 'vehicle' })
export const FIDELITIES = Object.freeze(['outreach', 'parametric', 'cad', 'engineering'])
export const SOURCE_KINDS = Object.freeze(['nasa', 'community', 'stk-local', 'user', 'param', 'builtin'])
export const MASS_SOURCES = Object.freeze(['manual', 'estimate', 'components'])
export const CONFIDENCES = Object.freeze(['high', 'low'])
export const LOD_KEYS = Object.freeze(['lod0', 'lod1', 'lod2'])
export const ATTITUDE_LAWS = Object.freeze(['nadir', 'yawSteer', 'sun', 'inertial', 'target'])
export const SHA256_RE = /^[0-9a-f]{64}$/

const STK_LICENSE = 'AGI SLA'
// 字符串长度上限：远端 manifest 是外来数据，给每个字段一个上限，防一条恶意条目把界面 / 内存撑爆
const LIM = { title: 200, url: 2048, credit: 1000, license: 200, tag: 64, tags: 64, alias: 128, aliases: 128, name: 256, list: 4096 }

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string'
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const q = (s) => { try { return JSON.stringify(s) } catch { return String(typeof s) } }
/**
 * 纯数据深拷贝（丢函数 / undefined / Proxy 外壳）。拷不了——BigInt、循环引用、toJSON 抛错——返回 undefined，
 * 调用方按「该字段丢弃」处理：normalizeMeta / validateBindings 承诺不抛，主进程逐个读 user/*.satsim.json 时
 * 一份坏文件不能让整个 models:manifest 目录加载失败。
 * 各层的 '__proto__' 键一律丢掉：JSON.parse 把它建成自有数据属性（不动原型），但下游只要对它做一次赋值拷贝
 * （out[k] = v、Object.assign）就会触发原型 setter，把攻击者给的对象换成原型——被丢弃 / 缺省的已知键（maskSig 等）
 * 随即从原型上读到未校验的值。在拷贝源头剥掉，所有经 plain 的字段（parts、spec、mount、姿态参数、天线口径）一并免疫。
 * reviver 逐值回调，12 MB 的部件表（80 万个 triRanges 区间）从 0.15 s 拖到 1.1 s：先在串里找这个键名，没有就走不带 reviver 的快路。
 */
const dropProto = (k, x) => (k === '__proto__' ? undefined : x)
const plain = (v) => {
  try {
    const s = JSON.stringify(v)
    if (s === undefined) return undefined
    return s.includes('"__proto__"') ? JSON.parse(s, dropProto) : JSON.parse(s)
  } catch { return undefined }
}
/** 原型链上的保留名：「未知键照留」的对象（mount、姿态参数、天线口径、部件、spec）不收它们（'__proto__' 已由 plain 剥掉，这里再挡一道） */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
/**
 * 从 plain 出来的副本上摘掉保留名；按原始对象查自有键（'__proto__' 在副本里已经没了），errors 给了就记错。
 * 'constructor' / 'prototype' 作数据属性本身不改原型，但下游「是不是纯对象」的判断（v.constructor === Object）会被它骗。
 */
function dropReserved(raw, copy, path, errors) {
  for (const k of RESERVED_KEYS) {
    if (!Object.hasOwn(raw, k)) continue
    if (errors) errors.push(`${path}.${k}：保留名，已丢弃`)
    if (Object.hasOwn(copy, k)) delete copy[k]
  }
  return copy
}
/** updatedAt → ISO 串或 null。数字时间戳越出 Date 的 ±8.64e15 ms 范围（纳秒戳、1e16）时 toISOString 会抛，这里给 null。 */
const isoOrNull = (v) => {
  if (isStr(v)) return Number.isFinite(Date.parse(v)) ? v : null
  if (isNum(v)) { const d = new Date(v); return Number.isFinite(d.getTime()) ? d.toISOString() : null }
  return null
}

// ─────────────────────────────── 模型 id（契约 §3.5） ───────────────────────────────

const ID_RULES = [
  // nasa:<slug>[~n]，n 从 2 起（多文件条目按文件名排序后的第 n 个）
  ['nasa', /^nasa:([a-z0-9](?:[a-z0-9-]{0,158}[a-z0-9])?)(?:~([2-9]|[1-9][0-9]{1,2}))?$/],
  // param:<模板 id> 或 param:<specHash 前 12 位>（小写字母数字开头，允许 . _ -）
  ['param', /^param:([a-z0-9][a-z0-9._-]{0,63})$/],
  ['user', /^user:([0-9a-f]{12})$/],
  ['stk', /^stk:([0-9a-f]{12})$/],
  // 社区模型（CC BY，三期云端库）：预留
  ['community', /^community:([a-z0-9][a-z0-9._-]{0,127})$/],
  // 装配件（DESIGN3 E4）：asm:<12 位十六进制>，新建时随机生成、终身不变（不是内容哈希：编辑不断绑定）；与 assembly.mjs ASM_ID_RE 同式
  ['asm', /^asm:([0-9a-f]{12})$/],
  // 实体模板（A3 SPEC §12-2）：ent:<模板 id>，运行时由 entityTemplates.mjs 现生成、没有文件；与 ENTITY_ID_RE 同式
  ['ent', /^ent:([a-z0-9][a-z0-9-]{0,47})$/]
]
// id 前缀 → 允许的 source.kind。asm 恒为用户自建件（主进程强制 user、可分发）；ent 是随程序的模板（builtin）
const PREFIX_SOURCES = { nasa: ['nasa', 'builtin'], param: ['param', 'builtin'], user: ['user'], stk: ['stk-local'], community: ['community'], asm: ['user'], ent: ['builtin'] }

/** 拆 id：{prefix, body, n}（n 仅 nasa 有，缺省 1）；非法返回 null。 */
export function parseModelId(id) {
  if (!isStr(id) || id.length > 200) return null
  for (const [prefix, re] of ID_RULES) {
    const m = re.exec(id)
    if (m) return prefix === 'nasa' ? { prefix, body: m[1], n: m[2] ? Number(m[2]) : 1 } : { prefix, body: m[1] }
  }
  return null
}
export const isValidModelId = (id) => parseModelId(id) !== null

/** nasa:<slug> / nasa:<slug>~<n>（n ≥ 2）。slug 非法返回 null。 */
export function nasaModelId(slug, n = 1) {
  const id = n > 1 ? `nasa:${slug}~${n}` : `nasa:${slug}`
  return Number.isInteger(n) && n >= 1 && isValidModelId(id) ? id : null
}
export function paramModelId(templateIdOrHash) {
  const id = `param:${String(templateIdOrHash ?? '').toLowerCase().slice(0, 64)}`
  return isValidModelId(id) ? id : null
}
const shaPrefix = (sha) => (isStr(sha) && SHA256_RE.test(sha.toLowerCase()) ? sha.toLowerCase().slice(0, 12) : null)
/** user:<sha256 前 12 位>；sha 非法返回 null。 */
export function userModelId(sha256) { const p = shaPrefix(sha256); return p ? `user:${p}` : null }
/** stk:<sha256 前 12 位>。 */
export function stkModelId(sha256) { const p = shaPrefix(sha256); return p ? `stk:${p}` : null }

// ─────────────────────────────── 默认值 ───────────────────────────────

/**
 * NASA 模型的许可文案（编排者 2026-09-24 全仓统一；scripts/nasa3d/build.mjs 的 NASA_LICENSE 同一句，modelPipeline 单测对拍）。
 * 依据 NASA Images and Media Usage Guidelines：美国政府作品在美国属公有领域；不得用于暗示 NASA 背书；
 * 第三方贡献者（DigitalSpace、JHU APL 等）的署名须保留——credit 字段按「NASA / <贡献者>」写，规则不变。
 */
export const NASA_LICENSE = 'NASA Images and Media Usage Guidelines（美国公有领域；不得暗示 NASA 背书；保留第三方贡献者署名）'

function defaultSource(kind) {
  switch (kind) {
    case 'nasa': return { kind, url: '', credit: 'NASA', license: NASA_LICENSE, redistributable: true }
    case 'stk-local': return { kind, url: '', credit: 'Ansys / AGI', license: STK_LICENSE, redistributable: false }
    case 'param': return { kind, url: '', credit: '', license: '', redistributable: true }
    case 'builtin': return { kind, url: '', credit: '', license: '', redistributable: true }
    case 'community': return { kind, url: '', credit: '', license: '', redistributable: false }
    // user：用户自己的文件来路我们不知道，缺省不可分发——要上云得用户明确勾（三期）
    default: return { kind: 'user', url: '', credit: '', license: '', redistributable: false }
  }
}

const zeroGeometry = () => ({ bboxM: { min: [0, 0, 0], max: [0, 0, 0] }, boundingRadiusM: 0, tris: 0, areaM2: 0, volumeM3: null, closed: false, centroidM: [0, 0, 0] })

/**
 * 新建条目：partial 覆盖缺省后走 normalizeMeta。source.kind 缺省按 id 前缀推（stk: → stk-local 等），
 * 再缺省 'user'；fidelity 缺省 param → parametric、其余 outreach。
 */
export function defaultMeta(partial = {}) {
  return normalizeMeta(isObj(partial) ? partial : {})
}

// ─────────────────────────────── 校验 ───────────────────────────────

function checkStrList(v, path, errors, { max = LIM.list, itemMax = LIM.name, unique = true, nonEmpty = true } = {}) {
  if (!Array.isArray(v)) { errors.push(`${path}：须为数组`); return }
  if (v.length > max) errors.push(`${path}：超过 ${max} 项`)
  const seen = new Set()
  v.forEach((s, i) => {
    if (!isStr(s) || (nonEmpty && !s)) errors.push(`${path}[${i}]：须为非空字符串`)
    else if (s.length > itemMax) errors.push(`${path}[${i}]：超过 ${itemMax} 字`)
    else if (unique && seen.has(s)) errors.push(`${path}[${i}]：重复「${s}」`)
    seen.add(s)
  })
}

function checkFileEntry(f, path, errors, withTris) {
  if (!isObj(f)) { errors.push(`${path}：须为对象`); return }
  if (!isStr(f.sha256) || !SHA256_RE.test(f.sha256)) errors.push(`${path}.sha256：须为 64 位小写十六进制`)
  if (!(Number.isInteger(f.bytes) && f.bytes > 0)) errors.push(`${path}.bytes：须为正整数`)
  if (withTris && f.tris !== undefined && !(Number.isInteger(f.tris) && f.tris >= 0)) errors.push(`${path}.tris：须为非负整数`)
}

function checkBbox(b, path, errors) {
  if (!isObj(b) || !isVec3(b.min) || !isVec3(b.max)) { errors.push(`${path}：须为 {min:[3], max:[3]}`); return }
  for (let k = 0; k < 3; k++) if (b.min[k] > b.max[k]) { errors.push(`${path}：min[${k}] > max[${k}]`); break }
}

/** 质量特性校验（ModelMeta.massProps 与绑定表覆盖共用）。 */
function checkMassProps(mp, path, errors, warnings) {
  if (!isObj(mp)) { errors.push(`${path}：须为对象或 null`); return }
  if (!(isNum(mp.massKg) && mp.massKg > 0)) errors.push(`${path}.massKg：须为正数`)
  if (!isVec3(mp.comBody)) errors.push(`${path}.comBody：须为 [x,y,z]`)
  if (mp.inertiaBody !== null && mp.inertiaBody !== undefined) {
    const I = mp.inertiaBody
    if (!(Array.isArray(I) && I.length === 3 && I.every(isVec3))) errors.push(`${path}.inertiaBody：须为 3×3 数组或 null`)
    else {
      const asym = Math.max(Math.abs(I[0][1] - I[1][0]), Math.abs(I[0][2] - I[2][0]), Math.abs(I[1][2] - I[2][1]))
      const scale = Math.max(1e-12, Math.abs(I[0][0]), Math.abs(I[1][1]), Math.abs(I[2][2]))
      if (asym > 1e-9 * scale) errors.push(`${path}.inertiaBody：不对称`)
      if (!(I[0][0] >= 0 && I[1][1] >= 0 && I[2][2] >= 0)) errors.push(`${path}.inertiaBody：主对角须非负`)
      // 三角不等式：刚体惯量须满足 Ixx + Iyy ≥ Izz 等；不满足说明手填错了轴，但不拦（只警告）
      else if (I[0][0] + I[1][1] < I[2][2] * (1 - 1e-9) || I[1][1] + I[2][2] < I[0][0] * (1 - 1e-9) || I[0][0] + I[2][2] < I[1][1] * (1 - 1e-9)) {
        warnings.push(`${path}.inertiaBody：主对角不满足三角不等式`)
      }
    }
  }
  if (!MASS_SOURCES.includes(mp.source)) errors.push(`${path}.source：须为 ${MASS_SOURCES.join(' / ')}`)
  if (!CONFIDENCES.includes(mp.confidence)) errors.push(`${path}.confidence：须为 high / low`)
}

// 部件的反射面拟合结果（segment 产出）：validateMeta 判、normalizeMeta 删不合格的，两处同一口径
const fittedOk = (f) => isObj(f) && f.kind === 'paraboloid' && isNum(f.focalM) && f.focalM > 0 && isNum(f.diameterM) && f.diameterM > 0 &&
  isVec3(f.vertexBody) && isVec3(f.axisBody)
// 部件整条拷不了时逐个抢救的已知字段（validateMeta 查的那几项）
const PART_KNOWN_KEYS = ['role', 'nodes', 'triRange', 'triRanges', 'areaM2', 'normalBody', 'fitted', 'solarGroup', 'attachPoint']
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0
// 部件引用的太阳翼组名 / 挂点名（segment 反写在部件上的关联）：非空字符串、长度同名字上限
const refNameOk = (v) => isStr(v) && v.length > 0 && v.length <= LIM.name
// triRanges 条目上限：部件是本机派生数据（不进 manifest），大 CAD 件（ISS IGOAL 数千实例）一个部件跨上万实例是正常的，
// 不能套 LIM.list（4096）——套了 saveMeta 会拒收真实分割结果；只防病态输入把内存撑爆
const TRI_RANGES_MAX = 131072

/**
 * parts[].triRanges（segment.mjs 产出：实例内的部分三角形）= [{ node, mesh?, ranges: [[起始三角形, 个数], …] }]。
 * 为什么要查：部件高亮、LOD 件剔除、导出时按 triRanges 拆节点都按这里的数去切索引，一个负数 / 小数 / 缺节点名
 * 就是越界切片或静默切错；外来 JSON（用户导入、工作台 JSON 进出）不能直接信。
 * 返回问题清单（空 = 合格）；normTriRanges 按同一口径逐项丢坏的。
 */
function triRangesProblems(tr, path) {
  const out = []
  if (!Array.isArray(tr)) return [`${path}：须为数组`]
  if (tr.length > TRI_RANGES_MAX) out.push(`${path}：超过 ${TRI_RANGES_MAX} 项`)
  tr.forEach((e, i) => {
    const p = `${path}[${i}]`
    if (!isObj(e)) { out.push(`${p}：须为对象`); return }
    if (!isStr(e.node) || !e.node || e.node.length > LIM.name) out.push(`${p}.node：须为非空字符串`)
    if (e.mesh !== undefined && !isNonNegInt(e.mesh)) out.push(`${p}.mesh：须为非负整数`)
    if (!Array.isArray(e.ranges) || !e.ranges.length) out.push(`${p}.ranges：须为非空数组`)
    else e.ranges.forEach((r, k) => { if (!(Array.isArray(r) && r.length === 2 && r.every(isNonNegInt))) out.push(`${p}.ranges[${k}]：须为 [起始, 个数] 非负整数对`) })
  })
  return out
}
function normTriRanges(tr) {
  if (!Array.isArray(tr)) return []
  const out = []
  for (const e of tr) {
    if (out.length >= TRI_RANGES_MAX) break
    if (!isObj(e) || !isStr(e.node) || !e.node || e.node.length > LIM.name || !Array.isArray(e.ranges)) continue
    const ranges = e.ranges.filter((r) => Array.isArray(r) && r.length === 2 && r.every(isNonNegInt)).map((r) => [r[0], r[1]])
    if (!ranges.length) continue
    const o = { node: e.node, ranges }
    if (isNonNegInt(e.mesh)) o.mesh = e.mesh
    out.push(o)
  }
  return out
}

function checkQT(fr, path, errors) {
  if (!quatIsUnit(fr.q)) errors.push(`${path}.q：须为单位四元数 [x,y,z,w]`)
  if (!isVec3(fr.t)) errors.push(`${path}.t：须为 [x,y,z]`)
}

/**
 * 校验一条 ModelMeta。
 * @param {object} m
 * @param {object} [opts]
 * @param {boolean} [opts.slim]            manifest 精简条目：parts / attachPoints / articulations / solarPanelGroups /
 *                                         noObscurationNodes / massProps / spec / nodeNameMap 可以缺（有就照查）
 * @param {'auto'|'all'|'any'|'none'} [opts.lods]  files 档位要求；auto：nasa / community 三档齐全，param 不要求，其余至少一档
 * @param {string[]} [opts.nodeNames]      glb 的节点原名表：给了就查「唯一非空」并核对所有按名引用都存在
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateMeta(m, opts = {}) {
  const errors = [], warnings = []
  const o = isObj(opts) ? opts : {}
  if (!isObj(m)) return { ok: false, errors: ['ModelMeta 不是对象'], warnings }
  if (m.schema !== SCHEMA_VERSION) errors.push(`schema：须为 ${SCHEMA_VERSION}（得到 ${q(m.schema)}）`)

  // id 与来源
  const pid = parseModelId(m.id)
  if (!pid) errors.push(`id：格式不对 ${q(m.id)}`)
  const src = m.source
  if (!isObj(src)) errors.push('source：须为对象')
  else {
    if (!SOURCE_KINDS.includes(src.kind)) errors.push(`source.kind：非法值 ${q(src.kind)}`)
    if (typeof src.redistributable !== 'boolean') errors.push('source.redistributable：须为布尔')
    for (const k of ['url', 'credit', 'license']) {
      if (src[k] !== undefined && !isStr(src[k])) errors.push(`source.${k}：须为字符串`)
      else if (isStr(src[k]) && src[k].length > LIM[k]) errors.push(`source.${k}：超过 ${LIM[k]} 字`)
    }
    if (pid && SOURCE_KINDS.includes(src.kind) && !PREFIX_SOURCES[pid.prefix].includes(src.kind)) {
      errors.push(`source.kind：id 前缀 ${pid.prefix}: 与来源 ${src.kind} 不符`)
    }
    // STK 授权一致性（DESIGN §0-1）：两个方向都查
    const isStk = src.kind === 'stk-local' || (pid && pid.prefix === 'stk')
    if (isStk && src.redistributable !== false) errors.push('source.redistributable：STK 模型必须为 false（AGI SLA §2.3）')
    if (isStk && src.kind === 'stk-local' && src.license !== STK_LICENSE) warnings.push(`source.license：STK 模型应为 ${q(STK_LICENSE)}`)
  }

  // 标题与分类
  if (!isStr(m.title) || !m.title.trim()) errors.push('title：须为非空字符串')
  else if (m.title.length > LIM.title) errors.push(`title：超过 ${LIM.title} 字`)
  if (m.titleZh !== undefined && (!isStr(m.titleZh) || m.titleZh.length > LIM.title)) errors.push('titleZh：须为字符串（≤ 200 字）')
  if (!MODEL_KINDS.includes(m.kind)) errors.push(`kind：非法值 ${q(m.kind)}`)
  if (m.group !== undefined && !MODEL_GROUPS.includes(m.group)) errors.push(`group：非法值 ${q(m.group)}`)
  if (!FIDELITIES.includes(m.fidelity)) errors.push(`fidelity：非法值 ${q(m.fidelity)}`)

  // 文件
  const files = m.files
  if (!isObj(files)) errors.push('files：须为对象')
  else {
    for (const k of Object.keys(files)) {
      if (LOD_KEYS.includes(k)) checkFileEntry(files[k], `files.${k}`, errors, true)
      else if (k === 'thumb') checkFileEntry(files[k], 'files.thumb', errors, false)
      else warnings.push(`files.${k}：未知档位，会被丢弃`)
    }
    let need = o.lods || 'auto'
    if (need === 'auto') need = isObj(src) && (src.kind === 'nasa' || src.kind === 'community') ? 'all' : (isObj(src) && src.kind === 'param' ? 'none' : 'any')
    const have = LOD_KEYS.filter((k) => files[k] !== undefined)
    if (need === 'all' && have.length !== 3) errors.push(`files：三档 lod 须齐全（缺 ${LOD_KEYS.filter((k) => !have.includes(k)).join('、')}）`)
    if (need === 'any' && !have.length) errors.push('files：至少要有一档 lod')
  }

  // 单位
  const u = m.units
  if (!isObj(u)) errors.push('units：须为对象')
  else {
    if (!(isNum(u.scaleToMeters) && u.scaleToMeters > 0)) errors.push('units.scaleToMeters：须为正数')
    if (!UNIT_HINTS.includes(u.unitGuess)) errors.push(`units.unitGuess：非法值 ${q(u.unitGuess)}`)
    if (typeof u.sizeVerified !== 'boolean') errors.push('units.sizeVerified：须为布尔')
    // 任务书 §5.3：sizeVerified 只在有出处时为 true
    if (u.sizeVerified === true && !(isStr(u.sizeSource) && u.sizeSource.trim())) errors.push('units.sizeSource：sizeVerified 为 true 时须给出处')
    if (u.sizeSource !== undefined && u.sizeSource !== null && (!isStr(u.sizeSource) || u.sizeSource.length > LIM.url)) errors.push('units.sizeSource：须为字符串')
  }

  // 本体系
  const fr = m.frame
  if (!isObj(fr)) errors.push('frame：须为对象')
  else {
    if (!quatIsUnit(fr.q_model2body)) errors.push('frame.q_model2body：须为单位四元数 [x,y,z,w]')
    if (!isVec3(fr.t_model2body)) errors.push('frame.t_model2body：须为 [x,y,z]')
    if (typeof fr.verified !== 'boolean') errors.push('frame.verified：须为布尔')
    // importQ：入库时记下的「出厂映射」（工作台 factoryFrameQ ① 取它）。可缺；给了就得是单位四元数
    if (fr.importQ !== undefined && !quatIsUnit(fr.importQ)) errors.push('frame.importQ：须为单位四元数 [x,y,z,w]')
  }

  // 几何
  const g = m.geometry
  if (!isObj(g)) errors.push('geometry：须为对象')
  else {
    checkBbox(g.bboxM, 'geometry.bboxM', errors)
    if (!(isNum(g.boundingRadiusM) && g.boundingRadiusM >= 0)) errors.push('geometry.boundingRadiusM：须为非负数')
    if (!(Number.isInteger(g.tris) && g.tris >= 0)) errors.push('geometry.tris：须为非负整数')
    if (!(isNum(g.areaM2) && g.areaM2 >= 0)) errors.push('geometry.areaM2：须为非负数')
    if (!(g.volumeM3 === null || (isNum(g.volumeM3) && g.volumeM3 >= 0))) errors.push('geometry.volumeM3：须为非负数或 null')
    if (typeof g.closed !== 'boolean') errors.push('geometry.closed：须为布尔')
    if (!isVec3(g.centroidM)) errors.push('geometry.centroidM：须为 [x,y,z]')
  }

  // 大字段（slim 时可缺）
  const need = (k) => !o.slim || m[k] !== undefined
  if (need('parts')) {
    if (!Array.isArray(m.parts)) errors.push('parts：须为数组')
    else {
      const ids = new Set()
      m.parts.forEach((p, i) => {
        const path = `parts[${i}]`
        if (!isObj(p)) { errors.push(`${path}：不是对象`); return }
        if (!isStr(p.id) || !p.id) errors.push(`${path}.id：须为非空字符串`)
        else if (ids.has(p.id)) errors.push(`${path}.id：重复「${p.id}」`)
        ids.add(p.id)
        if (p.name !== undefined && !isStr(p.name)) errors.push(`${path}.name：须为字符串`)
        if (!PART_ROLES.includes(p.role)) errors.push(`${path}.role：非法值 ${q(p.role)}`)
        if (p.nodes !== undefined) checkStrList(p.nodes, `${path}.nodes`, errors)
        if (p.triRange !== undefined && !(Array.isArray(p.triRange) && p.triRange.length === 2 && p.triRange.every((v) => Number.isInteger(v) && v >= 0))) errors.push(`${path}.triRange：须为 [start, count] 非负整数`)
        if (p.triRanges !== undefined) errors.push(...triRangesProblems(p.triRanges, `${path}.triRanges`))
        if (p.nodes === undefined && p.triRange === undefined && p.triRanges === undefined) warnings.push(`${path}：既无 nodes 也无 triRange / triRanges`)
        for (const k of ['solarGroup', 'attachPoint']) if (p[k] !== undefined && !refNameOk(p[k])) errors.push(`${path}.${k}：须为非空字符串`)
        if (p.areaM2 !== undefined && !(isNum(p.areaM2) && p.areaM2 >= 0)) errors.push(`${path}.areaM2：须为非负数`)
        if (p.normalBody !== undefined && !isVec3(p.normalBody)) errors.push(`${path}.normalBody：须为 [x,y,z]`)
        if (p.fitted !== undefined && !fittedOk(p.fitted)) {
          errors.push(`${path}.fitted：须为 {kind:'paraboloid', focalM>0, diameterM>0, vertexBody:[3], axisBody:[3]}`)
        }
      })
    }
  }
  if (need('massProps') && m.massProps !== null) checkMassProps(m.massProps, 'massProps', errors, warnings)
  if (need('attachPoints')) {
    if (!Array.isArray(m.attachPoints)) errors.push('attachPoints：须为数组')
    else {
      const names = new Set()
      m.attachPoints.forEach((a, i) => {
        const path = `attachPoints[${i}]`
        if (!isObj(a)) { errors.push(`${path}：不是对象`); return }
        if (!isStr(a.name) || !a.name) errors.push(`${path}.name：须为非空字符串`)
        else if (names.has(a.name)) errors.push(`${path}.name：重复「${a.name}」`)
        names.add(a.name)
        if (a.node !== undefined && (!isStr(a.node) || !a.node)) errors.push(`${path}.node：须为非空字符串`)
        if (!isVec3(a.posBody)) errors.push(`${path}.posBody：须为 [x,y,z]`)
        let axesOk = true
        for (const k of ['dirBody', 'upBody']) {
          if (!isVec3(a[k])) { errors.push(`${path}.${k}：须为 [x,y,z]`); axesOk = false }
          else if (!(Math.hypot(...a[k]) > 1e-9)) { errors.push(`${path}.${k}：不能是零向量`); axesOk = false }
        }
        // 上向量与视轴平行就定不出挂点系的滚转（二期 D1：up ↔ 天线 +y），方向图 / 掩模都会随手算的兜底轴乱转
        if (axesOk && isUpDegenerate(a.dirBody, a.upBody)) errors.push(`${path}.upBody：与 dirBody 平行，定不出滚转`)
      })
    }
  }
  if (need('articulations')) {
    if (!Array.isArray(m.articulations)) errors.push('articulations：须为数组')
    else {
      const names = new Set()
      m.articulations.forEach((a, i) => {
        const path = `articulations[${i}]`
        if (!isObj(a)) { errors.push(`${path}：不是对象`); return }
        // 互操作：STK 不认带空白的关节名 / stage 名（AGI_articulations schema pattern）
        if (!agiNameOk(a.name)) errors.push(`${path}.name：须非空且不含空白（STK 规则）`)
        else if (names.has(a.name)) errors.push(`${path}.name：重复「${a.name}」`)
        names.add(a.name)
        checkStrList(a.nodes, `${path}.nodes`, errors)
        if (!Array.isArray(a.stages) || !a.stages.length) errors.push(`${path}.stages：须为非空数组`)
        else {
          const sn = new Set()
          a.stages.forEach((s, k) => {
            const sp = `${path}.stages[${k}]`
            if (!isObj(s)) { errors.push(`${sp}：不是对象`); return }
            if (!agiNameOk(s.name)) errors.push(`${sp}.name：须非空且不含空白`)
            else if (sn.has(s.name)) errors.push(`${sp}.name：重复「${s.name}」`)
            sn.add(s.name)
            if (!STAGE_TYPES.includes(s.type)) errors.push(`${sp}.type：非法值 ${q(s.type)}`)
            const nums = ['minimumValue', 'maximumValue', 'initialValue'].every((key) => isNum(s[key]))
            if (!nums) errors.push(`${sp}：minimumValue / maximumValue / initialValue 须为有限数`)
            else {
              if (s.minimumValue > s.maximumValue) errors.push(`${sp}：minimumValue > maximumValue`)
              else if (s.initialValue < s.minimumValue || s.initialValue > s.maximumValue) warnings.push(`${sp}：initialValue 不在范围内`)
            }
          })
        }
        if (a.pointingVector !== undefined && !(isVec3(a.pointingVector) && Math.hypot(...a.pointingVector) > 1e-9)) errors.push(`${path}.pointingVector：须为非零 [x,y,z]`)
      })
    }
  }
  if (need('solarPanelGroups')) {
    if (!Array.isArray(m.solarPanelGroups)) errors.push('solarPanelGroups：须为数组')
    else {
      const names = new Set()
      m.solarPanelGroups.forEach((s, i) => {
        const path = `solarPanelGroups[${i}]`
        if (!isObj(s)) { errors.push(`${path}：不是对象`); return }
        if (!agiNameOk(s.name)) errors.push(`${path}.name：须非空且不含空白（STK 规则）`)
        else if (names.has(s.name)) errors.push(`${path}.name：重复「${s.name}」`)
        names.add(s.name)
        checkStrList(s.nodes, `${path}.nodes`, errors)
        if (!(isNum(s.efficiency) && s.efficiency >= 0 && s.efficiency <= 100)) errors.push(`${path}.efficiency：须在 0–100（百分数）`)
      })
    }
  }
  if (need('noObscurationNodes')) checkStrList(m.noObscurationNodes, 'noObscurationNodes', errors)
  // 部件上的关联名（segment 反写的 solarGroup / attachPoint）指向不存在的组 / 挂点：能用（只是高亮联动断了），只警告
  if (Array.isArray(m.parts)) {
    const grp = new Set((Array.isArray(m.solarPanelGroups) ? m.solarPanelGroups : []).filter(isObj).map((s) => s.name))
    const aps = new Set((Array.isArray(m.attachPoints) ? m.attachPoints : []).filter(isObj).map((a) => a.name))
    m.parts.forEach((p, i) => {
      if (!isObj(p)) return
      if (refNameOk(p.solarGroup) && !grp.has(p.solarGroup)) warnings.push(`parts[${i}].solarGroup：太阳翼组「${p.solarGroup}」不存在`)
      if (refNameOk(p.attachPoint) && !aps.has(p.attachPoint)) warnings.push(`parts[${i}].attachPoint：挂点「${p.attachPoint}」不存在`)
    })
  }
  if (m.nodeNameMap !== undefined) {
    if (!isObj(m.nodeNameMap)) errors.push('nodeNameMap：须为对象')
    else for (const [k, v] of Object.entries(m.nodeNameMap)) if (!k || !isStr(v)) { errors.push(`nodeNameMap：「${k}」的原名须为字符串`); break }
  }
  if (m.spec !== undefined && !isObj(m.spec)) errors.push('spec：须为对象')
  // 装配件（DESIGN3 E1/E4）：asm: ⇔ spec 是装配文档。两个方向都查——param: 带装配文档会被 buildParamModel 当整星 spec
  // 静默生成成一个点（assembly-ux §6-2）；asm: 缺装配文档则工作台 / 3D 页无从重建。ent:（实体模板的运行时预览）带的也是装配文档，放行。
  // 装配文档本身的合法性归 assembly.validateAssembly（schema 不 import assembly.mjs：防环、主进程不加载组件库）
  const asmSpec = isAssemblySpec(m.spec)
  if (pid && pid.prefix === 'asm' && need('spec') && !asmSpec) errors.push('spec：装配件须带装配文档（kind = assembly）')
  if (asmSpec && pid && pid.prefix !== 'asm' && pid.prefix !== 'ent') errors.push('spec：装配文档只能配 asm: id')
  if (asmSpec && Object.hasOwn(ASM_DOMAIN_KINDS, m.spec.domain) && m.kind !== ASM_DOMAIN_KINDS[m.spec.domain]) {
    warnings.push(`kind：装配领域 ${m.spec.domain} 应为 ${ASM_DOMAIN_KINDS[m.spec.domain]}（得到 ${q(m.kind)}）`)
  }
  checkStrList(Array.isArray(m.tags) ? m.tags : (m.tags === undefined ? [] : m.tags), 'tags', errors, { max: LIM.tags, itemMax: LIM.tag })
  checkStrList(Array.isArray(m.aliases) ? m.aliases : (m.aliases === undefined ? [] : m.aliases), 'aliases', errors, { max: LIM.aliases, itemMax: LIM.alias })
  if (!(m.updatedAt === null || m.updatedAt === undefined || (isStr(m.updatedAt) && isoOrNull(m.updatedAt) !== null))) errors.push('updatedAt：须为 ISO 时间串或 null')

  // 节点名：唯一非空（互操作硬要求）+ 按名引用都要存在
  if (Array.isArray(o.nodeNames)) {
    const seen = new Map()
    o.nodeNames.forEach((n, i) => {
      if (!isStr(n) || !n) errors.push(`节点 #${i}：名字为空（gmdf / AGI 按名引用，须唯一非空）`)
      else if (seen.has(n)) errors.push(`节点 #${i}：与 #${seen.get(n)} 重名「${n}」`)
      else seen.set(n, i)
    })
    const refs = []
    if (Array.isArray(m.parts)) m.parts.forEach((p) => {
      if (!isObj(p)) return
      if (Array.isArray(p.nodes)) refs.push(...p.nodes.map((n) => ['parts', n]))
      if (Array.isArray(p.triRanges)) for (const e of p.triRanges) if (isObj(e) && isStr(e.node) && e.node) refs.push(['parts.triRanges', e.node])
    })
    if (Array.isArray(m.attachPoints)) m.attachPoints.forEach((a) => { if (isObj(a) && isStr(a.node)) refs.push(['attachPoints', a.node]) })
    if (Array.isArray(m.articulations)) m.articulations.forEach((a) => { if (isObj(a) && Array.isArray(a.nodes)) refs.push(...a.nodes.map((n) => ['articulations', n])) })
    if (Array.isArray(m.solarPanelGroups)) m.solarPanelGroups.forEach((s) => { if (isObj(s) && Array.isArray(s.nodes)) refs.push(...s.nodes.map((n) => ['solarPanelGroups', n])) })
    if (Array.isArray(m.noObscurationNodes)) refs.push(...m.noObscurationNodes.map((n) => ['noObscurationNodes', n]))
    const missing = new Set()
    for (const [where, n] of refs) if (!seen.has(n) && !missing.has(`${where}:${n}`)) { missing.add(`${where}:${n}`); errors.push(`${where}：引用的节点「${n}」不存在`) }
  }
  return { ok: errors.length === 0, errors, warnings }
}

// ─────────────────────────────── 归一 ───────────────────────────────

const str = (v, max, d = '') => (isStr(v) ? v.slice(0, max) : d)
const vec3 = (v, d) => (isVec3(v) ? v.slice() : d.slice())
const strList = (v, max, itemMax) => {
  if (!Array.isArray(v)) return []
  const out = []
  for (const s of v) {
    if (out.length >= max) break
    if (isStr(s) && s && s.length <= itemMax && !out.includes(s)) out.push(s)
  }
  return out
}
const fileEntry = (f, withTris) => {
  if (!isObj(f)) return null
  const sha = isStr(f.sha256) ? f.sha256.toLowerCase() : ''
  if (!SHA256_RE.test(sha) || !(Number.isInteger(f.bytes) && f.bytes > 0)) return null
  const o = { sha256: sha, bytes: f.bytes }
  if (withTris && Number.isInteger(f.tris) && f.tris >= 0) o.tris = f.tris
  return o
}

function normMassProps(mp) {
  if (!isObj(mp) || !(isNum(mp.massKg) && mp.massKg > 0) || !isVec3(mp.comBody)) return null
  let I = null
  if (Array.isArray(mp.inertiaBody) && mp.inertiaBody.length === 3 && mp.inertiaBody.every(isVec3)) {
    const A = mp.inertiaBody
    // 对称化：手填的非对角两侧常差最后一位
    I = [0, 1, 2].map((r) => [0, 1, 2].map((c) => (r === c ? A[r][c] : (A[r][c] + A[c][r]) / 2)))
  }
  return {
    massKg: mp.massKg,
    comBody: mp.comBody.slice(),
    inertiaBody: I,
    source: MASS_SOURCES.includes(mp.source) ? mp.source : 'manual',
    // 惯量缺失的估算只能是 low（任务书 §4.3：不闭合网格退回表面质心、惯量不算）
    confidence: CONFIDENCES.includes(mp.confidence) ? (I || mp.source !== 'estimate' ? mp.confidence : 'low') : 'low'
  }
}

function normStage(s) {
  if (!isObj(s) || !agiNameOk(s.name) || !STAGE_TYPES.includes(s.type)) return null
  if (!['minimumValue', 'maximumValue', 'initialValue'].every((k) => isNum(s[k]))) return null
  let lo = s.minimumValue, hi = s.maximumValue
  if (lo > hi) [lo, hi] = [hi, lo]
  return { name: s.name, type: s.type, minimumValue: lo, maximumValue: hi, initialValue: s.initialValue }
}

// 条目的 source.kind（normalizeMeta 与 importDefaultQOf 同一口径）：认得的原样用；缺了按 id 前缀补；stk: 前缀一律 stk-local；都不行按 user
function sourceKindOf(s, pid) {
  const src0 = isObj(s.source) ? s.source : {}
  let kind = SOURCE_KINDS.includes(src0.kind) ? src0.kind : null
  if (!kind && pid) kind = { nasa: 'nasa', param: 'param', user: 'user', stk: 'stk-local', community: 'community', asm: 'user', ent: 'builtin' }[pid.prefix]
  // stk: 前缀却标了别的来源 → 一律按 STK 处理（宁可错拦，不可错放）
  if (pid && pid.prefix === 'stk') kind = 'stk-local'
  return kind || 'user'
}

/**
 * 这条元数据按类别 / 来源的导入缺省 q_model2body（轴映射终案 ②、DESIGN3 E5，bodyFrame.defaultImportQ），不看 meta.frame 里现有的 q。
 * normalizeMeta 缺 q 时的兜底就是它；工作台「本体轴 · 出厂映射」要回到「这件东西刚导入时的朝向」也该用它，而不是
 * 一律 DEFAULT_Q_MODEL2BODY（STK 映射）——否则未核的 NASA 件 / 用户普通件一点就绕本体 X 翻 180°（天线朝天）。
 *   类别优先（E5）：飞机 / 船 / 车 / 地球站（bodyFrame.ENTITY_KINDS）一律 +Y 天顶，来源 / AGI 不论（STK Air / Sea / Land 件实测同此）；
 *   builtin 只说「随包」：按 id 前缀还原成 nasa / param 再判；
 *   「带 AGI」按 AGI 那几样（关节 / 电池片组 / 不遮挡节点 / 挂点）非空算，与 3D 页 bodyDimsOf 的兜底同口径；
 *   extras.satsim.frame 自带的 q 不进 meta，这里取不到（导入时已经写成 frame.q_model2body 了；入库时另记在 frame.importQ）。
 * 坏输入不抛：非对象按 user 来源 → +Y 天顶。返回新数组。
 * @param {object} m ModelMeta（归一前后都行）
 * @returns {number[]} [x,y,z,w]
 */
export function importDefaultQOf(m) {
  const s = isObj(m) ? m : {}
  const pid = parseModelId(s.id)
  const kind = sourceKindOf(s, pid)
  return defaultImportQ({
    sourceKind: kind === 'builtin' && pid ? ({ nasa: 'nasa', param: 'param' }[pid.prefix] || kind) : kind,
    hasAgi: ['articulations', 'solarPanelGroups', 'noObscurationNodes', 'attachPoints'].some((k) => Array.isArray(s[k]) && s[k].length > 0),
    satsimFrame: null,
    kind: s.kind
  })
}

/**
 * 归一：补默认、裁非法值、按白名单丢未知键。永远返回完整 ModelMeta，不抛。
 * 注意 id 非法时保留原串（不擅自改 id，改了会和文件名 / 绑定表对不上），由 validateMeta 报错。
 */
export function normalizeMeta(m) {
  const s = isObj(m) ? m : {}
  const pid = parseModelId(s.id)
  const src0 = isObj(s.source) ? s.source : {}
  const kind = sourceKindOf(s, pid)
  const dsrc = defaultSource(kind)
  const source = {
    kind,
    url: str(src0.url, LIM.url, dsrc.url),
    credit: str(src0.credit, LIM.credit, dsrc.credit),
    license: str(src0.license, LIM.license, dsrc.license),
    redistributable: typeof src0.redistributable === 'boolean' ? src0.redistributable : dsrc.redistributable
  }
  if (kind === 'stk-local') { source.redistributable = false; source.license = STK_LICENSE }

  const files = {}
  if (isObj(s.files)) {
    for (const k of LOD_KEYS) { const f = fileEntry(s.files[k], true); if (f) files[k] = f }
    const t = fileEntry(s.files.thumb, false); if (t) files.thumb = t
  }

  const u = isObj(s.units) ? s.units : {}
  const units = {
    scaleToMeters: isNum(u.scaleToMeters) && u.scaleToMeters > 0 ? u.scaleToMeters : 1,
    unitGuess: UNIT_HINTS.includes(u.unitGuess) ? u.unitGuess : 'unknown',
    sizeVerified: false
  }
  if (isStr(u.sizeSource) && u.sizeSource.trim()) units.sizeSource = u.sizeSource.slice(0, LIM.url)
  units.sizeVerified = u.sizeVerified === true && !!units.sizeSource

  const f = isObj(s.frame) ? s.frame : {}
  // 近似单位长的四元数（JSON 截断过位数）重新归一；离得远的说明不是四元数，回缺省
  let qm = null
  if (Array.isArray(f.q_model2body) && f.q_model2body.length === 4 && f.q_model2body.every(isNum)) {
    const n = Math.hypot(...f.q_model2body)
    if (n > 0.9 && n < 1.1) qm = quatStable(f.q_model2body)
  }
  const frame = {
    // 缺省按来源（轴映射终案 ②，importDefaultQOf → bodyFrame.defaultImportQ）：STK / 参数化 / 带 AGI 扩展 → STK 映射；
    // NASA、用户导入的普通件 → +Y 天顶。有 q 的条目（管线、工作台、导出件写出的都有）走不到这里。
    q_model2body: qm || importDefaultQOf(s),
    t_model2body: vec3(f.t_model2body, [0, 0, 0]),
    verified: f.verified === true && !!qm
  }
  // importQ（入库时的出厂映射，可缺）：与 q_model2body 同一道模长门（0.9–1.1）后符号规范化；不像四元数的整键省略（不补缺省——
  // 缺了由工作台 factoryFrameQ 按类别 / 来源 / 当前 q 另推，补一个猜的值反而把「文件自带标定」这条信息抹掉）
  if (Array.isArray(f.importQ) && f.importQ.length === 4 && f.importQ.every(isNum)) {
    const n = Math.hypot(...f.importQ)
    if (n > 0.9 && n < 1.1) frame.importQ = quatStable(f.importQ)
  }

  const g = isObj(s.geometry) ? s.geometry : {}
  const zg = zeroGeometry()
  let bboxM = zg.bboxM
  if (isObj(g.bboxM) && isVec3(g.bboxM.min) && isVec3(g.bboxM.max)) {
    bboxM = { min: g.bboxM.min.map((v, k) => Math.min(v, g.bboxM.max[k])), max: g.bboxM.max.map((v, k) => Math.max(v, g.bboxM.min[k])) }
  }
  const geometry = {
    bboxM,
    boundingRadiusM: isNum(g.boundingRadiusM) && g.boundingRadiusM >= 0 ? g.boundingRadiusM : 0,
    tris: Number.isInteger(g.tris) && g.tris >= 0 ? g.tris : 0,
    areaM2: isNum(g.areaM2) && g.areaM2 >= 0 ? g.areaM2 : 0,
    volumeM3: isNum(g.volumeM3) && g.volumeM3 >= 0 ? g.volumeM3 : null,
    closed: g.closed === true,
    centroidM: vec3(g.centroidM, [0, 0, 0])
  }

  const parts = []
  if (Array.isArray(s.parts)) {
    const ids = new Set()
    for (const p of s.parts) {
      if (!isObj(p) || !isStr(p.id) || !p.id || ids.has(p.id)) continue
      ids.add(p.id)
      // 部件是本机派生数据（segment 产出，manifest 精简版不带），保留未知键以便 W2 扩字段；只丢非纯数据。
      // 整条拷不了（某个未知键里有 BigInt / 循环引用）时退回只拷已知字段，逐个能拷的留下——部件的主体信息不因一个坏键丢掉
      let o = plain(p)
      if (!isObj(o)) {
        o = { id: p.id }
        for (const k of PART_KNOWN_KEYS) { const c = plain(p[k]); if (c !== undefined) o[k] = c }
      } else dropReserved(p, o)
      o.name = str(p.name, LIM.name, p.id)
      o.role = PART_ROLES.includes(p.role) ? p.role : 'other'
      if (p.nodes !== undefined) o.nodes = strList(p.nodes, LIM.list, LIM.name)
      if (p.triRange !== undefined && !(Array.isArray(p.triRange) && p.triRange.length === 2 && p.triRange.every((v) => Number.isInteger(v) && v >= 0))) delete o.triRange
      if (p.normalBody !== undefined && !isVec3(p.normalBody)) delete o.normalBody
      if (p.areaM2 !== undefined && !(isNum(p.areaM2) && p.areaM2 >= 0)) delete o.areaM2
      if (o.fitted !== undefined && !fittedOk(o.fitted)) delete o.fitted
      // triRanges：逐项丢坏的（坏节点名 / 坏区间），丢空了就删键；关联名不是非空字符串就删
      if (o.triRanges !== undefined) { const tr = normTriRanges(o.triRanges); if (tr.length) o.triRanges = tr; else delete o.triRanges }
      for (const k of ['solarGroup', 'attachPoint']) if (o[k] !== undefined && !refNameOk(o[k])) delete o[k]
      parts.push(o)
    }
  }

  const attachPoints = []
  if (Array.isArray(s.attachPoints)) {
    const names = new Set()
    for (const a of s.attachPoints) {
      if (!isObj(a) || !isStr(a.name) || !a.name || names.has(a.name)) continue
      if (!isVec3(a.posBody)) continue
      names.add(a.name)
      // 缺视轴时兜底朝本体 +Z（天底）——对地通信天线最常见的安装朝向。
      // 上向量缺省 / 零长 / 与视轴平行时按二期契约 D1 补：本体 −Y 在视轴法平面的投影（对地挂点即 [0,−1,0]，GEO 顺行为北），
      // 退化再取 +X。给出的上向量只要不退化就原样保留（与视轴不正交也留：挂点系按投影取 y，保留用户原值便于再编辑）
      const dir = isVec3(a.dirBody) && Math.hypot(...a.dirBody) > 1e-9 ? a.dirBody.slice() : [0, 0, 1]
      const up = isVec3(a.upBody) && !isUpDegenerate(dir, a.upBody) ? a.upBody.slice() : defaultUpBody(dir)
      const o = { name: a.name.slice(0, LIM.name), posBody: a.posBody.slice(), dirBody: dir, upBody: up }
      if (isStr(a.node) && a.node) o.node = a.node
      attachPoints.push(o)
    }
  }

  const articulations = []
  if (Array.isArray(s.articulations)) {
    const names = new Set()
    for (const a of s.articulations) {
      if (!isObj(a) || !agiNameOk(a.name) || names.has(a.name)) continue
      const sn = new Set()
      const stages = (Array.isArray(a.stages) ? a.stages : []).map(normStage).filter((st) => st && !sn.has(st.name) && sn.add(st.name))
      if (!stages.length) continue
      names.add(a.name)
      const o = { name: a.name, nodes: strList(a.nodes, LIM.list, LIM.name), stages }
      if (isVec3(a.pointingVector) && Math.hypot(...a.pointingVector) > 1e-9) o.pointingVector = a.pointingVector.slice()
      articulations.push(o)
    }
  }

  const solarPanelGroups = []
  if (Array.isArray(s.solarPanelGroups)) {
    const names = new Set()
    for (const g2 of s.solarPanelGroups) {
      if (!isObj(g2) || !agiNameOk(g2.name) || names.has(g2.name) || !isNum(g2.efficiency)) continue
      names.add(g2.name)
      solarPanelGroups.push({ name: g2.name, nodes: strList(g2.nodes, LIM.list, LIM.name), efficiency: Math.min(100, Math.max(0, g2.efficiency)) })
    }
  }

  const out = {
    schema: SCHEMA_VERSION,
    id: isStr(s.id) ? s.id : '',
    title: str(s.title, LIM.title).trim() || (isStr(s.id) ? s.id : '未命名模型'),
    titleZh: str(s.titleZh, LIM.title),
    kind: MODEL_KINDS.includes(s.kind) ? s.kind : (s.kind === undefined ? 'spacecraft' : 'other'),
    fidelity: FIDELITIES.includes(s.fidelity) ? s.fidelity : (kind === 'param' ? 'parametric' : 'outreach'),
    source,
    files,
    units,
    frame,
    geometry,
    parts,
    massProps: normMassProps(s.massProps),
    attachPoints,
    articulations,
    solarPanelGroups,
    noObscurationNodes: strList(s.noObscurationNodes, LIM.list, LIM.name),
    tags: strList(s.tags, LIM.tags, LIM.tag),
    aliases: strList(s.aliases, LIM.aliases, LIM.alias),
    updatedAt: isoOrNull(s.updatedAt)
  }
  if (MODEL_GROUPS.includes(s.group)) out.group = s.group
  if (isObj(s.spec)) { const sp = plain(s.spec); if (isObj(sp)) out.spec = dropReserved(s.spec, sp) }
  if (isObj(s.nodeNameMap)) {
    const nm = {}
    for (const [k, v] of Object.entries(s.nodeNameMap)) if (k && isStr(v)) nm[k] = v
    if (Object.keys(nm).length) out.nodeNameMap = nm
  }
  return out
}

/**
 * manifest 精简条目（契约 §3.3）：只留列表 / 下载 / 匹配要用的字段，去掉 parts / attachPoints 等大字段。
 * 输入先 normalize；builtin（随包档位表）若有则保留。
 */
export function slimMeta(m) {
  const n = normalizeMeta(m)
  const out = {
    schema: n.schema, id: n.id, title: n.title, titleZh: n.titleZh, kind: n.kind, fidelity: n.fidelity,
    source: n.source, files: n.files, units: n.units, frame: n.frame, geometry: n.geometry,
    tags: n.tags, aliases: n.aliases, updatedAt: n.updatedAt
  }
  if (n.group) out.group = n.group
  if (isObj(m) && Array.isArray(m.builtin)) {
    const b = m.builtin.filter((k) => LOD_KEYS.includes(k) || k === 'thumb')
    if (b.length) out.builtin = [...new Set(b)]
  }
  return out
}

/**
 * spec 是否装配文档（DESIGN3 E1：spec.kind === 'assembly'）。只看这一个判别键，文档本身合不合法归 assembly.validateAssembly。
 */
export function isAssemblySpec(spec) {
  return isObj(spec) && spec.kind === 'assembly'
}

/** asmModelRefs 的哨兵：一个查不到的 id（授权闸遇到它整件拒收）。 */
export const ASM_REF_UNRESOLVED = '\u0000'
/**
 * 装配文档引用的库模型 id（去重、按首次出现排序）。授权闸（DESIGN3 E4）的数据基础：主进程 saveImported 对每个引用查目录，
 * 查不到或不可分发就整件拒收。★ 失败即关（fail-closed）——拿不准的一律报成查不到的哨兵 ASM_REF_UNRESOLVED：
 *   · 任何组件 params 里（含嵌套数组 / 对象，深 4 层）凡是合法模型 id 的字符串都算引用（不论键名：modelId / model / ref …）；
 *   · params.modelId 给了但不是非空字符串（数组 / 对象 / 空串）→ 哨兵；
 *   · type === 'model'（库中模型作组件，P4）却拿不到非空字符串 modelId → 哨兵。
 * 纯函数，不抛；非对象 / comps 不是数组 → []。
 * @param {object} spec
 * @returns {string[]}
 */
export function asmModelRefs(spec) {
  if (!isObj(spec) || !Array.isArray(spec.comps)) return []
  const out = []
  const add = (id) => { if (!out.includes(id)) out.push(id) }
  const scan = (v, depth) => {
    if (isStr(v)) { if (v.includes(':') && parseModelId(v)) add(v); return }
    if (depth <= 0 || v === null || typeof v !== 'object') return
    for (const x of Array.isArray(v) ? v : Object.values(v)) scan(x, depth - 1)
  }
  for (const c of spec.comps) {
    if (!isObj(c)) continue
    const p = isObj(c.params) ? c.params : null
    const has = !!p && Object.hasOwn(p, 'modelId')
    if (has && !(isStr(p.modelId) && p.modelId)) add(ASM_REF_UNRESOLVED)
    else if (c.type === 'model' && !has) add(ASM_REF_UNRESOLVED)
    if (p) scan(p, 4)
  }
  return out
}

/**
 * 能否离开本机（云端发布 / 分享包 / 报告附件 / 导出 glb 四道闸共用）。
 * 只认 redistributable === true，且不是 STK 来源（两种判据任一命中都拒）。
 */
export function isRedistributable(m) {
  if (!isObj(m) || !isObj(m.source)) return false
  if (m.source.kind === 'stk-local') return false
  const pid = parseModelId(m.id)
  if (pid && pid.prefix === 'stk') return false
  return m.source.redistributable === true
}

// ─────────────────────────────── 绑定表（契约 §3.4、T10） ───────────────────────────────

// geoDefault 出厂 = 默认卫星（paramTemplates.DEFAULT_MODEL_ID，与 autoMatch 的 GEO 缺省同一个值）。
// 老绑定表里存的旧模板 id（paramTemplates 的 LEGACY_TEMPLATE_IDS）由 validateBindings 经 resolveParamModelId 静默升级，
// 否则模型库按 === 比对找不到「GEO 默认」那一条（星标不亮、「设为 GEO 默认」一直可点）。
export const DEFAULT_PREFS = Object.freeze({ geoDefault: DEFAULT_MODEL_ID, showModels: true })
// 合成 NORAD 号段（800000+ 星历点序列、900000+ 自定义星座、990000+ 年历查不到的 PRN）不是稳定身份
export const SATKEY_NORAD_MAX = 800000
const SATKEY_MAX_LEN = 256

/**
 * 卫星记录 → 绑定键（T10）。优先级：
 *   ① entry._ephGroup      → ephem:<组id>:<key>（key 缺省用 name）——星历点序列星，合成 NORAD 不稳，用组 + key
 *   ② group 以 'cc_' 开头   → cc:<cfgId>:<name>——自定义星座合成星
 *   ③ NORAD 为 1..799999    → norad:<id>——目录星与 gp 自定义星（前导零去掉，'00025544' 与 25544 同键）
 *   ④ 否则有名字            → name:<name>
 *   都没有返回 null。name / key 去首尾空白（OMM 里常见尾随空格，不去会让同一颗星两个键）。
 */
export function satKeyOf(entry) {
  if (!isObj(entry)) return null
  const t = (v) => (v === null || v === undefined ? '' : String(v).trim())
  const name = t(entry.name)
  const gid = t(entry._ephGroup)
  if (gid) {
    const key = t(entry.key) || name
    return key ? cut(`ephem:${gid}:${key}`) : null
  }
  const group = isStr(entry.group) ? entry.group : ''
  if (group.startsWith('cc_') && group.length > 3 && name) return cut(`cc:${group.slice(3)}:${name}`)
  const raw = t(entry.noradId)
  if (/^\d{1,9}$/.test(raw)) {
    const n = Number(raw)
    if (n >= 1 && n < SATKEY_NORAD_MAX) return `norad:${n}`
  }
  return name ? cut(`name:${name}`) : null
}
const cut = (s) => (s.length > SATKEY_MAX_LEN ? null : s)
const trimKey = (v) => (v === null || v === undefined ? '' : String(v).trim())

/**
 * GRD 卫星树里没有目录身份的星（orbit / custom / preset）→ grdsat:<folder>（二期契约 D8）。
 * folder 是树内唯一且不可变的键（useGrdCoverage genFolder），改星名不动它；不用 name: 是因为会撞名、星名还能改。
 */
export function grdSatKey(folder) {
  const f = trimKey(folder)
  return f ? cut(`grdsat:${f}`) : null
}

/**
 * 链路预算四窗卫星库条目 → lbsat:<ns>:<satCfgId>（二期契约 D8）。ns 是窗口命名空间，不带就会出现四个窗口的 sat3 撞键。
 * ns 不许含冒号或空白（键靠第一个冒号后的那段分窗口）；satCfgId 去首尾空白后非空。
 */
export function lbSatKey(ns, satCfgId) {
  const n = trimKey(ns), id = trimKey(satCfgId)
  return n && id && /^[^:\s]+$/.test(n) ? cut(`lbsat:${n}:${id}`) : null
}

/**
 * 绑定键格式检查（与 satKeyOf / grdSatKey / lbSatKey 的产出一致）。
 * lbsat 只收带命名空间的 lbsat:<ns>:<id>：一期契约 T10 里的 lbsat:<id> 从没有代码写过，D8 改为带 ns 以免四窗撞键。
 */
export function isValidSatKey(k) {
  if (!isStr(k) || !k || k.length > SATKEY_MAX_LEN) return false
  let m = /^norad:([1-9]\d{0,5})$/.exec(k)
  if (m) return Number(m[1]) < SATKEY_NORAD_MAX
  return /^(?:ephem|cc):[^:\s][^:]*:\S(?:.*\S)?$/.test(k) || /^lbsat:[^:\s]+:\S(?:.*\S)?$/.test(k) || /^(?:grdsat|name):\S(?:.*\S)?$/.test(k)
}

// ─────────────────────────────── 挂点（mount）与姿态律（二期契约 D1 / D8 / D10 / D18、任务书 §4.2） ───────────────────────────────
//
// mount = 卫星记录上的「天线安装位」：引用模型的 attach point（几何来源，可空）+ 本体系位姿 + 视场 + 万向节 + 天线引用 + 本体遮挡掩模签名。
//   { id, name, attachPoint: <挂点名>|null, posBody:[3], boresightBody:[3], upBody:[3], fovDeg?, sysTempK,
//     gimbal: { type: 'none'|'azel'|'xy', limits: { a1Min, a1Max, a2Min, a2Max }, rateDegS? },
//     antennaRef: { kind: 'grd', id } | { kind: 'lbAntenna', id } | { kind: 'param', spec } | null,
//     excludeNodes: [节点名], maskSig? }
// 口径（改之前先看调用方：工作台卫星页、3D 页跟随 HUD、GRD「姿态 + 挂点」、掩模 Worker、可见性 / ISL / 对星表、报告）：
//   · 本体系：+X 速度、+Y 补全、+Z 天底（bodyFrame.mjs）。posBody 米；boresightBody / upBody 存单位向量，upBody 与视轴正交
//     （挂点系 z = 视轴、y = up、x = y × z，D1「up ↔ 天线 +y」）。上向缺省 = bodyFrame.defaultUpBody（本体 −Y 的投影，退化取 +X）；
//     对地挂点即 [0,−1,0]，「姿态 + 挂点」在赤道 GEO 与手动天底档逐位相等。
//   · fovDeg：视场全锥角（度，(0, 360]）；缺省不写 = 按方向图 −3 dB（由消费端算）。
//   · sysTempK：星上接收系统噪声温度（K，D10），缺省 500；星侧太阳侵入 ΔG/T = 10·lg(1 + ΔT / T_sys)。
//   · gimbal.limits：两轴限位（度）。a1 / a2 的几何含义由 gimbal.mjs 定（azel：a1 方位、a2 俯仰；xy：a1 绕 X、a2 绕 Y）；
//     缺省为全程 a1 ∈ [−180, 180]、a2 ∈ [−90, 90]（即不限位）。type = 'none' 时限位照存不用（切换档位不丢用户填的数）。
//   · antennaRef：grd 的 id = GRD 树天线键 `folder|name`；lbAntenna 的 id = 链路预算卫星库条目键；param 的 spec = 参数化口径
//     （diameterM / freqGHz / efficiency 0–1 / gainDbi / hpbwDeg / pattern，缺的由消费端推）。不许出现第二套天线概念（任务书 §4.2）。
//   · maskSig：本体遮挡掩模文件签名（D18：userData/models/masks/<sig>.bin）。主进程拿它拼路径，所以只收小写十六进制
//     （不含路径分隔符与点；Windows 文件名不分大小写，大小写混排的签名会两个撞一个文件）。
//   · 未知键：纯数据照留（并行开发中的二期消费端会往 mount 上加自己的选项，如掩模关节状态）；拷不了的丢。
// 归一原则同本文件其余部分：坏值丢弃（或回缺省）并记错误，不抛；结果可直接落盘 / 过 IPC。缺 posBody 的 mount 整条丢（无从安放）。

export const GIMBAL_TYPES = Object.freeze(['none', 'azel', 'xy'])
export const ANTENNA_REF_KINDS = Object.freeze(['grd', 'lbAntenna', 'param'])
/** 本体轴的字符串写法（姿态律参数里「用哪根本体轴指目标」用）；也可直接给非零 [x,y,z]。 */
export const BODY_AXES = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z'])
/** 星上接收系统噪声温度缺省（K，二期契约 D10）。 */
export const DEFAULT_SYS_TEMP_K = 500
/** 万向节缺省限位（度）：全程，即不限位。 */
export const DEFAULT_GIMBAL_LIMITS = Object.freeze({ a1Min: -180, a1Max: 180, a2Min: -90, a2Max: 90 })
/** 掩模签名：小写十六进制 16–128 位（D18 文件名安全，见上）。 */
export const MASK_SIG_RE = /^[0-9a-f]{16,128}$/
// 每张绑定的 mount 数上限（外来 JSON 防撑爆；真实卫星天线十几副）
const MOUNTS_MAX = 64
const MOUNT_ID_MAX = 64
// 万向节限位 / 角速率的合法区间：限位 ±360°（多圈没有意义）；角速率 (0, 1e4] °/s
const GIMBAL_LIM_ABS = 360, GIMBAL_RATE_MAX = 1e4
// 参数化天线口径字段：[名字, 判据, 说明]（坏值丢弃并记错；未知键照留）
const PARAM_ANT_FIELDS = [
  ['diameterM', (v) => isNum(v) && v > 0 && v <= 1000, '须在 (0, 1000] m'],
  ['freqGHz', (v) => isNum(v) && v > 0 && v <= 1000, '须在 (0, 1000] GHz'],
  ['efficiency', (v) => isNum(v) && v > 0 && v <= 1, '须在 (0, 1]'],
  ['gainDbi', (v) => isNum(v) && v >= -50 && v <= 100, '须在 [−50, 100] dBi'],
  ['hpbwDeg', (v) => isNum(v) && v > 0 && v <= 180, '须在 (0, 180] °'],
  ['pattern', (v) => isStr(v) && v.length > 0 && v.length <= 64, '须为非空字符串（≤ 64 字）']
]

const UNIT_TOL = 1e-12
/** 非零 3 维向量 → 单位向量；已是单位长（误差 ≤ 1e-12）的原样拷贝——保证 normalize 逐位幂等。零长 / 非法返回 null。 */
function unitOrNull(v) {
  if (!isVec3(v)) return null
  const n = Math.hypot(v[0], v[1], v[2])
  if (!(n > 1e-9)) return null
  const o = Math.abs(n - 1) <= UNIT_TOL ? v.slice() : [v[0] / n, v[1] / n, v[2] / n]
  return o.map((x) => (x === 0 ? 0 : x))
}
/** 上向量去掉沿单位视轴 d 的分量再归一；已正交（|u·d| ≤ 1e-12）的只归一——同样为幂等。退化返回 null。 */
function orthoUp(up, d) {
  if (!isVec3(up) || isUpDegenerate(d, up)) return null
  const k = up[0] * d[0] + up[1] * d[1] + up[2] * d[2]
  const r = Math.abs(k) <= UNIT_TOL * Math.hypot(up[0], up[1], up[2]) ? up : [up[0] - k * d[0], up[1] - k * d[1], up[2] - k * d[2]]
  return unitOrNull(r)
}

/**
 * 四元数符号规范化（w ≥ 0），已单位长（误差 ≤ 1e-12）的不再除模长——quatCanonical 每次都除，
 * 反复归一会在末位来回跳，绑定表「清洗结果再清洗不变」就不成立了。
 */
function quatStable(qv) {
  const n = Math.hypot(qv[0], qv[1], qv[2], qv[3])
  if (Math.abs(n - 1) > UNIT_TOL) return quatCanonical(qv)
  let flip = qv[3] < 0
  if (qv[3] === 0) for (let i = 0; i < 3; i++) if (qv[i] !== 0) { flip = qv[i] < 0; break }
  return qv.map((v) => (flip ? -v : v)).map((v) => (v === 0 ? 0 : v))
}

/** 姿态律参数里的「本体轴」：BODY_AXES 的字符串或非零 [x,y,z] → 单位向量（attitude.mjs 只认数值向量）。非法返回 undefined。 */
function normBodyAxis(v) {
  if (isStr(v)) return Object.hasOwn(AXIS_STR, v) ? AXIS_STR[v].slice() : undefined
  return unitOrNull(v) || undefined
}

function normGimbal(g, path, errors) {
  const src = g === undefined || g === null ? {} : g
  if (!isObj(src)) { errors.push(`${path}：须为对象，按无万向节`); return { type: 'none', limits: { ...DEFAULT_GIMBAL_LIMITS } } }
  let type = src.type === undefined ? 'none' : src.type
  if (!GIMBAL_TYPES.includes(type)) { errors.push(`${path}.type：非法 ${q(type)}，按 none`); type = 'none' }
  const L = isObj(src.limits) ? src.limits : {}
  if (src.limits !== undefined && !isObj(src.limits)) errors.push(`${path}.limits：须为对象，按全程`)
  const limits = {}
  for (const k of ['a1Min', 'a1Max', 'a2Min', 'a2Max']) {
    const v = L[k]
    if (v === undefined) limits[k] = DEFAULT_GIMBAL_LIMITS[k]
    else if (isNum(v) && Math.abs(v) <= GIMBAL_LIM_ABS) limits[k] = v
    else { errors.push(`${path}.limits.${k}：须为 [−360, 360] 内的数，按缺省 ${DEFAULT_GIMBAL_LIMITS[k]}`); limits[k] = DEFAULT_GIMBAL_LIMITS[k] }
  }
  for (const a of ['a1', 'a2']) {
    if (limits[`${a}Min`] > limits[`${a}Max`]) {
      errors.push(`${path}.limits：${a}Min > ${a}Max，已交换`)
      const t = limits[`${a}Min`]; limits[`${a}Min`] = limits[`${a}Max`]; limits[`${a}Max`] = t
    }
  }
  const out = { type, limits }
  if (src.rateDegS !== undefined && src.rateDegS !== null) {
    if (isNum(src.rateDegS) && src.rateDegS > 0 && src.rateDegS <= GIMBAL_RATE_MAX) out.rateDegS = src.rateDegS
    else errors.push(`${path}.rateDegS：须在 (0, ${GIMBAL_RATE_MAX}] °/s，已丢弃`)
  }
  return out
}

// raw：未经 plain 的原对象（查保留名用——plain 已把各层 '__proto__' 剥掉，只有原对象上还看得见，要记错得按它查）
function normAntennaRef(r, path, errors, raw) {
  if (r === undefined || r === null) return null
  if (!isObj(r) || !ANTENNA_REF_KINDS.includes(r.kind)) { errors.push(`${path}：kind 须为 ${ANTENNA_REF_KINDS.join(' / ')}，已清空`); return null }
  if (r.kind === 'param') {
    if (!isObj(r.spec)) { errors.push(`${path}.spec：参数化天线须给口径对象，已清空`); return null }
    const spec = plain(r.spec)
    if (!isObj(spec)) { errors.push(`${path}.spec：不是纯数据，已清空`); return null }
    dropReserved(isObj(raw) && isObj(raw.spec) ? raw.spec : r.spec, spec, `${path}.spec`, errors)
    for (const [k, ok, msg] of PARAM_ANT_FIELDS) {
      if (spec[k] !== undefined && !ok(spec[k])) { errors.push(`${path}.spec.${k}：${msg}，已丢弃`); delete spec[k] }
    }
    return { kind: 'param', spec }
  }
  const id = isStr(r.id) ? r.id.trim() : ''
  if (!id || id.length > 512) { errors.push(`${path}.id：${r.kind} 引用须为非空字符串，已清空`); return null }
  return { kind: r.kind, id }
}

// mount 的已知键（其余纯数据键照留，见上方口径）
const MOUNT_KEYS = new Set(['id', 'name', 'attachPoint', 'posBody', 'boresightBody', 'upBody', 'fovDeg', 'sysTempK', 'gimbal', 'antennaRef', 'excludeNodes', 'maskSig'])

/**
 * 归一一个 mount（工作台新建 / JSON 导入 / 绑定表读写共用）。坏值丢弃或回缺省并记错误；不抛。
 * @param {object} m
 * @param {{path?:string, errors?:string[], fallbackId?:string}} [opts]  errors 给了就往里追加（validateBindings 用）
 * @returns {{mount:object|null, errors:string[]}}  mount = null 表示整条丢弃（非对象 / 缺 posBody / 拷不了）
 */
export function normalizeMount(m, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const errors = Array.isArray(o.errors) ? o.errors : []
  const path = isStr(o.path) ? o.path : 'mount'
  if (!isObj(m)) { errors.push(`${path}：不是对象，已丢弃`); return { mount: null, errors } }
  const src = plain(m)
  if (!isObj(src)) { errors.push(`${path}：不是纯数据（BigInt / 循环引用），已丢弃`); return { mount: null, errors } }
  dropReserved(m, src, path, errors)
  if (!isVec3(src.posBody)) { errors.push(`${path}.posBody：须为 [x,y,z]（米，本体系），整条丢弃`); return { mount: null, errors } }

  let id = isStr(src.id) ? src.id.trim() : ''
  if (!id || id.length > MOUNT_ID_MAX) {
    const fb = isStr(o.fallbackId) && o.fallbackId ? o.fallbackId : 'mount_1'
    errors.push(`${path}.id：须为非空字符串（≤ ${MOUNT_ID_MAX} 字），已改为 ${q(fb)}`)
    id = fb
  }
  let name = id
  if (src.name !== undefined) {
    if (isStr(src.name) && src.name.trim()) name = src.name.slice(0, LIM.name)
    else errors.push(`${path}.name：须为非空字符串，按 id`)
  }
  let attachPoint = null
  if (src.attachPoint !== undefined && src.attachPoint !== null) {
    if (refNameOk(src.attachPoint)) attachPoint = src.attachPoint
    else errors.push(`${path}.attachPoint：须为挂点名（非空字符串）或 null，已清空`)
  }
  let bore = unitOrNull(src.boresightBody)
  if (!bore) {
    errors.push(`${path}.boresightBody：${src.boresightBody === undefined ? '缺失' : '须为非零 [x,y,z]'}，按本体 +Z（天底）`)
    bore = [0, 0, 1]
  }
  let up = src.upBody === undefined || src.upBody === null ? null : orthoUp(src.upBody, bore)
  if (!up && src.upBody !== undefined && src.upBody !== null) errors.push(`${path}.upBody：零长、非法或与视轴平行，按 D1 缺省`)
  if (!up) up = defaultUpBody(bore)

  // 未知键先放（纯数据），已知键随后覆盖——输出键序稳定：未知键在前不影响读，但让 JSON 对拍 / 幂等不受输入键序干扰。
  // 用 fromEntries 建（定义语义，不走赋值 setter）且跳过保留名：out 的原型恒为 Object.prototype，
  // 下面按条件不写的已知键（fovDeg / maskSig …）读出来就是 undefined，不会从别处冒出未校验的值
  const out = Object.fromEntries(Object.entries(src).filter(([k]) => !MOUNT_KEYS.has(k) && !RESERVED_KEYS.has(k)))
  Object.assign(out, { id, name, attachPoint, posBody: src.posBody.slice(), boresightBody: bore, upBody: up })
  if (src.fovDeg !== undefined && src.fovDeg !== null) {
    if (isNum(src.fovDeg) && src.fovDeg > 0 && src.fovDeg <= 360) out.fovDeg = src.fovDeg
    else errors.push(`${path}.fovDeg：须在 (0, 360] °（全锥角），已丢弃`)
  }
  out.sysTempK = DEFAULT_SYS_TEMP_K
  if (src.sysTempK !== undefined && src.sysTempK !== null) {
    if (isNum(src.sysTempK) && src.sysTempK > 0 && src.sysTempK <= 1e6) out.sysTempK = src.sysTempK
    else errors.push(`${path}.sysTempK：须在 (0, 1e6] K，按 ${DEFAULT_SYS_TEMP_K}`)
  }
  out.gimbal = normGimbal(src.gimbal, `${path}.gimbal`, errors)
  out.antennaRef = normAntennaRef(src.antennaRef, `${path}.antennaRef`, errors, m.antennaRef)
  out.excludeNodes = []
  if (src.excludeNodes !== undefined && src.excludeNodes !== null) {
    if (!Array.isArray(src.excludeNodes)) errors.push(`${path}.excludeNodes：须为节点名数组，已清空`)
    else {
      out.excludeNodes = strList(src.excludeNodes, LIM.list, LIM.name)
      if (out.excludeNodes.length !== src.excludeNodes.length) errors.push(`${path}.excludeNodes：有空、重复、非字符串或超长项，已丢弃`)
    }
  }
  if (src.maskSig !== undefined && src.maskSig !== null) {
    if (isStr(src.maskSig) && MASK_SIG_RE.test(src.maskSig)) out.maskSig = src.maskSig
    else errors.push(`${path}.maskSig：须为 16–128 位小写十六进制，已丢弃（掩模需重算）`)
  }
  return { mount: out, errors }
}

/**
 * 新建 mount 的缺省（工作台「新增挂点」「从挂点套用」用）：partial 覆盖后走 normalizeMount。
 * 恒返回对象、不返回 null（调用方直接 push / 取属性）：
 *   · partial 里值为 undefined / null 的键视同没给（{posBody: ap.posBody} 在挂点缺位姿时就是 undefined，不能盖掉缺省）；
 *   · posBody 不是 [x,y,z] 回原点（normalizeMount 对缺 posBody 整条丢，那是导入口径；新建时回缺省）；
 *   · 未知键里有拷不了的（BigInt / 循环引用）→ 只留已知键再试；还不行 → 纯缺省。
 * @returns {object} 归一后的 mount（partial 有坏值时已回缺省；要看错误用 normalizeMount）
 */
export function defaultMount(partial = {}) {
  const base = { id: 'mount_1', posBody: [0, 0, 0], boresightBody: [0, 0, 1] }
  const p = isObj(partial) ? Object.fromEntries(Object.entries(partial).filter(([k, v]) => v !== undefined && v !== null && !RESERVED_KEYS.has(k))) : {}
  if (!isVec3(p.posBody)) delete p.posBody
  const known = Object.fromEntries(Object.entries(p).filter(([k]) => MOUNT_KEYS.has(k)))
  return normalizeMount({ ...base, ...p }).mount || normalizeMount({ ...base, ...known }).mount || normalizeMount(base).mount
}

/**
 * 姿态律参数的键与缺省——与 packages/core/models/attitude.mjs 的 attitudeBasisEcef 逐键同口径（那边是消费端，缺的键它按下列缺省算）：
 *   nadir     yawBiasDeg（固定偏航，度，缺省 0）
 *   yawSteer  sunSide（'+X' | '-X'：太阳落在偏航后 +X / −X 半平面，缺省 '+X'）
 *   sun       axis（本体轴，[x,y,z]，缺省 −Z）精确指太阳；secondary（缺省随 axis：axis ∥ ±Z 取 'velocity'，否则 'nadir'）；secondaryAxis
 *   inertial  q（本体 → TEME 惯性系，[x,y,z,w]）或 eulerDeg {yaw, pitch, roll}（3-2-1）；都没有 = 单位旋转
 *   target    axis（缺省 +Z）精确指目标；secondary（缺省 'sun'）；secondaryAxis；target（要指的对象，存储用：地球站 / 目标星键 / 固定 ECEF 点；
 *             页面按它解出 ctx.targetEcef 喂 attitude.mjs，那边不读这个键）
 * secondary ∈ nadir / velocity / sun / orbitNormal（ATTITUDE_SECONDARY）。
 * 归一只校验、不补缺省：sun 律的次约束缺省取决于 axis，补一个定值反而改了语义；界面要显示缺省值时查这张表。
 * axis / secondaryAxis 可写成 BODY_AXES 的字符串（'+X' …），归一时换成单位向量——attitude.mjs 只认数值向量。
 */
export const ATTITUDE_PARAM_DEFAULTS = Object.freeze({
  nadir: Object.freeze({ yawBiasDeg: 0 }),
  yawSteer: Object.freeze({ sunSide: '+X' }),
  sun: Object.freeze({ axis: Object.freeze([0, 0, -1]) }),
  inertial: Object.freeze({ q: Object.freeze([0, 0, 0, 1]) }),
  target: Object.freeze({ axis: Object.freeze([0, 0, 1]), secondary: 'sun', target: null })
})
export const ATTITUDE_SECONDARY = Object.freeze(['nadir', 'velocity', 'sun', 'orbitNormal'])
const AXIS_STR = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }

function normTarget(t, path, errors) {
  if (t === undefined || t === null) return null
  if (!isObj(t)) { errors.push(`${path}：须为对象或 null，已清空`); return null }
  if (t.kind === 'station') {
    const lat = t.latDeg, lon = t.lonDeg
    if (!(isNum(lat) && lat >= -90 && lat <= 90) || !(isNum(lon) && lon >= -360 && lon <= 360)) { errors.push(`${path}：地球站经纬度非法（纬度 [−90, 90]、经度 [−360, 360]），已清空`); return null }
    // 经度归到 (−180, 180]：同一个站只有一种写法（存盘 / 比较确定）。输入限在 [−360, 360]，最多挪一圈；
    // 已在区间内的原样不动（取模再减会把 116.4 算成 116.39999999999998）
    let L = lon
    if (L > 180) L -= 360
    else if (L <= -180) L += 360
    const o = { kind: 'station', latDeg: lat, lonDeg: L === 0 ? 0 : L, altM: 0 }
    if (t.altM !== undefined && t.altM !== null) {
      if (isNum(t.altM) && t.altM >= -12000 && t.altM <= 1e8) o.altM = t.altM
      else errors.push(`${path}.altM：须在 [−12000, 1e8] m，按 0`)
    }
    if (t.name !== undefined) { if (isStr(t.name)) o.name = t.name.slice(0, LIM.name); else errors.push(`${path}.name：须为字符串，已丢弃`) }
    return o
  }
  if (t.kind === 'sat') {
    if (!isValidSatKey(t.satKey)) { errors.push(`${path}.satKey：目标星键非法 ${q(t.satKey)}，已清空`); return null }
    return { kind: 'sat', satKey: t.satKey }
  }
  if (t.kind === 'ecef') {
    if (!isVec3(t.ecefKm) || !(Math.hypot(...t.ecefKm) > 0)) { errors.push(`${path}.ecefKm：须为非零 [x,y,z]（km，标准 ECEF），已清空`); return null }
    return { kind: 'ecef', ecefKm: t.ecefKm.slice() }
  }
  errors.push(`${path}.kind：须为 station / sat / ecef，已清空`)
  return null
}

/**
 * 归一姿态律 {law, params}。law 非法按 nadir。参数键（见 ATTITUDE_PARAM_DEFAULTS 的说明）不论属于哪条律都按同一口径校验：
 * 坏值丢弃并记错（消费端按缺省算），不补缺省；其余键（消费端扩的）纯数据照留——切律再切回来不丢用户填的数。
 * 拷不了的 params 整体清空。
 * @returns {{attitude:{law:string, params:object}, errors:string[]}}
 */
export function normalizeAttitude(a, opts = {}) {
  const o = isObj(opts) ? opts : {}
  const errors = Array.isArray(o.errors) ? o.errors : []
  const path = isStr(o.path) ? o.path : 'attitude'
  const at = isObj(a) ? a : {}
  if (a !== undefined && a !== null && !isObj(a)) errors.push(`${path}：须为对象，按 nadir`)
  let law = at.law === undefined ? 'nadir' : at.law
  if (!ATTITUDE_LAWS.includes(law)) { errors.push(`${path}.law：非法 ${q(law)}，按 nadir`); law = 'nadir' }
  let params = {}
  if (at.params !== undefined && at.params !== null) {
    const pp = isObj(at.params) ? plain(at.params) : undefined
    if (isObj(pp)) params = dropReserved(at.params, pp, `${path}.params`, errors)
    else errors.push(`${path}.params：${isObj(at.params) ? '不是纯数据' : '须为对象'}，已清空`)
  }
  const pp = `${path}.params`
  const drop = (k, msg) => { errors.push(`${pp}.${k}：${msg}，已丢弃`); delete params[k] }
  for (const k of ['axis', 'secondaryAxis']) {
    if (params[k] === undefined) continue
    const ax = normBodyAxis(params[k])
    if (ax === undefined) drop(k, `须为 ${BODY_AXES.join(' / ')} 或非零 [x,y,z]`)
    else params[k] = ax
  }
  if (params.secondary !== undefined && !ATTITUDE_SECONDARY.includes(params.secondary)) drop('secondary', `须为 ${ATTITUDE_SECONDARY.join(' / ')}`)
  if (params.yawBiasDeg !== undefined && !(isNum(params.yawBiasDeg) && Math.abs(params.yawBiasDeg) <= 360)) drop('yawBiasDeg', '须在 [−360, 360] °')
  if (params.sunSide !== undefined && params.sunSide !== '+X' && params.sunSide !== '-X') drop('sunSide', "须为 '+X' / '-X'")
  if (params.q !== undefined) {
    const qv = params.q
    let qn = null
    if (Array.isArray(qv) && qv.length === 4 && qv.every(isNum)) { const n = Math.hypot(...qv); if (n > 0.9 && n < 1.1) qn = quatStable(qv) }
    if (qn) params.q = qn
    else drop('q', '须为单位四元数 [x,y,z,w]')
  }
  if (params.eulerDeg !== undefined) {
    const e = params.eulerDeg
    const okNum = (v) => v === undefined || (isNum(v) && Math.abs(v) <= 360)
    if (Array.isArray(e) ? !(e.length === 3 && e.every((v) => isNum(v) && Math.abs(v) <= 360)) : !(isObj(e) && okNum(e.yaw) && okNum(e.pitch) && okNum(e.roll))) drop('eulerDeg', '须为 {yaw, pitch, roll}（度，[−360, 360]）')
  }
  if (params.target !== undefined) params.target = normTarget(params.target, `${pp}.target`, errors)
  return { attitude: { law, params }, errors }
}

function normBinding(b, path, errors) {
  if (!isObj(b)) { errors.push(`${path}：不是对象，已丢弃`); return null }
  const out = {}
  const m = isObj(b.model) ? b.model : {}
  let id = m.id === undefined ? 'auto' : m.id
  if (!(id === 'auto' || id === null || isValidModelId(id))) { errors.push(`${path}.model.id：非法 ${q(id)}，按 auto`); id = 'auto' }
  else id = resolveParamModelId(id)   // 旧模板 id（LEGACY_TEMPLATE_IDS）静默换成现行 id：同 prefs.geoDefault，按 id 比对的地方才认得出
  out.model = { id }
  if (m.iconPx !== undefined) {
    if (isNum(m.iconPx) && m.iconPx >= 8 && m.iconPx <= 256) out.model.iconPx = Math.round(m.iconPx)
    else errors.push(`${path}.model.iconPx：须在 8–256，已丢弃`)
  }
  if (m.frameOverride !== undefined && m.frameOverride !== null) {
    const fo = m.frameOverride
    const e0 = errors.length
    if (!isObj(fo)) errors.push(`${path}.model.frameOverride：须为对象，已丢弃`)
    else checkQT(fo, `${path}.model.frameOverride`, errors)
    if (errors.length === e0) out.model.frameOverride = { q: quatStable(fo.q), t: fo.t.slice() }
  }
  if (b.massProps !== undefined && b.massProps !== null) {
    const e = [], w = []
    checkMassProps(b.massProps, `${path}.massProps`, e, w)
    if (e.length) errors.push(...e.map((x) => `${x}（已丢弃）`))
    else out.massProps = normMassProps(b.massProps)
  }
  // mounts（二期：挂点 + 天线引用 + 万向节 + 掩模签名）：逐条 normalizeMount，坏条丢弃、坏值回缺省，全部记错；
  // 一条坏数据不拖垮整张绑定表。id 在本星内唯一（重复的加 _2、_3…；缺的按序号补），掩模 / 表格选中 / 报告都按 id 认。
  out.mounts = []
  if (b.mounts !== undefined && b.mounts !== null && !Array.isArray(b.mounts)) errors.push(`${path}.mounts：须为数组，已清空`)
  if (Array.isArray(b.mounts)) {
    if (b.mounts.length > MOUNTS_MAX) errors.push(`${path}.mounts：超过 ${MOUNTS_MAX} 条，多出的已丢弃`)
    const ids = new Set()
    b.mounts.slice(0, MOUNTS_MAX).forEach((mm, i) => {
      const mp = `${path}.mounts[${i}]`
      let k = out.mounts.length + 1
      while (ids.has(`mount_${k}`)) k++
      const { mount } = normalizeMount(mm, { path: mp, errors, fallbackId: `mount_${k}` })
      if (!mount) return
      if (ids.has(mount.id)) {
        const base = mount.id.slice(0, MOUNT_ID_MAX - 4)   // 加后缀后仍不超长（否则再清洗一次又被改名，不幂等）
        let s = 2
        while (ids.has(`${base}_${s}`)) s++
        const nid = `${base}_${s}`
        errors.push(`${mp}.id：与前面重复「${mount.id}」，已改为 ${q(nid)}`)
        if (mount.name === mount.id) mount.name = nid
        mount.id = nid
      }
      ids.add(mount.id)
      out.mounts.push(mount)
    })
  }
  out.attitude = normalizeAttitude(b.attitude, { path: `${path}.attitude`, errors }).attitude
  return out
}

/**
 * 校验并清洗绑定表。整份不是对象或 schema ≠ 1 → ok:false（调用方据此拒写，照 storage.js mutate 口径）；
 * 单条坏的丢弃或纠正，记进 errors，ok 仍为 true。返回的 bindings 是清洗后的纯数据（可直接落盘 / 过 IPC）。
 * @returns {{ok:boolean, errors:string[], bindings:{schema:1, prefs:object, bindings:object}}}
 */
export function validateBindings(b) {
  const empty = { schema: 1, prefs: { ...DEFAULT_PREFS }, bindings: {} }
  if (!isObj(b)) return { ok: false, errors: ['绑定表不是对象'], bindings: empty }
  if (b.schema !== 1) return { ok: false, errors: [`绑定表 schema 须为 1（得到 ${q(b.schema)}）`], bindings: empty }
  const errors = []
  const p = isObj(b.prefs) ? b.prefs : {}
  const prefs = { ...DEFAULT_PREFS }
  if (p.geoDefault !== undefined) {
    if (isValidModelId(p.geoDefault)) prefs.geoDefault = resolveParamModelId(p.geoDefault)   // 旧模板 id → 现行 id
    else errors.push(`prefs.geoDefault：非法 ${q(p.geoDefault)}，按 ${DEFAULT_PREFS.geoDefault}`)
  }
  if (p.showModels !== undefined) {
    if (typeof p.showModels === 'boolean') prefs.showModels = p.showModels
    else errors.push('prefs.showModels：须为布尔')
  }
  const out = {}
  if (b.bindings !== undefined && !isObj(b.bindings)) errors.push('bindings：须为对象')
  else if (isObj(b.bindings)) {
    for (const [k, v] of Object.entries(b.bindings)) {
      if (!isValidSatKey(k)) { errors.push(`bindings：键 ${q(k)} 格式不对，已丢弃`); continue }
      const nb = normBinding(v, `bindings[${q(k)}]`, errors)
      if (nb) out[k] = nb
    }
  }
  return { ok: true, errors, bindings: { schema: 1, prefs, bindings: out } }
}
