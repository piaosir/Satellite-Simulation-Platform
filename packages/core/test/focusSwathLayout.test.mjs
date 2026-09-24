// 轨迹面（覆盖带）的整理与出图（src/viz/constellation/focusSwath.js：swathLayout / swathDiscs / swathOutline / buildSwath / emitSwath3D / swathFlatGeom）
//  ① 航向掉头：相邻横断面左右缘互换 → 翻回来；端帽按实际位移定外侧，轮廓不横穿带
//  ② 平滑平移：带面部分与直接 swathFill 逐位相同；首尾各一只端帽圆盘；轮廓（两缘 + 两段端帽弧）首尾相接成一圈
//  ③ GEO 原地抖动：整轨归为原地 run → 一只覆盖圆盘；覆盖圈层开着零轮廓、关着轮廓落在覆盖圈半径上
//  ④ 急转（内缘后退）：转弯步落盘（段首 + 段尾）+ 首尾端帽；2D 该步不围切片；轮廓点全在扫过区域的边界上
//  ⑤ Worker 池整条链：2D 打包字段齐全（圆盘 / 轮廓两级偏移），覆盖圈层开 / 关切换起点端帽弧
//  ⑥ 回归（2026-09 实拍）：GPS BIIF-1 最低仰角 25°、轨迹 1 h，按 10 min 一拍走 1 h —— 每拍带面与「覆盖圈扫过的真并集」
//     逐点相符（修前：首条断面把当前覆盖圈切掉一半，末端一进打转段又整盘冒出来，面积在 1× 与 3× 之间跳）
//  ⑦ GPS 整圈（过极转弯、升降段互相压住）：带面与真并集相符；轮廓点全落在真边界上（仰角恰为门限）
//  ⑧ Molniya 近地点后（覆盖半径一分钟涨一两度）：带面与真并集相符（两臂按包络倾斜，见 focusSwath.tiltCos）
import sat from '../../../src/viz/constellation/satellite.js'
import * as W from '../../../src/viz/wgs84.js'
import { groundMotion, swathK, sectionOf, swathLayout, buildSwath, emitSwath3D, swathFlatGeom } from '../../../src/viz/constellation/focusSwath.js'
import { llaToVec, vecToLatLon, swathFill, createSink, FILL_R } from '../../../src/viz/globe3d/focusLanes.js'
import { createFocusGeomPool } from '../../../src/viz/constellation/focusGeomPool.js'
import { createShard, syncShard, computeTick } from '../../../src/viz/constellation/focusGeomTick.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (Math.hypot(a.x, a.y, a.z) * Math.hypot(b.x, b.y, b.z))))) / DEG
const same = (s1, s2, n = s1.n) => n <= s2.n && s1.a.subarray(0, n).every((v, i) => v === s2.a[i])
const vOf = (ln, k) => ({ x: ln[k * 3], y: ln[k * 3 + 1], z: ln[k * 3 + 2] })
// 轮廓点到「扫过区域边界」的偏差：给定一组星位 S（ECEF），点处最大仰角 − 门限（最低仰角档）。边界上≈0，里面为正、外面为负
const elevExcess = (v, sats, elevDeg) => { const [la, lo] = vecToLatLon(v.x, v.y, v.z); let m = -90; for (const S of sats) m = Math.max(m, W.elevationDeg(lo, la, S)); return m - elevDeg }

