// 模型分析 Web Worker：质量特性估算、部件分割、IR 统计、LOD 抽稀（meshoptimizer）。
//
// 为什么放 Worker：ISS / Gateway 这类百万三角形的模型，焊接 + 闭合性 + 连通分量 + 抛物面拟合一趟要几百毫秒到数秒，
// 放主线程会把预览与表单一起卡住（DESIGN §9-5「重活进 Worker」）。算法本体全在 packages/core/models/*.mjs
// （node 单测覆盖、主进程与离线脚本共用），这里只做消息分派与数组搬运。
//
// 由 analyze.js 以 new Worker(new URL('./analyzeWorker.js', import.meta.url), { type: 'module' }) 启动（同 focusGeomPool.js 的写法，
// dev 与打包都实测过）。消息：{ id, op, payload } → { id, ok, result } | { id, ok:false, error }。
// 入参 / 出参都是纯数据；大数组走 transfer（调用方传完别再用）。
import { estimateMassProps } from '@core/models/massProps.mjs'
import { autoSegment } from '@core/models/segment.mjs'
import { nodeWorldMatrices, irStats } from '@core/models/ir.mjs'
import { MeshoptSimplifier } from 'meshoptimizer'

// 列主序 4×4 乘法 a·b
function mul4(a, b) {
  const o = new Array(16)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]
  return o
}

// estimate 档：IR 各实例乘节点世界矩阵（再乘模型系 → 本体系，含米制缩放），拼起来一次判闭合 / 积分
function massProps({ ir, massKg, bodyMatrix, tol }) {
  const W = nodeWorldMatrices(ir)
  const meshes = []
  ir.nodes.forEach((n, i) => {
    if (!Number.isInteger(n.mesh) || !ir.meshes[n.mesh] || !W[i]) return
    const m = ir.meshes[n.mesh]
    meshes.push({ position: m.position, index: m.index || null, matrix: bodyMatrix ? mul4(bodyMatrix, W[i]) : W[i] })
  })
  return estimateMassProps({ meshes, massKg, tol })
}

// 焊接（任务书 §5.3「焊接后再简化」）：按「全部属性逐位相同」合并顶点 —— 简化器要共享顶点才能折叠边。
//   · 无索引几何（STL / OBJ 读出来的三角形汤）：先建索引；
//   · 有索引的也过一遍：不少导出器（NASA 美术件、CAD 转出的 glb）按三角形各写一份顶点、索引只是 0,1,2,3…，
//     逐位相同的顶点不合并，简化器眼里每个三角形都是孤岛，一条边也折叠不了。
// 只合并逐位相同的：法向 / UV 不同的同位点保持分开，简化器把它们当属性接缝（硬边、贴图缝）保留，不会被抹圆。
// 开放寻址哈希（按 32 位字比较），百万顶点在 Worker 里百毫秒级；不用字符串键（同量级要秒级、且吃内存）。
function weldExact(attrs, count) {
  const cols = []
  for (const k of Object.keys(attrs)) {
    const { array, itemSize } = attrs[k]
    const w = array instanceof Float32Array ? new Uint32Array(array.buffer, array.byteOffset, array.length) : array
    cols.push({ w, itemSize })
  }
  let cap = 16
  while (cap < count * 2) cap <<= 1
  const mask = cap - 1
  const table = new Int32Array(cap).fill(-1)
  const remap = new Uint32Array(count)
  const rep = new Uint32Array(count)   // 新顶点号 → 代表的原顶点
  let uniq = 0
  const same = (a, b) => {
    for (const { w, itemSize } of cols) for (let c = 0; c < itemSize; c++) if (w[a * itemSize + c] !== w[b * itemSize + c]) return false
    return true
  }
  for (let i = 0; i < count; i++) {
    let h = 0x811c9dc5
    for (const { w, itemSize } of cols) for (let c = 0; c < itemSize; c++) h = Math.imul(h ^ (w[i * itemSize + c] >>> 0), 0x01000193)
    let s = (h >>> 0) & mask
    for (;;) {
      const t = table[s]
      if (t < 0) { table[s] = i; rep[uniq] = i; remap[i] = uniq++; break }
      if (same(t, i)) { remap[i] = remap[t]; break }
      s = (s + 1) & mask
    }
  }
  return { remap, rep, uniq }
}

