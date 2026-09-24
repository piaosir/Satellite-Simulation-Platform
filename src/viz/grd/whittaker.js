// Whittaker–Shannon 上采样 —— SATSOFT Contour Dialog 的「Whittaker Interpolation Density」（手册 §1.1.4 / §11.1）。
// 密度 N > 1 时把方向图的复场按周期 sinc（Dirichlet 核）插成 N 倍细的网格，下游投影 / 场 / 分带 / 峰值全部在细网格上跑，
// 与 SATSOFT 一样直接在细网格上做线性 marching squares；N = 1 即「关」。
//
// 口径：与「DFT 零填充 ×N 再逆变换」逐位等价（同一个周期延拓的三角多项式插值）。奇数点数用 Dirichlet 核
//   D_n(t) = sin(πt) / (n·sin(πt/n))，偶数点数把 Nyquist 频点对半分到 ±n/2（实值、最小范数）→ D_n(t) = sin(πt) / (n·tan(πt/n))。
//   两者在整数 t 处恒为 δ → 原网格节点逐位保留；周期 n → 循环卷积，边界按周期延拓（截断的方向图会振铃，手册 p.33 原话，
//   边界电平不到峰下 30 dB 时该用 1 = 关）。
// 实现：可分离，行向再列向；每个偏移 j/N 一条「加倍」核 Kd（Kd[i] = D_n((i mod n) + j/N)），内层无取模；
//   列向按整行扫（访存连续）。181×181 密度 5：约 5.6 亿次乘加、本机 0.5～1 s，派生波束缓存在原波束上，换密度才重算。
// 不做 FFT：181 这类素数长度要 Bluestein，代价与直接卷积同量级，代码却多一倍。

import { materializeBeam } from './gaussStk.js'

const _kern = new Map()   // 'n|N' → [Kd_1 … Kd_{N−1}]，每条 Float64Array(2n)

// 密度只认 1～10 的整数；非法值一律 1（= 关）
export const clampDensity = (v) => { const n = Math.round(+v); return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 1 }

// 周期 sinc：周期 n，D(0) = 1，非零整数处 0
export function dirichlet(n, t) {
  const r = t - n * Math.round(t / n)          // 折到 [−n/2, n/2]
  if (Math.abs(r) < 1e-12) return 1
  const a = Math.PI * r
  return (n & 1) ? Math.sin(a) / (n * Math.sin(a / n)) : Math.sin(a) / (n * Math.tan(a / n))
}

function kernels(n, N) {
  const key = n + '|' + N
  let k = _kern.get(key)
  if (k) return k
  k = []
  for (let j = 1; j < N; j++) {
    const kd = new Float64Array(2 * n)
    for (let i = 0; i < 2 * n; i++) kd[i] = dirichlet(n, (i % n) + j / N)
    k.push(kd)
  }
  if (_kern.size > 32) _kern.clear()
  _kern.set(key, k)
  return k
}

// 一张 NX×NY 的实数网格 → (N(NX−1)+1) × (N(NY−1)+1)，范围不变、原节点逐位保留。返回 Float64Array（行主序）。
export function upsample2D(src, NX, NY, N) {
  N = clampDensity(N)
  if (N <= 1) return Float64Array.from(src)
  const NX2 = N * (NX - 1) + 1, NY2 = N * (NY - 1) + 1
  const kx = kernels(NX, N), ky = kernels(NY, N)
  // 行向：NY 行 × NX → NY 行 × NX2
  const mid = new Float64Array(NY * NX2)
  for (let r = 0; r < NY; r++) {
    const ib = r * NX, ob = r * NX2
    for (let p = 0; p < NX; p++) mid[ob + p * N] = src[ib + p]
    for (let j = 1; j < N; j++) {
      const kd = kx[j - 1]
      for (let p = 0; p < NX - 1; p++) {
        let acc = 0
        const kb = p + NX                                   // Kd[p − m + NX]，(p − m) mod NX 的加倍索引
        for (let m = 0; m < NX; m++) acc += src[ib + m] * kd[kb - m]
        mid[ob + p * N + j] = acc
      }
    }
  }
  // 列向：内层沿整行（NX2 个列）扫，访存连续
  const out = new Float64Array(NY2 * NX2)
  for (let p = 0; p < NY; p++) out.set(mid.subarray(p * NX2, (p + 1) * NX2), p * N * NX2)
  for (let j = 1; j < N; j++) {
    const kd = ky[j - 1]
    for (let p = 0; p < NY - 1; p++) {
      const ob = (p * N + j) * NX2, kb = p + NY
      for (let m = 0; m < NY; m++) {
        const w = kd[kb - m]
        if (w === 0) continue
        const ib = m * NX2
        for (let c = 0; c < NX2; c++) out[ob + c] += w * mid[ib + c]
      }
    }
  }
  return out
}

