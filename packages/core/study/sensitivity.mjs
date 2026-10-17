// 参数研究 · 敏感性分析：Morris 初筛、Sobol 一阶 / 总效应指数（Saltelli 抽样 + Jansen 估计）、块 bootstrap 置信区间。
//
// 用法分两步，模型求值始终在本库之外（同步、异步、Worker 都行）：
//   ① *Sample 出单位超立方体上的设计 X（n 行 × k 列）→ 调用方 mapUnit(X, dists) 映射到参数分布 → 求值得 Y；
//   ② *Analyze / sobolIndices 吃 X 与 Y 出指数与区间。
// Y 里的非有限值（求值失败）不会把整次分析带崩：Morris 丢掉含失败点的整条轨迹，Sobol 丢掉含失败点的整组
// 基行（A、B 与 k 个 A_B^(i) 一起丢），丢了多少在结果里报。
//
// ─── Morris ───────────────────────────────────────────────────────────────
// Morris, Technometrics 33 (1991) 161–174：p 级网格上的随机一次一因子（OAT）轨迹，每条 k+1 个点、
// 每个因子恰走一步 Δ = p/(2(p−1))，基本效应 EE_i = Δy / Δx_i。
// μ* = mean|EE|（Campolongo, Cariboni & Saltelli, Environ. Model. Softw. 22 (2007) 1509–1518）判重要性，
// σ = sd(EE) 判非线性 / 交互；轨迹散布优化取同文的距离判据，用贪心近似（逐条剔除对总散布贡献最小者）
// 代替原文的穷举组合。
// grid: 'centered' 时网格取 (l+½)/p：网格两端不落在 0 / 1 上，正态等无界分布映射后不会出现 ±6σ 的极端点；
// 缺省 'edges'（l/(p−1)，Morris 原文口径）。
//
// ─── Sobol 指数 ───────────────────────────────────────────────────────────
// 抽样：Saltelli, Comput. Phys. Commun. 145 (2002) 280–297 的 A、B、A_B^(i) 方案，每个基行 k+2 次求值；
// 行序按基行分组：[A_j, A_B^(1)_j, …, A_B^(k)_j, B_j]，所以前若干组可以先算先分析。
// 估计：Jansen, Comput. Phys. Commun. 117 (1999) 35–43（Saltelli et al., Comput. Phys. Commun. 181 (2010)
// 259–270 表 2 里署名 Jansen 的一阶、总效应两式）：
//     S_Ti = Σ_j (f(A)_j − f(A_B^(i))_j)² / (2N·V)
//     S_i  = 1 − Σ_j (f(B)_j − f(A_B^(i))_j)² / (2N·V)
//     V    = f(A) ∪ f(B) 这 2N 个值的样本方差
// A_B^(i) 与 A 只差第 i 列，差值平方均值 = 2·E[V(Y|X~i)]；与 B 只共享第 i 列，差值平方均值 = 2·(V − V[E(Y|X_i)])。
//
// ─── 块 bootstrap ─────────────────────────────────────────────────────────
// 口径同 packages/core/utils/interference/ciNgso.js 的 bootstrapPercentiles（多历元）：
//   · 重采样单位是【块】：块内结构原样搬走，块间才当独立；
//   · B 次有放回重采样（缺省 200，样本总数 > 20000 时 100，下限 20），种子缺省 20260728，
//     抽块写法 (rng()·nB)|0 与 ciNgso 逐字一致——同一组块、同一种子，抽出的块序列逐位相同（单测对拍）；
//   · 区间取重采样估计的 2.5 / 97.5 分位，下标 round(f·(B−1))；mean 是重采样估计的均值；
//   · 块数 < 8 时置 lowResolution（区间分辨率受块组合数限制，会偏窄）。
// 块怎么分由抽样决定：Saltelli 的 blocks = R 份独立加扰的 Sobol 重复（随机化 QMC）时，块 = 一份重复；
// 蒙特卡洛或只有一份时每个基行自成一块（退化为普通 i.i.d. bootstrap；对单份 QMC 而言区间偏保守）。
// Morris 的块是轨迹。

import { DEFAULT_SEED, makeRng, childRng, deriveSeed, permutation, randInt } from './rng.mjs'
import { sobolSequence, monteCarlo, SOBOL_MAX_DIM } from './designs.mjs'

