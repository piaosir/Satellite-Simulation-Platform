// KML 序列化器 —— 把等值线数据导出为标准 Google KML（OGC KML 2.2，Google Earth/Google Maps 通用格式）。
// 入参与 gxt/serialize.js 的 serializeGxt 同源：beams=[{ name, satName, lon, bore, contours:[{g,p:[[lon,lat]...]}] }]。
// 按卫星→波束建 Folder 树；波束中心落 Point（target 图钉），每条等值线落 Polygon（outerBoundaryIs 闭合环），
// 按增益强弱套用与 3D 页 gainHex 同一套蓝→红渐变着色。
const clamp01 = (v) => Math.max(0, Math.min(1, v))
// HSL(蓝→红) -> 'rrggbb'
function gainRgb(t) {
  const h = (1 - clamp01(t)) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
  const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
  const hx = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return hx(f(0)) + hx(f(8)) + hx(f(4))
}
// KML 颜色为 aabbggrr（8 位十六进制：透明度+蓝+绿+红，与常见 rrggbb 顺序相反）
const kmlColor = (rrggbb, alpha) => alpha + rrggbb.slice(4, 6) + rrggbb.slice(2, 4) + rrggbb.slice(0, 2)
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// 环坐标：lon,lat,0 空格分隔；首尾不同则补首点闭合（LinearRing 要求闭合环）
function ringCoords(pts) {
  if (!pts || pts.length < 2) return ''
  const first = pts[0], last = pts[pts.length - 1]
  const all = (first[0] !== last[0] || first[1] !== last[1]) ? [...pts, first] : pts
  return all.map((p) => `${Number(p[0]).toFixed(6)},${Number(p[1]).toFixed(6)},0`).join(' ')
}

// Polygon（协调区多边形）导出：polys=[{ name, value, color:'#rrggbb', pts:[[lon,lat]...] }]。
// 每个多边形一个 Placemark：名称+数值进 name/description（数值含义与单位由协调材料约定，软件不做定义），
// 按多边形自身颜色描边 + 浅填充。忽略顶点数 <3 的记录。
export function serializePolysKml(polys = [], opts = {}) {
  const docName = opts.name || 'Polygon'
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `<name>${esc(docName)}</name>`
  ]
  polys.forEach((pg, i) => {
    const pts = pg && pg.pts
    if (!pts || pts.length < 3) return
    const m = /^#?([0-9a-fA-F]{6})$/.exec(String(pg.color || ''))
    const rgb = m ? m[1].toLowerCase() : 'ff5a5a'
    const hasVal = pg.value != null && String(pg.value).trim() !== ''
    const name = [pg.name, hasVal ? pg.value : ''].filter((x) => x != null && String(x).trim() !== '').join('：')
    out.push(
      `<Style id="pg${i}">`,
      `<LineStyle><color>${kmlColor(rgb, 'ff')}</color><width>2</width></LineStyle>`,
      `<PolyStyle><color>${kmlColor(rgb, '33')}</color><fill>1</fill><outline>1</outline></PolyStyle>`,
      '</Style>',
      '<Placemark>',
      `<name>${esc(name || 'Polygon')}</name>`
    )
    const desc = []
    if (hasVal) desc.push('数值：' + pg.value)
    if (pg.satName != null && String(pg.satName).trim() !== '') desc.push('卫星：' + pg.satName)
    if (pg.satLon != null && String(pg.satLon).trim() !== '') desc.push('轨道位置：' + pg.satLon + '°E')
    if (desc.length) out.push(`<description>${esc(desc.join('　'))}</description>`)
    out.push(
      `<styleUrl>#pg${i}</styleUrl>`,
      '<Polygon>',
      '<tessellate>1</tessellate>',
      '<altitudeMode>clampToGround</altitudeMode>',
      '<outerBoundaryIs><LinearRing><coordinates>', ringCoords(pts), '</coordinates></LinearRing></outerBoundaryIs>',
      '</Polygon>',
      '</Placemark>'
    )
  })
  out.push('</Document>', '</kml>')
  return out.join('\r\n')
}

export function serializeKml(beams = [], opts = {}) {
  const docName = opts.name || '覆盖图'
  const styleDefs = []
  const styleSeen = new Set()
  const satFolders = []

  const bySat = new Map()
  for (const b of (beams || [])) {
    const key = b.satName || '卫星'
    if (!bySat.has(key)) bySat.set(key, [])
    bySat.get(key).push(b)
  }

  for (const [satName, sbeams] of bySat) {
    const beamFolders = []
    for (const b of sbeams) {
      const contours = (b.contours || []).filter((c) => c && c.p && c.p.length >= 2)
      const gains = contours.map((c) => Number(c.g)).filter(Number.isFinite)
      const gmin = gains.length ? Math.min(...gains) : 0
      const gmax = gains.length ? Math.max(...gains) : 1
      const placemarks = []

      for (const bp of (b.bore || [])) {
        const lon = Array.isArray(bp) ? bp[0] : bp.lon
        const lat = Array.isArray(bp) ? bp[1] : bp.lat
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
        placemarks.push(
          '<Placemark>',
          `<name>${esc(b.name || '波束')} 波束中心</name>`,
          '<styleUrl>#boreStyle</styleUrl>',
          '<Point>',
          `<coordinates>${lon.toFixed(6)},${lat.toFixed(6)},0</coordinates>`,
          '</Point>',
          '</Placemark>'
        )
      }

      for (const c of contours) {
        const t = gmax > gmin ? (Number(c.g) - gmin) / (gmax - gmin) : 1
        const rgb = gainRgb(t)
        const sid = 'g' + rgb
        if (!styleSeen.has(sid)) {
          styleSeen.add(sid)
          styleDefs.push(
            `<Style id="${sid}">`,
            `<LineStyle><color>${kmlColor(rgb, 'ff')}</color><width>2</width></LineStyle>`,
            `<PolyStyle><color>${kmlColor(rgb, '33')}</color><fill>1</fill><outline>1</outline></PolyStyle>`,
            '</Style>'
          )
        }
        placemarks.push(
          '<Placemark>',
          `<name>${esc(c.g)} dB</name>`,
          `<styleUrl>#${sid}</styleUrl>`,
          '<Polygon>',
          '<tessellate>1</tessellate>',
          '<altitudeMode>clampToGround</altitudeMode>',
          '<outerBoundaryIs><LinearRing><coordinates>', ringCoords(c.p), '</coordinates></LinearRing></outerBoundaryIs>',
          '</Polygon>',
          '</Placemark>'
        )
      }

      beamFolders.push('<Folder>', `<name>${esc(b.name || '波束')}</name>`, ...placemarks, '</Folder>')
    }
    satFolders.push('<Folder>', `<name>${esc(satName)}</name>`, ...beamFolders, '</Folder>')
  }

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    `<name>${esc(docName)}</name>`,
    '<Style id="boreStyle"><IconStyle><Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon></IconStyle></Style>',
    ...styleDefs,
    ...satFolders,
    '</Document>',
    '</kml>'
  ]
  return out.join('\r\n')
}
