// 导入后自动分析（wbStore.postImport：单位推断 → 部件分割 → 表面 / 体积 / 闭合性）的提交口径（体检 2026-10-16 二.25）。
//
// 分析要跑几秒到几十秒，期间用户可能已经打开这件改了名、改了单位 / 本体轴，或自己点过「自动识别」。原来分析收尾按开头取的快照
// 整份 saveMeta（主进程逐字段整段覆盖）：用户这期间的改动被回滚；反过来用户那边整份落盘，又把刚写进去的部件表清空。
// 现在分析只提交它自己算出的字段，按三方合并——base = 分析开始时的快照、ours = 分析结果、theirs = 此刻那份（库里的；该件正开着时
// 是工作副本，含未存改动）：
//   · parts / attachPoints / solarPanelGroups：theirs 已与 base 不同（用户改过、自己识别过）→ 以用户的为准，不提交；
//   · geometry：只提交分析量出来的几项（包围盒 / 包围半径 / 表面积 / 体积 / 闭合 / 质心），三角形数等其余字段照 theirs；
//   · units：分析自动补的单位，只在用户这期间没写下任何按旧比例的本体系量时提交——单位、原点偏移、部件 / 挂点 / 太阳翼组、
//     质量特性都没碰过（只转了本体轴不算：转动与比例无关）；否则硬换单位，那些量就和几何脱开；
//   · 口径变了（用户改了比例 / 本体轴）：分析结果按 base → theirs 的同一个变换换过去再提交，与用户在「单位 / 本体轴」节里改时
//     作用到全部本体系量的整体变换是同一套（wbLogic.rescaleMeta → reframeMeta → retranslateMeta）。
// 合并是幂等的：theirs 里已经有这份结果时什么都不提交（工作台在晚到的加载上再并一次无害）。
// 纯逻辑，无 three / vue / DOM（packages/core/test/modelWorkbench.test.mjs 直接 import）；引 packages/core 走相对路径（同 wbLogic.js）。
import { rescaleMeta, reframeMeta, retranslateMeta, sameRotation } from './wbLogic.js'
import { DEFAULT_Q_MODEL2BODY } from '../../packages/core/models/bodyFrame.mjs'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
// 键序无关的比较：工作副本里改过的对象键序会变，按原串比会把「没改」误判成「改过」
const stable = (v) => JSON.stringify(v === undefined ? null : v, (_k, x) => (isObj(x) ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o }, {}) : x))
const same = (a, b) => stable(a) === stable(b)

/** 分析自己算出、可以整字段提交的几项 */
export const POST_IMPORT_FIELDS = Object.freeze(['parts', 'attachPoints', 'solarPanelGroups'])
/** geometry 里分析量出来的几项（三角形数是 glb 的事实，由主进程定） */
export const POST_IMPORT_GEOM = Object.freeze(['bboxM', 'boundingRadiusM', 'areaM2', 'volumeM3', 'closed', 'centroidM'])
const BASIS_KEYS = ['units', 'frame', 'parts', 'attachPoints', 'solarPanelGroups', 'massProps', 'geometry']

/** 三方合并用得到的字段（工作台留最近几件分析完的 base / ours 给晚到的加载补并：只留这几项，不囤整份元数据） */
export function postImportBasis(meta) {
  const m = isObj(meta) ? meta : {}
  const out = {}
  for (const k of BASIS_KEYS) if (m[k] !== undefined) out[k] = plain(m[k])
  return out
}

