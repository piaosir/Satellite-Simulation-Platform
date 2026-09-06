// 严格 minimax 赋形优化器自测（src/viz/grd/minimax.js + synth.js 的 buildShapedGrd / buildPamShapedGrd）。
// 运行：npm test（被测文件是渲染端 ESM，故本测试自身也是 .mjs）
//
// 这份钉的是「最差站点余量最大化」这件事本身，分三层：
//   ① 内核层：LP 内点法对暴力顶点解（minimax 的每一步都压在它身上，错了外面全错但看着像收敛）；
//      终解乘子 Σy=1（t 列的最优性条件——对偶残差写成 Aᵀy=+c 时这条恒不成立，LP 永远跑满迭代上限）。
//   ② 求解器层：解析等纹波解（三站残差相等、活跃站=3）、实子空间锁死复现、接受步单调。
//   ③ 端到端：三例口径的覆盖最低值必须【超过】旧 IRLS 启发式（改造的全部理由），且无空洞、确定性、
//      GRD 仍能回读。基线数字见下表——旧引擎实测值钉死在注释里，回归时一眼看得出退到哪一档。
//
// 【诚实边界】对齐的是 SATSOFT 的算法类（SLP minimax + 内点 LP）与语义（最差余量最大化、增益只看
// 相对值），不承诺 bit-exact；minimax 非凸，终解可能是局部极小（手册 §10.2 自认）。故基线断言取
// 「≥ 某个数」而不是「等于某个数」。
import { createMinimax, lpSolveIpm } from '../../../src/viz/grd/minimax.js'
import { buildShapedGrd, buildPamShapedGrd, shapedTheta3db, shapedApertureEff, shapedStations } from '../../../src/viz/grd/synth.js'
import { parseGrd } from '../../../src/viz/grd/parse.js'

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// 固定件（与 synthStationGrid.test.mjs 同源）
const SAT = { satLon: 110.5, altKm: 35786 }
const POLY = [[75, 40], [90, 45], [100, 48], [120, 50], [125, 45], [122, 38], [121, 31], [113, 22], [108, 21], [98, 24], [85, 35]]
const FGHZ = 12.25, TAPER = -15
const shaped = (D) => buildShapedGrd({
  ...SAT, polysPts: [POLY], mode: 'physical', value: null,
  effPct: shapedApertureEff(TAPER).effPct, theta3: shapedTheta3db(FGHZ, D, TAPER), apDm: D, fSimGHz: FGHZ
})

// ==================== ① LP 内点法 vs 暴力顶点枚举 ====================
// min cᵀz s.t. Az ≤ b 的最优解必在某 n 个约束的交点上（有界时）：枚举全部 C(rows,n) 个顶点、
// 取可行者里目标最小的，与内点法比目标值。任一例差 >1e-6 即 FAIL。
{
  let seed = 20260906                                   // 确定性 LCG（不用 Math.random，失败必可复现）
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }
  const solveDense = (Mx, n) => {                       // 高斯-约当，奇异返回 null
    for (let col = 0; col < n; col++) {
      let p = -1, mv = 1e-9
      for (let r = col; r < n; r++) if (Math.abs(Mx[r][col]) > mv) { mv = Math.abs(Mx[r][col]); p = r }
      if (p < 0) return null
      const t = Mx[col]; Mx[col] = Mx[p]; Mx[p] = t
      for (let r = 0; r < n; r++) {
        if (r === col) continue
        const f = Mx[r][col] / Mx[col][col]
        for (let j = col; j <= n; j++) Mx[r][j] -= f * Mx[col][j]
      }
    }
    const z = []
    for (let i = 0; i < n; i++) z.push(Mx[i][n] / Mx[i][i])
    return z
  }
  const brute = (A, b, c, n, rows) => {
    let best = Infinity
    const combo = []
    const rec = (start) => {
      if (combo.length === n) {
        const Mx = combo.map((i) => { const r = []; for (let j = 0; j < n; j++) r.push(A[i * n + j]); r.push(b[i]); return r })
        const z = solveDense(Mx, n)
        if (!z) return
        for (let i = 0; i < rows; i++) { let t = 0; for (let j = 0; j < n; j++) t += A[i * n + j] * z[j]; if (t > b[i] + 1e-7) return }
        let v = 0
        for (let j = 0; j < n; j++) v += c[j] * z[j]
        if (v < best) best = v
        return
      }
      for (let i = start; i < rows; i++) { combo.push(i); rec(i + 1); combo.pop() }
    }
    rec(0)
    return best
  }
  let bad = 0, worst = 0
  for (let k = 0; k < 30; k++) {
    const n = 3 + (k % 3)                                // n = 3..5
    const extra = 2 + (k % 5)                            // 一般约束 2..6 → 连界约束共 8..16 行
    const rows = extra + 2 * n
    const A = new Float64Array(rows * n), b = new Float64Array(rows), c = new Float64Array(n)
    for (let j = 0; j < n; j++) c[j] = rnd() * 2 - 1
    for (let i = 0; i < extra; i++) { for (let j = 0; j < n; j++) A[i * n + j] = rnd() * 2 - 1; b[i] = 0.5 + rnd() }
    for (let j = 0; j < n; j++) { A[(extra + j) * n + j] = 1; b[extra + j] = 1; A[(extra + n + j) * n + j] = -1; b[extra + n + j] = 1 }
    const lp = lpSolveIpm(A, b, c, n, rows)
    let obj = 0
    for (let j = 0; j < n; j++) obj += c[j] * lp.z[j]
    const d = Math.abs(obj - brute(A, b, c, n, rows))
    if (d > worst) worst = d
    if (!(d < 1e-6)) { bad++; if (bad < 4) console.log(`   例 ${k}：n=${n} rows=${rows} 差 ${d.toExponential(2)}`) }
  }
  ok('LP 内点法 30 例全对上暴力顶点解', bad === 0, `最大目标值差 ${worst.toExponential(2)}`)
}

