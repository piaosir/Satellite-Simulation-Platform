// 解析高斯天线（STK Gaussian，src/viz/grd/gaussStk.js）接进对地覆盖引擎之后的精度网。运行：node packages/core/test/gaussCoverage.test.mjs
//
//   ① GEO 0°E 天底单波束（14.5 GHz / 1 m / 55% / k=stk）：按应用同一条路（天底基底 → projectGrid → fieldDb → 交点细化 →
//      projectRefine → bandGeometry）出 −1 / −3 / −10 dB 线，逐顶点反算离轴角对闭式半角 θ3·√(L/kDb) 的相对误差；
//      顶点经 sampleBeamAt 取值 = 档值（≤ 1e-4 dB）；整条线（顶点 + 线段中点）对 coneFootprint（锥 ∩ WGS-84 精确足迹）的地面偏差。
//   ② LEO 550 km / 45°N，视轴 az 35° el −10°，θ3 = 4°（drv 'bw'）：同样的检查 —— 证明没有 cos(az) 模型误差；
//      对照旧 synth.buildGaussGrd 同一波束，沿 el 向量出它的 −3 dB 真实半角（≈ −18%），打印出来。
//   ③ sampleBeamAt / sampleBeamAtEcef 对解析波束 ≡ anGainDbi（500 个窗内随机地面点，≤ 1e-9 dB）；窗外 → null。
//   ④ refinedPeakDb / peakRefDb 精确（= g0，逐位）；Whittaker 密度对解析波束是重铺不是插值；projectRefine 的 grid.exact。
//   ⑤ useGrdCoverage 组合层：createAnalyticAntenna / updateAnalyticAntenna（写盘合帧）/ analyticRecordOf /
//      getState → restoreState → loadAntenna 往返；关联星无星历：拒建、不画、getPerfContext 标 noEph；setActive({face:false}) 不转镜头。
//      Whittaker 密度 > 1 的解析天线照建细化表（线仍精确）；setEphReady：星历源没备好先等再下「无星历」结论；
//      invalidateLive：换星历源后不等时钟走就把「解不解得出」与星位对一遍。
//   ⑤c 等星历源 / 存盘期间卫星被删 → 不建幽灵天线、不留孤儿文件；等待期间再点导入 → 不另开文件框、亮 loading
//      （importGrd / createAnalyticAntenna / importSynthGrd）。
//   ④b 细化表的密度门（refineAtDens）：解析天线密度 2 / 4 的线顶点仍 = 档值（~1e-8 dB）；网格天线照旧不建。
//   ⑥ 对星表时段扫描 × 解析天线就地改参：扫完改方向图 → winStaleFor 标「输入已变」（响应式推得出去），游标表按新波束取值。
import { antennaBasis, projectGrid, fieldDb, bandGeometry, edgeRefineFor, refineAtDens, projectRefine, sampleBeamAt, sampleBeamAtEcef, sampleBeamAtParam, refinedPeakDb, peakRefDb, gridDir } from '../../../src/viz/grd/coverage.js'
import { buildRecord, materialize, anGainDbi, anWindow, coneFootprint, kDbOf, recordToText, materializeBeam } from '../../../src/viz/grd/gaussStk.js'
import { whittakerBeam } from '../../../src/viz/grd/whittaker.js'
import { buildGaussGrd } from '../../../src/viz/grd/synth.js'
import { parseGrd } from '../../../src/viz/grd/parse.js'
import { geodeticToEcef } from '../../../src/viz/wgs84.js'

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg + (extra ? `  (${extra})` : '')); cond ? pass++ : fail++ }
const D2R = Math.PI / 180, R2D = 180 / Math.PI
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a) => Math.hypot(a[0], a[1], a[2])
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const nrm = (a) => { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l] }
const ang = (a, b) => Math.atan2(len(crs(a, b)), dot(a, b))
const toEcef = (basis, d) => nrm([basis.x[0] * d[0] + basis.y[0] * d[1] + basis.z[0] * d[2], basis.x[1] * d[0] + basis.y[1] * d[1] + basis.z[1] * d[2], basis.x[2] * d[0] + basis.y[2] * d[1] + basis.z[2] * d[2]])
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

// 与 useGrdCoverage.importedCacheEntry 同形的波束（an + grid.exact + 天底基底全网格投影）
function beamOf(set, basis) {
  return { P1: set.P1, P2: set.P2, c1re: set.c1re, c1im: set.c1im, c2re: set.c2re, c2im: set.c2im, an: set.an,
    grid: { XS: set.XS, YS: set.YS, XE: set.XE, YE: set.YE, NX: set.NX, NY: set.NY, exact: true }, proj: projectGrid(set, 6, basis, null, null, true) }
}
// 点到折线（ECEF，闭合）的最近距离 km
function distToRing(P, ring) {
  let best = Infinity
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i], b = ring[i + 1], ab = sub(b, a), ap = sub(P, a), L2 = dot(ab, ab)
    const t = L2 > 0 ? Math.max(0, Math.min(1, dot(ap, ab) / L2)) : 0
    const d = len(sub(ap, [ab[0] * t, ab[1] * t, ab[2] * t]))
    if (d < best) best = d
  }
  return best
}

// 按应用同一条路出线，逐顶点 / 线段中点检查。relLevels 为相对峰值的 dB（负）。
function contourCheck(tag, rec, basis, relLevels) {
  const g = materialize(rec), set = g.sets[0], an = set.an
  const beam = beamOf(set, basis)
  const field = fieldDb({ P1: beam.P1, P2: beam.P2, NX: set.NX, NY: set.NY }, beam.proj, { pol: 'RSS' })
  const pk = peakRefDb(beam, field, 'RSS', 0, 'none')
  const asc = relLevels.map((r) => pk + r).sort((a, b) => a - b)
  const t0 = performance.now()
  const refine = edgeRefineFor(beam, field, asc, 'RSS', 0)
  const pos = projectRefine(refine, beam.grid, 6, basis, beam.proj)
  const geo = bandGeometry({ lon: beam.proj.lon, lat: beam.proj.lat, vis: beam.proj.vis, db: field.db, NX: set.NX, NY: set.NY }, asc, true, null, null, 1, refine, pos)
  const ms = performance.now() - t0
  ok(pos.exact === refine.n + refine.nm, `${tag}：grid.exact → 细化顶点全部逐点求交`, `${pos.exact} / ${refine.n + refine.nm}`)
  const S = basis.S, axis = toEcef(basis, gridDir(6, an.az, an.el)), th3 = an.th3 * D2R, kdb = kDbOf(an.k)
  const out = []
  asc.forEach((L, k) => {
    const lrel = pk - L, thL = th3 * Math.sqrt(lrel / kdb)
    const segs = geo.lines[k]
    const seen = new Set(), verts = []
    for (const s of segs) for (const p of s) { const key = p[0] + ',' + p[1]; if (!seen.has(key)) { seen.add(key); verts.push(p) } }
    let worstRel = 0, worstDb = 0
    for (const p of verts) {
      const P = geodeticToEcef(p[0], p[1], 0)
      const th = ang(nrm(sub(P, S)), axis)
      worstRel = Math.max(worstRel, Math.abs(th - thL) / thL)
      const r = sampleBeamAt(beam, 6, basis, p[0], p[1], { pol: 'RSS' })
      worstDb = Math.max(worstDb, r ? Math.abs(r.db - L) : Infinity)
    }
    // 精确足迹：锥半角 thL 的 cone ∩ WGS-84（参考折线本身按 0.2 m 矢高加密）
    const ref = coneFootprint(S, axis, thL, { n: 256, tolKm: 0.0002, maxDepth: 16 }).ring.map((q) => geodeticToEcef(q[0], q[1], 0))
    let devV = 0, devM = 0
    for (const p of verts) devV = Math.max(devV, distToRing(geodeticToEcef(p[0], p[1], 0), ref))
    for (const s of segs) devM = Math.max(devM, distToRing(geodeticToEcef((s[0][0] + s[1][0]) / 2, (s[0][1] + s[1][1]) / 2, 0), ref))
    out.push({ lrel, thL, verts: verts.length, worstRel, worstDb, devV, devM })
    console.log(`      ${tag} ${(-lrel).toFixed(2)} dB：${verts.length} 顶点 · 离轴角相对误差 ≤ ${worstRel.toExponential(2)} · 取值 |Δ| ≤ ${worstDb.toExponential(2)} dB · 对精确足迹：顶点 ≤ ${(devV * 1000).toFixed(2)} m、线段中点 ≤ ${(devM * 1000).toFixed(1)} m（θL = ${(thL * R2D).toFixed(5)}°）`)
  })
  console.log(`      ${tag}：细化 + 投影 + 分带 ${ms.toFixed(1)} ms（${set.NX}×${set.NY}）`)
  return { out, beam, set, an, basis, field }
}

