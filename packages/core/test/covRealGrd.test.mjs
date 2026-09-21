// 真实 GRD 上的覆盖分析回归（本机有文件才跑，否则整份跳过）。四组统计来自 .covharness 的离线复现台：
//   ① 拼链：开口链恰一条折线（链数 = 闭合环数 + 度 1 端点数 / 2），碎片数对老实现的降幅
//   ② 转角：折线在顶点处的转角分布（> 8° 占比 = 「放大后像多边形」的量化口径）—— 只报告
//   ③ 贴合：线顶点是否落在填充边界上（近地平跨地平格子）—— 只报告；断言的是「线不随填充的地平裁法变」
//   ④ 与 SATSOFT 线的距离：Whittaker Interpolation Density = 1（关），即原网格上的线性 marching squares
//   ⑤ 密度 5：本平台派生波束（whittaker.js 周期 sinc 上采样）与 DFT 零填充复现逐点一致；细网格线与 SATSOFT 同密度线的距离
// 2026-09-22 等值线 / 填充画法回退到 v1.4.11（弦中点 P–M–Q、地平走 clipToHull）后，②③ 的弧点 / 贴合阈值失去对象，
// 改为报告；④ 的对比基准按用户定的密度 1。口径出自《覆盖分析五项修复与等值线终极优化任务书_2026-09-21.md》。
// 运行：npm test
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { parseGrd } from '../../../src/viz/grd/parse.js'
import { fieldDb, bandGeometry, buildEdgeRefine, peakRefDb, stitchLoops, antennaBasis, projectGrid, projectRefine } from '../../../src/viz/grd/coverage.js'
import { geodeticToEcef, elevationDeg, isoElevationContourAt } from '../../../src/viz/wgs84.js'
import { whittakerBeam } from '../../../src/viz/grd/whittaker.js'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const IMP = 'C:/Users/85256/AppData/Roaming/satellite-sim-platform/coverage-grd-imported/'
const FILES = [
  { tag: 'CS-6C 单波束', name: 'CS-6C-DB100V-EIRP-4.1_84-CRHR4__011BT13BCDVP00-EIRP_-x-Payload.grd', set: 0, rels: [-1, -2, -3, -4, -5, -6, -7, -8, -9, -10, -11, -12] },
  { tag: '300_X02G', name: '300_X02G_EIRP.grd', set: 0, rels: [-1, -2, -3, -4, -6, -8, -10, -12] },
  { tag: 'CS26GT HTS', name: 'CS26GT_OK1_.grd', set: 0, rels: [-1, -2, -3, -4, -6, -10, -15] }
]
const have = FILES.filter((f) => existsSync(IMP + f.name))
if (!have.length) { console.log('covRealGrd.test.mjs：本机无样例 GRD，整份跳过'); process.exit(0) }

const key = (p) => Math.round(p[0] * 20000) + ',' + Math.round(p[1] * 20000)
const isClosed = (l) => l.length > 2 && key(l[0]) === key(l[l.length - 1])
// 老实现：只从 s[1] 向前走，走到断头就停（09-21 前的 stitchLoops）——留作碎片数基准
function stitchFwdOnly(segs) {
  if (!segs || !segs.length) return []
  const ends = new Map()
  segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i) } })
  const used = new Array(segs.length).fill(false), loops = []
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue
    used[i] = true
    const loop = [segs[i][0], segs[i][1]]
    let curK = key(segs[i][1]); const startK = key(segs[i][0])
    for (let g = 0; g < segs.length; g++) {
      let nj = -1
      for (const j of (ends.get(curK) || [])) { if (!used[j]) { nj = j; break } }
      if (nj < 0) break
      used[nj] = true
      const s = segs[nj], next = key(s[0]) === curK ? s[1] : s[0]
      loop.push(next); curK = key(next)
      if (curK === startK) break
    }
    loops.push(loop)
  }
  return loops
}

