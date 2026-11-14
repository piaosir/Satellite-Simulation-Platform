// 从当前渲染层拾取覆盖对象。只认实际可见的线、填充和中心；不把未填色的整个轮廓内部当成对象。
// 经纬度预筛后才投影线段，避免悬停时将几十万条等值线全部投到屏幕上。
import { buildMeshIndices } from '../viz/flatmap/glField.js'
const wrap = (x) => ((x + 180) % 360 + 360) % 360 - 180
const geometryCache = new WeakMap()
const segmentCache = new WeakMap()
const positive = (v, fallback = 1) => (v == null ? fallback : Number(v)) > 0

// 连续线段按小块缓存包围盒。悬停只展开光标附近的块，避免每 40 ms 遍历整幅等值线。
// 跨日期线的块保守保留全部经度；几何数组换掉时 WeakMap 自动失效。
function segmentBlocks(segs) {
  let blocks = segmentCache.get(segs)
  if (blocks) return blocks
  blocks = []
  for (let start = 0; start < segs.length; start += 64) {
    const end = Math.min(start + 64, segs.length)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, crosses = false
    for (let i = start; i < end; i++) {
      const [a, b] = segs[i], ax = wrap(a[0]), bx = wrap(b[0])
      if (Math.abs(ax - bx) > 180) crosses = true
      minX = Math.min(minX, ax, bx); maxX = Math.max(maxX, ax, bx)
      minY = Math.min(minY, a[1], b[1]); maxY = Math.max(maxY, a[1], b[1])
    }
    blocks.push({ start, end, minX: crosses ? -180 : minX, maxX: crosses ? 180 : maxX, minY, maxY })
  }
  segmentCache.set(segs, blocks)
  return blocks
}

function nearBlock(block, ll, dx, dy) {
  if (block.minY > ll.lat + dy || block.maxY < ll.lat - dy) return false
  const lon = wrap(ll.lon)
  return [lon - 360, lon, lon + 360].some((x) => block.minX <= x + dx && block.maxX >= x - dx)
}

function polygon(verts, start, count) {
  const x0 = verts[start], points = []
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < count; i++) {
    const x = x0 + wrap(verts[start + i * 2] - x0), y = verts[start + i * 2 + 1]
    points.push([x, y]); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
  }
  return { points, x0, minX, maxX, minY, maxY }
}
function contains(p, ll) {
  const x = p.x0 + wrap(ll.lon - p.x0), y = ll.lat
  if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) return false
  let inside = false
  const a = p.points
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, yi] = a[i], [xj, yj] = a[j]
    if ((yi > y) !== (yj > y) && x <= (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
function fillGeometry(band) {
  let ps = geometryCache.get(band)
  if (ps) return ps
  ps = []; let start = 0
  for (const count of band.counts || []) { ps.push(polygon(band.verts, start, count)); start += count * 2 }
  geometryCache.set(band, ps)
  return ps
}
function segmentDistance(x, y, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy
  const t = d2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / d2)) : 0
  return Math.hypot(x - a.x - t * dx, y - a.y - t * dy)
}

/** 链路使用当前提交给渲染器的可见线段，端点 / 标记的优先级由宿主处理。 */
export function pickLinkGeometry(layers, view, flat, x, y, radius = 7) {
  if (!layers || !layers.length || !view || !view.screenOfLL) return null
  let best = null, distance = radius
  const project = (p) => Array.isArray(p) ? view.screenOfLL(p[1], p[0], 0) : view.screenOfLL(p.lat, p.lon, p.altKm || 0)
  for (let i = layers.length - 1; i >= 0; i--) for (const hop of layers[i].hops || []) {
    const points = flat ? hop.pts || [] : [hop.a, hop.b].filter(Boolean)
    let previous = null
    for (const point of points) {
      const p = project(point)
      if (p && previous && (!flat || Math.abs(p.x - previous.x) < (view.pickWidth || Infinity) / 2)) {
        const d = segmentDistance(x, y, previous, p)
        if (d < distance) { distance = d; best = layers[i].id }
      }
      previous = p
    }
  }
  return best
}

