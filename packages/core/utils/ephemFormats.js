// 外部「时间标签位置序列」星历的解析与序列化（纯 CommonJS）。
//
// 【格式清单】与 ommFormats.js 的六种【平均根数】格式并列，互不相干 —— 那六种喂 SGP4，这几种
// 喂插值器（ephemInterp）。全部由 detectFormat 按内容识别，扩展名只作兜底。
//   stk-e            STK .e（BEGIN/END Ephemeris，EpSec/UTCG/ISO-YMD/JDate 四种时间写法）
//   ccsds-oem-kvn    CCSDS 502.0-B OEM 关键字=值报文（多段 = 同一星多段）
//   ccsds-oem-xml    CCSDS 505.0-B NDM/XML 的 <oem>
//   sp3              SP3-c/d 精密星历（见 §7，本文件另行承担）
//
// 【星记录形状】{ name, objectId, frame, timeSystem, interp:{method,samples},
//   t:Float64Array（UTC 毫秒）, p:Float64Array（3n，km，frame 所指的帧）, v:Float64Array|null（3n，km/s）,
//   spans:[[t0,t1],…]|null（多段星历的分段，段间不插值）, meta:{} }
//   ★ t 一律已换算成 UTC 毫秒（时标换算在 timeSystems.js），p/v 保留【原帧原值】——
//     换到 TEME 是 ephemInterp.buildTable 的事，导出要的是原值，两件事不能混。
//
// 【回环判据】同格式导入 -> 导出：时间到 μs、位置到 1e-9 km 逐位相同（默认不换帧）。
//   跨帧导出再导入：positionAt 差 <= 1 m（内部一致性，见 test/ephemFormats.test.mjs）。
//
// 【BOM】所有入口统一 stripBom —— BOM 打死过 json / tle 解析，这里不能再犯。

'use strict'

const T = require('./timeSystems.js')
const FR = require('./frames.js')

const FORMATS = ['stk-e', 'ccsds-oem-kvn', 'ccsds-oem-xml', 'sp3']
const FORMAT_LABEL = {
  'stk-e': 'STK 星历（.e）',
  'ccsds-oem-kvn': 'CCSDS OEM（KVN）',
  'ccsds-oem-xml': 'CCSDS OEM（XML）',
  sp3: 'SP3 精密星历'
}
const FORMAT_EXT = { 'stk-e': '.e', 'ccsds-oem-kvn': '.oem', 'ccsds-oem-xml': '.xml', sp3: '.sp3' }

const stripBom = (s) => String(s == null ? '' : s).replace(/^﻿/, '')
const DEG = Math.PI / 180

/* ===================== WGS-84 大地坐标 <-> ECEF ===================== */
const WGS_A = 6378.137
const WGS_F = 1 / 298.257223563
const WGS_E2 = WGS_F * (2 - WGS_F)
function geodeticToEcef(latDeg, lonDeg, altKm) {
  const la = latDeg * DEG, lo = lonDeg * DEG
  const sl = Math.sin(la), cl = Math.cos(la)
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * sl * sl)
  return { x: (N + altKm) * cl * Math.cos(lo), y: (N + altKm) * cl * Math.sin(lo), z: (N * (1 - WGS_E2) + altKm) * sl }
}
function sphericalToEcef(latDeg, lonDeg, rKm) {
  const la = latDeg * DEG, lo = lonDeg * DEG
  return { x: rKm * Math.cos(la) * Math.cos(lo), y: rKm * Math.cos(la) * Math.sin(lo), z: rKm * Math.sin(la) }
}

