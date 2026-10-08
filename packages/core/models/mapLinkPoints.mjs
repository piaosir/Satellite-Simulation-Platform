// 图上链路 · Polygon / 航迹端点的「代表点」（设计稿 docs/链路分析·航迹与Polygon节点设计_2026-10-08.md）。
// 纯 ESM、Node 可测；星座 3D 主窗（每拍几何 / 取点编辑器）与四个计算窗的「导入链路」对话框共用这一份口径。
//
// 一个 Polygon / 航迹节点在链路里落成若干个代表点（测试点，ITU AP30/30A test points 同义）：
//   Polygon（pg）：质心 c · 顶点 v · 边界等分 d（N 点）
//   航迹（tj）：  载具 veh · 航点 w · 沿迹等分 d（N 点，含起终点）
// 取点 pick 存在链路节点上（mapLinks.mjs 的 node.pick）：
//   pg: { c?: true, v?: 'all' | int[], d?: N, ds?: int[] }
//   tj: { veh?: true, w?: 'all' | id[], d?: N, ds?: int[] }
//   离散族 v / w：'all' = 全部（之后增删顶点 / 航点自动跟随）；数组 = 只取这几个（顶点按下标、航点按 id——插删航点不串位）。
//   等分族 d：点数 N（DIV_MIN…DIV_MAX）；ds = 只取其中几个（0 起序号；缺省全取；改了 N 即作废）。
// 候选点 cand = { key, fam, i, n, lat, lon, altM, tMs, sM, sel, moved? }
//   key：'c' | 'v<i>' | 'd<i>' | 'veh' | 'w:<航点 id>'（没有 id 的老航点 'w#<下标>'）——取点编辑器与图上点选按它认点；
//   fam：'c' | 'v' | 'd' | 'veh' | 'w'；i = 族内序号（顶点 / 等分 0 起；航点 = 原下标）；n = 族内总数；
//   tMs = 该点时刻（航点 / 等分点排得出才有，否则 NaN；载具 = 计算时刻）；sM = 沿迹里程（m，航迹才有）；moved = 质心落在区外、改取区内点。
//
// ── 几何口径 ──
//   Polygon 的边：本软件 2D / 3D 都按【经纬度线性】画（ConstellationMap3D 的 densifyDeg：经度取短路），不是大圆。
//     故区内判定、边界等分都沿经纬度线性的边走（画出来是哪块就是哪块）；质心 = 画出来那块区域的球面面积质心：
//     边按 ≤ DENSE_DEG 加密后用 ∫x dA = ½ Σ θᵢ·n̂ᵢ（每条小边的大圆角 × 单位法向，S2 TrueCentroid 同式）求方向，
//     跨 ±180°、高纬都成立；绕向不定，取指向顶点均值的那一侧（小于半球的多边形恒成立）。
//     凹多边形的质心可能落在区外（STK 帮助原文也承认）——落在区外时改取区内距边界最远的点（polylabel，局部等距平面里求），moved = true。
//   航迹：与载具运动同一条大圆、同一套高度剖面（trajKinematics）：航点 = trajWaypointInfo、等分点 = trajStateAtS、载具 = trajStateAt。
//   高度 altM（m）：Polygon 恒 0；航行航迹恒 0；飞行航迹按剖面（静止档 = 航点钉高 ?? 巡航高度，与 3D 画法同口径）。

import { trajStateAt, trajStateAtS, trajWaypointInfo, trajPlan, trajEndMs, makeTrajState } from './trajKinematics.mjs'

/** 一个节点最多取多少个代表点（ITU AP30/30A 每服务区至多 20 个测试点，留足余量）。 */
export const PICK_MAX = 64
/** 等分点数范围与缺省。 */
export const DIV_MIN = 2, DIV_MAX = 64, DIV_DEF = 8
/** 静止档航迹缺省取「全部航点」的上限：航点更多（导入的 ADS-B 记录）时缺省改取沿迹等分 DIV_DEF 点。 */
export const TJ_ALL_MAX = 16
/** Polygon 边加密步长（度）：质心积分与边界等分的弧长都在加密后的边上算。 */
export const DENSE_DEG = 0.25

