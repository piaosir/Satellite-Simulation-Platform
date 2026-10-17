// 波束地图（覆盖库来源：GXT / KML / JSON / 脚本导入的闭合等值线）→ 与 GRD 同构的覆盖场图层。
//
// 产物与 useGrdCoverage.buildBeamLayer 同一种层格式，3D（scene.setBeamMapField）与 2D（flatCoverage.setBeamMapField）
// 的覆盖场通道直接消费，故分带填充 / 逐档线色线型 / 数值标签 / 波束名 / 中心十字 / 中心电平的画法与 GRD 一字不差：
//   { id, alpha, fillBands:[{ color:[r,g,b], alpha, verts:Float64Array, counts:Int32Array }],
//     segGroups:[{ idx, segs, color, opacity, width, dash, txt, labels }], bore:{ lon, lat, hit, onEarth, peak }, name }
// 差别只在几何来源：GRD 是方向图网格上 marching 出来的，这里是文件给定的多边形 ——
//   · 分带填充：第 i 档 = 该档全部环 ∪ 上一可见档全部环 的【奇偶规则】区域（= {≥v_i} − {≥v_{i+1}}；档内的「坑」
//     自然成岛、同档嵌套环自然成洞）。环按包含深度分外环 / 洞后 earcut 三角化；3D 再按最长边细分贴球（scene.updateFill）。
//   · 等值线：环逐边成段，点列与填充是同一份加密后的环 → 线与填充边界重合。
//   · 数值标签锚点：与 GRD 同一套 loopLabelAnchor / loopLabelsAtInterval。
//   · 波束中心：文件给了就用（GXT [Bn]，带电平即「中心电平」）；没给只算一个名字锚点（hit=false：十字与电平不画）。
// 经度：整束统一解缠到轨位附近（lon ∈ satLon ± 180），跨 ±180° 的波束不被横扫；标签锚点折回 [-180, 180)。
// 环一律按闭合处理（GXT / KML 的等值线本就是闭合环）；显式 closed === false 的开口链只画线、不进填充。
import earcut from 'earcut'
import { loopLabelAnchor, loopLabelsAtInterval } from '../grd/coverage.js'

export const NONE = 'none'                 // 无数值的等值线（覆盖边界之类）的档键
const MAX_SEG = 0.5                        // 加密步长（度）：大跨度多边形的边按经纬线性插值画，2D / 3D / 投影档同一条线
const r6 = (v) => Math.round(v * 1e6) / 1e6
const wrap180 = (x) => (x >= -180 && x < 180 ? x : ((x % 360) + 540) % 360 - 180)   // 已在范围内原样返回，不带进浮点尾数
const nearLon = (lon, ref) => ref + wrap180(lon - ref)

/** 档值 → 档键：数值按 1e-6 归一（文件里 52 与 52.0000001 是同一档）；空值 / 非数 → NONE */
export function levelKey(g) { return (typeof g === 'number' && Number.isFinite(g)) ? String(r6(g)) : NONE }
export function levelVal(key) { return key === NONE ? null : Number(key) }
/** 档值的显示文本（数值标签 / 电平表）：不做小数位裁剪，只去浮点噪声 */
export function fmtLevel(v) { return (typeof v === 'number' && Number.isFinite(v)) ? String(r6(v)) : '' }
// 升序：无数值档垫底（覆盖边界当最外一圈）
export const levelCmp = (a, b) => (a == null ? -Infinity : a) - (b == null ? -Infinity : b)

/** 一组等值线里出现过的档（升序，含 null） */
export function levelsOf(contours) {
  const m = new Map()
  for (const c of (contours || [])) { const k = levelKey(c && c.g); if (!m.has(k)) m.set(k, levelVal(k)) }
  return [...m.values()].sort(levelCmp)
}

// '#rrggbb' / 'rgb(r,g,b)' / [r,g,b] → [r,g,b]
export function toRgb(c, fb = [255, 255, 255]) {
  if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0]
  const s = String(c || '').trim()
  let m = /^#?([0-9a-f]{6})$/i.exec(s)
  if (m) { const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
  m = /^#([0-9a-f]{3})$/i.exec(s)
  if (m) return m[1].split('').map((x) => parseInt(x + x, 16))
  m = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(s)
  return m ? [+m[1] | 0, +m[2] | 0, +m[3] | 0] : fb.slice()
}
export const rgbHex = (c) => '#' + toRgb(c).map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')

