// 参数研究 · 试验设计（packages/core/study/designs.mjs）自测。运行：node packages/core/test/studyDesigns.test.mjs
//
//   ① 全因子：组合数、末维变化最快、显式水平值、单水平取 0.5；
//   ② LHS：每列每层恰一个点（maximin 前后都成立）、centered 取层中点；maximin 的最小点距显著大于随机 LHS，
//      小设计（5 点 × 2 维）达到穷举最优；
//   ③ Sobol：前 10 个三维点 = Joe–Kuo 网页给出的 sobol.cc 输出；第 1000 / 4095 个点在 1、2、3、501、1110、1111 维
//      与 SciPy（scramble=False, bits=32，同用 new-joe-kuo-6.21201）逐位相同；前 2¹⁰ 个点在全部 1111 维上每个
//      2⁻¹⁰ 区间恰一个点；skip 定位 = 逐个生成；
//   ④ 加扰 Sobol：网格性质保留（1 维分层 + 第 1、2 维的 (0,m,2)-网）、不再出 0、可复现；
//      光滑被积函数上误差远小于蒙特卡洛；
//   ⑤ 蒙特卡洛：前 n 行 = 2n 行的前 n 行（追加样本不重算）、可复现；
//   ⑥ 工具函数：minDistance / phiP / scaleToBounds。

import {
  fullFactorial, latinHypercube, minDistance, phiP, createSobol, sobolSequence, monteCarlo, scaleToBounds,
  SOBOL_MAX_DIM, MAXIMIN_MAX_N,
} from '../study/designs.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  cond ? pass++ : fail++
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const sameRows = (A, B) => A.length === B.length && A.every((r, i) => r.length === B[i].length && r.every((v, j) => Object.is(v, B[i][j])))

/** 每列每层恰一个点 */
function isLatin(X) {
  const n = X.length, k = X[0].length
  for (let c = 0; c < k; c++) {
    const seen = new Uint8Array(n)
    for (const r of X) {
      const s = Math.floor(r[c] * n)
      if (!(r[c] >= 0 && r[c] < 1) || seen[s]++) return false
    }
  }
  return true
}

/** 前 2^m 个点在各维上每个 2^−m 区间恰一个点 */
function stratified1d(X, m) {
  const N = 2 ** m
  for (let j = 0; j < X[0].length; j++) {
    const seen = new Uint8Array(N)
    for (let i = 0; i < N; i++) if (seen[Math.floor(X[i][j] * N)]++) return false
  }
  return true
}

console.log('=== ① 全因子 ===')
{
  const F = fullFactorial([2, 3])
  ok('2 × 3 = 6 行，末维变化最快', F.length === 6 && JSON.stringify(F) === JSON.stringify([[0, 0], [0, 0.5], [0, 1], [1, 0], [1, 0.5], [1, 1]]))
  const G = fullFactorial([['QPSK', '8PSK'], [1.2, 2.4, 3.7], 1])
  ok('显式水平值（可为任意值），单水平取 0.5', G.length === 6 && G[0].join() === 'QPSK,1.2,0.5' && G[5].join() === '8PSK,3.7,0.5')
  ok('水平数非法 / 空水平报错', throws(() => fullFactorial([0])) && throws(() => fullFactorial([[]])) && throws(() => fullFactorial([])))
  ok('组合数超上限报错', throws(() => fullFactorial([1000, 1000, 1000])))
}

