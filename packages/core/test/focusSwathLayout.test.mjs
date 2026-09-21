// 轨迹面（覆盖带）的退化处理（src/viz/constellation/focusSwath.js：swathLayout / swathDiscs / emitSwath3D / swathFlatGeom）
//  ① 航向掉头：相邻横断面左右缘互换 → 翻回来，两缘不再在带的两侧跳
//  ② 平滑平移轨迹：全是平移步，出图与直接 swathFill / swathEdges 逐位相同（普通 LEO 画面不变）
//  ③ GEO 原地抖动：整轨归为一个打转 run → 一个覆盖圆盘、零边线；描轮廓档轮廓落在覆盖圈半径上
//  ④ 急转（内缘后退）：该步为打转步，带在此断开、落一个盘；2D 数据的 skip / 两缘折线随之切开
//  ⑤ Worker 池整条链：2D 打包字段齐全，覆盖圈层开/关切换轮廓
import sat from '../../../src/viz/constellation/satellite.js'
import { headingAz, swathK, sectionOf, swathLayout, swathDiscs, emitSwath3D, swathFlatGeom, swathEdgePolylines } from '../../../src/viz/constellation/focusSwath.js'
import { llaToVec, vecToLatLon, swathFill, swathEdges, pushDashed, densifyArc, createSink, FILL_R } from '../../../src/viz/globe3d/focusLanes.js'
import { createFocusGeomPool } from '../../../src/viz/constellation/focusGeomPool.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))))) / DEG
const same = (s1, s2) => s1.n === s2.n && s1.a.subarray(0, s1.n).every((v, i) => v === s2.a[i])
const sec = (lat, lon, h, azDeg, fp, K) => sectionOf({ lat, lon, h, az: azDeg * DEG }, fp, K)

// —— ① 航向掉头 ——
{
  const fp = { mode: 'elev', elevDeg: 10 }, h = 780, K = swathK(h, fp)
  const secs = [sec(0, 0, h, 0, fp, K), sec(0.05, 0, h, 180, fp, K)]
  const lay = swathLayout(secs, K)
  const L0 = { x: lay.secs[0][0], y: lay.secs[0][1], z: lay.secs[0][2] }, L1 = { x: lay.secs[1][0], y: lay.secs[1][1], z: lay.secs[1][2] }
  const R0 = { x: lay.secs[0][K * 3], y: lay.secs[0][K * 3 + 1], z: lay.secs[0][K * 3 + 2] }
  ok(lay.rev[1] === 1 && angDeg(L1, L0) < angDeg(L1, R0), '① 掉头的断面被翻回来，左缘仍在同一侧', `左-左 ${angDeg(L1, L0).toFixed(3)}° 左-右 ${angDeg(L1, R0).toFixed(3)}°`)
  const fg = swathFlatGeom(lay, [], false)
  ok(fg.swL.length === 1 && fg.swL[0].length === 2 && Math.abs(fg.swL[0][0].lon - fg.swL[0][1].lon) < 0.5, '① 2D 左缘折线两点同侧', fg.swL[0].map((p) => p.lon.toFixed(2)).join(' / '))
}

// —— ② 平滑平移：出图逐位不变 ——
{
  const fp = { mode: 'elev', elevDeg: 5 }, h = 550, K = swathK(h, fp)
  const secs = [[0, 0], [3, 0.5], [6, 1], [9, 1.5]].map(([la, lo]) => sec(la, lo, h, 10, fp, K))
  const lay = swathLayout(secs, K)
  ok(lay.spans.length === 1 && lay.spans[0][0] === 0 && lay.spans[0][1] === 3 && lay.runs.length === 0 && !lay.allRot && Array.from(lay.kind).every((k) => k === 1), '② 全是平移步，一段 span', JSON.stringify(lay.spans))
  const fA = createSink(64), eA = createSink(64)
  swathFill(secs, K, fA)
  const [L, R] = swathEdges(secs, K); pushDashed(eA, densifyArc(L), 'solid'); pushDashed(eA, densifyArc(R), 'solid')
  const fB = createSink(64), eB = createSink(64)
  emitSwath3D(lay, swathDiscs(lay, [], fp, 72), { edge: eB, fill: fB, dash: 'solid', outlineOn: false })
  ok(fA.n > 0 && same(fA, fB) && same(eA, eB), '② 带面与两缘与直接 swathFill / swathEdges 逐位相同', `${fA.n} / ${eA.n} 个数`)
}

