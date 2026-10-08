// 起止时刻输入框（<input type="datetime-local">）的读写与「结束时刻 ⇄ 时长」换算 —— 三处共用：
//   星间链路距离工具（本机时区 'local'）、干扰分析 NGSO 时段（'utc'，与结果里的时刻同一口径）、工作台分析页（窗口自己的显示时区档）。
// 时区档位与墙钟分量的换算走 shared/tz.js 那两个咽喉（tzParts / tzToMs）；搜索起点设置（shared/geoT0.js）是同一套写法。
//
// 口径：时段 = 起始时刻 + 时长；结束时刻是时长的另一种填法 —— 改结束时刻＝改时长（须晚于起始），改起始时刻时长不变（结束跟着平移）。
// ★ datetime-local 每改一段就发一次 change（Chromium），年份敲到一半是 0002 / 0020 / 0202：4 位年 < 1000 一律不认 ——
//   否则 Date.UTC / new Date(y, …) 会把 0–99 年当成 19xx，半截输入就被记成一个百年前的时刻（3D 页树星历元输入踩过）。
// 纯 ESM、不依赖 Vue：node 可直接测（packages/core/test/timeWindowInput.test.mjs）。
import { tzParts, tzToMs } from './tz.js'

export const MIN_INPUT_YEAR = 1000
const RE_DT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/
const p2 = (n) => String(n).padStart(2, '0')

/** ms → 该时区档位的 datetime-local 值（到分）；无效给空串 */
export function inputText(ms, tzMode = 'local') {
  if (!Number.isFinite(ms)) return ''
  const q = tzParts(ms, tzMode)
  return `${String(q.y).padStart(4, '0')}-${p2(q.mo)}-${p2(q.d)}T${p2(q.h)}:${p2(q.mi)}`
}
/** datetime-local 值（该时区档位的墙钟）→ ms；格式不对 / 年份 < 1000 / 读不出 → NaN */
export function parseInput(v, tzMode = 'local') {
  const m = RE_DT.exec(String(v == null ? '' : v).trim())
  if (!m || +m[1] < MIN_INPUT_YEAR) return NaN
  const t = tzToMs(tzMode, +m[1], +m[2], +m[3], +m[4], +m[5], m[6] ? +m[6] : 0)
  return Number.isFinite(t) ? t : NaN
}
/** 结束时刻 = 起始 + 时长（h）；无效 NaN */
export function endFromHours(t0, hours) {
  const h = Number(hours)
  return Number.isFinite(t0) && h > 0 ? t0 + h * 3600e3 : NaN
}
/** 改结束时刻 → 新时长（h）：须晚于起始、不超过 maxHours（缺省不限）；不合格 NaN（调用方保持原时长） */
export function hoursFromEnd(t0, t1, maxHours = Infinity) {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) return NaN
  const h = (t1 - t0) / 3600e3
  return h <= maxHours ? h : NaN
}
