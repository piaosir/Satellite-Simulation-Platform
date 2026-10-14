// 滑杆配数值框 —— 纯逻辑部分（DOM 行为在 rangeField.js）。不碰 DOM，可单测。
//
// 读数与滑杆值之间的口径不是逐处登记的，而是开编辑那一刻从现场推出来的：
// 读数「18%」、滑杆值 0.18 → 倍率 100；读数「1.20×」、值 1.2 → 倍率 1、单位「×」。
// 推不出线性倍率的（对数刻度、时刻）由组件在滑杆上挂 rnumMap 自己给换算。

// 全角数字 / 运算符 / 冒号、中文句号、各种减号、乘除号 → 半角。中文输入法开着时打出来的就是这些。
export function normTyped(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/。/g, '.')
    .replace(/[−‒–—]/g, '-')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/　/g, ' ')
    .trim()
}

// 四则算式：数字（含小数、科学计数）、+ - * /、括号、一元正负。空白与千分位逗号忽略。
// 手写递归下降，不走 eval / Function。非法或非有限 → NaN。
export function evalExpr(src) {
  const s = String(src == null ? '' : src).replace(/[\s,]/g, '')
  if (!s) return NaN
  let i = 0
  const num = () => {
    const m = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i))
    if (!m) throw new Error('num')
    i += m[0].length
    return Number(m[0])
  }
  const factor = () => {
    const c = s[i]
    if (c === '+') { i++; return factor() }
    if (c === '-') { i++; return -factor() }
    if (c === '(') {
      i++
      const v = expr()
      if (s[i] !== ')') throw new Error('paren')
      i++
      return v
    }
    return num()
  }
  const term = () => {
    let v = factor()
    for (;;) {
      if (s[i] === '*') { i++; v *= factor() } else if (s[i] === '/') { i++; v /= factor() } else return v
    }
  }
  const expr = () => {
    let v = term()
    for (;;) {
      if (s[i] === '+') { i++; v += term() } else if (s[i] === '-') { i++; v -= term() } else return v
    }
  }
  try {
    const v = expr()
    return i === s.length && Number.isFinite(v) ? v : NaN
  } catch {
    return NaN
  }
}

// 读数文本 → { num, numText, dec, pre, suf }：取第一段数字，前后的余字是单位（「%」「×」「dB」「°」…）。
const NUM_RE = /[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:e[-+]?\d+)?|[-+−]?\.\d+/i
export function parseReadout(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  const m = NUM_RE.exec(t)
  if (!m) return null
  const numText = m[0].replace(/−/, '-').replace(/,/g, '')
  const num = Number(numText)
  if (!Number.isFinite(num)) return null
  const frac = /\.(\d+)/.exec(numText.split(/e/i)[0])
  return {
    num,
    numText,
    dec: frac ? frac[1].length : 0,
    pre: t.slice(0, m.index).trim(),
    suf: t.slice(m.index + m[0].length).trim()
  }
}

// 读数 = k × 滑杆值 的 k。先严格（只容读数自身的舍入），再放宽半个 step（键入过不在台阶上的值：
// 模型里是 0.33、滑杆 DOM 被吸到 0.35）。值为 0 时所有 k 都成立：带「%」且上限 ≤ 1 取 100，否则取 1。
// 推不出 → null（调用方改走「直接编辑滑杆原值」）。
const KS = [1, 100, 1000, 0.01, 0.001, 10, 0.1]
export function inferScale(v, ro, step, max) {
  if (!ro || !Number.isFinite(v)) return null
  if (v === 0 && ro.num === 0) return ro.suf === '%' && Number.isFinite(max) && max <= 1 ? 100 : 1
  const half = 0.5 * Math.pow(10, -ro.dec)
  const eps = 1e-9 * Math.max(1, Math.abs(ro.num))
  for (const loose of [false, true]) {
    let best = null
    let bestErr = Infinity
    for (const k of KS) {
      const tol = half + eps + (loose && step > 0 ? Math.abs(k) * step / 2 : 0)
      const err = Math.abs(ro.num - k * v)
      if (err <= tol && err / tol < bestErr) { best = k; bestErr = err / tol }
    }
    if (best != null) return best
  }
  return null
}

