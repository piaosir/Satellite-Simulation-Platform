// IR（中间表示，DESIGN §3.1）⇄ three 场景树。
//
// irToThree：paramBus / occt / importers 产出的 IR → THREE.Group。材质按 material.key 走材质库（共享、带程序纹理），
//   没有 key 的按 IR 的颜色 / 金属度 / 粗糙度现造。节点原名同时放 name 与 userData.name —— 与 GLTFLoader 读进来的
//   模型同一口径（按节点名的逻辑一律取 userData.name），导出时 exporter 统一从 userData.name 恢复。
// threeToIR：反方向，把任意 Object3D（glb / OBJ / STL / FBX 读进来的）摊成 IR，给分析 Worker（质量特性、部件分割）
//   与导出前的统计用。坐标一律是 root 的局部系（= 模型系），节点矩阵相对父节点。
//
// 米制 UV：材质库的程序纹理按「UV = 米」平铺（电池片恒为 40 × 80 mm）。IR 的 uv 没有约定单位，所以对需要纹理的库材质
//   一律按主法向盒投影现算米制 UV（节点局部坐标，面板在自己节点里是轴对齐的，栅格就顺着板边）；
//   只有 mesh.uvMeters === true 时才信 IR 自带的 uv。
import * as THREE from 'three'
import { uniqueNodeNames } from '@core/models/ir.mjs'
import { materialFromIR, keyNeedsUv } from './materials.js'
import { originalName } from './loader.js'

function boxUv(pos, nrm) {
  const n = pos.length / 3, uv = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2]
    const ax = Math.abs(nrm[i * 3]), ay = Math.abs(nrm[i * 3 + 1]), az = Math.abs(nrm[i * 3 + 2])
    if (ax >= ay && ax >= az) { uv[i * 2] = z; uv[i * 2 + 1] = y }
    else if (ay >= az) { uv[i * 2] = x; uv[i * 2 + 1] = z }
    else { uv[i * 2] = x; uv[i * 2 + 1] = y }
  }
  return uv
}

/**
 * IR → THREE.Group（根节点名 'ir_root'，不属于 IR 节点）。
 * @param {object} ir DESIGN §3.1
 * @returns {THREE.Group}
 */
export function irToThree(ir) {
  const root = new THREE.Group()
  root.name = 'ir_root'
  root.userData.__sceneRoot = true   // 导出时摊平（见 exporter.js）：ir_root 不是模型节点
  const mats = (ir.materials || []).map((m) => materialFromIR(m))
  const geoms = new Map()   // 同一个 IR mesh 被多个节点引用时共享一份几何
  const geomOf = (mi) => {
    if (geoms.has(mi)) return geoms.get(mi)
    const m = ir.meshes[mi]
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3))
    if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1))
    if (m.normal && m.normal.length === m.position.length) g.setAttribute('normal', new THREE.BufferAttribute(m.normal, 3))
    else g.computeVertexNormals()
    const im = (ir.materials || [])[m.material]
    if (im && im.key && keyNeedsUv(im.key) && !m.uvMeters) {
      g.setAttribute('uv', new THREE.BufferAttribute(boxUv(m.position, g.attributes.normal.array), 2))
    } else if (m.uv && m.uv.length === (m.position.length / 3) * 2) {
      g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2))
    }
    g.computeBoundingBox(); g.computeBoundingSphere()
    geoms.set(mi, g)
    return g
  }
  const objs = (ir.nodes || []).map((n) => {
    let o
    if (n.mesh != null && ir.meshes[n.mesh]) {
      o = new THREE.Mesh(geomOf(n.mesh), mats[ir.meshes[n.mesh].material] || materialFromIR(null))
      o.castShadow = true; o.receiveShadow = true
    } else {
      o = new THREE.Group()
    }
    o.name = n.name
    if (n.extras && typeof n.extras === 'object') Object.assign(o.userData, JSON.parse(JSON.stringify(n.extras)))
    o.userData.name = n.name
    if (n.role) o.userData.role = n.role
    if (Array.isArray(n.matrix) && n.matrix.length === 16) {
      o.matrix.fromArray(n.matrix)
      o.matrix.decompose(o.position, o.quaternion, o.scale)
    }
    return o
  })
  ;(ir.nodes || []).forEach((n, i) => {
    const p = n.parent != null && n.parent >= 0 ? objs[n.parent] : root
    p.add(objs[i])
  })
  return root
}

