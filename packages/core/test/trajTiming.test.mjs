// 航迹时间四项联动（packages/core/models/trajTiming.mjs）：出发 / 到达 / 历时 / 速度 / 清除。
//
//   ① 读数：静止档 / 起始 + 地速 / 带钉点（均速）三种口径；全程零长
//   ② 改出发 = 整条平移：没有钉点时地速不变、到达挪 Δ；带钉点时各航点时刻逐个 +Δ（逐航点读数比对）
//   ③ 改到达 / 历时 / 速度 = 出发不动：没有钉点换算成地速（改速度时原值照存）；带钉点按比例伸缩、外推地速同比反缩
//   ④ 静止档补齐：只设出发 → 补缺省地速；只设到达 → 按地速倒推出发（ETA 档）；只设历时 / 速度 → 出发取此刻；
//      单钉点缺地速、起始 + 坏钉点缺地速两种排不出程的情形
//   ⑤ 出错整笔撤回：到达不晚于出发 / 超速 / 越界 / 非法值 / 航点不足，航迹与改前深相等
//   ⑥ 清除：删起始与全部钉点、留地速，回静止档
//   ⑦ 缺省地速：模板 ops 有出处的巡航 / 服务速度优先（km/h > kn），最大速度不取；否则按类型

import assert from 'node:assert/strict'
import { trajTiming, retimeTraj, defaultSpeedKmh, SPEED_KMH_DEFAULT } from '../models/trajTiming.mjs'
import { trajStartMs, trajEndMs, trajLengthM, trajWaypointInfo, wgs84DistanceM } from '../models/trajKinematics.mjs'
import { trajMoving, SPEED_KMH_MAX } from '../models/entityRuntime.mjs'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.stack || e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const T0 = Date.UTC(2026, 9, 7, 8, 0, 0)
const H = 3600000
const A = { lat: 30, lon: 120 }, B = { lat: 31, lon: 122 }, C = { lat: 33, lon: 125 }, D = { lat: 35, lon: 129 }
let seq = 0
// 每条航迹给新 id：trajKinematics 的计划按 id 缓存，测试之间互不串
const mk = (o) => ({ id: 'tt' + (++seq), kind: 'flight', ...o, pts: o.pts.map((p, i) => ({ id: 'w' + i, ...p })) })
const clone = (o) => JSON.parse(JSON.stringify(o))
const ctx = { nowMs: T0 + 5 * H, defSpeedKmh: 600 }
// 时刻是 ~1.8e12 ms 的双精度、改动取整毫秒：比到达 / 历时按 ≤ 1 ms，比速度按相对 1e-9
const MS = 1

// ═════════════════ ① 读数 ═════════════════
t('① 读数：静止档 / 起始 + 地速 / 带钉点均速 / 全程零长', () => {
  const s = trajTiming(mk({ pts: [A, B, C] }))
  assert.equal(s.moving, false); assert.ok(Number.isNaN(s.depMs) && Number.isNaN(s.arrMs) && Number.isNaN(s.durMs) && Number.isNaN(s.speedKmh))
  assert.ok(s.L > 0); assert.equal(s.pins, 0)
  // 只有地速：历时 = 全程 ÷ 地速，出发 / 到达仍空
  const v = trajTiming(mk({ pts: [A, B, C], speedKmh: 500 }))
  assert.equal(v.moving, false); assert.equal(v.speedKmh, 500); near(v.durMs, v.L / (500 / 3.6) * 1000, 1e-6, '静止档历时')
  // 起始 + 地速
  const u = mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 })
  const m = trajTiming(u)
  assert.equal(m.moving, true); assert.equal(m.depMs, T0); assert.equal(m.arrMs, trajEndMs(u)); assert.equal(m.speedKmh, 800); assert.equal(m.avg, false)
  near(m.durMs, m.L / (800 / 3.6) * 1000, 1e-3, '历时 = 全程 ÷ 地速')
  // 带钉点：速度读数 = 全程均速
  const p = mk({ pts: [A, { ...B, tMs: T0 + H }, { ...C, tMs: T0 + 3 * H }], t0Ms: T0 })
  const q = trajTiming(p)
  assert.equal(q.moving, true); assert.equal(q.avg, true); assert.equal(q.pins, 2); assert.equal(q.durMs, 3 * H)
  near(q.speedKmh, trajLengthM(p) / 1000 / 3, 1e-9, '均速 = 全程 ÷ 历时')
  // 单点 / 同位两点：全程零长
  assert.equal(trajTiming(mk({ pts: [A] })).L, 0)
  assert.equal(trajTiming(mk({ pts: [A, A], t0Ms: T0, speedKmh: 10 })).moving, false)
})