// ============ ① GEO 0°E 天底 ============
const GEO_ALT = 35786
const MODEL_D = { id: 'm1', name: 'STK', fGHz: 14.5, drv: 'D', D: 1, bw3: 0, G: 0, eff: 55, back: -30, k: 'stk' }
const recGeo = buildRecord({ sat: { name: 'GEO0', lon: 0, lat: 0, altKm: GEO_ALT }, models: [MODEL_D], beams: [{ name: 'b1', az: 0, el: 0, model: 'm1' }] })
const basisGeo = antennaBasis(0, 0, 0, 0, 0, GEO_ALT)
{
  ok(Math.abs(recGeo.beams[0].g0 - 41.03757033) < 1e-7 && Math.abs(recGeo.beams[0].th3 - 1.59732757) < 1e-7, 'STK 默认模型 G0 / θ3 与官方读数一致', `${recGeo.beams[0].g0.toFixed(8)} dBi / ${recGeo.beams[0].th3.toFixed(8)}°`)
  const r = contourCheck('① GEO', recGeo, basisGeo, [-1, -3, -10])
  for (const o of r.out) {
    ok(o.verts > 50, `① ${-o.lrel} dB 线出得来`, o.verts + ' 顶点')
    ok(o.worstRel < 1e-6, `① ${-o.lrel} dB：每个线顶点离轴角 = 闭式半角（相对 < 1e-6）`, o.worstRel.toExponential(2))
    ok(o.worstDb < 1e-4, `① ${-o.lrel} dB：每个线顶点 sampleBeamAt = 档值（< 1e-4 dB）`, o.worstDb.toExponential(2) + ' dB')
    ok(o.devV < 0.0005, `① ${-o.lrel} dB：线顶点对精确足迹 < 0.5 m`, (o.devV * 1000).toFixed(3) + ' m')
    ok(o.devM < 0.5, `① ${-o.lrel} dB：线段中点（弦矢高）对精确足迹 < 0.5 km`, (o.devM * 1000).toFixed(1) + ' m')
  }
  // stk.md 测试向量 #8：−3 dB 半角 0.79911249°（系数 2.76 下是 θ3/2 处 −2.99663 dB，−3 dB 处半角略大于 θ3/2）
  const th3 = recGeo.beams[0].th3, thm3 = th3 * Math.sqrt(3 / kDbOf('stk'))
  ok(Math.abs(thm3 - 0.79911249) < 1e-7, '① −3 dB 半角 = STK 测试向量 #8（0.79911249°）', thm3.toFixed(8) + '°')
}

// ============ ② LEO 550 km / 45°N，偏轴波束 az 35° el −10°，θ3 = 4° ============
const LEO = { lon: 10, lat: 45, alt: 550 }
const MODEL_BW = { id: 'm1', name: 'BW4', fGHz: 20, drv: 'bw', D: 0, bw3: 4, G: 0, eff: 55, back: -30, k: 'stk' }
const recLeo = buildRecord({ sat: { name: 'LEO', lon: LEO.lon, lat: LEO.lat, altKm: LEO.alt }, models: [MODEL_BW], beams: [{ name: 'b1', az: 35, el: -10, model: 'm1' }] })
const basisLeo = antennaBasis(LEO.lon, LEO.lon, LEO.lat, 0, LEO.lat, LEO.alt)
let leo
{
  ok(Math.abs(recLeo.beams[0].th3 - 4) < 1e-12 && Math.abs(recLeo.beams[0].g0 - 10 * Math.log10((180 / 4) ** 2)) < 1e-9, '② 波束宽驱动：θ3 = 4°、G0 = (180/θ3)²（与效率无关）', recLeo.beams[0].g0.toFixed(6) + ' dBi')
  leo = contourCheck('② LEO', recLeo, basisLeo, [-1, -3, -10])
  for (const o of leo.out) {
    ok(o.worstRel < 1e-6, `② ${-o.lrel} dB：偏轴 35°/−10° 波束每个线顶点离轴角 = 闭式半角（相对 < 1e-6，无 cos(az) 模型误差）`, o.worstRel.toExponential(2))
    ok(o.worstDb < 1e-4, `② ${-o.lrel} dB：每个线顶点 sampleBeamAt = 档值（< 1e-4 dB）`, o.worstDb.toExponential(2) + ' dB')
    ok(o.devV < 0.0005 && o.devM < 0.5, `② ${-o.lrel} dB：对精确足迹 顶点 < 0.5 m、线段中点 < 0.5 km`, `${(o.devV * 1000).toFixed(2)} m / ${(o.devM * 1000).toFixed(1)} m`)
  }
  // 对照：旧 buildGaussGrd（在天底 az/el 网格坐标里算 (Δaz, Δel)）同一波束沿 el 向的 −3 dB 真实半角
  const legacy = parseGrd(buildGaussGrd({ satName: 'LEO', satLon: LEO.lon, satLat: LEO.lat, altKm: LEO.alt, effPct: 55, beams: [{ az: 35, el: -10, thX: 4, thY: 4, rot: 0 }] }))
  const ls = legacy.sets[0]
  const lb = { P1: ls.P1, P2: ls.P2, c1re: ls.c1re, c1im: ls.c1im, c2re: ls.c2re, c2im: ls.c2im, grid: { XS: ls.XS, YS: ls.YS, XE: ls.XE, YE: ls.YE, NX: ls.NX, NY: ls.NY } }
  const at = (x, y) => sampleBeamAtParam(lb, [x, y], 1, { pol: 'RSS' }).db
  const pk0 = at(35, -10)
  const halfAlong = (dx, dy) => { let lo = 0, hi = 4; for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (at(35 + dx * m, -10 + dy * m) > pk0 - 3) lo = m; else hi = m } return ang(gridDir(6, 35, -10), gridDir(6, 35 + dx * lo, -10 + dy * lo)) * R2D }
  const want = 4 * Math.sqrt(3 / (10 * Math.LOG10E * 4 * Math.LN2))   // 旧模型自己的口径（4ln2）：−3 dB 半角
  const hEl = halfAlong(0, 1), hAz = halfAlong(1, 0)
  const eEl = hEl / want - 1, eAz = hAz / want - 1
  console.log(`      旧 buildGaussGrd 对照：−3 dB 真实半角 el 向 ${hEl.toFixed(4)}°、az 向 ${hAz.toFixed(4)}°，模型本意 ${want.toFixed(4)}° → el 向 ${(eEl * 100).toFixed(1)}%、az 向 ${(eAz * 100).toFixed(2)}%`)
  ok(eEl < -0.15, '② 对照：旧模型沿 el 向半角缩成 cos(35°) 倍（证明这道检查量得出模型误差）', (eEl * 100).toFixed(1) + '%')
}

