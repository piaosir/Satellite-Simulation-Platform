// ITU-R P.840-9 云衰（itu/p840.js）测试。运行：npm test
//
// 外部金标准：ITU-R SG3 验证算例 ValEx Rev 8.3.0（CG-3M3J-13-ValEx-Rev8.3.0.xlsx）
//   「P.840-9 A_Clouds」对数正态段 32 例（Lat/Lon/p/f/θ/K_L/m_L/s_L/P_L → A_c）。
// 关键不变式：
//   ① K_L(f) = K_l(f, 273.75 K) × 式(14) 修正因子，与 ValEx 的 4 个 K_L 值逐位一致；旧口径 K_l(f, 273.15 K) 偏高 7.7~9.1%。
//   ② 对数正态 L_red 与 A_c 公式（给定 m/s/P_L）32 例与 ValEx 差 < 1e-6 dB（erfinv 为 Giles 近似）。
//   ③ 链路预算 / 雨衰页的云衰 = K_L·L_red(max(p,1%))/sinθ —— p<1% 封顶是用户 2026-07-23 拍板保留的口径。
//   ④ 实时分支手填柱液态水与统计分支用同一 K_L。
//   ⑤ 注入全精度参数图时，ValEx 8 个节点的 m/s/P_L 与图值一致。
import { createRequire } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const p840 = require('../utils/itu/p840.js')
const lc = require('../utils/linkCalculator.js')
const inst = require('../utils/instantAtten.js')
const cloudGrid = require('../data/cloudParamsGrid.js')

let pass = 0, fail = 0
function ok(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? `  (${extra})` : ''))
  cond ? pass++ : fail++
}

// ValEx Rev 8.3.0「P.840-9 A_Clouds」O..Z 列：[lat, lon, p%, f GHz, θ°, m_L, s_L, P_L%, K_L, A_c dB]
const VALEX = [[0,0,0.015,6,15,-3.129,0.782,88.491,0.0311277818545,0.086749599838],[0,0,1.5,15,45,-3.129,0.782,88.491,0.190113349078,0.0618061218307],[0,0,15.5,30,75,-3.129,0.782,88.491,0.707853958387,0.0665712282731],[0,0,65,45,90,-3.129,0.782,88.491,1.44305988658,0.0386877470806],[45,0,0.015,6,15,-2.481,0.886,59.072,0.0311277818545,0.218978979396],[45,0,1.5,15,45,-2.481,0.886,59.072,0.190113349078,0.126951763634],[45,0,15.5,30,75,-2.481,0.886,59.072,0.707853958387,0.107704639454],[45,0,65,45,90,-2.481,0.886,59.072,1.44305988658,0],[87.5,0,0.015,6,15,-2.999,0.75,48.724,0.0311277818545,0.0781925424619],[87.5,0,1.5,15,45,-2.999,0.75,48.724,0.190113349078,0.0544466792158],[87.5,0,15.5,30,75,-2.999,0.75,48.724,0.707853958387,0.0520722011808],[87.5,0,65,45,90,-2.999,0.75,48.724,1.44305988658,0],[-45,0,0.015,6,15,-2.599,0.782,80.974,0.0311277818545,0.144727019163],[-45,0,1.5,15,45,-2.599,0.782,80.974,0.190113349078,0.102088450344],[-45,0,15.5,30,75,-2.599,0.782,80.974,0.707853958387,0.107806695062],[-45,0,65,45,90,-2.599,0.782,80.974,1.44305988658,0.0551317150332],[-87.5,0,0.015,6,15,0,0,0.008,0.0311277818545,0],[-87.5,0,1.5,15,45,0,0,0.008,0.190113349078,0],[-87.5,0,15.5,30,75,0,0,0.008,0.707853958387,0],[-87.5,0,65,45,90,0,0,0.008,1.44305988658,0],[45,-90,0.015,6,15,-2.382,0.869,46.756,0.0311277818545,0.215713751774],[45,-90,1.5,15,45,-2.382,0.869,46.756,0.190113349078,0.124058511288],[45,-90,15.5,30,75,-2.382,0.869,46.756,0.707853958387,0.0988471495376],[45,-90,65,45,90,-2.382,0.869,46.756,1.44305988658,0],[-45,-90,0.015,6,15,-2.732,0.797,87.962,0.0311277818545,0.135983078227],[-45,-90,1.5,15,45,-2.732,0.797,87.962,0.190113349078,0.0947170499802],[-45,-90,15.5,30,75,-2.732,0.797,87.962,0.707853958387,0.10008633657],[-45,-90,65,45,90,-2.732,0.797,87.962,1.44305988658,0.0563926410385],[45,90,0.015,6,15,-3.334,0.888,15.016,0.0311277818545,0.0666952871798],[45,90,1.5,15,45,-3.334,0.888,15.016,0.190113349078,0.0299267043506],[45,90,15.5,30,75,-3.334,0.888,15.016,0.707853958387,0],[45,90,65,45,90,-3.334,0.888,15.016,1.44305988658,0]]

