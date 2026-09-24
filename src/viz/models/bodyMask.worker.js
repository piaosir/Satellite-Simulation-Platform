// 本体遮挡掩模的射线核（二期契约 DESIGN2 §2 / D2 / D3 / D18）＋ Worker 薄壳。
//
// 做什么：给定「本体系下的整星三角形汤」与一个挂点（posBody、视轴 dirBody），从挂点向 360×181 个方向各打一条射线，
//   命中星体任意三角形即该方向被遮挡（blocked=1），并记最近命中距离（clearance，米）。
//   · 方向与格子布局一律取 packages/core/models/mask.mjs 的 maskDir（D2：az 自 +X 向 +Y、el=+90 为本体 +Z 天底；
//     index = elIdx·360 + azIdx）。这里不另写一份角坐标定义——生成端与所有查表端（可见性 / 对星表 / ISL / 报告 / 画图）同一处定义。
//   · 起点 = posBody + 1 cm·视轴（契约口径）：挂点多半就在安装面上，贴着面起射会被安装面自己「挡住」半个球。
//   · 未命中：clearance = +Infinity（Float32 可存；落盘 .bin 与 CSV 由各自的写出端处理，CSV 留空）。
//   · 另出 hitNode（Int32，命中三角形所属节点下标，未命中 −1）：悬停读数能说出「挡住它的是哪一件」，不参与任何判据。
//
// 为什么是三角形汤（每三角形 9 个 float、不带索引）：
//   ① 按节点排除（挂点 excludeNodes ∪ 模型 noObscurationNodes，连同子孙）时直接挑三角形压实，不用重建索引；
//   ② MeshBVH 非 indirect 模式会重排索引缓冲，faceIndex 不再是原编号；汤的顶点不共享，命中面的 face.a / 3 就是压实后的三角形号，
//      再查 keptNode 即得节点——重排不影响这条映射。
//
// 关节（D3）：掩模按「生成时的关节值」算。bodyGeometryFromIR 按 AGI stage 把关节值乘到节点静止矩阵上（与 viewport.setArticulation
//   同一口径：局部 = 静止 × Π stage，角度为度、平移为模型单位），缺省取各 stage 的 initialValue。
//
// 本文件同时是 Worker 入口：只有在 Worker 上下文里才挂 onmessage（node 单测与主线程回退 import 它时不挂）。
// 纯函数部分不碰 DOM，node 可直接 import（单测先注册 @core 解析钩子，同 modelRenderStack.test.mjs）。
import { BufferGeometry, BufferAttribute, Ray, Vector3, DoubleSide } from 'three'
import { MeshBVH, SAH, CENTER } from 'three-mesh-bvh'
import { maskDir, maskRayOrigin, MASK_W, MASK_H, MASK_N, MASK_RAY_OFFSET_M } from '@core/models/mask.mjs'
import { DEFAULT_Q_MODEL2BODY } from '@core/models/bodyFrame.mjs'
import { nodeWorldMatrices } from '@core/models/ir.mjs'

// 掩模尺寸与射线起点外推量一律取 mask.mjs（D2 / D18 唯一定义），这里只转出去
export { MASK_W, MASK_H, MASK_N, MASK_RAY_OFFSET_M }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

// ───────────────────────────── 方向表 ─────────────────────────────
// 65160 个方向只算一次（maskDir 逐格调用会分配小数组；热循环里查表）
let _dirs = null
export function maskDirTable() {
  if (_dirs) return _dirs
  const t = new Float64Array(MASK_N * 3)
  for (let j = 0; j < MASK_H; j++) {
    for (let i = 0; i < MASK_W; i++) {
      const d = maskDir(i, j)
      const k = (j * MASK_W + i) * 3
      t[k] = d[0]; t[k + 1] = d[1]; t[k + 2] = d[2]
    }
  }
  _dirs = t
  return t
}

