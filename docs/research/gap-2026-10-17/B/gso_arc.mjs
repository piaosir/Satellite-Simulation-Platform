// B 路验证 3：NGSO 地球站「GSO 弧规避角 α₀」对可见性 / 服务星选择的影响量级。
// α 用平台现成的 pfdmask/alphaGeometry.alphaAndDeltaLong（S.1503 §D6.4.4.1 拓扑角，PFD 掩模生成器同一份），
// 只是可见性 / 覆盖 / NGSO 链路几何 / C/I 选服务星都没接它——这里在外面把它当约束套一遍，量差多少。
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const geo = require(ROOT + '/packages/core/utils/pfdmask/alphaGeometry.js')

const MU = 398600.4418, RE = 6378.137, D2R = Math.PI / 180
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
function walker({ altKm, incl, P, S, F = 1 }) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI), out = []
  for (let p = 0; p < P; p++) for (let s = 0; s < S; s++) {
    out.push(sat.omm2satrec({ noradId: 900000 + p * 100 + s, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl, raan: 360 * p / P, argp: 0, ma: (360 * s / S + 360 * F * p / (P * S)) % 360, bstar: 0, mdot: 0, mddot: 0 }))
  }
  return out
}
const recs = walker({ altKm: 550, incl: 53, P: 72, S: 22 })   // Starlink 1 号壳同构（1584 颗）
const stations = [
  { name: '北京 39.9°N', lat: 39.9042, lon: 116.4074 },
  { name: '海口 20.0°N', lat: 20.04, lon: 110.32 },
  { name: '新加坡 1.35°N', lat: 1.3521, lon: 103.8198 },
]
const minEl = 25, alphas = [3, 10, 18], T = 240, STEP = 30
for (const st of stations) {
  const es = geo.geodeticToEcefKm(st.lon, st.lat, 0)
  let any0 = 0, n0 = 0, bestEl0 = []
  const anyA = alphas.map(() => 0), nA = alphas.map(() => 0), bestElA = alphas.map(() => []), swapA = alphas.map(() => 0)
  for (let k = 0; k < T; k++) {
    const d = new Date(epoch.getTime() + k * STEP * 1000), g = sat.gstime(d)
    const vis = []
    for (const r of recs) {
      const pv = sat.propagate(r, d); if (!pv || !pv.position) continue
      const e = sat.eciToEcf(pv.position, g), ecef = [e.x, e.y, e.z]
      const el = geo.elevationFrom(st.lon, st.lat, 0, ecef)
      if (el >= minEl) vis.push({ el, ecef })
    }
    vis.sort((a, b) => b.el - a.el)
    if (vis.length) { any0++; bestEl0.push(vis[0].el) }
    n0 += vis.length
    const al = vis.map((v) => { const a = geo.alphaAndDeltaLong({ lonDeg: st.lon, latDeg: st.lat, altKm: 0 }, v.ecef, { minElevDeg: 0, coarseStepDeg: 2, tolDeg: 1e-3 }); return a ? Math.abs(a.alphaDeg) : 180 })
    alphas.forEach((a0, i) => {
      const ok = vis.filter((v, j) => al[j] >= a0)
      if (ok.length) { anyA[i]++; bestElA[i].push(ok[0].el) }
      nA[i] += ok.length
      if (vis.length && (!ok.length || ok[0] !== vis[0])) swapA[i]++   // 「最高仰角星」被规避掉、服务星换人（或无星）的拍数
    })
  }
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
  console.log(`${st.name} · 门限 ${minEl}° · 2h/30s：不计规避 有星 ${(100 * any0 / T).toFixed(1)}% 平均可见 ${(n0 / T).toFixed(1)} 颗 最高仰角中位 ${med(bestEl0).toFixed(1)}°`)
  alphas.forEach((a0, i) => console.log(`    α₀=${a0}°：有星 ${(100 * anyA[i] / T).toFixed(1)}% 平均可用 ${(nA[i] / T).toFixed(1)} 颗（${(100 * nA[i] / Math.max(1, n0)).toFixed(1)}%）服务星最高仰角中位 ${med(bestElA[i]).toFixed(1)}° · 「最高仰角星」落入规避区的拍 ${(100 * swapA[i] / T).toFixed(1)}%`))
}
