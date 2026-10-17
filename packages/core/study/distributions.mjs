// 参数研究 · 概率分布（逆 CDF 采样）与 Iman–Conover 相关性施加。
//
// 为什么全走逆 CDF：设计（LHS / Sobol / 蒙特卡洛，见 designs.mjs）先在单位超立方体 [0,1)^k 上撒点，
// 再逐列经 ppf 映射成各参数的分布。「怎么撒点」与「参数服从什么分布」就此解耦：ppf 单调，LHS 的分层、
// Sobol 的低差异性原样保留到每个边缘上。Box–Muller、拒绝采样之类会把一个 u 拆成几个或丢掉一部分 u，
// 分层就断了。
//
// 分布规格是纯 JSON，界面可直接存盘；makeDist 编译成 { ppf, cdf, mean, sd, lower, upper }：
//   uniform      { lower, upper }
//   normal       { mu, sigma }
//   truncnormal  { mu, sigma, lower?, upper? }   lower / upper 缺省或 ±Infinity 即该侧不截
//   triangular   { lower, mode, upper }
//   lognormal    { mu, sigma }                   ln X ~ N(mu, sigma²)
//                { mean, sd }                    或给 X 本身的均值 / 标准差，内部换算成 mu / sigma
//   empirical    { samples, interp? }            样本的经验分布：interp 'linear'（缺省，type-7 分位插值，
//                                                支撑 = [min, max]）| 'step'（ECDF 的广义逆，只取样本值）
//                { x, p }                        表格 CDF：p 从 0 单调到 1，分段线性（如雨衰「衰减–累积概率」表）
//   discrete     { values, weights? }            数值型离散分布（weights 缺省等概率）
//
// 端点口径：ppf(0) / ppf(1) 是支撑的下 / 上确界（无界分布即 ∓Infinity）。设计 → 分布的批量映射 mapUnit
// 先把 u 夹进 [2⁻³³, 1 − 2⁻³³]：本库所有均匀源的分辨率都是 2⁻³²，这个夹只挪动恰为 0 的点（如未加扰
// Sobol 的首点），不碰任何内部格点；未夹时正态参数会在那一行拿到 −Infinity，整次研究被一个点带崩。
//
// 数值：
//   · erfc —— W. J. Cody, "Rational Chebyshev approximations for the error function",
//     Math. Comp. 23 (1969) 631–637；三段有理逼近，双精度全域相对误差 ~1e-16。
//   · Φ⁻¹ —— M. J. Wichura, "Algorithm AS 241: The percentage points of the normal distribution",
//     Applied Statistics 37 (1988) 477–484（PPND16）；相对误差 ~1e-16，无需再做牛顿修正。
//   · 截断正态整段在均值上方时改用生存函数 Q(z) = Φ(−z) 计算：α = 9 时 Φ(α) 已舍入成 1，
//     照 Φ⁻¹(Φ(α) + u·(Φ(β) − Φ(α))) 直算会整段退化成常数。
//
// 相关性：Iman & Conover, "A distribution-free approach to inducing rank correlation among input
// variables", Commun. Statist. – Simul. Comput. 11(3) (1982) 311–334。只重排各列的行序，不改任何一列的取值，
// 所以边缘分布（以及 LHS 的分层）原样保留。目标缺省按 Spearman 秩相关解释，见 imanConover 头注。

import { childRng, permutation, DEFAULT_SEED } from './rng.mjs'
import { cholesky, invLower, matMul } from './linalg.mjs'

/** 设计 → 分布映射前 u 的夹紧下限（= 32 位格距的一半），上限为 1 − UNIT_EPS。 */
export const UNIT_EPS = 2 ** -33

/** 把 u 夹进 [UNIT_EPS, 1 − UNIT_EPS]（NaN 原样返回）。 */
export function clampUnitOpen(u) {
  return u < UNIT_EPS ? UNIT_EPS : u > 1 - UNIT_EPS ? 1 - UNIT_EPS : u
}

// ───────────────────────── 误差函数与标准正态 ─────────────────────────

