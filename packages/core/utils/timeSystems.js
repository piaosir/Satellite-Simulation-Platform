// 时间系统换算与外部星历里出现的几种时间写法的解析（纯 CommonJS，主进程 / 渲染端 / Worker 通用）。
//
// 【口径】平台内部一律 UTC 毫秒。外部星历（STK .e / CCSDS OEM / SP3 / GPS 年历）的时标可能是
//   UTC / TAI / TT / GPS / TDB 之一，进门即换算成 UTC 毫秒，之后全链路不再出现别的时标。
//     TAI - UTC = 闰秒（LEAP_SECONDS 表）      GPS = TAI - 19 s      TT = TAI + 32.184 s
//     TDB ~= TT（差 <=1.7 ms 的周年项，对本平台的几何量无意义，见下）    BDT = GPS - 14 s
//   UT1 ~= UTC（|dUT1| <= 0.9 s，被 frames.js 一并忽略，误差上限写在那边）。
//
// 【TDB 视同 TT 的量级】TDB-TT 的主项是 1.657 ms·sin(g)，g 为地球平近点角；1.7 ms 的时间偏差
//   对 LEO（7.5 km/s）是 12 m、对 GEO（3.07 km/s）是 5 m —— 都在插值星历本身的精度以内。
//
// 【新增闰秒只改 LEAP_SECONDS 一处】IERS Bulletin C 公告新闰秒时，在表尾追加一行即可，
//   全平台（解析、序列化、GPS 周换算）都从这一张表取值。

'use strict'

// TAI - UTC（秒），键是该值【开始生效】的 UTC 日（当日 00:00:00 起）。
// 截至 2026-09 最后一次是 2017-01-01 的第 37 秒（IERS Bulletin C 无新增）。
const LEAP_SECONDS = [
  ['1972-01-01', 10], ['1972-07-01', 11], ['1973-01-01', 12], ['1974-01-01', 13],
  ['1975-01-01', 14], ['1976-01-01', 15], ['1977-01-01', 16], ['1978-01-01', 17],
  ['1979-01-01', 18], ['1980-01-01', 19], ['1981-07-01', 20], ['1982-07-01', 21],
  ['1983-07-01', 22], ['1985-07-01', 23], ['1988-01-01', 24], ['1990-01-01', 25],
  ['1991-01-01', 26], ['1992-07-01', 27], ['1993-07-01', 28], ['1994-07-01', 29],
  ['1996-01-01', 30], ['1997-07-01', 31], ['1999-01-01', 32], ['2006-01-01', 33],
  ['2009-01-01', 34], ['2012-07-01', 35], ['2015-07-01', 36], ['2017-01-01', 37]
]
// 预解析成 [毫秒, 秒] 升序表
const LEAP_MS = LEAP_SECONDS.map(function (row) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(row[0])
  return [Date.UTC(+m[1], +m[2] - 1, +m[3]), row[1]]
})

const TT_MINUS_TAI = 32.184           // s
const TAI_MINUS_GPS = 19              // s
const GPS_MINUS_BDT = 14              // s（BDT = GPS - 14 s）
const GPS_EPOCH_MS = Date.UTC(1980, 0, 6)   // 1980-01-06 00:00:00 UTC（该刻 GPS = UTC）
const WEEK_MS = 7 * 86400 * 1000
const JD_UNIX = 2440587.5             // 1970-01-01T00:00:00Z 的儒略日
const DAY_MS = 86400000

// 某 UTC 时刻的 TAI - UTC（秒）。1972 以前一律按 10 s（本平台不处理 1972 前的星历）。
function taiMinusUtc(utcMs) {
  let n = LEAP_MS[0][1]
  for (let i = 0; i < LEAP_MS.length; i++) { if (utcMs >= LEAP_MS[i][0]) n = LEAP_MS[i][1]; else break }
  return n
}

const SYSTEMS = ['UTC', 'TAI', 'TT', 'GPS', 'TDB', 'BDT', 'UT1', 'GLO']
// 各时标相对 TAI 的常量偏移（秒）：scale = TAI + OFFSET_FROM_TAI[scale]
const OFFSET_FROM_TAI = {
  TAI: 0, TT: TT_MINUS_TAI, TDB: TT_MINUS_TAI,
  GPS: -TAI_MINUS_GPS, BDT: -TAI_MINUS_GPS - GPS_MINUS_BDT
}

