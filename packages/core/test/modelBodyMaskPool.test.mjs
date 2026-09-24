// 本体遮挡掩模 Worker 池（src/viz/models/bodyMaskPool.js）——node 下没有 Worker，池子自己走主线程路；
// 另用一个「假 Worker」（structuredClone 过一遍 + 调 bodyMask.worker.js 的 handleMessage）把 Worker 协议也跑一遍：
//   · 同键结果缓存命中、同键并发只算一次、排除名单顺序 / 去重不影响键；
//   · 取消：各调用方各自的 signal 各自生效，A 取消不连累同键的 B、结果照样进缓存；预先取消的 signal 不开算；
//     全体取消时主线程路在让出点停算、不进缓存、之后同键重算正常；Worker 路全体取消照样算完进缓存；
//   · 几何签名含节点名 / 父子表（改名、挪层级、名字拼接不撞键），池子不串缓存；
//   · noObscuration：meta 带的「不遮挡」节点缺省并入排除名单，includeNoObscuration 显式关闭；池子与同步核口径一致；
//   · 响应式代理（Vue ref 包出来的 nodeNames）不致 DataCloneError 降级；DataCloneError 只让那一片走主线程、池子不降级；
//   · needGeom 补发、Worker 崩溃回退主线程、dispose 拒绝挂起的调用；Worker 端收下的顶点不再复制一份。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz/models') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const W = await import(SRC + 'bodyMask.worker.js')
const P = await import(SRC + 'bodyMaskPool.js')
const M = await import(CORE + 'models/mask.mjs')
const { buildTemplateModel } = await import(CORE + 'models/paramBus.mjs')

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { e.message = name + '：' + e.message; throw e } n++ }
const same = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false; return true }
const sameMask = (a, b) => same(a.blocked, b.blocked) && same(a.clearance, b.clearance) && same(a.hitNode, b.hitNode)
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))
const tick = () => new Promise((r) => setTimeout(r, 0))
async function until(pred, ms = 5000) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('等超时'); await tick() } }

function boxMesh(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max
  const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]]
  return { position: new Float32Array(v.flat()), index: new Uint32Array(f.flat()) }
}
const IDQ = { q_model2body: [0, 0, 0, 1] }
const PX = boxMesh([1, -1, -1], [2, 1, 1]), NX = boxMesh([-2, -1, -1], [-1, 1, 1])
const EQ = 90 * 360   // 赤道行（el 0）起点下标
const M0 = { posBody: [0, 0, 0], dirBody: [0, 0, 1] }

// 默认卫星参数化几何（主线程路一次 ~50–100 ms：让出点足够多，取消能落在算的中途）
const dsat = buildTemplateModel('default-sat')
const geomSat = P.bodyGeometryFromIR(dsat.ir, { frame: dsat.frame, articulations: dsat.articulations, articulationState: {} })
const mountSat = dsat.attachPoints.find((a) => a.name === 'reflector_1_focus')

