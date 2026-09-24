// IR（中间表示）：参数化生成（paramBus）/ STEP 转换（occt）/ OBJ·STL·FBX 导入的公共出口（设计契约 §3.1）。
//
// 为什么要有 IR：三条来源各自产出网格，若各自直接变 three 对象，单位、节点名唯一化、统计口径就会
// 三份各写各的。IR 是纯数据（TypedArray + 普通对象），能过 postMessage / IPC 结构化克隆，node 可测；
// irToThree（渲染端）、massProps / segment（Worker）都只认 IR。
//
// 形状（契约原文，改之前先改契约）：
//   IR = { units:'m', unitHint, sourceFormat, materials:[…], meshes:[…], nodes:[…] }
//   material = { name, key?:MaterialKey, color:[r,g,b] 线性 0..1, metalness, roughness, emissive?, doubleSided?, opacity? }
//   mesh     = { name, position:Float32Array(3n), normal?:Float32Array(3n), uv?:Float32Array(2n), index:Uint32Array(3m), material:<下标> }
//   node     = { name 唯一非空, parent:<下标>|-1, mesh?:<下标>, matrix?:number[16] 列主序·相对父, role?:PartRole, extras?:{} }
//
// 导出：
//   MATERIAL_KEYS, PART_ROLES, UNIT_HINTS, IR_SOURCE_FORMATS
//   makeIR(opts) / addMaterial(ir, m) / addMesh(ir, m) / addNode(ir, n)   → 下标
//   validateIR(ir) → {ok, errors}
//   nodeWorldMatrices(ir) → (number[16]|null)[]（有环的节点为 null）
//   irStats(ir) → {tris, vertices, bboxM:{min,max}|null, areaM2, radiusFromOriginM, instances}
//   uniqueNodeNames(names) → {names, map}

import { resolveWorld } from './glb.mjs'

export const MATERIAL_KEYS = Object.freeze([
  'mli_gold', 'mli_silver', 'mli_black', 'solar_cell', 'solar_substrate', 'reflector', 'reflector_mesh',
  'aluminum', 'radiator', 'titanium', 'carbon', 'kapton_black', 'white_paint', 'glass', 'dark_metal',
  // A3（非卫星领域）扩充：船壳 / 甲板 / 集装箱 / 机翼漆面、轮胎、混凝土基础（A3 规格 §11-3、编排者裁定 §12-3）
  'paint_red', 'paint_navy', 'paint_blue', 'paint_green', 'paint_orange', 'paint_yellow', 'paint_grey', 'rubber', 'concrete'
])
export const PART_ROLES = Object.freeze(['bus', 'solarArray', 'reflector', 'feed', 'boom', 'radiator', 'thruster', 'sensor', 'other'])
export const UNIT_HINTS = Object.freeze(['m', 'cm', 'mm', 'in', 'ft', 'unknown'])
export const IR_SOURCE_FORMATS = Object.freeze(['param', 'step', 'iges', 'brep', 'obj', 'stl', 'fbx', 'glb'])

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const clamp01 = (v, d) => (isNum(v) ? Math.min(1, Math.max(0, v)) : d)
const rgb = (c, d) => (Array.isArray(c) && c.length === 3 && c.every(isNum) ? c.map((v) => Math.min(1, Math.max(0, v))) : d)

/** 新 IR。unitHint / sourceFormat 非法时取 'unknown' / 'param'。 */
export function makeIR(opts = {}) {
  const o = isObj(opts) ? opts : {}
  return {
    units: 'm',
    unitHint: UNIT_HINTS.includes(o.unitHint) ? o.unitHint : 'unknown',
    sourceFormat: IR_SOURCE_FORMATS.includes(o.sourceFormat) ? o.sourceFormat : 'param',
    materials: [],
    meshes: [],
    nodes: []
  }
}

/**
 * 加材质并归一：缺省 0.8 灰、金属度 0、粗糙度 0.5；key 不在材质库里就丢掉 key（按 color 等字段画）。
 * @returns {number} 材质下标
 */
