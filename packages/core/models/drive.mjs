// 驱动装配件（模型工作台「设计」页的快速设置层，2026-10）。
//
// 纯 ESM、零 three 依赖、node 可测。一份装配文档带 drive = {kind:'sat', spec, templateId, serial} 时就是「驱动装配件」：
//   · spec（paramBus 整星参数）是驱动参数：快速设置面板改的就是它；组件由 satSpecToComps(spec) 生成，叫「基线」。
//   · 文档里的组件 = 基线 + 用户在详细编辑里做的改动（改参数 / 挪位置 / 换材质 / 删件 / 加件）。
//   · 改驱动参数 = 新基线 + 三方合并（旧基线 / 当前文档 / 新基线）：某件某字段用户没碰过（当前 = 旧基线）就跟新基线走，
//     碰过的保留（改写）；用户删掉的基线件继续删着；新基线多出来的件加进来；基线里没了的件连同挂在它下面的生成件一起去掉，
//     挂在它下面的用户件改挂到根件、保持原世界位姿（自由安装）。专业 CAD 的「驱动尺寸 + 局部改写」同一套语义。
//     安装量（父件 / 安装方式 / 锚 / 位置）锚变了时按一个整体合并（见 mergeComp）；父件尺寸变了，面上取自当前文档的 uv 等比换算；
//     用户件 id 撞上新基线的件时用户件改名（不被认领）。
//   · 与 spec 字段一一对应的组件参数（满足 satSpecToComps 的 links 表）是「驱动参数的另一个入口」：在详细编辑里改它，
//     等于改 spec（直写），关联件（展开臂 / 馈源支架 / 天线塔高 …）随之重排——而不是在这一件上留一个孤立的改写。
//   · 组件 id 由条目序号决定（satSpecToComps 的 serialsOf）：列表条目一律带 uid，删掉中间条目不会让后面的件「继承」别人的改写。
//
// 导出：
//   isDriven(doc)                                 文档带合法驱动参数
//   driveBase(spec)                               → {ok, errors, missing, comps, byId, links, items, massTargetKg, density}（按 spec 规范 JSON 缓存）
//   withUids(spec, serial)                        → {spec, serial}：列表条目补 uid（不改入参）
//   newDrivenDoc({templateId?, spec?, name?})     → 归一后的驱动装配件；spec 非法抛 Error（code = 'SPEC_INVALID'）
//   rebaseDrive(doc, nextSpec)                    → {ok, doc, dropped, rehomed, renamed} | {ok:false, error}
//   driveLinks(doc, compId)                       → {参数键: [{p, m}]}（该件可直写回 spec 的参数）
//   writeThrough(doc, compId, params)             → 新 spec | null（有一个键不在联动表、或写完 spec 不合法 → null：按普通改写处理）
//   driveRemove(doc, ids)                         → {spec, rest} | null（ids 里对应 spec 列表条目的件 → 从 spec 删条目；rest = 其余照常删的件）
//   driveMarks(doc)                               → {组件 id: {user, params:{键:'link'|'over'}, attach, pose, mass, material, name, sym}}
//   resetToBase(doc, compId, what)                → 新文档（what：参数键 / 'pose' / 'mass' / 'material' / 'name' / 'sym' / 'all'；锁定件不改）| null
//   resetAllOverrides(doc) / restoreSuppressed(doc) → 全部改写一次恢复 / 找回删掉的基线件（一步撤销）| null；suppressedIds(doc)
//   detachDrive(doc)                              → 去掉驱动参数的普通装配件（组件原样）
//   specPathGet / specPathSet                     'reflectors[2].diameterM' 式路径读写（快速设置面板共用）
//   DRIVE_LISTS                                   带 uid 的 spec 列表键

import { normalizeAssembly, normalizeDrive, solvePose, validateAssembly, mkAttach } from './assembly.mjs'
import { satSpecToComps } from './components/sat.mjs'
import { getComponent, fillParams } from './components/index.mjs'
import { normalizeSpec, validateSpec, canon } from './paramBus.mjs'
import { templateSpec, resolveTemplateId } from './paramTemplates.mjs'
import { matToQuat } from './bodyFrame.mjs'
import { compGeo, clampToFace, compIdFor, setDriveReservedIds } from './asmSnap.mjs'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const z0 = (v) => (Math.abs(v) < 5e-13 ? 0 : v)

/** 带 uid 的 spec 列表（太阳翼按装在哪一面定 id，不用 uid）。 */
export const DRIVE_LISTS = Object.freeze(['reflectors', 'feeds', 'booms', 'thrusters', 'radiators'])

