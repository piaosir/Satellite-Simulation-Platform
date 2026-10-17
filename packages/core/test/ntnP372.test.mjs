// ITU-R P.372-18 无线电噪声（packages/core/utils/ntnChannel/p372.js + p372Tmr.js）。运行：node packages/core/test/ntnP372.test.mjs
//
// 锁定：
//   ① Table 1（Fam = c − d·lg f 的 c、d 与有效频段）、Table 2（十分位偏差）逐值；式 (15)(16)(17)；
//   ② §1.2 换算：式 (6)(9)，式 (1)–(4) 在 T_c = T_t = T₀ 时退化为式 (5)；
//   ③ §7.1 多源合成式 (31)–(39)：σ = 0 时退化为功率和；一组手算（独立 Python）；> 12 dB 时式 (38) 封顶；
//   ④ §3.1 Tmr_approx 数据文件 399 行首尾逐值、频率网格连续、线性插值；式 (10) 两端极限；
//   ⑤ §6.2 室内人为噪声：Figure 41 两组曲线 19 个读数、Figure 42 高斯段读数；中间量与独立 Python 同值；
//      IN 分量与 p_i 的作用；分位数是 CDF 的反函数；越界 null；
//   ⑥ 手持 0 dBi 天线噪温：G/T 公式复现 TR 38.821 手持 −31.6 dB/K、VSAT 15.9 dB/K、TR 38.811 −33.6 dB/K；
//      室外估值（~140 K）比 290 K 假设好约 0.5 dB、室内（≤ 2 GHz、ρη = 0.2 中值）差 2–3 dB。
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const N = require('../utils/ntnChannel/p372.js')
const { TMR_APPROX } = require('../utils/ntnChannel/p372Tmr.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, eps) => a != null && b != null && Math.abs(a - b) <= (eps == null ? 1e-9 : eps)

/* ---- ① Table 1 / Table 2 / 式 (15)(16)(17) ---- */
ok('Table 1：城市 76.8/27.7、居民区 72.5/27.7、乡村 67.2/27.7、安静乡村 53.6/28.6、银河 52.0/23.0',
  JSON.stringify(Object.keys(N.MANMADE_CD).map((k) => [k, N.MANMADE_CD[k].c, N.MANMADE_CD[k].d])) ===
  JSON.stringify([['city', 76.8, 27.7], ['residential', 72.5, 27.7], ['rural', 67.2, 27.7], ['quietRural', 53.6, 28.6], ['galactic', 52.0, 23.0]]))
ok('Table 2：时间上 / 下十分位与位置偏差逐值（城市 11.0/6.7/8.4、居民区 10.6/5.3/5.8、乡村 9.2/4.6/6.8）',
  JSON.stringify(N.MANMADE_DECILES) === JSON.stringify({
    city: { timeUpper: 11.0, timeLower: 6.7, location: 8.4 },
    residential: { timeUpper: 10.6, timeLower: 5.3, location: 5.8 },
    rural: { timeUpper: 9.2, timeLower: 4.6, location: 6.8 } }))
ok('式 (17)：城市 10 MHz = 76.8 − 27.7 = 49.1 dB；安静乡村 1 MHz = 53.6 dB；银河 100 MHz = 6 dB',
  near(N.manMadeNoiseFam(10, 'city').famDb, 49.1, 1e-12) && near(N.manMadeNoiseFam(1, 'quietRural').famDb, 53.6, 1e-12) &&
  near(N.manMadeNoiseFam(100, 'galactic').famDb, 6, 1e-12))
ok('有效频段：A/B/C 0.3–250 MHz；D 到 30 MHz、E 自 10 MHz（Figure 39）；2 GHz 属外推',
  N.manMadeNoiseFam(250, 'rural').inRange && !N.manMadeNoiseFam(300, 'rural').inRange && !N.manMadeNoiseFam(50, 'quietRural').inRange &&
  !N.manMadeNoiseFam(5, 'galactic').inRange && !N.manMadeNoiseFam(2000, 'city').inRange && N.manMadeNoiseFam(1, 'x') === null)
ok('式 (15)：银河 Fam = 52 − 23 lg f（30 MHz = 18.03 dB），原文「up to about 100 MHz」',
  near(N.galacticNoiseFam(30).famDb, 52 - 23 * Math.log10(30), 1e-12) && N.galacticNoiseFam(100).inRange && !N.galacticNoiseFam(150).inRange)
ok('式 (16) 原文示例：T_b = 200 K（408 MHz）→ 1 GHz 为 19.7 K', Math.round(N.galacticBrightnessK(200, 408, 1000) * 10) / 10 === 19.7)
ok('§4.1：银河噪声十分位偏差 2 dB', N.GALACTIC_DECILE_DB === 2)

/* ---- ② §1.2 换算 ---- */
ok('式 (9)：F_a = 0 dB ↔ 290 K，10 dB ↔ 2 900 K，往返自洽', near(N.faToTempK(0), 290) && near(N.faToTempK(10), 2900, 1e-9) &&
  near(N.tempKToFa(N.faToTempK(-7.3)), -7.3, 1e-12))
ok('式 (6)：P_n = F_a + 10lg b − 204（F_a = 0、1 MHz → −144 dBW）', near(N.noisePowerDbw(0, 1e6), -144, 1e-12) && near(N.noisePowerDbw(3, 1), -201, 1e-12))
{
  const a = N.systemNoiseFactor({ faDb: 4, lcDb: 1.5, ltDb: 2.2, frDb: 3.5 })
  const lin = (d) => Math.pow(10, d / 10)
  const fc = lin(1.5), ft = lin(2.2), fr = lin(3.5)      // T_c = T_t = T₀ 时 f_c = l_c、f_t = l_t
  ok('式 (1)–(4) 在 T_c = T_t = T₀ 时退化为式 (5)：f = f_a − 1 + f_c·f_t·f_r', near(a.f, lin(4) - 1 + fc * ft * fr, 1e-12))
  const b = N.systemNoiseFactor({ faDb: 0, frDb: 7 })
  ok('无损天线 + 290 K 环境：系统噪声温度 = 290·10^(7/10)（= TR 38.821 手持 1 453 K）', near(b.tSysK, 290 * Math.pow(10, 0.7), 1e-9))
}

/* ---- ③ §7.1 合成 ---- */
{
  const z = N.combineNoise([{ famDb: 10 }, { famDb: 10 }, { famDb: 4 }])
  ok('σ = 0 时退化为功率和', near(z.famTDb, 10 * Math.log10(2 * 10 + Math.pow(10, 0.4)), 1e-12) && z.sigmaTDb === 0)
  const c = N.combineNoise([{ famDb: 20, duDb: 11 }, { famDb: 15, duDb: 2 }], 'upper')
  ok('人为 20 dB（D_u 11）+ 银河 15 dB（D_u 2）：F_amT = 20.40216、σ_T = 8.47906、D_uT = 10.87015（独立 Python）',
    near(c.famTDb, 20.40215936614362, 1e-9) && near(c.sigmaTDb, 8.479058972334208, 1e-9) && near(c.decileTDb, 10.870153602532454, 1e-9))
  const lo = N.combineNoise([{ famDb: 20, duDb: 11, dlDb: 6.7 }, { famDb: 15, duDb: 2, dlDb: 2 }], 'lower')
  ok('按侧取 σ_i：下侧用 D_l（6.7 dB）得到更小的 σ_T', lo.sigmaTDb < c.sigmaTDb)
  // 一个起伏极大（D_u 20 dB）的弱源 + 一个稳定（D_u 0）的强源：式 (32) 给出的 σ_T ≈ 15.6 dB 超过式 (38) 上限 ≈ 12.4 dB
  const cc = 10 / Math.LN10
  const big = N.combineNoise([{ famDb: 0, duDb: 20 }, { famDb: 10, duDb: 0 }], 'upper')
  const aT = Math.exp(Math.pow(20 / 1.282, 2) / (2 * cc * cc)) + Math.exp(10 / cc), gT = 1 + Math.exp(10 / cc)
  ok('某源十分位 > 12 dB 时式 (38) 封顶：σ_T = c·√(2 ln(α_T/γ_T))', big.capped === true &&
    near(big.sigmaTDb, cc * Math.sqrt(2 * Math.log(aT / gT)), 1e-9), big.sigmaTDb.toFixed(3))
  const two = N.combineNoise([{ famDb: 0, duDb: 20 }, { famDb: 0, duDb: 20 }], 'upper')
  ok('同样 > 12 dB 但式 (32) 未超上限时不封顶', two.capped === false)
  ok('合成：空数组 / 非数 → null', N.combineNoise([]) === null && N.combineNoise([{ famDb: 'x' }]) === null)
}

/* ---- ④ Tmr_approx 与天空亮温 ---- */
ok('Tmr_approx.txt：399 行、1.0–200.0 GHz、步长 0.5 GHz、每行 5 列', TMR_APPROX.length === 399 &&
  TMR_APPROX.every((r, i) => r.length === 5 && near(r[0], 1 + 0.5 * i, 1e-12)))
ok('Tmr_approx 首行（1.00 GHz）逐值', JSON.stringify(TMR_APPROX[0]) === JSON.stringify([1, 73.41921, 0.6004962, 0.01340349, 0.2036446]))
ok('Tmr_approx 第 3 行（2.00 GHz）逐值', JSON.stringify(TMR_APPROX[2]) === JSON.stringify([2, 70.97924, 0.6094435, 0.01450615, 0.2262238]))
ok('Tmr_approx 末行（200.00 GHz）逐值', JSON.stringify(TMR_APPROX[398]) === JSON.stringify([200, 29.6181, 0.8411412, 0.005895457, 0.3522411]))
ok('式 (11)：2 GHz、标准大气（288.15 K / 1013.25 hPa / 7.5 g/m³）T_mr = 262.98542 K',
  near(N.meanRadiatingTempK(2), 70.97924 + 0.6094435 * 288.15 + 0.01450615 * 1013.25 + 0.2262238 * 7.5, 1e-9) && near(N.meanRadiatingTempK(2), 262.9854195125, 1e-9))
ok('系数在表格频点之间线性插值（2.25 GHz = 2.0 与 2.5 GHz 两行的平均）', near(N.meanRadiatingTempK(2.25), 263.12922045374995, 1e-9))
ok('有雨 T_mr = 275 K（1–55 GHz）；无雨超出 1–200 GHz → null', N.meanRadiatingTempK(30, { rain: true }) === 275 &&
  N.meanRadiatingTempK(60, { rain: true }) === null && N.meanRadiatingTempK(0.5) === null && N.meanRadiatingTempK(201) === null)
ok('式 (10)：A = 0 → 2.73 K；A 很大 → T_mr', near(N.skyBrightnessK(2, 0), 2.73, 1e-12) && near(N.skyBrightnessK(2, 300), N.meanRadiatingTempK(2), 1e-9))
ok('上半球平均天空亮温（cos 加权）：2 GHz、天顶 0.04 dB → 12.4533 K（独立 Python 中点积分同值到 1e-5 K）',
  near(N.hemisphereSkyTempK(2), 12.453286016765027, 1e-5))
ok('天顶衰减 0 → 只剩 2.73 K 宇宙背景；衰减越大越亮', near(N.hemisphereSkyTempK(2, { zenithAttenDb: 0 }), 2.73, 1e-9) &&
  N.hemisphereSkyTempK(2, { zenithAttenDb: 0.08 }) > N.hemisphereSkyTempK(2))

/* ---- ⑤ §6.2 室内人为噪声 ---- */
{
  // Figure 41 读数（图上数据点）：ρ, η = 0.2 与 0.15
  const F41a = { 100: 32.5, 200: 26.2, 300: 22.6, 400: 20.0, 500: 17.9, 600: 16.3, 700: 14.9, 800: 13.7, 900: 12.6, 1000: 11.7, 1200: 10.0, 1400: 8.6, 1600: 7.4 }
  const F41b = { 100: 29.2, 200: 23.0, 400: 16.7, 800: 10.4, 1000: 8.4, 1600: 4.2 }
  const badA = Object.keys(F41a).filter((f) => Math.abs(N.indoorNoiseParams(f / 1000).muG - F41a[f]) > 0.1)
  const badB = Object.keys(F41b).filter((f) => Math.abs(N.indoorNoiseParams(f / 1000, { rho: 0.15, eta: 0.15 }).muG - F41b[f]) > 0.1)
  ok('Figure 41（ρ, η = 0.2）十三个频点中值 ±0.1 dB', badA.length === 0, badA.join(','))
  ok('Figure 41（ρ, η = 0.15）六个频点中值 ±0.1 dB', badB.length === 0, badB.join(','))
  const p1 = N.indoorNoiseParams(1)
  ok('1 GHz 缺省：μ_G = 11.68373、σ_G = 3.91992（独立 Python 按式 19–30 同值）', near(p1.muG, 11.683734287898261, 1e-9) && near(p1.sigmaG, 3.9199159808022443, 1e-9))
  ok('IN 分量：发射均值高 5 dB → μ_I = μ_G + 5 dB，σ 相同（式 25 含 ε，式 26 不含）', near(p1.muI - p1.muG, 5, 1e-9) && near(p1.sigmaI, p1.sigmaG, 1e-12))
  ok('ε = +3 dB（带宽翻倍）只抬 IN 分量的均值', near(N.indoorNoiseParams(1, { eps: 3 }).muG, p1.muG, 1e-12) &&
    N.indoorNoiseParams(1, { eps: 3 }).muI > p1.muI)
  ok('2 GHz：μ_G = 5.42231 dB（S 频段室内）', near(N.indoorNoiseParams(2).muG, 5.422310378087445, 1e-9))
  // Figure 42（ρ, η = 0.2）高斯段读数：横轴是「超过」百分比
  const F42 = [[0.4, 50, 20.0], [0.4, 37, 21.3], [0.4, 10, 25.0], [0.4, 1, 29.0], [1.4, 50, 8.6], [1.4, 10, 13.8], [1.4, 1, 18.0]]
  const bad42 = F42.filter(([f, pe, v]) => Math.abs(N.indoorNoiseFaDb(1 - pe / 100, f) - v) > 0.4)
  ok('Figure 42 高斯段（超过概率 1%–50%）七个读数 ±0.4 dB', bad42.length === 0, bad42.map((x) => x.join('/')).join(' '))
  ok('分位数是 CDF 的反函数', near(N.indoorNoiseCdf(N.indoorNoiseFaDb(0.9, 1), 1), 0.9, 1e-9))
  ok('p_i = 0 时只剩高斯分量（NOTE 2）', near(N.indoorNoiseCdf(15, 1, { pi: 0 }), 0.5 * (1 + require('../utils/ntnChannel/numeric.js').erf((15 - p1.muG) / (p1.sigmaG * Math.SQRT2))), 1e-12))
  ok('有效频段 80 MHz–2 GHz：2.2 GHz → null（allowOutOfRange 照算并标 inRange = false）',
    N.indoorNoiseParams(2.2) === null && N.indoorNoiseParams(2.2, { allowOutOfRange: true }).inRange === false && N.indoorNoiseParams(0.07) === null)
  ok('非法参数（r_D ≤ r_0、ρ ≤ 0）→ null', N.indoorNoiseParams(1, { rD: 1 }) === null && N.indoorNoiseParams(1, { rho: 0 }) === null)
}

/* ---- ⑥ 手持终端天线噪温与 G/T ---- */
ok('TR 38.821 式 (6.1.3.1-3)：手持 0 dBi / NF 7 dB / 290 K → G/T = −31.6 dB/K（Table 6.1.1.1-3、6.1.3.3-1）',
  near(N.gOverTDb(0, 7, 290), -31.62397997898956, 1e-12) && Math.round(N.gOverTDb(0, 7, 290) * 10) / 10 === -31.6)
ok('同式：VSAT 39.7 dBi / NF 1.2 dB / 150 K → 15.9 dB/K', Math.round(N.gOverTDb(39.7, 1.2, 150) * 10) / 10 === 15.9)
ok('TR 38.811 Table 4.4-1：手持 NF 9 dB → −33.6 dB/K', Math.round(N.gOverTDb(0, 9, 290) * 10) / 10 === -33.6)
{
  const out = N.handheldVs38821({ fGHz: 2 })
  ok('室外 2 GHz（η_sky 0.5、ε 0.9、290 K 地面）：T_a ≈ 139 K，各分量相加自洽',
    near(out.taK, 0.5 * out.skyK + 0.5 * out.groundK + out.manMadeK + out.galacticK, 1e-9) && out.taK > 120 && out.taK < 160, out.taK.toFixed(1))
  ok('室外 G/T 比 290 K 假设好约 0.5 dB（NF 7 dB 时噪温差被稀释）', out.deltaGtDb > 0.3 && out.deltaGtDb < 0.7, out.deltaGtDb.toFixed(2))
  ok('T_sys = T_a + (F − 1)·T₀；290 K 假设下 1 453 K', near(out.tSys290K, 1453.4429775190895, 1e-9) &&
    near(out.tSysK, out.taK + (Math.pow(10, 0.7) - 1) * 290, 1e-9))
  const city = N.handheldVs38821({ fGHz: 2, manMade: 'city' })
  ok('室外城市人为噪声按式 (17) 外推到 2 GHz（−14.6 dB ≈ 10 K），并标 manMadeExtrapolated', city.manMadeExtrapolated &&
    near(city.manMadeFaDb, 76.8 - 27.7 * Math.log10(2000), 1e-12) && near(city.manMadeK, 290 * Math.pow(10, city.manMadeFaDb / 10), 1e-9))
  const ind = N.handheldVs38821({ fGHz: 2, manMade: 'indoor' })
  ok('室内 2 GHz（§6.2 中值）：墙体 290 K + 人为 ≈ 1 012 K → T_a ≈ 1 303 K，G/T 比 290 K 假设差约 2.3 dB',
    near(ind.groundK, 290, 1e-12) && ind.skyK > 0 && ind.galacticK === 0 && ind.taK > 1250 && ind.taK < 1350 && ind.deltaGtDb < -2 && ind.deltaGtDb > -2.6,
    ind.taK.toFixed(0) + ' K / ' + ind.deltaGtDb.toFixed(2) + ' dB')
  const l = N.handheldVs38821({ fGHz: 1.5, manMade: 'indoor' })
  ok('室内 L 频段 1.5 GHz（IoT n255）更糟：G/T 差 3 dB 以上', l.deltaGtDb < -3, l.deltaGtDb.toFixed(2))
  ok('室内 S 频段下行 2.185 GHz 超出 §6.2 频段 → null；显式放开后可算', N.handheldVs38821({ fGHz: 2.185, manMade: 'indoor' }) === null &&
    N.handheldVs38821({ fGHz: 2.185, manMade: 'indoor', indoor: { allowOutOfRange: true } }) !== null)
  ok('参数越界（η_sky > 1、ε < 0）→ null', N.handheldAntennaTempK({ fGHz: 2, skyFraction: 1.2 }) === null &&
    N.handheldAntennaTempK({ fGHz: 2, groundEmissivity: -0.1 }) === null)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
