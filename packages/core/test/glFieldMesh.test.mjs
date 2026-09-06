// 2D 分带填充 GPU 后端的等价性不变量（src/viz/flatmap/glField.js）。运行：npm test
//
// 为什么要有这一份：屏上填充从「CPU 逐三角切分带多边形（bandGeometry）」改成「GPU 逐像素分档」
// 之后，两边必须落在【同一张三角网】上，否则填充与等值线（仍走 CPU）会错开、跨地平那一圈会露缝。
// 这类错误不报错，只是「图看着有点怪」，故判据一律是能算的量：
//
//   ① 索引集合 == bandGeometry 三角化循环 + loadTri 前两条跳过所枚举出的那一批（stride 1 / 2 各一次）
//   ② 覆盖性：bandGeometry 切出来的【每一块填充多边形】，其质心都落在 GPU 的某个三角形内，
//      且 GPU 在该点线性插值出的 dB 落在【同一档】—— 填充边界与档号逐块对齐
//   ③ 多出来的那些三角形（CPU 因 max dB < L0 跳掉、GPU 留给片元 discard）确实全部低于最低档
//   ④ 片元的地平判据（归一坐标下 dot(P′, Ŝ′) ≥ 1）与 0° 仰角线严格同一条；着色器源码里
//      那一行也钉住（改了这里就得改测试）
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
import { antennaBasis, projectGrid, fieldDb, bandGeometry } from '../../../src/viz/grd/coverage.js'
import { buildMeshIndices, meshLattice, GL_MAX_LEVELS, FRAG_SRC } from '../../../src/viz/flatmap/glField.js'
import { makeProjection } from '../../../src/viz/geo/projection.js'
import { A, B, E2, geodeticToEcef, isoElevationContourAt, elevationDeg } from '../../../src/viz/wgs84.js'

let pass = 0
const ok = (c, m) => { assert.ok(c, m); pass++ }
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180

// ---- 合成一个 GRD set：igrid=4（az/el 度，与真 GRD 同一档）、两个高斯波束，边缘跨过地平 ----
// 两个瓣：一个在星下点附近（整瓣在地球上），一个偏到 az≈7.5° 上（其裙边越过 GEO 地平 ~8.7°）。
// 网格开到 ±14°，于是热区盒是全网格的【真子集】、盒角落低于最低档、盒边缘又跨地平 ——
// loadTri 的三条（NaN / 全越地平 / max<L0）在同一份数据上全部触发。
function makeSet(NX = 71, NY = 71, span = 14) {
  const N = NX * NY, P1 = new Float32Array(N), P2 = new Float32Array(N)
  const dx = 2 * span / (NX - 1), dy = 2 * span / (NY - 1)
  for (let r = 0; r < NY; r++) {
    const y = -span + dy * r
    for (let c = 0; c < NX; c++) {
      const x = -span + dx * c, k = r * NX + c
      const g1 = Math.exp(-((x - 1.5) ** 2 + (y - 0.7) ** 2) / 6)
      const g2 = 0.5 * Math.exp(-((x - 7.5) ** 2 + (y - 4.0) ** 2) / 6)
      P1[k] = g1 + g2
      P2[k] = 0.3 * g1
      // 一小块「无效增益」：loadTri 的第一条（任一角 dB 为 NaN 就跳）要在两边都触发
      if (r > 34 && r < 39 && c > 40 && c < 45) P1[k] = 0
    }
  }
  return { XS: -span, YS: -span, XE: span, YE: span, NX, NY, P1, P2 }
}

