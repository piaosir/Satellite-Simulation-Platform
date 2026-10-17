// 参数研究 · 优化：Nelder–Mead、CMA-ES、NSGA-II，以及离散 / 整数变量的混合编码。
//
// 统一形态：每个算法的本体是一个生成器（*Steps），yield 一批待评估的点（number[][]，均为副本），
// 收回等长的评估结果，最后 return 结果对象。这样：
//   · 同步跑：runSync(steps, fn)；异步 / 并行跑（主进程 IPC、Worker 池）：await runAsync(steps, evalBatch)；
//   · 界面可以逐批推进、给进度、随时停（口径同 ciNgso 的 createRun / stepBatch / finalize 三段式）；
//   · CMA-ES 一代 λ 个、NSGA-II 一代 N 个整批交出去，评估端可以并行。
//
// 评估结果的形状：
//   单目标（Nelder–Mead / CMA-ES）：number。NaN、非数一律当 +Infinity（评估失败 = 最差），不中断优化。
//   多目标（NSGA-II）：number[]（全部最小化），或 { f: number[], g?: number[] }，g_j ≤ 0 为满足约束；
//     目标里有非有限值的个体按「违反量 = +Infinity」处理。
//
// 算法与参考文献：
//   · Nelder–Mead —— Nelder & Mead, Comput. J. 7 (1965) 308–313；收缩 / 收缩失败即整体收缩的分支按
//     Lagarias, Reeds, Wright & Wright, SIAM J. Optim. 9 (1998) 112–147；维数自适应系数按
//     Gao & Han, Comput. Optim. Appl. 51 (2012) 259–277（n = 2 时与标准系数相同）。
//   · CMA-ES —— N. Hansen, "The CMA Evolution Strategy: A Tutorial", arXiv:1604.00772 的 (μ/μ_w, λ)-CMA-ES，
//     只用正权重，参数取经典缺省：λ = 4 + ⌊3 ln n⌋，μ = ⌊λ/2⌋，w_i ∝ ln((λ+1)/2) − ln i，
//     c_σ = (μ_eff + 2)/(n + μ_eff + 5)，d_σ = 1 + 2·max(0, √((μ_eff − 1)/(n + 1)) − 1) + c_σ，
//     c_c = (4 + μ_eff/n)/(n + 4 + 2μ_eff/n)，c₁ = 2/((n + 1.3)² + μ_eff)，
//     c_μ = min(1 − c₁, 2(μ_eff − 2 + 1/μ_eff)/((n + 2)² + μ_eff))；终止判据按同文附录的 TolFun / TolX /
//     ConditionCov / TolUpSigma / NoEffectCoord；IPOP 重启：Auger & Hansen, CEC 2005 1769–1776（每次重启种群加倍）。
//   · NSGA-II —— Deb, Pratap, Agarwal & Meyarivan, IEEE TEC 6(2) (2002) 182–197：快速非支配排序、
//     拥挤距离、拥挤比较锦标赛、约束支配（原文的 constrained-domination：可行解支配不可行解，都不可行比违反量）；
//     变异算子用有界 SBX（Deb & Agrawal, Complex Systems 9 (1995) 115–148）与多项式变异（Deb & Goyal 1996）。
//
// 边界：
//   · Nelder–Mead：试探点投影回盒内。
//   · CMA-ES：在无界空间里搜索，评估前经 C¹ 连续的「线性–二次」周期映射落进盒内（Hansen 的 cma 库里
//     BoundTransform 的同类做法，这里按原理自行推导实现）；返回的 x 是映射后的盒内点。
//   · NSGA-II：变异与交叉本身就是有界的，结果截在盒内。
//
// 混合编码（makeSpace / mixedSteps）：real / int / ordinal / cat 四种变量统一编码到 [0,1]^k，
// 优化器只见连续量；解码时离散变量按等宽格取整（z 在第 j 格 ⇔ 取第 j 个水平）。离散维的重复点按解码值
// 去重缓存，不重复评估。CMA-ES 在离散维上给边际标准差设下限（opt.minStd；makeSpace().minStd() 缺省给格宽的 1/4），
// 免得分布塌缩在一个格子里再也跳不出去（思路同 Hamano et al., GECCO 2022 的 CMA-ES with Margin，
// 这里只取最简单的「下限」形式）。

import { DEFAULT_SEED, childRng, deriveSeed, shuffle } from './rng.mjs'
import { normalSampler } from './distributions.mjs'
import { symEigen } from './linalg.mjs'

// ───────────────────────── 驱动 ─────────────────────────

/**
 * 同步驱动：fn(x) 逐点求值。
 * @param {Generator<number[][], any, any[]>} steps
 * @param {(x:number[]) => any} fn
 */
export function runSync(steps, fn) {
  let r = steps.next()
  while (!r.done) r = steps.next(r.value.map((x) => fn(x)))
  return r.value
}

/**
 * 异步驱动：evalBatch(X) 整批求值（可并行），返回（或 resolve 成）等长数组。
 * @param {Generator<number[][], any, any[]>} steps
 * @param {(X:number[][]) => any[] | Promise<any[]>} evalBatch
 */
export async function runAsync(steps, evalBatch) {
  let r = steps.next()
  while (!r.done) r = steps.next(await evalBatch(r.value))
  return r.value
}

/** yield 一批并校验回来的结果长度 */
function* ask(X) {
  const F = yield X.map((x) => (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x) : x))
  if (!F || F.length !== X.length) throw new Error(`评估结果须为长度 ${X.length} 的数组，收到 ${F && F.length}`)
  return F
}

