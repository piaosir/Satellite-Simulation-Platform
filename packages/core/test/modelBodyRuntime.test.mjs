// 卫星本体运行时（src/viz/models/bodyRuntime.js）：3D 页姿态显示 / GRD「姿态 + 挂点」/ 对星时段扫描共用的取数口；掩模查表口留给建模工具。
//   ① 无绑定 = nadir：本体基底与 attitude.attitudeBasisEcef('nadir') 逐位相同；qB2LFromBasis 与常量 Q_BODY2L_NADIR 差 ≤ 1e-15
//   ② yawSteer 绑定：翼轴（本体 ±Y）⟂ 太阳 < 1e-12；太阳用 sunEcefApprox(tMs)（与晨昏线同源）
//   ③ 缺省挂点（D1）：赤道 GEO「nadir + 视轴 +Z + up −Y」与 coverage.antennaBasisAzEl(0,0,0) 的 x / y / z 逐分量差 < 1e-12
//   ④ attEquivOf（D9）：任意挂点 / 偏航牵引下，等效 (boreAz, boreEl, yaw) 回代 antennaBasisAzEl 与挂点基底重合 < 1e-9
//   ⑤ target 律：地球站目标，挂点视轴指向误差 < 1e-9 rad
//   ⑥ 掩模：缺省不随绑定预取（prefetchMasks:true 才取）；getMask → decodeMask 按签名缓存；blockedAt 单挂点 / 全部挂点（任一通视即可）/ 无掩模 = null
//   ⑦ 对日扫描选档（mount.maskSun）与绑定广播重载
//   ⑧ 同一拍记一份基底：blockedAt / basisMemoAt / losBodyAt 与 attitudeBasisAt 逐位相同；换时刻 / 换位置 / 换绑定立刻失效
//   ⑨ mountAxesAt 附带项（mount / body / law）与 bindSigOf：内容签名与版本号无关、改挂点方向或姿态律才变；验证台注入口不进 Node / 打包件
// 渲染端源码用 @core/… 别名：先注册解析钩子再动态导入（写法同 modelGlobeLayer.test.mjs）。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const BR = await import(SRC + 'models/bodyRuntime.js')
const AT = await import(CORE + 'models/attitude.mjs')
const MK = await import(CORE + 'models/mask.mjs')
const COV = await import(SRC + 'grd/coverage.js')
const W = await import(SRC + 'wgs84.js')
const satMod = await import(SRC + 'constellation/satellite.js')
const sat = satMod.default || satMod

let n = 0
const t = async (name, fn) => { try { await fn() } catch (e) { console.error('FAIL ' + name); throw e } n++ }
const D2R = Math.PI / 180
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const maxDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]))
const ang = (a, b) => {
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), dot(a, b))
}
const T0 = Date.UTC(2026, 8, 24, 3, 17, 0)
// 一颗 LEO（ISS 型根数）与一颗赤道 GEO（固定星口径：只给 ECEF 位置）
const L1 = '1 25544U 98067A   26266.50000000  .00016717  00000-0  10270-3 0  9994'
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579 12345'
const leo = sat.twoline2satrec(L1, L2)
const pvAt = (rec, tMs) => sat.propagate(rec, new Date(tMs))
const geoR = W.geodeticToEcef(110.5, 0, 35786)

function fakeApi(bindings, masks = {}) {
  const ls = new Set()
  const calls = { getMask: 0, bindingsGet: 0 }
  return {
    calls,
    emit: (e) => { for (const f of ls) f(e) },
    models: {
      async bindingsGet() { calls.bindingsGet++; return JSON.parse(JSON.stringify({ schema: 1, prefs: null, bindings })) },
      async getMask(sig) { calls.getMask++; return masks[sig] ? masks[sig].slice() : null },
      onChanged(cb) { ls.add(cb); return () => ls.delete(cb) }
    }
  }
}

