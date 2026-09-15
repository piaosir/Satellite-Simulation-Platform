// 城市指向误差框（src/viz/grd/cityBoxes.js）自测。运行：npm test
//
// 钉死的是几何口径：① 椭圆框绕着城市、随误差线性变大；② 矩形＝刚性屏幕标记（只给半宽半高、不出环、同一设置全体城市
// 同一尺寸、尺寸＝星下点尺度；四角由 2D / 3D 渲染端按当前视图的像素/度现算）；③ yaw 只放大不旋转；④ 背面的城市没有框；
// ⑤ 整层的标签与开关；⑥ 跨日界线：椭圆环经度折回 [-180,180)、矩形尺寸不变；半幅＝输入/2，与 Min/Max Pointing 列同一口径
//（0.2° 的框比 0.1° 的框宽一倍）。
import { cityBoxRing, cityBoxItems, nadirGroundDeg, CITY_BOX_ELLIPSE_N } from '../../../src/viz/grd/cityBoxes.js'
import { antennaBasis } from '../../../src/viz/grd/coverage.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const span = (ring) => {
  let lo0 = Infinity, hi0 = -Infinity, lo1 = Infinity, hi1 = -Infinity
  for (const [x, y] of ring) { lo0 = Math.min(lo0, x); hi0 = Math.max(hi0, x); lo1 = Math.min(lo1, y); hi1 = Math.max(hi1, y) }
  return { lo0, hi0, lo1, hi1, dLon: hi0 - lo0, dLat: hi1 - lo1, cLon: (hi0 + lo0) / 2, cLat: (hi1 + lo1) / 2 }
}
// 矩形只有半宽 / 半高（度）：全宽 / 全高与椭圆的 span 同一口径可比
const dim = (r) => ({ dLon: 2 * r.rect.w, dLat: 2 * r.rect.h })

// GEO 110.5°E，天底指向；城市＝北京
const basis = antennaBasis(110.5, 110.5, 0, 0, 0, 35786)
const BJ = [116.4074, 39.9042]

// ==================== ① 椭圆框绕着城市，尺寸随误差走 ====================
{
  const r1 = cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 })
  const r2 = cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.2, el: 0.2, yaw: 0 })
  ok('① 椭圆框点数 = N+1（闭合）', r1 && r1.ring.length === CITY_BOX_ELLIPSE_N + 1, r1 && r1.ring.length)
  const s1 = span(r1.ring), s2 = span(r2.ring)
  ok('① 框心落在城市上（<0.02°）', Math.abs(s1.cLon - BJ[0]) < 0.02 && Math.abs(s1.cLat - BJ[1]) < 0.02, `${s1.cLon.toFixed(3)},${s1.cLat.toFixed(3)}`)
  // GEO 到北京斜距约 38 000 km，±0.05° → 东西向半宽约 33 km ≈ 0.4° 经度；南北向被入射角拉长
  ok('① 0.1° 全幅的框东西向跨度在 0.5°~1.2° 之间', s1.dLon > 0.5 && s1.dLon < 1.2, s1.dLon.toFixed(3))
  ok('① 南北向比东西向长（斜入射拉长）', s1.dLat > s1.dLon, `${s1.dLat.toFixed(3)} vs ${s1.dLon.toFixed(3)}`)
  ok('① 误差加倍 → 框加倍（半幅=输入/2 的线性口径）', Math.abs(s2.dLon / s1.dLon - 2) < 0.02 && Math.abs(s2.dLat / s1.dLat - 2) < 0.02, `${(s2.dLon / s1.dLon).toFixed(3)} / ${(s2.dLat / s1.dLat).toFixed(3)}`)
  ok('① 整框在地平内', r1.vis === true)
}

