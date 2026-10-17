// 合成轨道 → SGP4 平根数（差距分析 A-05）：packages/core/utils/sgp4Mean.js 与渲染端镜像 src/shared/sgp4Mean.js。
//
// 【判据】
//   ① 两份「共享段」逐字节相同（主进程 / 渲染端同一份算式）；同一输入两份逐位同值。
//   ② 通用口径：sgp4init 之后平半长轴 = 设计 a（信息卡近 / 远地点高度逐位回读）；Kozai 反解与 orbitState.kozaiMeanMotion 互逆；
//      主进程 buildSatrec（elements）与渲染端 3D 页 / 天线树 / 搜索池建出同一颗星。
//   ③ 设计目标在 SGP4 下成立（全部拿 SGP4 传播实测，不验公式本身）：
//      回归·太阳同步 233/16 一个回归周期（233 圈）后升交点经度闭合 < 0.01°；太阳同步 Ω̇ = 360°/回归年；
//      地球同步历元零漂移；Molniya 2:1 回归首日远地点经度不漂；550 km Walker 信息卡高度 550.000 km。
//      对照组：修改前的二体 n 当 Kozai 值（A 路 docs/research/gap-2026-10-17/A/exp1*.cjs 同一做法），数值写进用例名。
//   【外部真值】SGP4 本身（Vallado 2006 / satellite.js v7）：设计目标的判据只用它的传播结果，与本模块算式无关。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as M from '../../../src/shared/sgp4Mean.js'
import { kozaiMeanMotion } from '../../../src/shared/orbitState.js'
const require = createRequire(import.meta.url)
const C = require('../utils/sgp4Mean.js')
const sat = require('../vendor/satellite.js')
const ngGeom = require('../utils/ngsoGeometry.js')
const { default: satR } = await import('../../../src/viz/constellation/satellite.js')
const { default: OD } = await import('../../../src/viz/constellation/orbitDesign.js')
const { elementsOmm } = await import('../../../src/shared/treeOrbitEpoch.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const RE = 6378.137, MU = 398600.4418, DEG = Math.PI / 180, TWO_PI = 2 * Math.PI
const wrap = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; return x }
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0), EP = new Date(T0).toISOString()
const keplerRevDay = (a) => 86400 * Math.sqrt(MU / (a * a * a)) / TWO_PI   // 修改前：二体 n 直接当 Kozai 值
const recOf = (lib, n, el) => lib.omm2satrec({ noradId: 'T', epoch: EP, meanMotion: n, ecc: el.e, incl: el.i, raan: el.raan || 0, argp: el.argp || 0, ma: el.ma || 0, bstar: 0, mdot: 0, mddot: 0 })
const lonAt = (rec, ms) => { const d = new Date(ms); const p = sat.propagate(rec, d).position; return wrap((Math.atan2(p.y, p.x) - sat.gstime(d)) / DEG) }

/* ===== ① 两份一致 ===== */
section('① 主进程 / 渲染端两份')
{
  const here = fileURLToPath(new URL('.', import.meta.url))
  const cut = (file) => {
    const s = readFileSync(here + file, 'utf8').replace(/\r\n/g, '\n')
    const a = s.indexOf('/* <<<< 共享段'), b = s.indexOf('/* 共享段 >>>> */')
    return a >= 0 && b > a ? s.slice(a, b) : null
  }
  const core = cut('../utils/sgp4Mean.js'), mirror = cut('../../../src/shared/sgp4Mean.js')
  ok(core && mirror && core.length > 2000, '两份都有共享段')
  ok(core === mirror, '★ 共享段逐字节相同（' + (core ? core.length : 0) + ' 字符）')
  let same = true
  let seed = 20261017
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
  for (let k = 0; k < 400; k++) {
    const el = { altKm: 200 + rnd() * 40000, ecc: rnd() < 0.3 ? 0 : rnd() * 0.85, incl: rnd() * 180 }
    if (!Object.is(C.elementsMeanMotion(el), M.elementsMeanMotion(el))) same = false
  }
  ok(same, '400 组随机根数两份 Kozai 平均运动逐位相同')
  const sd = { aKm: 7077.72, e: 0, inclDeg: 98.19, raanDeg: 10, argpDeg: 0, m0Deg: 0 }
  const a1 = C.refineDesign({ kind: 'repeatSunSync', k: 233, m: 16 }, sd, T0, sat), a2 = M.refineDesign({ kind: 'repeatSunSync', k: 233, m: 16 }, sd, T0, satR)
  ok(a1.ok && a2.ok && Object.is(a1.seed.aKm, a2.seed.aKm) && Object.is(a1.seed.inclDeg, a2.seed.inclDeg), '设计反解：core + vendor SGP4 与 渲染端镜像 + 渲染端 SGP4 逐位同解')
}

