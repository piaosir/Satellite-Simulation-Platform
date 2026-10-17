// 参数研究 · 概率分布与 Iman–Conover（packages/core/study/distributions.mjs）自测。
//   运行： node packages/core/test/studyDistributions.test.mjs
//
//   ① erfc 对 mpmath（60 位）参考值，相对误差 ≤ 2e-15；对称性 erfc(−x) = 2 − erfc(x)；
//   ② Φ⁻¹（AS 241）对 mpmath 参考值（含 1e-300 的极端下尾）≤ 2e-15；Φ(Φ⁻¹(p)) 往返；
//   ③ 每种分布：ppf 单调、cdf(ppf(u)) = u、支撑端点、均值 / 标准差（对 ppf 做中点求积，独立于实现里的矩公式）、
//      蒙特卡洛样本的 KS 检验；
//   ④ 截断正态远尾（[8σ, 9σ]，Φ(8) 在双精度里已只剩 1 位有效数字）对 mpmath 中位数 / 0.9 分位；
//   ⑤ 表格 CDF 的原子与空档、经验分布 step / linear、离散分布：解析值逐个手算；
//   ⑥ 非法参数一律报错（空串不许悄悄当 0）；mapUnit 在 u = 0 处不出 ±Infinity；
//   ⑦ Iman–Conover：秩相关达到目标（±0.03）、各列取值的多重集合不变、两种口径、非正定报错、可复现。
//
// 本文件里的期望值凡带「解析」二字的，都是由独立公式在测试里现算的；带「mpmath」的是 60 位精度离线算好抄进来的。

import {
  UNIT_EPS, clampUnitOpen, erfc, stdNormalPdf, stdNormalCdf, stdNormalSf, stdNormalPpf, normalSampler,
  makeDist, mapUnit, sampleDists, ranks, pearsonMatrix, spearmanMatrix, imanConover,
} from '../study/distributions.mjs'
import { makeRng } from '../study/rng.mjs'
import { latinHypercube } from '../study/designs.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  cond ? pass++ : fail++
}
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)
const throws = (fn) => { try { fn(); return false } catch { return true } }

console.log('=== ① erfc ===')
{
  // mpmath 60 位：erfc(x)
  const REF = [
    [-3, 1.9999779095030014], [-0.5, 1.5204998778130465], [1e-10, 0.99999999988716208],
    [0.3, 0.67137324054087257], [0.46875, 0.50738652678206201], [0.5, 0.47950012218695346],
    [1, 0.15729920705028513], [2, 0.0046777349810472658], [3.5, 7.4309837234141275e-7],
    [4, 1.5417257900280019e-8], [4.5, 1.9661604415428875e-10], [6, 2.1519736712498913e-17],
    [10, 2.0884875837625448e-45], [20, 5.3958656116079009e-176], [26, 5.6631924088561428e-296],
  ]
  let worst = 0, at = null
  for (const [x, want] of REF) { const e = rel(erfc(x), want); if (e > worst) { worst = e; at = x } }
  ok('15 个点对 mpmath 相对误差 ≤ 2e-15（三段逼近与两个分界点都覆盖）', worst <= 2e-15, `最大 ${worst.toExponential(2)} @ x=${at}`)
  let sym = 0
  for (let x = 0; x <= 6; x += 0.01) sym = Math.max(sym, Math.abs(erfc(-x) - (2 - erfc(x))))
  ok('erfc(−x) = 2 − erfc(x)', sym <= 4e-16, sym.toExponential(2))
  ok('端点：erfc(+∞) = 0、erfc(−∞) = 2、erfc(NaN) = NaN', erfc(Infinity) === 0 && erfc(-Infinity) === 2 && Number.isNaN(erfc(NaN)))
  ok('Φ 下尾保持相对精度：Φ(−30) = 0.5·erfc(30/√2)', rel(stdNormalCdf(-30), 4.906713927148187e-198) < 1e-12, stdNormalCdf(-30).toExponential(15))
  ok('Q(x) = Φ(−x)', Math.abs(stdNormalSf(1.3) - stdNormalCdf(-1.3)) < 1e-17)
  ok('φ(0) = 1/√(2π)', rel(stdNormalPdf(0), 1 / Math.sqrt(2 * Math.PI)) < 1e-15)
}