const scaleOf = (m) => { const s = m && isObj(m.units) ? m.units.scaleToMeters : null; return isNum(s) && s > 0 ? s : 1 }
const qOf = (m) => {
  const f = m && isObj(m.frame) ? m.frame : null
  return f && Array.isArray(f.q_model2body) && f.q_model2body.length === 4 && f.q_model2body.every(isNum) ? f.q_model2body.slice() : DEFAULT_Q_MODEL2BODY.slice()
}
const tOf = (m) => { const f = m && isObj(m.frame) ? m.frame : null; return f && isVec3(f.t_model2body) ? f.t_model2body.slice() : [0, 0, 0] }
const sameT = (a, b) => { const ta = tOf(a), tb = tOf(b); return ta.every((v, k) => Math.abs(v - tb[k]) <= 1e-12 * Math.max(1, Math.abs(v), Math.abs(tb[k]))) }
/** 口径（比例 + 本体轴 q / t）相同 */
const sameBasis = (a, b) => Math.abs(scaleOf(a) / scaleOf(b) - 1) <= 1e-12 && sameRotation(qOf(a), qOf(b), 1e-6) && sameT(a, b)
/**
 * 按 from 口径算出的本体系量换到 to 口径：p₁ = ΔR·k·(p₀ − t₀) + t₁，ΔR = R(q₁)·R(q₀)ᵀ，k = s₁ / s₀；
 * 方向只转、长度 ×k、面积 ×k²、体积 ×k³，模型轴米的 bboxM ×k（wbLogic 的三个整体变换依次作用）。
 */
function toBasis(calc, from, to) {
  let x = { ...plain(calc), frame: { q_model2body: qOf(from), t_model2body: tOf(from) } }
  const k = scaleOf(to) / scaleOf(from)
  if (Math.abs(k - 1) > 1e-12) x = rescaleMeta(x, k)
  if (!sameRotation(qOf(from), qOf(to), 1e-6)) x = reframeMeta(x, qOf(from), qOf(to))
  const t = tOf(x), t1 = tOf(to)
  const d = [t1[0] - t[0], t1[1] - t[1], t1[2] - t[2]]
  if (d.some((v) => Math.abs(v) > 1e-12)) x = retranslateMeta(x, d)
  return x
}

/**
 * @param {object} base   分析开始时取的元数据快照
 * @param {object} ours   分析结果（base + 自动补的单位 + 分割 / 表面体积的结果；本体系量按 ours 的单位、base 的本体轴）
 * @param {object} theirs 此刻那份（库里的；该件正开着时是工作副本，含未存改动）
 * @returns {object|null} 要提交的字段（只含 parts / attachPoints / solarPanelGroups / geometry / units 里真要变的几项）；没有 null
 */
export function postImportPatch(base, ours, theirs) {
  if (!isObj(base) || !isObj(ours) || !isObj(theirs)) return null
  const tc = Object.create(null)   // 每个字段只比一次（大件的部件表序列化一次就是几 MB）
  const touched = (k) => (k in tc ? tc[k] : (tc[k] = !same(theirs[k], base[k])))
  const autoUnits = !same(ours.units, base.units)
  const keepUnits = autoUnits && !touched('units') && sameT(theirs, base) && !POST_IMPORT_FIELDS.some(touched) && !touched('massProps')
  // 分析结果的口径 = ours 的单位 + base 的本体轴；提交目标 = 提交自动单位时是 ours 的单位 + theirs 的本体轴，否则 = theirs 的单位与本体轴
  const from = { units: ours.units, frame: base.frame }
  const to = keepUnits ? { units: ours.units, frame: theirs.frame } : theirs
  const calc = {}
  for (const k of [...POST_IMPORT_FIELDS, 'geometry']) if (ours[k] !== undefined) calc[k] = ours[k]
  const m = sameBasis(from, to) ? plain(calc) : toBasis(calc, from, to)
  const patch = {}
  for (const k of POST_IMPORT_FIELDS) if (m[k] !== undefined && !touched(k) && !same(m[k], theirs[k])) patch[k] = m[k]
  const g0 = isObj(theirs.geometry) ? theirs.geometry : {}
  const g = plain(g0)
  let gd = false
  if (isObj(m.geometry)) for (const k of POST_IMPORT_GEOM) if (m.geometry[k] !== undefined && !same(m.geometry[k], g0[k])) { g[k] = plain(m.geometry[k]); gd = true }
  if (gd) patch.geometry = g
  if (keepUnits && !same(ours.units, theirs.units)) patch.units = plain(ours.units)
  return Object.keys(patch).length ? patch : null
}
