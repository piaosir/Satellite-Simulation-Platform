// 日凌引擎 v5.2 两档新口径（utils/sunOutageCalculator.js + utils/orbitSource.js）：
//   星历档（params.orbit → SGP4 两级采样 + 日内插值）与纯几何档（criterion:'geometric'）。
// 金标准 test/sunOutage.test.mjs 对拍的是定轨档，本文件只管新增的两档、ctx 缓存与返回形状。
// ★ 本文件不许放宽金标准，也不许改夹具——定轨档路径逐位不变是这次改造的前提。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { parseOMMCsv } from '../../../src/viz/constellation/tle.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { calculateSunOutage, calculateSunOutageSeasons } = require('../utils/sunOutageCalculator.js')
const { orbitSource, jdToMs } = require('../utils/orbitSource.js')
const sat = require('../vendor/satellite.js')

const sec = (s) => { const [h, m, x] = s.split(':').map(Number); return h * 3600 + m * 60 + x }
const SIDEREAL_SEC = 86164.0905          // 一个恒星日：经度差 → 时角差的换算

// —— 取一颗受控 GEO：随包内置的 GEO 组快照（568 条，历元 2026-09-15/16）——
const csv = gunzipSync(readFileSync(path.join(HERE, '../../../resources/omm/csv_geo.csv.gz'))).toString('utf8')
const pool = parseOMMCsv(csv)
// CelesTrak 把中星编目成 ZHONGXING-6C（不是 CHINASAT 6C）；找不到就退回第一颗近赤道 GEO
const omm = pool.find((s) => s.name === 'ZHONGXING-6C')
  || pool.find((s) => Math.abs(Number(s.incl)) < 0.1 && Math.abs(Number(s.meanMotion) - 1.00273896) < 0.02)
assert.ok(omm, 'GEO 快照里找不到可用的受控 GEO')

const specOf = (s, over) => Object.assign({
  type: 'omm', noradId: s.noradId, epoch: s.epoch,
  meanMotion: Number(s.meanMotion), ecc: Number(s.ecc), incl: Number(s.incl),
  raan: Number(s.raan), argp: Number(s.argp), ma: Number(s.ma),
  bstar: Number(s.bstar), mdot: Number(s.mdot), mddot: Number(s.mddot)
}, over || {})
const SPEC = specOf(omm)

// 历元处星下点经度（与 src/shared/geoSlot.js geoLonAtEpoch 同一算法）
const recEp = sat.omm2satrec(omm)
const dEp = new Date(Date.parse(omm.epoch))
const SLOT = sat.degreesLong(sat.eciToGeodetic(sat.propagate(recEp, dEp).position, sat.gstime(dEp)).longitude)

// 北京 / Ku / 2.4 m，2026 秋分（分点 09-23，与历元只差 7 天）
const BASE = { lat: 39.9042, lon: 116.4074, diameter: 2.4, band: 'Ku', customFreq: 12.5, sysTemp: 150, year: 2026, season: 'autumnal', degThreshold: 1 }

/* ── 2. 星历 vs 定轨一致性 ───────────────────────────────────────────────
 * ★ 任务书原估「峰值时刻差 ≤ 120 s」是按「卫星停在历元轨位不动」估的，实测 204 s：
 *   这颗星的平均运动 1.00269682 rev/day 比恒星日慢，东西漂移 −0.0152°/天，而北京站的
 *   秋季日凌落在 10-07~10-11（站→星方向赤纬为负，太阳要等到分点后半个月才走到），
 *   距历元 21~25 天 → 卫星已西漂 0.55~0.75°，换成时角就是 130~180 s。这是星历档要算出来的
 *   物理量本身，不是插值误差。所以这里把上界放到 300 s，另加一条真正的不变式：
 *   峰值时刻差应当等于「经度差 → 时角差」，偏差 ≤ 60 s（余量留给太阳自身的运动与倾角摆动）。
 */
{
  const slot = calculateSunOutage({ ...BASE, satLon: SLOT })
  const eph = calculateSunOutage({ ...BASE, orbit: SPEC })
  assert.equal(slot.error, false)
  assert.equal(eph.error, false)
  assert.equal(slot.satSource, 'slot')
  assert.equal(eph.satSource, 'ephemeris')
  assert.equal(eph.model.noradId, String(omm.noradId))
  assert.ok(Math.abs(eph.totalDays - slot.totalDays) <= 1, `天数 ${eph.totalDays} vs ${slot.totalDays}`)

  let worstDt = 0, worstDb = 0, worstResid = 0, shared = 0
  for (const r of eph.dailyResults) {
    const q = slot.dailyResults.find((z) => z.date === r.date)
    if (!q) continue
    shared++
    const dt = sec(r.peakTimeUTC) - sec(q.peakTimeUTC)
    worstDt = Math.max(worstDt, Math.abs(dt))
    worstDb = Math.max(worstDb, Math.abs(r.peakCNdeg - q.peakCNdeg))
    // 卫星比定轨轨位偏西 Δlon → 太阳要多转 Δlon 才对上，峰值时刻晚 Δlon/360×恒星日
    const expect = (SLOT - r.satLon) / 360 * SIDEREAL_SEC
    worstResid = Math.max(worstResid, Math.abs(dt - expect))
  }
  assert.ok(shared >= 3, '两档共有的事件日太少：' + shared)
  assert.ok(worstDt <= 300, `峰值时刻差 ${worstDt}s`)
  assert.ok(worstDb <= 0.2, `峰值恶化差 ${worstDb.toFixed(3)} dB`)
  assert.ok(worstResid <= 60, `时刻差与经度漂移不相符，残差 ${worstResid.toFixed(0)}s`)
  console.log(`  星历 vs 定轨：共有 ${shared} 天，峰值时刻差 ≤ ${worstDt}s（扣掉经度漂移后残差 ${worstResid.toFixed(0)}s）、恶化差 ≤ ${worstDb.toFixed(3)} dB`)
}