// ==================== ① · minimax LP 的对偶乘子：Σy_m = 1 ====================
// 站点行的 t 列恒为 −1 ⇒ Aᵀy = −c 在 t 分量上就是 Σy_m = 1（界约束行不含 t）。
// ★ 对偶残差写成 +c 时这条要求 Σ(−y_m)=1 而 y≥0，永不成立 —— 内点法会跑满上限且步长塌到 0。
{
  const n = 4, ns = 5, rows = ns + 2 * (n - 1)          // 3 个 h 变量 + t
  const A = new Float64Array(rows * n), b = new Float64Array(rows), c = new Float64Array(n)
  c[n - 1] = 1
  const G = [[1, 0.4, -0.2], [-0.7, 1, 0.3], [0.2, -0.9, 1], [0.5, 0.5, 0.5], [-0.3, 0.6, -0.8]]
  const r0 = [0.9, 0.6, 0.75, 0.3, 0.5]
  for (let m = 0; m < ns; m++) { for (let j = 0; j < n - 1; j++) A[m * n + j] = G[m][j]; A[m * n + n - 1] = -1; b[m] = -r0[m] }
  for (let j = 0; j < n - 1; j++) { A[(ns + j) * n + j] = 1; b[ns + j] = 0.5; A[(ns + n - 1 + j) * n + j] = -1; b[ns + n - 1 + j] = 0.5 }
  const z0 = new Float64Array(n); z0[n - 1] = 2
  const lp = lpSolveIpm(A, b, c, n, rows, { z0 })
  let sy = 0
  for (let m = 0; m < ns; m++) sy += lp.y[m]
  let act = 0
  for (let m = 0; m < ns; m++) if (lp.y[m] > 1e-4) act++
  ok('minimax LP 终解乘子 Σy_m = 1', lp.ok && Math.abs(sy - 1) < 1e-6, `Σy=${sy.toFixed(9)} · 正乘子 ${act} 个 · ${lp.iters} 步`)
}

