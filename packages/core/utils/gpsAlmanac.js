// GPS 年历（YUMA / SEM）解析与换算（纯 CommonJS）。
//
// 【为什么换算成 OMM 而不是新建一条管线】年历给的是【开普勒根数】，与 OMM 的平均根数同形，
//   换算一下就能走平台既有的 SGP4 通路：落库 / 搜索池 / 地图 / 链路窗口 / 六格式导出 一行都不用改。
//   代价是精度：年历本就是「粗根数」（供接收机捕获用），换成 OMM 再走 SGP4 与 ICD 年历算法本身
//   有几 km 的差（J2 短周期项两边处理不同），这在「看星座构型 / 选星」的用途上完全够用。
//   要精密轨道请用 SP3（那是 cm 级，走 ephem 通路）。
//
// 【RAAN 的坑】ICD 里的 Ω₀ 不是惯性升交点赤经，而是「周起点时刻相对格林尼治子午线的升交点经度」：
//     Ω_k(t) = Ω₀ + (Ω̇ − ω_e)(t − toa) − ω_e·toa     （地固系）
//   惯性 RAAN = Ω_ECEF(toa) + GMST(toa) = Ω₀ − ω_e·toa + GMST(toa) = Ω₀ + GMST(周起点 UTC)
//   两式相等是本模块的测试断言之一（gpsAlmanac.test.mjs）。
//
// 【icdPropagate】ICD-GPS-200 表 20-IV 的年历算法，直接出 ECEF。它【只给测试对拍用】：
//   平台运行时一律走「换算记录 → SGP4」那一条，不在这里分岔。

'use strict'

const T = require('./timeSystems.js')

// ICD-GPS-200 常数（与 WGS-84 的 μ 略有差别是规范如此，不许换成 398600.4418）
const MU_ICD = 3.986005e14            // m³/s²
const OMEGA_E_ICD = 7.2921151467e-5   // rad/s
const PI_ICD = 3.1415926535898        // ICD 规定的 π（半圆换算用）
const TWO_PI = 2 * Math.PI
const DEG = 180 / Math.PI
const SEMI = 180                      // 半圆 → 度
const J2 = 1.08262668e-3
const RE_KM = 6378.137

const wrap360 = (d) => ((d % 360) + 360) % 360

/* ===================== 嗅探 ===================== */
// YUMA：每星 13 行「键: 值」，以 "ID:" 或 "******** Week ... almanac ..." 起头
// SEM  ：行 1「N 记录数 名字」，行 2「周 toa」，其后每星 13 个数值行
function detectAlmanac(text) {
  const s = String(text == null ? '' : text).replace(/^﻿/, '')
  if (/^\s*\*+\s*Week\s+\d+\s+almanac/im.test(s) || /^\s*ID:\s*\d+/m.test(s)) return 'yuma'
  if (/SQRT\(A\)\s*\(m\s*1\/2\)/i.test(s)) return 'yuma'
  const lines = s.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length > 3) {
    const a = lines[0].trim().split(/\s+/)
    const b = lines[1].trim().split(/\s+/)
    // 行 1 首个数是记录数、行 2 是「周 toa」两个整数 —— SEM 的固定体例
    if (a.length >= 2 && /^\d+$/.test(a[0]) && b.length === 2 && /^\d+$/.test(b[0]) && /^\d+$/.test(b[1])) return 'sem'
  }
  return ''
}

