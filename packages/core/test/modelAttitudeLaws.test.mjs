// 二期姿态律 / 挂点系 / 视线换算（packages/core/models/attitude.mjs 后半）的回归网。
//
//   ① 五种律输出正交归一、右手（随机 600 组）；nadir +Z 精确指地心（< 1e-12）；与一期 bodyQuatSceneNadir 同一姿态。
//   ② yawSteer：翼轴·太阳 < 1e-6；β/μ 闭式与矢量式同值；任务书字面式（μ 自正午）的残差被钉住；正午 / 午夜奇点附近
//      连续性与峰值偏航角速率（≈ ω/tanβ）报数；limitYawRate 不超限。
//   ③ target / sun：主轴指向误差 < 1e-9 rad；次约束落在主–次平面内、朝次方向一侧；退化时退链。
//   ④ inertial：gmstRadAt 与 satellite.js gstime 逐位一致；TEME → ECEF 与 eciToEcf 同一转动。
//   ⑤ D1 零跳变：赤道 GEO「nadir + 视轴 +Z + up [0,−1,0]」与 coverage.js beamBasisFrom(azel 0,0) 逐分量 < 1e-12；
//      LEO 纬度 40° 三轴夹角 < 0.2°（大地 / 地心天底之差，报数）。
//   ⑥ 挂点系、单轴对日、四元数互换、Meeus 太阳与 terminator.solarGeometry 对拍、日地距离。
//   ⑦ 热路径分配量（采样堆分析，含被 GC 收走的对象）：五种律 / sunEcefApprox / sunDistanceAu / gmstRadAt 每次调用的平均字节数（报数）。

import assert from 'node:assert/strict'
import {
  attitudeBasisEcef, makeBasis, ATT_LAWS, OMEGA_EARTH_RAD_S, yawFromNadir, limitYawRate,
  basisToQuat, quatToBasis, basisToQuatScene, ecefToScene, sceneToEcef, losToBody, bodyToEcef,
  mountFrame, mountBasisEcef, dirBodyToMount, dirMountToBody, azElInMount,
  articulationSunAngle, rotateAboutAxis, gmstRadAt, sunEcefApprox, sunDistanceAu,
  bodyQuatSceneNadir, quatRotate, eclipseFactor
} from '../models/attitude.mjs'
import { beamBasisFrom } from '../../../src/viz/grd/coverage.js'
import { geodeticToEcef, RS_GEO, A as WGS_A } from '../../../src/viz/wgs84.js'
import { solarGeometry } from '../../../src/viz/terminator.js'
import sat from '../../../src/viz/constellation/satellite.js'
import { Session } from 'node:inspector/promises'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const ang = (a, b) => Math.atan2(len(cross(a, b)), dot(a, b))          // 小角度也准
const D2R = Math.PI / 180, R2D = 180 / Math.PI

let seed = 20260924
const N_ALLOC = 300000
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const rndUnit = () => { for (;;) { const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1]; const l = len(v); if (l > 0.1 && l < 1) return v.map((x) => x / l) } }

// 圆轨道上的一点（ECEF 与惯性共轴的瞬间：姿态律只看方向，轴向一致即可）
function orbitPoint(a, iDeg, raanDeg, uDeg) {
  const i = iDeg * D2R, O = raanDeg * D2R, u = uDeg * D2R, v = Math.sqrt(398600.4418 / a)
  const P = [Math.cos(O), Math.sin(O), 0], Q = [-Math.sin(O) * Math.cos(i), Math.cos(O) * Math.cos(i), Math.sin(i)]
  const r = [0, 1, 2].map((k) => a * (Math.cos(u) * P[k] + Math.sin(u) * Q[k]))
  const vv = [0, 1, 2].map((k) => v * (-Math.sin(u) * P[k] + Math.cos(u) * Q[k]))
  return { r, v: vv }
}
function checkOrtho(b, tol, msg) {
  for (const k of ['X', 'Y', 'Z']) near(len(b[k]), 1, tol, `${msg} |${k}|`)
  near(dot(b.X, b.Y), 0, tol, `${msg} X·Y`); near(dot(b.Y, b.Z), 0, tol, `${msg} Y·Z`); near(dot(b.Z, b.X), 0, tol, `${msg} Z·X`)
  near(dot(cross(b.X, b.Y), b.Z), 1, tol, `${msg} det`)
}
function randomCtx() {
  const a = 6371 + 300 + rnd() * 40000
  const { r, v } = orbitPoint(a, rnd() * 180, rnd() * 360, rnd() * 360)
  const kr = 0.3 * rnd()
  const vr = v.map((x, i) => x + kr * r[i] / len(r))          // 带一点径向速度（偏心轨道的样子）
  const tgt = rnd() < 0.5 ? geodeticToEcef(rnd() * 360 - 180, rnd() * 160 - 80, 0) : orbitPoint(6371 + 500 + rnd() * 36000, rnd() * 180, rnd() * 360, rnd() * 360).r
  return { rEcef: r, vInertialEcef: vr, sunEcef: rndUnit(), targetEcef: tgt, gmstRad: rnd() * 2 * Math.PI, tMs: Date.UTC(2026, 8, 24) + rnd() * 1e9 }
}

