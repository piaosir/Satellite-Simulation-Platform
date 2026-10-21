// 时区图层的核心（与渲染器无关，Node 可单测）：解码时区面拓扑 → 按当前视角求每面时区 → 按仿真时刻算偏移 →
// 出界线 / 连通区 / 色块分组 / 标注锚点 / 光标命中。2D 平面图与 3D 球体共用这一份结果。
//
// 数据：./tz/tz-{10m,50m,110m}.json（scripts/build-timezones.mjs 生成）。量化网格与同档底图逐位相同，
// 时区界里与国界重合的那几段坐标与底图弧逐点相等 —— 画在国界上严丝合缝，不出双线。
//
// 口径（任务书 §2）：
//   · 面三类：陆地 l（u 基础单元、d 争议叠加、z 事实时区、t 候选归属 → 时区）/ 海区 s（o 固定偏移，无夏令时）/
//     内陆水域 w（不填、不画界、读数不给值）。
//   · 陆地时区 = t[归属] ?? z，归属走主权解算层 ownerOf —— 本文件不认识任何具体国家（中国按北京时间、
//     台港澳用各自时区这些规则全在构建出来的 t 表里）。
//   · 一条弧两侧偏移不同才画；相差 ≥ 12 h 归日界线类。岸线（陆 / 海之间）不算时区界。
import { ownerOf } from './povResolver.js'
import { zoneOffset, offsetAt, zoneName } from './tzRules.js'

export const IDL_MIN = 720   // 两侧偏移相差 ≥ 12 h 的边归日界线类

const bundles = {}

// 档数据懒加载。★ 字面量 import()（Vite 才能各打一个 chunk），且不带 with { type: 'json' }（dev 期会被拒）
export async function ensureTzDetail(detail) {
  if (bundles[detail]) return bundles[detail]
  const mod = detail === '110m' ? await import('./tz/tz-110m.json')
    : detail === '50m' ? await import('./tz/tz-50m.json')
      : await import('./tz/tz-10m.json')
  return registerTzDetail(detail, mod.default || mod)
}
// Node 侧（单测 / 构建自检）：自己 fs 读进来再注入
export function registerTzDetail(detail, topo) { bundles[detail] = prep(detail, topo); return bundles[detail] }
export const tzBundle = (detail) => bundles[detail] || null

function prep(detail, topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate
  const arcs = topo.arcs.map((a) => {
    const out = new Array(a.length)
    let x = 0, y = 0
    for (let i = 0; i < a.length; i++) { x += a[i][0]; y += a[i][1]; out[i] = [x * sx + tx, y * sy + ty] }
    return out
  })
  const G = topo.objects.faces.geometries
  const faces = G.map((g) => {
    const p = g.properties || {}
    const polys = g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []
    let x0 = 180, x1 = -180, y0 = 90, y1 = -90
    for (const poly of polys) for (const ai of poly[0]) for (const pt of arcs[ai < 0 ? ~ai : ai]) {
      if (pt[0] < x0) x0 = pt[0]; if (pt[0] > x1) x1 = pt[0]; if (pt[1] < y0) y0 = pt[1]; if (pt[1] > y1) y1 = pt[1]
    }
    return {
      k: p.k || 'w', u: p.u || null, d: p.d || null, z: Number.isInteger(p.z) ? p.z : -1, t: p.t || null,
      o: Number.isFinite(p.o) ? p.o : 0, a: p.a || null, polys, box: [x0, y0, x1, y1], rings: null
    }
  })
  const adj = []
  for (const k in (topo.adj || {})) adj.push([+k, topo.adj[k][0], topo.adj[k].length > 1 ? topo.adj[k][1] : -1])
  // 跨 180° 经线的相邻（构建期按纬度段配对的图边）：补成沿 180° 的边，与普通弧一视同仁
  for (const [ya, yb, fe, fw] of (topo.seam || [])) {
    const ai = arcs.length
    arcs.push([[180, ya], [180, yb]])
    adj.push([ai, fe, fw])
  }
  return { detail, arcs, faces, adj, grid: null, meta: topo.meta || {} }
}

// 面的经纬环（[[外环, 洞…], …]，每环 [[lon,lat]…]）—— 懒解，填色 / 三角化 / 命中都用它
export function faceRings(B, i) {
  const f = B.faces[i]
  if (f.rings) return f.rings
  const ring = (ids) => {
    const out = []
    ids.forEach((ai, k) => {
      const seg = ai >= 0 ? B.arcs[ai] : B.arcs[~ai].slice().reverse()
      for (let j = k === 0 ? 0 : 1; j < seg.length; j++) out.push(seg[j])
    })
    return out
  }
  f.rings = f.polys.map((poly) => poly.map(ring))
  return f.rings
}

