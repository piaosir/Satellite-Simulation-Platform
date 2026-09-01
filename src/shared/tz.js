// 显示时区 —— 全平台唯一一份口径与格式化。
//
// ★ 只改【显示】：Date 内部是 UTC 毫秒数，SGP4 / 晨昏线 / 过境窗口全程走 getUTC*，
//   换档位不改变任何计算结果（时区不参与任何计算这条已逐功能核实过，勿再重查）。
//
// 档位（mode）三种取值，一律由本文件解释，各窗口不再自己判 'utc' / 'local'：
//   'local'  本机时区 —— 跟 Windows「时间和语言 → 时区」，含夏令时，逐时刻取
//   'utc'    UTC
//   数字      相对 UTC 的【固定偏移】(分钟)：480 = UTC+8、−300 = UTC−5
// ★ 固定档是纯偏移、不是某个国家的时区：不含夏令时、不随日期变化（与 STK 的 UTC offset 同口径）。
//   要跟夏令时走请选本机档。
//
// 取分量与反解一律走这里两个咽喉：
//   tzParts(ms, mode)                      绝对时刻 → 该档位的墙钟分量
//   tzToMs(mode, Y, Mo, D, h, mi, s)       该档位的墙钟 → 绝对时刻
// 自己写 `utc ? getUTCHours() : getHours()` 那种两分支的写法在固定偏移档下必然算错。

// 可选固定偏移的整点范围（真实存在的时区跨度：UTC−12 ~ UTC+14）
export const TZ_HOUR_MIN = -12
export const TZ_HOUR_MAX = 14

export function isFixedTz(mode) { return Number.isFinite(mode) }

// 存档 / 旧值 → 规范档位。'beijing'（NGSO 老档）折成固定 +8；越界或无法解释时退回 def。
export function normTzMode(v, def = 'local') {
  if (v === 'utc' || v === 'local') return v
  if (v === 'beijing') return 480
  const n = Number(v)
  if (v !== '' && v != null && Number.isFinite(n) && Math.abs(n) <= TZ_HOUR_MAX * 60) return Math.round(n)
  return def
}

// 档位在某一时刻的偏移(分钟)。本机档必须【按该时刻】取：夏令时区里 7 月与 1 月差一小时，
// 拿 Date.now() 的偏移去格式化半年前的时刻会整体偏 1 h。
export function tzOffMin(mode, ms) {
  if (mode === 'utc') return 0
  if (Number.isFinite(mode)) return mode
  return -new Date(Number.isFinite(ms) ? ms : Date.now()).getTimezoneOffset()
}

// 偏移(分钟) → 角标：0→'UTC'、480→'UTC+8'、−330→'UTC−5:30'（负号用 U+2212，与平台读数一致）
export function tzOffLabel(min) {
  const m = Math.round(Number(min) || 0)
  if (!m) return 'UTC'
  const a = Math.abs(m)
  return 'UTC' + (m < 0 ? '−' : '+') + Math.floor(a / 60) + (a % 60 ? ':' + String(a % 60).padStart(2, '0') : '')
}

// 档位角标（本机档＝该时刻的实际偏移，故半时区/夏令时都能如实标出）
export function tzTag(mode, ms) { return tzOffLabel(tzOffMin(mode, ms)) }

// 平移到「该档位的墙钟落在 UTC 字段上」的 Date：读它的 getUTC* 即得该档位的年月日时分秒。
// ★ 这是本文件的核心技巧 —— 一条路径同时覆盖 UTC / 本机 / 任意固定偏移，不再分支。
export function tzDate(ms, mode) { return new Date(ms + tzOffMin(mode, ms) * 60000) }

export function tzParts(ms, mode) {
  const d = tzDate(ms, mode)
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }
}

// 该档位的墙钟分量 → 绝对时刻(ms)。
// 本机档走 new Date(...) 而不是「减偏移」：夏令时切换那两天里同一墙钟的偏移前后不同，
// 只有构造器认得当地日历（跳过 / 重复的那一小时也由它按平台规则落定）。
export function tzToMs(mode, Y, Mo, D, h, mi, s) {
  const y = Number(Y), mo = Number(Mo), d = Number(D)
  const hh = Number(h) || 0, mm = Number(mi) || 0, ss = Number(s) || 0
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return NaN
  if (mode === 'local') return new Date(y, mo - 1, d, hh, mm, ss).getTime()
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - (mode === 'utc' ? 0 : Number(mode) || 0) * 60000
}

// 时区菜单项：本机 / UTC / UTC−12…UTC+14（跳过 0，UTC 已单列一项）。
// value 直接就是档位，label 是名字、tag 是偏移角标（本机档的角标随 ms 变）。
export function tzOptions(ms) {
  const out = [
    { value: 'local', label: '本机', tag: tzOffLabel(tzOffMin('local', ms)), fixed: false },
    { value: 'utc', label: 'UTC', tag: '', fixed: false }
  ]
  for (let h = TZ_HOUR_MIN; h <= TZ_HOUR_MAX; h++) {
    if (!h) continue
    out.push({ value: h * 60, label: tzOffLabel(h * 60), tag: '', fixed: true })
  }
  return out
}
