// 几何工程量：按位置焊接 / 闭合性 / 多面体质量特性（Mirtich 1996 口径）/ 表面质心 / 组件累加。
//
// 纯数值 ESM，无 three 依赖：输入一律是 Float32Array（或任意按下标取数的数组）位置 + Uint32Array 索引，
// 渲染端 Worker、主进程、离线脚本与单测共用同一份实现（设计契约 T1）。
//
// 口径（任务书 §4.3，定死）：
//   · 质心 / 质量 / 惯量在本功能定义，不从任何模型文件读。这里只提供「estimate」档与「components」档的算法；
//     「manual」档是用户手填，不经过这里。
//   · estimate：焊接后每条无向边恰被两个三角形共享且方向相反（绕向一致）→ 闭合 → 逐壳定向（orientShells）后
//     有向四面体积分一次出体积、质心、惯量（均匀密度 = massKg / volume），confidence 'high'；
//     不闭合（NASA 模型基本都不闭合）→ 面积加权表面质心，惯量不算（null），confidence 'low'。
//   · 惯量张量一律「对质心、沿输入坐标轴」，张量形式 I_ij = ∫(|r|²δ_ij − r_i r_j) dm，
//     即对角是转动惯量、非对角是「负的惯性积」。这是 STK / 大多数总体质量特性表的写法。
//
// 精度：累加全程 double；积分前把坐标平移到包围盒中心，避免远离原点的模型在 x²、x³ 项上抵消丢位。

// ───────────────────────── 小工具 ─────────────────────────

/** 顶点数组的包围盒（只看位置数组本身，不看索引；焊接与参考点都够用） */
function boundsOf(position) {
  const n = (position.length / 3) | 0
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    const x = position[j], y = position[j + 1], z = position[j + 2]
    if (x < x0) x0 = x; if (x > x1) x1 = x
    if (y < y0) y0 = y; if (y > y1) y1 = y
    if (z < z0) z0 = z; if (z > z1) z1 = z
  }
  if (!(n > 0)) return null
  return { min: [x0, y0, z0], max: [x1, y1, z1], diag: Math.hypot(x1 - x0, y1 - y0, z1 - z0) }
}

function sequentialIndex(n) {
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  return idx
}

function nextPow2(n) {
  let p = 1
  while (p < n) p *= 2
  return p
}

// ───────────────────────── 焊接 ─────────────────────────

/**
 * 按位置焊接：距离 ≤ tol 的顶点并成一个。
 *
 * 为什么不直接「坐标取整当键」：取整法在格子边界两侧、相距远小于 tol 的两点会被分进不同的格而焊不上，
 * 恰好是 NASA 导出件里最常见的那种 1e-7 级抖动。这里用边长 2·tol 的哈希网格：半径 tol 的球每轴最多跨两格，
 * 查 8 个格就能保证「≤ tol 必焊上」；先查本格、找到即停，绝大多数重复点一次命中。整体 O(n)。
 *
 * 代表点取「首次出现」的那个顶点（按顶点下标顺序），结果确定、与索引顺序无关。
 * 不做传递闭包（A~B、B~C 但 A、C 超出 tol 时 C 另立代表点），这是焊接的通行口径。
 *
 * 索引长度不变：焊接会让个别三角形退化（两个角并成一点），这些三角形保留原位、由下游跳过——
 * 这样「第 t 个三角形」在焊接前后指同一个面，部件的 triRanges 才对得上原网格。
 *
 * @param {ArrayLike<number>} position  3n
 * @param {ArrayLike<number>|null} index 3m；null = 三角形汤（顶点按顺序每三个一面）
 * @param {number} [tol] 缺省 1e-6 × 包围盒对角线
 * @returns {{position: Float32Array|Float64Array, index: Uint32Array, remap: Uint32Array, tol: number, vertexCount: number}}
 */
