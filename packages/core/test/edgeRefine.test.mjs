// 等值线交点细化「线 = 表」的不变量（src/viz/grd/coverage.js buildEdgeRefine / bandGeometry(refine)、
// src/viz/flatmap/glField.js buildMeshIndices(refine)）。运行：npm test
//
//   ① 取值内核重构后逐位不变：sampleBeamAtParam ≡ 旧实现（4 次 bicubicAt 逐分量），随机 3000 点、四种极化、AR 分量
//   ② 细化表：每条「两端节点跨档」的格边恰有一条记录，交点在表的插值下 |Δ| ≤ 1e-4 dB，同边各档 s* 单调
//   ③ bandGeometry(refine)：等值线每个顶点在表的插值下 |Δ| ≤ 1e-4 dB（不细化时同一份数据差 >0.05 dB，证明测的不是空话）；
//      填充与线由构造重合（线的每个顶点都是相邻两档填充多边形的顶点）；线的拓扑不变（各档线段数 / 拼环数与不细化时一致）
//   ④ 不细化那条路逐位不变（金标准 fixtures/bandGeometry.golden.json）
//   ⑤ GPU 网格(refine)：每个三角形的三个顶点 d 落在同一档内（带纯度）；CPU 每块填充多边形的质心都在某个 GPU 三角形内
//      且 GPU 线性插值出的 dB 落同一档（全量、不抽样）；索引不越界、细化顶点属性有限
//   ⑥ 真实 GRD（本机若有）：0.1° 粗网格 94 波束的首波束，线上顶点 |Δ| ≤ 1e-4 dB；顺带打印耗时
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { antennaBasis, projectGrid, fieldDb, bandGeometry, buildEdgeRefine, edgeRefineFor, sampleBeamAtParam, sampleBeamAt, stitchLoops, projectRefine, refinedPeakDb, peakRefDb } from '../../../src/viz/grd/coverage.js'
import { buildMeshIndices } from '../../../src/viz/flatmap/glField.js'
import { geodeticToEcef, elevationDeg } from '../../../src/viz/wgs84.js'
import { goldenNow, GOLDEN_PATH } from './fixtures/bandGeometryGolden.mjs'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const now = () => performance.now()

// ---- 合成带复场的 GRD set：两个高斯瓣 + 相位斜坡，网格刻意粗（≈7 点/波束宽）让线性与 bicubic 差得出来 ----
function makeSet(NX = 61, NY = 61, span = 12) {
  const N = NX * NY
  const P1 = new Float32Array(N), P2 = new Float32Array(N), c1re = new Float32Array(N), c1im = new Float32Array(N), c2re = new Float32Array(N), c2im = new Float32Array(N)
  const dx = 2 * span / (NX - 1), dy = 2 * span / (NY - 1)
  for (let r = 0; r < NY; r++) {
    const y = -span + dy * r
    for (let c = 0; c < NX; c++) {
      const x = -span + dx * c, k = r * NX + c
      const a1 = Math.exp(-((x - 1.5) ** 2 + (y - 0.7) ** 2) / 4.5), a2 = 0.55 * Math.exp(-((x - 6.5) ** 2 + (y - 3.5) ** 2) / 4.5)
      const ph1 = 0.35 * x - 0.2 * y, ph2 = 0.6 * y + 1.1
      const re = a1 * Math.cos(ph1) + a2 * Math.cos(ph2), im = a1 * Math.sin(ph1) + a2 * Math.sin(ph2)
      const re2 = 0.5 * a1 * Math.cos(ph1 + 0.7), im2 = 0.5 * a1 * Math.sin(ph1 + 0.7)
      c1re[k] = re; c1im[k] = im; c2re[k] = re2; c2im[k] = im2
      P1[k] = c1re[k] * c1re[k] + c1im[k] * c1im[k]; P2[k] = c2re[k] * c2re[k] + c2im[k] * c2im[k]
      if (r > 30 && r < 33 && c > 40 && c < 43) { P1[k] = 0; P2[k] = 0; c1re[k] = 0; c1im[k] = 0; c2re[k] = 0; c2im[k] = 0 }   // 一小块无效增益
    }
  }
  return { XS: -span, YS: -span, XE: span, YE: span, NX, NY, P1, P2, c1re, c1im, c2re, c2im }
}
const set = makeSet()
const NX = set.NX, NY = set.NY, N = NX * NY
const beam = { P1: set.P1, P2: set.P2, c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX, NY } }
const dxg = (set.XE - set.XS) / (NX - 1), dyg = (set.YE - set.YS) / (NY - 1)
// 表在格坐标 (fc, fr) 处的 dB（RSS）
const tableAt = (fc, fr, pol = 'RSS') => { const r = sampleBeamAtParam(beam, [set.XS + fc * dxg, set.YS + fr * dyg], 1, { pol }); return r ? r.db : NaN }