/* ===================== 嗅探 ===================== */
function detectFormat(text) {
  const s = stripBom(text)
  const head = s.slice(0, 4096)
  if (/^\s*stk\.v\.|BEGIN\s+Ephemeris/i.test(head)) return 'stk-e'
  if (/CCSDS_OEM_VERS/i.test(head)) return /^\s*</.test(s.trimStart()) || /<\s*(?:[A-Za-z_][\w.-]*:)?oem\b/i.test(head) ? 'ccsds-oem-xml' : 'ccsds-oem-kvn'
  if (/<\s*(?:[A-Za-z_][\w.-]*:)?oem\b/i.test(head)) return 'ccsds-oem-xml'
  if (/^#[cd]/.test(s)) return 'sp3'
  return ''
}

/* ===================== STK .e ===================== */
// 键值关键字（首 token）。大小写不敏感。
const E_KEYS = new Set(['scenarioepoch', 'centralbody', 'coordinatesystem', 'distanceunit', 'timeformat',
  'interpolationmethod', 'interpolationsamplesm1', 'numberofephemerispoints', 'ephemerisvariabletimestep',
  'begin', 'end', 'blockingfactor', 'version', 'satelliteid', 'coordinatesystemepoch', 'begin_segment_boundary_times'])
// 数据块名 -> 每行的位置列数与语义
const E_BLOCKS = {
  ephemeristimepos: { cols: 3, kind: 'xyz', vel: false },
  ephemeristimeposvel: { cols: 6, kind: 'xyz', vel: true },
  ephemeristimeposvelacc: { cols: 9, kind: 'xyz', vel: true },
  ephemerisllatimepos: { cols: 3, kind: 'lla', vel: false },
  ephemerisllrtimepos: { cols: 3, kind: 'llr', vel: false }
}
// STK CoordinateSystem -> 本平台帧；未列出的点名拒收
const E_FRAME = {
  fixed: 'FIXED', inertial: 'J2000', icrf: 'J2000', j2000: 'J2000',
  trueofdate: 'TOD', meanofdate: 'MOD', temeofdate: 'TEME', teme: 'TEME'
}

function parseStkE(text, name) {
  const errors = [], warnings = []
  const src = stripBom(text)
  const lines = src.split(/\r?\n/)
  let epochMs = NaN, frameRaw = 'Fixed', unit = 'meters', timeFormat = 'EpSec'
  let method = 'lagrange', samplesM1 = 5, declared = null, centralBody = 'earth'
  const rows = []       // { ms, x,y,z, vx,vy,vz }
  let block = null, blockKind = null, skipping = false
  const sampled = []

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    line = line.trim()
    if (!line) continue
    const tok = line.split(/\s+/)
    const k0 = tok[0].toLowerCase()

    if (/^stk\.v\./i.test(tok[0])) { continue }
    if (E_BLOCKS[k0] && tok.length === 1) { block = E_BLOCKS[k0]; blockKind = k0; skipping = false; continue }
    if (k0 === 'end' && /ephemeris/i.test(tok[1] || '')) { block = null; skipping = false; continue }
    if (k0 === 'begin') { continue }
    if (k0 === 'end') { block = null; skipping = false; continue }

    if (E_KEYS.has(k0)) {
      block = null; skipping = false
      const val = tok.slice(1).join(' ').trim()
      switch (k0) {
        case 'scenarioepoch': epochMs = T.parseUtcg(val); if (!Number.isFinite(epochMs)) epochMs = T.parseEpochLoose(val); break
        case 'centralbody': centralBody = val.toLowerCase(); break
        case 'coordinatesystem': frameRaw = val; break
        case 'distanceunit': unit = val.toLowerCase(); break
        case 'timeformat': timeFormat = val; break
        case 'interpolationmethod': method = /hermite/i.test(val) ? 'hermite' : 'lagrange'; break
        case 'interpolationsamplesm1': samplesM1 = Math.max(1, Math.round(parseFloat(val) || 5)); break
        case 'numberofephemerispoints': declared = Math.round(parseFloat(val) || 0); break
        default: break
      }
      continue
    }

    // 非关键字、非数字开头 = 另一个块的块名（含 Covariance*、AttitudeTime* 一类）：
    // 这里必须先把当前块收掉再进跳过态 —— 否则它后面的数据行会被当成星历点混进来。
    if (!/^[-+0-9.]/.test(tok[0])) {
      block = null
      if (!skipping) { skipping = true; warnings.push('跳过未识别的数据块 ' + tok[0]) }
      continue
    }
    if (!block || skipping) continue

    // 数据行
    const tcount = /^UTCG$/i.test(String(timeFormat).trim()) ? 4 : 1
    if (tok.length < tcount + block.cols) { warnings.push('第 ' + (li + 1) + ' 行列数不足，已跳过'); continue }
    const timeTok = tok.slice(0, tcount).join(' ')
    const read = T.parseTimeToken(timeTok, timeFormat, epochMs)
    if (!Number.isFinite(read)) { warnings.push('第 ' + (li + 1) + ' 行时间无法解析，已跳过'); continue }
    const nums = tok.slice(tcount, tcount + block.cols).map(Number)
    if (nums.some((x) => !Number.isFinite(x))) { warnings.push('第 ' + (li + 1) + ' 行数值无效，已跳过'); continue }
    sampled.push({ ms: read, kind: block.kind, vel: block.vel, nums })
  }

  if (!Number.isFinite(epochMs)) epochMs = 0
  if (centralBody && centralBody !== 'earth') errors.push('中心天体 ' + centralBody + ' 不受支持（只收 Earth）')
  const fk = String(frameRaw).toLowerCase().replace(/[^a-z0-9]/g, '')
  let frame = E_FRAME[fk] || ''
  if (!frame) errors.push('坐标系 ' + frameRaw + ' 不受支持')
  const scale = /^kilometers?$/.test(unit) || unit === 'km' ? 1 : (/^meters?$/.test(unit) || unit === 'm' ? 1e-3 : (/^feet$/.test(unit) ? 3.048e-4 : NaN))
  if (!Number.isFinite(scale)) errors.push('距离单位 ' + unit + ' 不受支持')
  if (errors.length) return { sats: [], errors, warnings }

  const hasVel = sampled.length > 0 && sampled.every((r) => r.vel)
  const n = sampled.length
  if (!n) { errors.push('没有解析到任何星历点'); return { sats: [], errors, warnings } }
  if (declared != null && declared !== n) warnings.push('NumberOfEphemerisPoints 声明 ' + declared + '，实得 ' + n)

  const t = new Float64Array(n), p = new Float64Array(3 * n)
  const v = hasVel ? new Float64Array(3 * n) : null
  let llFrame = false
  for (let i = 0; i < n; i++) {
    const r = sampled[i]
    t[i] = r.ms
    let pos
    if (r.kind === 'lla') { pos = geodeticToEcef(r.nums[0], r.nums[1], r.nums[2] * scale); llFrame = true }
    else if (r.kind === 'llr') { pos = sphericalToEcef(r.nums[0], r.nums[1], r.nums[2] * scale); llFrame = true }
    else pos = { x: r.nums[0] * scale, y: r.nums[1] * scale, z: r.nums[2] * scale }
    p[3 * i] = pos.x; p[3 * i + 1] = pos.y; p[3 * i + 2] = pos.z
    if (v) { v[3 * i] = r.nums[3] * scale; v[3 * i + 1] = r.nums[4] * scale; v[3 * i + 2] = r.nums[5] * scale }
  }
  // LLA / LLR 块按定义就在地固系，与 CoordinateSystem 无关
  if (llFrame) frame = 'FIXED'

  return {
    sats: [{
      name: name || 'Ephemeris', objectId: '', frame, timeSystem: 'UTC',
      interp: { method, samples: samplesM1 + 1 },
      t, p, v, spans: null, meta: { scenarioEpochMs: epochMs, distanceUnit: unit, timeFormat }
    }],
    errors, warnings
  }
}

