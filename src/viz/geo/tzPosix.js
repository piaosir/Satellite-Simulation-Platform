// POSIX TZ 串（TZif 脚注）的解析与求值 —— 时区图层的运行时规则表与构建脚本共用这一份。
//
// tzdata 包是 slim 格式：最后一次显式跃迁之后的规则只写在脚注里（如 Berlin 的 CET-1CEST,M3.5.0,M10.5.0/3），
// 运行时按它现算，规则表因此只存到最后一次显式跃迁，2100 年以后也照样有解。
// 语法按 RFC 8536 的扩展：规则时刻可为负、可超过 24 h（以色列 M3.4.4/26、格陵兰 M3.5.0/-1）。
// 偏移一律「东正西负、单位秒」（POSIX 串里写的是反号，解析时还原）。
//
// 纯函数、无依赖，Node 单测与浏览器同用。

const DAY = 86400

// 返回 { std: { name, utoff }, dst?: { name, utoff }, start?, end? }
export function parsePosixTz(s) {
  let i = 0
  const name = () => {
    if (s[i] === '<') { const e = s.indexOf('>', i); const n = s.slice(i + 1, e); i = e + 1; return n }
    const st = i; while (i < s.length && /[A-Za-z]/.test(s[i])) i++
    return s.slice(st, i)
  }
  const hms = () => {   // [+-]hh[:mm[:ss]] → 秒
    let sign = 1
    if (s[i] === '+' || s[i] === '-') { if (s[i] === '-') sign = -1; i++ }
    const num = () => { const st = i; while (i < s.length && /[0-9]/.test(s[i])) i++; if (st === i) throw new Error('POSIX TZ 数字缺失：' + s); return +s.slice(st, i) }
    let v = num() * 3600
    if (s[i] === ':') { i++; v += num() * 60; if (s[i] === ':') { i++; v += num() } }
    return sign * v
  }
  const dateRule = () => {
    let r
    if (s[i] === 'M') {
      i++
      const st = i; while (/[0-9.]/.test(s[i] || '')) i++
      const [m, w, d] = s.slice(st, i).split('.').map(Number)
      r = { kind: 'M', m, w, d }
    } else if (s[i] === 'J') {
      i++; const st = i; while (/[0-9]/.test(s[i] || '')) i++
      r = { kind: 'J', n: +s.slice(st, i) }
    } else {
      const st = i; while (/[0-9]/.test(s[i] || '')) i++
      r = { kind: 'n', n: +s.slice(st, i) }
    }
    r.time = 7200
    if (s[i] === '/') { i++; r.time = hms() }
    return r
  }
  const out = {}
  const stdName = name()
  out.std = { name: stdName, utoff: 0 - hms() }
  if (i >= s.length) return out
  const dstName = name()
  let dstOff = out.std.utoff + 3600
  if (i < s.length && s[i] !== ',') dstOff = 0 - hms()
  out.dst = { name: dstName, utoff: dstOff }
  if (s[i] === ',') { i++; out.start = dateRule(); if (s[i] !== ',') throw new Error('POSIX TZ 缺结束规则：' + s); i++; out.end = dateRule() }
  else { out.start = { kind: 'M', m: 3, w: 2, d: 0, time: 7200 }; out.end = { kind: 'M', m: 11, w: 1, d: 0, time: 7200 } }   // POSIX 缺省（美国规则）
  if (i !== s.length) throw new Error('POSIX TZ 尾部无法解析：' + s)
  return out
}

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const daysFromCivil = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000 / DAY)   // 1970-01-01 起的日序

// 规则日期 → 1970 起的绝对日序
export function ruleDay(r, y) {
  if (r.kind === 'M') {
    const first = daysFromCivil(y, r.m, 1)
    const wd1 = ((first % 7) + 7 + 4) % 7          // 1970-01-01 是周四
    let day = first + ((r.d - wd1 + 7) % 7) + (r.w - 1) * 7
    const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][r.m - 1]
    while (day >= first + dim) day -= 7            // w = 5 表示「最后一个」
    return day
  }
  const jan1 = daysFromCivil(y, 1, 1)
  if (r.kind === 'J') { let n = r.n - 1; if (isLeap(y) && r.n >= 60) n++; return jan1 + n }   // J：不数 2 月 29 日
  return jan1 + r.n
}

// 一年内的两次跃迁（UTC 秒，按时间排序）：开始时刻按本地标准时、结束时刻按本地夏令时（POSIX 定义）
export function yearTransitions(tz, y) {
  const s = ruleDay(tz.start, y) * DAY + tz.start.time - tz.std.utoff
  const e = ruleDay(tz.end, y) * DAY + tz.end.time - tz.dst.utoff
  return [{ t: s, utoff: tz.dst.utoff, isdst: 1 }, { t: e, utoff: tz.std.utoff, isdst: 0 }].sort((a, b) => a.t - b.t)
}

// 脚注在时刻 t（UTC 秒）的状态 { utoff（秒）, isdst }。
// 取 t 所在年及前后各一年的跃迁、找最后一个 ≤ t 的那次：跨年的规则（南半球、负时刻）都不必分情况。
// after：最后一次显式跃迁的时刻。脚注只管它【之后】发生的跃迁 —— 最近的脚注跃迁若不晚于 after，返回 null，
// 由调用方沿用显式段的末态（例：Goose Bay 2011-03-13 00:01 的显式跃迁早于脚注规则当年的 02:00，
// 两者之间若按脚注倒推会算成标准时，差一小时）。
// 返回值另带 { from, to }：该状态的起止时刻（秒），供调用方缓存恒定区间。
export function posixAt(tz, t, after = -Infinity) {
  if (!tz.dst) return after < t ? { utoff: tz.std.utoff, isdst: 0, from: after, to: Infinity } : null
  const y = new Date(t * 1000).getUTCFullYear()
  let best = null, next = null
  for (let yy = y - 1; yy <= y + 1; yy++) {
    for (const tr of yearTransitions(tz, yy)) {
      if (tr.t <= t) { if (!best || tr.t > best.t) best = tr }
      else if (!next || tr.t < next.t) next = tr
    }
  }
  if (!best || best.t <= after) return null
  return { utoff: best.utoff, isdst: best.isdst, from: best.t, to: next ? next.t : t + 86400 }
}

// 脚注的 rearguard「标准偏移」（秒）：夏令时一律为正 —— 负夏令时的脚注（爱尔兰 IST-1GMT0,…）
// 取两档里偏移小的那个当标准时。
export function posixStdBase(tz) {
  return tz.dst ? Math.min(tz.std.utoff, tz.dst.utoff) : tz.std.utoff
}
