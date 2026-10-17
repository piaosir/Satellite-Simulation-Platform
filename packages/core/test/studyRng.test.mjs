// 参数研究 · 可复现随机数（packages/core/study/rng.mjs）自测。运行：node packages/core/test/studyRng.test.mjs
//
//   ① makeRng 与 ciNgso.js 的 makeRng 逐位一致（含 0 / 负数 / 小数 / 超 2³² / 字符串 / NaN / null 种子）；
//   ② splitmix64 对参考向量：种子 0 → e220a8397b1dcdaf、6e789e6aa1b965f4、06c45d188009454f；
//      种子 1234567 → 599ed017fb08fc85 …（Vigna 的 splitmix64.c、Java SplittableRandom 同值）；
//   ③ deriveSeed：确定性；路径的顺序 / 层级 / 字符串与整数都区分；相邻路径的子流互不相关；
//   ④ shuffle / permutation 是置换、且位置分布均匀（卡方）；
//   ⑤ 同一种子逐位可复现，不同种子不同。

import { createRequire } from 'node:module'
import {
  DEFAULT_SEED, makeRng, mix64, splitmix64, deriveSeed, childRng, randInt, shuffle, permutation, uniforms,
} from '../study/rng.mjs'

const require = createRequire(import.meta.url)
const { makeRng: ciMakeRng } = require('../utils/interference/ciNgso.js')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  cond ? pass++ : fail++
}

console.log('=== ① 与 ciNgso.makeRng 逐位一致 ===')
{
  const seeds = [0, 1, -1, 7, DEFAULT_SEED, 4294967295, 2 ** 32 + 5, 1.7, -3.9, '123', '', null, undefined, NaN, Infinity]
  let bad = []
  for (const s of seeds) {
    const a = makeRng(s), b = ciMakeRng(s)
    for (let i = 0; i < 20000; i++) {
      if (!Object.is(a(), b())) { bad.push(String(s)); break }
    }
  }
  ok(`${seeds.length} 个种子 × 2 万个数逐位相同`, !bad.length, bad.join(','))
  const r = makeRng(1)
  let lo = Infinity, hi = -Infinity, grid = true
  for (let i = 0; i < 100000; i++) {
    const u = r()
    lo = Math.min(lo, u); hi = Math.max(hi, u)
    if (!Number.isInteger(u * 4294967296)) grid = false
  }
  ok('输出在 [0,1) 且是 2⁻³² 的整数倍', lo >= 0 && hi < 1 && grid, `[${lo}, ${hi}]`)
}

console.log('=== ② splitmix64 参考向量 ===')
{
  const g0 = splitmix64(0)
  const v0 = [g0.next(), g0.next(), g0.next()].map((v) => v.toString(16).padStart(16, '0'))
  ok('种子 0', v0.join() === 'e220a8397b1dcdaf,6e789e6aa1b965f4,06c45d188009454f', v0.join())
  const g1 = splitmix64(1234567)
  const v1 = [g1.next(), g1.next(), g1.next()].map((v) => v.toString(16).padStart(16, '0'))
  ok('种子 1234567', v1.join() === '599ed017fb08fc85,2c73f08458540fa5,883ebce5a3f27c77', v1.join())
  ok('mix64(0) = 0（双射的不动点，口径核对）', mix64(0n) === 0n)
  // 第 i 个输出 = mix64(seed + (i+1)·γ)：deriveSeed 依赖的随机访问性质
  const g = splitmix64(99)
  let same = true
  for (let i = 0; i < 10; i++) {
    const want = mix64(99n + BigInt(i + 1) * 0x9E3779B97F4A7C15n)
    if (g.next() !== want) same = false
  }
  ok('splitmix64 第 i 个输出 = mix64(s + (i+1)·γ)', same)
}