console.log('=== ② Φ⁻¹（AS 241） ===')
{
  // mpmath 400 位：Φ⁻¹(p)
  const REF = [
    [1e-300, -37.047096299361199], [1e-100, -21.273453560965324], [1e-20, -9.2623400897984076],
    [1e-10, -6.3613409024040562], [1e-5, -4.2648907939228246], [0.001, -3.0902323061678135],
    [0.025, -1.9599639845400542], [0.075, -1.4395314709384559], [0.3, -0.52440051270804078],
    [0.6, 0.2533471031357998], [0.925, 1.4395314709384559], [0.975, 1.9599639845400542], [0.999, 3.0902323061678135],
  ]
  let worst = 0, at = null
  for (const [p, want] of REF) { const e = rel(stdNormalPpf(p), want); if (e > worst) { worst = e; at = p } }
  ok('13 个点（含 1e-300）对 mpmath 相对误差 ≤ 2e-15', worst <= 2e-15, `最大 ${worst.toExponential(2)} @ p=${at}`)
  let rt = 0
  for (let e = -300; e <= -0.31; e += 0.37) { const p = 10 ** e; rt = Math.max(rt, rel(stdNormalCdf(stdNormalPpf(p)), p)) }
  ok('Φ(Φ⁻¹(p)) 往返，p ∈ [1e-300, 0.5]：相对误差 < 1e-12', rt < 1e-12, rt.toExponential(2))
  ok('Φ⁻¹(0.5) = 0、Φ⁻¹(0) = −∞、Φ⁻¹(1) = +∞、Φ⁻¹(NaN) = NaN',
    stdNormalPpf(0.5) === 0 && stdNormalPpf(0) === -Infinity && stdNormalPpf(1) === Infinity && Number.isNaN(stdNormalPpf(NaN)))
  let mono = true, prev = -Infinity
  for (let i = 1; i < 100000; i++) { const z = stdNormalPpf(i / 100000); if (!(z > prev)) mono = false; prev = z }
  ok('Φ⁻¹ 在 10 万个格点上严格递增', mono)
  const nz = normalSampler(makeRng(3))
  let s = 0, s2 = 0
  const N = 200000
  for (let i = 0; i < N; i++) { const z = nz(); s += z; s2 += z * z }
  ok('normalSampler：均值 ≈ 0、方差 ≈ 1（4σ 容差）', Math.abs(s / N) < 4 / Math.sqrt(N) && Math.abs(s2 / N - 1) < 4 * Math.sqrt(2 / N),
    `${(s / N).toFixed(4)} / ${(s2 / N).toFixed(4)}`)
}