// ==================== ② 解析等纹波解：两支实 beamlet + 三个对称站 ====================
// 两支 beamlet 在 ±0.5θ3、三站在 −0.6/0/+0.6（对称）。目标取【均匀激励下的实际场】⇒ 均匀激励是
// 残差恒 0 的可行点；2×2 实对称几何下它同时是 minimax 最优（暴力扫 t=w₂/w₁∈ℂ 全平面复核过：F*=3e-13）。
// 从非均匀起点出发必须收敛回等纹波：三站残差相等、活跃站 = 3。
{
  const th = 1.0, KF = 2 * Math.LN2
  const bc = [-0.5, 0.5], st = [-0.6, 0, 0.6]
  const gAt = (x, c) => Math.exp(-KF * (x - c) * (x - c) / (th * th))
  const omg1 = Math.PI * th * th / (4 * Math.LN2)
  const Q = new Float64Array(4)
  for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) { const d = bc[j] - bc[k]; Q[j * 2 + k] = omg1 * Math.exp(-Math.LN2 * d * d / (th * th)) }
  let P = 0
  for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) P += Q[j * 2 + k]
  const T = st.map((x) => { let e = 0; for (let j = 0; j < 2; j++) e += gAt(x, bc[j]); return 10 * Math.log10(e * e / P) })
  const rows = st.map((x, m) => ({ nb: [0, 1], g: Float64Array.from(bc.map((c) => gAt(x, c))), sign: -1, T: T[m] }))
  const x0 = new Float64Array([1, 0.3, 0.05, -0.015])   // 非均匀起点（含对称破缺）
  const s = createMinimax({ N: 2, rows, Q, x0, opts: { tolDb: 1e-7, maxIter: 120 } })
  const r = s.run()
  const spread = Math.max(...r.resid) - Math.min(...r.resid)
  ok('三站残差相等（等纹波）', spread < 1e-3, `极差 ${spread.toExponential(2)} dB`)
  ok('活跃站 = 3', r.active === 3, `${r.active} 站 · F=${r.maxRes.toExponential(2)} dB`)
  ok('收敛到解析最优（F → 0）', Math.abs(r.maxRes) < 1e-3, `F=${r.maxRes.toExponential(2)} · ${r.iters} 轮`)
}

// —— 合成算例（自足，不依赖 synth.js 内部）：一排 beamlet + 区内 contour 站 + 界外 sidelobe 站 ——
function lineProblem(nb = 7, sp = 1.0, th = 1.0, halfCov = 3.2, ns = 21, nSup = 8, supDb = -25) {
  const KF = 2 * Math.LN2
  const bc = []
  for (let j = 0; j < nb; j++) bc.push((j - (nb - 1) / 2) * sp * th)
  const gAt = (x, c) => Math.exp(-KF * (x - c) * (x - c) / (th * th))
  const gRef = -10 * Math.log10(2 * halfCov)
  const rows = []
  for (let m = 0; m < ns; m++) {
    const x = -halfCov + (2 * halfCov) * m / (ns - 1)
    rows.push({ nb: bc.map((_, j) => j), g: Float64Array.from(bc.map((c) => gAt(x, c))), sign: -1, T: gRef })
  }
  for (let m = 0; m < nSup; m++) {
    const d = halfCov + 1.15 * th + (3 * th) * m / (nSup - 1)
    for (const x of [-d, d]) rows.push({ nb: bc.map((_, j) => j), g: Float64Array.from(bc.map((c) => gAt(x, c))), sign: 1, T: gRef + supDb })
  }
  const omg1 = Math.PI * th * th / (4 * Math.LN2)
  const Q = new Float64Array(nb * nb)
  for (let j = 0; j < nb; j++) for (let k = 0; k < nb; k++) { const d = bc[j] - bc[k]; Q[j * nb + k] = omg1 * Math.exp(-Math.LN2 * d * d / (th * th)) }
  return { N: nb, rows, Q }
}

