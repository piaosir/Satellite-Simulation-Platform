const path = require('path')
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const LC = require(path.join(ROOT, 'packages/core/utils/linkCalculator.js'))
const DEG = Math.PI / 180, A = 6378.137, F = 1 / 298.257223563, E2 = F * (2 - F), R_GEO = 42164.17
function ex(la, lo, h, sl) {
  const s0 = Math.sin(la*DEG), c0 = Math.cos(la*DEG), N = A/Math.sqrt(1-E2*s0*s0)
  const o = [(N+h)*c0*Math.cos(lo*DEG),(N+h)*c0*Math.sin(lo*DEG),(N*(1-E2)+h)*s0]
  const s = [R_GEO*Math.cos(sl*DEG), R_GEO*Math.sin(sl*DEG), 0]
  const d = [s[0]-o[0], s[1]-o[1], s[2]-o[2]]
  const e = [-Math.sin(lo*DEG), Math.cos(lo*DEG), 0]
  const n = [-s0*Math.cos(lo*DEG), -s0*Math.sin(lo*DEG), c0]
  const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2]
  let az = Math.atan2(dot(d,e), dot(d,n))/DEG; if (az<0) az+=360
  return az
}
let mx = 0, w = null
for (const [la, lo] of [[39.9,116.4],[45.75,126.63],[52.97,122.53],[43.83,87.62],[39.47,75.99],[29.65,91.13],[18.25,109.5],[22.3,114.17],[5,110],[2,100]]) {
  for (const sl of [76.5,87.5,101.4,110.5,125,142,163]) {
    const a1 = LC.calculateSatelliteAngle(la, lo, sl), a2 = ex(la, lo, 0, sl)
    if (a1.elevation < 0) continue
    let d = a1.azimuth - a2; while (d > 180) d -= 360; while (d < -180) d += 360
    if (Math.abs(d) > Math.abs(mx)) { mx = d; w = [la, lo, sl, a1.azimuth, a2] }
  }
}
console.log('最大 |Δ方位| = ' + mx.toFixed(4) + '°', w)