// ───────────────────────── ① 正交归一 + nadir ─────────────────────────
t('五种律 × 600 组：正交归一、右手（< 1e-12）；out 复用返回同一对象', () => {
  const out = makeBasis()
  for (let k = 0; k < 600; k++) {
    const ctx = randomCtx()
    const law = ATT_LAWS[k % 5]
    const params = law === 'sun' ? { axis: rnd() < 0.5 ? [0, 0, -1] : rndUnit(), secondary: ['nadir', 'velocity', 'orbitNormal'][k % 3] }
      : law === 'target' ? { axis: rnd() < 0.5 ? [0, 0, 1] : rndUnit(), secondary: ['sun', 'nadir', 'velocity'][k % 3] }
      : law === 'inertial' ? (k % 2 ? { q: [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5] } : { eulerDeg: { yaw: rnd() * 360, pitch: rnd() * 180 - 90, roll: rnd() * 360 } })
      : law === 'nadir' ? { yawBiasDeg: rnd() * 20 - 10 } : {}
    const b = attitudeBasisEcef(law, params, ctx, out)
    assert.equal(b, out, 'out 复用')
    checkOrtho(b, 1e-12, `${law}#${k}`)
    assert.ok(!b.fallback || law === 'target' || law === 'sun', `${law}#${k} 不该退化`)
  }
})

t('nadir：+Z 精确指地心（< 1e-12 rad）、+X 沿速度水平投影、与一期 bodyQuatSceneNadir 同一姿态', () => {
  let worst = 0, worstQ = 0
  for (let k = 0; k < 400; k++) {
    const { rEcef, vInertialEcef } = randomCtx()
    const b = attitudeBasisEcef('nadir', null, { rEcef, vInertialEcef })
    worst = Math.max(worst, ang(b.Z, nrm(rEcef).map((x) => -x)))
    const up = nrm(rEcef), vh = nrm(vInertialEcef.map((x, i) => x - dot(vInertialEcef, up) * up[i]))
    assert.ok(ang(b.X, vh) < 1e-12, '+X 沿速度水平投影')
    const q1 = basisToQuatScene(b), q0 = bodyQuatSceneNadir(rEcef, vInertialEcef)
    worstQ = Math.max(worstQ, Math.min(len(sub(q1, q0)) + Math.abs(q1[3] - q0[3]), Math.hypot(q1[0] + q0[0], q1[1] + q0[1], q1[2] + q0[2], q1[3] + q0[3])))
  }
  assert.ok(worst < 1e-12, `+Z 最差 ${worst}`)
  assert.ok(worstQ < 1e-12, `与 bodyQuatSceneNadir 最差 ${worstQ}`)
  console.log(`  nadir：+Z 对地心最差 ${worst.toExponential(2)} rad，与一期场景四元数最差 ${worstQ.toExponential(2)}`)
})

t('nadir：速度缺省按 ω⊕ẑ × r 合成（赤道 GEO → +X = 东）；速度 ∥ 径向时退到正东；极点不出 NaN', () => {
  const lon = 105.5 * D2R, r = [RS_GEO * Math.cos(lon), RS_GEO * Math.sin(lon), 0]
  const b = attitudeBasisEcef('nadir', null, { rEcef: r })
  const east = [-Math.sin(lon), Math.cos(lon), 0]
  assert.ok(ang(b.X, east) < 1e-15, '+X 东')
  assert.ok(ang(b.Y, [0, 0, -1]) < 1e-15, '+Y 南')
  const b2 = attitudeBasisEcef('nadir', null, { rEcef: r, vInertialEcef: r.map((x) => x * 1e-3) })
  assert.ok(ang(b2.X, east) < 1e-15, '纯径向速度 → 正东')
  const b3 = attitudeBasisEcef('nadir', null, { rEcef: [0, 0, 7000], vInertialEcef: [0, 0, 1] })
  checkOrtho(b3, 1e-15, '极点')
  assert.equal(attitudeBasisEcef('nadir', null, { rEcef: [0, 0, 0] }), null, 'r = 0 → null')
  assert.equal(attitudeBasisEcef('nadir', null, null), null, 'ctx 缺 → null')
  assert.equal(OMEGA_EARTH_RAD_S, 7.292115e-5)
})

// ───────────────────────── ② yawSteer ─────────────────────────
t('yawSteer：翼轴（±Y）·太阳 < 1e-6（实测 1e-15 量级）；sunSide +X / −X 分别让太阳落在 ±X′ 半平面', () => {
  let worst = 0
  for (let k = 0; k < 2000; k++) {
    const ctx = randomCtx()
    const b = attitudeBasisEcef('yawSteer', {}, ctx)
    const s = nrm(ctx.sunEcef)
    worst = Math.max(worst, Math.abs(dot(b.Y, s)))
    assert.ok(dot(b.X, s) >= -1e-15, '+X 侧')
    const nad = attitudeBasisEcef('nadir', null, ctx)
    assert.ok(ang(b.Z, nad.Z) === 0, 'Z 不动（逐位）')
    const bm = attitudeBasisEcef('yawSteer', { sunSide: '-X' }, ctx)
    assert.ok(Math.abs(dot(bm.Y, s)) < 1e-12 && dot(bm.X, s) <= 1e-15, '−X 侧')
    // 偏航角的定义：nadir 绕 +Z 右手转 yawDeg
    const re = yawFromNadir(nad, b.yawDeg)
    assert.ok(len(sub(re.X, b.X)) < 1e-14 && len(sub(re.Y, b.Y)) < 1e-14, 'yawFromNadir 复原')
  }
  assert.ok(worst < 1e-6, `翼轴·太阳最差 ${worst}`)
  console.log(`  yawSteer：翼轴·太阳最差 ${worst.toExponential(2)}（2000 组）`)
})

