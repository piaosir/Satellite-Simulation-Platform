// 中国卫通测控星历报文（.eph，表头「地固坐标系瞬根」）的解析与序列化（纯 CommonJS）。
//
// 【这是什么格式】不是 CCSDS / STK / SP3 这类公开标准，是测控系统自用的文本报文（公开资料查不到规范）。
// 以下全部口径来自实物 6C-20260930.eph（中星 6C，130.57°E）的逐字节分析：
//   编码  GBK（CP936，Windows 简体中文 ANSI），行尾 CRLF，末行后也有 CRLF。
//   第 1 行  49 个 '_' + 标题 + 下划线补齐到 104 字节；样本的标题是 14 个 '%'（占位，非星名）。
//   第 2 行  40 个空格。
//   第 3 行  49 个 '_' + 「地固坐标系瞬根」（GBK 14 字节）+ 41 个 '_' + 生成时刻（本地时，yyyy/M/d H:mm:ss）。
//   第 4 行  列头：_______Time(UTC)___…___X___…___dZ___（下划线当分隔）。
//   数据行  yyyy/M/d H:mm:ss，再 6 列：X Y Z dX dY dZ。每列 = 两个空格 + 符号位（负号或空格）+ Delphi
//          ffExponent 体例（15 位有效数字、指数 4 位：-2.74261083105968E+0007），行尾再两个空格。
//   单位  位置 m、速度 m/s；坐标系 = 地固系（瞬根 = 瞬时状态矢量）；速度是相对旋转系的速度。
//   步长  60 s。机动处：机动开始时刻单独一行（08:55:18）→ 机动结束时刻一行（09:05:18）→ 该行【原样重复一次】
//         （弧段边界），之后网格改从机动结束时刻起每 60 s 一行（秒位因此从 :00 错到 :18）；末行落在整段终止时刻。
// 数据本身的三个特征（解析不依赖它们，只作诊断依据）：
//   · 加速度与地固系动力学（g − 2ω×v − ω×(ω×r)）吻合到 1e-6 m/s²，与惯性系假设差四个量级 —— 帧确为地固；
//   · 速度比位置差分系统性偏东 ~5e-4 m/s（速度换算用的地球自转角速度与位置帧差 ~1.1e-11 rad/s）；
//   · UTC 零点前后位置有米级跳步（日更的 UT1−UTC 不内插所致）。三者都远在任何链路几何的需要之下。
//
// 【鲁棒性】编码（由 textCodec 在读文件时识别）、行尾、表头缺失 / 残缺、帧名写法（地固 / J2000 / 惯性 / 真赤道 /
//   平赤道 / TEME / WGS-84 / CGCS2000）、时间系统（UTC / 北京时 / GPS / BDT / TAI / TT）、日期写法（/ - . 分隔、
//   T 连接、带小数秒）、数值写法（Delphi E+0007 / 常规科学计数 / 定点 / Fortran D 指数）、分隔符（空格 / Tab / 逗号 /
//   分号）、单位（m 与 km 按量级判，速度单位按位置差分判）、坐标系（表头缺失或与数据矛盾时按动力学判）、
//   重复行 / 机动断点 / 数据缺口（ephemNormalize）、个别坏行（跳过并点名行号），都不会让整份文件失败。
//   另收「瞬时根数」变体（列为 a e i Ω ω M/ν），按二体换算成状态矢量。「平根」报文拒收（要源软件的平根理论）。
//
// 【写出】serializeCsEph 逐字节复刻上述版式（GBK 编码由调用方用 textCodec.encodeText(…,'gbk') 完成）。
//   给了 header（导入时留下的原表头四行）就原样用，否则按样本生成；坐标系恒为地固——这是该报文唯一见过的
//   帧，写别的帧等于发明格式。段界（spans 里顺延 1 ms 的那一点）按样本惯例写成「同一时刻两行」。

'use strict'

const T = require('./timeSystems.js')
const N = require('./ephemNormalize.js')

const ID = 'cs-eph'
const LABEL = '中国卫通星历（.eph）'
const EXT = '.eph'
const ENCODING = 'gbk'

