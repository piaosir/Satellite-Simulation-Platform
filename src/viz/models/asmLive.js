// 装配编辑器的 live 树件（P3，CONTRACT §5.3）：组件几何缓存（按件 BVH、LRU）、条目子树、淡染 / 描边 / 占位层、ghost 池。
//
// ★ 几何缓存：键 = asmSnap.geomKey（type | 规范化参数 | 材质覆盖），值 = irToThree(buildComponent(...).ir) 的模板 + 插座 / 面 /
//   局部包围盒 / 关节 / 三角形数 / 质量特性（13 元，拖入件的质量读数直接用，不再生成一份单件文档）。引用归零的条目进 32 条 LRU
//   （撤销 / 重做秒回），挤出去才 dispose 几何与 boundsTree / 边线几何。库材质全窗口共享，这里绝不 dispose 库材质；
//   irToThree 现造的非库材质（没有库键时）记在条目上一并放掉。
// ★ 重活不上交互路径（rv2）：条目一建好就把每个几何的两档折角边线（选中 / 悬停 25°、ghost 40°）与 BVH 排进几何 Worker
//   （asmGeomWorker.js）——悬停、选中、落下、ghost 露面都只取现成的；还没算好的这一次不画边线，算好了回调 onReady 再补。
//   排队按空闲时段投递（拷一份位置 / 索引过去，原数组还在画）；拖入的 ghost 件插队（urgent）立刻投。视口的 ensureBvh 见到已挂好的
//   boundsTree 就不再同步建；Worker 起不来时边线退回主线程空闲时段里建（不在交互那一帧建）。
// ★ 材质覆盖（comp.material）在 IR 层换：全部网格改用该库键 —— irToThree 按库键决定要不要现算米制盒投影 UV（电池片 / MLI 纹理），
//   在 three 层换材质会丢这一步。
// ★ 条目子树：模板的几何节点逐个 clone（共享几何 / 材质 / BVH），节点改名 `${前缀}_${短名}`（与 buildAssembly 的 IR 节点名一致，
//   初值姿态预览按名摆关节）；matrixAutoUpdate 关掉（矩阵是现成的，逐帧不必再从 TRS 合成）。
// ★ 渲染矩阵：派生件直接复用主件几何，矩阵 = pose.m 把镜面那一列取反（= S·M，det −1；three 按行列式自动翻正面）。
// ★ 淡染 / 描边 / 占位 / ghost 都在 fxRoot（vp.scene 里、矩阵 = 显示矩阵、第 1 层）：不进 live 根，
//   于是视口的网格表 / 包围盒 / 三角形数 / 接触阴影 / AO 都看不到它们；逐帧只拷 16 个数跟着条目走（零分配）。
import * as THREE from 'three'
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh'
import { buildComponent, combineMass, normalizeAssembly } from '@core/models/assembly.mjs'
import { getComponent, fillParams } from '@core/models/components/index.mjs'
import { MATERIALS } from '@core/models/paramBus.mjs'
import { geomKey, planeAxis, massPack } from '@core/models/asmSnap.mjs'
import { irToThree } from './irToThree.js'

export const L_FX = 1         // 场景内叠加图层（与 viewport 的 L_SCENE_OV 同号：不进阴影 / AO / 接触阴影 / 拾取）
const LRU_CAP = 32
// LRU 另按字节限额：几何 / 边线 / BVH 的类型数组都算进页面 JS 堆（船体一件就是几 MB）。32 条都是大件时能常驻 30 MB 上下，
// 撤销 / 重做秒回只需要小件常驻；超额从最旧的放。按属性 / 索引 / 边线 / BVH 的类型数组字节估；实测页面堆里还要再乘 ~1.7（three 对象、
// 顶点法向 / UV 的副本等），4 MB 估算 ≈ 常驻 7 MB（验证台 fx2perf lruCount：满 32 条的旧口径常驻 26 MB）
const LRU_BYTES = 4 * 1048576
export const EDGE_DEG = 25          // 选中 / 悬停描边：折角 ≥ 25° 的边
export const GHOST_EDGE_DEG = 40    // ghost：只取大折角（剪影量级），太阳翼轭管那种细管不再每段出一圈边
const EDGE_DEGS = Object.freeze([EDGE_DEG, GHOST_EDGE_DEG])
const POST_BUDGET_MS = 4            // 空闲时段里投递 Worker 作业的预算（拷位置 / 索引）

/** pose.m（列主序，本体系）→ three 矩阵元素；ax ≥ 0 时把该列取反（镜像派生件的渲染等式）。零分配。 */
export function writeRenderMatrix(el, m, ax) {
  for (let i = 0; i < 16; i++) el[i] = m[i]
  if (ax >= 0) { el[4 * ax] = -el[4 * ax]; el[4 * ax + 1] = -el[4 * ax + 1]; el[4 * ax + 2] = -el[4 * ax + 2] }
}

