// ITU-R P.682-4 航空移动海面反射多径（packages/core/utils/ntnChannel/p682.js）。运行：node packages/core/test/ntnP682.test.mjs
//
// 锁定：
//   ① P.527-6 §5.1 海水 / 纯水复介电常数：对照 P.527-6 Figure 2（T = 20 °C）读数，另与独立 Python 同值；
//   ② §4.2.1 Step 1–6 的中间量（γ_sp、θ_sp、θ_hr、G、R、C_θ、D、P_r）—— 期望值由独立 Python 另算；
//      菲涅尔系数在正入射 / 掠射的极限；
//   ③ Figure 2（1.54 GHz、圆极化、H_a = 10 km）：原文 θ_i 口径在 ≥ 9° 吻合、3°–5° 偏高 1–1.7 dB；
//      fresnelAngle: 'grazing'（θ_i + γ_sp）口径全段吻合 —— 两种口径都钉住，差异见 p682.js 文件头；
//   ④ Figure 1（总功率恒定的 Nakagami-Rice 分布）：α = 1 瑞利闭式、各 α 在 99.999% 处的读数；
//   ⑤ 式 (7) 的衰落深度与 NOTE 1（7 dBi、圆极化、1.5 GHz：低 / 中空 8–11 dB、2 km 以上 7–9 dB、15 dBi 约低 2 dB）；
//   ⑥ 适用范围（1–2 GHz、θ_i ≥ 3°、G(1.5θ_i) ≥ −10 dB、垂直极化 θ_i ≥ 8°）越界返回 null；Tables 1 / 2 逐值。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const M = require('../utils/ntnChannel/p682.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)

/* ---- ① P.527-6 海水 ---- */
{
  // P.527-6 Figure 2（T = 20 °C）读数：[f GHz, S, 实部, 虚部, 容差]
  const F2 = [[0.1, 0, 80.0, null, 0.5], [1, 0, 79.7, 4.6, 0.5], [10, 0, 60.5, 33, 1], [17, 0, null, 37.5, 1], [100, 0, 7.5, 13, 1],
    [0.1, 35, 71.5, null, 0.5], [1, 35, 71.3, 89, 2], [5.5, 35, null, 32, 1], [10, 35, 59, 34.5, 1], [100, 35, 7.6, 15, 1]]
  const bad = F2.filter(([f, S, re, im, tol]) => {
    const r = M.seaWaterPermittivity(f, 20, S)
    return (re != null && Math.abs(r.epsReal - re) > tol) || (im != null && Math.abs(r.epsImag - im) > tol)
  })
  ok('P.527-6 Figure 2（20 °C，纯水 / 35 g/kg 海水）十个频点读数', bad.length === 0, bad.map((x) => x[0] + '/' + x[1]).join(' '))
  const s = M.seaWaterPermittivity(1.54, 20, 35)
  ok('1.54 GHz、20 °C、35 g/kg：η = 71.309 − j60.917，σ = 4.7913 S/m（独立 Python 同值）',
    near(s.epsReal, 71.3087198250607, 1e-10) && near(s.epsImag, 60.91729203514935, 1e-10) && near(s.sigmaSm, 4.791266067182028, 1e-12))
  ok('S = 0 即纯水（§5.1.1 是 §5.1.2 的特例）：σ = 0', M.seaWaterPermittivity(10, 20, 0).sigmaSm === 0 &&
    near(M.seaWaterPermittivity(10, 20, 0).epsReal, 60.7886338659253, 1e-10))
  ok('P.527-6 适用范围外（T > 40 °C、S > 40）→ null', M.seaWaterPermittivity(1.5, 45, 35) === null && M.seaWaterPermittivity(1.5, 20, 41) === null)
}