export const isDriven = (doc) => !!(isObj(doc) && doc.domain === 'spacecraft' && isObj(doc.drive) && doc.drive.kind === 'sat' && isObj(doc.drive.spec))

// ───────────────────────────── 路径读写（'a.b[2].c'）─────────────────────────────

function parsePath(path) {
  const out = []
  for (const part of String(path).split('.')) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(part)
    if (!m) return null
    out.push(m[1])
    for (const ix of m[2].match(/\d+/g) || []) out.push(Number(ix))
  }
  return out
}
export function specPathGet(obj, path) {
  const ks = parsePath(path)
  if (!ks) return undefined
  let o = obj
  for (const k of ks) { if (o === null || typeof o !== 'object') return undefined; o = o[k] }
  return o
}
/** 写路径（就地改 obj；缺的中间对象补上）。路径非法 / 中间是标量 → false。 */
export function specPathSet(obj, path, v) {
  const ks = parsePath(path)
  if (!ks || !ks.length) return false
  let o = obj
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i]
    if (o[k] === undefined || o[k] === null) o[k] = typeof ks[i + 1] === 'number' ? [] : {}
    if (typeof o[k] !== 'object') return false
    o = o[k]
  }
  o[ks[ks.length - 1]] = v
  return true
}

// ───────────────────────────── 基线 ─────────────────────────────

const BASE = new Map()   // canon(spec) → 基线（只读，调用方别改）
const BASE_MAX = 24
/**
 * spec → 基线组件（归一后）+ 联动表。按 spec 的规范 JSON 缓存（同一份 spec 反复合并、反复标记时不重算）。
 * 结果对象与其中的组件是共享缓存，调用方只读；要改先 clone。
 */
export function driveBase(spec) {
  const key = canon(spec)
  const hit = BASE.get(key)
  if (hit) return hit
  let out
  const v = validateSpec(spec)
  if (!v.ok) out = { ok: false, errors: v.errors, missing: v.missing }
  else {
    const s = normalizeSpec(spec)
    const r = satSpecToComps(s)
    const comps = normalizeAssembly({ kind: 'assembly', domain: 'spacecraft', comps: r.comps }).comps
    out = {
      ok: true, errors: [], missing: [], comps, byId: new Map(comps.map((c) => [c.id, c])), links: r.links, items: r.items, warnings: r.warnings,
      massTargetKg: isNum(s.massTargetKg) ? s.massTargetKg : null, density: isObj(s.density) ? s.density : {}
    }
  }
  if (BASE.size >= BASE_MAX) BASE.delete(BASE.keys().next().value)
  BASE.set(key, out)
  return out
}
// 编辑器给新件起 id（asmSnap.compIdFor）时避开当前基线的全部件 id，含被用户删掉的基线件：新件拿了那个 id 会被当成该基线件的改写，
// 「找回删除件」「全部恢复」都会认错它，驱动参数一变还可能被当生成件删掉（排查 #20；还没生成的基线 id 由 rebaseDrive 的改名兜住）
setDriveReservedIds((doc) => { const b = isDriven(doc) ? driveBase(doc.drive.spec) : null; return b && b.ok ? b.byId.keys() : [] })

const specErr = (b) => {
  const parts = [...(b.missing || []).map((p) => p + ' 缺值'), ...(b.errors || [])]
  return parts.length ? parts.join('；') : '参数无效。'
}

/** 列表条目补 uid（已有且不重复的保留；serial = 下一个可用号，只增不减）。不改入参。 */
export function withUids(spec, serial = 1) {
  const s = clone(spec) || {}
  let next = Number.isInteger(serial) && serial > 0 ? serial : 1
  for (const k of DRIVE_LISTS) {
    if (!Array.isArray(s[k])) continue
    for (const it of s[k]) if (isObj(it) && Number.isInteger(it.uid) && it.uid >= next) next = it.uid + 1
  }
  for (const k of DRIVE_LISTS) {
    if (!Array.isArray(s[k])) continue
    const seen = new Set()
    for (const it of s[k]) {
      if (!isObj(it)) continue
      if (!(Number.isInteger(it.uid) && it.uid > 0) || seen.has(it.uid)) it.uid = next++
      seen.add(it.uid)
    }
  }
  return { spec: s, serial: next }
}

/**
 * 新建驱动装配件：模板 id（现行或旧别名，按「含示意值」取 spec）或现成 spec。名称缺省取 spec.name / 模板中文名。
 * spec 非法抛 Error（code = 'SPEC_INVALID'，errors / missing 同 validateSpec）。
 */