// 版式常数（全部取自样本）
const TITLE_LEFT = 49
const TITLE_WIDTH = 55              // 标题 + 右侧下划线 = 55 字节（49 + 55 = 104）
const BLANK_LINE = ' '.repeat(40)
const FRAME_TITLE_FIXED = '地固坐标系瞬根'
const FRAME_RIGHT = 41
const COL_HEADER = '_______Time(UTC)_______________X_________________________Y________________________Z________________________dX_______________________dY_______________________dZ___________'

const MU = 398600.4418
const DEG = Math.PI / 180
const STD_COLS = ['X', 'Y', 'Z', 'VX', 'VY', 'VZ']   // 写出器的列次序（列名语义，见 COL_ALIASES）

/* ===================== 行级词法 ===================== */
// 日期时间开头：yyyy/M/d H:mm[:ss[.fff]]，分隔符 / - . 均可，日期与时刻之间空白或 T
const DT_RE = /^\s*(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?:[ \t]+|T)(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?\s*(?:Z\b|UTC\b)?/i
const NUM_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[EeDd][-+]?\d+)?$/
const daysIn = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]

// 一行 → { ms（按文件时标读的「读数毫秒」）, nums:[…] } | { err } | null（不是数据行）
function lexDataLine(line) {
  const m = DT_RE.exec(line)
  if (!m) return null
  const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5]
  const sec = m[6] === undefined ? 0 : parseFloat(m[6])
  if (mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || !(sec >= 0 && sec < 61)) return { err: '日期时刻超出范围' }
  const rest = line.slice(m[0].length).trim()
  if (!rest) return { err: '缺数值列' }
  const tok = rest.split(/[\s,;]+/).filter(Boolean)
  const nums = new Array(tok.length)
  for (let i = 0; i < tok.length; i++) {
    if (!NUM_RE.test(tok[i])) return { err: '第 ' + (i + 1) + ' 列不是数值（' + tok[i].slice(0, 24) + '）' }
    nums[i] = Number(tok[i].replace(/[dD]/, 'E'))
    if (!Number.isFinite(nums[i])) return { err: '第 ' + (i + 1) + ' 列数值溢出' }
  }
  return { ms: Date.UTC(y, mo - 1, d, h, mi, 0) + Math.round(sec * 1000), nums }
}

/* ===================== 表头 ===================== */
// 帧名：先查最具体的写法（「历元平赤道」= J2000，必须排在「平赤道」= MOD 之前）
const FRAME_WORDS = [
  [/地固|地心固连|地球固连|ECEF|\bECF\b|ITRF|WGS[-\s_]?84|CGCS\s*2000|\bEFG\b|\bFIXED\b/i, 'FIXED'],
  [/TEME/i, 'TEME'],
  [/J\s*2000|EME\s*2000|历元平赤道|\bICRF\b|\bGCRF\b/i, 'J2000'],
  [/瞬时真赤道|真赤道|真春分|\bTOD\b|TRUE\s*OF\s*DATE/i, 'TOD'],
  [/瞬时平赤道|平赤道|平春分|\bMOD\b|MEAN\s*OF\s*DATE/i, 'MOD'],
  [/惯性|INERTIAL/i, 'J2000']
]
function frameOfText(s) {
  for (const [re, f] of FRAME_WORDS) if (re.test(s)) return f
  return ''
}
// 时标：Time(UTC) / 时间(北京时) …
const SCALE_WORDS = [
  [/^(UTC|UTCG|GMT|Z)$/i, 'UTC'], [/^(BJT|BJ|BST|CST|北京时|北京时间|BEIJING)$/i, 'BJT'],
  [/^(GPS|GPST)$/i, 'GPS'], [/^(BDT|BDS|北斗时)$/i, 'BDT'], [/^TAI$/i, 'TAI'], [/^(TT|TDT)$/i, 'TT'], [/^UT1$/i, 'UTC']
]
function scaleOf(word) {
  const w = String(word || '').trim()
  for (const [re, s] of SCALE_WORDS) if (re.test(w)) return s
  return ''
}
// 列名 → 语义
const COL_ALIASES = {
  X: /^(X|RX|PX|POSX|X_POS)$/i, Y: /^(Y|RY|PY|POSY|Y_POS)$/i, Z: /^(Z|RZ|PZ|POSZ|Z_POS)$/i,
  VX: /^(DX|VX|X_DOT|XDOT|VELX|X'|ẋ)$/i, VY: /^(DY|VY|Y_DOT|YDOT|VELY|Y'|ẏ)$/i, VZ: /^(DZ|VZ|Z_DOT|ZDOT|VELZ|Z'|ż)$/i,
  A: /^(A|SMA|半长轴)$/i, E: /^(E|ECC|偏心率)$/i, I: /^(I|INC|INCL|倾角|轨道倾角)$/i,
  RAAN: /^(RAAN|Ω|OMEGA|NODE|升交点赤经)$/, AOP: /^(AOP|ARGP|ω|W|近地点幅角|近地点角距)$/i,
  M: /^(M|MA|平近点角)$/i, NU: /^(TA|NU|Ν|ν|F|真近点角)$/i
}
function colSem(name) {
  const n = String(name || '').trim()
  for (const k of Object.keys(COL_ALIASES)) if (COL_ALIASES[k].test(n)) return k
  return ''
}
const unitOf = (s) => { const m = /[（(]\s*([^)）]+?)\s*[)）]/.exec(String(s || '')); return m ? m[1].trim() : '' }
const stripUnit = (s) => String(s || '').replace(/[（(][^)）]*[)）]/g, '').trim()