// bandGeometry 三角化循环 + loadTri 前两条跳过的【独立枚举】（与被测实现分开写，用来对集合）
function enumerateTris(NX, NY, box, stride, db, vis) {
  const rA = box ? box.r0 : 0, rB = box ? Math.min(box.r1, NY - 1) : NY - 1
  const cA = box ? box.c0 : 0, cB = box ? Math.min(box.c1, NX - 1) : NX - 1
  const st = Math.max(1, stride | 0), out = []
  const live = (i0, i1, i2) => {
    const d0 = db[i0], d1 = db[i1], d2 = db[i2]
    if (Number.isNaN(d0) || Number.isNaN(d1) || Number.isNaN(d2)) return false
    return !(vis[i0] < 0 && vis[i1] < 0 && vis[i2] < 0)
  }
  for (let row = rA; row < rB; row += st) {
    const r2 = Math.min(row + st, rB)
    for (let col = cA; col < cB; col += st) {
      const c2 = Math.min(col + st, cB)
      const i00 = row * NX + col, i10 = row * NX + c2, i01 = r2 * NX + col, i11 = r2 * NX + c2
      if (live(i00, i10, i11)) out.push([i00, i10, i11])
      if (live(i00, i11, i01)) out.push([i00, i11, i01])
    }
  }
  return out
}

function computeBox(db, NX, NY, L0) {
  let r0 = NY, r1 = -1, c0 = NX, c1 = -1
  for (let r = 0; r < NY; r++) { const rb = r * NX; for (let c = 0; c < NX; c++) if (db[rb + c] >= L0) { if (r < r0) r0 = r; if (r > r1) r1 = r; if (c < c0) c0 = c; if (c > c1) c1 = c } }
  if (r1 < 0) return { r0: 0, r1: -1, c0: 0, c1: -1 }
  return { r0: Math.max(0, r0 - 1), r1: Math.min(NY - 1, r1 + 1), c0: Math.max(0, c0 - 1), c1: Math.min(NX - 1, c1 + 1) }
}

const SAT_LON = 110.5, SAT_ALT = 35786.06, IGRID = 4
const set = makeSet()
const basis = antennaBasis(SAT_LON, SAT_LON, 0, 0, 0, SAT_ALT)
const f0 = fieldDb(set, null, { pol: 'P1' })
const NB = 8
const levels = []
for (let k = NB - 1; k >= 0; k--) levels.push(f0.max - 1 - (23 / NB) * k)
const box = computeBox(f0.db, set.NX, set.NY, levels[0])
const proj = projectGrid(set, IGRID, basis, box, null, true)
const field = fieldDb(set, proj, { pol: 'P1' })
const N = set.NX * set.NY
const lonU = new Float32Array(N)
for (let r = box.r0; r <= box.r1; r++) { const rb = r * set.NX; for (let c = box.c0; c <= box.c1; c++) { const q = rb + c; lonU[q] = SAT_LON + wrap180(proj.lon[q] - SAT_LON) } }

// ============ ⓪ 这份合成数据确实把 loadTri 的三条跳过全踩到了（否则 ① 会空跑一场） ============
{
  let nan = 0, offEarth = 0, below = 0, live = 0
  const L0 = levels[0]
  for (let row = box.r0; row < box.r1; row++) for (let col = box.c0; col < box.c1; col++) {
    const i00 = row * set.NX + col, i10 = row * set.NX + col + 1, i01 = (row + 1) * set.NX + col, i11 = (row + 1) * set.NX + col + 1
    for (const t of [[i00, i10, i11], [i00, i11, i01]]) {
      const d = t.map((q) => field.db[q]), v = t.map((q) => proj.vis[q])
      if (d.some(Number.isNaN)) { nan++; continue }
      if (v.every((x) => x < 0)) { offEarth++; continue }
      if (Math.max(...d) < L0) { below++; continue }
      live++
    }
  }
  ok(nan > 0, `合成数据里有「增益无效」的三角（${nan} 个）`)
  ok(offEarth > 0, `合成数据里有「整三角越地平」的三角（${offEarth} 个）`)
  ok(below > 0, `合成数据里有「全部低于最低档」的三角（${below} 个）`)
  ok(live > 500, `合成数据里的有效三角够多（${live} 个）`)
}