// ==================== ② 矩形：刚性屏幕标记 —— 只给半宽半高、以城市为中心、全体同尺寸 ====================
{
  const spec = { type: 'rect', az: 0.1, el: 0.1, yaw: 0 }
  const r = cityBoxRing(basis, BJ[0], BJ[1], spec)
  // 09-16 起矩形不出地理环（沿经纬线的环在 3D / Mercator / Robinson / 方位档下弯曲变形，用户否决）：
  // 只给半宽 / 半高（度），渲染端按当前视图的像素/度画四边水平竖直的屏幕矩形
  ok('② 矩形不出环、只给半宽半高、恒在地平内', !!r && r.ring === null && !!r.rect && r.rect.w > 0 && r.rect.h > 0 && r.vis === true)
  const sr = dim(r)
  // ★ 同一设置 → 全体城市同一尺寸（海口近星下点、喀什远、北京中间）
  const HK = dim(cityBoxRing(basis, 110.33, 20.03, spec)), KS = dim(cityBoxRing(basis, 75.99, 39.47, spec))
  ok('② 同一设置全体城市同尺寸（北京 = 海口 = 喀什）', Math.abs(HK.dLon - sr.dLon) < 1e-9 && Math.abs(KS.dLon - sr.dLon) < 1e-9 && Math.abs(HK.dLat - sr.dLat) < 1e-9 && Math.abs(KS.dLat - sr.dLat) < 1e-9, `${sr.dLon.toFixed(4)} / ${HK.dLon.toFixed(4)} / ${KS.dLon.toFixed(4)}`)
  // 尺寸＝星下点尺度：GEO 0.1° 全幅 → 2×(asin(42164·sin0.05°/6378.137) − 0.05°) ≈ 0.561°；Az 管宽、El 管高
  const g = 2 * nadirGroundDeg(Math.hypot(...basis.S), 0.05)
  ok('② 边长＝星下点尺度（0.1° → ≈0.56°）', Math.abs(sr.dLon - g) < 1e-9 && Math.abs(sr.dLat - g) < 1e-9 && g > 0.55 && g < 0.57, `${g.toFixed(4)}`)
  const rw = dim(cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.2, el: 0.1, yaw: 0 }))
  ok('② Az 管宽、El 管高', Math.abs(rw.dLon / sr.dLon - 2) < 0.01 && Math.abs(rw.dLat - sr.dLat) < 1e-9, `${(rw.dLon / sr.dLon).toFixed(3)}`)
  // 星下点处矩形与椭圆轨迹同大（同一份口径），离星下点远了椭圆更大、矩形不跟
  const nadE = span(cityBoxRing(basis, 110.5, 0, { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 }).ring), nadR = dim(cityBoxRing(basis, 110.5, 0, spec))
  ok('② 星下点处矩形 ≈ 椭圆（<1%）', Math.abs(nadE.dLon / nadR.dLon - 1) < 0.01 && Math.abs(nadE.dLat / nadR.dLat - 1) < 0.01, `${nadE.dLon.toFixed(4)} vs ${nadR.dLon.toFixed(4)}`)
  const e = span(cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 }).ring)
  ok('② 北京处椭圆轨迹比矩形大（矩形是标记不是轨迹）', e.dLon > sr.dLon && e.dLat > sr.dLat, `${e.dLon.toFixed(3)}/${sr.dLon.toFixed(3)}`)
  const s2 = dim(cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.2, el: 0.2, yaw: 0 }))
  ok('② 误差加倍 → 矩形加倍', Math.abs(s2.dLon / sr.dLon - 2) < 0.01 && Math.abs(s2.dLat / sr.dLat - 2) < 0.01, `${(s2.dLon / sr.dLon).toFixed(3)} / ${(s2.dLat / sr.dLat).toFixed(3)}`)
  // 只有 Az 误差：矩形退化成一条东西向线段（高 0）
  const rz = cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.1, el: 0, yaw: 0 })
  ok('② 只有 Az 误差 → 东西向线段（高 0）', !!rz && Math.abs(2 * rz.rect.w - g) < 1e-9 && rz.rect.h === 0, rz && `${(2 * rz.rect.w).toFixed(3)} × ${rz.rect.h}`)
  // 椭圆环仍旧闭合、绕着城市（矩形改屏幕矩形不碰椭圆逻辑）
  ok('② 椭圆不受影响：仍出环、rect 为 null', e.dLon > 0 && cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 }).rect === null)
  // 越过地平的误差量钳在切点：不 NaN、不超过地平地心角 acos(R/r) ≈ 81.3°
  const big = nadirGroundDeg(42164, 30)
  ok('② 星下点尺度越过地平钳在切点', big > 81 && big < 81.4, big.toFixed(3))
}

// ==================== ③ yaw：只放大 ====================
{
  const a = cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 })
  const b = cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 1 })
  const sa = span(a.ring), sb = span(b.ring)
  ok('③ 加 yaw 后框更大', sb.dLon > sa.dLon && sb.dLat > sa.dLat, `${sb.dLon.toFixed(3)}>${sa.dLon.toFixed(3)}`)
  ok('③ yaw 不改框心', Math.abs(sb.cLon - sa.cLon) < 0.02 && Math.abs(sb.cLat - sa.cLat) < 0.02)
  // 只有 yaw、没有 Az/El 也有框（离天底 θ·ψ 的位移）
  const c = cityBoxRing(basis, BJ[0], BJ[1], { type: 'ellipse', az: 0, el: 0, yaw: 1 })
  ok('③ 纯 yaw 也出框', !!c && span(c.ring).dLon > 0)
  const d0 = dim(cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.1, el: 0.1, yaw: 0 })), d1 = dim(cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.1, el: 0.1, yaw: 1 }))
  ok('③ 矩形加 yaw 同样只放大', d1.dLon > d0.dLon && d1.dLat > d0.dLat)
  // yaw 的放大量随离天底角走：喀什（远）比海口（近）放得更大
  const yHK = dim(cityBoxRing(basis, 110.33, 20.03, { type: 'rect', az: 0.1, el: 0.1, yaw: 1 })), yKS = dim(cityBoxRing(basis, 75.99, 39.47, { type: 'rect', az: 0.1, el: 0.1, yaw: 1 }))
  ok('③ 有 yaw 时离天底越远矩形越大（手册口径）', yKS.dLon > yHK.dLon, `${yKS.dLon.toFixed(3)} > ${yHK.dLon.toFixed(3)}`)
}

