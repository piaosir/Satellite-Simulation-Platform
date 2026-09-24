// 对地性能表带时刻行的取值缓存（usePerfTable.computeRows 的 cache 参数）：有缓存与无缓存逐字段一致；命中时不再解星位。
// 运行：node packages/core/test/perfTimedCache.test.mjs
import { usePerfTable } from '../../../src/viz/grd/usePerfTable.js'
import { antennaBasis, projectGrid } from '../../../src/viz/grd/coverage.js'
import { buildRecord, materialize } from '../../../src/viz/grd/gaussStk.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }

const ALT = 35786
const MODEL = { id: 'm1', name: 'STK', fGHz: 14.5, drv: 'bw', D: 0, bw3: 6, G: 0, eff: 55, back: -30, k: 'stk' }
const rec = buildRecord({ sat: { name: 'GEO', lon: 0, lat: 0, altKm: ALT }, models: [MODEL], beams: [{ name: 'b1', az: 0, el: 0, model: 'm1' }, { name: 'b2', az: 2, el: 1, model: 'm1' }] })
const basisAt = (lon) => antennaBasis(lon, lon, 0, 0, 0, ALT)
const basis0 = basisAt(0)
const beams = materialize(rec).sets.map((set, bi) => ({
  bi, seq: bi + 1, name: 'b' + (bi + 1), peakDb: set.an.g0,
  beam: { P1: set.P1, P2: set.P2, c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, an: set.an,
    grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY, exact: true }, proj: projectGrid(set, 6, basis0, null, null, true) }
}))
const meta = { satLon: 0, satLat: 0, satAlt: ALT }
const ctx = { key: 'S|A', igrid: 6, icomp: 0, basis: basis0, meta, settings: { pol: 'RSS', gainOffset: 0, pathLoss: 'none', ctype: 'abs' }, beams, satNo: 1, antNo: 1, satName: 'GEO', antName: 'A' }

const p = usePerfTable()
const opts = p.getOpts ? { ...p.getOpts('x') } : {}
const cols = {}; for (const k of ['scAz', 'scEl', 'gsAz', 'gsEl', 'dir', 'param', 'minPt', 'maxPt', 'xpol', 'slope']) cols[k] = true
Object.assign(opts, { cols: { ...(opts.cols || {}), ...cols }, sameAsAnt: true, pointAz: 0.2, pointEl: 0.2, pointYaw: 0.1 })

const T0 = Date.UTC(2026, 8, 25)
const st = []
for (let i = 0; i < 12; i++) st.push({ id: 's' + i, city: 'c' + i, lon: -4 + i * 0.7, lat: 3 - i * 0.5, tMs: i % 4 === 3 ? null : T0 + i * 600000, altM: i % 2 ? 10000 : null })
st.push({ id: 'dup', lon: st[0].lon, lat: st[0].lat, tMs: st[0].tMs, altM: st[0].altM })   // 与 s0 同键：命中同一条缓存
let calls = 0
const ctxAt = (tMs) => { calls++; const lon = (tMs - T0) / 3.6e6; return { basis: basisAt(lon), meta: { satLon: lon, satLat: 0, satAlt: ALT } } }

const strip = (rows) => JSON.stringify(rows)
for (const filterOn of [false, true]) {
  const o = { ...opts, filterOn, minDir: 27.7 }
  const ref = p.computeRows(ctx, o, st, ctxAt)
  const cache = { map: new Map() }
  calls = 0
  const a = p.computeRows(ctx, o, st, ctxAt, cache)
  const c1 = calls
  calls = 0
  const b = p.computeRows(ctx, o, st, ctxAt, cache)
  ok(strip(a.rows) === strip(ref.rows), `filterOn=${filterOn}：首轮（填缓存）与无缓存逐字段一致`, a.rows.length + ' 行')
  ok(strip(b.rows) === strip(ref.rows), `filterOn=${filterOn}：次轮（命中缓存）与无缓存逐字段一致`)
  ok(c1 > 0 && calls === 0, `filterOn=${filterOn}：命中时不再解星位`, `首轮 ${c1} 次 / 次轮 ${calls} 次`)
  // 不带时刻的行照旧按当前上下文：换当前基底，缓存行不变、非时刻行跟着变
  const ctx2 = { ...ctx, basis: basisAt(1.5), meta: { satLon: 1.5, satLat: 0, satAlt: ALT } }
  const r2 = p.computeRows(ctx2, o, st, ctxAt), c2 = p.computeRows(ctx2, o, st, ctxAt, cache)
  ok(strip(c2.rows) === strip(r2.rows), `filterOn=${filterOn}：当前星位变了，缓存路与无缓存仍一致`)
  // 删掉一行 → 用不到的条目清掉
  const n0 = cache.map.size
  p.computeRows(ctx, o, st.slice(1, 5), ctxAt, cache)
  ok(cache.map.size < n0, `filterOn=${filterOn}：没用到的缓存条目清掉`, `${n0} → ${cache.map.size}`)
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
