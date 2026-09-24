// 轨迹面（覆盖带）几何自检：
//  ① 等仰角单方向求根器与逐方位等仰角环同一份口径（同方位取样逐位一致）
//  ② 横断面两缘落在瞬时覆盖圈上（最低仰角档 / 波束角档各验一次，与 footprintRing 的横向极点对上）
//  ③ 横断面第 K/2 点恰是星下点、左右缘关于星下点对称
//  ④' 地面运动：地面角速度 / 径向速度与星历中心差分自洽
//  ⑦ 两臂包络倾角：偏心轨道（Molniya）上两缘恰在包络上 —— 不被前后时刻的覆盖区盖住（垂直断面会被盖住）
//  ④ 地面航向：赤道顺行轨道 ≈ 90°（向东），极轨升段 ≈ 0°（向北）
//  ⑤ 三角网：顶点数 = 格数 × 18，顶点全在 FILL_R 壳层上；沿轨大间距自动插断面
//  ⑥ vecToLatLon 是 llaToVec 的逆
import * as W from '../../../src/viz/wgs84.js'
import sat from '../../../src/viz/constellation/satellite.js'
import { footprintRing, beamHalfAngle } from '../../../src/viz/constellation/focusFootprint.js'
import { groundMotion, swathK, swathSig, sectionOf } from '../../../src/viz/constellation/focusSwath.js'
import { llaToVec, vecToLatLon, swathFill, createSink, FILL_R, FILL_CELL } from '../../../src/viz/globe3d/focusLanes.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z))) / DEG

// —— ① 单方向求根器 vs 逐方位环 ——
{
  const S = W.geodeticToEcef(30, 40, 550)
  const ring = W.isoElevationContourAt(S, 25, 40)
  const sol = W.isoElevationSolver(S, 25)
  // 环的第 k 个方位 = basisAround(u0) 的 (cosβ, sinβ) 组合；这里用环上点反推方向再求根，比较落点
  let maxErr = 0
  for (const [lon, lat] of ring) {
    const p = W.geodeticToEcef(lon, lat, 0)
    const pr = Math.hypot(p[0], p[1], p[2])
    const u = sol.u0, up = [p[0] / pr, p[1] / pr, p[2] / pr]
    // 方向 = 去掉 u0 分量后归一
    const c = up[0] * u[0] + up[1] * u[1] + up[2] * u[2]
    let d = [up[0] - c * u[0], up[1] - c * u[1], up[2] - c * u[2]]
    const dn = Math.hypot(d[0], d[1], d[2]); d = [d[0] / dn, d[1] / dn, d[2] / dn]
    const rho = sol.solve(d[0], d[1], d[2], -1)
    const q = sol.geoOn(sol.surfAt(d[0], d[1], d[2], rho))
    maxErr = Math.max(maxErr, Math.abs(q[0] - lon), Math.abs(q[1] - lat))
  }
  ok(maxErr < 1e-7, '① 单方向求根落点与等仰角环逐位一致', `max ${maxErr.toExponential(2)}°`)
}