console.log('=== ③ 各分布：ppf / cdf / 矩 / KS ===')
const SPECS = [
  ['uniform(2,5)', { type: 'uniform', lower: 2, upper: 5 }],
  ['normal(3,2)', { type: 'normal', mu: 3, sigma: 2 }],
  ['truncnormal(0,1,[−1,2])', { type: 'truncnormal', mu: 0, sigma: 1, lower: -1, upper: 2 }],
  ['truncnormal(0,1,[8,9])', { type: 'truncnormal', mu: 0, sigma: 1, lower: 8, upper: 9 }],
  ['truncnormal(10,2,(−∞,4])', { type: 'truncnormal', mu: 10, sigma: 2, upper: 4 }],
  ['truncnormal(5,1,[4.5,∞))', { type: 'truncnormal', mu: 5, sigma: 1, lower: 4.5 }],
  ['triangular(1,2,5)', { type: 'triangular', lower: 1, mode: 2, upper: 5 }],
  ['triangular(0,0,1)', { type: 'triangular', lower: 0, mode: 0, upper: 1 }],
  ['lognormal(μ=0.5,σ=0.4)', { type: 'lognormal', mu: 0.5, sigma: 0.4 }],
  ['lognormal(mean=3,sd=1)', { type: 'lognormal', mean: 3, sd: 1 }],
  ['empirical linear', { type: 'empirical', samples: [4.1, 2.2, 9.5, 3.3, 3.9, 7.0, 5.8] }],
  ['empirical 表格', { type: 'empirical', x: [0, 1, 3, 10], p: [0, 0.5, 0.9, 1] }],
]
for (const [si, [name, spec]] of SPECS.entries()) {
  const d = makeDist(spec)
  // 单调
  let mono = true, prev = -Infinity
  for (let i = 0; i <= 2000; i++) { const x = d.ppf(i / 2000); if (x < prev) mono = false; prev = x }
  // 往返
  let rtErr = 0
  for (let i = 1; i < 1000; i++) { const u = i / 1000; rtErr = Math.max(rtErr, Math.abs(d.cdf(d.ppf(u)) - u)) }
  // 中点求积：E[X] = ∫ppf(u)du，E[X²] 同理（不依赖实现里的矩公式）
  const M = 400000
  let m1 = 0, m2 = 0
  for (let i = 0; i < M; i++) { const x = d.ppf((i + 0.5) / M); m1 += x; m2 += x * x }
  m1 /= M; m2 /= M
  const sdQ = Math.sqrt(Math.max(0, m2 - m1 * m1))
  const scale = Math.max(1e-12, d.sd)
  // KS：蒙特卡洛 5000 个，α = 1% 临界 1.63/√n（连续分布下 KS 只取决于 cdf(x) 即 u，故按分布错开种子）
  const n = 5000
  const xs = sampleDists([spec], n, { seed: 77 + si }).map((r) => r[0]).sort((a, b) => a - b)
  let D = 0
  for (let i = 0; i < n; i++) { const F = d.cdf(xs[i]); D = Math.max(D, (i + 1) / n - F, F - i / n) }
  const ends = d.ppf(0) === d.lower && d.ppf(1) === d.upper
  ok(`${name}：单调 / 往返 / 端点 / 矩 / KS`,
    mono && rtErr < 1e-9 && ends && Math.abs(m1 - d.mean) / scale < 2e-3 && Math.abs(sdQ - d.sd) / scale < 3e-3 && D < 1.63 / Math.sqrt(n),
    `往返 ${rtErr.toExponential(1)}，均值 ${d.mean.toFixed(5)}（求积 ${m1.toFixed(5)}），sd ${d.sd.toFixed(5)}（求积 ${sdQ.toFixed(5)}），KS ${D.toFixed(4)}`)
}
{
  const d = makeDist({ type: 'lognormal', mean: 3, sd: 1 })
  ok('lognormal 由 { mean, sd } 换算后矩一致', rel(d.mean, 3) < 1e-14 && rel(d.sd, 1) < 1e-13, `${d.mean} / ${d.sd}`)
  const t = makeDist({ type: 'truncnormal', mu: 0, sigma: 1 })
  const nrm = makeDist({ type: 'normal', mu: 0, sigma: 1 })
  ok('不截断的 truncnormal = normal', [0.01, 0.3, 0.5, 0.9].every((u) => rel(t.ppf(u), nrm.ppf(u)) < 1e-12 || Math.abs(t.ppf(u)) < 1e-15))
  ok('makeDist 对已编译对象原样返回', makeDist(d) === d)
}

