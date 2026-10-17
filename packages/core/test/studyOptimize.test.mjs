// 参数研究 · 优化（packages/core/study/optimize.mjs）自测。运行：node packages/core/test/studyOptimize.test.mjs
//
//   ① Nelder–Mead：Rosenbrock（−1.2, 1）收敛到 (1,1)；Himmelblau 五个起点各自收敛到四个极小点之一
//      （极小点坐标为 mpmath 求根结果）；盒约束；收敛轨迹单调；
//   ② CMA-ES：Rosenbrock n = 2 / 5 / 10 收敛；Himmelblau（含 IPOP 重启）；最优解在边界上的盒约束问题；
//   ③ NSGA-II：ZDT1–3（30 维、种群 100、250 代）第 0 前沿的超体积对解析前沿的超体积（参考点 (1.1, 1.1)）；
//      CONSTR（Deb 2002 的约束问题）全部可行，前沿到解析前沿的距离（GD / IGD）；评估失败（NaN）不中断；
//   ④ 超体积函数本身对手算；
//   ⑤ 混合编码：编码 / 解码 / 去重键；CMA-ES 与 NSGA-II 在 real + int + cat + ordinal 混合问题上找到最优；缓存去重；
//   ⑥ ask/tell：手动逐批推进、runSync、runAsync 三种驱动结果逐位相同；同种子逐位可复现；
//   ⑦ 随时停（opt.signal）、边界与入参的边角情形（一维 NM、步长比盒宽、单侧无界、无限边界、全部求值失败）；
//   ⓪ 线性代数：对称阵特征分解的重构 / 正交性，以及 1e154、1e-300 量级下仍正确。

import {
  runSync, runAsync, nelderMead, nelderMeadSteps, cmaes, cmaesSteps, nsga2, nsga2Steps, hypervolume2d,
  makeSpace, mixedSteps,
} from '../study/optimize.mjs'
import { symEigen, cholesky, invLower, matMul } from '../study/linalg.mjs'
import { makeRng } from '../study/rng.mjs'

let pass = 0, fail = 0
const ok = (name, cond, extra) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : ''))
  cond ? pass++ : fail++
}
const throws = (fn) => { try { fn(); return false } catch { return true } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const rosen = (x) => { let s = 0; for (let i = 0; i + 1 < x.length; i++) s += 100 * (x[i + 1] - x[i] ** 2) ** 2 + (1 - x[i]) ** 2; return s }
const himmel = ([x, y]) => (x * x + y - 11) ** 2 + (x + y * y - 7) ** 2
// mpmath 求根（60 位）
const HIMMEL_MIN = [[3, 2], [-2.8051180869527449, 3.131312518250573], [-3.7793102533777469, -3.2831859912861694], [3.5844283403304917, -1.8481265269644036]]
const nearestMin = (x) => Math.min(...HIMMEL_MIN.map((m) => Math.hypot(x[0] - m[0], x[1] - m[1])))

console.log('=== ⓪ 线性代数 ===')
{
  const rng = makeRng(17)
  const n = 6
  const M = Array.from({ length: n }, () => Array.from({ length: n }, () => rng() - 0.5))
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => M[i][j] + M[j][i]))
  const { values, vectors } = symEigen(A)
  let rec = 0, orth = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let s = 0, o = 0
      for (let k = 0; k < n; k++) { s += vectors[i][k] * values[k] * vectors[j][k]; o += vectors[k][i] * vectors[k][j] }
      rec = Math.max(rec, Math.abs(s - A[i][j])); orth = Math.max(orth, Math.abs(o - (i === j ? 1 : 0)))
    }
  }
  ok('symEigen：V·Λ·Vᵀ 重构 A、V 正交、特征值升序', rec < 1e-13 && orth < 1e-13 && values.every((v, i) => i === 0 || v >= values[i - 1]),
    `重构 ${rec.toExponential(1)}，正交 ${orth.toExponential(1)}`)
  const big = symEigen([[2e154, 1e154], [1e154, 2e154]])
  ok('symEigen：1e154 量级不因平方和上溢而失效（特征值 1e154、3e154）', Math.abs(big.values[0] / 1e154 - 1) < 1e-14 && Math.abs(big.values[1] / 3e154 - 1) < 1e-14,
    `${big.values[0].toExponential(6)}, ${big.values[1].toExponential(6)}`)
  const tiny = symEigen([[2e-300, 1e-300], [1e-300, 2e-300]])
  ok('symEigen：1e-300 量级不因平方和下溢而失效', Math.abs(tiny.values[0] / 1e-300 - 1) < 1e-14 && Math.abs(tiny.values[1] / 3e-300 - 1) < 1e-14)
  const P = [[4, 2, 0.4], [2, 5, 1], [0.4, 1, 3]]
  const L = cholesky(P)
  const LLt = matMul(L, L.map((_, i) => L.map((r) => r[i])))
  const I = matMul(L, invLower(L))
  ok('cholesky：L·Lᵀ = A，L·L⁻¹ = I；非正定返回 null',
    P.every((r, i) => r.every((v, j) => Math.abs(LLt[i][j] - v) < 1e-14)) && I.every((r, i) => r.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-15))
    && cholesky([[1, 2], [2, 1]]) === null)
}

