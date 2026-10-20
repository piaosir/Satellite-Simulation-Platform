// TZif（RFC 8536）解析 + POSIX TZ 脚注展开 + rearguard 夏令时语义 —— 只为 scripts/build-timezones.mjs 服务，不进运行时包。
//
// 产出：一个时区在 [1970, 2100] 内的「段」列表 [{ t, off, dst }]：t = 该段起点（Unix 秒；第一段为 -Infinity），
// off = 民用时 UTC 偏移（分钟），dst = 其中夏令时的份额（分钟，rearguard 语义：一律 ≥ 0）。
//   · 显式跃迁取 v2+ 数据块（64 位时刻）；tzdata 包是 slim 格式 —— 最后一次显式跃迁之后的规则只写在脚注的
//     POSIX TZ 串里（如 Berlin 的 CET-1CEST,M3.5.0,M10.5.0/3），必须自己展开，否则 2000 年以后全错。
//   · 脚注语法按 RFC 8536 的扩展：规则时刻可为负、可超过 24 h（以色列 M3.4.4/26、格陵兰 M3.5.0/-1）。
//   · TZif 不记「夏令时多少」，只记 isdst：dst = 本段偏移 − 相邻标准时段的偏移（前一个标准段优先）。
//   · main 格式里几个负夏令时（爱尔兰、摩洛哥 / 西撒 2018–2026、纳米比亚 1994–2017）按 rearguard 翻转：
//     在负夏令时生效的窗口里，偏移小的那段算标准时、偏移大的那段算夏令时（dst 一律为正）。
//     窗口 = 第一个负夏令时段 … 最后一个负夏令时段，两头各带上紧邻的、短于一年的标准段
//     （摩洛哥 2018-10-28 起的 +01 与 2026-09-20 之前那段 +01 属于窗口；爱尔兰 1968–71 的全年 IST、
//     纳米比亚 1990–94 的 CAT 都长于一年，是真正的标准时，不翻）。
//     纳米比亚的窗口按此收在 2017-09-03（rearguard 源文件写的是 2017-10-24：那次只改了法定口径、
//     民用时不变，TZif 里没有这次跃迁）—— 2017 年那 51 天的标准时口径差一小时，民用时不受影响。

const DAY = 86400

export function parseTzif(buf) {
  if (buf.toString('latin1', 0, 4) !== 'TZif') throw new Error('不是 TZif')
  const ver = buf[4]
  const hdr = (p) => ({
    isutcnt: buf.readUInt32BE(p + 20), isstdcnt: buf.readUInt32BE(p + 24), leapcnt: buf.readUInt32BE(p + 28),
    timecnt: buf.readUInt32BE(p + 32), typecnt: buf.readUInt32BE(p + 36), charcnt: buf.readUInt32BE(p + 40)
  })
  let h = hdr(0)
  let p = 44
  const v1len = h.timecnt * 5 + h.typecnt * 6 + h.charcnt + h.leapcnt * 8 + h.isstdcnt + h.isutcnt
  if (ver < 0x32) throw new Error('只支持 TZif v2+（v1 没有 64 位时刻与脚注）')
  p += v1len
  if (buf.toString('latin1', p, p + 4) !== 'TZif') throw new Error('v2 头缺失')
  h = hdr(p)
  p += 44
  const times = new Array(h.timecnt)
  for (let i = 0; i < h.timecnt; i++) times[i] = Number(buf.readBigInt64BE(p + i * 8))
  p += h.timecnt * 8
  const idx = new Array(h.timecnt)
  for (let i = 0; i < h.timecnt; i++) idx[i] = buf[p + i]
  p += h.timecnt
  const types = new Array(h.typecnt)
  for (let i = 0; i < h.typecnt; i++) {
    types[i] = { utoff: buf.readInt32BE(p), isdst: buf[p + 4], abbr: buf[p + 5] }
    p += 6
  }
  const chars = buf.toString('latin1', p, p + h.charcnt)
  for (const t of types) t.abbr = chars.slice(t.abbr, chars.indexOf('\0', t.abbr))
  p += h.charcnt + h.leapcnt * 12 + h.isstdcnt + h.isutcnt
  let footer = ''
  if (buf[p] === 0x0a) { const e = buf.indexOf(0x0a, p + 1); footer = buf.toString('latin1', p + 1, e < 0 ? buf.length : e) }
  return { version: String.fromCharCode(ver), times, idx, types, footer }
}

// ---------- POSIX TZ 串 ----------
// 返回 { std: { name, utoff }, dst?: { name, utoff }, start?, end? }；utoff 为秒（东正西负，已按 POSIX 的反号还原）
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