/* ---------------- 环的预处理 ---------------- */
// 点列 → 解缠（相对前一点取最近副本，首点相对 ref）→ 去非数 / 去连续重复点 / 去闭合重复点 → 按 MAX_SEG 加密（含闭合边）。
// 返回 { pts:[[lon,lat]...] 不含闭合重复点, polar: 绕极（首尾经度差超 180°：闭合边要经过极点）}
export function prepRing(p, ref, closed = true) {
  const out = []
  let prev = null
  for (const q of (p || [])) {
    const lon0 = Array.isArray(q) ? q[0] : (q && q.lon), lat = Array.isArray(q) ? q[1] : (q && q.lat)
    if (!Number.isFinite(lon0) || !Number.isFinite(lat)) continue
    const lon = nearLon(lon0, prev ? prev[0] : ref)
    if (prev && Math.abs(prev[0] - lon) < 1e-12 && Math.abs(prev[1] - lat) < 1e-12) continue
    if (prev) densifyInto(out, prev, lon, lat)
    const pt = [lon, lat]
    out.push(pt); prev = pt
  }
  if (out.length >= 2) {
    const a = out[0], b = out[out.length - 1]
    if (Math.abs(nearLon(b[0], a[0]) - a[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop()
  }
  let polar = false
  if (closed && out.length >= 3) {
    const a = out[0], b = out[out.length - 1]
    polar = Math.abs(b[0] - a[0]) > 180
    if (!polar) densifyInto(out, b, a[0], a[1])
  }
  return { pts: out, polar }
}
function densifyInto(out, a, lon, lat) {
  const dx = lon - a[0], dy = lat - a[1]
  const n = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_SEG)
  for (let k = 1; k < n; k++) out.push([a[0] + dx * k / n, a[1] + dy * k / n])
}
// 填充用的环：绕极环（覆盖极区、首尾差一圈）沿极点补一条闭合边，否则直接用
function fillRing(ring) {
  if (!ring.polar) return ring.pts
  const pts = ring.pts, a = pts[0], b = pts[pts.length - 1]
  let s = 0
  for (const q of pts) s += q[1]
  const pole = s >= 0 ? 90 : -90
  const out = pts.slice()
  out.push([b[0], pole])
  const n = Math.ceil(Math.abs(a[0] - b[0]) / MAX_SEG)
  for (let k = 1; k < n; k++) out.push([b[0] + (a[0] - b[0]) * k / n, pole])
  out.push([a[0], pole])
  return out
}

/* ---------------- 几何小件 ---------------- */
function boxOf(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const q of r) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1] }
  return [x0, y0, x1, y1]
}
function areaOf(r) {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1])
  return Math.abs(s) / 2
}
function inRing(x, y, r) {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c
  }
  return c
}
// 环 a 在环 b 内：取 a 上分布的三个顶点按多数判（相切 / 共顶点的环，单点落在 b 的边上时不至于误判）
function ringInside(a, b) {
  const n = a.r.length
  let k = 0
  for (const i of [0, Math.floor(n / 3), Math.floor(2 * n / 3)]) if (inRing(a.r[i][0], a.r[i][1], b.r)) k++
  return k >= 2
}
const sigOf = (r) => r.length + ':' + r[0][0].toFixed(5) + ',' + r[0][1].toFixed(5) + ':' + boxOf(r).map((v) => v.toFixed(5)).join(',')

/**
 * 奇偶规则区域的三角剖分：rings = 若干互不相交的闭合环（同一经度解缠系），按包含深度定外环（偶）/ 洞（奇），
 * 每个外环带上它的直接子洞交 earcut。返回扁平三角顶点 [lon,lat, lon,lat, …]（每 6 个数一个三角形）。
 * 完全重合的环先去重（同一条线导两次的脏数据不至于把整档异或成空）。
 */
export function evenOddTriangles(rings) {
  const seen = new Set()
  const R = []
  for (const r of (rings || [])) {
    if (!r || r.length < 3) continue
    const a = areaOf(r)
    if (!(a > 1e-12)) continue
    const sig = sigOf(r)
    if (seen.has(sig)) continue
    seen.add(sig)
    R.push({ r, a, box: boxOf(r), depth: 0, parent: -1 })
  }
  R.sort((x, y) => y.a - x.a)
  for (let i = 1; i < R.length; i++) {
    const bi = R[i].box
    for (let j = i - 1; j >= 0; j--) {          // 面积从小往大找：第一个包住它的就是直接父环
      const bj = R[j].box
      if (bi[0] < bj[0] || bi[2] > bj[2] || bi[1] < bj[1] || bi[3] > bj[3]) continue
      if (ringInside(R[i], R[j])) { R[i].parent = j; R[i].depth = R[j].depth + 1; break }
    }
  }
  const holes = new Map()
  for (let i = 0; i < R.length; i++) {
    if (R[i].depth % 2 === 1 && R[i].parent >= 0) { let l = holes.get(R[i].parent); if (!l) holes.set(R[i].parent, l = []); l.push(i) }
  }
  const out = []
  for (let i = 0; i < R.length; i++) {
    if (R[i].depth % 2) continue
    const flat = [], holeIdx = []
    for (const q of R[i].r) flat.push(q[0], q[1])
    for (const h of (holes.get(i) || [])) { holeIdx.push(flat.length / 2); for (const q of R[h].r) flat.push(q[0], q[1]) }
    const tri = earcut(flat, holeIdx)
    for (let t = 0; t < tri.length; t++) out.push(flat[tri[t] * 2], flat[tri[t] * 2 + 1])
  }
  return out
}

