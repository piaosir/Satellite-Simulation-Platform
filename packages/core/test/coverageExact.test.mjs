// 可见性「覆盖」区间精确 FOM（差距分析 B-01）+ 覆盖网格 / Polygon 质心跨日界线（B-02）自测。
// 运行：node packages/core/test/coverageExact.test.mjs
// 被测：src/viz/vis/coverageGrid.js（makeCoverageGrid / createCoverageRun）、src/viz/vis/visibility.js（ringCentroid）、src/viz/vis/useVisibility.js（Polygon 目标）。
//
// 钉死的事：
//   ① B-02 网格：170°E → 170°W、0–20°N 的 Polygon 按 2° 网格 = 100 格（修前算成另一侧 340° 宽的补集 1700 格）= 同尺寸不跨线的 Polygon；
//      自定义边界 lonMin > lonMax 视为跨日界线（修前 0 格）；全球 / 普通边界格数不变。
//   ② B-02 质心：跨日界线那块的代表点 (180°, 9.95°N)（修前顶点均值落到 (0°, 10°N) 地球另一面）；南海 U 形 (115.46°E, 13.86°N)（修前偏约 300 km）；
//      与建链模块 pgCentroid 逐位相同；可见性 Polygon 目标就是它。
//   ③ B-01 覆盖区间精确：与同一球冠判据的 1 s 暴力（翻转处真传播二分到 1 ms）逐格逐段对上 —— 段数、起止（≤ 0.05 s）、
//      时间覆盖 / 访问次数 / 最大重访 / 平均间隔；60 s 采样之间完整掠过的短过境一个不丢。
//   ④ B 路量级：北京 1° 格、132 颗 Walker、25°、24 h、60 s 采样：访问次数 168、最大重访 ≈ 3.18 min（WGS-84 1 s 真值 168 / 3.18；
//      修前按采样计数 119 / 4.00）。
//   ⑤ 时窗不是步长整数倍：末尾补一拍落在时窗终点，覆盖率分母 = 时窗原值；最短可检出过境时长随采样步长平方缩小。
import sat from '../../../src/viz/constellation/satellite.js'
import { posAt } from '../../../src/viz/constellation/satPos.js'
import { makeCoverageGrid, createCoverageRun } from '../../../src/viz/vis/coverageGrid.js'
import { ringCentroid, accessWindows, timeCoverage } from '../../../src/viz/vis/visibility.js'
import { useVisibility } from '../../../src/viz/vis/useVisibility.js'
import { pgRing, pgCentroid } from '../models/mapLinkPoints.mjs'

let pass = 0, fail = 0
const ok = (name, cond, info) => {
  if (cond) { pass++; console.log('PASS  ' + name + (info != null ? '  (' + info + ')' : '')) } else { fail++; console.log('FAIL  ' + name + (info != null ? '  (' + info + ')' : '')) }
}
const DEG = Math.PI / 180, MU = 398600.4418, RE = 6378.137
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
const times = { now: epoch, ccNow: epoch }