export function addMaterial(ir, m = {}) {
  const s = isObj(m) ? m : {}
  const mat = {
    name: typeof s.name === 'string' && s.name ? s.name : `material_${ir.materials.length}`,
    color: rgb(s.color, [0.8, 0.8, 0.8]),
    metalness: clamp01(s.metalness, 0),
    roughness: clamp01(s.roughness, 0.5)
  }
  if (MATERIAL_KEYS.includes(s.key)) mat.key = s.key
  if (s.emissive !== undefined) { const e = rgb(s.emissive, null); if (e) mat.emissive = e }
  if (typeof s.doubleSided === 'boolean') mat.doubleSided = s.doubleSided
  if (isNum(s.opacity)) mat.opacity = Math.min(1, Math.max(0, s.opacity))
  ir.materials.push(mat)
  return ir.materials.length - 1
}

// 普通数组 → 契约里的 TypedArray；已是正确类型的不拷贝（大网格别白复制一份）
const asF32 = (a) => (a instanceof Float32Array ? a : (Array.isArray(a) || ArrayBuffer.isView(a) ? Float32Array.from(a) : null))
const asU32 = (a) => (a instanceof Uint32Array ? a : (Array.isArray(a) || ArrayBuffer.isView(a) ? Uint32Array.from(a) : null))

/**
 * 加网格。position / normal / uv 转 Float32Array，index 转 Uint32Array；没给 index 视为非索引三角形，
 * 生成 0..n−1（STL 就是这样）。material 缺省 0（若 IR 还没有材质就先补一个默认材质，保证下标有效）。
 * 这里只做形状转换，一致性（长度、下标越界、NaN）由 validateIR 查——导入大文件时别在热路径里重复遍历。
 * @returns {number} 网格下标
 */
export function addMesh(ir, m = {}) {
  const s = isObj(m) ? m : {}
  const position = asF32(s.position) || new Float32Array(0)
  const mesh = { name: typeof s.name === 'string' && s.name ? s.name : `mesh_${ir.meshes.length}`, position }
  const normal = s.normal != null ? asF32(s.normal) : null
  if (normal) mesh.normal = normal
  const uv = s.uv != null ? asF32(s.uv) : null
  if (uv) mesh.uv = uv
  let index = s.index != null ? asU32(s.index) : null
  if (!index) {
    const n = Math.floor(position.length / 3)
    index = new Uint32Array(n - (n % 3))
    for (let i = 0; i < index.length; i++) index[i] = i
  }
  mesh.index = index
  if (Number.isInteger(s.material)) mesh.material = s.material
  else {
    if (!ir.materials.length) addMaterial(ir, { name: 'default' })
    mesh.material = 0
  }
  ir.meshes.push(mesh)
  return ir.meshes.length - 1
}

/**
 * 加节点。name 空就给 node_<下标>（与 uniqueNodeNames 同一规则）；不在这里做重名处理——
 * 批量导入请先对整张名字表跑 uniqueNodeNames，保留原名映射，再逐个 addNode。
 * @returns {number} 节点下标
 */
export function addNode(ir, n = {}) {
  const s = isObj(n) ? n : {}
  const idx = ir.nodes.length
  const node = {
    name: typeof s.name === 'string' && s.name.trim() ? s.name : `node_${idx}`,
    parent: Number.isInteger(s.parent) ? s.parent : -1
  }
  if (Number.isInteger(s.mesh)) node.mesh = s.mesh
  if (Array.isArray(s.matrix) && s.matrix.length === 16) node.matrix = s.matrix.slice()
  if (PART_ROLES.includes(s.role)) node.role = s.role
  if (isObj(s.extras)) node.extras = JSON.parse(JSON.stringify(s.extras))
  ir.nodes.push(node)
  return idx
}

/**
 * 全量一致性检查。不抛异常；errors 每条带路径前缀。
 * 检查项：顶层字段、材质取值、网格长度与下标越界 / NaN、节点名唯一非空、parent 合法无环、mesh 下标、matrix 16 个有限数、role 枚举。
 */
