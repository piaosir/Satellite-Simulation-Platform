// 部件分割（任务书 §5.4）：材质分组 → 连通分量 + 平面聚类（太阳翼）→ 抛物面拟合（反射面 + 焦点挂点）。
//
// 纯数值 ESM，无 three 依赖（渲染端放进 analyzeWorker，主进程 / 脚本 / 单测直接 import）。
// 输入是 IR 形状（设计契约 §3.1）：{ meshes:[{name, position:Float32Array, index:Uint32Array, material}],
// materials:[{name, key?}], nodes:[{name, parent, mesh?, matrix?}] }，一律米制。
//
// 节点名：NASA 多数模型只有 1–2 个节点、一个网格（任务书 §0.3-8），不能指望它；但 STEP / 用户 CAD 装配的节点树
// 就是部件划分（任务书 §5.4 ①），名字能认出角色的节点（含它的祖先装配节点）各成一个部件。
// 部件归属：整实例归本部件的记进 parts[].nodes；其余按实例内三角形区间 triRanges 记；
// 部件三角形在全局编号（实例顺序拼接，与 irToThree.triTable 一致）里恰好连续时另给 triRange:[start,count]。
//
// 识别（先算太阳翼，反射面搜索避开翼上的三角形）：
//   · 太阳翼：连通分量做面积加权 PCA，近平面、法向一致（含双面）的是候选；翼与本体焊成一个分量时，
//     在分量内按近共面相邻（≤ 5°）切平片再当候选。候选按「平行、共面（面外错位 ≤ 10 % 板宽）、相邻（间隙 ≤ ¼ 板宽）」
//     单链聚成翼，给出单面投影面积与法向；再用「两面朝空」（沿 ±法向打射线不撞别的几何）剔掉本体侧板。
//   · 反射面：连通分量与「光滑片」（相邻面法向夹角 ≤ 30° 的连片）上做旋转抛物面拟合，
//     残差 RMS / 口径 < 0.5 % 判为反射面（任务书口径）；0.5 %–1.5 % 之间要名字也提示反射面 / 天线才认。
//   · 馈源：焦点附近的小连通分量。
//   · 名字关键词（roleHint）：solar/cell/pv → solarArray；dish/reflector/antenna/ant → reflector；horn/feed → feed；
//     boom/mast/arm → boom；radiator/radiation/osr → radiator；thruster/nozzle → thruster；
//     sensor/tracker/camera/magnetometer/imager → sensor；array/panel → solarArray（弱提示：要几何佐证）。
// 认领顺序（每步只认领还没被认领的三角形，结果是对全部三角形的一个划分）：
//   反射面 → 太阳翼（连同落在翼薄板包络里的电池片、边框等小分量）→ 馈源 → 节点名（多实例时）→ 材质名
//   → 剩余里面积最大的连通分量作 bus（本体）→ 其余并成 other。
//   名字给出的 solarArray 三角形先看落没落在某面几何翼的薄板包络里，落进的并进那面翼（背板、边框、电池片材质）；
//   剩下的仍成部件，但不生成太阳翼组——组只从几何识别的翼生成（有法向、有投影面积，二期功率才算得对）。
//
// 坐标：几何先乘节点世界矩阵到模型系；输出的 *Body 字段再乘可选的 opts.bodyMatrix（列主序 4×4，模型系 → 本体系，
// 通常由 meta.frame 的 q/t 组成）。不给 bodyMatrix 时 *Body 就是模型系坐标。
//
// 挂点取向约定（写死，单测验证）：
//   反射面自动挂点 pos = 焦点；dir = 抛物面轴线单位向量，由顶点指向焦点——也就是天线波束视轴：
//   从焦点射向碟面的任一条射线经镜面反射后都平行于 +dir，出射波束沿 +dir 离开反射面凹侧。
//   馈源在焦点、朝向反射面：正馈时沿 −dir；偏置时指向口面中心，与 −dir 同侧。
//   偏置反射面的视轴仍是母抛物面轴线，不是口面法向。
//   up = 从轴线指向口面中心的方向（偏置方向）；近似正馈（偏置 < 1 % 口径）时取与 dir 最不平行的坐标轴在口面内的投影。

import { weldByPosition, buildHalfEdges, forEachEdge, symEigen, concatMeshes, connectedComponents } from './massProps.mjs'

// 连通分量的实现在 massProps（逐壳定向也要用），这里原样转出，保持本模块对外接口不变
export { connectedComponents }

const now = () => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now())

// ───────────────────────── 向量小工具（非热路径，数组即可）─────────────────────────

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const norm = (a) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1] }

/** 与 k 正交的一对单位向量（k 须是单位向量）；取与 k 最不平行的坐标轴起算，结果确定 */
function basisPerp(k) {
  const ax = Math.abs(k[0]), ay = Math.abs(k[1]), az = Math.abs(k[2])
  const ref = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1]
  const e1 = norm(sub(ref, scl(k, dot(ref, k))))
  return [e1, cross(k, e1)]
}

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

/** 列主序 4×4 乘法 a·b */
function mul4(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
    }
  }
  return o
}
const isMat4 = (m) => (Array.isArray(m) || ArrayBuffer.isView(m)) && m.length === 16 && Array.prototype.every.call(m, Number.isFinite)
const xformPoint = (M, p) => (M ? [M[0] * p[0] + M[4] * p[1] + M[8] * p[2] + M[12], M[1] * p[0] + M[5] * p[1] + M[9] * p[2] + M[13], M[2] * p[0] + M[6] * p[1] + M[10] * p[2] + M[14]] : p.slice())
const xformDir = (M, d) => (M ? norm([M[0] * d[0] + M[4] * d[1] + M[8] * d[2], M[1] * d[0] + M[5] * d[1] + M[9] * d[2], M[2] * d[0] + M[6] * d[1] + M[10] * d[2]]) : d.slice())

// ───────────────────────── 名字关键词 → 角色 ─────────────────────────

// 优先级从上到下：具体部件词在前、泛称在后。「antenna_boom」是臂不是反射面，「solar_array_boom」也是臂；
// 「太阳敏感器」「SunSensor」是敏感器不是太阳翼，所以 sensor 排在 solar 前；「Thermal Radiation Panel」是散热面，radiation 排在 panel 前。
// 「antenna」「array」「panel」这类泛称只在没有更具体的词时才起作用；array / panel 只算弱提示
// （Side Panel、MainSidePanels、Body_Panel 多半是本体侧板），调用方要有几何佐证才按太阳翼用。
// 短词（arm/ant/pv/osr/horn/mast/cell）只认整词或复数，避免 plant、quantum、master、hornet、cellular 误中。
// 中文按子串匹配，所以只放完整的词：「太阳」单字会把「太阳敏感器」判成太阳翼。
// 不收 reflect 前缀：Reflective_Foil、reflectiveMLI 是热控包覆，不是反射面。
const ROLE_RULES = [
  { role: 'thruster', prefix: ['thruster', 'nozzle'], zh: ['推力器', '发动机', '喷管', '喷嘴'] },
  { role: 'feed', prefix: ['feed'], exact: ['horn'], zh: ['馈源', '喇叭'] },
  { role: 'reflector', prefix: ['dish', 'reflector', 'reflectarray'], zh: ['反射面', '反射器', '抛物面'] },
  { role: 'radiator', prefix: ['radiator', 'radiation'], exact: ['osr'], zh: ['散热', '辐射器', '热辐射'] },
  { role: 'boom', prefix: ['boom'], exact: ['mast', 'arm'], zh: ['伸展臂', '支撑臂', '桅杆', '臂'] },
  { role: 'sensor', prefix: ['sensor', 'tracker', 'camera', 'magnetometer', 'imager'], zh: ['敏感器', '星敏', '相机', '磁强计', '传感器'] },
  { role: 'solarArray', prefix: ['solar'], exact: ['pv', 'cell'], zh: ['太阳翼', '太阳电池', '太阳能', '太阳阵', '帆板', '电池片', '电池阵'] },
  { role: 'reflector', prefix: ['antenna'], exact: ['ant'], zh: ['天线'] },
  { role: 'solarArray', weak: true, prefix: ['array', 'panel'], zh: [] },
]

// IR 材质库键（设计契约 §3.1 MaterialKey）也是强提示
const KEY_ROLE = { solar_cell: 'solarArray', solar_substrate: 'solarArray', reflector: 'reflector', reflector_mesh: 'reflector', radiator: 'radiator' }

function nameTokens(name) {
  return String(name)
    .replace(/([a-z])([A-Z])/g, '$1 $2')          // camelCase
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')        // 字母↔数字
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

const NO_HINT = Object.freeze({ role: 'other', weak: false })

/**
 * 名字 → 角色提示；认不出返回 {role:'other'}。weak = 只命中泛称（array / panel），要几何佐证才可信。
 * @param {string} name
 * @returns {{role:'solarArray'|'reflector'|'feed'|'boom'|'radiator'|'thruster'|'sensor'|'other', weak:boolean}}
 */
export function roleHint(name) {
  if (!name) return NO_HINT
  const s = String(name)
  const toks = nameTokens(s)
  for (const r of ROLE_RULES) {
    const hit = r.zh.some((w) => s.includes(w)) ||
      toks.some((t) => (r.prefix && r.prefix.some((w) => t.startsWith(w))) || (r.exact && r.exact.some((w) => t === w || t === w + 's' || t === w + 'es')))
    if (hit) return { role: r.role, weak: !!r.weak }
  }
  return NO_HINT
}

/**
 * 名字 → 初始角色；认不出返回 'other'（roleHint 的角色部分）。
 * @param {string} name
 * @returns {'solarArray'|'reflector'|'feed'|'boom'|'radiator'|'thruster'|'sensor'|'other'}
 */
export function roleFromName(name) {
  return roleHint(name).role
}

// ───────────────────────── IR → 同一坐标系的三角形集合 ─────────────────────────

function worldMatrices(nodes) {
  const N = nodes.length
  const world = new Array(N).fill(null)
  const state = new Uint8Array(N)                   // 0 未算 1 计算中（环）2 已算
  const get = (i) => {
    if (state[i] === 2) return world[i]
    if (state[i] === 1) return IDENT                // 父子成环：断开，按根处理
    state[i] = 1
    const n = nodes[i] || {}
    const local = isMat4(n.matrix) ? Array.from(n.matrix) : IDENT
    const p = n.parent
    const pw = Number.isInteger(p) && p >= 0 && p < N && p !== i ? get(p) : null
    world[i] = pw ? mul4(pw, local) : local
    state[i] = 2
    return world[i]
  }
  for (let i = 0; i < N; i++) get(i)
  return world
}

const isIdentity = (m) => m.every((v, i) => v === IDENT[i])

/**
 * 把 IR 摊成「实例」列表（节点 × 网格；没有节点树时每个网格一个实例）并拼成一份 Float64 三角形集合。
 * 实例是部件归属的最小可命名单位：parts[].nodes 记整实例、triRanges 记实例内的三角形区间。
 */
function assemble(ir) {
  const meshes = Array.isArray(ir?.meshes) ? ir.meshes : []
  const nodes = Array.isArray(ir?.nodes) ? ir.nodes : []
  const materials = Array.isArray(ir?.materials) ? ir.materials : []
  const valid = (mi) => Number.isInteger(mi) && mi >= 0 && mi < meshes.length && meshes[mi] && meshes[mi].position
  const inst = []
  if (nodes.some((n) => n && valid(n.mesh))) {
    const world = worldMatrices(nodes)
    nodes.forEach((n, i) => {
      if (!n || !valid(n.mesh)) return
      inst.push({ mesh: n.mesh, node: i, name: n.name || `node_${i}`, matrix: isIdentity(world[i]) ? null : world[i] })
    })
  } else {
    meshes.forEach((m, i) => { if (valid(i)) inst.push({ mesh: i, node: -1, name: m.name || `mesh_${i}`, matrix: null }) })
  }
  const cat = concatMeshes(inst.map((x) => ({ position: meshes[x.mesh].position, index: meshes[x.mesh].index || null, matrix: x.matrix })))
  const T = (cat.index.length / 3) | 0
  const triInst = new Uint32Array(T)
  inst.forEach((x, k) => {
    x.triStart = cat.triOffsets[k]
    x.triCount = (k + 1 < inst.length ? cat.triOffsets[k + 1] : T) - x.triStart
    triInst.fill(k, x.triStart, x.triStart + x.triCount)
    const m = meshes[x.mesh]
    const mi = Number.isInteger(m.material) ? m.material : -1
    const mat = mi >= 0 ? materials[mi] : null
    x.material = mi
    x.materialName = m.materialName != null ? String(m.materialName) : mat && mat.name != null ? String(mat.name) : mi >= 0 ? `material_${mi}` : ''
    x.materialKey = mat && mat.key ? mat.key : null
    x.meshName = m.name || ''
  })
  return { inst, position: cat.position, index: cat.index, T, triInst }
}

/** 逐三角形单位法向与面积（退化面面积 0、法向 0） */
function triNormals(position, index) {
  const T = (index.length / 3) | 0
  const nrm = new Float64Array(T * 3), area = new Float64Array(T)
  for (let t = 0; t < T; t++) {
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2]
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(l > 0)) continue
    area[t] = 0.5 * l
    nrm[t * 3] = nx / l; nrm[t * 3 + 1] = ny / l; nrm[t * 3 + 2] = nz / l
  }
  return { nrm, area }
}

