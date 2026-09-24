// 模型工作台的纯逻辑：库页筛选 / 分段、读数格式化、元数据随轴向与缩放的整体变换、参数化表单的 spec 路径工具、
// 部件合并拆分、JSON 进出。无 three / vue / DOM —— node 单测直接 import（packages/core/test/modelWorkbench.test.mjs）。
//
// ★ 引 packages/core 一律走相对路径（不用 @core 别名）：单测是裸 node 跑的，认不得 vite 别名；
//   渲染端 vite 对相对路径照样解析，两边同一份文件。
import { quatToMat, quatNormalize, matToQuat, quatCanonical, DEFAULT_Q_MODEL2BODY, Q_STK, Q_YUP_ZENITH } from '../../packages/core/models/bodyFrame.mjs'
import { importDefaultQOf } from '../../packages/core/models/schema.mjs'

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isVec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(isNum)
const plain = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

// ───────────────────────────── 库页：类别 / 分段 / 搜索 ─────────────────────────────

/** 类别（ModelMeta.group 优先、kind 兜底）→ 界面名；顺序即下拉顺序 */
export const CATEGORIES = [
  { key: 'spacecraft', label: '航天器' }, { key: 'deepspace', label: '深空' }, { key: 'station', label: '空间站' },
  { key: 'component', label: '部件' }, { key: 'ground', label: '地面' }, { key: 'crewed', label: '载人' },
  { key: 'launcher', label: '运载' }, { key: 'aircraft', label: '飞机' }, { key: 'ship', label: '船舶' }, { key: 'vehicle', label: '车辆' },
  { key: 'other', label: '其他' }
]
export const categoryOf = (e) => (e && (e.group || e.kind)) || 'other'

/**
 * 分段（互相不排斥：一条内置 NASA 模型同时属于「内置」和「云端」）。口径：
 *   内置   随包带了至少一档（local.builtin 非空）
 *   已下载 远端条目有一档在本机缓存里就绪、且不是随包那几档
 *   云端   来自远端清单（origin = 'remote'），含已下载的
 *   本机   用户导入（source.kind = user），不含 STK
 *   STK    本机 STK 导入件（source.kind = stk-local）
 *   参数化 参数化模板与另存的参数化模型（source.kind = param）
 *   装配   装配件（asm:，spec.kind = assembly）与内置实体模板（ent:，运行时现生成）
 */
export const SEGMENTS = [
  { key: 'all', label: '全部', tip: '全部模型' },
  { key: 'builtin', label: '内置', tip: '随安装包分发、离线可用' },
  { key: 'cached', label: '已下载', tip: '云端模型中已在本机缓存的' },
  { key: 'cloud', label: '云端', tip: '云端模型库的全部条目（含已下载）' },
  { key: 'local', label: '本机', tip: '本机导入的模型' },
  { key: 'stk', label: 'STK', tip: '从本机 STK 目录导入的模型（不可导出、不可分发）' },
  { key: 'param', label: '参数化', tip: '参数化模板与另存的参数化模型' },
  { key: 'asm', label: '装配', tip: '装配件与实体模板' }
]
const LODS = ['lod0', 'lod1', 'lod2']

/** 一条目的分段归属与就绪状态（纯读数，库卡片与筛选共用） */
export function entryFacts(e) {
  const loc = (e && e.local) || {}
  const src = (e && e.source) || {}
  const builtinLods = Array.isArray(loc.builtin) ? loc.builtin.filter((l) => LODS.includes(l)) : []
  const readyLods = LODS.filter((l) => loc[l] === 'ready')
  const param = src.kind === 'param' || (typeof e?.id === 'string' && e.id.startsWith('param:'))
  const stk = src.kind === 'stk-local' || (typeof e?.id === 'string' && e.id.startsWith('stk:'))
  const user = !param && !stk && (src.kind === 'user' || e?.origin === 'user')
  const asm = (typeof e?.id === 'string' && e.id.startsWith('asm:')) || !!(e && e.spec && e.spec.kind === 'assembly')
  const ent = typeof e?.id === 'string' && e.id.startsWith('ent:')
  const remote = !param && !stk && !user && (e?.origin === 'remote' || (e?.origin == null && (src.kind === 'nasa' || src.kind === 'community')))
  const cachedLods = readyLods.filter((l) => !builtinLods.includes(l))
  return {
    builtin: builtinLods.length > 0,
    cached: remote && cachedLods.length > 0,
    cloud: remote,
    local: user,
    stk,
    param,
    asm: asm || ent,                             // 「装配」分段：装配件 + 实体模板
    ent,
    ready: param || ent || readyLods.length > 0, // 本机能直接出图（参数化 / 实体模板现场生成）
    partial: LODS.some((l) => loc[l] === 'partial'),
    readyLods,
    hasThumb: loc.thumb === 'ready' || !!(e && e.files && e.files.thumb)
  }
}

export function matchSegment(e, seg) {
  if (!seg || seg === 'all') return true
  const f = entryFacts(e)
  return !!f[seg]
}

// 搜索归一：大小写、全角半角、连字符 / 空白都不算差别（「TDRS-A」「tdrs a」「ＴＤＲＳ」同一个）
export function normText(s) {
  return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[\s_\-–—·.()（）]+/g, '')
}
export function matchQuery(e, q) {
  const nq = normText(q)
  if (!nq) return true
  const hay = [e.title, e.titleZh, e.id, ...(Array.isArray(e.tags) ? e.tags : []), ...(Array.isArray(e.aliases) ? e.aliases : [])]
  return hay.some((s) => normText(s).includes(nq))
}

