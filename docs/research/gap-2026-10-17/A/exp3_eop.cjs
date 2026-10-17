const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const F = require(path.join(ROOT, 'packages/core/utils/frames.js'))
const T = require(path.join(ROOT, 'packages/core/utils/timeSystems.js'))
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
// Vallado Ex 3-15
const UTC = Date.UTC(2004, 3, 6, 7, 51, 28, 386) + 0.009
const tc = T.julianCenturiesTT(UTC), nu = F.nutationAngles(tc), gmst = sat.gstime(T.jdFromMs(UTC))
const GCRF = { x: 5102.508958, y: 6123.011401, z: 6378.136928 }
const ITRF = [-1033.4793830, 7901.2952754, 6380.3565958]
const TEME = [5094.18016, 6127.64465, 6380.34453]
const e = F.fromTeme(F.toTeme(GCRF, 'J2000', tc, gmst, nu), 'FIXED', tc, gmst, nu)
const t = F.toTeme(GCRF, 'J2000', tc, gmst, nu)
console.log('Vallado 3-15：平台 J2000→TEME 误差 ' + (Math.hypot(t.x-TEME[0], t.y-TEME[1], t.z-TEME[2])*1000).toFixed(1) + ' m；J2000→ITRF 误差 ' + (Math.hypot(e.x-ITRF[0], e.y-ITRF[1], e.z-ITRF[2])*1000).toFixed(1) + ' m（原文 dUT1=-0.4399619 s, xp=-0.140682", yp=0.333309"）')
// 补上 dUT1 后（只改 GMST 用 UT1）的误差 → 剩余即极移 + 其它
const gmstUT1 = sat.gstime(T.jdFromMs(UTC - 439.9619))
const e2 = F.fromTeme(F.toTeme(GCRF, 'J2000', tc, gmstUT1, nu), 'FIXED', tc, gmstUT1, nu)
console.log('   GMST 改用 UT1 后：' + (Math.hypot(e2.x-ITRF[0], e2.y-ITRF[1], e2.z-ITRF[2])*1000).toFixed(1) + ' m（剩余≈极移 + 章动截断/EOP 改正）')
// 极移再补：W = R1(yp)·R2(xp)（frame rotation，小角）：PEF -> ITRF：r_ITRF = R1(-yp)R2(-xp) r_PEF ? 用 Vallado：r_PEF = W r_ITRF, W = rot1(-yp)*rot2(-xp)，故 r_ITRF = rot2(xp) rot1(yp) r_PEF
const AS = Math.PI/180/3600
const xp = -0.140682*AS, yp = 0.333309*AS
const e3 = F.rot2(F.rot1(e2, yp), xp)
console.log('   再补极移后：' + (Math.hypot(e3.x-ITRF[0], e3.y-ITRF[1], e3.z-ITRF[2])*1000).toFixed(1) + ' m')
// 当前 / 半年后 / 上限 的量级
const W = 7.2921158553e-5
for (const [tag, d] of [['2026-10-17 UT1-UTC=-0.0377 s', -0.0377], ['2027-02 预报 -0.148 s', -0.148], ['闰秒制度上限 0.9 s', 0.9]]) {
  console.log(tag + '：GEO 赤道弧长 ' + (Math.abs(d)*W*42164.17).toFixed(3) + ' km；LEO(550 km) ' + (Math.abs(d)*W*6928).toFixed(3) + ' km；地面站看 GEO 指向 ' + (Math.abs(d)*W*42164.17/37000*180/Math.PI*3600).toFixed(1) + '″')
}
console.log('极移 0.35″：GEO 处 ' + (0.35*AS*42164.17*1000).toFixed(0) + ' m；地表 ' + (0.35*AS*6378*1000).toFixed(1) + ' m')
// 闰秒表过期 1 s：时标为 GPS/TAI/TT 的外部星历时间错 1 s
console.log('闰秒表少 1 s：LEO 沿迹 ' + (7.6).toFixed(1) + ' km；GNSS MEO ' + (3.9).toFixed(1) + ' km；GEO ' + (3.07).toFixed(2) + ' km（惯性速度）')