/* ===== ② 通用口径 ===== */
section('② 通用口径：平半长轴 = 设计 a')
{
  let worst = 0, worstK = 0
  for (const [h, e, i] of [[550, 0, 53], [550, 0, 0], [550, 0, 97.6], [1200, 0, 87.9], [20180, 0, 55], [35786, 0, 0], [500, 0.741, 63.4349], [32000, 0.1, 43], [800, 0.001, 98.6], [550, 0, 180]]) {
    const el = { altKm: h, ecc: e, incl: i, raan: 0, argp: 0, ma: 0 }
    const rec = sat.omm2satrec(C.ommFromElements(el, EP, 'T'))
    worst = Math.max(worst, Math.abs(rec.altp * RE - h))
    worstK = Math.max(worstK, Math.abs(kozaiMeanMotion(rec) * C.XPDOTP / C.elementsMeanMotion(el) - 1))
  }
  ok(worst < 1e-8, `信息卡近地点高度逐位回读设计值（10 组 LEO / MEO / GEO / HEO，最大差 ${worst.toExponential(2)} km）`)
  ok(worstK < 1e-13, `Kozai 反解与 orbitState.kozaiMeanMotion 互逆（相对差 ${worstK.toExponential(2)}）`)
  // 550 km Walker（i = 53°）：修改前二体口径信息卡显示 550.279 km
  const w = { altKm: 550, ecc: 0, incl: 53 }
  const nowRec = sat.omm2satrec(C.ommFromElements(w, EP)), oldRec = recOf(sat, keplerRevDay(RE + 550), { e: 0, i: 53 })
  ok(Math.abs(nowRec.altp * RE - 550) < 1e-9 && Math.abs(oldRec.altp * RE - 550.279) < 0.001, `★ 550 km Walker：实际高度（信息卡）550.000 km；修改前 ${(oldRec.altp * RE).toFixed(3)} km`)
  // 主进程 buildSatrec（elements）= 渲染端天线树 elementsOmm = 3D 页自定义星座：同一组根数同一颗星
  const el = { altKm: 780, ecc: 0.002, incl: 86.4, raan: 33, argp: 90, ma: 10 }
  const rMain = ngGeom.buildSatrec({ type: 'elements', ...el, epoch: EP, noradId: 9 })
  const rTree = satR.omm2satrec(elementsOmm({ ...el, epoch: EP }, 9))
  const keys = ['no', 'a', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'mdot', 'nodedot', 'argpdot', 'jdsatepoch']
  ok(keys.every((k) => Object.is(rMain[k], rTree[k])), '★ 主进程 buildSatrec(elements) 与渲染端 elementsOmm 建出的 satrec 逐位相同')
}

