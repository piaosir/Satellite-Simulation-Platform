// 时刻文本 ⇄ UTC 毫秒（按显示时区档位）—— 航迹表格、对地性能表、气象表的「时间」列共用一份口径。
//
//   fmtTzTime(ms, mode)            → 'YYYY-MM-DD HH:mm:ss'（该档位的墙钟；非有限 → ''）
//   fmtTzTimeOff(ms, mode)         → 'YYYY-MM-DD HH:mm:ss +08:00'（导出 Excel：带偏移，换台机器 / 换档位读回来不走样）
//   parseTzText(text, mode, refMs) → UTC ms | NaN
//     · 完整日期时间（parseDateTimeText 的写法：YYYY-MM-DD[ T]HH:mm[:ss[.sss]]，日期分隔也认 / 与 .，可带 Z / UTC / ±hh:mm）：
//       写了时区按所写；没写按档位（本机档走 tzToMs —— 夏令时切换那两天同一墙钟的偏移不同）
//     · 只有时刻（HH:mm[:ss]）：日期取 refMs 在该档位下的那一天（表格里改到点只敲时分，日期沿用该行原来那天）
//     · Excel 日期格：exceljs 把表格序列值当 UTC 墙钟读成 'YYYY-MM-DDTHH:mm:ss.sssZ'（带毫秒）—— 那个 Z 不是用户写的，
//       按墙钟（显示时区）读；用户自己写的 Z / ±hh:mm 不带毫秒，照常按所写时区
// 口径同 3D 页航迹「起始」输入框（t0Commit）；模块无 Vue 依赖，node 单测可直接 import。
import { tzOffMin, tzParts, tzToMs } from './tz.js'
import { parseDateTimeText, partsToUtcMs } from '../../packages/core/models/entityRuntime.mjs'

const p2 = (n) => String(n).padStart(2, '0')

export function fmtTzTime(ms, mode) {
  if (!Number.isFinite(ms)) return ''
  const p = tzParts(ms, mode)
  return `${p.y}-${p2(p.mo)}-${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`
}

export function fmtTzTimeOff(ms, mode) {
  if (!Number.isFinite(ms)) return ''
  const off = tzOffMin(mode, ms), a = Math.abs(off)
  return fmtTzTime(ms, mode) + ' ' + (off < 0 ? '-' : '+') + p2(Math.floor(a / 60)) + ':' + p2(a % 60)
}

const EXCEL_ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\.\d{3}Z$/
const TIME_ONLY = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/

// 墙钟分量（该档位）→ UTC ms
function wallToMs(mode, Y, Mo, D, h, mi, s, ms) {
  if (mode === 'local') return tzToMs('local', Y, Mo, D, h, mi, s) + (ms || 0)
  return partsToUtcMs({ Y, Mo, D, h, mi, s, ms: ms || 0, offMin: null }, tzOffMin(mode, Date.now()))
}

export function parseTzText(text, mode, refMs) {
  if (typeof text === 'number') return Number.isFinite(text) ? text : NaN
  let s = String(text == null ? '' : text).trim()
  if (!s) return NaN
  const ex = EXCEL_ISO.exec(s)
  if (ex) s = ex[1] + ' ' + ex[2]
  const tm = TIME_ONLY.exec(s)
  if (tm) {
    const h = Number(tm[1]), mi = Number(tm[2]), sec = tm[3] !== undefined ? Number(tm[3]) : 0
    if (h > 23 || mi > 59 || sec > 59) return NaN
    const r = tzParts(Number.isFinite(refMs) ? refMs : Date.now(), mode)
    return wallToMs(mode, r.y, r.mo, r.d, h, mi, sec, 0)
  }
  const d = parseDateTimeText(s)
  if (!d) return NaN
  if (d.offMin != null) return partsToUtcMs(d, 0)
  return wallToMs(mode, d.Y, d.Mo, d.D, d.h, d.mi, d.s, d.ms)
}