export function weldByPosition(position, index, tol) {
  const n = (position.length / 3) | 0
  const idx = index || sequentialIndex(n)
  const Out = position instanceof Float64Array ? Float64Array : Float32Array
  if (n === 0) return { position: new Out(0), index: new Uint32Array(idx.length), remap: new Uint32Array(0), tol: 0, vertexCount: 0 }
  const b = boundsOf(position)
  const diag = b.diag > 0 ? b.diag : 1
  if (!(tol > 0)) tol = 1e-6 * diag
  // 格坐标要装进 Int32：tol 过小会让「跨度 / 格长」溢出，下限钉在对角线的 2^-29
  tol = Math.max(tol, diag * 1.9e-9)
  const cell = 2 * tol, inv = 1 / cell, tol2 = tol * tol
  const [mx, my, mz] = b.min

  const cap = nextPow2(Math.max(16, n * 2))
  const mask = cap - 1
  const kx = new Int32Array(cap), ky = new Int32Array(cap), kz = new Int32Array(cap)
  const head = new Int32Array(cap).fill(-1)        // 槽 → 该格代表点链表头（代表点新编号）
  const nextRep = new Int32Array(n)                // 代表点链表
  const outPos = new Out(n * 3)
  const remap = new Uint32Array(n)
  let m = 0

  // 在哈希表里找格 (ix,iy,iz) 的槽；不存在返回 -1（create=false）或新建
  const slotOf = (ix, iy, iz, create) => {
    let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & mask
    for (;;) {
      if (head[h] === -1) {
        if (!create) return -1
        kx[h] = ix; ky[h] = iy; kz[h] = iz
        return h
      }
      if (kx[h] === ix && ky[h] === iy && kz[h] === iz) return h
      h = (h + 1) & mask
    }
  }
  const findIn = (s, x, y, z) => {
    for (let r = head[s]; r !== -1; r = nextRep[r]) {
      const dx = outPos[r * 3] - x, dy = outPos[r * 3 + 1] - y, dz = outPos[r * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz <= tol2) return r
    }
    return -1
  }

  for (let i = 0; i < n; i++) {
    const x = position[i * 3], y = position[i * 3 + 1], z = position[i * 3 + 2]
    const fx = (x - mx) * inv, fy = (y - my) * inv, fz = (z - mz) * inv
    const ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz)
    // 球 [f−½, f+½]（格单位）只会伸进离得近的那一侧邻格
    const jx = fx - ix < 0.5 ? ix - 1 : ix + 1
    const jy = fy - iy < 0.5 ? iy - 1 : iy + 1
    const jz = fz - iz < 0.5 ? iz - 1 : iz + 1
    let hit = -1
    const own = slotOf(ix, iy, iz, false)
    if (own !== -1) hit = findIn(own, x, y, z)
    if (hit === -1) {
      for (let c = 1; c < 8 && hit === -1; c++) {
        const s = slotOf(c & 1 ? jx : ix, c & 2 ? jy : iy, c & 4 ? jz : iz, false)
        if (s !== -1) hit = findIn(s, x, y, z)
      }
    }
    if (hit !== -1) { remap[i] = hit; continue }
    const s = own !== -1 ? own : slotOf(ix, iy, iz, true)
    outPos[m * 3] = x; outPos[m * 3 + 1] = y; outPos[m * 3 + 2] = z
    nextRep[m] = head[s]; head[s] = m
    remap[i] = m++
  }

  const outIdx = new Uint32Array(idx.length)
  for (let k = 0; k < idx.length; k++) outIdx[k] = remap[idx[k]]
  return { position: outPos.slice(0, m * 3), index: outIdx, remap, tol, vertexCount: m }
}

// ───────────────────────── 半边表（CSR）─────────────────────────

/**
 * 每个顶点的出半边表：三角形 (a,b,c) 贡献 a→b、b→c、c→a。退化三角形（任两角同点）跳过。
 * 用 CSR 而不是边哈希：内存只要 3T 个 Uint32 + 两个 V+1 数组，百万面也就十几 MB，且顶点度数小、邻接查找很快。
 * tri[] 记每条半边来自哪个三角形（部件分割的光滑片要用）。
 */
export function buildHalfEdges(index, vertexCount) {
  const T = (index.length / 3) | 0
  let V = vertexCount
  if (!(V >= 0)) { V = 0; for (let k = 0; k < index.length; k++) if (index[k] + 1 > V) V = index[k] + 1 }
  const off = new Uint32Array(V + 1)
  let degenerate = 0
  for (let t = 0; t < T; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2]
    if (a === b || b === c || c === a) { degenerate++; continue }
    off[a + 1]++; off[b + 1]++; off[c + 1]++
  }
  for (let v = 0; v < V; v++) off[v + 1] += off[v]
  const E = off[V]
  const tgt = new Uint32Array(E), tri = new Uint32Array(E)
  const fill = off.slice(0, V)
  for (let t = 0; t < T; t++) {
    const a = index[t * 3], b = index[t * 3 + 1], c = index[t * 3 + 2]
    if (a === b || b === c || c === a) continue
    let p = fill[a]++; tgt[p] = b; tri[p] = t
    p = fill[b]++; tgt[p] = c; tri[p] = t
    p = fill[c]++; tgt[p] = a; tri[p] = t
  }
  return { V, T, off, tgt, tri, degenerate }
}

/** 反向 CSR（每个顶点的入半边）+ 半边起点表，forEachEdge 首次用到时建、挂在 he 上复用 */
function ensureReverse(he) {
  if (he.inOff) return
  const { V, off, tgt } = he
  const E = off[V]
  const src = new Uint32Array(E)
  const inOff = new Uint32Array(V + 1)
  for (let a = 0; a < V; a++) for (let j = off[a], e = off[a + 1]; j < e; j++) { src[j] = a; inOff[tgt[j] + 1]++ }
  let maxDeg = 0
  for (let v = 0; v < V; v++) {
    const d = off[v + 1] - off[v] + inOff[v + 1]
    if (d > maxDeg) maxDeg = d
    inOff[v + 1] += inOff[v]
  }
  const inHe = new Uint32Array(E)
  const fill = inOff.slice(0, V)
  for (let j = 0; j < E; j++) inHe[fill[tgt[j]]++] = j
  he.src = src; he.inOff = inOff; he.inHe = inHe; he.maxDeg = maxDeg
}

/**
 * 逐条无向边归类，回调 (lo, hi, f, r, buf, s0)：f = lo→hi 半边数，r = hi→lo 半边数；
 * 这条边上的全部半边下标在 buf[s0 .. s0+f+r)（先 f 条 lo→hi、后 r 条 hi→lo，tri[] 取所在三角形）。
 * buf 是共享暂存区，只在回调期间有效。每条无向边只回调一次（在 lo 端）。
 *
 * 为什么不在出边表里线性查重、逐边数反向半边：那样每个顶点是 O(度²)，STL 平面扇形三角化、
 * 大 tol 把许多点焊成一点时，单个顶点度数上万，闭合判定会退化到分钟级。这里每个顶点把
 * 「出半边 + 入半边」按邻点打戳分桶，O(度) 处理完，全网格 O(E)。
 */
