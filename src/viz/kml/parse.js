// KML 解析器 —— 从标准 OGC KML 2.2 里提取「多边形」用于协调区 Polygon 导入（serialize.js 的逆）。
// 只认 <Placemark> 里的 <Polygon>（outerBoundaryIs/LinearRing）；<Point>（波束中心图钉）忽略。
// 尽量还原本软件导出的名称/数值/卫星/轨位/线色/填充色与不透明度（description + Style / StyleMap），
// 也兼容 Google Earth 等第三方仅含 name + coordinates(+样式) 的多边形。
// 输出：[{ name, value, satName, satLon, color:'#rrggbb'|null, fillColor:'#rrggbb'|null, fillOp:0..1|null,
//         fillOn:bool, pts:[[lon,lat]...] }]（pts 为开放环，不含末尾闭合重复点，与内部 pg.pts 同构）。

const HEX6 = /^#[0-9a-fA-F]{6}$/

// KML 颜色为 aabbggrr（8 位十六进制：透明度+蓝+绿+红，与常见 rrggbb 顺序相反）→ { hex:'#rrggbb', op:0..1 }；非法返回 null
function kmlColorToRgb(s) {
  const m = /^#?([0-9a-fA-F]{8})$/.exec(String(s || '').trim())
  if (!m) return null
  const h = m[1].toLowerCase()
  const aa = h.slice(0, 2), bb = h.slice(2, 4), gg = h.slice(4, 6), rr = h.slice(6, 8)
  return { hex: '#' + rr + gg + bb, op: parseInt(aa, 16) / 255 }
}

// "lon,lat[,alt] lon,lat[,alt] ..." → [[lon,lat]...]；去掉与首点重合的末尾闭合点（LinearRing 要求闭环）
function parseCoords(text) {
  const pts = []
  for (const tok of String(text || '').trim().split(/\s+/)) {
    if (!tok) continue
    const parts = tok.split(',')
    const lon = Number(parts[0]), lat = Number(parts[1])
    if (Number.isFinite(lon) && Number.isFinite(lat)) pts.push([lon, lat])
  }
  if (pts.length >= 2) {
    const f = pts[0], l = pts[pts.length - 1]
    if (f[0] === l[0] && f[1] === l[1]) pts.pop()
  }
  return pts
}

// 命名空间无关地取子元素（兼容带前缀的 <kml:Polygon> 与默认命名空间）
const els = (root, name) => (root ? Array.from(root.getElementsByTagNameNS('*', name)) : [])
const firstEl = (root, name) => { const l = els(root, name); return l.length ? l[0] : null }
const textOf = (root, name) => { const e = firstEl(root, name); return e ? (e.textContent || '').trim() : '' }

// 从一段样式片段（<Style> 或内联）取 { line, fill, fillOp, fillOn }
function readStyle(styleEl) {
  const out = {}
  const line = firstEl(styleEl, 'LineStyle')
  if (line) { const c = kmlColorToRgb(textOf(line, 'color')); if (c) out.line = c.hex }
  const poly = firstEl(styleEl, 'PolyStyle')
  if (poly) {
    const c = kmlColorToRgb(textOf(poly, 'color'))
    if (c) { out.fill = c.hex; out.fillOp = c.op }
    const fillFlag = textOf(poly, 'fill')
    if (fillFlag === '0') out.fillOn = false
  }
  return out
}

export function parseKmlPolys(text) {
  if (!text || typeof text !== 'string') throw new Error('空文件')
  const DP = (typeof DOMParser !== 'undefined') ? DOMParser : null
  if (!DP) throw new Error('当前环境不支持 KML 解析')
  const doc = new DP().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('KML 格式错误（XML 解析失败）')

  // 样式表：id -> { line, fill, fillOp, fillOn }。StyleMap（normal/highlight 组）取 normal 指向的 Style。
  const styleById = {}
  for (const st of els(doc, 'Style')) { const id = st.getAttribute('id'); if (id) styleById['#' + id] = readStyle(st) }
  const mapNormal = {}   // StyleMap id -> 其 normal 对的 styleUrl
  for (const sm of els(doc, 'StyleMap')) {
    const id = sm.getAttribute('id'); if (!id) continue
    for (const pair of els(sm, 'Pair')) {
      if (textOf(pair, 'key') === 'normal') { const u = textOf(pair, 'styleUrl'); if (u) mapNormal['#' + id] = u.startsWith('#') ? u : '#' + u }
    }
  }
  const resolveStyle = (url) => {
    if (!url) return {}
    const key = url.startsWith('#') ? url : '#' + url
    if (styleById[key]) return styleById[key]
    if (mapNormal[key] && styleById[mapNormal[key]]) return styleById[mapNormal[key]]
    return {}
  }

  const out = []
  for (const pm of els(doc, 'Placemark')) {
    const polyEls = els(pm, 'Polygon')
    if (!polyEls.length) continue   // 无多边形（纯 Point/LineString）跳过

    // 名称 / 描述（本软件导出：name="名称：数值"，description="数值：X　卫星：Y　轨道位置：Z°E"）
    const rawName = textOf(pm, 'name')
    const desc = textOf(pm, 'description')
    const mVal = /数值[:：]\s*([^\s　]+)/.exec(desc)
    const mSat = /卫星[:：]\s*([^\s　]+)/.exec(desc)
    const mLon = /轨道位置[:：]\s*(-?\d+(?:\.\d+)?)/.exec(desc)
    const value = mVal ? mVal[1] : ''
    const satName = mSat ? mSat[1] : ''
    const satLon = mLon ? mLon[1] : ''
    // 名称去掉导出时拼接的「：数值」尾巴（仅当确由本软件导出、尾部正是该数值时）
    let name = rawName
    if (value && name.endsWith('：' + value)) name = name.slice(0, -('：' + value).length).trim()

    // 样式：外链 styleUrl 优先；否则内联 <Style>
    const styleUrl = textOf(pm, 'styleUrl')
    let sty = resolveStyle(styleUrl)
    const inline = firstEl(pm, 'Style')
    if (inline) sty = { ...readStyle(inline), ...sty }   // 外链已解析的键保留，内联补空缺

    const color = (sty.line && HEX6.test(sty.line)) ? sty.line : null
    const fillColor = (sty.fill && HEX6.test(sty.fill)) ? sty.fill : null
    const fillOp = (typeof sty.fillOp === 'number') ? Math.max(0, Math.min(1, sty.fillOp)) : null
    const fillOn = sty.fillOn !== false

    polyEls.forEach((poly, i) => {
      const outer = firstEl(poly, 'outerBoundaryIs') || poly
      const coordsEl = firstEl(outer, 'coordinates')
      const pts = coordsEl ? parseCoords(coordsEl.textContent) : []
      if (pts.length < 3) return
      out.push({
        name: polyEls.length > 1 ? `${name || 'Polygon'} #${i + 1}` : name,
        value, satName, satLon, color, fillColor, fillOp, fillOn, pts
      })
    })
  }

  if (!out.length) throw new Error('未识别到多边形（KML 里没有 <Polygon>？）')
  return out
}
