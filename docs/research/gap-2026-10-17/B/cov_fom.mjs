// B 路验证 2：覆盖 FOM（coverageGrid.createCoverageRun）的采样量化 + 球冠判据，对单格 FOM 与 accessWindows 1 s 真值比；
// 以及规模：Walker N 星 × 全球网格的耗时（单线程、生产代码原样）。
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const V = await import(pathToFileURL(ROOT + '/src/viz/vis/visibility.js').href)
const C = await import(pathToFileURL(ROOT + '/src/viz/vis/coverageGrid.js').href)

const MU = 398600.4418, RE = 6378.137
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI)
  const out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) {
    const raan = 360 * p / P, ma = (360 * s / S + 360 * F * p / (P * S)) % 360
    const rec = sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan, argp: 0, ma, bstar: 0, mdot: 0, mddot: 0 })
    out.push({ rec, name: `W${p}-${s}`, noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  }
  return out
}
const times = { now: epoch, ccNow: epoch }

// ---- (a) 单格精度：北京所在 1° 胞元中心 vs 1 s accessWindows 真值 ----
{
  const ents = walker({ altKm: 550, incl: 53, P: 6, S: 22 })
  const thr = 25, H = 24 * 3600
  // 1° 网格、仅 1 格：边界 [39.5,40.5]×[116,117] → 中心 (40.0, 116.5)
  const grid = C.makeCoverageGrid({ kind: 'bounds', latMin: 39.5, latMax: 40.5, lonMin: 116, lonMax: 117 }, 1)
  const cell = grid.cells[0]
  const truth = V.accessWindows(ents, [cell], times, H, thr, { coarseSec: 1 })
  const tc = V.timeCoverage(truth, H / 60)
  let passes = 0; for (const s of truth) passes += s.windows.length
  // 真值「访问次数」= 合并后区间数；最大重访间隔 = 合并后最长中断（含首尾）
  const iv = []; for (const s of truth) for (const w of s.windows) iv.push([w.startMin, w.endMin]); iv.sort((x, y) => x[0] - y[0])
  let merged = 0, cur = -1; for (const [a, b] of iv) { if (a > cur) { merged++; cur = b } else if (b > cur) cur = b }
  console.log(`(a) 单格 (${cell.lat},${cell.lon}) 门限 ${thr}° 24h：真值 时间覆盖 ${tc.pct.toFixed(3)}% 访问次数(合并) ${merged} 最大间隔 ${tc.maxGapMin.toFixed(2)} min 平均间隔 ${(tc.gapCount ? ((H / 60 - tc.coveredMin) / tc.gapCount) : 0).toFixed(2)} min`)
  for (const sampleSec of [60, 30, 10, 5]) {
    const run = C.createCoverageRun(ents, grid, times, { horizonSec: H, minElevDeg: thr, sampleSec })
    run.stepBatch(1e9); const r = run.finalize()
    console.log(`    采样 ${sampleSec}s：时间覆盖 ${r.fom.percent[0].toFixed(3)}% 访问次数 ${r.fom.count[0]} 最大间隔 ${r.fom.revisit[0].toFixed(2)} min 平均间隔 ${r.fom.avggap[0].toFixed(2)} min 最大重数 ${r.fom.nasset[0]}`)
  }
}

// ---- (b) 规模：生产核单线程耗时（取部分采样外推）----
for (const cfg of [
  { tag: 'Walker 72×22=1584 (550km/53°)', c: { altKm: 550, incl: 53, P: 72, S: 22 }, step: 1, thr: 25 },
  { tag: 'Walker 100×60=6000 (550km/53°)', c: { altKm: 550, incl: 53, P: 100, S: 60 }, step: 1, thr: 25 },
  { tag: 'Walker 100×100=10000 (550km/53°)', c: { altKm: 550, incl: 53, P: 100, S: 100 }, step: 1, thr: 25 },
  { tag: 'Walker 100×100=10000 (550km/53°) 0.5°', c: { altKm: 550, incl: 53, P: 100, S: 100 }, step: 0.5, thr: 25 },
  { tag: 'Walker 100×100=10000 (550km/53°) 0.25°', c: { altKm: 550, incl: 53, P: 100, S: 100 }, step: 0.25, thr: 25 },
]) {
  const ents = walker(cfg.c)
  const grid = C.makeCoverageGrid({ kind: 'global' }, cfg.step)
  const H = 6 * 3600, sampleSec = 60
  const run = C.createCoverageRun(ents, grid, times, { horizonSec: H, minElevDeg: cfg.thr, sampleSec })
  const k = 10
  const t0 = performance.now(); run.stepBatch(k); const dt = performance.now() - t0
  const work = C.estimateCoverageWork(grid.cells.length, ents.length, H, sampleSec)
  console.log(`(b) ${cfg.tag} · 全球 ${cfg.step}° ${grid.cells.length} 格 · 6h/60s=${run.T} 采样：${(dt / k).toFixed(1)} ms/采样 → 全程约 ${(dt / k * run.T / 1000).toFixed(1)} s；估算工作量 ${work.toExponential(2)}（上限 2.5e8 ${work > 2.5e8 ? '超限被拒' : '放行'}）`)
}