export function newDrivenDoc(o = {}) {
  let spec = null, templateId = null
  if (typeof o.templateId === 'string' && o.templateId) {
    templateId = resolveTemplateId(o.templateId)
    const t = templateId ? templateSpec(templateId) : null
    if (!t || !t.spec) { const e = new Error(`未知模板「${o.templateId}」`); e.code = 'SPEC_INVALID'; e.errors = [e.message]; e.missing = []; throw e }
    spec = t.spec
  } else if (isObj(o.spec)) {
    spec = o.spec
    templateId = typeof spec.template === 'string' ? resolveTemplateId(spec.template) : null
  }
  const u = withUids(spec || {}, 1)
  const b = driveBase(u.spec)
  if (!b.ok) { const e = new Error(specErr(b)); e.code = 'SPEC_INVALID'; e.errors = b.errors; e.missing = b.missing; throw e }
  const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : (typeof u.spec.name === 'string' ? u.spec.name : '')
  return normalizeAssembly({
    kind: 'assembly', domain: 'spacecraft', name, comps: clone(b.comps), density: clone(b.density), massTargetKg: b.massTargetKg,
    drive: { kind: 'sat', spec: u.spec, templateId, serial: u.serial }
  })
}

// ───────────────────────────── 三方合并 ─────────────────────────────

const same = (a, b) => canon(a) === canon(b)
// 自由件的 t / q 按容差比：浮点重算在末位上的出入不是用户改写（t 1e-9 m、四元数分量 1e-12 ≈ 2e-12 rad）。逐字节比较时约 1 % 的
// 基线展开臂会因四元数归一的末位抖动被判成「位置改写」、朝向卡在旧值（v1.5.0 排查 #11；quatCanonical 也已改成归一幂等）
const T_TOL = 1e-9, Q_TOL = 1e-12
function sameVec(a, b, tol) {
  if (a === undefined || b === undefined || a === null || b === null) return a == null && b == null
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return same(a, b)
  for (let i = 0; i < a.length; i++) { if (!(Math.abs(a[i] - b[i]) <= tol)) return false }
  return true
}
// 安装量以外的字段：逐字段三方
const COMP_FIELDS = ['type', 'sym', 'name', 'massKg', 'material', 'hidden', 'locked']
// off / tilt（带锚偏移 / 倾角）同样逐键三方：用户设过的保留，改驱动参数不悄悄丢；两边都经 normalizeAssembly（缺省 [0,0,0] / [0,0]），
// 原样文档不会被判改写（反解值都过 clean、原地重放取原值，不留浮点尘）
const ATTACH_KEYS = ['mode', 'socket', 'face', 'uv', 'roll', 'mount', 'off', 'tilt']
// 安装锚：父件 + 安装方式 / 接口 / 面 / 安装端。uv / roll / off / tilt / t / q 都是相对锚的量
const ANCHOR_KEYS = ['mode', 'socket', 'face', 'mount']
const sameAnchor = (a, b) => a.parent === b.parent && ANCHOR_KEYS.every((k) => same(a.attach[k], b.attach[k]))
const samePlace = (a, b) => sameAnchor(a, b) && ATTACH_KEYS.every((k) => same(a.attach[k], b.attach[k])) && sameVec(a.t, b.t, T_TOL) && sameVec(a.q, b.q, Q_TOL)

/**
 * 单件合并：o = 旧基线、c = 当前、n = 新基线（三者都须是归一件：缺省 off / tilt 在场，逐键比较才不误判）。用户没碰过的字段（c = o）取 n，碰过的留 c。
 * 安装量 {parent, attach, t, q}：三方的锚都没变 → 逐键合并（用户改了滚转、驱动改了面上位置，两样都留）；锚变了就当一个整体——
 *   用户没碰过 → 取新基线整套；用户换过锚（挂到别处 / 换了安装方式）→ 留用户整套；用户只在原锚上挪过、驱动换了锚（快速设置改
 *   「安装位置」：父件 / 接口变了）→ 取新基线整套：那些偏移量是相对旧锚的，拼到新锚上会落进星体（v1.5.0 排查 #21）。
 * @returns {{comp:object, uvMine:boolean}} uvMine：面上位置 uv 取自当前文档（父件面尺寸变了要按比例换算，见 rescaleFaceUv）
 */
