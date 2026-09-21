// 外部星历格式（STK .e / CCSDS OEM 的 KVN 与 XML / SP3）解析与序列化的回归网。
//
// 两条判据：
//   ① 同格式回环——导入 -> 导出 -> 再导入，时间到 μs、位置到 1e-9 km 逐位相同；
//   ② 跨帧回环——导出成另一个参考系再导入，同一时刻的 TEME 位置差 <= 1 m（内部一致性）。
// 另有一批「拒收要点名」「坏输入不炸」的断言：解析器是外部文件的第一道门，不许抛 JS 内部异常。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const E = require('../utils/ephemFormats.js')
const EI = require('../utils/ephemInterp.js')
const T = require('../utils/timeSystems.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

const MU = 398600.4418
const T0 = Date.UTC(2026, 8, 21)
const R = 6878.137, INCL = 51.6
const N = Math.sqrt(MU / (R * R * R))
const CI = Math.cos(INCL * Math.PI / 180), SI = Math.sin(INCL * Math.PI / 180)
const truth = (sec) => ({
  x: R * Math.cos(N * sec), y: R * Math.sin(N * sec) * CI, z: R * Math.sin(N * sec) * SI,
  vx: -R * N * Math.sin(N * sec), vy: R * N * Math.cos(N * sec) * CI, vz: R * N * Math.cos(N * sec) * SI
})
const f9 = (x) => x.toFixed(9)
const COUNT = 21, STEP = 60

/* ===================== 造件：STK .e ===================== */
function makeE(opt) {
  const o = Object.assign({ frame: 'J2000', unit: 'Kilometers', timeFormat: 'EpSec', block: 'EphemerisTimePosVel', method: 'Lagrange' }, opt)
  const L = ['stk.v.12.0', '', 'BEGIN Ephemeris', '', '# 这一行是注释', 'NumberOfEphemerisPoints ' + COUNT,
    'ScenarioEpoch ' + T.formatUtcg(T0), 'InterpolationMethod ' + o.method, 'InterpolationSamplesM1 5',
    'CentralBody Earth', 'CoordinateSystem ' + o.frame, 'DistanceUnit ' + o.unit, 'TimeFormat ' + o.timeFormat, '', o.block, '']
  const scale = /^kil/i.test(o.unit) ? 1 : 1000
  for (let i = 0; i < COUNT; i++) {
    const s = i * STEP, q = truth(s)
    let tt
    if (/UTCG/i.test(o.timeFormat)) tt = T.formatUtcg(T0 + s * 1000)
    else if (/ISO/i.test(o.timeFormat)) tt = T.formatCcsds(T0 + s * 1000)
    else if (/JDate/i.test(o.timeFormat)) tt = T.jdFromMs(T0 + s * 1000).toFixed(9)
    else tt = s.toFixed(6)
    const cols = [tt]
    if (o.block === 'EphemerisTimePos') cols.push(f9(q.x * scale), f9(q.y * scale), f9(q.z * scale))
    else if (o.block === 'EphemerisTimePosVel') cols.push(f9(q.x * scale), f9(q.y * scale), f9(q.z * scale), f9(q.vx * scale), f9(q.vy * scale), f9(q.vz * scale))
    else if (o.block === 'EphemerisTimePosVelAcc') cols.push(f9(q.x * scale), f9(q.y * scale), f9(q.z * scale), f9(q.vx * scale), f9(q.vy * scale), f9(q.vz * scale), '0.0', '0.0', '0.0')
    else if (o.block === 'EphemerisLLATimePos') cols.push('30.5', '114.25', f9(700 * scale))
    else if (o.block === 'EphemerisLLRTimePos') cols.push('30.5', '114.25', f9(R * scale))
    L.push(cols.join(' '))
  }
  L.push('', 'END Ephemeris', '')
  return L.join('\n')
}

/* ===== ① .e 五种数据块 ===== */
section('STK .e 数据块')
for (const block of ['EphemerisTimePos', 'EphemerisTimePosVel', 'EphemerisTimePosVelAcc', 'EphemerisLLATimePos', 'EphemerisLLRTimePos']) {
  const r = E.parseEphemeris(makeE({ block }), null, { name: block })
  ok(r.format === 'stk-e' && !r.errors.length, block + '：解析成功', JSON.stringify(r.errors))
  ok(r.sats.length === 1 && r.sats[0].t.length === COUNT, block + '：' + COUNT + ' 点', String(r.sats[0] && r.sats[0].t.length))
  const s = r.sats[0]
  if (/LL[AR]/.test(block)) {
    ok(s.frame === 'FIXED', block + '：按定义落在地固系（不看 CoordinateSystem）', s.frame)
    ok(!s.v, block + '：无速度列')
  } else {
    ok(s.frame === 'J2000', block + '：帧取 CoordinateSystem', s.frame)
    ok(!!s.v === (block !== 'EphemerisTimePos'), block + '：速度列与块名一致')
    ok(Math.abs(s.p[0] - R) < 1e-9, block + '：首点位置')
  }
  ok(s.t[0] === T0 && s.t[COUNT - 1] === T0 + (COUNT - 1) * STEP * 1000, block + '：时标')
}
// LLA 与 LLR 的高度语义不同：LLA 是大地高（+700 km），LLR 是地心距（= R）
const lla = E.parseEphemeris(makeE({ block: 'EphemerisLLATimePos' })).sats[0]
const llr = E.parseEphemeris(makeE({ block: 'EphemerisLLRTimePos' })).sats[0]
near(Math.hypot(llr.p[0], llr.p[1], llr.p[2]), R, 1e-9, 'LLR 的地心距就是给的半径')
ok(Math.hypot(lla.p[0], lla.p[1], lla.p[2]) > 7000, 'LLA 的大地高 700 km 抬高了地心距')

/* ===== ② 三种 TimeFormat + 单位 ===== */
section('TimeFormat 与单位')
const base = E.parseEphemeris(makeE({})).sats[0]
// JDate 的容差不是 μs：儒略日 2.46e6 在 float64 里的分辨率是 2.46e6·2⁻⁵² ≈ 5.5e-10 d ≈ 0.047 ms，
// 这是 JD 这种「大整数 + 小数」写法本身的表示极限，与解析实现无关（本平台导出不用 JDate）。
for (const [tf, tol] of [['UTCG', 0.001], ['ISO-YMD', 0.001], ['JDate', 0.1]]) {
  const s = E.parseEphemeris(makeE({ timeFormat: tf })).sats[0]
  ok(s && s.t.length === COUNT, tf + '：点数一致')
  let worst = 0
  for (let i = 0; i < COUNT; i++) worst = Math.max(worst, Math.abs(s.t[i] - base.t[i]))
  ok(worst < tol, tf + '：时标与 EpSec 一致到 ' + tol + ' ms（差 ' + worst + ' ms）')
}
const mSat = E.parseEphemeris(makeE({ unit: 'Meters' })).sats[0]
let uWorst = 0
for (let i = 0; i < 3 * COUNT; i++) uWorst = Math.max(uWorst, Math.abs(mSat.p[i] - base.p[i]))
ok(uWorst < 1e-9, 'DistanceUnit Meters 换算到 km（差 ' + uWorst + '）')
ok(E.parseEphemeris(makeE({ method: 'Hermite' })).sats[0].interp.method === 'hermite', 'InterpolationMethod Hermite')
ok(base.interp.samples === 6, 'InterpolationSamplesM1 5 -> 6 点', String(base.interp.samples))

/* ===== ③ 拒收要点名 ===== */
section('拒收')
const rejFrame = E.parseEphemeris(makeE({ frame: 'MarsCentered' }))
ok(rejFrame.errors.some((e) => /MarsCentered/.test(e)), '坐标系拒收并点名', JSON.stringify(rejFrame.errors))
const rejUnit = E.parseEphemeris(makeE({ unit: 'Parsecs' }))
ok(rejUnit.errors.some((e) => /Parsecs/i.test(e)), '距离单位拒收并点名', JSON.stringify(rejUnit.errors))
const rejBody = E.parseEphemeris(makeE({}).replace('CentralBody Earth', 'CentralBody Mars'))
ok(rejBody.errors.some((e) => /mars/i.test(e)), '中心天体拒收并点名', JSON.stringify(rejBody.errors))

/* ===== ④ 协方差 / 未知块整块跳过 ===== */
section('未知块跳过')
const withCov = makeE({}).replace('END Ephemeris',
  'CovarianceTimePosVel\n0.0 1 2 3 4 5 6 7 8 9 10\n60.0 1 2 3 4 5 6 7 8 9 10\n\nEND Ephemeris')
const cov = E.parseEphemeris(withCov)
ok(cov.sats.length === 1 && cov.sats[0].t.length === COUNT, '协方差块不污染星历点', String(cov.sats[0] && cov.sats[0].t.length))
ok(cov.warnings.some((w) => /CovarianceTimePosVel/.test(w)), '跳过时给 warning', JSON.stringify(cov.warnings))
const declMismatch = E.parseEphemeris(makeE({}).replace('NumberOfEphemerisPoints ' + COUNT, 'NumberOfEphemerisPoints 999'))
ok(declMismatch.sats[0].t.length === COUNT, 'NumberOfEphemerisPoints 只作校验，不信它')
ok(declMismatch.warnings.some((w) => /999/.test(w)), '点数不符给 warning')

/* ===== ⑤ 同格式回环逐位 ===== */
section('同格式回环')
const FORMATS = ['stk-e', 'ccsds-oem-kvn', 'ccsds-oem-xml']
const src = E.parseEphemeris(makeE({})).sats
for (const fmt of FORMATS) {
  const txt = E.serializeEphemeris(src, fmt, { createdMs: T0 })
  ok(E.detectFormat(txt) === fmt, fmt + '：自家产物能被嗅探出来', E.detectFormat(txt))
  const back = E.parseEphemeris(txt)
  ok(back.format === fmt && !back.errors.length, fmt + '：回读无错', JSON.stringify(back.errors))
  ok(back.sats.length === 1 && back.sats[0].t.length === COUNT, fmt + '：点数一致')
  let dt = 0, dp = 0, dv = 0
  for (let i = 0; i < COUNT; i++) {
    dt = Math.max(dt, Math.abs(back.sats[0].t[i] - src[0].t[i]))
    for (let c = 0; c < 3; c++) {
      dp = Math.max(dp, Math.abs(back.sats[0].p[3 * i + c] - src[0].p[3 * i + c]))
      dv = Math.max(dv, Math.abs(back.sats[0].v[3 * i + c] - src[0].v[3 * i + c]))
    }
  }
  ok(dt <= 0.001, fmt + '：时间回环到 μs（差 ' + dt + ' ms）')
  ok(dp <= 1e-9, fmt + '：位置回环到 1e-9 km（差 ' + dp + '）')
  ok(dv <= 1e-9, fmt + '：速度回环到 1e-9 km/s（差 ' + dv + '）')
  // 再导出一次要与上一次逐字节相同（序列化是幂等的）
  ok(E.serializeEphemeris(back.sats, fmt, { createdMs: T0 }) === txt, fmt + '：二次导出逐字节相同')
}

/* ===== ⑥ 跨帧回环 <= 1 m ===== */
section('跨帧回环')
const tabSrc = EI.buildTable(Object.assign({}, src[0], { interp: src[0].interp }))
for (const fmt of FORMATS) {
  for (const frame of ['TEME', 'J2000', 'FIXED']) {
    const txt = E.serializeEphemeris(src, fmt, { frame, createdMs: T0 })
    const back = E.parseEphemeris(txt)
    ok(!back.errors.length, fmt + ' / ' + frame + '：回读无错', JSON.stringify(back.errors))
    const tab2 = EI.buildTable(Object.assign({}, back.sats[0], { interp: back.sats[0].interp }))
    let worst = 0
    for (let s = 30; s < (COUNT - 1) * STEP; s += 37) {
      const a = EI.evalTable(tabSrc, T0 + s * 1000), b = EI.evalTable(tab2, T0 + s * 1000)
      worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 1000)
    }
    ok(worst <= 1, fmt + ' / ' + frame + '：跨帧回环 <= 1 m（实得 ' + worst.toFixed(4) + ' m）')
  }
}