// ───────────────────────── ② 材质分组 ─────────────────────────

/**
 * 按材质分组（任务书 §5.4 ②）：NASA 单网格模型 31–283 个材质是天然分组。
 * 角色：材质名关键词 → IR 材质库键 → 所用实例名的多数票（按三角形数，过半才认）。
 * 每个实例只投一票：先看节点名，认不出再看网格名。节点名与网格名常是同一个词（Blender 的「Thruster_1」
 * 与「Thruster_1_mesh」），各投一票会让少数派角色翻倍过半，把整个共用材质的装配标成推力器。
 *
 * @param {{meshes, materials?, nodes?}} ir  网格可带 materialName 直接给名字
 * @returns {{id:string, name:string, material:number, role:string, weak:boolean, instances:number[], nodes:string[], tris:number, areaM2:number}[]}
 *   按面积降序；weak = 角色只来自泛称（array / panel）
 */
export function segmentByMaterial(ir) {
  const asm = ir && ir.inst ? ir : assemble(ir)
  const { area } = asm.area ? asm : triNormals(asm.position, asm.index)
  const groups = new Map()
  asm.inst.forEach((x, k) => {
    const key = x.material >= 0 ? `#${x.material}` : `@${x.materialName}`
    let g = groups.get(key)
    if (!g) {
      g = { id: x.material >= 0 ? `mat-${x.material}` : `mat-n${groups.size}`, name: x.materialName || '(无材质)', material: x.material, key: x.materialKey, instances: [], tris: 0, areaM2: 0, votes: new Map() }
      groups.set(key, g)
    }
    g.instances.push(k)
    g.tris += x.triCount
    let a = 0
    for (let t = x.triStart, e = x.triStart + x.triCount; t < e; t++) a += area[t]
    g.areaM2 += a
    let h = roleHint(x.name)
    if (h.role === 'other') h = roleHint(x.meshName)
    if (h.role !== 'other') {
      const v = g.votes.get(h.role) || { n: 0, strong: 0 }
      v.n += x.triCount
      if (!h.weak) v.strong += x.triCount
      g.votes.set(h.role, v)
    }
  })
  const out = []
  for (const g of groups.values()) {
    let { role, weak } = roleHint(g.name)
    if (role === 'other' && g.key && KEY_ROLE[g.key]) { role = KEY_ROLE[g.key]; weak = false }
    if (role === 'other') {
      for (const [r, v] of g.votes) if (v.n * 2 > g.tris) { role = r; weak = !(v.strong * 2 > g.tris) }
    }
    out.push({
      id: g.id, name: g.name, material: g.material, role, weak, instances: g.instances,
      nodes: [...new Set(g.instances.map((k) => asm.inst[k].name))], tris: g.tris, areaM2: g.areaM2,
    })
  }
  return out.sort((a, b) => b.areaM2 - a.areaM2 || a.id.localeCompare(b.id))
}

// ───────────────────────── 分组表 ─────────────────────────

/** 标签 → 每组三角形列表（CSR）。label < 0 的三角形不进任何组 */
function groupLists(label, count) {
  const off = new Uint32Array(count + 1)
  for (let t = 0; t < label.length; t++) if (label[t] >= 0) off[label[t] + 1]++
  for (let i = 0; i < count; i++) off[i + 1] += off[i]
  const list = new Uint32Array(off[count])
  const fill = off.slice(0, count)
  for (let t = 0; t < label.length; t++) if (label[t] >= 0) list[fill[label[t]]++] = t
  return (i) => list.subarray(off[i], off[i + 1])
}

// ───────────────────────── ③ 平面性 ─────────────────────────

/**
 * 一组三角形（一个连通分量）的平面性：面积加权 PCA，主轴跨度 e₁ ≥ e₂ ≥ e₃。
 *   厚度 / 广度比 = e₃ / √(e₁e₂)（广度取面内两跨度的几何平均）。
 *     不用 e₃/e₁：细长臂杆（厚≈宽≪长）会被当成平面；不用 e₃/e₂：NASA 模型的板子常带边框，
 *     TDRS-D 的电池板 0.393×0.300×0.0061 用 e₃/e₂ 是 0.0203、刚好卡在 0.02 外。
 *     另加 e₃ < 0.1·e₂ 挡住「窄而厚」的条带（杆、梁）。
 *   法向一致度 = Σ A|n·ê₃| / ΣA（取绝对值：双面板、薄盒的上下两面方向相反也算一致）。
 *   投影面积（单面）= max(Σ正面 A·n·ê₃, Σ背面 A·(−n·ê₃))：薄盒上下各一份、双面重合片正反各一份、
 *   单面片只有一面，取大者都等于一块板的迎光面积。
 *
 * @param {ArrayLike<number>} position
 * @param {ArrayLike<number>} index
 * @param {ArrayLike<number>|null} [tris]  三角形下标子集；缺省为全部
 * @param {{maxThicknessRatio?:number, minNormalConsistency?:number, planform?:boolean}} [opts]  缺省 0.02 / 0.8；
 *   planform:false 跳过栅格并集（只要平面性判据、不要投影面积时省时间）
 * @returns {null | {planar:boolean, areaM2:number, surfaceM2:number, frontM2:number, backM2:number, normal:number[],
 *   centroid:number[], axes:number[][], extents:number[], lo:number[], hi:number[], thicknessRatio:number, normalConsistency:number}}
 */
export function planarCluster(position, index, tris, opts = {}) {
  const maxRatio = opts.maxThicknessRatio ?? 0.02
  const minNC = opts.minNormalConsistency ?? 0.8
  const nT = tris ? tris.length : (index.length / 3) | 0
  if (nT === 0) return null
  const tAt = tris ? (i) => tris[i] : (i) => i
  // 参考点取第一个三角形的首顶点：二阶矩在远离原点的模型上不丢位
  const r0 = index[tAt(0) * 3] * 3
  const ox = position[r0], oy = position[r0 + 1], oz = position[r0 + 2]
  let S0 = 0, sx = 0, sy = 0, sz = 0
  let xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0
  for (let i = 0; i < nT; i++) {
    const t = tAt(i)
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const ax = position[a] - ox, ay = position[a + 1] - oy, az = position[a + 2] - oz
    const bx = position[b] - ox, by = position[b + 1] - oy, bz = position[b + 2] - oz
    const cx = position[c] - ox, cy = position[c + 1] - oy, cz = position[c + 2] - oz
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const A = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(A > 0)) continue
    const qx = ax + bx + cx, qy = ay + by + cy, qz = az + bz + cz
    S0 += A; sx += A * qx / 3; sy += A * qy / 3; sz += A * qz / 3
    // ∫_T x xᵀ dA = A/12 · (Σ vᵢvᵢᵀ + (Σvᵢ)(Σvᵢ)ᵀ)
    const w = A / 12
    xx += w * (ax * ax + bx * bx + cx * cx + qx * qx)
    yy += w * (ay * ay + by * by + cy * cy + qy * qy)
    zz += w * (az * az + bz * bz + cz * cz + qz * qz)
    xy += w * (ax * ay + bx * by + cx * cy + qx * qy)
    yz += w * (ay * az + by * bz + cy * cz + qy * qz)
    zx += w * (az * ax + bz * bx + cz * cx + qz * qx)
  }
  if (!(S0 > 0)) return null
  const mx = sx / S0, my = sy / S0, mz = sz / S0
  const C = [
    [xx / S0 - mx * mx, xy / S0 - mx * my, zx / S0 - mz * mx],
    [xy / S0 - mx * my, yy / S0 - my * my, yz / S0 - my * mz],
    [zx / S0 - mz * mx, yz / S0 - my * mz, zz / S0 - mz * mz],
  ]
  const { vectors } = symEigen(C)
  const e3 = norm(vectors[0]), e2 = norm(vectors[1])
  const e1 = cross(e2, e3)
  const centroid = [mx + ox, my + oy, mz + oz]
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  let front = 0, back = 0, nc = 0
  for (let i = 0; i < nT; i++) {
    const t = tAt(i)
    for (let k = 0; k < 3; k++) {
      const v = index[t * 3 + k] * 3
      const px = position[v] - centroid[0], py = position[v + 1] - centroid[1], pz = position[v + 2] - centroid[2]
      const p1 = px * e1[0] + py * e1[1] + pz * e1[2]
      const p2 = px * e2[0] + py * e2[1] + pz * e2[2]
      const p3 = px * e3[0] + py * e3[1] + pz * e3[2]
      if (p1 < lo[0]) lo[0] = p1; if (p1 > hi[0]) hi[0] = p1
      if (p2 < lo[1]) lo[1] = p2; if (p2 > hi[1]) hi[1] = p2
      if (p3 < lo[2]) lo[2] = p3; if (p3 > hi[2]) hi[2] = p3
    }
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2]
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    // |n|·cos = n·ê₃，面积 = |n|/2
    const proj = 0.5 * (nx * e3[0] + ny * e3[1] + nz * e3[2])
    if (proj > 0) front += proj; else back -= proj
    nc += Math.abs(proj)
  }
  const extents = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
  const breadth = Math.sqrt(extents[0] * extents[1])
  const thicknessRatio = breadth > 0 ? extents[2] / breadth : Infinity
  const normalConsistency = nc / S0
  // 法向朝「投影面积大的那一面」；两面相当（薄盒、双面片）时让绝对值最大的分量为正，结果确定
  let normal = e3
  const tie = Math.abs(front - back) <= 1e-9 * (front + back)
  if (tie) {
    const k = Math.abs(e3[0]) >= Math.abs(e3[1]) && Math.abs(e3[0]) >= Math.abs(e3[2]) ? 0 : Math.abs(e3[1]) >= Math.abs(e3[2]) ? 1 : 2
    if (e3[k] < 0) normal = scl(e3, -1)
  } else if (back > front) normal = scl(e3, -1)
  const flip = normal !== e3
  const planar = thicknessRatio < maxRatio && extents[2] < 0.1 * extents[1] && normalConsistency > minNC
  // 单面投影面积。只有一面有量 → 单层片（个别翻面的三角形也在同一层上）→ 正 + 背；
  // 两面都有量 → 可能是薄盒 / 双面重合片（= 较大一面），也可能是单层片绕向乱（= 正 + 背），
  // 这时用栅格并集定夺，并吸附到两个解析值上（差 2 % 以内取解析值，免得栅格误差带进精确情形）。
  let areaM2 = front + back
  const big = Math.max(front, back)
  if (Math.min(front, back) > 0.1 * big) {
    areaM2 = big
    // 注意正 ≈ 背时表面积也区分不了两种情形：薄盒 S≈2P，半数翻面的单层片 S=P=2·(P/2)。只能靠并集。
    if (planar && opts.planform !== false) {
      const ru = rasterUnionArea(position, index, [tris || Uint32Array.from({ length: nT }, (_, i) => i)], centroid, e1, e2, lo[0], hi[0], lo[1], hi[1], 512)
      let pf = Math.min(Math.max(ru, big), front + back)
      if (Math.abs(pf - big) <= 0.02 * big) pf = big
      else if (Math.abs(pf - (front + back)) <= 0.02 * (front + back)) pf = front + back
      areaM2 = pf
    }
  }
  return {
    planar,
    areaM2, surfaceM2: S0,
    frontM2: flip ? back : front, backM2: flip ? front : back,
    normal, centroid, axes: [e1, e2, e3], extents, lo, hi, thicknessRatio, normalConsistency,
  }
}