const objVal = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : Infinity)

function boxOf(n, lower, upper) {
  if (lower == null && upper == null) return null
  if (!lower || !upper || lower.length !== n || upper.length !== n) throw new Error(`边界 lower / upper 须同为长度 ${n} 的数组`)
  const lo = Float64Array.from(lower, Number), hi = Float64Array.from(upper, Number)
  for (let i = 0; i < n; i++) {
    if (!(lo[i] < hi[i])) throw new Error(`第 ${i} 维边界须满足 lower < upper：[${lower[i]}, ${upper[i]}]`)
  }
  return { lo, hi }
}

// ───────────────────────── Nelder–Mead ─────────────────────────

/**
 * Nelder–Mead 单纯形法（无导数、局部）。
 * @param {number[]} x0 初始点
 * @param {object} [opt]
 *   step      初始单纯形边长（数或每维数组）；缺省 x0_i 的 5%，x0_i = 0 处取 0.00025（同 MATLAB fminsearch）
 *   lower / upper  盒约束（试探点投影回盒内）
 *   xtol / ftol    收敛：单纯形各顶点到最好点的 ∞-范数距离 ≤ xtol，且函数值极差 ≤ ftol（缺省 1e-8 / 1e-10）
 *   maxEval        缺省 max(1000, 400·n)；每轮最多 n + 2 次求值，到点后在本轮结束时停（可能略超）
 *   adaptive       Gao–Han 维数自适应系数，缺省 true
 * @returns {Generator} return { x, f, nEval, nIter, reason: 'converged'|'maxEval', trace: number[] }
 */
export function* nelderMeadSteps(x0, opt = {}) {
  const n = x0.length
  if (!(n >= 1)) throw new Error('Nelder–Mead 需要至少 1 维的初始点')
  const box = boxOf(n, opt.lower, opt.upper)
  const proj = (x) => {
    if (box) for (let i = 0; i < n; i++) x[i] = Math.min(box.hi[i], Math.max(box.lo[i], x[i]))
    return x
  }
  const adaptive = opt.adaptive !== false
  const chi = adaptive ? 1 + 2 / n : 2
  const gamma = adaptive ? 0.75 - 1 / (2 * n) : 0.5
  const sigma = adaptive ? 1 - 1 / n : 0.5
  const xtol = opt.xtol == null ? 1e-8 : opt.xtol
  const ftol = opt.ftol == null ? 1e-10 : opt.ftol
  const maxEval = opt.maxEval == null ? Math.max(1000, 400 * n) : opt.maxEval
  const trace = []
  let nEval = 0

  const base = proj(Float64Array.from(x0, Number))
  const S = [base]
  for (let i = 0; i < n; i++) {
    const h = opt.step == null ? (base[i] !== 0 ? 0.05 * base[i] : 0.00025)
      : (typeof opt.step === 'number' ? opt.step : opt.step[i])
    const v = base.slice()
    v[i] += h
    if (box && (v[i] > box.hi[i] || v[i] < box.lo[i])) v[i] = base[i] - h   // 出盒就往反方向放
    S.push(proj(v))
  }
  const F0 = yield* ask(S)
  nEval += S.length
  const F = Array.from(F0, objVal)
  let nIter = 0
  let reason = 'maxEval'
  const order = Array.from({ length: n + 1 }, (_, i) => i)
  const xbar = new Float64Array(n)
  const along = (a, t) => {                        // xbar + t·(a − xbar)
    const x = new Float64Array(n)
    for (let i = 0; i < n; i++) x[i] = xbar[i] + t * (a[i] - xbar[i])
    return proj(x)
  }

  for (;;) {
    order.sort((a, b) => F[a] - F[b] || a - b)
    const b0 = order[0], w = order[n], sw = order[n - 1]
    trace.push(F[b0])
    let fspread = 0, xspread = 0
    for (let j = 1; j <= n; j++) {
      const o = order[j]
      fspread = Math.max(fspread, Math.abs(F[o] - F[b0]))
      for (let i = 0; i < n; i++) xspread = Math.max(xspread, Math.abs(S[o][i] - S[b0][i]))
    }
    if (fspread <= ftol && xspread <= xtol) { reason = 'converged'; break }
    if (nEval >= maxEval) break
    nIter++
    xbar.fill(0)
    for (let j = 0; j < n; j++) { const s = S[order[j]]; for (let i = 0; i < n; i++) xbar[i] += s[i] / n }

    const xr = along(S[w], -1)
    const [fr0] = yield* ask([xr]); nEval++
    const fr = objVal(fr0)
    if (fr < F[b0]) {
      const xe = along(S[w], -chi)
      const [fe0] = yield* ask([xe]); nEval++
      const fe = objVal(fe0)
      if (fe < fr) { S[w] = xe; F[w] = fe } else { S[w] = xr; F[w] = fr }
      continue
    }
    if (fr < F[sw]) { S[w] = xr; F[w] = fr; continue }
    if (fr < F[w]) {                                // 外收缩
      const xc = along(S[w], -gamma)
      const [fc0] = yield* ask([xc]); nEval++
      const fc = objVal(fc0)
      if (fc <= fr) { S[w] = xc; F[w] = fc; continue }
    } else {                                        // 内收缩
      const xcc = along(S[w], gamma)
      const [fcc0] = yield* ask([xcc]); nEval++
      const fcc = objVal(fcc0)
      if (fcc < F[w]) { S[w] = xcc; F[w] = fcc; continue }
    }
    // 整体收缩：除最好点外全部向最好点缩 σ，整批求值
    const shrink = []
    for (let j = 1; j <= n; j++) {
      const o = order[j], x = new Float64Array(n)
      for (let i = 0; i < n; i++) x[i] = S[b0][i] + sigma * (S[o][i] - S[b0][i])
      S[o] = proj(x)
      shrink.push(o)
    }
    const Fs = yield* ask(shrink.map((o) => S[o])); nEval += shrink.length
    shrink.forEach((o, j) => { F[o] = objVal(Fs[j]) })
  }
  let bi = 0
  for (let j = 1; j <= n; j++) if (F[j] < F[bi]) bi = j
  return { x: Array.from(S[bi]), f: F[bi], nEval, nIter, reason, trace }
}

