// Orekit 对拍：同一力模型下 LEO / GTO / GEO 的 7 天星历逐点比位置差（packages/core/utils/prop 的外部独立真值）。
//
// 【夹具】fixtures/prop/orekit-<算例>.json.gz，由 scripts/orekit-prop-refs.py 调 Orekit 13.1.9（Apache-2.0，经
//   orekit-jpype）生成：初始状态（EME2000 = J2000）、力模型配置、Orekit 的位置序列、同期 DE440 日月位置表（3 小时一点）
//   与地影进出时刻。两边力模型逐项对齐的做法、Orekit 侧积分容差与收敛性见该脚本头注。
// 【比法】JS 侧星历换成夹具里的 DE440 表（tabulatedEphemeris），rtol 1e-13 积到同一组输出点，逐点 |Δr| 取最大；
//   门限约为实测最大值的 3 倍。另测：平台缺省容差（rtol 1e-12）、平台缺省配置（解析历表 + rtol 1e-12）、地影进出时刻。
//   IERS 2010 全潮汐模型（第二步频率相关修正 + 固体极潮，JS 未实现）与 JS 只开第一步之差只报数，并核对它小于潮汐总效应的一半。
// 【实测（2026-10-17），7 天最大 |Δr|】
//   算例          力模型                                    DE440 表 1e-13   缺省 1e-12   解析历表 1e-12
//   leo-grav21    21×21                                       5.8 mm          3.3 cm         —
//   leo-grav70    70×70（2 天）                               6.3 cm         37.8 cm         —
//   leo-drag      21×21 + NRLMSISE-00 阻力                    1.9 cm          5.1 cm         —
//   leo-srp       21×21 + 光压（锥形地影）                    6.6 mm          1.4 cm         —
//   leo-notides   21×21（tide-free）+ 日月                    6.3 mm          3.3 cm         5.1 cm
//   leo-tides1    同上 + 固体潮第一步                         6.1 mm          3.3 cm         5.2 cm
//   leo-full      21×21 + 日月 + 光压 + 阻力                  4.8 mm          3.0 cm         4.7 cm
//   geo-full      8×8 + 日月 + 光压                           1.3 mm          2.6 mm        60 cm
//   gto           8×8 + 日月 + 光压                           5.2 mm          2.6 cm        44 cm
//   地影进出时刻（430 / 432 / 28 次）：DE440 表 ≤ 4 µs；解析历表 LEO ≤ 0.04 ms、GEO ≤ 0.47 ms。
//   leo-tides（Orekit IERS 2010 全模型）对 JS 第一步：18.6 m —— 即第二步 + 极潮的量级；潮汐总效应约 60 m。
//   （LEO = 450 km / e 0.0012 / 51.6°，2025-06-01 起；GEO / GTO 2026-09-20 起，秋分附近每天过地影。）

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
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const fmtM = (m) => m < 0.01 ? (m * 1000).toFixed(1) + ' mm' : m < 1 ? (m * 100).toFixed(1) + ' cm' : m.toFixed(2) + ' m'

const SWX = P.spaceWeather.createSpaceWeather(loadFx('orekitDensity').swCsv)
const TIGHT = { rtol: 1e-13, atolPos: 1e-10, atolVel: 1e-13 }

const tableEph = (c) => {
  const rows = (a) => a.map((r) => ({ tMs: r[0], r: r.slice(1) }))
  return P.ephemeris.tabulatedEphemeris({ sun: rows(c.ephemTable.sun), moon: rows(c.ephemTable.moon) })
}
const eclipseEvents = (eph) => [
  { name: 'penumbra', g: (t, r) => { const a = P.srp.shadowAngles(r, eph.sun(t)); return a.c - (a.a + a.b) } },
  { name: 'umbra', g: (t, r) => { const a = P.srp.shadowAngles(r, eph.sun(t)); return a.c - Math.abs(a.b - a.a) } }
]