// ───────── 主线程路（node 无 Worker） ─────────
await t('node 下无 Worker：池子走主线程；结果与同步核逐位相同；同键再算命中结果缓存（同一份数组）', async () => {
  const pool = P.createBodyMaskPool()
  assert.equal(pool.mode, 'main'); assert.equal(pool.threads, 1)
  const a = await pool.compute(geomSat, mountSat)
  assert.ok(sameMask(a, W.computeBodyMask(geomSat, mountSat)))
  assert.equal(a.stats.cached, false); assert.equal(a.stats.mode, 'main')
  const b = await pool.compute(geomSat, mountSat)
  assert.equal(b.stats.cached, true); assert.equal(b.blocked, a.blocked); assert.equal(b.stats.wallMs, 0)
  pool.dispose()
})
await t('同键并发只算一次：两个调用方拿到同一份结果、只起一个 job', async () => {
  const pool = P.createBodyMaskPool()
  const p1 = pool.compute(geomSat, mountSat), p2 = pool.compute(geomSat, mountSat)
  assert.notEqual(p1, p2)                 // 各自一个包装（各自的 signal）
  assert.equal(pool.pending, 1)
  const [a, b] = await Promise.all([p1, p2])
  assert.equal(a.blocked, b.blocked); assert.equal(a.stats.cached, false); assert.equal(b.stats.cached, false)
  assert.equal(pool.pending, 0); assert.equal(pool.cachedCount, 1)
  pool.dispose()
})
await t('取消不连累同键的其他调用方：A 取消收 AbortError，B（无 signal）拿到结果，结果进缓存', async () => {
  const pool = P.createBodyMaskPool()
  const ac = new AbortController()
  const a = settle(pool.compute(geomSat, mountSat, { signal: ac.signal }))
  ac.abort()
  const b = settle(pool.compute(geomSat, mountSat))
  const ra = await a
  assert.equal(ra.ok, false); assert.equal(ra.e.name, 'AbortError')
  const rb = await b
  assert.ok(rb.ok, rb.e && rb.e.message)
  assert.ok(sameMask(rb.v, W.computeBodyMask(geomSat, mountSat)))
  const c = await pool.compute(geomSat, mountSat)
  assert.equal(c.stats.cached, true)
  pool.dispose()
})
await t('取消立即生效（不等算完）；已取消的 signal 直接拒绝、不开算', async () => {
  const pool = P.createBodyMaskPool()
  const ac = new AbortController()
  const keep = pool.compute(geomSat, mountSat)           // 另一个调用方让 job 活着
  const t0 = performance.now()
  const a = settle(pool.compute(geomSat, mountSat, { signal: ac.signal }))
  await tick()
  ac.abort()
  const ra = await a
  const dt = performance.now() - t0
  assert.equal(ra.e.name, 'AbortError')
  const kr = await keep
  assert.ok(dt < kr.stats.wallMs, `取消用了 ${dt.toFixed(1)} ms，整算 ${kr.stats.wallMs.toFixed(1)} ms`)
  const pre = new AbortController(); pre.abort()
  const other = { ...mountSat, posBody: mountSat.posBody.map((v) => v + 0.002) }
  const rp = await settle(pool.compute(geomSat, other, { signal: pre.signal }))
  assert.equal(rp.e.name, 'AbortError'); assert.equal(pool.pending, 0)
  pool.dispose()
})
await t('全体取消（主线程路）：在让出点停算、不进缓存；之后同键重算正常', async () => {
  const pool = P.createBodyMaskPool()
  const ac1 = new AbortController(), ac2 = new AbortController()
  const a = settle(pool.compute(geomSat, mountSat, { signal: ac1.signal }))
  const b = settle(pool.compute(geomSat, mountSat, { signal: ac2.signal }))
  await tick()
  ac1.abort(); ac2.abort()
  assert.equal((await a).e.name, 'AbortError'); assert.equal((await b).e.name, 'AbortError')
  await until(() => pool.pending === 0)
  assert.equal(pool.cachedCount, 0)
  const c = await pool.compute(geomSat, mountSat)
  assert.equal(c.stats.cached, false)
  assert.ok(sameMask(c, W.computeBodyMask(geomSat, mountSat)))
  pool.dispose()
})
await t('排除名单的顺序 / 重复不影响键（第二次命中缓存）', async () => {
  const pool = P.createBodyMaskPool()
  const own = ['feed_1', 'feed_1_support', 'reflector_1', 'reflector_1_back', 'reflector_1_rim', 'reflector_1_arm']
  const a = await pool.compute(geomSat, { ...mountSat, excludeNodes: own })
  const b = await pool.compute(geomSat, { ...mountSat, excludeNodes: own.slice(3).reverse() }, { exclude: [...own.slice(0, 4), 'feed_1', ''] })
  assert.equal(b.stats.cached, true); assert.equal(b.blocked, a.blocked)
  assert.deepEqual(a.exclude, [...own].sort())
  pool.dispose()
})
await t('dispose：挂起的调用立即拒绝（不等算完）；之后再算直接拒绝', async () => {
  const pool = P.createBodyMaskPool()
  const a = settle(pool.compute(geomSat, { ...mountSat, posBody: [0.3, 0.2, 2.9] }))
  await tick()
  pool.dispose()
  const ra = await a
  assert.equal(ra.ok, false); assert.match(ra.e.message, /已释放/)
  assert.match((await settle(pool.compute(geomSat, mountSat))).e.message, /已释放/)
})