// ==================== ③ 实子空间锁死复现 + 对称破缺初值不吃亏 ====================
// g 全实 ⇒ 纯实初值下 ∂f/∂Im w ≡ 0：虚部方向的梯度整列为零，LP 只能给出 h_Im=0 的步 —— 实子空间
// 是 SLP 的不动点，「复激励」名存实亡。缺省初值叠 Im_j = 0.05·(−1)^j 的确定性破缺就是为了这个。
{
  const pr = lineProblem()
  const N = pr.N
  const xReal = new Float64Array(2 * N)
  for (let j = 0; j < N; j++) xReal[j] = 1                       // 纯实 Uniform
  const sR = createMinimax({ ...pr, x0: xReal })
  const rR = sR.run()
  let imMax = 0
  for (let j = 0; j < N; j++) imMax = Math.max(imMax, Math.abs(sR.x[N + j]))
  ok('纯实初值 → 终解虚部恒 0（实子空间锁死）', imMax < 1e-12, `max|Im| = ${imMax.toExponential(2)}`)

  const xBrk = new Float64Array(2 * N)
  for (let j = 0; j < N; j++) { xBrk[j] = 1; xBrk[N + j] = (j % 2 ? -0.05 : 0.05) }
  const sB = createMinimax({ ...pr, x0: xBrk })
  const rB = sB.run()
  let imB = 0
  for (let j = 0; j < N; j++) imB = Math.max(imB, Math.abs(sB.x[N + j]))
  ok('对称破缺初值 → 不差于纯实解', rB.maxRes <= rR.maxRes + 1e-6,
    `破缺 ${rB.maxRes.toFixed(4)} vs 纯实 ${rR.maxRes.toFixed(4)} dB（余量多 ${(rR.maxRes - rB.maxRes).toFixed(3)} dB）· max|Im|=${imB.toExponential(1)}`)

  // ==================== ④ 接受步单调 ====================
  const acc = rB.hist.filter((h) => h.acc)
  let mono = true, worstUp = 0
  for (let i = 1; i < acc.length; i++) { const up = acc[i].F - acc[i - 1].F; if (up > worstUp) worstUp = up; if (up > 1e-9) mono = false }
  ok('接受步 F 非增（单调）', mono && acc.length >= 2, `${acc.length} 个接受步 · 最大回升 ${worstUp.toExponential(2)} dB`)
  ok('终解活跃站 ≥ 2（等纹波活跃集）', rB.active >= 2, `${rB.active}/${rB.resid.length} 站在最差值 0.02 dB 内`)
  // 活跃集定义自洽：活跃站的残差确实都顶在最差值 0.02 dB 内
  let inBand = 0
  for (const v of rB.resid) if (v >= rB.maxRes - 0.02) inBand++
  ok('活跃站计数与残差带一致', inBand === rB.active, `${inBand} vs ${rB.active}`)
}

// ==================== ⑤ 三例口径基线：必须超过旧 IRLS 启发式 ====================
// 旧 IRLS（本仓 v1.4.3 实测）：2.4 m → 32.64 · 1.5 m → 31.76 · 4.0 m → 33.71 dBi。
// 严格 minimax 原型：33.71 / 32.90 / 34.19。断言取原型值下方留 0.2~0.3 dB 余地（局部极小 + 平台差异）。
const BASE = [
  { D: 2.4, floor: 33.4, irls: 32.64, ms: 3000 },
  { D: 1.5, floor: 32.4, irls: 31.76, ms: 3000 },
  { D: 4.0, floor: 34.0, irls: 33.71, ms: 6000 }
]
const shots = []
for (const bs of BASE) {
  const t0 = Date.now()
  const r = shaped(bs.D)
  const ms = Date.now() - t0
  const st = shapedStations({ ...SAT, polysPts: [POLY], theta3: shapedTheta3db(FGHZ, bs.D, TAPER) })
  shots.push({ ...bs, r, ms, nSt: st ? st.list.length : 0 })
  ok(`${bs.D} m 覆盖最低 ≥ ${bs.floor} dBi`, r.covMin >= bs.floor,
    `covMin ${r.covMin.toFixed(2)} dBi（旧 IRLS ${bs.irls}，+${(r.covMin - bs.irls).toFixed(2)} dB）· beamlet ${r.nBeams} · 站点 ${r.mm.nStations} · 活跃 ${r.mm.active} · SLP ${r.mm.iters} 轮 · LP ${r.mm.lpIters} 步 · LP 未收敛 ${r.mm.lpFail} · ${ms} ms`)
  ok(`${bs.D} m 耗时 < ${bs.ms / 1000} s`, ms < bs.ms, `${ms} ms`)
  ok(`${bs.D} m 无空洞（区内最低不低于边缘值 2 dB）`, r.covMin >= r.value - 2, `covMin ${r.covMin.toFixed(2)} vs 边缘 ${r.value.toFixed(2)}`)
  ok(`${bs.D} m 终解活跃站 ≥ 2`, r.mm.active >= 2, `${r.mm.active}/${r.mm.nStations}`)
}

