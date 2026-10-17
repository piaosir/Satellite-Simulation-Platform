// B 路验证 6：地面站 Az/El 座跟踪 LEO 过顶的方位角速率（keyhole）——平台站约束只有「最低仰角」，没有角速率 / 座架类型。
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const sat = (await import(pathToFileURL(ROOT + '/src/viz/constellation/satellite.js').href)).default
const MU = 398600.4418, RE = 6378.137, D2R = Math.PI / 180, R2D = 180 / Math.PI
const epoch = new Date(Date.UTC(2026, 9, 17, 0, 0, 0))
const st = { latitude: 39.9042 * D2R, longitude: 116.4074 * D2R, height: 0 }
for (const altKm of [550, 1200]) {
  const a = RE + altKm, n = 86400 * Math.sqrt(MU / a ** 3) / (2 * Math.PI)
  const rows = []
  // 扫一圈 RAAN，让某些过境近天顶
  for (let k = 0; k < 720; k++) {
    const rec = sat.omm2satrec({ noradId: 1, epoch: epoch.toISOString(), meanMotion: n, ecc: 0.0001, incl: 53, raan: k * 0.5, argp: 0, ma: 0, bstar: 0, mdot: 0, mddot: 0 })
    let prev = null, peakEl = -90, maxAzRate = 0
    for (let t = 0; t < 6 * 3600; t += 1) {
      const d = new Date(epoch.getTime() + t * 1000), pv = sat.propagate(rec, d)
      if (!pv || !pv.position) continue
      const la = sat.ecfToLookAngles(st, sat.eciToEcf(pv.position, sat.gstime(d)))
      const el = la.elevation * R2D, az = la.azimuth * R2D
      if (el > 10) {
        if (el > peakEl) peakEl = el
        if (prev) { let da = az - prev.az; if (da > 180) da -= 360; if (da < -180) da += 360; maxAzRate = Math.max(maxAzRate, Math.abs(da)) }
        prev = { az }
      } else if (prev) { rows.push({ peakEl, maxAzRate }); prev = null; peakEl = -90; maxAzRate = 0 }
    }
  }
  const bins = [[60, 70], [70, 80], [80, 85], [85, 88], [88, 89.5], [89.5, 90]]
  const out = bins.map(([lo, hi]) => { const r = rows.filter((x) => x.peakEl >= lo && x.peakEl < hi); return r.length ? `${lo}–${hi}°: 方位角速率峰值 ${Math.max(...r.map((x) => x.maxAzRate)).toFixed(1)}°/s（${r.length} 次）` : `${lo}–${hi}°: —` })
  const over5 = rows.filter((x) => x.maxAzRate > 5).length, over10 = rows.filter((x) => x.maxAzRate > 10).length
  console.log(`LEO ${altKm} km · 北京 · ${rows.length} 次过境（>10°）：` + out.join('；') + `｜方位速率 >5°/s 的过境占 ${(100 * over5 / rows.length).toFixed(1)}%，>10°/s 占 ${(100 * over10 / rows.length).toFixed(1)}%`)
}
