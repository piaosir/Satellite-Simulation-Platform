// NTN 信道库共用的数值底座（纯函数，CommonJS，无依赖）。
//
// 只放 tr38811 / p681 / p682 / p372 都要用、且标准里不给现成数值的那几样：
//   误差函数与正态分布（含反函数）、指数缩放的修正贝塞尔函数 I0、莱斯（Nakagami-Rice）包络 CDF、
//   Gauss–Legendre 求积、Brent 求根。
// 全部按教科书定义从头写（级数 / 连分式 / 牛顿迭代），不搬第三方代码，便于对照公式审查。
//
// 精度目标：erf / 正态 CDF 相对误差 ~1e-15；正态反函数经 Halley 精修到机器精度；
// 莱斯 CDF 绝对误差 < 1e-10（单元测试用 Marcum Q 的三条恒等式核对）。

const SQRT2 = Math.SQRT2
const SQRT_PI = Math.sqrt(Math.PI)
const SQRT_2PI = Math.sqrt(2 * Math.PI)

// erfc 的连分式（修正 Lentz 法），x ≥ 2 时收敛很快：
//   erfc x = e^(−x²)/√π · 1/(x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + …)))))
function erfcCF(x) {
  const tiny = 1e-300
  let f = x, C = x, D = 0
  for (let k = 1; k < 1000; k++) {
    const ak = k / 2
    D = x + ak * D
    if (D === 0) D = tiny
    D = 1 / D
    C = x + ak / C
    if (C === 0) C = tiny
    const delta = C * D
    f *= delta
    if (Math.abs(delta - 1) < 1e-16) break
  }
  return Math.exp(-x * x) / SQRT_PI / f
}

// |x| < 2.5 用全正项级数 erf x = (2/√π)·e^(−x²)·Σ 2ⁿx^(2n+1)/(1·3·…·(2n+1))，没有相消误差。
function erfSeries(ax) {
  const x2 = 2 * ax * ax
  let term = ax, sum = ax
  for (let n = 1; n < 500; n++) {
    term *= x2 / (2 * n + 1)
    sum += term
    if (term < 1e-17 * sum) break
  }
  return 2 / SQRT_PI * Math.exp(-ax * ax) * sum
}

function erf(x) {
  if (Number.isNaN(x)) return NaN
  const ax = Math.abs(x)
  const r = ax < 2.5 ? erfSeries(ax) : 1 - erfcCF(ax)
  return x < 0 ? -r : r
}

function erfc(x) {
  if (Number.isNaN(x)) return NaN
  if (x >= 2.5) return erfcCF(x)
  if (x <= -2.5) return 2 - erfcCF(-x)
  return 1 - erf(x)
}

const normPdf = (z) => Math.exp(-0.5 * z * z) / SQRT_2PI
// Φ(z) = ½·erfc(−z/√2)：左尾用 erfc 直接算，z = −10 时仍有完整相对精度
const normCdf = (z) => 0.5 * erfc(-z / SQRT2)

// 标准正态分位数 Φ⁻¹(p)。初值用 Acklam 有理逼近（相对误差 ~1e-9），再做 Halley 迭代精修到机器精度；
// 初值哪怕差个 1e-3 也会被迭代拉回来，所以结果不依赖初值系数的每一位。
const AK_A = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
const AK_B = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
const AK_C = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
const AK_D = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
function normInv(p) {
  if (Number.isNaN(p) || p < 0 || p > 1) return NaN
  if (p === 0) return -Infinity
  if (p === 1) return Infinity
  const pl = 0.02425
  let x
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((AK_C[0] * q + AK_C[1]) * q + AK_C[2]) * q + AK_C[3]) * q + AK_C[4]) * q + AK_C[5]) /
      ((((AK_D[0] * q + AK_D[1]) * q + AK_D[2]) * q + AK_D[3]) * q + 1)
  } else if (p <= 1 - pl) {
    const q = p - 0.5, r = q * q
    x = (((((AK_A[0] * r + AK_A[1]) * r + AK_A[2]) * r + AK_A[3]) * r + AK_A[4]) * r + AK_A[5]) * q /
      (((((AK_B[0] * r + AK_B[1]) * r + AK_B[2]) * r + AK_B[3]) * r + AK_B[4]) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    x = -(((((AK_C[0] * q + AK_C[1]) * q + AK_C[2]) * q + AK_C[3]) * q + AK_C[4]) * q + AK_C[5]) /
      ((((AK_D[0] * q + AK_D[1]) * q + AK_D[2]) * q + AK_D[3]) * q + 1)
  }
  for (let it = 0; it < 6; it++) {
    // 残差 e = Φ(x) − p；上尾改写成 (1−p) − Φ(−x)，免得 p→1 时相减丢精度
    const e = p > 0.5 ? (1 - p) - normCdf(-x) : normCdf(x) - p
    const u = e * SQRT_2PI * Math.exp(x * x / 2)
    const dx = u / (1 + x * u / 2)
    x -= dx
    if (Math.abs(dx) <= 1e-15 * Math.max(1, Math.abs(x))) break
  }
  return x
}

