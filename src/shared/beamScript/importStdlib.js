// 可编程波束地图 · 导入脚本的标准库（纯 ESM：Worker 沙箱里跑，Node 测试直接调）。
//
// 导入脚本拿到的是「文件」，要交回的是「波束」（形状见 importModel.js）。这里给的是把各种文件读成结构的那一层：
//   text      字节 → 文本（缺省自动识别 BOM / UTF-8 / GBK）
//   json      文本 → 对象（报错带行列）
//   csv       文本 → 行（自动识别 , ; Tab 分隔，header:true 出对象数组）
//   xml       文本 → 极简 DOM（miniXml.js：getElementsByTagName / textContent / getAttribute …）
//   unzip     ZIP / KMZ → 文件数组（与 files 同形，可递归交给其它函数）
//   gxt / gxtJson / kml   本软件内置的三种解析器原样开放（与文件管理「导入」同一份代码）
//   geojson   GeoJSON → 扁平要素表（Multi* / GeometryCollection 拆开）
//   shapefile .shp + .dbf（+ .cpg）→ 要素表；mif   MapInfo .mif + .mid → 要素表
//   num       宽松数值解析（'  12.5 '、'1,234'、'12.5dBW' → 数值；解析不出 → null）
// ★ 函数名与入参形状是公开 API（类型声明见 beamimport.dts.txt）：只增不改。
import { unzipSync } from 'fflate'
import { parseGxt } from '../../viz/gxt/parse.js'
import { parseGxtJson } from '../../viz/gxt/json.js'
import { parseKmlBeams } from '../../viz/kml/parse.js'
import { parseXml, MiniDOMParser } from './miniXml.js'

export const IMPORT_STDLIB_NAMES = ['text', 'json', 'csv', 'xml', 'unzip', 'gxt', 'gxtJson', 'kml', 'geojson', 'shapefile', 'mif', 'num']

/* ---------------- 字节 / 文本 ---------------- */
function latin1(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  return s
}
/** 字节 → { text, encoding }：BOM → UTF-8 / UTF-16；否则严格 UTF-8 试解，失败退 GBK，再失败退 Latin-1 */
export function sniffDecode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(b.subarray(3)), encoding: 'utf-8-bom' }
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' }
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' } } catch { /* 不是 UTF-8 */ }
  try { return { text: new TextDecoder('gbk').decode(b), encoding: 'gbk' } } catch { /* 运行环境不认 GBK */ }
  return { text: latin1(b), encoding: 'latin1' }
}
const ENC_ALIAS = { utf8: 'utf-8', 'utf-8-bom': 'utf-8', gb2312: 'gbk', gb18030: 'gb18030', cp936: 'gbk', 'windows-936': 'gbk', latin1: 'iso-8859-1', 'latin-1': 'iso-8859-1', ansi: 'gbk' }
function decodeAs(bytes, enc) {
  const e = String(enc || '').trim().toLowerCase()
  if (!e || e === 'auto') return sniffDecode(bytes).text
  const name = ENC_ALIAS[e] || e
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  const skip = (name === 'utf-8' && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) ? 3 : 0
  return new TextDecoder(name).decode(skip ? b.subarray(skip) : b)
}

/** 输入文件：{ name, base, ext, size, bytes, text（首次读取时自动解码）, encoding } */
export function makeInputFile(name, bytes) {
  const nm = String(name || 'file')
  const leaf = nm.split(/[\\/]/).pop()
  const dot = leaf.lastIndexOf('.')
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  let dec = null
  const f = {
    name: nm, base: dot > 0 ? leaf.slice(0, dot) : leaf, ext: dot > 0 ? leaf.slice(dot + 1).toLowerCase() : '', size: b.byteLength, bytes: b,
    get text() { if (!dec) dec = sniffDecode(b); return dec.text },
    get encoding() { if (!dec) dec = sniffDecode(b); return dec.encoding }
  }
  return Object.freeze(f)
}
const isFileLike = (x) => !!(x && typeof x === 'object' && x.bytes instanceof Uint8Array && typeof x.name === 'string')