// Cody (1969) 系数：A/B 用于 |x| ≤ 0.46875 的 erf，C/D 用于 0.46875 < |x| ≤ 4 的 erfc，P/Q 用于 |x| > 4。
const ERF_A = [3.16112374387056560e00, 1.13864154151050156e02, 3.77485237685302021e02, 3.20937758913846947e03, 1.85777706184603153e-1]
const ERF_B = [2.36012909523441209e01, 2.44024637934444173e02, 1.28261652607737228e03, 2.84423683343917062e03]
const ERF_C = [5.64188496988670089e-1, 8.88314979438837594e00, 6.61191906371416295e01, 2.98635138197400131e02,
  8.81952221241769090e02, 1.71204761263407058e03, 2.05107837782607147e03, 1.23033935479799725e03, 2.15311535474403846e-8]
const ERF_D = [1.57449261107098347e01, 1.17693950891312499e02, 5.37181101862009858e02, 1.62138957456669019e03,
  3.29079923573345963e03, 4.36261909014324716e03, 3.43936767414372164e03, 1.23033935480374942e03]
const ERF_P = [3.05326634961232344e-1, 3.60344899949804439e-1, 1.25781726111229246e-1, 1.60837851487422766e-2,
  6.58749161529837803e-4, 1.63153871373020978e-2]
const ERF_Q = [2.56852019228982242e00, 1.87295284992346725e00, 5.27905102951428412e-1, 6.05183413124413191e-2, 2.33520497626869185e-3]
const INV_SQRT_PI = 5.6418958354775628695e-1
const INV_SQRT_2PI = 0.3989422804014327

/** exp(−y²)，拆成 exp(−ŷ²)·exp(−(y−ŷ)(y+ŷ))，ŷ = y 截到 1/16 的整数倍：y² 的舍入误差不再被 exp 放大（Cody 原法）。 */
function expNegSq(y) {
  const ys = Math.trunc(y * 16) / 16
  return Math.exp(-ys * ys) * Math.exp(-(y - ys) * (y + ys))
}

/** 互补误差函数 erfc(x)。 */
export function erfc(x) {
  if (Number.isNaN(x)) return NaN
  const y = Math.abs(x)
  if (y === Infinity) return x < 0 ? 2 : 0         // expNegSq(∞) 里有 ∞ − ∞，单独处理
  if (y <= 0.46875) {
    const z = y > 1.11e-16 ? y * y : 0
    let num = ERF_A[4] * z, den = z
    for (let i = 0; i < 3; i++) { num = (num + ERF_A[i]) * z; den = (den + ERF_B[i]) * z }
    return 1 - x * (num + ERF_A[3]) / (den + ERF_B[3])
  }
  let r
  if (y <= 4) {
    let num = ERF_C[8] * y, den = y
    for (let i = 0; i < 7; i++) { num = (num + ERF_C[i]) * y; den = (den + ERF_D[i]) * y }
    r = (num + ERF_C[7]) / (den + ERF_D[7]) * expNegSq(y)
  } else {                                      // y ≳ 26.5 起结果进入次正规数区，y ≳ 27.3 下溢为 0（不必单独截断）
    const z = 1 / (y * y)
    let num = ERF_P[5] * z, den = z
    for (let i = 0; i < 4; i++) { num = (num + ERF_P[i]) * z; den = (den + ERF_Q[i]) * z }
    r = (INV_SQRT_PI - z * (num + ERF_P[4]) / (den + ERF_Q[4])) / y * expNegSq(y)
  }
  return x < 0 ? 2 - r : r
}

/** 标准正态密度 φ(x) */
export function stdNormalPdf(x) {
  return INV_SQRT_2PI * Math.exp(-0.5 * x * x)
}

/** 标准正态 CDF Φ(x)。下尾有完整相对精度；上尾请用 stdNormalSf。 */
export function stdNormalCdf(x) {
  return 0.5 * erfc(-x / Math.SQRT2)
}

/** 标准正态生存函数 Q(x) = 1 − Φ(x) = Φ(−x)，上尾有完整相对精度。 */
export function stdNormalSf(x) {
  return 0.5 * erfc(x / Math.SQRT2)
}

