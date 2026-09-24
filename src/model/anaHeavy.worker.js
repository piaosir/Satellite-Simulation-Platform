// 分析页整段同步的重活（analysisCore.HEAVY：功率、万向节）在这里跑，主线程只等结果（25.9 万拍的功率约 150 ms、不再卡一帧）。
// 结果里的 TypedArray 全部转移（transfer）回去，不再拷一遍。
import { HEAVY } from './analysisCore.js'

function buffersOf(v, out, seen) {
  if (!v || typeof v !== 'object' || seen.has(v)) return out
  seen.add(v)
  if (ArrayBuffer.isView(v)) { if (v.buffer && !out.includes(v.buffer)) out.push(v.buffer); return out }
  if (Array.isArray(v)) { for (const x of v) buffersOf(x, out, seen); return out }
  for (const k in v) buffersOf(v[k], out, seen)
  return out
}

self.onmessage = (e) => {
  const { id, op, args } = e.data || {}
  try {
    const fn = HEAVY[op]
    if (!fn) throw new Error('未知运算：' + op)
    const r = fn(args)
    self.postMessage({ id, ok: true, r }, buffersOf(r, [], new Set()))
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) })
  }
}
