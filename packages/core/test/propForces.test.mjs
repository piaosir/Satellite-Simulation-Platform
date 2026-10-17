// 力模型分项：日月星历、第三体、光压地影、NRLMSISE-00、空间天气、阻力密度、固体潮
// （packages/core/utils/prop/ephemeris.js、forces/*.js）。
//
// 【外部真值】
//   星历：pyerfa 2.0.1.5（ERFA C 库）的 eraEpv00 / eraMoon98 输出逐数对拍（移植正确性）；Orekit 读 JPL DE440 的
//     日月位置（解析历表本身的精度，夹具 orekitFramesEphem）；帧偏差矩阵对 Orekit 的 GCRF→EME2000。
//   NRLMSISE-00：Brodowski C 版 DOCUMENTATION 第 7 节公布的 17 组测试输出（7 位有效数字）；同一 C 源码编译后在
//     66 组随机输入上的全精度输出（夹具 nrlmsise00-c.json，生成方法写在夹具 meta 里）。
//   空间天气 / 密度：Orekit 13.1.9 的 CssiSpaceWeatherData + NRLMSISE00（平太阳时、UTC）在 120 个时刻 / 位置上的
//     F10.7、F10.7A、Ap 数组与密度（夹具 orekitDensity，Orekit 读的是同一段 SW-All.csv 的 CSSI 转写）。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const EPH = require('../utils/prop/ephemeris.js')
const TB = require('../utils/prop/forces/thirdBody.js')
const SRP = require('../utils/prop/forces/srp.js')
const MSIS = require('../utils/prop/forces/nrlmsise00.js')
const SW = require('../utils/prop/forces/spaceWeather.js')
const DRAG = require('../utils/prop/forces/drag.js')
const TIDES = require('../utils/prop/forces/tides.js')
const G = require('../utils/prop/forces/gravity.js')
const ER = require('../utils/prop/earthRotation.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)
const FXDIR = new URL('./fixtures/prop/', import.meta.url)
const loadFx = (name) => JSON.parse(gunzipSync(readFileSync(new URL(name + '.json.gz', FXDIR))).toString('utf8'))
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const angle = (a, b) => { const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; return Math.atan2(Math.hypot(...c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) }
const AS = 206264.806247

/* ===== ① 星历：ERFA 移植逐数对拍 ===== */
section('ERFA 移植（对 pyerfa 2.0.1.5）')
// d = J2000 起的 TDB 日；earthHelio = eraEpv00 日心地球（BCRS，au）；moon = eraMoon98（GCRS，au）
const ERFA = [
  { d: -9000.0, earthHelio: [-0.6289803039195822, -0.7253170487583485, -0.3145149187406362], moon: [0.0010525181295553622, 0.002166893623739987, 0.0009184683417876003] },
  { d: -2197.9090000000006, earthHelio: [-0.06678316013272761, 0.90024339282911, 0.3903161145909128], moon: [0.001540416491785453, 0.001979882995230882, 0.0008964755152136752] },
  { d: 3003.6900000000005, earthHelio: [-0.9955652912536563, -0.0448805270139138, -0.01945236016712271], moon: [-0.0025170077638112178, -0.000716221102147939, -0.0005165182483119571] },
  { d: 9005.535, earthHelio: [0.9146347961822994, -0.39341204060090096, -0.17054737878956153], moon: [0.0002096778434760243, 0.0022495691085123136, 0.0012245856768082737] },
  { d: 14607.256999999998, earthHelio: [-0.12533878238823914, 0.8948940254846685, 0.38788833604186523], moon: [4.707960523987656e-05, 0.0024626642518663557, 0.0011450500936130113] }
]
for (const r of ERFA) {
  near(dist(EPH.earthHelioBcrsAu(r.d), r.earthHelio) * EPH.AU_KM * 1000, 0, 1e-3, 'eraEpv00 日心地球 d = ' + r.d.toFixed(1) + '（m）')
  near(dist(EPH.moonGcrsAu(r.d), r.moon) * EPH.AU_KM * 1000, 0, 1e-6, 'eraMoon98 月球 d = ' + r.d.toFixed(1) + '（m）')
}
// 帧偏差：Orekit GCRF→EME2000 对三个单位矢量的变换（= 矩阵的三列）
const ORE_BIAS_COLS = [
  [0.9999999999999942, 7.078279477857338e-08, -8.056217380986972e-08],
  [-7.078279744199198e-08, 0.9999999999999971, -3.3060408839805523e-08],
  [8.056217146976134e-08, 3.3060414542221364e-08, 0.9999999999999962]
]
let wb = 0
for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) wb = Math.max(wb, Math.abs(EPH.FRAME_BIAS[3 * i + j] - ORE_BIAS_COLS[j][i]))
ok(wb < 2e-12, '帧偏差矩阵 = Orekit GCRF→EME2000（IERS 2003；差 < 2e-12 rad，即 < 0.5 µas 的二阶项写法差）', String(wb))
{
  let w = 0
  for (let k = 0; k < 400; k++) {
    const t = Date.UTC(2000, 0, 1) + k * 9.1e8
    const tt = (T => T)(require('../utils/timeSystems.js').msInSystem(t, 'TT'))
    w = Math.max(w, Math.abs((EPH.tdbDaysFromUtcMs(t) - (tt - ER.J2000_MS) / 86400000) * 86400))
  }
  ok(w < 1.7e-3 && w > 1.5e-3, 'TDB − TT 的周年项幅度 ≈ 1.66 ms', String(w))
}

section('解析历表对 DE440（Orekit，2000–2100）')
{
  const fx = loadFx('orekitFramesEphem')
  const eph = EPH.analyticEphemeris({ cache: false })
  let sa = 0, sd = 0, ma = 0, md = 0, ssa = 0, smd = 0
  for (const row of fx.ephem) {
    const t = row[0], s = row.slice(1, 4), m = row.slice(4, 7)
    const s1 = eph.sun(t), m1 = eph.moon(t)
    sa = Math.max(sa, angle(s, s1)); sd = Math.max(sd, dist(s, s1)); ma = Math.max(ma, angle(m, m1)); md = Math.max(md, dist(m, m1))
    ssa += angle(s, s1) ** 2; smd += dist(m, m1) ** 2
  }
  const n = fx.ephem.length
  console.log('  ' + n + ' 个时刻：太阳方向最大 ' + (sa * AS).toFixed(4) + '″（RMS ' + (Math.sqrt(ssa / n) * AS).toFixed(4) + '″），位置最大 ' + sd.toFixed(2) + ' km；' +
    '月球方向最大 ' + (ma * AS).toFixed(2) + '″，位置最大 ' + md.toFixed(2) + ' km（RMS ' + Math.sqrt(smd / n).toFixed(2) + ' km）')
  ok(sa * AS < 0.03 && sd < 15, '太阳：≤ 0.03″、≤ 15 km（ERFA 注：日心最大 11.2 km）', (sa * AS) + '″ / ' + sd + ' km')
  ok(ma * AS < 15 && md < 25, '月球：≤ 15″、≤ 25 km（ERFA 注：对 ELP/MPP02 最大 18.3″ / 31.7 km）', (ma * AS) + '″ / ' + md + ' km')
  ok(Math.abs(fx.meta.gmSun / 1e9 - TB.GM_SUN) < 1e-3 && Math.abs(fx.meta.gmMoon / 1e9 - TB.GM_MOON) < 1e-9, '第三体 GM 与 DE440（Orekit getGM）一致')
}
{
  const a = EPH.analyticEphemeris(), b = EPH.analyticEphemeris({ cache: false })
  let ws = 0, wm = 0
  for (let k = 0; k < 1500; k++) {
    const t = Date.UTC(2026, 0, 1) + k * 6.789e6 + 13.5
    ws = Math.max(ws, dist(a.sun(t), b.sun(t))); wm = Math.max(wm, dist(a.moon(t), b.moon(t)))
  }
  console.log('  分段 Chebyshev 缓存的插值误差：太阳 ' + (ws * 1e5).toFixed(3) + ' cm，月球 ' + (wm * 1e6).toFixed(3) + ' mm')
  ok(ws < 3e-5 && wm < 3e-6, '缓存插值误差：太阳 < 3 cm，月球 < 3 mm')
  // DE 式 Chebyshev 提供者（DE440 子集的接口）：拿解析历表拟合一段，取值应一致
  const seg = (fn, t0, span) => ({ t0Days: t0, spanDays: span, coef: EPH.chebFit(fn, t0, t0 + span, 14) })
  const d0 = Math.floor(EPH.tdbDaysFromUtcMs(Date.UTC(2026, 9, 1)))
  const ch = EPH.chebyshevEphemeris({ sun: [seg(EPH.sunJ2000Km, d0, 8), seg(EPH.sunJ2000Km, d0 + 8, 8)], moon: [seg(EPH.moonJ2000Km, d0, 2), seg(EPH.moonJ2000Km, d0 + 2, 2)] })
  const t = Date.UTC(2026, 9, 3, 7, 30)
  ok(dist(ch.sun(t), b.sun(t)) < 3e-5 && dist(ch.moon(t), b.moon(t)) < 3e-6, 'chebyshevEphemeris（分段系数）取值正确')
  let threw = false
  try { ch.moon(Date.UTC(2026, 9, 20)) } catch (e) { threw = true }
  ok(threw, 'chebyshevEphemeris 越界报错')
}

/* ===== ② 第三体 ===== */
section('第三体')
{
  const rb = [1.4e8, 3e7, 1e7]
  ok(TB.pointMass([0, 0, 0], rb, TB.GM_SUN).every((x) => Math.abs(x) < 1e-20), '地心处摄动为零（直接项与间接项抵消）')
  const r = [42164, 0, 0], a = TB.pointMass(r, rb, TB.GM_SUN)
  const d = [rb[0] - r[0], rb[1] - r[1], rb[2] - r[2]], dn = Math.hypot(...d), bn = Math.hypot(...rb)
  ok([0, 1, 2].every((i) => Math.abs(a[i] - TB.GM_SUN * (d[i] / dn ** 3 - rb[i] / bn ** 3)) < 1e-20), 'a = GM(d/|d|³ − r_b/|r_b|³)')
  ok(Math.hypot(...a) > 3e-9 && Math.hypot(...a) < 4e-9, 'GEO 处太阳潮汐加速度量级 ~3.4e-9 km/s²', String(Math.hypot(...a)))
}

/* ===== ③ 光压与地影 ===== */
section('光压 / 锥形地影')
{
  const sun = [1.495978707e8, 0, 0]
  const eph = { sun: () => sun, moon: () => [384400, 0, 0] }
  const srp = SRP.createSrp({ cr: 1.3, areaToMass: 0.02, ephemeris: eph })
  // 1 AU 处、全照：|a| = Cr·(A/m)·P☉·(AU/d)² / 1000（km/s²）
  const r1 = [0, 42164, 0]
  const a1 = srp.acceleration(0, r1)
  const dd = dist(r1, sun)
  near(Math.hypot(...a1) / (1.3 * 0.02 * 4.56e-6 / 1000 * (149597870 / dd) ** 2), 1, 1e-12, '全照处 |a| = Cr·A/m·P☉·(AU/d)²')
  ok(a1[0] < 0, '光压方向背离太阳')
  ok(srp.lighting(0, [-7000, 0, 0]) === 0 && srp.lighting(0, [-42164, 0, 0]) === 0, '日地连线背面：本影 ν = 0')
  ok(srp.lighting(0, [0, 7000, 0]) === 1, '晨昏线上空：全照 ν = 1')
  // 横穿影界：ν 单调、连续
  let prev = 0, mono = true, maxJump = 0
  for (let k = 0; k <= 4000; k++) {
    const y = 6300 + k * 0.05
    const nu = SRP.conicalShadow([-7000, y, 0], sun)
    if (nu < prev - 1e-15) mono = false
    maxJump = Math.max(maxJump, nu - prev); prev = nu
  }
  ok(mono && prev === 1 && maxJump < 0.01, '横穿半影：ν 由 0 单调连续升到 1', 'maxJump ' + maxJump)
  // 开关函数与 ν 自洽：g_pen = c − (a + b) > 0 ⇔ 全照；g_umb = c − |b − a| < 0 ⇔ 本影（LEO 处 a < b）
  let consistent = true, nPen = 0
  for (let k = 0; k <= 4000; k++) {
    const p = [-7000, 6300 + k * 0.05, 0], g = SRP.shadowAngles(p, sun), nu = SRP.conicalShadow(p, sun)
    const gp = g.c - (g.a + g.b), gu = g.c - Math.abs(g.b - g.a)
    if ((gp > 0 && nu !== 1) || (gu < 0 && nu !== 0) || (gp < 0 && gu > 0 && !(nu > 0 && nu < 1))) consistent = false
    if (gp < 0 && gu > 0) nPen++
  }
  ok(consistent && nPen > 100, '开关函数的符号与光照因子 ν 一致（半影带内 0 < ν < 1）', 'nPen ' + nPen)
  ok(SRP.cylindricalShadow([-7000, 6000, 0], sun) === 0 && SRP.cylindricalShadow([-7000, 6400, 0], sun) === 1, '柱形影：|ρ| < R⊕ 为影')
  ok(srp.discontinuities.length === 2, '锥形模型给积分器两条开关函数（半影外沿、本影边界）')
}

/* ===== ④ NRLMSISE-00 ===== */
section('NRLMSISE-00：C 版 DOCUMENTATION 的 17 组测试输出')
const DOC = [
  '6.665177E+05 1.138806E+08 1.998211E+07 4.022764E+05 3.557465E+03 4.074714E-15 3.475312E+04 4.095913E+06 2.667273E+04 1.250540E+03 1.241416E+03',
  '3.407293E+06 1.586333E+08 1.391117E+07 3.262560E+05 1.559618E+03 5.001846E-15 4.854208E+04 4.380967E+06 6.956682E+03 1.166754E+03 1.161710E+03',
  '1.123767E+05 6.934130E+04 4.247105E+01 1.322750E-01 2.618848E-05 2.756772E-18 2.016750E+04 5.741256E+03 2.374394E+04 1.239892E+03 1.239891E+03',
  '5.411554E+07 1.918893E+11 6.115826E+12 1.225201E+12 6.023212E+10 3.584426E-10 1.059880E+07 2.615737E+05 2.819879E-42 1.027318E+03 2.068878E+02',
  '1.851122E+06 1.476555E+08 1.579356E+07 2.633795E+05 1.588781E+03 4.809630E-15 5.816167E+04 5.478984E+06 1.264446E+03 1.212396E+03 1.208135E+03',
  '8.673095E+05 1.278862E+08 1.822577E+07 2.922214E+05 2.402962E+03 4.355866E-15 3.686389E+04 3.897276E+06 2.667273E+04 1.220146E+03 1.212712E+03',
  '5.776251E+05 6.979139E+07 1.236814E+07 2.492868E+05 1.405739E+03 2.470651E-15 5.291986E+04 1.069814E+06 2.667273E+04 1.116385E+03 1.112999E+03',
  '3.740304E+05 4.782720E+07 5.240380E+06 1.759875E+05 5.501649E+02 1.571889E-15 8.896776E+04 1.979741E+06 9.121815E+03 1.031247E+03 1.024848E+03',
  '6.748339E+05 1.245315E+08 2.369010E+07 4.911583E+05 4.578781E+03 4.564420E-15 3.244595E+04 5.370833E+06 2.667273E+04 1.306052E+03 1.293374E+03',
  '5.528601E+05 1.198041E+08 3.495798E+07 9.339618E+05 1.096255E+04 4.974543E-15 2.686428E+04 4.889974E+06 2.805445E+04 1.361868E+03 1.347389E+03',
  '1.375488E+14 0.000000E+00 2.049687E+19 5.498695E+18 2.451733E+17 1.261066E-03 0.000000E+00 0.000000E+00 0.000000E+00 1.027318E+03 2.814648E+02',
  '4.427443E+13 0.000000E+00 6.597567E+18 1.769929E+18 7.891680E+16 4.059139E-04 0.000000E+00 0.000000E+00 0.000000E+00 1.027318E+03 2.274180E+02',
  '2.127829E+12 0.000000E+00 3.170791E+17 8.506280E+16 3.792741E+15 1.950822E-05 0.000000E+00 0.000000E+00 0.000000E+00 1.027318E+03 2.374389E+02',
  '1.412184E+11 0.000000E+00 2.104370E+16 5.645392E+15 2.517142E+14 1.294709E-06 0.000000E+00 0.000000E+00 0.000000E+00 1.027318E+03 2.795551E+02',
  '1.254884E+10 0.000000E+00 1.874533E+15 4.923051E+14 2.239685E+13 1.147668E-07 0.000000E+00 0.000000E+00 0.000000E+00 1.027318E+03 2.190732E+02',
  '5.196477E+05 1.274494E+08 4.850450E+07 1.720838E+06 2.354487E+04 5.881940E-15 2.500078E+04 6.279210E+06 2.667273E+04 1.426412E+03 1.408608E+03',
  '4.260860E+07 1.241342E+11 4.929562E+12 1.048407E+12 4.993465E+10 2.914304E-10 8.831229E+06 2.252516E+05 2.415246E-42 1.027318E+03 1.934071E+02'
]
{
  // nrlmsise-00_test.c 的输入
  const base = { doy: 172, sec: 29000, alt: 400, g_lat: 60, g_long: -70, lst: 16, f107A: 150, f107: 150, ap: 4 }
  const inp = DOC.map(() => Object.assign({}, base))
  inp[1].doy = 81; inp[2].sec = 75000; inp[2].alt = 1000; inp[3].alt = 100; inp[10].alt = 0; inp[11].alt = 10; inp[12].alt = 30
  inp[13].alt = 50; inp[14].alt = 70; inp[16].alt = 100; inp[4].g_lat = 0; inp[5].g_long = 0; inp[6].lst = 4; inp[7].f107A = 70
  inp[8].f107 = 180; inp[9].ap = 40
  const aph = [100, 100, 100, 100, 100, 100, 100]
  inp[15].ap_a = aph; inp[16].ap_a = aph
  let worst = 0
  DOC.forEach((line, i) => {
    const sw = MSIS.DEFAULT_SWITCHES.slice(); if (i >= 15) sw[9] = -1
    const o = MSIS.gtd7(inp[i], sw)
    const got = [...o.d, o.t[0], o.t[1]], ref = line.split(' ').map(Number)
    ref.forEach((r, j) => { if (Math.abs(r) > 1e-30) worst = Math.max(worst, Math.abs(got[j] - r) / Math.abs(r)) })
  })
  console.log('  17 组 × 11 个输出对公布值（7 位有效数字）的最大相对差 ' + worst.toExponential(2))
  ok(worst <= 5.0e-7, '17 组测试输出逐项一致（≤ 公布值的舍入 5e-7）', String(worst))
}
section('NRLMSISE-00：对编译后 C 版的全精度输出')
{
  const fx = JSON.parse(readFileSync(new URL('nrlmsise00-c.json', FXDIR), 'utf8'))
  let worst = 0, worstRho = 0
  for (const c of fx.cases) {
    const sw = MSIS.DEFAULT_SWITCHES.slice(); sw[9] = c.in.sw9
    const o = MSIS.gtd7d(c.in, sw)
    const got = [...o.d, o.t[0], o.t[1]], ref = [...c.d, ...c.t]
    ref.forEach((r, j) => {
      if (Math.abs(r) < 1e-30 && Math.abs(got[j]) < 1e-30) return
      const rel = Math.abs(got[j] - r) / Math.abs(r)
      worst = Math.max(worst, rel)
      if (j === 5) worstRho = Math.max(worstRho, rel)
    })
  }
  console.log('  ' + fx.cases.length + ' 组（0–1000 km，日 Ap / 3 小时 ap 两种开关）：全部输出最大相对差 ' + worst.toExponential(2) + '，总质量密度 ' + worstRho.toExponential(2))
  ok(worst < 1e-12, 'JS 移植与 C 版逐位级一致（相对 < 1e-12）', String(worst))
  // 32.5 km 正好是 2019-07-09 修的那个边界（C 版旧版在此出 NaN）
  const c325 = fx.cases.find((c) => c.in.alt === 32.5)
  ok(c325 && Number.isFinite(MSIS.gtd7d(c325.in).d[5]), '32.5 km 边界不出 NaN（2019-07-09 修正）')
}

/* ===== ⑤ 空间天气 ===== */
section('空间天气（SW-All.csv）')
const dn = loadFx('orekitDensity')
const swx = SW.createSpaceWeather(dn.swCsv)
{
  const parsed = SW.parseSwCsv(dn.swCsv)
  ok(parsed.records.length === 184 && parsed.records[0].ms === Date.UTC(2025, 2, 1), '2025-03-01…08-31 共 184 行')
  const r = parsed.records.find((x) => x.ms === Date.UTC(2025, 5, 1))
  ok(r && r.f107Obs === 150.3 && r.f107ObsCtr81 === 134.7 && r.apAvg === 98 && r.ap.join() === '48,67,179,154,154,48,111,22' && r.kp[2] === 7.7,
    '2025-06-01 行：F10.7_OBS 150.3、CTR81 134.7、Ap 98、3 小时 ap、Kp')
  // 口径：f107 = 前一日观测值、f107A = 当日 81 日中心平均、ap 数组
  const t = Date.UTC(2025, 5, 2, 7, 30)
  const x = swx.msisInputs(t)
  ok(x.f107 === 150.3 && x.f107A === 134.4 && x.ap === 69, 'f107 = 前一日（06-01）观测值，f107A / Ap = 当日（06-02）')
  ok(x.ap_a[1] === parsed.records.find((q) => q.ms === Date.UTC(2025, 5, 2)).ap[2], 'ap_a[1] = 当前 3 小时段（06:00–09:00）的 ap')
  // 对 Orekit CssiSpaceWeatherData：120 个时刻逐项相等
  let bad = 0
  for (const s of dn.samples) {
    const y = swx.msisInputs(s.tMs)
    if (y.f107 !== s.f107 || y.f107A !== s.f107A || y.ap_a.some((v, i) => Math.abs(v - s.ap[i]) > 1e-12)) bad++
  }
  ok(bad === 0, 'F10.7 / F10.7A / Ap 数组与 Orekit 的取值逐项相同（120 个时刻）', bad + ' 处不同')
  // PRM（逐月预报）行在 CSV 里没有 Ap：沿用最后一个逐日日 Ap，不出 NaN
  const head = dn.swCsv.split('\n')[0]
  const tail = dn.swCsv.trim().split('\n').slice(-3).join('\n')
  const csv = head + '\n' + tail + '\n2025-10-01,2620,1,,,,,,,,,,,,,,,,,,,,,90,140.0,141.0,PRM,135.0,136.0,137.0,138.0\n'
  const sw2 = SW.createSpaceWeather(csv)
  const z = sw2.msisInputs(Date.UTC(2025, 8, 15))
  ok(Number.isFinite(z.ap) && Number.isFinite(z.f107) && Number.isFinite(z.f107A), 'PRM 段的 Ap 有值（沿用逐日末行）')
  ok(SW.constantSpaceWeather({ f107: 120 }).msisInputs(0).f107A === 120, '常数空间天气：f107A 缺省同 f107')
}

/* ===== ⑥ 阻力密度对 Orekit ===== */
section('阻力：密度对 Orekit NRLMSISE00')
{
  const drag = DRAG.createDrag({ cd: 2.2, areaToMass: 0.01, spaceWeather: swx })
  let w = 0
  for (const s of dn.samples) w = Math.max(w, Math.abs(drag.density(s.tMs, s.r) - s.rho) / s.rho)
  console.log('  120 个时刻 / 位置（120–900 km、全纬度）：密度最大相对差 ' + w.toExponential(2))
  ok(w < 1e-8, '密度与 Orekit 一致（相对 < 1e-8；残差来自地固系的 2.6 mas 时差方程项）', String(w))
  // 加速度：−½ρ Cd A/m |v_rel| v_rel
  const r = dn.samples[0].r, v = [-1.2, 7.0, 2.0], t = dn.samples[0].tMs
  const a = drag.acceleration(t, r, v), rho = drag.density(t, r)
  const er = ER.createEarthRotation(), w3 = er.omegaJ2000(t).map((x) => x / ER.OMEGA_E * DRAG.OMEGA_EARTH)
  const vr = [v[0] - (w3[1] * r[2] - w3[2] * r[1]), v[1] - (w3[2] * r[0] - w3[0] * r[2]), v[2] - (w3[0] * r[1] - w3[1] * r[0])]
  const vn = Math.hypot(...vr)
  ok([0, 1, 2].every((i) => Math.abs(a[i] + 0.5 * rho * 2.2 * 0.01 * vn * vr[i] * 1000) < 1e-15 * Math.abs(a[i]) + 1e-30), 'a = −½ρ·Cd·A/m·|v_rel|·v_rel（v_rel 扣除大气共转）')
  ok(drag.breakpoints(Date.UTC(2025, 5, 1, 12), Date.UTC(2025, 5, 4)).length === 3, '跳变时刻 = 区间内的 UTC 日界（含终点）')
}
section('大地坐标换算')
{
  const { a: A, f } = DRAG.WGS84
  const e2 = f * (2 - f)
  const toEcef = (lat, lon, h) => { const N = A / Math.sqrt(1 - e2 * Math.sin(lat) ** 2); return [(N + h) * Math.cos(lat) * Math.cos(lon), (N + h) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h) * Math.sin(lat)] }
  let w = 0
  for (const lat of [-90, -89.999, -45, 0, 10, 60, 89.9999, 90]) {
    for (const h of [-1, 0, 400, 35786]) {
      const g = DRAG.ecefToGeodetic(toEcef(lat * Math.PI / 180, 1.234, h))
      w = Math.max(w, Math.abs(g.lat - lat * Math.PI / 180) * 6378e3, Math.abs(g.h - h) * 1e3)
    }
  }
  ok(w < 1e-6, 'WGS-84 大地坐标来回（含两极、GEO 高度）< 1 µm', String(w))
}

