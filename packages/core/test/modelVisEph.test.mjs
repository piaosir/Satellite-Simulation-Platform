// 可见性分析 · 星历点序列星（entry = {eph: 表}，没有 rec）不再静默缺席 自测。运行：npm test
// 被测：src/viz/vis/visibility.js（accessWindows / computeVisibility 经 satPos.propOf 取传播体）、
//       src/viz/vis/useVisibility.js（瞬时 / 过境 / 覆盖三种模式拼 ents 时带上传播体）。
//
// 缺陷（修前）：accessWindows 只认 e.rec，useVisibility 三处拼 ents 只拷 rec —— 星历点序列星（外部星历导入 / OEM / SP3）
//   posAtMs(undefined) 恒为 null、仰角恒 −999，在过境表 / 瞬时清单 / 覆盖热力图里一声不吭地缺席。
// 钉死的事：
//   ① 同一颗星做成 satrec 与星历点序列表（SGP4 每 30 s 一点，hermite 带速度）两份：过境窗口逐窗对上
//      （AOS / LOS ≤ 0.5 s、峰值仰角 ≤ 0.01°），瞬时仰角 / 方位 / 斜距对上。
//   ② 反证：照修前的拼法把 eph 丢掉 → 0 窗；带上 eph → 窗口与 satrec 版同数。本文件的数据真能把缺陷测出来。
//   ③ 表外不外推：星历表在时窗中途（一次过境当中）截止时，窗口一律落在表的时段内，表内完整的窗口与 satrec 版逐窗对上，
//      跨表尾的那一窗止于表尾。
//   ④ 解析真值：理想 GEO（ECEF 恒定，星历点序列表）对北京的仰角 = 直接几何算的值；24 h 过境 = 一整窗（截断）。
//   ⑤ useVisibility 三种模式：只有 eph 的星在瞬时清单、过境表（含时间覆盖 KPI）、覆盖热力图里都出现，
//      覆盖读数与同一颗星的 satrec 版一致。
// 数据全部本地自造（ephemTable.tableFrom），不联网。与本体遮挡无关（遮挡不接入可见性，2026-09-24 用户拍板）。
// 变异核对（2026-09-24）：把 visibility.js 换回修前（8903e29）→ 红 7 条（①②③④ 过境 + ⑤ 过境两条）；
//   把 useVisibility.js 换回修前 → 红 4 条（⑤ 过境 ×2 / 瞬时 / 覆盖）。两半修复各自都有用例盯着。
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import sat from '../../../src/viz/constellation/satellite.js'
import { tableFrom } from '../../../src/viz/constellation/ephemTable.js'
import { propOf } from '../../../src/viz/constellation/satPos.js'
import { accessWindows, computeVisibility } from '../../../src/viz/vis/visibility.js'
import { useVisibility } from '../../../src/viz/vis/useVisibility.js'