const D2R = Math.PI / 180, R2D = 180 / Math.PI
const RE_KM = 6371.0088   // 平均地球半径（只用于弧长比例与局部平面尺度，结果不依赖它的绝对值）
const fin = Number.isFinite
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// 经度归一到 (−180, 180]
export function wrapLon(lon) {
  if (lon > -180 && lon <= 180) return lon
  let x = ((lon + 180) % 360 + 360) % 360 - 180
  if (x === -180) x = 180
  return x
}
const d180 = (d) => ((d % 360) + 540) % 360 - 180   // 经差折到 [−180, 180)
function unit(lat, lon) {
  const p = lat * D2R, l = lon * D2R, c = Math.cos(p)
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]
}
function toLL(x, y, z) {
  const h = Math.hypot(x, y)
  return { lat: Math.atan2(z, h) * R2D, lon: wrapLon(Math.atan2(y, x) * R2D) }
}
// 两点大圆角（rad）
function arcRad(lat1, lon1, lat2, lon2) {
  const a = unit(lat1, lon1), b = unit(lat2, lon2)
  const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0]
  return Math.atan2(Math.hypot(cx, cy, cz), a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
}

// ─────────────────────────────── Polygon 几何 ───────────────────────────────

/**
 * 页面 Polygon 的顶点 [[lon, lat], …] → 规整环 [{lat, lon}]（经度展开到首点 ±180° 邻域，与画法的「短路」一致）：
 * 丢坐标非有限的点、相邻重复点、末尾与首点重合的闭合点。不足 3 个顶点返回 []。
 */
export function pgRing(pts) {
  const out = []
  if (!Array.isArray(pts)) return out
  let ref = NaN
  for (const p of pts) {
    if (!Array.isArray(p) || !fin(p[0]) || !fin(p[1]) || Math.abs(p[1]) > 90) continue
    let lon = p[0]
    if (!fin(ref)) ref = lon
    else { const prev = out[out.length - 1].lon; lon = prev + d180(lon - prev) }   // 逐边取短路（与 densifyDeg 同口径）
    const q = out[out.length - 1]
    if (q && q.lat === p[1] && q.lon === lon) continue
    out.push({ lat: p[1], lon })
  }
  if (out.length > 1) { const a = out[0], b = out[out.length - 1]; if (a.lat === b.lat && Math.abs(d180(a.lon - b.lon)) < 1e-12) out.pop() }
  return out.length >= 3 ? out : []
}
// 闭合环加密：每条边（含末点 → 首点那条）按经纬度线性插值到 ≤ step 度；返回 [{lat, lon}]（经度连续展开，不回卷）
function denseRing(ring, step) {
  const out = [], n = ring.length
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n]
    const dlon = i === n - 1 ? d180(b.lon - a.lon) : b.lon - a.lon, dlat = b.lat - a.lat
    const k = Math.max(1, Math.ceil(Math.max(Math.abs(dlon), Math.abs(dlat)) / step))
    for (let j = 0; j < k; j++) out.push({ lat: a.lat + dlat * j / k, lon: a.lon + dlon * j / k })
  }
  return out
}
// 环的局部平面（等距圆柱，原点 = 经纬中值，x 按 cos(纬) 压缩，单位 km）：区内判定 / polylabel / 面积比较用
function planeOf(ring) {
  let lo = Infinity, hi = -Infinity, la = Infinity, lb = -Infinity
  for (const p of ring) { if (p.lon < lo) lo = p.lon; if (p.lon > hi) hi = p.lon; if (p.lat < la) la = p.lat; if (p.lat > lb) lb = p.lat }
  const lon0 = (lo + hi) / 2, lat0 = (la + lb) / 2, kx = Math.cos(lat0 * D2R) * D2R * RE_KM, ky = D2R * RE_KM
  const fwd = (lat, lon) => [(lon0 + d180(lon - lon0) - lon0) * kx, (lat - lat0) * ky]
  const inv = (x, y) => ({ lat: lat0 + y / ky, lon: wrapLon(lon0 + x / kx) })
  return { fwd, inv }
}
// 平面射线法（偶奇规则）
function inPoly2(xy, x, y) {
  let inside = false
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) {
    const xi = xy[i][0], yi = xy[i][1], xj = xy[j][0], yj = xy[j][1]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
/** 点 (lat, lon) 是否落在 Polygon 内（ring = pgRing 的结果；边按经纬度线性，与画法一致）。 */
export function pgContains(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3 || !fin(lat) || !fin(lon)) return false
  const ref = ring[0].lon
  const x = ref + d180(lon - ref)
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j]
    if ((a.lat > lat) !== (b.lat > lat) && x < (b.lon - a.lon) * (lat - a.lat) / (b.lat - a.lat) + a.lon) inside = !inside
  }
  return inside
}
/** 面积（km²，局部平面近似；只用于「嵌套 Polygon 取面积最小的那个」这类比较）。 */
export function pgAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return 0
  const P = planeOf(ring), xy = ring.map((p) => P.fwd(p.lat, p.lon))
  let s = 0
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += (xy[j][0] - xy[i][0]) * (xy[j][1] + xy[i][1])
  return Math.abs(s) / 2
}