// —— ③ GEO 原地抖动 ——
const EPOCH = new Date(); EPOCH.setHours(8, 0, 0, 0)
const geo = sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH.toISOString(), meanMotion: 1.0027, ecc: 0, incl: 0, raan: (22 + sat.gstime(EPOCH) / DEG) % 360, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
const FP = { mode: 'elev', beamDeg: NaN, elevDeg: 45 }
{
  const t0 = Date.now(), per = 1436.1 * 60000, N = 120
  const pts = [], secs = []
  const K = swathK(35786, FP)
  for (let i = 0; i <= N; i++) {
    const t = new Date(t0 + per * i / N), pv = sat.propagate(geo, t), g = sat.gstime(t)
    const gd = sat.eciToGeodetic(pv.position, g)
    const q = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), h: gd.height, az: headingAz(pv, g) }
    pts.push(q); secs.push(sectionOf(q, FP, K))
  }
  const lay = swathLayout(secs, K)
  ok(lay.allRot && lay.runs.length === 1 && lay.spans.length === 0, '③ 整轨归为一个打转 run', `runs ${JSON.stringify(lay.runs)} spans ${lay.spans.length}`)
  const discs = swathDiscs(lay, pts, FP, 72)
  ok(discs.length === 1, '③ 只落一个覆盖圆盘', `${discs.length} 个`)
  const fill = createSink(64), edge = createSink(64)
  emitSwath3D(lay, discs, { edge, fill, dash: 'solid', outlineOn: false })
  ok(edge.n === 0 && fill.n > 0, '③ 覆盖圈层开着：零边线、只有圆盘填充', `edge ${edge.n} fill ${fill.n}`)
  // 圆盘半径 = 该口径的覆盖半宽（与瞬时覆盖圈同源）
  const c = llaToVec(discs[0].lat, discs[0].lon, 0)
  let rMax = 0, rMin = 180
  for (let i = 0; i < fill.n; i += 3) { const a = angDeg(c, { x: fill.a[i], y: fill.a[i + 1], z: fill.a[i + 2] }); rMax = Math.max(rMax, a); if (a > 1e-6) rMin = Math.min(rMin, a) }
  ok(rMax > 38 && rMax < 40, '③ 圆盘半径 ≈ GEO 45° 仰角覆盖半宽（≈38.9°）', `${rMax.toFixed(2)}°`)
  const edge2 = createSink(64)
  emitSwath3D(lay, discs, { edge: edge2, fill: null, dash: 'solid', outlineOn: true })
  let eMin = 180, eMax = 0
  for (let i = 0; i < edge2.n; i += 3) { const a = angDeg(c, { x: edge2.a[i], y: edge2.a[i + 1], z: edge2.a[i + 2] }); eMin = Math.min(eMin, a); eMax = Math.max(eMax, a) }
  ok(edge2.n > 0 && eMin > 38 && eMax < 40, '③ 覆盖圈层关着：轮廓整圈落在覆盖圈半径上', `${eMin.toFixed(2)}°~${eMax.toFixed(2)}°`)
  const fg = swathFlatGeom(lay, discs, true)
  ok(fg.swL.length === 0 && fg.swR.length === 0 && fg.swRings.length === 1 && fg.swOutline && fg.swath.skip.every((v) => v === 1), '③ 2D：无两缘折线、一环、全步 skip')
  ok(discs[0].ring.length >= 3 && rMin > 0, '③ 圆盘环可用', `${discs[0].ring.length} 点`)
}

