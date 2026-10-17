// 参数研究 · 敏感性分析（packages/core/study/sensitivity.mjs）自测。运行：node packages/core/test/studySensitivity.test.mjs
//
//   ① 块 bootstrap 与 ciNgso.bootstrapPercentiles（多历元）口径一致：同一组块、同一种子，mean / lo / hi 逐位相同；
//   ② Ishigami（a = 7，b = 0.1，x_i ~ U(−π, π)）：解析 S_i / S_Ti 落在置信区间内（加扰 Sobol 与蒙特卡洛两种基样本）；
//   ③ 区间覆盖率：蒙特卡洛基样本 200 次独立重复，名义 95% 区间的实际覆盖率；
//   ④ Sobol-G（k = 8，a = 0, 1, 4.5, 9, 99, 99, 99, 99）：16 个解析指数全部落在区间内；
//   ⑤ 样本数翻倍，区间宽度按 1/√N 收缩：N = 512…8192 的平均宽度，相邻比 ≈ 0.707、对数斜率 ≈ −0.5；
//      按块（独立加扰的 Sobol 重复）翻倍同理；
//   ⑥ Morris：线性函数的基本效应精确等于系数（σ = 0）；Sobol-G 的 μ* 排序；轨迹结构；散布优化；
//   ⑦ 求值失败（NaN）只丢所在的基行 / 轨迹；同一种子逐位可复现；入参不合法报错。
//
// 解析式：
//   Ishigami：V = 1/2 + a²/8 + bπ⁴/5 + b²π⁸/18；V₁ = ½(1 + bπ⁴/5)²；V₂ = a²/8；V₃ = 0；V₁₃ = 8b²π⁸/225；
//            S_T1 = (V₁ + V₁₃)/V，S_T2 = V₂/V，S_T3 = V₁₃/V。
//   Sobol-G：G = Π (|4x_i − 2| + a_i)/(1 + a_i)；V_i = 1/(3(1 + a_i)²)，V = Π(1 + V_i) − 1，
//            S_i = V_i/V，S_Ti = V_i·Π_{j≠i}(1 + V_j)/V。

import { createRequire } from 'node:module'
import {
  blockBootstrap, BOOTSTRAP_MIN_BLOCKS, morrisSample, morrisAnalyze, saltelliSample, sobolIndices,
} from '../study/sensitivity.mjs'
import { mapUnit } from '../study/distributions.mjs'
import { makeRng } from '../study/rng.mjs'

const require = createRequire(import.meta.url)
const CI = require('../utils/interference/ciNgso.js')

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  cond ? pass++ : fail++
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const inside = (c, v) => c && c.lo <= v && v <= c.hi
const fmtCi = (v, c) => `${v.toFixed(4)} [${c.lo.toFixed(4)}, ${c.hi.toFixed(4)}]`

// ─── 基准函数 ───
const A_ISH = 7, B_ISH = 0.1, PI = Math.PI
const ishigami = ([x1, x2, x3]) => Math.sin(x1) + A_ISH * Math.sin(x2) ** 2 + B_ISH * x3 ** 4 * Math.sin(x1)
const ISH_DISTS = [0, 1, 2].map(() => ({ type: 'uniform', lower: -PI, upper: PI }))
const ISH = (() => {
  const V = 0.5 + A_ISH ** 2 / 8 + B_ISH * PI ** 4 / 5 + B_ISH ** 2 * PI ** 8 / 18
  const V1 = 0.5 * (1 + B_ISH * PI ** 4 / 5) ** 2, V2 = A_ISH ** 2 / 8, V13 = 8 * B_ISH ** 2 * PI ** 8 / 225
  return { V, S1: [V1 / V, V2 / V, 0], ST: [(V1 + V13) / V, V2 / V, V13 / V] }
})()
const ishY = (X) => mapUnit(X, ISH_DISTS).map(ishigami)

const A_G = [0, 1, 4.5, 9, 99, 99, 99, 99]
const sobolG = (x) => x.reduce((p, xi, i) => p * (Math.abs(4 * xi - 2) + A_G[i]) / (1 + A_G[i]), 1)
const G = (() => {
  const Vi = A_G.map((a) => 1 / (3 * (1 + a) ** 2))
  const V = Vi.reduce((p, v) => p * (1 + v), 1) - 1
  return {
    S1: Vi.map((v) => v / V),
    ST: Vi.map((v, i) => v * Vi.reduce((p, w, j) => (j === i ? p : p * (1 + w)), 1) / V),
  }
})()