// ==================== ④ 无误差 / 背面 ====================
{
  ok('④ 三项误差全 0 没有框', cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0, el: 0, yaw: 0 }) === null)
  ok('④ 地球背面的城市没有框（纽约对 110.5°E）', cityBoxRing(basis, -74.0, 40.7, { type: 'rect', az: 0.1, el: 0.1, yaw: 0 }) === null)
}

// ==================== ⑤ 整层：标签与开关 ====================
{
  const st = [{ id: 'a', city: '北京', desig: 'BJ', lon: BJ[0], lat: BJ[1] }, { id: 'b', city: '', desig: '', lon: null, lat: 1 }, { id: 'c', city: '纽约', desig: 'NYC', lon: -74, lat: 40.7 }]
  const items = cityBoxItems(basis, st, { cityMarkOn: true, cityMarkType: 'rect', pointAz: 0.1, pointEl: 0.1, pointYaw: 0 }, (s) => s.desig || s.city)
  ok('⑤ 坐标不全的行不进层', items.length === 2 && items[0].id === 'a' && items[1].id === 'c')
  ok('⑤ 标签取代号', items[0].text === 'BJ')
  ok('⑤ 正面的城市带矩形半宽半高、不带环', !!items[0].rect && items[0].rect.w > 0 && items[0].ring === null)
  ok('⑤ 背面的城市只有标签没有框', items[1].ring === null && items[1].rect === null && items[1].text === 'NYC')
  const off = cityBoxItems(basis, st, { cityMarkOn: false, pointAz: 0.1, pointEl: 0.1 }, (s) => s.city)
  ok('⑤ 标记关掉时不算框', off[0].ring === null && off[0].rect === null && off[0].text === '北京')
  const ell = cityBoxItems(basis, st, { cityMarkOn: true, cityMarkType: 'ellipse', pointAz: 0.1, pointEl: 0.1, pointYaw: 0 }, (s) => s.city)
  ok('⑤ 椭圆档带环、不带 rect', Array.isArray(ell[0].ring) && ell[0].ring.length === CITY_BOX_ELLIPSE_N + 1 && ell[0].rect === null)
}

// ==================== ⑥ 跨日界线：椭圆环经度折回 [-180,180)、相对城市对称；矩形尺寸不随城市位置变 ====================
{
  const CT = [179.95, 0]   // 110.5°E 的 GEO 看 179.95°E / 0°N（仰角约 13°），东边沿越过 180°
  const r = cityBoxRing(basis, CT[0], CT[1], { type: 'ellipse', az: 0.1, el: 0.1, yaw: 0 })
  ok('⑥ 低仰角城市有框', !!r && Array.isArray(r.ring))
  ok('⑥ 经度全在 [-180,180)', r.ring.every(([x]) => x >= -180 && x < 180))
  const rel = r.ring.map(([x]) => ((x - CT[0] + 540) % 360) - 180)
  const east = Math.max(...rel), west = Math.min(...rel)
  // 13° 仰角处真实轨迹远侧更长（斜入射拉长），东西不严格对称，只要求两侧都有、偏心 < 15%
  ok('⑥ 椭圆环绕着城市（跨缝后东西两侧都有点）', east > 0 && west < 0 && Math.abs(east + west) < 0.15 * (east - west), `${west.toFixed(3)}…${east.toFixed(3)}`)
  ok('⑥ 有点落在 180° 另一侧（确实跨了缝）', r.ring.some(([x]) => x < 0))
  const q = dim(cityBoxRing(basis, CT[0], CT[1], { type: 'rect', az: 0.1, el: 0.1, yaw: 0 })), b = dim(cityBoxRing(basis, BJ[0], BJ[1], { type: 'rect', az: 0.1, el: 0.1, yaw: 0 }))
  ok('⑥ 日界线上的矩形与北京同尺寸（刚性标记）', Math.abs(q.dLon - b.dLon) < 1e-9 && Math.abs(q.dLat - b.dLat) < 1e-9)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