export function forEachEdge(he, cb) {
  ensureReverse(he)
  const { V, off, tgt, src, inOff, inHe, maxDeg } = he
  if (maxDeg === 0) return
  const owner = new Int32Array(V).fill(-1)          // 邻点 → 当前正在处理的 lo（打戳，免得每个顶点清表）
  const slot = new Int32Array(V)                    // 邻点 → 本顶点局部桶号
  const nbr = new Uint32Array(maxDeg), fc = new Uint32Array(maxDeg), rc = new Uint32Array(maxDeg)
  const start = new Uint32Array(maxDeg + 1), fillp = new Uint32Array(maxDeg)
  const buf = new Uint32Array(maxDeg)
  for (let a = 0; a < V; a++) {
    let k = 0
    // 只收 hi > a 的边：hi < a 的那一侧在更小的顶点那里已经处理过（它的入半边就是这里的出半边）
    for (let j = off[a], e = off[a + 1]; j < e; j++) {
      const b = tgt[j]
      if (b < a) continue
      if (owner[b] !== a) { owner[b] = a; slot[b] = k; nbr[k] = b; fc[k] = 0; rc[k] = 0; k++ }
      fc[slot[b]]++
    }
    for (let q = inOff[a], e = inOff[a + 1]; q < e; q++) {
      const s = src[inHe[q]]
      if (s < a) continue
      if (owner[s] !== a) { owner[s] = a; slot[s] = k; nbr[k] = s; fc[k] = 0; rc[k] = 0; k++ }
      rc[slot[s]]++
    }
    if (k === 0) continue
    start[0] = 0
    for (let i = 0; i < k; i++) { start[i + 1] = start[i] + fc[i] + rc[i]; fillp[i] = start[i] }
    for (let j = off[a], e = off[a + 1]; j < e; j++) { const b = tgt[j]; if (b > a) buf[fillp[slot[b]]++] = j }
    for (let q = inOff[a], e = inOff[a + 1]; q < e; q++) { const j = inHe[q], s = src[j]; if (s > a) buf[fillp[slot[s]]++] = j }
    for (let i = 0; i < k; i++) cb(a, nbr[i], fc[i], rc[i], buf, start[i])
  }
}

// ───────────────────────── 连通分量 ─────────────────────────

/**
 * 焊接后索引上的连通分量（共顶点即连通）。编号按三角形出现顺序，结果确定。
 * 质量特性的逐壳定向与部件分割（segment.mjs 转出）共用这一份。
 * @param {ArrayLike<number>} weldedIndex
 * @param {number} [vertexCount]
 * @returns {{count:number, triComp:Int32Array, triCount:Uint32Array}}
 */
export function connectedComponents(weldedIndex, vertexCount) {
  const T = (weldedIndex.length / 3) | 0
  let V = vertexCount
  if (!(V >= 0)) { V = 0; for (let k = 0; k < weldedIndex.length; k++) if (weldedIndex[k] + 1 > V) V = weldedIndex[k] + 1 }
  const par = new Int32Array(V)
  for (let i = 0; i < V; i++) par[i] = i
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x] } return x }
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) par[b] = a; else par[a] = b } }
  for (let t = 0; t < T; t++) {
    const a = weldedIndex[t * 3], b = weldedIndex[t * 3 + 1], c = weldedIndex[t * 3 + 2]
    unite(a, b); unite(b, c)
  }
  const label = new Int32Array(V).fill(-1)
  const triComp = new Int32Array(T)
  let count = 0
  for (let t = 0; t < T; t++) {
    const r = find(weldedIndex[t * 3])
    if (label[r] === -1) label[r] = count++
    triComp[t] = label[r]
  }
  const triCount = new Uint32Array(count)
  for (let t = 0; t < T; t++) triCount[triComp[t]]++
  return { count, triComp, triCount }
}

// ───────────────────────── 闭合性 ─────────────────────────

/**
 * 闭合性（任务书 §4.3 判据）：焊接后每条无向边恰被两个三角形共享，且两者在这条边上方向相反（绕向一致）。
 * 退化三角形不参与（焊接产生的零面积面不影响体积，也不该让网格判为不闭合）。
 *
 * @param {ArrayLike<number>} weldedIndex 焊接后的索引
 * @param {number} [vertexCount]
 * @returns {{closed:boolean, boundaryEdges:number, nonManifoldEdges:number, inconsistent:number, edges:number, degenerate:number}}
 */
export function isClosed(weldedIndex, vertexCount) {
  const he = buildHalfEdges(weldedIndex, vertexCount)
  let boundary = 0, nonManifold = 0, inconsistent = 0, edges = 0
  forEachEdge(he, (_lo, _hi, f, r) => {
    edges++
    const tot = f + r
    if (tot === 1) boundary++
    else if (tot > 2) nonManifold++
    else if (!(f === 1 && r === 1)) inconsistent++       // 两面同向经过这条边 = 绕向不一致
  })
  const faces = he.T - he.degenerate
  return {
    closed: faces > 0 && boundary === 0 && nonManifold === 0 && inconsistent === 0,
    boundaryEdges: boundary, nonManifoldEdges: nonManifold, inconsistent, edges, degenerate: he.degenerate,
  }
}

// ───────────────────────── 多面体质量特性 ─────────────────────────

