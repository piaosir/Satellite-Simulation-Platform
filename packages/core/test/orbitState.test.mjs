// src/shared/orbitState.js：密切根数 / 同步轨道参数 / 相对状态 / Kozai 平均运动。
//
// 【外部真值】Vallado《Fundamentals of Astrodynamics and Applications》Example 2-5（rv2coe）。
// 【解析真值】二体开普勒轨道按根数正算出 r / v（coe2rv），再反算回去；同步轨道参数用二体传播 + 匀速 GMST，
//   漂移率 / 偏心率矢量 / 倾角矢量都有闭式真值。【SGP4】真 GEO 根数：窗口平均值与 TLE 平根数同量级对得上。

import { oscElements, syncElements, relState, kozaiMeanMotion, stateVector, frameContext, j2000AxesInEcef, RAD_MIN_TO_REV_DAY, SIDEREAL_DAY_MS, MU } from '../../../src/shared/orbitState.js'
import sat from '../../../src/viz/constellation/satellite.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（' + a + ' vs ' + b + '，差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)
const DEG = Math.PI / 180
const angDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d) }

// 根数 → r / v（二体，惯性系），角度用度
function coe2rv(a, e, iDeg, OmDeg, wDeg, nuDeg, mu = MU) {
  const i = iDeg * DEG, Om = OmDeg * DEG, w = wDeg * DEG, nu = nuDeg * DEG
  const p = a * (1 - e * e), r = p / (1 + e * Math.cos(nu))
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu)
  const k = Math.sqrt(mu / p), vxp = -k * Math.sin(nu), vyp = k * (e + Math.cos(nu))
  const cO = Math.cos(Om), sO = Math.sin(Om), cw = Math.cos(w), sw = Math.sin(w), ci = Math.cos(i), si = Math.sin(i)
  const R = [[cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci], [sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci], [sw * si, cw * si]]
  return {
    r: { x: R[0][0] * xp + R[0][1] * yp, y: R[1][0] * xp + R[1][1] * yp, z: R[2][0] * xp + R[2][1] * yp },
    v: { x: R[0][0] * vxp + R[0][1] * vyp, y: R[1][0] * vxp + R[1][1] * vyp, z: R[2][0] * vxp + R[2][1] * vyp }
  }
}
// 平近点角 → 真近点角
function M2nu(Mdeg, e) {
  const M = Mdeg * DEG
  let E = M
  for (let k = 0; k < 50; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E))
  return Math.atan2(Math.sqrt(1 - e * e) * Math.sin(E), Math.cos(E) - e) / DEG
}

section('① Vallado Example 2-5')
{
  const el = oscElements({ x: 6524.834, y: 6862.875, z: 6448.296 }, { x: 4.901327, y: 5.533756, z: -1.976341 })
  near(el.p, 11067.790, 0.01, 'p')
  near(el.a, 36127.343, 0.01, 'a')
  near(el.e, 0.832853, 1e-6, 'e')
  near(el.i / DEG, 87.870, 1e-3, 'i')
  near(el.raan / DEG, 227.898, 1e-3, 'Ω')
  near(el.argp / DEG, 53.38, 0.005, 'ω')
  near(el.nu / DEG, 92.335, 1e-3, 'ν')
  near(angDiff(el.u / DEG, (el.argp + el.nu) / DEG), 0, 1e-9, 'u（纬度幅角）= ω + ν')
  near(angDiff(el.L / DEG, (el.raan + el.argp + el.nu) / DEG), 0, 1e-9, '真经度 L = Ω + ω + ν')
  near(angDiff(el.lonPeri / DEG, (el.raan + el.argp) / DEG), 0, 1e-9, 'ϖ = Ω + ω')
  near(Math.hypot(el.ex, el.ey), el.e, 1e-12, '|偏心率矢量| = e')
  near(Math.hypot(el.ix, el.iy), el.i, 1e-12, '|倾角矢量| = i')
  near(angDiff(Math.atan2(el.iy, el.ix) / DEG, el.raan / DEG), 0, 1e-9, '倾角矢量指向升交点（方位 = Ω）')
}

