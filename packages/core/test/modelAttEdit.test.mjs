// 姿态律编辑逻辑（src/viz/models/attEdit.js，覆盖分析「天线 boresight · 姿态 + 挂点」一节 GrdAttitudeFields.vue 用）。
// 判据一律拿消费端 attitude.attitudeBasisEcef 现算对拍，不拿本文件自己的式子验自己：
//   ① 欧拉角 ↔ 四元数：quatFromEulerZYX 与 inertial 律的 eulerDeg 同一姿态（< 1e-12）；eulerZYXFromQuat 往返（含万向节锁）
//   ② 缺省推导：defaultSecondary / effectiveSecondary / secondaryAxisVec 显式写进参数后，消费端解出的姿态与不写逐位一致；
//      secondaryConflict ⇔ 消费端在一般几何下退链（fallback）
//   ③ 冻结：freezeQuat(此刻本体) 喂回 inertial 律（同一 GMST）与原姿态重合 < 1e-12（五律 × LEO / GEO / 固定星）；
//      withLaw 切惯性律落的是取整后的欧拉角（1e-6°），重合 < 1e-7 rad
//   ④ 切目标律：补的地球站 = 主轴此刻的落地点，切过去那一刻主轴指向不变（< 1e-8 rad）；已有目标 / 姿态不覆盖；参数照留
//   ⑤ 偏置 0 不落键；换给法（欧拉角 ↔ 四元数）姿态不变；改四元数分量后归一、全零不改
//   ⑥ 目标：地球站改坐标去站名、选城市带站名、经度归一；空间点地心球面往返；卫星键；targetView 与 schema 归一相容
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const AE = await import(SRC + 'models/attEdit.js')
const AT = await import(CORE + 'models/attitude.mjs')
const S = await import(CORE + 'models/schema.mjs')
const W = await import(SRC + 'wgs84.js')

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const D2R = Math.PI / 180
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const ang = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b))
const basisAng = (a, b) => Math.max(ang(a.X, b.X), ang(a.Y, b.Y), ang(a.Z, b.Z))
let seed = 20261006
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const rndUnit = () => { for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; const l = len(v); if (l > 0.1 && l < 1) return v.map((x) => x / l) } }
function orbitPoint(a, iDeg, raanDeg, uDeg) {
  const i = iDeg * D2R, O = raanDeg * D2R, u = uDeg * D2R, v = Math.sqrt(398600.4418 / a)
  const P = [Math.cos(O), Math.sin(O), 0], Q = [-Math.sin(O) * Math.cos(i), Math.cos(O) * Math.cos(i), Math.sin(i)]
  return { r: [0, 1, 2].map((k) => a * (Math.cos(u) * P[k] + Math.sin(u) * Q[k])), v: [0, 1, 2].map((k) => v * (-Math.sin(u) * P[k] + Math.cos(u) * Q[k])) }
}
const T0 = Date.UTC(2026, 9, 6, 4, 0, 0)
// 三种星位口径：LEO（带速度、给 GMST）/ GEO（带速度）/ 固定星（只给 rEcef，GMST 按 tMs 现算 —— 与 bodyRuntime 的 rEcef 路同口径）
const CTXS = [
  (() => { const o = orbitPoint(6378.137 + 550, 53, 40, 77); return { name: 'LEO', rEcef: o.r, vInertialEcef: o.v, gmstRad: 1.234, tMs: T0 } })(),
  (() => { const o = orbitPoint(42164.17, 0.05, 0, 105.5); return { name: 'GEO', rEcef: o.r, vInertialEcef: o.v, gmstRad: 4.321, tMs: T0 } })(),
  { name: '固定星', rEcef: W.geodeticToEcef(115.5, 0, 35786), tMs: T0 }
]
const sunOf = (tMs) => AT.sunEcefApprox(tMs, [0, 0, 0])
const gmstOf = (c) => (Number.isFinite(c.gmstRad) ? c.gmstRad : AT.gmstRadAt(c.tMs))
const lawCtx = (c, extra) => ({ ...c, sunEcef: sunOf(c.tMs), ...extra })

