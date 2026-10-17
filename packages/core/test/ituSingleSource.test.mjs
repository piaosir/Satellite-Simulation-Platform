// 传播物理函数单一真值源（C-16）守门测试。运行：npm test
//
// 2026-10-17 前，GSO 引擎 linkCalculator.js 与 NGSO 引擎 linkCalculatorNGSO.js 各有一份传播函数全量拷贝
// （去注释后只差注释与一个形参名），改一处漏一处就是口径分叉。抽到 utils/itu/ 后，这里钉住三件事：
//   ① 两引擎源码里不再定义任何一个传播函数（再抄一份进来，这条先红）；
//   ② linkCalculator 再导出的函数与 itu/ 里的是同一个函数对象（雨衰页 / 瞬时衰减 / 环境场经它取用）；
//   ③ 两引擎同输入下传播出参逐位相同（GSO 定点几何 ↔ NGSO 注入同一仰角）。
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const itu = require('../utils/itu/index.js')
const lc = require('../utils/linkCalculator.js')
const ng = require('../utils/linkCalculatorNGSO.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

console.log('=== 传播物理函数单一真值源 ===\n')

const FNS = ['calculateScintillationFading', 'calculatePolarizationAngle', 'calculateAtmosphericAttenuation', 'calcSpecificAttenOxygen',
  'calcSpecificAttenWaterVapor', 'interpP676Part1', 'calcEquivHeightOxygen', 'calcEquivHeightWaterVapor', 'erfinv', 'erfcinv',
  'cloudSpecificAttenuation', 'cloudLWCFromLognormal', 'getCloudLWC', 'calculateCloudAttenuation', 'findClosestFrequency',
  'scaleRainAttenP618_14', 'rainAttenAt6GHz', 'calculateRainXPD_P618_14', 'interpolateP838', 'getCoefficients',
  'calculateSinglePathRainAttenuation', 'gammaOxygen', 'gammaWaterVapour', 'skyNoise', 'gaseousAttenuationSite']
for (const file of ['linkCalculator.js', 'linkCalculatorNGSO.js', 'linkCalculatorRegen.js', 'rainAttenuation.js', 'instantAtten.js']) {
  const src = readFileSync(join(HERE, '..', 'utils', file), 'utf8')
  const dup = FNS.filter((n) => new RegExp('function\\s+' + n + '\\s*\\(').test(src))
  ok(`${file} 不再自带传播函数`, dup.length === 0, dup.join(', ') || '无')
  ok(`${file} 不再自带 P.838 系数表`, !/const\s+P838_TABLE\s*=/.test(src))
}

for (const n of ['calculateSinglePathRainAttenuation', 'getCoefficients', 'scaleRainAttenP618_14', 'calculateRainXPD_P618_14',
  'calculateAtmosphericAttenuation', 'calculateCloudAttenuation', 'cloudLWCFromLognormal', 'cloudSpecificAttenuation',
  'calculateScintillationFading', 'calculatePolarizationAngle']) {
  ok(`linkCalculator.${n} === itu.${n}`, typeof itu[n] === 'function' && lc[n] === itu[n])
}

// ③ 两引擎同输入、同仰角 → 传播出参逐位相同
{
  lc.setOutputPrecisionBoost(8); ng.setOutputPrecisionBoost(8)
  try {
    const sat = { frequencyBand: 'Ka', orbitPosition: 110.5 }
    const inp = {
      centerFrequency: 30, rxCenterFrequency: 20, latitude: 31.2, longitude: 121.5, rxLatitude: 23.13, rxLongitude: 113.26,
      rainRate: 60, rxRainRate: 83, uplinkAvailability: 99.7, rxDownlinkAvailability: 99.9, uplinkPolarization: 'R', downlinkPolarization: 'L',
      rxAntennaNoiseTempMode: '自动', antennaDiameter: 2.4, rxAntennaDiameter: 1.2
    }
    const g = lc.calculateLinkBudget(sat, inp).data
    const n = ng.calculateLinkBudget(sat, Object.assign({}, inp, {
      minElevation: g.elevationResult, rxMinElevation: g.rxElevationResult, distanceMode: 'slantRange',
      slantRange: g.slantRangeResult, rxSlantRange: g.rxSlantRangeResult
    })).data
    const KEYS = ['uplinkAtmosphericAttenuationResult', 'downlinkAtmosphericAttenuationResult', 'uplinkCloudAttenuation', 'downlinkCloudAttenuation',
      'uplinkRainAttenuation', 'downlinkRainAttenuationResult', 'uplinkScintillationResult', 'downlinkScintillationResult',
      'antennaNoiseTempResult', 'cloudNoiseTempResult', 'rainNoiseTempResult', 'systemNoiseTempKResult', 'gOverTdegradationResult']
    const diff = KEYS.filter((k) => Math.abs(+g[k] - +n[k]) > 1e-6)
    ok('GSO ↔ NGSO（注入同一仰角）传播与噪温出参一致', diff.length === 0, diff.map((k) => `${k} ${g[k]}≠${n[k]}`).join('；') || `${KEYS.length} 项`)
  } finally { lc.setOutputPrecisionBoost(0); ng.setOutputPrecisionBoost(0) }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