// ============ ① 取值内核逐位不变 ============
{
  const keysW = (s) => { s = Math.abs(s); const a = -0.5; return s <= 1 ? ((a + 2) * s - (a + 3)) * s * s + 1 : (s < 2 ? ((a * s - 5 * a) * s + 8 * a) * s - 4 * a : 0) }
  const clampI = (v, n) => (v < 0 ? 0 : (v > n - 1 ? n - 1 : v))
  const bicubicAt = (arr, NX, NY, fc, fr) => {
    const c0 = Math.floor(fc), r0 = Math.floor(fr), tx = fc - c0, ty = fr - r0
    const wx = [keysW(1 + tx), keysW(tx), keysW(1 - tx), keysW(2 - tx)], wy = [keysW(1 + ty), keysW(ty), keysW(1 - ty), keysW(2 - ty)]
    let acc = 0
    for (let j = 0; j < 4; j++) { const rr = clampI(r0 - 1 + j, NY) * NX; let row = 0; for (let i = 0; i < 4; i++) row += wx[i] * arr[rr + clampI(c0 - 1 + i, NX)]; acc += wy[j] * row }
    return acc
  }
  const bilinearAt = (arr, NX, NY, fc, fr) => {
    const c0 = Math.floor(fc), r0 = Math.floor(fr), c1 = Math.min(c0 + 1, NX - 1), r1 = Math.min(r0 + 1, NY - 1), tx = fc - c0, ty = fr - r0
    return arr[r0 * NX + c0] * (1 - tx) * (1 - ty) + arr[r0 * NX + c1] * tx * (1 - ty) + arr[r1 * NX + c0] * (1 - tx) * ty + arr[r1 * NX + c1] * tx * ty
  }
  // 旧 sampleBeamAtParam 逐字（f184d10 起的复场口径 + 无复场回退）
  const oldSample = (beam, xy, rs, { pol = 'RSS', gainOffset = 0, pathLoss = 'none', hNadir = 35786, wantComp = false } = {}) => {
    const g = beam.grid, NX = g.NX, NY = g.NY
    const fc = (xy[0] - g.XS) / ((g.XE - g.XS) / (NX - 1)), fr = (xy[1] - g.YS) / ((g.YE - g.YS) / (NY - 1))
    if (fc < 0 || fc > NX - 1 || fr < 0 || fr > NY - 1) return null
    let p1, p2, comp = null
    if (beam.c1re) {
      const re1 = bicubicAt(beam.c1re, NX, NY, fc, fr), im1 = bicubicAt(beam.c1im, NX, NY, fc, fr)
      const re2 = bicubicAt(beam.c2re, NX, NY, fc, fr), im2 = bicubicAt(beam.c2im, NX, NY, fc, fr)
      p1 = re1 * re1 + im1 * im1; p2 = re2 * re2 + im2 * im2
      if (wantComp) comp = { re1, im1, re2, im2 }
    } else {
      const samp = (arr) => { const v = bicubicAt(arr, NX, NY, fc, fr); return v > 0 ? v : bilinearAt(arr, NX, NY, fc, fr) }
      p1 = samp(beam.P1); p2 = samp(beam.P2)
    }
    let Pw
    if (pol === 'P1') Pw = p1; else if (pol === 'P2') Pw = p2; else if (pol === 'RSS') Pw = p1 + p2
    else if (pol === 'P1/P2') Pw = p2 > 0 ? p1 / p2 : 0; else if (pol === 'P2/P1') Pw = p1 > 0 ? p2 / p1 : 0; else Pw = p1
    if (!(Pw > 0)) return null
    let v = 10 * Math.log10(Pw) + gainOffset
    if (pathLoss !== 'none') v += pathLoss === 'relative' ? 20 * Math.log10(hNadir / rs) : -10 * Math.log10(4 * Math.PI * rs * rs)
    return { db: v, comp }
  }
  let seed = 12345
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  const bare = { P1: set.P1, P2: set.P2, grid: beam.grid }   // 无复场的预置烘焙路
  let diff = 0, nullMis = 0, compMis = 0, tested = 0
  for (let i = 0; i < 3000; i++) {
    const xy = [set.XS + rnd() * (set.XE - set.XS), set.YS + rnd() * (set.YE - set.YS)]
    for (const pol of ['RSS', 'P1', 'P2', 'P1/P2', 'P2/P1']) for (const b of [beam, bare]) {
      const o = { pol, gainOffset: 3.25, pathLoss: i % 3 === 0 ? 'relative' : (i % 3 === 1 ? 'absolute' : 'none'), hNadir: 35786.06, wantComp: true }
      const a = oldSample(b, xy, 38000 + i, o), n = sampleBeamAtParam(b, xy, 38000 + i, o)
      tested++
      if (!a || !n) { if (!!a !== !!n) nullMis++; continue }
      if (a.db !== n.db) diff++
      if (!!a.comp !== !!n.comp || (a.comp && (a.comp.re1 !== n.comp.re1 || a.comp.im1 !== n.comp.im1 || a.comp.re2 !== n.comp.re2 || a.comp.im2 !== n.comp.im2))) compMis++
    }
  }
  ok(tested === 30000 && diff === 0, `sampleBeamAtParam 与旧实现逐位一致（${tested} 次取值，dB 不同 ${diff}）`)
  ok(nullMis === 0 && compMis === 0, `域外 / 非正功率的 null 与 AR 复分量也逐位一致（${nullMis} / ${compMis}）`)
}