// ============ ③ 点取值 ≡ 闭式；窗外 null ============
for (const [tag, rec, basis] of [['GEO', recGeo, basisGeo], ['LEO', recLeo, basisLeo]]) {
  const set = materialize(rec).sets[0], an = set.an, beam = beamOf(set, basis), W = anWindow(an)
  const R = rng(tag === 'GEO' ? 7 : 11)
  let n = 0, worst = 0, worstE = 0, nullIn = 0, tries = 0
  while (n < 500 && tries < 5000) {
    tries++
    const X = W.XS + (W.XE - W.XS) * R(), Y = W.YS + (W.YE - W.YS) * R()
    // 射线交椭球：用 coverage 的投影同一套（projectGrid 单点）
    const one = projectGrid({ XS: X, YS: Y, XE: X + 1, YE: Y + 1, NX: 2, NY: 2 }, 6, basis, { r0: 0, r1: 0, c0: 0, c1: 0 }, null, false)
    if (!(one.vis[0] >= 0)) continue
    const lon = one.lon[0], lat = one.lat[0]
    const P = geodeticToEcef(lon, lat, 0), S = basis.S
    const e = nrm(sub(P, S)), a = dot(e, basis.x), b = dot(e, basis.y), c = dot(e, basis.z)
    const exact = anGainDbi(an, a, b, c)
    const r = sampleBeamAt(beam, 6, basis, lon, lat, { pol: 'RSS' })
    const rE = sampleBeamAtEcef(beam, 6, basis, P, { pol: 'RSS' })
    if (!r || !rE) { nullIn++; continue }
    worst = Math.max(worst, Math.abs(r.db - exact)); worstE = Math.max(worstE, Math.abs(rE.db - exact))
    n++
  }
  ok(n === 500 && nullIn === 0, `③ ${tag}：窗内 500 个地面点都取得到值`, `${n} 点 / 窗内 null ${nullIn}`)
  ok(worst < 1e-9 && worstE < 1e-9, `③ ${tag}：sampleBeamAt / sampleBeamAtEcef ≡ anGainDbi（≤ 1e-9 dB）`, `${worst.toExponential(2)} / ${worstE.toExponential(2)} dB`)
  // 窗外：X 越出 [XS, XE] 或 Y 越出 [YS, YE]（仍打在地球上）→ null
  let nOut = 0, bad = 0
  for (const [X, Y] of [[W.XE + 0.3, an.el], [W.XS - 0.3, an.el], [an.az, W.YE + 0.3], [an.az, W.YS - 0.3]]) {
    const one = projectGrid({ XS: X, YS: Y, XE: X + 1, YE: Y + 1, NX: 2, NY: 2 }, 6, basis, { r0: 0, r1: 0, c0: 0, c1: 0 }, null, false)
    if (!(one.vis[0] >= 0)) continue
    nOut++
    if (sampleBeamAt(beam, 6, basis, one.lon[0], one.lat[0], { pol: 'RSS' }) !== null) bad++
  }
  ok(nOut >= 2 && bad === 0, `③ ${tag}：窗外地面点 → null（与 GRD 网格域同一口径）`, `${nOut} 点`)
  // 共极化之外无值（与合成 GRD 的 icomp 3 / c2 ≡ 0 同形）；AR 分量 re1 = √p
  const r2 = sampleBeamAtParam(beam, [an.az, an.el], 1, { pol: 'P2' }), rc = sampleBeamAtParam(beam, [an.az, an.el], 1, { pol: 'RSS', wantComp: true })
  ok(r2 === null && rc && rc.comp && Math.abs(rc.comp.re1 * rc.comp.re1 - Math.pow(10, an.g0 / 10)) / Math.pow(10, an.g0 / 10) < 1e-12 && rc.comp.re2 === 0, `③ ${tag}：P2 无值、comp.re1 = √p`)
}

// ============ ④ 峰值 / Whittaker / projectRefine 旗标 ============
{
  const { beam, an, field, basis } = leo
  ok(refinedPeakDb(beam, 'RSS') === an.g0 && refinedPeakDb(beam, 'P1') === an.g0, '④ refinedPeakDb = g0（RSS / P1 逐位）', String(an.g0))
  ok(refinedPeakDb(beam, 'P2') === null && refinedPeakDb(beam, 'P1/P2') === null, '④ refinedPeakDb：P2 / P1/P2 无值（null）')
  ok(peakRefDb(beam, field, 'RSS', 2.5, 'none') === an.g0 + 2.5, '④ peakRefDb（无路损）= g0 + 增益偏置')
  // 格点最大值低于真峰（峰在格点之间也照样精确）：偏一点的视轴
  const recOff = buildRecord({ sat: null, models: [MODEL_BW], beams: [{ az: 35.0123, el: -9.9877, model: 'm1' }] })
  const sOff = materialize(recOff).sets[0], bOff = beamOf(sOff, basis)
  const fOff = fieldDb({ P1: bOff.P1, P2: bOff.P2, NX: sOff.NX, NY: sOff.NY }, null, { pol: 'RSS' })
  ok(refinedPeakDb(bOff, 'RSS') === sOff.an.g0 && fOff.max <= sOff.an.g0, '④ 视轴不在格点上：峰值仍是 g0（格点最大值 ≤ g0）', `格点 ${fOff.max.toFixed(6)} / g0 ${sOff.an.g0.toFixed(6)}`)

  // Whittaker：解析波束重铺（节点 = materializeBeam 同密度逐位），同窗口；取值仍精确
  const w = whittakerBeam(beam, 3)
  const ref3 = materializeBeam(an, 3 * (beam.grid.NX - 1) + 1)
  let same = w.grid.NX === ref3.NX && w.grid.XS === beam.grid.XS && w.grid.XE === beam.grid.XE && w.grid.YS === beam.grid.YS && w.grid.YE === beam.grid.YE && w.an === an && w._dens === 3
  for (let i = 0; same && i < ref3.P1.length; i++) if (w.P1[i] !== ref3.P1[i] || w.c1re[i] !== ref3.c1re[i]) same = false
  ok(same && whittakerBeam(beam, 3) === w, '④ Whittaker 密度 3：解析波束按 3 倍密度重铺（节点逐位 = 闭式、窗口不变、缓存命中）', `${w.grid.NX}×${w.grid.NY}`)
  const xy = [an.az + 1.234, an.el - 0.567]
  ok(Math.abs(sampleBeamAtParam(w, xy, 1, { pol: 'RSS' }).db - sampleBeamAtParam(beam, xy, 1, { pol: 'RSS' }).db) < 1e-12, '④ Whittaker 派生波束取值与原波束同一闭式')

  // projectRefine：同一张表，去掉 grid.exact（= 网格天线口径）→ GEO 天底高仰角格子一个都不逐点求交
  const b0 = beamOf(materialize(recGeo).sets[0], basisGeo)
  const f0 = fieldDb({ P1: b0.P1, P2: b0.P2, NX: b0.grid.NX, NY: b0.grid.NY }, b0.proj, { pol: 'RSS' })
  const rf0 = edgeRefineFor(b0, f0, [b0.an.g0 - 3], 'RSS', 0)
  const pE = projectRefine(rf0, b0.grid, 6, basisGeo, b0.proj)
  const pG = projectRefine(rf0, { ...b0.grid, exact: undefined }, 6, basisGeo, b0.proj)
  ok(pE.exact === rf0.n + rf0.nm && pG.exact === 0, '④ grid.exact 只改解析天线：网格口径（无旗标）高仰角照旧线性插值', `exact ${pE.exact} / 无旗标 ${pG.exact}`)
}