/** bootstrap 区间可信所需的最少块数（同 ciNgso 的 BOOTSTRAP_MIN_BLOCKS） */
export const BOOTSTRAP_MIN_BLOCKS = 8

function needInt(v, name, min = 1) {
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} 须为 ≥ ${min} 的整数：${v}`)
}

// ───────────────────────── 块 bootstrap ─────────────────────────

/**
 * 块 bootstrap 百分位区间。
 * @param {ArrayLike[]} blocks  每块一个数组（内容由 statistic 自己解释：样本值、行号……），只用到 length；空块剔除
 * @param {(pick: Int32Array) => number|number[]} statistic  pick = 本次抽中的块下标（原 blocks 的下标，可重复，长度 = 非空块数）
 * @param {{resamples?:number, seed?:number, conf?:number}} [opt]  conf 缺省 0.95
 * @returns {Array<{mean:number, lo:number, hi:number, resamples:number, blocks:number, lowResolution:boolean}|null>}
 *   每个统计量分量一项；NaN 估计不计入（全是 NaN 的分量为 null）
 */
export function blockBootstrap(blocks, statistic, opt = {}) {
  const live = []
  for (let i = 0; i < (blocks ? blocks.length : 0); i++) if (blocks[i] && blocks[i].length) live.push(i)
  const nB = live.length
  if (!nB) return []
  let total = 0
  for (const i of live) total += blocks[i].length
  const B = Math.max(20, Math.round(Number(opt.resamples) || (total > 20000 ? 100 : 200)))
  const conf = opt.conf == null ? 0.95 : Number(opt.conf)
  if (!(conf > 0 && conf < 1)) throw new Error(`置信水平须在 (0, 1)：${opt.conf}`)
  const rng = makeRng(opt.seed == null ? DEFAULT_SEED : opt.seed)
  const pick = new Int32Array(nB)
  let ests = null
  for (let b = 0; b < B; b++) {
    for (let k = 0; k < nB; k++) pick[k] = live[(rng() * nB) | 0]
    const v = statistic(pick)
    const arr = typeof v === 'number' ? [v] : v
    if (!ests) ests = Array.from(arr, () => [])
    for (let q = 0; q < ests.length; q++) {
      const x = arr[q]
      if (x != null && !Number.isNaN(x)) ests[q].push(x)
    }
  }
  const tail = (1 - conf) / 2
  return ests.map((e) => {
    if (!e.length) return null
    e.sort((a, b) => a - b)
    const q = (f) => e[Math.max(0, Math.min(e.length - 1, Math.round(f * (e.length - 1))))]
    const finite = e.filter(Number.isFinite)
    return {
      mean: finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : q(0.5),
      lo: q(tail), hi: q(1 - tail), resamples: e.length,
      blocks: nB, lowResolution: nB < BOOTSTRAP_MIN_BLOCKS,
    }
  })
}

// ───────────────────────── Morris ─────────────────────────

/**
 * Morris 轨迹设计。
 * @param {{k:number, r:number, levels?:number, grid?:'edges'|'centered', candidates?:number, seed?:number}} opt
 *   levels      网格级数 p（偶数，缺省 4）
 *   candidates  先生成这么多条候选、再按散布挑出 r 条（整数 ≥ r；缺省 = r，不挑）
 * @returns {{X:number[][], k:number, r:number, levels:number, grid:string, delta:number}}
 *   X 共 r·(k+1) 行，每 k+1 行一条轨迹
 */
export function morrisSample(opt = {}) {
  const { k, r } = opt
  needInt(k, 'Morris 因子数 k'); needInt(r, 'Morris 轨迹数 r')
  const p = opt.levels == null ? 4 : opt.levels
  if (!Number.isInteger(p) || p < 2 || p % 2) throw new Error(`Morris 网格级数须为 ≥ 2 的偶数：${p}`)
  const grid = opt.grid || 'edges'
  if (grid !== 'edges' && grid !== 'centered') throw new Error(`Morris 网格只能是 'edges' 或 'centered'：${grid}`)
  if (opt.candidates != null) needInt(opt.candidates, 'Morris 候选轨迹数 candidates', r)
  const M = opt.candidates == null ? r : opt.candidates
  const level = grid === 'edges' ? (l) => l / (p - 1) : (l) => (l + 0.5) / p
  const jump = p / 2
  const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'morris')
  let trajs = []
  for (let t = 0; t < M; t++) {
    const lv = new Int32Array(k), dir = new Int8Array(k)
    for (let i = 0; i < k; i++) {
      const base = randInt(rng, jump)               // 0 … p/2−1：base + Δ 仍在网格内
      dir[i] = rng() < 0.5 ? -1 : 1
      lv[i] = dir[i] > 0 ? base : base + jump
    }
    const order = permutation(rng, k)
    const rows = [Array.from(lv, level)]
    for (const i of order) { lv[i] += dir[i] * jump; rows.push(Array.from(lv, level)) }
    trajs.push(rows)
  }
  if (M > r) trajs = selectSpread(trajs, r)
  return { X: trajs.flat(), k, r, levels: p, grid, delta: level(jump) - level(0) }
}

/**
 * 从候选轨迹里挑 r 条散布最大的：Campolongo (2007) 的轨迹间距离 d_ml = Σ_i Σ_j ‖X_i^(m) − X_j^(l)‖，
 * 目标 max Σ d_ml²；贪心地逐条剔除「与其余各条的 d² 之和」最小者。
 */
function selectSpread(trajs, r) {
  const M = trajs.length, rows = trajs[0].length, k = trajs[0][0].length
  if (M * M * rows * rows * k > 2e9) throw new Error(`Morris 候选轨迹太多（${M} 条 × ${k} 因子），请减少 candidates`)
  const D2 = new Float64Array(M * M)
  const contrib = new Float64Array(M)
  for (let a = 0; a < M; a++) {
    for (let b = a + 1; b < M; b++) {
      let d = 0
      for (const x of trajs[a]) {
        for (const y of trajs[b]) {
          let s = 0
          for (let c = 0; c < k; c++) { const e = x[c] - y[c]; s += e * e }
          d += Math.sqrt(s)
        }
      }
      D2[a * M + b] = D2[b * M + a] = d * d
      contrib[a] += d * d; contrib[b] += d * d
    }
  }
  const alive = new Uint8Array(M).fill(1)
  for (let count = M; count > r; count--) {
    let worst = -1
    for (let m = 0; m < M; m++) if (alive[m] && (worst < 0 || contrib[m] < contrib[worst])) worst = m
    alive[worst] = 0
    for (let m = 0; m < M; m++) if (alive[m]) contrib[m] -= D2[worst * M + m]
  }
  return trajs.filter((_, m) => alive[m])
}

/**
 * Morris 分析：逐条轨迹求基本效应，汇总 μ、μ*、σ，并对 μ* 做按轨迹的块 bootstrap。
 * @param {ArrayLike<number>[]} X  morrisSample 的 X（单位超立方体上的值，不是映射后的值）
 * @param {ArrayLike<number>} Y   对应的模型输出
 * @param {{k:number, resamples?:number, seed?:number, conf?:number}} opt
 * @returns {{mu:number[], muStar:number[], sigma:number[], muStarCi:Array, ee:number[][], r:number, dropped:number}}
 *   ee：有效轨迹 × 因子的基本效应矩阵（画 μ*–σ 图、看分布用）
 */
export function morrisAnalyze(X, Y, opt = {}) {
  const { k } = opt
  needInt(k, 'Morris 因子数 k')
  const per = k + 1
  if (X.length !== Y.length || X.length % per) throw new Error(`Morris 设计行数（${X.length}）须与输出等长，且为 k+1 = ${per} 的整数倍`)
  const R = X.length / per
  const ee = []
  let dropped = 0
  for (let t = 0; t < R; t++) {
    const b0 = t * per
    let ok = true
    for (let s = 0; s < per; s++) if (!Number.isFinite(Number(Y[b0 + s]))) { ok = false; break }
    const e = new Array(k).fill(NaN)
    for (let s = 1; s < per; s++) {
      const a = X[b0 + s - 1], b = X[b0 + s]
      let moved = -1
      for (let i = 0; i < k; i++) {
        if (a[i] !== b[i]) {
          if (moved >= 0) throw new Error(`第 ${t} 条轨迹第 ${s} 步同时动了两个因子，不是 Morris 设计`)
          moved = i
        }
      }
      if (moved < 0 || !Number.isNaN(e[moved])) throw new Error(`第 ${t} 条轨迹第 ${s} 步没动或重复动了因子，不是 Morris 设计`)
      e[moved] = ok ? (Number(Y[b0 + s]) - Number(Y[b0 + s - 1])) / (b[moved] - a[moved]) : 0
    }
    if (ok) ee.push(e); else dropped++
  }
  const r = ee.length
  const mu = new Array(k).fill(NaN), muStar = new Array(k).fill(NaN), sigma = new Array(k).fill(NaN)
  for (let i = 0; i < k && r; i++) {
    let s = 0, sa = 0
    for (const e of ee) { s += e[i]; sa += Math.abs(e[i]) }
    mu[i] = s / r; muStar[i] = sa / r
    if (r > 1) {
      let v = 0
      for (const e of ee) v += (e[i] - mu[i]) ** 2
      sigma[i] = Math.sqrt(v / (r - 1))
    }
  }
  const muStarCi = r ? blockBootstrap(ee, (pick) => {
    const out = new Array(k).fill(0)
    for (const t of pick) for (let i = 0; i < k; i++) out[i] += Math.abs(ee[t][i])
    return out.map((v) => v / pick.length)
  }, opt) : []
  return { mu, muStar, sigma, muStarCi, ee, r, dropped }
}

// ───────────────────────── Saltelli + Jansen ─────────────────────────

/**
 * Saltelli 抽样（单位超立方体）。
 * @param {{k:number, n:number, method?:'sobol'|'mc', scramble?:boolean, blocks?:number, skip?:number, seed?:number}} opt
 *   n         基行数（总求值次数 n·(k+2)）；Sobol 时宜取 2 的幂
 *   method    'sobol'（缺省）| 'mc'
 *   scramble  Sobol 是否加扰，缺省 true
 *   blocks    独立重复份数 R（n 须被整除）。加扰 Sobol 时每份独立加扰，作为 bootstrap 的块；
 *             不加扰时为同一序列的连续 n/R 段；蒙特卡洛时只是分组
 *   skip      不加扰 Sobol 跳过的起始点数
 * @returns {{X:number[][], n:number, k:number, blocks:number, rowsPerBase:number}}
 *   X 共 n·(k+2) 行，按基行分组：[A_j, A_B^(1)_j, …, A_B^(k)_j, B_j]
 */
export function saltelliSample(opt = {}) {
  const { k, n } = opt
  needInt(k, 'Saltelli 因子数 k'); needInt(n, 'Saltelli 基行数 n')
  const method = opt.method || 'sobol'
  const blocks = opt.blocks == null ? 1 : opt.blocks
  needInt(blocks, 'Saltelli 块数 blocks')
  if (n % blocks) throw new Error(`基行数 n（${n}）须被块数（${blocks}）整除`)
  const seed = opt.seed == null ? DEFAULT_SEED : opt.seed
  let base
  if (method === 'sobol') {
    if (2 * k > SOBOL_MAX_DIM) throw new Error(`Saltelli + Sobol 需要 2k = ${2 * k} 维，超过 ${SOBOL_MAX_DIM}`)
    if (opt.scramble === false) {
      base = sobolSequence(n, 2 * k, { skip: opt.skip || 0 })
    } else {
      base = []
      for (let b = 0; b < blocks; b++) {
        for (const row of sobolSequence(n / blocks, 2 * k, { scramble: true, seed: deriveSeed(seed, 'saltelli', b) })) base.push(row)
      }
    }
  } else if (method === 'mc') {
    base = monteCarlo(n, 2 * k, { seed: deriveSeed(seed, 'saltelli-mc') })
  } else {
    throw new Error(`Saltelli 基样本方法只能是 'sobol' 或 'mc'：${method}`)
  }
  const X = []
  for (const row of base) {
    const A = row.slice(0, k), B = row.slice(k)
    X.push(A)
    for (let i = 0; i < k; i++) { const ab = A.slice(); ab[i] = B[i]; X.push(ab) }
    X.push(B)
  }
  return { X, n, k, blocks, rowsPerBase: k + 2 }
}

/**
 * Sobol 一阶 / 总效应指数（Jansen 估计）与块 bootstrap 区间。
 * @param {ArrayLike<number>} Y  saltelliSample 行序的模型输出，长度 n·(k+2)
 * @param {{k:number, blocks?:number, resamples?:number, seed?:number, conf?:number}} opt
 *   blocks 与抽样时一致；缺省 1 → 每个基行自成一块（i.i.d. bootstrap）
 * @returns {{S1:number[], ST:number[], S1ci:Array, STci:Array, V:number, mean:number, n:number, dropped:number, blocks:number}}
 */
export function sobolIndices(Y, opt = {}) {
  const { k } = opt
  needInt(k, 'Sobol 因子数 k')
  const per = k + 2
  if (!Y || Y.length % per) throw new Error(`输出长度（${Y && Y.length}）须为 k+2 = ${per} 的整数倍`)
  const n = Y.length / per
  const R = opt.blocks == null ? 1 : opt.blocks
  needInt(R, 'Sobol 块数 blocks')
  if (n % R) throw new Error(`基行数 n（${n}）须被块数（${R}）整除`)

  // 有效基行（k+2 个输出全有限）
  const rows = []
  let dropped = 0
  for (let j = 0; j < n; j++) {
    let ok = true
    for (let s = 0; s < per; s++) if (!Number.isFinite(Number(Y[j * per + s]))) { ok = false; break }
    if (ok) rows.push(j); else dropped++
  }
  // 中心化常数：方差对平移不变，先减掉均值，块内平方和不会因大均值而抵消丢位
  let c = 0
  for (const j of rows) c += Number(Y[j * per]) + Number(Y[j * per + k + 1])
  c = rows.length ? c / (2 * rows.length) : 0

  // 每块的可加统计量：[m, ΣA, ΣA², ΣB, ΣB², ΣdT_1…ΣdT_k, ΣdF_1…ΣdF_k]
  const L = 5 + 2 * k
  const nBlk = R > 1 ? R : n
  const rowsOf = Array.from({ length: nBlk }, () => [])
  const sums = Array.from({ length: nBlk }, () => new Float64Array(L))
  const size = n / R
  for (const j of rows) {
    const b = R > 1 ? Math.floor(j / size) : j
    rowsOf[b].push(j)
    const s = sums[b]
    const yA = Number(Y[j * per]) - c, yB = Number(Y[j * per + k + 1]) - c
    s[0] += 1; s[1] += yA; s[2] += yA * yA; s[3] += yB; s[4] += yB * yB
    for (let i = 0; i < k; i++) {
      const yi = Number(Y[j * per + 1 + i]) - c
      s[5 + i] += (yA - yi) * (yA - yi)
      s[5 + k + i] += (yB - yi) * (yB - yi)
    }
  }
  const estimate = (s) => {
    const m = s[0]
    const out = new Array(2 * k).fill(NaN)
    if (!(m >= 2)) return out
    const mean = (s[1] + s[3]) / (2 * m)
    const V = (s[2] + s[4] - 2 * m * mean * mean) / (2 * m - 1)
    if (!(V > 0)) return out
    for (let i = 0; i < k; i++) {
      out[i] = 1 - s[5 + k + i] / (2 * m * V)       // S_i
      out[k + i] = s[5 + i] / (2 * m * V)           // S_Ti
    }
    return out
  }
  const total = new Float64Array(L)
  for (const s of sums) for (let q = 0; q < L; q++) total[q] += s[q]
  const point = estimate(total)
  const acc = new Float64Array(L)
  const ci = blockBootstrap(rowsOf, (pick) => {
    acc.fill(0)
    for (const b of pick) { const s = sums[b]; for (let q = 0; q < L; q++) acc[q] += s[q] }
    return estimate(acc)
  }, opt)
  const m = total[0]
  const mean = m ? (total[1] + total[3]) / (2 * m) : NaN
  const V = m >= 1 ? (total[2] + total[4] - 2 * m * mean * mean) / (2 * m - 1) : NaN
  return {
    S1: point.slice(0, k), ST: point.slice(k),
    S1ci: ci.slice(0, k), STci: ci.slice(k),
    V, mean: mean + c, n: rows.length, dropped,
    blocks: rowsOf.filter((r) => r.length).length,
  }
}
