// 时间系统换算与外部星历时间写法解析的回归网（packages/core/utils/timeSystems.js）。
// 判据全部是外部可查的定值：闰秒表边界、GPS-UTC=18、TT-TAI=32.184、GPS 周 1000 的已知 UTC。

import { createRequire } from 'node:module'
import { epochMs as EM } from '../../../src/shared/epochMs.js'
const require = createRequire(import.meta.url)
const T = require('../utils/timeSystems.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

/* ===== ① 闰秒表 ===== */
section('闰秒表')
ok(T.LEAP_SECONDS.length === 28, '闰秒表 28 行', String(T.LEAP_SECONDS.length))
ok(T.LEAP_SECONDS[T.LEAP_SECONDS.length - 1][0] === '2017-01-01', '最后一次闰秒 2017-01-01')
ok(T.LEAP_SECONDS[T.LEAP_SECONDS.length - 1][1] === 37, '当前 TAI-UTC = 37')
// 2016-12-31 23:59:60 那一秒的前后
ok(T.taiMinusUtc(Date.UTC(2016, 11, 31, 23, 59, 59)) === 36, '闰秒生效前 36 s')
ok(T.taiMinusUtc(Date.UTC(2017, 0, 1, 0, 0, 0)) === 37, '闰秒生效瞬间 37 s')
ok(T.taiMinusUtc(Date.UTC(2017, 0, 1, 0, 0, 1)) === 37, '闰秒生效后 37 s')
ok(T.taiMinusUtc(Date.UTC(1971, 0, 1)) === 10, '1972 前按 10 s 兜底')
// 每一行的生效瞬间都要跳到该行的值（首行前面是 1972 以前的兜底区，不比「前一毫秒」）
T.LEAP_SECONDS.forEach(([d, n], i) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3])
  const before = i === 0 ? n : n - 1
  ok(T.taiMinusUtc(ms) === n && T.taiMinusUtc(ms - 1) === before, '闰秒 ' + d + ' -> ' + n)
})

/* ===== ② 时标偏移 ===== */
section('时标偏移')
const now = Date.UTC(2026, 0, 1)
near((T.msInSystem(now, 'GPS') - now) / 1000, 18, 1e-9, 'GPS - UTC = 18 s')
near((T.msInSystem(now, 'TAI') - now) / 1000, 37, 1e-9, 'TAI - UTC = 37 s')
near((T.msInSystem(now, 'TT') - T.msInSystem(now, 'TAI')) / 1000, 32.184, 1e-9, 'TT - TAI = 32.184 s')
near((T.msInSystem(now, 'BDT') - T.msInSystem(now, 'GPS')) / 1000, -14, 1e-9, 'BDT = GPS - 14 s')
ok(T.msInSystem(now, 'TDB') === T.msInSystem(now, 'TT'), 'TDB 视同 TT')
ok(T.utcMsFrom({ system: 'UTC', ms: now }) === now, 'UTC 原样返回')
for (const sys of ['TAI', 'TT', 'GPS', 'TDB', 'BDT']) {
  near(T.utcMsFrom({ system: sys, ms: T.msInSystem(now, sys) }), now, 1e-6, sys + ' 来回一致')
}
ok(Number.isNaN(T.utcMsFrom({ system: 'UTC', ms: NaN })), '非数返回 NaN')
let threw = false
try { T.utcMsFrom({ system: 'XYZ', ms: now }) } catch { threw = true }
ok(threw, '未知时标点名抛错')
// 1980-01-06 那一刻 GPS = UTC（该日 TAI-UTC 恰为 19）
ok(T.msInSystem(T.GPS_EPOCH_MS, 'GPS') === T.GPS_EPOCH_MS, 'GPS 纪元处 GPS = UTC')