function mergeComp(o, c, n) {
  const out = clone(n)
  for (const f of COMP_FIELDS) if (!same(c[f], o[f])) { if (c[f] === undefined) delete out[f]; else out[f] = clone(c[f]) }
  const keys = new Set([...Object.keys(n.params || {}), ...Object.keys(c.params || {})])
  for (const k of keys) if (!same(c.params[k], o.params[k])) out.params[k] = clone(c.params[k])
  let uvMine = false
  const takeCur = () => {
    out.parent = c.parent; out.attach = clone(c.attach)
    if (c.t === undefined) delete out.t; else out.t = clone(c.t)
    if (c.q === undefined) delete out.q; else out.q = clone(c.q)
    uvMine = true
  }
  if (sameAnchor(c, o) && sameAnchor(n, o)) {
    for (const k of ATTACH_KEYS) if (!same(c.attach[k], o.attach[k])) out.attach[k] = clone(c.attach[k])
    if (!sameVec(c.t, o.t, T_TOL)) { if (c.t === undefined) delete out.t; else out.t = clone(c.t) }
    if (!sameVec(c.q, o.q, Q_TOL)) { if (c.q === undefined) delete out.q; else out.q = clone(c.q) }
    uvMine = !same(c.attach.uv, o.attach.uv)
  } else if (!sameAnchor(c, o)) takeCur()
  // 其余（用户没碰过，或只在旧锚上挪过而驱动换了锚）：新基线整套（out 本就是 n 的副本）
  // 安装方式被用户改成了自由件（拾起重放 / gizmo）：新基线若不带 t / q（基线件是插座 / 面安装），沿用当前的
  if (out.attach.mode === 'free' && out.parent !== null) {
    if (!Array.isArray(out.t)) out.t = clone(c.t) || [0, 0, 0]
    if (!Array.isArray(out.q)) out.q = clone(c.q) || [0, 0, 0, 1]
  } else { delete out.t; delete out.q }
  return { comp: out, uvMine }
}

/**
 * 父件改了尺寸（新旧面同 id 同型、半宽变了）：贴在它面上、uv 取自当前文档的件（用户件 / 面上位置改写过的基线件）按新旧半宽等比
 * 换算 uv 再夹进面内——与普通装配件改参数（asmSnap.applyCmd setParams 的 rescaleFaceKids）同一换算。就地改 comps。
 * 跟新基线走的件不动（新基线按新尺寸生成，本来就对）。v1.5.0 排查 #12：星敏贴在 +X 面，快速设置把星体 Y / Z 改小后悬在面外 0.6 m。
 */
function rescaleFaceUv(oldComps, comps, mine) {
  const oldById = new Map(oldComps.map((c) => [c.id, c]))
  const byId = new Map(comps.map((c) => [c.id, c]))
  const geo = new Map()
  const facesOf = (c) => { const k = canon([c.type, c.params]); if (!geo.has(k)) geo.set(k, compGeo(c).faces); return geo.get(k) }
  const r9 = (x) => { const y = Math.round(x * 1e9) / 1e9; return y === 0 ? 0 : y }
  const io = { u: 0, v: 0 }
  for (const ch of comps) {
    const a = ch.attach
    if (!mine.has(ch.id) || ch.parent == null || !a || typeof a.face !== 'string' || !a.face || a.mode === 'socket' || !Array.isArray(a.uv)) continue
    const p1 = byId.get(ch.parent), p0 = oldById.get(ch.parent)
    if (!p0 || !p1 || p0.type !== p1.type) continue
    const f0 = facesOf(p0).find((f) => f.id === a.face), f1 = facesOf(p1).find((f) => f.id === a.face)
    if (!f0 || !f1 || f0.kind !== f1.kind) continue
    const su = f0.halfU > 0 && f1.halfU > 0 ? f1.halfU / f0.halfU : 1, sv = f0.halfV > 0 && f1.halfV > 0 ? f1.halfV / f0.halfV : 1
    if (su === 1 && sv === 1) continue
    clampToFace(f1, (isNum(a.uv[0]) ? a.uv[0] : 0) * su, (isNum(a.uv[1]) ? a.uv[1] : 0) * sv, io)
    ch.attach = { ...a, uv: [r9(io.u), r9(io.v)] }
  }
}