/* ===================== YUMA ===================== */
const YUMA_KEYS = {
  ID: 'prn', HEALTH: 'health', ECCENTRICITY: 'e', 'TIME OF APPLICABILITY(S)': 'toa',
  'ORBITAL INCLINATION(RAD)': 'i', 'RATE OF RIGHT ASCEN(R/S)': 'omegaDot',
  'SQRT(A)  (M 1/2)': 'sqrtA', 'RIGHT ASCEN AT WEEK(RAD)': 'omega0',
  'ARGUMENT OF PERIGEE(RAD)': 'argp', 'MEAN ANOM(RAD)': 'm0',
  'AF0(S)': 'af0', 'AF1(S/S)': 'af1', WEEK: 'week'
}
function parseYuma(text) {
  const warnings = [], errors = [], out = []
  const lines = String(text == null ? '' : text).replace(/^﻿/, '').split(/\r?\n/)
  let cur = null
  const flush = () => { if (cur && cur.prn != null && cur.sqrtA) out.push(cur); cur = null }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^\*+/.test(line)) { flush(); continue }          // 「******** Week 123 almanac for PRN-01 ********」
    const i = line.indexOf(':')
    if (i < 0) continue
    const keyRaw = line.slice(0, i).trim().toUpperCase().replace(/\s+/g, ' ')
    const val = parseFloat(line.slice(i + 1).trim())
    // 键名各家排版略有出入（空格数、括号），先按规范化后的全等，再退到关键字包含
    let key = YUMA_KEYS[keyRaw]
    if (!key) {
      if (/^ID/.test(keyRaw)) key = 'prn'
      else if (/HEALTH/.test(keyRaw)) key = 'health'
      else if (/ECCENT/.test(keyRaw)) key = 'e'
      else if (/APPLICABILITY/.test(keyRaw)) key = 'toa'
      else if (/INCLINATION/.test(keyRaw)) key = 'i'
      else if (/RATE OF RIGHT/.test(keyRaw)) key = 'omegaDot'
      else if (/SQRT/.test(keyRaw)) key = 'sqrtA'
      else if (/RIGHT ASCEN AT/.test(keyRaw)) key = 'omega0'
      else if (/ARGUMENT OF PERIGEE/.test(keyRaw)) key = 'argp'
      else if (/MEAN ANOM/.test(keyRaw)) key = 'm0'
      else if (/^AF0/.test(keyRaw)) key = 'af0'
      else if (/^AF1/.test(keyRaw)) key = 'af1'
      else if (/^WEEK/.test(keyRaw)) key = 'week'
    }
    if (!key) continue
    if (key === 'prn') { flush(); cur = { prn: Math.round(val) } ; continue }
    if (!cur) cur = {}
    cur[key] = val
  }
  flush()
  if (!out.length) errors.push('YUMA 里没有解析到任何卫星记录')
  return { sats: out, errors, warnings }
}

