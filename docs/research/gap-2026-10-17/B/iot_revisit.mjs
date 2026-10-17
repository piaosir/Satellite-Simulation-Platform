// B 路验证 7：稀疏物联网 LEO 星座（天启同量级：24 颗、850 km）对单点的重访 / 等待类指标——
// 生产口径（过境 90 s 粗扫；覆盖 60 s 采样）vs 1 s 真值；另给「平均响应时间」（随机时刻发起、等到下一次可见的期望等待）。
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
const ents = walker({ altKm: 900, incl: 50, P: 3, S: 4 })
const H = 7 * 86400
// 区间工具：合并窗口 → 间隔列表（含首尾）
function gapsOf(res, Hmin) {
  const iv = []; for (const s of res) for (const w of s.windows) iv.push([Math.max(0, w.startMin), Math.min(Hmin, w.endMin)])
  iv.sort((a, b) => a[0] - b[0])
  const g = []; let cur = 0, n = 0, merged = 0
  for (const [a, b] of iv) { if (a > cur) { g.push(a - cur); n++; merged++ } else if (merged === 0) merged = 1; if (b > cur) cur = b }
  if (cur < Hmin) g.push(Hmin - cur)
  return { gaps: g, contacts: merged }
}
for (const [tag, tgt] of [['北京', { lat: 39.9, lon: 116.4 }], ['海口', { lat: 20.0, lon: 110.3 }], ['乌鲁木齐', { lat: 43.8, lon: 87.6 }]]) {
  for (const thr of [10, 20]) {
    const prod = V.accessWindows(ents, [tgt], times, H, thr, { coarseSec: 90 })
    const truth = V.accessWindows(ents, [tgt], times, H, thr, { coarseSec: 1 })
    const gp = gapsOf(prod, H / 60), gt = gapsOf(truth, H / 60)
    const mrt = (g) => g.reduce((s, x) => s + x * x, 0) / (2 * H / 60)        // 平均响应时间（min）
    const mean = (g) => g.reduce((s, x) => s + x, 0) / g.length
    const grid = C.makeCoverageGrid({ kind: 'bounds', latMin: tgt.lat - 0.5, latMax: tgt.lat + 0.5, lonMin: tgt.lon - 0.5, lonMax: tgt.lon + 0.5 }, 1)
    const run = C.createCoverageRun(ents, grid, times, { horizonSec: H, minElevDeg: thr, sampleSec: 60 }); run.stepBatch(1e9); const r = run.finalize()
    console.log(`${tag} 门限 ${thr}° 7 天：合并接触次数 真值 ${gt.contacts} / 过境模式 ${gp.contacts} / 覆盖 FOM(60s) ${r.fom.count[0]}；`
      + `最长间隔 真值 ${Math.max(...gt.gaps).toFixed(1)} / 过境 ${Math.max(...gp.gaps).toFixed(1)} / 覆盖 ${r.fom.revisit[0].toFixed(1)} min；`
      + `平均间隔 真值 ${mean(gt.gaps).toFixed(1)} / 覆盖 ${r.fom.avggap[0].toFixed(1)} min；平均响应时间（真值）${mrt(gt.gaps).toFixed(1)} min（平台无此 FOM）`)
  }
}