// ---------------------------------------------------------------- 归属 → 时区
// 返回 Int32Array（陆地面 = 规则表时区号；海区 / 水域 = −1）。视角一变要重解。
export function resolveZones(B) {
  const n = B.faces.length
  const out = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    const f = B.faces[i]
    if (f.k !== 'l') continue
    const unit = f.d || f.u
    const own = unit ? ownerOf(unit, B.detail) : null
    const z = f.t && own && f.t[own] != null ? f.t[own] : f.z
    out[i] = z
  }
  return out
}

// 各面在 ms 时刻的偏移（分钟）。civil = 民用时（含夏令时）；否则标准时。水域为 NaN。
export function faceOffsets(B, zones, ms, civil, out) {
  const n = B.faces.length
  const r = out && out.length === n ? out : new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const f = B.faces[i]
    if (f.k === 's') r[i] = f.o
    else if (f.k === 'l' && zones[i] >= 0) r[i] = zoneOffset(zones[i], ms, civil)
    else r[i] = NaN
  }
  return r
}
// 夏令时标记（光标读数 / 标注用）
export const faceDst = (zone, ms) => (zone >= 0 ? offsetAt(zone, ms).dst : 0)

// 偏移签名：没变就不必重建几何
export function offsetsSig(offs) {
  let h = 2166136261
  for (let i = 0; i < offs.length; i++) { const v = Number.isNaN(offs[i]) ? 99999 : Math.round(offs[i] * 4); h = Math.imul(h ^ v, 16777619) }
  return h >>> 0
}

// ---------------------------------------------------------------- 界线
// { land: [折线], sea: [折线], idl: [折线] }；折线 = [[lon,lat]…]。
// 陆上时区界与海上航海带分界分两类（样式不同：陆上暖褐、海上更细更浅），两侧相差 ≥ 12 h 的归日界线类。
// 陆 / 海之间（岸线）不画；水域两侧不画。
export function boundaryLines(B, offs) {
  const land = [], sea = [], idl = []
  for (const [ai, a, b] of B.adj) {
    if (a < 0 || b < 0) continue
    const fa = B.faces[a], fb = B.faces[b]
    if (fa.k === 'w' || fb.k === 'w' || fa.k !== fb.k) continue
    const d = Math.abs(offs[a] - offs[b])
    if (!(d > 0)) continue
    if (d >= IDL_MIN) idl.push(B.arcs[ai])
    else (fa.k === 'l' ? land : sea).push(B.arcs[ai])
  }
  return { land, sea, idl }
}

// ---------------------------------------------------------------- 连通区（同偏移、同类的面）
// 返回 { comp: Int32Array(面 → 区号, 水域 −1), list: [{ off, k, faces, anchor:[lon,lat,r], face }] }
export function components(B, offs) {
  const n = B.faces.length
  const par = new Int32Array(n)
  for (let i = 0; i < n; i++) par[i] = i
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  for (const [, a, b] of B.adj) {
    if (a < 0 || b < 0) continue
    const fa = B.faces[a], fb = B.faces[b]
    if (fa.k === 'w' || fa.k !== fb.k || offs[a] !== offs[b]) continue
    const ra = find(a), rb = find(b)
    if (ra !== rb) par[ra] = rb
  }
  const comp = new Int32Array(n).fill(-1)
  const map = new Map(), list = []
  for (let i = 0; i < n; i++) {
    const f = B.faces[i]
    if (f.k === 'w' || Number.isNaN(offs[i])) continue
    const r = find(i)
    let c = map.get(r)
    if (c == null) { c = list.length; map.set(r, c); list.push({ off: offs[i], k: f.k, faces: [], anchor: null, face: -1 }) }
    comp[i] = c
    const L = list[c]
    L.faces.push(i)
    if (f.a && (!L.anchor || f.a[2] > L.anchor[2])) { L.anchor = f.a; L.face = i }
  }
  return { comp, list }
}

