// KML 解析器 —— 从标准 OGC KML 2.2 里提取「多边形」用于协调区 Polygon 导入（serialize.js 的逆）。
// 只认 <Placemark> 里的 <Polygon>（outerBoundaryIs/LinearRing）；<Point>（波束中心图钉）忽略。
// 尽量还原本软件导出的名称/数值/卫星/轨位/线色/填充色与不透明度（description + Style / StyleMap），
// 也兼容 Google Earth 等第三方仅含 name + coordinates(+样式) 的多边形。
// 输出：[{ name, value, satName, satLon, color:'#rrggbb'|null, fillColor:'#rrggbb'|null, fillOp:0..1|null,
//         fillOn:bool, pts:[[lon,lat]...] }]（pts 为开放环，不含末尾闭合重复点，与内部 pg.pts 同构）。
// 另有 parseKmlBeams（文件末尾）：按文件夹树还原「卫星 → 波束 → 等值线」，供 GXT/KML 覆盖库导入。

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

// 文本 → XML Document（渲染进程的 DOMParser；解析失败/环境不支持一律抛错供上层提示）
function parseXml(text) {
  if (!text || typeof text !== 'string') throw new Error('空文件')
  const DP = (typeof DOMParser !== 'undefined') ? DOMParser : null
  if (!DP) throw new Error('当前环境不支持 KML 解析')
  const doc = new DP().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('KML 格式错误（XML 解析失败）')
  return doc
}

