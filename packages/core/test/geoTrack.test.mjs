// GSO 倾斜运行 / 保持盒（差距分析 A-01）：packages/core/utils/geoTrack.js 与 GSO 链路引擎的接入。
//
// 【外部真值 / 对拍】
//   ① A 路 exp5（docs/research/gap-2026-10-17/A/exp5_inclined.cjs）：北京看 110.5°E、i = 1°、e = 3e-4 的 SDP4 星
//      ——视线偏 1.11°、斜距日变 161 km、12 GHz 多普勒 ±236 Hz、1.2 m Ku（12.5 GHz）固定天线 7.5 dB；
//      保持盒 i = 0.05°：13 m Ku（14 GHz）2.7–2.8 dB。这里把同一颗 SDP4 星逐分钟采样当星历喂进来，同物同比。
//   ② H 路 zx9（docs/research/gap-2026-10-17/H/zx9.cjs）：随包 GEO 快照里的中星 9 号（i = 0.97°）→ 1.2 m Ku（12 GHz）6.46 dB。
//   ③ 解析几何：站在星下点时，纯倾角的视线偏离 = atan(a·sin i / (a·cos i − R))；纯偏心率的最大距离变化率 = √(μ/p)·e。
//   ④ 引擎：缺省（定点 + 固定）结果逐位不变、新出参全空、详细预算不多一行；倾斜时指向损耗计入链路且级联逐行闭合。

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