// ============ ④b Whittaker 密度 > 1 × 解析天线：细化表照建（对地 / 对星 / 导出四处同一道门 refineAtDens）============
// 按应用同一条路在密度 N 的派生波束上出线（门 = refineAtDens），逐顶点对闭式；对照：同一派生波束不建表（旧门）的误差。
{
  const { beam, an, basis } = leo
  const S = basis.S, axis = toEcef(basis, gridDir(6, an.az, an.el)), th3 = an.th3 * D2R, kdb = kDbOf(an.k)
  const lineErr = (w, useRefine) => {
    if (!w.proj) w.proj = projectGrid(w.grid, 6, basis, null, null, true)
    const field = fieldDb({ P1: w.P1, P2: w.P2, NX: w.grid.NX, NY: w.grid.NY }, w.proj, { pol: 'RSS' })
    const pk = peakRefDb(w, field, 'RSS', 0, 'none')
    const asc = [-10, -3, -1].map((r) => pk + r).sort((a, b) => a - b)
    const refine = useRefine ? edgeRefineFor(w, field, asc, 'RSS', 0) : null
    const pos = refine ? projectRefine(refine, w.grid, 6, basis, w.proj) : null
    const geo = bandGeometry({ lon: w.proj.lon, lat: w.proj.lat, vis: w.proj.vis, db: field.db, NX: w.grid.NX, NY: w.grid.NY }, asc, false, null, null, 1, refine, pos)
    let worstDb = 0, worstRel = 0, nv = 0
    asc.forEach((L, k) => {
      const thL = th3 * Math.sqrt((pk - L) / kdb)
      for (const sg of geo.lines[k]) for (const p of sg) {
        nv++
        const r = sampleBeamAt(beam, 6, basis, p[0], p[1], { pol: 'RSS' })
        worstDb = Math.max(worstDb, r ? Math.abs(r.db - L) : Infinity)
        const th = ang(nrm(sub(geodeticToEcef(p[0], p[1], 0), S)), axis)
        worstRel = Math.max(worstRel, Math.abs(th - thL) / thL)
      }
    })
    return { worstDb, worstRel, nv }
  }
  for (const N of [2, 4]) {
    const w = whittakerBeam(beam, N)
    ok(w._dens === N && w.an === an && refineAtDens(w), `④b 密度 ${N}：解析派生波束过得了细化门`)
    const e = lineErr(w, refineAtDens(w)), e0 = lineErr(w, false)
    console.log(`      ④b 密度 ${N}（${w.grid.NX}×${w.grid.NY}）：建表 取值 |Δ| ≤ ${e.worstDb.toExponential(2)} dB、离轴角相对 ≤ ${e.worstRel.toExponential(2)}；不建表（旧门） ${e0.worstDb.toExponential(2)} dB / ${e0.worstRel.toExponential(2)}`)
    ok(e.nv > 100 && e.worstDb < 1e-6 && e.worstRel < 1e-6, `④b 密度 ${N}：线顶点 = 档值（< 1e-6 dB）、离轴角 = 闭式半角（相对 < 1e-6）`, `${e.worstDb.toExponential(2)} dB / ${e.worstRel.toExponential(2)}`)
    ok(e0.worstDb > 1e-5, `④b 密度 ${N} 对照：不建表误差大两三个量级以上（证明这道检查量得出旧门的退化）`, e0.worstDb.toExponential(2) + ' dB')
  }
  // 网格天线（无 an）：密度 > 1 照旧不建（SATSOFT 口径，逐位不变）；密度 1 照旧建
  const grd = { ...beam, an: undefined, grid: { ...beam.grid, exact: undefined }, _whit: null }
  ok(!refineAtDens(whittakerBeam(grd, 2)) && refineAtDens(grd) && refineAtDens(beam), '④b 网格天线密度 > 1 不建细化表；密度 1 / 解析天线照建')
}

