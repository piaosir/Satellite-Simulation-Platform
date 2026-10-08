// 球面模型图标抽稀 Worker（算法见 iconLod.js）。由 iconBatch.js 以 new Worker(new URL('./iconLodWorker.js', import.meta.url), { type: 'module' }) 启动。
// 消息：{ id, parts:[{pos, nrm, idx}], errs } → { id, ok, levels } | { id, ok:false, error }；索引缓冲 transfer 回去。
import { MeshoptSimplifier } from 'meshoptimizer'
import { simplifyIconParts } from './iconLod.js'

self.onmessage = async (ev) => {
  const { id, parts, errs } = ev.data || {}
  try {
    await MeshoptSimplifier.ready
    const levels = simplifyIconParts(MeshoptSimplifier, parts, errs)
    const tr = []
    for (const lv of levels) for (const a of lv) if (a) tr.push(a.buffer)
    self.postMessage({ id, ok: true, levels }, tr)
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) })
  }
}