/** Nelder–Mead 同步版：nelderMead(fn, x0, opt) */
export function nelderMead(fn, x0, opt) {
  return runSync(nelderMeadSteps(x0, opt), fn)
}

// ───────────────────────── CMA-ES ─────────────────────────

/**
 * 盒约束的「线性–二次」周期映射 T：R → [lb, ub]。
 * 内部 [lb+al, ub−au] 上 T = 恒等；[lb−al, lb+al] 上 T = lb + (x − lb + al)²/(4al)，在 lb+al 处值与一阶导都接上，
 * 在 lb−al 处 T = lb、导数为 0，于是在 lb−al 处镜像反射；上界对称。整体以 2(ub − lb + al + au) 为周期。
 * al = min((ub−lb)/2, (1+|lb|)/20)：边界附近只占很窄的一条，内部基本不失真。
 */
function boxTransform(box) {
  const n = box.lo.length
  const al = new Float64Array(n), au = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = box.hi[i] - box.lo[i]
    al[i] = Math.min(w / 2, (1 + Math.abs(box.lo[i])) / 20)
    au[i] = Math.min(w / 2, (1 + Math.abs(box.hi[i])) / 20)
  }
  return (x) => {
    const y = new Array(n)
    for (let i = 0; i < n; i++) {
      const lb = box.lo[i], ub = box.hi[i], a = al[i], b = au[i]
      const lo2 = lb - a, hi2 = ub + b                // 镜像点
      const period = 2 * (hi2 - lo2)
      let v = x[i]
      if (v < lo2 || v > hi2) {
        v = lo2 + (((v - lo2) % period) + period) % period
        if (v > hi2) v = 2 * hi2 - v               // 落在周期的后半段 → 反射回来
      }
      if (v < lb + a) v = lb + (v - lo2) * (v - lo2) / (4 * a)
      else if (v > ub - b) v = ub - (hi2 - v) * (hi2 - v) / (4 * b)
      y[i] = v
    }
    return y
  }
}