t('① quatFromEulerZYX 与 inertial 律的 eulerDeg 同一姿态（< 1e-12）；eulerZYXFromQuat 往返（含俯仰 ±90° 万向节锁：姿态重合）', () => {
  const ctx = lawCtx(CTXS[0])
  for (let k = 0; k < 400; k++) {
    const e = { yaw: rnd() * 360 - 180, pitch: rnd() * 178 - 89, roll: rnd() * 360 - 180 }
    if (k === 0) e.pitch = 90
    if (k === 1) e.pitch = -90
    const q = AE.quatFromEulerZYX(e)
    const bE = AT.attitudeBasisEcef('inertial', { eulerDeg: e }, ctx), bQ = AT.attitudeBasisEcef('inertial', { q }, ctx)
    assert.ok(basisAng(bE, bQ) < 1e-12, `欧拉角 ↔ 四元数同姿态 ${JSON.stringify(e)}`)
    const e2 = AE.eulerZYXFromQuat(q)
    const b2 = AT.attitudeBasisEcef('inertial', { eulerDeg: e2 }, ctx)
    assert.ok(basisAng(bE, b2) < 1e-9, `往返同姿态 ${JSON.stringify(e)} → ${JSON.stringify(e2)}`)
    if (Math.abs(e.pitch) < 89) for (const kk of ['yaw', 'pitch', 'roll']) assert.ok(Math.abs(e2[kk] - e[kk]) < 1e-9, `非锁区角度逐个往返 ${kk}`)
  }
})

t('② 缺省推导与消费端一致：主轴 / 次约束 / 次约束轴显式写出后姿态逐位不变；secondaryConflict ⇔ 消费端退链', () => {
  let conflicts = 0
  for (const law of ['sun', 'target']) {
    for (const c of CTXS) {
      const ctx = lawCtx(c, { targetEcef: W.geodeticToEcef(116.4, 39.9, 0) })
      for (const ax of [undefined, ...AE.AXES]) {
        for (const sec of [undefined, ...AE.SECONDARIES]) {
          if (law === 'sun' && sec === 'sun') continue                       // 主次世界方向同为太阳：面板里禁选
          const p = {}
          if (ax) p.axis = AE.axisVec(ax)
          if (sec) p.secondary = sec
          const b0 = AT.attitudeBasisEcef(law, p, ctx)
          const conflict = AE.secondaryConflict(law, p)
          if (conflict) { conflicts++; assert.equal(b0.fallback, true, `${law} ${ax} ${sec}：本体轴平行 → 消费端退链`); continue }
          assert.equal(b0.fallback, false, `${law} ${ax} ${sec}：不平行 → 不退链`)
          const pe = { axis: AE.primaryAxisVec(law, p), secondary: AE.effectiveSecondary(law, p), secondaryAxis: AE.secondaryAxisVec(law, p) }
          const b1 = AT.attitudeBasisEcef(law, pe, ctx)
          for (const k of ['X', 'Y', 'Z']) for (let i = 0; i < 3; i++) assert.equal(b1[k][i], b0[k][i], `${law} ${ax} ${sec} 显式缺省逐位 ${k}${i}`)
          assert.equal(AE.primaryAxisKey(law, p), ax || (law === 'sun' ? '-Z' : '+Z'))
        }
      }
    }
  }
  assert.ok(conflicts > 0, '覆盖到了平行组合')
  // 显式次约束轴与主轴平行
  assert.equal(AE.secondaryConflict('target', { axis: [0, 0, 1], secondary: 'velocity', secondaryAxis: [0, 0, -1] }), true)
  assert.equal(AE.secondaryConflict('nadir', {}), false, '只有 sun / target 有次约束')
  assert.equal(AE.primaryAxisKey('sun', { axis: [0.6, 0.8, 0] }), '', '非坐标轴 → 自定义')
  assert.equal(AE.axisKeyOf([0, 0, -2]), '-Z'); assert.equal(AE.axisKeyOf('+Y'), '+Y'); assert.equal(AE.axisKeyOf('+W'), '')
})