/* ===================== CCSDS OEM ===================== */
// REF_FRAME 映射；未列出的点名拒收
const OEM_FRAME = {
  EME2000: 'J2000', J2000: 'J2000', ICRF: 'J2000', GCRF: 'J2000', MJ2000EQ: 'J2000',
  TEME: 'TEME', TOD: 'TOD', TDR: 'TOD', TRUEOFDATE: 'TOD', MOD: 'MOD', MEANOFDATE: 'MOD',
  ITRF: 'FIXED', EFG: 'FIXED', ECEF: 'FIXED', GRC: 'FIXED'
}
function oemFrame(raw) {
  const k = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  if (OEM_FRAME[k]) return OEM_FRAME[k]
  if (/^ITRF\d*$/.test(k)) return 'FIXED'
  return ''
}
const OEM_TIME = new Set(['UTC', 'TAI', 'TT', 'GPS', 'TDB'])

// 一段 meta + 数据 -> 段对象
function oemSegment(meta, dataRows, errors, warnings) {
  const frame = oemFrame(meta.REF_FRAME)
  if (!frame) { errors.push('参考系 ' + (meta.REF_FRAME || '(缺)') + ' 不受支持'); return null }
  const tsys = String(meta.TIME_SYSTEM || 'UTC').toUpperCase()
  if (!OEM_TIME.has(tsys)) { errors.push('时间系统 ' + tsys + ' 不受支持'); return null }
  const center = String(meta.CENTER_NAME || 'EARTH').toUpperCase()
  if (center && center !== 'EARTH') { errors.push('中心天体 ' + meta.CENTER_NAME + ' 不受支持（只收 EARTH）'); return null }
  const method = /HERMITE/i.test(meta.INTERPOLATION || '') ? 'hermite' : 'lagrange'
  const deg = Math.round(Number(meta.INTERPOLATION_DEGREE))
  const samples = Number.isFinite(deg) && deg >= 1 ? deg + 1 : 6
  const rows = []
  for (let i = 0; i < dataRows.length; i++) {
    const r = dataRows[i]
    const read = T.parseEpochLoose(r[0])
    if (!Number.isFinite(read)) { warnings.push('历元无法解析：' + r[0]); continue }
    const nums = r.slice(1).map(Number)
    if (nums.length < 3 || nums.slice(0, 3).some((x) => !Number.isFinite(x))) { warnings.push('状态矢量无效：' + r[0]); continue }
    rows.push({ ms: T.utcMsFrom({ system: tsys, ms: read }), nums })
  }
  if (!rows.length) return null
  const hasV = rows.every((r) => r.nums.length >= 6 && r.nums.slice(3, 6).every(Number.isFinite))
  return {
    objectName: meta.OBJECT_NAME || '', objectId: meta.OBJECT_ID || '',
    frame, tsys, method, samples, rows, hasV
  }
}