// ───────── 几何签名：节点名 / 父子表 ─────────
await t('签名随节点名 / 父子表变：只改名、只挪层级都换签名；名字拼接不撞键', async () => {
  const base = { nodes: [{ name: 'root', parent: -1 }, { name: 'boxA', parent: 0, mesh: 0 }, { name: 'boxB', parent: 0, mesh: 1 }], meshes: [PX, NX] }
  const g0 = W.bodyGeometryFromIR(base, { frame: IDQ })
  const renamed = W.bodyGeometryFromIR({ ...base, nodes: base.nodes.map((x) => (x.name === 'boxB' ? { ...x, name: 'boxC' } : x)) }, { frame: IDQ })
  const reparent = W.bodyGeometryFromIR({ ...base, nodes: base.nodes.map((x) => (x.name === 'boxB' ? { ...x, parent: 1 } : x)) }, { frame: IDQ })
  assert.ok(same(g0.positions, renamed.positions) && same(g0.triNode, renamed.triNode) && same(g0.positions, reparent.positions))
  const h = W.geometryHash(g0)
  assert.notEqual(W.geometryHash(renamed), h)
  assert.notEqual(W.geometryHash(reparent), h)
  const cat1 = { ...g0, nodeNames: ['ab', 'c', 'x'] }, cat2 = { ...g0, nodeNames: ['a', 'bc', 'x'] }
  assert.notEqual(W.geometryHash(cat1), W.geometryHash(cat2))
  assert.equal(W.geometryHash({ ...g0, nodeNames: g0.nodeNames.slice() }), h)
})
await t('两份几何三角形相同、名字对调：同一排除名单作用在各自的节点上（不串缓存）', async () => {
  const irA = { nodes: [{ name: 'root', parent: -1 }, { name: 'boxA', parent: 0, mesh: 0 }, { name: 'boxB', parent: 0, mesh: 1 }], meshes: [PX, NX] }
  const irB = { nodes: [{ name: 'root', parent: -1 }, { name: 'boxB', parent: 0, mesh: 0 }, { name: 'boxA', parent: 0, mesh: 1 }], meshes: [PX, NX] }
  const gA = P.bodyGeometryFromIR(irA, { frame: IDQ }), gB = P.bodyGeometryFromIR(irB, { frame: IDQ })
  const pool = P.createBodyMaskPool()
  const mt = { ...M0, excludeNodes: ['boxA'] }
  const a = await pool.compute(gA, mt), b = await pool.compute(gB, mt)
  assert.equal(b.stats.cached, false)
  assert.deepEqual([a.blocked[EQ], a.blocked[EQ + 180]], [0, 1])   // gA 的 boxA 在 +X：剩 −X 块
  assert.deepEqual([b.blocked[EQ], b.blocked[EQ + 180]], [1, 0])   // gB 的 boxA 在 −X：剩 +X 块
  assert.equal(b.nodeNames[b.hitNode[EQ]], 'boxB')
  pool.dispose()
})

// ───────── noObscuration ─────────
await t('meta.noObscurationNodes 随几何带出，缺省并入排除（连同子孙）；includeNoObscuration 显式关闭；同步核同口径', async () => {
  const ir = { nodes: [{ name: 'root', parent: -1 }, { name: 'radome', parent: 0, mesh: 0 }, { name: 'radome_child', parent: 1 }, { name: 'bus', parent: 0, mesh: 1 }], meshes: [PX, NX] }
  const meta = { frame: IDQ, noObscurationNodes: ['radome', 'radome', '', 7] }
  const g = P.bodyGeometryFromIR(ir, { meta })
  assert.deepEqual(g.noObscuration, ['radome'])
  const gObj = P.bodyGeometryFromIR(ir, { frame: IDQ, noObscurationNodes: ['radome'] })
  assert.deepEqual(gObj.noObscuration, ['radome'])
  const pool = P.createBodyMaskPool()
  const def = await pool.compute(g, M0)
  assert.deepEqual([def.blocked[EQ], def.blocked[EQ + 180]], [0, 1]); assert.deepEqual(def.exclude, ['radome'])
  const all = await pool.compute(g, M0, { includeNoObscuration: true })
  assert.deepEqual([all.blocked[EQ], all.blocked[EQ + 180]], [1, 1]); assert.deepEqual(all.exclude, [])
  // 同步核（computeBodyMask）与池子同一个 resolveExclude
  assert.ok(sameMask(W.computeBodyMask(g, M0), def))
  assert.ok(sameMask(W.computeBodyMask(g, M0, { includeNoObscuration: true }), all))
  // 没有 meta：不排除任何节点
  assert.deepEqual(P.bodyGeometryFromIR(ir, { frame: IDQ }).noObscuration, [])
  assert.deepEqual(W.resolveExclude(g, { excludeNodes: ['bus', 'bus'] }, { exclude: ['z'] }), ['bus', 'radome', 'z'])
  pool.dispose()
})

