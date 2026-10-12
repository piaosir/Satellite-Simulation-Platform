// 外部「时间标签位置序列」星历的解析与序列化（纯 CommonJS）。
//
// 【格式清单】与 ommFormats.js 的六种【平均根数】格式并列，互不相干 —— 那六种喂 SGP4，这几种
// 喂插值器（ephemInterp）。全部由 detectFormat 按内容识别，扩展名只作兜底。
//   stk-e            STK .e（BEGIN/END Ephemeris，EpSec/UTCG/ISO-YMD/JDate 四种时间写法）
//   ccsds-oem-kvn    CCSDS 502.0-B OEM 关键字=值报文（多段 = 同一星多段）
//   ccsds-oem-xml    CCSDS 505.0-B NDM/XML 的 <oem>
//   sp3              SP3-c/d 精密星历（解析在 sp3.js，本文件只负责嗅探与分派）
//   cs-eph           中国卫通测控星历报文（.eph，「地固坐标系瞬根」；解析与写出在 csEph.js，GBK 由 textCodec 管）
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
// SP3 单独一个文件：它的定长栏位与哨兵值自成一套，与 .e / OEM 没有共用逻辑（见 sp3.js 头注）
const { parseSp3, SP3_SYS } = require('./sp3.js')
// 中国卫通 .eph 同理单独一个文件：版式全部来自实物逐字节分析（见 csEph.js 头注）
const CS = require('./csEph.js')
// 重复时刻 / 段界 / 缺口的整理（.e 的 SegmentBoundaryTimes 与 .eph 的机动断点共用）
const NZ = require('./ephemNormalize.js')