/* ===== ③ 设计目标在 SGP4 下成立 ===== */
section('③ 回归·太阳同步 233/16')
const g0 = sat.gstime(new Date(T0))
const solveR = (type, inp) => OD.solveDesign(type, inp, T0, { gmst: g0, sgp4: satR })
const solveJ = (type, inp) => OD.solveDesign(type, inp, T0, { gmst: g0 })
function closure(rec, k) {
  // 由升交点（z 由负转正）找起点，推 k 圈后同一升交点的星下点经度差
  const posAt = (ms) => sat.propagate(rec, new Date(ms)).position
  const nextAN = (ms) => {
    let t = ms, z0 = posAt(t).z
    for (;;) {
      const t2 = t + 20e3, z = posAt(t2).z
      if (z0 < 0 && z >= 0) { let lo = t, hi = t2; for (let j = 0; j < 60; j++) { const mid = (lo + hi) / 2; if (posAt(mid).z < 0) lo = mid; else hi = mid } return (lo + hi) / 2 }
      z0 = z; t = t2
    }
  }
  const Tn = TWO_PI / (rec.mdot + rec.argpdot) * 60e3
  const an0 = nextAN(T0)
  let an = an0
  for (let r = 0; r < k; r++) an = nextAN(an + Tn * 0.5)
  return { dLon: wrap(lonAt(rec, an) - lonAt(rec, an0)), days: (an - an0) / 864e5 }
}
{
  const inp = { k: 233, m: 16, anLonDeg: 0, localTime: '10:00', localMode: 'ltdn' }
  const r = solveR('repeatSunSync', inp), j = solveJ('repeatSunSync', inp)
  ok(r.ok && !r.warns.length, '求解成功', JSON.stringify(r.errs.concat(r.warns)))
  const el = { altKm: r.seed.aKm - RE, ecc: 0, incl: r.seed.inclDeg, raan: r.seed.raanDeg }
  const c1 = closure(sat.omm2satrec(C.ommFromElements(el, EP)), 233)
  const c0 = closure(recOf(sat, keplerRevDay(j.seed.aKm), { e: 0, i: j.seed.inclDeg, raan: j.seed.raanDeg }), 233)
  ok(Math.abs(c1.dLon) < 0.01, `★ 233 圈后升交点经度闭合 ${c1.dLon.toExponential(2)}°（< 0.01°）；修改前 ${c0.dLon.toFixed(3)}°`)
  ok(Math.abs(c1.days - 16) < 1e-5 && Math.abs(c0.days - 16) > 0.005, `用时 ${c1.days.toFixed(6)} d（修改前 ${c0.days.toFixed(4)} d）`)
  ok(Math.abs(r.derived.raanRateDegDay - 0.98564736) < 1e-6, `读数 Ω̇ = ${r.derived.raanRateDegDay.toFixed(8)} °/d（SGP4 长期率）`)
  ok(Math.abs(r.derived.nodalPeriodMin - 16 * 1440 / 233) < 1e-5, `读数交点周期 = 16·1440/233 min（${r.derived.nodalPeriodMin.toFixed(6)}）`)
  ok(Math.abs(r.derived.ltdnHours - 10) < 1e-9, 'LTDN 落点不动（10:00）')
  // 非太阳同步回归：倾角是输入、不动
  const rp = solveR('repeat', { inclDeg: 98.2, k: 233, m: 16, anLonDeg: 0 })
  const cp = closure(sat.omm2satrec(C.ommFromElements({ altKm: rp.seed.aKm - RE, ecc: 0, incl: rp.seed.inclDeg, raan: rp.seed.raanDeg }, EP)), 233)
  ok(rp.ok && rp.seed.inclDeg === 98.2 && Math.abs(cp.dLon) < 0.01, `回归轨道 i = 98.2°（不动）：233 圈闭合 ${cp.dLon.toExponential(2)}°`)
}