function run(c, eph, extra) {
  const f = c.forces
  const fm = P.createForceModel({
    ephemeris: eph,
    gravity: { degree: f.gravity.degree, order: f.gravity.order, tideSystem: f.gravity.tideSystem },
    thirdBody: !!f.thirdBody,
    srp: f.srp ? { cr: f.srp.cr, areaToMass: f.srp.areaToMass } : false,
    drag: f.drag ? { cd: f.drag.cd, areaToMass: f.drag.areaToMass, spaceWeather: SWX } : false,
    tides: !!f.tides            // JS 只有 IERS 2010 第一步：'step1' 与 'iers2010' 两个夹具都按它算
  })
  const o = Object.assign({ tEndMs: c.t0Ms + c.durationSec * 1000, outStepSec: c.outStepSec }, extra)
  if (c.eclipses) Object.assign(o, { events: eclipseEvents(eph), eventTolSec: 1e-7 })
  const t1 = performance.now()
  const out = P.propagate({ tMs: c.t0Ms, r: c.r0, v: c.v0 }, fm, o)
  out.ms = performance.now() - t1
  return out
}
// 夹具 ref 行：[tSec, x, y, z]（km）
const maxDev = (out, ref) => { let w = 0; for (let k = 0; k < ref.length; k++) w = Math.max(w, dist(out[k].r, ref[k].slice(1, 4))); return w * 1000 }
const aligned = (out, c) => out.length === c.ref.length && out.every((s, k) => s.tMs === c.t0Ms + c.ref[k][0] * 1000)
function eclipseDiff(out, c) {
  const a = out.events, b = c.eclipses
  if (a.length !== b.length) return { same: false, n: a.length }
  let w = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].kind || a[i].increasing !== b[i].increasing) return { same: false, n: a.length }
    w = Math.max(w, Math.abs((a[i].tMs - c.t0Ms) / 1000 - b[i].tSec))
  }
  return { same: true, n: a.length, ms: w * 1000 }
}

/* ===== ① 常数：两边同一组 ===== */
section('常数')
{
  const fx = loadFx('orekit-leo-full')
  const egm = P.gravity.loadEgm2008()
  // JS 用 km、夹具（Orekit）用 m：比相对差（≤ 2 ulp 即同值）
  const same = (km, si) => Math.abs(km * 1e9 / si - 1) <= 4.5e-16
  ok(same(egm.gm, fx.meta.gm) && Math.abs(egm.ae * 1000 - fx.meta.ae) < 1e-9, '中心引力常数 / 参考半径 = 夹具（EGM2008：3.986004415e14 m³/s²，6378136.3 m）')
  ok(same(P.thirdBody.GM_SUN, fx.meta.gmSun) && same(P.thirdBody.GM_MOON, fx.meta.gmMoon), '日月 GM = Orekit 读 DE440 的 getGM()')
}