// ───────────────────────────── 4×4 列主序小工具（纯 JS，不依赖 three） ─────────────────────────────
function m4mul(a, b, out = new Array(16)) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3]
    out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3
    out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3
    out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3
    out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3
  }
  return out
}
const I4 = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// AGI stage → 4×4（与 viewport.setArticulation 的 stageMatrix 逐式相同：角度为度，平移 / 缩放为模型单位）
export function stageMatrix(type, v) {
  const m = I4()
  const r = v * Math.PI / 180, c = Math.cos(r), s = Math.sin(r)
  switch (type) {
    case 'xTranslate': m[12] = v; break
    case 'yTranslate': m[13] = v; break
    case 'zTranslate': m[14] = v; break
    case 'xRotate': m[5] = c; m[6] = s; m[9] = -s; m[10] = c; break
    case 'yRotate': m[0] = c; m[2] = -s; m[8] = s; m[10] = c; break
    case 'zRotate': m[0] = c; m[1] = s; m[4] = -s; m[5] = c; break
    case 'xScale': m[0] = v; break
    case 'yScale': m[5] = v; break
    case 'zScale': m[10] = v; break
    case 'uniformScale': m[0] = v; m[5] = v; m[10] = v; break
    default: break
  }
  return m
}
// 模型系 → 本体系：v_body = R(q)·(s·v) + t（与 view.js modelToBodyMatrix 同式；q 缺省取 bodyFrame.mjs 的出厂值，不写死数字）
export function modelToBodyM4(frame, scaleToMeters) {
  const f = frame && typeof frame === 'object' ? frame : {}
  let q = Array.isArray(f.q_model2body) && f.q_model2body.length === 4 && f.q_model2body.every(isNum) ? f.q_model2body : DEFAULT_Q_MODEL2BODY
  const ql = Math.hypot(q[0], q[1], q[2], q[3])
  if (!(ql > 1e-12)) q = DEFAULT_Q_MODEL2BODY
  const n = Math.hypot(q[0], q[1], q[2], q[3])
  const x = q[0] / n, y = q[1] / n, z = q[2] / n, w = q[3] / n
  const t = Array.isArray(f.t_model2body) && f.t_model2body.length === 3 && f.t_model2body.every(isNum) ? f.t_model2body : [0, 0, 0]
  const s = isNum(scaleToMeters) && scaleToMeters > 0 ? scaleToMeters : 1
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z
  return [
    (1 - 2 * (yy + zz)) * s, (2 * (xy + wz)) * s, (2 * (xz - wy)) * s, 0,
    (2 * (xy - wz)) * s, (1 - 2 * (xx + zz)) * s, (2 * (yz + wx)) * s, 0,
    (2 * (xz + wy)) * s, (2 * (yz - wx)) * s, (1 - 2 * (xx + yy)) * s, 0,
    t[0], t[1], t[2], 1
  ]
}

/**
 * 关节状态 → 每个受控节点的「静止 × Π stage」局部矩阵。
 * state：{ [关节名]: 数组（按 stages 顺序）| { [stage 名]: 值 } }；缺的 stage 取 initialValue（D3：缺省 = initialValue）。
 * @returns {Map<string, number[16]>} 节点名 → 关节矩阵 A（右乘在静止矩阵上）
 */
export function articulationMatrices(articulations, state) {
  const out = new Map()
  if (!Array.isArray(articulations)) return out
  const st = state && typeof state === 'object' ? state : {}
  for (const art of articulations) {
    if (!art || !Array.isArray(art.nodes)) continue
    const sv = st[art.name]
    let A = I4()
    ;(art.stages || []).forEach((s, i) => {
      const v = Array.isArray(sv) ? sv[i] : (sv && typeof sv === 'object' ? sv[s.name] : undefined)
      const val = isNum(v) ? v : (isNum(s.initialValue) ? s.initialValue : 0)
      A = m4mul(A, stageMatrix(s.type, val))
    })
    for (const nm of art.nodes) {
      // 同一节点挂在多个关节下：按关节出现顺序依次右乘（AGI 未规定；STK 自带件里没有这种情况）
      out.set(nm, out.has(nm) ? m4mul(out.get(nm), A) : A)
    }
  }
  return out
}