/** 列主序 4×4 → {t, q}（本体系；q 规范 [x,y,z,w]）。 */
function tqOf(m) {
  const R = [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]]
  return { t: [z0(m[12]), z0(m[13]), z0(m[14])], q: (matToQuat(R, 1e-6) || [0, 0, 0, 1]).map(z0) }
}
/** a⁻¹ · b（刚体，列主序） */
function relM(a, b) {
  const o = new Float64Array(16)
  // a 的旋转转置
  const r = [a[0], a[4], a[8], a[1], a[5], a[9], a[2], a[6], a[10]]
  const t = [-(r[0] * a[12] + r[1] * a[13] + r[2] * a[14]), -(r[3] * a[12] + r[4] * a[13] + r[5] * a[14]), -(r[6] * a[12] + r[7] * a[13] + r[8] * a[14])]
  const inv = [r[0], r[3], r[6], 0, r[1], r[4], r[7], 0, r[2], r[5], r[8], 0, t[0], t[1], t[2], 1]
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) o[4 * c + rr] = inv[rr] * b[4 * c] + inv[4 + rr] * b[4 * c + 1] + inv[8 + rr] * b[4 * c + 2] + inv[12 + rr] * b[4 * c + 3]
  return o
}

/** 生成件 id 里带条目序号的前缀（satSpecToComps）：新条目的序号要避开文档里已有的同名件（用户手加的 refl5 …）。 */
const SERIAL_ID_RE = /^(?:refl|sup|arm|hinge|feedx|boomx|thrx|radx)(\d+)[a-z]?$/
/** spec 里的列表条目一律带 uid；serial 跟着推进（只增不减），且越过文档里已占用的序号。 */
function stampUids(doc, spec) {
  let serial = doc.drive.serial
  for (const c of doc.comps) { const m = SERIAL_ID_RE.exec(c.id); if (m && Number(m[1]) >= serial) serial = Number(m[1]) + 1 }
  const u = withUids(spec, serial)
  return { spec: u.spec, serial: Math.max(serial, u.serial) }
}

/**
 * 改驱动参数：新 spec 生成新基线，与当前文档三方合并（见文件头）。合并结果不合法（validateAssembly）时不改文档、报错。
 * @returns {{ok:true, doc:object, dropped:string[], rehomed:string[], renamed:Array<[string, string]>} | {ok:false, error:string}}
 *   renamed：撞上新基线件 id 而改了名的用户件 [旧 id, 新 id]
 */
export function rebaseDrive(doc0, nextSpec) {
  const doc = normalizeAssembly(doc0)
  if (!isDriven(doc)) return { ok: false, error: '不是驱动装配件。' }
  const st = stampUids(doc, nextSpec)
  const nb = driveBase(st.spec)
  if (!nb.ok) return { ok: false, error: specErr(nb) }
  let ob = driveBase(doc.drive.spec)
  // 旧 spec 坏了（手改过的存档）：拿新基线当旧基线——现有件一律按「用户改写」原样保留，只补新出现的件
  if (!ob.ok) ob = nb
  // 用户件（旧基线里没有）的 id 撞上新基线才生成的件（加了对地板反射面才有的 tower、换翼构型才有的 wing2 …）：用户件改名、
  // 子件的父件跟着改，不让新基线「认领」它——认领了就成了生成件，之后驱动参数一变又被当成「基线里没了的生成件」删掉（排查 #20）
  const renamed = renameClaimed(doc, ob, nb)
  const cur = new Map(doc.comps.map((c) => [c.id, c]))
  const comps = [], dropped = [], mine = new Set()
  for (const n of nb.comps) {
    const c = cur.get(n.id)
    if (c && ob.byId.has(n.id)) { const m = mergeComp(ob.byId.get(n.id), c, n); comps.push(m.comp); if (m.uvMine) mine.add(n.id) }
    else if (c) { comps.push(clone(c)); mine.add(c.id) }  // （renameClaimed 之后不会再有：留作兜底，按用户件原样留）
    else if (!ob.byId.has(n.id)) comps.push(clone(n))     // 驱动新增的件
    // 其余：旧基线有、当前没有 = 用户删过 → 继续删着
  }
  for (const c of doc.comps) {
    if (nb.byId.has(c.id)) continue
    if (ob.byId.has(c.id)) { dropped.push(c.id); continue }   // 基线里没了的生成件
    comps.push(clone(c)); mine.add(c.id)                       // 用户件
  }
  // 父件改了尺寸：面上 uv 取自当前文档的件按新旧面半宽等比换算（普通装配件改参数同一换算）
  rescaleFaceUv(doc.comps, comps, mine)
  // 挂点失效的件（父件没了 / 父件上没有那个接口或面了）：改成挂在根件（或原父件）上的自由件、保持原世界位姿
  const ids = new Set(comps.map((c) => c.id))
  const root = comps.find((c) => c.parent === null)
  const rehomed = []
  if (root) {
    let P0 = null
    const oldPose = (id) => { if (!P0) { try { P0 = solvePose(doc) } catch { P0 = new Map() } } const e = P0.get(id); return e && e.m ? e.m : null }
    const broken = []
    let draft = normalizeAssembly({ ...doc, comps })
    for (const c of draft.comps) {
      if (c.parent === null) continue
      const lost = !ids.has(c.parent)
      if (lost || !anchorOk(draft, c)) broken.push({ id: c.id, lost })
    }
    if (broken.length) {
      for (const b of broken) {
        const c = comps.find((x) => x.id === b.id)
        if (b.lost) c.parent = root.id
        c.attach = mkAttach(); c.t = [0, 0, 0]; c.q = [0, 0, 0, 1]
        if (c.sym && b.lost) c.sym = null
      }
      draft = normalizeAssembly({ ...doc, comps })
      let P1 = null
      try { P1 = solvePose(draft) } catch { P1 = new Map() }
      for (const b of broken) {
        const c = comps.find((x) => x.id === b.id)
        const m0 = oldPose(b.id), pe = P1.get(c.parent)
        if (m0 && pe && pe.m) { const r = tqOf(relM(pe.m, m0)); c.t = r.t; c.q = r.q }
        rehomed.push(b.id)
      }
    }
  }
  // 文档级驱动量（目标质量 / 密度表）：同样三方——用户在属性面板改过的留着
  const oldSpec = ob === nb ? null : doc.drive.spec
  let massTargetKg = doc.massTargetKg
  if (!oldSpec || same(doc.massTargetKg, ob.massTargetKg)) massTargetKg = nb.massTargetKg
  const density = { ...doc.density }
  const dKeys = new Set([...Object.keys(ob.density || {}), ...Object.keys(nb.density || {})])
  for (const k of dKeys) {
    if (!oldSpec || same(doc.density[k], ob.density[k])) { if (nb.density[k] === undefined) delete density[k]; else density[k] = nb.density[k] }
  }
  const out = normalizeAssembly({ ...doc, comps, massTargetKg, density, drive: { ...doc.drive, spec: st.spec, serial: st.serial } })
  const v = validateAssembly(out)
  if (!v.ok) return { ok: false, error: [...v.missing.map((p) => p + ' 缺值'), ...v.errors].slice(0, 3).join('；') }
  return { ok: true, doc: out, dropped, rehomed, renamed }
}