// 一份文件 → 格坐标域的场（恒等投影：lon = 列号、lat = 行号，全可见）+ 档 + 细化表
function loadCase(f) {
  const g = parseGrd(readFileSync(IMP + f.name, 'utf8'))
  const s = g.sets[f.set], NX = s.NX, NY = s.NY
  const beam = { P1: s.P1, P2: s.P2, c1re: s.c1re, c1im: s.c1im, c2re: s.c2re, c2im: s.c2im, grid: { XS: s.XS, YS: s.YS, XE: s.XE, YE: s.YE, NX, NY } }
  const field = fieldDb({ P1: s.P1, P2: s.P2, NX, NY }, null, { pol: 'RSS' })
  const peak = peakRefDb(beam, field, 'RSS', 0, 'none')
  const levels = f.rels.map((r) => peak + r).sort((a, b) => a - b)
  const n0 = NX * NY, lon = new Float32Array(n0), lat = new Float32Array(n0), vis = new Float32Array(n0).fill(1)
  for (let r = 0; r < NY; r++) for (let c = 0; c < NX; c++) { lon[r * NX + c] = c; lat[r * NX + c] = r }
  const refine = buildEdgeRefine(beam, field, levels, { pol: 'RSS', gainOffset: 0 })
  return { set: s, igrid: g.igrid, beam, field, peak, levels, NX, NY, gridField: { lon, lat, vis, db: field.db, NX, NY }, refine }
}

// ============ ① 拼链（对应任务书 §1）============
{
  console.log('  ① 拼链：档 | 度1端点 / 闭合 | 老(只向前) 段数·标签 | 新(双向) 链数·标签')
  let bad = 0, fwdAll = 0, newAll = 0, labOld = 0, labNew = 0, openAll = 0
  for (const f of have) {
    const c = loadCase(f)
    // 热区盒模拟真机上被地平 / 热区盒切断的开口链
    const box = { r0: 20, r1: c.NY - 21, c0: 20, c1: c.NX - 21 }
    const geo = bandGeometry(c.gridField, c.levels, false, box, null, 1, c.refine, null)
    let fo = 0, ne = 0, lo = 0, ln = 0, op = 0
    for (let k = 0; k < c.levels.length; k++) {
      const segs = geo.lines[k]; if (!segs.length) continue
      const deg = new Map(); for (const sg of segs) for (const p of sg) { const kk = key(p); deg.set(kk, (deg.get(kk) || 0) + 1) }
      let e1 = 0, junc = 0; for (const d of deg.values()) { if (d === 1) e1++; if (d >= 3) junc++ }
      const chains = stitchLoops(segs), closed = chains.filter(isClosed).length
      if (!junc && chains.length !== closed + e1 / 2) bad++
      if (!junc && chains.reduce((a, l) => a + l.length - 1, 0) !== segs.length) bad++
      const old = stitchFwdOnly(segs)
      fo += old.length; ne += chains.length; op += e1 / 2
      lo += old.filter((l) => l.length >= 4).length; ln += chains.filter((l) => l.length >= 4).length
    }
    console.log(`     ${f.tag}：开口链 ${op} | 老 ${fo} 段 / ${lo} 标签 → 新 ${ne} 链 / ${ln} 标签`)
    fwdAll += fo; newAll += ne; labOld += lo; labNew += ln; openAll += op
  }
  ok(bad === 0, `真 GRD 逐档：链数 = 闭合环数 + 度 1 端点数 / 2，且每条线段恰属一条链（${bad} 档不符）`)
  ok(openAll > 10 && newAll * 3 < fwdAll, `开口链不再剥成碎片：${fwdAll} 段 → ${newAll} 链（标签 ${labOld} → ${labNew}）`)
}