/* ===== ⑤ GSO 链路引擎 ===== */
section('⑤ GSO 链路引擎')
const q = (f) => { const e = console.error, l = console.log; console.error = console.log = () => {}; try { return f() } finally { console.error = e; console.log = l } }
{
  const SAT = { frequencyBand: 'Ku', satelliteName: 'DEMO' }
  const r0 = q(() => core.calculateLinkBudget(SAT, {}))
  const zeros = q(() => core.calculateLinkBudget({ ...SAT, geoIncl: '0', geoEcc: '0', geoBoxEW: '0' }, { trackMode: '固定', trackResidual: '0', rxTrackMode: '固定', rxTrackResidual: '0.3' }))
  ok(r0.success && JSON.stringify(r0) === JSON.stringify(zeros), '★ 缺省 / 显式定点 + 固定（残差在固定方式下不生效）：结果逐位相同')
  const NEW_KEYS = ['uplinkPointingLossResult', 'downlinkPointingLossResult', 'elevationMinResult', 'rxElevationMaxResult', 'linkDelayMinResult', 'maxDopplerUplinkResult', 'downlinkPointingLossP1Result']
  ok(NEW_KEYS.every((k) => r0.data[k] === ''), '缺省时倾斜运行出参一律留空')
  ok(r0.data.uplinkMiscLossResult === '0.300' && r0.data.downlinkMiscLossResult === '0.300', '「其他损耗」出参仍是输入值（指向损耗不并进这一格）')
  const rows0 = wf.buildWaterfallSegments({ results: r0.data, orbitType: 'GEO' }).flatMap((s) => s.rows)
  ok(!rows0.some((x) => /指向|日内|多普勒/.test(x.key)), '缺省时详细预算不多出任何一行')

  // 中星 9 号式倾斜运行（92.2°E、i = 0.97°、e = 9e-4），收信站 1.2 m Ku 12 GHz 固定天线
  const S9 = { ...SAT, orbitPosition: '92.2', geoIncl: '0.97', geoEcc: '0.0009' }
  const L9 = { rxAntennaDiameter: '1.2', rxCenterFrequency: '12' }
  const r9 = q(() => core.calculateLinkBudget(S9, L9)).data
  const d9 = Number(r9.downlinkPointingLossResult)
  ok(Math.abs(d9 - 6.59) < 0.05, `★ 收信站 1.2 m Ku 固定：下行指向损耗（日最大）${d9} dB 计入链路（中星 9 号快照星历 6.46 dB）`)
  ok(Number(r9.uplinkPointingLossResult) > 20, `发信站 6.2 m Ku 固定天线：上行 ${r9.uplinkPointingLossResult} dB（出主瓣，须用跟踪天线）`)
  const rFix = q(() => core.calculateLinkBudget({ ...SAT, orbitPosition: '92.2' }, L9)).data
  ok(Number(r9.paRecommendation) > Number(rFix.paRecommendation) * 100, `设置余量：同一条链路功放建议 ${rFix.paRecommendation} → ${r9.paRecommendation} W`)
  const rTrk = q(() => core.calculateLinkBudget(S9, { ...L9, trackMode: '程控', trackResidual: '0.02' })).data
  const th3up = 70 * (0.299792458 / 14.25) / 6.2
  ok(Math.abs(Number(rTrk.uplinkPointingLossResult) - 12 * (0.02 / th3up) ** 2) < 1e-3, `发信站改程控跟踪（残差 0.02°）：上行指向损耗 ${rTrk.uplinkPointingLossResult} dB`)
  ok(Number(r9.rxElevationMinResult) < Number(r9.rxElevationResult) && Number(r9.rxElevationMaxResult) > Number(r9.rxElevationResult), `日内仰角 ${r9.rxElevationMinResult}…${r9.rxElevationMaxResult}° 夹住标称 ${r9.rxElevationResult}°`)
  ok(Number(r9.linkDelayMinResult) < Number(r9.linkDelayResult) && Number(r9.linkDelayMaxResult) > Number(r9.linkDelayResult) && Number(r9.maxDopplerDownlinkResult) > 0.2, `一跳时延 ${r9.linkDelayMinResult}…${r9.linkDelayMaxResult} ms、下行多普勒 ±${r9.maxDopplerDownlinkResult} kHz`)
  // 详细预算：级联里单列「指向损耗（日最大）」，逐行仍闭合到引擎的上 / 下行 C/(N+I)
  const segs = wf.buildWaterfallSegments({ results: r9, orbitType: 'GEO' })
  const cas = segs.find((s) => s.id === 'cascade').rows
  const pt = cas.filter((x) => x.label === '指向损耗（日最大）')
  ok(pt.length === 2 && pt[0].num === Number(Number(r9.uplinkPointingLossResult).toFixed(2)) && pt[1].numDown === Number(d9.toFixed(2)), '级联上 / 下行各多一行「指向损耗（日最大）」')
  const upTh = cas.find((x) => x.label === '上行 C/N（热噪声）'), dnTh = cas.find((x) => x.label === '下行 C/N（热噪声）')
  ok(Math.abs(upTh.num - Number(r9.uplinkThermalCN)) < 0.02 && Math.abs(dnTh.numDown - Number(r9.downlinkThermalCN)) < 0.02, `级联逐行闭合：上行热噪 C/N ${upTh.num} / 引擎 ${r9.uplinkThermalCN}，下行 ${dnTh.numDown} / 引擎 ${r9.downlinkThermalCN}`)
  const geo = segs.find((s) => s.id === 'geometry').rows.map((x) => x.key), prop = segs.find((s) => s.id === 'propagation').rows.map((x) => x.key)
  ok(['日内最低仰角', '日内最高仰角', '日内最近斜距', '日内最远斜距', '日内最大指向偏离'].every((k) => geo.includes(k)) && ['指向损耗（日最大）', '指向损耗（50% 时间）', '指向损耗（1% 时间）'].every((k) => prop.includes(k)), '几何段 / 传播段出日内范围与损耗分位')
  const en = wf.buildWaterfallSegments({ results: r9, orbitType: 'GEO', lang: 'en' }).flatMap((s) => s.rows).filter((x) => /指向|日内|多普勒|时延\(日内/.test(x.key))
  ok(en.length > 0 && en.every((x) => !/[一-龥]/.test(x.label)), '英文详细预算：新行全有译名')
  // 求解器 / 批量反复调同一组入参：几何只算一次
  const t = Date.now()
  for (let k = 0; k < 100; k++) q(() => core.calculateLinkBudget(S9, L9))
  ok(Date.now() - t < 500, `同一组入参 100 次引擎调用 ${Date.now() - t} ms（日内轨迹按入参缓存）`)
}

/* ===== ⑥ 资源库字段与自动命名 ===== */
section('⑥ 资源库字段')
{
  const f = (arr, k) => arr.find((x) => x.key === k)
  ok(['geoIncl', 'geoEcc', 'geoBoxEW'].every((k) => f(P.SAT_FIELDS, k) && f(P.SAT_FIELDS, k).target === 'sat' && f(P.SAT_FIELDS, k).def === '0' && typeof f(P.SAT_FIELDS, k).max === 'number'), '卫星库：倾角 / 偏心率 / 东西保持 ±（卫星实体，缺省 0，带范围）')
  const tm = f(P.ES_COMMON_FIELDS, 'trackMode'), tr = f(P.ES_COMMON_FIELDS, 'trackResidual')
  ok(tm && tm.rxKey === 'rxTrackMode' && tm.def === '固定' && tr && tr.rxKey === 'rxTrackResidual' && tr.unit === '°', '地球站库：跟踪方式 / 跟踪残差（收发共用一面天线，收侧引擎键 rx*）')
  ok(!tr.showIf({ trackMode: '固定' }) && tr.showIf({ trackMode: '程控' }), '跟踪残差只在跟踪方式非「固定」时显示')
  const satForm = { ...P.defaultsFor(P.SAT_FIELDS), geoIncl: '0.97' }
  const txEs = { ...P.defaultsFor(P.ES_FIELDS), trackMode: '程控', trackResidual: '0.02' }
  const rxEs = { ...P.defaultsFor(P.ES_FIELDS), trackMode: '单脉冲', trackResidual: '0.01' }
  const bp = P.buildParams(satForm, P.defaultsFor(P.CARRIER_FIELDS), P.defaultsFor(P.TX_FIELDS), P.defaultsFor(P.RX_FIELDS), txEs, rxEs)
  ok(bp.satParams.geoIncl === '0.97' && bp.linkParams.trackMode === '程控' && bp.linkParams.trackResidual === '0.02' && bp.linkParams.rxTrackMode === '单脉冲' && bp.linkParams.rxTrackResidual === '0.01', '组装：卫星三项进 satParams，两站各自的跟踪方式 / 残差进 linkParams（发 = 键、收 = rx 键）')
  ok(AN.esAutoName({ antennaDiameter: '13', trackMode: '程控' }) === '13 m · 程控' && AN.esAutoName({ antennaDiameter: '13', trackMode: '固定' }) === '13 m' && AN.esAutoName({ antennaDiameter: '6.2' }) === '6.2 m', '地球站自动名：跟踪天线带跟踪方式，固定 / 老条目逐字不变')
  ok(AN.satAutoName({ form: { satelliteName: 'CHINASAT 9', frequencyBand: 'Ku', orbitPosition: '92.2', geoIncl: '0.97' } }) === 'CHINASAT 9 · Ku · 92.2°E · i=0.97°' &&
    AN.satAutoName({ form: { satelliteName: 'CHINASAT 9', frequencyBand: 'Ku', orbitPosition: '92.2', geoIncl: '0' } }) === 'CHINASAT 9 · Ku · 92.2°E', '卫星自动名：倾斜运行星轨位后缀倾角，定点逐字不变')
}

console.log('\ngeoTrack: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