/**
 * 用户件（旧基线里没有）与新基线的件同 id → 用户件改名（compIdFor 的命名规则，避开文档与新旧基线已有的全部 id），子件的父件、
 * 对称组名（缺省 = 自己的 id）跟着改。就地改 doc（rebaseDrive 里的归一副本）。旧 spec 坏了（ob 就是 nb）时不改。
 * @returns {Array<[string, string]>} [旧 id, 新 id]
 */
function renameClaimed(doc, ob, nb) {
  if (ob === nb) return []
  const clash = doc.comps.filter((c) => nb.byId.has(c.id) && !ob.byId.has(c.id))
  if (!clash.length) return []
  const used = new Set([...doc.comps.map((c) => c.id), ...nb.byId.keys(), ...ob.byId.keys()])
  const map = new Map()
  for (const c of clash) map.set(c.id, compIdFor({ comps: [] }, c.type, used))
  for (const c of doc.comps) {
    if (map.has(c.id)) {
      const old = c.id
      c.id = map.get(old)
      if (c.sym && c.sym.group === old) c.sym = { ...c.sym, group: c.id }
    }
    if (c.parent != null && map.has(c.parent)) c.parent = map.get(c.parent)
  }
  return [...map]
}

/** 该件的安装锚（接口 / 面）在父件上还存在。 */
function anchorOk(doc, c) {
  const a = c.attach
  if (!a || (a.socket === null && a.face === null)) return true
  const p = doc.comps.find((x) => x.id === c.parent)
  if (!p) return false
  try {
    const g = componentAnchors(p)
    if (a.socket !== null && !g.sockets.has(a.socket)) return false
    if (a.face !== null && !g.faces.has(a.face)) return false
  } catch { return false }
  return true
}
function componentAnchors(c) {
  const def = getComponent(c.type)
  if (!def) return { sockets: new Set(), faces: new Set() }
  const p = fillParams(def, c.params)
  return { sockets: new Set(def.sockets(p).map((s) => s.id)), faces: new Set(def.faces(p).map((f) => f.id)) }
}

// ───────────────────────────── 直写 / 删除 / 标记 / 恢复 ─────────────────────────────