// 某时标下的「读数毫秒」（把该时标的年月日时分秒当 UTC 读出来的 epoch 毫秒）-> 真 UTC 毫秒。
// UTC / UT1 / GLO 直接返回（GLONASS 系统时在 SP3 里已折算到 UTC，按 UTC 处理）。
// 闰秒取值依赖 UTC 本身，故先以读数试算再用结果复算一次（跨闰秒瞬间也只差一次迭代）。
function utcMsFrom(spec) {
  const sys = String((spec && spec.system) || 'UTC').toUpperCase()
  const ms = Number(spec && spec.ms)
  if (!Number.isFinite(ms)) return NaN
  if (sys === 'UTC' || sys === 'UT1' || sys === 'GLO') return ms
  if (!(sys in OFFSET_FROM_TAI)) throw new Error('未知时间系统：' + sys)
  const off = OFFSET_FROM_TAI[sys]
  // scale = TAI + off = UTC + leap(utc) + off  =>  utc = ms - off - leap(utc)
  let utc = ms - (off + taiMinusUtc(ms)) * 1000
  utc = ms - (off + taiMinusUtc(utc)) * 1000
  return utc
}
// 逆：UTC 毫秒 -> 某时标下的读数毫秒（序列化与儒略世纪数用）。
function msInSystem(utcMs, system) {
  const sys = String(system || 'UTC').toUpperCase()
  if (sys === 'UTC' || sys === 'UT1' || sys === 'GLO') return utcMs
  if (!(sys in OFFSET_FROM_TAI)) throw new Error('未知时间系统：' + sys)
  return utcMs + (OFFSET_FROM_TAI[sys] + taiMinusUtc(utcMs)) * 1000
}

/* ===================== 儒略日 ===================== */
const jdFromMs = (ms) => JD_UNIX + ms / DAY_MS
const msFromJd = (jd) => (jd - JD_UNIX) * DAY_MS
// TT 的儒略世纪数（J2000.0 起），frames.js 的岁差章动自变量。
const julianCenturiesTT = (utcMs) => (jdFromMs(msInSystem(utcMs, 'TT')) - 2451545) / 36525

/* ===================== 时间写法解析 ===================== */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTH_IX = {}
MONTHS.forEach(function (m, i) { MONTH_IX[m.toUpperCase()] = i })

// STK UTCG：dd mmm yyyy hh:mm:ss.sss（日可 1-2 位、秒小数位任意；月份英文三字母大小写不敏感）
function parseUtcg(s) {
  const m = /^\s*(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(String(s == null ? '' : s))
  if (!m) return NaN
  const mon = MONTH_IX[m[2].toUpperCase()]
  if (mon === undefined) return NaN
  const sec = parseFloat(m[6])
  return Date.UTC(+m[3], mon, +m[1], +m[4], +m[5], 0) + sec * 1000
}
// ISO-YMD：yyyy-mm-ddThh:mm:ss.sss（T 可为空格，尾部 Z 可有可无；一律按所在时标读，不做时区偏移）
function parseIsoYmd(s) {
  const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?)?\s*Z?\s*$/.exec(String(s == null ? '' : s))
  if (!m) return NaN
  const sec = m[6] === undefined ? 0 : parseFloat(m[6])
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), 0) + sec * 1000
}
// 儒略日按数字解
function parseJDate(s) {
  const v = parseFloat(String(s == null ? '' : s).trim())
  return Number.isFinite(v) ? msFromJd(v) : NaN
}