// 圆轨道 + 固定惯性系太阳（β 由太阳与轨道面决定）：u 自升交点，μ 自轨道正午
function betaMuCase(betaDeg, a = 6371 + 700) {
  const i = 55, raan = 30
  const h = nrm(cross(orbitPoint(a, i, raan, 0).r, orbitPoint(a, i, raan, 90).r))       // 轨道法向
  const p = orbitPoint(a, i, raan, 40).r.map((x) => x / a)                                  // 正午方向 = 太阳在轨道面的投影（取 u = 40°）
  const b = betaDeg * D2R
  const sun = nrm(p.map((x, k) => Math.cos(b) * x + Math.sin(b) * h[k]))
  return { a, i, raan, sun, uNoon: 40 }
}

t('yawSteer：矢量式 ψ 与 β/μ 闭式 atan2(−tanβ, −sin μ) 同值；任务书式 atan2(−tanβ, sin μ) 需 μ 自午夜起算', () => {
  for (const beta of [-60, -20, -3, 0.7, 5, 30, 75]) {
    const { a, i, raan, sun, uNoon } = betaMuCase(beta)
    let worstTbNoon = 0
    for (let u = 0; u < 360; u += 7.3) {
      const { r, v } = orbitPoint(a, i, raan, u)
      const bs = attitudeBasisEcef('yawSteer', {}, { rEcef: r, vInertialEcef: v, sunEcef: sun })
      const mu = (u - uNoon) * D2R, bt = beta * D2R
      const psiA = Math.atan2(-Math.tan(bt), -Math.sin(mu)) * R2D
      const dpsi = ((bs.yawDeg - psiA + 540) % 360) - 180
      assert.ok(Math.abs(dpsi) < 1e-9 || Math.hypot(Math.sin(mu), Math.tan(bt)) < 1e-9, `β=${beta} u=${u}：${bs.yawDeg} vs ${psiA}`)
      const psiMid = Math.atan2(-Math.tan(bt), Math.sin(mu + Math.PI)) * R2D                // 任务书式，μ 自午夜
      assert.ok(Math.abs(((bs.yawDeg - psiMid + 540) % 360) - 180) < 1e-9 || Math.abs(Math.sin(mu)) < 1e-9, `任务书式（μ 自午夜）β=${beta} u=${u}`)
      // 照任务书字面（μ 自正午）代入：翼轴与太阳点积的残差
      const psiTb = Math.atan2(-Math.tan(bt), Math.sin(mu))
      const nad = attitudeBasisEcef('nadir', null, { rEcef: r, vInertialEcef: v })
      const yb = yawFromNadir(nad, psiTb * R2D).Y
      worstTbNoon = Math.max(worstTbNoon, Math.abs(dot(yb, sun)))
    }
    if (Math.abs(beta) >= 5) assert.ok(worstTbNoon > 0.05, `β=${beta}：任务书字面式应有明显残差，实测 ${worstTbNoon}`)
    if (beta === 30) console.log(`  任务书字面式（μ 自正午）β=30° 翼轴·太阳最差 ${worstTbNoon.toFixed(4)}（sin2β = ${Math.sin(60 * D2R).toFixed(4)}）`)
  }
})

t('yawSteer：轨道正午 / 午夜两处奇点附近的连续性（1 s 步长，各 ±10 min；报单步最大、理论峰值 ω/tanβ 与翼轴·太阳）；β = 0 恰过奇点取 prevYawDeg', () => {
  for (const [where, du] of [['正午', 0], ['午夜', 180]]) {
    const rows = []
    for (const beta of [0.5, 2, 10, 30]) {
      const { a, i, raan, sun, uNoon } = betaMuCase(beta)
      const w = Math.sqrt(398600.4418 / a ** 3) * R2D                      // °/s 轨道角速率
      let prev = null, maxStep = 0, worstDot = 0
      for (let s = -600; s <= 600; s++) {                                   // 奇点 ±10 min
        const { r, v } = orbitPoint(a, i, raan, uNoon + du + w * s)
        const b = attitudeBasisEcef('yawSteer', {}, { rEcef: r, vInertialEcef: v, sunEcef: sun, prevYawDeg: prev })
        worstDot = Math.max(worstDot, Math.abs(dot(b.Y, sun)))
        if (prev != null) maxStep = Math.max(maxStep, Math.abs(((b.yawDeg - prev + 540) % 360) - 180))
        prev = b.yawDeg
      }
      const theory = w / Math.tan(beta * D2R)                               // 1 s 步长：单步最大（°）≈ 峰值速率（°/s）
      rows.push(`β=${beta}° 单步最大 ${maxStep.toFixed(4)}°（理论峰值 ${theory.toFixed(4)}°/s），翼轴·太阳 ≤ ${worstDot.toExponential(1)}`)
      if (beta >= 2) near(maxStep, theory, theory * 0.01, `${where} β=${beta} 峰值偏航速率`)
      else assert.ok(maxStep < theory * 1.01 && maxStep > theory * 0.9, `${where} β=${beta}：${maxStep} vs ${theory}`)
      assert.ok(maxStep < 180, '不出现 ±180° 跳变（选根连续）')
      assert.ok(worstDot < 1e-12, `${where} β=${beta} 翼轴·太阳 ${worstDot}`)
    }
    console.log(`  ${where}附近 1 s 步长：` + rows.join('；'))
  }
  // β = 0 恰在正午：太阳在 −Z 上 → 取 prevYawDeg
  const { a, i, raan, sun, uNoon } = betaMuCase(0)
  const { r, v } = orbitPoint(a, i, raan, uNoon)
  const s0 = nrm(r)                                                           // 正午：太阳 = 径向
  const b = attitudeBasisEcef('yawSteer', {}, { rEcef: r, vInertialEcef: v, sunEcef: s0, prevYawDeg: -90 })
  assert.equal(b.yawDeg, -90, '奇点取上一拍')
  assert.ok(Math.abs(dot(b.Y, s0)) < 1e-15, '奇点处任何偏航都 ⟂')
  void sun
})