// Wichura (1988) AS 241 PPND16 系数（分子 / 分母多项式，低次在前）。
const PPND_A = [3.3871328727963666080e0, 1.3314166789178437745e+2, 1.9715909503065514427e+3, 1.3731693765509461125e+4,
  4.5921953931549871457e+4, 6.7265770927008700853e+4, 3.3430575583588128105e+4, 2.5090809287301226727e+3]
const PPND_B = [1, 4.2313330701600911252e+1, 6.8718700749205790830e+2, 5.3941960214247511077e+3,
  2.1213794301586595867e+4, 3.9307895800092710610e+4, 2.8729085735721942674e+4, 5.2264952788528545610e+3]
const PPND_C = [1.42343711074968357734e0, 4.63033784615654529590e0, 5.76949722146069140550e0, 3.64784832476320460504e0,
  1.27045825245236838258e0, 2.41780725177450611770e-1, 2.27238449892691845833e-2, 7.74545014278341407640e-4]
const PPND_D = [1, 2.05319162663775882187e0, 1.67638483018380384940e0, 6.89767334985100004550e-1,
  1.48103976427480074590e-1, 1.51986665636164571966e-2, 5.47593808499534494600e-4, 1.05075007164441684324e-9]
const PPND_E = [6.65790464350110377720e0, 5.46378491116411436990e0, 1.78482653991729133580e0, 2.96560571828504891230e-1,
  2.65321895265761230930e-2, 1.24266094738807843860e-3, 2.71155556874348757815e-5, 2.01033439929228813265e-7]
const PPND_F = [1, 5.99832206555887937690e-1, 1.36929880922735805310e-1, 1.48753612908506148525e-2,
  7.86869131145613259100e-4, 1.84631831751005468180e-5, 1.42151175831644588870e-7, 2.04426310338993978564e-15]

/** Horner：c 低次在前 */
function poly(c, x) {
  let s = c[c.length - 1]
  for (let i = c.length - 2; i >= 0; i--) s = s * x + c[i]
  return s
}

/** 标准正态分位 Φ⁻¹(p)（AS 241）。p ≤ 0 → −Infinity，p ≥ 1 → +Infinity。 */
export function stdNormalPpf(p) {
  if (Number.isNaN(p)) return NaN
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const q = p - 0.5
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q
    return q * poly(PPND_A, r) / poly(PPND_B, r)
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p))   // p ≥ 0.5 时 1 − p 无舍入（Sterbenz）
  let x
  if (r <= 5) { r -= 1.6; x = poly(PPND_C, r) / poly(PPND_D, r) } else { r -= 5; x = poly(PPND_E, r) / poly(PPND_F, r) }
  return q < 0 ? -x : x
}

/** 由任一 [0,1) 均匀源造标准正态源：一个 u 出一个 z（逆 CDF，|z| ≤ 6.4）。 */
export function normalSampler(rng) {
  return () => stdNormalPpf(clampUnitOpen(rng()))
}

// ───────────────────────── 分布 ─────────────────────────

/** 表单来的值可能是字符串：空串不许悄悄变成 0。 */
function toNum(v) {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return NaN
}
const isFin = Number.isFinite

function need(cond, msg) {
  if (!cond) throw new Error(`分布参数无效：${msg}`)
}

/** 最大的 i 使 arr[i] ≤ x（无则 −1）；arr 升序 */
function lastLE(arr, x) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] <= x) lo = m + 1; else hi = m }
  return lo - 1
}

/** 最小的 j 使 arr[j] ≥ x（无则 arr.length）；arr 升序 */
function firstGE(arr, x) {
  let lo = 0, hi = arr.length
  while (lo < hi) { const m = (lo + hi) >>> 1; if (arr[m] < x) lo = m + 1; else hi = m }
  return lo
}

function finish(type, params, ppf, cdf, mean, variance, lower, upper) {
  return Object.freeze({ type, params: Object.freeze(params), ppf, cdf, mean, sd: Math.sqrt(Math.max(0, variance)), lower, upper })
}