section('② 根数往返（二体正算再反算）')
{
  const cases = [
    [7000, 0.001, 51.6, 120, 90, 33], [26560, 0.74, 63.4, 300, 270, 180], [42164.17, 0.0002, 0.05, 80, 300, 45],
    [8000, 0.3, 98.6, 10, 200, 359], [42164.17, 0.0005, 55, 210, 10, 100], [12000, 0.05, 120, 45, 60, 270]
  ]
  let worst = 0
  for (const c of cases) {
    const { r, v } = coe2rv(...c)
    const el = oscElements(r, v)
    const d = [Math.abs(el.a - c[0]) / c[0], Math.abs(el.e - c[1]), angDiff(el.i / DEG, c[2]), angDiff(el.raan / DEG, c[3]), angDiff(el.argp / DEG, c[4]), angDiff(el.nu / DEG, c[5])]
    worst = Math.max(worst, ...d.slice(2).map((x, k) => (k === 3 || k === 2) && c[1] < 0.001 ? x * c[1] : x))
    ok(d[0] < 1e-12 && d[1] < 1e-12 && d[2] < 1e-9 && d[3] < 1e-8 && (c[1] < 0.001 || (d[4] < 1e-7 && d[5] < 1e-7)), `往返 ${c.join(' / ')}`, d.join(' '))
    const nuM = M2nu(el.M / DEG, el.e)
    ok(angDiff(nuM, el.nu / DEG) < 1e-8, `平近点角自洽（M → ν 回到 ${c[5]}°）`)
  }
}

section('③ 奇异处：赤道 / 圆轨道')
{
  const a = coe2rv(42164.17, 0, 0, 0, 0, 37)        // 圆 + 赤道：只有真经度有意义
  a.r.z = 0; a.v.z = 0
  const el = oscElements(a.r, a.v)
  ok(Number.isNaN(el.raan) && Number.isNaN(el.u), '赤道：Ω / u 不编数（NaN）')
  near(el.L / DEG, 37, 1e-9, '赤道圆轨道：真经度 = 37°')
  near(el.lamM / DEG, 37, 1e-9, '圆轨道：平经度 = 真经度')
  near(el.ix, 0, 1e-15, '赤道：倾角矢量为零')
  const b = coe2rv(7000, 0, 45, 30, 0, 50)
  const eb = oscElements(b.r, b.v)
  ok(eb.e < 1e-11 ? Number.isNaN(eb.argp) && Number.isNaN(eb.nu) : true, '圆轨道：ω / ν 不编数')
  near(eb.u / DEG, 50, 1e-8, '圆轨道：纬度幅角 = 50°')
}

section('④ 同步轨道参数（二体 + 匀速 GMST 的闭式真值）')
{
  // 二体 GEO 族：a = a_GEO + Δa，e = 2e-4、ϖ = 60°，i = 0.05°、Ω = 80°；GMST 按恒星日匀速
  const aGeo = Math.cbrt(MU * (SIDEREAL_DAY_MS / 1000 / (2 * Math.PI)) ** 2)
  const t0 = Date.UTC(2026, 9, 12), g0 = 1.234
  const wE = 2 * Math.PI / (SIDEREAL_DAY_MS / 1000)
  for (const dA of [0, 5, -12]) {
    const a = aGeo + dA, e = 2e-4, i = 0.05, Om = 80, w = 340, M0 = 25
    const n = Math.sqrt(MU / (a * a * a))
    const sample = (ms) => {
      const dt = (ms - t0) / 1000
      const Mdeg = M0 + n * dt / DEG
      const { r, v } = coe2rv(a, e, i, Om, w, M2nu(Mdeg, e))
      return { r, v, gmst: g0 + wE * dt }
    }
    const tMs = t0 + 3.3 * 864e5
    const s = syncElements(sample, tMs)
    const wantD = (n - wE) * 86400 / DEG
    near(s.drift, wantD, 1e-9, `Δa = ${dA} km：漂移率 = (n − ω⊕)·86400 = ${wantD.toFixed(6)}°/d`)
    const dt = (tMs - t0) / 1000
    const wantLam = (((Om + w + M0 + n * dt / DEG) - (g0 + wE * dt) / DEG) % 360 + 540) % 360 - 180
    near(angDiff(s.lonMean, wantLam), 0, 1e-8, `Δa = ${dA} km：平经度（t 处）`)
    near(s.ex, e * Math.cos((Om + w) * DEG), 1e-12, 'eₓ = e·cos ϖ')
    near(s.ey, e * Math.sin((Om + w) * DEG), 1e-12, 'e_y = e·sin ϖ')
    near(s.ix, i * Math.cos(Om * DEG), 1e-9, 'iₓ = i·cos Ω')
    near(s.iy, i * Math.sin(Om * DEG), 1e-9, 'i_y = i·sin Ω')
    ok(s.track.length === 72 && s.track.every((p) => Math.abs(p.lat) < 0.06), '星下点轨迹 72 点、纬度摆幅 ≤ i')
  }
  ok(syncElements(() => null, Date.UTC(2026, 0, 1)) === null, '窗口内取不到位置 → null（不编数）')
  const span = { t0: Date.UTC(2026, 0, 1), t1: Date.UTC(2026, 0, 1) + 0.5 * 864e5 }
  ok(syncElements(() => ({ r: { x: 42164, y: 0, z: 0 }, v: { x: 0, y: 3.07, z: 0 }, gmst: 0 }), span.t0, span) === null, '星历时段不足一个恒星日 → null')
}