// —— ① 航向掉头 ——
{
  const fp = { mode: 'elev', elevDeg: 10 }, h = 780, K = swathK(h, fp)
  const pts = [{ lat: 0, lon: 0, h, az: 0 }, { lat: 0.05, lon: 0, h, az: 180 * DEG }]
  const secs = pts.map((q) => sectionOf(q, fp, K))
  const lay = swathLayout(secs, K)
  const L0 = vOf(lay.secs[0], 0), L1 = vOf(lay.secs[1], 0), R0 = vOf(lay.secs[0], K)
  ok(lay.rev[1] === 1 && angDeg(L1, L0) < angDeg(L1, R0), '① 掉头的断面被翻回来，左缘仍在同一侧', `左-左 ${angDeg(L1, L0).toFixed(3)}° 左-右 ${angDeg(L1, R0).toFixed(3)}°`)
  const sw = buildSwath(pts, secs, K, fp, 72, { fpOn: false })
  let jump = 0
  for (const ln of sw.lines) for (let k = 1; k < ln.length / 3; k++) jump = Math.max(jump, angDeg(vOf(ln, k - 1), vOf(ln, k)))
  ok(sw.lines.length === 4 && jump < 3, '① 轮廓 = 两缘 + 两段端帽弧，没有横穿带的跳线', `${sw.lines.length} 段，最长一步 ${jump.toFixed(2)}°`)
  // 终点航向朝南、实际位移朝北：终点端帽必须在北侧（背离起点），否则北半边没有轮廓
  const S = pts.map((q) => W.geodeticToEcef(q.lon, q.lat, q.h))
  let worst = 0
  for (const ln of sw.lines) for (let k = 0; k < ln.length / 3; k++) worst = Math.max(worst, Math.abs(elevExcess(vOf(ln, k), S, fp.elevDeg)))
  ok(worst < 0.01, '① 端帽按实际位移定外侧：轮廓点全在扫过区域的边界上', `最大偏差 ${worst.toFixed(4)}° 仰角`)
}

// —— ② 平滑平移 ——
{
  const fp = { mode: 'elev', elevDeg: 5 }, h = 550, K = swathK(h, fp)
  const pts = [[0, 0], [3, 0.5], [6, 1], [9, 1.5]].map(([lat, lon]) => ({ lat, lon, h, az: 10 * DEG }))
  const secs = pts.map((q) => sectionOf(q, fp, K))
  const sw = buildSwath(pts, secs, K, fp, 72, { fpOn: false })
  const lay = sw.layout
  ok(lay.spans.length === 1 && lay.spans[0][0] === 0 && lay.spans[0][1] === 3 && lay.runs.length === 0 && !lay.allStill && Array.from(lay.kind).every((k) => k === 1), '② 全是平移步，一段 span', JSON.stringify(lay.spans))
  ok(sw.discs.length === 2 && sw.discs.every((d) => d.cap) && sw.discs[0].i === 0 && sw.discs[1].i === 3, '② 首尾各一只端帽圆盘', sw.discs.map((d) => d.i).join(','))
  const fA = createSink(64)
  swathFill(secs, K, fA)
  const fB = createSink(64)
  emitSwath3D(sw, { edge: null, fill: fB, dash: 'solid' })
  ok(fA.n > 0 && fB.n > fA.n && same(fA, fB), '② 带面部分与直接 swathFill 逐位相同，其后是端帽', `${fA.n} / ${fB.n} 个数`)
  // 轮廓：四段首尾相接成一个圈（端点两两重合）
  const ends = []
  for (const ln of sw.lines) ends.push(vOf(ln, 0), vOf(ln, ln.length / 3 - 1))
  let unmatched = 0
  for (let a = 0; a < ends.length; a++) { let hit = false; for (let b = 0; b < ends.length; b++) if (b !== a && (b >> 1) !== (a >> 1) && angDeg(ends[a], ends[b]) < 1e-4) hit = true; if (!hit) unmatched++ }
  ok(sw.lines.length === 4 && unmatched === 0, '② 轮廓四段（两缘 + 两段端帽弧）首尾相接成一圈', `${sw.lines.length} 段，悬空端点 ${unmatched}`)
  const fg = swathFlatGeom(sw)
  ok(fg.swLines.length === 4 && fg.swRings.length === 2 && fg.swath.skip.every((v) => v === 0), '② 2D：四段轮廓、两只端帽环、全步围切片')
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
    const gd = sat.eciToGeodetic(pv.position, g), m = groundMotion(pv, g)
    const q = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), h: gd.height, az: m.az, gs: m.gs, hd: m.hd }
    pts.push(q); secs.push(sectionOf(q, FP, K))
  }
  const sw = buildSwath(pts, secs, K, FP, 72, { fpOn: true })
  const lay = sw.layout
  ok(lay.allStill && Array.from(lay.kind).every((k) => k === 3) && lay.runs.length === 1 && lay.spans.length === 0, '③ 整轨归为一个原地 run', `runs ${JSON.stringify(lay.runs)} spans ${lay.spans.length}`)
  ok(sw.discs.length === 1, '③ 只落一只覆盖圆盘（段尾 / 端帽与它重合，不重复落盘）', `${sw.discs.length} 只`)
  const fill = createSink(64), edge = createSink(64)
  emitSwath3D(sw, { edge, fill, dash: 'solid' })
  ok(edge.n === 0 && fill.n > 0, '③ 覆盖圈层开着：零轮廓、只有圆盘填充', `edge ${edge.n} fill ${fill.n}`)
  const c = llaToVec(sw.discs[0].lat, sw.discs[0].lon, 0)
  let rMax = 0
  for (let i = 0; i < fill.n; i += 3) rMax = Math.max(rMax, angDeg(c, { x: fill.a[i], y: fill.a[i + 1], z: fill.a[i + 2] }))
  ok(rMax > 38 && rMax < 40, '③ 圆盘半径 ≈ GEO 45° 仰角覆盖半宽（≈38.9°）', `${rMax.toFixed(2)}°`)
  const sw2 = buildSwath(pts, secs, K, FP, 72, { fpOn: false })
  const edge2 = createSink(64)
  emitSwath3D(sw2, { edge: edge2, fill: null, dash: 'solid' })
  let eMin = 180, eMax = 0
  for (let i = 0; i < edge2.n; i += 3) { const a = angDeg(c, { x: edge2.a[i], y: edge2.a[i + 1], z: edge2.a[i + 2] }); eMin = Math.min(eMin, a); eMax = Math.max(eMax, a) }
  ok(edge2.n > 0 && eMin > 38 && eMax < 40, '③ 覆盖圈层关着：轮廓整圈落在覆盖圈半径上', `${eMin.toFixed(2)}°~${eMax.toFixed(2)}°`)
  const fg = swathFlatGeom(sw)
  ok(fg.swLines.length === 0 && fg.swRings.length === 1 && fg.swath.skip.every((v) => v === 1), '③ 2D：无轮廓、一环、全步不围切片')
}