/** 界面显示名：中文界面取中文名（没有才英文名），英文界面取英文名 */
export function displayName(e, lang = 'zh') {
  if (!e) return ''
  if (lang === 'en') return e.title || e.titleZh || e.id || ''
  return e.titleZh || e.title || e.id || ''
}

/**
 * 库页筛选 + 排序。排序：参数化模板按目录顺序排在参数化段前面；其余按显示名（中文按拼音序）。
 * @param {object[]} list
 * @param {{seg?:string, cat?:string, q?:string, lang?:string}} o
 */
export function filterEntries(list, o = {}) {
  const out = []
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || !e.id) continue
    if (!matchSegment(e, o.seg)) continue
    if (o.cat && o.cat !== 'all' && categoryOf(e) !== o.cat) continue
    if (!matchQuery(e, o.q)) continue
    out.push(e)
  }
  const lang = o.lang || 'zh'
  const coll = new Intl.Collator(lang === 'en' ? 'en' : 'zh-Hans-CN', { numeric: true, sensitivity: 'base' })
  const rank = (e) => (Number.isInteger(e.tplOrder) ? e.tplOrder : 1e6)
  return out.sort((a, b) => (rank(a) - rank(b)) || coll.compare(displayName(a, lang), displayName(b, lang)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ───────────────────────────── 读数格式化（结果区只出数字） ─────────────────────────────

export function fmtInt(n) {
  if (!isNum(n)) return '—'
  return Math.round(n).toLocaleString('en-US')
}
/** 有效数字 sig 位、去尾零；|v| ≥ 1e6 或 < 1e-4 用科学计数 */
export function fmtNum(v, sig = 4) {
  if (!isNum(v)) return '—'
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e6 || a < 1e-4) return v.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, 'e')
  const d = Math.max(0, sig - 1 - Math.floor(Math.log10(a)))
  return String(Number(v.toFixed(Math.min(12, d))))
}
export function fmtBytes(n) {
  if (!isNum(n) || n < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + u[i]
}
/** 包围盒三边（m）读数：24.5 × 3.1 × 6.8 */
export function fmtBox(bb) {
  if (!bb || !isVec3(bb.min) || !isVec3(bb.max)) return '—'
  return [0, 1, 2].map((k) => fmtNum(bb.max[k] - bb.min[k], 3)).join(' × ')
}
export function fmtVec(v, sig = 4) { return isVec3(v) ? v.map((x) => fmtNum(x, sig)).join(', ') : '—' }

// ───────────────────────────── 元数据整体变换（轴向 / 缩放） ─────────────────────────────
//
// 为什么要整体变换：挂点、部件质心 / 法向 / 拟合、质心与惯量这些本体系量都是「贴在几何上」的。
// 用户在「本体轴」里把模型转 90° 或在「单位」里改比例，几何在本体系里跟着动了，这些量不跟着动就和模型脱开
// （挂点悬在半空、质心落在星体外）。所以一律按同一个变换作用到全部本体系量上——与 CAD 里「标注属于零件」同一口径。

const mat3Vec = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]]
const mat3Mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const mat3T = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]))
const z0 = (v) => (Math.abs(v) < 1e-15 ? 0 : v)

/** 对 meta 里全部本体系量施加 p' = f(p)（点）、d' = g(d)（方向）；inertia 另给 h(I)。原地改写并返回 meta。 */
function mapBodyQuantities(meta, pt, dir, inertia, lenK, areaK) {
  const P = (v) => (isVec3(v) ? pt(v).map(z0) : v)
  const D = (v) => (isVec3(v) ? dir(v).map(z0) : v)
  for (const a of Array.isArray(meta.attachPoints) ? meta.attachPoints : []) {
    if (!isObj(a)) continue
    a.posBody = P(a.posBody); a.dirBody = D(a.dirBody); a.upBody = D(a.upBody)
  }
  for (const p of Array.isArray(meta.parts) ? meta.parts : []) {
    if (!isObj(p)) continue
    if (isVec3(p.centroidBody)) p.centroidBody = P(p.centroidBody)
    if (isVec3(p.comBody)) p.comBody = P(p.comBody)
    if (isVec3(p.normalBody)) p.normalBody = D(p.normalBody)
    if (isNum(p.areaM2)) p.areaM2 *= areaK
    if (isNum(p.surfaceM2)) p.surfaceM2 *= areaK
    if (isVec3(p.extentsM)) p.extentsM = p.extentsM.map((x) => x * lenK)
    const f = p.fitted
    if (isObj(f)) {
      for (const k of ['vertexBody', 'focusBody']) if (isVec3(f[k])) f[k] = P(f[k])
      if (isVec3(f.axisBody)) f.axisBody = D(f.axisBody)
      for (const k of ['focalM', 'diameterM', 'offsetM']) if (isNum(f[k])) f[k] *= lenK
    }
  }
  const mp = meta.massProps
  if (isObj(mp)) {
    if (isVec3(mp.comBody)) mp.comBody = P(mp.comBody)
    if (Array.isArray(mp.inertiaBody) && mp.inertiaBody.length === 3 && mp.inertiaBody.every(isVec3)) mp.inertiaBody = inertia(mp.inertiaBody).map((r) => r.map(z0))
  }
  const g = meta.geometry
  if (isObj(g)) {
    if (isVec3(g.centroidM)) g.centroidM = P(g.centroidM)
    if (isNum(g.boundingRadiusM)) g.boundingRadiusM *= lenK
    if (isNum(g.areaM2)) g.areaM2 *= areaK
    if (isNum(g.volumeM3)) g.volumeM3 *= lenK * lenK * lenK
  }
  return meta
}