await t('① 无绑定 = nadir，qB2L 与常量相等', async () => {
  const rt = BR.createBodyRuntime()
  for (const tMs of [T0, T0 + 1234567]) {
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs))
    const b = rt.attitudeBasisAt('norad:25544', { pv, gmstRad: g, tMs })
    const r = sat.eciToEcf(pv.position, g), v = sat.eciToEcf(pv.velocity, g)
    const ref = AT.attitudeBasisEcef('nadir', {}, { rEcef: [r.x, r.y, r.z], vInertialEcef: [v.x, v.y, v.z], tMs })
    for (const k of ['X', 'Y', 'Z']) assert.ok(maxDiff(b[k], ref[k]) < 1e-15, k)
    const qL2S = AT.lvlhQuatScene([r.x, r.y, r.z], [v.x, v.y, v.z])
    const q = BR.qB2LFromBasis(b, qL2S)
    const d = Math.max(...q.map((x, i) => Math.abs(x - AT.Q_BODY2L_NADIR[i])))
    assert.ok(d < 1e-15, 'qB2L 差 ' + d)
  }
  assert.equal(rt.isPlainNadir('norad:25544'), true)
  assert.equal(rt.mountsFor('norad:25544').length, 0)
})

await t('② yawSteer：翼轴 ⟂ 太阳', async () => {
  const rt = BR.createBodyRuntime()
  rt.setBindings({ bindings: { 'norad:25544': { model: { id: 'auto' }, mounts: [], attitude: { law: 'yawSteer', params: {} } } } })
  assert.equal(rt.isPlainNadir('norad:25544'), false)
  let worst = 0
  for (let k = 0; k < 97; k++) {
    const tMs = T0 + k * 61000
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs))
    const b = rt.attitudeBasisAt('norad:25544', { pv, gmstRad: g, tMs })
    const s = AT.sunEcefApprox(tMs)
    worst = Math.max(worst, Math.abs(dot(b.Y, s)))
    assert.equal(b.law, 'yawSteer')
  }
  assert.ok(worst < 1e-12, '翼轴·太阳 ' + worst)
  // 固定 GEO（无速度 → ω⊕ × r），同样成立
  const b = rt.attitudeBasisAt('norad:25544', { rEcef: geoR, tMs: T0 })
  assert.ok(Math.abs(dot(b.Y, AT.sunEcefApprox(T0))) < 1e-12)
})

await t('③ 缺省挂点 = 手动天底（赤道 GEO，逐分量 < 1e-12）', async () => {
  const rt = BR.createBodyRuntime()
  for (const lon of [0, 87.5, 110.5, -75, 179.9]) {
    const S = W.geodeticToEcef(lon, 0, 35786)
    const ax = rt.mountAxesAt('grdsat:f1', '', { rEcef: S, tMs: T0 })
    const man = COV.antennaBasisAzEl(lon, 0, 35786, 0, 0, 0)
    assert.ok(maxDiff(ax.z, man.z) < 1e-12, 'z ' + lon)
    assert.ok(maxDiff(ax.up, man.y) < 1e-12, 'y ' + lon)
    assert.ok(maxDiff(ax.x, man.x) < 1e-12, 'x ' + lon)
    assert.ok(maxDiff(ax.S, S) === 0)
  }
  // 给了 id 却找不到 → null（退路由调用方定）
  assert.equal(rt.mountAxesAt('grdsat:f1', 'nope', { rEcef: geoR, tMs: T0 }), null)
})