// —— ④ 急转：内缘后退 ——
{
  const fp = { mode: 'elev', elevDeg: 5 }, h = 20000, K = swathK(h, fp)
  const pts = [{ lat: 0, lon: 0, h, az: 90 * DEG }, { lat: 0, lon: 1.5, h, az: 90 * DEG }, { lat: 1.5, lon: 1.5, h, az: 0 }, { lat: 3, lon: 1.5, h, az: 0 }]
  const secs = pts.map((q) => sectionOf(q, fp, K))
  const sw = buildSwath(pts, secs, K, fp, 36, { fpOn: false })
  const lay = sw.layout
  ok(lay.kind[0] === 1 && lay.kind[1] === 2 && lay.kind[2] === 1, '④ 直行-急转-直行 → 平移/转弯/平移', Array.from(lay.kind).join(','))
  ok(lay.spans.length === 2 && lay.runs.length === 1 && lay.runs[0][0] === 1 && lay.runs[0][1] === 2, '④ 两段 span、一段 run', `spans ${JSON.stringify(lay.spans)} runs ${JSON.stringify(lay.runs)}`)
  const idx = sw.discs.map((d) => d.i).sort().join(',')
  ok(idx === '0,1,2,3', '④ 转弯段首尾各一只盘 + 首尾端帽', idx)
  const fg = swathFlatGeom(sw)
  ok(Array.from(fg.swath.skip).join(',') === '0,1,0', '④ 2D：skip=0,1,0（转弯步不围切片，由盘兜）')
  const fill = createSink(64), edge = createSink(64)
  emitSwath3D(sw, { edge, fill, dash: 'solid' })
  let onShell = true
  for (let i = 0; i < fill.n; i += 3) if (Math.abs(Math.hypot(fill.a[i], fill.a[i + 1], fill.a[i + 2]) - FILL_R) > 1e-5) onShell = false
  ok(fill.n > 0 && edge.n > 0 && onShell, '④ 3D：带面 + 盘全在 FILL_R 壳层、有轮廓线', `fill ${fill.n} edge ${edge.n}`)
  const S = pts.map((q) => W.geodeticToEcef(q.lon, q.lat, q.h))
  let worst = 0, npt = 0
  for (const ln of sw.lines) for (let k = 0; k < ln.length / 3; k++) { worst = Math.max(worst, elevExcess(vOf(ln, k), S, fp.elevDeg)); npt++ }
  ok(npt > 0 && worst < 0.1, '④ 内缘燕尾被裁掉：轮廓点都不在任何时刻的覆盖区深处', `${npt} 点，最多深入 ${worst.toFixed(3)}° 仰角`)
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
  ok(f.swSk.length === nSec - 1 && f.swRgOff.length === 2 && f.swRgOff[1] === 1 && f.swRgPt.length === 2 && f.swRgLL.length === f.swRgPt[1] * 2,
    '⑤ 覆盖圈层开：skip 逐步齐全、一环', `secs ${nSec} skip ${f.swSk.length} rings ${f.swRgOff[1]} pts ${f.swRgPt[1]}`)
  ok(f.swLnOff.length === 2 && f.swLnOff[1] === 0 && a.trk.n === 0 && a.swath.n > 0, '⑤ 覆盖圈层开：GEO 零轮廓（2D / 3D）、有盘', `lines ${f.swLnOff[1]} trk ${a.trk.n}`)
  const [b] = await pool.compute(P(false))
  ok(b.flat.swLnOff[1] === 1 && b.flat.swLnLL.length === b.flat.swLnPt[1] * 2 && b.trk.n > 0, '⑤ 覆盖圈层关：描轮廓（2D 一条闭环、3D 有线）', `lines ${b.flat.swLnOff[1]} trk ${b.trk.n}`)
}

