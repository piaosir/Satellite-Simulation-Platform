// ITU 区域判定用的国家面：src/viz/globe3d/data/basemap-10m.json → packages/core/utils/itu/ituRegionGeo.json
//
// 用途：packages/core/utils/itu/ituRegion.js 按 RR No.5.3–5.9 判定站址所在 ITU 区域（Region 1/2/3），
// 以及 RR Art.21 Table 21-4 里「Region 1 countries listed in Nos. 5.494 and 5.496」这类国家条件。
// 线 A / B / C 是解析几何（大圆弧），不需要数据；数据只用于 RR 点名的国家：
//   r1East  No.5.3：Armenia, Azerbaijan, Russian Federation, Georgia, Kazakhstan, Mongolia, Uzbekistan,
//           Türkiye, Kyrgyzstan, Tajikistan, Turkmenistan, Ukraine 整体属 Region 1（哪怕在线 A 以东）
//   r3West  No.5.3 / 5.5：伊朗在线 A 以西的那部分属 Region 3
//   rr5_494 / rr5_496：RR 2024 Vol.1 RR5-117 两条脚注的国家表（WRC-23 / WRC-2000 版本原文）
//   r3Anchor  与上列国家陆地相邻、或隔窄海相望的 Region 3 国家（中、朝、日、阿富汗、巴基斯坦）：
//           只用来认「这点在 Region 3 的陆地上」，免得 ituRegion.js 的近岸就近归属把它们的岸边划给俄罗斯 / 中亚
//
// 数据源：仓库内的 basemap-10m.json（scripts/build-basemap.mjs 由 Natural Earth 5.1.1
//   ne_10m_admin_0_map_units 生成，公有领域；原始下载 https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_map_units.zip）。
//   只取基础分区（dispute != true）；NE 的 PSX（West Bank / Gaza）记作 PSE、SOL（Somaliland）记作 SOM、
//   SDS（South Sudan，NE 自用码）记作 ISO 3166 的 SSD。
//   1:50m 试过：海岸线丢了布什尔半岛、哈尔克岛、大代奥米德岛，绥芬河一带国界偏 4 km 以上，判区会错，故用 1:10m。
//   ★ 中国陆地锚不用 NE：NE 1:10m 把绥芬河、阿拉山口划进了俄 / 哈（国界线概括误差 1–3 km）。改用阿里 DataV
//   GeoAtlas（民政部行政区划，见 scripts/lib/chinaDatav.mjs）100000_full 里与 Region 1 国家接壤的五省区
//   ——内蒙古 150000、吉林 220000、黑龙江 230000、甘肃 620000、新疆 650000——的省界面作 CHN；
//   境内其余省份离任何 Region 1 国家都远，线判本就是 Region 3，不需要面。ituRegion.js 先认 CHN 再认其余国家。
//   DataV 坐标按原样用，未做 GCJ-02 → WGS-84 换算（若源为 GCJ-02，偏差约 0.5 km，小于 0.01° 的抽稀容差）。
// 处理：逐条 arc 做 Douglas–Peucker 抽稀（共享边界只抽一次 → 相邻国家的边仍严丝合缝），再拼面，
//   坐标保留 3 位小数（约 100 m）；按用途去掉不影响判区的小面（见 keepPoly）。输入文件的 SHA-256 写进输出 meta。
//
// 用法：node scripts/build-itu-regions.mjs [容差°，缺省 0.01] [10m|50m，缺省 10m]
//   （仓库里那份即缺省参数生成：10m、0.01°，约 400 KB；scripts/_ne/datav-100000.json 不在本机时由 chinaDatav 联网取）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { feature } from 'topojson-client'
import { decodeArc, polysOf } from './lib/geomUtil.mjs'
import { datavFull } from './lib/chinaDatav.mjs'
import { CACHE } from './lib/neFetch.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOL = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 0.01
const SCALE = process.argv[3] || '10m'
const SRC = path.join(ROOT, 'src', 'viz', 'globe3d', 'data', `basemap-${SCALE}.json`)
const OUT = path.join(ROOT, 'packages', 'core', 'utils', 'itu', 'ituRegionGeo.json')