section('③ 太阳同步')
{
  const OMEGA_SS = 360 / 365.2421897
  for (const h of [500, 800]) {
    const r = solveR('sunSync', { driver: 'alt', altKm: h, localTime: '10:30', localMode: 'ltan' }), j = solveJ('sunSync', { driver: 'alt', altKm: h, localTime: '10:30', localMode: 'ltan' })
    const rec = sat.omm2satrec(C.ommFromElements({ altKm: h, ecc: 0, incl: r.seed.inclDeg }, EP)), old = recOf(sat, keplerRevDay(RE + h), { e: 0, i: j.seed.inclDeg })
    const err = rec.nodedot * 1440 / DEG / OMEGA_SS - 1, errOld = old.nodedot * 1440 / DEG / OMEGA_SS - 1
    ok(Math.abs(err) < 1e-11 && Math.abs(r.seed.aKm - RE - h) < 1e-9, `★ ${h} km：SGP4 Ω̇ 与 360°/回归年 相对差 ${err.toExponential(1)}（修改前 ${(errOld * 100).toFixed(2)}%，一年 LTAN 漂 ${(errOld * 365.25 * OMEGA_SS * 4).toFixed(1)} min）；i ${j.seed.inclDeg.toFixed(4)} → ${r.seed.inclDeg.toFixed(4)}°，高度不动`)
  }
  const ri = solveR('sunSync', { driver: 'incl', inclDeg: 98.6, localTime: '10:30', localMode: 'ltan' })
  const reci = sat.omm2satrec(C.ommFromElements({ altKm: ri.seed.aKm - RE, ecc: 0, incl: 98.6 }, EP))
  ok(ri.ok && ri.seed.inclDeg === 98.6 && Math.abs(reci.nodedot * 1440 / DEG / OMEGA_SS - 1) < 1e-11, `给倾角 98.6° 解高度：${(ri.seed.aKm - RE).toFixed(2)} km，Ω̇ 严格太阳同步`)
  const cs = solveR('criticalSunSync', { perigeeKm: 500, anLonDeg: 0, argpDeg: 270 })
  const recc = sat.omm2satrec(C.ommFromElements({ altKm: cs.seed.aKm * (1 - cs.seed.e) - RE, ecc: cs.seed.e, incl: cs.seed.inclDeg, argp: 270 }, EP))
  ok(cs.ok && Math.abs(recc.altp * RE - 500) < 1e-6 && Math.abs(recc.nodedot * 1440 / DEG / OMEGA_SS - 1) < 1e-11, `临界倾角·太阳同步：近地点 500 km 守住、e = ${cs.seed.e.toFixed(6)}、Ω̇ 严格太阳同步`)
}

section('③ 地球同步零漂移（110.5°E）')
{
  // 日平均星下点经度（一个恒星日 96 点）
  const dayMean = (rec, ms) => { let acc = 0, prev = null, s = 0; for (let k = 0; k < 96; k++) { const L = lonAt(rec, ms + k * 86164.0905e3 / 96); acc = prev == null ? L : acc + wrap(L - prev); prev = L; s += acc } return s / 96 }
  const r = solveR('geosync', { subLonDeg: 110.5, inclDeg: 0 }), j = solveJ('geosync', { subLonDeg: 110.5, inclDeg: 0 })
  const el = { altKm: r.seed.aKm - RE, ecc: 0, incl: 0, raan: r.seed.raanDeg }
  const rec = sat.omm2satrec(C.ommFromElements(el, EP))
  const R = C.sgp4Rates(rec)
  const driftEpoch = (R.m + R.w + R.o - C.gmstRate(T0)) * 1440 / DEG
  ok(r.ok && Math.abs(driftEpoch) < 1e-9, `★ 历元漂移率 ${driftEpoch.toExponential(1)} °/d（Ṁ + ω̇ + Ω̇ = GMST 变化率；含 SDP4 日月长期项）`)
  const old = recOf(sat, keplerRevDay(j.seed.aKm), { e: 0, i: 0, raan: j.seed.raanDeg })
  const Ro = C.sgp4Rates(old), driftOld = (Ro.m + Ro.w + Ro.o - C.gmstRate(T0)) * 1440 / DEG
  ok(driftOld > 0.005, `对照：修改前二体口径历元漂移率 ${driftOld.toFixed(4)} °/d（叠上 J22 共振减速，A 路 exp1c 量到日平均经度头几天每天 +0.0026…+0.0047°）`)
  const d0 = dayMean(rec, T0), d1 = dayMean(rec, T0 + 86164.0905e3)
  const o0 = dayMean(old, T0), o1 = dayMean(old, T0 + 86164.0905e3)
  ok(Math.abs(d1 - d0) < 0.004, `首日日平均经度变化 ${(d1 - d0).toFixed(5)}°（只剩 SDP4 的 J22 共振加速度 ≈ −2e-3 °/d² 的半天量；修改前 ${(o1 - o0).toFixed(5)}°）`)
  ok(Math.abs(wrap(d0 - 110.5)) < 0.06, `日平均经度 ${d0.toFixed(4)}°E（落点按平根数放，SDP4 日月周期项 ±0.04° 照常叠加）`)
  ok(Math.abs(r.seed.aKm - 42165.825) < 0.01 && Math.abs(C.elementsMeanMotion(el) - 1.002717) < 2e-6, `平半长轴 ${r.seed.aKm.toFixed(3)} km、Kozai n = ${C.elementsMeanMotion(el).toFixed(8)} rev/d（真实 GEO 星 TLE 同量级）`)
  ok(Math.abs(OD.raanToLon(r.seed.raanDeg, g0) - 110.5) < 1e-9 && Math.abs(r.derived.subLonDeg - 110.5) < 1e-9, '设计落点（平根数星下点）仍是 110.5°E')
}

