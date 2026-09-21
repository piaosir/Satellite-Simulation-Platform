// 位置访问器的回归网（packages/core/utils/orbitPos.js）。
// 判据：satrec 一路必须与 sat.propagate【逐位相同】（这是全平台改走访问器的前提 —— 换了入口
// 但一个数都不许变）；ephem 一路走插值并在时段外返 null。

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const OP = require('../utils/orbitPos.js')
const EI = require('../utils/ephemInterp.js')
const sat = require('../vendor/satellite.js')

let pass = 0, fail = 0
const ok = (cond, msg, extra) => { if (cond) { pass++ } else { fail++; console.error('  ✗ ' + msg + (extra ? '\n      ' + extra : '')) } }
const section = (t) => console.log('\n— ' + t)

// ISS（NORAD 25544）的一组公开 TLE，只用来跑传播，不校验轨道本身
const L1 = '1 25544U 98067A   24170.51782528  .00016717  00000-0  30074-3 0  9993'
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49514403 25544'
const satrec = sat.twoline2satrec(L1, L2)
const EPOCH = new Date(Date.UTC(2024, 5, 18, 12, 25, 40))

/* ===== ① satrec 一路与 sat.propagate 逐位相同 ===== */
section('satrec 一路')
let cmp = 0, diff = 0
for (let m = 0; m < 200; m += 3) {
  const d = new Date(EPOCH.getTime() + m * 60000)
  const a = sat.propagate(satrec, d), b = OP.positionAt(satrec, d)
  cmp++
  if (!a || !a.position) { if (b !== null) diff++; continue }
  if (!b || a.position.x !== b.position.x || a.position.y !== b.position.y || a.position.z !== b.position.z) diff++
  if (b && a.velocity && (a.velocity.x !== b.velocity.x || a.velocity.y !== b.velocity.y || a.velocity.z !== b.velocity.z)) diff++
}
ok(diff === 0, cmp + ' 个时刻上与 sat.propagate 逐位相同（不同 ' + diff + ' 处）')
// 毫秒入参与 Date 入参同解
const msPv = OP.positionAt(satrec, EPOCH.getTime()), dPv = OP.positionAt(satrec, EPOCH)
ok(msPv.position.x === dPv.position.x && msPv.position.z === dPv.position.z, '毫秒与 Date 入参同解')
ok(OP.propagatorLabel(satrec) === 'SGP4', 'satrec 标注 SGP4', OP.propagatorLabel(satrec))
ok(OP.validSpan(satrec) === null, 'satrec 无时段限制')
ok(OP.isEphem(satrec) === false, 'satrec 不是 ephem')
// 深空星标 SDP4
const deep = sat.twoline2satrec(
  '1 00694U 63047A   24170.52905324  .00000181  00000-0  15991-3 0  9998',
  '2 00694  30.3563 216.5401 0575267 219.1174 135.8586 14.02690861 24693')
ok(OP.propagatorLabel(Object.assign({}, deep, { method: 'd' })) === 'SDP4', 'method=d 标注 SDP4')
// 病态：传播失败（SGP4 自己把 error 置位）时返 null。sgp4 每次进来会先清 error，
// 故不能手工塞一个 error 再调 —— 要找一个真会失败的时刻。ISS 这种低轨星往后推几十年必然衰落。
let sawFail = false
for (let yr = 5; yr <= 60 && !sawFail; yr += 5) {
  const d = new Date(EPOCH.getTime() + yr * 365.25 * 86400000)
  const pv = sat.propagate(satrec, d)
  const bad = !pv || !pv.position || !Number.isFinite(pv.position.x) || (satrec.error && satrec.error !== 0)
  if (bad) { sawFail = true; ok(OP.positionAt(satrec, d) === null, '传播失败的时刻 -> null（+' + yr + ' 年）') }
}
ok(sawFail, '找得到一个传播失败的时刻（否则这条断言没验到东西）')
ok(OP.positionAt(null, EPOCH) === null, '空对象 -> null')
ok(OP.positionAt(undefined, EPOCH) === null, 'undefined -> null')

/* ===== ② ephem 一路 ===== */
section('ephem 一路')
const MU = 398600.4418, R = 7000, n = Math.sqrt(MU / (R * R * R))
const T0 = Date.UTC(2026, 8, 21), CNT = 61
const t = new Float64Array(CNT), p = new Float64Array(3 * CNT), v = new Float64Array(3 * CNT)
for (let i = 0; i < CNT; i++) {
  const s = i * 60, u = n * s
  t[i] = T0 + s * 1000
  p[3 * i] = R * Math.cos(u); p[3 * i + 1] = R * Math.sin(u); p[3 * i + 2] = 0
  v[3 * i] = -R * n * Math.sin(u); v[3 * i + 1] = R * n * Math.cos(u); v[3 * i + 2] = 0
}
const tab = EI.buildTable({ t, p, v, frame: 'TEME', interp: { method: 'lagrange', samples: 6 } })
ok(OP.isEphem(tab) === true, 'ephem 表认得出来')
ok(OP.propagatorLabel(tab) === '星历点序列', 'ephem 标注「星历点序列」', OP.propagatorLabel(tab))
const span = OP.validSpan(tab)
ok(span && span.t0 === T0 && span.t1 === T0 + 3600000, 'validSpan 给出起止')
const mid = OP.positionAt(tab, T0 + 1800000)
ok(mid && Math.abs(Math.hypot(mid.position.x, mid.position.y, mid.position.z) - R) < 1e-6, '时段内取位在轨道半径上')
ok(mid.velocity && Math.abs(Math.hypot(mid.velocity.x, mid.velocity.y, mid.velocity.z) - R * n) < 1e-6, '速度量级对')
ok(OP.positionAt(tab, T0 - 5000) === null, '时段前 -> null（不外推）')
ok(OP.positionAt(tab, T0 + 3600000 + 5000) === null, '时段后 -> null（不外推）')
// 两种入参同解
ok(OP.positionAt(tab, new Date(T0 + 900000)).position.x === OP.positionAt(tab, T0 + 900000).position.x, 'Date / 毫秒同解')
// 契约形状：两条路都给 position / velocity 的 x,y,z，调用方不必分支。
// （satrec 一路是 vendor 结果的直通，会多带一个 meanElements，属于无害透传，不进契约。）
for (const [label, pv] of [['satrec', OP.positionAt(satrec, EPOCH)], ['ephem', mid]]) {
  ok(pv && pv.position && ['x', 'y', 'z'].every((k) => Number.isFinite(pv.position[k])), label + '：position 三分量有限')
  ok(pv && pv.velocity && ['x', 'y', 'z'].every((k) => Number.isFinite(pv.velocity[k])), label + '：velocity 三分量有限')
}

console.log('\norbitPos: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
