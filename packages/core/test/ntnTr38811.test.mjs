// 3GPP TR 38.811 V15.4.0 §6.6 大尺度参数（packages/core/utils/ntnChannel/tr38811.js）。运行：node packages/core/test/ntnTr38811.test.mjs
//
// 锁定：
//   ① Table 6.6.1-1 LOS 概率、Table 6.6.2-1/-2/-3 的 σ_SF 与 CL、Table 6.6.6.2.1-1 对流层闪烁 —— 逐值钉住；
//      下面的期望值是对着原文 PDF（38811-f40）重新逐格抄的一份，与库里的表互为校对；
//   ② 仰角规则：缺省线性插值；nearest = 原文「取最近参考仰角」；10° 以下两种规则都落到 10° 档；
//   ③ 位置覆盖概率 P_cov(M) = P_LOS·Φ(M/σ_LOS) + (1−P_LOS)·Φ((M−CL)/σ_NLOS)：期望值由独立的 Python
//      （math / statistics.NormalDist）按同一公式另算，不经过本库；反函数 requiredMarginDb 同此；
//   ④ P.2108 / P.2109 只留接口：extraLossDb 平移、extraLossQuantile 求期望、nlosClutterDb 覆盖；
//   ⑤ 式 (6.6-2)(6.6-3) 复算 TR 38.821 Table 6.1.3.3-1 的 12 种自由空间损耗（到 0.1 dB）；
//   ⑥ §6.6.6 闪烁：2 GHz 电离层 2.2 dB（原文示例式）、纬度规则、式 (6.6-11)(6.6-14)、Table 6.6.6.1.1-1 分档。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const T = require('../utils/ntnChannel/tr38811.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/* ---- ① 表格逐值 ---- */
// Table 6.6.1-1 LOS probability（%）
ok('Table 6.6.1-1 密集城区 LOS 概率逐值（10°…90°）',
  same(T.LOS_PROB_PCT.denseUrban, [28.2, 33.1, 39.8, 46.8, 53.7, 61.2, 73.8, 82.0, 98.1]))
ok('Table 6.6.1-1 城区 LOS 概率逐值',
  same(T.LOS_PROB_PCT.urban, [24.6, 38.6, 49.3, 61.3, 72.6, 80.5, 91.9, 96.8, 99.2]))
ok('Table 6.6.1-1 郊区与乡村（同一列）LOS 概率逐值',
  same(T.LOS_PROB_PCT.suburbanRural, [78.2, 86.9, 91.9, 92.9, 93.5, 94.0, 94.9, 95.2, 99.8]))
ok('参考仰角 10°…90° 每 10° 一档（§6.6.1）', same(T.ELEV_REF, [10, 20, 30, 40, 50, 60, 70, 80, 90]))