function uniformDist(s) {
  const a = toNum(s.lower), b = toNum(s.upper)
  need(isFin(a) && isFin(b) && a < b, 'uniform 需要有限的 lower < upper')
  const w = b - a
  return finish('uniform', { lower: a, upper: b },
    (u) => (u <= 0 ? a : u >= 1 ? b : Math.min(b, a + u * w)),
    (x) => (x <= a ? 0 : x >= b ? 1 : (x - a) / w),
    (a + b) / 2, w * w / 12, a, b)
}

function normalDist(s) {
  const mu = toNum(s.mu), sigma = toNum(s.sigma)
  need(isFin(mu) && isFin(sigma) && sigma > 0, 'normal 需要有限的 mu 与 sigma > 0')
  return finish('normal', { mu, sigma },
    (u) => mu + sigma * stdNormalPpf(u),
    (x) => stdNormalCdf((x - mu) / sigma),
    mu, sigma * sigma, -Infinity, Infinity)
}

function truncNormalDist(s) {
  const mu = toNum(s.mu), sigma = toNum(s.sigma)
  const lo = s.lower == null ? -Infinity : toNum(s.lower)
  const hi = s.upper == null ? Infinity : toNum(s.upper)
  need(isFin(mu) && isFin(sigma) && sigma > 0, 'truncnormal 需要有限的 mu 与 sigma > 0')
  need(!Number.isNaN(lo) && !Number.isNaN(hi) && lo < hi, 'truncnormal 需要 lower < upper')
  const a = (lo - mu) / sigma, b = (hi - mu) / sigma
  const flip = a > 0                              // 整段在均值上方 → 用生存函数
  const Fa = flip ? stdNormalSf(a) : stdNormalCdf(a)
  const Fb = flip ? stdNormalSf(b) : stdNormalCdf(b)
  const Z = flip ? Fa - Fb : Fb - Fa
  need(Z > 0, 'truncnormal 截断区间离均值太远，区间内的概率质量已下溢（|z| > 37）')
  const clampX = (x) => (x < lo ? lo : x > hi ? hi : x)
  const ppf = flip
    ? (u) => (u <= 0 ? lo : u >= 1 ? hi : clampX(mu - sigma * stdNormalPpf(Fa - u * Z)))   // Q⁻¹(s) = −Φ⁻¹(s)
    : (u) => (u <= 0 ? lo : u >= 1 ? hi : clampX(mu + sigma * stdNormalPpf(Fa + u * Z)))
  const cdf = (x) => {
    if (x <= lo) return 0
    if (x >= hi) return 1
    const z = (x - mu) / sigma
    return Math.min(1, Math.max(0, flip ? (Fa - stdNormalSf(z)) / Z : (stdNormalCdf(z) - Fa) / Z))
  }
  const pa = isFin(a) ? stdNormalPdf(a) : 0, pb = isFin(b) ? stdNormalPdf(b) : 0
  const m1 = (pa - pb) / Z
  const m2 = ((isFin(a) ? a * pa : 0) - (isFin(b) ? b * pb : 0)) / Z
  return finish('truncnormal', { mu, sigma, lower: lo, upper: hi }, ppf, cdf,
    mu + sigma * m1, sigma * sigma * (1 + m2 - m1 * m1), lo, hi)
}

function triangularDist(s) {
  const a = toNum(s.lower), c = toNum(s.mode), b = toNum(s.upper)
  need(isFin(a) && isFin(b) && isFin(c) && a < b && a <= c && c <= b, 'triangular 需要 lower ≤ mode ≤ upper 且 lower < upper')
  const w = b - a, fc = (c - a) / w
  return finish('triangular', { lower: a, mode: c, upper: b },
    (u) => (u <= 0 ? a : u >= 1 ? b : u < fc ? a + Math.sqrt(u * w * (c - a)) : b - Math.sqrt((1 - u) * w * (b - c))),
    (x) => (x <= a ? 0 : x >= b ? 1 : x <= c ? (x - a) * (x - a) / (w * (c - a)) : 1 - (b - x) * (b - x) / (w * (b - c))),
    (a + b + c) / 3, (a * a + b * b + c * c - a * b - a * c - b * c) / 18, a, b)
}