console.log('=== ① 块 bootstrap ≡ ciNgso.bootstrapPercentiles ===')
{
  const rng = makeRng(31)
  const blocks = Array.from({ length: 11 }, (_, b) => Array.from({ length: 150 + 37 * b }, () => 20 + 10 * rng() + (b % 3)))
  const P = [0.1, 1, 10, 50]
  const sorted = blocks.map((b) => Float64Array.from(b).sort())
  const stat = (pick) => {
    let len = 0
    for (const b of pick) len += sorted[b].length
    const arr = new Float64Array(len)
    let off = 0
    for (const b of pick) { arr.set(sorted[b], off); off += sorted[b].length }
    arr.sort()
    return P.map((p) => CI.percentileWorst(arr, p))
  }
  for (const opt of [{ seed: 77, resamples: 150 }, {}]) {
    const ref = CI.bootstrapPercentiles(blocks, P, opt)
    const ours = blockBootstrap(blocks, stat, opt)
    const same = P.every((p, i) => ['mean', 'lo', 'hi', 'resamples', 'blocks', 'lowResolution'].every((key) => Object.is(ours[i][key], ref[p][key])))
    ok(`同一组块${opt.seed ? '、seed 77、150 次' : '、缺省种子与次数'}：mean / lo / hi / 次数 / 块数 / lowResolution 逐位相同`, same,
      `p=1%: ${fmtCi(ours[1].mean, ours[1])}`)
  }
  const few = blockBootstrap(blocks.slice(0, 5), stat, {})
  ok(`块数 < ${BOOTSTRAP_MIN_BLOCKS} 置 lowResolution`, few[0].lowResolution === true && few[0].blocks === 5)
  const withEmpty = blockBootstrap([[], blocks[0], [], blocks[1]], (pick) => [pick.reduce((s, b) => s + b, 0)], { seed: 1 })
  ok('空块剔除，pick 用原下标', withEmpty[0].blocks === 2 && withEmpty[0].lo >= 2 && withEmpty[0].hi <= 6)
  ok('置信水平参数生效（90% 区间 ⊂ 95% 区间）', (() => {
    const a = blockBootstrap(blocks, stat, { seed: 3, conf: 0.9 })[3], b = blockBootstrap(blocks, stat, { seed: 3 })[3]
    return a.lo >= b.lo && a.hi <= b.hi
  })())
}

console.log('=== ② Ishigami ===')
{
  // 缺省配置（加扰 Sobol、每个基行自成一块）：i.i.d. bootstrap 量的是逐行方差，对 QMC 偏保守，单次运行即应全覆盖。
  // 蒙特卡洛基样本下区间是名义 95%：6 个区间同时覆盖的概率只有约 0.95⁶ ≈ 0.74，单次运行不作「全覆盖」断言，
  // 改在 ③ 里用 200 次独立重复检验覆盖率。
  {
    const s = saltelliSample({ k: 3, n: 4096, seed: 11 })
    const r = sobolIndices(ishY(s.X), { k: 3 })
    const allIn = [0, 1, 2].every((i) => inside(r.S1ci[i], ISH.S1[i]) && inside(r.STci[i], ISH.ST[i]))
    ok('加扰 Sobol N = 2¹²：解析 S_i、S_Ti 全部落在 95% 区间内', allIn,
      `S1 ${[0, 1, 2].map((i) => fmtCi(r.S1[i], r.S1ci[i])).join(' ')}；ST ${[0, 1, 2].map((i) => fmtCi(r.ST[i], r.STci[i])).join(' ')}`)
    const err = Math.max(...[0, 1, 2].flatMap((i) => [Math.abs(r.S1[i] - ISH.S1[i]), Math.abs(r.ST[i] - ISH.ST[i])]))
    ok('加扰 Sobol N = 2¹²：点估计最大误差 < 0.01', err < 0.01, err.toFixed(4))
  }
  {
    const s = saltelliSample({ k: 3, n: 8192, method: 'mc', seed: 11 })
    const r = sobolIndices(ishY(s.X), { k: 3 })
    const err = Math.max(...[0, 1, 2].flatMap((i) => [Math.abs(r.S1[i] - ISH.S1[i]), Math.abs(r.ST[i] - ISH.ST[i])]))
    const half = Math.max(...r.S1ci.concat(r.STci).map((c) => (c.hi - c.lo) / 2))
    ok('蒙特卡洛 N = 2¹³：点估计最大误差 < 最宽区间的半宽（误差与区间同量级）', err < half, `误差 ${err.toFixed(4)}，半宽 ${half.toFixed(4)}`)
  }
  const s = saltelliSample({ k: 3, n: 4096, seed: 11 })
  const r = sobolIndices(ishY(s.X), { k: 3 })
  ok(`方差与均值对解析值（V = ${ISH.V.toFixed(4)}，E = a/2 = 3.5）`, Math.abs(r.V / ISH.V - 1) < 0.02 && Math.abs(r.mean - 3.5) < 0.05,
    `V ${r.V.toFixed(4)}，E ${r.mean.toFixed(4)}`)
  ok('S_T3 > 0 而 S_3 ≈ 0：x3 只经交互起作用', r.ST[2] > 0.2 && Math.abs(r.S1[2]) < 0.05)
}