/* ===================== SEM ===================== */
// 行 1：N 记录数 名字；行 2：周 toa；每星依次 13 个字段（PRN / SVN / URA / e / δi / Ω̇ / √A /
// Ω₀ / ω / M₀ / af0 / af1 / health / config）—— 逐行或多值一行都有人写，故整份按数值流读。
function parseSem(text) {
  const warnings = [], errors = [], out = []
  const src = String(text == null ? '' : text).replace(/^﻿/, '')
  const lines = src.split(/\r?\n/).filter((l) => l.trim() && !/^\s*[#*]/.test(l))
  if (lines.length < 3) { errors.push('SEM 文件太短'); return { sats: out, errors, warnings } }
  const head1 = lines[0].trim().split(/\s+/)
  const count = parseInt(head1[0], 10)
  const head2 = lines[1].trim().split(/\s+/)
  const week = parseInt(head2[0], 10), toa = parseFloat(head2[1])
  if (!Number.isFinite(count) || !Number.isFinite(week) || !Number.isFinite(toa)) {
    errors.push('SEM 头两行无法解析（应为「记录数 名字」与「周 周内秒」）')
    return { sats: out, errors, warnings }
  }
  // 其后全部数值按流读：每 13 个一颗星（config 是第 14 个，某些产品缺省，故按 13 取、多的跳过）
  const nums = []
  for (let i = 2; i < lines.length; i++) for (const t of lines[i].trim().split(/\s+/)) { const v = Number(t); if (Number.isFinite(v)) nums.push(v) }
  const PER = 13
  const have = Math.floor(nums.length / PER)
  if (!have) { errors.push('SEM 里没有解析到任何卫星记录'); return { sats: out, errors, warnings } }
  if (Number.isFinite(count) && have < count) warnings.push('头里声明 ' + count + ' 条，实得 ' + have)
  for (let k = 0; k < have; k++) {
    const f = nums.slice(k * PER, k * PER + PER)
    out.push({
      prn: Math.round(f[0]), svn: Math.round(f[1]), ura: f[2],
      e: f[3],
      // δi 是【半圆】，相对 0.30 半圆（= 54°）的偏移：i = 54° + δi·180°
      i: (54 + f[4] * SEMI) / DEG,
      omegaDot: f[5] * SEMI / DEG,          // 半圆/s -> rad/s
      sqrtA: f[6],
      omega0: f[7] * SEMI / DEG,            // 半圆 -> rad
      argp: f[8] * SEMI / DEG,
      m0: f[9] * SEMI / DEG,
      af0: f[10], af1: f[11], health: Math.round(f[12]),
      week, toa
    })
  }
  return { sats: out, errors, warnings }
}

/* ===================== 年历记录 -> OMM 记录 ===================== */
// 单条换算。week 已展开（unrollGpsWeek）。
function toOmmRecord(a, weekFull, opts) {
  const o = opts || {}
  const aMeters = a.sqrtA * a.sqrtA                       // m
  const aKm = aMeters / 1000
  const nRadS = Math.sqrt(MU_ICD / (aMeters * aMeters * aMeters))
  const meanMotion = 86400 * nRadS / TWO_PI               // rev/day
  const toaUtcMs = T.gpsWeekSecToUtcMs(weekFull, a.toa)
  const weekStartUtcMs = T.gpsWeekSecToUtcMs(weekFull, 0)
  // 惯性 RAAN = Ω₀ + GMST(周起点 UTC)（= Ω₀ − ω_e·toa + GMST(toa)，见文件头注）
  const gmstWeekStart = o.gstime(T.jdFromMs(weekStartUtcMs))
  const raanDeg = wrap360((a.omega0 + gmstWeekStart) * DEG)
  const inclDeg = a.i * DEG
  const rec = {
    name: 'GPS PRN ' + String(a.prn).padStart(2, '0') + (a.svn ? ' (SVN ' + a.svn + ')' : ''),
    noradId: '',                                           // 由调用方反查 / 给合成号
    objectId: '',
    epoch: new Date(Math.round(toaUtcMs)).toISOString().replace('Z', ''),
    meanMotion: meanMotion.toFixed(8),
    ecc: String(a.e),
    incl: inclDeg.toFixed(4),
    raan: raanDeg.toFixed(4),
    argp: wrap360(a.argp * DEG).toFixed(4),
    ma: wrap360(a.m0 * DEG).toFixed(4),
    bstar: '0', mdot: '0', mddot: '0',
    prn: a.prn, svn: a.svn || null, health: a.health || 0,
    aKm, toaUtcMs, weekFull
  }
  return rec
}

// J2 摄动下的节点进动率（rad/s），用于校验年历自带的 Ω̇
function raanRateJ2(aKm, e, inclRad) {
  const MU_KM = 398600.4418
  const n = Math.sqrt(MU_KM / (aKm * aKm * aKm))
  const p = aKm * (1 - e * e)
  return -1.5 * n * J2 * (RE_KM / p) * (RE_KM / p) * Math.cos(inclRad)
}

/**
 * 年历文本 -> OMM 记录数组。
 * opts: { gstime（必给，由调用方注入 satellite.js 的 gstime）, refMs（周号解卷的参考时刻，缺省 now）}
 * 返回 { format:'yuma'|'sem', records, almanacs, week, errors, warnings }
 */
function parseAlmanac(text, opts) {
  const o = opts || {}
  if (typeof o.gstime !== 'function') throw new Error('parseAlmanac 需要注入 gstime（core 不直接引 satellite.js 的渲染端副本）')
  const fmt = o.format || detectAlmanac(text)
  if (fmt !== 'yuma' && fmt !== 'sem') return { format: '', records: [], almanacs: [], errors: ['无法识别为 GPS 年历（YUMA / SEM）'], warnings: [] }
  const r = fmt === 'yuma' ? parseYuma(text) : parseSem(text)
  const warnings = r.warnings.slice(), errors = r.errors.slice()
  if (!r.sats.length) return { format: fmt, records: [], almanacs: [], errors, warnings }

  // 周号解卷：10 bit 取与参考时刻最接近的整周
  const week10 = Number.isFinite(r.sats[0].week) ? r.sats[0].week : 0
  const weekFull = week10 > 1023 ? week10 : T.unrollGpsWeek(week10, o.refMs)
  const spanYears = Math.abs((T.gpsWeekSecToUtcMs(weekFull, r.sats[0].toa) - (Number.isFinite(o.refMs) ? o.refMs : Date.now()))) / (365.25 * 86400000)
  if (spanYears > 5) warnings.push('年历历元距今 ' + spanYears.toFixed(1) + ' 年，周号解卷可能不对（10 bit 每 19.6 年卷绕一次）')

  const records = [], almanacs = []
  let unhealthy = 0
  for (const a of r.sats) {
    if (!(a.sqrtA > 0) || !Number.isFinite(a.e) || !Number.isFinite(a.i)) { warnings.push('PRN ' + a.prn + '：根数不全，已跳过'); continue }
    const w = Number.isFinite(a.week) ? (a.week > 1023 ? a.week : T.unrollGpsWeek(a.week, o.refMs)) : weekFull
    const rec = toOmmRecord(a, w, o)
    // 年历自带的 Ω̇ 与 J2 理论值对不上 5% 以上 → 告警（多半是单位或半圆换算弄错了）
    if (Number.isFinite(a.omegaDot) && a.omegaDot !== 0) {
      const theo = raanRateJ2(rec.aKm, a.e, a.i)
      if (theo !== 0 && Math.abs((a.omegaDot - theo) / theo) > 0.05) {
        warnings.push('PRN ' + a.prn + '：年历的 Ω̇ 与 J2 理论值差 ' +
          (Math.abs((a.omegaDot - theo) / theo) * 100).toFixed(1) + '%（' + a.omegaDot.toExponential(3) + ' vs ' + theo.toExponential(3) + '）')
      }
    }
    if (a.health) unhealthy++
    records.push(rec)
    almanacs.push(Object.assign({}, a, { week: w }))
  }
  // 健康位 ≠ 0 的星照导，名字不加标记，只计数（任务书 §14 第 5 条）
  if (unhealthy) warnings.push(unhealthy + ' 颗卫星的健康位不为 0（照常导入）')
  if (!records.length) errors.push('没有可用的年历记录')
  return { format: fmt, records, almanacs, week: weekFull, errors, warnings }
}

/* ===================== ICD-GPS-200 表 20-IV 年历算法（只给测试对拍用） ===================== */
// 返回该时刻的 ECEF 位置（km）。a 为 parseAlmanac 带出的 almanacs 元素（角度均为 rad）。
function icdPropagate(a, utcMs) {
  const toaUtcMs = T.gpsWeekSecToUtcMs(a.week, a.toa)
  let tk = (utcMs - toaUtcMs) / 1000                 // s（GPS 与 UTC 的闰秒差在两端相消）
  if (tk > 302400) tk -= 604800
  if (tk < -302400) tk += 604800
  const aMeters = a.sqrtA * a.sqrtA
  const n0 = Math.sqrt(MU_ICD / (aMeters * aMeters * aMeters))
  const Mk = a.m0 + n0 * tk
  // 开普勒方程（偏心率极小，五次迭代足够）
  let Ek = Mk
  for (let i = 0; i < 12; i++) Ek = Mk + a.e * Math.sin(Ek)
  const sinE = Math.sin(Ek), cosE = Math.cos(Ek)
  const vk = Math.atan2(Math.sqrt(1 - a.e * a.e) * sinE, cosE - a.e)
  const uk = vk + a.argp
  const rk = aMeters * (1 - a.e * cosE)
  const xk = rk * Math.cos(uk), yk = rk * Math.sin(uk)
  // Ω_k = Ω₀ + (Ω̇ − ω_e)·t_k − ω_e·toa
  const Ok = a.omega0 + (a.omegaDot - OMEGA_E_ICD) * tk - OMEGA_E_ICD * a.toa
  const cO = Math.cos(Ok), sO = Math.sin(Ok), ci = Math.cos(a.i), si = Math.sin(a.i)
  return {
    x: (xk * cO - yk * ci * sO) / 1000,
    y: (xk * sO + yk * ci * cO) / 1000,
    z: (yk * si) / 1000
  }
}

module.exports = {
  MU_ICD, OMEGA_E_ICD, PI_ICD,
  detectAlmanac, parseYuma, parseSem, parseAlmanac, toOmmRecord, icdPropagate, raanRateJ2
}