console.log('=== ① Nelder–Mead ===')
{
  const r = nelderMead(rosen, [-1.2, 1])
  ok('Rosenbrock 从 (−1.2, 1) 收敛到 (1, 1)', r.reason === 'converged' && Math.max(Math.abs(r.x[0] - 1), Math.abs(r.x[1] - 1)) < 1e-6 && r.f < 1e-12,
    `x = (${r.x.map((v) => v.toFixed(9)).join(', ')})，f = ${r.f.toExponential(2)}，${r.nEval} 次求值`)
  ok('收敛轨迹（每轮最好值）单调不增', r.trace.every((v, i) => i === 0 || v <= r.trace[i - 1]))
  const starts = [[0, 0], [-1, -1], [-4, 4], [4, -4], [1, 1]]
  const res = starts.map((x0) => nelderMead(himmel, x0))
  ok('Himmelblau 五个起点都收敛到四个极小点之一（距离 < 1e-6，f < 1e-12）',
    res.every((q) => q.reason === 'converged' && nearestMin(q.x) < 1e-6 && q.f < 1e-12),
    res.map((q) => `(${q.x.map((v) => v.toFixed(4)).join(',')})`).join(' '))
  const found = new Set(res.map((q) => HIMMEL_MIN.findIndex((m) => Math.hypot(q.x[0] - m[0], q.x[1] - m[1]) < 1e-6)))
  ok('五个起点覆盖全部四个极小点', found.size === 4, `${found.size} 个`)
  const b = nelderMead((x) => x.reduce((s, v) => s + (v - 2) ** 2, 0), [0, 0, 0], { lower: [-1, -1, -1], upper: [1, 1, 1] })
  ok('盒约束：最优点在边界上（1, 1, 1），f = 3', b.x.every((v) => Math.abs(v - 1) < 1e-8) && Math.abs(b.f - 3) < 1e-12, `${b.x.join(', ')}`)
  const m = nelderMead(rosen, [-1.2, 1], { maxEval: 50 })
  ok('maxEval 截停并报原因', m.reason === 'maxEval' && m.nEval <= 50 + 3, `${m.nEval} 次`)
  ok('NaN / 非数求值当 +∞ 处理，不中断', nelderMead((x) => (x[0] < 0 ? NaN : (x[0] - 1) ** 2 + x[1] ** 2), [0.5, 0.5]).f < 1e-12)
}

