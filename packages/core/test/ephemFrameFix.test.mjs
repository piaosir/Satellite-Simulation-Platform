// 星历帧名两处合规修正（差距分析 A-09）：
//   ① CCSDS OEM 的 TDR（True of Date Rotating，地固旋转系 = GTOD）映射到本平台 FIXED，不再当惯性 TOD；
//   ② 「某历元」帧 MeanOfEpoch / TrueOfEpoch / TEMEOfEpoch 不给帧历元一律拒收（原来静默当 J2000 / TEME of date）；
//      给了帧历元（STK CoordinateSystemEpoch / OEM REF_FRAME_EPOCH）在解析时一次换到 J2000。
//
// 【外部依据】CCSDS 502.0-B-3 OEM 元数据 REF_FRAME 取 SANA 帧名表：TDR = True of Date, Rotating（Orekit
//   CelestialBodyFrame.TDR → GTOD）；REF_FRAME_EPOCH = 「帧历元，若帧定义本身不含」。STK .e 的
//   CoordinateSystemEpoch 同义。IAU-76 岁差 50.29″/年 → 2026 年初的 MeanOfEpoch 与 J2000 差约 0.363°。

import { createRequire } from 'node:module'
import * as M from '../../../src/shared/refFrames.js'
const require = createRequire(import.meta.url)
const F = require('../utils/frames.js')
const T = require('../utils/timeSystems.js')
const EF = require('../utils/ephemFormats.js')
const EI = require('../utils/ephemInterp.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const DEG = Math.PI / 180
const throwsWith = (fn, re) => { try { fn(); return false } catch (e) { return re.test(String(e && e.message)) } }

/* ===== ① 帧名归一 ===== */
section('① 帧名归一（core 与渲染端镜像同口径）')
ok(F.normFrame('TDR') === 'FIXED', 'normFrame TDR -> FIXED')
for (const n of ['MeanOfEpoch', 'TEMEOfEpoch', 'TrueOfEpoch', 'MEAN_OF_EPOCH']) {
  ok(F.normFrame(n) === '', `normFrame ${n} -> ''（缺帧历元即认不出）`, F.normFrame(n))
  ok(F.ofEpochBase(n) !== '', `ofEpochBase ${n} 认得出「某历元」帧`)
  ok(throwsWith(() => F.toTeme({ x: 7000, y: 0, z: 0 }, n, 0, 0), /缺帧历元/), `toTeme(${n}) 抛「缺帧历元」，不再静默当 TEME`)
}
ok(F.ofEpochBase('MeanOfEpoch') === 'MOD' && F.ofEpochBase('TrueOfEpoch') === 'TOD' && F.ofEpochBase('TEMEOfEpoch') === 'TEME', 'ofEpochBase 冻结档：MOD / TOD / TEME')
ok(F.frameKey('') === 'TEME' && F.frameKey(null) === 'TEME', 'frameKey 空帧名按平台缺省 TEME')
ok(throwsWith(() => F.frameKey('Mars2000'), /不受支持/), 'frameKey 未知帧名抛「不受支持」')
for (const n of ['TDR', 'MeanOfEpoch', 'TEMEOfEpoch', 'TrueOfEpoch', 'J2000', 'Fixed', 'TEMEOfDate', 'foo', '']) {
  ok(M.normFrame(n) === F.normFrame(n) && M.ofEpochBase(n) === F.ofEpochBase(n), `渲染端镜像 normFrame / ofEpochBase(${JSON.stringify(n)}) 一致`)
}
{
  const v = { x: 4123.4, y: -5211.9, z: 3001.2 }
  let same = true
  for (const base of ['MOD', 'TOD', 'TEME']) {
    for (const ms of [Date.UTC(2026, 0, 1), Date.UTC(1999, 5, 30, 12), Date.UTC(2031, 8, 9, 3, 4, 5)]) {
      const tE = T.julianCenturiesTT(ms)
      const a = F.ofEpochToJ2000(v, base, tE), b = M.ofEpochToJ2000(v, base, tE)
      const c = F.j2000ToOfEpoch(v, base, tE), d = M.j2000ToOfEpoch(v, base, tE)
      if (!(Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.z, b.z) && Object.is(c.x, d.x) && Object.is(c.y, d.y) && Object.is(c.z, d.z))) same = false
    }
  }
  ok(same, '「某历元」<-> J2000 两份实现逐位相同')
}

