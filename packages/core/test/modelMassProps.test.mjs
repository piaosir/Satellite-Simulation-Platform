// 几何工程量自测（packages/core/models/massProps.mjs）。运行：node packages/core/test/modelMassProps.test.mjs
//
// 判据全部对解析解（任务书 §4.3）：
//   ① 焊接：抖动 < tol 的重复点必须并上（含跨格边界），> tol 的不许并；
//   ② 闭合性：闭合 / 开口 / 单面翻转 / 非流形各一例；边归类对朴素实现（随机非流形堆）；锥尖度数 8 万的双锥 < 1 s；
//   ③ 长方体（任意中心 / 尺寸，float32 顶点）体积、质心、惯量相对误差 < 1e-9；旋转长方体（float64）同；
//   ④ 正 N 棱柱环（空心「圆柱」的多边形精确式，不是对连续圆柱）< 1e-9；
//   ⑤ 细分二十面体球：误差随细分单调下降，最细一档体积误差 < 1e-3；
//   ⑥ 内翻网格识别并翻正；镜像矩阵不翻号；多壳里个别壳内翻逐壳翻正；空腔（正确 / 整体翻 / 只翻内壳 / 只翻外壳）
//      与三层嵌套都得到解析的「外 − 内」体积、质心、惯量 < 1e-9；
//   ⑦ 开口盒 estimate → confidence 'low'、惯量 null、表面质心对手算；
//   ⑧ combineComponents 对手算，且「两半长方体合成 = 整块长方体」；
//   ⑨ 性能：100 万三角形（三角形汤）焊接 + 闭合 + 质量特性 < 3 s。
import assert from 'node:assert/strict'
import {
  weldByPosition, isClosed, polyhedronMassProps, surfaceProps, estimateMassProps,
  combineComponents, symEigen, principalInertia, concatMeshes,
} from '../models/massProps.mjs'

let pass = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log('PASS  ' + name) } catch (e) { console.error('FAIL  ' + name + '\n      ' + (e && e.message)); process.exitCode = 1 }
}
const relErr = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300)
const near = (a, b, rel, msg) => assert.ok(relErr(a, b) <= rel, `${msg}: ${a} vs ${b}（相对 ${relErr(a, b).toExponential(2)}）`)
const nearAbs = (a, b, abs, msg) => assert.ok(Math.abs(a - b) <= abs, `${msg}: ${a} vs ${b}`)
/** 张量逐元素：对角相对误差，非对角相对最大对角 */
function nearTensor(I, J, rel, msg) {
  const scale = Math.max(Math.abs(J[0][0]), Math.abs(J[1][1]), Math.abs(J[2][2]))
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const e = Math.abs(I[i][j] - J[i][j]) / scale
    assert.ok(e <= rel, `${msg}[${i}][${j}]: ${I[i][j]} vs ${J[i][j]}（相对 ${e.toExponential(2)}）`)
  }
}

// ───────── 网格构造 ─────────

/** 长方体 8 顶点 12 面（外法向，右手绕向）。corner 在前、size 为三边长 */
function boxMesh(x0, y0, z0, x1, y1, z1, Arr = Float32Array) {
  const position = Arr.from([x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1])
  const index = Uint32Array.from([
    0, 2, 1, 0, 3, 2,   // z0 面，法向 −z
    4, 5, 6, 4, 6, 7,   // z1 面，+z
    0, 1, 5, 0, 5, 4,   // y0 面，−y
    3, 7, 6, 3, 6, 2,   // y1 面，+y
    0, 4, 7, 0, 7, 3,   // x0 面，−x
    1, 2, 6, 1, 6, 5,   // x1 面，+x
  ])
  return { position, index }
}
/** 展开成三角形汤（每面独立顶点），模拟 glb 里按面拆开的顶点 */
function toSoup({ position, index }, Arr = Float32Array) {
  const p = new Arr(index.length * 3)
  for (let k = 0; k < index.length; k++) for (let d = 0; d < 3; d++) p[k * 3 + d] = position[index[k] * 3 + d]
  return { position: p, index: null }
}
const reversed = ({ position, index }) => {
  const idx = index.slice()
  for (let t = 0; t < idx.length; t += 3) { const b = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = b }
  return { position, index: idx }
}

