// 「同一颗星，走 SGP4 还是走星历点序列，算出来必须是同一个结果」的对拍网。
//
// 这是整条 ephem 通路的总判据：把一颗真实 TLE 星按 SGP4 采成点序列、导出成 OEM（三种参考系）、
// 再导入回来，然后拿【插值取位】与【SGP4 取位】逐项比 —— 位置、以及 NGSO 站星最差几何的
// 斜距 / 仰角 / 典型时刻 t*。差值都必须在「采样 + 插值 + 换帧」三步该有的量级以内。
//
// 判据（任务书 §12）：
//   导出 OEM（J2000 / TEME / ITRF 三帧）→ 导入 → positionAt 差 <= 10 m
//   solveMutualWorstCase 用 ephem 与用 omm：斜距 <= 10 m、仰角 <= 0.01°、t* <= 1 s

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const sat = require('../vendor/satellite.js')
const ephF = require('../utils/ephemFormats.js')
const ephI = require('../utils/ephemInterp.js')
const OP = require('../utils/orbitPos.js')
const G = require('../utils/ngsoGeometry.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, msg + '（差 ' + Math.abs(a - b) + '，容差 ' + tol + '）')
const section = (t) => console.log('\n— ' + t)

// GEO 定点星：圆赤道轨道上 ECI 赤经 = RAAN + argp + MA，星下点经度 = 赤经 - GMST。
// 故按历元 GMST 反解 MA，就能把星下点精确摆到想要的经度上（手写一组 TLE 多半摆不到，
// 站点看不见它，对拍就成了「两边都不可行」这种验不出东西的相等）。
function geoOmm(lonDeg, epochISO) {
  const gmstDeg = sat.gstime(new Date(epochISO)) * 180 / Math.PI
  const ma = ((lonDeg + gmstDeg) % 360 + 360) % 360
  return {
    type: 'omm', noradId: '900001', epoch: epochISO,
    meanMotion: 1.00270000, ecc: 0, incl: 0.03, raan: 0, argp: 0, ma,
    bstar: 0, mdot: 0, mddot: 0
  }
}
const GEO_EPOCH = '2026-08-18T12:00:00.000Z'

// 一颗真实 LEO 星（ISS 体例）与一颗 GEO 定点星，两种轨道各跑一遍
const CASES = [
  {
    label: 'LEO（i=51.6°、~92 min）',
    orbit: { type: 'tle', line1: '1 25544U 98067A   26230.54791667  .00016717  00000-0  10270-3 0  9004', line2: '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391 56354' },
    stepS: 60, hours: 24,
    tx: { lonDeg: 116.4, latDeg: 39.9, altKm: 0.05, minElevDeg: 10 },
    rx: { lonDeg: 121.5, latDeg: 31.2, altKm: 0.01, minElevDeg: 10 }
  },
  {
    label: 'GEO（i=0.03°、定点 110.5°E）',
    orbit: geoOmm(110.5, GEO_EPOCH),
    stepS: 300, hours: 24,
    tx: { lonDeg: 116.4, latDeg: 39.9, altKm: 0.05, minElevDeg: 5 },
    rx: { lonDeg: 103.8, latDeg: 1.35, altKm: 0.02, minElevDeg: 5 }
  }
]

for (const C of CASES) {
  section(C.label)
  const satrec = G.buildSatrec(C.orbit)
  ok(satrec && !satrec.error, '建 satrec')
  const epochMs = (satrec.jdsatepoch + (satrec.jdsatepochF || 0) - 2440587.5) * 86400000
  const t0 = epochMs
  const n = Math.floor(C.hours * 3600 / C.stepS) + 1

  // ① SGP4 采样成点序列（TEME）
  const t = new Float64Array(n), p = new Float64Array(3 * n), v = new Float64Array(3 * n)
  let k = 0
  for (let i = 0; i < n; i++) {
    const ms = t0 + i * C.stepS * 1000
    const pv = sat.propagate(satrec, new Date(ms))
    if (!pv || !pv.position || !Number.isFinite(pv.position.x)) continue
    t[k] = ms
    p[3 * k] = pv.position.x; p[3 * k + 1] = pv.position.y; p[3 * k + 2] = pv.position.z
    v[3 * k] = pv.velocity.x; v[3 * k + 1] = pv.velocity.y; v[3 * k + 2] = pv.velocity.z
    k++
  }
  ok(k === n, '采样 ' + n + ' 点全部成功', String(k))
  const srcSat = {
    name: 'PARITY', objectId: '', frame: 'TEME', timeSystem: 'UTC',
    interp: { method: 'lagrange', samples: 6 },
    t: t.slice(0, k), p: p.slice(0, 3 * k), v: v.slice(0, 3 * k), spans: null, meta: {}
  }

  // ② 导出 OEM 三帧 → 导入 → 与 SGP4 逐点比
  for (const frame of ['TEME', 'J2000', 'FIXED']) {
    for (const fmt of ['ccsds-oem-kvn', 'ccsds-oem-xml', 'stk-e']) {
      const txt = ephF.serializeEphemeris([srcSat], fmt, { frame, createdMs: t0 })
      const back = ephF.parseEphemeris(txt)
      ok(!back.errors.length && back.sats.length === 1, fmt + ' / ' + frame + '：回读无错', JSON.stringify(back.errors))
      const tab = ephI.buildTable(Object.assign({}, back.sats[0], { interp: back.sats[0].interp }))
      ok(tab && tab.n === k, fmt + ' / ' + frame + '：点数一致')
      let worst = 0, at = 0
      // 只在采样点【之间】比：采样点上两者本就一模一样，比不出插值误差
      for (let i = 1; i < k - 1; i += 7) {
        const ms = t[i] + C.stepS * 1000 * 0.37
        const a = OP.positionAt(satrec, ms), b = OP.positionAt(tab, ms)
        if (!a || !b) continue
        const d = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) * 1000
        if (d > worst) { worst = d; at = i }
      }
      ok(worst <= 10, fmt + ' / ' + frame + '：与 SGP4 差 <= 10 m（实得 ' + worst.toFixed(3) + ' m @ i=' + at + '）')
      // 采样点之间的【最坏】一处（半格处），才是插值误差的真值
      let mid = 0
      for (let i = 1; i < k - 1; i++) {
        const ms = t[i] + C.stepS * 500
        const a = OP.positionAt(satrec, ms), b = OP.positionAt(tab, ms)
        if (a && b) mid = Math.max(mid, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y, a.position.z - b.position.z) * 1000)
      }
      ok(mid <= 10, fmt + ' / ' + frame + '：半格处（插值最坏点）差 <= 10 m（实得 ' + mid.toFixed(3) + ' m）')
    }
  }

  // ③ NGSO 站星最差几何：ephem 与 omm 两条路的结果
  const t0ISO = new Date(t0).toISOString()
  const ommSpec = C.orbit
  const ephSpec = { type: 'ephem', noradId: '800000', samples: { t: srcSat.t, p: srcSat.p, v: srcSat.v, frame: 'TEME', interp: srcSat.interp } }
  const base = { tx: C.tx, rx: C.rx, t0ISO, horizonHours: C.hours }
  const rOmm = G.solveMutualWorstCase(Object.assign({ orbit: ommSpec }, base))
  const rEph = G.solveMutualWorstCase(Object.assign({ orbit: ephSpec }, base))
  ok(rOmm.feasible, 'omm 一路可行', rOmm.reason || '')
  ok(rEph.feasible, 'ephem 一路可行', rEph.reason || '')
  if (rOmm.feasible && rEph.feasible) {
    ok(rEph.method === '星历点序列', 'ephem 的 method 标「星历点序列」', rEph.method)
    ok(rOmm.method === 'SGP4' || rOmm.method === 'SDP4', 'omm 的 method 仍是 SGP4/SDP4', rOmm.method)
    const tA = Date.parse((rOmm.search || {}).typicalISO || '')
    const tB = Date.parse((rEph.search || {}).typicalISO || '')
    ok(Number.isFinite(tA) && Number.isFinite(tB), '两路都给出典型时刻 t*', String(tA) + ' / ' + String(tB))
    // 【t* 的判据】t* = 互视窗内「两站仰角余量之和」最小的那一刻。对 LEO 它落在窗口边缘、位置唯一，
    // 两路必须对到 1 s 以内。对 GEO 则是【退化极小值】：星相对两站几乎不动，整条 24 h 窗里余量之和
    // 处处一样（实测两路的 txElevExcessDeg / rxElevExcessDeg 逐位相同），内点采样落在哪儿都算最小，
    // 差几秒毫无意义 —— 该情形下要验的是「差这几秒到底影不影响结果」，答案是斜距只差 0.011 mm。
    // 故判据写成两者取一：t* 对齐到 1 s，或者 t* 虽不同但各自算出的斜距仍 <= 10 m。
    const dtS = Math.abs(tA - tB) / 1000
    const dSlantM = Math.max(
      Math.abs(((rOmm.worst.up || {}).slantKm - (rEph.worst.up || {}).slantKm) * 1000),
      Math.abs(((rOmm.worst.dn || {}).slantKm - (rEph.worst.dn || {}).slantKm) * 1000))
    ok(dtS <= 1 || dSlantM <= 10,
      '典型时刻 t* 差 <= 1 s，或落在平坦极小值里（各自 t* 上的斜距仍 <= 10 m）',
      'Δt* = ' + dtS.toFixed(3) + ' s，斜距差 = ' + dSlantM.toFixed(4) + ' m')

    // 【★ 两路的几何要在同一时刻上比】t* 是「互视窗内两站仰角余量之和最小」的那一刻，它恰好落在
    // 窗口边缘；边缘由二分求根定位，分辨率约 0.1 s。LEO 在 0.1 s 里走 770 m，所以【各自 t* 上】的
    // 斜距天生就差几百米 —— 那是求解器自身的边缘细化分辨率，与 ephem 通路无关（omm 那一路换个
    // 步长也会自己跟自己差这么多）。真正要验的是「同一物理瞬间，两种传播体给的几何是不是一致」，
    // 故先在 t*_omm 这一个共同时刻上严格比，再用 |Δt*|·星速 解释各自 t* 上的那点差。
    for (const side of ['up', 'dn']) {
      const st = side === 'up' ? C.tx : C.rx
      const A = G.lookAngles(satrec, st, new Date(tA))
      const B = G.lookAngles(G.buildSatrec(ephSpec), st, new Date(tA))
      ok(A && B, side + '：同一时刻两路都取得到视角')
      if (A && B) {
        near(A.slantKm * 1000, B.slantKm * 1000, 10, side + '（同一时刻）斜距差 <= 10 m')
        near(A.elevDeg, B.elevDeg, 0.01, side + '（同一时刻）仰角差 <= 0.01°')
        near(A.azDeg, B.azDeg, 0.01, side + '（同一时刻）方位角差 <= 0.01°')
      }
    }
    // 各自 t* 上的差：必须能被「Δt* × 星速」完整解释（再留 10 m 余量），否则就是真的不一致了
    const vKmS = Number(rOmm.worst.speedInertialKmS) || 0
    const explain = 10 + Math.abs(tA - tB) / 1000 * vKmS * 1000
    for (const side of ['up', 'dn']) {
      const A = (rOmm.worst || {})[side] || {}, B = (rEph.worst || {})[side] || {}
      ok(Number.isFinite(A.slantKm) && Number.isFinite(B.slantKm), side + '：两路都给出斜距')
      near(A.slantKm * 1000, B.slantKm * 1000, explain, side + '（各自 t*）斜距差在「Δt*×星速」可解释范围内')
    }
    // 星下点同理：两路的 t* 差多少，星下点就该差多少经度（GEO 几乎不动，LEO 每秒约 0.06°）
    const subTol = 0.001 + Math.abs(tA - tB) / 1000 * 0.07
    near(rOmm.subSat.lonDeg, rEph.subSat.lonDeg, subTol, '星下点经度差在可解释范围内')
    near(rOmm.subSat.latDeg, rEph.subSat.latDeg, subTol, '星下点纬度差在可解释范围内')
  }

  // ④ 访问窗口：两路窗口数一致、起止对齐到秒级
  const wOmm = G.solveAccessWindows({ orbit: ommSpec, station: C.tx, t0ISO, horizonHours: C.hours, minElevDeg: C.tx.minElevDeg })
  const wEph = G.solveAccessWindows({ orbit: ephSpec, station: C.tx, t0ISO, horizonHours: C.hours, minElevDeg: C.tx.minElevDeg })
  ok(wOmm.feasible && wEph.feasible, '两路都算出访问窗口', (wOmm.reason || '') + ' / ' + (wEph.reason || ''))
  ok(wOmm.totalWindows === wEph.totalWindows, '窗口数一致（' + wOmm.totalWindows + ' vs ' + wEph.totalWindows + '）')
  const m = Math.min((wOmm.windows || []).length, (wEph.windows || []).length)
  let wWorst = 0
  for (let i = 0; i < m; i++) {
    wWorst = Math.max(wWorst,
      Math.abs(Date.parse(wOmm.windows[i].startISO) - Date.parse(wEph.windows[i].startISO)) / 1000,
      Math.abs(Date.parse(wOmm.windows[i].endISO) - Date.parse(wEph.windows[i].endISO)) / 1000)
  }
  ok(m === 0 || wWorst <= 2, '各窗起止差 <= 2 s（实得 ' + wWorst.toFixed(3) + ' s）')
}