// Table 6.6.2-1 dense urban
ok('Table 6.6.2-1 密集城区 S 频段 LOS σ_SF', same(T.SF_CL.denseUrban.S.sfLos, [3.5, 3.4, 2.9, 3.0, 3.1, 2.7, 2.5, 2.3, 1.2]))
ok('Table 6.6.2-1 密集城区 S 频段 NLOS σ_SF', same(T.SF_CL.denseUrban.S.sfNlos, [15.5, 13.9, 12.4, 11.7, 10.6, 10.5, 10.1, 9.2, 9.2]))
ok('Table 6.6.2-1 密集城区 S 频段 NLOS CL', same(T.SF_CL.denseUrban.S.clNlos, [34.3, 30.9, 29.0, 27.7, 26.8, 26.2, 25.8, 25.5, 25.5]))
ok('Table 6.6.2-1 密集城区 Ka 频段 LOS σ_SF', same(T.SF_CL.denseUrban.Ka.sfLos, [2.9, 2.4, 2.7, 2.4, 2.4, 2.7, 2.6, 2.8, 0.6]))
ok('Table 6.6.2-1 密集城区 Ka 频段 NLOS σ_SF', same(T.SF_CL.denseUrban.Ka.sfNlos, [17.1, 17.1, 15.6, 14.6, 14.2, 12.6, 12.1, 12.3, 12.3]))
ok('Table 6.6.2-1 密集城区 Ka 频段 NLOS CL', same(T.SF_CL.denseUrban.Ka.clNlos, [44.3, 39.9, 37.5, 35.8, 34.6, 33.8, 33.3, 33.0, 32.9]))
// Table 6.6.2-2 urban
ok('Table 6.6.2-2 城区 S：σ_SF 恒为 LOS 4 / NLOS 6', same(T.SF_CL.urban.S.sfLos, Array(9).fill(4)) && same(T.SF_CL.urban.S.sfNlos, Array(9).fill(6)))
ok('Table 6.6.2-2 城区 S 频段 NLOS CL（与密集城区同列）', same(T.SF_CL.urban.S.clNlos, [34.3, 30.9, 29.0, 27.7, 26.8, 26.2, 25.8, 25.5, 25.5]))
ok('Table 6.6.2-2 城区 Ka：σ_SF 恒为 4 / 6', same(T.SF_CL.urban.Ka.sfLos, Array(9).fill(4)) && same(T.SF_CL.urban.Ka.sfNlos, Array(9).fill(6)))
ok('Table 6.6.2-2 城区 Ka 频段 NLOS CL', same(T.SF_CL.urban.Ka.clNlos, [44.3, 39.9, 37.5, 35.8, 34.6, 33.8, 33.3, 33.0, 32.9]))
// Table 6.6.2-3 suburban & rural
ok('Table 6.6.2-3 郊区/乡村 S 频段 LOS σ_SF', same(T.SF_CL.suburbanRural.S.sfLos, [1.79, 1.14, 1.14, 0.92, 1.42, 1.56, 0.85, 0.72, 0.72]))
ok('Table 6.6.2-3 郊区/乡村 S 频段 NLOS σ_SF', same(T.SF_CL.suburbanRural.S.sfNlos, [8.93, 9.08, 8.78, 10.25, 10.56, 10.74, 10.17, 11.52, 11.52]))
ok('Table 6.6.2-3 郊区/乡村 S 频段 NLOS CL', same(T.SF_CL.suburbanRural.S.clNlos, [19.52, 18.17, 18.42, 18.28, 18.63, 17.68, 16.50, 16.30, 16.30]))
ok('Table 6.6.2-3 郊区/乡村 Ka 频段 LOS σ_SF', same(T.SF_CL.suburbanRural.Ka.sfLos, [1.9, 1.6, 1.9, 2.3, 2.7, 3.1, 3.0, 3.6, 0.4]))
ok('Table 6.6.2-3 郊区/乡村 Ka 频段 NLOS σ_SF', same(T.SF_CL.suburbanRural.Ka.sfNlos, [10.7, 10.0, 11.2, 11.6, 11.8, 10.8, 10.8, 10.8, 10.8]))
ok('Table 6.6.2-3 郊区/乡村 Ka 频段 NLOS CL', same(T.SF_CL.suburbanRural.Ka.clNlos, [29.5, 24.6, 21.9, 20.0, 18.7, 17.8, 17.2, 16.9, 16.8]))
// Table 6.6.6.2.1-1
ok('Table 6.6.6.2.1-1 对流层闪烁（20 GHz Toulouse 99%）逐值',
  same(T.TROPO_SCINT_99_DB, [1.08, 0.48, 0.30, 0.22, 0.17, 0.13, 0.12, 0.12, 0.12]))
// 四个场景键都能用，郊区与乡村取同一份数据
{
  const a = T.largeScaleParams('suburban', 'Ka', 37), b = T.largeScaleParams('rural', 'Ka', 37)
  ok('郊区 = 乡村（Table 6.6.1-1 同列、Table 6.6.2-3 同表）',
    ['pLos', 'sigmaLos', 'sigmaNlos', 'clNlos'].every((k) => a[k] === b[k]))
}
ok('认不出的场景 / 频段返回 null（不回落）',
  T.losProbability('indoor', 30) === null && T.clutterLoss('urban', 'Ku', 30) === null && T.shadowFadingSigma('urban', '', true, 30) === null)