/* ===== ⑦ OEM：多段 / COMMENT 无等号 / 协方差 ===== */
section('OEM 细节')
function makeOemKvn(segs, extra) {
  const L = ['CCSDS_OEM_VERS = 2.0', 'COMMENT 这一行没有等号，是 KVN 的老坑', 'CREATION_DATE = ' + T.formatCcsds(T0), 'ORIGINATOR = TEST']
  for (const sg of segs) {
    L.push('', 'META_START', 'COMMENT 段内也可能有 COMMENT', 'OBJECT_NAME = ' + (sg.name || 'SAT-A'), 'OBJECT_ID = ' + (sg.id || '2026-001A'),
      'CENTER_NAME = EARTH', 'REF_FRAME = ' + (sg.frame || 'EME2000'), 'TIME_SYSTEM = ' + (sg.tsys || 'UTC'),
      'START_TIME = ' + T.formatCcsds(T0 + sg.from * 1000), 'STOP_TIME = ' + T.formatCcsds(T0 + sg.to * 1000),
      'INTERPOLATION = LAGRANGE', 'INTERPOLATION_DEGREE = 5', 'META_STOP', '')
    for (let s = sg.from; s <= sg.to; s += STEP) {
      const q = truth(s)
      L.push([T.formatCcsds(T0 + s * 1000), f9(q.x), f9(q.y), f9(q.z), f9(q.vx), f9(q.vy), f9(q.vz)].join(' '))
    }
    if (extra === 'cov') L.push('COVARIANCE_START', 'EPOCH = ' + T.formatCcsds(T0), '1.0 2.0 3.0', '4.0 5.0 6.0', 'COVARIANCE_STOP')
  }
  return L.join('\n') + '\n'
}
const one = E.parseEphemeris(makeOemKvn([{ from: 0, to: 600 }]))
ok(one.format === 'ccsds-oem-kvn' && !one.errors.length, 'OEM KVN 单段解析', JSON.stringify(one.errors))
ok(one.sats.length === 1 && one.sats[0].t.length === 11, 'OEM KVN 单段 11 点', String(one.sats[0] && one.sats[0].t.length))
ok(one.sats[0].name === 'SAT-A' && one.sats[0].objectId === '2026-001A', 'OBJECT_NAME / OBJECT_ID')
ok(one.sats[0].interp.samples === 6, 'INTERPOLATION_DEGREE 5 -> 6 点')
const covOem = E.parseEphemeris(makeOemKvn([{ from: 0, to: 600 }], 'cov'))
ok(covOem.sats[0].t.length === 11, '协方差块跳过，点数不变', String(covOem.sats[0].t.length))
const twoSeg = E.parseEphemeris(makeOemKvn([{ from: 0, to: 600 }, { from: 3600, to: 4200 }]))
ok(twoSeg.sats.length === 1, '同一 OBJECT_ID 的两段归并成一颗星', String(twoSeg.sats.length))
ok(twoSeg.sats[0].t.length === 22, '两段共 22 点', String(twoSeg.sats[0].t.length))
ok(twoSeg.sats[0].spans && twoSeg.sats[0].spans.length === 2, '带出两段的 spans')
const segTab = EI.buildTable(Object.assign({}, twoSeg.sats[0], { interp: twoSeg.sats[0].interp }))
ok(EI.evalTable(segTab, T0 + 300000) !== null, '第一段内有值')
ok(EI.evalTable(segTab, T0 + 2000000) === null, '两段之间的缝 -> null')
const twoSat = E.parseEphemeris(makeOemKvn([{ from: 0, to: 600, id: '2026-001A' }, { from: 0, to: 600, id: '2026-002B', name: 'SAT-B' }]))
ok(twoSat.sats.length === 2, '不同 OBJECT_ID = 两颗星', String(twoSat.sats.length))
// 时间系统
const gpsOem = E.parseEphemeris(makeOemKvn([{ from: 0, to: 120, tsys: 'GPS' }]))
near((gpsOem.sats[0].t[0] - T0) / 1000, -18, 1e-6, 'TIME_SYSTEM = GPS 换算 -18 s')
const badTsys = E.parseEphemeris(makeOemKvn([{ from: 0, to: 120, tsys: 'LOCAL' }]))
ok(badTsys.errors.some((e) => /LOCAL/.test(e)), '未知时间系统拒收并点名', JSON.stringify(badTsys.errors))
const badFrame = E.parseEphemeris(makeOemKvn([{ from: 0, to: 120, frame: 'MARSIAU' }]))
ok(badFrame.errors.some((e) => /MARSIAU/.test(e)), '未知参考系拒收并点名', JSON.stringify(badFrame.errors))
// 帧名映射
for (const [raw, want] of [['EME2000', 'J2000'], ['ICRF', 'J2000'], ['GCRF', 'J2000'], ['TEME', 'TEME'], ['TOD', 'TOD'], ['ITRF2014', 'FIXED'], ['ITRF2020', 'FIXED'], ['EFG', 'FIXED']]) {
  ok(E.oemFrame(raw) === want, 'REF_FRAME ' + raw + ' -> ' + want, E.oemFrame(raw))
}