// STK .e 的 TimeFormat 各档统一入口。返回该时标下的「读数毫秒」，调用方再走 utcMsFrom 换算。
// EpSec 相对 ScenarioEpoch（epochMs 已是读数毫秒）；其余档忽略 epochMs。
function parseTimeToken(tok, format, epochMs) {
  const f = String(format || 'EPSEC').toUpperCase().replace(/[^A-Z]/g, '')
  const s = String(tok == null ? '' : tok).trim()
  switch (f) {
    case 'EPSEC': {
      const v = parseFloat(s)
      return Number.isFinite(v) && Number.isFinite(epochMs) ? epochMs + v * 1000 : NaN
    }
    case 'UTCG': return parseUtcg(s)
    case 'ISOYMD': return parseIsoYmd(s)
    case 'JDATE': case 'JD': return parseJDate(s)
    case 'YYDDD': {
      const m = /^(\d{2})(\d{3})(?:\.(\d+))?$/.exec(s)
      if (!m) return NaN
      const yr = +m[1] < 57 ? 2000 + +m[1] : 1900 + +m[1]
      const frac = m[3] ? parseFloat('0.' + m[3]) : 0
      return Date.UTC(yr, 0, 1) + ((+m[2]) - 1 + frac) * DAY_MS
    }
    default: return NaN
  }
}
// OEM / SP3 的历元串：先 ISO，再 UTCG，最后儒略日（纯数字且 > 2e6 才当 JD，避免把 EpSec 当 JD）
function parseEpochLoose(s) {
  const txt = String(s == null ? '' : s).trim()
  let v = parseIsoYmd(txt)
  if (Number.isFinite(v)) return v
  v = parseUtcg(txt)
  if (Number.isFinite(v)) return v
  const n = parseFloat(txt)
  return Number.isFinite(n) && n > 2e6 ? msFromJd(n) : NaN
}

/* ===================== GPS 周 ===================== */
// GPS 周 + 周内秒 -> UTC 毫秒。week 是【展开后】的完整周数（1024/2048 卷绕由 unrollGpsWeek 解开）。
function gpsWeekSecToUtcMs(week, sow) {
  const gpsRead = GPS_EPOCH_MS + Number(week) * WEEK_MS + Number(sow) * 1000
  return utcMsFrom({ system: 'GPS', ms: gpsRead })
}
// 10 bit 周号解卷：取与参考时刻（缺省「现在」）最接近的那一整周
function unrollGpsWeek(week10, refMs) {
  const w = ((Number(week10) % 1024) + 1024) % 1024
  const ref = Number.isFinite(refMs) ? refMs : Date.now()
  const refWeek = Math.floor((msInSystem(ref, 'GPS') - GPS_EPOCH_MS) / WEEK_MS)
  const base = Math.round((refWeek - w) / 1024)
  return w + base * 1024
}

/* ===================== 序列化写法 ===================== */
const pad = (n, w) => String(Math.floor(n)).padStart(w, '0')
// UTC 毫秒 -> STK UTCG「dd mmm yyyy hh:mm:ss.sss」
function formatUtcg(ms) {
  const d = new Date(Math.round(Number(ms)))
  return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ' ' +
    pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' +
    pad(d.getUTCSeconds(), 2) + '.' + pad(d.getUTCMilliseconds(), 3)
}
// UTC 毫秒 -> CCSDS 历元「yyyy-mm-ddThh:mm:ss.ffffff」（6 位微秒，不带 Z —— 502.0-B 的体例）
function formatCcsds(ms) {
  const v = Number(ms)
  const base = Math.floor(v / 1000) * 1000
  const d = new Date(base)
  const us = Math.round((v - base) * 1000)
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1, 2) + '-' + pad(d.getUTCDate(), 2) + 'T' +
    pad(d.getUTCHours(), 2) + ':' + pad(d.getUTCMinutes(), 2) + ':' + pad(d.getUTCSeconds(), 2) +
    '.' + pad(us, 6)
}

module.exports = {
  LEAP_SECONDS, SYSTEMS, TT_MINUS_TAI, TAI_MINUS_GPS, GPS_EPOCH_MS, WEEK_MS, MONTHS, DAY_MS,
  taiMinusUtc, utcMsFrom, msInSystem,
  jdFromMs, msFromJd, julianCenturiesTT,
  parseUtcg, parseIsoYmd, parseJDate, parseTimeToken, parseEpochLoose,
  gpsWeekSecToUtcMs, unrollGpsWeek,
  formatUtcg, formatCcsds
}
