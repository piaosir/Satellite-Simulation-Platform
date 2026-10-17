// B 路验证 4：用平台自带的 Earth2014 5′ 地形（resources/itu/topo_v1.bin，elevation.js 同一份）算站址地平线掩模，
// 看「平台已有数据」能给出的地形遮挡量级；分辨率局限另述（5′≈9 km，近场 <10 km 的山体被平滑掉）。
import { createRequire } from 'node:module'
import fs from 'node:fs'
const require = createRequire(import.meta.url)
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const E = require(ROOT + '/packages/core/utils/elevation.js')
const buf = fs.readFileSync(ROOT + '/resources/itu/topo_v1.bin')
E.setFullPrecisionElevation(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
const h = (lat, lon) => { const r = E.queryElevation(lat, ((lon + 540) % 360) - 180); return r.success ? r.altitude : 0 }
const R = 6371e3, K = 4 / 3, D2R = Math.PI / 180
function horizon(site, maxKm = 60, stepM = 500, nAz = 72) {
  const h0 = (site.hM != null ? site.hM : h(site.lat, site.lon)) + (site.mastM || 5)
  const out = []
  for (let i = 0; i < nAz; i++) {
    const az = 360 * i / nAz * D2R
    let best = -90
    for (let d = stepM; d <= maxKm * 1000; d += stepM) {
      const dlat = d * Math.cos(az) / R / D2R, dlon = d * Math.sin(az) / (R * Math.cos(site.lat * D2R)) / D2R
      const z = h(site.lat + dlat, site.lon + dlon) - d * d / (2 * K * R)   // 4/3 等效地球曲率 + 折射
      const el = Math.atan2(z - h0, d) / D2R
      if (el > best) best = el
    }
    out.push(best)
  }
  return { h0, out }
}
const sites = [
  { name: '拉萨（河谷）', lat: 29.65, lon: 91.13 },
  { name: '密云站（燕山南麓）', lat: 40.45, lon: 116.85 },
  { name: '喀什', lat: 39.47, lon: 75.99 },
  { name: '昆明', lat: 25.04, lon: 102.71 },
  { name: '重庆', lat: 29.56, lon: 106.55 },
  { name: '香港', lat: 22.30, lon: 114.17 },
  { name: '三亚', lat: 18.25, lon: 109.51 },
  { name: '北京城区', lat: 39.90, lon: 116.41 },
]
for (const s of sites) {
  const { h0, out } = horizon(s)
  const max = Math.max(...out), mean = out.reduce((a, b) => a + b, 0) / out.length
  const over5 = out.filter((v) => v >= 5).length / out.length * 100, over10 = out.filter((v) => v >= 10).length / out.length * 100
  const iMax = out.indexOf(max)
  console.log(`${s.name} 站高 ${Math.round(h0)} m（Earth2014 5′）：地平线仰角 最大 ${max.toFixed(2)}°@${(iMax * 5)}° 方位 平均 ${mean.toFixed(2)}° ≥5° 的方位占 ${over5.toFixed(0)}% ≥10° 占 ${over10.toFixed(0)}%`)
}
