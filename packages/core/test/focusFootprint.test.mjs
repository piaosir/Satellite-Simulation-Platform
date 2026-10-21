// 覆盖圈两种口径（src/viz/constellation/focusFootprint.js）：波束角与最低仰角画同一族 WGS84 等仰角线
//  ① 全视场（波束角留空）＝ WGS84 地平：整圈仰角恰为 0
//  ② 波束角圈与换算出的仰角圈逐点相同；最大波束角 / 超限 / 留空 与 0° 仰角逐点相同（同一采样，不是「差不多」）
//  ③ 锥角单调：B 越大圈越大（逐方位地心角不减），达到上限后停在地平上
//  ④ 上限 bMaxDeg＝地平张角方位平均的两倍；回写文本向上取整，写回再画仍是整圈地平
//  ⑤ 换算往返逐位可逆；等效锥角与圈上平均离天底角 ×2 相差在 0.012° 以内
//  ⑥ 切换口径画面不变：ε → B（全精度）再画，主选星的圈逐点不动
//  ⑦ 轨迹面全视场档：两缘落在地平上、轮廓不被自己的覆盖区裁掉
import * as W from '../../../src/viz/wgs84.js'
import { footprintRing, beamMaxDeg, beamLimitText, beamToElevDeg, elevToBeamDeg, coverElevDeg } from '../../../src/viz/constellation/focusFootprint.js'
import { swathK, sectionOf, buildSwath } from '../../../src/viz/constellation/focusSwath.js'
import { vecToLatLon } from '../../../src/viz/globe3d/focusLanes.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180
const CASES = [
  ['GEO 100°E', 100, 0, 35786],
  ['LEO 50°N', 0, 50, 550],
  ['LEO 极区', 30, 88, 780],
  ['Molniya 远地点', 60, 63, 39000],
  ['MEO 30°S', -120, -30, 20200]
]
const elevs = (S, ring) => ring.map((q) => W.elevationDeg(q.lon, q.lat, S))
const offNadir = (S, q) => {
  const P = W.geodeticToEcef(q.lon, q.lat, 0), r = Math.hypot(...S)
  const d = [P[0] - S[0], P[1] - S[1], P[2] - S[2]]
  return Math.acos(-(d[0] * S[0] + d[1] * S[1] + d[2] * S[2]) / (Math.hypot(...d) * r)) / DEG
}
const central = (S, q) => {
  const P = W.geodeticToEcef(q.lon, q.lat, 0)
  return Math.acos((P[0] * S[0] + P[1] * S[1] + P[2] * S[2]) / (Math.hypot(...P) * Math.hypot(...S))) / DEG
}
// 两条圈逐点最大差（°）；点数不同直接判不同
const ringDiff = (a, b) => {
  if (!a || !b || a.length !== b.length) return Infinity
  let m = 0
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k].lat - b[k].lat), Math.abs(a[k].lon - b[k].lon))
  return m
}

// —— ① 全视场 ＝ 地平 ——
for (const [nm, lon, lat, h] of CASES) {
  const S = W.geodeticToEcef(lon, lat, h)
  const el = elevs(S, footprintRing(S, h, 72, { mode: 'beam', beamDeg: '' }))
  const worst = Math.max(...el.map(Math.abs))
  ok(worst < 1e-3, `① ${nm}：全视场圈整圈落在地平（ε=0）`, `|ε| ≤ ${worst.toExponential(1)}°`)
}

// —— ② 两档同一条圈 ——
for (const [nm, lon, lat, h] of CASES) {
  const S = W.geodeticToEcef(lon, lat, h), bMax = beamMaxDeg(S)
  for (const seg of [72, 18]) {
    const e0 = footprintRing(S, h, seg, { mode: 'elev', elevDeg: 0 })
    const worst = Math.max(...['', bMax, beamLimitText(bMax), 400].map((B) => ringDiff(footprintRing(S, h, seg, { mode: 'beam', beamDeg: B }), e0)))
    ok(worst === 0, `② ${nm} seg=${seg}：最大波束角 / 上限文本 / 超限 / 留空 ≡ 0° 仰角（逐点）`, `差 ${worst}`)
  }
  let worst = 0
  for (const f of [0.3, 0.6, 0.9, 0.99]) {
    const B = bMax * f
    worst = Math.max(worst, ringDiff(footprintRing(S, h, 72, { mode: 'beam', beamDeg: B }), footprintRing(S, h, 72, { mode: 'elev', elevDeg: beamToElevDeg(S, B) })))
  }
  ok(worst === 0, `② ${nm}：波束角圈 ≡ 换算仰角的等仰角圈`, `差 ${worst}`)
}

// —— ③ 单调、超限停在地平 ——
{
  const S = W.geodeticToEcef(100, 0, 35786), h = 35786
  const Bs = [16, 17, 17.2, 17.3, 17.35, 17.37, 17.38, 17.39, 17.4, 17.41, 18, 25, 90, 179.9, 400]
  let prev = null, worst = 0
  for (const B of Bs) {
    const lam = footprintRing(S, h, 72, { mode: 'beam', beamDeg: B }).map((q) => central(S, q))
    if (prev) for (let k = 0; k < lam.length; k++) worst = Math.min(worst, lam[k] - prev[k])
    prev = lam
  }
  ok(worst > -1e-9, '③ GEO：B 从 16° 加到 400°，逐方位地心角只增不减', `最大回缩 ${(-worst).toExponential(1)}°`)
  const el = elevs(S, footprintRing(S, h, 72, { mode: 'beam', beamDeg: 30 }))
  ok(Math.max(...el.map(Math.abs)) < 1e-3, '③ GEO B=30°（超出上限）＝ 整圈地平')
}