// ============ ⑤ useGrdCoverage：新建 / 就地改 / 读记录 / 存档往返 / 无星历 ============
{
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() }
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => { fn(0); return 0 })
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {})
  const files = new Map(), writes = []
  let inflight = 0, maxInflight = 0
  globalThis.window = {
    api: { coverageGrd: {
      save: async (nm, text) => { let f = String(nm).replace(/[^\w.\-]+/g, '_'), i = 1; while (files.has(f)) f = String(nm).replace(/\.gauss\.json$/i, '') + '_' + (++i) + '.gauss.json'; files.set(f, text); return { file: f } },
      raw: async (f) => { if (!files.has(f)) throw new Error('无此文件 ' + f); return { text: files.get(f) } },
      overwrite: async (f, text) => { inflight++; maxInflight = Math.max(maxInflight, inflight); await new Promise((r) => setTimeout(r, 60)); writes.push({ f, text }); files.set(f, text); inflight--; return { ok: true } },
      remove: (f) => { files.delete(f); return { ok: true } },
      open: async () => { opened++; return { canceled: true } }      // 导入 GRD 的文件框：只记开没开
    } },
    addEventListener () {}, removeEventListener () {}
  }
  let opened = 0
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const { useGrdCoverage } = await import('../../../src/viz/grd/useGrdCoverage.js')
  const { alertMsg } = await import('../../../src/stores/alert.js')
  let faced = 0, lastLayers = null
  const scene = { faceLonLat () { faced++ }, updateCoverageField (layers) { lastLayers = layers }, setCoverageField (layers) { lastLayers = layers }, patchCoverageLayers () {}, viewMetrics: () => null, setBeamDragMode () {}, setLabelDragMode () {} }
  const g = useGrdCoverage(() => scene, () => null, () => false, {})
  const node = g.addSatellite({ name: 'GEO0', lon: 0, lat: 0, altKm: GEO_ALT })
  const key = await g.createAnalyticAntenna(node.folder, { name: 'Gauss', record: recGeo, settings: { ctype: 'rel', levels: [-3, -1] } })
  const a = node.antennas.find((x) => x.name === 'Gauss')
  const ctx = g.getPerfContext(key)
  ok(key === node.folder + '|Gauss' && a && a.analytic === true && a.synth === false && a.imported === true && /\.gauss\.json$/.test(a.file) && files.get(a.file) === recordToText(recGeo),
    '⑤ createAnalyticAntenna：入树（analytic / imported）、按 .gauss.json 存参数记录', a && a.file)
  const st = ctx.settings
  ok(st.boreType === 'azel' && st.boreAz === 0 && st.boreEl === 0 && st.boreLock === false && st.ctype === 'rel' && st.levels.map((L) => L.v).join(',') === '-3,-1' && st.beamsToPlot.join(',') === '0',
    '⑤ 出厂设置：本体固定天底（不锁定）+ 传入的 ctype / 档位 + 全部波束')
  ok(ctx.beams[0].beam.an && ctx.beams[0].beam.grid.exact === true && ctx.beams[0].peakDb === +recGeo.beams[0].g0.toFixed(3) && g.active.value === key && g.selected.value.includes(key) && faced === 0,
    '⑤ 波束带 an / grid.exact、峰值 = g0（3 位）、已聚焦已勾选、不转镜头')
  ok(Array.isArray(lastLayers) && lastLayers.length === 1 && lastLayers[0].segGroups.length === 2, '⑤ 画出来：1 个波束层、2 档线')
  // Whittaker 密度 4：屏上的线（buildBeamLayer 那道门）仍逐顶点 = 档值（旧门在这里退到 ~1e-3 dB）
  {
    const lineWorst = () => {
      const L0 = (lastLayers || []).find((L) => L.id === key + '#0'), cx = g.getPerfContext(key), b0 = cx.beams[0].beam
      let w = 0, nv = 0
      for (const sg of (L0 ? L0.segGroups : [])) {
        const lv = b0.an.g0 + cx.settings.levels[sg.idx].v   // 相对档：峰值 = g0（增益偏置 0）
        for (const seg of sg.segs) for (const p of seg) { nv++; const r = sampleBeamAt(b0, 6, cx.basis, p[0], p[1], { pol: 'RSS' }); w = Math.max(w, r ? Math.abs(r.db - lv) : Infinity) }
      }
      return { w, nv }
    }
    const d1 = lineWorst()
    g.s.whitDens = 4; await sleep(0)
    const d4 = lineWorst()
    g.s.whitDens = 1; await sleep(0)
    ok(d4.nv > 2 * d1.nv && d4.w < 1e-6 && d1.w < 1e-6, '⑤ Whittaker 密度 4：解析天线屏上的线照建细化表，顶点 = 档值（< 1e-6 dB）', `密度 1 ${d1.nv} 顶点 ${d1.w.toExponential(2)} dB / 密度 4 ${d4.nv} 顶点 ${d4.w.toExponential(2)} dB`)
  }
  const k2 = await g.createAnalyticAntenna(node.folder, { name: 'Gauss', record: recGeo, activate: false, select: false })
  ok(k2 === node.folder + '|Gauss·2' && g.active.value === key, '⑤ 同星重名 → 「·2」；activate:false 不抢聚焦', k2)
  const cp = g.analyticRecordOf(key)
  cp.beams[0].az = 99
  ok(g.analyticRecordOf(key).beams[0].az === 0 && g.analyticRecordOf(node.folder + '|nope') === null, '⑤ analyticRecordOf 给深拷贝；没有的 key → null')
  // 就地改：连发 5 次（最后一份是两波束），写盘合帧 → 至多一笔在途 + 静默后补写最后一份
  const recs = [0.1, 0.2, 0.3, 0.4].map((d) => buildRecord({ sat: recGeo.sat, models: [MODEL_D], beams: [{ name: 'b1', az: d, el: 0, model: 'm1' }] }))
  const rec2 = buildRecord({ sat: recGeo.sat, models: [MODEL_D], beams: [{ name: 'b1', az: 0.5, el: 0, model: 'm1' }, { name: 'b2', az: -2, el: 1, model: 'm1' }] })
  const rev0 = g.anRev.value
  for (const r of recs) ok(g.updateAnalyticAntenna(key, r), '⑤ updateAnalyticAntenna（单波束改视轴）')
  ok(g.updateAnalyticAntenna(key, rec2), '⑤ updateAnalyticAntenna（改成两波束）')
  const c2 = g.getPerfContext(key)
  ok(c2.beams.length === 2 && c2.settings.beamsToPlot.join(',') === '0,1' && g.s.beamsToPlot.join(',') === '0,1' && a.beams === 2 && g.anRev.value === rev0 + 5 && key === g.active.value,
    '⑤ 波束数变了 → 画全部波束、树行波束数跟上、key 不变、anRev 逐次 +1')
  ok(c2.settings.levels.map((L) => L.v).join(',') === '-3,-1' && c2.settings.ctype === 'rel', '⑤ 就地改保留天线设置（档位 / 类型）')
  ok(Math.abs(c2.meta.satLon) < 1e-12 && c2.beams[1].beam.an.az === -2, '⑤ 天线系按当前 meta 星位重铺（不跳）')
  const pn = c2.patternNow && c2.patternNow()
  ok(c2.anRev === 5 && c2.meta.anRev === 5 && ctx.anRev === 0 && !Object.keys(c2).includes('patternNow') && pn && pn.anRev === 5 && pn.beams.length === 2 && pn.beams[1].beam === c2.beams[1].beam && ctx.patternNow().beams[1].beam === c2.beams[1].beam,
    '⑤ 逐天线方向图修订号：每次就地改 meta.anRev +1、上下文带 anRev；patternNow（不可枚举）按条目现取 —— 旧上下文也取得到新波束', `${ctx.anRev} → ${c2.anRev}`)
  await sleep(600)
  ok(writes.length === 1 && writes[0].f === a.file && writes[0].text === recordToText(rec2) && files.get(a.file) === recordToText(rec2), '⑤ 写盘合帧：5 次改动只落 1 笔、落的是最后一份', `${writes.length} 笔`)
  g.updateAnalyticAntenna(key, recs[0]); await sleep(275)       // 静默期满、第一笔在途（替身写 60 ms）
  g.updateAnalyticAntenna(key, recs[1]); g.updateAnalyticAntenna(key, rec2)   // 在途期间又改两次
  await sleep(700)
  ok(writes.length === 3 && writes[1].text === recordToText(recs[0]) && writes[2].text === recordToText(rec2) && files.get(a.file) === recordToText(rec2) && maxInflight === 1,
    '⑤ 在途期间再改：至多一笔在途，静默后补写最后一份（last record wins）', `${writes.length} 笔 · 同时在途 ≤ ${maxInflight}`)
  // 存档往返：getState → 新实例 restoreState → loadAntenna 从 .gauss.json 重建
  const state = JSON.parse(JSON.stringify(g.getState()))
  const sa = state.sats.find((x) => x.folder === node.folder).antennas.find((x) => x.name === 'Gauss')
  ok(sa && sa.analytic === true && sa.file === a.file, '⑤ getState 存下 analytic 旗标与文件')
  const g2 = useGrdCoverage(() => null, () => null, () => false, {})
  await g2.restoreState(state)
  ok(await g2.ensureAntLoaded(key), '⑤ restoreState 后能载入')
  const r2 = g2.analyticRecordOf(key), c3 = g2.getPerfContext(key)
  ok(JSON.stringify(r2) === JSON.stringify(JSON.parse(recordToText(rec2))) && c3.beams.length === 2 && c3.beams.every((b) => b.beam.an && b.beam.grid.exact) && c3.settings.boreLock === false && c3.settings.levels.map((L) => L.v).join(',') === '-3,-1',
    '⑤ 往返：记录、波束（an / exact）、设置（不锁定、档位）原样')
  const n2 = g2.sats.value.find((x) => x.folder === node.folder).antennas.find((x) => x.name === 'Gauss')
  ok(n2 && n2.analytic === true, '⑤ 往返：树行 analytic 旗标')
  // setActive({face:false}) 不转镜头；缺省照旧转
  faced = 0
  await g.setActive(node, node.antennas.find((x) => x.name === 'Gauss·2'), { face: false })
  const f1 = faced
  await g.setActive(node, a)
  ok(f1 === 0 && faced === 1, '⑤ setActive({face:false}) 不转镜头；缺省转', `${f1} / ${faced}`)
  // 删天线：文件跟着删，待写撤掉
  g.updateAnalyticAntenna(key, recs[1])
  g.removeAntenna(node.folder, 'Gauss')
  await sleep(400)
  ok(!files.has(a.file), '⑤ 删天线：文件删掉、待写撤掉（不被写回来）')

  // 关联星：注入的解算器解不出 → 拒建 / 不画 / noEph；解得出 → 恢复
  const live = { on: true, lon: 10.5 }
  const g3 = useGrdCoverage(() => scene, () => null, () => false, {})
  g3.setLivePos((sat) => (sat.noradId ? (live.on ? { lon: live.lon, lat: 0, altKm: GEO_ALT } : null) : null))
  const ln = g3.addSatellite({ name: 'LNK', noradId: '99999', lon: 3, lat: 0, altKm: GEO_ALT })
  const fx = g3.addSatellite({ name: 'FIX', lon: 20, lat: 0, altKm: GEO_ALT })
  const kL = await g3.createAnalyticAntenna(ln.folder, { name: 'A', record: recGeo })
  ok(Math.abs(g3.getPerfContext(kL).meta.satLon - 10.5) < 1e-12, '⑤ 关联星：按注入的活位置建天线系（不是节点里存的旧经度）')
  const kF = await g3.createAnalyticAntenna(fx.folder, { name: 'B', record: recGeo })
  ok(Math.abs(g3.getPerfContext(kF).meta.satLon - 20) < 1e-12, '⑤ 固定星：注入函数给 null → 仍退节点静态位置（行为不变）')
  lastLayers = null
  live.on = false
  const tk = g3.tickLive()
  const ids = (lastLayers || []).map((L) => L.id)
  const pc = g3.getPerfContext(kL)
  ok(tk.changed && tk.moved.has(kL) && !ids.some((id) => id.startsWith(kL)) && ids.some((id) => id.startsWith(kF)), '⑤ 关联星丢星历：该星的覆盖撤下（固定星照画）', ids.join(' '))
  ok(pc && pc.noEph === true && pc.basis === null && pc.beams.length === 0 && Math.abs(pc.meta.satLon - 10.5) < 1e-12, '⑤ getPerfContext 标 noEph、basis null、无波束；meta 不被挪到旧存位置')
  ok(g3.tickLive().changed === false, '⑤ 停在无星历：之后的拍不再白算')
  let err = ''
  try { await g3.createAnalyticAntenna(ln.folder, { name: 'C', record: recGeo }) } catch (e) { err = e.message }
  ok(err === '关联卫星当前无星历', '⑤ 无星历时新建 → 拒绝（关联卫星当前无星历）', err)
  alertMsg.value = ''
  const got = await g3.importGrd(ln)
  ok(Array.isArray(got) && got.length === 0 && alertMsg.value === '关联卫星当前无星历' && opened === 0, '⑤ 无星历时导入 GRD → 不开文件框，提示「关联卫星当前无星历」')
  live.on = true
  const tk2 = g3.tickLive()
  ok(tk2.changed && (lastLayers || []).some((L) => L.id.startsWith(kL)) && !g3.getPerfContext(kL).noEph, '⑤ 星历回来：覆盖与上下文恢复')

  // setEphReady：星历源（启动时的搜索池）还没备好 → 先等它，再下「无星历」的结论（新建 / 导入 GRD 两个入口）
  let waited = 0
  g3.setEphReady(() => { waited++; return new Promise((r) => setTimeout(() => { live.on = true; r() }, 20)) })
  live.on = false; g3.tickLive()
  let kC = null; err = ''
  try { kC = await g3.createAnalyticAntenna(ln.folder, { name: 'C', record: recGeo, select: false, activate: false }) } catch (e) { err = e.message }
  ok(kC && !err && waited === 1 && Math.abs(g3.getPerfContext(kC).meta.satLon - live.lon) < 1e-12, '⑤ setEphReady：池还在建 → 新建先等池、按解出来的活位置建（不误报无星历）', err || kC)
  live.on = false; g3.tickLive(); alertMsg.value = ''; opened = 0
  const got2 = await g3.importGrd(ln)
  ok(Array.isArray(got2) && waited === 2 && opened === 1 && alertMsg.value === '', '⑤ setEphReady：池还在建 → 导入 GRD 先等池、再开文件框', `等 ${waited} 次 · 文件框 ${opened} 次 · 提示「${alertMsg.value}」`)
  g3.setEphReady(() => null)                                     // 池已备好（没什么可等）：照旧拒绝
  live.on = false; err = ''
  try { await g3.createAnalyticAntenna(ln.folder, { name: 'D', record: recGeo }) } catch (e) { err = e.message }
  ok(err === '关联卫星当前无星历', '⑤ setEphReady 说已备好、仍解不出 → 照旧拒绝', err)
  g3.setEphReady(null)

  // invalidateLive：换星历源（池换了）不等时钟走 —— 备忘作废 + 缓存里全部天线按新源对一遍星位（含没画着的）
  live.on = true; live.lon = 10.5; g3.tickLive()
  live.on = false                                                // (a) 新池里没有这颗星了
  g3.recompute()
  const staleDrawn = (lastLayers || []).some((L) => L.id.startsWith(kL))
  const iv1 = g3.invalidateLive()
  ok(iv1.moved.has(kL) && iv1.moved.has(kC) && !(lastLayers || []).some((L) => L.id.startsWith(kL)) && g3.getPerfContext(kL).noEph && g3.getPerfContext(kC).noEph,
    '⑤ invalidateLive (a)：池里没了 → 当场撤图、上下文标 noEph（含没画着的天线）', `换池后只 recompute：${staleDrawn ? '仍照画（上一拍的备忘）' : '已撤'}`)
  live.on = true; live.lon = 12.25                               // (b) 新池解得出（且位置不同）
  g3.recompute()
  const staleHidden = !(lastLayers || []).some((L) => L.id.startsWith(kL))
  const iv2 = g3.invalidateLive()
  const pL = g3.getPerfContext(kL), pC = g3.getPerfContext(kC)
  ok(iv2.changed && iv2.moved.has(kL) && (lastLayers || []).some((L) => L.id.startsWith(kL)) && !pL.noEph && Math.abs(pL.meta.satLon - 12.25) < 1e-12 && !pC.noEph && Math.abs(pC.meta.satLon - 12.25) < 1e-12,
    '⑤ invalidateLive (b)：池里有了 → 当场画出，星位是新源解出的活位置（没画着的天线 meta 一并挪到）', `${pL.meta.satLon} / ${pC.meta.satLon} · 换池后只 recompute：${staleHidden ? '仍不画（上一拍的备忘）' : '已画'}`)
}