// ───────── 假 Worker：协议 / 代理 / DataCloneError / needGeom / 崩溃 ─────────
const FAKE = { made: [], opts: {} }
class FakeWorker {
  constructor() { this.onmessage = null; this.onerror = null; this.onmessageerror = null; this.sent = []; this.dead = false; FAKE.made.push(this); Object.assign(this, FAKE.opts) }
  postMessage(msg) {
    if (this.dead) return
    if (this.throwCloneOnce) { this.throwCloneOnce = false; throw new DOMException('模拟不可克隆', 'DataCloneError') }
    const d = structuredClone(msg)   // 真 postMessage 的克隆语义：代理 / 函数在这里抛 DataCloneError
    this.sent.push(d)
    if (d.op === 'clear') return
    setTimeout(() => {
      if (this.dead) return
      if (this.crash) { this.onerror && this.onerror({ message: '模拟崩溃' }); return }
      if (this.evictOnce && !d.geom) { this.evictOnce = false; this.onmessage({ data: { id: d.id, ok: false, needGeom: true } }); return }
      let res
      try { res = W.handleMessage(d, { ownsGeom: true })[0] } catch (e) { res = { id: d.id, ok: false, error: String(e.message || e) } }
      this.onmessage({ data: res })
    }, 0)
  }
  terminate() { this.dead = true }
}
async function withFake(opts, fn) {
  globalThis.Worker = FakeWorker; FAKE.made = []; FAKE.opts = opts || {}
  try { return await fn() } finally { delete globalThis.Worker; FAKE.opts = {} }
}
const truthSat = W.computeBodyMask(geomSat, mountSat)

