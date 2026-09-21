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
import { fieldDb, bandGeometry, buildEdgeRefine, peakRefDb, stitchLoops } from '../../../src/viz/grd/coverage.js'

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
  return { set: s, beam, field, peak, levels, NX, NY, gridField: { lon, lat, vis, db: field.db, NX, NY }, refine }
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

console.log(`covRealGrd.test.mjs：${pass} 条断言全绿（样例 ${have.length} / ${FILES.length}）`)
