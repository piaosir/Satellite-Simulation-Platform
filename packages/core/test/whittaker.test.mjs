// Whittaker–Shannon 上采样（SATSOFT Whittaker Interpolation Density）自测：
//   ① 原网格节点逐位保留；与「DFT 零填充 ×N」参考实现逐点一致（奇 / 偶点数、含 Nyquist 对半分的偶数档）
//   ② 带内三角多项式精确重建（周期 sinc 插值的定义性质）
//   ③ whittakerBeam：范围不变、点数 N(n−1)+1、P = |c|²、缓存命中、N ≤ 1 原样返回、密度夹到 1～10
//   ④ 181×181 密度 5 的耗时（打印，不断言）
// 运行：npm test
import assert from 'node:assert'
import { performance } from 'node:perf_hooks'
import { dirichlet, upsample2D, whittakerBeam, upsampledPts, clampDensity } from '../../../src/viz/grd/whittaker.js'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }

// 参考实现：DFT → 零填充 ×N → 逆变换（与 covRealGrd.test.mjs ④ 同一份，偶数长度的 Nyquist 项 = X[M/2]·cos(πt)，即对半分到 ±M/2 之和，只丢正弦）
const whittaker2D = (x, NX, NY, N) => {
  const W = N * NX, H = N * NY
  const Ar = new Float64Array(NX * NY), Ai = new Float64Array(NX * NY)
  for (let r = 0; r < NY; r++) for (let k = 0; k < NX; k++) { let re = 0, im = 0; for (let c = 0; c < NX; c++) { const a = -2 * Math.PI * c * k / NX, v = x[r * NX + c]; re += v * Math.cos(a); im += v * Math.sin(a) } Ar[r * NX + k] = re; Ai[r * NX + k] = im }
  const Br = new Float64Array(NX * NY), Bi = new Float64Array(NX * NY)
  for (let k = 0; k < NX; k++) for (let l = 0; l < NY; l++) { let re = 0, im = 0; for (let r = 0; r < NY; r++) { const a = -2 * Math.PI * r * l / NY, ar = Ar[r * NX + k], ai = Ai[r * NX + k], cc = Math.cos(a), ss = Math.sin(a); re += ar * cc - ai * ss; im += ar * ss + ai * cc } Br[l * NX + k] = re; Bi[l * NX + k] = im }
  const freqs = (M) => { const fr = new Float64Array(M), w = new Float64Array(M); for (let l = 0; l < M; l++) { if (l < M / 2) { fr[l] = l; w[l] = 1 } else if (l === M / 2) { fr[l] = l; w[l] = 0.5 } else { fr[l] = l - M; w[l] = 1 } } return { f: fr, w } }
  const FY = freqs(NY), FX = freqs(NX)
  const Cr = new Float64Array(NX * H), Ci = new Float64Array(NX * H)
  for (let k = 0; k < NX; k++) for (let m = 0; m < H; m++) { let re = 0, im = 0; for (let l = 0; l < NY; l++) { const a = 2 * Math.PI * FY.f[l] * m / H, br = Br[l * NX + k], bi = Bi[l * NX + k], cc = Math.cos(a), ss = Math.sin(a) * (FY.w[l] < 1 ? 0 : 1); re += br * cc - bi * ss; im += br * ss + bi * cc } Cr[m * NX + k] = re / NY; Ci[m * NX + k] = im / NY }
  const out = new Float64Array(W * H)
  for (let m = 0; m < H; m++) for (let n2 = 0; n2 < W; n2++) { let re = 0; for (let k = 0; k < NX; k++) { const a = 2 * Math.PI * FX.f[k] * n2 / W; re += Cr[m * NX + k] * Math.cos(a) - Ci[m * NX + k] * Math.sin(a) * (FX.w[k] < 1 ? 0 : 1) } out[m * W + n2] = re / NX }
  return out
}

// ============ ① 节点保留 + 与 DFT 零填充参考逐点一致 ============
{
  ok(Math.abs(dirichlet(11, 0) - 1) < 1e-15 && Math.abs(dirichlet(11, 3)) < 1e-12 && Math.abs(dirichlet(12, 5)) < 1e-12 && Math.abs(dirichlet(12, 6)) < 1e-12, 'Dirichlet 核：D(0)=1，非零整数（含偶数长度的 n/2）处为 0')
  for (const [NX, NY, N] of [[11, 7, 3], [12, 8, 4], [9, 9, 5], [10, 7, 2]]) {
    const src = Float64Array.from({ length: NX * NY }, (_, i) => Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9) - 0.2)
    const out = upsample2D(src, NX, NY, N), NX2 = N * (NX - 1) + 1, NY2 = N * (NY - 1) + 1
    const ref = whittaker2D(src, NX, NY, N), W = N * NX
    let nodeErr = 0, refErr = 0
    for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) nodeErr = Math.max(nodeErr, Math.abs(out[(r * N) * NX2 + c * N] - src[r * NX + c]))
    for (let r = 0; r < NY2; r++) for (let c = 0; c < NX2; c++) refErr = Math.max(refErr, Math.abs(out[r * NX2 + c] - ref[r * W + c]))
    ok(out.length === NX2 * NY2 && nodeErr < 1e-12, `${NX}×${NY} 密度 ${N}：${NX2}×${NY2}，原节点逐位保留（最大 |Δ| ${nodeErr.toExponential(1)}）`)
    ok(refErr < 1e-9, `${NX}×${NY} 密度 ${N}：与 DFT 零填充参考逐点一致（最大 |Δ| ${refErr.toExponential(1)}）`)
  }
}