// ══════════════ ① B-02 网格跨日界线 ══════════════
{
  const lonsOf = (g) => [...new Set(g.cells.map((c) => Math.round(c.lon * 1e6) / 1e6))].sort((a, b) => a - b)
  const gx = makeCoverageGrid({ kind: 'poly', poly: [[170, 0], [-170, 0], [-170, 20], [170, 20]] }, 2)
  const gn = makeCoverageGrid({ kind: 'poly', poly: [[150, 0], [170, 0], [170, 20], [150, 20]] }, 2)
  const gb = makeCoverageGrid({ kind: 'bounds', latMin: 0, latMax: 20, lonMin: 170, lonMax: -170 }, 2)
  const gw = makeCoverageGrid({ kind: 'poly', poly: [[-170, 0], [-170, 20], [170, 20], [170, 0]] }, 2)   // 从西半球起、反绕向
  ok('① 跨日界线 Polygon（170°E→170°W、0–20°N、2°）= 100 格', gx.cells.length === 100, gx.cells.length + ' 格')
  ok('① = 同尺寸不跨线的 Polygon 格数', gn.cells.length === gx.cells.length, gn.cells.length + ' 格')
  ok('① 自定义边界 lonMin 170 > lonMax −170 视为跨日界线 = 100 格', gb.cells.length === 100, gb.cells.length + ' 格')
  ok('① 顶点从西半球起、反绕向也是 100 格', gw.cells.length === 100, gw.cells.length + ' 格')
  const want = []; for (let x = 171; x <= 179; x += 2) want.push(x); for (let x = -179; x <= -171; x += 2) want.push(x); want.sort((a, b) => a - b)
  ok('① 格心经度 = 171…179、−179…−171（经度归一到 ±180），三种写法一致', [gx, gb, gw].every((g) => JSON.stringify(lonsOf(g)) === JSON.stringify(want)))
  ok('① 格心经度与不跨线那块整体差 20°', JSON.stringify(lonsOf(gn).map((x) => ((x + 20 + 540) % 360) - 180).sort((a, b) => a - b)) === JSON.stringify(want))
  ok('① 全球 2° 格数不变（180 × 90 = 16200）', makeCoverageGrid({ kind: 'global' }, 2).cells.length === 16200)
  ok('① 普通边界（80–140°E、20–55°N、5°）格数不变（12 × 7 = 84）', makeCoverageGrid({ kind: 'bounds', latMin: 20, latMax: 55, lonMin: 80, lonMax: 140 }, 5).cells.length === 84)
  const tri = makeCoverageGrid({ kind: 'poly', poly: [[100, 0], [120, 0], [110, 20]] }, 1)
  ok('① 普通三角形 Polygon：格心都在区内（边按经纬度线性），格数 ≈ 面积/格面积', tri.cells.length >= 190 && tri.cells.length <= 210 && tri.cells.every((c) => c.lat < 20 && c.lat > 0 && c.lon > 100 && c.lon < 120), tri.cells.length + ' 格')
  ok('① 顶点无效（不足 3 个有效点）→ 0 格', makeCoverageGrid({ kind: 'poly', poly: [[100, 0], [NaN, 5], [110, 95]] }, 1).cells.length === 0)
}

// ══════════════ ② B-02 Polygon 质心 ══════════════
{
  const dl = [[170, 0], [-170, 0], [-170, 20], [170, 20]]
  const scs = [[108, 18], [109, 17], [109.5, 16], [110, 15], [110.5, 14], [111, 13], [111.5, 12], [112, 11], [112.5, 10], [113, 9], [117, 4], [120, 12], [120, 21]]
  const c1 = ringCentroid(dl), c2 = ringCentroid(scs)
  const p1 = pgCentroid(pgRing(dl)), p2 = pgCentroid(pgRing(scs))
  ok('② 跨日界线：质心 (180°, 9.95°N)（修前顶点均值 (0°, 10°N)）', c1 && Math.abs(Math.abs(c1.lon) - 180) < 1e-9 && Math.abs(c1.lat - 9.95) < 0.01, c1 && `${c1.lon.toFixed(4)}, ${c1.lat.toFixed(4)}`)
  ok('② 南海 U 形：质心 (115.46°E, 13.86°N)', c2 && Math.abs(c2.lon - 115.46) < 0.01 && Math.abs(c2.lat - 13.86) < 0.01, c2 && `${c2.lon.toFixed(4)}, ${c2.lat.toFixed(4)}`)
  ok('② 与建链模块 pgCentroid 逐位相同', c1.lat === p1.lat && c1.lon === p1.lon && c2.lat === p2.lat && c2.lon === p2.lon)
  const objPts = scs.map(([lon, lat]) => ({ lat, lon }))
  const c3 = ringCentroid(objPts)
  ok('② 顶点写成 {lat, lon} 对象同结果', c3 && c3.lat === c2.lat && c3.lon === c2.lon)
  const vis = useVisibility({
    getStations: () => [], getPoints: () => [], getTrajectories: () => [], getPolys: () => [{ id: 'p1', name: '太平洋', pts: dl }],
    getSatSet: () => [], calcAt: () => epoch, ccTimeAt: (t) => t, isCustomEntry: () => false, refresh: () => {}
  })
  vis.setTarget('poly', 'p1')
  const tp = vis.targetPoints()
  ok('② 可见性 Polygon 目标 = 面积质心（不再落到地球另一面）', tp.length === 1 && Math.abs(Math.abs(tp[0].lon) - 180) < 1e-9 && Math.abs(tp[0].lat - 9.95) < 0.01, tp.length && `${tp[0].lon}, ${tp[0].lat.toFixed(4)}`)
}