console.log('=== ② 拉丁超立方 + maximin ===')
{
  const A = latinHypercube(40, 5, { seed: 1, maximin: false })
  const B = latinHypercube(40, 5, { seed: 1 })
  ok('随机 LHS 每列每层恰一个点', isLatin(A))
  ok('maximin 优化后仍是 LHS（只做列内交换）', isLatin(B))
  const C = latinHypercube(16, 3, { seed: 2, centered: true })
  ok('centered：取值全是层中点 (i+½)/n', isLatin(C) && C.every((r) => r.every((v) => Number.isInteger(v * 16 - 0.5))))
  ok('n = 1 / k = 1 也能出', isLatin(latinHypercube(1, 3)) && isLatin(latinHypercube(10, 1)))

  let rnd = 0, opt = 0, phR = 0, phO = 0
  for (let s = 1; s <= 4; s++) {
    const R = latinHypercube(30, 4, { seed: s, maximin: false }), O = latinHypercube(30, 4, { seed: s })
    rnd += minDistance(R); opt += minDistance(O); phR += phiP(R); phO += phiP(O)
  }
  ok('30 点 × 4 维：maximin 的最小点距 ≥ 随机 LHS 的 1.6 倍（4 个种子平均）', opt >= 1.6 * rnd, `${(rnd / 4).toFixed(4)} → ${(opt / 4).toFixed(4)}`)
  ok('φ_p 随之下降', phO < phR, `${(phR / 4).toFixed(3)} → ${(phO / 4).toFixed(3)}`)

  // 5 点 × 2 维 centered：穷举全部 5! 个排列得到最优最小点距，退火须达到
  let best = 0
  const perm = (arr, k = 0) => {
    if (k === arr.length) {
      const P = arr.map((v, i) => [(i + 0.5) / 5, (v + 0.5) / 5])
      best = Math.max(best, minDistance(P))
      return
    }
    for (let i = k; i < arr.length; i++) { [arr[k], arr[i]] = [arr[i], arr[k]]; perm(arr, k + 1); [arr[k], arr[i]] = [arr[i], arr[k]] }
  }
  perm([0, 1, 2, 3, 4])
  const hits = [1, 2, 3, 4, 5, 6].filter((s) => Math.abs(minDistance(latinHypercube(5, 2, { seed: s, centered: true })) - best) < 1e-12).length
  ok('5 点 × 2 维 centered：6 个种子全部达到穷举最优最小点距 √5/5', hits === 6 && Math.abs(best - Math.sqrt(5) / 5) < 1e-12, `${hits}/6，最优 ${best.toFixed(4)}`)

  ok('同种子逐位可复现', sameRows(latinHypercube(25, 3, { seed: 9 }), latinHypercube(25, 3, { seed: 9 })))
  ok('换种子即不同', !sameRows(latinHypercube(25, 3, { seed: 9 }), latinHypercube(25, 3, { seed: 10 })))
  const t0 = Date.now()
  const big = latinHypercube(MAXIMIN_MAX_N + 1, 2, { seed: 1 })
  ok(`n > ${MAXIMIN_MAX_N} 时跳过 maximin（仍是 LHS，且很快）`, isLatin(big) && Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
  ok('参数非法报错', throws(() => latinHypercube(0, 2)) && throws(() => latinHypercube(5, 1.5)))
}

console.log('=== ③ Sobol（不加扰） ===')
{
  // Joe–Kuo 网页：./sobol 10 3 new-joe-kuo-6.21201 的输出
  const JK = [
    [0, 0, 0], [0.5, 0.5, 0.5], [0.75, 0.25, 0.25], [0.25, 0.75, 0.75], [0.375, 0.375, 0.625],
    [0.875, 0.875, 0.125], [0.625, 0.125, 0.875], [0.125, 0.625, 0.375], [0.1875, 0.3125, 0.9375], [0.6875, 0.8125, 0.4375],
  ]
  ok('前 10 个三维点 = Joe–Kuo sobol.cc 输出', sameRows(sobolSequence(10, 3), JK))

  // SciPy 1.18：qmc.Sobol(d=1111, scramble=False, bits=32).random(4096)，取第 1000、4095 行的 1、2、3、501、1110、1111 维（×2³²）
  const cols = [0, 1, 2, 500, 1109, 1110]
  const SCIPY = {
    1000: [943718400, 415236096, 2227175424, 3116367872, 4248829952, 1589641216],
    4095: [1048576, 4042260480, 1435500544, 1877999616, 3440377856, 1454374912],
  }
  const S = sobolSequence(4096, SOBOL_MAX_DIM)
  ok('第 1000、4095 个点在高维（至第 1111 维）与 SciPy 逐位相同',
    [1000, 4095].every((i) => cols.every((c, t) => S[i][c] * 2 ** 32 === SCIPY[i][t])))
  ok(`前 2¹⁰ 个点在全部 ${SOBOL_MAX_DIM} 维上每个 2⁻¹⁰ 区间恰一个点`, stratified1d(S, 10))
  ok('前 2¹² 个点在全部维上每个 2⁻¹² 区间恰一个点', stratified1d(S, 12))
  ok('skip：sobolSequence(100, k, {skip: 3000}) = 第 3000…3099 个点', sameRows(sobolSequence(100, SOBOL_MAX_DIM, { skip: 3000 }), S.slice(3000, 3100)))
  const g = createSobol(5, { skip: 7 })
  const first = g.next()
  ok('createSobol 逐点生成与 sobolSequence 一致，index 前进', sameRows([first, g.next()], sobolSequence(2, 5, { skip: 7 })) && g.index === 9)
  ok(`维数 > ${SOBOL_MAX_DIM} 报错`, throws(() => sobolSequence(4, SOBOL_MAX_DIM + 1)))
}

console.log('=== ④ 加扰 Sobol ===')
{
  const X = sobolSequence(1024, 40, { scramble: true, seed: 5 })
  ok('1 维分层保留（40 维，每个 2⁻¹⁰ 区间恰一个点）', stratified1d(X, 10))
  let net = true
  for (let a = 0; a <= 10; a++) {
    const seen = new Uint8Array(1024)
    for (const r of X) if (seen[Math.floor(r[0] * 2 ** a) * 2 ** (10 - a) + Math.floor(r[1] * 2 ** (10 - a))]++) net = false
  }
  ok('第 1、2 维的 (0,10,2)-网性质保留（每个面积 2⁻¹⁰ 的基本矩形恰一个点）', net)
  ok('首点不再是原点', X[0].some((v) => v > 0))
  ok('同种子逐位可复现', sameRows(sobolSequence(64, 7, { scramble: true, seed: 5 }), sobolSequence(64, 7, { scramble: true, seed: 5 })))
  ok('换种子即不同', !sameRows(sobolSequence(64, 7, { scramble: true, seed: 5 }), sobolSequence(64, 7, { scramble: true, seed: 6 })))

  // ∫_{[0,1]^5} Π (π/2)·sin(π x_i) dx = 1，方差 (π²/8)⁵ − 1（解析）；蒙特卡洛标准误 = √方差 / √N
  const f = (x) => x.reduce((p, v) => p * (Math.PI / 2) * Math.sin(Math.PI * v), 1)
  const N = 4096
  const se = Math.sqrt((Math.PI ** 2 / 8) ** 5 - 1) / Math.sqrt(N)
  let s2 = 0
  for (let s = 1; s <= 10; s++) {
    const e = sobolSequence(N, 5, { scramble: true, seed: s }).reduce((a, x) => a + f(x), 0) / N - 1
    s2 += e * e
  }
  const rms = Math.sqrt(s2 / 10)
  ok('光滑积分：加扰 Sobol 10 次独立加扰的均方根误差 < 蒙特卡洛标准误的 1/8', rms < se / 8, `RQMC ${rms.toExponential(2)} vs MC σ/√N ${se.toExponential(2)}`)
}

console.log('=== ⑤ 蒙特卡洛 ===')
{
  const A = monteCarlo(500, 3, { seed: 4 }), B = monteCarlo(1000, 3, { seed: 4 })
  ok('前 n 行 = 2n 行设计的前 n 行（追加样本不重算）', sameRows(A, B.slice(0, 500)))
  ok('取值在 [0,1)', B.every((r) => r.every((v) => v >= 0 && v < 1)))
  const m = B.reduce((s, r) => s + r[0] + r[1] + r[2], 0) / 3000
  ok('均值 ≈ 0.5（4σ）', Math.abs(m - 0.5) < 4 * Math.sqrt(1 / 12 / 3000), m.toFixed(4))
  ok('换种子即不同', !sameRows(A, monteCarlo(500, 3, { seed: 5 })))
}

console.log('=== ⑥ 工具函数 ===')
{
  ok('minDistance：3-4-5 三角', minDistance([[0, 0], [3, 4], [10, 10]]) === 5)
  ok('phiP 在两点时 = 1/d', Math.abs(phiP([[0, 0], [0, 2]]) - 0.5) < 1e-15)
  ok('scaleToBounds 仿射映射', JSON.stringify(scaleToBounds([[0, 0.5], [1, 0.25]], [10, -1], [20, 1])) === JSON.stringify([[10, 0], [20, -0.5]]))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