// ---------------------------------------------------------------------------------------------
// three → IR
// ---------------------------------------------------------------------------------------------
function attrArray(attr, itemSize) {
  if (!attr) return null
  const n = attr.count, out = new Float32Array(n * itemSize)
  // 不直接拷 attr.array：可能是交错缓冲、KHR_mesh_quantization 的归一化整数，getX 系统一解
  for (let i = 0; i < n; i++) {
    out[i * itemSize] = attr.getX(i)
    if (itemSize > 1) out[i * itemSize + 1] = attr.getY(i)
    if (itemSize > 2) out[i * itemSize + 2] = attr.getZ(i)
  }
  return out
}
function linearColor(c) { return c ? [c.r, c.g, c.b] : [0.7, 0.7, 0.7] }

/**
 * three 树 → IR 节点布局（不拷数据）。threeToIR / irNodeTable / triTable / splitMultiMaterial / exporter 共用这一份遍历，
 * 保证「IR 节点名」「全局三角形号」在分析 Worker（segment.mjs 的 parts.nodes / triRanges）、预览高亮与导出件之间逐一对得上。
 *   · 先序遍历；原名 = userData.name（GLTFLoader / importers / irToThree 同一口径）。
 *   · 多材质网格（OBJ / FBX 常见）：IR 一个节点只挂一个网格 → 该对象自身作无网格节点，每个材质组各拆一个子节点，
 *     原名记作「对象名_材质名」（对象名为空时用 node_<对象的序号>，与唯一化的空名规则同形），紧跟在对象后面、排在对象的子节点之前。
 *   · 唯一化整表一次交给 ir.mjs 的 uniqueNodeNames（空名 → node_<序号>、重名第二个起 _2、_3…、后缀不抢别人的原名）——
 *     全链（主进程入库、paramBus、segment、这里、导出）只有这一套命名规则。
 * @returns {{name:string, raw:string, parent:number, obj:THREE.Object3D, isRoot:boolean, sub?:true, mesh?:{start:number,count:number,material:THREE.Material}}[]}
 *   mesh.start / count 以索引个数计（三角形 = count / 3）；raw = 唯一化之前的名字
 */
export function irLayout(root) {
  const out = [], raw = []
  const valid = (s) => typeof s === 'string' && s.trim() !== ''
  // 场景根（GLTFLoader 的 Scene、importers 以文件名命名的根、irToThree 的 ir_root）不是模型节点、导出时被摊平：
  // 它不参与唯一化争名 —— 否则 satellite.obj 里的对象 satellite 会被根抢了名字、变成 satellite_2
  const skipRoot = !!(root && (root.isScene || (root.userData && root.userData.__sceneRoot)))
  const off = skipRoot ? 1 : 0
  const walk = (obj, parent) => {
    const me = out.length
    const nm = originalName(obj)
    const e = { name: '', raw: '', parent, obj, isRoot: obj === root }
    out.push(e); raw.push(nm)
    if (obj.isMesh && obj.geometry && obj.geometry.attributes.position) {
      const g = obj.geometry
      const total = g.index ? g.index.count : g.attributes.position.count
      if (Array.isArray(obj.material)) {
        const base = valid(nm) ? nm : 'node_' + (me - off)
        const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }]
        for (const gr of groups) {
          const mat = obj.material[gr.materialIndex] || obj.material[0]
          const cnt = Math.max(0, Math.min(gr.count, total - gr.start))
          out.push({ name: '', raw: '', parent: me, obj, isRoot: false, sub: true, mesh: { start: gr.start, count: cnt - (cnt % 3), material: mat } })
          raw.push(base + '_' + ((mat && mat.name) || gr.materialIndex))
        }
      } else {
        e.mesh = { start: 0, count: total - (total % 3), material: obj.material }
      }
    }
    for (const c of obj.children) walk(c, me)
  }
  walk(root, -1)
  const u = uniqueNodeNames(raw.slice(off))
  out.forEach((e, i) => { e.raw = raw[i]; if (i >= off) e.name = u.names[i - off] })
  if (skipRoot) {
    // 根只要与节点不撞即可（IR 要求名字唯一非空）
    const used = new Set(u.names)
    const b = valid(raw[0]) ? raw[0] : 'root'
    let nm = b, k = 2
    while (used.has(nm)) nm = b + '_' + k++
    out[0].name = nm
  }
  return out
}

