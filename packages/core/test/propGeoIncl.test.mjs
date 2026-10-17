// GEO 倾角矢量的一年演化（packages/core/utils/prop，平台缺省力模型），对 Orekit 的独立数值积分。
//
// 【背景】平台原有的 SDP4 在 i < 3° 时把日月对升交点的长期率置零（dsinit 里 inclm < 5.2359877e-2 的 shs / shll 分支），
//   GEO 倾角矢量的年漂移因此失真（差距分析 A-03）。数值传播直接积日月引力，没有这条截断。
// 【物理】日月引力使 GEO 轨道面绕 Laplace 面极（相对赤道约 7.4°）以约 53 年周期进动；近赤道处倾角矢量
//   i⃗ = i·(cos Ω, sin Ω) 每年大致朝 Ω ≈ 90° 方向漂移 0.75–0.95°（随月球升交点的 18.6 年周期变化），叠加日的半年项与
//   月的半月项（Soop《Handbook of Geostationary Orbits》§4.3）。
// 【算例】a = 42164.17 km、e = 0.0002、Ω = 60°，i = 0.05° 与 1° 两条轨道，2026-09-20 起 365 天，逐日取倾角矢量。
//   JS：平台缺省力模型（EGM2008 8×8 + 日月解析历表 + 光压 C_R = 1.3、A/m = 0.02 m²/kg、锥形地影），DOP853 缺省容差。
//   参照：Orekit 13.1.9 —— 同一份 EGM2008 8×8、DE440 日月、同一光压与地影模型，DormandPrince853（dP = 1e-7 m、步长 ≤ 300 s）；
//   夹具 fixtures/prop/orekit-geo-year-i*.json.gz，由 scripts/orekit-prop-refs.py 生成。
// 【判据】① 逐日倾角矢量与 Orekit 之差；② 一年漂移量 |i⃗(365 d) − i⃗(0)|（整一年含两个半年周期，日的半年项相消）落在
//   0.85–0.95°，且与 Orekit 的同一量一致；③ DOP853 与 RKF78 两个积分器互校。
// 【实测（2026-10-17）】i = 0.05°：一年漂移 0.9228°（Orekit 0.9228°）；i = 1°：0.8841°（Orekit 0.8841°）。逐日倾角矢量与
//   Orekit 之差 ≤ 5.7e-6°（0.02″），位置差 ≤ 8.5 m —— 主要是解析历表与 DE440 之差（rtol 收紧到 1e-13 结果不变）。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
const require = createRequire(import.meta.url)
const P = require('../utils/prop/index.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const FXDIR = new URL('./fixtures/prop/', import.meta.url)
const loadFx = (name) => JSON.parse(gunzipSync(readFileSync(new URL(name + '.json.gz', FXDIR))).toString('utf8'))
const D = 180 / Math.PI
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const sub2 = (a, b) => [a[0] - b[0], a[1] - b[1]]
const len2 = (a) => Math.hypot(a[0], a[1])
const incl = (s) => P.elements.inclinationVector(s.r, s.v)

for (const i0 of ['0.05', '1.0']) {
  const c = loadFx('orekit-geo-year-i' + i0).case
  section('GEO i = ' + i0 + '°，' + new Date(c.t0Ms).toISOString().slice(0, 10) + ' 起 365 天')
  const f = c.forces
  ok(f.gravity.degree === 8 && f.gravity.order === 8 && f.thirdBody === true && f.srp.cr === 1.3 && f.srp.areaToMass === 0.02 && !f.drag && !f.tides,
    '夹具力模型 = 8×8 + 日月 + 光压（C_R 1.3、A/m 0.02）')

  const state0 = { tMs: c.t0Ms, r: c.r0, v: c.v0 }
  const opts = { tEndMs: c.t0Ms + c.durationSec * 1000, outStepSec: c.outStepSec }
  const fm = P.createForceModel({ srp: { cr: 1.3, areaToMass: 0.02 } }, state0)
  ok(fm.parts[0].name === 'gravity' && fm.parts[0].degree === 8 && fm.parts[0].order === 8 && fm.parts.some((p) => p.name === 'thirdBody'),
    '平台缺省：GEO 取 8×8 重力场 + 日月')
  const t1 = performance.now()
  const out = P.propagate(state0, fm, opts)
  const ms = performance.now() - t1
  ok(out.length === c.ref.length && out.every((s, k) => s.tMs === c.t0Ms + c.ref[k][0] * 1000), '366 个逐日点与夹具时刻对齐')

  const js = out.map(incl)
  const ore = c.ref.map((row) => incl({ r: row.slice(1, 4), v: row.slice(4, 7) }))
  let wi = 0, wr = 0
  for (let k = 0; k < js.length; k++) {
    wi = Math.max(wi, len2(sub2(js[k], ore[k])))
    wr = Math.max(wr, dist(out[k].r, c.ref[k].slice(1, 4)))
  }
  const n = js.length - 1
  const dJs = sub2(js[n], js[0]), dOre = sub2(ore[n], ore[0])
  console.log('  JS（DOP853 缺省容差，' + out.stats.nsteps + ' 步，' + ms.toFixed(0) + ' ms）：一年漂移 ' + (len2(dJs) * D).toFixed(4) + '°，方向 Ω = '
    + (Math.atan2(dJs[1], dJs[0]) * D).toFixed(1) + '°，末倾角 ' + (len2(js[n]) * D).toFixed(4) + '°')
  console.log('  Orekit：一年漂移 ' + (len2(dOre) * D).toFixed(4) + '°，方向 Ω = ' + (Math.atan2(dOre[1], dOre[0]) * D).toFixed(1) + '°，末倾角 ' + (len2(ore[n]) * D).toFixed(4) + '°')
  console.log('  逐日倾角矢量差最大 ' + (wi * D).toExponential(2) + '°（' + (wi * D * 3600).toFixed(3) + '″），位置差最大 ' + (wr * 1000).toFixed(2) + ' m')

  ok(len2(dJs) * D >= 0.85 && len2(dJs) * D <= 0.95, '一年漂移量 0.85–0.95°', (len2(dJs) * D).toFixed(5))
  ok(len2(dOre) * D >= 0.85 && len2(dOre) * D <= 0.95, 'Orekit 的一年漂移量同在 0.85–0.95°', (len2(dOre) * D).toFixed(5))
  ok(Math.abs(len2(dJs) - len2(dOre)) * D < 1e-4, '一年漂移量与 Orekit 一致（< 1e-4°）')
  ok(wi * D < 2e-5, '逐日倾角矢量与 Orekit 之差 < 2e-5°（实测 5.7e-6°）', (wi * D).toExponential(3))
  ok(wr < 0.025, '一年位置差 < 25 m（解析历表 vs DE440）', (wr * 1000).toFixed(2) + ' m')

  const outB = P.propagate(state0, fm, Object.assign({ integrator: 'RKF78' }, opts))
  let wb = 0
  for (let k = 0; k < js.length; k++) wb = Math.max(wb, len2(sub2(incl(outB[k]), js[k])))
  console.log('  RKF78 对 DOP853：逐日倾角矢量差最大 ' + (wb * D).toExponential(2) + '°')
  ok(wb * D < 1e-6, 'RKF78 与 DOP853 的逐日倾角矢量差 < 1e-6°', (wb * D).toExponential(3))
}

console.log('\npropGeoIncl: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