console.log('=== ③ 区间覆盖率（蒙特卡洛，200 次独立重复） ===')
{
  const R = 200, cover = new Array(6).fill(0)
  const truth = ISH.S1.concat(ISH.ST)
  for (let rep = 0; rep < R; rep++) {
    const s = saltelliSample({ k: 3, n: 256, method: 'mc', seed: 1000 + rep })
    const r = sobolIndices(ishY(s.X), { k: 3, seed: rep })
    r.S1ci.concat(r.STci).forEach((c, i) => { if (inside(c, truth[i])) cover[i]++ })
  }
  const rate = cover.map((c) => c / R)
  const avg = rate.reduce((a, b) => a + b, 0) / 6
  ok('名义 95%：6 个指数的平均覆盖率 ≥ 0.90，每个 ≥ 0.85', avg >= 0.9 && rate.every((x) => x >= 0.85), rate.map((x) => x.toFixed(3)).join(' '))
}

console.log('=== ④ Sobol-G ===')
{
  const s = saltelliSample({ k: 8, n: 8192, seed: 5 })
  const r = sobolIndices(s.X.map(sobolG), { k: 8 })
  let n = 0
  for (let i = 0; i < 8; i++) { if (inside(r.S1ci[i], G.S1[i])) n++; if (inside(r.STci[i], G.ST[i])) n++ }
  ok('16 个解析指数全部落在 95% 区间内', n === 16, `${n}/16`)
  const eT = Math.max(...r.ST.map((v, i) => Math.abs(v - G.ST[i]))), e1 = Math.max(...r.S1.map((v, i) => Math.abs(v - G.S1[i])))
  ok('点估计：S_T 误差 < 0.005，S_i 误差 < 0.02', eT < 0.005 && e1 < 0.02, `S_T ${eT.toFixed(4)}，S_i ${e1.toFixed(4)}`)
  ok('重要性排序 x1 > x2 > x3 > x4 > 其余', r.ST[0] > r.ST[1] && r.ST[1] > r.ST[2] && r.ST[2] > r.ST[3] && r.ST.slice(4).every((v) => v < r.ST[3]))
}

console.log('=== ⑤ 区间宽度 ∝ 1/√N ===')
{
  const meanWidth = (opt, R) => {
    let w = 0, cnt = 0
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = saltelliSample({ k: 3, seed, ...opt })
      const r = sobolIndices(ishY(s.X), { k: 3, blocks: opt.blocks, seed, resamples: 400 })
      for (const c of r.S1ci.concat(r.STci)) { w += c.hi - c.lo; cnt++ }
    }
    return w / cnt
  }
  const slope = (xs, ys) => {
    const lx = xs.map(Math.log), ly = ys.map(Math.log)
    const mx = lx.reduce((a, b) => a + b) / lx.length, my = ly.reduce((a, b) => a + b) / ly.length
    return lx.reduce((s, x, i) => s + (x - mx) * (ly[i] - my), 0) / lx.reduce((s, x) => s + (x - mx) ** 2, 0)
  }
  const Ns = [512, 1024, 2048, 4096, 8192]
  const W = Ns.map((n) => meanWidth({ n, method: 'mc' }))
  const ratios = W.slice(1).map((w, i) => w / W[i])
  ok('蒙特卡洛：N 每翻一倍宽度比 ∈ [0.62, 0.80]（理论 1/√2 = 0.707）', ratios.every((q) => q >= 0.62 && q <= 0.8), ratios.map((q) => q.toFixed(3)).join(' '))
  const sl = slope(Ns, W)
  ok('蒙特卡洛：log 宽度 – log N 斜率 = −0.5 ± 0.08', Math.abs(sl + 0.5) <= 0.08, sl.toFixed(3))
  const Rs = [16, 32, 64, 128]
  const WB = Rs.map((R) => meanWidth({ n: 64 * R, blocks: R }, R))
  const slB = slope(Rs, WB)
  ok('独立加扰的 Sobol 重复作块：块数 16→128 的斜率 = −0.5 ± 0.12', Math.abs(slB + 0.5) <= 0.12,
    `${slB.toFixed(3)}（宽度 ${WB.map((w) => w.toFixed(4)).join(' ')}）`)
}

