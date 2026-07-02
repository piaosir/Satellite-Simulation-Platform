// icsBuilder.js — iCalendar (RFC 5545) 生成器，交付级
//
// 目标：生成的 .ics 在 Outlook / Google Calendar / Apple Calendar 直接导入无警告。
// 关键规范点（都是三家日历实测会挑剔的地方）：
//   - 行分隔恒用 CRLF；单行 ≤75 字节（UTF-8 按字节折行，续行以一个空格开头）
//   - 文本值转义：反斜杠、分号、逗号、换行
//   - 时刻恒用 UTC（后缀 Z）——导入方自动换算本地时区，杜绝时区表描述不一致问题
//   - UID 稳定（同一事件重复导入 → 更新而非重复）
//   - VALARM 提醒（运营值班惯例：提前 1 天 + 提前 30 分钟）
//
// 纯字符串构建、零依赖，可在主进程/渲染进程/小程序任意环境运行。

'use strict';

/** 文本值转义（RFC 5545 §3.3.11） */
function escText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** 按 UTF-8 字节数 ≤75 折行（RFC 5545 §3.1），续行前置一个空格 */
function foldLine(line) {
  var bytes = 0, out = '', cur = '';
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    var b = byteLen(ch);
    // 续行首有 1 空格占 1 字节 → 续行有效载荷 74
    var limit = out === '' ? 75 : 74;
    if (bytes + b > limit) {
      out += (out === '' ? '' : '\r\n ') + cur;
      cur = ''; bytes = 0;
    }
    cur += ch; bytes += b;
  }
  out += (out === '' ? '' : '\r\n ') + cur;
  return out;
}

function byteLen(ch) {
  var c = ch.codePointAt(0);
  if (c < 0x80) return 1;
  if (c < 0x800) return 2;
  if (c < 0x10000) return 3;
  return 4;
}

/** 'YYYY-MM-DD' + 'HH:MM:SS' → RFC 5545 UTC 时刻 'YYYYMMDDTHHMMSSZ' */
function icsUtc(dateStr, timeStr) {
  return String(dateStr).replace(/-/g, '') + 'T' + String(timeStr).replace(/:/g, '') + 'Z';
}

/** 当前时刻 → DTSTAMP */
function nowUtc() {
  var d = new Date();
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    'T' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z';
}

/**
 * 构建 iCalendar 文本。
 * @param {object} cal
 * @param {string} cal.name        日历名（X-WR-CALNAME）
 * @param {string} [cal.prodId]    生产者标识
 * @param {Array}  cal.events      事件列表：
 *   { uid, date 'YYYY-MM-DD', start 'HH:MM:SS', end 'HH:MM:SS',  // 均为 UTC
 *     summary, description, location, categories:[...],
 *     alarms:[{ minutesBefore, description }] }
 *   注：end 若小于 start 视为跨 UTC 午夜，DTEND 日期 +1。
 * @returns {string} .ics 文本（CRLF 行尾）
 */
function buildIcs(cal) {
  var L = [];
  L.push('BEGIN:VCALENDAR');
  L.push('VERSION:2.0');
  L.push('PRODID:' + (cal.prodId || '-//SatSim Platform//Sun Outage//CN'));
  L.push('CALSCALE:GREGORIAN');
  L.push('METHOD:PUBLISH');
  if (cal.name) L.push('X-WR-CALNAME:' + escText(cal.name));
  var stamp = nowUtc();

  var events = cal.events || [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    var endDate = ev.date;
    if (ev.end < ev.start) endDate = addDay(ev.date);   // 跨 UTC 午夜
    L.push('BEGIN:VEVENT');
    L.push('UID:' + (ev.uid || 'ev' + i + '-' + stamp + '@satsim'));
    L.push('DTSTAMP:' + stamp);
    L.push('DTSTART:' + icsUtc(ev.date, ev.start));
    L.push('DTEND:' + icsUtc(endDate, ev.end));
    L.push('SUMMARY:' + escText(ev.summary));
    if (ev.description) L.push('DESCRIPTION:' + escText(ev.description));
    if (ev.location) L.push('LOCATION:' + escText(ev.location));
    if (ev.categories && ev.categories.length) L.push('CATEGORIES:' + ev.categories.map(escText).join(','));
    L.push('STATUS:CONFIRMED');
    L.push('TRANSP:OPAQUE');
    var alarms = ev.alarms || [];
    for (var a = 0; a < alarms.length; a++) {
      var al = alarms[a];
      L.push('BEGIN:VALARM');
      L.push('ACTION:DISPLAY');
      L.push('DESCRIPTION:' + escText(al.description || ev.summary));
      L.push('TRIGGER:-PT' + Math.max(1, Math.round(al.minutesBefore || 30)) + 'M');
      L.push('END:VALARM');
    }
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');

  var folded = [];
  for (var j = 0; j < L.length; j++) folded.push(foldLine(L[j]));
  return folded.join('\r\n') + '\r\n';
}

/** 'YYYY-MM-DD' + 1 天（纯字符串日期运算，避免时区干扰） */
function addDay(dateStr) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 1));
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

module.exports = { buildIcs: buildIcs };
