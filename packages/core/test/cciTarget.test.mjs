// C/CCI 目标波束口径（packages/core/utils/interference/cciTarget.js）自测。运行：node packages/core/test/cciTarget.test.mjs
//
//   ① 七波束蜂窝（高斯主瓣、公共窗口）：目标 = 中心波束，同频 = 隔一取一的三个邻波束。
//      峰值点 C/CCI 与覆盖边界上的最差值由闭式【独立】算出（不经被测模块），引擎读数对得上；
//   ② 与复用方案页引擎（htsCoupling.cciPoints，二值着色、钉死服务波束）在最差点 / 峰值点逐点同值；
//   ③ 足迹：目标波束那一圈正好是「峰值 − X」等值线（反算回天线坐标，半径 = 闭式半径）；
//   ④ 窗外地板计数、覆盖区越出窗口、缺失波束、未选同频波束报错；
//   ⑤ 等值线拼链：闭合环与顶到网格边的开口链。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const T = require('../utils/interference/cciTarget.js')
const H = require('../utils/interference/htsCoupling.js')
const S = require('../utils/grdSampler.js')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); cond ? pass++ : fail++ }
const approx = (name, got, want, tol) => {
  const g = Number(got)
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol
  console.log((c ? 'PASS' : 'FAIL') + `  ${name}  (got=${Number.isFinite(g) ? g.toFixed(4) : g}, want≈${want.toFixed ? want.toFixed(4) : want} ±${tol})`)
  c ? pass++ : fail++
}
const lg = (x) => 10 * Math.log10(x)

// 高斯主瓣 G = peak − 12.0412·r²/θ3²（r 在天线 az/el 网格上），窗口 [cx ± win] × [cy ± win]
const TH3 = 0.6, PEAK = 40, K12 = 12.0412
function gaussBeam(az, el, cx, cy, win, nn) {
  const XS = cx - win, XE = cx + win, YS = cy - win, YE = cy + win, N = nn * nn
  const c1re = new Float32Array(N), z = new Float32Array(N)
  for (let r = 0; r < nn; r++) for (let c = 0; c < nn; c++) {
    const X = XS + (XE - XS) * c / (nn - 1), Y = YS + (YE - YS) * r / (nn - 1)
    const db = PEAK - K12 * ((X - az) ** 2 + (Y - el) ** 2) / (TH3 * TH3)
    c1re[r * nn + c] = Math.sqrt(Math.pow(10, Math.max(db, PEAK - 60) / 10))
  }
  return { grid: { XS, YS, XE, YE, NX: nn, NY: nn }, c1re, c1im: z, c2re: z, c2im: z }
}
const G = (dx, dy) => PEAK - K12 * (dx * dx + dy * dy) / (TH3 * TH3)
const SP = 0.866 * TH3
const centers = [[0, 0]]
for (let k = 0; k < 6; k++) centers.push([SP * Math.cos(k * Math.PI / 3), SP * Math.sin(k * Math.PI / 3)])
const sat = { lon: 110, lat: 0, alt: 35786 }, cfg = { boreType: 'geo', boreLon: 110, boreLat: 30 }
const runJob = (o) => { const r = T.createTargetRun({ sampler: S, sat, cfg, ...o }); let d = 0, guard = 0; while (d < r.T && guard++ < 1e6) d = r.stepBatch(997); return r.finalize() }