let pass = 0, fail = 0
const fails = []
async function T(name, fn) {
  try { await fn(); pass++; console.log('PASS  ' + name) } catch (e) { fail++; fails.push(name); console.log('FAIL  ' + name + '\n      ' + ((e && e.message) || e)) }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}（容差 ${tol}）`)
const until = async (pred, ms = 60000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('等待超时'); await new Promise((r) => setTimeout(r, 5)) } }
const JD_UNIX = 2440587.5
const jdOf = (ms) => ms / 864e5 + JD_UNIX
const D2R = Math.PI / 180

// SGP4 星 → 星历点序列表（hermite，含速度）
function sgp4Table(rec, t0, t1, dtSec = 30) {
  const n = Math.floor((t1 - t0) / (dtSec * 1000)) + 1
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * dtSec * 1000, pv = sat.propagate(rec, new Date(ms))
    t[i] = ms
    p[3 * i] = pv.position.x; p[3 * i + 1] = pv.position.y; p[3 * i + 2] = pv.position.z
    v[3 * i] = pv.velocity.x; v[3 * i + 1] = pv.velocity.y; v[3 * i + 2] = pv.velocity.z
  }
  return tableFrom({ t, p, v, method: 'hermite', samples: 6 })
}
// 理想 GEO（星历点序列表）：ECEF 恒为 R(cosλ0, sinλ0, 0)，TEME = 绕极轴转 GMST
const R_GEO = 42164.17
const OMEGA_G = (876600 * 3600 + 8640184.812866) / 240 * D2R / (36525 * 86400)   // gstime 线性项的角速率（rad/s）
function idealGeoTable(lonDeg, t0, t1, dtSec = 60) {
  const n = Math.floor((t1 - t0) / (dtSec * 1000)) + 1
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * dtSec * 1000, th = lonDeg * D2R + sat.gstime(jdOf(ms))
    t[i] = ms
    p[3 * i] = R_GEO * Math.cos(th); p[3 * i + 1] = R_GEO * Math.sin(th); p[3 * i + 2] = 0
    v[3 * i] = -OMEGA_G * R_GEO * Math.sin(th); v[3 * i + 1] = OMEGA_G * R_GEO * Math.cos(th); v[3 * i + 2] = 0
  }
  return tableFrom({ t, p, v, method: 'hermite', samples: 6 })
}

const ISS = sat.twoline2satrec(
  '1 25544U 98067A   26047.50000000  .00016717  00000-0  30264-3 0  9990',
  '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.50377579 32519')
const NOW = new Date(Date.UTC(2026, 1, 16, 12, 0, 0))
const BJ = { lat: 39.9042, lon: 116.4074 }
const base = NOW.getTime(), H = 24 * 3600
const tab = sgp4Table(ISS, base - 3600e3, base + (H + 3600) * 1000)
const times = { now: NOW, ccNow: NOW }
const recEnt = { rec: ISS, name: 'ISS', noradId: 25544, group: 'g' }
const ephEnt = { eph: tab, name: 'ISS', noradId: 25544, group: 'ci:x' }
const winsOf = (ents, targets = [BJ], h = H) => { const r = accessWindows(ents, targets, times, h, 5, { coarseSec: 90 }); return r.length ? r[0].windows : [] }
const recWins = winsOf([recEnt])

// ══════════════════════ ① 同星两种传播体：过境 / 瞬时对上 ══════════════════════
await T('① 只有 eph 的 entry：过境窗口 = 同星 satrec 版（AOS/LOS ≤ 0.5 s、峰值仰角 ≤ 0.01°）', () => {
  assert.equal(propOf(ephEnt), tab, 'propOf 取到的是星历表')
  const b = winsOf([ephEnt])
  assert.ok(recWins.length >= 3, `satrec 版至少 3 窗（${recWins.length}）`)
  assert.equal(b.length, recWins.length, '窗数')
  let dA = 0, dL = 0, dE = 0
  for (let i = 0; i < recWins.length; i++) {
    near(b[i].startMs, recWins[i].startMs, 500, `第 ${i} 窗 AOS`); near(b[i].endMs, recWins[i].endMs, 500, `第 ${i} 窗 LOS`)
    near(b[i].peakEl, recWins[i].peakEl, 0.01, `第 ${i} 窗峰值仰角`)
    assert.equal(b[i].truncated, recWins[i].truncated)
    dA = Math.max(dA, Math.abs(b[i].startMs - recWins[i].startMs)); dL = Math.max(dL, Math.abs(b[i].endMs - recWins[i].endMs)); dE = Math.max(dE, Math.abs(b[i].peakEl - recWins[i].peakEl))
  }
  console.log(`      ${recWins.length} 窗 · AOS 最大差 ${dA.toFixed(1)} ms · LOS 最大差 ${dL.toFixed(1)} ms · 峰值仰角最大差 ${dE.toExponential(2)}°`)
})
await T('① 混合集（satrec 星 + eph 星）：两颗都进过境表，eph 星的窗口与 satrec 星逐窗同刻', () => {
  const r = accessWindows([recEnt, { ...ephEnt, name: 'ISS-EPH', noradId: 'E1' }], [BJ], times, H, 5, { coarseSec: 90 })
  assert.deepEqual(r.map((s) => s.name).sort(), ['ISS', 'ISS-EPH'])
  const a = r.find((s) => s.name === 'ISS').windows, b = r.find((s) => s.name === 'ISS-EPH').windows
  assert.equal(a.length, b.length)
  for (let i = 0; i < a.length; i++) near(b[i].startMs, a[i].startMs, 500, 'AOS')
})
await T('① 瞬时：eph 星在过境峰值时刻出现在可见清单（仰角 / 方位 ≤ 0.01°、斜距 ≤ 0.05 km）', () => {
  const w = recWins[0], t = new Date(w.peakMs)
  const tt = { now: t, gmst: sat.gstime(t), ccNow: t, ccGmst: sat.gstime(t) }
  const ra = computeVisibility([recEnt], [BJ], tt, 5), rb = computeVisibility([ephEnt], [BJ], tt, 5)
  assert.equal(ra.length, 1); assert.equal(rb.length, 1, 'eph 星在可见清单里')
  near(rb[0].elevDeg, ra[0].elevDeg, 0.01, 'elev'); near(rb[0].azDeg, ra[0].azDeg, 0.01, 'az'); near(rb[0].rangeKm, ra[0].rangeKm, 0.05, 'range')
  near(rb[0].subLat, ra[0].subLat, 0.01, 'subLat'); near(rb[0].altKm, ra[0].altKm, 0.05, 'altKm')
  assert.equal(rb[0].rising, ra[0].rising, '升 / 降')
})

// ══════════════════════ ② 反证：把 eph 去掉就 0 窗 ══════════════════════
await T('② 反证：照修前的拼法只拷 rec（eph 丢了）→ 0 窗、瞬时不在清单；带上 eph → 与 satrec 版同数', () => {
  const src = [ephEnt]
  const before = src.map((e) => ({ rec: e.rec, name: e.name, noradId: e.noradId, group: e.group }))            // 修前 useVisibility 的拼法
  const after = src.map((e) => ({ rec: e.rec, eph: e.eph, name: e.name, noradId: e.noradId, group: e.group }))  // 现拼法
  assert.equal(accessWindows(before, [BJ], times, H, 5, { coarseSec: 90 }).length, 0, '丢了 eph：过境表里没有这颗星')
  assert.equal(winsOf(after).length, recWins.length, '带上 eph：窗口与 satrec 版同数')
  const t = new Date(recWins[0].peakMs), tt = { now: t, gmst: sat.gstime(t), ccNow: t, ccGmst: sat.gstime(t) }
  assert.equal(computeVisibility(before, [BJ], tt, 5).length, 0, '丢了 eph：瞬时清单里没有')
  assert.equal(computeVisibility(after, [BJ], tt, 5).length, 1, '带上 eph：瞬时清单里有')
})

// ══════════════════════ ③ 表外不外推 ══════════════════════
await T('③ 星历表在一次过境当中截止：窗口全落在表时段内；表内完整的窗口与 satrec 版逐窗对上；跨表尾那窗止于表尾；表外的窗口不出现', () => {
  const cut = recWins[1], t1 = Math.round((cut.startMs + cut.endMs) / 2)   // 第 2 窗正中截止
  const short = sgp4Table(ISS, base - 3600e3, t1)
  const b = winsOf([{ ...ephEnt, eph: short }])
  const inside = recWins.filter((w) => w.endMs < t1 - 1000)
  assert.equal(inside.length, 1, '表内完整的只有第 1 窗')
  assert.ok(b.every((w) => w.startMs >= short.t0 && w.endMs <= short.t1 + 1000), '窗口落在表时段内')
  assert.equal(b.length, 2, `窗数 ${b.length}（表内完整 1 窗 + 跨表尾 1 窗）`)
  near(b[0].startMs, inside[0].startMs, 500, 'AOS'); near(b[0].endMs, inside[0].endMs, 500, 'LOS')
  near(b[1].startMs, cut.startMs, 500, '跨表尾那窗的 AOS'); near(b[1].endMs, short.t1, 1000, '跨表尾那窗止于表尾')
})

// ══════════════════════ ④ 解析真值：理想 GEO ══════════════════════
const LON0 = 110
const geoTab = idealGeoTable(LON0, base - 3600e3, base + (H + 3600) * 1000)
const geoEnt = { eph: geoTab, name: 'GEO-IDEAL', noradId: 'G0', group: 'ci:t' }
// 直接几何：ECEF 星位与站点 look angle（与星历表、插值、propOf 全无关）
const geoLook = (st) => sat.ecfToLookAngles({ longitude: st.lon * D2R, latitude: st.lat * D2R, height: 0 }, { x: R_GEO * Math.cos(LON0 * D2R), y: R_GEO * Math.sin(LON0 * D2R), z: 0 })
await T('④ 理想 GEO（只有 eph）：瞬时仰角 / 方位 = 直接几何（≤ 1e-4°），斜距 ≤ 1e-3 km', () => {
  const lk = geoLook(BJ)
  for (const dh of [0, 5.5, 17.25]) {
    const t = new Date(base + dh * 3600e3), tt = { now: t, gmst: sat.gstime(t), ccNow: t, ccGmst: sat.gstime(t) }
    const r = computeVisibility([geoEnt], [BJ], tt, 5)
    assert.equal(r.length, 1, `+${dh} h 在清单里`)
    near(r[0].elevDeg, lk.elevation / D2R, 1e-4, `+${dh} h elev`)
    near(r[0].azDeg, ((lk.azimuth / D2R) + 360) % 360, 1e-4, `+${dh} h az`)
    near(r[0].rangeKm, lk.rangeSat, 1e-3, `+${dh} h range`)
    assert.equal(r[0].rising, null, '静止星不分升降')
    near(r[0].subLon, LON0, 1e-6, 'subLon')
  }
})
await T('④ 理想 GEO（只有 eph）：24 h 过境 = 一整窗（截断），峰值仰角 = 直接几何', () => {
  const r = accessWindows([geoEnt], [BJ], times, H, 5, { coarseSec: 90 })
  assert.equal(r.length, 1); const w = r[0].windows
  assert.equal(w.length, 1, '一整窗'); assert.equal(w[0].truncated, true)
  assert.equal(w[0].startMs, base); assert.equal(w[0].endMs, base + H * 1000)
  near(w[0].peakEl, geoLook(BJ).elevation / D2R, 1e-4, 'peakEl')
})

// ══════════════════════ ⑤ useVisibility 三种模式 ══════════════════════
const station = { id: 's1', name: '测试站', lat: BJ.lat, lon: BJ.lon }
const mkVis = (set, calcAt = () => NOW) => {
  const v = useVisibility({
    getStations: () => [station], getPoints: () => [], getTrajectories: () => [], getPolys: () => [],
    getSatSet: () => set, calcAt, ccTimeAt: (t) => t, isCustomEntry: () => false, refresh: () => {}
  })
  v.openPanel(); v.setTarget('station', 's1')
  return v
}
await T('⑤ 过境模式：只有 eph 的星（ISS 表 / 理想 GEO）都进过境表，窗口 = 直接调 accessWindows；GEO 在 → 时间覆盖 100 %', async () => {
  const vis = mkVis([recEnt, { ...ephEnt, name: 'ISS-EPH', noradId: 'E1' }, geoEnt])
  vis.setMode('access'); vis.horizonH.value = 24
  await nextTick()
  vis.computeAccess()
  await until(() => !vis.accessBusy.value)
  const rs = vis.accessResults.value
  assert.deepEqual(rs.map((s) => s.name).sort(), ['GEO-IDEAL', 'ISS', 'ISS-EPH'])
  assert.equal(vis.accessScanned.value, 3, '三颗都过了粗筛')
  const eph = rs.find((s) => s.name === 'ISS-EPH').windows
  assert.equal(eph.length, recWins.length)
  for (let i = 0; i < eph.length; i++) near(eph[i].startMs, recWins[i].startMs, 500, 'AOS')
  near(vis.accessKpi.value.pct, 100, 1e-9, '时间覆盖')
  assert.equal(vis.accessKpi.value.sats, 3)
  vis.close()
})
await T('⑤ 过境模式 · 只有 eph 星的集：不再报「没有过境」', async () => {
  const vis = mkVis([ephEnt])
  vis.setMode('access'); vis.horizonH.value = 24
  await nextTick()
  vis.computeAccess()
  await until(() => !vis.accessBusy.value)
  assert.equal(vis.accessResults.value.length, 1)
  assert.equal(vis.accessMsg.value, '')
  assert.equal(vis.accessResults.value[0].windows.length, recWins.length)
  vis.close()
})
await T('⑤ 瞬时模式：只有 eph 的星在清单里，读数与 satrec 版一致；KPI 计数含它', async () => {
  const tPeak = new Date(recWins[0].peakMs)
  const vis = mkVis([{ ...ephEnt, name: 'ISS-EPH', noradId: 'E1' }, geoEnt], () => tPeak)
  vis.setMode('now')
  await nextTick()
  vis.recompute()
  const names = vis.results.value.map((r) => r.name).sort()
  assert.deepEqual(names, ['GEO-IDEAL', 'ISS-EPH'])
  assert.equal(vis.kpi.value.count, 2)
  const ra = computeVisibility([recEnt], [BJ], { now: tPeak, gmst: sat.gstime(tPeak), ccNow: tPeak, ccGmst: sat.gstime(tPeak) }, 5)[0]
  near(vis.results.value.find((r) => r.name === 'ISS-EPH').elevDeg, ra.elevDeg, 0.01, 'elev')
  const spec = vis.overlaySpec()
  assert.ok(spec && spec.sats.length === 2, '地图叠加画两颗')
  vis.close()
})
await T('⑤ 覆盖模式：只有 eph 星的集画得出覆盖（ents 的 rec 放传播体），读数与同星 satrec 版一致', async () => {
  const cov = async (set) => {
    const vis = mkVis(set)
    vis.setMode('coverage')
    vis.covRegionKind.value = 'bounds'; vis.covLatMin.value = 20; vis.covLatMax.value = 55; vis.covLonMin.value = 80; vis.covLonMax.value = 140
    vis.covStep.value = 5; vis.covHorizonH.value = 24; vis.covSample.value = 60
    vis.computeCoverage()
    await until(() => !vis.covBusy.value)
    const d = vis.covData.value, k = vis.covKpi.value
    vis.close()
    return { d, k }
  }
  const a = await cov([recEnt]), b = await cov([ephEnt])
  assert.ok(a.d && b.d, '两份都有结果')
  assert.ok(Array.from(a.d.fom.simple).some((v) => v > 0), 'satrec 版有被覆盖的格（数据本身测得出）')
  assert.ok(Array.from(b.d.fom.simple).some((v) => v > 0), 'eph 星有被覆盖的格')
  assert.equal(b.d.satActive, a.d.satActive, '参与星数')
  assert.equal(b.d.N, a.d.N)
  let diff = 0
  for (let i = 0; i < a.d.N; i++) if (a.d.fom.simple[i] !== b.d.fom.simple[i]) diff++
  assert.ok(diff <= Math.ceil(a.d.N * 0.01), `覆盖格不一致 ${diff} / ${a.d.N}`)
  near(b.k.timePct, a.k.timePct, 0.05, '时间覆盖 %')
  near(b.k.coverPct, a.k.coverPct, 1, '覆盖面积 %')
  console.log(`      ${a.d.N} 格 · 时间覆盖 satrec ${a.k.timePct.toFixed(4)} % / eph ${b.k.timePct.toFixed(4)} % · 覆盖格不一致 ${diff}`)
})
await T('⑤ 反证 · 覆盖：ents 只拷 rec（修前拼法）的集 → 没有一格被覆盖', async () => {
  const vis = mkVis([{ rec: undefined, name: 'ISS', noradId: 25544, group: 'ci:x' }])
  vis.setMode('coverage')
  vis.covRegionKind.value = 'bounds'; vis.covLatMin.value = 20; vis.covLatMax.value = 55; vis.covLonMin.value = 80; vis.covLonMax.value = 140
  vis.covStep.value = 5; vis.covHorizonH.value = 24; vis.covSample.value = 60
  vis.computeCoverage()
  await until(() => !vis.covBusy.value)
  const d = vis.covData.value
  assert.ok(d && !Array.from(d.fom.simple).some((v) => v > 0), '无传播体 → 0 覆盖')
  vis.close()
})

console.log(`\n${pass} 通过，${fail} 失败${fail ? '：' + fails.join(' / ') : ''}`)
if (fail) process.exit(1)
console.log(`modelVisEph: ${pass} 项通过`)
process.exit(0)