// polylabel（Mapbox，区内距边界最远点）：平面多边形 xy、精度 prec（同单位）
function segDist2(px, py, a, b) {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y
  if (dx !== 0 || dy !== 0) {
    const t = ((px - x) * dx + (py - y) * dy) / (dx * dx + dy * dy)
    if (t > 1) { x = b[0]; y = b[1] } else if (t > 0) { x += dx * t; y += dy * t }
  }
  dx = px - x; dy = py - y
  return dx * dx + dy * dy
}
function signedDist(xy, x, y) {
  let m = Infinity
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const d = segDist2(x, y, xy[i], xy[j]); if (d < m) m = d }
  return (inPoly2(xy, x, y) ? 1 : -1) * Math.sqrt(m)
}
function polylabel(xy, prec) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of xy) { if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1] }
  const w = x1 - x0, h = y1 - y0, size = Math.min(w, h)
  if (!(size > 0)) return [x0, y0]
  const cell = (x, y, hh) => { const d = signedDist(xy, x, y); return { x, y, h: hh, d, max: d + hh * Math.SQRT2 } }
  // 最大堆（按 max）
  const heap = []
  const push = (c) => { heap.push(c); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p].max >= heap[i].max) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p } }
  const pop = () => {
    const top = heap[0], last = heap.pop()
    if (heap.length) {
      heap[0] = last
      let i = 0
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l].max > heap[m].max) m = l; if (r < heap.length && heap[r].max > heap[m].max) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m }
    }
    return top
  }
  const hh = size / 2
  for (let x = x0; x < x1; x += size) for (let y = y0; y < y1; y += size) push(cell(x + hh, y + hh, hh))
  let best = cell(x0 + w / 2, y0 + h / 2, 0)
  let guard = 0
  while (heap.length && guard++ < 20000) {
    const c = pop()
    if (c.d > best.d) best = c
    if (c.max - best.d <= prec) continue
    const q = c.h / 2
    push(cell(c.x - q, c.y - q, q)); push(cell(c.x + q, c.y - q, q)); push(cell(c.x - q, c.y + q, q)); push(cell(c.x + q, c.y + q, q))
  }
  return [best.x, best.y]
}

/**
 * Polygon 质心：{ lat, lon, moved } | null（不足 3 个顶点）。
 * 画出来那块区域的球面面积质心；落在区外（凹多边形）时改取区内距边界最远的点，moved = true。
 */
export function pgCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null
  const dense = denseRing(ring, DENSE_DEG)
  const V = dense.map((p) => unit(p.lat, p.lon))
  let gx = 0, gy = 0, gz = 0, mx = 0, my = 0, mz = 0
  for (let i = 0; i < V.length; i++) {
    const a = V[i], b = V[(i + 1) % V.length]
    mx += a[0]; my += a[1]; mz += a[2]
    const cx = a[1] * b[2] - a[2] * b[1], cy = a[2] * b[0] - a[0] * b[2], cz = a[0] * b[1] - a[1] * b[0]
    const s = Math.hypot(cx, cy, cz)
    if (!(s > 1e-15)) continue
    const th = Math.atan2(s, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])
    gx += cx / s * th; gy += cy / s * th; gz += cz / s * th
  }
  if (gx * mx + gy * my + gz * mz < 0) { gx = -gx; gy = -gy; gz = -gz }   // 绕向不定：取指向顶点均值的那一侧
  const g = Math.hypot(gx, gy, gz) > 1e-12 ? toLL(gx, gy, gz) : toLL(mx, my, mz)
  if (pgContains(ring, g.lat, g.lon)) return { lat: g.lat, lon: g.lon, moved: false }
  const P = planeOf(ring), xy = dense.map((p) => P.fwd(p.lat, p.lon))
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
  for (const p of xy) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1] }
  const q = polylabel(xy, Math.max(1e-3, Math.max(x1 - x0, y1 - y0) / 1000))
  const r = P.inv(q[0], q[1])
  return { lat: r.lat, lon: r.lon, moved: true }
}