// ══════════════ 共用：Walker 星座、同一球冠判据的 1 s 暴力 ══════════════
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI), out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) out.push({ rec: sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 }), name: 'W' + p + '-' + s, noradId: 900000 + p * 100 + s, group: 'w', _cc: false })
  return out
}
// 球冠判据的余量（与覆盖核同式：大地星下点单位向量 · 格心单位向量 − cos λ，λ = acos(Re/(Re+h)·cos ε) − ε）
function capMargin(rec, cv, epsDeg, tMs) {
  const d = new Date(tMs), pv = posAt(rec, d)
  if (!pv) return -9
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(d))
  const ca = RE / (RE + gd.height) * Math.cos(epsDeg * DEG)
  if (!(ca < 1)) return -9
  const lam = Math.acos(ca) - epsDeg * DEG
  if (!(lam > 0)) return -9
  const cl = Math.cos(gd.latitude)
  return cl * Math.cos(gd.longitude) * cv[0] + cl * Math.sin(gd.longitude) * cv[1] + Math.sin(gd.latitude) * cv[2] - Math.cos(lam)
}
// 一批格 × 一批星的 1 s 暴力：每颗星每秒的星下点只算一遍（Float32 缓存），翻转处用真传播二分到 1 ms；返回各格的并集区间（相对秒）与 1 s 拍上的最大重数
function bruteCells(ents, cells, epsDeg, H) {
  const t0 = epoch.getTime(), n = H + 1
  const cvs = cells.map((c) => [Math.cos(c.lat * DEG) * Math.cos(c.lon * DEG), Math.cos(c.lat * DEG) * Math.sin(c.lon * DEG), Math.sin(c.lat * DEG)])
  const per = cells.map(() => [])
  const cnt = cells.map(() => new Uint16Array(n))
  const sx = new Float32Array(n), sy = new Float32Array(n), sz = new Float32Array(n), scl = new Float32Array(n)
  for (const e of ents) {
    for (let k = 0; k < n; k++) {
      const d = new Date(t0 + k * 1000), pv = posAt(e.rec, d)
      const gd = sat.eciToGeodetic(pv.position, sat.gstime(d))
      const ca = RE / (RE + gd.height) * Math.cos(epsDeg * DEG), lam = Math.acos(Math.min(1, ca)) - epsDeg * DEG
      const cl = Math.cos(gd.latitude)
      sx[k] = cl * Math.cos(gd.longitude); sy[k] = cl * Math.sin(gd.longitude); sz[k] = Math.sin(gd.latitude); scl[k] = lam > 0 ? Math.cos(lam) : 2
    }
    cells.forEach((c, ci) => {
      const cv = cvs[ci], f = (tMs) => capMargin(e.rec, cv, epsDeg, tMs)
      const bis = (a, b, aIn) => { for (let i = 0; i < 40 && b - a > 1; i++) { const m = (a + b) / 2; if ((f(m) >= 0) === aIn) a = m; else b = m } return (aIn ? a : b) }
      let prevIn = false, start = null
      for (let k = 0; k < n; k++) {
        const m = sx[k] * cv[0] + sy[k] * cv[1] + sz[k] * cv[2] - scl[k], inn = m >= 0
        if (inn) cnt[ci][k]++
        if (k === 0) { prevIn = inn; if (inn) start = t0; continue }
        if (inn && !prevIn) start = bis(t0 + (k - 1) * 1000, t0 + k * 1000, false)
        else if (!inn && prevIn) { per[ci].push([start, bis(t0 + (k - 1) * 1000, t0 + k * 1000, true)]); start = null }
        prevIn = inn
      }
      if (prevIn) per[ci].push([start, t0 + H * 1000])
    })
  }
  return per.map((iv, ci) => {
    iv.sort((a, b) => a[0] - b[0])
    const u = []
    for (const [a, b] of iv) { const L = u[u.length - 1]; if (L && a <= L[1] + 1) { if (b > L[1]) L[1] = b } else u.push([a, b]) }
    let maxN = 0; for (let k = 0; k < n; k++) if (cnt[ci][k] > maxN) maxN = cnt[ci][k]
    return { iv: u.map(([a, b]) => [(a - t0) / 1000, (b - t0) / 1000]), maxN }
  })
}
const fomOf = (iv, H) => {
  let cov = 0, maxGap = 0, gapSum = 0, gapN = 0, cur = 0, first = true
  for (const [a, b] of iv) { const g = a - cur; if (first ? g > 1e-3 : g > 1e-3) { maxGap = Math.max(maxGap, g); gapSum += g; gapN++ } cov += b - a; cur = b; first = false }
  if (H - cur > 1e-3) { maxGap = Math.max(maxGap, H - cur); gapSum += H - cur; gapN++ }
  return { pct: cov / H * 100, count: iv.length, revisit: maxGap / 60, avggap: gapN ? gapSum / gapN / 60 : 0 }
}