const FORMATS = ['stk-e', 'ccsds-oem-kvn', 'ccsds-oem-xml', 'sp3', 'cs-eph']
const FORMAT_LABEL = {
  'stk-e': 'STK 星历（.e）',
  'ccsds-oem-kvn': 'CCSDS OEM（KVN）',
  'ccsds-oem-xml': 'CCSDS OEM（XML）',
  sp3: 'SP3 精密星历',
  'cs-eph': CS.LABEL
}
const FORMAT_EXT = { 'stk-e': '.e', 'ccsds-oem-kvn': '.oem', 'ccsds-oem-xml': '.xml', sp3: '.sp3', 'cs-eph': CS.EXT }
// 一个文件只装一颗星的格式：多星导出须一星一个文件（STK .e 没有星名字段；.eph 表头只有一个标题）
const SINGLE_OBJECT = ['stk-e', 'cs-eph']
// 写出时的字符编码：.eph 是 GBK（源软件是 Windows 简体中文 ANSI 程序），其余一律 UTF-8 无 BOM
const FORMAT_ENCODING = { 'cs-eph': CS.ENCODING }
// 【写得出的格式】SP3 只解析不写出（定长栏位 + 钟差哨兵那一套，本平台没有写出器），
// 故 FORMATS 四种里只有下面三种进得了 serializeEphemeris。凡「导出成 sp3」的请求一律归一成
// stk-e —— 扩展名、默认文件名、返回值的 format 都要跟着归一后的走，否则会落盘一个
// 「扩展名 .sp3、正文却是 STK .e」的文件。
const WRITABLE = ['stk-e', 'ccsds-oem-kvn', 'ccsds-oem-xml', 'cs-eph']
const writableFormat = (f) => (f === 'sp3' ? 'stk-e' : f)

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
  if (CS.detectCsEph(s)) return 'cs-eph'
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
  // SegmentBoundaryTimes：STK 规定数据点只有在这些时刻才允许重复（段界两侧各一个状态），插值不许跨过
  let inSbt = false
  const sbtRaw = []

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li]
    const hash = line.indexOf('#')
    if (hash >= 0) line = line.slice(0, hash)
    line = line.trim()
    if (!line) continue
    const tok = line.split(/\s+/)
    const k0 = tok[0].toLowerCase()

    if (/^stk\.v\./i.test(tok[0])) { continue }
    if (E_BLOCKS[k0] && tok.length === 1) { block = E_BLOCKS[k0]; blockKind = k0; skipping = false; inSbt = false; continue }
    if (k0 === 'end' && /ephemeris/i.test(tok[1] || '')) { block = null; skipping = false; inSbt = false; continue }
    if (k0 === 'begin' && /^segmentboundarytimes$/i.test(tok[1] || '')) { inSbt = true; block = null; continue }
    if (k0 === 'end' && /^segmentboundarytimes$/i.test(tok[1] || '')) { inSbt = false; continue }
    if (inSbt) { sbtRaw.push(tok.join(' ')); continue }
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

  // 段界：SegmentBoundaryTimes 列出的时刻（按 TimeFormat 读，读不出再按 EpSec），连同数据里的重复时刻一起拆段
  const bounds = []
  for (const raw of sbtRaw) {
    let ms = T.parseTimeToken(raw, timeFormat, epochMs)
    if (!Number.isFinite(ms) && /^[-+]?[\d.]+(?:e[-+]?\d+)?$/i.test(raw)) ms = epochMs + parseFloat(raw) * 1000
    if (Number.isFinite(ms)) bounds.push(ms)
    else warnings.push('SegmentBoundaryTimes 中的时刻无法解析：' + raw)
  }
  const nrows = new Array(n)
  for (let i = 0; i < n; i++) nrows[i] = { ms: t[i], p: [p[3 * i], p[3 * i + 1], p[3 * i + 2]], v: v ? [v[3 * i], v[3 * i + 1], v[3 * i + 2]] : null }
  const nz = NZ.normalizeRows(nrows, { dupIsBoundary: true, boundaries: bounds })
  for (const w of nz.warnings) warnings.push(w)

  return {
    sats: [{
      name: name || 'Ephemeris', objectId: '', frame, timeSystem: 'UTC',
      interp: { method, samples: samplesM1 + 1 },
      t: nz.t, p: nz.p, v: nz.v, spans: nz.spans,
      meta: { scenarioEpochMs: epochMs, distanceUnit: unit, timeFormat, boundaries: nz.report.boundaries, jumps: nz.report.jumps, gaps: nz.report.gaps }
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

// OBJECT_ID 是不是一个真编号：空串与 UNKNOWN（没有国际编号时的占位写法）都不算
const realObjectId = (x) => { const v = String(x == null ? '' : x).trim(); return v && v.toUpperCase() !== 'UNKNOWN' ? v : '' }

// 多段 -> 星（按 OBJECT_ID 归并；OBJECT_ID 为空或 UNKNOWN 时连同 OBJECT_NAME 一起认；都没有就单星）
// ★ 不能只按 OBJECT_ID：多颗没有国际编号的星（自建星座 / 导入点序列…）同在一个文件里时 OBJECT_ID 常常都是
//   UNKNOWN，只按它归并会把几颗星的段并成一颗、时刻交错出一条假轨迹
function oemSatsFromSegments(segs, errors, warnings) {
  const byKey = new Map()
  for (const s of segs) {
    const oid = String(s.objectId || '').trim()
    const key = (realObjectId(oid) ? oid : oid + '|' + (s.objectName || '#1')).toUpperCase()
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(s)
  }
  const sats = []
  for (const [, list] of byKey) {
    list.sort((a, b) => a.rows[0].ms - b.rows[0].ms)
    const frame = list[0].frame
    if (list.some((s) => s.frame !== frame)) { errors.push('同一星的多段参考系不一致，已拒收'); continue }
    const hasV = list.every((s) => s.hasV)
    // 段与段拼接交给 normalizeRows：每段首行标 cut。机动星历常见「下一段 START_TIME = 上一段 STOP_TIME」，
    // 两段在同一历元各有一个状态 —— 原来直接拼数组，建表时把后一个（机动后的状态）当重复时刻剔掉，
    // 段缝后面整整一个步长取不到位置。现在机动前后两个状态都留下（后者顺延 1 ms），段间照旧不插值。
    const rows = []
    for (const s of list) {
      s.rows.forEach((r, i) => rows.push({ ms: r.ms, p: [r.nums[0], r.nums[1], r.nums[2]], v: hasV ? [r.nums[3], r.nums[4], r.nums[5]] : null, cut: i === 0 && rows.length > 0 }))
    }
    const nz = NZ.normalizeRows(rows, {})
    for (const w of nz.warnings) warnings.push(w)
    sats.push({
      name: list[0].objectName || list[0].objectId || 'OEM', objectId: realObjectId(list[0].objectId),
      frame, timeSystem: list[0].tsys, interp: { method: list[0].method, samples: list[0].samples },
      t: nz.t, p: nz.p, v: nz.v, spans: nz.spans, meta: { segments: list.length, jumps: nz.report.jumps, gaps: nz.report.gaps }
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
    case 'sp3': r = parseSp3(src); break
    case 'cs-eph': r = CS.parseCsEph(src, { name }); break
    default: return { format: '', sats: [], errors: ['无法识别的星历格式（支持 STK .e / CCSDS OEM 的 KVN 与 XML / SP3 / 中国卫通 .eph）'], warnings: [] }
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
// CCSDS KVN 只许可打印 ASCII（502.0-B-3 的 KVN 字符集）：星名带中文的退到 OBJECT_ID / 编号
const isAscii = (s) => /^[\x20-\x7E]*$/.test(String(s == null ? '' : s))
const asciiName = (name, fallback) => (name && isAscii(name) ? String(name) : (fallback && isAscii(fallback) ? String(fallback) : 'SATELLITE'))
const ORIGINATOR = 'SATSIM'
// OEM 的 OBJECT_ID：有国际编号用它；没有的（自建星座 / 导入点序列 / 天线树 / 定点星）给每颗星一个唯一的 ASCII 标识。
// 多星同文件时读入方（本平台、Orekit 一类按 OBJECT_ID 分对象的读者）靠它区分星，共用 UNKNOWN 会把几颗星并成一颗。
// 优先取编号（同一批里唯一），没有编号再取星名；两样都写不成 ASCII 才退回 UNKNOWN（读端会再连同 OBJECT_NAME 认）
const tokenAscii = (x) => { const v = String(x == null ? '' : x).trim().replace(/\s+/g, '_'); return /^[\x21-\x7E]+$/.test(v) ? v : '' }
function oemObjectId(s) {
  const real = realObjectId(s.objectId)
  if (real && isAscii(real)) return real
  const nid = tokenAscii(s.noradId)
  if (nid) return 'SATSIM-' + nid
  const nm = tokenAscii(s.name)
  return nm ? 'SATSIM-' + nm : 'UNKNOWN'
}

// 一颗星按 spans 切成下标段 [{ a, b }]（含两端）；没有 spans 就是整段
function segRanges(s) {
  const n = s.t.length
  if (!s.spans || s.spans.length < 2) return [{ a: 0, b: n - 1 }]
  const out = []
  let k = 0
  for (const sp of s.spans) {
    while (k < n && s.t[k] < sp[0]) k++
    const a = k
    while (k < n && s.t[k] <= sp[1]) k++
    if (k - 1 >= a) out.push({ a, b: k - 1 })
  }
  return out.length ? out : [{ a: 0, b: n - 1 }]
}
// 段首点若是解析时顺延 1 ms 的「段界后状态」，写出时还原到段界时刻（STK 靠 SegmentBoundaryTimes、
// OEM 靠相邻两段同历元表达同刻两状态）；真缺口照原样
const outTime = (s, k, isSegHead) => (isSegHead && k > 0 && s.t[k] - s.t[k - 1] <= NZ.NUDGE_MS && s.t[k] > s.t[k - 1] ? s.t[k - 1] : s.t[k])
// 插值口径：调用方给了 opts.interp（导出对话框的选择）就用它，否则沿用星自己的
function interpOut(s, o) {
  const ip = (o && o.interp) || s.interp || {}
  const method = String(ip.method || 'lagrange').toLowerCase() === 'hermite' && s.v ? 'hermite' : 'lagrange'
  let samples = Math.round(Number(ip.samples) || 0)
  if (!(samples >= 2)) samples = method === 'hermite' ? 2 : 6
  return { method, samples }
}

function serializeStkE(sats, opts) {
  const o = opts || {}
  const s = convertSat(sats[0], o.frame)
  const n = s.t.length
  const epoch = s.t[0]
  const ip = interpOut(s, o)
  const R = segRanges(s)
  const L = []
  L.push('stk.v.12.0')
  L.push('')
  L.push('BEGIN Ephemeris')
  L.push('')
  L.push('NumberOfEphemerisPoints ' + n)
  L.push('ScenarioEpoch            ' + T.formatUtcg(epoch))
  L.push('InterpolationMethod      ' + (ip.method === 'hermite' ? 'Hermite' : 'Lagrange'))
  // Hermite 的阶 = 2 × SamplesM1 + 1（STK 规范原文），两点三次 Hermite 即 SamplesM1 = 1
  L.push('InterpolationSamplesM1   ' + Math.max(1, ip.samples - 1))
  L.push('CentralBody              Earth')
  L.push('CoordinateSystem         ' + (E_FRAME_OUT[FR.normFrame(s.frame)] || 'TEMEOfDate'))
  L.push('DistanceUnit             Kilometers')
  L.push('')
  if (R.length > 1) {
    // 段界时刻（相对 ScenarioEpoch 的秒，升序）：STK 只在这些时刻允许同刻两点，且不跨段插值
    L.push('BEGIN SegmentBoundaryTimes')
    for (let r = 0; r < R.length - 1; r++) L.push('    ' + fix6((s.t[R[r].b] - epoch) / 1000))
    L.push('END SegmentBoundaryTimes')
    L.push('')
  }
  L.push(s.v ? 'EphemerisTimePosVel' : 'EphemerisTimePos')
  L.push('')
  for (let r = 0; r < R.length; r++) {
    if (r > 0) L.push('')   // 规范惯例：段界两侧的同刻两点之间空一行
    for (let k = R[r].a; k <= R[r].b; k++) {
      const tm = outTime(s, k, r > 0 && k === R[r].a)
      const cols = [fix6((tm - epoch) / 1000), sig9(s.p[3 * k]), sig9(s.p[3 * k + 1]), sig9(s.p[3 * k + 2])]
      if (s.v) cols.push(sig9(s.v[3 * k]), sig9(s.v[3 * k + 1]), sig9(s.v[3 * k + 2]))
      L.push(cols.join(' '))
    }
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
    originator: o.originator && isAscii(o.originator) ? o.originator : ORIGINATOR
  }
}
// 一颗星的 OEM 段（各段的元数据值 + 数据下标）：KVN 与 XML 共用
function oemSegments(raw, opts, ascii) {
  const s = convertSat(raw, opts && opts.frame)
  const ip = interpOut(s, opts)
  // INTERPOLATION_DEGREE = 插值多项式的次数：Lagrange 为点数 − 1，Hermite（位置 + 速度）为 2 × 点数 − 1
  const degree = ip.method === 'hermite' ? 2 * ip.samples - 1 : ip.samples - 1
  const id = oemObjectId(s)
  const name = ascii ? asciiName(s.name, realObjectId(s.objectId) || (s.noradId ? 'NORAD ' + s.noradId : '')) : (s.name || 'SATELLITE')
  return segRanges(s).map((rg, r) => ({
    s, rg, head: r > 0,
    meta: {
      OBJECT_NAME: name, OBJECT_ID: id, CENTER_NAME: 'EARTH',
      REF_FRAME: OEM_FRAME_OUT[FR.normFrame(s.frame)] || 'TEME', TIME_SYSTEM: 'UTC',
      START_TIME: T.formatCcsds(outTime(s, rg.a, r > 0)), STOP_TIME: T.formatCcsds(s.t[rg.b]),
      INTERPOLATION: ip.method === 'hermite' ? 'HERMITE' : 'LAGRANGE', INTERPOLATION_DEGREE: String(Math.max(1, degree))
    }
  }))
}
const OEM_META_ORDER = ['OBJECT_NAME', 'OBJECT_ID', 'CENTER_NAME', 'REF_FRAME', 'TIME_SYSTEM', 'START_TIME', 'STOP_TIME', 'INTERPOLATION', 'INTERPOLATION_DEGREE']
// OEM 拆成「头 / 每星一块 / 尾」三段：整份一次写出（serializeOem*）与导出引擎的边算边写盘走同一份代码，
// 两条路的字节天然一致。每段都是「换行 + 行」的拼接，头不带换行收尾，尾补最后那个换行。
function oemKvnHead(opts) {
  const h = oemHeaderLines(opts)
  return 'CCSDS_OEM_VERS = ' + h.vers + '\nCREATION_DATE = ' + h.created + '\nORIGINATOR = ' + h.originator
}
function oemKvnBody(raw, opts) {
  const L = []
  for (const seg of oemSegments(raw, opts, true)) {
    const { s, rg } = seg
    L.push('')
    L.push('META_START')
    for (const k of OEM_META_ORDER) L.push(k + ' = ' + seg.meta[k])
    L.push('META_STOP')
    L.push('')
    for (let k = rg.a; k <= rg.b; k++) {
      const cols = [T.formatCcsds(outTime(s, k, seg.head && k === rg.a)), sig9(s.p[3 * k]), sig9(s.p[3 * k + 1]), sig9(s.p[3 * k + 2])]
      if (s.v) cols.push(sig9(s.v[3 * k]), sig9(s.v[3 * k + 1]), sig9(s.v[3 * k + 2]))
      L.push(cols.join(' '))
    }
  }
  return L.length ? '\n' + L.join('\n') : ''
}
const oemKvnTail = () => '\n'
function serializeOemKvn(sats, opts) {
  let out = oemKvnHead(opts)
  for (const raw of sats) out += oemKvnBody(raw, opts)
  return out + oemKvnTail()
}
function oemXmlHead(opts) {
  const h = oemHeaderLines(opts)
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<oem id="CCSDS_OEM_VERS" version="' + h.vers + '">', '  <header>',
    '    <CREATION_DATE>' + h.created + '</CREATION_DATE>', '    <ORIGINATOR>' + xmlEsc(h.originator) + '</ORIGINATOR>',
    '  </header>', '  <body>'].join('\n')
}
function oemXmlBody(raw, opts) {
  const L = []
  for (const seg of oemSegments(raw, opts, false)) {
    const { s, rg } = seg
    L.push('    <segment>')
    L.push('      <metadata>')
    for (const k of OEM_META_ORDER) L.push('        <' + k + '>' + xmlEsc(seg.meta[k]) + '</' + k + '>')
    L.push('      </metadata>')
    L.push('      <data>')
    for (let k = rg.a; k <= rg.b; k++) {
      L.push('        <stateVector>')
      L.push('          <EPOCH>' + T.formatCcsds(outTime(s, k, seg.head && k === rg.a)) + '</EPOCH>')
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
  return L.length ? '\n' + L.join('\n') : ''
}
const oemXmlTail = () => '\n  </body>\n</oem>\n'
function serializeOemXml(sats, opts) {
  let out = oemXmlHead(opts)
  for (const raw of sats) out += oemXmlBody(raw, opts)
  return out + oemXmlTail()
}
// 流式写出用的三段（只有能多星同文件的格式才有：OEM 两种）
const STREAM_PARTS = {
  'ccsds-oem-kvn': { head: oemKvnHead, body: oemKvnBody, tail: oemKvnTail },
  'ccsds-oem-xml': { head: oemXmlHead, body: oemXmlBody, tail: oemXmlTail }
}
// 没有速度的星（SP3、只给位置的 .e）补速度：按它自己的插值口径建表，在每个采样时刻取插值多项式的导数。
// .eph 的六列是版式的一部分，缺速度列的文件它的读者读不了。
function ensureVelocity(s) {
  if (s.v) return s
  const EI = require('./ephemInterp.js')
  const tab = EI.buildTable(s)
  if (!tab) throw new Error('星历点不足，补不出速度')
  const v = new Float64Array(3 * tab.n)
  for (let k = 0; k < tab.n; k++) {
    const r = EI.evalTable(tab, tab.t[k])
    v[3 * k] = r ? r.vx : 0; v[3 * k + 1] = r ? r.vy : 0; v[3 * k + 2] = r ? r.vz : 0
  }
  return Object.assign({}, s, { frame: 'TEME', t: tab.t, p: tab.p, v })
}
// 中国卫通 .eph：恒为地固系；opts.header / opts.dupTimes 来自同格式导入时留下的原表头与原重复行
function serializeCsEphSat(sats, opts) {
  const o = opts || {}
  const s = convertSat(ensureVelocity(sats[0]), 'FIXED')
  return CS.serializeCsEph(s, { title: o.title != null ? o.title : s.name, createdMs: o.createdMs, header: o.header || null, dupTimes: o.dupTimes || null })
}

function serializeEphemeris(sats, format, opts) {
  const arr = Array.isArray(sats) ? sats.filter((s) => s && s.t && s.t.length >= 1) : []
  if (!arr.length) throw new Error('没有可导出的星历点')
  switch (format) {
    case 'stk-e': return serializeStkE(arr, opts)
    case 'ccsds-oem-kvn': return serializeOemKvn(arr, opts)
    case 'ccsds-oem-xml': return serializeOemXml(arr, opts)
    case 'cs-eph': return serializeCsEphSat(arr, opts)
    default: throw new Error('未知导出格式：' + format)
  }
}

module.exports = {
  FORMATS, FORMAT_LABEL, FORMAT_EXT, FORMAT_ENCODING, SINGLE_OBJECT, WRITABLE, STREAM_PARTS, writableFormat, segRanges, isAscii, ensureVelocity,
  stripBom, detectFormat, parseEphemeris, serializeEphemeris, convertSat, parseSp3, SP3_SYS,
  geodeticToEcef, sphericalToEcef, oemFrame
}