export function decimalsOf(x) {
  const s = String(x)
  const e = s.indexOf('e-')
  if (e >= 0) return Number(s.slice(e + 2)) + Math.max(0, (s.slice(0, e).split('.')[1] || '').length)
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

// 键入的值不吸附到滑杆台阶（线粗台阶 0.01，打 1.255 就是 1.255）。只有整数台阶的量（根数、序号、像素）按整数收。
// 一律夹进 [min, max]。
export function isIntStep(step) {
  return step >= 1 && Math.abs(step - Math.round(step)) < 1e-9
}
export function settle(x, min, max, step) {
  if (!Number.isFinite(x)) return null
  const lo = Number.isFinite(min) ? min : -Infinity
  const hi = Number.isFinite(max) ? max : Infinity
  let v = Math.min(hi, Math.max(lo, x))
  if (isIntStep(step)) {
    v = Math.round(v)
    if (v > hi) v = Math.floor(hi)
    if (v < lo) v = Math.ceil(lo)
  }
  return { v: Number(v.toPrecision(12)), clamped: x < lo || x > hi }
}

// —— 台阶口径（2026-10-14 起全库统一）——
// 拖动 = 纯线性：台阶取读数的末位（读数上能显示的每个值都拖得到，不出 0.5 / 0.05 一跳的阶梯），
// 且全程不少于约 100 档（条宽 200–300px 时每档 ≤ 3px，填充跟手）。线宽 0.01、透明度 / 系数 / 倍率 0.01、
// 尺寸 / 字号 0.1、dB 0.1；根数、序号、时刻这类本义离散的量仍是整数台阶。
// 台阶细了以后，方向键与读数横拖若仍按台阶走就太慢 —— 二者改按全程比例走（下两个函数）。

// 值域由数据决定的滑杆（模型关节）：台阶取 10 的整数次幂、全程不少于 n 档。
export function fineStep(min, max, n = 100) {
  const span = Math.abs(max - min)
  if (!(span > 0) || !Number.isFinite(span)) return 0.01
  return Number(Math.pow(10, Math.floor(Math.log10(span / n))).toPrecision(1))
}

// 方向键 / 滚轮微调的一档：约全程的 1%，取 1-2-5 序列里不小于它的那个；不细于台阶、且是台阶的整数倍。
export function nudgeOf(min, max, step) {
  const span = max - min
  if (!(span > 0) || !Number.isFinite(span)) return step > 0 ? step : 1
  const raw = span / 100
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  let n = 10 * p
  for (const m of [1, 2, 5]) if (m * p >= raw * (1 - 1e-9)) { n = m * p; break }
  if (step > 0) n = n <= step ? step : Math.round(n / step) * step
  return Number(n.toPrecision(12))
}

// 从 v 沿 dir 走到下一个「档的整数倍」（12.37 ↑ → 12.5，不是 12.87）：拖出来的零碎值一按就回到整齐数。夹进 [min, max]。
export function nudgeTo(v, dir, nudge, min, max) {
  const q = v / nudge
  const k = dir > 0 ? Math.floor(q + 1e-9) + 1 : Math.ceil(q - 1e-9) - 1
  const x = Number((k * nudge).toPrecision(12))
  return Math.min(max, Math.max(min, x))
}

// 按住读数横拖：每像素走多少值。全程约 240px 走完；台阶粗（档数 < 60）时每档至少 4px，免得一抖就跳一档。
export const SCRUB_SPAN_PX = 240
export function scrubRate(min, max, step) {
  const span = max - min
  const st = step > 0 ? step : span / 1000
  return Math.max(span / SCRUB_SPAN_PX, st / 4)
}

// 落到台阶上（以 min 为基准，与浏览器对滑杆值的吸附同口径）
export function snapStep(x, min, max, step) {
  let v = Math.min(max, Math.max(min, x))
  if (step > 0) v = Math.min(max, min + Math.round((v - min) / step) * step)
  return Number(v.toPrecision(12))
}

// 键入文本 → 显示口径下的数。先剥掉读数自己的单位（「50%」「1.5×」照打也认），
// 再剩一个结尾「%」的按百分数算（透明度读数是「0.50」时打「50%」= 0.5）。
export function parseTyped(raw, suf) {
  let s = normTyped(raw)
  const u = normTyped(suf || '')
  if (u && s.endsWith(u)) s = s.slice(0, -u.length).trim()
  let div = 1
  if (s.endsWith('%')) { s = s.slice(0, -1); div = 100 }
  const n = evalExpr(s)
  return Number.isFinite(n) ? n / div : NaN
}

// 数值按读数的小数位格式化（方向键微调后回填编辑框用）
export function fmtDisplay(x, dec) {
  if (!Number.isFinite(x)) return ''
  const d = Math.max(0, Math.min(10, dec | 0))
  return Number(x.toFixed(d)).toFixed(d)
}

// 时刻文本 → 墙钟分量 { y, mo, d, h, mi, s }。认：
//   「YYYY-MM-DD HH:MM[:SS]」「YYYY/MM/DD」「YYYY-MM-DD」（零点）「HH:MM[:SS]」（日期沿用 ref）
// 全角冒号 / 斜杠照认。ref 为当前显示的分量（缺日期时补用）。非法 → null。
export function parseDateTimeText(text, ref) {
  const s = normTyped(text).replace(/\s+/g, ' ')
  const m = /^(?:(\d{4})[-/.](\d{1,2})[-/.](\d{1,2}))?(?:[ T]?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(s)
  if (!m || (!m[1] && !m[4])) return null
  if (!m[1] && !ref) return null
  const y = m[1] ? Number(m[1]) : ref.y
  const mo = m[1] ? Number(m[2]) : ref.mo
  const d = m[1] ? Number(m[3]) : ref.d
  const h = m[4] ? Number(m[4]) : 0
  const mi = m[4] ? Number(m[5]) : 0
  const sec = m[6] ? Number(m[6]) : 0
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null
  return { y, mo, d, h, mi, s: sec }
}