t('③ 冻结：freezeQuat(此刻本体) 喂回 inertial 律（同一 GMST）与原姿态重合 < 1e-12；withLaw 落取整欧拉角 < 1e-7 rad', () => {
  const laws = [['nadir', { rollBiasDeg: 0.7, pitchBiasDeg: -1.2, yawBiasDeg: 33 }], ['yawSteer', {}], ['sun', { axis: [0, 1, 0] }], ['target', { secondary: 'orbitNormal' }], ['inertial', { eulerDeg: { yaw: 10, pitch: 20, roll: 30 } }]]
  for (const c of CTXS) {
    const ctx = lawCtx(c, { targetEcef: W.geodeticToEcef(100, 30, 0) })
    for (const [law, p] of laws) {
      const b = AT.attitudeBasisEcef(law, p, ctx)
      const sd = { X: b.X, Y: b.Y, Z: b.Z, S: c.rEcef, gmstRad: gmstOf(c) }
      const q = AE.freezeQuat(sd)
      const bq = AT.attitudeBasisEcef('inertial', { q }, ctx)
      assert.ok(basisAng(bq, b) < 1e-12, `${c.name} ${law}：冻结四元数`)
      const a1 = AE.withLaw({ law, params: { ...p } }, 'inertial', sd)
      assert.equal(a1.law, 'inertial')
      if (law === 'inertial') { assert.deepEqual(a1.params.eulerDeg, p.eulerDeg, '已有惯性姿态不覆盖'); continue }
      const be = AT.attitudeBasisEcef('inertial', a1.params, ctx)
      assert.ok(basisAng(be, b) < 1e-7, `${c.name} ${law}：切惯性律视轴不跳`)
      for (const k of Object.keys(p)) assert.deepEqual(a1.params[k], p[k], `切律参数照留 ${k}`)
      assert.equal(S.normalizeAttitude(a1).errors.length, 0, '落下去的参数过得了 schema')
    }
  }
})

t('④ 切目标律：补的地球站 = 主轴此刻落地点，切过去主轴指向不变；已有目标不覆盖；没有 seed 不补', () => {
  for (const c of CTXS) {
    for (const axis of [undefined, [1, 0, 0]]) {
      const ctx = lawCtx(c)
      const p0 = { rollBiasDeg: 2, pitchBiasDeg: -3 }
      if (axis) p0.axis = axis
      const b = AT.attitudeBasisEcef('nadir', p0, ctx)
      const sd = { X: b.X, Y: b.Y, Z: b.Z, S: c.rEcef, gmstRad: gmstOf(c) }
      const a1 = AE.withLaw({ law: 'nadir', params: p0 }, 'target', sd)
      const tgt = a1.params.target
      assert.equal(tgt.kind, 'station'); assert.equal(tgt.altM, 0)
      const prim = axis || [0, 0, 1]
      const dirNow = [0, 1, 2].map((i) => prim[0] * b.X[i] + prim[1] * b.Y[i] + prim[2] * b.Z[i])
      const hit = W.rayEllipsoid(c.rEcef, dirNow)
      const T = W.geodeticToEcef(tgt.lonDeg, tgt.latDeg, 0)
      const bt = AT.attitudeBasisEcef('target', a1.params, { ...ctx, targetEcef: T })
      const dirAfter = [0, 1, 2].map((i) => prim[0] * bt.X[i] + prim[1] * bt.Y[i] + prim[2] * bt.Z[i])
      // 容差按式子算：站址经纬取整到 1e-6°（每个 ≤ 0.5e-6°）→ 地面偏 ≤ √2·0.5e-6°·R，再除以斜距（LEO 550 km ≈ 1.4e-7 rad、GEO ≈ 2e-9 rad）
      const tol = 1.5 * Math.SQRT2 * 0.5e-6 * D2R * W.A / (hit ? len([hit[0] - c.rEcef[0], hit[1] - c.rEcef[1], hit[2] - c.rEcef[2]]) : 1)
      if (hit) assert.ok(ang(dirAfter, dirNow) < tol, `${c.name} 轴 ${axis || '+Z'}：主轴指向不跳（${ang(dirAfter, dirNow)} vs ${tol}）`)
      else assert.ok(Math.abs(tgt.latDeg) <= 90, '越地平 → 星下点')
      assert.equal(a1.params.rollBiasDeg, 2, '切律参数照留')
      assert.equal(S.normalizeAttitude(a1).errors.length, 0, '过得了 schema')
    }
  }
  const keep = AE.withLaw({ law: 'nadir', params: { target: { kind: 'sat', satKey: 'norad:1' } } }, 'target', { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], S: [7000, 0, 0], gmstRad: 0 })
  assert.deepEqual(keep.params.target, { kind: 'sat', satKey: 'norad:1' }, '已有目标不覆盖')
  assert.equal(AE.withLaw({ law: 'nadir', params: {} }, 'target', null).params.target, undefined, '没有 seed 不补')
  assert.equal(AE.withLaw({ law: 'nadir', params: {} }, 'bogus').law, 'nadir', '非法律名不动')
})