/* ── 插值保真：60 s 细表插值 vs 逐秒 propagate ─────────────────────────
 * 「不许逐秒算 SGP4」这条口径能成立，全靠这一条：倾角 5° 的 GSO，60 s 线性插值的位置误差
 * 不到 10 m，从 42 000 km 外看是 1e-5° 量级，比求根容差 0.5 s 对应的太阳位移（≈0.002°）小两个量级。
 */
{
  const src = orbitSource(specOf(omm, { incl: 5 }))
  const dayJD = Math.floor(2461336) + 0.5
  const base = jdToMs(dayJD)
  const fine = []
  for (let i = 0; i <= 1440; i++) fine.push(src.posEcefKm(base + i * 60000))
  let maxKm = 0
  for (let s = 0; s < 86400; s += 37) {
    const x = s / 60, i0 = Math.min(1439, Math.floor(x)), fr = x - i0
    const A = fine[i0], B = fine[i0 + 1]
    const t = src.posEcefKm(base + s * 1000)
    maxKm = Math.max(maxKm, Math.hypot(
      A[0] + (B[0] - A[0]) * fr - t[0],
      A[1] + (B[1] - A[1]) * fr - t[1],
      A[2] + (B[2] - A[2]) * fr - t[2]))
  }
  const degErr = maxKm / 42164 * 180 / Math.PI
  assert.ok(maxKm < 0.05, `60 s 插值位置误差 ${maxKm.toFixed(4)} km`)
  assert.ok(degErr < 2e-4, `60 s 插值视角误差 ${degErr.toExponential(2)}°`)
  console.log(`  60 s 插值（倾角 5°）：位置误差 ≤ ${(maxKm * 1000).toFixed(1)} m → 视角 ${degErr.toExponential(2)}°`)
}

/* ── 3. 倾斜 GSO 差异 ─────────────────────────────────────────────────
 * 倾角 0.05° → 5°，其余根数不动：星下点赤纬一天摆 ±5°，日凌落在完全不同的日子。
 * 任务书写的是「至少有一天峰值时刻差 > 60 s」；实测两档连事件日期都不重合（定轨 10-07~10-11、
 * 倾斜 10-20~10-23），那是比时刻差更强的差异，这里按「日期集合不同 或 有一天时刻差 > 60 s」判。
 */
{
  const slot = calculateSunOutage({ ...BASE, satLon: SLOT })
  const tilt = calculateSunOutage({ ...BASE, orbit: specOf(omm, { incl: 5 }) })
  assert.equal(tilt.error, false)
  assert.ok(tilt.totalDays > 0, '倾斜 GSO 应仍有日凌事件')
  assert.ok(Math.abs(tilt.model.inclDeg - 5) < 1e-3, 'model.inclDeg = ' + tilt.model.inclDeg)
  const dSlot = new Set(slot.dailyResults.map((d) => d.date))
  const dTilt = new Set(tilt.dailyResults.map((d) => d.date))
  const sameDates = dSlot.size === dTilt.size && [...dSlot].every((d) => dTilt.has(d))
  const bigShift = tilt.dailyResults.some((r) => {
    const q = slot.dailyResults.find((z) => z.date === r.date)
    return q && Math.abs(sec(r.peakTimeUTC) - sec(q.peakTimeUTC)) > 60
  })
  assert.ok(!sameDates || bigShift, '倾角 5° 的结果与定轨档没有可见差异')
  console.log(`  倾角 5°：${tilt.totalDays} 天（${tilt.dailyResults[0].date} 起），定轨档 ${slot.totalDays} 天（${slot.dailyResults[0].date} 起）`)
}