function matEntry(key) {
  const d = MATERIALS[key]
  const m = { name: key, key, color: d.color.slice(), metalness: d.metalness, roughness: d.roughness }
  if (d.doubleSided) m.doubleSided = true
  if (Number.isFinite(d.opacity)) m.opacity = d.opacity
  return m
}

const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 200 }) : setTimeout(() => fn({ timeRemaining: () => 8, didTimeout: true }), 16))
const unidle = (h) => { if (typeof cancelIdleCallback === 'function') cancelIdleCallback(h); else clearTimeout(h) }

// ───────────────────────────── 几何缓存 ─────────────────────────────

/**
 * @param {{onReady?:(item:object)=>void, onEvict?:(item:object)=>void}} [o] onReady：该件的边线 / BVH 都到齐（编辑器据此补画描边、补跑穿插）；
 *   onEvict：条目被挤出 LRU、资源释放前（ghost 池据此丢掉它的材质副本）
 * @returns {{get(comp):object, peek(key):object|null, prep(item, urgent?):void, sweep(active:Set<object>):void,
 *   edgesIf(item, geometry, deg?):THREE.BufferGeometry|null, linesOf(item, geometry):LineSegmentsGeometry|null, bvhReady(item):boolean,
 *   mass13(item, density, domain):Float64Array, dispose():void, stats():object, hasArtsField:boolean}}
 */