t('limitYawRate：单步不超 maxRate·Δt、沿最短方向、翻转后追上目标', () => {
  const { a, i, raan, sun, uNoon } = betaMuCase(0.5)
  const w = Math.sqrt(398600.4418 / a ** 3) * R2D
  const tMs = [], psi = []
  let prev = null
  for (let s = -1800; s <= 1800; s += 5) {
    const { r, v } = orbitPoint(a, i, raan, uNoon + w * s)
    const b = attitudeBasisEcef('yawSteer', {}, { rEcef: r, vInertialEcef: v, sunEcef: sun, prevYawDeg: prev })
    prev = b.yawDeg; tMs.push(s * 1000); psi.push(b.yawDeg)
  }
  const lim = limitYawRate(psi, tMs, 0.12)
  let worst = 0
  for (let k = 1; k < lim.length; k++) worst = Math.max(worst, Math.abs(((lim[k] - lim[k - 1] + 540) % 360) - 180) / 5)
  assert.ok(worst <= 0.12 + 1e-9, `最大速率 ${worst}`)
  near(Math.abs(((lim[lim.length - 1] - psi[psi.length - 1] + 540) % 360) - 180), 0, 1e-9, '末端追上')
  const raw = limitYawRate(psi, tMs, 0)
  assert.deepEqual(Array.from(raw), psi, '不限幅时原样')
})

t('limitYawRate：坏拍（NaN）输出 NaN、不污染后面；缺拍后从上一个有限拍接着追（可转角度按距上一个有限拍的时长）；全有限时与逐拍递推逐位相同', () => {
  assert.deepEqual(Array.from(limitYawRate([10, NaN, 12, 13], [0, 1000, 2000, 3000], 5)), [10, NaN, 12, 13], '审查实测用例')
  assert.deepEqual(Array.from(limitYawRate([10, NaN, 12, 13], [0, 1000, 2000, 3000], 0.5)), [10, NaN, 11, 11.5], '缺拍期间保持、按 2 s 追')
  assert.deepEqual(Array.from(limitYawRate([NaN, NaN, 5, 6], [0, 1000, 2000, 3000], 1)), [NaN, NaN, 5, 6], '开头的坏拍')
  assert.deepEqual(Array.from(limitYawRate([170, Infinity, -170], [0, 1000, 2000], 5)), [170, NaN, 180], '跨 ±180 走最短方向（170 → 180，再差 10° 追不完）')
  assert.deepEqual(Array.from(limitYawRate([1, NaN, 3], [0, 1, 2], 0)), [1, NaN, 3], '不限幅：坏拍照样 NaN')
  // 全有限：与改前的逐拍递推（参照实现）逐位相同
  const ref = (y, tt, lim) => { const o = [y[0]]; for (let k = 1; k < y.length; k++) { let d = y[k] - o[k - 1]; d = ((d % 360) + 540) % 360 - 180; const st = lim * Math.max(0, (tt[k] - tt[k - 1]) / 1000); let v = o[k - 1] + (Math.abs(d) <= st ? d : Math.sign(d) * st); v = ((v % 360) + 540) % 360 - 180; o.push(v === -180 ? 180 : v) } return o }
  for (let rep = 0; rep < 50; rep++) {
    const y = [], tt = []
    let tc = 0
    for (let k = 0; k < 400; k++) { y.push(rnd() * 360 - 180); tc += 200 + rnd() * 3000; tt.push(tc) }
    const lim = 0.05 + rnd() * 2
    const got = Array.from(limitYawRate(y, tt, lim)), want = ref(y, tt, lim)
    for (let k = 0; k < y.length; k++) assert.ok(Object.is(got[k], want[k]), `rep ${rep} k ${k}`)
  }
})

// ───────────────────────── ③ target / sun ─────────────────────────
t('target：主轴指向误差 < 1e-9 rad（地球站与他星、随机本体轴）；次约束 sun ⇒ Y ⟂ 太阳且太阳在 +X 侧', () => {
  let worst = 0, worstY = 0
  for (let k = 0; k < 1500; k++) {
    const ctx = randomCtx()
    const axis = k % 3 === 0 ? [0, 0, 1] : rndUnit()
    const b = attitudeBasisEcef('target', { axis }, ctx)
    const img = bodyToEcef(axis, b)
    const want = nrm(sub(ctx.targetEcef, ctx.rEcef))
    worst = Math.max(worst, ang(img, want))
    if (axis[2] === 1 && !b.fallback) {
      worstY = Math.max(worstY, Math.abs(dot(b.Y, ctx.sunEcef)))
      assert.ok(dot(b.X, ctx.sunEcef) >= -1e-12, '太阳在 +X 侧')
    }
  }
  assert.ok(worst < 1e-9, `target 最差 ${worst}`)
  assert.ok(worstY < 1e-12, `Y·太阳 ${worstY}`)
  console.log(`  target：主轴指向最差 ${worst.toExponential(2)} rad；翼轴·太阳 ${worstY.toExponential(2)}`)
})