// ───────────────────────────── 包围盒口径（轴映射终案 ④） ─────────────────────────────
// geometry.bboxM = 【模型轴、米】（顶点的模型系坐标 × scaleToMeters，关节初值位姿、只算可见件）。本体系尺寸不落盘，
// 由 frame 现算（bodyBoxOfMeta）：换轴向 / 平移原点都不改落盘的 bboxM，只有缩放改它（×k）。

/** 本体系 → 模型轴米（v_model·s = Rᵀ(v_body − t)）的包围盒：8 个角点变过去再取外包（轴向是 90° 倍数时就是精确的）。 */
export function bodyBoxToModelBox(bb, frame) {
  if (!bb || !isVec3(bb.min) || !isVec3(bb.max)) return null
  const f = isObj(frame) ? frame : {}
  const R = quatToMat(Array.isArray(f.q_model2body) && f.q_model2body.length === 4 ? f.q_model2body : DEFAULT_Q_MODEL2BODY)
  if (!R) return null
  const t = isVec3(f.t_model2body) ? f.t_model2body : [0, 0, 0]
  return boxCorners(bb, (p) => mat3Vec(mat3T(R), [p[0] - t[0], p[1] - t[1], p[2] - t[2]]))
}
/** 模型轴米 → 本体系（v_body = R·v + t）的包围盒；meta 缺 geometry.bboxM 返回 null。库卡片 title / 反算兜底用。 */
export function bodyBoxOfMeta(meta) {
  const g = meta && meta.geometry
  const bb = g && g.bboxM
  if (!bb || !isVec3(bb.min) || !isVec3(bb.max)) return null
  const f = isObj(meta.frame) ? meta.frame : {}
  const R = quatToMat(Array.isArray(f.q_model2body) && f.q_model2body.length === 4 ? f.q_model2body : DEFAULT_Q_MODEL2BODY)
  if (!R) return null
  const t = isVec3(f.t_model2body) ? f.t_model2body : [0, 0, 0]
  return boxCorners(bb, (p) => { const v = mat3Vec(R, p); return [v[0] + t[0], v[1] + t[1], v[2] + t[2]] })
}
function boxCorners(bb, fn) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const q = fn([c & 1 ? bb.max[0] : bb.min[0], c & 2 ? bb.max[1] : bb.min[1], c & 4 ? bb.max[2] : bb.min[2]])
    for (let k = 0; k < 3; k++) { if (q[k] < mn[k]) mn[k] = q[k]; if (q[k] > mx[k]) mx[k] = q[k] }
  }
  // 纯 90° 轴向下角点逐分量是 ±原值：抹掉 1e-15 级的舍入与 −0
  const cl = (v) => { const r = Math.round(v * 1e9) / 1e9; return Math.abs(r - v) < 1e-12 ? (r === 0 ? 0 : r) : v }
  return { min: mn.map(cl), max: mx.map(cl) }
}

/**
 * 缩放改变（scaleToMeters 由 s 变成 k·s）：本体系一切长度 ×k、面积 ×k²、体积 ×k³、惯量 ×k²（质量不变）；
 * 原点偏移 t 也 ×k（整个本体系内容绕本体原点等比缩放，贴在几何上的点仍贴着几何）；模型轴米的 bboxM 同样 ×k。
 * 返回新对象（不改入参）。
 */
export function rescaleMeta(meta, k) {
  const m = plain(meta || {})
  if (!(isNum(k) && k > 0) || k === 1) return m
  const f = isObj(m.frame) ? m.frame : (m.frame = {})
  if (isVec3(f.t_model2body)) f.t_model2body = f.t_model2body.map((x) => z0(x * k))
  if (isObj(m.geometry) && isObj(m.geometry.bboxM)) {
    const b = m.geometry.bboxM
    if (isVec3(b.min) && isVec3(b.max)) { b.min = b.min.map((x) => x * k); b.max = b.max.map((x) => x * k) }
  }
  return mapBodyQuantities(m, (v) => v.map((x) => x * k), (v) => v.slice(), (I) => I.map((r) => r.map((x) => x * k * k)), k, k * k)
}

/**
 * 轴向改变（q_model2body 由 qOld 变成 qNew）：模型在本体系里绕原点整体转了 ΔR = R(qNew)·R(qOld)ᵀ，
 * 本体系量同转：点 / 方向 ×ΔR，惯量 ΔR·I·ΔRᵀ，t → ΔR·t。返回新对象（不改入参）；q 非法时原样返回拷贝。
 */
export function reframeMeta(meta, qOld, qNew) {
  const m = plain(meta || {})
  const A = quatToMat(qOld), B = quatToMat(qNew)
  if (!A || !B) return m
  const dR = mat3Mul(B, mat3T(A))
  const f = isObj(m.frame) ? m.frame : (m.frame = {})
  f.q_model2body = quatCanonical(qNew)
  if (isVec3(f.t_model2body)) f.t_model2body = mat3Vec(dR, f.t_model2body).map(z0)
  const dRt = mat3T(dR)
  return mapBodyQuantities(m, (v) => mat3Vec(dR, v), (v) => mat3Vec(dR, v), (I) => mat3Mul(mat3Mul(dR, I), dRt), 1, 1)
}

/**
 * 原点偏移改变（t_model2body 加 Δ）：模型在本体系里平移 Δ，本体系的点同平移（方向、惯量不变）。
 * 「原点移到质心」= Δ = −comBody。bboxM 是模型轴口径（平移在模型系之后），不动。返回新对象。
 */
