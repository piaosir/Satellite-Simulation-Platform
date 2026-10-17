// GSO 倾斜运行 / 保持盒（差距分析 A-01）：packages/core/utils/geoTrack.js 的纯算法，与 GSO 窗口「指向误差」工具的合成口径。
//
// 【外部真值 / 对拍】
//   ① A 路 exp5（docs/research/gap-2026-10-17/A/exp5_inclined.cjs）：北京看 110.5°E、i = 1°、e = 3e-4 的 SDP4 星
//      ——视线偏 1.11°、斜距日变 161 km、12 GHz 多普勒 ±236 Hz、1.2 m Ku（12.5 GHz）固定天线 7.5 dB；
//      保持盒 i = 0.05°：13 m Ku（14 GHz）2.7–2.8 dB。这里把同一颗 SDP4 星逐分钟采样当星历喂进来，同物同比。
//   ② H 路 zx9（docs/research/gap-2026-10-17/H/zx9.cjs）：随包 GEO 快照里的中星 9 号（i = 0.97°）→ 1.2 m Ku（12 GHz）6.46 dB。
//   ③ 解析几何：站在星下点时，纯倾角的视线偏离 = atan(a·sin i / (a·cos i − R))；纯偏心率的最大距离变化率 = √(μ/p)·e。
//   ④ 资源库与引擎：倾角 / 偏心率 / 东西保持 ±、跟踪方式 / 残差已撤出（回到 v1.5.3），引擎不读、残留键不改任何出参。
//   ⑤ 「指向误差」工具：θ(t) = √(θ_main(t)² + Σθ_i²)（rssDeg），gsoPointingBudget 与 linkGeoTrack 同一套几何。

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const G = require('../utils/geoTrack.js')
const sat = require('../vendor/satellite.js')
const core = require('../index.js')
const wf = require('../utils/waterfallBuilder.js')
const P = await import('../../../src/linkbudget/params.js')
const AN = await import('../../../src/shared/lbAutoName.js')
const RK = await import('../../../src/shared/lbRetiredKeys.js')
const SH = await import('../../../src/shared/lbShare.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)
const DEG = Math.PI / 180
const BJ = { latDeg: 39.9, lonDeg: 116.4, altKm: 0.05 }
const T0 = Date.UTC(2026, 9, 17)
const ephOf = (rec, start) => {
  const tMs = [], ecef = []
  for (let k = 0; k <= 1440; k++) { const d = new Date(start + k * 60e3); const pv = sat.propagate(rec, d); const e = sat.eciToEcf(pv.position, sat.gstime(d)); tMs.push(d.getTime()); ecef.push([e.x, e.y, e.z]) }
  return { tMs, ecef }
}
const ant = (d) => ({ diameterM: d, efficiency: 0.65 })

/* ===== ① A 路 exp5：同一颗 SDP4 星 ===== */
section('① A 路 exp5（北京看 110.5°E，SDP4 星当星历）')
{
  const g = sat.gstime(new Date(T0)) / DEG
  const mk = (i, e) => sat.omm2satrec({ noradId: 'SIM', epoch: new Date(T0).toISOString(), meanMotion: 1.00273122, ecc: e, incl: i, raan: 0, argp: 0, ma: ((110.5 + g) % 360 + 360) % 360, bstar: 0, mdot: 0, mddot: 0 })
  const r = G.linkGeoTrack({ sat: { ephem: ephOf(mk(1, 3e-4), T0) }, tx: { ...BJ, freqGHz: 12.5, antenna: ant(1.2), tracking: {} }, rx: { ...BJ, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
  ok(Math.abs(r.tx.maxOffDeg - 1.106) < 0.005, `i = 1°：日内最大视线偏离 ${r.tx.maxOffDeg.toFixed(4)}°（exp5：1.108°，5 min 步长）`)
  ok(Math.abs(r.tx.maxRangeKm - r.tx.minRangeKm - 161.0) < 1, `斜距日变 ${(r.tx.maxRangeKm - r.tx.minRangeKm).toFixed(1)} km（exp5：161.0 km）`)
  ok(Math.abs(r.rx.maxDopplerHz - 236) < 4, `12 GHz 多普勒 ±${r.rx.maxDopplerHz.toFixed(0)} Hz（exp5：236 Hz）`)
  ok(Math.abs(r.tx.lossMaxDb - 7.5) < 0.1, `★ 1.2 m Ku（12.5 GHz）固定天线日最大指向损耗 ${r.tx.lossMaxDb.toFixed(2)} dB（exp5：7.5 dB）`)
  ok(r.tx.lossP50Db < r.tx.lossP1Db && r.tx.lossP1Db <= r.tx.lossMaxDb, `时间分位：50% ${r.tx.lossP50Db.toFixed(2)} ≤ 1% ${r.tx.lossP1Db.toFixed(2)} ≤ 最大 ${r.tx.lossMaxDb.toFixed(2)} dB`)
  const box = G.linkGeoTrack({ sat: { ephem: ephOf(mk(0.05, 3e-4), T0) }, tx: { ...BJ, freqGHz: 14, antenna: ant(13), tracking: {} } })
  ok(box.tx.lossMaxDb > 2.6 && box.tx.lossMaxDb < 2.9, `★ 保持盒 i = 0.05°：13 m Ku（14 GHz）固定天线 ${box.tx.lossMaxDb.toFixed(2)} dB（exp5：2.7–2.8 dB）`)
}

/* ===== ② H 路 zx9：随包快照里的中星 9 号 ===== */
section('② H 路 zx9（中星 9 号快照星历）')
{
  const here = fileURLToPath(new URL('.', import.meta.url))
  const csv = gunzipSync(readFileSync(here + '../../../resources/omm/csv_geo.csv.gz')).toString('utf8').split(/\r?\n/)
  const head = csv[0].split(',')
  const line = csv.find((x) => x.startsWith('ZHONGXING-9,'))
  ok(!!line, '快照里有 ZHONGXING-9')
  if (line) {
    const c = line.split(','), o = {}
    head.forEach((k, i) => { o[k] = c[i] })
    const rec = sat.omm2satrec({ noradId: o.NORAD_CAT_ID, epoch: o.EPOCH, meanMotion: +o.MEAN_MOTION, ecc: +o.ECCENTRICITY, incl: +o.INCLINATION, raan: +o.RA_OF_ASC_NODE, argp: +o.ARG_OF_PERICENTER, ma: +o.MEAN_ANOMALY, bstar: +o.BSTAR, mdot: +o.MEAN_MOTION_DOT, mddot: +o.MEAN_MOTION_DDOT })
    const r = G.linkGeoTrack({ sat: { ephem: ephOf(rec, Date.UTC(2026, 9, 16)) }, tx: { ...BJ, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
    ok(Math.abs(r.tx.lossMaxDb - 6.46) < 0.05, `★ 1.2 m Ku（12 GHz）日最大指向损耗 ${r.tx.lossMaxDb.toFixed(3)} dB（zx9：6.46 dB）`)
    ok(Math.abs(r.tx.minElevDeg - 36.70) < 0.02 && Math.abs(r.tx.maxElevDeg - 38.52) < 0.02, `北京仰角 ${r.tx.minElevDeg.toFixed(3)}…${r.tx.maxElevDeg.toFixed(3)}°（zx9：36.696…38.519°）`)
    // 合成二体轨道（卫星库三项的口径）：同 i / e、日平均经度取快照星下点经度中点 92.34°E
    const s = G.linkGeoTrack({ sat: { lonDeg: 92.34, inclDeg: +o.INCLINATION, ecc: +o.ECCENTRICITY }, tx: { ...BJ, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
    ok(Math.abs(s.tx.lossMaxDb - r.tx.lossMaxDb) < 0.2, `合成二体轨道（i = ${(+o.INCLINATION).toFixed(2)}°、e = ${(+o.ECCENTRICITY).toExponential(2)}）${s.tx.lossMaxDb.toFixed(3)} dB，与真星历差 < 0.2 dB`)
  }
}

/* ===== ③ 解析几何（站在星下点） ===== */
section('③ 解析几何')
{
  const a = G.A_GEO, R = 6378.137
  for (const i of [0.05, 1, 3]) {
    const r = G.linkGeoTrack({ sat: { lonDeg: 100, inclDeg: i, ecc: 0 }, tx: { latDeg: 0, lonDeg: 100, altKm: 0, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
    const want = Math.atan2(a * Math.sin(i * DEG), a * Math.cos(i * DEG) - R) / DEG
    ok(Math.abs(r.tx.maxOffDeg - want) < 2e-4 * Math.max(1, want), `纯倾角 ${i}°：星下点站视线最大偏离 ${r.tx.maxOffDeg.toFixed(5)}°（解析 ${want.toFixed(5)}°）`)
  }
  const e = 3e-4
  const r = G.linkGeoTrack({ sat: { lonDeg: 100, inclDeg: 0, ecc: e }, tx: { latDeg: 0, lonDeg: 100, altKm: 0, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
  const rdot = Math.sqrt(398600.4418 / (a * (1 - e * e))) * e
  ok(Math.abs(r.tx.maxRangeRateKmS / rdot - 1) < 0.005, `纯偏心率 e = 3e-4：最大距离变化率 ${(r.tx.maxRangeRateKmS * 1000).toFixed(3)} m/s（√(μ/p)·e = ${(rdot * 1000).toFixed(3)} m/s）`)
  ok(Math.abs(r.tx.maxRangeKm - r.tx.minRangeKm - 2 * a * e) < 0.05, `径向摆幅 ${(r.tx.maxRangeKm - r.tx.minRangeKm).toFixed(2)} km（2·a·e = ${(2 * a * e).toFixed(2)} km）`)
  // 保持盒：两边各算一遍取差的那边，偏离不小于盒宽在站上的张角
  const b = G.linkGeoTrack({ sat: { lonDeg: 100, inclDeg: 0, ecc: 0, boxDeg: 0.1 }, tx: { latDeg: 0, lonDeg: 100, altKm: 0, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
  const wantBox = Math.atan2(a * Math.sin(0.1 * DEG), a * Math.cos(0.1 * DEG) - R) / DEG
  ok(Math.abs(b.tx.maxOffDeg - wantBox) < 1e-4, `东西保持 ±0.1°（无倾角偏心）：最差那天偏离 ${b.tx.maxOffDeg.toFixed(5)}°（盒边张角 ${wantBox.toFixed(5)}°）`)
}

/* ===== ④ 跟踪方式与方向图 ===== */
section('④ 跟踪方式与方向图')
{
  const base = { sat: { lonDeg: 110.5, inclDeg: 1, ecc: 3e-4 } }
  const th3 = 70 * (0.299792458 / 14) / 13
  const prog = G.linkGeoTrack({ ...base, tx: { ...BJ, freqGHz: 14, antenna: ant(13), tracking: { mode: '程控', residualDeg: 0.02 } } })
  const want = 12 * (0.02 / th3) ** 2
  ok(Math.abs(prog.tx.lossMaxDb - want) < 1e-12 && prog.tx.lossP50Db === prog.tx.lossMaxDb && prog.tx.maxOffDeg === 0.02, `程控跟踪残差 0.02°：损耗恒为 12·(θ/θ3dB)² = ${want.toFixed(4)} dB（与卫星怎么动无关）`)
  for (const m of ['步进', 'step', '单脉冲', 'monopulse', 'program']) ok(G.trackMode(m) !== 'fixed', `跟踪方式「${m}」认得出`)
  ok(G.trackMode('') === 'fixed' && G.trackMode('固定') === 'fixed' && G.trackMode('乱写') === 'fixed', '空 / 固定 / 认不出 → 固定')
  const fix13 = G.linkGeoTrack({ ...base, tx: { ...BJ, freqGHz: 14, antenna: ant(13), tracking: {} } })
  const am = G.antennaModel(ant(13), 14)
  ok(fix13.tx.lossMaxDb > 25 && fix13.tx.lossMaxDb < 40, `13 m 固定天线遇 1° 倾斜星：出主瓣按附录 8 旁瓣包络封顶 ${fix13.tx.lossMaxDb.toFixed(1)} dB（高斯式会报 ${(12 * (fix13.tx.maxOffDeg / am.theta3dBDeg) ** 2).toFixed(0)} dB）`)
  ok(Math.abs(G.pointingLossDb(0.5 * am.theta3dBDeg, am) - 3) < 1e-12, '主瓣内：半个 θ3dB 处 3 dB（高斯主瓣）')
  const tab = { theta3dBDeg: 1, patternTable: [[0, 0], [0.5, -3], [1, -12], [3, -30]] }
  ok(Math.abs(G.pointingLossDb(0.75, tab) - 7.5) < 1e-12 && G.pointingLossDb(5, tab) === 30, '站有方向图：按表线性插值、表外取末值')
  const al = G.linkGeoTrack({ ...base, alignMin: 0, tx: { ...BJ, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
  const mean = G.linkGeoTrack({ ...base, tx: { ...BJ, freqGHz: 12, antenna: ant(1.2), tracking: {} } })
  ok(al.tx.maxOffDeg > mean.tx.maxOffDeg, `对准某一刻（alignMin）比对准日平均指向偏得多：${al.tx.maxOffDeg.toFixed(3)}° > ${mean.tx.maxOffDeg.toFixed(3)}°`)
}

/* ===== ⑤ GSO 链路引擎：不读倾斜运行 / 跟踪键 ===== */
section('⑤ GSO 链路引擎')
const q = (f) => { const e = console.error, l = console.log; console.error = console.log = () => {}; try { return f() } finally { console.error = e; console.log = l } }
// v1.5.4 引擎接入时多出的出参（撤出后一个都不该再有）
const RETIRED_OUT = ['uplinkPointingLossResult', 'downlinkPointingLossResult', 'uplinkPointingLossP50Result', 'uplinkPointingLossP1Result',
  'downlinkPointingLossP50Result', 'downlinkPointingLossP1Result', 'uplinkPointingOffsetResult', 'downlinkPointingOffsetResult',
  'elevationMinResult', 'elevationMaxResult', 'rxElevationMinResult', 'rxElevationMaxResult', 'slantRangeMinResult', 'slantRangeMaxResult',
  'rxSlantRangeMinResult', 'rxSlantRangeMaxResult', 'linkDelayMinResult', 'linkDelayMaxResult', 'maxDopplerUplinkResult', 'maxDopplerDownlinkResult']
{
  const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO', orbitPosition: '92.2' }
  const L = { rxAntennaDiameter: '1.2', rxCenterFrequency: '12' }
  const r0 = q(() => core.calculateLinkBudget(SAT, L))
  // 老库里的残留键（非缺省值）：中星 9 号式倾斜运行 + 两站跟踪
  const stale = q(() => core.calculateLinkBudget({ ...SAT, geoIncl: '0.97', geoEcc: '0.0009', geoBoxEW: '0.05' },
    { ...L, trackMode: '程控', trackResidual: '0.02', rxTrackMode: '单脉冲', rxTrackResidual: '0.01' }))
  ok(r0.success && JSON.stringify(r0) === JSON.stringify(stale), '★ 残留的倾角 / 偏心率 / 东西保持 / 跟踪方式 / 跟踪残差不进引擎：结果逐位相同')
  ok(RETIRED_OUT.every((k) => !(k in r0.data)), '倾斜运行那批出参（指向损耗 / 日内仰角 / 斜距 / 时延范围 / 多普勒）不再出')
  ok(r0.data.uplinkMiscLossResult === '0.300' && r0.data.downlinkMiscLossResult === '0.300', '「其他损耗」只是输入值')
  const segs = wf.buildWaterfallSegments({ results: r0.data, orbitType: 'GEO' })
  ok(!segs.flatMap((x) => x.rows).some((x) => /指向|日内/.test(x.key + x.label)), '详细预算没有指向损耗 / 日内范围行')
  // 拿 v1.5.4 存下的结果（带那批出参）重出详细预算：也不出那几行
  const old = { ...r0.data, uplinkPointingLossResult: '31.2', downlinkPointingLossResult: '6.59', elevationMinResult: '36.7', linkDelayMaxResult: '250.1' }
  const segsOld = wf.buildWaterfallSegments({ results: old, orbitType: 'GEO' })
  ok(JSON.stringify(segsOld) === JSON.stringify(segs), 'v1.5.4 存下的结果里残留的那批出参：详细预算逐字不变（不出行、级联不扣）')
}

/* ===== ⑥ 资源库字段、自动命名与残留键（回到 v1.5.3） ===== */
section('⑥ 资源库字段与残留键')
{
  const has = (arr, k) => arr.some((x) => x.key === k)
  ok(!['geoIncl', 'geoEcc', 'geoBoxEW'].some((k) => has(P.SAT_FIELDS, k)), '卫星库没有倾角 / 偏心率 / 东西保持 ±')
  ok(!['trackMode', 'trackResidual'].some((k) => has(P.ES_FIELDS, k)), '地球站库没有跟踪方式 / 跟踪残差')
  const satForm = { ...P.defaultsFor(P.SAT_FIELDS), geoIncl: '0.97' }
  const txEs = { ...P.defaultsFor(P.ES_FIELDS), trackMode: '程控', trackResidual: '0.02' }
  const bp = P.buildParams(satForm, P.defaultsFor(P.CARRIER_FIELDS), P.defaultsFor(P.TX_FIELDS), P.defaultsFor(P.RX_FIELDS), txEs, txEs)
  ok(!RK.RETIRED_FORM_KEYS.some((k) => k in bp.satParams || k in bp.linkParams), '组参：表单里的残留键不进引擎入参')
  ok(AN.esAutoName({ antennaDiameter: '13', trackMode: '程控' }) === '13 m' && AN.esAutoName({ antennaDiameter: '6.2' }) === '6.2 m', '地球站自动名只认口径（v1.5.3：「13 m」，无「· 程控」）')
  ok(AN.satAutoName({ form: { satelliteName: 'CHINASAT 9', frequencyBand: 'Ku', orbitPosition: '92.2', geoIncl: '0.97' } }) === 'CHINASAT 9 · Ku · 92.2°E', '卫星自动名不带「i=…°」（v1.5.3）')
  // 残留键：载入即剥 / 打包不带 / 指纹不认
  const f = { antennaDiameter: '13', trackMode: '程控', trackResidual: '0.02', geoIncl: '1' }
  const g = RK.withoutRetiredKeys(f)
  ok(g !== f && JSON.stringify(g) === '{"antennaDiameter":"13"}' && f.trackMode === '程控', 'withoutRetiredKeys：浅拷贝剥掉，原对象不动')
  const clean = { antennaDiameter: '13' }
  ok(RK.withoutRetiredKeys(clean) === clean && RK.stripRetiredKeys(clean) === 0, '没有残留键：原样返回同一个对象')
  ok(RK.stripRetiredKeys(f) === 3 && JSON.stringify(f) === '{"antennaDiameter":"13"}', 'stripRetiredKeys：就地剥、报剥掉几个')
  const spec = { arr: [], pack: (c) => c }
  const e154 = { id: 'es1', name: '关口站 13m', form: { antennaDiameter: '13', trackMode: '固定', trackResidual: '0' } }
  const e153 = { id: 'es1', name: '关口站 13m', form: { antennaDiameter: '13' } }
  ok(JSON.stringify(SH.packEntry(spec, e154).form) === '{"antennaDiameter":"13"}', '分享包：条目 form 不带残留键')
  ok(SH.strictFp(spec, e154) === SH.strictFp(spec, e153), '内容指纹不认残留键：v1.5.4 存过的条目与同参数的老条目认作同一份')
}

/* ===== ⑦ 「指向误差」工具：误差预算方和根 + 一站计算 ===== */
section('⑦ 指向误差工具')
{
  ok(G.rssDeg(0.3, [0.4]) === 0.5 && Math.abs(G.rssDeg(0, [0.03, 0.04]) - 0.05) < 1e-15 && G.rssDeg(0.3, [-0.4]) === 0.5, 'rssDeg：√(θ_main² + Σθ_i²)，分项按绝对值')
  const x = 1.1063217
  ok(G.rssDeg(x, []) === x && G.rssDeg(x, [0, '', null, NaN, undefined]) === x && G.rssDeg(x) === x, 'rssDeg：分项全空 / 全 0 → 主项原样（不经平方开方）')
  const STA = { latDeg: 39.9, lonDeg: 116.4, altKm: 0.05 }
  const SAT1 = { lonDeg: 110.5, inclDeg: 1, ecc: 3e-4 }
  const base = G.linkGeoTrack({ sat: SAT1, tx: { ...STA, freqGHz: 12.5, antenna: { diameterM: 1.2, efficiency: 0.65 }, tracking: {} } })
  const empty = G.linkGeoTrack({ sat: SAT1, tx: { ...STA, freqGHz: 12.5, antenna: { diameterM: 1.2, efficiency: 0.65 }, tracking: { budgetDeg: [] } } })
  ok(JSON.stringify(base.tx) === JSON.stringify(empty.tx), 'linkGeoTrack：误差分项为空时与不给逐位相同')
  const st = { ...STA, freqGHz: 12.5, diameterM: 1.2, efficiencyPct: 65 }
  const p0 = G.gsoPointingBudget({ sat: SAT1, station: st, mode: '固定' })
  ok(p0 && p0.lossMaxDb === base.tx.lossMaxDb && p0.maxOffDeg === base.tx.maxOffDeg && p0.minElevDeg === base.tx.minElevDeg && p0.maxRangeKm === base.tx.maxRangeKm && p0.maxDopplerHz === base.tx.maxDopplerHz,
    `固定、无分项：与 linkGeoTrack 同数（日最大 ${p0 && p0.lossMaxDb.toFixed(2)} dB、偏离 ${p0 && p0.maxOffDeg.toFixed(3)}°）`)
  ok(Math.abs(p0.lossMaxDb - 7.5) < 0.3, `合成轨道 i = 1°、北京、1.2 m Ku 12.5 GHz 固定：${p0.lossMaxDb.toFixed(2)} dB（exp5 SDP4 星 7.5 dB）`)
  ok(Math.abs(p0.theta3dBDeg - 70 * (0.299792458 / 12.5) / 1.2) < 1e-12, `θ3dB = 70λ/D = ${p0.theta3dBDeg.toFixed(4)}°`)
  const BUD = [0.1, 0.05, 0.08, 0.02]
  const p1 = G.gsoPointingBudget({ sat: SAT1, station: st, mode: 'fixed', budgetDeg: BUD })
  const s2 = BUD.reduce((a, v) => a + v * v, 0)
  ok(Math.abs(p1.maxOffDeg - Math.sqrt(p0.maxOffDeg ** 2 + s2)) < 1e-12, `固定 + 四项分项：最大总偏离 = √(主项最大² + Σθ_i²) = ${p1.maxOffDeg.toFixed(4)}°`)
  ok(p1.lossMaxDb > p0.lossMaxDb && p1.lossP50Db > p0.lossP50Db && p1.lossP1Db > p0.lossP1Db && p1.lossP50Db <= p1.lossP1Db && p1.lossP1Db <= p1.lossMaxDb,
    `分项抬高损耗：日最大 ${p0.lossMaxDb.toFixed(2)} → ${p1.lossMaxDb.toFixed(2)} dB、50% ${p1.lossP50Db.toFixed(2)} ≤ 1% ${p1.lossP1Db.toFixed(2)} ≤ 最大`)
  ok(p1.minElevDeg === p0.minElevDeg && p1.maxRangeKm === p0.maxRangeKm && p1.maxDopplerHz === p0.maxDopplerHz, '分项不碰几何：仰角 / 斜距 / 多普勒不变')
  // 定点星：主项恒 0，只剩分项
  const fixSat = { lonDeg: 110.5, inclDeg: 0, ecc: 0, boxDeg: 0 }
  const p2 = G.gsoPointingBudget({ sat: fixSat, station: st, mode: '固定', budgetDeg: [0.03, 0.04] })
  const want2 = 12 * (0.05 / p2.theta3dBDeg) ** 2
  ok(Math.abs(p2.maxOffDeg - 0.05) < 1e-12 && Math.abs(p2.lossMaxDb - want2) < 1e-9 && p2.lossP50Db === p2.lossMaxDb && p2.lossP1Db === p2.lossMaxDb, `定点星 + 分项 0.03° / 0.04°：偏离恒 0.05°、损耗恒 12·(θ/θ3dB)² = ${want2.toFixed(4)} dB`)
  ok(p2.maxDopplerHz === 0 && p2.minElevDeg === p2.maxElevDeg && p2.minRangeKm === p2.maxRangeKm, '定点星：多普勒 0、仰角 / 斜距无日变')
  // 步进跟踪：主项 = 跟踪残差（与卫星怎么动无关），几何照算
  const p3 = G.gsoPointingBudget({ sat: SAT1, station: { ...st, freqGHz: 14, diameterM: 9 }, mode: '步进跟踪', residualDeg: 0.02, budgetDeg: [0.01] })
  const th3 = 70 * (0.299792458 / 14) / 9, th = Math.sqrt(0.02 ** 2 + 0.01 ** 2)
  ok(Math.abs(p3.maxOffDeg - th) < 1e-15 && Math.abs(p3.lossMaxDb - 12 * (th / th3) ** 2) < 1e-12 && p3.lossP1Db === p3.lossMaxDb, `步进跟踪残差 0.02° + 风载 0.01°：偏离恒 ${th.toFixed(5)}°、损耗 ${p3.lossMaxDb.toFixed(4)} dB`)
  ok(p3.maxDopplerHz > 200 && p3.maxElevDeg - p3.minElevDeg > 1, `步进跟踪：日内仰角 ${p3.minElevDeg.toFixed(2)}…${p3.maxElevDeg.toFixed(2)}°、多普勒 ${p3.maxDopplerHz.toFixed(0)} Hz 照算`)
  const p3r = G.gsoPointingBudget({ sat: SAT1, station: { ...st, freqGHz: 14, diameterM: 9 }, mode: '固定', residualDeg: 0.02, budgetDeg: [0.01] })
  ok(p3r.maxOffDeg > 1, '固定方式下「跟踪残差」不计入')
  // 东西保持：取盒边两天里差的那边
  const p4 = G.gsoPointingBudget({ sat: { lonDeg: 110.5, inclDeg: 0.05, ecc: 0, boxDeg: 0.05 }, station: { ...st, freqGHz: 14, diameterM: 13 }, mode: '固定' })
  const p4c = G.gsoPointingBudget({ sat: { lonDeg: 110.5, inclDeg: 0.05, ecc: 0, boxDeg: 0 }, station: { ...st, freqGHz: 14, diameterM: 13 }, mode: '固定' })
  ok(p4.maxOffDeg > p4c.maxOffDeg && p4.lossMaxDb > p4c.lossMaxDb, `东西保持 ±0.05°：13 m Ku 偏离 ${p4c.maxOffDeg.toFixed(4)} → ${p4.maxOffDeg.toFixed(4)}°、损耗 ${p4c.lossMaxDb.toFixed(2)} → ${p4.lossMaxDb.toFixed(2)} dB`)
  // 速查表：主瓣内高斯，出主瓣附录 8 封顶
  const qk = p0.quick
  const at = (k) => qk.find((r) => r.ratio === k)
  ok(qk.length === 10 && Math.abs(at(0.5).lossDb - 3) < 1e-12 && Math.abs(at(1).lossDb - 12) < 1e-12 && Math.abs(at(0.5).thetaDeg - 0.5 * p0.theta3dBDeg) < 1e-15, '速查表：θ/θ3dB = 0.5 → 3 dB、1 → 12 dB')
  ok(at(2).lossDb < 48 && at(2).lossDb > at(1.5).lossDb - 5, `速查表：2·θ3dB 处按附录 8 旁瓣封顶 ${at(2).lossDb.toFixed(1)} dB（高斯式 48 dB）`)
  ok(qk.every((r, i) => i === 0 || r.thetaDeg > qk[i - 1].thetaDeg), '速查表档位按偏离角升序')
  // 入参不成立 → null
  const bad = (patch) => G.gsoPointingBudget({ sat: SAT1, station: { ...st, ...patch } })
  ok(bad({ diameterM: 0 }) === null && bad({ freqGHz: '' }) === null && bad({ efficiencyPct: 0 }) === null && bad({ efficiencyPct: 120 }) === null && bad({ latDeg: 91 }) === null, '口径 / 频率 / 效率 / 纬度不成立 → null')
  ok(G.gsoPointingBudget({ sat: SAT1, station: { ...st, efficiencyPct: 1 } }).g0Dbi < p0.g0Dbi - 15, '效率按百分数读（1 = 1%，不当作 100%）')
}

console.log('\ngeoTrack: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