section('③ Molniya 2:1 回归（远地点 100°E）')
{
  const apoNear = (rec, tGuess, win) => {
    const rr = (ms) => { const p = sat.propagate(rec, new Date(ms)).position; return Math.hypot(p.x, p.y, p.z) }
    let lo = tGuess - win, hi = tGuess + win
    for (let k = 0; k < 100; k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (rr(m1) < rr(m2)) lo = m1; else hi = m2 }
    return (lo + hi) / 2
  }
  const apoDrift = (rec, days) => {
    const P = TWO_PI / C.sgp4Rates(rec).m * 60e3
    let tA = apoNear(rec, T0, 3600e3)
    const L0 = lonAt(rec, tA), out = [0]
    for (let k = 1; k <= days * 2; k++) { tA = apoNear(rec, tA + P, 1800e3); if (k % 2 === 0) out.push(wrap(lonAt(rec, tA) - L0)) }
    return out
  }
  const inp = { apogeeLonDeg: 100, perigeeKm: 500, argpDeg: 270 }
  const r = solveR('molniya', inp), j = solveJ('molniya', inp)
  const rec = sat.omm2satrec(C.ommFromElements({ altKm: r.seed.aKm * (1 - r.seed.e) - RE, ecc: r.seed.e, incl: r.seed.inclDeg, raan: r.seed.raanDeg, argp: r.seed.argpDeg, ma: r.seed.m0Deg }, EP))
  const old = recOf(sat, keplerRevDay(j.seed.aKm), { e: j.seed.e, i: j.seed.inclDeg, raan: j.seed.raanDeg, argp: j.seed.argpDeg, ma: j.seed.m0Deg })
  const dn = apoDrift(rec, 30), dOld = apoDrift(old, 30)
  ok(r.ok && Math.abs(rec.altp * RE - 500) < 1e-6, `近地点 500 km 守住；a ${j.seed.aKm.toFixed(2)} → ${r.seed.aKm.toFixed(2)} km、远地点 ${r.derived.apogeeKm.toFixed(1)} km`)
  ok(Math.abs(dn[1]) < 0.01, `★ 首日远地点经度漂移 ${dn[1].toFixed(4)}°（修改前 ${dOld[1].toFixed(3)}°/d）`)
  ok(Math.abs(dn[30]) < Math.abs(dOld[30]) / 2, `30 天远地点经度漂移 ${dn[30].toFixed(2)}°（12 h 共振的二次项；修改前 ${dOld[30].toFixed(2)}°）`)
}