console.log('=== ⑥ Morris ===')
{
  const coef = [3, -2, 0.5, 0]
  const lin = (x) => x.reduce((s, v, i) => s + coef[i] * v, 1)
  const ms = morrisSample({ k: 4, r: 10, seed: 1 })
  const ml = morrisAnalyze(ms.X, ms.X.map(lin), { k: 4 })
  ok('线性函数：μ = 系数、μ* = |系数|、σ ≈ 0', ml.mu.every((v, i) => Math.abs(v - coef[i]) < 1e-12) && ml.muStar.every((v, i) => Math.abs(v - Math.abs(coef[i])) < 1e-12)
    && ml.sigma.every((v) => v < 1e-12), `μ = ${ml.mu.map((v) => +v.toFixed(12)).join(', ')}`)

  // 轨迹结构：每步只动一个因子、步长恰为 Δ、落在网格上，每个因子恰动一次
  const p = 6, k = 5
  const mt = morrisSample({ k, r: 20, levels: p, seed: 2 })
  const delta = p / (2 * (p - 1))
  let good = Math.abs(mt.delta - delta) < 1e-15
  for (let t = 0; t < 20; t++) {
    const moved = new Set()
    for (let s = 1; s <= k; s++) {
      const a = mt.X[t * (k + 1) + s - 1], b = mt.X[t * (k + 1) + s]
      const d = a.map((v, i) => b[i] - v).map((v, i) => [i, v]).filter(([, v]) => v !== 0)
      if (d.length !== 1 || Math.abs(Math.abs(d[0][1]) - delta) > 1e-12 || moved.has(d[0][0])) good = false
      moved.add(d[0] && d[0][0])
    }
    if (moved.size !== k) good = false
  }
  ok(`轨迹结构：每步只动一个因子 ±Δ（Δ = p/(2(p−1)) = ${delta}），每因子恰一次`, good)
  ok('网格：edges 取 l/(p−1)', mt.X.every((r) => r.every((v) => Math.abs(v * (p - 1) - Math.round(v * (p - 1))) < 1e-12)))
  const mc = morrisSample({ k, r: 10, levels: 4, grid: 'centered', seed: 2 })
  ok("网格：'centered' 不落在 0 / 1 上（(l+½)/p）", mc.X.every((r) => r.every((v) => v > 0 && v < 1 && Number.isInteger(v * 4 - 0.5))))

  // 散布优化：从 60 条候选里挑 15 条，总散布大于直接取前 15 条
  const spread = (X, r, kk) => {
    const T = Array.from({ length: r }, (_, t) => X.slice(t * (kk + 1), (t + 1) * (kk + 1)))
    let s = 0
    for (let a = 0; a < r; a++) for (let b = a + 1; b < r; b++) {
      let d = 0
      for (const x of T[a]) for (const y of T[b]) d += Math.hypot(...x.map((v, i) => v - y[i]))
      s += d * d
    }
    return Math.sqrt(s)
  }
  const plain = morrisSample({ k: 6, r: 60, seed: 4 })
  const picked = morrisSample({ k: 6, r: 15, candidates: 60, seed: 4 })
  const sp0 = spread(plain.X.slice(0, 15 * 7), 15, 6), sp1 = spread(picked.X, 15, 6)
  ok('Campolongo 散布判据：挑出的 15 条总散布 > 同批候选的前 15 条', sp1 > sp0, `${sp0.toFixed(1)} → ${sp1.toFixed(1)}`)

  const sg = morrisSample({ k: 8, r: 40, candidates: 80, seed: 3 })
  const mg = morrisAnalyze(sg.X, sg.X.map(sobolG), { k: 8 })
  const order = mg.muStar.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).map(([, i]) => i)
  ok('Sobol-G：μ* 排序 x1 > x2 > x3 > x4，后四个 < x1 的 5%', order.slice(0, 4).join() === '0,1,2,3' && mg.muStar.slice(4).every((v) => v < 0.05 * mg.muStar[0]),
    `μ* = ${mg.muStar.map((v) => v.toFixed(3)).join(' ')}`)
  ok('μ* 的 bootstrap 区间包住点估计，块 = 轨迹', mg.muStarCi.every((c, i) => inside(c, mg.muStar[i]) && c.blocks === 40))

  const Ybad = sg.X.map(sobolG)
  Ybad[3] = NaN; Ybad[9 * 3 + 5] = Infinity      // 第 0 条与第 3 条轨迹各坏一个点
  const mb = morrisAnalyze(sg.X, Ybad, { k: 8 })
  ok('求值失败的轨迹整条丢弃并计数', mb.r === 38 && mb.dropped === 2 && mb.muStar.every(Number.isFinite))
  ok('不是 Morris 设计（一步动两个因子）报错', throws(() => morrisAnalyze([[0, 0], [1, 1], [1, 0]], [0, 1, 2], { k: 2 })))
  ok('网格级数为奇数报错', throws(() => morrisSample({ k: 3, r: 2, levels: 5 })))
  ok('候选轨迹数非整数或小于 r 报错（不再悄悄返回空设计）', throws(() => morrisSample({ k: 3, r: 5, candidates: 'auto' }))
    && throws(() => morrisSample({ k: 3, r: 5, candidates: 3 })) && morrisSample({ k: 3, r: 5, candidates: 5 }).X.length === 20)
}