/* ── 4. 非同步轨道拒算 ───────────────────────────────────────────────── */
{
  const r = calculateSunOutage({ ...BASE, orbit: specOf(omm, { meanMotion: 2 }) })
  assert.equal(r.error, true)
  assert.match(r.message, /GSO/)
}

/* ── 5. 纯几何档 ─────────────────────────────────────────────────────── */
{
  const deg = calculateSunOutage({ ...BASE, satLon: SLOT })
  const geo = calculateSunOutage({ ...BASE, satLon: SLOT, criterion: 'geometric' })
  assert.equal(geo.error, false)
  assert.equal(geo.model.criterion, 'geometric')
  assert.equal(geo.model.thresholdAngleSource, 'beamwidth')
  assert.equal(deg.model.thresholdAngleSource, 'degradation')
  assert.equal(geo.thresholdAngle, geo.beamWidth, '门限角应恒等于 3dB 波束宽')
  assert.equal(geo.model.degThreshold, 1, 'degThreshold 在几何档下不参与定窗，但要原样回显')
  for (const d of geo.dailyResults) {
    assert.equal(d.thresholdDeg, geo.beamWidth, d.date + ' 每日门限角')
    assert.ok(d.peakSeparation <= d.thresholdDeg + 1e-9, d.date + ' 峰值夹角越界')
  }
  // 两档的日期集合是子集/超集关系，逐日时长同向
  const narrower = geo.beamWidth < deg.thresholdAngle
  const dg = new Set(deg.dailyResults.map((d) => d.date))
  const gg = new Set(geo.dailyResults.map((d) => d.date))
  const [small, big] = narrower ? [gg, dg] : [dg, gg]
  for (const d of small) assert.ok(big.has(d), '日期集合不是子集：' + d)
  for (const g of geo.dailyResults) {
    const q = deg.dailyResults.find((z) => z.date === g.date)
    if (!q) continue
    if (narrower) assert.ok(g.durationSec <= q.durationSec + 1, g.date + ' 几何档时长应更短')
    else assert.ok(g.durationSec >= q.durationSec - 1, g.date + ' 几何档时长应更长')
  }
  console.log(`  纯几何：θ_th = θ_3dB = ${geo.beamWidth}°（恶化门限档 ${deg.thresholdAngle}°），${geo.totalDays} 天 / ${deg.totalDays} 天`)
}

/* ── 6. 批量：seasons 选择 + ctx 轨迹缓存 ────────────────────────────── */
{
  const one = calculateSunOutageSeasons({ ...BASE, satLon: SLOT, seasons: ['vernal'] })
  assert.ok(one.vernal && one.vernal.error === false)
  assert.equal(one.autumnal, null)
  const both = calculateSunOutageSeasons({ ...BASE, satLon: SLOT })
  assert.ok(both.vernal && both.autumnal, '不传 seasons 应回两季')
  assert.equal(both.vernal.seasonName, '春分')
  assert.equal(both.autumnal.seasonName, '秋分')

  const ctx = { satTrack: new Map(), orbitSource: orbitSource(SPEC) }
  const t0 = process.hrtime.bigint()
  const r1 = calculateSunOutage({ ...BASE, orbit: SPEC }, ctx)
  const ms1 = Number(process.hrtime.bigint() - t0) / 1e6
  const t1 = process.hrtime.bigint()
  const r2 = calculateSunOutage({ ...BASE, lat: 43.8256, lon: 87.6168, orbit: SPEC }, ctx)   // 乌鲁木齐
  const ms2 = Number(process.hrtime.bigint() - t1) / 1e6
  assert.equal(r1.error, false)
  assert.equal(r2.error, false)
  assert.ok(ms2 < ms1 * 0.3, `轨迹缓存未生效：首站 ${ms1.toFixed(0)} ms、次站 ${ms2.toFixed(0)} ms`)
  console.log(`  ctx 轨迹缓存：首站 ${ms1.toFixed(0)} ms → 次站 ${ms2.toFixed(0)} ms`)
}