// ═══ ① 闭式 ═══
console.log('=== ① 七波束蜂窝 · 闭式 ===')
const common = { igrid: 6, icomp: 3, ncomp: 2, beams: centers.map(([az, el]) => gaussBeam(az, el, 0, 0, 2, 101)) }
const CO = [1, 3, 5]
const EOC = 4
const r1 = runJob({ loaded: common, target: 0, cochannel: CO, eocDb: EOC })
// 峰值点：G(0) − 10lg(3·G(SP))
const wantPeak = PEAK - lg(3 * Math.pow(10, G(SP, 0) / 10))
approx('峰值点 C/CCI = 闭式', r1.peak.cciDb, wantPeak, 0.05)
approx('峰值点目标增益 = 峰值', r1.peak.gainDb, PEAK, 0.02)
// 覆盖边界（半径 ρ：G(ρ) = PEAK − EOC）上逐角扫的最小值 —— 网格最差点只取得到圈内节点，故 ≥ 闭式、差不过半格的斜率
const RHO = Math.sqrt(EOC * TH3 * TH3 / K12)
let wantMin = Infinity
for (let a = 0; a < 3600; a++) {
  const t = a / 3600 * 2 * Math.PI, x = RHO * Math.cos(t), y = RHO * Math.sin(t)
  let s = 0
  for (const k of CO) s += Math.pow(10, G(x - centers[k][0], y - centers[k][1]) / 10)
  wantMin = Math.min(wantMin, G(x, y) - lg(s))
}
approx('覆盖区最差 C/CCI ≈ 闭式边界最小值', r1.stats.min, wantMin, 0.12)
ok('最差 ≤ 5% ≤ 中位 ≤ 峰值点', r1.stats.min <= r1.stats.p5 && r1.stats.p5 <= r1.stats.p50 && r1.stats.p50 <= r1.peak.cciDb + 1e-9)
ok('最差点读数 = 统计最小值', Math.abs(r1.worst.cciDb - r1.stats.min) < 1e-3, `${r1.worst.cciDb} vs ${r1.stats.min}`)
approx('最差点目标增益落在覆盖边缘内一格', PEAK - EOC - r1.worst.gainDb, 0, 0.15)
const shareSum = r1.worst.items.reduce((a, x) => a + x.sharePct, 0)
approx('最差点逐源占比合计 100%', shareSum, 100, 1e-6)
ok('最差点逐源按占比降序', r1.worst.items.every((x, i, a) => !i || a[i - 1].sharePct >= x.sharePct))
// 单项 C/I（逐源）：合成后 C/I = −10lg Σ 10^(−单项/10)
const recomb = -lg(r1.worst.items.reduce((a, x) => a + Math.pow(10, -x.ciDb / 10), 0))
approx('单项 C/I 合成回总 C/CCI', recomb, r1.worst.cciDb, 1e-6)
ok('逐源单项最差 ≥ 合成最差', r1.singles.every((s) => s.minDb >= r1.stats.min - 1e-9))
ok('公共窗口：无窗外地板、未越窗', r1.floorPts === 0 && r1.clipped === false)
ok('覆盖点数 > 1 万（细化网格）', r1.cover > 10000, `cover=${r1.cover} grid ${r1.grid.nx}×${r1.grid.ny}`)
ok('显示用经纬栅格有值、值域 = 统计范围', r1.field && r1.field.valid > 1000 && r1.field.min >= r1.stats.min - 0.05 && r1.field.max <= r1.peak.cciDb + 0.05)

// ═══ ② 与复用方案页引擎逐点同值 ═══
console.log('\n=== ② 与 htsCoupling 二值着色逐点同值 ===')
{
  const coloring = { 0: 0, 1: 0, 3: 0, 5: 0, 2: 1, 4: 2, 6: 3 }
  const pts = [r1.worst, r1.peak].map((p) => ({ lon: p.lon, lat: p.lat }))
  const ref = H.cciPoints({ sampler: S, loaded: common, sat, cfg, points: pts, servingIdx: 0, scheme: { source: 'manual', manual: { coloring } } })
  approx('最差点：两引擎同值（老口径取值按 0.01 dB 取整）', r1.worst.cciDb, ref.rows[0].cciDb, 0.02)
  approx('峰值点：两引擎同值', r1.peak.cciDb, ref.rows[1].cciDb, 0.02)
}

// ═══ ③ 足迹 ═══
console.log('\n=== ③ 足迹 = 峰值 − X 等值线 ===')
{
  const fp = T.beamFootprints({ sampler: S, loaded: common, sat, cfg, levelDb: EOC })
  ok('七个波束都有足迹与峰值落点', fp.beams.length === 7 && fp.beams.every((b) => b.rings.length >= 1 && b.peak))
  const ctx = S.makeSampleCtx(common, sat, cfg)
  const toGrid = (lon, lat) => {
    const P = H.geodeticToEcef(lon, lat, 0), Sv = ctx.basis.S
    let e = [P[0] - Sv[0], P[1] - Sv[1], P[2] - Sv[2]]
    const n = Math.hypot(...e); e = e.map((v) => v / n)
    const d = (b) => e[0] * b[0] + e[1] * b[1] + e[2] * b[2]
    return H.invGridDir(ctx.igrid, d(ctx.basis.x), d(ctx.basis.y), d(ctx.basis.z))
  }
  const ring = fp.beams[0].rings[0]
  let maxErr = 0, minAng = Infinity, maxAng = -Infinity
  const angs = []
  for (let i = 0; i < ring.length; i += 2) {
    const xy = toGrid(ring[i], ring[i + 1])
    maxErr = Math.max(maxErr, Math.abs(Math.hypot(xy[0], xy[1]) - RHO))
    angs.push(Math.atan2(xy[1], xy[0]))
  }
  angs.sort((a, b) => a - b)
  let gap = angs[0] + 2 * Math.PI - angs[angs.length - 1]
  for (let i = 1; i < angs.length; i++) gap = Math.max(gap, angs[i] - angs[i - 1])
  ok('目标足迹是一整圈多边形（抽稀后仍 ≥ 16 点、最大角缝 < 30°）', ring.length / 2 >= 16 && gap < Math.PI / 6, `${ring.length / 2} 点，最大角缝 ${(gap * 180 / Math.PI).toFixed(1)}°`)
  approx('目标足迹反算半径 = 闭式覆盖半径（误差上界）', maxErr, 0, 0.004)
  ok('目标足迹闭合', ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1])
  ok('每个波束的足迹都不止两个点', fp.beams.every((b) => b.rings.every((r) => r.length >= 32)))
  const pk = fp.beams[3].peak, xy = toGrid(pk.lon, pk.lat)
  approx('#4 峰值落点 = 波束中心（亚节点拟合）', Math.hypot(xy[0] - centers[3][0], xy[1] - centers[3][1]), 0, 0.003)
  approx('峰值读数', fp.beams[0].peakDb, PEAK, 0.01)
}