// —— ②③ 横断面两缘 vs 覆盖圈 ——
function edgeCheck(mode, tag) {
  const lat = 35, lon = 120, h = 780, az = 40 * DEG
  const fp = { mode, beamDeg: 40, elevDeg: 10 }
  const K = swathK(h, fp)
  const sec = sectionOf({ lat, lon, h, az }, fp, K)
  ok(!!sec && sec.length === (K + 1) * 3, `${tag} 横断面点数 = K+1`, `K=${K}`)
  const S = W.geodeticToEcef(lon, lat, h)
  const ring = footprintRing(S, h, 72, fp)
  const L = vecToLatLon(sec[0], sec[1], sec[2]), R = vecToLatLon(sec[K * 3], sec[K * 3 + 1], sec[K * 3 + 2])
  // 两缘按口径本身验：最低仰角档＝该点对星仰角恰为目标值；波束角档＝星→该点射线离天底恰为锥半角
  //（不拿「到环顶点的距离」验：环是 120/72 个顶点的折线，顶点间距本身就有半度）
  let dL, dR
  if (mode === 'elev') { dL = Math.abs(W.elevationDeg(L[1], L[0], S) - fp.elevDeg); dR = Math.abs(W.elevationDeg(R[1], R[0], S) - fp.elevDeg) }
  else {
    const eta = beamHalfAngle(h, fp.beamDeg) / DEG
    const off = (pt) => { const p = W.geodeticToEcef(pt[1], pt[0], 0); const d = [p[0] - S[0], p[1] - S[1], p[2] - S[2]]; const dn = Math.hypot(...d), sn = Math.hypot(...S); return Math.abs(Math.acos(-(d[0] * S[0] + d[1] * S[1] + d[2] * S[2]) / (dn * sn)) / DEG - eta) }
    dL = off(L); dR = off(R)
  }
  ok(dL < 1e-5 && dR < 1e-5, `${tag} 两缘严格落在口径上`, `左 ${dL.toExponential(2)}° 右 ${dR.toExponential(2)}°`)
  // 也顺带验一下与瞬时覆盖圈（折线）的贴合：到最近环顶点不超过顶点间距的一半
  const near = (pt) => { let m = Infinity; const v = llaToVec(pt[0], pt[1], 0); for (const q of ring) m = Math.min(m, angDeg(v, llaToVec(q.lat, q.lon, 0))); return m }
  const gap = angDeg(llaToVec(ring[0].lat, ring[0].lon, 0), llaToVec(ring[1].lat, ring[1].lon, 0))
  ok(near(L) <= gap * 0.55 && near(R) <= gap * 0.55, `${tag} 两缘贴着瞬时覆盖圈`, `左 ${near(L).toFixed(4)}° 右 ${near(R).toFixed(4)}° / 顶点间距 ${gap.toFixed(4)}°`)
  // 第 K/2 点就是星下点（两臂在这里接上）；左右缘到星下点等距
  const c = llaToVec(lat, lon, 0), mid = { x: sec[(K >> 1) * 3], y: sec[(K >> 1) * 3 + 1], z: sec[(K >> 1) * 3 + 2] }
  const a = angDeg(c, { x: sec[0], y: sec[1], z: sec[2] }), b = angDeg(c, { x: sec[K * 3], y: sec[K * 3 + 1], z: sec[K * 3 + 2] })
  ok(angDeg(c, mid) < 1e-4, `${tag} 横断面第 K/2 点恰是星下点`, `${angDeg(c, mid).toExponential(2)}°`)
  ok(Math.abs(a - b) < 0.05, `${tag} 左右缘关于星下点对称`, `${a.toFixed(3)}° / ${b.toFixed(3)}°`)
  // 横向：两缘方向与航向垂直（在星下点切平面里）
  const cl = llaToVec(L[0], L[1], 0), cr = llaToVec(R[0], R[1], 0)
  const chord = { x: cr.x - cl.x, y: cr.y - cl.y, z: cr.z - cl.z }
  // 航向在渲染球面上的切向：沿 az 走一小步
  const dlat = Math.cos(az) * 0.01, dlon = Math.sin(az) * 0.01 / Math.cos(lat * DEG)
  const ahead = llaToVec(lat + dlat, lon + dlon, 0)
  const t = { x: ahead.x - c.x, y: ahead.y - c.y, z: ahead.z - c.z }
  const cosv = (chord.x * t.x + chord.y * t.y + chord.z * t.z) / (Math.hypot(chord.x, chord.y, chord.z) * Math.hypot(t.x, t.y, t.z))
  ok(Math.abs(cosv) < 0.02, `${tag} 横断面垂直于航向`, `cos ${cosv.toFixed(4)}`)
  return { K, sec }
}
const E = edgeCheck('elev', '② 最低仰角档')
edgeCheck('beam', '② 波束角档')
ok(swathSig({ mode: 'elev', elevDeg: 10 }, 10) !== swathSig({ mode: 'elev', elevDeg: 11 }, 10) && swathSig({ mode: 'beam', beamDeg: 40 }, 10) !== swathSig({ mode: 'elev', elevDeg: 40 }, 10), '签名区分口径与取值')

// —— ④ 地面航向 ——
{
  // 赤道顺行（i=0）：向东；极轨（i=90）升交段：向北
  const mk = (incl, ma) => {
    const l1 = '1 99999U 24001A   24001.00000000  .00000000  00000-0  00000-0 0  9990'
    const s = `2 99999 ${incl.toFixed(4).padStart(8)}   0.0000 0001000   0.0000 ${ma.toFixed(4).padStart(8)} 14.00000000    01`
    // 校验位随便填：satellite.js 的 twoline2satrec 不校验
    return sat.twoline2satrec(l1, s)
  }
  const t = new Date(Date.UTC(2024, 0, 1, 0, 0, 0))
  const eq = mk(0, 0), po = mk(90, 0)
  const pe = sat.propagate(eq, t), pp = sat.propagate(po, t)
  const g = sat.gstime(t)
  const azE = groundMotion(pe, g).az / DEG, azP = groundMotion(pp, g).az / DEG
  ok(Math.abs(azE - 90) < 2, '④ 赤道顺行轨道航向 ≈ 90°（向东）', azE.toFixed(2))
  // 极轨升段：航向是【相对地球】的 —— 地面向东自转 0.465 km/s，星下点 6.5 km/s 向北，故偏西 atan(0.465/6.5) ≈ 4°
  const pos = pp.position, vel = pp.velocity
  const rr = Math.hypot(pos.x, pos.y, pos.z), vg = Math.hypot(vel.x, vel.y, vel.z) * 6378.137 / rr
  const expect = -Math.atan2(0.4651, vg) / DEG
  ok(Math.abs(azP - expect) < 0.5, '④ 极轨升段航向 ≈ 北偏西 atan(地表自转速/星下点速)', `${azP.toFixed(2)} vs ${expect.toFixed(2)}`)
}