// GPU 填充没有 fillBands；按同一网格的三角形插值取档，不能因此让 2D 的填充无法点选。
function meshContains(mesh, ll) {
  const { NX, NY, lonU, lat, db, levels, alphas, satN } = mesh
  if (satN) {
    const phi = ll.lat * Math.PI / 180, lam = ll.lon * Math.PI / 180, e2 = mesh.e2 || 0
    const n = 1 / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
    if (n * (Math.cos(phi) * Math.cos(lam) * satN[0] + Math.cos(phi) * Math.sin(lam) * satN[1] + Math.sqrt(1 - e2) * Math.sin(phi) * satN[2]) < 1) return false
  }
  let geometry = geometryCache.get(mesh)
  if (!geometry) {
    // 直接用渲染器的三角化，包含地平附近的交点细化；按几何身份缓存，悬停不再三角化。
    const { idx, extra } = buildMeshIndices(mesh), r0 = mesh.box ? mesh.box.r0 : 0, r1 = mesh.box ? Math.min(mesh.box.r1, NY - 1) : NY - 1
    const length = (r1 - r0 + 1) * NX
    const vertex = (i, out) => {
      if (i < length) { const k = i + r0 * NX; out[0] = lonU[k]; out[1] = lat[k]; out[2] = db[k] }
      else { const k = i - length; out[0] = extra.lon[k]; out[1] = extra.lat[k]; out[2] = extra.db[k] }
      return out
    }
    // 五度空间桶只存三角形下标；不为百万个网格三角形复制点列和对象。
    const bins = new Map(), a = [], b = [], c = []
    for (let i = 0; i < idx.length; i += 3) {
      vertex(idx[i], a); vertex(idx[i + 1], b); vertex(idx[i + 2], c)
      const bx = a[0] + wrap(b[0] - a[0]), cx = a[0] + wrap(c[0] - a[0])
      const x0 = Math.floor((Math.min(a[0], bx, cx) + 180) / 5), x1 = Math.floor((Math.max(a[0], bx, cx) + 180) / 5)
      const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) + 90) / 5)), y1 = Math.min(35, Math.floor((Math.max(a[1], b[1], c[1]) + 90) / 5))
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const key = y * 72 + ((x % 72) + 72) % 72
        if (!bins.has(key)) bins.set(key, [])
        bins.get(key).push(i)
      }
    }
    geometry = { bins, idx, vertex }; geometryCache.set(mesh, geometry)
  }
  const bin = Math.min(35, Math.max(0, Math.floor((ll.lat + 90) / 5))) * 72 + Math.floor((wrap(ll.lon) + 180) / 5)
  const a = [], b = [], c = []
  for (const i of geometry.bins.get(bin) || []) {
    geometry.vertex(geometry.idx[i], a); geometry.vertex(geometry.idx[i + 1], b); geometry.vertex(geometry.idx[i + 2], c)
    b[0] = a[0] + wrap(b[0] - a[0]); c[0] = a[0] + wrap(c[0] - a[0])
    const x = a[0] + wrap(ll.lon - a[0]), y = ll.lat
    if (x < Math.min(a[0], b[0], c[0]) || x > Math.max(a[0], b[0], c[0]) || y < Math.min(a[1], b[1], c[1]) || y > Math.max(a[1], b[1], c[1])) continue
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if (Math.abs(den) < 1e-12) continue
    const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den
    const v0 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den, w = 1 - u - v0
    if (u < -1e-9 || v0 < -1e-9 || w < -1e-9) continue
    const value = u * a[2] + v0 * b[2] + w * c[2]
    for (let i = levels.length - 1; i >= 0; i--) if (value >= levels[i]) return positive(alphas && alphas[i])
  }
  return false
}

/** entries 按由下到上的绘制顺序；view 使用 client 坐标，screenOfLL 会剔除地球背面。 */
export function pickCoverageLayer(entries, view, x, y, radius = 7) {
  if (!entries || !entries.length || !view || !view.lonLatAt || !view.screenOfLL) return null
  const ll = view.lonLatAt(x, y)
  if (!ll) return null
  let dx = 0, dy = 0, spanReady = false
  const ensureSpan = () => {
    if (spanReady) return
    spanReady = true
    const nearby = [[x - radius, y], [x + radius, y], [x, y - radius], [x, y + radius]].map(([a, b]) => view.lonLatAt(a, b)).filter(Boolean)
    dx = Math.max(0.01, ...nearby.map((p) => Math.abs(wrap(p.lon - ll.lon)))) * 2
    dy = Math.max(0.01, ...nearby.map((p) => Math.abs(p.lat - ll.lat))) * 2
  }
  let fill = null, nearest = null, distance = radius
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i], L = entry.layer, o = entry.options || {}
    if (!L) continue
    if (L.bore && L.bore.onEarth !== false && (o.showBore || o.showName || o.showPeak)) {
      const p = view.screenOfLL(L.bore.lat, L.bore.lon, 0)
      const d = p ? Math.hypot(p.x - x, p.y - y) : Infinity
      if (d < distance) { distance = d; nearest = entry }
    }
    for (const g of L.segGroups || []) {
      if (!positive(g.opacity, L.lineAlpha ?? o.lineAlpha ?? 1)) continue
      const segs = g.segs || []
      if (!segs.length) continue
      ensureSpan()
      for (const block of segmentBlocks(segs)) {
        if (!nearBlock(block, ll, dx, dy)) continue
        for (let si = block.start; si < block.end; si++) {
          const [a, b] = segs[si]
          const ax = wrap(a[0] - ll.lon), bx = ax + wrap(b[0] - a[0])
          if (Math.min(ax, bx) > dx || Math.max(ax, bx) < -dx || Math.min(a[1], b[1]) > ll.lat + dy || Math.max(a[1], b[1]) < ll.lat - dy) continue
          const p = view.screenOfLL(a[1], a[0], 0), q = view.screenOfLL(b[1], b[0], 0)
          // 投影切口两侧不能连出一条横穿全屏的假线。
          if (!p || !q || Math.hypot(p.x - q.x, p.y - q.y) > (view.pickWidth || Infinity) / 2) continue
          const d = segmentDistance(x, y, p, q)
          if (d < distance) { distance = d; nearest = entry }
        }
      }
    }
    if (!fill && positive(L.alpha, o.alpha ?? 0.78)) {
      for (const band of L.fillBands || []) {
        if (positive(band.alpha) && fillGeometry(band).some((p) => contains(p, ll))) { fill = entry; break }
      }
      if (!fill && L.fieldMesh && meshContains(L.fieldMesh, ll)) fill = entry
    }
  }
  return nearest || fill
}

