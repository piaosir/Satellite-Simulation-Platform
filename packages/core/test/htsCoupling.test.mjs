// HTS 多波束复用方案与同频耦合（packages/core/utils/interference/htsCoupling.js）。
//   C/CCI 页的「复用方案」页已撤（2026-10-17，改为目标波束口径，见 cciTarget.js），本引擎留作参照实现：
//   目标波束引擎复用这里的几何与统计，并在 cciTarget.test ② 与这里的二值耦合逐点对账。
//   运行： node packages/core/test/htsCoupling.test.mjs
//
//   ① 六角晶格闭式：4 色复用、波束间距 s = (√3/2)·θ3、−10 dB 边缘锥度的抛物线-台座圆口径照射
//      F(u) = (2pΛ₁(u) + qΛ₂(u))/(2p+q)，p = 10^(−10/20)，q = 1−p，Λ₁ = 2J₁(u)/u，Λ₂ = 8J₂(u)/u²，
//      u = 2u_h·θ/θ3（u_h 为 |F|² = 1/2 处）。C/I = |F(u₀)|² / Σ_同色 |F(u_k)|²，无穷晶格的和取
//      圆盘内逐项 + 圆盘外渐近尾项（远旁瓣均值包络 (2p/(2p+q))²·4/(πu³) 对同色点面密度积分）。
//      本测试推得：波束中心 14.85 dB、三重点 14.87 dB（尾项修正后 R = 60…200 圈稳定在 ±0.002 dB）。
//      E 路报的「约 15.0 / 15.1 dB」是 29×29 菱形截断的有限和（精确方向图下为 15.03 / 15.19 dB），差在截断尾项。
//   ② 耦合矩阵退化为二值（只有色号、功率偏置为 0）时，fwdAtPoint 与 ciCci.cciAtPoint 逐位一致。
//   ③ 窗外 null：取该波束网格自身的最小电平作地板计入，并计数。
//   ⑤ 返向：最坏点与逐点暴力一致；蒙特卡洛同种子可复现。
//   ⑥ 场图作业：天线网格逐节点、经纬网格与逐点同值、逐波束统计次序。
// 期望值凡带「独立」二字的，都在本文件里由独立实现现算，不是把被测实现的输出抄回来当基准。

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const H = require('../utils/interference/htsCoupling.js')
const C = require('../utils/interference/ciCci.js')
const S = require('../utils/grdSampler.js')

let pass = 0, fail = 0
const ok = (name, cond, extra) => { console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? '  ' + extra : '')); cond ? pass++ : fail++ }
const approx = (name, got, want, tol) => {
  const g = Number(got)
  const c = Number.isFinite(g) && Math.abs(g - want) <= tol
  console.log((c ? 'PASS' : 'FAIL') + `  ${name}  (got=${Number.isFinite(g) ? g.toFixed(6) : g}, want≈${want} ±${tol})`)
  c ? pass++ : fail++
}
const lg = (x) => 10 * Math.log10(x)