// ============ ③ 近地平贴合（对应任务书 §3）============
// 线顶点必须落在本档或下一档填充多边形的顶点集里；不在就量到填充【边】的最近距离（km）。
// 两条 CPU 路都测：hull（3D / 导出，外缘走平滑地平弧）与无 hull（2D CPU）。
{
  const wrap180 = (x) => ((x % 360) + 540) % 360 - 180
  const convexHullCCW = (pts) => {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const crs = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    const lo = []; for (const q of p) { while (lo.length >= 2 && crs(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q) }
    const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && crs(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q) }
    lo.pop(); up.pop(); return lo.concat(up)
  }
  const keyF = (x, y) => Math.round(x * 20000) + ',' + Math.round(y * 20000)
  const sx = (lat) => Math.cos(lat * Math.PI / 180)
  const segDist = (p, a, b) => {
    const ax = a[0], ay = a[1], dx = (b[0] - ax) * sx(p[1]), dy = b[1] - ay, px = (p[0] - ax) * sx(p[1]), py = p[1] - ay
    const l2 = dx * dx + dy * dy; let t = l2 > 0 ? (px * dx + py * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t
    return Math.hypot(px - dx * t, py - dy * t)
  }
  const SAT_LON = 130, SAT_ALT = 35786
  console.log('  ③ 贴合：线顶点不在填充顶点集的个数（地平端点 / 内部）与到填充边的距离')
  let worstOff = 0, worstGap = 0, vertsAll = 0, totHull = 0, totNoHull = 0
  for (const f of have) {
    const c = loadCase(f)
    const basis = antennaBasis(SAT_LON, SAT_LON, 0, 0, 0, SAT_ALT)
    const box = { r0: 0, r1: c.NY - 1, c0: 0, c1: c.NX - 1 }
    const proj = projectGrid(c.set, c.igrid, basis, box, null, true)
    const field = fieldDb(c.set, proj, { pol: 'RSS' })
    const levels = f.rels.map((r) => c.peak + r).sort((a, b) => a - b)
    const refine = buildEdgeRefine(c.beam, c.field, levels, { pol: 'RSS', gainOffset: 0 })
    const pos = projectRefine(refine, c.beam.grid, c.igrid, basis, proj, null)
    const arc = isoElevationContourAt(geodeticToEcef(SAT_LON, 0, SAT_ALT), 0, 240)
    const ring = convexHullCCW(arc.map((p) => [wrap180(p[0] - SAT_LON), p[1]]))
    const fa = { lon: proj.lon, lat: proj.lat, vis: proj.vis, db: field.db, NX: c.NX, NY: c.NY }
    const satE = geodeticToEcef(SAT_LON, 0, SAT_ALT)
    for (const [name, hull] of [['hull(3D/导出)', { ring, satLon: SAT_LON }], ['无 hull(2D CPU)', null]]) {
      const geo = bandGeometry(fa, levels, true, box, hull, 1, refine, pos)
      const sets = geo.fills.map((ff) => { const S = new Set(); for (let i = 0; i < ff.verts.length; i += 2) S.add(keyF(ff.verts[i], ff.verts[i + 1])); return S })
      const edgesOf = (k) => {
        const out = [], v = geo.fills[k].verts, cn = geo.fills[k].counts; let vi = 0
        for (let j = 0; j < cn.length; j++) { const n = cn[j]; for (let t = 0; t < n; t++) out.push([[v[(vi + t) * 2], v[(vi + t) * 2 + 1]], [v[(vi + (t + 1) % n) * 2], v[(vi + (t + 1) % n) * 2 + 1]]]); vi += n }
        return out
      }
      const cache = new Map()
      let tot = 0, offLimb = 0, offIn = 0, gapMax = 0
      for (let k = 0; k < levels.length; k++) {
        for (const sg of geo.lines[k]) for (const p of sg) {
          tot++
          const kk = keyF(p[0], p[1])
          if (sets[k].has(kk) || (k > 0 && sets[k - 1].has(kk))) continue
          const el = elevationDeg(p[0], p[1], satE)
          if (Math.abs(el) < 0.05) offLimb++; else offIn++
          let best = Infinity
          for (const kb of [k, k - 1]) {
            if (kb < 0) continue
            if (!cache.has(kb)) cache.set(kb, edgesOf(kb))
            for (const [a, b] of cache.get(kb)) { const d = segDist(p, a, b); if (d < best) best = d }
          }
          if (best * 111 > gapMax) gapMax = best * 111
        }
      }
      console.log(`     ${f.tag} · ${name}：线顶点 ${tot}，不在填充顶点集 地平 ${offLimb} / 内部 ${offIn}，最大间隙 ${gapMax ? gapMax.toFixed(2) + ' km' : '—'}`)
      vertsAll += tot; if (hull) totHull += tot; else totNoHull += tot
      worstOff = Math.max(worstOff, offLimb + offIn); worstGap = Math.max(worstGap, gapMax)
    }
  }
  ok(vertsAll > 1000 && totHull === totNoHull, `近地平：${vertsAll} 个线顶点，hull 路与无 hull 路的线同数（线不随填充的地平裁法变）；不在填充顶点集最坏 ${worstOff} 个、最大间隙 ${worstGap.toFixed(2)} km —— v1.4.11 画法的已知口径，只报告`)
}

// ============ ② 转角（对应任务书 §2）============
// 折线在顶点处的转角分布：「放大后像多边形」的量化口径（与缩放无关，只看转角）。
// 三条线逐档比：旧路（不细化）/ 只插弦中点 / 自适应弧点（现行）。
{
  const ang = (a, b, c) => {
    const ax = b[0] - a[0], ay = b[1] - a[1], bx = c[0] - b[0], by = c[1] - b[1]
    const na = Math.hypot(ax, ay), nb = Math.hypot(bx, by)
    if (!(na > 0 && nb > 0)) return 0
    return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (na * nb)))) * 180 / Math.PI
  }
  const q = (a, f) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(f * s.length))] }
  console.log('  ② 转角：档组 | 旧路(不细化) p95 / >8° | 现行(弦中点 P–M–Q) p95 / >8° / 顶点')
  const GRP = [['峰附近 −1~−3 dB', -3.5, 0], ['中间档 −4~−10 dB', -10.5, -3.5], ['副瓣 −12~−20 dB', -99, -10.5]]
  let worstP95 = 0, worstGt8 = 0, better = 0, total = 0
  for (const f of have) {
    const c = loadCase({ ...f, rels: [-1, -2, -3, -4, -6, -8, -10, -12, -15, -20] })
    const geoR = bandGeometry(c.gridField, c.levels, false, null, null, 1, c.refine, null)
    const geoL = bandGeometry(c.gridField, c.levels, false, null, null, 1, null, null)
    console.log(`     ${f.tag}`)
    GRP.forEach(([lab, lo, hi]) => {
      const A = [], B = []; let nv = 0
      c.levels.forEach((L, k) => {
        const rel = L - c.peak; if (!(rel > lo && rel <= hi)) return
        for (const ch of stitchLoops(geoR.lines[k])) { nv += ch.length; for (let i = 1; i < ch.length - 1; i++) A.push(ang(ch[i - 1], ch[i], ch[i + 1])) }
        for (const ch of stitchLoops(geoL.lines[k])) for (let i = 1; i < ch.length - 1; i++) B.push(ang(ch[i - 1], ch[i], ch[i + 1]))
      })
      if (!A.length) return
      const gA = 100 * A.filter((x) => x > 8).length / A.length, gB = 100 * B.filter((x) => x > 8).length / B.length
      console.log(`       ${lab}：旧路 ${q(B, 0.95).toFixed(1)}° / ${gB.toFixed(1)}%  →  现行 ${q(A, 0.95).toFixed(1)}° / ${gA.toFixed(1)}% / ${nv} 顶点`)
      total++; if (gA <= gB) better++
      worstP95 = Math.max(worstP95, q(A, 0.95)); worstGt8 = Math.max(worstGt8, gA)
    })
  }
  ok(total >= 6, `转角分布只报告（画法已回退到 v1.4.11 的弦中点）：${total} 个档组，> 8° 占比不高于旧路的 ${better} 个，最差 p95 ${worstP95.toFixed(1)}°、> 8° 占比 ${worstGt8.toFixed(1)}%`)
}