/**
 * IR 节点名 → 布局条目（部件 nodes / triRanges、关节节点落回 three 网格用）。
 * 带网格的条目：{mesh: 网格对象, start, count}（多材质子节点的区间只是该材质组那一段）；无网格节点：{obj}（整棵子树归它）。
 */
export function irNodeTable(root) {
  const m = new Map()
  for (const e of irLayout(root)) {
    if (e.mesh) m.set(e.name, { mesh: e.obj, obj: e.obj, start: e.mesh.start, count: e.mesh.count, sub: !!e.sub })
    else m.set(e.name, { mesh: null, obj: e.obj, start: 0, count: 0, sub: false })
  }
  return m
}

/**
 * 把多材质网格就地拆开，拆成 IR 的样子：对象换成同名、同变换的 Group（userData 原样，含原名），每个材质组一个单材质子网格
 * （名 = irLayout 给的子节点名，顶点属性与原几何共享、索引只取该组区间，几何打 userData._borrowed），排在原子节点之前。
 * 拆完再跑 irLayout：节点名、父子、全局三角形号与拆之前逐一相同 —— 导出件（exporter）与 LOD（analyze.simplifyObject）
 * 里的节点于是与 segment.mjs 按 IR 名给出的 parts.nodes / solarPanelGroups.nodes 对得上。
 * @param {THREE.Object3D} root
 * @returns {THREE.Object3D} 新根（只有根自己就是多材质网格时才换）
 */
export function splitMultiMaterial(root) {
  const lay = irLayout(root)
  let newRoot = root
  for (let i = 0; i < lay.length; i++) {
    const e = lay[i]
    const m = e.obj
    if (e.sub || !m.isMesh || !Array.isArray(m.material)) continue
    const g = new THREE.Group()
    g.name = m.name
    g.userData = { ...m.userData, name: originalName(m) }
    g.position.copy(m.position); g.quaternion.copy(m.quaternion); g.scale.copy(m.scale)
    g.matrix.copy(m.matrix); g.matrixAutoUpdate = m.matrixAutoUpdate; g.visible = m.visible
    const src = m.geometry, ia = src.index ? src.index.array : null
    const Idx = src.attributes.position.count <= 65535 ? Uint16Array : Uint32Array
    for (let j = i + 1; j < lay.length && lay[j].sub && lay[j].obj === m; j++) {
      const s = lay[j]
      const sub = new THREE.BufferGeometry()
      for (const k of Object.keys(src.attributes)) sub.setAttribute(k, src.attributes[k])
      const idx = new Idx(s.mesh.count)
      for (let k = 0; k < idx.length; k++) idx[k] = ia ? ia[s.mesh.start + k] : s.mesh.start + k
      sub.setIndex(new THREE.BufferAttribute(idx, 1))
      // 原几何的包围体是子集的外包：视锥剔除照样对，省一遍遍历
      if (src.boundingBox) sub.boundingBox = src.boundingBox.clone()
      if (src.boundingSphere) sub.boundingSphere = src.boundingSphere.clone()
      sub.userData._borrowed = true
      const mesh = new THREE.Mesh(sub, s.mesh.material)
      mesh.name = s.name
      mesh.userData = { name: s.name }
      mesh.castShadow = m.castShadow; mesh.receiveShadow = m.receiveShadow; mesh.renderOrder = m.renderOrder; mesh.visible = m.visible
      g.add(mesh)
    }
    for (const c of m.children.slice()) g.add(c)
    if (m === root) newRoot = g
    else if (m.parent) { const p = m.parent, at = p.children.indexOf(m); p.children[at] = g; g.parent = p; m.parent = null }
  }
  return newRoot
}

/**
 * 释放一个借用属性的几何（splitMultiMaterial / 部件高亮造的子集几何）：先摘掉共享属性再 dispose，
 * 只放它自己的索引缓冲 —— 否则各 renderer 会把原几何的顶点缓冲一起删掉、下一帧重传。
 */