console.log('=== ④ 截断正态远尾 ===')
{
  const d = makeDist({ type: 'truncnormal', mu: 0, sigma: 1, lower: 8, upper: 9 })
  ok('[8σ, 9σ] 中位数对 mpmath 8.0848888990181664', rel(d.ppf(0.5), 8.0848888990181664) < 1e-12, d.ppf(0.5).toPrecision(17))
  ok('[8σ, 9σ] 0.9 分位对 mpmath 8.2786090370115515', rel(d.ppf(0.9), 8.2786090370115515) < 1e-12, d.ppf(0.9).toPrecision(17))
  // 反例：照 Φ 直算，Φ(8) 与 Φ(9) 在双精度里只差几个 ulp，区间被压成一两个格点
  const Fa = stdNormalCdf(8), Fb = stdNormalCdf(9)
  ok('（对照）直接用 Φ 时 Φ(9) − Φ(8) 只剩 ≤ 6 个 ulp，说明翻到生存函数是必要的', (Fb - Fa) / 2 ** -53 <= 6, `Φ(9) − Φ(8) = ${(Fb - Fa).toExponential(3)}`)
  const lo = makeDist({ type: 'truncnormal', mu: 10, sigma: 2, upper: 4 })
  ok('单侧截断（只截上方，z ≤ −3）中位数对 mpmath 3.5896901588021336', rel(lo.ppf(0.5), 3.5896901588021336) < 1e-12, lo.ppf(0.5).toPrecision(17))
  ok('截断区间离均值 40σ → 报错（概率质量下溢）', throws(() => makeDist({ type: 'truncnormal', mu: 0, sigma: 1, lower: 40, upper: 41 })))
}

console.log('=== ⑤ 表格 CDF / 经验 / 离散：解析 ===')
{
  const t = makeDist({ type: 'empirical', x: [0, 1, 3, 10], p: [0, 0.5, 0.9, 1] })
  ok('表格：ppf(0.7) = 1 + (0.2/0.4)·2 = 2', Math.abs(t.ppf(0.7) - 2) < 1e-15)
  ok('表格：cdf(5) = 0.9 + 0.1·2/7', Math.abs(t.cdf(5) - (0.9 + 0.1 * 2 / 7)) < 1e-15)
  ok('表格：均值 = 0.5·0.5 + 0.4·2 + 0.1·6.5 = 1.7', Math.abs(t.mean - 1.7) < 1e-14)
  // 原子（x = 1 处 0.4 的质量）+ 空档（(1, 2) 上 F 不变）
  const a = makeDist({ type: 'empirical', x: [0, 1, 1, 2, 3], p: [0, 0.2, 0.6, 0.6, 1] })
  ok('表格原子：ppf(0.3) = ppf(0.6) = 1', a.ppf(0.3) === 1 && a.ppf(0.6) === 1)
  ok('表格空档：ppf(0.61) = 2 + 0.01/0.4 = 2.025', Math.abs(a.ppf(0.61) - 2.025) < 1e-14)
  ok('表格空档：cdf(1.5) = 0.6、cdf(1) = 0.6、cdf(0.999…) < 0.2', a.cdf(1.5) === 0.6 && a.cdf(1) === 0.6 && a.cdf(0.999999) < 0.2)

  const st = makeDist({ type: 'empirical', samples: [5, 1, 3], interp: 'step' })
  ok('经验 step：ppf(0.2) = 1、ppf(0.34) = 3、ppf(0.9) = 5，只取样本值', st.ppf(0.2) === 1 && st.ppf(0.34) === 3 && st.ppf(0.9) === 5)
  ok('经验 step：cdf(3) = 2/3、均值 3、sd = √(8/3)', Math.abs(st.cdf(3) - 2 / 3) < 1e-15 && st.mean === 3 && rel(st.sd, Math.sqrt(8 / 3)) < 1e-15)
  const li = makeDist({ type: 'empirical', samples: [5, 1, 3] })
  ok('经验 linear（type-7）：ppf(0.25) = 2、cdf(2) = 0.25、ppf(1) = 5', li.ppf(0.25) === 2 && li.cdf(2) === 0.25 && li.ppf(1) === 5)
  // 重复样本 = 原子：[1, 2, 2, 4] 的 type-7 顶点在 u = 0, 1/3, 2/3, 1，u ∈ [1/3, 2/3] 全落在 2 上
  const tie = makeDist({ type: 'empirical', samples: [2, 4, 1, 2] })
  ok('经验 linear 重复样本成原子：ppf(0.4) = ppf(0.6) = 2、cdf(2) = 2/3、cdf(1.5) = 1/6',
    tie.ppf(0.4) === 2 && tie.ppf(0.6) === 2 && Math.abs(tie.cdf(2) - 2 / 3) < 1e-15 && Math.abs(tie.cdf(1.5) - 1 / 6) < 1e-15)

  const dd = makeDist({ type: 'discrete', values: [3, 1, 2], weights: [1, 2, 1] })
  ok('离散：ppf(0.5) = 1、ppf(0.50001) = 2、ppf(0.76) = 3', dd.ppf(0.5) === 1 && dd.ppf(0.50001) === 2 && dd.ppf(0.76) === 3)
  ok('离散：cdf(2) = 0.75、cdf(0.5) = 0、均值 1.75', dd.cdf(2) === 0.75 && dd.cdf(0.5) === 0 && Math.abs(dd.mean - 1.75) < 1e-15)
  const z = makeDist({ type: 'discrete', values: [0, 1, 2], weights: [0, 1, 1] })
  ok('离散：零权重的值永远抽不到（含 u → 0⁺ 与 u = 1）', z.ppf(0) === 1 && z.ppf(1e-12) === 1 && z.ppf(1) === 2 && z.lower === 1)
  // 离散抽样频数（卡方，2 自由度 0.1% 临界 13.82）
  const xs = sampleDists([{ type: 'discrete', values: [3, 1, 2], weights: [1, 2, 1] }], 20000, { seed: 5 }).map((r) => r[0])
  const cnt = { 1: 0, 2: 0, 3: 0 }
  for (const x of xs) cnt[x]++
  const chi = (cnt[1] - 10000) ** 2 / 10000 + (cnt[2] - 5000) ** 2 / 5000 + (cnt[3] - 5000) ** 2 / 5000
  ok('离散抽样频数（卡方 < 13.82）', chi < 13.82, `χ² = ${chi.toFixed(2)}`)
}