/** 正 N 棱柱环：外 / 内接圆半径 Ro/Ri，高 H，轴 z，中心 c；闭合、外法向 */
function prismRing(N, Ro, Ri, H, c, phase) {
  const pos = []
  const vid = (ring, i) => ring * N + (i % N)       // ring：0 外下 1 外上 2 内下 3 内上
  for (const [R, z] of [[Ro, -H / 2], [Ro, H / 2], [Ri, -H / 2], [Ri, H / 2]]) {
    for (let i = 0; i < N; i++) {
      const a = phase + (2 * Math.PI * i) / N
      pos.push(c[0] + R * Math.cos(a), c[1] + R * Math.sin(a), c[2] + z)
    }
  }
  const idx = []
  const quad = (a, b, cc, d) => idx.push(a, b, cc, a, cc, d)    // a→b→c→d 逆时针（从外看）
  for (let i = 0; i < N; i++) {
    const j = i + 1
    quad(vid(0, i), vid(0, j), vid(1, j), vid(1, i))           // 外壁：法向朝外
    quad(vid(2, j), vid(2, i), vid(3, i), vid(3, j))           // 内壁：法向朝轴
    quad(vid(1, i), vid(1, j), vid(3, j), vid(3, i))           // 顶环：+z
    quad(vid(0, j), vid(0, i), vid(2, i), vid(2, j))           // 底环：−z
  }
  return { position: Float64Array.from(pos), index: Uint32Array.from(idx) }
}