// ============ ① 索引集合 == 独立枚举 ============
for (const stride of [1, 2]) {
  const mesh = { NX: set.NX, NY: set.NY, box, stride, lonU, lat: proj.lat, db: field.db, vis: proj.vis }
  const mi = buildMeshIndices(mesh)
  const rowOff = box.r0 * set.NX
  const got = new Set()
  for (let i = 0; i < mi.idx.length; i += 3) got.add([mi.idx[i] + rowOff, mi.idx[i + 1] + rowOff, mi.idx[i + 2] + rowOff].join(','))
  const want = new Set(enumerateTris(set.NX, set.NY, box, stride, field.db, proj.vis).map((t) => t.join(',')))
  ok(got.size === mi.idx.length / 3, `stride ${stride}：索引里没有重复三角（${got.size} / ${mi.idx.length / 3}）`)
  ok(want.size > 100, `stride ${stride}：枚举出的三角够多（${want.size}）`)
  ok(got.size === want.size, `stride ${stride}：三角数一致（GL ${got.size} vs 枚举 ${want.size}）`)
  let miss = 0
  for (const k of want) if (!got.has(k)) miss++
  ok(miss === 0, `stride ${stride}：逐个三角（含顶点次序）完全一致，缺 ${miss}`)
  // 顶点索引不越界（缓冲只传 box 那几行）
  const vLen = (Math.min(box.r1, set.NY - 1) - box.r0 + 1) * set.NX
  let bad = 0
  for (let i = 0; i < mi.idx.length; i++) if (mi.idx[i] >= vLen) bad++
  ok(bad === 0, `stride ${stride}：索引不越出上传的顶点区间`)
}

// ============ ② 每块 CPU 填充多边形的质心，都在 GPU 三角形内且落同一档 ============
{
  const stride = 1
  const mesh = { NX: set.NX, NY: set.NY, box, stride, lonU, lat: proj.lat, db: field.db, vis: proj.vis }
  const mi = buildMeshIndices(mesh)
  const rowOff = box.r0 * set.NX
  const tris = []
  for (let i = 0; i < mi.idx.length; i += 3) {
    const a = mi.idx[i] + rowOff, b = mi.idx[i + 1] + rowOff, c = mi.idx[i + 2] + rowOff
    tris.push([a, b, c])
  }
  // 三角形重心坐标：GPU 的插值就是这一套（等距圆柱下屏幕坐标是世界度的仿射变换）
  const bary = (t, px, py) => {
    const x0 = lonU[t[0]], y0 = proj.lat[t[0]], x1 = lonU[t[1]], y1 = proj.lat[t[1]], x2 = lonU[t[2]], y2 = proj.lat[t[2]]
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    if (!d) return null
    const l0 = ((y1 - y2) * (px - x2) + (x2 - x1) * (py - y2)) / d
    const l1 = ((y2 - y0) * (px - x2) + (x0 - x2) * (py - y2)) / d
    return [l0, l1, 1 - l0 - l1]
  }
  // 片元的分档式子：k = 最后一个 ≤ dB 的下标（与 FRAG 的循环同一判据）
  const bandOf = (v) => { let k = -1; for (let i = 0; i < levels.length; i++) { if (levels[i] <= v) k = i; else break } return k }
  // ★ 与 GPU 路对齐：CPU 这一次也不给 hull（跨地平三角形按 0°仰角线半平面裁），只比分档口径
  const geo = bandGeometry({ lon: proj.lon, lat: proj.lat, vis: proj.vis, db: field.db, NX: set.NX, NY: set.NY }, levels, true, box, null, stride)
  let nPoly = 0, nTested = 0, notInTri = 0, wrongBand = 0
  const STEP = 7   // 抽样（每 7 块测一块）：这一段是 O(块数 × 三角数)，全测要跑十几秒
  for (let k = 0; k < levels.length; k++) {
    const { verts, counts } = geo.fills[k]
    let vi = 0
    for (let j = 0; j < counts.length; j++) {
      const plen = counts[j]
      if (j % STEP) { vi += plen; nPoly++; continue }
      let cx = 0, cy = 0
      for (let q = 0; q < plen; q++) { cx += verts[(vi + q) * 2]; cy += verts[(vi + q) * 2 + 1] }
      cx /= plen; cy /= plen
      vi += plen
      nPoly++; nTested++
      // 质心落在哪个三角形里（经度按解缠窗口对齐）
      const ux = SAT_LON + wrap180(cx - SAT_LON)
      let hit = null, best = -1e9
      for (const t of tris) {
        const l = bary(t, ux, cy)
        if (!l) continue
        const m = Math.min(l[0], l[1], l[2])
        if (m > best) { best = m; hit = { t, l } }
      }
      if (!hit || best < -1e-6) { notInTri++; continue }
      const v = field.db[hit.t[0]] * hit.l[0] + field.db[hit.t[1]] * hit.l[1] + field.db[hit.t[2]] * hit.l[2]
      if (bandOf(v) !== k) wrongBand++
    }
  }
  ok(nPoly > 200 && nTested > 50, `CPU 切出的填充多边形够多（${nPoly} 块，抽测 ${nTested} 块）`)
  ok(notInTri === 0, `每块填充多边形的质心都落在某个 GPU 三角形内（漏 ${notInTri}）`)
  ok(wrongBand === 0, `GPU 在这些质心插值出的 dB 落在同一档（错 ${wrongBand} / ${nTested}）`)
}