/* ---- ② 仰角规则 ---- */
{
  let allRef = true
  for (const sc of T.SCENARIOS) for (const b of ['S', 'Ka']) for (let i = 0; i < 9; i++) {
    const e = T.ELEV_REF[i]
    const a = T.largeScaleParams(sc, b, e), n = T.largeScaleParams(sc, b, e, { elevRule: 'nearest' })
    if (!near(a.clNlos, n.clNlos) || !near(a.sigmaLos, n.sigmaLos) || !near(a.sigmaNlos, n.sigmaNlos) || !near(a.pLos, n.pLos)) allRef = false
  }
  ok('参考仰角上两种规则取值一致（4 场景 × 2 频段 × 9 档）', allRef)
}
ok('线性插值：城区 15° LOS 概率 = (24.6 + 38.6)/2 %', near(T.losProbability('urban', 15), 0.316, 1e-12))
ok('线性插值：密集城区 S 25° CL = (30.9 + 29.0)/2', near(T.clutterLoss('denseUrban', 'S', 25), 29.95, 1e-12))
ok('nearest：14° → 10° 档、16° → 20° 档', near(T.clutterLoss('denseUrban', 'S', 14, { elevRule: 'nearest' }), 34.3) &&
  near(T.clutterLoss('denseUrban', 'S', 16, { elevRule: 'nearest' }), 30.9))
ok('nearest：正好居中（15°）取较低仰角档（更保守）', near(T.clutterLoss('denseUrban', 'S', 15, { elevRule: 'nearest' }), 34.3))
{
  const a = T.largeScaleParams('urban', 'Ka', 5)
  ok('10° 以下落到 10° 档并标 elevClamped', a.elevClamped === true && a.elevUsed === 10 && near(a.clNlos, 44.3) && near(a.pLos, 0.246))
}
ok('仰角 ≤ 0、> 90、非数返回 null', T.losProbability('urban', 0) === null && T.losProbability('urban', 91) === null &&
  T.losProbability('urban', NaN) === null && T.losProbability('urban', '') === null)

/* ---- ③ 位置覆盖概率（期望值 = 独立 Python 计算）---- */
const COV = [
  [[3, 'rural', 'S', 12.5, 'nearest'], 0.752357711792493],
  [[3, 'rural', 'S', 12.5, 'linear'], 0.7844953323118066],
  [[3, 'denseUrban', 'S', 12.5, 'nearest'], 0.24241607903077933],
  [[3, 'urban', 'S', 12.5, 'nearest'], 0.19024973999400674],
  [[10, 'denseUrban', 'Ka', 35, 'linear'], 0.454975014632157],
  [[0, 'urban', 'Ka', 90, 'linear'], 0.49600000016695417],
  [[20, 'denseUrban', 'S', 30, 'nearest'], 0.5388551868162039],
  [[-2, 'suburban', 'Ka', 47, 'linear'], 0.20689492948918986]
]
for (const [[m, sc, b, e, rule], want] of COV) {
  const got = T.coverageProbability(m, sc, b, e, { elevRule: rule })
  ok(`P_cov(M=${m} dB, ${sc}, ${b}, ${e}°, ${rule}) = ${want.toFixed(6)}`, near(got, want, 1e-12), String(got))
}
{
  const r = T.coverageBreakdown(3, 'rural', 'S', 12.5, { elevRule: 'nearest' })
  ok('细项自洽：p = P_LOS·P(闭合|LOS) + (1−P_LOS)·P(闭合|NLOS)', near(r.p, r.pLos * r.pCloseLos + (1 - r.pLos) * r.pCloseNlos, 1e-15))
  ok('LOS 不计 CL：P(闭合|LOS) = Φ(3/1.79)', near(r.pCloseLos, 0.9531287151077301, 1e-12) && r.clNlos === 19.52)
}
{
  let mono = true, prev = -1
  for (let m = -40; m <= 120; m += 2) {
    const p = T.coverageProbability(m, 'denseUrban', 'S', 20)
    if (!(p >= prev)) mono = false
    prev = p
  }
  ok('P_cov 对余量单调不减、两端趋于 0 / 1', mono && T.coverageProbability(-80, 'urban', 'S', 30) < 1e-6 &&
    T.coverageProbability(200, 'urban', 'S', 30) > 1 - 1e-12)
}
const REQ = [
  [[0.95, 'denseUrban', 'S', 30, 'linear'], 46.17154733061909],
  [[0.95, 'urban', 'S', 30, 'linear'], 36.73675231637118],
  [[0.95, 'suburban', 'S', 30, 'linear'], 15.800441582869691],
  [[0.95, 'denseUrban', 'Ka', 30, 'linear'], 59.10291438368209],
  [[0.99, 'rural', 'S', 12.5, 'nearest'], 34.578422980328284],
  [[0.5, 'urban', 'Ka', 55, 'linear'], 1.575548977086164]
]
for (const [[p, sc, b, e, rule], want] of REQ) {
  const got = T.requiredMarginDb(p, sc, b, e, { elevRule: rule })
  ok(`所需余量 P_cov = ${p}（${sc}, ${b}, ${e}°）= ${want.toFixed(3)} dB`, near(got, want, 1e-6), String(got))
}
ok('「十到数十 dB」：S 频段 30° 达 95% 位置覆盖，郊区 ≈ 16 dB、密集城区 ≈ 46 dB',
  T.requiredMarginDb(0.95, 'suburban', 'S', 30) > 10 && T.requiredMarginDb(0.95, 'denseUrban', 'S', 30) > 40)