// ═══ ① 六角晶格闭式 ═══
console.log('=== ① 六角晶格闭式（4 色 · s = 0.866θ3 · −10 dB 锥度口径）===')
// J_n 用整周期梯形（被积函数周期 2π，节点数 > |x|+n+60 时达机器精度），与被测模块无关
const Jn = (n, x) => { const N = Math.max(64, Math.ceil(Math.abs(x) + n + 60)) * 2; let s = 0; for (let k = 0; k < N; k++) { const t = 2 * Math.PI * k / N; s += Math.cos(n * t - x * Math.sin(t)) } return s / N }
const TP = Math.pow(10, -10 / 20), TQ = 1 - TP
const Fu = (u) => (Math.abs(u) < 1e-9 ? 1 : (2 * TP * (2 * Jn(1, u) / u) + TQ * (8 * Jn(2, u) / (u * u))) / (2 * TP + TQ))
let uLo = 0.5, uHi = 3.5
for (let i = 0; i < 80; i++) { const m = (uLo + uHi) / 2; if (Fu(m) * Fu(m) > 0.5) uLo = m; else uHi = m }
const UH = (uLo + uHi) / 2
const powAt = (r) => { const f = Fu(2 * UH * r); return f * f }      // r = θ/θ3
const SP = Math.sqrt(3) / 2                                          // 波束间距（θ3 = 1）
const latXY = (i, j) => [SP * (i + j / 2), SP * j * Math.sqrt(3) / 2]
const par = (v) => ((v % 2) + 2) % 2
const TRIPLE = [SP / 2, SP / (2 * Math.sqrt(3))]
approx('u_h（|F|² = 1/2）', UH, 1.786374, 1e-5)
approx('三重点离三个波束中心都是 θ3/2（−3 dB 交点）', Math.hypot(...TRIPLE), 0.5, 1e-12)
// 无穷晶格：圆盘内逐项 + 尾项
const C4 = 4 * Math.pow(2 * TP / (2 * TP + TQ), 2), RHO = 1 / (4 * (Math.sqrt(3) / 2) * SP * SP)
const tail = (Rr) => RHO * C4 / (4 * Math.pow(UH, 3) * Rr)
function latticeSum(vx, vy, R) {
  let s = 0
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
    if ((!i && !j) || par(i) || par(j)) continue
    const [x, y] = latXY(i, j)
    if (Math.hypot(x, y) > R * SP + 1e-9) continue
    s += powAt(Math.hypot(vx - x, vy - y))
  }
  return s
}
const ciCenterInf = lg(powAt(0) / (latticeSum(0, 0, 60) + tail(60 * SP)))
const ciTripleInf = lg(powAt(0.5) / (latticeSum(TRIPLE[0], TRIPLE[1], 60) + tail(60 * SP)))
approx('闭式（无穷晶格）· 波束中心 C/I', ciCenterInf, 14.85, 0.01)
approx('闭式（无穷晶格）· 三重点 C/I', ciTripleInf, 14.87, 0.01)

// 被测引擎：圆盘晶格（R 圈）逐波束 dB 值 → 复用方案（逐波束频段：4 色 = 4 段互不重叠的频率）→ 耦合 → 前向 C/I
function latticeBeams(R) {
  const out = []
  for (let i = -R; i <= R; i++) for (let j = -R; j <= R; j++) {
    const [x, y] = latXY(i, j)
    if (Math.hypot(x, y) > R * SP + 1e-9) continue
    out.push({ i, j, x, y, c: par(i) + 2 * par(j) })
  }
  return out
}
function engineCi(beams, scheme, vx, vy, pinPos, cxOf) {
  const idx = beams.map((_, k) => k)
  const sc = H.normalizeScheme(scheme, idx)
  const cpl = H.couplingOf(sc, 'fwd')
  const vals = beams.map((b) => 50 + lg(powAt(Math.hypot(vx - b.x, vy - b.y))))
  const r = H.fwdAtPoint(vals, cxOf ? beams.map(cxOf) : null, cpl, { beamIdx: idx, servingIdx: pinPos, floorDb: 1e9, xpdDb: sc.xpdDb })
  return { r, cpl, sc }
}
{
  const R = 40
  const beams = latticeBeams(R)
  const k0 = beams.findIndex((b) => b.i === 0 && b.j === 0)
  const seg = (c) => [{ f1: 19260 + c * 100, f2: 19360 + c * 100, pol: 'R' }]
  const scheme = { source: 'excel', excel: { beams: Object.fromEntries(beams.map((b, k) => [k, { fwd: { segs: seg(b.c) }, rtn: { segs: seg(b.c) } }])) } }
  const fin = (vx, vy) => {
    let s = 0
    for (const b of beams) if ((b.i || b.j) && b.c === 0) s += powAt(Math.hypot(vx - b.x, vy - b.y))
    return s
  }
  const e0 = engineCi(beams, scheme, 0, 0, k0)
  approx(`引擎 ≡ 同一截断的独立有限和 · 中心（${beams.length} 波束）`, e0.r.cciDb, lg(powAt(0) / fin(0, 0)), 1e-9)
  const e1 = engineCi(beams, scheme, TRIPLE[0], TRIPLE[1], k0)
  approx('引擎 ≡ 同一截断的独立有限和 · 三重点', e1.r.cciDb, lg(powAt(0.5) / fin(TRIPLE[0], TRIPLE[1])), 1e-9)
  ok('频段互不重叠的 4 色：耦合矩阵恰为 0 / 1，无正交项', e0.cpl.mode === 'segs' && !e0.cpl.anyX && Array.from(e0.cpl.wCo).every((w) => w === 0 || Math.abs(w - 1) < 1e-15))
  approx('引擎有限和 + 尾项 → 闭式 · 中心', lg(powAt(0) / (fin(0, 0) + tail(R * SP))), ciCenterInf, 0.01)
  approx('引擎有限和 + 尾项 → 闭式 · 三重点', lg(powAt(0.5) / (fin(TRIPLE[0], TRIPLE[1]) + tail(R * SP))), ciTripleInf, 0.01)
  // 不钉服务波束：中心点自然选中 (0,0)
  const free = engineCi(beams, scheme, 0, 0, undefined)
  ok('中心点不钉服务波束 → 自动选中心那个波束', free.r.servingPos === k0 && Object.is(free.r.cciDb, e0.r.cciDb))

  // 4 色双极化 = 2 频段 × 2 极化（j 的奇偶分频段、i 的奇偶分极化），规格 XPD 30 dB，方向图无交叉极化分量
  const seg2 = (b) => [{ f1: par(b.j) ? 19700 : 19260, f2: par(b.j) ? 20140 : 19700, pol: par(b.i) ? 'L' : 'R' }]
  const scheme2 = { source: 'excel', xpdDb: 30, excel: { beams: Object.fromEntries(beams.map((b, k) => [k, { fwd: { segs: seg2(b) }, rtn: { segs: seg2(b) } }])) } }
  const e2 = engineCi(beams, scheme2, TRIPLE[0], TRIPLE[1], k0)
  let co = 0, xx = 0
  for (const b of beams) {
    if (!(b.i || b.j) || par(b.j)) continue
    const g = powAt(Math.hypot(TRIPLE[0] - b.x, TRIPLE[1] - b.y))
    if (par(b.i)) xx += g; else co += g
  }
  approx('双极化：异极化同频段按 1/XPD 漏入（独立闭式）', e2.r.cciDb, lg(powAt(0.5) / (co + 1e-3 * xx)), 1e-9)
  ok('双极化：比单极化 4 色差（多了异极化泄漏）', e2.r.cciDb < e1.r.cciDb, `${e2.r.cciDb.toFixed(3)} < ${e1.r.cciDb.toFixed(3)}`)
  // 正交项优先取逐点交叉极化分量：给 cx = co − 20 dB，结果应按 20 dB 漏入
  const e3 = engineCi(beams, scheme2, TRIPLE[0], TRIPLE[1], k0, (b) => 50 + lg(powAt(Math.hypot(TRIPLE[0] - b.x, TRIPLE[1] - b.y))) - 20)
  approx('正交项优先取方向图交叉极化分量（独立闭式）', e3.r.cciDb, lg(powAt(0.5) / (co + 1e-2 * xx)), 1e-9)
}