/* ===== ② 同一力模型、DE440 表、rtol 1e-13 ===== */
// [算例, 门限 m（DE440 表 + rtol 1e-13）, 门限 m（DE440 表 + 缺省 rtol 1e-12，null = 不测）, 门限 m（解析历表 + 缺省 rtol，null = 不测）]
const CASES = [
  ['leo-grav21', 0.02, 0.1, null],
  ['leo-grav70', 0.2, 1.0, null],
  ['leo-drag', 0.05, null, null],
  ['leo-srp', 0.02, 0.05, null],
  ['leo-notides', 0.02, null, null],
  ['leo-tides1', 0.02, null, null],
  ['leo-full', 0.02, null, 0.15],
  ['geo-full', 0.005, 0.01, 2.0],
  ['gto', 0.02, 0.1, 1.5]
]
const jsOut = {}
const refs = {}
for (const [name, tolTight, tolDef, tolAna] of CASES) {
  const c = loadFx('orekit-' + name).case
  refs[name] = c
  section(name + '（' + (c.durationSec / 86400) + ' 天，' + c.ref.length + ' 点）')
  const eph = c.ephemTable ? tableEph(c) : undefined
  const out = run(c, eph, TIGHT)
  jsOut[name] = out
  ok(aligned(out, c), '输出时刻与夹具逐点对齐')
  const d = maxDev(out, c.ref)
  console.log('  ' + (eph ? 'DE440 表' : '无日月') + ' + rtol 1e-13：max |Δr| = ' + fmtM(d) + '（' + out.stats.nsteps + ' 步，' + out.ms.toFixed(0) + ' ms）')
  ok(d <= tolTight, '对 Orekit 的最大位置差 < ' + fmtM(tolTight), fmtM(d))
  if (c.eclipses) {
    const e = eclipseDiff(out, c)
    console.log('  地影进出 ' + e.n + ' 次（Orekit ' + c.eclipses.length + ' 次）' + (e.same ? '，时刻差最大 ' + (e.ms * 1000).toFixed(1) + ' µs' : ''))
    ok(e.same, '地影事件序列（半影 / 本影、进 / 出）与 Orekit 逐个相同')
    ok(e.same && e.ms < 0.02, '地影进出时刻差 < 20 µs', e.same ? e.ms.toFixed(4) + ' ms' : '')
  }
  if (tolDef != null) {
    const o2 = run(c, eph, {})
    const d2 = maxDev(o2, c.ref)
    console.log('  ' + (eph ? 'DE440 表' : '无日月') + ' + 缺省 rtol 1e-12：max |Δr| = ' + fmtM(d2) + '（' + o2.stats.nsteps + ' 步，' + o2.ms.toFixed(0) + ' ms）')
    ok(d2 <= tolDef, '缺省容差下对 Orekit < ' + fmtM(tolDef), fmtM(d2))
  }
  if (tolAna != null) {
    const o3 = run(c, P.ephemeris.analyticEphemeris(), {})
    const d3 = maxDev(o3, c.ref)
    const e3 = c.eclipses ? eclipseDiff(o3, c) : null
    console.log('  平台缺省（解析历表 + rtol 1e-12）：max |Δr| = ' + fmtM(d3) + '（' + o3.ms.toFixed(0) + ' ms）'
      + (e3 && e3.same ? '；地影时刻差最大 ' + e3.ms.toFixed(3) + ' ms' : ''))
    ok(d3 <= tolAna, '平台缺省配置对 Orekit（DE440）< ' + fmtM(tolAna), fmtM(d3))
    if (e3) ok(e3.same && e3.ms < 2, '解析历表下地影事件逐个相同、时刻差 < 2 ms', e3.same ? e3.ms.toFixed(3) + ' ms' : '序列不同')
  }
}

/* ===== ③ 固体潮：IERS 2010 全模型 vs JS 第一步（未含项的量级） ===== */
section('固体潮：Orekit IERS 2010 全模型（第一步 + 第二步 + 极潮）对 JS 第一步')
{
  const full = loadFx('orekit-leo-tides').case, none = refs['leo-notides'], one = refs['leo-tides1']
  ok(full.ref.length === one.ref.length && full.t0Ms === one.t0Ms && JSON.stringify(full.r0) === JSON.stringify(one.r0),
    'leo-tides 与 leo-tides1 同一初值、同一输出网格')
  const js1 = jsOut['leo-tides1']
  const dGap = maxDev(js1, full.ref)
  let dTot = 0, dStep2 = 0
  for (let k = 0; k < full.ref.length; k++) {
    dTot = Math.max(dTot, dist(full.ref[k].slice(1, 4), none.ref[k].slice(1, 4)))
    dStep2 = Math.max(dStep2, dist(full.ref[k].slice(1, 4), one.ref[k].slice(1, 4)))
  }
  dTot *= 1000; dStep2 *= 1000
  console.log('  JS 第一步对 Orekit 全模型：max |Δr| = ' + fmtM(dGap) + '；Orekit 自身「全模型 − 第一步」' + fmtM(dStep2) + '；潮汐总效应（全模型 − 无潮汐）' + fmtM(dTot))
  ok(Math.abs(dGap - dStep2) < 0.05, 'JS 第一步与 Orekit 第一步对全模型的偏差相同（差 < 5 cm）—— 缺口全在未实现的第二步 + 极潮')
  ok(dGap < 0.5 * dTot, '第一步已解释潮汐总效应的一半以上')
}

console.log('\npropOrekit: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
