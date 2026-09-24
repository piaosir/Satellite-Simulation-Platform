// 航迹运动学（packages/core/models/trajKinematics.mjs，DESIGN3 E8）的回归网。
//
//   ① WGS-84 距离：赤道 1/4 圈 = a·π/2、子午线象限 = 10 001 965.729 m、Vincenty 原文算例（Flinders Peak → Buninyong）、
//      对跖退化（赤道对跖 = 过极子午线 = 2 × 象限）、对称
//   ② 大圆位置与航向对解析：赤道 / 子午线 / 任意斜段（球面中间点公式、球面方位角公式），出发 / 到达航向
//   ③ 多段：段号取原下标（跳过无效航点、零长段）、过航点连续、时刻与里程两个入口一致
//   ④ 飞行剖面：梯形（爬升 / 巡航 / 3° 下滑三段解析）、三角（短航段顶点解析）、钉点（中间航点 altM）、到不了就直线、处处连续
//   ⑤ 航行 altM 恒 0；未出发 / 已到达两端取航点原值
//   ⑥ 静止档（无时刻或速度）：与 scene.setTrajectories 的载具 _tan 逐位一致（three 的 Vector3 + focusLanes.llaToVec 原样复算），
//      位置 = 航迹头原值；航向 = 解析到达方位；scene.js 源码仍是这套算法（找到就核对，找不到打印提示）
//   ⑦ 计划缓存：同 id 新拷贝不重建、原地改航点立即生效、无效行挪位置也重建（leg 跟原下标走）、out 复用
//   ⑧ 极点航点（lat = ±90、lon ≠ 0）：航向按航点经度的 N / E 取，与切向一致
//   ⑨ 热路径分配量（采样堆分析）：报数 + 宽判据（只抓显式分配回归）

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Session } from 'node:inspector/promises'
import { fileURLToPath } from 'node:url'
import {
  trajStateAt, trajStateAtS, makeTrajState, trajPlan, trajLengthM, trajEndMs, sceneHeadTangent, greatCircleInterp,
  greatCircleDistanceM, wgs84DistanceM, clearTrajPlanCache, trajPlanStats,
  CRUISE_ALT_M_DEFAULT, CLIMB_RATE_MS_DEFAULT, GLIDE_DEG_DEFAULT, PITCH_LIMIT_DEG, SCENE_RE_KM
} from '../models/trajKinematics.mjs'
import { llaToVec } from '../../../src/viz/globe3d/focusLanes.js'