function lognormalDist(s) {
  let mu, sigma
  if (s.mu != null || s.sigma != null) {
    mu = toNum(s.mu); sigma = toNum(s.sigma)
  } else {
    const m = toNum(s.mean), sd = toNum(s.sd)
    need(isFin(m) && isFin(sd) && m > 0 && sd > 0, 'lognormal 需要 { mu, sigma } 或 { mean > 0, sd > 0 }')
    sigma = Math.sqrt(Math.log1p((sd / m) * (sd / m)))
    mu = Math.log(m) - sigma * sigma / 2
  }
  need(isFin(mu) && isFin(sigma) && sigma > 0, 'lognormal 需要有限的 mu 与 sigma > 0')
  const mean = Math.exp(mu + sigma * sigma / 2)
  return finish('lognormal', { mu, sigma },
    (u) => (u <= 0 ? 0 : Math.exp(mu + sigma * stdNormalPpf(u))),
    (x) => (x <= 0 ? 0 : stdNormalCdf((Math.log(x) - mu) / sigma)),
    mean, mean * mean * Math.expm1(sigma * sigma), 0, Infinity)
}

function empiricalSamplesDist(s) {
  const xs = Float64Array.from(s.samples, toNum).sort()
  const n = xs.length
  need(n >= 1 && xs.every(isFin), 'empirical 的 samples 须为非空有限数组')
  const interp = s.interp || 'linear'
  need(interp === 'linear' || interp === 'step', `empirical 的 interp 只能是 'linear' 或 'step'：${interp}`)
  const params = { samples: Array.from(xs), interp }
  if (interp === 'step') {
    let m = 0
    for (const x of xs) m += x
    m /= n
    let v = 0
    for (const x of xs) v += (x - m) * (x - m)
    return finish('empirical', params,
      (u) => xs[Math.min(n - 1, Math.max(0, Math.ceil(u * n) - 1))],
      (x) => (lastLE(xs, x) + 1) / n,
      m, v / n, xs[0], xs[n - 1])
  }
  // type-7 分位（numpy / R 缺省）：顶点 (xs[i], i/(n−1)) 之间分段线性
  let m = 0, e2 = 0
  for (let i = 0; i + 1 < n; i++) {
    const p = xs[i], q = xs[i + 1]
    m += (p + q) / 2; e2 += (p * p + p * q + q * q) / 3
  }
  if (n > 1) { m /= n - 1; e2 /= n - 1 } else { m = xs[0]; e2 = m * m }
  return finish('empirical', params,
    (u) => {
      if (n === 1 || u <= 0) return xs[0]
      const h = u * (n - 1), i = Math.floor(h)
      return i >= n - 1 ? xs[n - 1] : xs[i] + (h - i) * (xs[i + 1] - xs[i])
    },
    (x) => {
      if (x < xs[0]) return 0
      if (x >= xs[n - 1]) return 1
      const i = lastLE(xs, x)                     // xs[i] ≤ x < xs[i+1]
      return (i + (x - xs[i]) / (xs[i + 1] - xs[i])) / (n - 1)
    },
    m, e2 - m * m, xs[0], xs[n - 1])
}