/* ---- ② Step 1–6 中间量（独立 Python）---- */
{
  const r = M.multipathPower({ fGHz: 1.54, elevDeg: 10, heightKm: 10, gainDbi: 0 })
  ok('θ_i = 10°、H_a = 10 km：γ_sp = 0.408332°、θ_sp = 10.816665°、θ_hr = 3.208115°（式 2a / 2b）',
    near(r.gammaSp, 0.40833229101247503, 1e-12) && near(r.thetaSp, 10.81666458202495, 1e-12) && near(r.thetaHr, 3.2081154690901084, 1e-12))
  ok('…… R = −8.8782 dB、C_θ = 0、D = −0.33553 dB、P_r = −9.21373 dB（式 3–6）',
    near(r.R, -8.878197720339818, 1e-10) && r.c0 === 0 && near(r.D, -0.33553313926172457, 1e-12) && near(r.pr, -9.213730859601542, 1e-10))
  const r5 = M.multipathPower({ fGHz: 1.54, elevDeg: 5, heightKm: 10, gainDbi: 10 })
  ok('θ_i = 5°、G_m = 10 dBi：G = −0.35476、C_θ = (θ_sp − 7)/2 = −0.17704、P_r = −6.95973',
    near(r5.G, -0.3547647211258421, 1e-12) && near(r5.c0, -0.17703623420118353, 1e-12) && near(r5.pr, -6.95973327791549, 1e-10))
  const rh = M.multipathPower({ fGHz: 1.5, elevDeg: 20, heightKm: 2, gainDbi: 7, pol: 'horizontal' })
  ok('水平极化、H_a = 2 km、7 dBi、20°：P_r = −2.10983 dB', near(rh.pr, -2.109834390893191, 1e-10))
  ok('式 (1)：G(θ) = −4×10⁻⁴(10^(G_m/10) − 1)θ²；G_m = 0 dBi 处处为 0',
    near(M.relativeGainDb(15, 10), -4e-4 * (Math.pow(10, 1.5) - 1) * 100, 1e-12) && M.relativeGainDb(0, 30) === 0)
  const eta = { re: 71.3, im: -60.9 }
  const n = M.fresnelCoefficients(90, eta), g = M.fresnelCoefficients(1e-6, eta)
  const rootRe = Math.sqrt((Math.hypot(71.3, 60.9) + 71.3) / 2), rootIm = -Math.sqrt((Math.hypot(71.3, 60.9) - 71.3) / 2)
  const nr = ((1 - rootRe) * (1 + rootRe) - rootIm * rootIm) / ((1 + rootRe) ** 2 + rootIm ** 2)
  ok('正入射：R_V = −R_H，R_H = (1 − √η)/(1 + √η)', near(n.rv.re, -n.rh.re, 1e-12) && near(n.rv.im, -n.rh.im, 1e-12) && near(n.rh.re, nr, 1e-12))
  ok('掠射极限：R_H、R_V → −1', near(g.rh.re, -1, 1e-5) && near(g.rv.re, -1, 1e-4))
}

/* ---- ③ Figure 2 ---- */
{
  // 从 Figure 2 数字化（像素量取）的读数：G_m = 0 dBi 与 5 dBi
  const F0 = { 3: -7.98, 3.5: -7.82, 5: -7.60, 7: -8.09, 9: -9.13, 11: -10.08, 13: -10.94, 15: -11.80, 17: -12.69, 19: -13.55, 20: -14.0 }
  const F5 = { 7: -8.22, 9: -9.28, 11: -10.41, 13: -11.49, 15: -12.48, 17: -13.50, 19: -14.49 }
  const pr = (el, gm, mode) => M.multipathPower({ fGHz: 1.54, elevDeg: el, heightKm: 10, gainDbi: gm, fresnelAngle: mode }).pr
  const badElev = [], badGraz = []
  for (const [tab, gm] of [[F0, 0], [F5, 5]]) for (const k of Object.keys(tab)) {
    const el = Number(k)
    if (el >= 9 && Math.abs(pr(el, gm, 'elev') - tab[k]) > 0.5) badElev.push(gm + '@' + k)
    if (Math.abs(pr(el, gm, 'grazing') - tab[k]) > 0.5) badGraz.push(gm + '@' + k)
  }
  ok('Figure 2 原文 θ_i 口径：0 / 5 dBi 在 9°–20° 读数 ±0.5 dB', badElev.length === 0, badElev.join(','))
  ok('Figure 2 掠射角口径（θ_i + γ_sp）：0 / 5 dBi 全部 18 个读数（3°–20°）±0.5 dB', badGraz.length === 0, badGraz.join(','))
  ok('口径差异钉住：3° 处原文口径 −6.28 dB、掠射角口径 −7.56 dB、图 −7.98 dB',
    near(pr(3, 0, 'elev'), -6.275110006723085, 1e-9) && near(pr(3, 0, 'grazing'), -7.556415279007052, 1e-9))
  // 各增益曲线在 3° 的相对间隔就是 G(θ) 在 θ = θ_i + (θ_sp + θ_hr)/2 处的值（图上 −7.98/−8.19/−8.69/−9.29/−10.60/−13.22）
  const d3 = [10, 15, 18, 21, 24].map((gm) => pr(3, gm, 'elev') - pr(3, 0, 'elev'))
  const fig = [-8.19, -8.69, -9.29, -10.60, -13.22].map((v) => v - (-7.98))
  ok('Figure 2 在 3° 处各增益曲线相对 0 dBi 的间隔（10/15/18/21/24 dBi）±0.4 dB', d3.every((v, i) => Math.abs(v - fig[i]) <= 0.4),
    d3.map((v) => v.toFixed(2)).join(' '))
  ok('fresnelAngle 只认 elev / grazing', M.multipathPower({ fGHz: 1.54, elevDeg: 10, heightKm: 10, gainDbi: 0, fresnelAngle: 'x' }) === null)
}