export function createGeomCache(o = {}) {
  const items = new Map()   // key → item（在用的与 LRU 里的都在这里）
  const lru = new Map()     // key → item（引用归零，按放入顺序）
  const onReady = typeof o.onReady === 'function' ? o.onReady : null
  const onEvict = typeof o.onEvict === 'function' ? o.onEvict : null
  // core §2.4（buildComponent 返回 articulations）落地与否：建缓存时就探明 —— 空文档时「初值」开关也得与界面一致（否则界面开了、编辑器没开）
  let hasArtsField = (() => { try { return 'articulations' in buildComponent('prim.box', {}) } catch { return false } })()

  // ── 几何 Worker（边线两档 + BVH）──
  let worker = null, wdead = false, seq = 0, idleH = 0
  const queue = []            // {it, g}：待投递
  const inflight = new Map()  // id → {it, g}
  const fallback = []         // Worker 起不来：主线程空闲时段里建边线的 {it, g}
  const nStat = { posted: 0, done: 0, failed: 0, mainEdges: 0 }
  function ensureWorker() {
    if (worker || wdead) return worker
    try { worker = new Worker(new URL('./asmGeomWorker.js', import.meta.url), { type: 'module' }) } catch (e) { console.warn('[asm] 几何 Worker 起不来，边线改在主线程空闲时段建：' + ((e && e.message) || e)); wdead = true; return null }
    worker.onmessage = onResult
    worker.onerror = (ev) => {
      console.warn('[asm] 几何 Worker 出错，边线改在主线程空闲时段建：' + ((ev && ev.message) || ''))
      wdead = true
      try { worker.terminate() } catch { /* 无 */ }
      worker = null
      for (const j of inflight.values()) fallback.push(j)
      inflight.clear()
      for (const j of queue) fallback.push(j)
      queue.length = 0
      pump()
    }
    return worker
  }
  const ekey = (g, deg) => (deg === EDGE_DEG ? g : g.uuid + '|' + deg)
  function jobDone(it) {
    if (it.disposed) return
    if (--it.prepLeft > 0) return
    it.edgesReady = true
    if (onReady) { try { onReady(it) } catch (e) { console.error('[asm] onReady', e) } }
  }
  function onResult(ev) {
    const d = ev.data || {}
    const j = inflight.get(d.id)
    if (!j) return
    inflight.delete(d.id)
    const { it, g } = j
    if (it.disposed) return
    if (!d.ok) { nStat.failed++; fallback.push(j); pump(); return }
    nStat.done++
    for (const deg of EDGE_DEGS) {
      const a = d.edges && d.edges[deg]
      if (!a) continue
      const eg = new THREE.BufferGeometry()
      eg.setAttribute('position', new THREE.BufferAttribute(a, 3))
      // 包围盒 / 球 Worker 已算好：第一次画这条描边时 three 不再逐顶点现算（视锥剔除要球）
      const b = d.bounds && d.bounds[deg]
      if (b) { eg.boundingBox = new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])); eg.boundingSphere = new THREE.Sphere(new THREE.Vector3(b[6], b[7], b[8]), b[9]) }
      it.edges.set(ekey(g, deg), eg)
    }
    if (d.bvh && !g.boundsTree) {
      try { g.boundsTree = MeshBVH.deserialize({ version: d.bvh.version, roots: d.bvh.roots, indirectBuffer: d.bvh.indirectBuffer, index: null }, g, { setIndex: false, indirect: true }) } catch (e) { console.warn('[asm] BVH 反序列化失败：' + ((e && e.message) || e)) }
    }
    jobDone(it)
  }
  function post(j) {
    const w = ensureWorker()
    if (!w) { fallback.push(j); return }
    const g = j.g
    const pa = g.attributes.position
    let position
    if (!pa.isInterleavedBufferAttribute && !pa.normalized && pa.array instanceof Float32Array && pa.itemSize === 3) position = pa.array.slice(0, pa.count * 3)
    else { position = new Float32Array(pa.count * 3); for (let i = 0; i < pa.count; i++) { position[i * 3] = pa.getX(i); position[i * 3 + 1] = pa.getY(i); position[i * 3 + 2] = pa.getZ(i) } }
    const index = g.index ? g.index.array.slice() : null
    const id = ++seq
    inflight.set(id, j)
    nStat.posted++
    try {
      w.postMessage({ id, position, index, groups: g.groups.map((x) => ({ start: x.start, count: x.count, materialIndex: x.materialIndex })), drawRange: { start: g.drawRange.start, count: g.drawRange.count }, edges: EDGE_DEGS, bvh: !g.boundsTree },
        index ? [position.buffer, index.buffer] : [position.buffer])
    } catch (e) { inflight.delete(id); fallback.push(j) }
  }
  function mainEdges(j) {
    const { it, g } = j
    if (it.disposed) return
    for (const deg of EDGE_DEGS) { const k = ekey(g, deg); if (!it.edges.has(k)) { const e = new THREE.EdgesGeometry(g, deg); e.computeBoundingBox(); e.computeBoundingSphere(); it.edges.set(k, e) } }
    nStat.mainEdges++
    jobDone(it)
  }
  /** 空闲时段里投递（或 Worker 不可用时主线程建边线）：每段按预算，没做完排下一段。 */
  function pump() {
    if (idleH || (!queue.length && !fallback.length)) return
    idleH = idle((dl) => {
      idleH = 0
      const t0 = performance.now()
      const left = () => (dl && typeof dl.timeRemaining === 'function' && !dl.didTimeout ? Math.min(dl.timeRemaining(), POST_BUDGET_MS) : POST_BUDGET_MS) - (performance.now() - t0)
      while (queue.length && left() > 0) { const j = queue.shift(); if (!j.it.disposed) post(j) }
      // 主线程建边线一个几何可能要十几毫秒：一段只建一个
      if (fallback.length && left() > 0) { const j = fallback.shift(); if (!j.it.disposed) mainEdges(j) }
      pump()
    })
  }

  function build(comp) {
    const def = getComponent(comp.type)
    if (!def) throw new Error(`未知组件「${comp.type}」`)
    const params = fillParams(def, comp.params)
    const bc = buildComponent(comp.type, params)
    if ('articulations' in bc) hasArtsField = true
    let ir = bc.ir
    if (comp.material && MATERIALS[comp.material]) ir = { ...ir, materials: [matEntry(comp.material)], meshes: ir.meshes.map((m) => ({ ...m, material: 0 })) }
    const root = irToThree(ir)
    const tpl = root.children[0]   // IR 根节点 'component'（单位阵）；几何节点是它的直接子节点
    root.remove(tpl)
    const geoms = new Set(), ownMats = new Set(), meshes = []
    let tris = 0
    tpl.updateMatrixWorld(true)
    const inv = new THREE.Matrix4().copy(tpl.matrixWorld).invert()
    tpl.traverse((o) => {
      if (!o.isMesh || !o.geometry) return
      const g = o.geometry
      if (!geoms.has(g)) {
        geoms.add(g)
        tris += Math.floor((g.index ? g.index.count : g.attributes.position.count) / 3)
      }
      const ms = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of ms) if (m && !(m.userData && m.userData._shared)) ownMats.add(m)
      meshes.push({ geometry: g, rel: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld), name: o.userData.name || o.name, material: o.material })
    })
    const bb = bc.bbox
    const box6 = new Float64Array([bb.min[0], bb.min[1], bb.min[2], bb.max[0], bb.max[1], bb.max[2]])
    const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2])
    return {
      key: geomKey(comp), type: comp.type, params: bc.params, material: comp.material || null,
      template: tpl, sockets: bc.sockets, faces: bc.faces, symPlanes: bc.symmetricPlanes,
      box6, size: Number.isFinite(diag) && diag > 0 ? diag : 0.1,
      arts: Array.isArray(bc.articulations) ? bc.articulations : [], massKg: bc.massKg,
      meshes, geoms, ownMats, edges: new Map(), lines: new Map(), tris, m13: null, m13Dens: undefined,
      prepped: false, prepLeft: 0, edgesReady: false, disposed: false, ghostWarm: null, ghostWarmed: false
    }
  }
  /** 条目占用的类型数组字节数（几何属性 + 索引 + 两档边线 + BVH）。进 LRU 时现量（BVH / 边线可能是后到的）。 */
  function itemBytes(it) {
    let n = 0
    for (const g of it.geoms) {
      for (const k in g.attributes) { const a = g.attributes[k]; if (a && a.array) n += a.array.byteLength }
      if (g.index) n += g.index.array.byteLength
      const t = g.boundsTree
      if (t) { if (Array.isArray(t._roots)) for (const r of t._roots) n += r.byteLength || 0; if (t._indirectBuffer) n += t._indirectBuffer.byteLength || 0 }
    }
    for (const e of it.edges.values()) { const a = e.attributes.position; if (a && a.array) n += a.array.byteLength }
    return n
  }
  function disposeItem(it) {
    it.disposed = true
    if (onEvict) { try { onEvict(it) } catch { /* 无 */ } }
    for (const g of it.geoms) { g.boundsTree = null; g.dispose() }
    for (const e of it.edges.values()) e.dispose()
    for (const l of it.lines.values()) l.dispose()
    for (const m of it.ownMats) m.dispose()
    it.geoms.clear(); it.edges.clear(); it.lines.clear(); it.ownMats.clear()
  }
  /** 该件的边线两档 + BVH 排进 Worker（每件只排一次）；urgent = 插队立刻投（拖入的 ghost 件）。 */
  function prep(it, urgent) {
    if (!it || it.disposed) return
    if (!it.prepped) {
      it.prepped = true
      it.prepLeft = it.geoms.size
      if (!it.prepLeft) { it.edgesReady = true; return }
      const jobs = [...it.geoms].map((g) => ({ it, g }))
      if (urgent) { for (const j of jobs) post(j); pump(); return }
      for (const j of jobs) queue.push(j)
      pump()
      return
    }
    if (urgent && !it.edgesReady) {
      // 已排队、还没投：挪到前面立刻投
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].it === it) { const j = queue.splice(i, 1)[0]; post(j) }
    }
  }
  const densKey = (d) => (d && typeof d === 'object' ? JSON.stringify(d) : '')
  return {
    get hasArtsField() { return hasArtsField },
    /** 取（没有就建，并把边线 / BVH 排进 Worker）组件几何；参数非法抛 SPEC_INVALID。 */
    get(comp) {
      const key = geomKey(comp)
      let it = items.get(key)
      if (it) { lru.delete(key); return it }
      it = build(comp)
      items.set(key, it)
      prep(it, false)
      return it
    },
    prep,
    peek(key) { return items.get(key) || null },
    /** 这次同步之后在用的条目集合：其余的进 LRU，LRU 超额的释放。cap 缺省 LRU_CAP（验证台 / 离开装配页可传更小的值收紧）。 */
    sweep(active, cap = LRU_CAP, bytesCap = LRU_BYTES) {
      for (const [k, it] of items) {
        if (active.has(it)) { lru.delete(k); continue }
        if (!lru.has(k)) { it.bytes = itemBytes(it); lru.set(k, it) }
      }
      let bytes = 0
      for (const it of lru.values()) bytes += it.bytes || 0
      while (lru.size > cap || (lru.size && bytes > bytesCap)) {
        const [k, it] = lru.entries().next().value
        lru.delete(k); items.delete(k)
        bytes -= it.bytes || 0
        disposeItem(it)
      }
    },
    /** 条目某几何的边线（Worker 算好的；没到返回 null——调用方这一次不画边线，onReady 后再补）。deg 缺省选中描边口径。 */
    edgesIf(it, g, deg = EDGE_DEG) { return it.edges.get(ekey(g, deg)) || null },
    /** 选中描边的粗线几何（LineSegments2 用；由 25° 边线现转、随条目释放）；边线没到返回 null。 */
    linesOf(it, g) {
      let l = it.lines.get(g)
      if (l) return l
      const e = it.edges.get(ekey(g, EDGE_DEG))
      if (!e) return null
      // 与 LineSegmentsGeometry.setPositions 同一构造（端点数组直接当实例缓冲，不拷贝），包围盒 / 球沿用边线几何那份（不再逐段现算）
      const arr = e.attributes.position.array
      l = new LineSegmentsGeometry()
      const ib = new THREE.InstancedInterleavedBuffer(arr, 6, 1)
      l.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(ib, 3, 0))
      l.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(ib, 3, 3))
      l.instanceCount = arr.length / 6
      if (e.boundingBox && e.boundingSphere) { l.boundingBox = e.boundingBox.clone(); l.boundingSphere = e.boundingSphere.clone() } else { l.computeBoundingBox(); l.computeBoundingSphere() }
      it.lines.set(g, l)
      return l
    },
    /** 该件的几何都挂上 BVH 了（穿插检测要）。 */
    bvhReady(it) { for (const g of it.geoms) if (!g.boundsTree) return false; return true },
    /**
     * 该件（根件 = 局部系）的质量特性 13 元（asmSnap.massPack：质量 / 质心 / 对质心惯量），按文档密度表记在条目上。
     * 拖入的质量读数用它，不再每次拼一份单件文档从头生成（生成走 assembly 的模块级缓存，命中即取）。
     */
    mass13(it, density, domain = 'spacecraft') {
      const dk = densKey(density)
      if (it.m13 && it.m13Dens === dk) return it.m13
      const out = new Float64Array(13)
      try { massPack(combineMass(normalizeAssembly({ kind: 'assembly', domain, comps: [{ id: 'g', type: it.type, params: it.params, parent: null, material: it.material }], density })), out) } catch { out.fill(0) }
      it.m13 = out; it.m13Dens = dk
      return out
    },
    dispose() {
      if (idleH) { unidle(idleH); idleH = 0 }
      queue.length = 0; fallback.length = 0; inflight.clear()
      if (worker) { try { worker.terminate() } catch { /* 无 */ } worker = null }
      for (const it of items.values()) disposeItem(it)
      items.clear(); lru.clear()
    },
    stats() { let b = 0; for (const it of lru.values()) b += it.bytes || 0; return { items: items.size, lru: lru.size, lruBytes: b, queued: queue.length, inflight: inflight.size, ...nStat } }
  }
}