// ═══ ④ 窗外 / 越窗 / 缺失 / 报错 ═══
console.log('\n=== ④ 边界情形 ===')
{
  // 各波束只带自己的小窗口（±0.45°）：目标覆盖区多半落在干扰波束窗外 → 地板计入并计数
  const own = { igrid: 6, icomp: 3, ncomp: 2, beams: centers.map(([az, el]) => gaussBeam(az, el, az, el, 0.45, 61)) }
  const r = runJob({ loaded: own, target: 0, cochannel: CO, eocDb: EOC })
  ok('干扰波束窗外 → 地板计入并计数', r.floorPts > 0 && Number.isFinite(r.stats.min), `floorPts=${r.floorPts}`)
  ok('最差点逐源里标出窗外项', r.worst.items.some((x) => x.floored) || r.peak.items.some((x) => x.floored))
  const big = runJob({ loaded: own, target: 0, cochannel: CO, eocDb: 30 })
  ok('覆盖电平压到窗口边 → clipped', big.clipped === true)
  const miss = runJob({ loaded: common, target: 0, cochannel: [1, 99, 0, 1], eocDb: EOC })
  ok('缺失波束报出、目标与重复项剔除', JSON.stringify(miss.missing) === '[99]' && JSON.stringify(miss.cochannel) === '[1]')
  let err = ''
  try { T.createTargetRun({ sampler: S, loaded: common, sat, cfg, target: 0, cochannel: [] }) } catch (e) { err = e.message }
  ok('未选同频波束 → 报错', /同频/.test(err))
  err = ''
  try { T.createTargetRun({ sampler: S, loaded: common, sat, cfg, target: 42, cochannel: [1] }) } catch (e) { err = e.message }
  ok('目标波束不存在 → 报错', /目标波束/.test(err))
  // 存活波束裁剪（keptSets）：下标按原始 set 序号
  const kept = runJob({ loaded: common, cfg: { ...cfg, keptSets: [0, 1, 3, 5] }, target: 0, cochannel: [1, 3, 5, 2] })
  ok('keptSets 外的波束记为缺失', JSON.stringify(kept.missing) === '[2]' && Math.abs(kept.stats.min - r1.stats.min) < 1e-6)
}

// ═══ ⑤ 等值线拼链 ═══
console.log('\n=== ⑤ 等值线 ===')
{
  const NX = 41, NY = 41
  const circ = (i) => { const r = Math.floor(i / NX), c = i - r * NX; return -((c - 20) ** 2 + (r - 20) ** 2) }
  const L = T.isoLines(circ, NX, NY, -100)
  ok('圆：一条闭合环', L.length === 1 && L[0][0][0] === L[0][L[0].length - 1][0] && L[0][0][1] === L[0][L[0].length - 1][1])
  const rad = L[0].map(([c, r]) => Math.hypot(c - 20, r - 20))
  ok('圆：交点半径 ≈ 10（线性插值误差内）', rad.every((v) => Math.abs(v - 10) < 0.06))
  const edge = (i) => { const r = Math.floor(i / NX), c = i - r * NX; return -((c - 0) ** 2 + (r - 20) ** 2) }
  const E = T.isoLines(edge, NX, NY, -100)
  ok('贴边的半圆：一条开口链、两端在网格边上', E.length === 1 && E[0][0][0] === 0 && E[0][E[0].length - 1][0] === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