export function disposeBorrowed(g) {
  if (!g) return
  for (const k of Object.keys(g.attributes)) g.deleteAttribute(k)
  g.dispose()
}

/**
 * 任意 Object3D → IR（root 局部系 = 模型系）。
 * @param {THREE.Object3D} root
 * @param {{uv?:boolean, normal?:boolean}} [o] 默认都带；给分析 Worker 时可关掉省传输
 * @returns {object} IR（纯数据，可直接 postMessage；数组可 transfer，见 irTransferables）
 */
export function threeToIR(root, o = {}) {
  const wantUv = o.uv !== false, wantN = o.normal !== false
  const ir = { units: 'm', unitHint: 'unknown', sourceFormat: 'glb', materials: [], meshes: [], nodes: [] }
  const matIdx = new Map()
  const addMat = (m) => {
    if (matIdx.has(m)) return matIdx.get(m)
    const e = {
      name: m.name || 'material_' + ir.materials.length,
      color: linearColor(m.color),
      metalness: m.metalness != null ? m.metalness : 0,
      roughness: m.roughness != null ? m.roughness : 1,
      doubleSided: m.side === THREE.DoubleSide
    }
    if (m.userData && m.userData.materialKey) e.key = m.userData.materialKey
    if (m.emissive && (m.emissive.r || m.emissive.g || m.emissive.b)) e.emissive = linearColor(m.emissive)
    if (m.transparent && m.opacity < 1) e.opacity = m.opacity
    ir.materials.push(e)
    matIdx.set(m, ir.materials.length - 1)
    return ir.materials.length - 1
  }
  // 同一几何的属性只摊一次（多材质拆出来的几个子节点共享同一份顶点）
  const attrCache = new Map()
  const attrsOf = (g) => {
    let a = attrCache.get(g)
    if (!a) {
      a = { position: attrArray(g.attributes.position, 3) }
      if (wantN && g.attributes.normal) a.normal = attrArray(g.attributes.normal, 3)
      if (wantUv && g.attributes.uv) a.uv = attrArray(g.attributes.uv, 2)
      attrCache.set(g, a)
    }
    return a
  }
  for (const e of irLayout(root)) {
    const node = { name: e.name, parent: e.parent }
    if (!e.isRoot && !e.sub) node.matrix = e.obj.matrix.toArray()
    if (!e.sub && e.obj.userData && e.obj.userData.role) node.role = e.obj.userData.role
    if (e.mesh) {
      const g = e.obj.geometry
      const index = new Uint32Array(e.mesh.count)
      if (g.index) { const a = g.index.array; for (let i = 0; i < e.mesh.count; i++) index[i] = a[e.mesh.start + i] }
      else for (let i = 0; i < e.mesh.count; i++) index[i] = e.mesh.start + i
      const at = attrsOf(g)
      const m = { name: e.obj.name || '', position: at.position, index, material: addMat(e.mesh.material) }
      if (at.normal) m.normal = at.normal
      if (at.uv) m.uv = at.uv
      ir.meshes.push(m)
      node.mesh = ir.meshes.length - 1
    }
    ir.nodes.push(node)
  }
  return ir
}

/**
 * 全局三角形编号表（与 threeToIR / segment.mjs 的实例顺序一致：irLayout 里带网格的节点依次排）。
 * parts.triRange / parts.tris 用的「第几个三角形」就是按这张表数的，预览高亮与分析 Worker 对得上。
 * @returns {{mesh:THREE.Mesh, name:string, start:number, count:number, global:number}[]}  start = 索引数组起点（索引个数计），count = 三角形数
 */
export function triTable(root) {
  const out = []
  let g = 0
  for (const e of irLayout(root)) {
    if (!e.mesh) continue
    const cnt = e.mesh.count / 3
    out.push({ mesh: e.obj, name: e.name, start: e.mesh.start, count: cnt, global: g })
    g += cnt
  }
  return out
}

/** IR 的可传输数组（postMessage transfer 列表用；调用方传完就别再用这些数组） */
export function irTransferables(ir) {
  const t = new Set()   // 同一数组可能被两个网格引用：transfer 列表里重复会直接抛 DataCloneError
  for (const m of ir.meshes) for (const k of ['position', 'normal', 'uv', 'index']) if (m[k] && m[k].buffer) t.add(m[k].buffer)
  return [...t]
}