/* ===== ② TDR 帧 OEM：按地固系读，导入 -> 导出 -> 再导入回环 ===== */
section('② TDR 帧 OEM 导入回环')
// 一颗定点在 110.5°E 的同步星：地固坐标恒定（TDR 下每个采样点同一组数），速度为 0
const LON = 110.5, R = 42164.17
const P0 = [R * Math.cos(LON * DEG), R * Math.sin(LON * DEG), 0]
const T0 = Date.UTC(2026, 9, 17, 0, 0, 0)
const STEP = 600e3, N = 145
const iso = (ms) => new Date(ms).toISOString().replace('Z', '')
function oemKvn(frame, extraMeta) {
  const L = ['CCSDS_OEM_VERS = 2.0', 'CREATION_DATE = 2026-10-17T00:00:00', 'ORIGINATOR = TEST', '',
    'META_START', 'OBJECT_NAME = GEO-TEST', 'OBJECT_ID = 2026-999A', 'CENTER_NAME = EARTH', 'REF_FRAME = ' + frame]
  if (extraMeta) L.push(extraMeta)
  L.push('TIME_SYSTEM = UTC', 'START_TIME = ' + iso(T0), 'STOP_TIME = ' + iso(T0 + (N - 1) * STEP), 'INTERPOLATION = LAGRANGE', 'INTERPOLATION_DEGREE = 7', 'META_STOP', '')
  for (let k = 0; k < N; k++) L.push([iso(T0 + k * STEP), P0[0].toFixed(9), P0[1].toFixed(9), P0[2].toFixed(9), '0.000000000', '0.000000000', '0.000000000'].join(' '))
  return L.join('\n') + '\n'
}
const ecefAt = (tab, ms) => {
  const r = EI.evalTable(tab, ms)
  const g = sat.gstime(T.jdFromMs(ms))
  return F.temeToEcef({ x: r.x, y: r.y, z: r.z }, g)
}
{
  const r1 = EF.parseEphemeris(oemKvn('TDR'))
  ok(!r1.errors.length && r1.sats.length === 1, 'TDR OEM 解析成功', JSON.stringify(r1.errors))
  const s1 = r1.sats[0]
  ok(s1 && s1.frame === 'FIXED', 'TDR -> 帧 FIXED（地固），不是 TOD', s1 && s1.frame)
  const tab = EI.buildTable(s1)
  // 地固坐标进管线后仍是那个定点：采样时刻与采样之间都回到 P0（若按惯性 TOD 读，6 h 后经度差 90°，弦长约 6 万 km）
  let worstAt = 0, worstMid = 0
  for (let k = 0; k < (N - 1) * 2; k++) {
    const ms = T0 + k * STEP / 2
    const e = ecefAt(tab, ms)
    const d = Math.hypot(e.x - P0[0], e.y - P0[1], e.z - P0[2])
    if (k % 2) worstMid = Math.max(worstMid, d); else worstAt = Math.max(worstAt, d)
  }
  ok(worstAt < 1e-6, `采样时刻取位换回地固系仍是定点（最大偏差 ${worstAt.toExponential(2)} km < 1 mm）`)
  ok(worstMid < 1e-3, `采样之间（插值）仍是定点（最大偏差 ${worstMid.toExponential(2)} km < 1 m，余量是 TEME 里 8 点插值的截断）`)
  // 对照：同一组数按惯性 TOD 读（修正前的映射），6 h 后在地固系里已偏出 5 万 km 以上
  const asTod = EI.buildTable(Object.assign({}, s1, { frame: 'TOD' }))
  const e6 = ecefAt(asTod, T0 + 6 * 3600e3)
  ok(Math.hypot(e6.x - P0[0], e6.y - P0[1], e6.z - P0[2]) > 5e4, '对照：按惯性 TOD 读则 6 h 后偏出 5 万 km（修正前的错误量级）')
  // 导出（不换帧）-> 再导入：位置逐位相同到 1e-9 km，帧仍为 FIXED
  const txt = EF.serializeEphemeris([s1], 'ccsds-oem-kvn', { createdMs: T0 })
  const r2 = EF.parseEphemeris(txt)
  const s2 = r2.sats[0]
  ok(!r2.errors.length && s2 && s2.frame === 'FIXED', '导出再导入：帧仍为 FIXED')
  let maxDp = 0, maxDt = 0
  for (let i = 0; i < s1.t.length; i++) {
    maxDt = Math.max(maxDt, Math.abs(s2.t[i] - s1.t[i]))
    for (let j = 0; j < 3; j++) maxDp = Math.max(maxDp, Math.abs(s2.p[3 * i + j] - s1.p[3 * i + j]))
  }
  ok(s2.t.length === s1.t.length && maxDt === 0 && maxDp <= 1e-9, `导出再导入逐点一致（时刻差 ${maxDt} ms，位置差 ${maxDp} km）`)
  // XML 版同口径
  const xml = EF.serializeEphemeris([s1], 'ccsds-oem-xml', { createdMs: T0 }).replace(/<REF_FRAME>[^<]*<\/REF_FRAME>/, '<REF_FRAME>TDR</REF_FRAME>')
  const r3 = EF.parseEphemeris(xml)
  ok(!r3.errors.length && r3.sats[0] && r3.sats[0].frame === 'FIXED', 'OEM/XML 的 TDR 同样读成 FIXED')
  ok(EF.oemFrame('TDR') === 'FIXED' && EF.oemFrame('tdr') === 'FIXED', 'oemFrame(TDR) = FIXED')
}