// ═══ ② 二值退化 ≡ cciAtPoint ═══
console.log('\n=== ② 耦合退化为二值时与 cciAtPoint 逐位一致 ===')
{
  const rng = (() => { let a = 12345; return () => { a = (a * 1103515245 + 12345) >>> 0; return a / 4294967296 } })()
  let same = 0, total = 0, detailSame = 0
  for (let t = 0; t < 400; t++) {
    const n = 5 + Math.floor(rng() * 40)
    const idx = []; let o = 0
    for (let k = 0; k < n; k++) { o += 1 + Math.floor(rng() * 3); idx.push(o) }        // 删过波束的原始下标
    const vals = idx.map(() => (rng() < 0.15 ? null : +(20 + rng() * 40).toFixed(2)))
    const colors = [3, 4, 7, 8, 9, 12, 16][t % 7]
    const floorDb = [60, 15, 5, 200][t % 4]
    const pin = t % 5 === 0 ? idx[Math.floor(rng() * n)] : undefined
    const sc = H.normalizeScheme({ source: 'rotation', colors }, idx)
    const cpl = H.couplingOf(sc, 'fwd')
    const a = C.cciAtPoint(vals, idx, { colors, floorDb, servingIdx: pin })
    const b = H.fwdAtPoint(vals, null, cpl, { beamIdx: idx, floorDb, servingIdx: pin, colorOf: sc.dirs.fwd.color })
    total++
    if (a === null && b === null) { same++; detailSame++; continue }
    if (!a || !b) continue
    const eq = Object.is(a.cciDb, b.cciDb) && a.servingIdx === b.servingIdx && Object.is(a.servingGainDb, b.servingGainDb)
      && a.coChannelCount === b.coChannelCount && a.noCoChannel === b.noCoChannel && Object.is(a.aggregateInterfGainDb, b.aggregateInterfGainDb)
      && String(a.colorId) === String(b.colorId)
    if (eq) same++
    const dEq = a.interferers.length === b.interferers.length && a.interferers.every((x, k) => x.beamIdx === b.interferers[k].beamIdx
      && Object.is(x.gainDb, b.interferers[k].gainDb) && Object.is(x.sharePct, b.interferers[k].sharePct))
    if (dEq) detailSame++
  }
  ok(`轮转着色：${total} 组随机算例 cciDb / 服务波束 / 计数 / 聚合干扰逐位相同`, same === total, `${same}/${total}`)
  ok('轮转着色：逐源明细（下标 · 电平 · 占比）逐位相同', detailSame === total, `${detailSame}/${total}`)
  // 手工色号（老字段 coloringOverride 的形状）与 Excel 只给色号（标签串）同样退化
  const idx = [0, 1, 2, 3, 4, 5, 6, 7], vals = [50, 47.5, 44.1, 41.3, 38, 35.2, 30, 28.8]
  const coloring = { 0: 0, 1: 1, 2: 2, 3: 0, 4: 1, 5: 2, 6: 0, 7: 1 }
  const a = C.cciAtPoint(vals, idx, { coloring })
  const sm = H.normalizeScheme({ source: 'manual', manual: { coloring } }, idx)
  const bm = H.fwdAtPoint(vals, null, H.couplingOf(sm, 'fwd'), { beamIdx: idx, colorOf: sm.dirs.fwd.color })
  ok('手工色号：与 cciAtPoint 逐位相同', Object.is(a.cciDb, bm.cciDb) && a.coChannelCount === bm.coChannelCount)
  const se = H.normalizeScheme({ source: 'excel', excel: { beams: Object.fromEntries(idx.map((i) => [i, { fwd: { color: 'c' + coloring[i] } }])) } }, idx)
  const be = H.fwdAtPoint(vals, null, H.couplingOf(se, 'fwd'), { beamIdx: idx })
  ok('Excel 只有色号（标签串）：同样退化为二值、逐位相同', se.dirs.fwd.mode === 'color' && Object.is(a.cciDb, be.cciDb))
  // 功率偏置 0 dB 是精确的 1：显式给 0 也不破坏逐位一致
  const sp = H.normalizeScheme({ source: 'manual', manual: { coloring }, powerDb: { 0: 0, 3: 0 } }, idx)
  ok('显式功率偏置 0 dB：仍逐位相同', Object.is(a.cciDb, H.fwdAtPoint(vals, null, H.couplingOf(sp, 'fwd'), { beamIdx: idx }).cciDb))
  // 功率偏置 +3 dB 的同色干扰源 = 线性 ×10^0.3
  const s3 = H.normalizeScheme({ source: 'manual', manual: { coloring }, powerDb: { 3: 3 } }, idx)
  const b3 = H.fwdAtPoint(vals, null, H.couplingOf(s3, 'fwd'), { beamIdx: idx })
  approx('干扰波束功率偏置 +3 dB → 该项线性 ×10^0.3（独立）', b3.cciDb, 50 - lg(Math.pow(10, 4.13 + 0.3) + Math.pow(10, 3.0)), 1e-9)
}