await t('假 Worker×3：分行派活、拼回与同步核逐位相同；同一 Worker 第二次不再发几何', () => withFake({}, async () => {
  const pool = P.createBodyMaskPool({ threads: 3 })
  assert.equal(pool.mode, 'worker'); assert.equal(pool.threads, 3)
  const a = await pool.compute(geomSat, mountSat)
  assert.equal(a.stats.mode, 'worker'); assert.equal(a.stats.threads, 3)
  assert.ok(sameMask(a, truthSat))
  const b = await pool.compute(geomSat, { ...mountSat, posBody: mountSat.posBody.map((v) => v + 0.001) })
  assert.equal(b.stats.buildMs, 0)
  for (const w of FAKE.made) { assert.ok(w.sent[0].geom); assert.equal(w.sent[1].geom, undefined) }
  pool.dispose()
}))
await t('Vue 式响应式代理（nodeNames 是 Proxy）：发线程前现造纯数据，不抛 DataCloneError、不降级', () => withFake({}, async () => {
  const proxied = { ...geomSat, nodeNames: new Proxy(geomSat.nodeNames.slice(), {}), noObscuration: new Proxy([], {}) }
  assert.throws(() => structuredClone({ n: proxied.nodeNames }), { name: 'DataCloneError' })
  const warn = console.warn; let warned = 0; console.warn = () => { warned++ }
  try {
    const pool = P.createBodyMaskPool({ threads: 2 })
    const a = await pool.compute(proxied, mountSat)
    assert.equal(pool.mode, 'worker'); assert.equal(a.stats.mode, 'worker'); assert.equal(warned, 0)
    assert.ok(sameMask(a, truthSat))
    assert.ok(Array.isArray(a.nodeNames) && structuredClone(a.nodeNames).length === geomSat.nodeNames.length)
    pool.dispose()
  } finally { console.warn = warn }
}))
await t('postMessage 抛 DataCloneError：只那一片走主线程，池子仍是 Worker 模式、结果逐位相同', () => withFake({ throwCloneOnce: true }, async () => {
  const warn = console.warn; console.warn = () => {}
  try {
    const pool = P.createBodyMaskPool({ threads: 2 })
    const a = await pool.compute(geomSat, mountSat)
    assert.equal(pool.mode, 'worker'); assert.equal(a.stats.mode, 'main')   // 有一片是主线程补算的
    assert.ok(sameMask(a, truthSat))
    const b = await pool.compute(geomSat, { ...mountSat, posBody: [0.1, 0.2, 2.5] })
    assert.equal(b.stats.mode, 'worker')
    pool.dispose()
  } finally { console.warn = warn }
}))
await t('Worker 已淘汰那份树（needGeom）：池子补发几何，结果正确', () => withFake({}, async () => {
  const pool = P.createBodyMaskPool({ threads: 1 })
  await pool.compute(geomSat, mountSat)
  FAKE.made[0].evictOnce = true
  const b = await pool.compute(geomSat, { ...mountSat, posBody: mountSat.posBody.map((v) => v - 0.001) })
  const s = FAKE.made[0].sent
  assert.equal(s.length, 3); assert.equal(s[1].geom, undefined); assert.ok(s[2].geom); assert.equal(s[1].id, s[2].id)
  assert.ok(sameMask(b, W.computeBodyMask(geomSat, { ...mountSat, posBody: mountSat.posBody.map((v) => v - 0.001) })))
  pool.dispose()
}))
await t('Worker 崩溃（onerror）：挂起的分片退回主线程补算，结果逐位相同，之后一直走主线程', () => withFake({ crash: true }, async () => {
  const warn = console.warn; console.warn = () => {}
  try {
    const pool = P.createBodyMaskPool({ threads: 2 })
    const a = await pool.compute(geomSat, mountSat)
    assert.equal(pool.mode, 'main'); assert.equal(a.stats.mode, 'main')
    assert.ok(sameMask(a, truthSat))
    pool.dispose()
  } finally { console.warn = warn }
}))
await t('Worker 路全体取消：分片打断不了，照样算完进缓存（回头直接命中）', () => withFake({}, async () => {
  const pool = P.createBodyMaskPool({ threads: 2 })
  const ac = new AbortController()
  const a = settle(pool.compute(geomSat, mountSat, { signal: ac.signal }))
  ac.abort()
  assert.equal((await a).e.name, 'AbortError')
  await until(() => pool.pending === 0)
  const b = await pool.compute(geomSat, mountSat)
  assert.equal(b.stats.cached, true); assert.ok(sameMask(b, truthSat))
  pool.dispose()
}))
await t('dispose（Worker 路）：挂起的调用被拒绝、Worker 全部 terminate', () => withFake({}, async () => {
  const pool = P.createBodyMaskPool({ threads: 2 })
  const a = settle(pool.compute(geomSat, { ...mountSat, posBody: [0.2, 0.1, 2.2] }))
  pool.dispose()
  assert.match((await a).e.message, /已释放/)
  assert.ok(FAKE.made.every((w) => w.dead))
}))

// ───────── Worker 端顶点不再复制 ─────────
await t('buildMaskBvh ownsPositions：无排除时树直接用收到的顶点数组；主线程路（不给）仍复制', async () => {
  const g = P.bodyGeometryFromIR({ nodes: [{ name: 'r', parent: -1, mesh: 0 }], meshes: [PX] }, { frame: IDQ })
  const own = W.buildMaskBvh(g, null, { ownsPositions: true })
  assert.equal(own.bvh.geometry.attributes.position.array, g.positions)
  const cp = W.buildMaskBvh(g, null)
  assert.notEqual(cp.bvh.geometry.attributes.position.array, g.positions)
  assert.ok(same(cp.bvh.geometry.attributes.position.array, g.positions))
  // 树不改顶点：用过之后原数组逐位不变
  const before = g.positions.slice()
  W.castRows(own, [0, 0, 0], [90])
  assert.ok(same(before, g.positions))
})

console.log(`modelBodyMaskPool: ${n} 项通过`)