// ============ ⑤c 等星历源 / 存盘期间的竞态（importGrd / createAnalyticAntenna / importSynthGrd）============
// 等星历源（setEphReady）那段没有模态文件框挡着：期间卫星被删（树行 ✕ 一键删）→ 不往脱树的节点里建（旧：key 入勾选 / 聚焦、
// 画在图上、存了盘，树上却没有行可删）；再点一次导入 → 不另开一个文件框（旧：等完先后弹两个、入两副同名天线）；等待期间亮 loading。
// 存盘途中被删 → 刚存的文件撤掉、不交回 key。复现脚本 = review2/race.mjs。
{
  const prevWin = globalThis.window
  if (!globalThis.localStorage) { const mem = new Map(); globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() } }
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => { fn(0); return 0 })
  globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {})
  const { toGrdText } = await import('../../../src/viz/grd/gaussStk.js')
  const { useGrdCoverage } = await import('../../../src/viz/grd/useGrdCoverage.js')
  const { alertMsg } = await import('../../../src/stores/alert.js')
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const until = async (fn, ms = 2000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await sleep(2) } return true }
  const deferred = () => { let release; const p = new Promise((r) => { release = r }); return { p, release } }
  const files = new Map()
  let opened = 0, saveCalls = 0, saveGate = null, seq = 0
  const grdText = toGrdText(recGeo)
  let openFiles = [{ base: 'x.grd', text: grdText }]
  globalThis.window = {
    api: { coverageGrd: {
      save: async (nm, text) => { const n = ++saveCalls; if (saveGate && saveGate.at === n) await saveGate.p; const f = String(nm).replace(/[^\w.\-]+/g, '_') + '#' + (++seq); files.set(f, text); return { file: f } },
      raw: async (f) => ({ text: files.get(f) }),
      overwrite: async () => ({ ok: true }),
      remove: (f) => { files.delete(f); return { ok: true } },
      open: async () => { opened++; return { files: openFiles.map((x) => ({ ...x })) } }
    } },
    addEventListener () {}, removeEventListener () {}
  }
  let lastLayers = null
  const scene = { faceLonLat () {}, updateCoverageField (l) { lastLayers = l }, setCoverageField (l) { lastLayers = l }, patchCoverageLayers () {}, viewMetrics: () => null, setBeamDragMode () {}, setLabelDragMode () {} }
  const g = useGrdCoverage(() => scene, () => null, () => false, {})
  const live = { on: true }
  let eph = null                                                  // 在等的星历源（null = 已备好）
  g.setLivePos((sat) => (sat.noradId ? (live.on ? { lon: 10, lat: 0, altKm: GEO_ALT } : null) : null))
  g.setEphReady(() => (eph ? eph.p : null))
  const arm = () => { live.on = false; g.tickLive(); const d = deferred(); eph = { p: d.p, release: () => { live.on = true; eph = null; d.release() } } }
  // 该 folder 下的天线还挂在勾选 / 聚焦 / 图上 → 幽灵
  const ghost = (fold) => [...g.selected.value, g.active.value].some((k) => k && k.startsWith(fold + '|')) || (lastLayers || []).some((L) => L.id.startsWith(fold + '|'))
  const f0 = files.size

  // (1) 新建解析天线：等星历源期间卫星被删
  arm(); lastLayers = null
  const n1 = g.addSatellite({ name: 'LNK', noradId: '99999', lon: 3, lat: 0, altKm: GEO_ALT })
  const p1 = g.createAnalyticAntenna(n1.folder, { name: 'A', record: recGeo })
  await sleep(5)
  g.removeSatellite(n1.folder)
  eph.release()
  let err = '', k1 = null
  try { k1 = await p1 } catch (e) { err = e.message }
  ok(k1 === null && err === '目标卫星不存在' && !ghost(n1.folder) && !g.getPerfContext(n1.folder + '|A') && files.size === f0,
    '⑤c 新建解析天线：等星历源期间卫星被删 → 抛「目标卫星不存在」，不留幽灵天线 / 孤儿文件', err)

  // (2) 导入 GRD：等星历源期间亮 loading；卫星被删 → 不开文件框
  arm(); lastLayers = null; opened = 0; alertMsg.value = ''
  const n2 = g.addSatellite({ name: 'LNK2', noradId: '88888', lon: 3, lat: 0, altKm: GEO_ALT })
  const p2 = g.importGrd(n2)
  await sleep(5)
  const busy2 = g.loading.value
  g.removeSatellite(n2.folder)
  eph.release()
  const k2 = await p2
  ok(busy2 === true && Array.isArray(k2) && k2.length === 0 && opened === 0 && alertMsg.value === '目标卫星不存在' && !ghost(n2.folder) && files.size === f0 && g.loading.value === false,
    '⑤c 导入 GRD：等星历源期间亮 loading；卫星被删 → 不开文件框、不建天线（提示「目标卫星不存在」）', `loading ${busy2} · 文件框 ${opened} 次 · 「${alertMsg.value}」`)

  // (3) 导入 GRD：等待期间再点一次 → 立刻返回，不另起一轮
  arm(); opened = 0
  const n3 = g.addSatellite({ name: 'LNK3', noradId: '77777', lon: 3, lat: 0, altKm: GEO_ALT })
  const pa = g.importGrd(n3)
  await sleep(5)
  const pb = g.importGrd(n3)
  const kb = await Promise.race([pb, sleep(50).then(() => 'pending')])
  eph.release()
  const ka = await pa
  await pb
  ok(Array.isArray(kb) && kb.length === 0 && ka.length === 1 && ka[0] === n3.folder + '|x' && opened === 1 && n3.antennas.map((a) => a.name).join(',') === 'x' && g.loading.value === false,
    '⑤c 导入 GRD：等待期间再点一次 → 立刻返回、只开一次文件框、只入一副天线', `第二次 ${JSON.stringify(kb)} · 文件框 ${opened} 次 · 天线 ${n3.antennas.map((a) => a.name).join(',')}`)
  const kc = await g.importGrd(n3)
  ok(kc.length === 1 && kc[0] === n3.folder + '|x·' && opened === 2 && g.active.value === kc[0], '⑤c 上一轮导入结束后门放开：再导入照常（同名加「·」）', JSON.stringify(kc))

  // (4) 导入 GRD（两个文件）：第二个存盘途中卫星被删 → 刚存的文件撤掉；已入树的第一副随星清掉；不交回 key
  const fA = files.size
  const n4 = g.addSatellite({ name: 'LNK4', noradId: '66666', lon: 3, lat: 0, altKm: GEO_ALT })
  openFiles = [{ base: 'p.grd', text: grdText }, { base: 'q.grd', text: grdText }]
  saveCalls = 0; saveGate = { at: 2, ...deferred() }; lastLayers = null
  const p4 = g.importGrd(n4)
  const hit4 = await until(() => saveCalls === 2)
  g.removeSatellite(n4.folder)
  saveGate.release(); saveGate = null
  const k4 = await p4
  ok(hit4 && Array.isArray(k4) && k4.length === 0 && !ghost(n4.folder) && files.size === fA && g.loading.value === false,
    '⑤c 导入 GRD：存盘途中卫星被删 → 刚存的文件撤掉、已入树的那副随星清掉，不交回 key', `盘上 ${files.size} / ${fA}`)
  openFiles = [{ base: 'x.grd', text: grdText }]

  // (5) 新建解析天线：存盘途中卫星被删
  const n5 = g.addSatellite({ name: 'FIX5', lon: 20, lat: 0, altKm: GEO_ALT })
  saveCalls = 0; saveGate = { at: 1, ...deferred() }; lastLayers = null
  const p5 = g.createAnalyticAntenna(n5.folder, { name: 'A', record: recGeo })
  const hit5 = await until(() => saveCalls === 1)
  g.removeSatellite(n5.folder)
  saveGate.release(); saveGate = null
  err = ''
  try { await p5 } catch (e) { err = e.message }
  ok(hit5 && err === '目标卫星不存在' && !ghost(n5.folder) && files.size === fA, '⑤c 新建解析天线：存盘途中卫星被删 → 刚存的文件撤掉、抛「目标卫星不存在」', err)

  // (6) 波束合成入树：等星历源期间 / 存盘途中卫星被删
  arm(); lastLayers = null; alertMsg.value = ''
  const n6 = g.addSatellite({ name: 'LNK6', noradId: '55555', lon: 3, lat: 0, altKm: GEO_ALT })
  const p6 = g.importSynthGrd(n6.folder, 'S', grdText, { ctype: 'rel', levels: [-3] })
  await sleep(5)
  g.removeSatellite(n6.folder)
  eph.release()
  const k6 = await p6
  ok(k6 === null && alertMsg.value === '目标卫星不存在' && !ghost(n6.folder) && files.size === fA, '⑤c 波束合成入树：等星历源期间卫星被删 → 返回 null、不建天线', alertMsg.value)
  const n7 = g.addSatellite({ name: 'FIX7', lon: 20, lat: 0, altKm: GEO_ALT })
  saveCalls = 0; saveGate = { at: 1, ...deferred() }; lastLayers = null; alertMsg.value = ''
  const p7 = g.importSynthGrd(n7.folder, 'S', grdText, { ctype: 'rel', levels: [-3] })
  const hit7 = await until(() => saveCalls === 1)
  g.removeSatellite(n7.folder)
  saveGate.release(); saveGate = null
  const k7 = await p7
  ok(hit7 && k7 === null && !ghost(n7.folder) && files.size === fA, '⑤c 波束合成入树：存盘途中卫星被删 → 刚存的文件撤掉、返回 null', alertMsg.value)
  // 对照：没人删 → 等完照常建（行为不变）
  arm(); lastLayers = null
  const n8 = g.addSatellite({ name: 'LNK8', noradId: '44444', lon: 3, lat: 0, altKm: GEO_ALT })
  const f8 = files.size
  const p8 = g.importSynthGrd(n8.folder, 'S', grdText, { ctype: 'rel', levels: [-3] })
  await sleep(5)
  eph.release()
  const k8 = await p8
  ok(k8 === n8.folder + '|S' && g.active.value === k8 && (lastLayers || []).some((L) => L.id.startsWith(k8)) && Math.abs(g.getPerfContext(k8).meta.satLon - 10) < 1e-12 && files.size === f8 + 1,
    '⑤c 对照：波束合成入树等完星历源照常建（按解出来的活位置）', k8)
  g.setEphReady(null)
  globalThis.window = prevWin
}