await t('④ attEquivOf 回代 antennaBasisAzEl 重合', async () => {
  const rt = BR.createBodyRuntime()
  rt.setBindings({ bindings: {
    'norad:25544': { mounts: [{ id: 'm1', name: 'Ka', posBody: [0.5, 0, 1], boresightBody: AT.quatRotate([0, 0.3, 0, 0.954], [0, 0, 1]), upBody: [0.2, -1, 0] }], attitude: { law: 'yawSteer', params: {} } },
    'grdsat:g1': { mounts: [], attitude: { law: 'yawSteer', params: {} } }
  } })
  let worst = 0
  for (let k = 0; k < 40; k++) {
    const tMs = T0 + k * 97000
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs))
    const gd = sat.eciToGeodetic(pv.position, g)
    const lon = sat.degreesLong(gd.longitude), lat = sat.degreesLat(gd.latitude), alt = gd.height
    const S = W.geodeticToEcef(lon, lat, alt)
    const ax = rt.mountAxesAt('norad:25544', 'm1', { pv, gmstRad: g, tMs })
    for (const bias of [0, 17.5]) {
      const eq = BR.attEquivOf(ax.z, ax.up, lon, lat, alt, bias)
      const m = COV.antennaBasisAzEl(lon, lat, alt, eq.boreAz, eq.boreEl, eq.yaw)
      // 挂点基底（附加偏置 bias 绕视轴转）：x' = x cos + y sin
      const c = Math.cos(bias * D2R), s = Math.sin(bias * D2R)
      const xb = [0, 1, 2].map((i) => ax.x[i] * c + ax.up[i] * s)
      worst = Math.max(worst, maxDiff(m.z, ax.z), maxDiff(m.x, xb))
      void S
    }
  }
  // GEO 固定星 + 偏航牵引：足迹基底随时间转（yaw 变），视轴不变
  const e0 = rt.mountAxesAt('grdsat:g1', '', { rEcef: geoR, tMs: T0 }), e1 = rt.mountAxesAt('grdsat:g1', '', { rEcef: geoR, tMs: T0 + 3 * 3600e3 })
  const q0 = BR.attEquivOf(e0.z, e0.up, 110.5, 0, 35786), q1 = BR.attEquivOf(e1.z, e1.up, 110.5, 0, 35786)
  assert.ok(Math.abs(q0.boreAz) < 1e-9 && Math.abs(q0.boreEl) < 1e-9 && Math.abs(q1.boreAz) < 1e-9, '视轴仍是天底')
  const dYaw = Math.abs(((q1.yaw - q0.yaw + 540) % 360) - 180)
  assert.ok(dYaw > 20, '3 h 偏航变了 ' + dYaw.toFixed(2) + '°')
  assert.ok(worst < 1e-9, '回代残差 ' + worst)
  console.log(`  attEquiv 回代残差 ${worst.toExponential(2)}；GEO 偏航牵引 3 h 足迹钟向转 ${dYaw.toFixed(2)}°`)
})

await t('⑤ target 律（地球站）：视轴指向误差 < 1e-9 rad', async () => {
  const rt = BR.createBodyRuntime()
  const st = { kind: 'station', latDeg: 39.9, lonDeg: 116.4, altM: 50 }
  rt.setBindings({ bindings: { 'norad:25544': { mounts: [], attitude: { law: 'target', params: { target: st } } } } })
  const P = W.geodeticToEcef(116.4, 39.9, 0.05)
  let worst = 0
  for (let k = 0; k < 30; k++) {
    const tMs = T0 + k * 180000
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs))
    const ax = rt.mountAxesAt('norad:25544', '', { pv, gmstRad: g, tMs })
    const d = [P[0] - ax.S[0], P[1] - ax.S[1], P[2] - ax.S[2]]
    worst = Math.max(worst, ang(ax.z, d))
    assert.equal(ax.law, 'target')
  }
  assert.ok(worst < 1e-9, '指向误差 ' + worst)
  // 目标星：注入的解析器
  const rt2 = BR.createBodyRuntime({ resolveTargetEcef: (k) => (k === 'norad:1' ? geoR : null) })
  rt2.setBindings({ bindings: { 'norad:25544': { mounts: [], attitude: { law: 'target', params: { target: { kind: 'sat', satKey: 'norad:1' } } } } } })
  const pv = pvAt(leo, T0), g = sat.gstime(new Date(T0))
  const ax = rt2.mountAxesAt('norad:25544', '', { pv, gmstRad: g, tMs: T0 })
  assert.ok(ang(ax.z, [geoR[0] - ax.S[0], geoR[1] - ax.S[1], geoR[2] - ax.S[2]]) < 1e-9)
  // 解不到目标 → nadir 退路（fallback 标记）
  const rt3 = BR.createBodyRuntime()
  rt3.setBindings({ bindings: { 'norad:25544': { mounts: [], attitude: { law: 'target', params: { target: { kind: 'sat', satKey: 'norad:1' } } } } } })
  const a3 = rt3.mountAxesAt('norad:25544', '', { pv, gmstRad: g, tMs: T0 })
  assert.equal(a3.law, 'nadir'); assert.equal(a3.fallback, true)
})