/* ===== ⑧ BOM ===== */
section('BOM')
const BOM = '﻿'
for (const fmt of FORMATS) {
  const txt = E.serializeEphemeris(src, fmt, { createdMs: T0 })
  ok(E.detectFormat(BOM + txt) === fmt, fmt + '：detectFormat 剥 BOM', E.detectFormat(BOM + txt))
  const b = E.parseEphemeris(BOM + txt)
  ok(b.format === fmt && b.sats.length === 1, fmt + '：带 BOM 仍解出 1 颗', b.format + ' / ' + b.sats.length)
}

/* ===== ⑨ 坏输入不炸 ===== */
section('坏输入')
const JUNK = ['', '   ', 'hello world', ' ', 'stk.v.12.0', 'BEGIN Ephemeris\nEND Ephemeris',
  'CCSDS_OEM_VERS = 3.0', '<oem></oem>', 'stk.v.12.0\nBEGIN Ephemeris\nCoordinateSystem J2000\nEphemerisTimePosVel\nabc def\nEND Ephemeris']
for (const j of JUNK) {
  let threw = null
  try { const r = E.parseEphemeris(j); ok(Array.isArray(r.sats), '坏输入返回结构体：' + JSON.stringify(j.slice(0, 24))) }
  catch (e) { threw = e }
  ok(!threw, '坏输入不抛异常：' + JSON.stringify(j.slice(0, 24)), threw && threw.message)
}
ok(E.detectFormat('random text') === '', '认不出返回空串')
ok(E.parseEphemeris('random text').errors.length > 0, '认不出给错误行')
let sThrew = false
try { E.serializeEphemeris([], 'stk-e') } catch { sThrew = true }
ok(sThrew, '空数组导出抛可读错误')
let fThrew = false
try { E.serializeEphemeris(src, 'nope') } catch (e) { fThrew = /未知导出格式/.test(e.message) }
ok(fThrew, '未知格式导出抛可读错误')

/* ===== ⑩ 格式清单 ===== */
section('格式清单')
ok(E.FORMATS.length === 4 && E.FORMATS.includes('sp3'), '四种格式 id')
for (const f of E.FORMATS) { ok(!!E.FORMAT_LABEL[f], f + ' 有中文名'); ok(!!E.FORMAT_EXT[f], f + ' 有扩展名') }

console.log('\nephemFormats: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