// ───────────────────────────── 条目子树 ─────────────────────────────

/**
 * 按模板给条目组填子树（先清空旧的）：几何节点 clone（共享几何 / 材质 / BVH）、改名 `${prefix}_${短名}`、关自动矩阵、挂加速射线。
 * @returns {THREE.Mesh[]} 条目里的网格
 */
export function fillEntry(group, item, prefix) {
  for (const c of group.children.slice()) group.remove(c)
  const meshes = []
  for (const ch of item.template.children) {
    const c = ch.clone(true)
    c.traverse((o) => {
      const short = (o.userData && typeof o.userData.name === 'string' && o.userData.name) || o.name
      o.name = `${prefix}_${short}`
      o.userData.name = o.name
      o.matrixAutoUpdate = false
      if (o.isMesh) { o.raycast = acceleratedRaycast; meshes.push(o) }
    })
    group.add(c)
  }
  group.matrixWorldNeedsUpdate = true
  return meshes
}

/** 条目关节（局部短名）按前缀改名（初值姿态预览用）。 */
export const prefixedArts = (arts, prefix) => arts.map((a) => ({ ...a, name: `${prefix}_${a.name}`, nodes: a.nodes.map((n) => `${prefix}_${n}`) }))

// ───────────────────────────── 配色 ─────────────────────────────

