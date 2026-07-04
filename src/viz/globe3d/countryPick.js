// 经纬度 → 国家（右键地图「设置此国大地颜色」用）：对 10m topojson 各国多边形做偶奇射线判定。
// 反子午线处理：把环上各点经度映射到「以测试点为中心的 ±180° 窗口」再计交叉，无需预解缠/复制坐标；
// 每次点选全量扫描（约百万点量级 ≈ 数毫秒），仅用户右键触发，不建常驻索引、不额外占内存。
// 纬度包围盒（无需解缠即可预计算）一次性缓存，扫描时先粗筛掉绝大多数多边形。
import { feature } from 'topojson-client'
import topo from './data/countries-10m.json'
import NAMES from './data/country-names-zh.json'
import { CHINA_IDS } from './cnClaims.js'
import { landColors } from '../landPalette.js'

let feats = null, latBounds = null, idxOf = null
function init() {
  feats = feature(topo, topo.objects.countries).features
  idxOf = new Map()   // 国家 id → 首个 feature 序号（landColors 的 morandi 循环色取位与建图一致）
  latBounds = feats.map((f, i) => {
    const id = String(f.id)
    if (!idxOf.has(id)) idxOf.set(id, i)
    if (!f.geometry) return []
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates
    return polys.map((rings) => {
      let lo = 90, hi = -90
      for (const p of rings[0]) { if (p[1] < lo) lo = p[1]; if (p[1] > hi) hi = p[1] }
      return [lo, hi]
    })
  })
}

// 经度差 → (-180, 180] 内的最短夹角（带符号）
const dlon = (l, ref) => ((l - ref + 540) % 360 + 360) % 360 - 180
// 多边形（外环+洞）偶奇判定：对所有环统一计「向 +x 的水平射线」交叉数。
// 环上各点先转成以 ref 为锚点的「连续展开」本地 x：逐点用与上一点的最短夹角累加，而非各自独立对 ref 取模。
// 若各点独立取模（如 dlon(p, ref)），当测试点的对跖经线正好穿过该国国土时（如堪萨斯↔中国西部），
// 环会被人为切成跳变的两段，导致射线交叉数算错、误判成一个毫不相关的国家（北美/南美 vs 亚洲互为对跖，故此前只有它们会错）。
function hitPolygon(rings, lon, lat) {
  let inside = false
  for (const ring of rings) {
    const n = ring.length
    const xs = new Array(n)
    xs[0] = dlon(ring[0][0], lon)
    for (let k = 1; k < n; k++) xs[k] = xs[k - 1] + dlon(ring[k][0], ring[k - 1][0])
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = ring[i][1], yj = ring[j][1]
      if ((yi > lat) === (yj > lat)) continue
      const xi = xs[i], xj = xs[j]
      if (xi + (lat - yi) / (yj - yi) * (xj - xi) > 0) inside = !inside
    }
  }
  return inside
}

// 中文名（与建图同口径的别名：中国/朝鲜/韩国；台湾并入中国）
function zhOf(id) {
  if (id === '156') return '中国'
  if (id === '408') return '朝鲜'
  if (id === '410') return '韩国'
  const rec = NAMES[id]
  return rec ? rec[0] : null
}

// 返回 { id, zh }（台湾归并为中国 156）；不在任何国家内返回 null。
export function countryAt(lon, lat) {
  if (!feats) init()
  if (lat <= -85) { const id = '010'; return { id, zh: zhOf(id) } }   // 南极数据止于约 -85°，极冠直接判南极洲
  for (let i = 0; i < feats.length; i++) {
    const g = feats[i].geometry
    if (!g) continue
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
    const bounds = latBounds[i]
    for (let p = 0; p < polys.length; p++) {
      const b = bounds[p]
      if (lat < b[0] || lat > b[1]) continue
      if (hitPolygon(polys[p], lon, lat)) {
        const id0 = String(feats[i].id)
        const id = CHINA_IDS.has(id0) ? '156' : id0
        return { id, zh: zhOf(id) }
      }
    }
  }
  return null
}

// 国家当前实际底色（设置面板取色器预填用）：按建图同款取位（首个 feature 的循环色序号）解析
export function currentLandColor(id) {
  if (!feats) init()
  return landColors(id, idxOf.has(id) ? idxOf.get(id) : 0).base
}