// 半空间掩模：本体系 d_x > 0（速度方向那一半）全挡；另一张全通
function halfMask() {
  const m = MK.createMask()
  const d = [0, 0, 0]
  for (let e = 0; e < MK.MASK_H; e++) for (let a = 0; a < MK.MASK_W; a++) { MK.maskDir(a, e, d); const i = e * MK.MASK_W + a; if (d[0] > 1e-9) { m.blocked[i] = 1; m.clearance[i] = 2 } }
  return m
}
const SIG_H = 'aaaaaaaaaaaaaaaa', SIG_C = 'bbbbbbbbbbbbbbbb', SIG_F = 'cccccccccccccccc'
const clearMask = MK.createMask()
const fullMask = MK.createMask(); fullMask.blocked.fill(1); fullMask.clearance.fill(1)

await t('⑥ 掩模缓存与遮挡判据', async () => {
  const api = fakeApi({
    'norad:25544': { mounts: [
      { id: 'a', name: 'A', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG_H },
      { id: 'b', name: 'B', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG_C },
      { id: 'c', name: 'C', posBody: [0, 0, 0], boresightBody: [0, 0, 1] }
    ], attitude: { law: 'nadir', params: {} } },
    'norad:2': { mounts: [{ id: 'x', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG_F }, { id: 'y', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG_H }] }
  }, { [SIG_H]: MK.encodeMask(halfMask()), [SIG_C]: MK.encodeMask(clearMask), [SIG_F]: MK.encodeMask(fullMask) })
  const rt = BR.createBodyRuntime({ api })
  await rt.ready()
  // 缺省不随绑定预取（页面不查掩模：遮挡接入分析模块已叫停），要的时候才取；prefetchMasks:true 才绑定一到就取
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(api.calls.getMask, 0, '缺省不预取')
  const apiP = fakeApi({ 'norad:7': { mounts: [{ id: 'p', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG_C }] } }, { [SIG_C]: MK.encodeMask(clearMask) })
  const rtP = BR.createBodyRuntime({ api: apiP, prefetchMasks: true })
  await rtP.ready(); await rtP.prefetchMasks()
  assert.equal(apiP.calls.getMask, 1, 'prefetchMasks:true 绑定一到就取')
  assert.ok(rtP.maskSync('norad:7', 'p'), '预取后同步可查')
  rtP.dispose()
  await rt.ensureMasks()
  assert.equal(api.calls.getMask, 3, '三张掩模各取一次')
  const pv = pvAt(leo, T0), g = sat.gstime(new Date(T0)), ctx = { pv, gmstRad: g, tMs: T0 }
  const b = rt.attitudeBasisAt('norad:25544', ctx)
  const fwd = b.X, back = b.X.map((x) => -x)
  assert.equal(rt.blockedAt('norad:25544', 'a', ctx, fwd), true)
  assert.equal(rt.blockedAt('norad:25544', 'a', ctx, back), false)
  assert.equal(rt.blockedAt('norad:25544', 'b', ctx, fwd), false)
  assert.equal(rt.blockedAt('norad:25544', 'c', ctx, fwd), null, '无掩模的挂点不参与')
  assert.equal(rt.blockedAt('norad:25544', 'zz', ctx, fwd), null, '没有这个挂点')
  assert.equal(rt.blockedAt('norad:25544', '', ctx, fwd), false, '全部挂点：B 通视即通')
  assert.equal(rt.blockedAt('norad:2', '', ctx, fwd), true, '全部挂点：都挡才挡')
  assert.equal(rt.blockedAt('norad:2', '', ctx, back), false)
  assert.equal(rt.blockedAt('norad:9', '', ctx, fwd), null, '没有绑定')
  assert.ok(rt.maskSync('norad:25544', 'a') && rt.maskSync('norad:25544', 'a').blocked.length === MK.MASK_N)
  const mk = await rt.maskFor('norad:2', 'x')
  assert.ok(mk && mk.blocked[0] === 1)
  assert.equal(api.calls.getMask, 3, '签名缓存命中不再取')
})

