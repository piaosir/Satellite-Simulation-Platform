// ================= 严格 minimax 求解器（赋形优化内核，反射面 / 相控阵共用） =================
// 目标：max_x min_m 余量_m ⇔ min_x max_m r_m(x)（Chebyshev 解）。r 是【站点残差】：
//   contour 站（区内/边界）r_m = T_m − f_m（欠额为正）；sidelobe 站（抑制）r_m = f_m − T_m（超标为正）。
//   f_m = 10·log10(|E_m|²/P) 是【归一化相对增益】——对 x 整体缩放不变，这是序列线性化能工作的前提：
//   不归一的 f 会让 LP 沿「整体放大」方向无限走，一撞信赖域就停。
//
// 算法：Madsen 派序列线性规划（SLP）+ 信赖域外环；LP 子问题走 Mehrotra 预估–校正原对偶内点法。
//   K. Madsen, "An algorithm for minimax solution of overdetermined systems of non-linear equations",
//     J. Inst. Math. Appl. 16 (1975)；
//   J. Hald & K. Madsen, "Combined LP and quasi-Newton methods for minimax optimization",
//     Math. Programming 20 (1981) 49–62（本模块只做其第一阶段 SLP，对赋形问题已足够收敛）。
//
// 【诚实边界】本实现对齐的是 SATSOFT 的【算法类】与【语义】，不承诺与之 bit-exact：
//   · 算法类：手册 §10.2「The optimizer uses a mini-max algorithm, an iterative procedure that minimizes
//     the maximum error at each iteration」；二进制漏出的模块名 MIN_MAX_MODULE_mp_MMLPA_NEW（minimax LP
//     algorithm）与 ITPOINT_MODULE_mp_INTERIOR_POINT_FEASI（可行内点法）指向同一条 SLP + 内点 LP 路线。
//   · 语义：最差余量最大化、增益只看相对值（整体缩放不变）、迭代到「改善低于阈值或到轮数上限」为止。
//   · 不承诺一致的部分：SATSOFT 的 LP/minimax 内循环为专有实现（步长、信赖域、活跃集处理细节不公开），
//     数值不会逐位相同。minimax 问题本身非凸，终解可能是【局部极小】——手册 §10.2 自认「there is no
//     guarantee that the optimizer will converge on the best possible solution ... it may well converge
//     on a relative minimum」。本模块同此性质：初值决定落到哪个极小。
//
// 纯函数、无 DOM、无 Vue、无第三方依赖；热区一律 Float64Array，不做逐步 Array 复制。

const K10 = 10 / Math.LN10                          // d(10log10 y)/dy · y ＝ 10/ln10

// 剖析计数（诊断用，主线程同步求解的耗时全在这几处）：法矩阵装配 / Cholesky 分解（含正则重试次数）/ 其余
export const PROF = { normalMs: 0, cholMs: 0, cholTries: 0, steps: 0 }
const _now = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now())