/**
 * 闭合多面体（三角网格）的体积、质心、惯量——Mirtich 1996 的散度定理思路，
 * 按 Eberly《Polyhedral Mass Properties (Revisited)》的三角形闭式一次累出 1、x、y、z、x²、y²、z²、xy、yz、zx 十个体积分。
 * 与「每个面和参考点组成有向四面体再求和」数学上等价，但每面只算一次叉积、没有除法。
 *
 * 内翻（整体绕向朝内）的网格有向体积为负：十个积分同时变号，质心比值不变，只需把积分整体取反——
 * 这里据此翻正并在结果里标 inverted=true。这里只按「总体积 < 0」整体判：
 * 多壳网格里个别壳内翻（镜像实例烘进顶点却没翻绕向）要先过 orientShells 逐壳定向，estimateMassProps 就是这么做的。
 *
 * @param {ArrayLike<number>} position
 * @param {ArrayLike<number>} index
 * @param {number} [density=1]
 * @returns {{volume:number, signedVolume:number, inverted:boolean, massKg:number, centroid:number[]|null, inertia:number[][]|null}}
 */
export function polyhedronMassProps(position, index, density = 1) {
  const T = (index.length / 3) | 0
  const b = boundsOf(position)
  if (!b || T === 0) return { volume: 0, signedVolume: 0, inverted: false, massKg: 0, centroid: null, inertia: null }
  const ox = (b.min[0] + b.max[0]) / 2, oy = (b.min[1] + b.max[1]) / 2, oz = (b.min[2] + b.max[2]) / 2
  let i0 = 0, ix = 0, iy = 0, iz = 0, ixx = 0, iyy = 0, izz = 0, ixy = 0, iyz = 0, izx = 0
  for (let t = 0; t < T; t++) {
    const a = index[t * 3] * 3, bb = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const x0 = position[a] - ox, y0 = position[a + 1] - oy, z0 = position[a + 2] - oz
    const x1 = position[bb] - ox, y1 = position[bb + 1] - oy, z1 = position[bb + 2] - oz
    const x2 = position[c] - ox, y2 = position[c + 1] - oy, z2 = position[c + 2] - oz
    const a1 = x1 - x0, b1 = y1 - y0, c1 = z1 - z0
    const a2 = x2 - x0, b2 = y2 - y0, c2 = z2 - z0
    const d0 = b1 * c2 - b2 * c1, d1 = a2 * c1 - a1 * c2, d2 = a1 * b2 - a2 * b1
    // x 分量的子表达式
    let t0 = x0 + x1, f1x = t0 + x2, t1 = x0 * x0, t2 = t1 + x1 * t0
    const f2x = t2 + x2 * f1x, f3x = x0 * t1 + x1 * t2 + x2 * f2x
    const g0x = f2x + x0 * (f1x + x0), g1x = f2x + x1 * (f1x + x1), g2x = f2x + x2 * (f1x + x2)
    t0 = y0 + y1; const f1y = t0 + y2; t1 = y0 * y0; t2 = t1 + y1 * t0
    const f2y = t2 + y2 * f1y, f3y = y0 * t1 + y1 * t2 + y2 * f2y
    const g0y = f2y + y0 * (f1y + y0), g1y = f2y + y1 * (f1y + y1), g2y = f2y + y2 * (f1y + y2)
    t0 = z0 + z1; const f1z = t0 + z2; t1 = z0 * z0; t2 = t1 + z1 * t0
    const f2z = t2 + z2 * f1z, f3z = z0 * t1 + z1 * t2 + z2 * f2z
    const g0z = f2z + z0 * (f1z + z0), g1z = f2z + z1 * (f1z + z1), g2z = f2z + z2 * (f1z + z2)
    i0 += d0 * f1x
    ix += d0 * f2x; iy += d1 * f2y; iz += d2 * f2z
    ixx += d0 * f3x; iyy += d1 * f3y; izz += d2 * f3z
    ixy += d0 * (y0 * g0x + y1 * g1x + y2 * g2x)
    iyz += d1 * (z0 * g0y + z1 * g1y + z2 * g2y)
    izx += d2 * (x0 * g0z + x1 * g1z + x2 * g2z)
  }
  i0 /= 6; ix /= 24; iy /= 24; iz /= 24; ixx /= 60; iyy /= 60; izz /= 60; ixy /= 120; iyz /= 120; izx /= 120
  const signedVolume = i0
  // 零体积判据：相对包围盒对角线³ 的 1e-12（片状、线状网格）
  if (!(Math.abs(i0) > 1e-12 * b.diag ** 3)) {
    return { volume: 0, signedVolume, inverted: false, massKg: 0, centroid: null, inertia: null }
  }
  const inverted = i0 < 0
  if (inverted) { i0 = -i0; ix = -ix; iy = -iy; iz = -iz; ixx = -ixx; iyy = -iyy; izz = -izz; ixy = -ixy; iyz = -iyz; izx = -izx }
  const cx = ix / i0, cy = iy / i0, cz = iz / i0
  // 平行轴移到质心（先按单位密度，最后乘 density）
  const Ixx = iyy + izz - i0 * (cy * cy + cz * cz)
  const Iyy = izz + ixx - i0 * (cz * cz + cx * cx)
  const Izz = ixx + iyy - i0 * (cx * cx + cy * cy)
  const Pxy = -(ixy - i0 * cx * cy)
  const Pyz = -(iyz - i0 * cy * cz)
  const Pzx = -(izx - i0 * cz * cx)
  const d = density
  return {
    volume: i0, signedVolume, inverted, massKg: d * i0,
    centroid: [cx + ox, cy + oy, cz + oz],
    inertia: [[d * Ixx, d * Pxy, d * Pzx], [d * Pxy, d * Iyy, d * Pyz], [d * Pzx, d * Pyz, d * Izz]],
  }
}

// ───────────────────────── 逐壳定向 ─────────────────────────