t('⑤ 偏置 0 不落键；换给法姿态不变；改四元数分量后归一、全零不改', () => {
  let a = AE.withBias({ law: 'nadir', params: {} }, 'rollBiasDeg', 1.5)
  assert.deepEqual(a.params, { rollBiasDeg: 1.5 })
  a = AE.withBias(a, 'rollBiasDeg', 0); assert.deepEqual(a.params, {}, '0 → 删键')
  a = AE.withBias(a, 'pitchBiasDeg', null); assert.deepEqual(a.params, {})
  a = AE.withBias(a, 'bogus', 3); assert.deepEqual(a.params, {}, '非偏置键不收')
  const ctx = lawCtx(CTXS[0])
  const e0 = { yaw: 30, pitch: 10, roll: -5 }
  const aq = AE.withInertialMode({ law: 'inertial', params: { eulerDeg: e0 } }, 'q')
  assert.ok(Array.isArray(aq.params.q) && aq.params.eulerDeg === undefined)
  const b0 = AT.attitudeBasisEcef('inertial', { eulerDeg: e0 }, ctx)
  assert.ok(basisAng(AT.attitudeBasisEcef('inertial', aq.params, ctx), b0) < 1e-8, '欧拉角 → 四元数姿态不变')
  const ae = AE.withInertialMode(aq, 'euler')
  assert.ok(ae.params.q === undefined && basisAng(AT.attitudeBasisEcef('inertial', ae.params, ctx), b0) < 1e-7, '再换回欧拉角姿态不变')
  for (const k of ['yaw', 'pitch', 'roll']) assert.ok(Math.abs(ae.params.eulerDeg[k] - e0[k]) < 1e-6, k)
  const a3 = AE.withQuat({ law: 'inertial', params: { q: [0, 0, 0, 1] } }, 0, 1)
  assert.ok(Math.abs(Math.hypot(...a3.params.q) - 1) < 1e-12 && Math.abs(a3.params.q[0] - Math.SQRT1_2) < 1e-9, '改一个分量后整体归一')
  assert.equal(S.normalizeAttitude(a3).errors.length, 0)
  const z = AE.withQuat({ law: 'inertial', params: { q: [0, 0, 0, 1] } }, 3, 0)
  assert.deepEqual(z.params.q, [0, 0, 0, 1], '全零归一不了：不改')
  const e1 = AE.withEuler({ law: 'inertial', params: { q: aq.params.q } }, 'yaw', 45)
  assert.ok(e1.params.q === undefined && Math.abs(e1.params.eulerDeg.yaw - 45) < 1e-12 && Math.abs(e1.params.eulerDeg.pitch - 10) < 1e-6, '改欧拉角从当前姿态起（q 先换算）')
  const ax = AE.withAxis({ law: 'sun', params: {} }, 'axis', '+Y'); assert.deepEqual(ax.params.axis, [0, 1, 0])
  assert.equal(AE.withAxis(ax, 'axis', '').params.axis, undefined, "'' = 回缺省")
  assert.equal(AE.withParam({ law: 'yawSteer', params: { sunSide: '-X' } }, 'sunSide', null).params.sunSide, undefined)
})

