// 参数研究 · 小型稠密线性代数：Cholesky、下三角求逆、矩阵乘、对称阵特征分解（循环 Jacobi）。
//
// 只服务本目录：Iman–Conover 要 Cholesky，CMA-ES 要对称阵特征分解。维数是「参数个数」量级（几到几十），
// 不需要分块或 LAPACK 级的优化，要的是确定性与可读性。矩阵一律 Array<Float64Array>（按行存）。

/** n×m 零阵 */
export function zeros(n, m = n) {
  return Array.from({ length: n }, () => new Float64Array(m))
}

/** n 阶单位阵 */
export function identity(n) {
  const I = zeros(n)
  for (let i = 0; i < n; i++) I[i][i] = 1
  return I
}

/**
 * Cholesky 分解 A = L·Lᵀ（A 对称正定，只读下三角）。
 * @returns {Float64Array[]|null} 下三角 L；A 非正定（某个主元 ≤ 0 或非有限）时返回 null
 */
export function cholesky(A) {
  const n = A.length
  const L = zeros(n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let m = 0; m < j; m++) s -= L[i][m] * L[j][m]
      if (i === j) {
        if (!(s > 0) || !Number.isFinite(s)) return null
        L[i][i] = Math.sqrt(s)
      } else {
        L[i][j] = s / L[j][j]
      }
    }
  }
  return L
}

/** 下三角阵求逆（前代）。L 的对角须非零。 */
export function invLower(L) {
  const n = L.length
  const X = zeros(n)
  for (let j = 0; j < n; j++) {
    X[j][j] = 1 / L[j][j]
    for (let i = j + 1; i < n; i++) {
      let s = 0
      for (let m = j; m < i; m++) s -= L[i][m] * X[m][j]
      X[i][j] = s / L[i][i]
    }
  }
  return X
}

/** 矩阵乘 A(n×p)·B(p×m) */
export function matMul(A, B) {
  const n = A.length, p = B.length, m = p ? B[0].length : 0
  const C = zeros(n, m)
  for (let i = 0; i < n; i++) {
    const ai = A[i], ci = C[i]
    for (let k = 0; k < p; k++) {
      const a = ai[k]
      if (a === 0) continue
      const bk = B[k]
      for (let j = 0; j < m; j++) ci[j] += a * bk[j]
    }
  }
  return C
}

/**
 * 实对称阵特征分解：循环 Jacobi（Golub & Van Loan, Matrix Computations, §8.5 Algorithm 8.5.3）。
 *
 * 每次平面旋转把一个非对角元消成 0，非对角 Frobenius 范数单调下降，二次收敛；n ≤ 100 时几次扫描即可。
 * 选 Jacobi 而不是 QR：实现短、对称性天然保持、特征向量正交性好——CMA-ES 要反复拿 B·D 去变换样本，
 * 正交性差了协方差会被悄悄扭歪。
 *
 * @param {ArrayLike<number>[]} A  对称阵（只读，不改）
 * @returns {{values: Float64Array, vectors: Float64Array[]}} values 升序；vectors[i][j] = 第 j 个特征向量的第 i 个分量（按列）
 */
export function symEigen(A, { maxSweeps = 64 } = {}) {
  const n = A.length
  // 先按 max|a_ij| 归一：收敛判据里的平方和在 |a| ≳ 1e154 时会上溢、≲ 1e-162 时会下溢，
  // 判据失灵会一次旋转都不做就返回原对角（单测 studyOptimize ⓪ 守着）。特征值最后乘回去。
  let scale = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) scale = Math.max(scale, Math.abs(A[i][j]))
  if (!(scale > 0) || !Number.isFinite(scale)) scale = 1
  const a = Array.from(A, (r) => Float64Array.from(r, (x) => x / scale))
  const v = identity(n)
  let fro2 = 0
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) fro2 += a[i][j] * a[i][j]
  const tol2 = fro2 * 1e-32                       // off(A)² ≤ (1e-16·‖A‖F)² 即停
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off2 = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off2 += 2 * a[p][q] * a[p][q]
    if (!(off2 > tol2)) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q]
        if (apq === 0) continue
        // 2×2 对称 Schur 分解（GvL Algorithm 8.5.1）：取 t = tanθ 的小根，|θ| ≤ π/4，数值最稳
        const tau = (a[q][q] - a[p][p]) / (2 * apq)
        const t = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
        const c = 1 / Math.sqrt(1 + t * t), s = t * c
        for (let k = 0; k < n; k++) {             // A ← A·J（列 p、q）
          const akp = a[k][p], akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {             // A ← Jᵀ·A（行 p、q）
          const apk = a[p][k], aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        a[p][q] = 0; a[q][p] = 0
        for (let k = 0; k < n; k++) {             // V ← V·J
          const vkp = v[k][p], vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq
          v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j] || i - j)
  const values = Float64Array.from(order, (i) => a[i][i] * scale)
  const vectors = zeros(n)
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) vectors[r][c] = v[r][order[c]]
  return { values, vectors }
}