// erf⁻¹(y) = Φ⁻¹((y+1)/2)/√2，y ∈ (−1, 1)
const erfInv = (y) => normInv((y + 1) / 2) / SQRT2

// 指数缩放的零阶第一类修正贝塞尔函数 I0e(x) = e^(−|x|)·I0(x)。
// |x| ≤ 15：幂级数 Σ (x²/4)^k/(k!)²（全正项）；|x| > 15：渐近级数
//   I0(x) ~ eˣ/√(2πx)·Σ ((2k−1)!!)²/(k!(8x)^k)，项开始变大即截断（x>15 时可到 ~1e-13）。
function besselI0e(x) {
  const ax = Math.abs(x)
  if (ax <= 15) {
    const y = ax * ax / 4
    let term = 1, sum = 1
    for (let k = 1; k < 200; k++) {
      term *= y / (k * k)
      sum += term
      if (term < 1e-17 * sum) break
    }
    return sum * Math.exp(-ax)
  }
  const z8 = 8 * ax
  let term = 1, sum = 1
  for (let k = 1; k < 80; k++) {
    const next = term * (2 * k - 1) * (2 * k - 1) / (k * z8)
    if (next >= term) break
    term = next
    sum += term
    if (term < 1e-17 * sum) break
  }
  return sum / Math.sqrt(2 * Math.PI * ax)
}

// ===== Gauss–Legendre 节点（牛顿迭代求 Legendre 多项式零点，按 n 缓存）=====
const GL_CACHE = new Map()
function gaussLegendre(n) {
  if (GL_CACHE.has(n)) return GL_CACHE.get(n)
  const x = new Float64Array(n), w = new Float64Array(n)
  const m = Math.floor((n + 1) / 2)
  for (let i = 0; i < m; i++) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), pp = 0
    for (let it = 0; it < 100; it++) {
      let p1 = 1, p2 = 0
      for (let j = 0; j < n; j++) {
        const p3 = p2
        p2 = p1
        p1 = ((2 * j + 1) * z * p2 - j * p3) / (j + 1)
      }
      pp = n * (z * p1 - p2) / (z * z - 1)
      const z1 = z
      z = z1 - p1 / pp
      if (Math.abs(z - z1) < 1e-15) {
        // 用收敛后的 z 再算一次导数，权重才准
        let q1 = 1, q2 = 0
        for (let j = 0; j < n; j++) {
          const q3 = q2
          q2 = q1
          q1 = ((2 * j + 1) * z * q2 - j * q3) / (j + 1)
        }
        pp = n * (z * q1 - q2) / (z * z - 1)
        break
      }
    }
    x[i] = -z
    x[n - 1 - i] = z
    w[i] = w[n - 1 - i] = 2 / ((1 - z * z) * pp * pp)
  }
  const r = { x, w }
  GL_CACHE.set(n, r)
  return r
}

// 分段 Gauss–Legendre：在 [a, b] 上按断点切段，每段 n 点。断点落在区间外的自动忽略。
// 被积函数有已知的陡变位置（例如莱斯核在 a ≈ x0 处的台阶）时，把它放进 breaks 就能稳稳积准。
function integrate(f, a, b, n, breaks) {
  if (!(b > a)) return 0
  const pts = [a]
  if (breaks) {
    for (const t of breaks.slice().sort((u, v) => u - v)) if (t > a && t < b && t > pts[pts.length - 1]) pts.push(t)
  }
  pts.push(b)
  const { x, w } = gaussLegendre(n || 16)
  let s = 0
  for (let k = 0; k + 1 < pts.length; k++) {
    const lo = pts[k], hi = pts[k + 1]
    const c = (hi + lo) / 2, h = (hi - lo) / 2
    let sk = 0
    for (let i = 0; i < x.length; i++) sk += w[i] * f(c + h * x[i])
    s += sk * h
  }
  return s
}

