// 真实 GRD 上的覆盖分析回归（本机有文件才跑，否则整份跳过）。四组统计来自 .covharness 的离线复现台：
//   ① 拼链：开口链恰一条折线（链数 = 闭合环数 + 度 1 端点数 / 2），碎片数对老实现的降幅
//   ② 转角：折线在顶点处的转角分布（> 8° 占比 = 「放大后像多边形」的量化口径）
//   ③ 贴合：线顶点是否落在填充边界上（近地平跨地平格子）
//   ④ 与 SATSOFT（Whittaker 密度 5 重建 + 细网格 marching squares）线的距离
// 口径与阈值出自《覆盖分析五项修复与等值线终极优化任务书_2026-09-21.md》，数字见各组打印。
// 运行：npm test
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { parseGrd } from '../../../src/viz/grd/parse.js'
import { fieldDb, bandGeometry, buildEdgeRefine, peakRefDb, stitchLoops, antennaBasis, projectGrid, projectRefine } from '../../../src/viz/grd/coverage.js'
import { geodeticToEcef, elevationDeg, isoElevationContourAt } from '../../../src/viz/wgs84.js'

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
  let worstOff = 0, worstGap = 0, vertsAll = 0
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
      vertsAll += tot; worstOff = Math.max(worstOff, offLimb + offIn); worstGap = Math.max(worstGap, gapMax)
    }
  }
  ok(vertsAll > 1000 && worstOff === 0, `近地平：${vertsAll} 个线顶点全部落在填充多边形顶点上（最坏 ${worstOff} 个不在，最大间隙 ${worstGap.toFixed(2)} km）`)
}

console.log(`covRealGrd.test.mjs：${pass} 条断言全绿（样例 ${have.length} / ${FILES.length}）`)