/* ===== ③ 「某历元」帧：无帧历元拒收；有帧历元换到 J2000 ===== */
section('③ 「某历元」帧')
function stkE(frame, epochLine) {
  const L = ['stk.v.12.0', 'BEGIN Ephemeris', 'NumberOfEphemerisPoints 3', 'ScenarioEpoch 1 Jan 2026 00:00:00.000',
    'InterpolationMethod Lagrange', 'InterpolationSamplesM1 2', 'CentralBody Earth', 'CoordinateSystem ' + frame]
  if (epochLine) L.push(epochLine)
  L.push('DistanceUnit Kilometers', 'EphemerisTimePosVel',
    '0 7000.0 0.0 0.0 0.0 7.5 0.0',
    '60 6996.1 449.8 0.0 -0.48 7.49 0.0',
    '120 6984.6 898.9 0.0 -0.96 7.44 0.0',
    'END Ephemeris')
  return L.join('\n') + '\n'
}
for (const fr of ['MeanOfEpoch', 'TEMEOfEpoch', 'TrueOfEpoch']) {
  const r = EF.parseEphemeris(stkE(fr))
  ok(r.sats.length === 0 && r.errors.some((e) => /缺帧历元/.test(e) && /CoordinateSystemEpoch/.test(e)), `STK .e ${fr} 无 CoordinateSystemEpoch -> 拒收并报「缺帧历元」`, JSON.stringify(r.errors))
}
{
  const r = EF.parseEphemeris(oemKvn('MEANOFEPOCH'))
  ok(r.sats.length === 0 && r.errors.some((e) => /缺帧历元/.test(e) && /REF_FRAME_EPOCH/.test(e)), 'OEM MEANOFEPOCH 无 REF_FRAME_EPOCH -> 拒收并报「缺帧历元」', JSON.stringify(r.errors))
}
{
  // MeanOfEpoch，帧历元 2026-01-01：换到 J2000 后与原矢量夹角 ≈ 26 年岁差（约 0.363°），反换回原值
  const r = EF.parseEphemeris(stkE('MeanOfEpoch', 'CoordinateSystemEpoch 1 Jan 2026 00:00:00.000'))
  ok(!r.errors.length && r.sats.length === 1 && r.sats[0].frame === 'J2000', 'STK .e MeanOfEpoch + CoordinateSystemEpoch -> 收下、帧 J2000', JSON.stringify(r.errors))
  const s = r.sats[0]
  const v0 = { x: 7000, y: 0, z: 0 }, v1 = { x: s.p[0], y: s.p[1], z: s.p[2] }
  const ang = Math.acos((v0.x * v1.x + v0.y * v1.y + v0.z * v1.z) / (Math.hypot(v0.x, v0.y, v0.z) * Math.hypot(v1.x, v1.y, v1.z))) / DEG
  ok(Math.abs(ang - 0.3633) < 0.005, `MeanOfEpoch(2026) 与 J2000 夹角 ${ang.toFixed(4)}°（IAU-76 岁差 26 年 ≈ 0.363°）`)
  const tE = T.julianCenturiesTT(Date.UTC(2026, 0, 1))
  const back = F.j2000ToOfEpoch(v1, 'MOD', tE)
  ok(Math.hypot(back.x - 7000, back.y, back.z) < 1e-9, '换回 MeanOfEpoch 还原原值（1e-9 km）')
  ok(r.warnings.some((w) => /已换到 J2000/.test(w)), '告警记下换帧')
}
{
  // TEMEOfEpoch：帧历元那一刻的采样与「TEME of date」同值 —— 换到 J2000 须与 of-date 链逐点一致
  const E = Date.UTC(2026, 0, 1)
  const r = EF.parseEphemeris(stkE('TEMEOfEpoch', 'CoordinateSystemEpoch 1 Jan 2026 00:00:00.000'))
  const s = r.sats[0]
  const tE = T.julianCenturiesTT(E), nu = F.nutationAngles(tE)
  const want = F.fromTeme({ x: 7000, y: 0, z: 0 }, 'J2000', tE, 0, nu)
  ok(s && Math.hypot(s.p[0] - want.x, s.p[1] - want.y, s.p[2] - want.z) < 1e-9, 'TEMEOfEpoch 在帧历元那一刻 = TEME of date（换到 J2000 逐点一致）')
  // 帧历元之后 1 小时的点：「某历元」与「of date」不同（转动冻结）—— 差的就是 1 h 的岁差章动，量级 1e-4 km 以内但非零
  const v1 = { x: 6984.6, y: 898.9, z: 0 }
  const t1 = T.julianCenturiesTT(E + 120e3), nu1 = F.nutationAngles(t1)
  const ofDate = F.fromTeme(v1, 'J2000', t1, 0, nu1)
  const d = Math.hypot(s.p[6] - ofDate.x, s.p[7] - ofDate.y, s.p[8] - ofDate.z)
  ok(d > 0 && d < 1e-3, `「某历元」与「of date」在 2 min 后分开（${d.toExponential(2)} km），转动确实冻结`)
}
{
  const r = EF.parseEphemeris(oemKvn('TEMEOFEPOCH', 'REF_FRAME_EPOCH = 2026-10-17T00:00:00'))
  ok(!r.errors.length && r.sats[0] && r.sats[0].frame === 'J2000', 'OEM TEMEOFEPOCH + REF_FRAME_EPOCH -> 收下、帧 J2000', JSON.stringify(r.errors))
}

console.log('\nephemFrameFix: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