console.log('=== ⑦ 失败点 / 可复现 / 入参 ===')
{
  const s = saltelliSample({ k: 3, n: 1024, seed: 21 })
  const Y = ishY(s.X)
  const base = sobolIndices(Y, { k: 3 })
  const Yb = Y.slice()
  for (let j = 0; j < 10; j++) Yb[j * 50 * 5 + (j % 5)] = NaN   // 10 个不同基行各坏一个
  const r = sobolIndices(Yb, { k: 3 })
  ok('求值失败只丢所在基行：dropped = 10，其余照算', r.dropped === 10 && r.n === 1014 && r.S1.every(Number.isFinite)
    && r.ST.every((v, i) => Math.abs(v - base.ST[i]) < 0.02))
  const again = sobolIndices(ishY(saltelliSample({ k: 3, n: 1024, seed: 21 }).X), { k: 3 })
  ok('同一种子：抽样、点估计与区间逐位相同', JSON.stringify(again) === JSON.stringify(base))
  const other = sobolIndices(Y, { k: 3, seed: 99 })
  ok('只换 bootstrap 种子：点估计不变、区间变', JSON.stringify(other.S1) === JSON.stringify(base.S1) && other.S1ci[0].lo !== base.S1ci[0].lo)
  const lay = saltelliSample({ k: 2, n: 4, method: 'mc', seed: 1 })
  const okLayout = [0, 1, 2, 3].every((j) => {
    const [A, AB1, AB2, B] = lay.X.slice(j * 4, j * 4 + 4)
    return AB1[0] === B[0] && AB1[1] === A[1] && AB2[0] === A[0] && AB2[1] === B[1]
  })
  ok('行序 [A, A_B^(1), …, A_B^(k), B]：A_B^(i) 只有第 i 列取自 B', okLayout && lay.X.length === 16)
  ok('输出长度不是 k+2 的倍数报错', throws(() => sobolIndices([1, 2, 3, 4, 5, 6, 7], { k: 3 })))
  ok('块数不整除基行数报错', throws(() => saltelliSample({ k: 3, n: 100, blocks: 8 })) && throws(() => sobolIndices(Y, { k: 3, blocks: 7 })))
  ok('2k 超过 Sobol 维数上限报错', throws(() => saltelliSample({ k: 600, n: 8 })))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