// 环内一个「看得见的中心」（名字锚点）：面积重心落在环内就用它，否则取过重心纬度的最宽内段中点
export function ringLabelPoint(r) {
  let A = 0, cx = 0, cy = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j][0] * r[i][1] - r[i][0] * r[j][1]
    A += f; cx += (r[j][0] + r[i][0]) * f; cy += (r[j][1] + r[i][1]) * f
  }
  if (Math.abs(A) > 1e-12) { cx /= 3 * A; cy /= 3 * A } else { const b = boxOf(r); cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2 }
  if (inRing(cx, cy, r)) return [cx, cy]
  const xs = []
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const yi = r[i][1], yj = r[j][1]
    if ((yi > cy) !== (yj > cy)) xs.push(r[i][0] + (cy - yi) * (r[j][0] - r[i][0]) / (yj - yi))
  }
  xs.sort((a, b) => a - b)
  let best = null
  for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best[1] - best[0]) best = [xs[k], xs[k + 1]]
  return best ? [(best[0] + best[1]) / 2, cy] : [r[0][0], r[0][1]]
}

/* ---------------- 每束一份的几何缓存 ---------------- */
// prep(beam) → { ref, byKey: Map(档键 → [{ pts, polar, closed }]), order: [档键升序] }：只随数据变，与样式无关。
// 分带三角化按「可见档签名」缓存（关掉 / 打开一档才重算；改色、改透明度、改线宽都不碰几何）。
const _prep = new WeakMap()
function prep(beam) {
  const hit = _prep.get(beam)
  if (hit) return hit
  const ref = Number.isFinite(beam.satLon) ? beam.satLon : firstLon(beam)
  const byKey = new Map()
  for (const c of (beam.contours || [])) {
    if (!c) continue
    const closed = c.closed !== false
    const ring = prepRing(c.p, ref, closed)
    if (ring.pts.length < 2) continue
    ring.closed = closed && ring.pts.length >= 3
    const k = levelKey(c.g)
    let l = byKey.get(k); if (!l) byKey.set(k, l = []); l.push(ring)
  }
  const order = [...byKey.keys()].sort((a, b) => levelCmp(levelVal(a), levelVal(b)))
  const o = { ref, byKey, order, bands: new Map(), lines: new Map() }
  _prep.set(beam, o)
  return o
}
// 一档的线段与链（只随数据变）：改色 / 线宽 / 透明度 / 标签设置时不再重新分配几十万个线段对象
function linesFor(P, k) {
  let l = P.lines.get(k)
  if (l) return l
  const segs = [], chains = []
  for (const r of (P.byKey.get(k) || [])) {
    const pts = r.pts
    const ch = r.closed ? [...pts, pts[0]] : pts.slice()
    for (let q = 1; q < ch.length; q++) segs.push([ch[q - 1], ch[q]])
    chains.push(ch)
  }
  l = { segs, chains }
  P.lines.set(k, l)
  return l
}
function firstLon(beam) {
  for (const c of (beam.contours || [])) for (const q of ((c && c.p) || [])) { const v = Array.isArray(q) ? q[0] : q && q.lon; if (Number.isFinite(v)) return v }
  for (const q of (beam.bore || [])) if (Number.isFinite(q && q[0])) return q[0]
  return 0
}
function bandsFor(P, keysAsc) {
  const sig = keysAsc.join('|')
  let b = P.bands.get(sig)
  if (b) return b
  b = new Map()
  for (let i = 0; i < keysAsc.length; i++) {
    const own = (P.byKey.get(keysAsc[i]) || []).filter((r) => r.closed)
    const up = i + 1 < keysAsc.length ? (P.byKey.get(keysAsc[i + 1]) || []).filter((r) => r.closed) : []
    const tri = evenOddTriangles([...own, ...up].map(fillRing))
    if (tri.length) b.set(keysAsc[i], new Float64Array(tri))
  }
  if (P.bands.size >= 6) P.bands.delete(P.bands.keys().next().value)   // 只留最近几种可见组合
  P.bands.set(sig, b)
  return b
}

// 标签在图面上的宽度（度）：与 useGrdCoverage.labelWDeg 同式（沿线间隔按「几个标签宽」计）
const labelWDeg = (txt, size) => ((+size || 12) / 533) * (180 / Math.PI) * 0.62 * Math.max(1, String(txt).length)