t('⑥ 目标：地球站改坐标去站名、选城市带站名、经度归一；空间点地心球面往返；卫星键；过得了 schema', () => {
  let a = AE.withStation({ law: 'target', params: {} }, { lat: 39.9, lon: 116.4, name: '北京' })
  assert.deepEqual(a.params.target, { kind: 'station', latDeg: 39.9, lonDeg: 116.4, altM: 0, name: '北京' })
  a = AE.withStation(a, { altM: 50 }); assert.equal(a.params.target.name, '北京', '改站高不去站名'); assert.equal(a.params.target.altM, 50)
  a = AE.withStation(a, { lat: 40 }); assert.equal(a.params.target.name, undefined, '改坐标去站名')
  a = AE.withStation(a, { lon: 200 }); assert.equal(a.params.target.lonDeg, -160, '经度归到 (−180, 180]')
  assert.equal(S.normalizeAttitude(a).errors.length, 0)
  const v = AE.targetView(a.params)
  assert.deepEqual([v.kind, v.lat, v.lon, v.altM], ['station', 40, -160, 50])
  let p = AE.withSpacePoint(a, null)
  let pv = AE.targetView(p.params)
  assert.equal(pv.kind, 'ecef'); assert.ok(Math.abs(pv.lat - 40) < 1e-6 && Math.abs(pv.lon + 160) < 1e-6 && Math.abs(pv.altKm) < 1e-6, '地球站 → 空间点：经纬照搬、高度 0')
  p = AE.withSpacePoint(p, { altKm: 35786, lat: 0, lon: 105 })
  pv = AE.targetView(p.params)
  assert.ok(Math.abs(pv.altKm - 35786) < 1e-6 && Math.abs(pv.lat) < 1e-9 && Math.abs(pv.lon - 105) < 1e-6, '空间点往返')
  const P = W.geocentricToEcef(105, 0, 35786)
  assert.ok(len([P[0] - p.params.target.ecefKm[0], P[1] - p.params.target.ecefKm[1], P[2] - p.params.target.ecefKm[2]]) < 1e-5, '与手动「空间点」同一口径（geocentricToEcef）')
  assert.equal(S.normalizeAttitude(p).errors.length, 0)
  const back = AE.withStation(p, null)
  assert.equal(AE.targetView(back.params).kind, 'station', '空间点 → 地球站')
  const s = AE.withTargetSat(back, 'norad:25544')
  assert.deepEqual(s.params.target, { kind: 'sat', satKey: 'norad:25544' })
  assert.equal(AE.withTargetSat(s, '').params.target.satKey, 'norad:25544', '空键不改')
  assert.equal(S.normalizeAttitude(s).errors.length, 0)
  assert.equal(AE.targetView({}).kind, '')
  // 没目标时改地球站：从 seed 的落地点起
  const sd = { X: [0, 1, 0], Y: [0, 0, -1], Z: [-1, 0, 0], S: [42164.17, 0, 0], gmstRad: 0 }
  const fresh = AE.withStation({ law: 'target', params: {} }, { altM: 10 }, sd)
  assert.ok(Math.abs(fresh.params.target.latDeg) < 1e-6 && Math.abs(fresh.params.target.lonDeg) < 1e-6 && fresh.params.target.altM === 10, '从 seed 落地点（0°E 天底）起')
  const aim = AE.aimOf(sd, [0, 0, 1])
  assert.ok(Math.abs(aim.lat) < 1e-6 && Math.abs(aim.lon) < 1e-6)
  const sky = AE.aimOf(sd, [0, 0, -1])                               // 背对地球：越地平取星下点
  assert.ok(Math.abs(sky.lat) < 1e-6 && Math.abs(sky.lon) < 1e-6)
})

console.log(`modelAttEdit: ${n} 项通过`)
