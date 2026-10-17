// 可编程波束地图 · 导入脚本的返回值 → 覆盖库条目。
//
// 导入脚本返回「波束」—— 与导出脚本读到的 data.beams 同一种形状（一来一回同构，导出的东西能原样读回来）：
//   [{ satellite, orbitLon, name, band, type:'EIRP'|'GT', peaks:[{ lon, lat, value? }], contours:[{ level, points:[[lon,lat]…] }], props? }]
// 也收这两种外包：{ beams:[…] }（整份 BeamMap）、{ satellites:[{ name, orbitLon, band?, type?, beams:[…] }] }（按卫星分组）。
// 宽松认字段（脚本作者照自己的习惯写也能进）：
//   卫星 satellite | satName | sat     轨位 orbitLon | lon | longitude     波束名 name | beam | beamName | id
//   类型 type：G/T、GT、R、Rx、receive → 'GT'；其余 → 'EIRP'      中心 peaks | bore | centers：{lon,lat,value} 或 [lon,lat,value]
//   等值线 contours：{ level | g | value | gain, points | p | ring | coordinates }；level 可为 null（覆盖边界之类没有数值的环）
//   props：附带的元信息（如载波参数），纯 JSON，单束上限 16 KB，悬停波束时显示
// 归一化：经度折回 [-180, 180)、纬度越界的点剔除、不足 2 点的环剔除；同星同名同类型同频段的波束自动加序号区分。
export const IMPORT_MODEL_VERSION = 1
const MAX_POINTS = 5_000_000
const PROPS_CAP = 16384

const T = (lang, zh, en) => (lang === 'en' ? en : zh)
const str = (v) => (v == null ? '' : String(v).trim())
const numOr = (v, d = null) => { const n = typeof v === 'number' ? v : (v == null || String(v).trim() === '' ? NaN : Number(v)); return Number.isFinite(n) ? n : d }
// 已在 [-180, 180] 内的原样返回（取模会带进浮点尾数：61.98 → 61.98000000000002）
const wrap = (x) => { if (x >= -180 && x <= 180) return x; const w = ((x % 360) + 540) % 360 - 180; return w === -180 && x > 0 ? 180 : w }
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return undefined }

export function normType(t) {
  const s = str(t).toLowerCase()
  if (!s) return 'EIRP'
  return /^(g\s*\/?\s*t|gt|r|rx|rcp|receive|uplink|up)$/.test(s) || /g\s*\/\s*t/.test(s) ? 'GT' : 'EIRP'
}
function ptOf(q) {
  const lon = Array.isArray(q) ? numOr(q[0]) : numOr(q && (q.lon != null ? q.lon : q.longitude != null ? q.longitude : q.x))
  const lat = Array.isArray(q) ? numOr(q[1]) : numOr(q && (q.lat != null ? q.lat : q.latitude != null ? q.latitude : q.y))
  return (lon == null || lat == null) ? null : [lon, lat]
}

/**
 * ret → { beams:[{ satellite, orbitLon, name, band, type, bore:[[lon,lat(,v)]], contours:[{ g, p }], props }], warnings:[…], stats }
 * 结构不对直接抛错（带人话说明）。
 */