console.log('=== ⑥ 非法参数 / mapUnit ===')
{
  ok('normal σ ≤ 0 报错', throws(() => makeDist({ type: 'normal', mu: 0, sigma: 0 })))
  ok('uniform lower ≥ upper 报错', throws(() => makeDist({ type: 'uniform', lower: 1, upper: 1 })))
  ok('空串参数不当 0（报错）', throws(() => makeDist({ type: 'uniform', lower: '', upper: 1 })))
  ok('数字字符串可用', makeDist({ type: 'uniform', lower: '0', upper: '2' }).mean === 1)
  ok('triangular mode 出界报错', throws(() => makeDist({ type: 'triangular', lower: 0, mode: 2, upper: 1 })))
  ok('表格 CDF 不到 1 报错', throws(() => makeDist({ type: 'empirical', x: [0, 1], p: [0, 0.9] })))
  ok('表格 CDF 不单调报错', throws(() => makeDist({ type: 'empirical', x: [0, 2, 1], p: [0, 0.5, 1] })))
  ok('未知类型报错', throws(() => makeDist({ type: 'weibull' })))
  ok('离散负权重报错', throws(() => makeDist({ type: 'discrete', values: [1, 2], weights: [1, -1] })))

  const X = mapUnit([[0, 0, 1], [0.5, 0.5, 0.5]], [{ type: 'normal', mu: 0, sigma: 1 }, { type: 'uniform', lower: 0, upper: 1 }, { type: 'lognormal', mu: 0, sigma: 1 }])
  ok('mapUnit：u = 0 / 1 处夹到 2⁻³³，正态得有限值', X[0].every(Number.isFinite) && Math.abs(X[0][0] - stdNormalPpf(UNIT_EPS)) < 1e-12, X[0].map((v) => v.toFixed(4)).join(', '))
  ok('mapUnit：中点 0.5 原样', X[1][0] === 0 && X[1][1] === 0.5 && rel(X[1][2], 1) < 1e-15)
  ok('clampUnitOpen 不动内部格点', clampUnitOpen(2 ** -32) === 2 ** -32 && clampUnitOpen(1 - 2 ** -32) === 1 - 2 ** -32)
  ok('mapUnit：行宽与分布数不符报错', throws(() => mapUnit([[0.1, 0.2]], [{ type: 'normal', mu: 0, sigma: 1 }])))
}