ok('requiredMarginDb 越界概率返回 null', T.requiredMarginDb(1, 'urban', 'S', 30) === null && T.requiredMarginDb(0, 'urban', 'S', 30) === null)
ok('只看 LOS 的阴影余量 = Φ⁻¹(0.95)·σ_LOS（郊区 S 30°：1.6449 × 1.14）',
  near(T.losShadowMarginDb(0.95, 'suburban', 'S', 30), 1.6448536269514722 * 1.14, 1e-9))

/* ---- ④ P.2108 / P.2109 接口参数 ---- */
ok('extraLossDb = 5 等价于余量减 5 dB',
  near(T.coverageProbability(10, 'urban', 'S', 40, { extraLossDb: 5 }), T.coverageProbability(5, 'urban', 'S', 40), 1e-15))
ok('extraLossQuantile 为常数 5 dB 时 = extraLossDb 5 dB',
  near(T.coverageProbability(10, 'urban', 'S', 40, { extraLossQuantile: () => 5 }), T.coverageProbability(5, 'urban', 'S', 40), 1e-9))
{
  // 两点分布：一半位置 0 dB、一半位置 12 dB（模拟室内 / 室外混合）
  const q = (u) => (u < 0.5 ? 0 : 12)
  const want = 0.5 * T.coverageProbability(20, 'suburban', 'S', 30) + 0.5 * T.coverageProbability(8, 'suburban', 'S', 30)
  ok('extraLossQuantile 两点分布 = 两种余量覆盖概率的平均', near(T.coverageProbability(20, 'suburban', 'S', 30, { extraLossQuantile: q }), want, 1e-6))
}
ok('nlosClutterDb 覆盖：传 0 即 NLOS 不计 CL', near(T.coverageBreakdown(10, 'urban', 'S', 30, { nlosClutterDb: 0 }).pCloseNlos, 0.9522096477271853, 1e-12))
ok('extraLossQuantile 返回非数 → null', T.coverageProbability(10, 'urban', 'S', 30, { extraLossQuantile: () => 'x' }) === null)

/* ---- ⑤ 式 (6.6-2)(6.6-3) 复算 TR 38.821 Table 6.1.3.3-1 的 FSPL ---- */
const FSPL_38821 = [
  // [高度 m, 仰角, 频率 GHz, 表值 dB]（GEO Set-1 12.5°、GEO Set-2 20°、LEO 30°；S = 2 GHz，Ka = 20 / 30 GHz）
  [35786e3, 12.5, 2, 190.6], [35786e3, 20, 2, 190.4], [600e3, 30, 2, 159.1], [1200e3, 30, 2, 164.5],
  [35786e3, 12.5, 20, 210.6], [35786e3, 12.5, 30, 214.1], [35786e3, 20, 20, 210.4], [35786e3, 20, 30, 213.9],
  [600e3, 30, 20, 179.1], [600e3, 30, 30, 182.6], [1200e3, 30, 20, 184.5], [1200e3, 30, 30, 188.0]
]
{
  const bad = FSPL_38821.filter(([h, e, f, v]) => Math.abs(Math.round(T.fsplDb(T.slantRangeM(h, e), f) * 10) / 10 - v) > 1e-9)
  ok('式 (6.6-2)(6.6-3)（R_E = 6371 km）复算 TR 38.821 Table 6.1.3.3-1 的 12 种 FSPL，四舍五入到 0.1 dB 全对', bad.length === 0, bad.map((x) => x.join('/')).join(' '))
}
ok('斜距：GEO 12.5° = 40 316.68 km（独立计算）', near(T.slantRangeM(35786e3, 12.5), 40316680.19122387, 1e-3))
ok('斜距：仰角 90° = 高度本身', near(T.slantRangeM(600e3, 90), 600e3, 1e-6))
ok('式 (6.6-8)：A_zenith/sin α（0.0433 dB @12.5° → 0.20 dB，对得上 38.821 GEO S 频段大气损耗）',
  near(T.atmosphericLossDb(0.0433, 12.5), 0.0433 / Math.sin(12.5 * Math.PI / 180), 1e-12) && Math.round(T.atmosphericLossDb(0.0433, 12.5) * 10) / 10 === 0.2)