export function retranslateMeta(meta, delta) {
  const m = plain(meta || {})
  if (!isVec3(delta) || (delta[0] === 0 && delta[1] === 0 && delta[2] === 0)) return m
  const f = isObj(m.frame) ? m.frame : (m.frame = {})
  const t = isVec3(f.t_model2body) ? f.t_model2body : [0, 0, 0]
  f.t_model2body = t.map((x, k) => z0(x + delta[k]))
  return mapBodyQuantities(m, (v) => v.map((x, k) => x + delta[k]), (v) => v.slice(), (I) => I.map((r) => r.slice()), 1, 1)
}

/**
 * 预览点选命中（viewport hitToBody：irNode / irTri / globalTri）落在哪个部件：
 * 整节点归属（parts.nodes）> 节点内三角形段（triRanges）> 全局三角形段（triRange / tris）。找不到返回 null。
 */
export function partAtHit(parts, hit) {
  if (!hit || !Array.isArray(parts)) return null
  for (const p of parts) {
    if (!isObj(p)) continue
    if (Array.isArray(p.triRanges)) {
      for (const tr of p.triRanges) {
        if (!tr || tr.node !== hit.irNode || !Array.isArray(tr.ranges)) continue
        for (const r of tr.ranges) if (hit.irTri >= r[0] && hit.irTri < r[0] + r[1]) return p
      }
    }
  }
  for (const p of parts) {
    if (isObj(p) && Array.isArray(p.nodes) && (p.nodes.includes(hit.irNode) || (hit.nodeName && p.nodes.includes(hit.nodeName)))) return p
  }
  for (const p of parts) {
    if (!isObj(p)) continue
    if (Array.isArray(p.triRange) && p.triRange.length === 2 && hit.globalTri >= p.triRange[0] && hit.globalTri < p.triRange[0] + p.triRange[1]) return p
    if (Array.isArray(p.tris) && p.tris.includes(hit.globalTri)) return p
  }
  return null
}

/** 部件角色 → 界面名 */
export const ROLE_LABEL = { bus: '平台体', solarArray: '太阳翼', reflector: '反射面', feed: '馈源', boom: '伸展臂', radiator: '散热面', thruster: '推力器', sensor: '敏感器', other: '其他' }
/** AGI stage 类型 → 界面名（单位：转角 °、平移为模型单位、缩放无量纲） */
export const STAGE_LABEL = {
  xRotate: 'X 旋转', yRotate: 'Y 旋转', zRotate: 'Z 旋转', xTranslate: 'X 平移', yTranslate: 'Y 平移', zTranslate: 'Z 平移',
  xScale: 'X 缩放', yScale: 'Y 缩放', zScale: 'Z 缩放', uniformScale: '等比缩放'
}
export const stageUnit = (type) => (/Rotate$/.test(type) ? '°' : /Translate$/.test(type) ? '' : '×')

/**
 * 离 q 最近的「90° 整数倍」朝向（带符号置换矩阵）：本体轴微调的基准。
 * 逐行取绝对值最大的列、列不许重复（贪心按全局最大元素依次定），再补正行列式为 +1 的符号。
 */
export function nearestAxisQuat(q) {
  const R = quatToMat(q)
  if (!R) return null
  const cells = []
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cells.push([Math.abs(R[i][j]), i, j])
  cells.sort((a, b) => b[0] - a[0])
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  const ri = new Set(), cj = new Set()
  for (const [, i, j] of cells) {
    if (ri.has(i) || cj.has(j)) continue
    P[i][j] = R[i][j] >= 0 ? 1 : -1
    ri.add(i); cj.add(j)
  }
  // 行列式为 −1（镜像）时把最不确定的那个元素翻号：取 |R| 最小的已选元素
  const det = P[0][0] * (P[1][1] * P[2][2] - P[1][2] * P[2][1]) - P[0][1] * (P[1][0] * P[2][2] - P[1][2] * P[2][0]) + P[0][2] * (P[1][0] * P[2][1] - P[1][1] * P[2][0])
  if (det < 0) {
    let best = null
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (P[i][j] && (!best || Math.abs(R[i][j]) < best[0])) best = [Math.abs(R[i][j]), i, j]
    P[best[1]][best[2]] *= -1
  }
  return matToQuat(P)
}

// ───────────────────────────── 参数化表单：spec 路径 ─────────────────────────────

/** 'wings[0].panelHM' → ['wings', 0, 'panelHM'] */
export function parsePath(path) {
  const out = []
  for (const seg of String(path).split('.')) {
    const m = /^([^[\]]+)((?:\[\d+\])*)$/.exec(seg)
    if (!m) return null
    out.push(m[1])
    for (const x of m[2].matchAll(/\[(\d+)\]/g)) out.push(Number(x[1]))
  }
  return out
}
export function getPath(obj, path) {
  const ks = parsePath(path)
  if (!ks) return undefined
  let o = obj
  for (const k of ks) { if (o == null) return undefined; o = o[k] }
  return o
}
/** 原地写；中间缺的层按下一个键的类型补对象 / 数组 */
export function setPath(obj, path, v) {
  const ks = parsePath(path)
  if (!ks || !ks.length) return obj
  let o = obj
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i]
    if (o[k] == null || typeof o[k] !== 'object') o[k] = typeof ks[i + 1] === 'number' ? [] : {}
    o = o[k]
  }
  o[ks[ks.length - 1]] = v
  return obj
}
/** specSources 的键：条目下标换成 [*]（'wings[1].panelHM' → 'wings[*].panelHM'） */
export const sourceKey = (path) => String(path).replace(/\[\d+\]/g, '[*]')