// —— ④ 上限 ——
{
  const S = W.geodeticToEcef(100, 0, 35786), lim = {}
  footprintRing(S, 35786, 72, { mode: 'beam', beamDeg: 30 }, lim)
  ok(lim.bMaxDeg > 17.37 && lim.bMaxDeg < 17.38 && Math.abs(lim.bMaxDeg - beamMaxDeg(S)) < 1e-12, '④ GEO 上限＝地平张角方位平均 ×2', `${lim.bMaxDeg.toFixed(4)}°`)
  ok(lim.clampText === '17.38' && Number(lim.clampText) >= lim.bMaxDeg, '④ 回写文本向上取到 0.01°', lim.clampText)
  const el = elevs(S, footprintRing(S, 35786, 72, { mode: 'beam', beamDeg: lim.clampText }))
  ok(Math.max(...el.map(Math.abs)) < 1e-3, '④ 写回的上限值再画一遍仍是整圈地平')
  const lim2 = {}
  footprintRing(S, 35786, 72, { mode: 'beam', beamDeg: 17 }, lim2)
  ok(lim2.clampText === null, '④ 未超限不回写')
  ok(beamLimitText(17.4) === '17.40' && beamLimitText(17.40001) === '17.41', '④ beamLimitText 边界')
}

// —— ⑤ 换算 ——
for (const [nm, lon, lat, h] of CASES) {
  const S = W.geodeticToEcef(lon, lat, h)
  let rt = 0, eq = 0
  for (const e of [0.5, 2, 5, 10, 30, 60, 85]) {
    const B = elevToBeamDeg(S, e)
    rt = Math.max(rt, Math.abs(beamToElevDeg(S, B) - e), Math.abs(elevToBeamDeg(S, beamToElevDeg(S, B)) - B))
    const ring = W.isoElevationContourAt(S, e, 360).slice(0, -1).map(([lo, la]) => ({ lon: lo, lat: la }))
    eq = Math.max(eq, Math.abs(B - 2 * ring.reduce((s, q) => s + offNadir(S, q), 0) / ring.length))
  }
  ok(rt < 1e-9, `⑤ ${nm}：ε ↔ B 往返可逆`, `${rt.toExponential(1)}°`)
  ok(eq < 0.012, `⑤ ${nm}：等效锥角 ≈ 圈上平均离天底角 ×2`, `最大差 ${eq.toFixed(4)}°`)
}
{
  const S = W.geodeticToEcef(100, 0, 35786)
  ok(beamToElevDeg(S, '') === 0 && beamToElevDeg(S, 20) === 0 && beamToElevDeg(S, 0) === 0, '⑤ 全视场 / 超限 / 0 → ε=0')
  ok(elevToBeamDeg(S, 0) === null && elevToBeamDeg(S, '') === null, '⑤ ε=0 → 留空（全视场）')
  const e = beamToElevDeg(S, 1e-6)
  ok(e > 89.99 && e < 90, '⑤ 极小锥角 → 仰角趋近但小于 90°（不被当成越界的 0°）', `${e}`)
  ok(coverElevDeg(S, { mode: 'elev', elevDeg: 7 }) === 7 && coverElevDeg(S, { mode: 'beam', beamDeg: 17 }) === beamToElevDeg(S, 17), '⑤ coverElevDeg 按口径取')
}

// —— ⑥ 切换口径画面不变 ——
for (const [nm, lon, lat, h] of CASES) {
  const S = W.geodeticToEcef(lon, lat, h)
  let worst = 0
  for (const e of [1, 5, 10, 30]) {
    const a = footprintRing(S, h, 72, { mode: 'elev', elevDeg: e })
    const b = footprintRing(S, h, 72, { mode: 'beam', beamDeg: elevToBeamDeg(S, e) })
    worst = Math.max(worst, ringDiff(a, b))
  }
  ok(worst < 1e-6, `⑥ ${nm}：仰角圈切到波束角（全精度换算）逐点不动`, `${worst.toExponential(1)}°`)
}

// —— ⑦ 轨迹面全视场档 ——
{
  const fp = { mode: 'beam', beamDeg: '' }, h = 550, K = swathK(h, fp)
  const pts = [[0, 0], [3, 0.5], [6, 1], [9, 1.5]].map(([lat, lon]) => ({ lat, lon, h, az: 10 * DEG }))
  const secs = pts.map((q) => sectionOf(q, fp, K))
  const sw = buildSwath(pts, secs, K, fp, 72, { fpOn: false })
  const S = pts.map((q) => W.geodeticToEcef(q.lon, q.lat, q.h))
  let n = 0, worst = 0
  for (const ln of sw.lines) for (let k = 0; k < ln.length / 3; k++) {
    const [la, lo] = vecToLatLon(ln[k * 3], ln[k * 3 + 1], ln[k * 3 + 2])
    let m = -90
    for (const s of S) m = Math.max(m, W.elevationDeg(lo, la, s))
    worst = Math.max(worst, Math.abs(m)); n++
  }
  ok(sw.lines.length === 4 && n > 40, '⑦ 轮廓 = 两缘 + 两段端帽弧（没被自己的覆盖区裁掉）', `${sw.lines.length} 段 ${n} 点`)
  ok(worst < 0.08, '⑦ 轮廓点全在扫过区域的地平边界上', `最大 |ε| ${worst.toFixed(4)}°`)
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
