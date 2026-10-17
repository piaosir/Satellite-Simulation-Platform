// SGP4 吞吐 + 粗筛管线的单线程实测：Starlink 全星座 vs 在轨活跃编目
// node sgp4bench.cjs <repo>
const path = require('node:path')
const fs = require('node:fs')
const zlib = require('node:zlib')
const repo = process.argv[2]
const sat = require(path.join(repo, 'packages/core/vendor/satellite.js'))

function loadCsv(name) {
  const t = zlib.gunzipSync(fs.readFileSync(path.join(repo, 'resources/omm', name))).toString('utf8')
  const L = t.split(/\r?\n/).filter(Boolean)
  const H = L[0].split(',')
  return L.slice(1).map(l => {
    const c = l.split(',')
    const o = {}
    H.forEach((h, i) => { o[h] = c[i] })
    for (const k of ['MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION', 'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'NORAD_CAT_ID', 'ELEMENT_SET_NO', 'REV_AT_EPOCH', 'EPHEMERIS_TYPE']) o[k] = +o[k]
    return o
  })
}
const active = loadCsv('csv_active.csv.gz')
const star = new Set(loadCsv('csv_starlink.csv.gz').map(o => o.NORAD_CAT_ID))
const recs = []
let t0 = performance.now()
for (const o of active) { try { recs.push({ id: o.NORAD_CAT_ID, sl: star.has(o.NORAD_CAT_ID), r: sat.omm2satrec(o) }) } catch { } }
const tInit = performance.now() - t0
const N = recs.length
const T0 = Date.parse('2026-10-16T00:00:00Z')

// 1) 纯 SGP4 吞吐
const steps = 60
t0 = performance.now()
let bad = 0
const pos = new Float64Array(N * 3)
for (let k = 0; k < steps; k++) {
  const d = new Date(T0 + k * 60000)
  for (let j = 0; j < N; j++) {
    const pv = sat.propagate(recs[j].r, d)
    if (!pv || !pv.position) { bad++; continue }
    pos[j * 3] = pv.position.x
  }
}
const tProp = performance.now() - t0
const perUs = tProp * 1000 / (N * steps)

// 2) 一步内的体素哈希近邻（50 km 体素，查同格+26 邻格，阈值 10 km）
const d = new Date(T0)
const P = new Float64Array(N * 3)
for (let j = 0; j < N; j++) { const pv = sat.propagate(recs[j].r, d); if (pv && pv.position) { P[j * 3] = pv.position.x; P[j * 3 + 1] = pv.position.y; P[j * 3 + 2] = pv.position.z } else P[j * 3] = NaN }
t0 = performance.now()
const V = 50, map = new Map()
const key = (a, b, c) => (a + 2000) * 16000000 + (b + 2000) * 4000 + (c + 2000)
for (let j = 0; j < N; j++) {
  const x = P[j * 3]; if (Number.isNaN(x)) continue
  const k = key(Math.floor(x / V), Math.floor(P[j * 3 + 1] / V), Math.floor(P[j * 3 + 2] / V))
  let a = map.get(k); if (!a) map.set(k, a = []); a.push(j)
}
let pairs = 0, close = 0
for (let j = 0; j < N; j++) {
  const x = P[j * 3]; if (Number.isNaN(x)) continue
  if (!recs[j].sl) continue // 主体：Starlink
  const cx = Math.floor(x / V), cy = Math.floor(P[j * 3 + 1] / V), cz = Math.floor(P[j * 3 + 2] / V)
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const L = map.get(key(cx + a, cy + b, cz + c)); if (!L) continue
    for (const m of L) {
      if (m === j) continue
      pairs++
      const dx = P[m * 3] - x, dy = P[m * 3 + 1] - P[j * 3 + 1], dz = P[m * 3 + 2] - P[j * 3 + 2]
      if (dx * dx + dy * dy + dz * dz < 100) close++
    }
  }
}
const tGrid = performance.now() - t0
console.log(`编目 ${N} 颗（Starlink ${[...recs].filter(r => r.sl).length}）  omm2satrec ${tInit.toFixed(0)} ms`)
console.log(`SGP4：${(N * steps / 1e6).toFixed(2)} M 次 ${tProp.toFixed(0)} ms → ${perUs.toFixed(2)} µs/次（失败 ${bad}）`)
console.log(`单步体素近邻：候选对 ${pairs}，<10 km ${close}，耗时 ${tGrid.toFixed(1)} ms`)
const day = 86400 / 30
console.log(`外推：全编目 7 天 30 s 步长纯 SGP4 = ${(N * day * 7 * perUs / 1e6).toFixed(0)} s（单线程）`)