// 多段 -> 星（按 OBJECT_ID 归并；无 ID 按名字；都没有就单星）
function oemSatsFromSegments(segs, errors, warnings) {
  const byKey = new Map()
  for (const s of segs) {
    const key = (s.objectId || s.objectName || '#1').toUpperCase()
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(s)
  }
  const sats = []
  for (const [, list] of byKey) {
    list.sort((a, b) => a.rows[0].ms - b.rows[0].ms)
    const frame = list[0].frame
    if (list.some((s) => s.frame !== frame)) { errors.push('同一星的多段参考系不一致，已拒收'); continue }
    const hasV = list.every((s) => s.hasV)
    let n = 0
    for (const s of list) n += s.rows.length
    const t = new Float64Array(n), p = new Float64Array(3 * n)
    const v = hasV ? new Float64Array(3 * n) : null
    const spans = []
    let k = 0
    for (const s of list) {
      const a = k
      for (const r of s.rows) {
        t[k] = r.ms
        p[3 * k] = r.nums[0]; p[3 * k + 1] = r.nums[1]; p[3 * k + 2] = r.nums[2]
        if (v) { v[3 * k] = r.nums[3]; v[3 * k + 1] = r.nums[4]; v[3 * k + 2] = r.nums[5] }
        k++
      }
      spans.push([t[a], t[k - 1]])
    }
    sats.push({
      name: list[0].objectName || list[0].objectId || 'OEM', objectId: list[0].objectId || '',
      frame, timeSystem: list[0].tsys, interp: { method: list[0].method, samples: list[0].samples },
      t, p, v, spans: spans.length > 1 ? spans : null, meta: { segments: list.length }
    })
  }
  return sats
}

