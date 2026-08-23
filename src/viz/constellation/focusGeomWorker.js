// 聚焦星几何 Worker：只是给 focusGeomTick 套一层 onmessage —— 计算本身一行都不在这里写，
// 否则就成了「主线程一份、Worker 一份」，改一处忘一处的错在画面上根本看不出来。
import { createShard, syncShard, computeTick, transfersOf } from './focusGeomTick.js'

const st = createShard()
self.onmessage = (ev) => {
  const m = ev.data
  if (m.t === 'sync') { syncShard(st, m); self.postMessage({ t: 'sync', seq: m.seq }); return }
  if (m.t === 'tick') {
    const r = computeTick(st, m.p)
    r.t = 'tick'; r.seq = m.seq
    self.postMessage(r, transfersOf(r))
  }
}