/**
 * 边界等分：沿闭合边界（经纬度线性的边）按弧长 n 等分，从顶点 1 起，[{lat, lon}]（经度归一到 (−180, 180]）。
 */
export function pgBoundaryDiv(ring, n) {
  const N = Math.round(Number(n))
  if (!Array.isArray(ring) || ring.length < 3 || !(N >= 1)) return []
  const dense = denseRing(ring, DENSE_DEG / 2)
  const m = dense.length, cum = new Float64Array(m + 1)
  for (let i = 0; i < m; i++) { const a = dense[i], b = dense[(i + 1) % m]; cum[i + 1] = cum[i] + arcRad(a.lat, a.lon, b.lat, b.lon) }
  const total = cum[m]
  if (!(total > 0)) return [{ lat: ring[0].lat, lon: wrapLon(ring[0].lon) }]
  const out = []
  let k = 0
  for (let j = 0; j < N; j++) {
    const t = total * j / N
    while (k < m - 1 && cum[k + 1] <= t) k++
    const a = dense[k], b = k + 1 < m ? dense[k + 1] : dense[0], seg = cum[k + 1] - cum[k]
    const f = seg > 0 ? (t - cum[k]) / seg : 0
    const blon = k + 1 < m ? b.lon : a.lon + d180(b.lon - a.lon)
    out.push({ lat: a.lat + (b.lat - a.lat) * f, lon: wrapLon(a.lon + (blon - a.lon) * f) })
  }
  return out
}

// ─────────────────────────────── 取点（pick）规范化 / 缺省 ───────────────────────────────

const clampDiv = (v) => { const n = Math.round(Number(v)); return fin(n) && n >= DIV_MIN ? Math.min(DIV_MAX, n) : 0 }
function uniqInts(arr, lim) {
  const out = [], seen = new Set()
  for (const x of arr) { if (!Number.isInteger(x) || x < 0 || (lim != null && x >= lim) || seen.has(x)) continue; seen.add(x); out.push(x) }
  return out.sort((a, b) => a - b)
}
function uniqIds(arr) {
  const out = [], seen = new Set()
  for (const x of arr) { const s = typeof x === 'string' || typeof x === 'number' ? String(x).slice(0, 80) : ''; if (!s || seen.has(s)) continue; seen.add(s); out.push(s) }
  return out
}
/**
 * 规范化取点（存档 / 主进程前）：kind = 'pg' | 'tj'；坏字段丢掉，返回新对象（可能为空对象 = 一个点都没取）；
 * 不是对象返回 null（调用方按缺省取点）。
 */
export function normPick(kind, p) {
  if (!isObj(p)) return null
  const o = {}
  if (kind === 'pg') {
    if (p.c === true) o.c = true
    if (p.v === 'all') o.v = 'all'
    else if (Array.isArray(p.v)) { const v = uniqInts(p.v.slice(0, 20000)); if (v.length) o.v = v }
  } else if (kind === 'tj') {
    if (p.veh === true) o.veh = true
    if (p.w === 'all') o.w = 'all'
    else if (Array.isArray(p.w)) { const w = uniqIds(p.w.slice(0, 20000)); if (w.length) o.w = w }
  } else return null
  const d = clampDiv(p.d)
  if (d) {
    o.d = d
    if (Array.isArray(p.ds)) { const ds = uniqInts(p.ds, d); if (ds.length && ds.length < d) o.ds = ds }
  }
  return o
}
/** 航迹的有效航点（坐标有限）个数 */
function tjValidN(t) {
  const pts = t && Array.isArray(t.pts) ? t.pts : []
  let n = 0
  for (const p of pts) if (p && fin(p.lat) && fin(p.lon)) n++
  return n
}
/**
 * 缺省取点（新建节点时写进节点）：Polygon = 质心；航迹 = 运动档取载具，静止档航点 ≤ TJ_ALL_MAX 取全部航点、否则沿迹等分 DIV_DEF 点。
 */
export function defaultPick(kind, obj) {
  if (kind === 'pg') return { c: true }
  if (kind === 'tj') {
    if (obj && fin(trajEndMs(obj))) return { veh: true }
    return tjValidN(obj) <= TJ_ALL_MAX ? { w: 'all' } : { d: DIV_DEF }
  }
  return {}
}
const pickOf = (kind, obj, pick) => normPick(kind, pick) || defaultPick(kind, obj)