/** 该件可直写回 spec 的参数（联动表）；不是驱动装配件或不是基线件 → {} */
export function driveLinks(doc, compId) {
  if (!isDriven(doc)) return {}
  const b = driveBase(doc.drive.spec)
  return (b.ok && b.links[compId]) || {}
}

function applyLink(spec, l, v) {
  switch (l.m) {
    case 'neg': return isNum(v) ? specPathSet(spec, l.p, v === 0 ? 0 : -v) : false
    case 'mesh': return specPathSet(spec, l.p, v === 'mesh')
    case 'mli':
      // 平台体包覆：'none' = 不包（detail.mli 关、材质留着）；其余 = 包覆材质（detail.mli 开）
      if (v === 'none') return specPathSet(spec, 'detail.mli', false)
      return specPathSet(spec, 'bus.mli', v) && specPathSet(spec, 'detail.mli', true)
    default: return specPathSet(spec, l.p, v)
  }
}

/**
 * 详细编辑里改某件参数：全部键都在联动表里 → 写进 spec 后返回新 spec（调用方走 rebaseDrive）；否则 null（按本件改写处理）。
 * 写完 spec 不合法（如型式选了 spec 不支持的值）同样 null。
 */
export function writeThrough(doc, compId, params) {
  if (!isDriven(doc) || !isObj(params)) return null
  const L = driveLinks(doc, compId)
  const keys = Object.keys(params)
  if (!keys.length || !keys.every((k) => Array.isArray(L[k]) && L[k].length)) return null
  const spec = clone(doc.drive.spec)
  for (const k of keys) for (const l of L[k]) if (!applyLink(spec, l, params[k])) return null
  return validateSpec(spec).ok ? spec : null
}

/**
 * 删除：ids 里对应 spec 列表条目的件（反射面 / 太阳翼 / 显式附加件）→ 从 spec 删条目（关联的支架 / 展开臂随新基线消失）；
 * 其余件放在 rest 里由调用方照常删（基线件删了就是「删除改写」，以后改驱动参数也不会回来）。没有一件对应条目 → null。
 */
export function driveRemove(doc, ids) {
  if (!isDriven(doc) || !Array.isArray(ids)) return null
  const b = driveBase(doc.drive.spec)
  if (!b.ok) return null
  const paths = [], rest = []
  for (const id of ids) {
    const base = String(id).split('~')[0]   // 对称派生件按主件算
    const it = b.items[base]
    if (it) { for (const p of it) if (!paths.includes(p)) paths.push(p) } else rest.push(id)
  }
  if (!paths.length) return null
  const spec = clone(doc.drive.spec)
  // 同一列表按下标从大到小删，前面的下标不受影响
  const parsed = paths.map((p) => { const m = /^(\w+)\[(\d+)\]$/.exec(p); return m ? { k: m[1], i: Number(m[2]) } : null }).filter(Boolean)
  parsed.sort((a, b2) => (a.k === b2.k ? b2.i - a.i : a.k < b2.k ? -1 : 1))
  for (const { k, i } of parsed) if (Array.isArray(spec[k]) && i < spec[k].length) spec[k].splice(i, 1)
  if (!validateSpec(spec).ok) return null
  return { spec, rest }
}

/**
 * 每件相对基线的状态（属性面板 / 结构树的标记）：
 *   user：不在基线里（用户加的件）；params：{键: 'link'（驱动参数，改它直写 spec）| 'over'（本件改写）}；
 *   attach / pose / mass / material / name / sym：该项与基线不同。不是驱动装配件 → {}。
 * 入参先归一（基线是归一件）：存档 / 草稿形状（compactAssembly 剥掉了缺省 off / tilt）直接传进来也不会被逐件误判改写。
 */
export function driveMarks(doc0) {
  const doc = normalizeAssembly(doc0)
  if (!isDriven(doc)) return {}
  const b = driveBase(doc.drive.spec)
  if (!b.ok) return {}
  const out = {}
  for (const c of doc.comps) {
    const o = b.byId.get(c.id)
    if (!o) { out[c.id] = { user: true }; continue }
    const L = b.links[c.id] || {}
    const params = {}
    for (const k of Object.keys(c.params)) {
      if (L[k] && L[k].length) params[k] = same(c.params[k], o.params[k]) ? 'link' : 'over'
      else if (!same(c.params[k], o.params[k])) params[k] = 'over'
    }
    out[c.id] = {
      user: false, params,
      attach: !ATTACH_KEYS.every((k) => same(c.attach[k], o.attach[k])) || c.parent !== o.parent,
      pose: !sameVec(c.t, o.t, T_TOL) || !sameVec(c.q, o.q, Q_TOL),
      mass: !same(c.massKg, o.massKg), material: !same(c.material, o.material), name: !same(c.name, o.name), sym: !same(c.sym, o.sym)
    }
  }
  return out
}

