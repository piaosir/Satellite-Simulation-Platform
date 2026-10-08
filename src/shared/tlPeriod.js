// 时间轴时段：时长 / 跨度的解析与读数、时段规范化、时刻输入框的格式往返（纯函数，不碰 Vue / DOM）。
//
// 时段两种模式（OpenMCT Time Conductor 的 Real-time / Fixed Timespan、Grafana 相对 / 绝对时间范围同一个分法）：
//   · roll  滚动 —— 只定跨度，时间窗随游标走（回看 25%），连播不设边界。改造前的时间轴就是这一档，出厂仍是它。
//   · fixed 固定 —— 起止时刻钉死（STK 的 Analysis / Animation Period）。尺子缩放只是看细节，时段本身不动；
//                  连播到终止时刻按 end 停止 / 循环 / 继续（simClockCore.boundStep）。
// 跨度 / 时长 1 s ~ 100 年。改造前封在 30 天，且只能取下拉五档或滚轮缩出来的近似值。
import { END_MODES } from './simClockCore.js'
import { tzParts, tzToMs } from './tz.js'

export const SPAN_MIN_SEC = 1
export const SPAN_MAX_SEC = Math.round(100 * 365.25 * 86400)
// 时刻输入框（datetime-local）只认四位年份：0001-01-01 ~ 9999-12-31
export const T_MIN_MS = -62135596800000
export const T_MAX_MS = 253402300799000
export const DUR_UNITS = [{ k: 's', sec: 1 }, { k: 'min', sec: 60 }, { k: 'h', sec: 3600 }, { k: 'd', sec: 86400 }]
// 常用时长（秒）：时段浮层里一排快捷档
export const QUICK_SPANS = [3600, 6 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400, 90 * 86400, 365 * 86400]

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const unitSec = (k) => (DUR_UNITS.find((u) => u.k === k) || DUR_UNITS[0]).sec
// 数值读数：去掉浮点尾巴（0.1+0.2 那类），不出科学计数
export const numTxt = (x) => String(Math.round(Number(x) * 1e6) / 1e6)