// 描亮：偏移等于 target 的连通区外轮廓（一侧是目标区、另一侧不是的弧；含岸线 —— 描的是这块区本身）
// target 可以是一个偏移，也可以是一组（「选择时区」多选）：一组时各偏移各勾各的外轮廓 —— 两个选中区相邻（+8 挨 +9）时那条公共边照样勾出
export function highlightLines(B, offs, target) {
  const out = []
  const sel = Array.isArray(target) ? new Set(target.filter(Number.isFinite)) : Number.isFinite(target) ? new Set([target]) : null
  if (!sel || !sel.size) return out
  for (const [ai, a, b] of B.adj) {
    if (a < 0 || b < 0) continue                 // 图幅外缘（±90° 与 ±180° 图边）不是边界；±180° 的那段由跨缝边代替
    const oa = B.faces[a].k !== 'w' ? offs[a] : NaN
    const ob = B.faces[b].k !== 'w' ? offs[b] : NaN
    if (oa === ob) continue
    if (sel.has(oa) || sel.has(ob)) out.push(B.arcs[ai])
  }
  return out
}

// ---------------------------------------------------------------- 色块分组
// [{ off, k: 'l'|'s', faces: [面号] }]，按偏移与陆 / 海分组（海区用浅色），渲染器各自把面环拼成路径 / 网格。
export function fillGroups(B, offs) {
  const m = new Map()
  for (let i = 0; i < B.faces.length; i++) {
    const f = B.faces[i]
    if (f.k === 'w' || Number.isNaN(offs[i])) continue
    const key = f.k + ':' + offs[i]
    let g = m.get(key)
    if (!g) m.set(key, g = { off: offs[i], k: f.k, faces: [] })
    g.faces.push(i)
  }
  return [...m.values()]
}

// ---------------------------------------------------------------- 光标命中
const GRID = 2   // 度
function buildGrid(B) {
  const cols = 360 / GRID, rows = 180 / GRID
  const cells = new Array(cols * rows)
  B.faces.forEach((f, i) => {
    const [x0, y0, x1, y1] = f.box
    const c0 = Math.max(0, Math.floor((x0 + 180) / GRID)), c1 = Math.min(cols - 1, Math.floor((x1 + 180) / GRID))
    const r0 = Math.max(0, Math.floor((y0 + 90) / GRID)), r1 = Math.min(rows - 1, Math.floor((y1 + 90) / GRID))
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) (cells[r * cols + c] = cells[r * cols + c] || []).push(i)
  })
  return { cols, rows, cells }
}
function inRings(rings, x, y) {
  let inside = false
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const yi = ring[i][1], yj = ring[j][1]
      if ((yi > y) !== (yj > y) && x < (ring[j][0] - ring[i][0]) * (y - yi) / (yj - yi) + ring[i][0]) inside = !inside
    }
  }
  return inside
}
export function hitFace(B, lon, lat) {
  if (!B.grid) B.grid = buildGrid(B)
  const G = B.grid
  lon = ((lon + 180) % 360 + 360) % 360 - 180
  const c = Math.min(G.cols - 1, Math.max(0, Math.floor((lon + 180) / GRID)))
  const r = Math.min(G.rows - 1, Math.max(0, Math.floor((lat + 90) / GRID)))
  for (const i of (G.cells[r * G.cols + c] || [])) {
    const f = B.faces[i]
    if (lon < f.box[0] || lon > f.box[2] || lat < f.box[1] || lat > f.box[3]) continue
    for (const poly of faceRings(B, i)) if (inRings(poly, lon, lat)) return i
  }
  return -1
}

// 面 i 沿经线 lon 穿过纬度 lat 的那一段 [lo, hi]（该经线与面各环的交点按奇偶配对）：标注沿经线避让时区条用 ——
// 只在这一段里挪，字就还落在本区里。各面按锚点各算一次，缓存在面上。
export function meridianSpan(B, i, lon, lat) {
  const f = B.faces[i]
  if (f._span && f._span[0] === lon && f._span[1] === lat) return f._span[2]
  const ys = []
  for (const poly of faceRings(B, i)) {
    for (const ring of poly) {
      for (let k = 0, j = ring.length - 1; k < ring.length; j = k++) {
        const a = ring[j], b = ring[k]
        if ((a[0] > lon) !== (b[0] > lon)) ys.push(a[1] + (lon - a[0]) / (b[0] - a[0]) * (b[1] - a[1]))
      }
    }
  }
  ys.sort((p, q) => p - q)
  let span = [lat, lat]
  for (let k = 0; k + 1 < ys.length; k += 2) if (ys[k] <= lat && lat <= ys[k + 1]) { span = [ys[k], ys[k + 1]]; break }
  f._span = [lon, lat, span]
  return span
}

// 某面所用时区的 IANA 名（读数 title 用）
export const faceZoneName = (zones, i) => (i >= 0 && zones[i] >= 0 ? zoneName(zones[i]) : '')