function parseOemKvn(text) {
  const errors = [], warnings = []
  const lines = stripBom(text).split(/\r?\n/)
  const segs = []
  let meta = null, data = null, inCov = false
  // 段在【下一个 META_START】或文件结束时收束 —— 不能靠「下一行是不是 META_START」判断，
  // 段与段之间通常隔着空行，那样会把整段丢掉。
  const flush = () => {
    if (meta && data && data.length) { const s = oemSegment(meta, data, errors, warnings); if (s) segs.push(s) }
    meta = null; data = null
  }
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim()
    if (!line) continue
    // COMMENT 不带等号（KVN 老坑）：任何位置都直接丢
    if (/^COMMENT\b/i.test(line)) continue
    if (/^COVARIANCE_START\b/i.test(line)) { inCov = true; continue }
    if (/^COVARIANCE_STOP\b/i.test(line)) { inCov = false; continue }
    if (inCov) continue
    if (/^META_START\b/i.test(line)) { flush(); meta = {}; data = null; continue }
    if (/^META_STOP\b/i.test(line)) { data = []; continue }
    if (data === null) {
      const eq = line.indexOf('=')
      if (eq > 0 && meta) meta[line.slice(0, eq).trim().toUpperCase()] = line.slice(eq + 1).trim()
      continue
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue   // 段后杂项（如 USER_DEFINED）
    const tok = line.split(/\s+/)
    if (tok.length >= 4) data.push(tok)
  }
  flush()
  if (!segs.length && !errors.length) errors.push('OEM 里没有可用的状态矢量段')
  return { sats: oemSatsFromSegments(segs, errors, warnings), errors, warnings }
}

/* —— 最小 XML 读取（与 ommFormats.js 同思路，另写 oem 版） —— */
const XML_NS = '(?:[A-Za-z_][\\w.-]*:)?'
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const xmlDecode = (s) => String(s).replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g,
  (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : XML_ENT[e]))
const xmlEsc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
function xmlBlocks(text, tag) {
  const out = []
  const re = new RegExp('<' + XML_NS + tag + '(\\s[^>]*)?>([\\s\\S]*?)</' + XML_NS + tag + '>', 'g')
  let m
  while ((m = re.exec(text))) out.push({ attrs: m[1] || '', inner: m[2] })
  return out
}
function xmlLeaves(inner) {
  const out = []
  const re = new RegExp('<' + XML_NS + '([A-Za-z][A-Za-z0-9_]*)((?:\\s[^>]*)?)\\s*(/)?>(?:([\\s\\S]*?)</' + XML_NS + '\\1>)?', 'g')
  let m
  while ((m = re.exec(inner))) out.push({ key: m[1].toUpperCase(), text: m[3] ? '' : xmlDecode(m[4] == null ? '' : m[4]).trim() })
  return out
}

function parseOemXml(text) {
  const errors = [], warnings = []
  const src = stripBom(text)
  const oems = xmlBlocks(src, 'oem')
  const roots = oems.length ? oems : [{ attrs: '', inner: src }]
  const segs = []
  for (const root of roots) {
    const segBlocks = xmlBlocks(root.inner, 'segment')
    for (const sb of segBlocks) {
      const metaBlock = xmlBlocks(sb.inner, 'metadata')[0]
      const dataBlock = xmlBlocks(sb.inner, 'data')[0]
      if (!metaBlock || !dataBlock) continue
      const meta = {}
      for (const leaf of xmlLeaves(metaBlock.inner)) { if (leaf.key !== 'COMMENT') meta[leaf.key] = leaf.text }
      const rows = []
      for (const sv of xmlBlocks(dataBlock.inner, 'stateVector')) {
        const f = {}
        for (const leaf of xmlLeaves(sv.inner)) f[leaf.key] = leaf.text
        if (!f.EPOCH) continue
        const row = [f.EPOCH, f.X, f.Y, f.Z]
        if (f.X_DOT != null && f.X_DOT !== '') row.push(f.X_DOT, f.Y_DOT, f.Z_DOT)
        rows.push(row)
      }
      if (!rows.length) continue
      const s = oemSegment(meta, rows, errors, warnings)
      if (s) segs.push(s)
    }
  }
  if (!segs.length && !errors.length) errors.push('OEM/XML 里没有可用的 stateVector')
  return { sats: oemSatsFromSegments(segs, errors, warnings), errors, warnings }
}