const SETS = {
  r1East: ['ARM', 'AZE', 'RUS', 'GEO', 'KAZ', 'MNG', 'UZB', 'TUR', 'KGZ', 'TJK', 'TKM', 'UKR'],
  r3West: ['IRN'],
  rr5_494: ['DZA', 'SAU', 'BHR', 'CMR', 'CAF', 'COG', 'CIV', 'DJI', 'EGY', 'ARE', 'ERI', 'ETH', 'GAB', 'GHA', 'GIN',
    'IRQ', 'ISR', 'JOR', 'KWT', 'LBN', 'LBY', 'MDG', 'MLI', 'MAR', 'MNG', 'NGA', 'OMN', 'PSE', 'QAT', 'SYR', 'COD',
    'SOM', 'SDN', 'SSD', 'TCD', 'TGO', 'YEM'],
  rr5_496: ['AUT', 'AZE', 'KGZ', 'TKM'],
  r3Anchor: ['CHN', 'PRK', 'JPN', 'AFG', 'PAK']
}
const ISO_ALIAS = { PSX: 'PSE', SOL: 'SOM', SDS: 'SSD' }
const EXCEPTION = new Set([...SETS.r1East, ...SETS.r3West])

// 哪些面要收（面积按外环、度²）：
//   · No.5.3 例外国家与伊朗：≥ 0.0005 度²（约 5 km²）的岛都收——离岸 25 km 以外的岛（哈尔克、大代奥米德）只能靠自己的面；
//     俄罗斯整块在 65.5°N 以北的岛群不收（ituRegion.js 把线 A–C 之间 65.5°N 以北一律判 Region 1，No.5.3「the area to
//     the north of Russian Federation which lies between lines A and C」）
//   · 陆地锚与 5.494 / 5.496 国家：只收 ≥ 0.01 度²（约 100 km²）的面；日本只收北纬 41° 以北（北海道一带，与俄罗斯相望处）
function keepPoly(iso, area, bbox) {
  if (iso === 'RUS' && bbox[1] >= 65.5) return false
  if (EXCEPTION.has(iso)) return area >= 0.0005
  if (iso === 'JPN' && bbox[3] < 41) return false
  return area >= 0.01
}

// Douglas–Peucker（经纬度平面，端点保留）
function simplify(pts, tol) {
  if (pts.length <= 2) return pts.slice()
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    const [x1, y1] = pts[a], [x2, y2] = pts[b]
    const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy
    let best = -1, bi = -1
    for (let i = a + 1; i < b; i++) {
      const [x, y] = pts[i]
      let d
      if (L2 === 0) d = Math.hypot(x - x1, y - y1)
      else {
        const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L2))
        d = Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
      }
      if (d > best) { best = d; bi = i }
    }
    if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]) }
  }
  return pts.filter((_, i) => keep[i])
}
const flatArea = (r) => { let s = 0; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) s += r[j] * r[i + 1] - r[i] * r[j + 1]; return Math.abs(s / 2) }

