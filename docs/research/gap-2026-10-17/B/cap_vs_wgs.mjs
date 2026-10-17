// 覆盖核「球冠判据」vs 过境核「WGS84 look-angle」：同一格点、同一星集，采样 5 s 对拍（高纬 / 中纬 / 赤道）
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const V = await import(pathToFileURL(ROOT + '/src/viz/vis/visibility.js').href)
const C = await import(pathToFileURL(ROOT + '/src/viz/vis/coverageGrid.js').href)
const MU = 398600.4418, RE = 6378.137
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI), out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) out.push({ rec: sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 }), name: 'w', noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  return out
}
const times = { now: epoch, ccNow: epoch }
const ents = walker({ altKm: 550, incl: 97.6, P: 12, S: 20 })
const H = 24 * 3600
for (const lat of [0.5, 39.5, 69.5, 79.5]) {
  for (const thr of [5, 25]) {
    const grid = C.makeCoverageGrid({ kind: 'bounds', latMin: lat - 0.5, latMax: lat + 0.5, lonMin: 116, lonMax: 117 }, 1)
    const cell = grid.cells[0]
    const run = C.createCoverageRun(ents, grid, times, { horizonSec: H, minElevDeg: thr, sampleSec: 5 }); run.stepBatch(1e9); const r = run.finalize()
    const truth = V.timeCoverage(V.accessWindows(ents, [cell], times, H, thr, { coarseSec: 5 }), H / 60)
    console.log(`格点 ${cell.lat}°N 门限 ${thr}°：球冠 ${r.fom.percent[0].toFixed(3)}% vs WGS84 ${truth.pct.toFixed(3)}%（差 ${(r.fom.percent[0] - truth.pct).toFixed(3)} pp）`)
  }
}
