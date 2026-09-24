// 装配编辑器的几何预计算 Worker（P3 修复轮 rv2）：组件几何第一次进缓存时，把「描边用的折角边线」与「拾取 / 穿插用的 BVH」
// 挪到这里算，交互路径（悬停 / 选中 / 落下 / ghost 露面）上不再现建 EdgesGeometry、不再同步 new MeshBVH。
//
// 由 asmLive.js 以 new Worker(new URL('./asmGeomWorker.js', import.meta.url), { type: 'module' }) 启动（与 bvhWorker / analyzeWorker 同写法）。
// 消息：{ id, position:Float32Array, index:Uint16Array|Uint32Array|null, groups, drawRange, edges:number[]（折角门限，度）, bvh:boolean }
//   → { id, ok:true, edges:{ [deg]: Float32Array（线段端点，transfer）}, bounds:{ [deg]: [minx,miny,minz,maxx,maxy,maxz, cx,cy,cz,r] },
//       bvh?:{version, roots, indirectBuffer}（transfer）} | { id, ok:false, error }
//   bounds = 边线几何的包围盒与包围球（主线程直接挂上，第一次画描边时不再逐顶点现算）。
// 边线直接用 three 的 EdgesGeometry（与主线程现建逐位相同）；BVH 与 viewport 的 bvhWorker 同一个建树函数（indirect、带 groups / drawRange）。
import { BufferGeometry, BufferAttribute, EdgesGeometry } from 'three'
import { buildSerializedBvh } from './bvhWorker.js'

// bvhWorker.js 在 Worker 里被 import 时会顺手挂它自己的 onmessage：这里在模块体里重挂，以本文件的为准
self.onmessage = (ev) => {
  const d = ev.data || {}
  const { id } = d
  try {
    const out = { id, ok: true, edges: {}, bounds: {} }, transfer = []
    if (Array.isArray(d.edges) && d.edges.length) {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(d.position, 3))
      if (d.index) g.setIndex(new BufferAttribute(d.index, 1))
      for (const deg of d.edges) {
        const e = new EdgesGeometry(g, deg)
        const a = e.attributes.position.array
        e.computeBoundingBox(); e.computeBoundingSphere()
        const bb = e.boundingBox, bs = e.boundingSphere
        out.bounds[deg] = a.length ? [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z, bs.center.x, bs.center.y, bs.center.z, bs.radius] : null
        out.edges[deg] = a
        transfer.push(a.buffer)
        e.dispose()
      }
    }
    if (d.bvh) {
      const [r, tr] = buildSerializedBvh({ position: d.position, index: d.index, groups: d.groups, drawRange: d.drawRange })
      out.bvh = r
      for (const b of tr) if (!transfer.includes(b)) transfer.push(b)
    }
    self.postMessage(out, transfer)
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) })
  }
}
