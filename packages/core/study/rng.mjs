// 参数研究 · 可复现随机数：mulberry32 主序列 + splitmix64 派生子种子。
//
// 口径（与 packages/core/utils/interference/ciNgso.js 的 makeRng 逐位一致，单测 studyRng 守着）：
//   · makeRng(seed) 返回 () => [0, 1) 的函数，分辨率 2⁻³²；
//   · seed 先 Number() 再 >>> 0 截成 uint32，截完为 0（含 NaN / undefined / null）记为 1——这是
//     ciNgso 原样的口径，本库不另立规矩；
//   · 同一 seed 永远同一串。研究可复现全靠这一条：界面上的「种子」+ 本库 = 结果逐位重现。
//
// 子种子（deriveSeed）：一次研究里同时有好几条随机流——设计撒点、相关性重排、优化器变异、bootstrap。
// 都用同一个 seed，各流开头的数完全相同，抽样与 bootstrap 就相关了；用 seed+1、seed+2 也不行，
// mulberry32 对相邻种子没有任何独立性保证。这里用 splitmix64 把「父种子 + 路径」混成子种子：
//   Steele, Lea & Flood, "Fast splittable pseudorandom number generators", OOPSLA 2014
//   （即 Java SplittableRandom 的 mix64 与 GOLDEN_GAMMA；参考向量见单测）。
// splitmix64 的第 i 个输出 = mix64(s + (i+1)·γ)，可随机访问：子流 i 不必先生成前 i−1 个；
// 相邻 i 经 64 位雪崩混合后互不相关。
//
// 64 位整数用 BigInt：派生只在建流时做一次，不在逐样本的热路径上，慢一点无所谓。
//
// 导出：
//   DEFAULT_SEED                        缺省种子（与 ciNgso 的 bootstrap / 历元抽样同值）
//   makeRng(seed) → () => [0,1)         mulberry32
//   mix64(z) / splitmix64(seed)         splitmix64 混合函数与生成器（BigInt）
//   deriveSeed(seed, ...path) → uint32  路径元素为非负整数或字符串
//   childRng(seed, ...path)             = makeRng(deriveSeed(seed, ...path))
//   randInt / shuffle / permutation / uniforms   基于任一 rng 的小工具

/** 缺省种子。各函数 opt.seed 缺省时用它，与 ciNgso bootstrapPercentiles / makeEpochs 一致。 */
export const DEFAULT_SEED = 20260728

/** mulberry32：小而稳的确定性 PRNG。逐行照抄 ciNgso.js 的 makeRng（不 import：本库不依赖业务模块）。 */
export function makeRng(seed) {
  let a = (Number(seed) >>> 0) || 1
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ───────────────────────── splitmix64 ─────────────────────────

const GOLDEN_GAMMA = 0x9E3779B97F4A7C15n

/** splitmix64 的输出混合（Stafford variant 13）：uint64 → uint64 的双射。入参 BigInt。 */
export function mix64(z) {
  z = BigInt.asUintN(64, z)
  z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n)
  z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94D049BB133111EBn)
  return z ^ (z >> 31n)
}

/**
 * splitmix64 生成器：next() 返回 uint64（BigInt）。
 * 本库只用它派生种子，不用它出均匀数；单独导出是为了让单测能对参考向量。
 * @param {bigint|number} seed  整数（Number 须为安全整数）
 */
export function splitmix64(seed) {
  let s = BigInt.asUintN(64, BigInt(seed))
  return {
    next() {
      s = BigInt.asUintN(64, s + GOLDEN_GAMMA)
      return mix64(s)
    },
  }
}

/** 路径元素 → uint32：整数取 >>> 0；字符串取 FNV-1a（按 UTF-16 码元），保证跨平台同值。 */
function pathKey(k) {
  if (typeof k === 'string') {
    let h = 0x811C9DC5
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193)
    return h >>> 0
  }
  const v = Number(k)
  if (!Number.isInteger(v) || v < 0) throw new Error(`派生种子的路径元素须为非负整数或字符串：${k}`)
  return v >>> 0
}

/**
 * 由父种子与路径派生子种子（uint32）。逐级做「splitmix64 第 key+1 个输出」：
 *   s₀ = seed（uint32 当 uint64），s_{j+1} = mix64(s_j + (key_j + 1)·γ)，结果取最后一级的高 32 位。
 * 中间级保留全部 64 位，所以 ('a', 1) 与 ('a', 2)、(1, 'a') 与 ('a', 1) 都是互不相关的流。
 * 路径为空时原样返回 seed >>> 0（不派生）。
 */
export function deriveSeed(seed, ...path) {
  if (!path.length) return Number(seed) >>> 0
  let s = BigInt(Number(seed) >>> 0)
  for (const k of path) s = mix64(s + (BigInt(pathKey(k)) + 1n) * GOLDEN_GAMMA)
  return Number(s >> 32n)
}

/** 子流：makeRng(deriveSeed(seed, ...path))。各模块按用途各取一条，互不串扰。 */
export function childRng(seed, ...path) {
  return makeRng(deriveSeed(seed, ...path))
}

// ───────────────────────── 小工具 ─────────────────────────

/** [0, n) 上的均匀整数。取 floor(u·n)：n ≪ 2³² 时偏差 ≤ n/2³²，与 ciNgso 抽块的写法一致。 */
export function randInt(rng, n) {
  return Math.floor(rng() * n)
}

/** Fisher–Yates（Durstenfeld）原地洗牌，返回原数组。从尾往前，每位消耗一个 rng()。 */
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

/** 0…n−1 的随机排列（Int32Array）。 */
export function permutation(rng, n) {
  const p = new Int32Array(n)
  for (let i = 0; i < n; i++) p[i] = i
  return shuffle(rng, p)
}

/** n 个 [0,1) 均匀数（Float64Array），按生成顺序。 */
export function uniforms(rng, n) {
  const out = new Float64Array(n)
  for (let i = 0; i < n; i++) out[i] = rng()
  return out
}