/* ===================== 统一入口 ===================== */
function parseEphemeris(text, fmt, opts) {
  const src = stripBom(text)
  const f = fmt || detectFormat(src)
  const name = (opts && opts.name) || ''
  let r
  switch (f) {
    case 'stk-e': r = parseStkE(src, name); break
    case 'ccsds-oem-kvn': r = parseOemKvn(src); break
    case 'ccsds-oem-xml': r = parseOemXml(src); break
    case 'sp3': r = parseSp3 ? parseSp3(src) : { sats: [], errors: ['SP3 解析未启用'], warnings: [] }; break
    default: return { format: '', sats: [], errors: ['无法识别的星历格式（支持 STK .e / CCSDS OEM 的 KVN 与 XML / SP3）'], warnings: [] }
  }
  return { format: f, sats: r.sats || [], errors: r.errors || [], warnings: r.warnings || [] }
}

/* ===================== 换帧 ===================== */
const sat = require('../vendor/satellite.js')
// 把一颗星的采样整体换到目标帧（原地不改，返回新星）。target 为空 = 不换。
function convertSat(s, target) {
  const to = FR.normFrame(target)
  if (!to || to === FR.normFrame(s.frame)) return s
  const from = FR.normFrame(s.frame) || 'TEME'
  const n = s.t.length
  const p = new Float64Array(3 * n)
  const v = s.v ? new Float64Array(3 * n) : null
  for (let i = 0; i < n; i++) {
    const ms = s.t[i]
    const cT = T.julianCenturiesTT(ms)
    const gmst = sat.gstime(T.jdFromMs(ms))
    const nu = FR.nutationAngles(cT)
    const pos = { x: s.p[3 * i], y: s.p[3 * i + 1], z: s.p[3 * i + 2] }
    const teme = FR.toTeme(pos, from, cT, gmst, nu)
    const out = FR.fromTeme(teme, to, cT, gmst, nu)
    p[3 * i] = out.x; p[3 * i + 1] = out.y; p[3 * i + 2] = out.z
    if (v) {
      const vel = { x: s.v[3 * i], y: s.v[3 * i + 1], z: s.v[3 * i + 2] }
      const vTeme = FR.velToTeme(vel, pos, from, cT, gmst, nu)
      const vOut = FR.velFromTeme(vTeme, teme, to, cT, gmst, nu)
      v[3 * i] = vOut.x; v[3 * i + 1] = vOut.y; v[3 * i + 2] = vOut.z
    }
  }
  return Object.assign({}, s, { frame: to, p, v })
}

/* ===================== 序列化 ===================== */
const E_FRAME_OUT = { TEME: 'TEMEOfDate', J2000: 'J2000', FIXED: 'Fixed', TOD: 'TrueOfDate', MOD: 'MeanOfDate' }
const OEM_FRAME_OUT = { TEME: 'TEME', J2000: 'EME2000', FIXED: 'ITRF2020', TOD: 'TOD', MOD: 'MOD' }
// 位置 / 速度写 9 位小数 = 1e-9 km（与 §6.2 的回环判据同一把尺：同格式导入->导出，位置逐位
// 相同到 1e-9 km）。用定点而非「9 位有效数字」：后者在 6878 km 量级只有 1e-5 km 分辨率，
// 过不了回环判据；定点 9 位对 LEO 到深空全段都是 1e-9 km，且 STK / OEM 都认。
const sig9 = (x) => {
  const v = Number(x)
  return Number.isFinite(v) ? v.toFixed(9) : '0.000000000'
}
const fix6 = (x) => Number(x).toFixed(6)

