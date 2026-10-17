import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const V = await import(pathToFileURL(ROOT + '/src/viz/vis/visibility.js').href)
const M = await import(pathToFileURL(ROOT + '/packages/core/models/mapLinkPoints.mjs').href)
const cases = {
  '跨日界线太平洋区 170E→170W': [{ lon: 170, lat: 0 }, { lon: -170, lat: 0 }, { lon: -170, lat: 20 }, { lon: 170, lat: 20 }],
  '南海 U 形不规则区（一侧密点）': [{ lon: 108, lat: 18 }, { lon: 109, lat: 17 }, { lon: 109.5, lat: 16 }, { lon: 110, lat: 15 }, { lon: 110.5, lat: 14 }, { lon: 111, lat: 13 }, { lon: 111.5, lat: 12 }, { lon: 112, lat: 11 }, { lon: 112.5, lat: 10 }, { lon: 113, lat: 9 }, { lon: 117, lat: 4 }, { lon: 120, lat: 12 }, { lon: 120, lat: 21 }],
}
for (const [k, pts] of Object.entries(cases)) {
  const a = V.ringCentroid(pts)
  const ring = M.pgRing(pts.map((p) => [p.lon, p.lat]))
  const b = M.pgCentroid(ring)
  console.log(k, '| 可见性 ringCentroid', JSON.stringify(a), '| 链路分析 pgCentroid', JSON.stringify(b))
}