/** 字段的出处 title：先精确路径、再 [*] 通配；「示意值」之类的 note 一并写上 */
export function sourceTitle(specSources, path) {
  const ss = specSources || {}
  const e = ss[path] || ss[sourceKey(path)]
  if (!e) return ''
  const parts = []
  if (e.kind === 'illustrative') parts.push('示意值')
  else if (e.kind === 'derived') parts.push('推算值')
  if (e.source && e.source !== 'illustrative' && e.source !== 'derived') parts.push(e.source)
  if (e.note) parts.push(e.note)
  if (e.from && typeof e.from === 'string' && !parts.some((p) => p.includes(e.from))) parts.push(e.from)
  return parts.join('\n')
}

/**
 * 删掉数组条目 arr[i] 之后，路径表里 arr[i+1…] 的路径前移一位、arr[i] 自己的删掉（其它路径原样）。
 * 生成页的「示意值 / 已改」两张路径表靠它跟着条目走，不然描红会串到别的条目上。
 * @param {Iterable<string>} paths
 * @param {string} arr 数组字段名（'wings' / 'reflectors'）
 * @param {number} i 删掉的下标
 * @returns {string[]}
 */
export function shiftIndexedPaths(paths, arr, i) {
  const esc = String(arr).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('^' + esc + '\\[(\\d+)\\]')
  const out = []
  for (const p of paths) {
    const m = re.exec(p)
    if (!m) { out.push(p); continue }
    const k = Number(m[1])
    if (k === i) continue
    out.push(k > i ? p.replace(re, `${arr}[${k - 1}]`) : p)
  }
  return out
}

/** 某路径是否被 illustrative / missing 列表点名（条目整体被点名时其字段也算） */
export function pathFlagged(list, path) {
  if (!Array.isArray(list) || !list.length) return false
  const p = String(path)
  return list.some((x) => x === p || p.startsWith(x + '.') || p.startsWith(x + '['))
}

// ───────────────────────────── 名称 / 部件 ─────────────────────────────

/** base、base_2、base_3…里第一个没被占的（AGI 名字不许空白，空白换成下划线） */
export function uniqueName(base, taken) {
  const b = String(base || 'item').trim().replace(/\s+/g, '_') || 'item'
  const t = taken instanceof Set ? taken : new Set(taken || [])
  if (!t.has(b)) return b
  let k = 2
  while (t.has(`${b}_${k}`)) k++
  return `${b}_${k}`
}

/** 部件的组件质量表（combineComponents 的入参）：只收质量为正的；质心取 comBody（手填）> centroidBody（分割给的） */
export function partsAsComponents(parts) {
  const out = []
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!isObj(p) || !(isNum(p.massKg) && p.massKg > 0)) continue
    const c = isVec3(p.comBody) ? p.comBody : isVec3(p.centroidBody) ? p.centroidBody : null
    if (c) out.push({ massKg: p.massKg, comBody: c.slice(), name: p.name || p.id })
  }
  return out
}

/** 合并若干部件为一个（第一个的 id / 名称 / 角色；节点、三角形段并起来；读数量相加 / 按面积加权） */
export function mergeParts(parts, ids) {
  const list = Array.isArray(parts) ? parts : []
  const pick = list.filter((p) => ids.includes(p.id))
  if (pick.length < 2) return list.slice()
  const base = plain(pick[0])
  const nodes = new Set(), tri = new Map()
  let area = 0, cx = 0, cy = 0, cz = 0, wsum = 0, mass = 0
  for (const p of pick) {
    for (const n of Array.isArray(p.nodes) ? p.nodes : []) nodes.add(n)
    for (const tr of Array.isArray(p.triRanges) ? p.triRanges : []) {
      const k = tr.node
      if (!tri.has(k)) tri.set(k, { node: tr.node, mesh: tr.mesh, ranges: [] })
      tri.get(k).ranges.push(...(Array.isArray(tr.ranges) ? tr.ranges.map((r) => r.slice()) : []))
    }
    const a = isNum(p.areaM2) ? p.areaM2 : 0
    area += a
    if (isVec3(p.centroidBody) && a > 0) { cx += p.centroidBody[0] * a; cy += p.centroidBody[1] * a; cz += p.centroidBody[2] * a; wsum += a }
    if (isNum(p.massKg)) mass += p.massKg
  }
  base.nodes = [...nodes]
  if (tri.size) base.triRanges = [...tri.values()]
  else delete base.triRanges
  delete base.triRange   // 并起来的三角形一般不再连续
  const tris = pick.reduce((s, p) => s + (isNum(p.tris) ? p.tris : 0), 0)
  if (tris > 0) base.tris = tris; else delete base.tris
  base.areaM2 = area
  if (wsum > 0) base.centroidBody = [cx / wsum, cy / wsum, cz / wsum]
  if (mass > 0) base.massKg = mass
  delete base.fitted       // 合并后的形状不再是那一面抛物面
  const out = []
  let placed = false
  for (const p of list) {
    if (!ids.includes(p.id)) { out.push(p); continue }
    if (!placed) { out.push(base); placed = true }
  }
  return out
}

/** 按节点拆分：一个部件带 n 个节点 → n 个部件（每个只挂一个节点；三角形段按节点归属分过去） */
export function splitPartByNodes(parts, id) {
  const list = Array.isArray(parts) ? parts : []
  const p = list.find((x) => x.id === id)
  if (!p) return list.slice()
  const nodes = [...new Set([...(Array.isArray(p.nodes) ? p.nodes : []), ...(Array.isArray(p.triRanges) ? p.triRanges.map((t) => t.node) : [])])]
  if (nodes.length < 2) return list.slice()
  const taken = new Set(list.map((x) => x.id))
  const names = new Set(list.map((x) => x.name))
  const made = nodes.map((n, i) => {
    const o = { id: i === 0 ? p.id : uniqueName(p.id, taken), name: i === 0 ? p.name : uniqueName(`${p.name}_${n}`, names), role: p.role }
    taken.add(o.id); names.add(o.name)
    if ((p.nodes || []).includes(n)) o.nodes = [n]
    else o.nodes = []
    const tr = (p.triRanges || []).filter((t) => t.node === n)
    if (tr.length) o.triRanges = plain(tr)
    if (p.confirmed) o.confirmed = true
    return o
  })
  const out = []
  for (const x of list) { if (x.id === id) out.push(...made); else out.push(x) }
  return out
}

