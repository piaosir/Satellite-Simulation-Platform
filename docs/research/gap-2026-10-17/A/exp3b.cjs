const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const F = require(path.join(ROOT, 'packages/core/utils/frames.js'))
const T = require(path.join(ROOT, 'packages/core/utils/timeSystems.js'))
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const UTC = Date.UTC(2004, 3, 6, 7, 51, 28, 386) + 0.009
const tc = T.julianCenturiesTT(UTC), nu = F.nutationAngles(tc)
const GCRF = { x: 5102.508958, y: 6123.011401, z: 6378.136928 }
const ITRF = [-1033.4793830, 7901.2952754, 6380.3565958]
const AS = Math.PI/180/3600, xp = -0.140682*AS, yp = 0.333309*AS
const g = sat.gstime(T.jdFromMs(UTC - 439.9619))
const pef = F.fromTeme(F.toTeme(GCRF, 'J2000', tc, g, nu), 'FIXED', tc, g, nu)
const err = (v) => (Math.hypot(v.x-ITRF[0], v.y-ITRF[1], v.z-ITRF[2])*1000).toFixed(2)
for (const [sx, sy] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
  console.log('rot2(rot1(pef,', sy, 'yp),', sx, 'xp) ->', err(F.rot2(F.rot1(pef, sy*yp), sx*xp)), ' | rot1(rot2) ->', err(F.rot1(F.rot2(pef, sx*xp), sy*yp)))
}
