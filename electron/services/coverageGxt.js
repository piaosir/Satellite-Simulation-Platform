// 用户 GXT 覆盖库（主进程）：用户导入的 .gxt 持久化到 userData/gxt-imported。
// 维护一棵「卫星 → 波束」索引树（index.json，元信息真相），每个波束挂：
//   - 原始 .gxt 原文（再导出用，原样字节保真）
//   - 归一化 JSON（{ lon, bore, contours }，供渲染管线 coverage.get 同构消费）
// 解析在渲染进程做（src/viz/gxt/parse.js，ESM），主进程只负责存盘 + 索引增删。
const fs = require('fs')
const path = require('path')

module.exports = function createCoverageGxt(saveDirFn) {
  function dir() {
    const d = typeof saveDirFn === 'function' ? saveDirFn() : saveDirFn
    fs.mkdirSync(d, { recursive: true })
    return d
  }
  const idxPath = () => path.join(dir(), 'index.json')
  function readIndex() {
    let idx
    try { idx = JSON.parse(fs.readFileSync(idxPath(), 'utf8')) } catch { idx = { satellites: [] } }
    if (!Array.isArray(idx.satellites)) idx.satellites = []
    // hidden：对内置（preset）卫星/波束的软删除覆盖层（内置数据只读，删除即记此处供前端过滤）
    if (!idx.hidden || typeof idx.hidden !== 'object') idx.hidden = {}
    if (!Array.isArray(idx.hidden.sats)) idx.hidden.sats = []
    if (!Array.isArray(idx.hidden.beams)) idx.hidden.beams = []
    return idx
  }
  function writeIndex(idx) { fs.writeFileSync(idxPath(), JSON.stringify(idx, null, 2)) }
  const genId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
  const clean = (s) => String(s || '').replace(/[^\w.\-]+/g, '_').replace(/\.+/g, '.') || 'x'
  // 限定在 saveDir 内（防路径穿越）
  function safePath(rel) {
    const safe = String(rel || '').replace(/\\/g, '/').replace(/\.\.+/g, '').replace(/^\/+/, '')
    const fp = path.join(dir(), safe)
    if (!fp.startsWith(dir())) throw new Error('非法路径')
    return fp
  }

  function index() { return readIndex() }
  // 归一化 JSON（渲染用）：file 形如 "<satId>/<beamId>.json"
  function get(file) { return JSON.parse(fs.readFileSync(safePath(file), 'utf8')) }
  // 原始 GXT 文本（再导出用）
  function raw(file) { return { text: fs.readFileSync(safePath(file), 'latin1') } }

  function addSat(name, lon) {
    const idx = readIndex()
    const sat = { id: genId(), name: (name || '卫星').toString().trim() || '卫星', lon: Number.isFinite(lon) ? Number(lon) : null, beams: [], createdAt: new Date().toISOString() }
    idx.satellites.push(sat)
    writeIndex(idx)
    return sat
  }
  function renameSat(satId, name) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId); if (!sat) return { ok: false }
    sat.name = (name || sat.name).toString().trim() || sat.name
    writeIndex(idx); return { ok: true, sat }
  }
  function removeSat(satId) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId)
    if (sat) { try { fs.rmSync(path.join(dir(), clean(satId)), { recursive: true, force: true }) } catch {} }
    idx.satellites = idx.satellites.filter((s) => s.id !== satId)
    writeIndex(idx); return { ok: true }
  }
  // 按卫星名找/建用户卫星（给内置卫星「＋波束」时，用同名用户卫星承载新波束 → 前端按名合并）
  function ensureSat(name, lon) {
    const idx = readIndex()
    const nm = String(name || '卫星').trim() || '卫星'
    let sat = idx.satellites.find((s) => String(s.name || '').trim().toLowerCase() === nm.toLowerCase())
    if (!sat) { sat = { id: genId(), name: nm, lon: Number.isFinite(lon) ? Number(lon) : null, beams: [], createdAt: new Date().toISOString() }; idx.satellites.push(sat); writeIndex(idx) }
    else if (sat.lon == null && Number.isFinite(lon)) { sat.lon = Number(lon); writeIndex(idx) }
    return sat
  }
  // 软隐藏内置卫星/波束（kind='sat'|'beam'，key=preset 的 folder 或 beam.key）
  function hidePreset(kind, key) {
    const idx = readIndex()
    const arr = kind === 'beam' ? idx.hidden.beams : idx.hidden.sats
    if (key && !arr.includes(key)) arr.push(key)
    writeIndex(idx); return { ok: true }
  }
  function unhidePreset(kind, key) {
    const idx = readIndex()
    if (kind === 'beam') idx.hidden.beams = idx.hidden.beams.filter((k) => k !== key)
    else idx.hidden.sats = idx.hidden.sats.filter((k) => k !== key)
    writeIndex(idx); return { ok: true }
  }

  function addBeam(satId, name, type, band) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId); if (!sat) return { ok: false, error: '卫星不存在' }
    const beam = { id: genId(), name: (name || '波束').toString().trim() || '波束', type: type || 'EIRP', band: band || '', file: null, rawFile: null, contours: 0, importedAt: null }
    sat.beams.push(beam); writeIndex(idx); return { ok: true, beam }
  }
  function renameBeam(satId, beamId, name) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId); if (!sat) return { ok: false }
    const beam = sat.beams.find((b) => b.id === beamId); if (!beam) return { ok: false }
    beam.name = (name || beam.name).toString().trim() || beam.name
    writeIndex(idx); return { ok: true, beam }
  }
  function removeBeam(satId, beamId) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId); if (!sat) return { ok: false }
    const beam = sat.beams.find((b) => b.id === beamId)
    if (beam) { for (const f of [beam.file, beam.rawFile]) if (f) { try { fs.unlinkSync(safePath(f)) } catch {} } }
    sat.beams = sat.beams.filter((b) => b.id !== beamId)
    writeIndex(idx); return { ok: true }
  }
  // 把解析好的数据写到某波束：rawText=原始 GXT 文本；json={ lon, bore, contours, ... } 归一化数据。
  function attach(satId, beamId, payload) {
    const idx = readIndex(); const sat = idx.satellites.find((s) => s.id === satId); if (!sat) return { ok: false, error: '卫星不存在' }
    const beam = sat.beams.find((b) => b.id === beamId); if (!beam) return { ok: false, error: '波束不存在' }
    const sub = path.join(dir(), clean(satId)); fs.mkdirSync(sub, { recursive: true })
    const jsonRel = `${clean(satId)}/${clean(beamId)}.json`
    const rawRel = `${clean(satId)}/${clean(beamId)}.gxt`
    fs.writeFileSync(safePath(jsonRel), JSON.stringify(payload.json || {}))
    if (payload.rawText != null) fs.writeFileSync(safePath(rawRel), String(payload.rawText), 'latin1')
    beam.file = jsonRel
    beam.rawFile = payload.rawText != null ? rawRel : null
    beam.contours = (payload.json && payload.json.contours ? payload.json.contours.length : 0)
    beam.gains = payload.json && payload.json.contours ? [...new Set(payload.json.contours.map((c) => c.g))].sort((a, b) => a - b) : []
    beam.lon = payload.json && Number.isFinite(payload.json.lon) ? payload.json.lon : beam.lon
    beam.sourceName = payload.sourceName || beam.sourceName || null
    beam.importedAt = new Date().toISOString()
    if (Number.isFinite(beam.lon) && !Number.isFinite(sat.lon)) sat.lon = beam.lon
    if (payload.type) beam.type = payload.type
    if (payload.band != null) beam.band = payload.band
    writeIndex(idx); return { ok: true, beam }
  }

  // 批量导入：items=[{ satName, lon, beamName, type, band, rawText, sourceName, json }]。
  // 按 satName 自动找/建卫星，按 (beamName,type) 找/建波束（同名同类型则覆盖重导），一次写盘。返回 { sats, beams, total }。
  function importBatch(items) {
    const idx = readIndex()
    const byName = new Map()
    for (const s of idx.satellites) byName.set(String(s.name || '').trim().toLowerCase(), s)
    let satCount = 0, beamCount = 0
    for (const it of (items || [])) {
      const nm = (it.satName || '卫星').toString().trim() || '卫星'
      let sat = byName.get(nm.toLowerCase())
      if (!sat) { sat = { id: genId(), name: nm, lon: Number.isFinite(it.lon) ? it.lon : null, beams: [], createdAt: new Date().toISOString() }; idx.satellites.push(sat); byName.set(nm.toLowerCase(), sat); satCount++ }
      else if (sat.lon == null && Number.isFinite(it.lon)) sat.lon = it.lon
      const beamNm = (it.beamName || '波束').toString().trim() || '波束'
      const type = it.type || 'EIRP'
      let beam = sat.beams.find((b) => b.name === beamNm && (b.type || '') === type)
      if (!beam) { beam = { id: genId(), name: beamNm, type, band: it.band || '' }; sat.beams.push(beam); beamCount++ }
      const sub = path.join(dir(), clean(sat.id)); fs.mkdirSync(sub, { recursive: true })
      const jsonRel = `${clean(sat.id)}/${clean(beam.id)}.json`
      const rawRel = `${clean(sat.id)}/${clean(beam.id)}.gxt`
      fs.writeFileSync(safePath(jsonRel), JSON.stringify(it.json || {}))
      if (it.rawText != null) fs.writeFileSync(safePath(rawRel), String(it.rawText), 'latin1')
      beam.file = jsonRel
      beam.rawFile = it.rawText != null ? rawRel : null
      beam.contours = it.json && it.json.contours ? it.json.contours.length : 0
      beam.gains = it.json && it.json.contours ? [...new Set(it.json.contours.map((c) => c.g))].sort((a, b) => a - b) : []
      beam.lon = it.json && Number.isFinite(it.json.lon) ? it.json.lon : beam.lon
      beam.band = it.band != null ? it.band : beam.band
      beam.type = type
      beam.sourceName = it.sourceName || null
      beam.importedAt = new Date().toISOString()
      if (Number.isFinite(beam.lon) && !Number.isFinite(sat.lon)) sat.lon = beam.lon
    }
    writeIndex(idx)
    return { ok: true, sats: satCount, beams: beamCount, total: (items || []).length }
  }

  return { index, get, raw, addSat, renameSat, removeSat, ensureSat, hidePreset, unhidePreset, addBeam, renameBeam, removeBeam, attach, importBatch }
}