/* ---- ④ Figure 1（Nakagami-Rice，总功率 0 dB）---- */
{
  const R = [[99.999, -49.99997828515697], [99.9, -29.997827622267543], [99, -19.97819425120579], [90, -9.77322112507164], [50, -1.591745389548616]]
  ok('α = 1（瑞利）：被超过 p% 的电平 = 10lg(−ln(p/100)) 五点到 1e-7 dB',
    R.every(([p, v]) => near(M.nakagamiRiceLevelDb(1, p), v, 1e-7)))
  ok('α = 0.1 / 0.05 / 0.2 的分位点与独立 Python（细网格 Simpson）同值到 1e-6 dB',
    near(M.nakagamiRiceLevelDb(0.1, 99), -6.630289769252, 1e-6) && near(M.nakagamiRiceLevelDb(0.05, 99.9), -5.9556421085478295, 1e-6) &&
    near(M.nakagamiRiceLevelDb(0.2, 90), -5.007681587583006, 1e-6))
  // Figure 1 右边框（99.999%）处各曲线的数字化读数
  const F1 = [[0.025, -5.86], [0.05, -9.92], [0.075, -14.87], [0.1, -21.98], [0.15, -33.71], [0.2, -39.22], [0.3, -44.94], [0.4, -47.17], [0.5, -48.35]]
  const bad = F1.filter(([a, v]) => Math.abs(M.nakagamiRiceLevelDb(a, 99.999) - v) > 0.5)
  ok('Figure 1 在 99.999% 处九条曲线读数 ±0.5 dB', bad.length === 0, bad.map((x) => x[0]).join(','))
  ok('α 越界（≤ 0、> 1）→ null', M.nakagamiRiceLevelDb(0, 99) === null && M.nakagamiRiceLevelDb(1.2, 99) === null)
}

/* ---- ⑤ 式 (7) 与 NOTE 1 ---- */
{
  const a = { fGHz: 1.54, elevDeg: 6, heightKm: 10, gainDbi: 7 }
  const r = M.fadeDepthDb(1, a)
  const mp = M.multipathPower(a)
  const alpha = Math.pow(10, mp.pr / 10) / (1 + Math.pow(10, mp.pr / 10))
  ok('式 (7)：F_d(p) = −[A + 10lg(1 + 10^(P_r/10))]，A 为 (100 − p)% 时间被超过的电平',
    near(r.fadeDb, -(M.nakagamiRiceLevelDb(alpha, 99) + 10 * Math.log10(1 + Math.pow(10, mp.pr / 10))), 1e-9) && near(r.alpha, alpha, 1e-15))
  // NOTE 1 没写仰角与时间百分比；按海面多径最典型的低仰角 5°–7°、p = 1% 核对其「about」量级
  const fd = (gm, ha, el) => M.fadeDepthDb(1, { fGHz: 1.54, elevDeg: el, heightKm: ha, gainDbi: gm }).fadeDb
  const ELS = [5, 6, 7]
  const hi7 = ELS.map((el) => fd(7, 10, el)), lo7 = ELS.map((el) => fd(7, 0.5, el)), hi15 = ELS.map((el) => fd(15, 10, el))
  ok('NOTE 1：7 dBi、H_a = 10 km（> 2 km）、5°–7°、p = 1% 的衰落约 7–9 dB（取 7–9.5）', hi7.every((v) => v >= 7 && v <= 9.5), hi7.map((v) => v.toFixed(2)).join(' '))
  ok('NOTE 1：7 dBi、H_a = 0.5 km（低空）、5°–7° 的衰落约 8–11 dB', lo7.every((v) => v >= 8 && v <= 11), lo7.map((v) => v.toFixed(2)).join(' '))
  ok('NOTE 1：15 dBi 比 7 dBi 低约 2 dB（同条件差 1–3 dB）', hi15.every((v, i) => hi7[i] - v >= 1 && hi7[i] - v <= 3),
    hi15.map((v, i) => (hi7[i] - v).toFixed(2)).join(' '))
  ok('p 越小衰落越深', fd(7, 10, 6) < M.fadeDepthDb(0.1, { fGHz: 1.54, elevDeg: 6, heightKm: 10, gainDbi: 7 }).fadeDb)
}