// —— ④' 地面运动：地面角速度 / 径向速度对星历中心差分 ——
const MOL = sat.omm2satrec({ noradId: 'MOL', epoch: '2024-01-01T00:00:00', meanMotion: 2.0056, ecc: 0.74, incl: 63.4, raan: 30, argp: 270, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
{
  const ecfAt = (ms) => { const d = new Date(ms), pv = sat.propagate(MOL, d); return sat.eciToEcf(pv.position, sat.gstime(d)) }
  let wGs = 0, wHd = 0
  for (const minutes of [8, 25, 60, 300]) {
    const t = Date.UTC(2024, 0, 1, 0, 0, 0) + minutes * 60000, d = new Date(t)
    const pv = sat.propagate(MOL, d), g = sat.gstime(d)
    const m = groundMotion(pv, g)
    const a = ecfAt(t - 500), b = ecfAt(t + 500)
    const na = Math.hypot(a.x, a.y, a.z), nb = Math.hypot(b.x, b.y, b.z)
    const gs = Math.acos((a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb)), hd = nb - na   // 1 s 窗口
    wGs = Math.max(wGs, Math.abs(m.gs - gs) / gs); wHd = Math.max(wHd, Math.abs(m.hd - hd))
  }
  ok(wGs < 2e-3, "④' 地面角速度 = 地心方向角速率（±0.5 s 差分）", `最大相对差 ${wGs.toExponential(2)}`)
  ok(wHd < 2e-3, "④' 径向速度 = 地心距变化率（±0.5 s 差分）", `最大差 ${wHd.toExponential(2)} km/s`)
}

// —— ⑤ 三角网 ——
{
  const fp = { mode: 'elev', elevDeg: 5 }, h = 550
  const K = swathK(h, fp)
  const pts = [{ lat: 0, lon: 0 }, { lat: 3, lon: 0.5 }, { lat: 6, lon: 1 }]
  const secs = pts.map((p) => sectionOf({ lat: p.lat, lon: p.lon, h, az: 10 * DEG }, fp, K))
  const out = createSink(64)
  swathFill(secs, K, out)
  const n = out.n / 3
  ok(n === 2 * K * 6, '⑤ 相邻断面每格两个三角形（近距不插断面）', `${n} 顶点 K=${K}`)
  let rMin = Infinity, rMax = 0
  for (let i = 0; i < out.n; i += 3) { const r = Math.hypot(out.a[i], out.a[i + 1], out.a[i + 2]); rMin = Math.min(rMin, r); rMax = Math.max(rMax, r) }
  ok(Math.abs(rMin - FILL_R) < 1e-5 && Math.abs(rMax - FILL_R) < 1e-5, '⑤ 顶点全在 FILL_R 壳层上', `${rMin.toFixed(6)}~${rMax.toFixed(6)}`)
  // 沿轨大间距（15°，多选降采样档）：自动插中间断面，格数按 ceil(δ/FILL_CELL) 倍增
  const far = [{ lat: 0, lon: 0 }, { lat: 15, lon: 2 }].map((p) => sectionOf({ lat: p.lat, lon: p.lon, h, az: 10 * DEG }, fp, K))
  const out2 = createSink(64)
  swathFill(far, K, out2)
  const steps = Math.ceil((15.1 * DEG) / FILL_CELL)
  ok(out2.n / 3 >= (steps - 1) * K * 6 && out2.n / 3 <= (steps + 1) * K * 6, '⑤ 沿轨大间距自动插断面', `${out2.n / 3} 顶点 ≈ ${steps} 步`)
  // 断面缺失 → 该格跳过不抛
  const out3 = createSink(64)
  swathFill([secs[0], null, secs[2]], K, out3)
  ok(out3.n === 0, '⑤ 断面缺失的格子跳过')
}

// —— ⑥ vecToLatLon ——
{
  let maxErr = 0
  for (const [lat, lon] of [[0, 0], [45, 90], [-60, -120], [89, 179.9], [-89, -179.9], [10, 180]]) {
    const v = llaToVec(lat, lon, 0)
    const [la, lo] = vecToLatLon(v.x, v.y, v.z)
    let dl = Math.abs(lo - lon); if (dl > 180) dl = 360 - dl
    maxErr = Math.max(maxErr, Math.abs(la - lat), dl)
  }
  ok(maxErr < 1e-9, '⑥ vecToLatLon 是 llaToVec 的逆', `max ${maxErr.toExponential(2)}°`)
}

// —— ⑦ 两臂包络倾角：Molniya 近地点后覆盖半径一分钟涨一两度 ——
// 断面两缘该落在扫过区域的侧边界（包络）上：前后相邻时刻的覆盖区都盖不住它。垂直航向取的两缘会整段落进下一时刻的覆盖区。
{
  const FP7 = { mode: 'elev', elevDeg: 10 }, K = 24
  const t0 = Date.UTC(2024, 0, 1, 0, 0, 0)
  const at = (ms) => {
    const d = new Date(ms), pv = sat.propagate(MOL, d), g = sat.gstime(d)
    const gd = sat.eciToGeodetic(pv.position, g), m = groundMotion(pv, g), e = sat.eciToEcf(pv.position, g)
    return { pt: { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), h: gd.height, az: m.az, gs: m.gs, hd: m.hd }, S: [e.x, e.y, e.z] }
  }
  // 两缘被前 / 后 60 s 的覆盖区盖住多少：max(该时刻看这个地面点的仰角 − 门限)，正＝被盖住
  const worst = (tilted) => {
    let w = -Infinity
    for (let k = 1; k <= 30; k++) {
      const tm = t0 + k * 60000, c = at(tm), pr = at(tm - 60000), nx = at(tm + 60000)
      const pt = tilted ? c.pt : { lat: c.pt.lat, lon: c.pt.lon, h: c.pt.h, az: c.pt.az }
      const sec = sectionOf(pt, FP7, K)
      for (const o of [0, K * 3]) {
        const [la, lo] = vecToLatLon(sec[o], sec[o + 1], sec[o + 2])
        for (const q of [pr, nx]) w = Math.max(w, W.elevationDeg(lo, la, q.S) - FP7.elevDeg)
      }
    }
    return w
  }
  const wT = worst(true), wP = worst(false)
  ok(wT < 0.02, '⑦ 倾斜两臂：两缘不被前后时刻的覆盖区盖住（恰在包络上）', `最多深入 ${wT.toFixed(4)}° 仰角`)
  ok(wP > 0.5, '⑦ 对照：垂直断面的两缘被下一时刻的覆盖区整段盖住', `深入 ${wP.toFixed(3)}° 仰角`)
  // 近圆轨道不倾：GPS 一圈里两臂方向离垂直不到 0.5°
  const gps = sat.omm2satrec({ noradId: 'G', epoch: '2024-01-01T00:00:00', meanMotion: 2.00610343, ecc: 0.01160745, incl: 54.2577, raan: 204.6657, argp: 55.8766, ma: 150.5089, bstar: 0, mdot: 0, mddot: 0 })
  let tiltMax = 0
  for (let k = 0; k < 72; k++) {
    const d = new Date(t0 + k * 600000), pv = sat.propagate(gps, d), g = sat.gstime(d)
    const gd = sat.eciToGeodetic(pv.position, g), m = groundMotion(pv, g)
    const pt = { lat: sat.degreesLat(gd.latitude), lon: sat.degreesLong(gd.longitude), h: gd.height, az: m.az, gs: m.gs, hd: m.hd }
    const a = sectionOf(pt, FP7, K), b = sectionOf({ lat: pt.lat, lon: pt.lon, h: pt.h, az: pt.az }, FP7, K)
    const c = llaToVec(pt.lat, pt.lon, 0)
    // 两缘方向角差（在星下点处量）：左缘方位的偏转
    const ua = { x: a[0] - c.x, y: a[1] - c.y, z: a[2] - c.z }, ub = { x: b[0] - c.x, y: b[1] - c.y, z: b[2] - c.z }
    const na = Math.hypot(ua.x, ua.y, ua.z), nb = Math.hypot(ub.x, ub.y, ub.z)
    tiltMax = Math.max(tiltMax, Math.acos(Math.max(-1, Math.min(1, (ua.x * ub.x + ua.y * ub.y + ua.z * ub.z) / (na * nb)))) / DEG)
  }
  ok(tiltMax < 0.5, '⑦ 近圆轨道（GPS）两臂几乎不倾', `最大 ${tiltMax.toFixed(3)}°`)
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