/* ===== ⑦ 固体潮 ===== */
section('固体潮（IERS 2010 第一步）')
{
  const er = ER.createEarthRotation(), eph = EPH.analyticEphemeris()
  const tf = TIDES.createSolidTides({ ephemeris: eph, earthRotation: er, centralTideSystem: 'tide-free' })
  const zt = TIDES.createSolidTides({ ephemeris: eph, earthRotation: er, centralTideSystem: 'zero-tide' })
  let s20f = 0, s20z = 0, n = 0, maxAbs = 0
  for (let k = 0; k < 24 * 365; k++) {
    const t = Date.UTC(2026, 0, 1) + k * 3600e3
    const a = tf.deltaCS(t).C[3]
    s20f += a; s20z += zt.deltaCS(t).C[3]; n++
    maxAbs = Math.max(maxAbs, Math.abs(a))
  }
  console.log('  一年平均 ΔC̄20：tide-free 场 ' + (s20f / n).toExponential(3) + '（永久潮汐 ' + G.DC20_PERM.toExponential(3) + '），zero-tide 场 ' + (s20z / n).toExponential(3) + '；|ΔC̄20| 最大 ' + maxAbs.toExponential(2))
  ok(Math.abs(s20f / n - G.DC20_PERM) < 0.1 * Math.abs(G.DC20_PERM), 'tide-free 场：ΔC̄20 的年均值 ≈ 永久潮汐项')
  ok(Math.abs(s20z / n) < 0.1 * Math.abs(G.DC20_PERM), 'zero-tide 场：扣掉永久项后年均值 ≈ 0')
  ok(maxAbs > 3e-9 && maxAbs < 2e-8, 'ΔC̄20 量级 1e-9 ~ 1e-8')
}

console.log('\npropForces: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