/**
 * 编辑器配色（深色 = 深色主题或太阳档黑底）。
 *   accent：选中描边（2 px 实色）/ 悬停（45 %）/ 派生件（50 %）/ 拾起中的子树 —— 视口里最醒目的一层就是选中；
 *   ghost：拖入 ghost 的边线（中性墨色，无效位才换 danger）。
 */
export function palette(dark) {
  return dark
    ? { accent: 0x5aa2ff, accentEdge: 0x8cc0ff, danger: 0xff5c63, amber: 0xffb224, candidate: 0x49d6c4, halo: 0x0c0d0f, ink: 0xe8e8e6, selEdge: 0x5aa2ff, ghostEdge: 0xd8dadd }
    : { accent: 0x2f6fd6, accentEdge: 0x1f58b8, danger: 0xd33a40, amber: 0xc27a00, candidate: 0x0f9d8a, halo: 0xffffff, ink: 0x1a1a1a, selEdge: 0x2f6fd6, ghostEdge: 0x3a3f46 }
}

// ───────────────────────────── 淡染 / 描边 / 占位层 ─────────────────────────────

export const FX = Object.freeze({ HOVER: 1, SEL: 2, SEL_WEAK: 4, CLASH: 8, INVALID: 16, MOVING: 32 })
/** 描边线宽（CSS 像素）：选中 2、拾起中 1.5；悬停 / 派生件用 1 px 细线。选中件另有 2.5 px 剪影外轮廓。 */
const SEL_PX = 2, MOVE_PX = 1.5, SIL_PX = 2.5

// 选中件的剪影外轮廓（屏幕等宽）：只画背面、顶点沿投影后的法向在裁剪空间外推 SIL_PX 像素——件本身的正面把里面盖住，
// 只剩轮廓外缘一圈。折角边线（25°）画不出光滑曲面的剪影（机身、天线罩、碟面外缘），白件落在深色底上就只剩几根线；
// 这一圈把整件的外形勾出来。深度照常比（被别的件挡住的部分由下面那趟「被挡部分」细线补）；深度往后推一点，避免与单面薄板自身打架。
const silVS = `
uniform vec2 uRes;
uniform float uPx;
void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec3 vn = normalize(normalMatrix * normal);
  vec2 d = (projectionMatrix * vec4(vn, 0.0)).xy;
  float l = length(d);
  if (l > 1e-6) clip.xy += (d / l) * (uPx * 2.0 / uRes) * clip.w;
  gl_Position = clip;
}`
const silFS = `
uniform vec3 uColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(uColor, uOpacity);
  #include <colorspace_fragment>
}`
const _vp4 = new THREE.Vector4()