// ============ ② 细化表 ============
const fld = fieldDb(set, null, { pol: 'RSS' })
const NB = 10, levels = []
for (let k = NB - 1; k >= 0; k--) levels.push(fld.max - 0.7 - (18 / NB) * k)   // 升序
const ref = buildEdgeRefine(beam, fld, levels, { pol: 'RSS', gainOffset: 0 })
{
  const db = fld.db
  // 独立枚举：每条格边（h/v/d）与每档的跨越
  let want = 0
  const cross = (i0, i1) => { const v0 = db[i0], v1 = db[i1]; if (v0 !== v0 || v1 !== v1) return 0; let c = 0; for (const L of levels) if ((v0 < L) !== (v1 < L)) c++; return c }
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) {
    const i = r * NX + c
    if (c < NX - 1) want += cross(i, i + 1)
    if (r < NY - 1) want += cross(i, i + NX)
    if (c < NX - 1 && r < NY - 1) want += cross(i, i + NX + 1)
  }
  ok(ref.n > 300, `细化表非空（${ref.n} 条记录）`)
  ok(ref.n === want, `每条跨档格边恰一条记录（表 ${ref.n} vs 枚举 ${want}）`)
  let worst = 0, mono = 0, badK = 0
  for (let i = 0; i < N; i++) {
    const c = i % NX, r = (i / NX) | 0
    let lastT = -1, prevS = 0, up = true
    for (let p = ref.off[i]; p < ref.off[i + 1]; p++) {
      const t = ref.et[p], k = ref.ek[p], s = ref.es[p]
      const dc = t === 1 ? 0 : 1, dr = t === 0 ? 0 : 1
      const v = tableAt(c + dc * s, r + dr * s)
      worst = Math.max(worst, Math.abs(v - levels[k]))
      const f = t === 0 ? i + 1 : (t === 1 ? i + NX : i + NX + 1)
      if (t !== lastT) { lastT = t; up = db[i] < db[f]; prevS = up ? -1 : 2 }
      else if (up ? s <= prevS : s >= prevS) mono++
      prevS = s
      if (!((db[i] < levels[k]) !== (db[f] < levels[k]))) badK++
    }
  }
  ok(worst <= 1e-4, `记录点在表的插值下恰等于档值（最大 |Δ| ${worst.toExponential(2)} dB）`)
  ok(mono === 0, `同一格边各档交点沿边单调（违例 ${mono}）`)
  ok(badK === 0, `记录的档确实被该边两端跨过（违例 ${badK}）`)
  // en = 记录的起点节点；cells = 五条边上有记录的格子（独立枚举对集合）
  let enBad = 0
  for (let i = 0; i < N; i++) for (let p = ref.off[i]; p < ref.off[i + 1]; p++) if (ref.en[p] !== i) enBad++
  ok(enBad === 0, `每条记录的起点节点 en 与 CSR 分组一致（错 ${enBad}）`)
  const has = (i, t) => { for (let p = ref.off[i]; p < ref.off[i + 1]; p++) if (ref.et[p] === t) return true; return false }
  const wantCells = []
  for (let r = 0; r < NY - 1; r++) for (let c = 0; c < NX - 1; c++) {
    const i00 = r * NX + c, i10 = i00 + 1, i01 = i00 + NX
    if (has(i00, 0) || has(i00, 1) || has(i00, 2) || has(i10, 1) || has(i01, 0)) wantCells.push(i00)
  }
  ok(wantCells.length > 100 && wantCells.length === ref.cells.length && wantCells.every((v, q) => v === ref.cells[q]), `cells = 五条边上有记录的格子、升序（${ref.cells.length} 格 vs 枚举 ${wantCells.length}）`)
  // 缓存：同键命中同一对象，改档 / 改极化即重建
  const r1 = edgeRefineFor(beam, fld, levels, 'RSS', 0), r2 = edgeRefineFor(beam, fld, levels, 'RSS', 0)
  ok(r1 === r2, 'edgeRefineFor 同 (极化, 增益, 档) 命中缓存')
  const r3 = edgeRefineFor(beam, fld, levels.map((x) => x + 0.1), 'RSS', 0)
  ok(r3 !== r1 && edgeRefineFor(beam, fld, levels, 'RSS', 0) !== r1, '换档 / 换回都重建（不做多套缓存，键只记最近一套）')
}

