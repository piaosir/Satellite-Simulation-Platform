// 南极洲极区填充：把环极海岸线「收口到南极点」，得到可直接三角化/描 Path2D 的简单多边形。
// 解决两类问题：
//  1) 数据止于约 −85°、极点处留圆形空洞 —— 旧做法用 −82° 一刀切极冠，会污染罗斯海/威德尔海并与海岸线产生缝/重叠；
//  2) 50m 底图把本土编码成 [外环=贴 −90° 的退化线 + 洞=海岸线]，earcut 直接三角化得 0 → 本土完全不填充。
// 统一从「纬度跨度>10° 且经度跨度最大」的环识别本土海岸线（10m 是普通外环、50m 是被当成洞的那条），
// 解缠后在末尾追加两枚 −90° 顶点收口成简单多边形（两枚 −90° 之间横跨满经度 → 覆盖南极点）；
// 其余非退化环（岛屿/碎片）原样解缠返回。返回的环均为「解缠后的经纬度点列」，可直接投影。
function unwrapRing(ring) {
  const out = new Array(ring.length)
  let prev = ring[0][0]
  out[0] = [prev, ring[0][1]]
  for (let i = 1; i < ring.length; i++) {
    let lon = ring[i][0]
    while (lon - prev > 180) lon -= 360
    while (lon - prev < -180) lon += 360
    out[i] = [lon, ring[i][1]]
    prev = lon
  }
  let s = 0; for (const p of out) s += p[0]
  const shift = -360 * Math.round((s / out.length) / 360)
  if (shift) for (const p of out) p[0] += shift
  return out
}
function ringArea(r) { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(s / 2) }

// 入参：南极洲 GeoJSON feature（id '010'）。返回：[[ [lon,lat], ... ], ...] 一组简单多边形（无洞）。
// 第 0 个为本土（已收口到极点），其余为岛屿/碎片。
export function antarcticaFillRings(feature) {
  if (!feature || !feature.geometry) return []
  const g = feature.geometry
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
  const all = []
  for (const rings of polys) for (const r of rings) all.push(r)
  // 本土海岸线：纬度跨度>10° 且经度跨度最大（环极）。排除 50m 那条全在 −90° 的退化外环（纬度跨度≈0）。
  let main = null, mainSpan = -1
  for (const r of all) {
    let lo = 180, hi = -180, a = 90, b = -90
    for (const p of r) { if (p[0] < lo) lo = p[0]; if (p[0] > hi) hi = p[0]; if (p[1] < a) a = p[1]; if (p[1] > b) b = p[1] }
    if ((b - a) > 10 && (hi - lo) > mainSpan) { mainSpan = hi - lo; main = r }
  }
  const out = []
  if (main) {
    const uw = unwrapRing(main)
    const pts = uw.slice()
    // 去掉闭合重复点，再追加 (末端经度,−90)、(起点经度,−90) 收口（两枚 −90° 横跨满经度 → 含极点）
    if (pts.length > 1 && Math.abs(pts[0][0] - pts[pts.length - 1][0]) < 1 && Math.abs(pts[0][1] - pts[pts.length - 1][1]) < 1) pts.pop()
    out.push([...pts, [pts[pts.length - 1][0], -90], [pts[0][0], -90]])
  }
  for (const r of all) { if (r === main || ringArea(r) < 1e-6) continue; out.push(unwrapRing(r)) }
  return out
}
