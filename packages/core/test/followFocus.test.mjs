// 跟随主星的聚焦几何（src/viz/globe3d/followFocus.js）：
//  ① 两支折线首点恰是锚点（相对坐标 0）；整条轨道从主星看的角误差（对密采样真值）≤ 门限 —— GEO / ISS / Molniya（近地点段靠二分补密）
//  ② 轨道线在主星处的切向与惯性速度（L 系 x̂ 的来源）夹角：场景映射（大地纬经高 → 单位球）带来的偏差有多大
//  ③ 覆盖锥：相对几何 + 锚点 与聚焦几何 Worker（focusGeomTick 走 emitCone）同一拍的绝对几何逐段相符（float32 量化以内）
//  ④ emitCone 与改造前 focusGeomTick 里那段内联写法逐位相同
//  ⑤ 虚线相位钉在主星上：两支各自从锚点起「画」；实线档线段首尾相接
//  ⑥ 逐拍耗时
import * as THREE from 'three'
import sat from '../../../src/viz/constellation/satellite.js'
import { posAt } from '../../../src/viz/constellation/satPos.js'
import { footprintRing } from '../../../src/viz/constellation/focusFootprint.js'
import { followOrbitBranches, followFocusGeom, relSink, ORB_EPS } from '../../../src/viz/globe3d/followFocus.js'
import { llaToVec, pushDashed, coneFace, emitCone, createSink, LIFT } from '../../../src/viz/globe3d/focusLanes.js'
import { createShard, syncShard, computeTick } from '../../../src/viz/constellation/focusGeomTick.js'