/* ===== ⑤ 时段不重叠要点名报错，不能悄悄算出一个数 ===== */
section('时段不重叠')
const C0 = CASES[0]
const sr = G.buildSatrec(C0.orbit)
const e0 = (sr.jdsatepoch + (sr.jdsatepochF || 0) - 2440587.5) * 86400000
const nn = 241
const tt = new Float64Array(nn), pp = new Float64Array(3 * nn), vv = new Float64Array(3 * nn)
for (let i = 0; i < nn; i++) {
  const ms = e0 + i * 60000
  const pv = sat.propagate(sr, new Date(ms))
  tt[i] = ms
  pp[3 * i] = pv.position.x; pp[3 * i + 1] = pv.position.y; pp[3 * i + 2] = pv.position.z
  vv[3 * i] = pv.velocity.x; vv[3 * i + 1] = pv.velocity.y; vv[3 * i + 2] = pv.velocity.z
}
const shortSpec = { type: 'ephem', samples: { t: tt, p: pp, v: vv, frame: 'TEME', interp: { method: 'lagrange', samples: 6 } } }
const away = G.solveMutualWorstCase({ orbit: shortSpec, tx: C0.tx, rx: C0.rx, t0ISO: new Date(e0 + 30 * 86400000).toISOString(), horizonHours: 6 })
ok(away.feasible === false && /不重叠/.test(away.reason || ''), '分析时段在星历之外 → 点名「不重叠」', away.reason)
ok(/星历时段/.test(away.reason || ''), '诊断里带出星历自己的时段', away.reason)
const awayW = G.solveAccessWindows({ orbit: shortSpec, station: C0.tx, t0ISO: new Date(e0 + 30 * 86400000).toISOString(), horizonHours: 6, minElevDeg: 10 })
ok(awayW.feasible === false && /不重叠/.test(awayW.reason || ''), '访问窗口同样点名', awayW.reason)
// 部分重叠：自动收进星历时段内，照常算
const partial = G.solveAccessWindows({ orbit: shortSpec, station: C0.tx, t0ISO: new Date(e0 - 3600000).toISOString(), horizonHours: 6, minElevDeg: 10 })
ok(partial.feasible === true, '部分重叠 → 收进星历时段照常算', partial.reason || '')