// ─────────────────────────────── 候选点 ───────────────────────────────

const wpKey = (p, i) => (p && p.id != null && String(p.id) !== '' ? 'w:' + String(p.id) : 'w#' + i)
// 航点键 → 取点表里存的成员（有 id 存 id，没有 id 的老航点存 'w#<下标>' 原样）
const wpMember = (key) => (key.startsWith('w:') ? key.slice(2) : key)
// 航迹沿迹里程 s（m）处的时刻：航点时刻（排程 / 起始 + 匀速）之间按里程线性插值（段内匀速，同 trajKinematics 的 tAtS）；排不出 NaN
function tAtSOf(wps, s) {
  let prev = null
  for (const w of wps) {
    if (!w || !fin(w.tMs)) continue
    if (w.sM >= s) {
      if (!prev || !(w.sM > prev.sM)) return w.tMs
      return prev.tMs + (w.tMs - prev.tMs) * (s - prev.sM) / (w.sM - prev.sM)
    }
    prev = w
  }
  return prev && Math.abs(prev.sM - s) < 1e-6 ? prev.tMs : NaN
}

/**
 * Polygon 的全部候选点（取点编辑器 / 图上点选用）：质心（恒 1 个）、顶点（全部）、边界等分（取了等分族才有）；sel = 是否取了。
 * pg = 页面 Polygon 对象（pts:[[lon, lat], …]）；ring 可传 pgRing(pg.pts) 的缓存结果。
 */
export function pgCands(pg, pick, ring) {
  const r = ring || pgRing(pg && pg.pts)
  const out = []
  if (r.length < 3) return out
  const pk = pickOf('pg', pg, pick)
  const c = pgCentroid(r)
  if (c) out.push({ key: 'c', fam: 'c', i: 0, n: 1, lat: c.lat, lon: c.lon, altM: 0, tMs: NaN, sM: NaN, sel: pk.c === true, moved: c.moved })
  const vs = pk.v === 'all' ? null : new Set(Array.isArray(pk.v) ? pk.v : [])
  r.forEach((p, i) => out.push({ key: 'v' + i, fam: 'v', i, n: r.length, lat: p.lat, lon: wrapLon(p.lon), altM: 0, tMs: NaN, sM: NaN, sel: pk.v === 'all' || (!!vs && vs.has(i)) }))
  if (pk.d) {
    const ds = Array.isArray(pk.ds) ? new Set(pk.ds) : null
    pgBoundaryDiv(r, pk.d).forEach((p, i) => out.push({ key: 'd' + i, fam: 'd', i, n: pk.d, lat: p.lat, lon: p.lon, altM: 0, tMs: NaN, sM: NaN, sel: !ds || ds.has(i) }))
  }
  return out
}

/**
 * 航迹载具这个候选点（tMs 时刻的载具位置与实际高度；与图上载具同位）| null（没有有效航点）。sel = 取了载具。
 * 唯一随时刻变的代表点：页面把航点 / 等分点按内容缓存，只有它逐拍现算。
 */
export function tjVehicleCand(traj, pick, tMs, st) {
  if (!tjValidN(traj)) return null
  const pk = pickOf('tj', traj, pick)
  const s = trajStateAt(traj, tMs, st || makeTrajState())
  if (!s.ok) return null
  return { key: 'veh', fam: 'veh', i: 0, n: 1, lat: s.lat, lon: wrapLon(s.lon), altM: fin(s.altM) ? s.altM : 0, tMs: fin(tMs) ? tMs : NaN, sM: s.s, sel: pk.veh === true, moving: !!s.moving }
}
/**
 * 航迹的全部候选点：载具（tMs 时刻；恒 1 个）、航点（全部有效航点）、沿迹等分（取了等分族才有）；sel = 是否取了。
 * wps 可传 trajWaypointInfo(traj) 的缓存结果（与 traj.pts 等长）。opts.noVeh = 不算载具（页面缓存不随时刻变的那部分时用）。
 */