/** 细分二十面体球（顶点投到半径 R 的球面上），level 次四分 */
function icosphere(level, R) {
  const t = (1 + Math.sqrt(5)) / 2
  let verts = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l) })
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]]
  for (let l = 0; l < level; l++) {
    const cache = new Map()
    const mid = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`
      if (cache.has(key)) return cache.get(key)
      const m = [0, 1, 2].map((d) => verts[a][d] + verts[b][d])
      const len = Math.hypot(...m)
      verts.push(m.map((x) => x / len))
      cache.set(key, verts.length - 1)
      return verts.length - 1
    }
    const nf = []
    for (const [a, b, c] of faces) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a)
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = nf
  }
  return { position: Float64Array.from(verts.flat().map((x) => x * R)), index: Uint32Array.from(faces.flat()) }
}

/** 旋转矩阵（绕任意轴），行主序 3×3 */
function rotMat(axis, ang) {
  const l = Math.hypot(...axis), [x, y, z] = axis.map((v) => v / l)
  const c = Math.cos(ang), s = Math.sin(ang), C = 1 - c
  return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]]
}
const matMul = (A, B) => A.map((r, i) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const transpose = (A) => A[0].map((_, j) => A.map((r) => r[j]))

// ───────── ① 焊接 ─────────

ok('① 盒三角形汤 36 顶点焊成 8 个，索引按位置对应', () => {
  const box = boxMesh(-1, -2, -3, 1, 2, 3)
  const soup = toSoup(box)
  const w = weldByPosition(soup.position, null)
  assert.equal(w.vertexCount, 8)
  assert.equal(w.index.length, 36)
  for (let k = 0; k < 36; k++) for (let d = 0; d < 3; d++) assert.equal(w.position[w.index[k] * 3 + d], soup.position[k * 3 + d])
})

ok('① 抖动 < tol 的重复点跨格边界也必须并上；> tol 的不并', () => {
  // 伪随机（确定）：2000 个基点间距 1，各复制 4 份、抖动半径 0.45·tol（两两距离 < 0.9·tol）
  let seed = 12345
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
  const tol = 1e-4
  const pts = []
  for (let b = 0; b < 2000; b++) {
    const base = [b % 13, Math.floor(b / 13) % 11, Math.floor(b / 143)]
    for (let r = 0; r < 4; r++) {
      const u = rnd() * 2 - 1, v = rnd() * 2 - 1, w = rnd() * 2 - 1, l = Math.hypot(u, v, w) || 1
      const rad = 0.45 * tol * rnd()
      pts.push(base[0] + (u / l) * rad, base[1] + (v / l) * rad, base[2] + (w / l) * rad)
    }
  }
  const wld = weldByPosition(Float64Array.from(pts), null, tol)
  assert.equal(wld.vertexCount, 2000)
  // 相距 3·tol 的两点不并
  const w2 = weldByPosition(Float64Array.from([0, 0, 0, 3 * tol, 0, 0, 0, 5, 0]), null, tol)
  assert.equal(w2.vertexCount, 3)
})

ok('① 缺省 tol = 1e-6 × 对角线', () => {
  const w = weldByPosition(Float32Array.from([0, 0, 0, 3, 4, 0, 1, 1, 0]), null)
  near(w.tol, 5e-6, 1e-12, 'tol')
})

// ───────── ② 闭合性 ─────────

ok('② 闭合盒 / 开口盒 / 单面翻转 / 非流形', () => {
  const box = boxMesh(0, 0, 0, 1, 1, 1)
  const c = isClosed(box.index, 8)
  assert.deepEqual([c.closed, c.boundaryEdges, c.nonManifoldEdges, c.inconsistent, c.edges], [true, 0, 0, 0, 18])
  const open = box.index.slice(6)                               // 去掉 z0 面
  const o = isClosed(open, 8)
  assert.equal(o.closed, false); assert.equal(o.boundaryEdges, 4)
  const flip = box.index.slice(); const t = flip[1]; flip[1] = flip[2]; flip[2] = t
  const f = isClosed(flip, 8)
  assert.equal(f.closed, false); assert.equal(f.inconsistent, 3)
  // 在一条已有边上再挂一片三角形（鳍）→ 非流形
  const fin = Uint32Array.from([...box.index, 0, 1, 8])
  const n = isClosed(fin, 9)
  assert.equal(n.closed, false); assert.equal(n.nonManifoldEdges, 1)
  // 整体内翻仍是绕向一致的闭合网格
  assert.equal(isClosed(reversed(box).index, 8).closed, true)
})

ok('② 边归类对朴素实现（随机非流形三角形堆，含重复面、同向边、孤立边）', () => {
  let seed = 12345
  const rnd = (n) => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % n)
  for (let round = 0; round < 20; round++) {
    const V = 6 + rnd(30), T = 1 + rnd(300)
    const idx = []
    for (let t = 0; t < T; t++) {
      const a = rnd(V), b = rnd(V), c = rnd(V)
      idx.push(a, b, c)
      if (rnd(5) === 0) idx.push(a, b, c)                       // 重复面
      if (rnd(7) === 0) idx.push(a, c, b)                       // 反向重合面
    }
    // 朴素：Map<"lo,hi", [f, r]>
    const m = new Map()
    let degenerate = 0
    for (let t = 0; t < idx.length; t += 3) {
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]]
      if (a === b || b === c || c === a) { degenerate++; continue }
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const lo = Math.min(u, v), hi = Math.max(u, v), k = lo + ',' + hi
        const e = m.get(k) || [0, 0]
        if (u === lo) e[0]++; else e[1]++
        m.set(k, e)
      }
    }
    let boundary = 0, nonManifold = 0, inconsistent = 0
    for (const [f, r] of m.values()) { const s = f + r; if (s === 1) boundary++; else if (s > 2) nonManifold++; else if (!(f === 1 && r === 1)) inconsistent++ }
    const got = isClosed(Uint32Array.from(idx), V)
    assert.deepEqual([got.edges, got.boundaryEdges, got.nonManifoldEdges, got.inconsistent, got.degenerate], [m.size, boundary, nonManifold, inconsistent, degenerate], `第 ${round} 轮`)
  }
})

ok('② 高度数顶点（双锥，锥尖度数 8 万）：闭合判定按边数线性，不随度数平方增长', () => {
  const N = 80000
  const pos = [0, 0, 1, 0, 0, -1]
  for (let i = 0; i < N; i++) { const a = (2 * Math.PI * i) / N; pos.push(Math.cos(a), Math.sin(a), 0) }
  const idx = new Uint32Array(6 * N)
  for (let i = 0; i < N; i++) { const a = 2 + i, b = 2 + ((i + 1) % N); idx.set([0, a, b, 1, b, a], i * 6) }
  const t0 = performance.now()
  const c = isClosed(idx, N + 2)
  const ms = performance.now() - t0
  console.log(`      ${2 * N} 面、锥尖度数 ${N}：${ms.toFixed(0)} ms`)
  assert.equal(c.closed, true)
  assert.equal(c.edges, 3 * N)
  assert.ok(ms < 1000, `耗时 ${ms.toFixed(0)} ms`)
  const mp = estimateMassProps({ meshes: [{ position: Float64Array.from(pos), index: idx }], massKg: 1 })
  near(mp.volumeM3, (2 / 3) * N * Math.sin((2 * Math.PI) / N) / 2, 1e-9, '双锥体积（正 N 边形底）')
})

// ───────── ③ 长方体 ─────────

function boxExpected(x0, y0, z0, x1, y1, z1, rho = 1) {
  const a = x1 - x0, b = y1 - y0, c = z1 - z0, V = a * b * c, m = rho * V
  return { V, m, com: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2], I: [[m * (b * b + c * c) / 12, 0, 0], [0, m * (a * a + c * c) / 12, 0], [0, 0, m * (a * a + b * b) / 12]] }
}

ok('③ 长方体（任意中心 / 尺寸，float32）体积、质心、惯量 < 1e-9', () => {
  const cases = [[1.37, -2.11, 0.53, 0.8, 1.9, 3.3], [-120.25, 44.5, 3.75, 2.5, 0.07, 11.2], [1e3 + 0.3, -7e2, 5e2, 3.1, 2.2, 1.7]]
  for (const [cx, cy, cz, a, b, c] of cases) {
    const f = Math.fround
    const x0 = f(cx - a / 2), x1 = f(cx + a / 2), y0 = f(cy - b / 2), y1 = f(cy + b / 2), z0 = f(cz - c / 2), z1 = f(cz + c / 2)
    const exp = boxExpected(x0, y0, z0, x1, y1, z1, 2700)
    const mp = polyhedronMassProps(boxMesh(x0, y0, z0, x1, y1, z1).position, boxMesh(x0, y0, z0, x1, y1, z1).index, 2700)
    near(mp.volume, exp.V, 1e-9, '体积')
    near(mp.massKg, exp.m, 1e-9, '质量')
    for (let d = 0; d < 3; d++) near(mp.centroid[d], exp.com[d], 1e-9, `质心${d}`)
    nearTensor(mp.inertia, exp.I, 1e-9, '惯量')
    assert.equal(mp.inverted, false)
  }
})

ok('③ 旋转长方体（float64）惯量 = R·I·Rᵀ < 1e-9', () => {
  const R = rotMat([0.3, -0.5, 0.8], 0.77)
  const [a, b, c] = [1.2, 0.35, 2.9], cen = [4.2, -1.1, 0.6]
  const box = boxMesh(-a / 2, -b / 2, -c / 2, a / 2, b / 2, c / 2, Float64Array)
  const p = box.position
  for (let i = 0; i < 8; i++) {
    const v = [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]
    for (let d = 0; d < 3; d++) p[i * 3 + d] = R[d][0] * v[0] + R[d][1] * v[1] + R[d][2] * v[2] + cen[d]
  }
  const mp = polyhedronMassProps(p, box.index, 1)
  const exp = boxExpected(0, 0, 0, a, b, c)
  near(mp.volume, exp.V, 1e-9, '体积')
  for (let d = 0; d < 3; d++) near(mp.centroid[d], cen[d], 1e-9, `质心${d}`)
  nearTensor(mp.inertia, matMul(matMul(R, exp.I), transpose(R)), 1e-9, '惯量')
  // 主惯量回到三边公式
  const pm = principalInertia(mp.inertia).moments
  const want = [exp.I[0][0], exp.I[1][1], exp.I[2][2]].sort((x, y) => x - y)
  for (let k = 0; k < 3; k++) near(pm[k], want[k], 1e-9, `主惯量${k}`)
})

// ───────── ④ 正 N 棱柱环 ─────────

ok('④ 正 N 棱柱环（空心多边形柱）对多边形精确式 < 1e-9', () => {
  for (const [N, Ro, Ri, H, c, ph] of [[6, 1.0, 0.6, 2.0, [0, 0, 0], 0], [24, 2.3, 2.0, 0.7, [3.3, -1.2, 5.5], 0.3], [64, 0.75, 0.2, 4.1, [-10, 20, 1], 1.1]]) {
    const ring = prismRing(N, Ro, Ri, H, c, ph)
    assert.equal(isClosed(ring.index).closed, true)
    const th = (2 * Math.PI) / N
    const Ap = (R) => (N / 2) * R * R * Math.sin(th)
    const Jp = (R) => (N * R ** 4 * Math.sin(th) * (2 + Math.cos(th))) / 12
    const A = Ap(Ro) - Ap(Ri), J = Jp(Ro) - Jp(Ri)
    const V = H * A
    const Izz = H * J, Ixx = (H * J) / 2 + (A * H ** 3) / 12
    const mp = polyhedronMassProps(ring.position, ring.index, 1)
    near(mp.volume, V, 1e-9, `N=${N} 体积`)
    for (let d = 0; d < 3; d++) nearAbs(mp.centroid[d], c[d], 1e-9 * Math.max(1, Math.abs(c[d])), `N=${N} 质心${d}`)
    nearTensor(mp.inertia, [[Ixx, 0, 0], [0, Ixx, 0], [0, 0, Izz]], 1e-9, `N=${N} 惯量`)
  }
})

// ───────── ⑤ 细分二十面体球 ─────────

ok('⑤ 细分二十面体球：误差随细分单调下降，最细一档体积误差 < 1e-3', () => {
  const R = 1.7
  const V = (4 / 3) * Math.PI * R ** 3
  let prevV = Infinity, prevI = Infinity
  const rows = []
  for (let l = 1; l <= 6; l++) {
    const s = icosphere(l, R)
    const mp = polyhedronMassProps(s.position, s.index, 1)
    const eV = relErr(mp.volume, V)
    const eI = relErr(mp.inertia[0][0], 0.4 * V * R * R)
    rows.push(`L${l} ${s.index.length / 3} 面 体积误差 ${eV.toExponential(2)} 惯量误差 ${eI.toExponential(2)}`)
    assert.ok(eV < prevV && eI < prevI, `L${l} 未单调下降`)
    for (let d = 0; d < 3; d++) nearAbs(mp.centroid[d], 0, 1e-12, `L${l} 质心`)
    prevV = eV; prevI = eI
  }
  assert.ok(prevV < 1e-3, `最细一档体积误差 ${prevV}`)
  console.log('      ' + rows.join('\n      '))
})

// ───────── ⑥ 内翻 / 镜像 ─────────

ok('⑥ 内翻网格：识别 inverted 并翻正，体积 / 质心 / 惯量不变', () => {
  const box = boxMesh(0.5, 1.5, 2.5, 2.5, 2.0, 5.5)
  const a = polyhedronMassProps(box.position, box.index, 3)
  const b = polyhedronMassProps(box.position, reversed(box).index, 3)
  assert.equal(b.inverted, true)
  assert.ok(b.signedVolume < 0)
  near(b.volume, a.volume, 1e-12, '体积')
  for (let d = 0; d < 3; d++) near(b.centroid[d], a.centroid[d], 1e-12, '质心')
  nearTensor(b.inertia, a.inertia, 1e-12, '惯量')
  const e = estimateMassProps({ meshes: [reversed(box)], massKg: 10 })
  assert.equal(e.confidence, 'high'); assert.equal(e.inverted, true)
  near(e.volumeM3, a.volume, 1e-12, 'estimate 体积')
})

ok('⑥ 镜像矩阵（det<0）变换后体积仍为正、不报内翻', () => {
  const box = boxMesh(0, 0, 0, 1, 2, 3)
  const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]      // x → −x + 5
  const e = estimateMassProps({ meshes: [{ ...box, matrix: mirror }], massKg: 6 })
  assert.equal(e.closed, true); assert.equal(e.inverted, false)
  near(e.volumeM3, 6, 1e-12, '体积')
  near(e.comBody[0], 4.5, 1e-12, '质心 x')
})

/** 若干长方体按 ±1 号叠加（−1 = 空腔）的解析质量特性，密度 rho */
function boxesExpected(list, rho) {
  let V = 0, cx = 0, cy = 0, cz = 0
  const parts = list.map(([s, b]) => ({ s, e: boxExpected(...b, rho) }))
  for (const { s, e } of parts) { V += s * e.V; cx += s * e.V * e.com[0]; cy += s * e.V * e.com[1]; cz += s * e.V * e.com[2] }
  const com = [cx / V, cy / V, cz / V]
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const { s, e } of parts) {
    const d = [e.com[0] - com[0], e.com[1] - com[1], e.com[2] - com[2]], d2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I[i][j] += s * (e.I[i][j] + e.m * ((i === j ? d2 : 0) - d[i] * d[j]))
  }
  return { V, m: rho * V, com, I }
}
function checkEstimate(meshes, list, msg) {
  const exp = boxesExpected(list, 1)
  const e = estimateMassProps({ meshes, massKg: exp.V })          // 密度 1
  assert.equal(e.confidence, 'high', msg)
  near(e.volumeM3, exp.V, 1e-9, `${msg} 体积`)
  for (let d = 0; d < 3; d++) near(e.comBody[d] + 100, exp.com[d] + 100, 1e-9, `${msg} 质心${d}`)
  nearTensor(e.inertiaBody, exp.I, 1e-9, `${msg} 惯量`)
  return e
}

ok('⑥ 多壳里个别壳内翻（镜像件没翻绕向）：逐壳翻正，体积 / 质心 / 惯量对解析', () => {
  const A = [0, 0, 0, 1, 1, 1], B = [10, 0, 0, 12, 2, 2], b = [10, 0, 0, 10.5, 0.5, 0.5]
  // 小壳翻：整体体积仍为正，只按总体积判会把它当空腔减掉、质心落到两盒之外
  let e = checkEstimate([boxMesh(...A), reversed(boxMesh(...b))], [[1, A], [1, b]], '小壳翻')
  assert.deepEqual([e.shells, e.invertedShells, e.cavities, e.inverted], [2, 1, 0, true])
  // 大壳翻：总体积为负
  e = checkEstimate([boxMesh(...A), reversed(boxMesh(...B))], [[1, A], [1, B]], '大壳翻')
  assert.deepEqual([e.invertedShells, e.cavities], [1, 0])
  // 部分相交的两个同向实体（美术模型零件互插）：互不包含，谁也不翻
  const C = [0.5, 0.5, 0.5, 1.5, 1.5, 1.5]
  e = estimateMassProps({ meshes: [boxMesh(...A), boxMesh(...C)], massKg: 1 })
  assert.deepEqual([e.invertedShells, e.cavities], [0, 0])
  near(e.volumeM3, 2, 1e-12, '互插体积（重叠部分重复计，均匀密度口径）')
})

ok('⑥ 空腔：外正内负保留为空腔；整体翻 / 只翻内壳 / 只翻外壳都纠正到「外 − 内」', () => {
  const O = [0, 0, 0, 4, 3, 2], I = [1, 0.5, 0.5, 2.5, 2, 1.5]
  const exp = [[1, O], [-1, I]]
  const cases = [
    ['正确空腔', boxMesh(...O), reversed(boxMesh(...I)), 0],
    ['整体内翻', reversed(boxMesh(...O)), boxMesh(...I), 2],
    ['只翻内壳', boxMesh(...O), boxMesh(...I), 1],
    ['只翻外壳', reversed(boxMesh(...O)), reversed(boxMesh(...I)), 1],
  ]
  for (const [name, mo, mi, nInv] of cases) {
    const e = checkEstimate([mo, mi], exp, name)
    assert.deepEqual([e.shells, e.cavities, e.invertedShells], [2, 1, nInv], name)
  }
  // 三层嵌套：实体里有空腔，空腔里又放一块（内翻的）实体 → 深度 2 的实体翻回正
  const X = [0, 0, 0, 6, 6, 6], Y = [1, 1, 1, 5, 5, 5], Z = [2, 2.5, 2, 3, 3, 3.5]
  const e = checkEstimate([boxMesh(...X), reversed(boxMesh(...Y)), reversed(boxMesh(...Z))], [[1, X], [-1, Y], [1, Z]], '三层嵌套')
  assert.deepEqual([e.shells, e.cavities, e.invertedShells], [3, 1, 1])
})

// ───────── estimate 档（闭合）─────────

ok('estimate：三角形汤 + 平移旋转矩阵 + 分成两个 primitive 仍判闭合，均匀密度 = 质量 / 体积', () => {
  const [a, b, c] = [2, 1, 0.5]
  const soup = toSoup(boxMesh(-a / 2, -b / 2, -c / 2, a / 2, b / 2, c / 2))
  // 拆成两个网格（前 18 个顶点 / 后 18 个）
  const m1 = { position: soup.position.slice(0, 54), index: null }
  const m2 = { position: soup.position.slice(54), index: null }
  // 绕 z 转 90° 再平移 (10, 0, −2)（列主序）
  const M = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, -2, 1]
  const e = estimateMassProps({ meshes: [{ ...m1, matrix: M }, { ...m2, matrix: M }], massKg: 500 })
  assert.equal(e.confidence, 'high'); assert.equal(e.closed, true)
  near(e.volumeM3, 1, 1e-6, '体积')
  near(e.density, 500, 1e-6, '密度')
  for (let d = 0; d < 3; d++) nearAbs(e.comBody[d], [10, 0, -2][d], 1e-6, `质心${d}`)
  // 转 90° 后 x/y 两轴互换：Ixx = m(a²+c²)/12，Iyy = m(b²+c²)/12
  nearTensor(e.inertiaBody, [[500 * (a * a + c * c) / 12, 0, 0], [0, 500 * (b * b + c * c) / 12, 0], [0, 0, 500 * (a * a + b * b) / 12]], 1e-6, '惯量')
  near(e.areaM2, 2 * (a * b + b * c + a * c), 1e-6, '面积')
})

ok('estimate：不给质量 → 闭合件仍给体积 / 质心，惯量 null', () => {
  const e = estimateMassProps({ meshes: [boxMesh(0, 0, 0, 1, 1, 1)] })
  assert.equal(e.confidence, 'high'); assert.equal(e.massKg, null); assert.equal(e.inertiaBody, null)
  near(e.volumeM3, 1, 1e-9, '体积')
})

// ───────── ⑦ 开口盒 ─────────

ok('⑦ 开口盒 → confidence low、惯量 null、表面质心对手算', () => {
  const box = boxMesh(0, 0, 0, 2, 2, 1)
  const open = { position: box.position, index: box.index.slice(6) }   // 去掉 z=0 底面
  const e = estimateMassProps({ meshes: [open], massKg: 100 })
  assert.equal(e.confidence, 'low'); assert.equal(e.closed, false)
  assert.equal(e.inertiaBody, null); assert.equal(e.volumeM3, null)
  assert.equal(e.topology.boundaryEdges, 4)
  // 顶面 4 m² 在 z=1；四个侧面各 2 m² 在 z=0.5 → z̄ = (4·1 + 8·0.5)/12 = 2/3
  near(e.areaM2, 12, 1e-12, '面积')
  nearAbs(e.comBody[0], 1, 1e-12, 'x'); nearAbs(e.comBody[1], 1, 1e-12, 'y'); near(e.comBody[2], 2 / 3, 1e-12, 'z')
  const s = surfaceProps(open.position, open.index)
  near(s.area, 12, 1e-12, 'surfaceProps 面积')
  // 空输入
  assert.equal(estimateMassProps({ meshes: [] }), null)
})

// ───────── ⑧ 组件累加 ─────────

ok('⑧ combineComponents 对手算', () => {
  const r = combineComponents([
    { massKg: 2, comBody: [1, 0, 0] },
    { massKg: 2, comBody: [-1, 0, 0] },
    { massKg: 4, comBody: [0, 2, 0], inertiaCom: [[1, 0, 0], [0, 2, 0], [0, 0, 3]] },
    { massKg: 0, comBody: [9, 9, 9] },                 // 质量 0：跳过
    { massKg: NaN, comBody: [1, 1, 1] },               // 非数：跳过
  ])
  assert.equal(r.massKg, 8); assert.equal(r.count, 3)
  assert.deepEqual(r.comBody, [0, 1, 0])
  nearTensor(r.inertiaBody, [[9, 0, 0], [0, 6, 0], [0, 0, 15]], 1e-15, '惯量')
  assert.equal(combineComponents([]), null)
})

ok('⑧ 两半长方体组件累加 = 整块长方体的多面体积分', () => {
  const whole = polyhedronMassProps(...Object.values(boxMesh(0, 0, 0, 3, 1, 2, Float64Array)), 10)
  const h1 = polyhedronMassProps(...Object.values(boxMesh(0, 0, 0, 1, 1, 2, Float64Array)), 10)
  const h2 = polyhedronMassProps(...Object.values(boxMesh(1, 0, 0, 3, 1, 2, Float64Array)), 10)
  const r = combineComponents([
    { massKg: h1.massKg, comBody: h1.centroid, inertiaCom: h1.inertia },
    { massKg: h2.massKg, comBody: h2.centroid, inertiaCom: h2.inertia },
  ])
  near(r.massKg, whole.massKg, 1e-12, '质量')
  for (let d = 0; d < 3; d++) near(r.comBody[d], whole.centroid[d], 1e-12, `质心${d}`)
  nearTensor(r.inertiaBody, whole.inertia, 1e-12, '惯量')
})

ok('symEigen：已知谱的 3×3 与 10×10', () => {
  const R = rotMat([1, 2, 3], 0.9)
  const A = matMul(matMul(R, [[5, 0, 0], [0, 1, 0], [0, 0, 1 + 1e-9]]), transpose(R))
  const e = symEigen(A)
  near(e.values[2], 5, 1e-12, 'λmax')
  const v = e.vectors[2], w = [R[0][0], R[1][0], R[2][0]]
  near(Math.abs(v[0] * w[0] + v[1] * w[1] + v[2] * w[2]), 1, 1e-12, '特征向量')
  const n = 10, D = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? i + 1 : 0.01 / (1 + i + j))))
  const e10 = symEigen(D)
  for (let k = 0; k < n; k++) {
    const x = e10.vectors[k], Ax = D.map((r) => r.reduce((s, a, j) => s + a * x[j], 0))
    for (let i = 0; i < n; i++) nearAbs(Ax[i], e10.values[k] * x[i], 1e-12, `10×10 λ${k}`)
  }
})

ok('concatMeshes：三角形偏移与镜像翻绕向', () => {
  const a = boxMesh(0, 0, 0, 1, 1, 1), b = boxMesh(0, 0, 0, 1, 1, 1)
  const c = concatMeshes([a, { ...b, matrix: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }])
  assert.deepEqual(c.triOffsets, [0, 12])
  assert.equal(c.position.length, 48)
  // 第二个网格第一面 (0,2,1) 镜像后应翻成 (0,1,2) + 8
  assert.deepEqual(Array.from(c.index.slice(36, 39)), [8, 9, 10])
})

// ───────── ⑨ 性能 ─────────

ok('⑨ 100 万三角形（三角形汤 300 万顶点）焊接 + 闭合 + 质量特性 < 3 s', () => {
  // 圆环面：主半径 Rm、管半径 r，U×V 网格每格两面 → 2·U·V = 1,000,000
  const U = 1000, Vn = 500, Rm = 3, r = 0.8
  const P = (i, j) => {
    const u = (2 * Math.PI * (i % U)) / U, v = (2 * Math.PI * (j % Vn)) / Vn
    return [(Rm + r * Math.cos(v)) * Math.cos(u), (Rm + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]
  }
  const pos = new Float32Array(U * Vn * 2 * 9)
  let o = 0
  const put = (p) => { pos[o++] = p[0]; pos[o++] = p[1]; pos[o++] = p[2] }
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < Vn; j++) {
      const a = P(i, j), b = P(i + 1, j), c = P(i + 1, j + 1), d = P(i, j + 1)
      put(a); put(b); put(c); put(a); put(c); put(d)
    }
  }
  const t0 = performance.now()
  const w = weldByPosition(pos, null)
  const t1 = performance.now()
  const topo = isClosed(w.index, w.vertexCount)
  const t2 = performance.now()
  const mp = polyhedronMassProps(w.position, w.index, 1)
  const t3 = performance.now()
  const ms = t3 - t0
  console.log(`      焊接 ${(t1 - t0).toFixed(0)} ms · 闭合 ${(t2 - t1).toFixed(0)} ms · 质量特性 ${(t3 - t2).toFixed(0)} ms · 合计 ${ms.toFixed(0)} ms（${w.vertexCount} 个焊接后顶点）`)
  assert.equal(w.vertexCount, U * Vn)
  assert.equal(topo.closed, true)
  // 多边形圆环体积收敛到 2π²Rr²（这里只作健全性检查）
  near(mp.volume, 2 * Math.PI ** 2 * Rm * r * r, 1e-4, '圆环体积')
  assert.ok(ms < 3000, `耗时 ${ms.toFixed(0)} ms ≥ 3000 ms`)
})

console.log(`modelMassProps: ${pass} 项通过`)
if (process.exitCode) process.exit(process.exitCode)