// 奇偶射线用的三个方向：不沿坐标轴、两两不平行。建模件大多轴对齐，轴向射线会正好擦过棱与顶点让奇偶失真
const RAY_DIRS = [[0.5773, 0.6231, 0.5277], [-0.7071, 0.3013, 0.6397], [0.2310, -0.8412, 0.4889]].map((d) => {
  const l = Math.hypot(d[0], d[1], d[2])
  return [d[0] / l, d[1] / l, d[2] / l]
})

/** 与单位向量 d 正交的一对单位向量 */
function perpPair(d) {
  const ref = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  const k = ref[0] * d[0] + ref[1] * d[1] + ref[2] * d[2]
  let e1 = [ref[0] - k * d[0], ref[1] - k * d[1], ref[2] - k * d[2]]
  const l = Math.hypot(e1[0], e1[1], e1[2])
  e1 = [e1[0] / l, e1[1] / l, e1[2] / l]
  return [e1, [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]]]
}

/**
 * 多壳闭合网格逐壳定向：让每个壳的有向体积符号 = (−1)^嵌套深度——最外层实体为正、实体里的空腔为负、
 * 空腔里再放的实体又为正。
 *
 * 为什么需要：CAD 装配里镜像实例常把变换烘进顶点却不翻绕向（左右对称的翼、支架），这类壳自身绕向一致、
 * isClosed 照样判闭合，但有向体积是负的。只按总体积整体翻，会把它当成「空腔」从体积里减掉、把质心推到物体外面。
 * 反过来也不能把负壳一律翻正：真正的空腔内壳本该是负的，翻正会把空腔填实。所以要看它被谁包着。
 *
 * 嵌套深度 = 包含本壳的其他壳的个数。「包含」：本壳包围盒落在对方包围盒内，且本壳取的 3 个顶点
 * 都在对方内部（每点沿三个斜向打射线、对方三角形的交点数奇偶多数表决）。三点全在才算，
 * 部分相交的两个实体（常见于美术模型的零件互相插入）不会因为一个角伸进去就被当成空腔。
 * 这就是填充里的 even-odd 规则：实体由壳的几何决定，结果与输入绕向完全无关。代价是整个埋进另一实体里的同向零件
 * 也按空腔减掉（NASA 语料 14 个闭合件里有 4 个这样，体积变化 0.03 %–3.6 %）——均匀密度下真值是并集（只算外面那个），
 * 减掉与「重复计入」偏差同量级、方向相反；而只有按深度定号，才纠正得了「只有内壳翻了」「只有外壳翻了」
 * 「镜像的空心件内外壳一起翻了」这几种绕向错误。
 *
 * 加速：每个被问到的容器壳、每个射线方向建一张「沿射线方向投影」的二维格网（CSR），一根射线只测所在格里的三角形。
 * 容器候选只取包围盒体积前 512 大的壳（空腔的容器必然比空腔大），壳再多也是 O(壳数 × 512) 次包围盒比较。
 *
 * @param {ArrayLike<number>} position
 * @param {ArrayLike<number>} index  焊接后索引（壳 = 共顶点连通分量）
 * @param {number} [vertexCount]
 * @returns {{index: ArrayLike<number>, shells:number, invertedShells:number, cavities:number}}
 *   index：有壳被翻时是新数组，否则原样返回；invertedShells = 被翻过来的壳数；
 *   cavities = 奇数深度的壳数（空腔，或整个埋在别的实体里的零件——even-odd 口径下两者同算）
 */
