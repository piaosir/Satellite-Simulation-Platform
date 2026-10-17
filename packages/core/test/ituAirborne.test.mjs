// 机载 / 高空终端（ITU-R P.2041-1 §4）测试：站高统一进入气体 / 云 / 闪烁 / 天空噪温四项。运行：npm test
//
// 不设「机载」开关：终端海拔高于地形即按 P.2041-1 处理——
//   §4.2 气体 A_o' = γ_o·h_o·e^(−离地高度/h_o)、A_w' = K_w·V(p, 机高)；§4.3 云：雨高以下 100%、6 km 以上 0、其间线性；
//   §4.4 雨：机高 ≥ 雨高时为 0（P.618 原有）；§4.5 闪烁：机高 > 雨高时忽略；天空噪温随之按式(69) 合成。
// 量级对照（C 路 2026-10-17 算例，scratchpad gap/C/aero_gas.js）：广州、Ka 20 GHz、0.6 m、10 km 巡航、99.5%，
//   旧口径按地面算 气体 0.98 / 云 0.32 dB、系统噪温 189.6 K；按 P.2041-1 气体 ≈ 0、云 0、系统噪温约 121 K，
//   固定功放时下行热噪 C/N 改善约 3 dB。
// 关键不变式：地面站（站高 ≤ 雨高）云柱比例恒为 1、闪烁照算——地面结果与机载修正无关。
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const p2041 = require('../utils/itu/p2041.js')
const gs = require('../utils/itu/gasSite.js')
const core = require('../index.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}
const quiet = (fn) => { const l = console.log; console.log = () => {}; try { return fn() } finally { console.log = l } }

console.log('=== ITU-R P.2041-1 机载终端 ===\n')

// §4.3 / §4.5 判据
{
  ok('云柱：雨高以下 100%', p2041.cloudLiquidFraction(2, 4.5) === 1 && p2041.cloudLiquidFraction(4.5, 4.5) === 1)
  ok('云柱：雨高→6 km 线性（5.25 km 处 50%）', Math.abs(p2041.cloudLiquidFraction(5.25, 4.5) - 0.5) < 1e-12)
  ok('云柱：6 km 及以上 0', p2041.cloudLiquidFraction(6, 4.5) === 0 && p2041.cloudLiquidFraction(10, 4.5) === 0)
  ok('云柱：雨高已高于 6 km 时过雨高即 0', p2041.cloudLiquidFraction(6.3, 6.2) === 0 && p2041.cloudLiquidFraction(6.1, 6.2) === 1)
  ok('闪烁：雨高以下照算、以上忽略', p2041.scintillationApplies(4, 4.5) && !p2041.scintillationApplies(4.6, 4.5))
}

const rd = (f) => readFileSync(join(ROOT, 'resources/itu', f))
const haveData = ['p837_r001_v2.bin', 'topo_v1.bin', 'p836_v2.bin', 'p840_logn_v1.bin'].every((f) => existsSync(join(ROOT, 'resources/itu', f)))
if (haveData) {
  quiet(() => core.loadFullPrecisionData({ rain: rd('p837_r001_v2.bin'), elev: rd('topo_v1.bin'), vapor: rd('p836_rho_v1.bin'), vapor2: rd('p836_v2.bin'), cloud: rd('p840_logn_v1.bin') }))

  // §4.2 气体：离地高度 → e^(−h/h_o)；V 取机高处
  {
    const g0 = gs.gaseousAttenuationSite({ f: 20, el: 62.74, lat: 23.13, lon: 113.26, hsKm: 0.02, pPct: 0.5 })
    const g10 = gs.gaseousAttenuationSite({ f: 20, el: 62.74, lat: 23.13, lon: 113.26, hsKm: 10, pPct: 0.5 })
    const gSurf = gs.gaseousAttenuationSite({ f: 20, el: 62.74, lat: 23.13, lon: 113.26, hsKm: g10.hSurf, pPct: 0.5 })
    ok('10 km：离地高度 ≈ 10 km、地面气象取地形处', g10.agl > 9.9 && g10.hSurf < 0.1, `离地 ${g10.agl.toFixed(3)} km`)
    ok('10 km：氧气 = 地形处地面值 × e^(−h/h_o)（式 6）', Math.abs(g10.Ao - gSurf.Ao * Math.exp(-g10.agl / g10.ho)) < 1e-12,
      `${gSurf.Ao.toFixed(4)} × e^(−${g10.agl.toFixed(2)}/${g10.ho.toFixed(2)}) = ${g10.Ao.toFixed(4)} dB`)
    ok('10 km：水汽用机高处 V(p)（式 7）', g10.V < g0.V * 0.1, `V ${g0.V.toFixed(1)} → ${g10.V.toFixed(2)} kg/m²`)
    // 离地不足 0.1 km 按地面站（楼顶天线 / 手填海拔与平滑地形之差），且门限两侧无可见跳变
    const ter = gs.terrainKm(39.9, 116.4)
    const lo = gs.gaseousAttenuationSite({ f: 20, el: 40, lat: 39.9, lon: 116.4, hsKm: ter + 0.0999, pPct: 0 })
    const hi = gs.gaseousAttenuationSite({ f: 20, el: 40, lat: 39.9, lon: 116.4, hsKm: ter + 0.1001, pPct: 0 })
    ok('离地 < 0.1 km 按地面站（离地高度出 0）', lo.agl === 0 && hi.agl > 0.1)
    ok('0.1 km 门限两侧气体衰减相差 < 1%', Math.abs(hi.A / lo.A - 1) < 0.01, `${lo.A.toFixed(4)} / ${hi.A.toFixed(4)} dB`)
    ok('10 km：气体总衰减 < 0.15 dB（地面约 1 dB）', g10.A < 0.15 && g0.A > 0.8, `${g0.A.toFixed(3)} → ${g10.A.toFixed(3)} dB`)
  }

  const KA = { frequencyBand: 'Ka', orbitPosition: 110.5 }
  const base = {
    centerFrequency: 30, rxCenterFrequency: 20, latitude: 39.9, longitude: 116.4, uplinkAvailability: 100,
    rxLatitude: 23.13, rxLongitude: 113.26, rxRainRate: 83, rxDownlinkAvailability: 99.5,
    rxAntennaDiameter: 0.6, rxAntennaEfficiency: 60, rxFeederLoss: 0.3, rxReceiverNoiseTemp: 75,
    rxAntennaNoiseTempMode: '自动', downlinkPolarization: 'L'
  }
  const run = (altM) => quiet(() => core.computeLinkMode(KA, Object.assign({}, base, { rxAltitude: altM }), { mode: 'power', powerW: 10 })).data
  const g = run(core.geoAutoFill(23.13, 113.26).altitude || 0), a = run(10000)
  ok('机载 10 km：雨 / 云 / 闪烁均为 0', +a.downlinkRainAttenuationResult === 0 && +a.downlinkCloudAttenuation === 0 && +a.downlinkScintillationResult === 0)
  ok('机载 10 km：系统噪温约 120 K（地面同参约 184 K）', +a.systemNoiseTempKResult > 115 && +a.systemNoiseTempKResult < 130 && +g.systemNoiseTempKResult > 175,
    `${g.systemNoiseTempKResult} → ${a.systemNoiseTempKResult} K`)
  const dCN = +a.downlinkThermalCN - +g.downlinkThermalCN
  ok('机载 10 km（99.5%，功放固定 10 W）：下行热噪 C/N 比旧口径多出的约 3 dB 已兑现', +a.downlinkThermalCN > 17 && dCN > 10,
    `地面 ${g.downlinkThermalCN} → 10 km ${a.downlinkThermalCN} dB`)
  ok('地面站：云柱 100%、闪烁照算（与机载修正无关）', +g.downlinkCloudAttenuation > 0.2 && +g.downlinkScintillationResult > 0.1,
    `云 ${g.downlinkCloudAttenuation}、闪烁 ${g.downlinkScintillationResult} dB`)

  // 雨衰页同一判据
  const rp = core.calculateRainAttenuation({ lat: 23.13, lon: 113.26, satLon: 110.5, freq: 20, pol: 'C', diameter: 0.6, efficiency: 60, availability: 99.5, altitude: 10000, systemNoiseTemp: 150, direction: 'down' })
  ok('雨衰页 10 km：雨 / 云 / 闪烁为 0、气体 < 0.15 dB', rp.rainAtten === 0 && rp.cloudAtten === 0 && rp.scintillation === 0 && rp.gasAtten < 0.15, `气体 ${rp.gasAtten.toFixed(3)} dB`)
} else {
  ok('随包数据缺失（跳过引擎断言）', true)
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