/* ===== ③ 时间写法解析 ===== */
section('时间写法')
ok(T.parseUtcg('21 Sep 2026 00:00:00.000') === Date.UTC(2026, 8, 21), 'UTCG 基本')
ok(T.parseUtcg('1 Jan 2000 12:00:00.00') === Date.UTC(2000, 0, 1, 12), 'UTCG 单位数日 / 两位小数')
ok(T.parseUtcg('06 apr 2004 07:51:28.386') === Date.UTC(2004, 3, 6, 7, 51, 28, 386), 'UTCG 小写月份')
ok(Number.isNaN(T.parseUtcg('32 Xxx 2026 00:00:00')), 'UTCG 坏月份返回 NaN')
ok(T.parseIsoYmd('2026-09-21T00:00:00.000') === Date.UTC(2026, 8, 21), 'ISO-YMD 基本')
ok(T.parseIsoYmd('2026-09-21T01:02:03.456789') === Date.UTC(2026, 8, 21, 1, 2, 3) + 456.789, 'ISO-YMD 微秒')
ok(T.parseIsoYmd('2026-09-21 00:00:00Z') === Date.UTC(2026, 8, 21), 'ISO-YMD 空格分隔 + Z')
ok(T.parseIsoYmd('2026-09-21') === Date.UTC(2026, 8, 21), 'ISO-YMD 只有日期')
near(T.parseJDate('2451545.0'), Date.UTC(2000, 0, 1, 12), 1e-6, 'JD 2451545 = 2000-01-01 12:00')
ok(T.jdFromMs(Date.UTC(2000, 0, 1, 12)) === 2451545, 'jdFromMs 逆运算')
ok(T.msFromJd(2451545) === Date.UTC(2000, 0, 1, 12), 'msFromJd 逆运算')
const ep = Date.UTC(2026, 8, 21)
ok(T.parseTimeToken('60.5', 'EpSec', ep) === ep + 60500, 'EpSec 相对场景历元')
ok(T.parseTimeToken('21 Sep 2026 00:00:00.000', 'UTCG', ep) === ep, 'parseTimeToken UTCG')
ok(T.parseTimeToken('2026-09-21T00:00:00', 'ISO-YMD', ep) === ep, 'parseTimeToken ISO-YMD（带连字符）')
near(T.parseTimeToken('2461304.5', 'JDate', ep), T.msFromJd(2461304.5), 1e-6, 'parseTimeToken JDate')
ok(Number.isNaN(T.parseTimeToken('x', 'EpSec', ep)), 'EpSec 坏值 NaN')
ok(T.parseEpochLoose('2026-09-21T00:00:00') === ep, 'parseEpochLoose 认 ISO')
ok(T.parseEpochLoose('21 Sep 2026 00:00:00.000') === ep, 'parseEpochLoose 认 UTCG')
near(T.parseEpochLoose('2451545.0'), Date.UTC(2000, 0, 1, 12), 1e-6, 'parseEpochLoose 认 JD')
ok(Number.isNaN(T.parseEpochLoose('60.0')), 'parseEpochLoose 不把 EpSec 当 JD')

/* ===== ③b 年积日写法 YYYY-DDDThh:mm:ss（CCSDS 502.0-B 明文允许） ===== */
section('年积日历元')
ok(T.parseIsoYmd('2026-001T00:00:00.000') === Date.UTC(2026, 0, 1), '年积日 001 = 1 月 1 日')
ok(T.parseIsoYmd('2026-264T12:34:56.123456') === Date.UTC(2026, 8, 21, 12, 34, 56) + 123.456, '年积日 264 = 2026-09-21，微秒照收')
ok(T.parseIsoYmd('2026-264 12:34:56Z') === Date.UTC(2026, 8, 21, 12, 34, 56), '年积日空格分隔 + Z')
ok(T.parseIsoYmd('2026-264') === Date.UTC(2026, 8, 21), '年积日只有日期')
ok(T.parseIsoYmd('2024-366T12:00:00') === Date.UTC(2024, 11, 31, 12), '闰年 366 合法')
ok(Number.isNaN(T.parseIsoYmd('2023-366T12:00:00')), '平年 366 非法')
ok(Number.isNaN(T.parseIsoYmd('2026-000T00:00:00')), '年积日 000 非法')
ok(Number.isNaN(T.parseIsoYmd('2026-367T00:00:00')), '年积日 367 非法')
// 与 YYYY-MM-DD 不会撞：年积日恰好一个连字符 + 三位数字，月日写法是两个连字符
ok(T.parseIsoYmd('2026-01-01') === Date.UTC(2026, 0, 1), '月日写法不受影响')
ok(Number.isNaN(T.parseIsoYmd('2026-12')), '「年-月」不当年积日解')
ok(T.parseEpochLoose('2026-264T12:34:56') === Date.UTC(2026, 8, 21, 12, 34, 56), 'parseEpochLoose 认年积日')
ok(T.parseTimeToken('2026-264T00:00:00', 'ISO-YMD', ep) === Date.UTC(2026, 8, 21), 'parseTimeToken ISO-YMD 也认年积日')

/* ===== ③c 渲染端读 OMM 历元串（src/shared/epochMs.js，与 omm2satrec 同口径） ===== */
section('OMM 历元串')
ok(EM('2026-09-20T12:34:56.123456') === Date.UTC(2026, 8, 20, 12, 34, 56, 123), '不带 Z 的 OMM 历元按 UTC 解（裸 Date.parse 会按本机时区差几小时）',
  String(EM('2026-09-20T12:34:56.123456')) + ' vs ' + Date.parse('2026-09-20T12:34:56.123456'))