const raw = fs.readFileSync(SRC)
const sha = crypto.createHash('sha256').update(raw).digest('hex')
const topo = JSON.parse(raw.toString('utf8'))
// 逐 arc 定容差：例外国家与陆地锚用到的 arc 取 TOL；只属 5.494 / 5.496 国家（及其不收录邻国）的取 3×TOL；
// 整条在 65.5°N 以北的（俄罗斯北冰洋海岸）取 0.1°——那一带由「线 A–C 之间 65.5°N 以北归 Region 1」直接判，海岸细节不起作用
const FINE = new Set([...EXCEPTION, ...SETS.r3Anchor])
const arcFine = new Uint8Array(topo.arcs.length)
const walk = (a) => Array.isArray(a) ? a.forEach(walk) : (arcFine[a < 0 ? ~a : a] = 1)
for (const g of topo.objects.units.geometries) {
  const iso = ISO_ALIAS[(g.properties || {}).iso] || (g.properties || {}).iso
  if (FINE.has(iso) && g.arcs) walk(g.arcs)
}
// 一条 arc 可能从挪威边界一路沿北冰洋、太平洋海岸走到朝鲜边界，故按「是否在 65.5°N 以北」切成连续段分别抽稀，
// 段与段的分界点保留（端点不动 ⇒ 拓扑不变）
const absArcs = topo.arcs.map((a, i) => {
  const pts = decodeArc(topo, a)
  const base = arcFine[i] ? TOL : 3 * TOL
  const out = []
  let s = 0
  while (s < pts.length) {
    const north = pts[s][1] >= 65.5
    let e = s
    while (e + 1 < pts.length && (pts[e + 1][1] >= 65.5) === north) e++
    const run = simplify(pts.slice(s, Math.min(e + 2, pts.length)), north ? 0.1 : base)   // 带上下一段的首点，接缝处共点
    if (out.length) run.shift()
    out.push(...run)
    s = e + 1
  }
  return out
})
const flatTopo = { type: 'Topology', objects: topo.objects, arcs: absArcs }   // 无 transform ⇒ arcs 即绝对坐标
const want = new Set(Object.values(SETS).flat())
const r3 = (v) => Math.round(v * 1000) / 1000
const countries = {}
let nPts = 0
// 一块面（[外环, 洞…]，各环为 [[lon,lat]…]）→ 量化、去重、过滤后挂到 iso 名下
function addPoly(iso, poly, keep) {
  const rings = []
  for (const ring of poly) {
    const flat = []
    let px = NaN, py = NaN
    for (const [x, y] of ring) {
      const qx = r3(x), qy = r3(y)
      if (qx === px && qy === py) continue
      flat.push(qx, qy); px = qx; py = qy
    }
    if (flat.length >= 8) rings.push(flat)
  }
  if (!rings.length) return
  const o = rings[0]
  let w = 180, s = 90, e = -180, n = -90
  for (let i = 0; i < o.length; i += 2) { w = Math.min(w, o[i]); e = Math.max(e, o[i]); s = Math.min(s, o[i + 1]); n = Math.max(n, o[i + 1]) }
  if (!keep(flatArea(o), [w, s, e, n])) return
  const c = countries[iso] || (countries[iso] = { bbox: [180, 90, -180, -90], polys: [] })
  c.polys.push({ bbox: [w, s, e, n], rings })
  c.bbox = [Math.min(c.bbox[0], w), Math.min(c.bbox[1], s), Math.max(c.bbox[2], e), Math.max(c.bbox[3], n)]
  nPts += rings.reduce((t, r) => t + r.length / 2, 0)
}

// ① CHN：DataV 五省区省界（先写进 countries ⇒ ituRegion.js 遍历时第一个认）
const CN_PROV = [150000, 220000, 230000, 620000, 650000]
const dv = await datavFull(100000)
const dvSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(CACHE, 'datav-100000.json'))).digest('hex')
for (const f of dv.features) {
  if (!CN_PROV.includes(f.properties && f.properties.adcode)) continue
  for (const poly of polysOf(f.geometry)) addPoly('CHN', poly.map((ring) => simplify(ring, TOL)), (area) => area >= 0.0005)
}
// ② 其余国家：NE
for (const g of topo.objects.units.geometries) {
  const p = g.properties || {}
  if (p.dispute) continue
  const iso = ISO_ALIAS[p.iso] || p.iso
  if (!want.has(iso) || iso === 'CHN') continue
  const f = feature(flatTopo, g)
  for (const poly of polysOf(f.geometry)) addPoly(iso, poly, (area, bbox) => keepPoly(iso, area, bbox))
}
const missing = [...want].filter((k) => !countries[k])
if (missing.length) { console.error(`basemap-${SCALE} 缺这些国家：`, missing.join(' ')); process.exit(1) }
const out = {
  meta: {
    purpose: 'ITU Region (RR Nos. 5.3-5.9) country exceptions and RR Nos. 5.494 / 5.496 country lists for RR Art.21 Table 21-4',
    source: `src/viz/globe3d/data/basemap-${SCALE}.json (Natural Earth 5.1.1 ne_${SCALE}_admin_0_map_units, public domain; https://naciscdn.org/naturalearth/${SCALE}/cultural/ne_${SCALE}_admin_0_map_units.zip)`,
    sourceSha256: sha,
    sourceChn: 'Aliyun DataV GeoAtlas https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json (Ministry of Civil Affairs divisions), provinces ' + CN_PROV.join(', '),
    sourceChnSha256: dvSha,
    simplifyToleranceDeg: TOL,
    coordinateDecimals: 3,
    lists: 'RR Edition 2024 Vol.1: No.5.3 (WRC-23) RR5-2; No.5.494 (WRC-23) and No.5.496 (WRC-2000) RR5-117',
    generatedBy: 'scripts/build-itu-regions.mjs'
  },
  sets: SETS,
  countries
}
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify(out))
console.log(`写出 ${path.relative(ROOT, OUT)}：${Object.keys(countries).length} 国、${nPts} 点、${(fs.statSync(OUT).size / 1024).toFixed(1)} KB（${SCALE}，容差 ${TOL}°）`)
