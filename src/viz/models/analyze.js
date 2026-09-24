// analyzeWorker 的主线程客户端：把 three 模型摊成 IR / 属性数组发给 Worker，结果换回 three 对象。
//
// 用法（工作台）：
//   const an = createAnalyzer()
//   const mp  = await an.massProps(root, meta, { massKg })     // estimate 档：{source, confidence, closed, comBody, inertiaBody, volumeM3, …}
//   const seg = await an.segment(root, meta, opts)             // {parts, attachPoints, solarPanelGroups, materialGroups, stats}
//   const lod = await an.simplifyObject(root, { ratio: 0.1, error: 0.02 })   // 新的 Object3D（几何新造、材质与原模型共享）
//   disposeLod(lod)                                            // ★ 只放几何，别用 disposeObject（会把共享材质一起放掉）
//   an.dispose()
// 所有坐标：massProps / segment 的 *Body 结果在本体系（按 meta.frame × scaleToMeters 变换），与预览叠加层同一口径。
import * as THREE from 'three'
import { threeToIR, irTransferables, splitMultiMaterial } from './irToThree.js'
import { originalName } from './loader.js'
import { modelToBodyMatrix } from './view.js'

/** LOD 档口径（DESIGN §8 / 任务书 §5.3）：lod1 ratio 0.3 error 0.01；lod2 ratio 0.1 error 0.02；贴图上限 2048 / 1024 / 512 */
export const LOD_PRESETS = {
  lod0: { ratio: 1, error: 0, maxTexture: 2048 },
  lod1: { ratio: 0.3, error: 0.01, maxTexture: 1024, prune: false },
  lod2: { ratio: 0.1, error: 0.02, maxTexture: 512, prune: true }
}

function plainAttr(attr) {
  // 交错 / 量化属性一律解成普通数组（Worker 里按下标取数；简化器要 Float32 位置）
  const n = attr.count, k = attr.itemSize
  const Ctor = attr.normalized || attr.isInterleavedBufferAttribute ? Float32Array : attr.array.constructor
  const a = new Ctor(n * k)
  for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) a[i * k + c] = attr.getComponent(i, c)
  return { array: a, itemSize: k, normalized: false }
}

/** 释放 simplifyObject 出来的 LOD（只放几何；材质与原模型共享） */
export function disposeLod(obj) {
  if (!obj) return
  obj.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.userData._lod) o.geometry.dispose() })
}

