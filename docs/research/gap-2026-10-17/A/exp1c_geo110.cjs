const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const DEG = Math.PI / 180, MU = 398600.4418, TWO_PI = 2 * Math.PI
const EPOCH = '2026-10-17T00:00:00.000Z', t0 = Date.parse(EPOCH)
const g0 = sat.gstime(new Date(t0)) / DEG
const aW = Math.cbrt(MU * (86164.0905 / TWO_PI) ** 2), nW = 86400 * Math.sqrt(MU / aW ** 3) / TWO_PI
function lonMean(rec, ms) { let s = 0, prev = null, acc = 0; for (let k = 0; k < 48; k++) { const d = new Date(ms + k * 1795e3); const L = sat.eciToGeodetic(sat.propagate(rec, d).position, sat.gstime(d)).longitude / DEG; if (prev != null) { let dl = L - prev; while (dl > 180) dl -= 360; while (dl < -180) dl += 360; acc += dl } else acc = L; prev = L; s += acc } return s / 48 }
for (const [tag, n] of [['向导 a=42164.17（n=' + nW.toFixed(8) + '）', nW], ['SGP4 零漂移 n=1.00273122', 1.00273122]]) {
  const rec = sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: n, ecc: 0, incl: 0, raan: 0, argp: 0, ma: ((110.5 + g0) % 360 + 360) % 360, bstar: 0, mdot: 0, mddot: 0 })
  const L0 = lonMean(rec, t0), L1 = lonMean(rec, t0 + 86400e3), L3 = lonMean(rec, t0 + 3 * 86400e3), L7 = lonMean(rec, t0 + 7 * 86400e3)
  const d0 = sat.eciToGeodetic(sat.propagate(rec, new Date(t0)).position, g0 * DEG).longitude / DEG
  console.log(tag + '：t0 瞬时星下点 ' + d0.toFixed(4) + '°E；日平均经度 0/1/3/7 d = ' + [L0, L1, L3, L7].map((x) => x.toFixed(4)).join(' / '))
}