// ============ ③ bandGeometry(refine)：线 = 表、填充与线重合、拓扑不变 ============
// 恒等投影：lon=列号、lat=行号、全部可见 → 线顶点坐标就是格坐标，可直接喂表
const lonI = new Float32Array(N), latI = new Float32Array(N), visI = new Float32Array(N).fill(1)
for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) { lonI[r * NX + c] = c; latI[r * NX + c] = r }
const fieldI = { lon: lonI, lat: latI, vis: visI, db: fld.db, NX, NY }
const geoR = bandGeometry(fieldI, levels, true, null, null, 1, ref)
const geoL = bandGeometry(fieldI, levels, true, null, null, 1, null)
{
  const worstOf = (geo) => { let w = 0, n = 0; geo.lines.forEach((segs, k) => { for (const sg of segs) for (const p of sg) { const v = tableAt(p[0], p[1]); if (v === v) { w = Math.max(w, Math.abs(v - levels[k])); n++ } } }); return { w, n } }
  const a = worstOf(geoR), b = worstOf(geoL)
  ok(a.n > 1000 && a.w <= 1e-4, `细化后等值线每个顶点在表的插值下恰等于档值（${a.n} 个顶点，最大 |Δ| ${a.w.toExponential(2)} dB）`)
  ok(b.w > 0.05, `同一份数据不细化时差得出来（最大 |Δ| ${b.w.toFixed(3)} dB）——测的不是空话`)
  // 拓扑：各档拼环数一致（细化只挪交点、在弦上加中点，不增删穿越）；线段数只多不少（有弦中点的段一分为二）
  let segLess = 0, loopMis = 0
  for (let k = 0; k < NB; k++) {
    if (geoR.lines[k].length < geoL.lines[k].length) segLess++
    if (stitchLoops(geoR.lines[k]).length !== stitchLoops(geoL.lines[k]).length) loopMis++
  }
  ok(segLess === 0 && loopMis === 0, `各档拼环数与不细化时一致、线段只多不少（少 ${segLess} / 环 ${loopMis} 档不同）`)
  // 填充与线重合：线的每个顶点都是相邻两档填充多边形的顶点（k 档的下边界 = k−1 档的上边界）
  const keyOf = (x, y) => x.toFixed(9) + ',' + y.toFixed(9)
  const vertSets = geoR.fills.map((f) => { const s = new Set(); for (let i = 0; i < f.verts.length; i += 2) s.add(keyOf(f.verts[i], f.verts[i + 1])); return s })
  let missUp = 0, missDn = 0, nV = 0
  geoR.lines.forEach((segs, k) => {
    for (const sg of segs) for (const p of sg) {
      nV++
      const key = keyOf(p[0], p[1])
      if (!vertSets[k].has(key)) missUp++
      if (k > 0 && !vertSets[k - 1].has(key)) missDn++
    }
  })
  ok(nV > 1000 && missUp === 0 && missDn === 0, `线的每个顶点都是本档与下一档填充多边形的顶点（${nV} 个顶点，缺 ${missUp} / ${missDn}）`)
  // 填充多边形上不再有重复顶点（边界穿过顶点时不重复吐）
  let dup = 0
  for (const f of geoR.fills) { let vi = 0; for (let j = 0; j < f.counts.length; j++) { const m = f.counts[j]; for (let q = 0; q < m; q++) { const a = (vi + q) * 2, b = (vi + (q + 1) % m) * 2; if (f.verts[a] === f.verts[b] && f.verts[a + 1] === f.verts[b + 1]) dup++ } vi += m } }
  ok(dup === 0, `填充多边形无零长边（重复顶点 ${dup}）`)
  // 细化只在 stride 1 生效：stride 2 下带不带表逐位一样
  const s2a = bandGeometry(fieldI, levels, true, null, null, 2, ref), s2b = bandGeometry(fieldI, levels, true, null, null, 2, null)
  ok(JSON.stringify(s2a.lines) === JSON.stringify(s2b.lines), 'stride 2 时忽略细化表（线逐位一致）')
}

// ============ ④ 不细化那条路逐位不变（金标准） ============
{
  const g = goldenNow(), want = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'))
  ok(JSON.stringify(g) === JSON.stringify(want), 'bandGeometry 不带细化表：线 / 填充与金标准逐位一致（stride 1/2 × 开关填充）')
}

