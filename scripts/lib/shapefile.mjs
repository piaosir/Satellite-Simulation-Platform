// 极简 ZIP + Shapefile(SHP/DBF) 读取器 —— 只为构建脚本服务，不进运行时包，不引第三方依赖。
// Natural Earth 官方分发是 shapefile zip（比同内容 GeoJSON 小一个量级，naciscdn 直连也稳），
// 故直接读 zip 里的 .shp/.dbf，避免为构建脚本引入 shapefile/adm-zip 之类的依赖。
// 支持的几何：Null(0) / Point(1) / PolyLine(3) / Polygon(5)，以及带 Z/M 的 11/13/15/21/23/25（忽略 Z、M）。
import zlib from 'node:zlib'

// ---------- ZIP ----------
// 读中央目录（EOCD 起）→ 逐条按本地文件头定位数据 → store(0) 直取 / deflate(8) inflateRaw。
export function unzip(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break } }
  if (eocd < 0) throw new Error('不是 zip（找不到 EOCD）')
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = {}
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录项签名错')
    const method = buf.readUInt16LE(p + 10)
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), cmtLen = buf.readUInt16LE(p + 32)
    const lho = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    // 本地文件头的 name/extra 长度可与中央目录不同，必须各自读
    const lNameLen = buf.readUInt16LE(lho + 26), lExtraLen = buf.readUInt16LE(lho + 28)
    const data = buf.subarray(lho + 30 + lNameLen + lExtraLen, lho + 30 + lNameLen + lExtraLen + csize)
    out[name] = method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data)
    if (method !== 0 && method !== 8) throw new Error('不支持的压缩方式 ' + method)
    if (usize && out[name].length !== usize) throw new Error('解压长度不符：' + name)
    p += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

// ---------- DBF ----------
export function readDbf(buf, encoding = 'utf8') {
  const nRec = buf.readUInt32LE(4), hLen = buf.readUInt16LE(8), rLen = buf.readUInt16LE(10)
  const fields = []
  for (let p = 32; buf[p] !== 0x0d && p < hLen; p += 32) {
    let nm = buf.toString('latin1', p, p + 11); const z = nm.indexOf('\0'); if (z >= 0) nm = nm.slice(0, z)
    fields.push({ name: nm, type: String.fromCharCode(buf[p + 11]), len: buf[p + 16] })
  }
  const rows = new Array(nRec)
  for (let i = 0; i < nRec; i++) {
    let p = hLen + i * rLen + 1   // +1 跳过删除标记
    const rec = {}
    for (const f of fields) {
      const raw = buf.toString(encoding, p, p + f.len).replace(/\0/g, '').trim()
      rec[f.name] = f.type === 'N' || f.type === 'F' ? (raw === '' ? null : Number(raw))
        : f.type === 'L' ? /^[YyTt]$/.test(raw) : raw
      p += f.len
    }
    rows[i] = rec
  }
  return rows
}

// ---------- SHP ----------
const ringArea = (r) => { let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return a / 2 }

function shapeAt(buf, off, len) {
  const t = buf.readInt32LE(off)
  if (t === 0) return null
  if (t === 1 || t === 11 || t === 21) return { type: 'Point', coordinates: [buf.readDoubleLE(off + 4), buf.readDoubleLE(off + 12)] }
  if (t === 3 || t === 5 || t === 13 || t === 15 || t === 23 || t === 25) {
    const nParts = buf.readInt32LE(off + 36), nPts = buf.readInt32LE(off + 40)
    const parts = new Array(nParts)
    for (let i = 0; i < nParts; i++) parts[i] = buf.readInt32LE(off + 44 + i * 4)
    const pBase = off + 44 + nParts * 4
    const rings = []
    for (let i = 0; i < nParts; i++) {
      const s = parts[i], e = i + 1 < nParts ? parts[i + 1] : nPts
      const r = new Array(e - s)
      for (let k = s; k < e; k++) r[k - s] = [buf.readDoubleLE(pBase + k * 16), buf.readDoubleLE(pBase + k * 16 + 8)]
      rings.push(r)
    }
    const line = t === 3 || t === 13 || t === 23
    if (line) return rings.length === 1 ? { type: 'LineString', coordinates: rings[0] } : { type: 'MultiLineString', coordinates: rings }
    // 面：shapefile 外环顺时针（shoelace 为负）、内环逆时针 → 负面积开新多边形，正面积作为洞并入当前多边形
    const polys = []
    for (const r of rings) { if (ringArea(r) < 0 || !polys.length) polys.push([r]); else polys[polys.length - 1].push(r) }
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys }
  }
  throw new Error('不支持的 shape 类型 ' + t)
}

// zip Buffer → GeoJSON FeatureCollection
export function shapefileFromZip(zipBuf) {
  const files = unzip(zipBuf)
  const shpName = Object.keys(files).find((k) => /\.shp$/i.test(k))
  const dbfName = Object.keys(files).find((k) => /\.dbf$/i.test(k))
  const cpgName = Object.keys(files).find((k) => /\.cpg$/i.test(k))
  if (!shpName) throw new Error('zip 里没有 .shp')
  const enc = cpgName && /utf-?8/i.test(files[cpgName].toString('latin1')) ? 'utf8' : 'utf8'
  const shp = files[shpName]
  const props = dbfName ? readDbf(files[dbfName], enc) : []
  const feats = []
  let p = 100, i = 0
  while (p + 8 <= shp.length) {
    const cl = shp.readInt32BE(p + 4) * 2
    const g = shapeAt(shp, p + 8, cl)
    feats.push({ type: 'Feature', properties: props[i] || {}, geometry: g })
    p += 8 + cl; i++
  }
  return { type: 'FeatureCollection', features: feats }
}