/** 关节状态的规范签名（D3「签名含关节值」）：只含实际生效的值，键序固定 */
export function articulationSignature(articulations, state) {
  if (!Array.isArray(articulations) || !articulations.length) return ''
  const st = state && typeof state === 'object' ? state : {}
  const parts = []
  for (const art of articulations) {
    if (!art || !Array.isArray(art.stages)) continue
    const sv = st[art.name]
    const vals = art.stages.map((s, i) => {
      const v = Array.isArray(sv) ? sv[i] : (sv && typeof sv === 'object' ? sv[s.name] : undefined)
      return isNum(v) ? v : (isNum(s.initialValue) ? s.initialValue : 0)
    })
    parts.push(art.name + '=' + vals.map((v) => +v.toPrecision(12)).join(','))
  }
  return parts.sort().join(';')
}

/** 名单规范化：只留非空字符串，去重（保持首次出现的次序） */
const nameList = (a) => (Array.isArray(a) ? [...new Set(Array.from(a).filter((s) => typeof s === 'string' && s))] : [])

/**
 * IR（DESIGN §3.1；threeToIR / paramBus / occt 的公共出口）→ 本体系三角形汤。
 * @param ir IR（meshes[].position/index，nodes[].parent/matrix/mesh）
 * @param o  { frame?: {q_model2body,t_model2body}, scaleToMeters?, articulations?, articulationState?, meta?, noObscurationNodes? }
 *           meta 给了就从 meta.frame / meta.units.scaleToMeters / meta.articulations / meta.noObscurationNodes 取缺省
 * @returns {{positions:Float32Array, triNode:Int32Array, nodeNames:string[], nodeParent:Int32Array, tris:number, artSig:string,
 *            noObscuration:string[]}}
 *          positions：每三角形 9 个 float（本体系，米）；triNode：三角形所属节点下标；
 *          noObscuration：模型标了「不遮挡」的节点名（D2 §2：生成端排除它们，连同子孙）——随几何走，计算时缺省并入排除名单
 *          （resolveExclude），调用方不必记得再传一遍。
 * ★ 返回的对象当作不可变：池子按对象身份缓存签名，就地改数组会拿到旧掩模。要改就重新生成一份。
 */