function serializeStkE(sats, opts) {
  const o = opts || {}
  const s = convertSat(sats[0], o.frame)
  const n = s.t.length
  const epoch = s.t[0]
  const L = []
  L.push('stk.v.12.0')
  L.push('')
  L.push('BEGIN Ephemeris')
  L.push('')
  L.push('NumberOfEphemerisPoints ' + n)
  L.push('ScenarioEpoch            ' + T.formatUtcg(epoch))
  L.push('InterpolationMethod      ' + (s.interp && s.interp.method === 'hermite' ? 'Hermite' : 'Lagrange'))
  L.push('InterpolationSamplesM1   ' + Math.max(1, ((s.interp && s.interp.samples) || 6) - 1))
  L.push('CentralBody              Earth')
  L.push('CoordinateSystem         ' + (E_FRAME_OUT[FR.normFrame(s.frame)] || 'TEMEOfDate'))
  L.push('DistanceUnit             Kilometers')
  L.push('')
  L.push(s.v ? 'EphemerisTimePosVel' : 'EphemerisTimePos')
  L.push('')
  for (let i = 0; i < n; i++) {
    const cols = [fix6((s.t[i] - epoch) / 1000), sig9(s.p[3 * i]), sig9(s.p[3 * i + 1]), sig9(s.p[3 * i + 2])]
    if (s.v) cols.push(sig9(s.v[3 * i]), sig9(s.v[3 * i + 1]), sig9(s.v[3 * i + 2]))
    L.push(cols.join(' '))
  }
  L.push('')
  L.push('END Ephemeris')
  L.push('')
  return L.join('\n')
}