// ============ ⑤ GPU 网格(refine) ============
{
  const levels32 = Float32Array.from(levels)
  const mesh = { NX, NY, box: null, stride: 1, db: fld.db, vis: visI, lonU: lonI, lat: latI, levels: levels32, refine: ref }
  const mi = buildMeshIndices(mesh)
  const len = N
  ok(mi.extra && mi.extra.n === ref.n + 4 * ref.nm, `GPU 网格带 ${mi.extra ? mi.extra.n : 0} 个细化顶点（= 交点 ${ref.n} + 弦中点 ${ref.nm} + 薄片专属 3×${ref.nm}）`)
  const X = (v) => (v < len ? lonI[v] : mi.extra.lon[v - len]), Y = (v) => (v < len ? latI[v] : mi.extra.lat[v - len]), D = (v) => (v < len ? fld.db[v] : mi.extra.db[v - len])
  // 带纯度：每个三角形三个顶点的 d 能落进同一档
  const bandsOf = (d) => { const out = []; for (let k = 0; k < NB; k++) { const lo = levels32[k], hi = k < NB - 1 ? levels32[k + 1] : Infinity; if (d >= lo && d <= hi) out.push(k) } if (!out.length) out.push(-1); return out }
  let impure = 0, oob = 0, nanV = 0, withExtra = 0, nTri = mi.idx.length / 3
  for (let i = 0; i < mi.idx.length; i += 3) {
    const a = mi.idx[i], b = mi.idx[i + 1], c = mi.idx[i + 2]
    if (a >= len + mi.extra.n || b >= len + mi.extra.n || c >= len + mi.extra.n) { oob++; continue }
    const hasX = a >= len || b >= len || c >= len
    if (!hasX) continue
    withExtra++
    for (const v of [a, b, c]) if (!Number.isFinite(X(v)) || !Number.isFinite(Y(v)) || !Number.isFinite(D(v))) nanV++
    const s = bandsOf(D(a)).filter((k) => bandsOf(D(b)).includes(k) && bandsOf(D(c)).includes(k))
    if (!s.length || s[0] < 0) impure++
  }
  ok(oob === 0 && nanV === 0, `索引不越界、细化顶点属性有限（越界 ${oob}，非有限 ${nanV}）`)
  ok(withExtra > 500 && impure === 0, `引用细化顶点的三角形 ${withExtra} 个，三顶点全在同一档内（不纯 ${impure}）`)
  // CPU 每块填充多边形的质心 → 所在 GPU 三角形 → 线性插值 d 的档 == 该块的档（全量）
  const tris = []
  for (let i = 0; i < mi.idx.length; i += 3) tris.push([mi.idx[i], mi.idx[i + 1], mi.idx[i + 2]])
  // 按格子分桶（三角形的顶点都在一个格子里）
  const buckets = new Map()
  for (const t of tris) {
    const cx = Math.min(X(t[0]), X(t[1]), X(t[2])), cy = Math.min(Y(t[0]), Y(t[1]), Y(t[2]))
    const key = Math.floor(cx + 1e-9) + ',' + Math.floor(cy + 1e-9)
    if (!buckets.has(key)) buckets.set(key, []); buckets.get(key).push(t)
  }
  const bary = (t, px, py) => {
    const x0 = X(t[0]), y0 = Y(t[0]), x1 = X(t[1]), y1 = Y(t[1]), x2 = X(t[2]), y2 = Y(t[2])
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (!d) return null
    const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d, l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d
    return [l0, l1, 1 - l0 - l1]
  }
  const bandOf = (v) => { let k = -1; for (let i = 0; i < NB; i++) { if (levels32[i] <= v) k = i; else break } return k }
  let nPoly = 0, notIn = 0, wrong = 0
  geoR.fills.forEach((f, k) => {
    let vi = 0
    for (let j = 0; j < f.counts.length; j++) {
      const m = f.counts[j]
      // 测试点取首个扇形三角形 (v0,v1,v2) 的重心：带弦中点凹口的多边形是凹的（0 号顶点 = 凹口、以它为扇心的三角形都在多边形内），
      // 顶点平均点可能落到凹口外
      let cx = 0, cy = 0
      for (let q = 0; q < 3; q++) { cx += f.verts[(vi + q) * 2]; cy += f.verts[(vi + q) * 2 + 1] }
      cx /= 3; cy /= 3; vi += m; nPoly++
      const cand = buckets.get(Math.floor(cx) + ',' + Math.floor(cy)) || []
      let hit = null, best = -1e9
      for (const t of cand) { const l = bary(t, cx, cy); if (!l) continue; const mn = Math.min(l[0], l[1], l[2]); if (mn > best) { best = mn; hit = { t, l } } }
      if (!hit || best < -1e-7) { notIn++; return }
      const v = D(hit.t[0]) * hit.l[0] + D(hit.t[1]) * hit.l[1] + D(hit.t[2]) * hit.l[2]
      if (bandOf(v) !== k) wrong++
    }
  })
  ok(nPoly > 1000 && notIn === 0, `CPU 每块填充多边形的质心都在某个 GPU 三角形内（${nPoly} 块，漏 ${notIn}）`)
  ok(wrong === 0, `GPU 在这些质心线性插值出的 dB 落在同一档（错 ${wrong} / ${nPoly}）`)
  // 不带表时索引集合不变（老路逐字）
  const mi0 = buildMeshIndices({ ...mesh, refine: null })
  ok(!mi0.extra && mi0.idx.length > 0, '不带表：无细化顶点、索引照常')
  ok(mi.idx.length > mi0.idx.length, `带表的三角形更多（${nTri} vs ${mi0.idx.length / 3}）——跨档三角形按档扇形化`)
}

// ============ ⑦ 弦中点：在表的插值下恰为档值、在三角形内；线经过它；弦中点误差比只细化交点时明显下降 ============
{
  ok(ref.nm > 100, `弦中点 ${ref.nm} 个`)
  let worst = 0, outside = 0
  const keyOf = (x, y) => x.toFixed(9) + ',' + y.toFixed(9)
  const endCount = new Map()
  geoR.lines.forEach((segs) => { for (const sg of segs) for (const p of sg) { const k = keyOf(p[0], p[1]); endCount.set(k, (endCount.get(k) || 0) + 1) } })
  let notOnLine = 0
  for (let ci = 0; ci < ref.cells.length; ci++) {
    const i00 = ref.cells[ci], c = i00 % NX, r = (i00 / NX) | 0
    for (let q = ref.moff[ci]; q < ref.moff[ci + 1]; q++) {
      const u = ref.mu[q], v = ref.mv[q], isB = ref.mt[q] === 1
      const lA = isB ? 1 - v : 1 - u, lB = isB ? u : u - v, lC = isB ? v - u : v
      if (lA < -1e-6 || lB < -1e-6 || lC < -1e-6) outside++
      worst = Math.max(worst, Math.abs(tableAt(c + u, r + v) - levels[ref.mk[q]]))
      // 恒等投影下 M 的画面坐标 = 三角形三个角（整数格坐标）的重心插值 = (c+u, r+v)
      const x = isB ? (1 - v) * c + u * (c + 1) + (v - u) * c : (1 - u) * c + (u - v) * (c + 1) + v * (c + 1)
      const y = isB ? (1 - v) * r + u * (r + 1) + (v - u) * (r + 1) : (1 - u) * r + (u - v) * r + v * (r + 1)
      if (endCount.get(keyOf(x, y)) !== 2) notOnLine++
    }
  }
  ok(worst <= 1e-4, `弦中点在表的插值下恰等于档值（最大 |Δ| ${worst.toExponential(2)} dB）`)
  ok(outside === 0, `弦中点都在各自三角形内（越界 ${outside}）`)
  ok(notOnLine === 0, `每个弦中点恰是两条线段的端点（线 P–M–Q，不合 ${notOnLine}）`)
  // 只细化交点、不加中点（把表的中点数抹成 0）→ 线段中点的电平误差应明显更大
  const refNoM = { ...ref, nm: 0 }
  const geoE = bandGeometry(fieldI, levels, true, null, null, 1, refNoM)
  const midErr = (geo) => { const e = []; geo.lines.forEach((segs, k) => { for (const sg of segs) { const v = tableAt(0.5 * (sg[0][0] + sg[1][0]), 0.5 * (sg[0][1] + sg[1][1])); if (v === v) e.push(Math.abs(v - levels[k])) } }); e.sort((a, b) => a - b); return { p95: e[Math.floor(0.95 * (e.length - 1))], max: e[e.length - 1] } }
  const eR = midErr(geoR), eE = midErr(geoE)
  ok(eR.p95 < 0.5 * eE.p95, `线段中点电平误差 p95：只细化交点 ${eE.p95.toFixed(4)} → 加弦中点 ${eR.p95.toFixed(4)} dB（max ${eE.max.toFixed(3)} → ${eR.max.toFixed(3)}）`)
}