/**
 * 一束 → 图层（通常一层；GXT 多个波束中心时，第 2 个起各补一个只带十字的小层）。
 * @param beam  { contours:[{ g, p, closed? }], bore:[[lon,lat,gain?]], name, satLon }
 * @param st    { levels:[{ key, v, color, lineColor, name, dash, width, fillAlpha }]（只给可见档，顺序不限）,
 *                fill, fillAlpha, line, lineAlpha, lineWidth, lineStyle }
 * @param lab   { show, mode:'single'|'interval', gap, size, withName }（数值标签；与 GRD 的 showVal / labelMode / labelGap / valSize / labelWithName 同义）
 * @param id    层 id（渲染器按它增量复用）
 */
export function buildBeamLayers(beam, st, lab, id) {
  const P = prep(beam)
  const want = new Map()
  for (const L of (st.levels || [])) if (L && P.byKey.has(L.key)) want.set(L.key, L)
  const keys = P.order.filter((k) => want.has(k))
  const L0 = { id, alpha: st.fillAlpha != null ? +st.fillAlpha : null, fillBands: null, segGroups: [], bore: null, name: String(beam.name || '') }
  if (st.fill && keys.length) {
    const bands = bandsFor(P, keys)
    const fb = []
    for (const k of keys) {
      const v = bands.get(k); if (!v) continue
      const lv = want.get(k)
      const counts = new Int32Array(v.length / 6).fill(3)
      fb.push({ color: toRgb(lv.color), alpha: lv.fillAlpha == null ? null : +lv.fillAlpha, verts: v, counts })
    }
    L0.fillBands = fb.length ? fb : null
  }
  if (st.line) {
    keys.forEach((k, i) => {
      const lv = want.get(k)
      const { segs, chains } = linesFor(P, k)
      const labels = []
      const lab0 = fmtLevel(lv.v)
      const txt = (lab && lab.withName && lv.name && lab0) ? (lab0 + ' ' + lv.name) : (lv.name || lab0)
      if (lab && lab.show && txt) {
        for (const ch of chains) {
          if (ch.length < 4) continue
          const an = lab.mode === 'interval' ? loopLabelsAtInterval(ch, labelWDeg(txt, lab.size), lab.gap) : [loopLabelAnchor(ch, i, keys.length)]
          for (const a of an) labels.push([wrap180(a[0]), a[1]])
        }
      }
      if (!segs.length) return
      const g = {
        idx: i, segs, color: rgbHex(lv.lineColor || lv.color), opacity: st.lineAlpha != null ? +st.lineAlpha : 1,
        width: lv.width != null ? +lv.width : (+st.lineWidth || 1.6), dash: lv.dash || (st.lineStyle && st.lineStyle !== 'solid' ? st.lineStyle : null),
        txt: txt || null, labels
      }
      Object.defineProperty(g, '_chains', { value: chains, writable: true, configurable: true, enumerable: false })   // 2D 渲染器直接用，免得再拼链
      L0.segGroups.push(g)
    })
  }
  const out = [L0]
  const bores = (beam.bore || []).filter((q) => q && Number.isFinite(q[0]) && Number.isFinite(q[1]))
  if (bores.length) {
    const b = bores[0]
    L0.bore = { lon: wrap180(b[0]), lat: b[1], hit: true, onEarth: keys.length > 0, peak: Number.isFinite(b[2]) ? b[2] : null }
    for (let k = 1; k < bores.length; k++) {
      const q = bores[k]
      out.push({ id: id + '#b' + k, fillBands: null, segGroups: [], name: '', bore: { lon: wrap180(q[0]), lat: q[1], hit: true, onEarth: false, peak: Number.isFinite(q[2]) ? q[2] : null } })
    }
  } else if (keys.length) {
    // 没有波束中心：名字锚在最高可见档里最大的那个环的「看得见的中心」，十字与电平不画（hit=false）
    let best = null
    for (let i = keys.length - 1; i >= 0 && !best; i--) {
      for (const r of P.byKey.get(keys[i])) if (r.closed && (!best || areaOf(r.pts) > best.a)) best = { r, a: areaOf(r.pts) }
    }
    if (best) { const c = ringLabelPoint(best.r.pts); L0.bore = { lon: wrap180(c[0]), lat: c[1], hit: false, onEarth: true, peak: null } }
  }
  return out
}

/** 视轴射线（卫星 → 波束中心）：与 GRD 的 opts.rays 同格式 */
export function beamRay(satLon, b, style, rSat = 42164.17, rEarth = 6371) {
  if (!Number.isFinite(satLon) || !b || !Number.isFinite(b[0]) || !Number.isFinite(b[1])) return null
  return { from: { lon: satLon, lat: 0, rKm: rSat }, to: { lon: b[0], lat: b[1], rKm: rEarth * 1.0012 }, color: style.color, width: style.width, opacity: style.opacity }
}