export function validateIR(ir) {
  const errors = []
  if (!isObj(ir)) return { ok: false, errors: ['IR 不是对象'] }
  if (ir.units !== 'm') errors.push(`units：须为 'm'（得到 ${JSON.stringify(ir.units)}）`)
  if (!UNIT_HINTS.includes(ir.unitHint)) errors.push(`unitHint：非法值 ${JSON.stringify(ir.unitHint)}`)
  if (!IR_SOURCE_FORMATS.includes(ir.sourceFormat)) errors.push(`sourceFormat：非法值 ${JSON.stringify(ir.sourceFormat)}`)
  const materials = Array.isArray(ir.materials) ? ir.materials : (errors.push('materials：须为数组'), [])
  const meshes = Array.isArray(ir.meshes) ? ir.meshes : (errors.push('meshes：须为数组'), [])
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : (errors.push('nodes：须为数组'), [])

  materials.forEach((m, i) => {
    const p = `materials[${i}]`
    if (!isObj(m)) { errors.push(`${p}：不是对象`); return }
    if (typeof m.name !== 'string') errors.push(`${p}.name：须为字符串`)
    if (m.key !== undefined && !MATERIAL_KEYS.includes(m.key)) errors.push(`${p}.key：不在材质库里（${JSON.stringify(m.key)}）`)
    if (!(Array.isArray(m.color) && m.color.length === 3 && m.color.every((v) => isNum(v) && v >= 0 && v <= 1))) errors.push(`${p}.color：须为 0..1 的 [r,g,b]`)
    for (const k of ['metalness', 'roughness']) if (!(isNum(m[k]) && m[k] >= 0 && m[k] <= 1)) errors.push(`${p}.${k}：须为 0..1`)
    if (m.emissive !== undefined && !(Array.isArray(m.emissive) && m.emissive.length === 3 && m.emissive.every((v) => isNum(v) && v >= 0 && v <= 1))) errors.push(`${p}.emissive：须为 0..1 的 [r,g,b]`)
    if (m.opacity !== undefined && !(isNum(m.opacity) && m.opacity >= 0 && m.opacity <= 1)) errors.push(`${p}.opacity：须为 0..1`)
    if (m.doubleSided !== undefined && typeof m.doubleSided !== 'boolean') errors.push(`${p}.doubleSided：须为布尔`)
  })

  meshes.forEach((m, i) => {
    const p = `meshes[${i}]`
    if (!isObj(m)) { errors.push(`${p}：不是对象`); return }
    if (!(m.position instanceof Float32Array)) { errors.push(`${p}.position：须为 Float32Array`); return }
    if (m.position.length % 3) errors.push(`${p}.position：长度 ${m.position.length} 不是 3 的倍数`)
    const nv = Math.floor(m.position.length / 3)
    for (let k = 0; k < m.position.length; k++) if (!Number.isFinite(m.position[k])) { errors.push(`${p}.position[${k}]：不是有限数`); break }
    if (m.normal !== undefined) {
      if (!(m.normal instanceof Float32Array)) errors.push(`${p}.normal：须为 Float32Array`)
      else if (m.normal.length !== m.position.length) errors.push(`${p}.normal：长度 ${m.normal.length} ≠ position ${m.position.length}`)
    }
    if (m.uv !== undefined) {
      if (!(m.uv instanceof Float32Array)) errors.push(`${p}.uv：须为 Float32Array`)
      else if (m.uv.length !== nv * 2) errors.push(`${p}.uv：长度 ${m.uv.length} ≠ 2×顶点数 ${nv * 2}`)
    }
    if (!(m.index instanceof Uint32Array)) errors.push(`${p}.index：须为 Uint32Array`)
    else {
      if (m.index.length % 3) errors.push(`${p}.index：长度 ${m.index.length} 不是 3 的倍数`)
      for (let k = 0; k < m.index.length; k++) if (m.index[k] >= nv) { errors.push(`${p}.index[${k}]=${m.index[k]} 越界（顶点数 ${nv}）`); break }
    }
    if (!(Number.isInteger(m.material) && m.material >= 0 && m.material < materials.length)) errors.push(`${p}.material：下标 ${m.material} 越界`)
  })

  const seen = new Map()
  nodes.forEach((n, i) => {
    const p = `nodes[${i}]`
    if (!isObj(n)) { errors.push(`${p}：不是对象`); return }
    if (typeof n.name !== 'string' || !n.name.trim()) errors.push(`${p}.name：须为非空字符串`)
    else if (seen.has(n.name)) errors.push(`${p}.name：与 nodes[${seen.get(n.name)}] 重名「${n.name}」`)
    else seen.set(n.name, i)
    if (!(Number.isInteger(n.parent) && n.parent >= -1 && n.parent < nodes.length && n.parent !== i)) errors.push(`${p}.parent：非法（${n.parent}）`)
    if (n.mesh !== undefined && !(Number.isInteger(n.mesh) && n.mesh >= 0 && n.mesh < meshes.length)) errors.push(`${p}.mesh：下标 ${n.mesh} 越界`)
    if (n.matrix !== undefined && !(Array.isArray(n.matrix) && n.matrix.length === 16 && n.matrix.every(isNum))) errors.push(`${p}.matrix：须为 16 个有限数（列主序）`)
    if (n.role !== undefined && !PART_ROLES.includes(n.role)) errors.push(`${p}.role：非法值 ${JSON.stringify(n.role)}`)
    if (n.extras !== undefined && !isObj(n.extras)) errors.push(`${p}.extras：须为对象`)
  })
  // 环：沿 parent 链走，步数超过节点数就是有环
  nodes.forEach((n, i) => {
    if (!isObj(n)) return
    let cur = i, steps = 0
    while (cur !== -1 && steps <= nodes.length) {
      const nn = nodes[cur]
      if (!isObj(nn) || !Number.isInteger(nn.parent) || nn.parent < -1 || nn.parent >= nodes.length) return
      cur = nn.parent
      steps++
    }
    if (cur !== -1) errors.push(`nodes[${i}]：parent 链成环`)
  })
  return { ok: errors.length === 0, errors }
}