function empiricalTableDist(s) {
  const x = Float64Array.from(s.x, toNum), p = Float64Array.from(s.p, toNum)
  const n = x.length
  need(n >= 2 && p.length === n, 'empirical 表格 CDF 需要等长的 x 与 p（≥ 2 个点）')
  need(x.every(isFin) && p.every(isFin), 'empirical 表格 CDF 的 x 与 p 须为有限数')
  for (let i = 1; i < n; i++) need(x[i] >= x[i - 1] && p[i] >= p[i - 1], 'empirical 表格 CDF 的 x 与 p 须单调不减')
  need(Math.abs(p[0]) <= 1e-9 && Math.abs(p[n - 1] - 1) <= 1e-9, 'empirical 表格 CDF 须从 p = 0 起、到 p = 1 止')
  p[0] = 0; p[n - 1] = 1
  const j0 = lastLE(p, 0)                          // 支撑下界：最后一个 p = 0 的点
  const j1 = firstGE(p, 1)                         // 支撑上界：第一个 p = 1 的点
  let m = 0, e2 = 0
  for (let i = 0; i + 1 < n; i++) {
    const dp = p[i + 1] - p[i]
    if (dp <= 0) continue
    const a = x[i], b = x[i + 1]
    m += dp * (a + b) / 2; e2 += dp * (a * a + a * b + b * b) / 3
  }
  return finish('empirical', { x: Array.from(x), p: Array.from(p) },
    (u) => {
      if (u <= 0) return x[j0]
      if (u >= 1) return x[j1]
      const j = firstGE(p, u)                     // p[j−1] < u ≤ p[j]，j ≥ 1
      return x[j - 1] + (u - p[j - 1]) / (p[j] - p[j - 1]) * (x[j] - x[j - 1])
    },
    (v) => {
      if (v < x[0]) return 0
      if (v >= x[n - 1]) return 1
      const i = lastLE(x, v)                      // x[i] ≤ v < x[i+1]
      return p[i] + (v - x[i]) / (x[i + 1] - x[i]) * (p[i + 1] - p[i])
    },
    m, e2 - m * m, x[j0], x[j1])
}

function discreteDist(s) {
  const vals = Array.from(s.values || [], toNum)
  const n = vals.length
  need(n >= 1 && vals.every(isFin), 'discrete 的 values 须为非空有限数组')
  const w = s.weights == null ? vals.map(() => 1) : Array.from(s.weights, toNum)
  need(w.length === n && w.every((x) => isFin(x) && x >= 0), 'discrete 的 weights 须与 values 等长且非负')
  const order = vals.map((_, i) => i).sort((i, j) => vals[i] - vals[j] || i - j)
  const v = Float64Array.from(order, (i) => vals[i])
  const wt = Float64Array.from(order, (i) => w[i])
  const total = wt.reduce((a, b) => a + b, 0)
  need(total > 0 && isFin(total), 'discrete 的 weights 之和须为正')
  const cum = new Float64Array(n)
  let acc = 0, first = -1, last = -1
  for (let i = 0; i < n; i++) {
    acc += wt[i]; cum[i] = acc / total
    if (wt[i] > 0) { if (first < 0) first = i; last = i }
  }
  for (let i = last; i < n; i++) cum[i] = 1           // 累加舍入不许让 u→1 落空
  let m = 0, e2 = 0
  for (let i = 0; i < n; i++) { const q = wt[i] / total; m += q * v[i]; e2 += q * v[i] * v[i] }
  return finish('discrete', { values: Array.from(v), weights: Array.from(wt, (x) => x / total) },
    (u) => (u <= 0 ? v[first] : v[Math.min(last, firstGE(cum, u))]),
    (x) => { const i = lastLE(v, x); return i < 0 ? 0 : cum[i] },
    m, e2 - m * m, v[first], v[last])
}

/**
 * 编译分布规格。已编译的对象原样返回（可反复传）。
 * @param {object} spec  见文件头的规格表
 * @returns {{type:string, params:object, ppf:(u:number)=>number, cdf:(x:number)=>number, mean:number, sd:number, lower:number, upper:number}}
 */
export function makeDist(spec) {
  if (spec && typeof spec.ppf === 'function' && typeof spec.cdf === 'function') return spec
  const type = spec && spec.type
  switch (type) {
    case 'uniform': return uniformDist(spec)
    case 'normal': return normalDist(spec)
    case 'truncnormal': return truncNormalDist(spec)
    case 'triangular': return triangularDist(spec)
    case 'lognormal': return lognormalDist(spec)
    case 'empirical':
      if (spec.samples != null) return empiricalSamplesDist(spec)
      if (spec.x != null && spec.p != null) return empiricalTableDist(spec)
      throw new Error('分布参数无效：empirical 需要 samples，或成对的 x 与 p')
    case 'discrete': return discreteDist(spec)
    default: throw new Error(`未知分布类型：${type}`)
  }
}

