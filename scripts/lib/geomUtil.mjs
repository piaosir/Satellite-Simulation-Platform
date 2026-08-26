// 构建脚本共用的几何小工具（不进运行时包）。
export const polysOf = (g) => !g ? [] : g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
export const linesOf = (g) => !g ? [] : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []

// 偶奇射线判定（含洞）：rings = [外环, 洞...]
export function inRings(rings, x, y) {
  let c = false
  for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const yi = r[i][1], yj = r[j][1]
    if ((yi > y) !== (yj > y) && x < (r[j][0] - r[i][0]) * (y - yi) / (yj - yi) + r[i][0]) c = !c
  }
  return c
}
export const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s / 2) }

// 面要素的「内点」：优先取 NE 给的标注点，否则取最大环质心，若质心落在洞里则沿扫描线找一个真内点。
export function interiorPoint(geom, hintX, hintY) {
  const polys = polysOf(geom)
  if (!polys.length) return null
  if (Number.isFinite(hintX) && Number.isFinite(hintY)) for (const p of polys) if (inRings(p, hintX, hintY)) return [hintX, hintY]
  let best = null, ba = -1
  for (const p of polys) { const a = ringArea(p[0]); if (a > ba) { ba = a; best = p } }
  const o = best[0]
  let sx = 0, sy = 0; for (const q of o) { sx += q[0]; sy += q[1] }
  const c = [sx / o.length, sy / o.length]
  if (inRings(best, c[0], c[1])) return c
  let lo = 90, hi = -90, xlo = 180, xhi = -180
  for (const q of o) { if (q[1] < lo) lo = q[1]; if (q[1] > hi) hi = q[1]; if (q[0] < xlo) xlo = q[0]; if (q[0] > xhi) xhi = q[0] }
  for (let k = 1; k < 24; k++) {
    const y = lo + (hi - lo) * k / 24
    for (let m = 1; m < 24; m++) { const x = xlo + (xhi - xlo) * m / 24; if (inRings(best, x, y)) return [x, y] }
  }
  return c
}

// TopoJSON arc（量化 + 增量编码）→ 绝对经纬度点列
export function decodeArc(topo, arc) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate
  let x = 0, y = 0
  return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty] })
}
// 几何体引用到的 arc 索引集合（正规化成非负）
export function arcsOfGeom(g, out = new Set()) {
  if (!g) return out
  if (g.type === 'GeometryCollection') { for (const x of g.geometries) arcsOfGeom(x, out); return out }
  const walk = (a) => { if (!a.length) return; if (Array.isArray(a[0])) { for (const b of a) walk(b) } else for (const i of a) out.add(i < 0 ? ~i : i) }
  if (g.arcs) walk(g.arcs)
  return out
}