/** 单次 CMA-ES（不重启）。供 cmaesSteps 调度。 */
function* cmaesRun(x0, sigma0, lambda, rngSeed, opt, budget) {
  const n = x0.length
  const box = opt._box
  const T = box ? boxTransform(box) : null
  const rng = childRng(rngSeed, 'cma-es')
  const randn = normalSampler(rng)

  const mu = Math.floor(lambda / 2)
  const wRaw = Array.from({ length: mu }, (_, i) => Math.log((lambda + 1) / 2) - Math.log(i + 1))
  const wSum = wRaw.reduce((a, b) => a + b, 0)
  const w = wRaw.map((v) => v / wSum)
  const mueff = 1 / w.reduce((a, b) => a + b * b, 0)
  const cs = (mueff + 2) / (n + mueff + 5)
  const ds = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + cs
  const cc = (4 + mueff / n) / (n + 4 + 2 * mueff / n)
  const c1 = 2 / ((n + 1.3) ** 2 + mueff)
  const cmu = Math.min(1 - c1, 2 * (mueff - 2 + 1 / mueff) / ((n + 2) ** 2 + mueff))
  const chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n))
  const eigenEvery = Math.max(1, Math.floor(lambda / ((c1 + cmu) * n * 10)))

  const tolFun = opt.tolFun == null ? 1e-11 : opt.tolFun
  const tolX = opt.tolX == null ? 1e-11 * sigma0 : opt.tolX
  const stopF = opt.stopFitness == null ? -Infinity : opt.stopFitness
  const minStd = opt.minStd ? Float64Array.from(opt.minStd, Number) : null
  const histLen = 10 + Math.ceil(30 * n / lambda)

  let m = Float64Array.from(x0, Number)
  let sigma = sigma0
  const pc = new Float64Array(n), ps = new Float64Array(n)
  let C = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r })
  let B = C.map((r) => r.slice())
  let Dg = new Float64Array(n).fill(1)
  let eigenGen = 0
  const hist = []
  let best = { x: null, f: Infinity }
  let nEval = 0, gen = 0
  let reason = 'maxEval'
  const trace = []

  for (;;) {
    if (nEval + lambda > budget) { reason = 'maxEval'; break }
    // ── 采样：y = B·(D∘z)，x = m + σ·y
    const Y = [], X = []
    for (let k = 0; k < lambda; k++) {
      const z = new Float64Array(n)
      for (let i = 0; i < n; i++) z[i] = randn() * Dg[i]
      const y = new Float64Array(n), x = new Float64Array(n)
      for (let i = 0; i < n; i++) {
        let s = 0
        for (let j = 0; j < n; j++) s += B[i][j] * z[j]
        y[i] = s
      }
      if (minStd) {                                 // 边际标准差下限：不足部分以独立噪声补上（计入 y，更新时可见）
        for (let i = 0; i < n; i++) {
          const sd = sigma * Math.sqrt(C[i][i])
          if (minStd[i] > sd) y[i] += Math.sqrt(minStd[i] ** 2 - sd * sd) / sigma * randn()
        }
      }
      for (let i = 0; i < n; i++) x[i] = m[i] + sigma * y[i]
      Y.push(y); X.push(x)
    }
    const Xe = T ? X.map(T) : X.map((x) => Array.from(x))
    const F0 = yield* ask(Xe)
    nEval += lambda
    gen++
    const F = Array.from(F0, objVal)
    const idx = F.map((_, i) => i).sort((a, b) => F[a] - F[b] || a - b)
    if (F[idx[0]] < best.f) best = { x: Array.from(Xe[idx[0]]), f: F[idx[0]] }
    trace.push(best.f)

    // ── 均值
    const yw = new Float64Array(n)
    for (let k = 0; k < mu; k++) { const y = Y[idx[k]]; for (let i = 0; i < n; i++) yw[i] += w[k] * y[i] }
    for (let i = 0; i < n; i++) m[i] += sigma * yw[i]
    // ── 步长路径：C^{-1/2}·yw = B·D⁻¹·Bᵀ·yw
    const t = new Float64Array(n)
    for (let j = 0; j < n; j++) { let s = 0; for (let i = 0; i < n; i++) s += B[i][j] * yw[i]; t[j] = s / Dg[j] }
    const csn = Math.sqrt(cs * (2 - cs) * mueff)
    let psNorm = 0
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let j = 0; j < n; j++) s += B[i][j] * t[j]
      ps[i] = (1 - cs) * ps[i] + csn * s
      psNorm += ps[i] * ps[i]
    }
    psNorm = Math.sqrt(psNorm)
    const hsig = psNorm / Math.sqrt(1 - Math.pow(1 - cs, 2 * gen)) / chiN < 1.4 + 2 / (n + 1) ? 1 : 0
    const ccn = Math.sqrt(cc * (2 - cc) * mueff)
    for (let i = 0; i < n; i++) pc[i] = (1 - cc) * pc[i] + hsig * ccn * yw[i]
    // ── 协方差（秩 1 + 秩 μ）
    const keep = 1 - c1 - cmu + (1 - hsig) * c1 * cc * (2 - cc)
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        let rmu = 0
        for (let k = 0; k < mu; k++) { const y = Y[idx[k]]; rmu += w[k] * y[i] * y[j] }
        const v = keep * C[i][j] + c1 * pc[i] * pc[j] + cmu * rmu
        C[i][j] = v; C[j][i] = v
      }
    }
    // ── 步长
    sigma *= Math.exp((cs / ds) * (psNorm / chiN - 1))
    // ── 特征分解（惰性：每 eigenEvery 代一次）
    if (gen - eigenGen >= eigenEvery) {
      eigenGen = gen
      const e = symEigen(C)
      B = e.vectors
      Dg = Float64Array.from(e.values, (v) => Math.sqrt(Math.max(v, 1e-300)))
    }

    // ── 终止
    hist.push(F[idx[0]])
    if (hist.length > histLen) hist.shift()
    if (best.f <= stopF) { reason = 'stopFitness'; break }
    let fmin = Infinity, fmax = -Infinity
    for (const v of hist) { fmin = Math.min(fmin, v); fmax = Math.max(fmax, v) }
    for (const v of F) { fmin = Math.min(fmin, v); fmax = Math.max(fmax, v) }
    if (hist.length >= histLen && fmax - fmin < tolFun) { reason = 'tolFun'; break }
    let xs = 0
    for (let i = 0; i < n; i++) xs = Math.max(xs, sigma * Math.max(Math.abs(pc[i]), Math.sqrt(C[i][i])))
    if (xs < tolX) { reason = 'tolX'; break }
    let dmax = 0, dmin = Infinity
    for (const d of Dg) { dmax = Math.max(dmax, d); dmin = Math.min(dmin, d) }
    if (dmax / dmin > 1e7) { reason = 'conditionCov'; break }
    if (sigma * dmax > 1e20 * sigma0) { reason = 'tolUpSigma'; break }
    let noEffect = false                            // 任一坐标加 0.2 个标准差后均值纹丝不动 → 数值精度已到头
    for (let i = 0; i < n; i++) if (m[i] + 0.2 * sigma * Math.sqrt(C[i][i]) === m[i]) { noEffect = true; break }
    if (noEffect) { reason = 'noEffectCoord'; break }
    if (!Number.isFinite(sigma) || !Number.isFinite(psNorm)) { reason = 'numerical'; break }
  }
  return { x: best.x, f: best.f, nEval, nGen: gen, reason, sigma, mean: T ? T(m) : Array.from(m), trace }
}

/**
 * CMA-ES（无导数、全局性较强的进化策略）。
 * @param {number[]} x0 初始均值
 * @param {object} [opt]
 *   sigma0         初始步长；缺省有边界时取 0.3·平均盒宽，否则 0.5
 *   lower / upper  盒约束（经 boxTransform 映射，见文件头）
 *   popSize        λ，缺省 4 + ⌊3 ln n⌋
 *   maxEval        评估总数上限（含重启），缺省 1000·(n+5)²/√λ 取整
 *   restarts       IPOP 重启次数，缺省 0；每次重启 λ 加倍，有边界时从盒内均匀随机点重新出发
 *   stopFitness    目标值，f ≤ 它即停
 *   tolFun / tolX  终止判据（缺省 1e-11 / 1e-11·sigma0）
 *   minStd         各维边际标准差下限（数组；混合编码用，见 makeSpace().minStd()）
 *   seed           随机种子
 * @returns {Generator} return { x, f, nEval, nGen, reason, sigma, mean, restarts, trace }
 */
