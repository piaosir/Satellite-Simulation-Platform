// OMM / TLE 历元串 -> UTC 毫秒（渲染端共用的唯一入口）。
//
// 【为什么要有这一个函数】CelesTrak 的 GP / OMM 记录里 EPOCH 写成「2026-09-20T12:34:56.123456」——
//   尾部没有 Z。ECMAScript 规定「带时间但不带时区」的 ISO 串按【本地时间】解，Date.parse 在北京
//   机器上直接差 8 小时。引擎那侧（packages/core/vendor/satellite.js 的 omm2satrec）一直是补 Z 按
//   UTC 解析的，屏上的历元读数却各写各的 Date.parse —— 同一颗星，算的是一个时刻、显示的是另一个。
//   凡是吃 OMM / TLE 历元串的地方一律走这里，口径与 omm2satrec 逐字一致。
//
// 已带 Z 或 ±hh:mm 偏移的串原样交给 Date.parse（本来就有时区，再补 Z 只会变成 NaN）。
// 只有日期、没有时分的串按 ECMAScript 已经是 UTC，也不补。
// 解不出返回 NaN —— 调用方自己决定留空还是回落，本函数不编数。

const HAS_ZONE = /(?:[Zz]|[+-]\d{2}:?\d{2})$/
const HAS_TIME = /[T ]\d{1,2}:\d{2}/

export function epochMs(epoch) {
  const s = String(epoch == null ? '' : epoch).trim()
  if (!s) return NaN
  return Date.parse(HAS_TIME.test(s) && !HAS_ZONE.test(s) ? s + 'Z' : s)
}

export default epochMs
