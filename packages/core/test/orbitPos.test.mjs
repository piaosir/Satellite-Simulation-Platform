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

/* ===== ③ 叠加版本号与按 spec 缓存取位的地方（ngsoGeometry 粗扫会话） ===== */
section('叠加版本号 / NGSO 粗扫会话缓存')
{
  const NG = require('../utils/ngsoGeometry.js')
  const v0 = OP.overlayVersion()
  OP.bumpOverlays()
  ok(OP.overlayVersion() === v0 + 1, 'bumpOverlays 让版本号 +1')
  // 中星 6C（GEO）：先按 SGP4 算一次几何，再挂一张整体挪 60 km 的叠加表，同参数立刻重算
  const G1 = '1 44067U 19012A   26280.97985421 -.00000351  00000+0  00000+0 0  9995'
  const G2 = '2 44067   0.0554 298.8093 0012858 125.1382  75.8829  1.00270086 27879'
  const g6c = sat.twoline2satrec(G1, G2)
  const ep = Math.round((g6c.jdsatepoch - 2440587.5) * 86400000 / 60000) * 60000
  const opts = {
    orbit: { type: 'tle', line1: G1, line2: G2 },
    tx: { lonDeg: 116.4, latDeg: 39.9, altKm: 0, minElevDeg: 5, freqGHz: 14 }, rx: { lonDeg: 121.5, latDeg: 31.2, altKm: 0, minElevDeg: 5, freqGHz: 12 },
    t0ISO: new Date(ep).toISOString(), horizonHours: 6
  }
  const slant = (r) => (r && r.worst && r.worst.up ? r.worst.up.slantKm : NaN)
  const r1 = NG.solveMutualWorstCase(opts)
  const nn = 8 * 60 + 1, tt = new Float64Array(nn), pp = new Float64Array(3 * nn), vv = new Float64Array(3 * nn)
  for (let i = 0; i < nn; i++) {
    const ms = ep - 3600000 + i * 60000, pv = sat.propagate(g6c, new Date(ms))
    tt[i] = ms; pp.set([pv.position.x + 60, pv.position.y, pv.position.z], 3 * i); vv.set([pv.velocity.x, pv.velocity.y, pv.velocity.z], 3 * i)
  }
  const ovl = EI.buildTable({ t: tt, p: pp, v: vv, frame: 'TEME', interp: { method: 'hermite', samples: 2 } })
  OP.setOverlayResolver((id) => (id === '44067' ? [ovl] : null))
  const r2 = NG.solveMutualWorstCase(opts)
  NG.solveMutualWorstCase(Object.assign({}, opts, { horizonHours: 5 }))   // 换键：会话缓存整体丢弃
  const r3 = NG.solveMutualWorstCase(opts)
  ok(Number.isFinite(slant(r1)) && Math.abs(slant(r3) - slant(r1)) > 1, '叠加表确实改了几何（挪 60 km，斜距变化 > 1 km）', slant(r1) + ' → ' + slant(r3))
  ok(slant(r2) === slant(r3) && r2.worst.up.elevDeg === r3.worst.up.elevDeg, '刚挂上叠加就同参数重算：不沿用旧 SGP4 粗扫样本（与缓存失效后逐位相同）', slant(r2) + ' vs ' + slant(r3))
  OP.setOverlayResolver(null)
  const r4 = NG.solveMutualWorstCase(opts)
  ok(slant(r4) === slant(r1), '取消叠加后同参数重算：回到 SGP4 结果', slant(r4) + ' vs ' + slant(r1))
}

console.log('\norbitPos: 通过 ' + pass + '，失败 ' + fail)
process.exit(fail ? 1 : 0)