t('sun：缺省 −Z 指太阳、次约束 +X 对速度（X 在 太阳–速度 平面内朝速度侧）；axis +X 时次约束缺省对地', () => {
  let worst = 0
  for (let k = 0; k < 800; k++) {
    const ctx = randomCtx()
    const b = attitudeBasisEcef('sun', {}, ctx)
    const s = nrm(ctx.sunEcef)
    worst = Math.max(worst, ang(b.Z.map((x) => -x), s))
    const v = nrm(ctx.vInertialEcef)
    near(dot(cross(s, v), b.X), 0, 1e-12, 'X ∈ span(太阳, 速度)')
    assert.ok(dot(b.X, sub(v, s.map((x) => x * dot(v, s)))) > 0, 'X 朝速度一侧')
    const b2 = attitudeBasisEcef('sun', { axis: [1, 0, 0] }, ctx)
    worst = Math.max(worst, ang(b2.X, s))
    const nad = nrm(ctx.rEcef).map((x) => -x)
    near(dot(cross(s, nad), b2.Z), 0, 1e-12, 'Z ∈ span(太阳, 天底)')
  }
  assert.ok(worst < 1e-9, `sun 最差 ${worst}`)
})

t('退化：目标与星重合 / 缺太阳 → 退回 nadir 并标 fallback；主次同向 → 退链到 velocity', () => {
  const ctx = randomCtx()
  const b = attitudeBasisEcef('target', {}, { ...ctx, targetEcef: ctx.rEcef })
  assert.equal(b.law, 'nadir'); assert.equal(b.fallback, true)
  const b2 = attitudeBasisEcef('yawSteer', {}, { ...ctx, sunEcef: undefined })
  assert.equal(b2.law, 'nadir'); assert.equal(b2.fallback, true)
  // 太阳恰在天底方向、次约束对地 → 主次世界方向平行 → 退到 velocity
  const nad = nrm(ctx.rEcef).map((x) => -x)
  const b3 = attitudeBasisEcef('sun', { axis: [1, 0, 0], secondary: 'nadir' }, { ...ctx, sunEcef: nad })
  assert.equal(b3.law, 'sun'); assert.equal(b3.fallback, true)
  assert.ok(ang(b3.X, nad) < 1e-12)
  const b4 = attitudeBasisEcef('bogus', null, ctx)
  assert.equal(b4.law, 'nadir'); assert.equal(b4.fallback, true)
})

// ───────────────────────── ④ inertial / GMST ─────────────────────────
t('gmstRadAt（不经 Date、整数日历现算）与 satellite.js gstime(new Date(t)) 逐位一致：随机 1900–2100 含小数毫秒与 1970 前、闰日 / 世纪年 / 跨日边界、非法时刻', () => {
  const same = (ms, msg) => assert.ok(Object.is(gmstRadAt(ms), sat.gstime(new Date(ms))), `${msg} t=${ms}：${gmstRadAt(ms)} vs ${sat.gstime(new Date(ms))}`)
  for (let k = 0; k < 3000; k++) same(Math.round(Date.UTC(1995, 0, 1) + rnd() * 50 * 365.25 * 86400000), '整毫秒')
  for (let k = 0; k < 3000; k++) same(Date.UTC(1900, 0, 1) + rnd() * 200 * 365.25 * 86400000, '小数毫秒 1900–2100')
  const edges = [Date.UTC(2024, 1, 29, 23, 59, 59, 999), Date.UTC(2024, 2, 1), Date.UTC(2000, 1, 29, 12), Date.UTC(1900, 1, 28, 23, 59, 59, 999), Date.UTC(1900, 2, 1),
    Date.UTC(2100, 1, 28, 23, 59, 59, 999), Date.UTC(2100, 2, 1), Date.UTC(1969, 11, 31, 23, 59, 59, 999), 0, -0, -1, -0.5, 0.5, -86400000.5, Date.UTC(1600, 0, 1), Date.UTC(-1, 5, 1), 8.64e15, -8.64e15]
  for (const ms of edges) { same(ms, '边界'); same(ms + 0.999, '边界 + 0.999'); same(ms - 0.001, '边界 − 0.001') }
  for (const bad of [NaN, Infinity, -Infinity, 8.64e15 + 1, -8.64e15 - 1]) same(bad, '非法')
})

