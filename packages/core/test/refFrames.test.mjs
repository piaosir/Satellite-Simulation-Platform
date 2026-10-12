// 渲染端换帧镜像 src/shared/refFrames.js 与 core frames.js / timeSystems.js 的逐位对拍。
//
// 那份是手写 ESM 副本（渲染端吃不进 CJS），本测试是它唯一的防漂移闸门：
//   ① 章动表 / 闰秒表逐项相等；② 同一批时刻的 TT 世纪数、章动角逐位相等；
//   ③ 五个帧之间位置 / 速度往返逐位相等（含地固系的 ω × r 牵连项）；
//   ④ 信息栏读数 = 导出引擎读数：同一个 TEME 状态经 orbitState.stateVector 与 ephemFormats.convertSat 换到
//      J2000 / FIXED 后逐位相同（信息栏抄下来的数与导出的 OEM / STK .e 对得上）。

import { createRequire } from 'node:module'
import * as M from '../../../src/shared/refFrames.js'
import { stateVector, frameContext } from '../../../src/shared/orbitState.js'
import sat from '../../../src/viz/constellation/satellite.js'
const require = createRequire(import.meta.url)
const FR = require('../utils/frames.js')
const TS = require('../utils/timeSystems.js')
const EF = require('../utils/ephemFormats.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const same = (a, b) => Object.is(a, b)
const same3 = (a, b) => same(a.x, b.x) && same(a.y, b.y) && same(a.z, b.z)

section('① 常量与表')
ok(JSON.stringify(M.NUT80) === JSON.stringify(FR.NUT80), 'NUT80 106 行逐项相等')
ok(M.NUT80.length === 106, 'NUT80 共 106 行')
ok(JSON.stringify(M.LEAP_SECONDS) === JSON.stringify(TS.LEAP_SECONDS), '闰秒表逐项相等')
ok(same(M.ARCSEC, FR.ARCSEC) && same(M.OMEGA_E, FR.OMEGA_E), 'ARCSEC / OMEGA_E 同值')
ok(JSON.stringify(M.FRAMES) === JSON.stringify(FR.FRAMES), '帧名表相同')
for (const n of ['J2000', 'EME2000', 'ICRF', 'TEMEOfDate', 'TrueOfDate', 'MeanOfDate', 'Fixed', 'ITRF2020', 'WGS84', 'foo', '']) ok(M.normFrame(n) === FR.normFrame(n), `normFrame(${JSON.stringify(n)}) 一致`)

// 确定性伪随机（不依赖 Math.random，失败可复现）
let seed = 20261012
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }
const times = [Date.UTC(1972, 0, 1), Date.UTC(1999, 0, 1) - 1, Date.UTC(1999, 0, 1), Date.UTC(2017, 0, 1), Date.UTC(2026, 9, 12, 14, 20, 33, 123)]
for (let k = 0; k < 40; k++) times.push(Date.UTC(1990, 0, 1) + Math.floor(rnd() * 50 * 365.25 * 864e5))

section('② 时间与章动')
let tOk = true, nOk = true
for (const ms of times) {
  if (!same(M.taiMinusUtc(ms), TS.taiMinusUtc(ms)) || !same(M.jdFromMs(ms), TS.jdFromMs(ms)) || !same(M.julianCenturiesTT(ms), TS.julianCenturiesTT(ms))) tOk = false
  const t = TS.julianCenturiesTT(ms)
  const a = M.nutationAngles(t), b = FR.nutationAngles(t)
  for (const k of ['dpsi', 'deps', 'epsBar', 'eps', 'eqEq', 'om']) if (!same(a[k], b[k])) nOk = false
  const pa = M.precessionAngles(t), pb = FR.precessionAngles(t)
  for (const k of ['zeta', 'theta', 'z']) if (!same(pa[k], pb[k])) nOk = false
}
ok(tOk, `${times.length} 个时刻：taiMinusUtc / jdFromMs / julianCenturiesTT 逐位相等`)
ok(nOk, '岁差三角 + 章动六量逐位相等')