console.log('=== ② CMA-ES ===')
{
  for (const n of [2, 5, 10]) {
    const r = cmaes(rosen, new Array(n).fill(-1), { sigma0: 0.5, seed: 1 })
    const dx = Math.max(...r.x.map((v) => Math.abs(v - 1)))
    ok(`Rosenbrock n = ${n} 收敛（f < 1e-10，|x − 1|∞ < 1e-4）`, r.f < 1e-10 && dx < 1e-4,
      `f = ${r.f.toExponential(2)}，|x − 1|∞ = ${dx.toExponential(2)}，${r.nEval} 次求值，停机：${r.reason}`)
  }
  const hs = [[0, 0], [-1, -1], [-4, 4], [4, -4]].map((x0, i) => cmaes(himmel, x0, { sigma0: 1, seed: 3 + i }))
  ok('Himmelblau 四个起点都收敛到极小点（距离 < 1e-6）', hs.every((q) => nearestMin(q.x) < 1e-6 && q.f < 1e-12),
    hs.map((q) => `(${q.x.map((v) => v.toFixed(4)).join(',')})`).join(' '))
  const ip = cmaes(himmel, [0, 0], { lower: [-5, -5], upper: [5, 5], restarts: 3, seed: 8 })
  ok('Himmelblau 盒内 + IPOP 重启：收敛且有重启记录', nearestMin(ip.x) < 1e-6 && ip.restarts >= 1, `重启 ${ip.restarts} 次，${ip.nEval} 次求值`)
  const b = cmaes((x) => x.reduce((s, v) => s + (v - 2) ** 2, 0), [0, 0, 0], { lower: [-1, -1, -1], upper: [1, 1, 1], seed: 2 })
  ok('盒约束（边界映射）：最优点在边界上，返回点在盒内', b.x.every((v) => v <= 1 && v >= -1 && Math.abs(v - 1) < 1e-8) && Math.abs(b.f - 3) < 1e-10, b.x.join(', '))
  ok('stopFitness 提前停', cmaes(rosen, [0, 0], { stopFitness: 1e-3, seed: 1 }).reason === 'stopFitness')
  ok('maxEval < 种群报错', throws(() => cmaes(rosen, [0, 0], { maxEval: 3 })))
}

console.log('=== ③ NSGA-II ===')
{
  const n = 30
  const g = (x) => { let s = 0; for (let i = 1; i < n; i++) s += x[i]; return 1 + 9 * s / (n - 1) }
  const ZDT = {
    ZDT1: { f: (x) => { const gg = g(x); return [x[0], gg * (1 - Math.sqrt(x[0] / gg))] }, front: (f1) => 1 - Math.sqrt(f1), min: 0.985 },
    ZDT2: { f: (x) => { const gg = g(x); return [x[0], gg * (1 - (x[0] / gg) ** 2)] }, front: (f1) => 1 - f1 * f1, min: 0.98 },
    ZDT3: {
      f: (x) => { const gg = g(x), r = x[0] / gg; return [x[0], gg * (1 - Math.sqrt(r) - r * Math.sin(10 * Math.PI * x[0]))] },
      front: (f1) => 1 - Math.sqrt(f1) - f1 * Math.sin(10 * Math.PI * f1), min: 0.99,
    },
  }
  const ref = [1.1, 1.1]
  // 参考超体积：ZDT1 / ZDT2 解析（∫(1.1 − h(f₁))df₁ + 0.1·1.1）；ZDT3 前沿不连通，取 g = 1 曲线上 20 万点的非支配集
  const HV_REF = {
    ZDT1: 0.1 + 2 / 3 + 0.11,
    ZDT2: 0.1 + 1 / 3 + 0.11,
    ZDT3: hypervolume2d(Array.from({ length: 200001 }, (_, i) => [i / 200000, ZDT.ZDT3.front(i / 200000)]), ref),
  }
  ok('（参考值核对）ZDT1 / ZDT2 稠密前沿的超体积 = 解析值', ['ZDT1', 'ZDT2'].every((k) =>
    Math.abs(hypervolume2d(Array.from({ length: 200001 }, (_, i) => [i / 200000, ZDT[k].front(i / 200000)]), ref) - HV_REF[k]) < 1e-5))
  for (const [name, P] of Object.entries(ZDT)) {
    const t = Date.now()
    const r = nsga2(P.f, { lower: new Array(n).fill(0), upper: new Array(n).fill(1), popSize: 100, generations: 250, seed: 1 })
    const hv = hypervolume2d(r.front.map((p) => p.f), ref)
    ok(`${name}：超体积 ≥ 参考值的 ${(P.min * 100).toFixed(1)}%，前沿 100 个点`, hv / HV_REF[name] >= P.min && r.front.length === 100,
      `${hv.toFixed(5)} / ${HV_REF[name].toFixed(5)} = ${(hv / HV_REF[name] * 100).toFixed(2)}%，${r.nEval} 次求值，${Date.now() - t} ms`)
  }

  // CONSTR：min f1 = x1，f2 = (1 + x2)/x1；g1 = 6 − (x2 + 9x1) ≤ 0，g2 = 1 − (9x1 − x2) ≤ 0
  // 解析前沿：x1 ∈ [7/18, 2/3] 时 f2 = 7/x1 − 9（贴着 g1 边界），x1 ∈ [2/3, 1] 时 f2 = 1/x1
  const constr = ([x1, x2]) => ({ f: [x1, (1 + x2) / x1], g: [6 - (x2 + 9 * x1), 1 - (9 * x1 - x2)] })
  const r = nsga2(constr, { lower: [0.1, 0], upper: [1, 5], popSize: 100, generations: 200, seed: 1 })
  const tf = (x1) => (x1 < 2 / 3 ? 7 / x1 - 9 : 1 / x1)
  const curve = Array.from({ length: 20001 }, (_, i) => { const x1 = 7 / 18 + (11 / 18) * i / 20000; return [x1, tf(x1)] })
  const s1 = 11 / 18, s2 = 8                       // 目标范围归一
  const dist = (p, q) => Math.hypot((p[0] - q[0]) / s1, (p[1] - q[1]) / s2)
  const gd = r.front.map((p) => Math.min(...curve.map((c) => dist(p.f, c))))
  const igdPts = curve.filter((_, i) => i % 100 === 0)
  const igd = igdPts.reduce((s, c) => s + Math.min(...r.front.map((p) => dist(p.f, c))), 0) / igdPts.length
  const gdMean = gd.reduce((a, b) => a + b, 0) / gd.length
  ok('CONSTR：种群全部可行，前沿 100 个点', r.population.every((p) => p.cv === 0) && r.front.length === 100)
  ok('CONSTR：前沿到解析前沿 GD < 0.005、最远 < 0.05、IGD < 0.015（目标归一）', gdMean < 0.005 && Math.max(...gd) < 0.05 && igd < 0.015,
    `GD ${gdMean.toExponential(2)}，最远 ${Math.max(...gd).toExponential(2)}，IGD ${igd.toExponential(2)}`)
  ok('CONSTR：前沿铺满 f1 ∈ [7/18, 1]', r.front[0].f[0] < 0.40 && r.front[r.front.length - 1].f[0] > 0.99,
    `${r.front[0].f[0].toFixed(4)} … ${r.front[r.front.length - 1].f[0].toFixed(4)}`)

  // 评估失败：左半边一律 NaN；首代也会有失败个体
  const nanRun = nsga2((x) => (x[0] < 0.2 ? [NaN, NaN] : [x[0], 1 - Math.sqrt(x[0]) + x[1]]), { lower: [0, 0], upper: [1, 1], popSize: 40, generations: 30, seed: 4 })
  ok('评估失败（NaN）的个体按不可行处理，不中断，前沿里没有它们', nanRun.front.length > 0 && nanRun.front.every((p) => p.x[0] >= 0.2 && p.cv === 0))
  const init = [[0.5, 0], [0.25, 0]]
  const withInit = nsga2((x) => [x[0], 1 - x[0] + x[1]], { lower: [0, 0], upper: [1, 1], popSize: 8, generations: 0, initial: init })
  ok('initial：给定的初始点进入首代', init.every((x) => withInit.population.some((p) => same(p.x, x))))
  ok('缺盒约束报错', throws(() => nsga2(() => [0, 0], {})))
}