export function bodyGeometryFromIR(ir, o = {}) {
  const meta = o.meta && typeof o.meta === 'object' ? o.meta : {}
  const frame = o.frame || meta.frame
  const scale = isNum(o.scaleToMeters) ? o.scaleToMeters : (meta.units && meta.units.scaleToMeters)
  const arts = Array.isArray(o.articulations) ? o.articulations : meta.articulations
  const nodesIn = ir && Array.isArray(ir.nodes) ? ir.nodes : []
  const meshes = ir && Array.isArray(ir.meshes) ? ir.meshes : []
  const artM = articulationMatrices(arts, o.articulationState)
  // 关节只改受控节点的局部矩阵（静止 × A），其余原样；世界矩阵走 ir.mjs 同一个迭代核（深链 / 成环不抛）
  const nodes = nodesIn.map((n) => {
    if (!n || !artM.has(n.name)) return n
    const rest = Array.isArray(n.matrix) && n.matrix.length === 16 ? n.matrix : I4()
    return { ...n, matrix: m4mul(rest, artM.get(n.name)) }
  })
  const W = nodeWorldMatrices({ nodes })
  const B = modelToBodyM4(frame, scale)
  // 先数三角形，一次分配
  let total = 0
  const inst = []
  nodes.forEach((n, i) => {
    if (!n || !Number.isInteger(n.mesh) || !meshes[n.mesh] || !W[i]) return
    const m = meshes[n.mesh]
    const nt = m.index ? Math.floor(m.index.length / 3) : Math.floor((m.position ? m.position.length : 0) / 9)
    if (!nt || !m.position) return
    inst.push([i, m, nt]); total += nt
  })
  const positions = new Float32Array(total * 9)
  const triNode = new Int32Array(total)
  let t = 0
  const M = new Array(16)
  for (const [ni, m, nt] of inst) {
    m4mul(B, W[ni], M)
    const p = m.position, idx = m.index
    for (let k = 0; k < nt; k++) {
      for (let v = 0; v < 3; v++) {
        const vi = idx ? idx[k * 3 + v] : k * 3 + v
        const x = p[vi * 3], y = p[vi * 3 + 1], z = p[vi * 3 + 2]
        const o9 = t * 9 + v * 3
        positions[o9] = M[0] * x + M[4] * y + M[8] * z + M[12]
        positions[o9 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]
        positions[o9 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
      }
      triNode[t++] = ni
    }
  }
  const nodeParent = new Int32Array(nodes.length)
  nodes.forEach((n, i) => { const p = n && n.parent; nodeParent[i] = Number.isInteger(p) && p >= 0 && p < nodes.length && p !== i ? p : -1 })
  return {
    positions, triNode, tris: total,
    nodeNames: nodes.map((n, i) => (n && typeof n.name === 'string' && n.name) || 'node_' + i),
    nodeParent,
    artSig: articulationSignature(arts, o.articulationState),
    noObscuration: nameList(Array.isArray(o.noObscurationNodes) ? o.noObscurationNodes : meta.noObscurationNodes)
  }
}

/**
 * 几何内容签名（BVH 缓存键）：位置字节 + 三角形→节点表 + 节点父子表 + 节点名 的双 32 位 FNV-1a（不同种子），16 位十六进制。
 * 按内容算而不是信调用方给的键：关节动了、轴向改了、LOD 换了，几何一变签名就变，缓存不可能拿到旧树。
 * ★ 节点名与父子表也进签名：排除标志按「名字 + 父链」算、命中读数取节点名——三角形一样、只是改了名或挪了层级的两份几何
 *   必须是两把键，否则排除名单作用在错的节点上。（noObscuration 不进：它并进排除名单，由排除名单键区分。）
 * 100 万 float 约 3 ms；节点表的代价与节点数成正比，可忽略。
 */
export function geometryHash(geom) {
  let h1 = 0x811c9dc5 | 0, h2 = 0x9e3779b9 | 0
  const mix = (u) => {
    h1 = Math.imul(h1 ^ u, 16777619)
    h2 = Math.imul(h2 ^ (u >>> 16 | u << 16), 2246822519)
  }
  const pb = geom.positions
  const pu = new Uint32Array(pb.buffer, pb.byteOffset, pb.length)
  for (let i = 0; i < pu.length; i++) mix(pu[i])
  const tn = geom.triNode
  for (let i = 0; i < tn.length; i++) mix(tn[i] | 0)
  mix(pu.length); mix(tn.length)
  // 节点表：父下标逐项、名字逐字符码（每个名字后补一个分隔值 0xFFFFFFFF，防 ['ab','c'] 与 ['a','bc'] 撞键）
  const par = geom.nodeParent || []
  for (let i = 0; i < par.length; i++) mix(par[i] | 0)
  mix(par.length)
  const names = geom.nodeNames || []
  for (let i = 0; i < names.length; i++) {
    const s = String(names[i])
    for (let c = 0; c < s.length; c++) mix(s.charCodeAt(c))
    mix(0xffffffff | 0)
  }
  mix(names.length)
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}

/**
 * 本次计算的排除名单（D2 §2）：挂点 excludeNodes ∪ 调用方 opts.exclude ∪ 几何自带的 noObscuration（模型「不遮挡」节点），
 * 去重、排序。池子与同步核（computeBodyMask）走同一份，结果逐位一致。
 * @param o { exclude?: string[], includeNoObscuration?: boolean（true = 不遮挡节点也算遮挡体，显式关掉缺省排除） }
 */
export function resolveExclude(geom, mount, o = {}) {
  const a = nameList(mount && mount.excludeNodes)
  const b = nameList(o && o.exclude)
  const c = o && o.includeNoObscuration === true ? [] : nameList(geom && geom.noObscuration)
  return [...new Set([...a, ...b, ...c])].sort()
}

/**
 * 被排除的节点（名单里的节点连同全部子孙）→ 每节点一个标志。
 * 名单 = resolveExclude 的结果（挂点 excludeNodes ∪ opts.exclude ∪ 几何自带的 noObscuration）。
 */
export function excludedNodeFlags(geom, names) {
  const n = geom.nodeNames.length
  const flags = new Uint8Array(n)
  const want = new Set((Array.isArray(names) ? names : []).filter((s) => typeof s === 'string' && s))
  if (!want.size) return flags
  const state = new Int8Array(n)   // 0 未定、1 排除、2 不排除
  const par = geom.nodeParent
  for (let i = 0; i < n; i++) {
    if (state[i]) continue
    // 沿父链找第一个已定或在名单里的祖先（迭代，防成环：最多走 n 步）
    const chain = []
    let k = i, verdict = 2
    for (let step = 0; k >= 0 && step <= n; step++) {
      if (state[k]) { verdict = state[k]; break }
      chain.push(k)
      if (want.has(geom.nodeNames[k])) { verdict = 1; break }
      k = par[k]
    }
    for (const c of chain) state[c] = verdict
  }
  for (let i = 0; i < n; i++) flags[i] = state[i] === 1 ? 1 : 0
  return flags
}

/** 排除名单的规范键（去重、排序） */
export const excludeKey = (names) => [...new Set((Array.isArray(names) ? names : []).filter((s) => typeof s === 'string' && s))].sort().join('\u0001')

// 建树策略的分界（三角形数）：SAH 建树约 2.2 µs/三角形、射线省 30–50%；CENTER 约 0.5 µs/三角形。
// 实测（node，单线程，6.4 万条射线）：默认卫星参数化 1.2 万：SAH 14+26 ms / CENTER 3+56 ms；
// ISS(B) lod1 5.3 万：SAH 149+106 / CENTER 20+157；ISS(D) IGOAL lod1 140 万：SAH 3037+127 / CENTER 737+190。
// 射线数固定（6.5 万），三角形一多建树就压过省下的射线时间，故 3 万以下用 SAH、以上用 CENTER。
export const SAH_MAX_TRIS = 30000

/**
 * 按排除标志压实三角形 → MeshBVH（策略见 SAH_MAX_TRIS）。
 * @param o { ownsPositions?: boolean } 调用方把 geom.positions 让给这棵树（Worker 里收到的是结构化克隆出来的私有副本）：
 *          不排除任何三角形时直接用它，不再 slice 一份（IGOAL lod1 省 ~50 MB 峰值内存与 20–30 ms）。
 *          主线程回退路不给：原数组还挂在调用方的 geom 上、还要发给别的线程，树要独占自己那份。
 * @returns {{bvh:MeshBVH|null, keptNode:Int32Array, keptTris:number, buildMs:number}}
 */
export function buildMaskBvh(geom, flags, o = {}) {
  const t0 = now()
  const tn = geom.triNode, pos = geom.positions
  let kept = 0
  for (let i = 0; i < tn.length; i++) if (!flags || !flags[tn[i]]) kept++
  const keptNode = new Int32Array(kept)
  if (!kept) return { bvh: null, keptNode, keptTris: 0, buildMs: now() - t0 }
  let arr
  if (kept === tn.length) {
    // MeshBVH（非 indirect）只重排它自己建的索引缓冲，不改顶点
    arr = o.ownsPositions && pos instanceof Float32Array ? (pos.length === kept * 9 ? pos : pos.subarray(0, kept * 9)) : pos.slice(0, kept * 9)
  } else {
    arr = new Float32Array(kept * 9)
    let k = 0
    for (let i = 0; i < tn.length; i++) {
      if (flags && flags[tn[i]]) continue
      arr.set(pos.subarray(i * 9, i * 9 + 9), k * 9)
      keptNode[k++] = tn[i]
    }
  }
  if (kept === tn.length) keptNode.set(tn)
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(arr, 3))
  const bvh = new MeshBVH(g, { strategy: kept <= SAH_MAX_TRIS ? SAH : CENTER, targetLeafSize: 8 })
  return { bvh, keptNode, keptTris: kept, buildMs: now() - t0 }
}