section('③ 五帧位置 / 速度')
const FRS = ['J2000', 'MOD', 'TOD', 'TEME', 'FIXED']
let pOk = 0, pAll = 0, vOk = 0
for (const ms of times) {
  const cm = M.contextAt(ms, sat.gstime), cf = FR.contextAt(ms, sat.gstime)
  ok(same(cm.t, cf.t) && same(cm.gmst, cf.gmst), 'contextAt 同一时刻同 t / gmst')
  const r = { x: (rnd() - 0.5) * 84000, y: (rnd() - 0.5) * 84000, z: (rnd() - 0.5) * 84000 }
  const v = { x: (rnd() - 0.5) * 16, y: (rnd() - 0.5) * 16, z: (rnd() - 0.5) * 16 }
  for (const f of FRS) {
    pAll++
    const a = M.fromTeme(r, f, cm.t, cm.gmst, cm.nu), b = FR.fromTeme(r, f, cf.t, cf.gmst, cf.nu)
    const a2 = M.toTeme(r, f, cm.t, cm.gmst, cm.nu), b2 = FR.toTeme(r, f, cf.t, cf.gmst, cf.nu)
    if (same3(a, b) && same3(a2, b2)) pOk++
    const va = M.velFromTeme(v, r, f, cm.t, cm.gmst, cm.nu), vb = FR.velFromTeme(v, r, f, cf.t, cf.gmst, cf.nu)
    const vc = M.velToTeme(v, r, f, cm.t, cm.gmst, cm.nu), vd = FR.velToTeme(v, r, f, cf.t, cf.gmst, cf.nu)
    if (same3(va, vb) && same3(vc, vd)) vOk++
  }
}
ok(pOk === pAll, `位置 fromTeme / toTeme ${pAll} 组逐位相等（${pOk}）`)
ok(vOk === pAll, `速度 velFromTeme / velToTeme ${pAll} 组逐位相等（${vOk}）`)

section('④ 信息栏读数 = 导出引擎读数')
// 一颗真 GEO 与一颗 LEO 的 SGP4 状态，在几个时刻换到 J2000 / FIXED / TEME：stateVector 与 convertSat 逐位相同
const TLES = [
  ['1 25544U 98067A   26284.50000000  .00012000  00000-0  21000-3 0  9990', '2 25544  51.6400 120.0000 0003000  90.0000 270.0000 15.50000000400000'],
  ['1 44067U 19012A   26280.50000000 -.00000300  00000-0  00000+0 0  9990', '2 44067   0.0400  85.0000 0002000 300.0000  60.0000  1.00270000 20000']
]
let eqOk = 0, eqAll = 0
for (const [l1, l2] of TLES) {
  const rec = sat.twoline2satrec(l1, l2)
  for (let k = 0; k < 6; k++) {
    const ms = Date.UTC(2026, 9, 12) + k * 3700123
    const pv = sat.propagate(rec, new Date(ms))
    const ctx = frameContext(ms, sat.gstime)
    for (const f of ['J2000', 'FIXED', 'TEME']) {
      eqAll++
      const sv = stateVector(pv, f, ctx)
      const s = { frame: 'TEME', t: [ms], p: [pv.position.x, pv.position.y, pv.position.z], v: [pv.velocity.x, pv.velocity.y, pv.velocity.z] }
      const c = EF.convertSat(s, f)
      if (same(sv.r.x, c.p[0]) && same(sv.r.y, c.p[1]) && same(sv.r.z, c.p[2]) && same(sv.v.x, c.v[0]) && same(sv.v.y, c.v[1]) && same(sv.v.z, c.v[2])) eqOk++
    }
  }
}
ok(eqOk === eqAll, `stateVector 与 convertSat 逐位相同（${eqOk}/${eqAll}）`)
// 地固系与 satellite.js eciToEcf 同口径（只转 GMST）
{
  const rec = sat.twoline2satrec(TLES[0][0], TLES[0][1]), ms = Date.UTC(2026, 9, 12, 3)
  const pv = sat.propagate(rec, new Date(ms)), ctx = frameContext(ms, sat.gstime)
  const sv = stateVector(pv, 'FIXED', ctx), e = sat.eciToEcf(pv.position, ctx.gmst)
  ok(same3(sv.r, e), 'FIXED 位置 = satellite.js eciToEcf（同一 GMST）')
  const vmag = Math.hypot(sv.v.x, sv.v.y, sv.v.z), wr = Math.hypot(pv.velocity.x + M.OMEGA_E * pv.position.y, pv.velocity.y - M.OMEGA_E * pv.position.x, pv.velocity.z)
  ok(Math.abs(vmag - wr) < 1e-12, '地固速度模 = |v − ω⊕ × r|（相对地球的速度）')
}

console.log(`\nrefFrames：${pass} 通过，${fail} 失败`)
if (fail) process.exit(1)