export function tjCands(traj, pick, tMs, wps, opts) {
  const out = []
  const pts = traj && Array.isArray(traj.pts) ? traj.pts : []
  if (!tjValidN(traj)) return out
  const pk = pickOf('tj', traj, pick)
  const info = wps || trajWaypointInfo(traj)
  if (!(opts && opts.noVeh)) { const v = tjVehicleCand(traj, pk, tMs); if (v) out.push(v) }
  const wsel = pk.w === 'all' ? null : new Set(Array.isArray(pk.w) ? pk.w : [])
  let nw = 0
  for (let i = 0; i < pts.length; i++) if (info[i]) nw++
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], w = info[i]
    if (!w) continue
    const key = wpKey(p, i)
    out.push({ key, fam: 'w', i, n: nw, lat: p.lat, lon: wrapLon(p.lon), altM: fin(w.altM) ? w.altM : 0, tMs: fin(w.tMs) ? w.tMs : NaN, sM: w.sM, sel: pk.w === 'all' || (!!wsel && wsel.has(wpMember(key))) })
  }
  if (pk.d) {
    const L = trajPlan(traj).L
    const ds = Array.isArray(pk.ds) ? new Set(pk.ds) : null
    const st = makeTrajState()
    const wl = info.filter(Boolean)
    for (let k = 0; k < pk.d; k++) {
      const s = L > 0 ? L * k / (pk.d - 1) : 0
      trajStateAtS(traj, s, st)
      if (!st.ok) continue
      out.push({ key: 'd' + k, fam: 'd', i: k, n: pk.d, lat: st.lat, lon: wrapLon(st.lon), altM: fin(st.altM) ? st.altM : 0, tMs: tAtSOf(wl, s), sM: s, sel: !ds || ds.has(k) })
      if (!(L > 0)) break   // 全程零长：只有一个点
    }
  }
  return out
}

/** 节点的全部候选点：kind = 'pg' | 'tj'；obj = Polygon / 航迹对象；cache = { ring?, wps? } 可传缓存；opts 同 tjCands。 */
export function nodeCands(kind, obj, pick, tMs, cache, opts) {
  if (!obj) return []
  if (kind === 'pg') return pgCands(obj, pick, cache && cache.ring)
  if (kind === 'tj') return tjCands(obj, pick, tMs, cache && cache.wps, opts)
  return []
}
/** 节点取到的代表点（候选点里 sel 的那些，次序 = 族序：质心 / 载具 → 顶点 / 航点 → 等分）。 */
export function nodePoints(kind, obj, pick, tMs, cache) {
  return nodeCands(kind, obj, pick, tMs, cache).filter((c) => c.sel)
}

/**
 * 取到几个点（不求位置，校验 / 支路计数用）：顶点下标越界、航点 id 已删的不算；
 * 航迹的载具、Polygon 的质心只要对象几何有效就算 1 个。
 */
export function pickCount(kind, obj, pick) {
  if (!obj) return 0
  const pk = pickOf(kind, obj, pick)
  let n = 0
  if (kind === 'pg') {
    const nv = pgRing(obj.pts).length
    if (nv < 3) return 0
    if (pk.c) n++
    if (pk.v === 'all') n += nv
    else if (Array.isArray(pk.v)) for (const i of pk.v) if (i < nv) n++
  } else if (kind === 'tj') {
    const pts = Array.isArray(obj.pts) ? obj.pts : []
    const nw = tjValidN(obj)
    if (!nw) return 0
    if (pk.veh) n++
    if (pk.w === 'all') n += nw
    else if (Array.isArray(pk.w)) {
      const want = new Set(pk.w)
      pts.forEach((p, i) => { if (p && fin(p.lat) && fin(p.lon) && want.has(wpMember(wpKey(p, i)))) n++ })
    }
  } else return 0
  if (pk.d) n += Array.isArray(pk.ds) ? pk.ds.length : (kind === 'tj' && !(trajPlan(obj).L > 0) ? 1 : pk.d)
  return n
}

// ─────────────────────────────── 取舍 ───────────────────────────────

// 离散族成员表：Polygon 顶点下标 / 航点键（'w:<id>' 去前缀 = id；没有 id 的老航点用 'w#<下标>' 原样）
function famMembers(kind, obj) {
  if (kind === 'pg') return pgRing(obj && obj.pts).map((_, i) => i)
  const pts = obj && Array.isArray(obj.pts) ? obj.pts : []
  const out = []
  pts.forEach((p, i) => { if (p && fin(p.lat) && fin(p.lon)) out.push(wpMember(wpKey(p, i))) })
  return out
}
const famKey = (kind) => (kind === 'pg' ? 'v' : 'w')
const oneKey = (kind) => (kind === 'pg' ? 'c' : 'veh')

