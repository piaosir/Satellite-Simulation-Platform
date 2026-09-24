// 本体遮挡掩模的 Worker 池（主线程客户端）。射线核在 bodyMask.worker.js，这里只管：分行派活、缓存、取消、回退、收摊。
//
// 用法（工作台「分析」页 / 三期消费方）：
//   const pool = createBodyMaskPool()
//   const geom = bodyGeometryFromObject(modelRoot, meta, { articulationState })   // 或 bodyGeometryFromIR(ir, {meta, articulationState})
//   const m = await pool.compute(geom, mount, { signal })
//   // m = { w:360, h:181, blocked:Uint8Array, clearance:Float32Array(米，未命中 +Infinity), hitNode:Int32Array, nodeNames,
//   //       origin:[3], key, exclude, stats:{rays, tris, keptTris, buildMs, castMs, wallMs, threads, mode, cached} }
//   pool.dispose()
// ★ 返回的数组是缓存里的那一份（同键再算直接给它）——调用方只读，要改先 slice。
// ★ geom 当作不可变：签名与纯数据副本按对象身份缓存（WeakMap），就地改数组会拿到旧掩模。
//
// 排除名单（D2 §2）：挂点 excludeNodes ∪ opts.exclude ∪ geom.noObscuration（bodyGeometryFromIR 给了 meta 就从
//   meta.noObscurationNodes 带出来）——模型标了「不遮挡」的节点缺省就不参与遮挡，调用方不必记得传；
//   opts.includeNoObscuration = true 显式关掉这条缺省。与同步核 computeBodyMask 同一个 resolveExclude。
//
// 派活：181 个俯仰行按「行号模 K」交错分给 K 个 Worker（不按连续段切）：遮挡区往往集中在某几条俯仰带
//   （太阳翼平面、安装面），连续切段会让一个 Worker 独扛全部命中射线，交错切则每个 Worker 的命中比例相近，墙钟≈总量/K。
//   每个 Worker 各自建一份 BVH（按「几何签名 + 排除名单」缓存）：小模型建树只占总耗时的一成多，换来零共享内存、零同步。
//   ★ 大模型（> BIG_TRIS）只派给 0 号 Worker：140 万三角形的 IGOAL lod1 建树 0.6 s、射线 0.2 s，四路并行只省 0.2 s，
//     却要把 50 MB 顶点克隆四份、树建四遍（内存 ×4）。单路 ≈0.8 s 已在 3 s 指标内。
// 缓存：
//   · BVH：Worker 内 LRU 4 份；池子记着各 Worker 手里有哪些键，有就不再发几何；Worker 已淘汰则回 needGeom，池子补发。
//   · 结果：池内 LRU 8 份，键 = 几何内容签名（含节点名 / 父子表）| 排除名单 | 射线起点（1e-6 m 取整）。
//     几何签名按内容算（关节 / 轴向 / LOD / 改名 / 挪层级 一变就变），调用方给的 maskSignature（D18 落盘用）不参与——
//     两者口径不同，混用会让「换了关节值却拿到旧掩模」成为可能。
// 同键并发与取消：
//   · 同键只算一次（一个 job），每个调用方各自拿自己的 signal 跟 job 赛跑：谁取消谁收 AbortError，别人照常拿结果。
//   · job 里不看任何调用方的 signal：只要还有一个调用方在等，就算完并进结果缓存（「输入一变就取消上一次再发起」、
//     watch 连触两次，都不会让后来者拿到 AbortError）。
//   · 引用计数归零（所有调用方都取消了）：主线程路在下一个让出点停算、不进缓存（主线程的算力最贵，别替没人要的结果干活）；
//     Worker 路的分片已在别的线程上跑、打断不了，照样算完进缓存（回头切回来直接命中）。
//   · 传进来时已取消的 signal：直接拒绝，不开算。
// 回退：建不了 Worker、Worker 报错 / 崩溃 → 挂起的分片就地跑同一份 castRows（分块让出主线程，每块 ≤ ~25 ms），
//   数值与 Worker 路逐位相同（同一个函数、同一张方向表），之后本池一直走主线程，不反复试。
//   ★ postMessage 抛 DataCloneError（数据不可克隆）不是 Worker 坏了：只把这一片改在主线程算，池子不降级。
//     （正常不会发生：发出去的几何一律是 plainGeom 现造的纯数据——Vue 的 ref / reactive 会把 nodeNames 包成代理，
//     代理过不了结构化克隆，即 memory「IPC 不能收响应式代理」那个坑的 postMessage 版。）
import { threeToIR } from './irToThree.js'
import {
  MASK_W, MASK_H, MASK_N, bodyGeometryFromIR, geometryHash, excludedNodeFlags, excludeKey, buildMaskBvh,
  maskOrigin, castRows, articulationSignature, resolveExclude
} from './bodyMask.worker.js'