// 上采样后的点数（预算用）
export const upsampledPts = (beam, N) => { const g = beam.grid; N = clampDensity(N); return (N * (g.NX - 1) + 1) * (N * (g.NY - 1) + 1) }

// 派生波束：与导入波束同一形状（grid / P1 / P2 / 复振幅四分量 / peakDb），投影与各类缓存挂在派生对象自己身上。
// 缓存在原波束的 _whit 上（只留一档：换密度就重算）；N ≤ 1 原样返回原波束。
export function whittakerBeam(beam, N) {
  N = clampDensity(N)
  if (!beam || N <= 1) return beam
  const w = beam._whit
  if (w && w.N === N) return w.beam
  const g = beam.grid, NX = g.NX, NY = g.NY
  const NX2 = N * (NX - 1) + 1, NY2 = N * (NY - 1) + 1, n = NX2 * NY2
  // 解析天线（beam.an）：不插值 —— 按参数在同一窗口上直接铺 N 倍密的网格，节点值仍是闭式精确值
  //（周期 sinc 对截断窗口会振铃，精确函数没必要吃这份误差）。窗口由 an 唯一确定，与原网格逐位同一范围。
  if (beam.an && NX2 === NY2) {
    const st = materializeBeam(beam.an, NX2)
    const b = { grid: { XS: st.XS, YS: st.YS, XE: st.XE, YE: st.YE, NX: st.NX, NY: st.NY, ...(g.exact ? { exact: true } : {}) }, P1: st.P1, P2: st.P2, c1re: st.c1re, c1im: st.c1im, c2re: st.c2re, c2im: st.c2im, an: beam.an, proj: null, peakDb: beam.peakDb, peak: beam.peak, _base: beam, _dens: N }
    beam._whit = { N, beam: b }
    return b
  }
  const up = (a) => Float32Array.from(upsample2D(a, NX, NY, N))
  let c1re = null, c1im = null, c2re = null, c2im = null, P1, P2
  if (beam.c1re && beam.c1im && beam.c2re && beam.c2im) {
    c1re = up(beam.c1re); c1im = up(beam.c1im); c2re = up(beam.c2re); c2im = up(beam.c2im)
    P1 = new Float32Array(n); P2 = new Float32Array(n)
    for (let k = 0; k < n; k++) { P1[k] = c1re[k] * c1re[k] + c1im[k] * c1im[k]; P2[k] = c2re[k] * c2re[k] + c2im[k] * c2im[k] }
  } else {
    // 没有复振幅（只带功率的方向图）：按振幅 √P 上采样再平方 —— 振幅非负且比功率平滑；负过冲夹到 0
    const amp = (P) => {
      const a = new Float64Array(P.length)
      for (let k = 0; k < P.length; k++) a[k] = Math.sqrt(Math.max(0, P[k]))
      const u = upsample2D(a, NX, NY, N), o = new Float32Array(n)
      for (let k = 0; k < n; k++) { const v = u[k]; o[k] = v > 0 ? v * v : 0 }
      return o
    }
    P1 = amp(beam.P1); P2 = amp(beam.P2)
  }
  const b = { grid: { XS: g.XS, YS: g.YS, XE: g.XE, YE: g.YE, NX: NX2, NY: NY2 }, P1, P2, c1re, c1im, c2re, c2im, proj: null, peakDb: beam.peakDb, peak: beam.peak, _base: beam, _dens: N }
  beam._whit = { N, beam: b }
  return b
}
