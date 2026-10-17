// ITU-R P.681-11 陆地移动卫星衰落（packages/core/utils/ntnChannel/p681.js）+ 共用数值底座 numeric.js。
// 运行：node packages/core/test/ntnP681.test.mjs
//
// 锁定：
//   ① 数值底座：erf / Φ⁻¹ / I0e 对照 50 位十进制参考值；莱斯 CDF 用 Marcum Q 的三条恒等式核对；
//   ② Annex 2 的 54 张参数表：清单（Tables 8/9/10）、逐格抽查（对照原文 PDF 页面）、原表两处印错标签的
//      表按位置取数、郊区 70° 与城区 70° 原文同值；
//   ③ 式 (17a)(17b)(19) 的状态时长与概率 —— 期望值由独立 Python 另算；
//   ④ 式 (20)(21) 信号 CDF、式 (22)(23) 莱斯因子 CDF、式 (24)(25) 总功率 CDF 对 Figures 12–14 的读数：
//      正文口径（缺省）在 0 ~ −10 dB 吻合；深尾按「BAD 只截上限」（badMaLowerCut: false）才与图一致 ——
//      两种口径都钉住，差异见 p681.js 文件头；
//   ⑤ 衰落余量是 CDF 的反函数；Step 0 选表规则；越界返回 null；
//   ⑥ §4.1.1 路边树木（式 1–5 + Table 1 外推）、§4.2 路边建筑（式 8，Figure 4 读数）、§5 多径（Tables 3 / 4）。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const N = require('../utils/ntnChannel/numeric.js')
const P = require('../utils/ntnChannel/p681.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)

/* ---- ① 数值底座 ---- */
ok('erf(0.5) / erf(1) / erf(2)（参考值到 1e-15）', near(N.erf(0.5), 0.5204998778130465, 2e-16) &&
  near(N.erf(1), 0.8427007929497149, 2e-16) && near(N.erf(2), 0.9953222650189527, 4e-16) && near(N.erf(-1), -0.8427007929497149, 2e-16))
ok('erfc 尾部相对精度：erfc(3)、erfc(5)', near(N.erfc(3) / 2.209049699858544e-05, 1, 1e-13) && near(N.erfc(5) / 1.5374597944280349e-12, 1, 1e-13))
ok('Φ(−8) 左尾相对精度', near(N.normCdf(-8) / 6.22096057427178e-16, 1, 1e-12))
{
  const Q = [[0.5, 0], [0.9, 1.2815515655446004], [0.95, 1.6448536269514722], [0.975, 1.959963984540054],
    [0.99, 2.3263478740408408], [0.999, 3.090232306167813], [1e-6, -4.753424308822899], [0.01, -2.3263478740408408]]
  const bad = Q.filter(([p, z]) => !near(N.normInv(p), z, 1e-12))
  ok('Φ⁻¹ 八个分位点到 1e-12', bad.length === 0, bad.map((x) => x[0]).join(','))
}
// I0e 参考值：50 位十进制幂级数（scratch 里的 Python decimal 计算）
ok('I0e(1)、I0e(2)、I0e(10)', near(N.besselI0e(1), 0.46575960759364043, 1e-15) && near(N.besselI0e(2), 0.30850832255367104, 1e-15) &&
  near(N.besselI0e(10), 0.12783333716342861, 1e-15))
ok('I0e 级数 / 渐近分界两侧：x = 15 与 15.0000001', near(N.besselI0e(15), 0.10389953144882272, 1e-15) &&
  near(N.besselI0e(15.0000001), 0.10389953109628708, 1e-14))
ok('I0e(20)、I0e(30)、I0e(50)（渐近级数）', near(N.besselI0e(20), 0.08978031188482602, 1e-14) &&
  near(N.besselI0e(30), 0.07314594648223729, 1e-14) && near(N.besselI0e(50), 0.056561626647454193, 1e-14))
{
  let bad = []
  for (const a of [0.5, 2, 5, 20, 60]) {
    // Q1(a, a) = ½[1 + e^{−a²} I0(a²)]
    if (!near(N.marcumQ1(a, a), 0.5 * (1 + N.besselI0e(a * a)), 1e-10)) bad.push('eq' + a)
  }
  for (const [a, b] of [[1, 2], [3, 1], [10, 12], [30, 27], [0.2, 3], [50, 49]]) {
    // Q1(a,b) + Q1(b,a) = 1 + e^{−(a²+b²)/2} I0(ab)
    if (!near(N.marcumQ1(a, b) + N.marcumQ1(b, a), 1 + Math.exp(-(a - b) * (a - b) / 2) * N.besselI0e(a * b), 1e-10)) bad.push(a + '/' + b)
  }
  ok('Marcum Q 恒等式（Q1(a,a)、Q1(a,b)+Q1(b,a)）11 组到 1e-10', bad.length === 0, bad.join(','))
}
ok('瑞利闭式：Q1(0, b) = e^{−b²/2}', near(N.marcumQ1(0, 2), Math.exp(-2), 1e-15))
ok('无多径时直射分量确定：riceCdf(x0, a, 0)', N.riceCdf(1, 0.9, 0) === 1 && N.riceCdf(1, 1.1, 0) === 0)
ok('Gauss–Legendre 16 点对 31 次多项式精确', near(N.integrate((x) => Math.pow(x, 31) + Math.pow(x, 30), 0, 1, 16), 1 / 32 + 1 / 31, 1e-14))
ok('Brent 求根', near(N.brentRoot((x) => x * x - 2, 0, 2, 1e-14), Math.SQRT2, 1e-13) && N.brentRoot((x) => x * x + 1, 0, 2) === null)

/* ---- ② 参数表 ---- */
const T = P.P681_TABLES
ok('Annex 2 共 54 张参数表（2.2 GHz 24 + 3.8 GHz 24 + 10–20 GHz 6）', T.length === 54 &&
  T.filter((t) => t.fGHz === 2.2).length === 24 && T.filter((t) => t.fGHz === 3.8).length === 24 &&
  T.filter((t) => t.fGHz >= 10).length === 6)
{
  const inv = (f) => {
    const m = {}
    for (const t of T.filter((x) => x.fGHz === f)) (m[t.env] = m[t.env] || []).push(t.elev)
    return m
  }
  const want = { urban: [20, 30, 45, 60, 70], suburban: [20, 30, 45, 60, 70], village: [20, 30, 45, 60, 70],
    ruralWooded: [20, 30, 45, 60, 70], residential: [20, 30, 60, 70] }
  ok('Table 8（1.5–3 GHz）环境 × 仰角清单（居民区无 45°）', JSON.stringify(inv(2.2)) === JSON.stringify(want))
  ok('Table 9（3–5 GHz）环境 × 仰角清单', JSON.stringify(inv(3.8)) === JSON.stringify(want))
  const k = T.filter((x) => x.fGHz >= 10).map((x) => x.fGHz + '/' + x.env + '/' + x.elev).join(' ')
  ok('Table 10（10–20 GHz）：郊区 34°(11.7)/30°(20)、乡村 34°、公路 30°、铁路 30°、城区 30°',
    k === '11.7/rural/34 11.7/suburban/34 20/suburban/30 20/highway/30 20/urban/30 20/railway/30', k)
}
{
  // 原文 p.41「2.2 GHz/ Urban / 20 degrees」整张逐格
  const t = P.selectTable(2.2, 'urban', 20)
  const want = { G: { mu: 2.0042, sigma: 1.2049, durMin: 3.9889, muMA: -3.3681, sigmaMA: 3.3226, h1: 0.1739, h2: -11.5966, g1: 0.0036, g2: 1.3230, lcorr: 0.9680 },
    B: { mu: 3.689, sigma: 0.9796, durMin: 10.3114, muMA: -18.1771, sigmaMA: 3.2672, h1: 1.1411, h2: 4.0581, g1: -0.2502, g2: -1.2528, lcorr: 0.9680 } }
  ok('2.2 GHz 城区 20° 整表逐格（原文 p.41）', JSON.stringify(t.G) === JSON.stringify(want.G) && JSON.stringify(t.B) === JSON.stringify(want.B) &&
    t.f1 === 0.0870 && t.f2 === 2.8469 && t.pB[0] === 0.1 && t.pB[1] === 0.9 && t.gainDbi === '<5')
}
{
  // 原文 p.45：这张表第 3–5 行标签印成 h1,h2 / g1,g2 / h1,h2，数值按 Table 7 行序取
  const t = P.selectTable(2.2, 'village', 30)
  ok('2.2 GHz 村镇 30°（原表行标签印错）按位置取数：μ_MA/σ_MA、h1/h2、g1/g2',
    t.G.muMA === -2.2284 && t.G.sigmaMA === 1.4984 && t.B.muMA === -15.1583 && t.B.sigmaMA === 4.0987 &&
    t.G.h1 === -0.3431 && t.G.h2 === -14.0798 && t.B.h1 === 0.9614 && t.B.h2 === 0.3719 &&
    t.G.g1 === -0.2215 && t.G.g2 === 1.0077 && t.B.g1 === -0.0961 && t.B.g2 === 1.3123)
  const u = P.selectTable(3.8, 'suburban', 30)
  ok('3.8 GHz 郊区 30°（同样印错）按位置取数',
    u.G.muMA === -1.9611 && u.G.sigmaMA === 1.8460 && u.B.muMA === -15.3022 && u.B.sigmaMA === 2.9379 &&
    u.G.h1 === 0.2329 && u.G.h2 === -15.0063 && u.B.h1 === 0.5146 && u.B.h2 === -8.9987 &&
    u.G.g1 === 0.0334 && u.G.g2 === 1.3323 && u.B.g1 === 0.0880 && u.B.g2 === 4.4692)
}
{
  const a = P.selectTable(2.2, 'suburban', 70), b = P.selectTable(2.2, 'urban', 70)
  ok('2.2 GHz 郊区 70° 与城区 70° 原文数值完全相同（照录、不改）',
    JSON.stringify([a.G, a.B, a.f1, a.f2]) === JSON.stringify([b.G, b.B, b.f1, b.f2]) && a.G.durMin === 118.3312)
}
{
  const r = P.selectTable(2.2, 'residential', 60)
  ok('2.2 GHz 居民区 60°（原表精度较低）逐格：μ_MA,G = 0、σ = 0.30、f1 = −1.591',
    r.G.muMA === 0 && r.G.sigmaMA === 0.30 && r.B.muMA === -2.32 && r.B.g2 === -0.119 && r.f1 === -1.591 && r.f2 === 12.274)
  const k1 = P.selectTable(11.7, 'rural', 34)
  ok('11.7 GHz 乡村 34°：GOOD σ_MA = 0（式 20b 的情形）、h2 = −40.25、天线 19 dBi',
    k1.G.sigmaMA === 0 && k1.G.muMA === 0.05 && k1.G.h2 === -40.25 && k1.B.muMA === -16 && k1.B.sigmaMA === 10.4 && k1.gainDbi === 19)
  const tr = P.selectTable(20, 'railway', 30)
  ok('20 GHz 铁路（原表题 Train）30°：p_B 区间 [0.0006, 0.88]、天线 31 dBi', tr.pB[0] === 0.0006 && tr.pB[1] === 0.88 &&
    tr.G.lcorr === 19.52 && tr.gainDbi === 31)
  ok('20 GHz 郊区 30°：p_B [0.006, 0.921]、BAD g1 = −0.45、g2 = 0', (() => {
    const t = P.selectTable(20, 'suburban', 30)
    return t.pB[0] === 0.006 && t.pB[1] === 0.921 && t.B.g1 === -0.45 && t.B.g2 === 0
  })())
}
{
  // 全部 1 296 个数按位置加权求和（防误改、防串格）。期望值由 scratch 里的 Python 从原文 PDF 文本
  // 另行解析得到（与库里的表不同代码路径），两边一致才说明转录无误。
  let s = 0, w = 0
  for (const t of T) {
    for (const st of [t.G, t.B]) for (const k of ['mu', 'sigma', 'durMin', 'muMA', 'sigmaMA', 'h1', 'h2', 'g1', 'g2', 'lcorr']) s += st[k] * ++w
    for (const v of [t.f1, t.f2, t.pB[0], t.pB[1]]) s += v * ++w
  }
  ok('54 张表 1 296 个数的位置加权和 = −77 791.817（与原文文本独立解析一致）', w === 1296 && near(s, -77791.817, 1e-6), s.toFixed(4))
}

/* ---- ③ 式 (17)–(19)（期望值 = 独立 Python）---- */
{
  const u20 = P.stateProbabilities({ fGHz: 2.2, env: 'urban', elevDeg: 20 })
  ok('城区 20°：<dur>_G = 21.0677 m、<dur>_B = 69.8649 m、<dur>_T = 4.1353 m', near(u20.durG, 21.067666123616412, 1e-9) &&
    near(u20.durB, 69.86490067927217, 1e-9) && near(u20.durT, 4.135283, 1e-9))
  ok('城区 20°：p_G = 0.25405、p_B = 0.74595', near(u20.pG, 0.2540539639377453, 1e-12) && near(u20.pB, 0.7459460360622547, 1e-12))
  const u30 = P.stateProbabilities({ fGHz: 2.2, env: 'urban', elevDeg: 30 })
  ok('城区 30°：p_G = 0.47382、BAD 的 M_A 截在 [−22.494, −12.361] dB（式 18）', near(u30.pG, 0.47382482625929073, 1e-12) &&
    near(u30.maB[0], -22.493829648910918, 1e-9) && near(u30.maB[1], -12.361370351089086, 1e-9))
  const s20 = P.stateProbabilities({ fGHz: 20, env: 'suburban', elevDeg: 30 })
  ok('20 GHz 郊区：p_B 区间不对称时式 (17b) 的截尾均值修正（<dur>_T = 2.46178 m、p_G = 0.70986）',
    near(s20.durT, 2.4617765067133166, 1e-9) && near(s20.pG, 0.7098640975689131, 1e-12))
  const bad = T.filter((t) => {
    const s = P.stateProbabilities(t)
    return !(s.pG > 0 && s.pG < 1 && s.durT > 0 && near(s.pG + s.pB, 1, 1e-12))
  })
  ok('54 张表全部：0 < p_G < 1、<dur>_T > 0、p_G + p_B = 1', bad.length === 0, bad.map((t) => t.fGHz + t.env + t.elev).join(','))
}

/* ---- ④ Figures 12–14 读数（2.2 GHz、欧洲、天线 < 5 dBi）---- */
const sel = (env, el) => ({ fGHz: 2.2, env, elevDeg: el })
const FIG = { off: { badMaLowerCut: false } }
{
  // Figure 12 读数（图上量取，±0.01 级）
  const F12 = {
    'urban 30': { 0: 0.893, '-5': 0.600, '-10': 0.465, '-15': 0.290, '-20': 0.133, '-25': 0.050, '-30': 0.017 },
    'suburban 30': { 0: 0.690, '-5': 0.233, '-10': 0.140, '-15': 0.060, '-20': 0.020 },
    'urban 60': { 0: 0.840, '-5': 0.140, '-10': 0.085 },
    'suburban 60': { 0: 0.755, '-5': 0.090, '-10': 0.050 }
  }
  const bulk = [], tailFig = []
  for (const key of Object.keys(F12)) {
    const [env, el] = key.split(' ')
    for (const u of Object.keys(F12[key])) {
      const w = F12[key][u]
      if (Number(u) >= -10 && Math.abs(P.signalCdf(Number(u), sel(env, Number(el))).p - w) > 0.02) bulk.push(key + '@' + u)
      if (el === '30' && Math.abs(P.signalCdf(Number(u), sel(env, 30), FIG.off).p - w) > 0.01) tailFig.push(key + '@' + u)
    }
  }
  ok('Figure 12 正文口径：四条曲线 0 / −5 / −10 dB 读数 ±0.02', bulk.length === 0, bulk.join(','))
  ok('Figure 12「BAD 只截上限」口径：城区 / 郊区 30° 全段（到 −30 dB）读数 ±0.01', tailFig.length === 0, tailFig.join(','))
  const lit = P.signalCdf(-20, sel('urban', 30)).p, fig = P.signalCdf(-20, sel('urban', 30), FIG.off).p
  ok('两种口径的差异钉住：城区 30° @−20 dB 正文 0.109 / 图口径 0.133', near(lit, 0.1094, 5e-4) && near(fig, 0.1330, 5e-4), lit.toFixed(4) + ' / ' + fig.toFixed(4))
}
{
  const F13 = { '-10': 0.0, '-5': 0.05, 0: 0.305, 5: 0.51, 10: 0.668, 15: 0.995 }
  const bad = Object.keys(F13).filter((k) => Math.abs(P.riceFactorCdf(Number(k), sel('urban', 30)) - F13[k]) > 0.01)
  ok('Figure 13（莱斯因子 CDF）城区 30° 六个读数 ±0.01（正文口径）', bad.length === 0, bad.join(','))
}
{
  const F14 = { 0: 0.91, '-5': 0.572, '-10': 0.48, '-15': 0.222, '-20': 0.035 }
  const badText = ['0', '-5', '-10'].filter((k) => Math.abs(P.totalPowerCdf(Number(k), sel('urban', 30)) - F14[k]) > 0.01)
  const badFig = Object.keys(F14).filter((k) => Math.abs(P.totalPowerCdf(Number(k), sel('urban', 30), FIG.off) - F14[k]) > 0.01)
  ok('Figure 14（总功率 CDF）城区 30°：正文口径 0 ~ −10 dB ±0.01', badText.length === 0, badText.join(','))
  ok('Figure 14「BAD 只截上限」口径：五个读数全部 ±0.01（含 −20 dB 的 0.035）', badFig.length === 0, badFig.join(','))
}
ok('求积收敛：与 64 × 48 点参考积分同值到 1e-9（11.7 GHz 乡村 0 dB、20 GHz 郊区 −1 dB、2.2 GHz 城区 −10 dB）',
  near(P.signalCdf(0, { fGHz: 11.7, env: 'rural', elevDeg: 34 }).p, 0.530094965976024, 1e-9) &&
  near(P.signalCdf(-1, { fGHz: 20, env: 'suburban', elevDeg: 30 }).p, 0.332554289620055, 1e-9) &&
  near(P.signalCdf(-10, sel('urban', 30)).p, 0.458415233356682, 1e-9))
ok('a 的积分限 ±3Σ_A 照原文不归一：P(x ≤ +40 dB) = 0.9973', near(P.signalCdf(40, sel('suburban', 45)).p, N.normCdf(3) - N.normCdf(-3), 1e-6))

/* ---- ⑤ 衰落余量与选表 ---- */
{
  const s = sel('suburban', 30)
  const ms = [1, 5, 10, 20].map((p) => P.fadeMarginDb(p, s).fadeDb)
  ok('衰落余量随 p 减小而增大（郊区 30°：1/5/10/20%）', ms[0] > ms[1] && ms[1] > ms[2] && ms[2] > ms[3], ms.map((x) => x.toFixed(2)).join(' '))
  const r = P.fadeMarginDb(5, s)
  ok('余量是 CDF 的反函数：P(20lg x ≤ −F) = p', near(P.signalCdf(-r.fadeDb, s).p, 0.05, 1e-6))
  const a = P.fadeMarginDb(1, sel('urban', 30)).fadeDb, b = P.fadeMarginDb(10, sel('urban', 30)).fadeDb
  const c = P.fadeMarginDb(1, sel('urban', 30), FIG.off).fadeDb, d = P.fadeMarginDb(10, sel('urban', 30), FIG.off).fadeDb
  ok('城区 30°：p = 1% / 10% 正文口径 30.9 / 20.4 dB、图口径 32.2 / 21.5 dB（文件头所记）',
    near(a, 30.89, 0.05) && near(b, 20.44, 0.05) && near(c, 32.21, 0.05) && near(d, 21.52, 0.05), [a, b, c, d].map((x) => x.toFixed(2)).join(' '))
  ok('p ≥ 99.73%（超过 a 积分覆盖的 0.9973）无解 → null；p ≤ 0 → null',
    P.fadeMarginDb(99.8, s) === null && P.fadeMarginDb(0, s) === null)
  ok('返回值带上实际用的表', r.table.fGHz === 2.2 && r.table.env === 'suburban' && r.table.elev === 30 && r.table.gainDbi === '<5')
}
{
  const id = (f, e, el) => { const t = P.selectTable(f, e, el); return t ? t.fGHz + '/' + t.elev : null }
  ok('Step 0：1.6 GHz → 2.2 GHz 表；3 GHz → 3.8 GHz 表（Table 9 区间含 3 GHz）', id(1.6, 'urban', 30) === '2.2/30' && id(3, 'urban', 30) === '3.8/30')
  ok('Step 0：5–10 GHz 空档按最近频率（7 GHz 城区 → 3.8；9 GHz 城区 → 3.8，城区没有 11.7 GHz 表）',
    id(7, 'urban', 30) === '3.8/30' && id(9, 'urban', 30) === '3.8/30')
  ok('§4.2：郊区有两张 Ka/Ku 表时取频率最近的（12 GHz → 11.7、16 GHz → 20）',
    id(12, 'suburban', 30) === '11.7/34' && id(16, 'suburban', 30) === '20/30')
  ok('仰角取最近；正好居中（25°）取较低仰角；80° → 70°；乡村 11.7 GHz 只有 34° 一张',
    id(2.2, 'urban', 25) === '2.2/20' && id(2.2, 'urban', 80) === '2.2/70' && id(2.2, 'residential', 45) === '2.2/30' && id(15, 'rural', 70) === '11.7/34')
  ok('环境别名：train → railway、wooded → ruralWooded', id(20, 'train', 30) === '20/30' && id(2, 'wooded', 45) === '2.2/45')
  ok('越界返回 null：仰角 < 20°、频率 ∉ [1.5, 20]、该频档没有此环境（20 GHz 村镇）',
    P.selectTable(2.2, 'urban', 15) === null && P.selectTable(1.2, 'urban', 30) === null && P.selectTable(25, 'urban', 30) === null &&
    P.selectTable(12, 'village', 30) === null && P.selectTable(2.2, 'forest', 30) === null)
}

/* ---- ⑥ §4.1.1 路边树木、§4.2 建筑、§5 多径 ---- */
{
  // 期望值：独立 Python 按式 (1)–(5) 另算
  const ERS = [[[1, 20, 1.5], 25.9], [[2, 20, 1.5], 22.71845444122985], [[5, 20, 1.5], 18.512679981927477],
    [[10, 20, 1.5], 15.331134423157327], [[20, 20, 1.5], 12.149588864387178], [[30, 20, 1.5], 8.59606192196426],
    [[50, 20, 1.5], 4.119147433805152], [[1, 45, 1.5], 14.825], [[1, 60, 1.5], 8.179999999999996],
    [[10, 35, 2.2], 11.287333933928918], [[40, 50, 20], 3.2598661818574532], [[1, 10, 1.5], 25.9]]
  const bad = ERS.filter(([a, w]) => !near(P.roadsideTreeFadeDb(a[0], a[1], a[2]), w, 1e-9))
  ok('§4.1.1 式 (1)–(5) 十二组（含 Step 4：10° 按 20° 算）', bad.length === 0, bad.map((x) => x[0].join('/')).join(' '))
  // Figure 1（1.5 GHz）读数
  const F1 = [[1, 20, 26], [5, 20, 18.5], [10, 20, 15.4], [20, 20, 12.2], [30, 20, 8.6], [50, 20, 4.1], [1, 45, 14.8], [1, 60, 8.2]]
  const badF = F1.filter(([p, th, w]) => Math.abs(P.roadsideTreeFadeDb(p, th, 1.5) - w) > 0.5)
  ok('Figure 1 读数 8 点 ±0.5 dB', badF.length === 0, badF.map((x) => x.join('/')).join(' '))
  ok('§4.1.1.1 高仰角外推（1.6 GHz、1%）：70° = 60° 计算值与 Table 1 的 80° 值 4.1 dB 的中点；80° = 4.1；85° = 2.05；90° = 0',
    near(P.roadsideTreeFadeDb(1, 70, 1.6), 6.302196695280863, 1e-9) && near(P.roadsideTreeFadeDb(1, 80, 1.6), 4.1) &&
    near(P.roadsideTreeFadeDb(1, 85, 1.6), 2.05, 1e-12) && near(P.roadsideTreeFadeDb(1, 90, 1.6), 0))
  ok('Table 1 逐值（1.6 / 2.6 GHz，p = 1/5/10/15/20/30%）',
    JSON.stringify(P.ERS_TABLE1_80DEG) === JSON.stringify({ 1.6: { 1: 4.1, 5: 2.0, 10: 1.5, 15: 1.4, 20: 1.3, 30: 1.2 }, 2.6: { 1: 9.0, 5: 5.2, 10: 3.8, 15: 3.2, 20: 2.8, 30: 2.5 } }))
  ok('高仰角外推只对 Table 1 的频率与百分比；其余 null', P.roadsideTreeFadeDb(2, 70, 1.6) === null && P.roadsideTreeFadeDb(1, 70, 2.0) === null)
  ok('ERS 越界：p ∉ [1, 80]、θ < 7°、f ∉ [0.8, 20]、p > 20% 且 f < 0.85 → null',
    P.roadsideTreeFadeDb(0.5, 30, 1.5) === null && P.roadsideTreeFadeDb(90, 30, 1.5) === null && P.roadsideTreeFadeDb(5, 5, 1.5) === null &&
    P.roadsideTreeFadeDb(5, 30, 0.7) === null && P.roadsideTreeFadeDb(30, 30, 0.82) === null && P.roadsideTreeFadeDb(10, 30, 0.82) !== null)
}
{
  // Figure 4：h_b = 15 m、h_m = 1.5 m、d_m = 17.5 m、1.6 GHz；实线 C_f = 0、虚线 C_f = 0.7
  const F4 = [[90, 0, 30, 74], [90, 0, 40, 56], [90, 0, 50, 33], [90, 0, 60, 11], [90, 0.7, 30, 79.5], [90, 0.7, 40, 62], [90, 0.7, 50, 38],
    [90, 0.7, 60, 13.5], [45, 0, 20, 79], [45, 0, 30, 57.5], [45, 0, 40, 33], [45, 0, 50, 12], [45, 0.7, 20, 84], [45, 0.7, 30, 64],
    [45, 0.7, 40, 39], [45, 0.7, 50, 15]]
  const bad = F4.filter(([az, cf, el, w]) => Math.abs(P.buildingBlockagePct({ hbM: 15, hmM: 1.5, dmM: 17.5, elevDeg: el, azDeg: az, fGHz: 1.6, cf }) - w) > 1.5)
  ok('§4.2 式 (8) 对 Figure 4 十六个读数 ±1.5 个百分点', bad.length === 0, bad.map((x) => x.join('/')).join(' '))
  // 天线贴地（h_m = 0）、近掠射：h1 = d_m·tanθ ≈ 3 mm < h2 = 0.7·√(λ·d_r) ≈ 1.27 m
  ok('式 (8)：h1 ≤ h2（射线低于所需净空）判 100%；端点角度（θ = 90°、φ = 0°）不可用 → null',
    P.buildingBlockagePct({ hbM: 15, hmM: 0, dmM: 17.5, elevDeg: 0.01, azDeg: 90, fGHz: 1.6, cf: 0.7 }) === 100 &&
    P.buildingBlockagePct({ hbM: 15, hmM: 1.5, dmM: 17.5, elevDeg: 90, azDeg: 90, fGHz: 1.6 }) === null &&
    P.buildingBlockagePct({ hbM: 15, hmM: 1.5, dmM: 17.5, elevDeg: 30, azDeg: 0, fGHz: 1.6 }) === null)
}
{
  ok('Table 3 逐值（山区多径 a / b / 拟合区间）', JSON.stringify(P.MOUNTAIN_MP) === JSON.stringify({
    0.87: { 30: { a: 34.52, b: 1.855, range: [2, 7] }, 45: { a: 31.64, b: 2.464, range: [2, 4] } },
    1.5: { 30: { a: 33.19, b: 1.710, range: [2, 8] }, 45: { a: 39.95, b: 2.321, range: [2, 5] } } }))
  ok('Table 4 逐值（林荫路多径 u / v / 拟合区间）', JSON.stringify(P.TREE_ROAD_MP) === JSON.stringify({
    0.87: { u: 125.6, v: 1.116, range: [1, 4.5] }, 1.5: { u: 127.7, v: 0.8573, range: [1, 6] } }))
  const m = P.mountainMultipathFadeDb(1, 1.5, 30)
  ok('式 (12) 反解：1.5 GHz、30°、p = 1% → A = 33.19^(1/1.71) = 7.75 dB，落在拟合区间内',
    near(m.fadeDb, Math.pow(33.19, 1 / 1.71), 1e-12) && m.inFitRange === true)
  ok('式 (12) 回代：p = a·A^(−b)', near(33.19 * Math.pow(P.mountainMultipathFadeDb(4, 1.5, 30).fadeDb, -1.710), 4, 1e-9))
  const r = P.treeRoadMultipathFadeDb(1, 1.5)
  ok('式 (13) 反解：1.5 GHz、p = 1% → A = ln(127.7)/0.8573 = 5.66 dB', near(r.fadeDb, Math.log(127.7) / 0.8573, 1e-12) && r.inFitRange)
  ok('多径只认表内频率 / 仰角与 p 区间（1–10% / 1–50%）', P.mountainMultipathFadeDb(1, 2, 30) === null && P.mountainMultipathFadeDb(1, 1.5, 35) === null &&
    P.mountainMultipathFadeDb(20, 1.5, 30) === null && P.treeRoadMultipathFadeDb(60, 1.5) === null && P.treeRoadMultipathFadeDb(10, 0.87).fadeDb > 0)
  ok('拟合区间外标 inFitRange = false（0.87 GHz 45° p = 1%：A = 4.06 dB > 4 dB 上限）', P.mountainMultipathFadeDb(1, 0.87, 45).inFitRange === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