export function orientShells(position, index, vertexCount) {
  const T = (index.length / 3) | 0
  const cc = connectedComponents(index, vertexCount)
  const S = cc.count
  const out = { index, shells: S, invertedShells: 0, cavities: 0 }
  if (S <= 1) return out                            // 单壳：整体内翻由 polyhedronMassProps 按总体积翻正
  const b = boundsOf(position)
  const diag = b.diag > 0 ? b.diag : 1
  const ox = (b.min[0] + b.max[0]) / 2, oy = (b.min[1] + b.max[1]) / 2, oz = (b.min[2] + b.max[2]) / 2
  const vol = new Float64Array(S)
  const bb = new Float64Array(S * 6)
  for (let s = 0; s < S; s++) { bb[s * 6] = bb[s * 6 + 1] = bb[s * 6 + 2] = Infinity; bb[s * 6 + 3] = bb[s * 6 + 4] = bb[s * 6 + 5] = -Infinity }
  for (let t = 0; t < T; t++) {
    const s = cc.triComp[t]
    const a = index[t * 3] * 3, bq = index[t * 3 + 1] * 3, c = index[t * 3 + 2] * 3
    const x0 = position[a] - ox, y0 = position[a + 1] - oy, z0 = position[a + 2] - oz
    const x1 = position[bq] - ox, y1 = position[bq + 1] - oy, z1 = position[bq + 2] - oz
    const x2 = position[c] - ox, y2 = position[c + 1] - oy, z2 = position[c + 2] - oz
    vol[s] += (x0 * (y1 * z2 - z1 * y2) - y0 * (x1 * z2 - z1 * x2) + z0 * (x1 * y2 - y1 * x2)) / 6
    const o = s * 6
    for (const [x, y, z] of [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]]) {
      if (x < bb[o]) bb[o] = x; if (x > bb[o + 3]) bb[o + 3] = x
      if (y < bb[o + 1]) bb[o + 1] = y; if (y > bb[o + 4]) bb[o + 4] = y
      if (z < bb[o + 2]) bb[o + 2] = z; if (z > bb[o + 5]) bb[o + 5] = z
    }
  }
  const tiny = 1e-12 * diag ** 3
  // 壳 → 三角形表（CSR）
  const off = new Uint32Array(S + 1)
  for (let t = 0; t < T; t++) off[cc.triComp[t] + 1]++
  for (let s = 0; s < S; s++) off[s + 1] += off[s]
  const list = new Uint32Array(T)
  { const fill = off.slice(0, S); for (let t = 0; t < T; t++) list[fill[cc.triComp[t]]++] = t }
  const P = (v) => [position[v * 3] - ox, position[v * 3 + 1] - oy, position[v * 3 + 2] - oz]

  const grids = new Map()                           // `${壳}:${方向}` → 投影格网
  const gridOf = (c, di) => {
    const key = c * 3 + di
    let g = grids.get(key)
    if (g) return g
    const d = RAY_DIRS[di], [e1, e2] = perpPair(d)
    const n = off[c + 1] - off[c]
    const U = new Float64Array(n * 3), W = new Float64Array(n * 3)
    let u0 = Infinity, u1 = -Infinity, w0 = Infinity, w1 = -Infinity
    for (let i = 0; i < n; i++) {
      const t = list[off[c] + i]
      for (let k = 0; k < 3; k++) {
        const p = P(index[t * 3 + k])
        const u = p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], w = p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]
        U[i * 3 + k] = u; W[i * 3 + k] = w
        if (u < u0) u0 = u; if (u > u1) u1 = u; if (w < w0) w0 = w; if (w > w1) w1 = w
      }
    }
    const G = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(n / 4))))
    const su = (u1 - u0) / G || 1, sw = (w1 - w0) / G || 1
    const cellRange = (i) => {
      const a = Math.min(U[i * 3], U[i * 3 + 1], U[i * 3 + 2]), bmax = Math.max(U[i * 3], U[i * 3 + 1], U[i * 3 + 2])
      const cmin = Math.min(W[i * 3], W[i * 3 + 1], W[i * 3 + 2]), cmax = Math.max(W[i * 3], W[i * 3 + 1], W[i * 3 + 2])
      return [Math.max(0, Math.floor((a - u0) / su)), Math.min(G - 1, Math.floor((bmax - u0) / su)), Math.max(0, Math.floor((cmin - w0) / sw)), Math.min(G - 1, Math.floor((cmax - w0) / sw))]
    }
    const cnt = new Uint32Array(G * G + 1)
    for (let i = 0; i < n; i++) { const [i0, i1, j0, j1] = cellRange(i); for (let j = j0; j <= j1; j++) for (let q = i0; q <= i1; q++) cnt[j * G + q + 1]++ }
    for (let q = 0; q < G * G; q++) cnt[q + 1] += cnt[q]
    const items = new Uint32Array(cnt[G * G])
    const fill = cnt.slice(0, G * G)
    for (let i = 0; i < n; i++) { const [i0, i1, j0, j1] = cellRange(i); for (let j = j0; j <= j1; j++) for (let q = i0; q <= i1; q++) items[fill[j * G + q]++] = list[off[c] + i] }
    g = { d, e1, e2, u0, w0, su, sw, G, cnt, items }
    grids.set(key, g)
    return g
  }
  // 点 p（已平移）沿方向 di 的射线与壳 c 的交点个数奇偶（Möller–Trumbore，双面）
  const oddHits = (c, di, p) => {
    const g = gridOf(c, di)
    const u = p[0] * g.e1[0] + p[1] * g.e1[1] + p[2] * g.e1[2], w = p[0] * g.e2[0] + p[1] * g.e2[1] + p[2] * g.e2[2]
    const iu = Math.floor((u - g.u0) / g.su), iw = Math.floor((w - g.w0) / g.sw)
    if (iu < 0 || iw < 0 || iu >= g.G || iw >= g.G) return false
    const d = g.d, eps = 1e-12 * diag
    let hits = 0
    for (let q = g.cnt[iw * g.G + iu], e = g.cnt[iw * g.G + iu + 1]; q < e; q++) {
      const t = g.items[q]
      const A = P(index[t * 3]), B = P(index[t * 3 + 1]), C = P(index[t * 3 + 2])
      const e1x = B[0] - A[0], e1y = B[1] - A[1], e1z = B[2] - A[2], e2x = C[0] - A[0], e2y = C[1] - A[1], e2z = C[2] - A[2]
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x
      const det = e1x * px + e1y * py + e1z * pz
      if (Math.abs(det) < 1e-300) continue
      const inv = 1 / det
      const tx = p[0] - A[0], ty = p[1] - A[1], tz = p[2] - A[2]
      const uu = (tx * px + ty * py + tz * pz) * inv
      if (uu < 0 || uu > 1) continue
      const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x
      const vv = (d[0] * qx + d[1] * qy + d[2] * qz) * inv
      if (vv < 0 || uu + vv > 1) continue
      if ((e2x * qx + e2y * qy + e2z * qz) * inv > eps) hits++
    }
    return (hits & 1) === 1
  }
  const inside = (c, p) => (oddHits(c, 0, p) ? 1 : 0) + (oddHits(c, 1, p) ? 1 : 0) + (oddHits(c, 2, p) ? 1 : 0) >= 2

  // 容器候选：非零体积壳按包围盒体积降序取前 512
  const bbVol = (s) => Math.max(0, bb[s * 6 + 3] - bb[s * 6]) * Math.max(0, bb[s * 6 + 4] - bb[s * 6 + 1]) * Math.max(0, bb[s * 6 + 5] - bb[s * 6 + 2])
  const containers = []
  for (let s = 0; s < S; s++) if (Math.abs(vol[s]) > tiny) containers.push(s)
  containers.sort((a, c) => bbVol(c) - bbVol(a) || a - c)
  if (containers.length > 512) containers.length = 512
  const bbEps = 1e-9 * diag
  const flip = new Uint8Array(S)
  let any = false
  for (let s = 0; s < S; s++) {
    if (!(Math.abs(vol[s]) > tiny)) continue       // 零体积壳（闭合的双面片等）不定向、也不当容器
    const n = off[s + 1] - off[s]
    const samples = [list[off[s]] * 3, list[off[s] + (n >> 1)] * 3 + 1, list[off[s] + n - 1] * 3 + 2].map((k) => P(index[k]))
    let depth = 0
    for (const c of containers) {
      if (c === s) continue
      const o = c * 6, i = s * 6
      if (bb[i] < bb[o] - bbEps || bb[i + 1] < bb[o + 1] - bbEps || bb[i + 2] < bb[o + 2] - bbEps ||
          bb[i + 3] > bb[o + 3] + bbEps || bb[i + 4] > bb[o + 4] + bbEps || bb[i + 5] > bb[o + 5] + bbEps) continue
      if (samples.every((p) => inside(c, p))) depth++
    }
    const odd = (depth & 1) === 1
    if (odd) out.cavities++
    if ((vol[s] < 0) !== odd) { flip[s] = 1; out.invertedShells++; any = true }
  }
  if (any) {
    const idx = Uint32Array.from(index)
    for (let t = 0; t < T; t++) if (flip[cc.triComp[t]]) { const x = idx[t * 3 + 1]; idx[t * 3 + 1] = idx[t * 3 + 2]; idx[t * 3 + 2] = x }
    out.index = idx
  }
  return out
}

