// 无控 GEO 的自然演化（SDP4：含日月长周期 + 24h 共振；不含光压）——倾角矢量年漂移、经度漂移加速度
const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = require(path.join(ROOT, 'packages/core/vendor/satellite.js'))
const DEG = Math.PI / 180
const EPOCH = '2026-10-17T00:00:00.000Z', t0 = Date.parse(EPOCH)
const g0 = sat.gstime(new Date(t0)) / DEG
function mk(lon) { return sat.omm2satrec({ noradId: 'SIM', epoch: EPOCH, meanMotion: 1.00273122, ecc: 0.0001, incl: 0.0001, raan: 0, argp: 0, ma: ((lon + g0) % 360 + 360) % 360, bstar: 0, mdot: 0, mddot: 0 }) }
function iVecAt(rec, ms) {
  // 一个恒星日平均的倾角矢量（TEME）
  let sx = 0, sy = 0
  for (let k = 0; k < 48; k++) {
    const d = new Date(ms + k * 1795e3)
    const pv = sat.propagate(rec, d), r = pv.position, v = pv.velocity
    const h = [r.y * v.z - r.z * v.y, r.z * v.x - r.x * v.z, r.x * v.y - r.y * v.x], hn = Math.hypot(...h)
    const hu = h.map((x) => x / hn), sinI = Math.hypot(hu[0], hu[1]), i = Math.atan2(sinI, hu[2])
    const fac = sinI > 1e-15 ? i / sinI : 1
    sx += -hu[1] * fac; sy += hu[0] * fac
  }
  return [sx / 48 / DEG, sy / 48 / DEG]
}
function lonMeanAt(rec, ms) {
  let s = 0, prev = null, acc = 0
  for (let k = 0; k < 48; k++) {
    const d = new Date(ms + k * 1795e3); const pv = sat.propagate(rec, d)
    let L = sat.eciToGeodetic(pv.position, sat.gstime(d)).longitude / DEG
    if (prev != null) { let dl = L - prev; while (dl > 180) dl -= 360; while (dl < -180) dl += 360; acc += dl } else acc = L
    prev = L; s += acc
  }
  return s / 48
}
for (const lon of [110.5, 75.1, 165.0]) {
  const rec = mk(lon)
  const i0 = iVecAt(rec, t0), i1 = iVecAt(rec, t0 + 365.25 * 86400e3)
  const di = Math.hypot(i1[0] - i0[0], i1[1] - i0[1])
  const L = [0, 30, 60, 90].map((d) => lonMeanAt(rec, t0 + d * 86400e3))
  // 二次拟合 λ(t) = λ0 + λ̇0 t + ½ λ̈ t²（t 天）
  const t = [0, 30, 60, 90]
  const lam2 = (L[3] - 3 * L[2] + 3 * L[1] - L[0])   // 三阶差分检查
  const acc = (L[2] - 2 * L[1] + L[0]) / (30 * 30)  // °/d²（二阶差分）
  console.log('定点 ' + lon + '°E：一年倾角矢量变化 ' + di.toFixed(3) + '°（方向 ' + (Math.atan2(i1[1] - i0[1], i1[0] - i0[0]) / DEG).toFixed(1) + '°）；平经度 0/30/60/90 d：' + L.map((x) => x.toFixed(3)).join(' / ') + '；λ̈≈' + acc.toExponential(2) + ' °/d²')
}
// 北南保持 Δv/年（Δv = V·Δi）
const V = 3074.66
console.log('N-S 保持 Δv ≈ V·Δi = ' + (V * 0.75 * DEG).toFixed(1) + '–' + (V * 0.95 * DEG).toFixed(1) + ' m/s/年（Δi 0.75–0.95°/年）')
// 光压 e 圆半径（SDP4 不含）：r_e = 3 P C_R (A/m) / (2 V ω_s)
const P = 4.56e-6, ws = 2 * Math.PI / (365.2422 * 86400)
for (const am of [0.01, 0.02, 0.03]) console.log('A/m=' + am + ' m²/kg、C_R=1.5：自然偏心率圆半径 ' + (3 * P * 1.5 * am / (2 * V * ws)).toExponential(2) + ' → 日经度天平动 ±' + (2 * 3 * P * 1.5 * am / (2 * V * ws) / DEG).toFixed(3) + '°')
