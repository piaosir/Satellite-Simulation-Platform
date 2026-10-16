// 可编程波束地图 · 脚本标准库：脚本里除 `data` 之外的全部全局（file / zip / gxt / kml / geojson / csv / shapefile /
// png / features / geo / color / fmt / xml）。纯 ESM，Worker 与 Node 测试通用；png() 依赖 OffscreenCanvas，Node 里不可用。
//
// 设计口径（DataGrip「数据导出脚本」范式）：内置的几种导出格式本身就用这套 API 写成（见 templates.js），
// 用户复制一份就能改——所以这里的每个函数都要「默认值 = 菜单导出的口径」，参数只做加法。
//   · gxt(data) / kml(data, { name: '当前绘制' }) 与「导出 GXT / KML（对地）」逐字节一致（单测钉住）。
//   · 经纬度一律 WGS-84 十进制度 [lon, lat]；距离 km、面积 km²。
// 报错文本按界面语言出（createStdlib(lang)），由 runtime 收进控制台。
import { serializeGxt } from '../../viz/gxt/serialize.js'
import { serializeGxtJson } from '../../viz/gxt/json.js'
import { serializeKml } from '../../viz/kml/serialize.js'
import { wgs2gcj, gcj2wgs } from '../../viz/geo/datum.js'
import { zipSync } from 'fflate'
import { normEncoding, applyEol, encodeText, ENCODINGS } from './encode.js'

export const FILE_TAG = '__beamMapFile'
export const isOutputFile = (v) => !!(v && typeof v === 'object' && v[FILE_TAG] === true)

const toRad = Math.PI / 180
const R_MEAN = 6371.0088      // km，IUGG 平均半径（球面插值 / 加密用）
const R_AUTH = 6371.0072      // km，WGS-84 等积球半径（面积用）
const WGS_A = 6378137, WGS_F = 1 / 298.257223563, WGS_B = WGS_A * (1 - WGS_F)

const isPt = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
const isClosedPts = (pts) => pts.length >= 2 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]
const wrapDelta = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180 && d > 0) x = 180; return x }
// 经度连续化：每个点相对上一个点不跳过 180°（跨日界线的环在计算里不被撕开）
function unwrap(pts) {
  const out = new Array(pts.length)
  let prev = null
  for (let i = 0; i < pts.length; i++) {
    let lon = pts[i][0]
    if (prev != null) lon = prev + wrapDelta(lon - prev)
    out[i] = [lon, pts[i][1]]
    prev = lon
  }
  return out
}