t('inertial：TEME 下本体轴 = q 旋转；ECEF 与 eciToEcf 同一转动；eulerDeg 3-2-1 与 q 等价；缺 GMST 退 nadir', () => {
  for (let k = 0; k < 300; k++) {
    const ctx = randomCtx()
    const q0 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], l = Math.hypot(...q0), q = q0.map((x) => x / l)
    const b = attitudeBasisEcef('inertial', { q }, ctx)
    for (const [k2, e] of [['X', [1, 0, 0]], ['Y', [0, 1, 0]], ['Z', [0, 0, 1]]]) {
      const teme = quatRotate(q, e)
      const ecf = sat.eciToEcf({ x: teme[0], y: teme[1], z: teme[2] }, ctx.gmstRad)
      assert.ok(len(sub(b[k2], [ecf.x, ecf.y, ecf.z])) < 4e-15, k2)
    }
    const b2 = attitudeBasisEcef('inertial', { q }, { rEcef: ctx.rEcef, tMs: ctx.tMs })
    const b3 = attitudeBasisEcef('inertial', { q }, { rEcef: ctx.rEcef, gmstRad: gmstRadAt(ctx.tMs) })
    assert.ok(len(sub(b2.X, b3.X)) === 0, 'tMs 与 gmstRad 两条路逐位一致')
  }
  // 欧拉 3-2-1：yaw 90° 让本体 X 转到惯性 Y
  const b = attitudeBasisEcef('inertial', { eulerDeg: { yaw: 90, pitch: 0, roll: 0 } }, { rEcef: [7000, 0, 0], gmstRad: 0 })
  assert.ok(len(sub(b.X, [0, 1, 0])) < 1e-15 && len(sub(b.Z, [0, 0, 1])) < 1e-15)
  const b2 = attitudeBasisEcef('inertial', { eulerDeg: { yaw: 30, pitch: 20, roll: 10 } }, { rEcef: [7000, 0, 0], gmstRad: 0 })
  const q = basisToQuat(b2)
  const c = (x) => Math.cos(x * D2R / 2), s = (x) => Math.sin(x * D2R / 2)
  const qz = [0, 0, s(30), c(30)], qy = [0, s(20), 0, c(20)], qx = [s(10), 0, 0, c(10)]
  const mul = (a2, b1) => [a2[3] * b1[0] + a2[0] * b1[3] + a2[1] * b1[2] - a2[2] * b1[1], a2[3] * b1[1] - a2[0] * b1[2] + a2[1] * b1[3] + a2[2] * b1[0], a2[3] * b1[2] + a2[0] * b1[1] - a2[1] * b1[0] + a2[2] * b1[3], a2[3] * b1[3] - a2[0] * b1[0] - a2[1] * b1[1] - a2[2] * b1[2]]
  const qe = mul(mul(qz, qy), qx)
  assert.ok(Math.min(Math.hypot(...q.map((x, i) => x - qe[i])), Math.hypot(...q.map((x, i) => x + qe[i]))) < 1e-14, 'euler 3-2-1')
  const b4 = attitudeBasisEcef('inertial', { q: [0, 0, 0, 1] }, { rEcef: [7000, 0, 0] })
  assert.equal(b4.law, 'nadir'); assert.equal(b4.fallback, true)
})

// ───────────────────────── ⑤ D1 零跳变 ─────────────────────────
t('D1：赤道 GEO「nadir + 视轴 +Z + up [0,−1,0]」与 beamBasisFrom(azel 0,0) 的 x/y/z 逐分量 < 1e-12', () => {
  const frame = mountFrame({ boresightBody: [0, 0, 1], upBody: [0, -1, 0] })
  const frameDef = mountFrame({ boresightBody: [0, 0, 1] })                      // up 缺省按 D1 也得 −Y
  assert.deepEqual(frameDef, frame)
  let worst = 0
  for (let lon = -180; lon < 180; lon += 7.5) {
    const meta = { satLon: lon, satLat: 0, satAlt: RS_GEO - WGS_A }
    const ref = beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 })
    const S = geodeticToEcef(lon, 0, meta.satAlt)
    const vGeo = [-Math.sin(lon * D2R) * 3.0747, Math.cos(lon * D2R) * 3.0747, 0]
    for (const v of [vGeo, undefined]) {
      const body = attitudeBasisEcef('nadir', null, { rEcef: S, vInertialEcef: v })
      const mb = mountBasisEcef(body, frame)
      for (const k of ['x', 'y', 'z']) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(mb[k][c] - ref[k][c]))
    }
  }
  assert.ok(worst < 1e-12, `最差 ${worst}`)
  console.log(`  D1 赤道 GEO：挂点基底与手动天底逐分量最差 ${worst.toExponential(2)}`)
})

t('D1：LEO 纬度 40°（i = 40° 轨道顶点，速度正东）三轴与手动天底夹角 < 0.2°（大地 / 地心天底差，报数）', () => {
  const frame = mountFrame({ boresightBody: [0, 0, 1] })
  const rows = []
  for (const alt of [500, 800, 1200]) {
    for (const lon of [0, 116.4, -77]) {
      const meta = { satLon: lon, satLat: 40, satAlt: alt }
      const ref = beamBasisFrom(meta, { boreType: 'azel', boreAz: 0, boreEl: 0, yaw: 0 })
      const S = geodeticToEcef(lon, 40, alt)
      const east = [-Math.sin(lon * D2R), Math.cos(lon * D2R), 0]
      const body = attitudeBasisEcef('nadir', null, { rEcef: S, vInertialEcef: east.map((x) => x * 7.5) })
      const mb = mountBasisEcef(body, frame)
      const d = ['x', 'y', 'z'].map((k) => ang(mb[k], ref[k]) * R2D)
      for (const x of d) assert.ok(x < 0.2, `alt ${alt} lon ${lon}：${d}`)
      if (lon === 0) rows.push(`${alt} km ${d.map((x) => x.toFixed(4)).join('/')}°`)
    }
  }
  console.log('  LEO 纬度 40°（x/y/z 夹角）：' + rows.join('；'))
})