console.log('=== ④ 二目标超体积 ===')
{
  ok('两点 (0,1)、(1,0)，参考点 (2,2)：3', hypervolume2d([[0, 1], [1, 0]], [2, 2]) === 3)
  ok('被支配点与参考点外的点不贡献', hypervolume2d([[0, 1], [1, 0], [1, 1], [3, 0]], [2, 2]) === 3)
  ok('单点', hypervolume2d([[0.5, 0.5]], [1, 1]) === 0.25)
}

console.log('=== ⑤ 混合编码 ===')
{
  const space = makeSpace([
    { name: 'D', type: 'real', lower: 0.6, upper: 3.0 },
    { name: 'nBeams', type: 'int', lower: 1, upper: 16 },
    { name: 'mod', type: 'cat', values: ['QPSK', '8PSK', '16APSK', '32APSK'] },
    { name: 'rate', type: 'ordinal', values: [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 5 / 6] },
    { name: 'Rb', type: 'real', lower: 1e5, upper: 1e9, scale: 'log' },
  ])
  ok('维数与离散标记', space.dim === 5 && same(space.discrete, [false, true, true, true, false]) && same(space.levels, [0, 16, 4, 6, 0]))
  ok('解码：z = 0 / 1 精确落到两端（含对数刻度），z = 1 归最后一格', same(space.decode([0, 0, 0, 0, 0]), [0.6, 1, 'QPSK', 0.25, 1e5])
    && same(space.decode([1, 1, 1, 1, 1]), [3, 16, '32APSK', 5 / 6, 1e9]) && same(space.decode([-0.2, 1.3, 2, -1, 7]), [0.6, 16, '32APSK', 0.25, 1e9]))
  const v = [1.8, 7, '16APSK', 2 / 3, 1e7]
  const z = space.encode(v)
  const back = space.decode(z)
  ok('编码 → 解码往返（离散取格心，连续维到舍入）', Math.abs(back[0] - 1.8) < 1e-15 && same(back.slice(1, 4), v.slice(1, 4)) && Math.abs(back[4] / 1e7 - 1) < 1e-12)
  ok('离散维编码取格心', z[1] === 6.5 / 16 && z[2] === 2.5 / 4 && z[3] === 3.5 / 6)
  ok('对数刻度：z = 0.5 ↔ 几何中点 1e7', Math.abs(space.decode([0, 0, 0, 0, 0.5])[4] / 1e7 - 1) < 1e-12)
  ok('去重键：同格同值即同键', space.key([0.5, 0.40, 0.55, 0.1, 0.3]) === space.key([0.5, 0.41, 0.6, 0.12, 0.3]))
  ok('decodeObject 带变量名', space.decodeObject(z).mod === '16APSK' && space.decodeObject(z).nBeams === 7)
  ok('定义域外取值编码报错', throws(() => space.encode([1, 99, 'QPSK', 0.25, 1e6])) && throws(() => makeSpace([{ type: 'int', lower: 1.5, upper: 3 }])))

  const target = (x) => (x[0] - 1.8) ** 2 + 0.1 * (x[1] - 7) ** 2 + (x[2] === '16APSK' ? 0 : 0.5) + 4 * (x[3] - 2 / 3) ** 2 + (Math.log10(x[4]) - 7) ** 2 / 16
  let calls = 0
  const counted = (x) => { calls++; return target(x) }
  const res = runSync(mixedSteps(space, cmaesSteps(space.center(), {
    lower: space.lower, upper: space.upper, minStd: space.minStd(), seed: 5, restarts: 2,
  })), counted)
  ok('CMA-ES + 混合编码：找到 nBeams = 7、mod = 16APSK、rate = 2/3、D ≈ 1.8、Rb ≈ 1e7',
    res.values[1] === 7 && res.values[2] === '16APSK' && res.values[3] === 2 / 3 && Math.abs(res.values[0] - 1.8) < 1e-3 && Math.abs(Math.log10(res.values[4]) - 7) < 1e-2,
    `${JSON.stringify(res.values.map((x) => (typeof x === 'number' ? +x.toPrecision(6) : x)))}，f = ${res.f.toExponential(2)}`)
  ok('含连续维时每次请求都是新点：实际求值次数 = nUnique', calls === res.nUnique, `${res.nUnique} / ${res.nEval}`)

  // 纯离散空间（16 × 4 × 6 = 384 种组合）：重复点只算一次
  const disc = makeSpace([space.vars[1], space.vars[2], space.vars[3]].map((d) => ({ ...d })))
  let dcalls = 0
  const dres = runSync(mixedSteps(disc, cmaesSteps(disc.center(), { lower: disc.lower, upper: disc.upper, minStd: disc.minStd(), seed: 2 })),
    (x) => { dcalls++; return 0.1 * (x[0] - 7) ** 2 + (x[1] === '16APSK' ? 0 : 0.5) + 4 * (x[2] - 2 / 3) ** 2 })
  ok('纯离散空间：缓存去重后实际求值 = nUnique ≤ 384 < 请求次数，且找到最优组合',
    dcalls === dres.nUnique && dres.nUnique <= 384 && dres.nUnique < dres.nEval && same(dres.values, [7, '16APSK', 2 / 3]),
    `实际 ${dres.nUnique} 次 / 请求 ${dres.nEval} 次，${JSON.stringify(dres.values.map((x) => (typeof x === 'number' ? +x.toPrecision(4) : x)))}`)

  const ga = runSync(mixedSteps(space, nsga2Steps({ lower: space.lower, upper: space.upper, popSize: 40, generations: 60, seed: 3 })), (x) => [target(x)])
  const bestGa = ga.front[0]
  ok('NSGA-II（单目标）+ 混合编码：离散维全部命中', bestGa.values[1] === 7 && bestGa.values[2] === '16APSK' && bestGa.values[3] === 2 / 3,
    JSON.stringify(bestGa.values.map((x) => (typeof x === 'number' ? +x.toPrecision(4) : x))))
  const named = runSync(mixedSteps(space, nelderMeadSteps(space.center(), { lower: space.lower, upper: space.upper, maxEval: 30 }), { named: true }),
    (o) => { if (typeof o.mod !== 'string' || !('nBeams' in o)) throw new Error('named 模式应传对象'); return target([o.D, o.nBeams, o.mod, o.rate, o.Rb]) })
  ok('named 模式：评估端拿到 { 变量名: 值 }', named.values && typeof named.values.D === 'number')
}