/**
 * 逐点取 / 舍（取点编辑器的行、图上点选共用）：返回新的取点。
 *   单点族（质心 / 载具）：翻转；离散族：'all' 舍一个 → 余下的数组，数组取满 → 'all'，舍空 → 整族去掉；
 *   等分族：缺省全取 → 舍一个变 ds，ds 取满 → 去掉 ds，舍空 → 整族去掉。
 */
export function pickToggle(kind, obj, pick, key) {
  const pk = { ...pickOf(kind, obj, pick) }
  if (key === oneKey(kind)) { if (pk[key]) delete pk[key]; else pk[key] = true; return pk }
  const fk = famKey(kind)
  if ((kind === 'pg' && /^v\d+$/.test(key)) || (kind === 'tj' && (key.startsWith('w:') || key.startsWith('w#')))) {
    const all = famMembers(kind, obj)
    const m = kind === 'pg' ? Number(key.slice(1)) : wpMember(key)
    const cur = pk[fk] === 'all' ? all.slice() : (Array.isArray(pk[fk]) ? pk[fk].filter((x) => all.includes(x)) : [])
    const i = cur.indexOf(m)
    if (i >= 0) cur.splice(i, 1); else if (all.includes(m)) cur.push(m)
    if (!cur.length) delete pk[fk]
    else if (cur.length === all.length) pk[fk] = 'all'
    else pk[fk] = kind === 'pg' ? cur.sort((a, b) => a - b) : all.filter((x) => cur.includes(x))
    return pk
  }
  if (/^d\d+$/.test(key) && pk.d) {
    const k = Number(key.slice(1))
    if (!(k < pk.d)) return pk
    const cur = Array.isArray(pk.ds) ? pk.ds.slice() : Array.from({ length: pk.d }, (_, i) => i)
    const i = cur.indexOf(k)
    if (i >= 0) cur.splice(i, 1); else cur.push(k)
    if (!cur.length) { delete pk.d; delete pk.ds } else if (cur.length >= pk.d) delete pk.ds; else pk.ds = cur.sort((a, b) => a - b)
    return pk
  }
  return pk
}
/**
 * 整族取 / 舍：fam = 'c' | 'veh' | 'v' | 'w' | 'd'；on = 取（离散族 → 'all'，等分族 → n 点，缺省 DIV_DEF）/ 舍（整族去掉）。
 */
export function pickFamily(kind, obj, pick, fam, on, n) {
  const pk = { ...pickOf(kind, obj, pick) }
  if (fam === oneKey(kind)) { if (on) pk[fam] = true; else delete pk[fam]; return pk }
  if (fam === famKey(kind)) { if (on) pk[fam] = 'all'; else delete pk[fam]; return pk }
  if (fam === 'd') {
    if (on) { pk.d = clampDiv(n) || pk.d || DIV_DEF; delete pk.ds } else { delete pk.d; delete pk.ds }
    return pk
  }
  return pk
}
/** 改等分点数（逐点取舍随之作废，回到全取）；n 越界夹到 [DIV_MIN, DIV_MAX]。 */
export function pickSetDiv(kind, obj, pick, n) {
  const pk = { ...pickOf(kind, obj, pick) }
  const v = Math.round(Number(n))
  if (!fin(v)) return pk
  pk.d = Math.max(DIV_MIN, Math.min(DIV_MAX, v))
  delete pk.ds
  return pk
}
/** 某族取了几个 / 共几个：{ on, k, n }（摘要与族开关用）。 */
export function pickFamStat(kind, obj, pick, fam) {
  const pk = pickOf(kind, obj, pick)
  if (fam === oneKey(kind)) return { on: pk[fam] === true, k: pk[fam] === true ? 1 : 0, n: 1 }
  if (fam === famKey(kind)) {
    const all = famMembers(kind, obj), n = all.length
    if (pk[fam] === 'all') return { on: true, k: n, n }
    const k = Array.isArray(pk[fam]) ? pk[fam].filter((x) => all.includes(x)).length : 0
    return { on: k > 0, k, n }
  }
  if (fam === 'd') {
    if (!pk.d) return { on: false, k: 0, n: 0 }
    return { on: true, k: Array.isArray(pk.ds) ? pk.ds.length : pk.d, n: pk.d }
  }
  return { on: false, k: 0, n: 0 }
}