// ───────────────────────── ⑥ 挂点系 / 视线 / 四元数 ─────────────────────────
t('mountFrame：z = 视轴、y = up 投影、x = y × z；up 缺省按 D1（−Y 投影，视轴 ∥ ±Y 时 +X）；dirBody 兼容；互逆', () => {
  // 互逆误差 = |(MᵀM − I)·d|，上界是挂点三轴的正交归一残差（checkOrtho 的 1e-14 同量级），不是 1 ulp：判据按 2e-14 取
  let worstRt = 0
  for (let k = 0; k < 500; k++) {
    const bore = rndUnit(), up = rnd() < 0.3 ? undefined : rndUnit()
    const f = mountFrame(k % 2 ? { boresightBody: bore, upBody: up } : { dirBody: bore, upBody: up })
    checkOrtho({ X: f.x, Y: f.y, Z: f.z }, 1e-14, 'mount')
    assert.ok(ang(f.z, bore) < 1e-15, 'z = 视轴')
    if (up) assert.ok(Math.abs(dot(cross(nrm(up), f.y), f.z)) < 1e-12 && dot(nrm(up), f.y) > 0, 'y 是 up 的投影方向')
    const d = rndUnit()
    const m = dirBodyToMount(d, f), back = dirMountToBody(m, f)
    worstRt = Math.max(worstRt, len(sub(back, d)))
  }
  assert.ok(worstRt < 2e-14, `互逆最差 ${worstRt}`)
  const fy = mountFrame({ boresightBody: [0, 1, 0] })
  assert.ok(len(sub(fy.y, [1, 0, 0])) < 1e-15, '视轴 +Y → up +X')
  const fz = mountFrame({ boresightBody: [0, 0, -1], upBody: [0, 0, 1] })   // up 与视轴平行 → 缺省
  assert.ok(len(sub(fz.y, [0, -1, 0])) < 1e-15, '退化 up → D1')
  const f0 = mountFrame(null)
  assert.ok(len(sub(f0.z, [0, 0, 1])) === 0, '空挂点 → +Z')
})

t('azElInMount：视轴 (0,0)、+x → az 90、+y → el 90；offAxis / phi', () => {
  const r = azElInMount([0, 0, 1]); near(r.az, 0, 0, 'az'); near(r.el, 0, 0, 'el'); near(r.offAxisDeg, 0, 0, 'off')
  const r2 = azElInMount([1, 0, 0]); near(r2.az, 90, 1e-12, 'az'); near(r2.offAxisDeg, 90, 1e-12, 'off')
  const r3 = azElInMount([0, 1, 0]); near(r3.el, 90, 1e-12, 'el'); near(r3.phiDeg, 90, 1e-12, 'phi')
  const d = nrm([0.1, 0.2, 0.9]), r4 = azElInMount(d)
  const back = [Math.cos(r4.el * D2R) * Math.sin(r4.az * D2R), Math.sin(r4.el * D2R), Math.cos(r4.el * D2R) * Math.cos(r4.az * D2R)]
  assert.ok(len(sub(back, d)) < 1e-15)
})

t('losToBody / bodyToEcef 互逆；basisToQuat ↔ quatToBasis；ecefToScene ↔ sceneToEcef', () => {
  const out = [0, 0, 0]
  for (let k = 0; k < 300; k++) {
    const ctx = randomCtx()
    const b = attitudeBasisEcef(ATT_LAWS[k % 5], {}, ctx)
    const l = rndUnit()
    const lb = losToBody(l, b, out)
    assert.equal(lb, out)
    assert.ok(len(sub(bodyToEcef(lb, b), l)) < 1e-15)
    const q = basisToQuat(b), b2 = quatToBasis(q)
    for (const kk of ['X', 'Y', 'Z']) assert.ok(len(sub(b2[kk], b[kk])) < 1e-14, kk)
    near(q[3] >= 0 ? 1 : 0, 1, 0, 'w ≥ 0')
    const s = ecefToScene(l), e = sceneToEcef(s)
    assert.ok(len(sub(e, l)) === 0)
    assert.deepEqual(s, [l[0], l[2], -l[1]])
  }
})

t('articulationSunAngle：转后与太阳夹角最小（对 3600 个试探角取最大）；轴 ∥ 太阳 / 指向 ∥ 轴 → 0；Rodrigues 右手', () => {
  for (let k = 0; k < 400; k++) {
    const p = rndUnit(), axis = rndUnit(), s = rndUnit()
    const th = articulationSunAngle(p, axis, s)
    const best = dot(rotateAboutAxis(p, axis, th), s)
    for (let a = -180; a < 180; a += 0.1) assert.ok(dot(rotateAboutAxis(p, axis, a), s) <= best + 1e-12, `k=${k} a=${a}`)
    const pa = dot(p, axis), pp = sub(p, axis.map((x) => x * pa))
    const closed = pa * dot(axis, s) + Math.hypot(dot(pp, s), dot(cross(axis, pp), s))
    near(best, closed, 1e-12, '闭式最大值')
  }
  assert.equal(articulationSunAngle([0, 1, 0], [0, 1, 0], [1, 0, 0]), 0)
  assert.equal(articulationSunAngle([0, 0, 1], [0, 1, 0], [0, 1, 0]), 0)
  // 太阳翼：转轴 +Y、电池法向 +Z，太阳在 +X → 绕 +Y 右手转 +90°（Z → X）
  near(articulationSunAngle([0, 0, 1], [0, 1, 0], [1, 0, 0]), 90, 1e-12, '+Y 轴 Z→X')
  assert.ok(len(sub(rotateAboutAxis([0, 0, 1], [0, 1, 0], 90), [1, 0, 0])) < 1e-15)
})