// ==================== ⑥ 确定性：同参数两次调用逐字节相同 ====================
{
  const a = shaped(2.4), b = shaped(2.4)
  ok('反射面赋形两次生成逐字节相同', a.text === b.text, `${a.text.length} B`)
  ok('两次的 minimax 统计一致', a.mm.iters === b.mm.iters && a.mm.active === b.mm.active && a.mm.marginDb === b.mm.marginDb, `迭代 ${a.mm.iters} · 活跃 ${a.mm.active}`)
}

// ==================== ⑦ GRD 合规：能回读 · 表头纯 ASCII · SYNTHMETA 带 mm ====================
{
  const r = shots[0].r
  const g = parseGrd(r.text)
  const s0 = g && g.sets && g.sets[0]
  ok('parseGrd 能回读', !!s0 && s0.NX === r.nx && s0.NY === r.ny && s0.peakLin > 0,
    s0 ? `${g.sets.length} set · ${s0.NX}×${s0.NY} · icomp${g.icomp}/ncomp${g.ncomp}/igrid${g.igrid}` : '解析失败')
  const headLines = r.text.split('\r\n').slice(0, r.text.split('\r\n').indexOf('++++'))
  const nonAscii = headLines.filter((l) => /[^\x20-\x7E]/.test(l))
  ok('表头逐字节 ASCII', nonAscii.length === 0, nonAscii.length ? nonAscii[0].slice(0, 40) : `${headLines.length} 行`)
  const mLine = /^SYNTHMETA\s+(\{.*\})\s*$/m.exec(r.text)
  let meta = null
  try { meta = JSON.parse(mLine[1]) } catch { meta = null }
  ok('SYNTHMETA 单行且可 JSON.parse', !!meta, mLine ? `${mLine[1].length} B` : '未找到')
  ok('SYNTHMETA 带 mm 读数', !!meta && meta.mm && Number.isFinite(meta.mm.it) && Number.isFinite(meta.mm.act) && Number.isFinite(meta.mm.marg),
    meta && meta.mm ? `it=${meta.mm.it} act=${meta.mm.act} marg=${meta.mm.marg}` : '缺 mm')
}

// ==================== ⑧ 相控阵赋形冒烟 ====================
{
  const pam = { Nx: 48, Ny: 48, dxWl: 0.6, dyWl: 0.6, R: 1.2, tri: false, elem: true, eff: 65, fGHz: 12 }
  const run = () => buildPamShapedGrd({ ...SAT, polysPts: [POLY], pam, mode: 'physical', value: null })
  const t0 = Date.now()
  const r = run()
  const ms = Date.now() - t0
  const sum = r.excit.reduce((a, e) => a + e.powPct, 0)
  ok('PAM 激励功率占比和 = 100%', Math.abs(sum - 100) < 1e-6, `${sum.toFixed(9)}% · ${r.excit.length} 端口 · ${ms} ms`)
  ok('PAM 相位无 NaN', r.excit.every((e) => Number.isFinite(e.phaseDeg) && Number.isFinite(e.ampDb)), `相位范围 ${Math.min(...r.excit.map((e) => e.phaseDeg)).toFixed(1)}…${Math.max(...r.excit.map((e) => e.phaseDeg)).toFixed(1)}°`)
  // 复激励名副其实：严格 minimax 的解不再落在实轴上（0/180° 之外必须有值）
  const offAxis = r.excit.filter((e) => Math.min(Math.abs(e.phaseDeg), Math.abs(Math.abs(e.phaseDeg) - 180)) > 1).length
  ok('PAM 激励为复数（相位不只有 0/180°）', offAxis > 0, `${offAxis}/${r.excit.length} 个端口相位离实轴 >1°`)
  ok('PAM 无空洞（区内最低不低于边缘值 2 dB）', r.covMin >= r.value - 2, `covMin ${r.covMin.toFixed(2)} vs 边缘 ${r.value.toFixed(2)}`)
  ok('PAM 终解活跃站 ≥ 2', r.mm.active >= 2, `${r.mm.active}/${r.mm.nStations} · SLP ${r.mm.iters} 轮 · LP ${r.mm.lpIters} 步`)
  ok('PAM 两次生成逐字节相同', run().text === r.text, `${r.text.length} B`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