export function* cmaesSteps(x0, opt = {}) {
  const n = x0.length
  if (!(n >= 1)) throw new Error('CMA-ES 需要至少 1 维的初始点')
  const box = boxOf(n, opt.lower, opt.upper)
  const seed = opt.seed == null ? DEFAULT_SEED : opt.seed
  const lambda0 = opt.popSize == null ? 4 + Math.floor(3 * Math.log(n)) : Math.max(2, Math.floor(opt.popSize))
  let sigma0 = opt.sigma0
  if (sigma0 == null) {
    if (box) { let s = 0; for (let i = 0; i < n; i++) s += box.hi[i] - box.lo[i]; sigma0 = 0.3 * s / n } else sigma0 = 0.5
  }
  if (!(sigma0 > 0)) throw new Error(`CMA-ES 初始步长须为正：${sigma0}`)
  const maxEval = opt.maxEval == null ? Math.round(1000 * (n + 5) ** 2 / Math.sqrt(lambda0)) : opt.maxEval
  if (!(maxEval >= lambda0)) throw new Error(`CMA-ES 的 maxEval（${maxEval}）小于种群大小（${lambda0}）`)
  const restarts = Math.max(0, Math.floor(opt.restarts || 0))
  const inner = { ...opt, _box: box }
  const restartRng = childRng(seed, 'cma-es-restart')
  let best = null, last = null, nEval = 0, nGen = 0, lambda = lambda0, done = 0
  const trace = []
  for (let r = 0; r <= restarts && nEval + lambda <= maxEval; r++) {
    let start = Array.from(x0, Number)
    if (box) {
      start = r === 0 ? start.map((v, i) => Math.min(box.hi[i], Math.max(box.lo[i], v)))
        : Array.from({ length: n }, (_, i) => box.lo[i] + restartRng() * (box.hi[i] - box.lo[i]))
    }
    last = yield* cmaesRun(start, sigma0, lambda, deriveSeed(seed, r), inner, maxEval - nEval)
    nEval += last.nEval; nGen += last.nGen; done = r
    for (const v of last.trace) trace.push(best && best.f < v ? best.f : v)
    if (!best || last.f < best.f) best = last
    if (last.reason === 'stopFitness' || last.reason === 'maxEval') break
    lambda *= 2
  }
  // reason 取最后一轮的停机原因（「为什么停」）；x / f 取各轮中最好的
  return { x: best.x, f: best.f, nEval, nGen, reason: last.reason, sigma: best.sigma, mean: best.mean, restarts: done, trace }
}

/** CMA-ES 同步版：cmaes(fn, x0, opt) */
export function cmaes(fn, x0, opt) {
  return runSync(cmaesSteps(x0, opt), fn)
}

// ───────────────────────── NSGA-II ─────────────────────────

/** 多目标评估结果 → { f, g, cv }；cv = Σ max(0, g_j)，目标非有限 → cv = +Infinity */
function parseMulti(v, nObj) {
  let f, g
  if (typeof v === 'number') { f = [v]; g = [] } else if (Array.isArray(v) || ArrayBuffer.isView(v)) { f = Array.from(v); g = [] } else if (v && typeof v === 'object' && v.f != null) {
    f = typeof v.f === 'number' ? [v.f] : Array.from(v.f)
    g = v.g == null ? [] : (typeof v.g === 'number' ? [v.g] : Array.from(v.g))
  } else { f = []; g = [] }
  let cv = 0
  for (const gj of g) {
    const x = Number(gj)
    if (Number.isNaN(x)) { cv = Infinity; break }
    if (x > 0) cv += x
  }
  const ok = (nObj == null || f.length === nObj) && f.length > 0 && f.every((x) => typeof x === 'number' && Number.isFinite(x))
  if (!ok) cv = Infinity
  return { f, g, cv }
}

/** 约束支配：a 是否支配 b（Deb et al. 2002 的 constrained-domination） */
function constrainedDominates(a, b) {
  if (a.cv < b.cv) return true
  if (a.cv > b.cv || a.cv > 0) return false
  let better = false
  for (let m = 0; m < a.f.length; m++) {
    if (a.f[m] > b.f[m]) return false
    if (a.f[m] < b.f[m]) better = true
  }
  return better
}

/** 快速非支配排序：写 rank，返回前沿列表（下标数组） */
function nonDominatedSort(P) {
  const N = P.length
  const S = Array.from({ length: N }, () => [])
  const cnt = new Int32Array(N)
  const fronts = [[]]
  for (let p = 0; p < N; p++) {
    for (let q = p + 1; q < N; q++) {
      if (constrainedDominates(P[p], P[q])) { S[p].push(q); cnt[q]++ } else if (constrainedDominates(P[q], P[p])) { S[q].push(p); cnt[p]++ }
    }
  }
  for (let p = 0; p < N; p++) if (cnt[p] === 0) { P[p].rank = 0; fronts[0].push(p) }
  for (let i = 0; fronts[i].length; i++) {
    const next = []
    for (const p of fronts[i]) {
      for (const q of S[p]) if (--cnt[q] === 0) { P[q].rank = i + 1; next.push(q) }
    }
    fronts.push(next)
  }
  fronts.pop()
  return fronts
}