// ===================== ⑥⑦⑧ 与「覆盖圈扫过的真并集」蛮力对比 =====================
// 球面上铺 Fibonacci 点：真值＝窗口内逐 20 s 取星位、任一时刻仰角 ≥ 门限；画出＝3D 带面三角形（模板缓冲逐像素只涂一次＝三角形并集）
const NP = 12000
const PT = new Float64Array(NP * 3)
for (let i = 0; i < NP; i++) {
  const y = 1 - 2 * (i + 0.5) / NP, r = Math.sqrt(1 - y * y), th = i * Math.PI * (3 - Math.sqrt(5))
  PT[i * 3] = r * Math.cos(th); PT[i * 3 + 1] = y; PT[i * 3 + 2] = r * Math.sin(th)
}
const GRID = 0.16   // 三角形边 ≤ 0.12 rad：按质心所在格及周围 26 格找点
const grid = new Map()
const gkey = (x, y, z) => ((Math.floor(x / GRID) + 64) * 128 + (Math.floor(y / GRID) + 64)) * 128 + (Math.floor(z / GRID) + 64)
for (let i = 0; i < NP; i++) { const k = gkey(PT[i * 3], PT[i * 3 + 1], PT[i * 3 + 2]); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i) }
function drawnCover(buf, n) {
  const hit = new Uint8Array(NP)
  for (let o = 0; o < n; o += 9) {
    const ax = buf[o], ay = buf[o + 1], az = buf[o + 2], bx = buf[o + 3], by = buf[o + 4], bz = buf[o + 5], cx = buf[o + 6], cy = buf[o + 7], cz = buf[o + 8]
    const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx
    const n2x = by * cz - bz * cy, n2y = bz * cx - bx * cz, n2z = bx * cy - by * cx
    const n3x = cy * az - cz * ay, n3y = cz * ax - cx * az, n3z = cx * ay - cy * ax
    const mx = ax + bx + cx, my = ay + by + cy, mz = az + bz + cz, mn = Math.hypot(mx, my, mz) || 1
    const gx = Math.floor(mx / mn / GRID), gy = Math.floor(my / mn / GRID), gz = Math.floor(mz / mn / GRID)
    for (let p = -1; p <= 1; p++) for (let q = -1; q <= 1; q++) for (let r = -1; r <= 1; r++) {
      const js = grid.get(((gx + p + 64) * 128 + (gy + q + 64)) * 128 + (gz + r + 64))
      if (!js) continue
      for (const i of js) {
        if (hit[i]) continue
        const px = PT[i * 3], py = PT[i * 3 + 1], pz = PT[i * 3 + 2]
        if (px * mx + py * my + pz * mz <= 0) continue
        const s1 = px * n1x + py * n1y + pz * n1z, s2 = px * n2x + py * n2y + pz * n2z, s3 = px * n3x + py * n3y + pz * n3z
        if ((s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0)) hit[i] = 1
      }
    }
  }
  return hit
}
const GND = new Float64Array(NP * 6)
for (let i = 0; i < NP; i++) {
  const [lat, lon] = vecToLatLon(PT[i * 3], PT[i * 3 + 1], PT[i * 3 + 2])
  const e = W.geodeticToEcef(lon, lat, 0), up = W.geodeticUp(lon, lat)
  GND.set([e[0], e[1], e[2], up[0], up[1], up[2]], i * 6)
}
const satsAlong = (rec, t0, spanMs, stepMs = 20000) => { const out = []; for (let t = t0; t <= t0 + spanMs + 1; t += stepMs) { const d = new Date(t), pv = sat.propagate(rec, d), e = sat.eciToEcf(pv.position, sat.gstime(d)); out.push([e.x, e.y, e.z]) } return out }
function truthCover(sats, elevDeg) {
  const hit = new Uint8Array(NP), s = Math.sin(elevDeg * DEG)
  for (const S of sats) for (let i = 0; i < NP; i++) {
    if (hit[i]) continue
    const o = i * 6, dx = S[0] - GND[o], dy = S[1] - GND[o + 1], dz = S[2] - GND[o + 2]
    if (dx * GND[o + 3] + dy * GND[o + 4] + dz * GND[o + 5] >= s * Math.hypot(dx, dy, dz)) hit[i] = 1
  }
  return hit
}
const tickOf = (st, tMs, fp, per) => {
  const g = sat.gstime(new Date(tMs))
  return computeTick(st, { tMs, gmst: g, ccTMs: tMs, ccGmst: g, lod: { samples: 120, stepDeg: 4, fpSeg: 72 }, per, spanMs: 0,
    ring: { on: false, tMs, gmst: g, rebuild: true, build: true }, fp,
    style: { orbDash: 'solid', trkOn: true, trkDash: 'solid', trkMode: 'swath', trkFillOn: true, fpOn: false, fpDash: 'solid', fillOn: false,
      coneOn: false, faceOn: false, genCount: 0, genDash: 'solid', dotOn: false, dotPx: 13, subOn: false, ringOn: false }, want2d: true })
}
const compare = (r, sats, elevDeg) => {
  const d = drawnCover(new Float32Array(r.swath.buf, 0, r.swath.n), r.swath.n), t = truthCover(sats, elevDeg)
  let nd = 0, nt = 0, over = 0, miss = 0
  for (let i = 0; i < NP; i++) { nd += d[i]; nt += t[i]; if (d[i] && !t[i]) over++; if (!d[i] && t[i]) miss++ }
  return { nd, nt, over, miss }
}
const GPS = sat.omm2satrec({ noradId: '36585', epoch: '2026-09-21T23:06:37.427616', meanMotion: 2.00610343, ecc: 0.01160745, incl: 54.2577, raan: 204.6657, argp: 55.8766, ma: 150.5089, bstar: 0, mdot: -0.13e-6, mddot: 0 })
const GPS_P = 2 * Math.PI / GPS.no * 60000
const E25 = { mode: 'elev', beamDeg: NaN, elevDeg: 25 }