// ─────────────────────────────── 世界矩阵与统计 ───────────────────────────────

const IDENT = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

/**
 * 每个节点的世界矩阵（列主序，= 父世界 · 本地）。parent 非法或成环的节点给 null，统计时跳过。
 * 迭代求解（与 glb.mjs 同一个核）：CAD 装配体转来的 IR 可能有很深的父子链，递归会爆调用栈让 irStats 抛异常。
 */
export function nodeWorldMatrices(ir) {
  const nodes = isObj(ir) && Array.isArray(ir.nodes) ? ir.nodes : []
  const parentOf = nodes.map((n, i) => {
    if (!isObj(n)) return -2
    const p = n.parent
    if (p === -1 || p === undefined) return -1
    return Number.isInteger(p) && p >= 0 && p < nodes.length && p !== i ? p : -2
  })
  return resolveWorld(nodes.length, parentOf, (i) => {
    const n = nodes[i]
    if (!isObj(n)) return null
    return Array.isArray(n.matrix) && n.matrix.length === 16 && n.matrix.every(isNum) ? n.matrix.slice() : IDENT.slice()
  })
}

/**
 * 统计（米制，按节点世界矩阵变换后算）：三角形数、顶点数、包围盒、表面积、离原点最远距离。
 * 口径：
 *   · 同一网格被多个节点引用算多次（它在画面里就是多份）；
 *   · 没有任何节点的 IR（纯网格）按每个网格一份、单位矩阵统计——importers 半成品也能量；
 *   · 退化三角形面积为 0，照常计数；非法网格（validateIR 不过的）跳过，不抛。
 *   · radiusFromOriginM 是到本体原点的最远距离（图标定尺、相机远近用），不是包围球半径。
 */