/**
 * 单位超立方体上的设计 → 各参数的取值。每行逐列 ppf(clampUnitOpen(u))。
 * @param {ArrayLike<number>[]} U  n 行 × k 列，取值 [0,1]
 * @param {Array<object>} dists    k 个分布（规格或 makeDist 的结果）
 * @returns {number[][]}
 */
export function mapUnit(U, dists) {
  const D = dists.map(makeDist)
  const k = D.length
  return Array.from(U, (row, i) => {
    if (row.length !== k) throw new Error(`第 ${i} 行有 ${row.length} 列，分布有 ${k} 个`)
    const out = new Array(k)
    for (let j = 0; j < k; j++) out[j] = D[j].ppf(clampUnitOpen(row[j]))
    return out
  })
}

/**
 * 独立蒙特卡洛抽样（逆 CDF），可选 Iman–Conover 施加秩相关。
 * 要 LHS / Sobol 撒点的，用 designs.mjs 出单位设计再 mapUnit（相关性同样可接 imanConover）。
 * @param {Array<object>} dists
 * @param {number} n
 * @param {{seed?:number, corr?:number[][], corrType?:'spearman'|'normal-scores'}} [opt]
 */
export function sampleDists(dists, n, opt = {}) {
  const k = dists.length
  const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'sample-dists')
  const U = Array.from({ length: n }, () => { const r = new Array(k); for (let j = 0; j < k; j++) r[j] = rng(); return r })
  const X = mapUnit(U, dists)
  return opt.corr ? imanConover(X, opt.corr, { seed: opt.seed, corrType: opt.corrType }) : X
}

// ───────────────────────── 相关性 ─────────────────────────

/** 平均秩（1 起），结用平均秩。 */
export function ranks(values) {
  const n = values.length
  const idx = Array.from({ length: n }, (_, i) => i).sort((i, j) => values[i] - values[j] || i - j)
  const r = new Float64Array(n)
  for (let s = 0; s < n;) {
    let e = s
    while (e + 1 < n && values[idx[e + 1]] === values[idx[s]]) e++
    const avg = (s + e) / 2 + 1
    for (let t = s; t <= e; t++) r[idx[t]] = avg
    s = e + 1
  }
  return r
}

/** 各列（Float64Array）两两的 Pearson 相关阵 */
function corrOfColumns(cols) {
  const k = cols.length, n = k ? cols[0].length : 0
  const dev = cols.map((c) => {
    let m = 0
    for (let i = 0; i < n; i++) m += c[i]
    m /= n
    const d = new Float64Array(n)
    let ss = 0
    for (let i = 0; i < n; i++) { d[i] = c[i] - m; ss += d[i] * d[i] }
    return { d, norm: Math.sqrt(ss) }
  })
  const C = Array.from({ length: k }, () => new Float64Array(k))
  for (let a = 0; a < k; a++) {
    C[a][a] = 1
    for (let b = a + 1; b < k; b++) {
      let s = 0
      const da = dev[a].d, db = dev[b].d
      for (let i = 0; i < n; i++) s += da[i] * db[i]
      C[a][b] = C[b][a] = s / (dev[a].norm * dev[b].norm)
    }
  }
  return C
}

function columns(X) {
  const k = X[0].length
  return Array.from({ length: k }, (_, j) => Float64Array.from(X, (row) => toNum(row[j])))
}

/** 样本（n 行 × k 列）的 Pearson 相关阵 */
export function pearsonMatrix(X) {
  return corrOfColumns(columns(X))
}

/** 样本（n 行 × k 列）的 Spearman 秩相关阵（结取平均秩） */
export function spearmanMatrix(X) {
  return corrOfColumns(columns(X).map(ranks))
}