ok(EM('2026-09-20T12:34:56.123456Z') === Date.UTC(2026, 8, 20, 12, 34, 56, 123), '带 Z 的串结果不变')
ok(EM('2026-09-20T12:34:56+08:00') === Date.UTC(2026, 8, 20, 4, 34, 56), '带偏移的串照原偏移解，不再补 Z')
ok(EM('2026-09-20 12:34:56') === Date.UTC(2026, 8, 20, 12, 34, 56), '空格分隔也按 UTC')
ok(EM('2026-09-20') === Date.UTC(2026, 8, 20), '只有日期（ECMAScript 已按 UTC）不补 Z')
ok(Number.isNaN(EM('')) && Number.isNaN(EM(null)) && Number.isNaN(EM('随便什么')), '空串 / null / 乱串回 NaN，不编数')
// 与引擎口径逐字对拍：satellite.js 的 omm2satrec 走的是 jdsatepoch
{
  const rec = { noradId: '99999', epoch: '2026-09-20T12:34:56.123456', meanMotion: 15.5, ecc: 0.0001, incl: 51.6, raan: 100, argp: 90, ma: 270, bstar: 0, mdot: 0, mddot: 0 }
  const sr = sat.omm2satrec(rec)
  const engineMs = (sr.jdsatepoch + (sr.jdsatepochF || 0) - 2440587.5) * 86400000
  near(EM(rec.epoch), engineMs, 1, 'epochMs 与 omm2satrec 的 jdsatepoch 同一时刻（毫秒内）')
}

/* ===== ④ GPS 周 ===== */
section('GPS 周')
// 第一次 GPS 周卷绕（1023 -> 0）发生在 1999-08-21/22 午夜：周 1024 第 0 秒 = 1999-08-22 00:00:00 GPS。
// 该日 TAI-UTC=32 -> GPS-UTC=13，故对应 UTC 1999-08-21 23:59:47。
ok(T.gpsWeekSecToUtcMs(1024, 0) === Date.UTC(1999, 7, 21, 23, 59, 47), 'GPS 周 1024 -> 1999-08-21 23:59:47 UTC',
  new Date(T.gpsWeekSecToUtcMs(1024, 0)).toISOString())
// 2017 之后 GPS-UTC=18：周首 = UTC 周六 23:59:42
ok(T.gpsWeekSecToUtcMs(2338, 0) === T.GPS_EPOCH_MS + 2338 * T.WEEK_MS - 18000, '2338 周首比 UTC 早 18 s')
ok(new Date(T.gpsWeekSecToUtcMs(2338, 0)).getUTCDay() === 6, '周首落在 UTC 周六（因为早 18 s）')
near(T.gpsWeekSecToUtcMs(2338, 86400) - T.gpsWeekSecToUtcMs(2338, 0), 86400000, 1e-6, '周内秒线性')
// 10 bit 解卷
for (const w of [2300, 2338, 2400]) {
  const ref = T.gpsWeekSecToUtcMs(w, 3600)
  ok(T.unrollGpsWeek(w % 1024, ref) === w, '周号解卷 ' + w + ' -> ' + (w % 1024) + ' -> ' + w)
}
ok(T.unrollGpsWeek(2338 % 1024, T.gpsWeekSecToUtcMs(2338, 0)) === 2338, '解卷取最近整周')

/* ===== ⑤ 序列化写法 ===== */
section('序列化写法')
ok(T.formatUtcg(Date.UTC(2026, 8, 21, 1, 2, 3, 456)) === '21 Sep 2026 01:02:03.456', 'formatUtcg',
  T.formatUtcg(Date.UTC(2026, 8, 21, 1, 2, 3, 456)))
ok(T.formatUtcg(Date.UTC(2026, 8, 1)) === '1 Sep 2026 00:00:00.000', 'formatUtcg 单位数日不补零')
ok(T.formatCcsds(Date.UTC(2026, 8, 21, 1, 2, 3, 456)) === '2026-09-21T01:02:03.456000', 'formatCcsds 6 位微秒',
  T.formatCcsds(Date.UTC(2026, 8, 21, 1, 2, 3, 456)))
ok(T.formatCcsds(Date.UTC(2026, 8, 21) + 0.789) === '2026-09-21T00:00:00.000789', 'formatCcsds 亚毫秒',
  T.formatCcsds(Date.UTC(2026, 8, 21) + 0.789))
// 写出去再读回来
for (const ms of [Date.UTC(1999, 5, 1, 12, 34, 56, 789), Date.UTC(2026, 8, 21), Date.UTC(2017, 0, 1)]) {
  ok(T.parseUtcg(T.formatUtcg(ms)) === ms, 'UTCG 回环 ' + new Date(ms).toISOString())
  ok(T.parseIsoYmd(T.formatCcsds(ms)) === ms, 'CCSDS 回环 ' + new Date(ms).toISOString())
}

console.log('\ntimeSystems: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
