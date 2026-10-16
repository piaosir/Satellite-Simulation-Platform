// 聚焦几何 Worker 池的「逐分片最新者胜」（src/viz/constellation/focusGeomPool.js）：
//  分片手上有一拍在算时，新来的拍先不发、只记最新参数；在算的那拍回包后才发记下的最新一拍。
//  Node 里没有 Worker：这里装一个按同一协议跑 focusGeomTick 的假 Worker（异步回包），量「Worker 实际算了哪几拍」。
//  ① 连发 A、B、C（A 在算）：Worker 只算 A、C；A、B 作废（resolve null），C 出结果
//  ② C 的结果与「同一分片先算 A 再算 C」逐位相同（被顶掉的 B 不在 Worker 状态里留下任何东西）
//  ③ 中途换选中集（sync 当场发）：随后那一拍按新选中集算，与「A → sync → C」逐条发送逐位相同
//  ④ 不重叠的逐拍（时钟连播：每拍等上一拍回来再发）一拍不少地照算
import sat from '../../../src/viz/constellation/satellite.js'
import { createShard, syncShard, computeTick, transfersOf } from '../../../src/viz/constellation/focusGeomTick.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }

// —— 假 Worker：协议同 focusGeomWorker.js，回包走 setTimeout（与真 Worker 一样异步、按序） ——
const ticksRun = []
class FakeWorker {
  constructor() { this.st = createShard(); this.q = []; this.armed = false; this.onmessage = null; this.onerror = null }
  postMessage(m) {
    this.q.push(structuredClone(m))
    this.arm()
  }
  arm() { if (!this.armed && this.q.length) { this.armed = true; setTimeout(() => { this.armed = false; this.drain() }, 5) } }
  drain() {
    const m = this.q.shift()
    if (m.t === 'sync') { syncShard(this.st, m); this.onmessage && this.onmessage({ data: { t: 'sync', seq: m.seq } }) }
    else if (m.t === 'tick') {
      ticksRun.push(m.p.tMs)
      const r = computeTick(this.st, m.p); r.t = 'tick'; r.seq = m.seq
      transfersOf(r)
      this.onmessage && this.onmessage({ data: r })
    }
    this.arm()
  }
  terminate() {}
}
globalThis.Worker = FakeWorker
const { createFocusGeomPool } = await import('../../../src/viz/constellation/focusGeomPool.js')

const EPOCH = '2026-09-22T00:00:00.000Z'
const mk = (mm, incl, raan) => sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: mm, ecc: 0.001, incl, raan, argp: 0, ma: raan, bstar: 0, mdot: 0, mddot: 0 })
const sats = [mk(15.06, 53, 0), mk(14.2, 87, 40), mk(15.5, 97, 120), mk(1.0027, 0, 200)].map((rec, i) => ({ key: 'n:' + (1800000 + i), rec, cc: true, color: 0x4dabf7 }))
const T0 = Date.parse('2026-09-22T06:00:00Z')
const P = (tMs, rebuild = true) => {
  const gm = sat.gstime(new Date(tMs))
  return {
    tMs, gmst: gm, ccTMs: tMs, ccGmst: gm,
    lod: { samples: 120, stepDeg: 4, fpSeg: 72 }, per: 1,
    ring: { on: true, tMs, gmst: gm, rebuild, build: rebuild },
    fp: { mode: 'elev', beamDeg: NaN, elevDeg: 30 },
    style: { orbDash: 'solid', trkOn: true, trkDash: 'solid', trkMode: 'line', trkFillOn: false, fpOn: true, fpDash: 'dash', fillOn: false,
      coneOn: false, faceOn: false, genCount: 0, genDash: 'solid', dotOn: true, dotPx: 13, subOn: true, ringOn: true },
    want2d: true
  }
}
const arr = (x) => (x && x.n > 0 ? Array.from(new Float32Array(x.buf, 0, x.n)) : [])
const digest = (shards) => JSON.stringify(shards.map((s) => ({ orb: arr(s.orb), orbP: arr(s.orbP), fp: arr(s.fp), trk: arr(s.trk), hl: arr(s.hl), hlP: arr(s.hlP), sub: arr(s.sub),
  dots: s.dots.map((d) => d.px + ':' + d.tint + ':' + arr(d).join(',')), f2: s.f2 || null })))

// 参照：同一组星在一个就地分片上按给定的拍序算，取最后一拍
function reference(seqTms, list) {
  const st = createShard()
  syncShard(st, { keys: list.map((e) => e.key), add: list, primary: list[0].key })
  let r = null
  for (const t of seqTms) r = computeTick(st, P(t))
  return r
}

// —— ① ② ——
{
  const pool = createFocusGeomPool(1)   // 一片：分片归属不随 key 哈希变，参照好对
  ok(pool.workers === 1, '假 Worker 已接上（不是就地档）')
  pool.setSats(sats, sats[0].key)
  ticksRun.length = 0
  const a = pool.compute(P(T0))
  const b = pool.compute(P(T0 + 60000))
  const c = pool.compute(P(T0 + 120000))
  const [ra, rb, rc] = await Promise.all([a, b, c])
  ok(ra === null && rb === null, '① A、B 被顶掉（resolve null，不画）')
  ok(Array.isArray(rc) && rc.length === 1, '① C 出结果')
  ok(ticksRun.length === 2 && ticksRun[0] === T0 && ticksRun[1] === T0 + 120000, '① Worker 只算了 A 与 C（B 没发）', ticksRun.map((t) => (t - T0) / 1000 + 's').join(','))
  ok(rc && digest(rc) === digest([reference([T0, T0 + 120000], sats)]), '② C 与「同一分片先 A 后 C」逐位相同')
  pool.dispose()
}

// —— ③ 中途换选中集 ——
{
  const pool = createFocusGeomPool(1)
  pool.setSats(sats, sats[0].key)
  const a = pool.compute(P(T0))
  const sub = sats.slice(1, 3)
  pool.setSats(sub, sub[0].key)            // sync 当场发
  const c = pool.compute(P(T0 + 300000))
  const [ra, rc] = await Promise.all([a, c])
  ok(ra === null, '③ 换集前那一拍被顶掉')
  // 参照 = 原来的逐条发送：分片先算完 A（全集），再收 sync（留下的星沿用 A 那一拍的环 / 轨迹缓存），再算 C
  const st = createShard()
  syncShard(st, { keys: sats.map((e) => e.key), add: sats, primary: sats[0].key })
  computeTick(st, P(T0))
  syncShard(st, { keys: sub.map((e) => e.key), add: [], primary: sub[0].key })
  const ref = computeTick(st, P(T0 + 300000))
  ok(rc && digest(rc) === digest([ref]), '③ 换集后那一拍与「A → sync → C」逐位相同（sync 在 C 之前生效）')
  pool.dispose()
}

// —— ④ 不重叠的逐拍 ——
{
  const pool = createFocusGeomPool(1)
  pool.setSats(sats, sats[0].key)
  ticksRun.length = 0
  const tms = [0, 60, 120, 180, 240].map((s) => T0 + s * 1000)
  let last = null
  for (const t of tms) { last = await pool.compute(P(t)); ok(last !== null, `④ ${(t - T0) / 1000}s 那一拍出结果`) }
  ok(ticksRun.length === tms.length, '④ 逐拍都算了', String(ticksRun.length))
  ok(digest(last) === digest([reference(tms, sats)]), '④ 末拍与就地逐拍算逐位相同')
  pool.dispose()
}

if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
