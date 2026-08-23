// 聚焦星几何的 Worker 池：把逐颗的活（SGP4 采样 + 覆盖圈 + 顶点构建）摊到几个 Worker 上，
// 主线程只剩「发参数 → 收 Float32Array → 上传」。
//
// ★ 分片按 key 的哈希定，不按下标：下标会随选中集增删整体平移，那样每颗星都会换片，
//   轨道圈缓存与星下点环形缓冲全部作废 —— 缓存立不住，这个池子就只剩坏处。
// ★ 拿不到 Worker（或建失败）时就地同步跑同一份 computeTick，不另写一条退路 —— 一份实现两种跑法。
// ★ 时钟那条铁律（一次回调 = 一个时刻的完整画面）由调用方守：compute() 返回 Promise，
//   调用方必须 await 完再出帧，绝不能让「星在 t、轨道在 t−Δ」同框。
import { createShard, syncShard, computeTick, transfersOf } from './focusGeomTick.js'

const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0) }

// want<0：强制就地同步跑（不建 Worker），用来做「有没有变快」的对照基线
// ★ 分片数固定，【不跟 hardwareConcurrency 走】：分片数决定各片顶点拼进合批缓冲的先后，而聚焦星的
//   点层（星下点图标 / 高亮环 / 在轨点）是半透明且 depthTest 关的，叠压次序随之改变 —— 实测 400 颗
//   密排、同一份几何：1 片与「主线程就地」逐像素相同，2 片 0.71%、6 片 1.00% 的像素不同（几何数值
//   一字不变，只是谁压在谁上面）。让它跟核数走，同一份工程在 4 核机与 20 核机上就会出两张略有差别
//   的图，导出的 PNG 也跟着不同。故把它当【出图口径】钉死，不当性能旋钮。
//   核少的机器照开 6 个 worker：本来就是算力受限，多开几个只是多点调度开销，墙钟不变。
const SHARDS = 6
export function createFocusGeomPool(want) {
  const N = Math.max(1, Math.min(8, want > 0 ? want : SHARDS))
  const shards = []
  let ok = false
  try {
    // ★ 判据写 !(want < 0) 不写 want >= 0：本函数的常态调用是【不带参】（宿主 ConstellationMap3D
    //   就是 createFocusGeomPool()），而 undefined >= 0 是 false —— 用 >= 0 那道门对不带参的调用恒关，
    //   整个池永远落到下面那条单分片就地档，并行一次都没跑起来（只有验证台显式传数字才走得进来，
    //   所以基准表好看、软件里没变快）。NaN < 0 同样是 false，故不带参/传垃圾一律按「自动」处理，
    //   只有明确传负数才是「强制就地」那个对照档。
    if (!(want < 0) && typeof Worker !== 'undefined') {
      for (let i = 0; i < N; i++) {
        const w = new Worker(new URL('./focusGeomWorker.js', import.meta.url), { type: 'module' })
        shards.push({ w, pend: null, seen: new Set() })
      }
      ok = true
    }
  } catch { for (const s of shards) { try { s.w.terminate() } catch { /* 建到一半的先收掉 */ } } shards.length = 0; ok = false }
  if (!ok) { shards.length = 0; shards.push({ w: null, st: createShard(), seen: new Set() }) }
  let nShard = shards.length
  for (const s of shards) bind(s)
  let seq = 0
  let lastList = null, lastPrimary = null    // 最近一次 setSats 的原样入参：退回就地档时要拿它重新喂一遍

  function bind(s) {
    if (!s.w) return
    s.w.onmessage = (ev) => { const p = s.pend; if (p && ev.data.seq === p.seq) { s.pend = null; p.res(ev.data) } }
    // ★ Worker 起不来 / 中途崩：construct 不抛（模块脚本是异步取的），错误只从这里出来。不接的话
    //   那一片的 pend 永远没人 resolve —— 而调用方是 await 着它才出帧的（见 scene.holdFrames），
    //   结果是整个球面连相机都不再刷新、时钟也停在那一拍。故当场收摊退回就地同步跑。
    s.w.onerror = fallbackToLocal
  }
  // 退回「就地同步跑同一份 computeTick」：几何逐点一致，只是不再并行，故画面与数值一字不差。
  function fallbackToLocal(err) {
    if (!shards.some((s) => s.w)) return                     // 已经是就地档了（多个 worker 同时报错只收一次）
    if (typeof console !== 'undefined') console.warn('聚焦几何 Worker 失效，已退回主线程同步计算', err && (err.message || err))
    const pend = shards.map((s) => s.pend).filter(Boolean)   // 挂起的那次先攒下来，收摊后统一作废
    for (const s of shards) { s.pend = null; if (s.w) { try { s.w.terminate() } catch { /* 已经没了就算了 */ } } }
    shards.length = 0
    shards.push({ w: null, st: createShard(), seen: new Set() })
    nShard = 1
    if (lastList) setSats(lastList, lastPrimary)             // 分片没了，选中集得重新喂给这一片
    for (const p of pend) p.res(null)                        // null＝本拍作废、不画；下一拍就地算，照常出图
  }

  // list: [{ key, rec, cc, color:[r,g,b] }]，primaryKey 为主选那颗的 key
  function setSats(list, primaryKey) {
    lastList = list; lastPrimary = primaryKey
    const per = shards.map(() => ({ keys: [], add: [] }))
    for (const e of list) {
      const i = nShard === 1 ? 0 : hash(e.key) % nShard
      per[i].keys.push(e.key)
      if (!shards[i].seen.has(e.key)) { shards[i].seen.add(e.key); per[i].add.push({ key: e.key, rec: e.rec, cc: e.cc, color: e.color }) }
    }
    for (let i = 0; i < nShard; i++) {
      const keep = new Set(per[i].keys)
      for (const k of [...shards[i].seen]) if (!keep.has(k)) shards[i].seen.delete(k)
      const msg = { t: 'sync', keys: per[i].keys, add: per[i].add, primary: primaryKey || null }
      if (shards[i].w) shards[i].w.postMessage(msg); else syncShard(shards[i].st, msg)
    }
  }
  // 返回 Promise<[分片结果...] | null>；调用方必须等它 resolve 再出帧。
  // ★ 同一时刻只认最新那一次：新的一拍进来就把旧的那次就地 resolve(null)，让它的 await 立刻走掉、并且不画。
  //   否则「时钟拍」与「UI 动作触发的重算」一撞，先来那次的 Promise 永远没人 resolve —— 时钟会卡死在 await 上。
  //   Worker 按序处理消息，旧那次的回包带着旧 seq 到达时会被 onmessage 丢掉，不会串到新那次头上。
  function compute(p) {
    const s0 = ++seq
    return Promise.all(shards.map((s) => {
      if (!s.w) return Promise.resolve(computeTick(s.st, p))
      return new Promise((res) => {
        if (s.pend) { const old = s.pend; s.pend = null; old.res(null) }
        s.pend = { seq: s0, res }
        s.w.postMessage({ t: 'tick', seq: s0, p })
      })
    })).then((rs) => (rs.some((r) => !r) ? null : rs))
  }
  // 收摊：挂起的那次也要 resolve 掉。同 fallbackToLocal 的理由——Worker 一 terminate 回包就再也不来了，
  // 而调用方还 await 在那儿（出帧闸也还压着），不给个了断就是卸载途中卡死最后一帧。
  function dispose() {
    for (const s of shards) {
      const p = s.pend; s.pend = null
      if (s.w) { try { s.w.terminate() } catch { /* 已经没了就算了 */ } }
      if (p) p.res(null)
    }
    shards.length = 0
  }
  return { setSats, compute, dispose, get workers() { return shards.filter((s) => s.w).length }, get shardCount() { return nShard } }
}
export { transfersOf }