/**
 * 把部件分割（segment.mjs autoSegment）的结果并进元数据。规则：
 *   · parts 整份换成新结果（手填的质量 / 确认标记按部件名继承过去——重新识别不丢用户已做的事）；
 *   · 挂点：已有挂点（STK 的 AGI 挂点 / 手点的 / 上一次识别的）就一个不动 —— 自动挂点只在模型一个挂点都没有时补进来
 *     （STK 的 tdrs 自带 5 个挂点，再补 3 个「反射面焦点」就是重复的同一副天线）；
 *   · 太阳翼组：已有就不动（STK 的组是 AGI 元数据、比几何识别可信），没有才用自动的。
 * @returns 新 meta（不改入参）
 */
export function mergeSegment(meta, seg) {
  const m = plain(meta || {})
  if (!isObj(seg)) return m
  const oldByName = new Map((Array.isArray(m.parts) ? m.parts : []).map((p) => [p.name, p]))
  m.parts = (Array.isArray(seg.parts) ? seg.parts : []).map((p) => {
    const o = plain(p)
    const old = oldByName.get(o.name)
    if (old) {
      if (isNum(old.massKg)) o.massKg = old.massKg
      if (isVec3(old.comBody)) o.comBody = old.comBody.slice()
      if (old.confirmed) o.confirmed = true
      if (old.role && old.roleManual) { o.role = old.role; o.roleManual = true }
    }
    return o
  })
  const aps = Array.isArray(m.attachPoints) ? m.attachPoints : (m.attachPoints = [])
  const apNames = new Set(aps.map((a) => a.name))
  for (const a of aps.length ? [] : (Array.isArray(seg.attachPoints) ? seg.attachPoints : [])) {
    if (!isObj(a) || !a.name || apNames.has(a.name)) continue
    const o = { name: a.name, posBody: a.posBody, dirBody: a.dirBody }
    if (isVec3(a.upBody)) o.upBody = a.upBody
    aps.push(plain(o)); apNames.add(a.name)
  }
  if (!(Array.isArray(m.solarPanelGroups) && m.solarPanelGroups.length)) {
    m.solarPanelGroups = (Array.isArray(seg.solarPanelGroups) ? seg.solarPanelGroups : []).map((g) => ({ name: g.name, nodes: Array.isArray(g.nodes) ? g.nodes.slice() : [], efficiency: isNum(g.efficiency) ? g.efficiency : 28 }))
  }
  return m
}

// ───────────────────────────── JSON 进出 ─────────────────────────────

// 工作台允许从 JSON 覆盖的字段（与主进程 saveMeta 的 EDITABLE 同一张表的子集：id / source / files 永远以库里为准）
export const JSON_FIELDS = ['title', 'titleZh', 'kind', 'group', 'fidelity', 'units', 'frame', 'parts', 'massProps',
  'attachPoints', 'articulations', 'solarPanelGroups', 'noObscurationNodes', 'tags', 'aliases']

/**
 * JSON 导入：整份 ModelMeta（有 schema / id / frame 之一）→ 覆盖 JSON_FIELDS；
 * 挂点子集（数组，或 {attachPoints:[…]} 且没有别的元数据字段）→ 只换挂点。
 * @returns {{ok:boolean, meta?:object, what?:'meta'|'attach', error?:string, fields?:string[]}}
 */
export function applyJsonImport(meta, json) {
  const m = plain(meta || {})
  if (Array.isArray(json)) {
    if (!json.every((a) => isObj(a) && typeof a.name === 'string' && isVec3(a.posBody))) return { ok: false, error: '挂点数组格式不对。' }
    m.attachPoints = plain(json)
    return { ok: true, meta: m, what: 'attach', fields: ['attachPoints'] }
  }
  if (!isObj(json)) return { ok: false, error: '不是 JSON 对象。' }
  const keys = Object.keys(json)
  if (keys.length && keys.every((k) => k === 'attachPoints')) {
    if (!Array.isArray(json.attachPoints)) return { ok: false, error: '挂点数组格式不对。' }
    m.attachPoints = plain(json.attachPoints)
    return { ok: true, meta: m, what: 'attach', fields: ['attachPoints'] }
  }
  const fields = JSON_FIELDS.filter((k) => json[k] !== undefined)
  if (!fields.length) return { ok: false, error: '没有可用的元数据字段。' }
  for (const k of fields) m[k] = plain(json[k])
  return { ok: true, meta: m, what: 'meta', fields }
}

/** 导出：ModelMeta 全量（去掉本机专用的 local / origin 等）与挂点子集 */
export function metaForExport(meta) {
  const m = plain(meta || {})
  for (const k of ['local', 'origin', 'builtin', 'builtinFiles', 'overridesId', 'tplOrder', 'templateId', 'needsInput']) delete m[k]
  return m
}
export function attachSubset(meta) { return { attachPoints: plain((meta && meta.attachPoints) || []) } }

// ───────────────────────────── 杂项 ─────────────────────────────

/** 字节数组 → 显示用的 MB（十进制，库清单体积口径） */
export const toMB = (n) => (isNum(n) ? n / 1e6 : null)