/** 抽稀一批网格（导出给 node 单测直接调；Worker 里经消息 op:'simplify' 调）。meshes[i].errorScale：误差换算到本网格的倍数（缺省 1） */
export async function simplifyMeshes({ meshes, ratio, error, lockBorder, prune }) {
  await MeshoptSimplifier.ready
  const out = [], transfer = []
  for (const m of meshes) {
    const pos = m.attributes.position.array
    const count = pos.length / 3
    let index = m.index
    let attrs = m.attributes
    {
      const { remap, rep, uniq } = weldExact(attrs, count)
      if (uniq < count) {
        const na = {}
        for (const k of Object.keys(attrs)) {
          const { array, itemSize, normalized } = attrs[k]
          const a = new array.constructor(uniq * itemSize)
          for (let v = 0; v < uniq; v++) { const s = rep[v]; for (let c = 0; c < itemSize; c++) a[v * itemSize + c] = array[s * itemSize + c] }
          na[k] = { array: a, itemSize, normalized }
        }
        attrs = na
        if (index) { const ni = new Uint32Array(index.length); for (let i = 0; i < index.length; i++) ni[i] = remap[index[i]]; index = ni }
        else index = remap   // 汤的第 i 个顶点就是第 i 个索引位
      } else if (!index) {
        index = new Uint32Array(count)
        for (let i = 0; i < count; i++) index[i] = i
      }
    }
    const n0 = index.length
    const target = Math.max(3, Math.floor((n0 * ratio) / 3) * 3)
    const errM = Math.min(1, error * (Number.isFinite(m.errorScale) && m.errorScale > 0 ? m.errorScale : 1))
    let newIdx = index, err = 0
    // 小件门槛：Prune 档（远景）一个三角形以上都参与（整块剔除靠它）；其余档 30 个三角形以下不动（再简化也省不下什么，形状却会走样）
    if (n0 >= (prune ? 3 : 90) && target < n0) {
      const I = index instanceof Uint32Array ? index : Uint32Array.from(index)
      const P = attrs.position.array instanceof Float32Array ? attrs.position.array : Float32Array.from(attrs.position.array)
      // LOD2 这种远景档加 Prune：丢掉比误差还小的孤立小件
      const flags = [...(lockBorder ? ['LockBorder'] : []), ...(prune ? ['Prune'] : [])]
      ;[newIdx, err] = MeshoptSimplifier.simplify(I, P, 3, target, errM, flags)
      // NASA 美术件多是「平直着色」：同一位置的顶点按法向 / UV 拆开，简化器把每条这样的边当接缝锁住，
      // 实测 GOES 40935 → 36654（只降 10%）。没到目标（留 5% 余量）就放开接缝（Permissive）再来一次、取三角形少的那份
      if (newIdx.length > target * 1.05) {
        const [b, e2] = MeshoptSimplifier.simplify(I, P, 3, target, errM, [...flags, 'Permissive'])
        if (b.length < newIdx.length) { newIdx = b; err = e2 }
      }
    }
    // 压实：只留还被引用的顶点（导出的 LOD 不带死顶点，体积才真降下来）
    const vcount = attrs.position.array.length / 3
    const map = new Int32Array(vcount).fill(-1)
    let nv = 0
    for (let i = 0; i < newIdx.length; i++) { const v = newIdx[i]; if (map[v] < 0) map[v] = nv++ }
    const outAttrs = {}
    for (const k of Object.keys(attrs)) {
      const { array, itemSize, normalized } = attrs[k]
      const a = new array.constructor(nv * itemSize)
      for (let v = 0; v < vcount; v++) { const t = map[v]; if (t >= 0) for (let c = 0; c < itemSize; c++) a[t * itemSize + c] = array[v * itemSize + c] }
      outAttrs[k] = { array: a, itemSize, normalized }
      transfer.push(a.buffer)
    }
    const idx = nv <= 65535 ? new Uint16Array(newIdx.length) : new Uint32Array(newIdx.length)
    for (let i = 0; i < newIdx.length; i++) idx[i] = map[newIdx[i]]
    transfer.push(idx.buffer)
    out.push({ attributes: outAttrs, index: idx, error: err, tris0: n0 / 3, tris1: newIdx.length / 3 })
  }
  return [out, transfer]
}

// node 单测 import 本文件时没有 self；页面里（有 document）误引也不去占 window.onmessage：只在 Worker 里挂消息处理
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') self.onmessage = async (ev) => {
  const { id, op, payload } = ev.data || {}
  try {
    let result, transfer = []
    if (op === 'massProps') result = massProps(payload)
    else if (op === 'segment') result = autoSegment(payload.ir, payload.opts || {})
    else if (op === 'stats') result = irStats(payload.ir)
    else if (op === 'simplify') [result, transfer] = await simplifyMeshes(payload)
    else throw new Error('未知操作：' + op)
    self.postMessage({ id, ok: true, result }, transfer)
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) })
  }
}