/**
 * 表头若干行 → { title, name, frame, frameText, created, scale, cols:[{sem,unit}], kind:'state'|'elements'|'mean'|'' }
 */
function analyzeHeader(lines) {
  const out = { title: '', name: '', frame: '', frameText: '', created: '', scale: '', cols: null, kind: '', raw: lines.slice() }
  for (const raw of lines) {
    const ln = String(raw)
    const bare = ln.replace(/[_=\-*]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (!bare) continue
    // 列头：含 Time(…) / 时间(…) / Epoch，且后面跟着列名
    if (/(^|[\s_])(time|时间|时刻|epoch|历元)\s*([（(][^)）]*[)）])?([\s_]|$)/i.test(ln) && /[\s_](X|DX|VX|A|SMA|半长轴)[\s_(（]/i.test(ln + ' ')) {
      const toks = ln.split(/[_\s,;|]+/).filter(Boolean)
      let ti = toks.findIndex((x) => /^(time|时间|时刻|epoch|历元)/i.test(x))
      if (ti < 0) ti = 0
      const tUnit = unitOf(toks[ti]) || unitOf(ln.slice(0, ln.indexOf(toks[ti + 1] || '') || undefined))
      out.scale = scaleOf(tUnit) || out.scale
      out.cols = toks.slice(ti + 1).map((x) => ({ name: stripUnit(x), sem: colSem(stripUnit(x)), unit: unitOf(x) }))
      continue
    }
    const f = frameOfText(ln)
    const isMean = /平根/.test(ln)
    // 坐标系行：带帧名（地固 / J2000 / 真赤道…），或带这一行特有的字眼（坐标系 / 瞬根 / 平根）。「星历」「根数」
    // 这类泛称不算——标题常写成「中星6C星历」「ZX6C 轨道根数」，拿它当坐标系行会把真正的坐标系行挤掉
    if (f || /坐标系|瞬根|平根/.test(ln)) {
      // 首个坐标系行定 frameText；先记下的那行没有帧名、这一行有，以这一行为准
      if (!out.frameText || (f && !out.frame)) {
        // 末尾的生成时刻（yyyy/M/d H:mm:ss）剥出来单独存
        const tm = /(\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}[ T]+\d{1,2}:\d{1,2}(?::\d{1,2}(?:\.\d+)?)?)\s*$/.exec(ln)
        out.created = tm ? tm[1] : ''
        out.frameText = (tm ? ln.slice(0, tm.index) : ln).replace(/_+/g, ' ').trim()
        if (f) out.frame = f
        out.kind = isMean ? 'mean' : (/瞬根|状态|位置|速度/.test(ln) ? 'state' : (/根数/.test(ln) ? 'elements' : out.kind))
      }
      continue
    }
    // 标题：首个其它非空行；全是占位符（% * # ? -）就不当星名
    if (!out.title) {
      out.title = bare
      if (!/^[%*#?\s.]+$/.test(bare)) out.name = bare
    }
  }
  return out
}

/* ===================== 瞬时根数 → 状态矢量 ===================== */
function keplerToState(aKm, e, i, raan, argp, anom, isMean) {
  if (!(aKm > 0) || !(e >= 0 && e < 1)) return null
  let nu = anom
  if (isMean) {
    let E = e < 0.8 ? anom : Math.PI
    for (let k = 0; k < 50; k++) { const dE = (E - e * Math.sin(E) - anom) / (1 - e * Math.cos(E)); E -= dE; if (Math.abs(dE) < 1e-14) break }
    nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2))
  }
  const p = aKm * (1 - e * e), r = p / (1 + e * Math.cos(nu)), sq = Math.sqrt(MU / p)
  const xp = r * Math.cos(nu), yp = r * Math.sin(nu)
  const vxp = -sq * Math.sin(nu), vyp = sq * (e + Math.cos(nu))
  const cO = Math.cos(raan), sO = Math.sin(raan), cw = Math.cos(argp), sw = Math.sin(argp), ci = Math.cos(i), si = Math.sin(i)
  const R = [cO * cw - sO * sw * ci, -cO * sw - sO * cw * ci, sO * cw + cO * sw * ci, -sO * sw + cO * cw * ci, sw * si, cw * si]
  return {
    p: [R[0] * xp + R[1] * yp, R[2] * xp + R[3] * yp, R[4] * xp + R[5] * yp],
    v: [R[0] * vxp + R[1] * vyp, R[2] * vxp + R[3] * vyp, R[4] * vxp + R[5] * vyp]
  }
}

