// 惯性系 / 地固系换算的回归网（packages/core/utils/frames.js）。
//
// 【外部真值，不许只做自洽】Vallado《Fundamentals of Astrodynamics and Applications》4th ed.
// Example 3-15 / AIAA 2006-6753《Revisiting Spacetrack Report #3》附录同一算例：
//   2004-04-06 07:51:28.386009 UTC
//   r_ITRF = (-1033.4793830, 7901.2952754, 6380.3565958) km
//   r_GCRF = ( 5102.508958 , 6123.011401 , 6378.136928 ) km
//   r_TEME = ( 5094.18016  , 6127.64465  , 6380.34453  ) km
// 容差：J2000->TEME 50 m（原文含 dPsi/dEps 的 EOP 修正，本平台不含）；
//       TEME->ITRF 1 km（原文含 dUT1 = -0.4399619 s 与极移，本平台一并忽略，见 frames.js 头注）。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const F = require('../utils/frames.js')
const T = require('../utils/timeSystems.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)
const dist = (v, r) => Math.hypot(v.x - r[0], v.y - r[1], v.z - r[2])

const UTC = Date.UTC(2004, 3, 6, 7, 51, 28, 386) + 0.009
const tc = T.julianCenturiesTT(UTC)
const nu = F.nutationAngles(tc)
const gmst = sat.gstime(T.jdFromMs(UTC))

const GCRF = { x: 5102.508958, y: 6123.011401, z: 6378.136928 }
const MOD = [5094.0283745, 6127.8708164, 6380.2485164]
const TOD = [5094.5162030, 6127.3652784, 6380.3445327]
const TEME = [5094.18016, 6127.64465, 6380.34453]
const ITRF = [-1033.4793830, 7901.2952754, 6380.3565958]

/* ===== ① 章动表本身 ===== */
section('IAU-80 章动表')
ok(F.NUT80.length === 106, '章动表 106 项', String(F.NUT80.length))
ok(F.NUT80.every((r) => r.length === 9), '每项 5 乘子 + 4 系数')
ok(F.NUT80[0][5] === -171996 && F.NUT80[0][7] === 92025, '首项（Omega）系数')
// 该算例下 dPsi / dEps / 平黄赤交角的公布值
near(nu.dpsi * 180 / Math.PI, -0.0034108, 5e-7, 'dPsi = -0.0034108 deg')
near(nu.deps * 180 / Math.PI, 0.0020316, 5e-7, 'dEps = 0.0020316 deg')
near(nu.epsBar * 180 / Math.PI, 23.4387368, 5e-7, '平黄赤交角 23.4387368 deg')
near(F.meanObliquity(0) * 180 / Math.PI, 23.439291111, 1e-8, 'J2000 平黄赤交角')

/* ===== ② 逐段对外部真值 ===== */
section('Vallado Example 3-15')
const mod = F.j2000ToMod(GCRF, tc)
near(dist(mod, MOD) * 1000, 0, 50, 'J2000 -> MOD（m）')
const tod = F.modToTod(mod, tc, nu)
near(dist(tod, TOD) * 1000, 0, 50, 'MOD -> TOD（m）')
const teme = F.todToTeme(tod, tc, nu)
near(dist(teme, TEME) * 1000, 0, 50, 'TOD -> TEME（m）')
near(dist(F.toTeme(GCRF, 'J2000', tc, gmst, nu), TEME) * 1000, 0, 50, 'toTeme 一步到位（m）')
const ecef = F.temeToEcef(teme, gmst)
near(dist(ecef, ITRF) * 1000, 0, 1000, 'TEME -> ECEF（m，忽略 dUT1 与极移）')
near(dist(F.fromTeme(F.toTeme(GCRF, 'J2000', tc, gmst, nu), 'FIXED', tc, gmst, nu), ITRF) * 1000, 0, 1000,
  'J2000 -> FIXED 一条链（m）')

/* ===== ③ 与 satellite.js 逐位一致 ===== */
section('与 satellite.js 同口径')
const a = sat.eciToEcf(teme, gmst), b = F.temeToEcef(teme, gmst)
ok(a.x === b.x && a.y === b.y && a.z === b.z, 'temeToEcef 与 eciToEcf 逐位相同')
for (const g of [0, 1, 2.5, 6.2]) {
  const v = { x: 1234.5, y: -6789.01, z: 42.42 }
  const p = sat.eciToEcf(v, g), q = F.temeToEcef(v, g)
  ok(p.x === q.x && p.y === q.y && p.z === q.z, 'gmst=' + g + ' 逐位相同')
}
ok(F.ecefToTeme(F.temeToEcef(GCRF, gmst), gmst).x - GCRF.x < 1e-12, 'ECEF 来回')

/* ===== ④ 自洽回环 <= 1 mm ===== */
section('回环')
const VECS = [GCRF, { x: 42164.0, y: 0, z: 0 }, { x: -1234.5, y: 6789.0, z: -3456.7 }, { x: 0, y: 0, z: 7000 }]
for (const v of VECS) {
  for (const f of ['J2000', 'MOD', 'TOD', 'TEME', 'FIXED']) {
    const back = F.fromTeme(F.toTeme(v, f, tc, gmst, nu), f, tc, gmst, nu)
    near(Math.hypot(back.x - v.x, back.y - v.y, back.z - v.z) * 1e6, 0, 1, f + ' 回环 <= 1 mm')
  }
}
// 整条链逐段回环
const chain = F.modToJ2000(F.todToMod(F.temeToTod(F.ecefToTeme(F.temeToEcef(
  F.todToTeme(F.modToTod(F.j2000ToMod(GCRF, tc), tc, nu), tc, nu), gmst), gmst), tc, nu), tc, nu), tc)
near(Math.hypot(chain.x - GCRF.x, chain.y - GCRF.y, chain.z - GCRF.z) * 1e6, 0, 1, '整条链回环 <= 1 mm')

/* ===== ⑤ 速度：地固系的自转牵连项 ===== */
section('速度换算')
// 与地球固连的一点：TEME 速度应当正好是 omega x r
const rEcef = { x: 6378.137, y: 0, z: 0 }
const vTeme = F.velToTeme({ x: 0, y: 0, z: 0 }, rEcef, 'FIXED', tc, gmst, nu)
near(Math.hypot(vTeme.x, vTeme.y, vTeme.z), F.OMEGA_E * 6378.137, 1e-9, '地固静止点在 TEME 里的速度 = omega·r')
const rTeme = F.ecefToTeme(rEcef, gmst)
const vBack = F.velFromTeme(vTeme, rTeme, 'FIXED', tc, gmst, nu)
near(Math.hypot(vBack.x, vBack.y, vBack.z), 0, 1e-9, '换回地固系速度归零')
for (const f of ['J2000', 'TOD', 'MOD', 'TEME']) {
  const v0 = { x: 1.2, y: -7.3, z: 0.5 }
  const back = F.velFromTeme(F.velToTeme(v0, GCRF, f, tc, gmst, nu), GCRF, f, tc, gmst, nu)
  near(Math.hypot(back.x - v0.x, back.y - v0.y, back.z - v0.z), 0, 1e-12, f + ' 速度回环')
}

/* ===== ⑥ 帧名归一 ===== */
section('帧名归一')
const EXPECT = {
  J2000: 'J2000', EME2000: 'J2000', ICRF: 'J2000', GCRF: 'J2000', Inertial: 'J2000',
  TEME: 'TEME', TEMEOfDate: 'TEME', TrueOfDate: 'TOD', MeanOfDate: 'MOD',
  Fixed: 'FIXED', ITRF2020: 'FIXED', ITRF93: 'FIXED', IGS20: 'FIXED', ECEF: 'FIXED', EFG: 'FIXED'
}
for (const k in EXPECT) ok(F.normFrame(k) === EXPECT[k], 'normFrame ' + k + ' -> ' + EXPECT[k], F.normFrame(k))
ok(F.normFrame('Mars2000') === '', '未知帧名返回空串')
ok(F.normFrame(null) === '', 'null 返回空串')

console.log('\nframes: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