/* ── 7. 返回形状：定轨档除新增字段外与改前逐键相同 ───────────────────── */
{
  const OLD_TOP = ['error', 'seasonName', 'equinoxDate', 'beamWidth', 'thresholdAngle', 'satAz', 'satEl',
    'frequency', 'totalDays', 'startDate', 'endDate', 'maxDurationSec', 'maxDurationStr',
    'peakRecord', 'dailyResults', 'model']
  const NEW_TOP = ['satSource', 'satLonEff', 'coverageDays']
  const OLD_MODEL = ['degThreshold', 'sysTemp', 'solarTemp', 'solarTempSource', 'f107', 'diameter',
    'beamWidth3dB', 'sunDiameter', 'boresightDeg']
  const NEW_MODEL = ['satSource', 'noradId', 'epoch', 'epochAgeDays', 'inclDeg', 'ephemSpan', 'criterion', 'thresholdAngleSource']
  const OLD_DAY = ['date', 'dateBJT', 'startTimeUTC', 'endTimeUTC', 'peakTimeUTC', 'startTimeBJT', 'endTimeBJT',
    'peakTimeBJT', 'durationSec', 'durationStr', 'peakSeparation', 'peakCNdeg', 'thresholdDeg',
    'intensity', 'intensityClass', 'isPeak']

  const r = calculateSunOutage({ ...BASE, satLon: SLOT })
  assert.deepEqual(Object.keys(r).sort(), [...OLD_TOP, ...NEW_TOP].sort())
  assert.deepEqual(Object.keys(r.model).sort(), [...OLD_MODEL, ...NEW_MODEL].sort())
  assert.deepEqual(Object.keys(r.dailyResults[0]).sort(), OLD_DAY.slice().sort())
  assert.equal(r.model.satSource, 'slot')
  assert.equal(r.model.noradId, null)
  assert.equal(r.model.ephemSpan, null)
  assert.equal(r.coverageDays, 61)
  assert.equal(r.satLonEff, SLOT)

  // 星历档：逐日多一列 satLon
  const e = calculateSunOutage({ ...BASE, orbit: SPEC })
  assert.deepEqual(Object.keys(e.dailyResults[0]).sort(), [...OLD_DAY, 'satLon'].sort())

  // JSON 往返：不许有 NaN / undefined / 函数（IPC 要过结构化克隆）
  for (const x of [r, e]) {
    const round = JSON.parse(JSON.stringify(x))
    assert.deepEqual(round, JSON.parse(JSON.stringify(round)))
    const walk = (o, at) => {
      for (const [k, v] of Object.entries(o)) {
        assert.ok(typeof v !== 'function', at + k + ' 是函数')
        assert.ok(v !== undefined, at + k + ' 是 undefined')
        assert.ok(typeof v !== 'number' || Number.isFinite(v), at + k + ' 是 NaN/Infinity')
        if (v && typeof v === 'object') walk(v, at + k + '.')
      }
    }
    walk(x, '')
    assert.doesNotThrow(() => structuredClone(x))
  }
}

/* ── 8. 轨道源缝：假源 = 理想 GEO 常量位置 → 与定轨档逐日相同 ──────────
 * 这条既证明「两级采样 + 插值」这条路径本身不引入误差，也钉死引擎对轨道源的依赖
 * 只有 summary / span / posEcefKm / lonAt 这几个成员（换成别的实现不必改引擎）。
 */
const R_GEO = 42164.17
const idealGeo = (lonDeg) => {
  const lo = lonDeg * Math.PI / 180
  return [R_GEO * Math.cos(lo), R_GEO * Math.sin(lo), 0]
}
const fakeSource = (lonDeg, span) => ({
  kind: 'ephem',
  summary: { periodMin: 1436.07, inclDeg: 0, ecc: 0, epochIso: '2026-01-01T00:00:00.000Z' },
  span: span || null,
  posEcefKm: (ms) => (span && (ms < span.startMs || ms > span.endMs) ? null : idealGeo(lonDeg)),
  lonAt: (ms) => (span && (ms < span.startMs || ms > span.endMs) ? NaN : lonDeg)
})
{
  const LON = 130.5
  const slot = calculateSunOutage({ ...BASE, satLon: LON })
  const fake = calculateSunOutage({ ...BASE, orbit: { type: 'ephem', noradId: 'FAKE' } }, { orbitSource: fakeSource(LON) })
  assert.equal(fake.error, false)
  assert.equal(fake.satSource, 'ephemeris')
  assert.equal(fake.totalDays, slot.totalDays, '假源天数应与定轨档相同')
  assert.equal(fake.coverageDays, 61)
  for (let i = 0; i < slot.dailyResults.length; i++) {
    const a = slot.dailyResults[i], b = fake.dailyResults[i]
    assert.equal(b.date, a.date)
    for (const k of ['startTimeUTC', 'peakTimeUTC', 'endTimeUTC']) {
      assert.ok(Math.abs(sec(b[k]) - sec(a[k])) <= 1, `${a.date} ${k} 差 ${sec(b[k]) - sec(a[k])}s`)
    }
    assert.ok(Math.abs(b.peakCNdeg - a.peakCNdeg) <= 0.01 + 1e-9, a.date + ' 恶化差')
  }
  console.log(`  假源（理想 GEO 常量位置）：${fake.totalDays} 天与定轨档逐日一致`)
}