// ══════════════ ③ 区间精确：逐格逐段对 1 s 暴力 ══════════════
for (const [label, cfg, H, epsDeg, cellsLL] of [
  ['24 颗 850 km / 45°（物联网量级）· 24 h · 20°', { altKm: 850, incl: 45, P: 4, S: 6 }, 24 * 3600, 20, [[20.04, 110.32], [39.9, 116.4], [-10, 30], [0.5, -150], [44, 179.5], [30, -60]]],
  ['132 颗 550 km / 53° · 6 h · 40°', { altKm: 550, incl: 53, P: 6, S: 22 }, 6 * 3600, 40, [[39.9, 116.4], [22.3, 114.2], [-33.9, 151.2], [10, -170], [51.5, -0.1]]]
]) {
  const ents = walker(cfg)
  const cells = cellsLL.map(([lat, lon]) => ({ lat, lon }))
  const grid = { cells, step: 1 }
  const run = createCoverageRun(ents, grid, times, { horizonSec: H, minElevDeg: epsDeg, sampleSec: 60, traceCells: cells.map((_, i) => i) })
  run.stepBatch(1e9)
  const r = run.finalize()
  const br = bruteCells(ents, cells, epsDeg, H)
  let segs = 0, segOk = 0, worst = 0, fomBad = [], short = 0, shortOk = 0
  cells.forEach((c, i) => {
    const mine = r.trace[i], ref = br[i].iv
    segs += ref.length
    for (const [a, b] of ref) {
      const m = mine.find(([x, y]) => x < b + 0.5 && y > a - 0.5)
      if (b - a < 60) { short++; if (m) shortOk++ }
      if (m && Math.abs(m[0] - a) < 0.05 && Math.abs(m[1] - b) < 0.05) segOk++
      if (m) worst = Math.max(worst, Math.abs(m[0] - a), Math.abs(m[1] - b))
    }
    const F = fomOf(ref, H)
    const mineF = { pct: r.fom.percent[i], count: r.fom.count[i], revisit: r.fom.revisit[i], avggap: r.fom.avggap[i] }
    if (mine.length !== ref.length || mineF.count !== F.count || Math.abs(mineF.pct - F.pct) > 0.001 || Math.abs(mineF.revisit - F.revisit) > 0.002 || Math.abs(mineF.avggap - F.avggap) > 0.002 || r.fom.nasset[i] < br[i].maxN || r.fom.nasset[i] > br[i].maxN + 1) {
      fomBad.push(`(${c.lat},${c.lon}) 段 ${mine.length}/${ref.length} 次 ${mineF.count}/${F.count} 覆盖 ${mineF.pct.toFixed(4)}/${F.pct.toFixed(4)} 重访 ${mineF.revisit.toFixed(3)}/${F.revisit.toFixed(3)} 重数 ${r.fom.nasset[i]}/${br[i].maxN}`)
    }
  })
  ok(`③ ${label}：每段起止与 1 s 暴力差 ≤ 0.05 s`, segOk === segs && segs > 20, `${segOk} / ${segs} 段，最大差 ${(worst * 1000).toFixed(1)} ms`)
  ok(`③ ${label}：短于 60 s 采样步长的段一个不丢`, shortOk === short, `${shortOk} / ${short} 段`)
  ok(`③ ${label}：逐格 FOM（段数 / 访问次数 / 时间覆盖 / 最大重访 / 平均间隔 / 最大重数）= 暴力`, fomBad.length === 0, fomBad.join('；') || `${cells.length} 格`)
}