// ============ ③ GPU 多留的三角形确实全都低于最低档（片元 discard 掉，不会多画） ============
{
  const stride = 1
  const mi = buildMeshIndices({ NX: set.NX, NY: set.NY, box, stride, lonU, lat: proj.lat, db: field.db, vis: proj.vis })
  const rowOff = box.r0 * set.NX
  const L0 = levels[0]
  let extra = 0, extraAbove = 0
  for (let i = 0; i < mi.idx.length; i += 3) {
    const a = mi.idx[i] + rowOff, b = mi.idx[i + 1] + rowOff, c = mi.idx[i + 2] + rowOff
    const mx = Math.max(field.db[a], field.db[b], field.db[c])
    if (mx >= L0) continue
    extra++
    if (mx >= L0) extraAbove++
  }
  ok(extra > 0, `确实有「CPU 会跳、GPU 留给片元」的三角形（${extra} 个）`)
  ok(extraAbove === 0, '这些三角形的三个角全部低于最低档 → 线性插值后处处 < L0，片元一律 discard')
}

// ============ ④ 片元的地平判据 ≡ 0° 仰角线 ============
{
  const S = basis.S
  const satN = [S[0] / A, S[1] / A, S[2] / B]
  // ★ 这一段必须与 glField.js 的 FRAG 逐字同式：归一坐标 (x/A, y/A, z/B) 下地表点恰在单位球上
  const dotN = (lon, lat) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180
    const s = Math.sin(la), c = Math.cos(la)
    const Nn = 1 / Math.sqrt(1 - E2 * s * s), re = Math.sqrt(1 - E2)
    return (Nn * c * Math.cos(lo)) * satN[0] + (Nn * c * Math.sin(lo)) * satN[1] + (Nn * re * s) * satN[2]
  }
  const arc = isoElevationContourAt(geodeticToEcef(SAT_LON, 0, SAT_ALT), 0, 240)
  ok(arc && arc.length > 100, '取到 0° 仰角线')
  let worst = 0
  for (const p of arc) worst = Math.max(worst, Math.abs(dotN(p[0], p[1]) - 1))
  ok(worst < 2e-9, `0° 仰角线上 dot(P′,Ŝ′) 恒为 1（最大偏离 ${worst.toExponential(2)}）`)
  // 内外号位：星下点内、对跖点外
  ok(dotN(SAT_LON, 0) > 1, '星下点在地平内（dot > 1）')
  ok(dotN(SAT_LON + 180, 0) < 1, '对跖点在地平外（dot < 1）')
  // 判据与仰角同号：沿星下点往外扫，dot 过 1 的那一点仰角也恰好过 0
  const satE = geodeticToEcef(SAT_LON, 0, SAT_ALT)
  let flipDot = null, flipEl = null
  for (let d = 0; d <= 100; d += 0.02) {
    const lon = SAT_LON + d
    const a = dotN(lon, 0) - 1, e = elevationDeg(lon, 0, satE)
    if (flipDot == null && a < 0) flipDot = d
    if (flipEl == null && e < 0) flipEl = d
  }
  ok(Math.abs(flipDot - flipEl) <= 0.021, `dot 判据与仰角判据在同一点翻号（${flipDot.toFixed(2)}° vs ${flipEl.toFixed(2)}°）`)
  // 着色器源码里那一行钉住：改了式子就得回来改这份测试
  ok(/dot\(P,\s*uSatN\)\s*<\s*1\.0\s*\)\s*discard/.test(FRAG_SRC), '片元着色器仍按 dot(P, uSatN) < 1.0 discard')
  ok(FRAG_SRC.includes('uLevels[i] <= vDb'), '片元着色器仍按「最后一个 ≤ vDb 的档」取色')
  ok(GL_MAX_LEVELS === 64, '电平上限 64（超过退回 CPU 路）')
}