/** 基线件换回基线那份，但隐藏 / 锁定是视图与编辑状态、不算改写（不进改写清单），留着当前的 */
const baseWithState = (o, c) => ({ ...clone(o), hidden: c.hidden === true, locked: c.locked === true })

/**
 * 恢复为驱动值：what = 参数键（恢复该参数）/ 'pose'（安装与位置）/ 'mass' / 'material' / 'name' / 'sym'（对称）/ 'all'（整件）。
 * 返回新文档；该件不是基线件、已锁定（同编辑命令：锁定件不改）或没什么可恢复 → null。'all' 不动隐藏 / 锁定。
 */
export function resetToBase(doc0, compId, what = 'all') {
  const doc = normalizeAssembly(doc0)
  if (!isDriven(doc)) return null
  const b = driveBase(doc.drive.spec)
  const o = b.ok ? b.byId.get(compId) : null
  const i = doc.comps.findIndex((c) => c.id === compId)
  if (!o || i < 0 || doc.comps[i].locked) return null
  const c = clone(doc.comps[i])
  if (what === 'all') doc.comps[i] = baseWithState(o, c)
  else if (what === 'pose') { c.parent = o.parent; c.attach = clone(o.attach); if (o.t) c.t = clone(o.t); else delete c.t; if (o.q) c.q = clone(o.q); else delete c.q; doc.comps[i] = c }
  else if (what === 'mass') { c.massKg = o.massKg; doc.comps[i] = c }
  else if (what === 'material') { c.material = o.material; doc.comps[i] = c }
  else if (what === 'name') { c.name = o.name; doc.comps[i] = c }
  else if (what === 'sym') { c.sym = clone(o.sym); doc.comps[i] = c }
  else if (Object.hasOwn(o.params, what)) { c.params = { ...c.params, [what]: clone(o.params[what]) }; doc.comps[i] = c }
  else return null
  const out = normalizeAssembly(doc)
  return canon(out) === canon(normalizeAssembly(doc0)) ? null : out
}

/**
 * 全部改写一次恢复（一个文档、一步撤销）：基线件换回基线那份（隐藏 / 锁定留着当前的）；锁定件、用户件与用户删掉的基线件不动。
 * 没什么可恢复 → null。
 */
export function resetAllOverrides(doc0) {
  const doc = normalizeAssembly(doc0)
  if (!isDriven(doc)) return null
  const b = driveBase(doc.drive.spec)
  if (!b.ok) return null
  doc.comps = doc.comps.map((c) => (b.byId.has(c.id) && !c.locked ? baseWithState(b.byId.get(c.id), c) : c))
  const out = normalizeAssembly(doc)
  return canon(out) === canon(normalizeAssembly(doc0)) ? null : out
}
/** 被用户删掉的基线件 id（以后改驱动参数也不会回来的那些） */
export function suppressedIds(doc) {
  if (!isDriven(doc)) return []
  const b = driveBase(doc.drive.spec)
  if (!b.ok) return []
  const have = new Set(doc.comps.map((c) => c.id))
  return b.comps.filter((c) => !have.has(c.id)).map((c) => c.id)
}
/** 找回删掉的基线件（按基线顺序插回；父件也被删了的一并找回）。没有可找回的 → null。 */
export function restoreSuppressed(doc0) {
  const doc = normalizeAssembly(doc0)
  if (!isDriven(doc)) return null
  const b = driveBase(doc.drive.spec)
  if (!b.ok) return null
  const have = new Set(doc.comps.map((c) => c.id))
  if (b.comps.every((c) => have.has(c.id))) return null
  const comps = [], cur = new Map(doc.comps.map((c) => [c.id, c]))
  for (const c of b.comps) comps.push(cur.has(c.id) ? cur.get(c.id) : clone(c))
  for (const c of doc.comps) if (!b.byId.has(c.id)) comps.push(c)
  const out = normalizeAssembly({ ...doc, comps })
  return validateAssembly(out).ok ? out : null
}

/** 解除驱动：组件原样留下，从此是普通装配件（快速设置不再可用；适合要完全手工布局的场合）。 */
export function detachDrive(doc) {
  const d = normalizeAssembly(doc)
  delete d.drive
  return d
}

/** 驱动参数里 normalizeDrive 的再出口（调用方不必再 import assembly.mjs）。 */
export { normalizeDrive }