// ══════════════ ④ B 路量级：北京 1° 格 · 132 颗 · 25° · 24 h · 60 s ══════════════
{
  const ents = walker({ altKm: 550, incl: 53, P: 6, S: 22 })
  const grid = makeCoverageGrid({ kind: 'bounds', latMin: 39.5, latMax: 40.5, lonMin: 116, lonMax: 117 }, 1)
  const run = createCoverageRun(ents, grid, times, { horizonSec: 24 * 3600, minElevDeg: 25, sampleSec: 60 })
  run.stepBatch(1e9)
  const r = run.finalize()
  // WGS-84 仰角口径的真值（唯一访问引擎 = 1 s 暴力同值，见 accessEngine.test.mjs）
  const truth = accessWindows(ents, [grid.cells[0]], times, 24 * 3600, 25)
  const tc = timeCoverage(truth, 24 * 60)
  const iv = []; for (const s of truth) for (const w of s.windows) iv.push([w.startMin, w.endMin]); iv.sort((a, b) => a[0] - b[0])
  let merged = 0, cur = -1; for (const [a, b] of iv) { if (a > cur) { merged++; cur = b } else if (b > cur) cur = b }
  const avgT = (24 * 60 - tc.coveredMin) / tc.gapCount
  ok('④ 北京 1° 格：访问次数 168（WGS-84 1 s 真值 168；修前按采样计数 119）', r.fom.count[0] === 168 && merged === 168, `覆盖核 ${r.fom.count[0]} · 真值 ${merged}`)
  ok('④ 最大重访 ≈ 3.18 min（真值 3.18；修前 4.00）、平均间隔 ≈ 1.20 min（修前 1.71），差异只来自球冠 vs WGS-84 判据（< 0.05 / 0.01 min）',
    Math.abs(r.fom.revisit[0] - tc.maxGapMin) < 0.05 && Math.abs(r.fom.avggap[0] - avgT) < 0.01,
    `最大重访 ${r.fom.revisit[0].toFixed(3)} vs ${tc.maxGapMin.toFixed(3)} · 平均间隔 ${r.fom.avggap[0].toFixed(3)} vs ${avgT.toFixed(3)} min`)
  ok('④ 时间覆盖与 WGS-84 真值差 < 0.1 pp（球冠判据口径差）', Math.abs(r.fom.percent[0] - tc.pct) < 0.1, `${r.fom.percent[0].toFixed(3)}% vs ${tc.pct.toFixed(3)}%`)
}

// ══════════════ ⑤ 时窗非整数倍 / 最短可检出过境时长 ══════════════
{
  const ents = walker({ altKm: 850, incl: 45, P: 4, S: 6 })
  const cells = [{ lat: 20.04, lon: 110.32 }]
  const r1 = createCoverageRun(ents, { cells, step: 1 }, times, { horizonSec: 1000, minElevDeg: 10, sampleSec: 60 })
  ok('⑤ 时窗 1000 s、步长 60 s：采样 18 拍（末拍落在 1000 s）', r1.T === 18)
  r1.stepBatch(1e9)
  const f1 = r1.finalize()
  const b1 = bruteCells(ents, cells, 10, 1000)[0]
  ok('⑤ 覆盖率分母 = 时窗原值（与 1 s 暴力同值）', Math.abs(f1.fom.percent[0] - fomOf(b1.iv, 1000).pct) < 0.001, `${f1.fom.percent[0].toFixed(4)}% vs ${fomOf(b1.iv, 1000).pct.toFixed(4)}%`)
  const md = (s) => { const r = createCoverageRun(ents, { cells, step: 1 }, times, { horizonSec: 3600, minElevDeg: 10, sampleSec: s }); r.stepBatch(1e9); return r.finalize().minDetectSec }
  const m60 = md(60), m30 = md(30)
  ok('⑤ 最短可检出过境时长：60 s 采样亚秒级，减半步长约降为 1/4', m60 > 0.1 && m60 < 1.5 && Math.abs(m60 / m30 - 4) < 0.5, `${m60.toFixed(3)} s → ${m30.toFixed(3)} s`)
}

console.log(`\ncoverageExact: ${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