/**
 * 按条目的叠加标记（FX 位）在 fxRoot 里建描边 / 淡染组：update(list) 只重建标记变了（或边线刚到）的条目；follow() 每帧拷矩阵（零分配）。
 * list 元素须有 {id, fx, item, m:Float64Array(16) 渲染矩阵, rels?:THREE.Matrix4[]（网格相对条目的当前矩阵，含初值姿态）}。
 * ★ 层级：选中 > 拾起 > 悬停（Onshape / SketchUp 口径：选中是视口里最显眼的一层）——
 *   选中 = accent 实色 2 px 粗线（LineSegments2，屏幕像素定宽）+ 2.5 px 剪影外轮廓（光滑曲面也勾得出外形）+ 被挡住的那部分再画一趟
 *   （深度 GREATER、30 %）：被别的件挡住也看得出轮廓；
 *   拾起中的子树 = accent 1.5 px；派生件 = accent 50 % 细线；悬停 = accent 45 % 细线。
 * ★ 不做面淡染（accent 在线性空间里 10 % 混色感知上等于 25–35 %，选中件会被染成灰紫）；只有穿插 / 非法件保留 danger 淡染（报错要一眼看见）。
 * ★ 边线由几何 Worker 预先算好（cache.edgesIf / linesOf）；还没到的件这一次不画边线，到了编辑器再 update 一次。
 */
export function createFxLayer(fxRoot, cache) {
  const grp = new THREE.Group(); grp.name = 'asm_fx'; grp.matrixAutoUpdate = false
  fxRoot.add(grp)
  // forceSinglePass：透明 + 双面缺省分两趟画，每趟之间 three 把 material.needsUpdate 置真、重算一遍程序缓存键（整串拼接，
  // 一件高亮每帧十几 KB 的垃圾）；淡染不需要背面先画的排序效果，单趟画
  const mk = (o) => new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, toneMapped: false, ...o })
  const line = (opacity, o) => new THREE.LineBasicMaterial({ transparent: true, opacity, depthWrite: false, toneMapped: false, ...o })
  const fat = (px, opacity) => new LineMaterial({ linewidth: px, worldUnits: false, transparent: true, opacity, depthWrite: false, toneMapped: false })
  const sil = new THREE.ShaderMaterial({
    vertexShader: silVS, fragmentShader: silFS, side: THREE.BackSide, transparent: true, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4,
    uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uPx: { value: SIL_PX }, uColor: { value: new THREE.Color() }, uOpacity: { value: 1 } }
  })
  // 分辨率每帧由渲染时的视口定（与 LineSegments2 同一口径：CSS 像素）
  const silBefore = (renderer) => { renderer.getViewport(_vp4); sil.uniforms.uRes.value.set(_vp4.z, _vp4.w) }
  const M = {
    danger: mk({ opacity: 0.3 }),
    sel: fat(SEL_PX, 1), move: fat(MOVE_PX, 0.9), sil,
    selHidden: line(0.3, { depthFunc: THREE.GreaterDepth }),
    weak: line(0.5), hover: line(0.45),
    ph: line(0.9)
  }
  const phGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1))
  const byId = new Map()   // id → {g, mask, item, ready, src}
  function setPalette(p) {
    M.danger.color.setHex(p.danger)
    M.sel.color.setHex(p.accent); M.move.color.setHex(p.accent); M.selHidden.color.setHex(p.accent); M.sil.uniforms.uColor.value.setHex(p.accent)
    M.weak.color.setHex(p.accent); M.hover.color.setHex(p.accent)
    M.ph.color.setHex(p.danger)
  }
  function add(g, o, rel, order) { o.matrixAutoUpdate = false; o.matrix.copy(rel); o.renderOrder = order; o.layers.set(L_FX); g.add(o) }
  function build(e) {
    const g = new THREE.Group(); g.matrixAutoUpdate = false; g.name = 'fx:' + e.id
    const mask = e.fx
    const tint = mask & (FX.CLASH | FX.INVALID) ? M.danger : null
    const sel = !!(mask & FX.SEL), mov = !sel && !!(mask & FX.MOVING)
    const thin = sel || mov ? null : mask & FX.SEL_WEAK ? M.weak : mask & FX.HOVER ? M.hover : null
    if (e.item) {
      const im = e.item.meshes
      for (let k = 0; k < im.length; k++) {
        const mm = im[k], rel = e.rels && e.rels[k] ? e.rels[k] : mm.rel
        if (tint) add(g, new THREE.Mesh(mm.geometry, tint), rel, 6)
        if (sel && mm.geometry.attributes.normal) { const s = new THREE.Mesh(mm.geometry, M.sil); s.onBeforeRender = silBefore; add(g, s, rel, 7) }
        if (sel || mov) {
          const lg = cache.linesOf(e.item, mm.geometry)
          if (lg) add(g, new LineSegments2(lg, sel ? M.sel : M.move), rel, 8)
          if (sel) { const eg = cache.edgesIf(e.item, mm.geometry); if (eg) add(g, new THREE.LineSegments(eg, M.selHidden), rel, 7) }
        } else if (thin) {
          const eg = cache.edgesIf(e.item, mm.geometry)
          if (eg) add(g, new THREE.LineSegments(eg, thin), rel, 7)
        }
      }
    } else if (mask & FX.INVALID) {
      // 没有合法几何可画的件：0.3 m 包围盒线框占位
      const l = new THREE.LineSegments(phGeo, M.ph); l.matrixAutoUpdate = false; l.matrix.makeScale(0.3, 0.3, 0.3); l.layers.set(L_FX); g.add(l)
    }
    g.visible = e.visible !== false
    for (let i = 0; i < 16; i++) g.matrix.elements[i] = e.m[i]
    g.matrixWorldNeedsUpdate = true
    return g
  }
  /** 预热用：每种叠加材质各挂一个占位物体的组（交给视口 precompile 异步编译程序，第一次选中 / 悬停不卡着色器编译）。 */
  function warmGroup() {
    const g = new THREE.Group()
    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    const seg = new LineSegmentsGeometry().setPositions([0, 0, 0, 1, 0, 0])
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3))
    g.add(new THREE.Mesh(tri, M.danger), new THREE.Mesh(tri, M.sil), new LineSegments2(seg, M.sel), new LineSegments2(seg, M.move), new THREE.LineSegments(tri, M.selHidden), new THREE.LineSegments(tri, M.weak), new THREE.LineSegments(tri, M.hover), new THREE.LineSegments(phGeo, M.ph))
    g.userData.dispose = () => { tri.dispose(); seg.dispose() }
    return g
  }
  return {
    setPalette, warmGroup,
    /** 重建标记 / 几何变了（或边线刚到）的条目；list 之外的删掉。 */
    update(list) {
      const seen = new Set()
      for (const e of list) {
        if (!e.fx) continue
        seen.add(e.id)
        const cur = byId.get(e.id)
        const ready = !!(e.item && e.item.edgesReady)
        if (cur && cur.mask === e.fx && cur.item === e.item && cur.ready === ready) { cur.src = e; continue }
        if (cur) grp.remove(cur.g)
        const g = build(e)
        grp.add(g)
        byId.set(e.id, { g, mask: e.fx, item: e.item, ready, src: e })
      }
      for (const [id, r] of byId) if (!seen.has(id)) { grp.remove(r.g); byId.delete(id) }
    },
    /** 每帧：矩阵 / 显隐跟着条目走（零分配）。 */
    follow() {
      for (const r of byId.values()) {
        const el = r.g.matrix.elements, m = r.src.m
        for (let i = 0; i < 16; i++) el[i] = m[i]
        r.g.visible = r.src.visible !== false
        r.g.matrixWorldNeedsUpdate = true
      }
    },
    clear() { for (const r of byId.values()) grp.remove(r.g); byId.clear() },
    get count() { return byId.size },
    dispose() {
      this.clear()
      fxRoot.remove(grp)
      for (const m of Object.values(M)) m.dispose()
      phGeo.dispose()
    }
  }
}