/** 一条前沿内的拥挤距离（写 crowding） */
function crowding(P, front) {
  for (const i of front) P[i].crowding = 0
  if (!front.length) return
  const M = P[front[0]].f.length
  for (let m = 0; m < M; m++) {
    const s = front.slice().sort((a, b) => P[a].f[m] - P[b].f[m] || a - b)
    const fmin = P[s[0]].f[m], fmax = P[s[s.length - 1]].f[m]
    P[s[0]].crowding = Infinity; P[s[s.length - 1]].crowding = Infinity
    const range = fmax - fmin
    if (!(range > 0) || !Number.isFinite(range)) continue
    for (let j = 1; j < s.length - 1; j++) P[s[j]].crowding += (P[s[j + 1]].f[m] - P[s[j - 1]].f[m]) / range
  }
}

/**
 * NSGA-II 多目标优化（全部目标最小化）。
 * @param {object} opt
 *   lower / upper  盒约束（必填）
 *   popSize        种群 N，缺省 100（取偶数）
 *   generations    代数，缺省 100；maxEval 另设总评估上限（先到为准）
 *   crossoverProb  SBX 概率，缺省 0.9；etaC 缺省 20
 *   mutationProb   每个基因的多项式变异概率，缺省 1/n；etaM 缺省 20
 *   initial        初始种群（行向量数组；不足 N 的部分随机补齐），如用 LHS 撒的点
 *   seed
 * @returns {Generator} return { population, front, nEval, nGen, trace }
 *   population：[{ x, f, g, cv, rank, crowding }]，按 rank 升序、同 rank 拥挤距离降序
 *   front：可行的第 0 前沿，按 f[0] 升序
 */
export function* nsga2Steps(opt = {}) {
  const box = boxOf(opt.lower ? opt.lower.length : 0, opt.lower, opt.upper)
  if (!box) throw new Error('NSGA-II 需要盒约束 lower / upper')
  const n = box.lo.length
  const N = Math.max(4, 2 * Math.ceil((opt.popSize == null ? 100 : opt.popSize) / 2))
  const generations = opt.generations == null ? 100 : Math.max(0, Math.floor(opt.generations))
  const maxEval = opt.maxEval == null ? Infinity : opt.maxEval
  const pc = opt.crossoverProb == null ? 0.9 : opt.crossoverProb
  const etaC = opt.etaC == null ? 20 : opt.etaC
  const pm = opt.mutationProb == null ? 1 / n : opt.mutationProb
  const etaM = opt.etaM == null ? 20 : opt.etaM
  const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'nsga2')
  const lo = box.lo, hi = box.hi
  const clip = (v, i) => Math.min(hi[i], Math.max(lo[i], v))

  const X0 = []
  for (const x of opt.initial || []) {
    if (!x || x.length !== n) throw new Error(`initial 的每个点须为长度 ${n} 的数组`)
    if (X0.length < N) X0.push(Array.from(x, (v, i) => clip(Number(v), i)))
  }
  while (X0.length < N) X0.push(Array.from({ length: n }, (_, i) => lo[i] + rng() * (hi[i] - lo[i])))
  let nObj = null
  const evalPop = function* (X) {
    const R = yield* ask(X)
    return X.map((x, i) => {
      const e = parseMulti(R[i], nObj)
      if (nObj == null && e.cv !== Infinity) nObj = e.f.length
      return { x: Array.from(x), f: e.f, g: e.g, cv: e.cv, rank: 0, crowding: 0 }
    })
  }
  let P = yield* evalPop(X0)
  let nEval = N
  const fixShape = (pop) => {                       // 首代全部失败时 nObj 还没定：这里补成同长，免得排序时越界
    const M = nObj || Math.max(1, ...pop.map((p) => p.f.length))
    for (const p of pop) if (p.f.length !== M || p.cv === Infinity) { p.f = Array.from({ length: M }, (_, m) => (Number.isFinite(p.f[m]) ? p.f[m] : Infinity)); p.cv = Infinity }
  }
  fixShape(P)
  for (const fr of nonDominatedSort(P)) crowding(P, fr)
  const trace = []

  // 拥挤比较锦标赛：两两比 rank，同 rank 比拥挤距离，再同则随机
  const better = (a, b) => (a.rank !== b.rank ? (a.rank < b.rank ? a : b)
    : a.crowding !== b.crowding ? (a.crowding > b.crowding ? a : b) : (rng() < 0.5 ? a : b))
  let pool = [], poolAt = 0
  const pick = () => {
    if (poolAt + 2 > pool.length) { pool = shuffle(rng, P.map((_, i) => i)); poolAt = 0 }
    const a = P[pool[poolAt++]], b = P[pool[poolAt++]]
    return better(a, b)
  }

  // 有界 SBX：对每一维以 0.5 的概率交叉；βq 按到两侧边界的距离分别算（Deb 的 NSGA-II 原实现口径）
  const sbx = (p1, p2) => {
    const c1 = p1.slice(), c2 = p2.slice()
    if (rng() > pc) return [c1, c2]
    for (let i = 0; i < n; i++) {
      if (rng() > 0.5) continue
      const y1 = Math.min(p1[i], p2[i]), y2 = Math.max(p1[i], p2[i])
      if (!(y2 - y1 > 1e-14)) continue
      const u = rng()
      const betaq = (beta) => {
        const alpha = 2 - Math.pow(beta, -(etaC + 1))
        return u <= 1 / alpha ? Math.pow(u * alpha, 1 / (etaC + 1)) : Math.pow(1 / (2 - u * alpha), 1 / (etaC + 1))
      }
      const a = clip(0.5 * ((y1 + y2) - betaq(1 + 2 * (y1 - lo[i]) / (y2 - y1)) * (y2 - y1)), i)
      const b = clip(0.5 * ((y1 + y2) + betaq(1 + 2 * (hi[i] - y2) / (y2 - y1)) * (y2 - y1)), i)
      if (rng() < 0.5) { c1[i] = b; c2[i] = a } else { c1[i] = a; c2[i] = b }
    }
    return [c1, c2]
  }
  // 多项式变异（有界版）
  const mutate = (x) => {
    for (let i = 0; i < n; i++) {
      if (rng() >= pm) continue
      const y = x[i], w = hi[i] - lo[i]
      const d1 = (y - lo[i]) / w, d2 = (hi[i] - y) / w
      const u = rng(), pw = 1 / (etaM + 1)
      let dq
      if (u < 0.5) {
        const v = 2 * u + (1 - 2 * u) * Math.pow(1 - d1, etaM + 1)
        dq = Math.pow(v, pw) - 1
      } else {
        const v = 2 * (1 - u) + 2 * (u - 0.5) * Math.pow(1 - d2, etaM + 1)
        dq = 1 - Math.pow(v, pw)
      }
      x[i] = clip(y + dq * w, i)
    }
    return x
  }

  let gen = 0
  for (; gen < generations && nEval + N <= maxEval; gen++) {
    const Q = []
    while (Q.length < N) {
      const [c1, c2] = sbx(pick().x, pick().x)
      Q.push(mutate(c1)); if (Q.length < N) Q.push(mutate(c2))
    }
    const Qe = yield* evalPop(Q)
    nEval += N
    const R = P.concat(Qe)
    fixShape(R)
    const fronts = nonDominatedSort(R)
    const next = []
    for (const fr of fronts) {
      crowding(R, fr)
      if (next.length + fr.length <= N) { for (const i of fr) next.push(R[i]); continue }
      const s = fr.slice().sort((a, b) => R[b].crowding - R[a].crowding || a - b)
      for (let j = 0; next.length < N; j++) next.push(R[s[j]])
      break
    }
    P = next
    // 下一代锦标赛用的 rank / 拥挤距离按新种群重算（截断的那条前沿在新种群里拥挤距离会变）
    for (const fr of nonDominatedSort(P)) crowding(P, fr)
    pool = []; poolAt = 0
    trace.push({ gen: gen + 1, nFeasible: P.filter((p) => p.cv === 0).length, nFront: P.filter((p) => p.rank === 0 && p.cv === 0).length })
  }
  const population = P.slice().sort((a, b) => a.rank - b.rank || b.crowding - a.crowding)
  const front = population.filter((p) => p.rank === 0 && p.cv === 0).sort((a, b) => a.f[0] - b.f[0])
  return { population, front, nEval, nGen: gen, trace }
}