// ═════════════════ ② 改出发 = 平移 ═════════════════
t('② 改出发：没有钉点 → 地速不变、到达挪 Δ', () => {
  const u = mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 })
  const a0 = trajEndMs(u)
  assert.deepEqual(retimeTraj(u, { key: 'dep', value: T0 + 2 * H }, ctx), { ok: true })
  assert.equal(u.t0Ms, T0 + 2 * H); assert.equal(u.speedKmh, 800)
  near(trajEndMs(u), a0 + 2 * H, 1e-3, '到达平移')
})
t('② 改出发：带钉点 → 各航点时刻逐个 +Δ、各段地速不变', () => {
  const u = mk({ pts: [A, { ...B, tMs: T0 + H }, { ...C, tMs: T0 + 3 * H }, D], t0Ms: T0, speedKmh: 700 })
  const before = trajWaypointInfo(u).map((e) => e.tMs), sp0 = trajWaypointInfo(u).map((e) => e.speedKmh)
  assert.equal(retimeTraj(u, { key: 'dep', value: T0 - 30 * 60000 }, ctx).ok, true)
  const after = trajWaypointInfo(u)
  after.forEach((e, i) => near(e.tMs, before[i] - 30 * 60000, MS, `航点 ${i} 时刻平移`))
  after.forEach((e, i) => { if (i) near(e.speedKmh, sp0[i], sp0[i] * 1e-9, `航段 ${i} 地速不变`) })
  assert.equal(u.pts[1].tMs, T0 + H - 30 * 60000); assert.equal(u.speedKmh, 700)
})
t('② 改出发：没有起始、出发由钉点外推 → 平移后补上起始，排程不变形', () => {
  const u = mk({ kind: 'sea', pts: [A, { ...B, tMs: T0 + H }, C], speedKmh: 40 })
  const info0 = trajWaypointInfo(u).map((e) => e.tMs)
  const dep0 = trajStartMs(u)
  assert.ok(!('t0Ms' in u)); assert.ok(Number.isFinite(dep0))
  const d = Math.round(dep0) + 10 * 60000
  assert.equal(retimeTraj(u, { key: 'dep', value: d }, ctx).ok, true)
  assert.equal(u.t0Ms, d)
  trajWaypointInfo(u).forEach((e, i) => near(e.tMs, info0[i] + (d - dep0), MS, `航点 ${i}`))
})

// ═════════════════ ③ 改到达 / 历时 / 速度 = 出发不动 ═════════════════
t('③ 改到达：没有钉点 → 出发不动、地速 = 全程 ÷ 历时', () => {
  const u = mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 })
  const L = trajLengthM(u)
  assert.equal(retimeTraj(u, { key: 'arr', value: T0 + 2.5 * H }, ctx).ok, true)
  assert.equal(u.t0Ms, T0); near(trajEndMs(u), T0 + 2.5 * H, MS, '到达')
  near(u.speedKmh, L / 1000 / 2.5, 1e-9, '地速')
})
t('③ 改历时 / 速度：没有钉点 → 改速度原值照存（不出 849.999…）', () => {
  const u = mk({ pts: [A, B, C, D], t0Ms: T0, speedKmh: 800 })
  assert.equal(retimeTraj(u, { key: 'speed', value: 850 }, ctx).ok, true)
  assert.equal(u.speedKmh, 850); assert.equal(u.t0Ms, T0)
  assert.equal(retimeTraj(u, { key: 'dur', value: 4 * H }, ctx).ok, true)
  near(trajEndMs(u) - T0, 4 * H, MS, '历时'); assert.equal(u.t0Ms, T0)
})
t('③ 改历时：带钉点 → 各航点相对出发按同一比例伸缩、外推地速反缩、均速 = 目标', () => {
  const u = mk({ pts: [A, { ...B, tMs: T0 + H }, { ...C, tMs: T0 + 3 * H }, D], t0Ms: T0, speedKmh: 700 })
  const tm0 = trajTiming(u), rel0 = trajWaypointInfo(u).map((e) => e.tMs - T0)
  const k = 1.5
  assert.equal(retimeTraj(u, { key: 'dur', value: tm0.durMs * k }, ctx).ok, true)
  trajWaypointInfo(u).forEach((e, i) => near(e.tMs - T0, rel0[i] * k, MS, `航点 ${i} 伸缩`))
  near(u.speedKmh, 700 / k, 1e-9, '外推地速反缩')
  const tm1 = trajTiming(u)
  near(tm1.durMs, tm0.durMs * k, MS, '历时'); near(tm1.speedKmh, tm0.speedKmh / k, 1e-6, '均速')
  // 改均速：同一路
  assert.equal(retimeTraj(u, { key: 'speed', value: 300 }, ctx).ok, true)
  near(trajTiming(u).speedKmh, 300, 1e-6, '均速 = 目标'); assert.equal(u.t0Ms, T0)
  // 改到达：末航点外推的情形也落在目标上
  assert.equal(retimeTraj(u, { key: 'arr', value: T0 + 9 * H }, ctx).ok, true)
  near(trajEndMs(u), T0 + 9 * H, 2 * MS, '到达')
})