export function parseKmlPolys(text) {
  const doc = parseXml(text)

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

/* ===================== 覆盖等值线导入（serializeKml 的逆）===================== */
// 按 KML 文件夹树还原「卫星 → 波束 → 等值线」：Folder 链末段是波束名、其上一段是卫星名，
// 每个 <Polygon> 一条等值线、<Point> 一个波束中心。第三方 KML（层级不足/无 ExtendedData）按同一规则退化处理。
// 输出与 gxt/parse.js 的 parseGxt 同构，可直接进覆盖库：
//   { docName, beams:[{ satName, beamName, lon, band, type, bore:[[lon,lat]...], contours:[{g,p:[[lon,lat]...]}] }], noGain, polys }

const POLY_FOLDER = '协调区多边形'   // 本软件导出时协调区多边形所在的文件夹：那是协调区不是覆盖档位，导覆盖库时跳过

const localNameOf = (el) => el.localName || String(el.tagName || '').replace(/^.*:/, '')
// 直接子元素（层级遍历要的是「儿子」，不是 getElementsByTagNameNS 的全部后代）
const kids = (el) => Array.from((el && el.childNodes) || []).filter((n) => n.nodeType === 1)
const kidEls = (el, name) => kids(el).filter((c) => localNameOf(c) === name)
const kidText = (el, name) => { const c = kidEls(el, name)[0]; return c ? (c.textContent || '').trim() : '' }
const numOr = (v, d = null) => { const n = Number(v); return (v != null && String(v).trim() !== '' && Number.isFinite(n)) ? n : d }

// <ExtendedData> 里的 Data/SimpleData → { 键: 值 }（本软件导出的轨位/频段/类型/增益走这里）
function extData(el) {
  const out = {}
  for (const ed of kidEls(el, 'ExtendedData')) {
    for (const d of kids(ed)) {
      const ln = localNameOf(d)
      if (ln === 'Data') { const k = d.getAttribute('name'); if (k) out[k] = kidText(d, 'value') }
      else if (ln === 'SchemaData') { for (const sd of kidEls(d, 'SimpleData')) { const k = sd.getAttribute('name'); if (k) out[k] = (sd.textContent || '').trim() } }
    }
  }
  return out
}

// 一层容器（Document/Folder）带的元信息：轨位 / 频段 / 类型（ExtendedData 优先，description 文本兜底）
function containerMeta(el) {
  const ed = extData(el)
  const desc = kidText(el, 'description')
  const out = {}
  const lon = numOr(ed.satLon, numOr((/轨道位置[:：]\s*(-?\d+(?:\.\d+)?)/.exec(desc) || [])[1]))
  if (lon != null) out.lon = lon
  const band = ed.band || (/频段[:：]\s*([^\s　]+)/.exec(desc) || [])[1]
  if (band) out.band = String(band)
  const type = ed.type || (/类型[:：]\s*([^\s　]+)/.exec(desc) || [])[1]
  if (type) out.type = /gt|g\s*\/\s*t/i.test(type) ? 'GT' : 'EIRP'
  return out
}

// 一个 Placemark 的增益档：ExtendedData gain → 名称「48 dB」→ description「数值：48」→ 名称本身是数字。都取不到返回 null
function gainOf(pm) {
  const g = numOr(extData(pm).gain)
  if (g != null) return g
  const nm = kidText(pm, 'name'), desc = kidText(pm, 'description')
  const mdb = /(-?\d+(?:\.\d+)?)\s*dB/i.exec(nm) || /(-?\d+(?:\.\d+)?)\s*dB/i.exec(desc)
  if (mdb) return Number(mdb[1])
  const mval = /数值[:：]\s*(-?\d+(?:\.\d+)?)/.exec(desc)
  if (mval) return Number(mval[1])
  const mnum = /^\s*(-?\d+(?:\.\d+)?)\s*$/.exec(nm)
  if (mnum) return Number(mnum[1])
  return null
}

export function parseKmlBeams(text) {
  const doc = parseXml(text)
  const root = doc.documentElement
  const docEl = kidEls(root, 'Document')[0] || null
  const docName = docEl ? kidText(docEl, 'name') : kidText(root, 'name')

  const buckets = new Map()
  const stat = { noGain: 0, polys: 0 }   // 无增益档的多边形数 / 跳过的协调区多边形数

  const bucketFor = (path, meta) => {
    const beamName = path.length ? path[path.length - 1] : (docName || '波束')
    const satName = path.length >= 2 ? path[path.length - 2] : (docName || beamName)
    const key = satName + ' ' + beamName
    let b = buckets.get(key)
    if (!b) {
      b = { satName, beamName, lon: meta.lon != null ? meta.lon : null, band: meta.band || '', type: meta.type || 'EIRP', bore: [], contours: [] }
      buckets.set(key, b)
    } else if (b.lon == null && meta.lon != null) b.lon = meta.lon
    return b
  }

  const visitPlacemark = (pm, path, meta) => {
    const polyEls = els(pm, 'Polygon')
    const pointEls = els(pm, 'Point')
    if (!polyEls.length && !pointEls.length) return
    const b = bucketFor(path, meta)
    for (const pt of pointEls) {
      const coordsEl = firstEl(pt, 'coordinates')
      const p = coordsEl ? parseCoords(coordsEl.textContent) : []
      if (p.length) b.bore.push(p[0])
    }
    if (!polyEls.length) return
    const g = gainOf(pm)
    if (g == null) { stat.noGain += polyEls.length; return }
    // 单位写成 dB/K 的是 G/T 图（本软件导出会写 ExtendedData type，第三方文件靠这一手推断）
    if (!meta.type && /dB\s*\/\s*K/i.test(kidText(pm, 'name'))) b.type = 'GT'
    for (const poly of polyEls) {
      const outer = firstEl(poly, 'outerBoundaryIs') || poly
      const coordsEl = firstEl(outer, 'coordinates')
      const p = coordsEl ? parseCoords(coordsEl.textContent) : []
      if (p.length >= 2) b.contours.push({ g, p })
    }
  }

  const walk = (el, path, meta) => {
    for (const c of kids(el)) {
      const ln = localNameOf(c)
      if (ln === 'Folder' || ln === 'Document') {
        const nm = kidText(c, 'name')
        walk(c, nm ? [...path, nm] : path, { ...meta, ...containerMeta(c) })
      } else if (ln === 'Placemark') {
        if (path.includes(POLY_FOLDER)) { stat.polys += els(c, 'Polygon').length; continue }
        visitPlacemark(c, path, meta)
      }
    }
  }
  walk(root, [], containerMeta(root))

  const beams = [...buckets.values()].filter((b) => b.contours.length)
  if (!beams.length) {
    if (stat.polys) throw new Error('只有协调区多边形（用 Polygon 面板导入）')
    throw new Error(stat.noGain ? `${stat.noGain} 个多边形没有增益档（名称需含「48 dB」一类数值）` : '未识别到等值线（KML 里没有 <Polygon>？）')
  }
  return { docName, beams, ...stat }
}