function oemHeaderLines(opts) {
  const o = opts || {}
  return {
    vers: '3.0',
    created: T.formatCcsds(Number.isFinite(o.createdMs) ? o.createdMs : Date.now()),
    originator: o.originator || '卫星仿真平台'
  }
}
function serializeOemKvn(sats, opts) {
  const h = oemHeaderLines(opts)
  const L = []
  L.push('CCSDS_OEM_VERS = ' + h.vers)
  L.push('CREATION_DATE = ' + h.created)
  L.push('ORIGINATOR = ' + h.originator)
  for (const raw of sats) {
    const s = convertSat(raw, opts && opts.frame)
    const n = s.t.length
    const spans = s.spans && s.spans.length ? s.spans : [[s.t[0], s.t[n - 1]]]
    let k = 0
    for (const sp of spans) {
      L.push('')
      L.push('META_START')
      L.push('OBJECT_NAME = ' + (s.name || 'SATELLITE'))
      L.push('OBJECT_ID = ' + (s.objectId || 'UNKNOWN'))
      L.push('CENTER_NAME = EARTH')
      L.push('REF_FRAME = ' + (OEM_FRAME_OUT[FR.normFrame(s.frame)] || 'TEME'))
      L.push('TIME_SYSTEM = UTC')
      L.push('START_TIME = ' + T.formatCcsds(sp[0]))
      L.push('STOP_TIME = ' + T.formatCcsds(sp[1]))
      L.push('INTERPOLATION = ' + ((s.interp && s.interp.method === 'hermite') ? 'HERMITE' : 'LAGRANGE'))
      L.push('INTERPOLATION_DEGREE = ' + Math.max(1, ((s.interp && s.interp.samples) || 6) - 1))
      L.push('META_STOP')
      L.push('')
      for (; k < n && s.t[k] <= sp[1]; k++) {
        const cols = [T.formatCcsds(s.t[k]), sig9(s.p[3 * k]), sig9(s.p[3 * k + 1]), sig9(s.p[3 * k + 2])]
        if (s.v) cols.push(sig9(s.v[3 * k]), sig9(s.v[3 * k + 1]), sig9(s.v[3 * k + 2]))
        L.push(cols.join(' '))
      }
    }
  }
  L.push('')
  return L.join('\n')
}
function serializeOemXml(sats, opts) {
  const h = oemHeaderLines(opts)
  const L = []
  L.push('<?xml version="1.0" encoding="UTF-8"?>')
  L.push('<oem id="CCSDS_OEM_VERS" version="' + h.vers + '">')
  L.push('  <header>')
  L.push('    <CREATION_DATE>' + h.created + '</CREATION_DATE>')
  L.push('    <ORIGINATOR>' + xmlEsc(h.originator) + '</ORIGINATOR>')
  L.push('  </header>')
  L.push('  <body>')
  for (const raw of sats) {
    const s = convertSat(raw, opts && opts.frame)
    const n = s.t.length
    const spans = s.spans && s.spans.length ? s.spans : [[s.t[0], s.t[n - 1]]]
    let k = 0
    for (const sp of spans) {
      L.push('    <segment>')
      L.push('      <metadata>')
      L.push('        <OBJECT_NAME>' + xmlEsc(s.name || 'SATELLITE') + '</OBJECT_NAME>')
      L.push('        <OBJECT_ID>' + xmlEsc(s.objectId || 'UNKNOWN') + '</OBJECT_ID>')
      L.push('        <CENTER_NAME>EARTH</CENTER_NAME>')
      L.push('        <REF_FRAME>' + (OEM_FRAME_OUT[FR.normFrame(s.frame)] || 'TEME') + '</REF_FRAME>')
      L.push('        <TIME_SYSTEM>UTC</TIME_SYSTEM>')
      L.push('        <START_TIME>' + T.formatCcsds(sp[0]) + '</START_TIME>')
      L.push('        <STOP_TIME>' + T.formatCcsds(sp[1]) + '</STOP_TIME>')
      L.push('        <INTERPOLATION>' + ((s.interp && s.interp.method === 'hermite') ? 'HERMITE' : 'LAGRANGE') + '</INTERPOLATION>')
      L.push('        <INTERPOLATION_DEGREE>' + Math.max(1, ((s.interp && s.interp.samples) || 6) - 1) + '</INTERPOLATION_DEGREE>')
      L.push('      </metadata>')
      L.push('      <data>')
      for (; k < n && s.t[k] <= sp[1]; k++) {
        L.push('        <stateVector>')
        L.push('          <EPOCH>' + T.formatCcsds(s.t[k]) + '</EPOCH>')
        L.push('          <X>' + sig9(s.p[3 * k]) + '</X>')
        L.push('          <Y>' + sig9(s.p[3 * k + 1]) + '</Y>')
        L.push('          <Z>' + sig9(s.p[3 * k + 2]) + '</Z>')
        if (s.v) {
          L.push('          <X_DOT>' + sig9(s.v[3 * k]) + '</X_DOT>')
          L.push('          <Y_DOT>' + sig9(s.v[3 * k + 1]) + '</Y_DOT>')
          L.push('          <Z_DOT>' + sig9(s.v[3 * k + 2]) + '</Z_DOT>')
        }
        L.push('        </stateVector>')
      }
      L.push('      </data>')
      L.push('    </segment>')
    }
  }
  L.push('  </body>')
  L.push('</oem>')
  L.push('')
  return L.join('\n')
}

function serializeEphemeris(sats, format, opts) {
  const arr = Array.isArray(sats) ? sats.filter((s) => s && s.t && s.t.length >= 1) : []
  if (!arr.length) throw new Error('没有可导出的星历点')
  switch (format) {
    case 'stk-e': return serializeStkE(arr, opts)
    case 'ccsds-oem-kvn': return serializeOemKvn(arr, opts)
    case 'ccsds-oem-xml': return serializeOemXml(arr, opts)
    default: throw new Error('未知导出格式：' + format)
  }
}

// SP3 在 §7 另行接入（本文件的 parseSp3 由 sp3.js 注入，保持本模块只管一件事）
let parseSp3 = null
function registerSp3(fn) { parseSp3 = fn }

module.exports = {
  FORMATS, FORMAT_LABEL, FORMAT_EXT,
  stripBom, detectFormat, parseEphemeris, serializeEphemeris, convertSat, registerSp3,
  geodeticToEcef, sphericalToEcef, oemFrame
}
