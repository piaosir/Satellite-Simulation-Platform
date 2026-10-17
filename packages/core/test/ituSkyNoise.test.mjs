// 天空噪温 ITU-R P.618-14 §3 式(69)(70) 单一函数（itu/p618sky.js）测试。运行：npm test
//
// 关键不变式：
//   ① 恒等式：0 ≤ A → 2.7 ≤ T_sky ≤ T_mr；A → 0 退化为宇宙背景 2.7 K；A → ∞ 趋于 T_mr；对 A 单调增。
//   ② 串联介质先合成衰减再代入（C 路 2026-10-17 算例：广州 20 GHz 99.9%，A_G 0.84 / A_C 0.32 / A_R 14.73 dB，
//      分项相加 335.9 K → 式(69) 合成 268.0 K，T_mr = 275 K）。
//   ③ GSO / NGSO 引擎、雨衰页三处都由它构造噪温：自动天线噪温 = T_sky(A_G)+25；云/雨噪温为增量；
//      雨致 G/T 劣化 = 10·lg(T_sys(雨)/T_sys(晴))；可用度 100% 时云/雨增量为 0。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sky = require('../utils/itu/p618sky.js')
const geo = require('../utils/linkCalculator.js')
const ngso = require('../utils/linkCalculatorNGSO.js')
const rain = require('../utils/rainAttenuation.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const near = (a, b, tol) => Math.abs(a - b) <= tol

console.log('=== ITU-R P.618-14 §3 天空噪温 ===\n')

// ① 恒等式
{
  ok('A=0 → 2.7 K（宇宙背景）', near(sky.skyNoiseTemp(0, 275), 2.7, 1e-12))
  ok('A→∞ → T_mr', near(sky.skyNoiseTemp(400, 275), 275, 1e-9))
  let mono = true, bounded = true, prev = -1
  for (let A = 0; A <= 60; A += 0.05) {
    const t = sky.skyNoiseTemp(A, 266.651)
    if (!(t >= prev)) mono = false
    if (t < 2.7 - 1e-12 || t > 266.651 + 1e-12) bounded = false
    prev = t
  }
  ok('T_sky 对 A 单调不减', mono)
  ok('2.7 ≤ T_sky ≤ T_mr', bounded)
  ok('式(70) T_mr = 37.34 + 0.81·Ts', near(sky.meanRadiatingTemp(283.1), 37.34 + 0.81 * 283.1, 1e-12))
  ok('无地表温度 → 275 K', sky.meanRadiatingTemp(undefined) === 275 && sky.meanRadiatingTemp(NaN) === 275)
  const r = sky.skyNoise({ A_G: 0.5, A_C: 0, A_R: 0, Ts: 290 })
  ok('无云无雨：增量恒为 0', r.cloud === 0 && r.rain === 0 && r.precip === 0)
  const s = sky.skyNoise({ A_G: 0.6, A_C: 0.4, A_R: 9, Ts: 285 })
  ok('增量分解闭合：cloud + rain = precip = total − clear', near(s.cloud + s.rain, s.precip, 1e-9) && near(s.precip, s.total - s.clear, 1e-9))
}

// ② C 路算例（scratchpad gap/C/skynoise.js）
{
  const t = sky.skyNoise({ A_G: 0.84, A_C: 0.32, A_R: 14.73, Tmr: 275 })
  const sep = sky.skyNoiseTemp(0.84, 275) + 275 * (1 - 10 ** (-0.32 / 10)) + 275 * (1 - 10 ** (-14.73 / 10))
  ok('广州 20 GHz 99.9%：式(69) 合成 268.0 K', near(t.total, 268.0, 0.05), t.total.toFixed(2))
  ok('同例分项相加 335.9 K（旧口径，> T_mr）', near(sep, 335.9, 0.05) && sep > 275, sep.toFixed(2))
}

// ③ 引擎一致性（未注入全精度 bin 也照样成立——验证的是构造关系，不是绝对值）
function checkEngine(tag, d, Ts) {
  const Ag = +d.downlinkAtmosphericAttenuationResult, Ac = +d.downlinkCloudAttenuation, Ar = +d.downlinkRainAttenuationResult
  const s = sky.skyNoise({ A_G: Ag, A_C: Ac, A_R: Ar, Ts })
  const L = 10 ** (+d.rxFeederLossResult / 10)
  // 出参保留 10 位小数后再代回，容差按出参位数取
  ok(`${tag}：自动天线噪温 = T_sky(A_G)+25`, near(+d.antennaNoiseTempResult, s.clear + 25, 1e-6), `${d.antennaNoiseTempResult} vs ${(s.clear + 25).toFixed(6)}`)
  ok(`${tag}：云噪 = T_sky(A_G+A_C) − T_sky(A_G)`, near(+d.cloudNoiseTempResult, s.cloud, 1e-6))
  ok(`${tag}：雨噪 = T_sky(全) − T_sky(A_G+A_C)`, near(+d.rainNoiseTempResult, s.rain, 1e-6))
  const Tsys = +d.systemNoiseTempKResult
  ok(`${tag}：雨致 G/T 劣化 = 10lg(T_sys(雨)/T_sys(晴))`, near(+d.gOverTdegradationResult, 10 * Math.log10((Tsys + s.rain / L) / Tsys), 1e-6))
  ok(`${tag}：雨天天线口亮温不超过 T_mr`, s.total <= s.Tmr + 1e-9, `${s.total.toFixed(1)} ≤ ${s.Tmr.toFixed(1)} K`)
}
{
  geo.setOutputPrecisionBoost(8); ngso.setOutputPrecisionBoost(8)
  try {
    // 广州（|lat|<45 → Ts = 283.1 − 6.5h）Ka 20 GHz 下行 99.9%
    const gIn = {
      centerFrequency: 30, rxCenterFrequency: 20, latitude: 39.9, longitude: 116.4, uplinkAvailability: 100,
      rxLatitude: 23.13, rxLongitude: 113.26, rxAltitude: 0, rxRainRate: 83, rxDownlinkAvailability: 99.9,
      rxAntennaDiameter: 1.2, rxAntennaEfficiency: 65, rxFeederLoss: 0.3, rxReceiverNoiseTemp: 75,
      rxAntennaNoiseTempMode: '自动', downlinkPolarization: 'L', uplinkPolarization: 'R'
    }
    const g = geo.calculateLinkBudget({ frequencyBand: 'Ka', orbitPosition: 110.5 }, gIn).data
    checkEngine('GSO 广州 Ka 99.9%', g, 283.1)
    // 手填 = 晴空值：手填 35 K 原样进系统噪温，云/雨增量照样按式(69) 算
    const gm = geo.calculateLinkBudget({ frequencyBand: 'Ka', orbitPosition: 110.5 }, Object.assign({}, gIn, { rxAntennaNoiseTempMode: '自定义', rxAntennaNoiseTemp: 35 })).data
    ok('GSO 手填 35 K 原样生效', gm.antennaNoiseTempResult === 35)
    ok('GSO 手填：雨噪与自动模式同值（增量与手填值无关）', gm.rainNoiseTempResult === g.rainNoiseTempResult)
    // 可用度 100%：增量为 0
    const g100 = geo.calculateLinkBudget({ frequencyBand: 'Ka', orbitPosition: 110.5 }, Object.assign({}, gIn, { rxDownlinkAvailability: 100 })).data
    ok('GSO 可用度 100%：云噪/雨噪/G/T 劣化 = 0', +g100.cloudNoiseTempResult === 0 && +g100.rainNoiseTempResult === 0 && +g100.gOverTdegradationResult === 0)

    // NGSO：高纬（|lat|≥45 → Ts = 272.4）
    const n = ngso.calculateLinkBudget({ frequencyBand: 'Ka' }, {
      centerFrequency: 30, rxCenterFrequency: 20, latitude: 50, longitude: 10, rxLatitude: 50, rxLongitude: 10,
      distanceMode: 'altitude', orbitAltitude: 1200, rxOrbitAltitude: 1200, minElevation: 25, rxMinElevation: 25,
      uplinkAvailability: 100, rxDownlinkAvailability: 99.5, rxRainRate: 30, rainRate: 30,
      rxAntennaNoiseTempMode: '自动', rxFeederLoss: 0.5
    }).data
    checkEngine('NGSO 50°N Ka 99.5%', n, 272.4)
  } finally { geo.setOutputPrecisionBoost(0); ngso.setOutputPrecisionBoost(0) }
}

// ④ 雨衰页：增量 = T_sky(A_G+A_C+A_R) − T_sky(A_G)，G/T 劣化按输入晴空 T_sys
{
  const r = rain.calculateRainAttenuation({ lat: 23.13, lon: 113.26, satLon: 110.5, freq: 20, pol: 'C', diameter: 1.2, efficiency: 65, availability: 99.9, rainRate: 83, systemNoiseTemp: 200, feederLoss: 0.3, direction: 'down' })
  const s = sky.skyNoise({ A_G: r.gasAtten, A_C: r.cloudAtten, A_R: r.rainAtten, Ts: 283.1 })
  ok('雨衰页：降雨噪温 = 合成增量', near(r.rainNoiseTemp, s.precip, 1e-9), `${r.rainNoiseTemp.toFixed(2)} K`)
  ok('雨衰页：G/T 劣化 = 10lg((T_sys+ΔT/L)/T_sys)', near(r.gtDegradation, 10 * Math.log10((200 + s.precip / 10 ** 0.03) / 200), 1e-9))
  ok('雨衰页：降雨噪温 < 旧分项口径 275(1−10^(−(A_C+A_R)/10))', r.rainNoiseTemp < 275 * (1 - 10 ** (-(r.cloudAtten + r.rainAtten) / 10)))
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