section('⑤ 同步轨道参数（真 GEO 的 SGP4，对 TLE 平根数）')
{
  const l1 = '1 44067U 19012A   26280.50000000 -.00000300  00000-0  00000+0 0  9990'
  const l2 = '2 44067   0.0400  85.0000 0002000 300.0000  60.0000  1.00270000 20000'
  const rec = sat.twoline2satrec(l1, l2)
  const sample = (ms) => { const pv = sat.propagate(rec, new Date(ms)); const g = sat.gstime(new Date(ms)); return pv && pv.position ? { r: pv.position, v: pv.velocity, gmst: g } : null }
  const tMs = Date.UTC(2026, 9, 8)
  const s = syncElements(sample, tMs)
  ok(!!s, 'SDP4 GEO：取得到窗口平均')
  near(s.e, 2e-4, 3e-5, '平均偏心率 ≈ TLE 平偏心率（±3e-5：J₂ 3.7e-5 绕转分量已平均掉）')
  // SDP4 的日月周期项（半月 / 半年）让 GEO 倾角在历元附近偏离平根数 ~0.01°（实测历元处 0.032° vs 0.040°、14 天后 0.060°），
  // 窗口平均只平掉日周期项，长周期项本来就是该时刻的真实倾角 —— 故只要求同量级
  near(s.i, 0.04, 0.012, '平均倾角 ≈ TLE 倾角（±0.012°，日月长周期项）')
  const s2 = syncElements(sample, tMs + 1.5 * 864e5), sm = syncElements(sample, tMs + 0.75 * 864e5)
  near((s2.lonMean - s.lonMean) / 1.5, sm.drift, 1e-3, '漂移率与平经度的实际走向自洽（1.5 天差分 vs 中点斜率）')
  near(angDiff(Math.atan2(s.ey, s.ex) / DEG, 85 + 300), 0, 6, '偏心率矢量方位 ≈ Ω + ω（±6°，日月摄动）')
  ok(Math.abs(s.drift) < 0.05, `漂移率量级合理（${s.drift.toFixed(5)}°/d）`)
  // 平经度与「定点」同一参考：历元星下点经度（geoSlot 口径）与窗口平经度差 < 0.2°
  const pv0 = sat.sgp4(rec, 0), gd = sat.eciToGeodetic(pv0.position, sat.gstime(rec.jdsatepoch))
  ok(angDiff(s.lonMean, sat.degreesLong(gd.longitude)) < 0.5, `平经度与历元星下点经度同一参考（${s.lonMean.toFixed(3)} vs ${sat.degreesLong(gd.longitude).toFixed(3)}）`)
}

section('⑥ 相对状态（RIC）')
{
  const R = 7000, V = Math.sqrt(MU / R)
  const rp = { x: R, y: 0, z: 0 }, vp = { x: 0, y: V, z: 0 }
  const s = relState(rp, vp, { x: R + 1, y: 2, z: 3 }, { x: 0.001, y: V, z: 0 })
  near(s.R, 1, 1e-12, 'R = 径向分量'); near(s.I, 2, 1e-12, 'I = 沿迹分量'); near(s.C, 3, 1e-12, 'C = 法向分量')
  near(s.range, Math.sqrt(14), 1e-12, '距离 = |Δr|')
  const w = V / R
  near(s.dR, 0.001 + 2 * w, 1e-15, '转动系径向速度 = Δv_R + ω·ΔI')
  near(s.dI, -w * 1, 1e-15, '转动系沿迹速度 = Δv_I − ω·ΔR')
  near(s.dC, 0, 1e-15, '法向速度')
  near(s.rate, (1 * 0.001) / Math.sqrt(14), 1e-15, '距离变化率 = Δr·Δv / |Δr|（与帧无关）')
  // 同轨前后两颗（沿迹 100 km）：转动系里静止
  const th = 100 / R
  const s2 = relState(rp, vp, { x: R * Math.cos(th), y: R * Math.sin(th), z: 0 }, { x: -V * Math.sin(th), y: V * Math.cos(th), z: 0 })
  ok(s2.I > 99.9 && s2.I < 100 && s2.R < 0 && Math.abs(s2.dR) < 1e-12 && Math.abs(s2.dI) < 1e-12, '同轨前后：在前 I > 0，转动系相对速度为零')
  near(s2.theta, th, 1e-12, '地心张角')
}