/* ---- ⑥ §6.6.6 闪烁 ---- */
ok('电离层 2 GHz：A_IS = 1.1 × 0.5^−1.5/√2 = 2.2 dB（§6.6.6.1.4 末式）', near(T.ionoScintillation(2).lossDb, 1.1 * Math.pow(0.5, -1.5) / Math.SQRT2, 1e-12) &&
  Math.round(T.ionoScintillation(2).lossDb * 10) / 10 === 2.2)
ok('电离层纬度规则：|lat| ≤ 20° 计入，20°–60° 与 60° 以上取 0',
  near(T.scintillationLossDb(2, 30, { latDeg: -15 }), 2.2, 1e-12) && T.scintillationLossDb(2, 30, { latDeg: 25 }) === 0 &&
  T.scintillationLossDb(2, 30, { latDeg: 70 }) === 0)
ok('不给纬度 = TR 38.821 链路预算基线（一律计入）', near(T.scintillationLossDb(2, 30), 2.2, 1e-12) && T.ionoScintillation(2).latApplied === false)
ok('电离层频率换算 (f/4)^−1.5：1.5 GHz 比 2 GHz 大', T.ionoScintillation(1.5).lossDb > T.ionoScintillation(2).lossDb &&
  near(T.ionoScintillation(1.5).pflucDb, 1.1 * Math.pow(1.5 / 4, -1.5), 1e-12))
ok('≥ 6 GHz 不计电离层、改取对流层表', T.ionoScintillation(10).lossDb === 0 && near(T.scintillationLossDb(20, 30), 0.30))
ok('对流层 nearest：GEO 12.5° → 10° 档 1.08 dB（TR 38.821 SC1 闪烁 1.1 dB 即此）',
  near(T.tropoScintillationDb(12.5, { elevRule: 'nearest' }), 1.08) && near(T.tropoScintillationDb(12.5), 0.93, 1e-12))
ok('式 (6.6-14)：P_fluc = 27.5·S4^1.26，反解自洽', near(T.pflucFromS4(0.3), 27.5 * Math.pow(0.3, 1.26), 1e-12) &&
  near(T.s4FromPfluc(T.pflucFromS4(0.47)), 0.47, 1e-12))
ok('式 (6.6-11)：S4 从 L1 换到 L2（n = 1.5）', near(T.scaleS4(0.4, 1.57542, 1.2276), 0.4 * Math.pow(1.2276 / 1.57542, -1.5), 1e-12))
ok('式 (6.6-12)：σφ 换算缺省 n = 1', near(T.scaleSigmaPhi(0.2, 1.57542, 1.17645), 0.2 * 1.57542 / 1.17645, 1e-12))
ok('Table 6.6.6.1.1-1 分档：0.29 弱 / 0.3 中 / 0.6 中 / 0.61 强',
  T.scintRegime(0.29) === 'weak' && T.scintRegime(0.3) === 'moderate' && T.scintRegime(0.6) === 'moderate' && T.scintRegime(0.61) === 'strong')

/* ---- 频段口径 ---- */
ok('bandOfFreq：< 6 GHz 用 S 参数、≥ 6 GHz 用 Ka 参数；标称区间外标 nominal = false',
  T.bandOfFreq(2).band === 'S' && T.bandOfFreq(2).nominal && T.bandOfFreq(1.6).nominal &&
  T.bandOfFreq(12).band === 'Ka' && !T.bandOfFreq(12).nominal && T.bandOfFreq(20).nominal && T.bandOfFreq(0) === null)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