// ============ ② 带内三角多项式精确重建 ============
{
  const NX = 15, NY = 12, N = 4
  const f = (x, y) => Math.cos(2 * Math.PI * 3 * x / NX + 0.4) * Math.cos(2 * Math.PI * 2 * y / NY - 0.7) + 0.5 * Math.sin(2 * Math.PI * 5 * x / NX)
  const src = new Float64Array(NX * NY)
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) src[r * NX + c] = f(c, r)
  const out = upsample2D(src, NX, NY, N), NX2 = N * (NX - 1) + 1, NY2 = N * (NY - 1) + 1
  let err = 0
  for (let r = 0; r < NY2; r++) for (let c = 0; c < NX2; c++) err = Math.max(err, Math.abs(out[r * NX2 + c] - f(c / N, r / N)))
  ok(err < 1e-9, `带内模式（3/15、5/15、2/12）在细网格上按解析式重建（最大 |Δ| ${err.toExponential(1)}）`)
}

// ============ ③ whittakerBeam ============
{
  const NX = 9, NY = 7, n = NX * NY
  const c1re = new Float32Array(n), c1im = new Float32Array(n), c2re = new Float32Array(n), c2im = new Float32Array(n), P1 = new Float32Array(n), P2 = new Float32Array(n)
  for (let k = 0; k < n; k++) { c1re[k] = Math.cos(k * 0.3); c1im[k] = Math.sin(k * 0.21); c2re[k] = 0.1 * Math.cos(k * 0.7); c2im[k] = 0.05; P1[k] = c1re[k] ** 2 + c1im[k] ** 2; P2[k] = c2re[k] ** 2 + c2im[k] ** 2 }
  const beam = { grid: { XS: -3, YS: -2, XE: 3, YE: 2, NX, NY }, P1, P2, c1re, c1im, c2re, c2im, proj: null, peakDb: 42.5, peak: [1, 2] }
  ok(whittakerBeam(beam, 1) === beam && whittakerBeam(beam, 0) === beam && whittakerBeam(beam, 'x') === beam && whittakerBeam(null, 5) === null, 'N ≤ 1 / 非法值 / 空波束 → 原样返回')
  const b = whittakerBeam(beam, 3)
  ok(b !== beam && b.grid.XS === -3 && b.grid.XE === 3 && b.grid.YS === -2 && b.grid.YE === 2 && b.grid.NX === 3 * (NX - 1) + 1 && b.grid.NY === 3 * (NY - 1) + 1, '派生波束：网格范围不变，点数 N(n−1)+1')
  ok(b.peakDb === 42.5 && b.peak === beam.peak && b._dens === 3 && b._base === beam && b.proj === null, '派生波束：峰值元数据照抄、_dens / _base 记录、proj 留空')
  let pe = 0, ne = 0
  for (let k = 0; k < b.P1.length; k++) pe = Math.max(pe, Math.abs(b.P1[k] - (b.c1re[k] * b.c1re[k] + b.c1im[k] * b.c1im[k])), Math.abs(b.P2[k] - (b.c2re[k] * b.c2re[k] + b.c2im[k] * b.c2im[k])))
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) ne = Math.max(ne, Math.abs(b.c1re[(r * 3) * b.grid.NX + c * 3] - c1re[r * NX + c]))
  ok(pe < 1e-6 && ne < 1e-6, `功率 = |复振幅|²、原节点逐位保留（|Δ| ${pe.toExponential(1)} / ${ne.toExponential(1)}）`)
  ok(whittakerBeam(beam, 3) === b && whittakerBeam(beam, 2) !== b && whittakerBeam(beam, 3) !== b, '缓存：同密度命中同一对象，换密度重算')
  ok(upsampledPts(beam, 3) === b.grid.NX * b.grid.NY && upsampledPts(beam, 1) === n, 'upsampledPts 与派生网格点数一致')
  ok(clampDensity(5.4) === 5 && clampDensity(0) === 1 && clampDensity(99) === 10 && clampDensity(undefined) === 1 && clampDensity('3') === 3, 'clampDensity：取整、夹到 1～10、非法值 1')
  // 只有功率的方向图（无复振幅）：按振幅上采样，节点保留、不出负功率
  const bp = whittakerBeam({ grid: { XS: -3, YS: -2, XE: 3, YE: 2, NX, NY }, P1, P2, peakDb: 1 }, 2)
  let neg = 0, nodeP = 0
  for (let k = 0; k < bp.P1.length; k++) if (bp.P1[k] < 0 || bp.P2[k] < 0) neg++
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) nodeP = Math.max(nodeP, Math.abs(bp.P1[(r * 2) * bp.grid.NX + c * 2] - P1[r * NX + c]))
  ok(bp.c1re === null && neg === 0 && nodeP < 1e-5, `无复振幅时按振幅上采样：无负功率、节点保留（|Δ| ${nodeP.toExponential(1)}）`)
}

// ============ ④ 耗时 ============
{
  const NX = 181, NY = 181, n = NX * NY
  const mk = (s) => Float32Array.from({ length: n }, (_, i) => Math.exp(-((i % NX - 90) ** 2 + ((i / NX | 0) - 90) ** 2) / 800) * Math.cos(i * s))
  const beam = { grid: { XS: -9, YS: -9, XE: 9, YE: 9, NX, NY }, c1re: mk(0.1), c1im: mk(0.2), c2re: mk(0.3), c2im: mk(0.4), P1: new Float32Array(n), P2: new Float32Array(n) }
  const t0 = performance.now(); const b = whittakerBeam(beam, 5); const ms = performance.now() - t0
  console.log(`  [耗时] 181×181 密度 5 → ${b.grid.NX}×${b.grid.NY}，四分量 ${ms.toFixed(0)} ms`)
  ok(b.grid.NX === 901, '181 点密度 5 → 901 点')
}

console.log(`whittaker.test.mjs：${pass} 条断言全绿`)