/** NSGA-II 同步版：nsga2(fn, opt) */
export function nsga2(fn, opt) {
  return runSync(nsga2Steps(opt), fn)
}

/**
 * 二目标超体积（最小化，相对参考点 ref；只计严格优于 ref 的点）。
 * 按 f1 升序扫描，被支配的点自然不贡献面积。
 */
export function hypervolume2d(points, ref) {
  const pts = Array.from(points, (p) => [Number(p[0]), Number(p[1])])
    .filter((p) => p[0] < ref[0] && p[1] < ref[1])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let hv = 0, prev = ref[1]
  for (const [f1, f2] of pts) {
    if (f2 < prev) { hv += (ref[0] - f1) * (prev - f2); prev = f2 }
  }
  return hv
}

// ───────────────────────── 混合编码 ─────────────────────────

/**
 * 混合变量空间：统一编码到 [0,1]^k。
 * @param {Array<object>} vars 每个变量：
 *   { name, type: 'real', lower, upper, scale?: 'linear'|'log' }   log 刻度要求 0 < lower
 *   { name, type: 'int', lower, upper }                            含两端的整数
 *   { name, type: 'ordinal', values: [...] }                        有序水平（如天线口径 1.2 / 1.8 / 2.4 m）
 *   { name, type: 'cat', values: [...] }                            无序类别（如调制方式名）
 * 离散变量 m 个水平把 [0,1] 等分成 m 格，z ∈ [j/m, (j+1)/m) ↔ 第 j 个水平（z = 1 归最后一格）。
 * cat 与 ordinal 编码相同，区别只在语义：对 cat，相邻格没有「接近」的含义，NM / CMA-ES 的连续搜索
 * 对它只是随机试探，变量多时宜改用 NSGA-II 或全因子穷举。
 * @returns {{dim, vars, lower, upper, discrete: boolean[], levels: number[], decode, decodeObject, encode, key, center, minStd}}
 */