// —— ④ 急转：内缘后退 ——
{
  const fp = { mode: 'elev', elevDeg: 5 }, h = 20000, K = swathK(h, fp)
  const secs = [sec(0, 0, h, 90, fp, K), sec(0, 1.5, h, 90, fp, K), sec(1.5, 1.5, h, 0, fp, K), sec(3, 1.5, h, 0, fp, K)]
  const pts = [{ lat: 0, lon: 0, h }, { lat: 0, lon: 1.5, h }, { lat: 1.5, lon: 1.5, h }, { lat: 3, lon: 1.5, h }]
  const lay = swathLayout(secs, K)
  ok(lay.kind[0] === 1 && lay.kind[1] === 2 && lay.kind[2] === 1, '④ 直行-急转-直行 → 平移/打转/平移', Array.from(lay.kind).join(','))
  ok(lay.spans.length === 2 && lay.runs.length === 1 && lay.runs[0][0] === 1 && lay.runs[0][1] === 2, '④ 两段 span、一段 run', `spans ${JSON.stringify(lay.spans)} runs ${JSON.stringify(lay.runs)}`)
  const discs = swathDiscs(lay, pts, fp, 36)
  ok(discs.length === 1 && discs[0].i === 1, '④ run 首点落一个盘', `${discs.length} 个 @${discs.length ? discs[0].i : '-'}`)
  const fg = swathFlatGeom(lay, discs, false)
  ok(Array.from(fg.swath.skip).join(',') === '0,1,0' && fg.swL.length === 2 && fg.swL[0].length === 2 && fg.swL[1].length === 2, '④ 2D：skip=0,1,0，两缘各切成两段', `swL ${fg.swL.map((p) => p.length).join('+')}`)
  const [L2] = swathEdgePolylines(fg.swath.ll, K, fg.swath.skip)
  ok(L2.length === 2, '④ swathEdgePolylines 与 swathFlatGeom 同口径')
  const fill = createSink(64), edge = createSink(64)
  emitSwath3D(lay, discs, { edge, fill, dash: 'solid', outlineOn: false })
  let onShell = true
  for (let i = 0; i < fill.n; i += 3) if (Math.abs(Math.hypot(fill.a[i], fill.a[i + 1], fill.a[i + 2]) - FILL_R) > 1e-5) onShell = false
  ok(fill.n > 0 && edge.n > 0 && onShell, '④ 3D：带面 + 盘全在 FILL_R 壳层、两缘有线', `fill ${fill.n} edge ${edge.n}`)
}

// —— ⑤ Worker 池整条链的 2D 打包 ——
{
  const t = Date.now(), gm = sat.gstime(new Date(t))
  const P = (fpOn) => ({
    tMs: t, gmst: gm, ccTMs: t, ccGmst: gm, lod: { samples: 120, stepDeg: 4, fpSeg: 72 }, per: 1, spanMs: 0,
    ring: { on: false, tMs: t, gmst: gm, rebuild: true, build: true }, fp: FP,
    style: { orbDash: 'solid', trkOn: true, trkDash: 'solid', trkMode: 'swath', trkFillOn: true, fpOn, fpDash: 'dash', fillOn: fpOn,
      coneOn: false, faceOn: false, genCount: 0, genDash: 'solid', dotOn: false, dotPx: 13, subOn: false, ringOn: false },
    want2d: true
  })
  const pool = createFocusGeomPool(-1)
  pool.setSats([{ key: 'g', rec: geo, cc: true, color: 0x4dabf7 }], 'g')
  const [a] = await pool.compute(P(true))
  const f = a.flat
  const nSec = (f.swOff[1] - f.swOff[0]) / (f.swK[0] + 1)
  ok(f.swSk.length === nSec - 1 && f.swRgOff.length === 2 && f.swRgOff[1] === 1 && f.swRgPt.length === 2 && f.swRgLL.length === f.swRgPt[1] * 2 && f.swOut[0] === 0,
    '⑤ 覆盖圈层开：skip 逐步齐全、一环、不描轮廓', `secs ${nSec} skip ${f.swSk.length} rings ${f.swRgOff[1]} pts ${f.swRgPt[1]}`)
  ok(a.trk.n === 0 && a.swath.n > 0, '⑤ 覆盖圈层开：3D 零边线、有盘', `trk ${a.trk.n} swath ${a.swath.n}`)
  const [b] = await pool.compute(P(false))
  ok(b.flat.swOut[0] === 1 && b.trk.n > 0, '⑤ 覆盖圈层关：描轮廓、3D 有轮廓线', `trk ${b.trk.n}`)
}

if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