// —— ⑥ GPS 25°、1 h 轨迹逐拍：带面恒等于真并集，面积随时间平滑 ——
{
  const st = createShard()
  syncShard(st, { keys: ['g'], add: [{ key: 'g', rec: GPS, cc: false, color: 0 }], primary: 'g' })
  const per = 3600000 / GPS_P, T0 = Date.parse('2026-09-24T04:01:10Z')
  let worstErr = 0, minA = Infinity, maxA = 0, runsSeen = false
  const rows = []
  for (let k = 0; k <= 6; k++) {
    const t = T0 + k * 600000
    const r = tickOf(st, t, E25, per)
    if (Array.from(r.flat.swSk).some((v) => v)) runsSeen = true
    const c = compare(r, satsAlong(GPS, t, per * GPS_P), 25)
    worstErr = Math.max(worstErr, (c.over + c.miss) / c.nt)
    minA = Math.min(minA, c.nd); maxA = Math.max(maxA, c.nd)
    rows.push(`${c.nd}/${c.nt}`)
  }
  ok(runsSeen, '⑥ 这一小时里轨迹末端确实走进了转弯段（修前就是这时整盘冒出来）')
  ok(worstErr < 0.004, '⑥ 每拍带面 = 覆盖圈扫过的真并集（含当前时刻的整只覆盖圈）', `画/真 ${rows.join(' ')}；最大差 ${(worstErr * 100).toFixed(2)}%`)
  ok(maxA / minA < 1.1, '⑥ 面积随时间平滑（窗口只是往前滑）', `${minA} ~ ${maxA}`)
}