export function createImportStdlib(lang = 'zh') {
  const T = (zh, en) => (lang === 'en' ? en : zh)
  const fail = (zh, en) => { throw new Error(T(zh, en)) }
  const textOf = (x, enc) => {
    if (typeof x === 'string') return x
    if (isFileLike(x)) return enc ? decodeAs(x.bytes, enc) : x.text
    if (x instanceof Uint8Array || x instanceof ArrayBuffer || ArrayBuffer.isView(x)) return decodeAs(x instanceof Uint8Array ? x : new Uint8Array(x.buffer || x, x.byteOffset || 0, x.byteLength), enc)
    if (x == null) return ''
    return String(x)
  }
  const bytesOf = (x) => {
    if (isFileLike(x)) return x.bytes
    if (x instanceof Uint8Array) return x
    if (x instanceof ArrayBuffer) return new Uint8Array(x)
    if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength)
    if (typeof x === 'string') return new TextEncoder().encode(x)
    fail('需要文件或字节数组', 'expected a file or a byte array')
  }

  /* ---------------- 文本类 ---------------- */
  function text(x, encoding) { return textOf(x, encoding) }
  function json(x) {
    const s = textOf(x).replace(/^﻿/, '')
    try { return JSON.parse(s) }
    catch (e) {
      const m = /position (\d+)/.exec(String(e.message))
      if (m) { const p = +m[1]; const ln = s.slice(0, p).split('\n'); fail(`JSON 解析失败：第 ${ln.length} 行第 ${ln[ln.length - 1].length + 1} 列`, `JSON parse error at line ${ln.length}, column ${ln[ln.length - 1].length + 1}`) }
      fail('JSON 解析失败：' + e.message, 'JSON parse error: ' + e.message)
    }
  }
  // RFC 4180：双引号包裹、"" 转义、引号内可含分隔符与换行
  function csv(x, opts = {}) {
    const s = textOf(x, opts.encoding).replace(/^﻿/, '')
    let sep = typeof opts.delimiter === 'string' && opts.delimiter ? opts.delimiter : null
    if (!sep) {
      const first = s.slice(0, s.search(/\r?\n|$/))
      const cnt = (c) => first.split(c).length - 1
      const cands = [[',', cnt(',')], [';', cnt(';')], ['\t', cnt('\t')], ['|', cnt('|')]].sort((a, b) => b[1] - a[1])
      sep = cands[0][1] > 0 ? cands[0][0] : ','
    }
    const rows = []
    let row = [], cell = '', q = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (q) {
        if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++ } else q = false }
        else cell += c
        continue
      }
      if (c === '"' && cell === '') { q = true; continue }
      if (c === sep) { row.push(cell); cell = ''; continue }
      if (c === '\r') continue
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue }
      cell += c
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
    const list = rows.filter((r) => r.some((v) => String(v).trim() !== ''))
    if (!opts.header) return list
    const head = (list.shift() || []).map((h, i) => String(h).trim() || 'col' + (i + 1))
    const seen = new Map()
    const keys = head.map((h) => { const n = (seen.get(h) || 0) + 1; seen.set(h, n); return n > 1 ? `${h}_${n}` : h })
    return list.map((r) => { const o = {}; keys.forEach((k, i) => { o[k] = r[i] != null ? r[i] : '' }); return o })
  }
  function xml(x) { return parseXml(textOf(x)) }
  function unzip(x) {
    const b = bytesOf(x)
    let ent
    try { ent = unzipSync(b) } catch (e) { fail('不是有效的 ZIP / KMZ：' + e.message, 'not a valid ZIP / KMZ: ' + e.message) }
    return Object.keys(ent).filter((k) => !k.endsWith('/')).map((k) => makeInputFile(k, ent[k]))
  }

  /* ---------------- 内置解析器 ---------------- */
  function gxt(x) { return parseGxt(textOf(x)) }
  function gxtJson(x) { return parseGxtJson(textOf(x)) }
  function kml(x) {
    let src = x
    const b = isFileLike(x) || x instanceof Uint8Array ? bytesOf(x) : null
    if (b && b[0] === 0x50 && b[1] === 0x4b) {   // 'PK'：KMZ（ZIP 里取 doc.kml，没有就第一份 .kml）
      const list = unzip(b).filter((f) => f.ext === 'kml')
      if (!list.length) fail('KMZ 里没有 .kml', 'no .kml inside the KMZ')
      src = list.find((f) => /(^|\/)doc\.kml$/i.test(f.name)) || list[0]
    }
    const hadDP = typeof globalThis.DOMParser !== 'undefined'
    if (!hadDP) globalThis.DOMParser = MiniDOMParser
    try { return parseKmlBeams(textOf(src)) }
    finally { if (!hadDP) delete globalThis.DOMParser }
  }

  /* ---------------- GeoJSON ---------------- */
  // → [{ type:'Polygon', rings:[外环, 洞…], props } | { type:'LineString', points, props } | { type:'Point', point, props }]
  function geojson(x) {
    const o = (typeof x === 'object' && x && !isFileLike(x) && !(x instanceof Uint8Array)) ? x : json(x)
    const out = []
    const pt = (c) => (Array.isArray(c) && Number.isFinite(+c[0]) && Number.isFinite(+c[1]) ? [+c[0], +c[1]] : null)
    const line = (cs) => (cs || []).map(pt).filter(Boolean)
    const geom = (g, props) => {
      if (!g) return
      switch (g.type) {
        case 'Polygon': out.push({ type: 'Polygon', rings: (g.coordinates || []).map(line).filter((r) => r.length >= 3), props }); break
        case 'MultiPolygon': for (const p of (g.coordinates || [])) out.push({ type: 'Polygon', rings: (p || []).map(line).filter((r) => r.length >= 3), props }); break
        case 'LineString': out.push({ type: 'LineString', points: line(g.coordinates), props }); break
        case 'MultiLineString': for (const l of (g.coordinates || [])) out.push({ type: 'LineString', points: line(l), props }); break
        case 'Point': { const p = pt(g.coordinates); if (p) out.push({ type: 'Point', point: p, props }); break }
        case 'MultiPoint': for (const c of (g.coordinates || [])) { const p = pt(c); if (p) out.push({ type: 'Point', point: p, props }) } break
        case 'GeometryCollection': for (const s of (g.geometries || [])) geom(s, props); break
        default: break
      }
    }
    const feats = o && o.type === 'FeatureCollection' ? (o.features || []) : (o && o.type === 'Feature' ? [o] : (o && o.type ? [{ type: 'Feature', geometry: o, properties: {} }] : []))
    for (const f of feats) geom(f && f.geometry, (f && f.properties) || {})
    return out.filter((f) => (f.type === 'Polygon' ? f.rings.length : f.type === 'LineString' ? f.points.length >= 2 : true))
  }

  /* ---------------- Shapefile（ESRI 白皮书 + dBASE III）---------------- */
  // 入参：文件数组（unzip 的结果 / 一起选中的 .shp .dbf .cpg .prj）或单个 ZIP。按主文件名配套，每套一个图层。
  // → [{ layer, type:'Polygon'|'PolyLine'|'Point'|'MultiPoint', rings?|points?|point?, props }]（坐标照原样；.prj 是投影坐标系时给 layer.projected）
  function shapefile(x) {
    let list = Array.isArray(x) ? x : [x]
    list = list.flatMap((f) => (isFileLike(f) && (f.ext === 'zip' || (f.bytes[0] === 0x50 && f.bytes[1] === 0x4b && f.ext !== 'shp' && f.ext !== 'dbf')) ? unzip(f) : [f])).filter(isFileLike)
    const sets = new Map()
    for (const f of list) {
      const key = f.name.replace(/\.[^./\\]+$/, '').toLowerCase()
      if (!sets.has(key)) sets.set(key, {})
      sets.get(key)[f.ext] = f
    }
    const out = []
    for (const [key, set] of sets) {
      if (!set.shp) continue
      const layer = (set.shp.base || key)
      const enc = set.cpg ? set.cpg.text.trim() : ''
      const recs = set.dbf ? readDbf(set.dbf.bytes, enc) : []
      const shapes = readShp(set.shp.bytes)
      const projected = !!(set.prj && /PROJCS/i.test(set.prj.text))
      shapes.forEach((s, i) => { if (s) out.push({ layer, projected, ...s, props: recs[i] || {} }) })
    }
    if (!out.length && !sets.size) fail('没有 .shp 文件', 'no .shp file')
    return out
  }
  function readShp(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    if (b.byteLength < 100 || dv.getInt32(0, false) !== 9994) fail('不是有效的 .shp（文件头不对）', 'not a valid .shp (bad header)')
    const out = []
    let p = 100
    while (p + 8 <= b.byteLength) {
      const len = dv.getInt32(p + 4, false) * 2
      const c = p + 8
      if (c + 4 > b.byteLength) break
      const t = dv.getInt32(c, true)
      const base = t % 10 === 1 && t !== 31 ? 1 : t === 3 || t === 13 || t === 23 ? 3 : t === 5 || t === 15 || t === 25 ? 5 : t === 8 || t === 18 || t === 28 ? 8 : 0
      if (base === 1) out.push({ type: 'Point', point: [dv.getFloat64(c + 4, true), dv.getFloat64(c + 12, true)] })
      else if (base === 3 || base === 5) {
        const np = dv.getInt32(c + 36, true), nv = dv.getInt32(c + 40, true)
        const parts = []
        for (let k = 0; k < np; k++) parts.push(dv.getInt32(c + 44 + k * 4, true))
        const v0 = c + 44 + np * 4
        const rings = []
        for (let k = 0; k < np; k++) {
          const a = parts[k], z = k + 1 < np ? parts[k + 1] : nv
          const ring = []
          for (let q = a; q < z; q++) ring.push([dv.getFloat64(v0 + q * 16, true), dv.getFloat64(v0 + q * 16 + 8, true)])
          rings.push(ring)
        }
        out.push(base === 5 ? { type: 'Polygon', rings } : { type: 'PolyLine', rings })
      } else if (base === 8) {
        const nv = dv.getInt32(c + 36, true), pts = []
        for (let q = 0; q < nv; q++) pts.push([dv.getFloat64(c + 40 + q * 16, true), dv.getFloat64(c + 48 + q * 16, true)])
        out.push({ type: 'MultiPoint', points: pts })
      } else out.push(null)   // Null / MultiPatch：占位保持与 .dbf 逐行对应
      p = c + len
    }
    return out
  }
  function readDbf(b, enc) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
    if (b.byteLength < 32) return []
    const n = dv.getInt32(4, true), hlen = dv.getInt16(8, true), rlen = dv.getInt16(10, true)
    const fields = []
    for (let o = 32; o + 32 <= hlen && b[o] !== 0x0d; o += 32) {
      let name = ''
      for (let k = 0; k < 11 && b[o + k]; k++) name += String.fromCharCode(b[o + k])
      fields.push({ name, type: String.fromCharCode(b[o + 11]), len: b[o + 16] })
    }
    // 字段文本：.cpg 给了编码按它，否则严格 UTF-8 试解、失败退 GBK（老 ArcMap 中文）
    const utf8 = /utf-?8/i.test(enc || '')
    const dec = (u8) => { if (enc && !utf8) { try { return decodeAs(u8, enc) } catch { /* 不认识的编码名 */ } } return sniffDecode(u8).text }
    const out = []
    for (let r = 0; r < n; r++) {
      const s = hlen + r * rlen
      if (s + rlen > b.byteLength) break
      const rec = {}
      let o = s + 1
      for (const f of fields) {
        const raw = dec(b.subarray(o, o + f.len)).replace(/\u0000/g, '').trim()
        rec[f.name] = (f.type === 'N' || f.type === 'F') ? (raw === '' ? null : num(raw)) : f.type === 'L' ? /^[TtYy]$/.test(raw) : raw
        o += f.len
      }
      out.push(rec)
    }
    return out
  }

  /* ---------------- MapInfo MIF / MID ---------------- */
  // → [{ type:'Region'|'Pline'|'Line'|'Point', rings?|points?|point?, props }]；Charset 认 WindowsSimpChinese（GBK）/ UTF-8 / Neutral
  function mif(mifX, midX) {
    const rawHead = isFileLike(mifX) ? latin1(mifX.bytes.subarray(0, 4096)) : textOf(mifX).slice(0, 4096)
    const cs = (/Charset\s+"([^"]+)"/i.exec(rawHead) || [])[1] || ''
    const enc = /SimpChinese|936|gbk/i.test(cs) ? 'gbk' : /utf-?8/i.test(cs) ? 'utf-8' : /Neutral|Latin1|1252/i.test(cs) ? 'iso-8859-1' : ''
    const mt = textOf(mifX, isFileLike(mifX) && enc ? enc : undefined)
    const lines = mt.split(/\r?\n/)
    let i = 0, delim = '\t'
    const cols = []
    for (; i < lines.length; i++) {
      const ln = lines[i].trim()
      if (/^Data\b/i.test(ln)) { i++; break }
      const dm = /^Delimiter\s+"(.)"/i.exec(ln); if (dm) delim = dm[1]
      const cm = /^Columns\s+(\d+)/i.exec(ln)
      if (cm) { const k = +cm[1]; for (let j = 1; j <= k; j++) cols.push((lines[i + j] || '').trim().split(/\s+/)[0] || 'col' + j); i += k }
    }
    const xy = (s) => { const a = s.trim().split(/\s+/).map(Number); return (Number.isFinite(a[0]) && Number.isFinite(a[1])) ? [a[0], a[1]] : null }
    const objs = []
    while (i < lines.length) {
      const ln = lines[i].trim()
      let m
      if (!ln) { i++; continue }
      if ((m = /^Region\s+(\d+)/i.exec(ln))) {
        const rings = []; i++
        for (let k = 0; k < +m[1] && i < lines.length; k++) {
          const cnt = parseInt(lines[i++], 10)
          const ring = []
          for (let q = 0; q < cnt && i < lines.length; q++) { const p = xy(lines[i++]); if (p) ring.push(p) }
          rings.push(ring)
        }
        objs.push({ type: 'Region', rings })
      } else if ((m = /^Pline(?:\s+Multiple\s+(\d+))?(?:\s+(\d+))?/i.exec(ln))) {
        const rings = []; i++
        if (m[1]) {
          for (let k = 0; k < +m[1] && i < lines.length; k++) { const cnt = parseInt(lines[i++], 10); const r = []; for (let q = 0; q < cnt && i < lines.length; q++) { const p = xy(lines[i++]); if (p) r.push(p) } rings.push(r) }
        } else {
          const cnt = m[2] ? +m[2] : parseInt(lines[i++], 10)
          const r = []; for (let q = 0; q < cnt && i < lines.length; q++) { const p = xy(lines[i++]); if (p) r.push(p) } rings.push(r)
        }
        objs.push({ type: 'Pline', rings })
      } else if ((m = /^Line\s+(.+)$/i.exec(ln))) {
        const a = m[1].trim().split(/\s+/).map(Number); i++
        objs.push({ type: 'Line', points: [[a[0], a[1]], [a[2], a[3]]] })
      } else if ((m = /^Point\s+(.+)$/i.exec(ln))) { objs.push({ type: 'Point', point: xy(m[1]) }); i++ }
      else if (/^None\b/i.test(ln)) { objs.push(null); i++ }
      else if (/^(Text|Rect|RoundRect|Ellipse|Arc|Multipoint|Collection)\b/i.test(ln)) { objs.push(null); i++ }   // 不认的对象占位，保持与 .mid 逐行对应
      else i++   // 样式行（Pen / Brush / Symbol / Smooth / Center …）
    }
    let rows = []
    if (midX != null) rows = csv(isFileLike(midX) && enc ? decodeAs(midX.bytes, enc) : textOf(midX), { delimiter: delim })
    return objs.map((o, k) => (o ? { ...o, props: Object.fromEntries(cols.map((c, j) => [c, rows[k] ? rows[k][j] : undefined])) } : null)).filter(Boolean)
  }

  /* ---------------- 数值 ---------------- */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null
    if (v == null) return null
    const s = String(v).trim().replace(/^\+/, '')
    if (!s) return null
    const m = /^-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?|^-?\.\d+/.exec(s)
    if (!m) return null
    const n = Number(m[0].replace(/,/g, ''))
    return Number.isFinite(n) ? n : null
  }

  return { text, json, csv, xml, unzip, gxt, gxtJson, kml, geojson, shapefile, mif, num }
}