/**
 * 投影并集面积（栅格化，格心采样）：同一处叠了多层（电池片贴在基板上、正反两片再加边框）时，
 * 面积之和会重复计，只有并集才是迎光面积。只在检出重叠时才用（精度约 ±0.5 格 × 周长）。
 */
function rasterUnionArea(position, index, lists, origin, e1, e2, lo1, hi1, lo2, hi2, maxCells = 1024) {
  const w = hi1 - lo1, h = hi2 - lo2
  if (!(w > 0 && h > 0)) return 0
  const cell = Math.max(w, h) / maxCells
  const nx = Math.ceil(w / cell) + 1, ny = Math.ceil(h / cell) + 1
  const bits = new Uint8Array(nx * ny)
  const U = [0, 0, 0], W = [0, 0, 0]
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k] * 3
        const px = position[v] - origin[0], py = position[v + 1] - origin[1], pz = position[v + 2] - origin[2]
        U[k] = (px * e1[0] + py * e1[1] + pz * e1[2] - lo1) / cell
        W[k] = (px * e2[0] + py * e2[1] + pz * e2[2] - lo2) / cell
      }
      const d = (U[1] - U[0]) * (W[2] - W[0]) - (U[2] - U[0]) * (W[1] - W[0])
      if (Math.abs(d) < 1e-12) continue                 // 侧立的面投影退化
      const s = d > 0 ? 1 : -1
      const i0 = Math.max(0, Math.ceil(Math.min(U[0], U[1], U[2]) - 0.5)), i1 = Math.min(nx - 1, Math.floor(Math.max(U[0], U[1], U[2]) - 0.5))
      const j0 = Math.max(0, Math.ceil(Math.min(W[0], W[1], W[2]) - 0.5)), j1 = Math.min(ny - 1, Math.floor(Math.max(W[0], W[1], W[2]) - 0.5))
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5
        for (let ii = i0; ii <= i1; ii++) {
          const x = ii + 0.5
          const w0 = s * ((U[1] - x) * (W[2] - y) - (U[2] - x) * (W[1] - y))
          const w1 = s * ((U[2] - x) * (W[0] - y) - (U[0] - x) * (W[2] - y))
          const w2 = s * ((U[0] - x) * (W[1] - y) - (U[1] - x) * (W[0] - y))
          if (w0 >= 0 && w1 >= 0 && w2 >= 0) bits[j * nx + ii] = 1
        }
      }
    }
  }
  let n = 0
  for (let q = 0; q < bits.length; q++) n += bits[q]
  return n * cell * cell
}

/**
 * 射线 o + s·d（minS < s ≤ maxS）是否碰到 skip[t] 为 0 的任一三角形（Möller–Trumbore，双面）。
 * 只给少数几个平面簇做「两面朝空」判定用；list 给出预筛过的三角形下标（缺省扫全部），不值得建加速结构。
 */
function rayHits(position, index, skip, o, d, maxS, minS = 0, list = null) {
  const T = list ? list.length : (index.length / 3) | 0
  const eps = 1e-12
  for (let q = 0; q < T; q++) {
    const t = list ? list[q] : q
    if (skip && skip[t]) continue
    const a = index[t * 3] * 3, b = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const e1x = position[b] - position[a], e1y = position[b + 1] - position[a + 1], e1z = position[b + 2] - position[a + 2]
    const e2x = position[c] - position[a], e2y = position[c + 1] - position[a + 1], e2z = position[c + 2] - position[a + 2]
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (det > -eps && det < eps) continue
    const inv = 1 / det
    const tx = o[0] - position[a], ty = o[1] - position[a + 1], tz = o[2] - position[a + 2]
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
    if (v < 0 || u + v > 1) continue
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (s > Math.max(minS, 1e-9 * maxS) && s <= maxS) return true
  }
  return false
}

/** 候选 b 的包围盒 8 角在 a 的主轴上的区间 */
function boxInterval(a, b, axis) {
  let lo = Infinity, hi = -Infinity
  for (let c = 0; c < 8; c++) {
    const p = add(b.centroid, add(scl(b.axes[0], c & 1 ? b.hi[0] : b.lo[0]), add(scl(b.axes[1], c & 2 ? b.hi[1] : b.lo[1]), scl(b.axes[2], c & 4 ? b.hi[2] : b.lo[2]))))
    const s = dot(sub(p, a.centroid), a.axes[axis])
    if (s < lo) lo = s; if (s > hi) hi = s
  }
  return [lo, hi]
}

/** a、b 在 a 的面内两轴上的包围盒间隙（相交为 0） */
function planarGap(a, b) {
  let g = 0
  for (let k = 0; k < 2; k++) {
    const [lo, hi] = boxInterval(a, b, k)
    const s = Math.max(0, lo - a.hi[k], a.lo[k] - hi)
    g += s * s
  }
  return Math.sqrt(g)
}

/** a、b 在 a 的面内投影矩形的重叠面积 */
function planarOverlap(a, b) {
  let ar = 1
  for (let k = 0; k < 2; k++) {
    const [lo, hi] = boxInterval(a, b, k)
    const o = Math.min(hi, a.hi[k]) - Math.max(lo, a.lo[k])
    if (!(o > 0)) return 0
    ar *= o
  }
  return ar
}

// ───────────────────────── ④ 抛物面拟合 ─────────────────────────

/** 小型稠密线性方程组（高斯消元 + 列主元），失败返回 null */
function solveLinear(A, b) {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (!(Math.abs(M[p][c]) > 1e-300)) return null
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t }
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      if (f === 0) continue
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n]
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]
    x[r] = s / M[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}

function toFlatPoints(points) {
  if (Array.isArray(points) && points.length && Array.isArray(points[0])) {
    const f = new Float64Array(points.length * 3)
    points.forEach((p, i) => { f[i * 3] = p[0]; f[i * 3 + 1] = p[1]; f[i * 3 + 2] = p[2] })
    return f
  }
  return points
}

/** 点云协方差最小主轴（碟面的「矢高」方向） */
function pcaAxis(Q, n) {
  let xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, zx = 0
  for (let i = 0; i < n; i++) {
    const x = Q[i * 3], y = Q[i * 3 + 1], z = Q[i * 3 + 2]
    xx += x * x; yy += y * y; zz += z * z; xy += x * y; yz += y * z; zx += z * x
  }
  return norm(symEigen([[xx, xy, zx], [xy, yy, yz], [zx, yz, zz]]).vectors[0])
}

/**
 * 一般二次曲面代数拟合求轴：旋转抛物面的隐式式 pᵀ(I − kkᵀ)p − 4f k·p = 0，二次型矩阵 ∝ I − kkᵀ，
 * 它的零特征向量就是轴向 k。无噪数据上一步就是精确轴，与偏置多大无关——
 * 这正是 PCA 做不到的：偏置反射面的最小主轴与母抛物面轴线相差可达三十多度。
 */
function quadricAxis(Q, n) {
  const S = Array.from({ length: 10 }, () => new Array(10).fill(0))
  const d = new Array(10)
  for (let i = 0; i < n; i++) {
    const x = Q[i * 3], y = Q[i * 3 + 1], z = Q[i * 3 + 2]
    d[0] = x * x; d[1] = y * y; d[2] = z * z; d[3] = x * y; d[4] = x * z; d[5] = y * z; d[6] = x; d[7] = y; d[8] = z; d[9] = 1
    for (let r = 0; r < 10; r++) { const dr = d[r]; const row = S[r]; for (let c = r; c < 10; c++) row[c] += dr * d[c] }
  }
  for (let r = 0; r < 10; r++) for (let c = 0; c < r; c++) S[r][c] = S[c][r]
  const q = symEigen(S).vectors[0]
  const A = [[q[0], q[3] / 2, q[4] / 2], [q[3] / 2, q[1], q[5] / 2], [q[4] / 2, q[5] / 2, q[2]]]
  const e = symEigen(A)
  // 取 |λ| 最小的那个特征向量
  let best = 0
  for (let k = 1; k < 3; k++) if (Math.abs(e.values[k]) < Math.abs(e.values[best])) best = k
  const k = norm(e.vectors[best])
  return k.every(Number.isFinite) ? k : null
}

/** 在以 k 为 z 轴的坐标系里线性最小二乘 z = a(x²+y²) + bx + cy + d；a<0 时翻转轴向重拟。返回 {V, k, c:a} */
function linearFit(Q, n, k0) {
  for (let pass = 0; pass < 2; pass++) {
    const k = pass === 0 ? k0 : scl(k0, -1)
    const [e1, e2] = basisPerp(k)
    const N = Array.from({ length: 4 }, () => [0, 0, 0, 0]), rhs = [0, 0, 0, 0]
    const row = [0, 0, 0, 1]
    for (let i = 0; i < n; i++) {
      const p = [Q[i * 3], Q[i * 3 + 1], Q[i * 3 + 2]]
      const x = dot(p, e1), y = dot(p, e2), z = dot(p, k)
      row[0] = x * x + y * y; row[1] = x; row[2] = y
      for (let r = 0; r < 4; r++) { rhs[r] += row[r] * z; for (let c = 0; c < 4; c++) N[r][c] += row[r] * row[c] }
    }
    const s = solveLinear(N, rhs)
    if (!s) return null
    const [a, b, c, d] = s
    if (!(Math.abs(a) > 1e-9)) return null           // 近平面：没有有限焦距
    if (a < 0) continue
    const x0 = -b / (2 * a), y0 = -c / (2 * a), z0 = d - a * (x0 * x0 + y0 * y0)
    return { V: add(add(scl(e1, x0), scl(e2, y0)), scl(k, z0)), k, c: a }
  }
  return null
}

