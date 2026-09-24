// 模型工作台「分析」页纯计算（src/model/analysisCore.js）单测：时间网格、逐拍星位 / 姿态 / 挂点轴、视线与地球遮挡、万向节序列、
// 功率序列（与 power.sunGeometrySeries 同一条路逐位对拍）、星侧太阳侵入采样包、区段与读数、分块取消。
// 轨道用合成的解析星位（赤道 GEO 定点 / 圆 LEO），不碰 SGP4——分析页的取位只经 stateAt 回调进来（页面里是 satPos.posAt）。
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const imp = (p) => import(pathToFileURL(path.join(HERE, p)).href)
const A = await imp('../../../src/model/analysisCore.js')
const ATT = await imp('../models/attitude.mjs')
const PW = await imp('../models/power.mjs')
const GB = await imp('../models/gimbal.mjs')
const SCH = await imp('../models/schema.mjs')
const MASK = await imp('../models/mask.mjs')
const ML = await imp('../../../src/model/mountLogic.js')

let n = 0
const ok = async (name, fn) => { await fn(); n++ }
const near = (a, b, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} ≠ ${b}`)
const nearV = (a, b, tol = 1e-9, msg = '') => { assert.equal(a.length, b.length, msg); for (let i = 0; i < a.length; i++) near(a[i], b[i], tol, msg + '[' + i + ']') }
const D2R = Math.PI / 180
const W = ATT.OMEGA_EARTH_RAD_S
const RS_GEO = 42164.17
const T0 = Date.UTC(2026, 2, 20, 0, 0, 0)   // 春分附近（GEO 有地影）

// 赤道 GEO 定点 λ：ECEF 位置不变，惯性速度的 ECEF 分量 = ω × r
const geoState = (lonDeg) => () => {
  const l = lonDeg * D2R, r = [RS_GEO * Math.cos(l), RS_GEO * Math.sin(l), 0]
  return { rEcef: r, vEcef: [-W * r[1], W * r[0], 0], gmstRad: NaN }
}
// 圆 LEO（惯性系倾角 i、升交点赤经 Ω），ECEF = 绕极轴转 −GMST（与 satellite.js eciToEcf 同式）
const leoState = (altKm, incDeg, raanDeg) => (t) => {
  const a = 6378.137 + altKm, nMot = Math.sqrt(398600.4418 / (a * a * a))
  const u = nMot * (t - T0) / 1000, i = incDeg * D2R, O = raanDeg * D2R
  const pI = [Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i), Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i), Math.sin(u) * Math.sin(i)].map((x) => x * a)
  const vs = nMot * a
  const vI = [-Math.cos(O) * Math.sin(u) - Math.sin(O) * Math.cos(u) * Math.cos(i), -Math.sin(O) * Math.sin(u) + Math.cos(O) * Math.cos(u) * Math.cos(i), Math.cos(u) * Math.sin(i)].map((x) => x * vs)
  const g = ATT.gmstRadAt(t), c = Math.cos(g), s = Math.sin(g)
  return { rEcef: [pI[0] * c + pI[1] * s, -pI[0] * s + pI[1] * c, pI[2]], vEcef: [vI[0] * c + vI[1] * s, -vI[0] * s + vI[1] * c, vI[2]], gmstRad: g }
}

await ok('时间网格：含两端、末拍不齐步长补 t1；超上限 / 坏参返回 null', () => {
  const g = A.timeGrid(T0, T0 + 86400e3, 60)
  assert.equal(g.length, 1441); assert.equal(g[0], T0); assert.equal(g[1440], T0 + 86400e3)
  const h = A.timeGrid(T0, T0 + 100e3, 30)
  assert.deepEqual(Array.from(h), [T0, T0 + 30e3, T0 + 60e3, T0 + 90e3, T0 + 100e3])
  assert.equal(A.timeGrid(T0, T0 + 86400e3 * 30, 1), null, '超 200 万拍')
  assert.equal(A.timeGrid(T0, T0, 60), null); assert.equal(A.timeGrid(T0, T0 + 1, 0), null)
})

await ok('星位 + 姿态（nadir）：+Z 指地心、+X 沿速度；缺拍记 NaN 不中断', async () => {
  const tMs = A.timeGrid(T0, T0 + 3600e3, 600)
  const st = await A.sampleStates((t) => (t === tMs[3] ? null : leoState(550, 53, 20)(t)), tMs)
  assert.equal(st.nOk, tMs.length - 1); assert.equal(st.ok[3], 0)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  for (let i = 0; i < tMs.length; i++) {
    if (!st.ok[i]) { assert.equal(B.ok[i], 0); assert.ok(Number.isNaN(B.Z[3 * i])); continue }
    const r = [st.r[3 * i], st.r[3 * i + 1], st.r[3 * i + 2]], rl = Math.hypot(...r)
    nearV([B.Z[3 * i], B.Z[3 * i + 1], B.Z[3 * i + 2]], r.map((x) => -x / rl), 1e-12, 'Z = −r̂')
    const v = [st.v[3 * i], st.v[3 * i + 1], st.v[3 * i + 2]]
    assert.ok(B.X[3 * i] * v[0] + B.X[3 * i + 1] * v[1] + B.X[3 * i + 2] * v[2] > 0, 'X 朝速度一侧')
    // 太阳 = sunEcefApprox
    nearV([B.sun[3 * i], B.sun[3 * i + 1], B.sun[3 * i + 2]], ATT.sunEcefApprox(tMs[i]), 1e-15)
  }
})

await ok('挂点轴：赤道 GEO + nadir + 缺省挂点（视轴 +Z、up −Y）→ 视轴指地心、up 指北（D1），与 attitude.mountBasisEcef 逐位相同', async () => {
  const tMs = A.timeGrid(T0, T0 + 7200e3, 900)
  const st = await A.sampleStates(geoState(100), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  const m = SCH.defaultMount({ id: 'a' })
  const ax = A.mountAxesSeries(B, m)
  const f = ATT.mountFrame(m)
  for (let i = 0; i < tMs.length; i++) {
    nearV([ax.z[3 * i], ax.z[3 * i + 1], ax.z[3 * i + 2]], [-Math.cos(100 * D2R), -Math.sin(100 * D2R), 0], 1e-12, 'z')
    nearV([ax.y[3 * i], ax.y[3 * i + 1], ax.y[3 * i + 2]], [0, 0, 1], 1e-12, 'up = 北')
    const basis = { X: [B.X[3 * i], B.X[3 * i + 1], B.X[3 * i + 2]], Y: [B.Y[3 * i], B.Y[3 * i + 1], B.Y[3 * i + 2]], Z: [B.Z[3 * i], B.Z[3 * i + 1], B.Z[3 * i + 2]] }
    const ref = ATT.mountBasisEcef(basis, f)
    nearV([ax.x[3 * i], ax.x[3 * i + 1], ax.x[3 * i + 2]], ref.x, 0); nearV([ax.z[3 * i], ax.z[3 * i + 1], ax.z[3 * i + 2]], ref.z, 0)
  }
})

await ok('视线：星下站仰角 90°；高纬站仰角低于门限记不可见；星间被地球挡住记不可见；本体系方向 = 视线 · 本体三轴', async () => {
  const tMs = A.timeGrid(T0, T0 + 600e3, 300)
  const st = await A.sampleStates(geoState(100), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  const sub = A.stationTarget({ latDeg: 0, lonDeg: 100, elMinDeg: 5 })
  const l1 = A.losSeries(st, sub)
  near(l1.elDeg[0], 90, 1e-5, 'asin 在 90° 附近的舍入'); assert.equal(l1.vis[0], 1); near(l1.rangeKm[0], RS_GEO - 6378.137, 1e-6)
  const polar = A.losSeries(st, A.stationTarget({ latDeg: 80, lonDeg: 100, elMinDeg: 5 }))
  assert.ok(polar.elDeg[0] < 5 && polar.vis[0] === 0, '纬度 80° 看 GEO 仰角 ' + polar.elDeg[0])
  const dirs = A.toBodySeries(l1.los, B, l1.vis)
  nearV([dirs[0], dirs[1], dirs[2]], [0, 0, 1], 1e-9, '星下站 = 本体 +Z')
  // 星间：两颗 GEO 相隔 180°（被地球挡）/ 相隔 30°（通）
  const st2 = await A.sampleStates(geoState(280), tMs), st3 = await A.sampleStates(geoState(130), tMs)
  assert.equal(A.losSeries(st, { kind: 'sat', r: st2.r, ok: st2.ok }).vis[0], 0)
  assert.equal(A.losSeries(st, { kind: 'sat', r: st3.r, ok: st3.ok }).vis[0], 1)
})

await ok('万向节：GEO 对地 X-Y ±9° 看得到的站可跟踪、看不到的超限；状态条与灰带区段按中点切', async () => {
  const tMs = A.timeGrid(T0, T0 + 3600e3, 60)
  const st = await A.sampleStates(geoState(100), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  const m = SCH.defaultMount({ id: 'spot', gimbal: { type: 'xy', limits: { a1Min: -9, a1Max: 9, a2Min: -9, a2Max: 9 } } })
  const near1 = A.losSeries(st, A.stationTarget({ latDeg: 30, lonDeg: 110 }))
  const r1 = A.gimbalTrack(tMs, A.toBodySeries(near1.los, B, near1.vis), m, null)
  near(r1.trackableFrac, 1, 1e-12); assert.equal(r1.counts.limit, 0); assert.equal(r1.nTarget, tMs.length)
  const m2 = SCH.defaultMount({ id: 'spot2', gimbal: { type: 'xy', limits: { a1Min: -1, a1Max: 1, a2Min: -1, a2Max: 1 } } })
  const r2 = A.gimbalTrack(tMs, A.toBodySeries(near1.los, B, near1.vis), m2, null)
  near(r2.trackableFrac, 0, 1e-12); assert.equal(r2.counts.limit, tMs.length)
  near(r2.longestOutageMin, 60, 1e-9)
  const strip = A.gimbalStrip(tMs, r2.series.reason)
  assert.equal(strip.length, 1); assert.equal(strip[0].style, 'badHatch'); assert.equal(strip[0].t0, T0); assert.equal(strip[0].t1, T0 + 3600e3)
  // 掩模：把本体 +Z 半球全挡上 → 可跟踪的拍全变成遮挡
  const mk = MASK.createMask()
  for (let e = 90; e <= 180; e++) for (let a = 0; a < 360; a++) mk.blocked[e * 360 + a] = 1
  const r3 = A.gimbalTrack(tMs, A.toBodySeries(near1.los, B, near1.vis), m, A.maskFn(mk))
  assert.equal(r3.counts.mask, tMs.length)
  assert.equal(A.maskFn(null), null)
})

await ok('功率：sunBodySeries + powerSeries 与 power.sunGeometrySeries + arrayPowerSeries 逐位相同（同一套姿态律、太阳、地影）', async () => {
  const tMs = A.timeGrid(T0, T0 + 86400e3, 120)
  const sf = leoState(700, 98.2, 30)
  const st = await A.sampleStates(sf, tMs)
  const law = { law: 'yawSteer', params: {} }
  const B = await A.attitudeSeries(law, st, tMs)
  const sb = A.sunBodySeries(st, B, tMs)
  const panels = [{ name: 'zen', group: 'Z', normalBody: [0, 0, -1], areaM2: 10, efficiencyPct: 30, articulation: null },
    { name: 'wing', group: 'W', normalBody: [0, 0, -1], areaM2: 20, efficiencyPct: 28, articulation: { name: 'sada', axisBody: [0, 1, 0], pointingBody: null, minDeg: -180, maxDeg: 180, initialDeg: 0, track: true } }]
  const p = A.powerSeries(panels, tMs, sb)
  const ref = PW.sunGeometrySeries({ tMs, rEcef: st.r, vInertialEcef: st.v, gmstRad: st.gmst, law: law.law, params: law.params })
  nearV(sb.sunBody, ref.sunBody, 0, 'sunBody')
  nearV(sb.eclipse, ref.eclipse, 0, 'eclipse')
  const p2 = PW.arrayPowerSeries({ panels, tMs, sunBody: ref.sunBody, eclipse: ref.eclipse, auDist: ref.auDist })
  nearV(p.W, p2.W, 0, 'W'); near(p.meanW, p2.meanW, 0)
  assert.ok(p.eclipseSec > 0 && p.sunlitFrac < 1, '晨昏轨道一天里仍有地影（春分）')
  assert.ok(p.groups.length === 2 && p.groups[1].meanW > p.groups[0].meanW, '对日翼比固定板发电多')
})

await ok('星侧太阳侵入采样包：每样本 10 个数（t、星 ECEF、视轴、up），缺拍跳过并记下标；太阳偏轴读数', async () => {
  const tMs = A.timeGrid(T0, T0 + 3600e3, 600)
  const st = await A.sampleStates((t) => (t === tMs[2] ? null : geoState(100)(t)), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  const ax = A.mountAxesSeries(B, SCH.defaultMount({ id: 'a' }))
  const { samples, idx } = A.intrusionSamples(tMs, st, ax)
  assert.equal(idx.length, tMs.length - 1); assert.equal(samples.length, idx.length * 10)
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k], o = k * 10
    assert.equal(samples[o], tMs[i])
    nearV(Array.from(samples.subarray(o + 1, o + 4)), [st.r[3 * i], st.r[3 * i + 1], st.r[3 * i + 2]], 0)
    nearV(Array.from(samples.subarray(o + 4, o + 7)), [ax.z[3 * i], ax.z[3 * i + 1], ax.z[3 * i + 2]], 0)
    nearV(Array.from(samples.subarray(o + 7, o + 10)), [ax.y[3 * i], ax.y[3 * i + 1], ax.y[3 * i + 2]], 0)
  }
  assert.ok(!idx.includes(2))
  const off = A.sunOffAxisSeries(B, ax)
  assert.ok(Number.isNaN(off[2]) && off[0] > 60 && off[0] <= 180, '对地视轴离太阳很远：' + off[0])
})

await ok('区段 / 读数 / 分块取消', async () => {
  const t = [0, 10, 20, 30, 40, 50]
  assert.deepEqual(A.segmentsOf(t, (i) => i >= 2 && i <= 3), [{ t0: 15, t1: 35 }])
  assert.deepEqual(A.segmentsOf(t, (i) => i === 0 || i === 5), [{ t0: 0, t1: 5 }, { t0: 45, t1: 50 }])
  near(A.longestMin([{ t0: 0, t1: 60000 }, { t0: 0, t1: 30000 }]), 1)
  const s = A.seriesStats(t, [1, 3, NaN, 2, 5, 4])
  assert.deepEqual([s.min, s.max, s.argmax], [1, 5, 4])
  near(s.mean, ((1 + 3) / 2 * 10 + (2 + 5) / 2 * 10 + (5 + 4) / 2 * 10) / 30)
  const ac = new AbortController()
  let calls = 0
  const p = A.chunked(1e7, () => { calls++; if (calls === 5000) ac.abort() }, { signal: ac.signal, budgetMs: 1 })
  await assert.rejects(p, (e) => e.name === 'AbortError')
  assert.ok(calls < 1e7)
  let prog = null
  await A.chunked(10, () => {}, { onProgress: (d, N) => { prog = [d, N] } })
  assert.deepEqual(prog, [10, 10])
})

await ok('Worker 重活表 HEAVY：功率 / 万向节与逐步调用逐位相同；入参只带用到的数组、出参能结构化克隆（postMessage 往返不丢值）', async () => {
  const tMs = A.timeGrid(T0, T0 + 86400e3, 300)
  const st = await A.sampleStates(geoState(100), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  const panels = [{ name: 'wing', group: 'W', normalBody: [0, 0, -1], areaM2: 20, efficiencyPct: 28, articulation: { name: 'sada', axisBody: [0, 1, 0], pointingBody: null, minDeg: -180, maxDeg: 180, initialDeg: 0, track: true } }]
  const args = structuredClone({ panels, tMs, st: { r: st.r, ok: st.ok }, B: { X: B.X, Y: B.Y, Z: B.Z, sun: B.sun, ok: B.ok } })
  const hp = structuredClone(A.HEAVY.power(args))
  const sb = A.sunBodySeries(st, B, tMs), p = A.powerSeries(panels, tMs, sb)
  nearV(hp.eclipse, sb.eclipse, 0, 'eclipse'); nearV(hp.p.W, p.W, 0, 'W'); nearV(hp.p.groups[0].W, p.groups[0].W, 0, 'group W')
  assert.deepEqual(hp.p.daily, p.daily)
  const m = SCH.defaultMount({ id: 'spot', gimbal: { type: 'xy', limits: { a1Min: -9, a1Max: 9, a2Min: -9, a2Max: 9 } } })
  const mk = MASK.createMask()
  for (let e = 150; e <= 180; e++) for (let a = 0; a < 360; a++) mk.blocked[e * 360 + a] = 1
  const target = A.stationTarget({ latDeg: 30, lonDeg: 110, elMinDeg: 5 })
  const hg = structuredClone(A.HEAVY.gimbal(structuredClone({ tMs, st: { r: st.r, ok: st.ok }, B: { X: B.X, Y: B.Y, Z: B.Z, ok: B.ok }, target, mount: m, mask: mk, tolDeg: 0.1 })))
  const ls = A.losSeries(st, target)
  const tr = A.gimbalTrack(tMs, A.toBodySeries(ls.los, B, ls.vis), m, A.maskFn(mk), { tolDeg: 0.1 })
  nearV(hg.ls.los, ls.los, 0, 'los'); assert.deepEqual(hg.tr.counts, tr.counts); near(hg.tr.trackableFrac, tr.trackableFrac, 0)
  nearV(Array.from(hg.tr.series.reason), Array.from(tr.series.reason), 0, 'reason')
})

await ok('样本数读数 gridCount：与 timeGrid 的长度逐个相同；不分配数组（1 年 × 0.1 s 也是瞬间出数）', () => {
  for (const [h, st] of [[24, 60], [1, 30], [0.01, 7], [100 / 3600, 30], [24, 0.1], [2.5, 3.3], [8760, 3600]]) {
    const g = A.timeGrid(T0, T0 + h * 3600e3, st, Infinity)
    assert.equal(A.gridCount(T0, T0 + h * 3600e3, st), g ? g.length : 0, h + ' h / ' + st + ' s')
  }
  const t = performance.now()
  assert.equal(A.gridCount(T0, T0 + 8760 * 3600e3, 0.1), 8760 * 36000 + 1)
  assert.ok(performance.now() - t < 5, '纯算术')
  assert.equal(A.gridCount(T0, T0, 60), 0); assert.equal(A.gridCount(T0, T0 + 1, 0), 0); assert.equal(A.gridCount(NaN, T0, 1), 0)
  assert.equal(A.timeGrid(T0, T0 + 8760 * 3600e3, 0.1), null, '超上限照旧 null')
})
await ok('万向节固定天线：视场留空按方向图 −3 dB（fovFullOf），不再退回 0.1° 跟踪容差；全向 360°', async () => {
  const tMs = A.timeGrid(T0, T0 + 3600e3, 600)
  const st = await A.sampleStates(geoState(100), tMs)
  const B = await A.attitudeSeries({ law: 'nadir', params: {} }, st, tMs)
  // 固定天线、视轴天底、2.5 m @ 6.175 GHz（−3 dB 全宽 1.359°，半宽 0.68°），fov 留空 —— 默认卫星 refl_c_e 那一类
  const m = SCH.defaultMount({ id: 'fix', boresightBody: [0, 0, 1], antennaRef: { kind: 'param', spec: { diameterM: 2.5, freqGHz: 6.175, efficiency: 0.65, pattern: 'reflector' } } })
  const target = A.stationTarget({ latDeg: 2, lonDeg: 100 })
  const ls = A.losSeries(st, target)
  const off = Math.acos(Math.max(-1, Math.min(1, -(ls.los[0] * st.r[0] + ls.los[1] * st.r[1] + ls.los[2] * st.r[2]) / Math.hypot(st.r[0], st.r[1], st.r[2])))) * 180 / Math.PI
  assert.ok(off > 0.2 && off < 0.6, '目标偏视轴 ' + off.toFixed(3) + '°（在 −3 dB 锥内、远大于 0.1° 容差）')
  const args = { tMs, st: { r: st.r, ok: st.ok }, B: { X: B.X, Y: B.Y, Z: B.Z, ok: B.ok }, target, mount: m, mask: null, tolDeg: 0.1 }
  const without = A.HEAVY.gimbal(args)
  near(without.tr.trackableFrac, 0, 1e-12, '旧行为（不给 fov）：退回容差全记超限')
  const fov = ML.fovFullOf(m)
  near(fov, 20.98547 / (6.175 * 2.5), 1e-12)
  const withFov = A.HEAVY.gimbal({ ...args, fovDeg: fov })
  near(withFov.tr.trackableFrac, 1, 1e-12, '按 −3 dB 锥：全程可跟踪'); assert.equal(withFov.tr.counts.limit, 0)
  // 偏到锥外（纬度 8°，偏轴 ~1.3°）照样超限
  const far = A.stationTarget({ latDeg: 8, lonDeg: 100 })
  near(A.HEAVY.gimbal({ ...args, target: far, fovDeg: fov }).tr.trackableFrac, 0, 1e-12, '锥外超限')
  // 全向 0 dBi：任何可见方向都可跟踪
  const om = SCH.defaultMount({ id: 'omni', boresightBody: [0, 0, -1], antennaRef: { kind: 'param', spec: { freqGHz: 2.1, gainDbi: 0, pattern: 'omni' } } })
  near(A.HEAVY.gimbal({ ...args, mount: om, fovDeg: ML.fovFullOf(om) }).tr.trackableFrac, 1, 1e-12, '全向天线（视轴背地）照样可跟踪')
  // 非法 fov 当没给
  near(A.HEAVY.gimbal({ ...args, fovDeg: NaN }).tr.trackableFrac, 0, 1e-12)
})

console.log(`modelWbAnalysis: ${n} 项通过`)