console.log('=== ITU-R P.840-9 云衰（ValEx Rev 8.3.0）===\n')

// ① K_L
{
  let maxRel = 0
  for (const r of VALEX) maxRel = Math.max(maxRel, Math.abs(p840.cloudMassAbsorptionKL(r[3]) - r[8]) / r[8])
  ok('K_L(6/15/30/45 GHz) 与 ValEx 一致（相对差 < 1e-11）', maxRel < 1e-11, `max rel ${maxRel.toExponential(2)}`)
  const r6 = p840.cloudSpecificAttenuation(6, 273.15) / p840.cloudMassAbsorptionKL(6)
  const r40 = p840.cloudSpecificAttenuation(40, 273.15) / p840.cloudMassAbsorptionKL(40)
  ok('旧口径 K_l(f,273.15 K) 偏高 7.7%（6 GHz）~ 9.1%（40 GHz）', Math.abs(r6 - 1.077) < 0.002 && Math.abs(r40 - 1.091) < 0.002,
    `6 GHz ×${r6.toFixed(4)}，40 GHz ×${r40.toFixed(4)}`)
}

// ② 对数正态 A_c（参数取 ValEx 给定值，与地图解耦）
{
  let maxD = 0
  for (const [lat, lon, p, f, el, m, s, PL, KL, Ac] of VALEX) {
    const L = p840.cloudLWCFromLognormal(p, { m, sigma: s, Pclw: PL })
    maxD = Math.max(maxD, Math.abs(p840.cloudMassAbsorptionKL(f) * L / Math.sin(el * Math.PI / 180) - Ac))
  }
  ok('对数正态 A_c 32 例 |Δ| < 1e-6 dB', maxD < 1e-6, `max ${maxD.toExponential(2)} dB`)
}

// ③ 云衰函数口径：K_L × L_red(max(p,1)) / sinθ；lFactor 削减（机载 P.2041-1 §4.3）
{
  const pr = { m: -2.481, sigma: 0.886, Pclw: 59.072 }
  // 回退表路径（不给经纬度）：L = getCloudLWC(max(p,1))
  const a = lc.calculateCloudAttenuation(30, 30, 0.1, undefined, undefined)
  const want = p840.cloudMassAbsorptionKL(30) * p840.getCloudLWC(1) / Math.sin(Math.PI / 6)
  ok('p<1% 按 1% 封顶（回退表）', Math.abs(a - want) < 1e-12, `${a.toFixed(4)} dB`)
  ok('可用度 100%（p=0）→ 0', lc.calculateCloudAttenuation(30, 30, 0, 45, 0) === 0)
  ok('lFactor=0.4 → 线性削减', Math.abs(p840.calculateCloudAttenuation(30, 30, 2, undefined, undefined, 0.4) - 0.4 * p840.calculateCloudAttenuation(30, 30, 2)) < 1e-12)
  ok('lFactor=0 → 0', p840.calculateCloudAttenuation(30, 30, 2, undefined, undefined, 0) === 0)
  void pr
}

// ④ 实时分支：手填柱液态水 → K_L·L/sinθ
{
  const r = inst.computeInstant({ lat: 30, lon: 110, freq: 20, pol: 'V', elevation: 40, azimuth: 180, cloudMode: 'manual', cloudLKgM2: 0.8,
    met: { t: 0, tC: 20, rh: 60, rainMmH: 0, psHpa: 1000, precipType: 'none' } })
  const want = 0.8 * p840.cloudMassAbsorptionKL(20) / Math.sin(40 * Math.PI / 180)
  ok('实时手填柱液态水与统计分支同一 K_L', Math.abs(r.cloudDb - want) < 1e-12, `${r.cloudDb.toFixed(4)} dB`)
}

// ⑤ 全精度参数图（resources/itu/p840_logn_v1.bin）在 ValEx 节点上的 m/s/P_L
{
  const bin = join(ROOT, 'resources/itu/p840_logn_v1.bin')
  if (existsSync(bin)) {
    const b = readFileSync(bin)
    cloudGrid.setData(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))
    let maxM = 0, maxS = 0, maxP = 0, n = 0
    for (const [lat, lon, , , , m, s, PL] of VALEX) {
      const pr = cloudGrid.getParams(lat, lon)
      if (!pr) continue
      n++
      maxM = Math.max(maxM, Math.abs(pr.m - m)); maxS = Math.max(maxS, Math.abs(pr.sigma - s)); maxP = Math.max(maxP, Math.abs(pr.Pclw - PL))
    }
    ok('参数图节点 m/s/P_L 与 ValEx 一致（≤ 打包精度）', n === VALEX.length && maxM < 2e-3 && maxS < 2e-3 && maxP < 2e-2,
      `n=${n}, |Δm|≤${maxM.toFixed(4)}, |Δs|≤${maxS.toFixed(4)}, |ΔP|≤${maxP.toFixed(3)}`)
  } else {
    ok('参数图 bin 缺失（跳过节点核对）', true)
  }
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`)
process.exit(fail ? 1 : 0)