// ═════════════════ ④ 静止档补齐 ═════════════════
t('④ 只设出发 → 补缺省地速（ctx 给的），已有地速则沿用', () => {
  const u = mk({ pts: [A, B, C] })
  assert.equal(retimeTraj(u, { key: 'dep', value: T0 }, ctx).ok, true)
  assert.equal(u.t0Ms, T0); assert.equal(u.speedKmh, 600); assert.equal(trajMoving(u), true)
  const w = mk({ kind: 'sea', pts: [A, B], speedKmh: 25 })
  assert.equal(retimeTraj(w, { key: 'dep', value: T0 }, ctx).ok, true); assert.equal(w.speedKmh, 25)
  // ctx 没给缺省地速：按类型
  const x = mk({ kind: 'sea', pts: [A, B] })
  assert.equal(retimeTraj(x, { key: 'dep', value: T0 }, { nowMs: T0 }).ok, true); assert.equal(x.speedKmh, SPEED_KMH_DEFAULT.sea)
})
t('④ 只设到达 → 按地速倒推出发（ETA 档）', () => {
  const u = mk({ pts: [A, B, C] })
  const L = trajLengthM(u)
  assert.equal(retimeTraj(u, { key: 'arr', value: T0 + 6 * H }, ctx).ok, true)
  assert.equal(u.speedKmh, 600); near(trajEndMs(u), T0 + 6 * H, MS, '到达')
  near(u.t0Ms, T0 + 6 * H - L / (600 / 3.6) * 1000, 0.5 + 1e-6, '出发倒推（取整毫秒）')
  assert.ok(Number.isInteger(u.t0Ms))
})
t('④ 只设历时 / 速度 → 出发取此刻', () => {
  const u = mk({ pts: [A, B, C] })
  assert.equal(retimeTraj(u, { key: 'dur', value: 2 * H }, ctx).ok, true)
  assert.equal(u.t0Ms, ctx.nowMs); near(trajEndMs(u) - u.t0Ms, 2 * H, MS, '历时')
  const w = mk({ pts: [A, B, C] })
  assert.equal(retimeTraj(w, { key: 'speed', value: 450 }, ctx).ok, true)
  assert.equal(w.t0Ms, ctx.nowMs); assert.equal(w.speedKmh, 450)
  // 没有此刻可取：报错、原样不动
  const x = mk({ pts: [A, B, C] }), x0 = clone(x)
  assert.deepEqual(retimeTraj(x, { key: 'dur', value: H }, {}), { ok: false, err: 'bad' })
  assert.deepEqual(clone(x), x0)
})
t('④ 单钉点缺地速 / 起始 + 坏钉点缺地速：补齐后能动，目标落准', () => {
  // 单钉点：首尾都要外推却没有速度可借 → 静止档
  const u = mk({ pts: [A, { ...B, tMs: T0 + H }, C] })
  assert.equal(trajMoving(u), false)
  assert.equal(retimeTraj(u, { key: 'arr', value: T0 + 4 * H }, ctx).ok, true)
  assert.equal(trajMoving(u), true); near(trajEndMs(u), T0 + 4 * H, 2 * MS, '到达')
  const v = mk({ pts: [A, { ...B, tMs: T0 + H }, C] })
  assert.equal(retimeTraj(v, { key: 'dur', value: 3 * H }, ctx).ok, true)
  near(trajTiming(v).durMs, 3 * H, 2 * MS, '历时')
  const w = mk({ pts: [A, { ...B, tMs: T0 + H }, C] })
  assert.equal(retimeTraj(w, { key: 'dep', value: T0 }, ctx).ok, true)
  assert.equal(trajMoving(w), true); assert.equal(trajStartMs(w), T0)
  // 起始 + 坏钉点（不晚于起始）缺地速 → 改到达定地速
  const x = mk({ pts: [A, { ...B, tMs: T0 - H }, C], t0Ms: T0 })
  assert.equal(trajMoving(x), false)
  assert.equal(retimeTraj(x, { key: 'arr', value: T0 + 2 * H }, ctx).ok, true)
  near(trajEndMs(x), T0 + 2 * H, MS, '到达')
})