let fails = 0
const ok = (cond, msg, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}${extra ? '  (' + extra + ')' : ''}`); if (!cond) fails++ }
const DEG = Math.PI / 180

const GEO = sat.twoline2satrec('1 39017U 12075A   26265.41000000 -.00000349  00000+0  00000+0 0  9990', '2 39017   0.0200 137.5600 0002700  33.6000 304.8900  1.00270000 50000')
const ISS = sat.twoline2satrec('1 25544U 98067A   26265.47000000  .00016717  00000+0  30000-3 0  9990', '2 25544  51.6300 180.2400 0004800 167.1100 193.0000 15.49050000400000')
const MOL = sat.twoline2satrec('1 28163U 04005A   26265.50000000  .00000100  00000+0  10000-3 0  9990', '2 28163  62.8000 250.0000 7200000 270.0000 350.0000  2.00600000 10000')
const T0 = Date.UTC(2026, 8, 24, 4, 0, 0)

// 锚点：与 modelLayer.satStateAt 同一份算式（那边经 @core 别名引模型包，node 下直接引不了，这里照抄那一行）
const stateOf = (rec, tMs) => {
  const d = new Date(tMs), g = sat.gstime(d), pv = posAt(rec, d), gd = sat.eciToGeodetic(pv.position, g)
  const a = llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height)
  return { g, pv, st: { anchor: [a.x, a.y, a.z] } }
}
const mapAt = (rec, ms, g) => { const pv = posAt(rec, new Date(ms)); const gd = sat.eciToGeodetic(pv.position, g); return llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height) }
const periodMs = (rec) => 2 * Math.PI / rec.no * 60000

// 点到折线的最短距离（逐段）
function distToPolyline(q, pts) {
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1]
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, L2 = abx * abx + aby * aby + abz * abz
    let u = L2 > 0 ? ((q.x - a.x) * abx + (q.y - a.y) * aby + (q.z - a.z) * abz) / L2 : 0
    u = Math.max(0, Math.min(1, u))
    const dx = q.x - a.x - u * abx, dy = q.y - a.y - u * aby, dz = q.z - a.z - u * abz
    const d = dx * dx + dy * dy + dz * dz
    if (d < best) best = d
  }
  return Math.sqrt(best)
}

// —— ① 首点 = 锚点；从主星看的角误差 ——
for (const [nm, rec, dtNear] of [['GEO', GEO, 0.05], ['ISS', ISS, 0.01], ['Molniya', MOL, 0.05]]) {
  // 两支合起来恰一整圈：Molniya 的近地点段（角速度快、靠二分补密的那段）必在其中
  const tMs = T0
  const { g, st } = stateOf(rec, tMs)
  const br = followOrbitBranches(rec, tMs, g, st.anchor)
  const A = new THREE.Vector3(...st.anchor)
  ok(br && br[0][0].equals(A) && br[1][0].equals(A), `① ${nm}：两支首点就是锚点`)
  // 真值：每支按时间均匀 8000 点 + 主星附近几何加密 400 点
  const P = periodMs(rec) / 2
  let worst = 0, worstAt = 0
  for (const [sign, pts] of [[1, br[0]], [-1, br[1]]]) {
    const rel = pts.map((p) => p.clone().sub(A))
    const ts = []
    for (let j = 1; j <= 8000; j++) ts.push(sign * P * j / 8000)
    for (let j = 0; j < 400; j++) ts.push(sign * dtNear * 1000 * Math.pow(1.04, j))   // 自 dtNear 秒起几何增长
    for (const tau of ts) {
      if (Math.abs(tau) > P) continue
      const q = mapAt(rec, tMs + tau, g).sub(A)
      const r = q.length()
      if (!(r > 1e-9)) continue
      const e = distToPolyline(q, rel) / r
      if (e > worst) { worst = e; worstAt = tau }
    }
  }
  const n = br[0].length + br[1].length
  ok(worst <= ORB_EPS * 1.05, `① ${nm}：整条轨道从主星看的角误差 ≤ 门限 ${ORB_EPS}`, `最大 ${worst.toExponential(2)} rad @ τ=${(worstAt / 1000).toFixed(1)} s；顶点 ${n}`)
}

// —— ② 主星处切向 vs 惯性速度方向（L 系 x̂ 的来源）：场景映射的偏差（报数 + 宽限 0.5°）——
for (const [nm, rec] of [['GEO', GEO], ['ISS', ISS]]) {
  let maxDeg = 0
  for (let k = 0; k < 24; k++) {
    const tMs = T0 + k * periodMs(rec) / 24
    const { g, pv, st } = stateOf(rec, tMs)
    const br = followOrbitBranches(rec, tMs, g, st.anchor)
    const A = new THREE.Vector3(...st.anchor)
    const t1 = br[0][1].clone().sub(A).normalize()
    const v = sat.eciToEcf(pv.velocity, g)   // satStateAt 同口径：只转轴向、不减 ω×r
    const vs = new THREE.Vector3(v.x, v.z, -v.y).normalize()   // sceneFromEcef：(X, Z, −Y)
    maxDeg = Math.max(maxDeg, t1.angleTo(vs) / DEG)
  }
  ok(maxDeg < 0.5, `② ${nm}：轨道线在主星处的切向与惯性速度方向夹角（一圈 24 拍最大）< 0.5°`, `${maxDeg.toFixed(3)}°`)
}

// —— ③ 覆盖锥：近场（相对 + 锚点）与 Worker 同一拍的绝对几何逐段相符 ——
for (const [nm, rec, fp] of [['GEO 波束角 17.4°', GEO, { mode: 'beam', beamDeg: 17.4 }], ['ISS 最低仰角 10°', ISS, { mode: 'elev', elevDeg: 10 }]]) {
  const tMs = T0, d = new Date(tMs), { g, st } = stateOf(rec, tMs)
  const S = { orbDash: 'solid', trkOn: false, fpOn: false, fillOn: false, coneOn: true, faceOn: true, genCount: 8, genDash: 'dash', dotOn: false, subOn: false, ringOn: false }
  const sh = createShard()
  syncShard(sh, { keys: ['x'], add: [{ key: 'x', rec, cc: false, color: 0xffffff }], primary: 'x' })
  const r = computeTick(sh, { tMs, gmst: g, ccTMs: tMs, ccGmst: g, lod: { samples: 120, stepDeg: 4, fpSeg: 72 }, per: 1, spanMs: 0, ring: { on: false }, fp, style: S, want2d: false })
  const gAbs = new Float32Array(r.gen.buf, 0, r.gen.n), fAbs = new Float32Array(r.cone.buf, 0, r.cone.n)
  const ff = followFocusGeom(rec, d, g, st.anchor, { orbOn: false, coneOn: true, faceOn: true, genCount: 8, genDash: 'dash', fp, fpSeg: 72 })
  const cmp = (rel, abs) => {
    if (!rel || rel.length !== abs.length) return Infinity
    let m = 0
    for (let i = 0; i < rel.length; i++) m = Math.max(m, Math.abs(rel[i] + st.anchor[i % 3] - abs[i]))
    return m
  }
  const eg = cmp(ff.gen, gAbs), ef = cmp(ff.face, fAbs)
  // float32 绝对坐标在 GEO 半径处的量化 ≈ 4.8e-7 场景单位
  ok(eg < 1e-6 && ef < 1e-6, `③ ${nm}：母线 / 锥面与 Worker 同一拍逐段相符（float32 量化以内）`, `母线 ${ff.gen && ff.gen.length / 6} 段 差 ${eg.toExponential(1)}；锥面 ${ff.face && ff.face.length / 9} 片 差 ${ef.toExponential(1)}`)
  ok(ff.gen && ff.gen[0] === 0 && ff.gen[1] === 0 && ff.gen[2] === 0, `③ ${nm}：母线起点恰是锚点（相对 0）`)
}

// —— ④ emitCone 与改造前的内联写法逐位相同 ——
{
  const { g, pv } = stateOf(ISS, T0)
  const gd = sat.eciToGeodetic(pv.position, g), ecf = sat.eciToEcf(pv.position, g)
  const ring = footprintRing([ecf.x, ecf.y, ecf.z], gd.height, 40, { mode: 'elev', elevDeg: 5 })
  const rv = ring.map((q) => llaToVec(q.lat, q.lon, LIFT)), apex = llaToVec(sat.degreesLat(gd.latitude), sat.degreesLong(gd.longitude), gd.height)
  for (const genCount of [1, 7, 12.6, 400]) {
    const f1 = createSink(), g1 = createSink(), f2 = createSink(), g2 = createSink()
    emitCone(apex, rv, { faceOn: true, genCount, genDash: 'dashdot' }, f1, g1)
    coneFace(apex, rv, f2)
    const m = rv.length - 1, k = Math.max(1, Math.min(m, Math.round(genCount)))
    for (let j = 0; j < k; j++) pushDashed(g2, [apex, rv[Math.round(j * m / k) % m]], 'dashdot')
    const same = (a, b) => a.n === b.n && a.a.subarray(0, a.n).every((v, i) => v === b.a[i])
    ok(same(f1, f2) && same(g1, g2), `④ emitCone（母线 ${genCount} 根）与原内联写法逐位相同`)
  }
}

// —— ⑤ 虚线相位钉在主星上；实线档首尾相接 ——
{
  const { g, st } = stateOf(ISS, T0)
  const d = new Date(T0)
  for (const dash of ['dash', 'dot', 'dashdot']) {
    const ff = followFocusGeom(ISS, d, g, st.anchor, { orbOn: true, orbDash: dash, coneOn: false })
    // 两支各自从锚点起画：相对坐标 (0,0,0) 恰作为某两段线段的起点出现两次
    let zeros = 0
    for (let i = 0; i < ff.orb.length; i += 6) if (ff.orb[i] === 0 && ff.orb[i + 1] === 0 && ff.orb[i + 2] === 0) zeros++
    ok(zeros === 2, `⑤ 虚线档 ${dash}：两支都从主星起画（锚点处是一段「画」）`, `起点在锚点的线段 ${zeros} 条`)
  }
  const ff = followFocusGeom(ISS, d, g, st.anchor, { orbOn: true, orbDash: 'solid', coneOn: false })
  let gaps = 0
  const segs = ff.orb
  for (let i = 6; i < segs.length; i += 6) {
    const cont = segs[i] === segs[i - 3] && segs[i + 1] === segs[i - 2] && segs[i + 2] === segs[i - 1]
    const rest = segs[i] === 0 && segs[i + 1] === 0 && segs[i + 2] === 0   // 第二支重新从锚点起
    if (!cont && !rest) gaps++
  }
  ok(gaps === 0, '⑤ 实线档：线段首尾相接，只在锚点处换支')
}

// —— ⑥ 逐拍耗时 ——
{
  for (const [nm, rec] of [['GEO', GEO], ['ISS', ISS], ['Molniya', MOL]]) {
    const { g, st } = stateOf(rec, T0), d = new Date(T0)
    const o = { orbOn: true, orbDash: 'solid', coneOn: true, faceOn: true, genCount: 8, genDash: 'solid', fp: { mode: 'beam', beamDeg: 30 }, fpSeg: 72 }
    for (let w = 0; w < 5; w++) followFocusGeom(rec, d, g, st.anchor, o)
    const N = 40, t0 = performance.now()
    for (let w = 0; w < N; w++) followFocusGeom(rec, d, g, st.anchor, o)
    const ms = (performance.now() - t0) / N
    ok(ms < 5, `⑥ ${nm}：一拍的主星聚焦几何 < 5 ms`, `${ms.toFixed(2)} ms`)
  }
}

console.log(fails ? `\n${fails} 项失败` : '\n全部通过')
process.exit(fails ? 1 : 0)