// —— Cholesky（下三角就地）：法方程 N·Δz = rhs 每内点步一次分解、两次回代 ——
// 只读/只写下三角（上三角是垃圾，装配端因此不必镜像，省一趟 O(n²)）。
// ★ 四行一组的寄存器分块（Cholesky–Banachiewicz 行块版）：一组四行对同一个「行 j」做点积时行 j 只从内存读一次、
//   四个累加器并行。n≈700 时矩阵 4 MB 出了 L2，逐行版是内存带宽在限速（实测 1 GFMA/s，一次分解 25 ms，
//   赋形一次 160 次分解就是 4 s）。每一行的累加顺序（k 升序）与逐行版完全相同，结果逐位一致。
//   组内 i < j 的那几格算出来是上三角的垃圾（上三角本就是垃圾，见上），不读、不判，只是少量多余乘加。
function cholFactor(A, n) {
  let i0 = 0
  for (; i0 + 4 <= n; i0 += 4) {
    const r0 = i0 * n, r1 = r0 + n, r2 = r1 + n, r3 = r2 + n
    for (let j = 0; j <= i0 + 3; j++) {
      const rj = j * n
      let s0 = A[r0 + j], s1 = A[r1 + j], s2 = A[r2 + j], s3 = A[r3 + j]
      for (let k = 0; k < j; k++) {
        const ljk = A[rj + k]
        s0 -= A[r0 + k] * ljk; s1 -= A[r1 + k] * ljk; s2 -= A[r2 + k] * ljk; s3 -= A[r3 + k] * ljk
      }
      if (j < i0) {
        const d = A[rj + j]
        A[r0 + j] = s0 / d; A[r1 + j] = s1 / d; A[r2 + j] = s2 / d; A[r3 + j] = s3 / d
      } else {
        // j 落在本组里：先出对角（该行 i=j），组内后面的行再除它；组内 i<j 的格是上三角垃圾，随手写掉
        const jj = j - i0
        const sv = [s0, s1, s2, s3]
        const sd = sv[jj]
        if (!(sd > 1e-300)) return false
        const d = Math.sqrt(sd)
        A[rj + j] = d
        for (let q = 0; q < 4; q++) { if (q === jj) continue; A[(i0 + q) * n + j] = sv[q] / d }
      }
    }
  }
  for (let i = i0; i < n; i++) {                          // 余下不足四行的按逐行版
    const ri = i * n
    for (let j = 0; j <= i; j++) {
      const rj = j * n
      let s = A[ri + j]
      for (let k = 0; k < j; k++) s -= A[ri + k] * A[rj + k]
      if (i === j) { if (!(s > 1e-300)) return false; A[ri + i] = Math.sqrt(s) }
      else A[ri + j] = s / A[rj + j]
    }
  }
  return true
}
function cholSolve(L, b, n, out) {
  const x = out || new Float64Array(n)
  if (x !== b) x.set(b)
  for (let i = 0; i < n; i++) { const ri = i * n; let s = x[i]; for (let k = 0; k < i; k++) s -= L[ri + k] * x[k]; x[i] = s / L[ri + i] }
  for (let i = n - 1; i >= 0; i--) { let s = x[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]; x[i] = s / L[i * n + i] }
  return x
}