// ═════════════════ ⑤ 出错整笔撤回 ═════════════════
t('⑤ 出错：到达不晚于出发 / 超速 / 越界 / 非法值 / 航点不足 —— 航迹原样不动', () => {
  const cases = [
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'arr', value: T0 }, 'order'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'arr', value: T0 + 60000 }, 'fast'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'speed', value: SPEED_KMH_MAX + 1 }, 'fast'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'dur', value: -5 }, 'bad'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'speed', value: 0 }, 'bad'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'dep', value: NaN }, 'bad'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'dep', value: 1e17 }, 'range'],
    [mk({ pts: [A, B, C], t0Ms: T0, speedKmh: 800 }), { key: 'nope', value: 1 }, 'bad'],
    [mk({ pts: [A] }), { key: 'dep', value: T0 }, 'short'],
    // 带钉点：伸缩后外推地速超上限 → 超速，钉点一个都不许动
    [mk({ pts: [A, { ...B, tMs: T0 + H }, C], t0Ms: T0, speedKmh: 4000 }), { key: 'dur', value: 0.1 * H }, 'fast'],
    // 带钉点：平移出四位年 → 越界
    [mk({ pts: [A, { ...B, tMs: 253402300799000 - H }, C], t0Ms: 253402300799000 - 2 * H, speedKmh: 500 }), { key: 'dep', value: 253402300799000 - H / 2 }, 'range']
  ]
  for (const [u, e, err] of cases) {
    const u0 = clone(u)
    assert.deepEqual(retimeTraj(u, e, ctx), { ok: false, err }, JSON.stringify(e))
    assert.deepEqual(clone(u), u0, `撤回：${JSON.stringify(e)}`)
  }
  assert.deepEqual(retimeTraj(null, { key: 'dep', value: T0 }), { ok: false, err: 'bad' })
})

// ═════════════════ ⑥ 清除 ═════════════════
t('⑥ 清除：删起始与全部钉点、留地速，回静止档；没有时间可清也不报错', () => {
  const u = mk({ pts: [A, { ...B, tMs: T0 + H }, { ...C, tMs: T0 + 3 * H }], t0Ms: T0, speedKmh: 700 })
  assert.equal(retimeTraj(u, { key: 'clear' }).ok, true)
  assert.ok(!('t0Ms' in u)); assert.ok(u.pts.every((p) => !('tMs' in p))); assert.equal(u.speedKmh, 700)
  assert.equal(trajMoving(u), false)
  assert.equal(retimeTraj(mk({ pts: [A] }), { key: 'clear' }).ok, true)
})

// ═════════════════ ⑦ 缺省地速 ═════════════════
t('⑦ 缺省地速：km/h > 服务航速 kn > speedKt；最大速度不取；否则按类型', () => {
  assert.equal(defaultSpeedKmh('flight', { cruiseSpeedKmh: { value: 306 } }), 306)
  assert.equal(defaultSpeedKmh('sea', { serviceSpeedKn: { value: 22.5 } }), 41.7)
  assert.equal(defaultSpeedKmh('flight', { speedKt: { value: 310 } }), 574.1)
  assert.equal(defaultSpeedKmh('flight', { maxSpeedKtas: { value: 240 } }), SPEED_KMH_DEFAULT.flight)
  assert.equal(defaultSpeedKmh('flight', { cruiseSpeedKmh: { value: -1 }, speedKt: { value: 50 } }), 92.6)
  assert.equal(defaultSpeedKmh('flight'), 850); assert.equal(defaultSpeedKmh('sea'), 30); assert.equal(defaultSpeedKmh(undefined, null), 30)
  // 校核换算：1 kn = 1.852 km/h
  near(wgs84DistanceM(0, 0, 0, 1), 111319.49, 0.01, 'WGS-84 赤道 1° 经差')
})

console.log(`trajTiming: ${n} 项通过`)