export function createAnalyzer() {
  let worker = null, seq = 0
  const pending = new Map()
  const ensure = () => {
    if (worker) return worker
    worker = new Worker(new URL('./analyzeWorker.js', import.meta.url), { type: 'module' })
    worker.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data || {}
      const p = pending.get(id)
      if (!p) return
      pending.delete(id)
      ok ? p.res(result) : p.rej(new Error(error))
    }
    worker.onerror = (ev) => {
      const err = new Error('分析线程出错：' + (ev.message || ''))
      for (const p of pending.values()) p.rej(err)
      pending.clear()
      try { worker.terminate() } catch { /* ignore */ }
      worker = null
    }
    return worker
  }
  const call = (op, payload, transfer = []) => new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ensure().postMessage({ id, op, payload }, transfer)
  })
  const bodyM = (meta) => Array.from(modelToBodyMatrix(meta).elements)

  return {
    /** estimate 档质量特性（massKg 给了才有惯量） */
    massProps(root, meta, o = {}) {
      const ir = threeToIR(root, { uv: false, normal: false })
      return call('massProps', { ir, massKg: o.massKg, bodyMatrix: bodyM(meta), tol: o.tol }, irTransferables(ir))
    },
    /** 自动部件分割（segment.mjs）；opts 透传（planar / reflector / efficiency …），bodyMatrix 自动带上 */
    segment(root, meta, opts = {}) {
      const ir = threeToIR(root, { uv: false, normal: false })
      return call('segment', { ir, opts: { ...opts, bodyMatrix: bodyM(meta) } }, irTransferables(ir))
    },
    stats(root) {
      const ir = threeToIR(root, { uv: false, normal: false })
      return call('stats', { ir }, irTransferables(ir))
    },
    /**
     * LOD 抽稀：返回 root 的克隆，每个网格的几何换成简化后的新几何（属性压实、索引 16/32 位按顶点数取）。
     * @param {{ratio:number, error:number, lockBorder?:boolean, prune?:boolean}} o  prune：允许丢掉比误差还小的孤立小件（远景档用）
     */
    async simplifyObject(root, o) {
      // 多材质网格（OBJ 常见）先按材质组拆成子网格：简化后索引顺序全变，groups 保不住，拆开才能各留各的材质。
      // 拆法与 irLayout 同一口径（splitMultiMaterial），LOD 件的节点名与 lod0 / segment 的 IR 名逐一相同
      const clone = splitMultiMaterial(root.clone(true))
      clone.updateMatrixWorld(true)
      const list = []
      clone.traverse((m) => { if (m.isMesh && m.geometry && m.geometry.attributes.position) list.push(m) })
      // 误差按「整模型」算：meshopt 的 error 是相对单个网格自身尺寸的，NASA 美术件动辄上千个小零件，
      // 各按自身尺寸 2 % 算就几乎一个也简化不动（螺栓的 2 % 是亚毫米）。换成模型最大边长的 2 %：
      // 网格 j 的相对误差 = error × 模型边长 / (网格局部边长 × 实例最大缩放)；Prune 档据此把小于误差的孤立碎件整块去掉。
      const box = new THREE.Box3(), gb = new THREE.Box3(), sz = new THREE.Vector3()
      for (const m of list) { const g = m.geometry; if (!g.boundingBox) g.computeBoundingBox(); gb.copy(g.boundingBox).applyMatrix4(m.matrixWorld); box.union(gb) }
      const modelExt = box.isEmpty() ? 0 : Math.max(...box.getSize(sz).toArray())
      const seen = new Map()   // 同一几何被多个网格共用：只算一次（误差取最大实例缩放那一份，最保守）
      const jobs = []
      for (const m of list) {
        const g = m.geometry
        const sc = m.matrixWorld.getMaxScaleOnAxis()
        if (seen.has(g)) { const j = jobs[seen.get(g)]; j._scale = Math.max(j._scale, sc); continue }
        const attributes = {}
        for (const k of Object.keys(g.attributes)) attributes[k] = plainAttr(g.attributes[k])
        const index = g.index ? Uint32Array.from(g.index.array) : null
        seen.set(g, jobs.length)
        jobs.push({ attributes, index, _scale: sc, _ext: Math.max(...g.boundingBox.getSize(sz).toArray()) })
      }
      for (const j of jobs) {
        const local = j._ext * j._scale
        j.errorScale = modelExt > 0 && local > 0 ? modelExt / local : 1
        delete j._scale; delete j._ext
      }
      const transfer = []
      for (const j of jobs) { for (const k in j.attributes) transfer.push(j.attributes[k].array.buffer); if (j.index) transfer.push(j.index.buffer) }
      const res = jobs.length ? await call('simplify', { meshes: jobs, ratio: o.ratio, error: o.error, lockBorder: !!o.lockBorder, prune: !!o.prune }, transfer) : []
      const built = res.map((r) => {
        if (!r.index.length) return null
        const ng = new THREE.BufferGeometry()
        for (const k of Object.keys(r.attributes)) { const a = r.attributes[k]; ng.setAttribute(k, new THREE.BufferAttribute(a.array, a.itemSize, a.normalized)) }
        ng.setIndex(new THREE.BufferAttribute(r.index, 1))
        ng.computeBoundingBox(); ng.computeBoundingSphere()
        ng.userData._lod = true
        return ng
      })
      let tris0 = 0, tris1 = 0, pruned = 0
      for (const r of res) { tris0 += r.tris0; tris1 += r.tris1 }
      for (const m of list) {
        const k = seen.get(m.geometry)
        if (k === undefined) continue
        if (built[k]) { m.geometry = built[k]; continue }
        // 整块被 Prune 掉：换成同名同变换的空节点（节点名还在 —— AGI / 太阳翼组按名引用它），导出件里不留 0 个三角形的图元（Validator 判错）
        const e = new THREE.Group()
        e.name = m.name; e.userData = { ...m.userData, name: originalName(m) }
        e.position.copy(m.position); e.quaternion.copy(m.quaternion); e.scale.copy(m.scale); e.visible = m.visible
        for (const c of m.children.slice()) e.add(c)
        if (m.parent) { const p = m.parent, at = p.children.indexOf(m); p.children[at] = e; e.parent = p; m.parent = null }
        pruned++
      }
      clone.userData._lodStats = { tris0, tris1, pruned }
      return clone
    },
    dispose() {
      for (const p of pending.values()) p.rej(new Error('已取消'))
      pending.clear()
      if (worker) { worker.terminate(); worker = null }
    }
  }
}