await t('⑦ 对日扫描选档 + 绑定广播重载', async () => {
  const sigs = Array.from({ length: MK.SUN_SCAN_BINS }, (_, k) => (k.toString(16) + 'f'.repeat(15)).slice(0, 16))
  const masks = {}
  // 奇数档全挡、偶数档全通：选中哪一档一查便知
  sigs.forEach((s, k) => { masks[s] = MK.encodeMask(k % 2 ? fullMask : clearMask) })
  const mount = { id: 'sa', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSun: { sigs, axisBody: [0, 1, 0], pointingBody: [0, 0, -1] } }
  const api = fakeApi({ 'norad:25544': { mounts: [mount], attitude: { law: 'nadir', params: {} } } }, masks)
  const rt = BR.createBodyRuntime({ api })
  await rt.ready(); await rt.ensureMasks('norad:25544')
  let hits = 0
  for (let k = 0; k < 60; k++) {
    const tMs = T0 + k * 93000
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs)), ctx = { pv, gmstRad: g, tMs }
    const b = rt.attitudeBasisAt('norad:25544', ctx)
    const sb = AT.losToBody(AT.sunEcefApprox(tMs), b)
    const bin = MK.sunScanBin(AT.articulationSunAngle([0, 0, -1], [0, 1, 0], sb))
    assert.equal(rt.blockedAt('norad:25544', 'sa', ctx, b.Z), bin % 2 === 1)
    hits += bin % 2
  }
  assert.ok(hits > 0 && hits < 60, '两种档都走到了')
  // 绑定广播 → 重载
  let seen = 0
  rt.onChange((e) => { if (e.type === 'bindings') seen++ })
  const before = api.calls.bindingsGet
  api.emit({ type: 'bindings' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(api.calls.bindingsGet, before + 1)
  assert.ok(seen >= 1)
})

await t('⑧ 同一拍记一份基底：与现解逐位相同，换时刻 / 位置 / 绑定即失效', async () => {
  const halfMask = () => { const m = MK.createMask(); const d = [0, 0, 0]; for (let e = 0; e < MK.MASK_H; e++) for (let a = 0; a < MK.MASK_W; a++) { MK.maskDir(a, e, d); if (d[1] < -0.1) m.blocked[e * MK.MASK_W + a] = 1 } return m }
  const SIG = 'ab'.repeat(8)
  const api = fakeApi({ 'norad:25544': { mounts: [{ id: 'a', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG }, { id: 'b', posBody: [0, 0, 0], boresightBody: [0, 0, 1], maskSig: SIG }], attitude: { law: 'yawSteer', params: {} } } }, { [SIG]: MK.encodeMask(halfMask()) })
  const rt = BR.createBodyRuntime({ api })
  await rt.ready(); await rt.ensureMasks()
  let solves = 0
  for (let k = 0; k < 40; k++) {
    const tMs = T0 + k * 61000
    const pv = pvAt(leo, tMs), g = sat.gstime(new Date(tMs)), ctx = { pv, gmstRad: g, tMs }
    const ref = rt.attitudeBasisAt('norad:25544', ctx)
    // 同一拍：先按挂点逐个查、再取基底、再转视线 —— 三者都与现解逐位相同
    const los = [Math.cos(k), Math.sin(k), 0.3]
    const b1 = rt.blockedAt('norad:25544', 'a', { pv, gmstRad: g, tMs }, los)
    const b2 = rt.blockedAt('norad:25544', 'b', { pv, gmstRad: g, tMs }, los)
    const bm = rt.basisMemoAt('norad:25544', { pv, gmstRad: g, tMs })
    for (const ax of ['X', 'Y', 'Z']) assert.ok(maxDiff(bm[ax], ref[ax]) === 0, ax)
    const lb = rt.losBodyAt('norad:25544', { pv, gmstRad: g, tMs }, los)
    const want = AT.losToBody(los, ref)
    assert.ok(maxDiff(lb, want) === 0)
    // 查表结果与按现解基底自己查一遍相同
    const mk = rt.maskSync('norad:25544', 'a')
    const d = AT.losToBody(los, ref)
    assert.equal(b1, !!MK.maskLookup(mk, d)); assert.equal(b2, b1)
    if (b1) solves++
  }
  assert.ok(solves > 0 && solves < 40, '两种结果都走到了')
  // 换位置（同一时刻，固定星口径）：不许命中上一拍
  const g0 = rt.basisMemoAt('norad:25544', { rEcef: geoR, tMs: T0 })
  const geoR2 = W.geodeticToEcef(120, 0, 35786)
  const g1 = rt.basisMemoAt('norad:25544', { rEcef: geoR2, tMs: T0 })
  assert.ok(maxDiff(g0.Z, g1.Z) > 0.1, '换了星位基底必须跟着换')
  // 换绑定（同一拍）：律从偏航导引改 nadir，立刻失效
  const pv = pvAt(leo, T0), g = sat.gstime(new Date(T0))
  const ys = rt.basisMemoAt('norad:25544', { pv, gmstRad: g, tMs: T0 })
  rt.patchLocal('norad:25544', { ...rt.bindingFor('norad:25544'), attitude: { law: 'nadir', params: {} } })
  const nd = rt.basisMemoAt('norad:25544', { pv, gmstRad: g, tMs: T0 })
  const r = sat.eciToEcf(pv.position, g), v = sat.eciToEcf(pv.velocity, g)
  const ref = AT.attitudeBasisEcef('nadir', {}, { rEcef: [r.x, r.y, r.z], vInertialEcef: [v.x, v.y, v.z], tMs: T0 })
  assert.ok(maxDiff(nd.X, ref.X) < 1e-15 && maxDiff(ys.X, ref.X) > 1e-3)
})