// ============ ⑧ 带弦中点的填充：CPU 多边形互不重叠；随机点上 CPU 的档 == GPU 三角形（凹口扇形 + 薄片）线性插值的档；覆盖范围一致 ============
{
  const levels32 = Float32Array.from(levels)
  const mesh = { NX, NY, box: null, stride: 1, db: fld.db, vis: visI, lonU: lonI, lat: latI, levels: levels32, refine: ref }
  const mi = buildMeshIndices(mesh)
  const len = N
  ok(mi.extra && mi.extra.n === ref.n + 4 * ref.nm, `GPU 网格细化顶点 = 交点 + 弦中点 + 薄片专属（${mi.extra ? mi.extra.n : 0} = ${ref.n} + 4×${ref.nm}）`)
  const X = (v) => (v < len ? lonI[v] : mi.extra.lon[v - len]), Y = (v) => (v < len ? latI[v] : mi.extra.lat[v - len]), D = (v) => (v < len ? fld.db[v] : mi.extra.db[v - len])
  const bandOf = (v) => { let k = -1; for (let i = 0; i < NB; i++) { if (levels32[i] <= v) k = i; else break } return k }
  const cellKey = (x, y) => Math.floor(x + 1e-9) + ',' + Math.floor(y + 1e-9)
  const triB = new Map()
  for (let i = 0; i < mi.idx.length; i += 3) {
    const t = [mi.idx[i], mi.idx[i + 1], mi.idx[i + 2]]
    const k = cellKey(Math.min(X(t[0]), X(t[1]), X(t[2])), Math.min(Y(t[0]), Y(t[1]), Y(t[2])))
    if (!triB.has(k)) triB.set(k, []); triB.get(k).push(t)
  }
  const polyB = new Map()
  geoR.fills.forEach((f, k) => {
    let vi = 0
    for (let j = 0; j < f.counts.length; j++) {
      const m = f.counts[j], pts = []
      let mx = Infinity, my = Infinity
      for (let q = 0; q < m; q++) { const x = f.verts[(vi + q) * 2], y = f.verts[(vi + q) * 2 + 1]; pts.push([x, y]); if (x < mx) mx = x; if (y < my) my = y }
      vi += m
      const key = cellKey(mx, my)
      if (!polyB.has(key)) polyB.set(key, []); polyB.get(key).push({ k, pts })
    }
  })
  const inPoly = (pts, x, y) => { let inside = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside } return inside }
  const bary = (t, px, py) => { const x0 = X(t[0]), y0 = Y(t[0]), x1 = X(t[1]), y1 = Y(t[1]), x2 = X(t[2]), y2 = Y(t[2]); const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2); if (!d) return null; const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d, l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d; return [l0, l1, 1 - l0 - l1] }
  let seed = 99
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  let tested = 0, dup = 0, bandMis = 0, coverMis = 0, gpuDup = 0, covered = 0
  for (let t = 0; t < 30000; t++) {
    const x = rnd() * (NX - 1), y = rnd() * (NY - 1), key = cellKey(x, y)
    let cpuK = -1, nHit = 0
    for (const p of (polyB.get(key) || [])) if (inPoly(p.pts, x, y)) { nHit++; cpuK = p.k }
    if (nHit > 1) dup++
    let gpuK = -1, gHit = 0
    for (const tr of (triB.get(key) || [])) { const l = bary(tr, x, y); if (l && l[0] >= -1e-9 && l[1] >= -1e-9 && l[2] >= -1e-9) { gHit++; gpuK = bandOf(D(tr[0]) * l[0] + D(tr[1]) * l[1] + D(tr[2]) * l[2]) } }
    if (gHit > 1) gpuDup++
    tested++
    if ((cpuK >= 0) !== (gpuK >= 0)) { coverMis++; continue }
    if (cpuK >= 0) { covered++; if (cpuK !== gpuK) bandMis++ }
  }
  ok(covered > 1500, `随机点 ${tested} 个，落在填充里的 ${covered} 个`)
  ok(dup === 0, `CPU 填充多边形互不重叠（同一点落进两块 ${dup}）`)
  ok(gpuDup === 0, `GPU 三角形互不重叠（${gpuDup}）`)
  ok(coverMis === 0, `CPU 填充与 GPU 三角形覆盖范围逐点一致（不一致 ${coverMis}）`)
  ok(bandMis === 0, `CPU 多边形的档与 GPU 线性插值的档逐点一致（不一致 ${bandMis}）`)
}