section('⑦ Kozai 平均运动（反解 sgp4init）')
{
  for (const [l1, l2, n] of [
    ['1 25544U 98067A   26284.50000000  .00012000  00000-0  21000-3 0  9990', '2 25544  51.6400 120.0000 0003000  90.0000 270.0000 15.50000000400000', 15.5],
    ['1 44067U 19012A   26280.50000000 -.00000300  00000-0  00000+0 0  9990', '2 44067   0.0400  85.0000 0002000 300.0000  60.0000  1.00270000 20000', 1.0027],
    ['1 99999U 26001A   26100.00000000  .00000000  00000-0  00000+0 0  9990', '2 99999  63.4000 300.0000 7400000 270.0000 180.0000  2.00611000 10000', 2.00611]
  ]) {
    const rec = sat.twoline2satrec(l1, l2)
    const nk = kozaiMeanMotion(rec) * RAD_MIN_TO_REV_DAY
    near(nk, n, 1e-10, `n_Kozai 还原 TLE 原文（${n} 圈/日）`)
    ok(Math.abs(rec.no * RAD_MIN_TO_REV_DAY - n) > 1e-7 || n < 2, 'satrec.no 本身是 Brouwer 值（与原文不同，所以要反解）')
  }
  ok(kozaiMeanMotion(null) === null && kozaiMeanMotion({ no: 0 }) === null, '坏输入返回 null')
}

section('⑧ stateVector 的帧')
{
  const ms = Date.UTC(2026, 9, 12, 6), ctx = frameContext(ms, sat.gstime)
  const pv = { position: { x: 42164, y: 0, z: 0 }, velocity: { x: 0, y: 3.0747, z: 0 } }
  const f = stateVector(pv, 'FIXED', ctx), j = stateVector(pv, 'J2000', ctx), t = stateVector(pv, 'TEME', ctx)
  ok(f.frame === 'FIXED' && j.frame === 'J2000' && t.frame === 'TEME', '帧名归一')
  near(Math.hypot(f.r.x, f.r.y, f.r.z), 42164, 1e-9, '换帧保模（位置）')
  near(Math.hypot(j.v.x, j.v.y, j.v.z), 3.0747, 1e-12, '惯性帧之间换帧保模（速度）')
  near(Math.hypot(f.v.x, f.v.y, f.v.z), Math.abs(3.0747 - 7.2921158553e-5 * 42164), 1e-9, '地固速度 = 惯性速度 − ω⊕ × r（GEO 近乎静止）')
  ok(stateVector(null, 'J2000', ctx) === null && stateVector(pv, 'J2000', null) === null, '缺输入返回 null')
}

section('⑨ J2000 三轴在地固系里的方向（3D 参考系轴）')
{
  const ms = Date.UTC(2026, 9, 12, 6), ctx = frameContext(ms, sat.gstime)
  const [X, Y, Z] = j2000AxesInEcef(ctx)
  const d = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  const cr = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x })
  ok(Math.abs(d(X, X) - 1) < 1e-14 && Math.abs(d(Y, Y) - 1) < 1e-14 && Math.abs(d(Z, Z) - 1) < 1e-14 && Math.abs(d(X, Y)) < 1e-14 && Math.abs(d(Y, Z)) < 1e-14, '单位正交')
  const c = cr(X, Y)
  ok(Math.abs(c.x - Z.x) < 1e-14 && Math.abs(c.y - Z.y) < 1e-14 && Math.abs(c.z - Z.z) < 1e-14, '右手系（X × Y = Z）')
  const zTilt = Math.acos(Math.min(1, Z.z)) / DEG
  ok(zTilt > 0.1 && zTilt < 0.2, `J2000 极轴偏离地固 Z 轴 = 26 年岁差 + 章动（${zTilt.toFixed(4)}°）`)
  const hourAngle = (((Math.atan2(-X.y, X.x) / DEG) % 360) + 360) % 360, gmstDeg = ((ctx.gmst / DEG) % 360 + 360) % 360
  ok(angDiff(hourAngle, gmstDeg) < 0.5, `春分点方向的时角 ≈ GMST（${hourAngle.toFixed(3)}° vs ${gmstDeg.toFixed(3)}°，差的是岁差）`)
  // 与 stateVector 同一条链：任一 J2000 矢量 = 三轴的线性组合
  const pv = { position: { x: 1234.5, y: -6789.1, z: 2345.6 }, velocity: { x: 1, y: 2, z: 3 } }
  const j = stateVector(pv, 'J2000', ctx).r, f = stateVector(pv, 'FIXED', ctx).r
  const g = { x: j.x * X.x + j.y * Y.x + j.z * Z.x, y: j.x * X.y + j.y * Y.y + j.z * Z.y, z: j.x * X.z + j.y * Y.z + j.z * Z.z }
  ok(Math.abs(g.x - f.x) < 1e-8 && Math.abs(g.y - f.y) < 1e-8 && Math.abs(g.z - f.z) < 1e-8, '轴与星位同一条链：J2000 分量 × 三轴 = 地固位置')
}

console.log(`\norbitState：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