await t('⑨ mountAxesAt 附带项与 bindSigOf；验证台注入口不进 Node', async () => {
  const mk = (bs) => ({ bindings: { 'norad:25544': { mounts: [{ id: 'm1', name: 'M1', posBody: [0, 0.4, 1], boresightBody: bs, upBody: [0, -1, 0] }], attitude: { law: 'yawSteer', params: {} } } } })
  const rt = BR.createBodyRuntime()
  rt.setBindings(mk([0, 0.1, 1]))
  const pv = pvAt(leo, T0), g = sat.gstime(new Date(T0)), ctx = { pv, gmstRad: g, tMs: T0 }
  const ax = rt.mountAxesAt('norad:25544', 'm1', ctx)
  const b = rt.attitudeBasisAt('norad:25544', ctx)
  assert.equal(ax.mount, 'm1'); assert.equal(ax.law, 'yawSteer'); assert.equal(ax.fallback, false)
  for (const k of ['X', 'Y', 'Z']) assert.ok(maxDiff(ax.body[k], b[k]) === 0, k)
  assert.equal(rt.mountAxesAt('norad:25544', '', ctx).mount, '')
  const s1 = rt.bindSigOf('norad:25544', 'm1'), s0 = rt.bindSigOf('norad:25544', '')
  assert.match(s1, /^[0-9a-f]{8}$/); assert.notEqual(s1, s0)
  // 同内容重载（版本号变了）→ 签名不变；改挂点视轴 / 改律 → 变
  rt.setBindings(mk([0, 0.1, 1]))
  assert.equal(rt.bindSigOf('norad:25544', 'm1'), s1)
  rt.setBindings(mk([0, 0.2, 1]))
  const s2 = rt.bindSigOf('norad:25544', 'm1')
  assert.notEqual(s2, s1)
  const b2 = mk([0, 0.2, 1]); b2.bindings['norad:25544'].attitude = { law: 'nadir', params: {} }
  rt.setBindings(b2)
  assert.notEqual(rt.bindSigOf('norad:25544', 'm1'), s2)
  // 两个实例、同一份绑定：签名相同（跨重启稳定）
  const rt2 = BR.createBodyRuntime(); rt2.setBindings(b2)
  assert.equal(rt2.bindSigOf('norad:25544', 'm1'), rt.bindSigOf('norad:25544', 'm1'))
  assert.equal(typeof rt._putMask, 'undefined', 'Node 里 import.meta.env 不在：验证台注入口不导出')
})

console.log(`modelBodyRuntime: ${n} 项通过`)
