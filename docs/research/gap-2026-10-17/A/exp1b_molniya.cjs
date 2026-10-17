const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const RE = 6378.137, MU = 398600.4418, TWO_PI = 2*Math.PI, DEG = Math.PI/180
const EPOCH = '2026-10-17T00:00:00.000Z', t0 = Date.parse(EPOCH)
function mk(a, e, i, raan, argp, ma) {
  const n = Math.sqrt(MU/a**3)
  return sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: 86400*n/TWO_PI, ecc: e, incl: i, raan, argp, ma, bstar: 0, mdot: 0, mddot: 0 })
}
// Molniya：a=26561.76 e=0.741 i=63.4349 ω=270，M0=180（远地点）
const rec = mk(26561.76, 0.741, 63.4349, 0, 270, 180)
// 找每次远地点（|r| 极大）的星下点经度
const r = (ms) => { const pv = sat.propagate(rec, new Date(ms)); return Math.hypot(pv.position.x, pv.position.y, pv.position.z) }
const lon = (ms) => { const d = new Date(ms); return sat.eciToGeodetic(sat.propagate(rec, d).position, sat.gstime(d)).longitude / DEG }
function apoNear(ms) { let lo = ms - 3600e3, hi = ms + 3600e3; for (let k=0;k<80;k++){ const m1 = lo+(hi-lo)/3, m2 = hi-(hi-lo)/3; if (r(m1) < r(m2)) lo = m1; else hi = m2 } return (lo+hi)/2 }
const P = TWO_PI / rec.no * 60e3
let tA = apoNear(t0), L0 = lon(tA), out = []
for (let k = 1; k <= 60; k++) { tA = apoNear(tA + P); if (k % 2 === 0 && [2, 20, 60].includes(k)) { let d = lon(tA) - L0; while (d > 180) d -= 360; while (d < -180) d += 360; out.push([k/2, d]) } }
// 再看 argp 是否冻结：30 天后 ω
console.log('Molniya（向导口径 a=26561.76）SGP4 下远地点经度漂移：', out.map(([d, v]) => d + ' 天 ' + v.toFixed(2) + '°').join('，'))
// Tundra 型：a=42164.17 e=0.25 i=63.4349 ω=270
const recT = mk(42164.17, 0.25, 63.4349, 0, 270, 180)
const rT = (ms) => { const pv = sat.propagate(recT, new Date(ms)); return Math.hypot(pv.position.x, pv.position.y, pv.position.z) }
const lonT = (ms) => { const d = new Date(ms); return sat.eciToGeodetic(sat.propagate(recT, d).position, sat.gstime(d)).longitude / DEG }
function apoT(ms) { let lo = ms - 3*3600e3, hi = ms + 3*3600e3; for (let k=0;k<80;k++){ const m1 = lo+(hi-lo)/3, m2 = hi-(hi-lo)/3; if (rT(m1) < rT(m2)) lo = m1; else hi = m2 } return (lo+hi)/2 }
const PT = TWO_PI / recT.no * 60e3
let tT = apoT(t0); const LT0 = lonT(tT); const o2 = []
for (let k = 1; k <= 30; k++) { tT = apoT(tT + PT); if ([1, 10, 30].includes(k)) { let d = lonT(tT) - LT0; while (d > 180) d -= 360; while (d < -180) d += 360; o2.push([k, d]) } }
console.log('Tundra（a=42164.17,e=0.25,i=63.43）SGP4 下远地点经度漂移：', o2.map(([d, v]) => d + ' 天 ' + v.toFixed(2) + '°').join('，'))
