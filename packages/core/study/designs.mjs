// 参数研究 · 试验设计：全因子、拉丁超立方（maximin 优化）、Sobol 序列、蒙特卡洛。
//
// 除全因子外，设计一律产出单位超立方体 [0,1)^k 上的点（n 行 × k 列，number[][]），再由
// distributions.mjs 的 mapUnit 逐列映射到各参数的分布——撒点方式与参数分布在这里彻底解耦。
// 随机设计都吃 opt.seed（缺省 DEFAULT_SEED），内部按用途各派生一条子流（rng.mjs 的 deriveSeed），
// 同一 seed 逐位可复现。
//
// ─── 拉丁超立方 + maximin ───────────────────────────────────────────────────
// LHS（McKay, Beckman & Conover, Technometrics 21 (1979) 239–245）保证每个边缘恰好每层一个点，但多维上
// 可能聚成一团。maximin 优化按 Morris & Mitchell (J. Stat. Plan. Inference 43 (1995) 381–402) 的 φ_p 判据
// （φ_p = (Σ d_ij^−p)^(1/p)，p 大时 ≈ 1/最小点距，又比「最小点距」光滑）做模拟退火；
// 扰动是「同一列里交换两行的值」，各列取值集合不变，LHS 性质天然保持。交换只改动两行到其余各行的距离，
// 每步增量 O(n)。距离阵 n² 个双精度，n 超过 MAXIMIN_MAX_N 时不做优化（直接返回随机 LHS）。
//
// ─── Sobol ─────────────────────────────────────────────────────────────────
// Sobol' (USSR Comput. Math. Math. Phys. 7 (1967) 86–112)，Antonov & Saleev (1979) 的 Gray 码递推
// （逐点一次异或）；方向数用 Joe & Kuo (2008) 的 new-joe-kuo-6，前 1111 维，出处与许可见 sobolJoeKuo.mjs。
// 第 1 维取全 1 的初始方向数（van der Corput），与 Joe–Kuo 的 sobol.cc、SciPy 一致。
// 32 位精度：u = x / 2³²，点数上限 2³² − 1。平衡性质要求 n 取 2 的幂（每一维前 2^m 个点每个 2^−m 区间恰一个）。
//
// 加扰（opt.scramble）：线性矩阵加扰 + 数字移位（Matoušek, J. Complexity 14 (1998) 527–556；
// 与 SciPy qmc.Sobol 的缺省加扰同一做法）。每维取一个随机的单位下三角 0/1 阵 L 左乘生成矩阵，再异或一个
// 随机 32 位数。网格性质（上面的平衡性质）原样保留，点不再落在 0 上，独立的几次加扰互为独立重复——
// 这正是 sensitivity.mjs 里块 bootstrap 需要的「块」。
//
// 导出：
//   fullFactorial(levels)                         全因子（末维变化最快）
//   latinHypercube(n, k, opt)                     LHS，缺省 maximin 优化
//   createSobol(k, opt) / sobolSequence(n, k, opt)
//   monteCarlo(n, k, opt)
//   minDistance(X) / phiP(X, p)                   点集的最小点距与 φ_p（读数用）
//   scaleToBounds(U, lower, upper)                单位设计 → 各维 [lower, upper] 的仿射映射

import { DEFAULT_SEED, childRng, permutation, randInt } from './rng.mjs'
import { JOE_KUO_D6, JOE_KUO_MAX_DIM } from './sobolJoeKuo.mjs'

const TWO32 = 4294967296