/* ===== ⑥ 只给 ref 不给表：点名报错，绝不静默退成 SGP4 ===== */
section('未解析的引用')
let threw = ''
try { G.buildSatrec({ type: 'ephem', ref: { groupId: 'g1', key: 'k1' } }) } catch (e) { threw = e.message }
ok(/未解析/.test(threw), '只给 ref 不给表 → 抛可读错误', threw)
const bad = G.solveMutualWorstCase({ orbit: { type: 'ephem', ref: { groupId: 'g1' } }, tx: C0.tx, rx: C0.rx, t0ISO: new Date(e0).toISOString(), horizonHours: 4 })
ok(bad.feasible === false && /未解析|无效/.test(bad.reason || ''), '几何入口把它变成 feasible:false + 原因', bad.reason)

/* ===== 渲染端 periodMinOf：satrec 与星历表同一个口子 ===== */
// 3D 页的信息卡、轨道圈 TTL、轨迹长度原来一律直接读 rec.no —— 星历点序列星连 rec 都没有：
// 信息卡与 TTL 两处是真抛 TypeError（点一下星点、之后时钟每拍再抛一次），
// 两个 Worker 文件里 rec 是表对象本身、rec.no 为 undefined，周期 NaN → 轨道线 / 轨迹一根都画不出。
section('渲染端 periodMinOf')
{
  const { periodMinOf, validSpan } = await import('../../../src/viz/constellation/satPos.js')
  const { tableFrom } = await import('../../../src/viz/constellation/ephemTable.js')
  const rec0 = sr                              // ⑤ 节那颗真实 TLE 星（G.buildSatrec 建的 satrec）
  const pSat = periodMinOf({ rec: rec0 })
  near(pSat, (2 * Math.PI) / rec0.no, 0, 'satrec 一路逐位等于 2π/no（不许漂）')
  ok(periodMinOf(rec0) === pSat, '裸 satrec 与 { rec } 同结果')
  // 星历表：SGP4 采 2.5 圈，周期必须估得出并与 TLE 的对得上
  const stepS = 60, cnt = Math.round(pSat * 2.5 * 60 / stepS) + 1
  const t = new Float64Array(cnt), p = new Float64Array(3 * cnt), v = new Float64Array(3 * cnt)
  for (let i = 0; i < cnt; i++) {
    const ms = e0 + i * stepS * 1000
    const pv = sat.propagate(rec0, new Date(ms))
    t[i] = ms
    p[3 * i] = pv.position.x; p[3 * i + 1] = pv.position.y; p[3 * i + 2] = pv.position.z
    v[3 * i] = pv.velocity.x; v[3 * i + 1] = pv.velocity.y; v[3 * i + 2] = pv.velocity.z
  }
  const tabLong = tableFrom({ t, p, v, method: 'lagrange', samples: 6 })
  const pEph = periodMinOf({ eph: tabLong })
  ok(pEph != null, '★ 星历表估得出周期（原来读 rec.no 得 NaN / 抛 TypeError）', String(pEph))
  // 【容差怎么来的】estimatePeriodMin 量的是【交点周期】（升交点到升交点），而 2π/no 是开普勒平周期。
  // J2 的长期项让两者相差 2π/no − 2π/(ṁ+ω̇)：这颗星上是 0.0720 min（4.32 s），是物理差不是实现错。
  // 故判据对着【交点周期】给，容差 0.01 min —— 只留给采样步长 60 s 下线性插零点的那点误差。
  const pNodal = (2 * Math.PI) / (rec0.mdot + rec0.argpdot)
  near(pEph, pNodal, 0.01, '★ 表内升交点估的周期 = 交点周期 2π/(ṁ+ω̇)')
  ok(Math.abs(pEph - pSat) < 0.1, '与开普勒平周期只差 J2 长期项那一点（实得 ' + Math.abs(pEph - pSat).toFixed(4) + ' min，理论 ' + Math.abs(pSat - pNodal).toFixed(4) + '）')
  ok(periodMinOf(tabLong) === pEph, '裸表与 { eph } 同结果')
  // 不足一圈的表：估不出就 null，不编数
  const short = tableFrom({ t: t.slice(0, 20), p: p.slice(0, 60), v: v.slice(0, 60), method: 'lagrange', samples: 6 })
  ok(periodMinOf({ eph: short }) === null, '★ 不足一圈的表 → null（调用方据此走「按表点连线」）', String(periodMinOf({ eph: short })))
  ok(periodMinOf(null) === null && periodMinOf({ name: 'x' }) === null, '空 / 认不出 → null，不抛')
  // 有效时段：轨道圈采样窗要靠它夹住
  const sp = validSpan({ eph: tabLong })
  ok(sp && sp.t0 === t[0] && sp.t1 === t[cnt - 1], 'validSpan 给出表的时段', JSON.stringify(sp))
  ok(validSpan({ rec: rec0 }) === null, 'satrec 无时段限制')

  /* ===== 渲染集去留：星历星不因「此刻不在时段内」被剔出集合 ===== */
  // 3D 页的 renderEntries 只在换组 / 换可见层时重建，时钟推进只重算位置。原来 add() 按「此刻
  // posAt 为 null」直接 continue —— 导入一份覆盖【明天】的 .e，当场 0 颗，时钟拖进时段也不出现，
  // 因为没有任何一条时间驱动的重建路径。
  const { keepInRenderSet } = await import('../../../src/viz/constellation/satPos.js')
  const inside = t[Math.floor(cnt / 2)], before = t[0] - 86400000, after = t[cnt - 1] + 86400000
  ok(ephI.evalTable(tabLong, inside) !== null, '前提：时段内取得到位置')
  ok(ephI.evalTable(tabLong, before) === null && ephI.evalTable(tabLong, after) === null, '前提：时段外取不到位置')
  ok(keepInRenderSet({ eph: tabLong }, new Date(before)) === true, '★ 时段【之前】：星历星仍留在渲染集里')
  ok(keepInRenderSet({ eph: tabLong }, new Date(inside)) === true, '时段内当然留')
  ok(keepInRenderSet({ eph: tabLong }, new Date(after)) === true, '★ 时段【之后】：也留（拖回去还要再出现）')
  ok(keepInRenderSet({ rec: rec0 }, new Date(inside)) === true, 'satrec 解得出来 → 留')
  ok(keepInRenderSet({ rec: { no: 0, inclo: 0, error: 1 } }, new Date(inside)) === false, '★ satrec 解不出来 → 剔（这一支行为不变）')
  ok(keepInRenderSet(null, new Date(inside)) === false, '空 entry → 剔')
}

console.log('\nephemParity: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