export { MASK_W, MASK_H, MASK_N, bodyGeometryFromIR, geometryHash, articulationSignature, resolveExclude }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())
const RESULT_MAX = 8
const BIG_TRIS = 250000
const WORKER_KEYS_MAX = 4   // 与 bodyMask.worker.js 的 CACHE_MAX 一致（只是个「大概率还在」的提示，不一致也只多一次 needGeom 往返）

/**
 * three 模型（加载器 / 视口出来的 Object3D，关节已按需摆好）→ 本体系三角形汤（带 meta.noObscurationNodes）。
 * 节点命名与 threeToIR / 导出件 / 关节一致（irLayout 唯一名）；root 自身的矩阵不计（模型系 = root 局部系）。
 * @param o { articulationState? } 给了就再按 AGI stage 叠一次关节（适用于 root 是静止位姿的情形；视口里已经拖好的模型别再给）
 */
export function bodyGeometryFromObject(root, meta, o = {}) {
  root.updateMatrixWorld(true)
  const ir = threeToIR(root, { uv: false, normal: false })
  return bodyGeometryFromIR(ir, { meta, articulationState: o.articulationState, articulations: o.articulationState ? undefined : [] })
}

/**
 * 发往 Worker / 进缓存键的纯数据几何（按 geom 对象身份缓存一份）：
 *   typed array 原样（Vue 不代理 typed array）；nodeNames 现造成纯字符串数组；缺的父子表补 −1。签名在这份上算。
 */
const _plain = new WeakMap()
export function plainGeom(geom) {
  let g = _plain.get(geom)
  if (g) return g
  const pos = geom.positions instanceof Float32Array ? geom.positions : Float32Array.from(geom.positions)
  const tn = geom.triNode instanceof Int32Array ? geom.triNode : Int32Array.from(geom.triNode)
  const nodeNames = Array.from(geom.nodeNames || [], (s) => String(s))
  let par = geom.nodeParent
  if (!(par instanceof Int32Array) || par.length !== nodeNames.length) {
    const p = new Int32Array(nodeNames.length).fill(-1)
    if (par) for (let i = 0; i < p.length && i < par.length; i++) p[i] = Number.isInteger(par[i]) ? par[i] : -1
    par = p
  }
  g = {
    positions: pos, triNode: tn, nodeParent: par, nodeNames,
    tris: Math.floor(pos.length / 9),
    noObscuration: Array.from(geom.noObscuration || [], (s) => String(s))
  }
  g.hash = geometryHash(g)
  _plain.set(geom, g)
  return g
}

const r6 = (v) => Math.round(v * 1e6) / 1e6
function lruGet(map, k) { const v = map.get(k); if (v !== undefined) { map.delete(k); map.set(k, v) } return v }
function lruPut(map, k, v, max) { map.delete(k); map.set(k, v); while (map.size > max) map.delete(map.keys().next().value) }
const yieldMain = () => new Promise((r) => setTimeout(r, 0))
const abortErr = () => (typeof DOMException !== 'undefined' ? new DOMException('已取消', 'AbortError') : Object.assign(new Error('已取消'), { name: 'AbortError' }))
const disposedErr = () => new Error('遮挡掩模池已释放')