// ============ ⑨ 峰值基准：coverage.refinedPeakDb ≡ 性能指标表原公式；peakRefDb 口径 ============
{
  const oldRefined = (b, pol) => {
    const { P1, P2, grid } = b, NXb = grid.NX, NYb = grid.NY, Nb = NXb * NYb
    const pw = (i) => { const a = P1[i], bb = P2 ? P2[i] : 0; return pol === 'P1' ? a : pol === 'P2' ? bb : pol === 'RSS' ? a + bb : pol === 'P1/P2' ? (bb > 0 ? a / bb : 0) : pol === 'P2/P1' ? (a > 0 ? bb / a : 0) : a }
    let mi = 0, mv = -Infinity
    for (let i = 0; i < Nb; i++) { const v = pw(i); if (v > mv) { mv = v; mi = i } }
    if (!(mv > 0)) return null
    const r = (mi / NXb) | 0, c = mi % NXb
    const inc = (fm, f0, fp) => { const den = 2 * f0 - fm - fp; return den > 0 ? (fp - fm) * (fp - fm) / (8 * den) : 0 }
    let peak = mv
    if (c > 0 && c < NXb - 1) peak += inc(pw(mi - 1), mv, pw(mi + 1))
    if (r > 0 && r < NYb - 1) peak += inc(pw(mi - NXb), mv, pw(mi + NXb))
    return peak > 0 ? 10 * Math.log10(peak) : null
  }
  const b2 = { P1: set.P1, P2: set.P2, grid: beam.grid }
  let mis = 0
  for (const pol of ['RSS', 'P1', 'P2', 'P1/P2', 'P2/P1']) if (refinedPeakDb(b2, pol) !== oldRefined(b2, pol)) mis++
  ok(mis === 0, 'refinedPeakDb 与性能指标表原公式逐位一致（五种极化）')
  const pk = refinedPeakDb(b2, 'RSS')
  ok(pk >= fld.max && pk - fld.max < 0.5, `细化峰值 ≥ 节点峰值（高 ${(pk - fld.max).toFixed(4)} dB）`)
  ok(peakRefDb(b2, fld, 'RSS', 2.5, 'none') === pk + 2.5, '无路损：峰值基准 = 细化峰值 + 增益偏置')
  ok(peakRefDb(b2, fld, 'RSS', 2.5, 'relative') === fld.max, '有路损：峰值基准 = 场的节点最大值')
}

// ============ ⑩ 掠地格子的精确位置：真实 GEO 几何下，低仰角顶点经表的整条取值链反读仍等于档值 ============
{
  // 网格用 0.2°/格（真实文件是 0.05~0.1°）：30° 仰角以上不做逐点求交、按投影经纬度插值，其误差随格距平方走，
  // 0.4° 的合成格会把这一项放大到 0.02 dB 量级，不是几何解算的问题
  const SAT_LON = 110.5, SAT_ALT = 35786.06
  const setF = makeSet(121, 121, 12), NXF = setF.NX, NYF = setF.NY
  const beamF = { P1: setF.P1, P2: setF.P2, c1re: setF.c1re, c1im: setF.c1im, c2re: setF.c2re, c2im: setF.c2im, grid: { XS: setF.XS, YS: setF.YS, XE: setF.XE, YE: setF.YE, NX: NXF, NY: NYF } }
  const basis = antennaBasis(SAT_LON, SAT_LON, 0, 0, 0, SAT_ALT)
  const proj = projectGrid(setF, 4, basis, null, null, true)
  const fldG = fieldDb(setF, proj, { pol: 'RSS' })
  const levelsF = levels.map((L) => L - fld.max + fldG.max)
  const ref2 = buildEdgeRefine(beamF, fldG, levelsF, { pol: 'RSS', gainOffset: 0 })
  const pos = projectRefine(ref2, beamF.grid, 4, basis, proj)
  ok(pos.exact > 50, `掠地格子里逐点求交的顶点 ${pos.exact} 个`)
  const fG = { lon: proj.lon, lat: proj.lat, vis: proj.vis, db: fldG.db, NX: NXF, NY: NYF }
  const gP = bandGeometry(fG, levelsF, false, null, null, 1, ref2, pos), gN = bandGeometry(fG, levelsF, false, null, null, 1, ref2, null)
  const satE = geodeticToEcef(SAT_LON, 0, SAT_ALT)
  const errs = (geo) => { const lo = [], hi = []; geo.lines.forEach((segs, k) => { for (const sg of segs) for (const p of sg) { const r = sampleBeamAt(beamF, 4, basis, p[0], p[1], { pol: 'RSS' }); if (!r) continue; const e = Math.abs(r.db - levelsF[k]); (elevationDeg(p[0], p[1], satE) < 30 ? lo : hi).push(e) } }); lo.sort((a, b) => a - b); hi.sort((a, b) => a - b); return { lo, hi } }
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))]
  const eP = errs(gP), eN = errs(gN)
  // 地平端点求根（limbEnd）不许出 NaN：09-16 审查发现 limbSolve 的共享暂存被探测覆盖，探到 dir=−1 的端点试位除零变 NaN。
  // errs() 用 sampleBeamAt 反读，NaN 顶点返回 null 会被静默跳过 —— 故单独数一遍非有限顶点，并另用触到地平更多的深档再验一次。
  const nanOf = (geo) => { let n = 0; geo.lines.forEach((segs) => { for (const sg of segs) for (const p of sg) if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) n++ }); return n }
  const cntOf = (geo) => { let n = 0; geo.lines.forEach((segs) => { for (const sg of segs) n += sg.length }); return n }
  ok(nanOf(gP) === 0 && nanOf(gN) === 0, `地平端点求根不出 NaN 顶点（带 pos ${nanOf(gP)} / 不带 ${nanOf(gN)}，共 ${cntOf(gP)}）`)
  const deep = [40, 35, 30, 25, 20, 15, 10, 6, 3].map((d) => fldG.max - d).sort((a, b) => a - b)
  const refD = buildEdgeRefine(beamF, fldG, deep, { pol: 'RSS', gainOffset: 0 }), posD = projectRefine(refD, beamF.grid, 4, basis, proj)
  const gD = bandGeometry(fG, deep, false, null, null, 1, refD, posD)
  ok(cntOf(gD) > 5000 && nanOf(gD) === 0, `深档（到 −40 dB）地平端点求根不出 NaN 顶点（${nanOf(gD)} / ${cntOf(gD)}；修前 14）`)
  ok(eP.lo.length > 100, `30° 仰角以下的线顶点 ${eP.lo.length} 个`)
  ok(q(eP.lo, 0.95) <= 0.01 && q(eP.lo, 1) <= 0.05, `低仰角顶点经表反读 |Δ| p95 ${q(eP.lo, 0.95).toFixed(4)} / max ${q(eP.lo, 1).toFixed(4)} dB（插值时 p95 ${q(eN.lo, 0.95).toFixed(4)} / max ${q(eN.lo, 1).toFixed(4)}）`)
  ok(q(eP.hi, 0.95) <= 0.01, `高仰角顶点 |Δ| p95 ${q(eP.hi, 0.95).toFixed(4)} dB`)
}