// —— LP 内点法内核：min cᵀz s.t. A z ≤ b。A 只通过三个算子出现（不物化稠密 A，见 createMinimax 的 normal）——
//   ops.mulA(v, out)     out ← A·v            （长度 rows）
//   ops.mulAT(v, out)    out ← Aᵀ·v           （长度 n）
//   ops.normal(d, Nm)    Nm ← Aᵀ·diag(d)·A    （n×n，只填下三角）
// 返回 { z, y, s, iters, ok, feas }：y = 对偶乘子（≥0），s = 松弛（≥0），feas = 原始越界量（≤0 即可行）。
//
// ★ 对偶残差是 r_d = −c − Aᵀy，即最优性条件 Aᵀy = −c（不是 +c）。本问题的 t 列在站点行上恒为 −1，
//   写成 +c 时该列要求 Σ(−y_m) = +1 而 y ≥ 0，永远无解 → LP 每次跑满迭代上限、步长塌到 0。
function lpCore(ops, b, c, n, rows, z0, s0, maxIter) {
  const z = Float64Array.from(z0), s = Float64Array.from(s0), y = new Float64Array(rows).fill(1)
  const Az = new Float64Array(rows), rp = new Float64Array(rows), rd = new Float64Array(n), rc = new Float64Array(rows)
  const Nm = new Float64Array(n * n), Cw = new Float64Array(n * n), rhs = new Float64Array(n), tmp = new Float64Array(rows)
  const dcol = new Float64Array(rows)
  const dz = new Float64Array(n), ds = new Float64Array(rows), dy = new Float64Array(rows)
  const dzA = new Float64Array(n), dsA = new Float64Array(rows), dyA = new Float64Array(rows)
  let it = 0, ok = false
  const solveNewton = (rcv, outZ, outS, outY, L) => {
    for (let i = 0; i < rows; i++) tmp[i] = (rcv[i] - y[i] * rp[i]) / s[i]
    ops.mulAT(tmp, rhs)
    for (let j = 0; j < n; j++) rhs[j] = rd[j] - rhs[j]
    cholSolve(L, rhs, n, outZ)
    ops.mulA(outZ, tmp)
    for (let i = 0; i < rows; i++) { outS[i] = rp[i] - tmp[i]; outY[i] = (rcv[i] - y[i] * outS[i]) / s[i] }
  }
  const stepMax = (v, dv) => { let a = 1; for (let i = 0; i < v.length; i++) if (dv[i] < 0) { const t = -v[i] / dv[i]; if (t < a) a = t } return a }
  for (it = 0; it < maxIter; it++) {
    ops.mulA(z, Az)
    let pn = 0, mu = 0
    for (let i = 0; i < rows; i++) { rp[i] = b[i] - Az[i] - s[i]; const ap = Math.abs(rp[i]); if (ap > pn) pn = ap; mu += y[i] * s[i] }
    mu /= rows
    ops.mulAT(y, rd)
    let dn = 0
    for (let j = 0; j < n; j++) { rd[j] = -c[j] - rd[j]; const ad = Math.abs(rd[j]); if (ad > dn) dn = ad }
    let obj = 0
    for (let j = 0; j < n; j++) obj += c[j] * z[j]
    if (mu < 1e-9 * (1 + Math.abs(obj)) && pn < 1e-8 && dn < 1e-8) { ok = true; break }
    for (let i = 0; i < rows; i++) dcol[i] = y[i] / s[i]
    const _tn = _now()
    ops.normal(dcol, Nm)
    const _tc = _now()
    PROF.normalMs += _tc - _tn; PROF.steps++
    // 法矩阵奇异（尺度不变方向 + 退化活跃集）→ 对角加正则重试；reg 从 1e-12 起每次 ×100，最多 8 档
    let L = null
    for (let k = 0, reg = 1e-12; k < 8 && !L; k++, reg *= 100) {
      Cw.set(Nm)
      for (let a = 0; a < n; a++) { const p = a * n + a; Cw[p] += reg * (1 + Math.abs(Nm[p])) }
      PROF.cholTries++
      if (cholFactor(Cw, n)) L = Cw
    }
    PROF.cholMs += _now() - _tc
    if (!L) break
    for (let i = 0; i < rows; i++) rc[i] = -y[i] * s[i]                                  // 预估（affine scaling）
    solveNewton(rc, dzA, dsA, dyA, L)
    const apA = stepMax(s, dsA), adA = stepMax(y, dyA)
    let muA = 0
    for (let i = 0; i < rows; i++) muA += (y[i] + adA * dyA[i]) * (s[i] + apA * dsA[i])
    muA /= rows
    const sig = Math.min(1, Math.pow(Math.max(muA / mu, 0), 3))
    for (let i = 0; i < rows; i++) rc[i] = sig * mu - y[i] * s[i] - dyA[i] * dsA[i]       // 校正（centering + 二阶项）
    solveNewton(rc, dz, ds, dy, L)
    const ap = Math.min(1, 0.995 * stepMax(s, ds)), ad = Math.min(1, 0.995 * stepMax(y, dy))
    for (let j = 0; j < n; j++) z[j] += ap * dz[j]
    for (let i = 0; i < rows; i++) { s[i] += ap * ds[i]; y[i] += ad * dy[i] }
  }
  // 原始可行性：未收敛不等于失败，只要 A z ≤ b + 1e-6 仍可交给外环的实际/预测比裁决（计数另记）
  ops.mulA(z, Az)
  let feas = 0
  // ★ 写成 !(v <= feas) 而不是 v > feas：z 一旦是 NaN（法矩阵全败后的垃圾步）v 也是 NaN，
  //   v > feas 恒假会让 feas 停在 0、被当成「原始可行」放行 —— NaN 步进了外环，信赖域两个分支都不进，空转到上限。
  for (let i = 0; i < rows; i++) { const v = Az[i] - b[i]; if (!(v <= feas)) feas = v }
  return { z, y, s, iters: it, ok, feas }
}