// ============ ⑥ 对星表时段扫描 × 解析天线就地改参 ============
// 真 useGrdCoverage × 真 useSatPerfTable：固定 GEO 源星对准 ISS 那一刻的方向建高斯波束，扫 0.1 h 时窗；
// 扫完改口径效率（G0 变）→ winStaleFor 当场为真、且响应式读者（宿主推送 watch）在表重算那一拍收到；游标表按新波束取值。
{
  const { watch } = await import('vue')
  const sat = (await import('../../../src/viz/constellation/satellite.js')).default
  const { useSatPerfTable } = await import('../../../src/viz/grd/useSatPerfTable.js')
  const { useGrdCoverage } = await import('../../../src/viz/grd/useGrdCoverage.js')
  const tick0 = () => new Promise((r) => setTimeout(r, 0))
  const issRec = sat.twoline2satrec('1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004', '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354')
  const T0 = Date.UTC(2026, 7, 18, 12, 0, 0), d0 = new Date(T0)
  const pv = sat.propagate(issRec, d0), gm = sat.gstime(d0), e = sat.eciToEcf(pv.position, gm), gd = sat.eciToGeodetic(pv.position, gm)
  const P = [e.x, e.y, e.z], L = +sat.degreesLong(gd.longitude).toFixed(3)
  const g = useGrdCoverage(() => null, () => null, () => false, {})
  const node = g.addSatellite({ name: 'GEO-ISS', lon: L, lat: 0, altKm: GEO_ALT })
  const key = await g.createAnalyticAntenna(node.folder, { name: 'G', record: recGeo })
  // 视轴对准 ISS（天线系方向余弦 → igrid 6 的 az/el：a = −sin az，b = cos az·sin el，c = cos az·cos el）
  const bs = g.getPerfContext(key).basis, u = nrm(sub(P, bs.S))
  const a = dot(u, bs.x), b = dot(u, bs.y), c = dot(u, bs.z), az = -Math.asin(a) * R2D, el = Math.atan2(b, c) * R2D
  const recAt = (eff) => buildRecord({ sat: recGeo.sat, models: [{ ...MODEL_D, eff }], beams: [{ name: 'b1', az, el, model: 'm1' }] })
  const r55 = recAt(55), r70 = recAt(70)
  ok(g.updateAnalyticAntenna(key, r55), '⑥ 视轴对准 ISS（T0）')
  const sp = useSatPerfTable()
  sp.setActiveKey(key); sp.win.durH = 0.1
  const tg = [{ rec: issRec, name: 'ISS', noradId: 25544, group: '', _cc: false }]
  const times = { now: d0, gmst: gm, ccNow: d0, ccGmst: gm }
  await sp.computeWindows(g.getPerfContext(key), null, tg, times, [], 0, {})
  const ss = sp.session(key)
  sp.seekCursor(T0, key)
  const dirAt = () => { const r = ss.rows.value.find((x) => x.noradId === 25544); return r ? r.dir : null }
  const dir55 = dirAt()
  ok(!sp.winStaleFor(key) && ss.winInfo.value && dir55 != null && Math.abs(dir55 - r55.beams[0].g0) < 1e-3, '⑥ 扫完不过期；游标 T0 的 Dir = 视轴增益 g0', `${dir55} / ${r55.beams[0].g0}`)
  const seen = []
  const stop = watch(() => sp.winStaleFor(key), (v) => seen.push(v))
  ok(g.updateAnalyticAntenna(key, r70), '⑥ 改口径效率 55% → 70%（同 key 换方向图）')
  ok(sp.winStaleFor(key) === true, '⑥ 就地改参之后：时段结果当场自称「输入已变」')
  sp.seekCursor(ss.win.cursorMs, key)                          // 宿主刷开着的表（页面 watch(grd.anRev) → refreshShell → seekCursor）
  await tick0()
  const dir70 = dirAt()
  ok(seen.includes(true), '⑥ 响应式读者在表按新方向图重算的那一拍收到「输入已变」（宿主推送 watch 读得到）', JSON.stringify(seen))
  ok(ss.winEnv && ss.winEnv.ctx.beams[0].beam === g.getPerfContext(key).beams[0].beam && dir70 != null && Math.abs(dir70 - r70.beams[0].g0) < 1e-3 && Math.abs(dir70 - dir55) > 0.5,
    '⑥ 游标表不再拿扫描时钉住的旧波束：按新方向图取值', `${dir55.toFixed(4)} → ${dir70 && dir70.toFixed(4)} dBi（新 g0 ${r70.beams[0].g0.toFixed(4)}）`)
  await sp.computeWindows(g.getPerfContext(key), null, tg, times, [], 0, {})
  ok(sp.winStaleFor(key) === false, '⑥ 重扫之后不再过期')
  stop()
}

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
