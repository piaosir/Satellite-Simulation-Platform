// B 路验证 8：「仰角极值夹逼」事件检测原型（不依赖过境长短）vs 1 s 真值 vs 生产 90 s 粗扫。
// 思路：仰角 El(t) 对单星每圈只有一个局部极大（最近点）。按 P/16 采样找局部极大 → 黄金分割精炼峰值 →
//       峰值 ≥ 门限才算一次过境 → 在「峰值」与「峰前 / 峰后第一个低于门限的采样」之间二分求 AOS / LOS（单调段，必有解）。
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const V = await import(pathToFileURL(ROOT + '/src/viz/vis/visibility.js').href)
const MU = 398600.4418, RE = 6378.137, D2R = Math.PI / 180
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI), out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) out.push({ rec: sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 }), name: 'w', noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  return out
}
const A = 6378.137, B = 6356.7523142, f = (A - B) / A, e2 = 2 * f - f * f
function obsOf(lat, lon) { const la = lat * D2R, lo = lon * D2R, N = A / Math.sqrt(1 - e2 * Math.sin(la) ** 2); return { ox: N * Math.cos(la) * Math.cos(lo), oy: N * Math.cos(la) * Math.sin(lo), oz: N * (1 - e2) * Math.sin(la), ux: Math.cos(la) * Math.cos(lo), uy: Math.cos(la) * Math.sin(lo), uz: Math.sin(la) } }
let nEval = 0
function elAt(rec, o, tMs) {
  nEval++
  const d = new Date(tMs), pv = sat.propagate(rec, d); if (!pv || !pv.position) return -999
  const g = sat.gstime(d), cg = Math.cos(g), sg = Math.sin(g), p = pv.position
  const ex = p.x * cg + p.y * sg, ey = p.y * cg - p.x * sg, ez = p.z
  const rx = ex - o.ox, ry = ey - o.oy, rz = ez - o.oz, r = Math.hypot(rx, ry, rz)
  return Math.asin((rx * o.ux + ry * o.uy + rz * o.uz) / r) / D2R
}
function passesExtremum(rec, o, t0, t1, thr) {
  const P = 2 * Math.PI / rec.no * 60000, step = P / 16
  const ts = [], es = []
  for (let t = t0 - step; t <= t1 + step; t += step) { ts.push(t); es.push(elAt(rec, o, t)) }
  const out = []
  const GR = (Math.sqrt(5) - 1) / 2
  for (let i = 1; i < ts.length - 1; i++) {
    if (!(es[i] >= es[i - 1] && es[i] > es[i + 1])) continue
    let lo = ts[i - 1], hi = ts[i + 1], x1 = hi - GR * (hi - lo), x2 = lo + GR * (hi - lo), f1 = elAt(rec, o, x1), f2 = elAt(rec, o, x2)
    while (hi - lo > 500) { if (f1 < f2) { lo = x1; x1 = x2; f1 = f2; x2 = lo + GR * (hi - lo); f2 = elAt(rec, o, x2) } else { hi = x2; x2 = x1; f2 = f1; x1 = hi - GR * (hi - lo); f1 = elAt(rec, o, x1) } }
    const tp = (lo + hi) / 2, ep = elAt(rec, o, tp)
    if (ep < thr) continue
    let j = i; while (j > 0 && (ts[j] >= tp || es[j] >= thr)) j--
    let k = i; while (k < ts.length - 1 && (ts[k] <= tp || es[k] >= thr)) k++
    const bis = (a, b, up) => { for (let n = 0; n < 40 && b - a > 100; n++) { const m = (a + b) / 2; if ((elAt(rec, o, m) >= thr) === up) b = m; else a = m } return (a + b) / 2 }
    const aos = Math.max(t0, bis(ts[j], tp, true)), los = Math.min(t1, bis(tp, ts[k], false))
    if (los > aos) out.push({ aos, los, peak: ep })
  }
  return out
}
const ents = walker({ altKm: 550, incl: 53, P: 6, S: 22 })
const tgt = { lat: 39.9042, lon: 116.4074 }, o = obsOf(tgt.lat, tgt.lon)
const H = 72 * 3600, t0 = epoch.getTime(), t1 = t0 + H * 1000
for (const thr of [25, 40]) {
  nEval = 0
  const tA = performance.now()
  let nX = 0; const winsX = []
  for (const e of ents) { const w = passesExtremum(e.rec, o, t0, t1, thr); nX += w.length; for (const x of w) winsX.push({ startMin: (x.aos - t0) / 60000, endMin: (x.los - t0) / 60000 }) }
  const tB = performance.now()
  const truth = V.accessWindows(ents, [tgt], { now: epoch, ccNow: epoch }, H, thr, { coarseSec: 1 })
  let nT = 0; for (const s of truth) nT += s.windows.length
  const tcX = V.timeCoverage([{ windows: winsX }], H / 60), tcT = V.timeCoverage(truth, H / 60)
  console.log(`门限 ${thr}°：极值夹逼 过境 ${nX}（真值 ${nT}）；时间覆盖 ${tcX.pct.toFixed(3)}% vs ${tcT.pct.toFixed(3)}%；最长中断 ${tcX.maxGapMin.toFixed(2)} vs ${tcT.maxGapMin.toFixed(2)} min；传播次数 ${nEval}（生产 90 s 约 ${Math.round(ents.length * H / 90)}+精炼）；耗时 ${(tB - tA).toFixed(0)} ms`)
}