// ============ ④ 与 SATSOFT 线的距离（对应任务书 §2.5 因素 C）============
// 复现 SATSOFT §11.1：Whittaker Interpolation Density = N 时四个复场分量各自 FFT 零填充 ×N 的 Whittaker 重建 → RSS 功率 dB
// → N 倍细网格线性 marching squares。N = 1 即手册所说的「关」：SATSOFT 直接在原网格上做线性 marching squares，
// 2026-08-22 用户实测该档与本平台一致，2026-09-22 定为对比基准。与本平台线逐点比距离。只跑一份文件。
{
  const N5 = 1   // SATSOFT Whittaker Interpolation Density（1 = 关）
  // 实序列 → DFT → 零填充 → 逆变换（可分离直接求和；N 与网格尺寸无关）
  const whittaker2D = (x, NX, NY, N) => {
    const W = N * NX, H = N * NY
    const Ar = new Float64Array(NX * NY), Ai = new Float64Array(NX * NY)
    const cx = new Float64Array(NX * NX), sx2 = new Float64Array(NX * NX)
    for (let c = 0; c < NX; c++) for (let k = 0; k < NX; k++) { const a = -2 * Math.PI * c * k / NX; cx[c * NX + k] = Math.cos(a); sx2[c * NX + k] = Math.sin(a) }
    for (let r = 0; r < NY; r++) {
      const rb = r * NX
      for (let k = 0; k < NX; k++) { let re = 0, im = 0; for (let c = 0; c < NX; c++) { const v = x[rb + c]; re += v * cx[c * NX + k]; im += v * sx2[c * NX + k] } Ar[rb + k] = re; Ai[rb + k] = im }
    }
    const Br = new Float64Array(NX * NY), Bi = new Float64Array(NX * NY)
    const cy = new Float64Array(NY * NY), sy = new Float64Array(NY * NY)
    for (let r = 0; r < NY; r++) for (let l = 0; l < NY; l++) { const a = -2 * Math.PI * r * l / NY; cy[r * NY + l] = Math.cos(a); sy[r * NY + l] = Math.sin(a) }
    for (let k = 0; k < NX; k++) for (let l = 0; l < NY; l++) {
      let re = 0, im = 0
      for (let r = 0; r < NY; r++) { const ar = Ar[r * NX + k], ai = Ai[r * NX + k], cc = cy[r * NY + l], ss = sy[r * NY + l]; re += ar * cc - ai * ss; im += ar * ss + ai * cc }
      Br[l * NX + k] = re; Bi[l * NX + k] = im
    }
    const freqs = (M) => { const fr = new Float64Array(M), w = new Float64Array(M); for (let l = 0; l < M; l++) { if (l < M / 2) { fr[l] = l; w[l] = 1 } else if (l === M / 2) { fr[l] = l; w[l] = 0.5 } else { fr[l] = l - M; w[l] = 1 } } return { f: fr, w } }
    const FY = freqs(NY), FX = freqs(NX)
    const Cr = new Float64Array(NX * H), Ci = new Float64Array(NX * H)
    const icy = new Float64Array(NY * H), isy = new Float64Array(NY * H)
    for (let l = 0; l < NY; l++) for (let m = 0; m < H; m++) { const a = 2 * Math.PI * FY.f[l] * m / H; icy[l * H + m] = Math.cos(a); isy[l * H + m] = Math.sin(a) * (FY.w[l] < 1 ? 0 : 1) }
    for (let k = 0; k < NX; k++) for (let m = 0; m < H; m++) {
      let re = 0, im = 0
      for (let l = 0; l < NY; l++) { const br = Br[l * NX + k], bi = Bi[l * NX + k], cc = icy[l * H + m], ss = isy[l * H + m]; re += br * cc - bi * ss; im += br * ss + bi * cc }
      Cr[m * NX + k] = re / NY; Ci[m * NX + k] = im / NY
    }
    const out = new Float32Array(W * H)
    const icx = new Float64Array(NX * W), isx = new Float64Array(NX * W)
    for (let k = 0; k < NX; k++) for (let n2 = 0; n2 < W; n2++) { const a = 2 * Math.PI * FX.f[k] * n2 / W; icx[k * W + n2] = Math.cos(a); isx[k * W + n2] = Math.sin(a) * (FX.w[k] < 1 ? 0 : 1) }
    for (let m = 0; m < H; m++) {
      const mb = m * NX, ob = m * W
      for (let n2 = 0; n2 < W; n2++) { let re = 0; for (let k = 0; k < NX; k++) re += Cr[mb + k] * icx[k * W + n2] - Ci[mb + k] * isx[k * W + n2]; out[ob + n2] = re / NX }
    }
    return out
  }
  // 细网格线性 marching squares（标准 16 例，两处二义按中心均值）
  const marching = (d, W, H, L) => {
    const segs = []
    for (let j = 0; j < H - 1; j++) {
      const r0 = j * W, r1 = r0 + W
      for (let i = 0; i < W - 1; i++) {
        const v00 = d[r0 + i], v10 = d[r0 + i + 1], v01 = d[r1 + i], v11 = d[r1 + i + 1]
        if (v00 !== v00 || v10 !== v10 || v01 !== v01 || v11 !== v11) continue
        if (Math.max(v00, v10, v01, v11) < L || Math.min(v00, v10, v01, v11) >= L) continue
        const code = (v00 >= L ? 1 : 0) | (v10 >= L ? 2 : 0) | (v11 >= L ? 4 : 0) | (v01 >= L ? 8 : 0)
        const pB = [i + (L - v00) / (v10 - v00), j], pR = [i + 1, j + (L - v10) / (v11 - v10)]
        const pT = [i + (L - v01) / (v11 - v01), j + 1], pL = [i, j + (L - v00) / (v01 - v00)]
        switch (code) {
          case 1: case 14: segs.push([pL, pB]); break
          case 2: case 13: segs.push([pB, pR]); break
          case 3: case 12: segs.push([pL, pR]); break
          case 4: case 11: segs.push([pR, pT]); break
          case 6: case 9: segs.push([pB, pT]); break
          case 7: case 8: segs.push([pL, pT]); break
          case 5: { const cc = 0.25 * (v00 + v10 + v01 + v11); if (cc >= L) { segs.push([pT, pL]); segs.push([pB, pR]) } else { segs.push([pL, pB]); segs.push([pR, pT]) } break }
          case 10: { const cc = 0.25 * (v00 + v10 + v01 + v11); if (cc >= L) { segs.push([pL, pB]); segs.push([pR, pT]) } else { segs.push([pB, pR]); segs.push([pT, pL]) } break }
        }
      }
    }
    return segs
  }
  const f = have.find((x) => x.name.startsWith('CS-6C'))
  if (!f) { console.log('  ④ 与 SATSOFT 线的距离：本机无 CS-6C 样例，跳过') } else {
    const c = loadCase({ ...f, rels: [-1, -3, -6, -10] })
    const s = c.set, NX = c.NX, NY = c.NY, W = N5 * NX, H = N5 * NY
    const t0 = Date.now()
    let dS
    if (N5 === 1) dS = c.field.db   // 密度 1 = 不重建：原网格节点上的 RSS 功率 dB 直接做 marching squares
    else {
      const f1r = whittaker2D(s.c1re, NX, NY, N5), f1i = whittaker2D(s.c1im, NX, NY, N5)
      const f2r = whittaker2D(s.c2re, NX, NY, N5), f2i = whittaker2D(s.c2im, NX, NY, N5)
      dS = new Float32Array(W * H)
      for (let i = 0; i < W * H; i++) { const P = f1r[i] * f1r[i] + f1i[i] * f1i[i] + f2r[i] * f2r[i] + f2i[i] * f2i[i]; dS[i] = P > 0 ? 10 * Math.log10(P) : NaN }
      // 节点处 sinc 重建应逐点等于原场（插值型）
      let nodeErr = 0
      for (let r = 0; r < NY; r++) for (let cc = 0; cc < NX; cc++) { const v = c.field.db[r * NX + cc]; if (v === v) nodeErr = Math.max(nodeErr, Math.abs(dS[(r * N5) * W + cc * N5] - v)) }
      ok(nodeErr < 1e-3, `Whittaker 密度 ${N5} 重建在网格节点上复现原场（最大 |Δ| ${nodeErr.toExponential(1)} dB）`)
    }
    const geo = bandGeometry(c.gridField, c.levels, false, null, null, 1, c.refine, null)
    const dAll = []
    for (let k = 0; k < c.levels.length; k++) {
      const segS = marching(dS, W, H, c.levels[k]).map((sg) => [[sg[0][0] / N5, sg[0][1] / N5], [sg[1][0] / N5, sg[1][1] / N5]])
      if (!segS.length) continue
      // 空间桶：点到 SATSOFT 折线的最近距离（格）
      const bucket = new Map()
      const put = (kk, i) => { let a = bucket.get(kk); if (!a) { a = []; bucket.set(kk, a) } a.push(i) }
      segS.forEach((sg, i) => {
        const x0 = Math.floor(Math.min(sg[0][0], sg[1][0])), x1 = Math.floor(Math.max(sg[0][0], sg[1][0]))
        const y0 = Math.floor(Math.min(sg[0][1], sg[1][1])), y1 = Math.floor(Math.max(sg[0][1], sg[1][1]))
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(x + ',' + y, i)
      })
      const dseg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) }
      for (const sg of geo.lines[k]) for (const p of sg) {
        const cx2 = Math.floor(p[0]), cy2 = Math.floor(p[1])
        let best = Infinity
        for (let rad = 1; rad <= 4 && !(best < rad - 0.5); rad++) {
          for (let x = cx2 - rad; x <= cx2 + rad; x++) for (let y = cy2 - rad; y <= cy2 + rad; y++) {
            const a = bucket.get(x + ',' + y); if (!a) continue
            for (const i of a) { const d = dseg(p, segS[i][0], segS[i][1]); if (d < best) best = d }
          }
        }
        if (best < Infinity) dAll.push(best)
      }
    }
    const qq = (a, fr) => { const s2 = Float64Array.from(a).sort(); return s2[Math.min(s2.length - 1, Math.floor(fr * s2.length))] }
    const p50 = qq(dAll, 0.5), p95 = qq(dAll, 0.95), mx = Math.max(...dAll)
    console.log(`  ④ 与 SATSOFT（Whittaker 密度 ${N5}）线的距离：${dAll.length} 个顶点 p50/p95/max = ${p50.toFixed(4)}/${p95.toFixed(4)}/${mx.toFixed(3)} 格（重建 ${((Date.now() - t0) / 1000).toFixed(1)} s）`)
    ok(dAll.length > 1000 && p50 <= 0.06 && p95 <= 0.35, `本平台线与 SATSOFT 线的距离 p50 ≤ 0.06 格、p95 ≤ 0.35 格（剩余差来自插值核 sinc vs bicubic）`)
  }
  // ============ ⑤ 密度 5（对应 2026-09-22「Whittaker 密度可调」）============
  // 两边都是「复场周期 sinc 上采样 5 倍 → 细网格线性 marching」：本平台走派生波束 + 三角形线性（无细化表），
  // 复现走 DFT 零填充 + 方格 marching squares，差别只剩同一方格内三角形线性与双线性的交点差 → 不超过一个细格（1/N 原格）。
  if (f) {
    const N = 5
    const c = loadCase({ ...f, rels: [-1, -3, -6, -10] })
    const b = whittakerBeam(c.beam, N), NX2 = b.grid.NX, NY2 = b.grid.NY
    const fld = fieldDb({ P1: b.P1, P2: b.P2, NX: NX2, NY: NY2 }, null, { pol: 'RSS' })
    const n2 = NX2 * NY2, lon2 = new Float32Array(n2), lat2 = new Float32Array(n2), vis2 = new Float32Array(n2).fill(1)
    for (let r = 0; r < NY2; r++) for (let cc = 0; cc < NX2; cc++) { lon2[r * NX2 + cc] = cc / N; lat2[r * NX2 + cc] = r / N }   // 以原网格格为单位
    const geo5 = bandGeometry({ lon: lon2, lat: lat2, vis: vis2, db: fld.db, NX: NX2, NY: NY2 }, c.levels, false, null, null, 1, null, null)
    const s = c.set, NX = c.NX, NY = c.NY, W = N * NX, H = N * NY
    const t5 = Date.now()
    const f1r = whittaker2D(s.c1re, NX, NY, N), f1i = whittaker2D(s.c1im, NX, NY, N), f2r = whittaker2D(s.c2re, NX, NY, N), f2i = whittaker2D(s.c2im, NX, NY, N)
    const dS = new Float32Array(W * H)
    for (let i = 0; i < W * H; i++) { const P = f1r[i] * f1r[i] + f1i[i] * f1i[i] + f2r[i] * f2r[i] + f2i[i] * f2i[i]; dS[i] = P > 0 ? 10 * Math.log10(P) : NaN }
    let up = 0
    for (let r = 0; r < NY2; r++) for (let cc = 0; cc < NX2; cc++) { const a = fld.db[r * NX2 + cc], v = dS[r * W + cc]; if (a === a && v === v) up = Math.max(up, Math.abs(a - v)) }
    ok(up < 1e-3, `密度 ${N}：whittakerBeam 的细网格 dB 与 DFT 零填充复现逐点一致（最大 |Δ| ${up.toExponential(1)} dB）`)
    const dseg = (p, a, bb) => { const dx = bb[0] - a[0], dy = bb[1] - a[1], l2 = dx * dx + dy * dy; let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t; return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) }
    const d5 = []
    for (let k = 0; k < c.levels.length; k++) {
      const segS = marching(dS, W, H, c.levels[k]).map((sg) => [[sg[0][0] / N, sg[0][1] / N], [sg[1][0] / N, sg[1][1] / N]])
      if (!segS.length) continue
      const bucket = new Map(), put = (kk, i) => { let a = bucket.get(kk); if (!a) { a = []; bucket.set(kk, a) } a.push(i) }
      segS.forEach((sg, i) => { const x0 = Math.floor(Math.min(sg[0][0], sg[1][0])), x1 = Math.floor(Math.max(sg[0][0], sg[1][0])), y0 = Math.floor(Math.min(sg[0][1], sg[1][1])), y1 = Math.floor(Math.max(sg[0][1], sg[1][1])); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) put(x + ',' + y, i) })
      for (const sg of geo5.lines[k]) for (const p of sg) {
        const cx2 = Math.floor(p[0]), cy2 = Math.floor(p[1]); let best = Infinity
        for (let rad = 1; rad <= 3 && !(best < rad - 0.5); rad++) for (let x = cx2 - rad; x <= cx2 + rad; x++) for (let y = cy2 - rad; y <= cy2 + rad; y++) { const a = bucket.get(x + ',' + y); if (!a) continue; for (const i of a) { const d = dseg(p, segS[i][0], segS[i][1]); if (d < best) best = d } }
        if (best < Infinity) d5.push(best)
      }
    }
    const q5 = (a, fr) => { const s2 = Float64Array.from(a).sort(); return s2[Math.min(s2.length - 1, Math.floor(fr * s2.length))] }
    console.log(`  ⑤ 密度 ${N}：本平台细网格线 → SATSOFT 同密度线 ${d5.length} 个顶点 p50/p95/max = ${q5(d5, 0.5).toFixed(4)}/${q5(d5, 0.95).toFixed(4)}/${q5(d5, 1).toFixed(3)} 格（复现 ${((Date.now() - t5) / 1000).toFixed(1)} s）`)
    ok(d5.length > 1000 && q5(d5, 0.95) <= 1 / N, `密度 ${N} 两边同一份上采样：线距离 p95 ≤ 1/N 格（三角形线性 vs 方格双线性的交点差不出一个细格）`)
  }
}

console.log(`covRealGrd.test.mjs：${pass} 条断言全绿（样例 ${have.length} / ${FILES.length}）`)
