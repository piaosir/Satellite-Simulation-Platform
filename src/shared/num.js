// 全角/Unicode 数字变体归一到半角。
// 中文输入法在全角标点模式下会把「-」输成全角减号「－」(U+FF0D)（而数字仍是半角），JS 的 Number()/parseFloat()
// 只认半角 → Number('－75')=NaN，导致负数（西经/南纬经纬度、门限 Eb/N₀、SFDref、增益偏置等）被静默吞掉
// （症状：正数能填、负数不识别）。此工具供 GEO/NGSO/再生式链路预算统一收口。
// 注：性能表 src/viz/grd/usePerfTable.js 内有同款 toHalf/num（逻辑一致，未共享以免牵动已发版模块）。

// 归一：全角数字 ０-９、各种减号变体（全角－/数学−/破折–—―/小减号﹣）、全角＋、全角句点．与中文句号。 → 半角
export function toHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[－−–—―﹣]/g, '-')
    .replace(/＋/g, '+')
    .replace(/[．。]/g, '.')
}

// 仅归一、保持字符串（供以字符串交下游引擎的收口，如 buildParams）；非字符串原样返回，不改变类型。
export const halfStr = (v) => (typeof v === 'string' ? toHalf(v) : v)

// 全角容错版 parseFloat（drop-in 替换）：先归一再 parseFloat；非数得 NaN（与 parseFloat 同语义）。
export const pf = (v) => parseFloat(toHalf(v))

// 解析为数字：先归一再 Number；空/空白/非数 → null（保「空→null」不变式，勿把空写成 0）。
export function num(v) {
  if (v == null) return null
  const s = toHalf(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// 严格数值语法：整串（去首尾空白、全角转半角后）是一个十进制数——可带正负号、小数点、科学计数。
// 与引擎侧 packages/core/utils/strictNum.js 的 NUM_RE 逐字相同（引擎不能 import src，各存一份，改一处务必改另一处）。
// 「36 MHz」「12,5」「1.2.3」「0x10」「Infinity」一律不认——parseFloat 会按前缀把前两个读成 36 / 12，静默算错。
export const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

// 严格解析：空（null / undefined / 纯空白）→ null；合法 → number（取值与 parseFloat 逐位同）；非法 → NaN。
// 三态分开返回，供校验区分「留空＝按缺省」与「填了但不是数」。number 型：有限即原值，否则 NaN。
export function numStrict(v) {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
  if (typeof v !== 'string') return NaN
  const t = v.trim()
  if (t === '') return null
  const s = NUM_RE.test(t) ? t : toHalf(t).trim()
  if (!NUM_RE.test(s)) return NaN
  const n = parseFloat(s)
  return Number.isFinite(n) ? n : NaN
}