/* ===================== 嗅探 ===================== */
function detectCsEph(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '').slice(0, 16384)
  const lines = s.split(/\r\n|\n|\r/)
  let data = 0, header = false, seen = 0
  for (const ln of lines) {
    if (!ln.trim()) continue
    if (++seen > 80) break
    const r = lexDataLine(ln)
    if (r && !r.err && r.nums.length >= 3) { if (++data >= 2) break; continue }
    if (data === 0 && (/(time|时间)\s*[(（]/i.test(ln) || /坐标系|瞬根/.test(ln))) header = true
  }
  // 有表头：两行数据即认；无表头：要求从第一个非空行起就是数据（避免把别的带日期的文本吞进来）
  return data >= 2 && (header || seen === data)
}

/* ===================== 解析 ===================== */
/**
 * text → { sats:[sat], errors, warnings }；sat 与 ephemFormats 的星记录同形（t UTC ms、p km、v km/s、frame）。
 * opts.name：文件名（表头没有星名时用它）。
 */
function parseCsEph(text, opts) {
  const o = opts || {}
  const errors = [], warnings = []
  const src = String(text == null ? '' : text).replace(/^﻿/, '')
  const lines = src.split(/\r\n|\n|\r/)
  const headerLines = []
  const rows = []
  let bad = 0, firstBad = '', trailing = 0
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li]
    // 表头区的空行也要原样留下（样本第 2 行就是 40 个空格）：同格式导出复用原表头时要逐字节还原
    if (!ln.trim()) { if (!rows.length && !bad && headerLines.length < 40 && li < lines.length - 1) headerLines.push(ln); continue }
    const r = lexDataLine(ln)
    if (!r) { if (rows.length) trailing++; else if (headerLines.length < 40) headerLines.push(ln); continue }
    if (r.err) { bad++; if (!firstBad) firstBad = '第 ' + (li + 1) + ' 行' + r.err; continue }
    rows.push({ ms: r.ms, nums: r.nums, line: li + 1 })
  }
  if (bad) warnings.push(bad + ' 行无法解析，已跳过（首个：' + firstBad + '）')
  if (trailing) warnings.push('数据区中夹有 ' + trailing + ' 行非数据文本，已跳过')
  if (!rows.length) { errors.push('没有解析到任何星历行'); return { sats: [], errors, warnings } }

  const hdr = analyzeHeader(headerLines)
  // 平根要源软件自己的平根理论才能传播，本平台没有 —— 只报状态
  if (hdr.kind === 'mean') { errors.push('平根数报文不受支持（' + (hdr.frameText || '平根') + '）'); return { sats: [], errors, warnings } }

  // 列语义：表头给了就按表头，否则按列数（6 = 位置+速度，3 = 位置，≥6 取前 6）
  let cols = hdr.cols && hdr.cols.length ? hdr.cols : null
  const sems = cols ? cols.map((c) => c.sem) : []
  const isElem = sems.includes('A') && sems.includes('E') && sems.includes('I') && (sems.includes('M') || sems.includes('NU'))
  const idx = {}
  if (cols) cols.forEach((c, k) => { if (c.sem && idx[c.sem] == null) idx[c.sem] = k })
  const width = rows.reduce((m, r) => Math.max(m, r.nums.length), 0)
  if (!isElem && (idx.X == null || idx.Y == null || idx.Z == null)) {
    if (cols) warnings.push('列头未识别出 X/Y/Z，按列序解释')
    idx.X = 0; idx.Y = 1; idx.Z = 2
    if (width >= 6) { idx.VX = 3; idx.VY = 4; idx.VZ = 5 } else { delete idx.VX; delete idx.VY; delete idx.VZ }
    cols = null
  }
  const hasVcol = !isElem && idx.VX != null && idx.VY != null && idx.VZ != null
  // 原表头的列布局是不是写出器那一套（X Y Z dX dY dZ 六列、依此次序）：同格式导出复用原表头前要核这一条
  const colsStd = hdr.cols && hdr.cols.length ? (hdr.cols.length === 6 && hdr.cols.every((c, k) => c.sem === STD_COLS[k])) : width === 6

  // 时标
  const scale = hdr.scale || 'UTC'
  if (!hdr.scale && headerLines.length) warnings.push('表头未标时间系统，按 UTC 解析')
  const toUtc = (ms) => (scale === 'BJT' ? ms - 8 * 3600000 : T.utcMsFrom({ system: scale, ms }))

  // 行 → 原始数组
  const nRaw = rows.length
  const tRaw = new Float64Array(nRaw), pRaw = new Float64Array(3 * nRaw)
  let vRaw = hasVcol ? new Float64Array(3 * nRaw) : null
  let kept = 0, shortRows = 0
  const need = isElem ? Math.max(idx.A, idx.E, idx.I, idx.RAAN != null ? idx.RAAN : 0, idx.AOP != null ? idx.AOP : 0, idx.M != null ? idx.M : idx.NU) + 1
    : (hasVcol ? Math.max(idx.X, idx.Y, idx.Z, idx.VX, idx.VY, idx.VZ) + 1 : Math.max(idx.X, idx.Y, idx.Z) + 1)
  const elemRows = isElem ? [] : null
  for (const r of rows) {
    if (r.nums.length < need) { shortRows++; continue }
    tRaw[kept] = toUtc(r.ms)
    if (isElem) elemRows.push(r)
    else {
      pRaw[3 * kept] = r.nums[idx.X]; pRaw[3 * kept + 1] = r.nums[idx.Y]; pRaw[3 * kept + 2] = r.nums[idx.Z]
      if (vRaw) { vRaw[3 * kept] = r.nums[idx.VX]; vRaw[3 * kept + 1] = r.nums[idx.VY]; vRaw[3 * kept + 2] = r.nums[idx.VZ] }
    }
    kept++
  }
  if (shortRows) warnings.push(shortRows + ' 行列数不足，已跳过')
  if (kept < 2) { errors.push('有效星历行不足 2 行'); return { sats: [], errors, warnings } }

  let posScale = 1, velScale = 1, unitPos = 'km', unitVel = ''
  let frame = hdr.frame
  if (isElem) {
    // 瞬时根数：a 按量级判 km / m，角度按表头单位（缺省度）；换成状态矢量后与状态矢量变体同一条路
    const aCol = elemRows.map((r) => r.nums[idx.A]).sort((x, y) => x - y)
    const aMed = aCol[aCol.length >> 1]
    const aScale = aMed > 6.3e6 && aMed < 2e9 ? 1e-3 : (aMed > 6.3e3 && aMed < 2e6 ? 1 : NaN)
    if (!Number.isFinite(aScale)) { errors.push('半长轴量级 ' + aMed + ' 不在近地轨道范围'); return { sats: [], errors, warnings } }
    const angU = hdr.cols ? (hdr.cols[idx.I] && hdr.cols[idx.I].unit) : ''
    const ang = /rad|弧度/i.test(angU || '') ? 1 : DEG
    // 轨道根数只在惯性系有定义，表头却写地固系：数据与表头必有一错，拒收
    if (frame === 'FIXED') { errors.push('瞬时根数报文的表头为地固系，不受支持'); return { sats: [], errors, warnings } }
    if (!frame) { frame = 'J2000'; warnings.push('表头未标坐标系，瞬时根数按 J2000 解析') }
    vRaw = new Float64Array(3 * kept)
    let k = 0
    for (const r of elemRows) {
      const st = keplerToState(r.nums[idx.A] * aScale, r.nums[idx.E], r.nums[idx.I] * ang,
        idx.RAAN != null ? r.nums[idx.RAAN] * ang : 0, idx.AOP != null ? r.nums[idx.AOP] * ang : 0,
        (idx.M != null ? r.nums[idx.M] : r.nums[idx.NU]) * ang, idx.M != null)
      if (!st) { pRaw[3 * k] = NaN; k++; continue }
      pRaw[3 * k] = st.p[0]; pRaw[3 * k + 1] = st.p[1]; pRaw[3 * k + 2] = st.p[2]
      vRaw[3 * k] = st.v[0]; vRaw[3 * k + 1] = st.v[1]; vRaw[3 * k + 2] = st.v[2]
      k++
    }
    unitPos = 'km'; unitVel = 'km/s'
  } else {
    // 位置单位：表头给了就用，否则按 |r| 中位数判（近地轨道 6.3e3–2e6 km ⇔ 6.3e6–2e9 m，两段不重叠）
    const uP = cols && cols[idx.X] ? cols[idx.X].unit : ''
    if (/^km$/i.test(uP) || /千米|公里/.test(uP)) posScale = 1
    else if (/^m$/i.test(uP) || /^米$/.test(uP)) posScale = 1e-3
    else {
      const rs = []
      const stride = Math.max(1, Math.floor(kept / 2000))
      for (let i = 0; i < kept; i += stride) rs.push(Math.hypot(pRaw[3 * i], pRaw[3 * i + 1], pRaw[3 * i + 2]))
      rs.sort((a, b) => a - b)
      const med = rs[rs.length >> 1]
      posScale = med > 6.3e6 && med < 2e9 ? 1e-3 : (med > 6.3e3 && med < 2e6 ? 1 : NaN)
      if (!Number.isFinite(posScale)) { errors.push('位置量级 ' + med.toPrecision(4) + ' 既不像 km 也不像 m（不在近地轨道范围）'); return { sats: [], errors, warnings } }
    }
    unitPos = posScale === 1 ? 'km' : 'm'
    if (posScale !== 1) for (let i = 0; i < 3 * kept; i++) pRaw[i] /= 1000   // 除 1000 是单次正确舍入，乘 1e-3 不是
  }
  const t = tRaw.subarray(0, kept), pKm = pRaw.subarray(0, 3 * kept)

  // 速度单位：表头给了就用；否则拿位置差分标定（1e-3 = m/s，1 = km/s）。标不出来 / 残差大 = 速度列不可信，退回位置插值。
  let vKm = null
  if (vRaw && !isElem) {
    const uV = cols && cols[idx.VX] ? cols[idx.VX].unit : ''
    const hdrSc = /^km\/s$/i.test(uV) || /千米\/秒|公里\/秒/.test(uV) ? 1 : (/^m\/s$/i.test(uV) || /米\/秒/.test(uV) ? 1e-3 : NaN)
    const vs = N.velocityScale(t, pKm, vRaw)   // 相对 km/s 的比例，已吸附到 1e-3 / 1 / 1e3
    let sc = NaN
    if (vs.n >= 2) {
      if (!Number.isFinite(vs.scale)) warnings.push('速度列与位置差分对不上（比例 ' + (Number.isFinite(vs.raw) ? vs.raw.toPrecision(3) : '—') + '），已忽略速度、改按位置插值')
      else if (!(vs.rel < 1e-3)) warnings.push('速度列与位置差分相对残差 ' + (vs.rel * 100).toFixed(2) + '%（以惯性速度计），已忽略速度、改按位置插值')
      else {
        sc = vs.scale
        if (Number.isFinite(hdrSc) && hdrSc !== sc) warnings.push('速度列单位与表头不符（按位置差分应为 ' + (sc === 1 ? 'km/s' : 'm/s') + '），已按差分标定')
      }
    } else sc = Number.isFinite(hdrSc) ? hdrSc : posScale   // 点太少标定不了：按表头，没有就与位置同单位
    if (Number.isFinite(sc)) {
      vKm = new Float64Array(3 * kept)
      for (let i = 0; i < 3 * kept; i++) vKm[i] = sc === 1e-3 ? vRaw[i] / 1000 : vRaw[i] * sc
      unitVel = sc === 1 ? 'km/s' : (sc === 1e-3 ? 'm/s' : 'Mm/s')
    }
  } else if (isElem) vKm = vRaw.subarray(0, 3 * kept)

  // 坐标系：表头为准；表头缺失时按动力学判；两者强烈矛盾（比值两个量级以上）才推翻表头
  const kin = N.kinematicFrame(t, pKm)
  if (!isElem) {
    const strongFixed = kin.ratio >= 100, strongInert = kin.ratio <= 0.01
    if (frame) {
      if (frame !== 'FIXED' && strongFixed) { warnings.push('表头标注为惯性系（' + hdr.frameText + '），数据的动力学特征却是地固系，已按地固系解析'); frame = 'FIXED' }
      else if (frame === 'FIXED' && strongInert) { warnings.push('表头标注为地固系，数据的动力学特征却是惯性系，已按 J2000 解析'); frame = 'J2000' }
      else if ((frame === 'FIXED' && kin.frame === 'INERTIAL') || (frame !== 'FIXED' && kin.frame === 'FIXED')) warnings.push('数据的动力学特征与表头坐标系不太一致（比值 ' + kin.ratio.toPrecision(3) + '），仍按表头解析')
    } else {
      frame = kin.frame === 'INERTIAL' ? 'J2000' : 'FIXED'
      warnings.push(kin.frame ? '表头未标坐标系，按动力学特征判为' + (frame === 'FIXED' ? '地固系' : '惯性系（按 J2000）') : '表头未标坐标系，按地固系解析')
    }
  }

  // 整理：排序 / 重复行（按样本惯例是弧段边界）/ 机动断点 / 缺口
  const prow = new Array(kept)
  for (let i = 0; i < kept; i++) {
    prow[i] = {
      ms: t[i], p: [pKm[3 * i], pKm[3 * i + 1], pKm[3 * i + 2]],
      v: vKm ? [vKm[3 * i], vKm[3 * i + 1], vKm[3 * i + 2]] : null, line: rows[i] ? rows[i].line : 0
    }
  }
  const nz = N.normalizeRows(prow, { dupIsBoundary: true })
  for (const w of nz.warnings) warnings.push(w)
  if (nz.t.length < 2) { errors.push('整理后有效星历点不足 2 个'); return { sats: [], errors, warnings } }

  const name = hdr.name || (o.name && String(o.name).trim()) || 'Ephemeris'
  const sat = {
    name, objectId: '', frame, timeSystem: 'UTC',
    // 有速度就用三次 Hermite：局部两点、天然不跨机动窗口；没有速度退 Lagrange-8
    interp: nz.v ? { method: 'hermite', samples: 2 } : { method: 'lagrange', samples: 8 },
    t: nz.t, p: nz.p, v: nz.v, spans: nz.spans,
    meta: {
      format: ID,
      header: headerLines.some((l) => l.trim()) ? { lines: headerLines.slice() } : null,
      title: hdr.title, frameText: hdr.frameText, created: hdr.created,
      timeScale: scale, unitPos, unitVel, colsStd, elements: isElem,
      headerless: !headerLines.some((l) => l.trim()),
      kinematic: { frame: kin.frame, ratio: Number.isFinite(kin.ratio) ? kin.ratio : null },
      stepS: nz.report.stepS,
      dupTimes: nz.report.dupTimes, jumps: nz.report.jumps, gaps: nz.report.gaps, boundaries: nz.report.boundaries,
      rows: nRaw
    }
  }
  return { sats: [sat], errors, warnings }
}