/**
 * 射线起点 = mask.mjs 的 maskRayOrigin（posBody + MASK_RAY_OFFSET_M·视轴单位向量）。
 * 这里只把非法入参挡在外面：位置非法按原点、视轴非法 / 零长按不外推（maskRayOrigin 对零长视轴本就不外推）。
 */
export function maskOrigin(mount) {
  const p = Array.isArray(mount && mount.posBody) && mount.posBody.length === 3 && mount.posBody.every(isNum) ? mount.posBody : [0, 0, 0]
  const d = mount && mount.dirBody
  const dir = Array.isArray(d) && d.length === 3 && d.every(isNum) ? d : [0, 0, 0]
  return maskRayOrigin(p, dir, [0, 0, 0])
}

/**
 * 逐行打射线。rows：要算的俯仰行下标（0..180）列表；结果按 rows 顺序紧排（每行 360 格）。
 * 极点行（elIdx 0 / 180）整行同一方向：只打一条，整行复制（D2「极点行整行同值」）。
 * @returns {{blocked:Uint8Array, clearance:Float32Array, hitNode:Int32Array, rays:number, castMs:number}}
 */
export function castRows(ctx, origin, rows) {
  const t0 = now()
  const nR = rows.length
  const blocked = new Uint8Array(nR * MASK_W)
  const clearance = new Float32Array(nR * MASK_W).fill(Infinity)
  const hitNode = new Int32Array(nR * MASK_W).fill(-1)
  const dirs = maskDirTable()
  const bvh = ctx && ctx.bvh
  let rays = 0
  if (bvh) {
    const ray = new Ray(new Vector3(origin[0], origin[1], origin[2]), new Vector3())
    const keptNode = ctx.keptNode
    for (let r = 0; r < nR; r++) {
      const j = rows[r]
      const pole = j === 0 || j === MASK_H - 1
      const iEnd = pole ? 1 : MASK_W
      for (let i = 0; i < iEnd; i++) {
        const k = (j * MASK_W + i) * 3
        ray.direction.set(dirs[k], dirs[k + 1], dirs[k + 2])
        const hit = bvh.raycastFirst(ray, DoubleSide, 0, Infinity)
        rays++
        if (hit) {
          const o = r * MASK_W + i
          blocked[o] = 1
          clearance[o] = hit.distance
          hitNode[o] = keptNode[(hit.face.a / 3) | 0]
        }
      }
      if (pole) {
        const o = r * MASK_W
        blocked.fill(blocked[o], o + 1, o + MASK_W)
        clearance.fill(clearance[o], o + 1, o + MASK_W)
        hitNode.fill(hitNode[o], o + 1, o + MASK_W)
      }
    }
  }
  return { blocked, clearance, hitNode, rays, castMs: now() - t0 }
}

