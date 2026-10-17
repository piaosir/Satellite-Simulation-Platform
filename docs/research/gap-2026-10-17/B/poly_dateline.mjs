import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/85256/WeChatProjects/卫星仿真平台'
const C = await import(pathToFileURL(ROOT + '/src/viz/vis/coverageGrid.js').href)
// 跨日界线的太平洋矩形区 170°E → 170°W（宽 20°），纬度 0–20°N；按 2° 网格应得 10×10=100 格
const poly = [[170, 0], [-170, 0], [-170, 20], [170, 20]]
const g = C.makeCoverageGrid({ kind: 'poly', poly }, 2)
console.log('跨日界线 Polygon 网格胞元数', g.cells.length, '经度范围', g.lonMin, g.lonMax, '样例', JSON.stringify(g.cells.slice(0, 3)))
const g2 = C.makeCoverageGrid({ kind: 'poly', poly: [[150, 0], [170, 0], [170, 20], [150, 20]] }, 2)
console.log('不跨日界线的同尺寸区域胞元数', g2.cells.length)
const g3 = C.makeCoverageGrid({ kind: 'bounds', latMin: 0, latMax: 20, lonMin: 170, lonMax: -170 }, 2)
console.log('bounds 170 → -170 胞元数', g3.cells.length)