console.log('=== ⑥ ask/tell 与可复现 ===')
{
  // 手动逐批推进 = runSync
  const it = cmaesSteps([-1, -1, -1], { sigma0: 0.5, seed: 7 })
  let r = it.next(), batches = 0
  while (!r.done) { batches++; r = it.next(r.value.map(rosen)) }
  const viaSync = cmaes(rosen, [-1, -1, -1], { sigma0: 0.5, seed: 7 })
  ok('CMA-ES：手动 ask/tell 与 runSync 逐位相同', same(r.value, viaSync), `${batches} 批`)
  const viaAsync = await runAsync(cmaesSteps([-1, -1, -1], { sigma0: 0.5, seed: 7 }), async (X) => { await new Promise((ok_) => setTimeout(ok_, 0)); return X.map(rosen) })
  ok('CMA-ES：runAsync（批量、异步）与 runSync 逐位相同', same(viaAsync, viaSync))
  const nmA = await runAsync(nelderMeadSteps([-1.2, 1]), (X) => Promise.resolve(X.map(rosen)))
  ok('Nelder–Mead：runAsync 与 runSync 逐位相同', same(nmA, nelderMead(rosen, [-1.2, 1])))
  const zdt = (x) => [x[0], 1 + x[1] - Math.sqrt(x[0])]
  const a = nsga2(zdt, { lower: [0, 0], upper: [1, 1], popSize: 20, generations: 20, seed: 9 })
  const b = nsga2(zdt, { lower: [0, 0], upper: [1, 1], popSize: 20, generations: 20, seed: 9 })
  const c = nsga2(zdt, { lower: [0, 0], upper: [1, 1], popSize: 20, generations: 20, seed: 10 })
  ok('NSGA-II：同种子逐位可复现，换种子即不同', same(a, b) && !same(a, c))
  ok('CMA-ES：换种子即不同', !same(cmaes(rosen, [0, 0], { seed: 1 }).x, cmaes(rosen, [0, 0], { seed: 2 }).x))
  ok('评估结果长度与请求不符报错（首批 3 个点只回 1 个值）', throws(() => { const g = nelderMeadSteps([0, 0]); g.next(); g.next([1]) }))
}