console.log('=== ⑦ Iman–Conover ===')
{
  const r = ranks([10, 20, 20, 30])
  ok('平均秩：[10, 20, 20, 30] → [1, 2.5, 2.5, 4]', r.join() === '1,2.5,2.5,4')
  const C = [
    [1, 0.7, -0.4, 0.2],
    [0.7, 1, -0.3, 0],
    [-0.4, -0.3, 1, 0.5],
    [0.2, 0, 0.5, 1],
  ]
  const dists = [
    { type: 'normal', mu: 0, sigma: 1 },
    { type: 'lognormal', mu: 0, sigma: 0.8 },
    { type: 'triangular', lower: 0, mode: 1, upper: 4 },
    { type: 'empirical', samples: [1, 2, 2.5, 4, 8, 9, 13] },
  ]
  const n = 2000
  const X = mapUnit(latinHypercube(n, 4, { seed: 3, maximin: false }), dists)
  const Y = imanConover(X, C, { seed: 11 })
  const Sp = spearmanMatrix(Y)
  let worst = 0
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) worst = Math.max(worst, Math.abs(Sp[i][j] - C[i][j]))
  ok('Spearman 秩相关达到目标（各元素误差 ≤ 0.03）', worst <= 0.03, `最大误差 ${worst.toFixed(4)}`)
  let same = true
  for (let j = 0; j < 4; j++) {
    const a = X.map((row) => row[j]).sort((p, q) => p - q), b = Y.map((row) => row[j]).sort((p, q) => p - q)
    if (!a.every((v, i) => v === b[i])) same = false
  }
  ok('只重排行序：各列取值的多重集合不变（边缘分布与 LHS 分层原样）', same)
  const before = spearmanMatrix(X)
  ok('（对照）重排前近似独立', Math.abs(before[0][1]) < 0.06)

  const Yn = imanConover(X, C, { seed: 11, corrType: 'normal-scores' })
  const Sn = spearmanMatrix(Yn)
  let worstN = 0
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) if (i !== j) worstN = Math.max(worstN, Math.abs(Sn[i][j] - 6 / Math.PI * Math.asin(C[i][j] / 2)))
  ok("'normal-scores' 口径：秩相关 ≈ (6/π)·arcsin(ρ/2)（解析）", worstN <= 0.03, `最大误差 ${worstN.toFixed(4)}`)
  const scoreCorr = pearsonMatrix(mapUnit(Yn.map((row) => row.map((v, j) => makeDist(dists[j]).cdf(v))), [0, 1, 2, 3].map(() => ({ type: 'normal', mu: 0, sigma: 1 }))))
  ok("'normal-scores' 口径：正态得分的 Pearson ≈ 目标", Math.abs(scoreCorr[0][1] - 0.7) < 0.03, scoreCorr[0][1].toFixed(4))

  const Y2 = imanConover(X, C, { seed: 11 })
  ok('同种子逐位可复现', Y.every((row, i) => row.every((v, j) => Object.is(v, Y2[i][j]))))
  const Y3 = imanConover(X, C, { seed: 12 })
  ok('换种子行序不同', Y3.some((row, i) => row[0] !== Y[i][0]))
  ok('非正定目标报错', throws(() => imanConover(X, [[1, 0.9, 0.9, 0], [0.9, 1, -0.9, 0], [0.9, -0.9, 1, 0], [0, 0, 0, 1]])))
  ok('不对称目标报错', throws(() => imanConover(X, [[1, 0.5, 0, 0], [0.4, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])))
  ok('n ≤ k 报错', throws(() => imanConover(X.slice(0, 4), C)))

  const S2 = sampleDists(dists.slice(0, 2), 3000, { seed: 9, corr: [[1, -0.6], [-0.6, 1]] })
  ok('sampleDists 带 corr：秩相关 ≈ −0.6', Math.abs(spearmanMatrix(S2)[0][1] + 0.6) < 0.03, spearmanMatrix(S2)[0][1].toFixed(4))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