/**
 * Sampson 残差：g = s − cρ²（s = 轴向坐标、ρ = 离轴距离、c = 1/4f），|∇g| = √(1 + 4c²ρ²) = 1/cos(面法向倾角)，
 * g/|∇g| 是到曲面法向距离的一阶近似——碟边缘倾斜处也不会被轴向残差放大。
 */
function sampsonCost(Q, n, V, k, c) {
  let cost = 0
  for (let i = 0; i < n; i++) {
    const px = Q[i * 3] - V[0], py = Q[i * 3 + 1] - V[1], pz = Q[i * 3 + 2] - V[2]
    const s = px * k[0] + py * k[1] + pz * k[2]
    const rho2 = px * px + py * py + pz * pz - s * s
    const g = s - c * rho2
    cost += (g * g) / (1 + 4 * c * c * rho2)
  }
  return cost
}

/** Levenberg–Marquardt 细化 6 参数（顶点 3 + 轴向 2 + 曲率 1）。每轮在当前轴向的切平面里扰动轴向 */
function refineLM(Q, n, fit, maxIter = 40) {
  let { V, k, c } = fit
  let cost = sampsonCost(Q, n, V, k, c)
  let lambda = 1e-3
  const J = new Array(6)
  for (let it = 0; it < maxIter && cost > 1e-30; it++) {
    const [e1, e2] = basisPerp(k)
    const H = Array.from({ length: 6 }, () => new Array(6).fill(0)), gr = new Array(6).fill(0)
    for (let i = 0; i < n; i++) {
      const p = [Q[i * 3] - V[0], Q[i * 3 + 1] - V[1], Q[i * 3 + 2] - V[2]]
      const s = dot(p, k), pe1 = dot(p, e1), pe2 = dot(p, e2)
      const rho2 = pe1 * pe1 + pe2 * pe2
      const w = 1 / Math.sqrt(1 + 4 * c * c * rho2)
      const g = s - c * rho2
      const f = 1 + 2 * c * s
      // ∂g/∂V = −(f·k − 2c·p)
      J[0] = -w * (f * k[0] - 2 * c * p[0]); J[1] = -w * (f * k[1] - 2 * c * p[1]); J[2] = -w * (f * k[2] - 2 * c * p[2])
      J[3] = w * pe1 * f; J[4] = w * pe2 * f; J[5] = -w * rho2
      const r = w * g
      for (let a = 0; a < 6; a++) { gr[a] += J[a] * r; for (let b = a; b < 6; b++) H[a][b] += J[a] * J[b] }
    }
    for (let a = 0; a < 6; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a]
    let improved = false
    for (let tries = 0; tries < 8; tries++) {
      const A = H.map((row, a) => row.map((v, b) => (a === b ? v + lambda * Math.max(v, 1e-12) : v)))
      const d = solveLinear(A, gr.map((v) => -v))
      if (!d) { lambda *= 10; continue }
      const V2 = [V[0] + d[0], V[1] + d[1], V[2] + d[2]]
      const k2 = norm(add(k, add(scl(e1, d[3]), scl(e2, d[4]))))
      const c2 = c + d[5]
      const cost2 = c2 > 0 ? sampsonCost(Q, n, V2, k2, c2) : Infinity
      if (cost2 < cost) {
        const rel = (cost - cost2) / Math.max(cost, 1e-300)
        V = V2; k = k2; c = c2; cost = cost2
        lambda = Math.max(lambda / 3, 1e-12)
        improved = rel > 1e-12
        break
      }
      lambda *= 5
    }
    if (!improved) break
  }
  return { V, k, c, cost }
}