// ───────────────────────── 太阳 / 日地距离 ─────────────────────────
t('sunEcefApprox 与 terminator.solarGeometry（日下点）对拍 < 1e-12；sunDistanceAu 近 / 远日点', () => {
  let worst = 0
  for (let k = 0; k < 500; k++) {
    const ms = Math.round(Date.UTC(2020, 0, 1) + rnd() * 12 * 365.25 * 86400000)
    const s = sunEcefApprox(ms)
    const g = solarGeometry(new Date(ms)).sub
    const v = [Math.cos(g.lat * D2R) * Math.cos(g.lon * D2R), Math.cos(g.lat * D2R) * Math.sin(g.lon * D2R), Math.sin(g.lat * D2R)]
    worst = Math.max(worst, len(sub(s, v)))
  }
  assert.ok(worst < 1e-12, `最差 ${worst}`)
  const peri = sunDistanceAu(Date.UTC(2026, 0, 3, 17)), aph = sunDistanceAu(Date.UTC(2026, 6, 6, 18))
  near(peri, 0.98330, 3e-4, '2026 近日点'); near(aph, 1.01670, 3e-4, '2026 远日点')
  console.log(`  日地距离：2026-01-03 ${peri.toFixed(5)} AU，2026-07-06 ${aph.toFixed(5)} AU`)
})

t('一期 eclipseFactor 仍可用（二期只追加、不改一期函数）', () => {
  near(eclipseFactor([42164, 0, 0], [1, 0, 0]), 1, 0, '日照')
  near(eclipseFactor([-42164, 0, 0], [1, 0, 0]), 0, 0, '本影')
})

// ───────────────────────── ⑦ 热路径分配量 ─────────────────────────
// 采样堆分析（V8 HeapProfiler.startSampling，含 minor / major GC 收走的对象）量每次调用的平均分配字节数。
// 代码里已没有显式分配（对象 / 数组字面量、Date、Math.hypot 的暂存数组都去掉了）；剩下的是 V8 在未内联的调用边界、
// 或 megamorphic 取数点把 double 装箱成 HeapNumber（16 B / 个）。取数点只见过一两种数组时（单独跑的基准）五种律 0–80 B / 次；
// 本测试进程前面的用例拿各种形状的入参（数组 / {x,y,z} / 冻结常量）喂过取数器，这里量到的是「被撑开」时的量。
// 装不装箱取决于 JIT 反馈与内联、不是正确性：只报数，不设判据（设了要么永真、要么随 V8 版本抖）。
{
  const ctx = { rEcef: [7000.5, 100.25, 200.125], vInertialEcef: [0.1, 7.5, 0.2], sunEcef: [0.3, 0.8, 0.52], targetEcef: [6000.5, 500.5, 1000.5], gmstRad: 1.234, tMs: Date.UTC(2026, 8, 24) }
  const out = makeBasis(), o3 = [0, 0, 0], sink = new Float64Array(1)
  const PE = { eulerDeg: { yaw: 10, pitch: 5, roll: 2 } }, PN = { yawBiasDeg: 3 }
  const cases = [
    ['nadir', () => { for (let i = 0; i < N_ALLOC; i++) attitudeBasisEcef('nadir', PN, ctx, out) }],
    ['yawSteer', () => { for (let i = 0; i < N_ALLOC; i++) attitudeBasisEcef('yawSteer', null, ctx, out) }],
    ['sun', () => { for (let i = 0; i < N_ALLOC; i++) attitudeBasisEcef('sun', null, ctx, out) }],
    ['target', () => { for (let i = 0; i < N_ALLOC; i++) attitudeBasisEcef('target', null, ctx, out) }],
    ['inertial', () => { for (let i = 0; i < N_ALLOC; i++) attitudeBasisEcef('inertial', PE, ctx, out) }],
    ['sunEcefApprox', () => { for (let i = 0; i < N_ALLOC; i++) sunEcefApprox(ctx.tMs + i, o3, 1.2) }],
    ['sunDistanceAu', () => { for (let i = 0; i < N_ALLOC; i++) sink[0] = sunDistanceAu(ctx.tMs + i) }],
    ['gmstRadAt', () => { for (let i = 0; i < N_ALLOC; i++) sink[0] = gmstRadAt(ctx.tMs + i) }]
  ]
  const ss = new Session(); ss.connect()
  await ss.post('HeapProfiler.enable')
  const rows = []
  for (const [name, fn] of cases) {
    fn(); fn()                                                           // 预热到优化态
    await ss.post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
    fn()
    const { profile } = await ss.post('HeapProfiler.stopSampling')
    let bytes = 0
    const sites = new Map()
    const walk = (nd) => {
      if (/attitude[.]mjs|modelAttitudeLaws/.test(nd.callFrame.url || '')) {
        bytes += nd.selfSize || 0
        if (nd.selfSize) { const k = nd.callFrame.functionName + ':' + (nd.callFrame.lineNumber + 1); sites.set(k, (sites.get(k) || 0) + nd.selfSize) }
      }
      for (const c of nd.children || []) walk(c)
    }
    walk(profile.head)
    if (process.env.ALLOC_SITES) console.log('   ', name, [...sites].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => k + ' ' + (v / N_ALLOC).toFixed(1)).join('; '))
    const per = bytes / N_ALLOC
    rows.push(`${name} ${per.toFixed(1)}`)
  }
  await ss.post('HeapProfiler.disable'); ss.disconnect()
  console.log(`  每次调用平均分配（B，${N_ALLOC} 次、采样堆分析，报数不判）：` + rows.join('；'))
}

console.log(`modelAttitudeLaws: ${n} 项通过`)
