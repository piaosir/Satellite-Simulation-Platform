// GXT 结构 JSON —— 把 GXT 各节逐字段搬进 JSON 的波束图格式（每个文件一个波束，nDiag = 1）。
// LinkLab 小程序云数据（Satellitelinkbudget/CoverageCloudData，中星 / 亚太等 527 个文件）用的就是它，
// 由那边的 convertAPSTAR*.js / convertNewGxt.js 从交付的 GXT 转来：
//   { "formatInfo": { "format_ver": "1" },
//     "geoMain":   { "adm": "G", "satName": "...", "longitude": 134, "nDiag": 1 },
//     "coHeader":  { "beamId": 1, "emiRcp": "E", "polarization": "C", "reason": "C", "nBore": 1, "nContours": 10 },
//     "borePoints":[ { "index": 1, "gain": 43.46, "pos": [111.34, 33.05] } ],
//     "contours":  [ { "i": 1, "g": 43, "p": [[lon, lat], ...] }, ... ] }
// 与 GXT 的对应：format_ver / adm / sat_name / long_nom / n_diag / beam_id / emi_rcp / polar_disc / reason /
// n_bore / n_cont、[Bn] gain + p、[Cn] gain + p1..pN。
// 解析输出与 gxt/parse.js 同构（{ lon, satName, bore:[[lon,lat(,gain)]], contours:[{g,p}] }），覆盖库导入可共用一条路。

const num = (v) => { const n = typeof v === 'number' ? v : (v == null || String(v).trim() === '' ? NaN : Number(v)); return Number.isFinite(n) ? n : NaN }
const PLACEHOLDER_SAT = 'Satellite Name'   // GXT 缺卫星名时的占位（本软件与 SATSOFT 都这么写），当作没有

/** 文本像不像 GXT 结构 JSON（只做嗅探，解析失败另报） */
export function isGxtJsonText(text) {
  const s = String(text || '')
  return /^\s*\{/.test(s) && /"contours"\s*:/.test(s)
}

/**
 * 解析 GXT 结构 JSON（文本或已解析的对象）→ { lon, satName, bore, contours, beamId, emiRcp, polarDisc, reason, formatVer }。
 * 容错：等值线条目为 null / 点不足 2 个 / 电平非数的剔除（云数据里实有 82 个 null 条目）；点坐标非有限的剔除。
 * 一条有效的等值线或波束中心都没有时抛错（供调用方提示）。
 */
export function parseGxtJson(input) {
  let j = input
  if (typeof input === 'string') {
    try { j = JSON.parse(input.replace(/^﻿/, '')) } catch (e) { throw new Error('JSON 解析失败：' + ((e && e.message) || e)) }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j) || !Array.isArray(j.contours)) throw new Error('未识别到 contours（非 GXT 结构 JSON？）')
  const gm = (j.geoMain && typeof j.geoMain === 'object') ? j.geoMain : {}
  const co = (j.coHeader && typeof j.coHeader === 'object') ? j.coHeader : {}
  const pt = (q) => (Array.isArray(q) && q.length >= 2 && Number.isFinite(num(q[0])) && Number.isFinite(num(q[1]))) ? [num(q[0]), num(q[1])] : null
  const bore = []
  for (const b of (Array.isArray(j.borePoints) ? j.borePoints : [])) {
    const p = b && pt(b.pos)
    if (!p) continue
    const g = num(b.gain)
    bore.push(Number.isFinite(g) ? [p[0], p[1], g] : p)
  }
  const contours = []
  for (const c of j.contours) {
    if (!c || typeof c !== 'object') continue
    const g = num(c.g != null ? c.g : c.gain)
    if (!Number.isFinite(g)) continue
    const p = (Array.isArray(c.p) ? c.p : []).map(pt).filter(Boolean)
    if (p.length >= 2) contours.push({ g, p })
  }
  if (!contours.length && !bore.length) throw new Error('未识别到等值线/波束中心（非 GXT 结构 JSON？）')
  const sat = gm.satName != null ? String(gm.satName).trim() : ''
  const lon = num(gm.longitude)
  return {
    lon: Number.isFinite(lon) ? lon : null,
    satName: sat === PLACEHOLDER_SAT ? '' : sat,
    bore, contours,
    beamId: co.beamId != null ? co.beamId : null,
    emiRcp: co.emiRcp != null ? String(co.emiRcp) : '',
    polarDisc: co.polarization != null ? String(co.polarization) : '',
    reason: co.reason != null ? String(co.reason) : '',
    formatVer: j.formatInfo && j.formatInfo.format_ver != null ? String(j.formatInfo.format_ver) : ''
  }
}

/**
 * 写 GXT 结构 JSON。data 与 serializeGxt 同口径：
 *   { lon, satName, bore:[[lon,lat(,gain)]|{lon,lat,gain}], contours:[{ g, p }], beamId, emiRcp, polarDisc, reason, adm, formatVer }
 * opts：digits 坐标小数位（缺省 3，与云数据一致）、indent 缩进（缺省 0 = 单行，云数据即单行）。
 * 等值线点列原样写（不补也不删闭合点）；键序 i, g, p。
 */
export function serializeGxtJson(data = {}, opts = {}) {
  const dg = Number.isInteger(opts.digits) && opts.digits >= 0 && opts.digits <= 10 ? opts.digits : 3
  const r = (v) => +Number(v).toFixed(dg)
  const bore = (data.bore || []).map((b) => (Array.isArray(b) ? { lon: b[0], lat: b[1], gain: b[2] } : b))
    .filter((b) => b && Number.isFinite(b.lon) && Number.isFinite(b.lat))
  const contours = (data.contours || []).filter((c) => c && Array.isArray(c.p) && c.p.length >= 2 && Number.isFinite(Number(c.g)))
  // 轨位未知就不写 longitude（不编一个 0 进去；云数据里本就有缺 geoMain 的文件，读的一方都容得下）
  const geoMain = { adm: data.adm != null && String(data.adm) !== '' ? String(data.adm) : 'G', satName: String(data.satName || PLACEHOLDER_SAT) }
  if (Number.isFinite(data.lon)) geoMain.longitude = data.lon
  geoMain.nDiag = 1
  const doc = {
    formatInfo: { format_ver: String(data.formatVer || '1') },
    geoMain,
    coHeader: {
      beamId: data.beamId != null && data.beamId !== '' ? data.beamId : 1,
      emiRcp: data.emiRcp || 'E', polarization: data.polarDisc || 'X', reason: data.reason || 'C',
      nBore: bore.length, nContours: contours.length
    },
    borePoints: bore.map((b, k) => {
      const o = { index: k + 1 }
      if (Number.isFinite(b.gain)) o.gain = Number(b.gain)   // 电平原样（不像 GXT 文本那样截到 2 位）
      o.pos = [r(b.lon), r(b.lat)]
      return o
    }),
    contours: contours.map((c, k) => ({ i: k + 1, g: Number(c.g), p: c.p.map((q) => [r(q[0]), r(q[1])]) }))
  }
  return opts.indent ? JSON.stringify(doc, null, opts.indent) : JSON.stringify(doc)
}