/** 2D 凸包（Andrew 单调链），返回点下标 */
function hull2D(xs, ys) {
  const n = xs.length
  const ord = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b] || ys[a] - ys[b])
  const crossO = (o, a, b) => (xs[a] - xs[o]) * (ys[b] - ys[o]) - (ys[a] - ys[o]) * (xs[b] - xs[o])
  const lower = [], upper = []
  for (const i of ord) {
    while (lower.length >= 2 && crossO(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop()
    lower.push(i)
  }
  for (let q = ord.length - 1; q >= 0; q--) {
    const i = ord[q]
    while (upper.length >= 2 && crossO(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop()
    upper.push(i)
  }
  upper.pop(); lower.pop()
  return lower.concat(upper)
}

/**
 * 旋转抛物面拟合（任务书 §5.4 ④）。
 *   ① 初始轴向两路：PCA 最小主轴（任务书原口径）与二次曲面代数拟合的零特征向量（偏置反射面也准）；
 *   ② 每路在「轴向 = z」的坐标系里线性最小二乘 z = a(x²+y²) + bx + cy + d，
 *      顶点 = (−b/2a, −c/2a) 兼容偏置反射面（顶点可以不在碟面上）；
 *   ③ LM 同时细化顶点、轴向、曲率（Sampson 残差），两路取残差小者。
 * 焦距 f = 1/(4a)；口径 = 沿轴投影轮廓的最大宽度（凸包直径）；偏置 = 轴线到口面中心的距离。
 *
 * @param {ArrayLike<number>|number[][]} points  xyz 平铺或 [[x,y,z],…]
 * @param {{maxPoints?:number}} [opts]
 * @returns {null | {ok:true, focalM:number, diameterM:number, vertex:number[], axis:number[], focus:number[],
 *   rmsM:number, rmsRel:number, offsetM:number, offsetDir:number[]|null, apertureCenter:number[], fOverD:number, depthM:number,
 *   apertureAspect:number, n:number}}  apertureAspect = 口面投影「垂直直径方向的宽度 / 直径」，圆口面 = 1
 *   axis 由顶点指向焦点（凹侧朝向）。
 */
export function fitParaboloid(points, opts = {}) {
  const P = toFlatPoints(points)
  const nAll = (P.length / 3) | 0
  if (nAll < 6) return null
  // 抽样上限：拟合只要几千点就稳定，口径仍用全部点量
  const maxPts = opts.maxPoints ?? 6000
  const stride = Math.max(1, Math.ceil(nAll / maxPts))
  const n = Math.ceil(nAll / stride)
  let mx = 0, my = 0, mz = 0
  for (let i = 0; i < nAll; i += stride) { mx += P[i * 3]; my += P[i * 3 + 1]; mz += P[i * 3 + 2] }
  mx /= n; my /= n; mz /= n
  let r2 = 0
  for (let i = 0; i < nAll; i += stride) r2 += (P[i * 3] - mx) ** 2 + (P[i * 3 + 1] - my) ** 2 + (P[i * 3 + 2] - mz) ** 2
  const L = Math.sqrt(r2 / n)
  if (!(L > 0)) return null
  // 归一化到「均方根半径 = 1」：二次项、一次项、常数项同量级，10×10 散布矩阵才有条件数可言
  const Q = new Float64Array(n * 3)
  for (let i = 0, j = 0; i < nAll; i += stride, j++) {
    Q[j * 3] = (P[i * 3] - mx) / L; Q[j * 3 + 1] = (P[i * 3 + 1] - my) / L; Q[j * 3 + 2] = (P[i * 3 + 2] - mz) / L
  }
  let best = null
  for (const k0 of [pcaAxis(Q, n), quadricAxis(Q, n)]) {
    if (!k0) continue
    const lin = linearFit(Q, n, k0)
    if (!lin) continue
    const r = refineLM(Q, n, lin)
    if (!(r.c > 0) || !Number.isFinite(r.cost)) continue
    if (!best || r.cost < best.cost) best = r
  }
  if (!best) return null
  const k = best.k
  const vertex = [best.V[0] * L + mx, best.V[1] * L + my, best.V[2] * L + mz]
  const focalM = L / (4 * best.c)
  const focus = add(vertex, scl(k, focalM))
  // 口径：全部点沿轴投影到口面，凸包直径
  const [e1, e2] = basisPerp(k)
  const xs = new Float64Array(nAll), ys = new Float64Array(nAll)
  let smin = Infinity, smax = -Infinity
  for (let i = 0; i < nAll; i++) {
    const p = [P[i * 3] - vertex[0], P[i * 3 + 1] - vertex[1], P[i * 3 + 2] - vertex[2]]
    xs[i] = dot(p, e1); ys[i] = dot(p, e2)
    const s = dot(p, k)
    if (s < smin) smin = s; if (s > smax) smax = s
  }
  const h = hull2D(xs, ys)
  let dmax = 0, ia = h[0], ib = h[0]
  for (let a = 0; a < h.length; a++) {
    for (let b = a + 1; b < h.length; b++) {
      const d = (xs[h[a]] - xs[h[b]]) ** 2 + (ys[h[a]] - ys[h[b]]) ** 2
      if (d > dmax) { dmax = d; ia = h[a]; ib = h[b] }
    }
  }
  const diameterM = Math.sqrt(dmax)
  if (!(diameterM > 0)) return null
  // 口面中心：直径端点中点 + 垂直方向上的包络中点（圆 / 椭圆口面都落在中心）
  const ux = (xs[ib] - xs[ia]) / diameterM, uy = (ys[ib] - ys[ia]) / diameterM
  let wlo = Infinity, whi = -Infinity
  for (const i of h) { const w = -uy * xs[i] + ux * ys[i]; if (w < wlo) wlo = w; if (w > whi) whi = w }
  const wm = (wlo + whi) / 2
  const cx = (xs[ia] + xs[ib]) / 2, cy = (ys[ia] + ys[ib]) / 2
  const w0 = -uy * cx + ux * cy
  const acx = cx + (-uy) * (wm - w0), acy = cy + ux * (wm - w0)
  const offsetM = Math.hypot(acx, acy)
  const offsetDir = offsetM > 0 ? norm(add(scl(e1, acx), scl(e2, acy))) : null
  const rho2c = acx * acx + acy * acy
  const apertureCenter = add(vertex, add(add(scl(e1, acx), scl(e2, acy)), scl(k, (best.c / L) * rho2c)))
  const rmsM = Math.sqrt(best.cost / n) * L
  return {
    ok: true, focalM, diameterM, vertex, axis: k, focus,
    rmsM, rmsRel: rmsM / diameterM, offsetM, offsetDir, apertureCenter,
    fOverD: focalM / diameterM, depthM: smax - smin, apertureAspect: (whi - wlo) / diameterM, n: nAll,
  }
}

// ───────────────────────── 光滑片 ─────────────────────────

/**
 * 光滑片：流形边（恰两面共享）两侧法向夹角 ≤ maxDeg 的三角形连成一片。
 * 绕向不一致的那条边（两面同向经过）先把一侧法向取反再比——导出件里局部翻面很常见，不该因此断片。
 * 非流形边、边界边不连。eligible(t) 为假的三角形不参与（标 −1）。
 */
function smoothPatches(he, nrm, area, maxDeg, eligible) {
  const T = he.T
  const cosTol = Math.cos((maxDeg * Math.PI) / 180)
  const par = new Int32Array(T)
  for (let t = 0; t < T; t++) par[t] = t
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  const { tri } = he
  forEachEdge(he, (_lo, _hi, f, r, buf, s0) => {
    if (f + r !== 2) return
    // 一正一反 = 绕向一致，法向直接比；两条同向 = 其中一面翻了，取反再比
    const t1 = tri[buf[s0]], t2 = tri[buf[s0 + 1]], sign = f === 1 ? 1 : -1
    if (!(area[t1] > 0) || !(area[t2] > 0)) return
    if (eligible && (!eligible(t1) || !eligible(t2))) return
    const c = sign * (nrm[t1 * 3] * nrm[t2 * 3] + nrm[t1 * 3 + 1] * nrm[t2 * 3 + 1] + nrm[t1 * 3 + 2] * nrm[t2 * 3 + 2])
    if (c < cosTol) return
    const a = find(t1), b = find(t2)
    if (a !== b) { if (a < b) par[b] = a; else par[a] = b }
  })
  const label = new Int32Array(T).fill(-1)
  const map = new Int32Array(T).fill(-1)
  let count = 0
  for (let t = 0; t < T; t++) {
    if (eligible && !eligible(t)) continue
    if (!(area[t] > 0)) continue
    const r = find(t)
    if (map[r] === -1) map[r] = count++
    label[t] = map[r]
  }
  return { label, count }
}

/**
 * 平片：共边且法向近平行（|n·n'| ≥ cos maxDeg，不看正反）的三角形连成一片。
 * 与 smoothPatches 不同，这里连非流形边：双面重合片、重复三角形在同一条边上挂 4 个面，照样该并成一片。
 */
function flatPatches(he, nrm, area, maxDeg, eligible) {
  const T = he.T
  const cosTol = Math.cos((maxDeg * Math.PI) / 180)
  const par = new Int32Array(T)
  for (let t = 0; t < T; t++) par[t] = t
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  const { tri } = he
  const cosOf = (t1, t2) => Math.abs(nrm[t1 * 3] * nrm[t2 * 3] + nrm[t1 * 3 + 1] * nrm[t2 * 3 + 1] + nrm[t1 * 3 + 2] * nrm[t2 * 3 + 2])
  const unite = (t1, t2) => { const r1 = find(t1), r2 = find(t2); if (r1 !== r2) { if (r1 < r2) par[r2] = r1; else par[r1] = r2 } }
  const reps = []
  forEachEdge(he, (_lo, _hi, f, r, buf, s0) => {
    const n = f + r
    if (n <= 32) {
      for (let a = 0; a < n; a++) {
        const t1 = tri[buf[s0 + a]]
        if (!(area[t1] > 0) || !eligible(t1)) continue
        for (let b = a + 1; b < n; b++) {
          const t2 = tri[buf[s0 + b]]
          if (!(area[t2] > 0) || !eligible(t2)) continue
          if (cosOf(t1, t2) >= cosTol) unite(t1, t2)
        }
      }
      return
    }
    // 一条边挂几十上百个面（重复面、大 tol 焊塌）时两两比是 O(n²)：每个面只和至多 16 个「法向代表」比，
    // 相容就并进代表所在的集合，不相容另立代表（并查集可传递，结果与两两比只差在代表名额用完之后）
    reps.length = 0
    for (let a = 0; a < n; a++) {
      const t1 = tri[buf[s0 + a]]
      if (!(area[t1] > 0) || !eligible(t1)) continue
      let hit = false
      for (const t2 of reps) if (cosOf(t1, t2) >= cosTol) { unite(t1, t2); hit = true; break }
      if (!hit && reps.length < 16) reps.push(t1)
    }
  })
  const label = new Int32Array(T).fill(-1)
  const map = new Int32Array(T).fill(-1)
  let count = 0
  for (let t = 0; t < T; t++) {
    if (!eligible(t) || !(area[t] > 0)) continue
    const r = find(t)
    if (map[r] === -1) map[r] = count++
    label[t] = map[r]
  }
  return { label, count }
}

// ───────────────────────── 自动分割 ─────────────────────────

const ROLE_ZH = { bus: '本体', solarArray: '太阳翼', reflector: '反射面', feed: '馈源', boom: '伸展臂', radiator: '散热面', thruster: '推力器', sensor: '敏感器', other: '其他' }

/**
 * 自动分割（任务书 §5.4 ①–④ 的自动部分；⑤ 人工在工作台里改）。
 *
 * @param {{meshes, materials?, nodes?}} ir
 * @param {object} [opts]
 * @param {number[]} [opts.bodyMatrix]  列主序 4×4，模型系 → 本体系；*Body 输出都经它变换。可带均匀缩放（如 scaleToMeters）：
 *   长度（focalM / diameterM / offsetM / extentsM）乘 s、面积乘 s²，s = |det|^(1/3)；非均匀缩放不支持（先在 IR 上做）
 * @param {number} [opts.weldTol]  缺省 1e-6 × 包围盒对角线
 * @param {number} [opts.efficiency=28]  自动生成的 solarPanelGroups 效率（百分数 0–100，AGI_stk_metadata 口径）
 * @param {boolean} [opts.debug]  stats.debug 里附候选明细（调参用）
 * @param {object} [opts.planar]  {maxThicknessRatio=0.02, minNormalConsistency=0.8, minAreaFrac=0.01, relToLargest=0.2, gapRel=0.25}
 * @param {object} [opts.reflector]  {maxRmsRel=0.005, maxRmsRelNamed=0.015, smoothDeg=30, minAreaFrac=0.003, minFOverD=0.15, maxFOverD=3,
 *   minSagRatio=0.03, minAspect=0.5, maxCount=8}
 * @returns {{parts:object[], attachPoints:object[], solarPanelGroups:object[], materialGroups:object[], stats:object}}
 *   parts[]：{ id, name, role, source:'geometry'|'node'|'material'|'rest', tris, areaM2, surfaceM2, centroidBody,
 *     normalBody?, extentsM?, fitted?:{kind:'paraboloid', focalM, diameterM, vertexBody, axisBody, focusBody, offsetM, rmsRel},
 *     nodes:[名字]（整实例归本部件）, triRanges:[{node, mesh, ranges:[[起始三角形, 个数],…]}]（实例内的部分三角形），
 *     triRange?:[全局起始三角形, 个数]（部件三角形全局连续时才有）, solarGroup?:组名, attachPoint?:挂点名 }
 *   几何太阳翼（source='geometry'）的 areaM2 是单面投影面积；其余是表面积。太阳翼组只从几何太阳翼生成。
 *   attachPoints[] 带 part（部件 id）、source:'auto'；solarPanelGroups[] 带 partId——这两个键 schema 归一时会删，
 *   关联以部件上的 attachPoint / solarGroup 为准。
 */
export function autoSegment(ir, opts = {}) {
  const t0 = now()
  const P = { maxThicknessRatio: 0.02, minNormalConsistency: 0.8, minAreaFrac: 0.01, relToLargest: 0.2, gapRel: 0.25, ...(opts.planar || {}) }
  const R = { maxRmsRel: 0.005, maxRmsRelNamed: 0.015, smoothDeg: 30, minAreaFrac: 0.003, minFOverD: 0.15, maxFOverD: 3, minSagRatio: 0.03, minAspect: 0.5, maxCount: 8, ...(opts.reflector || {}) }
  const efficiency = Number.isFinite(opts.efficiency) ? opts.efficiency : 28
  const BM = isMat4(opts.bodyMatrix) ? Array.from(opts.bodyMatrix) : null

  const dbg = opts.debug ? { fits: [], clusters: [] } : null
  const asm = assemble(ir)
  const T = asm.T
  const empty = { parts: [], attachPoints: [], solarPanelGroups: [], materialGroups: [], stats: { tris: 0, ms: 0 } }
  if (T === 0) return empty
  const w = weldByPosition(asm.position, asm.index, opts.weldTol)
  const pos = w.position, idx = w.index
  const { nrm, area } = triNormals(pos, idx)
  asm.area = area
  let Atot = 0
  for (let t = 0; t < T; t++) Atot += area[t]
  if (!(Atot > 0)) return empty
  const materialGroups = segmentByMaterial(asm)
  const matRoleOfInst = new Array(asm.inst.length).fill('other')
  for (const g of materialGroups) for (const k of g.instances) matRoleOfInst[k] = g.role
  // 实例自身名字的提示（节点名 → 网格名）。材质组没给角色时用它：共用一个材质的装配里，
  // 多数票不会落到少数几个叫 Dish 的节点上，但反射面第二档门限与翼的「让位」判定仍该认它们的名字
  const instHint = asm.inst.map((x) => { const h = roleHint(x.name); return h.role !== 'other' ? h : roleHint(x.meshName) })
  const hintRoleOfInst = asm.inst.map((_, k) => (matRoleOfInst[k] !== 'other' ? matRoleOfInst[k] : instHint[k].role))

  const cc = connectedComponents(idx, w.vertexCount)
  const compTris = groupLists(cc.triComp, cc.count)
  const compArea = new Float64Array(cc.count)
  for (let t = 0; t < T; t++) compArea[cc.triComp[t]] += area[t]

  const owner = new Int32Array(T).fill(-1)         // 三角形 → 部件序号
  const parts = []
  const claim = (lists, part) => {
    const pi = parts.length
    let n = 0
    for (const list of lists) for (let i = 0; i < list.length; i++) { const t = list[i]; if (owner[t] === -1) { owner[t] = pi; n++ } }
    if (n === 0) return null
    part.tris = n
    parts.push(part)
    return part
  }

  // ── ③ 平面候选（先算，反射面要避开太阳翼三角形）──
  const planarCands = []
  const candMin = 0.001 * Atot
  for (let c = 0; c < cc.count; c++) {
    if (compArea[c] < candMin) continue
    const pc = planarCluster(pos, idx, compTris(c), P)
    if (pc && pc.planar) planarCands.push({ ...pc, comp: c, list: compTris(c) })
  }
  // 回退：翼与本体焊成一个连通分量时（TDRS-A、Satellite Kit 的翼），分量整体不平，上面一个候选也出不来。
  // 在这些「大而不平」的分量里按近共面相邻（≤ 5°）切出平片再当候选；本体的平侧面也会进来，交给后面的「两面朝空」剔除。
  const he = buildHalfEdges(idx, w.vertexCount)
  {
    const planarSet = new Set(planarCands.map((c) => c.comp))
    const fused = new Uint8Array(cc.count)
    let any = false
    for (let c = 0; c < cc.count; c++) if (compArea[c] >= candMin && !planarSet.has(c)) { fused[c] = 1; any = true }
    if (any) {
      const fp = flatPatches(he, nrm, area, 5, (t) => fused[cc.triComp[t]] === 1)
      const fpTris = groupLists(fp.label, fp.count)
      const fpArea = new Float64Array(fp.count)
      for (let t = 0; t < T; t++) if (fp.label[t] >= 0) fpArea[fp.label[t]] += area[t]
      for (let p = 0; p < fp.count; p++) {
        if (fpArea[p] < candMin) continue
        const pc = planarCluster(pos, idx, fpTris(p), P)
        if (pc && pc.planar) planarCands.push({ ...pc, comp: -1, list: fpTris(p) })
      }
    }
  }
  planarCands.sort((a, b) => b.areaM2 - a.areaM2 || a.comp - b.comp)
  // 太多碎片时只聚面积前 400 个（聚类两两比较是 O(n²)，碎片不影响翼的识别）
  if (planarCands.length > 400) planarCands.length = 400
  // 共面 + 相邻聚类（单链）
  const cosPar = Math.cos((5 * Math.PI) / 180)
  const upar = planarCands.map((_, i) => i)
  const ufind = (x) => { while (upar[x] !== x) { upar[x] = upar[upar[x]]; x = upar[x] } return x }
  for (let i = 0; i < planarCands.length; i++) {
    for (let j = i + 1; j < planarCands.length; j++) {
      const a = planarCands[i], b = planarCands[j]
      if (Math.abs(dot(a.normal, b.normal)) < cosPar) continue
      // 面外错位容差：两块自身厚度之和，或较窄一块宽度的 10 %。同一块板的正反两层片、电池片与基板常错开几毫米：
      // TDRS-D 正反贴图片错开 2 %板宽，Satellite Kit 的翼是正反两片相距 6.7 %板宽的夹层
      const offTol = Math.max(a.extents[2] + b.extents[2], 0.1 * Math.min(a.extents[1], b.extents[1]))
      if (Math.abs(dot(a.normal, sub(b.centroid, a.centroid))) > offTol) continue
      const gap = Math.max(planarGap(a, b), planarGap(b, a))
      if (gap > P.gapRel * Math.min(a.extents[1], b.extents[1])) continue
      const ra = ufind(i), rb = ufind(j)
      if (ra !== rb) upar[Math.max(ra, rb)] = Math.min(ra, rb)
    }
  }
  const clusterMap = new Map()
  planarCands.forEach((c, i) => { const r = ufind(i); if (!clusterMap.has(r)) clusterMap.set(r, []); clusterMap.get(r).push(c) })
  const clusters = []
  for (const members of clusterMap.values()) {
    const lead = members[0]
    const e1 = lead.axes[0], e2 = lead.axes[1]
    let n = [0, 0, 0], cen = [0, 0, 0], wsum = 0
    for (const m of members) {
      const s = dot(m.normal, lead.normal) >= 0 ? 1 : -1
      n = add(n, scl(m.normal, s * m.areaM2)); cen = add(cen, scl(m.centroid, m.areaM2)); wsum += m.areaM2
    }
    const normal = norm(n)
    const centroid = scl(cen, 1 / wsum)
    let areaM2 = wsum
    // 成员之间投影重叠（分成多个分量的叠层）→ 整簇栅格并集
    let overlap = false
    for (let i = 0; i < members.length && !overlap; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (planarOverlap(members[i], members[j]) > 0.05 * Math.min(members[i].areaM2, members[j].areaM2)) { overlap = true; break }
      }
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
    const frame = { centroid, axes: [e1, e2, normal] }
    for (const m of members) {
      for (let k = 0; k < 3; k++) {
        const [a, b] = boxInterval(frame, m, k)
        if (a < lo[k]) lo[k] = a; if (b > hi[k]) hi[k] = b
      }
    }
    if (overlap) {
      const ru = rasterUnionArea(pos, idx, members.map((m) => m.list), centroid, e1, e2, lo[0], hi[0], lo[1], hi[1])
      if (ru > 0) areaM2 = Math.min(areaM2, ru)
    }
    clusters.push({ members, normal, centroid, areaM2, lo, hi, extents: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], axes: [e1, e2, normal] })
  }
  clusters.sort((a, b) => b.areaM2 - a.areaM2)
  if (dbg) for (const c of clusters) dbg.clusters.push({ area: c.areaM2, members: c.members.length, tris: c.members.reduce((s, m) => s + m.list.length, 0), centroid: c.centroid, normal: c.normal, extents: c.extents, detail: c.members.map((m) => ({ area: m.areaM2, surf: m.surfaceM2, tris: m.list.length, c: m.centroid, ext: m.extents })) })
  // 候选：面积占全模型 ≥ minAreaFrac，且不小于最大平面簇的 relToLargest
  // 候选：面积占全模型 ≥ minAreaFrac（面积序前 12 个；射线判定按三角形逐个扫，簇数要有上限）
  const bigClusters = clusters.filter((c) => c.areaM2 >= P.minAreaFrac * Atot).slice(0, 12)
  const inCluster = new Uint8Array(cc.count)
  for (const c of clusters) for (const m of c.members) if (m.comp >= 0) inCluster[m.comp] = 1
  const taken = new Uint8Array(cc.count)
  const cmin = new Float64Array(cc.count * 3), cmax = new Float64Array(cc.count * 3)
  // 翼板上的细节（电池片、汇流条、边框、铰链）常是独立的小分量、本身不一定平：
  // 整个落在翼的薄板包络里（面内外扩 2 %，面外外扩 max(翼厚, 5 % 翼宽)）的分量并进这面翼，高亮与太阳翼组才完整。
  // 投影面积仍按簇成员算，不因吸收而变。必须先于下面的「两面朝空」判定：电池片就盖在板面上，不先认领的话射线一出板面就撞上它们。
  const absorb = (c) => {
    const extra = []
    const m1 = 0.02 * c.extents[0], m2 = 0.02 * c.extents[1]
    c.slabMargin = Math.max(c.extents[2], 0.05 * Math.min(c.extents[0], c.extents[1]))
    cmin.fill(Infinity); cmax.fill(-Infinity)
    for (let t = 0; t < T; t++) {
      const k = cc.triComp[t]
      if (inCluster[k] || taken[k]) continue
      for (let q = 0; q < 3; q++) {
        const v = idx[t * 3 + q] * 3
        const px = pos[v] - c.centroid[0], py = pos[v + 1] - c.centroid[1], pz = pos[v + 2] - c.centroid[2]
        for (let d = 0; d < 3; d++) {
          const ax = c.axes[d], u = px * ax[0] + py * ax[1] + pz * ax[2]
          if (u < cmin[k * 3 + d]) cmin[k * 3 + d] = u
          if (u > cmax[k * 3 + d]) cmax[k * 3 + d] = u
        }
      }
    }
    for (let k = 0; k < cc.count; k++) {
      if (inCluster[k] || taken[k] || !(cmax[k * 3] >= cmin[k * 3])) continue
      if (cmin[k * 3] >= c.lo[0] - m1 && cmax[k * 3] <= c.hi[0] + m1 && cmin[k * 3 + 1] >= c.lo[1] - m2 && cmax[k * 3 + 1] <= c.hi[1] + m2 &&
          cmin[k * 3 + 2] >= c.lo[2] - c.slabMargin && cmax[k * 3 + 2] <= c.hi[2] + c.slabMargin) extra.push(k)
    }
    return extra
  }
  // 两面朝空：太阳翼伸在本体外，沿板法向正反两边都看得到太空；本体的一块侧板（NASA 模型常把箱体拆成六块独立的板）
  // 朝里那一边必定撞上对面的板。从各成员中心沿 ±法向打射线（跳过本簇与它吸收的细节、薄板包络内的命中不算），
  // 一半以上的采样被挡就不是太阳翼。
  const skipTri = new Uint8Array(T)
  const bothSidesOpen = (c, extra) => {
    const mark = (v) => {
      for (const m of c.members) for (let i = 0; i < m.list.length; i++) skipTri[m.list[i]] = v
      for (const k of extra) { const l = compTris(k); for (let i = 0; i < l.length; i++) skipTri[l[i]] = v }
    }
    mark(1)
    const Lmax = 3 * Math.max(c.extents[0], c.extents[1])
    // 预筛：所有射线都平行于簇法向、起点都在簇的面内包络里，只有面内投影与包络相交、
    // 法向坐标落在 ±Lmax 内的三角形才可能被打中。扫一遍全模型做投影，比每根射线都扫全模型快一两个数量级。
    const cand = []
    {
      const [a0, a1, a2] = c.axes, [cx, cy, cz] = c.centroid
      const eps = 1e-6 * Math.max(c.extents[0], c.extents[1])
      for (let t = 0; t < T; t++) {
        if (skipTri[t]) continue
        let n0 = Infinity, x0 = -Infinity, n1 = Infinity, x1 = -Infinity, n2 = Infinity, x2 = -Infinity
        for (let q = 0; q < 3; q++) {
          const v = idx[t * 3 + q] * 3
          const px = pos[v] - cx, py = pos[v + 1] - cy, pz = pos[v + 2] - cz
          const u0 = px * a0[0] + py * a0[1] + pz * a0[2], u1 = px * a1[0] + py * a1[1] + pz * a1[2], u2 = px * a2[0] + py * a2[1] + pz * a2[2]
          if (u0 < n0) n0 = u0; if (u0 > x0) x0 = u0
          if (u1 < n1) n1 = u1; if (u1 > x1) x1 = u1
          if (u2 < n2) n2 = u2; if (u2 > x2) x2 = u2
        }
        if (x0 < c.lo[0] - eps || n0 > c.hi[0] + eps || x1 < c.lo[1] - eps || n1 > c.hi[1] + eps || x2 < c.lo[2] - Lmax || n2 > c.hi[2] + Lmax) continue
        cand.push(t)
      }
    }
    // 每个成员取包围盒中心与面内 ±¼ 跨度四点：只打中心一根会在对称模型上从正中的穿孔（翼杆穿舱处）漏出去
    const samples = []
    for (const m of c.members.slice(0, 3)) {
      const c1 = (m.lo[0] + m.hi[0]) / 2, c2 = (m.lo[1] + m.hi[1]) / 2
      for (const [du, dv] of [[0, 0], [0.25, 0], [-0.25, 0], [0, 0.25], [0, -0.25]]) {
        samples.push(add(m.centroid, add(scl(m.axes[0], c1 + du * m.extents[0]), scl(m.axes[1], c2 + dv * m.extents[1]))))
      }
    }
    let blocked = 0
    for (const o of samples) {
      if (rayHits(pos, idx, null, o, c.normal, Lmax, c.slabMargin, cand) || rayHits(pos, idx, null, o, scl(c.normal, -1), Lmax, c.slabMargin, cand)) blocked++
    }
    mark(0)
    return blocked * 2 < samples.length
  }
  // 先判两面朝空、再与「最大的开放簇」比 relToLargest：本体侧板可能比翼还大，拿它当基准会把翼筛掉
  const open = []
  for (const c of bigClusters) {
    const extra = absorb(c)
    const isOpen = bothSidesOpen(c, extra)
    if (dbg) dbg.clusters.find((d) => d.centroid === c.centroid).open = isOpen
    if (!isOpen) continue
    c.extraComps = extra
    for (const k of extra) taken[k] = 1
    open.push(c)
  }
  const largestOpen = open.length ? Math.max(...open.map((c) => c.areaM2)) : 0
  const solar = []
  const solarTri = new Uint8Array(T)
  for (const c of open) {
    if (c.areaM2 < P.relToLargest * largestOpen) { for (const k of c.extraComps) taken[k] = 0; continue }
    c.extra = c.extraComps.map((k) => compTris(k))
    solar.push(c)
    for (const m of c.members) for (let i = 0; i < m.list.length; i++) solarTri[m.list[i]] = 1
    for (const l of c.extra) for (let i = 0; i < l.length; i++) solarTri[l[i]] = 1
  }

  // ── ④ 反射面：连通分量整体 + 光滑片，两级候选 ──
  const patches = smoothPatches(he, nrm, area, R.smoothDeg, (t) => !solarTri[t])
  const patchTris = groupLists(patches.label, patches.count)
  const patchArea = new Float64Array(patches.count)
  for (let t = 0; t < T; t++) if (patches.label[t] >= 0) patchArea[patches.label[t]] += area[t]
  const refMin = Math.max(R.minAreaFrac * Atot, 0)
  const candLists = []
  const planarComp = new Set(planarCands.map((c) => c.comp))
  // 含太阳翼三角形的分量（翼与本体焊在一起）不整体拟合：反射面先认领，整体认成反射面会把翼吞掉
  const compHasSolar = new Uint8Array(cc.count)
  for (let t = 0; t < T; t++) if (solarTri[t]) compHasSolar[cc.triComp[t]] = 1
  for (let c = 0; c < cc.count; c++) {
    if (compArea[c] >= refMin && !planarComp.has(c) && !compHasSolar[c]) candLists.push({ list: compTris(c), level: 'component', area: compArea[c] })
  }
  for (let p = 0; p < patches.count; p++) {
    if (patchArea[p] < refMin) continue
    const list = patchTris(p)
    // 与所在分量完全相同的片已作为分量候选
    if (list.length === cc.triCount[cc.triComp[list[0]]]) continue
    candLists.push({ list, level: 'patch', area: patchArea[p] })
  }
  candLists.sort((a, b) => b.area - a.area)
  if (candLists.length > 200) candLists.length = 200
  const seenVert = new Int32Array(w.vertexCount).fill(-1)
  const refl = []
  let fits = 0
  candLists.forEach((cand, ci) => {
    const { list } = cand
    if (list.length < 8) return
    const pc = planarCluster(pos, idx, list, { ...P, planform: false })
    // 矢高 / 口径太小的弯板（缓弯的蒙皮、柱面片）也能被远偏置的浅抛物面拟得很贴，不认。
    // 实际通信反射面 f/D（按母抛物面口径）多在 0.25–1.5，矢高比 ≥ 0.04；门槛取 0.03。
    if (!pc || pc.thicknessRatio < R.minSagRatio) return
    // 片内唯一顶点
    const pts = []
    for (let i = 0; i < list.length; i++) {
      for (let k = 0; k < 3; k++) {
        const v = idx[list[i] * 3 + k]
        if (seenVert[v] === ci) continue
        seenVert[v] = ci
        pts.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2])
      }
    }
    // 6 个参数的拟合至少要几十个点才有「残差小」的意义；粗模型的小零件点少、随便什么形状都能拟得很贴
    if (pts.length < 30 * 3) return
    fits++
    const fit = fitParaboloid(Float64Array.from(pts))
    if (dbg && fit) dbg.fits.push({ level: cand.level, tris: list.length, pts: pts.length / 3, rmsRel: fit.rmsRel, fOverD: fit.fOverD, D: fit.diameterM, f: fit.focalM, thick: pc.thicknessRatio, nc: pc.normalConsistency, aspect: fit.apertureAspect, depthRel: fit.depthM / fit.diameterM })
    if (!fit || !(fit.fOverD >= R.minFOverD && fit.fOverD <= R.maxFOverD) || !(fit.apertureAspect >= R.minAspect)) return
    // 残差门限两档：< maxRmsRel（0.5 %，任务书口径）纯几何即认；
    // 到 maxRmsRelNamed（1.5 %）之间要名字（材质名 / 节点名 / 网格名，见 segmentByMaterial）也说它是反射面 / 天线才认——
    // 伞状网面反射面（TDRS 单址天线）肋间网面下垂成扇贝形，真反射面也拟到 0.57 %。
    if (!(fit.rmsRel < R.maxRmsRel)) {
      if (!(fit.rmsRel < R.maxRmsRelNamed)) return
      let ra = 0, aa0 = 0
      for (let i = 0; i < list.length; i++) { const t = list[i]; aa0 += area[t]; if (hintRoleOfInst[asm.triInst[t]] === 'reflector') ra += area[t] }
      if (!(ra * 2 > aa0)) return
    }
    // 面法向与轴向大体一致（碟面，不是筒壁）
    let nk = 0, aa = 0
    for (let i = 0; i < list.length; i++) {
      const t = list[i]
      nk += area[t] * Math.abs(nrm[t * 3] * fit.axis[0] + nrm[t * 3 + 1] * fit.axis[1] + nrm[t * 3 + 2] * fit.axis[2]); aa += area[t]
    }
    if (!(aa > 0) || nk / aa < 0.6) return
    refl.push({ fit, lists: [list], area: cand.area, level: cand.level })
  })
  // 去重：同一面碟的前后表面、分量与它自己的光滑片——轴平行且焦点相近的并成一个，参数取残差小者，三角形取并集
  refl.sort((a, b) => a.fit.rmsRel - b.fit.rmsRel)
  const reflectors = []
  for (const r of refl) {
    const dupOf = reflectors.find((q) => Math.abs(dot(q.fit.axis, r.fit.axis)) > Math.cos((10 * Math.PI) / 180) &&
      len(sub(q.fit.focus, r.fit.focus)) <= 0.2 * Math.max(q.fit.diameterM, r.fit.diameterM))
    if (dupOf) { dupOf.lists.push(...r.lists); continue }
    if (reflectors.length < R.maxCount) reflectors.push({ ...r, lists: [...r.lists] })
  }
  reflectors.sort((a, b) => b.fit.diameterM - a.fit.diameterM)

  // ── 认领：反射面 → 太阳翼 → 馈源 → 节点名 → 材质名 → 本体 / 其他 ──
  // 面积、质心、三角形数一律等全部认领完后按 owner[] 一次算（见下「部件读数」）：认领时传进来的若干三角形表会重叠
  // （反射面去重时分量与它自己的光滑片、太阳翼吸收的整分量里含平片成员），按表累加会把同一三角形算两遍。
  const attachPoints = []
  const wings = []                                   // 几何太阳翼：{pi: 部件序号, c: 平面簇（带薄板包络）}
  reflectors.forEach((r, i) => {
    const f = r.fit
    const part = claim(r.lists, {
      id: `reflector-${i + 1}`, name: `${ROLE_ZH.reflector} ${i + 1}`, role: 'reflector', source: 'geometry',
      normalBody: xformDir(BM, f.axis),
      fitted: {
        kind: 'paraboloid', focalM: f.focalM, diameterM: f.diameterM,
        vertexBody: xformPoint(BM, f.vertex), axisBody: xformDir(BM, f.axis), focusBody: xformPoint(BM, f.focus),
        offsetM: f.offsetM, rmsRel: f.rmsRel,
      },
    })
    if (!part) return
    // up：偏置方向；近似正馈时取与轴最不平行的坐标轴在口面内的投影
    const up = f.offsetDir && f.offsetM > 0.01 * f.diameterM ? f.offsetDir : basisPerp(f.axis)[0]
    const name = `reflector${i + 1}_focus`
    // 部件 ↔ 挂点的关联反写在部件上：schema.normalizeMeta 只保留挂点的几何字段，部件的扩展键会原样保留
    part.attachPoint = name
    attachPoints.push({
      name, part: part.id, source: 'auto',
      posBody: xformPoint(BM, f.focus), dirBody: xformDir(BM, f.axis), upBody: xformDir(BM, up),
    })
  })
  solar.forEach((c) => {
    const lists = [...c.members.map((m) => m.list), ...(c.extra || [])]
    // 名字明确说它是散热面 / 反射面时让位给名字的角色（大平板不一定是太阳翼）
    const votes = new Map()
    let tot = 0
    for (const list of lists) for (let q = 0; q < list.length; q++) { const t = list[q]; const r = hintRoleOfInst[asm.triInst[t]]; votes.set(r, (votes.get(r) || 0) + area[t]); tot += area[t] }
    let role = 'solarArray'
    for (const [r, a] of votes) if (r !== 'other' && r !== 'solarArray' && r !== 'bus' && a * 2 > tot) role = r
    const n = parts.filter((p) => p.role === role).length + 1
    const part = claim(lists, {
      id: `${role}-${n}`, name: `${ROLE_ZH[role] || role} ${n}`, role, source: 'geometry',
      normalBody: xformDir(BM, c.normal), extentsM: c.extents.slice(),
    })
    if (!part) return
    if (role === 'solarArray') { part._projM2 = c.areaM2; wings.push({ pi: parts.length - 1, c }) }
  })
  // 馈源：焦点附近（0.15 口径内或包围盒含焦点）的小分量
  reflectors.forEach((r, i) => {
    const F = r.fit.focus, D = r.fit.diameterM
    let best = -1, bestD = Infinity
    for (let c = 0; c < cc.count; c++) {
      if (compArea[c] > 0.05 * Atot) continue
      const list = compTris(c)
      if (owner[list[0]] !== -1) continue
      let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], s = [0, 0, 0], nv = 0
      for (let q = 0; q < list.length; q++) {
        for (let k = 0; k < 3; k++) {
          const v = idx[list[q] * 3 + k] * 3
          for (let d = 0; d < 3; d++) { const x = pos[v + d]; if (x < lo[d]) lo[d] = x; if (x > hi[d]) hi[d] = x; s[d] += x }
          nv++
        }
      }
      const cen = scl(s, 1 / nv)
      const inside = F.every((x, d) => x >= lo[d] - 1e-9 && x <= hi[d] + 1e-9)
      const dist = inside ? 0 : len(sub(cen, F))
      if (dist <= 0.15 * D && dist < bestD) { bestD = dist; best = c }
    }
    if (best < 0) return
    claim([compTris(best)], { id: `feed-${i + 1}`, name: `${ROLE_ZH.feed} ${i + 1}`, role: 'feed', source: 'geometry' })
  })

  const instTris = (k) => { const x = asm.inst[k]; const a = new Uint32Array(x.triCount); for (let q = 0; q < x.triCount; q++) a[q] = x.triStart + q; return a }
  // 名字说是太阳翼的三角形：质心落在某面几何翼的薄板包络里（面内外扩 2 %、面外 ± 薄板裕量）的并进那面翼。
  // 背板、边框、电池片常是单独的材质 / 节点（SSL-1300 的 SolarPanel-gold 背板与单翼面积同量级），
  // 单独成部件会让「太阳翼」多出几份、二期功率重复计。按三角形判而不是按整组质心：两翼共用一个背板材质时，
  // 整组质心落在两翼中间（本体上），哪面翼也进不去。返回没并进去、仍未认领的三角形。
  const mergeIntoWings = (lists) => {
    const rest = []
    for (const list of lists) {
      for (let q = 0; q < list.length; q++) {
        const t = list[q]
        if (owner[t] !== -1) continue
        let into = -1
        if (wings.length) {
          const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c3 = idx[t * 3 + 2] * 3
          const x = (pos[a] + pos[b] + pos[c3]) / 3, y = (pos[a + 1] + pos[b + 1] + pos[c3 + 1]) / 3, z = (pos[a + 2] + pos[b + 2] + pos[c3 + 2]) / 3
          for (const wg of wings) {
            const c = wg.c
            const px = x - c.centroid[0], py = y - c.centroid[1], pz = z - c.centroid[2]
            const u0 = px * c.axes[0][0] + py * c.axes[0][1] + pz * c.axes[0][2]
            const u1 = px * c.axes[1][0] + py * c.axes[1][1] + pz * c.axes[1][2]
            const u2 = px * c.axes[2][0] + py * c.axes[2][1] + pz * c.axes[2][2]
            const m1 = 0.02 * c.extents[0], m2 = 0.02 * c.extents[1]
            if (u0 >= c.lo[0] - m1 && u0 <= c.hi[0] + m1 && u1 >= c.lo[1] - m2 && u1 <= c.hi[1] + m2 &&
                u2 >= c.lo[2] - c.slabMargin && u2 <= c.hi[2] + c.slabMargin) { into = wg.pi; break }
          }
        }
        if (into >= 0) owner[t] = into
        else rest.push(t)
      }
    }
    return Uint32Array.from(rest)
  }
  // 名字给的太阳翼剩余件：泛称（array / panel）要几何佐证——剩下的三角形整体近平面才认，否则不按名字认领
  const solarOk = (rest, weak) => {
    if (!rest.length) return false
    if (!weak) return true
    const pc = planarCluster(pos, idx, rest, { ...P, planform: false })
    return !!(pc && pc.planar)
  }

  // ── ① 节点名（任务书 §5.4 ①：STEP / 用户 CAD 装配的节点树就是部件划分）──
  // 只在多实例时做（单网格模型没有节点可分）。每个实例先看自己的名字（节点名 → 网格名），认不出再往上找祖先装配节点
  // （STEP 里零件叫 Body1、装配叫 SolarArray_L 很常见），同一祖先下的实例并成一个部件。
  // 大节点不按名字认：根节点常以整星命名（「Solar Dynamics Observatory」），按它的名字会把整星标成太阳翼。
  // 实例自己的名字门槛放宽到全模型面积的一半；祖先门槛收到四分之一——美术模型的中间节点常是随手起的名，
  // NASA「Hubble Space Telescope (B)」的「-V2 mast01」底下挂的是整面太阳翼（占全模型一半），按它会把整翼标成伸展臂。
  // 认不出的实例留给材质名与本体 / 其他。
  if (asm.inst.length > 1) {
    const nodes = Array.isArray(ir?.nodes) ? ir.nodes : []
    const NN = nodes.length
    const parentOf = (i) => { const p = nodes[i] && nodes[i].parent; return Number.isInteger(p) && p >= 0 && p < NN && p !== i ? p : -1 }
    const instArea = new Float64Array(asm.inst.length)
    for (let t = 0; t < T; t++) instArea[asm.triInst[t]] += area[t]
    const subArea = new Float64Array(NN)
    // 步数上限防父子成环（worldMatrices 同样按环断开处理）
    asm.inst.forEach((x, k) => { for (let a = x.node, s = 0; a >= 0 && s <= NN; a = parentOf(a), s++) subArea[a] += instArea[k] })
    const bigOwn = 0.5 * Atot, bigAnc = 0.25 * Atot
    const byKey = new Map()
    asm.inst.forEach((x, k) => {
      let h = instArea[k] < bigOwn ? instHint[k] : NO_HINT
      let key = x.node >= 0 ? `n${x.node}` : `i${k}`, name = x.name, node = x.node
      if (h.role === 'other' && x.node >= 0) {
        for (let a = parentOf(x.node), s = 0; a >= 0 && s < NN; a = parentOf(a), s++) {
          if (!(subArea[a] < bigAnc)) break
          const ha = roleHint(nodes[a] && nodes[a].name)
          if (ha.role !== 'other') { h = ha; key = `n${a}`; name = nodes[a].name; node = a; break }
        }
      }
      if (h.role === 'other') return
      let g = byKey.get(key)
      if (!g) { g = { name, role: h.role, weak: h.weak, id: node >= 0 ? `node-${node}` : `inst-${k}`, inst: [] }; byKey.set(key, g) }
      g.inst.push(k)
    })
    for (const g of byKey.values()) {
      const lists = g.inst.map(instTris)
      if (g.role === 'solarArray') {
        const rest = mergeIntoWings(lists)
        if (solarOk(rest, g.weak)) claim([rest], { id: g.id, name: g.name, role: 'solarArray', source: 'node' })
      } else {
        claim(lists, { id: g.id, name: g.name, role: g.role, source: 'node' })
      }
    }
  }
  // ── ② 材质名 ──
  for (const g of materialGroups) {
    if (g.role === 'other') continue
    const lists = g.instances.map(instTris)
    if (g.role === 'solarArray') {
      const rest = mergeIntoWings(lists)
      if (solarOk(rest, g.weak)) claim([rest], { id: `${g.id}`, name: g.name, role: 'solarArray', source: 'material', material: g.material })
    } else {
      claim(lists, { id: `${g.id}`, name: g.name, role: g.role, source: 'material', material: g.material })
    }
  }
  // 本体 = 剩余里面积最大的连通分量；其余并成 other
  const restArea = new Float64Array(cc.count)
  for (let t = 0; t < T; t++) if (owner[t] === -1) restArea[cc.triComp[t]] += area[t]
  let busC = -1
  for (let c = 0; c < cc.count; c++) if (restArea[c] > 0 && (busC < 0 || restArea[c] > restArea[busC])) busC = c
  if (busC >= 0) claim([compTris(busC)], { id: 'bus', name: ROLE_ZH.bus, role: 'bus', source: 'rest' })
  {
    const rest = []
    for (let t = 0; t < T; t++) if (owner[t] === -1) rest.push(t)
    if (rest.length) claim([Uint32Array.from(rest)], { id: 'other', name: ROLE_ZH.other, role: 'other', source: 'rest' })
  }

  // ── 部件读数：按 owner[] 一次累加，每个三角形只算一次 ──
  const NP = parts.length
  {
    const cnt = new Uint32Array(NP), A = new Float64Array(NP), S = new Float64Array(NP * 3)
    for (let t = 0; t < T; t++) {
      const p = owner[t]
      if (p < 0) continue
      const ar = area[t]
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
      cnt[p]++; A[p] += ar
      S[p * 3] += ar * (pos[a] + pos[b] + pos[c]); S[p * 3 + 1] += ar * (pos[a + 1] + pos[b + 1] + pos[c + 1]); S[p * 3 + 2] += ar * (pos[a + 2] + pos[b + 2] + pos[c + 2])
    }
    parts.forEach((part, p) => {
      part.tris = cnt[p]
      part.surfaceM2 = A[p]
      part.centroidBody = A[p] > 0 ? xformPoint(BM, [S[p * 3] / (3 * A[p]), S[p * 3 + 1] / (3 * A[p]), S[p * 3 + 2] / (3 * A[p])]) : null
      // 几何太阳翼给单面投影面积（迎光面积），其余给表面积
      part.areaM2 = part._projM2 != null ? part._projM2 : A[p]
      delete part._projM2
    })
  }

  // bodyMatrix 带均匀缩放时，点已经随矩阵缩放，长度与面积在这里补乘
  if (BM) {
    const sc = Math.cbrt(Math.abs(BM[0] * (BM[5] * BM[10] - BM[9] * BM[6]) - BM[4] * (BM[1] * BM[10] - BM[9] * BM[2]) + BM[8] * (BM[1] * BM[6] - BM[5] * BM[2])))
    if (sc > 0 && Math.abs(sc - 1) > 1e-12) {
      for (const p of parts) {
        if (Number.isFinite(p.areaM2)) p.areaM2 *= sc * sc
        if (Number.isFinite(p.surfaceM2)) p.surfaceM2 *= sc * sc
        if (p.extentsM) p.extentsM = p.extentsM.map((x) => x * sc)
        if (p.fitted) { p.fitted.focalM *= sc; p.fitted.diameterM *= sc; p.fitted.offsetM *= sc }
      }
      for (const g of materialGroups) g.areaM2 *= sc * sc
    }
  }

  // ── 三角形 → 实例区间（整实例进 nodes，部分进 triRanges；全局连续时另给 triRange）──
  const perPart = parts.map(() => new Map())       // 实例 → [[start,count],…]
  const cntPart = parts.map(() => new Map())
  const gLo = new Int32Array(NP).fill(-1), gHi = new Int32Array(NP)
  for (let t = 0; t < T; t++) {
    const p = owner[t]
    if (p < 0) continue
    if (gLo[p] < 0) gLo[p] = t
    gHi[p] = t
    const k = asm.triInst[t], local = t - asm.inst[k].triStart
    let rs = perPart[p].get(k)
    if (!rs) { rs = []; perPart[p].set(k, rs) }
    const last = rs[rs.length - 1]
    if (last && last[0] + last[1] === local) last[1]++
    else rs.push([local, 1])
    cntPart[p].set(k, (cntPart[p].get(k) || 0) + 1)
  }
  parts.forEach((part, p) => {
    part.nodes = []
    part.triRanges = []
    for (const [k, rs] of perPart[p]) {
      const x = asm.inst[k]
      if (cntPart[p].get(k) === x.triCount) part.nodes.push(x.name)
      else part.triRanges.push({ node: x.name, mesh: x.mesh, ranges: rs })
    }
    // 设计契约 §3.2 / 任务书 §4.1 的 triRange:[start,count]（全局编号）只在部件三角形恰好连续时给得出；
    // 分散的（材质交错、翼与本体焊在一个分量里切出来的）只能靠 triRanges
    if (part.triRanges.length && gHi[p] - gLo[p] + 1 === part.tris) part.triRange = [gLo[p], part.tris]
  })

  // 太阳翼组只从几何识别的翼生成：有法向与单面投影面积，二期功率按组取法向才算得对。
  // 名字给的太阳翼剩余件（没落进任何几何翼的材质碎片、被 panel 泛称误中的侧板）保留为部件，不出组。
  // 组名走 AGI 规则（非空、无空白，schema.agiNameOk）；nodes 只含整节点归本部件的那些——单网格模型的翼是网格里的
  // 一段三角形，没有节点可列，要进 STK 须导出时按 triRanges 拆出独立节点。
  // 组 ↔ 部件的关联反写在部件上（part.solarGroup）：schema.normalizeMeta 会删组上的 partId，但保留部件的扩展键。
  let sg = 0
  const solarPanelGroups = []
  for (const p of parts) {
    if (p.role !== 'solarArray' || p.source !== 'geometry') continue
    const name = `SolarArray${++sg}`
    p.solarGroup = name
    solarPanelGroups.push({ name, partId: p.id, nodes: p.nodes.slice(), efficiency })
  }
  return {
    parts, attachPoints, solarPanelGroups,
    materialGroups: materialGroups.map((g) => ({ id: g.id, name: g.name, role: g.role, weak: g.weak, tris: g.tris, areaM2: g.areaM2 })),
    stats: {
      tris: T, verts: (asm.position.length / 3) | 0, weldedVerts: w.vertexCount, components: cc.count, patches: patches.count,
      planarCandidates: planarCands.length, clusters: clusters.length, reflectorFits: fits, ms: now() - t0,
      ...(dbg ? { debug: dbg } : {}),
    },
  }
}