export function irStats(ir) {
  const res = { tris: 0, vertices: 0, bboxM: null, areaM2: 0, radiusFromOriginM: 0, instances: 0 }
  if (!isObj(ir) || !Array.isArray(ir.meshes)) return res
  const meshes = ir.meshes
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : []
  const inst = []
  if (nodes.length) {
    const W = nodeWorldMatrices(ir)
    nodes.forEach((n, i) => { if (isObj(n) && Number.isInteger(n.mesh) && meshes[n.mesh] && W[i]) inst.push([n.mesh, W[i]]) })
  } else meshes.forEach((_, i) => inst.push([i, IDENT]))

  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  let r2max = 0
  for (const [mi, m] of inst) {
    const mesh = meshes[mi]
    if (!isObj(mesh) || !(mesh.position instanceof Float32Array) || !(mesh.index instanceof Uint32Array)) continue
    const P = mesh.position, I = mesh.index
    const nv = Math.floor(P.length / 3)
    // 先把顶点一次性变换到世界（Float64，避免大模型米级坐标在 float32 里丢精度），再按索引算面积
    const Wp = new Float64Array(nv * 3)
    for (let v = 0; v < nv; v++) {
      const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2]
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12]
      const wy = m[1] * x + m[5] * y + m[9] * z + m[13]
      const wz = m[2] * x + m[6] * y + m[10] * z + m[14]
      Wp[v * 3] = wx; Wp[v * 3 + 1] = wy; Wp[v * 3 + 2] = wz
    }
    // 包围盒只算被三角形引用到的顶点：导入件常带孤立顶点（CAD 的构造点），算进去会把盒子撑大
    const used = new Uint8Array(nv)
    const nt = Math.floor(I.length / 3)
    let area = 0
    for (let t = 0; t < nt; t++) {
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2]
      if (a >= nv || b >= nv || c >= nv) continue
      used[a] = 1; used[b] = 1; used[c] = 1
      const ax = Wp[a * 3], ay = Wp[a * 3 + 1], az = Wp[a * 3 + 2]
      const ux = Wp[b * 3] - ax, uy = Wp[b * 3 + 1] - ay, uz = Wp[b * 3 + 2] - az
      const vx = Wp[c * 3] - ax, vy = Wp[c * 3 + 1] - ay, vz = Wp[c * 3 + 2] - az
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx
      area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz)
    }
    for (let v = 0; v < nv; v++) {
      if (!used[v]) continue
      const x = Wp[v * 3], y = Wp[v * 3 + 1], z = Wp[v * 3 + 2]
      if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x
      if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y
      if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z
      const r2 = x * x + y * y + z * z
      if (r2 > r2max) r2max = r2
    }
    res.tris += nt
    res.vertices += nv
    res.areaM2 += area
    res.instances++
  }
  if (min.every(Number.isFinite)) res.bboxM = { min, max }
  res.radiusFromOriginM = Math.sqrt(r2max)
  return res
}

/**
 * 节点名唯一化（互操作硬要求：.gmdf 与 AGI 扩展按名字引用节点，名字必须唯一非空）。
 * 规则：
 *   · 非字符串或去空白后为空 → node_<下标>；
 *   · 重名：第一次出现保留原名，之后依次加 _2、_3…；后缀候选若撞上表里任何一个原名（哪怕在后面）
 *     或已分配的名字，就继续往上数——不抢别的节点的原名；
 *   · 非空名字原样保留（不 trim），因为 STK 端比对是逐字符的。
 * @param {Array<string|null|undefined>} names
 * @returns {{names:string[], map:Object<string,string>}}  map 只收被改动过的：{新名: 原名}（原名缺失记 ''）
 */
export function uniqueNodeNames(names) {
  const list = Array.isArray(names) ? names : []
  const valid = (s) => typeof s === 'string' && s.trim() !== ''
  const originals = new Set(list.filter(valid))
  const used = new Set()
  const out = new Array(list.length)
  const map = {}
  // 第一遍：合法且首次出现的原名先占位，保证「原名优先」不受出现顺序影响
  const firstIdx = new Map()
  list.forEach((s, i) => { if (valid(s) && !firstIdx.has(s)) firstIdx.set(s, i) })
  for (const [s, i] of firstIdx) { out[i] = s; used.add(s) }
  // 每个 base 记下一次该从哪个后缀试起：used / originals 只增不减，上次试过而被占的后缀这次一定仍被占，
  // 从头数只是白走——2 万个同名「Cell」的太阳翼从头数是 O(n²)（实测 37 s 卡死渲染主线程），续数是 O(n)，结果逐位相同。
  const nextK = new Map()
  const take = (base) => {
    if (!used.has(base) && !originals.has(base)) { used.add(base); return base }
    for (let k = nextK.get(base) || 2; ; k++) {
      const c = `${base}_${k}`
      if (!used.has(c) && !originals.has(c)) { used.add(c); nextK.set(base, k + 1); return c }
    }
  }
  list.forEach((s, i) => {
    if (out[i] !== undefined) return
    const name = valid(s) ? take(s) : take(`node_${i}`)
    out[i] = name
    map[name] = valid(s) ? s : (typeof s === 'string' ? s : '')
  })
  return { names: out, map }
}