// ───────────────────────── 表面 ─────────────────────────

/**
 * 面积与面积加权表面质心。不闭合网格的质心只能这么取（任务书 §4.3 low 档）：
 * 它是「均匀面密度薄壳」的质心，对外壳为主的 NASA 美术模型是可用的一阶近似。
 * @returns {{area:number, centroid:number[]|null}}
 */
export function surfaceProps(position, index) {
  const idx = index || sequentialIndex((position.length / 3) | 0)
  const T = (idx.length / 3) | 0
  let A = 0, sx = 0, sy = 0, sz = 0
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3
    const ux = position[b] - position[a], uy = position[b + 1] - position[a + 1], uz = position[b + 2] - position[a + 2]
    const vx = position[c] - position[a], vy = position[c + 1] - position[a + 1], vz = position[c + 2] - position[a + 2]
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const ar = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (!(ar > 0)) continue
    A += ar
    sx += ar * (position[a] + position[b] + position[c])
    sy += ar * (position[a + 1] + position[b + 1] + position[c + 1])
    sz += ar * (position[a + 2] + position[b + 2] + position[c + 2])
  }
  return { area: A, centroid: A > 0 ? [sx / (3 * A), sy / (3 * A), sz / (3 * A)] : null }
}

// ───────────────────────── 合并多个网格 ─────────────────────────

/** 列主序 4×4 左上 3×3 的行列式（判镜像：负号要翻三角形绕向，否则体积变号） */
function det3OfMat4(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}

/**
 * 把 [{position, index, matrix?}] 变换到同一坐标系并拼成一份（Float64，避免 float32 二次舍入）。
 * matrix 为列主序 4×4（glTF / three 口径）。镜像矩阵翻转绕向，保证拼完后外法向约定不变。
 * 三角形顺序 = 各网格顺序拼接，triOffsets[k] 是第 k 个网格的首三角形。
 */
export function concatMeshes(meshes) {
  let nv = 0, ni = 0
  for (const m of meshes) {
    const n = (m.position.length / 3) | 0
    nv += n
    ni += m.index ? m.index.length : n
  }
  const pos = new Float64Array(nv * 3), idx = new Uint32Array(ni)
  const triOffsets = []
  let vo = 0, io = 0
  for (const m of meshes) {
    const p = m.position, n = (p.length / 3) | 0, M = m.matrix
    if (M) {
      for (let i = 0; i < n; i++) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2]
        pos[(vo + i) * 3] = M[0] * x + M[4] * y + M[8] * z + M[12]
        pos[(vo + i) * 3 + 1] = M[1] * x + M[5] * y + M[9] * z + M[13]
        pos[(vo + i) * 3 + 2] = M[2] * x + M[6] * y + M[10] * z + M[14]
      }
    } else {
      for (let i = 0; i < n * 3; i++) pos[vo * 3 + i] = p[i]
    }
    const flip = M ? det3OfMat4(M) < 0 : false
    const src = m.index || sequentialIndex(n)
    triOffsets.push(io / 3)
    for (let k = 0; k < src.length; k += 3) {
      idx[io + k] = src[k] + vo
      idx[io + k + 1] = (flip ? src[k + 2] : src[k + 1]) + vo
      idx[io + k + 2] = (flip ? src[k + 1] : src[k + 2]) + vo
    }
    vo += n; io += src.length
  }
  return { position: pos, index: idx, triOffsets }
}

// ───────────────────────── estimate 档 ─────────────────────────

