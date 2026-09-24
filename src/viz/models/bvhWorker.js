// 拾取用 BVH 的建树 Worker（three-mesh-bvh 的 MeshBVH，indirect 模式）。
//
// 为什么自己写而不用 three-mesh-bvh/worker 的 GenerateMeshBVHWorker：它在依赖包里用 new URL('./x.worker.js', import.meta.url)
// 起 Worker，Vite 的依赖预构建会把那个相对文件弄丢（要在 vite 配置里 optimizeDeps.exclude 才行）；本目录的 Worker 由 Vite 当
// 应用源码处理，dev 与打包都实测过（analyzeWorker.js 同一写法）。做的事一样：Worker 里建树 → MeshBVH.serialize（不克隆缓冲）
// → roots 与 indirectBuffer 整块 transfer 回主线程 → MeshBVH.deserialize 挂到原几何上。
//
// indirect：不重排几何的原索引（部件 triRanges、拾取交出的三角形号都按原索引数）。几何的 groups / drawRange 决定 BVH 分几个根，
// 所以一并带过来，建出来的根与主线程直接 new MeshBVH(g, {indirect:true}) 逐一相同。
// 消息：{ id, position:Float32Array, index:Uint16Array|Uint32Array|null, groups, drawRange } → { id, ok, roots, indirectBuffer } | { id, ok:false, error }
import { BufferGeometry, BufferAttribute } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

export function buildSerializedBvh({ position, index, groups, drawRange }) {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(position, 3))
  if (index) g.setIndex(new BufferAttribute(index, 1))
  for (const gr of groups || []) g.addGroup(gr.start, gr.count, gr.materialIndex)
  if (drawRange) g.setDrawRange(drawRange.start, drawRange.count)
  const bvh = new MeshBVH(g, { indirect: true })
  const s = MeshBVH.serialize(bvh, { cloneBuffers: false })
  const transfer = s.roots.filter((r) => r instanceof ArrayBuffer)
  if (s.indirectBuffer && s.indirectBuffer.buffer instanceof ArrayBuffer) transfer.push(s.indirectBuffer.buffer)
  return [{ version: s.version, roots: s.roots, indirectBuffer: s.indirectBuffer }, transfer]
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') self.onmessage = (ev) => {
  const { id } = ev.data || {}
  try {
    const [r, transfer] = buildSerializedBvh(ev.data)
    self.postMessage({ id, ok: true, ...r }, transfer)
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) })
  }
}