export function normalizeImport(ret, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh'
  const warnings = []
  const warn = (zh, en) => { if (warnings.length < 200) warnings.push(T(lang, zh, en)) }
  let raw = []
  if (ret == null) raw = []
  else if (Array.isArray(ret)) raw = ret
  else if (typeof ret === 'object' && Array.isArray(ret.satellites)) {
    for (const s of ret.satellites) {
      if (!s || typeof s !== 'object') continue
      const sat = pick(s, 'name', 'satellite', 'satName', 'sat'), lon = pick(s, 'orbitLon', 'lon', 'longitude')
      for (const b of (Array.isArray(s.beams) ? s.beams : [])) raw.push({ band: s.band, type: s.type, ...b, satellite: pick(b, 'satellite', 'satName', 'sat') != null ? pick(b, 'satellite', 'satName', 'sat') : sat, orbitLon: pick(b, 'orbitLon', 'lon', 'longitude') != null ? pick(b, 'orbitLon', 'lon', 'longitude') : lon })
    }
  } else if (typeof ret === 'object' && Array.isArray(ret.beams)) raw = ret.beams
  else if (typeof ret === 'object' && Array.isArray(ret.contours)) raw = [ret]
  else throw new Error(T(lang, '脚本须返回波束数组（或 { beams } / { satellites }）', 'The script must return an array of beams (or { beams } / { satellites })'))

  let badPts = 0, shortRings = 0, totalPts = 0
  const beams = []
  raw.forEach((b, bi) => {
    if (!b || typeof b !== 'object') { warn(`第 ${bi + 1} 项不是对象，已跳过`, `Item ${bi + 1} is not an object; skipped`); return }
    const contoursIn = pick(b, 'contours', 'levels') || []
    if (!Array.isArray(contoursIn)) { warn(`第 ${bi + 1} 个波束的 contours 不是数组，已跳过`, `Beam ${bi + 1}: contours is not an array; skipped`); return }
    const contours = []
    for (const c of contoursIn) {
      if (!c) continue
      const ptsIn = Array.isArray(c) ? c : (pick(c, 'points', 'p', 'ring', 'coordinates') || [])
      const p = []
      for (const q of ptsIn) {
        const pt = ptOf(q)
        if (!pt || pt[1] < -90 || pt[1] > 90 || Math.abs(pt[0]) > 720) { badPts++; continue }
        p.push([wrap(pt[0]), pt[1]])
      }
      if (p.length < 2) { shortRings++; continue }
      totalPts += p.length
      if (totalPts > MAX_POINTS) throw new Error(T(lang, `顶点总数超过上限（${MAX_POINTS}）`, `Too many vertices (limit ${MAX_POINTS})`))
      const lv = Array.isArray(c) ? null : numOr(pick(c, 'level', 'g', 'value', 'gain'))
      contours.push({ g: lv, p })
    }
    const bore = []
    for (const q of (pick(b, 'peaks', 'bore', 'centers', 'center') || [])) {
      const pt = ptOf(q)
      if (!pt || pt[1] < -90 || pt[1] > 90) continue
      const v = Array.isArray(q) ? numOr(q[2]) : numOr(q && (q.value != null ? q.value : q.gain))
      bore.push(v != null ? [wrap(pt[0]), pt[1], v] : [wrap(pt[0]), pt[1]])
    }
    if (!contours.length && !bore.length) { warn(`波束「${str(pick(b, 'name', 'beam', 'beamName', 'id')) || bi + 1}」没有有效的等值线或中心，已跳过`, `Beam "${str(pick(b, 'name', 'beam', 'beamName', 'id')) || bi + 1}" has no valid contour or center; skipped`); return }
    let props = null
    if (b.props != null) {
      try {
        const js = JSON.stringify(b.props)
        if (js && js.length <= PROPS_CAP && typeof b.props === 'object') props = JSON.parse(js)
        else warn(`波束「${str(b.name) || bi + 1}」的 props 超过 16 KB，已舍弃`, `Beam "${str(b.name) || bi + 1}": props over 16 KB; dropped`)
      } catch { warn(`波束「${str(b.name) || bi + 1}」的 props 不是纯 JSON，已舍弃`, `Beam "${str(b.name) || bi + 1}": props is not plain JSON; dropped`) }
    }
    const lon = numOr(pick(b, 'orbitLon', 'lon', 'longitude'))
    beams.push({
      satellite: str(pick(b, 'satellite', 'satName', 'sat')) || T(lang, '卫星', 'Satellite'),
      orbitLon: lon == null ? null : wrap(lon),
      name: str(pick(b, 'name', 'beam', 'beamName', 'id')) || T(lang, `波束 ${bi + 1}`, `Beam ${bi + 1}`),
      band: str(b.band), type: normType(b.type), bore, contours, props
    })
  })
  // 同星同名同类型同频段：库里按这四项认波束，重名会互相覆盖 → 后来者加序号
  const seen = new Map()
  for (const b of beams) {
    const key = [b.satellite.toLowerCase(), b.name, b.type, b.band].join('\u0001')
    const n = (seen.get(key) || 0) + 1
    seen.set(key, n)
    if (n > 1) { const nn = `${b.name} (${n})`; warn(`「${b.satellite}」下有重名波束「${b.name}」，第 ${n} 个改名为「${nn}」`, `Duplicate beam "${b.name}" on "${b.satellite}"; #${n} renamed to "${nn}"`); b.name = nn }
  }
  if (badPts) warn(`${badPts} 个坐标无效或纬度越界的点已剔除`, `${badPts} invalid / out-of-range points dropped`)
  if (shortRings) warn(`${shortRings} 条不足 2 点的等值线已剔除`, `${shortRings} contours with fewer than 2 points dropped`)
  const sats = new Set(beams.map((b) => b.satellite.toLowerCase()))
  return { beams, warnings, stats: { satellites: sats.size, beams: beams.length, contours: beams.reduce((s, b) => s + b.contours.length, 0), vertices: totalPts } }
}

/** 归一化波束 → 覆盖库批量导入条目（coverageGxt.importBatch） */
export function toLibraryItems(beams, opts = {}) {
  return (beams || []).map((b) => ({
    satName: b.satellite, lon: b.orbitLon, beamName: b.name, type: b.type, band: b.band || '',
    rawText: null, sourceName: opts.sourceName || '', sourceFormat: opts.sourceFormat || 'script',
    json: { lon: b.orbitLon, sat: b.satellite, bore: b.bore, contours: b.contours },
    props: b.props || null
  }))
}