/**
 * 全部 181 行（主线程回退 / node 单测用的一次性入口）。结果为完整 360×181 掩模。
 * @param o { exclude?, includeNoObscuration?, ctx? }：排除名单口径同池子（resolveExclude）
 */
export function computeBodyMask(geom, mount, o = {}) {
  const t0 = now()
  const exclude = resolveExclude(geom, mount, o)
  const ctx = o.ctx || buildMaskBvh(geom, excludedNodeFlags(geom, exclude))
  const rows = Array.from({ length: MASK_H }, (_, j) => j)
  const r = castRows(ctx, maskOrigin(mount), rows)
  return {
    w: MASK_W, h: MASK_H, blocked: r.blocked, clearance: r.clearance, hitNode: r.hitNode,
    nodeNames: geom.nodeNames, exclude,
    stats: { rays: r.rays, tris: geom.tris, keptTris: ctx.keptTris, buildMs: o.ctx ? 0 : ctx.buildMs, castMs: r.castMs, ms: now() - t0 }
  }
}

// ───────────────────────────── Worker 薄壳 ─────────────────────────────
// 消息（入）：{ id, key, geom?:{positions,triNode,nodeParent,nodeNames}, exclude:string[], origin:[3], rows:number[] }
//   （全是纯数据：池子发之前现造，响应式代理过不了结构化克隆）
//   key = 几何签名 + 排除名单键；worker 按 key 缓存「压实后的 BVH」（LRU：至多 4 份、合计至多 250 万三角形——
//   140 万三角形的 IGOAL 一份树连顶点约 85 MB，按份数封顶会把内存吃穿）。没带 geom 又没缓存 → 回 needGeom，池子补发。
// 消息（出）：{ id, ok, rows, blocked, clearance, hitNode, rays, castMs, buildMs, keptTris } （三个结果数组整块 transfer）
const CACHE_MAX = 4, CACHE_TRIS = 2500000
const _cache = new Map()
function cacheGet(key) { const v = _cache.get(key); if (v) { _cache.delete(key); _cache.set(key, v) } return v }
function cachePut(key, v) {
  _cache.set(key, v)
  let tris = 0
  for (const e of _cache.values()) tris += e.keptTris
  // 最新那份永远留着（刚建的就是要用的）；旧的按先进先出让位
  while (_cache.size > 1 && (_cache.size > CACHE_MAX || tris > CACHE_TRIS)) {
    const k = _cache.keys().next().value
    tris -= _cache.get(k).keptTris
    _cache.delete(k)
  }
}