/* ===================== 写出 ===================== */
// Delphi ffExponent(15, 4)：符号位 + d.dddddddddddddd + E±dddd。toExponential 是精确舍入，
// 15 位有效数字的源串经 double 往返再写回必得原串（DBL_DIG = 15）。
function delphiExp(x) {
  const v = Number.isFinite(x) ? x : 0
  if (v === 0) return ' 0.00000000000000E+0000'
  const m = /^(\d\.\d{14})e([+-])(\d+)$/.exec(Math.abs(v).toExponential(14))
  return (v < 0 ? '-' : ' ') + m[1] + 'E' + m[2] + m[3].padStart(4, '0')
}
const p2 = (n) => String(n).padStart(2, '0')
// UTC 毫秒 → yyyy/M/d H:mm:ss（样本体例：月日时不补零）；非整秒才补 .fff
function fmtTime(ms) {
  const d = new Date(Math.round(ms))
  const frac = d.getUTCMilliseconds()
  return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' ' + d.getUTCHours() + ':' +
    p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + (frac ? '.' + String(frac).padStart(3, '0') : '')
}
// 数据行的时刻栏（连同其后的分隔）。样本里整零点写成「00:00:00」、其后只空一格（10 处逐行核过，
// 源软件 DateTimeToStr 在零点不出时分秒、由程序另补所致）；其余时刻「H:mm:ss」后空两格。
function timeField(ms) {
  const d = new Date(Math.round(ms))
  if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds() && !d.getUTCMilliseconds()) {
    return d.getUTCFullYear() + '/' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + ' 00:00:00 '
  }
  return fmtTime(ms) + '  '
}
// 本地时刻 → 同一体例（表头生成时刻，与源软件 Now() 一致取本机时区）
function fmtLocal(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + d.getHours() + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds())
}
const gbkW = (s) => { let w = 0; for (const ch of String(s)) w += ch.codePointAt(0) < 0x80 ? 1 : 2; return w }