// ═══ ③ 窗外地板 ═══
console.log('\n=== ③ 窗外 null 取网格最小电平计入 ===')
// 合成两波束 GRD（igrid 6，各自窗口 ±1°，相距 5°）：天底点只落在 A 的窗口里
function gaussBeam(az, el, th3, win, nn, peak) {
  const XS = az - win, XE = az + win, YS = el - win, YE = el + win, N = nn * nn
  const c1re = new Float32Array(N), z = new Float32Array(N)
  for (let r = 0; r < nn; r++) for (let c = 0; c < nn; c++) {
    const X = XS + (XE - XS) * c / (nn - 1), Y = YS + (YE - YS) * r / (nn - 1)
    const db = peak - 12.0412 * ((X - az) ** 2 + (Y - el) ** 2) / (th3 * th3)
    c1re[r * nn + c] = Math.sqrt(Math.pow(10, Math.max(db, peak - 50) / 10))
  }
  return { grid: { XS, YS, XE, YE, NX: nn, NY: nn }, c1re, c1im: z, c2re: z, c2im: z }
}
const gridMinDb = (bm) => { let m = Infinity; for (let i = 0; i < bm.c1re.length; i++) { const p = bm.c1re[i] ** 2 + bm.c1im[i] ** 2 + bm.c2re[i] ** 2 + bm.c2im[i] ** 2; if (p > 0 && p < m) m = p } return lg(m) }
{
  const A = gaussBeam(0, 0, 0.6, 1, 41, 45), B = gaussBeam(5, 0, 0.6, 1, 41, 45)
  const loaded = { igrid: 6, icomp: 3, ncomp: 2, beams: [A, B] }
  const sat = { lon: 100, lat: 0, alt: 35786 }, cfg = { boreType: 'azel', boreAz: 0, boreEl: 0 }
  const pt = [{ lon: 100, lat: 0 }]
  const ctx = S.makeSampleCtx(loaded, sat, cfg)
  const raw = S.sampleAllCtx(ctx, 100, 0)
  ok('前提：天底点上 B 在窗外（采样为 null）', raw[0] != null && raw[1] == null)
  const old = C.cciAtPoint(raw, ctx.beamIdx, { colors: 1 })
  ok('旧口径：窗外当作没有干扰 → 「无同色」', old.noCoChannel === true && old.cciDb === null)
  const r = H.cciPoints({ sampler: S, loaded, sat, cfg, scheme: { source: 'rotation', colors: 1 }, points: pt })
  const want = raw[0] - (+gridMinDb(B).toFixed(2))
  approx('新口径：B 按其网格最小电平计入（独立）', r.rows[0].cciDb, want, 1e-9)
  ok('窗外计入点数 = 1，逐源明细标出地板项', r.summary.floorPts === 1 && r.rows[0].floorUsed === 1 && r.rows[0].interferers[0].floored === true)
  const lc = C.cciOverPoints(S, loaded, sat, cfg, pt, { colors: 1 })
  approx('老入口 cciOverPoints 同口径', lc.cci[0], want, 1e-9)
  ok('老入口回窗外计入点数', lc.floorPts === 1)
  // 全在窗外 / 卫星不可见的点仍无值
  const far = H.cciPoints({ sampler: S, loaded, sat, cfg, scheme: { source: 'rotation', colors: 1 }, points: [{ lon: 40, lat: 60 }] })
  ok('所有波束都取不到值的点：无值（不编地板）', far.rows[0] === null && far.summary.floorPts === 0)
}

