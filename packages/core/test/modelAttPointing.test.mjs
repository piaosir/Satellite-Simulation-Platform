// GRD 指向「姿态 + 挂点」（boreType 'att'，DESIGN2 §4 / D1 / D9）的回归网：src/viz/grd/coverage.js 的 basisFromAxes /
// beamBasisFrom('att') / attAxesReadout，useSatPerfTable 时段扫描的 attAt 接线，主进程采样器 grdSampler 的 attEquiv 分支。
//
//   ① D1 零跳变：赤道 GEO「nadir 律 + 视轴本体 +Z + up 本体 −Y」经 beamBasisFrom('att') 与手动天底 azel(0,0) 的 x/y/z
//      逐分量 < 1e-12（含「旋转 Rot」偏置、含无速度的固定星）；LEO 纬度 40°（i = 40° 轨道顶点）三轴夹角 < 0.2°（大地 / 地心天底差）。
//   ② 缺钩子 / 解不到：att 为 null → 退回天底（与 azel(0,0,yaw) 逐位相等）；boreSettingsAtPos 对 att 原样放行（锁定 / 不锁定）。
//   ③ basisFromAxes：up 不与视轴正交时取投影；up ∥ 视轴退回极轴参考；输出正交归一、右手。
//   ④ 偏航导引（yawSteer）下 GEO 固定星的足迹基底随时间绕视轴转：视轴恒为天底（< 1e-12），钟向角 ψ = 偏航角（< 1e-9°），
//      一天里 ψ 扫过的范围报数；基底签名（z / up 取 1e-6）随时刻变化 —— tickLive 据此标 moved。
//   ⑤ D9 链：attEquivOf（宿主写回 cfg）= attAxesReadout（面板读数）；主进程 makeSampleCtx('att' + attEquiv) 的基底与
//      渲染端 beamBasisFrom('att') 同一基底（< 1e-9）；缺 attEquiv 退天底 + 偏置。
//   ⑥ 对星时段扫描：att 档消费 env.attAt（视轴跟踪目标星 → 窗口 = 星-星视线可见时段，与 5 s 密采样参考 ≤ 0.5 min）；
//      缺 attAt 退天底（窄波束下窗口显著变短）。
//   ⑦ 链路预算回填指纹：att 档 attEquiv 的角度（随时刻变）不进指纹，挂点 id 与 attEquiv 的来源签名 sig 进；null / 无签名老值 /
//      不同签名各成一档；非 att 档与二期之前逐字相同。
//   ⑧ D9 同步写回（useGrdCoverage 实例 + 宿主替身，时钟停着）：切进 att / 换挂点 / 改 Rot 当场重写 attEquiv，采样器与渲染端
//      同一基底（< 1e-7）；签名随输入变 ⇒ 指纹变、同输入随时刻变 ⇒ 指纹不变；宿主未就绪不写、就绪后第一份写回自愈；
//      绑定还在路上（缺省挂点 × nadir）那一版签名照实、绑定到了签名变；解不出 → null（两边都退天底 + Rot）；律退过读实际生效的律。
//   ⑨ 指向误差绕真实本体轴：att 基底带 body → perturbSpacecraft 绕 −X / −Y / Z 本体轴；nadir 律赤道 GEO 与手动天底口径 < 1e-12；
//      偏航导引下与现构口径差出报数；坏本体轴当没给。
//   ⑩ 等效指向 / 读数 / 落点的星位 = 宿主解轴用的 S（有星历的星 meta 可能停着）：meta 停 3 s / 1 min / 10 min 的 ISS 与宿主
//      grdAttTick 同口径 < 2e-6°（旧写法差 0.1° / 3° / 32°，报数）；宿主没带 S / 固定星 → 与 beamBasisFrom(meta) 逐位相同。
//   ⑪ 对星时段扫描 attAt(tMs, tPosMs)：第一参 = 扫描（场景）时刻，第二参 = 源星取位时刻（自定义星座星 + ccOff）。
//   ⑫ 时段扫描「输入已变」认指向：程序性改写（锁定 azel 钉 geo、不锁定 geo 随星平移含慢漂舍入、att 定时写回）不算；
//      用户改纬度 / 换挂点 / 改 Rot 算，改回复原。
//   ⑬ 换聚焦不改任何天线的指向（boreType 换算 watch 改 flush 'sync' 的回归）；用户切档照旧无缝换算。
// 渲染端 bodyRuntime.js 用 @core/… 别名：先注册解析钩子再动态导入（写法同 modelBodyRuntime.test.mjs）。
import assert from 'node:assert/strict'
import { register, createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = pathToFileURL(path.resolve(HERE, '..') + '/').href
const SRC = pathToFileURL(path.resolve(HERE, '../../../src/viz') + '/').href
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith('@core/')) return next(${JSON.stringify(CORE)} + s.slice(6), c); return next(s, c) }`))

const COV = await import(SRC + 'grd/coverage.js')
const AT = await import(CORE + 'models/attitude.mjs')
const W = await import(SRC + 'wgs84.js')
const BR = await import(SRC + 'models/bodyRuntime.js')
const SPT = await import(SRC + 'grd/useSatPerfTable.js')
const SHP = await import(SRC + 'grd/shellProj.js')
const satMod = await import(SRC + 'constellation/satellite.js')
const sat = satMod.default || satMod
const require = createRequire(import.meta.url)
const SAMPLER = require('../utils/grdSampler.js')

let n = 0
const t = async (name, fn) => { try { await fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const D2R = Math.PI / 180, R2D = 180 / Math.PI
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const ang = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b))
const wrap180 = (x) => { let v = ((x % 360) + 540) % 360 - 180; if (v === -180) v = 180; return v }
const GEO_ALT = W.RS_GEO - W.A
const DEF_FRAME = AT.mountFrame({ boresightBody: [0, 0, 1], upBody: [0, -1, 0] })
const axesOf = (body, frame = DEF_FRAME) => { const mb = AT.mountBasisEcef(body, frame); return { z: mb.z.slice(), up: mb.y.slice() } }
const worstDiff = (a, b) => { let w = 0; for (const k of ['x', 'y', 'z']) for (let c = 0; c < 3; c++) w = Math.max(w, Math.abs(a[k][c] - b[k][c])); return w }
const checkOrtho = (b, tol, msg) => {
  for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(len(b[k]) - 1) < tol, `${msg} |${k}|`)
  assert.ok(Math.abs(dot(b.x, b.y)) < tol && Math.abs(dot(b.y, b.z)) < tol && Math.abs(dot(b.z, b.x)) < tol, `${msg} 正交`)
  const c = cross(b.x, b.y); assert.ok(len([c[0] - b.z[0], c[1] - b.z[1], c[2] - b.z[2]]) < tol, `${msg} 右手`)
}

// ───────────────────────── ① D1 零跳变 ─────────────────────────
await t('D1：赤道 GEO「att + nadir + 视轴 +Z + up −Y」与手动天底 azel(0,0) 的 x/y/z 逐分量 < 1e-12（含 Rot 偏置、固定星）', () => {
  let worst = 0
  for (let lon = -180; lon < 180; lon += 7.5) {
    const meta = { satLon: lon, satLat: 0, satAlt: GEO_ALT }
    const S = W.geodeticToEcef(lon, 0, GEO_ALT)
    const vGeo = [-Math.sin(lon * D2R) * 3.0747, Math.cos(lon * D2R) * 3.0747, 0]
    for (const v of [vGeo, undefined]) {             // undefined = 固定星（attitude 按 ω⊕ × r 合成速度）
      const att = axesOf(AT.attitudeBasisEcef('nadir', null, { rEcef: S, vInertialEcef: v }))
      for (const yaw of [0, 17, -123.5]) {
        const got = COV.beamBasisFrom(meta, { boreType: 'att', yaw }, null, att)
        const ref = COV.beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw })
        worst = Math.max(worst, worstDiff(got, ref))
        assert.deepEqual(got.S, ref.S)
      }
    }
  }
  assert.ok(worst < 1e-12, `最差 ${worst}`)
  console.log(`  ① 赤道 GEO：att 基底与手动天底逐分量最差 ${worst.toExponential(2)}`)
})

await t('D1：LEO 纬度 40°（i = 40° 轨道顶点，速度正东）att 三轴与手动天底夹角 < 0.2°（报数）', () => {
  const rows = []
  for (const alt of [500, 800, 1200]) {
    for (const lon of [0, 116.4, -77]) {
      const meta = { satLon: lon, satLat: 40, satAlt: alt }
      const S = W.geodeticToEcef(lon, 40, alt)
      const east = [-Math.sin(lon * D2R), Math.cos(lon * D2R), 0]
      const att = axesOf(AT.attitudeBasisEcef('nadir', null, { rEcef: S, vInertialEcef: east.map((x) => x * 7.5) }))
      const got = COV.beamBasisFrom(meta, { boreType: 'att', yaw: 0 }, null, att)
      const ref = COV.beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 })
      const d = ['x', 'y', 'z'].map((k) => ang(got[k], ref[k]) * R2D)
      for (const x of d) assert.ok(x < 0.2, `alt ${alt} lon ${lon}：${d}`)
      if (lon === 0) rows.push(`${alt} km ${d.map((x) => x.toFixed(4)).join('/')}°`)
    }
  }
  console.log('  ① LEO 纬度 40°（x/y/z 夹角）：' + rows.join('；'))
})

// ───────────────────────── ② 退路 ─────────────────────────
await t('att 缺钩子 / 解不到（att = null / 缺 z）→ 退回天底 + 偏置，与 azel(0,0,yaw) 逐位相等；boreSettingsAtPos 原样放行', () => {
  for (const meta of [{ satLon: 110.5, satLat: 0, satAlt: GEO_ALT }, { satLon: -40, satLat: 33, satAlt: 700 }]) {
    for (const yaw of [0, 25]) {
      const ref = COV.beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw })
      for (const a of [null, undefined, {}, { up: [0, 0, 1] }]) {
        const got = COV.beamBasisFrom(meta, { boreType: 'att', yaw }, null, a)
        assert.equal(worstDiff(got, ref), 0, `att=${JSON.stringify(a)}`)
      }
    }
  }
  const meta0 = { satLon: 110.5, satLat: 0, satAlt: GEO_ALT }
  for (const boreLock of [true, false, undefined]) {
    const st = { boreType: 'att', boreLock, boreMount: 'm1', boreLon: 100, boreLat: 3, boreAz: 1, boreEl: 2 }
    assert.equal(COV.boreSettingsAtPos(st, meta0, { lon: 130, lat: 8 }), st, `boreLock=${boreLock}`)
  }
})

// ───────────────────────── ③ basisFromAxes ─────────────────────────
await t('basisFromAxes：up 取视轴法平面投影、y 同向；up ∥ 视轴退回极轴参考；正交归一、右手（随机 2000 组）', () => {
  let seed = 20260924
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const rndUnit = () => { const z = 2 * rnd() - 1, p = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z); return [r * Math.cos(p), r * Math.sin(p), z] }
  const S = [42164, 0, 0]
  for (let k = 0; k < 2000; k++) {
    const z = rndUnit(), up = rndUnit()
    const b = COV.basisFromAxes(S, z, up, 0)
    checkOrtho(b, 1e-14, 'basis')
    assert.ok(ang(b.z, z) < 1e-15)
    const upP = [up[0] - dot(up, z) * z[0], up[1] - dot(up, z) * z[1], up[2] - dot(up, z) * z[2]]
    assert.ok(ang(b.y, upP) < 1e-12, 'y = up 投影方向')
    const yaw = 360 * rnd() - 180
    const br = COV.basisFromAxes(S, z, up, yaw)
    checkOrtho(br, 1e-14, 'basis+yaw')
    assert.ok(ang(br.z, b.z) === 0, '偏置不动视轴')
    assert.ok(Math.abs(wrap180(Math.atan2(dot(br.x, b.y), dot(br.x, b.x)) * R2D - yaw)) < 1e-9, '偏置 = 绕视轴钟向角（x 转向 y 为正）')
  }
  // 退化：up ∥ 视轴 / up 缺失 → x = nrm(ẑ × z)（与 antennaBasisEcef 同一参考）
  const z = nrm([0.3, -0.4, 0.2])
  for (const up of [z, z.map((v) => -3 * v), null]) {
    const b = COV.basisFromAxes(S, z, up, 0)
    checkOrtho(b, 1e-14, 'degenerate')
    assert.ok(ang(b.x, nrm(cross([0, 0, 1], z))) < 1e-15, '极轴参考')
  }
  // 视轴恰在极轴上（ẑ × z = 0）且 up 退化：退到 x̂ × z
  const bp = COV.basisFromAxes(S, [0, 0, 1], [0, 0, 5], 0)
  checkOrtho(bp, 1e-14, 'pole')
})

// ───────────────────────── ④ 偏航导引：足迹基底随时间转 ─────────────────────────
await t('偏航导引：GEO 固定星视轴恒为天底、钟向角 ψ = 偏航角（< 1e-9°），基底签名随时刻变（报 ψ 一天的范围）', () => {
  const lon = 110.5, meta = { satLon: lon, satLat: 0, satAlt: GEO_ALT }
  const S = W.geodeticToEcef(lon, 0, GEO_ALT)
  const nadir = COV.beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 })
  const T0 = Date.UTC(2026, 11, 21, 0, 0, 0)            // 冬至：β ≈ −23°，偏航角离 0 / 180 远，全天连续
  let prevYaw = 0, lo = Infinity, hi = -Infinity, worstPsi = 0, worstZ = 0
  const sigs = new Set()
  const sigOf = (a) => [...a.z, ...a.up].map((v) => Math.round(v * 1e6)).join(',')
  for (let h = 0; h <= 24; h += 0.5) {
    const tMs = T0 + h * 3600e3
    const body = AT.attitudeBasisEcef('yawSteer', {}, { rEcef: S, sunEcef: AT.sunEcefApprox(tMs), tMs, prevYawDeg: prevYaw })
    assert.equal(body.law, 'yawSteer')
    prevYaw = body.yawDeg
    const att = axesOf(body)
    sigs.add(sigOf(att))
    const b = COV.beamBasisFrom(meta, { boreType: 'att', yaw: 0 }, null, att)
    worstZ = Math.max(worstZ, ang(b.z, nadir.z))
    const r = COV.attAxesReadout(meta, b)
    worstPsi = Math.max(worstPsi, Math.abs(wrap180(r.psi - body.yawDeg)))
    const y = wrap180(body.yawDeg); lo = Math.min(lo, y); hi = Math.max(hi, y)
  }
  assert.ok(worstZ < 1e-12, `视轴偏离天底 ${worstZ}`)
  assert.ok(worstPsi < 1e-9, `ψ − 偏航角 ${worstPsi}°`)
  assert.ok(sigs.size >= 40, `签名只变了 ${sigs.size} 次`)
  assert.ok(hi - lo > 90, `一天里 ψ 只扫了 ${hi - lo}°`)
  console.log(`  ④ 冬至 GEO 110.5°E 偏航导引：ψ ∈ [${lo.toFixed(2)}, ${hi.toFixed(2)}]°，视轴偏离天底 ${worstZ.toExponential(1)} rad，ψ 与偏航角差 ${worstPsi.toExponential(1)}°`)
})

// ───────────────────────── ⑤ D9：等效手动指向 ─────────────────────────
await t('D9：attEquivOf = attAxesReadout；采样器 makeSampleCtx(att + attEquiv) 与渲染端 att 基底同一基底（< 1e-9）；缺 attEquiv 退天底', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const loaded = { igrid: 6, icomp: 3, ncomp: 2, beams: [] }
  let worstB = 0, worstR = 0
  const cases = [
    { meta: { satLon: 110.5, satLat: 0, satAlt: GEO_ALT }, S: W.geodeticToEcef(110.5, 0, GEO_ALT) },
    { meta: { satLon: 30, satLat: 40, satAlt: 800 }, S: W.geodeticToEcef(30, 40, 800) },
    { meta: { satLon: -120, satLat: -60, satAlt: 1200 }, S: W.geodeticToEcef(-120, -60, 1200) }
  ]
  for (const c of cases) {
    for (let k = 0; k < 60; k++) {
      // 任意挂点（视轴离天底 ≤ 8°，GEO 地球张角内外都有）× nadir / 偏航导引 / 任意偏置
      const bore = nrm([0.14 * (rnd() - 0.5), 0.14 * (rnd() - 0.5), 1])
      const frame = AT.mountFrame({ boresightBody: bore, upBody: [rnd() - 0.5, -1, rnd() - 0.5] })
      const tMs = Date.UTC(2026, 3, 1) + rnd() * 86400e3
      const law = k % 2 ? 'yawSteer' : 'nadir'
      const body = AT.attitudeBasisEcef(law, {}, { rEcef: c.S, sunEcef: AT.sunEcefApprox(tMs), tMs })
      const att = axesOf(body, frame)
      const yawBias = k % 3 ? 0 : 360 * rnd() - 180
      const st = { boreType: 'att', yaw: yawBias }
      const b = COV.beamBasisFrom(c.meta, st, null, att)
      const eq = BR.attEquivOf(att.z, att.up, c.meta.satLon, c.meta.satLat, c.meta.satAlt, yawBias)
      const rd = COV.attAxesReadout(c.meta, b)
      worstR = Math.max(worstR, Math.abs(eq.boreAz - rd.az), Math.abs(eq.boreEl - rd.el), Math.abs(wrap180(eq.yaw - rd.psi)))
      const ctx = SAMPLER.makeSampleCtx(loaded, { lon: c.meta.satLon, lat: c.meta.satLat, alt: c.meta.satAlt }, { ...st, attEquiv: eq })
      worstB = Math.max(worstB, worstDiff(ctx.basis, b))
    }
    // 缺 attEquiv：天底 + c.yaw（与渲染端 att 缺轴同口径）
    const ctx0 = SAMPLER.makeSampleCtx(loaded, { lon: c.meta.satLon, lat: c.meta.satLat, alt: c.meta.satAlt }, { boreType: 'att', yaw: 12 })
    assert.ok(worstDiff(ctx0.basis, COV.beamBasisFrom(c.meta, { boreType: 'att', yaw: 12 }, null, null)) < 1e-12, '缺 attEquiv 退天底')
  }
  assert.ok(worstR < 1e-9, `attEquivOf vs attAxesReadout ${worstR}`)
  assert.ok(worstB < 1e-9, `采样器基底 vs 渲染端 ${worstB}`)
  console.log(`  ⑤ 等效指向回代：基底最差 ${worstB.toExponential(2)}，读数最差 ${worstR.toExponential(2)}°`)
})

// ───────────────────────── ⑥ 对星时段扫描：attAt 接线 ─────────────────────────
await t('对星时段扫描：att 档吃 env.attAt（跟踪目标 → 窗口 = 视线可见时段，与 5 s 密采样 ≤ 0.5 min）；缺 attAt 退天底', async () => {
  const L1 = '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004'
  const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354'
  const rec = sat.twoline2satrec(L1, L2)
  const T0 = Date.UTC(2026, 7, 18, 12, 0, 0)
  const lon = 100, meta = { satLon: lon, satLat: 0, satAlt: GEO_ALT, folder: 'f', name: 'a' }
  const S = W.geodeticToEcef(lon, 0, GEO_ALT)
  // 窄域 igrid 6 方向图（±0.5°，常数功率）：进域 = 视轴对准
  const NX = 11, NY = 11, P1 = new Float32Array(NX * NY).fill(1), P2 = new Float32Array(NX * NY)
  const beam = { grid: { XS: -0.5, YS: -0.5, XE: 0.5, YE: 0.5, NX, NY }, P1, P2 }
  const tgtEcef = (tMs) => { const d = new Date(tMs); const pv = sat.propagate(rec, d); const e = sat.eciToEcf(pv.position, sat.gstime(d)); return [e.x, e.y, e.z] }
  const mkCtx = (boreType) => ({
    key: 'f|a', igrid: 6, icomp: 3, meta, satName: 'GEO', antName: 'a',
    settings: { boreType, boreAz: 0, boreEl: 0, yaw: 0, boreLock: false, pol: 'RSS', gainOffset: 0, pathLoss: 'none', ctype: 'abs' },
    beams: [{ bi: 0, seq: 1, name: 'B1', peakDb: 0, beam }]
  })
  const attAt = (tMs) => { const P = tgtEcef(tMs); return { z: nrm([P[0] - S[0], P[1] - S[1], P[2] - S[2]]), up: [0, 0, 1] } }
  const times = { now: new Date(T0), gmst: sat.gstime(new Date(T0)), ccNow: new Date(T0), ccGmst: sat.gstime(new Date(T0)) }
  const tg = [{ rec, name: 'ISS', noradId: 25544, group: '', _cc: false }]
  const run = async (boreType, env) => {
    const sp = SPT.useSatPerfTable()
    sp.setActiveKey('f|a')
    sp.win.durH = 12
    await sp.computeWindows(mkCtx(boreType), null, tg, times, [], 0, env)
    return sp.session('f|a').winInfo.value
  }
  const wAtt = await run('att', { srcRec: null, boreRec: null, attAt })
  const wNoHook = await run('att', { srcRec: null, boreRec: null })
  // 参考：视线（线段）不被地球挡 —— 5 s 密采样
  let visMs = 0
  for (let tt = T0; tt < T0 + 12 * 3600e3; tt += 5000) if (!SHP.losBlocked(S, tgtEcef(tt), 0)) visMs += 5000
  const attMin = wAtt.bands[0].totMin, refMin = visMs / 60000, noMin = wNoHook.bands[0].totMin
  assert.ok(Math.abs(attMin - refMin) <= 0.5, `att 跟踪窗口 ${attMin.toFixed(2)} min vs 视线可见 ${refMin.toFixed(2)} min`)
  assert.ok(wAtt.bands[0].nWin >= 3, `窗口数 ${wAtt.bands[0].nWin}`)
  assert.ok(noMin < attMin * 0.2, `缺 attAt 应退天底（窄波束下窗口短得多）：${noMin.toFixed(2)} vs ${attMin.toFixed(2)} min`)
  console.log(`  ⑥ 12 h：att 跟踪窗口 ${attMin.toFixed(2)} min / ${wAtt.bands[0].nWin} 段（视线可见参考 ${refMin.toFixed(2)} min）；缺钩子退天底 ${noMin.toFixed(2)} min`)
})

// ───────────────────────── ⑦ 链路预算回填指纹 ─────────────────────────
await t('回填指纹（grdParam.grdFillBase）：att 档 attEquiv 随时刻变不改指纹、换挂点改；非 att 档与二期之前逐字相同', async () => {
  if (!globalThis.localStorage) { const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() } }
  const GP = await import(SRC + '../linkbudget/grdParam.js')
  assert.ok(GP.SAMPLE_CFG_KEYS.includes('attEquiv'))
  const node = { folder: 'F', lon: 110.5, lat: 0, altKm: 35786, live: false }, ant = { name: 'A', file: 'a.grd', satLon: 110.5, satLat: 0, satAlt: 35786 }
  const att = { boreType: 'att', boreMount: 'm1', yaw: 0, pol: 'RSS', gainOffset: 0, pathLoss: 'none' }
  const f1 = GP.grdFillBase(node, ant, { ...att, attEquiv: { boreAz: 0, boreEl: 0, yaw: 12.3 } })
  const f2 = GP.grdFillBase(node, ant, { ...att, attEquiv: { boreAz: 0.1, boreEl: -0.2, yaw: 80.1 } })
  const f3 = GP.grdFillBase(node, ant, { ...att, boreMount: 'm2', attEquiv: { boreAz: 0, boreEl: 0, yaw: 12.3 } })
  assert.equal(f1, f2, 'attEquiv 变化不改指纹')
  assert.notEqual(f1, f3, '换挂点改指纹')
  // 非 att 档：指纹里没有 att 段、也不含 attEquiv（切走 att 后 cfg 上残留的旧值不进指纹）；与按二期之前的写法手算的串逐字相同
  const man = { boreType: 'azel', boreAz: 1, boreEl: 2, yaw: 3, pol: 'RSS', gainOffset: 0, pathLoss: 'none', keptSets: [0, 2] }
  const old = JSON.stringify({ file: 'a.grd', sat: { lon: 110.5, lat: 0, alt: 35786 }, cfg: { boreType: 'azel', boreAz: 1, boreEl: 2, yaw: 3, pol: 'RSS', gainOffset: 0, pathLoss: 'none', keptSets: [0, 2] } })
  assert.equal(GP.grdFillBase(node, ant, man), old)
  assert.equal(GP.grdFillBase(node, ant, { ...man, attEquiv: { boreAz: 9, boreEl: 9, yaw: 9, sig: 'm1>m1|nadir|3' }, boreMount: 'm1' }), old)
  // att 档来源签名：同签名下角度随时刻变 ⇒ 不改；没写过（null）/ 没盖签名的老值（'?'）/ 换了签名 ⇒ 各不相同（第一份对得上的一到就重取）
  const sgA = 'm1>m1|yawSteer|0', sgB = 'm1>|nadir|0'
  const fa1 = GP.grdFillBase(node, ant, { ...att, attEquiv: { boreAz: 0, boreEl: 0, yaw: 12.3, sig: sgA } })
  const fa2 = GP.grdFillBase(node, ant, { ...att, attEquiv: { boreAz: 0.1, boreEl: -0.2, yaw: 80.1, sig: sgA } })
  const fb = GP.grdFillBase(node, ant, { ...att, attEquiv: { boreAz: 0, boreEl: 0, yaw: 12.3, sig: sgB } })
  const fn = GP.grdFillBase(node, ant, { ...att, attEquiv: null })
  assert.equal(fa1, fa2, '同签名角度变 → 指纹不变')
  assert.equal(new Set([fa1, fb, fn, f1]).size, 4, 'null / 老值 / 两种签名 → 四个不同指纹')
})

// ───────────────────────── ⑧ D9 同步写回（useGrdCoverage 实例 + 宿主替身，时钟停着）─────────────────────────
// 宿主替身：GEO 110.5°E 固定星、冬至 03:00、偏航导引；三副挂点（缺省 / m1 斜视 3° 且 antennaRef 命中本天线 / m2 天底）。
// bound=false 模拟「绑定还在路上」（宿主此刻解出的是缺省挂点 × nadir 律），ready 是 hooks.attReady。
await t('D9 同步写回：切进 att / 换挂点 / 改 Rot 当场重写 attEquiv（不等宿主定时写回）；来源签名进回填指纹、自愈；未就绪不写；律退过照实读', async () => {
  const mem = new Map()
  globalThis.localStorage = globalThis.localStorage || { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() }
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => { fn(0); return 0 })
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {})
  globalThis.window = globalThis.window || { api: { coverageGrd: { save: async (nm) => ({ file: nm }) } }, addEventListener() {}, removeEventListener() {} }
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const { useGrdCoverage } = await import(SRC + 'grd/useGrdCoverage.js')
  const GP = await import(SRC + '../linkbudget/grdParam.js')
  const lon = 110.5, S = W.geodeticToEcef(lon, 0, GEO_ALT)
  const tMs = Date.UTC(2026, 11, 21, 3, 0, 0)
  const bodyYs = AT.attitudeBasisEcef('yawSteer', {}, { rEcef: S, sunEcef: AT.sunEcefApprox(tMs), tMs })
  const bodyN = AT.attitudeBasisEcef('nadir', null, { rEcef: S })
  assert.ok(Math.abs(wrap180(bodyYs.yawDeg)) > 20, `夹具偏航角 ${bodyYs.yawDeg}`)
  const s3 = Math.sin(3 * D2R), c3 = Math.cos(3 * D2R)
  const FR = {
    '': DEF_FRAME,
    m1: AT.mountFrame({ boresightBody: [s3, 0, c3], upBody: [0.5, -Math.sqrt(0.75), 0] }),
    m2: AT.mountFrame({ boresightBody: [0, 0, 1], upBody: [0, -1, 0] })
  }
  const h = { bound: true, ready: true, nul: false, law: 'yawSteer', fb: null, calls: 0 }
  const effMount = (want) => (!h.bound ? '' : (want && FR[want] ? want : 'm1'))
  const axesFor = (want) => {
    const mb = AT.mountBasisEcef(h.bound ? bodyYs : bodyN, FR[effMount(want)])
    return { z: mb.z.slice(), up: mb.y.slice() }
  }
  const hooks = {
    getAttAxes: (meta, st) => { h.calls++; if (h.nul) return null; const a = axesFor(st.boreMount || ''); return h.fb ? { ...a, law: h.fb, fallback: true } : a },
    getMountOptions: () => (h.bound ? [{ id: '', name: 'Body +Z', match: false }, { id: 'm1', name: 'M1', match: true }, { id: 'm2', name: 'M2', match: false }] : [{ id: '', name: 'Body +Z', match: false }]),
    getAttLaw: () => (h.bound ? h.law : 'nadir'),
    attReady: () => h.ready
  }
  const g = useGrdCoverage(() => null, () => null, () => false, hooks)
  const node = g.addSatellite({ name: 'D9', lon, lat: 0, altKm: GEO_ALT })
  // 21 × 21 igrid 6 高斯点波束（±5°）
  const NX = 21, L = ['d9', '++++', '1', '1 3 2 6', '0 0', '-5 -5 5 5', `${NX} ${NX} 0`]
  for (let r = 0; r < NX; r++) for (let c = 0; c < NX; c++) { const az = -5 + c * 0.5, el = -5 + r * 0.5, a = Math.pow(10, (40 - 3 * (az * az + el * el)) / 20); L.push(`${a.toExponential(6)} 0 ${(a * 0.03).toExponential(6)} 0`) }
  const key = await g.importSynthGrd(node.folder, 'A', L.join('\n') + '\n')
  assert.equal(g.active.value, key)
  const ant = node.antennas.find((a) => a.name === 'A')
  const loaded = { igrid: 6, icomp: 3, ncomp: 2, beams: [] }
  const cfgNow = () => g.getPerfContext(key).settings
  const fp = () => GP.grdFillBase(node, ant, JSON.parse(JSON.stringify(cfgNow())))
  const eqRef = (want, yaw) => BR.attEquivOf(axesFor(want).z, axesFor(want).up, lon, 0, GEO_ALT, yaw)
  const eqDiff = (a, b) => Math.max(Math.abs(a.boreAz - b.boreAz), Math.abs(a.boreEl - b.boreEl), Math.abs(wrap180(a.yaw - b.yaw)))
  // 采样器（照 attEquiv 走 azel）与渲染端 att 基底：D9 要的就是这两个同一基底
  const d9Gap = () => {
    const ctx = g.getPerfContext(key)
    const smp = SAMPLER.makeSampleCtx(loaded, { lon, lat: 0, alt: GEO_ALT }, JSON.parse(JSON.stringify(ctx.settings)))
    return worstDiff(smp.basis, ctx.basis)
  }

  // ① 切进 att（缺省挂点 → antennaRef 命中的 m1）：当场写，签名 '>m1|yawSteer|0'
  g.setBoreSource('att'); await tick()
  let eq = cfgNow().attEquiv
  assert.ok(eq && eqDiff(eq, eqRef('', 0)) < 2e-6, JSON.stringify(eq))
  assert.equal(eq.sig, '>m1|yawSteer|0')
  assert.ok(d9Gap() < 1e-7, `切进 att：采样器 vs 渲染端 ${d9Gap()}`)
  const fp1 = fp()
  // ② 换挂点 m2（宿主定时写回不跑 = 时钟停着）：attEquiv 当场换成 m2 的，签名随之变 ⇒ 指纹变
  g.setBoreMount('m2'); await tick()
  eq = cfgNow().attEquiv
  assert.ok(eqDiff(eq, eqRef('m2', 0)) < 2e-6 && eqDiff(eqRef('m1', 0), eqRef('m2', 0)) > 1, `换挂点：${JSON.stringify(eq)}`)
  assert.equal(eq.sig, 'm2>m2|yawSteer|0')
  assert.ok(d9Gap() < 1e-7, `换挂点：采样器 vs 渲染端 ${d9Gap()}`)
  const fp2 = fp()
  assert.notEqual(fp2, fp1)
  // ③ 改 Rot：ψ 跟着加，签名带 Rot
  g.s.yaw = 25; await tick()
  eq = cfgNow().attEquiv
  assert.ok(eqDiff(eq, eqRef('m2', 25)) < 2e-6, `改 Rot：${JSON.stringify(eq)}`)
  assert.equal(eq.sig, 'm2>m2|yawSteer|25')
  assert.ok(d9Gap() < 1e-7)
  const fp3 = fp()
  assert.notEqual(fp3, fp2)
  // ④ 落盘：getState 里的那份与此刻一致
  const saved = g.getState().cfgs[key]
  assert.equal(saved.boreType, 'att'); assert.equal(saved.boreMount, 'm2'); assert.ok(eqDiff(saved.attEquiv, eqRef('m2', 25)) < 2e-6)
  // ⑤ 宿主定时写回（仿真时刻在走，角度变、输入没变）：盖同一签名 ⇒ 指纹不变
  g.setAttEquiv(key, { boreAz: eq.boreAz + 0.05, boreEl: eq.boreEl - 0.03, yaw: eq.yaw + 0.4 })
  assert.equal(cfgNow().attEquiv.sig, 'm2>m2|yawSteer|25')
  assert.equal(fp(), fp3, '同一输入下角度随时刻变不改指纹')
  // ⑥ 宿主绑定未就绪（attReady false）：切挂点时不写、宿主写回也不收；就绪后第一份写回签名对上 ⇒ 指纹再变一次（自愈）
  h.ready = false
  const before = JSON.stringify(cfgNow().attEquiv)
  g.setBoreMount('m1'); await tick()
  assert.equal(JSON.stringify(cfgNow().attEquiv), before, '未就绪：persistActive 不写')
  g.setAttEquiv(key, { boreAz: 1, boreEl: 1, yaw: 1 })
  assert.equal(JSON.stringify(cfgNow().attEquiv), before, '未就绪：宿主写回不收')
  const fpStale = fp()
  h.ready = true
  const e1 = eqRef('m1', 25)
  g.setAttEquiv(key, e1)
  assert.equal(cfgNow().attEquiv.sig, 'm1>m1|yawSteer|25')
  assert.notEqual(fp(), fpStale, '对得上的 attEquiv 一到指纹就变')
  // ⑦ 宿主没给 attReady、启动时绑定还没到（解出缺省 × nadir）：签名照实是缺省那一版；绑定到了宿主写回 ⇒ 签名变 ⇒ 指纹变
  h.bound = false
  g.s.yaw = 26; await tick()
  assert.equal(cfgNow().attEquiv.sig, 'm1>|nadir|26')
  const fpPre = fp()
  h.bound = true
  g.setAttEquiv(key, eqRef('m1', 26))
  assert.equal(cfgNow().attEquiv.sig, 'm1>m1|yawSteer|26')
  assert.notEqual(fp(), fpPre)
  // ⑧ 姿态解不出（宿主给 null）：attEquiv = null（渲染端 / 采样器都退天底 + Rot），指纹 eq 段 null；解出来了又变回签名
  h.nul = true
  g.s.yaw = 27; await tick()
  assert.equal(cfgNow().attEquiv, null)
  assert.ok(d9Gap() < 1e-12, '解不出：两边都是天底 + Rot')
  const fpNul = fp()
  h.nul = false
  g.s.yaw = 26; await tick()
  assert.equal(cfgNow().attEquiv.sig, 'm1>m1|yawSteer|26')
  assert.notEqual(fp(), fpNul)
  // ⑨ 律退过：宿主随轴带回 law 'nadir' + fallback（绑定律 target 解不出）→ 读数写实际生效的律，签名带 '!'
  h.law = 'target'; h.fb = 'nadir'
  g.s.yaw = 0; await tick()
  const rd = g.attReadout()
  assert.equal(rd.law, 'nadir'); assert.equal(rd.cfgLaw, 'target'); assert.equal(rd.fallback, true)
  assert.equal(cfgNow().attEquiv.sig, 'm1>m1|nadir!|0')
  h.fb = null; h.law = 'yawSteer'
  // ⑩ 切回手动：attEquiv 留着但不再进指纹（非 att 档指纹不看它），手动档原样回来
  g.setBoreSource('manual'); await tick()
  assert.equal(g.s.boreType, 'azel'); assert.ok(!/"att"/.test(fp()) && !/"eq"/.test(fp()))
  console.log(`  ⑧ 切 att / 换挂点 / 改 Rot 当场写回：采样器 vs 渲染端基底 < 1e-7；签名 ${JSON.stringify(['>m1|yawSteer|0', 'm2>m2|yawSteer|0', 'm2>m2|yawSteer|25'])}；宿主取轴 ${h.calls} 次`)
})

// ───────────────────────── ⑨ 指向误差绕真实本体轴（perturbSpacecraft × basis.body）─────────────────────────
await t('指向误差：att 基底带本体轴 → 绕真实本体轴施加；nadir 律赤道 GEO 与手动天底逐位同口径（< 1e-12）；偏航导引下轴随 ψ 转', () => {
  const rod = (v, k, a) => { const c = Math.cos(a), s = Math.sin(a), kv = cross(k, v), kd = dot(k, v); return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)] }
  const neg = (v) => [-v[0], -v[1], -v[2]]
  let worstN = 0
  for (let lon = -170; lon < 180; lon += 40) {
    const meta = { satLon: lon, satLat: 0, satAlt: GEO_ALT }
    const S = W.geodeticToEcef(lon, 0, GEO_ALT)
    const body = AT.attitudeBasisEcef('nadir', null, { rEcef: S })
    const att = { ...axesOf(body), body: { X: body.X.slice(), Y: body.Y.slice(), Z: body.Z.slice() } }
    const bAtt = COV.beamBasisFrom(meta, { boreType: 'att', yaw: 7 }, null, att)
    assert.ok(bAtt.body && bAtt.body.x.length === 3)
    const bMan = COV.beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 7 })
    for (const [az, el, yw] of [[0.1, 0, 0], [0, -0.2, 0], [0, 0, 0.3], [0.05, 0.07, -0.2]]) {
      worstN = Math.max(worstN, worstDiff(COV.perturbSpacecraft(bAtt, az, el, yw), COV.perturbSpacecraft(bMan, az, el, yw)))
    }
  }
  assert.ok(worstN < 1e-12, `nadir 律：体轴口径 vs 现构口径 ${worstN}`)
  // 偏航导引（ψ 离 0 远）：El 绕 −X_body、Az 绕 −Y_body、Yaw 绕 Z_body
  const lon = 110.5, meta = { satLon: lon, satLat: 0, satAlt: GEO_ALT }, S = W.geodeticToEcef(lon, 0, GEO_ALT)
  const tMs = Date.UTC(2026, 11, 21, 3, 0, 0)
  const body = AT.attitudeBasisEcef('yawSteer', {}, { rEcef: S, sunEcef: AT.sunEcefApprox(tMs), tMs })
  const frame = AT.mountFrame({ boresightBody: nrm([0.04, -0.02, 1]), upBody: [0, -1, 0] })
  const att = { ...axesOf(body, frame), body: { X: body.X.slice(), Y: body.Y.slice(), Z: body.Z.slice() } }
  const b = COV.beamBasisFrom(meta, { boreType: 'att', yaw: 0 }, null, att)
  const d = 0.3 * D2R
  const pe = COV.perturbSpacecraft(b, 0, 0.3, 0), pa = COV.perturbSpacecraft(b, 0.3, 0, 0), py = COV.perturbSpacecraft(b, 0, 0, 0.3)
  let w = 0
  for (const k of ['x', 'y', 'z']) {
    for (let c = 0; c < 3; c++) {
      w = Math.max(w, Math.abs(pe[k][c] - rod(b[k], neg(body.X), d)[c]), Math.abs(pa[k][c] - rod(b[k], neg(body.Y), d)[c]), Math.abs(py[k][c] - rod(b[k], body.Z, d)[c]))
    }
  }
  assert.ok(w < 1e-12, `偏航导引：绕本体轴 ${w}`)
  // 与现构体轴（天底 + 极轴）口径确实不同：El 误差下视轴落点差出 ≈ 误差 × 2 sin(ψ/2)
  const { body: _drop, ...bNo } = b
  const dz = ang(pe.z, COV.perturbSpacecraft(bNo, 0, 0.3, 0).z) * R2D
  assert.ok(dz > 0.05, `ψ = ${body.yawDeg.toFixed(1)}° 下体轴口径与现构口径差 ${dz}°`)
  // 本体轴坏了（零矢量 / 缺分量）→ 当没给，走现构体轴（与二期之前同一条路）
  for (const bad of [{ x: [0, 0, 0], y: body.Y, z: body.Z }, { x: body.X, y: [NaN, 0, 1], z: body.Z }, { x: body.X, y: body.Y }]) {
    assert.equal(worstDiff(COV.perturbSpacecraft({ ...bNo, body: bad }, 0.1, 0.2, 0.3), COV.perturbSpacecraft(bNo, 0.1, 0.2, 0.3)), 0)
  }
  console.log(`  ⑨ nadir 律体轴 vs 现构 ${worstN.toExponential(1)}；偏航导引 ψ = ${body.yawDeg.toFixed(2)}° 绕本体轴残差 ${w.toExponential(1)}，与现构口径差 ${dz.toFixed(3)}°（El 0.3°）`)
})

// ───────────────────────── 共用：useGrdCoverage 实例的运行环境 + 合成 GRD ─────────────────────────
const ensureHost = () => {
  if (!globalThis.localStorage) { const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() } }
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => { fn(0); return 0 })
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {})
  globalThis.window = globalThis.window || { api: { coverageGrd: { save: async (nm) => ({ file: nm }) } }, addEventListener() {}, removeEventListener() {} }
}
const tick0 = () => new Promise((r) => setTimeout(r, 0))
// 21 × 21 igrid 6 高斯点波束（±5°），同 ⑧
const synthGrd = (name) => {
  const NX = 21, L = [name, '++++', '1', '1 3 2 6', '0 0', '-5 -5 5 5', `${NX} ${NX} 0`]
  for (let r = 0; r < NX; r++) for (let c = 0; c < NX; c++) { const az = -5 + c * 0.5, el = -5 + r * 0.5, a = Math.pow(10, (40 - 3 * (az * az + el * el)) / 20); L.push(`${a.toExponential(6)} 0 ${(a * 0.03).toExponential(6)} 0`) }
  return L.join('\n') + '\n'
}
const ISS_L1 = '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004'
const ISS_L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354'
const issRec = sat.twoline2satrec(ISS_L1, ISS_L2)
// ISS 某时刻：ECEF 星位 / 惯性速度（ECEF 分量）/ 星下点 meta（与宿主 grdBodyCtx → bodyRt 同一套 SGP4）
const issAt = (tMs) => {
  const d = new Date(tMs), pv = sat.propagate(issRec, d), gm = sat.gstime(d)
  const e = sat.eciToEcf(pv.position, gm), gd = sat.eciToGeodetic(pv.position, gm)
  const c = Math.cos(gm), s = Math.sin(gm), v = pv.velocity
  return { r: [e.x, e.y, e.z], v: [v.x * c + v.y * s, -v.x * s + v.y * c, v.z], meta: { satLon: sat.degreesLong(gd.longitude), satLat: sat.degreesLat(gd.latitude), satAlt: gd.height } }
}

// ───────────────────────── ⑩ 等效指向 / 读数 / 落点的星位 = 宿主解轴用的那个 S ─────────────────────────
// 审查复现（w12rev_stale）：有星历的星，宿主按当前仿真时刻 SGP4 取位解姿态、随轴带回 S；没勾选的聚焦天线 c.meta 不随 tickLive 刷新。
// 旧写法拿停着的 meta 当星下点折 az/el/ψ：停 1 min 的 ISS 差出 2–3°，落盘的 attEquiv 让链路预算按错的指向取方向图。
await t('⑩ meta 停在 3 s / 1 min / 10 min 前（ISS）：attEquiv / 读数 / 落点按宿主带回的 S 折算，与宿主 grdAttTick 同口径（< 2e-6°）；固定星逐位不变', async () => {
  ensureHost()
  const { useGrdCoverage } = await import(SRC + 'grd/useGrdCoverage.js')
  const T0 = Date.UTC(2026, 7, 18, 12, 0, 0)
  const clk = { t: T0 + 60e3, withS: true }
  const axesNow = () => {
    const x = issAt(clk.t)
    const body = AT.attitudeBasisEcef('nadir', null, { rEcef: x.r, vInertialEcef: x.v, tMs: clk.t })
    const mb = AT.mountBasisEcef(body, DEF_FRAME)
    return clk.withS ? { z: mb.z.slice(), up: mb.y.slice(), S: x.r.slice(), law: 'nadir' } : { z: mb.z.slice(), up: mb.y.slice(), law: 'nadir' }
  }
  const hooks = { getAttAxes: () => axesNow(), getAttLaw: () => 'nadir', attReady: () => true }
  const g = useGrdCoverage(() => null, () => null, () => false, hooks)
  const m0 = issAt(T0).meta                         // 树节点 / 缓存 meta 停在 T0
  const node = g.addSatellite({ name: 'ISS-stale', lon: m0.satLon, lat: m0.satLat, altKm: m0.satAlt })
  const key = await g.importSynthGrd(node.folder, 'A', synthGrd('st'))
  assert.equal(g.active.value, key)
  const cfg = () => g.getPerfContext(key).settings
  const eqDiff = (a, b) => Math.max(Math.abs(a.boreAz - b.boreAz), Math.abs(a.boreEl - b.boreEl), Math.abs(wrap180(a.yaw - b.yaw)))
  const hostEq = () => { const ax = axesNow(), gg = W.ecefToGeodetic(ax.S[0], ax.S[1], ax.S[2]); return BR.attEquivOf(ax.z, ax.up, gg.lon, gg.lat, gg.h, Number(cfg().yaw) || 0) }
  const oldEq = () => { const ax = axesNow(), mm = g.getPerfContext(key).meta, r = COV.attAxesReadout(mm, COV.beamBasisFrom(mm, { boreType: 'att', yaw: 0 }, null, ax)); return { boreAz: r.az, boreEl: r.el, yaw: r.psi } }
  g.setBoreSource('att'); await tick0()
  const rows = []
  for (const dtMin of [0.05, 1, 10]) {
    clk.t = T0 + dtMin * 60e3
    g.s.yaw = 0.5; await tick0()     // 改 Rot 再改回 → persistActive → syncAttEquiv 当场重写（宿主定时写回不跑 = 时钟停着）
    g.s.yaw = 0; await tick0()
    const ref = hostEq(), eq = cfg().attEquiv, rd = g.attReadout()
    assert.ok(eq && eqDiff(eq, ref) < 2e-6, `${dtMin} min：attEquiv ${JSON.stringify(eq)} vs 宿主 ${JSON.stringify(ref)}`)
    assert.ok(eqDiff({ boreAz: rd.az, boreEl: rd.el, yaw: rd.psi }, ref) < 1e-9, `${dtMin} min：读数`)
    // nadir 律 + 缺省挂点：视轴 ≈ 大地天底 → 落点 ≈ 此刻（不是 meta 那一刻）的星下点
    const ssp = issAt(clk.t).meta, stale = m0
    const dG = Math.hypot(wrap180(rd.lon - ssp.satLon) * Math.cos(ssp.satLat * D2R), rd.lat - ssp.satLat)
    const dS = Math.hypot(wrap180(stale.satLon - ssp.satLon) * Math.cos(ssp.satLat * D2R), stale.satLat - ssp.satLat)
    assert.ok(dG < 0.2, `${dtMin} min：落点离此刻星下点 ${dG}°`)
    const bg = g.boreGround()
    assert.ok(bg && Math.abs(bg.lon - rd.lon) < 1e-9 && Math.abs(bg.lat - rd.lat) < 1e-9, 'boreGround 与读数落点同一个点')
    const o = oldEq()
    rows.push(`${dtMin} min：新 ${eq.boreAz.toFixed(3)}/${eq.boreEl.toFixed(3)}° 旧 ${o.boreAz.toFixed(3)}/${o.boreEl.toFixed(3)}°（星下点挪了 ${dS.toFixed(2)}°）`)
    if (dtMin >= 1) assert.ok(eqDiff(o, ref) > 1, `${dtMin} min：旧口径应差出 > 1°（复现审查）`)
  }
  // 宿主没带 S（老宿主 / 固定星）→ 照旧用 meta：与 beamBasisFrom(meta) 那条式子逐位相同
  clk.withS = false
  g.s.yaw = 3; await tick0()
  const ax = axesNow(), mm = g.getPerfContext(key).meta
  const r0 = COV.attAxesReadout(mm, COV.beamBasisFrom(mm, cfg(), null, ax))
  const rd0 = g.attReadout()
  assert.equal(rd0.az, r0.az); assert.equal(rd0.el, r0.el); assert.equal(rd0.psi, r0.psi)
  // 固定星：宿主拿 meta 解（S = geodeticToEcef(meta)）→ 不经大地坐标往返，逐位同上
  clk.withS = true
  const hooksF = { getAttAxes: (meta) => { const S = W.geodeticToEcef(meta.satLon, meta.satLat || 0, meta.satAlt); const mb = AT.mountBasisEcef(AT.attitudeBasisEcef('nadir', null, { rEcef: S }), DEF_FRAME); return { z: mb.z.slice(), up: mb.y.slice(), S } }, attReady: () => true }
  const gf = useGrdCoverage(() => null, () => null, () => false, hooksF)
  const nf = gf.addSatellite({ name: 'GEO-fix', lon: 110.5, lat: 0, altKm: GEO_ALT })
  const kf = await gf.importSynthGrd(nf.folder, 'A', synthGrd('fx'))
  gf.setBoreSource('att'); await tick0()
  const mf = gf.getPerfContext(kf).meta, axf = hooksF.getAttAxes(mf)
  const rf = COV.attAxesReadout(mf, COV.beamBasisFrom(mf, gf.getPerfContext(kf).settings, null, axf))
  const rdf = gf.attReadout()
  assert.equal(rdf.az, rf.az); assert.equal(rdf.el, rf.el); assert.equal(rdf.psi, rf.psi)
  console.log('  ⑩ 等效指向（ISS，meta 停着）：' + rows.join('；'))
})

// ───────────────────────── ⑪ 对星时段扫描 attAt(tMs, tPosMs) 的两个时刻 ─────────────────────────
await t('⑪ 对星时段扫描：attAt 第一参 = 扫描（场景）时刻（太阳 / 目标律按它），第二参 = 源星取位时刻（自定义星座星 = tMs + ccOff，其它 = tMs）', async () => {
  const T0 = Date.UTC(2026, 7, 18, 12, 0, 0), CC = 1800e3
  const meta = { satLon: 100, satLat: 0, satAlt: GEO_ALT, folder: 'f', name: 'a' }
  const NX = 11, P1 = new Float32Array(NX * NX).fill(1), P2 = new Float32Array(NX * NX)
  const beam = { grid: { XS: -0.5, YS: -0.5, XE: 0.5, YE: 0.5, NX, NY: NX }, P1, P2 }
  const ctx = { key: 'f|a', igrid: 6, icomp: 3, meta, satName: 'S', antName: 'a', settings: { boreType: 'att', yaw: 0, pol: 'RSS', gainOffset: 0, pathLoss: 'none', ctype: 'abs' }, beams: [{ bi: 0, seq: 1, name: 'B1', peakDb: 0, beam }] }
  const times = { now: new Date(T0), gmst: sat.gstime(new Date(T0)), ccNow: new Date(T0 + CC), ccGmst: sat.gstime(new Date(T0 + CC)) }
  // 目标：同一组根数、平近点角挪半圈（与源星错开，免得星-星重合）
  const tgRec = sat.twoline2satrec(ISS_L1, ISS_L2.replace('325.0288', '145.0288'))
  const tg = [{ rec: tgRec, name: 'ISS-b', noradId: 99998, group: '', _cc: false }]
  for (const cc of [true, false]) {
    const calls = []
    const sp = SPT.useSatPerfTable()
    sp.setActiveKey('f|a'); sp.win.durH = 0.2
    await sp.computeWindows(ctx, null, tg, times, [], 0, { srcRec: { rec: issRec, _cc: cc }, boreRec: null, attAt: (a, b) => { calls.push([a, b]); return null } })
    assert.ok(calls.length > 5, `调用 ${calls.length} 次`)
    for (const [a, b] of calls) {
      assert.ok(a >= T0 - 1 && a <= T0 + 0.2 * 3600e3 + 1, `第一参在时窗里：${a - T0}`)
      assert.equal(b - a, cc ? CC : 0)
    }
    if (cc) console.log(`  ⑪ 自定义星座源星（ccOff = ${CC / 60e3} min）：attAt 调 ${calls.length} 次，第二参 − 第一参恒 = ccOff；普通源星恒 = 0`)
  }
})

// ───────────────────────── ⑫ 时段扫描「输入已变」认指向 ─────────────────────────
await t('⑫ 时段扫描指纹带指向：tickLive 自动改写（不锁定 geo 平移 / 锁定 azel 钉成 geo / att 定时写回）不算变；用户改指向 / 换挂点 / 改 Rot 算变、改回复原', async () => {
  // A. 纯函数：不锁定 geo 拼相对星下点的偏置（随星平移不变、用户挪 0.05° 算变）；锁定 azel 钉成 geo 前后同一个指纹
  const m = { satLon: 100, satLat: 0.3, satAlt: 550 }
  const stU = { boreType: 'geo', boreLock: false, boreLon: 101.2, boreLat: 3.4, yaw: 5 }
  const sig0 = SPT.pointingSig(stU, m)
  assert.ok(SPT.samePointing(sig0, SPT.pointingSig({ ...stU, boreLon: 131.2, boreLat: 4.4 }, { ...m, satLon: 130, satLat: 1.3 })), '随星平移不变')
  assert.ok(SPT.samePointing(sig0, SPT.pointingSig({ ...stU, boreLon: -178.8 }, { ...m, satLon: -180 })), '跨 ±180°')
  assert.ok(!SPT.samePointing(sig0, SPT.pointingSig({ ...stU, boreLat: 3.45 }, m)), '用户改纬度 0.05° 算变')
  const stL = { boreType: 'azel', boreLock: true, boreAz: 1.2, boreEl: -0.7, yaw: 0 }
  const mG = { satLon: 87.5, satLat: 0, satAlt: GEO_ALT }
  const gp = COV.azElGround(mG.satLon, 0, GEO_ALT, 1.2, -0.7)
  const pinned = { ...stL, boreType: 'geo', boreLon: +gp.lon.toFixed(4), boreLat: +gp.lat.toFixed(4) }
  assert.ok(SPT.samePointing(SPT.pointingSig(stL, mG), SPT.pointingSig(pinned, { ...mG, satLon: 87.9 })), '锁定 azel 钉成 geo 前后同指纹')
  assert.ok(!SPT.samePointing(SPT.pointingSig(stL, mG), SPT.pointingSig({ ...stL, boreEl: -0.8 }, mG)), '改 El 算变')
  // 越地平的锁定 azel 不钉：照 azel 比
  assert.equal(SPT.pointingSig({ ...stL, boreEl: 30 }, mG).k, 'azel')
  // att：挂点 / Rot / 来源签名进；定时写回（同签名、角度变）与律退过的 '!' 不进
  const at = { boreType: 'att', boreMount: 'm1', yaw: 0, attEquiv: { boreAz: 0, boreEl: 0, yaw: 10, sig: 'm1>m1|yawSteer|0|v3' } }
  const sa = SPT.pointingSig(at, mG)
  assert.ok(SPT.samePointing(sa, SPT.pointingSig({ ...at, attEquiv: { boreAz: 0.3, boreEl: 0.1, yaw: 55, sig: 'm1>m1|yawSteer|0|v3' } }, mG)))
  assert.ok(SPT.samePointing(sa, SPT.pointingSig({ ...at, attEquiv: { ...at.attEquiv, sig: 'm1>m1|yawSteer!|0|v3' } }, mG)))
  for (const ch of [{ boreMount: 'm2' }, { yaw: 1 }, { attEquiv: { ...at.attEquiv, sig: 'm1>m1|yawSteer|0|v4' } }, { boreType: 'azel' }]) {
    assert.ok(!SPT.samePointing(sa, SPT.pointingSig({ ...at, ...ch }, mG)), JSON.stringify(ch))
  }

  // B. 集成：真 useGrdCoverage（关联星 → tickLive 真走 moveCoverage）× 真 useSatPerfTable
  ensureHost()
  const { useGrdCoverage } = await import(SRC + 'grd/useGrdCoverage.js')
  const hooks = { getAttAxes: (meta, st) => { const S = W.geodeticToEcef(meta.satLon, meta.satLat || 0, meta.satAlt); const mb = AT.mountBasisEcef(AT.attitudeBasisEcef('nadir', null, { rEcef: S }), st.boreMount === 'm2' ? AT.mountFrame({ boresightBody: nrm([0.03, 0, 1]), upBody: [0, -1, 0] }) : DEF_FRAME); return { z: mb.z.slice(), up: mb.y.slice(), S, mount: st.boreMount || '', law: 'nadir' } }, attReady: () => true, getMountOptions: () => [{ id: '', name: 'Body +Z', match: false }, { id: 'm2', name: 'M2', match: false }] }
  const g = useGrdCoverage(() => null, () => null, () => false, hooks)
  const live = { lon: 87.5, lat: 0, altKm: GEO_ALT }
  g.setLivePos(() => ({ ...live }))
  const node = g.addSatellite({ name: 'LNK', noradId: 99999, lon: live.lon, lat: 0, altKm: GEO_ALT })
  const key = await g.importSynthGrd(node.folder, 'A', synthGrd('lk'))
  const T0 = Date.UTC(2026, 7, 18, 12, 0, 0)
  const times = { now: new Date(T0), gmst: sat.gstime(new Date(T0)), ccNow: new Date(T0), ccGmst: sat.gstime(new Date(T0)) }
  const tg = [{ rec: issRec, name: 'ISS', noradId: 25544, group: '', _cc: false }]
  const sp = SPT.useSatPerfTable()
  sp.setActiveKey(key); sp.win.durH = 0.1
  const scan = async () => { await sp.computeWindows(g.getPerfContext(key), null, tg, times, [], 0, {}); assert.equal(sp.winStaleFor(key), false, '刚扫完不过期') }
  const walk = (n, dLon, dLat) => { for (let k = 0; k < n; k++) { live.lon += dLon; live.lat += dLat; g.tickLive(key) } }
  const st = () => g.getPerfContext(key).settings
  // B1 出厂（azel 锁定天底）扫描 → 星一动钉成 geo：不过期
  assert.equal(st().boreType, 'azel'); assert.notEqual(st().boreLock, false)
  await scan()
  walk(1, 0.01, 0.002); await tick0()
  walk(4, 0.01, 0.002); await tick0()
  assert.equal(st().boreType, 'geo', 'moveCoverage 把锁定 azel 钉成了 geo')
  // 钉点 = 开扫那一刻（第一次移动之前）的星下点，异步回调不再按新星位的 az/el 重折（flush 'sync'）
  const gp0 = COV.azElGround(87.5, 0, GEO_ALT, 0, 0)
  assert.ok(Math.abs(st().boreLon - gp0.lon) < 1e-4 && Math.abs(st().boreLat - gp0.lat) < 1e-4, `钉点 ${st().boreLon},${st().boreLat} vs ${gp0.lon},${gp0.lat}`)
  assert.equal(sp.winStaleFor(key), false, '钉成 geo 不算用户改')
  // B2 星下点跟随（不锁定 geo）：播放 200 拍平移 → 不过期；用户挪纬度 → 过期；挪回 → 不过期
  g.setBoreMode('groundtrack'); await tick0()
  g.s.boreLat = +(g.s.boreLat + 1).toFixed(4); await tick0()
  await scan()
  const lon0 = st().boreLon
  walk(200, 0.013, 0.0007)
  assert.ok(Math.abs(st().boreLon - lon0) > 2, `平移了 ${st().boreLon - lon0}°`)
  assert.equal(sp.winStaleFor(key), false, '跟随平移不算用户改')
  const lat1 = g.s.boreLat
  g.s.boreLat = +(lat1 + 0.3).toFixed(4); await tick0()
  assert.equal(sp.winStaleFor(key), true, '用户改纬度 → 输入已变')
  g.s.boreLat = lat1; await tick0()
  assert.equal(sp.winStaleFor(key), false, '改回 → 不过期')
  // 慢漂的星（每拍 3e-5°，小于 toFixed(4) 的舍入步长）：moveCoverage 的平移被舍入整段吞掉，相对偏置一直在漂 —— 用户改了又改回来之后（计数已吸收）同样不比，不误报
  const nSlow = 3000, off0 = st().boreLon - live.lon
  walk(nSlow, 3e-5, 0)
  const drift = Math.abs((st().boreLon - live.lon) - off0)
  assert.ok(drift > 0.02, `舍入吞掉的平移 ${drift}°（夹具该让它超过容差）`)
  assert.equal(sp.winStaleFor(key), false, '慢漂不算用户改')
  // B3 att：扫描后宿主定时写回（同签名、角度变）不过期；换挂点过期；Rot 改了过期
  g.setBoreSource('att'); await tick0()
  await scan()
  const eq = st().attEquiv
  assert.ok(eq && typeof eq.sig === 'string', JSON.stringify(eq))
  g.setAttEquiv(key, { boreAz: eq.boreAz + 0.2, boreEl: eq.boreEl, yaw: eq.yaw + 3 })
  assert.equal(sp.winStaleFor(key), false, '定时写回不算变')
  g.setBoreMount('m2'); await tick0()
  assert.equal(sp.winStaleFor(key), true, '换挂点 → 输入已变')
  g.setBoreMount(''); await tick0()
  assert.equal(sp.winStaleFor(key), false, '换回 → 不过期')
  g.s.yaw = 7; await tick0()
  assert.equal(sp.winStaleFor(key), true, '改 Rot → 输入已变')
  // B4 没扫过 / 清空目标：只看老的那几项（不因指纹炸）
  const sp2 = SPT.useSatPerfTable()
  assert.equal(sp2.winStaleFor(key), true)
  console.log(`  ⑫ 慢漂星 ${nSlow} 拍（每拍 3e-5°，toFixed(4) 吞掉的平移累计 ${drift.toFixed(4)}°）不过期；锁定 azel 钉 geo / att 定时写回不过期；改纬度 / 换挂点 / 改 Rot 过期，改回复原`)
})

// ───────────────────────── ⑬ boreType 换算只认用户切档（换聚焦 / 程序同步不折算）─────────────────────────
// 写 ⑫ 时发现的既有问题（HEAD 同样）：boreType watch 缺省 flush 'pre'，回调时 _muteSync 已复位 ——
// 换聚焦 azel 天线 → geo 天线，geo 天线的目标点被它陈旧的 az/el 冲掉；反过来 azel 天线的 az/el 被陈旧经纬冲掉。
await t('⑬ 换聚焦不改任何天线的指向（geo 目标点 / azel 偏置原样）；用户切档照旧无缝换算', async () => {
  ensureHost()
  const { useGrdCoverage } = await import(SRC + 'grd/useGrdCoverage.js')
  const g = useGrdCoverage(() => null, () => null, () => false, {})
  const node = g.addSatellite({ name: 'GEO-F', lon: 100, lat: 0, altKm: GEO_ALT })
  const kA = await g.importSynthGrd(node.folder, 'A', synthGrd('fa'))
  const kB = await g.importSynthGrd(node.folder, 'B', synthGrd('fb'))
  const cfg = (k) => g.getPerfContext(k).settings
  // A：本体固定 az/el = (1.5, −0.8)
  g.setActiveKey(kA); await tick0()
  g.setBoreMode('fixed'); await tick0()
  g.s.boreAz = 1.5; g.s.boreEl = -0.8; await tick0()
  // B：目标跟踪，手填目标点 (105, 5)（az/el 留着切档那一刻的 0 / 0）
  g.setActiveKey(kB); await tick0()
  g.setBoreMode('target'); await tick0()
  g.s.boreLon = 105; g.s.boreLat = 5; await tick0()
  const snap = (k) => { const c = cfg(k); return JSON.stringify([c.boreType, c.boreLon, c.boreLat, c.boreAz, c.boreEl, c.boreLock]) }
  const a0 = snap(kA), b0 = snap(kB)
  for (let r = 0; r < 3; r++) {
    g.setActiveKey(kA); await tick0()
    assert.equal(snap(kA), a0, `第 ${r} 轮：A 的指向被改`)
    assert.equal(g.s.boreAz, 1.5); assert.equal(g.s.boreEl, -0.8)
    g.setActiveKey(kB); await tick0()
    assert.equal(snap(kB), b0, `第 ${r} 轮：B 的指向被改`)
    assert.equal(g.s.boreLon, 105); assert.equal(g.s.boreLat, 5)
  }
  // 用户切档：B 目标跟踪 → 本体固定，az/el 取目标点 (105, 5) 的方向（无缝，不跳回 0 / 0）
  g.setBoreMode('fixed'); await tick0()
  const ae = COV.dirToAzEl ? COV.dirToAzEl(100, 0, GEO_ALT, 105, 5) : null
  assert.ok(Math.abs(g.s.boreAz) > 0.5 && Math.abs(g.s.boreEl) > 0.5, `切档换算 ${g.s.boreAz}/${g.s.boreEl}`)
  if (ae) { assert.ok(Math.abs(g.s.boreAz - +ae.az.toFixed(3)) < 1e-9 && Math.abs(g.s.boreEl - +ae.el.toFixed(3)) < 1e-9) }
  const gb = g.boreGround()
  assert.ok(Math.abs(gb.lon - 105) < 0.01 && Math.abs(gb.lat - 5) < 0.01, `切档后落点 ${gb.lon},${gb.lat}`)
  console.log(`  ⑬ 换聚焦 3 轮：A azel(1.5, −0.8) / B geo(105, 5) 逐字不变；B 切本体固定 → az/el ${g.s.boreAz}/${g.s.boreEl}（落点 ${gb.lon.toFixed(4)}, ${gb.lat.toFixed(4)}）`)
})

console.log(`modelAttPointing: ${n} 项通过`)