/**
 * Iman–Conover：重排各列的行序，使样本的秩相关逼近目标阵。
 *
 * 步骤（原文 §3）：
 *   ① 得分阵 R（n×k）：每列是 van der Waerden 得分 Φ⁻¹(i/(n+1)) 的一个独立随机排列；
 *   ② T = corr(R) = Q·Qᵀ，目标 C* = P·Pᵀ（Cholesky），R* = R·(P·Q⁻¹)ᵀ ——
 *      用样本相关 T 而不是 I 去「白化」，R* 的 Pearson 相关恰为 C*（不带抽样误差）；
 *   ③ X 的第 j 列按 R* 第 j 列的秩重排：X* 与 R* 各列同秩，于是 X* 的秩相关 = R* 的秩相关。
 *
 * corrType：
 *   'spearman'（缺省）—— corr 是目标 Spearman 秩相关 ρ_S。正态得分的 Pearson ρ 与其秩相关满足
 *     ρ_S = (6/π)·arcsin(ρ/2)，故先换成 ρ = 2·sin(π·ρ_S/6) 再做 ②；不换的话 ρ_S = 0.5 只能得到约 0.483。
 *   'normal-scores' —— corr 直接作为得分阵的 Pearson 相关（Iman–Conover 原文口径）。
 *
 * 只重排、不改值：各列取值的多重集合不变，边缘分布与 LHS 分层原样保留。
 *
 * @param {ArrayLike<number>[]} X  n 行 × k 列
 * @param {ArrayLike<number>[]} corr  k×k 对称、对角为 1、正定
 * @param {{seed?:number, corrType?:'spearman'|'normal-scores'}} [opt]
 * @returns {number[][]} 新的 n 行
 */
export function imanConover(X, corr, opt = {}) {
  const n = X.length
  if (!(n >= 2)) throw new Error('Iman–Conover 至少需要 2 行样本')
  const k = X[0].length
  if (!corr || corr.length !== k || Array.from(corr).some((r) => !r || r.length !== k)) {
    throw new Error(`目标相关阵须为 ${k}×${k}`)
  }
  const type = opt.corrType || 'spearman'
  if (type !== 'spearman' && type !== 'normal-scores') throw new Error(`corrType 只能是 'spearman' 或 'normal-scores'：${type}`)
  const target = Array.from({ length: k }, () => new Float64Array(k))
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const c = toNum(corr[i][j])
      if (!isFin(c) || Math.abs(c) > 1) throw new Error(`目标相关阵元素须在 [−1, 1]：(${i}, ${j}) = ${corr[i][j]}`)
      if (i === j && Math.abs(c - 1) > 1e-12) throw new Error(`目标相关阵对角须为 1：(${i}, ${i}) = ${c}`)
      if (j < i && Math.abs(c - toNum(corr[j][i])) > 1e-12) throw new Error(`目标相关阵须对称：(${i}, ${j})`)
      target[i][j] = i === j ? 1 : type === 'spearman' ? 2 * Math.sin(Math.PI * c / 6) : c
    }
  }
  const P = cholesky(target)
  if (!P) throw new Error('目标相关阵非正定')
  if (!(n > k)) throw new Error(`Iman–Conover 需要样本数 n（${n}）> 变量数 k（${k}）`)
  const cols = columns(X)
  for (let j = 0; j < k; j++) if (!cols[j].every(isFin)) throw new Error(`第 ${j} 列含非有限值`)

  const scores = Float64Array.from({ length: n }, (_, i) => stdNormalPpf((i + 1) / (n + 1)))
  const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'iman-conover')
  const R = Array.from({ length: k }, () => {
    const perm = permutation(rng, n)
    return Float64Array.from(perm, (p) => scores[p])
  })
  const Q = cholesky(corrOfColumns(R))
  if (!Q) throw new Error('得分阵的样本相关阵非正定（样本太少或退化）')
  const S = matMul(P, invLower(Q))                // 下三角
  const out = Array.from(X, (row) => Array.from(row, toNum))
  const rs = new Float64Array(n)
  for (let j = 0; j < k; j++) {
    rs.fill(0)
    for (let m = 0; m <= j; m++) {
      const s = S[j][m]
      if (s === 0) continue
      const Rm = R[m]
      for (let i = 0; i < n; i++) rs[i] += s * Rm[i]
    }
    const order = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => rs[a] - rs[b] || a - b)
    const sorted = cols[j].slice().sort()
    for (let m = 0; m < n; m++) out[order[m]][j] = sorted[m]
  }
  return out
}