function needInt(v, name, min = 1) {
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} 须为 ≥ ${min} 的整数：${v}`)
}

function toRows(X, n, k) {
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = Array.from(X.subarray(i * k, i * k + k))
  return out
}

// ───────────────────────── 全因子 ─────────────────────────

/** 全因子设计的组合数上限：再多就不是「设计」而是穷举了，且一次物化成数组会把内存吃光。 */
export const FULL_FACTORIAL_MAX = 10_000_000

/**
 * 全因子：各因子水平的笛卡儿积，末维变化最快（与嵌套 for 循环同序）。
 * @param {Array<number|Array>} levels 每个因子：整数 m → 单位区间上的 m 个等距水平（含两端；m = 1 取 0.5）；
 *                                     数组 → 直接作为水平取值（可以是任意值，如调制方式名）
 * @returns {Array<Array>} 每行一个组合
 */
export function fullFactorial(levels) {
  if (!levels || !levels.length) throw new Error('全因子至少需要 1 个因子')
  const axes = Array.from(levels, (L, j) => {
    if (typeof L === 'number') {
      needInt(L, `第 ${j} 个因子的水平数`)
      return L === 1 ? [0.5] : Array.from({ length: L }, (_, i) => i / (L - 1))
    }
    const arr = Array.from(L || [])
    if (!arr.length) throw new Error(`第 ${j} 个因子没有水平`)
    return arr
  })
  const total = axes.reduce((a, ax) => a * ax.length, 1)
  if (total > FULL_FACTORIAL_MAX) throw new Error(`全因子组合数 ${total} 超过上限 ${FULL_FACTORIAL_MAX}`)
  const k = axes.length
  const idx = new Array(k).fill(0)
  const out = new Array(total)
  for (let r = 0; r < total; r++) {
    out[r] = axes.map((ax, j) => ax[idx[j]])
    for (let j = k - 1; j >= 0; j--) {
      if (++idx[j] < axes[j].length) break
      idx[j] = 0
    }
  }
  return out
}

// ───────────────────────── 拉丁超立方 ─────────────────────────

/** maximin 优化的点数上限（距离阵 n² 个双精度：2000 点 = 32 MB）。 */
export const MAXIMIN_MAX_N = 2000

/** r^e：e 为整数时用平方求幂（φ_p 的热路径，比 Math.pow 快一个量级），否则退回 Math.pow。 */
function powFn(e) {
  if (!Number.isInteger(e) || e < 1) return (r) => Math.pow(r, e)
  return (r) => {
    let out = 1, b = r, m = e
    while (m > 0) { if (m & 1) out *= b; b *= b; m >>>= 1 }
    return out
  }
}

/**
 * φ_p 判据的模拟退火（原地改 X，结束时 X = 过程中最好的设计）。
 *
 * 判据 S = Σ_{i<j} (d²_ref / d²_ij)^(p/2)，即 φ_p^p 按初始最小点距归一（各项初始 ≤ 1，不会溢出）。
 * 接受概率用 φ 的相对变化 Δ = ln(S'/S)/p：与点数、维数、尺度都无关，温度可以给成定值。
 * 温度从 t0 几何降到 t1；S 每 n 步按距离阵整体重算一次，免得增量更新的舍入一路累积。
 */
function maximinAnneal(X, n, k, rng, opt) {
  const p = opt.p == null ? 50 : Number(opt.p)
  if (!(p > 0)) throw new Error(`φ_p 的 p 须为正：${opt.p}`)
  // 缺省步数按工作量给：每步 O(n)，总量 ~10⁷ 次内层运算（几百毫秒）；小设计再以 1000·n·k 封顶。
  // 实测（4 个种子平均的最小点距，60 点 × 6 维）：1 万步 0.561、3 万 0.592、10 万 0.617、30 万 0.636。
  const iters = opt.iterations == null
    ? Math.min(1000 * n * k, Math.max(2000, Math.floor(1e7 / n)))
    : Math.max(0, Math.floor(opt.iterations))
  const t0 = opt.t0 == null ? 0.05 : Number(opt.t0), t1 = opt.t1 == null ? 1e-4 : Number(opt.t1)
  const D = new Float64Array(n * n)
  let ref = Infinity
  for (let i = 0; i < n; i++) {
    for (let l = i + 1; l < n; l++) {
      let s = 0
      for (let c = 0; c < k; c++) { const d = X[i * k + c] - X[l * k + c]; s += d * d }
      D[i * n + l] = D[l * n + i] = s
      if (s < ref) ref = s
    }
  }
  const pw = powFn(p / 2)
  const term = (d2) => pw(ref / d2)
  const total = () => {
    let s = 0
    for (let i = 0; i < n; i++) for (let l = i + 1; l < n; l++) s += term(D[i * n + l])
    return s
  }
  let S = total()
  let bestS = S
  const best = X.slice()
  const newI = new Float64Array(n), newL = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    const T = t0 * Math.pow(t1 / t0, it / iters)
    const c = randInt(rng, k)
    const i = randInt(rng, n)
    let l = randInt(rng, n - 1)
    if (l >= i) l++
    const xi = X[i * k + c], xl = X[l * k + c]
    let dS = 0
    for (let m = 0; m < n; m++) {
      if (m === i || m === l) continue
      const xm = X[m * k + c]
      const a = (xi - xm) * (xi - xm), b = (xl - xm) * (xl - xm)
      const di = D[i * n + m], dl = D[l * n + m]
      const ni = di - a + b, nl = dl - b + a
      newI[m] = ni; newL[m] = nl
      dS += term(ni) + term(nl) - term(di) - term(dl)
    }
    let Snew = S + dS
    if (!(Snew > S * 1e-9)) {                    // 大幅下降时增量的相对精度不够 → 精确重算
      X[i * k + c] = xl; X[l * k + c] = xi
      Snew = 0
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          let d2
          if (a === i || a === l || b === i || b === l) {
            d2 = 0
            for (let cc = 0; cc < k; cc++) { const d = X[a * k + cc] - X[b * k + cc]; d2 += d * d }
          } else d2 = D[a * n + b]
          Snew += term(d2)
        }
      }
      X[i * k + c] = xi; X[l * k + c] = xl
    }
    const delta = Math.log(Snew / S) / p
    if (delta <= 0 || rng() < Math.exp(-delta / T)) {
      X[i * k + c] = xl; X[l * k + c] = xi
      for (let m = 0; m < n; m++) {
        if (m === i || m === l) continue
        D[i * n + m] = D[m * n + i] = newI[m]
        D[l * n + m] = D[m * n + l] = newL[m]
      }
      S = Snew
      if (S < bestS) { bestS = S; best.set(X) }
    }
    if ((it + 1) % n === 0) S = total()
  }
  X.set(best)
}

/**
 * 拉丁超立方设计。
 * @param {number} n 点数
 * @param {number} k 维数
 * @param {{seed?:number, centered?:boolean, maximin?:boolean, iterations?:number, p?:number, t0?:number, t1?:number}} [opt]
 *   centered   true → 每层取层中点（(i+½)/n）；缺省 false：层内均匀随机
 *   maximin    缺省 true；n < 3、k < 2 或 n > MAXIMIN_MAX_N 时不做
 *   iterations 退火步数，缺省 min(1000·n·k, max(2000, 10⁷/n))
 *   p          φ_p 的 p，缺省 50
 *   t0 / t1    退火起止温度（φ 的相对变化量纲），缺省 0.05 / 1e-4
 *
 * 局限：二维小设计上随机交换邻域很难到达格子状的全局最优（如 n = 9 最优最小点距 √10/9，退火多停在 √8/9）；
 * 要二维最优设计请查表（van Dam et al., Oper. Res. 55 (2007) 158–169）。三维以上本法比随机 LHS 的最小点距约大一倍。
 * @returns {number[][]}
 */
export function latinHypercube(n, k, opt = {}) {
  needInt(n, 'LHS 点数 n'); needInt(k, 'LHS 维数 k')
  const seed = opt.seed == null ? DEFAULT_SEED : opt.seed
  const rp = childRng(seed, 'lhs-perm'), rj = childRng(seed, 'lhs-jitter')
  const X = new Float64Array(n * k)
  for (let c = 0; c < k; c++) {
    const perm = permutation(rp, n)
    for (let i = 0; i < n; i++) X[i * k + c] = (perm[i] + (opt.centered ? 0.5 : rj())) / n
  }
  if (opt.maximin !== false && n >= 3 && k >= 2 && n <= MAXIMIN_MAX_N) {
    maximinAnneal(X, n, k, childRng(seed, 'lhs-maximin'), opt)
  }
  return toRows(X, n, k)
}

/** 点集最小欧氏距离（O(n²k)，读数用） */
export function minDistance(X) {
  let m = Infinity
  for (let i = 0; i < X.length; i++) {
    for (let j = i + 1; j < X.length; j++) {
      let s = 0
      for (let c = 0; c < X[i].length; c++) { const d = X[i][c] - X[j][c]; s += d * d }
      if (s < m) m = s
    }
  }
  return Math.sqrt(m)
}

/** Morris–Mitchell φ_p = (Σ_{i<j} d_ij^−p)^(1/p)，越小越好（按最小点距归一后计算，避免溢出） */
export function phiP(X, p = 50) {
  const dm = minDistance(X)
  if (!(dm > 0)) return Infinity
  let s = 0
  for (let i = 0; i < X.length; i++) {
    for (let j = i + 1; j < X.length; j++) {
      let d2 = 0
      for (let c = 0; c < X[i].length; c++) { const d = X[i][c] - X[j][c]; d2 += d * d }
      s += Math.pow(dm / Math.sqrt(d2), p)
    }
  }
  return Math.pow(s, 1 / p) / dm
}

// ───────────────────────── Sobol ─────────────────────────

/** 可用的最大维数（= Joe–Kuo 数据的截止维） */
export const SOBOL_MAX_DIM = JOE_KUO_MAX_DIM

let directionCache = null

/** 由本原多项式（次数 s、系数编码 a）与初始方向数 m 递推出 32 个方向数 v_i = m_i·2^(32−i)（i 从 1 起） */
function directionNumbers(s, a, m) {
  const v = new Uint32Array(32)
  for (let i = 0; i < 32; i++) {
    if (i < s) {
      v[i] = m[i] * 2 ** (31 - i)
    } else {
      let x = v[i - s] ^ (v[i - s] >>> s)
      for (let t = 1; t < s; t++) if ((a >>> (s - 1 - t)) & 1) x ^= v[i - t]
      v[i] = x
    }
  }
  return v
}

/** 全部 1111 维的方向数表（首次用到时解析一次，约 140 KB） */
function directionTable() {
  if (directionCache) return directionCache
  const first = new Uint32Array(32)
  for (let i = 0; i < 32; i++) first[i] = 2 ** (31 - i)
  const out = [first]
  for (const line of JOE_KUO_D6.split('\n')) {
    if (!line.trim()) continue
    const [, s, a, ...m] = line.trim().split(' ').map(Number)
    out.push(directionNumbers(s, a, m))
  }
  directionCache = out
  return out
}

/** 32 位奇偶 */
function parity32(x) {
  x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4
  return (0x6996 >>> (x & 0xF)) & 1
}

const rand32 = (rng) => Math.floor(rng() * TWO32)

/**
 * 线性矩阵加扰：v' = L·v（GF(2)）。L 为单位下三角：输出第 r 位（r = 0 为最高位）只由输入的第 0…r 位决定，
 * 所以前 m 位之间仍是双射，网格性质不变。每维消耗 31 个随机数（r = 1…31 行的随机部分）。
 */
function lmsScramble(v, rng) {
  const rows = new Uint32Array(32)
  for (let r = 0; r < 32; r++) {
    const high = r === 0 ? 0 : TWO32 - 2 ** (32 - r)   // 比对角更高的 r 位
    rows[r] = (r === 0 ? 0 : (rand32(rng) & high)) | (2 ** (31 - r))
  }
  const out = new Uint32Array(32)
  for (let i = 0; i < 32; i++) {
    const c = v[i]
    let y = 0
    for (let r = 0; r < 32; r++) if (parity32(rows[r] & c)) y |= 1 << (31 - r)
    out[i] = y
  }
  return out
}

/**
 * Sobol 序列生成器（逐点）。
 * @param {number} k 维数，1…SOBOL_MAX_DIM
 * @param {{skip?:number, scramble?:boolean, seed?:number}} [opt]
 *   skip      跳过前 skip 个点（直接按 Gray 码定位，不逐个生成）
 *   scramble  线性矩阵加扰 + 数字移位
 * @returns {{dim:number, readonly index:number, next:()=>number[]}} next() 返回第 index 个点并前进一位
 */
export function createSobol(k, opt = {}) {
  needInt(k, 'Sobol 维数 k')
  if (k > SOBOL_MAX_DIM) throw new Error(`Sobol 维数 ${k} 超过方向数表上限 ${SOBOL_MAX_DIM}`)
  const skip = opt.skip == null ? 0 : opt.skip
  needInt(skip, 'Sobol skip', 0)
  if (skip >= TWO32 - 1) throw new Error('Sobol skip 超出 2³² − 1')
  let V = directionTable().slice(0, k)
  const shift = new Uint32Array(k)
  if (opt.scramble) {
    const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'sobol-scramble')
    V = V.map((v, j) => {
      const s = lmsScramble(v, rng)
      shift[j] = rand32(rng)
      return s
    })
  }
  const X = new Uint32Array(k)
  const g = (skip ^ (skip >>> 1)) >>> 0             // 第 skip 个点 = 其 Gray 码各位对应方向数的异或
  for (let j = 0; j < k; j++) {
    let x = shift[j]
    for (let b = 0; b < 32; b++) if ((g >>> b) & 1) x ^= V[j][b]
    X[j] = x
  }
  let index = skip
  return {
    dim: k,
    get index() { return index },
    next() {
      if (index >= TWO32 - 1) throw new Error('Sobol 序列已用尽（2³² − 1 个点）')
      const row = new Array(k)
      for (let j = 0; j < k; j++) row[j] = X[j] / TWO32
      const nx = index + 1
      const c = 31 - Math.clz32(nx & -nx)           // index 的最低零位 = 下一个 Gray 码翻转的位
      for (let j = 0; j < k; j++) X[j] ^= V[j][c]
      index = nx
      return row
    },
  }
}

/**
 * n 个 k 维 Sobol 点（单位超立方体）。不加扰时第 0 个点是原点 0（与 Joe–Kuo / SciPy 同）。
 * @param {number} n
 * @param {number} k
 * @param {{skip?:number, scramble?:boolean, seed?:number}} [opt] 见 createSobol
 * @returns {number[][]}
 */
export function sobolSequence(n, k, opt = {}) {
  needInt(n, 'Sobol 点数 n', 0)
  const gen = createSobol(k, opt)
  const out = new Array(n)
  for (let i = 0; i < n; i++) out[i] = gen.next()
  return out
}

// ───────────────────────── 蒙特卡洛 ─────────────────────────

/**
 * 独立均匀随机设计。按行生成（行内逐维），所以同一 seed 下 n 个点恰是 2n 个点的前 n 行——
 * 追加样本不用重跑已算的点。
 * @returns {number[][]}
 */
export function monteCarlo(n, k, opt = {}) {
  needInt(n, '蒙特卡洛点数 n', 0); needInt(k, '蒙特卡洛维数 k')
  const rng = childRng(opt.seed == null ? DEFAULT_SEED : opt.seed, 'monte-carlo')
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const row = new Array(k)
    for (let j = 0; j < k; j++) row[j] = rng()
    out[i] = row
  }
  return out
}

/** 单位设计 → 各维 [lower_j, upper_j] 的仿射映射（均匀分布参数的快捷写法，等价于 mapUnit + uniform） */
export function scaleToBounds(U, lower, upper) {
  return Array.from(U, (row) => Array.from(row, (u, j) => lower[j] + u * (upper[j] - lower[j])))
}