export function createStdlib(lang = 'zh') {
  const T = (zh, en) => (lang === 'en' ? en : zh)
  const fail = (zh, en) => { throw new Error(T(zh, en)) }

  /* ===================== 输出 ===================== */
  function file(name, content, opts = {}) {
    if (typeof name !== 'string' || !name.trim()) fail('file()：文件名须为非空字符串', 'file(): name must be a non-empty string')
    const o = (opts && typeof opts === 'object') ? opts : {}
    const enc = normEncoding(o.encoding)
    if (!enc) fail(`file()：不支持的编码「${o.encoding}」（可选：${ENCODINGS.join(' / ')}）`, `file(): unsupported encoding "${o.encoding}" (one of: ${ENCODINGS.join(' / ')})`)
    if (o.eol != null && o.eol !== 'crlf' && o.eol !== 'lf') fail('file()：eol 须为 \'crlf\' 或 \'lf\'', 'file(): eol must be \'crlf\' or \'lf\'')
    let c = content
    if (c instanceof ArrayBuffer) c = new Uint8Array(c)
    else if (ArrayBuffer.isView(c) && !(c instanceof Uint8Array)) c = new Uint8Array(c.buffer, c.byteOffset, c.byteLength)
    else if (c == null) c = ''
    else if (typeof c !== 'string' && !(c instanceof Uint8Array)) c = JSON.stringify(c, null, 2)   // 对象 / 数组 → JSON
    return Object.freeze({ [FILE_TAG]: true, name: name.trim(), content: c, encoding: enc, eol: o.eol || null })
  }
  // 一份输出文件 → 落盘字节（zip 打包与导出共用）
  function fileBytes(f) {
    if (f.content instanceof Uint8Array) return f.content
    return encodeText(applyEol(f.content, f.eol), f.encoding).bytes
  }
  function zip(name, files, opts = {}) {
    const list = Array.isArray(files) ? files : (isOutputFile(files) ? [files] : Object.entries(files || {}).map(([k, v]) => (isOutputFile(v) ? v : file(k, v))))
    if (!list.length) fail('zip()：无待打包的文件', 'zip(): no files to pack')
    const entries = {}
    for (const f of list) {
      if (!isOutputFile(f)) fail('zip()：第二个参数须为 file() 的数组', 'zip(): files must be an array of file()')
      const path = f.name.replace(/\\/g, '/').replace(/^\/+/, '')
      if (entries[path]) fail(`zip()：压缩包内条目名重复「${path}」`, `zip(): duplicate entry "${path}"`)
      entries[path] = fileBytes(f)
    }
    const level = Number.isInteger(opts.level) && opts.level >= 0 && opts.level <= 9 ? opts.level : 6
    return file(name, zipSync(entries, { level }))
  }
  async function png(name, width, height, draw, opts = {}) {
    if (typeof OffscreenCanvas !== 'function') fail('png()：当前运行环境不支持 OffscreenCanvas', 'png(): OffscreenCanvas is not available')
    const w = Math.round(Number(width)), h = Math.round(Number(height))
    if (!(w > 0 && h > 0 && w <= 16384 && h <= 16384)) fail('png()：宽高须在 1–16384 像素之间', 'png(): width / height must be within 1–16384 px')
    if (typeof draw !== 'function') fail('png()：第四个参数须为绘制函数 (ctx) => {…}', 'png(): the 4th argument must be a draw function (ctx) => {…}')
    const cv = new OffscreenCanvas(w, h)
    const ctx = cv.getContext('2d')
    await draw(ctx, { width: w, height: h })
    const type = opts.type === 'jpeg' || opts.type === 'image/jpeg' ? 'image/jpeg' : (opts.type === 'webp' || opts.type === 'image/webp' ? 'image/webp' : 'image/png')
    const blob = await cv.convertToBlob({ type, quality: Number.isFinite(opts.quality) ? opts.quality : undefined })
    return file(name, new Uint8Array(await blob.arrayBuffer()))
  }

  /* ===================== 数据形状 ===================== */
  const isMap = (v) => !!(v && typeof v === 'object' && Array.isArray(v.beams) && Array.isArray(v.polygons))
  const beamsOf = (v) => (isMap(v) ? v.beams : Array.isArray(v) ? v.filter((b) => b && Array.isArray(b.contours)) : (v && Array.isArray(v.contours) ? [v] : []))
  const polysOf = (v) => (isMap(v) ? v.polygons : [])
  const nOrU = (v) => (Number.isFinite(v) ? v : undefined)
  // BeamMap 波束 → 序列化器的内部形状（{ name, satName, lon, band, type, bore, contours:[{g,p,color}] }）。
  // __src 挂回原对象：回调（contourName / beamId …）交给用户的是数据模型里的那一份，不是内部形状。
  // 波束中心电平只带「源文件里本来就有的」那份（覆盖库来源）：天线方向图的峰值是推出来的，菜单导出不写它，
  // 这里也不写 —— gxt(data) / kml(data) 才能与菜单导出逐字节一致。要带上就用 gxtJson() 或自己写。
  const toLegacyBeam = (b) => ({
    name: b.name, satName: b.satellite, lon: nOrU(b.orbitLon), band: b.band, type: b.type || undefined,
    bore: (b.peaks || []).map((p) => (b.source !== 'antenna' && Number.isFinite(p.value) ? [p.lon, p.lat, p.value] : [p.lon, p.lat])),
    contours: (b.contours || []).map((c) => ({ g: c.level, p: c.points, color: c.color, name: c.name, __src: c })),
    __src: b
  })
  // Polygon 按「卫星名 | 轨道位置」分组，组内每个多边形一条闭合等值线（值 = 数值栏）—— 与菜单导出 GXT 同口径
  function polyGroups(polys) {
    const groups = new Map()
    for (const pg of polys || []) {
      const key = `${pg.satellite || ''}|${pg.orbitLon != null ? pg.orbitLon : ''}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(pg)
    }
    return [...groups.values()].map((gs) => ({
      name: 'Polygon', satName: gs[0].satellite || 'Polygon', lon: Number.isFinite(gs[0].orbitLon) ? gs[0].orbitLon : 0, bore: [],
      contours: gs.map((pg) => ({ g: Number.isFinite(pg.level) ? pg.level : 0, p: geo.close(pg.points) })), emiRcp: 'E',
      __src: { name: 'Polygon', satellite: gs[0].satellite, orbitLon: gs[0].orbitLon, polygons: gs }
    }))
  }

  /* ===================== 格式写出 ===================== */
  // GXT：每个波束一个 diagram（含 Polygon 组），拼成一份多 diagram 文本。
  function gxt(input, opts = {}) {
    const beams = beamsOf(input).map(toLegacyBeam)
    const polyBeams = opts.polygons === false ? [] : polyGroups(polysOf(input))
    const all = [...beams, ...polyBeams]
    if (!all.length) return ''
    const head = { adm: opts.adm, polarDisc: opts.polarDisc, reason: opts.reason, digits: opts.digits }
    return all.map((b, i) => {
      const id = typeof opts.beamId === 'function' ? opts.beamId(b.__src, i) : (b.name || (i + 1))
      return serializeGxt({ ...b, ...head, emiRcp: opts.emiRcp || b.emiRcp || 'E', beamId: id })
    }).join('\r\n')
  }
  // GXT 结构 JSON（LinkLab 小程序云数据同款）：单个波束一份文档。GT 波束 emi_rcp 记 R（接收），其余 E。
  function gxtJson(beam, opts = {}) {
    if (!beam || !Array.isArray(beam.contours)) fail('gxtJson()：参数不是单个波束', 'gxtJson(): argument is not a single beam')
    return serializeGxtJson({
      lon: nOrU(beam.orbitLon), satName: beam.satellite,
      bore: (beam.peaks || []).map((p) => (Number.isFinite(p.value) ? [p.lon, p.lat, p.value] : [p.lon, p.lat])),
      contours: beam.contours.map((c) => ({ g: c.level, p: c.points })),
      beamId: opts.beamId != null ? opts.beamId : 1,
      emiRcp: opts.emiRcp || (beam.type === 'GT' ? 'R' : 'E'),
      polarDisc: opts.polarization, reason: opts.reason, adm: opts.adm, formatVer: opts.formatVer
    }, { digits: opts.digits, indent: opts.indent })
  }
  // KML：卫星 → 波束 文件夹树；等值线 Polygon、波束中心 Point；Polygon（协调区）单列文件夹。
  function kml(input, opts = {}) {
    const beams = beamsOf(input).map(toLegacyBeam)
    const polys = opts.polygons === false ? [] : polysOf(input).map((pg) => ({
      name: pg.name, value: pg.value, color: pg.color, satName: pg.satellite, satLon: pg.orbitLon != null ? pg.orbitLon : '', pts: pg.points
    }))
    const contourName = typeof opts.contourName === 'function' ? (c, b) => opts.contourName(c.__src, b.__src) : undefined
    const peakName = typeof opts.peakName === 'function' ? (b) => opts.peakName(b.__src) : undefined
    const title = isMap(input) && input.meta && input.meta.title
    return serializeKml(beams, { ...opts, name: opts.name || title || T('当前绘制', 'Current drawing'), polys, contourName, peakName })
  }
  // GeoJSON 要素（RFC 7946：外环逆时针、环闭合、坐标 [lon, lat]）
  function features(input, opts = {}) {
    const o = { contours: true, peaks: true, polygons: true, markers: true, trajectories: false, digits: 6, ...opts }
    const r = (v) => +v.toFixed(o.digits)
    const pts = (list) => list.map((p) => [r(p[0]), r(p[1])])
    const out = []
    const beams = beamsOf(input)
    for (const b of beams) {
      const base = { satellite: b.satellite, orbitLon: b.orbitLon, beam: b.name, band: b.band, type: b.type, unit: b.unit, source: b.source }
      if (o.contours) for (const c of b.contours) {
        const geom = c.points.length >= 3
          ? { type: 'Polygon', coordinates: [pts(geo.orient(geo.close(c.points), 'ccw'))] }
          : { type: 'LineString', coordinates: pts(c.points) }
        out.push({ type: 'Feature', geometry: geom, properties: { kind: 'contour', ...base, level: c.level, color: c.color } })
      }
      if (o.peaks) for (const p of b.peaks) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r(p.lon), r(p.lat)] }, properties: { kind: 'peak', ...base } })
    }
    if (isMap(input)) {
      if (o.polygons) for (const pg of input.polygons) {
        out.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts(geo.orient(geo.close(pg.points), 'ccw'))] },
          properties: { kind: 'polygon', name: pg.name, value: pg.value, level: pg.level, color: pg.color, fillColor: pg.fill.color, fillOpacity: pg.fill.on ? pg.fill.opacity : 0, satellite: pg.satellite, orbitLon: pg.orbitLon } })
      }
      if (o.markers) {
        for (const m of input.points) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r(m.lon), r(m.lat)] }, properties: { kind: 'point', name: m.name, color: m.color || null } })
        for (const m of input.stations) out.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r(m.lon), r(m.lat)] }, properties: { kind: 'station', name: m.name } })
      }
      if (o.trajectories) for (const t of input.trajectories) {
        if (t.points.length >= 2) out.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: t.points.map((p) => [r(p.lon), r(p.lat)]) }, properties: { kind: 'trajectory', name: t.name, trajectoryKind: t.kind } })
      }
    }
    return out
  }
  // 一行一个要素：比整份缩进小一个数量级，又比单行可读
  function geojson(input, opts = {}) {
    const feats = Array.isArray(input) && (!input.length || input[0].type === 'Feature') ? input : features(input, opts)
    if (opts.indent) return JSON.stringify({ type: 'FeatureCollection', features: feats }, null, opts.indent)
    return '{"type":"FeatureCollection","features":[\n' + feats.map((f) => JSON.stringify(f)).join(',\n') + '\n]}\n'
  }
  // CSV（RFC 4180 引号规则）。rows：数组的数组，或对象数组（表头取各对象键的并集，或 header 指定键序）
  function csv(rows, opts = {}) {
    const sep = typeof opts.sep === 'string' && opts.sep ? opts.sep : ','
    const eol = opts.eol === 'lf' || opts.eol === '\n' ? '\n' : '\r\n'
    const q = (v) => {
      if (v == null) return ''
      if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
      return (s.includes(sep) || /["\r\n]/.test(s) || /^\s|\s$/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const list = Array.isArray(rows) ? rows : []
    const lines = []
    if (list.length && !Array.isArray(list[0]) && typeof list[0] === 'object') {
      const keys = Array.isArray(opts.header) ? opts.header : [...new Set(list.flatMap((r) => Object.keys(r || {})))]
      if (opts.header !== false) lines.push(keys.map(q).join(sep))
      for (const r of list) lines.push(keys.map((k) => q(r && r[k])).join(sep))
    } else {
      if (Array.isArray(opts.header)) lines.push(opts.header.map(q).join(sep))
      for (const r of list) lines.push((Array.isArray(r) ? r : [r]).map(q).join(sep))
    }
    return lines.length ? lines.join(eol) + eol : ''
  }

  /* ===================== Shapefile（ESRI 1998 白皮书 + dBASE III） ===================== */
  const PRJ_WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
  function shapefile(baseName, feats, opts = {}) {
    const base = String(baseName || '').trim()
    if (!base) fail('shapefile()：须指定文件基名', 'shapefile(): base name is required')
    const list = (Array.isArray(feats) ? feats : features(feats, opts)).filter((f) => f && f.geometry)
    if (!list.length) fail('shapefile()：无可写出的要素', 'shapefile(): no features')
    const kindOf = (g) => (g.type === 'Point' ? 1 : (g.type === 'LineString' || g.type === 'MultiLineString') ? 3 : (g.type === 'Polygon' || g.type === 'MultiPolygon') ? 5 : 0)
    const st = kindOf(list[0].geometry)
    if (!st) fail(`shapefile()：不支持的几何类型 ${list[0].geometry.type}`, `shapefile(): unsupported geometry ${list[0].geometry.type}`)
    for (const f of list) if (kindOf(f.geometry) !== st) fail('shapefile()：要素含多种几何类型', 'shapefile(): features have mixed geometry types')
    // 每条记录 → parts（点列数组）
    const recs = list.map((f) => {
      const g = f.geometry
      if (st === 1) return { parts: [[g.coordinates]], props: f.properties || {} }
      let parts
      if (g.type === 'LineString') parts = [g.coordinates]
      else if (g.type === 'MultiLineString') parts = g.coordinates
      else {
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates
        parts = []
        // Shapefile 外环顺时针、内环逆时针（与 GeoJSON 相反）
        for (const poly of polys) poly.forEach((ring, k) => parts.push(geo.orient(geo.close(ring), k === 0 ? 'cw' : 'ccw')))
      }
      return { parts: parts.filter((p) => p.length), props: f.properties || {} }
    })
    // .shp / .shx
    const bboxOf = (parts) => { let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity; for (const p of parts) for (const q of p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c) c = q[0]; if (q[1] > d) d = q[1] } return [a, b, c, d] }
    const contentLen = (r) => (st === 1 ? 20 : 44 + 4 * r.parts.length + 16 * r.parts.reduce((s, p) => s + p.length, 0))
    const shpLen = 100 + recs.reduce((s, r) => s + 8 + contentLen(r), 0)
    const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(100 + 8 * recs.length))
    const all = bboxOf(recs.flatMap((r) => r.parts))
    for (const [dv, len] of [[shp, shpLen], [shx, 100 + 8 * recs.length]]) {
      dv.setInt32(0, 9994, false); dv.setInt32(24, len / 2, false); dv.setInt32(28, 1000, true); dv.setInt32(32, st, true)
      for (let k = 0; k < 4; k++) dv.setFloat64(36 + 8 * k, all[k], true)
    }
    let off = 100
    recs.forEach((r, i) => {
      const cl = contentLen(r)
      shx.setInt32(100 + 8 * i, off / 2, false); shx.setInt32(104 + 8 * i, cl / 2, false)
      shp.setInt32(off, i + 1, false); shp.setInt32(off + 4, cl / 2, false); off += 8
      shp.setInt32(off, st, true)
      if (st === 1) { shp.setFloat64(off + 4, r.parts[0][0][0], true); shp.setFloat64(off + 12, r.parts[0][0][1], true); off += 20; return }
      const bb = bboxOf(r.parts), np = r.parts.length, npt = r.parts.reduce((s, p) => s + p.length, 0)
      for (let k = 0; k < 4; k++) shp.setFloat64(off + 4 + 8 * k, bb[k], true)
      shp.setInt32(off + 36, np, true); shp.setInt32(off + 40, npt, true)
      let o2 = off + 44, start = 0
      for (const p of r.parts) { shp.setInt32(o2, start, true); o2 += 4; start += p.length }
      for (const p of r.parts) for (const q of p) { shp.setFloat64(o2, q[0], true); shp.setFloat64(o2 + 8, q[1], true); o2 += 16 }
      off += cl
    })
    // .dbf：字段名限 10 个 ASCII 字符；全为数值（或空）的列落 N，其余落 C
    const useGbk = normEncoding(opts.encoding) === 'gbk'
    const enc = (s) => encodeText(s, useGbk ? 'gbk' : 'utf-8').bytes
    const keys = [...new Set(recs.flatMap((r) => Object.keys(r.props)))]
    const used = new Set()
    const fields = keys.map((k, idx) => {
      let nm = String(k).replace(/[^A-Za-z0-9_]/g, '').slice(0, 10).toUpperCase() || ('FIELD' + (idx + 1))
      if (/^\d/.test(nm)) nm = ('F' + nm).slice(0, 10)
      let u = nm, n = 1
      while (used.has(u)) { const sfx = String(n++); u = nm.slice(0, 10 - sfx.length) + sfx }
      used.add(u)
      const vals = recs.map((r) => r.props[k])
      const numeric = vals.every((v) => v == null || v === '' || (typeof v === 'number' && Number.isFinite(v)))
      if (numeric && vals.some((v) => typeof v === 'number')) {
        let dec = 0
        for (const v of vals) if (typeof v === 'number') { const s = String(v); const d = s.includes('e') ? 6 : (s.split('.')[1] || '').length; if (d > dec) dec = d }
        dec = Math.min(dec, 8)
        let len = 1
        for (const v of vals) if (typeof v === 'number') len = Math.max(len, v.toFixed(dec).length)
        return { key: k, name: u, type: 'N', len: Math.min(Math.max(len, 1), 19), dec: Math.min(dec, 15) }
      }
      let len = 1
      for (const v of vals) { const b = enc(v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v))); if (b.length > len) len = b.length }
      return { key: k, name: u, type: 'C', len: Math.min(254, len), dec: 0 }
    })
    const recLen = 1 + fields.reduce((s, f) => s + f.len, 0)
    const hdrLen = 32 + 32 * fields.length + 1
    const dbf = new Uint8Array(hdrLen + recLen * recs.length + 1)
    const dv = new DataView(dbf.buffer)
    const now = new Date()
    dbf[0] = 0x03; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate()
    dv.setUint32(4, recs.length, true); dv.setUint16(8, hdrLen, true); dv.setUint16(10, recLen, true)
    fields.forEach((f, i) => {
      const o = 32 + 32 * i
      for (let c = 0; c < f.name.length; c++) dbf[o + c] = f.name.charCodeAt(c)
      dbf[o + 11] = f.type.charCodeAt(0); dbf[o + 16] = f.len; dbf[o + 17] = f.dec
    })
    dbf[hdrLen - 1] = 0x0D
    recs.forEach((r, i) => {
      let o = hdrLen + recLen * i
      dbf[o++] = 0x20
      for (const f of fields) {
        const v = r.props[f.key]
        dbf.fill(0x20, o, o + f.len)
        if (f.type === 'N') {
          if (typeof v === 'number' && Number.isFinite(v)) { const s = v.toFixed(f.dec).slice(0, f.len); for (let c = 0; c < s.length; c++) dbf[o + f.len - s.length + c] = s.charCodeAt(c) }
        } else if (v != null) {
          let b = enc(typeof v === 'object' ? JSON.stringify(v) : String(v))
          if (b.length > f.len) {
            // 截断不能劈开多字节字符：UTF-8 退到首字节、GBK 按双字节对齐退
            let cut = f.len
            if (!useGbk) { while (cut > 0 && (b[cut] & 0xC0) === 0x80) cut-- } else { let k2 = 0; while (k2 < cut) { const step = b[k2] >= 0x80 ? 2 : 1; if (k2 + step > cut) break; k2 += step } cut = k2 }
            b = b.subarray(0, cut)
          }
          dbf.set(b, o)
        }
        o += f.len
      }
    })
    dbf[dbf.length - 1] = 0x1A
    return [
      file(base + '.shp', new Uint8Array(shp.buffer)), file(base + '.shx', new Uint8Array(shx.buffer)), file(base + '.dbf', dbf),
      file(base + '.prj', PRJ_WGS84), file(base + '.cpg', useGbk ? '936' : 'UTF-8')
    ]
  }

  /* ===================== 几何 ===================== */
  function vincenty(lon1, lat1, lon2, lat2) {
    const L = wrapDelta(lon2 - lon1) * toRad
    const U1 = Math.atan((1 - WGS_F) * Math.tan(lat1 * toRad)), U2 = Math.atan((1 - WGS_F) * Math.tan(lat2 * toRad))
    const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2)
    let lam = L, sinS, cosS, sig, cos2a, cos2sm
    for (let it = 0; it < 200; it++) {
      const sl = Math.sin(lam), cl = Math.cos(lam)
      sinS = Math.sqrt((cU2 * sl) ** 2 + (cU1 * sU2 - sU1 * cU2 * cl) ** 2)
      if (sinS === 0) return 0
      cosS = sU1 * sU2 + cU1 * cU2 * cl
      sig = Math.atan2(sinS, cosS)
      const sa = cU1 * cU2 * sl / sinS
      cos2a = 1 - sa * sa
      cos2sm = cos2a !== 0 ? cosS - 2 * sU1 * sU2 / cos2a : 0
      const C = WGS_F / 16 * cos2a * (4 + WGS_F * (4 - 3 * cos2a))
      const prev = lam
      lam = L + (1 - C) * WGS_F * sa * (sig + C * sinS * (cos2sm + C * cosS * (-1 + 2 * cos2sm * cos2sm)))
      if (Math.abs(lam - prev) < 1e-12) {
        const u2 = cos2a * (WGS_A * WGS_A - WGS_B * WGS_B) / (WGS_B * WGS_B)
        const A = 1 + u2 / 16384 * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)))
        const B = u2 / 1024 * (256 + u2 * (-128 + u2 * (74 - 47 * u2)))
        const ds = B * sinS * (cos2sm + B / 4 * (cosS * (-1 + 2 * cos2sm * cos2sm) - B / 6 * cos2sm * (-3 + 4 * sinS * sinS) * (-3 + 4 * cos2sm * cos2sm)))
        return WGS_B * A * (sig - ds) / 1000
      }
    }
    return haversine(lon1, lat1, lon2, lat2)   // 近对跖点不收敛：退回球面
  }
  function haversine(lon1, lat1, lon2, lat2) {
    const dLat = (lat2 - lat1) * toRad, dLon = wrapDelta(lon2 - lon1) * toRad
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2
    return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(a)))
  }
  const ll = (a, b) => (Array.isArray(a) ? [a[0], a[1]] : [a, b])
  const ptsIn = (v) => (Array.isArray(v) ? v : (v && Array.isArray(v.points) ? v.points : []))
  function signedArea(pts) {   // 经纬度平面上的有向面积（>0 逆时针），只用来判方向
    const u = unwrap(pts)
    let s = 0
    for (let i = 0, n = u.length; i < n; i++) { const a = u[i], b = u[(i + 1) % n]; s += a[0] * b[1] - b[0] * a[1] }
    return s / 2
  }
  // 收集坐标并保留环结构：点列（等值线 / Polygon / 航迹）各成一组，孤立点单独成组
  function collectRings(v, out) {
    if (!v) return out
    if (isPt(v)) { out.push([v]); return out }
    if (Array.isArray(v)) {
      if (v.length && isPt(v[0])) { const r = v.filter(isPt); if (r.length) out.push(r); return out }
      for (const x of v) collectRings(x, out)
      return out
    }
    if (typeof v === 'object') {
      if (Number.isFinite(v.lon) && Number.isFinite(v.lat)) { out.push([[v.lon, v.lat]]); return out }
      if (Array.isArray(v.points) && !isMap(v)) {
        if (v.points.length && !isPt(v.points[0]) && v.points.every((q) => q && Number.isFinite(q.lon) && Number.isFinite(q.lat))) out.push(v.points.map((q) => [q.lon, q.lat]))
        else collectRings(v.points, out)
      }
      if (Array.isArray(v.contours)) collectRings(v.contours, out)
      if (Array.isArray(v.peaks)) collectRings(v.peaks, out)
      if (isMap(v)) { collectRings(v.beams, out); collectRings(v.polygons, out); collectRings(v.points, out); collectRings(v.stations, out) }
    }
    return out
  }
  const wl = (x) => (x >= -180 && x < 180 ? x : geo.wrapLon(x))
  const X_PI =Math.PI * 3000 / 180
  const gcj2bd = (lon, lat) => { const z = Math.sqrt(lon * lon + lat * lat) + 0.00002 * Math.sin(lat * X_PI); const t = Math.atan2(lat, lon) + 0.000003 * Math.cos(lon * X_PI); return [z * Math.cos(t) + 0.0065, z * Math.sin(t) + 0.006] }
  const bd2gcj = (lon, lat) => { const x = lon - 0.0065, y = lat - 0.006; const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI); const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI); return [z * Math.cos(t), z * Math.sin(t)] }

  const geo = {
    distance(a, b) { if (!isPt(a) || !isPt(b)) fail('geo.distance()：参数须为 [lon, lat]', 'geo.distance(): arguments must be [lon, lat]'); return vincenty(a[0], a[1], b[0], b[1]) },
    length(points) { const p = ptsIn(points); let s = 0; for (let i = 1; i < p.length; i++) s += vincenty(p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]); return s },
    perimeter(ring) { const p = geo.close(ptsIn(ring)); return geo.length(p) },
    area(ring) {
      const p = ptsIn(ring)
      if (p.length < 3) return 0
      let s = 0
      for (let i = 0, n = p.length; i < n; i++) {
        const a = p[i], b = p[(i + 1) % n]
        s += wrapDelta(b[0] - a[0]) * toRad * (2 + Math.sin(a[1] * toRad) + Math.sin(b[1] * toRad))
      }
      return Math.abs(s * R_AUTH * R_AUTH / 2)
    },
    // 经度取覆盖全部要素的最短连续区间：每个环先连续化，再在圆周上找最大空档；跨日界线时东经 > 180。
    // 不跨日界线、跨度 ≤ 180° 的数据结果与逐点取极值相同。
    bbox(v) {
      const rings = collectRings(v, [])
      if (!rings.length) return null
      let b = Infinity, d = -Infinity, full = false
      const iv = []
      for (const r of rings) {
        const u = r.length > 1 ? unwrap(r) : r
        let lo = Infinity, hi = -Infinity
        for (const q of u) { if (q[0] < lo) lo = q[0]; if (q[0] > hi) hi = q[0]; if (q[1] < b) b = q[1]; if (q[1] > d) d = q[1] }
        if (hi - lo >= 360) full = true
        const s = wl(lo)
        iv.push([s, s === lo ? hi : s + (hi - lo)])
      }
      if (full) return [-180, b, 180, d]
      iv.sort((x, y) => x[0] - y[0])
      const m = []
      for (const x of iv) { const t = m[m.length - 1]; if (t && x[0] <= t[1]) { if (x[1] > t[1]) t[1] = x[1] } else m.push([x[0], x[1]]) }
      // 末段越过 +180 后与开头几段相接：并到末段
      while (m.length > 1 && m[m.length - 1][1] >= m[0][0] + 360) { const f = m.shift(); const t = m[m.length - 1]; t[1] = Math.max(t[1], f[1] + 360) }
      if (m[0][1] - m[0][0] >= 360) return [-180, b, 180, d]
      // 最大空档；并列时取跨 ±180 的那个（即不跨日界线的取景）
      const n = m.length
      let best = n - 1, gap = m[0][0] + 360 - m[n - 1][1]
      for (let i = 0; i < n - 1; i++) { const g = m[i + 1][0] - m[i][1]; if (g > gap + 1e-9) { gap = g; best = i } }
      const w = m[(best + 1) % n][0]
      const west = wl(w)
      return [west, b, best === n - 1 ? m[n - 1][1] : west + (360 - gap), d]
    },
    centroid(ring) {
      const p = ptsIn(ring)
      if (!p.length) return null
      const u = unwrap(isClosedPts(p) ? p.slice(0, -1) : p)
      let A = 0, cx = 0, cy = 0
      for (let i = 0, n = u.length; i < n; i++) { const a = u[i], b = u[(i + 1) % n]; const k = a[0] * b[1] - b[0] * a[1]; A += k; cx += (a[0] + b[0]) * k; cy += (a[1] + b[1]) * k }
      if (Math.abs(A) < 1e-12) { const m = u.reduce((s, q) => [s[0] + q[0], s[1] + q[1]], [0, 0]); return [geo.wrapLon(m[0] / u.length), m[1] / u.length] }
      return [geo.wrapLon(cx / (3 * A)), cy / (3 * A)]
    },
    contains(ring, pt) {
      const p = ptsIn(ring)
      if (p.length < 3 || !isPt(pt)) return false
      const u = unwrap(p)
      let lo = Infinity, hi = -Infinity
      for (const q of u) { if (q[0] < lo) lo = q[0]; if (q[0] > hi) hi = q[0] }
      const mid = (lo + hi) / 2
      const x = mid + wrapDelta(pt[0] - mid)
      const y = pt[1]
      let inside = false
      for (let i = 0, j = u.length - 1; i < u.length; j = i++) {
        const xi = u[i][0], yi = u[i][1], xj = u[j][0], yj = u[j][1]
        if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) inside = !inside
      }
      return inside
    },
    levelAt(beam, lon, lat) {
      const pt = ll(lon, lat)
      let best = null
      for (const c of (beam && beam.contours) || []) if (c.points.length >= 3 && geo.contains(c.points, pt) && (best == null || c.level > best)) best = c.level
      return best
    },
    simplify(points, toleranceKm = 1) {
      const p = ptsIn(points)
      if (p.length < 3 || !(toleranceKm > 0)) return p.map((q) => [q[0], q[1]])
      const closed = isClosedPts(p)
      const u = unwrap(p)
      const lat0 = u.reduce((s, q) => s + q[1], 0) / u.length
      const kx = 111.32 * Math.cos(lat0 * toRad), ky = 110.574
      const xy = u.map((q) => [q[0] * kx, q[1] * ky])
      const keep = new Uint8Array(p.length)
      const tol2 = toleranceKm * toleranceKm
      const dp = (a, b) => {
        const stack = [[a, b]]
        while (stack.length) {
          const [s, e] = stack.pop()
          keep[s] = keep[e] = 1
          const [x1, y1] = xy[s], [x2, y2] = xy[e]
          const dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy
          let far = -1, fd = tol2
          for (let i = s + 1; i < e; i++) {
            let t = L2 ? ((xy[i][0] - x1) * dx + (xy[i][1] - y1) * dy) / L2 : 0
            t = Math.max(0, Math.min(1, t))
            const ex = xy[i][0] - (x1 + t * dx), ey = xy[i][1] - (y1 + t * dy)
            const d2 = ex * ex + ey * ey
            if (d2 > fd) { fd = d2; far = i }
          }
          if (far > 0) { stack.push([s, far]); stack.push([far, e]) }
        }
      }
      if (closed) {
        // 闭合环：首点与离首点最远的点都钉住，两半各自抽稀（单段 DP 在首尾重合时会退化）
        let far = 0, fd = -1
        for (let i = 1; i < p.length - 1; i++) { const d = (xy[i][0] - xy[0][0]) ** 2 + (xy[i][1] - xy[0][1]) ** 2; if (d > fd) { fd = d; far = i } }
        dp(0, far); dp(far, p.length - 1)
      } else dp(0, p.length - 1)
      const out = []
      for (let i = 0; i < p.length; i++) if (keep[i]) out.push([p[i][0], p[i][1]])
      if (closed && out.length < 4) return p.map((q) => [q[0], q[1]])   // 抽成不足三角形：保留原环
      return out
    },
    densify(points, maxStepKm = 50) {
      const p = ptsIn(points)
      if (p.length < 2 || !(maxStepKm > 0)) return p.map((q) => [q[0], q[1]])
      const vec = (q) => { const la = q[1] * toRad, lo = q[0] * toRad; return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] }
      const out = [[p[0][0], p[0][1]]]
      for (let i = 1; i < p.length; i++) {
        const a = p[i - 1], b = p[i]
        const d = haversine(a[0], a[1], b[0], b[1])
        const n = Math.ceil(d / maxStepKm)
        if (n > 1) {
          const va = vec(a), vb = vec(b)
          const om = d / R_MEAN, so = Math.sin(om)
          for (let k = 1; k < n; k++) {
            const t = k / n, wa = Math.sin((1 - t) * om) / so, wb = Math.sin(t * om) / so
            const x = wa * va[0] + wb * vb[0], y = wa * va[1] + wb * vb[1], z = wa * va[2] + wb * vb[2]
            let lon = Math.atan2(y, x) / toRad
            lon = a[0] + wrapDelta(lon - a[0])
            out.push([lon, Math.atan2(z, Math.hypot(x, y)) / toRad])
          }
        }
        out.push([b[0], b[1]])
      }
      return out
    },
    close(points) { const p = ptsIn(points).map((q) => [q[0], q[1]]); if (p.length >= 2 && !isClosedPts(p)) p.push([p[0][0], p[0][1]]); return p },
    open(points) { const p = ptsIn(points).map((q) => [q[0], q[1]]); if (isClosedPts(p) && p.length > 1) p.pop(); return p },
    isClosed(points) { return isClosedPts(ptsIn(points)) },
    orient(points, dir = 'ccw') {
      const p = ptsIn(points).map((q) => [q[0], q[1]])
      const s = signedArea(isClosedPts(p) ? p.slice(0, -1) : p)
      return ((dir === 'cw' && s > 0) || (dir !== 'cw' && s < 0)) ? p.reverse() : p
    },
    round(points, digits = 3) { return ptsIn(points).map((q) => [+q[0].toFixed(digits), +q[1].toFixed(digits)]) },
    wrapLon(lon) { return ((lon + 180) % 360 + 360) % 360 - 180 },
    dms(value, axis = 'lat', digits = 1) {
      if (!Number.isFinite(value)) return ''
      const hemi = axis === 'lon' ? (value < 0 ? 'W' : 'E') : (value < 0 ? 'S' : 'N')
      const f = 10 ** digits
      let tot = Math.round(Math.abs(value) * 3600 * f)
      const sec = (tot % (60 * f)) / f; tot = Math.floor(tot / (60 * f))
      const min = tot % 60, deg = Math.floor(tot / 60)
      return `${deg}°${String(min).padStart(2, '0')}′${sec.toFixed(digits).padStart(digits ? 3 + digits : 2, '0')}″${hemi}`
    },
    toGCJ02(a, b) { const [lon, lat] = ll(a, b); return wgs2gcj(lon, lat) },
    fromGCJ02(a, b) { const [lon, lat] = ll(a, b); return gcj2wgs(lon, lat) },
    toBD09(a, b) { const [lon, lat] = ll(a, b); const g = wgs2gcj(lon, lat); return gcj2bd(g[0], g[1]) },
    fromBD09(a, b) { const [lon, lat] = ll(a, b); const g = bd2gcj(lon, lat); return gcj2wgs(g[0], g[1]) },
    // 等经纬度（plate carrée）投影适配到画布：1° 经 = 1° 纬，按 bbox 留边居中
    fit(bbox, width, height, padding = 0) {
      const bb = Array.isArray(bbox) && bbox.length === 4 ? bbox : geo.bbox(bbox)
      if (!bb) fail('geo.fit()：无有效的外包范围', 'geo.fit(): nothing to fit')
      const [x0, y0, x1, y1] = bb
      const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9)
      const k = Math.min((width - 2 * padding) / w, (height - 2 * padding) / h)
      const ox = (width - k * w) / 2, oy = (height - k * h) / 2
      // 经度就近取到取景中心 ±180° 内：跨日界线的取景里 −179° 与 179° 落在相邻位置，环不被横向撕开
      const cx = (x0 + x1) / 2
      const x = (lon) => { const d = lon - cx; return ox + ((d >= -180 && d <= 180 ? lon : cx + wrapDelta(d)) - x0) * k }
      const y = (lat) => oy + (y1 - lat) * k
      const point = (q) => [x(q[0]), y(q[1])]
      return { x, y, point, scale: k, bbox: [x0, y0, x1, y1] }
    }
  }

  /* ===================== 配色 / 格式化 ===================== */
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  const h2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')
  function rgbOf(c) {
    if (c && typeof c === 'object') return { r: +c.r || 0, g: +c.g || 0, b: +c.b || 0 }
    const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(String(c || '').trim())
    if (!m) fail(`color：无法识别的颜色「${c}」`, `color: unrecognized color "${c}"`)
    const s = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1]
    return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) }
  }
  const hexOf = (r, g, b) => (r && typeof r === 'object' ? '#' + h2(r.r) + h2(r.g) + h2(r.b) : '#' + h2(r) + h2(g) + h2(b))
  // 'gain'＝覆盖图蓝→红渐变（与地图 gainHex 同式）；'jet'＝MATLAB jet（天线方向图默认色带）
  const RAMPS = {
    gain(t) {
      const h = (1 - t) * 240 / 360, s = 0.9, l = 0.55, a = s * Math.min(l, 1 - l)
      const f = (n) => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)) }
      return hexOf(f(0) * 255, f(8) * 255, f(4) * 255)
    },
    jet(t) {
      const c = (x) => clamp01(1.5 - Math.abs(4 * t - x))
      return hexOf(c(3) * 255, c(2) * 255, c(1) * 255)
    },
    gray(t) { return hexOf(t * 255, t * 255, t * 255) }
  }
  const color = {
    rgb: rgbOf,
    hex: hexOf,
    kml(c, opacity = 1) { const { r, g, b } = rgbOf(c); return h2(clamp01(opacity) * 255) + h2(b) + h2(g) + h2(r) },
    css(c, opacity = 1) { const { r, g, b } = rgbOf(c); return opacity >= 1 ? hexOf(r, g, b) : `rgba(${r},${g},${b},${+clamp01(opacity).toFixed(3)})` },
    mix(a, b, t = 0.5) { const x = rgbOf(a), y = rgbOf(b), k = clamp01(t); return hexOf(x.r + (y.r - x.r) * k, x.g + (y.g - x.g) * k, x.b + (y.b - x.b) * k) },
    ramp(t, scheme = 'gain') {
      const f = RAMPS[scheme]
      if (!f) fail(`color.ramp()：未知色带「${scheme}」（可选：${Object.keys(RAMPS).join(' / ')}）`, `color.ramp(): unknown scheme "${scheme}" (one of: ${Object.keys(RAMPS).join(' / ')})`)
      return f(clamp01(Number(t) || 0))
    }
  }
  function fmt(x, digits = 3) {
    const n = typeof x === 'number' ? x : Number(x)
    if (!Number.isFinite(n)) return ''
    const s = n.toFixed(Math.max(0, Math.min(20, digits | 0)))
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s
  }
  const xml = {
    esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;') },
    cdata(s) { return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>' }
  }

  return { file, zip, png, gxt, gxtJson, kml, geojson, features, csv, shapefile, geo, color, fmt, xml }
}

// 标准库全局名（runtime 按这个顺序注入；beammap.dts.txt 逐个声明）
export const STDLIB_NAMES = ['file', 'zip', 'png', 'gxt', 'gxtJson', 'kml', 'geojson', 'features', 'csv', 'shapefile', 'geo', 'color', 'fmt', 'xml']