/**
 * @param o { ownsGeom?: boolean } Worker 薄壳传 true（msg.geom 是结构化克隆出来的私有副本，顶点数组可直接给树用）；
 *          node 单测直接拿调用方的几何调用时不传，树仍复制一份顶点。
 */
export function handleMessage(msg, o = {}) {
  const { id, key } = msg || {}
  let ctx = cacheGet(key), buildMs = 0
  if (!ctx) {
    if (!msg.geom) return [{ id, ok: false, needGeom: true }, []]
    ctx = buildMaskBvh(msg.geom, excludedNodeFlags(msg.geom, msg.exclude), { ownsPositions: !!o.ownsGeom })
    buildMs = ctx.buildMs
    cachePut(key, ctx)
  }
  const r = castRows(ctx, msg.origin, msg.rows)
  return [{ id, ok: true, rows: msg.rows, blocked: r.blocked, clearance: r.clearance, hitNode: r.hitNode, rays: r.rays, castMs: r.castMs, buildMs, keptTris: ctx.keptTris },
    [r.blocked.buffer, r.clearance.buffer, r.hitNode.buffer]]
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined' && typeof window === 'undefined') {
  self.onmessage = (ev) => {
    const d = ev.data || {}
    if (d.op === 'clear') { _cache.clear(); return }
    try {
      const [res, transfer] = handleMessage(d, { ownsGeom: true })
      self.postMessage(res, transfer)
    } catch (e) {
      self.postMessage({ id: d.id, ok: false, error: String((e && e.message) || e) })
    }
  }
}