let n = 0
const t = (name, fn) => { try { fn(); n++ } catch (e) { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1 } }
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}（差 ${Math.abs(a - b)}）`)
const D2R = Math.PI / 180, R2D = 180 / Math.PI
const angDiff = (a, b) => { const d = Math.abs(((a - b) % 360 + 540) % 360 - 180); return d }
const nearAng = (a, b, tol, msg) => assert.ok(angDiff(a, b) <= tol, `${msg}：${a} vs ${b}（差 ${angDiff(a, b)}°）`)

let seed = 20260924
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }

// ── 球面解析式（大地纬当球面纬，与场景同口径）──
const unit = (lat, lon) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)]
const centralAngle = (a, b) => { const u = unit(a[0], a[1]), v = unit(b[0], b[1]); const c = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; return Math.atan2(Math.hypot(...c), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) }
// 球面初始方位（A → B），度 [0, 360)
function bearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * D2R, p2 = lat2 * D2R, dl = (lon2 - lon1) * D2R
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return (Math.atan2(y, x) * R2D + 360) % 360
}
// 球面中间点（Ed Williams《Aviation Formulary》）：f ∈ [0,1]
function midpoint(lat1, lon1, lat2, lon2, f) {
  const d = centralAngle([lat1, lon1], [lat2, lon2])
  const A = Math.sin((1 - f) * d) / Math.sin(d), B = Math.sin(f * d) / Math.sin(d)
  const u = unit(lat1, lon1), v = unit(lat2, lon2)
  const x = A * u[0] + B * v[0], y = A * u[1] + B * v[1], z = A * u[2] + B * v[2]
  return [Math.atan2(z, Math.hypot(x, y)) * R2D, Math.atan2(y, x) * R2D]
}
const posErrDeg = (lat, lon, ref) => centralAngle([lat, lon], ref) * R2D

const T0 = Date.UTC(2026, 8, 24, 0, 0, 0)
const A_M = 6378137

// ═════════════════════════════ ① WGS-84 距离 ═════════════════════════════
t('WGS-84：赤道 1/4 圈 = a·π/2（赤道测地线就是赤道）', () => {
  near(wgs84DistanceM(0, 0, 0, 90), A_M * Math.PI / 2, 1e-5, '赤道 90°')   // Vincenty 迭代收敛阈 1e-12 rad ≈ 6 µm
  near(wgs84DistanceM(0, 10, 0, -20), A_M * 30 * D2R, 1e-5, '赤道跨 0°')
})
t('WGS-84：子午线象限 = 10 001 965.729 m', () => {
  near(wgs84DistanceM(0, 30, 90, 30), 10001965.729, 0.002, '赤道 → 北极')
  near(wgs84DistanceM(-90, 0, 0, 0), 10001965.729, 0.002, '南极 → 赤道')
})
t('WGS-84：Vincenty 原文算例 Flinders Peak → Buninyong = 54 972.271 m', () => {
  const dms = (d, m, s) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600)
  const d = wgs84DistanceM(dms(-37, 57, 3.72030), dms(144, 25, 29.52440), dms(-37, 39, 10.15610), dms(143, 55, 35.38390))
  near(d, 54972.271, 0.005, 'Flinders → Buninyong')
})
t('WGS-84：对称、重合 = 0、非有限 = NaN、跨日界取短弧', () => {
  for (let i = 0; i < 50; i++) {
    const a = [rnd() * 170 - 85, rnd() * 360 - 180], b = [rnd() * 170 - 85, rnd() * 360 - 180]
    near(wgs84DistanceM(a[0], a[1], b[0], b[1]), wgs84DistanceM(b[0], b[1], a[0], a[1]), 1e-6, `对称 ${i}`)
  }
  assert.equal(wgs84DistanceM(12.3, 45.6, 12.3, 45.6), 0)
  assert.ok(Number.isNaN(wgs84DistanceM(NaN, 0, 1, 1)))
  near(wgs84DistanceM(0, 179.5, 0, -179.5), A_M * D2R, 1e-5, '跨日界 1°')
})
t('WGS-84：对跖退化 —— 赤道对跖 = 过极子午线 = 2 × 象限；近对跖有限且介于 πb 与 πa 之间', () => {
  near(wgs84DistanceM(0, 0, 0, 180), 2 * 10001965.729, 0.005, '赤道对跖')
  const d = wgs84DistanceM(0.3, 0, -0.2, 179.8)
  assert.ok(Number.isFinite(d) && d > Math.PI * 6356752.3142 * 0.999 && d < Math.PI * A_M, `近对跖 ${d}`)
})
t('场景球大圆距离 = 6371 km × 圆心角', () => {
  near(greatCircleDistanceM(0, 0, 0, 90), SCENE_RE_KM * 1000 * Math.PI / 2, 1e-6, '赤道 90°')
  near(greatCircleDistanceM(10, 20, -30, 140), SCENE_RE_KM * 1000 * centralAngle([10, 20], [-30, 140]), 1e-6, '斜段')
})

// ═════════════════════════════ ② 大圆位置与航向 ═════════════════════════════
t('赤道航段：半程 = 经度 45°、航向 90°、切向 = 场景轴正东', () => {
  const tr = { id: 'eq', kind: 'sea', pts: [{ lat: 0, lon: 0 }, { lat: 0, lon: 90 }], t0Ms: T0, speedKmh: 100 }
  const L = trajLengthM(tr)
  near(L, A_M * Math.PI / 2, 1e-5, '全程')
  const v = 100 / 3.6
  const st = trajStateAt(tr, T0 + (L / 2) / v * 1000)
  near(st.lat, 0, 1e-12, 'lat'); near(st.lon, 45, 1e-9, 'lon'); near(st.headingDeg, 90, 1e-9, '航向')
  near(st.s, L / 2, 1e-4, 's')    // tMs ≈ 1.8e12 的双精度粒度 ≈ 2.4e-4 ms
  assert.equal(st.moving, true); assert.equal(st.done, false); assert.equal(st.phase, 'cruise')
  assert.equal(st.altM, 0); assert.equal(st.pitchDeg, 0); assert.equal(st.leg, 0)
  const e = [-Math.SQRT1_2, Math.SQRT1_2, 0]                                // ECEF 正东 @ 45°E → 场景 (x, z, −y)
  near(st.tan[0], e[0], 1e-12, 'tan x'); near(st.tan[1], e[2], 1e-12, 'tan y'); near(st.tan[2], -e[1], 1e-12, 'tan z')
})
t('子午线航段：按里程比例 = 纬度比例、航向 0°', () => {
  const tr = { id: 'mer', kind: 'sea', pts: [{ lat: 0, lon: 30 }, { lat: 60, lon: 30 }] }
  const L = trajLengthM(tr)
  for (const f of [0, 0.25, 0.5, 0.9, 1]) {
    const st = trajStateAtS(tr, f * L)
    near(st.lat, 60 * f, 1e-9, `lat f=${f}`); near(st.lon, 30, 1e-9, `lon f=${f}`); nearAng(st.headingDeg, 0, 1e-9, `航向 f=${f}`)
  }
})
t('任意斜段：位置对球面中间点公式、航向对球面方位角（P → B）', () => {
  for (let i = 0; i < 40; i++) {
    const a = [rnd() * 140 - 70, rnd() * 360 - 180], b = [rnd() * 140 - 70, rnd() * 360 - 180]
    const ca = centralAngle(a, b)
    if (ca < 0.02 || ca > Math.PI - 0.05) continue
    const tr = { id: 'ob' + i, kind: 'sea', pts: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }] }
    const L = trajLengthM(tr)
    for (const f of [0.1, 0.37, 0.8]) {
      const st = trajStateAtS(tr, f * L)
      const ref = midpoint(a[0], a[1], b[0], b[1], f)
      assert.ok(posErrDeg(st.lat, st.lon, ref) < 1e-9, `位置 ${i} f=${f}：差 ${posErrDeg(st.lat, st.lon, ref)}°`)
      nearAng(st.headingDeg, bearing(st.lat, st.lon, b[0], b[1]), 1e-7, `航向 ${i} f=${f}`)
    }
    // 出发 / 到达（时刻口径两端）
    const tr2 = { ...tr, id: 'ob2' + i, t0Ms: T0, speedKmh: 900 }
    const pre = trajStateAt(tr2, T0 - 1000), end = trajStateAt(tr2, trajEndMs(tr2) + 1000)
    nearAng(pre.headingDeg, bearing(a[0], a[1], b[0], b[1]), 1e-7, `出发航向 ${i}`)
    nearAng(end.headingDeg, (bearing(b[0], b[1], a[0], a[1]) + 180) % 360, 1e-7, `到达航向 ${i}`)
  }
})
t('greatCircleInterp 与载具位置同一条大圆', () => {
  const tr = { id: 'gci', kind: 'sea', pts: [{ lat: 22.3, lon: 114.2 }, { lat: 51.5, lon: -0.1 }] }
  const L = trajLengthM(tr)
  for (const f of [0, 0.2, 0.5, 0.77, 1]) {
    const st = trajStateAtS(tr, f * L), g = greatCircleInterp(22.3, 114.2, 51.5, -0.1, f)
    assert.ok(posErrDeg(st.lat, st.lon, [g.lat, g.lon]) < 1e-10, `f=${f}`)
  }
})

// ═════════════════════════════ ③ 多段 ═════════════════════════════
t('多段：段号取原下标（跳过无效航点与零长段）、过航点连续、时刻与里程入口一致', () => {
  const pts = [{ lat: 31.2, lon: 121.5 }, { lat: NaN, lon: 3 }, { lat: 35.7, lon: 139.7 }, { lat: 35.7, lon: 139.7 }, { lat: 21.3, lon: -157.9 }, { lat: 37.6, lon: -122.4 }]
  const tr = { id: 'multi', kind: 'sea', pts, t0Ms: T0, speedKmh: 850 }
  const d1 = wgs84DistanceM(31.2, 121.5, 35.7, 139.7), d2 = wgs84DistanceM(35.7, 139.7, 21.3, -157.9), d3 = wgs84DistanceM(21.3, -157.9, 37.6, -122.4)
  near(trajLengthM(tr), d1 + d2 + d3, 1e-6, '全程 = 段长之和')
  assert.equal(trajStateAtS(tr, d1 * 0.5).leg, 0)
  assert.equal(trajStateAtS(tr, d1 + d2 * 0.5).leg, 3, '零长段 2→3 跳过，第二段起点是原下标 3')
  assert.equal(trajStateAtS(tr, d1 + d2 + d3 * 0.5).leg, 4)
  const at = trajStateAtS(tr, d1)
  assert.ok(posErrDeg(at.lat, at.lon, [35.7, 139.7]) < 1e-9, '恰在航点')
  const a = trajStateAtS(tr, d1 - 1), b = trajStateAtS(tr, d1 + 1)
  assert.ok(posErrDeg(a.lat, a.lon, [b.lat, b.lon]) * D2R * 6371000 < 2.01, '过航点位置连续（±1 m）')
  const v = 850 / 3.6
  for (const s of [1000, d1 * 0.3, d1 + d2 * 0.61, d1 + d2 + d3 * 0.99]) {
    const x = trajStateAt(tr, T0 + s / v * 1000), y = trajStateAtS(tr, s)
    assert.ok(posErrDeg(x.lat, x.lon, [y.lat, y.lon]) < 1e-9, `时刻 / 里程一致 s=${s}`)
    nearAng(x.headingDeg, y.headingDeg, 1e-7, `航向一致 s=${s}`)
  }
})
t('两端：未出发停在首航点原值（pre），到达后停在末航点原值（done），trajEndMs = t0 + 全程 / 速度', () => {
  const tr = { id: 'ends', kind: 'flight', pts: [{ lat: 40.08, lon: 116.58 }, { lat: 31.14, lon: 121.8 }], t0Ms: T0, speedKmh: 780 }
  const L = trajLengthM(tr)
  near(trajEndMs(tr), T0 + L / (780 / 3.6) * 1000, 1e-3, 'trajEndMs')
  const pre = trajStateAt(tr, T0 - 60000)
  assert.equal(pre.phase, 'pre'); assert.equal(pre.done, false); assert.equal(pre.s, 0); assert.equal(pre.altM, 0); assert.equal(pre.pitchDeg, 0)
  assert.ok(Object.is(pre.lat, 40.08) && Object.is(pre.lon, 116.58), '首航点原值')
  const end = trajStateAt(tr, trajEndMs(tr) + 1)
  assert.equal(end.phase, 'done'); assert.equal(end.done, true); assert.equal(end.s, L); assert.equal(end.altM, 0)
  assert.ok(Object.is(end.lat, 31.14) && Object.is(end.lon, 121.8), '末航点原值')
  assert.ok(Number.isNaN(trajEndMs({ id: 'x', kind: 'flight', pts: tr.pts })), '无时刻 → NaN')
})

// ═════════════════════════════ ④ 飞行剖面 ═════════════════════════════
const SPEED = 830, V = SPEED / 3.6, TC = CLIMB_RATE_MS_DEFAULT / V, TD = Math.tan(GLIDE_DEG_DEFAULT * D2R)
// 剖面处处连续：密采样相邻两点高差 ≤ 最大坡度 × 步长
function assertContinuous(tr, maxSlope, msg) {
  const L = trajLengthM(tr), N = 20000
  let prev = trajStateAtS(tr, 0).altM
  for (let i = 1; i <= N; i++) {
    const h = trajStateAtS(tr, L * i / N).altM
    assert.ok(Math.abs(h - prev) <= maxSlope * L / N + 1e-6, `${msg}：第 ${i} 点跳变 ${h - prev}`)
    prev = h
  }
}
t('梯形剖面：0 m 起飞 → 按爬升率升到 FL350 → 平飞 → 3° 下滑落地（分段解析）', () => {
  const tr = { id: 'trap', kind: 'flight', pts: [{ lat: 30, lon: 100 }, { lat: 40, lon: 120 }], speedKmh: SPEED }
  const L = trajLengthM(tr), cr = CRUISE_ALT_M_DEFAULT
  const sC = cr / TC, sD = L - cr / TD
  assert.ok(sC < sD, '航段够长')
  near(trajStateAtS(tr, 0).altM, 0, 1e-9, '起飞 0 m')
  near(trajStateAtS(tr, L).altM, 0, 1e-9, '落地 0 m')
  let st = trajStateAtS(tr, sC / 2)
  near(st.altM, TC * sC / 2, 1e-6, '爬升段高度'); near(st.pitchDeg, Math.atan(TC) * R2D, 1e-12, '爬升角'); assert.equal(st.phase, 'climb')
  st = trajStateAtS(tr, (sC + sD) / 2)
  assert.equal(st.altM, cr); assert.equal(st.pitchDeg, 0); assert.equal(st.phase, 'cruise')
  st = trajStateAtS(tr, L - 1000)
  near(st.altM, 1000 * TD, 1e-6, '下滑段高度'); near(st.pitchDeg, -GLIDE_DEG_DEFAULT, 1e-12, '下滑角'); assert.equal(st.phase, 'descent')
  near(trajStateAtS(tr, sC).altM, cr, 1e-6, '爬升顶点'); near(trajStateAtS(tr, sD).altM, cr, 1e-6, '下滑起点')
  assertContinuous(tr, Math.max(TC, TD), '梯形')
  // 时刻入口：t = t0 + s / v
  const tr2 = { ...tr, id: 'trap2', t0Ms: T0 }
  for (const s of [sC * 0.3, (sC + sD) / 2, L - 5000]) near(trajStateAt(tr2, T0 + s / V * 1000).altM, trajStateAtS(tr, s).altM, 1e-6, `时刻口径 s=${s}`)
})
t('三角剖面：短航段到不了巡航高度，顶点 = 两条斜线交点', () => {
  const tr = { id: 'tri', kind: 'flight', pts: [{ lat: 22.31, lon: 113.92 }, { lat: 22.9, lon: 113.5 }], speedKmh: SPEED }
  const L = trajLengthM(tr)
  const sx = L * TD / (TC + TD), hx = sx * TC
  assert.ok(hx < CRUISE_ALT_M_DEFAULT, `顶点 ${hx} m 低于巡航`)
  near(trajStateAtS(tr, sx).altM, hx, 1e-6, '顶点高度')
  assert.equal(trajStateAtS(tr, sx * 0.5).phase, 'climb'); assert.equal(trajStateAtS(tr, (sx + L) / 2).phase, 'descent')
  let hmax = 0
  for (let i = 0; i <= 4000; i++) hmax = Math.max(hmax, trajStateAtS(tr, L * i / 4000).altM)
  assert.ok(hmax <= hx + 1e-6 && hmax >= hx - Math.max(TC, TD) * L / 4000, '最大值 = 顶点')
  assertContinuous(tr, Math.max(TC, TD), '三角')
})
t('航点 altM 钉点：中间航点 5000 m（先 3° 降到钉点再爬回巡航）、首航点 300 m（机场标高）、段顶 = max(巡航, 两端钉点)', () => {
  const pts = [{ lat: 30, lon: 100, altM: 300 }, { lat: 33, lon: 108, altM: 5000 }, { lat: 36, lon: 116 }]
  const tr = { id: 'pin', kind: 'flight', pts, speedKmh: SPEED }
  const s1 = wgs84DistanceM(30, 100, 33, 108)
  near(trajStateAtS(tr, 0).altM, 300, 1e-9, '首航点标高')
  near(trajStateAtS(tr, s1).altM, 5000, 1e-6, '钉点高度')
  const before = trajStateAtS(tr, s1 - 2000), after = trajStateAtS(tr, s1 + 2000)
  near(before.altM, 5000 + 2000 * TD, 1e-6, '钉点前 3° 下滑'); assert.equal(before.phase, 'descent')
  near(after.altM, 5000 + 2000 * TC, 1e-6, '钉点后爬升'); assert.equal(after.phase, 'climb')
  assert.equal(trajStateAtS(tr, s1 / 2).altM, CRUISE_ALT_M_DEFAULT, '第一段中部巡航')
  assertContinuous(tr, Math.max(TC, TD), '钉点')
  // 钉点高于巡航：段顶抬到钉点
  const tr2 = { id: 'pinHigh', kind: 'flight', pts: [{ lat: 30, lon: 100 }, { lat: 33, lon: 108, altM: 12500 }, { lat: 36, lon: 116 }], speedKmh: SPEED }
  near(trajStateAtS(tr2, s1).altM, 12500, 1e-6, '高钉点')
  assert.equal(trajStateAtS(tr2, s1 * 0.8).altM, 12500, '段顶 = 钉点')
  assertContinuous(tr2, Math.max(TC, TD), '高钉点')
})
t('钉点按爬升率 / 下滑角到不了：该段退成直线，照样过钉点、连续，俯仰夹在 ±PITCH_LIMIT_DEG', () => {
  const pts = [{ lat: 30, lon: 100 }, { lat: 30.05, lon: 100 , altM: 9000 }, { lat: 30.1, lon: 100 }]
  const tr = { id: 'steep', kind: 'flight', pts, speedKmh: SPEED }
  const s1 = wgs84DistanceM(30, 100, 30.05, 100), L = trajLengthM(tr)
  near(trajStateAtS(tr, s1).altM, 9000, 1e-6, '过钉点')
  near(trajStateAtS(tr, s1 / 2).altM, 4500, 1e-6, '直线中点')
  assert.equal(trajStateAtS(tr, s1 / 2).pitchDeg, PITCH_LIMIT_DEG, '俯仰夹限')
  assert.equal(trajStateAtS(tr, (s1 + L) / 2).pitchDeg, -PITCH_LIMIT_DEG, '俯仰夹限（负）')
  assertContinuous(tr, 9000 / s1 * 1.001, '直线段')
})
t('爬升率 / 下滑角 / 巡航高度可由航迹覆盖', () => {
  const tr = { id: 'ovr', kind: 'flight', pts: [{ lat: 0, lon: 0 }, { lat: 0, lon: 20 }], speedKmh: 720, climbRateMs: 20, glideDeg: 4, cruiseAltM: 8000 }
  const L = trajLengthM(tr), tc = 20 / 200, td = Math.tan(4 * D2R)
  near(trajStateAtS(tr, 1000).altM, 1000 * tc, 1e-6, '爬升率覆盖')
  near(trajStateAtS(tr, L - 1000).altM, 1000 * td, 1e-6, '下滑角覆盖')
  assert.equal(trajStateAtS(tr, L / 2).altM, 8000, '巡航高度覆盖')
})

// ═════════════════════════════ ⑤ 航行 ═════════════════════════════
t('航行：altM 恒 0、俯仰恒 0（航点带 altM、航迹带 cruiseAltM 也不理）', () => {
  const tr = { id: 'sea', kind: 'sea', pts: [{ lat: 1.26, lon: 103.8, altM: 500 }, { lat: 31.2, lon: 121.9, altM: 800 }], cruiseAltM: 9000, t0Ms: T0, speedKmh: 40 }
  const L = trajLengthM(tr)
  for (const f of [0, 0.3, 0.99, 1]) { const st = trajStateAtS(tr, f * L); assert.equal(st.altM, 0); assert.equal(st.pitchDeg, 0) }
  for (const dt of [-1e6, 3.6e6, 1e12]) { const st = trajStateAt(tr, T0 + dt); assert.equal(st.altM, 0); assert.equal(st.pitchDeg, 0) }
  const st = trajStateAt(tr, T0); assert.equal(st.altM, 0)
  const s0 = trajStateAt({ ...tr, id: 'seaStatic', t0Ms: undefined }, T0); assert.equal(s0.altM, 0); assert.equal(s0.pitchDeg, 0)
})

// ═════════════════════════════ ⑥ 静止档 = 现状 ═════════════════════════════
// scene.setTrajectories 载具那几行原样（three 的 Vector3 + focusLanes.llaToVec）
function sceneTan(pts) {
  const hd = pts[pts.length - 1]
  const pos = llaToVec(hd.lat, hd.lon, 0).multiplyScalar(1.0025)
  const dir = pos.clone().normalize()
  if (!(pts.length > 1)) return { tan: null, pos }
  const pv = llaToVec(pts[pts.length - 2].lat, pts[pts.length - 2].lon, 0).normalize()
  const hn = dir
  const tan = pv.clone().addScaledVector(hn, -hn.dot(pv)).multiplyScalar(-1)
  return { tan: tan.lengthSq() > 1e-12 ? tan.normalize() : null, pos }
}
t('静止档：无时刻 / 速度 → 航迹头原值 + 切向与 scene 的 _tan 逐位一致（300 条随机航迹，含日界、近极、极短末段）', () => {
  let cmp = 0
  for (let i = 0; i < 300; i++) {
    const k = 2 + Math.floor(rnd() * 5)
    const pts = []
    for (let j = 0; j < k; j++) pts.push({ id: 'w' + j, lat: rnd() * 178 - 89, lon: rnd() * 360 - 180 })
    if (i % 10 === 0) { pts[k - 1].lon = 179.9; pts[k - 2].lon = -179.95 }
    if (i % 10 === 1) { pts[k - 1].lat = 89.99; pts[k - 2].lat = 89.5 }
    if (i % 10 === 2) { pts[k - 1].lat = pts[k - 2].lat + 1e-7; pts[k - 1].lon = pts[k - 2].lon }           // 末段约 1 cm：scene 不设 _tan
    if (i % 10 === 3) { pts[k - 1].lat = pts[k - 2].lat + 1e-4; pts[k - 1].lon = pts[k - 2].lon }           // 末段约 11 m：|tan|² ≈ 3e-12，刚过阈值
    const tr = { id: 'st' + i, name: 'x', kind: i % 2 ? 'flight' : 'sea', pts, color: 0xff0000 }
    const st = trajStateAt(tr, T0 + i * 1000)
    const ref = sceneTan(pts)
    assert.equal(st.moving, false); assert.equal(st.phase, 'static'); assert.equal(st.done, false)
    assert.ok(Object.is(st.lat, pts[k - 1].lat) && Object.is(st.lon, pts[k - 1].lon), `头位置原值 ${i}`)
    const own = llaToVec(st.lat, st.lon, 0).multiplyScalar(1.0025)
    assert.ok(Object.is(own.x, ref.pos.x) && Object.is(own.y, ref.pos.y) && Object.is(own.z, ref.pos.z), `锚点逐位 ${i}`)
    assert.equal(st.hasTan, !!ref.tan, `有无切向 ${i}`)
    if (ref.tan) {
      assert.ok(Object.is(st.tan[0], ref.tan.x) && Object.is(st.tan[1], ref.tan.y) && Object.is(st.tan[2], ref.tan.z),
        `切向逐位 ${i}：[${st.tan}] vs [${ref.tan.x},${ref.tan.y},${ref.tan.z}]`)
      cmp++
      const a = pts[k - 2], b = pts[k - 1]
      if (centralAngle([a.lat, a.lon], [b.lat, b.lon]) > 1e-4 && Math.abs(b.lat) < 89.9) nearAng(st.headingDeg, (bearing(b.lat, b.lon, a.lat, a.lon) + 180) % 360, 1e-6, `航向 = 解析到达方位 ${i}`)
    }
    near(st.s, trajLengthM(tr), 1e-9, `s = 全程 ${i}`); assert.equal(st.leg, k - 2)
  }
  assert.ok(cmp >= 260, `逐位对拍条数 ${cmp}`)
})
t('静止档航向 = 运动档到达航向；缺时刻 / 缺速度 / 速度 0 都走静止档', () => {
  const pts = [{ lat: 1.36, lon: 103.99 }, { lat: 13.69, lon: 100.75 }, { lat: 22.31, lon: 113.92 }]
  const base = { id: 'sm', kind: 'flight', pts }
  const s = trajStateAt(base, T0)
  const d = trajStateAt({ ...base, id: 'sm2', t0Ms: T0, speedKmh: 800 }, T0 + 864e5)
  assert.equal(d.done, true)
  nearAng(s.headingDeg, d.headingDeg, 1e-9, '静止 = 到达')
  for (const extra of [{ t0Ms: T0 }, { speedKmh: 800 }, { t0Ms: T0, speedKmh: 0 }, { t0Ms: T0, speedKmh: -5 }, { t0Ms: NaN, speedKmh: 800 }]) {
    const st = trajStateAt({ ...base, id: 'sm3', ...extra }, T0 + 3.6e6)
    assert.equal(st.moving, false, JSON.stringify(extra)); assert.ok(Object.is(st.lat, 22.31))
  }
})
t('静止档飞行高度：航迹头 altM ?? 巡航；俯仰 = 末段两点高差 / 段长', () => {
  const pts = [{ lat: 30, lon: 100 }, { lat: 31, lon: 101 }]
  assert.equal(trajStateAt({ id: 'h1', kind: 'flight', pts }, T0).altM, CRUISE_ALT_M_DEFAULT)
  assert.equal(trajStateAt({ id: 'h1', kind: 'flight', pts }, T0).pitchDeg, 0)
  assert.equal(trajStateAt({ id: 'h2', kind: 'flight', pts, cruiseAltM: 9500 }, T0).altM, 9500)
  const pts2 = [{ lat: 30, lon: 100, altM: 1000 }, { lat: 31, lon: 101, altM: 3000 }]
  const st = trajStateAt({ id: 'h3', kind: 'flight', pts: pts2 }, T0)
  assert.equal(st.altM, 3000)
  near(st.pitchDeg, Math.atan2(2000, wgs84DistanceM(30, 100, 31, 101)) * R2D, 1e-12, '末段俯仰')
})
t('单航点 / 全无效 / 空：单点钉住、无切向、航向 0；无效返回 ok=false', () => {
  const st = trajStateAt({ id: 'one', kind: 'flight', pts: [{ lat: 10, lon: 20 }], t0Ms: T0, speedKmh: 500 }, T0 + 1e6)
  assert.equal(st.ok, true); assert.equal(st.moving, false); assert.equal(st.hasTan, false); assert.equal(st.headingDeg, 0)
  assert.ok(Object.is(st.lat, 10) && Object.is(st.lon, 20))
  assert.equal(trajStateAt({ id: 'none', kind: 'sea', pts: [{ lat: null, lon: 3 }] }, T0).ok, false)
  assert.equal(trajStateAt({ id: 'empty', kind: 'sea', pts: [] }, T0).ok, false)
  assert.equal(trajStateAt(null, T0).ok, false)
  // 两点重合：静止、无切向
  const dup = trajStateAt({ id: 'dup', kind: 'sea', pts: [{ lat: 5, lon: 5 }, { lat: 5, lon: 5 }], t0Ms: T0, speedKmh: 30 }, T0 + 1e6)
  assert.equal(dup.moving, false); assert.equal(dup.hasTan, false)
})
t('scene.js 源码核对：setTrajectories 载具切向仍是这套算法（找不到只提示，不判失败）', () => {
  const src = readFileSync(fileURLToPath(new URL('../../../src/viz/globe3d/scene.js', import.meta.url)), 'utf8').replace(/\r/g, '')
  const lines = [
    'const pos = llaToVec(hd.lat, hd.lon, 0).multiplyScalar(1.0025)',
    'spr._dir = pos.clone().normalize()',
    'const pv = llaToVec(pts[pts.length - 2].lat, pts[pts.length - 2].lon, 0).normalize()',
    'const tan = pv.clone().addScaledVector(hn, -hn.dot(pv)).multiplyScalar(-1)',
    'if (tan.lengthSq() > 1e-12) spr._tan = tan.normalize()'
  ]
  const miss = lines.filter((l) => !src.includes(l))
  if (miss.length) console.log(`  ⚠ scene.js 载具切向写法已变（缺 ${miss.length} 行），静止档逐位对拍需按新代码复核：\n    ${miss.join('\n    ')}`)
})
t('sceneHeadTangent 单独可用（同一串运算）', () => {
  const o = [0, 0, 0]
  assert.equal(sceneHeadTangent(10, 20, 10, 20, o), false)
  assert.equal(sceneHeadTangent(10, 20, 11, 21, o), true)
  const ref = sceneTan([{ lat: 10, lon: 20 }, { lat: 11, lon: 21 }]).tan
  assert.ok(Object.is(o[0], ref.x) && Object.is(o[1], ref.y) && Object.is(o[2], ref.z))
})

// ═════════════════════════════ ⑦ 缓存与 out 复用 ═════════════════════════════
t('计划缓存：同 id 新拷贝不重建、原地改航点立即生效、out 复用返回同一对象', () => {
  clearTrajPlanCache()
  const mk = () => ({ id: 'cache', kind: 'flight', pts: [{ id: 'a', lat: 30, lon: 100 }, { id: 'b', lat: 35, lon: 110 }], t0Ms: T0, speedKmh: 800 })
  const out = makeTrajState()
  trajStateAt(mk(), T0 + 1e6, out)
  const b0 = trajPlanStats().builds
  for (let i = 0; i < 1000; i++) assert.equal(trajStateAt(mk(), T0 + i * 1000, out), out)
  assert.equal(trajPlanStats().builds, b0, '新拷贝同内容不重建')
  const tr = mk()
  const before = trajStateAt(tr, T0 + 36e5, out).lon
  tr.pts[1].lon = 120
  const after = trajStateAt(tr, T0 + 36e5, out).lon
  assert.equal(trajPlanStats().builds, b0 + 1, '改了就重建一次')
  assert.notEqual(before, after)
  tr.pts[1].altM = 7000
  trajStateAt(tr, T0, out)
  assert.equal(trajPlanStats().builds, b0 + 2, 'altM 变化也重建')
  // 无 id：按对象缓存
  const anon = { kind: 'sea', pts: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }] }
  trajStateAt(anon, T0, out); const b1 = trajPlanStats().builds
  trajStateAt(anon, T0, out); assert.equal(trajPlanStats().builds, b1)
  // trajPlan 结果直接传：静止档
  const p = trajPlan(tr)
  assert.equal(trajStateAt(p, T0, out).moving, false)
})
t('计划缓存：同 id 下无效行换位置（有效坐标序列不变）也重建，leg 跟着原下标走', () => {
  clearTrajPlanCache()
  const A = { lat: 30, lon: 100 }, B = { lat: 32, lon: 104 }, C = { lat: 34, lon: 108 }, bad = { lat: NaN, lon: 3 }
  const tr1 = { id: 'idxShift', kind: 'sea', pts: [A, bad, B, C] }, tr2 = { id: 'idxShift', kind: 'sea', pts: [A, B, bad, C] }
  const L = trajLengthM(tr1), sMid2 = wgs84DistanceM(30, 100, 32, 104) + wgs84DistanceM(32, 104, 34, 108) / 2
  assert.equal(trajStateAtS(tr1, sMid2).leg, 2, '[A, 空, B, C] 第二段起点原下标 2')
  assert.equal(trajStateAtS(tr2, sMid2).leg, 1, '[A, B, 空, C] 第二段起点原下标 1（缓存不能命中旧计划）')
  assert.equal(trajStateAt(tr1, T0).leg, 2); assert.equal(trajStateAt(tr2, T0).leg, 1)
  assert.equal(trajStateAtS(tr1, 0.1 * L).leg, 0)
  // 与冷缓存结果一致
  const warm = trajStateAtS(tr2, sMid2).leg
  clearTrajPlanCache()
  assert.equal(trajStateAtS(tr2, sMid2).leg, warm)
})

// ═════════════════════════════ ⑧ 极点航点 ═════════════════════════════
// 场景轴切向 → 当地 N / E（按 state.lat / lon）上的方位
function headingOfTan(lat, lon, tan) {
  const e = [tan[0], -tan[2], tan[1]], p = lat * D2R, l = lon * D2R
  const E = [-Math.sin(l), Math.cos(l), 0], N = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)]
  return (Math.atan2(e[0] * E[0] + e[1] * E[1] + e[2] * E[2], e[0] * N[0] + e[1] * N[1] + e[2] * N[2]) * R2D + 360) % 360
}
t('航点恰在极点（lat = ±90、lon ≠ 0）：航向按航点经度的 N / E 取，与切向一致（静止档、运动档到达）', () => {
  for (const lon of [100, -45, 179.9, 30, 0]) for (const sg of [1, -1]) {
    const pts = [{ lat: sg * 80, lon }, { lat: sg * 90, lon }]
    const exp = sg > 0 ? 0 : 180                                           // 沿子午线冲过极点：北极按航点经度的「北」= 0°，南极 = 180°
    const st = trajStateAt({ id: `pole ${sg} ${lon}`, kind: 'flight', pts }, T0)
    assert.equal(st.hasTan, true); assert.ok(Object.is(st.lon, lon), '静止档经度 = 航点原值')
    nearAng(st.headingDeg, exp, 1e-6, `静止档航向 lat ${sg * 90} lon ${lon}`)
    nearAng(st.headingDeg, headingOfTan(st.lat, st.lon, st.tan), 1e-9, `静止档航向 = 切向方位 lat ${sg * 90} lon ${lon}`)
    const mv = trajStateAt({ id: `poleM ${sg} ${lon}`, kind: 'flight', pts, t0Ms: T0, speedKmh: 800 }, T0 + 864e5)
    assert.equal(mv.done, true); assert.ok(Object.is(mv.lon, lon))
    nearAng(mv.headingDeg, exp, 1e-6, `到达航向 lat ${sg * 90} lon ${lon}`)
    nearAng(mv.headingDeg, headingOfTan(mv.lat, mv.lon, mv.tan), 1e-9, `到达航向 = 切向方位 lat ${sg * 90} lon ${lon}`)
  }
})

t('每拍开销（报数不判）', () => {
  const pts = []
  for (let j = 0; j < 50; j++) pts.push({ lat: -40 + j * 1.5, lon: -170 + j * 6.5 })
  const tr = { id: 'perf', kind: 'flight', pts, t0Ms: T0, speedKmh: 850 }
  const out = makeTrajState()
  const end = trajEndMs(tr)
  for (let i = 0; i < 2000; i++) trajStateAt(tr, T0 + (end - T0) * i / 2000, out)
  const N = 200000, t1 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) trajStateAt(tr, T0 + (end - T0) * (i % 997) / 997, out)
  const ns = Number(process.hrtime.bigint() - t1) / N
  console.log(`  trajStateAt（50 航点、飞行运动档）≈ ${ns.toFixed(0)} ns / 次`)
})

// ═════════════════════════════ ⑨ 热路径分配量 ═════════════════════════════
// 采样堆分析（V8 HeapProfiler.startSampling，含 minor / major GC 收走的对象；量法同 modelAttitudeLaws ⑦），整份剖面计数（被内联的
// 分配记在调用方帧上，按文件过滤会漏），只剔 node: 内部帧（inspector 自己的消息）。
// 代码里没有显式分配；剩下的是 V8 在未内联调用边界 / 被撑开的取数点对 double 的装箱（16 B / 个，随 JIT 反馈浮动）：单独跑时模块内
// ≈ 0、另有测试循环把 tMs 实参装箱的 16 B；本进程前面的用例拿各种形状的航迹对象喂过之后，取 t0Ms / speedKmh 变 megamorphic，
// 运动档再多 1 个（实测 ≈ 32 B / 次）。判据只抓显式分配回归：makeTrajState ≈ 160 B、对象 / 数组字面量 ≈ 72 B 起、
// Math.hypot 每回 ≈ 40 B——上限 ALLOC_MAX_B = 6 个装箱（再紧就会随 JIT 反馈抖）。ALLOC_SITES=1 打印分配点。
const ALLOC_MAX_B = 96
async function allocPerCall(ss, fn, N) {
  fn(); fn()                                                               // 预热到优化态
  await ss.post('HeapProfiler.startSampling', { samplingInterval: 256, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
  fn()
  const { profile } = await ss.post('HeapProfiler.stopSampling')
  let bytes = 0
  const sites = new Map()
  const walk = (nd) => {
    if (!/^node:/.test(nd.callFrame.url || '') && nd.selfSize) {
      bytes += nd.selfSize
      const k = (nd.callFrame.url || '').split('/').pop() + ' ' + nd.callFrame.functionName + ':' + (nd.callFrame.lineNumber + 1)
      sites.set(k, (sites.get(k) || 0) + nd.selfSize)
    }
    for (const c of nd.children || []) walk(c)
  }
  walk(profile.head)
  if (process.env.ALLOC_SITES) console.log('    ', [...sites].sort((p, q) => q[1] - p[1]).slice(0, 5).map(([k, v]) => k + ' ' + (v / N).toFixed(1)).join('; '))
  return bytes / N
}
{
  const name = '热路径分配量：trajStateAt（运动档飞行 / 航行、静止档）、trajStateAtS 复用 out 时每次 ≤ ALLOC_MAX_B（报数）'
  try {
    const N = 100000
    const pts = []
    for (let j = 0; j < 50; j++) pts.push({ lat: -40 + j * 1.5, lon: -170 + j * 6.5 })
    const fl = { id: 'allocF', kind: 'flight', pts, t0Ms: T0, speedKmh: 850 }, sea = { id: 'allocS', kind: 'sea', pts, t0Ms: T0, speedKmh: 40 }
    const st = { id: 'allocT', kind: 'flight', pts }
    const out = makeTrajState(), ts = new Float64Array(997), ss0 = new Float64Array(997)
    const endF = trajEndMs(fl), endS = trajEndMs(sea), L = trajLengthM(fl)
    for (let i = 0; i < 997; i++) { ts[i] = i / 997; ss0[i] = L * i / 997 }
    const tf = new Float64Array(997), tsea = new Float64Array(997)
    for (let i = 0; i < 997; i++) { tf[i] = T0 + (endF - T0) * ts[i]; tsea[i] = T0 + (endS - T0) * ts[i] }
    const cases = [
      ['运动档飞行', () => { for (let i = 0; i < N; i++) trajStateAt(fl, tf[i % 997], out) }],
      ['运动档航行', () => { for (let i = 0; i < N; i++) trajStateAt(sea, tsea[i % 997], out) }],
      ['静止档', () => { for (let i = 0; i < N; i++) trajStateAt(st, tf[i % 997], out) }],
      ['trajStateAtS', () => { for (let i = 0; i < N; i++) trajStateAtS(fl, ss0[i % 997], out) }]
    ]
    const ss = new Session(); ss.connect()
    await ss.post('HeapProfiler.enable')
    const rows = [], over = []
    for (const [nm, fn] of cases) { const b = await allocPerCall(ss, fn, N); rows.push(`${nm} ${b.toFixed(1)}`); if (b > ALLOC_MAX_B) over.push(`${nm} ${b.toFixed(1)} B`) }
    await ss.post('HeapProfiler.disable'); ss.disconnect()
    console.log(`  每次调用平均分配（B，${N} 次、采样堆分析）：` + rows.join('；'))
    assert.equal(over.length, 0, `超过 ${ALLOC_MAX_B} B / 次（疑似显式分配回归）：${over.join('，')}`)
    n++
  } catch (e) { console.error(`✗ ${name}
  ${e.message}`); process.exitCode = 1 }
}

console.log(`modelTrajKinematics: ${n} 项通过`)
