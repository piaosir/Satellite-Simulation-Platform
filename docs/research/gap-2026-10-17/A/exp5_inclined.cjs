// 倾斜 GEO / 保持盒对固定指向地面站的影响：日内视线偏离（相对日平均指向）、斜距/时延/多普勒变化、指向损耗 12(θ/θ3dB)²
const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const DEG = Math.PI / 180, TWO_PI = 2 * Math.PI
const EPOCH = '2026-10-17T00:00:00.000Z', t0 = Date.parse(EPOCH)
const st = { longitude: 116.40 * DEG, latitude: 39.90 * DEG, height: 0.05 }
const A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F)
const s0 = Math.sin(st.latitude), c0 = Math.cos(st.latitude), N = A / Math.sqrt(1 - E2 * s0 * s0)
const O = [(N + st.height) * c0 * Math.cos(st.longitude), (N + st.height) * c0 * Math.sin(st.longitude), (N * (1 - E2) + st.height) * s0]
const nZero = 1.00273122   // 实验 1 求得的 SGP4 零漂移 Kozai n
function mk(incl, ecc, lon) {
  // 让 t0 时星下点在 lon：RAAN + argp + MA ≈ lon + GMST
  const g = sat.gstime(new Date(t0)) / DEG
  return sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: nZero, ecc, incl, raan: 0, argp: 0, ma: ((lon + g) % 360 + 360) % 360, bstar: 0, mdot: 0, mddot: 0 })
}
const fmt = (x, d = 3) => x.toFixed(d)
const ants = [['1.2 m Ku 12.5 GHz', 70 * 0.0299792458 / 1.25 / 1.2], ['2.4 m Ku 12.5 GHz', 70 * 0.0299792458 / 1.25 / 2.4], ['4.5 m C 4 GHz', 70 * 0.299792458 / 4 / 4.5], ['9 m Ka 20 GHz', 70 * 0.299792458 / 20 / 9], ['13 m Ku 14 GHz', 70 * 0.299792458 / 14 / 13]]
for (const [incl, ecc] of [[0.05, 0.0003], [1, 0.0003], [3, 0.0003], [5, 0.0003]]) {
  const rec = mk(incl, ecc, 110.5)
  const dirs = [], rng = [], rr = []
  for (let k = 0; k <= 288; k++) {
    const d = new Date(t0 + k * 300e3)
    const pv = sat.propagate(rec, d), g = sat.gstime(d)
    const e = sat.eciToEcf(pv.position, g)
    const v = [e.x - O[0], e.y - O[1], e.z - O[2]], r = Math.hypot(...v)
    dirs.push(v.map((x) => x / r)); rng.push(r)
  }
  const m = [0, 0, 0]; dirs.forEach((u) => { m[0] += u[0]; m[1] += u[1]; m[2] += u[2] })
  const mn = Math.hypot(...m); const mu = m.map((x) => x / mn)
  let maxOff = 0; dirs.forEach((u) => { const c = u[0] * mu[0] + u[1] * mu[1] + u[2] * mu[2]; maxOff = Math.max(maxOff, Math.acos(Math.min(1, c)) / DEG) })
  const rMin = Math.min(...rng), rMax = Math.max(...rng)
  const dr = (rMax - rMin), dDelay = dr / 299792.458 * 1000
  // 多普勒：距离变化率最大值 × f/c（12 GHz）
  let rdMax = 0; for (let k = 1; k < rng.length; k++) rdMax = Math.max(rdMax, Math.abs(rng[k] - rng[k - 1]) / 300)
  const loss = ants.map(([nm, bw]) => nm + ' θ3dB=' + fmt(bw) + '° 损耗 ' + (maxOff < bw ? fmt(12 * (maxOff / bw) ** 2, 1) + ' dB' : '>12 dB(出主瓣)')).join('；')
  console.log('i=' + incl + '°：视线最大偏离 ' + fmt(maxOff) + '°，斜距日变 ' + fmt(dr, 1) + ' km（时延 ' + fmt(dDelay, 2) + ' ms），最大距离变化率 ' + fmt(rdMax * 1000, 1) + ' m/s（Ku 12 GHz 多普勒 ' + fmt(rdMax * 12e9 / 299792.458, 0) + ' Hz）')
  console.log('   ' + loss)
}