/**
 * 星（地固系，t UTC ms、p km、v km/s）→ 报文文本（CRLF；GBK 编码由调用方做）。
 * opts: { title, createdMs, header:{lines:[…]}（原表头，原样复用）, dupTimes:[ms]（这些时刻按原文再印一行）}
 */
function serializeCsEph(sat, opts) {
  const o = opts || {}
  if (!sat || !sat.t || sat.t.length < 1) throw new Error('没有可导出的星历点')
  if (sat.frame && sat.frame !== 'FIXED') throw new Error('中国卫通星历只写地固系，调用方须先换帧')
  if (!sat.v) throw new Error('中国卫通星历要求速度列，缺速度的星须先按插值重采样')
  const L = []
  const hl = o.header && Array.isArray(o.header.lines) && o.header.lines.length >= 1 ? o.header.lines : null
  if (hl) { for (const x of hl) L.push(String(x)) }
  else {
    const title = String(o.title != null ? o.title : (sat.name || '')).replace(/[\r\n]+/g, ' ') || '%'.repeat(14)
    L.push('_'.repeat(TITLE_LEFT) + title + '_'.repeat(Math.max(1, TITLE_WIDTH - gbkW(title))))
    L.push(BLANK_LINE)
    L.push('_'.repeat(TITLE_LEFT) + FRAME_TITLE_FIXED + '_'.repeat(FRAME_RIGHT) + fmtLocal(Number.isFinite(o.createdMs) ? o.createdMs : Date.now()))
    L.push(COL_HEADER)
  }
  const dup = new Set((o.dupTimes || []).map((x) => Math.round(x)))
  const t = sat.t, p = sat.p, v = sat.v, n = t.length
  const row = (k, tm) => timeField(tm) +
    [p[3 * k] * 1000, p[3 * k + 1] * 1000, p[3 * k + 2] * 1000, v[3 * k] * 1000, v[3 * k + 1] * 1000, v[3 * k + 2] * 1000].map(delphiExp).join('  ') + '  '
  for (let k = 0; k < n; k++) {
    // 段界后那一点（由解析器顺延 1 ms 产生）照样本惯例印成与段界同一时刻
    const nudged = k > 0 && t[k] - t[k - 1] <= N.NUDGE_MS && t[k] > t[k - 1]
    const tm = nudged ? t[k - 1] : t[k]
    L.push(row(k, tm))
    // 原文里「同一时刻原样印两行」、而解析时并成了一行的（不是段界的重复行）
    if (!nudged && dup.has(Math.round(t[k])) && !(k + 1 < n && t[k + 1] - t[k] <= N.NUDGE_MS)) L.push(row(k, tm))
  }
  return L.join('\r\n') + '\r\n'
}

module.exports = {
  ID, LABEL, EXT, ENCODING, COL_HEADER, FRAME_TITLE_FIXED,
  detectCsEph, parseCsEph, serializeCsEph, analyzeHeader, lexDataLine, delphiExp, fmtTime, timeField, keplerToState
}