// —— 时长解析：纯数字按所选单位；带单位的可以连写（1d12h、2小时30分、1.5d、90 min、2w、1y）——
// 年按 365 天、周按 7 天算（时长不挂日历；要整年对齐就直接填终止时刻）。全角数字 / 全角小数点先归一。
const UNIT_RE = /(\d+(?:\.\d+)?|\.\d+)(years?|yrs?|y|年|weeks?|wks?|w|周|星期|days?|d|天|日|hours?|hrs?|h|小时|时|minutes?|mins?|m|分钟|分|seconds?|secs?|s|秒)/gi
const UNIT_SEC = { y: 365 * 86400, w: 7 * 86400, d: 86400, h: 3600, m: 60, s: 1 }
function unitKey(u) {
  const x = u.toLowerCase()
  if (/^(y|yrs?|years?|年)$/.test(x)) return 'y'
  if (/^(w|wks?|weeks?|周|星期)$/.test(x)) return 'w'
  if (/^(d|days?|天|日)$/.test(x)) return 'd'
  if (/^(h|hrs?|hours?|小时|时)$/.test(x)) return 'h'
  if (/^(m|mins?|minutes?|分钟|分)$/.test(x)) return 'm'
  return 's'
}
/** 文本 → 秒（> 0）；解析不出返回 null。unitSecs：纯数字时的单位（秒数） */
export function parseDur(text, unitSecs = 1) {
  const s = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[．。]/g, '.')
    .replace(/\s+/g, '')
  if (!s) return null
  if (/^(\d+(\.\d+)?|\.\d+)$/.test(s)) { const v = Number(s) * unitSecs; return v > 0 && Number.isFinite(v) ? v : null }
  let total = 0, used = 0
  for (const m of s.matchAll(UNIT_RE)) { total += Number(m[1]) * UNIT_SEC[unitKey(m[2])]; used += m[0].length }
  return used === s.length && total > 0 && Number.isFinite(total) ? total : null
}
/** 纯数值（倍速）：全角归一，容许前后带 × / x；不是正数返回 null */
export function parseNum(text) {
  const s = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[．。]/g, '.')
    .replace(/[\s×xX,，]/g, '')
  if (!/^(\d+(\.\d+)?|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null
  const v = Number(s)
  return v > 0 && Number.isFinite(v) ? v : null
}
/** 秒 → 输入框里的「数值 + 单位」：取能写成至多三位小数的最大单位（90 min → 1.5 h、100 s → 100 s） */
export function durPick(sec) {
  const s = Number(sec)
  if (!(s > 0)) return { v: '', k: 's' }
  for (let i = DUR_UNITS.length - 1; i > 0; i--) {
    const q = s / DUR_UNITS[i].sec
    if (q >= 1 && Math.abs(q * 1000 - Math.round(q * 1000)) < 1e-6) return { v: numTxt(q), k: DUR_UNITS[i].k }
  }
  return { v: numTxt(s), k: 's' }
}
/** 秒在指定单位下的读数 */
export const durIn = (sec, k) => (Number(sec) > 0 ? numTxt(Number(sec) / unitSec(k)) : '')
export { unitSec as durUnitSec }

// —— 紧凑读数（时间条「跨度 / 时段」钮、快捷档）：45s · 5m30s · 12h · 1d6h · 365d · 2.7y ——
// 天档先把总时长取整到小时再拆（零头小时单独取整会进位成「7d24h」）；1000 天起按儒略年写。
export function fmtSpanSec(sec) {
  const v = Math.max(0, Math.round(Number(sec) || 0))
  if (v < 60) return v + 's'
  if (v < 3600) { const m = Math.floor(v / 60), s = v % 60; return s ? `${m}m${s}s` : `${m}m` }
  if (v < 86400) {
    const mT = Math.round(v / 60), h = Math.floor(mT / 60), m = mT % 60
    return m ? `${h}h${m}m` : `${h}h`
  }
  if (v < 1000 * 86400) { const hT = Math.round(v / 3600), d = Math.floor(hT / 24), rh = hT % 24; return rh ? `${d}d${rh}h` : `${d}d` }
  const y = v / (365.25 * 86400)
  return (y < 10 ? String(Math.round(y * 10) / 10) : String(Math.round(y))) + 'y'
}

/** 存档 / 浮层回传的时段 → 规范形状。不是合法的固定时段一律落回滚动档（end 照留，下次切固定时沿用） */
export function normPeriod(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const end = END_MODES.includes(r.end) ? r.end : 'stop'
  const a = Math.round(Number(r.startMs)), b = Math.round(Number(r.stopMs))
  if (r.mode !== 'fixed' || !Number.isFinite(a) || !Number.isFinite(b) || b - a < SPAN_MIN_SEC * 1000) return { mode: 'roll', startMs: null, stopMs: null, end }
  const s0 = clamp(a, T_MIN_MS, T_MAX_MS - SPAN_MIN_SEC * 1000)
  const s1 = clamp(Math.min(b, s0 + SPAN_MAX_SEC * 1000), s0 + SPAN_MIN_SEC * 1000, T_MAX_MS)
  return { mode: 'fixed', startMs: s0, stopMs: s1, end }
}

// —— 时刻输入框（datetime-local，step=1）的格式往返：按显示时区档位读写，与「跳到时刻」同一口径 ——
// 秒为 0 时省掉「:00」：与 Chromium 规范化后的 value 同一写法，否则重渲时往正在键入的框里回写。
export function fmtLocalInput(ms, tz) {
  if (!Number.isFinite(ms)) return ''
  const q = tzParts(ms, tz), p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(q.y, 4)}-${p(q.mo)}-${p(q.d)}T${p(q.h)}:${p(q.mi)}` + (q.s ? ':' + p(q.s) : '')
}
// ★ 年份不足四位不认：键入途中年份是「0202」这类半截值，当真就跳到公元 202 年
export function parseLocalInput(v, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(v || ''))
  if (!m || m[1][0] === '0') return null
  const [, Y, Mo, D, h, mi, s] = m.map(Number)
  const t = tzToMs(tz, Y, Mo, D, h, mi, s || 0)
  return Number.isFinite(t) ? t : null
}