// ===== 莱斯包络 CDF：P(|a + n| ≤ x0)，n ~ CN(0, P)，P = 2σ² 为漫射（多径）功率 =====
// 等价于 1 − Q1(a/σ, x0/σ)（Marcum Q）。归一化到 σ 单位后对密度
//   f(t) = t·exp(−(t−ν)²/2)·I0e(νt)，ν = a/σ
// 做分段 Gauss–Legendre（每段宽 2σ、10 点）；支撑取 [max(0, ν−10), ν+10]，段外质量 < e^(−50)。
function riceCdf(x0, a, P) {
  if (!(x0 > 0)) return 0
  if (!(P > 0)) return a <= x0 ? 1 : 0     // 无多径：直射分量是确定值
  const s = Math.sqrt(P / 2)
  const nu = Math.max(0, a) / s, b = x0 / s
  if (nu === 0) return -Math.expm1(-b * b / 2)   // 瑞利：闭式
  const lo = Math.max(0, nu - 10), hi = nu + 10
  if (b <= lo) return 0
  if (b >= hi) return 1
  const { x, w } = gaussLegendre(10)
  let sum = 0
  for (let t0 = lo; t0 < b; t0 += 2) {
    const t1 = Math.min(b, t0 + 2)
    const c = (t0 + t1) / 2, h = (t1 - t0) / 2
    let sk = 0
    for (let i = 0; i < 10; i++) {
      const t = c + h * x[i]
      const d = t - nu
      sk += w[i] * t * Math.exp(-0.5 * d * d) * besselI0e(nu * t)
    }
    sum += sk * h
  }
  return Math.min(1, Math.max(0, sum))
}

// Marcum Q1(α, β) = 1 − riceCdf(β, α, 2)（σ = 1 时 P = 2）
const marcumQ1 = (alpha, beta) => 1 - riceCdf(beta, alpha, 2)

// ===== Brent 求根（区间 [a, b] 两端异号；不异号返回 null）=====
function brentRoot(f, a, b, tol, maxIter) {
  const tolX = tol == null ? 1e-10 : tol
  let fa = f(a), fb = f(b)
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) return null
  if (fa === 0) return a
  if (fb === 0) return b
  if (fa * fb > 0) return null
  let c = a, fc = fa, d = b - a, e = d
  for (let it = 0; it < (maxIter || 200); it++) {
    if (fb * fc > 0) { c = a; fc = fa; d = b - a; e = d }
    if (Math.abs(fc) < Math.abs(fb)) { a = b; b = c; c = a; fa = fb; fb = fc; fc = fa }
    const tol1 = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolX
    const xm = 0.5 * (c - b)
    if (Math.abs(xm) <= tol1 || fb === 0) return b
    if (Math.abs(e) >= tol1 && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa
      let p, q
      if (a === c) {
        p = 2 * xm * s
        q = 1 - s
      } else {
        const qq = fa / fc, r = fb / fc
        p = s * (2 * xm * qq * (qq - r) - (b - a) * (r - 1))
        q = (qq - 1) * (r - 1) * (s - 1)
      }
      if (p > 0) q = -q
      else p = -p
      if (2 * p < Math.min(3 * xm * q - Math.abs(tol1 * q), Math.abs(e * q))) { e = d; d = p / q }
      else { d = xm; e = d }
    } else { d = xm; e = d }
    a = b
    fa = fb
    b += Math.abs(d) > tol1 ? d : (xm > 0 ? tol1 : -tol1)
    fb = f(b)
  }
  return b
}

// 有限数检查（拒绝 null / '' / NaN / ±Infinity；字符串数字接受）
function num(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const lin2db = (x) => 10 * Math.log10(x)
const db2lin = (d) => Math.pow(10, d / 10)

module.exports = {
  erf, erfc, erfInv, normPdf, normCdf, normInv, besselI0e,
  gaussLegendre, integrate, riceCdf, marcumQ1, brentRoot, num, lin2db, db2lin
}