/* ── 9. 覆盖区间：区间外采样返回 null → 只算区间内的天 ──────────────── */
{
  const probe = calculateSunOutage({ ...BASE, satLon: 130.5 })
  // 分点日 UT 零时的 JD（引擎的扫描基准）→ 覆盖分点日前后各 10 天（末日要采到次日 0 时，故 +11）
  const eqDayMs = Date.parse(probe.equinoxDate + 'T00:00:00Z')
  const span = { startMs: eqDayMs - 10 * 86400e3, endMs: eqDayMs + 11 * 86400e3 }
  const r = calculateSunOutage({ ...BASE, orbit: { type: 'ephem' } }, { orbitSource: fakeSource(130.5, span) })
  assert.equal(r.error, false)
  assert.equal(r.coverageDays, 21, 'coverageDays = ' + r.coverageDays)
  assert.deepEqual(r.model.ephemSpan, { start: new Date(span.startMs).toISOString(), end: new Date(span.endMs).toISOString() })

  // 上面那段区间不含北京站的事件日（秋季日凌落在分点后半个月），事件截断要另找一段覆盖事件的区间才验得到：
  // 覆盖「首个事件日 − 1 天 ~ 峰值日」，看事件是否被如实截掉一头
  const pk = probe.peakRecord.date, d0 = probe.dailyResults[0].date
  const span2 = { startMs: Date.parse(d0 + 'T00:00:00Z') - 86400e3, endMs: Date.parse(pk + 'T00:00:00Z') + 86400e3 }
  const r2 = calculateSunOutage({ ...BASE, orbit: { type: 'ephem' } }, { orbitSource: fakeSource(130.5, span2) })
  assert.equal(r2.error, false)
  assert.ok(r2.totalDays > 0 && r2.totalDays < probe.totalDays, `截断后事件 ${r2.totalDays} 天（全程 ${probe.totalDays} 天）`)
  for (const d of r2.dailyResults) {
    const t = Date.parse(d.date + 'T00:00:00Z')
    assert.ok(t >= span2.startMs && t + 86400e3 <= span2.endMs, '事件日落在覆盖区间外：' + d.date)
    const q = probe.dailyResults.find((z) => z.date === d.date)
    assert.ok(Math.abs(sec(d.peakTimeUTC) - sec(q.peakTimeUTC)) <= 1, d.date + ' 区间内的天应与全程一致')
  }
  console.log(`  覆盖区间：61 天里 ${r.coverageDays} 天有星历；截到 ${r2.coverageDays} 天时事件由 ${probe.totalDays} 天减到 ${r2.totalDays} 天，区间内逐日不变`)
}

/* ── 10. 性能读数（只打印，不断言——机器差异大） ─────────────────────── */
{
  const t0 = process.hrtime.bigint()
  calculateSunOutage({ ...BASE, satLon: SLOT })
  const msSlot = Number(process.hrtime.bigint() - t0) / 1e6
  const ctx = { satTrack: new Map(), orbitSource: orbitSource(SPEC) }
  const t1 = process.hrtime.bigint()
  calculateSunOutage({ ...BASE, orbit: SPEC }, ctx)
  const msFirst = Number(process.hrtime.bigint() - t1) / 1e6
  const t2 = process.hrtime.bigint()
  calculateSunOutage({ ...BASE, orbit: SPEC }, ctx)
  const msHit = Number(process.hrtime.bigint() - t2) / 1e6
  console.log(`  耗时：定轨 ${msSlot.toFixed(1)} ms/季 · 星历首算 ${msFirst.toFixed(0)} ms · 缓存命中 ${msHit.toFixed(0)} ms`)
}

console.log('sunOutageModes: 星历档 / 纯几何档 / ctx 缓存 / 返回形状 / 轨道源缝 全部通过')