// ═══ 来源优先级与波束合成色号 ═══
console.log('\n=== 来源优先级 · 波束合成色号 ===')
{
  const idx = [0, 1, 2, 3]
  ok('SYNTHMETA 行的 fc 数组', JSON.stringify(H.synthFcFromText('x\nSYNTHMETA {"kind":"gauss","fc":[0,1,null,2]}\n++++\n')) === '[0,1,null,2]')
  ok('SYNTHMETA 行的 beams[].fc', JSON.stringify(H.synthFcFromText('SYNTHMETA {"kind":"pam","beams":[{"fc":3},{}]}\n')) === '[3,null]')
  ok('解析天线记录的 beams[].fc', JSON.stringify(H.synthFcFromText('{"format":"satsim-analytic-antenna","beams":[{"az":0,"el":0,"th3":1,"g0":40,"back":-10,"fc":1}]}')) === '[1]')
  ok('没有色号 → null（来源不可用）', H.synthFcFromText('SYNTHMETA {"kind":"gauss","nBeams":4}\n') === null && H.synthFcFromText('') === null)
  const auto = H.normalizeScheme({ source: 'auto', fc: [0, 1, 0, 1], manual: { coloring: { 0: 0 } } }, idx)
  ok('自动：有波束合成色号时排在 Excel / 手工之前', auto.source === 'synth' && auto.requested === 'auto')
  const auto2 = H.normalizeScheme({ source: 'auto', colors: 3 }, idx)
  ok('自动：什么都没有 → 轮转兜底，来源写明', auto2.source === 'rotation' && auto2.label === '3')
  const bad = H.normalizeScheme({ source: 'freqPlan' }, idx)
  ok('指定频率计划却没有数据 → 报错，不偷偷换来源', bad.ok === false && /频率计划/.test(bad.error))
  const rtnOnly = { source: 'auto', colors: 4, plan: { label: 'P', beams: { 0: { rtn: { segs: [{ f1: 29500, f2: 29720, pol: 'V' }] } } } } }
  ok('自动按方向判：计划只有返向段 → 前向落到下一级（轮转）、返向用计划',
    H.normalizeScheme(rtnOnly, idx, 'fwd').source === 'rotation' && H.normalizeScheme(rtnOnly, idx, 'rtn').source === 'freqPlan')
  const part = H.normalizeScheme({ source: 'excel', excel: { beams: { 0: { fwd: { segs: [{ f1: 1, f2: 2 }] } }, 1: { fwd: { color: '2' } } } } }, idx)
  ok('有频段的波束占多数时，只有色号 / 什么都没给的记为未指派', part.dirs.fwd.mode === 'segs' && part.unassigned.fwd === 3)
  const defs = H.normalizeScheme({ source: 'manual', manual: { coloring: { 0: 0, 1: 1, 2: 0, 3: 1 } }, colorDefs: { 0: { fwd: { f1: 100, f2: 200, pol: 'R' } }, 1: { fwd: { f1: 100, f2: 200, pol: 'L' } } } }, idx)
  const dc = H.couplingOf(defs, 'fwd')
  ok('色号定义：F1 / F2 同频段异极化 → 正交耦合', dc.mode === 'segs' && dc.wCo[0 * 4 + 2] === 1 && dc.wX[0 * 4 + 1] === 1)
  ok('加权分位：等权下侧分位', H.weightedQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], null, 0.05) === 1 && H.weightedQuantile([1, 2, 3, 4], null, 0.5) === 2)
  ok('加权分位：权重', H.weightedQuantile([1, 2, 3], [0.1, 0.1, 0.8], 0.5) === 3)
}