/**
 * 按网格估算质量特性（任务书 §4.3 estimate 档）。
 * 各网格先按 matrix 变到同一坐标系、整体焊接后判闭合——分材质拆成多个 primitive 的闭合壳
 * 拼起来仍是闭合的，所以必须合并后再判，不能逐网格判。
 *
 * @param {{meshes: {position, index?, matrix?}[], massKg?: number, tol?: number}} o
 * 闭合时先 orientShells 逐壳定向（个别壳内翻的镜像件翻正、空腔保持为负），再积分。
 *
 * @returns {null | {source:'estimate', confidence:'high'|'low', closed:boolean, massKg:number|null,
 *   comBody:number[], inertiaBody:number[][]|null, volumeM3:number|null, areaM2:number, inverted:boolean,
 *   shells:number, invertedShells:number, cavities:number, density:number|null, topology:object}}
 *   inverted：有壳被翻正过（整体内翻或个别壳内翻）；massKg 缺省或非正时：闭合件仍给体积与质心，惯量无从标定 → null。
 */
export function estimateMassProps({ meshes, massKg, tol } = {}) {
  if (!Array.isArray(meshes) || meshes.length === 0) return null
  const all = concatMeshes(meshes)
  if (all.index.length < 3) return null
  const w = weldByPosition(all.position, all.index, tol)
  const topo = isClosed(w.index, w.vertexCount)
  const surf = surfaceProps(w.position, w.index)
  const mass = Number.isFinite(massKg) && massKg > 0 ? massKg : null
  if (topo.closed) {
    const sh = orientShells(w.position, w.index, w.vertexCount)
    const mp = polyhedronMassProps(w.position, sh.index, 1)
    if (mp.volume > 0) {
      const density = mass != null ? mass / mp.volume : null
      return {
        source: 'estimate', confidence: 'high', closed: true,
        massKg: mass, comBody: mp.centroid,
        inertiaBody: density != null ? mp.inertia.map((r) => r.map((v) => v * density)) : null,
        volumeM3: mp.volume, areaM2: surf.area,
        inverted: mp.inverted || sh.invertedShells > 0, shells: sh.shells, invertedShells: sh.invertedShells + (mp.inverted ? 1 : 0), cavities: sh.cavities,
        density, topology: topo,
      }
    }
  }
  if (!surf.centroid) return null
  return {
    source: 'estimate', confidence: 'low', closed: false,
    massKg: mass, comBody: surf.centroid, inertiaBody: null,
    volumeM3: null, areaM2: surf.area, inverted: false, shells: null, invertedShells: 0, cavities: 0, density: null, topology: topo,
  }
}

// ───────────────────────── components 档 ─────────────────────────

/**
 * 组件累加（任务书 §4.3 components 档）：总质量、合成质心、平行轴定理累加惯量。
 *   I_total = Σ [ I_i(对自身质心) + m_i ( |d|² E − d dᵀ ) ]，d = 组件质心 − 合成质心。
 * 缺 inertiaCom 的组件按质点处理。质量非正 / 非数的组件跳过（参数化模板里「待填」的组件不该让整体变 NaN）。
 *
 * @param {{massKg:number, comBody:number[], inertiaCom?:number[][]}[]} list
 * @returns {null | {massKg:number, comBody:number[], inertiaBody:number[][], source:'components', count:number}}
 */
export function combineComponents(list) {
  if (!Array.isArray(list)) return null
  const items = list.filter((c) => c && Number.isFinite(c.massKg) && c.massKg > 0 && Array.isArray(c.comBody) && c.comBody.length === 3 && c.comBody.every(Number.isFinite))
  if (items.length === 0) return null
  let M = 0, cx = 0, cy = 0, cz = 0
  for (const c of items) { M += c.massKg; cx += c.massKg * c.comBody[0]; cy += c.massKg * c.comBody[1]; cz += c.massKg * c.comBody[2] }
  cx /= M; cy /= M; cz /= M
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const c of items) {
    const m = c.massKg
    const d = [c.comBody[0] - cx, c.comBody[1] - cy, c.comBody[2] - cz]
    const d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const own = c.inertiaCom && Array.isArray(c.inertiaCom[i]) && Number.isFinite(c.inertiaCom[i][j]) ? c.inertiaCom[i][j] : 0
        I[i][j] += own + m * ((i === j ? d2 : 0) - d[i] * d[j])
      }
    }
  }
  return { massKg: M, comBody: [cx, cy, cz], inertiaBody: I, source: 'components', count: items.length }
}

// ───────────────────────── 对称矩阵特征分解 ─────────────────────────

/**
 * 实对称矩阵的 Jacobi 特征分解（n 小：3×3 的 PCA / 主惯量，10×10 的二次曲面拟合）。
 * Jacobi 慢但对近重根稳：部件分割里圆形反射面的两个面内特征值几乎相等，解析法在这里会丢精度。
 * @param {number[][]} A n×n（不改原矩阵）
 * @returns {{values:number[], vectors:number[][]}} 按特征值升序；vectors[k] 是第 k 个特征向量
 */
export function symEigen(A) {
  const n = A.length
  const a = A.map((r) => r.slice())
  const v = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0, diag = 0
    for (let i = 0; i < n; i++) {
      diag += a[i][i] * a[i][i]
      for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j]
    }
    if (off <= 1e-30 * Math.max(diag, 1e-300)) break
    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q]
        if (Math.abs(apq) < 1e-300) continue
        const theta = (a[q][q] - a[p][p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q]
          a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k]
          a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k][p], vkq = v[k][q]
          v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j])
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => v.map((row) => row[i])) }
}

/** 主惯量：特征值升序 + 对应主轴（给模型页读数与校核用） */
export function principalInertia(I) {
  const { values, vectors } = symEigen(I)
  return { moments: values, axes: vectors }
}