// ───────────────────────────── ghost 池 ─────────────────────────────

/**
 * 拖入时的 ghost：主 ghost + 对称预览 ghost（按需从池里取，最多 8 个）。
 * ★ 看得出件本来的材质：有效位用件自己的材质（半透明 0.62 的副本、不加自发光），边线只取大折角（≥ 40°）的中性墨色细线；
 *   无效位整件换成 danger 半透明 + danger 边线。
 * ★ 材质副本按源材质常驻（Map<源材质, 副本>，编辑器生命周期内不释放；源材质所在的缓存条目被挤出时才一并丢）：
 *   透明 / 单趟是一套新的程序变体，每次拖动结束就 dispose 的话程序引用归零被删，同一件每拖一次都要重新 link。
 * ★ 首帧不卡：warm(item) 把副本挂在一个不进场景的组上交给视口 precompile（KHR_parallel_shader_compile 异步编译）——
 *   库卡片按下（还没过 4 px 拖动门槛）就开始编译；编译好之前 ghost 不露面（吸附标记照常），编好了下一帧出来。
 * ★ 边线由几何 Worker 预先算好（cache.edgesIf，40° 档）：到了才挂上，之后池里新来的 ghost 直接带边线。
 * 几何全部与缓存共享（clone），只有 ghost 材质是自己的。
 */
