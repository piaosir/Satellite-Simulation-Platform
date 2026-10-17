// B 路验证 5：星间链路「指向角速率」量级——同面 / 异面邻星在本星 LVLH 系里的视线方位、俯仰角速率。
// 平台的星间几何（ngsoGeometry.solveIslWorstCase）只约束 掠地高度 + 最大工作距离，不约束角速率 / 终端视场；这里量它会差多少。
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const MU = 398600.4418, RE = 6378.137, R2D = 180 / Math.PI
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
const P = 72, S = 22, F = 39, altKm = 550, incl = 53
const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI)
const mk = (p, s) => sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 })
const A = mk(0, 0), sameNext = mk(0, 1), crossR = mk(1, 0)
// 异面邻星：在 1 号面里找与 A 在 t0 最近的那颗
let best = null, bd = Infinity
for (let s = 0; s < S; s++) { const r = mk(1, s); const pa = sat.propagate(A, epoch).position, pb = sat.propagate(r, epoch).position; const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z); if (d < bd) { bd = d; best = r } }
const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
const nrm = (u) => { const l = Math.hypot(...u); return [u[0] / l, u[1] / l, u[2] / l] }, cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
function azElLvlh(rec, tgt, t) {
  const pv = sat.propagate(rec, t), q = sat.propagate(tgt, t).position
  const r = [pv.position.x, pv.position.y, pv.position.z], v = [pv.velocity.x, pv.velocity.y, pv.velocity.z]
  const z = nrm(r.map((x) => -x)), y = nrm(cross(z, v).map((x) => x)), x = cross(y, z)   // LVLH：z 天底、y 负轨道法向、x 近似沿迹
  const los = nrm(sub([q.x, q.y, q.z], r))
  return { az: Math.atan2(dot(los, y), dot(los, x)) * R2D, el: Math.asin(dot(los, z)) * R2D, d: Math.hypot(q.x - r[0], q.y - r[1], q.z - r[2]), lat: Math.asin(r[2] / Math.hypot(...r)) * R2D }
}
for (const [tag, tgt] of [['同面前星', sameNext], ['异面邻星（右侧面最近）', best]]) {
  let maxAzRate = 0, maxElRate = 0, latAt = 0, dMin = Infinity, dMax = 0, azSpan = [999, -999]
  const dt = 10, T = 2 * 5760
  let prev = azElLvlh(A, tgt, epoch)
  for (let k = 1; k <= T / dt; k++) {
    const t = new Date(epoch.getTime() + k * dt * 1000), cur = azElLvlh(A, tgt, t)
    let daz = cur.az - prev.az; if (daz > 180) daz -= 360; if (daz < -180) daz += 360
    const ra = Math.abs(daz) / dt, re = Math.abs(cur.el - prev.el) / dt
    if (ra > maxAzRate) { maxAzRate = ra; latAt = cur.lat }
    if (re > maxElRate) maxElRate = re
    if (cur.d < dMin) dMin = cur.d; if (cur.d > dMax) dMax = cur.d
    if (cur.az < azSpan[0]) azSpan[0] = cur.az; if (cur.az > azSpan[1]) azSpan[1] = cur.az
    prev = cur
  }
  console.log(`${tag}：距离 ${dMin.toFixed(0)}–${dMax.toFixed(0)} km；LVLH 方位摆动 ${azSpan[0].toFixed(1)}°…${azSpan[1].toFixed(1)}°；方位角速率峰值 ${maxAzRate.toFixed(3)}°/s（出现在纬度 ${latAt.toFixed(1)}°）；俯仰角速率峰值 ${maxElRate.toFixed(4)}°/s`)
}