/**
 * @param o { threads?: number（缺省 = 核数 − 1，夹在 1..4；传负数 = 强制主线程，做对照基线用） }
 */
export function createBodyMaskPool(o = {}) {
  const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4
  const want = Number.isFinite(o.threads) ? o.threads : Math.max(1, Math.min(4, hc - 1))
  const workers = []
  let mode = 'main'
  if (want > 0 && typeof Worker !== 'undefined') {
    try {
      for (let i = 0; i < Math.min(8, want); i++) {
        const w = new Worker(new URL('./bodyMask.worker.js', import.meta.url), { type: 'module' })
        workers.push({ w, keys: new Map(), pend: new Map() })
      }
      mode = 'worker'
    } catch (e) {
      for (const s of workers) { try { s.w.terminate() } catch { /* 建到一半的先收掉 */ } }
      workers.length = 0
    }
  }
  let seq = 0, disposed = false, cloneWarned = false
  const results = new Map()      // 结果 LRU
  const inflight = new Map()     // key → job（同键并发共用）
  let mainCtx = null             // 主线程路的 BVH 缓存（一份）：{key, ctx}

  for (const s of workers) bind(s)
  function bind(s) {
    s.w.onmessage = (ev) => {
      const d = ev.data || {}
      const p = s.pend.get(d.id)
      if (!p) return
      s.pend.delete(d.id)
      if (d.ok) p.res({ ...d, via: 'worker' })
      // Worker 已把这份树淘汰：补发几何（补发后它又有了，键照记）
      else if (d.needGeom) { lruPut(s.keys, p.msg.key, true, WORKER_KEYS_MAX); send(s, { ...p.msg, geom: p.geom }, p) }
      else p.rej(new Error(d.error || '遮挡线程出错'))
    }
    // ★ 模块 Worker 起不来 / 中途崩：构造不抛（模块脚本是异步取的），错误只从 onerror 出来。挂起的活不收就永远不 resolve。
    s.w.onerror = (ev) => fallbackToMain(new Error('遮挡线程出错：' + ((ev && ev.message) || '')))
    s.w.onmessageerror = () => fallbackToMain(new Error('遮挡线程消息无法解码'))
  }
  function send(s, msg, p) {
    s.pend.set(msg.id, p)
    try { s.w.postMessage(msg) } catch (e) {
      s.pend.delete(msg.id)
      if (e && e.name === 'DataCloneError') {
        // 数据的毛病，不是线程的毛病：这一片改在主线程算，Worker 照留；这把键它其实没收到，别记着
        s.keys.delete(msg.key)
        if (!cloneWarned && typeof console !== 'undefined') { cloneWarned = true; console.warn('遮挡掩模：几何无法发往 Worker，本片改在主线程计算', e.message) }
        p.retry()
        return
      }
      fallbackToMain(e); p.retry()
    }
  }
  // 收摊退回主线程：所有挂起的分片改在主线程补算（retry），之后本池只走主线程
  function fallbackToMain(err) {
    if (mode !== 'worker') return
    mode = 'main'
    if (typeof console !== 'undefined') console.warn('遮挡掩模 Worker 失效，已退回主线程计算', err && (err.message || err))
    const pend = []
    for (const s of workers) { for (const p of s.pend.values()) pend.push(p); s.pend.clear(); try { s.w.terminate() } catch { /* 已经没了 */ } }
    workers.length = 0
    for (const p of pend) p.retry()
  }

  // 主线程路：同一个 castRows，按块让出（每块 ≥ 1 行，累计超过 ~25 ms 就让一次）；每个让出点看一眼「已释放 / 没人要了」
  async function castMain(g, gkey, exclude, origin, rows, job) {
    const check = () => { if (disposed) throw disposedErr(); if (job && job.abandon()) throw abortErr() }
    let buildMs = 0, ctx
    if (!mainCtx || mainCtx.key !== gkey) {
      // ctx 取局部：让出期间别的计算可能把 mainCtx 换成另一份几何
      ctx = buildMaskBvh(g, excludedNodeFlags(g, exclude))
      mainCtx = { key: gkey, ctx }
      buildMs = ctx.buildMs
      await yieldMain()
      check()
    } else ctx = mainCtx.ctx
    const nR = rows.length
    const blocked = new Uint8Array(nR * MASK_W), clearance = new Float32Array(nR * MASK_W), hitNode = new Int32Array(nR * MASK_W)
    let rays = 0, castMs = 0, i = 0
    while (i < nR) {
      const t0 = now()
      let j = i
      while (j < nR && (j === i || now() - t0 < 25)) {
        const r = castRows(ctx, origin, [rows[j]])
        blocked.set(r.blocked, j * MASK_W); clearance.set(r.clearance, j * MASK_W); hitNode.set(r.hitNode, j * MASK_W)
        rays += r.rays; j++
      }
      castMs += now() - t0
      i = j
      if (i < nR) { await yieldMain(); check() }
    }
    return { rows, blocked, clearance, hitNode, rays, castMs, buildMs, keptTris: ctx.keptTris, via: 'main' }
  }

  function castWorker(s, g, gkey, exclude, origin, rows, job) {
    return new Promise((res, rej) => {
      const id = ++seq
      const msg = { id, key: gkey, exclude, origin, rows }
      const geomMsg = { positions: g.positions, triNode: g.triNode, nodeParent: g.nodeParent, nodeNames: g.nodeNames }
      if (!lruGet(s.keys, gkey)) msg.geom = geomMsg
      lruPut(s.keys, gkey, true, WORKER_KEYS_MAX)
      const p = { msg, geom: geomMsg, res, rej, retry: () => castMain(g, gkey, exclude, origin, rows, job).then(res, rej) }
      send(s, msg, p)
    })
  }

  // 一个键一个 job：真正干活的那一份。不看任何调用方的 signal（见文件头）。
  function startJob(g, gkey, key, exclude, origin) {
    const job = { refs: 0, dead: false, settle: null, promise: null }
    // 引用计数归零 → 判死（只在主线程路的让出点问）：判死同时摘掉 inflight，之后同键的新调用方另起一个 job，不会接到这份注定作废的
    job.abandon = () => {
      if (job.refs > 0) return false
      if (!job.dead) { job.dead = true; if (inflight.get(key) === job) inflight.delete(key) }
      return true
    }
    const t0 = now()
    const run = async () => {
      let parts
      if (mode === 'worker' && workers.length) {
        const use = g.tris > BIG_TRIS ? workers.slice(0, 1) : workers.slice()
        const K = use.length
        const slices = use.map((_, w) => { const rs = []; for (let j = w; j < MASK_H; j += K) rs.push(j); return rs })
        parts = await Promise.all(use.map((s, w) => castWorker(s, g, gkey, exclude, origin, slices[w], job)))
      } else {
        const rows = Array.from({ length: MASK_H }, (_, j) => j)
        parts = [await castMain(g, gkey, exclude, origin, rows, job)]
      }
      if (disposed) throw disposedErr()
      const blocked = new Uint8Array(MASK_N), clearance = new Float32Array(MASK_N), hitNode = new Int32Array(MASK_N)
      let rays = 0, buildMs = 0, castMs = 0, keptTris = 0
      for (const p of parts) {
        p.rows.forEach((j, r) => {
          blocked.set(p.blocked.subarray(r * MASK_W, r * MASK_W + MASK_W), j * MASK_W)
          clearance.set(p.clearance.subarray(r * MASK_W, r * MASK_W + MASK_W), j * MASK_W)
          hitNode.set(p.hitNode.subarray(r * MASK_W, r * MASK_W + MASK_W), j * MASK_W)
        })
        rays += p.rays; buildMs = Math.max(buildMs, p.buildMs); castMs = Math.max(castMs, p.castMs); keptTris = p.keptTris
      }
      const res = {
        w: MASK_W, h: MASK_H, blocked, clearance, hitNode, nodeNames: g.nodeNames, origin, key, exclude,
        stats: { rays, tris: g.tris, keptTris, buildMs, castMs, wallMs: now() - t0, threads: parts.length, mode: parts.every((p) => p.via === 'worker') ? 'worker' : 'main', cached: false }
      }
      // 算完一律进缓存：哪怕发起它的调用方早取消了（Worker 路判不了死，结果照样有用）
      lruPut(results, key, res, RESULT_MAX)
      return res
    }
    job.promise = new Promise((res, rej) => {
      job.settle = rej   // 收摊时立刻拒绝，不等主线程路走到下一个让出点
      run().then(res, rej)
    })
    const off = () => { if (inflight.get(key) === job) inflight.delete(key) }
    job.promise.then(off, off)
    inflight.set(key, job)
    return job
  }

  // 调用方挂到 job 上：各自的 signal 各自赛跑
  function join(job, sig) {
    job.refs++
    return new Promise((res, rej) => {
      let done = false
      const leave = () => { done = true; job.refs--; if (sig) sig.removeEventListener('abort', onAbort) }
      const onAbort = () => { if (done) return; leave(); rej(abortErr()) }
      if (sig) sig.addEventListener('abort', onAbort, { once: true })
      job.promise.then((v) => { if (done) return; leave(); res(v) }, (e) => { if (done) return; leave(); rej(e) })
    })
  }

  /**
   * 算一个挂点的掩模。
   * @param geom  bodyGeometryFromIR / bodyGeometryFromObject 的结果（可以是 Vue 代理，发线程前现造纯数据）
   * @param mount { posBody:[3], dirBody:[3], excludeNodes?:string[] }（本体系，米）
   * @param opts  { exclude?: string[]（再并入的排除名单）, includeNoObscuration?: boolean, signal?: AbortSignal }
   */
  function compute(geom, mount, opts = {}) {
    if (disposed) return Promise.reject(disposedErr())
    if (!geom || !geom.positions || !geom.triNode) return Promise.reject(new Error('缺少几何'))
    const sig = opts && opts.signal
    if (sig && sig.aborted) return Promise.reject(abortErr())
    const g = plainGeom(geom)
    const exclude = resolveExclude(g, mount, opts)
    const origin = maskOrigin(mount)
    const gkey = g.hash + '|' + excludeKey(exclude)
    const key = gkey + '|' + origin.map(r6).join(',')
    const hit = lruGet(results, key)
    if (hit) return Promise.resolve({ ...hit, stats: { ...hit.stats, cached: true, wallMs: 0 } })
    const job = inflight.get(key) || startJob(g, gkey, key, exclude, origin)
    return join(job, sig)
  }

  function clearCache() {
    results.clear(); mainCtx = null
    for (const s of workers) { s.keys.clear(); try { s.w.postMessage({ op: 'clear' }) } catch { /* ignore */ } }
  }

  // 收摊：挂起的一律 reject（Worker 一 terminate 回包就再也不来了，调用方还 await 着）
  function dispose() {
    if (disposed) return
    disposed = true
    for (const s of workers) {
      for (const p of s.pend.values()) p.rej(disposedErr())
      s.pend.clear()
      try { s.w.terminate() } catch { /* ignore */ }
    }
    workers.length = 0
    for (const job of inflight.values()) job.settle(disposedErr())
    results.clear(); inflight.clear(); mainCtx = null
  }

  return {
    compute, clearCache, dispose,
    get mode() { return mode },
    get threads() { return mode === 'worker' ? workers.length : 1 },
    /** 调试 / 单测：当前在算的键数、结果缓存份数 */
    get pending() { return inflight.size },
    get cachedCount() { return results.size }
  }
}