console.log('=== ③ deriveSeed ===')
{
  ok('确定性', deriveSeed(42, 'lhs', 3) === deriveSeed(42, 'lhs', 3))
  ok('空路径原样返回 seed >>> 0', deriveSeed(42) === 42 && deriveSeed(-1) === 4294967295)
  ok('路径顺序有别', deriveSeed(42, 1, 2) !== deriveSeed(42, 2, 1))
  ok('层级有别', deriveSeed(42, 1, 2) !== deriveSeed(42, 1) && deriveSeed(42, 1, 2) !== deriveSeed(42, 2))
  ok('父种子有别', deriveSeed(1, 'x') !== deriveSeed(2, 'x'))
  ok('字符串路径确定且区分', deriveSeed(7, 'sobol') === deriveSeed(7, 'sobol') && deriveSeed(7, 'sobol') !== deriveSeed(7, 'lhs'))
  ok('子种子是 uint32', [0, 1, 2, 3, 'a'].every((k) => { const s = deriveSeed(123, k); return Number.isInteger(s) && s >= 0 && s < 2 ** 32 }))
  let threw = false
  try { deriveSeed(1, -1) } catch { threw = true }
  ok('负数路径元素报错', threw)

  const seen = new Set()
  for (let i = 0; i < 1000; i++) seen.add(deriveSeed(DEFAULT_SEED, i))
  ok('1000 个相邻路径的子种子互不相同', seen.size === 1000)

  // 相邻子流的样本相关：|ρ| < 4/√n
  const n = 100000
  let worst = 0
  for (let i = 0; i < 5; i++) {
    const a = uniforms(childRng(DEFAULT_SEED, i), n), b = uniforms(childRng(DEFAULT_SEED, i + 1), n)
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0
    for (let j = 0; j < n; j++) { sa += a[j]; sb += b[j]; sab += a[j] * b[j]; saa += a[j] * a[j]; sbb += b[j] * b[j] }
    const rho = (sab - sa * sb / n) / Math.sqrt((saa - sa * sa / n) * (sbb - sb * sb / n))
    worst = Math.max(worst, Math.abs(rho))
  }
  ok('相邻子流样本相关 |ρ| < 4/√n', worst < 4 / Math.sqrt(n), `max |ρ| = ${worst.toExponential(2)}`)

  // 子流首个输出的均匀性（种子派生得好，2000 条流的首个数应均匀铺满 [0,1)）：10 格卡方，9 自由度 0.1% 临界 27.88
  const bins = new Array(10).fill(0)
  for (let i = 0; i < 2000; i++) bins[Math.floor(childRng(1, i)() * 10)]++
  const chi = bins.reduce((s, c) => s + (c - 200) ** 2 / 200, 0)
  ok('2000 条子流首个输出均匀（卡方 < 27.88）', chi < 27.88, `χ² = ${chi.toFixed(2)}`)
}

console.log('=== ④ shuffle / permutation ===')
{
  const r = makeRng(5)
  const p = permutation(r, 1000)
  const sorted = Array.from(p).sort((a, b) => a - b)
  ok('permutation 是 0…n−1 的置换', sorted.every((v, i) => v === i))
  // 5 元素置换里元素 0 落在各位置的频数：5 万次，期望各 1 万；4 自由度 0.1% 临界 18.47
  const cnt = new Array(5).fill(0)
  for (let t = 0; t < 50000; t++) cnt[Array.from(permutation(r, 5)).indexOf(0)]++
  const chi = cnt.reduce((s, c) => s + (c - 10000) ** 2 / 10000, 0)
  ok('置换位置分布均匀（卡方 < 18.47）', chi < 18.47, `χ² = ${chi.toFixed(2)}`)
  const arr = ['a', 'b', 'c', 'd']
  ok('shuffle 原地洗牌并返回原数组', shuffle(makeRng(1), arr) === arr && arr.slice().sort().join('') === 'abcd')
  const ints = Array.from({ length: 10000 }, () => randInt(r, 7))
  ok('randInt 落在 [0, n)', ints.every((v) => Number.isInteger(v) && v >= 0 && v < 7))
}

console.log('=== ⑤ 可复现 ===')
{
  const a = uniforms(childRng(2026, 'x', 1), 1000), b = uniforms(childRng(2026, 'x', 1), 1000)
  ok('同种子同路径逐位相同', a.every((v, i) => Object.is(v, b[i])))
  const c = uniforms(childRng(2027, 'x', 1), 1000)
  ok('换种子即不同', c.some((v, i) => v !== a[i]))
  const p1 = permutation(makeRng(9), 50), p2 = permutation(makeRng(9), 50)
  ok('同种子置换相同', p1.every((v, i) => v === p2[i]))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