// 稠密 A 版 LP（通用入口，供测试对暴力顶点解）：A 为 rows×n 行主序。opts = { z0, s0, maxIter }。
// z0 缺省 0（此时要求 b > 0 才严格可行），s0 缺省 b − A·z0。
export function lpSolveIpm(A, b, c, n, rows, opts = {}) {
  const z0 = opts.z0 || new Float64Array(n)
  let s0 = opts.s0
  if (!s0) {
    s0 = new Float64Array(rows)
    for (let i = 0; i < rows; i++) { let t = 0; const r = i * n; for (let j = 0; j < n; j++) t += A[r + j] * z0[j]; s0[i] = b[i] - t }
  }
  const ops = {
    mulA: (v, out) => { for (let i = 0; i < rows; i++) { let t = 0; const r = i * n; for (let j = 0; j < n; j++) t += A[r + j] * v[j]; out[i] = t } },
    mulAT: (v, out) => { out.fill(0); for (let i = 0; i < rows; i++) { const vi = v[i]; if (vi === 0) continue; const r = i * n; for (let j = 0; j < n; j++) out[j] += A[r + j] * vi } },
    normal: (d, Nm) => {
      Nm.fill(0)
      for (let i = 0; i < rows; i++) {
        const di = d[i], r = i * n
        if (di === 0) continue
        for (let a = 0; a < n; a++) { const va = A[r + a] * di; if (va === 0) continue; const base = a * n; for (let q = 0; q <= a; q++) Nm[base + q] += va * A[r + q] }
      }
    }
  }
  return lpCore(ops, b, c, n, rows, z0, s0, Number.isFinite(opts.maxIter) ? opts.maxIter : 60)
}