console.log('=== ⑦ 随时停与边角情形 ===')
{
  // 一维：Gao–Han 系数在 n = 1 时收缩系数为 0，会一次压成一点假收敛；一维须用标准系数
  const f1 = (x) => Math.sin(3 * x[0]) + 0.1 * x[0] ** 2
  const d1 = (x) => 3 * Math.cos(3 * x) + 0.2 * x
  const r1 = nelderMead(f1, [-5.987], { step: 2 })
  ok('一维 NM（步长 2）收敛到驻点：|f′| < 1e-5', r1.reason === 'converged' && Math.abs(d1(r1.x[0])) < 1e-5,
    `x = ${r1.x[0].toFixed(6)}，f′ = ${d1(r1.x[0]).toExponential(1)}，${r1.nEval} 次求值`)
  let worst = 0
  for (let t = 0; t < 40; t++) {
    const x0 = -6 + 0.3 * t
    const r = nelderMead(f1, [x0], { step: 0.5 + (t % 4) })
    worst = Math.max(worst, Math.abs(d1(r.x[0])))
  }
  ok('一维 NM：40 组起点 / 步长全部停在驻点（|f′| < 1e-5）', worst < 1e-5, `最大 |f′| ${worst.toExponential(1)}`)

  const sq = ([x, y]) => (x - 0.7) ** 2 + (y - 0.3) ** 2
  const rb = nelderMead(sq, [0, 0.5], { step: 2, lower: [0, 0], upper: [1, 1] })
  ok('起点在边界上且步长比盒宽：初始单纯形不退化，仍找到 (0.7, 0.3)', Math.abs(rb.x[0] - 0.7) < 1e-6 && Math.abs(rb.x[1] - 0.3) < 1e-6,
    rb.x.map((v) => v.toFixed(6)).join(', '))
  const ro = nelderMead(([x, y]) => (x + 1) ** 2 + (y - 2) ** 2, [3, 3], { lower: [0, 0], upper: [Infinity, Infinity] })
  ok('NM 允许单侧无界：x ≥ 0 约束下最优 (0, 2)', Math.abs(ro.x[0]) < 1e-8 && Math.abs(ro.x[1] - 2) < 1e-6, ro.x.map((v) => v.toFixed(8)).join(', '))
  ok('CMA-ES / NSGA-II 拒收非有限边界', throws(() => cmaes(sq, [1, 1], { lower: [0, 0], upper: [Infinity, 1] }))
    && throws(() => nsga2(() => [0, 0], { lower: [0, 0], upper: [Infinity, 1] })))
  const allBad = cmaes(() => NaN, [0.2, -0.4], { maxEval: 60 })
  ok('CMA-ES 全部求值失败：返回起点（不是 null），f = +∞', same(allBad.x, [0.2, -0.4]) && allBad.f === Infinity)

  // 随时停：求值到一定次数后置位，下一个批次边界收尾，结果是已见过的最好值
  const stopAt = (limit) => {
    const sig = { aborted: false }
    let calls = 0, bestSeen = Infinity
    const fn = (x) => { const v = rosen(x); calls++; bestSeen = Math.min(bestSeen, v); if (calls >= limit) sig.aborted = true; return v }
    return { sig, fn, get calls() { return calls }, get best() { return bestSeen } }
  }
  const s1 = stopAt(40)
  const n1 = nelderMead(s1.fn, [-1.2, 1], { signal: s1.sig })
  const s2 = stopAt(100)
  const c2 = cmaes(s2.fn, [-1, -1, -1], { signal: s2.sig, seed: 1, restarts: 2 })
  const s3 = stopAt(500)
  const z3 = nsga2((x) => { s3.fn(x); return [x[0], 1 - Math.sqrt(x[0]) + x[1]] }, { lower: [0, 0], upper: [1, 1], popSize: 20, generations: 100, signal: s3.sig })
  ok('signal 置位：NM 在本轮迭代末尾停（至多再求值 n + 1 次），返回已见最好值，reason = aborted',
    n1.reason === 'aborted' && n1.nEval === s1.calls && n1.nEval <= 40 + 3 && n1.f === s1.best && Array.isArray(n1.x), `${n1.nEval} 次求值`)
  ok('signal 置位：CMA-ES（含重启）停在当代末尾，不再重启', c2.reason === 'aborted' && c2.nEval === s2.calls && c2.nEval < 110 && c2.f === s2.best && c2.restarts === 0)
  ok('signal 置位：NSGA-II 停在当代末尾，前沿照常给出', z3.reason === 'aborted' && z3.nEval === 500 && z3.nGen === 24 && z3.front.length > 0)
  ok('未置位时 NSGA-II 报 generations 跑满', nsga2((x) => [x[0], 1 - x[0]], { lower: [0], upper: [1], popSize: 4, generations: 3 }).reason === 'generations')

  ok('混合空间变量重名报错（含与缺省名 x1 撞名）', throws(() => makeSpace([{ name: 'x1', type: 'real', lower: 0, upper: 1 }, { type: 'int', lower: 5, upper: 9 }]))
    && throws(() => makeSpace([{ name: 'a', type: 'int', lower: 0, upper: 1 }, { name: 'a', type: 'int', lower: 0, upper: 1 }])))
  const sp = makeSpace([{ name: 'D', type: 'real', lower: 0.6, upper: 3 }, { name: 'n', type: 'int', lower: 1, upper: 4 }])
  ok('编码时连续维越界 / NaN 报错（不再悄悄夹到端点）', throws(() => sp.encode([30, 2])) && throws(() => sp.encode([NaN, 2])) && same(sp.encode([3, 4]), [1, 0.875]))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