// 规则日期 → 当年第几天（1970 起的绝对日序）
function ruleDay(r, y) {
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

// 一年内的两次跃迁（UTC 秒）：开始时刻按本地标准时、结束时刻按本地夏令时（POSIX 定义）
function yearTransitions(tz, y) {
  const s = ruleDay(tz.start, y) * DAY + tz.start.time - tz.std.utoff
  const e = ruleDay(tz.end, y) * DAY + tz.end.time - tz.dst.utoff
  return [{ t: s, utoff: tz.dst.utoff, isdst: 1 }, { t: e, utoff: tz.std.utoff, isdst: 0 }].sort((a, b) => a.t - b.t)
}

// TZif + 脚注 → 1970…2100 的段 [{ t, utoff(秒), isdst }]，第一段 t = -Infinity（1970-01-01 那一刻所处的状态）
export function zonePeriods(z, untilYear = 2100) {
  const T0 = 0
  const segs = []
  // 1970-01-01 所处的类型：最后一个 ≤ T0 的跃迁；没有则取类型 0（RFC 8536：首次跃迁之前用 0 号类型）
  let k = -1
  for (let i = 0; i < z.times.length; i++) if (z.times[i] <= T0) k = i
  const t0type = k >= 0 ? z.types[z.idx[k]] : z.types[0]
  segs.push({ t: -Infinity, utoff: t0type.utoff, isdst: t0type.isdst })
  for (let i = k + 1; i < z.times.length; i++) {
    const ty = z.types[z.idx[i]]
    segs.push({ t: z.times[i], utoff: ty.utoff, isdst: ty.isdst })
  }
  const last = z.times.length ? z.times[z.times.length - 1] : -Infinity
  const endT = Date.UTC(untilYear + 1, 0, 1) / 1000
  if (z.footer) {
    const tz = parsePosixTz(z.footer)
    if (tz.dst) {
      const y0 = Math.max(1970, Number.isFinite(last) ? new Date(last * 1000).getUTCFullYear() : 1970)
      for (let y = y0; y <= untilYear; y++) for (const tr of yearTransitions(tz, y)) if (tr.t > last && tr.t < endT) segs.push(tr)
    } else if (!z.times.length || segs[segs.length - 1].utoff !== tz.std.utoff) {
      // 无夏令时的脚注：与最后一段不一致时（极少见）以脚注为准，从最后一次显式跃迁起生效
      if (Number.isFinite(last)) segs.push({ t: last + 1, utoff: tz.std.utoff, isdst: 0 })
    }
  }
  // 去掉不改变任何东西的跃迁（偏移与 isdst 都同前一段）
  const out = []
  for (const s of segs) {
    const p = out[out.length - 1]
    if (p && p.utoff === s.utoff && p.isdst === s.isdst) continue
    out.push(s)
  }
  return out
}

// 段 → rearguard 语义的 { t, off, dst }（分钟）
export function rearguard(segs) {
  const n = segs.length
  const std = new Array(n), dst = new Array(n)
  const stdIdx = []
  for (let i = 0; i < n; i++) if (!segs[i].isdst) stdIdx.push(i)
  // 夏令时段的「标准偏移」：前一个标准段，没有则后一个
  for (let i = 0; i < n; i++) {
    if (!segs[i].isdst) { std[i] = segs[i].utoff; dst[i] = 0; continue }
    let j = -1
    for (let q = i - 1; q >= 0; q--) if (!segs[q].isdst) { j = q; break }
    if (j < 0) for (let q = i + 1; q < n; q++) if (!segs[q].isdst) { j = q; break }
    std[i] = j >= 0 ? segs[j].utoff : segs[i].utoff - 3600
    dst[i] = segs[i].utoff - std[i]
  }
  // 负夏令时窗口
  const neg = []
  for (let i = 0; i < n; i++) if (segs[i].isdst && dst[i] < 0) neg.push(i)
  if (neg.length) {
    const dur = (i) => (i + 1 < n ? segs[i + 1].t - segs[i].t : Infinity)
    let a = neg[0], b = neg[neg.length - 1]
    if (a > 0 && !segs[a - 1].isdst && dur(a - 1) < 366 * DAY) a--
    if (b + 1 < n && !segs[b + 1].isdst && dur(b + 1) < 366 * DAY) b++
    let mn = Infinity
    for (let i = a; i <= b; i++) mn = Math.min(mn, segs[i].utoff)
    for (let i = a; i <= b; i++) { std[i] = mn; dst[i] = segs[i].utoff - mn }
  }
  return segs.map((s, i) => ({ t: s.t, off: s.utoff / 60, dst: dst[i] / 60 }))
}