// —— ⑦ GPS 整圈：带面与真并集相符；轮廓点全在真边界上 ——
{
  const st = createShard()
  syncShard(st, { keys: ['g'], add: [{ key: 'g', rec: GPS, cc: false, color: 0 }], primary: 'g' })
  const t = Date.parse('2026-09-24T04:31:10Z')
  const r = tickOf(st, t, E25, 1)
  const sats = satsAlong(GPS, t, GPS_P)
  const c = compare(r, sats, 25)
  ok((c.over + c.miss) / c.nt < 0.004, '⑦ 整圈（过极转弯、升降段互相压住）带面 = 真并集', `画 ${c.nd} 真 ${c.nt} 多 ${c.over} 漏 ${c.miss}`)
  const f = r.flat
  let worst = 0, n = 0
  for (let q = 0; q < f.swLnOff[1]; q++) for (let k = f.swLnPt[q]; k < f.swLnPt[q + 1]; k++) {
    const v = llaToVec(f.swLnLL[k * 2], f.swLnLL[k * 2 + 1], 0)
    worst = Math.max(worst, Math.abs(elevExcess(v, sats, 25))); n++
  }
  ok(n > 100 && worst < 0.15, '⑦ 轮廓点全在扫过区域的真边界上（仰角恰为门限）', `${f.swLnOff[1]} 段 ${n} 点，最大偏差 ${worst.toFixed(3)}°`)
}

// —— ⑧ Molniya 近地点后 1 h：覆盖半径随高度猛涨，带面仍与真并集相符 ——
{
  const MOL = sat.omm2satrec({ noradId: 'MOL', epoch: '2024-01-01T00:00:00', meanMotion: 2.0056, ecc: 0.74, incl: 63.4, raan: 30, argp: 270, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
  const P = 2 * Math.PI / MOL.no * 60000
  const st = createShard()
  syncShard(st, { keys: ['m'], add: [{ key: 'm', rec: MOL, cc: false, color: 0 }], primary: 'm' })
  const t = Date.UTC(2024, 0, 1, 0, 5, 0), per = 3600000 / P
  const E10 = { mode: 'elev', beamDeg: NaN, elevDeg: 10 }
  const r = tickOf(st, t, E10, per)
  const c = compare(r, satsAlong(MOL, t, per * P), 10)
  ok((c.over + c.miss) / c.nt < 0.006, '⑧ Molniya 变宽段带面 = 真并集（两臂按包络倾斜）', `画 ${c.nd} 真 ${c.nt} 多 ${c.over} 漏 ${c.miss}`)
}

if (fails) { console.log(`\n${fails} 项失败`); process.exit(1) } else console.log('\n全部通过')