export function makeSpace(vars) {
  if (!vars || !vars.length) throw new Error('混合空间至少需要 1 个变量')
  const V = vars.map((v, j) => {
    const name = v.name == null ? `x${j}` : String(v.name)
    switch (v.type) {
      case 'real': {
        const lo = Number(v.lower), hi = Number(v.upper), log = v.scale === 'log'
        if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)) throw new Error(`变量 ${name}：real 需要有限的 lower < upper`)
        if (log && !(lo > 0)) throw new Error(`变量 ${name}：对数刻度要求 lower > 0`)
        return { name, type: 'real', lower: lo, upper: hi, scale: log ? 'log' : 'linear', m: 0 }
      }
      case 'int': {
        const lo = Number(v.lower), hi = Number(v.upper)
        if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi)) throw new Error(`变量 ${name}：int 需要整数 lower ≤ upper`)
        return { name, type: 'int', lower: lo, upper: hi, m: hi - lo + 1 }
      }
      case 'ordinal':
      case 'cat': {
        const values = Array.from(v.values || [])
        if (!values.length) throw new Error(`变量 ${name}：${v.type} 需要非空 values`)
        return { name, type: v.type, values, m: values.length }
      }
      default: throw new Error(`变量 ${name}：未知类型 ${v.type}`)
    }
  })
  const k = V.length
  const cell = (z, m) => Math.min(m - 1, Math.max(0, Math.floor(z * m)))
  const zc = (z) => (z > 0 ? (z < 1 ? z : 1) : 0)
  const decode1 = (v, z) => {
    if (v.type === 'real') {
      const t = zc(z)
      if (t === 0) return v.lower                  // 两端精确落在界上（lower + 1·(upper − lower) 未必 = upper）
      if (t === 1) return v.upper
      return v.scale === 'log' ? Math.exp(Math.log(v.lower) + t * (Math.log(v.upper) - Math.log(v.lower))) : v.lower + t * (v.upper - v.lower)
    }
    const j = cell(z, v.m)
    return v.type === 'int' ? v.lower + j : v.values[j]
  }
  const encode1 = (v, x) => {
    if (v.type === 'real') {
      const t = v.scale === 'log' ? (Math.log(x) - Math.log(v.lower)) / (Math.log(v.upper) - Math.log(v.lower)) : (x - v.lower) / (v.upper - v.lower)
      return zc(t)
    }
    const j = v.type === 'int' ? x - v.lower : v.values.indexOf(x)
    if (!(Number.isInteger(j) && j >= 0 && j < v.m)) throw new Error(`变量 ${v.name}：取值 ${x} 不在定义域内`)
    return (j + 0.5) / v.m                          // 格心
  }
  const space = {
    dim: k,
    vars: V,
    lower: new Array(k).fill(0),
    upper: new Array(k).fill(1),
    discrete: V.map((v) => v.m > 0),
    levels: V.map((v) => v.m),
    /** z → 取值数组 */
    decode: (z) => V.map((v, j) => decode1(v, z[j])),
    /** z → { name: 取值 } */
    decodeObject: (z) => Object.fromEntries(V.map((v, j) => [v.name, decode1(v, z[j])])),
    /** 取值数组 → z（离散取格心） */
    encode: (x) => V.map((v, j) => encode1(v, x[j])),
    /** 去重键：离散维取格号，连续维取解码值本身 */
    key: (z) => V.map((v, j) => (v.m ? cell(z[j], v.m) : decode1(v, z[j]))).join('|'),
    /** 单位立方体中心（各离散维取中间格的格心），作缺省起点 */
    center: () => V.map((v) => (v.m ? (Math.floor(v.m / 2) + 0.5) / v.m : 0.5)),
    /** CMA-ES 的边际标准差下限：离散维取格宽 × frac，连续维 0 */
    minStd: (frac = 0.25) => V.map((v) => (v.m ? frac / v.m : 0)),
  }
  return space
}

/**
 * 把任一优化器的 *Steps（在 [0,1]^k 上搜索）接到混合空间上：yield 的是解码后的取值（数组，
 * 或 named:true 时的 { name: 取值 } 对象），并按 space.key 去重缓存——同一批里的重复点、历史上算过的点都不再评估。
 * return 的结果对象上补 values（单目标的最优解码值）或给 population / front 的每个成员补 values。
 * @param {ReturnType<typeof makeSpace>} space
 * @param {Generator} steps  如 cmaesSteps(space.center(), { lower: space.lower, upper: space.upper, minStd: space.minStd() })
 * @param {{cache?:boolean, named?:boolean}} [opt]  cache 缺省：空间里有离散变量时开
 */
export function* mixedSteps(space, steps, opt = {}) {
  const useCache = opt.cache == null ? space.discrete.some(Boolean) : !!opt.cache
  const dec = opt.named ? space.decodeObject : space.decode
  const cache = new Map()
  let nUnique = 0
  let r = steps.next()
  while (!r.done) {
    const Z = r.value
    let F
    if (!useCache) {
      F = yield* ask(Z.map(dec))
      nUnique += Z.length
    } else {
      const keys = Z.map(space.key)
      const fresh = []                                // 本批新出现的键（同批重复只算一次）
      for (const k of keys) if (!cache.has(k) && !fresh.includes(k)) fresh.push(k)
      if (fresh.length) {
        const got = yield* ask(fresh.map((k) => dec(Z[keys.indexOf(k)])))
        fresh.forEach((k, j) => cache.set(k, got[j]))
        nUnique += fresh.length
      }
      F = keys.map((k) => cache.get(k))
    }
    r = steps.next(F)
  }
  const out = { ...r.value, nUnique }
  if (out.x) out.values = dec(out.x)
  if (out.population) out.population = out.population.map((p) => ({ ...p, values: dec(p.x) }))
  if (out.front) out.front = out.front.map((p) => ({ ...p, values: dec(p.x) }))
  return out
}