// ============ ⑥ 真实 GRD（本机若有） ============
{
  const file = 'C:/Users/85256/AppData/Roaming/satellite-sim-platform/coverage-grd-imported/CS26GT_OK1_.grd'
  if (existsSync(file)) {
    const { parseGrd } = await import('../../../src/viz/grd/parse.js')
    const g = parseGrd(readFileSync(file, 'utf8'))
    const s0 = g.sets[0]
    const b0 = { P1: s0.P1, P2: s0.P2, c1re: s0.c1re, c1im: s0.c1im, c2re: s0.c2re, c2im: s0.c2im, grid: { XS: s0.XS, YS: s0.YS, XE: s0.XE, YE: s0.YE, NX: s0.NX, NY: s0.NY } }
    const f0 = fieldDb(s0, null, { pol: 'RSS' })
    const lv = Array.from({ length: 12 }, (_, i) => f0.max - 12 + i)
    const t0 = now(); const rf = buildEdgeRefine(b0, f0, lv, { pol: 'RSS', gainOffset: 0 }); const tRef = now() - t0
    const n0 = s0.NX * s0.NY, lo = new Float32Array(n0), la = new Float32Array(n0), vs = new Float32Array(n0).fill(1)
    for (let r = 0; r < s0.NY; r++) for (let c = 0; c < s0.NX; c++) { lo[r * s0.NX + c] = c; la[r * s0.NX + c] = r }
    const fi = { lon: lo, lat: la, vis: vs, db: f0.db, NX: s0.NX, NY: s0.NY }
    const t1 = now(); const gR = bandGeometry(fi, lv, true, null, null, 1, rf); const tR = now() - t1
    const t2 = now(); bandGeometry(fi, lv, true, null, null, 1, null); const tL = now() - t2
    const dxr = (s0.XE - s0.XS) / (s0.NX - 1), dyr = (s0.YE - s0.YS) / (s0.NY - 1)
    let w = 0, nv = 0
    gR.lines.forEach((segs, k) => { for (const sg of segs) for (const p of sg) { const r = sampleBeamAtParam(b0, [s0.XS + p[0] * dxr, s0.YS + p[1] * dyr], 1, { pol: 'RSS' }); if (r) { w = Math.max(w, Math.abs(r.db - lv[k])); nv++ } } })
    ok(nv > 100 && w <= 1e-4, `真实 0.1° GRD 首波束：线上 ${nv} 个顶点 |Δ| ≤ 1e-4 dB（最大 ${w.toExponential(2)}）`)
    console.log(`  [真实 GRD] 细化表 ${rf.n} 条 ${tRef.toFixed(1)} ms · bandGeometry 带表 ${tR.toFixed(1)} ms / 不带 ${tL.toFixed(1)} ms`)
  } else console.log('  [真实 GRD] 本机无样例文件，跳过 ⑥')
}

console.log(`edgeRefine.test.mjs：${pass} 条断言全绿`)