/** 从文件名取扩展名（小写，不带点） */
export function extOf(name) { const m = /\.([^.\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : '' }
export const CAD_EXTS = ['step', 'stp', 'iges', 'igs', 'brep']
export const MESH_EXTS = ['obj', 'stl', 'fbx']
export const GLB_EXTS = ['glb', 'gltf']
export const IMPORT_EXTS = [...GLB_EXTS, ...MESH_EXTS, ...CAD_EXTS]

/** 导入格式分派 */
export function importRoute(name) {
  const e = extOf(name)
  if (GLB_EXTS.includes(e)) return 'glb'
  if (MESH_EXTS.includes(e)) return 'mesh'
  if (CAD_EXTS.includes(e)) return 'cad'
  return null
}

/**
 * 本体轴「出厂映射」= 这件东西入库时的 q_model2body（轴映射终案 ②，缺省口径见 bodyFrame.defaultImportQ）。不是一律
 * DEFAULT_Q_MODEL2BODY：那样未核的 NASA 件一点就绕本体 X 翻 180°。按下面的次序取：
 *   ① frame.importQ：入库时记下的缺省（带 extras.satsim 的取文件自带 q）。要主进程 metaFromGltf / NASA 管线写进去、
 *      schema.normalizeMeta 放行这个字段才有；没有就往下走。
 *   ② NASA 件只按来源判 → +Y 天顶（id / 类别 / 来源照传，别的字段不传）：importDefaultQOf 把「带挂点 / 关节 / 太阳翼组 /
 *      不遮挡节点」当成带 AGI 扩展，这几样在工作台里都能手加，NASA 语料却从不带 AGI 扩展。
 *   ③ STK 本机件 / 参数化件只按来源判 → STK 映射。
 *   ④ 其余（本机导入 user / 社区 community）：meta 里没记文件带没带 extras.satsim —— 渲染端转的 OBJ / STL / FBX、本工具导出件
 *      重新导入、另存出来的用户件都已烘成 STK 映射，普通 glb / glTF / STEP 是 +Y 天顶，AGI 数组又能手加，照来源 / AGI 猜总有一类
 *      猜错（烘过的件被判成 +Y 天顶，一点「出厂」天底面朝天）。改看当前 q：它最近的 90° 整数倍基准（nearestAxisQuat，与「本体轴」
 *      微调同一基准）是这两种缺省之一，就取那个基准；都不是（点过 ±90° 步进）才回到 importDefaultQOf（带 AGI → STK 映射，否则 +Y 天顶）。
 * 坏输入不抛：null / 非对象 → DEFAULT_Q_MODEL2BODY。
 * @param {object|null} meta
 * @returns {number[]} [x,y,z,w]（新数组）
 */
export function factoryFrameQ(meta) {
  if (!meta || typeof meta !== 'object') return DEFAULT_Q_MODEL2BODY.slice()
  const f = isObj(meta.frame) ? meta.frame : null
  const isQ = (v) => Array.isArray(v) && v.length === 4 && v.every(isNum)
  // ① 模长门与 normalizeMeta / metaFromGltf 同一道（0.9–1.1）：离得远的不是四元数
  if (f && isQ(f.importQ)) {
    const n = Math.hypot(f.importQ[0], f.importQ[1], f.importQ[2], f.importQ[3])
    const iq = n > 0.9 && n < 1.1 ? quatCanonical(f.importQ) : null
    if (iq) return iq
  }
  const k = meta.source && meta.source.kind
  const nasa = k === 'nasa' || ((k === 'builtin' || !k) && typeof meta.id === 'string' && meta.id.startsWith('nasa:'))
  // 只按来源（不看 AGI）的缺省：STK 映射 ⇔ 来源归到 stk-local / param（stk: 前缀、builtin 按前缀还原，同 schema.sourceKindOf）
  const bySource = importDefaultQOf({ id: meta.id, kind: meta.kind, source: meta.source })
  if (nasa || sameRotation(bySource, Q_STK, 1e-3)) return bySource   // ② / ③（24 个轴向基准彼此至少差 90°，容差放宽只防浮点）
  // ④
  const base = f && isQ(f.q_model2body) ? nearestAxisQuat(f.q_model2body) : null
  if (base) for (const c of [Q_STK, Q_YUP_ZENITH]) if (sameRotation(base, c, 1e-3)) return c.slice()
  return importDefaultQOf(meta)
}

/** 四元数归一后是否与另一个表示同一旋转（容差按角度） */
export function sameRotation(a, b, tolDeg = 1e-6) {
  const ua = quatNormalize(a), ub = quatNormalize(b)
  if (!ua || !ub) return false
  const d = Math.abs(ua[0] * ub[0] + ua[1] * ub[1] + ua[2] * ub[2] + ua[3] * ub[3])
  return 2 * Math.acos(Math.min(1, d)) * 180 / Math.PI <= tolDeg
}

// ───────────────────────────── 来源标签 ─────────────────────────────

/** 来源（source.kind）→ 概况里的全称 */
export const SOURCE_LABEL = { nasa: 'NASA 3D Resources', community: '社区', 'stk-local': 'STK 本机', user: '本机导入', param: '参数化生成', builtin: '内置' }
/** 来源 → 预览标题下的短标签（署名 / 许可全文只进 title，界面上不放整句出处） */
export const SOURCE_TAG = { nasa: 'NASA', community: '社区', 'stk-local': 'AGI STK', user: '本机导入', param: '参数化', builtin: '内置' }
export function sourceTag(meta) {
  const k = meta && meta.source && meta.source.kind
  return (k && SOURCE_TAG[k]) || ''
}

// ───────────────────────────── 导入：单位 / 作业状态 ─────────────────────────────

/**
 * STL 的单位兜底：STL 文件本身不带单位，CAD / 3D 打印导出的事实标准是毫米。包围盒最大边落在 300–3000 单位
 * （units.mjs 包围盒规则判「厘米」的那一档，毫米读法同样是 0.3–3 m 的小卫星）时按毫米；别的格式、别的档不动。
 * @param {{unitGuess:string, scaleToMeters:number, rule:string, confidence?:string, notes?:string[]}} ug guessUnits 的结果
 * @param {string} fmt 源格式
 */
export function meshUnitTieBreak(ug, fmt) {
  if (!isObj(ug) || String(fmt || '').toLowerCase() !== 'stl' || ug.rule !== 'bbox' || ug.unitGuess !== 'cm') return ug
  return { ...ug, unitGuess: 'mm', scaleToMeters: 0.001, rule: 'stl-mm', notes: [...(Array.isArray(ug.notes) ? ug.notes : []), 'STL 无单位字段，按 CAD 导出惯例取毫米'] }
}

const JOB_DONE = ['done', 'error', 'canceled']
const JOB_POST = ['analyze', 'segment', 'mass', 'thumb']
/**
 * 最近导入表从 localStorage 恢复：上次关窗时还没走完的作业不会再动了 —— 已入库的（有 modelId）记完成 + 「分析已中断」，
 * 没入库的记已取消。否则那一行永远停在「排队 / 读取」，右键也没有取消项。
 */
export function restoreJob(x) {
  const j = { ...x, live: false }
  if (!JOB_DONE.includes(j.phase)) {
    if (j.modelId) { j.phase = 'done'; j.error = [j.error, '分析已中断'].filter(Boolean).join('；') }
    else j.phase = 'canceled'
  }
  return j
}
/**
 * 这个作业现在还能不能取消：排队中的都能；CAD 在主进程 occt 里跑、按令牌取消，入库前都能；OBJ / STL / FBX 在渲染端读取 / 转换时
 * 能（写入之前查中止标志）；glb 是一次 IPC 直接入库，跑起来就停不下；入库之后的自动分析不算导入本身，不给取消。
 */
export function canCancelJob(j) {
  if (!j || !j.live) return false
  if (j.phase === 'queued') return true
  if (JOB_DONE.includes(j.phase) || JOB_POST.includes(j.phase)) return false
  if (j.route === 'cad') return !!j.token
  if (j.route === 'mesh') return j.phase === 'read' || j.phase === 'convert'
  return false
}

// ───────────────────────────── 参数化：重开已存模型 ─────────────────────────────

/** 参数化模型里「由生成器给出、但用户在模型页可改」的字段 */
export const PARAM_DERIVED = ['frame', 'units', 'parts', 'massProps', 'articulations', 'solarPanelGroups', 'geometry', 'attachPoints']
/**
 * 重开已存的参数化模型：几何按 spec 现生成，但上面这些字段以【存下来的】为准（用户改过的质量特性 / 轴向 / 效率都在里面），
 * 存档里没有的才取生成结果。
 * @param {object} stored getMeta 的结果
 * @param {object} regen 生成结果换算出的同名字段
 */
export function mergeParamMeta(stored, regen) {
  const out = { ...(isObj(stored) ? stored : {}) }
  for (const k of PARAM_DERIVED) if (out[k] == null && regen && regen[k] !== undefined) out[k] = regen[k]
  return out
}

// ───────────────────────────── 关节编辑（AGI articulation）─────────────────────────────

export const STAGE_TYPE_LIST = ['xRotate', 'yRotate', 'zRotate', 'xTranslate', 'yTranslate', 'zTranslate', 'xScale', 'yScale', 'zScale', 'uniformScale']
const stageKind = (t) => (/Rotate$/.test(t) ? 'rot' : /Translate$/.test(t) ? 'tr' : 'sc')
/** 新 stage 的缺省量程：旋转 ±180°、平移 ±1 模型单位、缩放 0–1（初值 1 = 原大） */
export function stageDefaults(type) {
  const k = stageKind(type)
  if (k === 'rot') return { minimumValue: -180, maximumValue: 180, initialValue: 0 }
  if (k === 'tr') return { minimumValue: -1, maximumValue: 1, initialValue: 0 }
  return { minimumValue: 0, maximumValue: 1, initialValue: 1 }
}
const STAGE_BASE = { rot: 'Rotate', tr: 'Translate', sc: 'Scale' }
/** 新 stage：名字按类型起、在本关节内唯一 */
export function newStage(stages, type = 'zRotate') {
  const t = STAGE_TYPE_LIST.includes(type) ? type : 'zRotate'
  const taken = new Set((Array.isArray(stages) ? stages : []).map((s) => s && s.name))
  return { name: uniqueName(STAGE_BASE[stageKind(t)], taken), type: t, ...stageDefaults(t) }
}
/** 改 stage 类型：量纲（角度 / 长度 / 倍数）没变就留着原量程，变了换成新量纲的缺省量程（旋转的 ±180 拿去当缩放倍数没有意义） */
export function retypeStage(s, type) {
  if (!isObj(s) || !STAGE_TYPE_LIST.includes(type)) return s
  if (stageKind(s.type) === stageKind(type)) return { ...s, type }
  return { ...s, type, ...stageDefaults(type) }
}
/** 新关节：名字唯一（AGI：非空、不含空白）、节点给定、带一个绕 Z 转的 stage */
export function newArticulation(taken, nodes = []) {
  const t = taken instanceof Set ? taken : new Set(taken || [])
  return { name: uniqueName('Articulation', t), nodes: Array.isArray(nodes) ? nodes.slice() : [], stages: [newStage([], 'zRotate')] }
}