// ═══ ⑤ ⑥ 场图作业：返向最坏点 / 蒙特卡洛 / 网格 ═══
console.log('\n=== ⑤ 返向 · ⑥ 场图作业 ===')
{
  // 七波束蜂窝（公共窗口），GEO 110°E，视轴指向 (110°E, 30°N)
  const s = 0.866 * 0.6
  const centers = [[0, 0]]
  for (let k = 0; k < 6; k++) centers.push([s * Math.cos(k * Math.PI / 3), s * Math.sin(k * Math.PI / 3)])
  const beams = centers.map(([az, el]) => {
    const b = gaussBeam(0, 0, 0.6, 2, 61, 40)
    // 公共窗口 ±2°，中心挪到各自位置
    const g = b.grid, N = g.NX * g.NY
    const c1re = new Float32Array(N)
    for (let r = 0; r < g.NY; r++) for (let c = 0; c < g.NX; c++) {
      const X = g.XS + (g.XE - g.XS) * c / (g.NX - 1), Y = g.YS + (g.YE - g.YS) * r / (g.NY - 1)
      c1re[r * g.NX + c] = Math.sqrt(Math.pow(10, Math.max(40 - 12.0412 * ((X - az) ** 2 + (Y - el) ** 2) / 0.36, -10) / 10))
    }
    return { grid: g, c1re, c1im: b.c1im, c2re: b.c2re, c2im: b.c2im }
  })
  const loaded = { igrid: 6, icomp: 3, ncomp: 2, beams }
  const sat = { lon: 110, lat: 0, alt: 35786 }, cfg = { boreType: 'geo', boreLon: 110, boreLat: 30 }
  const run = (o) => { const r = H.createCciRun({ sampler: S, loaded, sat, cfg, ...o }); let d = 0, guard = 0; while (d < r.T && guard++ < 1e6) d = r.stepBatch(257); return r.finalize() }

  const fa = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'fwd', grid: { kind: 'antenna' } })
  ok('天线网格：逐节点 = 方向图网格 61×61、全部有值', fa.grid.nx === 61 && fa.grid.ny === 61 && fa.valid === 61 * 61, `${fa.grid.nx}×${fa.grid.ny} 有值 ${fa.valid}`)
  ok('天线网格：显示用经纬栅格有值', fa.field && fa.field.valid > 1000 && fa.field.nx * fa.field.ny <= 1200 * 1200)
  ok('逐波束统计：最小 ≤ 5% ≤ 中位', fa.beams.every((b) => !b.fwd || (b.fwd.min <= b.fwd.p5 && b.fwd.p5 <= b.fwd.p50)))
  ok('来源读数：轮转 3 色', fa.source === 'rotation' && fa.colors === 3)

  // 经纬网格与逐点同值（同一套取值、同一套地板）
  const grid = { kind: 'user', lonMin: 105, lonMax: 115, latMin: 25, latMax: 35, step: 0.5 }
  const fu = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'fwd', grid, points: [{ lon: 110, lat: 30 }, { lon: 111.5, lat: 31 }] })
  const pts = H.cciPoints({ sampler: S, loaded, sat, cfg, scheme: { source: 'rotation', colors: 3 }, points: [{ lon: 110, lat: 30 }, { lon: 111.5, lat: 31 }] })
  ok('场图作业带的取值点 ≡ 逐点表', Object.is(fu.points[0].cciDb, pts.rows[0].cciDb) && Object.is(fu.points[1].cciDb, pts.rows[1].cciDb))
  const k = (30 - 25) / 0.5 * fu.grid.nx + (110 - 105) / 0.5
  approx('经纬网格格点 ≡ 该点逐点值', fu.field.z[k], pts.rows[0].cciDb, 1e-4)

  // 返向最坏点：独立暴力（逐格取值 → 服务区 → max G_j/G_k → Σ）
  const fr = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'rtn', grid, eocDb: 4 })
  const ctx = S.makeSampleCtx(loaded, sat, { ...cfg, pathLoss: 'none' })
  const n = ctx.beams.length
  const peak = ctx.beams.map((bm) => { let m = 0; for (let i = 0; i < bm.c1re.length; i++) m = Math.max(m, bm.c1re[i] ** 2); return lg(m) })
  const worst = Array.from({ length: n }, () => new Array(n).fill(-Infinity))
  for (let j = 0; j <= 20; j++) for (let i = 0; i <= 20; i++) {
    const v = S.sampleAllCtx(ctx, 105 + i * 0.5, 25 + j * 0.5)
    if (v.every((x) => x == null)) continue
    let sv = -1
    for (let b = 0; b < n; b++) if (v[b] != null && (sv < 0 || v[b] > v[sv])) sv = b
    if (v[sv] < peak[sv] - 4) continue
    for (let b = 0; b < n; b++) if (b !== sv && v[b] != null && b % 3 === sv % 3) worst[b][sv] = Math.max(worst[b][sv], v[b] - v[sv])
  }
  let maxErr = 0
  for (let jv = 0; jv < n; jv++) {
    let I = 0
    for (let kk = 0; kk < n; kk++) if (worst[jv][kk] > -Infinity) I += Math.pow(10, worst[jv][kk] / 10)
    const want = I > 0 ? -lg(I) : Infinity
    const got = fr.beams[jv].rtnWorst
    maxErr = Math.max(maxErr, want === Infinity ? (got === Infinity ? 0 : 1) : Math.abs(got - want))
  }
  ok('返向最坏点 ≡ 独立暴力', maxErr < 1e-9, `最大差 ${maxErr.toExponential(2)} dB`)
  // 蒙特卡洛：同种子逐位复现、换种子不同、最坏点 ≤ 蒙特卡洛最小
  const mc1 = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'rtn', grid, rtn: { mode: 'mc', trials: 60, seed: 7 } })
  const mc2 = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'rtn', grid, rtn: { mode: 'mc', trials: 60, seed: 7 } })
  const mc3 = run({ scheme: { source: 'rotation', colors: 3 }, dir: 'rtn', grid, rtn: { mode: 'mc', trials: 60, seed: 8 } })
  ok('蒙特卡洛：种子写进结果', mc1.seed === 7 && mc1.trials === 60)
  ok('蒙特卡洛：同种子逐位复现', mc1.beams.every((b, i) => JSON.stringify(b.rtnMc) === JSON.stringify(mc2.beams[i].rtnMc)))
  ok('蒙特卡洛：换种子结果不同', mc1.beams.some((b, i) => JSON.stringify(b.rtnMc) !== JSON.stringify(mc3.beams[i].rtnMc)))
  ok('最坏点不高于蒙特卡洛最小', mc1.beams.every((b) => !b.rtnMc || b.rtnWorst <= b.rtnMc.min + 1e-9))
  ok('返向场图按服务波束涂各自的值', fr.field && fr.field.valid > 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