// ================= createMinimax =================
// problem = {
//   N,                            // 自由度数（beamlet / Butler 端口），复激励 w ∈ ℂ^N
//   rows: [{ nb, g, sign, T }],   // 站点：nb=可见 beamlet 下标，g=实场系数，sign −1 contour / +1 sidelobe，T=目标 dB
//   Q,                            // 归一化功率矩阵：Float64Array(N*N)，或 { diag: Ω }（正交基，如理想 Butler 波束）
//   x0,                           // 初值 Float64Array(2N)：[Re w ; Im w]
//   opts: { tolDb = 0.01, maxIter = 60(N>250 → 40), lpMaxIter = 60, deltaFrac = 0.5, deltaFracWarm = 0.25 }
// }
// solver.run(maxIter?) → { x, maxRes, resid, active, iters, accepted, lpIters, lpFail, hist, converged, nStations }
// solver.setGoals(T)     只换目标（峰值点抬坡热启动），保留 x 与统计；下一次 run 的信赖域按 deltaFracWarm 重置
export function createMinimax(problem) {
  const N = problem.N | 0
  const srcRows = problem.rows || []
  const M = srcRows.length
  const n2 = 2 * N, n = n2 + 1
  const o = problem.opts || {}
  const tolDb = Number.isFinite(o.tolDb) ? o.tolDb : 0.01
  const maxIterDef = Number.isFinite(o.maxIter) ? o.maxIter : (N > 250 ? 40 : 60)
  const lpMaxIter = Number.isFinite(o.lpMaxIter) ? o.lpMaxIter : 60
  const dFrac0 = Number.isFinite(o.deltaFrac) ? o.deltaFrac : 0.5
  const dFracWarm = Number.isFinite(o.deltaFracWarm) ? o.deltaFracWarm : 0.25
  // 一次 run 的墙钟上限（ms）：到时就停、如实记 stoppedBy='time'，不冻死主线程；缺省不限
  const maxMs = (Number.isFinite(o.maxMs) && o.maxMs > 0) ? o.maxMs : Infinity
  const now = () => ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now())

  // —— 站点扁平化（热区全 Float64Array/Int32Array）。nb 必须按 beamlet 序号升序：
  //    下三角装配靠「全局索引 [nb… , N+nb…] 单调」省掉一半写入。——
  const off = new Int32Array(M + 1)
  for (let m = 0; m < M; m++) off[m + 1] = off[m] + srcRows[m].nb.length
  const nnz = off[M]
  const nbF = new Int32Array(nnz), gF = new Float64Array(nnz)
  const sgn = new Float64Array(M), Tg = new Float64Array(M)
  let maxL = 1
  for (let m = 0; m < M; m++) {
    const r = srcRows[m], nb = r.nb, g = r.g, L = nb.length, p0 = off[m]
    if (L > maxL) maxL = L
    let sorted = true
    for (let a = 1; a < L; a++) if (nb[a] < nb[a - 1]) { sorted = false; break }
    if (sorted) { for (let a = 0; a < L; a++) { nbF[p0 + a] = nb[a]; gF[p0 + a] = g[a] } }
    else {
      const ord = []
      for (let a = 0; a < L; a++) ord.push(a)
      ord.sort((p, q) => nb[p] - nb[q])
      for (let a = 0; a < L; a++) { nbF[p0 + a] = nb[ord[a]]; gF[p0 + a] = g[ord[a]] }
    }
    sgn[m] = r.sign < 0 ? -1 : 1
    Tg[m] = r.T
  }

  // —— 归一化功率 P(x) = xᵀQ̃x，Q̃ = blockdiag(Q, Q) ——
  const Qsrc = problem.Q
  const qDiag = (Qsrc && !ArrayBuffer.isView(Qsrc) && Number.isFinite(Qsrc.diag)) ? Qsrc.diag : 0
  const Qd = qDiag ? null : Qsrc
  const Qx = new Float64Array(n2)
  const applyQ = (xx) => {                          // Qx ← Q̃·xx，返回 P = xxᵀQ̃xx
    let P = 0
    if (qDiag) { for (let j = 0; j < n2; j++) { const v = qDiag * xx[j]; Qx[j] = v; P += xx[j] * v } return P }
    for (let j = 0; j < N; j++) {
      let sr = 0, si = 0
      const rj = j * N
      for (let k = 0; k < N; k++) { const q = Qd[rj + k]; sr += q * xx[k]; si += q * xx[N + k] }
      Qx[j] = sr; Qx[N + j] = si
      P += xx[j] * sr + xx[N + j] * si
    }
    return P
  }

  const x = Float64Array.from(problem.x0)
  const aR = new Float64Array(M), aI = new Float64Array(M)   // 每站梯度系数：G_m[Re j]=aR·g、G_m[Im j]=aI·g
  const cV = new Float64Array(n2)                            // 稠密公共向量 c = K·gP = K·2Q̃x/P（全站共享 → 秩一）
  const resid = new Float64Array(M), rTry = new Float64Array(M)

  // 站点场 + 残差 + 梯度缓存；返回 max_m r_m。cache=false 时只求残差（试探步用）。
  const evalAt = (xx, outR, cache) => {
    const P = applyQ(xx)
    if (cache) for (let j = 0; j < n2; j++) cV[j] = K10 * 2 * Qx[j] / P
    const lgP = 10 * Math.log10(P)
    let mx = -Infinity
    for (let m = 0; m < M; m++) {
      let er = 0, ei = 0
      const p0 = off[m], p1 = off[m + 1]
      for (let a = p0; a < p1; a++) { const i = nbF[a], g = gF[a]; er += xx[i] * g; ei += xx[N + i] * g }
      const p2 = Math.max(er * er + ei * ei, 1e-30 * P)      // 防 log(0)：抑制站可能落在深零点（此处梯度巨大属正常）
      const f = 10 * Math.log10(p2) - lgP
      const r = sgn[m] > 0 ? f - Tg[m] : Tg[m] - f
      outR[m] = r
      if (r > mx) mx = r
      if (cache) { const k = K10 * 2 / p2; aR[m] = k * er; aI[m] = k * ei }
    }
    return M ? mx : 0
  }
  const normalize = (xx) => { const P = applyQ(xx); if (P > 0) { const s = 1 / Math.sqrt(P); for (let j = 0; j < n2; j++) xx[j] *= s } }

  // —— LP 装配算子：站点行 [v_m, −1]（v_m = sgn_m·(G_m − c)）+ 4N 行信赖域界约束 ——
  // 不物化稠密 A：G_m 只在 nb[m] 的 Re/Im 位置非零（反射面每站约 13 支 → 26 个非零），c 是全站共享的
  // 稠密向量 → 法矩阵 = 【稀疏 Σ d G Gᵀ，O(M·(2L)²/2)】+【三次秩一更新，O(n²)】，不必逐站铺 n 长的行。
  const rowsLP = M + 2 * n2
  const bLP = new Float64Array(rowsLP), cLP = new Float64Array(n)
  cLP[n - 1] = 1
  const uVec = new Float64Array(n2), uSVec = new Float64Array(n2)
  const vIdx = new Int32Array(2 * maxL), vVal = new Float64Array(2 * maxL)
  const ops = {
    mulA: (v, out) => {
      let ch = 0
      for (let j = 0; j < n2; j++) ch += cV[j] * v[j]
      const t = v[n - 1]
      for (let m = 0; m < M; m++) {
        let sr = 0, si = 0
        const p0 = off[m], p1 = off[m + 1]
        for (let a = p0; a < p1; a++) { const i = nbF[a], g = gF[a]; sr += v[i] * g; si += v[N + i] * g }
        out[m] = sgn[m] * (aR[m] * sr + aI[m] * si - ch) - t
      }
      for (let j = 0; j < n2; j++) { out[M + j] = v[j]; out[M + n2 + j] = -v[j] }
    },
    mulAT: (v, out) => {
      out.fill(0)
      let sv = 0, st = 0
      for (let m = 0; m < M; m++) {
        const vm = v[m]
        if (vm === 0) continue
        const vs = vm * sgn[m]
        sv += vs; st += vm
        const kr = vs * aR[m], ki = vs * aI[m], p0 = off[m], p1 = off[m + 1]
        for (let a = p0; a < p1; a++) { const i = nbF[a], g = gF[a]; out[i] += kr * g; out[N + i] += ki * g }
      }
      for (let j = 0; j < n2; j++) out[j] += -sv * cV[j] + v[M + j] - v[M + n2 + j]
      out[n - 1] = -st
    },
    normal: (d, Nm) => {
      Nm.fill(0)
      uVec.fill(0); uSVec.fill(0)
      let sig = 0, sigS = 0
      // ① 稀疏部分 Σ d_m G_m G_mᵀ（只填下三角；每站 2L 个非零、全局索引升序）
      for (let m = 0; m < M; m++) {
        const dm = d[m]
        if (dm === 0) continue
        const p0 = off[m], L = off[m + 1] - p0, sm = sgn[m], kr = aR[m], ki = aI[m], dsm = dm * sm
        for (let a = 0; a < L; a++) {
          const i = nbF[p0 + a], g = gF[p0 + a], vr = kr * g, vi = ki * g
          vIdx[a] = i; vVal[a] = vr
          vIdx[L + a] = N + i; vVal[L + a] = vi
          uVec[i] += dm * vr; uVec[N + i] += dm * vi
          uSVec[i] += dsm * vr; uSVec[N + i] += dsm * vi
        }
        sig += dm; sigS += dsm
        const LL = 2 * L
        for (let a = 0; a < LL; a++) {
          const va = dm * vVal[a]
          if (va === 0) continue
          const base = vIdx[a] * n
          for (let q = 0; q <= a; q++) Nm[base + vIdx[q]] += va * vVal[q]
        }
      }
      // ② 三次秩一更新（c 稠密、全站共享）：−u cᵀ − c uᵀ + σ c cᵀ
      for (let p = 0; p < n2; p++) {
        const up = uVec[p], cp = cV[p], base = p * n
        for (let q = 0; q <= p; q++) Nm[base + q] += -up * cV[q] - cp * uVec[q] + sig * cp * cV[q]
      }
      // ③ t 列：N_ht[p] = −Σ d·v_m[p] = −uS[p] + σ_S·c[p]；N_tt = Σ d（站点行 t 系数 −1，界行为 0）
      const bt = (n - 1) * n
      for (let p = 0; p < n2; p++) Nm[bt + p] = -uSVec[p] + sigS * cV[p]
      Nm[bt + n - 1] = sig
      // ④ 界约束行（±e_j）：只落在对角
      for (let j = 0; j < n2; j++) Nm[j * n + j] += d[M + j] + d[M + n2 + j]
    }
  }

  // stoppedBy：最近一次 run 因什么停下 —— 'converged'（线性模型的可改善量 < tolDb）/ 'maxIter' / 'time'（到 maxMs）/
  // 'lpfail'（LP 连续解不出）/ 'delta'（信赖域缩到底）。converged 只在第一种情况为真，其余一律为假、由调用方回报。
  const stats = { iters: 0, accepted: 0, lpIters: 0, lpFail: 0, runs: 0, stoppedBy: '', elapsedMs: 0 }
  const hist = []
  let nextFrac = dFrac0
  let F = 0, inited = false

  const snapshot = (converged) => {
    let active = 0
    for (let m = 0; m < M; m++) if (resid[m] >= F - 0.02) active++
    return { x, maxRes: F, resid, active, iters: stats.iters, accepted: stats.accepted, lpIters: stats.lpIters, lpFail: stats.lpFail, hist, converged, nStations: M, stoppedBy: stats.stoppedBy, elapsedMs: stats.elapsedMs }
  }

  const runOnce = (maxIter) => {
    if (!M || !N) { stats.runs++; stats.stoppedBy = 'converged'; return snapshot(true) }
    if (!inited) { normalize(x); inited = true }
    const t0 = now()
    F = evalAt(x, resid, true)
    let xmax = 0
    for (let j = 0; j < n2; j++) { const a = Math.abs(x[j]); if (a > xmax) xmax = a }
    let Delta = Math.max(nextFrac * xmax, 1e-12)
    nextFrac = dFrac0
    const z0 = new Float64Array(n), s0 = new Float64Array(rowsLP), xn = new Float64Array(n2)
    let converged = false, it = 0, stop = '', lpBad = 0
    for (it = 0; it < maxIter; it++) {
      if (now() - t0 > maxMs) { stop = 'time'; break }
      for (let m = 0; m < M; m++) bLP[m] = -resid[m]
      for (let j = 0; j < n2; j++) { bLP[M + j] = Delta; bLP[M + n2 + j] = Delta }
      z0.fill(0); z0[n - 1] = F + 1                              // h=0、t=F+1 → 各站点行松弛 ≥1，严格可行
      for (let m = 0; m < M; m++) s0[m] = bLP[m] + z0[n - 1]
      for (let j = 0; j < 2 * n2; j++) s0[M + j] = Delta
      const lp = lpCore(ops, bLP, cLP, n, rowsLP, z0, s0, lpMaxIter)
      stats.lpIters += lp.iters
      if (!lp.ok) stats.lpFail++
      if (!lp.ok && !(lp.feas <= 1e-6)) { stop = 'lpfail'; break }   // 连原始可行都不满足（或 NaN）→ 这一步不可用
      const pred = F - lp.z[n - 1]                               // 信赖域内线性模型能给的最大改善
      // ★ pred < 0 不是收敛，是 LP 没解出来：法矩阵八档正则全败时 lpCore 把初值 z0 原样交回（t = F+1 → pred = −1），
      //   NaN 步同理。以前这一条落进 pred < tolDb 被判成「已收敛」，求解器一步没走就把 Uniform 初值当终解写出。
      //   处理：缩信赖域再试（界行的 d = y/s 随之变大、法矩阵对角更强），连着四次都不行才认输。
      if (!(pred >= 0)) {
        if (lp.ok) stats.lpFail++
        lpBad++
        hist.push({ it: stats.iters + it, F, pred, act: 0, rho: 0, delta: Delta, acc: false, lpIters: lp.iters, lpOk: false })
        Delta = Math.max(Delta * 0.25, 1e-12)
        if (Delta < 1e-9 || lpBad >= 4) { stop = 'lpfail'; break }
        continue
      }
      let hInf = 0
      for (let j = 0; j < n2; j++) { const a = Math.abs(lp.z[j]); if (a > hInf) hInf = a }
      if (pred < tolDb) { converged = true; break }
      for (let j = 0; j < n2; j++) xn[j] = x[j] + lp.z[j]
      const Fn = evalAt(xn, rTry, false)
      const act = F - Fn, rho = act / pred
      let acc = false
      // 归一只防尺度漂移（f 尺度不变 → 不改任何残差）；Δ 也在该尺度下解释
      if (act > 0) { x.set(xn); normalize(x); F = evalAt(x, resid, true); acc = true; stats.accepted++ }
      else evalAt(x, resid, true)                                // 试探步污染了梯度缓存 → 复位到 x
      if (rho < 0.25) Delta = Math.max(Delta * 0.25, 1e-12)
      else if (rho > 0.75 && hInf >= 0.9 * Delta) Delta *= 2
      hist.push({ it: stats.iters + it, F, pred, act, rho, delta: Delta, acc, lpIters: lp.iters, lpOk: lp.ok })
      if (Delta < 1e-9) { stop = 'delta'; break }
    }
    stats.iters += it
    stats.runs++
    stats.elapsedMs += now() - t0
    stats.stoppedBy = converged ? 'converged' : (stop || 'maxIter')
    return snapshot(converged)
  }

  return {
    x,
    stats,
    hist,
    goals: Tg,
    run: (mi) => runOnce(Number.isFinite(mi) ? mi : maxIterDef),
    setGoals: (T) => { const k = Math.min(M, T.length); for (let m = 0; m < k; m++) Tg[m] = T[m]; nextFrac = dFracWarm }
  }
}