/* ---- ⑥ 适用范围与 Tables 1 / 2 ---- */
{
  const base = { fGHz: 1.5, elevDeg: 10, heightKm: 10, gainDbi: 0 }
  ok('频率 ∉ [1, 2] GHz → null', M.multipathPower(Object.assign({}, base, { fGHz: 2.5 })) === null)
  ok('θ_i < 3° → null', M.multipathPower(Object.assign({}, base, { elevDeg: 2 })) === null)
  ok('垂直极化 θ_i < 8° → null；≥ 8° 可算', M.multipathPower(Object.assign({}, base, { elevDeg: 5, pol: 'vertical' })) === null &&
    M.multipathPower(Object.assign({}, base, { elevDeg: 8, pol: 'vertical' })) !== null)
  ok('G(1.5θ_i) < −10 dB（24 dBi @10°）→ null', M.multipathPower(Object.assign({}, base, { gainDbi: 24 })) === null)
  const f = M.multipathPower(Object.assign({}, base, { fGHz: 2.5, gainDbi: 24, allowOutOfRange: true }))
  ok('allowOutOfRange 照算并给原因码', f && f.applicable === false && f.reasons.join(',') === 'freq,gainRolloff')
  ok('直接给 η 或 ε_r + σ 覆盖海水模型（η = ε_r − j60λσ）',
    near(M.multipathPower(Object.assign({}, base, { epsR: 70, sigmaSm: 5 })).eta.im, 60 * 0.299792458 / 1.5 * 5, 1e-12) &&
    M.multipathPower(Object.assign({}, base, { eta: { re: 70, im: 60 } })).eta.im === 60)
  ok('Table 1（海面）逐值抽查：水平极化归一化多径功率 −5.5 ~ −0.5 dB，典型 8°/15°/30° = −2.5/−1/−1.5',
    JSON.stringify(M.OCEAN_MULTIPATH.normPowerDb.horizontal) === JSON.stringify({ range: [-5.5, -0.5], typical: { 8: -2.5, 15: -1, 30: -1.5 } }) &&
    JSON.stringify(M.OCEAN_MULTIPATH.normPowerDb.vertical) === JSON.stringify({ range: [-15, -2.5], typical: { 8: -14.5, 15: -9, 30: -3.5 } }))
  ok('Table 1：时延扩展、相关带宽、多普勒扩展（含 10 km / 1 000 km/h 模型值）、去相关时间',
    M.OCEAN_MULTIPATH.delaySpreadUs.db10.typical[15] === 3.2 && M.OCEAN_MULTIPATH.corrBandwidthKHz.db3.range[1] === 380 &&
    M.OCEAN_MULTIPATH.dopplerSpreadHz.inPlane.db10.model8 === 40 && M.OCEAN_MULTIPATH.dopplerSpreadHz.crossPlane.db10.typical[30] === 470 &&
    M.OCEAN_MULTIPATH.decorrTimeMs.db3.typical[8] === 7.5)
  ok('Table 2（陆面）逐值抽查', M.LAND_MULTIPATH.normPowerDb.horizontal.typical === -9 && M.LAND_MULTIPATH.normPowerDb.vertical.range[0] === -21 &&
    M.LAND_MULTIPATH.corrBandwidthKHz.db3.range[1] === 3000 && M.LAND_MULTIPATH.dopplerSpreadHz.db3.typical === 260 &&
    M.LAND_MULTIPATH.decorrTimeMs.db3.typical === 4)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