section('④ 链路预算库条目认星（改口径前选下的星照样跟上场景历元）')
{
  const G = await import('../../../src/viz/constellation/customConstGen.js')
  const { generateConstellation } = await import('../../../src/viz/constellation/walker.js')
  const { scenarioEpochPatch } = await import('../../../src/shared/lbTreeOrbit.js')
  const DAY = 86400000, E_OLD = T0 - 30 * DAY, iso = (ms) => new Date(ms).toISOString()
  for (const [type, inputs] of [['geosync', { subLonDeg: 110.5, inclDeg: 0 }], ['repeatSunSync', { k: 233, m: 16, anLonDeg: 0, localTime: '10:00', localMode: 'ltdn' }], ['molniya', { apogeeLonDeg: 100, perigeeKm: 500, argpDeg: 270 }], ['sunSync', { driver: 'incl', inclDeg: 98.6, localTime: '10:30', localMode: 'ltan' }]]) {
    const c = { params: OD.seedToParams(OD.solveDesign(type, inputs, E_OLD, { gmst: sat.gstime(new Date(E_OLD)) }).seed, { pattern: 'single' }, 'X'), design: { type, inputs } }
    // 30 天前、改口径前（J2 一阶式、无 SGP4 校正）选下的那颗星
    const old = generateConstellation(c.params)[0].elements
    const spec = { type: 'elements', noradId: '900000', epoch: iso(E_OLD), ...old }
    const now = G.customConstSats(c, iso(T0))[0].elements
    const rec = { orbitType: 'elements', noradId: '900000', epoch: iso(T0), elements: now, epochFrame: G.designFrame(c) }
    const p = scenarioEpochPatch(spec, [rec])
    ok(p && p.epoch === iso(T0) && p.altKm === now.altKm && p.ecc === now.ecc && p.incl === now.incl && p.raan === now.raan, `${type}：改口径前选下的库条目认得出，历元与根数一起换成当前（SGP4 校正后）的`)
    ok(scenarioEpochPatch({ ...spec, altKm: old.altKm + 0.005 * (RE + old.altKm) }, [rec]) === null && scenarioEpochPatch({ ...spec, incl: old.incl + 0.5 }, [rec]) === null, `${type}：设计真改过（地心距 0.5% / 倾角 0.5°）→ 不动`)
  }
}

section('⑤ 坏输入')
{
  ok(!C.refineDesign({ kind: 'nope' }, { aKm: 7000, e: 0, inclDeg: 50 }, T0, sat).ok, '未知目标 → ok=false')
  ok(!C.refineDesign({ kind: 'repeat', k: 0, m: 1 }, { aKm: 7000, e: 0, inclDeg: 50 }, T0, sat).ok, 'k = 0 → ok=false')
  ok(!C.refineDesign({ kind: 'sma' }, { aKm: 7000, e: 0, inclDeg: 50 }, NaN, sat).ok && !C.refineDesign({ kind: 'sma' }, { aKm: 7000 }, T0, null).ok, '坏历元 / 不给 SGP4 → ok=false')
  ok(Number.isNaN(C.meanMotionForSma(0, 0, 0)) && Number.isNaN(C.meanMotionForSma(-5, 0, 0)), 'a ≤ 0 → NaN')
  const s = { aKm: 7000, e: 0, inclDeg: 50, raanDeg: 1, argpDeg: 2, m0Deg: 3 }
  const r = C.refineDesign({ kind: 'sma' }, s, T0, sat)
  ok(r.ok && r.seed !== s && r.seed.aKm === 7000 && s.aKm === 7000 && r.seed.raanDeg === 1, "'sma'：不迭代、不改入参")
  const noSgp = solveJ('sunSync', { driver: 'alt', altKm: 800, localTime: '10:30', localMode: 'ltan' })
  ok(Math.abs(noSgp.seed.inclDeg - 98.6031) < 1e-3, '不给 ctx.sgp4：停在 J2 一阶解（公式层回归不变）')
}

console.log('\nsgp4Mean: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