// ============ ⑤ 源码级：网格【永远不会】流到导出与 3D 那两条路上 ============
// PNG/PDF 逐字节一致是硬约束，exportRender 的 compat 分支只认 fillBands；3D 的 updateFill 只吃凸多边形。
// 这三道闸任何一道被顺手改掉，导出的覆盖层会整片消失且【不报错】—— 故在源码上钉住。
{
  const read = (rel) => readFileSync(join(HERE, '../../..', rel), 'utf8')
  const flat = read('src/viz/flatmap/flatCoverage.js')
  const grd = read('src/viz/grd/useGrdCoverage.js')
  const page = read('src/pages/ConstellationMap3D.vue')

  ok(/function fieldBackend\(nLevels\) \{[\s\S]{0,400}?if \(exporting \|\| compat\) return 'paths'/.test(flat),
    'fieldBackend：导出中 / compat 一律回 paths（六个投影档都走 GPU）')
  ok(/const glOn = !compat && !exporting &&/.test(flat),
    'drawField 的 GPU 分叉同样把 compat / exporting 挡在外面')
  ok(/reprojectGlLayers\(\)/.test(flat) && /if \(!rotLive\) \{/.test(flat),
    '换平面时重投影 GPU 层，且「拖着转」进行中不做（松手那一次补）')
  ok(/setExporting\(v\)\s*\{[^}]*exporting = nv/.test(flat), 'setExporting 置的就是 fieldBackend 看的那个标志')

  // 几何层：fieldMesh 只在 (cfg.fill && glMesh) 时生成，glMesh 只在 isFlat() 且渲染器回答 gl 时为真
  ok(/const fieldMesh = \(cfg\.fill && glMesh\) \? buildFieldMesh\(/.test(grd), 'fieldMesh 只在开填充 + 后端为 gl 时生成')
  ok(/const glMesh = isFlat\(\) && \(\(\) => \{ const fl = flatField\(\); return !!\(fl && fl\.fieldBackend && fl\.fieldBackend\(/.test(grd),
    'glMesh 每次都现问 fieldBackend()（不缓存），且只在 isFlat() 时才可能为真')

  // 页面：导出流程必须在 feedFlat 之前置位（recompute 在 exportRender 之前跑，compat 那时还没置）
  const i0 = page.indexOf('flat.setExporting(true)')
  const i1 = page.indexOf('await feedFlat()', i0 < 0 ? 0 : i0)
  ok(i0 > 0 && i1 > i0, '导出流程里 setExporting(true) 排在 feedFlat() 之前')
  ok(/flat\.setExporting\(false\); grd\.recompute\(\)/.test(page), '导出结束复位并重算一轮（屏上换回 GPU 路）')
}

// ============ ⑥ 投影档：顶点位置由 CPU 预投，索引多两条跳过 ============
// 五个非等距圆柱档没有闭式仿射（d3 正算里有迭代），顶点位置只能 CPU 预投成 aPlane。
// 于是多两件必须自己做的事（d3 的 geoPath 本来替 CPU 路做了）：投不出来的角、跨切口的三角形。
{
  const stride = 1
  const mesh = { NX: set.NX, NY: set.NY, box, stride, lonU, lat: proj.lat, db: field.db, vis: proj.vis }
  const base = buildMeshIndices(mesh)
  const rowOff = box.r0 * set.NX
  const NXs = set.NX
  const rB = Math.min(box.r1, set.NY - 1)
  const len = (rB - box.r0 + 1) * NXs

  // ★ meshLattice ≡ 三角化真正引用到的行列集合。这一条错了，预投就会漏点 →
  //   那些点的 aPlane 是 NaN → 三角形被当成「投不出来」整片剔掉（图上一大块空白，不报错）。
  const lat0 = meshLattice(mesh)
  const rows = new Set(lat0.rows), cols = new Set(lat0.cols)
  let offLattice = 0
  for (let i = 0; i < base.idx.length; i++) {
    const q = base.idx[i] + rowOff
    if (!rows.has((q / NXs) | 0) || !cols.has(q % NXs)) offLattice++
  }
  ok(base.idx.length > 0 && offLattice === 0, `三角化只引用 meshLattice 给出的行列（越界 ${offLattice}）`)

  for (const kind of ['mercator', 'equalEarth', 'robinson', 'albers', 'azeq']) {
    const PJ = makeProjection(kind, -30, { lat0: 10, par1: 25, par2: 47 })
    // 只投 lattice 上的点，其余留 NaN —— 与 flatCoverage.projectMeshPlane 同一口径
    const xy = new Float32Array(len * 2); xy.fill(NaN)
    const o = [0, 0]
    for (const r of lat0.rows) {
      const rb = r * NXs, ob = (r - box.r0) * NXs
      for (const c of lat0.cols) { const q = rb + c, k = (ob + c) * 2; const pt = PJ.fwd(lonU[q], proj.lat[q], o); xy[k] = pt[0]; xy[k + 1] = pt[1] }
    }
    const mi = buildMeshIndices(mesh, { xy, W: PJ.W, H: PJ.H })
    ok(mi.idx.length === base.idx.length, `${kind}：只投 lattice 也没丢三角（${mi.idx.length / 3} vs ${base.idx.length / 3}）`)
    ok(Number.isFinite(mi.pxLo) && mi.pxLo >= -1e-6 && mi.pxHi <= PJ.W + 1e-6, `${kind}：平面 x 跨度落在 [0, W]（${mi.pxLo.toFixed(1)}~${mi.pxHi.toFixed(1)} / W=${PJ.W}）`)
    ok(Number.isFinite(mi.pyLo) && mi.pyLo >= -1e-6 && mi.pyHi <= PJ.H + 1e-6, `${kind}：平面 y 跨度落在 [0, H]（${mi.pyLo.toFixed(1)}~${mi.pyHi.toFixed(1)} / H=${PJ.H.toFixed(1)}）`)

    // 投不出来的角 → 整三角剔掉
    const xy2 = xy.slice()
    const bad = base.idx[0] * 2
    xy2[bad] = NaN
    const mi2 = buildMeshIndices(mesh, { xy: xy2, W: PJ.W, H: PJ.H })
    ok(mi2.idx.length < mi.idx.length, `${kind}：某个角投不出来（NaN）→ 引用它的三角形全被剔掉`)

    // 跨切口 → 整三角剔掉（把一个顶点搬到平面另一头，模拟从切口一侧接到另一侧）
    const xy3 = xy.slice()
    xy3[bad] = xy[bad] + PJ.W * 0.9
    const mi3 = buildMeshIndices(mesh, { xy: xy3, W: PJ.W, H: PJ.H })
    ok(mi3.idx.length < mi.idx.length, `${kind}：跨切口的三角形被剔掉（按投出来的边长判，不看是哪档投影）`)
  }
  ok(/uProj == 1\) \? aPlane/.test(FRAG_SRC) === false, '片元不碰平面坐标（地平判据只用经纬 varying）')
}

console.log(`glFieldMesh.test.mjs：${pass} 条断言全绿`)