export function createGhostPool(fxRoot, cache, o = {}) {
  const precompile = typeof o.precompile === 'function' ? o.precompile : null
  const onWarm = typeof o.onWarm === 'function' ? o.onWarm : null
  const grp = new THREE.Group(); grp.name = 'asm_ghost'; grp.matrixAutoUpdate = false; grp.visible = false
  fxRoot.add(grp)
  const bad = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, forceSinglePass: true })
  const edge = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false })
  let pal = palette(false), valid = true, want = 0
  const pool = []   // THREE.Group（子节点：网格…，边线在后）
  const matCache = new Map()   // 源材质 → ghost 副本（常驻）
  let item = null, mats = [], edgesOn = false
  function paint() {
    bad.color.setHex(pal.danger)
    edge.color.setHex(valid ? pal.ghostEdge : pal.danger)
    edge.opacity = valid ? 0.55 : 0.9
  }
  function ghostMat(m) {
    if (!m || typeof m.clone !== 'function') return bad
    let c = matCache.get(m)
    if (c) return c
    c = m.clone()
    c.transparent = true; c.opacity = Math.min(c.opacity == null ? 1 : c.opacity, 1) * 0.62; c.depthWrite = false; c.forceSinglePass = true
    if (c.emissive) c.emissiveIntensity = Math.min(c.emissiveIntensity || 0, 0.2)
    matCache.set(m, c)
    return c
  }
  const matsFor = (it) => it.meshes.map((mm) => (Array.isArray(mm.material) ? mm.material.map(ghostMat) : ghostMat(mm.material)))
  function make() {
    const g = new THREE.Group(); g.matrixAutoUpdate = false
    item.meshes.forEach((mm, k) => {
      const m = new THREE.Mesh(mm.geometry, valid ? mats[k] : bad); m.matrixAutoUpdate = false; m.matrix.copy(mm.rel); m.layers.set(L_FX); m.renderOrder = 8
      g.add(m)
    })
    if (edgesOn) addEdges(g)
    grp.add(g)
    return g
  }
  function addEdges(g) {
    for (const mm of item.meshes) {
      const eg = cache.edgesIf(item, mm.geometry, GHOST_EDGE_DEG)
      if (!eg) continue
      const l = new THREE.LineSegments(eg, edge); l.matrixAutoUpdate = false; l.matrix.copy(mm.rel); l.layers.set(L_FX); l.renderOrder = 9
      g.add(l)
    }
  }
  function swapMats() {
    for (const g of pool) {
      let k = 0
      for (const m of g.children) if (m.isMesh) { m.material = valid ? mats[k] : bad; k++ }
    }
  }
  /** 该件的 ghost 材质副本异步编译（不阻塞）；编好置 it.ghostWarmed。重复调用复用同一个 Promise。 */
  function warm(it) {
    if (!it || it.ghostWarm || !precompile) { if (it && !precompile) it.ghostWarmed = true; return it ? it.ghostWarm : null }
    const g = new THREE.Group()
    const ms = matsFor(it)
    it.meshes.forEach((mm, k) => g.add(new THREE.Mesh(mm.geometry, ms[k])))
    g.add(new THREE.Mesh(it.meshes.length ? it.meshes[0].geometry : new THREE.BufferGeometry(), bad))
    let p
    try { p = Promise.resolve(precompile(g)) } catch { p = Promise.resolve() }
    it.ghostWarm = p.catch(() => null).then(() => { it.ghostWarmed = true; if (onWarm) onWarm(it) })
    return it.ghostWarm
  }
  return {
    setPalette(p) { pal = p; paint() },
    warm,
    /** 源材质所在的缓存条目被挤出：丢掉它自己的（非库）材质的副本。 */
    forget(it) { for (const m of it.ownMats) { const c = matCache.get(m); if (c) { c.dispose(); matCache.delete(m) } } },
    /** 换 ghost 组件（清池；材质副本常驻不释放）。 */
    setItem(it) {
      for (const r of pool) grp.remove(r)
      pool.length = 0
      item = it
      edgesOn = false
      want = 0
      if (it) {
        mats = matsFor(it)
        warm(it)
        edgesOn = !!it.edgesReady
        pool.push(make())
      } else mats = []
      paint()
    },
    /** 确保池里至少 n 个（主 + 派生）；只在对称份数变了时调（会分配）。 */
    ensure(n) { while (item && pool.length < n) pool.push(make()) },
    /** 第 k 个 ghost 的矩阵（pose.m + 镜面列取反）；k ≥ count 的藏起来。零分配。 */
    place(k, m, ax) { const g = pool[k]; if (!g) return; writeRenderMatrix(g.matrix.elements, m, ax); g.matrixWorldNeedsUpdate = true; g.visible = true },
    /** 露出前 n 个（着色器还没编好时整组先不露面：不在交互那一帧同步编译）；边线到了顺手挂上（一次性）。 */
    showCount(n) {
      want = n
      for (let i = 0; i < pool.length; i++) pool[i].visible = i < n
      grp.visible = n > 0 && !!(item && item.ghostWarmed)
      if (!edgesOn && item && item.edgesReady && n > 0) { edgesOn = true; for (const g of pool) addEdges(g) }
    },
    /** 编译刚完成 / 边线刚到：按上次的份数重新露面。 */
    refresh() { if (want > 0) this.showCount(want) },
    setValid(v) { if (valid !== !!v) { valid = !!v; paint(); swapMats() } },
    hide() { grp.visible = false; want = 0 },
    get visible() { return grp.visible },
    get size() { return pool.length },
    get item() { return item },
    get warmedMats() { return matCache.size },
    dispose() { this.setItem(null); fxRoot.remove(grp); bad.dispose(); edge.dispose(); for (const c of matCache.values()) c.dispose(); matCache.clear() }
  }
}

export { planeAxis }
